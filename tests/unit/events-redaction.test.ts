import { describe, expect, test } from "bun:test"
import type { CommandResult } from "@ralph-next/domain"
import {
  type EventEnvelope,
  EventEnvelopeConsumerSchema,
  EventEnvelopeSchema,
  REDACTED,
  redactText,
  redactValue,
  replayWorkspaceEvents,
  secretValuesFromEnvironment,
  serializeCommandResult,
  serializeEventEnvelopes,
} from "@ralph-next/telemetry"

function event(sequence: number, type = "workspace.initialized"): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    monotonicMs: sequence,
    type,
    scope: "workspace",
    streamId: "workspace:workspace-1",
    workspaceId: "workspace-1",
    level: "info",
    payload: {},
  }
}

describe("event envelope and replay", () => {
  test("replays an empty and initialized workspace deterministically", () => {
    expect(replayWorkspaceEvents([])).toEqual({
      initialized: false,
      eventCursor: 0,
      eventCount: 0,
    })
    expect(replayWorkspaceEvents([event(1), event(2, "workspace.inspected")])).toEqual({
      initialized: true,
      initializedAt: "2026-01-01T00:00:01.000Z",
      eventCursor: 2,
      eventCount: 2,
      lastEventType: "workspace.inspected",
    })
  })

  test("requires runId for run-scoped events and strictly increasing sequences", () => {
    const invalidRun = { ...event(1), scope: "run", streamId: "run:one" }
    expect(EventEnvelopeSchema.safeParse(invalidRun).success).toBeFalse()
    expect(() => replayWorkspaceEvents([event(1), event(1, "duplicate")])).toThrow(
      "Event sequence must be strictly increasing",
    )
  })

  test("producers reject but consumers preserve additive schema-v1 fields", () => {
    const future = { ...event(1), futureField: { supportedLater: true } }
    expect(EventEnvelopeSchema.safeParse(future).success).toBeFalse()
    expect(EventEnvelopeConsumerSchema.parse(future)).toMatchObject({
      futureField: { supportedLater: true },
    })
    expect(() => replayWorkspaceEvents([future])).not.toThrow()

    const unknownMajor = { ...event(2), schemaVersion: 2 }
    expect(EventEnvelopeSchema.safeParse(unknownMajor).success).toBeFalse()
    expect(EventEnvelopeConsumerSchema.safeParse(unknownMajor).success).toBeFalse()
    expect(() => replayWorkspaceEvents([unknownMajor as never])).toThrow()
  })
})

describe("redaction", () => {
  test("discovers secret environment values without collecting benign values", () => {
    expect(
      secretValuesFromEnvironment({
        OPENROUTER_API_KEY: "api-canary-1234",
        ACCESS_TOKEN: "token-canary-5678",
        GITHUB_TOKEN: "github-token-canary-9012",
        PATH: "not-a-secret",
        PASSWORD: "abc",
      }),
    ).toEqual(["github-token-canary-9012", "token-canary-5678", "api-canary-1234"])
  })

  test("redacts secret keys, known values, bearer headers, URLs and cycles", () => {
    const cyclic: Record<string, unknown> = {
      authorization: "Bearer should-never-appear",
      nested: {
        note: "token api-canary-1234 and Bearer bearer-canary-4321",
        url: "https://example.test/callback?token=url-canary&ok=1",
      },
    }
    cyclic.self = cyclic

    const safe = redactValue(cyclic, ["api-canary-1234"]) as Record<string, unknown>
    expect(safe.authorization).toBe(REDACTED)
    expect(JSON.stringify(safe)).not.toContain("api-canary-1234")
    expect(JSON.stringify(safe)).not.toContain("bearer-canary-4321")
    expect(JSON.stringify(safe)).not.toContain("url-canary")
    expect(safe.self).toBe("[CIRCULAR]")
    expect(redactText("Authorization: Bearer abc.def", [])).toBe(
      `Authorization: Bearer ${REDACTED}`,
    )
  })

  test("preserves repeated shared values while still rejecting active traversal cycles", () => {
    const shared = { message: "shared api-canary-1234", apiKey: "must-not-survive" }
    const cyclic: Record<string, unknown> = { left: shared, right: shared }
    cyclic.self = cyclic

    const safe = redactValue(cyclic, ["api-canary-1234"]) as Record<string, unknown>
    expect(safe.left).toEqual({ message: `shared ${REDACTED}`, apiKey: REDACTED })
    expect(safe.right).toEqual({ message: `shared ${REDACTED}`, apiKey: REDACTED })
    expect(safe.self).toBe("[CIRCULAR]")
  })

  test("preserves credential references and advertised methods while redacting secret material", () => {
    const safe = redactValue({
      credential: "chatgpt-main",
      credentials: [{ id: "chatgpt-main", provider: "openai" }],
      credentialMethods: [{ method: "device-code", interactive: false }],
      form: { fields: [{ name: "apiKey", secret: true }] },
      credentialSecret: "must-not-survive",
      refreshToken: "must-not-survive-either",
    }) as Record<string, unknown>

    expect(safe.credential).toBe("chatgpt-main")
    expect(safe.credentials).toEqual([{ id: "chatgpt-main", provider: "openai" }])
    expect(safe.credentialMethods).toEqual([{ method: "device-code", interactive: false }])
    expect(safe.form).toEqual({ fields: [{ name: "apiKey", secret: true }] })
    expect(safe.credentialSecret).toBe(REDACTED)
    expect(safe.refreshToken).toBe(REDACTED)
  })

  test("serializes JSON and JSONL without banners, ANSI or secret canaries", () => {
    const result: CommandResult<{ token: string; message: string }> = {
      schemaVersion: 1,
      ok: true,
      command: "test",
      data: { token: "secret-canary", message: "plain secret-canary" },
      diagnostics: [],
    }
    const json = serializeCommandResult(result, "json", ["secret-canary"])
    const jsonl = serializeCommandResult(result, "jsonl", ["secret-canary"])
    expect(JSON.parse(json)).toMatchObject({ schemaVersion: 1, ok: true, command: "test" })
    expect(JSON.parse(jsonl)).toMatchObject({ schemaVersion: 1, ok: true, command: "test" })
    expect(json).not.toContain("secret-canary")
    expect(jsonl).not.toContain("secret-canary")
    expect(json).not.toContain(String.fromCharCode(27))
    expect(jsonl.split("\n").filter(Boolean)).toHaveLength(1)
  })

  test("serializes operational event JSONL as one redacted envelope per line", () => {
    const events = [
      { ...event(1), payload: { message: "first secret-canary" } },
      { ...event(2, "workspace.inspected"), payload: { authorization: "Bearer hidden" } },
    ]

    const output = serializeEventEnvelopes(events, ["secret-canary"])
    const lines = output.trim().split("\n")

    expect(lines).toHaveLength(2)
    expect(lines.map((line) => EventEnvelopeSchema.parse(JSON.parse(line)).type)).toEqual([
      "workspace.initialized",
      "workspace.inspected",
    ])
    expect(output).not.toContain("secret-canary")
    expect(output).not.toContain("Bearer hidden")
    expect(output).not.toContain(String.fromCharCode(27))
  })
})
