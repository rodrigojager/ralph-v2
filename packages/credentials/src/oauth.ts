import { timingSafeEqual } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { SecretInput } from "./contracts"
import { SecretRedactor } from "./redaction"
import { secretInputFromValue } from "./secret-input"

const DEFAULT_BROWSER_TIMEOUT_MS = 180_000
const DEFAULT_DEVICE_INTERVAL_SECONDS = 5
const MAX_TIMER_MS = 2_147_483_647
const MAX_RESPONSE_BYTES = 1_048_576
const LOOPBACK_HOST = "127.0.0.1"

export interface OAuthClock {
  now(): number
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>
}

export type OAuthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type BrowserOpener = (url: string) => Promise<boolean>

export type OAuthRandomBytes = (size: number) => Uint8Array

export type LoopbackCallbackResult =
  | { kind: "code"; code: string }
  | { kind: "error"; error: string; description?: string }

export interface LoopbackCallbackServer {
  readonly redirectUri: string
  wait(signal: AbortSignal): Promise<LoopbackCallbackResult>
  close(): Promise<void>
}

export type LoopbackCallbackFactory = (options: {
  host: typeof LOOPBACK_HOST
  port: number
  path: string
  expectedState: string
}) => Promise<LoopbackCallbackServer>

export type OAuthRuntime = {
  fetch?: OAuthFetch
  clock?: OAuthClock
  openBrowser?: BrowserOpener
  randomBytes?: OAuthRandomBytes
  createLoopbackCallback?: LoopbackCallbackFactory
}

export type BrowserOAuthConfig = {
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: SecretInput
  scopes: readonly string[]
  callbackPath?: string
  callbackPort?: number
  timeoutMs?: number
  headless?: boolean
  additionalAuthorizationParameters?: Readonly<Record<string, string>>
  additionalTokenParameters?: Readonly<Record<string, string>>
}

export type DeviceOAuthConfig = {
  deviceAuthorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: SecretInput
  scopes: readonly string[]
  timeoutMs?: number
  headless?: boolean
  additionalAuthorizationParameters?: Readonly<Record<string, string>>
  additionalTokenParameters?: Readonly<Record<string, string>>
}

export type RefreshOAuthConfig = {
  tokenEndpoint: string
  clientId: string
  clientSecret?: SecretInput
  scopes?: readonly string[]
  additionalTokenParameters?: Readonly<Record<string, string>>
}

export type RevokeOAuthConfig = {
  revocationEndpoint: string
  clientId: string
  clientSecret?: SecretInput
  tokenTypeHint?: "access_token" | "refresh_token"
  additionalParameters?: Readonly<Record<string, string>>
}

export type OAuthTokenSet = {
  idToken?: SecretInput
  accessToken: SecretInput
  refreshToken?: SecretInput
  tokenType?: string
  expiresAt?: string
  scope?: readonly string[]
}

export type BrowserOAuthSession = {
  readonly authorizationUrl: string
  readonly redirectUri: string
  readonly mode: "browser" | "headless"
  readonly browserOpened: boolean
  readonly instructions: string
  complete(options?: { signal?: AbortSignal }): Promise<OAuthTokenSet>
  cancel(): Promise<void>
}

export type DeviceOAuthSession = {
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete?: string
  readonly mode: "browser" | "headless"
  readonly browserOpened: boolean
  readonly instructions: string
  readonly expiresAt: string
  complete(options?: { signal?: AbortSignal }): Promise<OAuthTokenSet>
  cancel(): void
}

export class OAuthFlowError extends Error {
  readonly code: string
  readonly actionableHint: string
  readonly retryable: boolean
  readonly status?: number

  constructor(options: {
    code: string
    message: string
    actionableHint: string
    retryable?: boolean
    status?: number
  }) {
    super(options.message)
    this.name = "OAuthFlowError"
    this.code = options.code
    this.actionableHint = options.actionableHint
    this.retryable = options.retryable ?? false
    if (options.status !== undefined) this.status = options.status
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      actionableHint: this.actionableHint,
      retryable: this.retryable,
      ...(this.status !== undefined ? { status: this.status } : {}),
    }
  }
}

