import type { Database } from "bun:sqlite"
import {
  type DurableLeaseRecord,
  DurableLeaseRecordSchema,
  EXIT_CODES,
  type LeaseKind,
  type LeaseProbeRecord,
  LeaseProbeRecordSchema,
  type LeaseProbeStatus,
  RalphError,
} from "@ralph-next/domain"
import { appendEventInTransaction, withLedger } from "./ledger"

const LEASE_COLUMNS = `id, schema_version, kind, resource_key, workspace_id, run_id,
  owner_instance_id, worker_id, pid, process_start_token, hostname, command,
  capability_scope_json, parent_run_id, parent_worker_id, acquired_at, renewed_at,
  expires_at, grace_expires_at, status, revision, released_at, replaced_by_lease_id`

const PROBE_COLUMNS = `id, schema_version, lease_id, observer_instance_id, sequence, status,
  expected_process_start_token, observed_process_start_token, observed_at, reason`

type LeaseRow = {
  id: string
  schema_version: number
  kind: string
  resource_key: string
  workspace_id: string
  run_id: string | null
  owner_instance_id: string
  worker_id: string | null
  pid: number
  process_start_token: string
  hostname: string
  command: string
  capability_scope_json: string
  parent_run_id: string | null
  parent_worker_id: string | null
  acquired_at: string
  renewed_at: string
  expires_at: string
  grace_expires_at: string
  status: string
  revision: number
  released_at: string | null
  replaced_by_lease_id: string | null
}

type ProbeRow = {
  id: string
  schema_version: number
  lease_id: string
  observer_instance_id: string
  sequence: number
  status: string
  expected_process_start_token: string
  observed_process_start_token: string | null
  observed_at: string
  reason: string
}

export type LeaseOwnerIdentity = {
  ownerInstanceId: string
  pid: number
  processStartToken: string
  hostname: string
}

export type LeaseOwnerProbeResult = {
  status: LeaseProbeStatus
  observedProcessStartToken?: string
  reason: string
}

export type AcquireDurableLeaseInput = LeaseOwnerIdentity & {
  id?: string
  kind: LeaseKind
  resourceKey: string
  workspaceId: string
  runId?: string
  workerId?: string
  command: string
  scope: readonly string[]
  parentRunId?: string
  parentWorkerId?: string
  leaseDurationMs: number
  staleGraceMs: number
  staleProbeConfirmations?: number
  staleProbeIntervalMs?: number
}

export type AcquireDurableLeaseDependencies = {
  now?: () => Date
  id?: () => string
  probeOwner?: (owner: DurableLeaseRecord) => Promise<LeaseOwnerProbeResult>
  sleep?: (milliseconds: number) => Promise<void>
}

export type AcquireDurableLeaseResult = {
  lease: DurableLeaseRecord
  displacedLease?: DurableLeaseRecord
  probes: readonly LeaseProbeRecord[]
}

export type LeaseQuery = {
  workspaceId?: string
  runId?: string
  status?: DurableLeaseRecord["status"]
  limit?: number
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new RalphError("RALPH_LEASE_LEDGER_INVALID", `Invalid ${field} in durable lease`, {
      exitCode: EXIT_CODES.conflict,
      cause: error,
    })
  }
}

function leaseFromRow(row: LeaseRow): DurableLeaseRecord {
  return DurableLeaseRecordSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    kind: row.kind,
    resourceKey: row.resource_key,
    workspaceId: row.workspace_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ownerInstanceId: row.owner_instance_id,
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    pid: row.pid,
    processStartToken: row.process_start_token,
    hostname: row.hostname,
    command: row.command,
    scope: parseJson(row.capability_scope_json, "capability scope"),
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.parent_worker_id ? { parentWorkerId: row.parent_worker_id } : {}),
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
    graceExpiresAt: row.grace_expires_at,
    status: row.status,
    revision: row.revision,
    ...(row.released_at ? { releasedAt: row.released_at } : {}),
    ...(row.replaced_by_lease_id ? { replacedByLeaseId: row.replaced_by_lease_id } : {}),
  })
}

