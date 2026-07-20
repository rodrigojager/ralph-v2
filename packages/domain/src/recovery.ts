import { z } from "zod"

const NonEmptyStringSchema = z.string().min(1).max(4_096)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const TimestampSchema = z.iso.datetime({ offset: true })
const CounterSchema = z.number().int().nonnegative()

export const RecoveryStateSchema = z.enum(["clean", "continued", "workspace_changed"])
export type RecoveryState = z.infer<typeof RecoveryStateSchema>

export const RecoveryActionSchema = z.enum([
  "continue",
  "inspect",
  "checkpoint",
  "rollback-explicit",
])
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>

export const RecoveryChangeFileSchema = z
  .object({
    path: NonEmptyStringSchema,
    kind: z.enum(["created", "modified", "deleted"]),
    beforeSha256: Sha256Schema.optional(),
    afterSha256: Sha256Schema.optional(),
    beforeRef: NonEmptyStringSchema.optional(),
    afterRef: NonEmptyStringSchema.optional(),
  })
  .strict()
export type RecoveryChangeFile = z.infer<typeof RecoveryChangeFileSchema>

export const RecoveryManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    attemptId: NonEmptyStringSchema,
    state: RecoveryStateSchema,
    taskBaselineHash: Sha256Schema,
    observedWorkspaceHash: Sha256Schema,
    expectedWorkspaceHash: Sha256Schema.optional(),
    externalMutation: z.enum(["not-detected", "suspected", "unknown"]),
    diff: z
      .object({
        ref: NonEmptyStringSchema,
        contentHash: Sha256Schema,
        reproducible: z.boolean(),
      })
      .strict()
      .optional(),
    changes: z
      .object({
        total: CounterSchema,
        included: CounterSchema,
        truncated: z.boolean(),
        omittedPathsHash: Sha256Schema.optional(),
        created: z.array(NonEmptyStringSchema),
        modified: z.array(NonEmptyStringSchema),
        deleted: z.array(NonEmptyStringSchema),
        untrackedTotal: CounterSchema,
        untracked: z.array(NonEmptyStringSchema),
        outsideScope: z.array(NonEmptyStringSchema),
        files: z.array(RecoveryChangeFileSchema),
      })
      .strict(),
    previousAttemptIds: z.array(NonEmptyStringSchema),
    unsettledToolCallIds: z.array(NonEmptyStringSchema),
    availableActions: z.array(RecoveryActionSchema).min(1),
    recommendedAction: RecoveryActionSchema,
    requiresOperatorDecision: z.boolean(),
    notes: z.array(NonEmptyStringSchema),
    capturedAt: TimestampSchema,
    contentHash: Sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const filesByPath = new Map<string, (typeof value.changes.files)[number]>()
    for (const file of value.changes.files) {
      if (filesByPath.has(file.path)) {
        context.addIssue({
          code: "custom",
          message: "Recovery file inventory paths must be unique",
          path: ["changes", "files"],
        })
      }
      filesByPath.set(file.path, file)
    }
    const categories = [
      ["created", value.changes.created],
      ["modified", value.changes.modified],
      ["deleted", value.changes.deleted],
    ] as const
    const categorizedPaths = new Map<string, string>()
    for (const [kind, paths] of categories) {
      for (const path of paths) {
        const previousKind = categorizedPaths.get(path)
        if (previousKind) {
          context.addIssue({
            code: "custom",
            message: `Recovery path cannot appear in both ${previousKind} and ${kind}`,
            path: ["changes", kind],
          })
        }
        categorizedPaths.set(path, kind)
        if (filesByPath.get(path)?.kind !== kind) {
          context.addIssue({
            code: "custom",
            message: `Recovery ${kind} path must have a matching file inventory entry`,
            path: ["changes", kind],
          })
        }
      }
    }
    for (const file of value.changes.files) {
      if (categorizedPaths.get(file.path) !== file.kind) {
        context.addIssue({
          code: "custom",
          message: "Every recovery file must appear in its matching change category",
          path: ["changes", "files"],
        })
      }
    }
    if (value.changes.included !== value.changes.files.length) {
      context.addIssue({
        code: "custom",
        message: "Included recovery change count must match the file inventory",
        path: ["changes", "included"],
      })
    }
    if (value.changes.total < value.changes.included) {
      context.addIssue({
        code: "custom",
        message: "Total recovery changes cannot be smaller than the included inventory",
        path: ["changes", "total"],
      })
    }
    if (value.changes.truncated !== value.changes.total > value.changes.included) {
      context.addIssue({
        code: "custom",
        message: "Recovery truncation must reflect omitted changed paths",
        path: ["changes", "truncated"],
      })
    }
    if (value.changes.untrackedTotal < value.changes.untracked.length) {
      context.addIssue({
        code: "custom",
        message: "Total untracked files cannot be smaller than the included inventory",
        path: ["changes", "untrackedTotal"],
      })
    }
    if (value.changes.truncated !== Boolean(value.changes.omittedPathsHash)) {
      context.addIssue({
        code: "custom",
        message: "Truncated recovery inventories require an omitted paths hash",
        path: ["changes", "omittedPathsHash"],
      })
    }
    if ((value.state === "clean") !== (value.changes.total === 0)) {
      context.addIssue({
        code: "custom",
        message: "A clean recovery manifest must contain no workspace changes",
        path: ["state"],
      })
    }
    if (value.changes.total > 0 && !value.diff) {
      context.addIssue({
        code: "custom",
        message: "Changed recovery state requires a persisted diff binding",
        path: ["diff"],
      })
    }
    for (const path of value.changes.outsideScope) {
      if (!filesByPath.has(path)) {
        context.addIssue({
          code: "custom",
          message: "Outside-scope paths must belong to the included file inventory",
          path: ["changes", "outsideScope"],
        })
      }
    }
    if (value.externalMutation === "suspected" && value.state !== "workspace_changed") {
      context.addIssue({
        code: "custom",
        message: "Suspected external mutation requires workspace_changed state",
        path: ["externalMutation"],
      })
    }
    if (!value.availableActions.includes(value.recommendedAction)) {
      context.addIssue({
        code: "custom",
        message: "Recommended recovery action must be available",
        path: ["recommendedAction"],
      })
    }
    if (value.state === "workspace_changed" && !value.requiresOperatorDecision) {
      context.addIssue({
        code: "custom",
        message: "workspace_changed requires an explicit operator decision",
        path: ["requiresOperatorDecision"],
      })
    }
  })
