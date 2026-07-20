import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import {
  ChildRunObservabilitySchema,
  ContextManifestSchema,
  EffectiveRunOptionsSchema,
  EvaluationPolicySchema,
  ExecutorOutcomeSchema,
  type GateCommand,
  GateCommandSchema,
  GateResultSchema,
  JudgeOutputSchema,
  RunModeSchema,
} from "@ralph-next/domain"
import { EventEnvelopeSchema } from "@ralph-next/telemetry"
import { z } from "zod"
import { ProcessSettlementSchema } from "./contracts"
import {
  MAX_TIMER_DELAY_MS,
  type WorkerCapabilityAction,
  type WorkerCapabilityGrant,
  type WorkerIdentity,
  type WorkerRole,
} from "./worker-protocol"

const NonEmptyStringSchema = z.string().trim().min(1).max(4_096)
const PortablePathSchema = z.string().trim().min(1).max(32_768)
const AbsolutePathSchema = PortablePathSchema.refine(isAbsolute, "Worker path must be absolute")
const TimestampSchema = z.iso.datetime({ offset: true })
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const BoundedOutputSchema = z.string().max(1_048_576)
const MAX_INLINE_WORKER_RESOURCE_BYTES = 524_288

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, canonicalJsonValue(child)]),
  )
}

function stableJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalJsonValue(value))
  if (encoded === undefined) throw new Error("Worker canonical value has no JSON representation")
  return encoded
}

function normalizedEnvironmentNames(names: readonly string[]): string[] {
  return names
    .map((name) => (process.platform === "win32" ? name.toLocaleUpperCase("en-US") : name))
    .sort(compareText)
}

function namespacedHash(namespace: string, value: unknown): string {
  return createHash("sha256").update(namespace).update("\0").update(stableJson(value)).digest("hex")
}

export type WorkerJsonValue =
  | null
  | boolean
  | number
  | string
  | WorkerJsonValue[]
  | { [key: string]: WorkerJsonValue }

export const WorkerJsonValueSchema: z.ZodType<WorkerJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(WorkerJsonValueSchema),
    z.record(z.string(), WorkerJsonValueSchema),
  ]),
)
const JsonObjectSchema = z.record(z.string().min(1).max(256), WorkerJsonValueSchema)

function gateCommandFromSpecification(specification: WorkerJsonValue): GateCommand | undefined {
  if (specification === null || Array.isArray(specification) || typeof specification !== "object") {
    throw new Error("Gate specification must be an object")
  }
  if (specification.type !== "command") return undefined
  return GateCommandSchema.parse(specification.command)
}

export const WORKER_OPERATION_SCHEMA_VERSION = 1 as const

export class WorkerOperationError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = "WorkerOperationError"
    this.code = NonEmptyStringSchema.parse(code)
    this.retryable = retryable
  }
}

export const WorkerOperationNameSchema = z.enum([
  "executor-model.execute",
  "judge.evaluate",
  "tool.execute",
  "gate.execute",
  "child-run.execute",
  "git-integration.execute",
])
export type WorkerOperationName = z.infer<typeof WorkerOperationNameSchema>

export const WorkerOperationScopeSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    workspaceId: NonEmptyStringSchema,
    workspaceRoot: AbsolutePathSchema,
    runId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema.optional(),
    taskId: NonEmptyStringSchema.optional(),
    attemptId: NonEmptyStringSchema.optional(),
    correlationId: NonEmptyStringSchema,
    deadlineAt: TimestampSchema.optional(),
  })
  .strict()
export type WorkerOperationScope = z.infer<typeof WorkerOperationScopeSchema>

export const WorkerResourceReferenceSchema = z
  .object({
    ref: NonEmptyStringSchema,
    contentHash: Sha256Schema,
    includedHash: Sha256Schema.optional(),
    kind: NonEmptyStringSchema,
    mediaType: NonEmptyStringSchema.optional(),
    byteLength: z.number().int().nonnegative().optional(),
    includedByteLength: z.number().int().nonnegative().optional(),
    truncated: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.truncated && !value.includedHash) {
      context.addIssue({
        code: "custom",
        message: "A truncated worker resource requires an includedHash",
        path: ["includedHash"],
      })
    }
    if (!value.truncated && value.includedHash && value.includedHash !== value.contentHash) {
      context.addIssue({
        code: "custom",
        message: "A complete worker resource must have identical content and included hashes",
        path: ["includedHash"],
      })
    }
    if (
      !value.truncated &&
      value.byteLength !== undefined &&
      value.includedByteLength !== undefined &&
      value.byteLength !== value.includedByteLength
    ) {
      context.addIssue({
        code: "custom",
        message: "A complete worker resource must have identical byte lengths",
        path: ["includedByteLength"],
      })
    }
    if (
      value.truncated &&
      value.byteLength !== undefined &&
      value.includedByteLength !== undefined &&
      value.includedByteLength > value.byteLength
    ) {
      context.addIssue({
        code: "custom",
        message: "A truncated worker resource cannot include more bytes than its original",
        path: ["includedByteLength"],
      })
    }
  })
export type WorkerResourceReference = z.infer<typeof WorkerResourceReferenceSchema>

export const WorkerResourcePayloadSchema = z
  .object({
    resource: WorkerResourceReferenceSchema,
    content: z.string().max(524_288).optional(),
    path: PortablePathSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.content === undefined) === (value.path === undefined)) {
      context.addIssue({
        code: "custom",
        message: "A worker resource must carry exactly one of content or path",
      })
    }
  })
export type WorkerResourcePayload = z.infer<typeof WorkerResourcePayloadSchema>

export const WorkerProfileSnapshotSchema = z
  .object({
    profileId: NonEmptyStringSchema,
    role: z.enum(["executor", "judge"]),
    backend: z.enum(["fake", "embedded", "external-cli"]),
    provider: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    variant: NonEmptyStringSchema.optional(),
    credentialRef: NonEmptyStringSchema.optional(),
    configHash: Sha256Schema,
  })
  .strict()
export type WorkerProfileSnapshot = z.infer<typeof WorkerProfileSnapshotSchema>

export const WorkerCommandIntentSchema = z.enum([
  "executor-transport",
  "judge-transport",
  "tool",
  "gate",
  "git-inspect",
  "git-checkpoint",
  "git-integrate",
])
export type WorkerCommandIntent = z.infer<typeof WorkerCommandIntentSchema>

export const WorkerCommandInvocationSchema = z
  .object({
    intent: WorkerCommandIntentSchema,
    executable: AbsolutePathSchema,
    executableHash: Sha256Schema,
    args: z.array(z.string().max(65_536)).max(1_024),
    cwd: PortablePathSchema,
    environmentNames: z.array(NonEmptyStringSchema).max(256).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const normalizedNames = value.environmentNames.map((name) =>
      process.platform === "win32" ? name.toLocaleUpperCase("en-US") : name,
    )
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      context.addIssue({
        code: "custom",
        message: "Worker command environment names must be unique",
        path: ["environmentNames"],
      })
    }
  })
export type WorkerCommandInvocation = z.infer<typeof WorkerCommandInvocationSchema>

export const WorkerUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    source: z.enum(["reported", "derived", "estimated", "unavailable"]),
    rawUsageRef: NonEmptyStringSchema.optional(),
  })
  .strict()
export type WorkerUsage = z.infer<typeof WorkerUsageSchema>

export const WorkerObservationSchema = z
  .object({
    type: NonEmptyStringSchema,
    level: z.enum(["trace", "debug", "info", "warn", "error"]),
    summary: NonEmptyStringSchema,
    payloadRef: NonEmptyStringSchema.optional(),
    redacted: z.literal(true),
  })
  .strict()
export type WorkerObservation = z.infer<typeof WorkerObservationSchema>