function probeFromRow(row: ProbeRow): LeaseProbeRecord {
  return LeaseProbeRecordSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    leaseId: row.lease_id,
    observerInstanceId: row.observer_instance_id,
    sequence: row.sequence,
    status: row.status,
    expectedProcessStartToken: row.expected_process_start_token,
    ...(row.observed_process_start_token
      ? { observedProcessStartToken: row.observed_process_start_token }
      : {}),
    observedAt: row.observed_at,
    reason: row.reason,
  })
}

function activeLease(
  database: Database,
  workspaceId: string,
  kind: LeaseKind,
  resourceKey: string,
): DurableLeaseRecord | undefined {
  const row = database
    .query<LeaseRow, [string, string, string]>(
      `SELECT ${LEASE_COLUMNS} FROM leases
       WHERE workspace_id = ? AND kind = ? AND resource_key = ? AND status = 'active'`,
    )
    .get(workspaceId, kind, resourceKey)
  return row ? leaseFromRow(row) : undefined
}

function leaseById(database: Database, leaseId: string): DurableLeaseRecord | undefined {
  const row = database
    .query<LeaseRow, [string]>(`SELECT ${LEASE_COLUMNS} FROM leases WHERE id = ?`)
    .get(leaseId)
  return row ? leaseFromRow(row) : undefined
}

function canonicalScope(scope: readonly string[]): string[] {
  const values = [...new Set(scope.map((value) => value.trim()).filter(Boolean))].sort()
  if (values.length === 0 || values.length > 128 || values.some((value) => value.length > 512)) {
    throw new RalphError("RALPH_LEASE_INPUT_INVALID", "Lease capability scope is invalid", {
      exitCode: EXIT_CODES.invalidUsage,
      details: { scopeCount: values.length },
    })
  }
  return values
}

function duration(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RalphError("RALPH_LEASE_INPUT_INVALID", `${name} is outside its safe range`, {
      exitCode: EXIT_CODES.invalidUsage,
      details: { name, value, minimum, maximum },
    })
  }
  return value
}

function boundedText(name: string, value: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) {
    throw new RalphError("RALPH_LEASE_INPUT_INVALID", `${name} is empty or too long`, {
      exitCode: EXIT_CODES.invalidUsage,
      details: { name, maximum },
    })
  }
  return normalized
}

function leaseConflict(
  current: DurableLeaseRecord,
  reason: string,
  probes: readonly LeaseOwnerProbeResult[] = [],
): RalphError {
  return new RalphError(
    "RALPH_LEASE_CONFLICT",
    "Another Ralph supervisor owns this workspace writer lease",
    {
      exitCode: EXIT_CODES.conflict,
      details: {
        reason,
        leaseId: current.id,
        workspaceId: current.workspaceId,
        runId: current.runId,
        ownerInstanceId: current.ownerInstanceId,
        pid: current.pid,
        hostname: current.hostname,
        renewedAt: current.renewedAt,
        expiresAt: current.expiresAt,
        graceExpiresAt: current.graceExpiresAt,
        probes,
      },
      hint: "Attach read-only, wait for expiry plus grace, or stop the owning supervisor cleanly.",
    },
  )
}

function leaseLost(leaseId: string, reason: string, current?: DurableLeaseRecord): RalphError {
  return new RalphError("RALPH_LEASE_LOST", "The supervisor no longer owns its writer lease", {
    exitCode: EXIT_CODES.conflict,
    details: {
      leaseId,
      reason,
      ...(current
        ? {
            status: current.status,
            ownerInstanceId: current.ownerInstanceId,
            pid: current.pid,
            hostname: current.hostname,
            replacedByLeaseId: current.replacedByLeaseId,
          }
        : {}),
    },
    hint: "Stop writing immediately and resume through the current supervisor or a new lease acquisition.",
  })
}

