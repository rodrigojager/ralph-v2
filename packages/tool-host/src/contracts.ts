import { z } from "zod"

const NonEmptyStringSchema = z.string().min(1)
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const CounterSchema = z.number().int().nonnegative()
const TimestampSchema = z.iso.datetime({ offset: true })

export const BUILTIN_TOOL_NAMES = [
  "fs.read",
  "fs.list",
  "fs.glob",
  "fs.search",
  "fs.write",
  "fs.edit",
  "fs.apply_patch",
  "process.exec",
  "git.inspect",
  "artifact.publish",
] as const

export const BuiltinToolNameSchema = z.enum(BUILTIN_TOOL_NAMES)
export type BuiltinToolName = z.infer<typeof BuiltinToolNameSchema>

export const ToolRiskSchema = z.enum([
  "read",
  "write",
  "process",
  "network",
  "external-effect",
  "destructive",
])
export type ToolRisk = z.infer<typeof ToolRiskSchema>

export const ToolDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    inputSchema: z.record(z.string(), z.unknown()),
    risk: ToolRiskSchema,
    mutatesWorkspace: z.boolean(),
  })
  .strict()
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>

export const ToolCallSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    modelCallId: NonEmptyStringSchema,
    providerToolCallId: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    arguments: z.record(z.string(), z.unknown()),
    idempotencyKey: NonEmptyStringSchema.optional(),
    requestedAt: TimestampSchema,
  })
  .strict()
export type ToolCall = z.infer<typeof ToolCallSchema>

export const ToolSettlementOutcomeSchema = z.enum([
  "success",
  "nonzero",
  "denied",
  "invalid",
  "error",
  "timeout",
  "cancelled",
  "unsettled",
])
export type ToolSettlementOutcome = z.infer<typeof ToolSettlementOutcomeSchema>

export const ToolRecoveryClassificationSchema = z.enum([
  "safe-to-retry",
  "reconcile-by-precondition",
  "effect-confirmed",
  "effect-absent",
  "unknown-external-effect",
  "manual-review",
])
export type ToolRecoveryClassification = z.infer<typeof ToolRecoveryClassificationSchema>

export const ToolEffectSchema = z
  .object({
    path: NonEmptyStringSchema.optional(),
    kind: z.enum(["read", "created", "modified", "process", "artifact"]),
    beforeSha256: Sha256Schema.nullable().optional(),
    afterSha256: Sha256Schema.nullable().optional(),
    ref: NonEmptyStringSchema.optional(),
  })
  .strict()
export type ToolEffect = z.infer<typeof ToolEffectSchema>

export const ToolSettlementSchema = z
  .object({
    schemaVersion: z.literal(1),
    toolCallId: NonEmptyStringSchema,
    outcome: ToolSettlementOutcomeSchema,
    content: z.unknown(),
    outputRefs: z.array(NonEmptyStringSchema),
    effects: z.array(ToolEffectSchema),
    durationMs: CounterSchema,
    retryable: z.boolean(),
    recovery: ToolRecoveryClassificationSchema,
    reason: NonEmptyStringSchema.optional(),
    settledAt: TimestampSchema,
  })
  .strict()
export type ToolSettlement = z.infer<typeof ToolSettlementSchema>

export const ToolAuthorizationActionSchema = z.enum(["allow", "deny", "ask"])
export type ToolAuthorizationAction = z.infer<typeof ToolAuthorizationActionSchema>

export const ToolAuthorizationSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: NonEmptyStringSchema,
    requestHash: Sha256Schema,
    action: ToolAuthorizationActionSchema,
    reason: NonEmptyStringSchema,
    ruleId: NonEmptyStringSchema.optional(),
    auditedOverride: z.boolean(),
    decidedAt: TimestampSchema,
  })
  .strict()
export type ToolAuthorization = z.infer<typeof ToolAuthorizationSchema>