export const systemOAuthClock: OAuthClock = {
  now: () => Date.now(),
  sleep(milliseconds, signal) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_TIMER_MS) {
      return Promise.reject(new Error("Sleep duration must fit a supported non-negative timer"))
    }
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, milliseconds)
      const onAbort = () => {
        clearTimeout(timeout)
        reject(abortError())
      }
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  },
}

export const systemBrowserOpener: BrowserOpener = async (url) => {
  assertBrowserUrl(url)
  const command =
    process.platform === "win32"
      ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
      : process.platform === "darwin"
        ? ["/usr/bin/open", url]
        : ["xdg-open", url]
  try {
    const child = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
    return (await child.exited) === 0
  } catch {
    return false
  }
}

export const nodeLoopbackCallbackFactory: LoopbackCallbackFactory = async (options) => {
  if (options.host !== LOOPBACK_HOST) throw new Error("OAuth callback must bind to 127.0.0.1")
  validateLoopbackPath(options.path)
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("OAuth callback port must be between 0 and 65535")
  }

  let settle: ((result: LoopbackCallbackResult) => void) | undefined
  const callback = new Promise<LoopbackCallbackResult>((resolve) => {
    settle = resolve
  })
  let settled = false
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`)
    if (request.method !== "GET" || url.pathname !== options.path) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      response.end("Not found")
      return
    }
    const state = url.searchParams.get("state")
    if (!state || !constantTimeEqual(state, options.expectedState)) {
      response.writeHead(400, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      })
      response.end("OAuth state validation failed. Return to the CLI and retry.")
      return
    }
    const error = url.searchParams.get("error")
    const code = url.searchParams.get("code")
    if (!error && !code) {
      response.writeHead(400, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      })
      response.end("OAuth callback is missing a code or error.")
      return
    }
    response.writeHead(error ? 400 : 200, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    })
    response.end(
      error
        ? "Authorization was not completed. Return to the CLI for details."
        : "Authorization completed. You can close this window.",
    )
    if (settled) return
    settled = true
    if (error) {
      const description = url.searchParams.get("error_description")
      settle?.({
        kind: "error",
        error,
        ...(description ? { description } : {}),
      })
    } else if (code) settle?.({ kind: "code", code })
  })
  await listenLoopback(server, options.port)
  server.unref()
  const address = server.address()
  if (!address || typeof address === "string") {
    await closeServer(server)
    throw new Error("OAuth loopback callback did not receive a TCP address")
  }

  let closed = false
  return {
    redirectUri: `http://${LOOPBACK_HOST}:${address.port}${options.path}`,
    wait(signal) {
      return abortable(callback, signal)
    },
    async close() {
      if (closed) return
      closed = true
      await closeServer(server)
    },
  }
}

