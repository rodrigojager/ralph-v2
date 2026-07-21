import { describe, expect, test } from "bun:test"
import {
  CHATGPT_DEVICE_POLL_SAFETY_MARGIN_MS,
  CHATGPT_DEVICE_VERIFICATION_URL,
  DEFAULT_RALPH_OPENAI_USER_AGENT,
  OpenAiDriverError,
  pollDeviceAuthorization,
  startDeviceAuthorization,
} from "../../packages/openai-driver/src"

const codeVerifier = "v".repeat(43)

describe("ChatGPT headless device authorization", () => {
  test("starts with the pinned user-code endpoint and strict response schema", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const challenge = await startDeviceAuthorization({
      fetch: async (input, init) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) })
        return Response.json({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-EFGH",
          interval: "5",
        })
      },
    })

    expect(challenge).toEqual({
      deviceAuthId: "device-auth-id",
      userCode: "ABCD-EFGH",
      intervalMs: 5_000,
      verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://auth.openai.com/api/accounts/deviceauth/usercode")
    expect(calls[0]?.init?.body).toBe('{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann"}')
    expect(new Headers(calls[0]?.init?.headers).get("User-Agent")).toBe(
      DEFAULT_RALPH_OPENAI_USER_AGENT,
    )
  })

  test("polls pending responses then exchanges the device authorization code", async () => {
    const calls: Array<{ url: string; body: string; userAgent: string | null }> = []
    const sleeps: number[] = []
    const responses = [
      new Response(null, { status: 403 }),
      new Response(null, { status: 404 }),
      Response.json({ authorization_code: "authorization-code", code_verifier: codeVerifier }),
      Response.json({
        id_token: "header.payload.signature",
        access_token: "access-canary",
        refresh_token: "refresh-canary",
        expires_in: 3_600,
      }),
    ]
    const tokens = await pollDeviceAuthorization(
      {
        deviceAuthId: "device-auth-id",
        userCode: "ABCD-EFGH",
        intervalMs: 2_000,
        verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
      },
      {
        fetch: async (input, init) => {
          calls.push({
            url: String(input),
            body: String(init?.body),
            userAgent: new Headers(init?.headers).get("User-Agent"),
          })
          const response = responses.shift()
          if (!response) throw new Error("unexpected request")
          return response
        },
        now: () => 1_000,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
        },
      },
      { maxPolls: 4 },
    )

    expect(tokens).toMatchObject({
      accessToken: "access-canary",
      refreshToken: "refresh-canary",
      expiresInSeconds: 3_600,
    })
    expect(sleeps).toEqual([
      2_000 + CHATGPT_DEVICE_POLL_SAFETY_MARGIN_MS,
      2_000 + CHATGPT_DEVICE_POLL_SAFETY_MARGIN_MS,
    ])
    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ])
    expect(calls[3]?.body).toContain(
      "redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback",
    )
    expect(calls[3]?.body).toContain(`code_verifier=${codeVerifier}`)
    expect(calls.slice(0, 3).map((call) => call.userAgent)).toEqual([
      DEFAULT_RALPH_OPENAI_USER_AGENT,
      DEFAULT_RALPH_OPENAI_USER_AGENT,
      DEFAULT_RALPH_OPENAI_USER_AGENT,
    ])
  })

  test("allows a bounded Ralph user agent override without OpenCode or Codex CLI branding", async () => {
    const observed: Array<string | null> = []
    await startDeviceAuthorization(
      {
        fetch: async (_input, init) => {
          observed.push(new Headers(init?.headers).get("User-Agent"))
          return Response.json({
            device_auth_id: "device-auth-id",
            user_code: "ABCD-EFGH",
            interval: "5",
          })
        },
      },
      { userAgent: "ralph/fixture" },
    )
    expect(observed).toEqual(["ralph/fixture"])

    const error = await startDeviceAuthorization(
      { fetch: async () => Response.json({}) },
      { userAgent: "bad\r\nInjected: value" },
    ).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ kind: "invalid-input", failClosed: true })
  })

  test("separates cancellation, timeout and unexpected provider failure", async () => {
    const challenge = {
      deviceAuthId: "device-auth-id",
      userCode: "ABCD-EFGH",
      intervalMs: 1_000,
      verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
    }
    const controller = new AbortController()
    controller.abort("cancelled by test")
    const cancelled = await pollDeviceAuthorization(
      challenge,
      { fetch: async () => new Response(null, { status: 403 }) },
      { signal: controller.signal },
    ).catch((cause: unknown) => cause)
    expect(cancelled).toMatchObject({ kind: "cancelled", failClosed: true })

    const timedOut = await pollDeviceAuthorization(
      challenge,
      {
        fetch: async () => new Response(null, { status: 403 }),
        now: () => 10_000,
        sleep: async () => {},
      },
      { timeoutMs: 1, maxPolls: 2 },
    ).catch((cause: unknown) => cause)
    expect(timedOut).toBeInstanceOf(OpenAiDriverError)
    expect(timedOut).toMatchObject({ kind: "timeout" })

    const authFailed = await pollDeviceAuthorization(
      challenge,
      { fetch: async () => new Response(null, { status: 401 }) },
      { maxPolls: 1 },
    ).catch((cause: unknown) => cause)
    expect(authFailed).toMatchObject({ kind: "authentication", status: 401 })
  })

  test("fails closed when the device schema changes", async () => {
    const error = await startDeviceAuthorization({
      fetch: async () =>
        Response.json({ device_auth_id: "device", user_code: "CODE", interval: 5 }),
    }).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ kind: "protocol-drift", failClosed: true })
  })

  test("keeps the device deadline active through a stalled response body", async () => {
    const error = await startDeviceAuthorization(
      {
        fetch: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "Content-Type": "application/json" },
          }),
      },
      { timeoutMs: 10 },
    ).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ kind: "timeout", failClosed: true })
  })

  test("rejects malformed device response encodings", async () => {
    const error = await startDeviceAuthorization({
      fetch: async () =>
        new Response(Uint8Array.from([0xc3, 0x28]), {
          headers: { "Content-Type": "application/json" },
        }),
    }).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ kind: "protocol-drift", failClosed: true })
  })
})
