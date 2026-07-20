import type { Database } from "bun:sqlite"
import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  type AttemptCounters,
  AttemptCountersSchema,
  type AttemptPhase,
  AttemptPhaseSchema,
  AttemptRecordSchema,
  type AttemptStatus,
  AttemptStatusSchema,
  type CompletionDecision,
  CompletionDecisionSchema,
  type CompletionOverrideAudit,
  CompletionOverrideAuditSchema,
  type EffectiveRunOptions,
  EffectiveRunOptionsSchema,
  type EvidenceBundle,
  EvidenceBundleSchema,
  EXIT_CODES,
  type ExecutionReport,
  ExecutionReportSchema,
  type ExecutorOutcome,
  ExecutorOutcomeSchema,
  type GateResult,
  GateResultSchema,
  type GitBaseline,
  GitBaselineSchema,
  RalphError,
  type RunMode,
  RunModeSchema,
  RunRecordSchema,
  type RunStatus,
  RunStatusSchema,
  type RunWorkSource,
  RunWorkSourceSchema,
  TaskRecordSchema,
  type TaskRuntimeStatus,
  TaskRuntimeStatusSchema,
  type WatchdogEvaluation,
  WatchdogEvaluationSchema,
} from "@ralph-next/domain"
import type { EventInput, EventLevel } from "@ralph-next/telemetry"
import {
  assertEvidenceBundleContentHash,
  type EvidenceObjectReceipt,
  readEvidenceBundleObjectSync,
} from "./evidence-store"
import { appendEventInTransaction, withLedger } from "./ledger"
import type { WorkspaceLayout } from "./paths"

export type JsonObject = Record<string, unknown>

export type RunRecord = {
  id: string
  schemaVersion: number
  workspaceId: string
  rootPrdId: string
  rootPrdFile: string
  source?: RunWorkSource
  definitionHash: string
  graphHash: string
  mode: RunMode
  status: RunStatus
  effectiveOptionsHash: string
  effectiveOptions: EffectiveRunOptions
  createdAt: string
  startedAt?: string
  finishedAt?: string
  stopReason?: string
  updatedAt: string
}

export type CreateRunInput = {
  id: string
  schemaVersion: number
  workspaceId: string
  rootPrdId: string
  rootPrdFile: string
  source?: RunWorkSource
  definitionHash: string
  graphHash: string
  mode: RunMode
  status: RunStatus
  effectiveOptionsHash: string
  effectiveOptions: EffectiveRunOptions
  createdAt?: string
  startedAt?: string
  event?: ExecutionMutationEvent
}

export type UpdateRunInput = {
  runId: string
  graphHash?: string
  status?: RunStatus
  startedAt?: string | null
  finishedAt?: string | null
  stopReason?: string | null
  updatedAt?: string
  event?: ExecutionMutationEvent
}

export type ResumableRunQuery = {
  workspaceId: string
  rootPrdFile: string
  definitionHash: string
  rootPrdId?: string
  runId?: string
}

export type ListRunsQuery = {
  workspaceId?: string
  statuses?: readonly RunStatus[]
  limit?: number
}

export type RunTaskRecord = {
  runId: string
  documentId: string
  taskId: string
  status: TaskRuntimeStatus
  markerContentHash: string
  activeAttemptId?: string
  completion?: CompletionDecision
  updatedAt: string
}

export type MaterializedTaskInput = {
  documentId: string
  taskId: string
  status: TaskRuntimeStatus
  markerContentHash: string
  updatedAt?: string
}

export type MaterializeTasksInput = {
  runId: string
  tasks: readonly MaterializedTaskInput[]
  event?: ExecutionMutationEvent
}

export type UpsertRunTaskInput = {
  runId: string
  documentId: string
  taskId: string
  status: TaskRuntimeStatus
  markerContentHash: string
  activeAttemptId?: string | null
  completion?: CompletionDecision | null
  updatedAt?: string
  event?: ExecutionMutationEvent
}

export type AttemptRecord = {
  id: string
  runId: string
  documentId: string
  taskId: string
  ordinal: number
  phase: AttemptPhase
  status: AttemptStatus
  contextManifestHash: string
  baseline: GitBaseline
  effectiveOptionsHash: string
  effectiveOptions: EffectiveRunOptions
  counters: AttemptCounters
  executorOutcome?: ExecutorOutcome
  evidenceBundleId?: string
  completionDecision?: CompletionDecision
  startedAt: string
  finishedAt?: string
  updatedAt: string
}

export type CreateAttemptInput = {
  id: string
  runId: string
  documentId: string
  taskId: string
  ordinal: number
  phase: AttemptPhase
  status: AttemptStatus
  contextManifestHash: string
  baseline: GitBaseline
  effectiveOptionsHash: string
  effectiveOptions: EffectiveRunOptions
  counters: AttemptCounters
  startedAt?: string
  event?: ExecutionMutationEvent
}

export type UpdateAttemptInput = {
  attemptId: string
  phase?: AttemptPhase
  status?: AttemptStatus
  contextManifestHash?: string
  baseline?: GitBaseline
  counters?: AttemptCounters
  executorOutcome?: ExecutorOutcome | null
  evidenceBundleId?: string | null
  completionDecision?: CompletionDecision | null
  finishedAt?: string | null
  updatedAt?: string
  event?: ExecutionMutationEvent
}

export type PersistAttemptWatchdogEvaluationInput = {
  attemptId: string
  events: readonly EventInput[]
  evaluation: WatchdogEvaluation
}

export const MODEL_CALL_STATUSES = [
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const
export type ModelCallStatus = (typeof MODEL_CALL_STATUSES)[number]

export type ModelCallRecord = {
  schemaVersion: 1
  id: string
  attemptId: string
  ordinal: number
  status: ModelCallStatus
  requestHash: string
  contextManifestHash: string
  outcome?: ExecutorOutcome
  startedAt: string
  finishedAt?: string
  updatedAt: string
}

export type CreateModelCallInput = {
  id: string
  attemptId: string
  ordinal: number
  requestHash: string
  contextManifestHash: string
  startedAt?: string
  event?: ExecutionMutationEvent
}

export type UpdateModelCallInput = {
  modelCallId: string
  status: Exclude<ModelCallStatus, "started">
  outcome?: ExecutorOutcome
  finishedAt?: string
  updatedAt?: string
  event?: ExecutionMutationEvent
}

export type ListAttemptsQuery = {
  runId: string
  documentId?: string
  taskId?: string
  statuses?: readonly AttemptStatus[]
}

export type GateResultRecord = {
  attemptId: string
  gateId: string
  result: GateResult
  createdAt: string
}

export type PersistGateResultInput = {
  attemptId: string
  gateId: string
  result: GateResult
  createdAt?: string
  event?: ExecutionMutationEvent
}

export type EvidenceBundleRecord = {
  id: string
  attemptId: string
  contentHash: string
  bundle: EvidenceBundle
  schemaVersion: 1 | 2
  contentRef?: string
  storageHash?: string
  sizeBytes?: number
  createdAt: string
}

export type PersistEvidenceBundleInput = {
  id: string
  attemptId: string
  contentHash: string
  bundle: EvidenceBundle
  storage?: EvidenceObjectReceipt
  createdAt?: string
  event?: ExecutionMutationEvent
}

export type RunReportRecord = {
  runId: string
  report: ExecutionReport
  updatedAt: string
}

export type PersistRunReportInput = {
  runId: string
  report: ExecutionReport
  updatedAt?: string
  event?: ExecutionMutationEvent
}

export type CompletionStatus = "prepared" | "marker_written" | "committed"

export type CompletionTransactionRecord = {
  id: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  status: CompletionStatus
  expectedBeforeHash: string
  expectedAfterHash?: string
  decision: CompletionDecision
  overrideAudit?: CompletionOverrideAudit
  preparedAt: string
  markerWrittenAt?: string
  committedAt?: string
}

export type PrepareCompletionInput = {
  id: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  expectedBeforeHash: string
  decision: CompletionDecision
  overrideAudit?: CompletionOverrideAudit
  preparedAt?: string
  event?: ExecutionMutationEvent
}

export type MarkCompletionMarkerWrittenInput = {
  completionId: string
  expectedAfterHash: string
  markerWrittenAt?: string
  event?: ExecutionMutationEvent
}

export type CommitCompletionInput = {
  completionId: string
  markerContentHash: string
  taskStatus?: "completed" | "completed_with_override"
  completion?: CompletionDecision
  committedAt?: string
  event?: ExecutionMutationEvent
}

/**
 * Completes a command-owned execution unit that has no writable PRD marker.
 * The same persisted evidence/decision checks used by marker completion are
 * enforced, but task state and attempt state settle atomically in the ledger.
 */
export type CommitRecordOnlyCompletionInput = {
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  markerContentHash: string
  decision: CompletionDecision
  overrideAudit?: CompletionOverrideAudit
  committedAt?: string
  event?: ExecutionMutationEvent
}

export type ReconcilePreparedCompletionInput =
  | ({ target: "marker_written" } & MarkCompletionMarkerWrittenInput)
  | ({ target: "committed" } & CommitCompletionInput)

export type ExecutionMutationEvent = {
  type?: string
  level?: EventLevel
  payload?: JsonObject
  correlationId?: string
  causationId?: string
}

export type RunLayout = {
  root: string
  manifest: string
  events: string
  raw: string
  evidence: string
  reports: string
  context: string
  artifacts: string
}

type RunRow = {
  id: string
  schema_version: number
  workspace_id: string
  root_prd_id: string
  root_prd_file: string
  source_json: string | null
  definition_hash: string
  graph_hash: string
  mode: string
  status: string
  effective_options_hash: string
  effective_options_json: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  stop_reason: string | null
  updated_at: string
}

type RunTaskRow = {
  run_id: string
  document_id: string
  task_id: string
  status: string
  marker_content_hash: string
  active_attempt_id: string | null
  completion_json: string | null
  updated_at: string
}

type AttemptRow = {
  id: string
  run_id: string
  document_id: string
  task_id: string
  ordinal: number
  phase: string
  status: string
  context_manifest_hash: string
  baseline_json: string
  effective_options_hash: string
  effective_options_json: string
  counters_json: string
  executor_outcome_json: string | null
  evidence_bundle_id: string | null
  completion_decision_json: string | null
  started_at: string
  finished_at: string | null
  updated_at: string
}

type ModelCallRow = {
  schema_version: number
  id: string
  attempt_id: string
  ordinal: number
  status: string
  request_hash: string
  context_manifest_hash: string
  outcome_json: string | null
  started_at: string
  finished_at: string | null
  updated_at: string | null
}

type GateResultRow = {
  attempt_id: string
  gate_id: string
  result_json: string
  created_at: string
}

type EvidenceBundleRow = {
  id: string
  attempt_id: string
  content_hash: string
  bundle_json: string
  schema_version: number
  content_ref: string | null
  storage_hash: string | null
  size_bytes: number | null
  created_at: string
}

type RunReportRow = {
  run_id: string
  report_json: string
  updated_at: string
}

type CompletionTransactionRow = {
  id: string
  run_id: string
  document_id: string
  task_id: string
  attempt_id: string
  status: CompletionStatus
  expected_before_hash: string
  expected_after_hash: string | null
  decision_json: string
  override_audit_json: string | null
  prepared_at: string
  marker_written_at: string | null
  committed_at: string | null
}

const RUN_COLUMNS = `id, schema_version, workspace_id, root_prd_id, root_prd_file, source_json,
  definition_hash, graph_hash, mode, status, effective_options_hash, effective_options_json,
  created_at, started_at, finished_at, stop_reason, updated_at`
const RUN_TASK_COLUMNS = `run_id, document_id, task_id, status, marker_content_hash,
  active_attempt_id, completion_json, updated_at`
const ATTEMPT_COLUMNS = `id, run_id, document_id, task_id, ordinal, phase, status,
  context_manifest_hash, baseline_json, effective_options_hash, effective_options_json,
  counters_json, executor_outcome_json,
  evidence_bundle_id, completion_decision_json, started_at, finished_at, updated_at`
const MODEL_CALL_COLUMNS = `schema_version, id, attempt_id, ordinal, status, request_hash,
  context_manifest_hash, outcome_json,
  started_at, finished_at, updated_at`
const COMPLETION_COLUMNS = `id, run_id, document_id, task_id, attempt_id, status,
  expected_before_hash, expected_after_hash, decision_json, override_audit_json, prepared_at,
  marker_written_at, committed_at`
const EVIDENCE_COLUMNS = `id, attempt_id, content_hash, bundle_json, schema_version,
  content_ref, storage_hash, size_bytes, created_at`

const RESUMABLE_STATUSES = ["created", "running", "stopping", "interrupted", "waiting"] as const

function now(): string {
  return new Date().toISOString()
}

type RuntimeSchema<T> = { parse(value: unknown): T }

function parseSchemaObject<T>(json: string, label: string, schema: RuntimeSchema<T>): T {
  try {
    return schema.parse(JSON.parse(json))
  } catch (error) {
    throw new RalphError(
      "RALPH_LEDGER_INVALID_RECORD",
      `Invalid ${label} in the execution ledger`,
      {
        exitCode: EXIT_CODES.operationalError,
        cause: error,
      },
    )
  }
}

function stringifyObject(value: unknown, label: string): string {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) throw new TypeError(`${label} is not JSON serializable`)
    return json
  } catch (error) {
    throw new RalphError("RALPH_LEDGER_INVALID_JSON", `Could not serialize ${label}`, {
      exitCode: EXIT_CODES.invalidUsage,
      cause: error,
    })
  }
}