export const WorkerProgressDetailSchema = z
  .object({
    summary: NonEmptyStringSchema,
    eventType: NonEmptyStringSchema.optional(),
    stream: z
      .enum([
        "model-text",
        "model-reasoning",
        "tool-input",
        "tool-output",
        "gate-output",
        "judge-output",
        "child-output",
        "git-output",
        "log",
        "status",
      ])
      .optional(),
    text: z.string().max(65_536).optional(),
    payloadRef: NonEmptyStringSchema.optional(),
    usage: WorkerUsageSchema.optional(),
    completedUnits: z.number().int().nonnegative().optional(),
    totalUnits: z.number().int().positive().optional(),
    bytes: z.number().int().nonnegative().optional(),
    redacted: z.literal(true),
  })
  .strict()
export type WorkerProgressDetail = z.infer<typeof WorkerProgressDetailSchema>

export const WorkerContextTruncationSchema = z
  .object({
    field: NonEmptyStringSchema,
    reason: z.enum(["field-limit", "total-budget", "field-and-total-limit", "item-limit"]),
    originalHash: Sha256Schema,
    originalBytes: z.number().int().nonnegative().optional(),
    includedBytes: z.number().int().nonnegative().optional(),
    originalCount: z.number().int().nonnegative().optional(),
    includedCount: z.number().int().nonnegative().optional(),
  })
  .strict()
export type WorkerContextTruncation = z.infer<typeof WorkerContextTruncationSchema>

export const WorkerToolDefinitionSchema = z
  .object({
    name: NonEmptyStringSchema,
    description: z.string().max(16_384),
    inputSchema: JsonObjectSchema,
  })
  .strict()
export type WorkerToolDefinition = z.infer<typeof WorkerToolDefinitionSchema>

export const WorkerToolCallSchema = z
  .object({
    callId: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    arguments: JsonObjectSchema,
  })
  .strict()
export type WorkerToolCall = z.infer<typeof WorkerToolCallSchema>

export const WorkerToolFeedbackSchema = z
  .object({
    callId: NonEmptyStringSchema,
    outcome: z.enum([
      "success",
      "nonzero",
      "denied",
      "invalid",
      "error",
      "timeout",
      "cancelled",
      "unsettled",
    ]),
    output: BoundedOutputSchema,
    settlementRef: NonEmptyStringSchema.optional(),
  })
  .strict()
export type WorkerToolFeedback = z.infer<typeof WorkerToolFeedbackSchema>

export const ExecutorModelWorkerRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    scope: WorkerOperationScopeSchema,
    callId: NonEmptyStringSchema,
    callOrdinal: z.number().int().positive(),
    profile: WorkerProfileSnapshotSchema,
    contextManifest: ContextManifestSchema,
    execution: z
      .object({
        task: WorkerJsonValueSchema,
        effectiveOptions: WorkerJsonValueSchema,
        effectiveConfig: WorkerJsonValueSchema.optional(),
        controlRoot: AbsolutePathSchema,
        contextCanonicalJson: z.string().max(1_048_576),
        // The orchestrator caps this inventory to 4,000 entries and 512 KiB
        // before it crosses the 2 MiB worker envelope.
        protectedPaths: z.array(PortablePathSchema).max(4_000),
      })
      .strict(),
    resources: z.array(WorkerResourcePayloadSchema).max(128),
    contextTruncations: z.array(WorkerContextTruncationSchema).max(1_024),
    continuation: z
      .object({
        previousCallRef: NonEmptyStringSchema,
        transcript: WorkerResourcePayloadSchema.optional(),
        toolResults: z.array(WorkerToolFeedbackSchema).max(256),
      })
      .strict()
      .optional(),
    tools: z.array(WorkerToolDefinitionSchema).max(256),
    requestedReadPaths: z.array(PortablePathSchema).max(256),
    transportCommand: WorkerCommandInvocationSchema.optional(),
    limits: z
      .object({
        maximumOutputBytes: z.number().int().positive(),
        maximumModelCalls: z.number().int().positive(),
        maximumToolCalls: z.number().int().nonnegative(),
        timeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.profile.role !== "executor") {
      context.addIssue({ code: "custom", message: "Executor worker requires an executor profile" })
    }
    if (value.profile.backend === "external-cli" && !value.transportCommand) {
      context.addIssue({
        code: "custom",
        message: "An external CLI executor profile requires a transport command",
        path: ["transportCommand"],
      })
    }
    const toolNames = value.tools.map((tool) => tool.name)
    if (new Set(toolNames).size !== toolNames.length) {
      context.addIssue({
        code: "custom",
        message: "Executor worker tool definitions must have unique names",
        path: ["tools"],
      })
    }
  })
export type ExecutorModelWorkerRequest = z.infer<typeof ExecutorModelWorkerRequestSchema>

export const ExecutorModelWorkerResultSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    callId: NonEmptyStringSchema,
    outcome: ExecutorOutcomeSchema,
    requestedToolCalls: z.array(WorkerToolCallSchema).max(256),
    usage: WorkerUsageSchema.optional(),
    observations: z.array(WorkerObservationSchema).max(1_024),
    rawOutputRef: NonEmptyStringSchema.optional(),
    finishReason: NonEmptyStringSchema,
  })
  .strict()
export type ExecutorModelWorkerResult = z.infer<typeof ExecutorModelWorkerResultSchema>

export const JudgeWorkerRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    scope: WorkerOperationScopeSchema,
    assessmentId: NonEmptyStringSchema,
    profile: WorkerProfileSnapshotSchema,
    evidence: WorkerJsonValueSchema,
    policy: EvaluationPolicySchema,
    evaluation: z
      .object({
        kind: z.enum(["external", "self"]),
        bundle: WorkerJsonValueSchema,
        bundleHash: Sha256Schema,
        prompt: z
          .object({
            system: z.string().max(1_048_576),
            user: z.string().max(1_048_576),
          })
          .strict(),
        effectiveOptions: WorkerJsonValueSchema,
        effectiveConfig: WorkerJsonValueSchema.optional(),
        controlRoot: AbsolutePathSchema,
      })
      .strict(),
    attachments: z.array(WorkerResourcePayloadSchema).max(128),
    requestedReadPaths: z.array(PortablePathSchema).max(256),
    transportCommand: WorkerCommandInvocationSchema.optional(),
    maximumOutputBytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.policy.mode !== "external" && value.policy.mode !== "self") {
      context.addIssue({
        code: "custom",
        message: "A judge worker requires external or self evaluation mode",
        path: ["policy", "mode"],
      })
    }
    if (value.policy.mode === "external" && value.profile.role !== "judge") {
      context.addIssue({
        code: "custom",
        message: "External judge worker requires a judge profile",
        path: ["profile", "role"],
      })
    }
    if (value.policy.mode === "self" && value.profile.role !== "executor") {
      context.addIssue({
        code: "custom",
        message: "Self-review worker requires the selected executor profile",
        path: ["profile", "role"],
      })
    }
    if (value.profile.backend === "external-cli" && !value.transportCommand) {
      context.addIssue({
        code: "custom",
        message: "An external CLI judge profile requires a transport command",
        path: ["transportCommand"],
      })
    }
  })
export type JudgeWorkerRequest = z.infer<typeof JudgeWorkerRequestSchema>

export const JudgeWorkerResultSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    assessmentId: NonEmptyStringSchema,
    output: JudgeOutputSchema,
    usage: WorkerUsageSchema.optional(),
    observations: z.array(WorkerObservationSchema).max(1_024),
    rawResponseRef: NonEmptyStringSchema.optional(),
  })
  .strict()
export type JudgeWorkerResult = z.infer<typeof JudgeWorkerResultSchema>

