import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import type { OpenAiEvent } from "@ralph/openai-driver"
import type { ProviderEvent } from "@ralph/providers"

import { OpenAiProviderStreamAdapter } from "../src/index"

function adapter(): OpenAiProviderStreamAdapter {
  return new OpenAiProviderStreamAdapter({
    callId: "call-1",
    rawRef: "raw:model/call-1.jsonl",
    secrets: ["super-secret"],
    now: () => Date.parse("2026-07-18T00:00:00.000Z"),
  })
}

describe("OpenAI provider stream adapter", () => {
  test("closes a failed partial stream and keeps its golden retry causally isolated", async () => {
    type GoldenAttempt = {
      callId: string
      rawRef: string
      source: OpenAiEvent[]
      failAfterSource?: string
      expected: {
        finishReason: "error" | "stop"
        text: string
        types: ProviderEvent["type"][]
      }
    }
    const golden = (await Bun.file(
      resolve(import.meta.dir, "../../../tests/fixtures/s05/provider-stream-retry.json"),
    ).json()) as { schemaVersion: 1; attempts: GoldenAttempt[] }

    expect(golden.schemaVersion).toBe(1)
    expect(golden.attempts).toHaveLength(2)
    const summaries = golden.attempts.map((attempt) => {
      const target = new OpenAiProviderStreamAdapter({
        callId: attempt.callId,
        rawRef: attempt.rawRef,
        now: () => Date.parse("2026-07-18T00:00:00.000Z"),
      })
      for (const event of attempt.source) target.accept(event)
      if (attempt.failAfterSource) target.fail(new Error(attempt.failAfterSource))
      const summary = target.summary()
      expect(summary.finishReason).toBe(attempt.expected.finishReason)
      expect(summary.text).toBe(attempt.expected.text)
      expect(summary.events.map((event) => event.type)).toEqual(attempt.expected.types)
      expect(summary.events.map((event) => event.callId)).toEqual(
        summary.events.map(() => attempt.callId),
      )
      expect(JSON.stringify(summary.events)).toContain(attempt.rawRef)
      return summary
    })

    expect(summaries[0]?.events.at(-1)?.sequence).toBe(5)
    expect(summaries[1]?.events[0]?.sequence).toBe(1)
    expect(JSON.stringify(summaries[1])).not.toContain("partial before retry")
    expect(JSON.stringify(summaries[1])).not.toContain("provider-attempt-1")
  })

  test("keeps upstream calls as requests and emits one closed causal stream", () => {
    const target = adapter()
    const source: OpenAiEvent[] = [
      {
        type: "raw",
        sequence: 0,
        providerEventId: "response-event-1",
        data: { private: "never copied" },
      },
      {
        type: "text",
        sequence: 1,
        providerEventId: "response-event-1",
        delta: "working super-secret",
      },
      {
        type: "tool-input",
        sequence: 2,
        providerEventId: "response-event-2",
        toolCallId: "tool-1",
        delta: '{"path":"README.md"}',
      },
      {
        type: "tool-call",
        sequence: 3,
        providerEventId: "response-event-2",
        call: {
          itemId: "item-1",
          callId: "tool-1",
          name: "fs.read",
          input: { path: "README.md", note: "super-secret" },
          argumentsJson: '{"path":"README.md","note":"super-secret"}',
        },
      },
      {
        type: "usage",
        sequence: 4,
        providerEventId: "response-event-3",
        semantics: "final",
        delta: { input: 4, output: 2, total: 6, source: "reported" },
        aggregate: { input: 4, output: 2, total: 6, source: "reported" },
      },
      {
        type: "finish",
        sequence: 5,
        providerEventId: "response-event-4",
        reason: "tool-call",
      },
    ]

    const emitted = source.flatMap((event) => target.accept(event))
    const summary = target.summary()

    expect(emitted.map((event) => event.type)).toEqual([
      "model.text.delta",
      "model.tool.input.delta",
      "model.tool.call",
      "model.provider.warning",
      "model.usage.updated",
      "model.text.completed",
      "model.call.finished",
    ])
    expect(summary.finishReason).toBe("tool-call")
    expect(summary.toolCalls).toHaveLength(1)
    expect(summary.toolCalls[0]?.input).toEqual({ path: "README.md", note: "super-secret" })
    expect(JSON.stringify(summary.events)).not.toContain("super-secret")
    expect(summary.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(
      summary.events.find((event) => event.type === "model.provider.warning")?.payload,
    ).toEqual({
      kind: "pricing-unavailable",
      code: "RALPH_MODEL_COST_UNAVAILABLE",
      message: "no immutable price snapshot was configured",
      rawRef: "raw:model/call-1.jsonl",
    })
    expect(summary.events[0]?.providerEventId).toBe("response-event-1")
  })

  test("redacts a secret split across text, reasoning, and tool-input deltas", () => {
    const target = adapter()
    const emitted = [
      target.accept({ type: "text", sequence: 1, delta: "visible super-" }),
      target.accept({ type: "text", sequence: 2, delta: "secret text" }),
      target.accept({ type: "reasoning", sequence: 3, delta: "analysis super-" }),
      target.accept({ type: "reasoning", sequence: 4, delta: "secret reason" }),
      target.accept({
        type: "tool-input",
        sequence: 5,
        toolCallId: "tool-1",
        delta: '{"note":"super-',
      }),
      target.accept({
        type: "tool-input",
        sequence: 6,
        toolCallId: "tool-1",
        delta: 'secret"}',
      }),
      target.accept({
        type: "tool-call",
        sequence: 7,
        call: {
          itemId: "item-1",
          callId: "tool-1",
          name: "fs.read",
          input: { path: "README.md", note: "super-secret" },
          argumentsJson: '{"path":"README.md","note":"super-secret"}',
        },
      }),
      target.accept({ type: "finish", sequence: 8, reason: "tool-call" }),
    ].flat()

    const summary = target.summary()
    expect(summary.text).toBe("visible [REDACTED] text")
    expect(summary.reasoningSummary).toBe("analysis [REDACTED] reason")
    expect(summary.toolCalls[0]?.input).toEqual({ path: "README.md", note: "super-secret" })
    expect(JSON.stringify(emitted)).not.toContain("super-")
    expect(JSON.stringify(emitted)).not.toContain('"secret')
    expect(JSON.stringify(summary.events)).not.toContain("super-secret")
    expect(
      summary.events
        .filter((event) => event.type === "model.tool.input.delta")
        .map((event) => String(event.payload.delta))
        .join(""),
    ).toBe('{"note":"[REDACTED]"}')
  })

  test("fails closed on duplicate source order and duplicate tool calls", () => {
    const ordered = adapter()
    ordered.accept({ type: "text", sequence: 1, delta: "a" })
    expect(() => ordered.accept({ type: "text", sequence: 1, delta: "b" })).toThrow(
      "duplicated or out of order",
    )

    const calls = adapter()
    const call = {
      itemId: "item-1",
      callId: "tool-1",
      name: "fs.read",
      input: { path: "README.md" },
      argumentsJson: '{"path":"README.md"}',
    } as const
    calls.accept({ type: "tool-call", sequence: 1, call })
    expect(() =>
      calls.accept({ type: "tool-call", sequence: 2, call: { ...call, itemId: "item-2" } }),
    ).toThrow("duplicated a tool call")
  })

  test("does not duplicate a provider error when the transport rejects afterward", () => {
    const target = adapter()
    target.accept({
      type: "error",
      sequence: 1,
      providerEventId: "error-1",
      error: { kind: "provider", message: "upstream failed" },
    })
    target.fail(new Error("transport rejected"))

    const errors = target.summary().events.filter((event) => event.type === "model.provider.error")
    expect(errors).toHaveLength(1)
    expect(target.summary().finishReason).toBe("error")
  })
})
