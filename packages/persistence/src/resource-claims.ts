import type { Database } from "bun:sqlite"
import {
  EXIT_CODES,
  RalphError,
  type ResourceClaimConflict,
  type ResourceClaimMode,
  type ResourceClaimRecord,
  ResourceClaimRecordSchema,
  type ResourceClaimSetRecord,
  ResourceClaimSetRecordSchema,
  type ResourceClaimSpec,
  ResourceClaimSpecSchema,
} from "@ralph-next/domain"
import { appendEventInTransaction, withLedger } from "./ledger"

const CLAIM_SET_COLUMNS = `id, schema_version, workspace_id, run_id, document_id, task_id,
  attempt_id, worker_id, owner_instance_id, pid, process_start_token, hostname, status,
  acquired_at, renewed_at, expires_at, grace_expires_at, revision, released_at, release_reason`
const CLAIM_COLUMNS = `id, schema_version, claim_set_id, workspace_id, run_id, document_id,
  task_id, attempt_id, worker_id, kind, resource_key, mode, metadata_json, status,
  acquired_at, renewed_at, expires_at, grace_expires_at, revision, released_at, release_reason`

type ClaimSetRow = {
  id: string
  schema_version: number
  workspace_id: string
  run_id: string
  document_id: string
  task_id: string
  attempt_id: string
  worker_id: string
  owner_instance_id: string
  pid: number
  process_start_token: string
  hostname: string
  status: string
  acquired_at: string
  renewed_at: string
  expires_at: string
  grace_expires_at: string
  revision: number
  released_at: string | null
  release_reason: string | null
}

type ClaimRow = {
  id: string
  schema_version: number
  claim_set_id: string
  workspace_id: string
  run_id: string
  document_id: string
  task_id: string
  attempt_id: string
  worker_id: string
  kind: string
  resource_key: string
  mode: string
  metadata_json: string
  status: string
  acquired_at: string
  renewed_at: string
  expires_at: string
  grace_expires_at: string
  revision: number
  released_at: string | null
  release_reason: string | null
}

export type ResourceClaimOwner = {
  ownerInstanceId: string
  workerId: string
  pid: number
  processStartToken: string
  hostname: string
}

export type AcquireResourceClaimSetInput = ResourceClaimOwner & {
  id?: string
  workspaceId: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  claims: readonly ResourceClaimSpec[]
  leaseDurationMs: number
  staleGraceMs: number
}

export type ResourceClaimRecoveryProof = {
  status: "dead" | "identity-mismatch"
  confirmationCount: number
  firstObservedAt: string
  expectedProcessStartToken: string
  observedProcessStartToken?: string
  observedAt: string
  reason: string
}

export type SupervisorClaimAuthority = {
  leaseId: string
  workspaceId: string
  runId: string
  ownerInstanceId: string
  pid: number
  processStartToken: string
  hostname: string
}

export type ResourceClaimQuery = {
  workspaceId?: string
  runId?: string
  attemptId?: string
  status?: ResourceClaimSetRecord["status"]
  limit?: number
}

function bounded(name: string, value: string, maximum = 512): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) {
    throw new RalphError("RALPH_RESOURCE_CLAIM_INVALID", `${name} is empty or too long`, {
      exitCode: EXIT_CODES.invalidUsage,
      details: { name, maximum },
    })
  }
  return normalized
}

function duration(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > 24 * 60 * 60 * 1_000) {
    throw new RalphError("RALPH_RESOURCE_CLAIM_INVALID", `${name} is outside its safe range`, {
      exitCode: EXIT_CODES.invalidUsage,
      details: { name, value, minimum },
    })
  }
  return value
}

function parseMetadata(row: ClaimRow): Record<string, unknown> {
  try {
    const value = JSON.parse(row.metadata_json) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object")
    return value as Record<string, unknown>
  } catch (error) {
    throw new RalphError(
      "RALPH_RESOURCE_CLAIM_LEDGER_INVALID",
      `Claim ${row.id} contains invalid metadata`,
      { exitCode: EXIT_CODES.conflict, cause: error },
    )
  }
}

