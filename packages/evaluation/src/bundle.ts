import { createHash } from "node:crypto"

import {
  type ContextTask,
  ContextTaskSchema,
  EvidenceAssessmentRefSchema,
  type EvidenceBundle,
  EvidenceContextBindingSchema,
  EvidenceLimitsSchema,
  EvidencePriorAttemptSchema,
  EvidenceProfileSnapshotSchema,
  EvidenceToolCallSchema,
  EvidenceTruncationSchema,
  EvidenceUsageSchema,
  type JudgeAssessment,
  type JudgeRubric,
  JudgeRubricSchema,
  MissingEvidenceSchema,
} from "@ralph/domain"
import { z } from "zod"

const NonEmptyStringSchema = z.string().trim().min(1)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const TimestampSchema = z.iso.datetime({ offset: true })

export const JudgeBundleTruncationSchema = z
  .object({
    field: NonEmptyStringSchema,
    reason: z.enum(["field-limit", "item-limit", "total-limit"]),
    originalBytes: z.number().int().nonnegative().optional(),
    includedBytes: z.number().int().nonnegative().optional(),
    originalCount: z.number().int().nonnegative().optional(),
    includedCount: z.number().int().nonnegative().optional(),
  })
  .strict()
export type JudgeBundleTruncation = z.infer<typeof JudgeBundleTruncationSchema>

const JudgeTextAttachmentInputBaseSchema = z
  .object({
    id: NonEmptyStringSchema,
    sourceRef: NonEmptyStringSchema,
    contentHash: Sha256Schema,
    text: z.string(),
  })
  .strict()

const JudgeDiffTextAttachmentInputSchema = JudgeTextAttachmentInputBaseSchema.extend({
  kind: z.literal("diff"),
  scope: z.enum(["cumulative", "attempt"]),
}).strict()

const JudgeBeforeFileTextAttachmentInputSchema = JudgeTextAttachmentInputBaseSchema.extend({
  kind: z.literal("before-file"),
  path: NonEmptyStringSchema,
}).strict()

const JudgeAfterFileTextAttachmentInputSchema = JudgeTextAttachmentInputBaseSchema.extend({
  kind: z.literal("after-file"),
  path: NonEmptyStringSchema,
}).strict()

const JudgeArtifactTextAttachmentInputSchema = JudgeTextAttachmentInputBaseSchema.extend({
  kind: z.literal("artifact"),
  artifactId: NonEmptyStringSchema,
  path: NonEmptyStringSchema,
}).strict()

const JudgeGateOutputTextAttachmentInputSchema = JudgeTextAttachmentInputBaseSchema.extend({
  kind: z.literal("gate-output"),
  gateId: NonEmptyStringSchema,
}).strict()

/**
 * Text read from an immutable, already verified reference by the Ralph runner.
 * The builder re-hashes the full text and validates its locator against the
 * evidence bundle before any bounded excerpt can reach a judge backend.
 */
export const JudgeTextAttachmentInputSchema = z.discriminatedUnion("kind", [
  JudgeDiffTextAttachmentInputSchema,
  JudgeBeforeFileTextAttachmentInputSchema,
  JudgeAfterFileTextAttachmentInputSchema,
  JudgeArtifactTextAttachmentInputSchema,
  JudgeGateOutputTextAttachmentInputSchema,
])
export type JudgeTextAttachmentInput = z.infer<typeof JudgeTextAttachmentInputSchema>

export const JudgeAttachmentDiagnosticSchema = z
  .object({
    code: z.enum([
      "attachment-count-limit",
      "attachment-diff-manifest-invalid",
      "attachment-non-text",
      "attachment-not-found",
      "attachment-ref-invalid",
      "attachment-source-integrity",
      "attachment-source-too-large",
      "attachment-source-unavailable",
      "attachment-total-limit",
    ]),
    attachmentId: NonEmptyStringSchema,
    kind: z.enum(["diff", "before-file", "after-file", "artifact", "gate-output"]),
    message: NonEmptyStringSchema,
    sourceRef: NonEmptyStringSchema.optional(),
    path: NonEmptyStringSchema.optional(),
  })
  .strict()
export type JudgeAttachmentDiagnostic = z.infer<typeof JudgeAttachmentDiagnosticSchema>

const JudgeTextAttachmentProjectionFields = {
  evidenceBundleId: NonEmptyStringSchema,
  evidenceContentHash: Sha256Schema,
  attemptId: NonEmptyStringSchema,
  identityHash: Sha256Schema,
  originalBytes: z.number().int().nonnegative(),
  includedBytes: z.number().int().nonnegative(),
  includedContentHash: Sha256Schema,
  truncated: z.boolean(),
  text: z.string(),
} as const

const JudgeDiffTextAttachmentSchema = JudgeDiffTextAttachmentInputSchema.omit({ text: true })
  .extend(JudgeTextAttachmentProjectionFields)
  .strict()
const JudgeBeforeFileTextAttachmentSchema = JudgeBeforeFileTextAttachmentInputSchema.omit({
  text: true,
})
  .extend(JudgeTextAttachmentProjectionFields)
  .strict()
const JudgeAfterFileTextAttachmentSchema = JudgeAfterFileTextAttachmentInputSchema.omit({
  text: true,
})
  .extend(JudgeTextAttachmentProjectionFields)
  .strict()