function workspaceRootFromLedger(path: string): string {
  return resolve(dirname(path), "..", "..")
}

function evidenceObjectReceipt(row: EvidenceBundleRow): EvidenceObjectReceipt | undefined {
  if (row.content_ref === null && row.storage_hash === null && row.size_bytes === null)
    return undefined
  if (row.content_ref === null || row.storage_hash === null || row.size_bytes === null) {
    throw new RalphError(
      "RALPH_EVIDENCE_OBJECT_BINDING_INCOMPLETE",
      `Evidence bundle ${row.id} has an incomplete object-store binding`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  return {
    schemaVersion: 1,
    contentRef: row.content_ref,
    storageHash: row.storage_hash,
    sizeBytes: row.size_bytes,
  }
}

function evidenceFromRow(path: string, row: EvidenceBundleRow): EvidenceBundleRecord {
  const bundle = parseSchemaObject(row.bundle_json, "evidence bundle", EvidenceBundleSchema)
  assertEvidenceBundleContentHash(bundle)
  if (row.content_hash !== bundle.contentHash || row.schema_version !== bundle.schemaVersion) {
    throw new RalphError(
      "RALPH_EVIDENCE_LEDGER_BINDING_MISMATCH",
      `Evidence bundle ${row.id} does not match its ledger hash or schema version`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const storage = evidenceObjectReceipt(row)
  if (bundle.schemaVersion === 2 && !storage) {
    throw new RalphError(
      "RALPH_EVIDENCE_OBJECT_BINDING_MISSING",
      `Evidence bundle ${row.id} has no immutable object-store binding`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  if (storage) {
    const stored = readEvidenceBundleObjectSync(workspaceRootFromLedger(path), storage)
    if (
      stored.id !== bundle.id ||
      stored.contentHash !== bundle.contentHash ||
      stringifyObject(stored, "stored evidence object") !==
        stringifyObject(bundle, "ledger evidence bundle")
    ) {
      throw new RalphError(
        "RALPH_EVIDENCE_OBJECT_BINDING_MISMATCH",
        `Evidence object does not match ledger bundle ${row.id}`,
        { exitCode: EXIT_CODES.conflict },
      )
    }
  }
  return {
    id: row.id,
    attemptId: row.attempt_id,
    contentHash: row.content_hash,
    bundle,
    schemaVersion: bundle.schemaVersion,
    ...(storage
      ? {
          contentRef: storage.contentRef,
          storageHash: storage.storageHash,
          sizeBytes: storage.sizeBytes,
        }
      : {}),
    createdAt: row.created_at,
  }
}

function parseModelCallStatus(value: string): ModelCallStatus {
  if ((MODEL_CALL_STATUSES as readonly string[]).includes(value)) {
    return value as ModelCallStatus
  }
  throw invalidRecord("RALPH_MODEL_CALL_STATUS_INVALID", `Invalid model call status: ${value}`)
}

function parseRequestHash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw invalidRecord(
      "RALPH_MODEL_CALL_REQUEST_HASH_INVALID",
      "Model call requestHash must be a lowercase SHA-256 digest",
    )
  }
  return value
}

function parseModelCallContextHash(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw invalidRecord(
      "RALPH_MODEL_CALL_CONTEXT_HASH_INVALID",
      "Model call contextManifestHash must be a lowercase SHA-256 digest",
    )
  }
  return value
}

function recordNotFound(entity: string, id: string): RalphError {
  return new RalphError(
    `RALPH_${entity.toUpperCase()}_NOT_FOUND`,
    `${entity} record not found: ${id}`,
    { exitCode: EXIT_CODES.invalidUsage },
  )
}

function invalidRecord(code: string, message: string, details?: JsonObject): RalphError {
  return new RalphError(code, message, {
    exitCode: EXIT_CODES.invalidUsage,
    ...(details === undefined ? {} : { details }),
  })
}

function runFromRow(row: RunRow): RunRecord {
  const record: RunRecord = {
    id: row.id,
    schemaVersion: row.schema_version,
    workspaceId: row.workspace_id,
    rootPrdId: row.root_prd_id,
    rootPrdFile: row.root_prd_file,
    definitionHash: row.definition_hash,
    graphHash: row.graph_hash,
    mode: RunModeSchema.parse(row.mode),
    status: RunStatusSchema.parse(row.status),
    effectiveOptionsHash: row.effective_options_hash,
    effectiveOptions: parseSchemaObject(
      row.effective_options_json,
      "effective options",
      EffectiveRunOptionsSchema,
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.source_json !== null) {
    record.source = parseSchemaObject(row.source_json, "run work source", RunWorkSourceSchema)
  }
  if (row.started_at !== null) record.startedAt = row.started_at
  if (row.finished_at !== null) record.finishedAt = row.finished_at
  if (row.stop_reason !== null) record.stopReason = row.stop_reason
  RunRecordSchema.parse(record)
  return record
}

function taskFromRow(row: RunTaskRow): RunTaskRecord {
  const record: RunTaskRecord = {
    runId: row.run_id,
    documentId: row.document_id,
    taskId: row.task_id,
    status: TaskRuntimeStatusSchema.parse(row.status),
    markerContentHash: row.marker_content_hash,
    updatedAt: row.updated_at,
  }
  if (row.active_attempt_id !== null) record.activeAttemptId = row.active_attempt_id
  if (row.completion_json !== null) {
    record.completion = parseSchemaObject(
      row.completion_json,
      "task completion",
      CompletionDecisionSchema,
    )
  }
  TaskRecordSchema.parse(record)
  return record
}

function attemptFromRow(row: AttemptRow): AttemptRecord {
  const record: AttemptRecord = {
    id: row.id,
    runId: row.run_id,
    documentId: row.document_id,
    taskId: row.task_id,
    ordinal: row.ordinal,
    phase: AttemptPhaseSchema.parse(row.phase),
    status: AttemptStatusSchema.parse(row.status),
    contextManifestHash: row.context_manifest_hash,
    baseline: parseSchemaObject(row.baseline_json, "attempt baseline", GitBaselineSchema),
    effectiveOptionsHash: row.effective_options_hash,
    effectiveOptions: parseSchemaObject(
      row.effective_options_json,
      "attempt effective options",
      EffectiveRunOptionsSchema,
    ),
    counters: parseSchemaObject(row.counters_json, "attempt counters", AttemptCountersSchema),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  }
  if (row.executor_outcome_json !== null) {
    record.executorOutcome = parseSchemaObject(
      row.executor_outcome_json,
      "executor outcome",
      ExecutorOutcomeSchema,
    )
  }
  if (row.evidence_bundle_id !== null) record.evidenceBundleId = row.evidence_bundle_id
  if (row.completion_decision_json !== null) {
    record.completionDecision = parseSchemaObject(
      row.completion_decision_json,
      "completion decision",
      CompletionDecisionSchema,
    )
  }
  if (row.finished_at !== null) record.finishedAt = row.finished_at
  AttemptRecordSchema.parse(record)
  return record
}

function modelCallFromRow(row: ModelCallRow): ModelCallRecord {
  const record: ModelCallRecord = {
    schemaVersion: 1,
    id: row.id,
    attemptId: row.attempt_id,
    ordinal: row.ordinal,
    status: parseModelCallStatus(row.status),
    requestHash: parseRequestHash(row.request_hash),
    contextManifestHash: parseModelCallContextHash(row.context_manifest_hash),
    startedAt: row.started_at,
    updatedAt: row.updated_at ?? row.finished_at ?? row.started_at,
  }
  if (row.schema_version !== 1) {
    throw invalidRecord(
      "RALPH_MODEL_CALL_SCHEMA_VERSION_UNSUPPORTED",
      `Unsupported model call schema version: ${row.schema_version}`,
    )
  }
  if (row.outcome_json !== null) {
    record.outcome = parseSchemaObject(
      row.outcome_json,
      "model call outcome",
      ExecutorOutcomeSchema,
    )
  }
  if (row.finished_at !== null) record.finishedAt = row.finished_at
  return record
}

function completionFromRow(row: CompletionTransactionRow): CompletionTransactionRecord {
  const record: CompletionTransactionRecord = {
    id: row.id,
    runId: row.run_id,
    documentId: row.document_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    status: row.status,
    expectedBeforeHash: row.expected_before_hash,
    decision: parseSchemaObject(row.decision_json, "completion decision", CompletionDecisionSchema),
    preparedAt: row.prepared_at,
  }
  if (row.override_audit_json !== null) {
    record.overrideAudit = parseSchemaObject(
      row.override_audit_json,
      "completion override audit",
      CompletionOverrideAuditSchema,
    )
  }
  if (row.expected_after_hash !== null) record.expectedAfterHash = row.expected_after_hash
  if (row.marker_written_at !== null) record.markerWrittenAt = row.marker_written_at
  if (row.committed_at !== null) record.committedAt = row.committed_at
  return record
}

function findRunInDatabase(database: Database, runId: string): RunRecord | undefined {
  const row = database
    .query<RunRow, [string]>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`)
    .get(runId)
  return row ? runFromRow(row) : undefined
}

function requireRun(database: Database, runId: string): RunRecord {
  const run = findRunInDatabase(database, runId)
  if (!run) throw recordNotFound("run", runId)
  return run
}

function findTaskInDatabase(
  database: Database,
  runId: string,
  documentId: string,
  taskId: string,
): RunTaskRecord | undefined {
  const row = database
    .query<RunTaskRow, [string, string, string]>(
      `SELECT ${RUN_TASK_COLUMNS} FROM run_tasks
       WHERE run_id = ? AND document_id = ? AND task_id = ?`,
    )
    .get(runId, documentId, taskId)
  return row ? taskFromRow(row) : undefined
}

function findAttemptInDatabase(database: Database, attemptId: string): AttemptRecord | undefined {
  const row = database
    .query<AttemptRow, [string]>(`SELECT ${ATTEMPT_COLUMNS} FROM attempts WHERE id = ?`)
    .get(attemptId)
  return row ? attemptFromRow(row) : undefined
}

function requireAttempt(database: Database, attemptId: string): AttemptRecord {
  const attempt = findAttemptInDatabase(database, attemptId)
  if (!attempt) throw recordNotFound("attempt", attemptId)
  return attempt
}

function findModelCallInDatabase(
  database: Database,
  modelCallId: string,
): ModelCallRecord | undefined {
  const row = database
    .query<ModelCallRow, [string]>(`SELECT ${MODEL_CALL_COLUMNS} FROM model_calls WHERE id = ?`)
    .get(modelCallId)
  return row ? modelCallFromRow(row) : undefined
}

function requireModelCall(database: Database, modelCallId: string): ModelCallRecord {
  const call = findModelCallInDatabase(database, modelCallId)
  if (!call) throw recordNotFound("model_call", modelCallId)
  return call
}

function findCompletionInDatabase(
  database: Database,
  completionId: string,
): CompletionTransactionRecord | undefined {
  const row = database
    .query<CompletionTransactionRow, [string]>(
      `SELECT ${COMPLETION_COLUMNS} FROM completion_transactions WHERE id = ?`,
    )
    .get(completionId)
  return row ? completionFromRow(row) : undefined
}

function requireCompletion(database: Database, completionId: string): CompletionTransactionRecord {
  const completion = findCompletionInDatabase(database, completionId)
  if (!completion) throw recordNotFound("completion", completionId)
  return completion
}

type EventReferences = {
  documentId?: string
  taskId?: string
  attemptId?: string
  callId?: string
}

function appendMutationEvent(
  database: Database,
  run: RunRecord,
  defaultType: string,
  event: ExecutionMutationEvent | undefined,
  references: EventReferences = {},
  payload: JsonObject = {},
  explicitEventId?: string,
): void {
  const input: EventInput = {
    type: event?.type ?? defaultType,
    scope: "run",
    streamId: `run:${run.id}`,
    workspaceId: run.workspaceId,
    runId: run.id,
    payload: { ...(event?.payload ?? {}), ...payload },
  }
  if (event?.level !== undefined) input.level = event.level
  if (event?.correlationId !== undefined) input.correlationId = event.correlationId
  if (event?.causationId !== undefined) input.causationId = event.causationId
  if (references.documentId !== undefined) input.documentId = references.documentId
  if (references.taskId !== undefined) input.taskId = references.taskId
  if (references.attemptId !== undefined) input.attemptId = references.attemptId
  if (references.callId !== undefined) input.callId = references.callId
  appendEventInTransaction(database, input, explicitEventId)
}

function assertRunSegment(runId: string): void {
  if (
    runId.length === 0 ||
    runId === "." ||
    runId === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)
  ) {
    throw new RalphError("RALPH_INVALID_RUN_ID", `Run ID is not a safe path segment: ${runId}`, {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
}

export function runLayout(workspace: WorkspaceLayout, runId: string): RunLayout {
  assertRunSegment(runId)
  const root = join(workspace.runs, runId)
  return {
    root,
    manifest: join(root, "run.json"),
    events: join(root, "events.jsonl"),
    raw: join(root, "raw"),
    evidence: join(root, "evidence"),
    reports: join(root, "reports"),
    context: join(root, "context"),
    artifacts: join(root, "artifacts"),
  }
}

export async function ensureRunLayout(
  workspace: WorkspaceLayout,
  runId: string,
): Promise<RunLayout> {
  const layout = runLayout(workspace, runId)
  await Promise.all(
    [layout.raw, layout.evidence, layout.reports, layout.context, layout.artifacts].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  )
  return layout
}

export function createRun(path: string, input: CreateRunInput): RunRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const mode = RunModeSchema.parse(input.mode)
      const status = RunStatusSchema.parse(input.status)
      const effectiveOptions = EffectiveRunOptionsSchema.parse(input.effectiveOptions)
      const source = input.source ? RunWorkSourceSchema.parse(input.source) : undefined
      if (effectiveOptions.contentHash !== input.effectiveOptionsHash) {
        throw invalidRecord(
          "RALPH_EFFECTIVE_OPTIONS_HASH_MISMATCH",
          "Effective options snapshot does not match effectiveOptionsHash",
          { expected: input.effectiveOptionsHash, actual: effectiveOptions.contentHash },
        )
      }
      const timestamp = input.createdAt ?? now()
      database
        .query(
          `INSERT INTO runs(
            id, schema_version, workspace_id, root_prd_id, root_prd_file, source_json,
            definition_hash,
            graph_hash, mode, status, effective_options_hash, effective_options_json, created_at,
            started_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.schemaVersion,
          input.workspaceId,
          input.rootPrdId,
          input.rootPrdFile,
          source ? stringifyObject(source, "run work source") : null,
          input.definitionHash,
          input.graphHash,
          mode,
          status,
          input.effectiveOptionsHash,
          stringifyObject(effectiveOptions, "effective options"),
          timestamp,
          input.startedAt ?? null,
          timestamp,
        )
      const run = requireRun(database, input.id)
      appendMutationEvent(
        database,
        run,
        "run.created",
        input.event,
        {},
        {
          status: run.status,
          mode: run.mode,
          rootPrdId: run.rootPrdId,
          sourceKind: run.source?.kind ?? "legacy-prd",
          definitionHash: run.definitionHash,
          graphHash: run.graphHash,
        },
      )
      return run
    })(),
  )
}

export function getRun(path: string, runId: string): RunRecord | undefined {
  return withLedger(path, (database) => findRunInDatabase(database, runId))
}

export function listRuns(path: string, query: ListRunsQuery = {}): RunRecord[] {
  const limit = query.limit ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw invalidRecord(
      "RALPH_RUN_LIST_LIMIT_INVALID",
      "Run list limit must be a positive safe integer no greater than 1000",
    )
  }
  const statuses = query.statuses?.map((status) => RunStatusSchema.parse(status))
  const statusSet = statuses === undefined ? undefined : new Set(statuses)
  return withLedger(path, (database) =>
    database
      .query<RunRow, []>(
        `SELECT ${RUN_COLUMNS} FROM runs
         ORDER BY updated_at DESC, created_at DESC, id DESC`,
      )
      .all()
      .map(runFromRow)
      .filter(
        (run) =>
          (query.workspaceId === undefined || run.workspaceId === query.workspaceId) &&
          (statusSet === undefined || statusSet.has(run.status)),
      )
      .slice(0, limit),
  )
}