export async function startBrowserOAuth(
  config: BrowserOAuthConfig,
  runtime: OAuthRuntime = {},
): Promise<BrowserOAuthSession> {
  validateBrowserConfig(config)
  const randomBytes = runtime.randomBytes ?? defaultRandomBytes
  const state = base64Url(randomBytes(32))
  const verifier = base64Url(randomBytes(48))
  if (state.length < 32 || verifier.length < 43 || verifier.length > 128) {
    throw new Error("OAuth random source returned insufficient entropy")
  }
  const challenge = base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  )
  const callback = await (runtime.createLoopbackCallback ?? nodeLoopbackCallbackFactory)({
    host: LOOPBACK_HOST,
    port: config.callbackPort ?? 0,
    path: config.callbackPath ?? "/oauth/callback",
    expectedState: state,
  })
  const authorizationUrl = buildAuthorizationUrl(config, callback.redirectUri, state, challenge)
  const openBrowser = runtime.openBrowser ?? systemBrowserOpener
  const browserOpened = config.headless
    ? false
    : await tryOpenBrowser(openBrowser, authorizationUrl)
  const mode = browserOpened ? "browser" : "headless"
  const instructions = browserOpened
    ? "Complete authorization in the opened browser, then return to the CLI."
    : `Open this URL in a browser and complete authorization: ${authorizationUrl}`
  const sessionAbort = new AbortController()
  let completionStarted = false

  return {
    authorizationUrl,
    redirectUri: callback.redirectUri,
    mode,
    browserOpened,
    instructions,
    async complete(options = {}) {
      if (completionStarted) {
        throw new OAuthFlowError({
          code: "session_already_completed",
          message: "This OAuth browser session can only be completed once",
          actionableHint: "Start a new OAuth browser session.",
        })
      }
      completionStarted = true
      const timeoutMs = config.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS
      try {
        return await runWithDeadline(
          timeoutMs,
          runtime.clock ?? systemOAuthClock,
          [sessionAbort.signal, options.signal],
          async (signal) => {
            const result = await callback.wait(signal)
            if (result.kind === "error") {
              const redactor = new SecretRedactor()
              const description = result.description
                ? `: ${redactor.redactText(result.description, [verifier]).slice(0, 256)}`
                : ""
              throw new OAuthFlowError({
                code: redactor
                  .redactText(result.error, [verifier])
                  .replace(/\s+/g, "_")
                  .slice(0, 128),
                message: `OAuth authorization was rejected${description}`,
                actionableHint: "Review the provider authorization screen and start a new session.",
              })
            }
            const clientSecret = await readOptionalSecret(
              config.clientSecret,
              "OAuth client secret",
            )
            const parameters = mergeParameters(config.additionalTokenParameters, {
              grant_type: "authorization_code",
              client_id: config.clientId,
              code: result.code,
              redirect_uri: callback.redirectUri,
              code_verifier: verifier,
              ...(clientSecret ? { client_secret: clientSecret } : {}),
            })
            return requestToken(config.tokenEndpoint, parameters, runtime, signal, [
              result.code,
              verifier,
              ...(clientSecret ? [clientSecret] : []),
            ])
          },
        )
      } finally {
        await callback.close()
      }
    },
    async cancel() {
      sessionAbort.abort()
      await callback.close()
    },
  }
}

