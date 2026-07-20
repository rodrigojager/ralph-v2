import { lstat, realpath, rm } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  inspectWorkspace,
  listRuns,
  listWorkspaceFiles,
  workspaceLayout,
} from "@ralph-next/persistence"

export type CleanWorkspaceResult = {
  readonly schemaVersion: 1
  readonly root: string
  readonly statePath: string
  readonly files: readonly string[]
  readonly activeRunIds: readonly string[]
  readonly dryRun: boolean
  readonly removed: boolean
  readonly recoverable: false
}

function isContained(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
}

/**
 * Removes only a positively identified Ralph v2 state directory. PRDs, source
 * files, Git metadata and legacy workspaces are outside this capability.
 */
export async function cleanV2Workspace(input: {
  readonly root: string
  readonly force: boolean
  readonly dryRun: boolean
}): Promise<CleanWorkspaceResult> {
  const workspace = await inspectWorkspace(input.root, { exact: true })
  if (!workspace.initialized || !workspace.workspaceId) {
    throw new RalphError(
      "RALPH_CLEAN_V2_WORKSPACE_REQUIRED",
      "clean only removes a positively identified Ralph v2 workspace",
      {
        exitCode: EXIT_CODES.conflict,
        hint: "Legacy state is intentionally excluded; use migrate inspect before any manual cleanup.",
      },
    )
  }
  const layout = workspaceLayout(workspace.root)
  const info = await lstat(layout.ralph)
  const canonicalState = await realpath(layout.ralph)
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    !isContained(workspace.root, canonicalState) ||
    resolve(canonicalState) !== resolve(layout.ralph)
  ) {
    throw new RalphError(
      "RALPH_CLEAN_STATE_PATH_UNSAFE",
      "Refusing to clean linked, redirected or out-of-workspace Ralph state",
      { exitCode: EXIT_CODES.policyDenied, file: layout.ralph },
    )
  }
  const runs = listRuns(layout.ledger, {
    workspaceId: workspace.workspaceId,
    statuses: ["created", "running", "stopping", "interrupted", "waiting"],
    limit: 1_000,
  })
  const activeRunIds = runs.map((run) => run.id)
  if (activeRunIds.length > 0) {
    throw new RalphError(
      "RALPH_CLEAN_ACTIVE_RUNS",
      "Refusing to remove state while non-terminal runs exist",
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Stop each run and confirm its terminal status before cleaning.",
        details: { activeRunIds },
      },
    )
  }
  const files = await listWorkspaceFiles(workspace.root)
  if (!input.dryRun && !input.force) {
    throw new RalphError(
      "RALPH_CLEAN_FORCE_REQUIRED",
      "clean requires --force after reviewing the preview",
      {
        exitCode: EXIT_CODES.policyDenied,
        hint: "Run `ralph-next clean --dry-run`, then repeat with --force.",
      },
    )
  }
  if (!input.dryRun) await rm(canonicalState, { recursive: true, force: false })
  return {
    schemaVersion: 1,
    root: workspace.root,
    statePath: canonicalState,
    files,
    activeRunIds,
    dryRun: input.dryRun,
    removed: !input.dryRun,
    recoverable: false,
  }
}
