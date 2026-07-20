#!/usr/bin/env node

const chunks = []
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))

try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (
    input?.schemaVersion !== 1 ||
    input?.protocol !== "ralph.evaluation.external-cli.v1" ||
    input?.outputContract !== "judge-output-json-v1"
  ) {
    throw new Error("Unsupported Ralph sample judge protocol")
  }

  const taskId = input?.bundle?.task?.taskId
  const priorAttempts = Array.isArray(input?.bundle?.evidence?.v2?.priorAttempts)
    ? input.bundle.evidence.v2.priorAttempts
    : []
  const hasRequestedRevision = priorAttempts.some(
    (attempt) => attempt?.completionStatus === "revision_required",
  )
  const intentionalRevision = taskId === "note-create-flow" && !hasRequestedRevision
  const score = intentionalRevision ? 72 : 96
  const rubricCriteria = Array.isArray(input?.bundle?.rubric?.criteria)
    ? input.bundle.rubric.criteria
        .map((criterion) => criterion?.criterion)
        .filter((criterion) => typeof criterion === "string" && criterion.trim().length > 0)
    : []
  const criteria = rubricCriteria.length > 0 ? [...new Set(rubricCriteria)] : ["task-completion"]

  const output = {
    schemaVersion: 1,
    score,
    summary: intentionalRevision
      ? "The sample fixture intentionally requests one bounded revision for note-create-flow."
      : "The sample fixture accepts the supplied deterministic evidence projection.",
    adequate: intentionalRevision
      ? ["The judge protocol and evidence bundle were parsed successfully."]
      : ["The evidence bundle is present and the sample revision condition is satisfied."],
    problems: intentionalRevision
      ? [
          {
            severity: "major",
            criterion: criteria[0],
            message:
              "This fixture requires one revision so the sample can demonstrate judge feedback and retry accounting.",
            evidenceRefs: [],
          },
        ]
      : [],
    missingEvidence: intentionalRevision
      ? [
          "A prior note-create-flow attempt with completionStatus revision_required is required by the deterministic sample fixture.",
        ]
      : [],
    recommendations: intentionalRevision
      ? ["Perform one bounded revision and preserve the existing task contract and evidence."]
      : [],
    criterionScores: criteria.map((criterion) => ({
      criterion,
      score,
      rationale: intentionalRevision
        ? "The first attempt is deliberately below the sample threshold."
        : "The deterministic sample revision condition is satisfied.",
    })),
    confidence: 1,
  }

  process.stdout.write(JSON.stringify(output))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`ralph-sample-judge: ${message}\n`)
  process.exitCode = 2
}
