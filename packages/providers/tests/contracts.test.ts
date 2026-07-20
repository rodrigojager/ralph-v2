import { describe, expect, test } from "bun:test"

import {
  CatalogSeedSchema,
  CredentialRefSchema,
  CURATED_CATALOG_SEED,
  PriceSnapshotSchema,
  type ProviderDriver,
  type ProviderEvent,
  ProviderEventSchema,
  ProviderEventTypeSchema,
  ProviderModelInputSchema,
  ProviderModelRequestSchema,
  ProviderModelResultSchema,
  ProviderToolDefinitionSchema,
  RoleProfileSchema,
  TokenUsageSchema,
} from "../src/index"
import { validateProviderDriverContract } from "../src/registry"
import { fakeProviderDriver, NO_REQUIREMENTS } from "./fixtures"

describe("provider contracts", () => {
  test("the curated seed is strict and internally valid", () => {
    expect(CatalogSeedSchema.parse(CURATED_CATALOG_SEED).providers).toHaveLength(3)
    expect(CatalogSeedSchema.parse(CURATED_CATALOG_SEED).models).toHaveLength(9)
    expect(() =>
      CatalogSeedSchema.parse({ ...CURATED_CATALOG_SEED, orchestrationState: "forbidden" }),
    ).toThrow()
  })

  test("claims runtime availability only for providers with an audited S04 model driver", () => {
    expect(
      CURATED_CATALOG_SEED.providers.find((provider) => provider.id === "openai")?.status,
    ).toBe("available")
    expect(
      CURATED_CATALOG_SEED.providers.find((provider) => provider.id === "anthropic")?.status,
    ).toBe("unknown")
    expect(
      CURATED_CATALOG_SEED.providers.find((provider) => provider.id === "openrouter")?.status,
    ).toBe("available")
  })

  test("a role profile cannot reference a credential from another provider", () => {
    expect(() =>
      RoleProfileSchema.parse({
        id: "executor-main",
        role: "executor",
        backend: "embedded",
        provider: "openai",
        model: "gpt-5.3-codex",
        credential: {
          id: "anthropic-main",
          provider: "anthropic",
          method: "api-key",
          store: "os-keychain",
          locator: "credential/anthropic-main",
          label: "Anthropic main",
        },
        parameters: {},
        requirements: NO_REQUIREMENTS,
        fallbackProfiles: [],
        limits: {},
      }),
    ).toThrow("Credential provider must match")
  })

  test("credential references cannot contain an inline secret", () => {
    expect(() =>
      CredentialRefSchema.parse({
        id: "openai-main",
        provider: "openai",
        method: "api-key",
        store: "os-keychain",
        locator: "credential/openai-main",
        label: "OpenAI main",
        secret: "must-not-be-stored",
      }),
    ).toThrow()
  })

  test("unavailable usage and pricing cannot pretend to contain measurements", () => {
    expect(() =>
      TokenUsageSchema.parse({
        input: 100,
        source: "unavailable",
        semantics: "final",
      }),
    ).toThrow("Unavailable usage")
    expect(() =>
      PriceSnapshotSchema.parse({
        id: "unknown-price",
        status: "unavailable",
        source: "provider",
        capturedAt: "2026-07-18T00:00:00.000Z",
        appliesTo: ["api"],
        reason: "Provider did not report pricing",
        input: 1,
      }),
    ).toThrow("Unavailable pricing")
  })

  test("provider counters enforce their public safe integer bounds", () => {
    expect(TokenUsageSchema.parse({ input: 0, source: "reported", semantics: "final" }).input).toBe(
      0,
    )
    expect(() =>
      TokenUsageSchema.parse({ input: -1, source: "reported", semantics: "final" }),
    ).toThrow()
    expect(() =>
      TokenUsageSchema.parse({
        input: Number.MAX_SAFE_INTEGER + 1,
        source: "reported",
        semantics: "final",
      }),
    ).toThrow()

    const request = {
      schemaVersion: 1,
      callId: "call-bounds",
      model: { provider: "openai", model: "gpt-5.3-codex" },
      messages: [{ role: "user", content: "Bounded request" }],
      parameters: {},
      responseFormat: "text",
    } as const
    expect(
      ProviderModelRequestSchema.parse({ ...request, maxOutputTokens: 1 }).maxOutputTokens,
    ).toBe(1)
    expect(() => ProviderModelRequestSchema.parse({ ...request, maxOutputTokens: 0 })).toThrow()
    expect(() =>
      ProviderModelRequestSchema.parse({
        ...request,
        maxOutputTokens: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow()
  })

  test("normalizes ordered messages, function calls, outputs and strict tool definitions", () => {
    const tool = ProviderToolDefinitionSchema.parse({
      name: "fs.read",
      description: "Read one bounded workspace file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    })
    const input = [
      { type: "message", role: "user", content: "Read README.md" },
      {
        type: "function-call",
        itemId: "item-1",
        callId: "tool-call-1",
        name: "fs.read",
        argumentsJson: '{"path":"README.md"}',
        input: { path: "README.md" },
      },
      { type: "function-call-output", callId: "tool-call-1", output: "bounded output" },
    ] as const
    expect(input.map((item) => ProviderModelInputSchema.parse(item).type)).toEqual([
      "message",
      "function-call",
      "function-call-output",
    ])
    const request = ProviderModelRequestSchema.parse({
      schemaVersion: 1,
      callId: "call-tools",
      model: { provider: "openai", model: "gpt-5.3-codex" },
      input,
      tools: [tool],
      parameters: {},
      responseFormat: "text",
    })
    expect(request.tools).toEqual([tool])
    expect(
      ProviderModelRequestSchema.parse({
        ...request,
        responseFormat: "json",
        responseSchema: {
          name: "judge_output_v1",
          schema: {
            type: "object",
            properties: { score: { type: "integer", minimum: 0, maximum: 100 } },
            required: ["score"],
            additionalProperties: false,
          },
          strict: true,
        },
      }).responseSchema?.name,
    ).toBe("judge_output_v1")
    expect(() =>
      ProviderModelRequestSchema.parse({
        ...request,
        responseSchema: {
          name: "judge_output_v1",
          schema: { type: "object", additionalProperties: false },
          strict: true,
        },
      }),
    ).toThrow("responseFormat=json")
    expect(() =>
      ProviderModelRequestSchema.parse({
        ...request,
        messages: [{ role: "user", content: "ambiguous" }],
      }),
    ).toThrow("exactly one")
    expect(() =>
      ProviderToolDefinitionSchema.parse({
        ...tool,
        inputSchema: { type: "object", additionalProperties: true },
      }),
    ).toThrow("additionalProperties=false")
  })

  test("accepts multiline model context while rejecting unsafe terminal controls", () => {
    const multiline = ProviderModelInputSchema.parse({
      type: "message",
      role: "user",
      content: "Canonical context:\n\t- bounded task\r\n\t- deterministic evidence",
    })
    expect(multiline).toMatchObject({ type: "message" })
    if (multiline.type !== "message") throw new Error("Expected a model message")
    expect(multiline.content).toContain("\n")
    expect(() =>
      ProviderModelInputSchema.parse({
        type: "message",
        role: "user",
        content: "unsafe\u001b[2Jterminal sequence",
      }),
    ).toThrow("unsafe terminal control")
  })

  test("exposes coherent tool calls only with a tool-call finish reason", () => {
    const toolCall = {
      itemId: "item-1",
      callId: "tool-call-1",
      name: "fs.read",
      argumentsJson: '{"path":"README.md"}',
      input: { path: "README.md" },
    }
    const result = ProviderModelResultSchema.parse({
      schemaVersion: 1,
      callId: "call-tools",
      status: "succeeded",
      finishReason: "tool-call",
      usage: { source: "unavailable", semantics: "final" },
      toolCalls: [toolCall],
    })
    expect(result.toolCalls).toEqual([toolCall])
    expect(() => ProviderModelResultSchema.parse({ ...result, finishReason: "stop" })).toThrow(
      "finishReason=tool-call",
    )
    expect(() => ProviderModelResultSchema.parse({ ...result, toolCalls: [] })).toThrow(
      "at least one",
    )
  })

  test("provider event payloads are closed and discriminated by event type", () => {
    const envelope = {
      schemaVersion: 1,
      eventId: "event-contract",
      callId: "call-contract",
      sequence: 0,
      timestamp: "2026-07-18T00:00:00.000Z",
      level: "info",
      synthesized: false,
    } as const
    const rawRef = "raw:model/call-contract.jsonl"
    const catalogSnapshotId = `catalog:${"0".repeat(64)}`
    const catalogSource = {
      id: "opencode-curated",
      kind: "curated",
      revision: "pinned-revision",
    } as const
    const variants = [
      { type: "model.text.delta", payload: { delta: "d", rawRef } },
      { type: "model.text.completed", payload: { text: "done", rawRef } },
      { type: "model.reasoning.delta", payload: { delta: "r", rawRef } },
      { type: "model.reasoning.completed", payload: { summary: "safe summary", rawRef } },
      {
        type: "model.tool.input.delta",
        payload: { toolCallId: "tool-call-1", delta: '{"path":', rawRef },
      },
      {
        type: "model.tool.call",
        payload: {
          toolCallId: "tool-call-1",
          name: "fs.read",
          input: { path: "README.md" },
          rawRef,
        },
      },
      {
        type: "model.provider.warning",
        payload: { kind: "deprecation", message: "Provider warning", code: "warning", rawRef },
      },
      {
        type: "model.provider.error",
        payload: { kind: "rate-limit", message: "Rate limited", code: "rate_limit", rawRef },
      },
      {
        type: "model.usage.updated",
        payload: {
          usage: {
            input: 2,
            output: 1,
            total: 3,
            source: "reported",
            semantics: "delta",
            providerRawRef: rawRef,
          },
        },
      },
      {
        type: "model.call.finished",
        payload: {
          finishReason: "stop",
          rawRef,
          catalogSnapshotId,
          catalogOrigin: "source",
          catalogStale: false,
          catalogSource,
        },
      },
    ] as const

    expect(
      variants.map((variant) => ProviderEventSchema.parse({ ...envelope, ...variant }).type),
    ).toEqual(variants.map((variant) => variant.type))
    expect(variants.map((variant) => variant.type)).toEqual(ProviderEventTypeSchema.options)
    expect(
      ProviderEventSchema.parse({
        ...envelope,
        type: "model.text.completed",
        payload: { text: "raw capture is optional" },
      }).payload,
    ).toEqual({ text: "raw capture is optional" })
    expect(() =>
      ProviderEventSchema.parse({
        ...envelope,
        type: "model.provider.error",
        payload: {},
      }),
    ).toThrow()
    expect(() =>
      ProviderEventSchema.parse({
        ...envelope,
        type: "model.text.delta",
        payload: { delta: "d", rawRef, message: "belongs to a different event" },
      }),
    ).toThrow()
    expect(() =>
      ProviderEventSchema.parse({
        ...envelope,
        type: "model.call.finished",
        payload: { finishReason: "stop", catalogSnapshotId },
      }),
    ).toThrow()
  })

  test("a fake driver satisfies the port and emits normalized events and usage", async () => {
    const base = fakeProviderDriver()
    const events: ProviderEvent[] = []
    const driver: ProviderDriver = {
      ...base,
      async invoke(requestInput, sink) {
        const request = ProviderModelRequestSchema.parse(requestInput)
        const event = ProviderEventSchema.parse({
          schemaVersion: 1,
          eventId: "event-1",
          providerEventId: "upstream-1",
          callId: request.callId,
          sequence: 0,
          timestamp: "2026-07-18T00:00:00.000Z",
          type: "model.text.completed",
          level: "info",
          synthesized: false,
          payload: { text: "done", rawRef: "raw:model/call-1.jsonl" },
        })
        events.push(event)
        await sink.emit(event)
        return ProviderModelResultSchema.parse({
          schemaVersion: 1,
          callId: request.callId,
          status: "succeeded",
          finishReason: "stop",
          text: "done",
          usage: {
            input: 5,
            output: 1,
            total: 6,
            source: "reported",
            semantics: "final",
          },
        })
      },
    }
    validateProviderDriverContract(driver, "openai")

    const request = ProviderModelRequestSchema.parse({
      schemaVersion: 1,
      callId: "call-1",
      model: { provider: "openai", model: "gpt-5.3-codex" },
      messages: [{ role: "user", content: "Implement the slice" }],
      parameters: {},
      responseFormat: "text",
    })
    const result = await driver.invoke(request, { emit: () => {} })

    expect(events.map((event) => event.type)).toEqual(["model.text.completed"])
    expect(result.usage).toEqual({
      input: 5,
      output: 1,
      total: 6,
      source: "reported",
      semantics: "final",
    })
  })
})
