import { resolve } from "node:path"
import type {
  CredentialConnectionBroker,
  CredentialConnectRequest,
  CredentialDriver,
  CredentialMethodInfo,
  CredentialRef,
  CredentialStatus,
  CredentialStoreKind,
  ResolvedCredential,
  SecretStore,
} from "./contracts"
import {
  CredentialConnectRequestSchema,
  CredentialMethodInfoSchema,
  CredentialRefSchema,
} from "./contracts"
import { EnvironmentSecretStore } from "./environment-secret-store"
import type { CredentialMetadataRegistry } from "./metadata-registry"
import { SecretRedactor } from "./redaction"

export type CredentialManagerOptions = {
  providerId: string
  methods: readonly CredentialMethodInfo[]
  registry: CredentialMetadataRegistry
  stores: readonly SecretStore[]
  broker: CredentialConnectionBroker
  redactor?: SecretRedactor
  now?: () => Date
  id?: () => string
}

type PendingCredentialRenewal = {
  readonly input: CredentialRef
  readonly promise: Promise<CredentialRef>
}

// Multiple command compositions may construct independent managers over the
// same process-global credential registry. Coordinate renewals and revocations
// here so one refresh token is rotated once per process and a concurrent revoke
// cannot race a metadata upsert. Cross-process leases/crash recovery belong to
// the durable concurrency slice (S07); metadata commit remains atomic here.
const PROCESS_RENEWALS = new Map<string, PendingCredentialRenewal>()
const PROCESS_CREDENTIAL_OPERATION_TAILS = new Map<string, Promise<void>>()

/**
 * Remote logout is best-effort, but local secret and metadata cleanup is
 * authoritative. This error is raised only after local cleanup succeeded so a
 * caller can report the remote uncertainty without claiming the token remains
 * on this machine.
 */
export class CredentialRemoteRevocationError extends Error {
  readonly localCleanupCompleted = true

  constructor(message: string) {
    super(message)
    this.name = "CredentialRemoteRevocationError"
  }
}

export class CredentialManager implements CredentialDriver {
  readonly providerId: string
  readonly #methods: readonly CredentialMethodInfo[]
  readonly #registry: CredentialMetadataRegistry
  readonly #stores: ReadonlyMap<CredentialStoreKind, SecretStore>
  readonly #broker: CredentialConnectionBroker
  readonly #redactor: SecretRedactor
  readonly #now: () => Date
  readonly #id: () => string
  readonly #pendingIds = new Set<string>()