const JudgeArtifactTextAttachmentSchema = JudgeArtifactTextAttachmentInputSchema.omit({
  text: true,
})
  .extend(JudgeTextAttachmentProjectionFields)
  .strict()
const JudgeGateOutputTextAttachmentSchema = JudgeGateOutputTextAttachmentInputSchema.omit({
  text: true,
})
  .extend(JudgeTextAttachmentProjectionFields)
  .strict()

const JudgeTextAttachmentCoreSchema = z.discriminatedUnion("kind", [
  JudgeDiffTextAttachmentSchema,
  JudgeBeforeFileTextAttachmentSchema,
  JudgeAfterFileTextAttachmentSchema,
  JudgeArtifactTextAttachmentSchema,
  JudgeGateOutputTextAttachmentSchema,
])
export type JudgeTextAttachment = z.infer<typeof JudgeTextAttachmentCoreSchema>
type JudgeTextAttachmentIdentityInput = JudgeTextAttachment extends infer Attachment
  ? Attachment extends JudgeTextAttachment
    ? Omit<Attachment, "identityHash" | "text">
    : never
  : never

/** Stable identity for one full-content hash and the exact bounded excerpt supplied to the judge. */
export function judgeTextAttachmentIdentityHash(value: JudgeTextAttachmentIdentityInput): string {
  const locator = (() => {
    switch (value.kind) {
      case "diff":
        return { scope: value.scope }
      case "before-file":
      case "after-file":
        return { path: value.path }
      case "artifact":
        return { artifactId: value.artifactId, path: value.path }
      case "gate-output":
        return { gateId: value.gateId }
    }
  })()
  return sha256(
    stableJson({
      schemaVersion: 1,
      id: value.id,
      kind: value.kind,
      sourceRef: value.sourceRef,
      contentHash: value.contentHash,
      evidenceBundleId: value.evidenceBundleId,
      evidenceContentHash: value.evidenceContentHash,
      attemptId: value.attemptId,
      originalBytes: value.originalBytes,
      includedBytes: value.includedBytes,
      includedContentHash: value.includedContentHash,
      truncated: value.truncated,
      locator,
    }),
  )
}

export const JudgeTextAttachmentSchema = JudgeTextAttachmentCoreSchema.superRefine(
  (value, context) => {
    const includedBytes = bytes(value.text)
    if (value.includedBytes !== includedBytes) {
      context.addIssue({
        code: "custom",
        message: "Judge attachment included byte count does not match its text",
        path: ["includedBytes"],
      })
    }
    if (value.includedContentHash !== sha256(value.text)) {
      context.addIssue({
        code: "custom",
        message: "Judge attachment excerpt hash does not match its text",
        path: ["includedContentHash"],
      })
    }
    if (value.includedBytes > value.originalBytes) {
      context.addIssue({
        code: "custom",
        message: "Judge attachment excerpt cannot exceed the original content size",
        path: ["includedBytes"],
      })
    }
    if (value.truncated !== value.includedBytes < value.originalBytes) {
      context.addIssue({
        code: "custom",
        message: "Judge attachment truncation flag does not match its byte counts",
        path: ["truncated"],
      })
    }
    if (value.identityHash !== judgeTextAttachmentIdentityHash(value)) {
      context.addIssue({
        code: "custom",
        message: "Judge attachment identity hash is invalid",
        path: ["identityHash"],
      })
    }
  },
)

