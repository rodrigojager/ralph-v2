import {
  globalConfigPath,
  initializeWorkspace,
  listRuns,
  readConfigLayer,
  workspaceLayout,
} from "@ralph-next/persistence"
import { createTuiServices } from "../../../apps/ralph-cli/src/tui-services"
import {
  installPtyChildDiagnostics,
  markPtyChildStage,
  writePtyChildOutput,
} from "./child-diagnostics"

installPtyChildDiagnostics()

const workspaceRoot = process.env.RALPH_PTY_WORKSPACE
if (!workspaceRoot) throw new Error("RALPH_PTY_WORKSPACE is required")

await initializeWorkspace(workspaceRoot, "0.1.0-pty")
markPtyChildStage("pre-run.workspace-initialized")

const service = createTuiServices()
markPtyChildStage("pre-run.prepare.started")
const result = await service.prepare?.({
  workspaceRoot,
  initialInvocation: {
    schemaVersion: 1,
    runOptions: {},
    ui: "tui",
    lang: "en",
    cliArguments: [],
  },
})
markPtyChildStage("pre-run.prepare.settled", result?.disposition)
if (!result) throw new Error("TUI pre-run preparation service is unavailable")

const workspaceLayer = await readConfigLayer(workspaceLayout(workspaceRoot).config)
const globalLayer = await readConfigLayer(globalConfigPath(process.env))
const valueAt = (value: unknown, ...path: readonly string[]): unknown => {
  let current = value
  for (const segment of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return undefined
    }
    current = Reflect.get(current, segment)
  }
  return current
}

await writePtyChildOutput(
  `\nRALPH_PTY_PRE_RUN_RESULT:${JSON.stringify({
    disposition: result.disposition,
    appliedLanguage: result.disposition === "applied" ? result.invocation.lang : null,
    workspaceLanguage: valueAt(workspaceLayer, "defaults", "lang"),
    globalLanguage: valueAt(globalLayer, "defaults", "lang"),
    persistedRuns: listRuns(workspaceLayout(workspaceRoot).ledger, { limit: 10 }).length,
  })}\n`,
)
markPtyChildStage("pre-run.result-written")
