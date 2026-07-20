import { constants, Database } from "bun:sqlite"
import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  EffectiveRunOptionsSchema,
  EXIT_CODES,
  parseTelemetryEventRetention,
  RalphError,
} from "@ralph-next/domain"
import {
  acquireFilesystemLease,
  type EventEnvelope,
  EventEnvelopeConsumerSchema,
  EventEnvelopeSchema,
  type EventInput,
  redactValue,
  secretValuesFromEnvironment,
} from "@ralph-next/telemetry"
import { writeFileAtomic } from "./atomic"
import { CHILD_RUN_LINKS_MIGRATION_SQL } from "./child-run-links-migration"
import type { WorkspaceLayout } from "./paths"
import { purgeDiagnosticRawCaptures } from "./telemetry-policy"

const ledgerSecretCounts = new Map<string, Map<string, number>>()
const databaseSecrets = new WeakMap<Database, readonly string[]>()
const ledgerEventRetentionContextId = `${process.pid}:${crypto.randomUUID()}`

function ledgerKey(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLocaleLowerCase("und") : normalized
}

function registeredSecrets(path: string): string[] {
  return [...(ledgerSecretCounts.get(ledgerKey(path))?.keys() ?? [])]
}

/**
 * Registers execution-scoped secret values for persistence redaction without
 * writing them to config or the ledger. Registrations are reference-counted so
 * concurrent command clients sharing one workspace cannot release each other.
 */
export function registerLedgerRedactionSecrets(
  path: string,
  values: readonly string[],
): () => void {
  const key = ledgerKey(path)
  const secrets = [...new Set(values.filter((value) => value.length > 0))]
  const counts = ledgerSecretCounts.get(key) ?? new Map<string, number>()
  ledgerSecretCounts.set(key, counts)
  for (const secret of secrets) counts.set(secret, (counts.get(secret) ?? 0) + 1)

  let released = false
  return () => {
    if (released) return
    released = true
    const current = ledgerSecretCounts.get(key)
    if (!current) return
    for (const secret of secrets) {
      const count = current.get(secret) ?? 0
      if (count <= 1) current.delete(secret)
      else current.set(secret, count - 1)
    }
    if (current.size === 0) ledgerSecretCounts.delete(key)
  }
}

/**
 * Compatibility boundary for callers composed before per-event durable
 * snapshots. It validates the expression but owns no retention authority;
 * appendEventInTransaction snapshots workspace input or the durable run.
 */
export function registerLedgerEventRetention(path: string, expression: string | null): () => void {
  snapshotLedgerWorkspaceEventRetention(path, expression)
  return () => undefined
}

/** Persists the current workspace policy so independent command processes agree. */
export function snapshotLedgerWorkspaceEventRetention(
  path: string,
  expression: string | null,
): void {
  const snapshot = retentionSnapshotFromExpression(expression)
  const updatedAt = new Date().toISOString()
  withLedger(path, (database) =>
    database.transaction(() => {
      const available = database
        .query<{ present: number }, []>(
          `SELECT 1 AS present FROM sqlite_master
            WHERE type = 'table' AND name = 'workspace_event_retention_contexts'`,
        )
        .get()
      if (!available) return
      database
        .query(
          `INSERT INTO workspace_event_retention_contexts(
             context_id, expression, retention_ms, updated_at
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(context_id) DO UPDATE SET
             expression = excluded.expression,
             retention_ms = excluded.retention_ms,
             updated_at = excluded.updated_at
           WHERE workspace_event_retention_contexts.expression IS NOT excluded.expression
              OR workspace_event_retention_contexts.retention_ms IS NOT excluded.retention_ms`,
        )
        .run(ledgerEventRetentionContextId, expression, snapshot.retentionMs ?? null, updatedAt)
    })(),
  )
}

export type EventRetentionReceipt = {
  readonly removedEvents: number
  readonly retainedEvents: number
  readonly expiredRunIds: readonly string[]
}

type EventRetentionSnapshot = {
  readonly known: boolean
  readonly retentionMs?: number
}

function retentionSnapshotFromExpression(expression: string | null): EventRetentionSnapshot {
  const retentionMs = parseTelemetryEventRetention(expression)
  return {
    known: true,
    ...(retentionMs === undefined ? {} : { retentionMs }),
  }
}

function snapshottedRunRetention(serializedOptions: string): EventRetentionSnapshot {
  try {
    const options = EffectiveRunOptionsSchema.parse(JSON.parse(serializedOptions))
    const policy = options.telemetryPolicy?.value
    if (!policy || !Object.hasOwn(policy, "event_retention")) {
      return { known: false }
    }
    return retentionSnapshotFromExpression(policy.event_retention)
  } catch {
    // Unknown or legacy snapshots fail closed: retention never guesses that a
    // run is disposable when its immutable policy cannot be proven.
    return { known: false }
  }
}

function eventRetentionSnapshot(database: Database, input: EventInput): EventRetentionSnapshot {
  if (input.scope === "workspace" && input.eventRetention !== undefined) {
    return retentionSnapshotFromExpression(input.eventRetention)
  }
  if (input.scope === "workspace") {
    const workspace = database
      .query<{ expression: string | null; retention_ms: number | null }, [string]>(
        `SELECT expression, retention_ms FROM workspace_event_retention_contexts
          WHERE context_id = ?`,
      )
      .get(ledgerEventRetentionContextId)
    if (!workspace) return { known: false }
    if (workspace.expression === null) return { known: true }
    return {
      known: true,
      ...(workspace.retention_ms === null ? {} : { retentionMs: workspace.retention_ms }),
    }
  }
  if (!input.runId) return { known: false }
  const run = database
    .query<{ effective_options_json: string }, [string]>(
      "SELECT effective_options_json FROM runs WHERE id = ?",
    )
    .get(input.runId)
  return run ? snapshottedRunRetention(run.effective_options_json) : { known: false }
}

/**
 * Every deletion decision comes from the policy snapshot stored on the event
 * row. Unknown legacy rows and explicit-null rows are never candidates.
 */
function applyDurableEventRetention(path: string): EventRetentionReceipt {
  const nowMs = Date.now()
  return withLedger(path, (database) =>
    database.transaction(() => {
      const candidates = database
        .query<{ event_id: string; created_at: string; event_retention_ms: number }, []>(
          `SELECT events.event_id, events.created_at, events.event_retention_ms
             FROM events
            WHERE events.event_retention_known = 1
              AND events.event_retention_ms IS NOT NULL
              AND events.event_type NOT IN (
                'workspace.initialized',
                'workspace.repaired',
                'task.manual-completion.requested',
                'task.manual-completion.applied'
              )
              AND (
                events.run_id IS NULL
                OR EXISTS (
                  SELECT 1 FROM runs
                   WHERE runs.id = events.run_id
                     AND runs.status IN ('completed', 'failed', 'cancelled')
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM outbox
                 WHERE outbox.event_id = events.event_id
                   AND outbox.published_at IS NULL
              )
            ORDER BY events.sequence`,
        )
        .all()
        .filter((candidate) => {
          const createdAt = Date.parse(candidate.created_at)
          return Number.isFinite(createdAt) && nowMs - createdAt > candidate.event_retention_ms
        })
      const deleteOutbox = database.query(
        "DELETE FROM outbox WHERE event_id = ? AND published_at IS NOT NULL",
      )
      const deleteEvent = database.query(
        "DELETE FROM events WHERE event_id = ? AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.event_id = events.event_id)",
      )
      let removedEvents = 0
      for (const candidate of candidates) {
        deleteOutbox.run(candidate.event_id)
        removedEvents += Number(deleteEvent.run(candidate.event_id).changes)
      }
      const retainedEvents = Number(
        database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
          ?.count ?? 0,
      )
      const terminalRuns = database
        .query<{ id: string; effective_options_json: string; terminal_at: string }, []>(
          `SELECT id, effective_options_json,
                  COALESCE(finished_at, updated_at, created_at) AS terminal_at
             FROM runs
            WHERE status IN ('completed', 'failed', 'cancelled')
            ORDER BY id`,
        )
        .all()
      const expiredRunIds = terminalRuns.flatMap((run) => {
        const snapshot = snapshottedRunRetention(run.effective_options_json)
        const terminalAt = Date.parse(run.terminal_at)
        if (
          !snapshot.known ||
          snapshot.retentionMs === undefined ||
          !Number.isFinite(terminalAt) ||
          nowMs - terminalAt <= snapshot.retentionMs
        ) {
          return []
        }
        const retained = database
          .query<{ present: number }, [string]>(
            `SELECT 1 AS present FROM events
              WHERE run_id = ?
              LIMIT 1`,
          )
          .get(run.id)
        return retained ? [] : [run.id]
      })
      return {
        removedEvents,
        retainedEvents,
        expiredRunIds,
      }
    })(),
  )
}

export function persistenceSecretValues(database: Database): string[] {
  return [...new Set([...secretValuesFromEnvironment(), ...(databaseSecrets.get(database) ?? [])])]
}

export const INITIAL_MIGRATION_SQL = `-- Ralph v2 ledger schema v1
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id),
  sequence INTEGER NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  published_at TEXT
);
`

