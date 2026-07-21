import type { Database } from "bun:sqlite"

import {
  type CommandOperation,
  type CommandOperationReport,
  CommandOperationReportSchema,
  type CommandOperationRequest,
  CommandOperationRequestSchema,
  CommandOperationSchema,
  commandOperationRequestHash,
  EXIT_CODES,
  RalphError,
} from "@ralph/domain"
import { appendEventInTransaction, withLedger } from "./ledger"

const MAX_ERROR_CHARACTERS = 65_536

type CommandOperationRow = {
  id: string
  schema_version: number
  command: "verify" | "judge"
  status: "started" | "succeeded" | "failed" | "cancelled"
  request_hash: string
  request_json: string
  report_json: string | null
  error_code: string | null
  error_message: string | null
  started_at: string
  finished_at: string | null
}

export type CommandOperationQuery = {
  command?: "verify" | "judge"
  runId?: string
  documentId?: string
  taskId?: string
  attemptId?: string
  evidenceBundleId?: string
  status?: CommandOperation["status"]
  limit?: number
}

function boundedError(value: string): string {
  const characters = [...value]
  if (characters.length <= MAX_ERROR_CHARACTERS) return value
  return `${characters.slice(0, MAX_ERROR_CHARACTERS - 12).join("")}\n[truncated]`
}

function operationFromRow(row: CommandOperationRow): CommandOperation {
  return CommandOperationSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    command: row.command,
    status: row.status,
    request: JSON.parse(row.request_json),
    requestHash: row.request_hash,
    ...(row.report_json ? { report: JSON.parse(row.report_json) } : {}),
    ...(row.error_code && row.error_message
      ? { error: { code: row.error_code, message: row.error_message } }
      : {}),
    startedAt: row.started_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  })
}

