import { join } from "node:path"
import { type RecoveryManifest, RecoveryManifestSchema } from "@ralph/domain"
import type { RunLayout } from "@ralph/persistence"
import { hashCanonicalValue } from "@ralph/prd"
import { processShutdownRegistry } from "@ralph/supervisor"
import {
  compareWorkspaceBaselines,
  persistContentAddressedBytes,
  type WorkspaceBaseline,
  type WorkspaceChanges,
} from "@ralph/verification"

export const DEFAULT_MAX_RECOVERY_FILES = 512
export const DEFAULT_MAX_RECOVERY_MANIFEST_BYTES = 224 * 1_024
const MAX_GIT_UNTRACKED_OUTPUT_BYTES = 4 * 1_024 * 1_024
const GIT_UNTRACKED_TIMEOUT_MS = 10_000

export type RecoveryDiffBinding = {
  ref: string
  contentHash: string
  reproducible: boolean
}

export type BuildRecoveryManifestInput = {
  workspaceRoot: string
  storageRoot?: string
  runLayout: RunLayout
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  taskBaseline: WorkspaceBaseline
  observedWorkspace: WorkspaceBaseline
  previousAttemptIds?: readonly string[]
  unsettledToolCallIds?: readonly string[]
  expectedWorkspaceHash?: string
  diff?: RecoveryDiffBinding
  maxFiles?: number
  maxManifestBytes?: number
  capturedAt?: string
}

export type PersistedRecoveryManifest = {
  manifest: RecoveryManifest
  storageHash: string
  ref: string
  sizeBytes: number
}

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function safeRelativePath(path: string): boolean {
  const normalized = portable(path)
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !normalized.split("/").includes("..") &&
    !normalized.includes("\0")
  )
}

async function collectBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onOverflow: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    total += item.value.byteLength
    if (total > maximumBytes) {
      onOverflow()
      throw new Error(`Git untracked inventory exceeds ${maximumBytes} bytes`)
    }
    chunks.push(item.value.slice())
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function captureGitUntrackedPaths(
  workspaceRoot: string,
): Promise<{ paths: string[]; available: boolean; note?: string }> {
  const git = Bun.which("git")
  if (!git) return { paths: [], available: false, note: "Git executable is unavailable" }
  const child = Bun.spawn([git, "ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: workspaceRoot,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  })
  const unregisterProcess = processShutdownRegistry.register({
    pid: child.pid,
    cancel: async () => {
      child.kill()
    },
    forceKill: async () => {
      child.kill(9)
    },
  })
  void child.exited.finally(unregisterProcess).catch(() => undefined)
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill(9)
  }, GIT_UNTRACKED_TIMEOUT_MS)
  try {
    let output: Uint8Array
    try {
      output = await collectBoundedStream(child.stdout, MAX_GIT_UNTRACKED_OUTPUT_BYTES, () =>
        child.kill(9),
      )
    } catch (error) {
      await child.exited.catch(() => undefined)
      return { paths: [], available: false, note: String(error) }
    }
    const exitCode = await child.exited
    if (timedOut) {
      return { paths: [], available: false, note: "Git untracked inventory timed out" }
    }
    if (exitCode !== 0) {
      return {
        paths: [],
        available: false,
        note: `Git untracked inventory exited with code ${exitCode}`,
      }
    }
    const paths = new TextDecoder()
      .decode(output)
      .split("\0")
      .map(portable)
      .filter(safeRelativePath)
    return { paths: [...new Set(paths)].sort(), available: true }
  } finally {
    clearTimeout(timeout)
  }
}

function recoveryFile(
  path: string,
  kind: "created" | "modified" | "deleted",
  before: WorkspaceBaseline,
  after: WorkspaceBaseline,
) {
  const previous = before.files[path]
  const current = after.files[path]
  return {
    path,
    kind,
    ...(previous?.sha256 ? { beforeSha256: previous.sha256 } : {}),
    ...(current?.sha256 ? { afterSha256: current.sha256 } : {}),
    ...(previous?.contentRef ? { beforeRef: previous.contentRef } : {}),
    ...(current?.contentRef ? { afterRef: current.contentRef } : {}),
  }
}

function changeKind(changes: WorkspaceChanges, path: string): "created" | "modified" | "deleted" {
  if (changes.created.includes(path)) return "created"
  if (changes.modified.includes(path)) return "modified"
  return "deleted"
}

