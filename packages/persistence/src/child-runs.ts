import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import {
  aggregateChildUsageSummaries,
  type ChildParentPolicy,
  ChildParentPolicySchema,
  type ChildRunLinkRecord,
  ChildRunLinkRecordSchema,
  type ChildRunObservability,
  ChildRunObservabilitySchema,
  type ChildRunStatus,
  ChildRunStatusSchema,
  type ChildRunTerminalReceipt,
  ChildRunTerminalReceiptSchema,
  type ChildUsageSummary,
  canTransitionChildRunStatus,
  childRunStatusFromRunStatus,
  type EffectiveRunOptions,
  EffectiveRunOptionsSchema,
  EXIT_CODES,
  type ParentChildCompletionPolicy,
  ParentChildCompletionPolicySchema,
  RalphError,
  RunRecordSchema,
  RunStatusSchema,
  TaskRecordSchema,
  type TaskRuntimeStatus,
  TaskRuntimeStatusSchema,
} from "@ralph-next/domain"
import {
  type EventEnvelope,
  EventEnvelopeConsumerSchema,
  type EventLevel,
} from "@ralph-next/telemetry"
import { appendEventInTransaction, withLedger } from "./ledger"

export { CHILD_RUN_LINKS_MIGRATION_SQL } from "./child-run-links-migration"

const LINK_COLUMNS = `id, schema_version, workspace_id, parent_run_id, parent_document_id,
  parent_task_id, child_run_id, child_document_id, child_root_prd_file,
  graph_definition_hash, graph_hash, inherited_options_hash, materialization_hash, depth,
  expected_direct_children, parent_policy, completion_policy, status, revision, lease_id, observability_json,
  artifacts_reconciled, terminal_receipt_json, created_at, updated_at, last_heartbeat_at,
  terminal_at, terminal_reason`

type ChildRunLinkRow = {
  id: string
  schema_version: number
  workspace_id: string
  parent_run_id: string
  parent_document_id: string
  parent_task_id: string
  child_run_id: string
  child_document_id: string
  child_root_prd_file: string
  graph_definition_hash: string
  graph_hash: string
  inherited_options_hash: string
  materialization_hash: string
  depth: number
  expected_direct_children: number
  parent_policy: string
  completion_policy: string
  status: string
  revision: number
  lease_id: string | null
  observability_json: string
  artifacts_reconciled: number
  terminal_receipt_json: string | null
  created_at: string
  updated_at: string
  last_heartbeat_at: string | null
  terminal_at: string | null
  terminal_reason: string | null
}

type RunIdentityRow = {
  id: string
  workspace_id: string
  root_prd_id: string
  root_prd_file: string
  definition_hash: string
  graph_hash: string
  status: string
  effective_options_hash: string
}

type ChildTaskRow = {
  document_id: string
  task_id: string
  status: string
}

type SourceEventRow = { sequence: number; event_json: string }

export type ChildTaskMaterialization = {
  documentId: string
  taskId: string
  status: TaskRuntimeStatus
  markerContentHash: string
}

export type ReserveChildRunInput = {
  linkId: string
  childRunId: string
  workspaceId: string
  parentRunId: string
  parentDocumentId: string
  parentTaskId: string
  childDocumentId: string
  childRootPrdFile: string
  graphDefinitionHash: string
  graphHash: string
  inheritedOptionsHash: string
  materializationHash: string
  depth: number
  expectedDirectChildren: number
  parentPolicy: ChildParentPolicy
  completionPolicy?: ParentChildCompletionPolicy
  effectiveOptions: EffectiveRunOptions
  tasks: readonly ChildTaskMaterialization[]
  observability: ChildRunObservability
  createdAt?: string
}

export type ReserveChildRunResult = {
  link: ChildRunLinkRecord
  created: boolean
}

export type UpdateChildRunObservationInput = {
  linkId: string
  expectedRevision: number
  status?: Exclude<ChildRunStatus, "passed" | "failed" | "cancelled">
  leaseId?: string | null
  observability?: ChildRunObservability
  heartbeatAt?: string
  updatedAt?: string
  reason?: string | null
}

export type SettleChildRunInput = {
  linkId: string
  expectedRevision: number
  artifactsReconciled: boolean
  reason: string
  finishedAt?: string
}

export type ProjectChildEventInput = {
  linkId: string
  sourceEvent: EventEnvelope
  projectedEventId: string
  projectedAt?: string
}

export type ProjectChildEventResult = {
  projected: boolean
  eventId: string
  sourceSequence: number
}

export type ParentChildCompletionState = {
  readyForParentVerification: boolean
  links: readonly ChildRunLinkRecord[]
  reasons: readonly string[]
}

export type ChildRunTreeAggregate = {
  scope: "leaf-tasks"
  rootRunId: string
  runIds: readonly string[]
  childLinks: readonly ChildRunLinkRecord[]
  completed: number
  total: number
  runningChildren: number
  blockedChildren: number
  failedChildren: number
  usage: {
    executor: ChildUsageSummary
    judge: ChildUsageSummary
    combined: ChildUsageSummary
  }
  lastSourceEventSequence: number
  lastLogSequence: number
}

function now(): string {
  return new Date().toISOString()
}

function invalid(code: string, message: string, details: Record<string, unknown> = {}): RalphError {
  return new RalphError(code, message, {
    exitCode: code.endsWith("_NOT_FOUND") ? EXIT_CODES.invalidUsage : EXIT_CODES.conflict,
    details,
  })
}