function scopeForRequest(
  database: Database,
  request: CommandOperationRequest,
): {
  workspaceId: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
} {
  const row = database
    .query<
      { workspace_id: string; run_id: string; document_id: string; task_id: string },
      [string]
    >(
      `SELECT runs.workspace_id, attempts.run_id, attempts.document_id, attempts.task_id
       FROM attempts JOIN runs ON runs.id = attempts.run_id WHERE attempts.id = ?`,
    )
    .get(request.selection.attemptId)
  if (!row) {
    throw new RalphError(
      "RALPH_COMMAND_EVIDENCE_ATTEMPT_NOT_FOUND",
      `Selected attempt was not found: ${request.selection.attemptId}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (
    row.workspace_id !== request.selection.workspaceId ||
    row.run_id !== request.selection.runId ||
    row.document_id !== request.selection.documentId ||
    row.task_id !== request.selection.taskId
  ) {
    throw new RalphError(
      "RALPH_COMMAND_EVIDENCE_SELECTION_MISMATCH",
      "Resolved command selection does not match its persisted run/attempt scope",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  if (request.selection.source === "execution-evidence") {
    const evidence = database
      .query<{ attempt_id: string; content_hash: string }, [string]>(
        "SELECT attempt_id, content_hash FROM evidence_bundles WHERE id = ?",
      )
      .get(request.selection.evidenceBundleId)
    if (
      !evidence ||
      evidence.attempt_id !== request.selection.attemptId ||
      evidence.content_hash !== request.selection.evidenceContentHash
    ) {
      throw new RalphError(
        "RALPH_COMMAND_EXECUTION_EVIDENCE_MISMATCH",
        "Command selection does not match an immutable execution evidence bundle",
        { exitCode: EXIT_CODES.conflict },
      )
    }
  } else {
    const verificationId = request.selection.verificationOperationId
    const verificationRow = verificationId
      ? database
          .query<CommandOperationRow, [string]>("SELECT * FROM command_operations WHERE id = ?")
          .get(verificationId)
      : undefined
    const verification = verificationRow ? operationFromRow(verificationRow) : undefined
    if (
      !verification ||
      verification.command !== "verify" ||
      verification.status !== "succeeded" ||
      verification.report?.command !== "verify" ||
      verification.report.evidence.id !== request.selection.evidenceBundleId ||
      verification.report.evidence.contentHash !== request.selection.evidenceContentHash ||
      verification.report.evidence.attemptId !== request.selection.attemptId
    ) {
      throw new RalphError(
        "RALPH_COMMAND_VERIFICATION_EVIDENCE_MISMATCH",
        "Command selection does not match a completed immutable verification operation",
        { exitCode: EXIT_CODES.conflict },
      )
    }
  }
  return {
    workspaceId: row.workspace_id,
    runId: row.run_id,
    documentId: row.document_id,
    taskId: row.task_id,
    attemptId: request.selection.attemptId,
  }
}

function appendOperationEvent(
  database: Database,
  scope: ReturnType<typeof scopeForRequest>,
  operationId: string,
  type: string,
  payload: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
): void {
  appendEventInTransaction(database, {
    type,
    scope: "run",
    streamId: scope.runId,
    workspaceId: scope.workspaceId,
    runId: scope.runId,
    documentId: scope.documentId,
    taskId: scope.taskId,
    attemptId: scope.attemptId,
    correlationId: operationId,
    level,
    payload: { operationId, ...payload },
  })
}

export function createCommandOperation(
  path: string,
  input: { id: string; request: CommandOperationRequest; startedAt?: string },
): CommandOperation {
  const request = CommandOperationRequestSchema.parse(input.request)
  const requestHash = commandOperationRequestHash(request)
  return withLedger(path, (database) =>
    database.transaction(() => {
      const scope = scopeForRequest(database, request)
      const existing = database
        .query<CommandOperationRow, [string]>("SELECT * FROM command_operations WHERE id = ?")
        .get(input.id)
      if (existing) {
        const operation = operationFromRow(existing)
        if (operation.requestHash === requestHash && operation.status === "started")
          return operation
        throw new RalphError(
          "RALPH_COMMAND_OPERATION_ID_CONFLICT",
          `Command operation ID is already bound: ${input.id}`,
          { exitCode: EXIT_CODES.conflict },
        )
      }
      const startedAt = input.startedAt ?? new Date().toISOString()
      database
        .query(
          `INSERT INTO command_operations(
             id, schema_version, command, status, run_id, document_id, task_id, attempt_id,
             evidence_bundle_id, request_hash, request_json, started_at, updated_at
           ) VALUES (?, 1, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          request.command,
          scope.runId,
          scope.documentId,
          scope.taskId,
          scope.attemptId,
          request.selection.evidenceBundleId,
          requestHash,
          JSON.stringify(request),
          startedAt,
          startedAt,
        )
      appendOperationEvent(database, scope, input.id, `${request.command}.command.started`, {
        requestHash,
        evidenceBundleId: request.selection.evidenceBundleId,
        source: request.selection.source,
      })
      const row = database
        .query<CommandOperationRow, [string]>("SELECT * FROM command_operations WHERE id = ?")
        .get(input.id)
      if (!row) throw new Error(`Command operation disappeared after insert: ${input.id}`)
      return operationFromRow(row)
    })(),
  )
}

export function finishCommandOperation(
  path: string,
  input: { id: string; report: CommandOperationReport; finishedAt?: string },
): CommandOperation {
  const report = CommandOperationReportSchema.parse(input.report)
  return withLedger(path, (database) =>
    database.transaction(() => {
      const currentRow = database
        .query<CommandOperationRow, [string]>("SELECT * FROM command_operations WHERE id = ?")
        .get(input.id)
      if (!currentRow) {
        throw new RalphError(
          "RALPH_COMMAND_OPERATION_NOT_FOUND",
          `Operation not found: ${input.id}`,
          {
            exitCode: EXIT_CODES.invalidUsage,
          },
        )
      }
      const current = operationFromRow(currentRow)
      if (current.command !== report.command || report.operationId !== current.id) {
        throw new RalphError(
          "RALPH_COMMAND_OPERATION_REPORT_MISMATCH",
          "Command report does not match its durable operation",
          { exitCode: EXIT_CODES.conflict },
        )
      }
      if (current.status !== "started") {
        if (
          current.status === "succeeded" &&
          JSON.stringify(current.report) === JSON.stringify(report)
        ) {
          return current
        }
        throw new RalphError(
          "RALPH_COMMAND_OPERATION_ALREADY_FINISHED",
          `Operation is already terminal: ${input.id}`,
          { exitCode: EXIT_CODES.conflict },
        )
      }
      const finishedAt = input.finishedAt ?? report.finishedAt
      database
        .query(
          `UPDATE command_operations SET status = 'succeeded', report_json = ?,
             finished_at = ?, updated_at = ? WHERE id = ? AND status = 'started'`,
        )
        .run(JSON.stringify(report), finishedAt, finishedAt, input.id)
      const scope = scopeForRequest(database, current.request)
      appendOperationEvent(database, scope, input.id, `${current.command}.command.finished`, {
        reportId: report.id,
        status: report.status,
        contentHash: report.contentHash,
        sourceEvidenceBundleId: report.selection.evidenceBundleId,
        outputEvidenceBundleId:
          report.command === "verify" ? report.evidence.id : report.selection.evidenceBundleId,
        ...(report.command === "judge" ? { assessmentId: report.assessment.id } : {}),
      })
      const row = database
        .query<CommandOperationRow, [string]>("SELECT * FROM command_operations WHERE id = ?")
        .get(input.id)
      if (!row) throw new Error(`Command operation disappeared after finish: ${input.id}`)
      return operationFromRow(row)
    })(),
  )
}

