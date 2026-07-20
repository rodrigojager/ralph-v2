import { createHash } from "node:crypto"
import { mkdir, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  EXIT_CODES,
  type GitIntegrationRecord,
  GitIntegrationRecordSchema,
  type GitIntegrationStrategy,
  type GitWorktreeRecord,
  GitWorktreeRecordSchema,
  RalphError,
  type ResourceClaimSetRecord,
} from "@ralph-next/domain"
import {
  createGitIntegrationRecord,
  createGitWorktreeRecord,
  transitionGitIntegrationRecord,
  transitionGitWorktreeRecord,
} from "@ralph-next/persistence"

export type GitCommandResult = {
  exitCode?: number
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  /** True when the command port could not retain the complete summary output. */
  outputTruncated?: boolean
  /** True when even the immutable/raw capture was truncated. */
  rawOutputTruncated?: boolean
}

export interface GitCommandPort {
  run(input: {
    cwd: string
    args: readonly string[]
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<GitCommandResult>
}

export interface GitIntegrationGatePort {
  run(input: {
    integrationId: string
    runId: string
    taskId: string
    workspaceRoot: string
    sourceHead: string
    targetHead: string
    phase: "before-integration" | "after-integration"
    signal?: AbortSignal
  }): Promise<{ passed: boolean; summary: string; evidenceRefs: readonly string[] }>
}

export interface PullRequestPort {
  create(input: {
    repositoryRoot: string
    sourceRef: string
    targetRef: string
    expectedSourceHead: string
    title: string
    body: string
    draft: boolean
    labels: readonly string[]
    requestBinding: string
    idempotencyKey: string
    signal?: AbortSignal
  }): Promise<{ ref: string; head: string }>
}

export type PullRequestBindingInput = {
  readonly repositoryRoot: string
  readonly sourceRef: string
  readonly targetRef: string
  readonly expectedSourceHead: string
  readonly title: string
  readonly body: string
  readonly draft: boolean
  readonly labels: readonly string[]
}

/** Binds idempotency and adapter results to every authorized PR request field. */
export function createPullRequestRequestBinding(input: PullRequestBindingInput): string {
  const canonical = JSON.stringify([
    "ralph.create-pull-request.v1",
    input.repositoryRoot,
    input.sourceRef,
    input.targetRef,
    input.expectedSourceHead,
    input.title,
    input.body,
    input.draft,
    [...input.labels],
  ])
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

export type DirtyBaselinePolicy = "deny" | "allow" | "checkpoint-required"

export function normalizeGitIntegrationStrategy(
  value: GitIntegrationStrategy | "no-merge",
): GitIntegrationStrategy {
  return value === "no-merge" ? "none" : value
}

export function renderTaskCommitMessage(
  template: string,
  values: { runId: string; taskId: string; attemptId: string },
): string {
  const unknown = [...template.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1] as string)
    .filter((name) => !["runId", "taskId", "attemptId"].includes(name))
  if (unknown.length > 0) {
    throw new RalphError(
      "RALPH_GIT_COMMIT_TEMPLATE_INVALID",
      "Commit message template contains unsupported placeholders",
      { exitCode: EXIT_CODES.invalidUsage, details: { unknown: [...new Set(unknown)] } },
    )
  }
  return template
    .replaceAll("{runId}", values.runId)
    .replaceAll("{taskId}", values.taskId)
    .replaceAll("{attemptId}", values.attemptId)
}

export type GitBaselineInspection = {
  repositoryRoot: string
  head: string
  branch?: string
  dirty: boolean
  porcelain: string
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("und") : value
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function safeSegment(value: string, maximum = 80): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximum)
  if (!normalized || normalized === "." || normalized === "..") {
    throw new RalphError("RALPH_GIT_ID_INVALID", "Run/task identity cannot form a safe Git path", {
      exitCode: EXIT_CODES.invalidUsage,
      details: { value },
    })
  }
  return normalized
}

function attemptSegment(value: string): string {
  const prefix = safeSegment(value, 16)
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12)
  return `${prefix}-${digest}`
}