function sameOwner(lease: DurableLeaseRecord, owner: LeaseOwnerIdentity): boolean {
  return (
    lease.ownerInstanceId === owner.ownerInstanceId &&
    lease.pid === owner.pid &&
    lease.processStartToken === owner.processStartToken &&
    lease.hostname.toLocaleLowerCase("und") === owner.hostname.toLocaleLowerCase("und")
  )
}

function insertLease(database: Database, lease: DurableLeaseRecord): void {
  database
    .query(
      `INSERT INTO leases(
         id, schema_version, kind, resource_key, workspace_id, run_id,
         owner_instance_id, worker_id, pid, process_start_token, hostname, command,
         capability_scope_json, parent_run_id, parent_worker_id, acquired_at, renewed_at,
         expires_at, grace_expires_at, status, revision, released_at, replaced_by_lease_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      lease.id,
      lease.schemaVersion,
      lease.kind,
      lease.resourceKey,
      lease.workspaceId,
      lease.runId ?? null,
      lease.ownerInstanceId,
      lease.workerId ?? null,
      lease.pid,
      lease.processStartToken,
      lease.hostname,
      lease.command,
      JSON.stringify(lease.scope),
      lease.parentRunId ?? null,
      lease.parentWorkerId ?? null,
      lease.acquiredAt,
      lease.renewedAt,
      lease.expiresAt,
      lease.graceExpiresAt,
      lease.status,
      lease.revision,
      lease.releasedAt ?? null,
      lease.replacedByLeaseId ?? null,
    )
}

function insertProbe(database: Database, probe: LeaseProbeRecord): void {
  database
    .query(
      `INSERT INTO lease_probes(
         id, schema_version, lease_id, observer_instance_id, sequence, status,
         expected_process_start_token, observed_process_start_token, observed_at, reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      probe.id,
      probe.schemaVersion,
      probe.leaseId,
      probe.observerInstanceId,
      probe.sequence,
      probe.status,
      probe.expectedProcessStartToken,
      probe.observedProcessStartToken ?? null,
      probe.observedAt,
      probe.reason,
    )
}

function leaseEvent(
  database: Database,
  lease: DurableLeaseRecord,
  type: string,
  payload: Record<string, unknown>,
): void {
  appendEventInTransaction(database, {
    type,
    scope: lease.runId ? "run" : "workspace",
    streamId: lease.runId ?? `workspace:${lease.workspaceId}`,
    workspaceId: lease.workspaceId,
    ...(lease.runId ? { runId: lease.runId } : {}),
    ...(lease.workerId ? { workerId: lease.workerId } : {}),
    payload: {
      schemaVersion: 1,
      leaseId: lease.id,
      kind: lease.kind,
      resourceKey: lease.resourceKey,
      ownerInstanceId: lease.ownerInstanceId,
      pid: lease.pid,
      hostname: lease.hostname,
      revision: lease.revision,
      ...payload,
    },
  })
}

function newLease(
  input: AcquireDurableLeaseInput,
  id: string,
  now: Date,
  scope: readonly string[],
): DurableLeaseRecord {
  const acquiredAt = now.toISOString()
  const expiresAtMs = now.getTime() + input.leaseDurationMs
  return DurableLeaseRecordSchema.parse({
    schemaVersion: 1,
    id,
    kind: input.kind,
    resourceKey: boundedText("resourceKey", input.resourceKey, 512),
    workspaceId: boundedText("workspaceId", input.workspaceId, 512),
    ...(input.runId ? { runId: boundedText("runId", input.runId, 512) } : {}),
    ownerInstanceId: boundedText("ownerInstanceId", input.ownerInstanceId, 512),
    ...(input.workerId ? { workerId: boundedText("workerId", input.workerId, 512) } : {}),
    pid: input.pid,
    processStartToken: boundedText("processStartToken", input.processStartToken, 1024),
    hostname: boundedText("hostname", input.hostname, 512),
    command: boundedText("command", input.command, 4096),
    scope,
    ...(input.parentRunId
      ? { parentRunId: boundedText("parentRunId", input.parentRunId, 512) }
      : {}),
    ...(input.parentWorkerId
      ? { parentWorkerId: boundedText("parentWorkerId", input.parentWorkerId, 512) }
      : {}),
    acquiredAt,
    renewedAt: acquiredAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    graceExpiresAt: new Date(expiresAtMs + input.staleGraceMs).toISOString(),
    status: "active",
    revision: 0,
  })
}

export function readActiveDurableLease(
  path: string,
  workspaceId: string,
  kind: LeaseKind,
  resourceKey: string,
): DurableLeaseRecord | undefined {
  return withLedger(path, (database) => activeLease(database, workspaceId, kind, resourceKey))
}

export function readDurableLease(path: string, leaseId: string): DurableLeaseRecord | undefined {
  return withLedger(path, (database) => leaseById(database, leaseId))
}

export function listDurableLeases(path: string, query: LeaseQuery = {}): DurableLeaseRecord[] {
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
      .query<LeaseRow, string[]>(
        `SELECT ${LEASE_COLUMNS} FROM leases
         ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY acquired_at DESC, id DESC LIMIT ${limit}`,
      )
      .all(...bindings)
      .map(leaseFromRow),
  )
}

