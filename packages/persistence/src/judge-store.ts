import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import {
  EXIT_CODES,
  type JudgeAssessment,
  JudgeAssessmentSchema,
  RalphError,
} from "@ralph-next/domain"
import { type EventLevel, redactValue } from "@ralph-next/telemetry"
import { appendEventInTransaction, persistenceSecretValues, withLedger } from "./ledger"

const SHA256 = /^[a-f0-9]{64}$/
const MAX_JUDGE_ERROR_CHARACTERS = 65_536

type JudgeScopeRow = {
  run_id: string
  document_id: string
  task_id: string
  workspace_id: string
}

type JudgeCallRow = {
  id: string
  schema_version: number
  attempt_id: string
  ordinal: number
  transport_ordinal: number
  kind: "external" | "self"
  profile_id: string
  backend_id: string
  status: "started" | "succeeded" | "failed" | "cancelled"
  request_hash: string
  error_message: string | null
  started_at: string
  finished_at: string | null
}

type JudgeAssessmentRow = {
  id: string
  schema_version: number
  attempt_id: string
  evidence_bundle_id: string
  judge_call_id: string
  kind: "external" | "self"
  score: number
  content_hash: string
  content_ref: string | null
  assessment_json: string
  created_at: string
}

export type JudgeCallRecord = {
  schemaVersion: 1
  id: string
  attemptId: string
  ordinal: number
  transportOrdinal: number
  kind: "external" | "self"
  profileId: string
  backendId: string
  status: "started" | "succeeded" | "failed" | "cancelled"
  requestHash: string
  errorMessage?: string
  startedAt: string
  finishedAt?: string
}