export function findResumableRun(path: string, query: ResumableRunQuery): RunRecord | undefined {
  return withLedger(path, (database) => {
    const statuses = RESUMABLE_STATUSES
    const row = database
      .query<
        RunRow,
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
        ]
      >(
        `SELECT ${RUN_COLUMNS} FROM runs
         WHERE workspace_id = ?
           AND root_prd_file = ?
           AND definition_hash = ?
           AND (? = '' OR root_prd_id = ?)
           AND (? = '' OR id = ?)
           AND status IN (?, ?, ?, ?, ?)
         ORDER BY updated_at DESC, created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(
        query.workspaceId,
        query.rootPrdFile,
        query.definitionHash,
        query.rootPrdId ?? "",
        query.rootPrdId ?? "",
        query.runId ?? "",
        query.runId ?? "",
        ...statuses,
      )
    return row ? runFromRow(row) : undefined
  })
}

export function updateRun(path: string, input: UpdateRunInput): RunRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const current = requireRun(database, input.runId)
      const updatedAt = input.updatedAt ?? now()
      const graphHash = input.graphHash ?? current.graphHash
      const status = RunStatusSchema.parse(input.status ?? current.status)
      const startedAt =
        input.startedAt === undefined ? (current.startedAt ?? null) : input.startedAt
      const finishedAt =
        input.finishedAt === undefined ? (current.finishedAt ?? null) : input.finishedAt
      const stopReason =
        input.stopReason === undefined ? (current.stopReason ?? null) : input.stopReason
      database
        .query(
          `UPDATE runs SET graph_hash = ?, status = ?, started_at = ?, finished_at = ?,
             stop_reason = ?, updated_at = ? WHERE id = ?`,
        )
        .run(graphHash, status, startedAt, finishedAt, stopReason, updatedAt, input.runId)
      const updated = requireRun(database, input.runId)
      appendMutationEvent(
        database,
        updated,
        "run.updated",
        input.event,
        {},
        {
          previousStatus: current.status,
          status: updated.status,
          graphHash: updated.graphHash,
        },
      )
      return updated
    })(),
  )
}

export function materializeRunTasks(path: string, input: MaterializeTasksInput): RunTaskRecord[] {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const run = requireRun(database, input.runId)
      const seen = new Set<string>()
      const insert = database.query(
        `INSERT INTO run_tasks(
          run_id, document_id, task_id, status, marker_content_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, document_id, task_id) DO NOTHING`,
      )
      for (const task of input.tasks) {
        const status = TaskRuntimeStatusSchema.parse(task.status)
        const identity = `${task.documentId}\u0000${task.taskId}`
        if (seen.has(identity)) {
          throw new RalphError(
            "RALPH_DUPLICATE_MATERIALIZED_TASK",
            `Task appears more than once in materialization: ${task.documentId}/${task.taskId}`,
            { exitCode: EXIT_CODES.invalidUsage },
          )
        }
        seen.add(identity)
        insert.run(
          input.runId,
          task.documentId,
          task.taskId,
          status,
          task.markerContentHash,
          task.updatedAt ?? now(),
        )
      }
      const records = input.tasks.map((task) => {
        const record = findTaskInDatabase(database, input.runId, task.documentId, task.taskId)
        if (!record) throw recordNotFound("task", `${task.documentId}/${task.taskId}`)
        return record
      })
      appendMutationEvent(
        database,
        run,
        "run.tasks.materialized",
        input.event,
        {},
        {
          count: records.length,
          tasks: records.map((task) => ({
            documentId: task.documentId,
            taskId: task.taskId,
            status: task.status,
          })),
        },
      )
      return records
    })(),
  )
}

export function getRunTask(
  path: string,
  runId: string,
  documentId: string,
  taskId: string,
): RunTaskRecord | undefined {
  return withLedger(path, (database) => findTaskInDatabase(database, runId, documentId, taskId))
}

export function listRunTasks(path: string, runId: string): RunTaskRecord[] {
  return withLedger(path, (database) =>
    database
      .query<RunTaskRow, [string]>(
        `SELECT ${RUN_TASK_COLUMNS} FROM run_tasks
         WHERE run_id = ? ORDER BY document_id, task_id`,
      )
      .all(runId)
      .map(taskFromRow),
  )
}

export function upsertRunTask(path: string, input: UpsertRunTaskInput): RunTaskRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const run = requireRun(database, input.runId)
      const status = TaskRuntimeStatusSchema.parse(input.status)
      const completion =
        input.completion === undefined || input.completion === null
          ? input.completion
          : CompletionDecisionSchema.parse(input.completion)
      database
        .query(
          `INSERT INTO run_tasks(
            run_id, document_id, task_id, status, marker_content_hash, active_attempt_id,
            completion_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, document_id, task_id) DO UPDATE SET
            status = excluded.status,
            marker_content_hash = excluded.marker_content_hash,
            active_attempt_id = excluded.active_attempt_id,
            completion_json = excluded.completion_json,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.runId,
          input.documentId,
          input.taskId,
          status,
          input.markerContentHash,
          input.activeAttemptId ?? null,
          completion === undefined || completion === null
            ? null
            : stringifyObject(completion, "task completion"),
          input.updatedAt ?? now(),
        )
      const task = findTaskInDatabase(database, input.runId, input.documentId, input.taskId)
      if (!task) throw recordNotFound("task", `${input.documentId}/${input.taskId}`)
      appendMutationEvent(
        database,
        run,
        "task.state.updated",
        input.event,
        {
          documentId: input.documentId,
          taskId: input.taskId,
          ...(task.activeAttemptId === undefined ? {} : { attemptId: task.activeAttemptId }),
        },
        { status: task.status, markerContentHash: task.markerContentHash },
      )
      return task
    })(),
  )
}

