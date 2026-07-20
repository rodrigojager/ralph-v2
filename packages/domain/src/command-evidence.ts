import { createHash } from "node:crypto"
import { z } from "zod"

import { PortableRelativePathSchema } from "./contracts"
import {
  CompletionDecisionSchema,
  EvidenceBundleV2Schema,
  evidenceBundleCanonicalJson,
} from "./execution"
import { EvaluationPolicySchema, JudgeAssessmentSchema } from "./judge"

const NonEmptyStringSchema = z.string().min(1)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const TimestampSchema = z.iso.datetime({ offset: true })

export const CommandEvidenceSelectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    attemptId: NonEmptyStringSchema,
    evidenceBundleId: NonEmptyStringSchema,
    evidenceContentHash: Sha256Schema,
    source: z.enum(["execution-evidence", "verification-evidence"]),
    verificationOperationId: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.source === "verification-evidence") !== Boolean(value.verificationOperationId)) {
      context.addIssue({
        code: "custom",
        message: "Verification evidence must name exactly one verification operation",
        path: ["verificationOperationId"],
      })
    }
  })
export type CommandEvidenceSelection = z.infer<typeof CommandEvidenceSelectionSchema>

const CommandSafetyBoundarySchema = z
  .object({
    executorInvocation: z.literal("forbidden"),
    toolCalling: z.literal("forbidden"),
    taskStateMutation: z.literal("forbidden"),
    prdMarkerMutation: z.literal("forbidden"),
  })
  .strict()

export const VerifyCommandRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: z.literal("verify"),
    selection: CommandEvidenceSelectionSchema.refine(
      (selection) => selection.source === "execution-evidence",
      "verify must derive from persisted execution evidence",
    ),
    gatePolicy: z
      .object({
        skipTests: z.boolean(),
        skipLint: z.boolean(),
        skipGates: z.array(NonEmptyStringSchema),
        noGates: z.boolean(),
        fast: z.boolean(),
        force: z.boolean(),
        failFast: z.boolean(),
      })
      .strict(),
    safety: CommandSafetyBoundarySchema,
  })
  .strict()
export type VerifyCommandRequest = z.infer<typeof VerifyCommandRequestSchema>

export const JudgeCommandRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: z.literal("judge"),
    selection: CommandEvidenceSelectionSchema,
    kind: z.enum(["external", "self"]),
    profileId: NonEmptyStringSchema,
    policy: EvaluationPolicySchema.refine(
      (policy) => policy.mode === "external" || policy.mode === "self",
      "judge command requires self or external evaluation",
    ),
    safety: CommandSafetyBoundarySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.policy.mode !== value.kind) {
      context.addIssue({
        code: "custom",
        message: "Judge command policy mode must match the requested judge kind",
        path: ["policy", "mode"],
      })
    }
  })
export type JudgeCommandRequest = z.infer<typeof JudgeCommandRequestSchema>

export const CommandOperationRequestSchema = z.discriminatedUnion("command", [
  VerifyCommandRequestSchema,
  JudgeCommandRequestSchema,
])
export type CommandOperationRequest = z.infer<typeof CommandOperationRequestSchema>

const EvidenceObjectReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    contentRef: PortableRelativePathSchema,
    storageHash: Sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict()

