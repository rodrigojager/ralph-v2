import { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  type CheckpointRecord,
  CheckpointRecordSchema,
  EXIT_CODES,
  RalphError,
  type RollbackPlan,
  RollbackPlanSchema,
} from "@ralph-next/domain"
import { appendEventInTransaction, checkpointLedger, withLedger } from "./ledger"

type CheckpointRow = {
  id: string
  workspace_id: string
  run_id: string | null
  task_id: string | null
  attempt_id: string | null
  manifest_hash: string
  status: string
  manifest_json: string
  created_at: string
  applied_at: string | null
}

type RollbackPlanRow = {
  id: string
  checkpoint_id: string
  workspace_id: string
  plan_hash: string
  status: string
  plan_json: string
  created_at: string
  expires_at: string
  settled_at: string | null
}

const CHECKPOINT_COLUMNS = `id, workspace_id, run_id, task_id, attempt_id, manifest_hash,
  status, manifest_json, created_at, applied_at`
const ROLLBACK_COLUMNS = `id, checkpoint_id, workspace_id, plan_hash, status, plan_json,
  created_at, expires_at, settled_at`

function checkpointFromRow(row: CheckpointRow): CheckpointRecord {
  try {
    const record = CheckpointRecordSchema.parse(JSON.parse(row.manifest_json) as unknown)
    if (
      record.id !== row.id ||
      record.workspaceId !== row.workspace_id ||
      (record.runId ?? null) !== row.run_id ||
      (record.taskId ?? null) !== row.task_id ||
      (record.attemptId ?? null) !== row.attempt_id ||
      record.manifestHash !== row.manifest_hash ||
      record.status !== row.status ||
      record.createdAt !== row.created_at ||
      (record.appliedAt ?? null) !== row.applied_at
    ) {
      throw new Error("columns do not match manifest")
    }
    return record
  } catch (error) {
    throw new RalphError(
      "RALPH_CHECKPOINT_LEDGER_INVALID",
      `Checkpoint ${row.id} is inconsistent in the ledger`,
      { exitCode: EXIT_CODES.conflict, cause: error },
    )
  }
}

function rollbackFromRow(row: RollbackPlanRow): RollbackPlan {
  try {
    const record = RollbackPlanSchema.parse(JSON.parse(row.plan_json) as unknown)
    if (
      record.id !== row.id ||
      record.checkpointId !== row.checkpoint_id ||
      record.workspaceId !== row.workspace_id ||
      record.planHash !== row.plan_hash ||
      record.createdAt !== row.created_at ||
      record.expiresAt !== row.expires_at
    ) {
      throw new Error("columns do not match rollback plan")
    }
    return record
  } catch (error) {
    throw new RalphError(
      "RALPH_ROLLBACK_LEDGER_INVALID",
      `Rollback plan ${row.id} is inconsistent in the ledger`,
      { exitCode: EXIT_CODES.conflict, cause: error },
    )
  }
}

function readCheckpointRow(database: Database, id: string): CheckpointRow | undefined {
  return (
    database
      .query<CheckpointRow, [string]>(`SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints WHERE id = ?`)
      .get(id) ?? undefined
  )
}

function readRollbackRow(database: Database, id: string): RollbackPlanRow | undefined {
  return (
    database
      .query<RollbackPlanRow, [string]>(
        `SELECT ${ROLLBACK_COLUMNS} FROM rollback_plans WHERE id = ?`,
      )
      .get(id) ?? undefined
  )
}

function checkpointEvent(
  database: Database,
  record: CheckpointRecord,
  type: string,
  payload: Record<string, unknown>,
): void {
  appendEventInTransaction(database, {
    type,
    scope: record.runId ? "run" : "workspace",
    streamId: record.runId ?? `workspace:${record.workspaceId}`,
    workspaceId: record.workspaceId,
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.attemptId ? { attemptId: record.attemptId } : {}),
    payload: { schemaVersion: 1, checkpointId: record.id, ...payload },
  })
}