export async function startDeviceOAuth(
  config: DeviceOAuthConfig,
  runtime: OAuthRuntime = {},
  options: { signal?: AbortSignal } = {},
): Promise<DeviceOAuthSession> {
  validateDeviceConfig(config)
  if (options.signal?.aborted) throw cancelledError()
  const parameters = mergeParameters(config.additionalAuthorizationParameters, {
    client_id: config.clientId,
    scope: config.scopes.join(" "),
  })
  let response: Response
  try {
    response = await postForm(
      config.deviceAuthorizationEndpoint,
      parameters,
      runtime.fetch ?? fetch,
      options.signal,
    )
  } catch (error) {
    if (isAbortError(error)) throw cancelledError()
    throw error
  }
  const payload = await readJsonObject(response, options.signal)
  if (!response.ok) throw providerResponseError(response, payload, [])
  const deviceCode = requiredString(payload, "device_code")
  const userCode = requiredString(payload, "user_code")
  const verificationUri = requiredString(payload, "verification_uri")
  const verificationUriComplete = optionalString(payload, "verification_uri_complete")
  assertBrowserUrl(verificationUri)
  if (verificationUriComplete) assertBrowserUrl(verificationUriComplete)
  const expiresIn = positiveNumber(payload.expires_in, "expires_in")
  const intervalSeconds =
    optionalPositiveNumber(payload.interval) ?? DEFAULT_DEVICE_INTERVAL_SECONDS
  const clock = runtime.clock ?? systemOAuthClock
  const startedAt = clock.now()
  const providerTimeoutMs = timerMilliseconds(expiresIn, "expires_in")
  const timeoutMs = Math.min(config.timeoutMs ?? providerTimeoutMs, providerTimeoutMs)
  const openBrowser = runtime.openBrowser ?? systemBrowserOpener
  const browserUrl = verificationUriComplete ?? verificationUri
  const browserOpened = config.headless ? false : await tryOpenBrowser(openBrowser, browserUrl)
  const mode = browserOpened ? "browser" : "headless"
  const instructions = verificationUriComplete
    ? browserOpened
      ? `Complete device authorization in the opened browser. Code: ${userCode}`
      : `Open ${verificationUriComplete} in a browser. Device code: ${userCode}`
    : browserOpened
      ? `Enter device code ${userCode} in the opened browser.`
      : `Open ${verificationUri} in a browser and enter device code ${userCode}.`
  const sessionAbort = new AbortController()
  let completionStarted = false

  return {
    userCode,
    verificationUri,
    ...(verificationUriComplete ? { verificationUriComplete } : {}),
    mode,
    browserOpened,
    instructions,
    expiresAt: expirationIso(startedAt, expiresIn),
    async complete(completeOptions = {}) {
      if (completionStarted) {
        throw new OAuthFlowError({
          code: "session_already_completed",
          message: "This OAuth device session can only be completed once",
          actionableHint: "Start a new OAuth device session.",
        })
      }
      completionStarted = true
      const clientSecret = await readOptionalSecret(config.clientSecret, "OAuth client secret")
      return runWithDeadline(
        timeoutMs,
        clock,
        [sessionAbort.signal, completeOptions.signal],
        async (signal) => {
          let intervalMs = intervalSeconds * 1_000
          while (true) {
            const tokenParameters = mergeParameters(config.additionalTokenParameters, {
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              device_code: deviceCode,
              client_id: config.clientId,
              ...(clientSecret ? { client_secret: clientSecret } : {}),
            })
            const response = await postForm(
              config.tokenEndpoint,
              tokenParameters,
              runtime.fetch ?? fetch,
              signal,
            )
            const payload = await readJsonObject(response, signal)
            if (response.ok) {
              return tokenSetFromPayload(payload, clock.now())
            }
            const code = optionalString(payload, "error") ?? `http_${response.status}`
            if (code === "authorization_pending") {
              await clock.sleep(intervalMs, signal)
              continue
            }
            if (code === "slow_down") {
              intervalMs += 5_000
              await clock.sleep(intervalMs, signal)
              continue
            }
            if (code === "access_denied") {
              throw new OAuthFlowError({
                code,
                message: "OAuth device authorization was denied",
                actionableHint: "Start a new device flow and approve access in the browser.",
                status: response.status,
              })
            }
            if (code === "expired_token") {
              throw timeoutError("The OAuth device code expired")
            }
            throw providerResponseError(response, payload, [
              deviceCode,
              ...(clientSecret ? [clientSecret] : []),
            ])
          }
        },
      )
    },
    cancel() {
      sessionAbort.abort()
    },
  }
}

export async function refreshOAuthToken(
  config: RefreshOAuthConfig,
  refreshToken: SecretInput,
  runtime: OAuthRuntime = {},
  options: { signal?: AbortSignal } = {},
): Promise<OAuthTokenSet> {
  assertEndpoint(config.tokenEndpoint, "tokenEndpoint")
  validateClientId(config.clientId)
  const refreshValue = await refreshToken.readOnce()
  const clientSecret = await readOptionalSecret(config.clientSecret, "OAuth client secret")
  const parameters = mergeParameters(config.additionalTokenParameters, {
    grant_type: "refresh_token",
    refresh_token: refreshValue,
    client_id: config.clientId,
    ...(config.scopes?.length ? { scope: config.scopes.join(" ") } : {}),
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  })
  const response = await postForm(
    config.tokenEndpoint,
    parameters,
    runtime.fetch ?? fetch,
    options.signal,
  )
  const payload = await readJsonObject(response, options.signal)
  if (!response.ok) {
    throw providerResponseError(response, payload, [
      refreshValue,
      ...(clientSecret ? [clientSecret] : []),
    ])
  }
  return tokenSetFromPayload(payload, (runtime.clock ?? systemOAuthClock).now(), refreshValue)
}

