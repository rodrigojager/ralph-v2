import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  CredentialConnectionBroker,
  CredentialMethodInfo,
  CredentialRef,
  SecretConnectionMaterial,
  SecretStore,
} from "../src/index"
import {
  CredentialManager,
  CredentialMetadataRegistry,
  CredentialRemoteRevocationError,
  EnvironmentSecretStore,
  FakeSecretStore,
  REDACTED_SECRET,
  SecretRedactor,
  secretInputFromValue,
} from "../src/index"

const roots: string[] = []

class ControlledCredentialMetadataRegistry extends CredentialMetadataRegistry {
  failNextUpsert = false
  attemptedUpsert: CredentialRef | undefined

  override async upsert(
    ref: CredentialRef,
    forbiddenSecrets: readonly string[] = [],
  ): Promise<void> {
    this.attemptedUpsert = ref
    if (this.failNextUpsert) {
      this.failNextUpsert = false
      throw new Error(`Injected registry failure: ${forbiddenSecrets.join("|")}`)
    }
    await super.upsert(ref, forbiddenSecrets)
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(
  options: {
    secret?: string
    environment?: Record<string, string | undefined>
    expiresAt?: string
    renew?: NonNullable<CredentialConnectionBroker["renew"]>
    revoke?: NonNullable<CredentialConnectionBroker["revoke"]>
    additionalStores?: readonly SecretStore[]
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ralph-credentials-manager-"))
  roots.push(root)
  const registry = new ControlledCredentialMetadataRegistry(join(root, "credentials.json"))
  const store = new FakeSecretStore()
  const redactor = new SecretRedactor()
  const secret = options.secret ?? "manager-secret-canary-1234"
  const methods: CredentialMethodInfo[] = [
    { method: "api-key", label: "API key", access: ["api"], interactive: true },
    { method: "environment", label: "Environment", access: ["api"], interactive: false },
  ]
  const broker: CredentialConnectionBroker = {
    async connect(request) {
      if (request.method === "environment") {
        return { kind: "environment", variable: "OPENAI_API_KEY", accountHint: "env" }
      }
      return {
        kind: "secret",
        store: "os-keychain",
        secret: secretInputFromValue(secret),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      }
    },
    renew:
      options.renew ??
      (async () => ({
        kind: "secret",
        store: "os-keychain",
        secret: secretInputFromValue("renewed-secret-canary-5678"),
        expiresAt: "2031-01-01T00:00:00.000Z",
      })),
    ...(options.revoke ? { revoke: options.revoke } : {}),
  }
  const manager = new CredentialManager({
    providerId: "openai",
    methods,
    registry,
    stores: [
      store,
      ...(options.additionalStores ?? []),
      new EnvironmentSecretStore(options.environment ?? { OPENAI_API_KEY: "env-canary" }),
    ],
    broker,
    redactor,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    id: () => "cred-fixed-id",
  })
  return { root, registry, store, manager, secret, redactor, broker, methods }
}

describe("credential metadata registry and manager", () => {
  test("serializes metadata mutations across independent registry instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-credentials-concurrent-"))
    roots.push(root)
    const file = join(root, "credentials.json")
    const first = new CredentialMetadataRegistry(file)
    const second = new CredentialMetadataRegistry(file)
    const reference = (id: string): CredentialRef => ({
      id,
      provider: "openai",
      method: "api-key",
      store: "os-keychain",
      locator: `openai:${id}`,
      label: id,
    })

    await Promise.all([
      first.insert(reference("credential-one")),
      second.insert(reference("credential-two")),
    ])

    expect((await first.list()).map((item) => item.id).sort()).toEqual([
      "credential-one",
      "credential-two",
    ])
    expect(await Bun.file(`${file}.lock`).exists()).toBeFalse()
  })

  test("connects, lists, resolves and revokes without persisting secret material", async () => {
    const { root, store, manager, secret } = await fixture()
    const ref = await manager.connect({
      provider: "openai",
      method: "api-key",
      label: "primary",
      nonInteractive: false,
    })

    expect(ref).toMatchObject({
      id: "cred-fixed-id",
      provider: "openai",
      method: "api-key",
      store: "os-keychain",
      label: "primary",
    })
    expect(ref.locator).toMatch(/^openai:[0-9a-f-]{36}$/)
    expect(await manager.list()).toEqual([ref])
    expect(await manager.status(ref)).toBe("connected")
    expect(JSON.stringify(await manager.list())).not.toContain(secret)

    const metadata = await readFile(join(root, "credentials.json"), "utf8")
    expect(metadata).not.toContain(secret)
    expect(metadata).not.toContain("access_token")
    expect(metadata).toContain(ref.locator)

    const resolved = await manager.resolve(ref)
    expect(await resolved.useValue(async (value) => `length:${value.length}`)).toBe(
      `length:${secret.length}`,
    )
    await expect(resolved.useValue(async () => "again")).rejects.toThrow("already been consumed")

    await manager.revoke(ref)
    expect(await manager.status(ref)).toBe("revoked")
    expect(await store.has(ref.locator)).toBe(false)
    expect(await manager.list()).toEqual([])
  })

  test("always removes local material when remote revocation fails", async () => {
    const { store, manager, secret } = await fixture({
      revoke: async (_ref, currentSecret) => {
        throw new Error(`remote revoke failed for ${currentSecret}`)
      },
    })
    const ref = await manager.connect({
      provider: "openai",
      method: "api-key",
      label: "remote-failure",
      nonInteractive: false,
    })

    const failure = await manager
      .revoke(ref)
      .then(() => new Error("Expected remote revocation uncertainty"))
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(CredentialRemoteRevocationError)
    expect(failure).toMatchObject({ localCleanupCompleted: true })
    expect((failure as Error).message).not.toContain(secret)
    expect(await store.get(ref.locator)).toBeUndefined()
    expect(await manager.list()).toEqual([])
    expect(await manager.status(ref)).toBe("revoked")
  })

  test("stores an environment locator but never copies its value", async () => {
    const environmentSecret = "environment-manager-canary-9876"
    const { root, manager } = await fixture({ environment: { OPENAI_API_KEY: environmentSecret } })
    const ref = await manager.connect({
      provider: "openai",
      method: "environment",
      nonInteractive: true,
    })

    expect(ref.store).toBe("environment")
    expect(ref.locator).toBe("OPENAI_API_KEY")
    expect(await manager.status(ref)).toBe("connected")
    expect(await readFile(join(root, "credentials.json"), "utf8")).not.toContain(environmentSecret)
    expect(await (await manager.resolve(ref)).useValue(async (value) => value)).toBe(
      environmentSecret,
    )
  })

  test("renews through the broker while preserving a metadata-only registry", async () => {
    const { root, registry, store, manager, secret } = await fixture({
      expiresAt: "2029-01-01T00:00:00.000Z",
    })
    const ref = await manager.connect({
      provider: "openai",
      method: "api-key",
      nonInteractive: false,
    })
    expect(await manager.status(ref)).toBe("expired")

    const renewed = await manager.renew(ref)
    expect(renewed.expiresAt).toBe("2031-01-01T00:00:00.000Z")
    expect(renewed.locator).not.toBe(ref.locator)
    expect(renewed.locator).toMatch(/^openai:[0-9a-f-]{36}$/)
    expect(await store.get(ref.locator)).toBeUndefined()
    expect(await store.get(renewed.locator)).toBe("renewed-secret-canary-5678")
    expect(await registry.get(ref.id)).toEqual(renewed)
    const metadata = await readFile(join(root, "credentials.json"), "utf8")
    expect(metadata).not.toContain(secret)
    expect(metadata).not.toContain("renewed-secret-canary-5678")
    expect(metadata).not.toContain(ref.locator)
    expect(metadata).toContain(renewed.locator)
  })

  test("rolls back the new locator when the metadata commit fails", async () => {
    const { root, registry, store, manager, secret } = await fixture({
      expiresAt: "2029-01-01T00:00:00.000Z",
    })
    const ref = await manager.connect({
      provider: "openai",
      method: "api-key",
      nonInteractive: false,
    })
    registry.failNextUpsert = true

    let failure: unknown
    try {
      await manager.renew(ref)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("Credential renewal failed")
    expect((failure as Error).message).toContain(REDACTED_SECRET)
    expect((failure as Error).message).not.toContain(secret)
    expect((failure as Error).message).not.toContain("renewed-secret-canary-5678")
    expect(registry.attemptedUpsert?.locator).not.toBe(ref.locator)
    expect(await registry.get(ref.id)).toEqual(ref)
    expect(await store.get(ref.locator)).toBe(secret)
    expect([...store.values.entries()]).toEqual([[ref.locator, secret]])

    const metadata = await readFile(join(root, "credentials.json"), "utf8")
    expect(metadata).toContain(ref.locator)
    expect(metadata).not.toContain(registry.attemptedUpsert?.locator ?? "missing-locator")
    expect(metadata).not.toContain(secret)
    expect(metadata).not.toContain("renewed-secret-canary-5678")
  })

  test("coalesces concurrent renewal across independent managers into one token rotation", async () => {
    let renewCalls = 0
    let releaseRenewal: () => void = () => undefined
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseRenewal = resolve
    })
    const renew = async (
      _ref: CredentialRef,
      currentSecret: string,
    ): Promise<SecretConnectionMaterial> => {
      renewCalls += 1
      expect(currentSecret).toBe("manager-secret-canary-1234")
      markStarted()
      await blocked
      return {
        kind: "secret",
        store: "os-keychain",
        secret: secretInputFromValue("concurrent-renewed-secret-canary-9012"),
        expiresAt: "2031-01-01T00:00:00.000Z",
      }
    }
    const { registry, store, manager, broker, methods } = await fixture({
      expiresAt: "2029-01-01T00:00:00.000Z",
      renew,
    })
    const secondManager = new CredentialManager({
      providerId: "openai",
      methods,
      registry,
      stores: [store, new EnvironmentSecretStore({ OPENAI_API_KEY: "env-canary" })],
      broker,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    })
    const ref = await manager.connect({
      provider: "openai",
      method: "api-key",
      nonInteractive: false,
    })

    const first = manager.renew(ref)
    await started
    const second = secondManager.renew({ ...ref })
    await Promise.resolve()
    expect(renewCalls).toBe(1)
    releaseRenewal()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toEqual(secondResult)
    expect(renewCalls).toBe(1)
    expect(firstResult.locator).not.toBe(ref.locator)
    expect(await registry.get(ref.id)).toEqual(firstResult)
    expect(await store.get(ref.locator)).toBeUndefined()
    expect(await store.get(firstResult.locator)).toBe("concurrent-renewed-secret-canary-9012")
    await expect(secondManager.renew(ref)).rejects.toThrow(
      "Credential reference does not match registered metadata",
    )
    expect(renewCalls).toBe(1)
  })

