import type { Database } from "bun:sqlite"
import {
  EXIT_CODES,
  RalphError,
  type SandboxSessionRecord,
  SandboxSessionRecordSchema,
} from "@ralph/domain"
import { appendEventInTransaction, withLedger } from "./ledger"

type SandboxRow = {
  id: string
  workspace_id: string
  run_id: string
  task_id: string
  attempt_id: string
  worker_id: string
  backend: string
  status: string
  revision: number
  record_json: string
  created_at: string
  updated_at: string
}

const SANDBOX_COLUMNS = `id, workspace_id, run_id, task_id, attempt_id, worker_id,
  backend, status, revision, record_json, created_at, updated_at`

function sessionFromRow(row: SandboxRow): SandboxSessionRecord {
  try {
    const record = SandboxSessionRecordSchema.parse(JSON.parse(row.record_json) as unknown)
    if (
      record.id !== row.id ||
      record.workspaceId !== row.workspace_id ||
      record.runId !== row.run_id ||
      record.taskId !== row.task_id ||
      record.attemptId !== row.attempt_id ||
      record.workerId !== row.worker_id ||
      record.backend !== row.backend ||
      record.status !== row.status ||
      record.revision !== row.revision ||
      record.createdAt !== row.created_at ||
      record.updatedAt !== row.updated_at
    ) {
      throw new Error("columns do not match record")
    }
    return record
  } catch (error) {
    throw new RalphError(
      "RALPH_SANDBOX_LEDGER_INVALID",
      `Sandbox session ${row.id} is inconsistent in the ledger`,
      { exitCode: EXIT_CODES.conflict, cause: error },
    )
  }
}

function sandboxRow(database: Database, id: string): SandboxRow | undefined {
  return (
    database
      .query<SandboxRow, [string]>(`SELECT ${SANDBOX_COLUMNS} FROM sandbox_sessions WHERE id = ?`)
      .get(id) ?? undefined
  )
}

function sandboxEvent(
  database: Database,
  record: SandboxSessionRecord,
  type: string,
  payload: Record<string, unknown>,
): void {
  appendEventInTransaction(database, {
    type,
    scope: "run",
    streamId: record.runId,
    workspaceId: record.workspaceId,
    runId: record.runId,
    taskId: record.taskId,
    attemptId: record.attemptId,
    workerId: record.workerId,
    payload: {
      schemaVersion: 1,
      sandboxSessionId: record.id,
      backend: record.backend,
      status: record.status,
      revision: record.revision,
      ...payload,
    },
  })
}

export function createSandboxSessionRecord(
  path: string,
  input: SandboxSessionRecord,
): SandboxSessionRecord {
  const record = SandboxSessionRecordSchema.parse(input)
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const existing = sandboxRow(database, record.id)
      if (existing) {
        const parsed = sessionFromRow(existing)
        if (JSON.stringify(parsed) === JSON.stringify(record)) return parsed
        throw new RalphError("RALPH_SANDBOX_SESSION_ID_REUSED", "Sandbox session ID was reused", {
          exitCode: EXIT_CODES.conflict,
          details: { sandboxSessionId: record.id },
        })
      }
      database
        .query(
          `INSERT INTO sandbox_sessions(
             id, workspace_id, run_id, task_id, attempt_id, worker_id, backend,
             status, revision, record_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.workspaceId,
          record.runId,
          record.taskId,
          record.attemptId,
          record.workerId,
          record.backend,
          record.status,
          record.revision,
          JSON.stringify(record),
          record.createdAt,
          record.updatedAt,
        )
      sandboxEvent(database, record, "sandbox.session.created", {
        capability: record.capability,
        specHash: record.specHash,
      })
      return record
    })
    return operation.immediate()
  })
}

const TRANSITIONS: Readonly<
  Record<SandboxSessionRecord["status"], readonly SandboxSessionRecord["status"][]>
> = {
  preparing: ["ready", "failed"],
  ready: ["running", "stopped", "failed"],
  running: ["stopped", "failed", "orphaned"],
  stopped: ["stopped"],
  failed: ["stopped"],
  orphaned: ["stopped", "failed"],
}

export function transitionSandboxSessionRecord(
  path: string,
  id: string,
  expectedRevision: number,
  update: {
    status: SandboxSessionRecord["status"]
    backendResourceId?: string
    terminationConfirmed?: boolean
    failureReason?: string
    updatedAt?: string
  },
): SandboxSessionRecord {
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const row = sandboxRow(database, id)
      if (!row) {
        throw new RalphError("RALPH_SANDBOX_SESSION_NOT_FOUND", "Sandbox session was not found", {
          exitCode: EXIT_CODES.notFound,
          details: { sandboxSessionId: id },
        })
      }
      const current = sessionFromRow(row)
      if (current.revision !== expectedRevision) {
        throw new RalphError("RALPH_SANDBOX_SESSION_CHANGED", "Sandbox session changed", {
          exitCode: EXIT_CODES.conflict,
          details: { id, expectedRevision, observedRevision: current.revision },
        })
      }
      if (!TRANSITIONS[current.status].includes(update.status)) {
        throw new RalphError(
          "RALPH_SANDBOX_SESSION_TRANSITION_INVALID",
          `Sandbox session cannot transition from ${current.status} to ${update.status}`,
          { exitCode: EXIT_CODES.conflict, details: { id } },
        )
      }
      const next = SandboxSessionRecordSchema.parse({
        ...current,
        status: update.status,
        revision: current.revision + 1,
        updatedAt: update.updatedAt ?? new Date().toISOString(),
        ...(update.backendResourceId ? { backendResourceId: update.backendResourceId } : {}),
        ...(update.terminationConfirmed !== undefined
          ? { terminationConfirmed: update.terminationConfirmed }
          : {}),
        ...(update.failureReason ? { failureReason: update.failureReason } : {}),
      })
      const changed = database
        .query(
          `UPDATE sandbox_sessions SET status = ?, revision = ?, record_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(next.status, next.revision, JSON.stringify(next), next.updatedAt, id, expectedRevision)
      if (changed.changes !== 1) {
        throw new RalphError(
          "RALPH_SANDBOX_SESSION_CHANGED",
          "Sandbox session changed concurrently",
          {
            exitCode: EXIT_CODES.conflict,
            details: { id, expectedRevision },
          },
        )
      }
      sandboxEvent(database, next, "sandbox.session.transitioned", {
        previousStatus: current.status,
        status: next.status,
        ...(next.backendResourceId ? { backendResourceId: next.backendResourceId } : {}),
        ...(next.terminationConfirmed !== undefined
          ? { terminationConfirmed: next.terminationConfirmed }
          : {}),
        ...(next.failureReason ? { failureReason: next.failureReason } : {}),
      })
      return next
    })
    return operation.immediate()
  })
}

