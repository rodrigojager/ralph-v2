import { access, readFile, rename, writeFile } from "node:fs/promises"
import { createCommandShutdownLifecycle } from "../../../../apps/ralph-cli/src/command-shutdown"
import {
  installPtyChildDiagnostics,
  markPtyChildStage,
} from "../../../../tests/fixtures/pty/child-diagnostics"
import {
  createEmptyRunUiSnapshot,
  RunUiEventStore,
  type RunUiSnapshot,
  renderRunDashboard,
} from "../../src"

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
const parentAcknowledgementFile = `${stateFile}.parent-observed`
const backgroundResultFile = `${stateFile}.background-result.json`
const reattachResultFile = `${stateFile}.reattach-result.json`

async function waitForParentAcknowledgement(path: string): Promise<void> {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    try {
      await access(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    // This is a bounded condition poll, not a flush delay: exit depends only
    // on the parent's durable acknowledgement becoming observable.
    await Bun.sleep(10)
  }
  throw new Error(`Parent did not acknowledge PTY result through ${path}`)
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
  // Closing OpenTUI also closes the ConPTY output channel on some Windows
  // runners. Publish the post-renderer result atomically instead of racing an
  // informational stdout write against a pipe that is already gone.
  const backgroundResultStagingFile = `${backgroundResultFile}.${process.pid}.tmp`
  await writeFile(
    backgroundResultStagingFile,
    JSON.stringify({
      status: source.getSnapshot().status,
      progress: source.getSnapshot().progress,
    }),
    "utf8",
  )
  await rename(backgroundResultStagingFile, backgroundResultFile)
  markPtyChildStage("lifecycle.background.result-persisted")
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
  // A Windows ConPTY may deliver Ctrl+C as either a parsed keypress or a
  // process SIGINT. Production registers both routes against this same
  // command-owned lifecycle, so the fixture must model that boundary instead
  // of assuming the renderer always receives an ETX byte first.
  const shutdown = createCommandShutdownLifecycle({
    forceExit: () => undefined,
    onStateChange: (state) => {
      if (state !== "graceful") return
      interrupted = true
      markPtyChildStage("lifecycle.reattach.command-interrupt")
      handle?.destroy()
    },
  })
  handle = await renderRunDashboard({
    source,
    ascii: true,
    locale: "en",
    onInterrupt: () => shutdown.interrupt("SIGINT"),
  })
  markPtyChildStage("lifecycle.reattach.handle-created")
  await handle.closed
  markPtyChildStage("lifecycle.reattach.handle-closed")
  await shutdown.close()
  const result = {
    interrupted,
    status: source.getSnapshot().status,
    progress: source.getSnapshot().progress,
    childPlaceholder: source
      .getSnapshot()
      .taskTree?.some((task) => task.id === "child-placeholder"),
  }
  // The durable projection is the authoritative result after a renderer is
  // torn down. Publish it atomically so the harness never observes partial
  // JSON, even if ConPTY drops its final display-only output block.
  const resultStagingFile = `${reattachResultFile}.${process.pid}.tmp`
  await writeFile(resultStagingFile, JSON.stringify(result), "utf8")
  await rename(resultStagingFile, reattachResultFile)
  markPtyChildStage("lifecycle.reattach.result-persisted")
  // A stdout write callback means the bytes reached the ConPTY host, not that
  // the parent data callback consumed its final block. The OpenTUI teardown
  // also leaves PTY stdin unsuitable as an acknowledgement channel, so use a
  // sibling file to prove that the parent observed the result before exit.
  await waitForParentAcknowledgement(parentAcknowledgementFile)
  markPtyChildStage("lifecycle.reattach.result-acknowledged")
}
