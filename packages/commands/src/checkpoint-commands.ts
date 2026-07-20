import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  applyCheckpointRollback,
  createGitCommandPort,
  createWorkspaceCheckpoint,
  type GitCheckpointInventory,
  type GitCommandPort,
  inspectGitBaseline,
  previewCheckpointRollback,
} from "@ralph-next/orchestration"
import {
  canonicalDirectory,
  getRun,
  inspectWorkspace,
  loadEffectiveConfig,
  readEventHighWater,
  snapshotLedgerWorkspaceEventRetention,
  workspaceLayout,
} from "@ralph-next/persistence"

type InitializedCheckpointWorkspace = {
  root: string
  workspaceId: string
  layout: ReturnType<typeof workspaceLayout>
}

type PrdRevision = {
  path: string
  sha256: string
}

function portable(value: string): string {
  return value.split(sep).join("/")
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function initializedWorkspace(
  workspaceRoot: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<InitializedCheckpointWorkspace> {
  const root = await canonicalDirectory(workspaceRoot)
  const inspected = await inspectWorkspace(root, { exact: true })
  if (!inspected.initialized || !inspected.workspaceId) {
    throw new RalphError(
      "RALPH_CHECKPOINT_WORKSPACE_REQUIRED",
      "Checkpoint and rollback commands require an initialized Ralph v2 workspace",
      { exitCode: EXIT_CODES.blocked, file: root },
    )
  }
  const layout = workspaceLayout(root)
  const effective = await loadEffectiveConfig({
    workspaceConfig: layout.config,
    environment: { ...environment },
  })
  snapshotLedgerWorkspaceEventRetention(layout.ledger, effective.config.telemetry.event_retention)
  return { root, workspaceId: inspected.workspaceId, layout }
}

async function prdRevision(workspaceRoot: string, requested = "PRD.md"): Promise<PrdRevision> {
  const candidate = resolve(workspaceRoot, requested)
  if (!contained(workspaceRoot, candidate)) {
    throw new RalphError(
      "RALPH_CHECKPOINT_PRD_OUTSIDE_WORKSPACE",
      "Checkpoint PRD must be a file inside the workspace",
      { exitCode: EXIT_CODES.permissionDenied, file: requested },
    )
  }
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(candidate)
  } catch (error) {
    throw new RalphError("RALPH_CHECKPOINT_PRD_UNAVAILABLE", "Checkpoint PRD is unavailable", {
      exitCode: EXIT_CODES.notFound,
      file: requested,
      cause: error,
    })
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new RalphError(
      "RALPH_CHECKPOINT_PRD_UNSAFE",
      "Checkpoint PRD must be a regular non-linked file",
      { exitCode: EXIT_CODES.permissionDenied, file: requested },
    )
  }
  const canonical = await realpath(candidate)
  if (!contained(workspaceRoot, canonical)) {
    throw new RalphError(
      "RALPH_CHECKPOINT_PRD_OUTSIDE_WORKSPACE",
      "Checkpoint PRD resolves outside the workspace",
      { exitCode: EXIT_CODES.permissionDenied, file: requested },
    )
  }
  return {
    path: portable(relative(workspaceRoot, canonical)),
    sha256: sha256(await readFile(canonical)),
  }
}

async function gitInventory(input: {
  workspaceRoot: string
  git: GitCommandPort
  signal?: AbortSignal
}): Promise<GitCheckpointInventory> {
  const baseline = await inspectGitBaseline(input.workspaceRoot, input.git, input.signal)
  const diff = await input.git.run({
    cwd: baseline.repositoryRoot,
    args: ["diff", "--binary", "--full-index", "HEAD", "--"],
    timeoutMs: 10 * 60 * 1_000,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (
    diff.exitCode !== 0 ||
    diff.timedOut ||
    diff.cancelled ||
    diff.outputTruncated ||
    diff.rawOutputTruncated
  ) {
    throw new RalphError(
      "RALPH_CHECKPOINT_GIT_DIFF_FAILED",
      "Could not capture a complete Git diff for the checkpoint boundary",
      {
        exitCode: EXIT_CODES.operationalError,
        details: {
          exitCode: diff.exitCode,
          timedOut: diff.timedOut,
          cancelled: diff.cancelled,
          outputTruncated: diff.outputTruncated ?? false,
          rawOutputTruncated: diff.rawOutputTruncated ?? false,
          stderr: diff.stderr.slice(0, 8_192),
        },
      },
    )
  }
  return {
    head: baseline.head,
    ...(baseline.branch ? { branch: baseline.branch } : {}),
    status: baseline.porcelain,
    diff: diff.stdout,
  }
}

function assertRunScope(
  workspace: InitializedCheckpointWorkspace,
  runId: string | undefined,
): void {
  if (!runId) return
  const run = getRun(workspace.layout.ledger, runId)
  if (!run || run.workspaceId !== workspace.workspaceId) {
    throw new RalphError("RALPH_CHECKPOINT_RUN_NOT_FOUND", `Run was not found: ${runId}`, {
      exitCode: EXIT_CODES.notFound,
    })
  }
}

export async function createCheckpointCommand(input: {
  workspaceRoot: string
  environment: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
  prd?: string
  runId?: string
  reason?: string
  paths: readonly string[]
  inventoryRoots: readonly string[]
}): Promise<Record<string, unknown>> {
  const workspace = await initializedWorkspace(input.workspaceRoot, input.environment)
  assertRunScope(workspace, input.runId)
  const revision = await prdRevision(workspace.root, input.prd)
  const git = createGitCommandPort(input.environment)
  const inventory = await gitInventory({
    workspaceRoot: workspace.root,
    git,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const checkpoint = await createWorkspaceCheckpoint({
    ledgerPath: workspace.layout.ledger,
    checkpointRoot: workspace.layout.checkpoints,
    workspaceRoot: workspace.root,
    workspaceId: workspace.workspaceId,
    ...(input.runId ? { runId: input.runId } : {}),
    reason: input.reason?.trim() || "Explicit command-created checkpoint",
    createdBy: "ralph-cli",
    relevantPaths: [...new Set([revision.path, ...input.paths])],
    inventoryRoots: [...new Set(input.inventoryRoots)],
    git: inventory,
    prdRevisionHash: revision.sha256,
    stateRevision: readEventHighWater(workspace.layout.ledger),
  })
  return {
    schemaVersion: 1,
    id: checkpoint.id,
    status: checkpoint.status,
    createdAt: checkpoint.createdAt,
    reason: checkpoint.reason,
    manifestHash: checkpoint.manifestHash,
    files: checkpoint.files.length,
    inventoryRoots: checkpoint.inventoryRoots,
    gitHead: checkpoint.gitHead ?? null,
    gitBranch: checkpoint.gitBranch ?? null,
    prdRevisionHash: checkpoint.prdRevisionHash,
    stateRevision: checkpoint.stateRevision,
    mutationPerformed: true,
  }
}

export async function previewRollbackCommand(input: {
  workspaceRoot: string
  environment: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
  checkpointId: string
  prd?: string
  expiresInMs?: number
}): Promise<Record<string, unknown>> {
  const workspace = await initializedWorkspace(input.workspaceRoot, input.environment)
  const revision = await prdRevision(workspace.root, input.prd)
  const inventory = await gitInventory({
    workspaceRoot: workspace.root,
    git: createGitCommandPort(input.environment),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const plan = await previewCheckpointRollback({
    ledgerPath: workspace.layout.ledger,
    workspaceRoot: workspace.root,
    workspaceId: workspace.workspaceId,
    checkpointId: input.checkpointId,
    ...(inventory.head ? { currentGitHead: inventory.head } : {}),
    currentPrdRevisionHash: revision.sha256,
    currentStateRevision: readEventHighWater(workspace.layout.ledger),
    ...(input.expiresInMs ? { expiresInMs: input.expiresInMs } : {}),
  })
  return {
    schemaVersion: 1,
    id: plan.id,
    checkpointId: plan.checkpointId,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    planHash: plan.planHash,
    operations: plan.operations,
    conflicts: plan.conflicts,
    operationCount: plan.operations.length,
    conflictCount: plan.conflicts.length,
    requiresExplicitConfirmation: plan.requiresExplicitConfirmation,
    requiresSafetyCheckpoint: plan.requiresSafetyCheckpoint,
    mutationPerformed: false,
  }
}

export async function applyRollbackCommand(input: {
  workspaceRoot: string
  environment: Readonly<Record<string, string | undefined>>
  signal?: AbortSignal
  rollbackPlanId: string
  confirmationPlanHash: string
  prd?: string
}): Promise<Record<string, unknown>> {
  const workspace = await initializedWorkspace(input.workspaceRoot, input.environment)
  const revision = await prdRevision(workspace.root, input.prd)
  const inventory = await gitInventory({
    workspaceRoot: workspace.root,
    git: createGitCommandPort(input.environment),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const applied = await applyCheckpointRollback({
    ledgerPath: workspace.layout.ledger,
    checkpointRoot: workspace.layout.checkpoints,
    workspaceRoot: workspace.root,
    workspaceId: workspace.workspaceId,
    rollbackPlanId: input.rollbackPlanId,
    confirmationPlanHash: input.confirmationPlanHash,
    git: inventory,
    prdRevisionHash: revision.sha256,
    stateRevision: readEventHighWater(workspace.layout.ledger),
    actor: "ralph-cli",
  })
  return {
    schemaVersion: 1,
    rollbackPlanId: input.rollbackPlanId,
    checkpointId: applied.checkpoint.id,
    checkpointStatus: applied.checkpoint.status,
    appliedAt: applied.checkpoint.appliedAt ?? null,
    safetyCheckpointId: applied.safetyCheckpoint.id,
    safetyCheckpointManifestHash: applied.safetyCheckpoint.manifestHash,
    mutationPerformed: true,
  }
}