export const ORCHESTRATION_MIGRATION_SQL = `-- Ralph v2 orchestration schema v2
ALTER TABLE events ADD COLUMN run_id TEXT;
ALTER TABLE events ADD COLUMN document_id TEXT;
ALTER TABLE events ADD COLUMN task_id TEXT;
ALTER TABLE events ADD COLUMN attempt_id TEXT;
ALTER TABLE events ADD COLUMN event_type TEXT;

CREATE INDEX IF NOT EXISTS events_run_sequence_idx ON events(run_id, sequence);
CREATE INDEX IF NOT EXISTS events_task_sequence_idx ON events(run_id, document_id, task_id, sequence);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  root_prd_id TEXT NOT NULL,
  root_prd_file TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  graph_hash TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  effective_options_hash TEXT NOT NULL,
  effective_options_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  stop_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_resume_idx
  ON runs(workspace_id, root_prd_file, definition_hash, status, updated_at);

CREATE TABLE IF NOT EXISTS run_tasks (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  marker_content_hash TEXT NOT NULL,
  active_attempt_id TEXT,
  completion_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, document_id, task_id)
);

CREATE INDEX IF NOT EXISTS run_tasks_status_idx ON run_tasks(run_id, status, updated_at);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  context_manifest_hash TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  counters_json TEXT NOT NULL,
  executor_outcome_json TEXT,
  evidence_bundle_id TEXT,
  completion_decision_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, document_id, task_id, ordinal)
);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  outcome_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(attempt_id, ordinal)
);

CREATE TABLE IF NOT EXISTS gate_results (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  gate_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(attempt_id, gate_id)
);

CREATE TABLE IF NOT EXISTS evidence_bundles (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS completion_transactions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  expected_before_hash TEXT NOT NULL,
  expected_after_hash TEXT,
  decision_json TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  marker_written_at TEXT,
  committed_at TEXT
);

CREATE INDEX IF NOT EXISTS completion_pending_idx
  ON completion_transactions(run_id, status, prepared_at);

CREATE UNIQUE INDEX IF NOT EXISTS completion_one_pending_task_idx
  ON completion_transactions(run_id, document_id, task_id)
  WHERE status IN ('prepared', 'marker_written');

CREATE TABLE IF NOT EXISTS run_reports (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

export const EXECUTION_HARDENING_MIGRATION_SQL = `-- Ralph v2 execution hardening schema v3
ALTER TABLE model_calls ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE model_calls ADD COLUMN updated_at TEXT;
ALTER TABLE completion_transactions ADD COLUMN override_audit_json TEXT;

CREATE INDEX IF NOT EXISTS model_calls_attempt_status_idx
  ON model_calls(attempt_id, status, ordinal);
`

const EMPTY_SHA256 = "0".repeat(64)

export const ATTEMPT_EFFECTIVE_OPTIONS_MIGRATION_SQL = `-- Ralph v2 attempt options schema v4
ALTER TABLE attempts ADD COLUMN effective_options_hash TEXT NOT NULL DEFAULT '${EMPTY_SHA256}';
ALTER TABLE attempts ADD COLUMN effective_options_json TEXT NOT NULL DEFAULT '{}';

CREATE TRIGGER IF NOT EXISTS attempts_effective_options_insert_guard
BEFORE INSERT ON attempts
WHEN CASE
  WHEN length(NEW.effective_options_hash) <> 64 THEN 1
  WHEN NEW.effective_options_hash GLOB '*[^0-9a-f]*' THEN 1
  WHEN json_valid(NEW.effective_options_json) <> 1 THEN 1
  WHEN json_extract(NEW.effective_options_json, '$.contentHash') IS NOT NEW.effective_options_hash THEN 1
  ELSE 0
END
BEGIN
  SELECT RAISE(ABORT, 'attempt effective options hash mismatch');
END;

CREATE TRIGGER IF NOT EXISTS attempts_effective_options_update_guard
BEFORE UPDATE OF effective_options_hash, effective_options_json ON attempts
WHEN CASE
  WHEN length(NEW.effective_options_hash) <> 64 THEN 1
  WHEN NEW.effective_options_hash GLOB '*[^0-9a-f]*' THEN 1
  WHEN json_valid(NEW.effective_options_json) <> 1 THEN 1
  WHEN json_extract(NEW.effective_options_json, '$.contentHash') IS NOT NEW.effective_options_hash THEN 1
  ELSE 0
END
BEGIN
  SELECT RAISE(ABORT, 'attempt effective options hash mismatch');
END;

UPDATE attempts
SET effective_options_hash = (
      SELECT runs.effective_options_hash FROM runs WHERE runs.id = attempts.run_id
    ),
    effective_options_json = (
      SELECT runs.effective_options_json FROM runs WHERE runs.id = attempts.run_id
    );
`

export const MODEL_CALL_CONTEXT_MIGRATION_SQL = `-- Ralph v2 model-call context binding schema v5
ALTER TABLE model_calls ADD COLUMN context_manifest_hash TEXT NOT NULL DEFAULT '${EMPTY_SHA256}';

CREATE TRIGGER IF NOT EXISTS model_calls_context_hash_insert_guard
BEFORE INSERT ON model_calls
WHEN length(NEW.context_manifest_hash) <> 64
  OR NEW.context_manifest_hash GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'model call context manifest hash invalid');
END;

CREATE TRIGGER IF NOT EXISTS model_calls_context_hash_update_guard
BEFORE UPDATE OF context_manifest_hash ON model_calls
WHEN length(NEW.context_manifest_hash) <> 64
  OR NEW.context_manifest_hash GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'model call context manifest hash invalid');
END;

UPDATE model_calls
SET context_manifest_hash = (
  SELECT attempts.context_manifest_hash
  FROM attempts
  WHERE attempts.id = model_calls.attempt_id
);
`

export const TOOL_CALL_JOURNAL_MIGRATION_SQL = `-- Ralph v2 tool-call journal schema v6
CREATE TABLE IF NOT EXISTS tool_call_intents (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  run_id TEXT NOT NULL REFERENCES runs(id) CHECK(length(run_id) BETWEEN 1 AND 512),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 512),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  attempt_id TEXT NOT NULL REFERENCES attempts(id) CHECK(length(attempt_id) BETWEEN 1 AND 512),
  model_call_id TEXT NOT NULL REFERENCES model_calls(id) CHECK(length(model_call_id) BETWEEN 1 AND 512),
  provider_tool_call_id TEXT NOT NULL CHECK(length(provider_tool_call_id) BETWEEN 1 AND 512),
  tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 128),
  arguments_hash TEXT NOT NULL CHECK(
    length(arguments_hash) = 64 AND arguments_hash NOT GLOB '*[^0-9a-f]*'
  ),
  arguments_redacted_json TEXT NOT NULL CHECK(
    json_valid(arguments_redacted_json) = 1 AND length(arguments_redacted_json) <= 65536
  ),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(
    length(idempotency_key) = 64 AND idempotency_key NOT GLOB '*[^0-9a-f]*'
  ),
  risk TEXT NOT NULL CHECK(
    risk IN ('read', 'write', 'process', 'network', 'external-effect', 'destructive')
  ),
  effect_class TEXT NOT NULL CHECK(
    effect_class IN (
      'read-only', 'workspace-write', 'process', 'network', 'external-effect', 'destructive'
    )
  ),
  authorization TEXT NOT NULL CHECK(authorization IN ('allowed', 'denied', 'asked')),
  recovery_strategy TEXT NOT NULL CHECK(
    recovery_strategy IN (
      'safe-to-retry', 'verify-preconditions', 'inspect-process',
      'manual-reconciliation', 'never-retry'
    )
  ),
  precondition_refs_hash TEXT NOT NULL CHECK(
    length(precondition_refs_hash) = 64 AND precondition_refs_hash NOT GLOB '*[^0-9a-f]*'
  ),
  precondition_refs_json TEXT NOT NULL CHECK(
    json_valid(precondition_refs_json) = 1 AND length(precondition_refs_json) <= 32768
  ),
  requested_at TEXT NOT NULL,
  UNIQUE(model_call_id, provider_tool_call_id)
);

CREATE INDEX IF NOT EXISTS tool_call_intents_run_requested_idx
  ON tool_call_intents(run_id, requested_at, id);
CREATE INDEX IF NOT EXISTS tool_call_intents_attempt_requested_idx
  ON tool_call_intents(attempt_id, requested_at, id);

CREATE TABLE IF NOT EXISTS tool_call_settlements (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  intent_id TEXT NOT NULL UNIQUE REFERENCES tool_call_intents(id),
  outcome TEXT NOT NULL CHECK(
    outcome IN (
      'succeeded', 'failed', 'nonzero', 'denied', 'timeout', 'cancelled',
      'interrupted', 'needs-reconciliation'
    )
  ),
  result_hash TEXT NOT NULL CHECK(
    length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*'
  ),
  result_redacted_json TEXT NOT NULL CHECK(
    json_valid(result_redacted_json) = 1 AND length(result_redacted_json) <= 65536
  ),
  effect_refs_hash TEXT NOT NULL CHECK(
    length(effect_refs_hash) = 64 AND effect_refs_hash NOT GLOB '*[^0-9a-f]*'
  ),
  effect_refs_json TEXT NOT NULL CHECK(
    json_valid(effect_refs_json) = 1 AND length(effect_refs_json) <= 32768
  ),
  output_refs_hash TEXT NOT NULL CHECK(
    length(output_refs_hash) = 64 AND output_refs_hash NOT GLOB '*[^0-9a-f]*'
  ),
  output_refs_json TEXT NOT NULL CHECK(
    json_valid(output_refs_json) = 1 AND length(output_refs_json) <= 32768
  ),
  error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 256),
  settled_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tool_call_settlements_settled_idx
  ON tool_call_settlements(settled_at, id);

