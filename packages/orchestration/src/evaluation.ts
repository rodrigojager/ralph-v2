import {
  type EffectiveRunOptions,
  type EvaluationPolicy,
  EvaluationPolicySchema,
} from "@ralph/domain"
import type { PrdTask } from "@ralph/prd"

/** Materializes the command-owned evaluation policy for one compiled task. */
export function evaluationPolicyForTask(
  options: EffectiveRunOptions,
  task: PrdTask,
): EvaluationPolicy {
  const derivedCriteria =
    task.criteria.length > 0
      ? task.criteria.map((criterion) => ({
          criterion: criterion.id,
          description: criterion.text.text,
          weight: criterion.weight ?? 1,
          blocking: criterion.blocking ?? false,
        }))
      : [
          {
            criterion: "task-result",
            description: task.result.text,
            weight: 1,
            blocking: true,
          },
        ]
  const configuredRubric = options.judgeRubric?.value
  const rubric = configuredRubric
    ? {
        schemaVersion: 1 as const,
        weightPolicy: configuredRubric.weight_policy,
        criteria: configuredRubric.criteria.map((criterion) => ({
          criterion: criterion.id,
          description: criterion.description,
          weight: criterion.weight,
          blocking: criterion.blocking,
        })),
      }
    : {
        schemaVersion: 1 as const,
        weightPolicy: "normalize" as const,
        criteria: derivedCriteria,
      }
  return EvaluationPolicySchema.parse({
    schemaVersion: 1,
    mode: options.evaluationMode.value,
    threshold: options.judgeThreshold.value,
    maxRevisionAttempts: options.maxRevisionAttempts.value,
    judgeCallRetries: options.judgeCallRetries.value,
    onJudgeUnavailable: options.judgeUnavailablePolicy.value,
    blockingSeverities: options.blockingJudgeSeverities.value,
    exhaustedPolicy: options.judgeExhaustedPolicy.value,
    rubric,
  })
}
