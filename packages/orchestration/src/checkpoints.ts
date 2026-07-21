import { createHash } from "node:crypto"
import { chmod, lstat, readdir, readFile, realpath, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  type CheckpointFileEntry,
  type CheckpointInventoryRoot,
  type CheckpointRecord,
  CheckpointRecordSchema,
  EXIT_CODES,
  RalphError,
  type RollbackConflict,
  type RollbackOperation,
  type RollbackPlan,
  RollbackPlanSchema,
} from "@ralph/domain"
import {
  createLedgerCheckpointBackup,
  ensureCheckpointStore,
  persistCheckpoint,
  persistRollbackPlan,
  readCheckpoint,
  readRollbackPlan,
  settleRollbackPlan,
  writeFileAtomic,
  writeJsonAtomic,
} from "@ralph/persistence"

export type GitCheckpointInventory = {
  head?: string
  branch?: string
  status: string
  diff: string
}

export type ExpectedRollbackFileState = {
  path: string
  kind: "file" | "missing"
  sha256?: string
}

type CurrentFileState = {
  path: string
  kind: "file" | "missing"
  sha256?: string
  sizeBytes: number
  executable: boolean
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("und") : value
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function portable(value: string): string {
  return value.replaceAll("\\", "/")
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function hashCanonical(namespace: string, value: unknown): string {
  return sha256(`${namespace}\0${canonicalJson(value)}`)
}

function safeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (
    !normalized ||
    isAbsolute(normalized) ||
    /(^|\/)\.\.(\/|$)/.test(normalized) ||
    normalized.includes("\0") ||
    normalized.startsWith(".ralph/") ||
    normalized === ".ralph"
  ) {
    throw new RalphError(
      "RALPH_CHECKPOINT_PATH_INVALID",
      "Checkpoint paths must be relative workspace files outside the Ralph control plane",
      { exitCode: EXIT_CODES.invalidUsage, details: { path: value } },
    )
  }
  return normalized
}

async function canonicalWorkspaceFile(
  workspaceRoot: string,
  path: string,
): Promise<{ workspace: string; relativePath: string; absolutePath: string }> {
  const workspace = await realpath(resolve(workspaceRoot))
  const relativePath = safeRelativePath(path)
  const absolutePath = resolve(workspace, relativePath)
  if (!contained(workspace, absolutePath)) {
    throw new RalphError("RALPH_CHECKPOINT_PATH_ESCAPE", "Checkpoint path escapes workspace", {
      exitCode: EXIT_CODES.permissionDenied,
      file: absolutePath,
    })
  }
  return { workspace, relativePath, absolutePath }
}

async function existingAncestor(path: string): Promise<string> {
  let cursor = path
  while (true) {
    try {
      await lstat(cursor)
      return realpath(cursor)
    } catch (error) {
      if (!missing(error)) throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      cursor = parent
    }
  }
}

function missing(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT",
  )
}

async function captureCurrentFile(workspaceRoot: string, path: string): Promise<CurrentFileState> {
  const target = await canonicalWorkspaceFile(workspaceRoot, path)
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(target.absolutePath)
  } catch (error) {
    if (missing(error)) {
      const anchor = await existingAncestor(dirname(target.absolutePath))
      if (!contained(target.workspace, anchor)) {
        throw new RalphError(
          "RALPH_CHECKPOINT_PATH_ESCAPE",
          "Missing checkpoint target has an ancestor outside the workspace",
          { exitCode: EXIT_CODES.permissionDenied, file: target.absolutePath },
        )
      }
      return { path: target.relativePath, kind: "missing", sizeBytes: 0, executable: false }
    }
    throw error
  }
  if (info.isSymbolicLink()) {
    throw new RalphError(
      "RALPH_CHECKPOINT_SYMLINK_UNSUPPORTED",
      "Checkpoint refuses symbolic-link or junction file entries",
      { exitCode: EXIT_CODES.permissionDenied, file: target.absolutePath },
    )
  }
  if (!info.isFile()) {
    throw new RalphError(
      "RALPH_CHECKPOINT_FILE_REQUIRED",
      "Checkpoint inventory must expand directories into explicit regular files",
      { exitCode: EXIT_CODES.invalidUsage, file: target.absolutePath },
    )
  }
  const canonical = await realpath(target.absolutePath)
  if (!contained(target.workspace, canonical)) {
    throw new RalphError(
      "RALPH_CHECKPOINT_PATH_ESCAPE",
      "Checkpoint file resolves outside the workspace",
      { exitCode: EXIT_CODES.permissionDenied, file: canonical },
    )
  }
  const content = await readFile(canonical)
  return {
    path: target.relativePath,
    kind: "file",
    sha256: sha256(content),
    sizeBytes: content.byteLength,
    executable: (info.mode & 0o111) !== 0,
  }
}