export type RecoveryManifest = z.infer<typeof RecoveryManifestSchema>

/**
 * Durable event payload emitted when the observed workspace no longer matches
 * the last state that Ralph could prove. The content-addressed reference and
 * both workspace hashes let a later CLI invocation present an exact,
 * auditable decision instead of accepting an unbound boolean.
 */
export const RecoveryDecisionRequiredEventPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    recoveryRef: NonEmptyStringSchema,
    recoveryHash: Sha256Schema,
    recoveryStorageHash: Sha256Schema,
    taskBaselineHash: Sha256Schema,
    expectedWorkspaceHash: Sha256Schema,
    observedWorkspaceHash: Sha256Schema,
    supersedesDecisionEventId: NonEmptyStringSchema.optional(),
    availableActions: z.array(RecoveryActionSchema).min(1),
    recommendedAction: RecoveryActionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.availableActions.includes(value.recommendedAction)) {
      context.addIssue({
        code: "custom",
        message: "Recommended recovery action must be available",
        path: ["recommendedAction"],
      })
    }
    if (value.expectedWorkspaceHash === value.observedWorkspaceHash) {
      context.addIssue({
        code: "custom",
        message: "A recovery decision requires distinct expected and observed workspace hashes",
        path: ["observedWorkspaceHash"],
      })
    }
  })
export type RecoveryDecisionRequiredEventPayload = z.infer<
  typeof RecoveryDecisionRequiredEventPayloadSchema
>

/**
 * The only automatic continuation authorization in S07. It is deliberately
 * one-shot and binds the CLI decision, the prior blocked manifest, and the
 * freshly observed manifest that is about to enter the executor context.
 */
export const RecoveryWorkspaceAcceptanceEventPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal("continue"),
    source: z.literal("cli"),
    decisionEventId: NonEmptyStringSchema,
    decisionAttemptId: NonEmptyStringSchema,
    decisionRecoveryRef: NonEmptyStringSchema,
    decisionRecoveryHash: Sha256Schema,
    decisionRecoveryStorageHash: Sha256Schema,
    currentRecoveryRef: NonEmptyStringSchema,
    currentRecoveryHash: Sha256Schema,
    currentRecoveryStorageHash: Sha256Schema,
    taskBaselineHash: Sha256Schema,
    expectedWorkspaceHash: Sha256Schema,
    observedWorkspaceHash: Sha256Schema,
  })
  .strict()
  .refine((value) => value.expectedWorkspaceHash !== value.observedWorkspaceHash, {
    message: "Accepted workspace changes must differ from the expected workspace hash",
    path: ["observedWorkspaceHash"],
  })
export type RecoveryWorkspaceAcceptanceEventPayload = z.infer<
  typeof RecoveryWorkspaceAcceptanceEventPayloadSchema
>

export const RecoveryDecisionObsoleteEventPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionEventId: NonEmptyStringSchema,
    decisionAttemptId: NonEmptyStringSchema,
    decisionRecoveryHash: Sha256Schema,
    currentRecoveryRef: NonEmptyStringSchema,
    currentRecoveryHash: Sha256Schema,
    currentRecoveryStorageHash: Sha256Schema,
    currentState: RecoveryStateSchema,
    reason: z.literal("workspace-no-longer-requires-decision"),
  })
  .strict()
export type RecoveryDecisionObsoleteEventPayload = z.infer<
  typeof RecoveryDecisionObsoleteEventPayloadSchema
>

export const RecoveryContextPointerSchema = z
  .object({
    kind: z.literal("recovery"),
    ref: NonEmptyStringSchema,
    sourceRef: NonEmptyStringSchema,
    manifestHash: Sha256Schema,
    contentHash: Sha256Schema,
    includedHash: Sha256Schema,
    sourceStorageHash: Sha256Schema,
    truncated: z.boolean(),
    state: RecoveryStateSchema,
    changedFiles: CounterSchema,
    untrackedFiles: CounterSchema,
    previousAttempts: CounterSchema,
    unsettledToolCalls: CounterSchema,
    recommendedAction: RecoveryActionSchema,
    requiresOperatorDecision: z.boolean(),
  })
  .strict()
export type RecoveryContextPointer = z.infer<typeof RecoveryContextPointerSchema>
