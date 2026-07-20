import { createHash } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import type {
  CredentialCatalogHandle,
  CredentialCommandService,
  CredentialConnectCommandRequest,
  ModelSmokeCommandRequest,
  ModelSmokeCommandService,
  ModelSmokeServiceResult,
} from "@ralph-next/commands"
import {
  type BrowserOpener,
  type CredentialConnectionBroker,
  type CredentialConnectRequest,
  CredentialManager,
  CredentialMetadataRegistry,
  type CredentialMethodInfo,
  type CredentialRef,
  CredentialRefSchema,
  CredentialRemoteRevocationError,
  type CredentialStatus,
  EnvironmentSecretStore,
  type LoopbackCallbackFactory,
  nodeLoopbackCallbackFactory,
  type OAuthClock,
  type OAuthRandomBytes,
  type OAuthTokenSet,
  OsKeychainSecretStore,
  readSecretStream,
  type SecretConnectionMaterial,
  type SecretInput,
  SecretRedactor,
  type SecretStore,
  secretInputFromValue,
  startBrowserOAuth,
  systemBrowserOpener,
} from "@ralph-next/credentials"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  CHATGPT_OAUTH_CALLBACK_PORT,
  CHATGPT_OAUTH_ORIGINATOR,
  ChatGptCodexDriver,
  type ChatGptCredential,
  chatGptCredentialFromTokens,
  DEFAULT_RALPH_OPENAI_USER_AGENT,
  extractAccountId,
  type FetchLike,
  OPENAI_AUTH_ISSUER,
  OPENAI_OAUTH_CLIENT_ID,
  OpenAiApiKeyDriver,
  OpenAiDriverError,
  type OpenAiEvent,
  type OpenAiFinishReason,
  OpenRouterApiKeyDriver,
  pollDeviceAuthorization,
  refreshAccessToken,
  startDeviceAuthorization,
} from "@ralph-next/openai-driver"
import {
  applyDiagnosticRawRetention,
  globalConfigPath,
  rawPersistenceEnabled,
  resolveDiagnosticRawRetention,
} from "@ralph-next/persistence"
import {
  type CatalogResolution,
  CatalogResolutionSchema,
  createModelCatalogRuntime,
  type ModelAccess,
  type ModelCatalog,
  type ModelCatalogSnapshot,
  modelSatisfiesRequirements,
  type PriceSnapshot,
  type ProviderEvent,
  ProviderEventSchema,
  type ProviderInfo,
  resolveModelParameters,
  type TokenUsage,
  TokenUsageSchema,
  type UsageMetric,
} from "@ralph-next/providers"
import {
  acquireFilesystemLease,
  applyPriceSnapshot,
  assertTrustedOpenFile,
  type FilesystemLease,
  openTrustedFile,
  readTrustedFile,
} from "@ralph-next/telemetry"
import { createTerminalProfileForm, type TerminalProfileFormOptions } from "./profile-form"

const CHATGPT_SCOPES = ["openid", "profile", "email", "offline_access"] as const
const CHATGPT_TOKEN_ENDPOINT = `${OPENAI_AUTH_ISSUER}/oauth/token`
const CHATGPT_AUTHORIZATION_ENDPOINT = `${OPENAI_AUTH_ISSUER}/oauth/authorize`
const DEFAULT_SMOKE_TIMEOUT_MS = 30_000
const DEFAULT_ACCOUNT_TIMEOUT_MS = 10 * 60 * 1_000
const REFRESH_SAFETY_WINDOW_MS = 60_000
const MAX_MASKED_SECRET_BYTES = 64 * 1024

type SubscriptionMethod = "oauth-browser" | "device-code" | "subscription-session"

export type AuthorizationNotice = {
  kind: "browser" | "device"
  method: SubscriptionMethod
  url: string
  instructions: string
  browserOpened: boolean
  userCode?: string
  expiresAt?: string
}

export type ChatGptAccountConnectRequest = {
  method: SubscriptionMethod
  headless: boolean
  timeoutMs: number
}

export interface ChatGptAccountFlow {
  connect(request: ChatGptAccountConnectRequest): Promise<ChatGptCredential>
  refresh(credential: ChatGptCredential, timeoutMs: number): Promise<ChatGptCredential>
  revoke?(credential: ChatGptCredential): Promise<void>
}

export type OpenAiChatGptAccountFlowOptions = {
  fetch?: FetchLike
  now?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  openBrowser?: BrowserOpener
  createLoopbackCallback?: LoopbackCallbackFactory
  randomBytes?: OAuthRandomBytes
  onAuthorization?: (notice: AuthorizationNotice) => void | Promise<void>
  userAgent?: string
}

function defaultAuthorizationNotice(notice: AuthorizationNotice): void {
  process.stderr.write(`${notice.instructions}\n`)
}

function systemSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    const cancel = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", cancel, { once: true })
  })
}

function assertChatGptCredential(value: ChatGptCredential): ChatGptCredential {
  if (
    value.kind !== "chatgpt-subscription" ||
    !value.accessToken ||
    !value.refreshToken ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt <= 0
  ) {
    throw new Error("ChatGPT subscription credential has an incompatible shape")
  }
  return { ...value }
}

function parseStoredChatGptCredential(secret: string): ChatGptCredential {
  let value: unknown
  try {
    value = JSON.parse(secret)
  } catch {
    throw new Error("Stored ChatGPT subscription credential is invalid")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored ChatGPT subscription credential is invalid")
  }
  const candidate = value as Record<string, unknown>
  const allowed = new Set([
    "schemaVersion",
    "kind",
    "accessToken",
    "refreshToken",
    "expiresAt",
    "accountId",
  ])
  if (Object.keys(candidate).some((key) => !allowed.has(key)) || candidate.schemaVersion !== 1) {
    throw new Error("Stored ChatGPT subscription credential schema is unsupported")
  }
  return assertChatGptCredential({
    kind: candidate.kind as ChatGptCredential["kind"],
    accessToken: candidate.accessToken as string,
    refreshToken: candidate.refreshToken as string,
    expiresAt: candidate.expiresAt as number,
    ...(typeof candidate.accountId === "string" ? { accountId: candidate.accountId } : {}),
  })
}

function serializeChatGptCredential(credential: ChatGptCredential): string {
  const value = assertChatGptCredential(credential)
  return JSON.stringify({ schemaVersion: 1, ...value })
}

async function browserTokenCredential(
  tokenSet: OAuthTokenSet,
  now: number,
): Promise<ChatGptCredential> {
  const idToken = await tokenSet.idToken?.readOnce()
  const accessToken = await tokenSet.accessToken.readOnce()
  const refreshToken = await tokenSet.refreshToken?.readOnce()
  const expiresAt = tokenSet.expiresAt ? Date.parse(tokenSet.expiresAt) : Number.NaN
  if (
    !idToken ||
    !accessToken ||
    !refreshToken ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  ) {
    throw new OpenAiDriverError(
      "protocol-drift",
      "ChatGPT browser OAuth token response does not match the pinned protocol",
    )
  }
  const accountId = extractAccountId(idToken, accessToken)
  return assertChatGptCredential({
    kind: "chatgpt-subscription",
    accessToken,
    refreshToken,
    expiresAt,
    ...(accountId ? { accountId } : {}),
  })
}

/** Embedded ChatGPT account flow pinned to the OpenAI/Codex protocol adapter. */
export class OpenAiChatGptAccountFlow implements ChatGptAccountFlow {
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  readonly #openBrowser: BrowserOpener
  readonly #createLoopbackCallback: LoopbackCallbackFactory
  readonly #randomBytes: OAuthRandomBytes | undefined
  readonly #onAuthorization: (notice: AuthorizationNotice) => void | Promise<void>
  readonly #userAgent: string