export function failCommandOperation(
  path: string,
  input: {
    id: string
    code: string
    message: string
    cancelled?: boolean
    finishedAt?: string
  },
): CommandOperation {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const row = database
        .query<CommandOperationRow, [string]>("SELECT * FROM command_operations WHERE id = ?")
        .get(input.id)
      if (!row) {
        throw new RalphError(
          "RALPH_COMMAND_OPERATION_NOT_FOUND",
          `Operation not found: ${input.id}`,
          {
            exitCode: EXIT_CODES.invalidUsage,
          },
        )
      }
      const current = operationFromRow(row)
      if (current.status !== "started") return current
      const finishedAt = input.finishedAt ?? new Date().toISOString()
      const status = input.cancelled ? "cancelled" : "failed"
      const message = boundedError(input.message)
      database
        .query(
          `UPDATE command_operations SET status = ?, error_code = ?, error_message = ?,
             finished_at = ?, updated_at = ? WHERE id = ? AND status = 'started'`,
        )
        .run(status, input.code, message, finishedAt, finishedAt, input.id)
      const scope = scopeForRequest(database, current.request)
      appendOperationEvent(
        database,
        scope,
        input.id,
        `${current.command}.command.${status}`,
        { code: input.code, message },
        status === "cancelled" ? "warn" : "error",
      )
      const updated = database
        .query<CommandOperationRow, [string]>("SELECT * FROM command_operations WHERE id = ?")
        .get(input.id)
      if (!updated) throw new Error(`Command operation disappeared after failure: ${input.id}`)
      return operationFromRow(updated)
    })(),
  )
}

export function getCommandOperation(path: string, id: string): CommandOperation | undefined {
  return withLedger(path, (database) => {
    const row = database
      .query<CommandOperationRow, [string]>("SELECT * FROM command_operations WHERE id = ?")
      .get(id)
    return row ? operationFromRow(row) : undefined
  })
}

export function listCommandOperations(
  path: string,
  query: CommandOperationQuery = {},
): CommandOperation[] {
  const limit = query.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Command operation query limit must be between 1 and 1000")
  }
  return withLedger(path, (database) =>
    database
      .query<
        CommandOperationRow,
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          number,
        ]
      >(
        `SELECT * FROM command_operations
         WHERE (? = '' OR command = ?)
           AND (? = '' OR run_id = ?)
           AND (? = '' OR document_id = ?)
           AND (? = '' OR task_id = ?)
           AND (? = '' OR attempt_id = ?)
           AND (? = '' OR evidence_bundle_id = ?)
           AND (? = '' OR status = ?)
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(
        query.command ?? "",
        query.command ?? "",
        query.runId ?? "",
        query.runId ?? "",
        query.documentId ?? "",
        query.documentId ?? "",
        query.taskId ?? "",
        query.taskId ?? "",
        query.attemptId ?? "",
        query.attemptId ?? "",
        query.evidenceBundleId ?? "",
        query.evidenceBundleId ?? "",
        query.status ?? "",
        query.status ?? "",
        limit,
      )
      .map(operationFromRow),
  )
}
