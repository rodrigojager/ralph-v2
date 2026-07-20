import { createHash } from "node:crypto"

type AssessmentFeedback = {
  schemaVersion: 1
  sourceAssessmentRef: string
  sourceAssessmentId: string
  sourceEvidenceBundleId: string
  score: number
  threshold: number
  summary: string
  adequate: string[]
  problems: Array<{ message: string }>
  missingEvidence: string[]
  recommendations: string[]
  criterionScores: Array<{ criterion: string; score: number }>
}

type ProtocolInput = {
  call: { attemptId: string }
  history: Array<{ type: string; callId?: string }>
  context: {
    manifest: {
      previousAssessmentRef?: string
      revisionFeedback?: {
        kind: "assessment"
        ref: string
        sourceAssessmentRef: string
        sourceAssessmentId: string
        sourceEvidenceBundleId: string
        contentHash: string
        includedHash: string
        score: number
        threshold: number
        truncated: boolean
      }
    }
    resources: Array<{
      ref: string
      kind: string
      content: string
      contentHash: string
      includedHash: string
      truncated: boolean
    }>
  }
}

const input = JSON.parse(await Bun.stdin.text()) as ProtocolInput
const feedbackResource = input.context.resources.find((resource) => resource.kind === "assessment")
const revision = feedbackResource !== undefined
let feedback: AssessmentFeedback | undefined
if (revision) {
  const pointer = input.context.manifest.revisionFeedback
  if (!pointer) throw new Error("Revision assessment resource has no manifest pointer")
  feedback = JSON.parse(feedbackResource.content) as AssessmentFeedback
  const expectedRecommendation = "Address this assessment in one bounded revision."
  const expectedProblem = "Apply one explicit revision before approval."
  if (
    feedback.schemaVersion !== 1 ||
    feedback.score !== 60 ||
    feedback.threshold !== 85 ||
    feedback.recommendations[0] !== expectedRecommendation ||
    feedback.problems[0]?.message !== expectedProblem ||
    feedback.sourceAssessmentRef !== pointer.sourceAssessmentRef ||
    feedback.sourceAssessmentId !== pointer.sourceAssessmentId ||
    feedback.sourceEvidenceBundleId !== pointer.sourceEvidenceBundleId ||
    input.context.manifest.previousAssessmentRef !== feedback.sourceAssessmentRef ||
    feedbackResource.ref !== pointer.ref ||
    feedbackResource.contentHash !== pointer.contentHash ||
    feedbackResource.truncated !== pointer.truncated ||
    createHash("sha256").update(feedbackResource.content).digest("hex") !== pointer.includedHash
  ) {
    throw new Error("Revision assessment feedback is missing, incomplete, or not hash-bound")
  }
}

const feedbackSlug = feedback?.recommendations[0]
  ?.toLocaleLowerCase("en-US")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .slice(0, 56)
const callId = revision ? `fixture-revision-${feedbackSlug}` : "fixture-capability-write"
const path = revision ? `product/${feedbackSlug}.txt` : "product/capability.txt"
const content = feedback
  ? [
      `score=${feedback.score}/${feedback.threshold}`,
      `problem=${feedback.problems[0]?.message}`,
      `recommendation=${feedback.recommendations[0]}`,
    ].join("\n")
  : "delivered"
const settled = input.history.some(
  (item) => item.type === "function-call-output" && item.callId === callId,
)

if (!settled) {
  const toolInput = {
    path,
    content,
    precondition: { kind: "absent" },
    createParents: true,
  }
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      protocol: "ralph.execution.external-cli.v1",
      kind: "tool-calls",
      toolCalls: [
        {
          itemId: `${callId}-item`,
          callId,
          name: "fs.write",
          argumentsJson: JSON.stringify(toolInput),
          input: toolInput,
        },
      ],
    }),
  )
} else {
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      protocol: "ralph.execution.external-cli.v1",
      kind: "outcome",
      outcome: {
        schemaVersion: 1,
        status: "work_submitted",
        summary: feedback
          ? `Applied structured feedback: ${feedback.recommendations[0]}`
          : "Delivered the initial slice.",
        intendedFiles: [path],
        artifactRefs: [],
        suggestedVerifications: [],
        risks: [],
        reportedAt: "2000-01-01T00:00:00.000Z",
      },
    }),
  )
}
