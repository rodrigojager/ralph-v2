import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  appendEventInTransaction,
  appendRawStream,
  initializeLedger,
  readEvents,
  readRawStream,
  withLedger,
  workspaceLayout,
} from "@ralph/persistence"
import { compilePrdGraph, parsePrdSource } from "@ralph/prd"
import { type EventEnvelope, replayWorkspaceEvents } from "@ralph/telemetry"
import { type RunUiEventEnvelope, RunUiEventStore, type RunUiRenderScheduler } from "@ralph/tui"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const NOW = "2026-07-19T12:00:00.000Z"
const MEBIBYTE = 1_048_576

// These are intentionally broad local regression ceilings, not machine scores.
// Deterministic size/count assertions below remain the primary performance contract.
const TIME_BUDGETS_MS = {
  largePrd: 30_000,
  eventStorm: 15_000,
  rawRetention: 45_000,
  longReplay: 15_000,
  tuiMemory: 20_000,
  multipleProjects: 30_000,
} as const

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

function assertLocalTimeBudget(label: string, startedAt: number, budgetMs: number): number {
  const elapsedMs = performance.now() - startedAt
  console.info(
    `[performance:windows-local] ${label}=${elapsedMs.toFixed(1)}ms budget=${budgetMs}ms`,
  )
  expect(elapsedMs).toBeLessThan(budgetMs)
  return elapsedMs
}

function forceGarbageCollection(): void {
  Bun.gc(true)
}

function assertLocalHeapBudget(label: string, beforeBytes: number, budgetBytes: number): number {
  forceGarbageCollection()
  const deltaBytes = Math.max(0, process.memoryUsage().heapUsed - beforeBytes)
  console.info(
    `[performance:windows-local] ${label}=${(deltaBytes / MEBIBYTE).toFixed(1)}MiB budget=${(
      budgetBytes / MEBIBYTE
    ).toFixed(0)}MiB`,
  )
  expect(deltaBytes).toBeLessThan(budgetBytes)
  return deltaBytes
}

function largePrdSource(taskCount: number): string {
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const ordinal = index + 1
    const id = `task-${String(ordinal).padStart(4, "0")}`
    const dependency = index === 0 ? "none" : `task-${String(index).padStart(4, "0")}`
    return `- [ ] **${id} — Deliver observable increment ${ordinal}**
  - Result: increment ${ordinal} is independently observable from end to end.
  - Dependencies: ${dependency}
  - Criteria:
    1. The deterministic artifact for increment ${ordinal} exists.
  - Verification:
    - file: artifacts/${id}.txt; exists
  - Boundaries:
    - Preserve the authored cross-layer contract.
  - Evidence mode: criteria
  - Sub-PRD: none
  - Parallel group: performance-baseline
  - Profiles: executor=runner; judge=reviewer
  - Budget: model_calls=2; timeout=90s; revisions=1
  - Notes:
    - Generated only for the local parser and graph regression budget.`
  })

  return `---
ralph_prd: 2
id: large-performance
title: Large deterministic performance fixture
kind: root
workspace: .
defaults:
  executor_profile: runner
  judge_profile: reviewer
  evidence_mode: criteria
  budget:
    max_model_calls: 4
    timeout: 2m
metadata:
  fixture: s11-performance
---

# Large deterministic performance fixture

## Vertical slices

${tasks.join("\n\n")}
`
}

function workspaceEvent(sequence: number, workspaceId = "workspace-replay"): EventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `${workspaceId}-event-${sequence}`,
    sequence,
    timestamp: NOW,
    monotonicMs: sequence,
    type: sequence === 1 ? "workspace.initialized" : "workspace.inspected",
    scope: "workspace",
    streamId: `workspace:${workspaceId}`,
    workspaceId,
    level: "info",
    payload: { sequence },
  }
}

