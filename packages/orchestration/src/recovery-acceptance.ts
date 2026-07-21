import {
  RecoveryDecisionObsoleteEventPayloadSchema,
  type RecoveryDecisionRequiredEventPayload,
  RecoveryDecisionRequiredEventPayloadSchema,
  RecoveryWorkspaceAcceptanceEventPayloadSchema,
} from "@ralph/domain"
import type { EventEnvelope } from "@ralph/telemetry"

export type PendingRecoveryDecision = {
  eventId: string
  sequence: number
  timestamp: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  payload: RecoveryDecisionRequiredEventPayload
}

const RESOLUTION_EVENT_TYPES = new Set([
  "recovery.operator_decision_accepted",
  "recovery.operator_decision_obsolete",
])

type ResolutionBinding = {
  sourceEventId: string
  documentId?: string
  taskId?: string
  decisionAttemptId?: string
}

function resolvedDecision(event: EventEnvelope): {
  decisionEventId: string
  decisionAttemptId: string
} {
  if (event.type === "recovery.operator_decision_accepted") {
    const payload = RecoveryWorkspaceAcceptanceEventPayloadSchema.parse(event.payload)
    return {
      decisionEventId: payload.decisionEventId,
      decisionAttemptId: payload.decisionAttemptId,
    }
  }
  const payload = RecoveryDecisionObsoleteEventPayloadSchema.parse(event.payload)
  return {
    decisionEventId: payload.decisionEventId,
    decisionAttemptId: payload.decisionAttemptId,
  }
}

/**
 * Finds the newest unresolved recovery decision for a run. Resolution is
 * explicit and references the original decision event; an unrelated resume or
 * a later process invocation can never make the decision disappear.
 */
export function findPendingRecoveryDecision(
  events: readonly EventEnvelope[],
  runId: string,
): PendingRecoveryDecision | undefined {
  const resolved = new Map<string, ResolutionBinding>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (!event || event.runId !== runId) continue
    if (RESOLUTION_EVENT_TYPES.has(event.type)) {
      const resolution = resolvedDecision(event)
      if (!resolved.has(resolution.decisionEventId)) {
        resolved.set(resolution.decisionEventId, {
          sourceEventId: event.eventId,
          ...(event.documentId ? { documentId: event.documentId } : {}),
          ...(event.taskId ? { taskId: event.taskId } : {}),
          decisionAttemptId: resolution.decisionAttemptId,
        })
      }
      continue
    }
    if (event.type !== "recovery.operator_decision_required") continue
    if (!event.documentId || !event.taskId || !event.attemptId) {
      throw new Error(
        `Recovery decision event ${event.eventId} is missing its task or attempt binding`,
      )
    }
    const payload = RecoveryDecisionRequiredEventPayloadSchema.parse(event.payload)
    if (payload.supersedesDecisionEventId && !resolved.has(payload.supersedesDecisionEventId)) {
      resolved.set(payload.supersedesDecisionEventId, {
        sourceEventId: event.eventId,
        documentId: event.documentId,
        taskId: event.taskId,
      })
    }
    const resolution = resolved.get(event.eventId)
    if (resolution) {
      if (
        resolution.documentId !== event.documentId ||
        resolution.taskId !== event.taskId ||
        (resolution.decisionAttemptId !== undefined &&
          resolution.decisionAttemptId !== event.attemptId)
      ) {
        throw new Error(
          `Recovery resolution ${resolution.sourceEventId} is not bound to decision ${event.eventId}`,
        )
      }
      continue
    }
    return {
      eventId: event.eventId,
      sequence: event.sequence,
      timestamp: event.timestamp,
      runId,
      documentId: event.documentId,
      taskId: event.taskId,
      attemptId: event.attemptId,
      payload,
    }
  }
  return undefined
}

export function recoveryDecisionMatchesObservation(
  decision: PendingRecoveryDecision,
  input: {
    documentId: string
    taskId: string
    taskBaselineHash: string
    expectedWorkspaceHash: string | undefined
    observedWorkspaceHash: string
  },
): boolean {
  return (
    decision.documentId === input.documentId &&
    decision.taskId === input.taskId &&
    decision.payload.taskBaselineHash === input.taskBaselineHash &&
    decision.payload.expectedWorkspaceHash === input.expectedWorkspaceHash &&
    decision.payload.observedWorkspaceHash === input.observedWorkspaceHash
  )
}
