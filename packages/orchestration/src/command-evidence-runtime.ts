import { randomUUID } from "node:crypto"
import { basename, resolve } from "node:path"

import {
  type CommandEvidenceSelection,
  CommandEvidenceSelectionSchema,
  commandOperationReportHash,
  type EffectiveConfig,
  EvaluationProfileSnapshotSchema,
  EvidenceBundleV2Schema,
  EXIT_CODES,
  type JudgmentCommandReport,
  JudgmentCommandReportSchema,
  RalphError,
  type VerificationCommandReport,
  VerificationCommandReportSchema,
} from "@ralph-next/domain"
import {
  buildJudgeEvaluationBundle,
  createJudgeEvaluator,
  type JudgeBackendResolver,
  type JudgeEventSink,
  type JudgeKind,
} from "@ralph-next/evaluation"
import {
  appendEvent,
  createCommandOperation,
  failCommandOperation,
  finishCommandOperation,
  getAttempt,
  getCommandOperation,
  getEvidenceBundle,
  getEvidenceBundleById,
  getRun,
  getRunTask,
  listAttempts,
  persistEvidenceBundleObject,
  readEvidenceBundleObject,
  runLayout,
  workspaceLayout,
} from "@ralph-next/persistence"
import {
  type CompiledPrdGraph,
  compilePrdGraph,
  detectPrdFile,
  hashCanonicalValue,
  type PrdDocument,
  type PrdTask,
} from "@ralph-next/prd"
import { redactValue, secretValuesFromEnvironment } from "@ralph-next/telemetry"
import {
  buildEvidenceBundle,
  captureWorkspaceBaseline,
  changeEvidenceFromWorkspace,
  collectArtifactEvidence,
  compareWorkspaceBaselines,
  decideAssessedCompletion,
  decideDeterministicCompletion,
  type GateExecutorRegistry,
  gateResultFromVerification,
  gitBaselineFromWorkspace,
  persistContentAddressedBytes,
  runVerifications,
  verifyWorkspaceBaselineContent,
  type WorkspaceBaseline,
} from "@ralph-next/verification"
import { loadTaskBaseline } from "./baseline"
import { evaluationPolicyForTask } from "./evaluation"
import {
  isJudgeAttachmentIntegrityDiagnostic,
  judgeAttachmentMaterializationEventPayload,
  materializeJudgeTextAttachments,
} from "./judge-attachments"
import { normalizeJudgeBackendEventPayload } from "./judge-backend-events"
import { type RunOptionOverrides, resolveEffectiveRunOptions } from "./options"
import { materializeAdHocExecutionSource, type VerificationRegistryScope } from "./runner"

const SAFETY_BOUNDARY = {
  executorInvocation: "forbidden",
  toolCalling: "forbidden",
  taskStateMutation: "forbidden",
  prdMarkerMutation: "forbidden",
} as const

export type CommandEvidenceSelectorInput = {
  runId?: string
  task?: string
  attemptId?: string
  evidenceBundleId?: string
  verificationOperationId?: string
  positional?: string
}

type ResolvedEvidence = {
  selection: CommandEvidenceSelection
  evidence: ReturnType<typeof EvidenceBundleV2Schema.parse>
  run: NonNullable<ReturnType<typeof getRun>>
  attempt: NonNullable<ReturnType<typeof getAttempt>>
  document: PrdDocument
  task: PrdTask
}

type RuntimeBase = {
  workspaceRoot: string
  workspaceId: string
  selector: CommandEvidenceSelectorInput
  environment?: Record<string, string | undefined>
  signal?: AbortSignal
  now?: () => string
  id?: (kind: "operation" | "evidence" | "report" | "judge-call" | "assessment") => string
}

export type ExecuteVerifyCommandInput = RuntimeBase & {
  gatePolicy: {
    skipTests: boolean
    skipLint: boolean
    skipGates: readonly string[]
    noGates: boolean
    fast: boolean
    force: boolean
    failFast: boolean
  }
  gateRegistryFactory?: (scope: VerificationRegistryScope) => GateExecutorRegistry
}

export type ExecuteJudgeCommandInput = RuntimeBase & {
  effectiveConfig: EffectiveConfig
  optionOverrides?: RunOptionOverrides
  resolveJudge: JudgeBackendResolver
}

function cancellationError(signal: AbortSignal | undefined): RalphError {
  return new RalphError("RALPH_COMMAND_OPERATION_CANCELLED", "Command operation was cancelled", {
    exitCode: EXIT_CODES.interrupted,
    cause: signal?.reason,
  })
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancellationError(signal)
}

function operationError(error: unknown): { code: string; message: string; cancelled: boolean } {
  if (error instanceof RalphError) {
    return {
      code: error.code,
      message: error.message,
      cancelled: error.exitCode === EXIT_CODES.interrupted,
    }
  }
  return {
    code: "RALPH_COMMAND_OPERATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    cancelled: false,
  }
}

function forcedOverrideGateIds(
  evidence: ReturnType<typeof EvidenceBundleV2Schema.parse>,
): ReadonlySet<string> {
  return new Set(
    evidence.gates
      .filter(
        (gate) =>
          gate.blocking &&
          gate.status === "skipped_by_cli" &&
          gate.skipPolicy !== "allowed-to-skip" &&
          gate.skipPolicy !== "optional",
      )
      .map((gate) => gate.gateId),
  )
}

function taskSelectorMatches(
  value: string | undefined,
  documentId: string,
  taskId: string,
): boolean {
  if (!value) return true
  const normalized = value.startsWith("task:") ? value.slice("task:".length) : value
  return normalized.includes("/") ? normalized === `${documentId}/${taskId}` : normalized === taskId
}