function runUiEvent(
  sequence: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
  options: {
    readonly runId?: string
    readonly workspaceId?: string
    readonly callId?: string
    readonly level?: RunUiEventEnvelope["level"]
  } = {},
): RunUiEventEnvelope {
  const runId = options.runId ?? "run-performance"
  const workspaceId = options.workspaceId ?? "workspace-performance"
  return {
    schemaVersion: 1,
    eventId: `${runId}-event-${sequence}`,
    sequence,
    timestamp: NOW,
    monotonicMs: sequence,
    type,
    scope: "run",
    streamId: `run:${runId}`,
    workspaceId,
    runId,
    ...(options.callId ? { callId: options.callId } : {}),
    level: options.level ?? "info",
    payload,
  }
}

function controlledScheduler(): {
  scheduler: RunUiRenderScheduler
  scheduled: Array<() => void>
} {
  const scheduled: Array<() => void> = []
  return {
    scheduled,
    scheduler: {
      schedule(callback) {
        scheduled.push(callback)
        return callback
      },
      cancel() {},
    },
  }
}

describe("S11 local performance, backpressure and retention budgets", () => {
  test("parses and compiles a 750-task vertical PRD inside a broad local budget", async () => {
    const root = await temporaryDirectory()
    const taskCount = 750
    const source = largePrdSource(taskCount)
    const prdFile = resolve(root, "PRD.md")
    await writeFile(prdFile, source, "utf8")

    const startedAt = performance.now()
    const parsed = parsePrdSource(source, { file: "PRD.md" })
    expect(parsed.ok).toBeTrue()
    expect(parsed.document?.tasks).toHaveLength(taskCount)

    const compiled = await compilePrdGraph(prdFile, {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    assertLocalTimeBudget("large-prd-750", startedAt, TIME_BUDGETS_MS.largePrd)

    expect(compiled.ok).toBeTrue()
    if (!compiled.graph) throw new Error("Large PRD did not compile a graph")
    expect(compiled.graph.topologicalOrder).toHaveLength(taskCount)
    expect(compiled.graph.dependencyEdges).toHaveLength(taskCount - 1)
    expect(compiled.graph.eligibleTasks).toHaveLength(1)
    expect(compiled.graph.eligibleTasks[0]).toMatchObject({
      documentId: "large-performance",
      taskId: "task-0001",
    })
    expect(compiled.graph.topologicalOrder.at(-1)).toMatchObject({
      documentId: "large-performance",
      taskId: "task-0750",
    })
  }, 45_000)

  test("coalesces the maximum event batch carrying about 8 MiB of output", () => {
    const runId = "run-output-storm"
    const callId = "call-output-storm"
    const deltaCount = 2_043
    const deltaCharacters = 4_080
    const deltas = Array.from({ length: deltaCount }, (_, index) =>
      runUiEvent(
        index + 3,
        "model.text.delta",
        { delta: `out-${String(index).padStart(4, "0")}:${"x".repeat(deltaCharacters)}` },
        { runId, callId },
      ),
    )
    const events: RunUiEventEnvelope[] = [
      runUiEvent(1, "run.started", { status: "running" }, { runId }),
      runUiEvent(2, "model.backend.call.reserved", {}, { runId, callId }),
      ...deltas,
      runUiEvent(2_046, "progress.updated", { completed: 1, total: 1 }, { runId }),
      runUiEvent(
        2_047,
        "model.usage.updated",
        {
          usage: {
            input: 80,
            output: 40,
            total: 120,
            source: "reported",
            semantics: "final",
          },
        },
        { runId, callId },
      ),
      runUiEvent(2_048, "run.completed", { status: "completed" }, { runId }),
    ]
    const rawOutputCharacters = deltas.reduce(
      (total, event) => total + String(event.payload.delta).length,
      0,
    )
    const { scheduler, scheduled } = controlledScheduler()
    const store = new RunUiEventStore({
      runId,
      scheduler,
      renderIntervalMs: 50,
      maxRememberedEvents: 2_048,
      maxDisplaySegments: 4,
      maxDisplayCharactersPerSegment: 8_192,
      projectionLimits: { activity: 16, events: 16, logs: 16, engineOutput: 8 },
      now: () => NOW,
    })
    forceGarbageCollection()
    const heapBefore = process.memoryUsage().heapUsed

    const startedAt = performance.now()
    const result = store.ingestBatch({
      cursor: { schemaVersion: 1, streamId: `ledger:${runId}`, sequence: 2_048 },
      events,
    })
    store.flushNow()
    assertLocalTimeBudget("event-storm-2048", startedAt, TIME_BUDGETS_MS.eventStorm)
    assertLocalHeapBudget("event-storm-heap", heapBefore, 96 * MEBIBYTE)

    const snapshot = store.getSnapshot()
    expect(events).toHaveLength(2_048)
    expect(rawOutputCharacters).toBeGreaterThan(8 * MEBIBYTE - 100_000)
    expect(result).toMatchObject({ received: 2_048, applied: 2_048, duplicates: 0, stale: 0 })
    expect(scheduled).toHaveLength(1)
    expect(snapshot.status).toBe("completed")
    expect(snapshot.progress).toEqual({ completed: 1, total: 1 })
    expect(snapshot.usage.executor.totalTokens).toBe(120)
    expect(snapshot.engineOutput.length).toBeLessThanOrEqual(8)
    expect(snapshot.connection?.metrics.coalescedDisplayEvents).toBe(deltaCount - 1)
    expect(snapshot.connection?.metrics.droppedDisplayCharacters).toBeGreaterThan(
      8 * MEBIBYTE - 200_000,
    )
  }, 30_000)

  test("retains a bounded tail while appending more than one MiB of raw output", async () => {
    const root = await temporaryDirectory()
    const rawRoot = resolve(root, "raw")
    await mkdir(rawRoot, { recursive: true })
    const chunkCount = 32
    const retention = {
      maxSegmentBytes: 65_536,
      maxSegments: 4,
      maxTotalBytes: 262_144,
    } as const
    let lastReceipt: Awaited<ReturnType<typeof appendRawStream>> | undefined

    const startedAt = performance.now()
    for (let index = 0; index < chunkCount; index += 1) {
      const marker = `raw-chunk-${String(index).padStart(2, "0")}`
      lastReceipt = await appendRawStream({
        rawRoot,
        streamKind: "process",
        streamId: "large-output-process",
        referenceScope: "run-performance",
        channel: "stdout",
        data: `${marker}:${"r".repeat(40_000)}`,
        timestamp: NOW,
        retention,
      })
    }
    const records = await readRawStream(rawRoot, {
      streamKind: "process",
      streamId: "large-output-process",
      limit: chunkCount,
    })
    assertLocalTimeBudget("raw-retention-32x40k", startedAt, TIME_BUDGETS_MS.rawRetention)

    if (!lastReceipt) throw new Error("Raw output benchmark produced no receipt")
    expect(lastReceipt.retainedSegments).toBeLessThanOrEqual(retention.maxSegments)
    expect(lastReceipt.retainedBytes).toBeLessThanOrEqual(retention.maxTotalBytes)
    expect(records.length).toBeGreaterThan(0)
    expect(records.length).toBeLessThan(chunkCount)
    expect(records.at(-1)?.data).toContain("raw-chunk-31")
    expect(records.some((record) => record.data.includes("raw-chunk-00"))).toBeFalse()
    expect(records.every((record) => record.redacted)).toBeTrue()
  }, 60_000)

  test("replays 25,000 durable envelopes with an exact cursor and count", () => {
    const eventCount = 25_000
    const events = Array.from({ length: eventCount }, (_, index) => workspaceEvent(index + 1))

    const startedAt = performance.now()
    const replay = replayWorkspaceEvents(events)
    assertLocalTimeBudget("workspace-replay-25000", startedAt, TIME_BUDGETS_MS.longReplay)

    expect(replay).toEqual({
      initialized: true,
      initializedAt: NOW,
      eventCursor: eventCount,
      eventCount,
      lastEventType: "workspace.inspected",
    })
  }, 30_000)

  test("keeps a 20,000-event TUI replay bounded in projection and heap", () => {
    const runId = "run-long-tui-replay"
    const totalEvents = 20_000
    const batchSize = 500
    const { scheduler, scheduled } = controlledScheduler()
    const store = new RunUiEventStore({
      runId,
      scheduler,
      renderIntervalMs: 50,
      maxRememberedEvents: 512,
      maxDisplaySegments: 4,
      maxDisplayCharactersPerSegment: 2_048,
      projectionLimits: { activity: 32, events: 32, logs: 32, engineOutput: 16 },
      now: () => NOW,
    })
    forceGarbageCollection()
    const heapBefore = process.memoryUsage().heapUsed

    const startedAt = performance.now()
    for (let offset = 0; offset < totalEvents; offset += batchSize) {
      const events = Array.from({ length: batchSize }, (_, index) => {
        const sequence = offset + index + 1
        return runUiEvent(
          sequence,
          "diagnostic.created",
          { code: "PERFORMANCE_DIAGNOSTIC", message: `diagnostic-${sequence}` },
          { runId, level: "error" },
        )
      })
      store.ingestBatch({
        cursor: {
          schemaVersion: 1,
          streamId: `ledger:${runId}`,
          sequence: offset + batchSize,
        },
        events,
      })
    }
    store.flushNow()
    assertLocalTimeBudget("tui-replay-20000", startedAt, TIME_BUDGETS_MS.tuiMemory)
    assertLocalHeapBudget("tui-replay-heap", heapBefore, 128 * MEBIBYTE)

    const snapshot = store.getSnapshot()
    expect(scheduled).toHaveLength(1)
    expect(snapshot.activity).toHaveLength(32)
    expect(snapshot.events).toHaveLength(32)
    expect(snapshot.logs).toHaveLength(32)
    expect(snapshot.errorsSummary?.count).toBe(totalEvents)
    expect(snapshot.connection?.cursor?.sequence).toBe(totalEvents)
    expect(snapshot.connection?.metrics).toMatchObject({
      receivedEvents: totalEvents,
      appliedEvents: totalEvents,
      duplicateEvents: 0,
      staleEvents: 0,
      renderFlushes: 1,
    })
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(512 * 1_024)
  }, 30_000)

  test("keeps eight concurrently initialized project ledgers isolated", async () => {
    const projectCount = 8
    const eventsPerProject = 256
    const roots = await Promise.all(
      Array.from({ length: projectCount }, () => temporaryDirectory()),
    )

    const startedAt = performance.now()
    const results = await Promise.all(
      roots.map(async (root, projectIndex) => {
        const workspaceId = `project-${projectIndex}`
        const layout = workspaceLayout(root)
        await initializeLedger(layout)
        withLedger(layout.ledger, (database) =>
          database.transaction(() => {
            for (let index = 0; index < eventsPerProject; index += 1) {
              appendEventInTransaction(
                database,
                {
                  type: index === 0 ? "workspace.initialized" : "workspace.inspected",
                  scope: "workspace",
                  streamId: `workspace:${workspaceId}`,
                  workspaceId,
                  payload: { projectIndex, index },
                },
                `${workspaceId}-event-${index + 1}`,
              )
            }
          })(),
        )
        const events = readEvents(layout.ledger)
        return { workspaceId, events, replay: replayWorkspaceEvents(events) }
      }),
    )
    assertLocalTimeBudget("multiple-projects-8x256", startedAt, TIME_BUDGETS_MS.multipleProjects)

    const eventIds = new Set<string>()
    for (const result of results) {
      expect(result.events).toHaveLength(eventsPerProject)
      expect(result.events.every((event) => event.workspaceId === result.workspaceId)).toBeTrue()
      expect(result.replay).toMatchObject({
        initialized: true,
        eventCursor: eventsPerProject,
        eventCount: eventsPerProject,
      })
      for (const event of result.events) eventIds.add(event.eventId)
    }
    expect(eventIds.size).toBe(projectCount * eventsPerProject)
  }, 45_000)
})