export function createAttempt(path: string, input: CreateAttemptInput): AttemptRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const run = requireRun(database, input.runId)
      const task = findTaskInDatabase(database, input.runId, input.documentId, input.taskId)
      if (!task) throw recordNotFound("task", `${input.documentId}/${input.taskId}`)
      const phase = AttemptPhaseSchema.parse(input.phase)
      const status = AttemptStatusSchema.parse(input.status)
      const baseline = GitBaselineSchema.parse(input.baseline)
      const effectiveOptions = EffectiveRunOptionsSchema.parse(input.effectiveOptions)
      if (effectiveOptions.contentHash !== input.effectiveOptionsHash) {
        throw invalidRecord(
          "RALPH_ATTEMPT_EFFECTIVE_OPTIONS_HASH_MISMATCH",
          "Attempt effective options snapshot does not match effectiveOptionsHash",
          { expected: input.effectiveOptionsHash, actual: effectiveOptions.contentHash },
        )
      }
      const counters = AttemptCountersSchema.parse(input.counters)
      const timestamp = input.startedAt ?? now()
      database
        .query(
          `INSERT INTO attempts(
            id, run_id, document_id, task_id, ordinal, phase, status, context_manifest_hash,
            baseline_json, effective_options_hash, effective_options_json, counters_json,
            started_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.runId,
          input.documentId,
          input.taskId,
          input.ordinal,
          phase,
          status,
          input.contextManifestHash,
          stringifyObject(baseline, "attempt baseline"),
          input.effectiveOptionsHash,
          stringifyObject(effectiveOptions, "attempt effective options"),
          stringifyObject(counters, "attempt counters"),
          timestamp,
          timestamp,
        )
      database
        .query(
          `UPDATE run_tasks SET active_attempt_id = ?, updated_at = ?
           WHERE run_id = ? AND document_id = ? AND task_id = ?`,
        )
        .run(input.id, timestamp, input.runId, input.documentId, input.taskId)
      const attempt = requireAttempt(database, input.id)
      appendMutationEvent(
        database,
        run,
        "attempt.created",
        input.event,
        { documentId: input.documentId, taskId: input.taskId, attemptId: input.id },
        {
          ordinal: attempt.ordinal,
          phase: attempt.phase,
          status: attempt.status,
          effectiveOptionsHash: attempt.effectiveOptionsHash,
        },
      )
      return attempt
    })(),
  )
}

export function getAttempt(path: string, attemptId: string): AttemptRecord | undefined {
  return withLedger(path, (database) => findAttemptInDatabase(database, attemptId))
}

export function listAttempts(path: string, query: ListAttemptsQuery): AttemptRecord[] {
  const statuses = query.statuses?.map((status) => AttemptStatusSchema.parse(status))
  const statusSet = statuses === undefined ? undefined : new Set(statuses)
  return withLedger(path, (database) =>
    database
      .query<AttemptRow, [string, string, string, string, string]>(
        `SELECT ${ATTEMPT_COLUMNS} FROM attempts
         WHERE run_id = ?
           AND (? = '' OR document_id = ?)
           AND (? = '' OR task_id = ?)
         ORDER BY started_at, document_id, task_id, ordinal, id`,
      )
      .all(
        query.runId,
        query.documentId ?? "",
        query.documentId ?? "",
        query.taskId ?? "",
        query.taskId ?? "",
      )
      .map(attemptFromRow)
      .filter((attempt) => statusSet === undefined || statusSet.has(attempt.status)),
  )
}

export function updateAttempt(path: string, input: UpdateAttemptInput): AttemptRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const current = requireAttempt(database, input.attemptId)
      const run = requireRun(database, current.runId)
      const phase = AttemptPhaseSchema.parse(input.phase ?? current.phase)
      const status = AttemptStatusSchema.parse(input.status ?? current.status)
      const baseline = GitBaselineSchema.parse(input.baseline ?? current.baseline)
      const counters = AttemptCountersSchema.parse(input.counters ?? current.counters)
      const executorOutcome =
        input.executorOutcome === undefined
          ? (current.executorOutcome ?? null)
          : input.executorOutcome === null
            ? null
            : ExecutorOutcomeSchema.parse(input.executorOutcome)
      const evidenceBundleId =
        input.evidenceBundleId === undefined
          ? (current.evidenceBundleId ?? null)
          : input.evidenceBundleId
      const completionDecision =
        input.completionDecision === undefined
          ? (current.completionDecision ?? null)
          : input.completionDecision === null
            ? null
            : CompletionDecisionSchema.parse(input.completionDecision)
      const finishedAt =
        input.finishedAt === undefined ? (current.finishedAt ?? null) : input.finishedAt
      database
        .query(
          `UPDATE attempts SET phase = ?, status = ?, context_manifest_hash = ?,
             baseline_json = ?, counters_json = ?, executor_outcome_json = ?,
             evidence_bundle_id = ?, completion_decision_json = ?, finished_at = ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(
          phase,
          status,
          input.contextManifestHash ?? current.contextManifestHash,
          stringifyObject(baseline, "attempt baseline"),
          stringifyObject(counters, "attempt counters"),
          executorOutcome === null ? null : stringifyObject(executorOutcome, "executor outcome"),
          evidenceBundleId,
          completionDecision === null
            ? null
            : stringifyObject(completionDecision, "completion decision"),
          finishedAt,
          input.updatedAt ?? now(),
          input.attemptId,
        )
      const attempt = requireAttempt(database, input.attemptId)
      appendMutationEvent(
        database,
        run,
        "attempt.updated",
        input.event,
        {
          documentId: attempt.documentId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
        },
        {
          previousPhase: current.phase,
          phase: attempt.phase,
          previousStatus: current.status,
          status: attempt.status,
        },
      )
      return attempt
    })(),
  )
}

/**
 * Persists one watchdog probe and reserves its operational effects in the same
 * ledger transaction. A destructive watchdog decision never depends on the
 * runner's later catch path to reserve a restart or release a judge revision.
 */