const JudgeChangedFileProjectionSchema = z
  .object({
    path: NonEmptyStringSchema,
    kind: z.enum(["created", "modified", "deleted", "renamed"]),
    previousPath: NonEmptyStringSchema.optional(),
    contentHash: Sha256Schema.optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict()

const JudgeChangeProjectionSchema = z
  .object({
    policy: z.enum([
      "require-change",
      "allow-no-change",
      "fail-on-no-change",
      "retry-on-no-change",
    ]),
    status: z.enum(["changed", "unchanged", "out_of_scope"]),
    files: z.array(JudgeChangedFileProjectionSchema),
    outsideScopePaths: z.array(NonEmptyStringSchema),
    reproducible: z.boolean(),
    missingContent: z.array(
      z
        .object({
          path: NonEmptyStringSchema,
          side: z.enum(["before", "after"]),
          reason: NonEmptyStringSchema,
        })
        .strict(),
    ),
    diffHash: Sha256Schema.optional(),
    diffRef: NonEmptyStringSchema.optional(),
    attemptDiffHash: Sha256Schema.optional(),
    attemptDiffRef: NonEmptyStringSchema.optional(),
  })
  .strict()

const JudgeArtifactProjectionSchema = z
  .object({
    artifactId: NonEmptyStringSchema,
    path: NonEmptyStringSchema,
    contentHash: Sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
    immutableRef: NonEmptyStringSchema.optional(),
    status: z.enum(["passed", "failed", "not_checked"]),
    reason: NonEmptyStringSchema.optional(),
  })
  .strict()

const JudgeGateProjectionSchema = z
  .object({
    gateId: NonEmptyStringSchema,
    category: NonEmptyStringSchema,
    blocking: z.boolean(),
    status: z.enum([
      "passed",
      "failed",
      "timeout",
      "error",
      "skipped_by_cli",
      "skipped_by_policy",
      "not_applicable",
      "unavailable",
    ]),
    command: z
      .object({
        executable: NonEmptyStringSchema,
        args: z.array(z.string()),
      })
      .strict()
      .optional(),
    exitCode: z.number().int().optional(),
    durationMs: z.number().int().nonnegative(),
    outputRefs: z.array(NonEmptyStringSchema),
    outputTruncated: z.boolean().optional(),
    rawOutputTruncated: z.boolean().optional(),
    reason: NonEmptyStringSchema.optional(),
  })
  .strict()

const JudgeExecutorOutcomeProjectionSchema = z
  .object({
    status: z.enum(["work_submitted", "blocked_reported"]),
    summary: NonEmptyStringSchema,
    intendedFiles: z.array(NonEmptyStringSchema),
    artifactRefs: z.array(NonEmptyStringSchema),
    suggestedVerifications: z.array(NonEmptyStringSchema),
    risks: z.array(NonEmptyStringSchema),
  })
  .strict()

const JudgeV2EvidenceSupplementSchema = z
  .object({
    limits: EvidenceLimitsSchema,
    tests: z.array(
      z
        .object({
          gateId: NonEmptyStringSchema,
          status: z.enum([
            "passed",
            "failed",
            "timeout",
            "error",
            "skipped_by_cli",
            "skipped_by_policy",
            "not_applicable",
            "unavailable",
          ]),
          blocking: z.boolean(),
        })
        .strict(),
    ),
    toolCalls: z.array(EvidenceToolCallSchema),
    context: EvidenceContextBindingSchema,
    profile: EvidenceProfileSnapshotSchema,
    usage: EvidenceUsageSchema,
    priorAttempts: z.array(EvidencePriorAttemptSchema),
    priorAssessments: z.array(EvidenceAssessmentRefSchema),
    security: z
      .object({
        mode: z.enum(["safe", "auto", "dangerous"]),
        headlessAsk: z.enum(["deny", "allow"]),
        allowShell: z.boolean(),
        interactive: z.boolean(),
        allowedCommandCount: z.number().int().nonnegative(),
        readPaths: z.array(NonEmptyStringSchema),
        writePaths: z.array(NonEmptyStringSchema),
        toolRuleCount: z.number().int().nonnegative(),
        diagnostics: z.array(NonEmptyStringSchema),
      })
      .strict(),
    provenance: z
      .object({
        task: z.enum(["reported", "derived", "estimated", "unavailable"]),
        changes: z.enum(["reported", "derived", "estimated", "unavailable"]),
        artifacts: z.enum(["reported", "derived", "estimated", "unavailable"]),
        gates: z.enum(["reported", "derived", "estimated", "unavailable"]),
        tools: z.enum(["reported", "derived", "estimated", "unavailable"]),
        context: z.enum(["reported", "derived", "estimated", "unavailable"]),
        profile: z.enum(["reported", "derived", "estimated", "unavailable"]),
        usage: z.enum(["reported", "derived", "estimated", "unavailable"]),
        security: z.enum(["reported", "derived", "estimated", "unavailable"]),
        assessments: z.enum(["reported", "derived", "estimated", "unavailable"]),
      })
      .strict(),
    truncations: z.array(EvidenceTruncationSchema),
    missingEvidence: z.array(MissingEvidenceSchema),
  })
  .strict()

const JudgeEvidenceProjectionSchema = z
  .object({
    id: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    attemptId: NonEmptyStringSchema,
    taskSpecHash: Sha256Schema,
    changes: JudgeChangeProjectionSchema,
    artifacts: z.array(JudgeArtifactProjectionSchema),
    gates: z.array(JudgeGateProjectionSchema),
    executorOutcome: JudgeExecutorOutcomeProjectionSchema.optional(),
    v2: JudgeV2EvidenceSupplementSchema.optional(),
    contextManifestHash: Sha256Schema,
    createdAt: TimestampSchema,
    contentHash: Sha256Schema,
  })
  .strict()

const JudgePreviousAssessmentProjectionSchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: z.enum(["external", "self"]),
    score: z.number().int().min(0).max(100),
    summary: NonEmptyStringSchema,
    problems: z.array(
      z
        .object({
          severity: z.enum(["info", "minor", "major", "critical"]),
          criterion: NonEmptyStringSchema.optional(),
          message: NonEmptyStringSchema,
          evidenceRefs: z.array(NonEmptyStringSchema),
        })
        .strict(),
    ),
    missingEvidence: z.array(NonEmptyStringSchema),
    recommendations: z.array(NonEmptyStringSchema),
  })
  .strict()