  constructor(options: OpenAiChatGptAccountFlowOptions = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? systemSleep
    this.#openBrowser = options.openBrowser ?? systemBrowserOpener
    this.#createLoopbackCallback = options.createLoopbackCallback ?? chatGptLoopbackCallbackFactory
    this.#randomBytes = options.randomBytes
    this.#onAuthorization = options.onAuthorization ?? defaultAuthorizationNotice
    this.#userAgent = options.userAgent ?? DEFAULT_RALPH_OPENAI_USER_AGENT
  }

  async connect(request: ChatGptAccountConnectRequest): Promise<ChatGptCredential> {
    if (request.method === "oauth-browser" && request.headless) {
      throw new Error(
        "ChatGPT browser OAuth cannot wait for a loopback callback in headless mode; use --method device-code",
      )
    }
    if (
      request.method === "device-code" ||
      (request.method === "subscription-session" && request.headless)
    ) {
      return this.#connectDevice(request)
    }
    return this.#connectBrowser(request)
  }

  async refresh(credential: ChatGptCredential, timeoutMs: number): Promise<ChatGptCredential> {
    const current = assertChatGptCredential(credential)
    const tokens = await refreshAccessToken(
      current.refreshToken,
      { fetch: this.#fetch },
      { timeoutMs },
    )
    return chatGptCredentialFromTokens(tokens, this.#now(), current.accountId)
  }

  async revoke(_credential: ChatGptCredential): Promise<void> {
    // The pinned flow exposes no stable remote revocation endpoint. CredentialManager
    // still removes the rotated local token from keychain and metadata atomically.
  }

  async #connectDevice(request: ChatGptAccountConnectRequest): Promise<ChatGptCredential> {
    const challenge = await startDeviceAuthorization(
      { fetch: this.#fetch },
      { timeoutMs: request.timeoutMs, userAgent: this.#userAgent },
    )
    const browserOpened = request.headless
      ? false
      : await this.#openBrowser(challenge.verificationUrl).catch(() => false)
    await this.#onAuthorization({
      kind: "device",
      method: request.method,
      url: challenge.verificationUrl,
      instructions: browserOpened
        ? `Complete ChatGPT device authorization in the opened browser. Code: ${challenge.userCode}`
        : `Open ${challenge.verificationUrl} and enter code ${challenge.userCode}.`,
      browserOpened,
      userCode: challenge.userCode,
    })
    const tokens = await pollDeviceAuthorization(
      challenge,
      { fetch: this.#fetch, now: this.#now, sleep: this.#sleep },
      {
        timeoutMs: request.timeoutMs,
        userAgent: this.#userAgent,
        maxPolls: Math.max(1, Math.ceil(request.timeoutMs / challenge.intervalMs)),
      },
    )
    return chatGptCredentialFromTokens(tokens, this.#now())
  }

  async #connectBrowser(request: ChatGptAccountConnectRequest): Promise<ChatGptCredential> {
    const clock: OAuthClock = { now: this.#now, sleep: this.#sleep }
    const session = await startBrowserOAuth(
      {
        authorizationEndpoint: CHATGPT_AUTHORIZATION_ENDPOINT,
        tokenEndpoint: CHATGPT_TOKEN_ENDPOINT,
        clientId: OPENAI_OAUTH_CLIENT_ID,
        scopes: CHATGPT_SCOPES,
        callbackPath: "/auth/callback",
        callbackPort: CHATGPT_OAUTH_CALLBACK_PORT,
        timeoutMs: request.timeoutMs,
        headless: false,
        additionalAuthorizationParameters: {
          id_token_add_organizations: "true",
          codex_cli_simplified_flow: "true",
          // This is a pinned upstream protocol parameter, not Ralph branding or a User-Agent.
          originator: CHATGPT_OAUTH_ORIGINATOR,
        },
      },
      {
        fetch: this.#fetch,
        clock,
        openBrowser: this.#openBrowser,
        createLoopbackCallback: this.#createLoopbackCallback,
        ...(this.#randomBytes ? { randomBytes: this.#randomBytes } : {}),
      },
    )
    await this.#onAuthorization({
      kind: "browser",
      method: request.method,
      url: session.authorizationUrl,
      instructions: session.instructions,
      browserOpened: session.browserOpened,
    })
    return browserTokenCredential(await session.complete(), this.#now())
  }
}

/**
 * The pinned ChatGPT client registers localhost while the server remains bound
 * to 127.0.0.1. Advertising localhost preserves the exact redirect contract
 * without widening the listening interface.
 */
export const chatGptLoopbackCallbackFactory: LoopbackCallbackFactory = async (options) => {
  const callback = await nodeLoopbackCallbackFactory(options)
  const redirect = new URL(callback.redirectUri)
  redirect.hostname = "localhost"
  return {
    redirectUri: redirect.toString(),
    wait: (signal) => callback.wait(signal),
    close: () => callback.close(),
  }
}

type PendingConnection = {
  command: CredentialConnectCommandRequest
  secretInput?: SecretInput
}

class ProviderCredentialBroker implements CredentialConnectionBroker {
  readonly #pending = new Map<string, PendingConnection>()

  constructor(
    private readonly accountFlow: ChatGptAccountFlow,
    private readonly readStdin: () => Promise<ReturnType<typeof secretInputFromValue>>,
    private readonly readMasked: (
      label: string,
    ) => Promise<ReturnType<typeof secretInputFromValue>>,
  ) {}

  async run<T>(id: string, pending: PendingConnection, operation: () => Promise<T>): Promise<T> {
    if (this.#pending.has(id)) throw new Error(`Credential connection is already active: ${id}`)
    this.#pending.set(id, pending)
    try {
      return await operation()
    } finally {
      this.#pending.delete(id)
    }
  }

  async connect(
    request: CredentialConnectRequest,
    _method: CredentialMethodInfo,
  ): Promise<SecretConnectionMaterial | { kind: "environment"; variable: string }> {
    const id = request.id
    const pending = id ? this.#pending.get(id) : undefined
    if (!pending) throw new Error("Credential connection context is unavailable")
    const command = pending.command
    if (command.provider !== request.provider || command.method !== request.method) {
      throw new Error("Credential connection context does not match the requested method")
    }
    if (request.method === "environment") {
      if (!command.environmentName) throw new Error("Environment variable name is required")
      return { kind: "environment", variable: command.environmentName }
    }
    if (request.method === "api-key") {
      const secret =
        pending.secretInput ??
        (command.secretSource === "stdin"
          ? await this.readStdin()
          : command.secretSource === "masked-prompt"
            ? await this.readMasked(command.label ?? `${command.provider} API key`)
            : undefined)
      if (!secret) throw new Error("A secure API key input source is required")
      return { kind: "secret", store: "os-keychain", secret }
    }
    if (!isSubscriptionMethod(request.method)) {
      throw new Error(
        `Credential method is not implemented by the embedded runtime: ${request.method}`,
      )
    }
    const credential = await this.accountFlow.connect({
      method: request.method,
      headless: command.headless,
      timeoutMs: command.timeoutMs ?? DEFAULT_ACCOUNT_TIMEOUT_MS,
    })
    return {
      kind: "secret",
      store: "os-keychain",
      secret: secretInputFromValue(serializeChatGptCredential(credential)),
      ...(credential.accountId ? { accountHint: credential.accountId } : {}),
      expiresAt: new Date(credential.expiresAt).toISOString(),
    }
  }

  async renew(ref: CredentialRef, currentSecret: string): Promise<SecretConnectionMaterial> {
    if (!isSubscriptionMethod(ref.method)) {
      throw new Error(`Credential renewal is unsupported: ${ref.method}`)
    }
    const credential = await this.accountFlow.refresh(
      parseStoredChatGptCredential(currentSecret),
      DEFAULT_ACCOUNT_TIMEOUT_MS,
    )
    return {
      kind: "secret",
      store: "os-keychain",
      secret: secretInputFromValue(serializeChatGptCredential(credential)),
      ...(credential.accountId ? { accountHint: credential.accountId } : {}),
      expiresAt: new Date(credential.expiresAt).toISOString(),
    }
  }

  async revoke(ref: CredentialRef, currentSecret: string | undefined): Promise<void> {
    if (!isSubscriptionMethod(ref.method) || !currentSecret || !this.accountFlow.revoke) return
    await this.accountFlow.revoke(parseStoredChatGptCredential(currentSecret))
  }
}

function isSubscriptionMethod(value: string): value is SubscriptionMethod {
  return value === "oauth-browser" || value === "device-code" || value === "subscription-session"
}

async function defaultSecretStdin() {
  return readSecretStream(Bun.stdin.stream(), { maxBytes: MAX_MASKED_SECRET_BYTES })
}

/** Masked terminal input used only when the caller did not select stdin. */
export async function readMaskedSecret(
  label: string,
): Promise<ReturnType<typeof secretInputFromValue>> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !process.stdin.setRawMode) {
    throw new Error("Masked secret input requires a TTY; pipe the API key with --secret-stdin")
  }
  const input = process.stdin
  const wasRaw = Boolean(input.isRaw)
  const wasPaused = input.isPaused()
  process.stderr.write(`${label}: `)
  return new Promise((resolve, reject) => {
    let value = ""
    let settled = false
    const cleanup = () => {
      input.off("data", onData)
      if (!wasRaw) input.setRawMode(false)
      if (wasPaused) input.pause()
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      process.stderr.write("\n")
      cleanup()
      if (error) reject(error)
      else resolve(secretInputFromValue(value))
    }
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\u0003" || character === "\u001b") {
          finish(new Error("Secret input was cancelled"))
          return
        }
        if (character === "\r" || character === "\n") {
          finish(value ? undefined : new Error("Secret input cannot be empty"))
          return
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stderr.write("\b \b")
          }
          continue
        }
        if (character.charCodeAt(0) < 32) continue
        value += character
        if (Buffer.byteLength(value, "utf8") > MAX_MASKED_SECRET_BYTES) {
          finish(new Error("Secret input exceeds the safe size limit"))
          return
        }
        process.stderr.write("*")
      }
    }
    input.setRawMode(true)
    input.on("data", onData)
    input.resume()
  })
}