export function persistAttemptWatchdogEvaluation(
  path: string,
  input: PersistAttemptWatchdogEvaluationInput,
): AttemptRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const current = requireAttempt(database, input.attemptId)
      const evaluation = WatchdogEvaluationSchema.parse(input.evaluation)
      const probeId = evaluation.snapshot.probeId
      const action = evaluation.decision.action
      const destructive =
        action === "cancel" || action === "restart-attempt" || action === "stop-run"
      const probeEvents = input.events.filter((event) => event.type === "watchdog.probe")
      const actionEvents = input.events.filter((event) => event.type === "watchdog.action")
      const probeEvent = probeEvents[0]

      if (
        probeEvents.length !== 1 ||
        !probeEvent ||
        input.events.some(
          (event) =>
            typeof event.payload !== "object" ||
            event.payload === null ||
            (event.payload as JsonObject).probeId !== probeId,
        )
      ) {
        throw invalidRecord(
          "RALPH_WATCHDOG_PROBE_EVENT_MISMATCH",
          "Watchdog telemetry must contain exactly one probe and bind every event to its probeId",
          { attemptId: input.attemptId, probeId, probeEventCount: probeEvents.length },
        )
      }
      if (
        stringifyObject((probeEvent.payload as JsonObject).snapshot, "watchdog probe snapshot") !==
        stringifyObject(evaluation.snapshot, "watchdog evaluation snapshot")
      ) {
        throw invalidRecord(
          "RALPH_WATCHDOG_PROBE_SNAPSHOT_MISMATCH",
          "Watchdog probe telemetry does not match the evaluated snapshot",
          { attemptId: input.attemptId, probeId },
        )
      }
      if (
        actionEvents[0] &&
        stringifyObject(
          (actionEvents[0].payload as JsonObject).decision,
          "watchdog action decision",
        ) !== stringifyObject(evaluation.decision, "watchdog evaluation decision")
      ) {
        throw invalidRecord(
          "RALPH_WATCHDOG_ACTION_DECISION_MISMATCH",
          "Watchdog action telemetry does not match the evaluated recovery decision",
          { attemptId: input.attemptId, probeId, action },
        )
      }

      const priorProbeRows = database
        .query<{ event_json: string }, [string]>(
          `SELECT event_json FROM events
           WHERE attempt_id = ? AND event_type IN ('watchdog.probe', 'watchdog.action')
           ORDER BY sequence`,
        )
        .all(input.attemptId)
      const priorProbeEvents = priorProbeRows
        .map((row) => {
          try {
            return JSON.parse(row.event_json) as {
              type?: unknown
              payload?: unknown
            }
          } catch (error) {
            throw new RalphError(
              "RALPH_LEDGER_INVALID_RECORD",
              "Invalid watchdog event in the execution ledger",
              { exitCode: EXIT_CODES.operationalError, cause: error },
            )
          }
        })
        .filter(
          (event) =>
            typeof event.payload === "object" &&
            event.payload !== null &&
            (event.payload as JsonObject).probeId === probeId,
        )
      if (priorProbeEvents.length > 0) {
        const priorProbe = priorProbeEvents.find((event) => event.type === "watchdog.probe")
        const priorAction = priorProbeEvents.find((event) => event.type === "watchdog.action")
        const sameSnapshot =
          priorProbe !== undefined &&
          stringifyObject(
            (priorProbe.payload as JsonObject).snapshot,
            "persisted watchdog probe snapshot",
          ) === stringifyObject(evaluation.snapshot, "watchdog evaluation snapshot")
        const sameDecision =
          action === "none"
            ? priorAction === undefined
            : priorAction !== undefined &&
              stringifyObject(
                (priorAction.payload as JsonObject).decision,
                "persisted watchdog action decision",
              ) === stringifyObject(evaluation.decision, "watchdog evaluation decision")
        if (!sameSnapshot || !sameDecision) {
          throw invalidRecord(
            "RALPH_WATCHDOG_PROBE_ID_CONFLICT",
            "A watchdog probeId was reused with different snapshot or recovery semantics",
            { attemptId: input.attemptId, probeId },
          )
        }
        return current
      }

      if (current.status !== "active") {
        throw invalidRecord(
          "RALPH_WATCHDOG_ATTEMPT_NOT_ACTIVE",
          "Watchdog probes may only mutate an active attempt",
          { attemptId: input.attemptId, status: current.status },
        )
      }
      if (
        input.events.some(
          (event) =>
            event.attemptId !== input.attemptId ||
            event.runId !== current.runId ||
            event.documentId !== current.documentId ||
            event.taskId !== current.taskId,
        )
      ) {
        throw invalidRecord(
          "RALPH_WATCHDOG_EVENT_ATTEMPT_MISMATCH",
          "A watchdog probe event is not fully bound to the attempt being updated",
          { attemptId: input.attemptId },
        )
      }
      if (
        (action === "none" && actionEvents.length !== 0) ||
        (action !== "none" && actionEvents.length !== 1)
      ) {
        throw invalidRecord(
          "RALPH_WATCHDOG_ACTION_EVENT_MISMATCH",
          "Watchdog action telemetry does not match the evaluated recovery decision",
          { attemptId: input.attemptId, action, actionEventCount: actionEvents.length },
        )
      }

      const counters = AttemptCountersSchema.parse({
        ...current.counters,
        watchdogRestarts:
          current.counters.watchdogRestarts + evaluation.decision.watchdogRestartDelta,
        revisionAttempts:
          destructive && !evaluation.decision.consumesJudgeRevision
            ? Math.max(0, current.counters.revisionAttempts - 1)
            : current.counters.revisionAttempts,
      })
      const countersChanged =
        counters.watchdogRestarts !== current.counters.watchdogRestarts ||
        counters.revisionAttempts !== current.counters.revisionAttempts
      if (countersChanged) {
        database
          .query(
            `UPDATE attempts SET counters_json = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(stringifyObject(counters, "attempt watchdog counters"), now(), input.attemptId)
      }
      for (const event of input.events) appendEventInTransaction(database, event)
      const actionEvent = actionEvents[0]
      if (countersChanged && actionEvent) {
        appendEventInTransaction(database, {
          ...actionEvent,
          type: "attempt.watchdog_budget_reserved",
          level: "warn",
          payload: {
            probeId: evaluation.snapshot.probeId,
            action,
            watchdogRestartDelta: evaluation.decision.watchdogRestartDelta,
            revisionCompensated: current.counters.revisionAttempts - counters.revisionAttempts,
            countersBefore: current.counters,
            countersAfter: counters,
          },
        })
      }
      return requireAttempt(database, input.attemptId)
    })(),
  )
}

export function createModelCall(path: string, input: CreateModelCallInput): ModelCallRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const attempt = requireAttempt(database, input.attemptId)
      const run = requireRun(database, attempt.runId)
      if (attempt.status !== "active") {
        throw invalidRecord(
          "RALPH_MODEL_CALL_ATTEMPT_NOT_ACTIVE",
          `Model calls require an active attempt; ${attempt.id} is ${attempt.status}`,
        )
      }
      if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 1) {
        throw invalidRecord(
          "RALPH_MODEL_CALL_ORDINAL_INVALID",
          "Model call ordinal must be a positive safe integer",
        )
      }
      const expectedOrdinal = attempt.counters.modelCalls + 1
      if (input.ordinal !== expectedOrdinal) {
        throw invalidRecord(
          "RALPH_MODEL_CALL_ORDINAL_MISMATCH",
          `Model call ordinal ${input.ordinal} does not match the next counter ${expectedOrdinal}`,
          { expectedOrdinal, actualOrdinal: input.ordinal },
        )
      }
      const requestHash = parseRequestHash(input.requestHash)
      const contextManifestHash = parseModelCallContextHash(input.contextManifestHash)
      const timestamp = input.startedAt ?? now()
      const counters = AttemptCountersSchema.parse({
        ...attempt.counters,
        modelCalls: attempt.counters.modelCalls + 1,
      })
      database
        .query(
          `INSERT INTO model_calls(
             schema_version, id, attempt_id, ordinal, status, request_hash,
             context_manifest_hash, started_at, updated_at
           ) VALUES (1, ?, ?, ?, 'started', ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.attemptId,
          input.ordinal,
          requestHash,
          contextManifestHash,
          timestamp,
          timestamp,
        )
      database
        .query("UPDATE attempts SET counters_json = ?, updated_at = ? WHERE id = ?")
        .run(stringifyObject(counters, "attempt counters"), timestamp, input.attemptId)
      const call = requireModelCall(database, input.id)
      appendMutationEvent(
        database,
        run,
        "model.call.started",
        input.event,
        {
          documentId: attempt.documentId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          callId: call.id,
        },
        {
          ordinal: call.ordinal,
          requestHash: call.requestHash,
          contextManifestHash: call.contextManifestHash,
          status: call.status,
        },
      )
      return call
    })(),
  )
}

export function getModelCall(path: string, modelCallId: string): ModelCallRecord | undefined {
  return withLedger(path, (database) => findModelCallInDatabase(database, modelCallId))
}

export function listModelCalls(path: string, attemptId: string): ModelCallRecord[] {
  return withLedger(path, (database) =>
    database
      .query<ModelCallRow, [string]>(
        `SELECT ${MODEL_CALL_COLUMNS} FROM model_calls
         WHERE attempt_id = ? ORDER BY ordinal, started_at, id`,
      )
      .all(attemptId)
      .map(modelCallFromRow),
  )
}

export function updateModelCall(path: string, input: UpdateModelCallInput): ModelCallRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const current = requireModelCall(database, input.modelCallId)
      if (current.status !== "started") {
        throw invalidRecord(
          "RALPH_MODEL_CALL_TERMINAL",
          `Model call ${current.id} is already terminal with status ${current.status}`,
        )
      }
      const status = parseModelCallStatus(input.status)
      if (status === "started") {
        throw invalidRecord(
          "RALPH_MODEL_CALL_INVALID_TRANSITION",
          "updateModelCall requires a terminal status",
        )
      }
      const outcome =
        input.outcome === undefined ? undefined : ExecutorOutcomeSchema.parse(input.outcome)
      if (status === "succeeded" && outcome === undefined) {
        throw invalidRecord(
          "RALPH_MODEL_CALL_OUTCOME_REQUIRED",
          "A succeeded model call requires a validated ExecutorOutcome",
        )
      }
      if (status !== "succeeded" && outcome !== undefined) {
        throw invalidRecord(
          "RALPH_MODEL_CALL_OUTCOME_NOT_ALLOWED",
          `A ${status} model call cannot persist a successful ExecutorOutcome`,
        )
      }
      const attempt = requireAttempt(database, current.attemptId)
      const run = requireRun(database, attempt.runId)
      const finishedAt = input.finishedAt ?? now()
      const updatedAt = input.updatedAt ?? finishedAt
      database
        .query(
          `UPDATE model_calls SET status = ?, outcome_json = ?, finished_at = ?, updated_at = ?
           WHERE id = ? AND status = 'started'`,
        )
        .run(
          status,
          outcome === undefined ? null : stringifyObject(outcome, "model call outcome"),
          finishedAt,
          updatedAt,
          current.id,
        )
      const call = requireModelCall(database, current.id)
      appendMutationEvent(
        database,
        run,
        "model.call.finished",
        input.event,
        {
          documentId: attempt.documentId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          callId: call.id,
        },
        { ordinal: call.ordinal, status: call.status, hasOutcome: call.outcome !== undefined },
      )
      return call
    })(),
  )
}

