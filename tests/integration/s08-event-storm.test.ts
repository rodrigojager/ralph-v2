import { afterEach, describe, expect, test } from "bun:test"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import {
  appendEvent,
  appendEventInTransaction,
  initializeLedger,
  readEventBatch,
  readEvents,
  runLayout,
  withLedger,
  workspaceLayout,
} from "@ralph-next/persistence"
import { type EventInput, RawStreamRecordSchema } from "@ralph-next/telemetry"
import {
  type RunUiEventEnvelope,
  RunUiEventStore,
  type RunUiRenderScheduler,
} from "@ralph-next/tui"
import { createWorkspaceBunProcessSupervisor } from "../../apps/ralph-cli/src/process-output-store"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const RUN_ID = "run-s08-storm"
const WORKSPACE_ID = "workspace-s08-storm"
const STREAM_ID = `run:${RUN_ID}`
const LEDGER_STREAM_ID = `ledger:${WORKSPACE_ID}`
// The TUI-only max-batch test covers 2,048 events. This cross-component case
// keeps 128 durable deltas so a real SQLite + Windows process run remains a
// bounded integration check instead of turning every local check into a soak.
const DELTA_COUNT = 128
const LAST_DELTA = `storm-${String(DELTA_COUNT - 1).padStart(4, "0")}`
const PAGE_SIZE = 128

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

function appendRunEvent(
  ledger: string,
  type: string,
  payload: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
): void {
  appendEvent(ledger, runEventInput(type, payload, level))
}

function runEventInput(
  type: string,
  payload: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
): EventInput {
  return {
    type,
    scope: "run",
    streamId: STREAM_ID,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    level,
    payload,
  }
}

function rawStreamDirectory(workspaceRoot: string, rawRef: string): string {
  const match = /^run-raw:\/\/([^/]+)\/process\/([a-f0-9]{64})\/stream$/u.exec(rawRef)
  if (!match || match[1] !== RUN_ID) throw new Error(`Unexpected process raw ref: ${rawRef}`)
  return join(
    runLayout(workspaceLayout(workspaceRoot), RUN_ID).raw,
    "diagnostic",
    "processes",
    match[2] as string,
  )
}