function claimFromRow(row: ClaimRow): ResourceClaimRecord {
  return ResourceClaimRecordSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    claimSetId: row.claim_set_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    documentId: row.document_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    workerId: row.worker_id,
    kind: row.kind,
    resourceKey: row.resource_key,
    mode: row.mode,
    metadata: parseMetadata(row),
    status: row.status,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
    graceExpiresAt: row.grace_expires_at,
    revision: row.revision,
    ...(row.released_at ? { releasedAt: row.released_at } : {}),
    ...(row.release_reason ? { releaseReason: row.release_reason } : {}),
  })
}

function claimsForSet(database: Database, claimSetId: string): ResourceClaimRecord[] {
  return database
    .query<ClaimRow, [string]>(
      `SELECT ${CLAIM_COLUMNS} FROM resource_claims
       WHERE claim_set_id = ? ORDER BY kind, resource_key, id`,
    )
    .all(claimSetId)
    .map(claimFromRow)
}

function setFromRow(database: Database, row: ClaimSetRow): ResourceClaimSetRecord {
  return ResourceClaimSetRecordSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    documentId: row.document_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    workerId: row.worker_id,
    ownerInstanceId: row.owner_instance_id,
    pid: row.pid,
    processStartToken: row.process_start_token,
    hostname: row.hostname,
    status: row.status,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
    graceExpiresAt: row.grace_expires_at,
    revision: row.revision,
    ...(row.released_at ? { releasedAt: row.released_at } : {}),
    ...(row.release_reason ? { releaseReason: row.release_reason } : {}),
    claims: claimsForSet(database, row.id),
  })
}

function readSetRow(database: Database, claimSetId: string): ClaimSetRow | undefined {
  return (
    database
      .query<ClaimSetRow, [string]>(
        `SELECT ${CLAIM_SET_COLUMNS} FROM resource_claim_sets WHERE id = ?`,
      )
      .get(claimSetId) ?? undefined
  )
}

function activeClaims(database: Database, workspaceId: string): ResourceClaimRecord[] {
  return database
    .query<ClaimRow, [string]>(
      `SELECT ${CLAIM_COLUMNS} FROM resource_claims
       WHERE workspace_id = ? AND status = 'active'
       ORDER BY kind, resource_key, id`,
    )
    .all(workspaceId)
    .map(claimFromRow)
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("und") : value
}

function pathPrefix(value: string): string {
  const normalized = comparable(value.replaceAll("\\", "/").replace(/\/+$/, ""))
  return normalized.endsWith("/**") ? normalized.slice(0, -3).replace(/\/+$/, "") : normalized
}

