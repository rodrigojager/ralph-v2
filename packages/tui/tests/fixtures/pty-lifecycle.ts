import { readFile, writeFile } from "node:fs/promises"
import {
  createEmptyRunUiSnapshot,
  RunUiEventStore,
  type RunUiSnapshot,
  renderRunDashboard,
} from "../../src"
import {
  installPtyChildDiagnostics,
  markPtyChildStage,
  writePtyChildOutput,
} from "../../../../tests/fixtures/pty/child-diagnostics"

installPtyChildDiagnostics()

const RUN_ID = "pty-lifecycle"
const CHILD_RUN_ID = "pty-lifecycle-child"
const STREAM_ID = "ledger:pty-lifecycle"
const phase = process.env.RALPH_PTY_LIFECYCLE_PHASE
const stateFile = process.env.RALPH_PTY_LIFECYCLE_STATE
if ((phase !== "background" && phase !== "reattach") || !stateFile) {
  throw new Error(
    "RALPH_PTY_LIFECYCLE_PHASE=background|reattach and RALPH_PTY_LIFECYCLE_STATE are required",
  )
}
const empty = createEmptyRunUiSnapshot(RUN_ID)
const usage = { available: false, source: "no-usage", note: "deterministic PTY fixture" } as const
const runtime = empty.runtime as NonNullable<RunUiSnapshot["runtime"]>
const watchdog = empty.watchdog as NonNullable<RunUiSnapshot["watchdog"]>

const initialSnapshot: RunUiSnapshot = {
  ...empty,
  title: "RALPH_PTY_LIFECYCLE:ATTACHED",
  status: "running",
  currentTask: {
    id: "root-work",
    title: "Root work continues independently of the renderer",
    status: "running",
    runId: RUN_ID,
  },
  progress: { completed: 1, total: 3 },
  usage: { combined: usage, executor: usage, judge: usage },
  taskTree: [
    {
      id: "root-work",
      title: "Root work continues independently of the renderer",
      status: "running",
      runId: RUN_ID,
      documentId: "pty-root",
      depth: 0,
    },
    {
      id: "child-placeholder",
      title: "Pre-authored child placeholder",
      status: "waiting",
      runId: CHILD_RUN_ID,
      parentRunId: RUN_ID,
      documentId: "pty-child",
      depth: 1,
    },
  ],
  scopes: [
    {
      runId: RUN_ID,
      kind: "root",
      depth: 0,
      title: "Root",
      status: "running",
      currentTask: {
        id: "root-work",
        title: "Root work continues independently of the renderer",
        status: "running",
        runId: RUN_ID,
      },
      progress: { completed: 1, total: 3 },
      usage: { combined: usage, executor: usage, judge: usage },
      runtime,
      watchdog,
      errors: { count: 0 },
    },
    {
      runId: CHILD_RUN_ID,
      kind: "child",
      depth: 1,
      parentRunId: RUN_ID,
      title: "Child placeholder",
      status: "waiting",
      currentTask: null,
      progress: { completed: 0, total: 1 },
      usage: { combined: usage, executor: usage, judge: usage },
      runtime,
      watchdog,
      errors: { count: 0 },
    },
  ],
}

if (phase === "background") {
  const source = new RunUiEventStore({ runId: RUN_ID, initialSnapshot, renderIntervalMs: 0 })
  const handle = await renderRunDashboard({ source, ascii: true, locale: "en" })
  markPtyChildStage("lifecycle.background.handle-created")
  await handle.closed
  markPtyChildStage("lifecycle.background.handle-closed")

  // `q` closes only this renderer. The command-owned source is then allowed to
  // progress and its durable projection is what a later CLI process observes.
  source.acceptSnapshot(
    {
      ...source.getSnapshot(),
      title: "RALPH_PTY_LIFECYCLE:REATTACHED",
      progress: { completed: 2, total: 3 },
      activity: [
        ...source.getSnapshot().activity,
        { type: "background", message: "engine progressed while no renderer was attached" },
      ],
    },
    { schemaVersion: 1, streamId: STREAM_ID, sequence: 1 },
  )
  source.flushNow()
  await writeFile(stateFile, JSON.stringify(source.getSnapshot()), "utf8")
  await writePtyChildOutput("\nRALPH_PTY_BACKGROUND:source-progressed-without-renderer\n")
  await writePtyChildOutput(
    `RALPH_PTY_BACKGROUND_RESULT:${JSON.stringify({
      status: source.getSnapshot().status,
      progress: source.getSnapshot().progress,
    })}\n`,
  )
  markPtyChildStage("lifecycle.background.result-written")
} else {
  // Reattach is a new CLI invocation in production. Use a fresh process and a
  // fresh renderer, hydrating only the durable source projection written by
  // the background phase.
  const persisted = JSON.parse(await readFile(stateFile, "utf8")) as RunUiSnapshot
  const source = new RunUiEventStore({
    runId: RUN_ID,
    initialSnapshot: persisted,
    renderIntervalMs: 0,
  })
  let interrupted = false
  let handle: Awaited<ReturnType<typeof renderRunDashboard>> | undefined
  handle = await renderRunDashboard({
    source,
    ascii: true,
    locale: "en",
    onInterrupt: () => {
      interrupted = true
      handle?.destroy()
    },
  })
  markPtyChildStage("lifecycle.reattach.handle-created")
  await handle.closed
  markPtyChildStage("lifecycle.reattach.handle-closed")
  if (interrupted) {
    await writePtyChildOutput("\nRALPH_PTY_CTRL_C:command-owned-interrupt\n")
  }
  await writePtyChildOutput(
    `RALPH_PTY_LIFECYCLE_RESULT:${JSON.stringify({
      interrupted,
      status: source.getSnapshot().status,
      progress: source.getSnapshot().progress,
      childPlaceholder: source
        .getSnapshot()
        .taskTree?.some((task) => task.id === "child-placeholder"),
    })}\n`,
  )
  markPtyChildStage("lifecycle.reattach.result-written")
}
