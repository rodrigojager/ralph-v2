import { createHash } from "node:crypto"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import { appendEventInTransaction, withLedger } from "@ralph-next/persistence"
import { type EventEnvelope, EventEnvelopeConsumerSchema } from "@ralph-next/telemetry"
import { z } from "zod"

const SafeNonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const SafePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const RevisionRecoverySourceSchema = z.enum(["cli", "tui", "api"])
const ReasonSchema = z.string().trim().min(1).max(2_000)
const RequestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const TimestampSchema = z.iso.datetime({ offset: true })

/**
 * Durable payload contract for `evaluation.revisions.extended`.
 *
 * The event is intentionally an operational extension rather than a mutation
 * of EffectiveRunOptions. Its chain fields make replay detect missing,
 * duplicated, reordered, or conflicting grants.
 */
export const JudgeRevisionExtensionPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    previousMaximum: SafeNonNegativeIntegerSchema,
    additionalRevisions: SafePositiveIntegerSchema,
    effectiveMaximum: SafePositiveIntegerSchema,
    source: RevisionRecoverySourceSchema,
    reason: ReasonSchema,
    reasonHash: Sha256Schema,
    exhaustionEventId: z.string().min(1),
    grantedAt: TimestampSchema,
    previousTaskStatus: z.literal("blocked"),
    taskStatus: z.literal("eligible"),
    requestId: RequestIdSchema.optional(),
  })
  .strict()

export type JudgeRevisionExtensionPayload = z.infer<typeof JudgeRevisionExtensionPayloadSchema>
export type RevisionRecoverySource = z.infer<typeof RevisionRecoverySourceSchema>

export type JudgeRevisionScope = {
  runId: string
  documentId: string
  taskId: string
}

export type JudgeRevisionGrantRecord = JudgeRevisionExtensionPayload & {
  eventId: string
  sequence: number
}

export type JudgeRevisionGrantSummary = {
  baseMaximum: number
  totalGranted: number
  effectiveMaximum: number
  grants: readonly JudgeRevisionGrantRecord[]
}

export type JudgeRevisionGrantReceipt = JudgeRevisionExtensionPayload & {
  eventId: string
  sequence: number
  idempotent: boolean
}

export type GrantJudgeRevisionAttemptsInput = JudgeRevisionScope & {
  ledger: string
  additionalRevisions: number
  reason: string
  source: RevisionRecoverySource
  /** Enables safe retries across a lost CLI/TUI/API response. */
  requestId?: string
  now?: () => string
}

type StoredRunRow = {
  workspace_id: string
  status: string
}

type StoredTaskRow = {
  status: string
  active_attempt_id: string | null
}

type StoredEventRow = {
  event_json: string
}

const ManualReviewExhaustionPayloadSchema = z
  .object({
    policy: z.literal("manual-review"),
    maximum: SafeNonNegativeIntegerSchema,
    baseMaximum: SafeNonNegativeIntegerSchema.optional(),
  })
  .passthrough()

function invalidInput(code: string, message: string): RalphError {
  return new RalphError(code, message, { exitCode: EXIT_CODES.invalidUsage })
}

function recoveryConflict(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RalphError {
  return new RalphError(code, message, {
    exitCode: EXIT_CODES.conflict,
    ...(details ? { details } : {}),
  })
}

function nonEmptyIdentity(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidInput("RALPH_REVISION_RECOVERY_SCOPE_INVALID", `${field} must not be empty`)
  }
  return value
}

function safeAdd(left: number, right: number): number {
  const parsedLeft = SafeNonNegativeIntegerSchema.safeParse(left)
  const parsedRight = SafeNonNegativeIntegerSchema.safeParse(right)
  if (!parsedLeft.success || !parsedRight.success || right > Number.MAX_SAFE_INTEGER - left) {
    throw recoveryConflict(
      "RALPH_REVISION_RECOVERY_OVERFLOW",
      "The cumulative judge revision maximum exceeds the safe integer limit",
    )
  }
  return left + right
}

function reasonHash(reason: string): string {
  return createHash("sha256").update(reason, "utf8").digest("hex")
}

function scopedRevisionEvents(
  events: readonly EventEnvelope[],
  scope: JudgeRevisionScope,
): EventEnvelope[] {
  return events
    .filter(
      (event) =>
        event.runId === scope.runId &&
        event.documentId === scope.documentId &&
        event.taskId === scope.taskId &&
        event.type === "evaluation.revisions.extended",
    )
    .sort((left, right) => left.sequence - right.sequence)
}

