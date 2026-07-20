import { createHash } from "node:crypto"
import { z } from "zod"
import {
  AllowedCommandSchema,
  DEFAULT_CONFIG,
  EvaluationRubricConfigSchema,
  GitConfigSchema,
  HeadlessAskSchema,
  ParallelConfigSchema,
  PortableRelativeScopeSchema,
  ProfileParametersSchema,
  RunModeSchema,
  SandboxConfigSchema,
  SecurityConfigSchema,
  SecurityModeSchema,
  TelemetryConfigSchema,
  ToolRulesSchema,
} from "./contracts"
import { JudgeAssessmentSchema } from "./judge"
import { RecoveryContextPointerSchema } from "./recovery"
import { ChildUsageSummarySchema } from "./usage-summary"

const NonEmptyStringSchema = z.string().min(1)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const TimestampSchema = z.iso.datetime({ offset: true })
const CounterSchema = z.number().int().nonnegative()

export const RunStatusSchema = z.enum([
  "created",
  "running",
  "stopping",
  "interrupted",
  "waiting",
  "completed",
  "failed",
  "cancelled",
])
export type RunStatus = z.infer<typeof RunStatusSchema>

/**
 * Controls whether a command may discover an existing non-terminal run.
 * `never` does not make a previous run terminal and therefore cannot silently
 * create competing work; `--new-run` is the separate, explicit creation
 * authority at the command boundary.
 */
export const ResumeDiscoverySchema = z.enum(["auto", "never", "required"])
export type ResumeDiscovery = z.infer<typeof ResumeDiscoverySchema>

export const RunStopModeSchema = z.enum(["graceful", "force"])
export type RunStopMode = z.infer<typeof RunStopModeSchema>

export const TaskRuntimeStatusSchema = z.enum([
  "pending",
  "eligible",
  "active",
  "verifying",
  "evaluating",
  "retryable_failed",
  "interrupted",
  "blocked",
  "rejected",
  "cancelled",
  "completed",
  "completed_with_override",
])
export type TaskRuntimeStatus = z.infer<typeof TaskRuntimeStatusSchema>

export const AttemptPhaseSchema = z.enum([
  "created",
  "preparing",
  "invoking",
  "tools",
  "settling",
  "evidence",
  "gates",
  "judgment",
  "decision",
])
export type AttemptPhase = z.infer<typeof AttemptPhaseSchema>

export const AttemptStatusSchema = z.enum(["active", "passed", "failed", "interrupted", "rejected"])
export type AttemptStatus = z.infer<typeof AttemptStatusSchema>

export const EffectiveOptionSourceSchema = z.enum([
  "builtin",
  "global",
  "workspace",
  "env",
  "profile",
  "prd",
  "task",
  "cli",
])
export type EffectiveOptionSource = z.infer<typeof EffectiveOptionSourceSchema>

function effectiveOption<T extends z.ZodType>(value: T) {
  return z
    .object({
      value,
      source: EffectiveOptionSourceSchema,
      sourceRef: NonEmptyStringSchema.optional(),
    })
    .strict()
}

export const NoChangePolicySchema = z.enum([
  "require-change",
  "allow-no-change",
  "fail-on-no-change",
  "retry-on-no-change",
])
export type NoChangePolicy = z.infer<typeof NoChangePolicySchema>

export const NormalizedNoChangePolicySchema = z
  .object({
    value: NoChangePolicySchema,
    original: NonEmptyStringSchema,
    notice: NonEmptyStringSchema.optional(),
  })
  .strict()
export type NormalizedNoChangePolicy = z.infer<typeof NormalizedNoChangePolicySchema>

export const EffectiveNoChangePolicySchema = NormalizedNoChangePolicySchema.extend({
  source: EffectiveOptionSourceSchema,
  sourceRef: NonEmptyStringSchema.optional(),
}).strict()
export type EffectiveNoChangePolicy = z.infer<typeof EffectiveNoChangePolicySchema>

export const EffectiveRunOptionsSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: effectiveOption(RunModeSchema),
    executorProfile: effectiveOption(NonEmptyStringSchema),
    judgeProfile: effectiveOption(NonEmptyStringSchema).optional(),
    executorProvider: effectiveOption(NonEmptyStringSchema).optional(),
    executorModel: effectiveOption(NonEmptyStringSchema).optional(),
    executorCredential: effectiveOption(NonEmptyStringSchema.nullable()).optional(),
    executorVariant: effectiveOption(NonEmptyStringSchema.nullable()).optional(),
    executorParameters: effectiveOption(ProfileParametersSchema).optional(),
    judgeProvider: effectiveOption(NonEmptyStringSchema).optional(),
    judgeModel: effectiveOption(NonEmptyStringSchema).optional(),
    judgeCredential: effectiveOption(NonEmptyStringSchema.nullable()).optional(),
    judgeVariant: effectiveOption(NonEmptyStringSchema.nullable()).optional(),
    judgeParameters: effectiveOption(ProfileParametersSchema).optional(),
    task: effectiveOption(NonEmptyStringSchema.nullable()),
    force: effectiveOption(z.boolean()),
    dryRun: effectiveOption(z.boolean()),
    skipTests: effectiveOption(z.boolean()),
    skipLint: effectiveOption(z.boolean()),
    skipGates: effectiveOption(z.array(NonEmptyStringSchema)),
    noGates: effectiveOption(z.boolean()).default({ value: false, source: "builtin" }),
    fast: effectiveOption(z.boolean()),
    noCommit: effectiveOption(z.boolean()),
    failFast: effectiveOption(z.boolean()),
    maxTasks: effectiveOption(z.number().int().positive()),
    delayMs: effectiveOption(CounterSchema),
    maxIterations: effectiveOption(z.number().int().positive()),
    maxModelCallsPerAttempt: effectiveOption(z.number().int().positive()),
    maxNoChangeAttempts: effectiveOption(CounterSchema),
    noChangePolicy: EffectiveNoChangePolicySchema,
    evaluationMode: effectiveOption(
      z.enum(["deterministic-only", "self", "external", "manual"]),
    ).default({ value: "deterministic-only", source: "builtin" }),
    judgeThreshold: effectiveOption(z.number().int().min(0).max(100)).default({
      value: 85,
      source: "builtin",
    }),
    maxRevisionAttempts: effectiveOption(CounterSchema).default({ value: 3, source: "builtin" }),
    judgeCallRetries: effectiveOption(CounterSchema).default({ value: 2, source: "builtin" }),
    judgeUnavailablePolicy: effectiveOption(z.enum(["deterministic", "pause", "fail"])).default({
      value: "pause",
      source: "builtin",
    }),
    blockingJudgeSeverities: effectiveOption(
      z
        .array(z.enum(["info", "minor", "major", "critical"]))
        .refine((values) => new Set(values).size === values.length, "Severities must be unique"),
    ).default({ value: ["critical"], source: "builtin" }),
    judgeRubric: effectiveOption(EvaluationRubricConfigSchema.nullable()).optional(),
    judgeExhaustedPolicy: effectiveOption(z.enum(["manual-review", "fail", "stop-run"])).default({
      value: "manual-review",
      source: "builtin",
    }),
    securityMode: effectiveOption(SecurityModeSchema),
    headlessAsk: effectiveOption(HeadlessAskSchema),
    toolRules: effectiveOption(ToolRulesSchema),
    allowedCommands: effectiveOption(
      z
        .array(AllowedCommandSchema)
        .refine((values) => new Set(values).size === values.length, "Commands must be unique"),
    ),
    readPaths: effectiveOption(
      z
        .array(PortableRelativeScopeSchema)
        .refine((values) => new Set(values).size === values.length, "Read paths must be unique"),
    ),
    writePaths: effectiveOption(
      z
        .array(PortableRelativeScopeSchema)
        .refine((values) => new Set(values).size === values.length, "Write paths must be unique"),
    ),
    allowShell: effectiveOption(z.boolean()),
    parallelPolicy: effectiveOption(ParallelConfigSchema).default({
      value: DEFAULT_CONFIG.parallel,
      source: "builtin",
    }),
    gitPolicy: effectiveOption(GitConfigSchema).default({
      value: DEFAULT_CONFIG.git,
      source: "builtin",
    }),
    sandboxPolicy: effectiveOption(SandboxConfigSchema).default({
      value: DEFAULT_CONFIG.sandbox,
      source: "builtin",
    }),
    securityPolicy: effectiveOption(SecurityConfigSchema).default({
      value: DEFAULT_CONFIG.security,
      source: "builtin",
    }),
    /**
     * New runs persist the command-resolved telemetry policy. It remains
     * optional so ledgers created before this field existed keep their exact
     * v1 content hash; legacy snapshots use DEFAULT_CONFIG.telemetry at the
     * runtime boundary instead of silently adopting current config.
     */
    telemetryPolicy: effectiveOption(TelemetryConfigSchema).optional(),
    contentHash: Sha256Schema,
  })
  .strict()