CREATE TRIGGER IF NOT EXISTS tool_call_intents_scope_guard
BEFORE INSERT ON tool_call_intents
WHEN NOT EXISTS (
  SELECT 1
  FROM model_calls AS model_call
  JOIN attempts AS attempt ON attempt.id = model_call.attempt_id
  WHERE model_call.id = NEW.model_call_id
    AND model_call.attempt_id = NEW.attempt_id
    AND attempt.run_id = NEW.run_id
    AND attempt.document_id = NEW.document_id
    AND attempt.task_id = NEW.task_id
)
BEGIN
  SELECT RAISE(ABORT, 'tool call intent scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS tool_call_intents_immutable_update
BEFORE UPDATE ON tool_call_intents
BEGIN
  SELECT RAISE(ABORT, 'tool call intents are append-only');
END;

CREATE TRIGGER IF NOT EXISTS tool_call_intents_immutable_delete
BEFORE DELETE ON tool_call_intents
BEGIN
  SELECT RAISE(ABORT, 'tool call intents are append-only');
END;

CREATE TRIGGER IF NOT EXISTS tool_call_settlements_immutable_update
BEFORE UPDATE ON tool_call_settlements
BEGIN
  SELECT RAISE(ABORT, 'tool call settlements are append-only');
END;

CREATE TRIGGER IF NOT EXISTS tool_call_settlements_immutable_delete
BEFORE DELETE ON tool_call_settlements
BEGIN
  SELECT RAISE(ABORT, 'tool call settlements are append-only');
END;
`

export const EVIDENCE_STORE_MIGRATION_SQL = `-- Ralph v2 immutable evidence store schema v7
ALTER TABLE evidence_bundles ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE evidence_bundles ADD COLUMN content_ref TEXT;
ALTER TABLE evidence_bundles ADD COLUMN storage_hash TEXT;
ALTER TABLE evidence_bundles ADD COLUMN size_bytes INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS evidence_bundles_content_ref_idx
  ON evidence_bundles(content_ref)
  WHERE content_ref IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS evidence_bundles_immutable_update
BEFORE UPDATE ON evidence_bundles
BEGIN
  SELECT RAISE(ABORT, 'evidence bundles are append-only');
END;
`

export const JUDGE_ASSESSMENT_MIGRATION_SQL = `-- Ralph v2 judge calls and assessments schema v8
CREATE TABLE IF NOT EXISTS judge_calls (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(typeof(schema_version) = 'integer' AND schema_version = 1),
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(typeof(ordinal) = 'integer' AND ordinal > 0),
  transport_ordinal INTEGER NOT NULL CHECK(
    typeof(transport_ordinal) = 'integer' AND transport_ordinal >= 0
  ),
  kind TEXT NOT NULL CHECK(kind IN ('external', 'self')),
  profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 512),
  backend_id TEXT NOT NULL CHECK(length(backend_id) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK(status IN ('started', 'succeeded', 'failed', 'cancelled')),
  request_hash TEXT NOT NULL CHECK(
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  error_message TEXT CHECK(error_message IS NULL OR length(error_message) BETWEEN 1 AND 65536),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK(
    (status = 'started' AND finished_at IS NULL) OR
    (status <> 'started' AND finished_at IS NOT NULL)
  ),
  UNIQUE(attempt_id, ordinal)
);

CREATE INDEX IF NOT EXISTS judge_calls_attempt_status_idx
  ON judge_calls(attempt_id, status, ordinal);

CREATE TABLE IF NOT EXISTS judge_assessments (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(typeof(schema_version) = 'integer' AND schema_version = 1),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id) ON DELETE CASCADE,
  evidence_bundle_id TEXT NOT NULL UNIQUE REFERENCES evidence_bundles(id),
  judge_call_id TEXT NOT NULL UNIQUE REFERENCES judge_calls(id),
  kind TEXT NOT NULL CHECK(kind IN ('external', 'self')),
  score INTEGER NOT NULL CHECK(typeof(score) = 'integer' AND score BETWEEN 0 AND 100),
  content_hash TEXT NOT NULL CHECK(
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  content_ref TEXT CHECK(
    content_ref IS NULL OR length(content_ref) BETWEEN 1 AND 4096
  ),
  assessment_json TEXT NOT NULL CHECK(
    json_valid(assessment_json) = 1 AND length(assessment_json) BETWEEN 2 AND 4194304
  ),
  created_at TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS judge_calls_transition_guard
BEFORE UPDATE ON judge_calls
WHEN OLD.status <> 'started'
  OR NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.ordinal IS NOT OLD.ordinal
  OR NEW.transport_ordinal IS NOT OLD.transport_ordinal
  OR NEW.kind IS NOT OLD.kind
  OR NEW.profile_id IS NOT OLD.profile_id
  OR NEW.backend_id IS NOT OLD.backend_id
  OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.status = 'started'
  OR NEW.finished_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'judge call transition is invalid or immutable');
END;

CREATE TRIGGER IF NOT EXISTS judge_calls_immutable_delete
BEFORE DELETE ON judge_calls
BEGIN
  SELECT RAISE(ABORT, 'judge calls are durable');
END;

CREATE TRIGGER IF NOT EXISTS judge_assessments_scope_guard
BEFORE INSERT ON judge_assessments
WHEN NOT EXISTS (
  SELECT 1
  FROM judge_calls AS judge_call
  JOIN evidence_bundles AS evidence ON evidence.id = NEW.evidence_bundle_id
  WHERE judge_call.id = NEW.judge_call_id
    AND judge_call.attempt_id = NEW.attempt_id
    AND judge_call.kind = NEW.kind
    AND judge_call.status = 'succeeded'
    AND evidence.attempt_id = NEW.attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'judge assessment scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS judge_assessments_json_guard
BEFORE INSERT ON judge_assessments
WHEN json_extract(NEW.assessment_json, '$.schemaVersion') IS NOT 1
  OR json_extract(NEW.assessment_json, '$.id') IS NOT NEW.id
  OR json_extract(NEW.assessment_json, '$.kind') IS NOT NEW.kind
  OR json_extract(NEW.assessment_json, '$.evidenceBundleId') IS NOT NEW.evidence_bundle_id
  OR json_extract(NEW.assessment_json, '$.score') IS NOT NEW.score
  OR json_extract(NEW.assessment_json, '$.createdAt') IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'judge assessment columns do not match assessment JSON');
END;

CREATE TRIGGER IF NOT EXISTS judge_assessments_immutable_update
BEFORE UPDATE ON judge_assessments
BEGIN
  SELECT RAISE(ABORT, 'judge assessments are append-only');
END;

CREATE TRIGGER IF NOT EXISTS judge_assessments_immutable_delete
BEFORE DELETE ON judge_assessments
BEGIN
  SELECT RAISE(ABORT, 'judge assessments are append-only');
END;
`

export const DURABLE_LEASES_MIGRATION_SQL = `-- Ralph v2 durable supervisor leases schema v9
CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(typeof(schema_version) = 'integer' AND schema_version = 1),
  kind TEXT NOT NULL CHECK(kind IN ('workspace-supervisor', 'run-supervisor', 'worker')),
  resource_key TEXT NOT NULL CHECK(length(resource_key) BETWEEN 1 AND 4096),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT CHECK(run_id IS NULL OR length(run_id) BETWEEN 1 AND 512),
  owner_instance_id TEXT NOT NULL CHECK(length(owner_instance_id) BETWEEN 1 AND 512),
  worker_id TEXT CHECK(worker_id IS NULL OR length(worker_id) BETWEEN 1 AND 512),
  pid INTEGER NOT NULL CHECK(typeof(pid) = 'integer' AND pid > 0),
  process_start_token TEXT NOT NULL CHECK(length(process_start_token) BETWEEN 1 AND 1024),
  hostname TEXT NOT NULL CHECK(length(hostname) BETWEEN 1 AND 512),
  command TEXT NOT NULL CHECK(length(command) BETWEEN 1 AND 4096),
  capability_scope_json TEXT NOT NULL CHECK(
    json_valid(capability_scope_json) = 1
    AND json_type(capability_scope_json) = 'array'
    AND json_array_length(capability_scope_json) > 0
    AND length(capability_scope_json) <= 32768
  ),
  parent_run_id TEXT CHECK(parent_run_id IS NULL OR length(parent_run_id) BETWEEN 1 AND 512),
  parent_worker_id TEXT CHECK(parent_worker_id IS NULL OR length(parent_worker_id) BETWEEN 1 AND 512),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grace_expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'released', 'stolen')),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  released_at TEXT,
  replaced_by_lease_id TEXT REFERENCES leases(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK(acquired_at <= renewed_at),
  CHECK(renewed_at < expires_at),
  CHECK(expires_at <= grace_expires_at),
  CHECK(
    (status = 'active' AND released_at IS NULL AND replaced_by_lease_id IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL AND replaced_by_lease_id IS NULL)
    OR (status = 'stolen' AND released_at IS NOT NULL AND replaced_by_lease_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS leases_one_active_resource_idx
  ON leases(workspace_id, kind, resource_key)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS leases_workspace_status_idx
  ON leases(workspace_id, status, renewed_at, id);
CREATE INDEX IF NOT EXISTS leases_run_status_idx
  ON leases(run_id, status, renewed_at, id)
  WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lease_probes (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(typeof(schema_version) = 'integer' AND schema_version = 1),
  lease_id TEXT NOT NULL REFERENCES leases(id),
  observer_instance_id TEXT NOT NULL CHECK(length(observer_instance_id) BETWEEN 1 AND 512),
  sequence INTEGER NOT NULL CHECK(typeof(sequence) = 'integer' AND sequence > 0),
  status TEXT NOT NULL CHECK(status IN ('alive', 'dead', 'identity-mismatch', 'unreachable')),
  expected_process_start_token TEXT NOT NULL CHECK(
    length(expected_process_start_token) BETWEEN 1 AND 1024
  ),
  observed_process_start_token TEXT CHECK(
    observed_process_start_token IS NULL
    OR length(observed_process_start_token) BETWEEN 1 AND 1024
  ),
  observed_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 4096),
  UNIQUE(lease_id, observer_instance_id, sequence)
);

CREATE INDEX IF NOT EXISTS lease_probes_lease_sequence_idx
  ON lease_probes(lease_id, observed_at, sequence);

CREATE TRIGGER IF NOT EXISTS leases_identity_update_guard
BEFORE UPDATE ON leases
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.kind IS NOT OLD.kind
  OR NEW.resource_key IS NOT OLD.resource_key
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR (OLD.run_id IS NOT NULL AND NEW.run_id IS NOT OLD.run_id)
  OR NEW.owner_instance_id IS NOT OLD.owner_instance_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.pid IS NOT OLD.pid
  OR NEW.process_start_token IS NOT OLD.process_start_token
  OR NEW.hostname IS NOT OLD.hostname
  OR NEW.command IS NOT OLD.command
  OR NEW.capability_scope_json IS NOT OLD.capability_scope_json
  OR NEW.parent_run_id IS NOT OLD.parent_run_id
  OR NEW.parent_worker_id IS NOT OLD.parent_worker_id
  OR NEW.acquired_at IS NOT OLD.acquired_at
BEGIN
  SELECT RAISE(ABORT, 'lease identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS leases_transition_guard
BEFORE UPDATE ON leases
WHEN OLD.status <> 'active'
  OR NEW.revision <> OLD.revision + 1
  OR NEW.renewed_at < OLD.renewed_at
  OR (NEW.status = 'active' AND (NEW.released_at IS NOT NULL OR NEW.replaced_by_lease_id IS NOT NULL))
  OR (NEW.status = 'released' AND (NEW.released_at IS NULL OR NEW.replaced_by_lease_id IS NOT NULL))
  OR (NEW.status = 'stolen' AND (NEW.released_at IS NULL OR NEW.replaced_by_lease_id IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'lease transition is invalid');
END;

CREATE TRIGGER IF NOT EXISTS leases_immutable_delete
BEFORE DELETE ON leases
BEGIN
  SELECT RAISE(ABORT, 'leases are durable');
END;

CREATE TRIGGER IF NOT EXISTS lease_probes_immutable_update
BEFORE UPDATE ON lease_probes
BEGIN
  SELECT RAISE(ABORT, 'lease probes are append-only');
END;

CREATE TRIGGER IF NOT EXISTS lease_probes_immutable_delete
BEFORE DELETE ON lease_probes
BEGIN
  SELECT RAISE(ABORT, 'lease probes are append-only');
END;
`

export const PARALLEL_GIT_SECURITY_MIGRATION_SQL = `-- Ralph v2 parallel, Git and security schema v10
CREATE TABLE IF NOT EXISTS resource_claim_sets (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT NOT NULL REFERENCES runs(id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 512),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 512),
  owner_instance_id TEXT NOT NULL CHECK(length(owner_instance_id) BETWEEN 1 AND 512),
  pid INTEGER NOT NULL CHECK(typeof(pid) = 'integer' AND pid > 0),
  process_start_token TEXT NOT NULL CHECK(length(process_start_token) BETWEEN 1 AND 4096),
  hostname TEXT NOT NULL CHECK(length(hostname) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK(status IN ('active', 'released', 'expired')),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grace_expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  released_at TEXT,
  release_reason TEXT CHECK(release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 4096),
  CHECK(acquired_at <= renewed_at),
  CHECK(renewed_at < expires_at),
  CHECK(expires_at <= grace_expires_at),
  CHECK(
    (status = 'active' AND released_at IS NULL AND release_reason IS NULL)
    OR (status IN ('released', 'expired') AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS resource_claim_sets_owner_idx
  ON resource_claim_sets(workspace_id, run_id, status, worker_id, acquired_at);
CREATE INDEX IF NOT EXISTS resource_claim_sets_attempt_idx
  ON resource_claim_sets(attempt_id, status, acquired_at);

CREATE TABLE IF NOT EXISTS resource_claims (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  claim_set_id TEXT NOT NULL REFERENCES resource_claim_sets(id),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT NOT NULL REFERENCES runs(id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 512),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 512),
  kind TEXT NOT NULL CHECK(kind IN (
    'task', 'path', 'artifact', 'port', 'worktree', 'branch', 'integration-target'
  )),
  resource_key TEXT NOT NULL CHECK(length(resource_key) BETWEEN 1 AND 512),
  mode TEXT NOT NULL CHECK(mode IN ('exclusive', 'shared-read')),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) = 1 AND length(metadata_json) <= 131072),
  status TEXT NOT NULL CHECK(status IN ('active', 'released', 'expired')),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grace_expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  released_at TEXT,
  release_reason TEXT CHECK(release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 4096),
  CHECK(acquired_at <= renewed_at),
  CHECK(renewed_at < expires_at),
  CHECK(expires_at <= grace_expires_at),
  CHECK(
    (status = 'active' AND released_at IS NULL AND release_reason IS NULL)
    OR (status IN ('released', 'expired') AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS resource_claims_active_resource_idx
  ON resource_claims(workspace_id, kind, resource_key, mode, acquired_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS resource_claims_set_idx
  ON resource_claims(claim_set_id, status, kind, resource_key);

CREATE TRIGGER IF NOT EXISTS resource_claim_sets_identity_guard
BEFORE UPDATE ON resource_claim_sets
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.document_id IS NOT OLD.document_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.owner_instance_id IS NOT OLD.owner_instance_id
  OR NEW.pid IS NOT OLD.pid
  OR NEW.process_start_token IS NOT OLD.process_start_token
  OR NEW.hostname IS NOT OLD.hostname
  OR NEW.acquired_at IS NOT OLD.acquired_at
BEGIN
  SELECT RAISE(ABORT, 'resource claim-set identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS resource_claim_sets_transition_guard
BEFORE UPDATE ON resource_claim_sets
WHEN OLD.status <> 'active'
  OR NEW.revision <> OLD.revision + 1
  OR NEW.renewed_at < OLD.renewed_at
  OR (NEW.status = 'active' AND (NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL))
  OR (NEW.status IN ('released', 'expired') AND (
    NEW.released_at IS NULL OR NEW.release_reason IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'resource claim-set transition is invalid');
END;

CREATE TRIGGER IF NOT EXISTS resource_claims_identity_guard
BEFORE UPDATE ON resource_claims
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.claim_set_id IS NOT OLD.claim_set_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.document_id IS NOT OLD.document_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.resource_key IS NOT OLD.resource_key
  OR NEW.mode IS NOT OLD.mode
  OR NEW.metadata_json IS NOT OLD.metadata_json
  OR NEW.acquired_at IS NOT OLD.acquired_at
BEGIN
  SELECT RAISE(ABORT, 'resource claim identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS resource_claims_transition_guard
BEFORE UPDATE ON resource_claims
WHEN OLD.status <> 'active'
  OR NEW.revision <> OLD.revision + 1
  OR NEW.renewed_at < OLD.renewed_at
  OR (NEW.status = 'active' AND (NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL))
  OR (NEW.status IN ('released', 'expired') AND (
    NEW.released_at IS NULL OR NEW.release_reason IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'resource claim transition is invalid');
END;

CREATE TRIGGER IF NOT EXISTS resource_claim_sets_immutable_delete
BEFORE DELETE ON resource_claim_sets
BEGIN
  SELECT RAISE(ABORT, 'resource claim sets are durable');
END;

CREATE TRIGGER IF NOT EXISTS resource_claims_immutable_delete
BEFORE DELETE ON resource_claims
BEGIN
  SELECT RAISE(ABORT, 'resource claims are durable');
END;

CREATE TABLE IF NOT EXISTS git_worktrees (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  status TEXT NOT NULL CHECK(status IN (
    'preparing', 'active', 'integrating', 'integrated', 'conflicted', 'failed', 'retained', 'removed'
  )),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) = 1 AND length(record_json) <= 1048576),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS git_worktrees_run_status_idx
  ON git_worktrees(workspace_id, run_id, status, task_id, id);

CREATE TABLE IF NOT EXISTS git_integrations (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT NOT NULL REFERENCES runs(id),
  worktree_id TEXT NOT NULL REFERENCES git_worktrees(id),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  integration_order INTEGER NOT NULL CHECK(typeof(integration_order) = 'integer' AND integration_order >= 0),
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'running', 'passed', 'conflicted', 'failed', 'paused', 'pr-created'
  )),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) = 1 AND length(record_json) <= 1048576),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, integration_order, task_id)
);
CREATE INDEX IF NOT EXISTS git_integrations_run_status_idx
  ON git_integrations(workspace_id, run_id, status, integration_order, id);

CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT REFERENCES runs(id),
  task_id TEXT CHECK(task_id IS NULL OR length(task_id) BETWEEN 1 AND 512),
  attempt_id TEXT REFERENCES attempts(id),
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash) = 64),
  status TEXT NOT NULL CHECK(status IN ('available', 'applied', 'conflicted')),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) = 1 AND length(manifest_json) <= 67108864),
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS checkpoints_scope_idx
  ON checkpoints(workspace_id, run_id, created_at, id);

CREATE TABLE IF NOT EXISTS rollback_plans (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  plan_hash TEXT NOT NULL CHECK(length(plan_hash) = 64),
  status TEXT NOT NULL CHECK(status IN ('previewed', 'applied', 'expired', 'conflicted')),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json) = 1 AND length(plan_json) <= 67108864),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS rollback_plans_checkpoint_idx
  ON rollback_plans(checkpoint_id, status, created_at, id);

CREATE TABLE IF NOT EXISTS sandbox_sessions (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 512),
  backend TEXT NOT NULL CHECK(backend IN ('process', 'docker', 'podman')),
  status TEXT NOT NULL CHECK(status IN ('preparing', 'ready', 'running', 'stopped', 'failed', 'orphaned')),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) = 1 AND length(record_json) <= 1048576),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sandbox_sessions_owner_idx
  ON sandbox_sessions(workspace_id, run_id, worker_id, status, updated_at, id);