export function readLeaseProbes(path: string, leaseId: string): LeaseProbeRecord[] {
  return withLedger(path, (database) =>
    database
      .query<ProbeRow, [string]>(
        `SELECT ${PROBE_COLUMNS} FROM lease_probes
         WHERE lease_id = ? ORDER BY observed_at, sequence, id`,
      )
      .all(leaseId)
      .map(probeFromRow),
  )
}

export async function acquireDurableLease(
  path: string,
  input: AcquireDurableLeaseInput,
  dependencies: AcquireDurableLeaseDependencies = {},
): Promise<AcquireDurableLeaseResult> {
  const now = dependencies.now ?? (() => new Date())
  const id = dependencies.id ?? (() => crypto.randomUUID())
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  duration("leaseDurationMs", input.leaseDurationMs, 1_000, 24 * 60 * 60 * 1_000)
  duration("staleGraceMs", input.staleGraceMs, 0, 24 * 60 * 60 * 1_000)
  const confirmations = duration(
    "staleProbeConfirmations",
    input.staleProbeConfirmations ?? 2,
    1,
    10,
  )
  const probeIntervalMs = duration(
    "staleProbeIntervalMs",
    input.staleProbeIntervalMs ?? 250,
    0,
    60_000,
  )
  const scope = canonicalScope(input.scope)

  for (let raceAttempt = 0; raceAttempt < 3; raceAttempt += 1) {
    const observed = readActiveDurableLease(path, input.workspaceId, input.kind, input.resourceKey)
    if (observed && sameOwner(observed, input)) {
      if (observed.runId && input.runId && observed.runId !== input.runId) {
        throw leaseConflict(observed, "the same owner attempted to bind a different run")
      }
      const renewed = renewDurableLease(
        path,
        observed.id,
        input,
        input.leaseDurationMs,
        input.staleGraceMs,
        now,
      )
      return { lease: renewed, probes: [] }
    }

    const probeResults: LeaseOwnerProbeResult[] = []
    if (observed) {
      const observedNow = now()
      if (observedNow.getTime() < Date.parse(observed.graceExpiresAt)) {
        throw leaseConflict(
          observed,
          observedNow.getTime() < Date.parse(observed.expiresAt)
            ? "owner lease has not expired"
            : "owner lease expired but remains inside its stale grace period",
        )
      }
      if (!dependencies.probeOwner) {
        throw leaseConflict(observed, "stale owner requires an explicit process identity probe")
      }
      for (let sequence = 1; sequence <= confirmations; sequence += 1) {
        const result = await dependencies.probeOwner(observed)
        probeResults.push(result)
        if (result.status !== "dead" && result.status !== "identity-mismatch") {
          throw leaseConflict(
            observed,
            result.status === "alive"
              ? "process probe confirmed the owner is alive"
              : "owner process is on a host that cannot be probed safely",
            probeResults,
          )
        }
        if (sequence < confirmations && probeIntervalMs > 0) await sleep(probeIntervalMs)
      }
    }

    const acquired = withLedger(path, (database) => {
      const operation = database.transaction(
        (): { kind: "retry" } | { kind: "acquired"; result: AcquireDurableLeaseResult } => {
          const current = activeLease(database, input.workspaceId, input.kind, input.resourceKey)
          if (
            (current?.id ?? null) !== (observed?.id ?? null) ||
            current?.revision !== observed?.revision
          ) {
            return { kind: "retry" }
          }
          const acquiredAt = now()
          const lease = newLease(input, input.id ?? id(), acquiredAt, scope)
          const persistedProbes: LeaseProbeRecord[] = []
          let displacedLease: DurableLeaseRecord | undefined
          if (current) {
            const displaced = database
              .query(
                `UPDATE leases
               SET status = 'stolen', released_at = ?, replaced_by_lease_id = ?, revision = revision + 1
               WHERE id = ? AND status = 'active' AND revision = ?`,
              )
              .run(acquiredAt.toISOString(), lease.id, current.id, current.revision)
            if (displaced.changes !== 1) return { kind: "retry" }
            for (const [index, result] of probeResults.entries()) {
              const probe = LeaseProbeRecordSchema.parse({
                schemaVersion: 1,
                id: id(),
                leaseId: current.id,
                observerInstanceId: input.ownerInstanceId,
                sequence: index + 1,
                status: result.status,
                expectedProcessStartToken: current.processStartToken,
                ...(result.observedProcessStartToken
                  ? { observedProcessStartToken: result.observedProcessStartToken }
                  : {}),
                observedAt: now().toISOString(),
                reason: boundedText("probe reason", result.reason, 4096),
              })
              insertProbe(database, probe)
              persistedProbes.push(probe)
            }
          }
          insertLease(database, lease)
          if (current) {
            displacedLease = leaseById(database, current.id)
            if (!displacedLease) throw leaseLost(current.id, "displaced lease row disappeared")
            leaseEvent(database, displacedLease, "lease.lost", {
              reason: "expired owner displaced after grace and negative identity probes",
              replacementLeaseId: lease.id,
              probeStatuses: persistedProbes.map((probe) => probe.status),
            })
          }
          leaseEvent(database, lease, "lease.acquired", {
            expiresAt: lease.expiresAt,
            graceExpiresAt: lease.graceExpiresAt,
            displacedLeaseId: current?.id,
          })
          return {
            kind: "acquired",
            result: {
              lease,
              ...(displacedLease ? { displacedLease } : {}),
              probes: persistedProbes,
            },
          }
        },
      )
      return operation.immediate()
    })
    if (acquired.kind === "acquired") return acquired.result
  }

  const current = readActiveDurableLease(path, input.workspaceId, input.kind, input.resourceKey)
  if (current) throw leaseConflict(current, "lease owner changed concurrently during acquisition")
  throw new RalphError(
    "RALPH_LEASE_ACQUIRE_RACE",
    "Writer lease changed repeatedly during acquisition",
    { exitCode: EXIT_CODES.conflict },
  )
}