export type EffectiveRunOptions = z.infer<typeof EffectiveRunOptionsSchema>

export const AttemptCountersSchema = z
  .object({
    modelCalls: CounterSchema,
    toolCalls: CounterSchema,
    wiggumIterations: CounterSchema,
    executorRetries: CounterSchema,
    watchdogRestarts: CounterSchema.default(0),
    judgeTransportRetries: CounterSchema,
    revisionAttempts: CounterSchema,
    noChangeAttempts: CounterSchema,
    gateRuns: CounterSchema,
  })
  .strict()
export type AttemptCounters = z.infer<typeof AttemptCountersSchema>

export const GitBaselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(["git", "workspace"]),
    revision: NonEmptyStringSchema.nullable(),
    branch: NonEmptyStringSchema.nullable(),
    dirty: z.boolean(),
    statusHash: Sha256Schema,
    workspaceSnapshotHash: Sha256Schema,
    capturedAt: TimestampSchema,
  })
  .strict()
export type GitBaseline = z.infer<typeof GitBaselineSchema>

export const ChangedFileSchema = z
  .object({
    path: NonEmptyStringSchema,
    kind: z.enum(["created", "modified", "deleted", "renamed"]),
    previousPath: NonEmptyStringSchema.optional(),
    contentHash: Sha256Schema.optional(),
    sizeBytes: CounterSchema.optional(),
  })
  .strict()
export type ChangedFile = z.infer<typeof ChangedFileSchema>

export const MissingChangeContentSchema = z
  .object({
    path: NonEmptyStringSchema,
    side: z.enum(["before", "after"]),
    reason: NonEmptyStringSchema,
  })
  .strict()
export type MissingChangeContent = z.infer<typeof MissingChangeContentSchema>

export const ChangeEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    policy: NoChangePolicySchema,
    status: z.enum(["changed", "unchanged", "out_of_scope"]),
    files: z.array(ChangedFileSchema),
    outsideScopePaths: z.array(NonEmptyStringSchema),
    reproducible: z.boolean(),
    missingContent: z.array(MissingChangeContentSchema),
    diffHash: Sha256Schema.optional(),
    diffRef: NonEmptyStringSchema.optional(),
    attemptDiffHash: Sha256Schema.optional(),
    attemptDiffRef: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.diffHash) !== Boolean(value.diffRef)) {
      context.addIssue({
        code: "custom",
        message: "Cumulative diff hash and reference must be provided together",
        path: [value.diffHash ? "diffRef" : "diffHash"],
      })
    }
    if (Boolean(value.attemptDiffHash) !== Boolean(value.attemptDiffRef)) {
      context.addIssue({
        code: "custom",
        message: "Attempt diff hash and reference must be provided together",
        path: [value.attemptDiffHash ? "attemptDiffRef" : "attemptDiffHash"],
      })
    }
    if (value.reproducible !== (value.missingContent.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Reproducible change evidence must have no missing before/after content",
        path: [value.reproducible ? "missingContent" : "reproducible"],
      })
    }
    if (value.status === "unchanged" && value.files.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Unchanged evidence cannot contain changed files",
        path: ["files"],
      })
    }
    if (value.status === "out_of_scope" && value.outsideScopePaths.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Out-of-scope evidence must name at least one path",
        path: ["outsideScopePaths"],
      })
    }
  })
export type ChangeEvidence = z.infer<typeof ChangeEvidenceSchema>

export const ArtifactEvidenceSchema = z
  .object({
    artifactId: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    contentHash: Sha256Schema,
    sizeBytes: CounterSchema,
    immutableRef: NonEmptyStringSchema.optional(),
    status: z.enum(["passed", "failed", "not_checked"]),
    reason: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "failed" && !value.immutableRef) {
      context.addIssue({
        code: "custom",
        message: "Materialized artifact evidence requires an immutable content reference",
        path: ["immutableRef"],
      })
    }
  })
export type ArtifactEvidence = z.infer<typeof ArtifactEvidenceSchema>

export const GateCommandSchema = z
  .object({
    executable: NonEmptyStringSchema,
    args: z.array(z.string()),
    cwd: NonEmptyStringSchema.optional(),
    environmentRefs: z.record(NonEmptyStringSchema, NonEmptyStringSchema).optional(),
    shell: z
      .union([
        z.literal(false),
        z
          .object({
            kind: z.enum(["powershell", "cmd", "sh", "bash", "custom"]),
            executable: NonEmptyStringSchema.optional(),
          })
          .strict(),
      ])
      .optional(),
    timeoutMs: z.number().int().positive(),
    successExitCodes: z.array(z.number().int()).min(1),
    outputLimitBytes: z.number().int().positive(),
  })
  .strict()
export type GateCommand = z.infer<typeof GateCommandSchema>

export const GateStatusSchema = z.enum([
  "passed",
  "failed",
  "timeout",
  "error",
  "skipped_by_cli",
  "skipped_by_policy",
  "not_applicable",
  "unavailable",
])
export type GateStatus = z.infer<typeof GateStatusSchema>

export const GateResultSchema = z
  .object({
    gateId: NonEmptyStringSchema,
    category: NonEmptyStringSchema,
    blocking: z.boolean(),
    skipPolicy: z.enum(["required", "optional", "allowed-to-skip", "never-run"]).optional(),
    criterionIds: z.array(NonEmptyStringSchema).min(1).optional(),
    status: GateStatusSchema,
    command: GateCommandSchema.optional(),
    exitCode: z.number().int().optional(),
    durationMs: CounterSchema,
    attempts: CounterSchema.optional(),
    outputRefs: z.array(NonEmptyStringSchema),
    stdoutBytes: CounterSchema.optional(),
    stderrBytes: CounterSchema.optional(),
    outputTruncated: z.boolean().optional(),
    rawOutputTruncated: z.boolean().optional(),
    reason: NonEmptyStringSchema.optional(),
  })
  .strict()
export type GateResult = z.infer<typeof GateResultSchema>

export const ExecutorOutcomeSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["work_submitted", "blocked_reported"]),
    summary: NonEmptyStringSchema,
    intendedFiles: z.array(NonEmptyStringSchema),
    artifactRefs: z.array(NonEmptyStringSchema),
    suggestedVerifications: z.array(NonEmptyStringSchema),
    risks: z.array(NonEmptyStringSchema),
    reportedAt: TimestampSchema,
  })
  .strict()
export type ExecutorOutcome = z.infer<typeof ExecutorOutcomeSchema>

export const ContextTaskSchema = z
  .object({
    documentId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    result: NonEmptyStringSchema,
    criteria: z.array(
      z
        .object({
          id: NonEmptyStringSchema,
          text: NonEmptyStringSchema,
          weight: z.number().positive().optional(),
          blocking: z.boolean().optional(),
        })
        .strict(),
    ),
    boundaries: z.array(NonEmptyStringSchema),
    notes: z.array(NonEmptyStringSchema).optional(),
    evidenceMode: NonEmptyStringSchema,
    verificationRefs: z.array(NonEmptyStringSchema),
    taskSpecHash: Sha256Schema,
  })
  .strict()