export const JudgeEvaluationBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    task: ContextTaskSchema,
    evidence: JudgeEvidenceProjectionSchema,
    rubric: JudgeRubricSchema,
    previousAssessment: JudgePreviousAssessmentProjectionSchema.optional(),
    attachments: z.array(JudgeTextAttachmentSchema).default([]),
    attachmentDiagnostics: z.array(JudgeAttachmentDiagnosticSchema).default([]),
    truncations: z.array(JudgeBundleTruncationSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.task.documentId !== value.evidence.documentId ||
      value.task.taskId !== value.evidence.taskId ||
      value.task.taskSpecHash !== value.evidence.taskSpecHash
    ) {
      context.addIssue({
        code: "custom",
        message: "Judge task and evidence identities must match",
        path: ["evidence"],
      })
    }
    if (
      new Set(value.attachments.map((attachment) => attachment.id)).size !==
      value.attachments.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Judge attachment ids must be unique",
        path: ["attachments"],
      })
    }
    for (const [index, attachment] of value.attachments.entries()) {
      if (
        attachment.evidenceBundleId !== value.evidence.id ||
        attachment.evidenceContentHash !== value.evidence.contentHash ||
        attachment.attemptId !== value.evidence.attemptId
      ) {
        context.addIssue({
          code: "custom",
          message: "Judge attachment identity does not match its evidence bundle",
          path: ["attachments", index],
        })
      }
    }
  })
export type JudgeEvaluationBundle = z.infer<typeof JudgeEvaluationBundleSchema>

export type JudgeBundleLimits = {
  maxStringBytes: number
  maxItemsPerList: number
  /** Maximum UTF-8 text bytes retained from any one attachment. */
  maxAttachmentBytes: number
  /** Maximum combined UTF-8 text bytes retained across attachments. */
  maxAttachmentTotalBytes: number
  maxTotalBytes: number
}

export const DEFAULT_JUDGE_BUNDLE_LIMITS: Readonly<JudgeBundleLimits> = Object.freeze({
  maxStringBytes: 32 * 1024,
  maxItemsPerList: 100,
  maxAttachmentBytes: 64 * 1024,
  maxAttachmentTotalBytes: 160 * 1024,
  maxTotalBytes: 256 * 1024,
})

export type BuildJudgeEvaluationBundleInput = {
  task: ContextTask
  evidence: EvidenceBundle
  rubric: JudgeRubric
  previousAssessment?: JudgeAssessment
  attachments?: readonly JudgeTextAttachmentInput[]
  attachmentDiagnostics?: readonly JudgeAttachmentDiagnostic[]
  limits?: Partial<JudgeBundleLimits>
}

export type JudgeEvaluationBundleBuild = {
  bundle: JudgeEvaluationBundle
  canonicalJson: string
  byteLength: number
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function utf8Prefix(value: string, maxBytes: number): { text: string; byteLength: number } {
  let output = ""
  let byteLength = 0
  for (const character of value) {
    const characterBytes = bytes(character)
    if (byteLength + characterBytes > maxBytes) break
    output += character
    byteLength += characterBytes
  }
  return { text: output, byteLength }
}

function truncateText(
  value: string,
  field: string,
  limits: JudgeBundleLimits,
  truncations: JudgeBundleTruncation[],
): string {
  const originalBytes = bytes(value)
  if (originalBytes <= limits.maxStringBytes) return value
  let output = ""
  for (const character of value) {
    if (bytes(output + character) > limits.maxStringBytes) break
    output += character
  }
  truncations.push({
    field,
    reason: "field-limit",
    originalBytes,
    includedBytes: bytes(output),
  })
  return output.trim() || "[truncated]"
}

function cap<T>(
  values: readonly T[],
  field: string,
  limits: JudgeBundleLimits,
  truncations: JudgeBundleTruncation[],
): readonly T[] {
  if (values.length <= limits.maxItemsPerList) return values
  truncations.push({
    field,
    reason: "item-limit",
    originalCount: values.length,
    includedCount: limits.maxItemsPerList,
  })
  return values.slice(0, limits.maxItemsPerList)
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error("Judge bundle contains a non-JSON value")
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`
}

function effectiveLimits(input?: Partial<JudgeBundleLimits>): JudgeBundleLimits {
  const output = { ...DEFAULT_JUDGE_BUNDLE_LIMITS, ...input }
  for (const [name, value] of Object.entries(output)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Judge bundle limit ${name} must be a positive safe integer`)
    }
  }
  if (output.maxAttachmentTotalBytes > output.maxTotalBytes) {
    throw new Error("Judge bundle maxAttachmentTotalBytes cannot exceed maxTotalBytes")
  }
  return output
}