  constructor(options: CredentialManagerOptions) {
    this.providerId = options.providerId
    this.#methods = options.methods.map((method) => CredentialMethodInfoSchema.parse(method))
    if (new Set(this.#methods.map((method) => method.method)).size !== this.#methods.length) {
      throw new Error(`Credential methods for ${this.providerId} must be unique`)
    }
    this.#registry = options.registry
    const stores = [...options.stores]
    if (!stores.some((store) => store.kind === "environment"))
      stores.push(new EnvironmentSecretStore())
    if (new Set(stores.map((store) => store.kind)).size !== stores.length) {
      throw new Error("Credential secret store kinds must be unique")
    }
    this.#stores = new Map(stores.map((store) => [store.kind, store]))
    this.#broker = options.broker
    this.#redactor = options.redactor ?? new SecretRedactor()
    this.#now = options.now ?? (() => new Date())
    this.#id = options.id ?? (() => `cred-${crypto.randomUUID()}`)
  }

  async methods(): Promise<readonly CredentialMethodInfo[]> {
    return this.#methods.map((method) => ({ ...method, access: [...method.access] }))
  }

  async connect(input: CredentialConnectRequest): Promise<CredentialRef> {
    const request = CredentialConnectRequestSchema.parse(input)
    if (request.provider !== this.providerId)
      throw new Error("Credential provider does not match driver")
    const method = this.#methods.find((candidate) => candidate.method === request.method)
    if (!method) throw new Error(`Credential method is unsupported: ${request.method}`)
    const id = request.id ?? this.#id()
    CredentialRefSchema.pick({ id: true }).parse({ id })
    if (this.#pendingIds.has(id) || (await this.#registry.get(id))) {
      throw new Error(`Credential ID is already registered: ${id}`)
    }
    this.#pendingIds.add(id)
    try {
      const material = await this.#broker.connect(request, method)
      const label = request.label ?? method.label

      if (material.kind === "environment") {
        if (request.method !== "environment") {
          throw new Error("Only the environment auth method may create an environment reference")
        }
        const store = this.store("environment")
        await this.ensureAvailable(store)
        if (!(await store.has(material.variable))) {
          throw new Error(`Environment credential is unavailable: ${material.variable}`)
        }
        const ref = CredentialRefSchema.parse({
          id,
          provider: this.providerId,
          method: request.method,
          store: "environment",
          locator: material.variable,
          label,
          ...(material.accountHint ? { accountHint: material.accountHint } : {}),
        })
        await this.#registry.insert(ref)
        return ref
      }

      if (request.method === "environment") {
        throw new Error("Environment auth must use an environment reference")
      }
      const store = this.store(material.store)
      await this.ensureAvailable(store)
      const secret = await material.secret.readOnce()
      if (secret.length === 0) throw new Error("Credential secret cannot be empty")
      // The metadata ID is user-facing, while the secret locator is unique per
      // connection attempt. Two Ralph processes racing for the same ID cannot
      // overwrite or delete the winning process's keychain value.
      const locator = `${this.providerId}:${crypto.randomUUID()}`
      const ref = CredentialRefSchema.parse({
        id,
        provider: this.providerId,
        method: request.method,
        store: material.store,
        locator,
        label,
        ...(material.accountHint ? { accountHint: material.accountHint } : {}),
        ...(material.expiresAt ? { expiresAt: material.expiresAt } : {}),
      })

      const release = this.#redactor.register(secret)
      try {
        await store.put(locator, secret)
        try {
          await this.#registry.insert(ref, [secret])
        } catch (error) {
          await store.delete(locator).catch(() => undefined)
          throw error
        }
        return ref
      } catch (error) {
        throw this.safeError("Credential connection failed", error, [secret])
      } finally {
        release()
      }
    } finally {
      this.#pendingIds.delete(id)
    }
  }

  async list(): Promise<CredentialRef[]> {
    return (await this.#registry.list()).filter((ref) => ref.provider === this.providerId)
  }

  async status(input: CredentialRef): Promise<CredentialStatus> {
    const ref = CredentialRefSchema.parse(input)
    const registered = await this.#registry.get(ref.id)
    if (!registered) return "revoked"
    if (!sameRef(ref, registered) || registered.provider !== this.providerId) return "unknown"
    if (registered.expiresAt && Date.parse(registered.expiresAt) <= this.#now().getTime())
      return "expired"
    try {
      const store = this.store(registered.store)
      const probe = await store.probe()
      if (!probe.available) return "unavailable"
      return (await store.has(registered.locator)) ? "connected" : "unavailable"
    } catch {
      return "unavailable"
    }
  }

  async resolve(input: CredentialRef): Promise<ResolvedCredential> {
    const ref = await this.registered(input)
    if (ref.expiresAt && Date.parse(ref.expiresAt) <= this.#now().getTime()) {
      throw new Error(`Credential is expired: ${ref.id}`)
    }
    const secret = await this.store(ref.store).get(ref.locator)
    if (secret === undefined) throw new Error(`Credential secret is unavailable: ${ref.id}`)
    let value: string | undefined = secret
    return {
      ref,
      useValue: async <T>(consumer: (secretValue: string) => Promise<T>) => {
        const current = value
        if (current === undefined) throw new Error("Resolved credential has already been consumed")
        value = undefined
        const release = this.#redactor.register(current)
        try {
          return await consumer(current)
        } catch (error) {
          throw this.safeError("Credential consumer failed", error, [current])
        } finally {
          release()
        }
      },
    }
  }

  async renew(input: CredentialRef): Promise<CredentialRef> {
    const ref = CredentialRefSchema.parse(input)
    const operationKey = this.credentialOperationKey(ref)

    while (true) {
      const pending = PROCESS_RENEWALS.get(operationKey)
      if (!pending) return this.startRenewal(ref, operationKey)
      if (sameRef(ref, pending.input)) {
        return CredentialRefSchema.parse(await pending.promise)
      }

      // A different/stale reference for the same credential must not rotate the
      // provider token concurrently. Once the active renewal settles, normal
      // registered-ref validation decides whether this caller is still valid.
      await pending.promise.catch(() => undefined)
      if (PROCESS_RENEWALS.get(operationKey) === pending) {
        PROCESS_RENEWALS.delete(operationKey)
      }
    }
  }

  private async startRenewal(ref: CredentialRef, operationKey: string): Promise<CredentialRef> {
    const promise = this.runCredentialOperation(operationKey, () => this.renewOnce(ref))
    const pending = { input: ref, promise }
    PROCESS_RENEWALS.set(operationKey, pending)
    try {
      return CredentialRefSchema.parse(await promise)
    } finally {
      if (PROCESS_RENEWALS.get(operationKey) === pending) {
        PROCESS_RENEWALS.delete(operationKey)
      }
    }
  }

  private credentialOperationKey(ref: CredentialRef): string {
    return `${resolve(this.#registry.file)}\0${this.providerId}\0${ref.id}`
  }

  private async runCredentialOperation<T>(
    operationKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const predecessor = PROCESS_CREDENTIAL_OPERATION_TAILS.get(operationKey)
    let release: () => void = () => undefined
    const active = new Promise<void>((resolveActive) => {
      release = resolveActive
    })
    const tail = (predecessor ?? Promise.resolve()).then(() => active)
    PROCESS_CREDENTIAL_OPERATION_TAILS.set(operationKey, tail)

    if (predecessor) await predecessor
    try {
      return await operation()
    } finally {
      release()
      if (PROCESS_CREDENTIAL_OPERATION_TAILS.get(operationKey) === tail) {
        PROCESS_CREDENTIAL_OPERATION_TAILS.delete(operationKey)
      }
    }
  }

  private async renewOnce(input: CredentialRef): Promise<CredentialRef> {
    if (!this.#broker.renew) throw new Error(`Credential renewal is unsupported: ${input.method}`)
    const ref = await this.registered(input)
    if (ref.store === "environment") throw new Error("Environment credentials cannot be renewed")
    const source = this.store(ref.store)
    const current = await source.get(ref.locator)
    if (current === undefined) throw new Error(`Credential secret is unavailable: ${ref.id}`)

    const releaseCurrent = this.#redactor.register(current)
    let next: string | undefined
    let releaseNext: () => void = () => undefined
    let target: SecretStore | undefined
    let nextLocator: string | undefined
    let committed = false
    try {
      const material = await this.#broker.renew(ref, current)
      target = this.store(material.store)
      await this.ensureAvailable(target)
      next = await material.secret.readOnce()
      if (next.length === 0) throw new Error("Renewed credential secret cannot be empty")
      releaseNext = this.#redactor.register(next)
      nextLocator = await this.uniqueLocator(target, ref.locator)
      const updated = CredentialRefSchema.parse({
        ...ref,
        store: material.store,
        locator: nextLocator,
        ...(material.accountHint ? { accountHint: material.accountHint } : {}),
        ...(material.expiresAt ? { expiresAt: material.expiresAt } : {}),
      })

      // The old locator remains authoritative until the metadata write commits.
      // A failed put/upsert can therefore delete only the new locator and leave
      // the previously usable credential untouched.
      await target.put(nextLocator, next)
      await this.#registry.upsert(updated, [current, next])
      committed = true

      // Delete the retired secret only after metadata resolves to the new one.
      // If cleanup fails, the committed credential remains usable and must not
      // be rolled back to a refresh token the provider may already have rotated.
      await source.delete(ref.locator)
      return updated
    } catch (error) {
      let failure = error
      if (!committed && target && nextLocator) {
        try {
          await target.delete(nextLocator)
        } catch (rollbackError) {
          const primary = error instanceof Error ? error.message : String(error)
          const rollback =
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
          failure = new Error(`${primary}; renewal rollback cleanup failed: ${rollback}`)
        }
      }
      throw this.safeError(
        committed
          ? "Credential renewal committed but previous secret cleanup failed"
          : "Credential renewal failed",
        failure,
        [current, ...(next === undefined ? [] : [next])],
      )
    } finally {
      releaseCurrent()
      releaseNext()
    }
  }

  private async uniqueLocator(store: SecretStore, currentLocator: string): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = `${this.providerId}:${crypto.randomUUID()}`
      if (candidate !== currentLocator && !(await store.has(candidate))) return candidate
    }
    throw new Error("Could not allocate a unique credential secret locator")
  }

  async revoke(input: CredentialRef): Promise<void> {
    const inputRef = CredentialRefSchema.parse(input)
    const operationKey = this.credentialOperationKey(inputRef)
    await this.runCredentialOperation(operationKey, async () => {
      const ref = await this.registered(inputRef)
      const store = this.store(ref.store)
      const current = await store.get(ref.locator).catch(() => undefined)
      const release = current ? this.#redactor.register(current) : () => undefined
      let remoteFailure: unknown
      try {
        if (this.#broker.revoke) {
          try {
            await this.#broker.revoke(ref, current)
          } catch (error) {
            remoteFailure = error
          }
        }
        await store.delete(ref.locator)
        await this.#registry.remove(ref.id)
      } catch (error) {
        throw this.safeError("Credential revocation failed", error, current ? [current] : [])
      } finally {
        release()
      }
      if (remoteFailure !== undefined) {
        const safe = this.safeError(
          "Remote credential revocation failed after local cleanup completed",
          remoteFailure,
          current ? [current] : [],
        )
        throw new CredentialRemoteRevocationError(safe.message)
      }
    })
  }

  private store(kind: CredentialStoreKind): SecretStore {
    const store = this.#stores.get(kind)
    if (!store) throw new Error(`Credential secret store is not configured: ${kind}`)
    return store
  }

  private async ensureAvailable(store: SecretStore): Promise<void> {
    const probe = await store.probe()
    if (!probe.available)
      throw new Error(probe.detail ?? `Secret store is unavailable: ${probe.backend}`)
  }

  private async registered(input: CredentialRef): Promise<CredentialRef> {
    const ref = CredentialRefSchema.parse(input)
    const registered = await this.#registry.get(ref.id)
    if (!registered || registered.provider !== this.providerId)
      throw new Error(`Credential is not registered: ${ref.id}`)
    if (!sameRef(ref, registered))
      throw new Error("Credential reference does not match registered metadata")
    return registered
  }

  private safeError(prefix: string, error: unknown, secrets: readonly string[]): Error {
    const message = error instanceof Error ? error.message : String(error)
    return new Error(`${prefix}: ${this.#redactor.redactText(message, secrets)}`)
  }
}

function sameRef(left: CredentialRef, right: CredentialRef): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
