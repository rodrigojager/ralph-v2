import { describe, expect, test } from "bun:test"
import {
  type CompletionDecision,
  type EvaluationPolicy,
  JudgeAssessmentSchema,
} from "@ralph-next/domain"
import { decideAssessedCompletion, decideUnavailableEvaluation } from "@ralph-next/verification"

const HASH = "a".repeat(64)

function policy(overrides: Partial<EvaluationPolicy> = {}): EvaluationPolicy {
  return {
    schemaVersion: 1,
    mode: "external",
    threshold: 85,
    maxRevisionAttempts: 2,
    judgeCallRetries: 1,
    onJudgeUnavailable: "pause",
    blockingSeverities: ["critical"],
    exhaustedPolicy: "manual-review",
    rubric: {
      schemaVersion: 1,
      weightPolicy: "strict-100",
      criteria: [
        { criterion: "C1", description: "The vertical slice works", weight: 100, blocking: true },
      ],
    },
    ...overrides,
  }
}

function deterministic(status: CompletionDecision["status"] = "passed"): CompletionDecision {
  return {
    status,
    deterministicPassed: status === "passed" || status === "overridden",
    evaluationMode: "none",
    evidenceBundleId: "evidence-1",
    reasons: status === "passed" ? ["Gates passed"] : ["Blocking gate failed"],
    decidedBy: "ralph-policy",
    decidedAt: "2026-07-18T12:00:00.000Z",
  }
}

function assessment(score: number, options: { critical?: boolean; criterionScore?: number } = {}) {
  return JudgeAssessmentSchema.parse({
    schemaVersion: 1,
    id: `assessment-${score}`,
    kind: "external",
    profileSnapshot: {
      id: "judge-main",
      role: "judge",
      backend: "fake",
      provider: "fake",
      model: "judge-fixture",
      contentHash: HASH,
    },
    evidenceBundleId: "evidence-1",
    score,
    summary: "Structured assessment",
    adequate: score >= 85 ? ["Main path is connected"] : [],
    problems: options.critical
      ? [{ severity: "critical", message: "Unsafe output", evidenceRefs: [] }]
      : [],
    missingEvidence: [],
    recommendations: score >= 85 ? [] : ["Complete the missing behavior"],
    criterionScores: [
      { criterion: "C1", score: options.criterionScore ?? score, rationale: "Fixture" },
    ],
    confidence: 0.9,
    createdAt: "2026-07-18T12:01:00.000Z",
  })
}

describe("S06 evaluation policy", () => {
  test("requires revision below threshold and accepts a later assessment", () => {
    const rejected = decideAssessedCompletion({
      deterministicDecision: deterministic(),
      assessment: assessment(60),
      policy: policy(),
    })
    expect(rejected).toMatchObject({
      status: "revision_required",
      score: 60,
      threshold: 85,
      assessmentId: "assessment-60",
      severityRulesPassed: false,
    })

    const accepted = decideAssessedCompletion({
      deterministicDecision: deterministic(),
      assessment: assessment(88),
      policy: policy(),
    })
    expect(accepted).toMatchObject({
      status: "passed",
      score: 88,
      threshold: 85,
      evaluationMode: "external",
      severityRulesPassed: true,
    })
  })

  test("never lets score 100 override a blocking deterministic failure", () => {
    const result = decideAssessedCompletion({
      deterministicDecision: deterministic("failed"),
      assessment: assessment(100),
      policy: policy(),
    })
    expect(result.status).toBe("failed")
    expect(result.score).toBeUndefined()
    expect(result.reasons.join(" ")).toContain("cannot override deterministic")
  })

  test("applies blocking severity and mandatory criterion rules independently of total score", () => {
    expect(
      decideAssessedCompletion({
        deterministicDecision: deterministic(),
        assessment: assessment(100, { critical: true }),
        policy: policy(),
      }).status,
    ).toBe("revision_required")
    expect(
      decideAssessedCompletion({
        deterministicDecision: deterministic(),
        assessment: assessment(100, { criterionScore: 40 }),
        policy: policy(),
      }).status,
    ).toBe("revision_required")
  })

  test("handles unavailable evaluation without inventing score or assessment", () => {
    const fallback = decideUnavailableEvaluation({
      deterministicDecision: deterministic(),
      policy: policy({ onJudgeUnavailable: "deterministic" }),
      reason: "judge offline",
    })
    expect(fallback.status).toBe("passed")
    expect(fallback.score).toBeUndefined()
    expect(fallback.assessmentId).toBeUndefined()

    expect(
      decideUnavailableEvaluation({
        deterministicDecision: deterministic(),
        policy: policy({ onJudgeUnavailable: "pause" }),
        reason: "judge offline",
      }).status,
    ).toBe("blocked")
    expect(
      decideUnavailableEvaluation({
        deterministicDecision: deterministic(),
        policy: policy({ onJudgeUnavailable: "fail" }),
        reason: "judge offline",
      }).status,
    ).toBe("failed")
  })
})
