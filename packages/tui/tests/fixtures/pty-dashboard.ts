import { CliRenderEvents } from "@opentui/core"
import {
  createEmptyRunUiSnapshot,
  type EvaluationFieldMetadata,
  type RunUiEventEnvelope,
  RunUiEventStore,
  type RunUiSnapshot,
  renderRunDashboard,
} from "../../src"

const READY_MARKER = "RALPH_PTY_READY"
const RESIZE_MARKER = "RALPH_PTY_RESIZE"
const RUN_ID = "pty-smoke"
const STREAM_ID = "ledger:pty-smoke"
const TIMESTAMP = "2026-07-19T12:00:00.000Z"
const USAGE_MODE = process.env.RALPH_PTY_USAGE_MODE === "reported" ? "reported" : "no-usage"
const TTY_MARKER = `T${Number(process.stdin.isTTY === true)}${Number(process.stdout.isTTY === true)}${Number(process.stderr.isTTY === true)}`

const emptySnapshot = createEmptyRunUiSnapshot(RUN_ID)
const unavailableUsage = {
  available: false,
  source: "no-usage",
  note: "provider omitted usage",
} as const
const initialSnapshot: RunUiSnapshot = {
  ...emptySnapshot,
  title: `${READY_MARKER}:${TTY_MARKER}:${USAGE_MODE}`,
  status: "running",
  currentTask: {
    id: "child-placeholder",
    title: "Pre-authored child waiting for its worker",
    status: "waiting",
    runId: "pty-child-placeholder",
  },
  progress: { completed: 1, total: 4 },
  usage: {
    combined: unavailableUsage,
    executor: unavailableUsage,
    judge: { available: false, source: "not-requested", note: "judge disabled" },
  },
  taskTree: [
    {
      id: "child-placeholder",
      title: "Pre-authored child waiting for its worker",
      status: "waiting",
      runId: "pty-child-placeholder",
      parentRunId: RUN_ID,
      documentId: "pty-child-prd",
      depth: 1,
    },
  ],
  scopes: [
    {
      runId: RUN_ID,
      kind: "root",
      depth: 0,
      title: "PTY root",
      status: "running",
      currentTask: null,
      progress: { completed: 1, total: 4 },
      usage: {
        combined: unavailableUsage,
        executor: unavailableUsage,
        judge: initialSnapshotJudgeUsage(),
      },
      runtime: emptySnapshot.runtime as NonNullable<RunUiSnapshot["runtime"]>,
      watchdog: emptySnapshot.watchdog as NonNullable<RunUiSnapshot["watchdog"]>,
      errors: { count: 0 },
    },
    {
      runId: "pty-child-placeholder",
      kind: "child",
      depth: 1,
      parentRunId: RUN_ID,
      title: "Child placeholder",
      status: "waiting",
      currentTask: {
        id: "child-placeholder",
        title: "Pre-authored child waiting for its worker",
        status: "waiting",
        runId: "pty-child-placeholder",
      },
      progress: { completed: 0, total: 1 },
      usage: {
        combined: unavailableUsage,
        executor: unavailableUsage,
        judge: initialSnapshotJudgeUsage(),
      },
      runtime: emptySnapshot.runtime as NonNullable<RunUiSnapshot["runtime"]>,
      watchdog: emptySnapshot.watchdog as NonNullable<RunUiSnapshot["watchdog"]>,
      errors: { count: 0 },
    },
  ],
}

function initialSnapshotJudgeUsage() {
  return { available: false, source: "not-requested", note: "judge disabled" } as const
}
const source = new RunUiEventStore({
  runId: RUN_ID,
  initialSnapshot,
  maxDisplayCharactersPerSegment: 16_384,
  renderIntervalMs: 10,
})
const evaluationFields: readonly EvaluationFieldMetadata[] = [
  {
    id: "evaluationMode",
    label: "Evaluation mode",
    kind: "select",
    configPath: "evaluation.mode",
    cliFlag: "--evaluation-mode",
    defaultValue: "deterministic-only",
  },
]