function pathClaimsOverlap(left: string, right: string): boolean {
  const a = pathPrefix(left)
  const b = pathPrefix(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function claimsConflict(requested: ResourceClaimSpec, active: ResourceClaimRecord): boolean {
  if (requested.kind !== active.kind) return false
  const sameResource =
    requested.kind === "path"
      ? pathClaimsOverlap(requested.resourceKey, active.resourceKey)
      : comparable(requested.resourceKey) === comparable(active.resourceKey)
  if (!sameResource) return false
  return requested.mode === "exclusive" || active.mode === "exclusive"
}

function normalizeSpecs(specs: readonly ResourceClaimSpec[]): ResourceClaimSpec[] {
  if (specs.length === 0 || specs.length > 1_024) {
    throw new RalphError(
      "RALPH_RESOURCE_CLAIM_INVALID",
      "A claim set must contain between one and 1024 resources",
      { exitCode: EXIT_CODES.invalidUsage, details: { count: specs.length } },
    )
  }
  const normalized = specs.map((spec) => {
    const parsed = ResourceClaimSpecSchema.parse(spec)
    const resourceKey = bounded("resourceKey", parsed.resourceKey, 4_096)
    if (parsed.kind === "path" && /(^|\/)\.\.(\/|$)/.test(resourceKey.replaceAll("\\", "/"))) {
      throw new RalphError(
        "RALPH_RESOURCE_CLAIM_INVALID",
        "Path claims must use a canonical path without parent traversal",
        { exitCode: EXIT_CODES.invalidUsage, details: { resourceKey } },
      )
    }
    return ResourceClaimSpecSchema.parse({ ...parsed, resourceKey })
  })
  const keys = new Set<string>()
  for (const spec of normalized) {
    const key = `${spec.kind}:${comparable(spec.resourceKey)}:${spec.mode}`
    if (keys.has(key)) {
      throw new RalphError(
        "RALPH_RESOURCE_CLAIM_INVALID",
        "Claim set contains a duplicate resource",
        {
          exitCode: EXIT_CODES.invalidUsage,
          details: { kind: spec.kind, resourceKey: spec.resourceKey, mode: spec.mode },
        },
      )
    }
    keys.add(key)
  }
  return normalized.sort((left, right) =>
    `${left.kind}:${left.resourceKey}:${left.mode}`.localeCompare(
      `${right.kind}:${right.resourceKey}:${right.mode}`,
      "en",
    ),
  )
}

function sameOwner(record: ResourceClaimSetRecord, owner: ResourceClaimOwner): boolean {
  return (
    record.ownerInstanceId === owner.ownerInstanceId &&
    record.workerId === owner.workerId &&
    record.pid === owner.pid &&
    record.processStartToken === owner.processStartToken &&
    comparable(record.hostname) === comparable(owner.hostname)
  )
}

function claimConflictError(conflicts: readonly ResourceClaimConflict[]): RalphError {
  return new RalphError(
    "RALPH_RESOURCE_CLAIM_CONFLICT",
    "Parallel work conflicts with resources already owned by another active attempt",
    {
      exitCode: EXIT_CODES.conflict,
      details: {
        conflicts: conflicts.map((conflict) => ({
          requested: conflict.requested,
          activeClaimId: conflict.activeClaim.id,
          activeClaimSetId: conflict.activeClaim.claimSetId,
          activeRunId: conflict.activeClaim.runId,
          activeTaskId: conflict.activeClaim.taskId,
          activeAttemptId: conflict.activeClaim.attemptId,
          activeWorkerId: conflict.activeClaim.workerId,
          reason: conflict.reason,
        })),
      },
      hint: "Serialize the tasks, narrow their declared resources, or recover the stale claim after verified owner death and grace.",
    },
  )
}

function assertNoConflicts(
  requested: readonly ResourceClaimSpec[],
  active: readonly ResourceClaimRecord[],
  ownSetId?: string,
): void {
  const conflicts: ResourceClaimConflict[] = []
  for (const spec of requested) {
    for (const claim of active) {
      if (claim.claimSetId === ownSetId || !claimsConflict(spec, claim)) continue
      conflicts.push({
        requested: spec,
        activeClaim: claim,
        reason:
          spec.kind === "path"
            ? "canonical path scopes overlap and at least one claim is exclusive"
            : "resource identity is already held and at least one claim is exclusive",
      })
    }
  }
  if (conflicts.length > 0) throw claimConflictError(conflicts)
}

function insertSet(database: Database, record: ResourceClaimSetRecord): void {
  database
    .query(
      `INSERT INTO resource_claim_sets(
         id, schema_version, workspace_id, run_id, document_id, task_id, attempt_id,
         worker_id, owner_instance_id, pid, process_start_token, hostname, status,
         acquired_at, renewed_at, expires_at, grace_expires_at, revision, released_at,
         release_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.schemaVersion,
      record.workspaceId,
      record.runId,
      record.documentId,
      record.taskId,
      record.attemptId,
      record.workerId,
      record.ownerInstanceId,
      record.pid,
      record.processStartToken,
      record.hostname,
      record.status,
      record.acquiredAt,
      record.renewedAt,
      record.expiresAt,
      record.graceExpiresAt,
      record.revision,
      record.releasedAt ?? null,
      record.releaseReason ?? null,
    )
  for (const claim of record.claims) insertClaim(database, claim)
}

function insertClaim(database: Database, claim: ResourceClaimRecord): void {
  database
    .query(
      `INSERT INTO resource_claims(
         id, schema_version, claim_set_id, workspace_id, run_id, document_id, task_id,
         attempt_id, worker_id, kind, resource_key, mode, metadata_json, status,
         acquired_at, renewed_at, expires_at, grace_expires_at, revision, released_at,
         release_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      claim.id,
      claim.schemaVersion,
      claim.claimSetId,
      claim.workspaceId,
      claim.runId,
      claim.documentId,
      claim.taskId,
      claim.attemptId,
      claim.workerId,
      claim.kind,
      claim.resourceKey,
      claim.mode,
      JSON.stringify(claim.metadata),
      claim.status,
      claim.acquiredAt,
      claim.renewedAt,
      claim.expiresAt,
      claim.graceExpiresAt,
      claim.revision,
      claim.releasedAt ?? null,
      claim.releaseReason ?? null,
    )
}

function claimEvent(
  database: Database,
  record: ResourceClaimSetRecord,
  type: string,
  payload: Record<string, unknown>,
): void {
  appendEventInTransaction(database, {
    type,
    scope: "run",
    streamId: record.runId,
    workspaceId: record.workspaceId,
    runId: record.runId,
    documentId: record.documentId,
    taskId: record.taskId,
    attemptId: record.attemptId,
    workerId: record.workerId,
    payload: {
      schemaVersion: 1,
      claimSetId: record.id,
      status: record.status,
      revision: record.revision,
      resources: record.claims.map((claim) => ({
        claimId: claim.id,
        kind: claim.kind,
        resourceKey: claim.resourceKey,
        mode: claim.mode,
      })),
      ...payload,
    },
  })
}

export function acquireResourceClaimSet(
  path: string,
  input: AcquireResourceClaimSetInput,
  dependencies: { now?: () => Date; id?: () => string } = {},
): ResourceClaimSetRecord {
  const now = dependencies.now ?? (() => new Date())
  const id = dependencies.id ?? (() => crypto.randomUUID())
  const leaseDurationMs = duration("leaseDurationMs", input.leaseDurationMs, 1_000)
  const staleGraceMs = duration("staleGraceMs", input.staleGraceMs, 0)
  const specs = normalizeSpecs(input.claims)
  const acquiredAt = now()
  const acquiredAtText = acquiredAt.toISOString()
  const expiresAt = new Date(acquiredAt.getTime() + leaseDurationMs).toISOString()
  const graceExpiresAt = new Date(
    acquiredAt.getTime() + leaseDurationMs + staleGraceMs,
  ).toISOString()

  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const requestedId = input.id ? bounded("id", input.id) : id()
      const existingRow = readSetRow(database, requestedId)
      if (existingRow) {
        const existing = setFromRow(database, existingRow)
        const identicalClaims = JSON.stringify(
          existing.claims.map(({ kind, resourceKey, mode, metadata }) => ({
            kind,
            resourceKey,
            mode,
            metadata,
          })),
        )
        if (
          existing.status === "active" &&
          existing.workspaceId === input.workspaceId &&
          existing.runId === input.runId &&
          existing.attemptId === input.attemptId &&
          sameOwner(existing, input) &&
          identicalClaims === JSON.stringify(specs)
        ) {
          return existing
        }
        throw new RalphError(
          "RALPH_RESOURCE_CLAIM_ID_REUSED",
          "Claim-set identity was already used for a different immutable claim",
          { exitCode: EXIT_CODES.conflict, details: { claimSetId: requestedId } },
        )
      }
      assertNoConflicts(specs, activeClaims(database, bounded("workspaceId", input.workspaceId)))
      const record = ResourceClaimSetRecordSchema.parse({
        schemaVersion: 1,
        id: requestedId,
        workspaceId: bounded("workspaceId", input.workspaceId),
        runId: bounded("runId", input.runId),
        documentId: bounded("documentId", input.documentId),
        taskId: bounded("taskId", input.taskId),
        attemptId: bounded("attemptId", input.attemptId),
        workerId: bounded("workerId", input.workerId),
        ownerInstanceId: bounded("ownerInstanceId", input.ownerInstanceId),
        pid: input.pid,
        processStartToken: bounded("processStartToken", input.processStartToken, 4_096),
        hostname: bounded("hostname", input.hostname),
        status: "active",
        acquiredAt: acquiredAtText,
        renewedAt: acquiredAtText,
        expiresAt,
        graceExpiresAt,
        revision: 0,
        claims: specs.map((spec) =>
          ResourceClaimRecordSchema.parse({
            schemaVersion: 1,
            id: id(),
            claimSetId: requestedId,
            workspaceId: input.workspaceId,
            runId: input.runId,
            documentId: input.documentId,
            taskId: input.taskId,
            attemptId: input.attemptId,
            workerId: input.workerId,
            ...spec,
            status: "active",
            acquiredAt: acquiredAtText,
            renewedAt: acquiredAtText,
            expiresAt,
            graceExpiresAt,
            revision: 0,
          }),
        ),
      })
      insertSet(database, record)
      claimEvent(database, record, "resource.claims.acquired", {
        ownerInstanceId: record.ownerInstanceId,
        pid: record.pid,
        hostname: record.hostname,
        expiresAt: record.expiresAt,
        graceExpiresAt: record.graceExpiresAt,
      })
      return record
    })
    return operation.immediate()
  })
}