async function persistBlob(
  checkpointRoot: string,
  content: Uint8Array,
  expectedHash = sha256(content),
): Promise<string> {
  const ref = portable(join("blobs", expectedHash.slice(0, 2), expectedHash))
  const target = resolve(checkpointRoot, ref)
  try {
    const existing = await readFile(target)
    if (sha256(existing) !== expectedHash) {
      throw new RalphError(
        "RALPH_CHECKPOINT_BLOB_CORRUPT",
        "Existing content-addressed checkpoint blob has the wrong hash",
        { exitCode: EXIT_CODES.conflict, file: target },
      )
    }
    return ref
  } catch (error) {
    if (!missing(error)) throw error
  }
  await writeFileAtomic(target, content, { overwrite: false })
  const persisted = await readFile(target)
  if (sha256(persisted) !== expectedHash) {
    throw new RalphError(
      "RALPH_CHECKPOINT_BLOB_CORRUPT",
      "Checkpoint blob changed while being persisted",
      { exitCode: EXIT_CODES.conflict, file: target },
    )
  }
  return ref
}

function checkpointStoreRoot(workspace: string, checkpointRoot: string): string {
  const expected = resolve(workspace, ".ralph", "checkpoints")
  const observed = resolve(checkpointRoot)
  if (comparable(expected) !== comparable(observed)) {
    throw new RalphError(
      "RALPH_CHECKPOINT_ROOT_INVALID",
      "Checkpoint store must be the workspace-managed .ralph/checkpoints directory",
      {
        exitCode: EXIT_CODES.permissionDenied,
        details: { expected, observed },
      },
    )
  }
  return observed
}

async function scanInventoryRoot(input: {
  workspace: string
  path: string
  maximumFiles: number
}): Promise<{ root: CheckpointInventoryRoot; files: readonly CurrentFileState[] }> {
  const relativeRoot = safeRelativePath(input.path)
  const absoluteRoot = resolve(input.workspace, relativeRoot)
  let rootInfo: Awaited<ReturnType<typeof lstat>>
  try {
    rootInfo = await lstat(absoluteRoot)
  } catch (error) {
    if (!missing(error)) throw error
    const anchor = await existingAncestor(dirname(absoluteRoot))
    if (!contained(input.workspace, anchor)) {
      throw new RalphError(
        "RALPH_CHECKPOINT_PATH_ESCAPE",
        "Missing inventory root escapes the canonical workspace",
        { exitCode: EXIT_CODES.permissionDenied, file: absoluteRoot },
      )
    }
    return {
      root: {
        path: relativeRoot,
        kind: "missing",
        fileCount: 0,
        treeHash: hashCanonical("ralph.checkpoint.tree.v1", { path: relativeRoot, missing: true }),
      },
      files: [],
    }
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new RalphError(
      "RALPH_CHECKPOINT_INVENTORY_ROOT_INVALID",
      "Checkpoint inventory root must be a real directory or a missing future directory",
      { exitCode: EXIT_CODES.invalidUsage, file: absoluteRoot },
    )
  }
  const canonicalRoot = await realpath(absoluteRoot)
  if (!contained(input.workspace, canonicalRoot)) {
    throw new RalphError(
      "RALPH_CHECKPOINT_PATH_ESCAPE",
      "Checkpoint inventory root resolves outside the workspace",
      { exitCode: EXIT_CODES.permissionDenied, file: canonicalRoot },
    )
  }
  const queue = [canonicalRoot]
  const paths: string[] = []
  while (queue.length > 0) {
    const directory = queue.shift() as string
    const canonicalDirectory = await realpath(directory)
    if (!contained(canonicalRoot, canonicalDirectory)) {
      throw new RalphError(
        "RALPH_CHECKPOINT_PATH_ESCAPE",
        "Inventory directory changed through a symlink or junction",
        { exitCode: EXIT_CODES.permissionDenied, file: canonicalDirectory },
      )
    }
    const entries = (await readdir(canonicalDirectory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name, "en"),
    )
    for (const entry of entries) {
      const absolute = resolve(canonicalDirectory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new RalphError(
          "RALPH_CHECKPOINT_SYMLINK_UNSUPPORTED",
          "Checkpoint inventory roots cannot contain symlinks or junctions",
          { exitCode: EXIT_CODES.permissionDenied, file: absolute },
        )
      }
      if (entry.isDirectory()) queue.push(absolute)
      else if (entry.isFile()) paths.push(portable(relative(input.workspace, absolute)))
      else {
        throw new RalphError(
          "RALPH_CHECKPOINT_FILE_REQUIRED",
          "Checkpoint inventory contains an unsupported filesystem entry",
          { exitCode: EXIT_CODES.invalidUsage, file: absolute },
        )
      }
      if (paths.length > input.maximumFiles) {
        throw new RalphError(
          "RALPH_CHECKPOINT_LIMIT_EXCEEDED",
          "Checkpoint inventory root contains too many files",
          { exitCode: EXIT_CODES.conflict, details: { maximumFiles: input.maximumFiles } },
        )
      }
    }
  }
  const files: CurrentFileState[] = []
  for (const path of paths.sort()) files.push(await captureCurrentFile(input.workspace, path))
  return {
    root: {
      path: relativeRoot,
      kind: "directory",
      fileCount: files.length,
      treeHash: hashCanonical(
        "ralph.checkpoint.tree.v1",
        files.map((file) => ({ path: file.path, sha256: file.sha256 })),
      ),
    },
    files,
  }
}

