import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  CHATGPT_CODEX_RESPONSES_ENDPOINT,
  ChatGptCodexDriver,
  isChatGptCodexModelAllowed,
  OPENAI_MAX_ERROR_RESPONSE_BYTES,
  OpenAiApiKeyDriver,
  OpenAiDriverError,
  type OpenAiEvent,
} from "../../packages/openai-driver/src"

const fixtures = resolve(import.meta.dir, "../fixtures/openai-driver")

function eventCollector(): { events: OpenAiEvent[]; sink: (event: OpenAiEvent) => void } {
  const events: OpenAiEvent[] = []
  return {
    events,
    sink(event) {
      events.push(event)
    },
  }
}

function jwt(claims: unknown): string {
  return ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(
    ".",
  )
}

describe("embedded OpenAI smoke drivers", () => {
  test("sends strict tools and function outputs only through the general invoke contract", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const driver = new OpenAiApiKeyDriver({
      apiKey: "api-key-canary",
      fetch: async (input, init) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) })
        return Response.json({ status: "completed", output_text: "done" })
      },
    })

    await driver.invoke(
      {
        model: "gpt-api-fixture",
        instructions: "Use only the supplied Ralph tools.",
        input: [
          { type: "message", role: "user", content: "Read the file." },
          {
            type: "reasoning",
            itemId: "rs-1",
            encryptedContent: "opaque-reasoning-payload",
            summary: [],
          },
          {
            type: "function_call",
            itemId: "fc-1",
            callId: "call-1",
            name: "fs_read",
            argumentsJson: '{"path":"README.md"}',
          },
          { type: "function_call_output", callId: "call-1", output: '{"status":"success"}' },
        ],
        textFormat: {
          type: "json_schema",
          name: "ralph_outcome",
          schema: {
            type: "object",
            properties: { status: { type: "string" } },
            required: ["status"],
            additionalProperties: false,
          },
          strict: true,
        },
        tools: [
          {
            name: "fs_read",
            description: "Read a bounded workspace file.",
            strict: true,
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
          },
        ],
        maxOutputTokens: 512,
      },
      () => {},
    )

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      instructions: "Use only the supplied Ralph tools.",
      max_output_tokens: 512,
      parallel_tool_calls: false,
      tool_choice: "auto",
      text: {
        format: {
          type: "json_schema",
          name: "ralph_outcome",
          strict: true,
        },
      },
      tools: [
        {
          type: "function",
          name: "fs_read",
          strict: true,
          parameters: { type: "object", additionalProperties: false },
        },
      ],
      input: [
        { role: "user" },
        {
          type: "reasoning",
          id: "rs-1",
          encrypted_content: "opaque-reasoning-payload",
          summary: [],
        },
        { type: "function_call", id: "fc-1", call_id: "call-1", name: "fs_read" },
        { type: "function_call_output", call_id: "call-1" },
      ],
    })
  })

  test("keeps the API-key driver separate and sends a read-only tool-free smoke", async () => {
    const golden = await Bun.file(resolve(fixtures, "openai-json.json")).text()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const collector = eventCollector()
    const driver = new OpenAiApiKeyDriver({
      apiKey: "api-key-canary",
      fetch: async (input, init) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) })
        return new Response(golden, { headers: { "Content-Type": "application/json" } })
      },
    })

    const result = await driver.smoke(
      {
        model: "gpt-api-fixture",
        prompt: "Return one short diagnostic.",
        parameters: { reasoning_effort: "high" },
      },
      collector.sink,
    )
    const request = calls[0]
    const headers = new Headers(request?.init?.headers)
    const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>

    expect(request?.url).toBe("https://api.openai.com/v1/responses")
    expect(headers.get("authorization")).toBe("Bearer api-key-canary")
    expect(headers.has("ChatGPT-Account-Id")).toBeFalse()
    expect(body).toMatchObject({
      model: "gpt-api-fixture",
      stream: true,
      store: false,
      reasoning: { effort: "high" },
    })
    expect(body).not.toHaveProperty("tools")
    expect(result.finishReason).toBe("stop")
    expect(driver.credentialMetadata()).toEqual({ kind: "openai-api-key", available: true })
  })

  test("refreshes an expired subscription in memory and calls the pinned Codex endpoint", async () => {
    const golden = await Bun.file(resolve(fixtures, "chatgpt-sse.txt")).text()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const collector = eventCollector()
    const driver = new ChatGptCodexDriver({
      credential: {
        kind: "chatgpt-subscription",
        accessToken: "expired-access-canary",
        refreshToken: "refresh-canary",
        expiresAt: 999,
        accountId: "account-prior",
      },
      now: () => 1_000,
      fetch: async (input, init) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) })
        if (String(input).endsWith("/oauth/token")) {
          return Response.json({
            id_token: jwt({ chatgpt_account_id: "account-refreshed" }),
            access_token: "fresh-access-canary",
            refresh_token: "fresh-refresh-canary",
            expires_in: 3_600,
          })
        }
        return new Response(golden, { headers: { "Content-Type": "text/event-stream" } })
      },
    })

    const result = await driver.smoke(
      { model: "gpt-5.4", prompt: "Return one short diagnostic." },
      collector.sink,
    )
    const modelCall = calls[1]
    const headers = new Headers(modelCall?.init?.headers)
    const body = JSON.parse(String(modelCall?.init?.body)) as Record<string, unknown>

    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.openai.com/oauth/token",
      CHATGPT_CODEX_RESPONSES_ENDPOINT,
    ])
    expect(headers.get("authorization")).toBe("Bearer fresh-access-canary")
    expect(headers.get("ChatGPT-Account-Id")).toBe("account-refreshed")
    expect(headers.get("originator")).toBe("opencode")
    expect(body).toMatchObject({ model: "gpt-5.4", stream: true, store: false })
    expect(body).not.toHaveProperty("tools")
    expect(result.usage.total).toBe(14)
    expect(driver.credentialMetadata()).toEqual({
      kind: "chatgpt-subscription",
      available: true,
      expiresAt: 3_601_000,
      accountId: "account-refreshed",
    })
    expect(JSON.stringify(driver)).not.toContain("fresh-access-canary")
    expect(JSON.stringify(driver)).not.toContain("fresh-refresh-canary")
  })

  test("keeps cancellation local to one waiter on a shared credential refresh", async () => {
    const golden = await Bun.file(resolve(fixtures, "chatgpt-sse.txt")).text()
    let releaseRefresh: ((response: Response) => void) | undefined
    let refreshStarted: (() => void) | undefined
    const refreshStartedPromise = new Promise<void>((resolveStarted) => {
      refreshStarted = resolveStarted
    })
    const refreshResponse = new Promise<Response>((resolveResponse) => {
      releaseRefresh = resolveResponse
    })
    let refreshCalls = 0
    let modelCalls = 0
    const driver = new ChatGptCodexDriver({
      credential: {
        kind: "chatgpt-subscription",
        accessToken: "expired-access-canary",
        refreshToken: "refresh-canary",
        expiresAt: 999,
      },
      now: () => 1_000,
      fetch: async (input) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1
          refreshStarted?.()
          return refreshResponse
        }
        modelCalls += 1
        return new Response(golden, { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    const cancelledController = new AbortController()
    const cancelledWaiter = driver
      .smoke({ model: "gpt-5.4", prompt: "diagnostic" }, () => {}, {
        signal: cancelledController.signal,
        timeoutMs: 1_000,
      })
      .catch((cause: unknown) => cause)
    const survivingWaiter = driver.smoke({ model: "gpt-5.4", prompt: "diagnostic" }, () => {}, {
      timeoutMs: 1_000,
    })

    await refreshStartedPromise
    cancelledController.abort("cancel only this waiter")
    expect(await cancelledWaiter).toMatchObject({ kind: "cancelled", failClosed: true })
    releaseRefresh?.(
      Response.json({
        id_token: jwt({ chatgpt_account_id: "account-refreshed" }),
        access_token: "fresh-access-canary",
        refresh_token: "fresh-refresh-canary",
        expires_in: 3_600,
      }),
    )

    expect((await survivingWaiter).finishReason).toBe("stop")
    expect(refreshCalls).toBe(1)
    expect(modelCalls).toBe(1)
  })

  test("gives concurrent refresh waiters independent timeout budgets", async () => {
    const golden = await Bun.file(resolve(fixtures, "chatgpt-sse.txt")).text()
    let releaseRefresh: ((response: Response) => void) | undefined
    let refreshStarted: (() => void) | undefined
    const refreshStartedPromise = new Promise<void>((resolveStarted) => {
      refreshStarted = resolveStarted
    })
    const refreshResponse = new Promise<Response>((resolveResponse) => {
      releaseRefresh = resolveResponse
    })
    let refreshCalls = 0
    let modelCalls = 0
    const driver = new ChatGptCodexDriver({
      credential: {
        kind: "chatgpt-subscription",
        accessToken: "expired-access-canary",
        refreshToken: "refresh-canary",
        expiresAt: 999,
      },
      now: () => 1_000,
      fetch: async (input) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1
          refreshStarted?.()
          return refreshResponse
        }
        modelCalls += 1
        return new Response(golden, { headers: { "Content-Type": "text/event-stream" } })
      },
    })
    const shortWaiter = driver
      .smoke({ model: "gpt-5.4", prompt: "diagnostic" }, () => {}, { timeoutMs: 10 })
      .catch((cause: unknown) => cause)
    const longWaiter = driver.smoke({ model: "gpt-5.4", prompt: "diagnostic" }, () => {}, {
      timeoutMs: 1_000,
    })

    await refreshStartedPromise
    expect(await shortWaiter).toMatchObject({ kind: "timeout", failClosed: true })
    releaseRefresh?.(
      Response.json({
        id_token: jwt({ chatgpt_account_id: "account-refreshed" }),
        access_token: "fresh-access-canary",
        refresh_token: "fresh-refresh-canary",
        expires_in: 3_600,
      }),
    )

    expect((await longWaiter).finishReason).toBe("stop")
    expect(refreshCalls).toBe(1)
    expect(modelCalls).toBe(1)
  })

  test("uses one absolute deadline across refresh and model request", async () => {
    let releaseRefresh: ((response: Response) => void) | undefined
    let refreshStarted: (() => void) | undefined
    let modelStarted: (() => void) | undefined
    const refreshStartedPromise = new Promise<void>((resolveStarted) => {
      refreshStarted = resolveStarted
    })
    const modelStartedPromise = new Promise<void>((resolveStarted) => {
      modelStarted = resolveStarted
    })
    const refreshResponse = new Promise<Response>((resolveResponse) => {
      releaseRefresh = resolveResponse
    })
    const driver = new ChatGptCodexDriver({
      credential: {
        kind: "chatgpt-subscription",
        accessToken: "expired-access-canary",
        refreshToken: "refresh-canary",
        expiresAt: 999,
      },
      now: () => 1_000,
      fetch: async (input) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshStarted?.()
          return refreshResponse
        }
        modelStarted?.()
        return new Promise<Response>(() => {})
      },
    })
    const smoke = driver
      .smoke({ model: "gpt-5.4", prompt: "diagnostic" }, () => {}, { timeoutMs: 100 })
      .catch((cause: unknown) => cause)

    await refreshStartedPromise
    await Bun.sleep(70)
    releaseRefresh?.(
      Response.json({
        id_token: jwt({ chatgpt_account_id: "account-refreshed" }),
        access_token: "fresh-access-canary",
        refresh_token: "fresh-refresh-canary",
        expires_in: 3_600,
      }),
    )
    await modelStartedPromise
    const modelStartedAt = performance.now()
    expect(await smoke).toMatchObject({ kind: "timeout", failClosed: true })

    expect(performance.now() - modelStartedAt).toBeLessThan(65)
  })

  test("implements the pinned subscription model eligibility rules", () => {
    expect(isChatGptCodexModelAllowed("gpt-5.3-codex-spark")).toBeTrue()
    expect(isChatGptCodexModelAllowed("gpt-5.4-mini")).toBeTrue()
    expect(isChatGptCodexModelAllowed("gpt-5.3-codex")).toBeFalse()
    expect(isChatGptCodexModelAllowed("gpt-5.5-pro")).toBeFalse()
    expect(isChatGptCodexModelAllowed("gpt-5.6")).toBeFalse()
    expect(isChatGptCodexModelAllowed("gpt-5.7-codex")).toBeTrue()
    expect(isChatGptCodexModelAllowed("other-model")).toBeFalse()
  })

  test("classifies HTTP failures without retrying or switching credentials", async () => {
    const scenarios = [
      { status: 401, kind: "authentication", code: "invalid_token" },
      { status: 403, kind: "eligibility", code: "account_not_eligible" },
      { status: 404, kind: "protocol-drift", code: "unknown_endpoint" },
      { status: 429, kind: "rate-limit", code: "rate_limit" },
    ] as const

    for (const scenario of scenarios) {
      const collector = eventCollector()
      let calls = 0
      const driver = new ChatGptCodexDriver({
        credential: {
          kind: "chatgpt-subscription",
          accessToken: "access-secret-canary",
          refreshToken: "refresh-secret-canary",
          expiresAt: 10_000,
          accountId: "account-safe",
        },
        now: () => 1_000,
        fetch: async () => {
          calls += 1
          return Response.json(
            { error: { code: scenario.code, message: "body-secret-canary" } },
            {
              status: scenario.status,
              ...(scenario.status === 429 ? { headers: { "Retry-After": "2" } } : {}),
            },
          )
        },
      })
      const error = await driver
        .smoke({ model: "gpt-5.4", prompt: "diagnostic" }, collector.sink)
        .catch((cause: unknown) => cause)

      expect(error).toBeInstanceOf(OpenAiDriverError)
      expect(error).toMatchObject({
        kind: scenario.kind,
        status: scenario.status,
        failClosed: true,
      })
      if (!(error instanceof OpenAiDriverError)) throw new Error("Expected OpenAiDriverError")
      if (scenario.status === 429) expect(error.retryAfterMs).toBe(2_000)
      expect(calls).toBe(1)
      expect(collector.events.map((event) => event.type)).toEqual(["raw", "error"])
      expect(JSON.stringify(collector.events)).not.toContain("access-secret-canary")
      expect(JSON.stringify(collector.events)).not.toContain("refresh-secret-canary")
      expect(JSON.stringify(collector.events)).not.toContain("body-secret-canary")
    }
  })

  test("cancels and times out even when an injected fetch ignores abort", async () => {
    const never = async (): Promise<Response> => new Promise(() => {})
    const apiDriver = new OpenAiApiKeyDriver({ apiKey: "api-key-canary", fetch: never })
    const cancelledController = new AbortController()
    setTimeout(() => cancelledController.abort("test cancellation"), 0)
    const cancelled = await apiDriver
      .smoke({ model: "gpt-api-fixture", prompt: "diagnostic" }, () => {}, {
        signal: cancelledController.signal,
        timeoutMs: 1_000,
      })
      .catch((cause: unknown) => cause)
    expect(cancelled).toMatchObject({ kind: "cancelled", failClosed: true })

    const timedOut = await apiDriver
      .smoke({ model: "gpt-api-fixture", prompt: "diagnostic" }, () => {}, { timeoutMs: 5 })
      .catch((cause: unknown) => cause)
    expect(timedOut).toMatchObject({ kind: "timeout", failClosed: true })
  })

  test("times out while a successful fetch leaves the SSE body stalled", async () => {
    const stalledBody = new ReadableStream<Uint8Array>({ start() {} })
    const driver = new OpenAiApiKeyDriver({
      apiKey: "api-key-canary",
      fetch: async () =>
        new Response(stalledBody, { headers: { "Content-Type": "text/event-stream" } }),
    })
    const error = await driver
      .smoke({ model: "gpt-api-fixture", prompt: "diagnostic" }, () => {}, { timeoutMs: 5 })
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({ kind: "timeout", failClosed: true })
  })

  test("times out while success and 429 error JSON bodies are stalled", async () => {
    for (const status of [200, 429]) {
      const driver = new OpenAiApiKeyDriver({
        apiKey: "api-key-canary",
        fetch: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      })
      const error = await driver
        .smoke({ model: "gpt-api-fixture", prompt: "diagnostic" }, () => {}, {
          timeoutMs: 10,
        })
        .catch((cause: unknown) => cause)
      expect(error).toMatchObject({ kind: "timeout", failClosed: true })
    }
  })

  test("does not emit provider failure events after a timeout aborts body parsing", async () => {
    const collector = eventCollector()
    const driver = new OpenAiApiKeyDriver({
      apiKey: "api-key-canary",
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
    })
    const error = await driver
      .smoke({ model: "gpt-api-fixture", prompt: "diagnostic" }, collector.sink, {
        timeoutMs: 10,
      })
      .catch((cause: unknown) => cause)
    await Bun.sleep(10)

    expect(error).toMatchObject({ kind: "timeout", failClosed: true })
    expect(collector.events).toEqual([])
  })

  test("fences the second provider failure event when the first sink call crosses timeout", async () => {
    let releaseRaw: (() => void) | undefined
    const rawGate = new Promise<void>((resolveRaw) => {
      releaseRaw = resolveRaw
    })
    const eventTypes: string[] = []
    const driver = new OpenAiApiKeyDriver({
      apiKey: "api-key-canary",
      fetch: async () => Response.json({ error: { code: "rate_limit" } }, { status: 429 }),
    })
    const smoke = driver
      .smoke(
        { model: "gpt-api-fixture", prompt: "diagnostic" },
        async (event) => {
          eventTypes.push(event.type)
          if (event.type === "raw") await rawGate
        },
        { timeoutMs: 10 },
      )
      .catch((cause: unknown) => cause)

    expect(await smoke).toMatchObject({ kind: "timeout", failClosed: true })
    releaseRaw?.()
    await Bun.sleep(10)

    expect(eventTypes).toEqual(["raw"])
  })

  test("bounds HTTP error bodies and emits only allowlisted failure descriptors", async () => {
    const canary = "provider-error-body-secret-canary"
    const prefix = new TextEncoder().encode(
      JSON.stringify({ error: { code: "invalid_token", message: canary } }),
    )
    const oversized = new Uint8Array(OPENAI_MAX_ERROR_RESPONSE_BYTES + 1)
    oversized.set(prefix)
    const collector = eventCollector()
    const driver = new OpenAiApiKeyDriver({
      apiKey: "api-key-canary",
      fetch: async () => new Response(oversized, { status: 401 }),
    })
    const error = await driver
      .smoke({ model: "gpt-api-fixture", prompt: "diagnostic" }, collector.sink)
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({ kind: "authentication", status: 401, failClosed: true })
    expect(JSON.stringify(collector.events)).not.toContain(canary)
    expect(JSON.stringify(collector.events)).not.toContain("api-key-canary")
  })

  test("rejects an ineligible subscription model before network access", async () => {
    let called = false
    const driver = new ChatGptCodexDriver({
      credential: {
        kind: "chatgpt-subscription",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: 10_000,
      },
      now: () => 1_000,
      fetch: async () => {
        called = true
        return Response.json({})
      },
    })
    const error = await driver
      .smoke({ model: "gpt-5.5-pro", prompt: "diagnostic" }, () => {})
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({ kind: "eligibility", failClosed: true })
    expect(called).toBeFalse()
  })

  test("rejects unknown or invalid parameter mappings before network access", async () => {
    let calls = 0
    const driver = new OpenAiApiKeyDriver({
      apiKey: "api-key-canary",
      fetch: async () => {
        calls += 1
        return Response.json({})
      },
    })
    const unknown = await driver
      .smoke(
        {
          model: "gpt-api-fixture",
          prompt: "diagnostic",
          parameters: { provider_magic: true },
        },
        () => {},
      )
      .catch((cause: unknown) => cause)
    expect(unknown).toMatchObject({ kind: "invalid-input", failClosed: true })

    const invalid = await driver
      .smoke(
        {
          model: "gpt-api-fixture",
          prompt: "diagnostic",
          parameters: { top_p: 2 },
        },
        () => {},
      )
      .catch((cause: unknown) => cause)
    expect(invalid).toMatchObject({ kind: "invalid-input", failClosed: true })
    expect(calls).toBe(0)
  })

  test("rejects provider-unsafe names and recursively non-strict schemas before network access", async () => {
    let calls = 0
    const driver = new OpenAiApiKeyDriver({
      apiKey: "api-key-canary",
      fetch: async () => {
        calls += 1
        return Response.json({})
      },
    })
    const base = {
      model: "gpt-api-fixture",
      input: [{ type: "message" as const, role: "user" as const, content: "work" }],
      parameters: {},
    }
    const unsafeName = await driver
      .invoke(
        {
          ...base,
          tools: [
            {
              name: "fs.read",
              description: "read",
              strict: true,
              parameters: {
                type: "object",
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
          ],
        },
        () => {},
      )
      .catch((cause: unknown) => cause)
    expect(unsafeName).toMatchObject({ kind: "invalid-input", failClosed: true })

    const nestedOpenObject = await driver
      .invoke(
        {
          ...base,
          tools: [
            {
              name: "fs_read",
              description: "read",
              strict: true,
              parameters: {
                type: "object",
                properties: {
                  options: {
                    type: "object",
                    properties: { path: { type: "string" } },
                    required: [],
                    additionalProperties: true,
                  },
                },
                required: ["options"],
                additionalProperties: false,
              },
            },
          ],
        },
        () => {},
      )
      .catch((cause: unknown) => cause)
    expect(nestedOpenObject).toMatchObject({ kind: "invalid-input", failClosed: true })
    expect(String((nestedOpenObject as Error).message)).toContain("not closed")
    expect(calls).toBe(0)
  })
})
