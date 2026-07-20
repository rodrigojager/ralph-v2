import {
  type CompletionDecision,
  CompletionDecisionSchema,
  type EvaluationPolicy,
  EvaluationPolicySchema,
  type JudgeAssessment,
  JudgeAssessmentSchema,
} from "@ralph-next/domain"

function decisionMode(policy: EvaluationPolicy): CompletionDecision["evaluationMode"] {
  return policy.mode === "deterministic-only" ? "none" : policy.mode
}

function deterministicAccepted(decision: CompletionDecision): boolean {
  return decision.status === "passed" || decision.status === "overridden"
}

/**
 * Applies a valid judge assessment after deterministic gates have run.
 * The assessment is evidence, never authority: a deterministic rejection is
 * returned unchanged even when the assessment reports score 100.
 */
export function decideAssessedCompletion(input: {
  deterministicDecision: CompletionDecision
  assessment: JudgeAssessment
  policy: EvaluationPolicy
  decidedAt?: string
}): CompletionDecision {
  const policy = EvaluationPolicySchema.parse(input.policy)
  const assessment = JudgeAssessmentSchema.parse(input.assessment)
  const deterministic = CompletionDecisionSchema.parse(input.deterministicDecision)

  if (!deterministicAccepted(deterministic)) {
    return CompletionDecisionSchema.parse({
      ...deterministic,
      reasons: [
        ...deterministic.reasons,
        `Assessment ${assessment.id} cannot override deterministic gate or evidence failure`,
      ],
    })
  }
  if (policy.mode !== assessment.kind) {
    throw new Error(
      `Assessment kind ${assessment.kind} does not match evaluation mode ${policy.mode}`,
    )
  }
  if (assessment.evidenceBundleId !== deterministic.evidenceBundleId) {
    throw new Error(
      `Assessment ${assessment.id} targets ${assessment.evidenceBundleId}, expected ${deterministic.evidenceBundleId}`,
    )
  }

  const blockingSeverity = assessment.problems.filter((finding) =>
    policy.blockingSeverities.includes(finding.severity),
  )
  const scores = new Map(
    assessment.criterionScores.map((criterion) => [criterion.criterion, criterion.score]),
  )
  const failedMandatoryCriteria = policy.rubric.criteria
    .filter((criterion) => criterion.blocking)
    .filter((criterion) => (scores.get(criterion.criterion) ?? -1) < policy.threshold)
  const thresholdPassed = assessment.score >= policy.threshold
  const severityRulesPassed = blockingSeverity.length === 0 && failedMandatoryCriteria.length === 0
  const passed = thresholdPassed && severityRulesPassed
  const reasons: string[] = [
    `Judge score ${assessment.score} ${thresholdPassed ? "meets" : "is below"} threshold ${policy.threshold}`,
  ]
  if (blockingSeverity.length > 0) {
    reasons.push(
      `Blocking judge findings: ${blockingSeverity
        .map((finding) => `${finding.severity}: ${finding.message}`)
        .join("; ")}`,
    )
  }
  if (failedMandatoryCriteria.length > 0) {
    reasons.push(
      `Mandatory criteria below threshold or missing: ${failedMandatoryCriteria
        .map((criterion) => criterion.criterion)
        .join(", ")}`,
    )
  }

  return CompletionDecisionSchema.parse({
    status: passed ? deterministic.status : "revision_required",
    deterministicPassed: true,
    evaluationMode: assessment.kind,
    score: assessment.score,
    threshold: policy.threshold,
    severityRulesPassed,
    evidenceBundleId: deterministic.evidenceBundleId,
    assessmentId: assessment.id,
    reasons,
    decidedBy: "ralph-policy",
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  })
}

/** Resolves an unavailable judge without fabricating a score or assessment. */
export function decideUnavailableEvaluation(input: {
  deterministicDecision: CompletionDecision
  policy: EvaluationPolicy
  reason: string
  decidedAt?: string
}): CompletionDecision {
  const policy = EvaluationPolicySchema.parse(input.policy)
  const deterministic = CompletionDecisionSchema.parse(input.deterministicDecision)
  if (!deterministicAccepted(deterministic)) return deterministic

  if (policy.onJudgeUnavailable === "deterministic") {
    return CompletionDecisionSchema.parse({
      ...deterministic,
      evaluationMode: decisionMode(policy),
      reasons: [
        ...deterministic.reasons,
        `Evaluation unavailable; explicit deterministic fallback applied: ${input.reason}`,
      ],
      decidedAt: input.decidedAt ?? new Date().toISOString(),
    })
  }
  return CompletionDecisionSchema.parse({
    status: policy.onJudgeUnavailable === "pause" ? "blocked" : "failed",
    deterministicPassed: true,
    evaluationMode: decisionMode(policy),
    evidenceBundleId: deterministic.evidenceBundleId,
    reasons: [
      `Evaluation unavailable; policy ${policy.onJudgeUnavailable} prevents completion: ${input.reason}`,
    ],
    decidedBy: "ralph-policy",
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  })
}