type ManagerEntry = {
  manager: CredentialManager
  broker: ProviderCredentialBroker
}

type ManagerCacheEntry = {
  fingerprint: string
  pending: Promise<ManagerEntry>
}

type TrustedProvider = {
  provider: ProviderInfo
  fingerprint: string
}

function providerManagerFingerprint(provider: ProviderInfo, snapshotId: string): string {
  return createHash("sha256").update(JSON.stringify({ snapshotId, provider })).digest("hex")
}

function deepFreezeCatalogResolution(resolution: CatalogResolution): CatalogResolution {
  const pending: object[] = [resolution]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || seen.has(current)) continue
    seen.add(current)
    for (const value of Object.values(current)) {
      if (value !== null && typeof value === "object") pending.push(value)
    }
    Object.freeze(current)
  }
  return resolution
}

export type S04CredentialServiceOptions = {
  catalog: () => Promise<ModelCatalog>
  registry: CredentialMetadataRegistry
  environment: Record<string, string | undefined>
  keychainStore: SecretStore
  accountFlow: ChatGptAccountFlow
  readSecretStdin: () => Promise<ReturnType<typeof secretInputFromValue>>
  readMaskedSecret: (label: string) => Promise<ReturnType<typeof secretInputFromValue>>
  now: () => number
  credentialId: () => string
}

export class S04CredentialService implements CredentialCommandService {
  readonly #managers = new Map<string, ManagerCacheEntry>()
  readonly #catalogHandles = new WeakSet<CredentialCatalogHandle>()

  constructor(private readonly options: S04CredentialServiceOptions) {
    if (options.keychainStore.kind !== "os-keychain") {
      throw new Error("S04 credential runtime requires an os-keychain secret store")
    }
  }

  async catalogSnapshot(
    options: { refresh: boolean } = { refresh: false },
  ): Promise<CredentialCatalogHandle> {
    const resolution = deepFreezeCatalogResolution(
      CatalogResolutionSchema.parse(
        await (await this.options.catalog()).snapshot({ forceRefresh: options.refresh }),
      ),
    )
    const handle = Object.freeze({ resolution })
    this.#catalogHandles.add(handle)
    return handle
  }

  async connect(request: CredentialConnectCommandRequest): Promise<CredentialRef> {
    return this.#connect(request)
  }

  async connectWithSecretInput(
    request: CredentialConnectCommandRequest,
    secretInput: SecretInput,
  ): Promise<CredentialRef> {
    if (request.method !== "api-key" || request.secretSource !== "not-applicable") {
      throw new Error("Direct secret input is restricted to API-key authentication")
    }
    return this.#connect(request, secretInput)
  }