export type JudgeAssessmentRecord = {
  schemaVersion: 1
  id: string
  attemptId: string
  evidenceBundleId: string
  judgeCallId: string
  kind: "external" | "self"
  score: number
  contentHash: string
  contentRef?: string
  assessment: JudgeAssessment
  createdAt: string
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error("Judge record contains a non-JSON value")
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function boundedError(value: string): string {
  const characters = [...value]
  if (characters.length <= MAX_JUDGE_ERROR_CHARACTERS) return value
  const suffix = "\n[truncated]"
  return `${characters.slice(0, MAX_JUDGE_ERROR_CHARACTERS - [...suffix].length).join("")}${suffix}`
}

function callFromRow(row: JudgeCallRow): JudgeCallRecord {
  if (row.schema_version !== 1) {
    throw new Error(`Unsupported judge call schema version: ${row.schema_version}`)
  }
  return {
    schemaVersion: 1,
    id: row.id,
    attemptId: row.attempt_id,
    ordinal: row.ordinal,
    transportOrdinal: row.transport_ordinal,
    kind: row.kind,
    profileId: row.profile_id,
    backendId: row.backend_id,
    status: row.status,
    requestHash: row.request_hash,
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  }
}

function assessmentFromRow(row: JudgeAssessmentRow): JudgeAssessmentRecord {
  if (row.schema_version !== 1) {
    throw new Error(`Unsupported judge assessment schema version: ${row.schema_version}`)
  }
  return {
    schemaVersion: 1,
    id: row.id,
    attemptId: row.attempt_id,
    evidenceBundleId: row.evidence_bundle_id,
    judgeCallId: row.judge_call_id,
    kind: row.kind,
    score: row.score,
    contentHash: row.content_hash,
    ...(row.content_ref ? { contentRef: row.content_ref } : {}),
    assessment: JudgeAssessmentSchema.parse(JSON.parse(row.assessment_json)),
    createdAt: row.created_at,
  }
}

function scopeForAttempt(database: Database, attemptId: string): JudgeScopeRow {
  const scope = database
    .query<JudgeScopeRow, [string]>(
      `SELECT attempts.run_id, attempts.document_id, attempts.task_id, runs.workspace_id
       FROM attempts
       JOIN runs ON runs.id = attempts.run_id
       WHERE attempts.id = ?`,
    )
    .get(attemptId)
  if (!scope) {
    throw new RalphError("RALPH_ATTEMPT_NOT_FOUND", `Attempt not found: ${attemptId}`, {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  return scope
}

function appendJudgeEvent(
  database: Database,
  scope: JudgeScopeRow,
  attemptId: string,
  type: string,
  callId: string,
  payload: Record<string, unknown>,
  level: EventLevel = "info",
): void {
  appendEventInTransaction(database, {
    type,
    scope: "run",
    streamId: scope.run_id,
    workspaceId: scope.workspace_id,
    runId: scope.run_id,
    documentId: scope.document_id,
    taskId: scope.task_id,
    attemptId,
    callId,
    level,
    payload,
  })
}

export function createJudgeCall(
  path: string,
  input: {
    id: string
    attemptId: string
    ordinal: number
    transportOrdinal: number
    kind: "external" | "self"
    profileId: string
    backendId: string
    requestHash: string
    startedAt?: string
  },
): JudgeCallRecord {
  if (!SHA256.test(input.requestHash)) throw new Error("Judge request hash must be SHA-256")
  return withLedger(path, (database) =>
    database.transaction(() => {
      const scope = scopeForAttempt(database, input.attemptId)
      const existing = database
        .query<JudgeCallRow, [string]>("SELECT * FROM judge_calls WHERE id = ?")
        .get(input.id)
      if (existing) {
        const replayMatches =
          existing.attempt_id === input.attemptId &&
          existing.ordinal === input.ordinal &&
          existing.transport_ordinal === input.transportOrdinal &&
          existing.kind === input.kind &&
          existing.profile_id === input.profileId &&
          existing.backend_id === input.backendId &&
          existing.request_hash === input.requestHash &&
          (input.startedAt === undefined || existing.started_at === input.startedAt)
        if (replayMatches) return callFromRow(existing)
        throw new Error(`Judge call id is already bound to different immutable data: ${input.id}`)
      }
      const startedAt = input.startedAt ?? new Date().toISOString()
      database
        .query(
          `INSERT INTO judge_calls(
             id, schema_version, attempt_id, ordinal, transport_ordinal, kind, profile_id,
             backend_id, status, request_hash, started_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'started', ?, ?)`,
        )
        .run(
          input.id,
          input.attemptId,
          input.ordinal,
          input.transportOrdinal,
          input.kind,
          input.profileId,
          input.backendId,
          input.requestHash,
          startedAt,
        )
      appendJudgeEvent(database, scope, input.attemptId, "judge.call.started", input.id, {
        kind: input.kind,
        profileId: input.profileId,
        backendId: input.backendId,
        ordinal: input.ordinal,
        transportOrdinal: input.transportOrdinal,
        requestHash: input.requestHash,
      })
      const row = database
        .query<JudgeCallRow, [string]>("SELECT * FROM judge_calls WHERE id = ?")
        .get(input.id)
      if (!row) throw new Error(`Judge call disappeared after insert: ${input.id}`)
      return callFromRow(row)
    })(),
  )
}

export function listJudgeCalls(path: string, attemptId: string): JudgeCallRecord[] {
  return withLedger(path, (database) =>
    database
      .query<JudgeCallRow, [string]>(
        `SELECT * FROM judge_calls
         WHERE attempt_id = ?
         ORDER BY ordinal ASC, transport_ordinal ASC, id ASC`,
      )
      .all(attemptId)
      .map(callFromRow),
  )
}

export function finishJudgeCall(
  path: string,
  input: {
    id: string
    status: "succeeded" | "failed" | "cancelled"
    errorMessage?: string
    finishedAt?: string
  },
): JudgeCallRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const current = database
        .query<JudgeCallRow, [string]>("SELECT * FROM judge_calls WHERE id = ?")
        .get(input.id)
      if (!current) throw new Error(`Judge call not found: ${input.id}`)
      if (input.status === "succeeded" && input.errorMessage) {
        throw new Error("A succeeded judge call cannot persist an error message")
      }
      const safeError = input.errorMessage
        ? boundedError(String(redactValue(input.errorMessage, persistenceSecretValues(database))))
        : undefined
      if (current.status !== "started") {
        if (current.status === input.status) {
          if (
            (input.finishedAt !== undefined && current.finished_at !== input.finishedAt) ||
            (safeError !== undefined && current.error_message !== safeError)
          ) {
            throw new Error(`Judge call ${input.id} replay conflicts with its immutable result`)
          }
          return callFromRow(current)
        }
        throw new Error(`Judge call ${input.id} is already ${current.status}`)
      }
      const scope = scopeForAttempt(database, current.attempt_id)
      const finishedAt = input.finishedAt ?? new Date().toISOString()
      database
        .query(
          `UPDATE judge_calls
           SET status = ?, error_message = ?, finished_at = ?
           WHERE id = ? AND status = 'started'`,
        )
        .run(input.status, safeError ?? null, finishedAt, input.id)
      appendJudgeEvent(
        database,
        scope,
        current.attempt_id,
        "judge.call.finished",
        input.id,
        { status: input.status, ...(safeError ? { error: safeError } : {}) },
        input.status === "succeeded" ? "info" : "error",
      )
      const row = database
        .query<JudgeCallRow, [string]>("SELECT * FROM judge_calls WHERE id = ?")
        .get(input.id)
      if (!row) throw new Error(`Judge call disappeared after update: ${input.id}`)
      return callFromRow(row)
    })(),
  )
}

