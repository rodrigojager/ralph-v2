export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const OPENAI_AUTH_ISSUER = "https://auth.openai.com"
export const CHATGPT_CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const CHATGPT_DEVICE_VERIFICATION_URL = `${OPENAI_AUTH_ISSUER}/codex/device`
export const CHATGPT_OAUTH_CALLBACK_PORT = 1455
export const CHATGPT_DEVICE_POLL_SAFETY_MARGIN_MS = 3_000
export const CHATGPT_OAUTH_ORIGINATOR = "opencode"
export const OPENAI_MAX_OAUTH_RESPONSE_BYTES = 1_048_576

export type OpenAiFailureKind =
  | "authentication"
  | "rate-limit"
  | "protocol-drift"
  | "eligibility"
  | "timeout"
  | "cancelled"
  | "transport"
  | "provider"
  | "invalid-input"

export class OpenAiDriverError extends Error {
  readonly failClosed = true

  constructor(
    readonly kind: OpenAiFailureKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "OpenAiDriverError"
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type PkceCodes = {
  verifier: string
  challenge: string
}

export type BrowserAuthorization = {
  url: string
  redirectUri: string
  state: string
  pkce: PkceCodes
}

export type OpenAiTokenResponse = {
  idToken: string
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
}

export type ChatGptCredential = {
  kind: "chatgpt-subscription"
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string
}

export type BrowserCallbackResult = {
  code: string
  state: string
}

export type ProtocolRuntime = {
  fetch: FetchLike
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
  sha256?: (value: Uint8Array) => Promise<Uint8Array>
}

export type ProtocolRequestOptions = {
  issuer?: string
  signal?: AbortSignal
  timeoutMs?: number
}

const PKCE_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,256}$/

function defaultRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size))
}

async function defaultSha256(value: Uint8Array): Promise<Uint8Array> {
  const buffer = new ArrayBuffer(value.byteLength)
  new Uint8Array(buffer).set(value)
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))
}

export function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url")
}

export async function generatePkce(
  runtime: Pick<ProtocolRuntime, "randomBytes" | "sha256"> = {},
): Promise<PkceCodes> {
  const randomBytes = runtime.randomBytes ?? defaultRandomBytes
  const sha256 = runtime.sha256 ?? defaultSha256
  const verifier = Array.from(
    randomBytes(43),
    (byte) => PKCE_CHARACTERS[byte % PKCE_CHARACTERS.length],
  ).join("")
  const challenge = base64UrlEncode(await sha256(new TextEncoder().encode(verifier)))
  return { verifier, challenge }
}

export function generateOAuthState(
  randomBytes: (size: number) => Uint8Array = defaultRandomBytes,
): string {
  return base64UrlEncode(randomBytes(32))
}

function assertLoopbackRedirect(redirectUri: string): URL {
  let redirect: URL
  try {
    redirect = new URL(redirectUri)
  } catch (cause) {
    throw new OpenAiDriverError(
      "invalid-input",
      "OAuth redirect URI is invalid",
      undefined,
      undefined,
      {
        cause,
      },
    )
  }
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"])
  if (redirect.protocol !== "http:" || !loopback.has(redirect.hostname)) {
    throw new OpenAiDriverError(
      "invalid-input",
      "OAuth redirect URI must use an HTTP loopback address",
    )
  }
  if (redirect.pathname !== "/auth/callback") {
    throw new OpenAiDriverError("invalid-input", "OAuth redirect path must be /auth/callback")
  }
  return redirect
}

function assertPkce(pkce: PkceCodes): void {
  if (pkce.verifier.length < 43 || pkce.verifier.length > 128) {
    throw new OpenAiDriverError("invalid-input", "PKCE verifier length is invalid")
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(pkce.verifier) || !/^[A-Za-z0-9_-]+$/.test(pkce.challenge)) {
    throw new OpenAiDriverError("invalid-input", "PKCE value contains invalid characters")
  }
}

export function buildBrowserAuthorization(input: {
  redirectUri: string
  state: string
  pkce: PkceCodes
  issuer?: string
}): BrowserAuthorization {
  const redirect = assertLoopbackRedirect(input.redirectUri)
  assertPkce(input.pkce)
  if (!input.state || input.state.length > 512) {
    throw new OpenAiDriverError("invalid-input", "OAuth state is invalid")
  }
  const issuer = normalizeIssuer(input.issuer)
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirect.toString(),
    scope: "openid profile email offline_access",
    code_challenge: input.pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: input.state,
    originator: CHATGPT_OAUTH_ORIGINATOR,
  })
  return {
    url: `${issuer}/oauth/authorize?${params.toString()}`,
    redirectUri: redirect.toString(),
    state: input.state,
    pkce: input.pkce,
  }
}

