import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { ContextManifestSchema, EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  canonicalDirectory,
  getRun,
  inspectWorkspace,
  listAttempts,
  listCheckpoints,
  listModelCalls,
  listRuns,
  readCheckpoint,
  runLayout,
  workspaceLayout,
  writeFileAtomic,
} from "@ralph-next/persistence"

const MAX_CONTEXT_MANIFEST_BYTES = 2 * 1024 * 1024
const CHECKPOINT_FILE_PREVIEW = 100

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new RalphError(
      "RALPH_OPERATIONAL_LIMIT_INVALID",
      "Operational inspection limit must be an integer between 1 and 1000",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  return value
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

function portable(path: string): string {
  return path.split(sep).join("/")
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`))
}

async function initializedWorkspace(root: string): Promise<{
  root: string
  workspaceId: string
  layout: ReturnType<typeof workspaceLayout>
}> {
  const canonical = await canonicalDirectory(root)
  const status = await inspectWorkspace(canonical, { exact: true })
  if (!status.initialized || !status.workspaceId) {
    throw new RalphError(
      "RALPH_OPERATIONAL_WORKSPACE_REQUIRED",
      "This operational inspection requires an initialized Ralph v2 workspace",
      { exitCode: EXIT_CODES.blocked },
    )
  }
  return { root: canonical, workspaceId: status.workspaceId, layout: workspaceLayout(canonical) }
}

async function readContextManifest(
  workspaceRoot: string,
  path: string,
  expectedHash: string,
): Promise<Record<string, unknown>> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) {
      return { integrity: "unsafe", reason: "manifest is not a regular non-linked file" }
    }
    if (info.size > MAX_CONTEXT_MANIFEST_BYTES) {
      return { integrity: "oversized", bytes: info.size }
    }
    const canonical = await realpath(path)
    if (!contained(workspaceRoot, canonical)) {
      return { integrity: "unsafe", reason: "manifest resolves outside workspace" }
    }
    const bytes = await readFile(canonical)
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(bytes).toString("utf8"))
    } catch {
      return { integrity: "invalid-json", bytes: bytes.byteLength, fileSha256: sha256(bytes) }
    }
    const parsed = ContextManifestSchema.safeParse(decoded)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return {
        integrity: "invalid-schema",
        bytes: bytes.byteLength,
        fileSha256: sha256(bytes),
        ...(issue ? { issue: { path: issue.path.join("."), message: issue.message } } : {}),
      }
    }
    const manifest = parsed.data
    return {
      integrity: manifest.contentHash === expectedHash ? "verified" : "hash-mismatch",
      bytes: bytes.byteLength,
      fileSha256: sha256(bytes),
      contentHash: manifest.contentHash,
      id: manifest.id,
      mode: manifest.mode,
      task: {
        documentId: manifest.task.documentId,
        taskId: manifest.task.taskId,
        taskSpecHash: manifest.task.taskSpecHash,
        evidenceMode: manifest.task.evidenceMode,
      },
      createdAt: manifest.createdAt,
      budget: manifest.budget,
      authority: manifest.authority,
      references: {
        parent: manifest.parentContextRefs.length,
        dependencies: manifest.dependencyOutputs.length,
        declaredFiles: manifest.declaredFileRefs.length,
        previousAssessment: manifest.previousAssessmentRef ? 1 : 0,
        recovery: manifest.recovery ? 1 : 0,
        fullPrd: manifest.fullPrd ? 1 : 0,
      },
      sensitiveContentIncluded: false,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { integrity: "missing" }
    throw error
  }
}

export async function inspectPersistedContext(options: {
  readonly workspaceRoot: string
  readonly runId?: string
  readonly limit: number
}): Promise<Record<string, unknown>> {
  const limit = boundedLimit(options.limit)
  const workspace = await initializedWorkspace(options.workspaceRoot)
  const run = options.runId
    ? getRun(workspace.layout.ledger, options.runId)
    : listRuns(workspace.layout.ledger, { workspaceId: workspace.workspaceId, limit: 1 })[0]
  if (!run || run.workspaceId !== workspace.workspaceId) {
    throw new RalphError(
      "RALPH_CONTEXT_RUN_NOT_FOUND",
      options.runId ? `Run was not found: ${options.runId}` : "No persisted run is available",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const attempts = listAttempts(workspace.layout.ledger, { runId: run.id })
  const selectedAttempts = attempts.slice(-limit)
  const layout = runLayout(workspace.layout, run.id)
  const contexts: Record<string, unknown>[] = []
  let contextBindings = 0
  for (const attempt of selectedAttempts) {
    const calls = listModelCalls(workspace.layout.ledger, attempt.id)
    const bindings: Array<{
      callId?: string
      ordinal: number
      contextManifestHash: string
      status: string
    }> =
      calls.length > 0
        ? calls.map((call) => ({
            callId: call.id,
            ordinal: call.ordinal,
            contextManifestHash: call.contextManifestHash,
            status: call.status,
          }))
        : [
            {
              ordinal: 1,
              contextManifestHash: attempt.contextManifestHash,
              status: "not-called",
            },
          ]
    contextBindings += bindings.length
    for (const binding of bindings) {
      if (contexts.length >= limit) continue
      const directory =
        binding.ordinal === 1
          ? join(layout.context, attempt.id)
          : join(layout.context, attempt.id, `call-${String(binding.ordinal).padStart(4, "0")}`)
      const path = join(directory, "manifest.json")
      contexts.push({
        attemptId: attempt.id,
        documentId: attempt.documentId,
        taskId: attempt.taskId,
        attemptOrdinal: attempt.ordinal,
        callOrdinal: binding.ordinal,
        ...(binding.callId ? { callId: binding.callId } : {}),
        callStatus: binding.status,
        expectedContextManifestHash: binding.contextManifestHash,
        path: portable(relative(workspace.root, path)),
        ...(await readContextManifest(workspace.root, path, binding.contextManifestHash)),
      })
    }
  }
  return {
    schemaVersion: 1,
    workspaceRoot: workspace.root,
    run: {
      id: run.id,
      status: run.status,
      mode: run.mode,
      rootPrdId: run.rootPrdId,
      graphHash: run.graphHash,
      updatedAt: run.updatedAt,
    },
    attempts: selectedAttempts.length,
    totalAttempts: attempts.length,
    truncatedAttempts: attempts.length - selectedAttempts.length,
    contexts,
    totalContextBindings: contextBindings,
    truncatedContexts: Math.max(0, contextBindings - contexts.length),
    exportPolicy: "metadata-only",
  }
}

async function outputSnapshot(path: string): Promise<{ exists: boolean; hash?: string }> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new RalphError(
        "RALPH_CONTEXT_EXPORT_OUTPUT_UNSAFE",
        "Context export output must be a regular non-linked file",
        { exitCode: EXIT_CODES.policyDenied, file: path },
      )
    }
    return { exists: true, hash: sha256(await readFile(path)) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }
    throw error
  }
}

export async function exportPersistedContext(options: {
  readonly workspaceRoot: string
  readonly runId?: string
  readonly limit: number
  readonly output: string
  readonly force: boolean
}): Promise<{
  readonly output: string
  readonly sha256: string
  readonly overwritten: boolean
  readonly policy: "metadata-only"
  readonly inspection: Record<string, unknown>
}> {
  const workspace = await initializedWorkspace(options.workspaceRoot)
  const requested = resolve(workspace.root, options.output)
  const parent = await canonicalDirectory(dirname(requested))
  const target = resolve(parent, basename(requested))
  if (!contained(workspace.root, target) || target === workspace.root) {
    throw new RalphError(
      "RALPH_CONTEXT_EXPORT_OUTSIDE_WORKSPACE",
      "Context export output must be a file inside the workspace",
      { exitCode: EXIT_CODES.policyDenied, file: target },
    )
  }
  const baseline = await outputSnapshot(target)
  if (baseline.exists && !options.force) {
    throw new RalphError(
      "RALPH_CONTEXT_EXPORT_EXISTS",
      "Context export refuses to overwrite an existing file without --force",
      { exitCode: EXIT_CODES.policyDenied, file: target },
    )
  }
  const inspection = await inspectPersistedContext({
    workspaceRoot: workspace.root,
    ...(options.runId ? { runId: options.runId } : {}),
    limit: options.limit,
  })
  const content = `${JSON.stringify(inspection, null, 2)}\n`
  await writeFileAtomic(target, content, {
    overwrite: options.force,
    beforeCommit: async () => {
      const current = await outputSnapshot(target)
      if (current.exists !== baseline.exists || current.hash !== baseline.hash) {
        throw new RalphError(
          "RALPH_CONTEXT_EXPORT_CHANGED",
          "Context export output changed before the write committed",
          { exitCode: EXIT_CODES.conflict, file: target },
        )
      }
    },
  })
  return {
    output: target,
    sha256: sha256(content),
    overwritten: baseline.exists,
    policy: "metadata-only",
    inspection,
  }
}

export async function listOperationalCheckpoints(options: {
  readonly workspaceRoot: string
  readonly runId?: string
  readonly limit: number
}): Promise<{
  readonly count: number
  readonly checkpoints: readonly Record<string, unknown>[]
}> {
  const limit = boundedLimit(options.limit)
  const workspace = await initializedWorkspace(options.workspaceRoot)
  if (options.runId) {
    const run = getRun(workspace.layout.ledger, options.runId)
    if (!run || run.workspaceId !== workspace.workspaceId) {
      throw new RalphError(
        "RALPH_CHECKPOINT_RUN_NOT_FOUND",
        `Run was not found: ${options.runId}`,
        {
          exitCode: EXIT_CODES.invalidUsage,
        },
      )
    }
  }
  const checkpoints = listCheckpoints(workspace.layout.ledger, {
    workspaceId: workspace.workspaceId,
    ...(options.runId ? { runId: options.runId } : {}),
    limit,
  }).map((checkpoint) => ({
    id: checkpoint.id,
    status: checkpoint.status,
    reason: checkpoint.reason,
    createdAt: checkpoint.createdAt,
    ...(checkpoint.appliedAt ? { appliedAt: checkpoint.appliedAt } : {}),
    ...(checkpoint.runId ? { runId: checkpoint.runId } : {}),
    ...(checkpoint.taskId ? { taskId: checkpoint.taskId } : {}),
    ...(checkpoint.attemptId ? { attemptId: checkpoint.attemptId } : {}),
    manifestHash: checkpoint.manifestHash,
    files: checkpoint.files.length,
    inventoryRoots: checkpoint.inventoryRoots.length,
    gitHead: checkpoint.gitHead ?? null,
    gitBranch: checkpoint.gitBranch ?? null,
  }))
  return { count: checkpoints.length, checkpoints }
}

export async function showOperationalCheckpoint(options: {
  readonly workspaceRoot: string
  readonly checkpointId: string
}): Promise<Record<string, unknown>> {
  const workspace = await initializedWorkspace(options.workspaceRoot)
  const checkpoint = readCheckpoint(workspace.layout.ledger, options.checkpointId)
  if (!checkpoint || checkpoint.workspaceId !== workspace.workspaceId) {
    throw new RalphError(
      "RALPH_CHECKPOINT_NOT_FOUND",
      `Checkpoint was not found: ${options.checkpointId}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  return {
    schemaVersion: 1,
    id: checkpoint.id,
    workspaceId: checkpoint.workspaceId,
    ...(checkpoint.runId ? { runId: checkpoint.runId } : {}),
    ...(checkpoint.taskId ? { taskId: checkpoint.taskId } : {}),
    ...(checkpoint.attemptId ? { attemptId: checkpoint.attemptId } : {}),
    reason: checkpoint.reason,
    createdBy: checkpoint.createdBy,
    createdAt: checkpoint.createdAt,
    repositoryRoot: checkpoint.repositoryRoot,
    gitHead: checkpoint.gitHead ?? null,
    gitBranch: checkpoint.gitBranch ?? null,
    gitStatusHash: checkpoint.gitStatusHash,
    gitStatusRef: checkpoint.gitStatusRef ?? null,
    gitDiffHash: checkpoint.gitDiffHash,
    gitDiffRef: checkpoint.gitDiffRef ?? null,
    prdRevisionHash: checkpoint.prdRevisionHash,
    stateRevision: checkpoint.stateRevision,
    ledgerBackupRef: checkpoint.ledgerBackupRef ?? null,
    manifestHash: checkpoint.manifestHash,
    status: checkpoint.status,
    appliedAt: checkpoint.appliedAt ?? null,
    fileCount: checkpoint.files.length,
    filePreview: checkpoint.files.slice(0, CHECKPOINT_FILE_PREVIEW),
    filesTruncated: Math.max(0, checkpoint.files.length - CHECKPOINT_FILE_PREVIEW),
    inventoryRoots: checkpoint.inventoryRoots,
    mutationPerformed: false,
  }
}