export const VerificationCommandReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    operationId: NonEmptyStringSchema,
    command: z.literal("verify"),
    selection: CommandEvidenceSelectionSchema,
    status: z.enum(["passed", "failed", "blocked", "overridden"]),
    evidence: EvidenceBundleV2Schema,
    evidenceObject: EvidenceObjectReceiptSchema,
    decision: CompletionDecisionSchema,
    workspaceStable: z.boolean(),
    controlStateStable: z.boolean(),
    gateCount: z.number().int().nonnegative(),
    executorInvoked: z.literal(false),
    markerUpdated: z.literal(false),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
    contentHash: Sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const selection = value.selection
    const evidence = value.evidence
    if (
      evidence.runId !== selection.runId ||
      evidence.documentId !== selection.documentId ||
      evidence.taskId !== selection.taskId ||
      evidence.attemptId !== selection.attemptId
    ) {
      context.addIssue({
        code: "custom",
        message: "Verification evidence does not match the resolved command selection",
        path: ["evidence"],
      })
    }
    if (selection.source !== "execution-evidence") {
      context.addIssue({
        code: "custom",
        message: "Verification reports must derive from execution evidence",
        path: ["selection", "source"],
      })
    }
    if (value.decision.evidenceBundleId !== evidence.id) {
      context.addIssue({
        code: "custom",
        message: "Verification decision must reference the newly collected evidence bundle",
        path: ["decision", "evidenceBundleId"],
      })
    }
    if (value.gateCount !== evidence.gates.length) {
      context.addIssue({
        code: "custom",
        message: "Verification report gateCount must equal the evidence gate count",
        path: ["gateCount"],
      })
    }
    const evidenceBytes = new TextEncoder().encode(`${evidenceBundleCanonicalJson(evidence)}\n`)
    const evidenceStorageHash = createHash("sha256").update(evidenceBytes).digest("hex")
    if (
      value.evidenceObject.storageHash !== evidenceStorageHash ||
      value.evidenceObject.sizeBytes !== evidenceBytes.byteLength
    ) {
      context.addIssue({
        code: "custom",
        message: "Verification evidence object receipt does not match its canonical bytes",
        path: ["evidenceObject"],
      })
    }
    if (value.status !== value.decision.status) {
      context.addIssue({
        code: "custom",
        message: "Verification report status must equal its decision status",
        path: ["status"],
      })
    }
    if (
      (!value.workspaceStable || !value.controlStateStable) &&
      (value.status === "passed" || value.status === "overridden")
    ) {
      context.addIssue({
        code: "custom",
        message: "Unstable verification state cannot produce an approving report",
        path: ["status"],
      })
    }
    const { contentHash, ...body } = value
    if (contentHash !== commandOperationReportHash(body)) {
      context.addIssue({
        code: "custom",
        message: "Verification command report content hash is invalid",
        path: ["contentHash"],
      })
    }
  })
export type VerificationCommandReport = z.infer<typeof VerificationCommandReportSchema>

export const JudgmentCommandReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    operationId: NonEmptyStringSchema,
    command: z.literal("judge"),
    selection: CommandEvidenceSelectionSchema,
    status: z.enum(["passed", "failed", "revision_required", "blocked", "overridden"]),
    kind: z.enum(["external", "self"]),
    profileId: NonEmptyStringSchema,
    policy: EvaluationPolicySchema,
    assessment: JudgeAssessmentSchema,
    assessmentRef: PortableRelativePathSchema,
    assessmentStorageHash: Sha256Schema,
    assessmentSizeBytes: z.number().int().nonnegative(),
    decision: CompletionDecisionSchema,
    workspaceStable: z.boolean(),
    controlStateStable: z.boolean(),
    toolsAvailable: z.literal(false),
    codeMutationApplied: z.literal(false),
    markerUpdated: z.literal(false),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema,
    contentHash: Sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.assessment.kind !== value.kind ||
      value.assessment.evidenceBundleId !== value.selection.evidenceBundleId ||
      value.assessment.profileSnapshot.id !== value.profileId
    ) {
      context.addIssue({
        code: "custom",
        message: "Judge assessment does not match the selected evidence and configured kind",
        path: ["assessment"],
      })
    }
    if (value.policy.mode !== value.kind || value.status !== value.decision.status) {
      context.addIssue({
        code: "custom",
        message: "Judge report policy, kind and decision status must agree",
        path: ["status"],
      })
    }
    if (
      (!value.workspaceStable || !value.controlStateStable) &&
      (value.status === "passed" || value.status === "overridden")
    ) {
      context.addIssue({
        code: "custom",
        message: "A judge read-only violation cannot produce an approving report",
        path: ["status"],
      })
    }
    const assessmentBytes = new TextEncoder().encode(
      `${JSON.stringify(value.assessment, null, 2)}\n`,
    )
    const assessmentStorageHash = createHash("sha256").update(assessmentBytes).digest("hex")
    if (
      value.assessmentStorageHash !== assessmentStorageHash ||
      value.assessmentSizeBytes !== assessmentBytes.byteLength
    ) {
      context.addIssue({
        code: "custom",
        message: "Judge assessment receipt does not match its persisted bytes",
        path: ["assessmentStorageHash"],
      })
    }
    if (
      value.decision.evidenceBundleId !== value.selection.evidenceBundleId ||
      value.decision.assessmentId !== value.assessment.id ||
      value.decision.evaluationMode !== value.kind ||
      value.decision.score !== value.assessment.score ||
      value.decision.threshold !== value.policy.threshold
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Judge decision must bind the selected evidence, assessment, mode, score and threshold",
        path: ["decision"],
      })
    }
    const { contentHash, ...body } = value
    if (contentHash !== commandOperationReportHash(body)) {
      context.addIssue({
        code: "custom",
        message: "Judge command report content hash is invalid",
        path: ["contentHash"],
      })
    }
  })
