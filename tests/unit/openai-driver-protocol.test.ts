import { describe, expect, test } from "bun:test"
import {
  buildBrowserAuthorization,
  CHATGPT_CODEX_RESPONSES_ENDPOINT,
  CHATGPT_OAUTH_ORIGINATOR,
  chatGptCredentialFromTokens,
  exchangeAuthorizationCode,
  extractAccountId,
  OPENAI_AUTH_ISSUER,
  OPENAI_MAX_OAUTH_RESPONSE_BYTES,
  OPENAI_OAUTH_CLIENT_ID,
  OpenAiDriverError,
  prepareBrowserAuthorization,
  refreshAccessToken,
  rewriteChatGptCodexRequest,
  validateBrowserCallback,
} from "../../packages/openai-driver/src"

const pkce = {
  verifier: "v".repeat(43),
  challenge: "challenge_without_padding",
}

function jwt(claims: unknown): string {
  return ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(
    ".",
  )
}

describe("pinned ChatGPT/Codex protocol", () => {
  test("generates deterministic PKCE and state through injected entropy", async () => {
    const authorization = await prepareBrowserAuthorization("http://127.0.0.1:1455/auth/callback", {
      randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index),
      sha256: async () => new Uint8Array(32).fill(255),
    })

    expect(authorization.pkce.verifier).toHaveLength(43)
    expect(authorization.pkce.challenge).toBe("__________________________________________8")
    expect(authorization.state).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
    const url = new URL(authorization.url)
    expect(url.searchParams.get("state")).toBe(authorization.state)
    expect(url.searchParams.get("code_challenge")).toBe(authorization.pkce.challenge)
  })

  test("builds the browser authorization URL from explicit state and PKCE inputs", () => {
    const authorization = buildBrowserAuthorization({
      redirectUri: "http://localhost:1455/auth/callback",
      state: "fixed-state",
      pkce,
    })
    const url = new URL(authorization.url)

    expect(OPENAI_OAUTH_CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(OPENAI_AUTH_ISSUER).toBe("https://auth.openai.com")
    expect(CHATGPT_CODEX_RESPONSES_ENDPOINT).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(url.origin).toBe(OPENAI_AUTH_ISSUER)
    expect(url.pathname).toBe("/oauth/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: OPENAI_OAUTH_CLIENT_ID,
      redirect_uri: "http://localhost:1455/auth/callback",
      scope: "openid profile email offline_access",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state: "fixed-state",
      originator: CHATGPT_OAUTH_ORIGINATOR,
    })
  })

  test("validates callback state without exposing provider details", () => {
    expect(
      validateBrowserCallback(
        "http://localhost:1455/auth/callback?code=authorization-code&state=fixed-state",
        "fixed-state",
      ),
    ).toEqual({ code: "authorization-code", state: "fixed-state" })

    expect(() =>
      validateBrowserCallback(
        "http://localhost:1455/auth/callback?code=secret-code&state=attacker",
        "fixed-state",
      ),
    ).toThrow("OAuth callback state mismatch")
  })

  test("exchanges and refreshes tokens using the exact form protocol", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) })
      return Response.json({
        id_token: jwt({ chatgpt_account_id: "account-primary" }),
        access_token: "access-canary",
        refresh_token: "refresh-canary",
        expires_in: 1800,
      })
    }

    const exchanged = await exchangeAuthorizationCode(
      {
        code: "authorization-code",
        redirectUri: "http://localhost:1455/auth/callback",
        pkce,
      },
      { fetch: fetcher },
    )
    const refreshed = await refreshAccessToken("refresh-original", { fetch: fetcher })

    expect(exchanged).toEqual(refreshed)
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/oauth/token",
      "https://auth.openai.com/oauth/token",
    ])
    expect(String(requests[0]?.init?.body)).toBe(
      "grant_type=authorization_code&code=authorization-code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&client_id=app_EMoamEEZ73f0CkXaXp7hrann&code_verifier=vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv",
    )
    expect(String(requests[1]?.init?.body)).toBe(
      "grant_type=refresh_token&refresh_token=refresh-original&client_id=app_EMoamEEZ73f0CkXaXp7hrann",
    )
  })

  test("extracts only a safe account ID for metadata and preserves it across refresh", () => {
    const idToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-nested" },
    })
    expect(extractAccountId(idToken)).toBe("account-nested")
    expect(extractAccountId(jwt({ organizations: [{ id: "org-fallback" }] }))).toBe("org-fallback")
    expect(extractAccountId(jwt({ chatgpt_account_id: "bad\r\nInjected: value" }))).toBeUndefined()

    expect(
      chatGptCredentialFromTokens(
        {
          idToken: "invalid",
          accessToken: "next-access",
          refreshToken: "next-refresh",
          expiresInSeconds: 60,
        },
        1_000,
        "account-prior",
      ),
    ).toEqual({
      kind: "chatgpt-subscription",
      accessToken: "next-access",
      refreshToken: "next-refresh",
      expiresAt: 61_000,
      accountId: "account-prior",
    })
  })

  test("rewrites only supported OpenAI paths and replaces untrusted auth headers", () => {
    const rewritten = rewriteChatGptCodexRequest({
      request: "https://api.openai.com/v1/responses",
      init: {
        method: "POST",
        headers: {
          Authorization: "Bearer attacker",
          "ChatGPT-Account-Id": "attacker-account",
          "Content-Type": "application/json",
        },
        body: '{"stream":true}',
      },
      credential: {
        accessToken: "access-canary",
        accountId: "account-safe",
      },
    })
    const headers = new Headers(rewritten.init.headers)

    expect(rewritten.url.toString()).toBe(CHATGPT_CODEX_RESPONSES_ENDPOINT)
    expect(headers.get("authorization")).toBe("Bearer access-canary")
    expect(headers.get("ChatGPT-Account-Id")).toBe("account-safe")
    expect(rewritten.init.body).toBe('{"stream":true}')
    expect(rewritten.init.redirect).toBe("error")

    expect(() =>
      rewriteChatGptCodexRequest({
        request: "https://api.openai.com/v1/files",
        credential: { accessToken: "access-canary" },
      }),
    ).toThrow("supported OpenAI response path")
  })

  test("fails closed on incompatible token schema without leaking response tokens", async () => {
    const promise = refreshAccessToken("refresh-super-secret", {
      fetch: async () => Response.json({ access_token: "leaked-access" }),
    })
    const error = await promise.catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(OpenAiDriverError)
    expect(error).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(String(error)).not.toContain("refresh-super-secret")
    expect(String(error)).not.toContain("leaked-access")
  })

  test("bounds token refresh when fetch ignores cancellation", async () => {
    const never = async (): Promise<Response> => new Promise(() => {})
    const timedOut = await refreshAccessToken(
      "refresh-secret-canary",
      { fetch: never },
      { timeoutMs: 5 },
    ).catch((cause: unknown) => cause)
    expect(timedOut).toMatchObject({ kind: "timeout", failClosed: true })
    expect(String(timedOut)).not.toContain("refresh-secret-canary")

    const controller = new AbortController()
    const cancelledPromise = refreshAccessToken(
      "refresh-secret-canary",
      { fetch: never },
      { signal: controller.signal, timeoutMs: 1_000 },
    ).catch((cause: unknown) => cause)
    controller.abort("cancel test")
    const cancelled = await cancelledPromise
    expect(cancelled).toMatchObject({ kind: "cancelled", failClosed: true })
  })

  test("keeps the OAuth deadline active through a stalled token response body", async () => {
    const error = await refreshAccessToken(
      "refresh-secret-canary",
      {
        fetch: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "Content-Type": "application/json" },
          }),
      },
      { timeoutMs: 10 },
    ).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ kind: "timeout", failClosed: true })
    expect(String(error)).not.toContain("refresh-secret-canary")
  })

  test("rejects oversized, invalid UTF-8 and invalid JSON token responses", async () => {
    const cases = [
      new Uint8Array(OPENAI_MAX_OAUTH_RESPONSE_BYTES + 1).fill(0x20),
      Uint8Array.from([0xc3, 0x28]),
      new TextEncoder().encode("{not-json"),
    ]
    for (const body of cases) {
      const error = await refreshAccessToken("refresh-secret-canary", {
        fetch: async () => new Response(body, { headers: { "Content-Type": "application/json" } }),
      }).catch((cause: unknown) => cause)
      expect(error).toMatchObject({ kind: "protocol-drift", failClosed: true })
      expect(String(error)).not.toContain("refresh-secret-canary")
    }
  })
})