export const ToolWorkerRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    scope: WorkerOperationScopeSchema,
    modelCallId: NonEmptyStringSchema,
    toolCall: WorkerToolCallSchema,
    journalBinding: z
      .object({
        intentId: NonEmptyStringSchema,
        argumentsHash: Sha256Schema,
        idempotencyKey: Sha256Schema,
      })
      .strict(),
    runtime: z
      .object({
        policy: WorkerJsonValueSchema,
        session: WorkerJsonValueSchema,
        controlRoot: AbsolutePathSchema.optional(),
      })
      .strict(),
    executionKind: z.enum(["builtin", "command"]),
    authorization: z
      .object({
        allowed: z.literal(true),
        decisionRef: NonEmptyStringSchema,
        policyHash: Sha256Schema,
        risk: z.enum([
          "read-only",
          "workspace-write",
          "command",
          "network",
          "external-effect",
          "destructive",
        ]),
      })
      .strict(),
    requestedReadPaths: z.array(PortablePathSchema).max(256),
    requestedWritePaths: z.array(PortablePathSchema).max(256),
    command: WorkerCommandInvocationSchema.optional(),
    timeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS),
    maximumOutputBytes: z.number().int().positive(),
    maximumRawOutputBytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.executionKind === "command") !== (value.command !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "A command tool requires exactly one explicit command invocation",
        path: ["command"],
      })
    }
    if (value.authorization.risk === "read-only" && value.requestedWritePaths.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A read-only tool authorization cannot carry write paths",
        path: ["requestedWritePaths"],
      })
    }
  })
export type ToolWorkerRequest = z.infer<typeof ToolWorkerRequestSchema>

export const ToolWorkerResultSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    callId: NonEmptyStringSchema,
    outcome: z.enum([
      "success",
      "nonzero",
      "denied",
      "invalid",
      "error",
      "timeout",
      "cancelled",
      "unsettled",
    ]),
    output: BoundedOutputSchema,
    retryable: z.boolean(),
    settlementRef: NonEmptyStringSchema.optional(),
    exitCode: z.number().int().optional(),
    preStateHash: Sha256Schema.optional(),
    postStateHash: Sha256Schema.optional(),
    outputRefs: z.array(NonEmptyStringSchema).max(128),
    observations: z.array(WorkerObservationSchema).max(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "success" && value.retryable) {
      context.addIssue({
        code: "custom",
        message: "A successful tool settlement cannot be retryable",
        path: ["retryable"],
      })
    }
    if (value.outcome === "nonzero" && value.exitCode === undefined) {
      context.addIssue({
        code: "custom",
        message: "A nonzero tool settlement requires an exit code",
        path: ["exitCode"],
      })
    }
  })
export type ToolWorkerResult = z.infer<typeof ToolWorkerResultSchema>

export const GateInvocationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      command: WorkerCommandInvocationSchema,
      successExitCodes: z.array(z.number().int()).min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("adapter"),
      adapterId: NonEmptyStringSchema,
      input: JsonObjectSchema,
    })
    .strict(),
])
export type GateInvocation = z.infer<typeof GateInvocationSchema>

export const GateWorkerRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    scope: WorkerOperationScopeSchema,
    gateId: NonEmptyStringSchema,
    gatePlanRef: NonEmptyStringSchema,
    gatePlanHash: Sha256Schema,
    category: NonEmptyStringSchema,
    blocking: z.boolean(),
    skipPolicy: z.enum(["required", "optional", "allowed-to-skip", "never-run"]),
    criterionIds: z.array(NonEmptyStringSchema).max(256),
    specification: WorkerJsonValueSchema,
    invocation: GateInvocationSchema,
    requestedReadPaths: z.array(PortablePathSchema).max(256),
    requestedWritePaths: z.array(PortablePathSchema).max(256),
    timeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS),
    maximumOutputBytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.criterionIds).size !== value.criterionIds.length) {
      context.addIssue({
        code: "custom",
        message: "Gate worker criterion IDs must be unique",
        path: ["criterionIds"],
      })
    }
    if (value.skipPolicy === "never-run") {
      context.addIssue({
        code: "custom",
        message: "A never-run gate cannot be dispatched to a worker",
        path: ["skipPolicy"],
      })
    }
    if (value.blocking && value.skipPolicy === "optional") {
      context.addIssue({
        code: "custom",
        message: "An optional gate cannot be blocking",
        path: ["blocking"],
      })
    }
  })
export type GateWorkerRequest = z.infer<typeof GateWorkerRequestSchema>

export const GateWorkerResultSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    result: GateResultSchema,
    observations: z.array(WorkerObservationSchema).max(1_024),
  })
  .strict()
export type GateWorkerResult = z.infer<typeof GateWorkerResultSchema>

export const ChildTaskBudgetSnapshotSchema = z
  .object({
    limit: z.number().int().nonnegative(),
    consumed: z.number().int().nonnegative(),
    lastExecution: z
      .object({
        runId: NonEmptyStringSchema,
        documentId: NonEmptyStringSchema,
        taskId: NonEmptyStringSchema,
        effectiveOptions: EffectiveRunOptionsSchema,
        optionsHash: Sha256Schema,
        notices: z.array(z.string().max(16_384)).max(1_024),
        judgeAvailable: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.consumed > value.limit) {
      context.addIssue({
        code: "custom",
        message: "Child task budget consumption cannot exceed its limit",
        path: ["consumed"],
      })
    }
  })
export type ChildTaskBudgetSnapshot = z.infer<typeof ChildTaskBudgetSnapshotSchema>

export const ChildRunWorkerRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    scope: WorkerOperationScopeSchema,
    operation: z.enum(["execute", "reconcile-terminal"]),
    parentRunId: NonEmptyStringSchema,
    childRunId: NonEmptyStringSchema,
    parentDocumentId: NonEmptyStringSchema,
    parentTaskId: NonEmptyStringSchema,
    parentLinkRef: NonEmptyStringSchema,
    parentLinkHash: Sha256Schema,
    leaseId: NonEmptyStringSchema,
    executionRoot: AbsolutePathSchema,
    graphRootFile: AbsolutePathSchema,
    childDocumentId: NonEmptyStringSchema,
    childDocumentDefinitionHash: Sha256Schema,
    graphDefinitionHash: Sha256Schema,
    effectiveOptions: WorkerResourcePayloadSchema,
    optionResolution: WorkerResourcePayloadSchema,
    taskBudget: ChildTaskBudgetSnapshotSchema,
    mode: RunModeSchema,
    depth: z.number().int().nonnegative(),
    maximumDepth: z.number().int().positive(),
    parentPolicy: z.enum(["pause-with-parent", "survive-parent"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.depth > value.maximumDepth) {
      context.addIssue({
        code: "custom",
        message: "Child run depth exceeds its authorized maximum",
        path: ["depth"],
      })
    }
  })
export type ChildRunWorkerRequest = z.infer<typeof ChildRunWorkerRequestSchema>

export const ChildRunWorkerResultSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    childRunId: NonEmptyStringSchema,
    status: z.enum(["passed", "failed", "interrupted", "blocked", "cancelled"]),
    artifactsReconciled: z.boolean(),
    exitCode: z.number().int().optional(),
    summary: NonEmptyStringSchema,
    eventRefs: z.array(NonEmptyStringSchema).max(1_024),
    artifactRefs: z.array(NonEmptyStringSchema).max(1_024),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
    observations: z.array(WorkerObservationSchema).max(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: "custom",
        message: "Child run finish time cannot precede its start time",
        path: ["finishedAt"],
      })
    }
    if (value.status === "passed" && !value.artifactsReconciled) {
      context.addIssue({
        code: "custom",
        message: "A passed child worker result requires reconciled artifacts",
        path: ["artifactsReconciled"],
      })
    }
  })
export type ChildRunWorkerResult = z.infer<typeof ChildRunWorkerResultSchema>

const ChildTaskBudgetTaskSchema = z
  .object({
    runId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    taskSpecHash: Sha256Schema,
  })
  .strict()

export const ChildTaskBudgetReserveCallSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    childRunId: NonEmptyStringSchema,
    parentLinkRef: NonEmptyStringSchema,
    task: ChildTaskBudgetTaskSchema,
    effectiveOptions: EffectiveRunOptionsSchema,
    optionsHash: Sha256Schema,
    notices: z.array(z.string().max(16_384)).max(1_024),
  })
  .strict()
export type ChildTaskBudgetReserveCall = z.infer<typeof ChildTaskBudgetReserveCallSchema>

export const ChildTaskBudgetReserveResultSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    granted: z.boolean(),
    snapshot: ChildTaskBudgetSnapshotSchema,
  })
  .strict()
export type ChildTaskBudgetReserveResult = z.infer<typeof ChildTaskBudgetReserveResultSchema>

export const ChildTaskBudgetReportCallSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    childRunId: NonEmptyStringSchema,
    parentLinkRef: NonEmptyStringSchema,
    task: ChildTaskBudgetTaskSchema,
    judgeAvailable: z.boolean().optional(),
  })
  .strict()
export type ChildTaskBudgetReportCall = z.infer<typeof ChildTaskBudgetReportCallSchema>

export const ChildTaskBudgetBoundaryCallSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    childRunId: NonEmptyStringSchema,
    parentLinkRef: NonEmptyStringSchema,
    boundaryRunId: NonEmptyStringSchema,
  })
  .strict()
export type ChildTaskBudgetBoundaryCall = z.infer<typeof ChildTaskBudgetBoundaryCallSchema>

export const ChildRunObservationCallSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    childRunId: NonEmptyStringSchema,
    parentLinkRef: NonEmptyStringSchema,
    observation: z
      .object({
        status: z.enum(["starting", "running", "waiting", "blocked", "interrupted"]).optional(),
        observability: ChildRunObservabilitySchema,
        heartbeatAt: TimestampSchema.optional(),
        reason: z.string().min(1).max(65_536).optional(),
      })
      .strict(),
  })
  .strict()
export type ChildRunObservationCall = z.infer<typeof ChildRunObservationCallSchema>

export const ChildRunProjectEventCallSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    childRunId: NonEmptyStringSchema,
    parentLinkRef: NonEmptyStringSchema,
    event: EventEnvelopeSchema,
  })
  .strict()
export type ChildRunProjectEventCall = z.infer<typeof ChildRunProjectEventCallSchema>

export const GitIntegrationWorkerRequestSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    scope: WorkerOperationScopeSchema,
    integrationId: NonEmptyStringSchema,
    decisionRef: NonEmptyStringSchema,
    policyHash: Sha256Schema,
    action: z.enum(["inspect", "checkpoint", "integrate", "command"]),
    repositoryRoot: PortablePathSchema,
    worktreeRoot: PortablePathSchema.optional(),
    baseRef: NonEmptyStringSchema.optional(),
    sourceRef: NonEmptyStringSchema.optional(),
    targetRef: NonEmptyStringSchema.optional(),
    strategy: z.enum(["none", "merge", "rebase", "cherry-pick", "patch"]),
    checkpointMessage: NonEmptyStringSchema.optional(),
    gitCommand: WorkerCommandInvocationSchema,
    timeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS),
    maximumOutputBytes: z.number().int().positive(),
    maximumRawOutputBytes: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "checkpoint" && !value.checkpointMessage) {
      context.addIssue({
        code: "custom",
        message: "A Git checkpoint requires an explicit message",
        path: ["checkpointMessage"],
      })
    }
    if (value.action === "integrate" && (!value.sourceRef || !value.targetRef)) {
      context.addIssue({
        code: "custom",
        message: "Git integration requires explicit source and target refs",
        path: ["sourceRef"],
      })
    }
    if (value.action === "integrate" && value.strategy === "none") {
      context.addIssue({
        code: "custom",
        message: "Git integration requires an explicit non-none strategy",
        path: ["strategy"],
      })
    }
    if (value.maximumRawOutputBytes < value.maximumOutputBytes) {
      context.addIssue({
        code: "custom",
        message: "Git raw output boundary cannot be smaller than its summary boundary",
        path: ["maximumRawOutputBytes"],
      })
    }
  })
export type GitIntegrationWorkerRequest = z.infer<typeof GitIntegrationWorkerRequestSchema>

export const GitIntegrationWorkerResultSchema = z
  .object({
    schemaVersion: z.literal(WORKER_OPERATION_SCHEMA_VERSION),
    integrationId: NonEmptyStringSchema,
    action: z.enum(["inspect", "checkpoint", "integrate", "command"]),
    status: z.enum(["succeeded", "conflicted", "failed", "cancelled"]),
    headBefore: NonEmptyStringSchema.optional(),
    headAfter: NonEmptyStringSchema.optional(),
    checkpointRef: NonEmptyStringSchema.optional(),
    conflictPaths: z.array(PortablePathSchema).max(1_024),
    artifactRefs: z.array(NonEmptyStringSchema).max(1_024),
    summary: NonEmptyStringSchema,
    process: ProcessSettlementSchema.optional(),
    observations: z.array(WorkerObservationSchema).max(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "conflicted" && value.conflictPaths.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A conflicted Git result must identify at least one path",
        path: ["conflictPaths"],
      })
    }
    if (
      value.status === "succeeded" &&
      (value.action === "checkpoint" || value.action === "integrate") &&
      value.headAfter === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "A successful mutating Git result requires headAfter",
        path: ["headAfter"],
      })
    }
  })
export type GitIntegrationWorkerResult = z.infer<typeof GitIntegrationWorkerResultSchema>

export type WorkerOperationRequest =
  | ExecutorModelWorkerRequest
  | JudgeWorkerRequest
  | ToolWorkerRequest
  | GateWorkerRequest
  | ChildRunWorkerRequest
  | GitIntegrationWorkerRequest

export type WorkerOperationResult =
  | ExecutorModelWorkerResult
  | JudgeWorkerResult
  | ToolWorkerResult
  | GateWorkerResult
  | ChildRunWorkerResult
  | GitIntegrationWorkerResult

export type WorkerOperationRequestMap = {
  "executor-model.execute": ExecutorModelWorkerRequest
  "judge.evaluate": JudgeWorkerRequest
  "tool.execute": ToolWorkerRequest
  "gate.execute": GateWorkerRequest
  "child-run.execute": ChildRunWorkerRequest
  "git-integration.execute": GitIntegrationWorkerRequest
}

export type WorkerOperationResultMap = {
  "executor-model.execute": ExecutorModelWorkerResult
  "judge.evaluate": JudgeWorkerResult
  "tool.execute": ToolWorkerResult
  "gate.execute": GateWorkerResult
  "child-run.execute": ChildRunWorkerResult
  "git-integration.execute": GitIntegrationWorkerResult
}

export type WorkerOperationAuthority = {
  readonly identity: WorkerIdentity
  readonly capability: WorkerCapabilityGrant
}

export function workerOperationRole(operation: WorkerOperationName): WorkerRole {
  switch (operation) {
    case "executor-model.execute":
      return "executor-model"
    case "judge.evaluate":
      return "judge"
    case "tool.execute":
    case "gate.execute":
      return "tool-gate"
    case "child-run.execute":
      return "child-run"
    case "git-integration.execute":
      return "git-integration"
  }
}

export function workerOperationCapability(operation: WorkerOperationName): WorkerCapabilityAction {
  switch (operation) {
    case "executor-model.execute":
      return "model.execute"
    case "judge.evaluate":
      return "judge.evaluate"
    case "tool.execute":
      return "tool.execute"
    case "gate.execute":
      return "gate.execute"
    case "child-run.execute":
      return "child.execute"
    case "git-integration.execute":
      return "integration.execute"
  }
}