function assertJudgeAttachmentBinding(
  attachment: JudgeTextAttachmentInput,
  evidence: EvidenceBundle,
): void {
  if (sha256(attachment.text) !== attachment.contentHash) {
    throw new Error(`Judge attachment ${attachment.id} content hash mismatch`)
  }

  switch (attachment.kind) {
    case "diff": {
      const expectedRef =
        attachment.scope === "cumulative"
          ? evidence.changes.diffRef
          : evidence.changes.attemptDiffRef
      const expectedHash =
        attachment.scope === "cumulative"
          ? evidence.changes.diffHash
          : evidence.changes.attemptDiffHash
      if (!expectedRef || !expectedHash) {
        throw new Error(
          `Judge attachment ${attachment.id} has no ${attachment.scope} diff evidence`,
        )
      }
      if (attachment.sourceRef !== expectedRef) {
        throw new Error(`Judge attachment ${attachment.id} source ref mismatch`)
      }
      if (attachment.contentHash !== expectedHash) {
        throw new Error(`Judge attachment ${attachment.id} evidence hash mismatch`)
      }
      return
    }
    case "artifact": {
      const artifact = evidence.artifacts.find(
        (candidate) =>
          candidate.artifactId === attachment.artifactId && candidate.path === attachment.path,
      )
      if (!artifact) {
        throw new Error(`Judge attachment ${attachment.id} does not bind to an artifact`)
      }
      if (!artifact.immutableRef || attachment.sourceRef !== artifact.immutableRef) {
        throw new Error(`Judge attachment ${attachment.id} source ref mismatch`)
      }
      if (attachment.contentHash !== artifact.contentHash) {
        throw new Error(`Judge attachment ${attachment.id} evidence hash mismatch`)
      }
      return
    }
    case "gate-output": {
      const gate = evidence.gates.find((candidate) => candidate.gateId === attachment.gateId)
      if (!gate) {
        throw new Error(`Judge attachment ${attachment.id} does not bind to a gate`)
      }
      if (!gate.outputRefs.includes(attachment.sourceRef)) {
        throw new Error(`Judge attachment ${attachment.id} source ref mismatch`)
      }
      return
    }
    case "before-file": {
      const file = evidence.changes.files.find(
        (candidate) =>
          candidate.kind !== "created" &&
          (candidate.previousPath ?? candidate.path) === attachment.path,
      )
      if (!file) {
        throw new Error(`Judge attachment ${attachment.id} has an invalid before-file side`)
      }
      if (
        evidence.changes.missingContent.some(
          (missing) => missing.side === "before" && missing.path === attachment.path,
        )
      ) {
        throw new Error(`Judge attachment ${attachment.id} before-file content is unavailable`)
      }
      return
    }
    case "after-file": {
      const file = evidence.changes.files.find(
        (candidate) => candidate.kind !== "deleted" && candidate.path === attachment.path,
      )
      if (!file) {
        throw new Error(`Judge attachment ${attachment.id} has an invalid after-file side`)
      }
      if (
        evidence.changes.missingContent.some(
          (missing) => missing.side === "after" && missing.path === attachment.path,
        )
      ) {
        throw new Error(`Judge attachment ${attachment.id} after-file content is unavailable`)
      }
      if (file.contentHash && attachment.contentHash !== file.contentHash) {
        throw new Error(`Judge attachment ${attachment.id} evidence hash mismatch`)
      }
      return
    }
  }
}

function buildJudgeAttachments(
  attachments: readonly JudgeTextAttachmentInput[],
  evidence: EvidenceBundle,
  limits: JudgeBundleLimits,
  truncations: JudgeBundleTruncation[],
): JudgeTextAttachment[] {
  const parsed = attachments.map((attachment) => JudgeTextAttachmentInputSchema.parse(attachment))
  const duplicateIds = [
    ...new Set(
      parsed
        .map((attachment) => attachment.id)
        .filter((id, index, ids) => ids.indexOf(id) !== index),
    ),
  ].sort((left, right) => left.localeCompare(right, "en"))
  if (duplicateIds.length > 0) {
    throw new Error(`Judge attachment ids must be unique: ${duplicateIds.join(", ")}`)
  }
  for (const attachment of parsed) assertJudgeAttachmentBinding(attachment, evidence)

  const sorted = [...parsed].sort((left, right) => left.id.localeCompare(right.id, "en"))
  const selected = cap(sorted, "attachments", limits, truncations)
  let includedTotalBytes = 0

  return selected.map((attachment) => {
    const originalBytes = bytes(attachment.text)
    const itemExcerpt = utf8Prefix(attachment.text, limits.maxAttachmentBytes)
    if (itemExcerpt.byteLength < originalBytes) {
      truncations.push({
        field: `attachments.${attachment.id}.text`,
        reason: "field-limit",
        originalBytes,
        includedBytes: itemExcerpt.byteLength,
      })
    }

    const remainingBytes = Math.max(0, limits.maxAttachmentTotalBytes - includedTotalBytes)
    const totalExcerpt = utf8Prefix(itemExcerpt.text, remainingBytes)
    if (totalExcerpt.byteLength < itemExcerpt.byteLength) {
      truncations.push({
        field: `attachments.${attachment.id}.text`,
        reason: "total-limit",
        originalBytes,
        includedBytes: totalExcerpt.byteLength,
      })
    }
    includedTotalBytes += totalExcerpt.byteLength

    const { text: _fullText, ...identity } = attachment
    const projected = {
      ...identity,
      evidenceBundleId: evidence.id,
      evidenceContentHash: evidence.contentHash,
      attemptId: evidence.attemptId,
      originalBytes,
      includedBytes: totalExcerpt.byteLength,
      includedContentHash: sha256(totalExcerpt.text),
      truncated: totalExcerpt.byteLength < originalBytes,
    } as JudgeTextAttachmentIdentityInput
    return JudgeTextAttachmentSchema.parse({
      ...projected,
      identityHash: judgeTextAttachmentIdentityHash(projected),
      text: totalExcerpt.text,
    })
  })
}