export type ContextTask = z.infer<typeof ContextTaskSchema>

export const ContextBudgetSchema = z
  .object({
    remainingModelCalls: CounterSchema,
    remainingToolCalls: CounterSchema,
    remainingIterations: CounterSchema,
    remainingInputTokens: CounterSchema.optional(),
    remainingOutputTokens: CounterSchema.optional(),
    remainingReasoningTokens: CounterSchema.optional(),
    maxTotalTokens: CounterSchema.optional(),
    maxCost: z
      .object({
        amount: z.number().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .optional(),
    taskTimeout: z
      .object({
        source: NonEmptyStringSchema,
        milliseconds: CounterSchema,
      })
      .strict()
      .optional(),
    deadlineAt: TimestampSchema.optional(),
  })
  .strict()
export type ContextBudget = z.infer<typeof ContextBudgetSchema>

export const DependencyOutputSchema = z
  .object({
    taskId: NonEmptyStringSchema,
    outputRefs: z.array(NonEmptyStringSchema),
  })
  .strict()
export type DependencyOutput = z.infer<typeof DependencyOutputSchema>

export const ContextAssessmentPointerSchema = z
  .object({
    kind: z.literal("assessment"),
    ref: NonEmptyStringSchema,
    sourceAssessmentRef: NonEmptyStringSchema,
    sourceAssessmentId: NonEmptyStringSchema,
    sourceEvidenceBundleId: NonEmptyStringSchema,
    contentHash: Sha256Schema,
    includedHash: Sha256Schema,
    score: z.number().int().min(0).max(100),
    threshold: z.number().int().min(0).max(100),
    truncated: z.boolean(),
  })
  .strict()
export type ContextAssessmentPointer = z.infer<typeof ContextAssessmentPointerSchema>

export const ContextRotationPointerSchema = z
  .object({
    requestId: NonEmptyStringSchema,
    reason: NonEmptyStringSchema,
    requestedAt: TimestampSchema,
    boundary: z.enum(["next-model-call", "next-task"]),
  })
  .strict()
export type ContextRotationPointer = z.infer<typeof ContextRotationPointerSchema>

export const ContextManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    attemptId: NonEmptyStringSchema,
    mode: RunModeSchema,
    sharedContext: z.string(),
    fullPrd: z
      .object({
        ref: NonEmptyStringSchema,
        contentHash: Sha256Schema,
      })
      .strict()
      .optional(),
    task: ContextTaskSchema,
    invariants: z.array(NonEmptyStringSchema),
    parentContextRefs: z.array(NonEmptyStringSchema),
    dependencyOutputs: z.array(DependencyOutputSchema),
    declaredFileRefs: z.array(NonEmptyStringSchema),
    previousAssessmentRef: NonEmptyStringSchema.optional(),
    contextRotation: ContextRotationPointerSchema.optional(),
    revisionFeedback: ContextAssessmentPointerSchema.optional(),
    recovery: RecoveryContextPointerSchema.optional(),
    baseline: GitBaselineSchema,
    budget: ContextBudgetSchema,
    authority: z
      .object({
        taskSelection: z.literal("ralph"),
        taskCompletion: z.literal("ralph-policy"),
        subPrdCreation: z.literal("preauthored-only"),
      })
      .strict(),
    createdAt: TimestampSchema,
    contentHash: Sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "wiggum" && !value.fullPrd) {
      context.addIssue({
        code: "custom",
        message: "Wiggum context requires a full PRD reference and hash",
        path: ["fullPrd"],
      })
    }
    if (value.revisionFeedback && !value.previousAssessmentRef) {
      context.addIssue({
        code: "custom",
        message: "Revision feedback requires an auditable previous assessment reference",
        path: ["previousAssessmentRef"],
      })
    }
  })
export type ContextManifest = z.infer<typeof ContextManifestSchema>

export const EvidenceBundleV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    attemptId: NonEmptyStringSchema,
    taskSpecHash: Sha256Schema,
    baseline: GitBaselineSchema,
    changes: ChangeEvidenceSchema,
    artifacts: z.array(ArtifactEvidenceSchema),
    gates: z.array(GateResultSchema),
    executorOutcome: ExecutorOutcomeSchema.optional(),
    contextManifestHash: Sha256Schema,
    createdAt: TimestampSchema,
    contentHash: Sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ["diffHash", "diffRef", "attemptDiffHash", "attemptDiffRef"] as const) {
      if (!value.changes[field]) {
        context.addIssue({
          code: "custom",
          message: "Evidence bundles require cumulative and per-attempt diff manifest bindings",
          path: ["changes", field],
        })
      }
    }
  })
export type EvidenceBundleV1 = z.infer<typeof EvidenceBundleV1Schema>

export const EvidenceSourceSchema = z.enum(["reported", "derived", "estimated", "unavailable"])
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>

export const ArtifactEvidenceV2Schema = z
  .object({
    artifactId: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    contentHash: Sha256Schema,
    sizeBytes: CounterSchema,
    mediaType: NonEmptyStringSchema,
    immutableRef: NonEmptyStringSchema.optional(),
    status: z.enum(["passed", "failed", "not_checked"]),
    validation: z
      .object({
        status: z.enum(["passed", "failed", "not_requested", "unavailable"]),
        schemaRef: NonEmptyStringSchema.optional(),
        reason: NonEmptyStringSchema.optional(),
      })
      .strict(),
    reason: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "failed" && !value.immutableRef) {
      context.addIssue({
        code: "custom",
        message: "Materialized artifact evidence requires an immutable content reference",
        path: ["immutableRef"],
      })
    }
  })
export type ArtifactEvidenceV2 = z.infer<typeof ArtifactEvidenceV2Schema>