export function persistCheckpoint(path: string, input: CheckpointRecord): CheckpointRecord {
  const record = CheckpointRecordSchema.parse(input)
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const existing = readCheckpointRow(database, record.id)
      if (existing) {
        const parsed = checkpointFromRow(existing)
        if (JSON.stringify(parsed) === JSON.stringify(record)) return parsed
        throw new RalphError("RALPH_CHECKPOINT_ID_REUSED", "Checkpoint ID was reused", {
          exitCode: EXIT_CODES.conflict,
          details: { checkpointId: record.id },
        })
      }
      database
        .query(
          `INSERT INTO checkpoints(
             id, workspace_id, run_id, task_id, attempt_id, manifest_hash, status,
             manifest_json, created_at, applied_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.workspaceId,
          record.runId ?? null,
          record.taskId ?? null,
          record.attemptId ?? null,
          record.manifestHash,
          record.status,
          JSON.stringify(record),
          record.createdAt,
          record.appliedAt ?? null,
        )
      checkpointEvent(database, record, "checkpoint.created", {
        reason: record.reason,
        manifestHash: record.manifestHash,
        files: record.files.length,
        gitHead: record.gitHead,
        gitBranch: record.gitBranch,
        stateRevision: record.stateRevision,
        ledgerBackupRef: record.ledgerBackupRef,
      })
      return record
    })
    return operation.immediate()
  })
}

export function readCheckpoint(path: string, id: string): CheckpointRecord | undefined {
  return withLedger(path, (database) => {
    const row = readCheckpointRow(database, id)
    return row ? checkpointFromRow(row) : undefined
  })
}

export function listCheckpoints(
  path: string,
  query: {
    workspaceId?: string
    runId?: string
    status?: CheckpointRecord["status"]
    limit?: number
  } = {},
): CheckpointRecord[] {
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
      .query<CheckpointRow, string[]>(
        `SELECT ${CHECKPOINT_COLUMNS} FROM checkpoints
         ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
      )
      .all(...bindings)
      .map(checkpointFromRow),
  )
}

export function persistRollbackPlan(path: string, input: RollbackPlan): RollbackPlan {
  const plan = RollbackPlanSchema.parse(input)
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const existing = readRollbackRow(database, plan.id)
      if (existing) {
        const parsed = rollbackFromRow(existing)
        if (JSON.stringify(parsed) === JSON.stringify(plan)) return parsed
        throw new RalphError("RALPH_ROLLBACK_PLAN_ID_REUSED", "Rollback plan ID was reused", {
          exitCode: EXIT_CODES.conflict,
          details: { rollbackPlanId: plan.id },
        })
      }
      const checkpoint = readCheckpointRow(database, plan.checkpointId)
      if (!checkpoint) {
        throw new RalphError("RALPH_CHECKPOINT_NOT_FOUND", "Checkpoint was not found", {
          exitCode: EXIT_CODES.notFound,
          details: { checkpointId: plan.checkpointId },
        })
      }
      database
        .query(
          `INSERT INTO rollback_plans(
             id, checkpoint_id, workspace_id, plan_hash, status, plan_json,
             created_at, expires_at, settled_at
           ) VALUES (?, ?, ?, ?, 'previewed', ?, ?, ?, NULL)`,
        )
        .run(
          plan.id,
          plan.checkpointId,
          plan.workspaceId,
          plan.planHash,
          JSON.stringify(plan),
          plan.createdAt,
          plan.expiresAt,
        )
      const checkpointRecord = checkpointFromRow(checkpoint)
      checkpointEvent(database, checkpointRecord, "checkpoint.rollback.previewed", {
        rollbackPlanId: plan.id,
        planHash: plan.planHash,
        expiresAt: plan.expiresAt,
        operations: plan.operations.length,
        conflicts: plan.conflicts.length,
        requiresExplicitConfirmation: true,
        requiresSafetyCheckpoint: true,
      })
      return plan
    })
    return operation.immediate()
  })
}

export function readRollbackPlan(path: string, id: string): RollbackPlan | undefined {
  return withLedger(path, (database) => {
    const row = readRollbackRow(database, id)
    return row ? rollbackFromRow(row) : undefined
  })
}