export function persistGateResult(path: string, input: PersistGateResultInput): GateResultRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const attempt = requireAttempt(database, input.attemptId)
      const run = requireRun(database, attempt.runId)
      const result = GateResultSchema.parse(input.result)
      if (result.gateId !== input.gateId) {
        throw invalidRecord(
          "RALPH_GATE_ID_MISMATCH",
          `Gate result ${result.gateId} cannot be persisted as ${input.gateId}`,
        )
      }
      const createdAt = input.createdAt ?? now()
      database
        .query(
          `INSERT INTO gate_results(attempt_id, gate_id, result_json, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(attempt_id, gate_id) DO UPDATE SET
             result_json = excluded.result_json,
             created_at = excluded.created_at`,
        )
        .run(input.attemptId, input.gateId, stringifyObject(result, "gate result"), createdAt)
      const row = database
        .query<GateResultRow, [string, string]>(
          `SELECT attempt_id, gate_id, result_json, created_at FROM gate_results
           WHERE attempt_id = ? AND gate_id = ?`,
        )
        .get(input.attemptId, input.gateId)
      if (!row) throw recordNotFound("gate", `${input.attemptId}/${input.gateId}`)
      const record: GateResultRecord = {
        attemptId: row.attempt_id,
        gateId: row.gate_id,
        result: parseSchemaObject(row.result_json, "gate result", GateResultSchema),
        createdAt: row.created_at,
      }
      appendMutationEvent(
        database,
        run,
        "gate.persisted",
        input.event,
        {
          documentId: attempt.documentId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
        },
        { gateId: record.gateId },
      )
      return record
    })(),
  )
}

export function listGateResults(path: string, attemptId: string): GateResultRecord[] {
  return withLedger(path, (database) =>
    database
      .query<GateResultRow, [string]>(
        `SELECT attempt_id, gate_id, result_json, created_at FROM gate_results
         WHERE attempt_id = ? ORDER BY gate_id`,
      )
      .all(attemptId)
      .map((row) => ({
        attemptId: row.attempt_id,
        gateId: row.gate_id,
        result: parseSchemaObject(row.result_json, "gate result", GateResultSchema),
        createdAt: row.created_at,
      })),
  )
}

