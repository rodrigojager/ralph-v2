export const PRD_AUTHORSHIP_POLICY = Object.freeze({
  schemaVersion: 1 as const,
  author: "external-skill" as const,
  runtime: "consumer-only" as const,
  missingPlan: "fail-before-model" as const,
  childCreation: "pre-run-only" as const,
})