function gitRef(value: string, name: string): string {
  const ref = value.trim()
  if (
    !ref ||
    ref.length > 255 ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    /[\0-\x20\x7f~^:?*[\\]/.test(ref)
  ) {
    throw new RalphError("RALPH_GIT_REF_INVALID", `${name} is not a safe Git ref`, {
      exitCode: EXIT_CODES.invalidUsage,
      details: { name, value },
    })
  }
  return ref
}

function commandFailure(operation: string, result: GitCommandResult, details = {}): RalphError {
  return new RalphError("RALPH_GIT_COMMAND_FAILED", `Git ${operation} failed`, {
    exitCode: EXIT_CODES.operationalError,
    details: {
      operation,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stderr: result.stderr.slice(0, 8_192),
      ...details,
    },
    hint:
      process.platform === "win32"
        ? "Inspect Git locks, long-path support, antivirus handles and the retained branch/worktree before retrying."
        : "Inspect Git locks and the retained branch/worktree before retrying.",
  })
}

async function gitText(
  port: GitCommandPort,
  cwd: string,
  args: readonly string[],
  operation: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await port.run({
    cwd,
    args,
    timeoutMs: 2 * 60 * 1_000,
    ...(signal ? { signal } : {}),
  })
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.cancelled ||
    result.outputTruncated ||
    result.rawOutputTruncated
  ) {
    throw commandFailure(operation, result, { args })
  }
  return result.stdout.trim()
}

async function runGit(
  port: GitCommandPort,
  cwd: string,
  args: readonly string[],
  operation: string,
  signal?: AbortSignal,
): Promise<GitCommandResult> {
  const result = await port.run({
    cwd,
    args,
    timeoutMs: 10 * 60 * 1_000,
    ...(signal ? { signal } : {}),
  })
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.cancelled ||
    result.outputTruncated ||
    result.rawOutputTruncated
  ) {
    throw commandFailure(operation, result, { args })
  }
  return result
}

export async function inspectGitBaseline(
  repositoryRoot: string,
  port: GitCommandPort,
  signal?: AbortSignal,
): Promise<GitBaselineInspection> {
  const root = await realpath(resolve(repositoryRoot))
  const [topLevel, head, branch, porcelain] = await Promise.all([
    gitText(port, root, ["rev-parse", "--show-toplevel"], "repository inspection", signal),
    gitText(port, root, ["rev-parse", "HEAD"], "HEAD inspection", signal),
    gitText(port, root, ["branch", "--show-current"], "branch inspection", signal),
    gitText(
      port,
      root,
      ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
      "status inspection",
      signal,
    ),
  ])
  const canonicalTopLevel = await realpath(resolve(topLevel))
  if (comparable(canonicalTopLevel) !== comparable(root)) {
    throw new RalphError(
      "RALPH_GIT_ROOT_MISMATCH",
      "Configured workspace is not the canonical Git repository root",
      {
        exitCode: EXIT_CODES.conflict,
        details: { repositoryRoot: root, observedTopLevel: canonicalTopLevel },
      },
    )
  }
  const worktreeLines = porcelain
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !line.startsWith("# "))
  return {
    repositoryRoot: root,
    head,
    ...(branch ? { branch } : {}),
    dirty: worktreeLines.length > 0,
    porcelain,
  }
}

export function assertGitBaselinePolicy(input: {
  baseline: GitBaselineInspection
  policy: DirtyBaselinePolicy
  checkpointId?: string
}): void {
  if (!input.baseline.dirty) return
  if (input.policy === "allow") return
  if (input.policy === "checkpoint-required" && input.checkpointId) return
  throw new RalphError(
    "RALPH_GIT_DIRTY_BASELINE",
    "Parallel Git execution cannot start from this dirty baseline under the effective policy",
    {
      exitCode: EXIT_CODES.conflict,
      details: {
        policy: input.policy,
        checkpointId: input.checkpointId,
        porcelain: input.baseline.porcelain.slice(0, 16_384),
      },
      hint:
        input.policy === "checkpoint-required"
          ? "Create an explicit checkpoint before starting isolated worktrees."
          : "Commit/stash manually, use an explicit dirty-baseline policy, or keep this run serialized.",
    },
  )
}

export function assertGitAutomationPolicy(input: {
  autoRollback: boolean
  autoCheckpoints: boolean
}): void {
  if (input.autoRollback) {
    throw new RalphError(
      "RALPH_GIT_AUTO_ROLLBACK_FORBIDDEN",
      "Automatic rollback is retained only as a legacy configuration field and cannot authorize mutation",
      {
        exitCode: EXIT_CODES.permissionDenied,
        hint: "Use a checkpoint rollback preview, inspect conflicts, and confirm the exact plan hash explicitly.",
      },
    )
  }
  void input.autoCheckpoints
}

