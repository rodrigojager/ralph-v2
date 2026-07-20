import { z } from "zod"
import type { RunStatusSchema } from "./execution"
import { ChildUsageSummarySchema } from "./usage-summary"

export {
  aggregateChildUsageSummaries,
  type ChildUsageSummary,
  ChildUsageSummarySchema,
} from "./usage-summary"

const NonEmptyStringSchema = z.string().min(1)
const TimestampSchema = z.iso.datetime({ offset: true })
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const CounterSchema = z.number().int().nonnegative()

/**
 * Lifecycle of the durable relationship between one parent task and the
 * pre-authored child run that refines it. `interrupted`, `waiting` and
 * `blocked` remain resumable; only passed/failed/cancelled are terminal.
 */
export const ChildRunStatusSchema = z.enum([
  "reserved",
  "starting",
  "running",
  "waiting",
  "blocked",
  "interrupted",
  "passed",
  "failed",
  "cancelled",
])
export type ChildRunStatus = z.infer<typeof ChildRunStatusSchema>

export const ChildParentPolicySchema = z.enum(["pause-with-parent", "survive-parent"])
export type ChildParentPolicy = z.infer<typeof ChildParentPolicySchema>

/**
 * There is deliberately no permissive completion policy. A parent task may
 * only enter its own verification after every descendant is durably passed;
 * the parent's gates/evaluation then remain an independent authority.
 */
export const ParentChildCompletionPolicySchema = z.literal(
  "all-descendants-passed-and-parent-verified",
)
export type ParentChildCompletionPolicy = z.infer<typeof ParentChildCompletionPolicySchema>

export const ChildRunProgressSchema = z
  .object({
    completed: CounterSchema,
    total: CounterSchema,
    currentDocumentId: NonEmptyStringSchema.optional(),
    currentTaskId: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((progress, context) => {
    if (progress.completed > progress.total) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "Child completed count cannot exceed total",
      })
    }
    if ((progress.currentDocumentId === undefined) !== (progress.currentTaskId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["currentTaskId"],
        message: "Current child task must include both documentId and taskId",
      })
    }
  })
export type ChildRunProgress = z.infer<typeof ChildRunProgressSchema>

export const ChildRunObservabilitySchema = z
  .object({
    progress: ChildRunProgressSchema,
    executorUsage: ChildUsageSummarySchema,
    judgeUsage: ChildUsageSummarySchema,
    combinedUsage: ChildUsageSummarySchema,
    lastSourceEventSequence: CounterSchema,
    lastLogSequence: CounterSchema,
    watchdogStatus: z.enum(["idle", "healthy", "slow", "suspect", "recovering", "stalled"]),
    lastError: NonEmptyStringSchema.optional(),
  })
  .strict()
export type ChildRunObservability = z.infer<typeof ChildRunObservabilitySchema>

export function emptyChildRunObservability(totalTasks: number): ChildRunObservability {
  return ChildRunObservabilitySchema.parse({
    progress: { completed: 0, total: totalTasks },
    executorUsage: { available: false, source: "unavailable" },
    judgeUsage: { available: false, source: "unavailable" },
    combinedUsage: { available: false, source: "unavailable" },
    lastSourceEventSequence: 0,
    lastLogSequence: 0,
    watchdogStatus: "idle",
  })
}