export function buildJudgeEvaluationBundle(
  input: BuildJudgeEvaluationBundleInput,
): JudgeEvaluationBundleBuild {
  const limits = effectiveLimits(input.limits)
  const truncations: JudgeBundleTruncation[] = []
  const text = (value: string, field: string): string =>
    truncateText(value, field, limits, truncations)
  const list = <T>(values: readonly T[], field: string): readonly T[] =>
    cap(values, field, limits, truncations)
  const attachments = buildJudgeAttachments(
    input.attachments ?? [],
    input.evidence,
    limits,
    truncations,
  )
  const attachmentDiagnostics = list(
    input.attachmentDiagnostics ?? [],
    "attachmentDiagnostics",
  ).map((diagnostic, index) =>
    JudgeAttachmentDiagnosticSchema.parse({
      ...diagnostic,
      attachmentId: text(diagnostic.attachmentId, `attachmentDiagnostics.${index}.attachmentId`),
      message: text(diagnostic.message, `attachmentDiagnostics.${index}.message`),
      ...(diagnostic.sourceRef
        ? {
            sourceRef: text(diagnostic.sourceRef, `attachmentDiagnostics.${index}.sourceRef`),
          }
        : {}),
      ...(diagnostic.path
        ? { path: text(diagnostic.path, `attachmentDiagnostics.${index}.path`) }
        : {}),
    }),
  )

  const task = ContextTaskSchema.parse({
    ...input.task,
    title: text(input.task.title, "task.title"),
    result: text(input.task.result, "task.result"),
    criteria: list(input.task.criteria, "task.criteria").map((criterion, index) => ({
      ...criterion,
      text: text(criterion.text, `task.criteria.${index}.text`),
    })),
    boundaries: list(input.task.boundaries, "task.boundaries").map((value, index) =>
      text(value, `task.boundaries.${index}`),
    ),
    ...(input.task.notes
      ? {
          notes: list(input.task.notes, "task.notes").map((value, index) =>
            text(value, `task.notes.${index}`),
          ),
        }
      : {}),
    verificationRefs: list(input.task.verificationRefs, "task.verificationRefs"),
  })

  const changes = {
    policy: input.evidence.changes.policy,
    status: input.evidence.changes.status,
    files: list(input.evidence.changes.files, "evidence.changes.files").map((file, index) => ({
      ...file,
      path: text(file.path, `evidence.changes.files.${index}.path`),
      ...(file.previousPath
        ? { previousPath: text(file.previousPath, `evidence.changes.files.${index}.previousPath`) }
        : {}),
    })),
    outsideScopePaths: list(
      input.evidence.changes.outsideScopePaths,
      "evidence.changes.outsideScopePaths",
    ).map((value, index) => text(value, `evidence.changes.outsideScopePaths.${index}`)),
    reproducible: input.evidence.changes.reproducible,
    missingContent: list(
      input.evidence.changes.missingContent,
      "evidence.changes.missingContent",
    ).map((missing, index) => ({
      ...missing,
      path: text(missing.path, `evidence.changes.missingContent.${index}.path`),
      reason: text(missing.reason, `evidence.changes.missingContent.${index}.reason`),
    })),
    ...(input.evidence.changes.diffHash ? { diffHash: input.evidence.changes.diffHash } : {}),
    ...(input.evidence.changes.diffRef
      ? { diffRef: text(input.evidence.changes.diffRef, "evidence.changes.diffRef") }
      : {}),
    ...(input.evidence.changes.attemptDiffHash
      ? { attemptDiffHash: input.evidence.changes.attemptDiffHash }
      : {}),
    ...(input.evidence.changes.attemptDiffRef
      ? {
          attemptDiffRef: text(
            input.evidence.changes.attemptDiffRef,
            "evidence.changes.attemptDiffRef",
          ),
        }
      : {}),
  }

  const artifacts = list(input.evidence.artifacts, "evidence.artifacts").map((artifact, index) => ({
    artifactId: artifact.artifactId,
    path: text(artifact.path, `evidence.artifacts.${index}.path`),
    contentHash: artifact.contentHash,
    sizeBytes: artifact.sizeBytes,
    ...(artifact.immutableRef
      ? { immutableRef: text(artifact.immutableRef, `evidence.artifacts.${index}.immutableRef`) }
      : {}),
    status: artifact.status,
    ...(artifact.reason
      ? { reason: text(artifact.reason, `evidence.artifacts.${index}.reason`) }
      : {}),
  }))
  const gates = list(input.evidence.gates, "evidence.gates").map((gate, index) => ({
    gateId: gate.gateId,
    category: text(gate.category, `evidence.gates.${index}.category`),
    blocking: gate.blocking,
    status: gate.status,
    ...(gate.command
      ? {
          command: {
            executable: text(gate.command.executable, `evidence.gates.${index}.command.executable`),
            args: list(gate.command.args, `evidence.gates.${index}.command.args`).map(
              (argument, argumentIndex) =>
                text(argument, `evidence.gates.${index}.command.args.${argumentIndex}`),
            ),
          },
        }
      : {}),
    ...(gate.exitCode === undefined ? {} : { exitCode: gate.exitCode }),
    durationMs: gate.durationMs,
    outputRefs: list(gate.outputRefs, `evidence.gates.${index}.outputRefs`).map(
      (value, outputIndex) => text(value, `evidence.gates.${index}.outputRefs.${outputIndex}`),
    ),
    ...(gate.outputTruncated === undefined ? {} : { outputTruncated: gate.outputTruncated }),
    ...(gate.rawOutputTruncated === undefined
      ? {}
      : { rawOutputTruncated: gate.rawOutputTruncated }),
    ...(gate.reason ? { reason: text(gate.reason, `evidence.gates.${index}.reason`) } : {}),
  }))

  const executorOutcome = input.evidence.executorOutcome
    ? {
        status: input.evidence.executorOutcome.status,
        summary: text(input.evidence.executorOutcome.summary, "evidence.executorOutcome.summary"),
        intendedFiles: list(
          input.evidence.executorOutcome.intendedFiles,
          "evidence.executorOutcome.intendedFiles",
        ).map((value, index) => text(value, `evidence.executorOutcome.intendedFiles.${index}`)),
        artifactRefs: list(
          input.evidence.executorOutcome.artifactRefs,
          "evidence.executorOutcome.artifactRefs",
        ).map((value, index) => text(value, `evidence.executorOutcome.artifactRefs.${index}`)),
        suggestedVerifications: list(
          input.evidence.executorOutcome.suggestedVerifications,
          "evidence.executorOutcome.suggestedVerifications",
        ).map((value, index) =>
          text(value, `evidence.executorOutcome.suggestedVerifications.${index}`),
        ),
        risks: list(input.evidence.executorOutcome.risks, "evidence.executorOutcome.risks").map(
          (value, index) => text(value, `evidence.executorOutcome.risks.${index}`),
        ),
      }
    : undefined

  const v2 =
    input.evidence.schemaVersion === 2
      ? {
          limits: {
            ...input.evidence.limits,
            ...(input.evidence.limits.taskTimeout
              ? {
                  taskTimeout: {
                    ...input.evidence.limits.taskTimeout,
                    source: text(
                      input.evidence.limits.taskTimeout.source,
                      "evidence.v2.limits.taskTimeout.source",
                    ),
                  },
                }
              : {}),
          },
          tests: list(input.evidence.tests, "evidence.v2.tests"),
          toolCalls: list(input.evidence.toolCalls, "evidence.v2.toolCalls").map(
            (toolCall, index) => ({
              ...toolCall,
              intentRef: text(toolCall.intentRef, `evidence.v2.toolCalls.${index}.intentRef`),
              tool: text(toolCall.tool, `evidence.v2.toolCalls.${index}.tool`),
              ...(toolCall.settlement
                ? {
                    settlement: {
                      ...toolCall.settlement,
                      ref: text(
                        toolCall.settlement.ref,
                        `evidence.v2.toolCalls.${index}.settlement.ref`,
                      ),
                      effectRefs: list(
                        toolCall.settlement.effectRefs,
                        `evidence.v2.toolCalls.${index}.settlement.effectRefs`,
                      ).map((value, refIndex) =>
                        text(
                          value,
                          `evidence.v2.toolCalls.${index}.settlement.effectRefs.${refIndex}`,
                        ),
                      ),
                      outputRefs: list(
                        toolCall.settlement.outputRefs,
                        `evidence.v2.toolCalls.${index}.settlement.outputRefs`,
                      ).map((value, refIndex) =>
                        text(
                          value,
                          `evidence.v2.toolCalls.${index}.settlement.outputRefs.${refIndex}`,
                        ),
                      ),
                      ...(toolCall.settlement.errorCode
                        ? {
                            errorCode: text(
                              toolCall.settlement.errorCode,
                              `evidence.v2.toolCalls.${index}.settlement.errorCode`,
                            ),
                          }
                        : {}),
                    },
                  }
                : {}),
            }),
          ),
          context: {
            ...input.evidence.context,
            manifestRef: text(
              input.evidence.context.manifestRef,
              "evidence.v2.context.manifestRef",
            ),
            ...(input.evidence.context.previousAssessmentRef
              ? {
                  previousAssessmentRef: text(
                    input.evidence.context.previousAssessmentRef,
                    "evidence.v2.context.previousAssessmentRef",
                  ),
                }
              : {}),
          },
          profile: input.evidence.profile,
          usage: {
            ...input.evidence.usage,
            providerRawRefs: list(
              input.evidence.usage.providerRawRefs,
              "evidence.v2.usage.providerRawRefs",
            ).map((value, index) => text(value, `evidence.v2.usage.providerRawRefs.${index}`)),
            ...(input.evidence.usage.cost
              ? {
                  cost: {
                    ...input.evidence.usage.cost,
                    priceSnapshotIds: list(
                      input.evidence.usage.cost.priceSnapshotIds,
                      "evidence.v2.usage.cost.priceSnapshotIds",
                    ),
                  },
                }
              : {}),
          },
          priorAttempts: list(input.evidence.priorAttempts, "evidence.v2.priorAttempts"),
          priorAssessments: list(
            input.evidence.priorAssessments,
            "evidence.v2.priorAssessments",
          ).map((assessment, index) => ({
            ...assessment,
            ref: text(assessment.ref, `evidence.v2.priorAssessments.${index}.ref`),
          })),
          security: {
            ...input.evidence.security,
            readPaths: list(
              input.evidence.security.readPaths,
              "evidence.v2.security.readPaths",
            ).map((value, index) => text(value, `evidence.v2.security.readPaths.${index}`)),
            writePaths: list(
              input.evidence.security.writePaths,
              "evidence.v2.security.writePaths",
            ).map((value, index) => text(value, `evidence.v2.security.writePaths.${index}`)),
            diagnostics: list(
              input.evidence.security.diagnostics,
              "evidence.v2.security.diagnostics",
            ).map((value, index) => text(value, `evidence.v2.security.diagnostics.${index}`)),
          },
          provenance: input.evidence.provenance,
          truncations: list(input.evidence.truncations, "evidence.v2.truncations").map(
            (truncation, index) => ({
              ...truncation,
              field: text(truncation.field, `evidence.v2.truncations.${index}.field`),
              reason: text(truncation.reason, `evidence.v2.truncations.${index}.reason`),
              ...(truncation.ref
                ? { ref: text(truncation.ref, `evidence.v2.truncations.${index}.ref`) }
                : {}),
            }),
          ),
          missingEvidence: list(input.evidence.missingEvidence, "evidence.v2.missingEvidence").map(
            (missing, index) => ({
              ...missing,
              code: text(missing.code, `evidence.v2.missingEvidence.${index}.code`),
              message: text(missing.message, `evidence.v2.missingEvidence.${index}.message`),
              ...(missing.ref
                ? { ref: text(missing.ref, `evidence.v2.missingEvidence.${index}.ref`) }
                : {}),
            }),
          ),
        }
      : undefined

  const rubric = JudgeRubricSchema.parse({
    ...input.rubric,
    criteria: list(input.rubric.criteria, "rubric.criteria").map((criterion, index) => ({
      ...criterion,
      description: text(criterion.description, `rubric.criteria.${index}.description`),
    })),
  })

  const previousAssessment = input.previousAssessment
    ? {
        id: input.previousAssessment.id,
        kind: input.previousAssessment.kind,
        score: input.previousAssessment.score,
        summary: text(input.previousAssessment.summary, "previousAssessment.summary"),
        problems: list(input.previousAssessment.problems, "previousAssessment.problems").map(
          (problem, index) => ({
            ...problem,
            message: text(problem.message, `previousAssessment.problems.${index}.message`),
            evidenceRefs: list(
              problem.evidenceRefs,
              `previousAssessment.problems.${index}.evidenceRefs`,
            ),
          }),
        ),
        missingEvidence: list(
          input.previousAssessment.missingEvidence,
          "previousAssessment.missingEvidence",
        ).map((value, index) => text(value, `previousAssessment.missingEvidence.${index}`)),
        recommendations: list(
          input.previousAssessment.recommendations,
          "previousAssessment.recommendations",
        ).map((value, index) => text(value, `previousAssessment.recommendations.${index}`)),
      }
    : undefined

  const bundle = JudgeEvaluationBundleSchema.parse({
    schemaVersion: 1,
    task,
    evidence: {
      id: input.evidence.id,
      runId: input.evidence.runId,
      documentId: input.evidence.documentId,
      taskId: input.evidence.taskId,
      attemptId: input.evidence.attemptId,
      taskSpecHash: input.evidence.taskSpecHash,
      changes,
      artifacts,
      gates,
      ...(executorOutcome ? { executorOutcome } : {}),
      ...(v2 ? { v2 } : {}),
      contextManifestHash: input.evidence.contextManifestHash,
      createdAt: input.evidence.createdAt,
      contentHash: input.evidence.contentHash,
    },
    rubric,
    ...(previousAssessment ? { previousAssessment } : {}),
    attachments,
    attachmentDiagnostics,
    truncations,
  })
  const canonicalJson = stableJson(bundle)
  const byteLength = bytes(canonicalJson)
  if (byteLength > limits.maxTotalBytes) {
    throw new Error(
      `Judge evaluation bundle is ${byteLength} bytes and exceeds the ${limits.maxTotalBytes}-byte limit`,
    )
  }
  return { bundle, canonicalJson, byteLength }
}