function parseJson<T>(value: string, label: string, schema: { parse(value: unknown): T }): T {
  try {
    return schema.parse(JSON.parse(value))
  } catch (error) {
    throw new RalphError("RALPH_CHILD_LEDGER_INVALID", `Invalid ${label} in child runtime state`, {
      exitCode: EXIT_CODES.conflict,
      cause: error,
    })
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    )
  }
  return value
}

function contentHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")
}

function linkFromRow(row: ChildRunLinkRow): ChildRunLinkRecord {
  return ChildRunLinkRecordSchema.parse({
    schemaVersion: row.schema_version,
    id: row.id,
    workspaceId: row.workspace_id,
    parentRunId: row.parent_run_id,
    parentDocumentId: row.parent_document_id,
    parentTaskId: row.parent_task_id,
    childRunId: row.child_run_id,
    childDocumentId: row.child_document_id,
    childRootPrdFile: row.child_root_prd_file,
    graphDefinitionHash: row.graph_definition_hash,
    graphHash: row.graph_hash,
    inheritedOptionsHash: row.inherited_options_hash,
    materializationHash: row.materialization_hash,
    depth: row.depth,
    expectedDirectChildren: row.expected_direct_children,
    parentPolicy: row.parent_policy,
    completionPolicy: row.completion_policy,
    status: row.status,
    revision: row.revision,
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    observability: parseJson(
      row.observability_json,
      "child observability",
      ChildRunObservabilitySchema,
    ),
    artifactsReconciled: row.artifacts_reconciled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.last_heartbeat_at ? { lastHeartbeatAt: row.last_heartbeat_at } : {}),
    ...(row.terminal_at ? { terminalAt: row.terminal_at } : {}),
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
  })
}

function findLinkById(database: Database, linkId: string): ChildRunLinkRecord | undefined {
  const row = database
    .query<ChildRunLinkRow, [string]>(`SELECT ${LINK_COLUMNS} FROM child_run_links WHERE id = ?`)
    .get(linkId)
  return row ? linkFromRow(row) : undefined
}

function findLinkForParentInDatabase(
  database: Database,
  parentRunId: string,
  parentDocumentId: string,
  parentTaskId: string,
): ChildRunLinkRecord | undefined {
  const row = database
    .query<ChildRunLinkRow, [string, string, string]>(
      `SELECT ${LINK_COLUMNS} FROM child_run_links
       WHERE parent_run_id = ? AND parent_document_id = ? AND parent_task_id = ?`,
    )
    .get(parentRunId, parentDocumentId, parentTaskId)
  return row ? linkFromRow(row) : undefined
}

function findLinkForChildInDatabase(
  database: Database,
  childRunId: string,
): ChildRunLinkRecord | undefined {
  const row = database
    .query<ChildRunLinkRow, [string]>(
      `SELECT ${LINK_COLUMNS} FROM child_run_links WHERE child_run_id = ?`,
    )
    .get(childRunId)
  return row ? linkFromRow(row) : undefined
}

function runIdentity(database: Database, runId: string): RunIdentityRow | undefined {
  return (
    database
      .query<RunIdentityRow, [string]>(
        `SELECT id, workspace_id, root_prd_id, root_prd_file, definition_hash, graph_hash,
              status, effective_options_hash
       FROM runs WHERE id = ?`,
      )
      .get(runId) ?? undefined
  )
}

function requireLink(database: Database, linkId: string): ChildRunLinkRecord {
  const link = findLinkById(database, linkId)
  if (!link) throw invalid("RALPH_CHILD_LINK_NOT_FOUND", `Child link not found: ${linkId}`)
  return link
}

function assertReservationIdentity(
  existing: ChildRunLinkRecord,
  input: ReserveChildRunInput,
): void {
  const expected = {
    id: input.linkId,
    workspaceId: input.workspaceId,
    parentRunId: input.parentRunId,
    parentDocumentId: input.parentDocumentId,
    parentTaskId: input.parentTaskId,
    childRunId: input.childRunId,
    childDocumentId: input.childDocumentId,
    childRootPrdFile: input.childRootPrdFile,
    graphDefinitionHash: input.graphDefinitionHash,
    inheritedOptionsHash: input.inheritedOptionsHash,
    materializationHash: input.materializationHash,
    depth: input.depth,
    expectedDirectChildren: input.expectedDirectChildren,
    parentPolicy: input.parentPolicy,
    completionPolicy: input.completionPolicy ?? "all-descendants-passed-and-parent-verified",
  }
  const actual = Object.fromEntries(
    Object.keys(expected).map((key) => [key, Reflect.get(existing, key)]),
  )
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw invalid(
      "RALPH_CHILD_RESERVATION_IDENTITY_CONFLICT",
      "An existing child reservation does not match the pre-authored graph materialization",
      { expected, actual },
    )
  }
}

function appendChildEvent(
  database: Database,
  link: ChildRunLinkRecord,
  target: "parent" | "child",
  type: string,
  payload: Record<string, unknown>,
  level: EventLevel = "info",
  eventId?: string,
): void {
  appendEventInTransaction(
    database,
    {
      type,
      scope: "run",
      streamId: `run:${target === "parent" ? link.parentRunId : link.childRunId}`,
      workspaceId: link.workspaceId,
      runId: target === "parent" ? link.parentRunId : link.childRunId,
      documentId: target === "parent" ? link.parentDocumentId : link.childDocumentId,
      ...(target === "parent" ? { taskId: link.parentTaskId } : {}),
      ...(target === "child" ? { parentRunId: link.parentRunId } : {}),
      level,
      payload: {
        schemaVersion: 1,
        linkId: link.id,
        parentRunId: link.parentRunId,
        parentDocumentId: link.parentDocumentId,
        parentTaskId: link.parentTaskId,
        childRunId: link.childRunId,
        childDocumentId: link.childDocumentId,
        depth: link.depth,
        ...payload,
      },
    },
    eventId,
  )
}