  async #connect(
    request: CredentialConnectCommandRequest,
    secretInput?: SecretInput,
  ): Promise<CredentialRef> {
    if (request.allowInsecureStore) {
      throw new Error(
        "Plaintext credential storage is intentionally unavailable; configure an OS keychain",
      )
    }
    const trusted = this.#trustedProvider(
      request.catalogHandle,
      request.providerInfo,
      request.provider,
      request.method,
    )
    if (request.method === "oauth-browser" && (request.headless || request.nonInteractive)) {
      throw new RalphError(
        "RALPH_AUTH_BROWSER_OAUTH_UNAVAILABLE_HEADLESS",
        "Browser OAuth cannot wait for a loopback callback in headless or non-interactive mode",
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: "Use `auth connect <provider> --method device-code` for a headless subscription login.",
        },
      )
    }
    const entry = await this.#manager(request.provider, trusted.provider, trusted.fingerprint)
    const id = request.credentialId ?? this.options.credentialId()
    return entry.broker.run(id, { command: request, ...(secretInput ? { secretInput } : {}) }, () =>
      entry.manager.connect({
        id,
        provider: request.provider,
        method: request.method,
        ...(request.label ? { label: request.label } : {}),
        nonInteractive: request.nonInteractive,
      }),
    )
  }

  async list(): Promise<readonly CredentialRef[]> {
    return this.options.registry.list()
  }

  async status(
    ref: CredentialRef,
    options: {
      refresh: boolean
      provider: ProviderInfo
      catalogHandle?: CredentialCatalogHandle
    },
  ): Promise<CredentialStatus> {
    const current = await this.options.registry.get(ref.id)
    if (!current) return "revoked"
    const trusted = this.#trustedProvider(
      options.catalogHandle,
      options.provider,
      current.provider,
      current.method,
    )
    const entry = await this.#manager(current.provider, trusted.provider, trusted.fingerprint)
    if (options.refresh && isSubscriptionMethod(current.method)) {
      const renewed = await entry.manager.renew(current)
      return entry.manager.status(renewed)
    }
    return entry.manager.status(current)
  }

  async revoke(ref: CredentialRef): Promise<void> {
    const requested = CredentialRefSchema.parse(ref)
    // Revocation is a local recovery/cleanup operation. It must not become
    // impossible merely because a provider, method, or the whole catalog is
    // currently unavailable. CredentialManager still revalidates the exact
    // registered ref and removes secret material before metadata.
    try {
      await (await this.#cleanupManager(requested.provider)).manager.revoke(requested)
    } catch (error) {
      if (error instanceof CredentialRemoteRevocationError) {
        throw new RalphError(
          "RALPH_CREDENTIAL_REMOTE_REVOKE_UNCONFIRMED",
          "Local credential material was removed, but remote revocation could not be confirmed",
          {
            exitCode: EXIT_CODES.providerUnavailable,
            details: { localRevoked: true, remoteRevoked: false },
          },
        )
      }
      throw error
    }
  }

  async resolveForModelUse(
    id: string,
    provider: ProviderInfo,
    catalogHandle: CredentialCatalogHandle,
    options: { refresh: boolean },
  ): Promise<{
    ref: CredentialRef
    useValue<T>(consumer: (secret: string) => Promise<T>): Promise<T>
  }> {
    let ref = await this.#registered(id)
    const trusted = this.#trustedProvider(catalogHandle, provider, ref.provider, ref.method)
    const entry = await this.#manager(ref.provider, trusted.provider, trusted.fingerprint)
    if (
      isSubscriptionMethod(ref.method) &&
      (options.refresh ||
        (ref.expiresAt &&
          Date.parse(ref.expiresAt) <= this.options.now() + REFRESH_SAFETY_WINDOW_MS))
    ) {
      ref = await entry.manager.renew(ref)
    }
    const status = await entry.manager.status(ref)
    if (status !== "connected") throw new Error(`Credential ${ref.id} is ${status}`)
    return entry.manager.resolve(ref)
  }

  /** Backward-compatible S04 name; production execution uses resolveForModelUse. */
  async resolveForSmoke(
    id: string,
    provider: ProviderInfo,
    catalogHandle: CredentialCatalogHandle,
    options: { refresh: boolean },
  ): Promise<{
    ref: CredentialRef
    useValue<T>(consumer: (secret: string) => Promise<T>): Promise<T>
  }> {
    return this.resolveForModelUse(id, provider, catalogHandle, options)
  }

  async #registered(id: string): Promise<CredentialRef> {
    const ref = await this.options.registry.get(id)
    if (!ref) throw new Error(`Credential reference was not found: ${id}`)
    return ref
  }

  #trustedProvider(
    handle: CredentialCatalogHandle | undefined,
    providerInfo: ProviderInfo | undefined,
    providerId: string,
    method: CredentialRef["method"],
  ): TrustedProvider {
    if (!handle) {
      throw new RalphError(
        "RALPH_CREDENTIAL_CATALOG_HANDLE_REQUIRED",
        "A service-owned catalog handle is required for credential provider operations",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (!this.#catalogHandles.has(handle)) {
      throw new RalphError(
        "RALPH_CREDENTIAL_CATALOG_HANDLE_UNTRUSTED",
        "The credential catalog handle was not issued by this service instance",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (!providerInfo) {
      throw new RalphError(
        "RALPH_CREDENTIAL_PROVIDER_REQUIRED",
        "The exact provider record from the trusted catalog handle is required",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    const provider = handle.resolution.snapshot.providers.find(
      (candidate) => candidate.id === providerId,
    )
    if (!provider) {
      throw new RalphError(
        "RALPH_CREDENTIAL_PROVIDER_NOT_FOUND",
        `Provider is absent from the trusted catalog snapshot: ${providerId}`,
        {
          exitCode: EXIT_CODES.providerUnavailable,
          details: {
            provider: providerId,
            catalogSnapshotId: handle.resolution.snapshot.id,
          },
        },
      )
    }
    if (providerInfo !== provider) {
      throw new RalphError(
        "RALPH_CREDENTIAL_PROVIDER_UNTRUSTED",
        "The provider record does not belong to the supplied service-owned catalog handle",
        {
          exitCode: EXIT_CODES.invalidUsage,
          details: { provider: providerId },
        },
      )
    }
    if (!provider.credentialMethods.some((candidate) => candidate.method === method)) {
      throw new RalphError(
        "RALPH_AUTH_METHOD_UNSUPPORTED",
        `Authentication method ${method} is not advertised by provider ${providerId}`,
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: `Inspect \`providers inspect ${providerId}\` and choose an advertised authentication method.`,
          details: {
            provider: providerId,
            method,
            catalogSnapshotId: handle.resolution.snapshot.id,
          },
        },
      )
    }
    return {
      provider,
      fingerprint: providerManagerFingerprint(provider, handle.resolution.snapshot.id),
    }
  }

  async #manager(
    providerId: string,
    exactProvider: ProviderInfo,
    exactFingerprint: string,
  ): Promise<ManagerEntry> {
    // Validate the requested contract before consulting the cache. A warm
    // provider manager must never mask a mismatched exact provider record.
    if (exactProvider.id !== providerId) {
      throw new Error("Exact catalog provider does not match the credential provider")
    }
    const existing = this.#managers.get(providerId)
    const fingerprint = exactFingerprint
    if (existing?.fingerprint === fingerprint) return existing.pending
    const pending = this.#createManager(providerId, exactProvider)
    const cached = { fingerprint, pending }
    this.#managers.set(providerId, cached)
    try {
      return await pending
    } catch (error) {
      if (this.#managers.get(providerId) === cached) this.#managers.delete(providerId)
      throw error
    }
  }

  async #cleanupManager(providerId: string): Promise<ManagerEntry> {
    const existing = this.#managers.get(providerId)
    if (existing) return existing.pending
    const pending = Promise.resolve(this.#createManagerEntry(providerId, []))
    const cached = { fingerprint: "local-cleanup", pending }
    this.#managers.set(providerId, cached)
    try {
      return await pending
    } catch (error) {
      if (this.#managers.get(providerId) === cached) this.#managers.delete(providerId)
      throw error
    }
  }

  async #createManager(providerId: string, exactProvider: ProviderInfo): Promise<ManagerEntry> {
    if (exactProvider.id !== providerId) {
      throw new Error("Exact catalog provider does not match the credential provider")
    }
    const provider = exactProvider
    return this.#createManagerEntry(providerId, provider.credentialMethods)
  }

  #createManagerEntry(providerId: string, methods: readonly CredentialMethodInfo[]): ManagerEntry {
    const broker = new ProviderCredentialBroker(
      this.options.accountFlow,
      this.options.readSecretStdin,
      this.options.readMaskedSecret,
    )
    const manager = new CredentialManager({
      providerId,
      methods,
      registry: this.options.registry,
      stores: [this.options.keychainStore, new EnvironmentSecretStore(this.options.environment)],
      broker,
      now: () => new Date(this.options.now()),
      id: this.options.credentialId,
    })
    return { manager, broker }
  }
}

export class ModelSmokeFailure extends RalphError {
  constructor(
    readonly kind: string,
    message: string,
    readonly rawRef: string | undefined,
    readonly retryAfterMs?: number,
    readonly events: readonly ProviderEvent[] = [],
  ) {
    super("RALPH_MODEL_SMOKE_FAILED", message, {
      exitCode: EXIT_CODES.providerUnavailable,
      details: {
        kind,
        ...(rawRef ? { rawRef } : {}),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        events,
      },
    })
    this.name = "ModelSmokeFailure"
  }
}

export type S04ModelSmokeServiceResult = ModelSmokeServiceResult & {
  catalogSnapshotId: string
  catalogOrigin: CatalogResolution["origin"]
  catalogStale: boolean
}

export type S04ModelSmokeServiceOptions = {
  credentials: S04CredentialService
  fetch: FetchLike
  rawDirectory: string
  now: () => number
  callId: () => string
}

type RawSmokeRecord = {
  schemaVersion: 1
  callId: string
  provider: string
  model: string
  variant?: string
  effectiveParameters: Readonly<Record<string, unknown>>
  catalog: {
    snapshotId: string
    origin: CatalogResolution["origin"]
    stale: boolean
    warning?: string
    source: ModelCatalogSnapshot["source"]
  }
  events: readonly OpenAiEvent[]
  error?: Record<string, unknown>
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function rawSmokeScopePartition(diagnosticScope: string): string {
  const resolvedScope = resolve(diagnosticScope)
  const portableScope =
    process.platform === "win32" ? resolvedScope.toLocaleLowerCase("und") : resolvedScope
  return sha256(`ralph.model-smoke.scope.v2\0${portableScope}`)
}

export function rawSmokePath(rawDirectory: string, rawRef: string): string {
  const match = /^raw:\/\/model-smoke\/([a-f0-9]{64})\/([a-f0-9]{64})$/.exec(rawRef)
  if (match?.[1] && match[2]) return join(rawDirectory, match[1], `${match[2]}.json`)
  const legacy = /^raw:\/\/sha256\/([a-f0-9]{64})$/.exec(rawRef)
  if (legacy?.[1]) return join(rawDirectory, "sha256", `${legacy[1]}.json`)
  throw new Error("Raw smoke reference is invalid")
}

async function persistRawSmoke(
  rawDirectory: string,
  record: RawSmokeRecord,
  secrets: readonly string[],
  maximumBytes: number,
  diagnosticScope: string,
): Promise<{
  readonly rawRef: string
  readonly contentHash: string
  readonly activeLease: FilesystemLease
}> {
  const redactor = new SecretRedactor()
  const redacted = redactor.redactValue(record, secrets)
  const complete = `${JSON.stringify(redacted, null, 2)}\n`
  const content =
    Buffer.byteLength(complete, "utf8") <= maximumBytes
      ? complete
      : `${JSON.stringify(
          {
            schemaVersion: 1,
            type: "model-smoke.capture.truncated",
            callId: record.callId,
            provider: record.provider,
            model: record.model,
            originalBytes: Buffer.byteLength(complete, "utf8"),
            maximumBytes,
          },
          null,
          2,
        )}\n`
  for (const secret of secrets) {
    if (secret.length >= 4 && content.includes(secret)) {
      throw new Error("Raw model output still contains secret material after redaction")
    }
  }
  const hash = sha256(content)
  // Scope is intentionally stable across telemetry-policy edits. The current
  // policy must continue sweeping captures created under earlier policies for
  // this same workspace/cwd instead of orphaning one directory per edit.
  const partition = rawSmokeScopePartition(diagnosticScope)
  const ref = `raw://model-smoke/${partition}/${hash}`
  const target = rawSmokePath(rawDirectory, ref)
  const partitionRoot = dirname(target)
  // Lock order is always capture -> root mutation. A competing identical
  // capture therefore waits without holding the mutation lease needed by this
  // capture's retention pass.
  const activeLease = await acquireFilesystemLease(partitionRoot, `${hash}.json.capture.lock`)
  let lease: FilesystemLease | undefined
  let persisted:
    | {
        readonly rawRef: string
        readonly contentHash: string
        readonly activeLease: FilesystemLease
      }
    | undefined
  let operationFailed = false
  let operationError: unknown
  try {
    await activeLease.assertOwned()
    lease = await acquireFilesystemLease(partitionRoot, ".raw.mutation.lock")
    await activeLease.assertOwned()
    await lease.assertOwned()
    let handle: Awaited<ReturnType<typeof openTrustedFile>> | undefined
    try {
      handle = await openTrustedFile(target, "exclusive", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      await lease.assertOwned()
      await activeLease.assertOwned()
      const existing = (await readTrustedFile(target)).toString("utf8")
      if (existing !== content) {
        throw new Error("Content-addressed raw smoke capture has conflicting bytes")
      }
      persisted = { rawRef: ref, contentHash: hash, activeLease }
    }
    if (handle) {
      try {
        await lease.assertOwned()
        await activeLease.assertOwned()
        await assertTrustedOpenFile(target, handle)
        await handle.writeFile(content, "utf8")
        await handle.sync()
        await assertTrustedOpenFile(target, handle)
        await activeLease.assertOwned()
        await lease.assertOwned()
        persisted = { rawRef: ref, contentHash: hash, activeLease }
      } finally {
        await handle.close()
      }
    }
  } catch (error) {
    operationFailed = true
    operationError = error
  }

  let releaseFailed = false
  let releaseError: unknown
  if (lease) {
    try {
      await lease.release()
    } catch (error) {
      releaseFailed = true
      releaseError = error
    }
  }

  if (operationFailed || releaseFailed || !persisted) {
    await activeLease.release().catch(() => undefined)
    if (releaseFailed) throw releaseError
    if (operationFailed) throw operationError
    throw new Error("Raw smoke capture completed without a durable result")
  }
  return persisted
}

function safeErrorRecord(error: unknown, secrets: readonly string[]): Record<string, unknown> {
  const redactor = new SecretRedactor()
  if (error instanceof OpenAiDriverError) {
    return {
      name: error.name,
      kind: error.kind,
      message: redactor.redactText(error.message, secrets),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    }
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: redactor.redactText(error instanceof Error ? error.message : String(error), secrets),
  }
}

function hasUsageCounters(value: {
  input?: number | undefined
  output?: number | undefined
  reasoning?: number | undefined
  cacheRead?: number | undefined
  cacheWrite?: number | undefined
  total?: number | undefined
}): boolean {
  return [
    value.input,
    value.output,
    value.reasoning,
    value.cacheRead,
    value.cacheWrite,
    value.total,
  ].some((item) => item !== undefined)
}

function providerUsage(
  value: {
    input?: number | undefined
    output?: number | undefined
    reasoning?: number | undefined
    cacheRead?: number | undefined
    cacheWrite?: number | undefined
    total?: number | undefined
    source: "reported" | "derived" | "estimated" | "unavailable"
  },
  semantics: "delta" | "cumulative" | "final",
  rawRef?: string,
): TokenUsage {
  if (value.source === "unavailable" || !hasUsageCounters(value)) {
    return TokenUsageSchema.parse({
      source: "unavailable",
      semantics,
      ...(rawRef ? { providerRawRef: rawRef } : {}),
    })
  }
  const cacheRead = value.cacheRead ?? 0
  const cacheWrite = value.cacheWrite ?? 0
  if (
    value.input !== undefined &&
    (cacheRead > value.input || cacheWrite > value.input - cacheRead)
  ) {
    throw new OpenAiDriverError("protocol-drift", "Provider cache usage exceeds total input usage")
  }
  return TokenUsageSchema.parse({
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.input === undefined ||
    (value.cacheRead === undefined && value.cacheWrite === undefined)
      ? {}
      : { inputNonCached: value.input - cacheRead - cacheWrite }),
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
    ...(value.cacheRead === undefined ? {} : { cacheRead: value.cacheRead }),
    ...(value.cacheWrite === undefined ? {} : { cacheWrite: value.cacheWrite }),
    ...(value.total === undefined ? {} : { total: value.total }),
    source: value.source,
    semantics,
    ...(rawRef ? { providerRawRef: rawRef } : {}),
  })
}

function smokeRawReference(rawRef: string | undefined): { rawRef?: string } {
  return rawRef ? { rawRef } : {}
}

function normalizeEvents(options: {
  source: readonly OpenAiEvent[]
  syntheticSourceSequences?: ReadonlySet<number>
  callId: string
  rawRef?: string
  snapshot: ModelCatalogSnapshot
  resolution: CatalogResolution
  price: PriceSnapshot
  access: ModelAccess
  usageMetrics: readonly UsageMetric[]
  secrets: readonly string[]
  now: () => number
}): {
  events: readonly ProviderEvent[]
  text: string
  finishReason: OpenAiFinishReason
  usage: TokenUsage
} {
  const output: ProviderEvent[] = []
  const redactor = new SecretRedactor()
  const textParts: string[] = []
  const reasoningParts: string[] = []
  let usage: TokenUsage | undefined
  let finalUsage: TokenUsage | undefined
  let finalUsageEmitted = false
  let pricingWarningEmitted = false
  let finishReason: OpenAiFinishReason = "unknown"
  let finishProviderEventId: string | undefined
  let sequence = 0
  const emit = (
    type: ProviderEvent["type"],
    level: ProviderEvent["level"],
    payload: Record<string, unknown>,
    synthesized: boolean,
    providerEventId?: string,
  ) => {
    sequence += 1
    output.push(
      ProviderEventSchema.parse({
        schemaVersion: 1,
        eventId: `${options.callId}:${sequence}`,
        ...(providerEventId ? { providerEventId } : {}),
        callId: options.callId,
        sequence,
        timestamp: new Date(options.now()).toISOString(),
        type,
        level,
        synthesized,
        payload,
      }),
    )
  }

  for (const event of options.source) {
    if (event.type === "raw") continue
    if (event.type === "text") {
      const delta = redactor.redactText(event.delta, options.secrets)
      textParts.push(delta)
      emit(
        "model.text.delta",
        "info",
        { delta, ...smokeRawReference(options.rawRef) },
        false,
        event.providerEventId,
      )
      continue
    }
    if (event.type === "reasoning") {
      const delta = redactor.redactText(event.delta, options.secrets)
      reasoningParts.push(delta)
      emit(
        "model.reasoning.delta",
        "debug",
        { delta, ...smokeRawReference(options.rawRef) },
        false,
        event.providerEventId,
      )
      continue
    }
    if (event.type === "tool-input" || event.type === "tool-call") {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Read-only model smoke emitted an unrequested tool call",
      )
    }
    if (event.type === "usage") {
      if (finalUsageEmitted) {
        throw new OpenAiDriverError(
          "protocol-drift",
          "Provider emitted usage after the final usage settlement",
        )
      }
      const eventPricing = applyPriceSnapshot(
        providerUsage(
          event.semantics === "delta" ? event.delta : event.aggregate,
          event.semantics,
          options.rawRef,
        ),
        options.price,
        options.access,
        options.usageMetrics,
      )
      const finalPricing = applyPriceSnapshot(
        providerUsage(event.aggregate, "final", options.rawRef),
        options.price,
        options.access,
        options.usageMetrics,
      )
      finalUsage = finalPricing.usage
      usage = eventPricing.usage
      finalUsageEmitted = eventPricing.usage.semantics === "final"
      if (
        finalUsageEmitted &&
        !finalPricing.priced &&
        finalPricing.reason &&
        !pricingWarningEmitted
      ) {
        emit(
          "model.provider.warning",
          "warn",
          {
            kind: "pricing-unavailable",
            code: "RALPH_MODEL_COST_UNAVAILABLE",
            message: finalPricing.reason,
            ...smokeRawReference(options.rawRef),
          },
          true,
          event.providerEventId,
        )
        pricingWarningEmitted = true
      }
      emit(
        "model.usage.updated",
        "info",
        { usage: eventPricing.usage },
        false,
        event.providerEventId,
      )
      continue
    }
    if (event.type === "error") {
      finishReason = "error"
      finishProviderEventId = event.providerEventId
      emit(
        "model.provider.error",
        "error",
        {
          kind: event.error.kind,
          message: redactor.redactText(event.error.message, options.secrets),
          ...(event.error.code ? { code: event.error.code } : {}),
          ...smokeRawReference(options.rawRef),
        },
        options.syntheticSourceSequences?.has(event.sequence) ?? false,
        event.providerEventId,
      )
      continue
    }
    if (event.type === "finish") {
      finishReason = event.reason
      finishProviderEventId = event.providerEventId
    }
  }

  const text = textParts.join("")
  if (textParts.length > 0) {
    emit("model.text.completed", "info", { text, ...smokeRawReference(options.rawRef) }, true)
  }
  if (reasoningParts.length > 0) {
    emit(
      "model.reasoning.completed",
      "debug",
      { summary: reasoningParts.join(""), ...smokeRawReference(options.rawRef) },
      true,
    )
  }
  if (!finalUsageEmitted) {
    // Delta/cumulative observations already produced a deterministic final
    // aggregate. Only streams with no recognized counters are unavailable.
    finalUsage ??= TokenUsageSchema.parse({
      source: "unavailable",
      semantics: "final",
      ...(options.rawRef ? { providerRawRef: options.rawRef } : {}),
    })
    emit("model.usage.updated", "info", { usage: finalUsage }, true)
  }
  usage = finalUsage as TokenUsage
  emit(
    "model.call.finished",
    "info",
    {
      finishReason,
      ...smokeRawReference(options.rawRef),
      catalogSnapshotId: options.snapshot.id,
      catalogOrigin: options.resolution.origin,
      catalogStale: options.resolution.stale,
      catalogSource: options.snapshot.source,
    },
    true,
    finishProviderEventId,
  )
  return { events: output, text, finishReason, usage }
}

function sourceEventsWithFailure(
  source: readonly OpenAiEvent[],
  error: unknown,
): {
  source: readonly OpenAiEvent[]
  syntheticErrorSequence?: number
} {
  if (source.some((event) => event.type === "error")) return { source }
  const failure =
    error instanceof OpenAiDriverError
      ? { kind: error.kind, message: error.message }
      : { kind: "provider" as const, message: "The embedded model smoke call failed" }
  const sequence = source.reduce((maximum, event) => Math.max(maximum, event.sequence), 0) + 1
  return {
    source: [...source, { type: "error", sequence, error: failure }],
    syntheticErrorSequence: sequence,
  }
}

function credentialAccess(ref: CredentialRef): "api" | "subscription" {
  return isSubscriptionMethod(ref.method) ? "subscription" : "api"
}

function assertCredentialLeaseBinding(expected: CredentialRef, observed: CredentialRef): void {
  const changed =
    observed.id !== expected.id ||
    observed.provider !== expected.provider ||
    observed.method !== expected.method ||
    observed.store !== expected.store ||
    observed.locator !== expected.locator
  if (!changed) return
  throw new RalphError(
    "RALPH_CREDENTIAL_LEASE_BINDING_CHANGED",
    "Credential identity or access method changed after the role profile was resolved",
    {
      exitCode: EXIT_CODES.conflict,
      details: {
        credential: expected.id,
        expectedProvider: expected.provider,
        observedProvider: observed.provider,
        expectedMethod: expected.method,
        observedMethod: observed.method,
      },
      hint: "Resolve the role profile again; Ralph will not reuse pricing or authorization across a changed credential binding.",
    },
  )
}

export type S04OpenAiInvoker = ChatGptCodexDriver | OpenAiApiKeyDriver | OpenRouterApiKeyDriver

export type S04OpenAiInvokerLease = {
  withInvoker<T>(
    consumer: (invoker: S04OpenAiInvoker, secrets: readonly string[]) => Promise<T>,
  ): Promise<T>
}

/**
 * Creates a short-lived credential lease for S05 model calls. Secret material
 * only exists inside `withInvoker`; subscription tokens are refreshed by the
 * credential service before each provider turn and never enter role profiles.
 */
export function createS04OpenAiInvokerLease(options: {
  credentials: S04CredentialService
  credential: CredentialRef
  provider: ProviderInfo
  catalogHandle: CredentialCatalogHandle
  fetch?: FetchLike
  now?: () => number
}): S04OpenAiInvokerLease {
  const expectedCredential = CredentialRefSchema.parse(options.credential)
  if (options.provider.id !== "openai") {
    throw new Error(`OpenAI invoker lease cannot serve provider ${options.provider.id}`)
  }
  return {
    async withInvoker(consumer) {
      const resolved = await options.credentials.resolveForModelUse(
        expectedCredential.id,
        options.provider,
        options.catalogHandle,
        { refresh: false },
      )
      assertCredentialLeaseBinding(expectedCredential, resolved.ref)
      return resolved.useValue(async (secret) => {
        if (isSubscriptionMethod(resolved.ref.method)) {
          const credential = parseStoredChatGptCredential(secret)
          return consumer(
            new ChatGptCodexDriver({
              credential,
              fetch: options.fetch ?? fetch,
              ...(options.now ? { now: options.now } : {}),
            }),
            [secret, credential.accessToken, credential.refreshToken],
          )
        }
        return consumer(
          new OpenAiApiKeyDriver({
            apiKey: secret,
            fetch: options.fetch ?? fetch,
          }),
          [secret],
        )
      })
    },
  }
}

/**
 * OpenRouter uses its pinned OpenAI-compatible Responses endpoint, but only
 * API/environment credentials are accepted. Subscription credentials are an
 * OpenAI/ChatGPT-specific protocol and never fall through to this adapter.
 */
export function createS04OpenRouterInvokerLease(options: {
  credentials: S04CredentialService
  credential: CredentialRef
  provider: ProviderInfo
  catalogHandle: CredentialCatalogHandle
  fetch?: FetchLike
}): S04OpenAiInvokerLease {
  const expectedCredential = CredentialRefSchema.parse(options.credential)
  if (options.provider.id !== "openrouter") {
    throw new Error(`OpenRouter invoker lease cannot serve provider ${options.provider.id}`)
  }
  return {
    async withInvoker<T>(
      consumer: (invoker: S04OpenAiInvoker, secrets: readonly string[]) => Promise<T>,
    ) {
      const resolved = await options.credentials.resolveForModelUse(
        expectedCredential.id,
        options.provider,
        options.catalogHandle,
        { refresh: false },
      )
      assertCredentialLeaseBinding(expectedCredential, resolved.ref)
      if (isSubscriptionMethod(resolved.ref.method)) {
        throw new RalphError(
          "RALPH_OPENROUTER_SUBSCRIPTION_UNSUPPORTED",
          "OpenRouter embedded execution requires an API-key or environment credential",
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      return resolved.useValue((secret) =>
        consumer(
          new OpenRouterApiKeyDriver({
            apiKey: secret,
            fetch: options.fetch ?? fetch,
          }),
          [secret],
        ),
      )
    },
  }
}

export class S04ModelSmokeService implements ModelSmokeCommandService {
  constructor(private readonly options: S04ModelSmokeServiceOptions) {}

  async smoke(request: ModelSmokeCommandRequest): Promise<S04ModelSmokeServiceResult> {
    if (!request.readOnly || request.tools.length !== 0) {
      throw new Error("S04 model smoke must be read-only and cannot expose tools")
    }
    if (request.provider !== "openai" && request.provider !== "openrouter") {
      throw new Error(
        `Embedded S04 smoke keeps ${request.provider} catalog-only/fail-closed until it has an implemented driver`,
      )
    }
    if (!request.credentialId) {
      throw new Error(`${request.provider} model smoke requires a credential reference`)
    }

    // The model selection and credential resolution share one service-owned
    // catalog capability, so resolveForSmoke cannot be called with forged
    // ProviderInfo/snapshot metadata and no second snapshot is needed.
    const catalogHandle = await this.options.credentials.catalogSnapshot({
      refresh: request.refreshCatalog,
    })
    const resolution = catalogHandle.resolution
    const provider = resolution.snapshot.providers.find(
      (candidate) => candidate.id === request.provider,
    )
    const model = resolution.snapshot.models.find(
      (candidate) => candidate.provider === request.provider && candidate.id === request.model,
    )
    if (!provider || provider.status === "unavailable" || provider.status === "deprecated") {
      throw new Error(`Provider is unavailable in catalog snapshot: ${request.provider}`)
    }
    if (!model || model.status === "unavailable" || model.status === "deprecated") {
      throw new Error(
        `Model is unavailable in catalog snapshot: ${request.provider}/${request.model}`,
      )
    }
    if (!model.capabilities.input.includes("text")) {
      throw new Error(`Model does not accept text input: ${request.provider}/${request.model}`)
    }
    if (!modelSatisfiesRequirements(model, request.requirements)) {
      throw new RalphError(
        "RALPH_PROFILE_MODEL_CAPABILITY_MISMATCH",
        `Model ${request.provider}/${request.model} does not satisfy the smoke requirements`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    const effective = resolveModelParameters(model, {
      ...(request.variant ? { variant: request.variant } : {}),
      parameters: request.parameters,
    })

    let resolved: Awaited<ReturnType<S04CredentialService["resolveForSmoke"]>>
    try {
      resolved = await this.options.credentials.resolveForSmoke(
        request.credentialId,
        provider,
        catalogHandle,
        { refresh: request.refreshCatalog },
      )
    } catch {
      throw new RalphError(
        "RALPH_MODEL_SMOKE_CREDENTIAL_UNAVAILABLE",
        `Credential ${request.credentialId} is unavailable for the exact catalog snapshot`,
        {
          exitCode: EXIT_CODES.providerUnavailable,
          hint: "Inspect the credential status and reconnect it if necessary.",
        },
      )
    }
    if (resolved.ref.provider !== request.provider) {
      throw new Error(`Credential ${resolved.ref.id} does not belong to ${request.provider}`)
    }
    const access = credentialAccess(resolved.ref)
    if (!model.access.includes(access)) {
      throw new Error(
        `Credential access ${access} is incompatible with ${request.provider}/${request.model}`,
      )
    }

    const callId = `smoke-${this.options.callId()}`
    const timeoutMs = request.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS
    let capturedFailure: ModelSmokeFailure | undefined
    try {
      return await resolved.useValue(async (secret) => {
        const sourceEvents: OpenAiEvent[] = []
        const sink = async (event: OpenAiEvent) => {
          sourceEvents.push(event)
        }
        let accountCredential: ChatGptCredential | undefined
        const secrets = [secret]
        const retention = resolveDiagnosticRawRetention(request.telemetry)
        const captureRaw = async (record: RawSmokeRecord): Promise<string | undefined> => {
          const scopeRoot = join(
            this.options.rawDirectory,
            rawSmokeScopePartition(request.diagnosticScope),
          )
          // Raw persistence is optional. When disabled, neither storage access
          // nor cleanup failure may change the provider smoke outcome.
          if (!rawPersistenceEnabled(request.telemetry)) return undefined
          const persisted = await persistRawSmoke(
            this.options.rawDirectory,
            record,
            secrets,
            retention.maximumFileBytes,
            request.diagnosticScope,
          )
          const target = rawSmokePath(this.options.rawDirectory, persisted.rawRef)
          try {
            const receipt = await applyDiagnosticRawRetention(
              scopeRoot,
              retention,
              this.options.now(),
              [target],
            )
            if (receipt.blocked || receipt.overBudget) {
              throw new Error(
                `Model smoke raw retention was not enforced: ${receipt.blockedReason ?? "partition remains over budget"}`,
              )
            }
            await persisted.activeLease.assertOwned()
            const retainedContent = await readTrustedFile(target)
            const retainedHash = createHash("sha256").update(retainedContent).digest("hex")
            if (retainedHash !== persisted.contentHash) {
              throw new Error("Model smoke raw reference changed bytes during retention")
            }
            return persisted.rawRef
          } finally {
            await persisted.activeLease.release()
          }
        }
        const driver = isSubscriptionMethod(resolved.ref.method)
          ? (() => {
              if (request.provider !== "openai") {
                throw new RalphError(
                  "RALPH_PROVIDER_SUBSCRIPTION_UNSUPPORTED",
                  `${request.provider} embedded smoke does not support subscription credentials`,
                  { exitCode: EXIT_CODES.invalidUsage },
                )
              }
              accountCredential = parseStoredChatGptCredential(secret)
              secrets.push(accountCredential.accessToken, accountCredential.refreshToken)
              return new ChatGptCodexDriver({
                credential: accountCredential,
                fetch: this.options.fetch,
                now: this.options.now,
              })
            })()
          : request.provider === "openrouter"
            ? new OpenRouterApiKeyDriver({ apiKey: secret, fetch: this.options.fetch })
            : new OpenAiApiKeyDriver({ apiKey: secret, fetch: this.options.fetch })

        try {
          const consumed = await driver.smoke(
            {
              model: request.model,
              prompt: request.prompt,
              parameters: effective.parameters,
            },
            sink,
            { timeoutMs },
          )
          const rawRef = await captureRaw({
            schemaVersion: 1,
            callId,
            provider: request.provider,
            model: request.model,
            ...(request.variant ? { variant: request.variant } : {}),
            effectiveParameters: effective.parameters,
            catalog: {
              snapshotId: resolution.snapshot.id,
              origin: resolution.origin,
              stale: resolution.stale,
              ...(resolution.warning ? { warning: resolution.warning } : {}),
              source: resolution.snapshot.source,
            },
            events: sourceEvents,
          })
          const normalized = normalizeEvents({
            source: sourceEvents,
            callId,
            ...(rawRef ? { rawRef } : {}),
            snapshot: resolution.snapshot,
            resolution,
            price: model.price,
            access,
            usageMetrics: model.capabilities.usage,
            secrets,
            now: this.options.now,
          })
          const finalUsage = applyPriceSnapshot(
            providerUsage(consumed.usage, "final", rawRef),
            model.price,
            access,
            model.capabilities.usage,
          ).usage
          return {
            provider: request.provider,
            model: request.model,
            effectiveParameters: effective.parameters,
            text: normalized.text,
            finishReason: consumed.finishReason || normalized.finishReason,
            usage: finalUsage,
            events: normalized.events,
            ...(rawRef ? { rawRef } : {}),
            catalogSnapshotId: resolution.snapshot.id,
            catalogOrigin: resolution.origin,
            catalogStale: resolution.stale,
          }
        } catch (error) {
          const rawRef = await captureRaw({
            schemaVersion: 1,
            callId,
            provider: request.provider,
            model: request.model,
            ...(request.variant ? { variant: request.variant } : {}),
            effectiveParameters: effective.parameters,
            catalog: {
              snapshotId: resolution.snapshot.id,
              origin: resolution.origin,
              stale: resolution.stale,
              ...(resolution.warning ? { warning: resolution.warning } : {}),
              source: resolution.snapshot.source,
            },
            events: sourceEvents,
            error: safeErrorRecord(error, secrets),
          })
          const kind = error instanceof OpenAiDriverError ? error.kind : "provider"
          const message =
            error instanceof OpenAiDriverError
              ? error.message
              : "The embedded model smoke call failed"
          const failureSource = sourceEventsWithFailure(sourceEvents, error)
          const normalizedFailure = normalizeEvents({
            source: failureSource.source,
            ...(failureSource.syntheticErrorSequence === undefined
              ? {}
              : { syntheticSourceSequences: new Set([failureSource.syntheticErrorSequence]) }),
            callId,
            ...(rawRef ? { rawRef } : {}),
            snapshot: resolution.snapshot,
            resolution,
            price: model.price,
            access,
            usageMetrics: model.capabilities.usage,
            secrets,
            now: this.options.now,
          })
          capturedFailure = new ModelSmokeFailure(
            kind,
            new SecretRedactor().redactText(message, secrets),
            rawRef,
            error instanceof OpenAiDriverError ? error.retryAfterMs : undefined,
            normalizedFailure.events,
          )
          throw capturedFailure
        }
      })
    } catch (error) {
      if (capturedFailure) throw capturedFailure
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(new SecretRedactor().redactText(message))
    }
  }
}

export type S04ServicesOptions = {
  environment?: Record<string, string | undefined>
  dataRoot?: string
  catalogFactory?: () => ModelCatalog | Promise<ModelCatalog>
  catalogFetch?: FetchLike
  modelFetch?: FetchLike
  keychainStore?: SecretStore
  accountFlow?: ChatGptAccountFlow
  readSecretStdin?: () => Promise<ReturnType<typeof secretInputFromValue>>
  readMaskedSecret?: (label: string) => Promise<ReturnType<typeof secretInputFromValue>>
  onAuthorization?: (notice: AuthorizationNotice) => void | Promise<void>
  now?: () => number
  credentialId?: () => string
  callId?: () => string
  profileForm?: TerminalProfileFormOptions
}

export type S04Services = {
  resolveModelCatalog: () => Promise<ModelCatalog>
  credentials: S04CredentialService
  modelSmoke: S04ModelSmokeService
  profileForm: ReturnType<typeof createTerminalProfileForm>
  paths: {
    dataRoot: string
    credentialMetadata: string
    catalogCache: string
    rawSmoke: string
  }
}

/**
 * Concrete S04 composition. Construction is side-effect free: catalog, disk,
 * keychain and network are touched only by the corresponding command.
 */
export function createS04Services(options: S04ServicesOptions = {}): S04Services {
  const environment = options.environment ?? process.env
  const dataRoot = options.dataRoot ?? dirname(globalConfigPath(environment))
  const paths = {
    dataRoot,
    credentialMetadata: join(dataRoot, "credentials", "metadata.json"),
    catalogCache: join(dataRoot, "cache", "model-catalog.json"),
    rawSmoke: join(dataRoot, "raw", "model-smoke"),
  }
  const now = options.now ?? Date.now
  let catalogPromise: Promise<ModelCatalog> | undefined
  const resolveModelCatalog = async (): Promise<ModelCatalog> => {
    if (catalogPromise) return catalogPromise
    const pending = Promise.resolve().then(() =>
      options.catalogFactory
        ? options.catalogFactory()
        : createModelCatalogRuntime({
            cachePath: paths.catalogCache,
            ...(options.catalogFetch ? { fetch: options.catalogFetch } : {}),
            clock: () => new Date(now()),
          }),
    )
    catalogPromise = pending
    try {
      return await pending
    } catch (error) {
      if (catalogPromise === pending) catalogPromise = undefined
      throw error
    }
  }

  const keychainStore = options.keychainStore ?? new OsKeychainSecretStore()
  const modelFetch = options.modelFetch ?? fetch
  const accountFlow =
    options.accountFlow ??
    new OpenAiChatGptAccountFlow({
      fetch: modelFetch,
      now,
      ...(options.onAuthorization ? { onAuthorization: options.onAuthorization } : {}),
    })
  const credentials = new S04CredentialService({
    catalog: resolveModelCatalog,
    registry: new CredentialMetadataRegistry(paths.credentialMetadata),
    environment,
    keychainStore,
    accountFlow,
    readSecretStdin: options.readSecretStdin ?? defaultSecretStdin,
    readMaskedSecret: options.readMaskedSecret ?? readMaskedSecret,
    now,
    credentialId: options.credentialId ?? (() => `cred-${crypto.randomUUID()}`),
  })
  const modelSmoke = new S04ModelSmokeService({
    credentials,
    fetch: modelFetch,
    rawDirectory: paths.rawSmoke,
    now,
    callId: options.callId ?? (() => crypto.randomUUID()),
  })
  return {
    resolveModelCatalog,
    credentials,
    modelSmoke,
    profileForm: createTerminalProfileForm(options.profileForm),
    paths,
  }
}

/** Test/release harness guard: real paid/network smoke is never implicit. */
export function isRealS04SmokeOptedIn(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.RALPH_S04_REAL_PROVIDER_SMOKE === "1"
}
