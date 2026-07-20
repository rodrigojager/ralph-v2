type JudgeInput = {
  bundle: {
    previousAssessment?: unknown
    rubric: { criteria: Array<{ criterion: string }> }
  }
}

const input = JSON.parse(await Bun.stdin.text()) as JudgeInput
const revised = input.bundle.previousAssessment !== undefined
const score = revised ? 88 : 60
const criterion = input.bundle.rubric.criteria[0]?.criterion ?? "criterion-1"
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    score,
    summary: revised
      ? "The bounded revision addresses the prior finding."
      : "A bounded revision is required.",
    adequate: revised ? ["The declared vertical slice and evidence are adequate."] : [],
    problems: revised
      ? []
      : [
          {
            severity: "major",
            criterion,
            message: "Apply one explicit revision before approval.",
            evidenceRefs: [],
          },
        ],
    missingEvidence: revised ? [] : ["Evidence from the requested revision."],
    recommendations: revised ? [] : ["Address this assessment in one bounded revision."],
    criterionScores: [
      {
        criterion,
        score,
        rationale: revised ? "Revision evidence is present." : "Revision evidence is absent.",
      },
    ],
    confidence: 0.95,
  }),
)