function rootRunForChildTree(database: Database, runId: string): string {
  let current = runId
  const visited = new Set<string>()
  while (true) {
    if (visited.has(current)) {
      throw invalid("RALPH_CHILD_LINK_CYCLE", "Child ownership contains a parent-run cycle", {
        runId: current,
      })
    }
    visited.add(current)
    const owner = database
      .query<{ parent_run_id: string }, [string]>(
        "SELECT parent_run_id FROM child_run_links WHERE child_run_id = ?",
      )
      .get(current)
    if (!owner) return current
    current = owner.parent_run_id
  }
}

function leafProgressInDatabase(
  database: Database,
  rootRunId: string,
): { completed: number; total: number; runIds: string[] } {
  const links: {
    parentRunId: string
    parentDocumentId: string
    parentTaskId: string
    childRunId: string
  }[] = []
  const runIds = [rootRunId]
  const queue = [rootRunId]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const parentRunId = queue.shift() as string
    if (visited.has(parentRunId)) {
      throw invalid("RALPH_CHILD_LINK_CYCLE", "Child ownership contains a run cycle")
    }
    visited.add(parentRunId)
    const direct = database
      .query<
        { parent_document_id: string; parent_task_id: string; child_run_id: string },
        [string]
      >(
        `SELECT parent_document_id, parent_task_id, child_run_id
         FROM child_run_links WHERE parent_run_id = ? ORDER BY id`,
      )
      .all(parentRunId)
    for (const child of direct) {
      links.push({
        parentRunId,
        parentDocumentId: child.parent_document_id,
        parentTaskId: child.parent_task_id,
        childRunId: child.child_run_id,
      })
      runIds.push(child.child_run_id)
      queue.push(child.child_run_id)
    }
  }
  const nonLeaf = new Set(
    links.map(
      (link) => `${link.parentRunId}\u0000${link.parentDocumentId}\u0000${link.parentTaskId}`,
    ),
  )
  let completed = 0
  let total = 0
  for (const scopeRunId of runIds) {
    const tasks = database
      .query<ChildTaskRow, [string]>(
        "SELECT document_id, task_id, status FROM run_tasks WHERE run_id = ?",
      )
      .all(scopeRunId)
    for (const task of tasks) {
      if (nonLeaf.has(`${scopeRunId}\u0000${task.document_id}\u0000${task.task_id}`)) continue
      total += 1
      if (["completed", "completed_with_override"].includes(task.status)) completed += 1
    }
  }
  return { completed, total, runIds }
}

function appendTreeProgressEvent(database: Database, link: ChildRunLinkRecord): void {
  const rootRunId = rootRunForChildTree(database, link.parentRunId)
  const progress = leafProgressInDatabase(database, rootRunId)
  appendEventInTransaction(database, {
    type: "progress.updated",
    scope: "run",
    streamId: `run:${rootRunId}`,
    workspaceId: link.workspaceId,
    runId: rootRunId,
    documentId: link.parentDocumentId,
    taskId: link.parentTaskId,
    payload: {
      completed: progress.completed,
      total: progress.total,
      aggregateScope: "leaf-tasks",
      childLinkId: link.id,
      childRunId: link.childRunId,
      runIds: progress.runIds,
    },
  })
}

