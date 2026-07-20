import type { Database } from "bun:sqlite"
import {
  EXIT_CODES,
  type GitIntegrationRecord,
  GitIntegrationRecordSchema,
  type GitIntegrationStatus,
  type GitWorktreeRecord,
  GitWorktreeRecordSchema,
  type GitWorktreeStatus,
  RalphError,
} from "@ralph-next/domain"
import { appendEventInTransaction, withLedger } from "./ledger"

type GitWorktreeRow = {
  id: string
  workspace_id: string
  run_id: string
  task_id: string
  attempt_id: string
  status: string
  revision: number
  record_json: string
  created_at: string
  updated_at: string
}

type GitIntegrationRow = {
  id: string
  workspace_id: string
  run_id: string
  worktree_id: string
  task_id: string
  integration_order: number
  status: string
  revision: number
  record_json: string
  created_at: string
  updated_at: string
}

const WORKTREE_COLUMNS = `id, workspace_id, run_id, task_id, attempt_id, status, revision,
  record_json, created_at, updated_at`
const INTEGRATION_COLUMNS = `id, workspace_id, run_id, worktree_id, task_id,
  integration_order, status, revision, record_json, created_at, updated_at`

function parseRecord<T>(
  value: string,
  parse: (input: unknown) => T,
  entity: string,
  id: string,
): T {
  try {
    return parse(JSON.parse(value) as unknown)
  } catch (error) {
    throw new RalphError("RALPH_GIT_STATE_INVALID", `Persisted ${entity} ${id} is invalid`, {
      exitCode: EXIT_CODES.conflict,
      cause: error,
    })
  }
}