export function parseWorkerOperationRequest(
  operation: WorkerOperationName,
  payload: unknown,
): WorkerOperationRequest {
  switch (operation) {
    case "executor-model.execute":
      return ExecutorModelWorkerRequestSchema.parse(payload)
    case "judge.evaluate":
      return JudgeWorkerRequestSchema.parse(payload)
    case "tool.execute":
      return ToolWorkerRequestSchema.parse(payload)
    case "gate.execute":
      return GateWorkerRequestSchema.parse(payload)
    case "child-run.execute":
      return ChildRunWorkerRequestSchema.parse(payload)
    case "git-integration.execute":
      return GitIntegrationWorkerRequestSchema.parse(payload)
  }
}

export function parseWorkerOperationResult(
  operation: WorkerOperationName,
  result: unknown,
): WorkerOperationResult {
  switch (operation) {
    case "executor-model.execute":
      return ExecutorModelWorkerResultSchema.parse(result)
    case "judge.evaluate":
      return JudgeWorkerResultSchema.parse(result)
    case "tool.execute":
      return ToolWorkerResultSchema.parse(result)
    case "gate.execute":
      return GateWorkerResultSchema.parse(result)
    case "child-run.execute":
      return ChildRunWorkerResultSchema.parse(result)
    case "git-integration.execute":
      return GitIntegrationWorkerResultSchema.parse(result)
  }
}

/** Ensures a schema-valid result still belongs to the dispatched request. */
export function assertWorkerOperationResultBinding(
  operation: WorkerOperationName,
  requestInput: unknown,
  resultInput: unknown,
): WorkerOperationResult {
  switch (operation) {
    case "executor-model.execute": {
      const request = ExecutorModelWorkerRequestSchema.parse(requestInput)
      const result = ExecutorModelWorkerResultSchema.parse(resultInput)
      if (result.callId !== request.callId) {
        throw new Error("Executor worker result is bound to a different model call")
      }
      if (result.requestedToolCalls.length > request.limits.maximumToolCalls) {
        throw new Error("Executor worker result exceeds the dispatched tool-call limit")
      }
      const allowedTools = new Set(request.tools.map((tool) => tool.name))
      const requestedCallIds = new Set<string>()
      for (const call of result.requestedToolCalls) {
        if (!allowedTools.has(call.name)) {
          throw new Error(`Executor worker requested an undispatched tool: ${call.name}`)
        }
        if (requestedCallIds.has(call.callId)) {
          throw new Error(`Executor worker repeated tool call ID: ${call.callId}`)
        }
        requestedCallIds.add(call.callId)
      }
      return result
    }
    case "judge.evaluate": {
      const request = JudgeWorkerRequestSchema.parse(requestInput)
      const result = JudgeWorkerResultSchema.parse(resultInput)
      if (result.assessmentId !== request.assessmentId) {
        throw new Error("Judge worker result is bound to a different assessment")
      }
      const rubricCriteria = new Set(
        request.policy.rubric.criteria.map((criterion) => criterion.criterion),
      )
      for (const score of result.output.criterionScores) {
        if (!rubricCriteria.has(score.criterion)) {
          throw new Error(`Judge worker scored an undispatched criterion: ${score.criterion}`)
        }
      }
      for (const finding of result.output.problems) {
        if (finding.criterion && !rubricCriteria.has(finding.criterion)) {
          throw new Error(`Judge worker cited an undispatched criterion: ${finding.criterion}`)
        }
      }
      return result
    }
    case "tool.execute": {
      const request = ToolWorkerRequestSchema.parse(requestInput)
      const result = ToolWorkerResultSchema.parse(resultInput)
      if (result.callId !== request.toolCall.callId) {
        throw new Error("Tool worker result is bound to a different tool call")
      }
      return result
    }
    case "gate.execute": {
      const request = GateWorkerRequestSchema.parse(requestInput)
      const result = GateWorkerResultSchema.parse(resultInput)
      if (
        result.result.gateId !== request.gateId ||
        result.result.category !== request.category ||
        result.result.blocking !== request.blocking ||
        result.result.skipPolicy !== request.skipPolicy ||
        stableJson(result.result.criterionIds ?? []) !== stableJson(request.criterionIds)
      ) {
        throw new Error("Gate worker result metadata is not bound to the dispatched gate")
      }
      if (request.invocation.kind === "adapter") {
        if (result.result.command !== undefined) {
          throw new Error("Adapter gate result cannot allege a command invocation")
        }
      } else {
        const command = result.result.command
        const declaredCommand = gateCommandFromSpecification(request.specification)
        if (!command || !declaredCommand) {
          throw new Error("Command gate result is missing its bound command projection")
        }
        // `shell` is classification-only metadata for CommandSpec. The actual
        // process is still the canonical executable + argv capability below.
        const expectedCommand = GateCommandSchema.parse({
          ...declaredCommand,
          executable: realpathSync.native(request.invocation.command.executable),
          args: [...request.invocation.command.args],
          cwd: canonicalPath(request.scope.workspaceRoot, request.invocation.command.cwd),
        })
        if (stableJson(command) !== stableJson(expectedCommand)) {
          throw new Error("Gate worker result command is not bound to the dispatched invocation")
        }
      }
      return result
    }
    case "child-run.execute": {
      const request = ChildRunWorkerRequestSchema.parse(requestInput)
      const result = ChildRunWorkerResultSchema.parse(resultInput)
      if (result.childRunId !== request.childRunId) {
        throw new Error("Child worker result is bound to a different child run")
      }
      return result
    }
    case "git-integration.execute": {
      const request = GitIntegrationWorkerRequestSchema.parse(requestInput)
      const result = GitIntegrationWorkerResultSchema.parse(resultInput)
      if (result.integrationId !== request.integrationId || result.action !== request.action) {
        throw new Error("Git worker result is bound to a different integration action")
      }
      if (request.action === "command" && !result.process) {
        throw new Error("Git command worker result omitted its process settlement")
      }
      if (result.process) {
        const expectedExecutable = realpathSync.native(request.gitCommand.executable)
        const actualExecutable = result.process.argv[0]
          ? realpathSync.native(result.process.argv[0])
          : undefined
        if (
          !actualExecutable ||
          comparablePath(actualExecutable) !== comparablePath(expectedExecutable) ||
          stableJson(result.process.argv.slice(1)) !== stableJson(request.gitCommand.args) ||
          comparablePath(result.process.cwd) !==
            comparablePath(canonicalPath(request.scope.workspaceRoot, request.gitCommand.cwd))
        ) {
          throw new Error("Git process settlement is not bound to the dispatched command")
        }
      }
      return result
    }
  }
}

function operationScope(operation: WorkerOperationName, payload: unknown): WorkerOperationScope {
  const parsed = parseWorkerOperationRequest(operation, payload)
  return parsed.scope
}

function operationPaths(operation: WorkerOperationName, payload: unknown): readonly string[] {
  switch (operation) {
    case "executor-model.execute": {
      const request = ExecutorModelWorkerRequestSchema.parse(payload)
      return [
        ...request.requestedReadPaths,
        request.execution.controlRoot,
        ...request.resources.flatMap((resource) => (resource.path ? [resource.path] : [])),
        ...(request.continuation?.transcript?.path ? [request.continuation.transcript.path] : []),
        ...(request.transportCommand ? [request.transportCommand.cwd] : []),
      ]
    }
    case "judge.evaluate": {
      const request = JudgeWorkerRequestSchema.parse(payload)
      return [
        ...request.requestedReadPaths,
        request.evaluation.controlRoot,
        ...request.attachments.flatMap((resource) => (resource.path ? [resource.path] : [])),
        ...(request.transportCommand ? [request.transportCommand.cwd] : []),
      ]
    }
    case "tool.execute": {
      const request = ToolWorkerRequestSchema.parse(payload)
      return [
        ...request.requestedReadPaths,
        ...request.requestedWritePaths,
        ...(request.runtime.controlRoot ? [request.runtime.controlRoot] : []),
        ...(request.command ? [request.command.cwd] : []),
      ]
    }
    case "gate.execute": {
      const request = GateWorkerRequestSchema.parse(payload)
      return [
        ...request.requestedReadPaths,
        ...request.requestedWritePaths,
        ...(request.invocation.kind === "command" ? [request.invocation.command.cwd] : []),
      ]
    }
    case "child-run.execute": {
      const request = ChildRunWorkerRequestSchema.parse(payload)
      return [
        request.executionRoot,
        request.graphRootFile,
        ...(request.effectiveOptions.path ? [request.effectiveOptions.path] : []),
        ...(request.optionResolution.path ? [request.optionResolution.path] : []),
      ]
    }
    case "git-integration.execute": {
      const request = GitIntegrationWorkerRequestSchema.parse(payload)
      return [
        request.repositoryRoot,
        ...(request.worktreeRoot ? [request.worktreeRoot] : []),
        request.gitCommand.cwd,
      ]
    }
  }
}