export function reserveChildRun(path: string, input: ReserveChildRunInput): ReserveChildRunResult {
  const effectiveOptions = EffectiveRunOptionsSchema.parse(input.effectiveOptions)
  if (
    effectiveOptions.contentHash !== input.inheritedOptionsHash ||
    input.inheritedOptionsHash !== input.effectiveOptions.contentHash
  ) {
    throw invalid(
      "RALPH_CHILD_OPTIONS_HASH_MISMATCH",
      "Child effective options do not match the inherited options hash",
    )
  }
  const parentPolicy = ChildParentPolicySchema.parse(input.parentPolicy)
  const completionPolicy = ParentChildCompletionPolicySchema.parse(
    input.completionPolicy ?? "all-descendants-passed-and-parent-verified",
  )
  const observability = ChildRunObservabilitySchema.parse(input.observability)
  if (input.depth < 1 || !Number.isSafeInteger(input.depth)) {
    throw invalid("RALPH_CHILD_DEPTH_INVALID", "Child depth must be a positive safe integer")
  }
  if (input.expectedDirectChildren < 0 || !Number.isSafeInteger(input.expectedDirectChildren)) {
    throw invalid(
      "RALPH_CHILD_COUNT_INVALID",
      "Expected direct child count must be a non-negative safe integer",
    )
  }
  if (input.tasks.length < 1) {
    throw invalid("RALPH_CHILD_TASKS_EMPTY", "A child run must materialize at least one task")
  }
  const taskKeys = input.tasks.map((task) => `${task.documentId}/${task.taskId}`)
  if (new Set(taskKeys).size !== taskKeys.length) {
    throw invalid("RALPH_CHILD_TASKS_DUPLICATED", "Child task materialization contains duplicates")
  }
  if (observability.progress.total !== input.tasks.length) {
    throw invalid(
      "RALPH_CHILD_PROGRESS_TOTAL_MISMATCH",
      "Initial child progress total must equal the number of direct materialized tasks",
      { total: observability.progress.total, taskCount: input.tasks.length },
    )
  }
  for (const task of input.tasks) {
    TaskRecordSchema.parse({
      runId: input.childRunId,
      documentId: task.documentId,
      taskId: task.taskId,
      status: TaskRuntimeStatusSchema.parse(task.status),
      markerContentHash: task.markerContentHash,
      updatedAt: input.createdAt ?? now(),
    })
  }

  return withLedger(path, (database) =>
    database.transaction(() => {
      const existing = findLinkForParentInDatabase(
        database,
        input.parentRunId,
        input.parentDocumentId,
        input.parentTaskId,
      )
      if (existing) {
        assertReservationIdentity(existing, input)
        if (!runIdentity(database, existing.childRunId)) {
          throw invalid(
            "RALPH_CHILD_RUN_LINK_DANGLING",
            "The durable child link exists but its run record is missing",
          )
        }
        return { link: existing, created: false }
      }

      const parent = runIdentity(database, input.parentRunId)
      if (!parent) {
        throw invalid(
          "RALPH_CHILD_PARENT_RUN_NOT_FOUND",
          `Parent run not found: ${input.parentRunId}`,
        )
      }
      if (parent.workspace_id !== input.workspaceId) {
        throw invalid(
          "RALPH_CHILD_WORKSPACE_MISMATCH",
          "Parent and child reservation must belong to the same workspace ledger",
        )
      }
      if (parent.definition_hash !== input.graphDefinitionHash) {
        throw invalid(
          "RALPH_CHILD_GRAPH_DEFINITION_MISMATCH",
          "Parent run definition differs from the pre-validated child graph",
          { expected: parent.definition_hash, actual: input.graphDefinitionHash },
        )
      }
      if (["completed", "failed", "cancelled"].includes(parent.status)) {
        throw invalid(
          "RALPH_CHILD_PARENT_RUN_TERMINAL",
          "A terminal parent run cannot reserve a new child",
          { parentStatus: parent.status },
        )
      }
      const parentTask = database
        .query<{ status: string }, [string, string, string]>(
          `SELECT status FROM run_tasks
           WHERE run_id = ? AND document_id = ? AND task_id = ?`,
        )
        .get(input.parentRunId, input.parentDocumentId, input.parentTaskId)
      if (!parentTask) {
        throw invalid(
          "RALPH_CHILD_PARENT_TASK_NOT_FOUND",
          "Parent task is not materialized in the parent run",
        )
      }
      if (
        parentTask.status !== "active" &&
        parentTask.status !== "completed" &&
        parentTask.status !== "completed_with_override"
      ) {
        throw invalid(
          "RALPH_CHILD_PARENT_TASK_NOT_MATERIALIZABLE",
          "Parent task must be active or already completed before its child is reserved",
          { parentTaskStatus: parentTask.status },
        )
      }
      if (
        parentTask.status !== "active" &&
        input.tasks.some(
          (task) => task.status !== "completed" && task.status !== "completed_with_override",
        )
      ) {
        throw invalid(
          "RALPH_CHILD_PRECOMPLETED_TREE_INCONSISTENT",
          "A completed parent can only reconcile a child whose direct markers are completed",
          { parentTaskStatus: parentTask.status },
        )
      }
      if (runIdentity(database, input.childRunId)) {
        throw invalid(
          "RALPH_CHILD_RUN_ID_COLLISION",
          "The deterministic child run ID is already owned by another run",
          { childRunId: input.childRunId },
        )
      }

      const timestamp = input.createdAt ?? now()
      database
        .query(
          `INSERT INTO runs(
            id, schema_version, workspace_id, root_prd_id, root_prd_file, definition_hash,
            graph_hash, mode, status, effective_options_hash, effective_options_json,
            created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?)`,
        )
        .run(
          input.childRunId,
          input.workspaceId,
          input.childDocumentId,
          input.childRootPrdFile,
          input.graphDefinitionHash,
          input.graphHash,
          effectiveOptions.mode.value,
          input.inheritedOptionsHash,
          JSON.stringify(effectiveOptions),
          timestamp,
          timestamp,
        )

      for (const task of input.tasks) {
        database
          .query(
            `INSERT INTO run_tasks(
              run_id, document_id, task_id, status, marker_content_hash, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.childRunId,
            task.documentId,
            task.taskId,
            TaskRuntimeStatusSchema.parse(task.status),
            task.markerContentHash,
            timestamp,
          )
      }

      database
        .query(
          `INSERT INTO child_run_links(
            id, schema_version, workspace_id, parent_run_id, parent_document_id,
            parent_task_id, child_run_id, child_document_id, child_root_prd_file,
            graph_definition_hash, graph_hash, inherited_options_hash, materialization_hash,
            depth, expected_direct_children, parent_policy, completion_policy, status, revision, observability_json,
            artifacts_reconciled, created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 0, ?, 0, ?, ?)`,
        )
        .run(
          input.linkId,
          input.workspaceId,
          input.parentRunId,
          input.parentDocumentId,
          input.parentTaskId,
          input.childRunId,
          input.childDocumentId,
          input.childRootPrdFile,
          input.graphDefinitionHash,
          input.graphHash,
          input.inheritedOptionsHash,
          input.materializationHash,
          input.depth,
          input.expectedDirectChildren,
          parentPolicy,
          completionPolicy,
          JSON.stringify(observability),
          timestamp,
          timestamp,
        )
      const link = requireLink(database, input.linkId)
      RunRecordSchema.parse({
        schemaVersion: 1,
        id: input.childRunId,
        workspaceId: input.workspaceId,
        rootPrdId: input.childDocumentId,
        rootPrdFile: input.childRootPrdFile,
        definitionHash: input.graphDefinitionHash,
        graphHash: input.graphHash,
        mode: effectiveOptions.mode.value,
        status: "created",
        effectiveOptionsHash: input.inheritedOptionsHash,
        effectiveOptions,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      appendChildEvent(database, link, "parent", "child.run.reserved", {
        status: link.status,
        materializationHash: link.materializationHash,
        totalTasks: link.observability.progress.total,
        parentPolicy: link.parentPolicy,
        completionPolicy: link.completionPolicy,
      })
      appendChildEvent(database, link, "child", "run.created", {
        status: "created",
        rootPrdId: input.childDocumentId,
        definitionHash: input.graphDefinitionHash,
        graphHash: input.graphHash,
      })
      appendTreeProgressEvent(database, link)
      return { link, created: true }
    })(),
  )
}

export function getChildRunLink(path: string, linkId: string): ChildRunLinkRecord | undefined {
  return withLedger(path, (database) => findLinkById(database, linkId))
}

export function getChildRunLinkForParent(
  path: string,
  parentRunId: string,
  parentDocumentId: string,
  parentTaskId: string,
): ChildRunLinkRecord | undefined {
  return withLedger(path, (database) =>
    findLinkForParentInDatabase(database, parentRunId, parentDocumentId, parentTaskId),
  )
}

export function getChildRunOwnerLink(
  path: string,
  childRunId: string,
): ChildRunLinkRecord | undefined {
  return withLedger(path, (database) => findLinkForChildInDatabase(database, childRunId))
}

export function resolveChildRunTreeRoot(path: string, runId: string): string {
  return withLedger(path, (database) => rootRunForChildTree(database, runId))
}

export function listDirectChildRunLinks(path: string, parentRunId: string): ChildRunLinkRecord[] {
  return withLedger(path, (database) =>
    database
      .query<ChildRunLinkRow, [string]>(
        `SELECT ${LINK_COLUMNS} FROM child_run_links
         WHERE parent_run_id = ? ORDER BY depth DESC, created_at, id`,
      )
      .all(parentRunId)
      .map(linkFromRow),
  )
}

export function listChildRunTree(path: string, rootRunId: string): ChildRunLinkRecord[] {
  return withLedger(path, (database) => {
    const links: ChildRunLinkRecord[] = []
    const queue = [rootRunId]
    const visitedRuns = new Set<string>()
    while (queue.length > 0) {
      const parentRunId = queue.shift() as string
      if (visitedRuns.has(parentRunId)) {
        throw invalid("RALPH_CHILD_LINK_CYCLE", "Durable child links contain a run cycle", {
          runId: parentRunId,
        })
      }
      visitedRuns.add(parentRunId)
      const direct = database
        .query<ChildRunLinkRow, [string]>(
          `SELECT ${LINK_COLUMNS} FROM child_run_links
           WHERE parent_run_id = ? ORDER BY depth, created_at, id`,
        )
        .all(parentRunId)
        .map(linkFromRow)
      for (const link of direct) {
        if (visitedRuns.has(link.childRunId) || queue.includes(link.childRunId)) {
          throw invalid("RALPH_CHILD_LINK_CYCLE", "Durable child links contain a run cycle", {
            linkId: link.id,
            childRunId: link.childRunId,
          })
        }
        links.push(link)
        queue.push(link.childRunId)
      }
    }
    return links.sort(
      (left, right) =>
        left.depth - right.depth ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
  })
}

export function findDeepestResumableChildRun(
  path: string,
  rootRunId: string,
): ChildRunLinkRecord | undefined {
  return listChildRunTree(path, rootRunId)
    .filter((link) => !["passed", "failed", "cancelled"].includes(link.status))
    .sort(
      (left, right) =>
        right.depth - left.depth ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )[0]
}

function assertLeaseBinding(database: Database, link: ChildRunLinkRecord, leaseId: string): void {
  const lease = database
    .query<
      { workspace_id: string; run_id: string | null; parent_run_id: string | null; status: string },
      [string]
    >(`SELECT workspace_id, run_id, parent_run_id, status FROM leases WHERE id = ?`)
    .get(leaseId)
  if (
    !lease ||
    lease.workspace_id !== link.workspaceId ||
    lease.run_id !== link.childRunId ||
    lease.parent_run_id !== link.parentRunId ||
    lease.status !== "active"
  ) {
    throw invalid(
      "RALPH_CHILD_LEASE_BINDING_INVALID",
      "Child observation requires an active lease bound to the child and parent runs",
      { linkId: link.id, leaseId },
    )
  }
}

export function updateChildRunObservation(
  path: string,
  input: UpdateChildRunObservationInput,
): ChildRunLinkRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const current = requireLink(database, input.linkId)
      if (current.revision !== input.expectedRevision) {
        throw invalid(
          "RALPH_CHILD_LINK_REVISION_CONFLICT",
          "Child link changed before the observation could be persisted",
          { expected: input.expectedRevision, actual: current.revision },
        )
      }
      const status = input.status ? ChildRunStatusSchema.parse(input.status) : current.status
      if (!canTransitionChildRunStatus(current.status, status)) {
        throw invalid(
          "RALPH_CHILD_STATUS_TRANSITION_INVALID",
          `Invalid child status transition: ${current.status} -> ${status}`,
        )
      }
      if (status === "passed" || status === "failed" || status === "cancelled") {
        throw invalid(
          "RALPH_CHILD_TERMINAL_SETTLEMENT_REQUIRED",
          "Terminal child status requires settleChildRun and a content-hashed receipt",
        )
      }
      const leaseId = input.leaseId === undefined ? current.leaseId : (input.leaseId ?? undefined)
      if (leaseId) assertLeaseBinding(database, current, leaseId)
      const observability = input.observability
        ? ChildRunObservabilitySchema.parse(input.observability)
        : current.observability
      const updatedAt = input.updatedAt ?? now()
      const result = database
        .query(
          `UPDATE child_run_links
           SET status = ?, revision = revision + 1, lease_id = ?, observability_json = ?,
               updated_at = ?, last_heartbeat_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          status,
          leaseId ?? null,
          JSON.stringify(observability),
          updatedAt,
          input.heartbeatAt ?? current.lastHeartbeatAt ?? null,
          current.id,
          current.revision,
        )
      if (result.changes !== 1) {
        throw invalid(
          "RALPH_CHILD_LINK_REVISION_CONFLICT",
          "Child link revision changed during observation persistence",
        )
      }
      const updated = requireLink(database, current.id)
      appendChildEvent(database, updated, "parent", "child.run.observed", {
        status: updated.status,
        previousStatus: current.status,
        progress: updated.observability.progress,
        usage: {
          executor: updated.observability.executorUsage,
          judge: updated.observability.judgeUsage,
          combined: updated.observability.combinedUsage,
        },
        watchdogStatus: updated.observability.watchdogStatus,
        ...(input.reason ? { reason: input.reason } : {}),
        revision: updated.revision,
      })
      if (
        JSON.stringify(current.observability.progress) !==
        JSON.stringify(updated.observability.progress)
      ) {
        appendTreeProgressEvent(database, updated)
      }
      return updated
    })(),
  )
}

function terminalReceipt(
  link: ChildRunLinkRecord,
  status: "passed" | "failed" | "cancelled",
  artifactsReconciled: boolean,
  finishedAt: string,
  reason: string,
): ChildRunTerminalReceipt {
  const projection = {
    schemaVersion: 1 as const,
    linkId: link.id,
    childRunId: link.childRunId,
    status,
    progress: link.observability.progress,
    artifactsReconciled,
    graphHash: link.graphHash,
    finishedAt,
    reason,
  }
  return ChildRunTerminalReceiptSchema.parse({
    ...projection,
    contentHash: contentHash(projection),
  })
}

export function settleChildRun(path: string, input: SettleChildRunInput): ChildRunLinkRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const current = requireLink(database, input.linkId)
      if (current.revision !== input.expectedRevision) {
        throw invalid(
          "RALPH_CHILD_LINK_REVISION_CONFLICT",
          "Child link changed before terminal settlement",
          { expected: input.expectedRevision, actual: current.revision },
        )
      }
      const run = runIdentity(database, current.childRunId)
      if (!run) {
        throw invalid("RALPH_CHILD_RUN_NOT_FOUND", `Child run not found: ${current.childRunId}`)
      }
      const runStatus = RunStatusSchema.parse(run.status)
      const status = childRunStatusFromRunStatus(runStatus)
      if (status !== "passed" && status !== "failed" && status !== "cancelled") {
        throw invalid(
          "RALPH_CHILD_RUN_NOT_TERMINAL",
          "Child link cannot settle before its run is terminal",
          { runStatus },
        )
      }
      if (!canTransitionChildRunStatus(current.status, status)) {
        throw invalid(
          "RALPH_CHILD_STATUS_TRANSITION_INVALID",
          `Invalid child terminal transition: ${current.status} -> ${status}`,
        )
      }
      const tasks = database
        .query<ChildTaskRow, [string]>(
          `SELECT document_id, task_id, status FROM run_tasks
           WHERE run_id = ? ORDER BY document_id, task_id`,
        )
        .all(current.childRunId)
      const completed = tasks.filter((task) =>
        ["completed", "completed_with_override"].includes(task.status),
      ).length
      const observability = ChildRunObservabilitySchema.parse({
        ...current.observability,
        progress: {
          completed,
          total: tasks.length,
        },
      })
      if (status === "passed" && completed !== tasks.length) {
        throw invalid(
          "RALPH_CHILD_TASKS_INCOMPLETE",
          "A completed child run still contains non-completed task records",
          { completed, total: tasks.length },
        )
      }
      if (status === "passed" && !input.artifactsReconciled) {
        throw invalid(
          "RALPH_CHILD_ARTIFACTS_NOT_RECONCILED",
          "A passed child must reconcile its artifacts into the parent scope",
        )
      }
      const directChildren = database
        .query<{ status: string }, [string]>(
          "SELECT status FROM child_run_links WHERE parent_run_id = ? ORDER BY id",
        )
        .all(current.childRunId)
      if (
        status === "passed" &&
        (directChildren.length !== current.expectedDirectChildren ||
          directChildren.some((child) => child.status !== "passed"))
      ) {
        throw invalid(
          "RALPH_CHILD_DESCENDANTS_INCOMPLETE",
          "A child cannot pass before every expected direct child is durably passed",
          {
            expected: current.expectedDirectChildren,
            observed: directChildren.length,
            statuses: directChildren.map((child) => child.status),
          },
        )
      }
      const finishedAt = input.finishedAt ?? now()
      const receipt = terminalReceipt(
        { ...current, observability },
        status,
        input.artifactsReconciled,
        finishedAt,
        input.reason,
      )
      const result = database
        .query(
          `UPDATE child_run_links
           SET status = ?, revision = revision + 1, observability_json = ?,
               artifacts_reconciled = ?, terminal_receipt_json = ?, updated_at = ?,
               terminal_at = ?, terminal_reason = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          status,
          JSON.stringify(observability),
          input.artifactsReconciled ? 1 : 0,
          JSON.stringify(receipt),
          finishedAt,
          finishedAt,
          input.reason,
          current.id,
          current.revision,
        )
      if (result.changes !== 1) {
        throw invalid(
          "RALPH_CHILD_LINK_REVISION_CONFLICT",
          "Child link revision changed during terminal settlement",
        )
      }
      const settled = requireLink(database, current.id)
      const level = status === "passed" ? "info" : "error"
      appendChildEvent(
        database,
        settled,
        "parent",
        `child.run.${status}`,
        {
          status,
          progress: settled.observability.progress,
          artifactsReconciled: settled.artifactsReconciled,
          terminalReceipt: receipt,
        },
        level,
      )
      appendChildEvent(
        database,
        settled,
        "child",
        "child.run.settled",
        {
          status,
          terminalReceipt: receipt,
        },
        level,
      )
      appendTreeProgressEvent(database, settled)
      return settled
    })(),
  )
}

export function getChildRunTerminalReceipt(
  path: string,
  linkId: string,
): ChildRunTerminalReceipt | undefined {
  return withLedger(path, (database) => {
    const row = database
      .query<{ terminal_receipt_json: string | null }, [string]>(
        "SELECT terminal_receipt_json FROM child_run_links WHERE id = ?",
      )
      .get(linkId)
    if (!row) throw invalid("RALPH_CHILD_LINK_NOT_FOUND", `Child link not found: ${linkId}`)
    const receipt = row.terminal_receipt_json
      ? parseJson(
          row.terminal_receipt_json,
          "child terminal receipt",
          ChildRunTerminalReceiptSchema,
        )
      : undefined
    if (receipt) {
      const { contentHash: recordedHash, ...projection } = receipt
      if (contentHash(projection) !== recordedHash) {
        throw invalid(
          "RALPH_CHILD_TERMINAL_RECEIPT_HASH_MISMATCH",
          "Child terminal receipt does not match its content hash",
          { linkId, recordedHash },
        )
      }
    }
    return receipt
  })
}

function eventProjectionKind(
  event: EventEnvelope,
): "log" | "usage" | "progress" | "status" | "event" {
  if (event.type.includes("usage") || event.type.includes("token")) return "usage"
  if (event.type.includes("progress") || event.type.startsWith("task.")) return "progress"
  if (event.type.startsWith("run.") || event.type.includes("watchdog")) return "status"
  if (
    event.type.includes("output") ||
    event.type.includes("delta") ||
    event.level === "warn" ||
    event.level === "error"
  )
    return "log"
  return "event"
}

export function projectChildEventToParent(
  path: string,
  input: ProjectChildEventInput,
): ProjectChildEventResult {
  const source = EventEnvelopeConsumerSchema.parse(input.sourceEvent)
  return withLedger(path, (database) =>
    database.transaction(() => {
      const link = requireLink(database, input.linkId)
      if (source.runId !== link.childRunId || source.workspaceId !== link.workspaceId) {
        throw invalid(
          "RALPH_CHILD_EVENT_SCOPE_MISMATCH",
          "Only events from the linked child run can be projected to its parent",
          {
            sourceRunId: source.runId,
            childRunId: link.childRunId,
            sourceWorkspaceId: source.workspaceId,
            linkWorkspaceId: link.workspaceId,
          },
        )
      }
      const persisted = database
        .query<SourceEventRow, [string]>(
          "SELECT sequence, event_json FROM events WHERE event_id = ?",
        )
        .get(source.eventId)
      if (!persisted || persisted.sequence !== source.sequence) {
        throw invalid(
          "RALPH_CHILD_EVENT_NOT_PERSISTED",
          "A child event must exist in the durable ledger before projection",
          { sourceEventId: source.eventId, sourceSequence: source.sequence },
        )
      }
      const durableSource = EventEnvelopeConsumerSchema.parse(JSON.parse(persisted.event_json))
      if (contentHash(durableSource) !== contentHash(source)) {
        throw invalid(
          "RALPH_CHILD_EVENT_CONTENT_MISMATCH",
          "Projected child event does not match the immutable ledger envelope",
          { sourceEventId: source.eventId },
        )
      }
      const prior = database
        .query<{ projected_event_id: string; source_sequence: number }, [string, string]>(
          `SELECT projected_event_id, source_sequence FROM child_event_projections
           WHERE link_id = ? AND source_event_id = ?`,
        )
        .get(link.id, source.eventId)
      if (prior) {
        return {
          projected: false,
          eventId: prior.projected_event_id,
          sourceSequence: prior.source_sequence,
        }
      }
      const kind = eventProjectionKind(source)
      appendChildEvent(
        database,
        link,
        "parent",
        "child.event.projected",
        {
          kind,
          sourceEventId: source.eventId,
          sourceSequence: source.sequence,
          sourceType: source.type,
          sourceLevel: source.level,
          sourceDocumentId: source.documentId,
          sourceTaskId: source.taskId,
          sourceAttemptId: source.attemptId,
          sourceCallId: source.callId,
          sourceTimestamp: source.timestamp,
          sourcePayload: source.payload,
        },
        source.level,
        input.projectedEventId,
      )
      const projectedAt = input.projectedAt ?? now()
      database
        .query(
          `INSERT INTO child_event_projections(
            link_id, source_event_id, source_sequence, projected_event_id, projected_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(link.id, source.eventId, source.sequence, input.projectedEventId, projectedAt)
      const observability = ChildRunObservabilitySchema.parse({
        ...link.observability,
        lastSourceEventSequence: Math.max(
          link.observability.lastSourceEventSequence,
          source.sequence,
        ),
        lastLogSequence:
          kind === "log"
            ? Math.max(link.observability.lastLogSequence, source.sequence)
            : link.observability.lastLogSequence,
      })
      const updated = database
        .query(
          `UPDATE child_run_links
           SET revision = revision + 1, observability_json = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(JSON.stringify(observability), projectedAt, link.id, link.revision)
      if (updated.changes !== 1) {
        throw invalid(
          "RALPH_CHILD_LINK_REVISION_CONFLICT",
          "Child link revision changed during event projection",
        )
      }
      if (kind === "progress") appendTreeProgressEvent(database, requireLink(database, link.id))
      return {
        projected: true,
        eventId: input.projectedEventId,
        sourceSequence: source.sequence,
      }
    })(),
  )
}

export function parentChildCompletionState(
  path: string,
  input: {
    parentRunId: string
    parentDocumentId: string
    parentTaskId: string
    expectedChildDocumentId?: string
  },
): ParentChildCompletionState {
  const link = getChildRunLinkForParent(
    path,
    input.parentRunId,
    input.parentDocumentId,
    input.parentTaskId,
  )
  const reasons: string[] = []
  if (!link) {
    if (input.expectedChildDocumentId)
      reasons.push("The pre-authored child run has not been reserved")
    return { readyForParentVerification: !input.expectedChildDocumentId, links: [], reasons }
  }
  if (input.expectedChildDocumentId && link.childDocumentId !== input.expectedChildDocumentId) {
    reasons.push("The durable child link targets a different compiled document")
  }
  if (link.status !== "passed") reasons.push(`Child run is ${link.status}, not passed`)
  if (!link.artifactsReconciled) reasons.push("Child artifacts are not reconciled")
  const receipt = getChildRunTerminalReceipt(path, link.id)
  if (!receipt || receipt.status !== "passed") reasons.push("A passed terminal receipt is missing")
  return { readyForParentVerification: reasons.length === 0, links: [link], reasons }
}

export function assertParentChildCompletionReady(
  path: string,
  input: {
    parentRunId: string
    parentDocumentId: string
    parentTaskId: string
    expectedChildDocumentId: string
  },
): ChildRunLinkRecord {
  const state = parentChildCompletionState(path, input)
  const link = state.links[0]
  if (!state.readyForParentVerification || !link) {
    throw invalid(
      "RALPH_PARENT_CHILD_COMPLETION_NOT_READY",
      "Parent verification cannot start before its pre-authored child passes",
      { ...input, reasons: state.reasons },
    )
  }
  return link
}

export function readChildRunTreeAggregate(path: string, rootRunId: string): ChildRunTreeAggregate {
  const links = listChildRunTree(path, rootRunId)
  return withLedger(path, (database) => {
    const runIds = [rootRunId, ...links.map((link) => link.childRunId)]
    const nonLeafTaskKeys = new Set(
      links.map(
        (link) => `${link.parentRunId}\u0000${link.parentDocumentId}\u0000${link.parentTaskId}`,
      ),
    )
    let total = 0
    let completed = 0
    for (const runId of runIds) {
      const tasks = database
        .query<ChildTaskRow, [string]>(
          "SELECT document_id, task_id, status FROM run_tasks WHERE run_id = ?",
        )
        .all(runId)
      for (const task of tasks) {
        if (nonLeafTaskKeys.has(`${runId}\u0000${task.document_id}\u0000${task.task_id}`)) continue
        total += 1
        if (["completed", "completed_with_override"].includes(task.status)) completed += 1
      }
    }
    return {
      scope: "leaf-tasks",
      rootRunId,
      runIds,
      childLinks: links,
      completed,
      total,
      runningChildren: links.filter((link) => ["starting", "running"].includes(link.status)).length,
      blockedChildren: links.filter((link) =>
        ["waiting", "blocked", "interrupted"].includes(link.status),
      ).length,
      failedChildren: links.filter((link) => ["failed", "cancelled"].includes(link.status)).length,
      usage: {
        executor: aggregateChildUsageSummaries(
          links.map((link) => link.observability.executorUsage),
          "child-tree:executor",
        ),
        judge: aggregateChildUsageSummaries(
          links.map((link) => link.observability.judgeUsage),
          "child-tree:judge",
        ),
        combined: aggregateChildUsageSummaries(
          links.map((link) => link.observability.combinedUsage),
          "child-tree:combined",
        ),
      },
      lastSourceEventSequence: links.reduce(
        (maximum, link) => Math.max(maximum, link.observability.lastSourceEventSequence),
        0,
      ),
      lastLogSequence: links.reduce(
        (maximum, link) => Math.max(maximum, link.observability.lastLogSequence),
        0,
      ),
    }
  })
}