export const ChildRunLinkRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    workspaceId: NonEmptyStringSchema,
    parentRunId: NonEmptyStringSchema,
    parentDocumentId: NonEmptyStringSchema,
    parentTaskId: NonEmptyStringSchema,
    childRunId: NonEmptyStringSchema,
    childDocumentId: NonEmptyStringSchema,
    childRootPrdFile: NonEmptyStringSchema,
    graphDefinitionHash: Sha256Schema,
    graphHash: Sha256Schema,
    inheritedOptionsHash: Sha256Schema,
    materializationHash: Sha256Schema,
    depth: CounterSchema,
    expectedDirectChildren: CounterSchema,
    parentPolicy: ChildParentPolicySchema,
    completionPolicy: ParentChildCompletionPolicySchema,
    status: ChildRunStatusSchema,
    revision: CounterSchema,
    leaseId: NonEmptyStringSchema.optional(),
    observability: ChildRunObservabilitySchema,
    artifactsReconciled: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    lastHeartbeatAt: TimestampSchema.optional(),
    terminalAt: TimestampSchema.optional(),
    terminalReason: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((link, context) => {
    const terminal =
      link.status === "passed" || link.status === "failed" || link.status === "cancelled"
    if (terminal !== (link.terminalAt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["terminalAt"],
        message: "Exactly terminal child links must record terminalAt",
      })
    }
    if (link.status === "passed") {
      if (!link.artifactsReconciled) {
        context.addIssue({
          code: "custom",
          path: ["artifactsReconciled"],
          message: "A passed child must have reconciled artifacts",
        })
      }
      if (
        link.observability.progress.total < 1 ||
        link.observability.progress.completed !== link.observability.progress.total
      ) {
        context.addIssue({
          code: "custom",
          path: ["observability", "progress"],
          message: "A passed child must durably complete every materialized task",
        })
      }
    }
  })
export type ChildRunLinkRecord = z.infer<typeof ChildRunLinkRecordSchema>

export const ChildRunTerminalReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    linkId: NonEmptyStringSchema,
    childRunId: NonEmptyStringSchema,
    status: z.enum(["passed", "failed", "cancelled"]),
    progress: ChildRunProgressSchema,
    artifactsReconciled: z.boolean(),
    graphHash: Sha256Schema,
    finishedAt: TimestampSchema,
    reason: NonEmptyStringSchema,
    contentHash: Sha256Schema,
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      receipt.status === "passed" &&
      (!receipt.artifactsReconciled ||
        receipt.progress.total < 1 ||
        receipt.progress.completed !== receipt.progress.total)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A passed terminal receipt requires complete progress and reconciled artifacts",
      })
    }
  })
export type ChildRunTerminalReceipt = z.infer<typeof ChildRunTerminalReceiptSchema>

export const ChildRunLimitsSchema = z
  .object({
    maxDepth: z.number().int().nonnegative(),
    maxChildren: z.number().int().positive(),
    maxConcurrentChildren: z.number().int().positive(),
  })
  .strict()
export type ChildRunLimits = z.infer<typeof ChildRunLimitsSchema>

const childRunTransitions = (...statuses: ChildRunStatus[]): readonly ChildRunStatus[] =>
  Object.freeze(statuses)

export const ChildRunStatusTransitions: Readonly<
  Record<ChildRunStatus, readonly ChildRunStatus[]>
> = Object.freeze({
  reserved: childRunTransitions(
    "starting",
    "running",
    "interrupted",
    "passed",
    "failed",
    "cancelled",
  ),
  starting: childRunTransitions("running", "interrupted", "passed", "failed", "cancelled"),
  running: childRunTransitions(
    "waiting",
    "blocked",
    "interrupted",
    "passed",
    "failed",
    "cancelled",
  ),
  waiting: childRunTransitions(
    "starting",
    "running",
    "blocked",
    "interrupted",
    "passed",
    "failed",
    "cancelled",
  ),
  blocked: childRunTransitions(
    "starting",
    "running",
    "interrupted",
    "passed",
    "failed",
    "cancelled",
  ),
  interrupted: childRunTransitions("starting", "running", "passed", "failed", "cancelled"),
  passed: childRunTransitions(),
  failed: childRunTransitions(),
  cancelled: childRunTransitions(),
})

export function canTransitionChildRunStatus(from: ChildRunStatus, to: ChildRunStatus): boolean {
  return from === to || ChildRunStatusTransitions[from].includes(to)
}

export function isTerminalChildRunStatus(status: ChildRunStatus): boolean {
  return status === "passed" || status === "failed" || status === "cancelled"
}

export function isResumableChildRunStatus(status: ChildRunStatus): boolean {
  return !isTerminalChildRunStatus(status)
}

export function childRunStatusFromRunStatus(
  status: z.infer<typeof RunStatusSchema>,
): ChildRunStatus {
  switch (status) {
    case "created":
      return "reserved"
    case "running":
      return "running"
    case "stopping":
    case "interrupted":
      return "interrupted"
    case "waiting":
      return "waiting"
    case "completed":
      return "passed"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
  }
}