export function readResourceClaimSet(
  path: string,
  claimSetId: string,
): ResourceClaimSetRecord | undefined {
  return withLedger(path, (database) => {
    const row = readSetRow(database, claimSetId)
    return row ? setFromRow(database, row) : undefined
  })
}

export function listResourceClaimSets(
  path: string,
  query: ResourceClaimQuery = {},
): ResourceClaimSetRecord[] {
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
  if (query.attemptId) {
    conditions.push("attempt_id = ?")
    bindings.push(query.attemptId)
  }
  if (query.status) {
    conditions.push("status = ?")
    bindings.push(query.status)
  }
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000)
  return withLedger(path, (database) =>
    database
      .query<ClaimSetRow, string[]>(
        `SELECT ${CLAIM_SET_COLUMNS} FROM resource_claim_sets
         ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY acquired_at DESC, id DESC LIMIT ${limit}`,
      )
      .all(...bindings)
      .map((row) => setFromRow(database, row)),
  )
}

function transitionActiveClaimSet(
  path: string,
  claimSetId: string,
  authorization:
    | { kind: "owner"; owner: ResourceClaimOwner }
    | { kind: "supervisor"; authority: SupervisorClaimAuthority }
    | { kind: "recovery"; proof: ResourceClaimRecoveryProof },
  transition: {
    status: "active" | "released" | "expired"
    at: Date
    leaseDurationMs?: number
    staleGraceMs?: number
    reason?: string
    eventType: string
    eventPayload?: Record<string, unknown>
  },
): ResourceClaimSetRecord {
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const row = readSetRow(database, claimSetId)
      if (!row) {
        throw new RalphError("RALPH_RESOURCE_CLAIM_NOT_FOUND", "Resource claim set was not found", {
          exitCode: EXIT_CODES.notFound,
          details: { claimSetId },
        })
      }
      const current = setFromRow(database, row)
      if (current.status !== "active") {
        if (current.status === transition.status) return current
        throw new RalphError(
          "RALPH_RESOURCE_CLAIM_LOST",
          "Resource claim set is no longer active",
          { exitCode: EXIT_CODES.conflict, details: { claimSetId, status: current.status } },
        )
      }
      if (authorization.kind === "owner" && !sameOwner(current, authorization.owner)) {
        throw new RalphError(
          "RALPH_RESOURCE_CLAIM_OWNER_MISMATCH",
          "Resource claims can only be renewed or released by their verified owner",
          { exitCode: EXIT_CODES.conflict, details: { claimSetId } },
        )
      }
      if (authorization.kind === "supervisor") {
        const authority = authorization.authority
        const lease = database
          .query<
            {
              workspace_id: string
              run_id: string | null
              kind: string
              resource_key: string
              owner_instance_id: string
              pid: number
              process_start_token: string
              hostname: string
              expires_at: string
            },
            [string]
          >(
            `SELECT workspace_id, run_id, kind, resource_key, owner_instance_id, pid,
                    process_start_token, hostname, expires_at
             FROM leases
             WHERE id = ?
               AND kind IN ('workspace-supervisor', 'run-supervisor')
               AND status = 'active'`,
          )
          .get(authority.leaseId)
        if (
          !lease ||
          lease.workspace_id !== current.workspaceId ||
          (lease.kind === "run-supervisor" && lease.run_id !== current.runId) ||
          (lease.kind === "workspace-supervisor" &&
            (lease.run_id !== null || lease.resource_key !== "workspace-writer")) ||
          authority.workspaceId !== current.workspaceId ||
          authority.runId !== current.runId ||
          lease.owner_instance_id !== authority.ownerInstanceId ||
          lease.pid !== authority.pid ||
          lease.process_start_token !== authority.processStartToken ||
          comparable(lease.hostname) !== comparable(authority.hostname) ||
          transition.at.getTime() >= Date.parse(lease.expires_at)
        ) {
          throw new RalphError(
            "RALPH_RESOURCE_CLAIM_SUPERVISOR_AUTHORITY_INVALID",
            "Claim release is not bound to the active run-supervisor lease",
            { exitCode: EXIT_CODES.conflict, details: { claimSetId, leaseId: authority.leaseId } },
          )
        }
      }
      if (authorization.kind === "recovery") {
        const proof = authorization.proof
        const observedAt = Date.parse(proof.observedAt)
        const firstObservedAt = Date.parse(proof.firstObservedAt)
        if (
          !Number.isSafeInteger(proof.confirmationCount) ||
          proof.confirmationCount < 2 ||
          proof.confirmationCount > 10 ||
          !Number.isFinite(firstObservedAt) ||
          !Number.isFinite(observedAt) ||
          firstObservedAt > observedAt ||
          observedAt - firstObservedAt < 250 ||
          observedAt > transition.at.getTime()
        ) {
          throw new RalphError(
            "RALPH_RESOURCE_CLAIM_RECOVERY_INVALID",
            "Owner proof timestamp is invalid",
            { exitCode: EXIT_CODES.invalidUsage, details: { claimSetId } },
          )
        }
        if (transition.at.getTime() < Date.parse(current.graceExpiresAt)) {
          throw new RalphError(
            "RALPH_RESOURCE_CLAIM_RECOVERY_EARLY",
            "Active claims cannot be recovered before lease expiry and stale grace",
            {
              exitCode: EXIT_CODES.conflict,
              details: { claimSetId, graceExpiresAt: current.graceExpiresAt },
            },
          )
        }
        if (proof.expectedProcessStartToken !== current.processStartToken) {
          throw new RalphError(
            "RALPH_RESOURCE_CLAIM_RECOVERY_IDENTITY_MISMATCH",
            "Recovery proof is not bound to the current claim owner",
            { exitCode: EXIT_CODES.conflict, details: { claimSetId } },
          )
        }
        if (
          proof.status === "identity-mismatch" &&
          (!proof.observedProcessStartToken ||
            proof.observedProcessStartToken === proof.expectedProcessStartToken)
        ) {
          throw new RalphError(
            "RALPH_RESOURCE_CLAIM_RECOVERY_INVALID",
            "Identity-mismatch proof must contain a different observed start token",
            { exitCode: EXIT_CODES.invalidUsage, details: { claimSetId } },
          )
        }
      }
      const at = transition.at.toISOString()
      const expiresAt =
        transition.status === "active"
          ? new Date(transition.at.getTime() + (transition.leaseDurationMs ?? 0)).toISOString()
          : current.expiresAt
      const graceExpiresAt =
        transition.status === "active"
          ? new Date(
              transition.at.getTime() +
                (transition.leaseDurationMs ?? 0) +
                (transition.staleGraceMs ?? 0),
            ).toISOString()
          : current.graceExpiresAt
      const reason =
        transition.status === "active"
          ? null
          : bounded("reason", transition.reason ?? "released", 4_096)
      const result = database
        .query(
          `UPDATE resource_claim_sets
           SET status = ?, renewed_at = ?, expires_at = ?, grace_expires_at = ?,
               revision = revision + 1, released_at = ?, release_reason = ?
           WHERE id = ? AND status = 'active' AND revision = ?`,
        )
        .run(
          transition.status,
          at,
          expiresAt,
          graceExpiresAt,
          transition.status === "active" ? null : at,
          reason,
          claimSetId,
          current.revision,
        )
      if (result.changes !== 1) {
        throw new RalphError(
          "RALPH_RESOURCE_CLAIM_LOST",
          "Resource claim set changed during transition",
          { exitCode: EXIT_CODES.conflict, details: { claimSetId } },
        )
      }
      database
        .query(
          `UPDATE resource_claims
           SET status = ?, renewed_at = ?, expires_at = ?, grace_expires_at = ?,
               revision = revision + 1, released_at = ?, release_reason = ?
           WHERE claim_set_id = ? AND status = 'active'`,
        )
        .run(
          transition.status,
          at,
          expiresAt,
          graceExpiresAt,
          transition.status === "active" ? null : at,
          reason,
          claimSetId,
        )
      const updatedRow = readSetRow(database, claimSetId)
      if (!updatedRow) throw new Error("Resource claim set disappeared after transition")
      const updated = setFromRow(database, updatedRow)
      claimEvent(
        database,
        updated,
        transition.eventType,
        transition.eventPayload ?? (transition.reason ? { reason: transition.reason } : {}),
      )
      return updated
    })
    return operation.immediate()
  })
}