function operationCommands(
  operation: WorkerOperationName,
  payload: unknown,
): readonly WorkerCommandInvocation[] {
  switch (operation) {
    case "executor-model.execute": {
      const command = ExecutorModelWorkerRequestSchema.parse(payload).transportCommand
      return command ? [command] : []
    }
    case "judge.evaluate": {
      const command = JudgeWorkerRequestSchema.parse(payload).transportCommand
      return command ? [command] : []
    }
    case "tool.execute": {
      const command = ToolWorkerRequestSchema.parse(payload).command
      return command ? [command] : []
    }
    case "gate.execute": {
      const invocation = GateWorkerRequestSchema.parse(payload).invocation
      return invocation.kind === "command" ? [invocation.command] : []
    }
    case "child-run.execute":
      return []
    case "git-integration.execute":
      return [GitIntegrationWorkerRequestSchema.parse(payload).gitCommand]
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path
}

/**
 * Resolves every existing ancestor through realpath and carries only a missing
 * suffix forward. Broken links and non-directory ancestors fail closed. This
 * catches symlink/junction escapes for existing paths and for prospective
 * write targets whose nearest existing ancestor is linked.
 */
function canonicalPath(workspaceRoot: string, candidate: string): string {
  const canonicalRoot = realpathSync.native(resolve(workspaceRoot))
  let cursor = resolve(canonicalRoot, candidate)
  const missingSuffix: string[] = []
  while (true) {
    try {
      const canonical = realpathSync.native(cursor)
      if (missingSuffix.length > 0 && !statSync(canonical).isDirectory()) {
        throw new Error(`Worker path has a non-directory ancestor: ${candidate}`)
      }
      return resolve(canonical, ...missingSuffix.reverse())
    } catch (error) {
      const code = errorCode(error)
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      try {
        if (lstatSync(cursor).isSymbolicLink()) {
          throw new Error(`Worker path contains a broken symbolic link or junction: ${candidate}`)
        }
      } catch (metadataError) {
        const metadataCode = errorCode(metadataError)
        if (metadataCode !== "ENOENT" && metadataCode !== "ENOTDIR") throw metadataError
      }
      const parent = dirname(cursor)
      if (parent === cursor) {
        throw new Error(`Worker path has no canonical existing ancestor: ${candidate}`)
      }
      missingSuffix.push(basename(cursor))
      cursor = parent
    }
  }
}

function pathIsWithin(scope: string, candidate: string): boolean {
  const child = relative(comparablePath(scope), comparablePath(candidate))
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
}

function executableContentHash(path: string): string {
  const canonical = realpathSync.native(path)
  const before = statSync(canonical)
  if (!before.isFile()) {
    throw new Error(`Worker command executable is not a regular file: ${path}`)
  }
  const bytes = readFileSync(canonical)
  const after = statSync(canonical)
  const canonicalAfter = realpathSync.native(canonical)
  if (
    !sameFileSnapshot(before, after) ||
    comparablePath(canonicalAfter) !== comparablePath(canonical)
  ) {
    throw new Error(`Worker command executable changed while it was hashed: ${path}`)
  }
  return createHash("sha256").update(bytes).digest("hex")
}

export function workerCommandCapabilityFingerprint(
  workspaceRoot: string,
  invocationInput: WorkerCommandInvocation,
): string {
  const invocation = WorkerCommandInvocationSchema.parse(invocationInput)
  const executable = realpathSync.native(invocation.executable)
  const actualExecutableHash = executableContentHash(executable)
  if (actualExecutableHash !== invocation.executableHash) {
    throw new Error(`Worker command executable hash mismatch: ${invocation.executable}`)
  }
  const cwd = canonicalPath(workspaceRoot, invocation.cwd)
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Worker command cwd is not a directory: ${invocation.cwd}`)
  }
  return namespacedHash("ralph.worker.command-capability.v1", {
    intent: invocation.intent,
    executable,
    executableHash: actualExecutableHash,
    args: invocation.args,
    cwd,
    environmentNames: invocation.environmentNames
      .map((name) => (process.platform === "win32" ? name.toLocaleUpperCase("en-US") : name))
      .sort(compareText),
  })
}

export function canonicalWorkerAuthorizedPaths(input: {
  workspaceRoot: string
  capability: WorkerCapabilityGrant
  paths: readonly string[]
}): readonly string[] {
  const pathScopes = input.capability.pathScopes.map((path) =>
    canonicalPath(input.workspaceRoot, path),
  )
  const authorized: string[] = []
  for (const requestedPath of input.paths) {
    const normalized = canonicalPath(input.workspaceRoot, requestedPath)
    if (!pathScopes.some((pathScope) => pathIsWithin(pathScope, normalized))) {
      throw new Error(`Worker path is outside its capability scope: ${requestedPath}`)
    }
    authorized.push(normalized)
  }
  return authorized
}

export function assertWorkerPathCapability(input: {
  workspaceRoot: string
  capability: WorkerCapabilityGrant
  paths: readonly string[]
}): void {
  canonicalWorkerAuthorizedPaths(input)
}

export function canonicalWorkerAuthorizedCommands(input: {
  workspaceRoot: string
  capability: WorkerCapabilityGrant
  commands: readonly WorkerCommandInvocation[]
}): readonly WorkerCommandInvocation[] {
  const authorized: WorkerCommandInvocation[] = []
  for (const command of input.commands) {
    const fingerprint = workerCommandCapabilityFingerprint(input.workspaceRoot, command)
    if (!input.capability.commandScopes.includes(fingerprint)) {
      throw new Error(
        `Worker command invocation is outside its exact capability scope: ${command.executable}`,
      )
    }
    authorized.push(
      WorkerCommandInvocationSchema.parse({
        ...command,
        executable: realpathSync.native(command.executable),
        cwd: canonicalPath(input.workspaceRoot, command.cwd),
      }),
    )
  }
  return authorized
}

export function assertWorkerCommandCapability(input: {
  workspaceRoot: string
  capability: WorkerCapabilityGrant
  commands: readonly WorkerCommandInvocation[]
}): void {
  canonicalWorkerAuthorizedCommands(input)
}

function canonicalizeDeclaredPaths(
  operation: WorkerOperationName,
  payload: WorkerOperationRequest,
): void {
  const map = (workspaceRoot: string, paths: string[]): string[] =>
    paths.map((path) => canonicalPath(workspaceRoot, path))
  const command = (
    workspaceRoot: string,
    invocation: WorkerCommandInvocation | undefined,
  ): void => {
    if (!invocation) return
    invocation.executable = realpathSync.native(invocation.executable)
    invocation.cwd = canonicalPath(workspaceRoot, invocation.cwd)
  }
  switch (operation) {
    case "executor-model.execute": {
      const request = payload as ExecutorModelWorkerRequest
      request.requestedReadPaths = map(request.scope.workspaceRoot, request.requestedReadPaths)
      request.execution.controlRoot = canonicalPath(
        request.scope.workspaceRoot,
        request.execution.controlRoot,
      )
      command(request.scope.workspaceRoot, request.transportCommand)
      return
    }
    case "judge.evaluate": {
      const request = payload as JudgeWorkerRequest
      request.requestedReadPaths = map(request.scope.workspaceRoot, request.requestedReadPaths)
      request.evaluation.controlRoot = canonicalPath(
        request.scope.workspaceRoot,
        request.evaluation.controlRoot,
      )
      command(request.scope.workspaceRoot, request.transportCommand)
      return
    }
    case "tool.execute": {
      const request = payload as ToolWorkerRequest
      request.requestedReadPaths = map(request.scope.workspaceRoot, request.requestedReadPaths)
      request.requestedWritePaths = map(request.scope.workspaceRoot, request.requestedWritePaths)
      command(request.scope.workspaceRoot, request.command)
      return
    }
    case "gate.execute": {
      const request = payload as GateWorkerRequest
      request.requestedReadPaths = map(request.scope.workspaceRoot, request.requestedReadPaths)
      request.requestedWritePaths = map(request.scope.workspaceRoot, request.requestedWritePaths)
      if (request.invocation.kind === "command") {
        command(request.scope.workspaceRoot, request.invocation.command)
      }
      return
    }
    case "child-run.execute": {
      const request = payload as ChildRunWorkerRequest
      request.executionRoot = canonicalPath(request.scope.workspaceRoot, request.executionRoot)
      request.graphRootFile = canonicalPath(request.scope.workspaceRoot, request.graphRootFile)
      return
    }
    case "git-integration.execute": {
      const request = payload as GitIntegrationWorkerRequest
      request.repositoryRoot = canonicalPath(request.scope.workspaceRoot, request.repositoryRoot)
      if (request.worktreeRoot) {
        request.worktreeRoot = canonicalPath(request.scope.workspaceRoot, request.worktreeRoot)
      }
      command(request.scope.workspaceRoot, request.gitCommand)
      return
    }
  }
}

function assertScopeIdentity(scope: WorkerOperationScope, identity: WorkerIdentity): void {
  if (scope.workspaceId !== identity.workspaceId || scope.runId !== identity.runId) {
    throw new Error("Worker operation scope does not match its boot identity")
  }
  const operationRoot = realpathSync.native(resolve(scope.workspaceRoot))
  const identityRoot = realpathSync.native(resolve(identity.workspaceRoot))
  if (comparablePath(operationRoot) !== comparablePath(identityRoot)) {
    throw new Error("Worker operation workspace path does not match its boot identity")
  }
  if (scope.attemptId !== identity.attemptId) {
    throw new Error("Worker operation attempt does not match its boot identity")
  }
  if (
    scope.deadlineAt &&
    identity.deadlineAt &&
    Date.parse(scope.deadlineAt) > Date.parse(identity.deadlineAt)
  ) {
    throw new Error("Worker operation deadline exceeds the worker identity deadline")
  }
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function assertResource(payload: WorkerResourcePayload): void {
  if (payload.content === undefined) {
    throw new Error(`Worker resource was not materialized: ${payload.resource.ref}`)
  }
  const bytes = Buffer.byteLength(payload.content, "utf8")
  const contentHash = createHash("sha256").update(payload.content, "utf8").digest("hex")
  const expectedHash = payload.resource.truncated
    ? payload.resource.includedHash
    : payload.resource.contentHash
  if (contentHash !== expectedHash) {
    throw new Error(`Worker resource content hash mismatch: ${payload.resource.ref}`)
  }
  const expectedBytes = payload.resource.truncated
    ? payload.resource.includedByteLength
    : payload.resource.byteLength
  if (expectedBytes !== undefined && expectedBytes !== bytes) {
    throw new Error(`Worker resource byte length mismatch: ${payload.resource.ref}`)
  }
}

function materializeResource(workspaceRoot: string, payload: WorkerResourcePayload): void {
  if (payload.path !== undefined) {
    const canonical = canonicalPath(workspaceRoot, payload.path)
    const before = statSync(canonical)
    if (!before.isFile()) {
      throw new Error(`Worker resource path is not a regular file: ${payload.resource.ref}`)
    }
    if (before.size > MAX_INLINE_WORKER_RESOURCE_BYTES) {
      throw new Error(
        `Worker resource exceeds ${MAX_INLINE_WORKER_RESOURCE_BYTES} bytes: ${payload.resource.ref}`,
      )
    }
    const bytes = readFileSync(canonical)
    const after = statSync(canonical)
    const canonicalAfter = realpathSync.native(canonical)
    if (
      !sameFileSnapshot(before, after) ||
      comparablePath(canonicalAfter) !== comparablePath(canonical)
    ) {
      throw new Error(`Worker resource changed while it was materialized: ${payload.resource.ref}`)
    }
    const content = bytes.toString("utf8")
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      throw new Error(`Worker resource is not valid UTF-8 text: ${payload.resource.ref}`)
    }
    payload.content = content
    delete payload.path
  }
  assertResource(payload)
}

function materializeOperationResources(
  operation: WorkerOperationName,
  payload: WorkerOperationRequest,
): void {
  switch (operation) {
    case "executor-model.execute": {
      const request = payload as ExecutorModelWorkerRequest
      for (const resource of request.resources)
        materializeResource(request.scope.workspaceRoot, resource)
      if (request.continuation?.transcript) {
        materializeResource(request.scope.workspaceRoot, request.continuation.transcript)
      }
      return
    }
    case "judge.evaluate": {
      const request = payload as JudgeWorkerRequest
      for (const attachment of request.attachments) {
        materializeResource(request.scope.workspaceRoot, attachment)
      }
      return
    }
    case "child-run.execute": {
      const request = payload as ChildRunWorkerRequest
      materializeResource(request.scope.workspaceRoot, request.effectiveOptions)
      materializeResource(request.scope.workspaceRoot, request.optionResolution)
      return
    }
    case "tool.execute":
    case "gate.execute":
    case "git-integration.execute":
      return
  }
}

function assertCommandIntent(
  command: WorkerCommandInvocation | undefined,
  expected: WorkerCommandIntent,
): void {
  if (command && command.intent !== expected) {
    throw new Error(`Worker command intent ${command.intent} does not match ${expected}`)
  }
}

function assertExecutorContextBundle(request: ExecutorModelWorkerRequest): void {
  const manifest = request.contextManifest
  const seenRefs = new Set<string>()
  const resources = request.resources
    .map((payload) => {
      assertResource(payload)
      const resource = payload.resource
      if (seenRefs.has(resource.ref)) {
        throw new Error(`Executor context contains duplicate resource ref: ${resource.ref}`)
      }
      seenRefs.add(resource.ref)
      if (
        payload.content === undefined ||
        resource.includedHash === undefined ||
        resource.mediaType === undefined ||
        resource.byteLength === undefined ||
        resource.includedByteLength === undefined
      ) {
        throw new Error(`Executor context resource metadata is incomplete: ${resource.ref}`)
      }
      const kind = z
        .enum(["verification", "full-prd", "assessment", "recovery"])
        .parse(resource.kind)
      return {
        ref: resource.ref,
        kind,
        mediaType: z.enum(["application/json", "text/markdown"]).parse(resource.mediaType),
        encoding: "utf-8" as const,
        content: payload.content,
        contentHash: resource.contentHash,
        includedHash: resource.includedHash,
        originalBytes: resource.byteLength,
        includedBytes: resource.includedByteLength,
        truncated: resource.truncated,
      }
    })
    .sort((left, right) => compareText(left.ref, right.ref))
  const {
    id: _id,
    createdAt: _createdAt,
    contentHash,
    baseline: manifestBaseline,
    ...manifestContent
  } = manifest
  const { capturedAt: _capturedAt, ...baseline } = manifestBaseline
  const projection = {
    ...manifestContent,
    baseline,
    resources,
    truncations: request.contextTruncations,
  }
  const actualHash = namespacedHash("ralph.execution.context-bundle.v1", projection)
  if (actualHash !== contentHash || manifest.id !== `context-${actualHash.slice(0, 24)}`) {
    throw new Error("Executor context bundle hash does not match its materialized content")
  }
}

function assertPayloadBindings(operation: WorkerOperationName, payload: unknown): void {
  const assertTaskAttemptScope = (scope: WorkerOperationScope): void => {
    if (!scope.documentId || !scope.taskId || !scope.attemptId) {
      throw new Error(`${operation} requires document, task and attempt scope`)
    }
  }
  switch (operation) {
    case "executor-model.execute": {
      const request = ExecutorModelWorkerRequestSchema.parse(payload)
      assertTaskAttemptScope(request.scope)
      for (const resource of request.resources) assertResource(resource)
      if (request.continuation?.transcript) assertResource(request.continuation.transcript)
      const manifest = request.contextManifest
      if (
        manifest.runId !== request.scope.runId ||
        manifest.attemptId !== request.scope.attemptId ||
        manifest.task.documentId !== request.scope.documentId ||
        manifest.task.taskId !== request.scope.taskId
      ) {
        throw new Error("Executor context manifest is not bound to the worker operation scope")
      }
      assertExecutorContextBundle(request)
      assertCommandIntent(request.transportCommand, "executor-transport")
      return
    }
    case "judge.evaluate": {
      const request = JudgeWorkerRequestSchema.parse(payload)
      assertTaskAttemptScope(request.scope)
      for (const attachment of request.attachments) assertResource(attachment)
      const evidence = request.evidence as Record<string, WorkerJsonValue>
      if (
        evidence.runId !== request.scope.runId ||
        evidence.attemptId !== request.scope.attemptId ||
        evidence.documentId !== request.scope.documentId ||
        evidence.taskId !== request.scope.taskId
      ) {
        throw new Error("Judge evidence is not bound to the worker operation scope")
      }
      if (
        namespacedHash("ralph.worker.judge-evaluation-bundle.v1", request.evaluation.bundle) !==
        request.evaluation.bundleHash
      ) {
        throw new Error("Judge evaluation bundle hash does not match its dispatched content")
      }
      assertCommandIntent(request.transportCommand, "judge-transport")
      return
    }
    case "child-run.execute": {
      const request = ChildRunWorkerRequestSchema.parse(payload)
      assertResource(request.effectiveOptions)
      assertResource(request.optionResolution)
      if (request.childRunId !== request.scope.runId) {
        throw new Error("Child worker run does not match the worker operation scope")
      }
      if (
        request.scope.documentId !== request.childDocumentId ||
        request.scope.taskId !== undefined ||
        request.scope.attemptId !== undefined
      ) {
        throw new Error("Child worker scope is not bound to its child document coordinator")
      }
      if (request.parentPolicy === "survive-parent") {
        throw new Error(
          "survive-parent requires an independently leased supervisor/process owner and is unavailable in the worker-owned process tree",
        )
      }
      return
    }
    case "tool.execute": {
      const request = ToolWorkerRequestSchema.parse(payload)
      assertTaskAttemptScope(request.scope)
      if (request.journalBinding.intentId !== request.toolCall.callId) {
        throw new Error("Tool worker journal intent does not match the dispatched tool call")
      }
      assertCommandIntent(request.command, "tool")
      return
    }
    case "gate.execute": {
      const request = GateWorkerRequestSchema.parse(payload)
      assertTaskAttemptScope(request.scope)
      const actualPlanHash = namespacedHash("ralph.worker.gate-plan.v1", request.specification)
      if (
        actualPlanHash !== request.gatePlanHash ||
        request.gatePlanRef !== `gate-plan:${actualPlanHash}`
      ) {
        throw new Error("Gate plan identity does not match its dispatched specification")
      }
      const declaredCommand = gateCommandFromSpecification(request.specification)
      if (request.invocation.kind === "command") {
        if (!declaredCommand) {
          throw new Error("Command gate invocation requires a command specification")
        }
        assertCommandIntent(request.invocation.command, "gate")
        const executableCandidate = isAbsolute(declaredCommand.executable)
          ? declaredCommand.executable
          : declaredCommand.executable === "bun" || declaredCommand.executable === "bun.exe"
            ? process.execPath
            : Bun.which(declaredCommand.executable)
        if (!executableCandidate) {
          throw new Error(`Gate command executable is unavailable: ${declaredCommand.executable}`)
        }
        const expectedExecutable = realpathSync.native(executableCandidate)
        const expectedCwd = canonicalPath(
          request.scope.workspaceRoot,
          declaredCommand.cwd ?? request.scope.workspaceRoot,
        )
        if (
          comparablePath(expectedExecutable) !==
            comparablePath(request.invocation.command.executable) ||
          stableJson(declaredCommand.args) !== stableJson(request.invocation.command.args) ||
          comparablePath(expectedCwd) !== comparablePath(request.invocation.command.cwd) ||
          declaredCommand.timeoutMs !== request.timeoutMs ||
          declaredCommand.outputLimitBytes !== request.maximumOutputBytes ||
          stableJson(declaredCommand.successExitCodes) !==
            stableJson(request.invocation.successExitCodes) ||
          stableJson(
            normalizedEnvironmentNames(Object.keys(declaredCommand.environmentRefs ?? {})),
          ) !== stableJson(normalizedEnvironmentNames(request.invocation.command.environmentNames))
        ) {
          throw new Error("Gate command specification is not bound to its canonical invocation")
        }
      } else if (declaredCommand) {
        throw new Error("Command gate specification cannot use an adapter invocation")
      }
      return
    }
    case "git-integration.execute": {
      const request = GitIntegrationWorkerRequestSchema.parse(payload)
      if (request.action === "checkpoint" || request.action === "integrate") {
        assertTaskAttemptScope(request.scope)
      }
      const intentByAction: Record<typeof request.action, WorkerCommandIntent> = {
        inspect: "git-inspect",
        checkpoint: "git-checkpoint",
        integrate: "git-integrate",
        command: "git-integrate",
      }
      assertCommandIntent(request.gitCommand, intentByAction[request.action])
      return
    }
  }
}

function deepFreezeWorkerValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeWorkerValue(child, seen)
  }
  return Object.freeze(value as object) as T
}

/**
 * Validates the request at the worker trust boundary. It binds payload identity,
 * role, capability, path scopes and command scopes before an adapter sees data.
 */
export function assertWorkerOperationAuthority(
  operationInput: string,
  payload: unknown,
  authority: WorkerOperationAuthority,
): WorkerOperationRequest {
  const operation = WorkerOperationNameSchema.parse(operationInput)
  const parsed = parseWorkerOperationRequest(operation, payload)
  const requiredRole = workerOperationRole(operation)
  const requiredCapability = workerOperationCapability(operation)
  if (authority.identity.role !== requiredRole) {
    throw new Error(`Worker role ${authority.identity.role} cannot execute ${operation}`)
  }
  if (authority.capability.action !== requiredCapability) {
    throw new Error(`Worker capability ${authority.capability.action} cannot execute ${operation}`)
  }

  const scope = operationScope(operation, parsed)
  assertScopeIdentity(scope, authority.identity)
  assertWorkerPathCapability({
    workspaceRoot: scope.workspaceRoot,
    capability: authority.capability,
    paths: operationPaths(operation, parsed),
  })
  canonicalizeDeclaredPaths(operation, parsed)
  assertWorkerCommandCapability({
    workspaceRoot: scope.workspaceRoot,
    capability: authority.capability,
    commands: operationCommands(operation, parsed),
  })
  materializeOperationResources(operation, parsed)
  const materialized = parseWorkerOperationRequest(operation, parsed)
  assertPayloadBindings(operation, materialized)
  return deepFreezeWorkerValue(materialized)
}