export function settleRollbackPlan(
  path: string,
  id: string,
  status: "applied" | "expired" | "conflicted",
  input: { settledAt?: string; safetyCheckpointId?: string; reason: string },
): void {
  withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const row = readRollbackRow(database, id)
      if (!row) {
        throw new RalphError("RALPH_ROLLBACK_PLAN_NOT_FOUND", "Rollback plan was not found", {
          exitCode: EXIT_CODES.notFound,
          details: { rollbackPlanId: id },
        })
      }
      if (row.status !== "previewed") {
        if (row.status === status) return
        throw new RalphError("RALPH_ROLLBACK_PLAN_SETTLED", "Rollback plan is already settled", {
          exitCode: EXIT_CODES.conflict,
          details: { rollbackPlanId: id, status: row.status },
        })
      }
      const settledAt = input.settledAt ?? new Date().toISOString()
      const changed = database
        .query(
          `UPDATE rollback_plans SET status = ?, settled_at = ?
           WHERE id = ? AND status = 'previewed'`,
        )
        .run(status, settledAt, id)
      if (changed.changes !== 1) {
        throw new RalphError("RALPH_ROLLBACK_PLAN_CHANGED", "Rollback plan changed concurrently", {
          exitCode: EXIT_CODES.conflict,
          details: { rollbackPlanId: id },
        })
      }
      const checkpointRow = readCheckpointRow(database, row.checkpoint_id)
      if (!checkpointRow) throw new Error("Checkpoint disappeared while settling rollback")
      const checkpoint = checkpointFromRow(checkpointRow)
      if (status === "applied") {
        const applied = CheckpointRecordSchema.parse({
          ...checkpoint,
          status: "applied",
          appliedAt: settledAt,
        })
        database
          .query(
            `UPDATE checkpoints SET status = 'applied', applied_at = ?, manifest_json = ?
             WHERE id = ? AND status = 'available'`,
          )
          .run(settledAt, JSON.stringify(applied), checkpoint.id)
      }
      checkpointEvent(database, checkpoint, `checkpoint.rollback.${status}`, {
        rollbackPlanId: id,
        planHash: row.plan_hash,
        reason: input.reason,
        ...(input.safetyCheckpointId ? { safetyCheckpointId: input.safetyCheckpointId } : {}),
        settledAt,
      })
    })
    operation.immediate()
  })
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export async function createLedgerCheckpointBackup(input: {
  ledgerPath: string
  checkpointRoot: string
  checkpointId: string
}): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,512}$/.test(input.checkpointId)) {
    throw new RalphError(
      "RALPH_CHECKPOINT_ID_INVALID",
      "Checkpoint ID cannot be used as a managed backup filename",
      { exitCode: EXIT_CODES.invalidUsage, details: { checkpointId: input.checkpointId } },
    )
  }
  const backupDirectory = join(input.checkpointRoot, "ledger")
  await mkdir(backupDirectory, { recursive: true })
  const backupPath = join(backupDirectory, `${input.checkpointId}.sqlite`)
  checkpointLedger(input.ledgerPath)
  const database = new Database(input.ledgerPath, { strict: true })
  try {
    database.exec("PRAGMA busy_timeout = 5000;")
    database.exec(`VACUUM INTO ${sqliteString(backupPath)};`)
  } catch (error) {
    throw new RalphError(
      "RALPH_CHECKPOINT_LEDGER_BACKUP_FAILED",
      "Could not create the checkpoint ledger backup",
      {
        exitCode: EXIT_CODES.operationalError,
        file: backupPath,
        cause: error,
      },
    )
  } finally {
    database.close(true)
  }
  return backupPath
}

export async function ensureCheckpointStore(checkpointRoot: string): Promise<void> {
  await Promise.all([
    mkdir(join(checkpointRoot, "blobs"), { recursive: true }),
    mkdir(join(checkpointRoot, "ledger"), { recursive: true }),
    mkdir(dirname(join(checkpointRoot, "manifests", "placeholder")), { recursive: true }),
  ])
}