export function readSandboxSessionRecord(
  path: string,
  id: string,
): SandboxSessionRecord | undefined {
  return withLedger(path, (database) => {
    const row = sandboxRow(database, id)
    return row ? sessionFromRow(row) : undefined
  })
}

export const SANDBOX_SESSION_PAGE_MAX_SIZE = 256

export type SandboxSessionCursor = {
  /** Exclusive keyset boundary in the same descending order used by the query. */
  createdAt: string
  id: string
}

export type SandboxSessionPage = {
  records: SandboxSessionRecord[]
  exhausted: boolean
  nextCursor?: SandboxSessionCursor
}

export type SandboxSessionPageQuery = {
  /** Required so a caller cannot accidentally sweep or mix independent workspaces. */
  workspaceId: string
  runId?: string
  workerId?: string
  status?: SandboxSessionRecord["status"]
  cursor?: SandboxSessionCursor
  limit?: number
}

function assertSandboxPageText(value: string, field: string): void {
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new RalphError(
      "RALPH_SANDBOX_PAGE_QUERY_INVALID",
      `Sandbox session page ${field} must be a non-empty single-line value`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
}

/**
 * Reads one bounded keyset page. The `(created_at, id)` tuple is unique because
 * `id` is the table primary key, so a consumer can exhaust the workspace without
 * an offset race or a silent total-result cap.
 */
export function listSandboxSessionRecordPage(
  path: string,
  query: SandboxSessionPageQuery,
): SandboxSessionPage {
  assertSandboxPageText(query.workspaceId, "workspaceId")
  if (query.runId !== undefined) assertSandboxPageText(query.runId, "runId")
  if (query.workerId !== undefined) assertSandboxPageText(query.workerId, "workerId")

  const limit = query.limit ?? SANDBOX_SESSION_PAGE_MAX_SIZE
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > SANDBOX_SESSION_PAGE_MAX_SIZE) {
    throw new RalphError(
      "RALPH_SANDBOX_PAGE_LIMIT_INVALID",
      `Sandbox session page limit must be between 1 and ${SANDBOX_SESSION_PAGE_MAX_SIZE}`,
      { exitCode: EXIT_CODES.invalidUsage, details: { limit } },
    )
  }

  if (query.cursor) {
    assertSandboxPageText(query.cursor.id, "cursor.id")
    assertSandboxPageText(query.cursor.createdAt, "cursor.createdAt")
    if (Number.isNaN(Date.parse(query.cursor.createdAt))) {
      throw new RalphError(
        "RALPH_SANDBOX_PAGE_CURSOR_INVALID",
        "Sandbox session page cursor.createdAt must be a valid ISO timestamp",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
  }

  const conditions = ["workspace_id = ?"]
  const bindings = [query.workspaceId]
  if (query.runId !== undefined) {
    conditions.push("run_id = ?")
    bindings.push(query.runId)
  }
  if (query.workerId !== undefined) {
    conditions.push("worker_id = ?")
    bindings.push(query.workerId)
  }
  if (query.status !== undefined) {
    conditions.push("status = ?")
    bindings.push(query.status)
  }
  if (query.cursor) {
    conditions.push("(created_at < ? OR (created_at = ? AND id < ?))")
    bindings.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
  }

  return withLedger(path, (database) => {
    const rows = database
      .query<SandboxRow, string[]>(
        `SELECT ${SANDBOX_COLUMNS} FROM sandbox_sessions
         WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
      )
      .all(...bindings)
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const records = pageRows.map(sessionFromRow)
    const last = pageRows.at(-1)
    return {
      records,
      exhausted: !hasMore,
      ...(hasMore && last ? { nextCursor: { createdAt: last.created_at, id: last.id } } : {}),
    }
  })
}

export function listSandboxSessionRecords(
  path: string,
  query: {
    workspaceId?: string
    runId?: string
    workerId?: string
    status?: SandboxSessionRecord["status"]
    limit?: number
  } = {},
): SandboxSessionRecord[] {
  const conditions: string[] = []
  const bindings: string[] = []
  if (query.workspaceId) {
    conditions.push("workspace_id = ?")
    bindings.push(query.workspaceId)
  }
  if (query.runId) {
    conditions.push("run_id = ?")
    bindings.push(query.runId)
  }
  if (query.workerId) {
    conditions.push("worker_id = ?")
    bindings.push(query.workerId)
  }
  if (query.status) {
    conditions.push("status = ?")
    bindings.push(query.status)
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000)
  return withLedger(path, (database) =>
    database
      .query<SandboxRow, string[]>(
        `SELECT ${SANDBOX_COLUMNS} FROM sandbox_sessions
         ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
      )
      .all(...bindings)
      .map(sessionFromRow),
  )
}