export async function revokeOAuthToken(
  config: RevokeOAuthConfig,
  token: SecretInput,
  runtime: OAuthRuntime = {},
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  assertEndpoint(config.revocationEndpoint, "revocationEndpoint")
  validateClientId(config.clientId)
  const tokenValue = await token.readOnce()
  const clientSecret = await readOptionalSecret(config.clientSecret, "OAuth client secret")
  const parameters = mergeParameters(config.additionalParameters, {
    token: tokenValue,
    client_id: config.clientId,
    ...(config.tokenTypeHint ? { token_type_hint: config.tokenTypeHint } : {}),
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  })
  const response = await postForm(
    config.revocationEndpoint,
    parameters,
    runtime.fetch ?? fetch,
    options.signal,
  )
  if (!response.ok) {
    const payload = await readJsonObject(response, options.signal)
    throw providerResponseError(response, payload, [
      tokenValue,
      ...(clientSecret ? [clientSecret] : []),
    ])
  }
}

async function requestToken(
  endpoint: string,
  parameters: URLSearchParams,
  runtime: OAuthRuntime,
  signal: AbortSignal | undefined,
  secrets: readonly string[],
): Promise<OAuthTokenSet> {
  const response = await postForm(endpoint, parameters, runtime.fetch ?? fetch, signal)
  const payload = await readJsonObject(response, signal)
  if (!response.ok) throw providerResponseError(response, payload, secrets)
  return tokenSetFromPayload(payload, (runtime.clock ?? systemOAuthClock).now())
}

async function postForm(
  endpoint: string,
  parameters: URLSearchParams,
  fetcher: OAuthFetch,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    const request = fetcher(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: parameters,
      // Never replay an authorization code, PKCE verifier, refresh token or
      // revocation token to a redirect target chosen by the response.
      redirect: "error",
      ...(signal ? { signal } : {}),
    })
    return signal ? await abortable(request, signal) : await request
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw cancelledError()
    throw new OAuthFlowError({
      code: "network_error",
      message: "OAuth provider request failed",
      actionableHint: "Check network access and the configured OAuth endpoint, then retry.",
      retryable: true,
    })
  }
}

async function readJsonObject(
  response: Response,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await readBoundedOAuthText(response, signal)
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw cancelledError()
    throw error
  }
  if (text.trim() === "") return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object")
    return parsed as Record<string, unknown>
  } catch {
    throw new OAuthFlowError({
      code: "invalid_response",
      message: "OAuth provider returned an invalid JSON response",
      actionableHint: "Check the configured endpoint and provider compatibility.",
      status: response.status,
    })
  }
}

async function readBoundedOAuthText(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let completed = false
  try {
    while (true) {
      const request = reader.read()
      const result = signal ? await abortable(request, signal) : await request
      if (result.done) {
        completed = true
        break
      }
      totalBytes += result.value.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        throw new OAuthFlowError({
          code: "invalid_response",
          message: "OAuth provider response exceeded the safe size limit",
          actionableHint: "Check the configured endpoint and provider status.",
        })
      }
      chunks.push(result.value)
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined)
    if (completed) reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new OAuthFlowError({
      code: "invalid_response",
      message: "OAuth provider returned a response that is not valid UTF-8",
      actionableHint: "Check the configured endpoint and provider compatibility.",
      status: response.status,
    })
  }
}

function tokenSetFromPayload(
  payload: Record<string, unknown>,
  now: number,
  fallbackRefreshToken?: string,
): OAuthTokenSet {
  const idToken = optionalString(payload, "id_token")
  const accessToken = requiredString(payload, "access_token")
  const refreshToken = optionalString(payload, "refresh_token") ?? fallbackRefreshToken
  const tokenType = optionalString(payload, "token_type")
  const expiresIn = optionalPositiveNumber(payload.expires_in)
  const scopeValue = optionalString(payload, "scope")
  return {
    ...(idToken ? { idToken: secretInputFromValue(idToken) } : {}),
    accessToken: secretInputFromValue(accessToken),
    ...(refreshToken ? { refreshToken: secretInputFromValue(refreshToken) } : {}),
    ...(tokenType ? { tokenType } : {}),
    ...(expiresIn ? { expiresAt: expirationIso(now, expiresIn) } : {}),
    ...(scopeValue ? { scope: scopeValue.split(/\s+/).filter(Boolean) } : {}),
  }
}

