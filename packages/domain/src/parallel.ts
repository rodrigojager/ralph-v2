import { z } from "zod"

const NonEmptyStringSchema = z.string().trim().min(1).max(4_096)
const IdentifierSchema = z.string().trim().min(1).max(512)
const TimestampSchema = z.iso.datetime({ offset: true })
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const ResourceClaimKindSchema = z.enum([
  "task",
  "path",
  "artifact",
  "port",
  "worktree",
  "branch",
  "integration-target",
])
export type ResourceClaimKind = z.infer<typeof ResourceClaimKindSchema>

export const ResourceClaimModeSchema = z.enum(["exclusive", "shared-read"])
export type ResourceClaimMode = z.infer<typeof ResourceClaimModeSchema>

export const ResourceClaimStatusSchema = z.enum(["active", "released", "expired"])
export type ResourceClaimStatus = z.infer<typeof ResourceClaimStatusSchema>

export const ResourceClaimSpecSchema = z
  .object({
    kind: ResourceClaimKindSchema,
    resourceKey: NonEmptyStringSchema,
    mode: ResourceClaimModeSchema.default("exclusive"),
    metadata: z.record(z.string().max(128), z.unknown()).default({}),
  })
  .strict()
export type ResourceClaimSpec = z.infer<typeof ResourceClaimSpecSchema>

export const ResourceClaimRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    claimSetId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    runId: IdentifierSchema,
    documentId: IdentifierSchema,
    taskId: IdentifierSchema,
    attemptId: IdentifierSchema,
    workerId: IdentifierSchema,
    kind: ResourceClaimKindSchema,
    resourceKey: NonEmptyStringSchema,
    mode: ResourceClaimModeSchema,
    metadata: z.record(z.string().max(128), z.unknown()),
    status: ResourceClaimStatusSchema,
    acquiredAt: TimestampSchema,
    renewedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    graceExpiresAt: TimestampSchema,
    revision: z.number().int().nonnegative(),
    releasedAt: TimestampSchema.optional(),
    releaseReason: NonEmptyStringSchema.optional(),
  })
  .strict()
export type ResourceClaimRecord = z.infer<typeof ResourceClaimRecordSchema>

export const ResourceClaimSetRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    runId: IdentifierSchema,
    documentId: IdentifierSchema,
    taskId: IdentifierSchema,
    attemptId: IdentifierSchema,
    workerId: IdentifierSchema,
    ownerInstanceId: IdentifierSchema,
    pid: z.number().int().positive(),
    processStartToken: NonEmptyStringSchema,
    hostname: IdentifierSchema,
    status: ResourceClaimStatusSchema,
    acquiredAt: TimestampSchema,
    renewedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    graceExpiresAt: TimestampSchema,
    revision: z.number().int().nonnegative(),
    releasedAt: TimestampSchema.optional(),
    releaseReason: NonEmptyStringSchema.optional(),
    claims: z.array(ResourceClaimRecordSchema).min(1).max(1_024),
  })
  .strict()
export type ResourceClaimSetRecord = z.infer<typeof ResourceClaimSetRecordSchema>

export const ResourceClaimConflictSchema = z
  .object({
    requested: ResourceClaimSpecSchema,
    activeClaim: ResourceClaimRecordSchema,
    reason: NonEmptyStringSchema,
  })
  .strict()
export type ResourceClaimConflict = z.infer<typeof ResourceClaimConflictSchema>

export const GitWorktreeRetentionSchema = z.enum([
  "remove-after-integration",
  "keep-on-failure",
  "always-keep",
])
export type GitWorktreeRetention = z.infer<typeof GitWorktreeRetentionSchema>

export const GitWorktreeStatusSchema = z.enum([
  "preparing",
  "active",
  "integrating",
  "integrated",
  "conflicted",
  "failed",
  "retained",
  "removed",
])
export type GitWorktreeStatus = z.infer<typeof GitWorktreeStatusSchema>

export const GitWorktreeRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    runId: IdentifierSchema,
    documentId: IdentifierSchema,
    taskId: IdentifierSchema,
    attemptId: IdentifierSchema,
    repositoryRoot: NonEmptyStringSchema,
    worktreePath: NonEmptyStringSchema,
    branch: IdentifierSchema,
    baseRef: IdentifierSchema,
    integrationTarget: IdentifierSchema,
    retention: GitWorktreeRetentionSchema,
    status: GitWorktreeStatusSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    revision: z.number().int().nonnegative(),
    head: IdentifierSchema.optional(),
    failureReason: NonEmptyStringSchema.optional(),
  })
  .strict()
export type GitWorktreeRecord = z.infer<typeof GitWorktreeRecordSchema>

export const GitIntegrationStrategySchema = z.enum([
  "none",
  "merge",
  "rebase-merge",
  "cherry-pick",
  "create-pr",
])
export type GitIntegrationStrategy = z.infer<typeof GitIntegrationStrategySchema>

export const GitIntegrationStatusSchema = z.enum([
  "pending",
  "running",
  "passed",
  "conflicted",
  "failed",
  "paused",
  "pr-created",
])
export type GitIntegrationStatus = z.infer<typeof GitIntegrationStatusSchema>