export async function prepareBrowserAuthorization(
  redirectUri = `http://localhost:${CHATGPT_OAUTH_CALLBACK_PORT}/auth/callback`,
  runtime: Pick<ProtocolRuntime, "randomBytes" | "sha256"> = {},
): Promise<BrowserAuthorization> {
  const pkce = await generatePkce(runtime)
  return buildBrowserAuthorization({
    redirectUri,
    state: generateOAuthState(runtime.randomBytes),
    pkce,
  })
}

export function validateBrowserCallback(
  callbackUrl: string,
  expectedState: string,
): BrowserCallbackResult {
  let callback: URL
  try {
    callback = new URL(callbackUrl)
  } catch (cause) {
    throw new OpenAiDriverError(
      "authentication",
      "OAuth callback URL is invalid",
      undefined,
      undefined,
      {
        cause,
      },
    )
  }
  const providerError =
    callback.searchParams.get("error_description") ?? callback.searchParams.get("error")
  if (providerError) {
    throw new OpenAiDriverError("authentication", "OAuth provider rejected authorization")
  }
  const state = callback.searchParams.get("state")
  if (!state || state !== expectedState) {
    throw new OpenAiDriverError("authentication", "OAuth callback state mismatch")
  }
  const code = callback.searchParams.get("code")
  if (!code)
    throw new OpenAiDriverError("protocol-drift", "OAuth callback omitted authorization code")
  return { code, state }
}

export async function exchangeAuthorizationCode(
  input: { code: string; redirectUri: string; pkce: PkceCodes; issuer?: string },
  runtime: Pick<ProtocolRuntime, "fetch">,
  options: Omit<ProtocolRequestOptions, "issuer"> = {},
): Promise<OpenAiTokenResponse> {
  const redirectKind = assertLoopbackOrDeviceRedirect(input.redirectUri, input.issuer)
  if (redirectKind === "browser") assertPkce(input.pkce)
  else assertPkceVerifier(input.pkce.verifier)
  if (!input.code) throw new OpenAiDriverError("invalid-input", "Authorization code is required")
  return requestTokens(
    input.issuer,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: input.pkce.verifier,
    }),
    runtime.fetch,
    options,
  )
}

export async function refreshAccessToken(
  refreshToken: string,
  runtime: Pick<ProtocolRuntime, "fetch">,
  options: ProtocolRequestOptions = {},
): Promise<OpenAiTokenResponse> {
  if (!refreshToken) throw new OpenAiDriverError("invalid-input", "Refresh credential is required")
  return requestTokens(
    options.issuer,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }),
    runtime.fetch,
    options,
  )
}

export function chatGptCredentialFromTokens(
  tokens: OpenAiTokenResponse,
  now = Date.now(),
  priorAccountId?: string,
): ChatGptCredential {
  const accountId =
    extractAccountId(tokens.idToken, tokens.accessToken) ?? sanitizeAccountId(priorAccountId)
  return {
    kind: "chatgpt-subscription",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + tokens.expiresInSeconds * 1_000,
    ...(accountId ? { accountId } : {}),
  }
}

export function extractAccountId(idToken?: string, accessToken?: string): string | undefined {
  return extractAccountIdFromJwt(idToken) ?? extractAccountIdFromJwt(accessToken)
}

export function rewriteChatGptCodexRequest(input: {
  request: RequestInfo | URL
  init?: RequestInit
  credential: Pick<ChatGptCredential, "accessToken" | "accountId">
  endpoint?: string
}): { url: URL; init: RequestInit } {
  const source = requestUrl(input.request)
  if (source.username || source.password) {
    throw new OpenAiDriverError("invalid-input", "Request URL must not contain credentials")
  }
  if (
    !source.pathname.includes("/v1/responses") &&
    !source.pathname.includes("/chat/completions")
  ) {
    throw new OpenAiDriverError(
      "protocol-drift",
      "ChatGPT subscription request did not target a supported OpenAI response path",
    )
  }
  if (!input.credential.accessToken) {
    throw new OpenAiDriverError("authentication", "ChatGPT access credential is unavailable")
  }
  const endpoint = validateCodexEndpoint(input.endpoint)
  const headers = new Headers(input.init?.headers)
  headers.delete("authorization")
  headers.set("authorization", `Bearer ${input.credential.accessToken}`)
  const accountId = sanitizeAccountId(input.credential.accountId)
  if (accountId) headers.set("ChatGPT-Account-Id", accountId)
  else headers.delete("ChatGPT-Account-Id")
  return {
    url: endpoint,
    init: {
      ...input.init,
      headers,
      redirect: "error",
    },
  }
}