function event(
  sequence: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
  callId = "pty-call",
): RunUiEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: `pty-event-${sequence}`,
    sequence,
    timestamp: TIMESTAMP,
    monotonicMs: sequence,
    type,
    scope: "run",
    streamId: `run:${RUN_ID}`,
    workspaceId: "pty-workspace",
    runId: RUN_ID,
    callId,
    level: "info",
    payload,
  }
}

function retitle(title: string, sequence: number): void {
  source.acceptSnapshot(
    { ...source.getSnapshot(), title },
    { schemaVersion: 1, streamId: STREAM_ID, sequence },
  )
  source.flushNow()
}

const streamEvents = [
  event(1, "model.text.delta", {
    delta: `PTY_LARGE_OUTPUT:${"X".repeat(20_000)}:PTY_LARGE_OUTPUT_END`,
  }),
  event(2, "model.reasoning.delta", { delta: "PTY_REASONING_STREAM" }),
  event(3, "tool.output.delta", { delta: "PTY_TOOL_STREAM" }, "pty-tool-call"),
  event(4, "gate.output.delta", { delta: "PTY_GATE_STREAM" }, "pty-gate-call"),
  event(5, "external.cli.output.delta", { delta: "PTY_EXTERNAL_STREAM" }, "pty-cli-call"),
  ...(USAGE_MODE === "reported"
    ? [
        event(6, "model.usage.updated", {
          usage: {
            input: 30,
            output: 20,
            total: 50,
            source: "reported",
            semantics: "final",
          },
        }),
      ]
    : []),
  event(USAGE_MODE === "reported" ? 7 : 6, "progress.updated", { completed: 1, total: 4 }),
]
const initialSequence = streamEvents.at(-1)?.sequence ?? 0
source.ingestBatch({
  cursor: { schemaVersion: 1, streamId: STREAM_ID, sequence: initialSequence },
  events: streamEvents,
})
source.flushNow()

const handle = await renderRunDashboard({
  source,
  ascii: true,
  locale: "en",
  evaluationFields,
})
let resizeHandled = false
handle.renderer.on(CliRenderEvents.RESIZE, (width: number, height: number) => {
  if (resizeHandled || width !== 120 || height !== 36) return
  resizeHandled = true
  retitle(`${RESIZE_MARKER}:${width}x${height}`, initialSequence)
  source.ingestBatch({
    cursor: { schemaVersion: 1, streamId: STREAM_ID, sequence: initialSequence + 3 },
    events: [
      event(initialSequence + 1, "model.text.delta", {
        delta: `PTY resize applied at ${width}x${height}`,
      }),
      event(initialSequence + 2, "progress.updated", { completed: 4, total: 4 }),
      event(initialSequence + 3, "run.completed", { status: "completed" }),
    ],
  })
})

await handle.closed
const finalSnapshot = source.getSnapshot()
process.stdout.write(
  `\nRALPH_PTY_STREAM_RESULT:${JSON.stringify({
    usageMode: USAGE_MODE,
    tty: TTY_MARKER,
    status: finalSnapshot.status,
    progress: finalSnapshot.progress,
    usageSource: finalSnapshot.usage.executor.source,
    childPlaceholder: finalSnapshot.taskTree?.some((task) => task.id === "child-placeholder"),
    streams: {
      large: finalSnapshot.engineOutput.some((line) => line.includes("PTY_LARGE_OUTPUT_END")),
      reasoning: finalSnapshot.engineOutput.some((line) => line.includes("PTY_REASONING_STREAM")),
      tool: finalSnapshot.engineOutput.some((line) => line.includes("PTY_TOOL_STREAM")),
      gate: finalSnapshot.engineOutput.some((line) => line.includes("PTY_GATE_STREAM")),
      external: finalSnapshot.engineOutput.some((line) => line.includes("PTY_EXTERNAL_STREAM")),
    },
    droppedDisplayCharacters: finalSnapshot.connection?.metrics.droppedDisplayCharacters ?? 0,
  })}\n`,
)