export async function createWorkspaceCheckpoint(input: {
  ledgerPath: string
  checkpointRoot: string
  workspaceRoot: string
  workspaceId: string
  runId?: string
  taskId?: string
  attemptId?: string
  reason: string
  createdBy: string
  relevantPaths: readonly string[]
  inventoryRoots?: readonly string[]
  git: GitCheckpointInventory
  prdRevisionHash: string
  stateRevision: number
  maximumFileBytes?: number
  maximumTotalBytes?: number
  now?: () => Date
  id?: () => string
}): Promise<CheckpointRecord> {
  const now = input.now ?? (() => new Date())
  const id = input.id ?? (() => crypto.randomUUID())
  const workspace = await realpath(resolve(input.workspaceRoot))
  const root = checkpointStoreRoot(workspace, input.checkpointRoot)
  await ensureCheckpointStore(root)
  const checkpointId = id()
  if (!/^[A-Za-z0-9._-]{1,512}$/.test(checkpointId)) {
    throw new RalphError("RALPH_CHECKPOINT_ID_INVALID", "Checkpoint ID is not path-safe", {
      exitCode: EXIT_CODES.invalidUsage,
      details: { checkpointId },
    })
  }
  const maximumFileBytes = input.maximumFileBytes ?? 64 * 1_024 * 1_024
  const maximumTotalBytes = input.maximumTotalBytes ?? 512 * 1_024 * 1_024
  if (
    !Number.isSafeInteger(maximumFileBytes) ||
    maximumFileBytes < 1 ||
    !Number.isSafeInteger(maximumTotalBytes) ||
    maximumTotalBytes < maximumFileBytes
  ) {
    throw new RalphError("RALPH_CHECKPOINT_LIMIT_INVALID", "Checkpoint byte limits are invalid", {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  const rootScans = [] as {
    root: CheckpointInventoryRoot
    files: readonly CurrentFileState[]
  }[]
  for (const inventoryRoot of [...new Set(input.inventoryRoots ?? [])].sort()) {
    rootScans.push(
      await scanInventoryRoot({ workspace, path: inventoryRoot, maximumFiles: 100_000 }),
    )
  }
  const paths = [
    ...new Set([
      ...input.relevantPaths.map(safeRelativePath),
      ...rootScans.flatMap((scan) => scan.files.map((file) => file.path)),
    ]),
  ].sort()
  if (paths.length > 100_000) {
    throw new RalphError("RALPH_CHECKPOINT_LIMIT_EXCEEDED", "Checkpoint has too many paths", {
      exitCode: EXIT_CODES.invalidUsage,
      details: { count: paths.length },
    })
  }
  const files: CheckpointFileEntry[] = []
  let totalBytes = 0
  for (const path of paths) {
    const current = await captureCurrentFile(workspace, path)
    if (current.kind === "missing") {
      files.push({ path, kind: "missing", sizeBytes: 0, executable: false })
      continue
    }
    if (
      current.sizeBytes > maximumFileBytes ||
      totalBytes + current.sizeBytes > maximumTotalBytes
    ) {
      throw new RalphError(
        "RALPH_CHECKPOINT_LIMIT_EXCEEDED",
        "Checkpoint file inventory exceeds configured byte limits",
        {
          exitCode: EXIT_CODES.conflict,
          file: path,
          details: {
            sizeBytes: current.sizeBytes,
            totalBytes,
            maximumFileBytes,
            maximumTotalBytes,
          },
        },
      )
    }
    const content = await readFile(resolve(workspace, path))
    if (!current.sha256) throw new Error("Captured checkpoint file has no content hash")
    const ref = await persistBlob(root, content, current.sha256)
    files.push({
      path,
      kind: "file",
      sizeBytes: current.sizeBytes,
      sha256: current.sha256,
      contentRef: ref,
      executable: current.executable,
    })
    totalBytes += current.sizeBytes
  }
  const statusBytes = new TextEncoder().encode(input.git.status)
  const diffBytes = new TextEncoder().encode(input.git.diff)
  if (statusBytes.byteLength + diffBytes.byteLength > 64 * 1_024 * 1_024) {
    throw new RalphError(
      "RALPH_CHECKPOINT_LIMIT_EXCEEDED",
      "Git status and diff inventory exceeds the checkpoint metadata limit",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const gitStatusHash = sha256(statusBytes)
  const gitDiffHash = sha256(diffBytes)
  const gitStatusRef = await persistBlob(root, statusBytes, gitStatusHash)
  const gitDiffRef = await persistBlob(root, diffBytes, gitDiffHash)
  const ledgerBackupPath = await createLedgerCheckpointBackup({
    ledgerPath: input.ledgerPath,
    checkpointRoot: root,
    checkpointId,
  })
  const ledgerBackupRef = portable(relative(root, ledgerBackupPath))
  const createdAt = now().toISOString()
  const manifestProjection = {
    schemaVersion: 1,
    id: checkpointId,
    workspaceId: input.workspaceId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    reason: input.reason,
    createdBy: input.createdBy,
    createdAt,
    repositoryRoot: workspace,
    ...(input.git.head ? { gitHead: input.git.head } : {}),
    ...(input.git.branch ? { gitBranch: input.git.branch } : {}),
    gitStatusHash,
    gitStatusRef,
    gitDiffHash,
    gitDiffRef,
    prdRevisionHash: input.prdRevisionHash,
    stateRevision: input.stateRevision,
    ledgerBackupRef,
    files,
    inventoryRoots: rootScans.map((scan) => scan.root),
    status: "available" as const,
  }
  const record = CheckpointRecordSchema.parse({
    ...manifestProjection,
    manifestHash: hashCanonical("ralph.checkpoint.manifest.v1", manifestProjection),
  })
  await writeJsonAtomic(resolve(root, "manifests", `${checkpointId}.json`), record, {
    overwrite: false,
  })
  return persistCheckpoint(input.ledgerPath, record)
}

function expectedStateMap(
  values: readonly ExpectedRollbackFileState[],
): ReadonlyMap<string, ExpectedRollbackFileState> {
  const output = new Map<string, ExpectedRollbackFileState>()
  for (const value of values) {
    const path = safeRelativePath(value.path)
    if (output.has(path)) {
      throw new RalphError(
        "RALPH_ROLLBACK_EXPECTATION_INVALID",
        "Rollback expectation contains a duplicate path",
        { exitCode: EXIT_CODES.invalidUsage, details: { path } },
      )
    }
    if (value.kind === "file" && !value.sha256) {
      throw new RalphError(
        "RALPH_ROLLBACK_EXPECTATION_INVALID",
        "Expected file state requires sha256",
        { exitCode: EXIT_CODES.invalidUsage, details: { path } },
      )
    }
    output.set(path, { ...value, path })
  }
  return output
}

function stateMatchesExpected(
  current: CurrentFileState,
  expected: ExpectedRollbackFileState,
): boolean {
  return (
    current.kind === expected.kind &&
    (current.kind === "missing" || current.sha256 === expected.sha256)
  )
}

function currentInventoryHash(values: readonly CurrentFileState[]): string {
  return hashCanonical(
    "ralph.rollback.current-inventory.v1",
    values.map(({ path, kind, sha256: hash }) => ({
      path,
      kind,
      ...(hash ? { sha256: hash } : {}),
    })),
  )
}

export async function previewCheckpointRollback(input: {
  ledgerPath: string
  workspaceRoot: string
  workspaceId: string
  checkpointId: string
  /**
   * Optional caller-pinned current state. When omitted, the command-owned
   * preview captures the exact current state itself and binds the resulting
   * inventory hash into the persisted plan. Apply still requires the plan hash
   * and rechecks every path, Git, PRD and ledger revision.
   */
  expectedCurrent?: readonly ExpectedRollbackFileState[]
  currentGitHead?: string
  currentPrdRevisionHash: string
  currentStateRevision: number
  expiresInMs?: number
  now?: () => Date
  id?: () => string
}): Promise<RollbackPlan> {
  if (
    !Number.isSafeInteger(input.currentStateRevision) ||
    input.currentStateRevision < 0 ||
    input.currentStateRevision === Number.MAX_SAFE_INTEGER
  ) {
    throw new RalphError(
      "RALPH_ROLLBACK_STATE_REVISION_INVALID",
      "Rollback preview requires a non-negative event revision with room for its audit event",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const checkpoint = readCheckpoint(input.ledgerPath, input.checkpointId)
  if (!checkpoint || checkpoint.workspaceId !== input.workspaceId) {
    throw new RalphError(
      "RALPH_CHECKPOINT_NOT_FOUND",
      "Checkpoint was not found in this workspace",
      {
        exitCode: EXIT_CODES.notFound,
        details: { checkpointId: input.checkpointId, workspaceId: input.workspaceId },
      },
    )
  }
  if (checkpoint.status !== "available") {
    throw new RalphError("RALPH_CHECKPOINT_NOT_AVAILABLE", "Checkpoint is not available", {
      exitCode: EXIT_CODES.conflict,
      details: { checkpointId: checkpoint.id, status: checkpoint.status },
    })
  }
  const workspace = await realpath(resolve(input.workspaceRoot))
  if (comparable(workspace) !== comparable(checkpoint.repositoryRoot)) {
    throw new RalphError(
      "RALPH_CHECKPOINT_WORKSPACE_MISMATCH",
      "Checkpoint belongs to a different canonical workspace",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const expectations =
    input.expectedCurrent === undefined ? undefined : expectedStateMap(input.expectedCurrent)
  const conflicts: RollbackConflict[] = []
  const operations: RollbackOperation[] = []
  const currentStates: CurrentFileState[] = []
  const checkpointFiles = new Map(checkpoint.files.map((entry) => [entry.path, entry]))
  const inventoryPaths = new Set(checkpoint.files.map((entry) => entry.path))
  for (const root of checkpoint.inventoryRoots) {
    const scan = await scanInventoryRoot({ workspace, path: root.path, maximumFiles: 100_000 })
    for (const file of scan.files) inventoryPaths.add(file.path)
  }
  const orderedInventoryPaths = [...inventoryPaths].sort()
  for (const path of orderedInventoryPaths) {
    const entry = checkpointFiles.get(path)
    const current = await captureCurrentFile(workspace, path)
    currentStates.push(current)
    const expected: ExpectedRollbackFileState = expectations?.get(path) ?? {
      path,
      kind: current.kind,
      ...(current.sha256 ? { sha256: current.sha256 } : {}),
    }
    if (expectations && !expectations.has(path)) {
      conflicts.push({ path, reason: "No expected current state was bound to rollback" })
      continue
    }
    if (!stateMatchesExpected(current, expected)) {
      conflicts.push({
        path,
        reason: "File changed outside the state expected by this rollback request",
        ...(entry?.sha256 ? { checkpointSha256: entry.sha256 } : {}),
        ...(current.sha256 ? { currentSha256: current.sha256 } : {}),
      })
      continue
    }
    if (!entry && current.kind === "file") {
      if (!current.sha256) throw new Error("Captured rollback file has no content hash")
      operations.push({
        kind: "remove-file",
        path,
        expectedCurrentSha256: current.sha256,
      })
    } else if (entry?.kind === "file" && current.sha256 !== entry.sha256) {
      if (!entry.sha256 || !entry.contentRef) {
        conflicts.push({
          path,
          reason: "Checkpoint file entry has no immutable content binding",
        })
        continue
      }
      operations.push({
        kind: "restore-file",
        path,
        ...(current.sha256 ? { expectedCurrentSha256: current.sha256 } : {}),
        checkpointSha256: entry.sha256,
        contentRef: entry.contentRef,
      })
    } else if (entry?.kind === "missing" && current.kind === "file") {
      if (!current.sha256) throw new Error("Captured rollback file has no content hash")
      operations.push({
        kind: "remove-file",
        path,
        expectedCurrentSha256: current.sha256,
      })
    }
  }
  const now = input.now ?? (() => new Date())
  const created = now()
  const expiresInMs = input.expiresInMs ?? 15 * 60 * 1_000
  if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1_000 || expiresInMs > 60 * 60 * 1_000) {
    throw new RalphError("RALPH_ROLLBACK_EXPIRY_INVALID", "Rollback preview expiry is invalid", {
      exitCode: EXIT_CODES.invalidUsage,
      details: { expiresInMs },
    })
  }
  const projection = {
    schemaVersion: 1,
    id: (input.id ?? (() => crypto.randomUUID()))(),
    checkpointId: checkpoint.id,
    workspaceId: checkpoint.workspaceId,
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + expiresInMs).toISOString(),
    operations,
    conflicts,
    inventoryPaths: orderedInventoryPaths,
    currentInventoryHash: currentInventoryHash(currentStates),
    ...(input.currentGitHead ? { expectedGitHead: input.currentGitHead } : {}),
    expectedPrdRevisionHash: input.currentPrdRevisionHash,
    // persistRollbackPlan appends exactly one audit event in the same immediate
    // transaction. Binding the post-preview watermark lets apply accept only
    // that audit write; any concurrent or later ledger event still conflicts.
    expectedStateRevision: input.currentStateRevision + 1,
    requiresExplicitConfirmation: true as const,
    requiresSafetyCheckpoint: true as const,
  }
  const plan = RollbackPlanSchema.parse({
    ...projection,
    planHash: hashCanonical("ralph.rollback.plan.v1", projection),
  })
  return persistRollbackPlan(input.ledgerPath, plan)
}

async function currentMatchesOperation(
  workspace: string,
  operation: RollbackOperation,
): Promise<boolean> {
  const current = await captureCurrentFile(workspace, operation.path)
  return operation.expectedCurrentSha256
    ? current.kind === "file" && current.sha256 === operation.expectedCurrentSha256
    : current.kind === "missing"
}

async function safeParent(workspace: string, path: string): Promise<string> {
  const target = await canonicalWorkspaceFile(workspace, path)
  let parent: string
  try {
    parent = await realpath(dirname(target.absolutePath))
  } catch (error) {
    if (missing(error)) {
      throw new RalphError(
        "RALPH_ROLLBACK_PARENT_MISSING",
        "Rollback will not create a missing directory tree implicitly",
        { exitCode: EXIT_CODES.conflict, file: dirname(target.absolutePath) },
      )
    }
    throw error
  }
  if (!contained(target.workspace, parent)) {
    throw new RalphError("RALPH_ROLLBACK_PATH_ESCAPE", "Rollback parent escapes workspace", {
      exitCode: EXIT_CODES.permissionDenied,
      file: parent,
    })
  }
  return parent
}

export async function applyCheckpointRollback(input: {
  ledgerPath: string
  checkpointRoot: string
  workspaceRoot: string
  workspaceId: string
  rollbackPlanId: string
  confirmationPlanHash: string
  git: GitCheckpointInventory
  prdRevisionHash: string
  stateRevision: number
  actor: string
  now?: () => Date
  id?: () => string
}): Promise<{ checkpoint: CheckpointRecord; safetyCheckpoint: CheckpointRecord }> {
  const now = input.now ?? (() => new Date())
  const plan = readRollbackPlan(input.ledgerPath, input.rollbackPlanId)
  if (!plan || plan.workspaceId !== input.workspaceId) {
    throw new RalphError("RALPH_ROLLBACK_PLAN_NOT_FOUND", "Rollback plan was not found", {
      exitCode: EXIT_CODES.notFound,
      details: { rollbackPlanId: input.rollbackPlanId },
    })
  }
  if (plan.planHash !== input.confirmationPlanHash) {
    throw new RalphError(
      "RALPH_ROLLBACK_CONFIRMATION_MISMATCH",
      "Rollback confirmation is not bound to the previewed plan hash",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  if (now().getTime() > Date.parse(plan.expiresAt)) {
    settleRollbackPlan(input.ledgerPath, plan.id, "expired", {
      settledAt: now().toISOString(),
      reason: "Preview expired before explicit confirmation",
    })
    throw new RalphError("RALPH_ROLLBACK_PLAN_EXPIRED", "Rollback preview expired", {
      exitCode: EXIT_CODES.conflict,
    })
  }
  if (plan.conflicts.length > 0) {
    settleRollbackPlan(input.ledgerPath, plan.id, "conflicted", {
      settledAt: now().toISOString(),
      reason: "Preview contains unresolved conflicts",
    })
    throw new RalphError("RALPH_ROLLBACK_CONFLICT", "Rollback preview contains conflicts", {
      exitCode: EXIT_CODES.conflict,
      details: { conflicts: plan.conflicts },
    })
  }
  if (
    (plan.expectedGitHead ?? null) !== (input.git.head ?? null) ||
    plan.expectedPrdRevisionHash !== input.prdRevisionHash ||
    plan.expectedStateRevision !== input.stateRevision
  ) {
    settleRollbackPlan(input.ledgerPath, plan.id, "conflicted", {
      settledAt: now().toISOString(),
      reason: "Git, PRD or ledger state changed after rollback preview",
    })
    throw new RalphError(
      "RALPH_ROLLBACK_STATE_CHANGED",
      "Git, PRD or ledger state changed after rollback preview",
      {
        exitCode: EXIT_CODES.conflict,
        details: {
          expectedGitHead: plan.expectedGitHead,
          observedGitHead: input.git.head,
          expectedPrdRevisionHash: plan.expectedPrdRevisionHash,
          observedPrdRevisionHash: input.prdRevisionHash,
          expectedStateRevision: plan.expectedStateRevision,
          observedStateRevision: input.stateRevision,
        },
      },
    )
  }
  const workspace = await realpath(resolve(input.workspaceRoot))
  const checkpoint = readCheckpoint(input.ledgerPath, plan.checkpointId)
  if (!checkpoint) throw new Error("Checkpoint disappeared after rollback preview")
  const currentInventory: CurrentFileState[] = []
  for (const path of plan.inventoryPaths) {
    currentInventory.push(await captureCurrentFile(workspace, path))
  }
  if (currentInventoryHash(currentInventory) !== plan.currentInventoryHash) {
    settleRollbackPlan(input.ledgerPath, plan.id, "conflicted", {
      settledAt: now().toISOString(),
      reason: "Checkpoint file inventory changed after rollback preview",
    })
    throw new RalphError(
      "RALPH_ROLLBACK_STATE_CHANGED",
      "Workspace file inventory changed after rollback preview",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  for (const operation of plan.operations) {
    if (!(await currentMatchesOperation(workspace, operation))) {
      settleRollbackPlan(input.ledgerPath, plan.id, "conflicted", {
        settledAt: now().toISOString(),
        reason: `Current file state changed after preview: ${operation.path}`,
      })
      throw new RalphError(
        "RALPH_ROLLBACK_STATE_CHANGED",
        "Workspace changed after rollback preview",
        { exitCode: EXIT_CODES.conflict, file: operation.path },
      )
    }
  }
  const safetyCheckpoint = await createWorkspaceCheckpoint({
    ledgerPath: input.ledgerPath,
    checkpointRoot: input.checkpointRoot,
    workspaceRoot: workspace,
    workspaceId: input.workspaceId,
    ...(checkpoint.runId ? { runId: checkpoint.runId } : {}),
    ...(checkpoint.taskId ? { taskId: checkpoint.taskId } : {}),
    ...(checkpoint.attemptId ? { attemptId: checkpoint.attemptId } : {}),
    reason: `Safety checkpoint before rollback ${plan.id}`,
    createdBy: input.actor,
    relevantPaths: plan.operations.map((operation) => operation.path),
    git: input.git,
    prdRevisionHash: input.prdRevisionHash,
    stateRevision: input.stateRevision,
    ...(input.id ? { id: input.id } : {}),
    now,
  })
  const root = checkpointStoreRoot(workspace, input.checkpointRoot)
  for (const operation of plan.operations) {
    const target = await canonicalWorkspaceFile(workspace, operation.path)
    const parentBefore = await safeParent(workspace, operation.path)
    if (operation.kind === "restore-file") {
      if (!operation.contentRef || !operation.checkpointSha256) {
        throw new RalphError(
          "RALPH_ROLLBACK_PLAN_INVALID",
          "Restore operation is missing immutable checkpoint content",
          { exitCode: EXIT_CODES.conflict, file: operation.path },
        )
      }
      const blobPath = resolve(root, operation.contentRef)
      if (!contained(root, blobPath)) {
        throw new RalphError("RALPH_ROLLBACK_BLOB_ESCAPE", "Rollback blob ref escapes store", {
          exitCode: EXIT_CODES.permissionDenied,
          file: blobPath,
        })
      }
      const content = await readFile(blobPath)
      if (sha256(content) !== operation.checkpointSha256) {
        throw new RalphError("RALPH_ROLLBACK_BLOB_CORRUPT", "Rollback blob hash mismatch", {
          exitCode: EXIT_CODES.conflict,
          file: blobPath,
        })
      }
      const checkpointEntry = checkpoint.files.find((entry) => entry.path === operation.path)
      await writeFileAtomic(target.absolutePath, content, {
        overwrite: true,
        mode: checkpointEntry?.executable ? 0o700 : 0o600,
        beforeCommit: async () => {
          const parentAfter = await safeParent(workspace, operation.path)
          if (comparable(parentAfter) !== comparable(parentBefore)) {
            throw new RalphError(
              "RALPH_ROLLBACK_PATH_CHANGED",
              "Rollback parent changed during atomic restore",
              { exitCode: EXIT_CODES.conflict, file: operation.path },
            )
          }
          if (!(await currentMatchesOperation(workspace, operation))) {
            throw new RalphError(
              "RALPH_ROLLBACK_STATE_CHANGED",
              "Rollback target changed during atomic restore",
              { exitCode: EXIT_CODES.conflict, file: operation.path },
            )
          }
        },
      })
      if (checkpointEntry?.executable && process.platform !== "win32") {
        await chmod(target.absolutePath, 0o700)
      }
    } else {
      const info = await lstat(target.absolutePath)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new RalphError(
          "RALPH_ROLLBACK_REMOVE_UNSAFE",
          "Rollback removal target is no longer an exact regular file",
          { exitCode: EXIT_CODES.conflict, file: operation.path },
        )
      }
      const parentAfter = await safeParent(workspace, operation.path)
      if (
        comparable(parentAfter) !== comparable(parentBefore) ||
        !(await currentMatchesOperation(workspace, operation))
      ) {
        throw new RalphError(
          "RALPH_ROLLBACK_STATE_CHANGED",
          "Rollback removal target changed after preview",
          { exitCode: EXIT_CODES.conflict, file: operation.path },
        )
      }
      await unlink(target.absolutePath)
    }
  }
  settleRollbackPlan(input.ledgerPath, plan.id, "applied", {
    settledAt: now().toISOString(),
    safetyCheckpointId: safetyCheckpoint.id,
    reason: "Explicit hash-bound rollback applied exact file operations",
  })
  const applied = readCheckpoint(input.ledgerPath, checkpoint.id)
  if (!applied) throw new Error("Applied checkpoint disappeared from ledger")
  return { checkpoint: applied, safetyCheckpoint }
}
