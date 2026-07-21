import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import type { VerificationSpec } from "@ralph/prd"
import { evaluateVerificationApplicability } from "./applicability"
import { validateArtifactContract } from "./artifact-contract"
import type {
  GateExecutionContext,
  GateExecutionOutcome,
  VerificationResult,
  VerificationRunOptions,
  VerificationStatus,
} from "./gate-contracts"
import { GateExecutorRegistry } from "./gate-registry"
import { executeGitGate } from "./git-gate"
import { resolveSafeWorkspaceTarget } from "./path-safety"
import { runStructuredCommand } from "./process"
import { validateJsonDocumentAgainstSchema } from "./schema-gate"

export type {
  GateExecutionContext,
  GateExecutionOutcome,
  GateExecutor,
  PluginGateExecutor,
  VerificationResult,
  VerificationRunOptions,
  VerificationStatus,
} from "./gate-contracts"
export { GateExecutorRegistry } from "./gate-registry"

function skipRequest(
  specification: VerificationSpec,
  options: VerificationRunOptions,
): string | undefined {
  if (options.noGates) return "Skipped by explicit no-gates request"
  if (options.skipGateIdsOrCategories?.has(specification.id)) {
    return `Skipped by explicit gate ID: ${specification.id}`
  }
  if (options.skipGateIdsOrCategories?.has(specification.category)) {
    return `Skipped by explicit gate category: ${specification.category}`
  }
  if (options.skipTests && specification.category === "test") {
    return "Skipped by explicit test skip request"
  }
  if (options.skipLint && specification.category === "lint") {
    return "Skipped by explicit lint skip request"
  }
  if (options.fast === true) return "Skipped by explicit --fast request"
  return undefined
}

function baseResult(
  specification: VerificationSpec,
  started: number,
  attempts = 0,
): VerificationResult {
  return {
    gateId: specification.id,
    category: specification.category,
    blocking: specification.blocking,
    skipPolicy: specification.skipPolicy,
    ...(specification.type !== "instruction" && specification.criterionIds
      ? { criterionIds: [...specification.criterionIds] }
      : {}),
    status: "unavailable",
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    attempts,
    outputRefs: [],
    overridden: false,
  }
}

async function persistCommandOutput(
  specification: VerificationSpec,
  context: GateExecutionContext,
  stdout: string,
  stderr: string,
): Promise<string[]> {
  if (!context.persistOutput) return []
  const refs: string[] = []
  if (stdout) refs.push(await context.persistOutput(specification.id, "stdout", stdout))
  if (stderr) refs.push(await context.persistOutput(specification.id, "stderr", stderr))
  return refs
}

async function executeCommandGate(
  specification: Extract<VerificationSpec, { type: "command" }>,
  context: GateExecutionContext,
): Promise<GateExecutionOutcome> {
  const execution = await runStructuredCommand(specification.command, {
    workspaceRoot: context.workspaceRoot,
    signal: context.signal,
    ...(context.environment ? { environment: context.environment } : {}),
    ...(context.environmentRoot ? { environmentRoot: context.environmentRoot } : {}),
    ...(context.rawOutputLimitBytes ? { rawOutputLimitBytes: context.rawOutputLimitBytes } : {}),
    ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
  })
  const outputRefs = await persistCommandOutput(
    specification,
    context,
    execution.rawStdout,
    execution.rawStderr,
  )
  const shared = {
    command: specification.command,
    ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
    outputRefs,
    stdoutBytes: execution.stdoutBytes,
    stderrBytes: execution.stderrBytes,
    outputTruncated: execution.truncated,
    rawOutputTruncated: execution.rawTruncated,
    deadlineExceeded: execution.deadlineExceeded,
  }
  if (execution.error) return { ...shared, status: "unavailable", reason: execution.error }
  if (execution.deadlineExceeded) {
    return { ...shared, status: "timeout", reason: "Task execution deadline was exceeded" }
  }
  if (execution.timedOut) return { ...shared, status: "timeout", reason: "Command timed out" }
  const passed =
    execution.exitCode !== undefined &&
    specification.command.successExitCodes.includes(execution.exitCode)
  return passed
    ? { ...shared, status: "passed" }
    : {
        ...shared,
        status: "failed",
        reason: `Unexpected exit code ${String(execution.exitCode)}`,
      }
}

