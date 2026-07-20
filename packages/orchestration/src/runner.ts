import { createHash, randomUUID } from "node:crypto"
import type { Dirent } from "node:fs"
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  type AttemptCounters,
  AttemptCountersSchema,
  aggregateChildUsageSummaries,
  ChangeEvidenceSchema,
  type ChildRunLinkRecord,
  type ChildRunObservability,
  ChildRunObservabilitySchema,
  type ChildRunStatus,
  type ChildUsageSummary,
  ChildUsageSummarySchema,
  type CompletionOverrideAudit,
  CompletionOverrideAuditSchema,
  completeTask,
  completeTaskWithOverride,
  DEFAULT_CONFIG,
  type DependencyOutput,
  type EffectiveRunOptions,
  EffectiveRunOptionsSchema,
  type EvaluationProfileSnapshot,
  EvaluationProfileSnapshotSchema,
  type EvidenceLimits,
  type EvidencePersistenceReceipt,
  EvidencePersistenceReceiptSchema,
  type EvidenceProfileSnapshot,
  type EvidenceToolCall,
  type EvidenceTruncation,
  type EvidenceUsage,
  EXIT_CODES,
  type ExecutionReport,
  ExecutionReportSchema,
  type ExecutorOutcome,
  type ExitCode,
  type GitIntegrationRecord,
  type GitWorktreeRecord,
  type JudgeAssessment,
  type MissingEvidence,
  RalphError,
  RecoveryDecisionObsoleteEventPayloadSchema,
  RecoveryDecisionRequiredEventPayloadSchema,
  RecoveryWorkspaceAcceptanceEventPayloadSchema,
  type ResourceClaimSpec,
  type ResumeDiscovery,
  ResumeDiscoverySchema,
  type RunMode,
  type RunStatus,
  type RunWorkSource,
  RunWorkSourceSchema,
  resolveWatchdogPhaseProfile,
  type SandboxCapability,
  type SandboxSessionRecord,
  type WatchdogOperationalBudget,
  watchdogProfileFromConfig,
} from "@ralph-next/domain"
import {
  buildJudgeEvaluationBundle,
  createJudgeEvaluator,
  evaluationKind,
  type JudgeBackend,
  type JudgeBackendResolver,
  type JudgeEventSink,
  type JudgeKind,
} from "@ralph-next/evaluation"
import {
  appendEvent,
  commitCompletion,
  commitRecordOnlyCompletion,
  createAttempt,
  createJudgeCall,
  createModelCall,
  createRun,
  ensureRunLayout,
  findResumableRun,
  finishJudgeCall,
  flushOutbox,
  getAttempt,
  getChildRunLink,
  getChildRunLinkForParent,
  getEvidenceBundle,
  getModelCall,
  getRun,
  getRunReport,
  getRunTask,
  inspectWorkspace,
  type LeaseOwnerIdentity,
  listAttempts,
  listChildRunTree,
  listGitIntegrationRecords,
  listGitWorktreeRecords,
  listJudgeAssessments,
  listJudgeCalls,
  listModelCalls,
  listPreparedCompletions,
  listResourceClaimSets,
  listRuns,
  listRunTasks,
  listSandboxSessionRecordPage,
  listToolCalls,
  listUnsettledToolCalls,
  markCompletionMarkerWritten,
  materializeRunTasks,
  persistAttemptWatchdogEvaluation,
  persistEvidenceBundle,
  persistEvidenceBundleObject,
  persistGateResult,
  persistJudgeAssessment,
  persistRunReport,
  persistSecurityPolicyAudit,
  prepareCompletion,
  type RunLayout,
  type RunRecord,
  type RunTaskRecord,
  readChildRunTreeAggregate,
  readEventHighWater,
  readEvents,
  readRunEventBatch,
  registerLedgerEventRetention,
  registerLedgerRedactionSecrets,
  SANDBOX_SESSION_PAGE_MAX_SIZE,
  type SandboxSessionCursor,
  transitionGitIntegrationRecord,
  transitionGitWorktreeRecord,
  transitionSandboxSessionRecord,
  updateAttempt,
  updateModelCall,
  updateRun,
  upsertRunTask,
  workspaceLayout,
  writeJsonAtomic,
} from "@ralph-next/persistence"
import {
  type CompiledPrdGraph,
  CompiledPrdGraphSchema,
  compilePrdGraph,
  detectPrdFile,
  hashCanonicalValue,
  type PrdDocument,
  type PrdTask,
  parseMarkdownFragment,
  type TaskRef,
  updateTaskMarker,
} from "@ralph-next/prd"
import {
  ProviderEventSchema,
  ProviderToolCallSchema,
  ProviderToolDefinitionSchema,
  RoleProfileLimitsSchema,
  type TokenUsage,
  TokenUsageSchema,
} from "@ralph-next/providers"
import {
  BunProcessSupervisor,
  type ProcessSupervisor,
  WatchdogMonitor,
  type WatchdogProbeResult,
} from "@ralph-next/supervisor"
import { redactValue, secretValuesFromEnvironment } from "@ralph-next/telemetry"
import {
  buildEvidenceBundle,
  captureWorkspaceBaseline,
  changeEvidenceFromWorkspace,
  collectArtifactEvidence,
  compareWorkspaceBaselines,
  decideAssessedCompletion,
  decideDeterministicCompletion,
  decideUnavailableEvaluation,
  type GateExecutorRegistry,
  gateResultFromVerification,
  gitBaselineFromWorkspace,
  isBlockingVerificationFailure,
  persistContentAddressedBytes,
  readVerifiedContentReference,
  runVerifications,
  verifyWorkspaceBaselineContent,
  type WorkspaceBaseline,
} from "@ralph-next/verification"
import type {
  BackendCapabilities,
  CallHandle,
  ExecutionBackend,
  ExecutionBackendLimits,
  ExecutionBackendResolver,
  ExecutionChannel,
  ExecutionToolPort,
  ModelEventSink,
} from "./backend"
import { ensureTaskBaseline } from "./baseline"
import { createWorkspaceCheckpoint, type GitCheckpointInventory } from "./checkpoints"
import {
  assertChildPassedBeforeParentVerification,
  type ChildRunExecutionPort,
  requestGracefulChildTreeStop,
  reservePreauthoredChildRun,
  superviseChildRun,
  validateChildRuntimeGraph,
} from "./child-scheduler"
import { artifactResourceClaim, bindCanonicalPathClaim, taskResourceClaim } from "./claim-scopes"
import { createGitCommandPort, createSandboxProcessPort } from "./command-runtime-ports"
import {
  buildContextManifest,
  type ContextManifestBundle,
  contextManifestBundleHash,
} from "./context"
import {
  assertExecutionDeadline,
  assertExecutionNotCancelled,
  awaitBackendOutcome,
  awaitBackendStart,
  awaitExecutionDeadline,
  executionCancelledError,
  executionDeadlineExceededError,
  isExecutionCancelled,
  isExecutionDeadlineExceeded,
} from "./deadline"
import { evaluationPolicyForTask } from "./evaluation"
import {
  assertGitAutomationPolicy,
  assertGitBaselinePolicy,
  finalizeTaskWorktree,
  type GitCommandPort,
  type GitIntegrationGatePort,
  inspectGitBaseline,
  integrateTaskWorktree,
  normalizeGitIntegrationStrategy,
  type PullRequestPort,
  prepareTaskWorktree,
  removeManagedTaskWorktree,
  renderTaskCommitMessage,
  resolveManagedWorktreePath,
} from "./git-runtime"
import {
  isJudgeAttachmentIntegrityDiagnostic,
  judgeAttachmentMaterializationEventPayload,
  materializeJudgeTextAttachments,
} from "./judge-attachments"
import { normalizeJudgeBackendEventPayload } from "./judge-backend-events"
import {
  effectiveOptionsAreResumeCompatible,
  effectiveOptionsHash,
  type ResolvedRunOptions,
  type RunOptionResolutionContext,
  resolveEffectiveRunOptions,
  telemetryPolicyForEffectiveOptions,
} from "./options"
import { createDurableParallelCapacityPort } from "./parallel-capacity"
import { createDurableParallelClaimPort, recoverExpiredParallelClaims } from "./parallel-claims"
import { executeParallelWaves, type ParallelWorkerResult } from "./parallel-runner"
import type {
  ClaimedParallelDispatch,
  ParallelTaskCandidate,
  ParallelTaskStatus,
} from "./parallel-scheduler"
import { buildExecutionPlan, type ExecutionPlan } from "./plan"
import { probeProcessIdentity } from "./process-identity"
import {
  findPendingRecoveryDecision,
  type PendingRecoveryDecision,
  recoveryDecisionMatchesObservation,
} from "./recovery-acceptance"
import { buildAndPersistRecoveryManifest } from "./recovery-manifest"
import { effectiveJudgeRevisionMaximum } from "./revision-recovery"
import { acquireExecutionLock, type DurableExecutionLock } from "./run-lock"
import type {
  RunSupervisorControlPort,
  RunSupervisorControlSession,
  SupervisorContextRotation,
  SupervisorContextRotationBoundary,
} from "./run-supervisor-control"
import { discoverSandboxCapabilities, sandboxCapabilityProblem } from "./sandbox-runtime"
import { CommandOwnedSandboxSupervisor } from "./sandbox-supervisor"
import { initialTaskRecords, selectTask, taskRefKey } from "./scheduler"
import { materializeSecurityPolicy, securityDiagnostics } from "./security-runtime"
import {
  domainTaskRecord,
  transitionStoredAttemptPhase,
  transitionStoredAttemptStatus,
  transitionStoredRun,
  transitionStoredTask,
} from "./state-store"
import {
  AttemptWatchdogRuntime,
  WatchdogRuntimeActionError,
  WatchdogRuntimeMonitorError,
  WatchdogRuntimePersistenceError,
} from "./watchdog-runtime"

export type VerificationRegistryScope = {
  workspaceRoot: string
  workspaceId: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
}

export type GitProcessSupervisorScope = {
  workspaceRoot: string
  workspaceId: string
  runId: string
  attemptId?: string
}

export type ChildTaskBudgetState = {
  readonly limit: number
  readonly consumed: number
  readonly lastExecution?: {
    readonly runId: string
    readonly documentId: string
    readonly taskId: string
    readonly resolution: ResolvedRunOptions
    readonly judgeAvailable?: boolean
  }
}

export type ChildTaskBudgetAuthority = {
  snapshot(): ChildTaskBudgetState
  reserve(input: {
    readonly runId: string
    readonly task: TaskRef
    readonly resolution: ResolvedRunOptions
  }): Promise<{ granted: boolean; state: ChildTaskBudgetState }>
  report(input: {
    readonly runId: string
    readonly task: TaskRef
    readonly judgeAvailable?: boolean
  }): Promise<ChildTaskBudgetState>
  markBoundary(runId: string): Promise<void>
}

export type ChildRunWorkerSession = {
  readonly owner: LeaseOwnerIdentity
  readonly workerId: string
  readonly parentWorkerId: string
  readonly execution: ChildRunExecutionPort
  snapshot(): {
    readonly state: "starting" | "ready" | "busy" | "closing" | "exited" | "failed"
    readonly activeRequestId?: string
    readonly lastControlHeartbeatAt?: string
    readonly lastProgressAt?: string
  }
  ping(timeoutMs: number): Promise<void>
  forceKill(reason: string): Promise<void>
  close(reason: string): Promise<void>
}

export type ChildRunWorkerSessionFactory = (input: {
  readonly workspaceRoot: string
  readonly executionRoot: string
  readonly workspaceId: string
  readonly parentRunId: string
  readonly parentDocumentId: string
  readonly parentTaskId: string
  readonly childRunId: string
  readonly linkId: string
  readonly parentWorkerId?: string
  readonly parentPolicy: "pause-with-parent" | "survive-parent"
  /** Exact maximum depth authorized by the already validated immutable graph. */
  readonly maximumDepth: number
  /** Wall-clock bound derived from the effective child watchdog profile. */
  readonly deadlineAt?: string
  /** Grace for directed cancellation before the worker supervisor force-kills. */
  readonly cancellationGraceMs: number
  readonly optionResolution: RunOptionResolutionContext
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly interactive: boolean
  readonly taskBudget: ChildTaskBudgetAuthority
  readonly signal?: AbortSignal
}) => Promise<ChildRunWorkerSession>

export type ExecutionRuntimeDependencies = {
  resolveBackend: ExecutionBackendResolver
  resolveJudge?: JudgeBackendResolver
  toolPort?: ExecutionToolPort
  /** Optional host supervisor used beneath command-owned sandbox adapters. */
  processSupervisor?: ProcessSupervisor
  /** Per-attempt gate registry; the CLI uses it to cross the typed worker boundary. */
  gateRegistryFactory?: (scope: VerificationRegistryScope) => GateExecutorRegistry
  /** Command-owned Git process boundary for parallel worktree and integration effects. */
  gitProcessSupervisorFactory?: (scope: GitProcessSupervisorScope) => ProcessSupervisor
  /**
   * Starts the command-authorized Ralph child coordinator in a typed worker
   * process. The factory receives no PRD authorship capability: execute and
   * reconcile payloads are supplied later by ChildRunExecutionPort from the
   * already compiled graph and durable link.
   */
  childRunWorkerSessionFactory?: ChildRunWorkerSessionFactory
  /** Explicit external-effect capability for the create-pr integration strategy. */
  pullRequests?: PullRequestPort
  /** Live authenticated control transport composed only by the CLI application. */
  supervisorControl?: RunSupervisorControlPort
  now?: () => string
  id?: (
    kind:
      | "run"
      | "attempt"
      | "model-call"
      | "judge-call"
      | "assessment"
      | "evidence"
      | "completion"
      | "report",
  ) => string
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  fault?: (
    point:
      | "after-task-active"
      | "after-child-reserved"
      | "after-gates-persisted"
      | "after-judge-assessment-persisted"
      | "after-git-integration-persisted"
      | "after-completion-prepared"
      | "after-completion-marker-file-written"
      | "after-completion-marker-written"
      | "after-completion-committed",
  ) => void | Promise<void>
}

export type ExecuteRunInput = {
  workspaceRoot: string
  /** Legacy PRD input retained for programmatic callers; `source` wins when present. */
  prdFile?: string
  source?: { kind: "prd"; prdFile: string } | { kind: "ad-hoc"; description: string }
  effectiveOptions: EffectiveRunOptions
  optionResolution: RunOptionResolutionContext
  environment?: Record<string, string | undefined>
  /** Command-owned confirmation capability; false when no attached TTY is available. */
  interactive?: boolean
  signal?: AbortSignal
  /** Command-owned observer hook fired only after the run is durable and before task execution. */
  onRunReady?: (run: {
    readonly runId: string
    readonly workspaceId: string
    readonly resumed: boolean
  }) => void | Promise<void>
  runId?: string
  /** Discovery policy is separate from the explicit authority to create a new run. */
  resumeDiscovery?: ResumeDiscovery
  newRun?: boolean
  /**
   * One-shot CLI authority to continue the exact pending workspace-change
   * decision. It is resolved and hash-bound by the orchestrator, never passed
   * through as an unscoped model instruction.
   */
  acceptWorkspaceChanges?: boolean
  dependencies: ExecutionRuntimeDependencies
}

export type RunExecutionResult = {
  kind: "dry-run" | "executed"
  runId?: string
  mode: RunMode
  status: RunStatus | "planned"
  exitCode: ExitCode
  reason: string
  plan: ExecutionPlan
  effectiveOptions: EffectiveRunOptions
  optionsHash: string
  notices: readonly string[]
  report?: ExecutionReport
}

type Runtime = {
  workspaceRoot: string
  /** Isolated source checkout used by this task; control state stays under workspaceRoot. */
  executionRoot?: string
  /** Optional command-owned process boundary injected into tool execution. */
  processSupervisor?: ProcessSupervisor
  /** Isolated workers must not align the shared run hash before Git integration. */
  alignGraphHash?: boolean
  workspaceId: string
  layout: ReturnType<typeof workspaceLayout>
  runLayout: RunLayout
  graph: CompiledPrdGraph
  source: RunWorkSource
  protectedPrdPaths: readonly string[]
  run: RunRecord
  options: EffectiveRunOptions
  invocationOptions: EffectiveRunOptions
  optionResolution: RunOptionResolutionContext
  environment: Record<string, string | undefined>
  interactive: boolean
  pendingRecoveryDecision: PendingRecoveryDecision | undefined
  recoveryAcceptance: PendingRecoveryDecision | undefined
  controlSession?: RunSupervisorControlSession
  /** Verified stale-writer takeover for this command ownership epoch, if any. */
  writerTakeover?: DurableExecutionLock["takeover"]
  assertWriterLease(): void
  signal?: AbortSignal
  dependencies: Required<Pick<ExecutionRuntimeDependencies, "now" | "id" | "sleep">> &
    Pick<ExecutionRuntimeDependencies, "resolveBackend" | "resolveJudge"> & {
      toolPort: ExecutionToolPort
      fault: NonNullable<ExecutionRuntimeDependencies["fault"]>
      pullRequests?: PullRequestPort
      gateRegistryFactory?: NonNullable<ExecutionRuntimeDependencies["gateRegistryFactory"]>
      gitProcessSupervisorFactory?: NonNullable<
        ExecutionRuntimeDependencies["gitProcessSupervisorFactory"]
      >
      childRunWorkerSessionFactory?: NonNullable<
        ExecutionRuntimeDependencies["childRunWorkerSessionFactory"]
      >
    }
}

function combineRunSignals(
  commandSignal: AbortSignal | undefined,
  supervisorSignal: AbortSignal | undefined,
): { signal?: AbortSignal; dispose(): void } {
  const signals = [commandSignal, supervisorSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  )
  if (signals.length === 0) return { dispose() {} }
  const singleSignal = signals.at(0)
  if (signals.length === 1 && singleSignal) return { signal: singleSignal, dispose() {} }
  const controller = new AbortController()
  const subscriptions = signals.map((signal) => {
    const forward = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
    }
    signal.addEventListener("abort", forward, { once: true })
    if (signal.aborted) forward()
    return { signal, forward }
  })
  return {
    signal: controller.signal,
    dispose() {
      for (const subscription of subscriptions) {
        subscription.signal.removeEventListener("abort", subscription.forward)
      }
    },
  }
}

function executionWorkspace(runtime: Runtime): string {
  return runtime.executionRoot ?? runtime.workspaceRoot
}

function protectedDefinitionPaths(runtime: Runtime): string[] {
  return [...runtime.protectedPrdPaths]
}

function executionControlContext(runtime: Runtime): {
  workspaceRoot: string
  controlRoot?: string
  processSupervisor?: ProcessSupervisor
} {
  const workspaceRoot = executionWorkspace(runtime)
  return {
    workspaceRoot,
    ...(workspaceRoot !== runtime.workspaceRoot ? { controlRoot: runtime.workspaceRoot } : {}),
    ...(runtime.processSupervisor ? { processSupervisor: runtime.processSupervisor } : {}),
  }
}

function gateRegistryFor(
  runtime: Runtime,
  reference: TaskRef,
  attemptId: string,
): GateExecutorRegistry | undefined {
  return runtime.dependencies.gateRegistryFactory?.({
    workspaceRoot: executionWorkspace(runtime),
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
    attemptId,
  })
}

type TaskExecutionResult = {
  status:
    | "completed"
    | "completed_with_override"
    | "revision_required"
    | "failed"
    | "blocked"
    | "limit"
  exitCode: ExitCode
  reason: string
  assessment?: JudgeAssessment
  assessmentRef?: string
  stopRun?: boolean
  terminalFailure?: boolean
  /** This is a resumable command budget boundary, not a task failure. */
  budgetBoundary?: boolean
  judgeAvailable?: boolean
}

type ResolvedJudgeEvaluation = {
  kind: JudgeKind
  profileId?: string
  backend?: JudgeBackend
  unavailableReason?: string
}

const EMPTY_COUNTERS: AttemptCounters = AttemptCountersSchema.parse({
  modelCalls: 0,
  toolCalls: 0,
  wiggumIterations: 0,
  executorRetries: 0,
  watchdogRestarts: 0,
  judgeTransportRetries: 0,
  revisionAttempts: 0,
  noChangeAttempts: 0,
  gateRuns: 0,
})

const UNAVAILABLE_TOOL_PORT: ExecutionToolPort = {
  async reconcile() {
    return []
  },
  async materialize() {
    return []
  },
  async execute(call) {
    return {
      callId: call.callId,
      outcome: "invalid",
      output: JSON.stringify({ error: "Ralph tool host is unavailable for this composition" }),
      retryable: false,
    }
  },
}

async function reconcileTaskToolCalls(runtime: Runtime, reference: TaskRef): Promise<void> {
  runtime.assertWriterLease()
  const protectedPaths = protectedDefinitionPaths(runtime)
  const emit: ModelEventSink["emit"] = (event): void => {
    const allowed =
      BACKEND_OBSERVATION_TYPES.has(event.type) || event.type.startsWith("tool.reconciliation.")
    if (!allowed) {
      throw new RalphError(
        "RALPH_TOOL_RECONCILIATION_EVENT_FORBIDDEN",
        `Tool reconciliation attempted to emit an unknown event: ${event.type}`,
        { exitCode: EXIT_CODES.policyDenied, details: { eventType: event.type } },
      )
    }
    appendEvent(runtime.layout.ledger, {
      type: event.type,
      scope: "run",
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      level:
        event.level === "warning"
          ? "warn"
          : event.level === "error"
            ? "error"
            : event.level === "debug"
              ? "debug"
              : "info",
      payload: persistenceSafe(runtime, {
        ...(event.payload ?? {}),
        source: "tool-reconciliation",
      }),
    })
  }
  const results = await runtime.dependencies.toolPort.reconcile({
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
    ...executionControlContext(runtime),
    protectedPaths,
    telemetry: telemetryPolicyForEffectiveOptions(runtime.options),
    security: {
      mode: runtime.options.securityMode.value,
      headlessAsk: runtime.options.headlessAsk.value,
      toolRules: runtime.options.toolRules.value,
      allowedCommands: runtime.options.allowedCommands.value,
      readPaths: runtime.options.readPaths.value,
      writePaths: runtime.options.writePaths.value,
      allowShell: runtime.options.allowShell.value,
      interactive: runtime.interactive,
    },
    ...(runtime.signal ? { signal: runtime.signal } : {}),
    environment: runtime.environment,
    emit,
  })
  runtime.assertWriterLease()
  const remaining = listUnsettledToolCalls(runtime.layout.ledger, {
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
  })
  if (remaining.length === 0) return
  const reported = new Map(results.map((result) => [result.intentId, result]))
  throw new RalphError(
    "RALPH_TOOL_RECONCILIATION_REQUIRED",
    `The task still has ${remaining.length} unsettled tool call(s); starting new model work is unsafe`,
    {
      exitCode: EXIT_CODES.interrupted,
      details: {
        intents: remaining.map(({ intent }) => ({
          intentId: intent.id,
          tool: intent.tool,
          risk: intent.risk,
          recoveryStrategy: intent.recoveryStrategy,
          reason:
            reported.get(intent.id)?.reason ??
            "No reconciliation adapter produced a terminal decision",
        })),
      },
      hint: "Inspect the durable intent and workspace/process evidence. External, destructive, unknown, or unbound process effects require an explicit recovery decision.",
    },
  )
}

const BACKEND_OBSERVATION_TYPES = new Set([
  "model.text.delta",
  "model.text.completed",
  "model.reasoning.delta",
  "model.reasoning.completed",
  "model.tool.input.delta",
  "model.tool.call",
  "model.provider.warning",
  "model.provider.error",
  "model.usage.updated",
  "model.backend.call.reserved",
  "model.backend.turn.started",
  "model.backend.turn.finished",
  "external.cli.started",
  "external.cli.output.delta",
  "external.cli.settled",
  "tool.call.requested",
  "tool.call.authorized",
  "tool.call.started",
  "tool.output.delta",
  "tool.call.settled",
  "tool.call.rejected.budget",
  "tool.call.result.forwarded",
])

type AccountedUsage = {
  input: number
  output: number
  reasoning: number
  total: number
  cost?: { amount: number; currency: string }
}

type ModelUsageLimitSource = "task" | "profile" | "task+profile"

type EffectiveCounterLimit = {
  maximum: number
  source: ModelUsageLimitSource
}

type EffectiveCostLimit = EffectiveCounterLimit & {
  currency: string
}

type EffectiveModelUsageLimits = {
  input?: EffectiveCounterLimit
  output?: EffectiveCounterLimit
  reasoning?: EffectiveCounterLimit
  total?: EffectiveCounterLimit
  cost?: EffectiveCostLimit
}

function effectiveCounterLimit(
  taskMaximum: number | undefined,
  profileMaximum: number | undefined,
): EffectiveCounterLimit | undefined {
  if (taskMaximum === undefined && profileMaximum === undefined) return undefined
  if (taskMaximum === undefined) return { maximum: profileMaximum as number, source: "profile" }
  if (profileMaximum === undefined) return { maximum: taskMaximum, source: "task" }
  if (taskMaximum === profileMaximum) return { maximum: taskMaximum, source: "task+profile" }
  return taskMaximum < profileMaximum
    ? { maximum: taskMaximum, source: "task" }
    : { maximum: profileMaximum, source: "profile" }
}

function effectiveModelUsageLimits(
  taskBudget: PrdTask["budget"],
  profileLimits: ExecutionBackendLimits,
): EffectiveModelUsageLimits {
  const input = effectiveCounterLimit(taskBudget?.maxInputTokens, profileLimits.maxInputTokens)
  const output = effectiveCounterLimit(taskBudget?.maxOutputTokens, profileLimits.maxOutputTokens)
  const reasoning = effectiveCounterLimit(
    taskBudget?.maxReasoningTokens,
    profileLimits.maxReasoningTokens,
  )
  const total = effectiveCounterLimit(taskBudget?.maxTotalTokens, profileLimits.maxTotalTokens)
  const taskCost = taskBudget?.maxCost
  const profileCost = profileLimits.maxCost
  if (taskCost && profileCost && taskCost.currency !== profileCost.currency) {
    throw new RalphError(
      "RALPH_MODEL_COST_LIMIT_CURRENCY_MISMATCH",
      "Task and executor profile cost limits use incomparable currencies",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: { taskCurrency: taskCost.currency, profileCurrency: profileCost.currency },
      },
    )
  }
  const costLimit = effectiveCounterLimit(taskCost?.amount, profileCost?.amount)
  const cost = costLimit
    ? {
        ...costLimit,
        currency: (taskCost?.currency ?? profileCost?.currency) as string,
      }
    : undefined
  return {
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(total ? { total } : {}),
    ...(cost ? { cost } : {}),
  }
}

function hasModelUsageLimits(limits: EffectiveModelUsageLimits): boolean {
  return Object.keys(limits).length > 0
}

function missingRequiredUsageFields(
  usage: TokenUsage,
  limits: EffectiveModelUsageLimits,
): string[] {
  return [
    limits.input && usage.input === undefined ? "input" : undefined,
    limits.output && usage.output === undefined ? "output" : undefined,
    limits.reasoning && usage.reasoning === undefined ? "reasoning" : undefined,
    limits.total && usage.total === undefined ? "total" : undefined,
    limits.cost && usage.cost === undefined ? "cost" : undefined,
  ].filter((field): field is string => field !== undefined)
}

function emptyAccountedUsage(): AccountedUsage {
  return { input: 0, output: 0, reasoning: 0, total: 0 }
}

function safeCounterSum(left: number, right: number, label: string): number {
  const value = left + right
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RalphError("RALPH_USAGE_COUNTER_OVERFLOW", `${label} usage counter overflowed`, {
      exitCode: EXIT_CODES.budgetExceeded,
    })
  }
  return value
}

function usageSnapshot(value: TokenUsage): AccountedUsage {
  const input = value.input ?? 0
  const output = value.output ?? 0
  const reasoning = value.reasoning ?? 0
  return {
    input,
    output,
    reasoning,
    total:
      value.total ?? safeCounterSum(input, safeCounterSum(output, reasoning, "total"), "total"),
    ...(value.cost ? { cost: { amount: value.cost.amount, currency: value.cost.currency } } : {}),
  }
}

function addUsage(left: AccountedUsage, right: AccountedUsage): AccountedUsage {
  let cost: AccountedUsage["cost"]
  if (left.cost || right.cost) {
    const currency = left.cost?.currency ?? right.cost?.currency
    if (left.cost && right.cost && left.cost.currency !== right.cost.currency) {
      throw new RalphError(
        "RALPH_USAGE_CURRENCY_MISMATCH",
        "Provider usage changed currency within one attempt",
        { exitCode: EXIT_CODES.operationalError },
      )
    }
    cost = {
      amount: (left.cost?.amount ?? 0) + (right.cost?.amount ?? 0),
      currency: currency as string,
    }
  }
  return {
    input: safeCounterSum(left.input, right.input, "input"),
    output: safeCounterSum(left.output, right.output, "output"),
    reasoning: safeCounterSum(left.reasoning, right.reasoning, "reasoning"),
    total: safeCounterSum(left.total, right.total, "total"),
    ...(cost ? { cost } : {}),
  }
}

type DetailedUsage = {
  input: number
  inputNonCached: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  total: number
  cost?: {
    amount: number
    currency: string
    source: Exclude<TokenUsage["source"], "unavailable">
  }
  priceSnapshotIds: string[]
  providerRawRefs: string[]
  source: TokenUsage["source"]
}

function detailedUsageSnapshot(value: TokenUsage): DetailedUsage {
  const input = value.input ?? 0
  const output = value.output ?? 0
  const reasoning = value.reasoning ?? 0
  return {
    input,
    inputNonCached: value.inputNonCached ?? 0,
    cacheRead: value.cacheRead ?? 0,
    cacheWrite: value.cacheWrite ?? 0,
    output,
    reasoning,
    total:
      value.total ?? safeCounterSum(input, safeCounterSum(output, reasoning, "total"), "total"),
    ...(value.cost
      ? {
          cost: {
            amount: value.cost.amount,
            currency: value.cost.currency,
            source: (value.cost.source ?? value.source) as Exclude<
              TokenUsage["source"],
              "unavailable"
            >,
          },
        }
      : {}),
    priceSnapshotIds: value.cost ? [value.cost.priceSnapshotId] : [],
    providerRawRefs: value.providerRawRef ? [value.providerRawRef] : [],
    source: value.source,
  }
}

function addDetailedUsage(left: DetailedUsage, right: DetailedUsage): DetailedUsage {
  const basic = addUsage(left, right)
  const costSources = [
    ...new Set([left.cost?.source, right.cost?.source].filter(Boolean)),
  ] as Array<Exclude<TokenUsage["source"], "unavailable">>
  const sources = new Set([left.source, right.source])
  const source: TokenUsage["source"] =
    sources.has("unavailable") || sources.size > 1 ? "estimated" : left.source
  return {
    input: basic.input,
    inputNonCached: safeCounterSum(left.inputNonCached, right.inputNonCached, "inputNonCached"),
    cacheRead: safeCounterSum(left.cacheRead, right.cacheRead, "cacheRead"),
    cacheWrite: safeCounterSum(left.cacheWrite, right.cacheWrite, "cacheWrite"),
    output: basic.output,
    reasoning: basic.reasoning,
    total: basic.total,
    ...(basic.cost
      ? {
          cost: {
            ...basic.cost,
            source:
              costSources.length === 1
                ? (costSources[0] as (typeof costSources)[number])
                : "estimated",
          },
        }
      : {}),
    priceSnapshotIds: [...new Set([...left.priceSnapshotIds, ...right.priceSnapshotIds])].sort(),
    providerRawRefs: [...new Set([...left.providerRawRefs, ...right.providerRawRefs])].sort(),
    source,
  }
}

function finalUsageEvidence(
  usageByProviderCall: ReadonlyMap<string, DetailedUsage>,
  providerCallCount = usageByProviderCall.size,
): EvidenceUsage {
  if (usageByProviderCall.size === 0) {
    return {
      source: "unavailable",
      semantics: "final",
      providerRawRefs: [],
      providerCallCount,
    }
  }
  const values = [...usageByProviderCall.values()]
  const sources = new Set(values.map((value) => value.source))
  const priced = values.filter((value) => value.cost !== undefined)
  const currencies = new Set(priced.map((value) => value.cost?.currency))
  const costSources = new Set(priced.flatMap((value) => (value.cost ? [value.cost.source] : [])))
  const comparableCost = priced.length === values.length && currencies.size === 1
  const aggregate: DetailedUsage = {
    input: values.reduce((sum, value) => safeCounterSum(sum, value.input, "input"), 0),
    inputNonCached: values.reduce(
      (sum, value) => safeCounterSum(sum, value.inputNonCached, "inputNonCached"),
      0,
    ),
    cacheRead: values.reduce((sum, value) => safeCounterSum(sum, value.cacheRead, "cacheRead"), 0),
    cacheWrite: values.reduce(
      (sum, value) => safeCounterSum(sum, value.cacheWrite, "cacheWrite"),
      0,
    ),
    output: values.reduce((sum, value) => safeCounterSum(sum, value.output, "output"), 0),
    reasoning: values.reduce((sum, value) => safeCounterSum(sum, value.reasoning, "reasoning"), 0),
    total: values.reduce((sum, value) => safeCounterSum(sum, value.total, "total"), 0),
    ...(comparableCost
      ? {
          cost: {
            amount: priced.reduce((sum, value) => sum + (value.cost?.amount ?? 0), 0),
            currency: priced[0]?.cost?.currency as string,
            source:
              costSources.size === 1
                ? (priced[0]?.cost?.source as Exclude<TokenUsage["source"], "unavailable">)
                : "estimated",
          },
        }
      : {}),
    priceSnapshotIds: comparableCost
      ? [...new Set(values.flatMap((value) => value.priceSnapshotIds))].sort()
      : [],
    providerRawRefs: [...new Set(values.flatMap((value) => value.providerRawRefs))].sort(),
    source:
      sources.size === 1 && !sources.has("unavailable")
        ? (values[0]?.source as TokenUsage["source"])
        : "estimated",
  }
  return {
    source: aggregate.source,
    semantics: "final",
    input: aggregate.input,
    inputNonCached: aggregate.inputNonCached,
    cacheRead: aggregate.cacheRead,
    cacheWrite: aggregate.cacheWrite,
    output: aggregate.output,
    reasoning: aggregate.reasoning,
    total: aggregate.total,
    ...(aggregate.cost
      ? {
          cost: {
            ...aggregate.cost,
            priceSnapshotIds: aggregate.priceSnapshotIds,
          },
        }
      : {}),
    providerRawRefs: aggregate.providerRawRefs,
    providerCallCount,
  }
}

function executorUsageEvidenceWhere(
  runtime: Runtime,
  include: (event: ReturnType<typeof readEvents>[number]) => boolean,
): EvidenceUsage {
  const usageByProviderCall = new Map<string, DetailedUsage>()
  for (const event of readEvents(runtime.layout.ledger)) {
    if (!include(event) || event.type !== "model.usage.updated") continue
    const parsed = TokenUsageSchema.safeParse(event.payload?.usage)
    if (!parsed.success) continue
    const providerCallId =
      typeof event.payload?.providerCallId === "string"
        ? event.payload.providerCallId
        : (event.callId ?? `event:${event.eventId}`)
    const snapshot = detailedUsageSnapshot(parsed.data)
    const previous = usageByProviderCall.get(providerCallId)
    usageByProviderCall.set(
      providerCallId,
      parsed.data.semantics === "delta"
        ? addDetailedUsage(
            previous ?? {
              input: 0,
              inputNonCached: 0,
              cacheRead: 0,
              cacheWrite: 0,
              output: 0,
              reasoning: 0,
              total: 0,
              priceSnapshotIds: [],
              providerRawRefs: [],
              source: parsed.data.source,
            },
            snapshot,
          )
        : parsed.data.semantics === "final" && parsed.data.source === "unavailable" && previous
          ? {
              ...previous,
              providerRawRefs: [
                ...new Set([...previous.providerRawRefs, ...snapshot.providerRawRefs]),
              ].sort(),
              source: "estimated",
            }
          : snapshot,
    )
  }
  return finalUsageEvidence(usageByProviderCall)
}

function attemptUsageEvidence(runtime: Runtime, attemptId: string): EvidenceUsage {
  return executorUsageEvidenceWhere(runtime, (event) => event.attemptId === attemptId)
}

function taskUsageEvidence(runtime: Runtime, reference: TaskRef): EvidenceUsage {
  return executorUsageEvidenceWhere(
    runtime,
    (event) =>
      event.runId === runtime.run.id &&
      event.documentId === reference.documentId &&
      event.taskId === reference.taskId,
  )
}

function unresolvedTaskUsageCalls(
  runtime: Runtime,
  reference: TaskRef,
  limits: EffectiveModelUsageLimits,
): string[] {
  const reserved = new Set<string>()
  const settled = new Set<string>()
  for (const event of readEvents(runtime.layout.ledger)) {
    if (
      event.runId !== runtime.run.id ||
      event.documentId !== reference.documentId ||
      event.taskId !== reference.taskId
    ) {
      continue
    }
    if (event.type === "model.backend.call.reserved") {
      const providerCallId = event.payload?.providerCallId
      if (typeof providerCallId === "string" && providerCallId.length > 0) {
        reserved.add(providerCallId)
      }
      continue
    }
    if (event.type !== "model.usage.updated") continue
    const providerCallId = event.payload?.providerCallId
    const parsed = TokenUsageSchema.safeParse(event.payload?.usage)
    if (
      typeof providerCallId !== "string" ||
      !parsed.success ||
      parsed.data.semantics !== "final" ||
      parsed.data.source === "unavailable" ||
      missingRequiredUsageFields(parsed.data, limits).length > 0
    ) {
      continue
    }
    settled.add(providerCallId)
  }
  return [...reserved].filter((callId) => !settled.has(callId)).sort()
}

function accountedUsageFromEvidence(value: EvidenceUsage): AccountedUsage {
  const input = value.input ?? 0
  const output = value.output ?? 0
  const reasoning = value.reasoning ?? 0
  return {
    input,
    output,
    reasoning,
    total:
      value.total ?? safeCounterSum(input, safeCounterSum(output, reasoning, "total"), "total"),
    ...(value.cost ? { cost: { amount: value.cost.amount, currency: value.cost.currency } } : {}),
  }
}

function judgeUsageEvidence(runtime: Runtime): EvidenceUsage {
  const usageByProviderCall = new Map<string, DetailedUsage>()
  const startedCalls = new Set<string>()
  for (const event of readEvents(runtime.layout.ledger)) {
    if (event.runId !== runtime.run.id) continue
    if (event.type === "judge.call.started" && event.callId) {
      startedCalls.add(event.callId)
      continue
    }
    if (event.type !== "judge.backend.model.usage.updated") continue
    const parsedEvent = ProviderEventSchema.safeParse(event.payload?.backendPayload)
    if (!parsedEvent.success || parsedEvent.data.type !== "model.usage.updated") continue
    const usage = parsedEvent.data.payload.usage
    const providerCallId = parsedEvent.data.callId
    const snapshot = detailedUsageSnapshot(usage)
    usageByProviderCall.set(
      providerCallId,
      usage.semantics === "delta"
        ? addDetailedUsage(
            usageByProviderCall.get(providerCallId) ?? {
              input: 0,
              inputNonCached: 0,
              cacheRead: 0,
              cacheWrite: 0,
              output: 0,
              reasoning: 0,
              total: 0,
              priceSnapshotIds: [],
              providerRawRefs: [],
              source: usage.source,
            },
            snapshot,
          )
        : snapshot,
    )
  }
  return finalUsageEvidence(usageByProviderCall, startedCalls.size)
}

function executorRunUsageEvidence(
  runtime: Runtime,
  attempts: readonly { id: string }[],
): EvidenceUsage {
  const attemptIds = new Set(attempts.map((attempt) => attempt.id))
  const startedCalls = new Set<string>()
  const usageByProviderCall = new Map<string, DetailedUsage>()
  for (const event of readEvents(runtime.layout.ledger)) {
    if (!event.attemptId || !attemptIds.has(event.attemptId)) continue
    if (event.type === "model.call.started" && event.callId) {
      startedCalls.add(event.callId)
      continue
    }
    if (event.type !== "model.usage.updated") continue
    const parsed = TokenUsageSchema.safeParse(event.payload?.usage)
    if (!parsed.success) continue
    const providerCallId =
      typeof event.payload?.providerCallId === "string"
        ? event.payload.providerCallId
        : (event.callId ?? `event:${event.eventId}`)
    const snapshot = detailedUsageSnapshot(parsed.data)
    usageByProviderCall.set(
      providerCallId,
      parsed.data.semantics === "delta"
        ? addDetailedUsage(
            usageByProviderCall.get(providerCallId) ?? {
              input: 0,
              inputNonCached: 0,
              cacheRead: 0,
              cacheWrite: 0,
              output: 0,
              reasoning: 0,
              total: 0,
              priceSnapshotIds: [],
              providerRawRefs: [],
              source: parsed.data.source,
            },
            snapshot,
          )
        : snapshot,
    )
  }
  return finalUsageEvidence(usageByProviderCall, startedCalls.size)
}

function combinedRunUsageEvidence(executor: EvidenceUsage, judge: EvidenceUsage): EvidenceUsage {
  const active = [executor, judge].filter((usage) => usage.providerCallCount > 0)
  const providerCallCount = active.reduce(
    (sum, usage) => safeCounterSum(sum, usage.providerCallCount, "providerCallCount"),
    0,
  )
  const providerRawRefs = [...new Set(active.flatMap((usage) => usage.providerRawRefs))].sort()
  if (active.length === 0 || active.some((usage) => usage.source === "unavailable")) {
    return {
      source: "unavailable",
      semantics: "final",
      providerRawRefs,
      providerCallCount,
    }
  }
  const sum = (
    field:
      | "input"
      | "inputNonCached"
      | "cacheRead"
      | "cacheWrite"
      | "output"
      | "reasoning"
      | "total",
  ) =>
    active.reduce(
      (total, usage) => safeCounterSum(total, usage[field] ?? 0, `combined.${field}`),
      0,
    )
  const priced = active.filter((usage) => usage.cost !== undefined)
  const currencies = new Set(priced.map((usage) => usage.cost?.currency))
  const costSources = new Set(priced.map((usage) => usage.cost?.source ?? usage.source))
  const comparableCost = priced.length === active.length && currencies.size === 1
  return {
    source: "derived",
    semantics: "final",
    input: sum("input"),
    inputNonCached: sum("inputNonCached"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    output: sum("output"),
    reasoning: sum("reasoning"),
    total: sum("total"),
    ...(comparableCost
      ? {
          cost: {
            amount: priced.reduce((total, usage) => total + (usage.cost?.amount ?? 0), 0),
            currency: priced[0]?.cost?.currency as string,
            source:
              costSources.size === 1
                ? ([...costSources][0] as "reported" | "derived" | "estimated")
                : "estimated",
            priceSnapshotIds: [
              ...new Set(priced.flatMap((usage) => usage.cost?.priceSnapshotIds ?? [])),
            ].sort(),
          },
        }
      : {}),
    providerRawRefs,
    providerCallCount,
  }
}

function evidenceLimits(
  runtime: Runtime,
  task: PrdTask,
  modelLimits: EffectiveModelUsageLimits,
  deadlineAt?: string,
): EvidenceLimits {
  return {
    modelCallsPerAttempt: {
      maximum: runtime.options.maxModelCallsPerAttempt.value,
      source: "command",
    },
    ...(task.budget?.maxToolCallsPerModelCall !== undefined
      ? {
          toolCallsPerModelCall: {
            maximum: task.budget.maxToolCallsPerModelCall,
            source: "task" as const,
          },
        }
      : {}),
    ...(modelLimits.input ? { inputTokens: modelLimits.input } : {}),
    ...(modelLimits.output ? { outputTokens: modelLimits.output } : {}),
    ...(modelLimits.reasoning ? { reasoningTokens: modelLimits.reasoning } : {}),
    ...(modelLimits.total ? { totalTokens: modelLimits.total } : {}),
    ...(modelLimits.cost ? { cost: modelLimits.cost } : {}),
    ...(task.budget?.taskTimeout ? { taskTimeout: task.budget.taskTimeout } : {}),
    ...(deadlineAt ? { deadlineAt } : {}),
    maxRevisionAttempts: {
      maximum: runtime.options.maxRevisionAttempts.value,
      source: runtime.options.maxRevisionAttempts.source === "task" ? "task" : "command",
    },
  }
}

function evidenceProfileSnapshot(
  runtime: Runtime,
  backend: ExecutionBackend,
  declaredLimits: ExecutionBackendLimits,
): EvidenceProfileSnapshot {
  const provider = runtime.options.executorProvider?.value
  const model = runtime.options.executorModel?.value
  return {
    role: "executor",
    profileId: runtime.options.executorProfile.value,
    backendId: backend.id,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(runtime.options.executorVariant?.value
      ? { variant: runtime.options.executorVariant.value }
      : {}),
    metadataAvailability:
      provider && model ? "reported" : provider || model ? "partial" : "unavailable",
    capabilities: backend.capabilities(),
    declaredLimits,
  }
}

function toolCallEvidence(runtime: Runtime, attemptId: string): EvidenceToolCall[] {
  return listToolCalls(runtime.layout.ledger, { attemptId }).map(({ intent, settlement }) => ({
    intentId: intent.id,
    intentRef: `tool-intent:${intent.id}`,
    modelCallId: intent.modelCallId,
    providerToolCallId: intent.providerToolCallId,
    tool: intent.tool,
    argumentsHash: intent.argumentsHash,
    risk: intent.risk,
    effectClass: intent.effectClass,
    authorization: intent.authorization,
    recoveryStrategy: intent.recoveryStrategy,
    requestedAt: intent.requestedAt,
    ...(settlement
      ? {
          settlement: {
            id: settlement.id,
            ref: `tool-settlement:${settlement.id}`,
            outcome: settlement.outcome,
            resultHash: settlement.resultHash,
            effectRefs: settlement.effectRefs,
            outputRefs: settlement.outputRefs,
            ...(settlement.errorCode ? { errorCode: settlement.errorCode } : {}),
            settledAt: settlement.settledAt,
          },
        }
      : {}),
  }))
}

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function persistenceSafe<T>(runtime: Runtime, value: T): T {
  return redactValue(value, secretValuesFromEnvironment(runtime.environment)) as T
}

function evaluationProfileSnapshot(
  runtime: Runtime,
  backend: JudgeBackend,
  kind: JudgeKind,
  profileId: string,
): EvaluationProfileSnapshot {
  const configured = runtime.optionResolution.config?.config.profiles[profileId]
  const providerOverride =
    kind === "external"
      ? runtime.options.judgeProvider?.value
      : runtime.options.executorProvider?.value
  const modelOverride =
    kind === "external" ? runtime.options.judgeModel?.value : runtime.options.executorModel?.value
  const variantOverride =
    kind === "external"
      ? runtime.options.judgeVariant?.value
      : runtime.options.executorVariant?.value
  const variant = variantOverride === undefined ? configured?.variant : variantOverride
  const backendKind =
    configured?.backend ??
    (backend.id.startsWith("external-cli:")
      ? "external-cli"
      : backend.id.startsWith("embedded:")
        ? "embedded"
        : "fake")
  const body = {
    id: profileId,
    role: kind === "external" ? ("judge" as const) : ("executor" as const),
    backend: backendKind,
    provider: providerOverride ?? configured?.provider ?? `backend:${backend.id}`,
    model: modelOverride ?? configured?.model ?? backend.id,
    ...(variant ? { variant } : {}),
  }
  return EvaluationProfileSnapshotSchema.parse({
    ...body,
    contentHash: hashCanonicalValue("ralph.evaluation.profile-snapshot.v1", body),
  })
}

function judgeEventSink(
  runtime: Runtime,
  reference: TaskRef,
  attemptId: string,
  callId: string,
  kind: JudgeKind,
  watchdog: AttemptWatchdogRuntime,
): JudgeEventSink {
  return {
    emit(event) {
      try {
        if (!watchdog.signal.aborted) {
          watchdog.recordJudge({ pending: "yes", progress: true })
        }
        appendEvent(runtime.layout.ledger, {
          type: `judge.backend.${event.type}`,
          scope: "run",
          streamId: runtime.run.id,
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          documentId: reference.documentId,
          taskId: reference.taskId,
          attemptId,
          callId,
          level: event.level === "warning" ? "warn" : event.level,
          payload: persistenceSafe(
            runtime,
            normalizeJudgeBackendEventPayload(event.payload, kind, callId),
          ),
        })
      } catch (error) {
        if (error instanceof RalphError) throw error
        throw new RalphError(
          "RALPH_JUDGE_EVENT_PERSISTENCE_FAILED",
          `Judge backend event could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
          { exitCode: EXIT_CODES.operationalError, cause: error },
        )
      }
    },
  }
}

async function persistAssessmentObject(
  runtime: Runtime,
  attemptId: string,
  assessment: JudgeAssessment,
): Promise<string> {
  const safe = persistenceSafe(runtime, assessment)
  const bytes = new TextEncoder().encode(JSON.stringify(safe))
  const frozen = await persistContentAddressedBytes(
    runtime.workspaceRoot,
    { directory: runtime.runLayout.artifacts },
    bytes,
    { suffix: ".judge.json" },
  )
  await writeJsonAtomic(
    join(runtime.runLayout.evidence, attemptId, "judge-assessment.json"),
    safe,
    { overwrite: false },
  )
  return frozen.ref
}

type JudgeEvaluationResult = {
  assessment?: JudgeAssessment
  assessmentRef?: string
  transportRetries: number
  unavailableReason?: string
}

async function evaluateEvidence(
  runtime: Runtime,
  reference: TaskRef,
  attemptId: string,
  backend: JudgeBackend,
  kind: JudgeKind,
  profileId: string,
  evidence: ReturnType<typeof buildEvidenceBundle>,
  context: ContextManifestBundle,
  signal: AbortSignal,
  watchdog: AttemptWatchdogRuntime,
  previousAssessment?: JudgeAssessment,
): Promise<JudgeEvaluationResult> {
  const task = taskFor(runtime.graph, reference)
  const policy = evaluationPolicyForTask(runtime.options, task)
  const materialized = await materializeJudgeTextAttachments({
    workspaceRoot: runtime.workspaceRoot,
    evidence,
  })
  appendEvent(runtime.layout.ledger, {
    type: "judge.attachments.materialized",
    scope: "run",
    streamId: runtime.run.id,
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
    attemptId,
    level: materialized.diagnostics.length > 0 ? "warn" : "info",
    payload: persistenceSafe(runtime, {
      evidenceBundleId: evidence.id,
      ...judgeAttachmentMaterializationEventPayload(materialized),
    }),
  })
  const integrityDiagnostics = materialized.diagnostics.filter(isJudgeAttachmentIntegrityDiagnostic)
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
    task: context.manifest.task,
    evidence,
    rubric: policy.rubric,
    attachments: materialized.attachments,
    attachmentDiagnostics: materialized.diagnostics,
    ...(previousAssessment ? { previousAssessment } : {}),
  })
  const profileSnapshot = evaluationProfileSnapshot(runtime, backend, kind, profileId)
  const evaluator = createJudgeEvaluator({
    backend,
    profileSnapshot,
    now: runtime.dependencies.now,
    idFactory: () => runtime.dependencies.id("assessment"),
  })
  let lastError: unknown
  for (
    let transportOrdinal = 0;
    transportOrdinal <= policy.judgeCallRetries;
    transportOrdinal += 1
  ) {
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Judge evaluation was cancelled")
    }
    const callId = runtime.dependencies.id("judge-call")
    const repairInstruction =
      transportOrdinal > 0
        ? `Previous judge call could not be accepted: ${persistenceSafe(
            runtime,
            lastError instanceof Error ? lastError.message : String(lastError),
          )}`
        : undefined
    const requestHash = hashCanonicalValue("ralph.evaluation.request.v1", {
      evidenceBundleId: evidence.id,
      bundle: build.bundle,
      kind,
      profileSnapshot,
      backendId: backend.id,
      transportOrdinal,
      ...(repairInstruction ? { repairInstruction } : {}),
    })
    createJudgeCall(runtime.layout.ledger, {
      id: callId,
      attemptId,
      ordinal: transportOrdinal + 1,
      transportOrdinal,
      kind,
      profileId,
      backendId: backend.id,
      requestHash,
      startedAt: runtime.dependencies.now(),
    })
    if (transportOrdinal > 0) {
      appendEvent(runtime.layout.ledger, {
        type: "judge.repair.requested",
        scope: "run",
        streamId: runtime.run.id,
        workspaceId: runtime.workspaceId,
        runId: runtime.run.id,
        documentId: reference.documentId,
        taskId: reference.taskId,
        attemptId,
        callId,
        level: "warn",
        payload: persistenceSafe(runtime, {
          transportOrdinal,
          previousError: repairInstruction,
        }),
      })
    }
    let assessment: JudgeAssessment
    try {
      assessment = persistenceSafe(
        runtime,
        await evaluator.evaluate(
          {
            callId,
            kind,
            build,
            ...(repairInstruction ? { repairInstruction } : {}),
            signal,
          },
          judgeEventSink(runtime, reference, attemptId, callId, kind, watchdog),
        ),
      )
    } catch (error) {
      lastError = error
      finishJudgeCall(runtime.layout.ledger, {
        id: callId,
        status: signal.aborted || isExecutionCancelled(error) ? "cancelled" : "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt: runtime.dependencies.now(),
      })
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error("Judge evaluation was cancelled")
      }
      if (isExecutionCancelled(error) || isExecutionDeadlineExceeded(error)) throw error
      if (error instanceof RalphError && error.exitCode !== EXIT_CODES.providerUnavailable) {
        throw error
      }
      continue
    }
    finishJudgeCall(runtime.layout.ledger, {
      id: callId,
      status: "succeeded",
      finishedAt: runtime.dependencies.now(),
    })
    const assessmentRef = await persistAssessmentObject(runtime, attemptId, assessment)
    persistJudgeAssessment(runtime.layout.ledger, {
      attemptId,
      judgeCallId: callId,
      assessment,
      contentRef: assessmentRef,
    })
    if (!watchdog.signal.aborted) {
      watchdog.recordJudge({
        pending: "no",
        streamOpen: "no",
        progress: true,
        settlement: "settled",
      })
    }
    return {
      assessment,
      assessmentRef,
      transportRetries: transportOrdinal,
    }
  }
  return {
    transportRetries: policy.judgeCallRetries,
    unavailableReason: `Judge evaluation failed after ${policy.judgeCallRetries + 1} call(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  }
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function defaultId(
  kind:
    | "run"
    | "attempt"
    | "model-call"
    | "judge-call"
    | "assessment"
    | "evidence"
    | "completion"
    | "report",
): string {
  return `${kind}-${randomUUID()}`
}

function runtimeDependencies(value: ExecutionRuntimeDependencies): Runtime["dependencies"] {
  return {
    resolveBackend: value.resolveBackend,
    ...(value.resolveJudge ? { resolveJudge: value.resolveJudge } : {}),
    ...(value.pullRequests ? { pullRequests: value.pullRequests } : {}),
    ...(value.gateRegistryFactory ? { gateRegistryFactory: value.gateRegistryFactory } : {}),
    ...(value.gitProcessSupervisorFactory
      ? { gitProcessSupervisorFactory: value.gitProcessSupervisorFactory }
      : {}),
    ...(value.childRunWorkerSessionFactory
      ? { childRunWorkerSessionFactory: value.childRunWorkerSessionFactory }
      : {}),
    toolPort: value.toolPort ?? UNAVAILABLE_TOOL_PORT,
    now: value.now ?? (() => new Date().toISOString()),
    id: value.id ?? defaultId,
    sleep:
      value.sleep ??
      ((milliseconds, signal) =>
        new Promise<void>((resolveDelay, rejectDelay) => {
          if (signal?.aborted) {
            rejectDelay(executionCancelledError(signal, "execution-delay"))
            return
          }
          let timer: ReturnType<typeof setTimeout> | undefined
          const cancel = (): void => {
            if (timer) clearTimeout(timer)
            rejectDelay(executionCancelledError(signal as AbortSignal, "execution-delay"))
          }
          timer = setTimeout(() => {
            signal?.removeEventListener("abort", cancel)
            resolveDelay()
          }, milliseconds)
          signal?.addEventListener("abort", cancel, { once: true })
        })),
    fault: value.fault ?? (() => undefined),
  }
}

async function resolveJudgeEvaluation(
  runtime: Runtime,
): Promise<ResolvedJudgeEvaluation | undefined> {
  const kind = evaluationKind(runtime.options.evaluationMode.value)
  if (!kind) return undefined
  const profileId =
    kind === "external"
      ? runtime.options.judgeProfile?.value
      : runtime.options.executorProfile.value
  if (!profileId) {
    return {
      kind,
      unavailableReason: "External evaluation requires an explicitly configured judge profile",
    }
  }
  if (!runtime.dependencies.resolveJudge) {
    return {
      kind,
      profileId,
      unavailableReason: "No judge backend resolver is installed in the CLI composition root",
    }
  }
  try {
    const backend = await runtime.dependencies.resolveJudge(profileId, {
      workspaceRoot: executionWorkspace(runtime),
      runId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      controlRoot: runtime.workspaceRoot,
      kind,
      effectiveOptions: runtime.options,
      dryRun: false,
      ...(runtime.optionResolution.config ? { config: runtime.optionResolution.config } : {}),
    })
    return backend
      ? { kind, profileId, backend }
      : {
          kind,
          profileId,
          unavailableReason: `Judge profile/backend is unavailable: ${profileId}`,
        }
  } catch (error) {
    if (error instanceof RalphError && error.exitCode !== EXIT_CODES.providerUnavailable) {
      throw error
    }
    return {
      kind,
      profileId,
      unavailableReason: `Judge profile/backend is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function taskFor(graph: CompiledPrdGraph, reference: TaskRef): PrdTask {
  const task = graph.documents[reference.documentId]?.tasks.find(
    (candidate) => candidate.id === reference.taskId,
  )
  if (!task) {
    throw new RalphError(
      "RALPH_EXECUTION_GRAPH_TASK_MISSING",
      `Compiled task is missing: ${taskRefKey(reference)}`,
      { exitCode: EXIT_CODES.invalidPrd },
    )
  }
  return task
}

function retentionPriorityPaths(task: PrdTask): string[] {
  return [
    ...new Set(
      task.verification.flatMap((verification) =>
        verification.type === "file" ||
        verification.type === "schema" ||
        verification.type === "artifact"
          ? [verification.path]
          : [],
      ),
    ),
  ].sort()
}

function documentFor(graph: CompiledPrdGraph, documentId: string): PrdDocument {
  const document = graph.documents[documentId]
  if (!document) {
    throw new RalphError(
      "RALPH_EXECUTION_GRAPH_DOCUMENT_MISSING",
      `Compiled PRD document is missing: ${documentId}`,
      { exitCode: EXIT_CODES.invalidPrd },
    )
  }
  return document
}

function recordsMap(
  records: readonly RunTaskRecord[],
): Map<string, ReturnType<typeof domainTaskRecord>> {
  return new Map(records.map((record) => [taskRefKey(record), domainTaskRecord(record)]))
}

type PlannedExecutionTarget = {
  selection: NonNullable<ReturnType<typeof selectTask>> | undefined
  blockedChildDocumentId: string | undefined
}

/**
 * Dry-run follows pre-authored child edges to the deepest task that would
 * actually invoke a backend. Existing child runs contribute their durable
 * task state; an unmaterialized child uses only its compiled completion
 * markers. This is read-only and never authors or reserves a child PRD.
 */
function deepestPlannedExecutionTarget(input: {
  graph: CompiledPrdGraph
  selection: NonNullable<ReturnType<typeof selectTask>>
  ledger: string
  runId?: string
  force: boolean
}): PlannedExecutionTarget {
  let selection = input.selection
  let runId = input.runId
  const visited = new Set<string>()
  while (taskFor(input.graph, selection.task).subPrd) {
    const key = taskRefKey(selection.task)
    if (visited.has(key)) {
      throw new RalphError(
        "RALPH_CHILD_PLAN_CYCLE",
        `Dry-run encountered a repeated child edge at ${key}`,
        { exitCode: EXIT_CODES.invalidPrd },
      )
    }
    visited.add(key)
    const edge = input.graph.childEdges.find(
      (candidate) => taskRefKey(candidate.parentTask) === key,
    )
    if (!edge) {
      throw new RalphError(
        "RALPH_CHILD_PLAN_EDGE_MISSING",
        `Task ${key} declares a sub-PRD without a compiled child edge`,
        { exitCode: EXIT_CODES.invalidPrd },
      )
    }
    const link = runId
      ? getChildRunLinkForParent(
          input.ledger,
          runId,
          selection.task.documentId,
          selection.task.taskId,
        )
      : undefined
    const records = link
      ? listRunTasks(input.ledger, link.childRunId).map(domainTaskRecord)
      : initialTaskRecords(`dry-run:${edge.childDocument}`, input.graph, edge.childDocument)
    const incomplete = records.some(
      (record) => record.status !== "completed" && record.status !== "completed_with_override",
    )
    if (!incomplete) {
      return { selection, blockedChildDocumentId: undefined }
    }
    const childSelection = selectTask({
      graph: input.graph,
      records: new Map(records.map((record) => [taskRefKey(record), record])),
      documentId: edge.childDocument,
      force: input.force,
    })
    if (!childSelection) {
      return { selection: undefined, blockedChildDocumentId: edge.childDocument }
    }
    selection = childSelection
    runId = link?.childRunId
  }
  return { selection, blockedChildDocumentId: undefined }
}

async function compileExecutableGraph(
  workspaceRoot: string,
  prdFile: string,
): Promise<CompiledPrdGraph> {
  const input = resolve(workspaceRoot, prdFile)
  if (!contained(workspaceRoot, input)) {
    throw new RalphError("RALPH_EXECUTION_PRD_OUTSIDE_WORKSPACE", "PRD path escapes workspace", {
      exitCode: EXIT_CODES.invalidUsage,
      file: prdFile,
    })
  }
  const detected = await detectPrdFile(input, portable(relative(workspaceRoot, input)))
  if (detected.format !== "v2") {
    throw new RalphError(
      detected.format === "classic"
        ? "RALPH_EXECUTION_CLASSIC_PRD_REQUIRES_MIGRATION"
        : "RALPH_EXECUTION_PRD_FORMAT_INVALID",
      detected.format === "classic"
        ? "Execution requires PRD v2; migrate the classic PRD to a separate destination first"
        : "Execution requires an unambiguous PRD v2 Markdown document",
      {
        exitCode: EXIT_CODES.invalidPrd,
        file: portable(relative(workspaceRoot, input)),
        ...(detected.format === "classic"
          ? {
              hint: "Run `ralph-next prd migrate <PRD> --output <new-file>` and inspect the result.",
            }
          : {}),
        details: { diagnostics: detected.diagnostics },
      },
    )
  }
  const compiled = await compilePrdGraph(input, {
    workspaceRoot,
    recursive: true,
    strict: true,
  })
  if (!compiled.ok || !compiled.graph) {
    throw new RalphError("RALPH_EXECUTION_PRD_INVALID", "PRD v2 graph is not executable", {
      exitCode: EXIT_CODES.invalidPrd,
      file: portable(relative(workspaceRoot, input)),
      details: { diagnostics: compiled.diagnostics },
    })
  }
  return compiled.graph
}

export type MaterializedExecutionSource = {
  graph: CompiledPrdGraph
  rootFile: string
  source: RunWorkSource
  protectedPrdPaths: readonly string[]
}

const AD_HOC_DISCOVERY_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".ralph",
  ".next",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv",
])
const MAX_AD_HOC_PROTECTED_PRD_PATHS = 4_000
const MAX_AD_HOC_PROTECTED_PATH_BYTES = 512 * 1_024

async function discoverAuthoredPrdPaths(workspaceRoot: string): Promise<string[]> {
  const directories: string[] = [workspaceRoot]
  const markdown: string[] = []
  const protectedPaths = new Set<string>()
  let entriesSeen = 0
  let markdownBytesScheduled = 0
  let protectedPathBytes = 0
  const protect = (relativePath: string): void => {
    if (protectedPaths.has(relativePath)) return
    const nextBytes = protectedPathBytes + Buffer.byteLength(relativePath, "utf8")
    if (
      protectedPaths.size >= MAX_AD_HOC_PROTECTED_PRD_PATHS ||
      nextBytes > MAX_AD_HOC_PROTECTED_PATH_BYTES
    ) {
      throw new RalphError(
        "RALPH_AD_HOC_PRD_DISCOVERY_LIMIT",
        "Ad-hoc PRD protection exceeded its bounded protected-path inventory",
        {
          exitCode: EXIT_CODES.policyDenied,
          hint: "Reduce authored PRD files or execute an explicit PRD task instead.",
        },
      )
    }
    protectedPaths.add(relativePath)
    protectedPathBytes = nextBytes
  }
  while (directories.length > 0) {
    const directory = directories.shift() as string
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new RalphError(
        "RALPH_AD_HOC_PRD_DISCOVERY_FAILED",
        "Ad-hoc execution could not inspect the workspace for protected PRD documents",
        { exitCode: EXIT_CODES.policyDenied, file: directory, cause: error },
      )
    }
    for (const entry of entries) {
      entriesSeen += 1
      if (entriesSeen > 25_000) {
        throw new RalphError(
          "RALPH_AD_HOC_PRD_DISCOVERY_LIMIT",
          "Ad-hoc PRD protection exceeded its bounded workspace discovery limit",
          {
            exitCode: EXIT_CODES.policyDenied,
            hint: "Reduce generated/dependency directories or execute an explicit PRD task instead.",
          },
        )
      }
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        if (/^prd(?:[-_. ].*)?\.md$/i.test(entry.name)) {
          protect(portable(relative(workspaceRoot, absolute)))
        }
        continue
      }
      if (entry.isDirectory()) {
        if (!AD_HOC_DISCOVERY_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
          directories.push(absolute)
        }
        continue
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue
      if (markdown.length >= 4_000) {
        throw new RalphError(
          "RALPH_AD_HOC_PRD_DISCOVERY_LIMIT",
          "Ad-hoc PRD protection exceeded its bounded Markdown discovery limit",
          { exitCode: EXIT_CODES.policyDenied },
        )
      }
      const relativePath = portable(relative(workspaceRoot, absolute))
      const conventionalPrd = /^prd(?:[-_. ].*)?\.md$/i.test(entry.name)
      if (conventionalPrd) protect(relativePath)
      let size = 0
      try {
        size = (await lstat(absolute)).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      if (size > 2 * 1_024 * 1_024 || markdownBytesScheduled + size > 32 * 1_024 * 1_024) {
        // Oversized/unbounded Markdown is protected conservatively rather than
        // being read during command preflight.
        protect(relativePath)
        continue
      }
      markdownBytesScheduled += size
      markdown.push(relativePath)
    }
  }
  for (const relativePath of markdown) {
    try {
      const detected = await detectPrdFile(resolve(workspaceRoot, relativePath), relativePath)
      if (detected.format === "v2" || detected.format === "classic") {
        protect(relativePath)
      }
    } catch {
      // Conventional PRD filenames remain protected even when invalid. Other
      // malformed Markdown does not make ad-hoc execution depend on a PRD.
    }
  }
  return [...protectedPaths].sort()
}

async function adHocPrdMutationPaths(
  runtime: Runtime,
  changedPaths: readonly string[],
): Promise<string[]> {
  if (runtime.source.kind !== "ad-hoc") return []
  const protectedPaths = new Set(runtime.protectedPrdPaths.map(portable))
  const violations = new Set<string>()
  for (const changedPath of changedPaths.map(portable)) {
    if (protectedPaths.has(changedPath)) {
      violations.add(changedPath)
      continue
    }
    if (!changedPath.toLowerCase().endsWith(".md")) continue
    if (/^prd(?:[-_. ].*)?\.md$/i.test(basename(changedPath))) {
      violations.add(changedPath)
      continue
    }
    try {
      const absolute = resolve(executionWorkspace(runtime), changedPath)
      if (!contained(executionWorkspace(runtime), absolute)) {
        violations.add(changedPath)
        continue
      }
      const detected = await detectPrdFile(absolute, changedPath)
      if (detected.format === "v2" || detected.format === "classic") {
        violations.add(changedPath)
      }
    } catch {
      // Deleted files and malformed non-conventional Markdown are covered only
      // when they were part of the protected preflight inventory.
    }
  }
  return [...violations].sort()
}

function requestedExecutionSource(input: ExecuteRunInput): NonNullable<ExecuteRunInput["source"]> {
  if (input.source) {
    if (input.source.kind === "ad-hoc" && input.prdFile !== undefined) {
      throw new RalphError(
        "RALPH_EXECUTION_SOURCE_CONFLICT",
        "Ad-hoc execution cannot also provide a PRD file",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (
      input.source.kind === "prd" &&
      input.prdFile !== undefined &&
      input.prdFile !== input.source.prdFile
    ) {
      throw new RalphError(
        "RALPH_EXECUTION_SOURCE_CONFLICT",
        "The explicit PRD source conflicts with the legacy prdFile input",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    return input.source
  }
  return { kind: "prd", prdFile: input.prdFile ?? "PRD.md" }
}

export function materializeAdHocExecutionSource(
  descriptionInput: string,
): MaterializedExecutionSource {
  const description = descriptionInput.trim()
  const descriptionHash = createHash("sha256").update(description, "utf8").digest("hex")
  const source = RunWorkSourceSchema.parse({
    kind: "ad-hoc",
    description,
    descriptionHash,
  })
  const rootDocumentId = `ad-hoc-${descriptionHash.slice(0, 16)}`
  const taskId = "request"
  const rootFile = `@ad-hoc/${descriptionHash}`
  const result = parseMarkdownFragment(description)
  const boundary = parseMarkdownFragment(
    "Execute only this command-supplied request. Produce a permitted workspace change; when no natural file deliverable exists, materialize a small bounded evidence file. Do not create or update PRD or sub-PRD files.",
  )
  const taskSpecHash = hashCanonicalValue("ralph.execution.ad-hoc-task.v1", {
    description,
    evidenceMode: "change-only",
    boundary: boundary.markdown,
  })
  const reference: TaskRef = {
    documentId: rootDocumentId,
    taskId,
    taskSpecHash,
  }
  const contentHash = hashCanonicalValue("ralph.execution.ad-hoc-document.v1", {
    description,
    taskSpecHash,
  })
  const document: PrdDocument = {
    schemaVersion: 2,
    id: rootDocumentId,
    title: `Ad-hoc request ${descriptionHash.slice(0, 12)}`,
    kind: "root",
    file: rootFile,
    workspace: ".",
    contentHash,
    definitionHash: taskSpecHash,
    defaults: { evidenceMode: "change-only" },
    sharedContext: parseMarkdownFragment(""),
    tasks: [
      {
        id: taskId,
        taskSpecHash,
        title: description.split(/\r?\n/, 1)[0]?.slice(0, 240) || "Ad-hoc request",
        status: "pending",
        result,
        dependencies: [],
        criteria: [],
        verification: [],
        boundaries: [boundary],
        evidenceMode: "change-only",
      },
    ],
    sourceMap: {
      [taskId]: {
        file: rootFile,
        taskStart: { line: 1, column: 1, offset: 0 },
        marker: { line: 1, column: 1, offset: 0, length: 3 },
        taskEnd: { line: 1, column: 1, offset: 0 },
      },
    },
    metadata: { executionSource: "ad-hoc", descriptionHash },
  }
  const definitionHash = hashCanonicalValue("ralph.execution.ad-hoc-definition.v1", {
    rootDocumentId,
    taskSpecHash,
  })
  document.definitionHash = definitionHash
  const graph = CompiledPrdGraphSchema.parse({
    schemaVersion: 1,
    rootDocumentId,
    rootFile,
    documents: { [rootDocumentId]: document },
    canonicalReferences: { [rootDocumentId]: rootFile },
    dependencyEdges: [],
    childEdges: [],
    topologicalOrder: [reference],
    eligibleTasks: [reference],
    parallelGroups: [],
    diagnostics: [],
    definitionHash,
    graphHash: hashCanonicalValue("ralph.execution.ad-hoc-graph.v1", {
      rootDocumentId,
      rootFile,
      definitionHash,
      reference,
    }),
  })
  return { graph, rootFile, source, protectedPrdPaths: [] }
}

async function materializeExecutionSource(
  workspaceRoot: string,
  request: NonNullable<ExecuteRunInput["source"]>,
): Promise<MaterializedExecutionSource> {
  if (request.kind === "ad-hoc") {
    const materialized = materializeAdHocExecutionSource(request.description)
    return {
      ...materialized,
      protectedPrdPaths: await discoverAuthoredPrdPaths(workspaceRoot),
    }
  }
  const graph = await compileExecutableGraph(workspaceRoot, request.prdFile)
  const rootFile = portable(relative(workspaceRoot, resolve(workspaceRoot, graph.rootFile)))
  return {
    graph,
    rootFile,
    source: RunWorkSourceSchema.parse({
      kind: "prd",
      prdId: graph.rootDocumentId,
      prdFile: rootFile,
    }),
    protectedPrdPaths: Object.values(graph.documents).map((document) => document.file),
  }
}

async function persistContextBundle(
  layout: RunLayout,
  attemptId: string,
  bundle: ContextManifestBundle,
  callOrdinal = 1,
): Promise<void> {
  const directory =
    callOrdinal === 1
      ? join(layout.context, attemptId)
      : join(layout.context, attemptId, `call-${String(callOrdinal).padStart(4, "0")}`)
  await mkdir(directory, { recursive: true })
  const actualHash = contextManifestBundleHash(bundle)
  if (actualHash !== bundle.manifest.contentHash) {
    throw new RalphError(
      "RALPH_CONTEXT_PERSISTENCE_HASH_MISMATCH",
      "Context bundle hash does not match its manifest",
      { exitCode: EXIT_CODES.operationalError },
    )
  }
  await writeJsonAtomic(join(directory, "manifest.json"), bundle.manifest, { overwrite: false })
  await writeJsonAtomic(
    join(directory, "bundle.json"),
    {
      schemaVersion: 1,
      manifest: bundle.manifest,
      resources: bundle.resources,
      truncations: bundle.truncations,
      canonicalJson: bundle.canonicalJson,
    },
    { overwrite: false },
  )
}

function contextBudget(
  task: PrdTask,
  options: EffectiveRunOptions,
  mode: RunMode,
  modelLimits: EffectiveModelUsageLimits,
  consumedUsage: AccountedUsage,
  remaining?: { modelCalls?: number; iterations?: number; deadlineAt?: string },
) {
  const taskBudget = task.budget
  return {
    remainingModelCalls: remaining?.modelCalls ?? options.maxModelCallsPerAttempt.value,
    remainingToolCalls: taskBudget?.maxToolCallsPerModelCall ?? 0,
    remainingIterations:
      remaining?.iterations ?? (mode === "wiggum" ? options.maxIterations.value : 1),
    ...(modelLimits.input
      ? { remainingInputTokens: Math.max(0, modelLimits.input.maximum - consumedUsage.input) }
      : {}),
    ...(modelLimits.output
      ? { remainingOutputTokens: Math.max(0, modelLimits.output.maximum - consumedUsage.output) }
      : {}),
    ...(modelLimits.reasoning
      ? {
          remainingReasoningTokens: Math.max(
            0,
            modelLimits.reasoning.maximum - consumedUsage.reasoning,
          ),
        }
      : {}),
    ...(modelLimits.total
      ? { maxTotalTokens: Math.max(0, modelLimits.total.maximum - consumedUsage.total) }
      : {}),
    ...(modelLimits.cost
      ? {
          maxCost: {
            amount: Math.max(0, modelLimits.cost.maximum - (consumedUsage.cost?.amount ?? 0)),
            currency: modelLimits.cost.currency,
          },
        }
      : {}),
    ...(remaining?.deadlineAt ? { deadlineAt: remaining.deadlineAt } : {}),
  }
}

function resolveTaskOptions(
  graph: CompiledPrdGraph,
  optionResolution: RunOptionResolutionContext,
  reference: TaskRef,
): ResolvedRunOptions {
  const document = documentFor(graph, reference.documentId)
  const task = taskFor(graph, reference)
  const resolved = resolveEffectiveRunOptions({
    ...optionResolution,
    document,
    task,
  })
  return {
    ...resolved,
    notices: [...new Set([...resolved.notices, ...optionNotices(resolved.options)])],
  }
}

function effectiveOptionsForTask(runtime: Runtime, reference: TaskRef): ResolvedRunOptions {
  const previousAttempt = listAttempts(runtime.layout.ledger, {
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
  }).at(-1)
  if (previousAttempt) {
    // Revisions, including revisions resumed by a later CLI process, inherit
    // the exact task-level snapshot that governed the preceding attempt. The
    // new invocation's config/CLI context is intentionally not allowed to
    // downgrade an external evaluation (or change any other execution option)
    // after recovery has already persisted the task boundary.
    return {
      options: previousAttempt.effectiveOptions,
      optionsHash: previousAttempt.effectiveOptionsHash,
      notices: optionNotices(previousAttempt.effectiveOptions),
    }
  }
  return resolveTaskOptions(runtime.graph, runtime.optionResolution, reference)
}

function optionNotices(options: EffectiveRunOptions): readonly string[] {
  const origin = (option: { source: string; sourceRef?: string | undefined }) =>
    `${option.source}${option.sourceRef ? ` (${option.sourceRef})` : ""}`
  const hasSkipRequest =
    options.skipTests.value ||
    options.skipLint.value ||
    options.skipGates.value.length > 0 ||
    options.noGates.value ||
    options.fast.value
  return [
    ...(options.noChangePolicy.notice ? [options.noChangePolicy.notice] : []),
    ...(options.skipTests.value
      ? [
          `--skip-tests from ${origin(options.skipTests)} requests only applicable skippable test gates; each result remains skipped_by_cli, never passed.`,
        ]
      : []),
    ...(options.skipLint.value
      ? [
          `--skip-lint from ${origin(options.skipLint)} requests only applicable skippable lint gates; each result remains skipped_by_cli, never passed.`,
        ]
      : []),
    ...(options.skipGates.value.length > 0
      ? [
          `--skip-gates from ${origin(options.skipGates)} requests IDs/categories [${options.skipGates.value.join(", ")}]; applicable results remain skipped_by_cli, never passed.`,
        ]
      : []),
    ...(options.fast.value
      ? [
          `--fast from ${origin(options.fast)} expands to every applicable verification whose policy permits skipping; required gates still run unless explicitly forced, and skips are never passed.`,
        ]
      : []),
    ...(options.noGates.value
      ? [
          `--no-gates from ${origin(options.noGates)} is an audited suppression request; required gates still need an explicit --force override and are never recorded as passed.`,
        ]
      : []),
    ...(options.force.value && hasSkipRequest
      ? [
          `--force from ${origin(options.force)} may override requested required gates; every override is recorded as skipped_by_cli and limits completion to completed_with_override.`,
        ]
      : []),
    ...(options.failFast.value
      ? [
          `--fail-fast from ${origin(options.failFast)} stops the remaining gate pipeline after the first blocking failure; it does not convert unrun gates to passed.`,
        ]
      : []),
    ...(options.evaluationMode.value === "deterministic-only" && options.judgeProfile
      ? ["A judge profile is configured but deterministic-only evaluation will not invoke it."]
      : []),
  ]
}

function executorUnavailable(profile: string): RalphError {
  return new RalphError(
    "RALPH_EXECUTOR_PROFILE_UNAVAILABLE",
    `Executor profile/backend is unavailable: ${profile}`,
    {
      exitCode: EXIT_CODES.providerUnavailable,
      hint:
        profile === "fake"
          ? "The fake backend exists only in the test composition and is never registered by the product binary."
          : "Configure an available executor profile. Provider integration is delivered in S04/S05.",
    },
  )
}

function taskDeadlineAt(
  task: PrdTask,
  existingAttempts: readonly { startedAt: string }[],
  now: string,
): string | undefined {
  const timeout = task.budget?.taskTimeout?.milliseconds
  if (timeout === undefined) return undefined
  const candidates = [now, ...existingAttempts.map((attempt) => attempt.startedAt)]
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
  const startedAt = Math.min(...candidates)
  return new Date(startedAt + timeout).toISOString()
}

async function withinTaskDeadline<T>(
  deadlineAt: string | undefined,
  phase: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  assertExecutionNotCancelled(signal, phase)
  assertExecutionDeadline(deadlineAt, phase)
  return awaitExecutionDeadline({
    operation: Promise.resolve().then(operation),
    ...(deadlineAt ? { deadlineAt } : {}),
    ...(signal ? { signal } : {}),
    phase,
  })
}

function assertVerificationDeadline(
  deadlineAt: string | undefined,
  phase: string,
  results: readonly { deadlineExceeded?: boolean }[],
): void {
  if (deadlineAt && results.some((result) => result.deadlineExceeded)) {
    throw executionDeadlineExceededError(deadlineAt, phase)
  }
  assertExecutionDeadline(deadlineAt, phase)
}

async function dependencyOutputsFor(
  runtime: Runtime,
  reference: TaskRef,
): Promise<DependencyOutput[]> {
  const task = taskFor(runtime.graph, reference)
  return Promise.all(
    task.dependencies.map(async (dependencyTaskId) => {
      const dependency = getRunTask(
        runtime.layout.ledger,
        runtime.run.id,
        reference.documentId,
        dependencyTaskId,
      )
      if (
        !dependency ||
        (dependency.status !== "completed" && dependency.status !== "completed_with_override")
      ) {
        if (runtime.options.force.value) {
          return { taskId: dependencyTaskId, outputRefs: [] }
        }
        throw new RalphError(
          "RALPH_CONTEXT_DEPENDENCY_NOT_COMPLETED",
          `Dependency output is unavailable for ${reference.documentId}/${dependencyTaskId}`,
          { exitCode: EXIT_CODES.conflict },
        )
      }
      const attempt = dependency.completion
        ? listAttempts(runtime.layout.ledger, {
            runId: runtime.run.id,
            documentId: reference.documentId,
            taskId: dependencyTaskId,
          }).findLast(
            (candidate) => candidate.evidenceBundleId === dependency.completion?.evidenceBundleId,
          )
        : undefined
      const bundle = attempt
        ? getEvidenceBundle(runtime.layout.ledger, attempt.id)?.bundle
        : undefined
      const outputRefs: string[] = []
      if (attempt && bundle) {
        if (
          !bundle.changes.reproducible ||
          !bundle.changes.diffRef ||
          !bundle.changes.diffHash ||
          !bundle.changes.attemptDiffRef ||
          !bundle.changes.attemptDiffHash
        ) {
          throw new RalphError(
            "RALPH_CONTEXT_DEPENDENCY_DIFF_UNBOUND",
            `Dependency evidence is not reproducible for ${reference.documentId}/${dependencyTaskId}`,
            { exitCode: EXIT_CODES.conflict },
          )
        }
        await Promise.all([
          readVerifiedContentReference(
            runtime.workspaceRoot,
            bundle.changes.diffRef,
            bundle.changes.diffHash,
          ),
          readVerifiedContentReference(
            runtime.workspaceRoot,
            bundle.changes.attemptDiffRef,
            bundle.changes.attemptDiffHash,
          ),
          ...bundle.artifacts
            .filter((artifact) => artifact.status === "passed")
            .map(async (artifact) => {
              if (!artifact.immutableRef) {
                throw new Error(
                  `Passed artifact has no immutable reference: ${artifact.artifactId}`,
                )
              }
              await readVerifiedContentReference(
                runtime.workspaceRoot,
                artifact.immutableRef,
                artifact.contentHash,
                artifact.sizeBytes,
              )
            }),
        ])
        outputRefs.push(
          bundle.changes.diffRef,
          bundle.changes.attemptDiffRef,
          ...bundle.artifacts
            .filter((artifact) => artifact.status === "passed" && artifact.immutableRef)
            .flatMap((artifact) => (artifact.immutableRef ? [artifact.immutableRef] : [])),
        )
      }
      return {
        taskId: dependencyTaskId,
        outputRefs: [...new Set(outputRefs)].sort(),
      }
    }),
  )
}

function forcedDependencyInvariants(runtime: Runtime, reference: TaskRef): string[] {
  if (!runtime.options.force.value) return []
  const task = taskFor(runtime.graph, reference)
  const incomplete = task.dependencies.filter((dependencyTaskId) => {
    const dependency = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      reference.documentId,
      dependencyTaskId,
    )
    return (
      !dependency ||
      (dependency.status !== "completed" && dependency.status !== "completed_with_override")
    )
  })
  return incomplete.length === 0
    ? []
    : [
        `CLI --force authorized selection with incomplete dependencies (${incomplete.join(", ")}); no dependency output may be assumed.`,
      ]
}

function executableMode(options: EffectiveRunOptions): RunMode {
  return options.mode.value
}

async function persistGateOutput(
  runtime: Runtime,
  attemptId: string,
  gateId: string,
  stream: "stdout" | "stderr",
  value: string,
): Promise<string> {
  const gateDigest = hashCanonicalValue("ralph.gate-output-scope.v1", {
    attemptId,
    gateId,
    stream,
  }).slice(0, 16)
  const persisted = await persistContentAddressedBytes(
    runtime.workspaceRoot,
    { directory: join(runtime.runLayout.raw, attemptId, gateDigest) },
    Buffer.from(value, "utf8"),
    { suffix: `.${stream}.log` },
  )
  return persisted.ref
}

async function persistWiggumAssessment(
  runtime: Runtime,
  reference: TaskRef,
  attemptId: string,
  callOrdinal: number,
  value: Readonly<Record<string, unknown>>,
): Promise<string> {
  const safe = persistenceSafe(runtime, {
    schemaVersion: 1,
    attemptId,
    callOrdinal,
    ...value,
  })
  const persisted = await persistContentAddressedBytes(
    runtime.workspaceRoot,
    { directory: join(runtime.runLayout.evidence, "wiggum", attemptId) },
    Buffer.from(`${JSON.stringify(safe, null, 2)}\n`, "utf8"),
    { suffix: ".assessment.json" },
  )
  appendEvent(runtime.layout.ledger, {
    type: "wiggum.iteration.assessed",
    scope: "run",
    streamId: runtime.run.id,
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
    attemptId,
    level: "info",
    payload: { callOrdinal, assessmentRef: persisted.ref, contentHash: persisted.contentHash },
  })
  return persisted.ref
}

async function persistWorkspaceDiff(
  runtime: Runtime,
  attemptId: string,
  kind: "task" | "attempt" | "gate",
  before: WorkspaceBaseline,
  after: WorkspaceBaseline,
  changes: ReturnType<typeof compareWorkspaceBaselines>,
): Promise<{
  diffHash: string
  diffRef: string
  reproducible: boolean
  missingContent: Array<{ path: string; side: "before" | "after"; reason: string }>
}> {
  if (changes.beforeHash !== before.snapshotHash || changes.afterHash !== after.snapshotHash) {
    throw new RalphError(
      "RALPH_WORKSPACE_DIFF_BASELINE_MISMATCH",
      "Workspace diff hashes do not match the supplied before/after snapshots",
      { exitCode: EXIT_CODES.operationalError },
    )
  }
  const recalculated = compareWorkspaceBaselines(before, after)
  if (JSON.stringify(recalculated) !== JSON.stringify(changes)) {
    throw new RalphError(
      "RALPH_WORKSPACE_DIFF_RECALCULATION_MISMATCH",
      "Workspace diff changed between calculation and persistence",
      { exitCode: EXIT_CODES.operationalError },
    )
  }
  const retainedBefore = changes.changed.filter((path) => before.files[path]?.contentRef)
  const retainedAfter = changes.changed.filter((path) => after.files[path]?.contentRef)
  await Promise.all([
    verifyWorkspaceBaselineContent(runtime.workspaceRoot, before, retainedBefore),
    verifyWorkspaceBaselineContent(runtime.workspaceRoot, after, retainedAfter),
  ])
  const runPrefix = `${portable(relative(runtime.workspaceRoot, runtime.runLayout.root))}/`
  const missingContent: Array<{
    path: string
    side: "before" | "after"
    reason: string
  }> = []
  const omissionReason = (snapshot: WorkspaceBaseline["files"][string]): string => {
    switch (snapshot.retentionStatus) {
      case "inventory-only":
        return "snapshot captured inventory only"
      case "out-of-scope":
        return "path is outside the declared workspace scope"
      case "sensitive":
        return "sensitive path content is intentionally hash-only"
      case "per-file-limit":
        return "content exceeds the per-file retention limit"
      case "total-limit":
        return "content exceeds the snapshot retention budget"
      case "control-plane":
        return "control-plane content is intentionally hash-only"
      case "retained":
        return "retained snapshot is missing its immutable content reference"
    }
  }
  for (const path of changes.changed) {
    for (const [side, snapshot] of [
      ["before", before.files[path]],
      ["after", after.files[path]],
    ] as const) {
      if (snapshot?.contentRef && !snapshot.contentRef.startsWith(runPrefix)) {
        throw new RalphError(
          "RALPH_WORKSPACE_OBJECT_REF_OUTSIDE_RUN",
          `Workspace object reference is not portable under the run: ${snapshot.contentRef}`,
          { exitCode: EXIT_CODES.operationalError },
        )
      }
      if (snapshot && !snapshot.contentRef) {
        missingContent.push({ path, side, reason: omissionReason(snapshot) })
      }
    }
  }
  const reproducible = missingContent.length === 0
  const manifest = {
    schemaVersion: 1 as const,
    mediaType: "application/vnd.ralph.workspace-diff+json" as const,
    kind,
    runId: runtime.run.id,
    attemptId,
    scope: before.scope,
    beforeHash: changes.beforeHash,
    afterHash: changes.afterHash,
    created: changes.created,
    modified: changes.modified,
    deleted: changes.deleted,
    outsideScope: changes.outsideScope,
    reproducible,
    missingContent,
    files: changes.changed.map((file) => ({
      path: file,
      before: before.files[file] ?? null,
      after: after.files[file] ?? null,
    })),
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  const persisted = await persistContentAddressedBytes(
    runtime.workspaceRoot,
    { directory: join(runtime.runLayout.evidence, "diffs") },
    bytes,
    { suffix: ".json" },
  )
  if (!persisted.ref.startsWith(runPrefix)) {
    throw new RalphError(
      "RALPH_WORKSPACE_DIFF_REF_OUTSIDE_RUN",
      `Workspace diff reference is not portable under the run: ${persisted.ref}`,
      { exitCode: EXIT_CODES.operationalError },
    )
  }
  return {
    diffHash: persisted.contentHash,
    diffRef: persisted.ref,
    reproducible,
    missingContent,
  }
}

async function expectedWorkspaceHashFromLatestAttempt(
  runtime: Runtime,
  attempts: ReturnType<typeof listAttempts>,
): Promise<string | undefined> {
  const newestFirst = [...attempts].sort(
    (left, right) => right.ordinal - left.ordinal || right.updatedAt.localeCompare(left.updatedAt),
  )
  for (const candidate of newestFirst) {
    const evidence = getEvidenceBundle(runtime.layout.ledger, candidate.id)
    if (!evidence) continue
    const diffRef = evidence.bundle.changes.diffRef
    const diffHash = evidence.bundle.changes.diffHash
    if (!diffRef && !diffHash) continue
    if (!diffRef || !diffHash) {
      throw new RalphError(
        "RALPH_RECOVERY_DIFF_BINDING_INVALID",
        "Durable task evidence contains an incomplete diff binding",
        {
          exitCode: EXIT_CODES.conflict,
          details: {
            attemptId: candidate.id,
            diffRef: diffRef ?? null,
            diffHash: diffHash ?? null,
          },
        },
      )
    }
    const bytes = await readVerifiedContentReference(runtime.workspaceRoot, diffRef, diffHash)
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(bytes))
    } catch (error) {
      throw new RalphError(
        "RALPH_RECOVERY_DIFF_INVALID",
        "Most recent durable task diff is not valid JSON",
        {
          exitCode: EXIT_CODES.conflict,
          cause: error,
          details: { attemptId: candidate.id, diffRef },
        },
      )
    }
    if (
      !value ||
      typeof value !== "object" ||
      (value as { runId?: unknown }).runId !== runtime.run.id ||
      (value as { attemptId?: unknown }).attemptId !== candidate.id ||
      typeof (value as { afterHash?: unknown }).afterHash !== "string" ||
      !/^[a-f0-9]{64}$/.test((value as { afterHash: string }).afterHash)
    ) {
      throw new RalphError(
        "RALPH_RECOVERY_DIFF_BINDING_INVALID",
        "Most recent durable task diff is not bound to the expected run and attempt",
        { exitCode: EXIT_CODES.conflict, details: { attemptId: candidate.id, diffRef } },
      )
    }
    return (value as { afterHash: string }).afterHash
  }
  return undefined
}

function backendChannel(
  runtime: Runtime,
  reference: TaskRef,
  attemptId: string,
  modelCallId: string,
  protectedPaths: readonly string[],
  maximumModelCalls: number,
  maximumToolCalls: number,
  modelLimits: EffectiveModelUsageLimits,
  previouslyAccountedUsage: AccountedUsage,
  usageCapability: BackendCapabilities["usage"],
  watchdog: AttemptWatchdogRuntime,
  operationSignal: AbortSignal,
  deadlineAt?: string,
): ExecutionChannel & {
  assertUsageSettled(options?: { requireReservation?: boolean }): void
  currentUsage(): AccountedUsage
} {
  let modelCalls = 0
  let toolCalls = 0
  const reservedModelCallIds = new Set<string>()
  const observedFinalUsageCallIds = new Set<string>()
  const settledFinalUsageCallIds = new Set<string>()
  const usageByCall = new Map<string, AccountedUsage>()
  let definitionsPromise:
    | Promise<readonly ReturnType<typeof ProviderToolDefinitionSchema.parse>[]>
    | undefined
  const aggregateUsage = (): AccountedUsage => {
    let aggregate = previouslyAccountedUsage
    for (const usage of usageByCall.values()) aggregate = addUsage(aggregate, usage)
    return aggregate
  }
  const currentUsage = (): AccountedUsage => {
    let aggregate = emptyAccountedUsage()
    for (const usage of usageByCall.values()) aggregate = addUsage(aggregate, usage)
    return aggregate
  }
  const accountUsage = (event: Parameters<ModelEventSink["emit"]>[0]): RalphError | undefined => {
    if (event.type !== "model.usage.updated") return
    const parsed = TokenUsageSchema.safeParse(event.payload?.usage)
    if (!parsed.success) {
      throw new RalphError("RALPH_MODEL_USAGE_INVALID", "Backend emitted invalid model usage", {
        exitCode: EXIT_CODES.operationalError,
        details: { modelCallId },
      })
    }
    const providerCallId =
      typeof event.payload?.providerCallId === "string" ? event.payload.providerCallId : modelCallId
    if (!reservedModelCallIds.has(providerCallId)) {
      throw new RalphError(
        "RALPH_MODEL_USAGE_UNRESERVED",
        "Backend emitted model usage for a provider/process call that was not reserved",
        {
          exitCode: EXIT_CODES.operationalError,
          details: { modelCallId, providerCallId },
        },
      )
    }
    if (observedFinalUsageCallIds.has(providerCallId)) {
      throw new RalphError(
        "RALPH_MODEL_USAGE_AFTER_FINAL",
        "Backend emitted model usage after the provider/process call was finally settled",
        {
          exitCode: EXIT_CODES.operationalError,
          details: { modelCallId, providerCallId },
        },
      )
    }
    let policyError: RalphError | undefined
    if (parsed.data.source === "unavailable" && hasModelUsageLimits(modelLimits)) {
      policyError = new RalphError(
        "RALPH_MODEL_USAGE_LIMIT_UNENFORCEABLE",
        "Backend reported unavailable usage while command-owned model limits are active",
        {
          exitCode: EXIT_CODES.budgetExceeded,
          details: { modelCallId, limits: modelLimits },
        },
      )
    }
    if (parsed.data.semantics === "final" && parsed.data.source !== "unavailable") {
      const missing = missingRequiredUsageFields(parsed.data, modelLimits)
      if (missing.length > 0) {
        policyError = new RalphError(
          "RALPH_MODEL_USAGE_LIMIT_UNENFORCEABLE",
          "Final model usage omitted fields required by command-owned limits",
          {
            exitCode: EXIT_CODES.budgetExceeded,
            details: { modelCallId, missing, limits: modelLimits },
          },
        )
      }
    }
    const snapshot = usageSnapshot(parsed.data)
    const previous = usageByCall.get(providerCallId)
    usageByCall.set(
      providerCallId,
      parsed.data.semantics === "delta"
        ? addUsage(previous ?? emptyAccountedUsage(), snapshot)
        : parsed.data.semantics === "final" && parsed.data.source === "unavailable" && previous
          ? previous
          : snapshot,
    )
    if (parsed.data.semantics === "final") {
      observedFinalUsageCallIds.add(providerCallId)
      if (parsed.data.source !== "unavailable" && !policyError) {
        settledFinalUsageCallIds.add(providerCallId)
      }
    }
    return policyError
  }
  const assertUsageBudget = (): void => {
    const usage = aggregateUsage()
    const exceeded =
      modelLimits.input && usage.input > modelLimits.input.maximum
        ? { kind: "input", ...modelLimits.input, actual: usage.input }
        : modelLimits.output && usage.output > modelLimits.output.maximum
          ? { kind: "output", ...modelLimits.output, actual: usage.output }
          : modelLimits.reasoning && usage.reasoning > modelLimits.reasoning.maximum
            ? {
                kind: "reasoning",
                ...modelLimits.reasoning,
                actual: usage.reasoning,
              }
            : modelLimits.total && usage.total > modelLimits.total.maximum
              ? { kind: "total", ...modelLimits.total, actual: usage.total }
              : undefined
    let costExceeded:
      | {
          kind: "cost"
          maximum: number
          actual: number
          currency: string
          source: ModelUsageLimitSource
        }
      | undefined
    if (modelLimits.cost && usage.cost) {
      if (modelLimits.cost.currency !== usage.cost.currency) {
        throw new RalphError(
          "RALPH_MODEL_COST_CURRENCY_MISMATCH",
          "Reported model usage currency does not match the effective command-owned limit",
          {
            exitCode: EXIT_CODES.operationalError,
            details: {
              source: modelLimits.cost.source,
              expected: modelLimits.cost.currency,
              actual: usage.cost.currency,
              modelCallId,
            },
          },
        )
      }
      if (usage.cost.amount > modelLimits.cost.maximum) {
        costExceeded = {
          kind: "cost",
          source: modelLimits.cost.source,
          maximum: modelLimits.cost.maximum,
          actual: usage.cost.amount,
          currency: usage.cost.currency,
        }
      }
    }
    const violation = exceeded ?? costExceeded
    if (!violation) return
    appendEvent(runtime.layout.ledger, {
      type: "budget.model_usage.exceeded",
      scope: "run",
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      attemptId,
      callId: modelCallId,
      level: "error",
      payload: persistenceSafe(runtime, violation),
    })
    throw new RalphError(
      "RALPH_MODEL_USAGE_BUDGET_EXCEEDED",
      `Model ${violation.kind} usage ${violation.actual} exceeded the ${violation.source} limit ${violation.maximum}`,
      { exitCode: EXIT_CODES.budgetExceeded, details: { modelCallId, ...violation } },
    )
  }
  const assertUsageCapacity = (): void => {
    const usage = aggregateUsage()
    if (modelLimits.cost && usage.cost && usage.cost.currency !== modelLimits.cost.currency) {
      throw new RalphError(
        "RALPH_MODEL_COST_CURRENCY_MISMATCH",
        "Accumulated model usage currency does not match the effective command-owned limit",
        {
          exitCode: EXIT_CODES.operationalError,
          details: {
            source: modelLimits.cost.source,
            expected: modelLimits.cost.currency,
            actual: usage.cost.currency,
            modelCallId,
          },
        },
      )
    }
    const exhausted =
      modelLimits.input && usage.input >= modelLimits.input.maximum
        ? { kind: "input", ...modelLimits.input, actual: usage.input }
        : modelLimits.output && usage.output >= modelLimits.output.maximum
          ? { kind: "output", ...modelLimits.output, actual: usage.output }
          : modelLimits.reasoning && usage.reasoning >= modelLimits.reasoning.maximum
            ? { kind: "reasoning", ...modelLimits.reasoning, actual: usage.reasoning }
            : modelLimits.total && usage.total >= modelLimits.total.maximum
              ? { kind: "total", ...modelLimits.total, actual: usage.total }
              : modelLimits.cost &&
                  usage.cost &&
                  usage.cost.currency === modelLimits.cost.currency &&
                  usage.cost.amount >= modelLimits.cost.maximum
                ? {
                    kind: "cost",
                    ...modelLimits.cost,
                    actual: usage.cost.amount,
                  }
                : undefined
    if (!exhausted) return
    appendEvent(runtime.layout.ledger, {
      type: "budget.model_usage.exhausted",
      scope: "run",
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      attemptId,
      callId: modelCallId,
      level: "error",
      payload: persistenceSafe(runtime, exhausted),
    })
    throw new RalphError(
      "RALPH_MODEL_USAGE_BUDGET_EXHAUSTED",
      `Model ${exhausted.kind} usage exhausted the ${exhausted.source} limit ${exhausted.maximum}`,
      { exitCode: EXIT_CODES.budgetExceeded, details: { modelCallId, ...exhausted } },
    )
  }
  const recordBackendWatchdogEvent = (event: Parameters<ModelEventSink["emit"]>[0]): void => {
    if (watchdog.signal.aborted) return
    if (watchdog.phase === "tool") {
      watchdog.recordTool({ alive: "yes", activity: "yes", progress: true })
      return
    }
    const settled =
      event.type === "model.backend.turn.finished" || event.type === "external.cli.settled"
    const retryAfter = event.payload?.retryAfterMs
    watchdog.recordProvider({
      pending: settled ? "no" : "yes",
      ...(event.type.endsWith(".delta")
        ? { streamOpen: "yes" as const }
        : settled
          ? { streamOpen: "no" as const }
          : {}),
      ...(typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter >= 0
        ? { retryAfterMs: retryAfter }
        : {}),
      progress: true,
      ...(settled ? { settlement: "settled" } : {}),
    })
  }
  const emit: ModelEventSink["emit"] = (event): void => {
    // Provider finish is observational metadata for an inner turn. The
    // authoritative model.call.finished event is emitted only by the ledger
    // transition below, so this similarly named provider event is not stored.
    if (event.type === "model.call.finished") return
    if (!BACKEND_OBSERVATION_TYPES.has(event.type)) {
      throw new RalphError(
        "RALPH_BACKEND_EVENT_TYPE_FORBIDDEN",
        `Execution backend attempted to emit a reserved or unknown event: ${event.type}`,
        { exitCode: EXIT_CODES.policyDenied, details: { modelCallId, eventType: event.type } },
      )
    }
    recordBackendWatchdogEvent(event)
    const usagePolicyError = accountUsage(event)
    appendEvent(runtime.layout.ledger, {
      type: event.type,
      scope: "run",
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      attemptId,
      callId: modelCallId,
      level:
        event.level === "warning"
          ? "warn"
          : event.level === "error"
            ? "error"
            : event.level === "debug"
              ? "debug"
              : "info",
      payload: persistenceSafe(runtime, {
        ...(event.payload ?? {}),
        source: "execution-backend",
      }),
    })
    if (usagePolicyError) throw usagePolicyError
    assertUsageBudget()
  }
  const context = (signal?: AbortSignal) => {
    const effectiveSignal = signal ?? operationSignal
    return {
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      attemptId,
      modelCallId,
      ...executionControlContext(runtime),
      protectedPaths,
      maximumToolCalls,
      telemetry: telemetryPolicyForEffectiveOptions(runtime.options),
      security: {
        mode: runtime.options.securityMode.value,
        headlessAsk: runtime.options.headlessAsk.value,
        toolRules: runtime.options.toolRules.value,
        allowedCommands: runtime.options.allowedCommands.value,
        readPaths: runtime.options.readPaths.value,
        writePaths: runtime.options.writePaths.value,
        allowShell: runtime.options.allowShell.value,
        interactive: runtime.interactive,
      },
      ...(deadlineAt ? { deadlineAt } : {}),
      ...(effectiveSignal ? { signal: effectiveSignal } : {}),
      environment: runtime.environment,
      emit,
    }
  }
  return {
    emit,
    async reserveModelCall(input) {
      if (!input.callId.trim() || !Number.isSafeInteger(input.turn) || input.turn < 1) {
        throw new RalphError(
          "RALPH_MODEL_CALL_RESERVATION_INVALID",
          "Backend supplied an invalid provider/process turn identity",
          { exitCode: EXIT_CODES.operationalError, details: { modelCallId } },
        )
      }
      if (reservedModelCallIds.has(input.callId)) {
        throw new RalphError(
          "RALPH_MODEL_CALL_RESERVATION_DUPLICATE",
          `Backend attempted to reserve provider/process call twice: ${input.callId}`,
          { exitCode: EXIT_CODES.operationalError, details: { modelCallId } },
        )
      }
      assertUsageCapacity()
      if (modelCalls >= maximumModelCalls) {
        appendEvent(runtime.layout.ledger, {
          type: "budget.model_calls.exceeded",
          scope: "run",
          streamId: runtime.run.id,
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          documentId: reference.documentId,
          taskId: reference.taskId,
          attemptId,
          callId: modelCallId,
          level: "error",
          payload: { maximumModelCalls, attemptedCallId: input.callId, turn: input.turn },
        })
        throw new RalphError(
          "RALPH_MODEL_CALL_BUDGET_EXCEEDED",
          `Model call budget was exhausted at ${maximumModelCalls}`,
          {
            exitCode: EXIT_CODES.budgetExceeded,
            details: { modelCallId, maximumModelCalls, attemptedCallId: input.callId },
          },
        )
      }
      reservedModelCallIds.add(input.callId)
      modelCalls += 1
      emit({
        type: "model.backend.call.reserved",
        payload: { providerCallId: input.callId, turn: input.turn, ordinal: modelCalls },
      })
    },
    assertUsageSettled(options) {
      if (reservedModelCallIds.size === 0) {
        if (options?.requireReservation === false) return
        throw new RalphError(
          "RALPH_MODEL_CALL_RESERVATION_MISSING",
          "Backend completed without reserving its real provider/process call",
          {
            exitCode: EXIT_CODES.operationalError,
            details: { modelCallId, usageCapability },
          },
        )
      }
      if (usageCapability === "unavailable") return
      const unsettled = [...reservedModelCallIds].filter(
        (callId) => !settledFinalUsageCallIds.has(callId),
      )
      if (unsettled.length === 0) return
      throw new RalphError(
        "RALPH_MODEL_USAGE_FINAL_MISSING",
        "Backend completed without final usage for every reserved provider/process call",
        {
          exitCode: hasModelUsageLimits(modelLimits)
            ? EXIT_CODES.budgetExceeded
            : EXIT_CODES.operationalError,
          details: {
            modelCallId,
            usageCapability,
            unsettled,
            unavailableFinals: unsettled.filter((callId) => observedFinalUsageCallIds.has(callId)),
            limits: modelLimits,
          },
        },
      )
    },
    currentUsage,
    async tools() {
      if (maximumToolCalls === 0) return []
      if (!definitionsPromise) {
        beginWatchdogPhase(watchdog, "tool", deadlineAt)
        watchdog.recordTool({ alive: "yes", activity: "yes", progress: true })
        definitionsPromise = awaitExecutionDeadline({
          operation: runtime.dependencies.toolPort
            .materialize(context())
            .then((definitions) =>
              definitions.map((item) => ProviderToolDefinitionSchema.parse(item)),
            ),
          ...(deadlineAt ? { deadlineAt } : {}),
          signal: operationSignal,
          phase: "tool-materialization",
        }).finally(() => {
          if (watchdog.signal.aborted) return
          watchdog.recordTool({
            alive: "no",
            activity: "no",
            progress: true,
            settlement: "settled",
          })
          beginWatchdogPhase(watchdog, "model-call", deadlineAt)
        })
      }
      const definitions = await definitionsPromise
      if (definitions.length > 128) {
        throw new RalphError("RALPH_TOOL_DEFINITION_LIMIT", "Tool definition limit was exceeded", {
          exitCode: EXIT_CODES.budgetExceeded,
          details: { maximum: 128, actual: definitions.length },
        })
      }
      if (new Set(definitions.map((item) => item.name)).size !== definitions.length) {
        throw new RalphError("RALPH_TOOL_DEFINITION_DUPLICATE", "Tool definitions are not unique", {
          exitCode: EXIT_CODES.operationalError,
        })
      }
      return definitions.map((item) => structuredClone(item))
    },
    async executeTool(callInput, options) {
      const call = ProviderToolCallSchema.parse(callInput)
      if (toolCalls >= maximumToolCalls) {
        emit({
          type: "tool.call.rejected.budget",
          level: "error",
          payload: { callId: call.callId, name: call.name, maximumToolCalls },
        })
        throw new RalphError(
          "RALPH_TOOL_CALL_BUDGET_EXCEEDED",
          `Tool call budget was exhausted at ${maximumToolCalls}`,
          {
            exitCode: EXIT_CODES.budgetExceeded,
            details: { modelCallId, maximumToolCalls, attemptedToolCallId: call.callId },
          },
        )
      }
      toolCalls += 1
      emit({
        type: "tool.call.requested",
        payload: { callId: call.callId, name: call.name, ordinal: toolCalls },
      })
      beginWatchdogPhase(watchdog, "tool", deadlineAt)
      watchdog.recordTool({ alive: "yes", activity: "yes", progress: true })
      let result: Awaited<ReturnType<ExecutionToolPort["execute"]>>
      try {
        const signal = options?.signal ?? operationSignal
        result = await awaitExecutionDeadline({
          operation: runtime.dependencies.toolPort.execute(call, context(signal)),
          ...(deadlineAt ? { deadlineAt } : {}),
          signal,
          phase: "tool-execution",
        })
      } finally {
        if (!watchdog.signal.aborted) {
          watchdog.recordTool({
            alive: "no",
            activity: "no",
            progress: true,
            settlement: "settled",
          })
          beginWatchdogPhase(watchdog, "model-call", deadlineAt)
        }
      }
      const outcomes = new Set([
        "success",
        "nonzero",
        "denied",
        "invalid",
        "error",
        "timeout",
        "cancelled",
        "unsettled",
      ])
      if (
        result.callId !== call.callId ||
        !outcomes.has(result.outcome) ||
        typeof result.output !== "string" ||
        typeof result.retryable !== "boolean"
      ) {
        throw new RalphError(
          "RALPH_TOOL_SETTLEMENT_INVALID",
          "Tool port returned an invalid or causally mismatched settlement",
          { exitCode: EXIT_CODES.operationalError, details: { callId: call.callId } },
        )
      }
      if (Buffer.byteLength(result.output, "utf8") > 1_048_576) {
        throw new RalphError(
          "RALPH_TOOL_RESULT_OUTPUT_LIMIT",
          "Tool settlement output exceeded the orchestration boundary",
          { exitCode: EXIT_CODES.budgetExceeded, details: { callId: call.callId } },
        )
      }
      emit({
        type: "tool.call.result.forwarded",
        level: result.outcome === "success" ? "info" : "warning",
        payload: {
          callId: call.callId,
          name: call.name,
          outcome: result.outcome,
          retryable: result.retryable,
          ...(result.settlementRef ? { settlementRef: result.settlementRef } : {}),
        },
      })
      return { ...result }
    },
    stats() {
      return { modelCalls, maximumModelCalls, toolCalls, maximumToolCalls }
    },
  }
}

function cancellationLeftModelCallUnsettled(error: unknown): boolean {
  if (!isExecutionDeadlineExceeded(error) && !isExecutionCancelled(error)) return false
  const details = error.diagnostic.details
  return details?.phase === "backend-start" || details?.outcomeSettlement === "timed_out"
}

function observeLateModelCallSettlement(
  runtime: Runtime,
  modelCallId: string,
  handle: CallHandle,
): void {
  const settle = (settlement: "resolved" | "rejected"): void => {
    try {
      const current = getModelCall(runtime.layout.ledger, modelCallId)
      if (current?.status !== "started") return
      updateModelCall(runtime.layout.ledger, {
        modelCallId,
        status: "cancelled",
        finishedAt: runtime.dependencies.now(),
        event: {
          type: "model.call.late_settled",
          payload: { backendCallId: handle.id, settlement, outcomeAccepted: false },
        },
      })
    } catch {
      // The authoritative command has already returned. A concurrent
      // reconciliation may have terminalized the call first; either terminal
      // state is safer than starting another call while it remains `started`.
    }
  }
  void handle.outcome.then(
    () => settle("resolved"),
    () => settle("rejected"),
  )
}

function verifiedWriterTakeoverForRun(
  runtime: Runtime,
): NonNullable<DurableExecutionLock["takeover"]> | undefined {
  const takeover = runtime.writerTakeover
  if (!takeover) return undefined
  const displaced = takeover.displacedLease
  const negativeStatuses = new Set(["dead", "identity-mismatch"])
  const probes = takeover.probes.filter(
    (probe) =>
      probe.leaseId === displaced.id &&
      probe.expectedProcessStartToken === displaced.processStartToken &&
      negativeStatuses.has(probe.status),
  )
  if (
    displaced.status !== "stolen" ||
    displaced.kind !== "workspace-supervisor" ||
    displaced.resourceKey !== "workspace-writer" ||
    displaced.workspaceId !== runtime.workspaceId ||
    displaced.runId !== runtime.run.id ||
    displaced.replacedByLeaseId !== takeover.replacementLeaseId ||
    probes.length < 2 ||
    new Set(probes.map((probe) => probe.sequence)).size < 2
  ) {
    return undefined
  }
  runtime.assertWriterLease()
  return takeover
}

/**
 * A model/judge call may be retried only after the previous command owner is
 * proven dead. Clean lock release, timeout, cancellation, or elapsed time alone
 * intentionally provide no authority and keep the existing fail-closed guard.
 */
function reconcileCallsAbandonedByDeadWriter(runtime: Runtime, reference: TaskRef): void {
  const takeover = verifiedWriterTakeoverForRun(runtime)
  if (!takeover) return
  const attempts = listAttempts(runtime.layout.ledger, {
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
  })
  const finishedAt = runtime.dependencies.now()
  let modelCallsInterrupted = 0
  let judgeCallsCancelled = 0
  for (const attempt of attempts) {
    for (const modelCall of listModelCalls(runtime.layout.ledger, attempt.id)) {
      if (modelCall.status !== "started") continue
      updateModelCall(runtime.layout.ledger, {
        modelCallId: modelCall.id,
        status: "interrupted",
        finishedAt,
        event: {
          type: "model.call.owner_recovered_dead",
          level: "warn",
          payload: {
            displacedLeaseId: takeover.displacedLease.id,
            replacementLeaseId: takeover.replacementLeaseId,
            probeIds: takeover.probes.map((probe) => probe.id),
            outcomeAccepted: false,
          },
        },
      })
      modelCallsInterrupted += 1
    }
    for (const judgeCall of listJudgeCalls(runtime.layout.ledger, attempt.id)) {
      if (judgeCall.status !== "started") continue
      finishJudgeCall(runtime.layout.ledger, {
        id: judgeCall.id,
        status: "cancelled",
        errorMessage: "Verified writer process died before the judge call settled",
        finishedAt,
      })
      judgeCallsCancelled += 1
    }
  }
  if (modelCallsInterrupted > 0 || judgeCallsCancelled > 0) {
    appendEvent(runtime.layout.ledger, {
      type: "run.writer_takeover.calls_reconciled",
      scope: "run",
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      level: "warn",
      payload: persistenceSafe(runtime, {
        displacedLeaseId: takeover.displacedLease.id,
        replacementLeaseId: takeover.replacementLeaseId,
        probeIds: takeover.probes.map((probe) => probe.id),
        modelCallsInterrupted,
        judgeCallsCancelled,
      }),
    })
  }
}

function reportBody(
  runtime: Runtime,
  status: RunStatus,
  reasons: string[],
): Omit<ExecutionReport, "contentHash"> {
  const tasks = listRunTasks(runtime.layout.ledger, runtime.run.id)
  const attempts = listAttempts(runtime.layout.ledger, { runId: runtime.run.id })
  const judgeAssessments = listJudgeAssessments(runtime.layout.ledger, {
    runId: runtime.run.id,
  })
  const completed = tasks.filter(
    (task) => task.status === "completed" || task.status === "completed_with_override",
  ).length
  const failed = tasks.filter((task) =>
    ["retryable_failed", "rejected"].includes(task.status),
  ).length
  const blocked = tasks.filter((task) => task.status === "blocked").length
  const executorUsage = executorRunUsageEvidence(runtime, attempts)
  const judgeUsage = judgeUsageEvidence(runtime)
  const combinedUsage = combinedRunUsageEvidence(executorUsage, judgeUsage)
  const childAggregate = readChildRunTreeAggregate(runtime.layout.ledger, runtime.run.id)
  const childRunCount = childAggregate.childLinks.length
  const childWorkerWatchdogRestarts = readIndexedRunEvents(
    runtime.layout.ledger,
    runtime.run.id,
  ).filter((event) => event.type === "child.worker.restart_started").length
  const aggregateUsage = (
    rootUsage: EvidenceUsage,
    childUsage: ChildUsageSummary,
    source: string,
  ): ChildUsageSummary => {
    const rootSummary = childUsageFromEvidence(rootUsage)
    return childRunCount === 0
      ? rootSummary
      : aggregateChildUsageSummaries([rootSummary, childUsage], source)
  }
  const taskEvidenceCaveats = (taskAttempts: readonly { id: string }[]): string[] => {
    const evidence = taskAttempts
      .map((attempt) => getEvidenceBundle(runtime.layout.ledger, attempt.id)?.bundle)
      .filter((bundle) => bundle?.schemaVersion === 2)
      .at(-1)
    if (evidence?.schemaVersion !== 2) return []
    const caveats: string[] = []
    if (evidence.task.evidenceMode === "change-only") {
      caveats.push(
        "A permitted Git/workspace delta proves materialization, not semantic correctness by itself.",
      )
    }
    if (evidence.task.evidenceMode.includes("artifact")) {
      caveats.push(
        "Artifact existence, hash or schema proves materialization and declared shape, not semantic correctness beyond the configured gates or assessment.",
      )
    }
    return caveats
  }
  return {
    schemaVersion: 1,
    id: `report-${runtime.run.id}`,
    runId: runtime.run.id,
    rootPrdId: runtime.run.rootPrdId,
    rootPrdFile: runtime.run.rootPrdFile,
    ...(runtime.run.source ? { source: runtime.run.source } : {}),
    definitionHash: runtime.run.definitionHash,
    graphHash: runtime.run.graphHash,
    mode: runtime.run.mode,
    status,
    effectiveOptionsHash: runtime.run.effectiveOptionsHash,
    effectiveOptions: runtime.run.effectiveOptions,
    tasks: tasks.map((task) => {
      const taskAttempts = attempts.filter(
        (attempt) => attempt.documentId === task.documentId && attempt.taskId === task.taskId,
      )
      return {
        taskId: task.taskId,
        documentId: task.documentId,
        status: task.status,
        attemptIds: taskAttempts.map((attempt) => attempt.id),
        evidenceCaveats: taskEvidenceCaveats(taskAttempts),
        markerUpdated:
          runtime.source.kind === "prd" &&
          (task.status === "completed" || task.status === "completed_with_override"),
        ...(task.completion ? { completion: task.completion } : {}),
        ...(() => {
          const assessments = judgeAssessments
            .filter((record) => {
              const assessedAttempt = attempts.find((attempt) => attempt.id === record.attemptId)
              return (
                assessedAttempt?.documentId === task.documentId &&
                assessedAttempt.taskId === task.taskId
              )
            })
            .map((record) => record.assessment)
          return assessments.length > 0 ? { judgeAssessments: assessments } : {}
        })(),
        ...(() => {
          const latest = attempts
            .filter(
              (attempt) => attempt.documentId === task.documentId && attempt.taskId === task.taskId,
            )
            .at(-1)
          return latest?.executorOutcome ? { executorOutcome: latest.executorOutcome } : {}
        })(),
      }
    }),
    counters: {
      tasksSelected: tasks.filter((task) => task.status !== "pending" && task.status !== "eligible")
        .length,
      tasksCompleted: completed,
      tasksFailed: failed,
      tasksBlocked: blocked,
      attempts: attempts.length,
      modelCalls: attempts.reduce((sum, attempt) => sum + attempt.counters.modelCalls, 0),
      toolCalls: attempts.reduce((sum, attempt) => sum + attempt.counters.toolCalls, 0),
      wiggumIterations: attempts.reduce(
        (sum, attempt) => sum + attempt.counters.wiggumIterations,
        0,
      ),
      executorRetries: attempts.reduce((sum, attempt) => sum + attempt.counters.executorRetries, 0),
      watchdogRestarts: attempts.reduce(
        (sum, attempt) => sum + attempt.counters.watchdogRestarts,
        childWorkerWatchdogRestarts,
      ),
      judgeTransportRetries: attempts.reduce(
        (sum, attempt) => sum + attempt.counters.judgeTransportRetries,
        0,
      ),
      revisionAttempts: attempts.reduce(
        (sum, attempt) => sum + attempt.counters.revisionAttempts,
        0,
      ),
      gateRuns: attempts.reduce((sum, attempt) => sum + attempt.counters.gateRuns, 0),
      noChangeAttempts: attempts.reduce(
        (sum, attempt) => sum + attempt.counters.noChangeAttempts,
        0,
      ),
    },
    progress: {
      scope: childAggregate.scope,
      completed: childAggregate.completed,
      total: childAggregate.total,
      childRunCount,
    },
    usage: {
      combined: combinedUsage,
      executor: executorUsage,
      judge: judgeUsage,
      judgeRequested:
        runtime.options.evaluationMode.value === "external" ||
        runtime.options.evaluationMode.value === "self",
      children: {
        runCount: childRunCount,
        combined: childAggregate.usage.combined,
        executor: childAggregate.usage.executor,
        judge: childAggregate.usage.judge,
      },
      aggregate: {
        combined: aggregateUsage(combinedUsage, childAggregate.usage.combined, "run-tree:combined"),
        executor: aggregateUsage(executorUsage, childAggregate.usage.executor, "run-tree:executor"),
        judge: aggregateUsage(judgeUsage, childAggregate.usage.judge, "run-tree:judge"),
      },
    },
    reasons,
    createdAt: runtime.run.createdAt,
    ...(runtime.run.startedAt ? { startedAt: runtime.run.startedAt } : {}),
    ...(runtime.run.finishedAt ? { finishedAt: runtime.run.finishedAt } : {}),
  }
}

async function persistReport(
  runtime: Runtime,
  status: RunStatus,
  reasons: string[],
): Promise<ExecutionReport> {
  const body = reportBody(runtime, status, reasons)
  const report = ExecutionReportSchema.parse({
    ...body,
    contentHash: hashCanonicalValue("ralph.execution.report.v1", body),
  })
  persistRunReport(runtime.layout.ledger, {
    runId: runtime.run.id,
    report,
    event: { type: "run.report.updated" },
  })
  await writeJsonAtomic(join(runtime.runLayout.reports, "report.json"), report, {
    overwrite: true,
  })
  return report
}

function alignRunGraphHash(runtime: Runtime): void {
  if (runtime.run.graphHash === runtime.graph.graphHash) return
  runtime.run = updateRun(runtime.layout.ledger, {
    runId: runtime.run.id,
    graphHash: runtime.graph.graphHash,
    event: { type: "run.graph.reconciled" },
  })
}

async function recompileRuntime(runtime: Runtime, alignRun = true): Promise<void> {
  if (runtime.source.kind === "ad-hoc") {
    if (alignRun && runtime.alignGraphHash !== false) alignRunGraphHash(runtime)
    return
  }
  const graph = await compileExecutableGraph(executionWorkspace(runtime), runtime.graph.rootFile)
  if (graph.definitionHash !== runtime.run.definitionHash) {
    throw new RalphError(
      "RALPH_EXECUTION_DEFINITION_CHANGED",
      "PRD definition changed while the run was active",
      {
        exitCode: EXIT_CODES.conflict,
        details: { expected: runtime.run.definitionHash, actual: graph.definitionHash },
      },
    )
  }
  runtime.graph = graph
  if (alignRun && runtime.alignGraphHash !== false) alignRunGraphHash(runtime)
}

async function completedMarkerMatchesPreparedSource(
  runtime: Runtime,
  document: PrdDocument,
  task: PrdTask,
  expectedBeforeHash: string,
): Promise<boolean> {
  const location = document.sourceMap[task.id]
  if (!location || task.status !== "completed") return false
  const bytes = await readFile(resolve(executionWorkspace(runtime), document.file))
  const markerOffset = location.marker.offset
  if (
    bytes[markerOffset] !== "[".charCodeAt(0) ||
    bytes[markerOffset + 1] !== "x".charCodeAt(0) ||
    bytes[markerOffset + 2] !== "]".charCodeAt(0)
  ) {
    return false
  }
  const reconstructedBefore = Buffer.from(bytes)
  reconstructedBefore[markerOffset + 1] = "~".charCodeAt(0)
  return createHash("sha256").update(reconstructedBefore).digest("hex") === expectedBeforeHash
}

async function reconcileCompletions(runtime: Runtime): Promise<void> {
  for (const transaction of listPreparedCompletions(runtime.layout.ledger, runtime.run.id)) {
    runtime.assertWriterLease()
    let current = transaction
    const isolatedWorktrees =
      runtime.run.mode === "parallel"
        ? listGitWorktreeRecords(runtime.layout.ledger, {
            workspaceId: runtime.workspaceId,
            runId: runtime.run.id,
            limit: 1_000,
          })
        : []
    const claimedWorktreePaths = new Set(
      runtime.run.mode === "parallel"
        ? listResourceClaimSets(runtime.layout.ledger, {
            workspaceId: runtime.workspaceId,
            runId: runtime.run.id,
            attemptId: current.attemptId,
            limit: 1_000,
          }).flatMap((claimSet) =>
            claimSet.claims
              .filter((claim) => claim.kind === "worktree")
              .map((claim) => claim.resourceKey),
          )
        : [],
    )
    const isolatedWorktree =
      isolatedWorktrees.find(
        (worktree) =>
          worktree.attemptId === current.attemptId &&
          worktree.status !== "removed" &&
          worktree.status !== "failed",
      ) ??
      isolatedWorktrees.find(
        (worktree) =>
          worktree.documentId === current.documentId &&
          worktree.taskId === current.taskId &&
          worktree.status === "active" &&
          worktree.failureReason === PARALLEL_RESUMABLE_WORKTREE_REASON &&
          claimedWorktreePaths.has(portable(worktree.worktreePath)),
      )
    const reconciliationRuntime: Runtime = isolatedWorktree
      ? {
          ...runtime,
          executionRoot: isolatedWorktree.worktreePath,
          graph: await compileExecutableGraph(
            isolatedWorktree.worktreePath,
            runtime.graph.rootFile,
          ),
          alignGraphHash: false,
        }
      : runtime
    let document = documentFor(reconciliationRuntime.graph, current.documentId)
    let task = document.tasks.find((candidate) => candidate.id === current.taskId)
    if (!task) {
      throw new RalphError(
        "RALPH_COMPLETION_RECONCILIATION_TASK_MISSING",
        `Prepared completion task is missing: ${current.documentId}/${current.taskId}`,
        { exitCode: EXIT_CODES.conflict },
      )
    }
    if (current.status === "prepared") {
      if (task.status === "pending") {
        throw new RalphError(
          "RALPH_COMPLETION_RECONCILIATION_MARKER_CONFLICT",
          `Prepared completion marker reverted to pending: ${current.documentId}/${current.taskId}`,
          { exitCode: EXIT_CODES.conflict },
        )
      }
      if (task.status === "completed") {
        if (
          !(await completedMarkerMatchesPreparedSource(
            reconciliationRuntime,
            document,
            task,
            current.expectedBeforeHash,
          ))
        ) {
          throw new RalphError(
            "RALPH_COMPLETION_RECONCILIATION_HASH_CONFLICT",
            `Completed marker does not derive from the prepared source: ${current.documentId}/${current.taskId}`,
            {
              exitCode: EXIT_CODES.conflict,
              details: {
                transactionStatus: current.status,
                markerStatus: task.status,
                expectedBeforeHash: current.expectedBeforeHash,
                actualHash: document.contentHash,
              },
            },
          )
        }
        runtime.assertWriterLease()
        current = markCompletionMarkerWritten(runtime.layout.ledger, {
          completionId: current.id,
          expectedAfterHash: document.contentHash,
          event: { type: "completion.reconciled.existing_marker" },
        })
      } else {
        if (task.status !== "active" || document.contentHash !== current.expectedBeforeHash) {
          throw new RalphError(
            "RALPH_COMPLETION_RECONCILIATION_HASH_CONFLICT",
            `PRD changed after completion was prepared: ${current.documentId}/${current.taskId}`,
            {
              exitCode: EXIT_CODES.conflict,
              details: {
                transactionStatus: current.status,
                markerStatus: task.status,
                expectedBeforeHash: current.expectedBeforeHash,
                actualHash: document.contentHash,
              },
            },
          )
        }
        runtime.assertWriterLease()
        const marker = await updateTaskMarker(
          resolve(executionWorkspace(reconciliationRuntime), document.file),
          {
            file: document.file,
            taskId: task.id,
            status: "completed",
            expectedContentHash: current.expectedBeforeHash,
            expectedStatus: "active",
          },
        )
        runtime.assertWriterLease()
        current = markCompletionMarkerWritten(runtime.layout.ledger, {
          completionId: current.id,
          expectedAfterHash: marker.contentHash,
          event: { type: "completion.reconciled.marker" },
        })
        await recompileRuntime(reconciliationRuntime, false)
        document = documentFor(reconciliationRuntime.graph, current.documentId)
        task = document.tasks.find((candidate) => candidate.id === current.taskId)
      }
    }
    if (
      current.status !== "marker_written" ||
      task?.status !== "completed" ||
      document.contentHash !== current.expectedAfterHash
    ) {
      throw new RalphError(
        "RALPH_COMPLETION_RECONCILIATION_HASH_CONFLICT",
        `Marker does not match pending completion: ${current.documentId}/${current.taskId}`,
        {
          exitCode: EXIT_CODES.conflict,
          details: {
            transactionStatus: current.status,
            markerStatus: task?.status,
            expectedHash: current.expectedAfterHash,
            actualHash: document.contentHash,
          },
        },
      )
    }
    runtime.assertWriterLease()
    commitCompletion(runtime.layout.ledger, {
      completionId: current.id,
      markerContentHash: document.contentHash,
      taskStatus:
        current.decision.status === "overridden" ? "completed_with_override" : "completed",
      completion: current.decision,
      event: { type: "completion.reconciled.commit" },
    })
    await recompileRuntime(reconciliationRuntime, false)
  }
  if (listPreparedCompletions(runtime.layout.ledger, runtime.run.id).length > 0) {
    throw new RalphError(
      "RALPH_COMPLETION_RECONCILIATION_INCOMPLETE",
      "A pending completion remains unreconciled",
      { exitCode: EXIT_CODES.conflict },
    )
  }
}

function revisionRecoveryTaskKeys(
  events: readonly ReturnType<typeof readEvents>[number][],
  runId: string,
): ReadonlySet<string> {
  return new Set(
    events
      .filter(
        (event) =>
          event.runId === runId &&
          event.type === "evaluation.revisions.extended" &&
          event.documentId !== undefined &&
          event.taskId !== undefined,
      )
      .map((event) => `${event.documentId}\u0000${event.taskId}`),
  )
}

function assertTaskMarkerParity(
  graph: CompiledPrdGraph,
  records: readonly RunTaskRecord[],
  recoveredTaskKeys: ReadonlySet<string> = new Set(),
  isolatedCompletionTaskKeys: ReadonlySet<string> = new Set(),
): void {
  for (const record of records) {
    const markerTask = documentFor(graph, record.documentId).tasks.find(
      (task) => task.id === record.taskId,
    )
    if (!markerTask) {
      throw new RalphError(
        "RALPH_EXECUTION_GRAPH_TASK_MISSING",
        `Compiled task is missing: ${record.documentId}/${record.taskId}`,
        { exitCode: EXIT_CODES.conflict },
      )
    }
    const marker = markerTask.status
    const recoveryEligible =
      record.status === "eligible" &&
      recoveredTaskKeys.has(`${record.documentId}\u0000${record.taskId}`)
    const expectedMarker =
      record.status === "pending" || (record.status === "eligible" && !recoveryEligible)
        ? "pending"
        : record.status === "completed" || record.status === "completed_with_override"
          ? "completed"
          : "active"
    if (marker === expectedMarker) continue
    const taskKey = `${record.documentId}\u0000${record.taskId}`
    if (
      ((expectedMarker === "completed" && marker !== "completed") ||
        (expectedMarker === "active" && marker === "pending")) &&
      isolatedCompletionTaskKeys.has(taskKey)
    ) {
      continue
    }
    throw new RalphError(
      "RALPH_EXECUTION_MARKER_LEDGER_CONFLICT",
      `PRD marker and durable task state disagree: ${record.documentId}/${record.taskId}`,
      {
        exitCode: EXIT_CODES.conflict,
        details: {
          ledgerStatus: record.status,
          markerStatus: marker,
          expectedMarkerStatus: expectedMarker,
        },
        hint: "Restore the verified marker/state pair before resuming; marker text alone is not completion evidence.",
      },
    )
  }
}

function isolatedParallelCompletionKeys(input: {
  ledgerPath: string
  workspaceId: string
  runId: string
  mode: RunMode
}): ReadonlySet<string> {
  if (input.mode !== "parallel") return new Set()
  const worktrees = listGitWorktreeRecords(input.ledgerPath, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    limit: 1_000,
  })
  const integrations = listGitIntegrationRecords(input.ledgerPath, {
    workspaceId: input.workspaceId,
    runId: input.runId,
    limit: 1_000,
  })
  const integrationsByWorktree = new Map<string, GitIntegrationRecord[]>()
  for (const integration of integrations) {
    const current = integrationsByWorktree.get(integration.worktreeId) ?? []
    current.push(integration)
    integrationsByWorktree.set(integration.worktreeId, current)
  }
  const waived = new Set<string>()
  for (const worktree of worktrees) {
    if (
      worktree.status === "removed" ||
      worktree.status === "integrated" ||
      worktree.status === "preparing"
    ) {
      continue
    }
    const records = integrationsByWorktree.get(worktree.id) ?? []
    const deliveredToTarget = records.some(
      (record) => record.status === "passed" && record.strategy !== "none",
    )
    if (!deliveredToTarget) waived.add(`${worktree.documentId}\u0000${worktree.taskId}`)
  }
  return waived
}

function isolatedParallelCompletionTaskKeys(runtime: Runtime): ReadonlySet<string> {
  return isolatedParallelCompletionKeys({
    ledgerPath: runtime.layout.ledger,
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    mode: runtime.run.mode,
  })
}

function assertLedgerMarkerParity(runtime: Runtime): void {
  if (runtime.source.kind === "ad-hoc") return
  const events = readEvents(runtime.layout.ledger)
  assertTaskMarkerParity(
    runtime.graph,
    listRunTasks(runtime.layout.ledger, runtime.run.id),
    revisionRecoveryTaskKeys(events, runtime.run.id),
    isolatedParallelCompletionTaskKeys(runtime),
  )
}

async function activateTask(runtime: Runtime, reference: TaskRef): Promise<RunTaskRecord> {
  runtime.assertWriterLease()
  let record = getRunTask(
    runtime.layout.ledger,
    runtime.run.id,
    reference.documentId,
    reference.taskId,
  )
  if (!record) {
    throw new RalphError("RALPH_RUN_TASK_NOT_MATERIALIZED", "Selected task is not materialized", {
      exitCode: EXIT_CODES.operationalError,
    })
  }
  if (record.status === "pending" || record.status === "blocked") {
    record = transitionStoredTask(runtime.layout.ledger, record, "eligible", {
      eventType: "task.selected",
    })
  }
  if (runtime.source.kind === "ad-hoc") {
    if (record.status !== "active") {
      record = transitionStoredTask(runtime.layout.ledger, record, "active", {
        markerContentHash: record.markerContentHash,
        eventType: "task.started.record_only",
      })
    }
    return record
  }
  const document = documentFor(runtime.graph, reference.documentId)
  const task = taskFor(runtime.graph, reference)
  let markerHash = document.contentHash
  if (task.status === "pending") {
    const marker = await updateTaskMarker(resolve(executionWorkspace(runtime), document.file), {
      file: document.file,
      taskId: task.id,
      status: "active",
      expectedContentHash: document.contentHash,
      expectedStatus: "pending",
    })
    markerHash = marker.contentHash
    runtime.assertWriterLease()
    await recompileRuntime(runtime)
  } else if (task.status !== "active") {
    throw new RalphError(
      "RALPH_TASK_MARKER_NOT_ACTIVATABLE",
      `Selected task marker is ${task.status}: ${taskRefKey(reference)}`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  if (record.status !== "active") {
    record = transitionStoredTask(runtime.layout.ledger, record, "active", {
      markerContentHash: markerHash,
      eventType: "task.started",
    })
  } else if (record.markerContentHash !== markerHash) {
    record = upsertRunTask(runtime.layout.ledger, {
      runId: record.runId,
      documentId: record.documentId,
      taskId: record.taskId,
      status: record.status,
      markerContentHash: markerHash,
      ...(record.activeAttemptId ? { activeAttemptId: record.activeAttemptId } : {}),
      event: { type: "task.marker.reconciled" },
    })
  }
  return record
}

async function completeSelectedTask(
  runtime: Runtime,
  reference: TaskRef,
  record: RunTaskRecord,
  attemptId: string,
  evidence: ReturnType<typeof buildEvidenceBundle>,
  decision: ReturnType<typeof decideDeterministicCompletion>,
  overrideGateIds: readonly string[],
  signal: AbortSignal,
  deadlineAt?: string,
): Promise<TaskExecutionResult> {
  runtime.assertWriterLease()
  // A model outcome, gate result or parent-side override can never bypass the
  // separately leased child tree. The child receipt unlocks parent
  // verification; it does not itself complete the parent contract.
  assertChildPassedBeforeParentVerification({
    ledger: runtime.layout.ledger,
    parentRunId: runtime.run.id,
    parentTask: reference,
    graph: runtime.graph,
  })
  assertExecutionDeadline(deadlineAt, "completion-prepare")
  assertExecutionNotCancelled(signal, "completion-prepare")
  const receipt: EvidencePersistenceReceipt = EvidencePersistenceReceiptSchema.parse({
    schemaVersion: 1,
    evidenceBundleId: evidence.id,
    contentHash: evidence.contentHash,
    persistedAt: runtime.dependencies.now(),
  })
  let overrideAudit: CompletionOverrideAudit | undefined
  const taskRecord = domainTaskRecord(record)
  if (decision.overrideUsed) {
    const recordedAt = runtime.dependencies.now()
    overrideAudit = CompletionOverrideAuditSchema.parse({
      schemaVersion: 1,
      eventId: randomUUID(),
      source: "cli",
      force: true,
      reason: "Required verifications were explicitly skipped with --force.",
      overriddenGateIds: overrideGateIds,
      recordedAt,
    })
    completeTaskWithOverride(taskRecord, {
      decision: decision.decision,
      evidence,
      persistence: receipt,
      audit: overrideAudit,
    })
  } else {
    completeTask(taskRecord, {
      decision: decision.decision,
      evidence,
      persistence: receipt,
    })
  }

  if (runtime.source.kind === "ad-hoc") {
    commitRecordOnlyCompletion(runtime.layout.ledger, {
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      attemptId,
      markerContentHash: record.markerContentHash,
      decision: decision.decision,
      ...(overrideAudit ? { overrideAudit } : {}),
      committedAt: runtime.dependencies.now(),
      event: {
        type: "task.completed.record_only",
        payload: { sourceKind: "ad-hoc", markerUpdated: false },
      },
    })
    return {
      status: decision.overrideUsed ? "completed_with_override" : "completed",
      exitCode: EXIT_CODES.success,
      reason: decision.decision.reasons.join("; "),
    }
  }

  const document = documentFor(runtime.graph, reference.documentId)
  const completionId = runtime.dependencies.id("completion")
  prepareCompletion(runtime.layout.ledger, {
    id: completionId,
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
    attemptId,
    expectedBeforeHash: document.contentHash,
    decision: decision.decision,
    ...(overrideAudit ? { overrideAudit } : {}),
    event: {
      type: "completion.prepared",
      payload: overrideAudit ? { overrideAudit } : {},
    },
  })
  await withinTaskDeadline(
    deadlineAt,
    "completion-prepared-fault-boundary",
    () => Promise.resolve(runtime.dependencies.fault("after-completion-prepared")),
    signal,
  )
  runtime.assertWriterLease()
  const marker = await withinTaskDeadline(
    deadlineAt,
    "completion-marker-write",
    () =>
      updateTaskMarker(resolve(executionWorkspace(runtime), document.file), {
        file: document.file,
        taskId: reference.taskId,
        status: "completed",
        expectedContentHash: document.contentHash,
        expectedStatus: "active",
      }),
    signal,
  )
  await withinTaskDeadline(
    deadlineAt,
    "completion-marker-file-fault-boundary",
    () => Promise.resolve(runtime.dependencies.fault("after-completion-marker-file-written")),
    signal,
  )
  assertExecutionDeadline(deadlineAt, "completion-marker-ledger")
  assertExecutionNotCancelled(signal, "completion-marker-ledger")
  runtime.assertWriterLease()
  markCompletionMarkerWritten(runtime.layout.ledger, {
    completionId,
    expectedAfterHash: marker.contentHash,
    event: { type: "completion.marker_written" },
  })
  await withinTaskDeadline(
    deadlineAt,
    "completion-marker-ledger-fault-boundary",
    () => Promise.resolve(runtime.dependencies.fault("after-completion-marker-written")),
    signal,
  )
  assertExecutionDeadline(deadlineAt, "completion-commit")
  assertExecutionNotCancelled(signal, "completion-commit")
  runtime.assertWriterLease()
  commitCompletion(runtime.layout.ledger, {
    completionId,
    markerContentHash: marker.contentHash,
    taskStatus: decision.overrideUsed ? "completed_with_override" : "completed",
    completion: decision.decision,
    event: { type: "task.completed" },
  })
  await withinTaskDeadline(
    deadlineAt,
    "completion-committed-fault-boundary",
    () => Promise.resolve(runtime.dependencies.fault("after-completion-committed")),
    signal,
  )
  await withinTaskDeadline(
    deadlineAt,
    "completion-recompile",
    () => recompileRuntime(runtime),
    signal,
  )
  return {
    status: decision.overrideUsed ? "completed_with_override" : "completed",
    exitCode: EXIT_CODES.success,
    reason: decision.decision.reasons.join("; "),
  }
}

function createAttemptWatchdog(
  runtime: Runtime,
  reference: TaskRef,
  attemptId: string,
): AttemptWatchdogRuntime {
  const watchdogRestarts = listAttempts(runtime.layout.ledger, {
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
  }).reduce((sum, candidate) => sum + candidate.counters.watchdogRestarts, 0)
  const profile = watchdogProfileFromConfig(
    runtime.optionResolution.config?.config.watchdog ?? DEFAULT_CONFIG.watchdog,
  )
  return new AttemptWatchdogRuntime({
    profile,
    initialPhase: "model-call",
    initialBudget: { schemaVersion: 1, watchdogRestarts },
    eventContext: {
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      attemptId,
    },
    ...(runtime.signal ? { externalSignal: runtime.signal } : {}),
    autoControlHeartbeat: true,
    probeId: (sequence, phase) => `${attemptId}:${phase}:${sequence}`,
    persistEvents(events, evaluation) {
      runtime.assertWriterLease()
      persistAttemptWatchdogEvaluation(runtime.layout.ledger, {
        attemptId,
        evaluation,
        events: events.map((event) => ({
          ...event,
          payload: persistenceSafe(runtime, event.payload ?? {}),
        })),
      })
    },
  })
}

function beginWatchdogPhase(
  watchdog: AttemptWatchdogRuntime,
  phase: "model-call" | "tool" | "gate" | "judge" | "child" | "integration",
  deadlineAt?: string,
): void {
  switch (phase) {
    case "model-call":
      watchdog.beginModelCall()
      break
    case "tool":
      watchdog.beginTool()
      break
    case "gate":
      watchdog.beginGate()
      break
    case "judge":
      watchdog.beginJudge()
      break
    case "child":
      watchdog.beginChild()
      break
    case "integration":
      watchdog.beginIntegration()
      break
  }
  if (deadlineAt) {
    const deadline = Date.parse(deadlineAt)
    if (!Number.isFinite(deadline)) {
      throw new RalphError(
        "RALPH_WATCHDOG_DEADLINE_INVALID",
        `Watchdog phase ${phase} received an invalid task deadline`,
        { exitCode: EXIT_CODES.operationalError, details: { phase, deadlineAt } },
      )
    }
    watchdog.setDeadlinesAfter({
      phaseTimeoutMs: Math.max(0, deadline - Date.now()),
    })
  }
  watchdog.recordProgress()
}

async function assertAttemptWatchdogHealthy(watchdog: AttemptWatchdogRuntime): Promise<void> {
  // Drain the current probe before a command-owned terminal transition. The
  // monitor may schedule another timer, but the caller synchronously stops it
  // after this check, so no accepted action/error can disappear in finally.
  await watchdog.flush()
  watchdog.throwIfActionRequested()
  if (watchdog.lastError) throw watchdog.lastError
}

async function runAttempt(
  runtime: Runtime,
  reference: TaskRef,
  backend: ExecutionBackend,
  taskBaseline: WorkspaceBaseline,
  ordinal: number,
  noChangeOrdinal: number,
  judgeEvaluation?: ResolvedJudgeEvaluation,
  revision?: {
    ordinal: number
    previousAssessment: JudgeAssessment
    previousAssessmentRef: string
  },
  deadlineAt?: string,
): Promise<TaskExecutionResult> {
  const attemptId = runtime.dependencies.id("attempt")
  const watchdog = createAttemptWatchdog(runtime, reference, attemptId)
  try {
    const result = await runAttemptBody(
      runtime,
      reference,
      backend,
      taskBaseline,
      ordinal,
      noChangeOrdinal,
      attemptId,
      watchdog,
      judgeEvaluation,
      revision,
      deadlineAt,
    )
    await assertAttemptWatchdogHealthy(watchdog)
    return result
  } catch (error) {
    await watchdog.whenIdle()
    if (watchdog.activeAction?.destructive) throw watchdog.activeAction
    if (watchdog.lastError) throw watchdog.lastError
    throw error
  } finally {
    watchdog.stop()
    await watchdog.whenIdle()
  }
}

function takeSupervisorContextRotation(
  runtime: Runtime,
  boundary: SupervisorContextRotationBoundary,
): SupervisorContextRotation | undefined {
  runtime.assertWriterLease()
  return runtime.controlSession?.takeContextRotation(boundary)
}

function persistAppliedContextRotation(
  runtime: Runtime,
  rotation: SupervisorContextRotation | undefined,
  boundary: SupervisorContextRotationBoundary,
  attemptId: string,
  contextManifestHash: string,
): void {
  if (!rotation) return
  runtime.assertWriterLease()
  appendEvent(runtime.layout.ledger, {
    type: "context.rotation.applied",
    scope: "run",
    streamId: runtime.run.id,
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    attemptId,
    causationId: rotation.requestId,
    level: "info",
    payload: persistenceSafe(runtime, {
      schemaVersion: 1,
      requestId: rotation.requestId,
      reason: rotation.reason,
      requestedAt: rotation.requestedAt,
      boundary,
      contextManifestHash,
    }),
  })
}

async function runAttemptBody(
  runtime: Runtime,
  reference: TaskRef,
  backend: ExecutionBackend,
  taskBaseline: WorkspaceBaseline,
  ordinal: number,
  noChangeOrdinal: number,
  attemptId: string,
  watchdog: AttemptWatchdogRuntime,
  judgeEvaluation?: ResolvedJudgeEvaluation,
  revision?: {
    ordinal: number
    previousAssessment: JudgeAssessment
    previousAssessmentRef: string
  },
  deadlineAt?: string,
): Promise<TaskExecutionResult> {
  const task = taskFor(runtime.graph, reference)
  const document = documentFor(runtime.graph, reference.documentId)
  const backendCapabilities = backend.capabilities()
  const backendLimits = RoleProfileLimitsSchema.parse(backend.limits?.() ?? {})
  const modelLimits = effectiveModelUsageLimits(task.budget, backendLimits)
  const attemptSignal = watchdog.signal
  if (hasModelUsageLimits(modelLimits) && backendCapabilities.usage === "unavailable") {
    throw new RalphError(
      "RALPH_MODEL_USAGE_LIMIT_UNENFORCEABLE",
      "Executor usage is unavailable, so command-owned token or cost limits cannot be enforced",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: { backendId: backend.id, limits: modelLimits },
      },
    )
  }
  const unresolvedUsageCalls = hasModelUsageLimits(modelLimits)
    ? unresolvedTaskUsageCalls(runtime, reference, modelLimits)
    : []
  if (unresolvedUsageCalls.length > 0) {
    throw new RalphError(
      "RALPH_MODEL_USAGE_RECONCILIATION_REQUIRED",
      "Task has prior provider/process calls whose usage budget could not be reconciled",
      {
        exitCode: EXIT_CODES.budgetExceeded,
        details: {
          documentId: reference.documentId,
          taskId: reference.taskId,
          unresolvedProviderCallIds: unresolvedUsageCalls,
          limits: modelLimits,
        },
        hint: "Inspect the durable usage events and resolve the interrupted call before resuming this task under token or cost limits.",
      },
    )
  }
  const priorityPaths = retentionPriorityPaths(task)
  const attemptWorkspaceBaseline = await withinTaskDeadline(
    deadlineAt,
    "attempt-baseline",
    () =>
      captureWorkspaceBaseline(executionWorkspace(runtime), {
        scope: document.workspace,
        retentionPriorityPaths: priorityPaths,
        objectStore: { directory: runtime.runLayout.artifacts },
        storageRoot: runtime.workspaceRoot,
      }),
    attemptSignal,
  )
  const baseline = gitBaselineFromWorkspace(attemptWorkspaceBaseline)
  const previousAttemptsAtRecovery = listAttempts(runtime.layout.ledger, {
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
  })
  const expectedWorkspaceHash = await withinTaskDeadline(
    deadlineAt,
    "recovery-expected-workspace",
    () => expectedWorkspaceHashFromLatestAttempt(runtime, previousAttemptsAtRecovery),
    attemptSignal,
  )
  const unsettledToolCallIds = listToolCalls(runtime.layout.ledger, {
    runId: runtime.run.id,
  })
    .filter(
      (record) =>
        !record.settlement &&
        record.intent.documentId === reference.documentId &&
        record.intent.taskId === reference.taskId,
    )
    .map((record) => record.intent.id)
  const recoveryChanges = compareWorkspaceBaselines(taskBaseline, attemptWorkspaceBaseline)
  const recoveryDiff = recoveryChanges.hasChanges
    ? await withinTaskDeadline(
        deadlineAt,
        "recovery-diff",
        () =>
          persistWorkspaceDiff(
            runtime,
            attemptId,
            "task",
            taskBaseline,
            attemptWorkspaceBaseline,
            recoveryChanges,
          ),
        attemptSignal,
      )
    : undefined
  const recovery = await withinTaskDeadline(
    deadlineAt,
    "recovery-manifest",
    () =>
      buildAndPersistRecoveryManifest({
        workspaceRoot: executionWorkspace(runtime),
        storageRoot: runtime.workspaceRoot,
        runLayout: runtime.runLayout,
        runId: runtime.run.id,
        documentId: reference.documentId,
        taskId: reference.taskId,
        attemptId,
        taskBaseline,
        observedWorkspace: attemptWorkspaceBaseline,
        previousAttemptIds: previousAttemptsAtRecovery.map((candidate) => candidate.id),
        unsettledToolCallIds,
        ...(expectedWorkspaceHash ? { expectedWorkspaceHash } : {}),
        ...(recoveryDiff
          ? {
              diff: {
                ref: recoveryDiff.diffRef,
                contentHash: recoveryDiff.diffHash,
                reproducible: recoveryDiff.reproducible,
              },
            }
          : {}),
        capturedAt: runtime.dependencies.now(),
      }),
    attemptSignal,
  )
  const pendingRecoveryDecision = runtime.pendingRecoveryDecision
  const pendingRecoveryAcceptance = runtime.recoveryAcceptance
  if (
    pendingRecoveryDecision &&
    (pendingRecoveryDecision.documentId !== reference.documentId ||
      pendingRecoveryDecision.taskId !== reference.taskId)
  ) {
    throw new RalphError(
      "RALPH_RECOVERY_PENDING_TARGET_MISMATCH",
      "The unresolved workspace-change decision targets a different task than the resumable task selected by the scheduler",
      {
        exitCode: EXIT_CODES.conflict,
        details: {
          decisionEventId: pendingRecoveryDecision.eventId,
          pendingTask: `${pendingRecoveryDecision.documentId}/${pendingRecoveryDecision.taskId}`,
          selectedTask: `${reference.documentId}/${reference.taskId}`,
        },
        hint: "Inspect `ralph-next status run`; Ralph will not transfer recovery authority between tasks.",
      },
    )
  }
  const mode = executableMode(runtime.options)
  const maxCalls =
    mode === "wiggum"
      ? Math.min(runtime.options.maxIterations.value, runtime.options.maxModelCallsPerAttempt.value)
      : 1
  let consumedModelUsage = accountedUsageFromEvidence(taskUsageEvidence(runtime, reference))
  const initialDependencyOutputs = await withinTaskDeadline(
    deadlineAt,
    "dependency-context",
    () => dependencyOutputsFor(runtime, reference),
    attemptSignal,
  )
  const initialContextRotation = takeSupervisorContextRotation(runtime, "next-task")
  let context = await withinTaskDeadline(
    deadlineAt,
    "context-build",
    () =>
      buildContextManifest({
        graph: runtime.graph,
        task: reference,
        runId: runtime.run.id,
        attemptId,
        mode,
        baseline,
        budget: contextBudget(task, runtime.options, mode, modelLimits, consumedModelUsage, {
          modelCalls: runtime.options.maxModelCallsPerAttempt.value,
          iterations: mode === "wiggum" ? maxCalls : 1,
          ...(deadlineAt ? { deadlineAt } : {}),
        }),
        workspaceRoot: executionWorkspace(runtime),
        dependencyOutputs: initialDependencyOutputs,
        ...(initialContextRotation
          ? {
              contextRotation: {
                ...initialContextRotation,
                boundary: "next-task" as const,
              },
            }
          : {}),
        additionalInvariants: forcedDependencyInvariants(runtime, reference),
        ...(revision?.previousAssessmentRef
          ? { previousAssessmentRef: revision.previousAssessmentRef }
          : {}),
        ...(revision
          ? {
              revisionFeedback: {
                assessment: revision.previousAssessment,
                assessmentRef: revision.previousAssessmentRef,
                threshold: runtime.options.judgeThreshold.value,
              },
            }
          : {}),
        recovery: {
          manifest: recovery.manifest,
          sourceRef: recovery.ref,
          sourceStorageHash: recovery.storageHash,
        },
        createdAt: runtime.dependencies.now(),
      }),
    attemptSignal,
  )
  await withinTaskDeadline(
    deadlineAt,
    "context-persistence",
    () => persistContextBundle(runtime.runLayout, attemptId, context),
    attemptSignal,
  )
  persistAppliedContextRotation(
    runtime,
    initialContextRotation,
    "next-task",
    attemptId,
    context.manifest.contentHash,
  )

  if (recovery.manifest.requiresOperatorDecision && !recovery.manifest.expectedWorkspaceHash) {
    throw new RalphError(
      "RALPH_RECOVERY_EXPECTED_HASH_MISSING",
      "A workspace-change decision is missing its expected workspace hash",
      { exitCode: EXIT_CODES.operationalError },
    )
  }
  const acceptanceMatches =
    recovery.manifest.requiresOperatorDecision &&
    pendingRecoveryAcceptance !== undefined &&
    recoveryDecisionMatchesObservation(pendingRecoveryAcceptance, {
      documentId: reference.documentId,
      taskId: reference.taskId,
      taskBaselineHash: recovery.manifest.taskBaselineHash,
      expectedWorkspaceHash: recovery.manifest.expectedWorkspaceHash,
      observedWorkspaceHash: recovery.manifest.observedWorkspaceHash,
    })
  let recoveryAcceptanceRecorded = false
  if (recovery.manifest.requiresOperatorDecision && acceptanceMatches) {
    const acceptance = pendingRecoveryAcceptance as PendingRecoveryDecision
    runtime.assertWriterLease()
    appendEvent(runtime.layout.ledger, {
      type: "recovery.operator_decision_accepted",
      scope: "run",
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      attemptId,
      causationId: acceptance.eventId,
      level: "warn",
      payload: RecoveryWorkspaceAcceptanceEventPayloadSchema.parse({
        schemaVersion: 1,
        action: "continue",
        source: "cli",
        decisionEventId: acceptance.eventId,
        decisionAttemptId: acceptance.attemptId,
        decisionRecoveryRef: acceptance.payload.recoveryRef,
        decisionRecoveryHash: acceptance.payload.recoveryHash,
        decisionRecoveryStorageHash: acceptance.payload.recoveryStorageHash,
        currentRecoveryRef: recovery.ref,
        currentRecoveryHash: recovery.manifest.contentHash,
        currentRecoveryStorageHash: recovery.storageHash,
        taskBaselineHash: recovery.manifest.taskBaselineHash,
        expectedWorkspaceHash: recovery.manifest.expectedWorkspaceHash,
        observedWorkspaceHash: recovery.manifest.observedWorkspaceHash,
      }),
    })
    runtime.pendingRecoveryDecision = undefined
    runtime.recoveryAcceptance = undefined
    recoveryAcceptanceRecorded = true
  } else if (!recovery.manifest.requiresOperatorDecision && pendingRecoveryDecision) {
    runtime.assertWriterLease()
    appendEvent(runtime.layout.ledger, {
      type: "recovery.operator_decision_obsolete",
      scope: "run",
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      attemptId,
      causationId: pendingRecoveryDecision.eventId,
      level: "info",
      payload: RecoveryDecisionObsoleteEventPayloadSchema.parse({
        schemaVersion: 1,
        decisionEventId: pendingRecoveryDecision.eventId,
        decisionAttemptId: pendingRecoveryDecision.attemptId,
        decisionRecoveryHash: pendingRecoveryDecision.payload.recoveryHash,
        currentRecoveryRef: recovery.ref,
        currentRecoveryHash: recovery.manifest.contentHash,
        currentRecoveryStorageHash: recovery.storageHash,
        currentState: recovery.manifest.state,
        reason: "workspace-no-longer-requires-decision",
      }),
    })
    runtime.pendingRecoveryDecision = undefined
    runtime.recoveryAcceptance = undefined
  }

  let counters = AttemptCountersSchema.parse({
    ...EMPTY_COUNTERS,
    revisionAttempts: revision ? 1 : 0,
  })
  let attempt = createAttempt(runtime.layout.ledger, {
    id: attemptId,
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
    ordinal,
    phase: "created",
    status: "active",
    contextManifestHash: context.manifest.contentHash,
    baseline,
    effectiveOptionsHash: runtime.options.contentHash,
    effectiveOptions: runtime.options,
    counters,
    event: { type: "attempt.created" },
  })
  let taskRecord = getRunTask(
    runtime.layout.ledger,
    runtime.run.id,
    reference.documentId,
    reference.taskId,
  ) as RunTaskRecord
  taskRecord = upsertRunTask(runtime.layout.ledger, {
    runId: taskRecord.runId,
    documentId: taskRecord.documentId,
    taskId: taskRecord.taskId,
    status: taskRecord.status,
    markerContentHash: taskRecord.markerContentHash,
    activeAttemptId: attemptId,
    event: { type: "attempt.activated" },
  })
  if (recovery.manifest.requiresOperatorDecision && !recoveryAcceptanceRecorded) {
    runtime.assertWriterLease()
    transitionStoredAttemptStatus(runtime.layout.ledger, attempt, "interrupted", {
      finishedAt: runtime.dependencies.now(),
      eventType: "attempt.recovery_decision_required",
    })
    transitionStoredTask(runtime.layout.ledger, taskRecord, "interrupted", {
      activeAttemptId: null,
      eventType: "task.workspace_changed",
    })
    appendEvent(runtime.layout.ledger, {
      type: "recovery.operator_decision_required",
      scope: "run",
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      attemptId,
      ...(pendingRecoveryDecision ? { causationId: pendingRecoveryDecision.eventId } : {}),
      level: "warn",
      payload: RecoveryDecisionRequiredEventPayloadSchema.parse({
        schemaVersion: 1,
        recoveryRef: recovery.ref,
        recoveryHash: recovery.manifest.contentHash,
        recoveryStorageHash: recovery.storageHash,
        taskBaselineHash: recovery.manifest.taskBaselineHash,
        expectedWorkspaceHash: recovery.manifest.expectedWorkspaceHash,
        observedWorkspaceHash: recovery.manifest.observedWorkspaceHash,
        ...(pendingRecoveryDecision
          ? { supersedesDecisionEventId: pendingRecoveryDecision.eventId }
          : {}),
        availableActions: recovery.manifest.availableActions,
        recommendedAction: recovery.manifest.recommendedAction,
      }),
    })
    return {
      status: "blocked",
      exitCode: EXIT_CODES.conflict,
      reason:
        "Workspace changed outside the expected observation; inspect it with status run, checkpoint separately, continue with --accept-workspace-changes, or use a separate explicit rollback command",
      stopRun: true,
    }
  }
  attempt = transitionStoredAttemptPhase(runtime.layout.ledger, attempt, "preparing")
  attempt = transitionStoredAttemptPhase(runtime.layout.ledger, attempt, "invoking")
  beginWatchdogPhase(watchdog, "model-call", deadlineAt)
  watchdog.start()

  let executorOutcome: ExecutorOutcome | undefined
  let previousAssessmentRef: string | undefined = revision?.previousAssessmentRef
  const intermediateGateMutations: Array<{
    callOrdinal: number
    changed: string[]
    diffRef: string
  }> = []

  try {
    for (let callOrdinal = 1; callOrdinal <= maxCalls; callOrdinal += 1) {
      if (callOrdinal > 1) {
        if (counters.modelCalls >= runtime.options.maxModelCallsPerAttempt.value) {
          throw new RalphError(
            "RALPH_MODEL_CALL_BUDGET_EXCEEDED",
            `Model call budget was exhausted at ${runtime.options.maxModelCallsPerAttempt.value}`,
            {
              exitCode: EXIT_CODES.budgetExceeded,
              details: { attemptId, modelCalls: counters.modelCalls },
            },
          )
        }
        const dependencyOutputs = await withinTaskDeadline(
          deadlineAt,
          "wiggum-dependency-context",
          () => dependencyOutputsFor(runtime, reference),
          attemptSignal,
        )
        const contextRotation = takeSupervisorContextRotation(runtime, "next-model-call")
        context = await withinTaskDeadline(
          deadlineAt,
          "wiggum-context-build",
          () =>
            buildContextManifest({
              graph: runtime.graph,
              task: reference,
              runId: runtime.run.id,
              attemptId,
              mode,
              baseline,
              budget: contextBudget(task, runtime.options, mode, modelLimits, consumedModelUsage, {
                modelCalls: Math.max(
                  0,
                  runtime.options.maxModelCallsPerAttempt.value - counters.modelCalls,
                ),
                iterations: maxCalls - callOrdinal + 1,
                ...(deadlineAt ? { deadlineAt } : {}),
              }),
              workspaceRoot: executionWorkspace(runtime),
              dependencyOutputs,
              ...(contextRotation
                ? {
                    contextRotation: {
                      ...contextRotation,
                      boundary: "next-model-call" as const,
                    },
                  }
                : {}),
              additionalInvariants: forcedDependencyInvariants(runtime, reference),
              ...(previousAssessmentRef ? { previousAssessmentRef } : {}),
              ...(revision
                ? {
                    revisionFeedback: {
                      assessment: revision.previousAssessment,
                      assessmentRef: revision.previousAssessmentRef,
                      threshold: runtime.options.judgeThreshold.value,
                    },
                  }
                : {}),
              recovery: {
                manifest: recovery.manifest,
                sourceRef: recovery.ref,
                sourceStorageHash: recovery.storageHash,
              },
              createdAt: runtime.dependencies.now(),
            }),
          attemptSignal,
        )
        await withinTaskDeadline(
          deadlineAt,
          "wiggum-context-persistence",
          () => persistContextBundle(runtime.runLayout, attemptId, context, callOrdinal),
          attemptSignal,
        )
        persistAppliedContextRotation(
          runtime,
          contextRotation,
          "next-model-call",
          attemptId,
          context.manifest.contentHash,
        )
        attempt = updateAttempt(runtime.layout.ledger, {
          attemptId,
          contextManifestHash: context.manifest.contentHash,
          event: {
            type: "wiggum.context.rebuilt",
            payload: { callOrdinal, previousAssessmentRef },
          },
        })
      }
      beginWatchdogPhase(watchdog, "model-call", deadlineAt)
      const modelCallId = runtime.dependencies.id("model-call")
      createModelCall(runtime.layout.ledger, {
        id: modelCallId,
        attemptId,
        ordinal: counters.modelCalls + 1,
        contextManifestHash: context.manifest.contentHash,
        requestHash: hashCanonicalValue("ralph.execution.model-call-request.v1", {
          contextManifestHash: context.manifest.contentHash,
          backendId: backend.id,
          backendCapabilities,
          backendLimits,
          effectiveModelUsageLimits: modelLimits,
          executorProfile: runtime.options.executorProfile.value,
          effectiveOptionsHash: runtime.options.contentHash,
          maximumModelCalls: runtime.options.maxModelCallsPerAttempt.value,
          maximumToolCalls: task.budget?.maxToolCallsPerModelCall ?? 0,
          callOrdinal,
        }),
        startedAt: runtime.dependencies.now(),
        event: { type: "model.call.started" },
      })
      let handle: Awaited<ReturnType<typeof backend.start>> | undefined
      let channel: ReturnType<typeof backendChannel> | undefined
      try {
        const request = {
          runId: runtime.run.id,
          documentId: reference.documentId,
          taskId: reference.taskId,
          attemptId,
          modelCallId,
          callOrdinal,
          workspaceRoot: executionWorkspace(runtime),
          contextManifest: context.manifest,
          contextBundle: context,
          task,
          protectedPaths: protectedDefinitionPaths(runtime),
          ...(deadlineAt ? { deadlineAt } : {}),
          signal: watchdog.signal,
        }
        const executionChannel = backendChannel(
          runtime,
          reference,
          attemptId,
          modelCallId,
          request.protectedPaths,
          Math.max(0, runtime.options.maxModelCallsPerAttempt.value - counters.modelCalls),
          task.budget?.maxToolCallsPerModelCall ?? 0,
          modelLimits,
          consumedModelUsage,
          backendCapabilities.usage,
          watchdog,
          watchdog.signal,
          deadlineAt,
        )
        channel = executionChannel
        handle = await awaitBackendStart({
          backend,
          start: () => backend.start(request, executionChannel),
          ...(deadlineAt ? { deadlineAt } : {}),
          signal: watchdog.signal,
          onLateHandle: (lateHandle) =>
            observeLateModelCallSettlement(runtime, modelCallId, lateHandle),
        })
        const backendOutcome = await awaitBackendOutcome({
          backend,
          handle,
          ...(deadlineAt ? { deadlineAt } : {}),
          signal: watchdog.signal,
        })
        executionChannel.assertUsageSettled()
        executorOutcome = persistenceSafe(runtime, backendOutcome)
        if (!watchdog.signal.aborted) {
          watchdog.recordProvider({
            pending: "no",
            streamOpen: "no",
            progress: true,
            settlement: "settled",
          })
        }
        updateModelCall(runtime.layout.ledger, {
          modelCallId,
          status: "succeeded",
          outcome: executorOutcome,
          finishedAt: runtime.dependencies.now(),
          event: { type: "model.call.finished", payload: { backendCallId: handle.id } },
        })
      } catch (error) {
        const unsettled = cancellationLeftModelCallUnsettled(error)
        let effectiveError: unknown = error
        if (!unsettled && channel) {
          try {
            channel.assertUsageSettled({ requireReservation: false })
          } catch (settlementError) {
            appendEvent(runtime.layout.ledger, {
              type: "model.usage.settlement.failed",
              scope: "run",
              streamId: runtime.run.id,
              workspaceId: runtime.workspaceId,
              runId: runtime.run.id,
              documentId: reference.documentId,
              taskId: reference.taskId,
              attemptId,
              callId: modelCallId,
              level: "error",
              payload: persistenceSafe(runtime, {
                reason:
                  settlementError instanceof Error
                    ? settlementError.message
                    : String(settlementError),
                backendFailure: error instanceof Error ? error.message : String(error),
              }),
            })
            if (!isExecutionCancelled(error) && !isExecutionDeadlineExceeded(error)) {
              effectiveError = settlementError
            }
          }
        }
        if (!watchdog.signal.aborted && !unsettled) {
          watchdog.recordProvider({
            pending: "no",
            streamOpen: "no",
            progress: true,
            settlement: "settled",
          })
        }
        if (unsettled) {
          if (handle) observeLateModelCallSettlement(runtime, modelCallId, handle)
          appendEvent(runtime.layout.ledger, {
            type: "model.call.unsettled",
            scope: "run",
            streamId: runtime.run.id,
            workspaceId: runtime.workspaceId,
            runId: runtime.run.id,
            documentId: reference.documentId,
            taskId: reference.taskId,
            attemptId,
            callId: modelCallId,
            level: "error",
            payload: persistenceSafe(runtime, {
              reason: error instanceof Error ? error.message : String(error),
              resumeBlocked: true,
              ...(isExecutionDeadlineExceeded(error)
                ? { deadline: error.diagnostic.details ?? {} }
                : {}),
            }),
          })
        } else {
          updateModelCall(runtime.layout.ledger, {
            modelCallId,
            status:
              isExecutionDeadlineExceeded(error) || isExecutionCancelled(error)
                ? "cancelled"
                : "failed",
            finishedAt: runtime.dependencies.now(),
            event: {
              type: "model.call.finished",
              level: "error",
              payload: {
                reason:
                  effectiveError instanceof Error ? effectiveError.message : String(effectiveError),
                ...(effectiveError === error
                  ? {}
                  : {
                      backendFailure: error instanceof Error ? error.message : String(error),
                    }),
              },
            },
          })
        }
        const failedStats = channel?.stats()
        const durableAttempt = getAttempt(runtime.layout.ledger, attemptId)
        if (!durableAttempt) {
          throw new RalphError(
            "RALPH_ATTEMPT_NOT_FOUND",
            `Attempt disappeared while accounting a failed backend call: ${attemptId}`,
            { exitCode: EXIT_CODES.operationalError },
          )
        }
        counters = AttemptCountersSchema.parse({
          ...durableAttempt.counters,
          modelCalls:
            durableAttempt.counters.modelCalls + Math.max(0, (failedStats?.modelCalls ?? 1) - 1),
          toolCalls: durableAttempt.counters.toolCalls + (failedStats?.toolCalls ?? 0),
        })
        attempt = updateAttempt(runtime.layout.ledger, {
          attemptId,
          counters,
          event: {
            type: "attempt.failed_backend_usage.accounted",
            payload: {
              modelCallId,
              modelCalls: Math.max(1, failedStats?.modelCalls ?? 1),
              toolCalls: failedStats?.toolCalls ?? 0,
              callOrdinal,
            },
          },
        })
        throw effectiveError
      }
      const channelStats = channel?.stats()
      consumedModelUsage = addUsage(
        consumedModelUsage,
        channel?.currentUsage() ?? emptyAccountedUsage(),
      )
      counters = AttemptCountersSchema.parse({
        ...counters,
        modelCalls: counters.modelCalls + Math.max(1, channelStats?.modelCalls ?? 1),
        toolCalls: counters.toolCalls + (channelStats?.toolCalls ?? 0),
        wiggumIterations:
          counters.wiggumIterations + (runtime.options.mode.value === "wiggum" ? 1 : 0),
      })
      attempt = updateAttempt(runtime.layout.ledger, {
        attemptId,
        counters,
        executorOutcome,
        event: {
          type: "attempt.model_call.accounted",
          payload: { backendCallId: handle.id, callOrdinal },
        },
      })
      const afterCall = await withinTaskDeadline(
        deadlineAt,
        "post-call-baseline",
        () =>
          captureWorkspaceBaseline(executionWorkspace(runtime), {
            scope: document.workspace,
            retentionPriorityPaths: priorityPaths,
            objectStore: { directory: runtime.runLayout.artifacts },
            storageRoot: runtime.workspaceRoot,
          }),
        attemptSignal,
      )
      let continueWiggum = false
      if (mode === "wiggum" && callOrdinal < maxCalls) {
        attempt = transitionStoredAttemptPhase(runtime.layout.ledger, attempt, "settling")
        appendEvent(runtime.layout.ledger, {
          type: "wiggum.iteration.verifying",
          scope: "run",
          streamId: runtime.run.id,
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          documentId: reference.documentId,
          taskId: reference.taskId,
          attemptId,
          payload: { callOrdinal, contextManifestHash: context.manifest.contentHash },
        })
        beginWatchdogPhase(watchdog, "gate", deadlineAt)
        watchdog.recordGate({ alive: "yes", activity: "yes", progress: true })
        let iterationVerifications: Awaited<ReturnType<typeof runVerifications>>
        try {
          iterationVerifications = await withinTaskDeadline(
            deadlineAt,
            "wiggum-intermediate-gates",
            () =>
              runVerifications(task.verification, {
                workspaceRoot: executionWorkspace(runtime),
                ...(runtime.dependencies.gateRegistryFactory
                  ? {
                      registry: gateRegistryFor(
                        runtime,
                        reference,
                        attemptId,
                      ) as GateExecutorRegistry,
                    }
                  : {}),
                signal: watchdog.signal,
                environment: runtime.environment,
                environmentRoot: join(
                  runtime.runLayout.root,
                  "environment",
                  attemptId,
                  `call-${callOrdinal}`,
                ),
                ...(deadlineAt ? { deadlineAt } : {}),
                skipTests: runtime.options.skipTests.value,
                skipLint: runtime.options.skipLint.value,
                skipGateIdsOrCategories: new Set(runtime.options.skipGates.value),
                noGates: runtime.options.noGates.value,
                fast: runtime.options.fast.value,
                force: runtime.options.force.value,
                failFast: runtime.options.failFast.value,
                persistOutput: (gateId, stream, value) =>
                  persistGateOutput(runtime, attemptId, gateId, stream, value),
              }),
            watchdog.signal,
          )
        } finally {
          if (!watchdog.signal.aborted) {
            watchdog.recordGate({
              alive: "no",
              activity: "no",
              progress: true,
              settlement: "settled",
            })
          }
        }
        assertVerificationDeadline(deadlineAt, "wiggum-intermediate-gates", iterationVerifications)
        const iterationArtifacts = await withinTaskDeadline(
          deadlineAt,
          "wiggum-intermediate-artifacts",
          () =>
            collectArtifactEvidence(executionWorkspace(runtime), task.verification, {
              objectStore: { directory: runtime.runLayout.artifacts },
              storageRoot: runtime.workspaceRoot,
            }),
          attemptSignal,
        )
        const afterIterationGates = await withinTaskDeadline(
          deadlineAt,
          "wiggum-post-gate-baseline",
          () =>
            captureWorkspaceBaseline(executionWorkspace(runtime), {
              scope: document.workspace,
              retentionPriorityPaths: priorityPaths,
              objectStore: { directory: runtime.runLayout.artifacts },
              storageRoot: runtime.workspaceRoot,
            }),
          attemptSignal,
        )
        const cumulativeIterationChanges = compareWorkspaceBaselines(
          attemptWorkspaceBaseline,
          afterIterationGates,
        )
        const gateMutation = compareWorkspaceBaselines(afterCall, afterIterationGates)
        if (gateMutation.hasChanges) {
          const gateDiff = await withinTaskDeadline(
            deadlineAt,
            "wiggum-gate-diff",
            () =>
              persistWorkspaceDiff(
                runtime,
                attemptId,
                "gate",
                afterCall,
                afterIterationGates,
                gateMutation,
              ),
            attemptSignal,
          )
          intermediateGateMutations.push({
            callOrdinal,
            changed: [...gateMutation.changed],
            diffRef: gateDiff.diffRef,
          })
        }
        const blockingFailure = iterationVerifications.some(isBlockingVerificationFailure)
        const artifactFailure = iterationArtifacts.some((artifact) => artifact.status === "failed")
        const noChangeNeedsRevision =
          !cumulativeIterationChanges.hasChanges &&
          runtime.options.noChangePolicy.value !== "allow-no-change"
        const terminalFailure =
          executorOutcome?.status === "blocked_reported" ||
          gateMutation.hasChanges ||
          cumulativeIterationChanges.outsideScope.length > 0
        continueWiggum =
          !terminalFailure && (blockingFailure || artifactFailure || noChangeNeedsRevision)
        counters = AttemptCountersSchema.parse({
          ...counters,
          gateRuns: counters.gateRuns + iterationVerifications.length,
          noChangeAttempts:
            counters.noChangeAttempts + (!cumulativeIterationChanges.hasChanges ? 1 : 0),
        })
        previousAssessmentRef = await withinTaskDeadline(
          deadlineAt,
          "wiggum-assessment-persistence",
          () =>
            persistWiggumAssessment(runtime, reference, attemptId, callOrdinal, {
              contextManifestHash: context.manifest.contentHash,
              workspaceSnapshotHash: afterIterationGates.snapshotHash,
              blockingFailure,
              artifactFailure,
              noChangeNeedsRevision,
              terminalFailure,
              continueWiggum,
              ...(gateMutation.hasChanges
                ? {
                    gateMutation: {
                      changed: gateMutation.changed,
                      diffRef: intermediateGateMutations.at(-1)?.diffRef,
                    },
                  }
                : {}),
              gates: iterationVerifications.map((gate) => ({ ...gate })),
              artifacts: iterationArtifacts.map((artifact) => ({
                artifactId: artifact.artifactId,
                status: artifact.status,
                ...(artifact.reason ? { reason: artifact.reason } : {}),
              })),
            }),
          attemptSignal,
        )
        attempt = updateAttempt(runtime.layout.ledger, {
          attemptId,
          counters,
          event: {
            type: "wiggum.iteration.accounted",
            payload: { callOrdinal, continueWiggum, previousAssessmentRef },
          },
        })
      }
      if (!continueWiggum) break
      attempt = transitionStoredAttemptPhase(runtime.layout.ledger, attempt, "invoking")
    }
  } catch (error) {
    attempt = transitionStoredAttemptStatus(runtime.layout.ledger, attempt, "interrupted", {
      finishedAt: runtime.dependencies.now(),
      eventType: "attempt.interrupted",
    })
    const currentTask = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      reference.documentId,
      reference.taskId,
    )
    if (currentTask && currentTask.status === "active") {
      transitionStoredTask(runtime.layout.ledger, currentTask, "interrupted", {
        eventType: "task.interrupted",
      })
    }
    throw error
  }

  attempt = transitionStoredAttemptPhase(runtime.layout.ledger, attempt, "settling")
  attempt = transitionStoredAttemptPhase(runtime.layout.ledger, attempt, "evidence")
  const preGateBaseline = await withinTaskDeadline(
    deadlineAt,
    "pre-gate-baseline",
    () =>
      captureWorkspaceBaseline(executionWorkspace(runtime), {
        scope: document.workspace,
        retentionPriorityPaths: priorityPaths,
        objectStore: { directory: runtime.runLayout.artifacts },
        storageRoot: runtime.workspaceRoot,
      }),
    attemptSignal,
  )
  const executorAttemptDelta = compareWorkspaceBaselines(attemptWorkspaceBaseline, preGateBaseline)
  const noChangeThisAttempt = !executorAttemptDelta.hasChanges
  const shouldRetryNoChange =
    noChangeThisAttempt && runtime.options.noChangePolicy.value === "retry-on-no-change"
  const deterministicNoChangeFailure =
    noChangeThisAttempt &&
    (runtime.options.noChangePolicy.value === "require-change" ||
      runtime.options.noChangePolicy.value === "fail-on-no-change")

  taskRecord = transitionStoredTask(runtime.layout.ledger, taskRecord, "verifying", {
    activeAttemptId: attemptId,
    eventType: "task.verifying",
  })
  attempt = transitionStoredAttemptPhase(runtime.layout.ledger, attempt, "gates")
  beginWatchdogPhase(watchdog, "gate", deadlineAt)
  watchdog.recordGate({ alive: "yes", activity: "yes", progress: true })
  let verificationResults: Awaited<ReturnType<typeof runVerifications>>
  try {
    verificationResults =
      shouldRetryNoChange || deterministicNoChangeFailure
        ? []
        : await withinTaskDeadline(
            deadlineAt,
            "final-gates",
            () =>
              runVerifications(task.verification, {
                workspaceRoot: executionWorkspace(runtime),
                ...(runtime.dependencies.gateRegistryFactory
                  ? {
                      registry: gateRegistryFor(
                        runtime,
                        reference,
                        attemptId,
                      ) as GateExecutorRegistry,
                    }
                  : {}),
                signal: watchdog.signal,
                environment: runtime.environment,
                environmentRoot: join(runtime.runLayout.root, "environment", attemptId),
                ...(deadlineAt ? { deadlineAt } : {}),
                skipTests: runtime.options.skipTests.value,
                skipLint: runtime.options.skipLint.value,
                skipGateIdsOrCategories: new Set(runtime.options.skipGates.value),
                noGates: runtime.options.noGates.value,
                fast: runtime.options.fast.value,
                force: runtime.options.force.value,
                failFast: runtime.options.failFast.value,
                changedPaths: new Set(executorAttemptDelta.changed),
                persistOutput: (gateId, stream, value) =>
                  persistGateOutput(runtime, attemptId, gateId, stream, value),
              }),
            watchdog.signal,
          )
  } finally {
    if (!watchdog.signal.aborted) {
      watchdog.recordGate({
        alive: "no",
        activity: "no",
        progress: true,
        settlement: "settled",
      })
    }
  }
  // The persisted task baseline spans every attempt, including work left by a
  // failed attempt, an accepted recovery, or a watchdog restart. Checking only
  // the current attempt delta would let a forbidden PRD mutation survive into a
  // later attempt unchanged and then disappear from this security decision.
  const adHocCumulativeDelta = compareWorkspaceBaselines(taskBaseline, preGateBaseline)
  const adHocPrdMutations = await withinTaskDeadline(
    deadlineAt,
    "ad-hoc-prd-protection",
    () => adHocPrdMutationPaths(runtime, adHocCumulativeDelta.changed),
    attemptSignal,
  )
  if (adHocPrdMutations.length > 0) {
    verificationResults.push({
      gateId: "ralph.ad-hoc-prd-protection",
      category: "security",
      blocking: true,
      status: "failed",
      durationMs: 0,
      outputRefs: [],
      reason: `Ad-hoc execution changed or created protected PRD content: ${adHocPrdMutations.join(", ")}`,
      overridden: false,
    })
  }
  assertVerificationDeadline(deadlineAt, "final-gates", verificationResults)
  if (deterministicNoChangeFailure) {
    verificationResults.push({
      gateId: "ralph.attempt-change-required",
      category: "security",
      blocking: true,
      status: "failed",
      durationMs: 0,
      outputRefs: [],
      reason: `The current attempt produced no permitted change under ${runtime.options.noChangePolicy.value}`,
      overridden: false,
    })
  }
  const artifacts = await withinTaskDeadline(
    deadlineAt,
    "artifact-collection",
    () =>
      collectArtifactEvidence(executionWorkspace(runtime), task.verification, {
        objectStore: { directory: runtime.runLayout.artifacts },
        storageRoot: runtime.workspaceRoot,
      }),
    attemptSignal,
  )
  const finalBaseline = await withinTaskDeadline(
    deadlineAt,
    "final-baseline",
    () =>
      captureWorkspaceBaseline(executionWorkspace(runtime), {
        scope: document.workspace,
        retentionPriorityPaths: priorityPaths,
        objectStore: { directory: runtime.runLayout.artifacts },
        storageRoot: runtime.workspaceRoot,
      }),
    attemptSignal,
  )
  const gateMutation = compareWorkspaceBaselines(preGateBaseline, finalBaseline)
  if (gateMutation.hasChanges) {
    const gateDiff = await withinTaskDeadline(
      deadlineAt,
      "gate-diff",
      () =>
        persistWorkspaceDiff(
          runtime,
          attemptId,
          "gate",
          preGateBaseline,
          finalBaseline,
          gateMutation,
        ),
      attemptSignal,
    )
    verificationResults.push({
      gateId: "ralph.workspace-stability",
      category: "security",
      blocking: true,
      status: "failed",
      durationMs: 0,
      outputRefs: [gateDiff.diffRef],
      reason: `Verification commands changed the workspace: ${gateMutation.changed.join(", ")}`,
      overridden: false,
    })
  }
  if (intermediateGateMutations.length > 0) {
    const occurrences = intermediateGateMutations.map(
      (mutation) =>
        `call ${mutation.callOrdinal} (${mutation.changed.join(", ") || "unknown paths"})`,
    )
    verificationResults.push({
      gateId: "ralph.workspace-stability.wiggum-intermediate",
      category: "security",
      blocking: true,
      status: "failed",
      durationMs: 0,
      outputRefs: intermediateGateMutations.map((mutation) => mutation.diffRef),
      reason: `Intermediate Wiggum verification commands changed the workspace: ${occurrences.join("; ")}`,
      overridden: false,
    })
  }
  for (const artifact of artifacts) {
    if (artifact.status === "failed") {
      verificationResults.push({
        gateId: `ralph.artifact-collection.${artifact.artifactId}`,
        category: "artifact",
        blocking: true,
        status: "failed",
        durationMs: 0,
        outputRefs: [],
        reason: artifact.reason ?? `Artifact could not be frozen: ${artifact.path}`,
        overridden: false,
      })
      continue
    }
    const snapshot = finalBaseline.files[artifact.path]
    if (
      snapshot?.kind !== "file" ||
      snapshot.sha256 !== artifact.contentHash ||
      snapshot.size !== artifact.sizeBytes ||
      snapshot.contentRef !== artifact.immutableRef
    ) {
      verificationResults.push({
        gateId: `ralph.artifact-integrity.${artifact.artifactId}`,
        category: "artifact",
        blocking: true,
        status: "failed",
        durationMs: 0,
        outputRefs: artifact.immutableRef ? [artifact.immutableRef] : [],
        reason: `Artifact changed between immutable capture and the final workspace snapshot: ${artifact.path}`,
        overridden: false,
      })
    }
  }

  const cumulativeChanges = compareWorkspaceBaselines(taskBaseline, finalBaseline)
  const attemptDelta = compareWorkspaceBaselines(attemptWorkspaceBaseline, finalBaseline)
  const taskDiff = await withinTaskDeadline(
    deadlineAt,
    "task-diff",
    () =>
      persistWorkspaceDiff(
        runtime,
        attemptId,
        "task",
        taskBaseline,
        finalBaseline,
        cumulativeChanges,
      ),
    attemptSignal,
  )
  const attemptDiff = await withinTaskDeadline(
    deadlineAt,
    "attempt-diff",
    () =>
      persistWorkspaceDiff(
        runtime,
        attemptId,
        "attempt",
        attemptWorkspaceBaseline,
        finalBaseline,
        attemptDelta,
      ),
    attemptSignal,
  )
  const missingContent = [taskDiff, attemptDiff]
    .flatMap((diff) => diff.missingContent)
    .filter(
      (item, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.path === item.path &&
            candidate.side === item.side &&
            candidate.reason === item.reason,
        ) === index,
    )
  const taskChangeEvidence = changeEvidenceFromWorkspace(
    cumulativeChanges,
    finalBaseline,
    runtime.options.noChangePolicy.value,
    {
      diffHash: taskDiff.diffHash,
      diffRef: taskDiff.diffRef,
      reproducible: taskDiff.reproducible && attemptDiff.reproducible,
      missingContent,
    },
  )
  const changeEvidence = ChangeEvidenceSchema.parse({
    ...taskChangeEvidence,
    attemptDiffHash: attemptDiff.diffHash,
    attemptDiffRef: attemptDiff.diffRef,
  })
  const gates = verificationResults.map(gateResultFromVerification)
  assertExecutionDeadline(deadlineAt, "evidence-persistence")
  assertExecutionNotCancelled(attemptSignal, "evidence-persistence")
  for (const gate of gates) {
    persistGateResult(runtime.layout.ledger, {
      attemptId,
      gateId: gate.gateId,
      result: gate,
      event: {
        type: gate.status.startsWith("skipped") ? "gate.skipped" : "gate.completed",
        payload: persistenceSafe(runtime, {
          status: gate.status,
          category: gate.category,
          blocking: gate.blocking,
          durationMs: gate.durationMs,
          ...(gate.attempts !== undefined ? { attempts: gate.attempts } : {}),
          ...(gate.reason ? { reason: gate.reason } : {}),
        }),
      },
    })
  }
  counters = AttemptCountersSchema.parse({
    ...counters,
    gateRuns: counters.gateRuns + gates.length,
    noChangeAttempts: counters.noChangeAttempts + (noChangeThisAttempt ? 1 : 0),
  })
  attempt = updateAttempt(runtime.layout.ledger, {
    attemptId,
    counters,
    event: {
      type: "attempt.gates.accounted",
      payload: {
        gateRuns: gates.length,
        noChangeAttempt: noChangeThisAttempt,
      },
    },
  })
  await withinTaskDeadline(
    deadlineAt,
    "gate-persistence-fault-boundary",
    () => Promise.resolve(runtime.dependencies.fault("after-gates-persisted")),
    attemptSignal,
  )
  const contextTruncations: EvidenceTruncation[] = context.truncations.map((notice) => ({
    source: "context",
    field: notice.field,
    reason: notice.reason,
    originalHash: notice.originalHash,
    ...(notice.originalBytes !== undefined ? { originalBytes: notice.originalBytes } : {}),
    ...(notice.includedBytes !== undefined ? { includedBytes: notice.includedBytes } : {}),
    ...(notice.originalCount !== undefined ? { originalCount: notice.originalCount } : {}),
    ...(notice.includedCount !== undefined ? { includedCount: notice.includedCount } : {}),
  }))
  const contextMissingEvidence: MissingEvidence[] = context.truncations.map((notice) => ({
    source: "context",
    code: "context-truncated",
    message: `Context field ${notice.field} was truncated by ${notice.reason}`,
    blocking: false,
  }))
  const previousAttempts = listAttempts(runtime.layout.ledger, {
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
  })
    .filter((candidate) => candidate.id !== attemptId)
    .map((candidate) => ({
      attemptId: candidate.id,
      ordinal: candidate.ordinal,
      status: candidate.status,
      ...(candidate.evidenceBundleId ? { evidenceBundleId: candidate.evidenceBundleId } : {}),
      ...(candidate.completionDecision
        ? { completionStatus: candidate.completionDecision.status }
        : {}),
    }))
  const evidence = buildEvidenceBundle({
    id: runtime.dependencies.id("evidence"),
    runId: runtime.run.id,
    documentId: reference.documentId,
    task,
    taskSnapshot: context.manifest.task,
    attemptId,
    baseline: gitBaselineFromWorkspace(taskBaseline),
    changes: changeEvidence,
    artifacts,
    gates,
    ...(executorOutcome ? { executorOutcome } : {}),
    context: {
      manifestHash: context.manifest.contentHash,
      manifestRef: `context:${context.manifest.contentHash}`,
      mode,
      ...(context.manifest.previousAssessmentRef
        ? { previousAssessmentRef: context.manifest.previousAssessmentRef }
        : {}),
    },
    limits: evidenceLimits(runtime, task, modelLimits, deadlineAt),
    toolCalls: toolCallEvidence(runtime, attemptId),
    profile: evidenceProfileSnapshot(runtime, backend, backendLimits),
    usage: attemptUsageEvidence(runtime, attemptId),
    priorAttempts: previousAttempts,
    priorAssessments: [
      ...(revision
        ? [
            {
              kind: revision.previousAssessment.kind,
              ref: revision.previousAssessmentRef,
            } as const,
          ]
        : []),
      ...(context.manifest.previousAssessmentRef &&
      context.manifest.previousAssessmentRef !== revision?.previousAssessmentRef
        ? [{ kind: "executor" as const, ref: context.manifest.previousAssessmentRef }]
        : []),
    ],
    security: {
      mode: runtime.options.securityMode.value,
      headlessAsk: runtime.options.headlessAsk.value,
      allowShell: runtime.options.allowShell.value,
      interactive: runtime.interactive,
      allowedCommandCount: runtime.options.allowedCommands.value.length,
      readPaths: runtime.options.readPaths.value,
      writePaths: runtime.options.writePaths.value,
      toolRuleCount: Object.keys(runtime.options.toolRules.value).length,
      diagnostics: [],
    },
    truncations: contextTruncations,
    missingEvidence: contextMissingEvidence,
    createdAt: runtime.dependencies.now(),
  })
  const evidenceStorage = await withinTaskDeadline(
    deadlineAt,
    "evidence-object-persistence",
    () => persistEvidenceBundleObject(runtime.workspaceRoot, runtime.runLayout, evidence),
    attemptSignal,
  )
  persistEvidenceBundle(runtime.layout.ledger, {
    id: evidence.id,
    attemptId,
    contentHash: evidence.contentHash,
    bundle: evidence,
    storage: evidenceStorage,
    event: { type: "evidence.collected" },
  })
  assertExecutionDeadline(deadlineAt, "completion-decision")
  assertExecutionNotCancelled(attemptSignal, "completion-decision")
  taskRecord = transitionStoredTask(runtime.layout.ledger, taskRecord, "evaluating", {
    activeAttemptId: attemptId,
    eventType: "task.evaluating",
  })

  const overriddenGateIds = verificationResults
    .filter((gate) => gate.overridden)
    .map((gate) => gate.gateId)
  let evaluation = decideDeterministicCompletion({
    task,
    evidence,
    overrideGateIds: new Set(overriddenGateIds),
    decidedAt: runtime.dependencies.now(),
  })
  if (shouldRetryNoChange && evaluation.decision.status === "passed") {
    evaluation = decideDeterministicCompletion({
      task,
      evidence: {
        ...evidence,
        changes: { ...evidence.changes, status: "unchanged", files: [] },
      },
      overrideGateIds: new Set(overriddenGateIds),
      decidedAt: runtime.dependencies.now(),
    })
  }
  const policy = evaluationPolicyForTask(runtime.options, task)
  let assessment: JudgeAssessment | undefined
  let assessmentRef: string | undefined
  if (evaluation.decision.status === "passed" || evaluation.decision.status === "overridden") {
    const kind = evaluationKind(policy.mode)
    if (kind && judgeEvaluation?.backend && judgeEvaluation.profileId) {
      const judgeBackend = judgeEvaluation.backend
      const judgeProfileId = judgeEvaluation.profileId
      if (judgeEvaluation.kind !== kind) {
        throw new RalphError(
          "RALPH_JUDGE_KIND_MISMATCH",
          `Resolved judge kind ${judgeEvaluation.kind} does not match evaluation mode ${kind}`,
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      attempt = transitionStoredAttemptPhase(runtime.layout.ledger, attempt, "judgment")
      beginWatchdogPhase(watchdog, "judge", deadlineAt)
      watchdog.recordJudge({ pending: "yes", progress: true })
      let judged: JudgeEvaluationResult
      try {
        judged = await withinTaskDeadline(
          deadlineAt,
          "judge-evaluation",
          () =>
            evaluateEvidence(
              runtime,
              reference,
              attemptId,
              judgeBackend,
              kind,
              judgeProfileId,
              evidence,
              context,
              watchdog.signal,
              watchdog,
              revision?.previousAssessment,
            ),
          watchdog.signal,
        )
      } finally {
        if (!watchdog.signal.aborted) {
          watchdog.recordJudge({
            pending: "no",
            streamOpen: "no",
            progress: true,
            settlement: "settled",
          })
        }
      }
      counters = AttemptCountersSchema.parse({
        ...counters,
        judgeTransportRetries: counters.judgeTransportRetries + judged.transportRetries,
      })
      assessment = judged.assessment
      assessmentRef = judged.assessmentRef
      if (assessment) {
        attempt = updateAttempt(runtime.layout.ledger, {
          attemptId,
          counters,
          event: {
            type: "attempt.judge.accounted",
            payload: {
              assessmentId: assessment.id,
              transportRetries: judged.transportRetries,
            },
          },
        })
        await withinTaskDeadline(
          deadlineAt,
          "judge-assessment-fault-boundary",
          () => Promise.resolve(runtime.dependencies.fault("after-judge-assessment-persisted")),
          attemptSignal,
        )
      }
      evaluation = assessment
        ? {
            ...evaluation,
            decision: decideAssessedCompletion({
              deterministicDecision: evaluation.decision,
              assessment,
              policy,
              decidedAt: runtime.dependencies.now(),
            }),
          }
        : {
            ...evaluation,
            decision: decideUnavailableEvaluation({
              deterministicDecision: evaluation.decision,
              policy,
              reason: judged.unavailableReason ?? "Judge evaluation is unavailable",
              decidedAt: runtime.dependencies.now(),
            }),
          }
    } else if (kind || policy.mode === "manual") {
      evaluation = {
        ...evaluation,
        decision: decideUnavailableEvaluation({
          deterministicDecision: evaluation.decision,
          policy:
            policy.mode === "manual" ? { ...policy, onJudgeUnavailable: "pause" as const } : policy,
          reason:
            policy.mode === "manual"
              ? "Manual evaluation is waiting for an explicit human decision"
              : (judgeEvaluation?.unavailableReason ??
                `No ${kind ?? policy.mode} judge backend is available`),
          decidedAt: runtime.dependencies.now(),
        }),
      }
    }
  }
  await assertAttemptWatchdogHealthy(watchdog)
  watchdog.stop()
  await watchdog.whenIdle()
  assertExecutionNotCancelled(attemptSignal, "completion-decision")
  if (attempt.phase !== "decision") {
    attempt = transitionStoredAttemptPhase(runtime.layout.ledger, attempt, "decision")
  }
  attempt = updateAttempt(runtime.layout.ledger, {
    attemptId,
    counters,
    evidenceBundleId: evidence.id,
    completionDecision: evaluation.decision,
    event: {
      type: assessment ? "evaluation.decision" : "verification.decision",
      payload: assessment
        ? {
            assessmentId: assessment.id,
            assessmentRef,
            score: assessment.score,
            threshold: policy.threshold,
            decision: evaluation.decision.status,
            revisionAttempt: revision?.ordinal ?? 0,
            maxRevisionAttempts: runtime.options.maxRevisionAttempts.value,
            summary: assessment.summary,
          }
        : { evaluationMode: policy.mode },
    },
  })

  if (evaluation.decision.status === "passed" || evaluation.decision.status === "overridden") {
    assertExecutionDeadline(deadlineAt, "completion-transaction")
    return completeSelectedTask(
      runtime,
      reference,
      taskRecord,
      attemptId,
      evidence,
      evaluation,
      overriddenGateIds,
      attemptSignal,
      deadlineAt,
    )
  }

  if (evaluation.decision.status === "revision_required" && assessment && assessmentRef) {
    attempt = transitionStoredAttemptStatus(runtime.layout.ledger, attempt, "rejected", {
      finishedAt: runtime.dependencies.now(),
      eventType: "attempt.revision_required",
    })
    taskRecord = transitionStoredTask(runtime.layout.ledger, taskRecord, "retryable_failed", {
      activeAttemptId: null,
      eventType: "task.revision_required",
    })
    return {
      status: "revision_required",
      exitCode: EXIT_CODES.verificationFailed,
      reason: evaluation.decision.reasons.join("; "),
      assessment,
      assessmentRef,
    }
  }

  attempt = transitionStoredAttemptStatus(runtime.layout.ledger, attempt, "failed", {
    finishedAt: runtime.dependencies.now(),
    eventType: "attempt.finished",
  })
  taskRecord = transitionStoredTask(
    runtime.layout.ledger,
    taskRecord,
    evaluation.decision.status === "blocked" ? "blocked" : "retryable_failed",
    {
      activeAttemptId: null,
      eventType:
        evaluation.decision.status === "blocked" ? "task.blocked" : "task.verification_failed",
    },
  )
  if (evaluation.decision.status === "blocked") {
    return {
      status: "blocked",
      exitCode: EXIT_CODES.blocked,
      reason: evaluation.decision.reasons.join("; "),
    }
  }
  if (shouldRetryNoChange) {
    const exhausted =
      runtime.options.mode.value === "wiggum" ||
      noChangeOrdinal + counters.noChangeAttempts > runtime.options.maxNoChangeAttempts.value
    return {
      status: exhausted ? "limit" : "failed",
      exitCode: exhausted ? EXIT_CODES.budgetExceeded : EXIT_CODES.verificationFailed,
      reason: exhausted
        ? runtime.options.mode.value === "wiggum"
          ? `Wiggum iteration/model-call limit exhausted (${maxCalls}) without a permitted change`
          : `No-change retry limit exhausted (${runtime.options.maxNoChangeAttempts.value})`
        : "No permitted change was observed; another bounded attempt is allowed",
    }
  }
  return {
    status: "failed",
    exitCode: EXIT_CODES.verificationFailed,
    reason: evaluation.decision.reasons.join("; "),
  }
}

function settleRevisionExhaustion(
  runtime: Runtime,
  reference: TaskRef,
  assessment: JudgeAssessment,
  effectiveMaximum: number,
): TaskExecutionResult {
  const policy = evaluationPolicyForTask(runtime.options, taskFor(runtime.graph, reference))
  const current = getRunTask(
    runtime.layout.ledger,
    runtime.run.id,
    reference.documentId,
    reference.taskId,
  )
  if (!current) throw new Error("Revision-exhausted task record disappeared")
  const reason = `Judge revision budget exhausted (${effectiveMaximum}); last score ${assessment.score} is not accepted at threshold ${policy.threshold}`
  appendEvent(runtime.layout.ledger, {
    type: "evaluation.revisions.exhausted",
    scope: "run",
    streamId: runtime.run.id,
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
    level: policy.exhaustedPolicy === "manual-review" ? "warn" : "error",
    payload: persistenceSafe(runtime, {
      assessmentId: assessment.id,
      score: assessment.score,
      threshold: policy.threshold,
      baseMaximum: policy.maxRevisionAttempts,
      maximum: effectiveMaximum,
      policy: policy.exhaustedPolicy,
      summary: assessment.summary,
      adequate: assessment.adequate,
      problems: assessment.problems,
      missingEvidence: assessment.missingEvidence,
      recommendations: assessment.recommendations,
    }),
  })
  if (policy.exhaustedPolicy === "manual-review") {
    transitionStoredTask(runtime.layout.ledger, current, "blocked", {
      activeAttemptId: null,
      eventType: "task.awaiting_manual_review",
    })
    return {
      status: "blocked",
      exitCode: EXIT_CODES.blocked,
      reason,
      assessment,
    }
  }
  if (policy.exhaustedPolicy === "fail") {
    transitionStoredTask(runtime.layout.ledger, current, "rejected", {
      activeAttemptId: null,
      eventType: "task.revision_budget_failed",
    })
    return {
      status: "failed",
      exitCode: EXIT_CODES.verificationFailed,
      reason,
      assessment,
    }
  }
  if (current.status !== "retryable_failed") {
    transitionStoredTask(runtime.layout.ledger, current, "retryable_failed", {
      activeAttemptId: null,
      eventType: "task.revision_budget_stopped",
    })
  } else {
    appendEvent(runtime.layout.ledger, {
      type: "task.revision_budget_stopped",
      scope: "run",
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      level: "warn",
      payload: { alreadyRetryable: true, reason },
    })
  }
  return {
    status: "limit",
    exitCode: EXIT_CODES.budgetExceeded,
    reason,
    assessment,
    stopRun: true,
  }
}

async function executeTask(
  runtime: Runtime,
  reference: TaskRef,
  effectiveOptions: EffectiveRunOptions,
  backend: ExecutionBackend,
): Promise<TaskExecutionResult> {
  assertSandboxTerminationAllowsTask(runtime, reference)
  if (
    runtime.pendingRecoveryDecision &&
    (runtime.pendingRecoveryDecision.documentId !== reference.documentId ||
      runtime.pendingRecoveryDecision.taskId !== reference.taskId)
  ) {
    throw new RalphError(
      "RALPH_RECOVERY_PENDING_TARGET_MISMATCH",
      "The scheduler selected a task outside the unresolved workspace-change decision",
      {
        exitCode: EXIT_CODES.conflict,
        details: {
          decisionEventId: runtime.pendingRecoveryDecision.eventId,
          pendingTask: `${runtime.pendingRecoveryDecision.documentId}/${runtime.pendingRecoveryDecision.taskId}`,
          selectedTask: `${reference.documentId}/${reference.taskId}`,
        },
        hint: "Inspect `ralph-next status run`; no reconciliation or model work was started for the unrelated task.",
      },
    )
  }
  const previousOptions = runtime.options
  runtime.options = effectiveOptions
  try {
    const judgeEvaluation = await resolveJudgeEvaluation(runtime)
    const withJudgeAvailability = (result: TaskExecutionResult): TaskExecutionResult => ({
      ...result,
      judgeAvailable: judgeEvaluation?.backend !== undefined,
    })
    const document = documentFor(runtime.graph, reference.documentId)
    const priorityPaths = retentionPriorityPaths(taskFor(runtime.graph, reference))
    const taskRecordBeforeActivation = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      reference.documentId,
      reference.taskId,
    )
    const existingAttempts = listAttempts(runtime.layout.ledger, {
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
    })
    const existingAssessments = listJudgeAssessments(runtime.layout.ledger, {
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
    })
    const latestRevisionAssessment = [...existingAssessments].reverse().find((record) => {
      const assessedAttempt = getAttempt(runtime.layout.ledger, record.attemptId)
      return assessedAttempt?.completionDecision?.status === "revision_required"
    })
    await reconcileTaskToolCalls(runtime, reference)
    reconcileCallsAbandonedByDeadWriter(runtime, reference)
    const unsettledCalls = existingAttempts.flatMap((attempt) =>
      listModelCalls(runtime.layout.ledger, attempt.id).filter((call) => call.status === "started"),
    )
    if (unsettledCalls.length > 0) {
      throw new RalphError(
        "RALPH_MODEL_CALL_UNSETTLED",
        `The task still has ${unsettledCalls.length} unsettled model call(s); a concurrent retry is unsafe`,
        {
          exitCode: EXIT_CODES.interrupted,
          details: { modelCallIds: unsettledCalls.map((call) => call.id) },
          hint: "Wait for late settlement before resuming. Ralph retries only after a stale writer lease is displaced using verified process-death probes.",
        },
      )
    }
    const deadlineStart =
      taskRecordBeforeActivation &&
      taskRecordBeforeActivation.status !== "pending" &&
      taskRecordBeforeActivation.status !== "eligible"
        ? taskRecordBeforeActivation.updatedAt
        : runtime.dependencies.now()
    const deadlineAt = taskDeadlineAt(
      taskFor(runtime.graph, reference),
      existingAttempts,
      deadlineStart,
    )
    const activeAttempts = existingAttempts.filter((attempt) => attempt.status === "active")
    for (const existing of activeAttempts) {
      updateAttempt(runtime.layout.ledger, {
        attemptId: existing.id,
        status: "interrupted",
        finishedAt: runtime.dependencies.now(),
        event: { type: "attempt.reconciled.interrupted" },
      })
    }
    const taskBeforeReactivation = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      reference.documentId,
      reference.taskId,
    )
    if (
      taskBeforeReactivation &&
      (taskBeforeReactivation.status === "verifying" ||
        taskBeforeReactivation.status === "evaluating" ||
        (taskBeforeReactivation.status === "active" && activeAttempts.length > 0))
    ) {
      transitionStoredTask(runtime.layout.ledger, taskBeforeReactivation, "interrupted", {
        activeAttemptId: null,
        eventType: "task.reconciled.interrupted",
      })
    }
    await withinTaskDeadline(
      deadlineAt,
      "task-activation",
      () => activateTask(runtime, reference),
      runtime.signal,
    )
    await withinTaskDeadline(
      deadlineAt,
      "task-active-fault-boundary",
      () => Promise.resolve(runtime.dependencies.fault("after-task-active")),
      runtime.signal,
    )
    const baselineArtifact = await withinTaskDeadline(
      deadlineAt,
      "task-baseline",
      () =>
        ensureTaskBaseline({
          layout: runtime.runLayout,
          workspaceRoot: executionWorkspace(runtime),
          storageRoot: runtime.workspaceRoot,
          runId: runtime.run.id,
          documentId: reference.documentId,
          taskId: reference.taskId,
          capture: { scope: document.workspace, retentionPriorityPaths: priorityPaths },
        }),
      runtime.signal,
    )
    let ordinal =
      existingAttempts.reduce((maximum, attempt) => Math.max(maximum, attempt.ordinal), 0) + 1
    let noChangeOrdinal = existingAttempts.reduce(
      (sum, attempt) => sum + attempt.counters.noChangeAttempts,
      0,
    )
    let revisionsUsed = existingAttempts.reduce(
      (sum, attempt) => sum + attempt.counters.revisionAttempts,
      0,
    )
    const effectiveRevisionMaximum = effectiveJudgeRevisionMaximum({
      baseMaximum: runtime.options.maxRevisionAttempts.value,
      events: readEvents(runtime.layout.ledger),
      scope: {
        runId: runtime.run.id,
        documentId: reference.documentId,
        taskId: reference.taskId,
      },
    })
    let revisionFeedback =
      latestRevisionAssessment?.contentRef && latestRevisionAssessment.assessment
        ? {
            assessment: latestRevisionAssessment.assessment,
            assessmentRef: latestRevisionAssessment.contentRef,
          }
        : undefined
    while (true) {
      assertSandboxTerminationAllowsTask(runtime, reference)
      if (revisionFeedback && revisionsUsed >= effectiveRevisionMaximum) {
        return withJudgeAvailability(
          settleRevisionExhaustion(
            runtime,
            reference,
            revisionFeedback.assessment,
            effectiveRevisionMaximum,
          ),
        )
      }
      const revision = revisionFeedback
        ? {
            ordinal: revisionsUsed + 1,
            previousAssessment: revisionFeedback.assessment,
            previousAssessmentRef: revisionFeedback.assessmentRef,
          }
        : undefined
      if (revision) revisionsUsed += 1
      let result: TaskExecutionResult
      try {
        result = await runAttempt(
          runtime,
          reference,
          backend,
          baselineArtifact.baseline as WorkspaceBaseline,
          ordinal,
          noChangeOrdinal,
          judgeEvaluation,
          revision,
          deadlineAt,
        )
      } catch (error) {
        if (
          !(error instanceof WatchdogRuntimeActionError) &&
          !(error instanceof WatchdogRuntimePersistenceError) &&
          !(error instanceof WatchdogRuntimeMonitorError)
        ) {
          throw error
        }
        runtime.assertWriterLease()
        const currentAttempt = listAttempts(runtime.layout.ledger, {
          runId: runtime.run.id,
          documentId: reference.documentId,
          taskId: reference.taskId,
        }).find((candidate) => candidate.ordinal === ordinal)
        if (!currentAttempt) {
          throw new RalphError(
            "RALPH_WATCHDOG_ATTEMPT_NOT_FOUND",
            `The watchdog interrupted attempt ordinal ${ordinal}, but its durable record is unavailable`,
            { exitCode: EXIT_CODES.operationalError },
          )
        }
        const restartDelta =
          error instanceof WatchdogRuntimeActionError ? error.decision.watchdogRestartDelta : 0
        const interruptedCounters = AttemptCountersSchema.parse({
          ...currentAttempt.counters,
          revisionAttempts: Math.max(
            0,
            currentAttempt.counters.revisionAttempts -
              (!(error instanceof WatchdogRuntimeActionError) && revision ? 1 : 0),
          ),
        })
        updateAttempt(runtime.layout.ledger, {
          attemptId: currentAttempt.id,
          counters: interruptedCounters,
          ...(currentAttempt.status === "active"
            ? { status: "interrupted" as const, finishedAt: runtime.dependencies.now() }
            : {}),
          event: {
            type:
              error instanceof WatchdogRuntimeActionError
                ? "attempt.watchdog_interrupted"
                : error instanceof WatchdogRuntimePersistenceError
                  ? "attempt.watchdog_persistence_failed"
                  : "attempt.watchdog_monitor_failed",
            level: "error",
            payload: persistenceSafe(runtime, {
              reason: error.message,
              ...(error instanceof WatchdogRuntimeActionError
                ? {
                    action: error.action,
                    phase: error.decision.phase,
                    probeId: error.probeId,
                    restartDelta,
                    consumesJudgeRevision: false,
                  }
                : error instanceof WatchdogRuntimePersistenceError
                  ? { probeId: error.probeId }
                  : { stage: error.stage, phase: error.phase }),
            }),
          },
        })
        let currentTask = getRunTask(
          runtime.layout.ledger,
          runtime.run.id,
          reference.documentId,
          reference.taskId,
        )
        if (
          currentTask &&
          (currentTask.status === "active" ||
            currentTask.status === "verifying" ||
            currentTask.status === "evaluating")
        ) {
          currentTask = transitionStoredTask(runtime.layout.ledger, currentTask, "interrupted", {
            activeAttemptId: null,
            eventType: "task.watchdog_interrupted",
          })
        } else if (currentTask?.status === "interrupted" && currentTask.activeAttemptId) {
          currentTask = upsertRunTask(runtime.layout.ledger, {
            runId: currentTask.runId,
            documentId: currentTask.documentId,
            taskId: currentTask.taskId,
            status: currentTask.status,
            markerContentHash: currentTask.markerContentHash,
            activeAttemptId: null,
            event: { type: "task.watchdog_attempt_released" },
          })
        }
        if (revision) revisionsUsed = Math.max(0, revisionsUsed - 1)
        if (error instanceof WatchdogRuntimeActionError && error.action === "restart-attempt") {
          if (!currentTask) throw new Error("Watchdog-interrupted task record disappeared")
          const unsettledModelCalls = listModelCalls(
            runtime.layout.ledger,
            currentAttempt.id,
          ).filter((call) => call.status === "started")
          if (unsettledModelCalls.length > 0) {
            appendEvent(runtime.layout.ledger, {
              type: "attempt.watchdog_restart_deferred",
              scope: "run",
              streamId: runtime.run.id,
              workspaceId: runtime.workspaceId,
              runId: runtime.run.id,
              documentId: reference.documentId,
              taskId: reference.taskId,
              attemptId: currentAttempt.id,
              level: "error",
              payload: persistenceSafe(runtime, {
                probeId: error.probeId,
                action: error.action,
                reason:
                  "The cancelled backend did not confirm settlement after its bounded graceful/force termination window",
                modelCallIds: unsettledModelCalls.map((call) => call.id),
                preserveTask: error.decision.preserveTask,
                preserveDiff: error.decision.preserveDiff,
                resumable: error.decision.resumable,
              }),
            })
            return withJudgeAvailability({
              status: "limit",
              exitCode: EXIT_CODES.interrupted,
              reason:
                "Watchdog restart is deferred until the previous model call has a confirmed terminal settlement",
              stopRun: true,
            })
          }
          transitionStoredTask(runtime.layout.ledger, currentTask, "active", {
            activeAttemptId: null,
            eventType: "task.watchdog_restart_started",
          })
          ordinal += 1
          continue
        }
        const restartBudgetExhausted =
          error instanceof WatchdogRuntimeActionError &&
          error.decision.cause === "restart-budget-exhausted"
        return withJudgeAvailability({
          status: "limit",
          exitCode: restartBudgetExhausted
            ? EXIT_CODES.budgetExceeded
            : error instanceof WatchdogRuntimePersistenceError ||
                error instanceof WatchdogRuntimeMonitorError
              ? EXIT_CODES.operationalError
              : EXIT_CODES.interrupted,
          reason: error.message,
          stopRun: !(error instanceof WatchdogRuntimeActionError) || error.action === "stop-run",
        })
      }
      if (result.status === "revision_required") {
        if (!result.assessment || !result.assessmentRef) {
          throw new Error("Revision-required result is missing its persisted judge assessment")
        }
        revisionFeedback = {
          assessment: result.assessment,
          assessmentRef: result.assessmentRef,
        }
        if (revisionsUsed >= effectiveRevisionMaximum) {
          return withJudgeAvailability(
            settleRevisionExhaustion(
              runtime,
              reference,
              result.assessment,
              effectiveRevisionMaximum,
            ),
          )
        }
        ordinal += 1
        const record = getRunTask(
          runtime.layout.ledger,
          runtime.run.id,
          reference.documentId,
          reference.taskId,
        )
        if (!record) throw new Error("Revision-required task record disappeared")
        transitionStoredTask(runtime.layout.ledger, record, "active", {
          eventType: "task.judge_revision_started",
        })
        continue
      }
      if (
        result.status === "failed" &&
        result.reason.includes("another bounded attempt") &&
        runtime.options.mode.value !== "wiggum" &&
        noChangeOrdinal < runtime.options.maxNoChangeAttempts.value
      ) {
        noChangeOrdinal += 1
        ordinal += 1
        const record = getRunTask(
          runtime.layout.ledger,
          runtime.run.id,
          reference.documentId,
          reference.taskId,
        )
        if (!record) throw new Error("Retryable task record disappeared")
        transitionStoredTask(runtime.layout.ledger, record, "active", {
          eventType: "task.no_change_retry",
        })
        if (runtime.options.delayMs.value > 0) {
          await withinTaskDeadline(
            deadlineAt,
            "no-change-retry-delay",
            () => runtime.dependencies.sleep(runtime.options.delayMs.value, runtime.signal),
            runtime.signal,
          )
        }
        continue
      }
      return withJudgeAvailability(result)
    }
  } catch (error) {
    if (isExecutionCancelled(error) || isExecutionDeadlineExceeded(error)) {
      for (const activeAttempt of listAttempts(runtime.layout.ledger, {
        runId: runtime.run.id,
        documentId: reference.documentId,
        taskId: reference.taskId,
      }).filter((candidate) => candidate.status === "active")) {
        transitionStoredAttemptStatus(runtime.layout.ledger, activeAttempt, "interrupted", {
          finishedAt: runtime.dependencies.now(),
          eventType: "attempt.interrupted",
        })
      }
      const currentTask = getRunTask(
        runtime.layout.ledger,
        runtime.run.id,
        reference.documentId,
        reference.taskId,
      )
      if (
        currentTask &&
        (currentTask.status === "active" ||
          currentTask.status === "verifying" ||
          currentTask.status === "evaluating")
      ) {
        transitionStoredTask(runtime.layout.ledger, currentTask, "interrupted", {
          eventType: "task.interrupted",
        })
      }
    }
    throw error
  } finally {
    runtime.options = previousOptions
  }
}

type CommandOwnedChildCoordinator = {
  host: Runtime
  owner: LeaseOwnerIdentity
  budget: CommandOwnedTaskBudget
  reconciliationOnlyDepth: number
}

type CommandOwnedTaskBudget = {
  readonly limit: number
  consumed: number
  lastExecution:
    | {
        runId: string
        documentId: string
        taskId: string
        resolution: ResolvedRunOptions
        judgeAvailable: boolean | undefined
      }
    | undefined
  /** One already-consumed leaf may be re-entered after a child watchdog restart. */
  watchdogRestartPermit:
    | {
        runId: string
        documentId: string
        taskId: string
      }
    | undefined
  readonly boundaryRunIds: Set<string>
  readonly upstream?: ChildTaskBudgetAuthority
}

type ChildExecutionRequest = Parameters<ChildRunExecutionPort["execute"]>[0]
type ChildTerminalReconciliationRequest = Parameters<ChildRunExecutionPort["reconcileTerminal"]>[0]

function childUsageFromEvidence(usage: EvidenceUsage): ChildUsageSummary {
  if (usage.source === "unavailable") {
    return ChildUsageSummarySchema.parse({ available: false, source: "unavailable" })
  }
  return ChildUsageSummarySchema.parse({
    available: true,
    source: usage.source,
    ...(usage.input !== undefined ? { inputTokens: usage.input } : {}),
    ...(usage.output !== undefined ? { outputTokens: usage.output } : {}),
    ...(usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : {}),
    ...(usage.total !== undefined ? { totalTokens: usage.total } : {}),
    ...(usage.cost
      ? {
          cost: {
            amount: usage.cost.amount,
            currency: usage.cost.currency,
            source: usage.cost.source ?? usage.source,
          },
        }
      : {}),
  })
}

function childWatchdogStatus(runStatus: RunStatus): ChildRunObservability["watchdogStatus"] {
  switch (runStatus) {
    case "running":
      return "healthy"
    case "waiting":
      return "slow"
    case "stopping":
    case "interrupted":
      return "suspect"
    case "failed":
    case "cancelled":
      return "stalled"
    case "created":
    case "completed":
      return "idle"
  }
}

function childRuntimeObservability(
  runtime: Runtime,
  linkId: string,
  report?: ExecutionReport,
): ChildRunObservability {
  const link = getChildRunLink(runtime.layout.ledger, linkId)
  if (!link) {
    throw new RalphError("RALPH_CHILD_LINK_NOT_FOUND", `Child link not found: ${linkId}`, {
      exitCode: EXIT_CODES.conflict,
    })
  }
  const tasks = listRunTasks(runtime.layout.ledger, runtime.run.id)
  const completed = tasks.filter(
    (task) => task.status === "completed" || task.status === "completed_with_override",
  ).length
  const current = tasks.find(
    (task) => task.status !== "completed" && task.status !== "completed_with_override",
  )
  const usage = report
    ? {
        executorUsage: childUsageFromEvidence(report.usage.executor),
        judgeUsage: childUsageFromEvidence(report.usage.judge),
        combinedUsage: childUsageFromEvidence(report.usage.combined),
      }
    : {
        executorUsage: link.observability.executorUsage,
        judgeUsage: link.observability.judgeUsage,
        combinedUsage: link.observability.combinedUsage,
      }
  return ChildRunObservabilitySchema.parse({
    progress: {
      completed,
      total: tasks.length,
      ...(current ? { currentDocumentId: current.documentId, currentTaskId: current.taskId } : {}),
    },
    ...usage,
    lastSourceEventSequence: link.observability.lastSourceEventSequence,
    lastLogSequence: link.observability.lastLogSequence,
    watchdogStatus: childWatchdogStatus(runtime.run.status),
    ...(runtime.run.status !== "completed" && runtime.run.stopReason
      ? { lastError: runtime.run.stopReason }
      : {}),
  })
}

async function projectUnprojectedChildEvents(
  runtime: Runtime,
  request: Pick<ChildExecutionRequest, "link" | "projectEvent">,
): Promise<void> {
  const link = getChildRunLink(runtime.layout.ledger, request.link.id)
  if (!link) {
    throw new RalphError(
      "RALPH_CHILD_LINK_NOT_FOUND",
      `Child link not found while projecting events: ${request.link.id}`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const throughSequence = readEventHighWater(runtime.layout.ledger)
  let cursor = link.observability.lastSourceEventSequence
  if (cursor > throughSequence) {
    throw new RalphError(
      "RALPH_CHILD_EVENT_CURSOR_AHEAD",
      "The child projection cursor is ahead of the durable event ledger",
      {
        exitCode: EXIT_CODES.conflict,
        details: {
          childRunId: runtime.run.id,
          cursor,
          throughSequence,
        },
      },
    )
  }
  while (cursor < throughSequence) {
    const batch = readRunEventBatch(runtime.layout.ledger, {
      runId: runtime.run.id,
      afterSequence: cursor,
      throughSequence,
      limit: 256,
    })
    for (const event of batch.events) await request.projectEvent(event)
    if (batch.cursorSequence <= cursor) {
      throw new RalphError(
        "RALPH_CHILD_EVENT_CURSOR_STALLED",
        "The bounded child event reader did not advance its cursor",
        {
          exitCode: EXIT_CODES.operationalError,
          details: { childRunId: runtime.run.id, cursor, throughSequence },
        },
      )
    }
    cursor = batch.cursorSequence
    if (batch.exhausted) break
  }
}

type IndexedRunEvent = ReturnType<typeof readRunEventBatch>["events"][number]

/** Reads one run through a fixed high-water mark without deserializing sibling runs. */
function readIndexedRunEvents(ledger: string, runId: string): readonly IndexedRunEvent[] {
  const throughSequence = readEventHighWater(ledger)
  const events: IndexedRunEvent[] = []
  let cursor = 0
  while (cursor < throughSequence) {
    const batch = readRunEventBatch(ledger, {
      runId,
      afterSequence: cursor,
      throughSequence,
      limit: 256,
    })
    events.push(...batch.events)
    if (batch.cursorSequence <= cursor) {
      throw new RalphError(
        "RALPH_RUN_EVENT_CURSOR_STALLED",
        "The bounded run event reader did not advance its cursor",
        {
          exitCode: EXIT_CODES.operationalError,
          details: { runId, cursor, throughSequence },
        },
      )
    }
    cursor = batch.cursorSequence
    if (batch.exhausted) break
  }
  return events
}

async function buildCommandOwnedChildRuntime(
  host: Runtime,
  request: ChildExecutionRequest | ChildTerminalReconciliationRequest,
): Promise<Runtime> {
  const run = getRun(host.layout.ledger, request.link.childRunId)
  if (!run) {
    throw new RalphError(
      "RALPH_CHILD_RUN_NOT_FOUND",
      `Child run not found: ${request.link.childRunId}`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  if (
    run.workspaceId !== host.workspaceId ||
    run.rootPrdId !== request.childDocument.id ||
    run.definitionHash !== request.graph.definitionHash ||
    run.effectiveOptionsHash !== request.effectiveOptions.contentHash
  ) {
    throw new RalphError(
      "RALPH_CHILD_RUNTIME_BINDING_MISMATCH",
      "The command-owned child runtime does not match its durable reservation",
      {
        exitCode: EXIT_CODES.conflict,
        details: {
          childRunId: run.id,
          rootPrdId: run.rootPrdId,
          childDocumentId: request.childDocument.id,
          definitionHash: run.definitionHash,
          graphDefinitionHash: request.graph.definitionHash,
          effectiveOptionsHash: run.effectiveOptionsHash,
          requestedOptionsHash: request.effectiveOptions.contentHash,
        },
      },
    )
  }
  const pendingRecoveryDecision = findPendingRecoveryDecision(
    readIndexedRunEvents(host.layout.ledger, run.id),
    run.id,
  )
  const runLayout = await ensureRunLayout(host.layout, run.id)
  const signal = "signal" in request ? request.signal : undefined
  return {
    workspaceRoot: host.workspaceRoot,
    ...(host.executionRoot ? { executionRoot: host.executionRoot } : {}),
    workspaceId: host.workspaceId,
    layout: host.layout,
    runLayout,
    graph: request.graph,
    source:
      run.source ??
      RunWorkSourceSchema.parse({
        kind: "prd",
        prdId: run.rootPrdId,
        prdFile: run.rootPrdFile,
      }),
    protectedPrdPaths: Object.values(request.graph.documents).map((document) => document.file),
    run,
    options: request.effectiveOptions,
    invocationOptions: request.effectiveOptions,
    optionResolution: host.optionResolution,
    environment: host.environment,
    interactive: host.interactive,
    pendingRecoveryDecision,
    recoveryAcceptance:
      host.recoveryAcceptance?.runId === run.id ? host.recoveryAcceptance : undefined,
    ...(host.processSupervisor ? { processSupervisor: host.processSupervisor } : {}),
    assertWriterLease: () => {
      host.assertWriterLease()
      request.assertLease()
    },
    ...(signal ? { signal } : {}),
    dependencies: host.dependencies,
  }
}

function childBoundaryResult(
  childRun: RunRecord,
  status: ChildRunStatus,
  coordinator: CommandOwnedChildCoordinator,
): TaskExecutionResult | undefined {
  if (status === "passed") return undefined
  const reason = childRun.stopReason ?? `Child run ${childRun.id} is ${String(status)}`
  if (status === "interrupted" && coordinator.budget.boundaryRunIds.has(childRun.id)) {
    return {
      status: "limit",
      exitCode:
        coordinator.host.invocationOptions.mode.value === "once"
          ? EXIT_CODES.success
          : EXIT_CODES.budgetExceeded,
      reason,
      stopRun: true,
      budgetBoundary: true,
    }
  }
  if (status === "failed") {
    return {
      status: "failed",
      exitCode: EXIT_CODES.verificationFailed,
      reason,
      stopRun: true,
      terminalFailure: true,
    }
  }
  if (status === "cancelled") {
    return {
      status: "limit",
      exitCode: EXIT_CODES.interrupted,
      reason,
      stopRun: true,
      terminalFailure: true,
    }
  }
  if (status === "waiting" || status === "blocked") {
    return {
      status: "blocked",
      exitCode: EXIT_CODES.blocked,
      reason,
      stopRun: true,
    }
  }
  return {
    status: "limit",
    exitCode: EXIT_CODES.interrupted,
    reason,
    stopRun: true,
  }
}

function taskBudgetExhausted(coordinator: CommandOwnedChildCoordinator): boolean {
  return coordinator.budget.consumed >= coordinator.budget.limit
}

function taskBudgetState(budget: CommandOwnedTaskBudget): ChildTaskBudgetState {
  return {
    limit: budget.limit,
    consumed: budget.consumed,
    ...(budget.lastExecution
      ? {
          lastExecution: {
            runId: budget.lastExecution.runId,
            documentId: budget.lastExecution.documentId,
            taskId: budget.lastExecution.taskId,
            resolution: budget.lastExecution.resolution,
            ...(budget.lastExecution.judgeAvailable !== undefined
              ? { judgeAvailable: budget.lastExecution.judgeAvailable }
              : {}),
          },
        }
      : {}),
  }
}

function applyTaskBudgetState(budget: CommandOwnedTaskBudget, state: ChildTaskBudgetState): void {
  if (state.limit !== budget.limit || state.consumed < budget.consumed) {
    throw new RalphError(
      "RALPH_CHILD_TASK_BUDGET_STATE_INVALID",
      "A supervised child returned a regressive or differently bounded task budget state",
      {
        exitCode: EXIT_CODES.conflict,
        details: {
          expectedLimit: budget.limit,
          actualLimit: state.limit,
          previousConsumed: budget.consumed,
          actualConsumed: state.consumed,
        },
      },
    )
  }
  budget.consumed = state.consumed
  budget.lastExecution = state.lastExecution
    ? {
        runId: state.lastExecution.runId,
        documentId: state.lastExecution.documentId,
        taskId: state.lastExecution.taskId,
        resolution: state.lastExecution.resolution,
        judgeAvailable: state.lastExecution.judgeAvailable,
      }
    : undefined
}

async function consumeTaskExecutionBudget(
  coordinator: CommandOwnedChildCoordinator,
  runtime: Runtime,
  reference: TaskRef,
  resolution: ResolvedRunOptions,
): Promise<boolean> {
  const restartPermit = coordinator.budget.watchdogRestartPermit
  if (
    restartPermit?.runId === runtime.run.id &&
    restartPermit.documentId === reference.documentId &&
    restartPermit.taskId === reference.taskId
  ) {
    const task = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      reference.documentId,
      reference.taskId,
    )
    if (task && task.status !== "completed" && task.status !== "completed_with_override") {
      coordinator.budget.watchdogRestartPermit = undefined
      coordinator.budget.lastExecution = {
        runId: runtime.run.id,
        documentId: reference.documentId,
        taskId: reference.taskId,
        resolution,
        judgeAvailable: coordinator.budget.lastExecution?.judgeAvailable,
      }
      return true
    }
    coordinator.budget.watchdogRestartPermit = undefined
  }
  if (coordinator.budget.upstream) {
    const result = await coordinator.budget.upstream.reserve({
      runId: runtime.run.id,
      task: reference,
      resolution,
    })
    applyTaskBudgetState(coordinator.budget, result.state)
    return result.granted
  }
  if (taskBudgetExhausted(coordinator)) return false
  coordinator.budget.consumed += 1
  coordinator.budget.lastExecution = {
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
    resolution,
    judgeAvailable: undefined,
  }
  return true
}

async function recordTaskExecutionOutcome(
  coordinator: CommandOwnedChildCoordinator,
  runtime: Runtime,
  reference: TaskRef,
  result: TaskExecutionResult,
): Promise<void> {
  if (coordinator.budget.upstream) {
    const state = await coordinator.budget.upstream.report({
      runId: runtime.run.id,
      task: reference,
      ...(result.judgeAvailable !== undefined ? { judgeAvailable: result.judgeAvailable } : {}),
    })
    applyTaskBudgetState(coordinator.budget, state)
    return
  }
  const last = coordinator.budget.lastExecution
  if (
    last?.runId === runtime.run.id &&
    last.documentId === reference.documentId &&
    last.taskId === reference.taskId
  ) {
    last.judgeAvailable = result.judgeAvailable
  }
}

async function markTaskBudgetBoundary(
  coordinator: CommandOwnedChildCoordinator,
  runId: string,
): Promise<void> {
  coordinator.budget.boundaryRunIds.add(runId)
  await coordinator.budget.upstream?.markBoundary(runId)
}

function taskBudgetAuthority(coordinator: CommandOwnedChildCoordinator): ChildTaskBudgetAuthority {
  const assertBudgetTask = (input: {
    readonly runId: string
    readonly task: TaskRef
  }): RunRecord => {
    const document = coordinator.host.graph.documents[input.task.documentId]
    const task = document?.tasks.find((candidate) => candidate.id === input.task.taskId)
    if (!task || task.taskSpecHash !== input.task.taskSpecHash) {
      throw new RalphError(
        "RALPH_CHILD_TASK_BUDGET_TASK_INVALID",
        "A supervised child requested budget authority for a task outside the pre-authorized graph",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    const runtime = getRun(coordinator.host.layout.ledger, input.runId)
    if (
      !runtime ||
      runtime.workspaceId !== coordinator.host.workspaceId ||
      runtime.rootPrdId !== input.task.documentId
    ) {
      throw new RalphError(
        "RALPH_CHILD_TASK_BUDGET_RUN_INVALID",
        "A supervised child requested budget authority for a run/document binding outside its durable task scope",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    return runtime
  }
  return {
    snapshot: () => taskBudgetState(coordinator.budget),
    async reserve(input) {
      const runtime = assertBudgetTask(input)
      if (
        input.resolution.optionsHash !== input.resolution.options.contentHash ||
        effectiveOptionsHash(input.resolution.options) !== input.resolution.optionsHash ||
        input.runId.length === 0
      ) {
        throw new RalphError(
          "RALPH_CHILD_TASK_BUDGET_OPTIONS_INVALID",
          "A supervised child requested budget with an invalid effective-options binding",
          { exitCode: EXIT_CODES.conflict },
        )
      }
      const granted = await consumeTaskExecutionBudget(
        coordinator,
        { ...coordinator.host, run: runtime },
        input.task,
        input.resolution,
      )
      return { granted, state: taskBudgetState(coordinator.budget) }
    },
    async report(input) {
      const runtime = assertBudgetTask(input)
      await recordTaskExecutionOutcome(
        coordinator,
        { ...coordinator.host, run: runtime },
        input.task,
        {
          status: "completed",
          exitCode: EXIT_CODES.success,
          reason: "Supervised child task outcome",
          ...(input.judgeAvailable !== undefined ? { judgeAvailable: input.judgeAvailable } : {}),
        },
      )
      return taskBudgetState(coordinator.budget)
    },
    async markBoundary(runId) {
      const run = getRun(coordinator.host.layout.ledger, runId)
      if (!run || run.workspaceId !== coordinator.host.workspaceId) {
        throw new RalphError(
          "RALPH_CHILD_TASK_BUDGET_BOUNDARY_INVALID",
          "A supervised child marked a budget boundary for an unknown run",
          { exitCode: EXIT_CODES.conflict },
        )
      }
      await markTaskBudgetBoundary(coordinator, runId)
    },
  }
}

function taskBudgetBoundaryReason(coordinator: CommandOwnedChildCoordinator): string {
  const last = coordinator.budget.lastExecution
  const lastTask = last ? `${last.documentId}/${last.taskId} in run ${last.runId}` : "no task"
  if (coordinator.host.invocationOptions.mode.value === "once") {
    return `Once consumed its single task-execution budget at ${lastTask}; remaining root/child work is resumable`
  }
  return `Shared maxTasks=${coordinator.budget.limit} was reached after ${coordinator.budget.consumed} task execution(s) across root and child scopes (last: ${lastTask}); remaining work is resumable`
}

function taskBudgetBoundaryResult(coordinator: CommandOwnedChildCoordinator): TaskExecutionResult {
  return {
    status: "limit",
    exitCode:
      coordinator.host.invocationOptions.mode.value === "once"
        ? EXIT_CODES.success
        : EXIT_CODES.budgetExceeded,
    reason: taskBudgetBoundaryReason(coordinator),
    stopRun: true,
    budgetBoundary: true,
  }
}

type CommandOwnedChildWatchdog = {
  readonly signal: AbortSignal
  leaseRenewalAuthorized(): boolean
  fail(error: unknown): void
  stop(settled: boolean): Promise<WatchdogProbeResult | undefined>
}

function childWatchdogOperationalBudget(
  runtime: Runtime,
  link: ChildRunLinkRecord,
): WatchdogOperationalBudget {
  let watchdogRestarts = 0
  for (const event of readIndexedRunEvents(runtime.layout.ledger, runtime.run.id)) {
    if (event.type !== "child.worker.restart_started" || event.correlationId !== link.id) continue
    const persistedRestarts = event.payload?.watchdogRestarts
    if (
      typeof persistedRestarts !== "number" ||
      !Number.isSafeInteger(persistedRestarts) ||
      persistedRestarts <= 0
    ) {
      throw new RalphError(
        "RALPH_CHILD_WATCHDOG_EVENT_INVALID",
        "A persisted child watchdog restart no longer satisfies its operational-budget contract",
        {
          exitCode: EXIT_CODES.conflict,
          details: { eventId: event.eventId, linkId: link.id },
        },
      )
    }
    watchdogRestarts = Math.max(watchdogRestarts, persistedRestarts)
  }
  return { schemaVersion: 1, watchdogRestarts }
}

function childWatchdogRestartPermit(
  runtime: Runtime,
  rootLink: ChildRunLinkRecord,
): NonNullable<CommandOwnedTaskBudget["watchdogRestartPermit"]> | undefined {
  const currentRoot = getChildRunLink(runtime.layout.ledger, rootLink.id)
  if (!currentRoot || currentRoot.childRunId !== rootLink.childRunId) return undefined
  const candidates = [
    currentRoot,
    ...listChildRunTree(runtime.layout.ledger, currentRoot.childRunId),
  ].sort((left, right) => right.depth - left.depth || left.id.localeCompare(right.id))
  for (const candidate of candidates) {
    if (["passed", "failed", "cancelled"].includes(candidate.status)) continue
    const { currentDocumentId, currentTaskId } = candidate.observability.progress
    if (!currentDocumentId || !currentTaskId) continue
    const task = getRunTask(
      runtime.layout.ledger,
      candidate.childRunId,
      currentDocumentId,
      currentTaskId,
    )
    if (
      !task ||
      !["active", "verifying", "evaluating", "retryable_failed", "interrupted"].includes(
        task.status,
      )
    ) {
      continue
    }
    return {
      runId: candidate.childRunId,
      documentId: currentDocumentId,
      taskId: currentTaskId,
    }
  }
  return undefined
}

function childWatchdogActionError(
  link: ChildRunLinkRecord,
  result: WatchdogProbeResult,
): RalphError {
  const decision = result.evaluation.decision
  return new RalphError(
    "RALPH_CHILD_WATCHDOG_ACTION",
    `Child watchdog confirmed ${decision.action} after independent signals and configured quorum`,
    {
      exitCode:
        decision.cause === "restart-budget-exhausted"
          ? EXIT_CODES.budgetExceeded
          : EXIT_CODES.interrupted,
      details: {
        childRunId: link.childRunId,
        linkId: link.id,
        probeId: result.observation.probeId,
        action: decision.action,
        cause: decision.cause,
        reasons: result.evaluation.snapshot.reasons,
        budgetBefore: decision.budgetBefore,
        budgetAfter: decision.budgetAfter,
      },
    },
  )
}

function childWatchdogConfiguration(runtime: Runtime) {
  const profile = watchdogProfileFromConfig(
    runtime.optionResolution.config?.config.watchdog ?? DEFAULT_CONFIG.watchdog,
  )
  return {
    profile,
    phase: resolveWatchdogPhaseProfile(profile, "child"),
  }
}

function childWatchdogDeadline(runtime: Runtime): string | undefined {
  const { phase } = childWatchdogConfiguration(runtime)
  if (!phase.enabled || phase.hardTimeoutMs === undefined) return undefined
  const startedAt = Date.parse(runtime.dependencies.now())
  if (!Number.isFinite(startedAt)) {
    throw new RalphError(
      "RALPH_CHILD_WATCHDOG_CLOCK_INVALID",
      "The command clock could not establish the child watchdog deadline",
      { exitCode: EXIT_CODES.operationalError },
    )
  }
  // The monitor owns the configured hard deadline. The worker lifetime bound
  // is a fallback one probe plus bounded graceful-stop window later, allowing
  // the watchdog decision to be persisted before the process tree is killed.
  const terminationGraceMs = Math.min(
    Number.MAX_SAFE_INTEGER,
    phase.probeIntervalMs + Math.min(30_000, phase.heartbeatGraceMs),
  )
  return new Date(startedAt + phase.hardTimeoutMs + terminationGraceMs).toISOString()
}

async function createCommandOwnedChildWatchdog(input: {
  runtime: Runtime
  reference: TaskRef
  link: ChildRunLinkRecord
  session: ChildRunWorkerSession
  initialBudget: WatchdogOperationalBudget
}): Promise<CommandOwnedChildWatchdog> {
  const { runtime, reference, link, session } = input
  const { profile, phase } = childWatchdogConfiguration(runtime)
  const actionController = new AbortController()
  const combined = combineRunSignals(runtime.signal, actionController.signal)
  const startedMonotonicMs = Math.floor(performance.now())
  let lastExactHealthMonotonicMs = startedMonotonicMs
  let lastChildHeartbeatMonotonicMs = Number.NEGATIVE_INFINITY
  let renewalAuthorized = true
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let sampleInFlight: Promise<void> | undefined
  let previousChildHeartbeatMarker = ""
  let previousProgressMarker = ""
  let acceptedAction: WatchdogProbeResult | undefined
  let fatalError: unknown
  let actionQueue = Promise.resolve()
  const pingTimeoutMs = Math.max(
    250,
    Math.min(phase.heartbeatGraceMs, Math.max(1_000, phase.heartbeatIntervalMs * 2)),
  )
  const sampleIntervalMs = Math.max(250, Math.min(phase.probeIntervalMs, phase.heartbeatIntervalMs))
  const gracefulStopMs = Math.max(250, Math.min(30_000, phase.heartbeatGraceMs))
  // A delayed health probe must not revoke a healthy worker before the
  // configured quiet boundary. heartbeatGrace still classifies individual
  // heartbeat freshness; quietAfter is the bounded lease-proof window that
  // tolerates host scheduling and slow process-table probes without renewing
  // indefinitely through the watchdog's suspect/stall decisions.
  const leaseHealthProofGraceMs = Math.max(phase.heartbeatGraceMs, phase.quietAfterMs)

  const failClosed = (error: unknown): void => {
    fatalError =
      fatalError === undefined
        ? error
        : new AggregateError([fatalError, error], "Multiple child watchdog failures")
    renewalAuthorized = false
    if (!actionController.signal.aborted) actionController.abort(error)
  }

  let monitor!: WatchdogMonitor
  const sampleHealth = async (): Promise<void> => {
    const snapshot = session.snapshot()
    const currentLink = getChildRunLink(runtime.layout.ledger, link.id)
    if (
      !currentLink ||
      currentLink.childRunId !== link.childRunId ||
      currentLink.parentRunId !== link.parentRunId ||
      currentLink.parentDocumentId !== link.parentDocumentId ||
      currentLink.parentTaskId !== link.parentTaskId
    ) {
      throw new RalphError(
        "RALPH_CHILD_WATCHDOG_LINK_CHANGED",
        "The child watchdog could not read its exact durable parent/child binding",
        { exitCode: EXIT_CODES.conflict, details: { linkId: link.id } },
      )
    }
    const nowBeforeProbe = Math.floor(performance.now())
    const childHeartbeatMarker = snapshot.lastControlHeartbeatAt ?? ""
    if (childHeartbeatMarker.length > 0 && childHeartbeatMarker !== previousChildHeartbeatMarker) {
      previousChildHeartbeatMarker = childHeartbeatMarker
      lastChildHeartbeatMonotonicMs = nowBeforeProbe
      monitor.recordChildHeartbeat()
    }
    const processProbe = await probeProcessIdentity(session.owner)
    const exactProcessAlive =
      processProbe.status === "alive" &&
      processProbe.observedProcessStartToken === session.owner.processStartToken
    let pingAccepted = false
    if (exactProcessAlive) {
      try {
        await session.ping(pingTimeoutMs)
        pingAccepted = true
      } catch {
        // Periodic worker heartbeat, exact process identity and semantic ping
        // remain independent; one failed ping cannot manufacture a quorum.
      }
    }
    const now = Math.floor(performance.now())
    if (pingAccepted) monitor.recordControlHeartbeat()
    const childHeartbeatFresh = now - lastChildHeartbeatMonotonicMs <= phase.heartbeatGraceMs
    if (exactProcessAlive && (pingAccepted || childHeartbeatFresh)) {
      lastExactHealthMonotonicMs = now
    }
    monitor.recordProcessAlive(
      exactProcessAlive
        ? "yes"
        : processProbe.status === "dead" || processProbe.status === "identity-mismatch"
          ? "no"
          : "unknown",
    )
    const progressMarker = [
      snapshot.lastProgressAt ?? "",
      snapshot.activeRequestId ?? "",
      currentLink.observability.progress.completed,
      currentLink.observability.progress.currentDocumentId ?? "",
      currentLink.observability.progress.currentTaskId ?? "",
      currentLink.observability.lastSourceEventSequence,
      currentLink.observability.lastLogSequence,
    ].join(":")
    const progressed = progressMarker !== previousProgressMarker
    if (progressed) {
      previousProgressMarker = progressMarker
      monitor.recordProgress()
    }
    monitor.recordProcessActivity(progressed ? "yes" : "no")
    monitor.recordSettlement("running")
  }

  const handleWatchdogAction = async (result: WatchdogProbeResult): Promise<void> => {
    const action = result.evaluation.decision.action
    if (action === "none") return

    // Every actionable decision receives a fresh protocol ping and exact PID
    // start-token probe before any cancellation or process-tree kill.
    await sampleHealth()
    await monitor.flush()
    const confirmed = monitor.previousSnapshot
    if (action === "notify" || confirmed?.state !== "stalled") return

    if (acceptedAction) return
    acceptedAction = result
    renewalAuthorized = false
    const actionError = childWatchdogActionError(link, result)
    if (!actionController.signal.aborted) actionController.abort(actionError)
    try {
      if (!session.execution.requestStop) {
        throw new Error("The child worker session has no directed graceful-stop capability")
      }
      await requestGracefulChildTreeStop({
        ledger: runtime.layout.ledger,
        rootRunId: link.childRunId,
        execution: session.execution,
        reason: actionError.message,
        graceMs: gracefulStopMs,
      })
      await session.execution.requestStop({
        link,
        mode: "graceful",
        reason: actionError.message,
        graceMs: gracefulStopMs,
      })
    } catch (stopError) {
      try {
        await session.forceKill(actionError.message)
      } catch (killError) {
        throw new AggregateError(
          [actionError, stopError, killError],
          "Child watchdog could not confirm worker termination after bounded cancellation and kill",
        )
      }
      appendEvent(runtime.layout.ledger, {
        type: "child.worker.force_killed",
        scope: "run",
        streamId: runtime.run.id,
        workspaceId: runtime.workspaceId,
        runId: runtime.run.id,
        documentId: reference.documentId,
        taskId: reference.taskId,
        workerId: session.workerId,
        correlationId: link.id,
        level: "warn",
        payload: persistenceSafe(runtime, {
          schemaVersion: 1,
          childRunId: link.childRunId,
          linkId: link.id,
          action,
          gracefulStopError: stopError instanceof Error ? stopError.message : String(stopError),
          terminationConfirmed: true,
        }),
      })
    }
  }

  monitor = new WatchdogMonitor({
    profile,
    phase: "child",
    eventContext: {
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      workerId: session.workerId,
      parentRunId: runtime.run.id,
      correlationId: link.id,
    },
    initialBudget: input.initialBudget,
    ...(combined.signal ? { signal: combined.signal } : {}),
    autoControlHeartbeat: false,
    probeId: (sequence) => `${link.id}:${session.workerId}:child:${sequence}`,
    onEvaluation(result) {
      runtime.assertWriterLease()
      for (const event of result.events) {
        appendEvent(runtime.layout.ledger, {
          ...event,
          payload: persistenceSafe(runtime, event.payload ?? {}),
        })
      }
    },
    onAction(result) {
      const queued = actionQueue.then(
        () => handleWatchdogAction(result),
        () => handleWatchdogAction(result),
      )
      actionQueue = queued.catch((error) => {
        failClosed(error)
      })
    },
    onError(failure) {
      failClosed(
        new RalphError(
          "RALPH_CHILD_WATCHDOG_FAILED",
          `Child watchdog failed during ${failure.stage}`,
          { exitCode: EXIT_CODES.operationalError, cause: failure.error },
        ),
      )
    },
  })
  monitor.recordProgress()
  await sampleHealth()
  monitor.start()

  const armSample = (): void => {
    if (stopped || combined.signal?.aborted) return
    timer = setTimeout(() => {
      timer = undefined
      if (stopped || combined.signal?.aborted) return
      const operation = sampleHealth()
      sampleInFlight = operation
      void operation
        .catch((error) => failClosed(error))
        .finally(() => {
          if (sampleInFlight === operation) sampleInFlight = undefined
          armSample()
        })
    }, sampleIntervalMs)
    timer.unref()
  }
  armSample()

  return {
    signal: combined.signal ?? actionController.signal,
    leaseRenewalAuthorized() {
      const now = Math.floor(performance.now())
      return (
        renewalAuthorized &&
        !fatalError &&
        now - lastExactHealthMonotonicMs <= leaseHealthProofGraceMs
      )
    },
    fail(error) {
      failClosed(error)
    },
    async stop(settled) {
      stopped = true
      if (timer) clearTimeout(timer)
      await sampleInFlight?.catch(() => undefined)
      let observedActionQueue: Promise<void>
      do {
        observedActionQueue = actionQueue
        await observedActionQueue
      } while (observedActionQueue !== actionQueue)
      if (settled && fatalError === undefined && !combined.signal?.aborted) {
        monitor.recordSettlement("settled")
        await monitor.flush()
      }
      monitor.stop()
      await monitor.whenIdle()
      combined.dispose()
      if (fatalError !== undefined) throw fatalError
      return acceptedAction
    },
  }
}

type ChildWorkerAttemptOutcome =
  | {
      kind: "settled"
      supervised: Awaited<ReturnType<typeof superviseChildRun>>
    }
  | {
      kind: "watchdog-action"
      result: WatchdogProbeResult
    }

async function superviseChildWorkerAttempt(input: {
  runtime: Runtime
  reference: TaskRef
  effectiveOptions: EffectiveRunOptions
  coordinator: CommandOwnedChildCoordinator
  link: ChildRunLinkRecord
  sessionFactory: ChildRunWorkerSessionFactory
  maximumDepth: number
  cancellationGraceMs: number
  watchdogBudget: WatchdogOperationalBudget
}): Promise<ChildWorkerAttemptOutcome> {
  const { runtime, reference, effectiveOptions, coordinator, link } = input
  const deadlineAt = childWatchdogDeadline(runtime)
  const session = await input.sessionFactory({
    workspaceRoot: runtime.workspaceRoot,
    executionRoot: executionWorkspace(runtime),
    workspaceId: runtime.workspaceId,
    parentRunId: runtime.run.id,
    parentDocumentId: reference.documentId,
    parentTaskId: reference.taskId,
    childRunId: link.childRunId,
    linkId: link.id,
    parentPolicy: link.parentPolicy,
    maximumDepth: input.maximumDepth,
    ...(deadlineAt ? { deadlineAt } : {}),
    cancellationGraceMs: input.cancellationGraceMs,
    optionResolution: runtime.optionResolution,
    environment: runtime.environment,
    interactive: false,
    taskBudget: taskBudgetAuthority(coordinator),
    ...(runtime.signal ? { signal: runtime.signal } : {}),
  })

  let watchdog: CommandOwnedChildWatchdog | undefined
  let supervised: Awaited<ReturnType<typeof superviseChildRun>> | undefined
  let supervisionError: unknown
  try {
    watchdog = await createCommandOwnedChildWatchdog({
      runtime,
      reference,
      link,
      session,
      initialBudget: input.watchdogBudget,
    })
    supervised = await superviseChildRun({
      ledger: runtime.layout.ledger,
      graph: runtime.graph,
      linkId: link.id,
      effectiveOptions,
      owner: session.owner,
      workerId: session.workerId,
      parentWorkerId: session.parentWorkerId,
      command: "ralph-next child-run worker",
      probeOwner: probeProcessIdentity,
      execution: session.execution,
      signal: watchdog.signal,
      leaseRenewalGuard: () => watchdog?.leaseRenewalAuthorized() ?? false,
      onLeaseRenewalFailure(error) {
        watchdog?.fail(error)
        const reason =
          error instanceof Error ? error.message : "Child lease renewal failed its health gate"
        void Promise.resolve(
          session.execution.requestStop
            ? session.execution.requestStop({ link, mode: "graceful", reason })
            : Promise.reject(new Error("Child worker has no graceful-stop capability")),
        ).catch(async (stopError) => {
          try {
            await session.forceKill(reason)
          } catch (killError) {
            watchdog?.fail(
              new AggregateError(
                [error, stopError, killError],
                "Child lease failure could not confirm worker termination",
              ),
            )
          }
        })
      },
      now: runtime.dependencies.now,
    })
  } catch (error) {
    supervisionError = error
  }

  let watchdogAction: WatchdogProbeResult | undefined
  let watchdogError: unknown
  try {
    watchdogAction = await watchdog?.stop(supervised !== undefined)
  } catch (error) {
    watchdogError = error
  }
  let closeError: unknown
  try {
    await session.close("Child supervision boundary settled")
  } catch (error) {
    closeError = error
  }
  if (watchdogError !== undefined || closeError !== undefined) {
    const failures: unknown[] = [
      supervisionError,
      watchdogError,
      closeError,
      watchdogAction ? childWatchdogActionError(link, watchdogAction) : undefined,
    ].filter((error) => error !== undefined)
    const failure = new AggregateError(
      failures,
      closeError !== undefined
        ? "Child worker termination could not be confirmed"
        : "Child watchdog supervision failed closed",
    )
    appendEvent(runtime.layout.ledger, {
      type: "child.worker.supervision_failed",
      scope: "run",
      streamId: runtime.run.id,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      documentId: reference.documentId,
      taskId: reference.taskId,
      workerId: session.workerId,
      correlationId: link.id,
      level: "error",
      payload: persistenceSafe(runtime, {
        schemaVersion: 1,
        childRunId: link.childRunId,
        linkId: link.id,
        terminationConfirmed: closeError === undefined,
        watchdogSettled: watchdogError === undefined,
        reason: failure.message,
        failures: failures.map((error) => (error instanceof Error ? error.message : String(error))),
      }),
    })
    throw failure
  }
  if (watchdogAction) return { kind: "watchdog-action", result: watchdogAction }
  if (supervisionError !== undefined) throw supervisionError
  if (!supervised) {
    throw new RalphError(
      "RALPH_CHILD_SUPERVISION_UNSETTLED",
      "Child supervision returned without a durable result or failure",
      { exitCode: EXIT_CODES.operationalError },
    )
  }
  return { kind: "settled", supervised }
}

async function supervisePreauthoredTaskChild(
  runtime: Runtime,
  reference: TaskRef,
  effectiveOptions: EffectiveRunOptions,
  coordinator: CommandOwnedChildCoordinator,
): Promise<TaskExecutionResult | undefined> {
  const task = taskFor(runtime.graph, reference)
  if (!task.subPrd) return undefined

  let link = getChildRunLinkForParent(
    runtime.layout.ledger,
    runtime.run.id,
    reference.documentId,
    reference.taskId,
  )
  if (!link) {
    const parentRecord = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      reference.documentId,
      reference.taskId,
    )
    const precompleted =
      parentRecord?.status === "completed" || parentRecord?.status === "completed_with_override"
    if (!precompleted) await activateTask(runtime, reference)
    const refreshedReference = runtime.graph.topologicalOrder.find(
      (candidate) =>
        candidate.documentId === reference.documentId && candidate.taskId === reference.taskId,
    )
    if (!refreshedReference || refreshedReference.taskSpecHash !== reference.taskSpecHash) {
      throw new RalphError(
        "RALPH_CHILD_PARENT_TASK_CHANGED",
        "Parent task identity changed while activating its pre-authored child",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    link = reservePreauthoredChildRun({
      ledger: runtime.layout.ledger,
      workspaceId: runtime.workspaceId,
      parentRunId: runtime.run.id,
      parentTask: refreshedReference,
      graph: runtime.graph,
      effectiveOptions,
      parentPolicy: "pause-with-parent",
      now: runtime.dependencies.now,
    }).link
    assertExecutionNotCancelled(runtime.signal, "fault-after-child-reserved")
    await Promise.resolve(runtime.dependencies.fault("after-child-reserved"))
  }

  const childRuntimeBeforeDispatch = getRun(runtime.layout.ledger, link.childRunId)
  if (!childRuntimeBeforeDispatch) {
    throw new RalphError("RALPH_CHILD_RUN_NOT_FOUND", "Reserved child run disappeared", {
      exitCode: EXIT_CODES.conflict,
    })
  }
  if (["passed", "failed", "cancelled"].includes(link.status)) {
    return childBoundaryResult(childRuntimeBeforeDispatch, link.status, coordinator)
  }
  if (link.parentPolicy === "survive-parent") {
    throw new RalphError(
      "RALPH_CHILD_SURVIVE_PARENT_OWNER_REQUIRED",
      "survive-parent remains unavailable until Ralph can transfer the child to a separately owned writer/supervisor outside the parent process tree",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const sessionFactory = runtime.dependencies.childRunWorkerSessionFactory
  if (!sessionFactory) {
    throw new RalphError(
      "RALPH_CHILD_WORKER_COMPOSITION_UNAVAILABLE",
      "Child execution requires the supervised child-run worker composition",
      {
        exitCode: EXIT_CODES.providerUnavailable,
        hint: "Use the Ralph product composition; an executor/model cannot substitute or spawn a child coordinator.",
      },
    )
  }
  const authorizedGraph = validateChildRuntimeGraph(runtime.graph)
  const maximumDepth = Math.max(...authorizedGraph.depthByDocument.values())
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < link.depth) {
    throw new RalphError(
      "RALPH_CHILD_MAXIMUM_DEPTH_INVALID",
      "The immutable compiled graph did not authorize the reserved child depth",
      {
        exitCode: EXIT_CODES.conflict,
        details: { linkId: link.id, depth: link.depth, maximumDepth },
      },
    )
  }
  const childPhase = childWatchdogConfiguration(runtime).phase
  const cancellationGraceMs = Math.max(250, Math.min(30_000, childPhase.heartbeatGraceMs))
  let watchdogBudget = childWatchdogOperationalBudget(runtime, link)
  while (true) {
    const currentLink = getChildRunLink(runtime.layout.ledger, link.id)
    if (
      !currentLink ||
      currentLink.childRunId !== link.childRunId ||
      currentLink.parentRunId !== link.parentRunId ||
      currentLink.parentDocumentId !== link.parentDocumentId ||
      currentLink.parentTaskId !== link.parentTaskId
    ) {
      throw new RalphError(
        "RALPH_CHILD_RESTART_BINDING_CHANGED",
        "The child link changed while crossing a supervised worker boundary",
        { exitCode: EXIT_CODES.conflict, details: { linkId: link.id } },
      )
    }
    link = currentLink
    if (["passed", "failed", "cancelled"].includes(link.status)) {
      const terminalRun = getRun(runtime.layout.ledger, link.childRunId)
      if (!terminalRun) {
        throw new RalphError(
          "RALPH_CHILD_RUN_NOT_FOUND",
          "Terminal child run disappeared while reconciling a watchdog boundary",
          { exitCode: EXIT_CODES.conflict },
        )
      }
      return childBoundaryResult(terminalRun, link.status, coordinator)
    }

    const outcome = await superviseChildWorkerAttempt({
      runtime,
      reference,
      effectiveOptions,
      coordinator,
      link,
      sessionFactory,
      maximumDepth,
      cancellationGraceMs,
      watchdogBudget,
    })
    if (outcome.kind === "watchdog-action") {
      const decision = outcome.result.evaluation.decision
      watchdogBudget = outcome.result.evaluation.nextBudget
      if (decision.action !== "restart-attempt") {
        throw childWatchdogActionError(link, outcome.result)
      }
      assertExecutionNotCancelled(runtime.signal, "child-watchdog-restart")
      coordinator.budget.watchdogRestartPermit = childWatchdogRestartPermit(runtime, link)
      appendEvent(runtime.layout.ledger, {
        type: "child.worker.restart_started",
        scope: "run",
        streamId: runtime.run.id,
        workspaceId: runtime.workspaceId,
        runId: runtime.run.id,
        documentId: reference.documentId,
        taskId: reference.taskId,
        correlationId: link.id,
        level: "warn",
        payload: persistenceSafe(runtime, {
          schemaVersion: 1,
          childRunId: link.childRunId,
          linkId: link.id,
          probeId: outcome.result.observation.probeId,
          watchdogRestarts: watchdogBudget.watchdogRestarts,
          maxRestarts: decision.budgetAfter.maximum,
          preserveTask: decision.preserveTask,
          preserveDiff: decision.preserveDiff,
          resumable: decision.resumable,
        }),
      })
      continue
    }

    await recompileRuntime(runtime)
    const childRuntime = getRun(runtime.layout.ledger, link.childRunId)
    if (!childRuntime) {
      throw new RalphError("RALPH_CHILD_RUN_NOT_FOUND", "Supervised child run disappeared", {
        exitCode: EXIT_CODES.conflict,
      })
    }
    return childBoundaryResult(childRuntime, outcome.supervised.link.status, coordinator)
  }
}

async function reconcilePrecompletedTaskChildren(
  runtime: Runtime,
  documentId: string,
  coordinator: CommandOwnedChildCoordinator,
): Promise<void> {
  const references = runtime.graph.topologicalOrder.filter(
    (reference) => reference.documentId === documentId,
  )
  for (const reference of references) {
    const task = taskFor(runtime.graph, reference)
    if (!task.subPrd) continue
    const record = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      reference.documentId,
      reference.taskId,
    )
    if (record?.status !== "completed" && record?.status !== "completed_with_override") {
      continue
    }
    const resolution = effectiveOptionsForTask(runtime, reference)
    coordinator.reconciliationOnlyDepth += 1
    let result: TaskExecutionResult | undefined
    try {
      result = await supervisePreauthoredTaskChild(
        runtime,
        reference,
        resolution.options,
        coordinator,
      )
    } finally {
      coordinator.reconciliationOnlyDepth -= 1
    }
    if (result) {
      throw new RalphError(
        "RALPH_CHILD_PRECOMPLETED_RECONCILIATION_FAILED",
        "A pre-completed parent task could not reconcile its durable child tree",
        {
          exitCode: result.exitCode,
          details: {
            runId: runtime.run.id,
            documentId: reference.documentId,
            taskId: reference.taskId,
            reason: result.reason,
          },
        },
      )
    }
  }
}

async function executeCommandOwnedChildScope(
  coordinator: CommandOwnedChildCoordinator,
  request: ChildExecutionRequest,
): Promise<{ artifactsReconciled: boolean; reason: string }> {
  const runtime = await buildCommandOwnedChildRuntime(coordinator.host, request)
  let report: ExecutionReport | undefined
  try {
    runtime.assertWriterLease()
    const sandboxTerminationBlockedTaskKeys = new Set<string>()
    const refreshSandboxTerminationBarriers = (): void => {
      const barriers = scanWorkspaceSandboxTerminationBarriers({
        ledgerPath: runtime.layout.ledger,
        workspaceId: runtime.workspaceId,
        currentRunId: runtime.run.id,
      })
      for (const taskId of barriers.currentRunTaskIds) {
        sandboxTerminationBlockedTaskKeys.add(`${request.childDocument.id}\u0000${taskId}`)
      }
    }
    refreshSandboxTerminationBarriers()
    await reconcileCompletions(runtime)
    assertLedgerMarkerParity(runtime)
    alignRunGraphHash(runtime)
    if (runtime.run.status === "stopping") {
      runtime.run = transitionStoredRun(runtime.layout.ledger, runtime.run, "interrupted", {
        stopReason: "A previously requested child stop was reconciled before resume",
        eventType: "run.stop.reconciled",
      })
    }
    if (runtime.run.status !== "running") {
      runtime.run = transitionStoredRun(runtime.layout.ledger, runtime.run, "running", {
        startedAt: runtime.run.startedAt ?? runtime.dependencies.now(),
        stopReason: null,
        eventType: runtime.run.status === "created" ? "run.started" : "run.resumed",
      })
    }
    await reconcilePrecompletedTaskChildren(runtime, request.childDocument.id, coordinator)
    if (coordinator.reconciliationOnlyDepth > 0) {
      const incomplete = listRunTasks(runtime.layout.ledger, runtime.run.id).filter(
        (task) => task.status !== "completed" && task.status !== "completed_with_override",
      )
      if (incomplete.length > 0) {
        throw new RalphError(
          "RALPH_CHILD_PRECOMPLETED_TREE_INCOMPLETE",
          "A completed parent references child work that cannot be reconciled without model execution",
          {
            exitCode: EXIT_CODES.conflict,
            details: { childRunId: runtime.run.id, incomplete },
          },
        )
      }
    }
    await projectUnprojectedChildEvents(runtime, request)
    await request.observe({
      status: "running",
      observability: childRuntimeObservability(runtime, request.link.id),
      heartbeatAt: runtime.dependencies.now(),
    })

    let firstNonSuccess: TaskExecutionResult | undefined
    const deferredTaskKeys = new Set<string>(sandboxTerminationBlockedTaskKeys)
    let externallyRequestedStop: "stopping" | "cancelled" | undefined
    const observeExternalStop = (): boolean => {
      const persisted = getRun(runtime.layout.ledger, runtime.run.id)
      if (persisted?.status !== "stopping" && persisted?.status !== "cancelled") return false
      runtime.run = persisted
      externallyRequestedStop = persisted.status
      return true
    }

    while (coordinator.budget.upstream !== undefined || !taskBudgetExhausted(coordinator)) {
      runtime.assertWriterLease()
      if (observeExternalStop()) break
      assertExecutionNotCancelled(runtime.signal, "child-task-selection")
      refreshSandboxTerminationBarriers()
      for (const taskKey of sandboxTerminationBlockedTaskKeys) {
        deferredTaskKeys.add(taskKey)
      }
      const selection = selectTask({
        graph: runtime.graph,
        records: recordsMap(listRunTasks(runtime.layout.ledger, runtime.run.id)),
        documentId: request.childDocument.id,
        force: runtime.invocationOptions.force.value,
        excludedTaskKeys: deferredTaskKeys,
      })
      if (!selection) break
      if (selection.dependencyOverride) {
        appendEvent(runtime.layout.ledger, {
          type: "task.selection.overridden",
          scope: "run",
          streamId: runtime.run.id,
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          documentId: selection.task.documentId,
          taskId: selection.task.taskId,
          level: "warn",
          payload: { force: true, reason: selection.reason },
        })
      }
      const taskResolution = effectiveOptionsForTask(runtime, selection.task)
      let taskResult = await supervisePreauthoredTaskChild(
        runtime,
        selection.task,
        taskResolution.options,
        coordinator,
      )
      if (!taskResult) {
        if (taskBudgetExhausted(coordinator) && !coordinator.budget.upstream) {
          taskResult = taskBudgetBoundaryResult(coordinator)
        } else {
          const profile = taskResolution.options.executorProfile.value
          const backend = await runtime.dependencies.resolveBackend(profile, {
            workspaceRoot: executionWorkspace(runtime),
            runId: runtime.run.id,
            workspaceId: runtime.workspaceId,
            controlRoot: runtime.workspaceRoot,
            effectiveOptions: taskResolution.options,
            dryRun: false,
            ...(runtime.optionResolution.config ? { config: runtime.optionResolution.config } : {}),
          })
          assertExecutionNotCancelled(runtime.signal, "child-backend-resolution")
          if (!backend) throw executorUnavailable(profile)
          if (
            !(await consumeTaskExecutionBudget(
              coordinator,
              runtime,
              selection.task,
              taskResolution,
            ))
          ) {
            taskResult = taskBudgetBoundaryResult(coordinator)
          } else {
            taskResult = await executeTask(runtime, selection.task, taskResolution.options, backend)
            await recordTaskExecutionOutcome(coordinator, runtime, selection.task, taskResult)
          }
        }
      }
      assertExecutionNotCancelled(runtime.signal, "child-task-settlement")
      await projectUnprojectedChildEvents(runtime, request)
      await request.observe({
        status: "running",
        observability: childRuntimeObservability(runtime, request.link.id),
        heartbeatAt: runtime.dependencies.now(),
      })
      if (taskResult.status === "completed" || taskResult.status === "completed_with_override") {
        if (observeExternalStop() || taskBudgetExhausted(coordinator)) break
        continue
      }
      firstNonSuccess ??= taskResult
      deferredTaskKeys.add(taskRefKey(selection.task))
      appendEvent(runtime.layout.ledger, {
        type: "task.deferred_after_failure",
        scope: "run",
        streamId: runtime.run.id,
        workspaceId: runtime.workspaceId,
        runId: runtime.run.id,
        documentId: selection.task.documentId,
        taskId: selection.task.taskId,
        level: "warn",
        payload: {
          failFast: runtime.invocationOptions.failFast.value,
          reason: taskResult.reason,
        },
      })
      if (
        observeExternalStop() ||
        taskResult.stopRun ||
        taskBudgetExhausted(coordinator) ||
        runtime.invocationOptions.failFast.value
      ) {
        break
      }
    }

    runtime.assertWriterLease()
    const remaining = listRunTasks(runtime.layout.ledger, runtime.run.id).filter(
      (task) => task.status !== "completed" && task.status !== "completed_with_override",
    )
    const sandboxTerminationBlockedRemaining = remaining.some((task) =>
      sandboxTerminationBlockedTaskKeys.has(taskRefKey(task)),
    )
    let runStatus: RunStatus
    let reason: string
    if (externallyRequestedStop && remaining.length > 0) {
      if (runtime.run.status === "stopping") {
        runtime.run = transitionStoredRun(runtime.layout.ledger, runtime.run, "interrupted", {
          stopReason: "The child supervisor acknowledged a durable stop request",
          eventType: "run.stop.acknowledged",
        })
      }
      runStatus = runtime.run.status === "cancelled" ? "cancelled" : "interrupted"
      reason =
        runStatus === "cancelled"
          ? "The child run was cancelled by a control command"
          : "The child stopped at a durable boundary and remains resumable"
    } else if (remaining.length === 0) {
      runStatus = "completed"
      reason = `Every direct task in child document ${request.childDocument.id} is completed`
    } else if (firstNonSuccess?.budgetBoundary) {
      runStatus = "interrupted"
      reason = firstNonSuccess.reason
      await markTaskBudgetBoundary(coordinator, runtime.run.id)
    } else if (firstNonSuccess && firstNonSuccess.exitCode !== EXIT_CODES.success) {
      runStatus =
        firstNonSuccess.status === "blocked"
          ? "waiting"
          : firstNonSuccess.terminalFailure || runtime.invocationOptions.failFast.value
            ? "failed"
            : "interrupted"
      reason = firstNonSuccess.reason
    } else if (taskBudgetExhausted(coordinator)) {
      runStatus = "interrupted"
      reason = taskBudgetBoundaryReason(coordinator)
      await markTaskBudgetBoundary(coordinator, runtime.run.id)
    } else if (sandboxTerminationBlockedRemaining) {
      runStatus = "waiting"
      reason =
        "A child task remains blocked because its sandbox termination is not durably confirmed"
    } else {
      runStatus = "waiting"
      reason = "No direct child task is eligible while incomplete work remains"
    }
    if (runtime.run.status !== runStatus) {
      runtime.run = transitionStoredRun(runtime.layout.ledger, runtime.run, runStatus, {
        stopReason: reason,
        ...(runStatus === "completed" || runStatus === "failed"
          ? { finishedAt: runtime.dependencies.now() }
          : {}),
        eventType: runStatus === "completed" ? "run.completed" : "run.stopped",
      })
    }
    report = await persistReport(runtime, runStatus, [reason])
    await projectUnprojectedChildEvents(runtime, request)
    await request.observe({
      ...(runStatus === "waiting"
        ? { status: "waiting" as const }
        : runStatus === "interrupted"
          ? { status: "interrupted" as const }
          : {}),
      observability: childRuntimeObservability(runtime, request.link.id, report),
      heartbeatAt: runtime.dependencies.now(),
      reason,
    })
    return { artifactsReconciled: runStatus === "completed", reason }
  } catch (error) {
    const persisted = getRun(runtime.layout.ledger, runtime.run.id)
    if (persisted) runtime.run = persisted
    if (runtime.run.status === "running" || runtime.run.status === "stopping") {
      const exitCode = error instanceof RalphError ? error.exitCode : EXIT_CODES.operationalError
      const target: RunStatus =
        exitCode === EXIT_CODES.verificationFailed ? "failed" : "interrupted"
      const reason = persistenceSafe(
        runtime,
        error instanceof Error ? error.message : String(error),
      )
      runtime.run = transitionStoredRun(runtime.layout.ledger, runtime.run, target, {
        stopReason: reason,
        ...(target === "failed" ? { finishedAt: runtime.dependencies.now() } : {}),
        eventType: target === "failed" ? "run.failed" : "run.interrupted",
      })
      report = await persistReport(runtime, target, [reason])
      await projectUnprojectedChildEvents(runtime, request)
      await request.observe({
        ...(target === "interrupted" ? { status: "interrupted" as const } : {}),
        observability: childRuntimeObservability(runtime, request.link.id, report),
        heartbeatAt: runtime.dependencies.now(),
        reason,
      })
    }
    throw error
  }
}

async function reconcileCommandOwnedTerminalChild(
  coordinator: CommandOwnedChildCoordinator,
  request: ChildTerminalReconciliationRequest,
): Promise<{ artifactsReconciled: boolean; reason: string }> {
  const runtime = await buildCommandOwnedChildRuntime(coordinator.host, request)
  runtime.assertWriterLease()
  await reconcileCompletions(runtime)
  await recompileRuntime(runtime, false)
  assertLedgerMarkerParity(runtime)
  const remaining = listRunTasks(runtime.layout.ledger, runtime.run.id).filter(
    (task) => task.status !== "completed" && task.status !== "completed_with_override",
  )
  if (runtime.run.status === "completed" && remaining.length > 0) {
    throw new RalphError(
      "RALPH_CHILD_TERMINAL_RECONCILIATION_INCOMPLETE",
      "Completed child run still contains incomplete direct tasks",
      {
        exitCode: EXIT_CODES.conflict,
        details: { childRunId: runtime.run.id, remaining },
      },
    )
  }
  await projectUnprojectedChildEvents(runtime, request)
  const reason =
    runtime.run.stopReason ?? `Recovered terminal child run ${runtime.run.id} without re-execution`
  await request.observe({
    observability: childRuntimeObservability(
      runtime,
      request.link.id,
      getRunReport(runtime.layout.ledger, runtime.run.id)?.report,
    ),
    heartbeatAt: runtime.dependencies.now(),
    reason,
  })
  return {
    artifactsReconciled: runtime.run.status === "completed" && remaining.length === 0,
    reason,
  }
}

function createCommandOwnedChildCoordinator(
  host: Runtime,
  owner: LeaseOwnerIdentity,
  sharedBudget?: CommandOwnedTaskBudget,
  upstreamBudget?: ChildTaskBudgetAuthority,
): CommandOwnedChildCoordinator {
  const coordinator = {} as CommandOwnedChildCoordinator
  const upstreamState = upstreamBudget?.snapshot()
  const budget: CommandOwnedTaskBudget = sharedBudget ?? {
    limit:
      upstreamState?.limit ??
      (host.invocationOptions.mode.value === "once" ? 1 : host.invocationOptions.maxTasks.value),
    consumed: upstreamState?.consumed ?? 0,
    lastExecution: upstreamState?.lastExecution
      ? {
          runId: upstreamState.lastExecution.runId,
          documentId: upstreamState.lastExecution.documentId,
          taskId: upstreamState.lastExecution.taskId,
          resolution: upstreamState.lastExecution.resolution,
          judgeAvailable: upstreamState.lastExecution.judgeAvailable,
        }
      : undefined,
    watchdogRestartPermit: undefined,
    boundaryRunIds: new Set<string>(),
    ...(upstreamBudget ? { upstream: upstreamBudget } : {}),
  }
  Object.assign(coordinator, {
    host,
    owner,
    budget,
    reconciliationOnlyDepth: 0,
  })
  return coordinator
}

export type ExecuteReservedChildWorkerInput = {
  readonly operation: "execute" | "reconcile-terminal"
  readonly workspaceRoot: string
  readonly executionRoot: string
  readonly workspaceId: string
  readonly link: ChildRunLinkRecord
  readonly graph: CompiledPrdGraph
  readonly childDocument: PrdDocument
  readonly effectiveOptions: EffectiveRunOptions
  readonly optionResolution: RunOptionResolutionContext
  readonly environment?: Record<string, string | undefined>
  readonly owner: LeaseOwnerIdentity
  readonly taskBudget: ChildTaskBudgetAuthority
  readonly dependencies: ExecutionRuntimeDependencies
  readonly signal?: AbortSignal
  readonly assertLease: ChildExecutionRequest["assertLease"]
  readonly observe: ChildExecutionRequest["observe"]
  readonly projectEvent: ChildExecutionRequest["projectEvent"]
}

export type ReservedChildWorkerExecutionResult = {
  readonly runStatus: RunStatus
  readonly artifactsReconciled: boolean
  readonly reason: string
}

/**
 * Executes one already-reserved child scope inside the `child-run` Ralph
 * worker. This entrypoint cannot discover or author a PRD: its graph,
 * document, immutable link and lease are all supplied and revalidated by the
 * outer command supervisor before any task/model work is selected.
 */
export async function executeReservedChildWorker(
  input: ExecuteReservedChildWorkerInput,
): Promise<ReservedChildWorkerExecutionResult> {
  const graph = CompiledPrdGraphSchema.parse(input.graph)
  const options = EffectiveRunOptionsSchema.parse(input.effectiveOptions)
  const document = graph.documents[input.childDocument.id]
  if (
    !document ||
    document.kind !== "child" ||
    document.definitionHash !== input.childDocument.definitionHash ||
    input.link.childDocumentId !== document.id ||
    input.link.childRunId.length === 0 ||
    input.link.workspaceId !== input.workspaceId ||
    input.link.graphDefinitionHash !== graph.definitionHash ||
    input.link.inheritedOptionsHash !== options.contentHash
  ) {
    throw new RalphError(
      "RALPH_CHILD_WORKER_BINDING_INVALID",
      "The child-run worker payload does not match its pre-authorized graph, document, options and durable link",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const layout = workspaceLayout(input.workspaceRoot)
  const run = getRun(layout.ledger, input.link.childRunId)
  if (!run || run.workspaceId !== input.workspaceId) {
    throw new RalphError(
      "RALPH_CHILD_RUN_NOT_FOUND",
      `Child run not found for supervised worker: ${input.link.childRunId}`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const terminal = ["completed", "failed", "cancelled"].includes(run.status)
  if (
    (input.operation === "reconcile-terminal" && !terminal) ||
    (input.operation === "execute" && terminal)
  ) {
    throw new RalphError(
      "RALPH_CHILD_WORKER_OPERATION_INVALID",
      "The child worker operation does not match the durable run terminal state",
      {
        exitCode: EXIT_CODES.conflict,
        details: { operation: input.operation, runId: run.id, runStatus: run.status },
      },
    )
  }
  input.assertLease()
  const runLayout = await ensureRunLayout(layout, run.id)
  const host: Runtime = {
    workspaceRoot: input.workspaceRoot,
    ...(input.executionRoot !== input.workspaceRoot ? { executionRoot: input.executionRoot } : {}),
    workspaceId: input.workspaceId,
    layout,
    runLayout,
    graph,
    source:
      run.source ??
      RunWorkSourceSchema.parse({
        kind: "prd",
        prdId: run.rootPrdId,
        prdFile: run.rootPrdFile,
      }),
    protectedPrdPaths: Object.values(graph.documents).map((candidate) => candidate.file),
    run,
    options,
    invocationOptions: options,
    optionResolution: input.optionResolution,
    environment: input.environment ?? process.env,
    interactive: false,
    pendingRecoveryDecision: findPendingRecoveryDecision(
      readIndexedRunEvents(layout.ledger, run.id),
      run.id,
    ),
    recoveryAcceptance: undefined,
    ...(input.dependencies.processSupervisor
      ? { processSupervisor: input.dependencies.processSupervisor }
      : {}),
    assertWriterLease: () => {
      input.assertLease()
    },
    ...(input.signal ? { signal: input.signal } : {}),
    dependencies: runtimeDependencies(input.dependencies),
  }
  const coordinator = createCommandOwnedChildCoordinator(
    host,
    input.owner,
    undefined,
    input.taskBudget,
  )
  const common = {
    link: input.link,
    graph,
    childDocument: document,
    effectiveOptions: options,
    assertLease: input.assertLease,
    observe: input.observe,
    projectEvent: input.projectEvent,
  }
  const result =
    input.operation === "execute"
      ? await executeCommandOwnedChildScope(coordinator, {
          ...common,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : await reconcileCommandOwnedTerminalChild(coordinator, common)
  const settledRun = getRun(layout.ledger, run.id)
  if (!settledRun) {
    throw new RalphError(
      "RALPH_CHILD_RUN_NOT_FOUND",
      "Child run disappeared after its supervised worker settled",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  return {
    runStatus: settledRun.status,
    artifactsReconciled: result.artifactsReconciled,
    reason: result.reason,
  }
}

type PreparedParallelTask = {
  candidate: ParallelTaskCandidate
  reference: TaskRef
  resolution: ResolvedRunOptions
  backend?: ExecutionBackend
  expectedTargetHead: string
  worktreePath: string
  branch: string
  integrationTarget: string
  writeScopes: readonly string[]
  existingWorktree?: GitWorktreeRecord
  integrationOnly?: boolean
  childLane: boolean
}

type ParallelTaskExecutionValue = {
  prepared: PreparedParallelTask
  result: TaskExecutionResult
  claimSetId: string
  capacityLeaseId: string
  workerId: string
  worktree?: GitWorktreeRecord
  integration?: GitIntegrationRecord
  error?: unknown
}

const PARALLEL_RESUMABLE_WORKTREE_REASON =
  "Verified dead-owner recovery; resume this active worktree with a fresh task attempt"
const PARALLEL_FRESH_RETRY_WORKTREE_REASON =
  "Verified dead-owner recovery; retain this worktree and resume the task in fresh isolation"
const PARALLEL_SAFE_INTEGRATION_RETRY_PREFIX =
  "Recovery proved that no integration mutation reached the target;"
const PARALLEL_SANDBOX_TERMINATION_BLOCK_REASON =
  "Sandbox termination is not durably confirmed; this worktree remains blocked from reuse or redispatch"
const SANDBOX_TERMINATION_SCAN_PAGE_SIZE = SANDBOX_SESSION_PAGE_MAX_SIZE
const SANDBOX_TERMINATION_FOREIGN_EXAMPLE_LIMIT = 16

type SandboxSessionPageTraversal = {
  ledgerPath: string
  workspaceId: string
  runId?: string
  workerId?: string
}

type WorkspaceSandboxTerminationBarriers = {
  currentRunTaskIds: ReadonlySet<string>
}

function sandboxCursorFor(record: SandboxSessionRecord): SandboxSessionCursor {
  return { createdAt: record.createdAt, id: record.id }
}

function sandboxCursorEqual(left: SandboxSessionCursor, right: SandboxSessionCursor): boolean {
  return left.createdAt === right.createdAt && left.id === right.id
}

function sandboxCursorStrictlyOlder(
  candidate: SandboxSessionCursor,
  previous: SandboxSessionCursor,
): boolean {
  return (
    candidate.createdAt < previous.createdAt ||
    (candidate.createdAt === previous.createdAt && candidate.id < previous.id)
  )
}

/**
 * Exhausts bounded keyset pages without a total row/page cap. Strict cursor and
 * row monotonicity make a malformed or stalled persistence response fail closed
 * instead of looping or silently treating a partial scan as authoritative.
 */
function forEachSandboxSessionPage(
  query: SandboxSessionPageTraversal,
  visit: (record: SandboxSessionRecord) => void,
): void {
  let cursor: SandboxSessionCursor | undefined
  let previousRecordCursor: SandboxSessionCursor | undefined
  while (true) {
    const page = listSandboxSessionRecordPage(query.ledgerPath, {
      workspaceId: query.workspaceId,
      ...(query.runId !== undefined ? { runId: query.runId } : {}),
      ...(query.workerId !== undefined ? { workerId: query.workerId } : {}),
      ...(cursor ? { cursor } : {}),
      limit: SANDBOX_TERMINATION_SCAN_PAGE_SIZE,
    })
    if (page.records.length > SANDBOX_TERMINATION_SCAN_PAGE_SIZE) {
      throw new RalphError(
        "RALPH_SANDBOX_PAGE_OVERSIZED",
        "Sandbox session persistence returned more rows than the requested bounded page",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    for (const record of page.records) {
      const recordCursor = sandboxCursorFor(record)
      if (previousRecordCursor && !sandboxCursorStrictlyOlder(recordCursor, previousRecordCursor)) {
        throw new RalphError(
          "RALPH_SANDBOX_PAGE_ORDER_INVALID",
          "Sandbox session pages did not preserve strict (createdAt, id) descending order",
          {
            exitCode: EXIT_CODES.conflict,
            details: { previous: previousRecordCursor, observed: recordCursor },
          },
        )
      }
      visit(record)
      previousRecordCursor = recordCursor
    }

    if (page.exhausted) {
      if (page.nextCursor !== undefined) {
        throw new RalphError(
          "RALPH_SANDBOX_PAGE_CURSOR_INVALID",
          "An exhausted sandbox session page unexpectedly returned a continuation cursor",
          { exitCode: EXIT_CODES.conflict },
        )
      }
      return
    }

    const nextCursor = page.nextCursor
    const lastRecord = page.records.at(-1)
    if (
      !nextCursor ||
      !lastRecord ||
      !sandboxCursorEqual(nextCursor, sandboxCursorFor(lastRecord)) ||
      (cursor !== undefined && !sandboxCursorStrictlyOlder(nextCursor, cursor))
    ) {
      throw new RalphError(
        "RALPH_SANDBOX_PAGE_CURSOR_STALLED",
        "Sandbox session pagination did not produce a valid strictly advancing cursor",
        {
          exitCode: EXIT_CODES.conflict,
          details: {
            ...(cursor ? { previousCursor: cursor } : {}),
            ...(nextCursor ? { observedCursor: nextCursor } : {}),
          },
        },
      )
    }
    cursor = nextCursor
  }
}

function scanWorkspaceSandboxTerminationBarriers(input: {
  ledgerPath: string
  workspaceId: string
  currentRunId?: string
}): WorkspaceSandboxTerminationBarriers {
  const currentRunTaskIds = new Set<string>()
  const foreignExamples: Array<{ sessionId: string; runId: string; status: string }> = []
  let foreignCount = 0

  forEachSandboxSessionPage(
    { ledgerPath: input.ledgerPath, workspaceId: input.workspaceId },
    (session) => {
      if (session.terminationConfirmed === true) return
      if (input.currentRunId !== undefined && session.runId === input.currentRunId) {
        currentRunTaskIds.add(session.taskId)
        return
      }
      if (foreignCount === Number.MAX_SAFE_INTEGER) {
        throw new RalphError(
          "RALPH_SANDBOX_WORKSPACE_BARRIER_OVERFLOW",
          "The number of unconfirmed foreign sandbox sessions exceeded the safe counter range",
          { exitCode: EXIT_CODES.conflict },
        )
      }
      foreignCount += 1
      if (foreignExamples.length < SANDBOX_TERMINATION_FOREIGN_EXAMPLE_LIMIT) {
        foreignExamples.push({
          sessionId: session.id,
          runId: session.runId,
          status: session.status,
        })
      }
    },
  )

  if (foreignCount > 0) {
    throw new RalphError(
      "RALPH_SANDBOX_WORKSPACE_TERMINATION_UNCONFIRMED",
      "A sandbox session from another run lacks durable termination confirmation; this workspace cannot start or redispatch work",
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Confirm cleanup for every reported sandbox session before executing any run in this workspace.",
        details: {
          workspaceId: input.workspaceId,
          foreignUnconfirmedSessionCount: foreignCount,
          examplesTruncated: foreignCount > foreignExamples.length,
          foreignSessionExamples: foreignExamples,
        },
      },
    )
  }

  return { currentRunTaskIds }
}

function assertSandboxTerminationAllowsTask(runtime: Runtime, reference: TaskRef): void {
  const barriers = scanWorkspaceSandboxTerminationBarriers({
    ledgerPath: runtime.layout.ledger,
    workspaceId: runtime.workspaceId,
    currentRunId: runtime.run.id,
  })
  if (!barriers.currentRunTaskIds.has(reference.taskId)) return
  throw new RalphError(
    "RALPH_SANDBOX_TASK_TERMINATION_UNCONFIRMED",
    "This task cannot start an attempt while an earlier sandbox termination remains unconfirmed",
    {
      exitCode: EXIT_CODES.blocked,
      details: {
        runId: runtime.run.id,
        documentId: reference.documentId,
        taskId: reference.taskId,
      },
    },
  )
}

function parallelTaskStatus(record: RunTaskRecord): ParallelTaskStatus {
  switch (record.status) {
    case "completed":
    case "completed_with_override":
      return "completed"
    case "active":
    case "verifying":
    case "evaluating":
      return "active"
    case "retryable_failed":
    case "rejected":
      return "failed"
    case "interrupted":
      return "interrupted"
    case "blocked":
    case "cancelled":
      return "blocked"
    case "pending":
    case "eligible":
      return "pending"
  }
}

function parallelFailureCount(runtime: Runtime, reference: TaskRef): number {
  return listAttempts(runtime.layout.ledger, {
    runId: runtime.run.id,
    documentId: reference.documentId,
    taskId: reference.taskId,
  }).filter(
    (attempt) =>
      attempt.status === "failed" ||
      attempt.status === "interrupted" ||
      attempt.status === "rejected",
  ).length
}

function parallelCompletionAttemptId(runtime: Runtime, record: RunTaskRecord): string | undefined {
  const evidenceBundleId = record.completion?.evidenceBundleId
  if (!evidenceBundleId) return undefined
  return [
    ...listAttempts(runtime.layout.ledger, {
      runId: runtime.run.id,
      documentId: record.documentId,
      taskId: record.taskId,
    }),
  ]
    .reverse()
    .find((attempt) => attempt.completionDecision?.evidenceBundleId === evidenceBundleId)?.id
}

function rootParallelReferences(graph: CompiledPrdGraph): readonly TaskRef[] {
  return graph.topologicalOrder.filter((reference) => reference.documentId === graph.rootDocumentId)
}

function latestParallelWorktrees(runtime: Runtime): ReadonlyMap<string, GitWorktreeRecord> {
  const latest = new Map<string, GitWorktreeRecord>()
  for (const worktree of listGitWorktreeRecords(runtime.layout.ledger, {
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    limit: 1_000,
  })) {
    const key = `${worktree.documentId}\u0000${worktree.taskId}`
    if (!latest.has(key)) latest.set(key, worktree)
  }
  return latest
}

function parallelIntegrationsByWorktree(
  runtime: Runtime,
): ReadonlyMap<string, readonly GitIntegrationRecord[]> {
  const grouped = new Map<string, GitIntegrationRecord[]>()
  for (const record of listGitIntegrationRecords(runtime.layout.ledger, {
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    limit: 1_000,
  })) {
    const current = grouped.get(record.worktreeId) ?? []
    current.push(record)
    grouped.set(record.worktreeId, current)
  }
  return grouped
}

function pendingIsolatedWorktree(
  record: RunTaskRecord,
  worktree: GitWorktreeRecord | undefined,
  integrations: readonly GitIntegrationRecord[],
): GitWorktreeRecord | undefined {
  if (record.status !== "completed" && record.status !== "completed_with_override") {
    return undefined
  }
  if (!worktree) return undefined
  if (
    worktree.status !== "active" &&
    worktree.status !== "retained" &&
    worktree.status !== "integrating"
  ) {
    return undefined
  }
  if (
    integrations.length > 0 &&
    !integrations.every(
      (integration) =>
        integration.status === "paused" &&
        integration.summary?.startsWith(PARALLEL_SAFE_INTEGRATION_RETRY_PREFIX) === true,
    )
  ) {
    return undefined
  }
  return worktree
}

async function parallelGitResult(input: {
  git: GitCommandPort
  cwd: string
  args: readonly string[]
  operation: string
  signal?: AbortSignal
  allowExitCodes?: ReadonlySet<number>
}): Promise<Awaited<ReturnType<GitCommandPort["run"]>>> {
  const result = await input.git.run({
    cwd: input.cwd,
    args: input.args,
    timeoutMs: 10 * 60 * 1_000,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  const allowed = input.allowExitCodes ?? new Set([0])
  if (
    result.exitCode === undefined ||
    !allowed.has(result.exitCode) ||
    result.timedOut ||
    result.cancelled ||
    result.outputTruncated ||
    result.rawOutputTruncated
  ) {
    throw new RalphError(
      "RALPH_PARALLEL_GIT_COMMAND_FAILED",
      `Git ${input.operation} failed at the command-owned parallel boundary`,
      {
        exitCode: EXIT_CODES.conflict,
        details: {
          args: input.args,
          commandExitCode: result.exitCode,
          timedOut: result.timedOut,
          cancelled: result.cancelled,
          outputTruncated: result.outputTruncated === true,
          rawOutputTruncated: result.rawOutputTruncated === true,
          stderr: result.stderr.slice(0, 16_384),
        },
      },
    )
  }
  return result
}

async function parallelGitText(input: {
  git: GitCommandPort
  cwd: string
  args: readonly string[]
  operation: string
  signal?: AbortSignal
}): Promise<string> {
  return (
    await parallelGitResult({
      ...input,
      allowExitCodes: new Set([0]),
    })
  ).stdout.trim()
}

function nulPaths(value: string): string[] {
  return value
    .split("\0")
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => path.length > 0)
}

async function parallelGitInventory(
  runtime: Runtime,
  git: GitCommandPort,
): Promise<GitCheckpointInventory & { changedPaths: readonly string[] }> {
  const [statusResult, diffResult, trackedResult, untrackedResult] = await Promise.all([
    parallelGitResult({
      git,
      cwd: runtime.workspaceRoot,
      args: ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
      operation: "checkpoint status capture",
      allowExitCodes: new Set([0]),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    }),
    parallelGitResult({
      git,
      cwd: runtime.workspaceRoot,
      args: ["diff", "--binary", "HEAD", "--"],
      operation: "checkpoint diff capture",
      allowExitCodes: new Set([0]),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    }),
    parallelGitResult({
      git,
      cwd: runtime.workspaceRoot,
      args: ["diff", "--name-only", "-z", "HEAD", "--"],
      operation: "checkpoint changed-path capture",
      allowExitCodes: new Set([0]),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    }),
    parallelGitResult({
      git,
      cwd: runtime.workspaceRoot,
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      operation: "checkpoint untracked-path capture",
      allowExitCodes: new Set([0]),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    }),
  ])
  const baseline = await inspectGitBaseline(runtime.workspaceRoot, git, runtime.signal)
  return {
    head: baseline.head,
    ...(baseline.branch ? { branch: baseline.branch } : {}),
    status: statusResult.stdout,
    diff: diffResult.stdout,
    changedPaths: [
      ...new Set([...nulPaths(trackedResult.stdout), ...nulPaths(untrackedResult.stdout)]),
    ]
      .filter((path) => path !== ".ralph" && !path.startsWith(".ralph/"))
      .sort(),
  }
}

async function createParallelCheckpoint(
  runtime: Runtime,
  git: GitCommandPort,
  reason: string,
): Promise<string> {
  runtime.assertWriterLease()
  const inventory = await parallelGitInventory(runtime, git)
  const documents = Object.values(runtime.graph.documents).map((document) => document.file)
  const checkpoint = await createWorkspaceCheckpoint({
    ledgerPath: runtime.layout.ledger,
    checkpointRoot: runtime.layout.checkpoints,
    workspaceRoot: runtime.workspaceRoot,
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    reason,
    createdBy: "ralph-next:parallel-runner",
    relevantPaths: [...new Set([...documents, ...inventory.changedPaths])],
    git: inventory,
    prdRevisionHash: runtime.graph.graphHash,
    stateRevision: readEventHighWater(runtime.layout.ledger),
    id: () => `checkpoint-${randomUUID()}`,
  })
  return checkpoint.id
}

function parallelSecurityPolicy(runtime: Runtime, options: EffectiveRunOptions) {
  const configured = options.securityPolicy.value
  return materializeSecurityPolicy({
    profile: options.securityMode.value,
    interactive: runtime.interactive,
    headlessAsk: options.headlessAsk.value,
    commandAllowlist: options.allowedCommands.value,
    network: {
      mode: configured.network_mode,
      destinations: configured.network_destinations,
    },
    externalEffects: configured.external_effects.map((rule) => ({
      capability: rule.capability,
      action: rule.action,
      requireIdempotencyKey: rule.require_idempotency_key,
    })),
    ...(configured.dangerous_override_reason
      ? { dangerousOverrideReason: configured.dangerous_override_reason }
      : {}),
    role: "executor",
  })
}

function parallelTerminal(
  prepared: PreparedParallelTask,
  result: TaskExecutionResult,
): ParallelWorkerResult<ParallelTaskExecutionValue>["terminal"] {
  const completed = result.status === "completed" || result.status === "completed_with_override"
  return {
    taskId: prepared.candidate.taskId,
    attemptId: prepared.candidate.attemptId,
    outcome: completed
      ? "completed"
      : result.status === "limit" || result.status === "revision_required"
        ? "interrupted"
        : "failed",
    failureCount: completed ? prepared.candidate.failureCount : prepared.candidate.failureCount + 1,
  }
}

function retainParallelWorktree(
  runtime: Runtime,
  worktree: GitWorktreeRecord,
  reason: string,
): GitWorktreeRecord {
  if (worktree.status === "retained" || worktree.status === "failed") return worktree
  if (worktree.status !== "preparing" && worktree.status !== "active") return worktree
  return transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
    status: "retained",
    failureReason: reason.slice(0, 4_096),
    updatedAt: runtime.dependencies.now(),
  })
}

async function executeParallelRoot(input: {
  runtime: Runtime
  childCoordinator: CommandOwnedChildCoordinator
  sandboxTerminationBarriers: WorkspaceSandboxTerminationBarriers
  resumedExistingRun: boolean
  requestedTask?: string
  ownerInstanceId: string
}): Promise<RunExecutionResult> {
  const { runtime } = input
  const potentiallyActiveSandboxTaskKeys = new Set(
    [...input.sandboxTerminationBarriers.currentRunTaskIds].map(
      (taskId) => `${runtime.graph.rootDocumentId}\u0000${taskId}`,
    ),
  )
  const hostSupervisor =
    runtime.processSupervisor ??
    runtime.dependencies.gitProcessSupervisorFactory?.({
      workspaceRoot: runtime.workspaceRoot,
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
    }) ??
    new BunProcessSupervisor()
  const git = createGitCommandPort(runtime.environment, hostSupervisor)
  const rootParallel = runtime.options.parallelPolicy.value
  const rootGit = runtime.options.gitPolicy.value
  assertGitAutomationPolicy({
    autoRollback: rootGit.auto_rollback,
    autoCheckpoints: rootGit.auto_checkpoints,
  })
  if (!rootGit.branch_per_task) {
    throw new RalphError(
      "RALPH_PARALLEL_WORKTREE_ISOLATION_REQUIRED",
      "Parallel mode requires git.branch_per_task; command-owned execution will not degrade to serial work",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Enable branch-per-task worktrees or choose a non-parallel run mode explicitly.",
      },
    )
  }
  const rootStrategy = rootGit.create_pr
    ? "create-pr"
    : normalizeGitIntegrationStrategy(rootParallel.integration_strategy)
  if (!rootGit.commit_per_task && rootStrategy !== "none") {
    throw new RalphError(
      "RALPH_PARALLEL_COMMIT_REQUIRED",
      "A mutating parallel integration strategy requires git.commit_per_task",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Enable commit-per-task or use the explicit none/no-merge integration strategy.",
      },
    )
  }

  let baseline = await inspectGitBaseline(runtime.workspaceRoot, git, runtime.signal)
  const integrationTarget = rootGit.integration_branch ?? baseline.branch
  if (!integrationTarget || !baseline.branch) {
    throw new RalphError(
      "RALPH_PARALLEL_DETACHED_HEAD_UNSUPPORTED",
      "Parallel integration requires an explicit checked-out target branch",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  if (baseline.branch !== integrationTarget) {
    throw new RalphError(
      "RALPH_PARALLEL_INTEGRATION_BRANCH_NOT_CHECKED_OUT",
      "The command-owned integration workspace must already be on the configured integration branch",
      {
        exitCode: EXIT_CODES.conflict,
        details: { configured: integrationTarget, observed: baseline.branch },
      },
    )
  }
  const resolvedTargetHead = await parallelGitText({
    git,
    cwd: runtime.workspaceRoot,
    args: ["rev-parse", "--verify", "--end-of-options", `${integrationTarget}^{commit}`],
    operation: "integration target ref verification",
    ...(runtime.signal ? { signal: runtime.signal } : {}),
  })
  if (resolvedTargetHead !== baseline.head) {
    throw new RalphError(
      "RALPH_PARALLEL_INTEGRATION_TARGET_MISMATCH",
      "Configured integration target does not resolve to the checked-out HEAD",
      {
        exitCode: EXIT_CODES.conflict,
        details: { integrationTarget, resolvedTargetHead, observedHead: baseline.head },
      },
    )
  }
  if (rootGit.base_branch) {
    const baseHead = await parallelGitText({
      git,
      cwd: runtime.workspaceRoot,
      args: ["rev-parse", "--verify", "--end-of-options", `${rootGit.base_branch}^{commit}`],
      operation: "configured base-branch ref verification",
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    })
    const ancestry = await parallelGitResult({
      git,
      cwd: runtime.workspaceRoot,
      args: ["merge-base", "--is-ancestor", baseHead, baseline.head],
      operation: "configured base-branch ancestry check",
      allowExitCodes: new Set([0, 1]),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    })
    if (ancestry.exitCode !== 0) {
      throw new RalphError(
        "RALPH_PARALLEL_BASE_BRANCH_DIVERGED",
        "The configured base branch is not an ancestor of the integration target HEAD",
        {
          exitCode: EXIT_CODES.conflict,
          details: { baseBranch: rootGit.base_branch, target: integrationTarget },
        },
      )
    }
  }

  let baselineCheckpointId: string | undefined
  if (
    rootGit.auto_checkpoints ||
    rootGit.checkpoint_before_task ||
    (baseline.dirty && rootGit.dirty_baseline === "checkpoint-required")
  ) {
    baselineCheckpointId = await createParallelCheckpoint(
      runtime,
      git,
      "Parallel run boundary before the next isolated wave",
    )
  }
  assertGitBaselinePolicy({
    baseline,
    policy: rootGit.dirty_baseline,
    ...(baselineCheckpointId ? { checkpointId: baselineCheckpointId } : {}),
  })

  const activeClaimsBeforeRecovery = listResourceClaimSets(runtime.layout.ledger, {
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    status: "active",
    limit: 1_000,
  })
  const claimRecovery = await recoverExpiredParallelClaims({
    ledgerPath: runtime.layout.ledger,
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    probe: probeProcessIdentity,
  })
  const recoveredClaimIds = new Set(claimRecovery.recoveredClaimSetIds)
  const recoveredInterruptedWorktrees = new Map<string, GitWorktreeRecord>()
  const recoveredInterruptedFreshRetries = new Set<string>()
  const worktreesAtRecovery = listGitWorktreeRecords(runtime.layout.ledger, {
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    limit: 1_000,
  })
  for (const recoveredClaim of activeClaimsBeforeRecovery.filter((claimSet) =>
    recoveredClaimIds.has(claimSet.id),
  )) {
    for (const modelCall of listModelCalls(runtime.layout.ledger, recoveredClaim.attemptId)) {
      if (modelCall.status !== "started") continue
      updateModelCall(runtime.layout.ledger, {
        modelCallId: modelCall.id,
        status: "interrupted",
        finishedAt: runtime.dependencies.now(),
        event: {
          type: "model.call.owner_recovered_dead",
          level: "warn",
          payload: { claimSetId: recoveredClaim.id, outcomeAccepted: false },
        },
      })
    }
    for (const judgeCall of listJudgeCalls(runtime.layout.ledger, recoveredClaim.attemptId)) {
      if (judgeCall.status !== "started") continue
      finishJudgeCall(runtime.layout.ledger, {
        id: judgeCall.id,
        status: "cancelled",
        errorMessage: "Verified claim owner died before the judge call settled",
        finishedAt: runtime.dependencies.now(),
      })
    }
    const attempt = getAttempt(runtime.layout.ledger, recoveredClaim.attemptId)
    if (attempt?.status === "active") {
      transitionStoredAttemptStatus(runtime.layout.ledger, attempt, "interrupted", {
        finishedAt: runtime.dependencies.now(),
        eventType: "attempt.owner_recovered_dead",
      })
    }
    const taskRecord = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      recoveredClaim.documentId,
      recoveredClaim.taskId,
    )
    let taskWasInterruptedForResume = false
    if (
      taskRecord &&
      (taskRecord.status === "active" ||
        taskRecord.status === "verifying" ||
        taskRecord.status === "evaluating")
    ) {
      transitionStoredTask(runtime.layout.ledger, taskRecord, "interrupted", {
        activeAttemptId: null,
        eventType: "task.owner_recovered_dead",
      })
      taskWasInterruptedForResume = true
    }
    const unsettledSandboxSessions: SandboxSessionRecord[] = []
    forEachSandboxSessionPage(
      {
        ledgerPath: runtime.layout.ledger,
        workspaceId: runtime.workspaceId,
        runId: runtime.run.id,
        workerId: recoveredClaim.workerId,
      },
      (session) => {
        if (
          session.attemptId === recoveredClaim.attemptId &&
          session.terminationConfirmed !== true &&
          session.status !== "stopped"
        ) {
          unsettledSandboxSessions.push(session)
        }
      },
    )
    for (const session of unsettledSandboxSessions) {
      if (session.status === "orphaned" || session.status === "failed") continue
      transitionSandboxSessionRecord(runtime.layout.ledger, session.id, session.revision, {
        status: session.status === "running" ? "orphaned" : "failed",
        terminationConfirmed: false,
        failureReason:
          "Verified claim owner died; backend process termination must be confirmed before reuse",
        updatedAt: runtime.dependencies.now(),
      })
    }
    const recoveredClaimWorktreePaths = new Set(
      recoveredClaim.claims
        .filter((claim) => claim.kind === "worktree")
        .map((claim) => claim.resourceKey),
    )
    const worktree =
      worktreesAtRecovery.find(
        (candidate) =>
          candidate.attemptId === recoveredClaim.attemptId && candidate.status === "active",
      ) ??
      worktreesAtRecovery.find(
        (candidate) =>
          candidate.documentId === recoveredClaim.documentId &&
          candidate.taskId === recoveredClaim.taskId &&
          candidate.status === "active" &&
          recoveredClaimWorktreePaths.has(portable(candidate.worktreePath)),
      )
    const preparingWorktree = worktreesAtRecovery.find(
      (candidate) =>
        candidate.attemptId === recoveredClaim.attemptId && candidate.status === "preparing",
    )
    if (
      worktree &&
      (taskWasInterruptedForResume ||
        (taskRecord?.status === "interrupted" &&
          worktree.failureReason === PARALLEL_RESUMABLE_WORKTREE_REASON)) &&
      unsettledSandboxSessions.length === 0
    ) {
      const resumableWorktree =
        worktree.failureReason === PARALLEL_RESUMABLE_WORKTREE_REASON
          ? worktree
          : transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
              status: "active",
              failureReason: PARALLEL_RESUMABLE_WORKTREE_REASON,
              updatedAt: runtime.dependencies.now(),
            })
      recoveredInterruptedWorktrees.set(
        `${recoveredClaim.documentId}\u0000${recoveredClaim.taskId}`,
        resumableWorktree,
      )
    } else if (worktree) {
      const freshRetry =
        unsettledSandboxSessions.length === 0 &&
        (taskWasInterruptedForResume || taskRecord?.status === "interrupted")
      transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
        status: "retained",
        failureReason:
          unsettledSandboxSessions.length > 0
            ? PARALLEL_SANDBOX_TERMINATION_BLOCK_REASON
            : freshRetry
              ? PARALLEL_FRESH_RETRY_WORKTREE_REASON
              : "Owner died before a resumable task execution became active",
        updatedAt: runtime.dependencies.now(),
      })
      if (freshRetry) {
        recoveredInterruptedFreshRetries.add(
          `${recoveredClaim.documentId}\u0000${recoveredClaim.taskId}`,
        )
      }
    } else if (preparingWorktree) {
      const freshRetry =
        unsettledSandboxSessions.length === 0 &&
        (taskWasInterruptedForResume || taskRecord?.status === "interrupted")
      transitionGitWorktreeRecord(
        runtime.layout.ledger,
        preparingWorktree.id,
        preparingWorktree.revision,
        {
          status: "retained",
          failureReason:
            unsettledSandboxSessions.length > 0
              ? PARALLEL_SANDBOX_TERMINATION_BLOCK_REASON
              : freshRetry
                ? PARALLEL_FRESH_RETRY_WORKTREE_REASON
                : "Owner died while preparing the worktree; automatic reuse is unsafe",
          updatedAt: runtime.dependencies.now(),
        },
      )
      if (freshRetry) {
        recoveredInterruptedFreshRetries.add(
          `${recoveredClaim.documentId}\u0000${recoveredClaim.taskId}`,
        )
      }
    }
  }
  for (const [key, worktree] of latestParallelWorktrees(runtime)) {
    if (!potentiallyActiveSandboxTaskKeys.has(key)) continue
    const taskRecord = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      worktree.documentId,
      worktree.taskId,
    )
    if (taskRecord?.status !== "interrupted") continue
    if (worktree.status === "active") {
      transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
        status: "retained",
        failureReason: PARALLEL_SANDBOX_TERMINATION_BLOCK_REASON,
        updatedAt: runtime.dependencies.now(),
      })
    }
    recoveredInterruptedFreshRetries.delete(key)
  }
  for (const [key, worktree] of latestParallelWorktrees(runtime)) {
    if (
      recoveredInterruptedWorktrees.has(key) ||
      potentiallyActiveSandboxTaskKeys.has(key) ||
      worktree.status !== "active" ||
      worktree.failureReason !== PARALLEL_RESUMABLE_WORKTREE_REASON
    ) {
      continue
    }
    const taskRecord = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      worktree.documentId,
      worktree.taskId,
    )
    if (taskRecord?.status === "interrupted") {
      recoveredInterruptedWorktrees.set(key, worktree)
    }
  }
  for (const [key, worktree] of latestParallelWorktrees(runtime)) {
    if (
      recoveredInterruptedFreshRetries.has(key) ||
      potentiallyActiveSandboxTaskKeys.has(key) ||
      worktree.status !== "retained" ||
      worktree.failureReason !== PARALLEL_FRESH_RETRY_WORKTREE_REASON
    ) {
      continue
    }
    const taskRecord = getRunTask(
      runtime.layout.ledger,
      runtime.run.id,
      worktree.documentId,
      worktree.taskId,
    )
    if (taskRecord?.status === "interrupted") {
      recoveredInterruptedFreshRetries.add(key)
    }
  }
  const inFlightIntegrations = listGitIntegrationRecords(runtime.layout.ledger, {
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    limit: 1_000,
  }).filter((integration) => integration.status === "pending" || integration.status === "running")
  for (const integration of inFlightIntegrations) {
    const worktree = listGitWorktreeRecords(runtime.layout.ledger, {
      workspaceId: runtime.workspaceId,
      runId: runtime.run.id,
      limit: 1_000,
    }).find((candidate) => candidate.id === integration.worktreeId)
    if (!worktree || worktree.status !== "integrating") continue
    const targetHeadBefore = integration.targetHeadBefore ?? worktree.baseRef
    const targetContainsSource = await parallelGitResult({
      git,
      cwd: runtime.workspaceRoot,
      args: ["merge-base", "--is-ancestor", integration.sourceHead, baseline.head],
      operation: "in-flight integration source ancestry recovery",
      allowExitCodes: new Set([0, 1]),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    })
    let patchEquivalent = targetContainsSource.exitCode === 0
    if (
      !patchEquivalent &&
      (integration.strategy === "cherry-pick" || integration.strategy === "rebase-merge")
    ) {
      const cherry = await parallelGitText({
        git,
        cwd: runtime.workspaceRoot,
        args: ["cherry", baseline.head, integration.sourceHead],
        operation: "in-flight integration patch-equivalence recovery",
        ...(runtime.signal ? { signal: runtime.signal } : {}),
      })
      const lines = cherry
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      patchEquivalent = lines.length > 0 && lines.every((line) => line.startsWith("-"))
    }
    const sourceRefHead = await parallelGitText({
      git,
      cwd: worktree.worktreePath,
      args: ["rev-parse", "--verify", "--end-of-options", `${integration.sourceRef}^{commit}`],
      operation: "in-flight integration source-ref recovery",
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    })
    const sourceBaseline = await inspectGitBaseline(worktree.worktreePath, git, runtime.signal)
    const unmerged = await parallelGitText({
      git,
      cwd: runtime.workspaceRoot,
      args: ["diff", "--name-only", "--diff-filter=U", "-z"],
      operation: "in-flight integration conflict recovery",
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    })
    const conflictPaths = unmerged.split("\0").filter(Boolean)
    const reference = runtime.graph.topologicalOrder.find(
      (candidate) =>
        candidate.documentId === worktree.documentId && candidate.taskId === worktree.taskId,
    )
    const verificationCount = reference
      ? taskFor(runtime.graph, reference).verification.filter(
          (verification) => verification.type !== "instruction",
        ).length
      : Number.POSITIVE_INFINITY
    if (
      integration.status === "running" &&
      patchEquivalent &&
      conflictPaths.length === 0 &&
      !baseline.dirty &&
      verificationCount === 0
    ) {
      transitionGitIntegrationRecord(runtime.layout.ledger, integration.id, integration.revision, {
        status: "passed",
        resultHead: baseline.head,
        summary:
          "Recovery proved the source mutation is present in a clean target and no post-integration gates are declared",
        updatedAt: runtime.dependencies.now(),
      })
      const integrated = transitionGitWorktreeRecord(
        runtime.layout.ledger,
        worktree.id,
        worktree.revision,
        { status: "integrated", head: baseline.head, updatedAt: runtime.dependencies.now() },
      )
      transitionGitWorktreeRecord(runtime.layout.ledger, integrated.id, integrated.revision, {
        status: "retained",
        failureReason: "Recovered an already delivered integration; cleanup deferred",
        updatedAt: runtime.dependencies.now(),
      })
      continue
    }
    const safeRetry =
      integration.status === "pending" &&
      conflictPaths.length === 0 &&
      !baseline.dirty &&
      baseline.head === targetHeadBefore &&
      !patchEquivalent &&
      sourceRefHead === integration.sourceHead &&
      !sourceBaseline.dirty
    const nextStatus =
      integration.status === "running" && conflictPaths.length > 0 ? "conflicted" : "paused"
    transitionGitIntegrationRecord(runtime.layout.ledger, integration.id, integration.revision, {
      status: nextStatus,
      ...(patchEquivalent ? { resultHead: baseline.head } : {}),
      ...(conflictPaths.length > 0 ? { conflictPaths } : {}),
      summary: safeRetry
        ? `${PARALLEL_SAFE_INTEGRATION_RETRY_PREFIX} a fresh claimed integration attempt is eligible`
        : patchEquivalent
          ? "Recovery found the source mutation in the target, but post-integration approval is not durably proven"
          : "Recovery could not prove either a clean non-mutation or a fully delivered integration; explicit review is required",
      updatedAt: runtime.dependencies.now(),
    })
    transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
      status: nextStatus === "conflicted" ? "conflicted" : "retained",
      failureReason: safeRetry
        ? "Integration recovery proved retry is safe under a new claim epoch"
        : "Integration recovery requires explicit review before another mutation",
      updatedAt: runtime.dependencies.now(),
    })
  }
  const integrationRecordsAtRecovery = parallelIntegrationsByWorktree(runtime)
  for (const worktree of listGitWorktreeRecords(runtime.layout.ledger, {
    workspaceId: runtime.workspaceId,
    runId: runtime.run.id,
    status: "integrating",
    limit: 1_000,
  })) {
    const terminalIntegration = (integrationRecordsAtRecovery.get(worktree.id) ?? []).find(
      (integration) => integration.status === "passed" || integration.status === "pr-created",
    )
    if (!terminalIntegration) continue
    if (terminalIntegration.status === "passed" && terminalIntegration.strategy !== "none") {
      if (!terminalIntegration.resultHead) {
        throw new RalphError(
          "RALPH_PARALLEL_INTEGRATION_RECOVERY_HEAD_MISSING",
          "A passed integration cannot be reconciled without its durable result HEAD",
          {
            exitCode: EXIT_CODES.conflict,
            details: { integrationId: terminalIntegration.id, worktreeId: worktree.id },
          },
        )
      }
      const delivered = await parallelGitResult({
        git,
        cwd: runtime.workspaceRoot,
        args: ["merge-base", "--is-ancestor", terminalIntegration.resultHead, baseline.head],
        operation: "recovered integration ancestry verification",
        allowExitCodes: new Set([0, 1]),
        ...(runtime.signal ? { signal: runtime.signal } : {}),
      })
      if (delivered.exitCode !== 0) {
        throw new RalphError(
          "RALPH_PARALLEL_INTEGRATION_RECOVERY_DIVERGED",
          "The integration target no longer contains a previously passed integration result",
          {
            exitCode: EXIT_CODES.conflict,
            details: {
              integrationId: terminalIntegration.id,
              resultHead: terminalIntegration.resultHead,
              targetHead: baseline.head,
            },
          },
        )
      }
      const integrated = transitionGitWorktreeRecord(
        runtime.layout.ledger,
        worktree.id,
        worktree.revision,
        {
          status: "integrated",
          head: terminalIntegration.resultHead,
          updatedAt: runtime.dependencies.now(),
        },
      )
      transitionGitWorktreeRecord(runtime.layout.ledger, integrated.id, integrated.revision, {
        status: "retained",
        failureReason:
          "Passed integration recovered after restart; cleanup was conservatively deferred",
        updatedAt: runtime.dependencies.now(),
      })
      const reference = runtime.graph.topologicalOrder.find(
        (candidate) =>
          candidate.documentId === worktree.documentId && candidate.taskId === worktree.taskId,
      )
      if (!reference) {
        throw new RalphError(
          "RALPH_PARALLEL_INTEGRATION_RECOVERY_TASK_MISSING",
          "A recovered integration references a task outside the immutable run graph",
          { exitCode: EXIT_CODES.conflict, details: { worktreeId: worktree.id } },
        )
      }
      const recoveredGitPolicy = effectiveOptionsForTask(runtime, reference).options.gitPolicy.value
      if (recoveredGitPolicy.auto_checkpoints || recoveredGitPolicy.checkpoint_after_task) {
        await createParallelCheckpoint(
          runtime,
          git,
          `Recovered settled integration for ${worktree.taskId}`,
        )
      }
    } else {
      transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
        status: "retained",
        failureReason:
          terminalIntegration.status === "pr-created"
            ? "Recovered a created pull request awaiting external integration"
            : "Recovered an explicit no-merge delivery boundary",
        updatedAt: runtime.dependencies.now(),
      })
    }
  }
  const claimPort = await createDurableParallelClaimPort({
    ledgerPath: runtime.layout.ledger,
    workspaceId: runtime.workspaceId,
    ownerInstanceId: input.ownerInstanceId,
  })
  const capacityPort = await createDurableParallelCapacityPort({
    projectLedgerPath: runtime.layout.ledger,
    workspaceId: runtime.workspaceId,
    maximumGlobal: rootParallel.max_global,
    maximumProject: rootParallel.max_parallel,
    maximumByProvider: rootParallel.max_per_provider,
    maximumByModel: rootParallel.max_per_model,
    environment: runtime.environment,
  })
  const sandboxCapabilities = new Map<string, SandboxCapability>()
  let sandboxCapabilitiesDiscovered = false
  const sandboxCapabilityFor = async (
    provider: EffectiveRunOptions["sandboxPolicy"]["value"]["provider"],
  ): Promise<SandboxCapability | undefined> => {
    if (!sandboxCapabilitiesDiscovered) {
      for (const capability of await discoverSandboxCapabilities(
        createSandboxProcessPort(hostSupervisor),
        runtime.signal,
      )) {
        sandboxCapabilities.set(capability.backend, capability)
      }
      sandboxCapabilitiesDiscovered = true
    }
    return sandboxCapabilities.get(provider)
  }

  const declaredRootGroups = runtime.graph.parallelGroups
    .filter((group) => group.documentId === runtime.graph.rootDocumentId)
    .map((group) => group.id)
  const allowedGroups =
    rootParallel.allowed_groups.length > 0 ? rootParallel.allowed_groups : declaredRootGroups
  const policy = {
    parallelAuto: rootParallel.auto,
    allowedGroups,
    retryFailed: rootParallel.retry_failed,
    maximumFailureRetries: rootParallel.max_failure_retries,
    failFast: rootParallel.fail_fast || runtime.options.failFast.value,
    requireIsolatedWorkspace: true,
    allowCommandOwnedChildLane: true,
  }
  const preparedByAttempt = new Map<string, PreparedParallelTask>()
  const graphOrder = new Map(
    rootParallelReferences(runtime.graph).map((reference, index) => [taskRefKey(reference), index]),
  )
  let lastPrepared: PreparedParallelTask | undefined
  let externalStop: "stopping" | "cancelled" | undefined
  let integrationBlockedReason: string | undefined
  let requestedTaskConsumed = input.requestedTask === undefined
  let snapshotOrdinal = 0
  const forcedDependencyAudits = new Set<string>()

  const snapshot = async () => {
    snapshotOrdinal += 1
    runtime.assertWriterLease()
    const persistedRun = getRun(runtime.layout.ledger, runtime.run.id)
    if (persistedRun) runtime.run = persistedRun
    if (runtime.run.status === "stopping" || runtime.run.status === "cancelled") {
      externalStop = runtime.run.status
      return {
        candidates: [],
        completedTaskIds: new Set<string>(),
        capacity: {
          maximumGlobal: rootParallel.max_global,
          activeGlobal: 0,
          maximumProject: rootParallel.max_parallel,
          activeProject: 0,
          maximumByProvider: rootParallel.max_per_provider,
          activeByProvider: {},
          maximumByModel: rootParallel.max_per_model,
          activeByModel: {},
        },
      }
    }
    if (integrationBlockedReason) {
      return {
        candidates: [],
        completedTaskIds: new Set<string>(),
        capacity: {
          maximumGlobal: rootParallel.max_global,
          activeGlobal: 0,
          maximumProject: rootParallel.max_parallel,
          activeProject: 0,
          maximumByProvider: rootParallel.max_per_provider,
          activeByProvider: {},
          maximumByModel: rootParallel.max_per_model,
          activeByModel: {},
        },
      }
    }
    const liveSandboxTerminationBarriers = scanWorkspaceSandboxTerminationBarriers({
      ledgerPath: runtime.layout.ledger,
      workspaceId: runtime.workspaceId,
      currentRunId: runtime.run.id,
    })
    for (const taskId of liveSandboxTerminationBarriers.currentRunTaskIds) {
      potentiallyActiveSandboxTaskKeys.add(`${runtime.graph.rootDocumentId}\u0000${taskId}`)
    }
    baseline = await inspectGitBaseline(runtime.workspaceRoot, git, runtime.signal)
    if (baseline.branch !== integrationTarget) {
      throw new RalphError(
        "RALPH_PARALLEL_INTEGRATION_TARGET_CHANGED",
        "The checked-out integration branch changed while parallel execution was active",
        {
          exitCode: EXIT_CODES.conflict,
          details: { expected: integrationTarget, observed: baseline.branch },
        },
      )
    }
    if (snapshotOrdinal > 1 && (rootGit.auto_checkpoints || rootGit.checkpoint_before_task)) {
      await createParallelCheckpoint(
        runtime,
        git,
        `Parallel wave ${snapshotOrdinal} pre-dispatch boundary`,
      )
    }
    const records = listRunTasks(runtime.layout.ledger, runtime.run.id)
    const recordsByKey = new Map(
      records.map((record) => [`${record.documentId}\u0000${record.taskId}`, record]),
    )
    const requestedReference =
      input.requestedTask && !requestedTaskConsumed
        ? rootParallelReferences(runtime.graph).find(
            (reference) => reference.taskId === input.requestedTask,
          )
        : undefined
    if (input.requestedTask && !requestedTaskConsumed) {
      if (!requestedReference) {
        throw new RalphError(
          "RALPH_REQUESTED_TASK_NOT_FOUND",
          `Requested root task was not found: ${input.requestedTask}`,
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
    }
    const worktrees = latestParallelWorktrees(runtime)
    const integrations = parallelIntegrationsByWorktree(runtime)
    const completedTaskIds = new Set<string>()
    for (const reference of rootParallelReferences(runtime.graph)) {
      const key = `${reference.documentId}\u0000${reference.taskId}`
      const record = recordsByKey.get(key)
      if (!record) continue
      if (record.status !== "completed" && record.status !== "completed_with_override") continue
      const worktree = worktrees.get(key)
      const delivery = worktree ? (integrations.get(worktree.id) ?? []) : []
      const pending = pendingIsolatedWorktree(record, worktree, delivery)
      const externallyPending = delivery.some(
        (item) =>
          item.status === "pr-created" || (item.status === "passed" && item.strategy === "none"),
      )
      const blockedIntegration = delivery.some(
        (item) =>
          item.status === "pending" ||
          item.status === "running" ||
          item.status === "conflicted" ||
          item.status === "failed" ||
          item.status === "paused",
      )
      if (!pending && !externallyPending && !blockedIntegration)
        completedTaskIds.add(reference.taskId)
    }
    if (requestedReference && completedTaskIds.has(requestedReference.taskId)) {
      requestedTaskConsumed = true
    }

    const candidates: ParallelTaskCandidate[] = []
    for (const reference of rootParallelReferences(runtime.graph)) {
      if (
        runtime.pendingRecoveryDecision &&
        (reference.documentId !== runtime.pendingRecoveryDecision.documentId ||
          reference.taskId !== runtime.pendingRecoveryDecision.taskId)
      ) {
        continue
      }
      if (
        input.requestedTask &&
        !requestedTaskConsumed &&
        reference.taskId !== input.requestedTask
      ) {
        continue
      }
      const record = recordsByKey.get(`${reference.documentId}\u0000${reference.taskId}`)
      if (!record) {
        throw new RalphError(
          "RALPH_RUN_TASK_NOT_MATERIALIZED",
          `Parallel task is not materialized: ${reference.documentId}/${reference.taskId}`,
          { exitCode: EXIT_CODES.operationalError },
        )
      }
      const task = taskFor(runtime.graph, reference)
      const taskKey = `${reference.documentId}\u0000${reference.taskId}`
      const sandboxTerminationBlocked = potentiallyActiveSandboxTaskKeys.has(taskKey)
      const latestWorktree = worktrees.get(taskKey)
      const existingIntegrations = latestWorktree ? (integrations.get(latestWorktree.id) ?? []) : []
      const recoverable = sandboxTerminationBlocked
        ? undefined
        : pendingIsolatedWorktree(record, latestWorktree, existingIntegrations)
      const childLaneWorktree =
        task.subPrd &&
        !sandboxTerminationBlocked &&
        existingIntegrations.length === 0 &&
        (record.status === "active" || record.status === "interrupted") &&
        latestWorktree &&
        (latestWorktree.status === "active" || latestWorktree.status === "retained") &&
        latestWorktree.failureReason !== PARALLEL_FRESH_RETRY_WORKTREE_REASON
          ? latestWorktree
          : undefined
      const interruptedWorktree =
        record.status === "interrupted" && !sandboxTerminationBlocked
          ? recoveredInterruptedWorktrees.get(`${reference.documentId}\u0000${reference.taskId}`)
          : undefined
      const interruptedFreshRetry =
        record.status === "interrupted" &&
        !sandboxTerminationBlocked &&
        recoveredInterruptedFreshRetries.has(`${reference.documentId}\u0000${reference.taskId}`)
      if (
        (record.status === "completed" || record.status === "completed_with_override") &&
        !recoverable
      ) {
        continue
      }
      const resolution = effectiveOptionsForTask(runtime, reference)
      if (
        resolution.options.force.value &&
        task.dependencies.length > 0 &&
        !forcedDependencyAudits.has(taskRefKey(reference))
      ) {
        forcedDependencyAudits.add(taskRefKey(reference))
        appendEvent(runtime.layout.ledger, {
          type: "task.selection.overridden",
          scope: "run",
          streamId: runtime.run.id,
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          documentId: reference.documentId,
          taskId: reference.taskId,
          level: "warn",
          payload: {
            force: true,
            reason: `Parallel dependency gate explicitly overridden: ${task.dependencies.join(", ")}`,
          },
        })
      }
      const taskGit = resolution.options.gitPolicy.value
      const taskParallel = resolution.options.parallelPolicy.value
      assertGitAutomationPolicy({
        autoRollback: taskGit.auto_rollback,
        autoCheckpoints: taskGit.auto_checkpoints,
      })
      const taskTarget: string = taskGit.integration_branch ?? integrationTarget
      if (taskTarget !== integrationTarget) {
        throw new RalphError(
          "RALPH_PARALLEL_TASK_INTEGRATION_TARGET_CONFLICT",
          "Task-level Git policy cannot switch integration targets inside one parallel run",
          {
            exitCode: EXIT_CODES.conflict,
            details: { taskId: task.id, expected: integrationTarget, observed: taskTarget },
          },
        )
      }
      const strategy = taskGit.create_pr
        ? "create-pr"
        : normalizeGitIntegrationStrategy(taskParallel.integration_strategy)
      if (!taskGit.commit_per_task && strategy !== "none") {
        throw new RalphError(
          "RALPH_PARALLEL_COMMIT_REQUIRED",
          `Task ${task.id} selects a mutating integration strategy without commit-per-task`,
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      const attemptId = recoverable
        ? (parallelCompletionAttemptId(runtime, record) ?? recoverable.attemptId)
        : runtime.dependencies.id("attempt")
      const resumableWorktree = recoverable ?? interruptedWorktree ?? childLaneWorktree
      const paths = resumableWorktree
        ? {
            repositoryRoot: resumableWorktree.repositoryRoot,
            managedRoot: resolve(resumableWorktree.worktreePath, ".."),
            worktreePath: resumableWorktree.worktreePath,
            branch: resumableWorktree.branch,
          }
        : await resolveManagedWorktreePath({
            repositoryRoot: runtime.workspaceRoot,
            runId: runtime.run.id,
            taskId: task.id,
            attemptId,
          })
      let backend: ExecutionBackend | undefined
      if (!recoverable && !task.subPrd) {
        try {
          backend = await runtime.dependencies.resolveBackend(
            resolution.options.executorProfile.value,
            {
              workspaceRoot: runtime.workspaceRoot,
              runId: runtime.run.id,
              workspaceId: runtime.workspaceId,
              controlRoot: runtime.workspaceRoot,
              effectiveOptions: resolution.options,
              dryRun: false,
              ...(runtime.optionResolution.config
                ? { config: runtime.optionResolution.config }
                : {}),
            },
          )
        } catch (error) {
          if (!(error instanceof RalphError) || error.exitCode !== EXIT_CODES.providerUnavailable) {
            throw error
          }
        }
      }
      const sandbox = resolution.options.sandboxPolicy.value
      const sandboxCapability = sandbox.enabled
        ? await sandboxCapabilityFor(sandbox.provider)
        : undefined
      const sandboxReady =
        !sandbox.enabled ||
        (sandboxCapability !== undefined &&
          sandboxCapabilityProblem({
            capability: sandboxCapability,
            requirements: {
              backend: sandbox.provider,
              requireContainerIsolation: sandbox.require_container_isolation,
              requireNetworkIsolation: sandbox.require_network_isolation,
              networkMode: sandbox.network_mode,
            },
          }) === undefined)
      const writeScopes = [
        ...new Set([
          ...resolution.options.writePaths.value,
          ...Object.values(runtime.graph.documents).map((document) => document.file),
        ]),
      ]
      const claims: ResourceClaimSpec[] = [
        taskResourceClaim(runtime.run.id, reference.documentId, reference.taskId),
        {
          kind: "worktree",
          resourceKey: portable(paths.worktreePath),
          mode: "exclusive",
          metadata: { attemptId },
        },
        {
          kind: "branch",
          resourceKey: paths.branch,
          mode: "exclusive",
          metadata: { attemptId },
        },
        {
          kind: "integration-target",
          resourceKey: integrationTarget,
          mode: "shared-read",
          metadata: { targetHead: baseline.head },
        },
        artifactResourceClaim(
          runtime.workspaceId,
          `${runtime.run.id}:${reference.documentId}:${reference.taskId}`,
        ),
      ]
      const providerId =
        resolution.options.executorProvider?.value ?? resolution.options.executorProfile.value
      const modelId =
        resolution.options.executorModel?.value ??
        backend?.id ??
        resolution.options.executorProfile.value
      const candidate: ParallelTaskCandidate = {
        runId: runtime.run.id,
        documentId: reference.documentId,
        taskId: reference.taskId,
        attemptId,
        graphOrder: graphOrder.get(taskRefKey(reference)) ?? Number.MAX_SAFE_INTEGER,
        status: sandboxTerminationBlocked
          ? "blocked"
          : recoverable || interruptedWorktree || interruptedFreshRetry || childLaneWorktree
            ? "pending"
            : parallelTaskStatus(record),
        dependencies: resolution.options.force.value ? [] : task.dependencies,
        ...(task.parallelGroup ? { parallelGroup: task.parallelGroup } : {}),
        providerId,
        modelId,
        declaredClaims: claims,
        childRequiresParentSequencing: task.subPrd !== undefined,
        baselineConsistent: baseline.branch === integrationTarget,
        isolation: taskGit.branch_per_task ? "worktree" : "none",
        capabilitiesAvailable:
          !sandboxTerminationBlocked &&
          (recoverable !== undefined ||
            task.subPrd !== undefined ||
            (backend !== undefined && sandboxReady)),
        credentialsAvailable:
          recoverable !== undefined || task.subPrd !== undefined || backend !== undefined,
        failureCount: parallelFailureCount(runtime, reference),
        ...(recoverable ? { reconciliationOnly: true } : {}),
      }
      const prepared: PreparedParallelTask = {
        candidate,
        reference,
        resolution,
        ...(backend ? { backend } : {}),
        expectedTargetHead: baseline.head,
        worktreePath: paths.worktreePath,
        branch: paths.branch,
        integrationTarget,
        writeScopes,
        ...(resumableWorktree ? { existingWorktree: resumableWorktree } : {}),
        ...(recoverable ? { integrationOnly: true } : {}),
        childLane: task.subPrd !== undefined,
      }
      preparedByAttempt.set(attemptId, prepared)
      lastPrepared = prepared
      candidates.push(candidate)
    }
    const remainingBudget = Math.max(
      0,
      input.childCoordinator.budget.limit - input.childCoordinator.budget.consumed,
    )
    const reconciliationCandidates = candidates.filter(
      (candidate) => candidate.reconciliationOnly === true,
    )
    const reconciliationWave = reconciliationCandidates.length > 0
    return {
      candidates: reconciliationWave ? reconciliationCandidates : candidates,
      completedTaskIds,
      capacity: {
        maximumGlobal: reconciliationWave
          ? rootParallel.max_global
          : Math.min(rootParallel.max_global, remainingBudget),
        activeGlobal: 0,
        maximumProject: reconciliationWave
          ? rootParallel.max_parallel
          : Math.min(rootParallel.max_parallel, remainingBudget),
        activeProject: 0,
        maximumByProvider: rootParallel.max_per_provider,
        activeByProvider: {},
        maximumByModel: rootParallel.max_per_model,
        activeByModel: {},
      },
    }
  }

  const executeWorker = async (
    dispatch: ClaimedParallelDispatch,
  ): Promise<ParallelWorkerResult<ParallelTaskExecutionValue>> => {
    const prepared = preparedByAttempt.get(dispatch.candidate.attemptId)
    if (!prepared) {
      throw new RalphError(
        "RALPH_PARALLEL_PREPARATION_MISSING",
        "Claimed parallel dispatch has no command-owned preparation",
        { exitCode: EXIT_CODES.operationalError },
      )
    }
    if (input.requestedTask === prepared.reference.taskId) requestedTaskConsumed = true
    if (!prepared.integrationOnly) {
      const taskKey = `${prepared.reference.documentId}\u0000${prepared.reference.taskId}`
      recoveredInterruptedWorktrees.delete(taskKey)
      recoveredInterruptedFreshRetries.delete(taskKey)
    }
    capacityPort.assertOwned(dispatch.capacityLeaseId)
    let claimSet = claimPort.assertOwned(dispatch.claimSet.id)
    let worktree = prepared.existingWorktree
    if (
      !prepared.childLane &&
      !prepared.integrationOnly &&
      !(await consumeTaskExecutionBudget(
        input.childCoordinator,
        runtime,
        prepared.reference,
        prepared.resolution,
      ))
    ) {
      const result = taskBudgetBoundaryResult(input.childCoordinator)
      const value: ParallelTaskExecutionValue = {
        prepared,
        result,
        claimSetId: claimSet.id,
        capacityLeaseId: dispatch.capacityLeaseId,
        workerId: dispatch.workerId,
        ...(worktree ? { worktree } : {}),
      }
      return { terminal: parallelTerminal(prepared, result), value }
    }
    try {
      if (!worktree) {
        worktree = await prepareTaskWorktree({
          ledgerPath: runtime.layout.ledger,
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          documentId: prepared.reference.documentId,
          taskId: prepared.reference.taskId,
          attemptId: prepared.candidate.attemptId,
          repositoryRoot: runtime.workspaceRoot,
          baseRef: prepared.expectedTargetHead,
          integrationTarget: prepared.integrationTarget,
          retention: prepared.resolution.options.gitPolicy.value.worktree_retention,
          claimSet,
          git,
          ...(runtime.signal ? { signal: runtime.signal } : {}),
          now: () => new Date(runtime.dependencies.now()),
        })
      } else {
        const recoveredBaseline = await inspectGitBaseline(
          worktree.worktreePath,
          git,
          runtime.signal,
        )
        if (
          recoveredBaseline.branch !== worktree.branch ||
          (worktree.head !== undefined && recoveredBaseline.head !== worktree.head)
        ) {
          throw new RalphError(
            "RALPH_PARALLEL_RECOVERY_WORKTREE_CHANGED",
            "Retained worktree branch or HEAD changed before command-owned resume",
            {
              exitCode: EXIT_CODES.conflict,
              details: {
                worktreeId: worktree.id,
                expectedBranch: worktree.branch,
                observedBranch: recoveredBaseline.branch,
                expectedHead: worktree.head,
                observedHead: recoveredBaseline.head,
              },
            },
          )
        }
        if (prepared.childLane && worktree.status === "retained") {
          worktree = transitionGitWorktreeRecord(
            runtime.layout.ledger,
            worktree.id,
            worktree.revision,
            {
              status: "active",
              failureReason: "Command-owned child lane resumed after a durable boundary",
              updatedAt: runtime.dependencies.now(),
            },
          )
        }
      }
      const pathClaims: ResourceClaimSpec[] = []
      for (const scope of prepared.writeScopes) {
        pathClaims.push((await bindCanonicalPathClaim(worktree.worktreePath, scope)).spec)
      }
      if (pathClaims.length > 0) {
        claimPort.expand(claimSet.id, pathClaims)
        claimSet = claimPort.assertOwned(claimSet.id)
      }
      if (prepared.integrationOnly) {
        if (worktree.status === "active") {
          worktree = await finalizeTaskWorktree({
            ledgerPath: runtime.layout.ledger,
            record: worktree,
            git,
            commit: prepared.resolution.options.gitPolicy.value.commit_per_task,
            writeScopes: prepared.writeScopes,
            message: renderTaskCommitMessage(
              prepared.resolution.options.gitPolicy.value.commit_message_template,
              {
                runId: runtime.run.id,
                taskId: prepared.reference.taskId,
                attemptId: prepared.candidate.attemptId,
              },
            ),
            sign: prepared.resolution.options.gitPolicy.value.sign_commits,
            ...(runtime.signal ? { signal: runtime.signal } : {}),
            now: () => new Date(runtime.dependencies.now()),
          })
        }
        const recoveredResult: TaskExecutionResult = {
          status: "completed",
          exitCode: EXIT_CODES.success,
          reason: "Recovered a durably completed isolated worktree without re-executing the task",
        }
        const value = {
          prepared,
          result: recoveredResult,
          claimSetId: claimSet.id,
          capacityLeaseId: dispatch.capacityLeaseId,
          workerId: dispatch.workerId,
          worktree,
        }
        return { terminal: parallelTerminal(prepared, recoveredResult), value }
      }
      if (!prepared.backend && !prepared.childLane) {
        throw executorUnavailable(prepared.resolution.options.executorProfile.value)
      }
      const workerGraph = await compileExecutableGraph(
        worktree.worktreePath,
        runtime.graph.rootFile,
      )
      if (workerGraph.definitionHash !== runtime.run.definitionHash) {
        throw new RalphError(
          "RALPH_PARALLEL_WORKTREE_DEFINITION_CHANGED",
          "The isolated worktree does not contain the run's immutable PRD definition",
          { exitCode: EXIT_CODES.conflict },
        )
      }
      let reservedAttemptAvailable = true
      const workerRuntime: Runtime = {
        ...runtime,
        executionRoot: worktree.worktreePath,
        graph: workerGraph,
        options: prepared.resolution.options,
        alignGraphHash: false,
        dependencies: {
          ...runtime.dependencies,
          id(kind) {
            if (kind === "attempt" && reservedAttemptAvailable) {
              reservedAttemptAvailable = false
              return prepared.candidate.attemptId
            }
            return runtime.dependencies.id(kind)
          },
        },
      }
      const security = parallelSecurityPolicy(runtime, prepared.resolution.options)
      persistSecurityPolicyAudit({
        ledgerPath: runtime.layout.ledger,
        scope: {
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          documentId: prepared.reference.documentId,
          taskId: prepared.reference.taskId,
          attemptId: prepared.candidate.attemptId,
          workerId: dispatch.workerId,
        },
        diagnostics: securityDiagnostics(security),
      })
      const sandbox = prepared.resolution.options.sandboxPolicy.value
      if (sandbox.enabled) {
        const capability = await sandboxCapabilityFor(sandbox.provider)
        if (!capability?.available) {
          throw new RalphError(
            "RALPH_SANDBOX_CAPABILITY_UNAVAILABLE",
            `Configured sandbox provider is unavailable: ${sandbox.provider}`,
            {
              exitCode: EXIT_CODES.providerUnavailable,
              details: { reason: capability?.reason },
            },
          )
        }
        workerRuntime.processSupervisor = new CommandOwnedSandboxSupervisor({
          ledgerPath: runtime.layout.ledger,
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          taskId: prepared.reference.taskId,
          attemptId: prepared.candidate.attemptId,
          workerId: dispatch.workerId,
          workspaceRoot: worktree.worktreePath,
          config: sandbox,
          capability,
          claimSet,
          host: hostSupervisor,
        })
      } else {
        workerRuntime.processSupervisor = hostSupervisor
      }
      let result: TaskExecutionResult
      if (prepared.childLane) {
        const laneCoordinator = createCommandOwnedChildCoordinator(
          workerRuntime,
          input.childCoordinator.owner,
          input.childCoordinator.budget,
        )
        const childBoundary = await supervisePreauthoredTaskChild(
          workerRuntime,
          prepared.reference,
          prepared.resolution.options,
          laneCoordinator,
        )
        if (childBoundary) {
          result = childBoundary
        } else if (
          !(await consumeTaskExecutionBudget(
            input.childCoordinator,
            workerRuntime,
            prepared.reference,
            prepared.resolution,
          ))
        ) {
          result = taskBudgetBoundaryResult(input.childCoordinator)
        } else {
          const profile = prepared.resolution.options.executorProfile.value
          const backend =
            prepared.backend ??
            (await runtime.dependencies.resolveBackend(profile, {
              workspaceRoot: worktree.worktreePath,
              runId: runtime.run.id,
              workspaceId: runtime.workspaceId,
              controlRoot: runtime.workspaceRoot,
              effectiveOptions: prepared.resolution.options,
              dryRun: false,
              ...(runtime.optionResolution.config
                ? { config: runtime.optionResolution.config }
                : {}),
            }))
          if (!backend) throw executorUnavailable(profile)
          result = await executeTask(
            workerRuntime,
            prepared.reference,
            prepared.resolution.options,
            backend,
          )
          await recordTaskExecutionOutcome(
            input.childCoordinator,
            workerRuntime,
            prepared.reference,
            result,
          )
        }
      } else {
        result = await executeTask(
          workerRuntime,
          prepared.reference,
          prepared.resolution.options,
          prepared.backend as ExecutionBackend,
        )
        await recordTaskExecutionOutcome(
          input.childCoordinator,
          workerRuntime,
          prepared.reference,
          result,
        )
      }
      if (result.status === "completed" || result.status === "completed_with_override") {
        const finalize = (writeScopes: readonly string[]) =>
          finalizeTaskWorktree({
            ledgerPath: runtime.layout.ledger,
            record: worktree as GitWorktreeRecord,
            git,
            commit: prepared.resolution.options.gitPolicy.value.commit_per_task,
            writeScopes,
            message: renderTaskCommitMessage(
              prepared.resolution.options.gitPolicy.value.commit_message_template,
              {
                runId: runtime.run.id,
                taskId: prepared.reference.taskId,
                attemptId: prepared.candidate.attemptId,
              },
            ),
            sign: prepared.resolution.options.gitPolicy.value.sign_commits,
            ...(runtime.signal ? { signal: runtime.signal } : {}),
            now: () => new Date(runtime.dependencies.now()),
          })
        try {
          worktree = await finalize(prepared.writeScopes)
        } catch (error) {
          if (!(error instanceof RalphError) || error.code !== "RALPH_GIT_COMMIT_SCOPE_EXPANDED") {
            throw error
          }
          const expansionPolicy = prepared.resolution.options.parallelPolicy.value.scope_expansion
          if (expansionPolicy === "pause") {
            throw new RalphError(
              "RALPH_PARALLEL_SCOPE_EXPANSION_PAUSED",
              "Task touched paths outside its declared scope and policy requires explicit review",
              {
                exitCode: EXIT_CODES.blocked,
                ...(error.diagnostic.details ? { details: error.diagnostic.details } : {}),
              },
            )
          }
          if (expansionPolicy === "deny") throw error
          const outside = Array.isArray(error.diagnostic.details?.outside)
            ? error.diagnostic.details.outside.filter(
                (path): path is string => typeof path === "string" && path.length > 0,
              )
            : []
          if (outside.length === 0) throw error
          const additions: ResourceClaimSpec[] = []
          for (const path of outside) {
            additions.push((await bindCanonicalPathClaim(worktree.worktreePath, path)).spec)
          }
          claimPort.expand(claimSet.id, additions)
          claimSet = claimPort.assertOwned(claimSet.id)
          worktree = await finalize([...new Set([...prepared.writeScopes, ...outside])])
        }
      } else {
        worktree = retainParallelWorktree(runtime, worktree, result.reason)
      }
      const value = {
        prepared,
        result,
        claimSetId: claimSet.id,
        capacityLeaseId: dispatch.capacityLeaseId,
        workerId: dispatch.workerId,
        worktree,
      }
      return { terminal: parallelTerminal(prepared, result), value }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (worktree) {
        const taskRecord = getRunTask(
          runtime.layout.ledger,
          runtime.run.id,
          prepared.reference.documentId,
          prepared.reference.taskId,
        )
        const completedBeforeGitSettlement =
          taskRecord?.status === "completed" || taskRecord?.status === "completed_with_override"
        worktree =
          completedBeforeGitSettlement && worktree.status === "active"
            ? transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
                status: "failed",
                failureReason: reason.slice(0, 4_096),
                updatedAt: runtime.dependencies.now(),
              })
            : retainParallelWorktree(runtime, worktree, reason)
      }
      const failed: TaskExecutionResult = {
        status:
          error instanceof RalphError && error.exitCode === EXIT_CODES.blocked
            ? "blocked"
            : "failed",
        exitCode: error instanceof RalphError ? error.exitCode : EXIT_CODES.operationalError,
        reason,
        terminalFailure:
          error instanceof RalphError && error.exitCode === EXIT_CODES.verificationFailed,
      }
      const value: ParallelTaskExecutionValue = {
        prepared,
        result: failed,
        claimSetId: claimSet.id,
        capacityLeaseId: dispatch.capacityLeaseId,
        workerId: dispatch.workerId,
        ...(worktree ? { worktree } : {}),
        error,
      }
      return { terminal: parallelTerminal(prepared, failed), value, error }
    }
  }

  const integrateWave = async (
    results: readonly ParallelWorkerResult<ParallelTaskExecutionValue>[],
  ): Promise<void> => {
    const ordered = [...results].sort((left, right) => {
      const leftOrder = left.value?.prepared.candidate.graphOrder ?? Number.MAX_SAFE_INTEGER
      const rightOrder = right.value?.prepared.candidate.graphOrder ?? Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || left.terminal.taskId.localeCompare(right.terminal.taskId)
    })
    let expectedTargetHead = await parallelGitText({
      git,
      cwd: runtime.workspaceRoot,
      args: ["rev-parse", "HEAD"],
      operation: "integration target HEAD refresh",
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    })
    const firstCompleted = ordered.find(
      (item) => item.terminal.outcome === "completed" && item.value?.worktree !== undefined,
    )?.value
    if (firstCompleted && expectedTargetHead !== firstCompleted.prepared.expectedTargetHead) {
      integrationBlockedReason =
        `Integration target changed while workers were executing: expected ` +
        `${firstCompleted.prepared.expectedTargetHead}, observed ${expectedTargetHead}`
      for (const item of ordered) {
        if (item.terminal.outcome !== "completed" || !item.value?.worktree) continue
        item.value.worktree = retainParallelWorktree(
          runtime,
          item.value.worktree,
          integrationBlockedReason,
        )
      }
      return
    }
    for (const settled of ordered) {
      const value = settled.value
      if (settled.terminal.outcome !== "completed" || !value?.worktree) continue
      if (value.prepared.candidate.attemptId !== settled.terminal.attemptId) {
        throw new RalphError(
          "RALPH_PARALLEL_INTEGRATION_ATTEMPT_MISMATCH",
          "Integration result does not match its claimed attempt",
          { exitCode: EXIT_CODES.conflict },
        )
      }
      capacityPort.assertOwned(value.capacityLeaseId)
      const claimSet = claimPort.assertOwned(value.claimSetId)
      let worktree = value.worktree
      if (worktree.status !== "integrating") {
        worktree = transitionGitWorktreeRecord(
          runtime.layout.ledger,
          worktree.id,
          worktree.revision,
          { status: "integrating", updatedAt: runtime.dependencies.now() },
        )
      }
      const strategy = value.prepared.resolution.options.gitPolicy.value.create_pr
        ? "create-pr"
        : normalizeGitIntegrationStrategy(
            value.prepared.resolution.options.parallelPolicy.value.integration_strategy,
          )
      const evidenceRefs: string[] = []
      const integrationAttemptId = `integration-${randomUUID()}`
      const gates: GitIntegrationGatePort = {
        async run(gate) {
          if (gate.phase === "before-integration") {
            claimPort.assertOwned(claimSet.id)
            capacityPort.assertOwned(value.capacityLeaseId)
            return {
              passed: true,
              summary: "Command-owned claims and target HEAD are still valid",
              evidenceRefs: [],
            }
          }
          if (strategy === "none") {
            return {
              passed: true,
              summary:
                "No target mutation requested; task gates remain bound to the isolated evidence",
              evidenceRefs: [],
            }
          }
          const task = taskFor(runtime.graph, value.prepared.reference)
          const verifications = await runVerifications(task.verification, {
            workspaceRoot: runtime.workspaceRoot,
            ...(runtime.dependencies.gateRegistryFactory
              ? {
                  registry: runtime.dependencies.gateRegistryFactory({
                    workspaceRoot: runtime.workspaceRoot,
                    workspaceId: runtime.workspaceId,
                    runId: runtime.run.id,
                    documentId: value.prepared.reference.documentId,
                    taskId: value.prepared.reference.taskId,
                    attemptId: integrationAttemptId,
                  }),
                }
              : {}),
            ...(runtime.signal ? { signal: runtime.signal } : {}),
            environment: runtime.environment,
            environmentRoot: join(runtime.runLayout.root, "environment", integrationAttemptId),
            skipTests: value.prepared.resolution.options.skipTests.value,
            skipLint: value.prepared.resolution.options.skipLint.value,
            skipGateIdsOrCategories: new Set(value.prepared.resolution.options.skipGates.value),
            noGates: value.prepared.resolution.options.noGates.value,
            fast: value.prepared.resolution.options.fast.value,
            force: value.prepared.resolution.options.force.value,
            failFast: value.prepared.resolution.options.failFast.value,
            persistOutput: async (gateId, stream, output) => {
              const ref = await persistGateOutput(
                runtime,
                integrationAttemptId,
                gateId,
                stream,
                output,
              )
              evidenceRefs.push(ref)
              return ref
            },
          })
          const blocking = verifications.filter(isBlockingVerificationFailure)
          claimPort.assertOwned(claimSet.id)
          capacityPort.assertOwned(value.capacityLeaseId)
          return {
            passed: blocking.length === 0,
            summary:
              blocking.length === 0
                ? `Post-integration gates settled (${verifications.length})`
                : `Blocking post-integration gates failed: ${blocking.map((item) => item.gateId).join(", ")}`,
            evidenceRefs: [...new Set(evidenceRefs)],
          }
        },
      }
      let integration: GitIntegrationRecord
      try {
        integration = await integrateTaskWorktree({
          ledgerPath: runtime.layout.ledger,
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          taskId: value.prepared.reference.taskId,
          order: value.prepared.candidate.graphOrder,
          integrationAttemptId,
          worktree,
          targetWorktreePath: runtime.workspaceRoot,
          expectedTargetHead,
          strategy,
          claimSet,
          git,
          gates,
          ...(runtime.dependencies.pullRequests
            ? { pullRequests: runtime.dependencies.pullRequests }
            : {}),
          ...(strategy === "create-pr"
            ? {
                pullRequest: {
                  title: `ralph: ${value.prepared.reference.taskId}`,
                  body: `Command-owned parallel delivery for run ${runtime.run.id}, task ${value.prepared.reference.taskId}.`,
                  draft: value.prepared.resolution.options.gitPolicy.value.draft_pr,
                  labels: value.prepared.resolution.options.gitPolicy.value.pr_labels,
                },
              }
            : {}),
          ...(runtime.signal ? { signal: runtime.signal } : {}),
          now: () => new Date(runtime.dependencies.now()),
        })
      } catch (error) {
        transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
          status: "failed",
          failureReason:
            error instanceof Error ? error.message.slice(0, 4_096) : String(error).slice(0, 4_096),
          updatedAt: runtime.dependencies.now(),
        })
        value.error = error
        integrationBlockedReason = error instanceof Error ? error.message : String(error)
        break
      }
      value.integration = integration
      assertExecutionNotCancelled(runtime.signal, "fault-after-git-integration-persisted")
      await Promise.resolve(runtime.dependencies.fault("after-git-integration-persisted"))
      if (integration.status === "passed" && strategy !== "none") {
        worktree = transitionGitWorktreeRecord(
          runtime.layout.ledger,
          worktree.id,
          worktree.revision,
          {
            status: "integrated",
            ...(integration.resultHead ? { head: integration.resultHead } : {}),
            updatedAt: runtime.dependencies.now(),
          },
        )
        if (integration.resultHead) expectedTargetHead = integration.resultHead
        await recompileRuntime(runtime)
        const retention = value.prepared.resolution.options.gitPolicy.value.worktree_retention
        if (retention === "always-keep") {
          worktree = transitionGitWorktreeRecord(
            runtime.layout.ledger,
            worktree.id,
            worktree.revision,
            {
              status: "retained",
              failureReason: "Successful worktree retained by explicit policy",
              updatedAt: runtime.dependencies.now(),
            },
          )
        } else {
          try {
            worktree = await removeManagedTaskWorktree({
              ledgerPath: runtime.layout.ledger,
              record: worktree,
              git,
              ...(runtime.signal ? { signal: runtime.signal } : {}),
              now: () => new Date(runtime.dependencies.now()),
            })
          } catch (cleanupError) {
            worktree = transitionGitWorktreeRecord(
              runtime.layout.ledger,
              worktree.id,
              worktree.revision,
              {
                status: "retained",
                failureReason: `Integration passed, but safe worktree cleanup was deferred: ${
                  cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
                }`.slice(0, 4_096),
                updatedAt: runtime.dependencies.now(),
              },
            )
          }
        }
        if (
          value.prepared.resolution.options.gitPolicy.value.auto_checkpoints ||
          value.prepared.resolution.options.gitPolicy.value.checkpoint_after_task
        ) {
          await createParallelCheckpoint(
            runtime,
            git,
            `Parallel integration settled for ${value.prepared.reference.taskId}`,
          )
        }
      } else if (integration.status === "conflicted") {
        transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
          status: "conflicted",
          failureReason: integration.summary ?? "Integration conflict requires explicit resolution",
          updatedAt: runtime.dependencies.now(),
        })
        integrationBlockedReason =
          integration.summary ?? "Integration conflict requires explicit resolution"
        break
      } else if (integration.status === "failed") {
        transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
          status: "failed",
          failureReason: integration.summary ?? "Integration failed",
          updatedAt: runtime.dependencies.now(),
        })
        integrationBlockedReason = integration.summary ?? "Integration failed"
        break
      } else {
        transitionGitWorktreeRecord(runtime.layout.ledger, worktree.id, worktree.revision, {
          status: "retained",
          failureReason:
            integration.summary ??
            (integration.status === "pr-created"
              ? "Pull request created; external integration remains pending"
              : "Integration paused for explicit review"),
          updatedAt: runtime.dependencies.now(),
        })
        if (integration.status !== "passed" && integration.status !== "pr-created") {
          integrationBlockedReason = integration.summary ?? `Integration ${integration.status}`
          break
        }
      }
    }
  }

  const reconciliationAllowance = rootParallelReferences(runtime.graph).length
  const maximumParallelDispatches = Math.max(
    1,
    input.childCoordinator.budget.limit <= Number.MAX_SAFE_INTEGER - reconciliationAllowance
      ? input.childCoordinator.budget.limit + reconciliationAllowance
      : Number.MAX_SAFE_INTEGER,
  )
  let executionOutcome:
    | { readonly kind: "returned"; readonly result: RunExecutionResult }
    | { readonly kind: "threw"; readonly error: unknown }
    | undefined
  let finalReleaseFailure: RalphError | undefined
  try {
    const summary = await executeParallelWaves<ParallelTaskExecutionValue>({
      policy,
      maximumDispatches: maximumParallelDispatches,
      snapshot,
      claimPort,
      capacityPort,
      workerId: (candidate, ordinal) =>
        `worker-${ordinal + 1}-${candidate.attemptId}`.slice(0, 512),
      execute: executeWorker,
      integrate: integrateWave,
      observe(observation) {
        appendEvent(runtime.layout.ledger, {
          type: `parallel.${observation.type}`,
          scope: "run",
          streamId: runtime.run.id,
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          ...(observation.taskId ? { taskId: observation.taskId } : {}),
          ...(observation.attemptId ? { attemptId: observation.attemptId } : {}),
          ...(observation.workerId ? { workerId: observation.workerId } : {}),
          level: observation.type === "claim-conflict" ? "warn" : "info",
          payload: persistenceSafe(runtime, observation.details ?? {}),
        })
      },
    })
    if (!integrationBlockedReason) await recompileRuntime(runtime)
    const records = listRunTasks(runtime.layout.ledger, runtime.run.id)
    const remaining = records.filter(
      (task) => task.status !== "completed" && task.status !== "completed_with_override",
    )
    const worktrees = latestParallelWorktrees(runtime)
    const integrations = parallelIntegrationsByWorktree(runtime)
    const deliveryBlockers: string[] = []
    for (const record of records.filter(
      (task) => task.status === "completed" || task.status === "completed_with_override",
    )) {
      const worktree = worktrees.get(`${record.documentId}\u0000${record.taskId}`)
      if (!worktree) continue
      const delivery = integrations.get(worktree.id) ?? []
      const external = delivery.find(
        (item) =>
          item.status === "pr-created" || (item.status === "passed" && item.strategy === "none"),
      )
      const delivered = delivery.some(
        (item) => item.status === "passed" && item.strategy !== "none",
      )
      const blocked = delivery.find(
        (item) =>
          item.status === "pending" ||
          item.status === "running" ||
          item.status === "conflicted" ||
          item.status === "failed" ||
          item.status === "paused",
      )
      if (delivered) {
      } else if (external) {
        deliveryBlockers.push(
          `${record.taskId}: ${external.status === "pr-created" ? `pull request ${external.pullRequestRef ?? external.id}` : "no-merge worktree retained"}`,
        )
      } else if (blocked) {
        deliveryBlockers.push(`${record.taskId}: integration ${blocked.status} (${blocked.id})`)
      } else if (worktree.status !== "integrated" && worktree.status !== "removed") {
        deliveryBlockers.push(
          `${record.taskId}: isolated worktree ${worktree.status} at ${worktree.worktreePath}`,
        )
      }
    }
    const failedResult = [...summary.terminals]
      .reverse()
      .find((item) => item.terminal.outcome !== "completed")?.value?.result
    const persistedRun = getRun(runtime.layout.ledger, runtime.run.id)
    if (persistedRun) runtime.run = persistedRun
    let runStatus: RunStatus
    let exitCode: ExitCode
    let reason: string
    if (externalStop && (remaining.length > 0 || deliveryBlockers.length > 0)) {
      if (runtime.run.status === "stopping") {
        runtime.run = transitionStoredRun(runtime.layout.ledger, runtime.run, "interrupted", {
          stopReason: "The supervisor acknowledged a durable CLI stop request",
          eventType: "run.stop.acknowledged",
        })
      }
      runStatus = runtime.run.status === "cancelled" ? "cancelled" : "interrupted"
      exitCode = EXIT_CODES.interrupted
      reason = "Parallel execution stopped at a durable integration boundary"
    } else if (remaining.length === 0 && deliveryBlockers.length === 0) {
      runStatus = "completed"
      exitCode = EXIT_CODES.success
      reason =
        "Every direct root task was completed and integrated through command-owned boundaries"
    } else if (deliveryBlockers.length > 0) {
      runStatus = "waiting"
      exitCode = EXIT_CODES.blocked
      reason = `Parallel delivery requires explicit continuation: ${deliveryBlockers.join("; ")}`
    } else if (failedResult) {
      runStatus =
        failedResult.status === "blocked"
          ? "waiting"
          : failedResult.terminalFailure || policy.failFast
            ? "failed"
            : "interrupted"
      exitCode = failedResult.exitCode
      reason = failedResult.reason
    } else if (taskBudgetExhausted(input.childCoordinator)) {
      runStatus = "interrupted"
      exitCode = EXIT_CODES.budgetExceeded
      reason = taskBudgetBoundaryReason(input.childCoordinator)
    } else {
      runStatus = "waiting"
      exitCode = EXIT_CODES.blocked
      reason = integrationBlockedReason ?? summary.reason
    }
    if (runtime.run.status !== runStatus) {
      runtime.run = transitionStoredRun(runtime.layout.ledger, runtime.run, runStatus, {
        stopReason: reason,
        ...(runStatus === "completed" || runStatus === "failed"
          ? { finishedAt: runtime.dependencies.now() }
          : {}),
        eventType: runStatus === "completed" ? "run.completed" : "run.stopped",
      })
    }
    const report = await persistReport(runtime, runStatus, [reason, summary.reason])
    await flushOutbox(runtime.layout)
    const reportedResolution = lastPrepared?.resolution ?? {
      options: runtime.options,
      optionsHash: runtime.options.contentHash,
      notices: optionNotices(runtime.options),
    }
    executionOutcome = {
      kind: "returned",
      result: {
        kind: "executed",
        runId: runtime.run.id,
        mode: "parallel",
        status: runStatus,
        exitCode,
        reason,
        plan: buildExecutionPlan({
          graph: runtime.graph,
          options: reportedResolution.options,
          sourceKind: runtime.source.kind,
          ...(runtime.source.kind === "ad-hoc"
            ? { sourceDescriptionHash: runtime.source.descriptionHash }
            : {}),
          completedTasks: listRunTasks(runtime.layout.ledger, runtime.run.id).filter(
            (task) => task.status === "completed" || task.status === "completed_with_override",
          ).length,
          ...(lastPrepared
            ? {
                selection: {
                  task: lastPrepared.reference,
                  reason: "parallel command-owned dispatch",
                  dependencyOverride: false,
                },
              }
            : {}),
          backendAvailable:
            lastPrepared?.backend !== undefined || lastPrepared?.existingWorktree !== undefined,
          runAlreadyExists: input.resumedExistingRun,
        }),
        effectiveOptions: reportedResolution.options,
        optionsHash: reportedResolution.optionsHash,
        notices: reportedResolution.notices,
        report,
      },
    }
  } catch (error) {
    executionOutcome = { kind: "threw", error }
  } finally {
    const releases = await Promise.allSettled([
      claimPort.releaseAll("Parallel root execution settled"),
      capacityPort.releaseAll("Parallel root execution settled"),
    ])
    const failedRelease = releases.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    )
    if (failedRelease) {
      finalReleaseFailure = new RalphError(
        "RALPH_PARALLEL_FINAL_RELEASE_FAILED",
        "Parallel execution settled but a durable claim or capacity lease could not be released",
        { exitCode: EXIT_CODES.operationalError, cause: failedRelease.reason },
      )
    }
  }
  if (finalReleaseFailure) throw finalReleaseFailure
  if (executionOutcome?.kind === "threw") throw executionOutcome.error
  if (!executionOutcome) {
    throw new RalphError(
      "RALPH_PARALLEL_EXECUTION_OUTCOME_MISSING",
      "Parallel execution settled without returning a result or reporting a failure",
      { exitCode: EXIT_CODES.operationalError },
    )
  }
  return executionOutcome.result
}

export async function executeRun(input: ExecuteRunInput): Promise<RunExecutionResult> {
  assertExecutionNotCancelled(input.signal, "run-preflight")
  const resumeDiscovery = ResumeDiscoverySchema.parse(input.resumeDiscovery ?? "auto")
  if (input.newRun && input.runId) {
    throw new RalphError(
      "RALPH_NEW_RUN_ID_CONFLICT",
      "A fresh run cannot target an existing run ID",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (input.runId && resumeDiscovery === "never") {
    throw new RalphError(
      "RALPH_RUN_ID_RESUME_CONFLICT",
      "An explicit run ID cannot be combined with disabled resume discovery",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (!input.optionResolution) {
    throw new RalphError(
      "RALPH_RUN_OPTION_RESOLUTION_REQUIRED",
      "Execution requires the materialized config/profile/CLI option-resolution context",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Pass optionResolution so every selected task can deterministically re-resolve its own overrides.",
      },
    )
  }
  const options = EffectiveRunOptionsSchema.parse(input.effectiveOptions)
  const workspaceRoot = await realpath(resolve(input.workspaceRoot))
  assertExecutionNotCancelled(input.signal, "workspace-resolution")
  const status = await inspectWorkspace(workspaceRoot, { exact: true })
  assertExecutionNotCancelled(input.signal, "workspace-inspection")
  if (!status.initialized || !status.workspaceId) {
    throw new RalphError(
      "RALPH_WORKSPACE_NOT_INITIALIZED",
      "Ralph v2 workspace is not initialized",
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: workspaceRoot,
        hint: "Run `ralph-next init` first.",
      },
    )
  }
  const workspaceId = status.workspaceId
  const sourceRequest = requestedExecutionSource(input)
  if (sourceRequest.kind === "ad-hoc" && options.mode.value !== "once") {
    throw new RalphError(
      "RALPH_AD_HOC_MODE_INVALID",
      "Ad-hoc descriptions are supported only by the once command mode",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (sourceRequest.kind === "ad-hoc" && options.task.value !== null) {
    throw new RalphError(
      "RALPH_AD_HOC_TASK_SELECTION_CONFLICT",
      "An ad-hoc description cannot be combined with a PRD task selector",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const materializedSource = await materializeExecutionSource(workspaceRoot, sourceRequest)
  const { graph, rootFile, source } = materializedSource
  assertExecutionNotCancelled(input.signal, "work-source-compilation")
  const previewRecords = initialTaskRecords("dry-run", graph, graph.rootDocumentId)
  const previewRequestedTask = options.task.value ?? undefined
  const previewSelection = selectTask({
    graph,
    records: new Map(previewRecords.map((record) => [taskRefKey(record), record])),
    documentId: graph.rootDocumentId,
    ...(previewRequestedTask ? { requestedTask: previewRequestedTask } : {}),
    force: options.force.value,
  })
  if (options.dryRun.value) {
    const dryLayout = workspaceLayout(workspaceRoot)
    const discoveredRun = findResumableRun(dryLayout.ledger, {
      workspaceId,
      rootPrdFile: rootFile,
      rootPrdId: graph.rootDocumentId,
      definitionHash: graph.definitionHash,
      ...(input.runId ? { runId: input.runId } : {}),
    })
    if (resumeDiscovery === "never" && discoveredRun && !input.newRun) {
      throw new RalphError(
        "RALPH_RESUME_DISABLED_CONFLICT",
        `Compatible non-terminal run exists but resume discovery is disabled: ${discoveredRun.id}`,
        {
          exitCode: EXIT_CODES.conflict,
          hint: "Use --resume auto|required to continue it, or --new-run to explicitly request a fresh run.",
        },
      )
    }
    const resumable = input.newRun || resumeDiscovery === "never" ? undefined : discoveredRun
    if ((input.runId || resumeDiscovery === "required") && !resumable) {
      throw new RalphError(
        "RALPH_RESUMABLE_RUN_NOT_FOUND",
        input.runId
          ? `Compatible resumable run not found: ${input.runId}`
          : "No compatible non-terminal run is available to resume",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (resumable && !effectiveOptionsAreResumeCompatible(resumable.effectiveOptions, options)) {
      throw new RalphError(
        "RALPH_RESUME_OPTIONS_CONFLICT",
        "Effective execution options changed for a resumable run",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    const resumableRecords = resumable ? listRunTasks(dryLayout.ledger, resumable.id) : undefined
    if (resumableRecords && resumable && source.kind === "prd") {
      const events = readEvents(dryLayout.ledger)
      assertTaskMarkerParity(
        graph,
        resumableRecords,
        revisionRecoveryTaskKeys(events, resumable.id),
        isolatedParallelCompletionKeys({
          ledgerPath: dryLayout.ledger,
          workspaceId,
          runId: resumable.id,
          mode: resumable.mode,
        }),
      )
    }
    const dryRootSelection = resumableRecords
      ? selectTask({
          graph,
          records: recordsMap(resumableRecords),
          documentId: graph.rootDocumentId,
          ...(previewRequestedTask ? { requestedTask: previewRequestedTask } : {}),
          force: options.force.value,
        })
      : previewSelection
    const plannedTarget = dryRootSelection
      ? deepestPlannedExecutionTarget({
          graph,
          selection: dryRootSelection,
          ledger: dryLayout.ledger,
          ...(resumable ? { runId: resumable.id } : {}),
          force: options.force.value,
        })
      : { selection: undefined, blockedChildDocumentId: undefined }
    const drySelection = plannedTarget.selection
    const plannedResolution = drySelection
      ? resolveTaskOptions(graph, input.optionResolution, drySelection.task)
      : { options, optionsHash: options.contentHash, notices: optionNotices(options) }
    const plannedOptions = plannedResolution.options
    const previewBackend = drySelection
      ? await input.dependencies.resolveBackend(plannedOptions.executorProfile.value, {
          workspaceRoot,
          workspaceId,
          controlRoot: workspaceRoot,
          effectiveOptions: plannedOptions,
          dryRun: true,
          ...(input.optionResolution.config ? { config: input.optionResolution.config } : {}),
        })
      : undefined
    const previewJudgeKind = evaluationKind(plannedOptions.evaluationMode.value)
    const previewJudgeProfile =
      previewJudgeKind === "external"
        ? plannedOptions.judgeProfile?.value
        : previewJudgeKind === "self"
          ? plannedOptions.executorProfile.value
          : undefined
    let previewJudge: JudgeBackend | undefined
    if (
      drySelection &&
      previewJudgeKind &&
      previewJudgeProfile &&
      input.dependencies.resolveJudge
    ) {
      try {
        previewJudge = await input.dependencies.resolveJudge(previewJudgeProfile, {
          workspaceRoot,
          workspaceId,
          controlRoot: workspaceRoot,
          kind: previewJudgeKind,
          effectiveOptions: plannedOptions,
          dryRun: true,
          ...(input.optionResolution.config ? { config: input.optionResolution.config } : {}),
        })
      } catch (error) {
        if (error instanceof RalphError && error.exitCode !== EXIT_CODES.providerUnavailable) {
          throw error
        }
      }
    }
    const judgeRequiredButUnavailable =
      previewJudgeKind !== undefined &&
      previewJudge === undefined &&
      plannedOptions.judgeUnavailablePolicy.value !== "deterministic"
    const plan = buildExecutionPlan({
      graph,
      options: plannedOptions,
      sourceKind: source.kind,
      ...(source.kind === "ad-hoc" ? { sourceDescriptionHash: source.descriptionHash } : {}),
      ...(resumableRecords
        ? {
            completedTasks: resumableRecords.filter(
              (task) => task.status === "completed" || task.status === "completed_with_override",
            ).length,
          }
        : {}),
      ...(drySelection ? { selection: drySelection } : {}),
      backendAvailable: previewBackend !== undefined,
      ...(previewJudgeKind ? { judgeAvailable: previewJudge !== undefined } : {}),
      runAlreadyExists: resumable !== undefined,
    })
    return {
      kind: "dry-run",
      ...(resumable ? { runId: resumable.id } : {}),
      mode: options.mode.value,
      status: "planned",
      exitCode: plannedTarget.blockedChildDocumentId
        ? EXIT_CODES.blocked
        : drySelection && (!previewBackend || judgeRequiredButUnavailable)
          ? EXIT_CODES.providerUnavailable
          : EXIT_CODES.success,
      reason: drySelection
        ? !previewBackend
          ? `Executor profile/backend is unavailable: ${plannedOptions.executorProfile.value}`
          : judgeRequiredButUnavailable
            ? `Judge profile/backend is unavailable: ${previewJudgeProfile ?? "not configured"}`
            : source.kind === "ad-hoc"
              ? `Ad-hoc request ${source.descriptionHash} is ready for command-owned execution`
              : `Deepest executable task ${taskRefKey(drySelection.task)} is ready for command-owned execution`
        : plannedTarget.blockedChildDocumentId
          ? `Child document ${plannedTarget.blockedChildDocumentId} has incomplete work but no eligible direct task`
          : resumable?.status === "waiting"
            ? "No pending task is eligible; the resumable run remains waiting"
            : "No pending task is eligible",
      plan,
      effectiveOptions: plannedOptions,
      optionsHash: plannedResolution.optionsHash,
      notices: plannedResolution.notices,
    }
  }
  const layout = workspaceLayout(workspaceRoot)
  const releaseEventRetention = registerLedgerEventRetention(
    layout.ledger,
    telemetryPolicyForEffectiveOptions(options).event_retention,
  )
  const lock = await acquireExecutionLock({
    layout,
    workspaceId,
    ...(input.runId ? { runId: input.runId } : {}),
    command: "ralph-next run",
    capabilityScope: ["run:supervise", "workspace:write"],
  })
  const releaseRedaction = registerLedgerRedactionSecrets(
    layout.ledger,
    secretValuesFromEnvironment(input.environment ?? process.env),
  )
  let runtime: Runtime | undefined
  let controlSession: RunSupervisorControlSession | undefined
  let disposeCombinedSignal = (): void => undefined
  let removeCancellationListener = (): void => undefined
  try {
    assertExecutionNotCancelled(input.signal, "execution-lock")
    const currentSource =
      sourceRequest.kind === "prd"
        ? await materializeExecutionSource(workspaceRoot, sourceRequest)
        : materializedSource
    const currentGraph = currentSource.graph
    const rootFile = currentSource.rootFile
    const dependencies = runtimeDependencies(input.dependencies)
    const discoveredRun = findResumableRun(layout.ledger, {
      workspaceId,
      rootPrdFile: rootFile,
      rootPrdId: currentGraph.rootDocumentId,
      definitionHash: currentGraph.definitionHash,
      ...(input.runId ? { runId: input.runId } : {}),
    })
    if (resumeDiscovery === "never" && discoveredRun && !input.newRun) {
      throw new RalphError(
        "RALPH_RESUME_DISABLED_CONFLICT",
        `Compatible non-terminal run exists but resume discovery is disabled: ${discoveredRun.id}`,
        {
          exitCode: EXIT_CODES.conflict,
          hint: "Use --resume auto|required to continue it, or --new-run to explicitly request a fresh run.",
        },
      )
    }
    let run = input.newRun || resumeDiscovery === "never" ? undefined : discoveredRun
    const resumedExistingRun = run !== undefined
    if (run) {
      const persistedSource = run.source
      const sourceMismatch =
        currentSource.source.kind === "ad-hoc"
          ? persistedSource?.kind !== "ad-hoc" ||
            persistedSource.descriptionHash !== currentSource.source.descriptionHash ||
            persistedSource.description !== currentSource.source.description
          : persistedSource?.kind === "ad-hoc" ||
            (persistedSource?.kind === "prd" &&
              (persistedSource.prdId !== currentSource.source.prdId ||
                persistedSource.prdFile !== currentSource.source.prdFile))
      if (sourceMismatch) {
        throw new RalphError(
          "RALPH_RESUME_SOURCE_MISMATCH",
          "The requested work source does not match the immutable source of the resumable run",
          {
            exitCode: EXIT_CODES.conflict,
            details: {
              runId: run.id,
              persistedSourceKind: persistedSource?.kind ?? "legacy-prd",
              requestedSourceKind: currentSource.source.kind,
            },
          },
        )
      }
    }
    let pendingRecoveryDecision: PendingRecoveryDecision | undefined
    let recoveryAcceptance: PendingRecoveryDecision | undefined
    if (resumedExistingRun && run) {
      try {
        pendingRecoveryDecision = findPendingRecoveryDecision(readEvents(layout.ledger), run.id)
      } catch (error) {
        throw new RalphError(
          "RALPH_RECOVERY_DECISION_INVALID",
          "The latest recovery decision record is malformed and cannot be resumed safely",
          {
            exitCode: EXIT_CODES.conflict,
            hint: "Inspect the immutable event ledger and recovery manifest; do not bypass the decision with a new run.",
            details: { cause: error instanceof Error ? error.message : String(error) },
          },
        )
      }
    }
    if (input.acceptWorkspaceChanges) {
      if (!resumedExistingRun || !run) {
        throw new RalphError(
          "RALPH_RECOVERY_ACCEPTANCE_REQUIRES_RESUME",
          "--accept-workspace-changes requires an existing compatible run with a pending recovery decision",
          {
            exitCode: EXIT_CODES.invalidUsage,
            hint: "Inspect the run with `ralph-next status run`; ordinary new runs cannot pre-authorize workspace changes.",
          },
        )
      }
      if (!pendingRecoveryDecision) {
        throw new RalphError(
          "RALPH_RECOVERY_DECISION_NOT_FOUND",
          "No unresolved workspace-change decision is available for explicit continuation",
          {
            exitCode: EXIT_CODES.conflict,
            hint: "Use `ralph-next status run` to inspect the current run before resuming normally.",
          },
        )
      }
      recoveryAcceptance = pendingRecoveryDecision
    }
    let preparedBackend: { taskKey: string; profile: string; backend: ExecutionBackend } | undefined
    if (!run) {
      const conflictingRun = listRuns(layout.ledger, {
        workspaceId,
        statuses: ["created", "running", "stopping", "interrupted", "waiting"],
      }).find(
        (candidate) =>
          candidate.rootPrdFile === rootFile && (!input.runId || candidate.id === input.runId),
      )
      if (
        conflictingRun &&
        (conflictingRun.rootPrdId !== currentGraph.rootDocumentId ||
          conflictingRun.definitionHash !== currentGraph.definitionHash)
      ) {
        throw new RalphError(
          "RALPH_EXECUTION_DEFINITION_CHANGED",
          "PRD definition changed while resumable work still exists",
          {
            exitCode: EXIT_CODES.conflict,
            details: {
              runId: conflictingRun.id,
              expectedRootPrdId: conflictingRun.rootPrdId,
              actualRootPrdId: currentGraph.rootDocumentId,
              expected: conflictingRun.definitionHash,
              actual: currentGraph.definitionHash,
            },
            hint: "Restore the prepared PRD definition or explicitly resolve the existing run before starting a new definition.",
          },
        )
      }
    }
    if ((input.runId || resumeDiscovery === "required") && !run) {
      throw new RalphError(
        "RALPH_RESUMABLE_RUN_NOT_FOUND",
        input.runId
          ? `Compatible resumable run not found: ${input.runId}`
          : "No compatible non-terminal run is available to resume",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (run && !effectiveOptionsAreResumeCompatible(run.effectiveOptions, options)) {
      throw new RalphError(
        "RALPH_RESUME_OPTIONS_CONFLICT",
        "Effective execution options changed for a resumable run",
        {
          exitCode: EXIT_CODES.conflict,
          details: { expected: run.effectiveOptionsHash, actual: options.contentHash },
        },
      )
    }
    const sandboxTerminationBarriers = scanWorkspaceSandboxTerminationBarriers({
      ledgerPath: layout.ledger,
      workspaceId,
      ...(run ? { currentRunId: run.id } : {}),
    })
    if (!run) {
      // Reserve the command-owned identity before backend construction so all
      // optional captures are scoped to the exact run even though persistence
      // still happens only after provider/backend preflight succeeds.
      const newRunId = dependencies.id("run")
      const newRunRecords = initialTaskRecords(
        "new-run-preflight",
        currentGraph,
        currentGraph.rootDocumentId,
      )
      const newRunSelection = selectTask({
        graph: currentGraph,
        records: new Map(newRunRecords.map((record) => [taskRefKey(record), record])),
        documentId: currentGraph.rootDocumentId,
        ...(previewRequestedTask ? { requestedTask: previewRequestedTask } : {}),
        force: options.force.value,
      })
      if (
        options.mode.value !== "parallel" &&
        newRunSelection &&
        !taskFor(currentGraph, newRunSelection.task).subPrd
      ) {
        const resolution = resolveTaskOptions(
          currentGraph,
          input.optionResolution,
          newRunSelection.task,
        )
        const profile = resolution.options.executorProfile.value
        const backend = await dependencies.resolveBackend(profile, {
          workspaceRoot,
          runId: newRunId,
          workspaceId,
          controlRoot: workspaceRoot,
          effectiveOptions: resolution.options,
          dryRun: false,
          ...(input.optionResolution.config ? { config: input.optionResolution.config } : {}),
        })
        if (!backend) throw executorUnavailable(profile)
        preparedBackend = {
          taskKey: taskRefKey(newRunSelection.task),
          profile,
          backend,
        }
      }
      const createdAt = dependencies.now()
      const telemetry = telemetryPolicyForEffectiveOptions(options)
      run = createRun(layout.ledger, {
        id: newRunId,
        schemaVersion: 1,
        workspaceId,
        rootPrdId: currentGraph.rootDocumentId,
        rootPrdFile: rootFile,
        source: currentSource.source,
        definitionHash: currentGraph.definitionHash,
        graphHash: currentGraph.graphHash,
        mode: options.mode.value,
        status: "created",
        effectiveOptionsHash: options.contentHash,
        effectiveOptions: options,
        createdAt,
        event: {
          type: "run.created",
          payload: {
            telemetry: {
              persistRawOutput: telemetry.persist_raw_output,
              redact: telemetry.redact,
              rawPersistenceEnabled: telemetry.persist_raw_output && telemetry.redact,
              eventRetention: telemetry.event_retention,
              redactionBoundary: telemetry.redact ? "configured-and-mandatory" : "mandatory-no-raw",
            },
          },
        },
      })
      materializeRunTasks(layout.ledger, {
        runId: run.id,
        tasks: initialTaskRecords(run.id, currentGraph, currentGraph.rootDocumentId).map(
          (task) => ({
            documentId: task.documentId,
            taskId: task.taskId,
            status: task.status,
            markerContentHash: task.markerContentHash,
          }),
        ),
        event: { type: "run.tasks.materialized" },
      })
    }
    await lock.bindRun(run.id)
    lock.assertOwned()
    const isolated = await ensureRunLayout(layout, run.id)
    runtime = {
      workspaceRoot,
      workspaceId,
      layout,
      runLayout: isolated,
      graph: currentGraph,
      source: currentSource.source,
      protectedPrdPaths: currentSource.protectedPrdPaths,
      run,
      options,
      invocationOptions: options,
      optionResolution: input.optionResolution,
      environment: input.environment ?? process.env,
      interactive: input.interactive === true,
      pendingRecoveryDecision,
      recoveryAcceptance,
      ...(lock.takeover ? { writerTakeover: lock.takeover } : {}),
      ...(input.dependencies.processSupervisor
        ? { processSupervisor: input.dependencies.processSupervisor }
        : {}),
      assertWriterLease: () => {
        lock.assertOwned()
      },
      ...(input.signal ? { signal: input.signal } : {}),
      dependencies,
    }
    const markRunStopping = (
      reason = "Execution cancellation was requested by the command",
    ): void => {
      if (!runtime) return
      const persisted = getRun(layout.ledger, runtime.run.id)
      if (persisted) runtime.run = persisted
      if (runtime.run.status !== "running") return
      try {
        runtime.assertWriterLease()
      } catch {
        return
      }
      runtime.run = transitionStoredRun(layout.ledger, runtime.run, "stopping", {
        stopReason: reason,
        eventType: "run.stopping",
      })
    }
    if (input.signal) {
      const stopFromCancellation = (): void => markRunStopping()
      input.signal.addEventListener("abort", stopFromCancellation, { once: true })
      removeCancellationListener = () =>
        input.signal?.removeEventListener("abort", stopFromCancellation)
      if (input.signal.aborted) stopFromCancellation()
    }
    assertExecutionNotCancelled(input.signal, "run-reconciliation")
    await reconcileCompletions(runtime)
    assertExecutionNotCancelled(input.signal, "run-reconciliation")
    assertLedgerMarkerParity(runtime)
    alignRunGraphHash(runtime)
    if (runtime.run.status === "stopping") {
      runtime.run = transitionStoredRun(layout.ledger, runtime.run, "interrupted", {
        stopReason: "A previously requested stop was reconciled before resume",
        eventType: "run.stop.reconciled",
      })
    }
    if (runtime.run.status !== "running") {
      assertExecutionNotCancelled(input.signal, "run-start")
      runtime.run = transitionStoredRun(layout.ledger, runtime.run, "running", {
        startedAt: runtime.run.startedAt ?? dependencies.now(),
        stopReason: null,
        eventType: run.status === "created" ? "run.started" : "run.resumed",
      })
    }
    if (input.dependencies.supervisorControl) {
      controlSession = await input.dependencies.supervisorControl.activate({
        workspaceRoot,
        workspaceId,
        runId: runtime.run.id,
        ownerInstanceId: lock.ownerInstanceId,
        lease: lock.lease,
        async onStop(request) {
          runtime?.assertWriterLease()
          if (!runtime) throw new Error("Run supervisor callback lost its runtime")
          const persisted = getRun(layout.ledger, runtime.run.id)
          if (!persisted) throw new Error("Run supervisor callback cannot find its durable run")
          runtime.run = persisted
          const previousStatus = persisted.status
          if (["completed", "failed", "cancelled"].includes(previousStatus)) {
            return {
              previousStatus,
              status: previousStatus,
              disposition: "already-terminal",
              requestedAt: request.requestedAt,
              delivery: "supervisor",
            }
          }
          if (previousStatus === "stopping") {
            return {
              previousStatus,
              status: previousStatus,
              disposition: "already-requested",
              requestedAt: request.requestedAt,
              delivery: "supervisor",
            }
          }
          markRunStopping(request.reason)
          return {
            previousStatus,
            status: runtime.run.status,
            disposition: "requested",
            requestedAt: request.requestedAt,
            delivery: "supervisor",
          }
        },
        async onContextRotation(request) {
          runtime?.assertWriterLease()
          if (!runtime) throw new Error("Context-control callback lost its runtime")
          const current = getRun(layout.ledger, runtime.run.id)
          if (!current) throw new Error("Context-control callback cannot find its durable run")
          runtime.run = current
          const nextBoundary =
            runtime.options.mode.value === "wiggum"
              ? ("next-model-call" as const)
              : ("next-task" as const)
          if (["completed", "failed", "cancelled"].includes(current.status)) {
            return {
              disposition: "not-applicable",
              requestedAt: request.requestedAt,
              nextBoundary,
            }
          }
          appendEvent(layout.ledger, {
            type: "context.rotation.requested",
            scope: "run",
            streamId: runtime.run.id,
            workspaceId,
            runId: runtime.run.id,
            correlationId: request.requestId,
            level: "info",
            payload: persistenceSafe(runtime, {
              schemaVersion: 1,
              requestId: request.requestId,
              reason: request.reason,
              requestedAt: request.requestedAt,
              nextBoundary,
            }),
          })
          return {
            disposition: "requested",
            requestedAt: request.requestedAt,
            nextBoundary,
          }
        },
      })
      runtime.controlSession = controlSession
      const combined = combineRunSignals(input.signal, controlSession.signal)
      disposeCombinedSignal = combined.dispose
      if (combined.signal) runtime.signal = combined.signal
    }
    await input.onRunReady?.({
      runId: runtime.run.id,
      workspaceId,
      resumed: resumedExistingRun,
    })
    if (input.signal?.aborted) markRunStopping()
    assertExecutionNotCancelled(runtime.signal, "run-start")

    const childCoordinator = createCommandOwnedChildCoordinator(runtime, {
      ownerInstanceId: lock.ownerInstanceId,
      pid: lock.lease.pid,
      processStartToken: lock.lease.processStartToken,
      hostname: lock.lease.hostname,
    })
    await reconcilePrecompletedTaskChildren(runtime, runtime.graph.rootDocumentId, childCoordinator)
    assertExecutionNotCancelled(runtime.signal, "precompleted-child-reconciliation")

    if (options.mode.value === "parallel") {
      return await executeParallelRoot({
        runtime,
        childCoordinator,
        sandboxTerminationBarriers,
        resumedExistingRun,
        ...(options.task.value ? { requestedTask: options.task.value } : {}),
        ownerInstanceId: lock.ownerInstanceId,
      })
    }

    let rootSelectionsThisInvocation = 0
    let firstNonSuccess: TaskExecutionResult | undefined
    let lastSelection: ReturnType<typeof selectTask>
    let lastTaskResolution: ResolvedRunOptions = {
      options: runtime.run.effectiveOptions,
      optionsHash: runtime.run.effectiveOptionsHash,
      notices: optionNotices(runtime.run.effectiveOptions),
    }
    let lastBackendAvailable = false
    let lastJudgeAvailable: boolean | undefined
    const rootDocumentId = runtime.graph.rootDocumentId
    const sandboxTerminationBlockedTaskKeys = new Set(
      [...sandboxTerminationBarriers.currentRunTaskIds].map(
        (taskId) => `${rootDocumentId}\u0000${taskId}`,
      ),
    )
    const deferredTaskKeys = new Set<string>(sandboxTerminationBlockedTaskKeys)
    let externallyRequestedStop: "stopping" | "cancelled" | undefined
    const observeExternalStop = (): boolean => {
      const currentRuntime = runtime
      if (!currentRuntime) return false
      const persisted = getRun(layout.ledger, currentRuntime.run.id)
      if (persisted?.status !== "stopping" && persisted?.status !== "cancelled") return false
      currentRuntime.run = persisted
      externallyRequestedStop = persisted.status
      return true
    }
    while (!taskBudgetExhausted(childCoordinator)) {
      lock.assertOwned()
      if (observeExternalStop()) break
      assertExecutionNotCancelled(runtime.signal, "task-selection")
      const liveSandboxTerminationBarriers = scanWorkspaceSandboxTerminationBarriers({
        ledgerPath: runtime.layout.ledger,
        workspaceId: runtime.workspaceId,
        currentRunId: runtime.run.id,
      })
      for (const taskId of liveSandboxTerminationBarriers.currentRunTaskIds) {
        const taskKey = `${runtime.graph.rootDocumentId}\u0000${taskId}`
        sandboxTerminationBlockedTaskKeys.add(taskKey)
        deferredTaskKeys.add(taskKey)
      }
      const requestedTask =
        rootSelectionsThisInvocation === 0 ? (options.task.value ?? undefined) : undefined
      const selection = selectTask({
        graph: runtime.graph,
        records: recordsMap(listRunTasks(layout.ledger, runtime.run.id)),
        documentId: runtime.graph.rootDocumentId,
        ...(requestedTask ? { requestedTask } : {}),
        force: options.force.value,
        excludedTaskKeys: deferredTaskKeys,
      })
      if (!selection) break
      lastSelection = selection
      if (selection.dependencyOverride) {
        appendEvent(layout.ledger, {
          type: "task.selection.overridden",
          scope: "run",
          streamId: runtime.run.id,
          workspaceId: runtime.workspaceId,
          runId: runtime.run.id,
          documentId: selection.task.documentId,
          taskId: selection.task.taskId,
          level: "warn",
          payload: { force: true, reason: selection.reason },
        })
      }
      const taskResolution = effectiveOptionsForTask(runtime, selection.task)
      rootSelectionsThisInvocation += 1
      lastTaskResolution = taskResolution
      let taskResult = await supervisePreauthoredTaskChild(
        runtime,
        selection.task,
        taskResolution.options,
        childCoordinator,
      )
      if (!taskResult) {
        if (taskBudgetExhausted(childCoordinator)) {
          taskResult = taskBudgetBoundaryResult(childCoordinator)
          preparedBackend = undefined
        } else {
          const profile = taskResolution.options.executorProfile.value
          const selectionKey = taskRefKey(selection.task)
          const backend =
            preparedBackend?.taskKey === selectionKey && preparedBackend.profile === profile
              ? preparedBackend.backend
              : await dependencies.resolveBackend(profile, {
                  workspaceRoot,
                  runId: runtime.run.id,
                  workspaceId: runtime.workspaceId,
                  controlRoot: runtime.workspaceRoot,
                  effectiveOptions: taskResolution.options,
                  dryRun: false,
                  ...(runtime.optionResolution.config
                    ? { config: runtime.optionResolution.config }
                    : {}),
                })
          assertExecutionNotCancelled(runtime.signal, "backend-resolution")
          preparedBackend = undefined
          if (!backend) throw executorUnavailable(profile)
          lastBackendAvailable = true
          if (
            !(await consumeTaskExecutionBudget(
              childCoordinator,
              runtime,
              selection.task,
              taskResolution,
            ))
          ) {
            taskResult = taskBudgetBoundaryResult(childCoordinator)
          } else {
            taskResult = await executeTask(runtime, selection.task, taskResolution.options, backend)
            await recordTaskExecutionOutcome(childCoordinator, runtime, selection.task, taskResult)
          }
        }
      } else {
        preparedBackend = undefined
      }
      assertExecutionNotCancelled(runtime.signal, "task-settlement")
      lastJudgeAvailable = taskResult.judgeAvailable
      if (taskResult.status === "completed" || taskResult.status === "completed_with_override") {
        if (observeExternalStop()) break
        if (taskBudgetExhausted(childCoordinator)) break
        continue
      }
      firstNonSuccess ??= taskResult
      deferredTaskKeys.add(taskRefKey(selection.task))
      appendEvent(layout.ledger, {
        type: "task.deferred_after_failure",
        scope: "run",
        streamId: runtime.run.id,
        workspaceId: runtime.workspaceId,
        runId: runtime.run.id,
        documentId: selection.task.documentId,
        taskId: selection.task.taskId,
        level: "warn",
        payload: { failFast: options.failFast.value, reason: taskResult.reason },
      })
      if (observeExternalStop()) break
      if (taskResult.stopRun || taskBudgetExhausted(childCoordinator) || options.failFast.value) {
        break
      }
    }

    lock.assertOwned()
    assertExecutionNotCancelled(runtime.signal, "run-settlement")
    const remaining = listRunTasks(layout.ledger, runtime.run.id).filter(
      (task) => task.status !== "completed" && task.status !== "completed_with_override",
    )
    const sandboxTerminationBlockedRemaining = remaining.some((task) =>
      sandboxTerminationBlockedTaskKeys.has(taskRefKey(task)),
    )
    let runStatus: RunStatus
    let exitCode: ExitCode
    let reason: string
    if (externallyRequestedStop && remaining.length > 0) {
      if (runtime.run.status === "stopping") {
        runtime.run = transitionStoredRun(layout.ledger, runtime.run, "interrupted", {
          stopReason: "The supervisor acknowledged a durable CLI stop request",
          eventType: "run.stop.acknowledged",
        })
      }
      runStatus = runtime.run.status === "cancelled" ? "cancelled" : "interrupted"
      exitCode = EXIT_CODES.interrupted
      reason =
        runStatus === "cancelled"
          ? "The run was cancelled by an external control command"
          : "The run stopped at a durable boundary and remains resumable"
    } else if (remaining.length === 0) {
      runStatus = "completed"
      exitCode = EXIT_CODES.success
      reason =
        runtime.source.kind === "ad-hoc"
          ? "The ad-hoc request is durably completed with evidence; no PRD marker was changed"
          : "Every direct task in the root PRD is durably completed"
    } else if (firstNonSuccess?.budgetBoundary) {
      runStatus = "interrupted"
      exitCode = firstNonSuccess.exitCode
      reason = firstNonSuccess.reason
    } else if (firstNonSuccess && firstNonSuccess.exitCode !== EXIT_CODES.success) {
      runStatus =
        firstNonSuccess.status === "blocked"
          ? "waiting"
          : firstNonSuccess.terminalFailure || options.failFast.value
            ? "failed"
            : "interrupted"
      exitCode = firstNonSuccess.exitCode
      reason = firstNonSuccess.reason
    } else if (taskBudgetExhausted(childCoordinator)) {
      runStatus = "interrupted"
      exitCode = options.mode.value === "once" ? EXIT_CODES.success : EXIT_CODES.budgetExceeded
      reason = taskBudgetBoundaryReason(childCoordinator)
    } else if (sandboxTerminationBlockedRemaining) {
      runStatus = "waiting"
      exitCode = EXIT_CODES.blocked
      reason =
        "A task in this run remains blocked because its sandbox termination is not durably confirmed"
    } else {
      runStatus = "waiting"
      exitCode = EXIT_CODES.blocked
      reason = "No task is eligible while incomplete work remains; the run is waiting"
    }
    runtime.run = transitionStoredRun(layout.ledger, runtime.run, runStatus, {
      stopReason: reason,
      ...(runStatus === "completed" || runStatus === "failed"
        ? { finishedAt: dependencies.now() }
        : {}),
      eventType: runStatus === "completed" ? "run.completed" : "run.stopped",
    })
    const report = await persistReport(runtime, runStatus, [reason])
    await flushOutbox(layout)
    const lastExecution = childCoordinator.budget.lastExecution
    const lastExecutedReference = lastExecution
      ? runtime.graph.topologicalOrder.find(
          (reference) =>
            reference.documentId === lastExecution.documentId &&
            reference.taskId === lastExecution.taskId,
        )
      : undefined
    if (lastExecution && !lastExecutedReference) {
      throw new RalphError(
        "RALPH_EXECUTION_REPORT_TASK_MISSING",
        "The last budgeted task execution is absent from the compiled graph",
        {
          exitCode: EXIT_CODES.conflict,
          details: { lastExecution },
        },
      )
    }
    const reportedSelection = lastExecutedReference
      ? {
          task: lastExecutedReference,
          reason: "eligible" as const,
          dependencyOverride: false,
        }
      : lastSelection
    const reportedResolution = lastExecution?.resolution ?? lastTaskResolution
    const reportedJudgeAvailable = lastExecution?.judgeAvailable ?? lastJudgeAvailable
    return {
      kind: "executed",
      runId: runtime.run.id,
      mode: options.mode.value,
      status: runStatus,
      exitCode,
      reason,
      plan: buildExecutionPlan({
        graph: runtime.graph,
        options: reportedResolution.options,
        sourceKind: runtime.source.kind,
        ...(runtime.source.kind === "ad-hoc"
          ? { sourceDescriptionHash: runtime.source.descriptionHash }
          : {}),
        completedTasks: listRunTasks(runtime.layout.ledger, runtime.run.id).filter(
          (task) => task.status === "completed" || task.status === "completed_with_override",
        ).length,
        ...(reportedSelection ? { selection: reportedSelection } : {}),
        backendAvailable: lastExecution !== undefined || lastBackendAvailable,
        ...(reportedJudgeAvailable !== undefined ? { judgeAvailable: reportedJudgeAvailable } : {}),
        runAlreadyExists: resumedExistingRun,
      }),
      effectiveOptions: reportedResolution.options,
      optionsHash: reportedResolution.optionsHash,
      notices: reportedResolution.notices,
      report,
    }
  } catch (error) {
    let writerLeaseOwned = false
    try {
      lock.assertOwned()
      writerLeaseOwned = true
    } catch {
      // Once ownership is uncertain, this process must not persist recovery transitions.
    }
    if (
      writerLeaseOwned &&
      runtime &&
      (runtime.run.status === "running" || runtime.run.status === "stopping")
    ) {
      const exitCode = error instanceof RalphError ? error.exitCode : EXIT_CODES.operationalError
      const target: RunStatus =
        exitCode === EXIT_CODES.verificationFailed ? "failed" : "interrupted"
      const reason = persistenceSafe(
        runtime,
        error instanceof Error ? error.message : String(error),
      )
      runtime.run = transitionStoredRun(runtime.layout.ledger, runtime.run, target, {
        stopReason: reason,
        ...(target === "failed" ? { finishedAt: runtime.dependencies.now() } : {}),
        eventType: target === "failed" ? "run.failed" : "run.interrupted",
      })
      await persistReport(runtime, target, [reason])
      await flushOutbox(runtime.layout)
    }
    throw error
  } finally {
    removeCancellationListener()
    if (controlSession && runtime) {
      try {
        runtime.assertWriterLease()
        for (const pending of controlSession.pendingContextRotations()) {
          appendEvent(runtime.layout.ledger, {
            type: "context.rotation.not_applied",
            scope: "run",
            streamId: runtime.run.id,
            workspaceId: runtime.workspaceId,
            runId: runtime.run.id,
            correlationId: pending.requestId,
            level: "warn",
            payload: persistenceSafe(runtime, {
              schemaVersion: 1,
              requestId: pending.requestId,
              reason: pending.reason,
              requestedAt: pending.requestedAt,
              cause: "run-settled-before-next-context-boundary",
            }),
          })
        }
        await flushOutbox(runtime.layout)
      } catch {
        // A lost writer lease forbids recording a synthetic control outcome.
      }
      await controlSession.close().catch(() => undefined)
    }
    disposeCombinedSignal()
    releaseEventRetention()
    releaseRedaction()
    await lock.release()
  }
}
