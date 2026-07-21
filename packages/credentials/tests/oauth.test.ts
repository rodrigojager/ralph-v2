import { describe, expect, test } from "bun:test"
import { ControlledTestClock } from "@ralph/test-kit"
import type { LoopbackCallbackFactory, OAuthClock, OAuthFetch, SecretInput } from "../src/index"
import {
  OAuthFlowError,
  REDACTED_SECRET,
  refreshOAuthToken,
  revokeOAuthToken,
  secretInputFromValue,
  startBrowserOAuth,
  startDeviceOAuth,
} from "../src/index"

const jsonResponse = (body: Record<string, unknown>, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

const deterministicRandom = (() => {
  let invocation = 0
  return (size: number) => {
    invocation += 1
    return Uint8Array.from({ length: size }, (_, index) => (index + invocation * 37) % 256)
  }
})()

function asForm(init: RequestInit | undefined): URLSearchParams {
  expect(init?.method).toBe("POST")
  expect(init?.redirect).toBe("error")
  expect(init?.body).toBeInstanceOf(URLSearchParams)
  return init?.body as URLSearchParams
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => new Error("Expected promise to reject"),
    (error: unknown) => error as Error,
  )
}

describe("OAuth browser flow", () => {
  test("uses state and S256 PKCE, rejects a wrong state, and exchanges the callback code", async () => {
    const idCanary = "browser-id-canary-9012"
    const accessCanary = "browser-access-canary-1234"
    const refreshCanary = "browser-refresh-canary-5678"
    let tokenForm: URLSearchParams | undefined
    const providerFetch: OAuthFetch = async (_input, init) => {
      tokenForm = asForm(init)
      return jsonResponse({
        id_token: idCanary,
        access_token: accessCanary,
        refresh_token: refreshCanary,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "models.read runs.write",
      })
    }
    const session = await startBrowserOAuth(
      {
        authorizationEndpoint: "https://accounts.example.test/authorize",
        tokenEndpoint: "https://accounts.example.test/token",
        clientId: "ralph-public-client",
        scopes: ["models.read", "runs.write"],
      },
      {
        fetch: providerFetch,
        openBrowser: async () => false,
        randomBytes: deterministicRandom,
      },
    )

    const authorization = new URL(session.authorizationUrl)
    expect(session.mode).toBe("headless")
    expect(session.browserOpened).toBe(false)
    expect(session.instructions).toContain(session.authorizationUrl)
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorization.searchParams.get("state")).toHaveLength(43)
    expect(authorization.searchParams.get("code_challenge")).toHaveLength(43)
    expect(authorization.searchParams.has("code_verifier")).toBe(false)

    const completion = session.complete()
    const wrongState = await fetch(`${session.redirectUri}?state=wrong&code=ignored`)
    expect(wrongState.status).toBe(400)
    const correctState = authorization.searchParams.get("state")
    if (!correctState) throw new Error("Authorization URL did not contain state")
    const callback = await fetch(
      `${session.redirectUri}?state=${encodeURIComponent(correctState)}&code=callback-code-canary`,
    )
    expect(callback.status).toBe(200)
    const tokens = await completion

    expect(tokenForm?.get("grant_type")).toBe("authorization_code")
    expect(tokenForm?.get("code")).toBe("callback-code-canary")
    expect(tokenForm?.get("redirect_uri")).toBe(session.redirectUri)
    expect(tokenForm?.get("code_verifier")).toHaveLength(64)
    expect(JSON.stringify(tokens)).not.toContain(accessCanary)
    expect(JSON.stringify(tokens)).not.toContain(refreshCanary)
    expect(JSON.stringify(tokens)).not.toContain(idCanary)
    expect(tokens.expiresAt).toBeDefined()
    expect(tokens.scope).toEqual(["models.read", "runs.write"])
    expect(await tokens.idToken?.readOnce()).toBe(idCanary)
    expect(await tokens.accessToken.readOnce()).toBe(accessCanary)
    expect(await tokens.refreshToken?.readOnce()).toBe(refreshCanary)
  })

  test("supports deterministic timeout and cancellation with actionable errors", async () => {
    let closed = 0
    const callbackFactory: LoopbackCallbackFactory = async () => {
      let callbackClosed = false
      return {
        redirectUri: "http://127.0.0.1:32123/oauth/callback",
        wait(signal) {
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            )
          })
        },
        async close() {
          if (callbackClosed) return
          callbackClosed = true
          closed += 1
        },
      }
    }
    const immediateClock: OAuthClock = {
      now: () => 0,
      async sleep() {},
    }
    const timedOut = await startBrowserOAuth(
      {
        authorizationEndpoint: "https://accounts.example.test/authorize",
        tokenEndpoint: "https://accounts.example.test/token",
        clientId: "ralph-public-client",
        scopes: ["models.read"],
        timeoutMs: 1,
        headless: true,
      },
      { clock: immediateClock, createLoopbackCallback: callbackFactory },
    )
    const timeoutError = await caught(timedOut.complete())
    expect(timeoutError).toBeInstanceOf(OAuthFlowError)
    expect((timeoutError as OAuthFlowError).code).toBe("timeout")
    expect((timeoutError as OAuthFlowError).actionableHint).toContain("Start a new")

    const neverClock: OAuthClock = {
      now: () => 0,
      sleep(_milliseconds, signal) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          )
        })
      },
    }
    const cancelled = await startBrowserOAuth(
      {
        authorizationEndpoint: "https://accounts.example.test/authorize",
        tokenEndpoint: "https://accounts.example.test/token",
        clientId: "ralph-public-client",
        scopes: ["models.read"],
        headless: true,
      },
      { clock: neverClock, createLoopbackCallback: callbackFactory },
    )
    const completing = cancelled.complete()
    await cancelled.cancel()
    const cancelError = await caught(completing)
    expect(cancelError).toBeInstanceOf(OAuthFlowError)
    expect((cancelError as OAuthFlowError).code).toBe("cancelled")
    expect(closed).toBe(2)
  })
})