export function renewResourceClaimSet(
  path: string,
  claimSetId: string,
  owner: ResourceClaimOwner,
  leaseDurationMs: number,
  staleGraceMs: number,
  now: () => Date = () => new Date(),
): ResourceClaimSetRecord {
  duration("leaseDurationMs", leaseDurationMs, 1_000)
  duration("staleGraceMs", staleGraceMs, 0)
  return transitionActiveClaimSet(
    path,
    claimSetId,
    { kind: "owner", owner },
    {
      status: "active",
      at: now(),
      leaseDurationMs,
      staleGraceMs,
      eventType: "resource.claims.renewed",
    },
  )
}

export function expandResourceClaimSet(
  path: string,
  claimSetId: string,
  owner: ResourceClaimOwner,
  additions: readonly ResourceClaimSpec[],
  leaseDurationMs: number,
  staleGraceMs: number,
  dependencies: { now?: () => Date; id?: () => string } = {},
): ResourceClaimSetRecord {
  duration("leaseDurationMs", leaseDurationMs, 1_000)
  duration("staleGraceMs", staleGraceMs, 0)
  const requested = normalizeSpecs(additions)
  const now = dependencies.now ?? (() => new Date())
  const id = dependencies.id ?? (() => crypto.randomUUID())
  return withLedger(path, (database) => {
    const operation = database.transaction(() => {
      const row = readSetRow(database, claimSetId)
      if (!row) {
        throw new RalphError("RALPH_RESOURCE_CLAIM_NOT_FOUND", "Resource claim set was not found", {
          exitCode: EXIT_CODES.notFound,
          details: { claimSetId },
        })
      }
      const current = setFromRow(database, row)
      if (current.status !== "active" || !sameOwner(current, owner)) {
        throw new RalphError(
          "RALPH_RESOURCE_CLAIM_OWNER_MISMATCH",
          "Only the verified active owner may expand resource claims",
          { exitCode: EXIT_CODES.conflict, details: { claimSetId, status: current.status } },
        )
      }
      const existingKeys = new Set(
        current.claims.map(
          (claim) => `${claim.kind}:${comparable(claim.resourceKey)}:${claim.mode}`,
        ),
      )
      const novel = requested.filter(
        (spec) => !existingKeys.has(`${spec.kind}:${comparable(spec.resourceKey)}:${spec.mode}`),
      )
      if (novel.length === 0) return current
      assertNoConflicts(novel, activeClaims(database, current.workspaceId), current.id)
      const renewedAt = now()
      const renewedAtText = renewedAt.toISOString()
      const expiresAt = new Date(renewedAt.getTime() + leaseDurationMs).toISOString()
      const graceExpiresAt = new Date(
        renewedAt.getTime() + leaseDurationMs + staleGraceMs,
      ).toISOString()
      const updated = database
        .query(
          `UPDATE resource_claim_sets
           SET renewed_at = ?, expires_at = ?, grace_expires_at = ?, revision = revision + 1
           WHERE id = ? AND status = 'active' AND revision = ?`,
        )
        .run(renewedAtText, expiresAt, graceExpiresAt, current.id, current.revision)
      if (updated.changes !== 1) {
        throw new RalphError(
          "RALPH_RESOURCE_CLAIM_LOST",
          "Resource claim set changed while expanding scope",
          { exitCode: EXIT_CODES.conflict, details: { claimSetId } },
        )
      }
      database
        .query(
          `UPDATE resource_claims
           SET renewed_at = ?, expires_at = ?, grace_expires_at = ?, revision = revision + 1
           WHERE claim_set_id = ? AND status = 'active'`,
        )
        .run(renewedAtText, expiresAt, graceExpiresAt, current.id)
      for (const spec of novel) {
        insertClaim(
          database,
          ResourceClaimRecordSchema.parse({
            schemaVersion: 1,
            id: id(),
            claimSetId: current.id,
            workspaceId: current.workspaceId,
            runId: current.runId,
            documentId: current.documentId,
            taskId: current.taskId,
            attemptId: current.attemptId,
            workerId: current.workerId,
            ...spec,
            status: "active",
            acquiredAt: renewedAtText,
            renewedAt: renewedAtText,
            expiresAt,
            graceExpiresAt,
            revision: 0,
          }),
        )
      }
      const nextRow = readSetRow(database, current.id)
      if (!nextRow) throw new Error("Resource claim set disappeared after expansion")
      const next = setFromRow(database, nextRow)
      claimEvent(database, next, "scope.expanded", {
        previousRevision: current.revision,
        additions: novel.map((spec) => ({
          kind: spec.kind,
          resourceKey: spec.resourceKey,
          mode: spec.mode,
        })),
      })
      return next
    })
    return operation.immediate()
  })
}

