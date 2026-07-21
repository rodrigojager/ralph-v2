import {
  DiagnosticSchema,
  type WatchdogEvaluation,
  WatchdogEvaluationSchema,
  WatchdogPhaseSchema,
  WatchdogRecoveryDecisionSchema,
  WatchdogSnapshotSchema,
  WatchdogStateSchema,
} from "@ralph/domain"
import { z } from "zod"
import type { EventInput, EventLevel } from "./events"

export const WatchdogProbePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: WatchdogPhaseSchema,
    state: WatchdogStateSchema,
    probeId: z.string().min(1),
    snapshot: WatchdogSnapshotSchema,
  })
  .strict()
export type WatchdogProbePayload = z.infer<typeof WatchdogProbePayloadSchema>

export const WatchdogStateChangedPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: WatchdogPhaseSchema,
    probeId: z.string().min(1),
    previousState: WatchdogStateSchema.optional(),
    state: WatchdogStateSchema,
    snapshot: WatchdogSnapshotSchema,
  })
  .strict()
export type WatchdogStateChangedPayload = z.infer<typeof WatchdogStateChangedPayloadSchema>

export const WatchdogActionPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: WatchdogPhaseSchema,
    probeId: z.string().min(1),
    decision: WatchdogRecoveryDecisionSchema,
    snapshot: WatchdogSnapshotSchema,
  })
  .strict()
export type WatchdogActionPayload = z.infer<typeof WatchdogActionPayloadSchema>

export const WatchdogDiagnosticPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("watchdog"),
    phase: WatchdogPhaseSchema,
    probeId: z.string().min(1),
    diagnostic: DiagnosticSchema,
    snapshot: WatchdogSnapshotSchema,
  })
  .strict()
export type WatchdogDiagnosticPayload = z.infer<typeof WatchdogDiagnosticPayloadSchema>

export const WatchdogEventContextSchema = z
  .object({
    streamId: z.string().min(1),
    workspaceId: z.string().min(1),
    runId: z.string().min(1),
    documentId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    attemptId: z.string().min(1).optional(),
    callId: z.string().min(1).optional(),
    workerId: z.string().min(1).optional(),
    parentRunId: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
    causationId: z.string().min(1).optional(),
  })
  .strict()
export type WatchdogEventContext = z.infer<typeof WatchdogEventContextSchema>

function eventInput(
  context: WatchdogEventContext,
  type: "watchdog.probe" | "watchdog.state_changed" | "watchdog.action" | "diagnostic.created",
  level: EventLevel,
  payload: Record<string, unknown>,
): EventInput {
  return {
    type,
    scope: "run",
    streamId: context.streamId,
    workspaceId: context.workspaceId,
    runId: context.runId,
    level,
    payload,
    ...(context.documentId ? { documentId: context.documentId } : {}),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.attemptId ? { attemptId: context.attemptId } : {}),
    ...(context.callId ? { callId: context.callId } : {}),
    ...(context.workerId ? { workerId: context.workerId } : {}),
    ...(context.parentRunId ? { parentRunId: context.parentRunId } : {}),
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    ...(context.causationId ? { causationId: context.causationId } : {}),
  }
}

function stateLevel(state: WatchdogStateChangedPayload["state"]): EventLevel {
  if (state === "stalled") return "error"
  if (state === "suspect" || state === "slow") return "warn"
  return "info"
}

function actionLevel(action: WatchdogActionPayload["decision"]["action"]): EventLevel {
  if (action === "stop-run") return "error"
  if (action === "none") return "debug"
  return "warn"
}

export function watchdogEventInputs(
  contextInput: WatchdogEventContext,
  evaluationInput: WatchdogEvaluation,
): EventInput[] {
  const context = WatchdogEventContextSchema.parse(contextInput)
  const evaluation = WatchdogEvaluationSchema.parse(evaluationInput)
  const { snapshot, previousSnapshot, decision } = evaluation
  const events: EventInput[] = []

  const probe = WatchdogProbePayloadSchema.parse({
    schemaVersion: 1,
    phase: snapshot.phase,
    state: snapshot.state,
    probeId: snapshot.probeId,
    snapshot,
  })
  events.push(eventInput(context, "watchdog.probe", "debug", probe))

  const stateChanged =
    previousSnapshot === undefined ||
    previousSnapshot.phase !== snapshot.phase ||
    previousSnapshot.state !== snapshot.state
  if (stateChanged) {
    const payload = WatchdogStateChangedPayloadSchema.parse({
      schemaVersion: 1,
      phase: snapshot.phase,
      probeId: snapshot.probeId,
      ...(previousSnapshot ? { previousState: previousSnapshot.state } : {}),
      state: snapshot.state,
      snapshot,
    })
    events.push(eventInput(context, "watchdog.state_changed", stateLevel(snapshot.state), payload))
  }

  if (decision.action !== "none") {
    const payload = WatchdogActionPayloadSchema.parse({
      schemaVersion: 1,
      phase: snapshot.phase,
      probeId: snapshot.probeId,
      decision,
      snapshot,
    })
    events.push(eventInput(context, "watchdog.action", actionLevel(decision.action), payload))
  }

  for (const diagnostic of evaluation.diagnostics) {
    const payload = WatchdogDiagnosticPayloadSchema.parse({
      schemaVersion: 1,
      source: "watchdog",
      phase: snapshot.phase,
      probeId: snapshot.probeId,
      diagnostic,
      snapshot,
    })
    const level: EventLevel =
      diagnostic.severity === "error"
        ? "error"
        : diagnostic.severity === "warning"
          ? "warn"
          : "info"
    events.push(eventInput(context, "diagnostic.created", level, payload))
  }

  return events
}