`

export const RUN_WORK_SOURCE_MIGRATION_SQL = `-- Ralph v2 explicit run work source schema v12
ALTER TABLE runs ADD COLUMN source_json TEXT
  CHECK(
    source_json IS NULL
    OR (json_valid(source_json) = 1 AND length(source_json) BETWEEN 2 AND 524288)
  );
`

export const COMMAND_EVIDENCE_OPERATIONS_MIGRATION_SQL = `-- Ralph v2 command evidence operations schema v13
CREATE TABLE IF NOT EXISTS command_operations (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  command TEXT NOT NULL CHECK(command IN ('verify', 'judge')),
  status TEXT NOT NULL CHECK(status IN ('started', 'succeeded', 'failed', 'cancelled')),
  run_id TEXT NOT NULL REFERENCES runs(id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 512),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  evidence_bundle_id TEXT NOT NULL CHECK(length(evidence_bundle_id) BETWEEN 1 AND 512),
  request_hash TEXT NOT NULL CHECK(
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) = 1 AND length(request_json) <= 4194304),
  report_json TEXT CHECK(report_json IS NULL OR (json_valid(report_json) = 1 AND length(report_json) <= 16777216)),
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK(
    (status = 'started' AND report_json IS NULL AND error_code IS NULL AND error_message IS NULL AND finished_at IS NULL)
    OR (status = 'succeeded' AND report_json IS NOT NULL AND error_code IS NULL AND error_message IS NULL AND finished_at IS NOT NULL)
    OR (status IN ('failed', 'cancelled') AND report_json IS NULL AND error_code IS NOT NULL AND error_message IS NOT NULL AND finished_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS command_operations_selection_idx
  ON command_operations(run_id, document_id, task_id, attempt_id, command, started_at, id);
CREATE INDEX IF NOT EXISTS command_operations_evidence_idx
  ON command_operations(evidence_bundle_id, command, started_at, id);

CREATE TRIGGER IF NOT EXISTS command_operations_request_guard
BEFORE INSERT ON command_operations
WHEN json_extract(NEW.request_json, '$.schemaVersion') IS NOT 1
  OR json_extract(NEW.request_json, '$.command') IS NOT NEW.command
  OR json_extract(NEW.request_json, '$.selection.runId') IS NOT NEW.run_id
  OR json_extract(NEW.request_json, '$.selection.documentId') IS NOT NEW.document_id
  OR json_extract(NEW.request_json, '$.selection.taskId') IS NOT NEW.task_id
  OR json_extract(NEW.request_json, '$.selection.attemptId') IS NOT NEW.attempt_id
  OR json_extract(NEW.request_json, '$.selection.evidenceBundleId') IS NOT NEW.evidence_bundle_id
BEGIN
  SELECT RAISE(ABORT, 'command operation request scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS command_operations_identity_guard
BEFORE UPDATE ON command_operations
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.command IS NOT OLD.command
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.document_id IS NOT OLD.document_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.evidence_bundle_id IS NOT OLD.evidence_bundle_id
  OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.request_json IS NOT OLD.request_json
  OR NEW.started_at IS NOT OLD.started_at
BEGIN
  SELECT RAISE(ABORT, 'command operation identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS command_operations_transition_guard
BEFORE UPDATE ON command_operations
WHEN OLD.status <> 'started'
  OR NEW.status NOT IN ('succeeded', 'failed', 'cancelled')
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'command operation transition is invalid');
END;

CREATE TRIGGER IF NOT EXISTS command_operations_report_guard
BEFORE UPDATE ON command_operations
WHEN NEW.status = 'succeeded' AND (
  json_extract(NEW.report_json, '$.schemaVersion') IS NOT 1
  OR json_extract(NEW.report_json, '$.operationId') IS NOT NEW.id
  OR json_extract(NEW.report_json, '$.command') IS NOT NEW.command
  OR json_extract(NEW.report_json, '$.selection.runId') IS NOT NEW.run_id
  OR json_extract(NEW.report_json, '$.selection.documentId') IS NOT NEW.document_id
  OR json_extract(NEW.report_json, '$.selection.taskId') IS NOT NEW.task_id
  OR json_extract(NEW.report_json, '$.selection.attemptId') IS NOT NEW.attempt_id
  OR json_extract(NEW.report_json, '$.selection.evidenceBundleId') IS NOT NEW.evidence_bundle_id
  OR json_extract(NEW.report_json, '$.startedAt') IS NOT NEW.started_at
  OR json_extract(NEW.report_json, '$.finishedAt') IS NOT NEW.finished_at
)
BEGIN
  SELECT RAISE(ABORT, 'command operation report scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS command_operations_immutable_delete
BEFORE DELETE ON command_operations
BEGIN
  SELECT RAISE(ABORT, 'command operations are durable');
END;
`

export const EVENT_RETENTION_SNAPSHOT_MIGRATION_SQL = `-- Ralph v2 durable event retention snapshots schema v14
ALTER TABLE events ADD COLUMN event_retention_known INTEGER NOT NULL DEFAULT 0
  CHECK(event_retention_known IN (0, 1));
ALTER TABLE events ADD COLUMN event_retention_ms INTEGER
  CHECK(event_retention_ms IS NULL OR event_retention_ms > 0);

CREATE INDEX IF NOT EXISTS events_retention_idx
  ON events(event_retention_known, event_retention_ms, created_at, sequence);

CREATE TABLE IF NOT EXISTS workspace_event_retention_contexts (
  context_id TEXT PRIMARY KEY CHECK(length(context_id) BETWEEN 3 AND 512),
  expression TEXT,
  retention_ms INTEGER CHECK(retention_ms IS NULL OR retention_ms > 0),
  updated_at TEXT NOT NULL,
  CHECK(
    (expression IS NULL AND retention_ms IS NULL)
    OR (expression IS NOT NULL AND length(expression) BETWEEN 2 AND 64 AND retention_ms IS NOT NULL)
  )
);
`

export const PARALLEL_RESERVED_ATTEMPTS_MIGRATION_SQL = `-- Ralph v2 parallel reserved attempt identities schema v15
-- Parallel claims and worktrees are intentionally durable before executeTask creates the
-- corresponding attempt. Keep the immutable attempt identity, but do not require the
-- attempts row to exist at dispatch-reservation time.
DROP TRIGGER IF EXISTS resource_claim_sets_identity_guard;
DROP TRIGGER IF EXISTS resource_claim_sets_transition_guard;
DROP TRIGGER IF EXISTS resource_claim_sets_immutable_delete;
DROP TRIGGER IF EXISTS resource_claims_identity_guard;
DROP TRIGGER IF EXISTS resource_claims_transition_guard;
DROP TRIGGER IF EXISTS resource_claims_immutable_delete;
DROP INDEX IF EXISTS resource_claim_sets_owner_idx;
DROP INDEX IF EXISTS resource_claim_sets_attempt_idx;
DROP INDEX IF EXISTS resource_claims_active_resource_idx;
DROP INDEX IF EXISTS resource_claims_set_idx;

ALTER TABLE resource_claims RENAME TO resource_claims_v10;
ALTER TABLE resource_claim_sets RENAME TO resource_claim_sets_v10;

CREATE TABLE resource_claim_sets (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT NOT NULL REFERENCES runs(id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 512),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 512),
  worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 512),
  owner_instance_id TEXT NOT NULL CHECK(length(owner_instance_id) BETWEEN 1 AND 512),
  pid INTEGER NOT NULL CHECK(typeof(pid) = 'integer' AND pid > 0),
  process_start_token TEXT NOT NULL CHECK(length(process_start_token) BETWEEN 1 AND 4096),
  hostname TEXT NOT NULL CHECK(length(hostname) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK(status IN ('active', 'released', 'expired')),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grace_expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  released_at TEXT,
  release_reason TEXT CHECK(release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 4096),
  CHECK(acquired_at <= renewed_at),
  CHECK(renewed_at < expires_at),
  CHECK(expires_at <= grace_expires_at),
  CHECK(
    (status = 'active' AND released_at IS NULL AND release_reason IS NULL)
    OR (status IN ('released', 'expired') AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  )
);

CREATE TABLE resource_claims (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  claim_set_id TEXT NOT NULL REFERENCES resource_claim_sets(id),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT NOT NULL REFERENCES runs(id),
  document_id TEXT NOT NULL CHECK(length(document_id) BETWEEN 1 AND 512),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 512),
  worker_id TEXT NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 512),
  kind TEXT NOT NULL CHECK(kind IN (
    'task', 'path', 'artifact', 'port', 'worktree', 'branch', 'integration-target'
  )),
  resource_key TEXT NOT NULL CHECK(length(resource_key) BETWEEN 1 AND 512),
  mode TEXT NOT NULL CHECK(mode IN ('exclusive', 'shared-read')),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) = 1 AND length(metadata_json) <= 131072),
  status TEXT NOT NULL CHECK(status IN ('active', 'released', 'expired')),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  grace_expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  released_at TEXT,
  release_reason TEXT CHECK(release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 4096),
  CHECK(acquired_at <= renewed_at),
  CHECK(renewed_at < expires_at),
  CHECK(expires_at <= grace_expires_at),
  CHECK(
    (status = 'active' AND released_at IS NULL AND release_reason IS NULL)
    OR (status IN ('released', 'expired') AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  )
);

INSERT INTO resource_claim_sets SELECT * FROM resource_claim_sets_v10;
INSERT INTO resource_claims SELECT * FROM resource_claims_v10;
DROP TABLE resource_claims_v10;
DROP TABLE resource_claim_sets_v10;

CREATE INDEX resource_claim_sets_owner_idx
  ON resource_claim_sets(workspace_id, run_id, status, worker_id, acquired_at);
CREATE INDEX resource_claim_sets_attempt_idx
  ON resource_claim_sets(attempt_id, status, acquired_at);
CREATE INDEX resource_claims_active_resource_idx
  ON resource_claims(workspace_id, kind, resource_key, mode, acquired_at)
  WHERE status = 'active';
CREATE INDEX resource_claims_set_idx
  ON resource_claims(claim_set_id, status, kind, resource_key);

CREATE TRIGGER resource_claim_sets_identity_guard
BEFORE UPDATE ON resource_claim_sets
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.document_id IS NOT OLD.document_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.owner_instance_id IS NOT OLD.owner_instance_id
  OR NEW.pid IS NOT OLD.pid
  OR NEW.process_start_token IS NOT OLD.process_start_token
  OR NEW.hostname IS NOT OLD.hostname
  OR NEW.acquired_at IS NOT OLD.acquired_at
BEGIN
  SELECT RAISE(ABORT, 'resource claim-set identity is immutable');
END;

CREATE TRIGGER resource_claim_sets_transition_guard
BEFORE UPDATE ON resource_claim_sets
WHEN OLD.status <> 'active'
  OR NEW.revision <> OLD.revision + 1
  OR NEW.renewed_at < OLD.renewed_at
  OR (NEW.status = 'active' AND (NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL))
  OR (NEW.status IN ('released', 'expired') AND (
    NEW.released_at IS NULL OR NEW.release_reason IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'resource claim-set transition is invalid');
END;

CREATE TRIGGER resource_claims_identity_guard
BEFORE UPDATE ON resource_claims
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.claim_set_id IS NOT OLD.claim_set_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.run_id IS NOT OLD.run_id
  OR NEW.document_id IS NOT OLD.document_id
  OR NEW.task_id IS NOT OLD.task_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.resource_key IS NOT OLD.resource_key
  OR NEW.mode IS NOT OLD.mode
  OR NEW.metadata_json IS NOT OLD.metadata_json
  OR NEW.acquired_at IS NOT OLD.acquired_at
BEGIN
  SELECT RAISE(ABORT, 'resource claim identity is immutable');
END;

CREATE TRIGGER resource_claims_transition_guard
BEFORE UPDATE ON resource_claims
WHEN OLD.status <> 'active'
  OR NEW.revision <> OLD.revision + 1
  OR NEW.renewed_at < OLD.renewed_at
  OR (NEW.status = 'active' AND (NEW.released_at IS NOT NULL OR NEW.release_reason IS NOT NULL))
  OR (NEW.status IN ('released', 'expired') AND (
    NEW.released_at IS NULL OR NEW.release_reason IS NULL
  ))
BEGIN
  SELECT RAISE(ABORT, 'resource claim transition is invalid');
END;

CREATE TRIGGER resource_claim_sets_immutable_delete
BEFORE DELETE ON resource_claim_sets
BEGIN
  SELECT RAISE(ABORT, 'resource claim sets are durable');
END;

CREATE TRIGGER resource_claims_immutable_delete
BEFORE DELETE ON resource_claims
BEGIN
  SELECT RAISE(ABORT, 'resource claims are durable');
END;

DROP INDEX IF EXISTS git_integrations_run_status_idx;
DROP INDEX IF EXISTS git_worktrees_run_status_idx;
ALTER TABLE git_integrations RENAME TO git_integrations_v10;
ALTER TABLE git_worktrees RENAME TO git_worktrees_v10;

CREATE TABLE git_worktrees (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT NOT NULL REFERENCES runs(id),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK(status IN (
    'preparing', 'active', 'integrating', 'integrated', 'conflicted', 'failed', 'retained', 'removed'
  )),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) = 1 AND length(record_json) <= 1048576),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE git_integrations (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  run_id TEXT NOT NULL REFERENCES runs(id),
  worktree_id TEXT NOT NULL REFERENCES git_worktrees(id),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 512),
  integration_order INTEGER NOT NULL CHECK(typeof(integration_order) = 'integer' AND integration_order >= 0),
  status TEXT NOT NULL CHECK(status IN (
    'pending', 'running', 'passed', 'conflicted', 'failed', 'paused', 'pr-created'
  )),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) = 1 AND length(record_json) <= 1048576),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id, integration_order, task_id)
);