export function persistEvidenceBundle(
  path: string,
  input: PersistEvidenceBundleInput,
): EvidenceBundleRecord {
  const parsedBundle = EvidenceBundleSchema.parse(input.bundle)
  assertEvidenceBundleContentHash(parsedBundle)
  if (parsedBundle.schemaVersion === 2 && !input.storage) {
    throw invalidRecord(
      "RALPH_EVIDENCE_OBJECT_BINDING_MISSING",
      "Evidence bundle v2 requires an immutable object-store receipt",
    )
  }
  if (input.storage) {
    const stored = readEvidenceBundleObjectSync(workspaceRootFromLedger(path), input.storage)
    if (
      stored.id !== parsedBundle.id ||
      stored.contentHash !== parsedBundle.contentHash ||
      stringifyObject(stored, "stored evidence object") !==
        stringifyObject(parsedBundle, "evidence bundle")
    ) {
      throw invalidRecord(
        "RALPH_EVIDENCE_OBJECT_BINDING_MISMATCH",
        "Evidence object receipt does not bind the submitted bundle",
      )
    }
  }
  return withLedger(path, (database) =>
    database.transaction(() => {
      const attempt = requireAttempt(database, input.attemptId)
      const run = requireRun(database, attempt.runId)
      const bundle = parsedBundle
      if (
        bundle.id !== input.id ||
        bundle.attemptId !== input.attemptId ||
        bundle.contentHash !== input.contentHash ||
        bundle.runId !== attempt.runId ||
        bundle.documentId !== attempt.documentId ||
        bundle.taskId !== attempt.taskId ||
        bundle.contextManifestHash !== attempt.contextManifestHash
      ) {
        throw invalidRecord(
          "RALPH_EVIDENCE_BINDING_MISMATCH",
          `Evidence bundle ${input.id} does not match its attempt and persistence identity`,
        )
      }
      for (const gate of bundle.gates) {
        const persistedGate = database
          .query<{ result_json: string }, [string, string]>(
            "SELECT result_json FROM gate_results WHERE attempt_id = ? AND gate_id = ?",
          )
          .get(input.attemptId, gate.gateId)
        if (
          !persistedGate ||
          stringifyObject(
            parseSchemaObject(persistedGate.result_json, "gate result", GateResultSchema),
            "gate result",
          ) !== stringifyObject(gate, "evidence gate result")
        ) {
          throw invalidRecord(
            "RALPH_EVIDENCE_GATE_NOT_PERSISTED",
            `Evidence gate ${gate.gateId} does not match a persisted gate result`,
          )
        }
      }
      const existingForAttempt = database
        .query<EvidenceBundleRow, [string]>(
          `SELECT ${EVIDENCE_COLUMNS} FROM evidence_bundles WHERE attempt_id = ?`,
        )
        .get(input.attemptId)
      if (existingForAttempt) {
        const existing = evidenceFromRow(path, existingForAttempt)
        const sameStorage = input.storage
          ? existing.contentRef === input.storage.contentRef &&
            existing.storageHash === input.storage.storageHash &&
            existing.sizeBytes === input.storage.sizeBytes
          : existing.contentRef === undefined
        if (
          existing.id === input.id &&
          existing.contentHash === input.contentHash &&
          sameStorage &&
          stringifyObject(existing.bundle, "existing evidence bundle") ===
            stringifyObject(bundle, "evidence bundle")
        ) {
          return existing
        }
        throw new RalphError(
          "RALPH_EVIDENCE_IMMUTABLE_CONFLICT",
          `Attempt ${input.attemptId} already owns immutable evidence bundle ${existing.id}`,
          { exitCode: EXIT_CODES.conflict },
        )
      }
      const existingId = database
        .query<{ attempt_id: string }, [string]>(
          "SELECT attempt_id FROM evidence_bundles WHERE id = ?",
        )
        .get(input.id)
      if (existingId) {
        throw new RalphError(
          "RALPH_EVIDENCE_ID_CONFLICT",
          `Evidence bundle ID ${input.id} already belongs to attempt ${existingId.attempt_id}`,
          { exitCode: EXIT_CODES.conflict },
        )
      }
      const createdAt = input.createdAt ?? now()
      database
        .query(
          `INSERT INTO evidence_bundles(
             id, attempt_id, content_hash, bundle_json, schema_version,
             content_ref, storage_hash, size_bytes, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.attemptId,
          input.contentHash,
          stringifyObject(bundle, "evidence bundle"),
          bundle.schemaVersion,
          input.storage?.contentRef ?? null,
          input.storage?.storageHash ?? null,
          input.storage?.sizeBytes ?? null,
          createdAt,
        )
      database
        .query("UPDATE attempts SET evidence_bundle_id = ?, updated_at = ? WHERE id = ?")
        .run(input.id, createdAt, input.attemptId)
      const row = database
        .query<EvidenceBundleRow, [string]>(
          `SELECT ${EVIDENCE_COLUMNS} FROM evidence_bundles WHERE id = ?`,
        )
        .get(input.id)
      if (!row) throw recordNotFound("evidence", input.id)
      const record = evidenceFromRow(path, row)
      appendMutationEvent(
        database,
        run,
        "evidence.persisted",
        input.event,
        {
          documentId: attempt.documentId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
        },
        {
          evidenceBundleId: record.id,
          contentHash: record.contentHash,
          schemaVersion: record.schemaVersion,
          ...(record.contentRef
            ? {
                contentRef: record.contentRef,
                storageHash: record.storageHash,
                sizeBytes: record.sizeBytes,
              }
            : {}),
        },
      )
      return record
    })(),
  )
}

export function getEvidenceBundle(
  path: string,
  attemptId: string,
): EvidenceBundleRecord | undefined {
  return withLedger(path, (database) => {
    const row = database
      .query<EvidenceBundleRow, [string]>(
        `SELECT ${EVIDENCE_COLUMNS} FROM evidence_bundles WHERE attempt_id = ?`,
      )
      .get(attemptId)
    if (!row) return undefined
    return evidenceFromRow(path, row)
  })
}

export function getEvidenceBundleById(
  path: string,
  evidenceBundleId: string,
): EvidenceBundleRecord | undefined {
  return withLedger(path, (database) => {
    const row = database
      .query<EvidenceBundleRow, [string]>(
        `SELECT ${EVIDENCE_COLUMNS} FROM evidence_bundles WHERE id = ?`,
      )
      .get(evidenceBundleId)
    return row ? evidenceFromRow(path, row) : undefined
  })
}

export function persistRunReport(path: string, input: PersistRunReportInput): RunReportRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const run = requireRun(database, input.runId)
      const report = ExecutionReportSchema.parse(input.report)
      if (report.runId !== input.runId) {
        throw invalidRecord(
          "RALPH_REPORT_RUN_MISMATCH",
          `Execution report ${report.id} does not belong to run ${input.runId}`,
        )
      }
      const updatedAt = input.updatedAt ?? now()
      database
        .query(
          `INSERT INTO run_reports(run_id, report_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(run_id) DO UPDATE SET
             report_json = excluded.report_json,
             updated_at = excluded.updated_at`,
        )
        .run(input.runId, stringifyObject(report, "run report"), updatedAt)
      const record: RunReportRecord = {
        runId: input.runId,
        report,
        updatedAt,
      }
      appendMutationEvent(
        database,
        run,
        "run.report.persisted",
        input.event,
        {},
        {
          reportUpdatedAt: updatedAt,
        },
      )
      return record
    })(),
  )
}

export function getRunReport(path: string, runId: string): RunReportRecord | undefined {
  return withLedger(path, (database) => {
    const row = database
      .query<RunReportRow, [string]>(
        "SELECT run_id, report_json, updated_at FROM run_reports WHERE run_id = ?",
      )
      .get(runId)
    if (!row) return undefined
    return {
      runId: row.run_id,
      report: parseSchemaObject(row.report_json, "run report", ExecutionReportSchema),
      updatedAt: row.updated_at,
    }
  })
}

function validateCompletionApproval(
  decision: CompletionDecision,
  evidence: EvidenceBundle,
  overrideAudit: CompletionOverrideAudit | undefined,
): void {
  if (!evidence.changes.reproducible) {
    throw invalidRecord(
      "RALPH_COMPLETION_EVIDENCE_NOT_REPRODUCIBLE",
      "Completion requires reconstructable before/after content for every changed path",
      { missingContent: evidence.changes.missingContent },
    )
  }
  if (decision.status !== "passed" && decision.status !== "overridden") {
    throw invalidRecord(
      "RALPH_COMPLETION_DECISION_NOT_APPROVED",
      `Completion decision status ${decision.status} cannot prepare completion`,
    )
  }

  const blockingGates = evidence.gates.filter((gate) => gate.blocking)
  if (decision.status === "passed") {
    if (overrideAudit !== undefined) {
      throw invalidRecord(
        "RALPH_COMPLETION_OVERRIDE_AUDIT_NOT_ALLOWED",
        "A normal passed completion cannot carry an override audit",
      )
    }
    const failedBlocking = blockingGates.filter(
      (gate) =>
        gate.status !== "passed" &&
        !(
          gate.status === "skipped_by_cli" &&
          (gate.skipPolicy === "allowed-to-skip" || gate.skipPolicy === "optional")
        ),
    )
    if (
      !decision.deterministicPassed ||
      decision.severityRulesPassed === false ||
      (decision.score !== undefined &&
        decision.threshold !== undefined &&
        decision.score < decision.threshold) ||
      failedBlocking.length > 0
    ) {
      throw invalidRecord(
        "RALPH_COMPLETION_DECISION_NOT_APPROVED",
        "Completion decision or its blocking evidence did not pass",
        { failedBlockingGateIds: failedBlocking.map((gate) => gate.gateId) },
      )
    }
    return
  }

  if (overrideAudit === undefined) {
    throw invalidRecord(
      "RALPH_COMPLETION_OVERRIDE_AUDIT_REQUIRED",
      "An overridden completion requires a persisted CompletionOverrideAudit",
    )
  }
  const blockingThatNeedsOverride = blockingGates.filter(
    (gate) =>
      gate.status !== "passed" &&
      !(
        gate.status === "skipped_by_cli" &&
        (gate.skipPolicy === "allowed-to-skip" || gate.skipPolicy === "optional")
      ),
  )
  const forbiddenBlocking = blockingThatNeedsOverride.filter(
    (gate) => gate.status !== "skipped_by_cli",
  )
  if (forbiddenBlocking.length > 0) {
    throw invalidRecord(
      "RALPH_COMPLETION_OVERRIDE_BLOCKING_GATE_NOT_OVERRIDABLE",
      "Override permits only passed or explicitly CLI-skipped blocking gates",
      {
        gates: forbiddenBlocking.map((gate) => ({ id: gate.gateId, status: gate.status })),
      },
    )
  }
  const skippedGateIds = blockingThatNeedsOverride
    .filter((gate) => gate.status === "skipped_by_cli")
    .map((gate) => gate.gateId)
    .sort()
  const auditedGateIds = [...overrideAudit.overriddenGateIds].sort()
  if (
    skippedGateIds.length === 0 ||
    skippedGateIds.length !== auditedGateIds.length ||
    skippedGateIds.some((gateId, index) => gateId !== auditedGateIds[index])
  ) {
    throw invalidRecord(
      "RALPH_COMPLETION_OVERRIDE_AUDIT_MISMATCH",
      "Override audit must name every and only CLI-skipped blocking gate",
      { skippedGateIds, auditedGateIds },
    )
  }
}

export function prepareCompletion(
  path: string,
  input: PrepareCompletionInput,
): CompletionTransactionRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const run = requireRun(database, input.runId)
      const decision = CompletionDecisionSchema.parse(input.decision)
      const overrideAudit =
        input.overrideAudit === undefined
          ? undefined
          : CompletionOverrideAuditSchema.parse(input.overrideAudit)
      const task = findTaskInDatabase(database, input.runId, input.documentId, input.taskId)
      if (!task) throw recordNotFound("task", `${input.documentId}/${input.taskId}`)
      if (task.status === "completed" || task.status === "completed_with_override") {
        throw new RalphError(
          "RALPH_COMPLETION_ALREADY_COMMITTED",
          `Task is already complete: ${input.documentId}/${input.taskId}`,
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      if (task.markerContentHash !== input.expectedBeforeHash) {
        throw new RalphError(
          "RALPH_COMPLETION_HASH_CONFLICT",
          `Task marker hash changed before completion was prepared: ${input.documentId}/${input.taskId}`,
          {
            exitCode: EXIT_CODES.invalidUsage,
            details: {
              expected: input.expectedBeforeHash,
              actual: task.markerContentHash,
            },
          },
        )
      }
      const attempt = requireAttempt(database, input.attemptId)
      if (
        attempt.runId !== input.runId ||
        attempt.documentId !== input.documentId ||
        attempt.taskId !== input.taskId
      ) {
        throw new RalphError(
          "RALPH_COMPLETION_ATTEMPT_MISMATCH",
          `Attempt ${input.attemptId} does not belong to ${input.documentId}/${input.taskId}`,
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      if (task.activeAttemptId !== input.attemptId) {
        throw new RalphError(
          "RALPH_COMPLETION_INACTIVE_ATTEMPT",
          `Attempt ${input.attemptId} is not the active attempt for ${input.documentId}/${input.taskId}`,
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      if (!attempt.evidenceBundleId || attempt.evidenceBundleId !== decision.evidenceBundleId) {
        throw invalidRecord(
          "RALPH_COMPLETION_EVIDENCE_MISMATCH",
          `Completion decision does not reference the persisted evidence for attempt ${input.attemptId}`,
        )
      }
      const evidenceRow = database
        .query<EvidenceBundleRow, [string]>(
          `SELECT ${EVIDENCE_COLUMNS} FROM evidence_bundles WHERE id = ?`,
        )
        .get(decision.evidenceBundleId)
      if (!evidenceRow) throw recordNotFound("evidence", decision.evidenceBundleId)
      const evidence = evidenceFromRow(path, evidenceRow).bundle
      if (
        evidence.runId !== input.runId ||
        evidence.documentId !== input.documentId ||
        evidence.taskId !== input.taskId ||
        evidence.attemptId !== input.attemptId
      ) {
        throw invalidRecord(
          "RALPH_COMPLETION_EVIDENCE_MISMATCH",
          "Persisted evidence does not belong to the task being completed",
        )
      }
      validateCompletionApproval(decision, evidence, overrideAudit)
      const preparedAt = input.preparedAt ?? now()
      const decisionJson = stringifyObject(decision, "completion decision")
      const overrideAuditJson =
        overrideAudit === undefined
          ? null
          : stringifyObject(overrideAudit, "completion override audit")
      database
        .query(
          `INSERT INTO completion_transactions(
            id, run_id, document_id, task_id, attempt_id, status, expected_before_hash,
            decision_json, override_audit_json, prepared_at
          ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.runId,
          input.documentId,
          input.taskId,
          input.attemptId,
          input.expectedBeforeHash,
          decisionJson,
          overrideAuditJson,
          preparedAt,
        )
      database
        .query("UPDATE attempts SET completion_decision_json = ?, updated_at = ? WHERE id = ?")
        .run(decisionJson, preparedAt, input.attemptId)
      const completion = requireCompletion(database, input.id)
      if (overrideAudit !== undefined) {
        appendMutationEvent(
          database,
          run,
          "completion.override_audited",
          undefined,
          {
            documentId: input.documentId,
            taskId: input.taskId,
            attemptId: input.attemptId,
          },
          {
            completionId: completion.id,
            source: overrideAudit.source,
            force: overrideAudit.force,
            reason: overrideAudit.reason,
            overriddenGateIds: overrideAudit.overriddenGateIds,
          },
          overrideAudit.eventId,
        )
      }
      appendMutationEvent(
        database,
        run,
        "completion.prepared",
        input.event,
        {
          documentId: input.documentId,
          taskId: input.taskId,
          attemptId: input.attemptId,
        },
        {
          completionId: completion.id,
          expectedBeforeHash: completion.expectedBeforeHash,
        },
      )
      return completion
    })(),
  )
}

export function getCompletionTransaction(
  path: string,
  completionId: string,
): CompletionTransactionRecord | undefined {
  return withLedger(path, (database) => findCompletionInDatabase(database, completionId))
}

export function markCompletionMarkerWritten(
  path: string,
  input: MarkCompletionMarkerWrittenInput,
): CompletionTransactionRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const current = requireCompletion(database, input.completionId)
      if (current.status !== "prepared") {
        throw new RalphError(
          "RALPH_COMPLETION_INVALID_TRANSITION",
          `Completion ${current.id} cannot move from ${current.status} to marker_written`,
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      const run = requireRun(database, current.runId)
      const markerWrittenAt = input.markerWrittenAt ?? now()
      database
        .query(
          `UPDATE completion_transactions SET status = 'marker_written',
             expected_after_hash = ?, marker_written_at = ?
           WHERE id = ? AND status = 'prepared'`,
        )
        .run(input.expectedAfterHash, markerWrittenAt, input.completionId)
      const completion = requireCompletion(database, input.completionId)
      appendMutationEvent(
        database,
        run,
        "completion.marker_written",
        input.event,
        {
          documentId: completion.documentId,
          taskId: completion.taskId,
          attemptId: completion.attemptId,
        },
        {
          completionId: completion.id,
          expectedBeforeHash: completion.expectedBeforeHash,
          expectedAfterHash: completion.expectedAfterHash,
        },
      )
      return completion
    })(),
  )
}

