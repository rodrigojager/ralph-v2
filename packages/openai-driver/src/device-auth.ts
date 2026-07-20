import {
  boundedJsonFetch,
  CHATGPT_DEVICE_POLL_SAFETY_MARGIN_MS,
  CHATGPT_DEVICE_VERIFICATION_URL,
  classifyHttpFailure,
  exchangeAuthorizationCode,
  OPENAI_AUTH_ISSUER,
  OPENAI_OAUTH_CLIENT_ID,
  OpenAiDriverError,
  type OpenAiTokenResponse,
  type ProtocolRuntime,
} from "./protocol"

export type DeviceAuthorizationChallenge = {
  deviceAuthId: string
  userCode: string
  intervalMs: number
  verificationUrl: string
}

export type DevicePollRuntime = Pick<ProtocolRuntime, "fetch" | "now"> & {
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export type DevicePollOptions = {
  issuer?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxPolls?: number
  userAgent?: string
}

export const DEFAULT_RALPH_OPENAI_USER_AGENT = "ralph-next/0.1.0-beta.2"

export async function startDeviceAuthorization(
  runtime: Pick<ProtocolRuntime, "fetch">,
  options: DevicePollOptions = {},
): Promise<DeviceAuthorizationChallenge> {
  const normalizedIssuer = validateIssuer(options.issuer ?? OPENAI_AUTH_ISSUER)
  const userAgent = validateUserAgent(options.userAgent)
  const { response, value } = await boundedJsonFetch(
    runtime.fetch,
    `${normalizedIssuer}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": userAgent },
      body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
      redirect: "error",
    },
    options,
    "Device authorization",
  )
  if (!response.ok) throw classifyHttpFailure(response.status, response.headers)
  if (!isRecord(value)) {
    throw new OpenAiDriverError("protocol-drift", "Device authorization response is not an object")
  }
  const deviceAuthId = requiredString(value.device_auth_id)
  const userCode = requiredString(value.user_code)
  const interval =
    typeof value.interval === "string" ? Number.parseInt(value.interval, 10) : Number.NaN
  if (!deviceAuthId || !userCode || !Number.isFinite(interval) || interval < 1) {
    throw new OpenAiDriverError(
      "protocol-drift",
      "Device authorization response has an incompatible schema",
    )
  }
  return {
    deviceAuthId,
    userCode,
    intervalMs: interval * 1_000,
    verificationUrl: `${normalizedIssuer}/codex/device`,
  }
}

export async function pollDeviceAuthorization(
  challenge: DeviceAuthorizationChallenge,
  runtime: DevicePollRuntime,
  options: DevicePollOptions = {},
): Promise<OpenAiTokenResponse> {
  const issuer = validateIssuer(options.issuer ?? OPENAI_AUTH_ISSUER)
  const userAgent = validateUserAgent(options.userAgent)
  validateChallenge(challenge, `${issuer}/codex/device`)
  const now = runtime.now ?? Date.now
  const sleep = runtime.sleep ?? abortableSleep
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1_000
  const maxPolls = options.maxPolls ?? 120
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new OpenAiDriverError("invalid-input", "Device authorization timeout is invalid")
  }
  if (!Number.isSafeInteger(maxPolls) || maxPolls <= 0) {
    throw new OpenAiDriverError("invalid-input", "Device authorization poll limit is invalid")
  }
  const startedAt = now()

  for (let poll = 1; poll <= maxPolls; poll += 1) {
    throwIfCancelled(options.signal)
    if (now() - startedAt >= timeoutMs) {
      throw new OpenAiDriverError("timeout", "Device authorization timed out")
    }
    const remainingMs = timeoutMs - (now() - startedAt)
    const { response, value } = await boundedJsonFetch(
      runtime.fetch,
      `${issuer}/api/accounts/deviceauth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": userAgent },
        body: JSON.stringify({
          device_auth_id: challenge.deviceAuthId,
          user_code: challenge.userCode,
        }),
        redirect: "error",
      },
      {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: Math.max(1, Math.min(remainingMs, 30_000)),
      },
      "Device authorization",
    )

    if (response.ok) {
      if (!isRecord(value)) {
        throw new OpenAiDriverError("protocol-drift", "Device token response is not an object")
      }
      const authorizationCode = requiredString(value.authorization_code)
      const codeVerifier = requiredString(value.code_verifier)
      if (!authorizationCode || !codeVerifier) {
        throw new OpenAiDriverError(
          "protocol-drift",
          "Device token response has an incompatible schema",
        )
      }
      return exchangeAuthorizationCode(
        {
          code: authorizationCode,
          redirectUri: `${issuer}/deviceauth/callback`,
          pkce: { verifier: codeVerifier, challenge: "" },
          issuer,
        },
        runtime,
        {
          ...(options.signal ? { signal: options.signal } : {}),
          timeoutMs: Math.max(1, Math.min(timeoutMs - (now() - startedAt), 30_000)),
        },
      )
    }

    if (response.status !== 403 && response.status !== 404) {
      throw classifyHttpFailure(response.status, response.headers)
    }
    if (poll === maxPolls) break
    const delay = challenge.intervalMs + CHATGPT_DEVICE_POLL_SAFETY_MARGIN_MS
    if (now() - startedAt + delay >= timeoutMs) {
      throw new OpenAiDriverError("timeout", "Device authorization timed out")
    }
    try {
      await sleep(delay, options.signal)
    } catch (cause) {
      if (options.signal?.aborted) {
        throw new OpenAiDriverError("cancelled", "Device authorization was cancelled")
      }
      throw new OpenAiDriverError(
        "transport",
        "Device authorization wait failed",
        undefined,
        undefined,
        { cause },
      )
    }
  }

  throw new OpenAiDriverError("timeout", "Device authorization poll limit was reached")
}

export function isPinnedDeviceVerificationUrl(value: string): boolean {
  return value === CHATGPT_DEVICE_VERIFICATION_URL
}

function validateChallenge(challenge: DeviceAuthorizationChallenge, verificationUrl: string): void {
  if (
    !challenge.deviceAuthId ||
    !challenge.userCode ||
    !Number.isSafeInteger(challenge.intervalMs) ||
    challenge.intervalMs < 1_000 ||
    challenge.verificationUrl !== verificationUrl
  ) {
    throw new OpenAiDriverError("invalid-input", "Device authorization challenge is invalid")
  }
}

function validateIssuer(value: string): string {
  const issuer = new URL(value)
  if (issuer.protocol !== "https:") {
    throw new OpenAiDriverError("invalid-input", "Device authorization issuer must use HTTPS")
  }
  return issuer.toString().replace(/\/$/, "")
}

function validateUserAgent(value = DEFAULT_RALPH_OPENAI_USER_AGENT): string {
  if (!/^[A-Za-z0-9._/() -]{1,256}$/.test(value)) {
    throw new OpenAiDriverError("invalid-input", "Device authorization user agent is invalid")
  }
  return value
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OpenAiDriverError("cancelled", "Device authorization was cancelled")
  }
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const settle = () => {
      signal?.removeEventListener("abort", cancel)
      resolve()
    }
    const timer = setTimeout(settle, milliseconds)
    const cancel = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", cancel, { once: true })
  })
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