function providerResponseError(
  response: Response,
  payload: Record<string, unknown>,
  secrets: readonly string[],
): OAuthFlowError {
  const redactor = new SecretRedactor()
  const rawCode = optionalString(payload, "error") ?? `http_${response.status}`
  const code = redactor.redactText(rawCode, secrets).replace(/\s+/g, "_").slice(0, 128)
  const rawDescription = optionalString(payload, "error_description")
  const description = rawDescription
    ? `: ${redactor.redactText(rawDescription, secrets).replace(/\s+/g, " ").slice(0, 256)}`
    : ""
  return new OAuthFlowError({
    code,
    message: `OAuth provider rejected the request${description}`,
    actionableHint:
      "Review the credential, provider permissions and OAuth configuration, then retry.",
    retryable: response.status >= 500 || response.status === 429,
    status: response.status,
  })
}

function buildAuthorizationUrl(
  config: BrowserOAuthConfig,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const url = new URL(config.authorizationEndpoint)
  const parameters = mergeParameters(config.additionalAuthorizationParameters, {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  url.search = parameters.toString()
  return url.toString()
}

function mergeParameters(
  additional: Readonly<Record<string, string>> | undefined,
  required: Readonly<Record<string, string>>,
): URLSearchParams {
  const parameters = new URLSearchParams()
  for (const [key, value] of Object.entries(additional ?? {})) {
    if (!key || [...key].some((character) => character.charCodeAt(0) <= 31)) {
      throw new Error("Invalid OAuth parameter name")
    }
    parameters.set(key, value)
  }
  for (const [key, value] of Object.entries(required)) parameters.set(key, value)
  return parameters
}

function validateBrowserConfig(config: BrowserOAuthConfig): void {
  assertEndpoint(config.authorizationEndpoint, "authorizationEndpoint")
  assertEndpoint(config.tokenEndpoint, "tokenEndpoint")
  validateClientId(config.clientId)
  validateScopes(config.scopes)
  validateLoopbackPath(config.callbackPath ?? "/oauth/callback")
  if (
    config.callbackPort !== undefined &&
    (!Number.isSafeInteger(config.callbackPort) ||
      config.callbackPort < 0 ||
      config.callbackPort > 65_535)
  ) {
    throw new Error("OAuth callbackPort must be between 0 and 65535")
  }
  validateTimeout(config.timeoutMs)
}

function validateDeviceConfig(config: DeviceOAuthConfig): void {
  assertEndpoint(config.deviceAuthorizationEndpoint, "deviceAuthorizationEndpoint")
  assertEndpoint(config.tokenEndpoint, "tokenEndpoint")
  validateClientId(config.clientId)
  validateScopes(config.scopes)
  validateTimeout(config.timeoutMs)
}

function validateClientId(clientId: string): void {
  if (!clientId.trim() || clientId.length > 512) throw new Error("OAuth clientId is invalid")
}

function validateScopes(scopes: readonly string[]): void {
  if (scopes.length === 0 || scopes.some((scope) => !scope.trim() || /\s/.test(scope))) {
    throw new Error("OAuth scopes must contain at least one non-whitespace scope")
  }
}

function validateTimeout(timeoutMs: number | undefined): void {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS)
  ) {
    throw new Error(`OAuth timeoutMs must be between 1 and ${MAX_TIMER_MS}`)
  }
}

function validateLoopbackPath(path: string): void {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.includes("\\")) {
    throw new Error("OAuth callbackPath must be an absolute URL path")
  }
}

function assertEndpoint(value: string, field: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`OAuth ${field} must be an absolute URL`)
  }
  if (url.protocol === "https:") return
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return
  throw new Error(`OAuth ${field} must use HTTPS or a loopback HTTP address`)
}