export const EvidenceToolCallSchema = z
  .object({
    intentId: NonEmptyStringSchema,
    intentRef: NonEmptyStringSchema,
    modelCallId: NonEmptyStringSchema,
    providerToolCallId: NonEmptyStringSchema,
    tool: NonEmptyStringSchema,
    argumentsHash: Sha256Schema,
    risk: z.enum(["read", "write", "process", "network", "external-effect", "destructive"]),
    effectClass: z.enum([
      "read-only",
      "workspace-write",
      "process",
      "network",
      "external-effect",
      "destructive",
    ]),
    authorization: z.enum(["allowed", "denied", "asked"]),
    recoveryStrategy: z.enum([
      "safe-to-retry",
      "verify-preconditions",
      "inspect-process",
      "manual-reconciliation",
      "never-retry",
    ]),
    requestedAt: TimestampSchema,
    settlement: z
      .object({
        id: NonEmptyStringSchema,
        ref: NonEmptyStringSchema,
        outcome: z.enum([
          "succeeded",
          "failed",
          "nonzero",
          "denied",
          "timeout",
          "cancelled",
          "interrupted",
          "needs-reconciliation",
        ]),
        resultHash: Sha256Schema,
        effectRefs: z.array(NonEmptyStringSchema),
        outputRefs: z.array(NonEmptyStringSchema),
        errorCode: NonEmptyStringSchema.optional(),
        settledAt: TimestampSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
export type EvidenceToolCall = z.infer<typeof EvidenceToolCallSchema>

export const EvidenceUsageSchema = z
  .object({
    source: EvidenceSourceSchema,
    semantics: z.literal("final"),
    input: CounterSchema.optional(),
    inputNonCached: CounterSchema.optional(),
    cacheRead: CounterSchema.optional(),
    cacheWrite: CounterSchema.optional(),
    output: CounterSchema.optional(),
    reasoning: CounterSchema.optional(),
    total: CounterSchema.optional(),
    cost: z
      .object({
        amount: z.number().finite().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        source: z.enum(["reported", "derived", "estimated"]).optional(),
        priceSnapshotIds: z.array(NonEmptyStringSchema),
      })
      .strict()
      .optional(),
    providerRawRefs: z.array(NonEmptyStringSchema),
    providerCallCount: CounterSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.source === "unavailable" &&
      [
        value.input,
        value.inputNonCached,
        value.cacheRead,
        value.cacheWrite,
        value.output,
        value.reasoning,
        value.total,
        value.cost,
      ].some((item) => item !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Unavailable evidence usage cannot contain measured values",
        path: ["source"],
      })
    }
  })
export type EvidenceUsage = z.infer<typeof EvidenceUsageSchema>

const EvidenceCounterLimitSchema = z
  .object({
    maximum: CounterSchema,
    source: z.enum(["task", "profile", "task+profile", "command"]),
  })
  .strict()

export const EvidenceLimitsSchema = z
  .object({
    modelCallsPerAttempt: EvidenceCounterLimitSchema,
    toolCallsPerModelCall: EvidenceCounterLimitSchema.optional(),
    inputTokens: EvidenceCounterLimitSchema.optional(),
    outputTokens: EvidenceCounterLimitSchema.optional(),
    reasoningTokens: EvidenceCounterLimitSchema.optional(),
    totalTokens: EvidenceCounterLimitSchema.optional(),
    cost: EvidenceCounterLimitSchema.extend({
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
      .strict()
      .optional(),
    taskTimeout: z
      .object({ source: NonEmptyStringSchema, milliseconds: CounterSchema })
      .strict()
      .optional(),
    deadlineAt: TimestampSchema.optional(),
    maxRevisionAttempts: EvidenceCounterLimitSchema.optional(),
  })
  .strict()
export type EvidenceLimits = z.infer<typeof EvidenceLimitsSchema>

export const EvidenceProfileSnapshotSchema = z
  .object({
    role: z.literal("executor"),
    profileId: NonEmptyStringSchema,
    backendId: NonEmptyStringSchema,
    provider: NonEmptyStringSchema.optional(),
    model: NonEmptyStringSchema.optional(),
    variant: NonEmptyStringSchema.optional(),
    metadataAvailability: z.enum(["reported", "partial", "unavailable"]),
    capabilities: z
      .object({
        streaming: z.boolean(),
        toolCalling: z.union([z.boolean(), z.enum(["ralph", "internal", "unavailable"])]),
        cancellation: z.boolean(),
        usage: z.enum(["reported", "estimated", "unavailable"]),
      })
      .strict(),
    declaredLimits: z
      .object({
        maxInputTokens: CounterSchema.optional(),
        maxOutputTokens: CounterSchema.optional(),
        maxReasoningTokens: CounterSchema.optional(),
        maxTotalTokens: CounterSchema.optional(),
        maxCost: z
          .object({
            amount: z.number().finite().nonnegative(),
            currency: z.string().regex(/^[A-Z]{3}$/),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
export type EvidenceProfileSnapshot = z.infer<typeof EvidenceProfileSnapshotSchema>

export const EvidenceContextBindingSchema = z
  .object({
    manifestHash: Sha256Schema,
    manifestRef: NonEmptyStringSchema,
    mode: RunModeSchema,
    previousAssessmentRef: NonEmptyStringSchema.optional(),
  })
  .strict()
export type EvidenceContextBinding = z.infer<typeof EvidenceContextBindingSchema>

export const EvidencePriorAttemptSchema = z
  .object({
    attemptId: NonEmptyStringSchema,
    ordinal: z.number().int().positive(),
    status: AttemptStatusSchema,
    evidenceBundleId: NonEmptyStringSchema.optional(),
    completionStatus: z
      .enum(["passed", "failed", "revision_required", "blocked", "overridden"])
      .optional(),
  })
  .strict()
export type EvidencePriorAttempt = z.infer<typeof EvidencePriorAttemptSchema>

export const EvidenceAssessmentRefSchema = z
  .object({
    kind: z.enum(["executor", "self", "external"]),
    ref: NonEmptyStringSchema,
    sourceAttemptId: NonEmptyStringSchema.optional(),
  })
  .strict()
export type EvidenceAssessmentRef = z.infer<typeof EvidenceAssessmentRefSchema>

export const EvidenceTruncationSchema = z
  .object({
    source: z.enum(["context", "gate", "tool", "usage", "artifact", "change", "assessment"]),
    field: NonEmptyStringSchema,
    reason: NonEmptyStringSchema,
    originalHash: Sha256Schema.optional(),
    originalBytes: CounterSchema.optional(),
    includedBytes: CounterSchema.optional(),
    originalCount: CounterSchema.optional(),
    includedCount: CounterSchema.optional(),
    ref: NonEmptyStringSchema.optional(),
  })
  .strict()
export type EvidenceTruncation = z.infer<typeof EvidenceTruncationSchema>

export const MissingEvidenceSchema = z
  .object({
    source: z.enum([
      "context",
      "gate",
      "tool",
      "usage",
      "artifact",
      "change",
      "assessment",
      "security",
    ]),
    code: NonEmptyStringSchema,
    message: NonEmptyStringSchema,
    blocking: z.boolean(),
    ref: NonEmptyStringSchema.optional(),
  })
  .strict()
export type MissingEvidence = z.infer<typeof MissingEvidenceSchema>

export const EvidenceBundleV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    id: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    attemptId: NonEmptyStringSchema,
    taskSpecHash: Sha256Schema,
    task: ContextTaskSchema,
    limits: EvidenceLimitsSchema,
    baseline: GitBaselineSchema,
    changes: ChangeEvidenceSchema,
    artifacts: z.array(ArtifactEvidenceV2Schema),
    gates: z.array(GateResultSchema),
    tests: z.array(
      z
        .object({
          gateId: NonEmptyStringSchema,
          status: GateStatusSchema,
          blocking: z.boolean(),
        })
        .strict(),
    ),
    toolCalls: z.array(EvidenceToolCallSchema),
    executorOutcome: ExecutorOutcomeSchema.optional(),
    context: EvidenceContextBindingSchema,
    contextManifestHash: Sha256Schema,
    profile: EvidenceProfileSnapshotSchema,
    usage: EvidenceUsageSchema,
    priorAttempts: z.array(EvidencePriorAttemptSchema),
    priorAssessments: z.array(EvidenceAssessmentRefSchema),
    security: z
      .object({
        mode: SecurityModeSchema,
        headlessAsk: HeadlessAskSchema,
        allowShell: z.boolean(),
        interactive: z.boolean(),
        allowedCommandCount: CounterSchema,
        readPaths: z.array(PortableRelativeScopeSchema),
        writePaths: z.array(PortableRelativeScopeSchema),
        toolRuleCount: CounterSchema,
        diagnostics: z.array(NonEmptyStringSchema),
      })
      .strict(),
    provenance: z
      .object({
        task: EvidenceSourceSchema,
        changes: EvidenceSourceSchema,
        artifacts: EvidenceSourceSchema,
        gates: EvidenceSourceSchema,
        tools: EvidenceSourceSchema,
        context: EvidenceSourceSchema,
        profile: EvidenceSourceSchema,
        usage: EvidenceSourceSchema,
        security: EvidenceSourceSchema,
        assessments: EvidenceSourceSchema,
      })
      .strict(),
    truncations: z.array(EvidenceTruncationSchema),
    missingEvidence: z.array(MissingEvidenceSchema),
    createdAt: TimestampSchema,
    contentHash: Sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    for (const field of ["diffHash", "diffRef", "attemptDiffHash", "attemptDiffRef"] as const) {
      if (!value.changes[field]) {
        context.addIssue({
          code: "custom",
          message: "Evidence bundles require cumulative and per-attempt diff manifest bindings",
          path: ["changes", field],
        })
      }
    }
    if (value.context.manifestHash !== value.contextManifestHash) {
      context.addIssue({
        code: "custom",
        message: "Evidence context binding must match contextManifestHash",
        path: ["context", "manifestHash"],
      })
    }
    if (value.task.taskSpecHash !== value.taskSpecHash) {
      context.addIssue({
        code: "custom",
        message: "Evidence task snapshot must match taskSpecHash",
        path: ["task", "taskSpecHash"],
      })
    }
  })
export type EvidenceBundleV2 = z.infer<typeof EvidenceBundleV2Schema>

export const EvidenceBundleSchema = z.union([EvidenceBundleV1Schema, EvidenceBundleV2Schema])
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>

function canonicalEvidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEvidenceValue)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, canonicalEvidenceValue(child)]),
  )
}

export function evidenceBundleCanonicalJson(value: EvidenceBundle): string {
  return JSON.stringify(canonicalEvidenceValue(value))
}

export function computeEvidenceBundleContentHash(
  value:
    | EvidenceBundle
    | ({ schemaVersion: 1 | 2; contentHash?: string } & Record<string, unknown>),
): string {
  const { contentHash: _contentHash, ...body } = value
  return createHash("sha256")
    .update(`ralph.evidence.bundle.v${body.schemaVersion}`)
    .update("\0")
    .update(JSON.stringify(canonicalEvidenceValue(body)))
    .digest("hex")
}

export const CompletionDecisionStatusSchema = z.enum([
  "passed",
  "failed",
  "revision_required",
  "blocked",
  "overridden",
])
export type CompletionDecisionStatus = z.infer<typeof CompletionDecisionStatusSchema>

export const CompletionDecisionSchema = z
  .object({
    status: CompletionDecisionStatusSchema,
    deterministicPassed: z.boolean(),
    evaluationMode: z.enum(["none", "external", "self", "manual"]),
    score: z.number().int().min(0).max(100).optional(),
    threshold: z.number().int().min(0).max(100).optional(),
    severityRulesPassed: z.boolean().optional(),
    evidenceBundleId: NonEmptyStringSchema,
    assessmentId: NonEmptyStringSchema.optional(),
    reasons: z.array(NonEmptyStringSchema),
    decidedBy: z.literal("ralph-policy"),
    decidedAt: TimestampSchema,
  })
  .strict()
export type CompletionDecision = z.infer<typeof CompletionDecisionSchema>

export const EvidencePersistenceReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceBundleId: NonEmptyStringSchema,
    contentHash: Sha256Schema,
    persistedAt: TimestampSchema,
  })
  .strict()
export type EvidencePersistenceReceipt = z.infer<typeof EvidencePersistenceReceiptSchema>

export const TaskCompletionAuthorizationSchema = z
  .object({
    decision: CompletionDecisionSchema,
    evidence: EvidenceBundleSchema,
    persistence: EvidencePersistenceReceiptSchema,
  })
  .strict()
export type TaskCompletionAuthorization = z.infer<typeof TaskCompletionAuthorizationSchema>

export const CompletionOverrideAuditSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: NonEmptyStringSchema,
    source: z.enum(["cli", "tui", "api"]),
    force: z.literal(true),
    reason: NonEmptyStringSchema,
    overriddenGateIds: z.array(NonEmptyStringSchema),
    recordedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.overriddenGateIds).size !== value.overriddenGateIds.length) {
      context.addIssue({
        code: "custom",
        message: "Override audit gate IDs must be unique",
        path: ["overriddenGateIds"],
      })
    }
  })