INSERT INTO git_worktrees SELECT * FROM git_worktrees_v10;
INSERT INTO git_integrations SELECT * FROM git_integrations_v10;
DROP TABLE git_integrations_v10;
DROP TABLE git_worktrees_v10;

CREATE INDEX git_worktrees_run_status_idx
  ON git_worktrees(workspace_id, run_id, status, task_id, id);
CREATE INDEX git_integrations_run_status_idx
  ON git_integrations(workspace_id, run_id, status, integration_order, id);
`

type EventRow = { event_json: string }
type EventScanRow = { sequence: number; event_json: string }
type EventHighWaterRow = { sequence: number }
type OutboxRow = { event_id: string; sequence: number; event_json: string }
type AppliedMigrationRow = { version: number; name: string }

export interface ReadEventBatchQuery {
  /** Inclusive watermark: only ledger rows after this sequence are scanned. */
  readonly afterSequence: number
  /** Bounds one read so an attached observer cannot monopolize the ledger. */
  readonly limit?: number
  /** Optional projection filter; the scan watermark still crosses other runs. */
  readonly runId?: string
}

export interface ReadEventBatchResult {
  /** Last global ledger sequence scanned, even when every row was filtered out. */
  readonly cursorSequence: number
  readonly scanned: number
  readonly events: readonly EventEnvelope[]
}

export interface ReadRunEventBatchQuery {
  /** Run whose indexed event stream is being replayed. */
  readonly runId: string
  /** Exclusive run-event cursor. */
  readonly afterSequence: number
  /** Inclusive global snapshot boundary captured before materialized reads. */
  readonly throughSequence: number
  /** Bounds one page even when a single run produced a large stream. */
  readonly limit?: number
}

export interface ReadRunEventBatchResult {
  /** Last matching sequence, or throughSequence when this run has no more rows in the snapshot. */
  readonly cursorSequence: number
  readonly exhausted: boolean
  readonly events: readonly EventEnvelope[]
}

type LedgerMigration = {
  version: number
  name: string
  file: string
  sql: string
}

export const LEDGER_MIGRATIONS: readonly LedgerMigration[] = [
  { version: 1, name: "initial", file: "0001-initial.sql", sql: INITIAL_MIGRATION_SQL },
  {
    version: 2,
    name: "orchestration",
    file: "0002-orchestration.sql",
    sql: ORCHESTRATION_MIGRATION_SQL,
  },
  {
    version: 3,
    name: "execution-hardening",
    file: "0003-execution-hardening.sql",
    sql: EXECUTION_HARDENING_MIGRATION_SQL,
  },
  {
    version: 4,
    name: "attempt-effective-options",
    file: "0004-attempt-effective-options.sql",
    sql: ATTEMPT_EFFECTIVE_OPTIONS_MIGRATION_SQL,
  },
  {
    version: 5,
    name: "model-call-context",
    file: "0005-model-call-context.sql",
    sql: MODEL_CALL_CONTEXT_MIGRATION_SQL,
  },
  {
    version: 6,
    name: "tool-call-journal",
    file: "0006-tool-call-journal.sql",
    sql: TOOL_CALL_JOURNAL_MIGRATION_SQL,
  },
  {
    version: 7,
    name: "evidence-store",
    file: "0007-evidence-store.sql",
    sql: EVIDENCE_STORE_MIGRATION_SQL,
  },
  {
    version: 8,
    name: "judge-assessment",
    file: "0008-judge-assessment.sql",
    sql: JUDGE_ASSESSMENT_MIGRATION_SQL,
  },
  {
    version: 9,
    name: "durable-leases",
    file: "0009-durable-leases.sql",
    sql: DURABLE_LEASES_MIGRATION_SQL,
  },
  {
    version: 10,
    name: "parallel-git-security",
    file: "0010-parallel-git-security.sql",
    sql: PARALLEL_GIT_SECURITY_MIGRATION_SQL,
  },
  {
    version: 11,
    name: "child-run-links",
    file: "0011-child-run-links.sql",
    sql: CHILD_RUN_LINKS_MIGRATION_SQL,
  },
  {
    version: 12,
    name: "run-work-source",
    file: "0012-run-work-source.sql",
    sql: RUN_WORK_SOURCE_MIGRATION_SQL,
  },
  {
    version: 13,
    name: "command-evidence-operations",
    file: "0013-command-evidence-operations.sql",
    sql: COMMAND_EVIDENCE_OPERATIONS_MIGRATION_SQL,
  },
  {
    version: 14,
    name: "event-retention-snapshots",
    file: "0014-event-retention-snapshots.sql",
    sql: EVENT_RETENTION_SNAPSHOT_MIGRATION_SQL,
  },
  {
    version: 15,
    name: "parallel-reserved-attempts",
    file: "0015-parallel-reserved-attempts.sql",
    sql: PARALLEL_RESERVED_ATTEMPTS_MIGRATION_SQL,
  },
]

function configureDatabase(database: Database): void {
  database.exec("PRAGMA journal_mode = WAL;")
  database.exec("PRAGMA foreign_keys = ON;")
  database.exec("PRAGMA busy_timeout = 5000;")
}

function appliedMigrations(database: Database): AppliedMigrationRow[] {
  const exists = database
    .query<{ present: number }, []>(
      `SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'schema_migrations'`,
    )
    .get()
  if (!exists) return []
  return database
    .query<AppliedMigrationRow, []>("SELECT version, name FROM schema_migrations ORDER BY version")
    .all()
}

function validateMigrationHistory(rows: readonly AppliedMigrationRow[]): void {
  for (const [index, row] of rows.entries()) {
    const expected = LEDGER_MIGRATIONS[index]
    if (!expected) {
      throw new RalphError(
        "RALPH_LEDGER_SCHEMA_NEWER",
        `Ledger schema v${row.version} is newer than this Ralph build`,
        {
          exitCode: EXIT_CODES.conflict,
          details: { latestSupportedVersion: LEDGER_MIGRATIONS.at(-1)?.version, row },
          hint: "Use a Ralph build that supports this ledger; never downgrade it in place.",
        },
      )
    }
    if (row.version !== expected.version || row.name !== expected.name) {
      throw new RalphError(
        "RALPH_LEDGER_MIGRATION_HISTORY_INVALID",
        "Ledger migration history is not the expected forward-only prefix",
        {
          exitCode: EXIT_CODES.conflict,
          details: { index, expected: { version: expected.version, name: expected.name }, row },
          hint: "Restore the ledger from a verified checkpoint instead of editing migration history.",
        },
      )
    }
  }
}

function hasExistingLedgerState(database: Database): boolean {
  return (
    database
      .query<{ present: number }, []>(
        `SELECT 1 AS present FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name <> 'schema_migrations'
         LIMIT 1`,
      )
      .get() !== null
  )
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function createMigrationBackup(
  database: Database,
  layout: WorkspaceLayout,
  fromVersion: number,
  toVersion: number,
): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  const backup = join(
    layout.checkpoints,
    "migrations",
    `ledger-v${fromVersion}-before-v${toVersion}-${timestamp}-${crypto.randomUUID()}.sqlite`,
  )
  database.exec("PRAGMA wal_checkpoint(FULL);")
  database.exec(`VACUUM INTO ${sqliteString(backup)};`)
  return backup
}

function applyMigrations(database: Database): void {
  const operation = database.transaction(() => {
    const current = appliedMigrations(database)
    validateMigrationHistory(current)
    const pending = LEDGER_MIGRATIONS.slice(current.length)
    for (const migration of pending) {
      database.exec(migration.sql)
      database
        .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString())
    }
  })
  operation.immediate()
}

async function ensureMigrationSources(layout: WorkspaceLayout): Promise<void> {
  for (const migration of LEDGER_MIGRATIONS) {
    const path = join(layout.migrations, migration.file)
    if (!(await Bun.file(path).exists())) {
      await writeFileAtomic(path, migration.sql, { overwrite: false })
    }
    const persisted = await Bun.file(path).text()
    if (persisted !== migration.sql) {
      throw new RalphError(
        "RALPH_LEDGER_MIGRATION_SOURCE_MISMATCH",
        `Persisted migration source differs from this Ralph build: ${migration.file}`,
        {
          exitCode: EXIT_CODES.conflict,
          file: path,
          details: { version: migration.version, name: migration.name },
          hint: "Restore the canonical migration file; Ralph will not execute ambiguous migration history.",
        },
      )
    }
  }
}

export async function initializeLedger(layout: WorkspaceLayout): Promise<void> {
  await mkdir(dirname(layout.ledger), { recursive: true })
  await mkdir(layout.migrations, { recursive: true })
  await mkdir(join(layout.checkpoints, "migrations"), { recursive: true })
  await ensureMigrationSources(layout)

  const database = new Database(layout.ledger, { create: true, strict: true })
  let backup: string | undefined
  try {
    configureDatabase(database)
    const applied = appliedMigrations(database)
    validateMigrationHistory(applied)
    const pending = LEDGER_MIGRATIONS.slice(applied.length)
    if (pending.length > 0 && hasExistingLedgerState(database)) {
      backup = createMigrationBackup(
        database,
        layout,
        applied.at(-1)?.version ?? 0,
        pending.at(-1)?.version ?? applied.length,
      )
    }
    applyMigrations(database)
  } catch (error) {
    if (error instanceof RalphError) throw error
    throw new RalphError(
      "RALPH_LEDGER_MIGRATION_FAILED",
      "Ledger migration failed; the previous schema transaction was preserved",
      {
        exitCode: EXIT_CODES.operationalError,
        file: layout.ledger,
        details: {
          ...(backup ? { backup } : {}),
          latestSupportedVersion: LEDGER_MIGRATIONS.at(-1)?.version,
        },
        hint: backup
          ? "Inspect the error and retained pre-migration checkpoint before retrying."
          : "Inspect the migration source and ledger before retrying.",
        cause: error,
      },
    )
  } finally {
    database.close(true)
  }
}

export function withLedger<T>(path: string, operation: (database: Database) => T): T {
  const database = new Database(path, { strict: true })
  try {
    configureDatabase(database)
    databaseSecrets.set(database, registeredSecrets(path))
    return operation(database)
  } finally {
    database.close(true)
  }
}

export function checkpointLedger(path: string): void {
  const database = new Database(path, { strict: true })
  try {
    configureDatabase(database)
    database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0)
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);")
  } finally {
    database.close(true)
  }
}

export function appendEvent(path: string, input: EventInput): EventEnvelope {
  return withLedger(path, (database) =>
    database.transaction(() => appendEventInTransaction(database, input))(),
  )
}

export function appendEventInTransaction(
  database: Database,
  input: EventInput,
  eventId: string = crypto.randomUUID(),
): EventEnvelope {
  const timestamp = new Date().toISOString()
  const retention = eventRetentionSnapshot(database, input)
  const insert = database
    .query(
      `INSERT INTO events(
        event_id, event_json, created_at, run_id, document_id, task_id, attempt_id, event_type,
        event_retention_known, event_retention_ms
      ) VALUES (?, '{}', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      timestamp,
      input.runId ?? null,
      input.documentId ?? null,
      input.taskId ?? null,
      input.attemptId ?? null,
      input.type,
      retention.known ? 1 : 0,
      retention.retentionMs ?? null,
    )
  const sequence = Number(insert.lastInsertRowid)
  const redactedPayload = redactValue(
    input.payload ?? {},
    persistenceSecretValues(database),
  ) as Record<string, unknown>
  const envelope: EventEnvelope = {
    schemaVersion: 1,
    eventId,
    sequence,
    timestamp,
    monotonicMs: performance.now(),
    type: input.type,
    scope: input.scope,
    streamId: input.streamId,
    workspaceId: input.workspaceId,
    level: input.level ?? "info",
    payload: redactedPayload,
  }
  for (const key of [
    "runId",
    "documentId",
    "taskId",
    "attemptId",
    "callId",
    "workerId",
    "parentRunId",
    "correlationId",
    "causationId",
  ] as const) {
    const value = input[key]
    if (value !== undefined) envelope[key] = value
  }
  EventEnvelopeSchema.parse(envelope)
  const json = JSON.stringify(envelope)
  database.query("UPDATE events SET event_json = ? WHERE event_id = ?").run(json, eventId)
  database
    .query("INSERT INTO outbox(event_id, sequence, event_json) VALUES (?, ?, ?)")
    .run(eventId, sequence, json)
  return envelope
}