function assertSelectorConsistency(
  selector: CommandEvidenceSelectorInput,
  value: {
    runId: string
    documentId: string
    taskId: string
    attemptId: string
    evidenceId: string
  },
): void {
  if (selector.runId && selector.runId !== value.runId) {
    throw new RalphError(
      "RALPH_COMMAND_RUN_SELECTOR_MISMATCH",
      "--run-id does not match the selected evidence",
      {
        exitCode: EXIT_CODES.invalidUsage,
      },
    )
  }
  if (selector.attemptId && selector.attemptId !== value.attemptId) {
    throw new RalphError(
      "RALPH_COMMAND_ATTEMPT_SELECTOR_MISMATCH",
      "--attempt-id does not match the selected evidence",
      {
        exitCode: EXIT_CODES.invalidUsage,
      },
    )
  }
  if (selector.evidenceBundleId && selector.evidenceBundleId !== value.evidenceId) {
    throw new RalphError(
      "RALPH_COMMAND_EVIDENCE_SELECTOR_MISMATCH",
      "--evidence-bundle-id does not match the selected evidence",
      {
        exitCode: EXIT_CODES.invalidUsage,
      },
    )
  }
  if (!taskSelectorMatches(selector.task, value.documentId, value.taskId)) {
    throw new RalphError(
      "RALPH_COMMAND_TASK_SELECTOR_MISMATCH",
      "--task does not match the selected evidence",
      {
        exitCode: EXIT_CODES.invalidUsage,
      },
    )
  }
}