export type CompletionOverrideAudit = z.infer<typeof CompletionOverrideAuditSchema>

export const TaskOverrideCompletionAuthorizationSchema = z
  .object({
    decision: CompletionDecisionSchema,
    evidence: EvidenceBundleSchema,
    persistence: EvidencePersistenceReceiptSchema,
    audit: CompletionOverrideAuditSchema,
  })
  .strict()
export type TaskOverrideCompletionAuthorization = z.infer<
  typeof TaskOverrideCompletionAuthorizationSchema
>

export const LeaseKindSchema = z.enum(["workspace-supervisor", "run-supervisor", "worker"])
export type LeaseKind = z.infer<typeof LeaseKindSchema>

export const LeaseStatusSchema = z.enum(["active", "released", "stolen"])
export type LeaseStatus = z.infer<typeof LeaseStatusSchema>

export const LeaseProbeStatusSchema = z.enum(["alive", "dead", "identity-mismatch", "unreachable"])
export type LeaseProbeStatus = z.infer<typeof LeaseProbeStatusSchema>

/**
 * Durable writer ownership. The conceptual LeaseRecord in docs/17 is kept
 * intact while the persisted contract also records lifecycle/revision data
 * needed for compare-and-swap renewal and auditable stale-owner takeover.
 */
export const DurableLeaseRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    kind: LeaseKindSchema,
    resourceKey: NonEmptyStringSchema,
    workspaceId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema.optional(),
    ownerInstanceId: NonEmptyStringSchema,
    workerId: NonEmptyStringSchema.optional(),
    pid: z.number().int().positive(),
    processStartToken: NonEmptyStringSchema,
    hostname: NonEmptyStringSchema,
    command: NonEmptyStringSchema,
    scope: z.array(NonEmptyStringSchema).min(1),
    parentRunId: NonEmptyStringSchema.optional(),
    parentWorkerId: NonEmptyStringSchema.optional(),
    acquiredAt: TimestampSchema,
    renewedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    graceExpiresAt: TimestampSchema,
    status: LeaseStatusSchema,
    revision: z.number().int().nonnegative(),
    releasedAt: TimestampSchema.optional(),
    replacedByLeaseId: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((lease, context) => {
    const acquiredAt = Date.parse(lease.acquiredAt)
    const renewedAt = Date.parse(lease.renewedAt)
    const expiresAt = Date.parse(lease.expiresAt)
    const graceExpiresAt = Date.parse(lease.graceExpiresAt)
    if (!(acquiredAt <= renewedAt && renewedAt < expiresAt && expiresAt <= graceExpiresAt)) {
      context.addIssue({
        code: "custom",
        message:
          "Lease timestamps must satisfy acquiredAt <= renewedAt < expiresAt <= graceExpiresAt",
        path: ["expiresAt"],
      })
    }
    if (lease.status === "active") {
      if (lease.releasedAt !== undefined || lease.replacedByLeaseId !== undefined) {
        context.addIssue({
          code: "custom",
          message: "An active lease cannot have terminal lifecycle fields",
          path: ["status"],
        })
      }
      return
    }
    if (lease.releasedAt === undefined) {
      context.addIssue({
        code: "custom",
        message: "A terminal lease must record releasedAt",
        path: ["releasedAt"],
      })
    }
    if (lease.status === "stolen" && lease.replacedByLeaseId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A stolen lease must identify its replacement",
        path: ["replacedByLeaseId"],
      })
    }
  })
export type DurableLeaseRecord = z.infer<typeof DurableLeaseRecordSchema>

export const LeaseProbeRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    leaseId: NonEmptyStringSchema,
    observerInstanceId: NonEmptyStringSchema,
    sequence: z.number().int().positive(),
    status: LeaseProbeStatusSchema,
    expectedProcessStartToken: NonEmptyStringSchema,
    observedProcessStartToken: NonEmptyStringSchema.optional(),
    observedAt: TimestampSchema,
    reason: NonEmptyStringSchema,
  })
  .strict()
export type LeaseProbeRecord = z.infer<typeof LeaseProbeRecordSchema>

/**
 * Immutable description of the command-owned work source for a run.
 *
 * `rootPrdId`/`rootPrdFile` remain on RunRecord as stable legacy identity
 * columns used by resume discovery. This discriminant makes it explicit when
 * those columns identify an ad-hoc execution unit instead of a user-authored
 * PRD document.
 */