export function renewDurableLease(
  path: string,
  leaseId: string,
  owner: LeaseOwnerIdentity,
  leaseDurationMs: number,
  staleGraceMs: number,
  now: () => Date = () => new Date(),
): DurableLeaseRecord {
  duration("leaseDurationMs", leaseDurationMs, 1_000, 24 * 60 * 60 * 1_000)
  duration("staleGraceMs", staleGraceMs, 0, 24 * 60 * 60 * 1_000)
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const current = leaseById(database, leaseId)
      if (!current || current.status !== "active" || !sameOwner(current, owner)) {
        throw leaseLost(leaseId, "renewal identity/status comparison failed", current)
      }
      const renewedAt = now()
      const expiresAt = new Date(renewedAt.getTime() + leaseDurationMs)
      const update = database
        .query(
          `UPDATE leases
           SET renewed_at = ?, expires_at = ?, grace_expires_at = ?, revision = revision + 1
           WHERE id = ? AND status = 'active' AND revision = ?`,
        )
        .run(
          renewedAt.toISOString(),
          expiresAt.toISOString(),
          new Date(expiresAt.getTime() + staleGraceMs).toISOString(),
          current.id,
          current.revision,
        )
      if (update.changes !== 1) throw leaseLost(leaseId, "renewal compare-and-swap failed")
      const renewed = leaseById(database, leaseId)
      if (!renewed) throw leaseLost(leaseId, "renewed row disappeared")
      leaseEvent(database, renewed, "lease.renewed", { expiresAt: renewed.expiresAt })
      return renewed
    })
    return operation.immediate()
  })
}