function positionalSelection(selector: CommandEvidenceSelectorInput): CommandEvidenceSelectorInput {
  const raw = selector.positional
  if (!raw) return selector
  if (
    selector.task ||
    selector.attemptId ||
    selector.evidenceBundleId ||
    selector.verificationOperationId
  ) {
    throw new RalphError(
      "RALPH_COMMAND_SELECTOR_CONFLICT",
      "A positional selector cannot be combined with --task, --attempt-id, --evidence-bundle-id or --verification-id",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (raw.startsWith("task:")) {
    const task = raw.slice("task:".length)
    if (!task)
      throw new RalphError("RALPH_COMMAND_SELECTOR_INVALID", "task: selector is empty", {
        exitCode: EXIT_CODES.invalidUsage,
      })
    return { ...selector, task }
  }
  if (raw.startsWith("attempt:")) {
    const attemptId = raw.slice("attempt:".length)
    if (!attemptId)
      throw new RalphError("RALPH_COMMAND_SELECTOR_INVALID", "attempt: selector is empty", {
        exitCode: EXIT_CODES.invalidUsage,
      })
    return { ...selector, attemptId }
  }
  if (raw.startsWith("evidence:")) {
    const evidenceBundleId = raw.slice("evidence:".length)
    if (!evidenceBundleId)
      throw new RalphError("RALPH_COMMAND_SELECTOR_INVALID", "evidence: selector is empty", {
        exitCode: EXIT_CODES.invalidUsage,
      })
    return { ...selector, evidenceBundleId }
  }
  if (raw.startsWith("verification:")) {
    const verificationOperationId = raw.slice("verification:".length)
    if (!verificationOperationId)
      throw new RalphError("RALPH_COMMAND_SELECTOR_INVALID", "verification: selector is empty", {
        exitCode: EXIT_CODES.invalidUsage,
      })
    return { ...selector, verificationOperationId }
  }
  if (raw.includes("/")) return { ...selector, task: raw }
  throw new RalphError(
    "RALPH_COMMAND_SELECTOR_AMBIGUOUS",
    `Unprefixed selector is ambiguous: ${raw}`,
    {
      exitCode: EXIT_CODES.invalidUsage,
      hint: "Use task:<document/task>, attempt:<attempt-id>, evidence:<bundle-id>, verification:<operation-id>, or the explicit flags.",
    },
  )
}

function executionEvidenceCandidate(
  ledger: string,
  selector: CommandEvidenceSelectorInput,
): {
  evidence: ReturnType<typeof EvidenceBundleV2Schema.parse>
  attempt: NonNullable<ReturnType<typeof getAttempt>>
} {
  if (selector.evidenceBundleId) {
    const record = getEvidenceBundleById(ledger, selector.evidenceBundleId)
    if (!record) {
      throw new RalphError(
        "RALPH_COMMAND_EVIDENCE_NOT_FOUND",
        `Evidence bundle was not found: ${selector.evidenceBundleId}`,
        {
          exitCode: EXIT_CODES.invalidUsage,
        },
      )
    }
    const attempt = getAttempt(ledger, record.attemptId)
    if (!attempt)
      throw new RalphError(
        "RALPH_COMMAND_ATTEMPT_NOT_FOUND",
        `Attempt was not found: ${record.attemptId}`,
        { exitCode: EXIT_CODES.conflict },
      )
    return { evidence: EvidenceBundleV2Schema.parse(record.bundle), attempt }
  }
  if (selector.attemptId) {
    const attempt = getAttempt(ledger, selector.attemptId)
    if (!attempt) {
      throw new RalphError(
        "RALPH_COMMAND_ATTEMPT_NOT_FOUND",
        `Attempt was not found: ${selector.attemptId}`,
        {
          exitCode: EXIT_CODES.invalidUsage,
        },
      )
    }
    const record = getEvidenceBundle(ledger, attempt.id)
    if (!record) {
      throw new RalphError(
        "RALPH_COMMAND_EVIDENCE_NOT_FOUND",
        `Attempt has no persisted evidence: ${attempt.id}`,
        {
          exitCode: EXIT_CODES.blocked,
        },
      )
    }
    return { evidence: EvidenceBundleV2Schema.parse(record.bundle), attempt }
  }

  if (!selector.runId) {
    throw new RalphError(
      "RALPH_COMMAND_RUN_SELECTOR_REQUIRED",
      "Task-based evidence selection requires one exact --run-id",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Alternatively select an immutable --attempt-id or --evidence-bundle-id.",
      },
    )
  }
  if (!getRun(ledger, selector.runId)) {
    throw new RalphError("RALPH_COMMAND_RUN_NOT_FOUND", `Run was not found: ${selector.runId}`, {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  const candidates = listAttempts(ledger, { runId: selector.runId })
    .filter((attempt) => taskSelectorMatches(selector.task, attempt.documentId, attempt.taskId))
    .map((attempt) => ({ attempt, record: getEvidenceBundle(ledger, attempt.id) }))
    .filter((candidate) => candidate.record !== undefined)
  const byTaskAndRun = new Map<string, (typeof candidates)[number][]>()
  for (const candidate of candidates) {
    const key = `${candidate.attempt.runId}\0${candidate.attempt.documentId}/${candidate.attempt.taskId}`
    const values = byTaskAndRun.get(key) ?? []
    values.push(candidate)
    byTaskAndRun.set(key, values)
  }
  if (byTaskAndRun.size !== 1) {
    throw new RalphError(
      "RALPH_COMMAND_SELECTOR_AMBIGUOUS",
      byTaskAndRun.size === 0
        ? "No persisted evidence matches the requested run/task selectors"
        : "Run/task selector matches more than one persisted task evidence stream",
      {
        exitCode: byTaskAndRun.size === 0 ? EXIT_CODES.invalidUsage : EXIT_CODES.conflict,
        hint: "Provide --run-id with --task <document/task>, or select one exact --attempt-id.",
      },
    )
  }
  const selected = [...byTaskAndRun.values()][0]?.sort(
    (left, right) => right.attempt.ordinal - left.attempt.ordinal,
  )[0]
  if (!selected?.record) throw new Error("Resolved evidence candidate disappeared")
  return {
    evidence: EvidenceBundleV2Schema.parse(selected.record.bundle),
    attempt: selected.attempt,
  }
}

async function resolveCommandEvidence(
  input: RuntimeBase,
  allowVerificationEvidence: boolean,
): Promise<ResolvedEvidence> {
  const layout = workspaceLayout(input.workspaceRoot)
  const selector = positionalSelection(input.selector)
  let evidence: ReturnType<typeof EvidenceBundleV2Schema.parse>
  let attempt: NonNullable<ReturnType<typeof getAttempt>>
  let source: CommandEvidenceSelection["source"] = "execution-evidence"
  let verificationOperationId: string | undefined

  if (selector.verificationOperationId) {
    if (!allowVerificationEvidence) {
      throw new RalphError(
        "RALPH_VERIFY_SOURCE_INVALID",
        "verify cannot derive from a prior verify operation",
        {
          exitCode: EXIT_CODES.invalidUsage,
        },
      )
    }
    const operation = getCommandOperation(layout.ledger, selector.verificationOperationId)
    if (
      !operation ||
      operation.command !== "verify" ||
      operation.status !== "succeeded" ||
      operation.report?.command !== "verify"
    ) {
      throw new RalphError(
        "RALPH_VERIFICATION_OPERATION_NOT_FOUND",
        `Completed verification operation was not found: ${selector.verificationOperationId}`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    const persistedVerificationEvidence = await readEvidenceBundleObject(
      input.workspaceRoot,
      operation.report.evidenceObject,
    )
    evidence = EvidenceBundleV2Schema.parse(persistedVerificationEvidence)
    if (
      evidence.id !== operation.report.evidence.id ||
      evidence.contentHash !== operation.report.evidence.contentHash
    ) {
      throw new RalphError(
        "RALPH_VERIFICATION_EVIDENCE_OBJECT_MISMATCH",
        "Persisted verification evidence object does not match its durable report",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    attempt = getAttempt(layout.ledger, evidence.attemptId) as NonNullable<
      ReturnType<typeof getAttempt>
    >
    if (!attempt)
      throw new RalphError(
        "RALPH_COMMAND_ATTEMPT_NOT_FOUND",
        `Attempt was not found: ${evidence.attemptId}`,
        { exitCode: EXIT_CODES.conflict },
      )
    source = "verification-evidence"
    verificationOperationId = operation.id
  } else {
    const candidate = executionEvidenceCandidate(layout.ledger, selector)
    evidence = candidate.evidence
    attempt = candidate.attempt
  }

  assertSelectorConsistency(selector, {
    runId: attempt.runId,
    documentId: attempt.documentId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    evidenceId: evidence.id,
  })
  const run = getRun(layout.ledger, attempt.runId)
  if (!run || run.workspaceId !== input.workspaceId) {
    throw new RalphError(
      "RALPH_COMMAND_RUN_NOT_FOUND",
      "Selected evidence does not belong to this workspace",
      {
        exitCode: EXIT_CODES.conflict,
      },
    )
  }
  let graph: CompiledPrdGraph
  if (run.source?.kind === "ad-hoc") {
    const materialized = materializeAdHocExecutionSource(run.source.description)
    if (
      materialized.source.kind !== "ad-hoc" ||
      materialized.source.descriptionHash !== run.source.descriptionHash ||
      materialized.rootFile !== run.rootPrdFile ||
      materialized.graph.rootDocumentId !== run.rootPrdId ||
      materialized.graph.definitionHash !== run.definitionHash ||
      materialized.graph.graphHash !== run.graphHash
    ) {
      throw new RalphError(
        "RALPH_COMMAND_AD_HOC_BINDING_INVALID",
        "Persisted ad-hoc source does not reproduce the selected run definition",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    graph = materialized.graph
  } else {
    if (run.rootPrdFile.startsWith("@ad-hoc/")) {
      throw new RalphError(
        "RALPH_COMMAND_AD_HOC_SOURCE_MISSING",
        "Legacy run uses a virtual ad-hoc root but has no persisted ad-hoc source",
        {
          exitCode: EXIT_CODES.conflict,
          hint: "Select evidence from a newer run that persists its command-supplied source.",
        },
      )
    }
    if (
      run.source?.kind === "prd" &&
      (run.source.prdFile !== run.rootPrdFile || run.source.prdId !== run.rootPrdId)
    ) {
      throw new RalphError(
        "RALPH_COMMAND_PRD_SOURCE_MISMATCH",
        "Persisted PRD source does not match the selected run root",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    const compiled = await compilePrdGraph(resolve(input.workspaceRoot, run.rootPrdFile), {
      workspaceRoot: input.workspaceRoot,
      recursive: true,
      strict: true,
    })
    if (!compiled.ok || !compiled.graph) {
      throw new RalphError(
        "RALPH_COMMAND_PRD_INVALID",
        "The selected run PRD no longer compiles strictly",
        {
          exitCode: EXIT_CODES.invalidPrd,
          details: { diagnostics: compiled.diagnostics },
        },
      )
    }
    graph = compiled.graph
  }
  if (graph.definitionHash !== run.definitionHash || graph.graphHash !== run.graphHash) {
    throw new RalphError(
      "RALPH_COMMAND_PRD_DEFINITION_CHANGED",
      "Current work definition differs from the selected run",
      {
        exitCode: EXIT_CODES.conflict,
      },
    )
  }
  const document = graph.documents[attempt.documentId]
  const task = document?.tasks.find((candidate) => candidate.id === attempt.taskId)
  if (!document || !task || task.taskSpecHash !== evidence.taskSpecHash) {
    throw new RalphError(
      "RALPH_COMMAND_TASK_BINDING_INVALID",
      "Selected evidence no longer matches the compiled task definition",
      {
        exitCode: EXIT_CODES.conflict,
      },
    )
  }
  const selection = CommandEvidenceSelectionSchema.parse({
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    runId: run.id,
    documentId: document.id,
    taskId: task.id,
    attemptId: attempt.id,
    evidenceBundleId: evidence.id,
    evidenceContentHash: evidence.contentHash,
    source,
    ...(verificationOperationId ? { verificationOperationId } : {}),
  })
  return { selection, evidence, run, attempt, document, task }
}

async function persistDiff(input: {
  workspaceRoot: string
  directory: string
  runId: string
  attemptId: string
  operationId: string
  kind: "task" | "attempt" | "gate"
  before: WorkspaceBaseline
  after: WorkspaceBaseline
}) {
  const changes = compareWorkspaceBaselines(input.before, input.after)
  await Promise.all([
    verifyWorkspaceBaselineContent(
      input.workspaceRoot,
      input.before,
      changes.changed.filter((path) => input.before.files[path]?.contentRef),
    ),
    verifyWorkspaceBaselineContent(
      input.workspaceRoot,
      input.after,
      changes.changed.filter((path) => input.after.files[path]?.contentRef),
    ),
  ])
  const missingContent = changes.changed.flatMap((path) =>
    (["before", "after"] as const).flatMap((side) => {
      const snapshot = side === "before" ? input.before.files[path] : input.after.files[path]
      return snapshot && !snapshot.contentRef
        ? [{ path, side, reason: `content was not retained (${snapshot.retentionStatus})` }]
        : []
    }),
  )
  const manifest = {
    schemaVersion: 1,
    mediaType: "application/vnd.ralph.workspace-diff+json",
    kind: input.kind,
    runId: input.runId,
    attemptId: input.attemptId,
    operationId: input.operationId,
    scope: input.before.scope,
    beforeHash: changes.beforeHash,
    afterHash: changes.afterHash,
    created: changes.created,
    modified: changes.modified,
    deleted: changes.deleted,
    outsideScope: changes.outsideScope,
    reproducible: missingContent.length === 0,
    missingContent,
    files: changes.changed.map((path) => ({
      path,
      before: input.before.files[path] ?? null,
      after: input.after.files[path] ?? null,
    })),
  }
  const stored = await persistContentAddressedBytes(
    input.workspaceRoot,
    { directory: input.directory },
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    { suffix: ".json" },
  )
  return {
    changes,
    diffHash: stored.contentHash,
    diffRef: stored.ref,
    reproducible: missingContent.length === 0,
    missingContent,
  }
}

function event(
  input: RuntimeBase,
  resolved: ResolvedEvidence,
  operationId: string,
  type: string,
  payload: Record<string, unknown>,
  level: "debug" | "info" | "warn" | "error" = "info",
  callId?: string,
): void {
  try {
    appendEvent(workspaceLayout(input.workspaceRoot).ledger, {
      type,
      scope: "run",
      streamId: resolved.run.id,
      workspaceId: input.workspaceId,
      runId: resolved.run.id,
      documentId: resolved.document.id,
      taskId: resolved.task.id,
      attemptId: resolved.attempt.id,
      ...(callId ? { callId } : {}),
      correlationId: operationId,
      level,
      payload: redactValue(payload, secretValuesFromEnvironment(input.environment ?? {})) as Record<
        string,
        unknown
      >,
    })
  } catch (error) {
    if (error instanceof RalphError) throw error
    throw new RalphError(
      "RALPH_COMMAND_EVENT_PERSISTENCE_FAILED",
      `Command event could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
      { exitCode: EXIT_CODES.operationalError, cause: error },
    )
  }
}

function commandControlState(
  ledger: string,
  resolved: ResolvedEvidence,
): {
  task: NonNullable<ReturnType<typeof getRunTask>>
  attempt: NonNullable<ReturnType<typeof getAttempt>>
} {
  const task = getRunTask(ledger, resolved.run.id, resolved.document.id, resolved.task.id)
  const attempt = getAttempt(ledger, resolved.attempt.id)
  if (!task || !attempt) {
    throw new RalphError(
      "RALPH_COMMAND_CONTROL_STATE_MISSING",
      "Selected task or attempt disappeared while the command was running",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  return { task, attempt }
}

function commandControlStateStable(
  before: ReturnType<typeof commandControlState>,
  after: ReturnType<typeof commandControlState>,
): boolean {
  return JSON.stringify(before) === JSON.stringify(after)
}

async function adHocPrdProtectionViolations(input: {
  workspaceRoot: string
  sourceKind: "prd" | "ad-hoc"
  before: WorkspaceBaseline
  after: WorkspaceBaseline
  changedPaths: readonly string[]
}): Promise<string[]> {
  if (input.sourceKind !== "ad-hoc") return []
  const violations = new Set<string>()
  const detectsPrdOrUnsafeClassification = async (
    absolutePath: string,
    displayPath: string,
  ): Promise<boolean> => {
    const detected = await detectPrdFile(absolutePath, displayPath)
    return (
      detected.format === "v2" ||
      detected.format === "classic" ||
      detected.declaredVersion !== undefined ||
      detected.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "RALPH_PRD_READ_FAILED" ||
          diagnostic.code === "RALPH_PRD_UTF8_INVALID" ||
          diagnostic.code === "RALPH_PRD_VERSION_UNSUPPORTED",
      )
    )
  }
  for (const path of input.changedPaths) {
    if (!path.toLowerCase().endsWith(".md")) continue
    if (/^prd(?:[-_. ].*)?\.md$/i.test(basename(path))) {
      violations.add(path)
      continue
    }
    const before = input.before.files[path]
    if (before?.kind === "symlink") {
      violations.add(path)
      continue
    }
    if (before?.kind === "file") {
      if (!before.contentRef) {
        // The original Markdown classification cannot be reconstructed. Ad-hoc
        // PRD protection is fail-closed instead of trusting the mutable current file.
        violations.add(path)
        continue
      }
      if (
        await detectsPrdOrUnsafeClassification(
          resolve(input.workspaceRoot, before.contentRef),
          `${path} (persisted task baseline)`,
        )
      ) {
        violations.add(path)
        continue
      }
    }
    const after = input.after.files[path]
    if (after?.kind === "symlink") {
      violations.add(path)
      continue
    }
    if (
      after?.kind === "file" &&
      (await detectsPrdOrUnsafeClassification(resolve(input.workspaceRoot, path), path))
    ) {
      violations.add(path)
    }
  }
  return [...violations].sort()
}

export async function executeVerifyCommand(
  input: ExecuteVerifyCommandInput,
): Promise<VerificationCommandReport> {
  assertNotCancelled(input.signal)
  const now = input.now ?? (() => new Date().toISOString())
  const id = input.id ?? ((kind) => `${kind}-${randomUUID()}`)
  const resolved = await resolveCommandEvidence(input, false)
  const layout = workspaceLayout(input.workspaceRoot)
  const operationId = id("operation")
  const startedAt = now()
  const request = {
    schemaVersion: 1 as const,
    command: "verify" as const,
    selection: resolved.selection,
    gatePolicy: { ...input.gatePolicy, skipGates: [...input.gatePolicy.skipGates] },
    safety: SAFETY_BOUNDARY,
  }
  createCommandOperation(layout.ledger, { id: operationId, request, startedAt })
  try {
    const controlBefore = commandControlState(layout.ledger, resolved)
    const isolatedRunLayout = runLayout(layout, resolved.run.id)
    const taskBaseline = await loadTaskBaseline(
      isolatedRunLayout,
      input.workspaceRoot,
      resolved.document.id,
      resolved.task.id,
    )
    if (!taskBaseline || taskBaseline.runId !== resolved.run.id) {
      throw new RalphError(
        "RALPH_VERIFY_BASELINE_UNAVAILABLE",
        "The selected task has no verified durable baseline",
        {
          exitCode: EXIT_CODES.blocked,
        },
      )
    }
    const priorityPaths = resolved.task.verification
      .filter((specification) => specification.type === "artifact")
      .map((specification) => specification.path)
    const preGate = await captureWorkspaceBaseline(input.workspaceRoot, {
      scope: resolved.document.workspace,
      retentionPriorityPaths: priorityPaths,
      objectStore: { directory: isolatedRunLayout.artifacts },
      storageRoot: input.workspaceRoot,
    })
    assertNotCancelled(input.signal)
    const executableGateCount = resolved.task.verification.filter(
      (specification) => specification.type !== "instruction",
    ).length
    event(input, resolved, operationId, "verify.gates.started", {
      gateCount: executableGateCount,
      executorInvoked: false,
      markerUpdated: false,
    })
    const registry = input.gateRegistryFactory?.({
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      runId: resolved.run.id,
      documentId: resolved.document.id,
      taskId: resolved.task.id,
      attemptId: resolved.attempt.id,
    })
    const verificationResults = await runVerifications(resolved.task.verification, {
      workspaceRoot: input.workspaceRoot,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      environmentRoot: resolve(isolatedRunLayout.root, "environment", operationId),
      skipTests: input.gatePolicy.skipTests,
      skipLint: input.gatePolicy.skipLint,
      skipGateIdsOrCategories: new Set(input.gatePolicy.skipGates),
      noGates: input.gatePolicy.noGates,
      fast: input.gatePolicy.fast,
      force: input.gatePolicy.force,
      failFast: input.gatePolicy.failFast,
      changedPaths: new Set(
        compareWorkspaceBaselines(taskBaseline.baseline as WorkspaceBaseline, preGate).changed,
      ),
      ...(registry ? { registry } : {}),
      persistOutput: async (gateId, stream, value) => {
        const stored = await persistContentAddressedBytes(
          input.workspaceRoot,
          { directory: resolve(isolatedRunLayout.raw, "verify", operationId) },
          Buffer.from(value, "utf8"),
          {
            suffix: `.${hashCanonicalValue("ralph.verify.gate-output.v1", { gateId, stream }).slice(0, 12)}.${stream}.log`,
          },
        )
        return stored.ref
      },
    })
    const artifacts = await collectArtifactEvidence(
      input.workspaceRoot,
      resolved.task.verification,
      {
        objectStore: { directory: isolatedRunLayout.artifacts },
        storageRoot: input.workspaceRoot,
      },
    )
    const finalBaseline = await captureWorkspaceBaseline(input.workspaceRoot, {
      scope: resolved.document.workspace,
      retentionPriorityPaths: priorityPaths,
      objectStore: { directory: isolatedRunLayout.artifacts },
      storageRoot: input.workspaceRoot,
    })
    const gateMutation = compareWorkspaceBaselines(preGate, finalBaseline)
    const controlStateStable = commandControlStateStable(
      controlBefore,
      commandControlState(layout.ledger, resolved),
    )
    if (gateMutation.hasChanges) {
      verificationResults.push({
        gateId: "ralph.verify.workspace-stability",
        category: "security",
        blocking: true,
        status: "failed",
        durationMs: 0,
        outputRefs: [],
        reason: `Verification gates changed the workspace: ${gateMutation.changed.join(", ")}`,
        overridden: false,
      })
    }
    if (!controlStateStable) {
      verificationResults.push({
        gateId: "ralph.verify.control-state-stability",
        category: "security",
        blocking: true,
        status: "failed",
        durationMs: 0,
        outputRefs: [],
        reason: "Verification gates changed the durable task or attempt state",
        overridden: false,
      })
    }
    const cumulativeMutation = compareWorkspaceBaselines(
      taskBaseline.baseline as WorkspaceBaseline,
      finalBaseline,
    )
    const adHocPrdViolations = await adHocPrdProtectionViolations({
      workspaceRoot: input.workspaceRoot,
      sourceKind: resolved.run.source?.kind ?? "prd",
      before: taskBaseline.baseline as WorkspaceBaseline,
      after: finalBaseline,
      changedPaths: cumulativeMutation.changed,
    })
    if (adHocPrdViolations.length > 0) {
      verificationResults.push({
        gateId: "ralph.ad-hoc-prd-protection",
        category: "security",
        blocking: true,
        status: "failed",
        durationMs: 0,
        outputRefs: [],
        reason: `Ad-hoc work changed, created or could not safely classify protected PRD Markdown: ${adHocPrdViolations.join(", ")}`,
        overridden: false,
      })
    }
    const taskDiff = await persistDiff({
      workspaceRoot: input.workspaceRoot,
      directory: resolve(isolatedRunLayout.evidence, "diffs"),
      runId: resolved.run.id,
      attemptId: resolved.attempt.id,
      operationId,
      kind: "task",
      before: taskBaseline.baseline as WorkspaceBaseline,
      after: finalBaseline,
    })
    const commandDiff = await persistDiff({
      workspaceRoot: input.workspaceRoot,
      directory: resolve(isolatedRunLayout.evidence, "diffs"),
      runId: resolved.run.id,
      attemptId: resolved.attempt.id,
      operationId,
      kind: "attempt",
      before: preGate,
      after: finalBaseline,
    })
    const changes = changeEvidenceFromWorkspace(
      taskDiff.changes,
      finalBaseline,
      resolved.evidence.changes.policy,
      {
        diffHash: taskDiff.diffHash,
        diffRef: taskDiff.diffRef,
        reproducible: taskDiff.reproducible && commandDiff.reproducible,
        missingContent: [...taskDiff.missingContent, ...commandDiff.missingContent],
      },
    )
    const evidence = buildEvidenceBundle({
      id: id("evidence"),
      runId: resolved.run.id,
      documentId: resolved.document.id,
      task: resolved.task,
      taskSnapshot: resolved.evidence.task,
      attemptId: resolved.attempt.id,
      baseline: gitBaselineFromWorkspace(taskBaseline.baseline as WorkspaceBaseline),
      changes: {
        ...changes,
        attemptDiffHash: commandDiff.diffHash,
        attemptDiffRef: commandDiff.diffRef,
      },
      artifacts,
      gates: verificationResults.map(gateResultFromVerification),
      context: resolved.evidence.context,
      limits: resolved.evidence.limits,
      toolCalls: [],
      profile: resolved.evidence.profile,
      usage: {
        source: "derived",
        semantics: "final",
        input: 0,
        inputNonCached: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        total: 0,
        providerRawRefs: [],
        providerCallCount: 0,
      },
      priorAttempts: [
        {
          attemptId: resolved.attempt.id,
          ordinal: resolved.attempt.ordinal,
          status: resolved.attempt.status,
          evidenceBundleId: resolved.evidence.id,
          ...(resolved.attempt.completionDecision
            ? { completionStatus: resolved.attempt.completionDecision.status }
            : {}),
        },
      ],
      security: {
        ...resolved.evidence.security,
        interactive: false,
        diagnostics: [
          ...resolved.evidence.security.diagnostics,
          "Top-level verify invoked no executor, no model tools and no task-state mutation",
        ],
      },
      createdAt: now(),
    })
    const decision = decideDeterministicCompletion({
      task: resolved.task,
      evidence,
      overrideGateIds: new Set(
        verificationResults.filter((gate) => gate.overridden).map((gate) => gate.gateId),
      ),
      decidedAt: now(),
    }).decision
    if (decision.status === "revision_required") {
      throw new RalphError(
        "RALPH_VERIFY_DECISION_INVALID",
        "Deterministic verification produced a revision-only status",
        { exitCode: EXIT_CODES.operationalError },
      )
    }
    const reportStatus = decision.status as VerificationCommandReport["status"]
    const evidenceObject = await persistEvidenceBundleObject(
      input.workspaceRoot,
      isolatedRunLayout,
      evidence,
    )
    const reportBody = {
      schemaVersion: 1 as const,
      id: id("report"),
      operationId,
      command: "verify" as const,
      selection: resolved.selection,
      status: reportStatus,
      evidence,
      evidenceObject,
      decision,
      workspaceStable: !gateMutation.hasChanges,
      controlStateStable,
      gateCount: evidence.gates.length,
      executorInvoked: false as const,
      markerUpdated: false as const,
      startedAt,
      finishedAt: now(),
    }
    const report = VerificationCommandReportSchema.parse({
      ...reportBody,
      contentHash: commandOperationReportHash(reportBody),
    })
    event(input, resolved, operationId, "verify.evidence.persisted", {
      evidenceBundleId: evidence.id,
      contentHash: evidence.contentHash,
      contentRef: evidenceObject.contentRef,
      storageHash: evidenceObject.storageHash,
      sizeBytes: evidenceObject.sizeBytes,
      decision: decision.status,
      workspaceStable: !gateMutation.hasChanges,
      controlStateStable,
    })
    finishCommandOperation(layout.ledger, {
      id: operationId,
      report,
      finishedAt: report.finishedAt,
    })
    return report
  } catch (error) {
    const failure = operationError(error)
    failCommandOperation(layout.ledger, { id: operationId, ...failure, finishedAt: now() })
    throw error
  }
}

export async function executeJudgeCommand(
  input: ExecuteJudgeCommandInput,
): Promise<JudgmentCommandReport> {
  assertNotCancelled(input.signal)
  const now = input.now ?? (() => new Date().toISOString())
  const id = input.id ?? ((kind) => `${kind}-${randomUUID()}`)
  const resolved = await resolveCommandEvidence(input, true)
  const layout = workspaceLayout(input.workspaceRoot)
  const operationId = id("operation")
  const startedAt = now()
  const effectiveOptions = resolveEffectiveRunOptions({
    config: input.effectiveConfig,
    document: resolved.document,
    task: resolved.task,
    cli: { mode: resolved.run.mode, ...(input.optionOverrides ?? {}) },
  }).options
  const policy = evaluationPolicyForTask(effectiveOptions, resolved.task)
  if (policy.mode !== "external" && policy.mode !== "self") {
    throw new RalphError(
      "RALPH_JUDGE_MODE_INVALID",
      `Top-level judge requires self or external evaluation, received ${policy.mode}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
      },
    )
  }
  const kind: JudgeKind = policy.mode
  const profileId =
    kind === "external"
      ? effectiveOptions.judgeProfile?.value
      : effectiveOptions.executorProfile.value
  if (!profileId) {
    throw new RalphError(
      "RALPH_JUDGE_PROFILE_MISSING",
      `${kind} evaluation has no configured profile`,
      {
        exitCode: EXIT_CODES.invalidUsage,
      },
    )
  }
  const configuredProfile = input.effectiveConfig.config.profiles[profileId]
  const expectedRole = kind === "external" ? "judge" : "executor"
  if (!configuredProfile || configuredProfile.role !== expectedRole) {
    throw new RalphError(
      "RALPH_JUDGE_PROFILE_ROLE_INVALID",
      `${kind} judge requires a configured ${expectedRole} profile: ${profileId}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const request = {
    schemaVersion: 1 as const,
    command: "judge" as const,
    selection: resolved.selection,
    kind,
    profileId,
    policy,
    safety: SAFETY_BOUNDARY,
  }
  createCommandOperation(layout.ledger, { id: operationId, request, startedAt })
  try {
    const controlBefore = commandControlState(layout.ledger, resolved)
    const isolatedRunLayout = runLayout(layout, resolved.run.id)
    const before = await captureWorkspaceBaseline(input.workspaceRoot, {
      scope: resolved.document.workspace,
      objectStore: { directory: isolatedRunLayout.artifacts },
      storageRoot: input.workspaceRoot,
    })
    const backend = await input.resolveJudge(profileId, {
      workspaceRoot: input.workspaceRoot,
      runId: resolved.run.id,
      workspaceId: input.workspaceId,
      kind,
      effectiveOptions,
      dryRun: false,
      config: input.effectiveConfig,
    })
    if (!backend) {
      throw new RalphError(
        "RALPH_JUDGE_BACKEND_UNAVAILABLE",
        `Judge backend is unavailable: ${profileId}`,
        {
          exitCode: EXIT_CODES.providerUnavailable,
        },
      )
    }
    const capabilities = backend.capabilities()
    if (capabilities.toolCalling !== "unavailable" || capabilities.mutationMode !== "read-only") {
      throw new RalphError(
        "RALPH_JUDGE_CAPABILITY_UNSAFE",
        "Top-level judge requires a read-only backend with tool calling unavailable",
        { exitCode: EXIT_CODES.policyDenied },
      )
    }
    const materialized = await materializeJudgeTextAttachments({
      workspaceRoot: input.workspaceRoot,
      evidence: resolved.evidence,
    })
    event(
      input,
      resolved,
      operationId,
      "judge.attachments.materialized",
      {
        evidenceBundleId: resolved.evidence.id,
        ...judgeAttachmentMaterializationEventPayload(materialized),
      },
      materialized.diagnostics.length > 0 ? "warn" : "info",
    )
    const integrityDiagnostics = materialized.diagnostics.filter(
      isJudgeAttachmentIntegrityDiagnostic,
    )
    if (integrityDiagnostics.length > 0) {
      const summary = integrityDiagnostics
        .slice(0, 8)
        .map((diagnostic) => `${diagnostic.attachmentId}:${diagnostic.code}`)
        .join(", ")
      throw new RalphError(
        "RALPH_JUDGE_EVIDENCE_INTEGRITY",
        `Judge attachment integrity validation failed (${summary})`,
        { exitCode: EXIT_CODES.verificationFailed },
      )
    }
    const build = buildJudgeEvaluationBundle({
      task: resolved.evidence.task,
      evidence: resolved.evidence,
      rubric: policy.rubric,
      attachments: materialized.attachments,
      attachmentDiagnostics: materialized.diagnostics,
    })
    const providerOverride =
      kind === "external"
        ? effectiveOptions.judgeProvider?.value
        : effectiveOptions.executorProvider?.value
    const modelOverride =
      kind === "external"
        ? effectiveOptions.judgeModel?.value
        : effectiveOptions.executorModel?.value
    const variantOverride =
      kind === "external"
        ? effectiveOptions.judgeVariant?.value
        : effectiveOptions.executorVariant?.value
    const variant = variantOverride === undefined ? configuredProfile.variant : variantOverride
    const profileBody = {
      id: profileId,
      role: expectedRole,
      backend: configuredProfile.backend,
      provider: providerOverride ?? configuredProfile.provider,
      model: modelOverride ?? configuredProfile.model,
      ...(variant ? { variant } : {}),
    }
    const profileSnapshot = EvaluationProfileSnapshotSchema.parse({
      ...profileBody,
      contentHash: hashCanonicalValue("ralph.evaluation.profile-snapshot.v1", profileBody),
    })
    const evaluator = createJudgeEvaluator({
      backend,
      profileSnapshot,
      now,
      idFactory: () => id("assessment"),
    })
    let assessment: Awaited<ReturnType<typeof evaluator.evaluate>> | undefined
    let lastError: unknown
    for (let ordinal = 0; ordinal <= policy.judgeCallRetries; ordinal += 1) {
      assertNotCancelled(input.signal)
      const callId = id("judge-call")
      const sink: JudgeEventSink = {
        emit(backendEvent) {
          event(
            input,
            resolved,
            operationId,
            `judge.backend.${backendEvent.type}`,
            normalizeJudgeBackendEventPayload(backendEvent.payload, kind, callId),
            backendEvent.level === "warning" ? "warn" : backendEvent.level,
            callId,
          )
        },
      }
      event(
        input,
        resolved,
        operationId,
        "judge.call.started",
        {
          callId,
          ordinal,
          backendId: backend.id,
          evidenceBundleId: resolved.evidence.id,
          toolsAvailable: false,
        },
        "info",
        callId,
      )
      try {
        assessment = await evaluator.evaluate(
          {
            callId,
            kind,
            build,
            ...(ordinal > 0
              ? {
                  repairInstruction: `Previous response was rejected: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
                }
              : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          },
          sink,
        )
        event(
          input,
          resolved,
          operationId,
          "judge.call.finished",
          { callId, ordinal, status: "succeeded" },
          "info",
          callId,
        )
        break
      } catch (error) {
        lastError = error
        event(
          input,
          resolved,
          operationId,
          "judge.call.finished",
          {
            callId,
            ordinal,
            status: input.signal?.aborted ? "cancelled" : "failed",
            message: error instanceof Error ? error.message : String(error),
          },
          "warn",
          callId,
        )
        if (input.signal?.aborted) throw cancellationError(input.signal)
        if (error instanceof RalphError && error.exitCode !== EXIT_CODES.providerUnavailable) {
          throw error
        }
      }
    }
    if (!assessment) {
      throw new RalphError(
        "RALPH_JUDGE_EVALUATION_FAILED",
        `Judge did not return a valid assessment after ${policy.judgeCallRetries + 1} call(s)`,
        { exitCode: EXIT_CODES.providerUnavailable, cause: lastError },
      )
    }
    const safeAssessment = redactValue(
      assessment,
      secretValuesFromEnvironment(input.environment ?? {}),
    ) as typeof assessment
    const storedAssessment = await persistContentAddressedBytes(
      input.workspaceRoot,
      { directory: resolve(isolatedRunLayout.reports, "judge-commands") },
      Buffer.from(`${JSON.stringify(safeAssessment, null, 2)}\n`, "utf8"),
      { suffix: ".judge.json" },
    )
    const deterministic = decideDeterministicCompletion({
      task: resolved.task,
      evidence: resolved.evidence,
      // Evidence intentionally stores the durable gate semantics rather than
      // the transient VerificationResult helper flag. A CLI-skipped blocking
      // gate that was not independently skippable can only have been emitted
      // by the command-owned --force path, so reconstruct that audited set.
      overrideGateIds: forcedOverrideGateIds(resolved.evidence),
      decidedAt: now(),
    }).decision
    let decision = decideAssessedCompletion({
      deterministicDecision: deterministic,
      assessment: safeAssessment,
      policy,
      decidedAt: now(),
    })
    const after = await captureWorkspaceBaseline(input.workspaceRoot, {
      scope: resolved.document.workspace,
      objectStore: { directory: isolatedRunLayout.artifacts },
      storageRoot: input.workspaceRoot,
    })
    const mutation = compareWorkspaceBaselines(before, after)
    const controlStateStable = commandControlStateStable(
      controlBefore,
      commandControlState(layout.ledger, resolved),
    )
    if (mutation.hasChanges || !controlStateStable) {
      const mutationReasons = [
        ...(mutation.hasChanges ? [`workspace files changed: ${mutation.changed.join(", ")}`] : []),
        ...(!controlStateStable ? ["durable task or attempt state changed"] : []),
      ]
      decision = {
        status: "failed",
        deterministicPassed: false,
        evaluationMode: kind,
        score: safeAssessment.score,
        threshold: policy.threshold,
        severityRulesPassed: false,
        evidenceBundleId: resolved.evidence.id,
        assessmentId: safeAssessment.id,
        reasons: [`Judge backend violated its read-only contract: ${mutationReasons.join("; ")}`],
        decidedBy: "ralph-policy",
        decidedAt: now(),
      }
    }
    const reportBody = {
      schemaVersion: 1 as const,
      id: id("report"),
      operationId,
      command: "judge" as const,
      selection: resolved.selection,
      status: decision.status,
      kind,
      profileId,
      policy,
      assessment: safeAssessment,
      assessmentRef: storedAssessment.ref,
      assessmentStorageHash: storedAssessment.contentHash,
      assessmentSizeBytes: storedAssessment.sizeBytes,
      decision,
      workspaceStable: !mutation.hasChanges,
      controlStateStable,
      toolsAvailable: false as const,
      codeMutationApplied: false as const,
      markerUpdated: false as const,
      startedAt,
      finishedAt: now(),
    }
    const report = JudgmentCommandReportSchema.parse({
      ...reportBody,
      contentHash: commandOperationReportHash(reportBody),
    })
    event(
      input,
      resolved,
      operationId,
      "judge.assessment.persisted",
      {
        assessmentId: safeAssessment.id,
        ...(safeAssessment.rawResponseRef
          ? { assessment: { rawResponseRef: safeAssessment.rawResponseRef } }
          : {}),
        assessmentRef: storedAssessment.ref,
        assessmentStorageHash: storedAssessment.contentHash,
        assessmentSizeBytes: storedAssessment.sizeBytes,
        evidenceBundleId: resolved.evidence.id,
        score: safeAssessment.score,
        threshold: policy.threshold,
        decision: decision.status,
        workspaceStable: !mutation.hasChanges,
        controlStateStable,
      },
      mutation.hasChanges || !controlStateStable ? "error" : "info",
    )
    finishCommandOperation(layout.ledger, {
      id: operationId,
      report,
      finishedAt: report.finishedAt,
    })
    return report
  } catch (error) {
    const failure = operationError(error)
    failCommandOperation(layout.ledger, { id: operationId, ...failure, finishedAt: now() })
    throw error
  }
}
