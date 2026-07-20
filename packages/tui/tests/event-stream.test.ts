import { describe, expect, test } from "bun:test"
import { type RunUiEventEnvelope, RunUiEventStore, type RunUiRenderScheduler } from "../src"

const RUN_ID = "run-event-storm"
const STREAM_ID = "ledger:workspace-storm"
const NOW = "2026-07-19T12:00:00.000Z"

function event(
  sequence: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
  options: { readonly callId?: string; readonly level?: RunUiEventEnvelope["level"] } = {},
): RunUiEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    timestamp: NOW,
    monotonicMs: sequence,
    type,
    scope: "run",
    streamId: `run:${RUN_ID}`,
    workspaceId: "workspace-storm",
    runId: RUN_ID,
    ...(options.callId ? { callId: options.callId } : {}),
    level: options.level ?? "info",
    payload,
  }
}

describe("TUI display backpressure", () => {
  test("coalesces a maximum-size event storm without blocking control-plane observations", () => {
    const scheduled: Array<() => void> = []
    const scheduler: RunUiRenderScheduler = {
      schedule(callback) {
        scheduled.push(callback)
        return callback
      },
      cancel() {},
    }
    const callId = "call-storm"
    const deltas = Array.from({ length: 2_042 }, (_, index) =>
      event(
        index + 3,
        "model.text.delta",
        { delta: `chunk-${index.toString().padStart(4, "0")};` },
        { callId },
      ),
    )
    const events: RunUiEventEnvelope[] = [
      event(1, "run.started", { status: "running" }),
      event(2, "model.backend.call.reserved", {}, { callId }),
      ...deltas,
      event(
        2_045,
        "model.usage.updated",
        {
          usage: {
            input: 20,
            output: 10,
            total: 30,
            source: "reported",
            semantics: "final",
          },
        },
        { callId },
      ),
      event(2_046, "watchdog.probe", {
        state: "healthy",
        phase: "model-call",
        signals: [{ signal: "control-heartbeat", verdict: "positive", reason: "responsive" }],
      }),
      event(
        2_047,
        "diagnostic.created",
        { code: "STORM_DIAGNOSTIC", message: "bounded diagnostic survived the stream" },
        { level: "error" },
      ),
      event(2_048, "model.call.finished", { status: "finished" }, { callId }),
    ]
    const rawFeedBefore = JSON.stringify(events)
    const store = new RunUiEventStore({
      runId: RUN_ID,
      scheduler,
      renderIntervalMs: 50,
      maxDisplaySegments: 4,
      maxDisplayCharactersPerSegment: 128,
      projectionLimits: { engineOutput: 8, events: 16, activity: 16, logs: 16 },
      now: () => NOW,
    })
    let rendered = 0
    store.subscribe(() => {
      rendered += 1
    })

    const result = store.ingestBatch({
      cursor: { schemaVersion: 1, streamId: STREAM_ID, sequence: 2_048 },
      events,
    })
    const heartbeat = store.acceptHeartbeat({
      schemaVersion: 1,
      streamId: STREAM_ID,
      sequence: 2_048,
    })

    expect(result).toMatchObject({ received: 2_048, applied: 2_048, duplicates: 0, stale: 0 })
    expect(heartbeat).toMatchObject({ received: 0, applied: 0, duplicates: 0, stale: 0 })
    expect(rendered).toBe(0)
    expect(scheduled).toHaveLength(1)
    expect(JSON.stringify(events)).toBe(rawFeedBefore)

    scheduled[0]?.()
    const snapshot = store.getSnapshot()
    expect(rendered).toBe(1)
    expect(snapshot.status).toBe("running")
    expect(snapshot.usage.executor).toMatchObject({
      available: true,
      source: "reported",
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    })
    expect(snapshot.watchdog).toMatchObject({
      state: "healthy",
      phase: "model-call",
      signals: [{ name: "control-heartbeat", verdict: "positive" }],
    })
    expect(snapshot.errorsSummary?.last).toMatchObject({ code: "STORM_DIAGNOSTIC" })
    expect(snapshot.engineOutput.join("\n")).toContain("raw stream remains authoritative")
    expect(snapshot.connection?.lastHeartbeatAt).toBe(NOW)
    expect(snapshot.connection?.metrics).toMatchObject({
      receivedEvents: 2_048,
      appliedEvents: 2_048,
      coalescedDisplayEvents: 2_041,
      renderFlushes: 1,
      protocolErrors: 0,
    })
    expect(snapshot.connection?.metrics.droppedDisplayCharacters).toBeGreaterThan(0)
  })

  test("only a durable progress event changes the official completed count", () => {
    const store = new RunUiEventStore({ runId: RUN_ID, renderIntervalMs: 0 })
    store.ingestBatch({
      cursor: { schemaVersion: 1, streamId: STREAM_ID, sequence: 4 },
      events: [
        event(1, "task.started", { status: "executing" }),
        event(2, "model.text.delta", { delta: "work in progress" }, { callId: "call-progress" }),
        event(3, "tool.call.settled", { status: "success", tool: "fs.write" }),
        event(4, "task.completed", { status: "completed" }),
      ],
    })
    store.flushNow()
    expect(store.getSnapshot().progress).toEqual({ completed: 0, total: 0 })

    store.ingestBatch({
      cursor: { schemaVersion: 1, streamId: STREAM_ID, sequence: 5 },
      events: [event(5, "progress.updated", { completed: 1, total: 4 })],
    })
    store.flushNow()
    expect(store.getSnapshot().progress).toEqual({ completed: 1, total: 4 })
  })
})