export const RunWorkSourceSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("prd"),
        prdId: NonEmptyStringSchema,
        prdFile: NonEmptyStringSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("ad-hoc"),
        description: z.string().trim().min(1).max(65_536),
        descriptionHash: Sha256Schema,
      })
      .strict(),
  ])
  .superRefine((source, context) => {
    if (source.kind !== "ad-hoc") return
    const actual = createHash("sha256").update(source.description.trim(), "utf8").digest("hex")
    if (actual !== source.descriptionHash) {
      context.addIssue({
        code: "custom",
        path: ["descriptionHash"],
        message: "Ad-hoc descriptionHash must match the normalized description",
      })
    }
  })
export type RunWorkSource = z.infer<typeof RunWorkSourceSchema>

export const RunRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    workspaceId: NonEmptyStringSchema,
    rootPrdId: NonEmptyStringSchema,
    rootPrdFile: NonEmptyStringSchema,
    source: RunWorkSourceSchema.optional(),
    definitionHash: Sha256Schema,
    graphHash: Sha256Schema,
    mode: RunModeSchema,
    status: RunStatusSchema,
    effectiveOptionsHash: Sha256Schema,
    effectiveOptions: EffectiveRunOptionsSchema,
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
    stopReason: NonEmptyStringSchema.optional(),
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (!run.source) return
    const expectedId =
      run.source.kind === "prd"
        ? run.source.prdId
        : `ad-hoc-${run.source.descriptionHash.slice(0, 16)}`
    const expectedFile =
      run.source.kind === "prd" ? run.source.prdFile : `@ad-hoc/${run.source.descriptionHash}`
    if (run.rootPrdId !== expectedId) {
      context.addIssue({
        code: "custom",
        path: ["rootPrdId"],
        message: "Run root identity must match its immutable work source",
      })
    }
    if (run.rootPrdFile !== expectedFile) {
      context.addIssue({
        code: "custom",
        path: ["rootPrdFile"],
        message: "Run root file identity must match its immutable work source",
      })
    }
  })
export type RunRecord = z.infer<typeof RunRecordSchema>

export const TaskRecordSchema = z
  .object({
    runId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    status: TaskRuntimeStatusSchema,
    markerContentHash: Sha256Schema,
    activeAttemptId: NonEmptyStringSchema.optional(),
    completion: CompletionDecisionSchema.optional(),
    updatedAt: TimestampSchema,
  })
  .strict()
export type TaskRecord = z.infer<typeof TaskRecordSchema>

export const ExecutorProfileSnapshotSchema = z
  .object({
    id: NonEmptyStringSchema,
    backend: z.enum(["fake", "embedded", "external-cli"]),
    provider: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    variant: NonEmptyStringSchema.optional(),
    contentHash: Sha256Schema,
  })
  .strict()
export type ExecutorProfileSnapshot = z.infer<typeof ExecutorProfileSnapshotSchema>

export const AttemptRecordSchema = z
  .object({
    id: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    ordinal: z.number().int().positive(),
    phase: AttemptPhaseSchema,
    status: AttemptStatusSchema,
    baseline: GitBaselineSchema,
    contextManifestHash: Sha256Schema,
    effectiveOptionsHash: Sha256Schema,
    effectiveOptions: EffectiveRunOptionsSchema,
    counters: AttemptCountersSchema,
    executorOutcome: ExecutorOutcomeSchema.optional(),
    evidenceBundleId: NonEmptyStringSchema.optional(),
    completionDecision: CompletionDecisionSchema.optional(),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.effectiveOptionsHash !== value.effectiveOptions.contentHash) {
      context.addIssue({
        code: "custom",
        message: "Attempt effective options snapshot does not match effectiveOptionsHash",
        path: ["effectiveOptionsHash"],
      })
    }
  })
export type AttemptRecord = z.infer<typeof AttemptRecordSchema>

export const ExecutionReportCountersSchema = z
  .object({
    tasksSelected: CounterSchema,
    tasksCompleted: CounterSchema,
    tasksFailed: CounterSchema,
    tasksBlocked: CounterSchema,
    attempts: CounterSchema,
    modelCalls: CounterSchema,
    toolCalls: CounterSchema,
    wiggumIterations: CounterSchema,
    executorRetries: CounterSchema,
    watchdogRestarts: CounterSchema.default(0),
    judgeTransportRetries: CounterSchema,
    revisionAttempts: CounterSchema,
    gateRuns: CounterSchema,
    noChangeAttempts: CounterSchema,
  })
  .strict()
export type ExecutionReportCounters = z.infer<typeof ExecutionReportCountersSchema>

export const TaskExecutionReportSchema = z
  .object({
    taskId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    status: TaskRuntimeStatusSchema,
    attemptIds: z.array(NonEmptyStringSchema),
    completion: CompletionDecisionSchema.optional(),
    executorOutcome: ExecutorOutcomeSchema.optional(),
    judgeAssessments: z.array(JudgeAssessmentSchema).optional(),
    evidenceCaveats: z.array(NonEmptyStringSchema).default([]),
    markerUpdated: z.boolean().optional(),
  })
  .strict()
export type TaskExecutionReport = z.infer<typeof TaskExecutionReportSchema>

export const ExecutionReportUsageSummaryGroupSchema = z
  .object({
    combined: ChildUsageSummarySchema,
    executor: ChildUsageSummarySchema,
    judge: ChildUsageSummarySchema,
  })
  .strict()
export type ExecutionReportUsageSummaryGroup = z.infer<
  typeof ExecutionReportUsageSummaryGroupSchema
>

export const ExecutionReportChildUsageSchema = z
  .object({
    runCount: CounterSchema,
    combined: ChildUsageSummarySchema,
    executor: ChildUsageSummarySchema,
    judge: ChildUsageSummarySchema,
  })
  .strict()
export type ExecutionReportChildUsage = z.infer<typeof ExecutionReportChildUsageSchema>

export const ExecutionReportProgressSchema = z
  .object({
    scope: z.literal("leaf-tasks"),
    completed: CounterSchema,
    total: CounterSchema,
    childRunCount: CounterSchema,
  })
  .strict()
  .superRefine((progress, context) => {
    if (progress.completed > progress.total) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "Completed leaf-task count cannot exceed total leaf-task count",
      })
    }
  })
export type ExecutionReportProgress = z.infer<typeof ExecutionReportProgressSchema>

export const ExecutionReportUsageSchema = z
  .object({
    combined: EvidenceUsageSchema.default({
      source: "unavailable",
      semantics: "final",
      providerRawRefs: [],
      providerCallCount: 0,
    }),
    executor: EvidenceUsageSchema,
    judge: EvidenceUsageSchema,
    judgeRequested: z.boolean(),
    children: ExecutionReportChildUsageSchema.optional(),
    aggregate: ExecutionReportUsageSummaryGroupSchema.optional(),
  })
  .strict()
export type ExecutionReportUsage = z.infer<typeof ExecutionReportUsageSchema>