export function bindDurableLeaseRun(
  path: string,
  leaseId: string,
  owner: LeaseOwnerIdentity,
  runId: string,
): DurableLeaseRecord {
  const normalizedRunId = boundedText("runId", runId, 512)
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const current = leaseById(database, leaseId)
      if (!current || current.status !== "active" || !sameOwner(current, owner)) {
        throw leaseLost(leaseId, "run binding identity/status comparison failed", current)
      }
      if (current.runId === normalizedRunId) return current
      if (current.runId !== undefined) {
        throw leaseLost(leaseId, "lease is already bound to a different run", current)
      }
      const update = database
        .query(
          `UPDATE leases SET run_id = ?, revision = revision + 1
           WHERE id = ? AND status = 'active' AND revision = ? AND run_id IS NULL`,
        )
        .run(normalizedRunId, current.id, current.revision)
      if (update.changes !== 1) throw leaseLost(leaseId, "run binding compare-and-swap failed")
      const bound = leaseById(database, leaseId)
      if (!bound) throw leaseLost(leaseId, "bound row disappeared")
      leaseEvent(database, bound, "lease.bound", { runId: normalizedRunId })
      return bound
    })
    return operation.immediate()
  })
}

export function assertDurableLeaseOwned(
  path: string,
  leaseId: string,
  owner: LeaseOwnerIdentity,
  at: Date = new Date(),
): DurableLeaseRecord {
  const current = readDurableLease(path, leaseId)
  if (!current || current.status !== "active" || !sameOwner(current, owner)) {
    throw leaseLost(leaseId, "ownership assertion failed", current)
  }
  if (at.getTime() >= Date.parse(current.expiresAt)) {
    throw leaseLost(leaseId, "lease renewal deadline elapsed", current)
  }
  return current
}

export function releaseDurableLease(
  path: string,
  leaseId: string,
  owner: LeaseOwnerIdentity,
  now: () => Date = () => new Date(),
): DurableLeaseRecord {
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const current = leaseById(database, leaseId)
      if (!current) throw leaseLost(leaseId, "lease row is missing")
      if (!sameOwner(current, owner)) {
        throw leaseLost(leaseId, "release identity comparison failed", current)
      }
      if (current.status !== "active") return current
      const releasedAt = now().toISOString()
      const update = database
        .query(
          `UPDATE leases
           SET status = 'released', released_at = ?, revision = revision + 1
           WHERE id = ? AND status = 'active' AND revision = ?`,
        )
        .run(releasedAt, current.id, current.revision)
      if (update.changes !== 1) throw leaseLost(leaseId, "release compare-and-swap failed")
      const released = leaseById(database, leaseId)
      if (!released) throw leaseLost(leaseId, "released row disappeared")
      leaseEvent(database, released, "lease.released", { releasedAt })
      return released
    })
    return operation.immediate()
  })
}