  test("serializes renew before revoke and rejects the ref made stale by renewal", async () => {
    let markRenewStarted: () => void = () => undefined
    let releaseRenew: () => void = () => undefined
    const renewStarted = new Promise<void>((resolve) => {
      markRenewStarted = resolve
    })
    const renewBlocked = new Promise<void>((resolve) => {
      releaseRenew = resolve
    })
    let revokeCalls = 0
    let markRevokeStarted: () => void = () => undefined
    const revokeStarted = new Promise<void>((resolve) => {
      markRevokeStarted = resolve
    })
    const renew = async (): Promise<SecretConnectionMaterial> => {
      markRenewStarted()
      await renewBlocked
      return {
        kind: "secret",
        store: "os-keychain",
        secret: secretInputFromValue("renew-before-revoke-canary-2345"),
        expiresAt: "2031-01-01T00:00:00.000Z",
      }
    }
    const revoke = async () => {
      revokeCalls += 1
      markRevokeStarted()
    }
    const { registry, store, manager, broker, methods } = await fixture({
      expiresAt: "2029-01-01T00:00:00.000Z",
      renew,
      revoke,
    })
    const secondRegistry = new CredentialMetadataRegistry(registry.file)
    const secondManager = new CredentialManager({
      providerId: "openai",
      methods,
      registry: secondRegistry,
      stores: [store, new EnvironmentSecretStore({ OPENAI_API_KEY: "env-canary" })],
      broker,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    })
    const ref = await manager.connect({
      provider: "openai",
      method: "api-key",
      nonInteractive: false,
    })

    const renewal = manager.renew(ref)
    await renewStarted
    const revocation = secondManager.revoke({ ...ref }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const revokeCrossedRenewal = await Promise.race([
      revokeStarted.then(() => true),
      Bun.sleep(100).then(() => false),
    ])
    releaseRenew()

    const renewed = await renewal
    const revocationOutcome = await revocation
    expect(revokeCrossedRenewal).toBeFalse()
    expect(revocationOutcome.ok).toBeFalse()
    if (revocationOutcome.ok) throw new Error("Expected stale revocation to fail")
    expect(revocationOutcome.error).toBeInstanceOf(Error)
    expect((revocationOutcome.error as Error).message).toContain(
      "Credential reference does not match registered metadata",
    )
    expect(revokeCalls).toBe(0)
    expect(await registry.get(ref.id)).toEqual(renewed)
    expect(await secondRegistry.get(ref.id)).toEqual(renewed)
    expect(await store.get(ref.locator)).toBeUndefined()
    expect(await store.get(renewed.locator)).toBe("renew-before-revoke-canary-2345")
  })

  test("serializes revoke before renew across independent managers without orphaning a locator", async () => {
    let markRevokeStarted: () => void = () => undefined
    let releaseRevoke: () => void = () => undefined
    const revokeStarted = new Promise<void>((resolve) => {
      markRevokeStarted = resolve
    })
    const revokeBlocked = new Promise<void>((resolve) => {
      releaseRevoke = resolve
    })
    let renewCalls = 0
    let markRenewStarted: () => void = () => undefined
    const renewStarted = new Promise<void>((resolve) => {
      markRenewStarted = resolve
    })
    const revoke = async () => {
      markRevokeStarted()
      await revokeBlocked
    }
    const renew = async (): Promise<SecretConnectionMaterial> => {
      renewCalls += 1
      markRenewStarted()
      return {
        kind: "secret",
        store: "os-keychain",
        secret: secretInputFromValue("revoke-before-renew-canary-6789"),
        expiresAt: "2031-01-01T00:00:00.000Z",
      }
    }
    const { registry, store, manager, broker, methods } = await fixture({
      expiresAt: "2029-01-01T00:00:00.000Z",
      renew,
      revoke,
    })
    const secondRegistry = new CredentialMetadataRegistry(registry.file)
    const secondManager = new CredentialManager({
      providerId: "openai",
      methods,
      registry: secondRegistry,
      stores: [store, new EnvironmentSecretStore({ OPENAI_API_KEY: "env-canary" })],
      broker,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    })
    const ref = await manager.connect({
      provider: "openai",
      method: "api-key",
      nonInteractive: false,
    })

    const revocation = manager.revoke(ref)
    await revokeStarted
    const renewal = secondManager.renew({ ...ref }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const renewCrossedRevocation = await Promise.race([
      renewStarted.then(() => true),
      Bun.sleep(100).then(() => false),
    ])
    releaseRevoke()

    await revocation
    const renewalOutcome = await renewal
    expect(renewCrossedRevocation).toBeFalse()
    expect(renewalOutcome.ok).toBeFalse()
    if (renewalOutcome.ok) throw new Error("Expected renewal of a revoked credential to fail")
    expect(renewalOutcome.error).toBeInstanceOf(Error)
    expect((renewalOutcome.error as Error).message).toContain("Credential is not registered")
    expect(renewCalls).toBe(0)
    expect(await registry.get(ref.id)).toBeUndefined()
    expect(await secondRegistry.get(ref.id)).toBeUndefined()
    expect(await store.get(ref.locator)).toBeUndefined()
    expect([...store.values.entries()]).toEqual([])
  })

  test("commits a new locator before removing the source during store migration", async () => {
    const encryptedStore = new FakeSecretStore("encrypted-file")
    const renew = async (): Promise<SecretConnectionMaterial> => ({
      kind: "secret",
      store: "encrypted-file",
      secret: secretInputFromValue("migrated-renewed-secret-canary-3456"),
      expiresAt: "2031-01-01T00:00:00.000Z",
    })
    const { registry, store, manager } = await fixture({
      expiresAt: "2029-01-01T00:00:00.000Z",
      renew,
      additionalStores: [encryptedStore],
    })
    const ref = await manager.connect({
      provider: "openai",
      method: "api-key",
      nonInteractive: false,
    })

    const renewed = await manager.renew(ref)
    expect(renewed).toMatchObject({ store: "encrypted-file" })
    expect(renewed.locator).not.toBe(ref.locator)
    expect(await registry.get(ref.id)).toEqual(renewed)
    expect(await encryptedStore.get(renewed.locator)).toBe("migrated-renewed-secret-canary-3456")
    expect(await store.get(ref.locator)).toBeUndefined()
  })

  test("redacts active and additional canaries from errors and structured values", async () => {
    const { manager, secret, redactor } = await fixture()
    const ref = await manager.connect({
      provider: "openai",
      method: "api-key",
      nonInteractive: false,
    })
    const resolved = await manager.resolve(ref)
    const consumerError = await resolved
      .useValue(async (value) => {
        throw new Error(`provider echoed Bearer ${value} and ${value}`)
      })
      .then(
        () => new Error("Expected credential consumer failure"),
        (error: unknown) => error as Error,
      )
    expect(consumerError.message).toContain(`Bearer ${REDACTED_SECRET} and ${REDACTED_SECRET}`)
    expect(consumerError.cause).toBeUndefined()

    const release = redactor.register(secret)
    try {
      const redacted = redactor.redactValue({
        authorization: `Bearer ${secret}`,
        nested: { message: `failed with ${secret}` },
      })
      const serialized = JSON.stringify(redacted)
      expect(serialized).not.toContain(secret)
      expect(serialized).toContain(REDACTED_SECRET)
      const redactedError = JSON.stringify(redactor.redactValue(new Error(`failed with ${secret}`)))
      expect(redactedError).not.toContain(secret)
      expect(redactedError).toContain(REDACTED_SECRET)
    } finally {
      release()
    }
  })

  test("preserves repeated shared values while still rejecting active traversal cycles", () => {
    const redactor = new SecretRedactor()
    const shared = { message: "shared credential-canary-1234", apiKey: "must-not-survive" }
    const cyclic: Record<string, unknown> = {
      left: shared,
      right: shared,
      metadata: { secret: false },
    }
    cyclic.self = cyclic

    const redacted = redactor.redactValue(cyclic, ["credential-canary-1234"]) as Record<
      string,
      unknown
    >
    expect(redacted.left).toEqual({
      message: `shared ${REDACTED_SECRET}`,
      apiKey: REDACTED_SECRET,
    })
    expect(redacted.right).toEqual(redacted.left)
    expect(redacted.metadata).toEqual({ secret: false })
    expect(redacted.self).toBe("[CIRCULAR]")
  })

  test("fails closed on provider mismatch, forged refs and unavailable stores", async () => {
    const { manager, store } = await fixture()
    await expect(
      manager.connect({ provider: "openrouter", method: "api-key", nonInteractive: false }),
    ).rejects.toThrow("does not match")
    const ref = await manager.connect({
      id: "explicit-credential",
      provider: "openai",
      method: "api-key",
      nonInteractive: true,
    })
    expect(ref.id).toBe("explicit-credential")
    await expect(
      manager.connect({
        id: "explicit-credential",
        provider: "openai",
        method: "api-key",
        nonInteractive: true,
      }),
    ).rejects.toThrow("already registered")
    const forged: CredentialRef = { ...ref, locator: "openai:forged" }
    await expect(manager.resolve(forged)).rejects.toThrow("does not match registered metadata")
    await expect(manager.renew(forged)).rejects.toThrow("does not match registered metadata")
    await expect(manager.revoke(forged)).rejects.toThrow("does not match registered metadata")
    expect(await manager.status(ref)).toBe("connected")

    store.available = false
    expect(await manager.status(ref)).toBe("unavailable")
    await expect(manager.resolve(ref)).rejects.toThrow("unavailable")
  })
})