export const ExecutionReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    rootPrdId: NonEmptyStringSchema,
    rootPrdFile: NonEmptyStringSchema,
    source: RunWorkSourceSchema.optional(),
    definitionHash: Sha256Schema,
    graphHash: Sha256Schema,
    mode: RunModeSchema,
    status: RunStatusSchema,
    effectiveOptionsHash: Sha256Schema,
    effectiveOptions: EffectiveRunOptionsSchema,
    tasks: z.array(TaskExecutionReportSchema),
    counters: ExecutionReportCountersSchema,
    progress: ExecutionReportProgressSchema.optional(),
    usage: ExecutionReportUsageSchema.default({
      combined: {
        source: "unavailable",
        semantics: "final",
        providerRawRefs: [],
        providerCallCount: 0,
      },
      executor: {
        source: "unavailable",
        semantics: "final",
        providerRawRefs: [],
        providerCallCount: 0,
      },
      judge: {
        source: "unavailable",
        semantics: "final",
        providerRawRefs: [],
        providerCallCount: 0,
      },
      judgeRequested: false,
    }),
    reasons: z.array(NonEmptyStringSchema),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    finishedAt: TimestampSchema.optional(),
    contentHash: Sha256Schema,
  })
  .strict()
  .superRefine((report, context) => {
    if (!report.source) return
    const expectedId =
      report.source.kind === "prd"
        ? report.source.prdId
        : `ad-hoc-${report.source.descriptionHash.slice(0, 16)}`
    const expectedFile =
      report.source.kind === "prd"
        ? report.source.prdFile
        : `@ad-hoc/${report.source.descriptionHash}`
    if (report.rootPrdId !== expectedId) {
      context.addIssue({
        code: "custom",
        path: ["rootPrdId"],
        message: "Report root identity must match its immutable work source",
      })
    }
    if (report.rootPrdFile !== expectedFile) {
      context.addIssue({
        code: "custom",
        path: ["rootPrdFile"],
        message: "Report root file identity must match its immutable work source",
      })
    }
  })
export type ExecutionReport = z.infer<typeof ExecutionReportSchema>
export const RunReportSchema = ExecutionReportSchema
export type RunReport = ExecutionReport

type TransitionMatrix<State extends string> = Readonly<Record<State, readonly State[]>>

function closedTransitionMatrix<State extends string>(
  matrix: Record<State, readonly State[]>,
): TransitionMatrix<State> {
  for (const targets of Object.values(matrix) as Array<readonly State[]>) Object.freeze(targets)
  return Object.freeze(matrix)
}