export async function resolveManagedWorktreePath(input: {
  repositoryRoot: string
  runId: string
  taskId: string
  /** Distinguishes retained retry attempts without deleting or reusing prior work. */
  attemptId?: string
  maximumPathLength?: number
}): Promise<{ repositoryRoot: string; managedRoot: string; worktreePath: string; branch: string }> {
  const repositoryRoot = await realpath(resolve(input.repositoryRoot))
  const run = safeSegment(input.runId)
  const task = safeSegment(input.taskId)
  const attempt = input.attemptId ? attemptSegment(input.attemptId) : undefined
  const managedRoot = resolve(repositoryRoot, ".ralph", "worktrees", run)
  const worktreePath = resolve(managedRoot, attempt ? `${task}--${attempt}` : task)
  if (!contained(repositoryRoot, managedRoot) || !contained(managedRoot, worktreePath)) {
    throw new RalphError(
      "RALPH_GIT_WORKTREE_PATH_ESCAPE",
      "Managed worktree path escaped its repository-owned root",
      { exitCode: EXIT_CODES.permissionDenied, file: worktreePath },
    )
  }
  const maximumPathLength =
    input.maximumPathLength ?? (process.platform === "win32" ? 32_000 : 4_096)
  if (worktreePath.length > maximumPathLength) {
    throw new RalphError(
      "RALPH_GIT_WORKTREE_PATH_TOO_LONG",
      "Managed worktree path exceeds the configured platform limit",
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: worktreePath,
        details: { length: worktreePath.length, maximumPathLength },
      },
    )
  }
  return {
    repositoryRoot,
    managedRoot,
    worktreePath,
    branch: gitRef(
      `ralph/${run.slice(0, 24)}/${task.slice(0, 80)}${attempt ? `/${attempt}` : ""}`,
      "generated branch",
    ),
  }
}

export function assertGitResourceClaims(input: {
  claimSet: ResourceClaimSetRecord
  worktreePath: string
  branch: string
  integrationTarget: string
}): void {
  if (input.claimSet.status !== "active") {
    throw new RalphError("RALPH_GIT_CLAIM_INACTIVE", "Git operation requires active claims", {
      exitCode: EXIT_CODES.conflict,
      details: { claimSetId: input.claimSet.id, status: input.claimSet.status },
    })
  }
  const expected: readonly [string, string][] = [
    ["worktree", input.worktreePath.replaceAll("\\", "/")],
    ["branch", input.branch],
    ["integration-target", input.integrationTarget],
  ]
  const missing = expected.filter(
    ([kind, key]) =>
      !input.claimSet.claims.some(
        (claim) => claim.kind === kind && comparable(claim.resourceKey) === comparable(key),
      ),
  )
  if (missing.length > 0) {
    throw new RalphError(
      "RALPH_GIT_CLAIM_MISSING",
      "Git operation is not covered by the worker resource claim set",
      {
        exitCode: EXIT_CODES.permissionDenied,
        details: { claimSetId: input.claimSet.id, missing },
      },
    )
  }
}