export function releaseResourceClaimSet(
  path: string,
  claimSetId: string,
  owner: ResourceClaimOwner,
  reason: string,
  now: () => Date = () => new Date(),
): ResourceClaimSetRecord {
  return transitionActiveClaimSet(
    path,
    claimSetId,
    { kind: "owner", owner },
    {
      status: "released",
      at: now(),
      reason,
      eventType: "resource.claims.released",
    },
  )
}

export function releaseResourceClaimSetBySupervisor(
  path: string,
  claimSetId: string,
  authority: SupervisorClaimAuthority,
  reason: string,
  now: () => Date = () => new Date(),
): ResourceClaimSetRecord {
  return transitionActiveClaimSet(
    path,
    claimSetId,
    { kind: "supervisor", authority },
    {
      status: "released",
      at: now(),
      reason,
      eventType: "resource.claims.released_by_supervisor",
      eventPayload: { supervisorLeaseId: authority.leaseId, reason },
    },
  )
}

export function recoverExpiredResourceClaimSet(
  path: string,
  claimSetId: string,
  proof: ResourceClaimRecoveryProof,
  now: () => Date = () => new Date(),
): ResourceClaimSetRecord {
  const currentTime = now()
  return transitionActiveClaimSet(
    path,
    claimSetId,
    { kind: "recovery", proof },
    {
      status: "expired",
      at: currentTime,
      reason: bounded("reason", proof.reason, 4_096),
      eventType: "resource.claims.recovered",
      eventPayload: {
        proof: {
          status: proof.status,
          confirmationCount: proof.confirmationCount,
          firstObservedAt: proof.firstObservedAt,
          expectedProcessStartToken: proof.expectedProcessStartToken,
          ...(proof.observedProcessStartToken
            ? { observedProcessStartToken: proof.observedProcessStartToken }
            : {}),
          observedAt: proof.observedAt,
          reason: proof.reason,
        },
      },
    },
  )
}

export function resourceClaimsConflict(
  requested: ResourceClaimSpec,
  active: ResourceClaimRecord,
): boolean {
  return claimsConflict(
    ResourceClaimSpecSchema.parse(requested),
    ResourceClaimRecordSchema.parse(active),
  )
}

export function resourceClaimModesConflict(
  requested: ResourceClaimMode,
  active: ResourceClaimMode,
): boolean {
  return requested === "exclusive" || active === "exclusive"
}