class PollClock implements OAuthClock {
  value = 0
  readonly sleeps: number[] = []

  now(): number {
    return this.value
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds >= 60_000) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        })
      })
    }
    if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"))
    this.sleeps.push(milliseconds)
    this.value += milliseconds
    return Promise.resolve()
  }
}

describe("OAuth device flow", () => {
  test("handles authorization_pending and slow_down before returning redacted tokens", async () => {
    const accessCanary = "device-access-canary-1234"
    const refreshCanary = "device-refresh-canary-5678"
    const responses = [
      jsonResponse({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.example.test/device",
        verification_uri_complete: "https://accounts.example.test/device?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 2,
      }),
      jsonResponse({ error: "authorization_pending" }, 400),
      jsonResponse({ error: "slow_down" }, 400),
      jsonResponse({
        access_token: accessCanary,
        refresh_token: refreshCanary,
        token_type: "Bearer",
      }),
    ]
    const forms: URLSearchParams[] = []
    const providerFetch: OAuthFetch = async (_input, init) => {
      forms.push(asForm(init))
      const response = responses.shift()
      if (!response) throw new Error("No fake OAuth response")
      return response
    }
    const clock = new ControlledTestClock({ freezeSleepsAtOrAboveMs: 60_000 })
    const session = await startDeviceOAuth(
      {
        deviceAuthorizationEndpoint: "https://accounts.example.test/device/code",
        tokenEndpoint: "https://accounts.example.test/token",
        clientId: "ralph-device-client",
        scopes: ["models.read"],
        timeoutMs: 60_000,
      },
      { fetch: providerFetch, clock, openBrowser: async () => false },
    )

    expect(session.mode).toBe("headless")
    expect(session.instructions).toContain("ABCD-EFGH")
    expect(session.instructions).toContain("https://accounts.example.test/device")
    const tokens = await session.complete()

    expect(forms[0]?.get("scope")).toBe("models.read")
    expect(forms[1]?.get("device_code")).toBe("private-device-code")
    expect(forms[1]?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
    expect(clock.sleeps).toEqual([2_000, 7_000])
    expect(JSON.stringify(tokens)).not.toContain(accessCanary)
    expect(await tokens.accessToken.readOnce()).toBe(accessCanary)
    expect(await tokens.refreshToken?.readOnce()).toBe(refreshCanary)
  })

  test("cancels an in-flight device token request", async () => {
    let tokenRequestStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      tokenRequestStarted = resolve
    })
    let calls = 0
    const providerFetch: OAuthFetch = async (_input, init) => {
      calls += 1
      if (calls === 1) {
        return jsonResponse({
          device_code: "private-device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://accounts.example.test/device",
          expires_in: 600,
        })
      }
      tokenRequestStarted?.()
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        )
      })
    }
    const session = await startDeviceOAuth(
      {
        deviceAuthorizationEndpoint: "https://accounts.example.test/device/code",
        tokenEndpoint: "https://accounts.example.test/token",
        clientId: "ralph-device-client",
        scopes: ["models.read"],
        headless: true,
      },
      { fetch: providerFetch, clock: new PollClock() },
    )
    const completing = session.complete()
    await started
    session.cancel()
    const error = await caught(completing)
    expect(error).toBeInstanceOf(OAuthFlowError)
    expect((error as OAuthFlowError).code).toBe("cancelled")
  })

  test("cancels a stalled device token response body even if the stream ignores abort", async () => {
    let calls = 0
    const session = await startDeviceOAuth(
      {
        deviceAuthorizationEndpoint: "https://accounts.example.test/device/code",
        tokenEndpoint: "https://accounts.example.test/token",
        clientId: "ralph-device-client",
        scopes: ["models.read"],
        headless: true,
      },
      {
        fetch: async () => {
          calls += 1
          if (calls === 1) {
            return jsonResponse({
              device_code: "private-device-code",
              user_code: "ABCD-EFGH",
              verification_uri: "https://accounts.example.test/device",
              expires_in: 600,
            })
          }
          return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "content-type": "application/json" },
          })
        },
        clock: new PollClock(),
      },
    )
    const completion = session.complete()
    await Promise.resolve()
    session.cancel()
    const error = await caught(completion)
    expect(error).toBeInstanceOf(OAuthFlowError)
    expect((error as OAuthFlowError).code).toBe("cancelled")
  })
})