export const RUN_STATUS_TRANSITIONS = closedTransitionMatrix<RunStatus>({
  created: ["running", "cancelled"],
  running: ["stopping", "interrupted", "waiting", "completed", "failed", "cancelled"],
  stopping: ["interrupted", "completed", "failed", "cancelled"],
  interrupted: ["running", "cancelled"],
  waiting: ["running", "stopping", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
})

export const TASK_RUNTIME_STATUS_TRANSITIONS = closedTransitionMatrix<TaskRuntimeStatus>({
  pending: ["eligible", "blocked", "cancelled"],
  eligible: ["active", "blocked", "cancelled"],
  active: ["verifying", "retryable_failed", "interrupted", "blocked", "rejected", "cancelled"],
  verifying: ["evaluating", "retryable_failed", "interrupted", "blocked", "rejected", "cancelled"],
  evaluating: [
    "completed",
    "completed_with_override",
    "retryable_failed",
    "interrupted",
    "blocked",
    "rejected",
    "cancelled",
  ],
  retryable_failed: ["active", "blocked", "rejected", "cancelled"],
  interrupted: ["active", "blocked", "cancelled"],
  blocked: ["eligible", "cancelled"],
  rejected: [],
  cancelled: [],
  completed: [],
  completed_with_override: [],
})

export const ATTEMPT_PHASE_TRANSITIONS = closedTransitionMatrix<AttemptPhase>({
  created: ["preparing"],
  preparing: ["invoking"],
  invoking: ["tools", "settling"],
  tools: ["settling"],
  settling: ["invoking", "evidence"],
  evidence: ["gates"],
  gates: ["judgment", "decision"],
  judgment: ["decision"],
  decision: [],
})

export const ATTEMPT_STATUS_TRANSITIONS = closedTransitionMatrix<AttemptStatus>({
  active: ["passed", "failed", "interrupted", "rejected"],
  passed: [],
  failed: [],
  interrupted: [],
  rejected: [],
})

export class ExecutionTransitionError extends Error {
  readonly code: string
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = "ExecutionTransitionError"
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

const NO_CHANGE_POLICY_ALIASES: Readonly<
  Record<string, { value: NoChangePolicy; notice: string }>
> = Object.freeze({
  retry: {
    value: "retry-on-no-change",
    notice: "Legacy no-change policy `retry` normalized to `retry-on-no-change`.",
  },
  "fail-fast": {
    value: "fail-on-no-change",
    notice: "Legacy no-change policy `fail-fast` normalized to `fail-on-no-change`.",
  },
  fallback: {
    value: "retry-on-no-change",
    notice:
      "Legacy no-change policy `fallback` normalized to bounded `retry-on-no-change`; it does not switch provider or model.",
  },
})

export function normalizeNoChangePolicy(input: string): NormalizedNoChangePolicy {
  const original = NonEmptyStringSchema.parse(input)
  const normalized = original.trim().toLocaleLowerCase("und")
  const canonical = NoChangePolicySchema.safeParse(normalized)
  if (canonical.success) {
    return NormalizedNoChangePolicySchema.parse({ value: canonical.data, original })
  }
  const alias = NO_CHANGE_POLICY_ALIASES[normalized]
  if (alias) {
    return NormalizedNoChangePolicySchema.parse({ ...alias, original })
  }
  throw new ExecutionTransitionError(
    "RALPH_NO_CHANGE_POLICY_INVALID",
    `Unknown no-change policy: ${original}`,
    {
      original,
      allowed: NoChangePolicySchema.options,
      aliases: Object.keys(NO_CHANGE_POLICY_ALIASES),
    },
  )
}

function allows<State extends string>(
  matrix: TransitionMatrix<State>,
  from: State,
  to: State,
): boolean {
  return matrix[from].includes(to)
}

function invalidTransition(kind: string, from: string, to: string): never {
  throw new ExecutionTransitionError(
    `RALPH_${kind}_TRANSITION_INVALID`,
    `Invalid ${kind.toLocaleLowerCase("und")} transition: ${from} -> ${to}`,
    { from, to },
  )
}

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return allows(RUN_STATUS_TRANSITIONS, from, to)
}

export function canTransitionTaskRuntimeStatus(
  from: TaskRuntimeStatus,
  to: TaskRuntimeStatus,
): boolean {
  return allows(TASK_RUNTIME_STATUS_TRANSITIONS, from, to)
}

export const canTransitionTaskStatus = canTransitionTaskRuntimeStatus

export function canTransitionAttemptPhase(from: AttemptPhase, to: AttemptPhase): boolean {
  return allows(ATTEMPT_PHASE_TRANSITIONS, from, to)
}

export function canTransitionAttemptStatus(from: AttemptStatus, to: AttemptStatus): boolean {
  return allows(ATTEMPT_STATUS_TRANSITIONS, from, to)
}

export function transitionRunStatus(record: RunRecord, to: RunStatus): RunRecord {
  const current = RunRecordSchema.parse(record)
  const target = RunStatusSchema.parse(to)
  if (!canTransitionRunStatus(current.status, target)) {
    return invalidTransition("RUN_STATUS", current.status, target)
  }
  return RunRecordSchema.parse({ ...current, status: target })
}

export function transitionTaskRuntimeStatus(record: TaskRecord, to: TaskRuntimeStatus): TaskRecord {
  const current = TaskRecordSchema.parse(record)
  const target = TaskRuntimeStatusSchema.parse(to)
  if (!canTransitionTaskRuntimeStatus(current.status, target)) {
    return invalidTransition("TASK_STATUS", current.status, target)
  }
  if (target === "completed" || target === "completed_with_override") {
    throw new ExecutionTransitionError(
      "RALPH_TASK_COMPLETION_AUTHORITY_REQUIRED",
      "Task completion requires a Ralph CompletionDecision and persisted evidence",
      { from: current.status, to: target },
    )
  }
  return TaskRecordSchema.parse({ ...current, status: target })
}

export const transitionTaskStatus = transitionTaskRuntimeStatus

export function transitionAttemptPhase(record: AttemptRecord, to: AttemptPhase): AttemptRecord {
  const current = AttemptRecordSchema.parse(record)
  const target = AttemptPhaseSchema.parse(to)
  if (current.status !== "active") {
    throw new ExecutionTransitionError(
      "RALPH_ATTEMPT_PHASE_TERMINAL",
      "A terminal attempt cannot change phase",
      { status: current.status, from: current.phase, to: target },
    )
  }
  if (!canTransitionAttemptPhase(current.phase, target)) {
    return invalidTransition("ATTEMPT_PHASE", current.phase, target)
  }
  return AttemptRecordSchema.parse({ ...current, phase: target })
}

export function transitionAttemptStatus(record: AttemptRecord, to: AttemptStatus): AttemptRecord {
  const current = AttemptRecordSchema.parse(record)
  const target = AttemptStatusSchema.parse(to)
  if (!canTransitionAttemptStatus(current.status, target)) {
    return invalidTransition("ATTEMPT_STATUS", current.status, target)
  }
  return AttemptRecordSchema.parse({ ...current, status: target })
}

function completionDenied(code: string, message: string, details = {}): never {
  throw new ExecutionTransitionError(code, message, details)
}

function assertCompletionEvidenceBinding(
  current: TaskRecord,
  decision: CompletionDecision,
  evidence: EvidenceBundle,
  persistence: EvidencePersistenceReceipt,
): void {
  if (
    evidence.runId !== current.runId ||
    evidence.documentId !== current.documentId ||
    evidence.taskId !== current.taskId ||
    current.activeAttemptId !== evidence.attemptId
  ) {
    completionDenied(
      "RALPH_TASK_COMPLETION_CONTEXT_MISMATCH",
      "Evidence does not belong to the active task attempt",
      {
        taskRunId: current.runId,
        evidenceRunId: evidence.runId,
        taskDocumentId: current.documentId,
        evidenceDocumentId: evidence.documentId,
        taskId: current.taskId,
        evidenceTaskId: evidence.taskId,
        activeAttemptId: current.activeAttemptId,
        evidenceAttemptId: evidence.attemptId,
      },
    )
  }
  if (decision.evidenceBundleId !== evidence.id) {
    completionDenied(
      "RALPH_TASK_COMPLETION_EVIDENCE_MISMATCH",
      "CompletionDecision references a different evidence bundle",
    )
  }
  if (
    persistence.evidenceBundleId !== evidence.id ||
    persistence.contentHash !== evidence.contentHash
  ) {
    completionDenied(
      "RALPH_TASK_COMPLETION_EVIDENCE_NOT_PERSISTED",
      "Completion requires a persistence receipt for the exact evidence bundle",
    )
  }
  if (!evidence.changes.reproducible) {
    completionDenied(
      "RALPH_TASK_COMPLETION_EVIDENCE_NOT_REPRODUCIBLE",
      "Completion requires reconstructable before/after content for every changed path",
      { missingContent: evidence.changes.missingContent },
    )
  }
}

export function assertTaskCompletionAuthorized(
  task: TaskRecord,
  authorization: TaskCompletionAuthorization,
): void {
  const current = TaskRecordSchema.parse(task)
  const parsed = TaskCompletionAuthorizationSchema.parse(authorization)
  const { decision, evidence, persistence } = parsed

  if (!canTransitionTaskRuntimeStatus(current.status, "completed")) {
    invalidTransition("TASK_STATUS", current.status, "completed")
  }
  if (decision.status !== "passed" || !decision.deterministicPassed) {
    completionDenied(
      "RALPH_TASK_COMPLETION_DECISION_NOT_PASSED",
      "Only a passed deterministic CompletionDecision can complete a task",
      { decisionStatus: decision.status, deterministicPassed: decision.deterministicPassed },
    )
  }
  if (
    decision.severityRulesPassed === false ||
    (decision.score !== undefined &&
      decision.threshold !== undefined &&
      decision.score < decision.threshold)
  ) {
    completionDenied(
      "RALPH_TASK_COMPLETION_EVALUATION_NOT_PASSED",
      "Completion evaluation threshold and severity rules must pass",
    )
  }
  assertCompletionEvidenceBinding(current, decision, evidence, persistence)
  const failedBlockingGates = evidence.gates.filter(
    (gate) =>
      gate.blocking &&
      gate.status !== "passed" &&
      !(
        gate.status === "skipped_by_cli" &&
        (gate.skipPolicy === "allowed-to-skip" || gate.skipPolicy === "optional")
      ),
  )
  if (failedBlockingGates.length > 0) {
    completionDenied(
      "RALPH_TASK_COMPLETION_BLOCKING_GATE_NOT_PASSED",
      "Every blocking gate must be explicitly passed before completion",
      {
        gates: failedBlockingGates.map((gate) => ({ id: gate.gateId, status: gate.status })),
      },
    )
  }
}

export function assertTaskOverrideCompletionAuthorized(
  task: TaskRecord,
  authorization: TaskOverrideCompletionAuthorization,
): void {
  const current = TaskRecordSchema.parse(task)
  const parsed = TaskOverrideCompletionAuthorizationSchema.parse(authorization)
  const { decision, evidence, persistence, audit } = parsed

  if (!canTransitionTaskRuntimeStatus(current.status, "completed_with_override")) {
    invalidTransition("TASK_STATUS", current.status, "completed_with_override")
  }
  if (decision.status !== "overridden") {
    completionDenied(
      "RALPH_TASK_OVERRIDE_DECISION_REQUIRED",
      "Override completion requires an overridden CompletionDecision",
      { decisionStatus: decision.status },
    )
  }
  assertCompletionEvidenceBinding(current, decision, evidence, persistence)

  const nonPassedBlockingGates = evidence.gates.filter(
    (gate) =>
      gate.blocking &&
      gate.status !== "passed" &&
      !(
        gate.status === "skipped_by_cli" &&
        (gate.skipPolicy === "allowed-to-skip" || gate.skipPolicy === "optional")
      ),
  )
  const nonOverridableGates = nonPassedBlockingGates.filter(
    (gate) => gate.status !== "skipped_by_cli",
  )
  if (nonOverridableGates.length > 0) {
    completionDenied(
      "RALPH_TASK_OVERRIDE_BLOCKING_GATE_NOT_OVERRIDABLE",
      "Only explicitly CLI-skipped blocking gates can be completed with override",
      {
        gates: nonOverridableGates.map((gate) => ({ id: gate.gateId, status: gate.status })),
      },
    )
  }
  const expectedGateIds = nonPassedBlockingGates.map((gate) => gate.gateId).sort()
  const auditedGateIds = [...audit.overriddenGateIds].sort()
  if (
    expectedGateIds.length !== auditedGateIds.length ||
    expectedGateIds.some((gateId, index) => gateId !== auditedGateIds[index])
  ) {
    completionDenied(
      "RALPH_TASK_OVERRIDE_AUDIT_MISMATCH",
      "Override audit must name every and only non-passed blocking gate",
      { expectedGateIds, auditedGateIds },
    )
  }
}

export function completeTask(
  task: TaskRecord,
  authorization: TaskCompletionAuthorization,
): TaskRecord {
  const current = TaskRecordSchema.parse(task)
  const parsed = TaskCompletionAuthorizationSchema.parse(authorization)
  assertTaskCompletionAuthorized(current, parsed)
  const completed: Record<string, unknown> = {
    ...current,
    status: "completed",
    completion: parsed.decision,
  }
  delete completed.activeAttemptId
  delete completed.claimId
  return TaskRecordSchema.parse(completed)
}

export function completeTaskWithOverride(
  task: TaskRecord,
  authorization: TaskOverrideCompletionAuthorization,
): TaskRecord {
  const current = TaskRecordSchema.parse(task)
  const parsed = TaskOverrideCompletionAuthorizationSchema.parse(authorization)
  assertTaskOverrideCompletionAuthorized(current, parsed)
  const completed: Record<string, unknown> = {
    ...current,
    status: "completed_with_override",
    completion: parsed.decision,
  }
  delete completed.activeAttemptId
  delete completed.claimId
  return TaskRecordSchema.parse(completed)
}
