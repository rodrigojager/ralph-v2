import { z } from "zod"

const NonEmptyStringSchema = z.string().trim().min(1)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const TimestampSchema = z.iso.datetime({ offset: true })
const ScoreSchema = z.number().int().min(0).max(100)

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export const EvaluationModeSchema = z.enum(["deterministic-only", "external", "self", "manual"])
export type EvaluationMode = z.infer<typeof EvaluationModeSchema>

export const JudgeUnavailablePolicySchema = z.enum(["deterministic", "pause", "fail"])
export type JudgeUnavailablePolicy = z.infer<typeof JudgeUnavailablePolicySchema>

export const JudgeSeveritySchema = z.enum(["info", "minor", "major", "critical"])
export type JudgeSeverity = z.infer<typeof JudgeSeveritySchema>

export const JudgeFindingSchema = z
  .object({
    severity: JudgeSeveritySchema,
    criterion: NonEmptyStringSchema.optional(),
    message: NonEmptyStringSchema,
    evidenceRefs: z
      .array(NonEmptyStringSchema)
      .refine(unique, "Finding evidence references must be unique"),
  })
  .strict()
export type JudgeFinding = z.infer<typeof JudgeFindingSchema>

export const JudgeCriterionScoreSchema = z
  .object({
    criterion: NonEmptyStringSchema,
    score: ScoreSchema,
    rationale: NonEmptyStringSchema.optional(),
  })
  .strict()
export type JudgeCriterionScore = z.infer<typeof JudgeCriterionScoreSchema>

export const JudgeOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    score: ScoreSchema,
    summary: NonEmptyStringSchema,
    adequate: z.array(NonEmptyStringSchema),
    problems: z.array(JudgeFindingSchema),
    missingEvidence: z.array(NonEmptyStringSchema),
    recommendations: z.array(NonEmptyStringSchema),
    criterionScores: z.array(JudgeCriterionScoreSchema),
    confidence: z.number().finite().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!unique(value.criterionScores.map((criterion) => criterion.criterion))) {
      context.addIssue({
        code: "custom",
        message: "Judge criterion scores must identify unique criteria",
        path: ["criterionScores"],
      })
    }
  })
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>

export const EvaluationProfileSnapshotSchema = z
  .object({
    id: NonEmptyStringSchema,
    role: z.enum(["executor", "judge"]),
    backend: z.enum(["fake", "embedded", "external-cli"]),
    provider: NonEmptyStringSchema,
    model: NonEmptyStringSchema,
    variant: NonEmptyStringSchema.optional(),
    contentHash: Sha256Schema,
  })
  .strict()
export type EvaluationProfileSnapshot = z.infer<typeof EvaluationProfileSnapshotSchema>

export const JudgeAssessmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: NonEmptyStringSchema,
    kind: z.enum(["external", "self"]),
    profileSnapshot: EvaluationProfileSnapshotSchema,
    evidenceBundleId: NonEmptyStringSchema,
    score: ScoreSchema,
    summary: NonEmptyStringSchema,
    adequate: z.array(NonEmptyStringSchema),
    problems: z.array(JudgeFindingSchema),
    missingEvidence: z.array(NonEmptyStringSchema),
    recommendations: z.array(NonEmptyStringSchema),
    criterionScores: z.array(JudgeCriterionScoreSchema),
    confidence: z.number().finite().min(0).max(1).optional(),
    rawResponseRef: NonEmptyStringSchema.optional(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!unique(value.criterionScores.map((criterion) => criterion.criterion))) {
      context.addIssue({
        code: "custom",
        message: "Judge criterion scores must identify unique criteria",
        path: ["criterionScores"],
      })
    }
  })
export type JudgeAssessment = z.infer<typeof JudgeAssessmentSchema>

/**
 * Safe, bounded projection of a persisted assessment supplied to an executor
 * that is performing a judge-requested revision. This deliberately excludes
 * the judge profile, credential references, raw provider output and timestamps.
 * The source identifiers keep the projection auditable without granting the
 * executor access to Ralph's control directory.
 */
export const ContextAssessmentFeedbackSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceAssessmentRef: NonEmptyStringSchema,
    sourceAssessmentId: NonEmptyStringSchema,
    sourceEvidenceBundleId: NonEmptyStringSchema,
    sourceKind: z.enum(["external", "self"]),
    score: ScoreSchema,
    threshold: ScoreSchema,
    summary: NonEmptyStringSchema,
    adequate: z.array(NonEmptyStringSchema),
    problems: z.array(JudgeFindingSchema),
    missingEvidence: z.array(NonEmptyStringSchema),
    recommendations: z.array(NonEmptyStringSchema),
    criterionScores: z.array(JudgeCriterionScoreSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (!unique(value.criterionScores.map((criterion) => criterion.criterion))) {
      context.addIssue({
        code: "custom",
        message: "Context assessment criterion scores must identify unique criteria",
        path: ["criterionScores"],
      })
    }
  })
export type ContextAssessmentFeedback = z.infer<typeof ContextAssessmentFeedbackSchema>

export const JudgeRubricCriterionSchema = z
  .object({
    criterion: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    weight: z.number().finite().positive(),
    blocking: z.boolean().default(false),
  })
  .strict()
export type JudgeRubricCriterion = z.infer<typeof JudgeRubricCriterionSchema>

export const JudgeRubricSchema = z
  .object({
    schemaVersion: z.literal(1),
    weightPolicy: z.enum(["strict-100", "normalize"]),
    criteria: z.array(JudgeRubricCriterionSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (!unique(value.criteria.map((criterion) => criterion.criterion))) {
      context.addIssue({
        code: "custom",
        message: "Rubric criteria must be unique",
        path: ["criteria"],
      })
    }
    if (
      value.weightPolicy === "strict-100" &&
      Math.abs(value.criteria.reduce((total, criterion) => total + criterion.weight, 0) - 100) >
        Number.EPSILON
    ) {
      context.addIssue({
        code: "custom",
        message: "A strict rubric must have weights totaling 100",
        path: ["criteria"],
      })
    }
  })
export type JudgeRubric = z.infer<typeof JudgeRubricSchema>

export const EvaluationPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: EvaluationModeSchema,
    threshold: ScoreSchema,
    maxRevisionAttempts: z.number().int().nonnegative(),
    judgeCallRetries: z.number().int().nonnegative(),
    onJudgeUnavailable: JudgeUnavailablePolicySchema,
    blockingSeverities: z
      .array(JudgeSeveritySchema)
      .refine(unique, "Blocking severities must be unique"),
    exhaustedPolicy: z.enum(["manual-review", "fail", "stop-run"]),
    rubric: JudgeRubricSchema,
  })
  .strict()
export type EvaluationPolicy = z.infer<typeof EvaluationPolicySchema>