function assertBrowserUrl(value: string): void {
  assertEndpoint(value, "browser URL")
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
}

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = optionalString(payload, field)
  if (!value) {
    throw new OAuthFlowError({
      code: "invalid_response",
      message: `OAuth provider response is missing ${field}`,
      actionableHint: "Check provider compatibility and the configured OAuth endpoints.",
    })
  }
  return value
}

function optionalString(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function positiveNumber(value: unknown, field: string): number {
  const parsed = optionalPositiveNumber(value)
  if (!parsed) {
    throw new OAuthFlowError({
      code: "invalid_response",
      message: `OAuth provider response has invalid ${field}`,
      actionableHint: "Check provider compatibility and the configured OAuth endpoints.",
    })
  }
  return parsed
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function timerMilliseconds(seconds: number, field: string): number {
  const milliseconds = seconds * 1_000
  if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_TIMER_MS) {
    throw new OAuthFlowError({
      code: "invalid_response",
      message: `OAuth provider response has unsupported ${field}`,
      actionableHint: "Check provider compatibility and the configured OAuth endpoints.",
    })
  }
  return milliseconds
}

function expirationIso(now: number, expiresInSeconds: number): string {
  const expiresAt = now + expiresInSeconds * 1_000
  if (!Number.isFinite(expiresAt) || expiresAt > 8_640_000_000_000_000) {
    throw new OAuthFlowError({
      code: "invalid_response",
      message: "OAuth provider response has an invalid expiration",
      actionableHint: "Check provider compatibility and the configured OAuth endpoints.",
    })
  }
  return new Date(expiresAt).toISOString()
}

async function readOptionalSecret(
  input: SecretInput | undefined,
  label: string,
): Promise<string | undefined> {
  if (!input) return undefined
  const value = await input.readOnce()
  if (value.length === 0) throw new Error(`${label} cannot be empty`)
  return value
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url")
}

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size))
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

async function tryOpenBrowser(opener: BrowserOpener, url: string): Promise<boolean> {
  try {
    return await opener(url)
  } catch {
    return false
  }
}

async function runWithDeadline<T>(
  timeoutMs: number,
  clock: OAuthClock,
  sources: readonly (AbortSignal | undefined)[],
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const operationAbort = new AbortController()
  const timerAbort = new AbortController()
  let reason: "cancelled" | "timeout" | undefined
  let rejectTermination: ((error: DOMException) => void) | undefined
  const termination = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject
  })
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = []
  for (const source of sources) {
    if (!source) continue
    const listener = () => {
      if (!reason) reason = "cancelled"
      operationAbort.abort()
      rejectTermination?.(abortError())
    }
    if (source.aborted) listener()
    else {
      source.addEventListener("abort", listener, { once: true })
      listeners.push({ signal: source, listener })
    }
  }
  const timer = clock
    .sleep(timeoutMs, timerAbort.signal)
    .then(() => {
      if (!operationAbort.signal.aborted) {
        reason = "timeout"
        operationAbort.abort()
        rejectTermination?.(abortError())
      }
    })
    .catch(() => undefined)
  try {
    const pending =
      reason === "cancelled" ? new Promise<never>(() => {}) : operation(operationAbort.signal)
    return await Promise.race([pending, termination])
  } catch (error) {
    if (reason === "timeout") throw timeoutError("OAuth flow timed out")
    if (reason === "cancelled" || isAbortError(error)) throw cancelledError()
    throw error
  } finally {
    timerAbort.abort()
    void timer.catch(() => undefined)
    for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener)
  }
}

function timeoutError(message: string): OAuthFlowError {
  return new OAuthFlowError({
    code: "timeout",
    message,
    actionableHint: "Start a new OAuth flow and complete it before the timeout.",
    retryable: true,
  })
}

function cancelledError(): OAuthFlowError {
  return new OAuthFlowError({
    code: "cancelled",
    message: "OAuth flow was cancelled",
    actionableHint: "Start a new OAuth flow when ready.",
    retryable: true,
  })
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError")
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

function listenLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", onError)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