export function persistJudgeAssessment(
  path: string,
  input: {
    attemptId: string
    judgeCallId: string
    assessment: JudgeAssessment
    contentRef?: string
  },
): JudgeAssessmentRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const scope = scopeForAttempt(database, input.attemptId)
      if (
        input.contentRef !== undefined &&
        (input.contentRef.trim().length === 0 ||
          input.contentRef.length > 4096 ||
          [...input.contentRef].some((character) => {
            const code = character.codePointAt(0)
            return code !== undefined && (code < 32 || (code >= 127 && code <= 159))
          }))
      ) {
        throw new Error("Judge assessment content reference is invalid")
      }
      const call = database
        .query<JudgeCallRow, [string]>("SELECT * FROM judge_calls WHERE id = ?")
        .get(input.judgeCallId)
      if (!call || call.attempt_id !== input.attemptId || call.status !== "succeeded") {
        throw new Error("Judge assessment requires a succeeded call from the same attempt")
      }
      const redacted = JudgeAssessmentSchema.parse(
        redactValue(input.assessment, persistenceSecretValues(database)),
      )
      if (redacted.kind !== call.kind) throw new Error("Judge assessment kind does not match call")
      const evidence = database
        .query<{ attempt_id: string }, [string]>(
          "SELECT attempt_id FROM evidence_bundles WHERE id = ?",
        )
        .get(redacted.evidenceBundleId)
      if (!evidence || evidence.attempt_id !== input.attemptId) {
        throw new Error("Judge assessment evidence does not belong to the same attempt")
      }
      const assessmentJson = stableJson(redacted)
      const contentHash = sha256(assessmentJson)
      const existing = database
        .query<JudgeAssessmentRow, [string]>("SELECT * FROM judge_assessments WHERE id = ?")
        .get(redacted.id)
      if (existing) {
        const replayMatches =
          existing.attempt_id === input.attemptId &&
          existing.evidence_bundle_id === redacted.evidenceBundleId &&
          existing.judge_call_id === input.judgeCallId &&
          existing.kind === redacted.kind &&
          existing.score === redacted.score &&
          existing.content_hash === contentHash &&
          existing.content_ref === (input.contentRef ?? null) &&
          existing.assessment_json === assessmentJson &&
          existing.created_at === redacted.createdAt
        if (replayMatches) return assessmentFromRow(existing)
        throw new Error(
          `Judge assessment id is already bound to different immutable data: ${redacted.id}`,
        )
      }
      database
        .query(
          `INSERT INTO judge_assessments(
             id, schema_version, attempt_id, evidence_bundle_id, judge_call_id, kind, score,
             content_hash, content_ref, assessment_json, created_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          redacted.id,
          input.attemptId,
          redacted.evidenceBundleId,
          input.judgeCallId,
          redacted.kind,
          redacted.score,
          contentHash,
          input.contentRef ?? null,
          assessmentJson,
          redacted.createdAt,
        )
      appendJudgeEvent(
        database,
        scope,
        input.attemptId,
        "judge.assessment.persisted",
        input.judgeCallId,
        {
          assessmentId: redacted.id,
          evidenceBundleId: redacted.evidenceBundleId,
          kind: redacted.kind,
          score: redacted.score,
          contentHash,
          assessment: redacted,
          ...(input.contentRef ? { contentRef: input.contentRef } : {}),
        },
      )
      const row = database
        .query<JudgeAssessmentRow, [string]>("SELECT * FROM judge_assessments WHERE id = ?")
        .get(redacted.id)
      if (!row) throw new Error(`Judge assessment disappeared after insert: ${redacted.id}`)
      return assessmentFromRow(row)
    })(),
  )
}

export function getJudgeAssessmentForAttempt(
  path: string,
  attemptId: string,
): JudgeAssessmentRecord | undefined {
  return withLedger(path, (database) => {
    const row = database
      .query<JudgeAssessmentRow, [string]>("SELECT * FROM judge_assessments WHERE attempt_id = ?")
      .get(attemptId)
    return row ? assessmentFromRow(row) : undefined
  })
}

export function listJudgeAssessments(
  path: string,
  input: { runId: string; documentId?: string; taskId?: string },
): JudgeAssessmentRecord[] {
  return withLedger(path, (database) => {
    const rows = database
      .query<
        JudgeAssessmentRow,
        [string, string | null, string | null, string | null, string | null]
      >(
        `SELECT judge_assessments.*
         FROM judge_assessments
         JOIN attempts ON attempts.id = judge_assessments.attempt_id
         WHERE attempts.run_id = ?
           AND (? IS NULL OR attempts.document_id = ?)
           AND (? IS NULL OR attempts.task_id = ?)
         ORDER BY attempts.ordinal, judge_assessments.created_at, judge_assessments.id`,
      )
      .all(
        input.runId,
        input.documentId ?? null,
        input.documentId ?? null,
        input.taskId ?? null,
        input.taskId ?? null,
      )
    return rows.map(assessmentFromRow)
  })
}