export function classifyHttpFailure(
  status: number,
  headers: Headers,
  providerCode?: string,
): OpenAiDriverError {
  const code = providerCode?.toLowerCase()
  if (status === 401)
    return new OpenAiDriverError("authentication", "Provider rejected credentials", status)
  if (
    status === 403 ||
    code === "account_not_eligible" ||
    code === "unsupported_country" ||
    code === "model_not_found"
  ) {
    return new OpenAiDriverError("eligibility", "Account or model is not eligible", status)
  }
  if (status === 429) {
    return new OpenAiDriverError(
      "rate-limit",
      "Provider rate limit reached",
      status,
      retryAfterMilliseconds(headers.get("retry-after")),
    )
  }
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return new OpenAiDriverError("protocol-drift", "Pinned provider protocol was rejected", status)
  }
  if (status >= 500)
    return new OpenAiDriverError("provider", "Provider is temporarily unavailable", status)
  return new OpenAiDriverError("provider", "Provider request failed", status)
}

function normalizeIssuer(issuer = OPENAI_AUTH_ISSUER): string {
  const value = new URL(issuer)
  if (value.protocol !== "https:") {
    throw new OpenAiDriverError("invalid-input", "OAuth issuer must use HTTPS")
  }
  return value.toString().replace(/\/$/, "")
}

function assertLoopbackOrDeviceRedirect(
  redirectUri: string,
  issuer?: string,
): "browser" | "device" {
  const expectedDevice = `${normalizeIssuer(issuer)}/deviceauth/callback`
  if (redirectUri === expectedDevice) return "device"
  assertLoopbackRedirect(redirectUri)
  return "browser"
}

function assertPkceVerifier(verifier: string): void {
  if (verifier.length < 43 || verifier.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(verifier)) {
    throw new OpenAiDriverError("protocol-drift", "Device PKCE verifier is invalid")
  }
}