export function commitCompletion(
  path: string,
  input: CommitCompletionInput,
): CompletionTransactionRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const current = requireCompletion(database, input.completionId)
      if (current.status !== "marker_written") {
        throw new RalphError(
          "RALPH_COMPLETION_INVALID_TRANSITION",
          `Completion ${current.id} cannot move from ${current.status} to committed`,
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      if (current.expectedAfterHash !== input.markerContentHash) {
        throw new RalphError(
          "RALPH_COMPLETION_HASH_CONFLICT",
          `Marker hash does not match completion ${current.id}`,
          {
            exitCode: EXIT_CODES.invalidUsage,
            details: {
              expected: current.expectedAfterHash,
              actual: input.markerContentHash,
            },
          },
        )
      }
      const run = requireRun(database, current.runId)
      const task = findTaskInDatabase(database, current.runId, current.documentId, current.taskId)
      if (!task) throw recordNotFound("task", `${current.documentId}/${current.taskId}`)
      if (task.markerContentHash !== current.expectedBeforeHash) {
        throw new RalphError(
          "RALPH_COMPLETION_HASH_CONFLICT",
          `Ledger task hash changed while completion ${current.id} was pending`,
          {
            exitCode: EXIT_CODES.invalidUsage,
            details: {
              expected: current.expectedBeforeHash,
              actual: task.markerContentHash,
            },
          },
        )
      }
      const committedAt = input.committedAt ?? now()
      const completion = CompletionDecisionSchema.parse(input.completion ?? current.decision)
      if (
        stringifyObject(completion, "completion decision") !==
        stringifyObject(current.decision, "prepared completion decision")
      ) {
        throw invalidRecord(
          "RALPH_COMPLETION_DECISION_CHANGED",
          "The decision committed must be identical to the prepared completion decision",
        )
      }
      const evidenceRow = database
        .query<EvidenceBundleRow, [string]>(
          `SELECT ${EVIDENCE_COLUMNS} FROM evidence_bundles WHERE id = ?`,
        )
        .get(current.decision.evidenceBundleId)
      if (!evidenceRow) throw recordNotFound("evidence", current.decision.evidenceBundleId)
      const evidence = evidenceFromRow(path, evidenceRow).bundle
      if (
        evidence.runId !== current.runId ||
        evidence.documentId !== current.documentId ||
        evidence.taskId !== current.taskId ||
        evidence.attemptId !== current.attemptId
      ) {
        throw invalidRecord(
          "RALPH_COMPLETION_EVIDENCE_MISMATCH",
          "Prepared completion evidence no longer binds to its run, task and attempt",
        )
      }
      validateCompletionApproval(completion, evidence, current.overrideAudit)
      const taskStatus =
        input.taskStatus ??
        (completion.status === "overridden" ? "completed_with_override" : "completed")
      if ((completion.status === "overridden") !== (taskStatus === "completed_with_override")) {
        throw invalidRecord(
          "RALPH_COMPLETION_STATUS_MISMATCH",
          `Task status ${taskStatus} does not match decision status ${completion.status}`,
        )
      }
      database
        .query(
          `UPDATE run_tasks SET status = ?, marker_content_hash = ?, active_attempt_id = NULL,
             completion_json = ?, updated_at = ?
           WHERE run_id = ? AND document_id = ? AND task_id = ?`,
        )
        .run(
          taskStatus,
          input.markerContentHash,
          stringifyObject(completion, "task completion"),
          committedAt,
          current.runId,
          current.documentId,
          current.taskId,
        )
      database
        .query(
          `UPDATE completion_transactions SET status = 'committed', committed_at = ?
           WHERE id = ? AND status = 'marker_written'`,
        )
        .run(committedAt, input.completionId)
      database
        .query(
          `UPDATE attempts SET status = 'passed', phase = 'decision',
             completion_decision_json = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
           WHERE id = ?`,
        )
        .run(
          stringifyObject(completion, "completion decision"),
          committedAt,
          committedAt,
          current.attemptId,
        )
      const committed = requireCompletion(database, input.completionId)
      const references = {
        documentId: committed.documentId,
        taskId: committed.taskId,
        attemptId: committed.attemptId,
      }
      appendMutationEvent(database, run, "task.completed", input.event, references, {
        completionId: committed.id,
        status: taskStatus,
        markerContentHash: input.markerContentHash,
      })
      const progress = database
        .query<{ completed: number; total: number }, [string]>(
          `SELECT
             SUM(CASE WHEN status IN ('completed', 'completed_with_override') THEN 1 ELSE 0 END) AS completed,
             COUNT(*) AS total
           FROM run_tasks WHERE run_id = ?`,
        )
        .get(committed.runId)
      appendMutationEvent(database, run, "progress.updated", undefined, references, {
        completed: progress?.completed ?? 0,
        total: progress?.total ?? 0,
        completedDocumentId: committed.documentId,
        completedTaskId: committed.taskId,
      })
      return committed
    })(),
  )
}

export function commitRecordOnlyCompletion(
  path: string,
  input: CommitRecordOnlyCompletionInput,
): RunTaskRecord {
  return withLedger(path, (database) =>
    database.transaction(() => {
      const run = requireRun(database, input.runId)
      if (run.source?.kind !== "ad-hoc") {
        throw invalidRecord(
          "RALPH_RECORD_ONLY_COMPLETION_SOURCE_INVALID",
          "Record-only completion is restricted to persisted ad-hoc work sources",
        )
      }
      const decision = CompletionDecisionSchema.parse(input.decision)
      const overrideAudit =
        input.overrideAudit === undefined
          ? undefined
          : CompletionOverrideAuditSchema.parse(input.overrideAudit)
      const task = findTaskInDatabase(database, input.runId, input.documentId, input.taskId)
      if (!task) throw recordNotFound("task", `${input.documentId}/${input.taskId}`)
      if (task.status === "completed" || task.status === "completed_with_override") {
        throw new RalphError(
          "RALPH_COMPLETION_ALREADY_COMMITTED",
          `Task is already complete: ${input.documentId}/${input.taskId}`,
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      if (task.status !== "evaluating" || task.activeAttemptId !== input.attemptId) {
        throw invalidRecord(
          "RALPH_RECORD_ONLY_COMPLETION_ATTEMPT_INACTIVE",
          "Record-only completion requires the active evaluating attempt",
          {
            status: task.status,
            activeAttemptId: task.activeAttemptId,
            requestedAttemptId: input.attemptId,
          },
        )
      }
      if (task.markerContentHash !== input.markerContentHash) {
        throw invalidRecord(
          "RALPH_RECORD_ONLY_COMPLETION_IDENTITY_CHANGED",
          "The ad-hoc execution identity changed before completion",
          { expected: input.markerContentHash, actual: task.markerContentHash },
        )
      }
      const attempt = requireAttempt(database, input.attemptId)
      if (
        attempt.runId !== input.runId ||
        attempt.documentId !== input.documentId ||
        attempt.taskId !== input.taskId ||
        attempt.evidenceBundleId !== decision.evidenceBundleId
      ) {
        throw invalidRecord(
          "RALPH_COMPLETION_EVIDENCE_MISMATCH",
          "Completion decision does not bind to the active ad-hoc attempt and evidence",
        )
      }
      const evidenceRow = database
        .query<EvidenceBundleRow, [string]>(
          `SELECT ${EVIDENCE_COLUMNS} FROM evidence_bundles WHERE id = ?`,
        )
        .get(decision.evidenceBundleId)
      if (!evidenceRow) throw recordNotFound("evidence", decision.evidenceBundleId)
      const evidence = evidenceFromRow(path, evidenceRow).bundle
      if (
        evidence.runId !== input.runId ||
        evidence.documentId !== input.documentId ||
        evidence.taskId !== input.taskId ||
        evidence.attemptId !== input.attemptId
      ) {
        throw invalidRecord(
          "RALPH_COMPLETION_EVIDENCE_MISMATCH",
          "Persisted evidence does not belong to the ad-hoc work being completed",
        )
      }
      validateCompletionApproval(decision, evidence, overrideAudit)
      const taskStatus = decision.status === "overridden" ? "completed_with_override" : "completed"
      const committedAt = input.committedAt ?? now()
      database
        .query(
          `UPDATE run_tasks SET status = ?, active_attempt_id = NULL,
             completion_json = ?, updated_at = ?
           WHERE run_id = ? AND document_id = ? AND task_id = ?
             AND status = 'evaluating' AND active_attempt_id = ?`,
        )
        .run(
          taskStatus,
          stringifyObject(decision, "task completion"),
          committedAt,
          input.runId,
          input.documentId,
          input.taskId,
          input.attemptId,
        )
      database
        .query(
          `UPDATE attempts SET status = 'passed', phase = 'decision',
             completion_decision_json = ?, finished_at = COALESCE(finished_at, ?), updated_at = ?
           WHERE id = ?`,
        )
        .run(
          stringifyObject(decision, "completion decision"),
          committedAt,
          committedAt,
          input.attemptId,
        )
      const references = {
        documentId: input.documentId,
        taskId: input.taskId,
        attemptId: input.attemptId,
      }
      if (overrideAudit) {
        appendMutationEvent(
          database,
          run,
          "completion.override_audited",
          undefined,
          references,
          {
            source: overrideAudit.source,
            force: overrideAudit.force,
            reason: overrideAudit.reason,
            overriddenGateIds: overrideAudit.overriddenGateIds,
            markerUpdated: false,
          },
          overrideAudit.eventId,
        )
      }
      appendMutationEvent(database, run, "task.completed.record_only", input.event, references, {
        status: taskStatus,
        markerUpdated: false,
        evidenceBundleId: decision.evidenceBundleId,
      })
      const progress = database
        .query<{ completed: number; total: number }, [string]>(
          `SELECT
             SUM(CASE WHEN status IN ('completed', 'completed_with_override') THEN 1 ELSE 0 END) AS completed,
             COUNT(*) AS total
           FROM run_tasks WHERE run_id = ?`,
        )
        .get(input.runId)
      appendMutationEvent(database, run, "progress.updated", undefined, references, {
        completed: progress?.completed ?? 0,
        total: progress?.total ?? 0,
        completedDocumentId: input.documentId,
        completedTaskId: input.taskId,
        markerUpdated: false,
      })
      const completed = findTaskInDatabase(database, input.runId, input.documentId, input.taskId)
      if (!completed) throw recordNotFound("task", `${input.documentId}/${input.taskId}`)
      if (
        completed.status !== taskStatus ||
        completed.activeAttemptId !== undefined ||
        completed.completion?.evidenceBundleId !== decision.evidenceBundleId
      ) {
        throw new RalphError(
          "RALPH_RECORD_ONLY_COMPLETION_COMMIT_CONFLICT",
          "The ad-hoc task did not settle to the authorized record-only completion",
          { exitCode: EXIT_CODES.conflict },
        )
      }
      return completed
    })(),
  )
}

export function listPreparedCompletions(
  path: string,
  runId?: string,
): CompletionTransactionRecord[] {
  return withLedger(path, (database) => {
    const rows = database
      .query<CompletionTransactionRow, [string, string]>(
        `SELECT ${COMPLETION_COLUMNS} FROM completion_transactions
         WHERE (? = '' OR run_id = ?)
           AND status IN ('prepared', 'marker_written')
         ORDER BY prepared_at, id`,
      )
      .all(runId ?? "", runId ?? "")
    return rows.map(completionFromRow)
  })
}

export function reconcilePreparedCompletion(
  path: string,
  input: ReconcilePreparedCompletionInput,
): CompletionTransactionRecord {
  if (input.target === "marker_written") {
    return markCompletionMarkerWritten(path, input)
  }
  return commitCompletion(path, input)
}