export type JudgmentCommandReport = z.infer<typeof JudgmentCommandReportSchema>

export const CommandOperationReportSchema = z.discriminatedUnion("command", [
  VerificationCommandReportSchema,
  JudgmentCommandReportSchema,
])
export type CommandOperationReport = z.infer<typeof CommandOperationReportSchema>
export type CommandOperationReportBody =
  | Omit<VerificationCommandReport, "contentHash">
  | Omit<JudgmentCommandReport, "contentHash">

export const CommandOperationSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    command: z.enum(["verify", "judge"]),
    status: z.enum(["started", "succeeded", "failed", "cancelled"]),
    request: CommandOperationRequestSchema,
    requestHash: Sha256Schema,
    report: CommandOperationReportSchema.optional(),
    error: z
      .object({ code: NonEmptyStringSchema, message: NonEmptyStringSchema })
      .strict()
      .optional(),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.requestHash !== commandOperationRequestHash(value.request)) {
      context.addIssue({
        code: "custom",
        message: "Operation request hash is invalid",
        path: ["requestHash"],
      })
    }
    if (value.command !== value.request.command) {
      context.addIssue({ code: "custom", message: "Operation command/request mismatch" })
    }
    if (
      value.report &&
      (value.report.command !== value.command || value.report.operationId !== value.id)
    ) {
      context.addIssue({
        code: "custom",
        message: "Operation report identity mismatch",
        path: ["report"],
      })
    }
    if (
      value.report &&
      (value.report.startedAt !== value.startedAt || value.report.finishedAt !== value.finishedAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Operation and report lifecycle timestamps must match",
        path: ["report", "finishedAt"],
      })
    }
    if (
      value.report &&
      JSON.stringify(canonical(value.report.selection)) !==
        JSON.stringify(canonical(value.request.selection))
    ) {
      context.addIssue({
        code: "custom",
        message: "Operation report selection does not match its immutable request",
        path: ["report", "selection"],
      })
    }
    if (
      value.request.command === "judge" &&
      value.report?.command === "judge" &&
      (value.report.kind !== value.request.kind ||
        value.report.profileId !== value.request.profileId ||
        JSON.stringify(canonical(value.report.policy)) !==
          JSON.stringify(canonical(value.request.policy)))
    ) {
      context.addIssue({
        code: "custom",
        message: "Judge report does not match the immutable requested evaluator policy",
        path: ["report"],
      })
    }
    if (value.status === "succeeded" && !value.report) {
      context.addIssue({
        code: "custom",
        message: "Succeeded operation requires a report",
        path: ["report"],
      })
    }
    if ((value.status === "failed" || value.status === "cancelled") && !value.error) {
      context.addIssue({
        code: "custom",
        message: "Failed/cancelled operation requires an error",
        path: ["error"],
      })
    }
    if ((value.status === "started") !== (value.finishedAt === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Only a started operation may omit finishedAt",
        path: ["finishedAt"],
      })
    }
    if (value.status === "started" && (value.report || value.error)) {
      context.addIssue({
        code: "custom",
        message: "Started operation cannot be terminal",
        path: ["status"],
      })
    }
    if (value.status === "succeeded" && value.error) {
      context.addIssue({
        code: "custom",
        message: "Succeeded operation cannot carry an error",
        path: ["error"],
      })
    }
    if ((value.status === "failed" || value.status === "cancelled") && value.report) {
      context.addIssue({
        code: "custom",
        message: "Failed/cancelled operation cannot carry a report",
        path: ["report"],
      })
    }
  })
export type CommandOperation = z.infer<typeof CommandOperationSchema>

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, canonical(child)]),
  )
}

function hash(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")
}

export function commandOperationRequestHash(value: CommandOperationRequest): string {
  return hash("ralph.command-operation.request.v1", CommandOperationRequestSchema.parse(value))
}

export function commandOperationReportHash(value: CommandOperationReportBody): string {
  return hash(`ralph.${value.command}.command-report.v1`, value)
}