describe("OAuth refresh and revoke", () => {
  test("refuses provider redirects without replaying a refresh token", async () => {
    const canary = "redirect-refresh-canary-8811"
    let calls = 0
    const error = await caught(
      refreshOAuthToken(
        {
          tokenEndpoint: "https://accounts.example.test/token",
          clientId: "ralph-client",
        },
        secretInputFromValue(canary),
        {
          fetch: async (_input, init) => {
            calls += 1
            expect(asForm(init).get("refresh_token")).toBe(canary)
            return new Response(null, {
              status: 302,
              headers: { location: "https://attacker.example.test/collect" },
            })
          },
        },
      ),
    )

    expect(calls).toBe(1)
    expect(error).toBeInstanceOf(OAuthFlowError)
    expect((error as OAuthFlowError).status).toBe(302)
    expect(JSON.stringify(error)).not.toContain(canary)
  })

  test("refreshes with rotation fallback and revokes without serializing tokens", async () => {
    const oldRefresh = "old-refresh-canary-1234"
    const accessCanary = "refreshed-access-canary-5678"
    const clientSecret = "oauth-client-secret-canary-9012"
    const forms: URLSearchParams[] = []
    const providerFetch: OAuthFetch = async (_input, init) => {
      const form = asForm(init)
      forms.push(form)
      if (form.has("refresh_token")) {
        return jsonResponse({ access_token: accessCanary, expires_in: 120 })
      }
      return new Response(null, { status: 204 })
    }
    const refreshed = await refreshOAuthToken(
      {
        tokenEndpoint: "https://accounts.example.test/token",
        clientId: "ralph-client",
        clientSecret: secretInputFromValue(clientSecret),
      },
      secretInputFromValue(oldRefresh),
      { fetch: providerFetch, clock: { now: () => 1_000, sleep: async () => undefined } },
    )
    expect(forms[0]?.get("refresh_token")).toBe(oldRefresh)
    expect(forms[0]?.get("client_secret")).toBe(clientSecret)
    expect(JSON.stringify(refreshed)).toContain(REDACTED_SECRET)
    expect(JSON.stringify(refreshed)).not.toContain(oldRefresh)
    expect(await refreshed.accessToken.readOnce()).toBe(accessCanary)

    const fallbackRefresh = refreshed.refreshToken as SecretInput
    expect(await fallbackRefresh.readOnce()).toBe(oldRefresh)
    await revokeOAuthToken(
      {
        revocationEndpoint: "https://accounts.example.test/revoke",
        clientId: "ralph-client",
        tokenTypeHint: "refresh_token",
      },
      secretInputFromValue(oldRefresh),
      { fetch: providerFetch },
    )
    expect(forms[1]?.get("token")).toBe(oldRefresh)
    expect(forms[1]?.get("token_type_hint")).toBe("refresh_token")
  })

  test("redacts provider error descriptions that echo a credential", async () => {
    const canary = "provider-error-secret-canary-3456"
    const error = await caught(
      refreshOAuthToken(
        {
          tokenEndpoint: "https://accounts.example.test/token",
          clientId: "ralph-client",
        },
        secretInputFromValue(canary),
        {
          fetch: async () =>
            jsonResponse(
              { error: "invalid_grant", error_description: `provider echoed ${canary}` },
              401,
            ),
        },
      ),
    )
    expect(error.message).not.toContain(canary)
    expect(error.message).toContain(REDACTED_SECRET)
    expect(JSON.stringify(error)).not.toContain(canary)
  })

  test("reads OAuth JSON incrementally with byte and UTF-8 limits", async () => {
    const bodies = [
      new Uint8Array(1_048_577).fill(0x20),
      Uint8Array.from([0xc3, 0x28]),
      new TextEncoder().encode("{not-json"),
    ]
    for (const body of bodies) {
      const error = await caught(
        refreshOAuthToken(
          {
            tokenEndpoint: "https://accounts.example.test/token",
            clientId: "ralph-client",
          },
          secretInputFromValue("refresh-body-limit-canary"),
          { fetch: async () => new Response(body) },
        ),
      )
      expect(error).toBeInstanceOf(OAuthFlowError)
      expect((error as OAuthFlowError).code).toBe("invalid_response")
      expect(JSON.stringify(error)).not.toContain("refresh-body-limit-canary")
    }
  })

  test("cancels a stalled refresh response body without relying on stream abort", async () => {
    const controller = new AbortController()
    const refresh = refreshOAuthToken(
      {
        tokenEndpoint: "https://accounts.example.test/token",
        clientId: "ralph-client",
      },
      secretInputFromValue("refresh-cancel-canary"),
      {
        fetch: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "content-type": "application/json" },
          }),
      },
      { signal: controller.signal },
    )
    controller.abort()
    const error = await caught(refresh)
    expect(error).toBeInstanceOf(OAuthFlowError)
    expect((error as OAuthFlowError).code).toBe("cancelled")
    expect(JSON.stringify(error)).not.toContain("refresh-cancel-canary")
  })
})