async function executeFileGate(
  specification: Extract<VerificationSpec, { type: "file" }>,
  context: GateExecutionContext,
): Promise<GateExecutionOutcome> {
  const target = await resolveSafeWorkspaceTarget(context.workspaceRoot, specification.path)
  const expectation = specification.expectation
  if (expectation.kind === "absent") {
    return target.exists
      ? { status: "failed", reason: `File must be absent: ${specification.path}` }
      : { status: "passed" }
  }
  if (!target.exists) {
    return { status: "failed", reason: `Required file does not exist: ${specification.path}` }
  }
  const metadata = await lstat(target.target)
  if (!metadata.isFile()) {
    return {
      status: "failed",
      reason: `Verification target is not a regular file: ${specification.path}`,
    }
  }
  if (expectation.kind === "exists") return { status: "passed" }
  if (expectation.kind === "non-empty") {
    return metadata.size > 0
      ? { status: "passed" }
      : { status: "failed", reason: `File is empty: ${specification.path}` }
  }
  if (expectation.kind === "sha256") {
    const digest = createHash("sha256")
      .update(await readFile(target.target))
      .digest("hex")
    return digest === expectation.value
      ? { status: "passed" }
      : { status: "failed", reason: `File hash mismatch: ${specification.path}` }
  }
  return validateJsonDocumentAgainstSchema(
    context.workspaceRoot,
    specification.path,
    expectation.schema,
  )
}

async function executeSchemaGate(
  specification: Extract<VerificationSpec, { type: "schema" }>,
  context: GateExecutionContext,
): Promise<GateExecutionOutcome> {
  return validateJsonDocumentAgainstSchema(
    context.workspaceRoot,
    specification.path,
    specification.schema,
  )
}

async function executeArtifactGate(
  specification: Extract<VerificationSpec, { type: "artifact" }>,
  context: GateExecutionContext,
): Promise<GateExecutionOutcome> {
  const validation = await validateArtifactContract(context.workspaceRoot, specification)
  return {
    status: validation.status,
    ...(validation.reason ? { reason: validation.reason } : {}),
  }
}

export function createDefaultGateExecutorRegistry(): GateExecutorRegistry {
  return new GateExecutorRegistry()
    .register("command", executeCommandGate)
    .register("file", executeFileGate)
    .register("schema", executeSchemaGate)
    .register("git", executeGitGate)
    .register("artifact", executeArtifactGate)
}

function effectiveAttemptDeadline(
  specification: VerificationSpec,
  taskDeadlineAt: string | undefined,
): { deadlineAt?: string; deadlineExceeded: boolean; invalid?: string } {
  const taskDeadline = taskDeadlineAt ? Date.parse(taskDeadlineAt) : undefined
  if (taskDeadline !== undefined && !Number.isFinite(taskDeadline)) {
    return {
      deadlineExceeded: false,
      invalid: `Execution deadline is not a valid timestamp: ${taskDeadlineAt}`,
    }
  }
  const timeoutMs = specification.type === "instruction" ? undefined : specification.timeoutMs
  const gateDeadline = timeoutMs ? Date.now() + timeoutMs : undefined
  const deadline =
    taskDeadline === undefined
      ? gateDeadline
      : gateDeadline === undefined
        ? taskDeadline
        : Math.min(taskDeadline, gateDeadline)
  if (deadline === undefined) return { deadlineExceeded: false }
  return {
    deadlineAt: new Date(deadline).toISOString(),
    deadlineExceeded: taskDeadline !== undefined && taskDeadline <= deadline,
  }
}

async function executeAttempt(
  specification: VerificationSpec,
  options: VerificationRunOptions,
  registry: GateExecutorRegistry,
  attempt: number,
): Promise<GateExecutionOutcome> {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error("Verification cancelled before gate execution")
  }
  const deadline = effectiveAttemptDeadline(specification, options.deadlineAt)
  if (deadline.invalid) return { status: "error", reason: deadline.invalid }
  if (deadline.deadlineAt && Date.parse(deadline.deadlineAt) <= Date.now()) {
    return {
      status: "timeout",
      reason: deadline.deadlineExceeded
        ? "Task execution deadline was exceeded"
        : "Gate timeout was exceeded",
      deadlineExceeded: deadline.deadlineExceeded,
    }
  }

  const controller = new AbortController()
  const onExternalAbort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", onExternalAbort, { once: true })
  if (options.signal?.aborted) onExternalAbort()
  const operation = registry.execute(specification, {
    workspaceRoot: options.workspaceRoot,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.environmentRoot ? { environmentRoot: options.environmentRoot } : {}),
    ...(options.rawOutputLimitBytes ? { rawOutputLimitBytes: options.rawOutputLimitBytes } : {}),
    ...(deadline.deadlineAt ? { deadlineAt: deadline.deadlineAt } : {}),
    signal: controller.signal,
    attempt,
    ...(options.persistOutput ? { persistOutput: options.persistOutput } : {}),
  })
  if (!deadline.deadlineAt) {
    try {
      const outcome = await operation
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error("Verification cancelled during gate execution")
      }
      return outcome
    } finally {
      options.signal?.removeEventListener("abort", onExternalAbort)
    }
  }

  const remaining = Date.parse(deadline.deadlineAt) - Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<GateExecutionOutcome>((resolveTimeout) => {
    timer = setTimeout(
      () => {
        controller.abort()
        resolveTimeout({
          status: "timeout",
          reason: deadline.deadlineExceeded
            ? "Task execution deadline was exceeded"
            : "Gate timeout was exceeded",
          deadlineExceeded: deadline.deadlineExceeded,
        })
      },
      Math.max(0, remaining),
    )
  })
  try {
    const outcome = await Promise.race([operation, timeout])
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Verification cancelled during gate execution")
    }
    return outcome
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener("abort", onExternalAbort)
    void operation.catch(() => undefined)
  }
}

