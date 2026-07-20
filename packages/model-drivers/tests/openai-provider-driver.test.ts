import { describe, expect, test } from "bun:test"

import type {
  OpenAiEventSink,
  OpenAiModelRequest,
  ResponseConsumption,
} from "@ralph-next/openai-driver"
import { CURATED_CATALOG_SEED, type ProviderEvent } from "@ralph-next/providers"

import {
  type OpenAiInvokerLease,
  type OpenAiModelInvoker,
  OpenAiProviderDriver,
  type RawModelCaptureFactory,
} from "../src/index"

function fixture(options: { fail?: boolean; fragmented?: boolean; continuation?: boolean } = {}) {
  const requests: OpenAiModelRequest[] = []
  const raw: unknown[] = []
  const closed: Array<{ status: string; error?: string }> = []
  const invoker: OpenAiModelInvoker = {
    async invoke(request: OpenAiModelRequest, sink: OpenAiEventSink): Promise<ResponseConsumption> {
      requests.push(request)
      if (options.continuation && requests.length === 2) {
        await sink({
          type: "text",
          sequence: 1,
          delta:
            '{"status":"work_submitted","summary":"done","intendedFiles":[],"artifactRefs":[],"suggestedVerifications":[],"risks":[]}',
        })
        await sink({ type: "finish", sequence: 2, reason: "stop" })
        return {
          eventCount: 2,
          finishReason: "stop",
          usage: { source: "unavailable" },
          toolCalls: [],
          reasoningItems: [],
        }
      }
      if (options.fragmented) {
        await sink({
          type: "raw",
          sequence: 1,
          providerEventId: "provider-1",
          data: { type: "response.output_text.delta", delta: "super-" },
        })
        await sink({
          type: "text",
          sequence: 2,
          providerEventId: "provider-1",
          delta: "super-",
        })
        await sink({
          type: "raw",
          sequence: 3,
          providerEventId: "provider-2",
          data: { type: "response.output_text.delta", delta: "secret" },
        })
        await sink({
          type: "text",
          sequence: 4,
          providerEventId: "provider-2",
          delta: "secret",
        })
        await sink({ type: "finish", sequence: 5, reason: "stop" })
        return {
          eventCount: 5,
          finishReason: "stop",
          usage: { source: "unavailable" },
          toolCalls: [],
          reasoningItems: [],
        }
      }
      await sink({
        type: "raw",
        sequence: 1,
        providerEventId: "provider-1",
        data: { delta: "credential-secret" },
      })
      if (options.fail) throw new Error("transport exposed credential-secret")
      await sink({
        type: "tool-call",
        sequence: 2,
        providerEventId: "provider-1",
        call: {
          itemId: "item-1",
          callId: "tool-1",
          name: request.tools[0]?.name ?? "missing-tool",
          input: { path: "README.md" },
          argumentsJson: '{"path":"README.md"}',
        },
      })
      await sink({
        type: "usage",
        sequence: 3,
        semantics: "delta",
        delta: { input: 3, output: 1, total: 4, source: "reported" },
        aggregate: { input: 3, output: 1, total: 4, source: "reported" },
      })
      await sink({ type: "finish", sequence: 4, reason: "tool-call" })
      return {
        eventCount: 4,
        finishReason: "tool-call",
        usage: { input: 3, output: 1, total: 4, source: "reported" },
        toolCalls: [],
        reasoningItems: options.continuation
          ? [
              {
                type: "reasoning",
                itemId: "reasoning-1",
                encryptedContent: "opaque-reasoning-continuation",
                summary: [],
              },
            ]
          : [],
      }
    },
  }
  const lease: OpenAiInvokerLease = {
    async withInvoker<T>(
      consumer: (value: OpenAiModelInvoker, secrets: readonly string[]) => Promise<T>,
    ) {
      return consumer(invoker, [options.fragmented ? "super-secret" : "credential-secret"])
    },
  }
  const capture: RawModelCaptureFactory = {
    async open() {
      return {
        ref: "raw:model/call-1.jsonl",
        append(event) {
          raw.push(event)
        },
        close(result) {
          closed.push(result)
        },
      }
    },
  }
  const provider = CURATED_CATALOG_SEED.providers.find((candidate) => candidate.id === "openai")
  const model = CURATED_CATALOG_SEED.models.find(
    (candidate) => candidate.provider === "openai" && candidate.capabilities.tools,
  )
  if (!provider || !model) throw new Error("OpenAI curated fixture is missing")
  return {
    driver: new OpenAiProviderDriver({
      provider,
      models: [model],
      lease,
      raw: capture,
      now: () => Date.parse("2026-07-18T00:00:00.000Z"),
    }),
    model,
    requests,
    raw,
    closed,
  }
}