/** Replays the immutable grant chain without consulting mutable run state. */
export function judgeRevisionGrantSummary(input: {
  baseMaximum: number
  events: readonly EventEnvelope[]
  scope: JudgeRevisionScope
}): JudgeRevisionGrantSummary {
  const baseMaximum = SafeNonNegativeIntegerSchema.safeParse(input.baseMaximum)
  if (!baseMaximum.success) {
    throw invalidInput(
      "RALPH_REVISION_RECOVERY_BASE_INVALID",
      "The base judge revision maximum must be a non-negative safe integer",
    )
  }

  let effectiveMaximum = baseMaximum.data
  let totalGranted = 0
  const grants: JudgeRevisionGrantRecord[] = []
  for (const event of scopedRevisionEvents(input.events, input.scope)) {
    const payload = JudgeRevisionExtensionPayloadSchema.safeParse(event.payload)
    if (!payload.success) {
      throw recoveryConflict(
        "RALPH_REVISION_RECOVERY_EVENT_INVALID",
        `Revision extension event ${event.eventId} has an invalid versioned payload`,
        { eventId: event.eventId },
      )
    }
    if (payload.data.previousMaximum !== effectiveMaximum) {
      throw recoveryConflict(
        "RALPH_REVISION_RECOVERY_CHAIN_CONFLICT",
        `Revision extension event ${event.eventId} does not continue the durable grant chain`,
        {
          eventId: event.eventId,
          expectedPreviousMaximum: effectiveMaximum,
          actualPreviousMaximum: payload.data.previousMaximum,
        },
      )
    }
    const expectedEffective = safeAdd(effectiveMaximum, payload.data.additionalRevisions)
    if (payload.data.effectiveMaximum !== expectedEffective) {
      throw recoveryConflict(
        "RALPH_REVISION_RECOVERY_CHAIN_CONFLICT",
        `Revision extension event ${event.eventId} has a conflicting effective maximum`,
        {
          eventId: event.eventId,
          expectedEffectiveMaximum: expectedEffective,
          actualEffectiveMaximum: payload.data.effectiveMaximum,
        },
      )
    }
    effectiveMaximum = expectedEffective
    totalGranted = safeAdd(totalGranted, payload.data.additionalRevisions)
    grants.push({ ...payload.data, eventId: event.eventId, sequence: event.sequence })
  }
  return { baseMaximum: baseMaximum.data, totalGranted, effectiveMaximum, grants }
}

export function effectiveJudgeRevisionMaximum(input: {
  baseMaximum: number
  events: readonly EventEnvelope[]
  scope: JudgeRevisionScope
}): number {
  return judgeRevisionGrantSummary(input).effectiveMaximum
}

function storedRevisionEvents(
  database: Parameters<Parameters<typeof withLedger>[1]>[0],
  scope: JudgeRevisionScope,
): EventEnvelope[] {
  return database
    .query<StoredEventRow, [string, string, string]>(
      `SELECT event_json FROM events
       WHERE run_id = ? AND document_id = ? AND task_id = ?
         AND event_type IN ('evaluation.revisions.exhausted', 'evaluation.revisions.extended')
       ORDER BY sequence`,
    )
    .all(scope.runId, scope.documentId, scope.taskId)
    .map((row) => EventEnvelopeConsumerSchema.parse(JSON.parse(row.event_json)))
}

function inferredBaseMaximum(events: readonly EventEnvelope[]): number {
  const firstExhaustion = events.find((event) => event.type === "evaluation.revisions.exhausted")
  if (!firstExhaustion) {
    throw recoveryConflict(
      "RALPH_REVISION_RECOVERY_EXHAUSTION_MISSING",
      "No judge revision exhaustion exists for this task",
    )
  }
  const parsed = ManualReviewExhaustionPayloadSchema.safeParse(firstExhaustion.payload)
  if (!parsed.success) {
    throw recoveryConflict(
      "RALPH_REVISION_RECOVERY_EXHAUSTION_INVALID",
      "The first judge revision exhaustion is not a valid manual-review exhaustion",
      { eventId: firstExhaustion.eventId },
    )
  }
  return parsed.data.baseMaximum ?? parsed.data.maximum
}