export const GitIntegrationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    runId: IdentifierSchema,
    worktreeId: IdentifierSchema,
    taskId: IdentifierSchema,
    order: z.number().int().nonnegative(),
    strategy: GitIntegrationStrategySchema,
    sourceRef: IdentifierSchema,
    targetRef: IdentifierSchema,
    sourceHead: IdentifierSchema,
    targetHeadBefore: IdentifierSchema.optional(),
    status: GitIntegrationStatusSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    revision: z.number().int().nonnegative(),
    attemptId: IdentifierSchema.optional(),
    resultHead: IdentifierSchema.optional(),
    pullRequestRef: NonEmptyStringSchema.optional(),
    conflictPaths: z.array(NonEmptyStringSchema).max(10_000).default([]),
    summary: NonEmptyStringSchema.optional(),
  })
  .strict()
export type GitIntegrationRecord = z.infer<typeof GitIntegrationRecordSchema>

export const CheckpointFileEntrySchema = z
  .object({
    path: NonEmptyStringSchema,
    kind: z.enum(["file", "missing"]),
    sizeBytes: z.number().int().nonnegative(),
    sha256: Sha256Schema.optional(),
    contentRef: NonEmptyStringSchema.optional(),
    executable: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "file" && (!value.sha256 || !value.contentRef)) {
      context.addIssue({
        code: "custom",
        message: "Checkpoint files require both sha256 and contentRef",
      })
    }
    if (value.kind === "missing" && (value.sha256 || value.contentRef || value.sizeBytes !== 0)) {
      context.addIssue({
        code: "custom",
        message: "Missing checkpoint entries cannot carry file content",
      })
    }
  })
export type CheckpointFileEntry = z.infer<typeof CheckpointFileEntrySchema>

export const CheckpointInventoryRootSchema = z
  .object({
    path: NonEmptyStringSchema,
    kind: z.enum(["directory", "missing"]),
    fileCount: z.number().int().nonnegative(),
    treeHash: Sha256Schema,
  })
  .strict()
export type CheckpointInventoryRoot = z.infer<typeof CheckpointInventoryRootSchema>

export const CheckpointRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    runId: IdentifierSchema.optional(),
    taskId: IdentifierSchema.optional(),
    attemptId: IdentifierSchema.optional(),
    reason: NonEmptyStringSchema,
    createdBy: IdentifierSchema,
    createdAt: TimestampSchema,
    repositoryRoot: NonEmptyStringSchema,
    gitHead: IdentifierSchema.optional(),
    gitBranch: IdentifierSchema.optional(),
    gitStatusHash: Sha256Schema,
    gitStatusRef: NonEmptyStringSchema.optional(),
    gitDiffHash: Sha256Schema,
    gitDiffRef: NonEmptyStringSchema.optional(),
    prdRevisionHash: Sha256Schema,
    stateRevision: z.number().int().nonnegative(),
    ledgerBackupRef: NonEmptyStringSchema.optional(),
    files: z.array(CheckpointFileEntrySchema).max(100_000),
    inventoryRoots: z.array(CheckpointInventoryRootSchema).max(1_024).default([]),
    manifestHash: Sha256Schema,
    status: z.enum(["available", "applied", "conflicted"]),
    appliedAt: TimestampSchema.optional(),
  })
  .strict()
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>

export const RollbackOperationSchema = z
  .object({
    kind: z.enum(["restore-file", "remove-file"]),
    path: NonEmptyStringSchema,
    expectedCurrentSha256: Sha256Schema.optional(),
    checkpointSha256: Sha256Schema.optional(),
    contentRef: NonEmptyStringSchema.optional(),
  })
  .strict()
export type RollbackOperation = z.infer<typeof RollbackOperationSchema>

export const RollbackConflictSchema = z
  .object({
    path: NonEmptyStringSchema,
    reason: NonEmptyStringSchema,
    checkpointSha256: Sha256Schema.optional(),
    currentSha256: Sha256Schema.optional(),
  })
  .strict()
export type RollbackConflict = z.infer<typeof RollbackConflictSchema>

export const RollbackPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    checkpointId: IdentifierSchema,
    workspaceId: IdentifierSchema,
    createdAt: TimestampSchema,
    expiresAt: TimestampSchema,
    operations: z.array(RollbackOperationSchema).max(100_000),
    conflicts: z.array(RollbackConflictSchema).max(100_000),
    inventoryPaths: z.array(NonEmptyStringSchema).max(100_000),
    currentInventoryHash: Sha256Schema,
    expectedGitHead: IdentifierSchema.optional(),
    expectedPrdRevisionHash: Sha256Schema,
    expectedStateRevision: z.number().int().nonnegative(),
    planHash: Sha256Schema,
    requiresExplicitConfirmation: z.literal(true),
    requiresSafetyCheckpoint: z.literal(true),
  })
  .strict()
export type RollbackPlan = z.infer<typeof RollbackPlanSchema>