export async function prepareTaskWorktree(input: {
  ledgerPath: string
  workspaceId: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  repositoryRoot: string
  baseRef: string
  integrationTarget: string
  retention: GitWorktreeRecord["retention"]
  claimSet: ResourceClaimSetRecord
  git: GitCommandPort
  maximumPathLength?: number
  signal?: AbortSignal
  now?: () => Date
  id?: () => string
}): Promise<GitWorktreeRecord> {
  const now = input.now ?? (() => new Date())
  const id = input.id ?? (() => crypto.randomUUID())
  const paths = await resolveManagedWorktreePath({
    repositoryRoot: input.repositoryRoot,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    ...(input.maximumPathLength ? { maximumPathLength: input.maximumPathLength } : {}),
  })
  const baseRef = gitRef(input.baseRef, "baseRef")
  const integrationTarget = gitRef(input.integrationTarget, "integrationTarget")
  assertGitResourceClaims({
    claimSet: input.claimSet,
    worktreePath: paths.worktreePath,
    branch: paths.branch,
    integrationTarget,
  })
  const baseHead = await gitText(
    input.git,
    paths.repositoryRoot,
    ["rev-parse", "--verify", `${baseRef}^{commit}`],
    "base-ref verification",
    input.signal,
  )
  const createdAt = now().toISOString()
  let record = createGitWorktreeRecord(
    input.ledgerPath,
    GitWorktreeRecordSchema.parse({
      schemaVersion: 1,
      id: id(),
      workspaceId: input.workspaceId,
      runId: input.runId,
      documentId: input.documentId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      repositoryRoot: paths.repositoryRoot,
      worktreePath: paths.worktreePath,
      branch: paths.branch,
      baseRef,
      integrationTarget,
      retention: input.retention,
      status: "preparing",
      createdAt,
      updatedAt: createdAt,
      revision: 0,
      head: baseHead,
    }),
  )
  await mkdir(paths.managedRoot, { recursive: true })
  try {
    await runGit(
      input.git,
      paths.repositoryRoot,
      ["worktree", "add", "-b", paths.branch, "--", paths.worktreePath, baseHead],
      "worktree creation",
      input.signal,
    )
    const canonicalWorktree = await realpath(paths.worktreePath)
    if (!contained(paths.managedRoot, canonicalWorktree)) {
      throw new RalphError(
        "RALPH_GIT_WORKTREE_PATH_ESCAPE",
        "Created worktree resolves outside the managed run directory",
        { exitCode: EXIT_CODES.permissionDenied, file: canonicalWorktree },
      )
    }
    const head = await gitText(
      input.git,
      canonicalWorktree,
      ["rev-parse", "HEAD"],
      "worktree HEAD inspection",
      input.signal,
    )
    record = transitionGitWorktreeRecord(input.ledgerPath, record.id, record.revision, {
      status: "active",
      head,
      updatedAt: now().toISOString(),
    })
    return record
  } catch (error) {
    transitionGitWorktreeRecord(input.ledgerPath, record.id, record.revision, {
      status: "failed",
      failureReason: error instanceof Error ? error.message : String(error),
      updatedAt: now().toISOString(),
    })
    throw error
  }
}

function relativeScope(value: string): string {
  const normalized =
    value
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/\/\*\*$/, "")
      .replace(/\/+$/, "") || "."
  if (
    !normalized ||
    isAbsolute(normalized) ||
    /(^|\/)\.\.(\/|$)/.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new RalphError(
      "RALPH_GIT_COMMIT_SCOPE_INVALID",
      "Commit scope must be a safe path relative to the task worktree",
      { exitCode: EXIT_CODES.invalidUsage, details: { value } },
    )
  }
  return normalized
}

function statusPaths(porcelain: string): string[] {
  const entries = porcelain.split("\0").filter(Boolean)
  const paths: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as string
    const path = entry.length >= 4 ? entry.slice(3) : ""
    if (path) paths.push(path.replaceAll("\\", "/"))
    if (
      (entry.startsWith("R") || entry.startsWith("C") || entry[1] === "R" || entry[1] === "C") &&
      entries[index + 1]
    ) {
      paths.push((entries[index + 1] as string).replaceAll("\\", "/"))
      index += 1
    }
  }
  return paths
}