async function requestTokens(
  issuer: string | undefined,
  body: URLSearchParams,
  fetcher: FetchLike,
  options: Omit<ProtocolRequestOptions, "issuer">,
): Promise<OpenAiTokenResponse> {
  const { response, value } = await boundedJsonFetch(
    fetcher,
    `${normalizeIssuer(issuer)}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "error",
    },
    options,
    "OAuth token",
  )
  if (!response.ok) throw classifyHttpFailure(response.status, response.headers)
  return parseTokenResponse(value)
}

export async function boundedJsonFetch(
  fetcher: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
  options: Omit<ProtocolRequestOptions, "issuer">,
  operation: "OAuth token" | "Device authorization",
): Promise<{ response: Response; value: unknown }> {
  return runBoundedProtocolOperation(
    fetcher,
    input,
    init,
    options,
    operation,
    async (response, signal) => ({
      response,
      value: await safeJson(response, signal, operation),
    }),
  )
}

export async function boundedFetch(
  fetcher: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
  options: Omit<ProtocolRequestOptions, "issuer">,
  operation: "OAuth token" | "Device authorization",
): Promise<Response> {
  return runBoundedProtocolOperation(
    fetcher,
    input,
    init,
    options,
    operation,
    async (response) => response,
  )
}

async function runBoundedProtocolOperation<T>(
  fetcher: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
  options: Omit<ProtocolRequestOptions, "issuer">,
  operation: "OAuth token" | "Device authorization",
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60 * 1_000) {
    throw new OpenAiDriverError("invalid-input", `${operation} timeout is invalid`)
  }
  if (options.signal?.aborted) {
    throw new OpenAiDriverError("cancelled", `${operation} request was cancelled`)
  }
  const controller = new AbortController()
  let termination: "timeout" | "cancelled" | undefined
  let rejectTermination: ((error: OpenAiDriverError) => void) | undefined
  const terminationPromise = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject
  })
  const cancel = () => {
    if (termination) return
    termination = "cancelled"
    controller.abort(options.signal?.reason)
    rejectTermination?.(new OpenAiDriverError("cancelled", `${operation} request was cancelled`))
  }
  options.signal?.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(() => {
    if (termination) return
    termination = "timeout"
    controller.abort("timeout")
    rejectTermination?.(new OpenAiDriverError("timeout", `${operation} request timed out`))
  }, timeoutMs)
  try {
    try {
      const operationPromise = fetcher(input, { ...init, signal: controller.signal }).then(
        (response) => consume(response, controller.signal),
      )
      return await Promise.race([operationPromise, terminationPromise])
    } catch (cause) {
      if (termination === "cancelled") {
        throw new OpenAiDriverError("cancelled", `${operation} request was cancelled`)
      }
      if (termination === "timeout") {
        throw new OpenAiDriverError("timeout", `${operation} request timed out`)
      }
      if (cause instanceof OpenAiDriverError) throw cause
      throw new OpenAiDriverError(
        "transport",
        `${operation} request failed`,
        undefined,
        undefined,
        { cause },
      )
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", cancel)
  }
}

function parseTokenResponse(value: unknown): OpenAiTokenResponse {
  if (!isRecord(value))
    throw new OpenAiDriverError("protocol-drift", "OAuth token response is not an object")
  const idToken = nonEmptyString(value.id_token)
  const accessToken = nonEmptyString(value.access_token)
  const refreshToken = nonEmptyString(value.refresh_token)
  const expires = value.expires_in === undefined ? 3_600 : value.expires_in
  if (
    !idToken ||
    !accessToken ||
    !refreshToken ||
    typeof expires !== "number" ||
    !Number.isFinite(expires) ||
    expires <= 0
  ) {
    throw new OpenAiDriverError("protocol-drift", "OAuth token response has an incompatible schema")
  }
  return { idToken, accessToken, refreshToken, expiresInSeconds: expires }
}

function extractAccountIdFromJwt(token?: string): string | undefined {
  if (!token || token.length > 64_000) return undefined
  const parts = token.split(".")
  if (parts.length !== 3 || !parts[1]) return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    if (!isRecord(value)) return undefined
    const direct = sanitizeAccountId(value.chatgpt_account_id)
    if (direct) return direct
    const auth = value["https://api.openai.com/auth"]
    if (isRecord(auth)) {
      const nested = sanitizeAccountId(auth.chatgpt_account_id)
      if (nested) return nested
    }
    const organizations = value.organizations
    if (Array.isArray(organizations) && isRecord(organizations[0])) {
      return sanitizeAccountId(organizations[0].id)
    }
  } catch {
    return undefined
  }
  return undefined
}

function sanitizeAccountId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ACCOUNT_ID.test(value) ? value : undefined
}

function requestUrl(input: RequestInfo | URL): URL {
  try {
    if (input instanceof URL) return new URL(input)
    if (typeof input === "string") return new URL(input)
    return new URL(input.url)
  } catch (cause) {
    throw new OpenAiDriverError(
      "invalid-input",
      "Provider request URL is invalid",
      undefined,
      undefined,
      {
        cause,
      },
    )
  }
}

function validateCodexEndpoint(endpoint = CHATGPT_CODEX_RESPONSES_ENDPOINT): URL {
  const value = new URL(endpoint)
  if (
    value.protocol !== "https:" ||
    value.origin !== "https://chatgpt.com" ||
    value.pathname !== "/backend-api/codex/responses" ||
    value.search ||
    value.hash
  ) {
    throw new OpenAiDriverError(
      "protocol-drift",
      "ChatGPT Codex endpoint does not match pinned protocol",
    )
  }
  return value
}

async function safeJson(
  response: Response,
  signal: AbortSignal,
  operation: string,
): Promise<unknown> {
  try {
    if (!response.body) return undefined
    return await readBoundedResponseJson(response, {
      maxBytes: OPENAI_MAX_OAUTH_RESPONSE_BYTES,
      signal,
      label: `${operation} response`,
    })
  } catch (cause) {
    if (cause instanceof ResponseBodyError && cause.reason === "aborted") throw cause
    throw new OpenAiDriverError(
      "protocol-drift",
      "Provider returned invalid JSON",
      response.status,
      undefined,
      {
        cause,
      },
    )
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now())
}

import { ResponseBodyError, readBoundedResponseJson } from "./response-body"