export const CommandRuleSchema = z
  .object({
    id: NonEmptyStringSchema,
    executable: NonEmptyStringSchema,
    argsPrefix: z.array(z.string()).optional(),
    exactArgs: z.array(z.string()).optional(),
    shell: z.boolean().default(false),
    risk: z.enum(["process", "destructive"]).default("process"),
  })
  .strict()
  .refine((value) => !(value.argsPrefix && value.exactArgs), {
    message: "A command rule cannot combine exactArgs and argsPrefix",
  })
export type CommandRule = z.infer<typeof CommandRuleSchema>

export const ToolLimitsSchema = z
  .object({
    maxReadBytes: z.number().int().positive().default(1_048_576),
    maxWriteBytes: z.number().int().positive().default(1_048_576),
    maxListEntries: z.number().int().positive().default(2_000),
    maxGlobMatches: z.number().int().positive().default(2_000),
    maxSearchFiles: z.number().int().positive().default(2_000),
    maxSearchMatches: z.number().int().positive().default(1_000),
    maxSearchFileBytes: z.number().int().positive().default(1_048_576),
    maxProcessOutputBytes: z.number().int().positive().default(1_048_576),
    maxProcessRawOutputBytes: z.number().int().positive().default(16_777_216),
    maxProcessTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1_000),
  })
  .strict()
export type ToolLimits = z.infer<typeof ToolLimitsSchema>

export const ToolPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    role: z.enum(["executor", "judge"]),
    securityMode: z.enum(["safe", "auto", "dangerous"]),
    interactive: z.boolean(),
    headlessAsk: z.enum(["deny", "allow"]).default("deny"),
    toolRules: z
      .record(z.string().regex(/^[a-z][a-z0-9_.:-]*$/), ToolAuthorizationActionSchema)
      .default({}),
    readScopes: z.array(NonEmptyStringSchema).min(1),
    writeScopes: z.array(NonEmptyStringSchema),
    protectedPaths: z.array(NonEmptyStringSchema),
    allowedTools: z.array(NonEmptyStringSchema).optional(),
    commandRules: z.array(CommandRuleSchema),
    allowUnlistedProcess: z.boolean().default(false),
    allowDestructive: z.boolean().default(false),
    allowShell: z.boolean().default(false),
    followInternalSymlinksForRead: z.boolean().default(false),
    limits: ToolLimitsSchema,
  })
  .strict()
export type ToolPolicy = z.infer<typeof ToolPolicySchema>

export const PermissionFactsSchema = z
  .object({
    risk: ToolRiskSchema,
    mutatesWorkspace: z.boolean(),
    pathProtected: z.boolean().default(false),
    pathInReadScope: z.boolean().default(false),
    pathInWriteScope: z.boolean().default(false),
    commandRuleId: NonEmptyStringSchema.optional(),
    commandRuleRisk: z.enum(["process", "destructive"]).optional(),
    shell: z.boolean().default(false),
  })
  .strict()
export type PermissionFacts = z.infer<typeof PermissionFactsSchema>

export const ToolPermissionRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    requestHash: Sha256Schema,
    toolCallId: NonEmptyStringSchema,
    tool: NonEmptyStringSchema,
    argumentsHash: Sha256Schema,
    risk: ToolRiskSchema,
    role: z.enum(["executor", "judge"]),
    securityMode: z.enum(["safe", "auto", "dangerous"]),
    reason: NonEmptyStringSchema,
    requestedAt: TimestampSchema,
  })
  .strict()
export type ToolPermissionRequest = z.infer<typeof ToolPermissionRequestSchema>

export const ToolPermissionResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: NonEmptyStringSchema,
    requestHash: Sha256Schema,
    action: z.enum(["allow", "deny"]),
    reason: NonEmptyStringSchema,
    respondedAt: TimestampSchema,
  })
  .strict()
export type ToolPermissionResponse = z.infer<typeof ToolPermissionResponseSchema>

export const ToolCallRecordStatusSchema = z.enum([
  "requested",
  "authorized",
  "started",
  "settled",
  "unsettled",
])