function pathWithinScopes(path: string, scopes: readonly string[]): boolean {
  const normalized = comparable(path.replaceAll("\\", "/").replace(/^\.\//, ""))
  return scopes.some((scope) => {
    const candidate = comparable(scope)
    if (candidate === ".") return true
    return normalized === candidate || normalized.startsWith(`${candidate}/`)
  })
}

export async function finalizeTaskWorktree(input: {
  ledgerPath: string
  record: GitWorktreeRecord
  git: GitCommandPort
  commit: boolean
  writeScopes: readonly string[]
  message: string
  sign: boolean
  signal?: AbortSignal
  now?: () => Date
}): Promise<GitWorktreeRecord> {
  if (input.record.status !== "active") {
    throw new RalphError(
      "RALPH_GIT_WORKTREE_NOT_ACTIVE",
      "Only an active task worktree can be finalized",
      { exitCode: EXIT_CODES.conflict, details: { status: input.record.status } },
    )
  }
  const scopes = [...new Set(input.writeScopes.map(relativeScope))].sort()
  if (scopes.length === 0) {
    throw new RalphError(
      "RALPH_GIT_COMMIT_SCOPE_INVALID",
      "Task worktree finalization requires explicit write scopes",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const porcelain = await gitText(
    input.git,
    input.record.worktreePath,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "task worktree status inspection",
    input.signal,
  )
  const changedPaths = statusPaths(porcelain)
  const outside = changedPaths.filter((path) => !pathWithinScopes(path, scopes))
  if (outside.length > 0) {
    throw new RalphError(
      "RALPH_GIT_COMMIT_SCOPE_EXPANDED",
      "Task changed paths outside its declared Git write scopes",
      {
        exitCode: EXIT_CODES.conflict,
        details: { outside: outside.slice(0, 1_000), declaredScopes: scopes },
        hint: "Apply scope.expanded policy and update the active claim before staging any additional path.",
      },
    )
  }
  const now = input.now ?? (() => new Date())
  if (!input.commit) {
    return transitionGitWorktreeRecord(input.ledgerPath, input.record.id, input.record.revision, {
      status: "retained",
      ...(input.record.head ? { head: input.record.head } : {}),
      failureReason:
        changedPaths.length > 0
          ? "No-commit policy retained the worktree with uncommitted changes"
          : "No-commit policy retained the worktree without creating a task commit",
      updatedAt: now().toISOString(),
    })
  }
  if (changedPaths.length > 0) {
    await runGit(
      input.git,
      input.record.worktreePath,
      ["add", "--", ...scopes],
      "scoped task staging",
      input.signal,
    )
    const message = input.message.trim()
    if (!message || message.length > 8_192 || /[\0\r]/.test(message)) {
      throw new RalphError("RALPH_GIT_COMMIT_MESSAGE_INVALID", "Task commit message is invalid", {
        exitCode: EXIT_CODES.invalidUsage,
      })
    }
    await runGit(
      input.git,
      input.record.worktreePath,
      ["commit", ...(input.sign ? ["-S"] : []), "-m", message],
      "task commit",
      input.signal,
    )
  }
  const remaining = await gitText(
    input.git,
    input.record.worktreePath,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "post-commit status inspection",
    input.signal,
  )
  if (remaining.length > 0) {
    throw new RalphError(
      "RALPH_GIT_WORKTREE_DIRTY_AFTER_COMMIT",
      "Task worktree remains dirty after scoped commit",
      {
        exitCode: EXIT_CODES.conflict,
        details: { paths: statusPaths(remaining).slice(0, 1_000) },
      },
    )
  }
  const head = await gitText(
    input.git,
    input.record.worktreePath,
    ["rev-parse", "HEAD"],
    "finalized task HEAD inspection",
    input.signal,
  )
  return transitionGitWorktreeRecord(input.ledgerPath, input.record.id, input.record.revision, {
    status: "active",
    head,
    updatedAt: now().toISOString(),
  })
}

async function conflictPaths(
  git: GitCommandPort,
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await git.run({
    cwd,
    args: ["diff", "--name-only", "--diff-filter=U", "-z"],
    timeoutMs: 2 * 60 * 1_000,
    ...(signal ? { signal } : {}),
  })
  if (result.exitCode !== 0 || result.timedOut || result.cancelled) return []
  return result.stdout
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 10_000)
}

async function commandOrConflict(input: {
  git: GitCommandPort
  cwd: string
  args: readonly string[]
  operation: string
  signal?: AbortSignal
}): Promise<{ conflictPaths: readonly string[]; error?: RalphError }> {
  const result = await input.git.run({
    cwd: input.cwd,
    args: input.args,
    timeoutMs: 10 * 60 * 1_000,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (result.exitCode === 0 && !result.timedOut && !result.cancelled) return { conflictPaths: [] }
  const conflicts = await conflictPaths(input.git, input.cwd, input.signal)
  return {
    conflictPaths: conflicts,
    error: commandFailure(input.operation, result, { args: input.args, conflictPaths: conflicts }),
  }
}

async function assertIntegrationTarget(input: {
  git: GitCommandPort
  targetWorktreePath: string
  targetRef: string
  expectedTargetHead: string
  signal?: AbortSignal
}): Promise<string> {
  const branch = await gitText(
    input.git,
    input.targetWorktreePath,
    ["branch", "--show-current"],
    "integration target branch inspection",
    input.signal,
  )
  if (branch !== input.targetRef) {
    throw new RalphError(
      "RALPH_GIT_INTEGRATION_TARGET_MISMATCH",
      "Integration worktree is not on the claimed target branch",
      {
        exitCode: EXIT_CODES.conflict,
        details: { expected: input.targetRef, observed: branch },
      },
    )
  }
  const head = await gitText(
    input.git,
    input.targetWorktreePath,
    ["rev-parse", "HEAD"],
    "integration target HEAD inspection",
    input.signal,
  )
  if (head !== input.expectedTargetHead) {
    throw new RalphError(
      "RALPH_GIT_INTEGRATION_TARGET_CHANGED",
      "Integration target changed after planning; automatic conflict resolution is forbidden",
      {
        exitCode: EXIT_CODES.conflict,
        details: { expectedTargetHead: input.expectedTargetHead, observedTargetHead: head },
        hint: "Pause, re-run integration gates against the new target and create an explicit integration attempt.",
      },
    )
  }
  return head
}

export async function integrateTaskWorktree(input: {
  ledgerPath: string
  workspaceId: string
  runId: string
  taskId: string
  order: number
  integrationAttemptId: string
  worktree: GitWorktreeRecord
  targetWorktreePath: string
  expectedTargetHead: string
  strategy: GitIntegrationStrategy
  claimSet: ResourceClaimSetRecord
  git: GitCommandPort
  gates: GitIntegrationGatePort
  pullRequests?: PullRequestPort
  pullRequest?: { title: string; body: string; draft: boolean; labels: readonly string[] }
  signal?: AbortSignal
  now?: () => Date
  id?: () => string
}): Promise<GitIntegrationRecord> {
  const now = input.now ?? (() => new Date())
  const id = input.id ?? (() => crypto.randomUUID())
  const targetWorktreePath = await realpath(resolve(input.targetWorktreePath))
  const repositoryRoot = await realpath(resolve(input.worktree.repositoryRoot))
  if (!contained(repositoryRoot, targetWorktreePath)) {
    throw new RalphError(
      "RALPH_GIT_INTEGRATION_PATH_ESCAPE",
      "Integration worktree must remain inside the canonical repository workspace",
      { exitCode: EXIT_CODES.permissionDenied, file: targetWorktreePath },
    )
  }
  assertGitResourceClaims({
    claimSet: input.claimSet,
    worktreePath: input.worktree.worktreePath,
    branch: input.worktree.branch,
    integrationTarget: input.worktree.integrationTarget,
  })
  const sourceHead = await gitText(
    input.git,
    input.worktree.worktreePath,
    ["rev-parse", "HEAD"],
    "source HEAD inspection",
    input.signal,
  )
  if (input.strategy !== "none") {
    const sourceStatus = await gitText(
      input.git,
      input.worktree.worktreePath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      "source cleanliness inspection",
      input.signal,
    )
    if (sourceStatus.length > 0) {
      throw new RalphError(
        "RALPH_GIT_SOURCE_DIRTY",
        "Git integration requires a clean committed source worktree",
        {
          exitCode: EXIT_CODES.conflict,
          details: { paths: statusPaths(sourceStatus).slice(0, 1_000) },
          hint: "Use commit-per-task, or select strategy none and retain the no-commit worktree.",
        },
      )
    }
  }
  await assertIntegrationTarget({
    git: input.git,
    targetWorktreePath,
    targetRef: input.worktree.integrationTarget,
    expectedTargetHead: input.expectedTargetHead,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const createdAt = now().toISOString()
  let record = createGitIntegrationRecord(
    input.ledgerPath,
    GitIntegrationRecordSchema.parse({
      schemaVersion: 1,
      id: id(),
      workspaceId: input.workspaceId,
      runId: input.runId,
      worktreeId: input.worktree.id,
      taskId: input.taskId,
      order: input.order,
      strategy: input.strategy,
      sourceRef: input.worktree.branch,
      targetRef: input.worktree.integrationTarget,
      sourceHead,
      targetHeadBefore: input.expectedTargetHead,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      revision: 0,
      attemptId: input.integrationAttemptId,
      conflictPaths: [],
    }),
  )
  const before = await input.gates.run({
    integrationId: record.id,
    runId: input.runId,
    taskId: input.taskId,
    workspaceRoot: targetWorktreePath,
    sourceHead,
    targetHead: input.expectedTargetHead,
    phase: "before-integration",
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (!before.passed) {
    return transitionGitIntegrationRecord(input.ledgerPath, record.id, record.revision, {
      status: "paused",
      summary: `Integration gates failed before mutation: ${before.summary}`,
      updatedAt: now().toISOString(),
    })
  }
  record = transitionGitIntegrationRecord(input.ledgerPath, record.id, record.revision, {
    status: "running",
    updatedAt: now().toISOString(),
  })

  let mutation: { conflictPaths: readonly string[]; error?: RalphError } = { conflictPaths: [] }
  if (input.strategy === "merge") {
    mutation = await commandOrConflict({
      git: input.git,
      cwd: targetWorktreePath,
      args: ["merge", "--no-ff", "--no-edit", "--", sourceHead],
      operation: "merge integration",
      ...(input.signal ? { signal: input.signal } : {}),
    })
  } else if (input.strategy === "rebase-merge") {
    mutation = await commandOrConflict({
      git: input.git,
      cwd: input.worktree.worktreePath,
      args: ["rebase", input.worktree.integrationTarget],
      operation: "source rebase",
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (!mutation.error) {
      const rebasedHead = await gitText(
        input.git,
        input.worktree.worktreePath,
        ["rev-parse", "HEAD"],
        "rebased source HEAD inspection",
        input.signal,
      )
      mutation = await commandOrConflict({
        git: input.git,
        cwd: targetWorktreePath,
        args: ["merge", "--no-ff", "--no-edit", "--", rebasedHead],
        operation: "rebased merge integration",
        ...(input.signal ? { signal: input.signal } : {}),
      })
    }
  } else if (input.strategy === "cherry-pick") {
    const revisions = await gitText(
      input.git,
      targetWorktreePath,
      ["rev-list", "--reverse", `${input.expectedTargetHead}..${sourceHead}`],
      "cherry-pick revision planning",
      input.signal,
    )
    const commits = revisions
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
    if (commits.length === 0) {
      mutation = {
        conflictPaths: [],
        error: new RalphError(
          "RALPH_GIT_CHERRY_PICK_EMPTY",
          "Cherry-pick integration found no source commits",
          {
            exitCode: EXIT_CODES.conflict,
            details: { sourceHead, target: input.expectedTargetHead },
          },
        ),
      }
    } else {
      mutation = await commandOrConflict({
        git: input.git,
        cwd: targetWorktreePath,
        args: ["cherry-pick", ...commits],
        operation: "cherry-pick integration",
        ...(input.signal ? { signal: input.signal } : {}),
      })
    }
  } else if (input.strategy === "create-pr") {
    if (!input.pullRequests || !input.pullRequest) {
      mutation = {
        conflictPaths: [],
        error: new RalphError(
          "RALPH_GIT_PULL_REQUEST_CAPABILITY_UNAVAILABLE",
          "Create-PR strategy requires an explicit external-effect adapter and request metadata",
          { exitCode: EXIT_CODES.invalidUsage },
        ),
      }
    } else {
      const pullRequest = {
        repositoryRoot,
        sourceRef: input.worktree.branch,
        targetRef: input.worktree.integrationTarget,
        expectedSourceHead: sourceHead,
        title: input.pullRequest.title,
        body: input.pullRequest.body,
        draft: input.pullRequest.draft,
        labels: input.pullRequest.labels,
      }
      const requestBinding = createPullRequestRequestBinding(pullRequest)
      const created = await input.pullRequests.create({
        ...pullRequest,
        requestBinding,
        idempotencyKey: `ralph:${input.runId}:${input.taskId}:${requestBinding}:create-pr`,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      if (created.head !== sourceHead) {
        throw new RalphError(
          "RALPH_GIT_PULL_REQUEST_HEAD_MISMATCH",
          "Create-PR adapter did not bind the authorized source HEAD",
          {
            exitCode: EXIT_CODES.conflict,
            details: { expectedSourceHead: sourceHead, observedHead: created.head },
          },
        )
      }
      return transitionGitIntegrationRecord(input.ledgerPath, record.id, record.revision, {
        status: "pr-created",
        resultHead: created.head,
        pullRequestRef: created.ref,
        summary: "Branch published through the authorized create-PR adapter",
        updatedAt: now().toISOString(),
      })
    }
  }

  if (mutation.error) {
    return transitionGitIntegrationRecord(input.ledgerPath, record.id, record.revision, {
      status: mutation.conflictPaths.length > 0 ? "conflicted" : "failed",
      conflictPaths: mutation.conflictPaths,
      summary:
        mutation.conflictPaths.length > 0
          ? "Integration paused with unresolved conflicts; no ours/theirs or automatic abort was applied"
          : mutation.error.message,
      updatedAt: now().toISOString(),
    })
  }
  const resultHead =
    input.strategy === "none"
      ? input.expectedTargetHead
      : await gitText(
          input.git,
          targetWorktreePath,
          ["rev-parse", "HEAD"],
          "integrated HEAD inspection",
          input.signal,
        )
  const after = await input.gates.run({
    integrationId: record.id,
    runId: input.runId,
    taskId: input.taskId,
    workspaceRoot: targetWorktreePath,
    sourceHead,
    targetHead: resultHead,
    phase: "after-integration",
    ...(input.signal ? { signal: input.signal } : {}),
  })
  return transitionGitIntegrationRecord(input.ledgerPath, record.id, record.revision, {
    status: after.passed ? "passed" : "paused",
    resultHead,
    summary: after.passed
      ? input.strategy === "none"
        ? "No integration requested; branch and worktree retained for inspection"
        : "Integration and integration-specific gates passed"
      : `Integration mutation completed but post-integration gates failed: ${after.summary}`,
    updatedAt: now().toISOString(),
  })
}

export async function removeManagedTaskWorktree(input: {
  ledgerPath: string
  record: GitWorktreeRecord
  git: GitCommandPort
  signal?: AbortSignal
  now?: () => Date
}): Promise<GitWorktreeRecord> {
  if (input.record.status !== "integrated" && input.record.status !== "retained") {
    throw new RalphError(
      "RALPH_GIT_WORKTREE_REMOVAL_UNSAFE",
      "Only an integrated or explicitly retained worktree can be removed",
      { exitCode: EXIT_CODES.conflict, details: { status: input.record.status } },
    )
  }
  const paths = await resolveManagedWorktreePath({
    repositoryRoot: input.record.repositoryRoot,
    runId: input.record.runId,
    taskId: input.record.taskId,
    attemptId: input.record.attemptId,
  })
  if (comparable(paths.worktreePath) !== comparable(resolve(input.record.worktreePath))) {
    throw new RalphError(
      "RALPH_GIT_WORKTREE_REMOVAL_UNSAFE",
      "Persisted worktree path is outside the exact managed target",
      {
        exitCode: EXIT_CODES.permissionDenied,
        details: { expected: paths.worktreePath, observed: input.record.worktreePath },
      },
    )
  }
  const status = await gitText(
    input.git,
    paths.worktreePath,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    "pre-removal worktree status inspection",
    input.signal,
  )
  if (status.length > 0) {
    throw new RalphError(
      "RALPH_GIT_WORKTREE_REMOVAL_DIRTY",
      "Managed worktree contains changes and cannot be removed automatically",
      {
        exitCode: EXIT_CODES.conflict,
        details: { paths: statusPaths(status).slice(0, 1_000) },
        hint: "Retain or checkpoint the worktree; removal never uses --force, reset --hard or clean.",
      },
    )
  }
  await runGit(
    input.git,
    paths.repositoryRoot,
    ["worktree", "remove", "--", paths.worktreePath],
    "managed worktree removal",
    input.signal,
  )
  return transitionGitWorktreeRecord(input.ledgerPath, input.record.id, input.record.revision, {
    status: "removed",
    updatedAt: (input.now ?? (() => new Date()))().toISOString(),
  })
}

export async function integrateWorktreesInOrder<
  T extends { order: number; taskId: string },
>(input: {
  items: readonly T[]
  integrate: (item: T) => Promise<GitIntegrationRecord>
}): Promise<GitIntegrationRecord[]> {
  const ordered = [...input.items].sort(
    (left, right) => left.order - right.order || left.taskId.localeCompare(right.taskId),
  )
  const results: GitIntegrationRecord[] = []
  for (const item of ordered) {
    const result = await input.integrate(item)
    results.push(result)
    if (
      result.status === "conflicted" ||
      result.status === "failed" ||
      result.status === "paused"
    ) {
      break
    }
  }
  return results
}
