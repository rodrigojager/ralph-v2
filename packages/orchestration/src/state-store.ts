import {
  type AttemptPhase,
  type AttemptStatus,
  type CompletionDecision,
  canTransitionAttemptPhase,
  canTransitionAttemptStatus,
  canTransitionRunStatus,
  canTransitionTaskRuntimeStatus,
  ExecutionTransitionError,
  type RunStatus,
  type TaskRecord,
  TaskRecordSchema,
  type TaskRuntimeStatus,
} from "@ralph-next/domain"
import {
  type RunTaskRecord,
  type AttemptRecord as StoredAttemptRecord,
  type RunRecord as StoredRunRecord,
  updateAttempt,
  updateRun,
  upsertRunTask,
} from "@ralph-next/persistence"

export function domainTaskRecord(record: RunTaskRecord): TaskRecord {
  return TaskRecordSchema.parse({
    runId: record.runId,
    documentId: record.documentId,
    taskId: record.taskId,
    status: record.status,
    markerContentHash: record.markerContentHash,
    ...(record.activeAttemptId ? { activeAttemptId: record.activeAttemptId } : {}),
    ...(record.completion ? { completion: record.completion } : {}),
    updatedAt: record.updatedAt,
  })
}

export function transitionStoredRun(
  ledger: string,
  record: StoredRunRecord,
  status: RunStatus,
  options: {
    stopReason?: string | null
    graphHash?: string
    startedAt?: string
    finishedAt?: string | null
    eventType?: string
  } = {},
): StoredRunRecord {
  if (record.status !== status && !canTransitionRunStatus(record.status, status)) {
    throw new ExecutionTransitionError(
      "RALPH_RUN_STATUS_TRANSITION_INVALID",
      `Invalid run status transition: ${record.status} -> ${status}`,
      { runId: record.id },
    )
  }
  return updateRun(ledger, {
    runId: record.id,
    status,
    ...(options.graphHash ? { graphHash: options.graphHash } : {}),
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
    ...(options.finishedAt !== undefined ? { finishedAt: options.finishedAt } : {}),
    ...(options.stopReason !== undefined ? { stopReason: options.stopReason } : {}),
    event: { type: options.eventType ?? "run.state.transitioned" },
  })
}

export function transitionStoredTask(
  ledger: string,
  record: RunTaskRecord,
  status: TaskRuntimeStatus,
  options: {
    markerContentHash?: string
    activeAttemptId?: string | null
    completion?: CompletionDecision | null
    eventType?: string
  } = {},
): RunTaskRecord {
  if (record.status !== status) {
    if (status === "completed" || status === "completed_with_override") {
      throw new ExecutionTransitionError(
        "RALPH_TASK_COMPLETION_AUTHORITY_REQUIRED",
        "Completion must use the prepared/marker/committed coordinator",
        { runId: record.runId, documentId: record.documentId, taskId: record.taskId },
      )
    }
    if (!canTransitionTaskRuntimeStatus(record.status, status)) {
      throw new ExecutionTransitionError(
        "RALPH_TASK_STATUS_TRANSITION_INVALID",
        `Invalid task status transition: ${record.status} -> ${status}`,
        { runId: record.runId, documentId: record.documentId, taskId: record.taskId },
      )
    }
  }
  return upsertRunTask(ledger, {
    runId: record.runId,
    documentId: record.documentId,
    taskId: record.taskId,
    status,
    markerContentHash: options.markerContentHash ?? record.markerContentHash,
    ...(options.activeAttemptId !== undefined
      ? { activeAttemptId: options.activeAttemptId }
      : record.activeAttemptId
        ? { activeAttemptId: record.activeAttemptId }
        : {}),
    ...(options.completion !== undefined
      ? { completion: options.completion }
      : record.completion
        ? { completion: record.completion }
        : {}),
    event: { type: options.eventType ?? "task.state.transitioned" },
  })
}

export function transitionStoredAttemptPhase(
  ledger: string,
  record: StoredAttemptRecord,
  phase: AttemptPhase,
  eventType = "attempt.phase.transitioned",
): StoredAttemptRecord {
  if (record.phase !== phase && !canTransitionAttemptPhase(record.phase, phase)) {
    throw new ExecutionTransitionError(
      "RALPH_ATTEMPT_PHASE_TRANSITION_INVALID",
      `Invalid attempt phase transition: ${record.phase} -> ${phase}`,
      { attemptId: record.id },
    )
  }
  return updateAttempt(ledger, { attemptId: record.id, phase, event: { type: eventType } })
}

export function transitionStoredAttemptStatus(
  ledger: string,
  record: StoredAttemptRecord,
  status: AttemptStatus,
  options: { finishedAt?: string; eventType?: string } = {},
): StoredAttemptRecord {
  if (record.status !== status && !canTransitionAttemptStatus(record.status, status)) {
    throw new ExecutionTransitionError(
      "RALPH_ATTEMPT_STATUS_TRANSITION_INVALID",
      `Invalid attempt status transition: ${record.status} -> ${status}`,
      { attemptId: record.id },
    )
  }
  return updateAttempt(ledger, {
    attemptId: record.id,
    status,
    ...(options.finishedAt ? { finishedAt: options.finishedAt } : {}),
    event: { type: options.eventType ?? "attempt.status.transitioned" },
  })
}