function worktreeFromRow(row: GitWorktreeRow): GitWorktreeRecord {
  const record = parseRecord(
    row.record_json,
    (input) => GitWorktreeRecordSchema.parse(input),
    "Git worktree",
    row.id,
  )
  if (
    record.id !== row.id ||
    record.workspaceId !== row.workspace_id ||
    record.runId !== row.run_id ||
    record.taskId !== row.task_id ||
    record.attemptId !== row.attempt_id ||
    record.status !== row.status ||
    record.revision !== row.revision ||
    record.createdAt !== row.created_at ||
    record.updatedAt !== row.updated_at
  ) {
    throw new RalphError(
      "RALPH_GIT_STATE_INVALID",
      `Git worktree ${row.id} columns do not match its record`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  return record
}

function integrationFromRow(row: GitIntegrationRow): GitIntegrationRecord {
  const record = parseRecord(
    row.record_json,
    (input) => GitIntegrationRecordSchema.parse(input),
    "Git integration",
    row.id,
  )
  if (
    record.id !== row.id ||
    record.workspaceId !== row.workspace_id ||
    record.runId !== row.run_id ||
    record.worktreeId !== row.worktree_id ||
    record.taskId !== row.task_id ||
    record.order !== row.integration_order ||
    record.status !== row.status ||
    record.revision !== row.revision ||
    record.createdAt !== row.created_at ||
    record.updatedAt !== row.updated_at
  ) {
    throw new RalphError(
      "RALPH_GIT_STATE_INVALID",
      `Git integration ${row.id} columns do not match its record`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  return record
}

function worktreeRow(database: Database, id: string): GitWorktreeRow | undefined {
  return (
    database
      .query<GitWorktreeRow, [string]>(`SELECT ${WORKTREE_COLUMNS} FROM git_worktrees WHERE id = ?`)
      .get(id) ?? undefined
  )
}

function integrationRow(database: Database, id: string): GitIntegrationRow | undefined {
  return (
    database
      .query<GitIntegrationRow, [string]>(
        `SELECT ${INTEGRATION_COLUMNS} FROM git_integrations WHERE id = ?`,
      )
      .get(id) ?? undefined
  )
}

function gitEvent(
  database: Database,
  input: {
    workspaceId: string
    runId: string
    taskId: string
    attemptId?: string
    type: string
    payload: Record<string, unknown>
  },
): void {
  appendEventInTransaction(database, {
    type: input.type,
    scope: "run",
    streamId: input.runId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    taskId: input.taskId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    payload: { schemaVersion: 1, ...input.payload },
  })
}

export function createGitWorktreeRecord(path: string, input: GitWorktreeRecord): GitWorktreeRecord {
  const record = GitWorktreeRecordSchema.parse(input)
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const existing = worktreeRow(database, record.id)
      if (existing) {
        const parsed = worktreeFromRow(existing)
        if (JSON.stringify(parsed) === JSON.stringify(record)) return parsed
        throw new RalphError("RALPH_GIT_WORKTREE_ID_REUSED", "Git worktree ID was reused", {
          exitCode: EXIT_CODES.conflict,
          details: { worktreeId: record.id },
        })
      }
      database
        .query(
          `INSERT INTO git_worktrees(
             id, workspace_id, run_id, task_id, attempt_id, status, revision,
             record_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.workspaceId,
          record.runId,
          record.taskId,
          record.attemptId,
          record.status,
          record.revision,
          JSON.stringify(record),
          record.createdAt,
          record.updatedAt,
        )
      gitEvent(database, {
        workspaceId: record.workspaceId,
        runId: record.runId,
        taskId: record.taskId,
        attemptId: record.attemptId,
        type: "git.worktree.recorded",
        payload: {
          worktreeId: record.id,
          status: record.status,
          branch: record.branch,
          worktreePath: record.worktreePath,
          retention: record.retention,
        },
      })
      return record
    })
    return operation.immediate()
  })
}

const WORKTREE_TRANSITIONS: Readonly<Record<GitWorktreeStatus, readonly GitWorktreeStatus[]>> = {
  preparing: ["active", "failed", "retained"],
  active: ["active", "integrating", "failed", "retained"],
  integrating: ["integrated", "conflicted", "failed", "retained"],
  integrated: ["retained", "removed"],
  conflicted: ["integrating", "retained"],
  failed: ["retained"],
  retained: ["active", "integrating", "removed"],
  removed: [],
}

export function transitionGitWorktreeRecord(
  path: string,
  id: string,
  expectedRevision: number,
  update: {
    status: GitWorktreeStatus
    head?: string
    failureReason?: string
    updatedAt?: string
  },
): GitWorktreeRecord {
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const row = worktreeRow(database, id)
      if (!row) {
        throw new RalphError("RALPH_GIT_WORKTREE_NOT_FOUND", "Git worktree record was not found", {
          exitCode: EXIT_CODES.notFound,
          details: { worktreeId: id },
        })
      }
      const current = worktreeFromRow(row)
      if (current.revision !== expectedRevision) {
        throw new RalphError("RALPH_GIT_WORKTREE_CHANGED", "Git worktree record changed", {
          exitCode: EXIT_CODES.conflict,
          details: { id, expectedRevision, observedRevision: current.revision },
        })
      }
      if (!WORKTREE_TRANSITIONS[current.status].includes(update.status)) {
        throw new RalphError(
          "RALPH_GIT_WORKTREE_TRANSITION_INVALID",
          `Git worktree cannot transition from ${current.status} to ${update.status}`,
          { exitCode: EXIT_CODES.conflict, details: { id } },
        )
      }
      const next = GitWorktreeRecordSchema.parse({
        ...current,
        status: update.status,
        updatedAt: update.updatedAt ?? new Date().toISOString(),
        revision: current.revision + 1,
        ...(update.head ? { head: update.head } : {}),
        ...(update.failureReason ? { failureReason: update.failureReason } : {}),
      })
      const changed = database
        .query(
          `UPDATE git_worktrees SET status = ?, revision = ?, record_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(next.status, next.revision, JSON.stringify(next), next.updatedAt, id, expectedRevision)
      if (changed.changes !== 1) {
        throw new RalphError("RALPH_GIT_WORKTREE_CHANGED", "Git worktree changed concurrently", {
          exitCode: EXIT_CODES.conflict,
          details: { id, expectedRevision },
        })
      }
      gitEvent(database, {
        workspaceId: next.workspaceId,
        runId: next.runId,
        taskId: next.taskId,
        attemptId: next.attemptId,
        type: "git.worktree.transitioned",
        payload: {
          worktreeId: next.id,
          previousStatus: current.status,
          status: next.status,
          revision: next.revision,
          ...(next.head ? { head: next.head } : {}),
          ...(next.failureReason ? { failureReason: next.failureReason } : {}),
        },
      })
      return next
    })
    return operation.immediate()
  })
}

export function readGitWorktreeRecord(path: string, id: string): GitWorktreeRecord | undefined {
  return withLedger(path, (database) => {
    const row = worktreeRow(database, id)
    return row ? worktreeFromRow(row) : undefined
  })
}

export function listGitWorktreeRecords(
  path: string,
  query: { workspaceId?: string; runId?: string; status?: GitWorktreeStatus; limit?: number } = {},
): GitWorktreeRecord[] {
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
  if (query.status) {
    conditions.push("status = ?")
    bindings.push(query.status)
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000)
  return withLedger(path, (database) =>
    database
      .query<GitWorktreeRow, string[]>(
        `SELECT ${WORKTREE_COLUMNS} FROM git_worktrees
         ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
      )
      .all(...bindings)
      .map(worktreeFromRow),
  )
}

export function createGitIntegrationRecord(
  path: string,
  input: GitIntegrationRecord,
): GitIntegrationRecord {
  const record = GitIntegrationRecordSchema.parse(input)
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const existing = integrationRow(database, record.id)
      if (existing) {
        const parsed = integrationFromRow(existing)
        if (JSON.stringify(parsed) === JSON.stringify(record)) return parsed
        throw new RalphError("RALPH_GIT_INTEGRATION_ID_REUSED", "Git integration ID was reused", {
          exitCode: EXIT_CODES.conflict,
          details: { integrationId: record.id },
        })
      }
      database
        .query(
          `INSERT INTO git_integrations(
             id, workspace_id, run_id, worktree_id, task_id, integration_order,
             status, revision, record_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.workspaceId,
          record.runId,
          record.worktreeId,
          record.taskId,
          record.order,
          record.status,
          record.revision,
          JSON.stringify(record),
          record.createdAt,
          record.updatedAt,
        )
      gitEvent(database, {
        workspaceId: record.workspaceId,
        runId: record.runId,
        taskId: record.taskId,
        type: "git.integration.recorded",
        payload: {
          integrationId: record.id,
          worktreeId: record.worktreeId,
          order: record.order,
          strategy: record.strategy,
          sourceRef: record.sourceRef,
          targetRef: record.targetRef,
          status: record.status,
        },
      })
      return record
    })
    return operation.immediate()
  })
}