export async function flushOutbox(layout: WorkspaceLayout): Promise<number> {
  const projectionLease = await acquireFilesystemLease(layout.locks, ".event-projection.lock")
  try {
    await projectionLease.assertOwned()
    const rows = withLedger(layout.ledger, (database) =>
      database
        .query<OutboxRow, []>(
          "SELECT event_id, sequence, event_json FROM outbox WHERE published_at IS NULL ORDER BY sequence",
        )
        .all(),
    )
    await mkdir(dirname(layout.workspaceEvents), { recursive: true })
    const events = readEvents(layout.ledger)
    const expected =
      events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : ""
    const outputExists = await Bun.file(layout.workspaceEvents).exists()
    const existing = outputExists ? await Bun.file(layout.workspaceEvents).text() : undefined
    await projectionLease.assertOwned()
    if (!outputExists) {
      await writeFileAtomic(layout.workspaceEvents, expected, { overwrite: false })
    } else if (existing !== expected) {
      let prefixLength: number | undefined
      if (existing?.endsWith("\n")) {
        try {
          const parsed = existing
            .split(/\r?\n/)
            .filter((line) => line.length > 0)
            .map((line) => EventEnvelopeConsumerSchema.parse(JSON.parse(line)))
          const isPrefix =
            parsed.length <= events.length &&
            parsed.every((event, index) => JSON.stringify(event) === JSON.stringify(events[index]))
          if (isPrefix) prefixLength = parsed.length
        } catch {
          // A malformed/truncated projection is rebuilt from the authoritative ledger below.
        }
      }

      if (prefixLength !== undefined) {
        const missing = events.slice(prefixLength)
        if (missing.length > 0) {
          await appendFile(
            layout.workspaceEvents,
            `${missing.map((event) => JSON.stringify(event)).join("\n")}\n`,
          )
        }
      } else {
        await writeFileAtomic(layout.workspaceEvents, expected, { overwrite: true })
      }
    }
    await projectionLease.assertOwned()

    if (rows.length > 0) {
      withLedger(layout.ledger, (database) =>
        database.transaction(() => {
          const statement = database.query(
            "UPDATE outbox SET published_at = ? WHERE event_id = ? AND published_at IS NULL",
          )
          const publishedAt = new Date().toISOString()
          for (const row of rows) statement.run(publishedAt, row.event_id)
        })(),
      )
    }
    await projectionLease.assertOwned()
    const retention = applyDurableEventRetention(layout.ledger)
    for (const runId of retention.expiredRunIds) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/.test(runId)) {
        throw new Error(`Event retention selected an unsafe run id: ${runId}`)
      }
      await projectionLease.assertOwned()
      await purgeDiagnosticRawCaptures(join(layout.runs, runId, "raw", "diagnostic"))
    }
    await projectionLease.assertOwned()
    if (retention.removedEvents > 0) {
      const retainedEvents = readEvents(layout.ledger)
      const retainedProjection =
        retainedEvents.length > 0
          ? `${retainedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
          : ""
      await writeFileAtomic(layout.workspaceEvents, retainedProjection, { overwrite: true })
    }
    await projectionLease.assertOwned()
    return rows.length
  } finally {
    await projectionLease.release()
  }
}

export function readEvents(path: string): EventEnvelope[] {
  try {
    const database = new Database(path, { readonly: true, strict: true })
    try {
      database.exec("PRAGMA foreign_keys = ON;")
      database.exec("PRAGMA busy_timeout = 5000;")
      return database
        .query<EventRow, []>("SELECT event_json FROM events ORDER BY sequence")
        .all()
        .map((row) => EventEnvelopeConsumerSchema.parse(JSON.parse(row.event_json)))
    } finally {
      database.close(true)
    }
  } catch (error) {
    throw new RalphError("RALPH_LEDGER_READ_FAILED", `Could not read event ledger: ${path}`, {
      exitCode: EXIT_CODES.operationalError,
      file: path,
      cause: error,
    })
  }
}

/**
 * Captures the global event high-water mark without materializing event payloads.
 * Snapshot consumers must capture this before reading materialized run/task state,
 * then replay only rows at or below the returned boundary. Later rows are delivered
 * by the normal follow cursor and cannot be skipped.
 */
export function readEventHighWater(path: string): number {
  try {
    const database = new Database(path, { readonly: true, strict: true })
    try {
      database.exec("PRAGMA foreign_keys = ON;")
      database.exec("PRAGMA busy_timeout = 5000;")
      const row = database
        .query<EventHighWaterRow, []>("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events")
        .get()
      const sequence = row?.sequence ?? 0
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error(`Invalid event high-water sequence: ${String(sequence)}`)
      }
      return sequence
    } finally {
      database.close(true)
    }
  } catch (error) {
    throw new RalphError(
      "RALPH_LEDGER_READ_FAILED",
      `Could not read event high-water mark: ${path}`,
      { exitCode: EXIT_CODES.operationalError, file: path, cause: error },
    )
  }
}

/**
 * Reads one bounded page through the run_id/sequence index. Unlike the shared
 * workspace follow scan, bootstrap callers already know their root/child scopes
 * and must not deserialize unrelated projects or runs.
 */
export function readRunEventBatch(
  path: string,
  query: ReadRunEventBatchQuery,
): ReadRunEventBatchResult {
  if (query.runId.length === 0) {
    throw new RalphError("RALPH_EVENT_RUN_ID_INVALID", "Run event query requires a run ID", {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  if (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0) {
    throw new RalphError(
      "RALPH_EVENT_CURSOR_INVALID",
      `Run event cursor must be a non-negative safe integer: ${String(query.afterSequence)}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (!Number.isSafeInteger(query.throughSequence) || query.throughSequence < query.afterSequence) {
    throw new RalphError(
      "RALPH_EVENT_SNAPSHOT_BOUNDARY_INVALID",
      `Run event snapshot boundary must be a safe integer at or after the cursor: ${String(query.throughSequence)}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const limit = query.limit ?? 256
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RalphError(
      "RALPH_EVENT_BATCH_LIMIT_INVALID",
      `Run event batch limit must be a positive safe integer: ${String(limit)}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }

  try {
    const database = new Database(path, { readonly: true, strict: true })
    try {
      database.exec("PRAGMA foreign_keys = ON;")
      database.exec("PRAGMA busy_timeout = 5000;")
      const rows = database
        .query<EventScanRow, [string, number, number, number]>(
          `SELECT sequence, event_json FROM events
           WHERE run_id = ? AND sequence > ? AND sequence <= ?
           ORDER BY sequence LIMIT ?`,
        )
        .all(query.runId, query.afterSequence, query.throughSequence, limit)
      const events = rows.map((row) => {
        const event = EventEnvelopeConsumerSchema.parse(JSON.parse(row.event_json))
        if (event.sequence !== row.sequence || event.runId !== query.runId) {
          throw new Error(
            `Run event ${event.eventId} does not match indexed ledger identity ${query.runId}/${row.sequence}`,
          )
        }
        return event
      })
      const exhausted = rows.length < limit
      return {
        cursorSequence: exhausted
          ? query.throughSequence
          : (rows.at(-1)?.sequence ?? query.throughSequence),
        exhausted,
        events,
      }
    } finally {
      database.close(true)
    }
  } catch (error) {
    throw new RalphError("RALPH_LEDGER_READ_FAILED", `Could not read run event ledger: ${path}`, {
      exitCode: EXIT_CODES.operationalError,
      file: path,
      cause: error,
    })
  }
}

/**
 * Reads a bounded, cursor-based ledger page for observers such as the TUI.
 * Filtering happens after the ordered scan so the returned cursor remains a
 * truthful watermark for the shared workspace event sequence.
 */
export function readEventBatch(path: string, query: ReadEventBatchQuery): ReadEventBatchResult {
  if (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0) {
    throw new RalphError(
      "RALPH_EVENT_CURSOR_INVALID",
      `Event cursor must be a non-negative safe integer: ${String(query.afterSequence)}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const limit = query.limit ?? 256
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RalphError(
      "RALPH_EVENT_BATCH_LIMIT_INVALID",
      `Event batch limit must be a positive safe integer: ${String(limit)}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }

  try {
    const database = new Database(path, { readonly: true, strict: true })
    try {
      database.exec("PRAGMA foreign_keys = ON;")
      database.exec("PRAGMA busy_timeout = 5000;")
      const rows = database
        .query<EventScanRow, [number, number]>(
          "SELECT sequence, event_json FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?",
        )
        .all(query.afterSequence, limit)
      const events = rows
        .map((row) => {
          const event = EventEnvelopeConsumerSchema.parse(JSON.parse(row.event_json))
          if (event.sequence !== row.sequence) {
            throw new Error(
              `Event ${event.eventId} sequence ${event.sequence} does not match ledger row ${row.sequence}`,
            )
          }
          return event
        })
        .filter((event) => query.runId === undefined || event.runId === query.runId)
      return {
        cursorSequence: rows.at(-1)?.sequence ?? query.afterSequence,
        scanned: rows.length,
        events,
      }
    } finally {
      database.close(true)
    }
  } catch (error) {
    if (error instanceof RalphError) throw error
    throw new RalphError("RALPH_LEDGER_READ_FAILED", `Could not scan event ledger: ${path}`, {
      exitCode: EXIT_CODES.operationalError,
      file: path,
      cause: error,
    })
  }
}