/**
 * Grants a bounded operational extension and atomically reopens one blocked
 * task. The immutable EffectiveRunOptions snapshot remains unchanged.
 */
export function grantJudgeRevisionAttempts(
  input: GrantJudgeRevisionAttemptsInput,
): JudgeRevisionGrantReceipt {
  const scope: JudgeRevisionScope = {
    runId: nonEmptyIdentity(input.runId, "runId"),
    documentId: nonEmptyIdentity(input.documentId, "documentId"),
    taskId: nonEmptyIdentity(input.taskId, "taskId"),
  }
  const additional = SafePositiveIntegerSchema.safeParse(input.additionalRevisions)
  if (!additional.success) {
    throw invalidInput(
      "RALPH_REVISION_RECOVERY_AMOUNT_INVALID",
      "additionalRevisions must be a positive safe integer",
    )
  }
  const reason = ReasonSchema.safeParse(input.reason)
  if (!reason.success) {
    throw invalidInput(
      "RALPH_REVISION_RECOVERY_REASON_INVALID",
      "A non-empty recovery reason no longer than 2000 characters is required",
    )
  }
  const source = RevisionRecoverySourceSchema.safeParse(input.source)
  if (!source.success) {
    throw invalidInput(
      "RALPH_REVISION_RECOVERY_SOURCE_INVALID",
      "Recovery source must be cli, tui, or api",
    )
  }
  const requestId =
    input.requestId === undefined ? undefined : RequestIdSchema.safeParse(input.requestId)
  if (requestId !== undefined && !requestId.success) {
    throw invalidInput(
      "RALPH_REVISION_RECOVERY_REQUEST_ID_INVALID",
      "requestId must be a safe non-empty identifier no longer than 200 characters",
    )
  }
  const grantedAt = TimestampSchema.safeParse((input.now ?? (() => new Date().toISOString()))())
  if (!grantedAt.success) {
    throw invalidInput(
      "RALPH_REVISION_RECOVERY_TIME_INVALID",
      "The revision recovery timestamp must be an ISO 8601 timestamp with an offset",
    )
  }
  const requestedReasonHash = reasonHash(reason.data)

  return withLedger(input.ledger, (database) => {
    const operation = database.transaction(() => {
      const events = storedRevisionEvents(database, scope)
      const baseMaximum = inferredBaseMaximum(events)
      const summary = judgeRevisionGrantSummary({ baseMaximum, events, scope })

      if (requestId?.data) {
        const prior = summary.grants.filter((grant) => grant.requestId === requestId.data)
        if (prior.length > 1) {
          throw recoveryConflict(
            "RALPH_REVISION_RECOVERY_IDEMPOTENCY_CONFLICT",
            "The requestId occurs more than once in the revision grant ledger",
            { requestId: requestId.data },
          )
        }
        const existing = prior[0]
        if (existing) {
          if (
            existing.additionalRevisions !== additional.data ||
            existing.source !== source.data ||
            existing.reasonHash !== requestedReasonHash
          ) {
            throw recoveryConflict(
              "RALPH_REVISION_RECOVERY_IDEMPOTENCY_CONFLICT",
              "The requestId was already used with different revision grant inputs",
              { requestId: requestId.data },
            )
          }
          return { ...existing, idempotent: true }
        }
      }

      const run = database
        .query<StoredRunRow, [string]>("SELECT workspace_id, status FROM runs WHERE id = ?")
        .get(scope.runId)
      if (!run) {
        throw recoveryConflict(
          "RALPH_REVISION_RECOVERY_RUN_NOT_FOUND",
          `Run does not exist: ${scope.runId}`,
        )
      }
      if (run.status !== "waiting") {
        throw recoveryConflict(
          "RALPH_REVISION_RECOVERY_RUN_NOT_WAITING",
          `Run ${scope.runId} must be waiting before a revision grant can be applied`,
          { status: run.status },
        )
      }
      const task = database
        .query<StoredTaskRow, [string, string, string]>(
          `SELECT status, active_attempt_id FROM run_tasks
           WHERE run_id = ? AND document_id = ? AND task_id = ?`,
        )
        .get(scope.runId, scope.documentId, scope.taskId)
      if (!task) {
        throw recoveryConflict(
          "RALPH_REVISION_RECOVERY_TASK_NOT_FOUND",
          `Task does not exist in run ${scope.runId}: ${scope.documentId}/${scope.taskId}`,
        )
      }
      if (task.status !== "blocked" || task.active_attempt_id !== null) {
        throw recoveryConflict(
          "RALPH_REVISION_RECOVERY_TASK_NOT_BLOCKED",
          "The task must be blocked with no active attempt before a revision grant can be applied",
          { status: task.status, activeAttemptId: task.active_attempt_id },
        )
      }

      const lastExhaustion = [...events]
        .reverse()
        .find((event) => event.type === "evaluation.revisions.exhausted")
      if (!lastExhaustion) {
        throw recoveryConflict(
          "RALPH_REVISION_RECOVERY_EXHAUSTION_MISSING",
          "The blocked task has no judge revision exhaustion to recover",
        )
      }
      const exhaustion = ManualReviewExhaustionPayloadSchema.safeParse(lastExhaustion.payload)
      if (!exhaustion.success) {
        throw recoveryConflict(
          "RALPH_REVISION_RECOVERY_POLICY_CONFLICT",
          "The latest judge revision exhaustion is not governed by manual-review",
          { eventId: lastExhaustion.eventId },
        )
      }
      const lastGrant = summary.grants.at(-1)
      if (lastGrant && lastGrant.sequence > lastExhaustion.sequence) {
        throw recoveryConflict(
          "RALPH_REVISION_RECOVERY_GRANT_ALREADY_APPLIED",
          "A revision grant already follows the latest manual-review exhaustion",
          { eventId: lastGrant.eventId },
        )
      }
      if (exhaustion.data.maximum !== summary.effectiveMaximum) {
        throw recoveryConflict(
          "RALPH_REVISION_RECOVERY_MAXIMUM_CONFLICT",
          "The latest exhaustion maximum does not match the durable revision grant chain",
          {
            exhaustionMaximum: exhaustion.data.maximum,
            durableMaximum: summary.effectiveMaximum,
          },
        )
      }

      const effectiveMaximum = safeAdd(summary.effectiveMaximum, additional.data)
      const payload: JudgeRevisionExtensionPayload = {
        schemaVersion: 1,
        previousMaximum: summary.effectiveMaximum,
        additionalRevisions: additional.data,
        effectiveMaximum,
        source: source.data,
        reason: reason.data,
        reasonHash: requestedReasonHash,
        exhaustionEventId: lastExhaustion.eventId,
        grantedAt: grantedAt.data,
        previousTaskStatus: "blocked",
        taskStatus: "eligible",
        ...(requestId?.data ? { requestId: requestId.data } : {}),
      }
      const extensionEvent = appendEventInTransaction(database, {
        type: "evaluation.revisions.extended",
        scope: "run",
        streamId: scope.runId,
        workspaceId: run.workspace_id,
        runId: scope.runId,
        documentId: scope.documentId,
        taskId: scope.taskId,
        level: "warn",
        causationId: lastExhaustion.eventId,
        payload,
      })
      const transition = database
        .query(
          `UPDATE run_tasks
           SET status = 'eligible', active_attempt_id = NULL, updated_at = ?
           WHERE run_id = ? AND document_id = ? AND task_id = ?
             AND status = 'blocked' AND active_attempt_id IS NULL`,
        )
        .run(grantedAt.data, scope.runId, scope.documentId, scope.taskId)
      if (transition.changes !== 1) {
        throw recoveryConflict(
          "RALPH_REVISION_RECOVERY_CONCURRENT_CONFLICT",
          "The task changed concurrently while the revision grant was being applied",
        )
      }
      database
        .query("UPDATE runs SET updated_at = ? WHERE id = ? AND status = 'waiting'")
        .run(grantedAt.data, scope.runId)
      appendEventInTransaction(database, {
        type: "task.revision_recovery.eligible",
        scope: "run",
        streamId: scope.runId,
        workspaceId: run.workspace_id,
        runId: scope.runId,
        documentId: scope.documentId,
        taskId: scope.taskId,
        causationId: extensionEvent.eventId,
        payload: {
          schemaVersion: 1,
          previousStatus: "blocked",
          status: "eligible",
          revisionExtensionEventId: extensionEvent.eventId,
          effectiveMaximum,
        },
      })
      const persisted = JudgeRevisionExtensionPayloadSchema.parse(extensionEvent.payload)
      return {
        ...persisted,
        eventId: extensionEvent.eventId,
        sequence: extensionEvent.sequence,
        idempotent: false,
      }
    })
    return operation.immediate()
  })
}