const INTEGRATION_TRANSITIONS: Readonly<
  Record<GitIntegrationStatus, readonly GitIntegrationStatus[]>
> = {
  pending: ["running", "paused"],
  running: ["passed", "conflicted", "failed", "paused", "pr-created"],
  passed: [],
  conflicted: ["running", "paused"],
  failed: ["running", "paused"],
  paused: ["running"],
  "pr-created": [],
}

export function transitionGitIntegrationRecord(
  path: string,
  id: string,
  expectedRevision: number,
  update: {
    status: GitIntegrationStatus
    attemptId?: string
    resultHead?: string
    pullRequestRef?: string
    conflictPaths?: readonly string[]
    summary?: string
    updatedAt?: string
  },
): GitIntegrationRecord {
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const row = integrationRow(database, id)
      if (!row) {
        throw new RalphError(
          "RALPH_GIT_INTEGRATION_NOT_FOUND",
          "Git integration record was not found",
          { exitCode: EXIT_CODES.notFound, details: { integrationId: id } },
        )
      }
      const current = integrationFromRow(row)
      if (current.revision !== expectedRevision) {
        throw new RalphError("RALPH_GIT_INTEGRATION_CHANGED", "Git integration changed", {
          exitCode: EXIT_CODES.conflict,
          details: { id, expectedRevision, observedRevision: current.revision },
        })
      }
      if (!INTEGRATION_TRANSITIONS[current.status].includes(update.status)) {
        throw new RalphError(
          "RALPH_GIT_INTEGRATION_TRANSITION_INVALID",
          `Git integration cannot transition from ${current.status} to ${update.status}`,
          { exitCode: EXIT_CODES.conflict, details: { id } },
        )
      }
      const next = GitIntegrationRecordSchema.parse({
        ...current,
        status: update.status,
        revision: current.revision + 1,
        updatedAt: update.updatedAt ?? new Date().toISOString(),
        ...(update.attemptId ? { attemptId: update.attemptId } : {}),
        ...(update.resultHead ? { resultHead: update.resultHead } : {}),
        ...(update.pullRequestRef ? { pullRequestRef: update.pullRequestRef } : {}),
        ...(update.conflictPaths ? { conflictPaths: [...update.conflictPaths] } : {}),
        ...(update.summary ? { summary: update.summary } : {}),
      })
      const changed = database
        .query(
          `UPDATE git_integrations SET status = ?, revision = ?, record_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(next.status, next.revision, JSON.stringify(next), next.updatedAt, id, expectedRevision)
      if (changed.changes !== 1) {
        throw new RalphError(
          "RALPH_GIT_INTEGRATION_CHANGED",
          "Git integration changed concurrently",
          {
            exitCode: EXIT_CODES.conflict,
            details: { id, expectedRevision },
          },
        )
      }
      gitEvent(database, {
        workspaceId: next.workspaceId,
        runId: next.runId,
        taskId: next.taskId,
        type: "git.integration.transitioned",
        payload: {
          integrationId: next.id,
          worktreeId: next.worktreeId,
          previousStatus: current.status,
          status: next.status,
          revision: next.revision,
          conflictPaths: next.conflictPaths,
          ...(next.resultHead ? { resultHead: next.resultHead } : {}),
          ...(next.pullRequestRef ? { pullRequestRef: next.pullRequestRef } : {}),
          ...(next.summary ? { summary: next.summary } : {}),
        },
      })
      return next
    })
    return operation.immediate()
  })
}

export function readGitIntegrationRecord(
  path: string,
  id: string,
): GitIntegrationRecord | undefined {
  return withLedger(path, (database) => {
    const row = integrationRow(database, id)
    return row ? integrationFromRow(row) : undefined
  })
}

export function listGitIntegrationRecords(
  path: string,
  query: {
    workspaceId?: string
    runId?: string
    status?: GitIntegrationStatus
    limit?: number
  } = {},
): GitIntegrationRecord[] {
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
  if (query.status) {
    conditions.push("status = ?")
    bindings.push(query.status)
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000)
  return withLedger(path, (database) =>
    database
      .query<GitIntegrationRow, string[]>(
        `SELECT ${INTEGRATION_COLUMNS} FROM git_integrations
         ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY integration_order, task_id, id LIMIT ${limit}`,
      )
      .all(...bindings)
      .map(integrationFromRow),
  )
}
