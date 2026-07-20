import type { EvaluationFieldMetadata, RunUiSnapshot } from "../src"

export const EVALUATION_FIELDS: readonly EvaluationFieldMetadata[] = [
  {
    id: "evaluationMode",
    label: "Evaluation mode",
    kind: "select",
    configPath: "evaluation.mode",
    cliFlag: "--evaluation-mode",
    defaultValue: "external",
  },
  {
    id: "judgeThreshold",
    label: "Judge threshold",
    kind: "integer",
    configPath: "evaluation.threshold",
    cliFlag: "--judge-threshold",
    defaultValue: 80,
  },
  {
    id: "credential",
    label: "Credential",
    kind: "string",
    secret: true,
  },
]

export function populatedSnapshot(): RunUiSnapshot {
  return {
    runId: "run-006",
    title: "Vertical slice delivery",
    status: "running",
    currentTask: {
      id: "S06.10",
      title: "Evaluation dashboard",
      status: "executing",
      attempt: 2,
    },
    progress: { completed: 6, total: 12 },
    usage: {
      combined: {
        available: false,
        source: "incomplete-role-usage",
        note: "judge usage unavailable",
      },
      executor: {
        available: true,
        source: "provider-final",
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
        cost: { amount: 0.012345, currency: "USD", source: "provider" },
      },
      judge: {
        available: false,
        source: "provider-did-not-report",
        note: "no usage event",
      },
    },
    activity: [
      { timestamp: "12:00:00", type: "task", message: "executor started" },
      { timestamp: "12:00:02", type: "gate", message: "schema passed" },
    ],
    events: [{ timestamp: "12:00:03", type: "judge", message: "assessment received" }],
    logs: [{ timestamp: "12:00:04", type: "info", message: "revision requested" }],
    engineOutput: ["editing packages/tui", "focused typecheck passed"],
    judge: {
      mode: "external",
      profile: "judge-main",
      score: 74,
      threshold: 85,
      revisionAttempt: 1,
      maxRevisionAttempts: 3,
      decision: "revise",
      summary: "The vertical slice is connected, but evidence is incomplete.",
      feedback: {
        adequate: ["UI reads a provider-neutral snapshot"],
        problems: ["Missing narrow-terminal evidence"],
        missing: ["A popup interaction capture"],
        recommendations: ["Add a focused renderer test"],
      },
    },
    evaluationValues: {
      evaluationMode: "external",
      judgeThreshold: 85,
      credential: "must-never-render",
    },
    evaluationOrigins: {
      evaluationMode: "cli (cli:--evaluation)",
      judgeThreshold: "workspace (workspace:evaluation.threshold)",
      credential: "global (global:profiles.judge-main.credential)",
    },
  }
}
