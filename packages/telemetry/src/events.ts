import { z } from "zod"

export const EventLevelSchema = z.enum(["trace", "debug", "info", "warn", "error"])
export type EventLevel = z.infer<typeof EventLevelSchema>

const EventEnvelopeObjectSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  timestamp: z.iso.datetime({ offset: true }),
  monotonicMs: z.number().nonnegative(),
  type: z.string().min(1),
  scope: z.enum(["workspace", "run"]),
  streamId: z.string().min(1),
  workspaceId: z.string().min(1),
  runId: z.string().min(1).optional(),
  documentId: z.string().optional(),
  taskId: z.string().optional(),
  attemptId: z.string().optional(),
  callId: z.string().optional(),
  workerId: z.string().optional(),
  parentRunId: z.string().optional(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
  level: EventLevelSchema,
  payload: z.record(z.string(), z.unknown()),
})

export const EventEnvelopeSchema = EventEnvelopeObjectSchema.strict().refine(
  (event) => event.scope !== "run" || event.runId !== undefined,
  {
    message: "runId is required for run-scoped events",
    path: ["runId"],
  },
)

export const EventEnvelopeConsumerSchema = EventEnvelopeObjectSchema.passthrough().refine(
  (event) => event.scope !== "run" || event.runId !== undefined,
  {
    message: "runId is required for run-scoped events",
    path: ["runId"],
  },
)

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>

export type EventInput = {
  type: string
  scope: "workspace" | "run"
  streamId: string
  workspaceId: string
  runId?: string
  documentId?: string
  taskId?: string
  attemptId?: string
  callId?: string
  workerId?: string
  parentRunId?: string
  level?: EventLevel
  payload?: Record<string, unknown>
  correlationId?: string
  causationId?: string
  /**
   * Immutable command-resolved policy for workspace-scoped events. `null` is
   * explicit infinite retention; omission is unknown and therefore never
   * eligible for deletion. Run events bind this from the durable run snapshot.
   */
  eventRetention?: string | null
}

export type WorkspaceReplay = {
  initialized: boolean
  eventCursor: number
  eventCount: number
  lastEventType?: string
  initializedAt?: string
}

export function replayWorkspaceEvents(events: readonly EventEnvelope[]): WorkspaceReplay {
  const state: WorkspaceReplay = {
    initialized: false,
    eventCursor: 0,
    eventCount: 0,
  }

  for (const event of events) {
    EventEnvelopeConsumerSchema.parse(event)
    if (event.sequence <= state.eventCursor) {
      throw new Error(
        `Event sequence must be strictly increasing: ${event.sequence} <= ${state.eventCursor}`,
      )
    }
    state.eventCursor = event.sequence
    state.eventCount += 1
    state.lastEventType = event.type
    if (event.type === "workspace.initialized" || event.type === "workspace.repaired") {
      state.initialized = true
      state.initializedAt ??= event.timestamp
    }
  }

  return state
}