const RETRYABLE_STATUSES = new Set<VerificationStatus>([
  "failed",
  "timeout",
  "error",
  "unavailable",
])

export async function runVerification(
  specification: VerificationSpec,
  options: VerificationRunOptions,
): Promise<VerificationResult> {
  const started = performance.now()
  if (specification.type === "instruction") {
    return {
      ...baseResult(specification, started),
      blocking: false,
      skipPolicy: "never-run",
      status: "skipped_by_policy",
      reason: "Human instruction is context, not an executable verification gate",
    }
  }
  if (specification.skipPolicy === "never-run") {
    return {
      ...baseResult(specification, started),
      status: "skipped_by_policy",
      reason: "Verification policy is never-run",
    }
  }

  const applicability = await evaluateVerificationApplicability(specification, {
    workspaceRoot: options.workspaceRoot,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.changedPaths ? { changedPaths: options.changedPaths } : {}),
  })
  if (applicability.status !== "applicable") {
    return {
      ...baseResult(specification, started),
      status: applicability.status,
      reason: applicability.reason,
    }
  }

  const requestedSkip = skipRequest(specification, options)
  if (requestedSkip) {
    const canSkip =
      specification.skipPolicy === "allowed-to-skip" || specification.skipPolicy === "optional"
    if (canSkip || options.force) {
      return {
        ...baseResult(specification, started),
        status: "skipped_by_cli",
        reason: canSkip
          ? requestedSkip
          : `Required verification skipped by explicit --force override (${requestedSkip})`,
        overridden: !canSkip,
      }
    }
  }

  const registry = options.registry ?? createDefaultGateExecutorRegistry()
  const maximumAttempts = specification.attempts ?? 1
  const outputRefs: string[] = []
  let outcome: GateExecutionOutcome = {
    status: "unavailable",
    reason: "Gate produced no execution outcome",
  }
  let attempts = 0
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    attempts = attempt
    try {
      outcome = await executeAttempt(specification, options, registry, attempt)
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error("Verification cancelled during gate execution", { cause: error })
      }
      outcome = { status: "error", reason: error instanceof Error ? error.message : String(error) }
    }
    outputRefs.push(...(outcome.outputRefs ?? []))
    if (!RETRYABLE_STATUSES.has(outcome.status) || attempt === maximumAttempts) break
    if (outcome.deadlineExceeded) break
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Verification cancelled before gate retry")
    }
  }
  return {
    ...baseResult(specification, started, attempts),
    ...outcome,
    outputRefs: [...new Set(outputRefs)],
  }
}

export function isBlockingVerificationFailure(result: VerificationResult): boolean {
  if (!result.blocking || result.status === "passed" || result.status === "not_applicable") {
    return false
  }
  if (result.overridden) return false
  if (
    result.status === "skipped_by_cli" &&
    (result.skipPolicy === "allowed-to-skip" || result.skipPolicy === "optional")
  ) {
    return false
  }
  return true
}

function failFastResult(specification: VerificationSpec, failedGateId: string): VerificationResult {
  return {
    gateId: specification.id,
    category: specification.category,
    blocking: specification.blocking,
    skipPolicy: specification.skipPolicy,
    ...(specification.type !== "instruction" && specification.criterionIds
      ? { criterionIds: [...specification.criterionIds] }
      : {}),
    status: "skipped_by_policy",
    durationMs: 0,
    attempts: 0,
    outputRefs: [],
    reason: `Not run because fail-fast stopped after blocking gate ${failedGateId}`,
    overridden: false,
  }
}

export async function runVerifications(
  specifications: readonly VerificationSpec[],
  options: VerificationRunOptions,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = []
  const registry = options.registry ?? createDefaultGateExecutorRegistry()
  const executableSpecifications = specifications.filter(
    (specification) => specification.type !== "instruction",
  )
  for (let index = 0; index < executableSpecifications.length; index += 1) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Verification cancelled before the next gate")
    }
    const specification = executableSpecifications[index]
    if (!specification) continue
    const result = await runVerification(specification, { ...options, registry })
    results.push(result)
    if (options.failFast && isBlockingVerificationFailure(result)) {
      for (const remaining of executableSpecifications.slice(index + 1)) {
        results.push(failFastResult(remaining, result.gateId))
      }
      break
    }
  }
  return results
}