export const ToolCallRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    attemptId: NonEmptyStringSchema,
    modelCallId: NonEmptyStringSchema,
    providerToolCallId: NonEmptyStringSchema,
    tool: NonEmptyStringSchema,
    argumentsHash: Sha256Schema,
    argumentsRedacted: z.unknown(),
    idempotencyKey: NonEmptyStringSchema,
    risk: ToolRiskSchema,
    authorization: ToolAuthorizationSchema.optional(),
    status: ToolCallRecordStatusSchema,
    effects: z.array(ToolEffectSchema),
    settlement: ToolSettlementSchema.optional(),
    recovery: ToolRecoveryClassificationSchema,
    requestedAt: TimestampSchema,
    startedAt: TimestampSchema.optional(),
    settledAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema,
  })
  .strict()
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>

export type ToolEvent = {
  type:
    | "tool.call.requested"
    | "tool.call.authorized"
    | "tool.call.started"
    | "tool.output.delta"
    | "tool.call.settled"
  level?: "trace" | "debug" | "info" | "warn" | "error"
  toolCallId: string
  payload: Readonly<Record<string, unknown>>
}

export interface ToolEventSink {
  emit(event: ToolEvent): void | Promise<void>
}

export type ReserveToolCallInput = {
  record: ToolCallRecord
  maximumToolCalls: number
}

export type ReserveToolCallResult =
  | { status: "reserved"; record: ToolCallRecord }
  | { status: "duplicate"; record: ToolCallRecord; settlement?: ToolSettlement }
  | { status: "budget-exhausted" }

export interface ToolJournal {
  reserve(input: ReserveToolCallInput): Promise<ReserveToolCallResult>
  authorize(id: string, authorization: ToolAuthorization): Promise<ToolCallRecord>
  start(id: string, startedAt: string): Promise<ToolCallRecord>
  settle(id: string, settlement: ToolSettlement): Promise<ToolCallRecord>
  markUnsettled(
    id: string,
    recovery: ToolRecoveryClassification,
    updatedAt: string,
  ): Promise<ToolCallRecord>
  get(id: string): Promise<ToolCallRecord | undefined>
  listUnsettled(attemptId: string): Promise<readonly ToolCallRecord[]>
}

export interface PermissionPromptPort {
  request(input: ToolPermissionRequest, signal?: AbortSignal): Promise<ToolPermissionResponse>
}

export type ProcessPortRequest = {
  executable: string
  args: readonly string[]
  cwd: string
  environment: Readonly<Record<string, string | undefined>>
  environmentRefs?: Readonly<Record<string, string>>
  shell?:
    | false
    | {
        kind: "powershell" | "cmd" | "sh" | "bash" | "custom"
        script: string
        executable?: string
      }
  stdin?: string | Uint8Array
  timeoutMs: number
  outputLimitBytes: number
  rawOutputLimitBytes: number
  signal?: AbortSignal
  secretValues?: readonly string[]
  onOutput?: (stream: "stdout" | "stderr", delta: string) => void | Promise<void>
}

export type ProcessPortResult = {
  exitCode?: number
  signal?: string
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  outputTruncated: boolean
  rawOutputTruncated: boolean
  timedOut: boolean
  cancelled: boolean
  treeTerminated: boolean
  outputRefs: readonly string[]
  durationMs: number
  error?: string
}

export interface ProcessExecutorPort {
  run(request: ProcessPortRequest): Promise<ProcessPortResult>
  which(
    executable: string,
    environment?: Readonly<Record<string, string | undefined>>,
  ): string | null
}

export type PublishedArtifact = {
  artifactId: string
  path: string
  contentHash: string
  sizeBytes: number
  ref: string
}

export interface ArtifactPublisherPort {
  publish(input: {
    artifactId: string
    workspaceRoot: string
    path: string
    expectedSha256?: string
    maximumBytes: number
  }): Promise<PublishedArtifact>
}

export type ToolSession = {
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  modelCallId: string
  workspaceRoot: string
  policy: ToolPolicy
  maximumToolCalls: number
  deadlineAt?: string
  signal?: AbortSignal
  environment?: Readonly<Record<string, string | undefined>>
  secretValues?: readonly string[]
}