export const NetworkAccessModeSchema = z.enum(["none", "allowlist", "full"])
export type NetworkAccessMode = z.infer<typeof NetworkAccessModeSchema>

export const NetworkPolicySchema = z
  .object({
    mode: NetworkAccessModeSchema,
    destinations: z.array(NonEmptyStringSchema).max(1_024).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "allowlist" && value.destinations.length === 0) {
      context.addIssue({ code: "custom", message: "Network allowlist cannot be empty" })
    }
    if (value.mode !== "allowlist" && value.destinations.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Network destinations are only valid in allowlist mode",
      })
    }
  })
export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>

export const ExternalEffectRuleSchema = z
  .object({
    capability: IdentifierSchema,
    action: z.enum(["deny", "ask", "allow"]),
    requireIdempotencyKey: z.boolean().default(true),
  })
  .strict()
export type ExternalEffectRule = z.infer<typeof ExternalEffectRuleSchema>

export const SecurityPolicySnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    role: z.enum(["executor", "judge"]),
    profile: z.enum(["safe", "auto", "dangerous"]),
    interactive: z.boolean(),
    headlessAsk: z.enum(["deny", "allow"]),
    commandAllowlist: z.array(NonEmptyStringSchema).max(4_096),
    network: NetworkPolicySchema,
    externalEffects: z.array(ExternalEffectRuleSchema).max(1_024),
    destructiveOperations: z.literal(false),
    judgeReadOnly: z.literal(true),
    dangerousOverrideReason: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.profile === "dangerous" && !value.dangerousOverrideReason) {
      context.addIssue({
        code: "custom",
        path: ["dangerousOverrideReason"],
        message: "Dangerous mode requires an auditable override reason",
      })
    }
  })
export type SecurityPolicySnapshot = z.infer<typeof SecurityPolicySnapshotSchema>

export const SandboxBackendSchema = z.enum(["process", "docker", "podman"])
export type SandboxBackend = z.infer<typeof SandboxBackendSchema>

export const SandboxCapabilitySchema = z
  .object({
    schemaVersion: z.literal(1),
    backend: SandboxBackendSchema,
    available: z.boolean(),
    version: NonEmptyStringSchema.optional(),
    filesystemIsolation: z.enum(["policy", "container"]),
    networkIsolation: z.enum(["none", "container"]),
    processIsolation: z.enum(["supervised", "container"]),
    supportsNetworkAllowlist: z.boolean(),
    reason: NonEmptyStringSchema.optional(),
  })
  .strict()
export type SandboxCapability = z.infer<typeof SandboxCapabilitySchema>

export const SandboxMountSchema = z
  .object({
    source: NonEmptyStringSchema,
    target: NonEmptyStringSchema,
    mode: z.enum(["read-only", "read-write"]),
  })
  .strict()
export type SandboxMount = z.infer<typeof SandboxMountSchema>

export const SandboxResourceLimitsSchema = z
  .object({
    cpuCount: z.number().positive().max(1_024).optional(),
    memoryBytes: z.number().int().positive().optional(),
    processCount: z.number().int().positive().optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1_000),
  })
  .strict()
export type SandboxResourceLimits = z.infer<typeof SandboxResourceLimitsSchema>

export const SandboxSpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    backend: SandboxBackendSchema,
    workspaceRoot: NonEmptyStringSchema,
    workingDirectory: NonEmptyStringSchema,
    image: NonEmptyStringSchema.optional(),
    mounts: z.array(SandboxMountSchema).max(256),
    network: NetworkPolicySchema,
    environmentAllowlist: z.array(IdentifierSchema).max(1_024),
    environment: z.record(IdentifierSchema, z.string().max(1_048_576)),
    resources: SandboxResourceLimitsSchema,
    ports: z.array(z.number().int().min(1).max(65_535)).max(256),
    user: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.backend !== "process" && !value.image) {
      context.addIssue({ code: "custom", path: ["image"], message: "Container image required" })
    }
    const allowed = new Set(value.environmentAllowlist)
    for (const name of Object.keys(value.environment)) {
      if (!allowed.has(name)) {
        context.addIssue({
          code: "custom",
          path: ["environment", name],
          message: "Environment value is not in the explicit allowlist",
        })
      }
    }
  })
export type SandboxSpec = z.infer<typeof SandboxSpecSchema>

export const SandboxSessionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    workspaceId: IdentifierSchema,
    runId: IdentifierSchema,
    taskId: IdentifierSchema,
    attemptId: IdentifierSchema,
    workerId: IdentifierSchema,
    backend: SandboxBackendSchema,
    status: z.enum(["preparing", "ready", "running", "stopped", "failed", "orphaned"]),
    capability: SandboxCapabilitySchema,
    specHash: Sha256Schema,
    backendResourceId: NonEmptyStringSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    revision: z.number().int().nonnegative(),
    /** Only literal true releases the workspace/task barrier; absent is unsafe legacy state. */
    terminationConfirmed: z.boolean().optional(),
    failureReason: NonEmptyStringSchema.optional(),
  })
  .strict()
export type SandboxSessionRecord = z.infer<typeof SandboxSessionRecordSchema>