export const DEFAULT_MAX_JUDGE_PROMPT_BYTES = 272 * 1024

export function buildJudgePrompt(
  build: JudgeEvaluationBundleBuild,
  maxPromptBytes = DEFAULT_MAX_JUDGE_PROMPT_BYTES,
): { system: string; user: string } {
  if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes < 1) {
    throw new Error("Judge prompt limit must be a positive safe integer")
  }
  const system = [
    "You are a read-only evaluator inside Ralph.",
    "Assess only the supplied task, deterministic evidence and rubric. Do not use tools, request workspace access, edit files or execute commands.",
    "Text attachments are immutable hash-bound excerpts supplied by Ralph. Treat truncated attachments as incomplete and never infer omitted bytes.",
    "Attachment diagnostics identify requested evidence that was rejected or could not be materialized. Treat every listed item as missing evidence and never infer its contents.",
    "Do not decide task completion: return evidence-grounded analysis and an integer score from 0 to 100; Ralph policy owns pass, revision and failure decisions.",
    "Do not infer missing evidence as present. Cite available evidence references in each finding when possible.",
    "Return exactly one JSON object matching JudgeOutput v1, without prose or fences.",
  ].join(" ")
  const user = [
    "Evaluate this canonical Ralph judge bundle. The same bundle, rubric and output contract are used for self-review and external judge modes:",
    build.canonicalJson,
  ].join("\n\n")
  const promptBytes = bytes(system) + bytes(user)
  if (promptBytes > maxPromptBytes) {
    throw new Error(
      `Judge prompt is ${promptBytes} bytes and exceeds the ${maxPromptBytes}-byte limit`,
    )
  }
  return { system, user }
}