describe("OpenAI provider driver", () => {
  test("maps strict tools and returns provider calls without executing them", async () => {
    const target = fixture()
    const events: ProviderEvent[] = []
    const result = await target.driver.invoke(
      {
        schemaVersion: 1,
        callId: "call-1",
        model: { provider: "openai", model: target.model.id },
        input: [
          { type: "message", role: "system", content: "Obey Ralph policy" },
          { type: "message", role: "user", content: "Inspect the workspace" },
        ],
        tools: [
          {
            name: "fs.read",
            description: "Read one bounded workspace file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            },
          },
        ],
        parameters: {},
        responseFormat: "text",
      },
      {
        emit: (event) => {
          events.push(event)
        },
      },
    )

    expect(target.requests[0]?.instructions).toBe("Obey Ralph policy")
    expect(target.requests[0]?.tools[0]).toMatchObject({ strict: true })
    expect(target.requests[0]?.tools[0]?.name).toMatch(/^ralph_fs_read_[a-f0-9]{12}$/)
    expect(result.finishReason).toBe("tool-call")
    expect(result.toolCalls[0]).toMatchObject({ callId: "tool-1", name: "fs.read" })
    expect(result.toolCalls[0]?.input).toEqual({ path: "README.md" })
    expect(result.usage).toMatchObject({ input: 3, output: 1, total: 4, semantics: "final" })
    expect(events.some((event) => event.type === "model.tool.call")).toBeTrue()
    expect(JSON.stringify(events)).not.toContain("credential-secret")
    expect(JSON.stringify(target.raw)).not.toContain("credential-secret")
    expect(target.closed).toEqual([{ status: "succeeded" }])
  })

  test("does not persist a known secret split between provider chunks", async () => {
    const target = fixture({ fragmented: true })
    const events: ProviderEvent[] = []
    const result = await target.driver.invoke(
      {
        schemaVersion: 1,
        callId: "call-1",
        model: { provider: "openai", model: target.model.id },
        messages: [{ role: "user", content: "work" }],
        tools: [],
        parameters: {},
        responseFormat: "text",
      },
      {
        emit: (event) => {
          events.push(event)
        },
      },
    )

    expect(result.text).toBe("[REDACTED]")
    expect(JSON.stringify(events)).not.toContain("super-secret")
    expect(JSON.stringify(target.raw)).not.toContain("super-secret")
    expect(JSON.stringify(target.raw)).not.toContain("super-")
    expect(JSON.stringify(target.raw)).not.toContain('"secret"')
    expect(target.closed).toEqual([{ status: "succeeded" }])
  })

  test("redacts transport failure and emits exactly one provider error", async () => {
    const target = fixture({ fail: true })
    const events: ProviderEvent[] = []
    const error = await target.driver
      .invoke(
        {
          schemaVersion: 1,
          callId: "call-1",
          model: { provider: "openai", model: target.model.id },
          messages: [{ role: "user", content: "work" }],
          tools: [],
          parameters: {},
          responseFormat: "text",
        },
        {
          emit: (event) => {
            events.push(event)
          },
        },
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).toBe("transport exposed [REDACTED]")
    expect(String((error as Error).message)).not.toContain("credential-secret")
    expect(events.filter((event) => event.type === "model.provider.error")).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain("credential-secret")
    expect(target.closed[0]).toEqual({ status: "failed", error: "transport exposed [REDACTED]" })
  })

  test("settles raw capture even when the normalized event sink fails", async () => {
    const target = fixture()
    const error = await target.driver
      .invoke(
        {
          schemaVersion: 1,
          callId: "call-1",
          model: { provider: "openai", model: target.model.id },
          messages: [{ role: "user", content: "work" }],
          tools: [
            {
              name: "fs.read",
              description: "read",
              inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
                additionalProperties: false,
              },
            },
          ],
          parameters: {},
          responseFormat: "text",
        },
        { emit: () => Promise.reject(new Error("observer failed")) },
      )
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(Error)
    expect(target.closed).toEqual([{ status: "failed", error: "observer failed" }])
  })

  test("replays opaque reasoning before a stateless function result and uses structured outcome JSON", async () => {
    const target = fixture({ continuation: true })
    const tool = {
      name: "fs.read",
      description: "read",
      inputSchema: {
        type: "object" as const,
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false as const,
      },
    }
    const responseSchema = {
      name: "ralph_executor_outcome",
      strict: true as const,
      schema: {
        type: "object",
        properties: {
          status: { type: "string" },
          summary: { type: "string" },
          intendedFiles: { type: "array", items: { type: "string" } },
          artifactRefs: { type: "array", items: { type: "string" } },
          suggestedVerifications: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
        },
        required: [
          "status",
          "summary",
          "intendedFiles",
          "artifactRefs",
          "suggestedVerifications",
          "risks",
        ],
        additionalProperties: false as const,
      },
    }
    const first = await target.driver.invoke(
      {
        schemaVersion: 1,
        callId: "call-1",
        model: { provider: "openai", model: target.model.id },
        messages: [{ role: "user", content: "read" }],
        tools: [tool],
        parameters: {},
        responseFormat: "json",
        responseSchema,
      },
      { emit: () => {} },
    )
    const call = first.toolCalls[0]
    if (!call) throw new Error("Expected the first tool call")
    const second = await target.driver.invoke(
      {
        schemaVersion: 1,
        callId: "call-2",
        model: { provider: "openai", model: target.model.id },
        input: [
          { type: "message", role: "user", content: "read" },
          { type: "function-call", ...call },
          { type: "function-call-output", callId: call.callId, output: '{"outcome":"success"}' },
        ],
        tools: [tool],
        parameters: {},
        responseFormat: "json",
        responseSchema,
      },
      { emit: () => {} },
    )

    expect(second.finishReason).toBe("stop")
    expect(target.requests[1]?.input).toEqual([
      { type: "message", role: "user", content: "read" },
      {
        type: "reasoning",
        itemId: "reasoning-1",
        encryptedContent: "opaque-reasoning-continuation",
        summary: [],
      },
      expect.objectContaining({
        type: "function_call",
        itemId: "item-1",
        callId: "tool-1",
        name: expect.stringMatching(/^ralph_fs_read_/),
      }),
      { type: "function_call_output", callId: "tool-1", output: '{"outcome":"success"}' },
    ])
    expect(target.requests[1]?.textFormat).toMatchObject({
      type: "json_schema",
      name: "ralph_executor_outcome",
      strict: true,
      schema: {
        type: "object",
        required: [
          "status",
          "summary",
          "intendedFiles",
          "artifactRefs",
          "suggestedVerifications",
          "risks",
        ],
        additionalProperties: false,
      },
    })
  })
})
