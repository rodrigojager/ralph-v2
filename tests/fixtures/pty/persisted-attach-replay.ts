import { createHash } from "node:crypto"
import { buildRunUiSnapshot, createTuiServices } from "../../../apps/ralph-cli/src/tui-services"

const workspaceRoot = process.env.RALPH_PTY_WORKSPACE
const runId = process.env.RALPH_PTY_RUN_ID
const mode = process.env.RALPH_PTY_ATTACH_MODE
if (!workspaceRoot || !runId || (mode !== "attach" && mode !== "replay")) {
  throw new Error(
    "RALPH_PTY_WORKSPACE, RALPH_PTY_RUN_ID and RALPH_PTY_ATTACH_MODE=attach|replay are required",
  )
}

const snapshotHash = (): string =>
  createHash("sha256")
    .update(JSON.stringify(buildRunUiSnapshot(workspaceRoot, runId)))
    .digest("hex")

const beforeHash = snapshotHash()
const abort = new AbortController()
const service = createTuiServices({
  interrupt: () => {
    abort.abort(new Error("PTY Ctrl+C"))
  },
})
process.stdout.write(`RALPH_PTY_${mode.toLocaleUpperCase("en-US")}_START\n`)
const result = await service.attach({
  workspaceRoot,
  runId,
  mode,
  signal: abort.signal,
})
if (abort.signal.aborted) {
  process.stdout.write(`\nRALPH_PTY_CTRL_C:${mode}-command-interrupt\n`)
}
const afterHash = snapshotHash()
const finalSnapshot = buildRunUiSnapshot(workspaceRoot, runId)

process.stdout.write(
  `RALPH_PTY_PERSISTED_RESULT:${JSON.stringify({
    mode,
    runId,
    status: finalSnapshot.status,
    progress: finalSnapshot.progress,
    result,
    readOnly: beforeHash === afterHash,
  })}\n`,
)
