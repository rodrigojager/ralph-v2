/**
 * Dependency-free migration source. It lives outside child-runs.ts so the
 * ledger migration registry never imports a store that imports the ledger.
 */
export const CHILD_RUN_LINKS_MIGRATION_SQL = `-- Ralph v2 child-run links schema v11
CREATE TABLE IF NOT EXISTS child_run_links (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 512),
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  workspace_id TEXT NOT NULL CHECK(length(workspace_id) BETWEEN 1 AND 512),
  parent_run_id TEXT NOT NULL REFERENCES runs(id),
  parent_document_id TEXT NOT NULL CHECK(length(parent_document_id) BETWEEN 1 AND 512),
  parent_task_id TEXT NOT NULL CHECK(length(parent_task_id) BETWEEN 1 AND 512),
  child_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  child_document_id TEXT NOT NULL CHECK(length(child_document_id) BETWEEN 1 AND 512),
  child_root_prd_file TEXT NOT NULL CHECK(length(child_root_prd_file) BETWEEN 1 AND 4096),
  graph_definition_hash TEXT NOT NULL CHECK(
    length(graph_definition_hash) = 64 AND graph_definition_hash NOT GLOB '*[^0-9a-f]*'
  ),
  graph_hash TEXT NOT NULL CHECK(length(graph_hash) = 64 AND graph_hash NOT GLOB '*[^0-9a-f]*'),
  inherited_options_hash TEXT NOT NULL CHECK(
    length(inherited_options_hash) = 64 AND inherited_options_hash NOT GLOB '*[^0-9a-f]*'
  ),
  materialization_hash TEXT NOT NULL CHECK(
    length(materialization_hash) = 64 AND materialization_hash NOT GLOB '*[^0-9a-f]*'
  ),
  depth INTEGER NOT NULL CHECK(typeof(depth) = 'integer' AND depth >= 1),
  expected_direct_children INTEGER NOT NULL CHECK(
    typeof(expected_direct_children) = 'integer' AND expected_direct_children >= 0
  ),
  parent_policy TEXT NOT NULL CHECK(parent_policy IN ('pause-with-parent', 'survive-parent')),
  completion_policy TEXT NOT NULL CHECK(
    completion_policy = 'all-descendants-passed-and-parent-verified'
  ),
  status TEXT NOT NULL CHECK(
    status IN (
      'reserved', 'starting', 'running', 'waiting', 'blocked', 'interrupted',
      'passed', 'failed', 'cancelled'
    )
  ),
  revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
  lease_id TEXT REFERENCES leases(id),
  observability_json TEXT NOT NULL CHECK(
    json_valid(observability_json) = 1
    AND json_type(observability_json) = 'object'
    AND length(observability_json) <= 262144
  ),
  artifacts_reconciled INTEGER NOT NULL CHECK(artifacts_reconciled IN (0, 1)),
  terminal_receipt_json TEXT CHECK(
    terminal_receipt_json IS NULL
    OR (json_valid(terminal_receipt_json) = 1 AND length(terminal_receipt_json) <= 131072)
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  terminal_at TEXT,
  terminal_reason TEXT CHECK(terminal_reason IS NULL OR length(terminal_reason) BETWEEN 1 AND 8192),
  UNIQUE(parent_run_id, parent_document_id, parent_task_id),
  CHECK(
    (status IN ('passed', 'failed', 'cancelled') AND terminal_at IS NOT NULL AND terminal_receipt_json IS NOT NULL)
    OR
    (status NOT IN ('passed', 'failed', 'cancelled') AND terminal_at IS NULL AND terminal_receipt_json IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS child_run_links_parent_status_idx
  ON child_run_links(parent_run_id, status, depth DESC, created_at, id);
CREATE INDEX IF NOT EXISTS child_run_links_workspace_status_idx
  ON child_run_links(workspace_id, status, updated_at, id);

CREATE TABLE IF NOT EXISTS child_event_projections (
  link_id TEXT NOT NULL REFERENCES child_run_links(id),
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  source_sequence INTEGER NOT NULL CHECK(typeof(source_sequence) = 'integer' AND source_sequence > 0),
  projected_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  projected_at TEXT NOT NULL,
  PRIMARY KEY(link_id, source_event_id),
  UNIQUE(link_id, source_sequence)
);

CREATE INDEX IF NOT EXISTS child_event_projections_cursor_idx
  ON child_event_projections(link_id, source_sequence);

CREATE TRIGGER IF NOT EXISTS child_run_links_workspace_guard_insert
BEFORE INSERT ON child_run_links
WHEN NOT EXISTS (
  SELECT 1
  FROM runs parent_run, runs child_run
  WHERE parent_run.id = NEW.parent_run_id
    AND child_run.id = NEW.child_run_id
    AND parent_run.workspace_id = NEW.workspace_id
    AND child_run.workspace_id = NEW.workspace_id
    AND parent_run.definition_hash = NEW.graph_definition_hash
    AND child_run.root_prd_id = NEW.child_document_id
    AND child_run.root_prd_file = NEW.child_root_prd_file
    AND child_run.definition_hash = NEW.graph_definition_hash
    AND child_run.graph_hash = NEW.graph_hash
    AND child_run.effective_options_hash = NEW.inherited_options_hash
    AND EXISTS (
      SELECT 1 FROM run_tasks parent_task
      WHERE parent_task.run_id = NEW.parent_run_id
        AND parent_task.document_id = NEW.parent_document_id
        AND parent_task.task_id = NEW.parent_task_id
        AND parent_task.status IN ('active', 'completed', 'completed_with_override')
    )
    AND EXISTS (
      SELECT 1 FROM run_tasks child_task
      WHERE child_task.run_id = NEW.child_run_id
        AND child_task.document_id = NEW.child_document_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM run_tasks child_task
      WHERE child_task.run_id = NEW.child_run_id
        AND child_task.document_id <> NEW.child_document_id
    )
    AND (
      EXISTS (
        SELECT 1 FROM run_tasks parent_task
        WHERE parent_task.run_id = NEW.parent_run_id
          AND parent_task.document_id = NEW.parent_document_id
          AND parent_task.task_id = NEW.parent_task_id
          AND parent_task.status = 'active'
      )
      OR NOT EXISTS (
        SELECT 1 FROM run_tasks child_task
        WHERE child_task.run_id = NEW.child_run_id
          AND child_task.status NOT IN ('completed', 'completed_with_override')
      )
    )
    AND json_extract(NEW.observability_json, '$.progress.total') = (
      SELECT COUNT(*) FROM run_tasks child_task WHERE child_task.run_id = NEW.child_run_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'child link reservation identity is invalid');
END;

CREATE TRIGGER IF NOT EXISTS child_run_links_identity_guard
BEFORE UPDATE ON child_run_links
WHEN NEW.id IS NOT OLD.id
  OR NEW.schema_version IS NOT OLD.schema_version
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.parent_run_id IS NOT OLD.parent_run_id
  OR NEW.parent_document_id IS NOT OLD.parent_document_id
  OR NEW.parent_task_id IS NOT OLD.parent_task_id
  OR NEW.child_run_id IS NOT OLD.child_run_id
  OR NEW.child_document_id IS NOT OLD.child_document_id
  OR NEW.child_root_prd_file IS NOT OLD.child_root_prd_file
  OR NEW.graph_definition_hash IS NOT OLD.graph_definition_hash
  OR NEW.graph_hash IS NOT OLD.graph_hash
  OR NEW.inherited_options_hash IS NOT OLD.inherited_options_hash
  OR NEW.materialization_hash IS NOT OLD.materialization_hash
  OR NEW.depth IS NOT OLD.depth
  OR NEW.expected_direct_children IS NOT OLD.expected_direct_children
  OR NEW.parent_policy IS NOT OLD.parent_policy
  OR NEW.completion_policy IS NOT OLD.completion_policy
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'child link identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS child_run_links_lease_guard
BEFORE UPDATE OF lease_id ON child_run_links
WHEN NEW.lease_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM leases
    WHERE id = NEW.lease_id
      AND workspace_id = NEW.workspace_id
      AND run_id = NEW.child_run_id
      AND parent_run_id = NEW.parent_run_id
      AND status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'child link lease binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS child_run_links_transition_guard
BEFORE UPDATE ON child_run_links
WHEN OLD.status IN ('passed', 'failed', 'cancelled')
  OR NEW.revision <> OLD.revision + 1
  OR (
    NEW.status <> OLD.status
    AND NOT (
      (OLD.status = 'reserved' AND NEW.status IN ('starting', 'running', 'interrupted', 'passed', 'failed', 'cancelled'))
      OR (OLD.status = 'starting' AND NEW.status IN ('running', 'interrupted', 'passed', 'failed', 'cancelled'))
      OR (OLD.status = 'running' AND NEW.status IN ('waiting', 'blocked', 'interrupted', 'passed', 'failed', 'cancelled'))
      OR (OLD.status = 'waiting' AND NEW.status IN ('starting', 'running', 'blocked', 'interrupted', 'passed', 'failed', 'cancelled'))
      OR (OLD.status = 'blocked' AND NEW.status IN ('starting', 'running', 'interrupted', 'passed', 'failed', 'cancelled'))
      OR (OLD.status = 'interrupted' AND NEW.status IN ('starting', 'running', 'passed', 'failed', 'cancelled'))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'child link transition is invalid');
END;

CREATE TRIGGER IF NOT EXISTS child_run_links_pass_guard
BEFORE UPDATE ON child_run_links
WHEN NEW.status = 'passed'
  AND (
    NEW.artifacts_reconciled <> 1
    OR json_extract(NEW.observability_json, '$.progress.total') < 1
    OR json_extract(NEW.observability_json, '$.progress.completed')
       <> json_extract(NEW.observability_json, '$.progress.total')
    OR NOT EXISTS (SELECT 1 FROM runs WHERE id = NEW.child_run_id AND status = 'completed')
    OR EXISTS (
      SELECT 1 FROM run_tasks
      WHERE run_id = NEW.child_run_id
        AND status NOT IN ('completed', 'completed_with_override')
    )
    OR (
      SELECT COUNT(*) FROM child_run_links WHERE parent_run_id = NEW.child_run_id
    ) <> NEW.expected_direct_children
    OR EXISTS (
      SELECT 1 FROM child_run_links
      WHERE parent_run_id = NEW.child_run_id AND status <> 'passed'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'child pass requires completed run/tasks and reconciled artifacts');
END;

CREATE TRIGGER IF NOT EXISTS child_run_links_immutable_delete
BEFORE DELETE ON child_run_links
BEGIN
  SELECT RAISE(ABORT, 'child links are durable');
END;

CREATE TRIGGER IF NOT EXISTS child_event_projections_immutable_update
BEFORE UPDATE ON child_event_projections
BEGIN
  SELECT RAISE(ABORT, 'child event projections are append-only');
END;

CREATE TRIGGER IF NOT EXISTS child_event_projections_immutable_delete
BEFORE DELETE ON child_event_projections
BEGIN
  SELECT RAISE(ABORT, 'child event projections are append-only');
END;
`
