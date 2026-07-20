import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  CHATGPT_CODEX_RESPONSES_ENDPOINT,
  ChatGptCodexDriver,
  chatGptCredentialFromTokens,
  exchangeAuthorizationCode,
  type OpenAiEvent,
  prepareBrowserAuthorization,
  validateBrowserCallback,
} from "../../packages/openai-driver/src"

const fixture = resolve(import.meta.dir, "../fixtures/openai-driver/chatgpt-sse.txt")

function jwt(claims: unknown): string {
  return ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(
    ".",
  )
}

describe("embedded ChatGPT subscription vertical smoke", () => {
  test("goes from browser authorization through token exchange to read-only SSE without CLI", async () => {
    const authorization = await prepareBrowserAuthorization("http://localhost:1455/auth/callback", {
      randomBytes: (size) => new Uint8Array(size).fill(7),
      sha256: async () => new Uint8Array(32).fill(11),
    })
    const callback = validateBrowserCallback(
      `${authorization.redirectUri}?code=browser-authorization-code&state=${authorization.state}`,
      authorization.state,
    )
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const golden = await Bun.file(fixture).text()
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), ...(init ? { init } : {}) })
      if (String(input) === "https://auth.openai.com/oauth/token") {
        return Response.json({
          id_token: jwt({ chatgpt_account_id: "account-integration" }),
          access_token: "integration-access-secret",
          refresh_token: "integration-refresh-secret",
          expires_in: 3_600,
        })
      }
      return new Response(golden, { headers: { "Content-Type": "text/event-stream" } })
    }
    const tokens = await exchangeAuthorizationCode(
      {
        code: callback.code,
        redirectUri: authorization.redirectUri,
        pkce: authorization.pkce,
      },
      { fetch: fetcher },
    )
    const driver = new ChatGptCodexDriver({
      credential: chatGptCredentialFromTokens(tokens, 10_000),
      fetch: fetcher,
      now: () => 11_000,
    })
    const events: OpenAiEvent[] = []
    const result = await driver.smoke(
      { model: "gpt-5.4-mini", prompt: "Return a short read-only diagnostic." },
      (event) => {
        events.push(event)
      },
    )

    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.openai.com/oauth/token",
      CHATGPT_CODEX_RESPONSES_ENDPOINT,
    ])
    const tokenBody = String(calls[0]?.init?.body)
    expect(tokenBody).toContain("grant_type=authorization_code")
    expect(tokenBody).toContain("code=browser-authorization-code")
    const modelHeaders = new Headers(calls[1]?.init?.headers)
    expect(modelHeaders.get("authorization")).toBe("Bearer integration-access-secret")
    expect(modelHeaders.get("ChatGPT-Account-Id")).toBe("account-integration")
    const modelBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>
    expect(modelBody).toMatchObject({ model: "gpt-5.4-mini", stream: true, store: false })
    expect(modelBody).not.toHaveProperty("tools")
    expect(result).toMatchObject({ finishReason: "stop", usage: { total: 14 } })
    expect(events.some((event) => event.type === "text")).toBeTrue()
    expect(events.some((event) => event.type === "reasoning")).toBeTrue()
    expect(events.some((event) => event.type === "raw")).toBeTrue()
    expect(JSON.stringify(events)).not.toContain("integration-access-secret")
    expect(JSON.stringify(events)).not.toContain("integration-refresh-secret")
  })
})
