import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  consumeOpenAiResponse,
  OPENAI_MAX_JSON_RESPONSE_BYTES,
  OPENAI_MAX_NORMALIZED_EVENTS,
  OPENAI_MAX_SSE_FRAME_BYTES,
  OPENAI_MAX_SSE_FRAMES,
  OPENAI_MAX_SSE_RESPONSE_BYTES,
  OPENAI_MAX_STRUCTURED_DEPTH,
  OPENAI_MAX_STRUCTURED_NODES,
  OpenAiDriverError,
  type OpenAiEvent,
  UsageAccumulator,
} from "../../packages/openai-driver/src"

const fixtures = resolve(import.meta.dir, "../fixtures/openai-driver")

function chunkedBody(value: string, widths: number[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let offset = 0
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= value.length) {
        controller.close()
        return
      }
      const width = widths[index % widths.length] ?? value.length
      controller.enqueue(encoder.encode(value.slice(offset, offset + width)))
      offset += width
      index += 1
    },
  })
}

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index]
      if (!chunk) {
        controller.close()
        return
      }
      controller.enqueue(chunk)
      index += 1
    },
  })
}

describe("OpenAI response normalization", () => {
  test("assembles streamed function arguments into one causal tool call", async () => {
    const stream = [
      {
        type: "response.output_item.added",
        sequence_number: 0,
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc-1",
          call_id: "call-1",
          name: "fs.read",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 1,
        item_id: "fc-1",
        output_index: 0,
        delta: '{"path":',
      },
      {
        type: "response.function_call_arguments.delta",
        sequence_number: 2,
        item_id: "fc-1",
        output_index: 0,
        delta: '"README.md"}',
      },
      {
        type: "response.function_call_arguments.done",
        sequence_number: 3,
        item_id: "fc-1",
        output_index: 0,
        arguments: '{"path":"README.md"}',
      },
      {
        type: "response.completed",
        sequence_number: 4,
        response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
    const events: OpenAiEvent[] = []

    const result = await consumeOpenAiResponse(
      new Response(chunkedBody(stream, [1, 3, 5, 2]), {
        headers: { "Content-Type": "text/event-stream" },
      }),
      (event) => {
        events.push(event)
      },
    )

    expect(events.filter((event) => event.type === "tool-input")).toEqual([
      expect.objectContaining({ toolCallId: "call-1", delta: '{"path":' }),
      expect.objectContaining({ toolCallId: "call-1", delta: '"README.md"}' }),
    ])
    expect(events.filter((event) => event.type === "tool-call")).toEqual([
      expect.objectContaining({
        call: {
          itemId: "fc-1",
          callId: "call-1",
          name: "fs.read",
          input: { path: "README.md" },
          argumentsJson: '{"path":"README.md"}',
        },
      }),
    ])
    expect(result).toMatchObject({
      finishReason: "tool-call",
      toolCalls: [{ callId: "call-1", name: "fs.read", input: { path: "README.md" } }],
      usage: { input: 10, output: 5, total: 15 },
    })
  })

  test("preserves opaque reasoning for a stateless tool continuation without exposing it", async () => {
    const encrypted = "opaque-reasoning-continuation-canary"
    const response = Response.json({
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs-1",
          encrypted_content: encrypted,
          summary: [{ type: "summary_text", text: "Safe summary" }],
        },
        {
          type: "function_call",
          id: "fc-1",
          call_id: "call-1",
          name: "ralph_fs_read_fixture",
          arguments: '{"path":"README.md"}',
        },
      ],
      usage: { input_tokens: 4, output_tokens: 2 },
    })
    const events: OpenAiEvent[] = []
    const result = await consumeOpenAiResponse(response, (event) => {
      events.push(event)
    })

    expect(result.reasoningItems).toEqual([
      {
        type: "reasoning",
        itemId: "rs-1",
        encryptedContent: encrypted,
        summary: [{ type: "summary_text", text: "Safe summary" }],
      },
    ])
    expect(JSON.stringify(events)).not.toContain(encrypted)
    expect(JSON.stringify(events)).toContain("[PRIVATE_REASONING_OMITTED]")
  })

  test("captures opaque reasoning from the streamed Responses path used by the driver", async () => {
    const encrypted = "opaque-streamed-reasoning-canary"
    const stream = [
      {
        type: "response.output_item.done",
        sequence_number: 0,
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs-stream-1",
          encrypted_content: encrypted,
          summary: [],
        },
      },
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc-stream-1",
          call_id: "call-stream-1",
          name: "ralph_fs_read_fixture",
          arguments: "",
        },
      },
      {
        type: "response.output_item.done",
        sequence_number: 2,
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc-stream-1",
          call_id: "call-stream-1",
          name: "ralph_fs_read_fixture",
          arguments: '{"path":"README.md"}',
        },
      },
      {
        type: "response.completed",
        sequence_number: 3,
        response: { status: "completed" },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
    const events: OpenAiEvent[] = []
    const result = await consumeOpenAiResponse(
      new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
      (event) => {
        events.push(event)
      },
    )

    expect(result.finishReason).toBe("tool-call")
    expect(result.reasoningItems).toEqual([
      {
        type: "reasoning",
        itemId: "rs-stream-1",
        encryptedContent: encrypted,
        summary: [],
      },
    ])
    expect(JSON.stringify(events)).not.toContain(encrypted)
  })

  test("fails closed when the provider duplicates a function call item", async () => {
    const added = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc-duplicate",
        call_id: "call-duplicate",
        name: "ralph_fs_read_fixture",
        arguments: "",
      },
    }
    const stream = [added, added].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    const error = await consumeOpenAiResponse(
      new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
      () => {},
    ).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(String((error as Error).message)).toContain("duplicated a function call item")
  })

  test("fails closed when streamed function arguments drift at completion", async () => {
    const stream = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc-1",
          call_id: "call-1",
          name: "fs.read",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc-1",
        output_index: 0,
        delta: '{"path":"safe.txt"}',
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc-1",
        output_index: 0,
        arguments: '{"path":"different.txt"}',
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
    const error = await consumeOpenAiResponse(
      new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
      () => {},
    ).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(String((error as Error).message)).toContain("do not match")
  })

  test("normalizes chunked SSE text, reasoning, finish, raw and cumulative usage", async () => {
    const golden = await Bun.file(resolve(fixtures, "chatgpt-sse.txt")).text()
    const events: OpenAiEvent[] = []
    const result = await consumeOpenAiResponse(
      new Response(chunkedBody(golden, [1, 2, 7, 13, 3]), {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      }),
      (event) => {
        events.push(event)
      },
    )

    expect(events.filter((event) => event.type === "text").map((event) => event.delta)).toEqual([
      "Hello ",
      "world",
    ])
    expect(
      events.filter((event) => event.type === "reasoning").map((event) => event.delta),
    ).toEqual(["Checked the fixture. "])
    expect(events.filter((event) => event.type === "raw")).toHaveLength(6)
    expect(events.at(-1)?.type).toBe("finish")
    const usage = events.filter((event) => event.type === "usage")
    expect(usage).toHaveLength(3)
    expect(usage[0]).toMatchObject({
      semantics: "cumulative",
      delta: { input: 10, output: 1, reasoning: 1, cacheRead: 3, total: 12 },
      aggregate: { input: 10, output: 1, reasoning: 1, cacheRead: 3, total: 12 },
    })
    expect(usage[1]).toMatchObject({
      semantics: "cumulative",
      delta: { input: 0, output: 1, reasoning: 1, cacheRead: 0, total: 2 },
      aggregate: { input: 10, output: 2, reasoning: 2, cacheRead: 3, total: 14 },
    })
    expect(usage[2]).toMatchObject({
      semantics: "final",
      delta: { input: 0, output: 0, reasoning: 0, cacheRead: 0, total: 0 },
      aggregate: { input: 10, output: 2, reasoning: 2, cacheRead: 3, total: 14 },
    })
    expect(events.filter((event) => event.type === "finish")).toEqual([
      expect.objectContaining({ reason: "stop" }),
    ])
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1))
    expect(result).toMatchObject({
      eventCount: events.length,
      finishReason: "stop",
      usage: { input: 10, output: 2, reasoning: 2, cacheRead: 3, total: 14 },
    })
  })

  test("normalizes a non-stream JSON response with the same event contract", async () => {
    const golden = await Bun.file(resolve(fixtures, "openai-json.json")).text()
    const events: OpenAiEvent[] = []
    const result = await consumeOpenAiResponse(
      new Response(golden, { headers: { "Content-Type": "application/json" } }),
      (event) => {
        events.push(event)
      },
    )

    expect(events.map((event) => event.type)).toEqual([
      "raw",
      "reasoning",
      "text",
      "usage",
      "finish",
    ])
    expect(events[1]).toMatchObject({ type: "reasoning", delta: "Reasoning summary" })
    expect(events[2]).toMatchObject({ type: "text", delta: "JSON response" })
    expect(result.usage).toMatchObject({
      input: 7,
      output: 4,
      reasoning: 1,
      cacheRead: 2,
      total: 12,
      source: "reported",
    })
  })

  test("projects only provider reasoning summaries and omits private reasoning from raw events", async () => {
    const privateCanary = "PRIVATE_CHAIN_OF_THOUGHT_CANARY"
    const stream = [
      {
        type: "response.reasoning_text.delta",
        sequence_number: 0,
        delta: privateCanary,
      },
      {
        type: "response.reasoning_summary_text.delta",
        sequence_number: 1,
        delta: "Safe provider summary",
      },
      { type: "response.completed", sequence_number: 2, response: { status: "completed" } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
    const events: OpenAiEvent[] = []
    const result = await consumeOpenAiResponse(
      new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
      (event) => {
        events.push(event)
      },
    )
    expect(result.finishReason).toBe("stop")
    expect(
      events.filter((event) => event.type === "reasoning").map((event) => event.delta),
    ).toEqual(["Safe provider summary"])
    expect(JSON.stringify(events)).not.toContain(privateCanary)
    expect(JSON.stringify(events)).toContain("[PRIVATE_REASONING_OMITTED]")

    const jsonEvents: OpenAiEvent[] = []
    await consumeOpenAiResponse(
      Response.json({
        status: "completed",
        output: [
          {
            type: "reasoning",
            content: [{ type: "reasoning_text", text: privateCanary }],
            summary: [{ type: "summary_text", text: "Safe JSON summary" }],
          },
        ],
      }),
      (event) => {
        jsonEvents.push(event)
      },
    )
    expect(JSON.stringify(jsonEvents)).not.toContain(privateCanary)
    expect(jsonEvents.find((event) => event.type === "reasoning")).toMatchObject({
      delta: "Safe JSON summary",
    })
  })

  test("redacts private reasoning from header-typed and terminal SSE raw payloads", async () => {
    const privateCanary = "PRIVATE_NESTED_SSE_REASONING_CANARY"
    const stream = [
      `event: response.reasoning_text.delta\nid: private-header\ndata: ${JSON.stringify({
        sequence_number: 0,
        delta: privateCanary,
      })}\n\n`,
      `data: ${JSON.stringify({
        type: "response.completed",
        sequence_number: 1,
        response: {
          status: "completed",
          output: [
            {
              type: "reasoning",
              encrypted_content: privateCanary,
              content: [{ type: "reasoning_text", text: privateCanary }],
              summary: [{ type: "summary_text", text: "Safe terminal summary" }],
            },
          ],
        },
      })}\n\n`,
    ].join("")
    const events: OpenAiEvent[] = []

    const result = await consumeOpenAiResponse(
      new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
      (event) => {
        events.push(event)
      },
    )

    expect(result.finishReason).toBe("stop")
    expect(JSON.stringify(events)).not.toContain(privateCanary)
    expect(JSON.stringify(events)).toContain("[PRIVATE_REASONING_OMITTED]")
    expect(events.some((event) => event.type === "reasoning")).toBeFalse()
  })

  test("redacts direct text and delta fields on JSON reasoning output items", async () => {
    const privateCanary = "PRIVATE_DIRECT_REASONING_CANARY"
    const events: OpenAiEvent[] = []
    await consumeOpenAiResponse(
      new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "reasoning", text: privateCanary, delta: privateCanary, summary: [] }],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
      (event) => {
        events.push(event)
      },
    )

    expect(JSON.stringify(events)).not.toContain(privateCanary)
    expect(events[0]).toMatchObject({
      type: "raw",
      data: {
        output: [
          {
            type: "reasoning",
            text: "[PRIVATE_REASONING_OMITTED]",
            delta: "[PRIVATE_REASONING_OMITTED]",
          },
        ],
      },
    })
  })

  test("derives missing totals and rejects decreasing cumulative snapshots", () => {
    const accumulator = new UsageAccumulator()
    expect(accumulator.apply({ input: 5, output: 2 }, "cumulative")).toMatchObject({
      delta: { input: 5, output: 2, total: 7, source: "derived" },
      aggregate: { input: 5, output: 2, total: 7, source: "derived" },
    })
    expect(accumulator.apply({ input: 5, output: 3 }, "cumulative")).toMatchObject({
      delta: { input: 0, output: 1, total: 1 },
      aggregate: { input: 5, output: 3, total: 8 },
    })
    expect(() => accumulator.apply({ input: 4, output: 3 }, "cumulative")).toThrow(
      "decreased within one model call",
    )
  })

  test("preserves a reported total when a later cumulative snapshot omits it", () => {
    const accumulator = new UsageAccumulator()
    expect(accumulator.apply({ input: 10, output: 2, total: 20 }, "cumulative")).toMatchObject({
      delta: { input: 10, output: 2, total: 20, source: "reported" },
      aggregate: { input: 10, output: 2, total: 20, source: "reported" },
    })
    const next = accumulator.apply({ input: 10, output: 3 }, "cumulative")
    expect(next).toMatchObject({
      delta: { input: 0, output: 1, source: "reported" },
      aggregate: { input: 10, output: 3, total: 20, source: "reported" },
    })
    expect(next?.delta.total).toBeUndefined()
    expect(accumulator.snapshot()).toEqual({
      input: 10,
      output: 3,
      total: 20,
      source: "reported",
    })

    expect(() => accumulator.apply({ input: 19, output: 3 }, "cumulative")).toThrow(
      "smaller than cumulative input and output",
    )

    const mixedProvenance = new UsageAccumulator()
    mixedProvenance.apply({ input: 2, output: 1 }, "cumulative")
    mixedProvenance.apply({ input: 1, output: 1, total: 2 }, "delta")
    expect(mixedProvenance.snapshot()).toEqual({
      input: 3,
      output: 2,
      total: 5,
      source: "derived",
    })
  })

  test("rejects token aggregate overflow even when each provider delta is individually safe", () => {
    const usage = new UsageAccumulator()
    usage.apply({ input: Number.MAX_SAFE_INTEGER }, "delta")
    expect(() => usage.apply({ input: 1 }, "delta")).toThrow("usage field input is invalid")

    const derived = new UsageAccumulator()
    expect(() => derived.apply({ input: Number.MAX_SAFE_INTEGER, output: 1 }, "delta")).toThrow(
      "usage field total is invalid",
    )
  })

  test("labels a completed response without usage as unavailable", async () => {
    const events: OpenAiEvent[] = []
    const result = await consumeOpenAiResponse(
      new Response(JSON.stringify({ status: "completed", output_text: "ok" }), {
        headers: { "Content-Type": "application/json" },
      }),
      (event) => {
        events.push(event)
      },
    )

    expect(result.usage).toEqual({ source: "unavailable" })
    expect(events.some((event) => event.type === "usage")).toBeFalse()
  })

  test("emits a bounded error event and fails when the provider reports failure", async () => {
    const secret = "provider-secret-canary"
    const stream = `data: ${JSON.stringify({
      type: "response.failed",
      response: { error: { code: "account_error", message: secret } },
    })}\n\n`
    const events: OpenAiEvent[] = []
    const error = await consumeOpenAiResponse(
      new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
      (event) => {
        events.push(event)
      },
    ).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(OpenAiDriverError)
    expect(error).toMatchObject({ kind: "provider", failClosed: true })
    const normalizedError = events.find((event) => event.type === "error")
    expect(normalizedError).toMatchObject({
      error: { kind: "provider", code: "account_error" },
    })
    expect(JSON.stringify(normalizedError)).not.toContain(secret)
    expect(events.find((event) => event.type === "raw")).toBeDefined()
  })

  test("rejects a stream that ends without a finish signal", async () => {
    const events: OpenAiEvent[] = []
    const error = await consumeOpenAiResponse(
      new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
      (event) => {
        events.push(event)
      },
    ).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(events.some((event) => event.type === "text")).toBeTrue()
  })

  test("preserves SSE and JSON provider event IDs without confusing the event name", async () => {
    const sseEvents: OpenAiEvent[] = []
    await consumeOpenAiResponse(
      new Response(
        'event: response.output_text.delta\nid: upstream-sse-1\ndata: {"type":"response.output_text.delta","id":"json-fallback","delta":"ok"}\n\nid: upstream-sse-2\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
      (event) => {
        sseEvents.push(event)
      },
    )
    const raw = sseEvents.find((event) => event.type === "raw")
    const text = sseEvents.find((event) => event.type === "text")
    const finish = sseEvents.find((event) => event.type === "finish")
    expect(raw).toMatchObject({
      providerEvent: "response.output_text.delta",
      providerEventId: "upstream-sse-1",
    })
    expect(text).toMatchObject({ providerEventId: "upstream-sse-1" })
    expect(finish).toMatchObject({ providerEventId: "upstream-sse-2", reason: "stop" })

    const jsonEvents: OpenAiEvent[] = []
    await consumeOpenAiResponse(
      Response.json({ id: "response-json-1", status: "completed", output_text: "ok" }),
      (event) => {
        jsonEvents.push(event)
      },
    )
    expect(jsonEvents.every((event) => event.providerEventId === "response-json-1")).toBeTrue()
  })

  test("normalizes public finish reasons from realistic incomplete details", async () => {
    const scenarios = [
      { body: { status: "completed" }, expected: "stop" },
      {
        body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        expected: "length",
      },
      {
        body: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
        expected: "content-filter",
      },
      {
        body: { status: "incomplete", incomplete_details: { reason: "provider_magic" } },
        expected: "unknown",
      },
      { body: { status: "incomplete" }, expected: "unknown" },
      { body: { status: "max_output_tokens" }, expected: "length" },
      { body: { status: "tool_calls" }, expected: "tool-call" },
      { body: { status: "content_filtered" }, expected: "content-filter" },
      { body: { status: "failed" }, expected: "error" },
      { body: { status: "canceled" }, expected: "cancelled" },
      { body: { status: "provider_magic" }, expected: "unknown" },
    ] as const
    for (const scenario of scenarios) {
      const result = await consumeOpenAiResponse(Response.json(scenario.body), () => {})
      expect(result.finishReason).toBe(scenario.expected)
    }

    const sseResult = await consumeOpenAiResponse(
      new Response(
        'data: {"type":"response.incomplete","sequence_number":0,"response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      ),
      () => {},
    )
    expect(sseResult.finishReason).toBe("content-filter")
  })

  test("rejects content and contradictory terminal events after stream settlement", async () => {
    const completed = {
      type: "response.completed",
      sequence_number: 0,
      response: { status: "completed" },
    }
    const afterFinish = [
      completed,
      { type: "response.output_text.delta", sequence_number: 1, delta: "AFTER_FINISH" },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
    const events: OpenAiEvent[] = []
    const contentError = await consumeOpenAiResponse(
      new Response(afterFinish, { headers: { "Content-Type": "text/event-stream" } }),
      (event) => {
        events.push(event)
      },
    ).catch((cause: unknown) => cause)
    expect(contentError).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(String((contentError as Error).message)).toContain("after its terminal event")
    expect(JSON.stringify(events)).not.toContain("AFTER_FINISH")

    const contradictory = [
      completed,
      {
        type: "response.incomplete",
        sequence_number: 1,
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
    const terminalError = await consumeOpenAiResponse(
      new Response(contradictory, { headers: { "Content-Type": "text/event-stream" } }),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(terminalError).toMatchObject({ kind: "protocol-drift", failClosed: true })
  })

  test("keeps the finish event terminal when the provider appends the SSE done sentinel", async () => {
    const events: OpenAiEvent[] = []
    const response = new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        sequence_number: 0,
        response: {},
      })}\n\ndata: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    )
    const result = await consumeOpenAiResponse(response, (event) => {
      events.push(event)
    })

    expect(result.finishReason).toBe("stop")
    expect(events.at(-1)?.type).toBe("finish")
    expect(events.filter((event) => event.type === "raw")).toHaveLength(1)
  })

  test("fails closed on invalid, duplicate or out-of-order provider sequence numbers", async () => {
    const outOfOrder = [
      { type: "response.output_text.delta", sequence_number: 2, delta: "partial" },
      { type: "response.completed", sequence_number: 1, response: { status: "completed" } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
    const outOfOrderEvents: OpenAiEvent[] = []
    const outOfOrderError = await consumeOpenAiResponse(
      new Response(outOfOrder, { headers: { "Content-Type": "text/event-stream" } }),
      (event) => {
        outOfOrderEvents.push(event)
      },
    ).catch((cause: unknown) => cause)
    expect(outOfOrderError).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(outOfOrderEvents.some((event) => event.type === "text")).toBeTrue()

    for (const sequence_number of [-1, 1.5, "1"]) {
      const error = await consumeOpenAiResponse(
        new Response(
          `data: ${JSON.stringify({ type: "response.completed", sequence_number })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        ),
        () => {},
      ).catch((cause: unknown) => cause)
      expect(error).toMatchObject({ kind: "protocol-drift", failClosed: true })
    }
  })

  test("rejects oversized or malformed JSON before normalization", async () => {
    const oversized = new Uint8Array(OPENAI_MAX_JSON_RESPONSE_BYTES + 1).fill(0x20)
    const tooLarge = await consumeOpenAiResponse(
      new Response(oversized, { headers: { "Content-Type": "application/json" } }),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(tooLarge).toMatchObject({ kind: "protocol-drift", failClosed: true })

    const invalidUtf8 = await consumeOpenAiResponse(
      new Response(Uint8Array.from([0xc3, 0x28]), {
        headers: { "Content-Type": "application/json" },
      }),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(invalidUtf8).toMatchObject({ kind: "protocol-drift", failClosed: true })

    const invalidJson = await consumeOpenAiResponse(
      new Response("{not-json", { headers: { "Content-Type": "application/json" } }),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(invalidJson).toMatchObject({ kind: "protocol-drift", failClosed: true })
  })

  test("enforces independent SSE frame and total byte limits", async () => {
    const encoder = new TextEncoder()
    const oversizedFrame = encoder.encode(`data: ${"x".repeat(OPENAI_MAX_SSE_FRAME_BYTES)}\n\n`)
    const frameError = await consumeOpenAiResponse(
      new Response(byteStream([oversizedFrame]), {
        headers: { "Content-Type": "text/event-stream" },
      }),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(frameError).toMatchObject({ kind: "protocol-drift", failClosed: true })

    const comment = encoder.encode(`:${"x".repeat(OPENAI_MAX_SSE_FRAME_BYTES - 3)}\n\n`)
    const count = Math.floor(OPENAI_MAX_SSE_RESPONSE_BYTES / comment.byteLength) + 2
    const totalError = await consumeOpenAiResponse(
      new Response(byteStream(Array.from({ length: count }, () => comment)), {
        headers: { "Content-Type": "text/event-stream" },
      }),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(totalError).toMatchObject({ kind: "protocol-drift", failClosed: true })
  })

  test("rejects invalid UTF-8 in SSE without replacement decoding", async () => {
    const error = await consumeOpenAiResponse(
      new Response(
        byteStream([Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xc3, 0x28])]),
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ kind: "protocol-drift", failClosed: true })
  })

  test("bounds JSON structure independently from response bytes", async () => {
    const nested =
      '{"x":'.repeat(OPENAI_MAX_STRUCTURED_DEPTH + 1) +
      '{"status":"completed"}' +
      "}".repeat(OPENAI_MAX_STRUCTURED_DEPTH + 1)
    expect(Buffer.byteLength(nested)).toBeLessThan(OPENAI_MAX_JSON_RESPONSE_BYTES)
    const depthError = await consumeOpenAiResponse(
      new Response(nested, { headers: { "Content-Type": "application/json" } }),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(depthError).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(String((depthError as Error).message)).toContain("structured depth")

    const entries = Array.from({ length: OPENAI_MAX_STRUCTURED_NODES + 1 }, () => '"x"').join(",")
    const wide = `{"status":"completed","output":[${entries}]}`
    expect(Buffer.byteLength(wide)).toBeLessThan(OPENAI_MAX_JSON_RESPONSE_BYTES)
    const nodeError = await consumeOpenAiResponse(
      new Response(wide, { headers: { "Content-Type": "application/json" } }),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(nodeError).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(String((nodeError as Error).message)).toContain("structured node count")
  })

  test("bounds SSE frame and normalized event counts", async () => {
    const frameError = await consumeOpenAiResponse(
      new Response(": keepalive\n\n".repeat(OPENAI_MAX_SSE_FRAMES + 1), {
        headers: { "Content-Type": "text/event-stream" },
      }),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(frameError).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(String((frameError as Error).message)).toContain("frame count")

    const textFrame = 'data: {"type":"response.output_text.delta","delta":"x"}\n\n'
    const framesForEventOverflow = Math.floor(OPENAI_MAX_NORMALIZED_EVENTS / 2) + 1
    expect(framesForEventOverflow).toBeLessThan(OPENAI_MAX_SSE_FRAMES)
    const eventError = await consumeOpenAiResponse(
      new Response(textFrame.repeat(framesForEventOverflow), {
        headers: { "Content-Type": "text/event-stream" },
      }),
      () => {},
    ).catch((cause: unknown) => cause)
    expect(eventError).toMatchObject({ kind: "protocol-drift", failClosed: true })
    expect(String((eventError as Error).message)).toContain("normalized event count")
  })
})