async function persistedRawText(workspaceRoot: string, rawRef: string): Promise<string> {
  const directory = rawStreamDirectory(workspaceRoot, rawRef)
  const files = (await readdir(directory)).filter((name) => /^\d{8,16}\.jsonl$/u.test(name)).sort()
  const records = []
  for (const file of files) {
    const lines = (await readFile(join(directory, file), "utf8")).split(/\r?\n/u).filter(Boolean)
    for (const line of lines) records.push(RawStreamRecordSchema.parse(JSON.parse(line)))
  }
  return records.map((record) => record.data).join("")
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

describe("S08 integrated event-storm boundary", () => {
  test("keeps supervisor, persistence, raw retention, heartbeat and progress authoritative under display backpressure", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    const bun = Bun.which("bun")
    if (!bun) throw new Error("Bun executable is unavailable")

    const retention = {
      maximumFileBytes: 65_536,
      maximumFiles: 1,
      maximumTotalBytes: 65_536,
    } as const
    const supervisor = createWorkspaceBunProcessSupervisor({
      workspaceRoot: root,
      runId: RUN_ID,
      maximumBytes: 65_536,
      persistRawOutput: true,
      retention,
    })

    appendRunEvent(layout.ledger, "run.started", { status: "running" })
    let lineBuffer = ""
    const capturedLines: string[] = []
    let persistedDeltas = 0
    let midProgressPersisted = false
    const persistCompletedLines = (completedLines: readonly string[]): void => {
      if (completedLines.length === 0) return
      const crossesMidpoint =
        !midProgressPersisted &&
        persistedDeltas < Math.floor(DELTA_COUNT / 2) &&
        persistedDeltas + completedLines.length >= Math.floor(DELTA_COUNT / 2)
      withLedger(layout.ledger, (database) =>
        database.transaction(() => {
          for (const line of completedLines) {
            appendEventInTransaction(
              database,
              runEventInput("external.cli.output.delta", { delta: line }),
            )
          }
          if (crossesMidpoint) {
            appendEventInTransaction(
              database,
              runEventInput("progress.updated", { completed: 0, total: 1 }),
            )
          }
        })(),
      )
      persistedDeltas += completedLines.length
      if (crossesMidpoint) midProgressPersisted = true
    }
    const queueLines = (delta: string): void => {
      lineBuffer += delta
      const lines = lineBuffer.split("\n")
      lineBuffer = lines.pop() ?? ""
      capturedLines.push(...lines.filter(Boolean))
    }
    const stormScript = `
      let output = "";
      for (let index = 0; index < ${DELTA_COUNT}; index += 1) {
        output += "storm-" + String(index).padStart(4, "0") + "\\n";
      }
      process.stdout.write("old-raw-candidate");
      process.stderr.write(output);
    `
    let supervisorSettled = false
    let heartbeatWhileRunning = 0
    const handle = await supervisor.start({
      executable: bun,
      args: ["-e", stormScript],
      cwd: root,
      environment: { PATH: process.env.PATH },
      shell: false,
      timeoutMs: 10_000,
      outputLimitBytes: 65_536,
      rawOutputLimitBytes: 65_536,
      onOutput(stream, delta) {
        if (stream === "stderr") queueLines(delta)
      },
    })
    const persistHeartbeat = (): void => {
      if (supervisorSettled) return
      heartbeatWhileRunning += 1
      appendRunEvent(layout.ledger, "watchdog.probe", {
        state: "healthy",
        phase: "supervised-event-storm",
        signals: [
          { signal: "supervisor-heartbeat", verdict: "positive", reason: "process responsive" },
        ],
      })
    }
    persistHeartbeat()
    const settlement = await handle.settlement
    supervisorSettled = true
    if (lineBuffer) {
      capturedLines.push(lineBuffer)
      lineBuffer = ""
    }
    persistCompletedLines(capturedLines)
    expect(settlement.exitCode).toBe(0)
    expect(settlement.timedOut).toBeFalse()
    expect(settlement.cancelled).toBeFalse()
    expect(settlement.rawOutputTruncated).toBeFalse()
    expect(settlement.outputRefs).toHaveLength(2)
    expect(persistedDeltas).toBe(DELTA_COUNT)
    expect(heartbeatWhileRunning).toBeGreaterThan(0)

    const oldRawRef = settlement.outputRefs[0] as string
    const mandatoryRawRef = settlement.outputRefs[1] as string
    appendRunEvent(layout.ledger, "external.cli.output.completed", {
      status: "completed",
      rawRefsResolved: [mandatoryRawRef],
    })
    appendRunEvent(layout.ledger, "model.usage.updated", {
      usage: { input: 12, output: 8, total: 20, source: "reported", semantics: "final" },
    })
    appendRunEvent(layout.ledger, "progress.updated", { completed: 1, total: 1 })
    appendRunEvent(layout.ledger, "run.completed", { status: "completed" })

    const durableEvents = readEvents(layout.ledger).filter((event) => event.runId === RUN_ID)
    const durableDeltas = durableEvents.filter(
      (event) => event.type === "external.cli.output.delta",
    )
    expect(durableDeltas).toHaveLength(DELTA_COUNT)
    expect(durableDeltas[0]?.payload.delta).toBe("storm-0000")
    expect(durableDeltas.at(-1)?.payload.delta).toBe(LAST_DELTA)
    expect(durableEvents.some((event) => event.type === "watchdog.probe")).toBeTrue()
    expect(durableEvents.at(-1)?.type).toBe("run.completed")

    const rawText = await persistedRawText(root, mandatoryRawRef)
    expect(rawText).toContain("storm-0000")
    expect(rawText).toContain(LAST_DELTA)
    expect(await directoryExists(rawStreamDirectory(root, oldRawRef))).toBeFalse()
    expect(await directoryExists(rawStreamDirectory(root, mandatoryRawRef))).toBeTrue()

    const scheduled: Array<() => void> = []
    const scheduler: RunUiRenderScheduler = {
      schedule(callback) {
        scheduled.push(callback)
        return callback
      },
      cancel() {},
    }
    const store = new RunUiEventStore({
      runId: RUN_ID,
      scheduler,
      renderIntervalMs: 50,
      maxDisplaySegments: 8,
      maxDisplayCharactersPerSegment: 128,
      projectionLimits: { engineOutput: 16, events: 32, activity: 32, logs: 32 },
    })
    let renders = 0
    store.subscribe(() => {
      renders += 1
    })
    let cursor = 0
    while (true) {
      const page = readEventBatch(layout.ledger, {
        afterSequence: cursor,
        limit: PAGE_SIZE,
        runId: RUN_ID,
      })
      if (page.scanned === 0) break
      cursor = page.cursorSequence
      const eventCursor = {
        schemaVersion: 1 as const,
        streamId: LEDGER_STREAM_ID,
        sequence: cursor,
      }
      store.ingestBatch({
        cursor: eventCursor,
        events: page.events as readonly RunUiEventEnvelope[],
      })
      store.acceptHeartbeat(eventCursor)
    }
    expect(scheduled).toHaveLength(1)
    expect(renders).toBe(0)
    scheduled[0]?.()

    const snapshot = store.getSnapshot()
    expect(renders).toBe(1)
    expect(snapshot.status).toBe("completed")
    expect(snapshot.progress).toEqual({ completed: 1, total: 1 })
    expect(snapshot.watchdog).toMatchObject({
      state: "healthy",
      phase: "supervised-event-storm",
      signals: [{ name: "supervisor-heartbeat", verdict: "positive" }],
    })
    expect(snapshot.usage.executor).toMatchObject({
      available: true,
      source: "reported",
      totalTokens: 20,
    })
    expect(snapshot.rawEngineRefs).toContain(mandatoryRawRef)
    expect(snapshot.engineOutput.join("\n")).toContain(LAST_DELTA)
    expect(snapshot.connection?.lastHeartbeatAt).not.toBeNull()
    expect(snapshot.connection?.metrics.receivedEvents).toBe(durableEvents.length)
    expect(snapshot.connection?.metrics.coalescedDisplayEvents).toBeGreaterThan(120)
    expect(snapshot.connection?.metrics.droppedDisplayCharacters).toBeGreaterThan(0)
  }, 45_000)
})