function manifestWithoutHash(input: {
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  taskBaseline: WorkspaceBaseline
  observedWorkspace: WorkspaceBaseline
  changes: WorkspaceChanges
  untracked: readonly string[]
  untrackedAvailable: boolean
  untrackedNote?: string
  previousAttemptIds: readonly string[]
  unsettledToolCallIds: readonly string[]
  expectedWorkspaceHash?: string
  diff?: RecoveryDiffBinding
  maximumFiles: number
  capturedAt: string
}) {
  const allPaths = [...input.changes.changed].sort()
  const includedPaths = allPaths.slice(0, input.maximumFiles)
  const omittedPaths = allPaths.slice(includedPaths.length)
  const omittedInventory = [
    ...new Set([...omittedPaths, ...input.untracked.slice(input.maximumFiles)]),
  ].sort()
  const expectedMismatch =
    input.expectedWorkspaceHash !== undefined &&
    input.expectedWorkspaceHash !== input.observedWorkspace.snapshotHash
  const externalMutation = expectedMismatch
    ? "suspected"
    : allPaths.length > 0
      ? "unknown"
      : "not-detected"
  const state =
    allPaths.length === 0
      ? ("clean" as const)
      : externalMutation === "suspected"
        ? ("workspace_changed" as const)
        : ("continued" as const)
  const requiresOperatorDecision = state === "workspace_changed"
  const availableActions = ["continue", "inspect", "checkpoint", "rollback-explicit"] as const
  const recommendedAction = requiresOperatorDecision ? ("inspect" as const) : ("continue" as const)
  const notes = [
    ...(state === "continued"
      ? ["Partial workspace changes are preserved and supplied to the next attempt."]
      : []),
    ...(state === "workspace_changed"
      ? ["Workspace state differs from the expected observation; no reset or rollback was applied."]
      : []),
    ...(!input.untrackedAvailable
      ? [
          input.untrackedNote ??
            "Untracked Git inventory is unavailable; changed paths remain listed.",
        ]
      : []),
    ...(input.unsettledToolCallIds.length > 0
      ? ["Unsettled tool calls require reconciliation before an unsafe replay."]
      : []),
  ]
  const body = {
    schemaVersion: 1 as const,
    id: `recovery-${hashCanonicalValue("ralph.recovery-identity.v1", {
      runId: input.runId,
      documentId: input.documentId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      observedWorkspaceHash: input.observedWorkspace.snapshotHash,
    })}`,
    runId: input.runId,
    documentId: input.documentId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    state,
    taskBaselineHash: input.taskBaseline.snapshotHash,
    observedWorkspaceHash: input.observedWorkspace.snapshotHash,
    ...(input.expectedWorkspaceHash ? { expectedWorkspaceHash: input.expectedWorkspaceHash } : {}),
    externalMutation,
    ...(input.diff ? { diff: input.diff } : {}),
    changes: {
      total: allPaths.length,
      included: includedPaths.length,
      truncated: omittedInventory.length > 0,
      ...(omittedInventory.length > 0
        ? {
            omittedPathsHash: hashCanonicalValue(
              "ralph.recovery-omitted-paths.v1",
              omittedInventory,
            ),
          }
        : {}),
      created: input.changes.created.filter((path) => includedPaths.includes(path)),
      modified: input.changes.modified.filter((path) => includedPaths.includes(path)),
      deleted: input.changes.deleted.filter((path) => includedPaths.includes(path)),
      untrackedTotal: input.untracked.length,
      untracked: input.untracked.slice(0, input.maximumFiles),
      outsideScope: input.changes.outsideScope.filter((path) => includedPaths.includes(path)),
      files: includedPaths.map((path) =>
        recoveryFile(
          path,
          changeKind(input.changes, path),
          input.taskBaseline,
          input.observedWorkspace,
        ),
      ),
    },
    previousAttemptIds: [...input.previousAttemptIds],
    unsettledToolCallIds: [...input.unsettledToolCallIds],
    availableActions: [...availableActions],
    recommendedAction,
    requiresOperatorDecision,
    notes,
    capturedAt: input.capturedAt,
  }
  return body
}

export async function buildAndPersistRecoveryManifest(
  input: BuildRecoveryManifestInput,
): Promise<PersistedRecoveryManifest> {
  let maximumFiles = input.maxFiles ?? DEFAULT_MAX_RECOVERY_FILES
  if (!Number.isSafeInteger(maximumFiles) || maximumFiles <= 0) {
    throw new Error("Recovery manifest maxFiles must be a positive safe integer")
  }
  const maximumManifestBytes = input.maxManifestBytes ?? DEFAULT_MAX_RECOVERY_MANIFEST_BYTES
  if (!Number.isSafeInteger(maximumManifestBytes) || maximumManifestBytes <= 0) {
    throw new Error("Recovery manifest maxManifestBytes must be a positive safe integer")
  }
  const changes = compareWorkspaceBaselines(input.taskBaseline, input.observedWorkspace)
  if (changes.hasChanges && !input.diff) {
    throw new Error("Changed recovery state requires a persisted diff binding")
  }
  const untracked = await captureGitUntrackedPaths(input.workspaceRoot)
  let manifest: RecoveryManifest
  let bytes: Uint8Array
  while (true) {
    const body = manifestWithoutHash({
      runId: input.runId,
      documentId: input.documentId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      taskBaseline: input.taskBaseline,
      observedWorkspace: input.observedWorkspace,
      changes,
      untracked: untracked.paths,
      untrackedAvailable: untracked.available,
      ...(untracked.note ? { untrackedNote: untracked.note } : {}),
      previousAttemptIds: input.previousAttemptIds ?? [],
      unsettledToolCallIds: input.unsettledToolCallIds ?? [],
      ...(input.expectedWorkspaceHash
        ? { expectedWorkspaceHash: input.expectedWorkspaceHash }
        : {}),
      ...(input.diff ? { diff: input.diff } : {}),
      maximumFiles,
      capturedAt: input.capturedAt ?? new Date().toISOString(),
    })
    manifest = RecoveryManifestSchema.parse({
      ...body,
      contentHash: hashCanonicalValue("ralph.recovery-manifest.v1", body),
    })
    bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    if (bytes.byteLength <= maximumManifestBytes) break
    if (maximumFiles === 1) {
      throw new Error(
        `Recovery manifest cannot fit the ${maximumManifestBytes} byte authenticated budget`,
      )
    }
    maximumFiles = Math.max(1, Math.floor(maximumFiles / 2))
  }
  const persisted = await persistContentAddressedBytes(
    input.storageRoot ?? input.workspaceRoot,
    { directory: join(input.runLayout.evidence, "recovery") },
    bytes,
    { suffix: ".json" },
  )
  return {
    manifest,
    storageHash: persisted.contentHash,
    ref: persisted.ref,
    sizeBytes: bytes.byteLength,
  }
}
