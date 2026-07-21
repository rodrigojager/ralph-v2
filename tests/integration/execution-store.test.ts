import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"
import {
  AttemptCountersSchema,
  CompletionDecisionSchema,
  CompletionOverrideAuditSchema,
  computeEvidenceBundleContentHash,
  EffectiveRunOptionsSchema,
  EvidenceBundleSchema,
  ExecutionReportSchema,
  ExecutorOutcomeSchema,
  GateResultSchema,
  GitBaselineSchema,
} from "@ralph/domain"
import {
  ATTEMPT_EFFECTIVE_OPTIONS_MIGRATION_SQL,
  commitCompletion,
  createAttempt,
  createModelCall,
  createRun,
  EVIDENCE_STORE_MIGRATION_SQL,
  EXECUTION_HARDENING_MIGRATION_SQL,
  ensureRunLayout,
  findResumableRun,
  getAttempt,
  getCompletionTransaction,
  getEvidenceBundle,
  getModelCall,
  getRun,
  getRunReport,
  getRunTask,
  INITIAL_MIGRATION_SQL,
  initializeLedger,
  JUDGE_ASSESSMENT_MIGRATION_SQL,
  listAttempts,
  listGateResults,
  listModelCalls,
  listPreparedCompletions,
  MODEL_CALL_CONTEXT_MIGRATION_SQL,
  markCompletionMarkerWritten,
  materializeRunTasks,
  ORCHESTRATION_MIGRATION_SQL,
  persistEvidenceBundle,
  persistGateResult,
  persistRunReport,
  prepareCompletion,
  readEvents,
  runLayout,
  TOOL_CALL_JOURNAL_MIGRATION_SQL,
  updateModelCall,
  updateRun,
  upsertRunTask,
  withLedger,
  workspaceLayout,
} from "@ralph/persistence"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const NOW = "2026-07-18T12:00:00.000Z"
const LATER = "2026-07-18T12:01:00.000Z"
const LATEST = "2026-07-18T12:02:00.000Z"
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)
const HASH_C = "c".repeat(64)
const HASH_D = "d".repeat(64)
const HASH_E = "e".repeat(64)
const CURRENT_LEDGER_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

const effectiveOptions = EffectiveRunOptionsSchema.parse({
  schemaVersion: 1,
  mode: { value: "once", source: "cli", sourceRef: "--once" },
  executorProfile: { value: "test-executor", source: "profile" },
  task: { value: null, source: "builtin" },
  force: { value: false, source: "builtin" },
  dryRun: { value: false, source: "builtin" },
  skipTests: { value: false, source: "builtin" },
  skipLint: { value: false, source: "builtin" },
  skipGates: { value: [], source: "builtin" },
  fast: { value: false, source: "builtin" },
  noCommit: { value: true, source: "workspace" },
  failFast: { value: false, source: "builtin" },
  maxTasks: { value: 1, source: "builtin" },
  delayMs: { value: 0, source: "builtin" },
  maxIterations: { value: 1, source: "builtin" },
  maxModelCallsPerAttempt: { value: 2, source: "builtin" },
  maxNoChangeAttempts: { value: 1, source: "builtin" },
  noChangePolicy: {
    value: "require-change",
    original: "require-change",
    source: "builtin",
  },
  securityMode: { value: "safe", source: "builtin" },
  headlessAsk: { value: "deny", source: "builtin" },
  toolRules: { value: {}, source: "builtin" },
  allowedCommands: { value: [], source: "builtin" },
  readPaths: { value: [], source: "builtin" },
  writePaths: { value: [], source: "builtin" },
  allowShell: { value: false, source: "builtin" },
  contentHash: HASH_E,
})

const taskEffectiveOptions = EffectiveRunOptionsSchema.parse({
  ...effectiveOptions,
  executorProfile: {
    value: "task-executor",
    source: "task",
    sourceRef: "task:root-prd/vertical-slice",
  },
  maxModelCallsPerAttempt: {
    value: 1,
    source: "task",
    sourceRef: "task:root-prd/vertical-slice",
  },
  contentHash: HASH_D,
})

const attemptEffectiveOptions = {
  effectiveOptionsHash: taskEffectiveOptions.contentHash,
  effectiveOptions: taskEffectiveOptions,
}

const baseline = GitBaselineSchema.parse({
  schemaVersion: 1,
  kind: "git",
  revision: "abc123",
  branch: "main",
  dirty: false,
  statusHash: HASH_A,
  workspaceSnapshotHash: HASH_A,
  capturedAt: NOW,
})

const counters = AttemptCountersSchema.parse({
  modelCalls: 1,
  toolCalls: 2,
  wiggumIterations: 0,
  executorRetries: 0,
  judgeTransportRetries: 0,
  revisionAttempts: 0,
  noChangeAttempts: 0,
  gateRuns: 1,
})

const gate = GateResultSchema.parse({
  gateId: "contract-test",
  category: "test",
  blocking: true,
  status: "passed",
  exitCode: 0,
  durationMs: 12,
  outputRefs: ["outputs/contract-test.stdout"],
})

function runInput(
  id: string,
  status: "created" | "running" | "interrupted" | "completed",
  createdAt = NOW,
) {
  return {
    id,
    schemaVersion: 1,
    workspaceId: "workspace-1",
    rootPrdId: "root-prd",
    rootPrdFile: "PRD.md",
    definitionHash: HASH_A,
    graphHash: HASH_B,
    mode: "once" as const,
    status,
    effectiveOptionsHash: effectiveOptions.contentHash,
    effectiveOptions,
    createdAt,
  }
}

describe("execution persistence", () => {
  test("upgrades a v1 ledger in place and creates an isolated run layout", async () => {
    const root = await temporaryDirectory()
    const workspace = workspaceLayout(root)
    await mkdir(dirname(workspace.ledger), { recursive: true })
    const legacy = new Database(workspace.ledger, { create: true, strict: true })
    try {
      legacy.exec(INITIAL_MIGRATION_SQL)
      legacy
        .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
        .run("initial", NOW)
      legacy
        .query("INSERT INTO events(event_id, event_json, created_at) VALUES (?, ?, ?)")
        .run("legacy-event", "{}", NOW)
    } finally {
      legacy.close()
    }

    await initializeLedger(workspace)

    const state = withLedger(workspace.ledger, (database) => ({
      versions: database
        .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => row.version),
      eventColumns: database
        .query<{ name: string }, []>("PRAGMA table_info(events)")
        .all()
        .map((row) => row.name),
      legacyEvents: database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM events WHERE event_id = 'legacy-event'",
        )
        .get()?.count,
      pendingIndex: database
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'completion_one_pending_task_idx'",
        )
        .get()?.sql,
    }))
    expect(state.versions).toEqual(CURRENT_LEDGER_VERSIONS)
    expect(state.eventColumns).toContain("run_id")
    expect(state.eventColumns).toContain("document_id")
    expect(state.legacyEvents).toBe(1)
    expect(state.pendingIndex).toContain("WHERE status IN")
    const hardeningColumns = withLedger(workspace.ledger, (database) => ({
      modelCalls: database
        .query<{ name: string }, []>("PRAGMA table_info(model_calls)")
        .all()
        .map((row) => row.name),
      completions: database
        .query<{ name: string }, []>("PRAGMA table_info(completion_transactions)")
        .all()
        .map((row) => row.name),
      attempts: database
        .query<{ name: string }, []>("PRAGMA table_info(attempts)")
        .all()
        .map((row) => row.name),
    }))
    expect(hardeningColumns.modelCalls).toContain("schema_version")
    expect(hardeningColumns.modelCalls).toContain("updated_at")
    expect(hardeningColumns.modelCalls).toContain("context_manifest_hash")
    expect(hardeningColumns.completions).toContain("override_audit_json")
    expect(hardeningColumns.attempts).toContain("effective_options_hash")
    expect(hardeningColumns.attempts).toContain("effective_options_json")
    expect(
      await Bun.file(`${workspace.migrations}/0003-execution-hardening.sql`).exists(),
    ).toBeTrue()
    expect(
      await Bun.file(`${workspace.migrations}/0004-attempt-effective-options.sql`).exists(),
    ).toBeTrue()
    expect(
      await Bun.file(`${workspace.migrations}/0005-model-call-context.sql`).exists(),
    ).toBeTrue()
    expect(await Bun.file(`${workspace.migrations}/0006-tool-call-journal.sql`).exists()).toBeTrue()
    expect(await Bun.file(`${workspace.migrations}/0007-evidence-store.sql`).exists()).toBeTrue()
    expect(await Bun.file(`${workspace.migrations}/0008-judge-assessment.sql`).exists()).toBeTrue()
    expect(
      await Bun.file(`${workspace.migrations}/0015-parallel-reserved-attempts.sql`).exists(),
    ).toBeTrue()

    const layout = await ensureRunLayout(workspace, "run-safe_1")
    expect(layout).toEqual(runLayout(workspace, "run-safe_1"))
    for (const directory of [
      layout.raw,
      layout.evidence,
      layout.reports,
      layout.context,
      layout.artifacts,
    ]) {
      expect((await stat(directory)).isDirectory()).toBeTrue()
    }
    expect(() => runLayout(workspace, "../escape")).toThrow("safe path segment")
  })

  test("applies v3 additively to an existing v2 ledger", async () => {
    const root = await temporaryDirectory()
    const workspace = workspaceLayout(root)
    await mkdir(dirname(workspace.ledger), { recursive: true })
    const versionTwo = new Database(workspace.ledger, { create: true, strict: true })
    try {
      versionTwo.exec(INITIAL_MIGRATION_SQL)
      versionTwo
        .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
        .run("initial", NOW)
      versionTwo.exec(ORCHESTRATION_MIGRATION_SQL)
      versionTwo
        .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (2, ?, ?)")
        .run("orchestration", NOW)
    } finally {
      versionTwo.close()
    }

    await initializeLedger(workspace)
    const state = withLedger(workspace.ledger, (database) => ({
      versions: database
        .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => row.version),
      modelCallUpdatedAt: database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pragma_table_info('model_calls') WHERE name = 'updated_at'",
        )
        .get()?.count,
      modelCallSchemaVersion: database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pragma_table_info('model_calls') WHERE name = 'schema_version'",
        )
        .get()?.count,
      completionAudit: database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pragma_table_info('completion_transactions') WHERE name = 'override_audit_json'",
        )
        .get()?.count,
    }))
    expect(state).toEqual({
      versions: CURRENT_LEDGER_VERSIONS,
      modelCallUpdatedAt: 1,
      modelCallSchemaVersion: 1,
      completionAudit: 1,
    })
  })

  test("applies v4 additively to a populated v3 ledger and backfills attempt options", async () => {
    const root = await temporaryDirectory()
    const workspace = workspaceLayout(root)
    await mkdir(dirname(workspace.ledger), { recursive: true })
    const versionThree = new Database(workspace.ledger, { create: true, strict: true })
    try {
      versionThree.exec(INITIAL_MIGRATION_SQL)
      versionThree
        .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
        .run("initial", NOW)
      versionThree.exec(ORCHESTRATION_MIGRATION_SQL)
      versionThree
        .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (2, ?, ?)")
        .run("orchestration", NOW)
      versionThree.exec(EXECUTION_HARDENING_MIGRATION_SQL)
      versionThree
        .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (3, ?, ?)")
        .run("execution-hardening", NOW)
      versionThree
        .query(
          `INSERT INTO runs(
            id, schema_version, workspace_id, root_prd_id, root_prd_file, definition_hash,
            graph_hash, mode, status, effective_options_hash, effective_options_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "run-v3",
          1,
          "workspace-1",
          "root-prd",
          "PRD.md",
          HASH_A,
          HASH_B,
          "once",
          "running",
          effectiveOptions.contentHash,
          JSON.stringify(effectiveOptions),
          NOW,
          NOW,
        )
      versionThree
        .query(
          `INSERT INTO run_tasks(
            run_id, document_id, task_id, status, marker_content_hash, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("run-v3", "root-prd", "vertical-slice", "active", HASH_A, NOW)
      versionThree
        .query(
          `INSERT INTO attempts(
            id, run_id, document_id, task_id, ordinal, phase, status,
            context_manifest_hash, baseline_json, counters_json, started_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "attempt-v3",
          "run-v3",
          "root-prd",
          "vertical-slice",
          1,
          "created",
          "active",
          HASH_C,
          JSON.stringify(baseline),
          JSON.stringify(counters),
          NOW,
          NOW,
        )
    } finally {
      versionThree.close()
    }

    await initializeLedger(workspace)

    expect(
      withLedger(workspace.ledger, (database) =>
        database
          .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => row.version),
      ),
    ).toEqual(CURRENT_LEDGER_VERSIONS)
    expect(getAttempt(workspace.ledger, "attempt-v3")).toMatchObject({
      effectiveOptionsHash: effectiveOptions.contentHash,
      effectiveOptions,
    })
    expect(() =>
      withLedger(workspace.ledger, (database) =>
        database
          .query("UPDATE attempts SET effective_options_hash = ? WHERE id = ?")
          .run(HASH_A, "attempt-v3"),
      ),
    ).toThrow("attempt effective options hash mismatch")
    expect(getAttempt(workspace.ledger, "attempt-v3")?.effectiveOptionsHash).toBe(
      effectiveOptions.contentHash,
    )
    expect(
      await Bun.file(`${workspace.migrations}/0004-attempt-effective-options.sql`).text(),
    ).toBe(ATTEMPT_EFFECTIVE_OPTIONS_MIGRATION_SQL)
  })

  test("applies v5 to a populated v4 ledger and binds existing calls to their attempt context", async () => {
    const root = await temporaryDirectory()
    const workspace = workspaceLayout(root)
    await mkdir(dirname(workspace.ledger), { recursive: true })
    const versionFour = new Database(workspace.ledger, { create: true, strict: true })
    try {
      for (const [version, name, sql] of [
        [1, "initial", INITIAL_MIGRATION_SQL],
        [2, "orchestration", ORCHESTRATION_MIGRATION_SQL],
        [3, "execution-hardening", EXECUTION_HARDENING_MIGRATION_SQL],
        [4, "attempt-effective-options", ATTEMPT_EFFECTIVE_OPTIONS_MIGRATION_SQL],
      ] as const) {
        versionFour.exec(sql)
        versionFour
          .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(version, name, NOW)
      }
      versionFour
        .query(
          `INSERT INTO runs(
            id, schema_version, workspace_id, root_prd_id, root_prd_file, definition_hash,
            graph_hash, mode, status, effective_options_hash, effective_options_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "run-v4",
          1,
          "workspace-v4",
          "root-prd",
          "PRD.md",
          HASH_A,
          HASH_B,
          "wiggum",
          "running",
          effectiveOptions.contentHash,
          JSON.stringify(effectiveOptions),
          NOW,
          NOW,
        )
      versionFour
        .query(
          `INSERT INTO attempts(
            id, run_id, document_id, task_id, ordinal, phase, status, context_manifest_hash,
            baseline_json, effective_options_hash, effective_options_json, counters_json,
            started_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "attempt-v4",
          "run-v4",
          "root-prd",
          "vertical-slice",
          1,
          "invoking",
          "active",
          HASH_C,
          JSON.stringify(baseline),
          effectiveOptions.contentHash,
          JSON.stringify(effectiveOptions),
          JSON.stringify(counters),
          NOW,
          NOW,
        )
      versionFour
        .query(
          `INSERT INTO model_calls(
            schema_version, id, attempt_id, ordinal, status, request_hash, started_at, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("call-v4", "attempt-v4", 1, "started", HASH_A, NOW, NOW)
    } finally {
      versionFour.close()
    }

    await initializeLedger(workspace)

    expect(getModelCall(workspace.ledger, "call-v4")).toMatchObject({
      requestHash: HASH_A,
      contextManifestHash: HASH_C,
    })
    expect(await Bun.file(`${workspace.migrations}/0005-model-call-context.sql`).text()).toBe(
      MODEL_CALL_CONTEXT_MIGRATION_SQL,
    )
    expect(await Bun.file(`${workspace.migrations}/0006-tool-call-journal.sql`).text()).toBe(
      TOOL_CALL_JOURNAL_MIGRATION_SQL,
    )
    expect(await Bun.file(`${workspace.migrations}/0007-evidence-store.sql`).text()).toBe(
      EVIDENCE_STORE_MIGRATION_SQL,
    )
    expect(await Bun.file(`${workspace.migrations}/0008-judge-assessment.sql`).text()).toBe(
      JUDGE_ASSESSMENT_MIGRATION_SQL,
    )
  })

  test("finds the newest compatible resumable run and rolls state back with a failed event", async () => {
    const root = await temporaryDirectory()
    const workspace = workspaceLayout(root)
    await initializeLedger(workspace)

    createRun(workspace.ledger, runInput("run-old", "created", NOW))
    createRun(workspace.ledger, runInput("run-resume", "interrupted", LATER))
    createRun(workspace.ledger, runInput("run-terminal", "completed", LATEST))

    expect(
      findResumableRun(workspace.ledger, {
        workspaceId: "workspace-1",
        rootPrdFile: "PRD.md",
        rootPrdId: "root-prd",
        definitionHash: HASH_A,
      })?.id,
    ).toBe("run-resume")
    expect(
      findResumableRun(workspace.ledger, {
        workspaceId: "workspace-1",
        rootPrdFile: "PRD.md",
        definitionHash: HASH_C,
      }),
    ).toBeUndefined()

    const before = withLedger(workspace.ledger, (database) => ({
      events: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
        ?.count,
      outbox: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM outbox").get()
        ?.count,
    }))
    expect(() =>
      updateRun(workspace.ledger, {
        runId: "run-resume",
        status: "running",
        event: { type: "" },
      }),
    ).toThrow()
    expect(getRun(workspace.ledger, "run-resume")?.status).toBe("interrupted")
    const after = withLedger(workspace.ledger, (database) => ({
      events: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
        ?.count,
      outbox: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM outbox").get()
        ?.count,
    }))
    expect(after).toEqual(before)
  })

  test("persists model calls with attempt counters and lists attempts for resume", async () => {
    const root = await temporaryDirectory()
    const workspace = workspaceLayout(root)
    await initializeLedger(workspace)
    createRun(workspace.ledger, runInput("run-calls", "running"))
    materializeRunTasks(workspace.ledger, {
      runId: "run-calls",
      tasks: [
        {
          documentId: "root-prd",
          taskId: "vertical-slice",
          status: "active",
          markerContentHash: HASH_A,
        },
      ],
    })
    const initialCounters = AttemptCountersSchema.parse({ ...counters, modelCalls: 0 })
    createAttempt(workspace.ledger, {
      id: "attempt-call-1",
      runId: "run-calls",
      documentId: "root-prd",
      taskId: "vertical-slice",
      ordinal: 1,
      phase: "invoking",
      status: "active",
      contextManifestHash: HASH_C,
      baseline,
      ...attemptEffectiveOptions,
      counters: initialCounters,
      startedAt: NOW,
    })
    createAttempt(workspace.ledger, {
      id: "attempt-call-2",
      runId: "run-calls",
      documentId: "root-prd",
      taskId: "vertical-slice",
      ordinal: 2,
      phase: "decision",
      status: "failed",
      contextManifestHash: HASH_D,
      baseline,
      ...attemptEffectiveOptions,
      counters: initialCounters,
      startedAt: LATEST,
    })

    const storedAttempts = listAttempts(workspace.ledger, { runId: "run-calls" })
    expect(storedAttempts.map((item) => item.id)).toEqual(["attempt-call-1", "attempt-call-2"])
    expect(storedAttempts[0]).toMatchObject({
      effectiveOptionsHash: taskEffectiveOptions.contentHash,
      effectiveOptions: taskEffectiveOptions,
    })
    expect(storedAttempts[0]?.effectiveOptions).not.toEqual(
      getRun(workspace.ledger, "run-calls")?.effectiveOptions,
    )
    expect(() =>
      createAttempt(workspace.ledger, {
        id: "attempt-options-mismatch",
        runId: "run-calls",
        documentId: "root-prd",
        taskId: "vertical-slice",
        ordinal: 3,
        phase: "created",
        status: "active",
        contextManifestHash: HASH_C,
        baseline,
        effectiveOptionsHash: HASH_A,
        effectiveOptions: taskEffectiveOptions,
        counters: initialCounters,
        startedAt: LATEST,
      }),
    ).toThrow("Attempt effective options snapshot does not match effectiveOptionsHash")
    expect(getAttempt(workspace.ledger, "attempt-options-mismatch")).toBeUndefined()
    expect(
      listAttempts(workspace.ledger, {
        runId: "run-calls",
        documentId: "root-prd",
        taskId: "vertical-slice",
        statuses: ["failed"],
      }).map((item) => item.id),
    ).toEqual(["attempt-call-2"])

    expect(() =>
      createModelCall(workspace.ledger, {
        id: "call-out-of-order",
        attemptId: "attempt-call-1",
        ordinal: 2,
        requestHash: HASH_C,
        contextManifestHash: HASH_B,
      }),
    ).toThrow("does not match the next counter 1")
    expect(getAttempt(workspace.ledger, "attempt-call-1")?.counters.modelCalls).toBe(0)

    createModelCall(workspace.ledger, {
      id: "call-1",
      attemptId: "attempt-call-1",
      ordinal: 1,
      requestHash: HASH_A,
      contextManifestHash: HASH_B,
      startedAt: NOW,
    })
    createModelCall(workspace.ledger, {
      id: "call-2",
      attemptId: "attempt-call-1",
      ordinal: 2,
      requestHash: HASH_B,
      contextManifestHash: HASH_C,
      startedAt: LATER,
    })
    expect(listModelCalls(workspace.ledger, "attempt-call-1").map((call) => call.id)).toEqual([
      "call-1",
      "call-2",
    ])
    expect(listModelCalls(workspace.ledger, "attempt-call-1")).toMatchObject([
      { id: "call-1", contextManifestHash: HASH_B },
      { id: "call-2", contextManifestHash: HASH_C },
    ])
    expect(getAttempt(workspace.ledger, "attempt-call-1")?.counters.modelCalls).toBe(2)

    expect(() =>
      createModelCall(workspace.ledger, {
        id: "call-rolled-back",
        attemptId: "attempt-call-1",
        ordinal: 3,
        requestHash: HASH_C,
        contextManifestHash: HASH_A,
        event: { type: "" },
      }),
    ).toThrow()
    expect(getModelCall(workspace.ledger, "call-rolled-back")).toBeUndefined()
    expect(getAttempt(workspace.ledger, "attempt-call-1")?.counters.modelCalls).toBe(2)

    const outcome = ExecutorOutcomeSchema.parse({
      schemaVersion: 1,
      status: "work_submitted",
      summary: "The executor submitted work for verification.",
      intendedFiles: ["src/feature.ts"],
      artifactRefs: [],
      suggestedVerifications: [],
      risks: [],
      reportedAt: LATER,
    })
    expect(
      updateModelCall(workspace.ledger, {
        modelCallId: "call-1",
        status: "succeeded",
        outcome,
        finishedAt: LATER,
      }),
    ).toMatchObject({ status: "succeeded", outcome, finishedAt: LATER })
    expect(() =>
      updateModelCall(workspace.ledger, {
        modelCallId: "call-2",
        status: "failed",
        event: { type: "" },
      }),
    ).toThrow()
    expect(getModelCall(workspace.ledger, "call-2")?.status).toBe("started")
    expect(
      updateModelCall(workspace.ledger, {
        modelCallId: "call-2",
        status: "failed",
        finishedAt: LATEST,
      }).status,
    ).toBe("failed")
    expect(() =>
      updateModelCall(workspace.ledger, {
        modelCallId: "call-2",
        status: "cancelled",
      }),
    ).toThrow("already terminal")

    const modelEvents = readEvents(workspace.ledger).filter((event) =>
      event.type.startsWith("model.call."),
    )
    expect(modelEvents.map((event) => [event.type, event.callId])).toEqual([
      ["model.call.started", "call-1"],
      ["model.call.started", "call-2"],
      ["model.call.finished", "call-1"],
      ["model.call.finished", "call-2"],
    ])
    const counts = withLedger(workspace.ledger, (database) => ({
      events: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
        ?.count,
      outbox: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM outbox").get()
        ?.count,
    }))
    expect(counts.events).toBe(counts.outbox)
  })

  test("requires and persists an exact override audit without permitting failed blocking gates", async () => {
    const root = await temporaryDirectory()
    const workspace = workspaceLayout(root)
    await initializeLedger(workspace)
    createRun(workspace.ledger, runInput("run-override", "running"))
    materializeRunTasks(workspace.ledger, {
      runId: "run-override",
      tasks: [
        {
          documentId: "root-prd",
          taskId: "audited-skip",
          status: "evaluating",
          markerContentHash: HASH_A,
        },
        {
          documentId: "root-prd",
          taskId: "failed-gate",
          status: "evaluating",
          markerContentHash: HASH_A,
        },
      ],
    })

    const skippedGate = GateResultSchema.parse({
      gateId: "required-test",
      category: "test",
      blocking: true,
      status: "skipped_by_cli",
      durationMs: 0,
      outputRefs: [],
      reason: "Explicit --force and --skip-tests override.",
    })
    const failedGate = GateResultSchema.parse({
      gateId: "blocking-failure",
      category: "test",
      blocking: true,
      status: "failed",
      exitCode: 1,
      durationMs: 10,
      outputRefs: [],
    })

    const persistAttemptEvidence = (
      taskId: string,
      attemptId: string,
      evidenceId: string,
      _evidenceHash: string,
      result: typeof skippedGate,
    ) => {
      createAttempt(workspace.ledger, {
        id: attemptId,
        runId: "run-override",
        documentId: "root-prd",
        taskId,
        ordinal: 1,
        phase: "decision",
        status: "active",
        contextManifestHash: HASH_C,
        baseline,
        ...attemptEffectiveOptions,
        counters,
        startedAt: NOW,
      })
      persistGateResult(workspace.ledger, {
        attemptId,
        gateId: result.gateId,
        result,
        createdAt: NOW,
      })
      const evidenceBody = {
        schemaVersion: 1,
        id: evidenceId,
        runId: "run-override",
        documentId: "root-prd",
        taskId,
        attemptId,
        taskSpecHash: HASH_B,
        baseline,
        changes: {
          schemaVersion: 1,
          policy: "require-change",
          status: "changed",
          files: [{ path: `src/${taskId}.ts`, kind: "modified", contentHash: HASH_B }],
          outsideScopePaths: [],
          reproducible: true,
          missingContent: [],
          diffHash: HASH_C,
          diffRef: "evidence/workspace-diff.json",
          attemptDiffHash: HASH_C,
          attemptDiffRef: "evidence/attempt-diff.json",
        },
        artifacts: [],
        gates: [result],
        contextManifestHash: HASH_C,
        createdAt: NOW,
      } as const
      const evidence = EvidenceBundleSchema.parse({
        ...evidenceBody,
        contentHash: computeEvidenceBundleContentHash(evidenceBody),
      })
      persistEvidenceBundle(workspace.ledger, {
        id: evidence.id,
        attemptId,
        contentHash: evidence.contentHash,
        bundle: evidence,
        createdAt: NOW,
      })
      return evidence
    }

    const skippedEvidence = persistAttemptEvidence(
      "audited-skip",
      "attempt-override",
      "evidence-override",
      HASH_D,
      skippedGate,
    )
    const failedEvidence = persistAttemptEvidence(
      "failed-gate",
      "attempt-failed-gate",
      "evidence-failed-gate",
      HASH_E,
      failedGate,
    )
    const overrideDecision = CompletionDecisionSchema.parse({
      status: "overridden",
      deterministicPassed: false,
      evaluationMode: "none",
      evidenceBundleId: skippedEvidence.id,
      reasons: ["A required test was explicitly skipped with force."],
      decidedBy: "ralph-policy",
      decidedAt: NOW,
    })
    const audit = CompletionOverrideAuditSchema.parse({
      schemaVersion: 1,
      eventId: "override-audit-event-1",
      source: "cli",
      force: true,
      reason: "The operator explicitly accepted skipping the required test.",
      overriddenGateIds: [skippedGate.gateId],
      recordedAt: NOW,
    })

    expect(() =>
      prepareCompletion(workspace.ledger, {
        id: "missing-audit",
        runId: "run-override",
        documentId: "root-prd",
        taskId: "audited-skip",
        attemptId: "attempt-override",
        expectedBeforeHash: HASH_A,
        decision: overrideDecision,
      }),
    ).toThrow("requires a persisted CompletionOverrideAudit")
    const normalDecision = CompletionDecisionSchema.parse({
      ...overrideDecision,
      status: "passed",
      deterministicPassed: true,
      reasons: ["Normal completion cannot smuggle an override audit."],
    })
    expect(() =>
      prepareCompletion(workspace.ledger, {
        id: "audit-on-normal",
        runId: "run-override",
        documentId: "root-prd",
        taskId: "audited-skip",
        attemptId: "attempt-override",
        expectedBeforeHash: HASH_A,
        decision: normalDecision,
        overrideAudit: audit,
      }),
    ).toThrow("normal passed completion cannot carry an override audit")
    expect(() =>
      prepareCompletion(workspace.ledger, {
        id: "mismatched-audit",
        runId: "run-override",
        documentId: "root-prd",
        taskId: "audited-skip",
        attemptId: "attempt-override",
        expectedBeforeHash: HASH_A,
        decision: overrideDecision,
        overrideAudit: { ...audit, eventId: "mismatch-event", overriddenGateIds: [] },
      }),
    ).toThrow("must name every and only CLI-skipped blocking gate")

    const failedDecision = CompletionDecisionSchema.parse({
      ...overrideDecision,
      evidenceBundleId: failedEvidence.id,
    })
    expect(() =>
      prepareCompletion(workspace.ledger, {
        id: "failed-gate-override",
        runId: "run-override",
        documentId: "root-prd",
        taskId: "failed-gate",
        attemptId: "attempt-failed-gate",
        expectedBeforeHash: HASH_A,
        decision: failedDecision,
        overrideAudit: {
          ...audit,
          eventId: "failed-gate-audit",
          overriddenGateIds: [failedGate.gateId],
        },
      }),
    ).toThrow("only passed or explicitly CLI-skipped blocking gates")

    const prepared = prepareCompletion(workspace.ledger, {
      id: "completion-override",
      runId: "run-override",
      documentId: "root-prd",
      taskId: "audited-skip",
      attemptId: "attempt-override",
      expectedBeforeHash: HASH_A,
      decision: overrideDecision,
      overrideAudit: audit,
      preparedAt: NOW,
    })
    expect(prepared.overrideAudit).toEqual(audit)
    const auditEvent = readEvents(workspace.ledger).find((event) => event.eventId === audit.eventId)
    expect(auditEvent).toMatchObject({
      type: "completion.override_audited",
      taskId: "audited-skip",
      attemptId: "attempt-override",
    })

    markCompletionMarkerWritten(workspace.ledger, {
      completionId: prepared.id,
      expectedAfterHash: HASH_B,
      markerWrittenAt: LATER,
    })
    expect(() =>
      commitCompletion(workspace.ledger, {
        completionId: prepared.id,
        markerContentHash: HASH_B,
        completion: normalDecision,
      }),
    ).toThrow("must be identical to the prepared completion decision")
    commitCompletion(workspace.ledger, {
      completionId: prepared.id,
      markerContentHash: HASH_B,
      committedAt: LATEST,
    })
    expect(getRunTask(workspace.ledger, "run-override", "root-prd", "audited-skip")?.status).toBe(
      "completed_with_override",
    )
    const counts = withLedger(workspace.ledger, (database) => ({
      events: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
        ?.count,
      outbox: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM outbox").get()
        ?.count,
    }))
    expect(counts.events).toBe(counts.outbox)
  })

  test("persists evidence and commits completion only through prepared and marker_written", async () => {
    const root = await temporaryDirectory()
    const workspace = workspaceLayout(root)
    await initializeLedger(workspace)
    createRun(workspace.ledger, runInput("run-1", "running"))
    materializeRunTasks(workspace.ledger, {
      runId: "run-1",
      tasks: [
        {
          documentId: "root-prd",
          taskId: "vertical-slice",
          status: "eligible",
          markerContentHash: HASH_A,
        },
      ],
    })
    upsertRunTask(workspace.ledger, {
      runId: "run-1",
      documentId: "root-prd",
      taskId: "vertical-slice",
      status: "evaluating",
      markerContentHash: HASH_A,
    })
    createAttempt(workspace.ledger, {
      id: "attempt-1",
      runId: "run-1",
      documentId: "root-prd",
      taskId: "vertical-slice",
      ordinal: 1,
      phase: "decision",
      status: "active",
      contextManifestHash: HASH_C,
      baseline,
      ...attemptEffectiveOptions,
      counters,
      startedAt: NOW,
    })
    persistGateResult(workspace.ledger, {
      attemptId: "attempt-1",
      gateId: gate.gateId,
      result: gate,
      createdAt: NOW,
    })

    const evidenceBody = {
      schemaVersion: 1,
      id: "evidence-1",
      runId: "run-1",
      documentId: "root-prd",
      taskId: "vertical-slice",
      attemptId: "attempt-1",
      taskSpecHash: HASH_B,
      baseline,
      changes: {
        schemaVersion: 1,
        policy: "require-change",
        status: "changed",
        files: [{ path: "src/feature.ts", kind: "modified", contentHash: HASH_B }],
        outsideScopePaths: [],
        reproducible: true,
        missingContent: [],
        diffHash: HASH_C,
        diffRef: "evidence/workspace-diff.json",
        attemptDiffHash: HASH_C,
        attemptDiffRef: "evidence/attempt-diff.json",
      },
      artifacts: [],
      gates: [gate],
      contextManifestHash: HASH_C,
      createdAt: NOW,
    } as const
    const evidence = EvidenceBundleSchema.parse({
      ...evidenceBody,
      contentHash: computeEvidenceBundleContentHash(evidenceBody),
    })
    persistEvidenceBundle(workspace.ledger, {
      id: evidence.id,
      attemptId: evidence.attemptId,
      contentHash: evidence.contentHash,
      bundle: evidence,
      createdAt: NOW,
    })
    expect(listGateResults(workspace.ledger, "attempt-1")).toHaveLength(1)
    expect(getEvidenceBundle(workspace.ledger, "attempt-1")?.id).toBe("evidence-1")
    expect(() =>
      withLedger(workspace.ledger, (database) =>
        database
          .query("UPDATE evidence_bundles SET created_at = ? WHERE id = ?")
          .run("2026-07-18T12:00:09.000Z", evidence.id),
      ),
    ).toThrow("evidence bundles are append-only")

    const report = ExecutionReportSchema.parse({
      schemaVersion: 1,
      id: "report-1",
      runId: "run-1",
      rootPrdId: "root-prd",
      rootPrdFile: "PRD.md",
      definitionHash: HASH_A,
      graphHash: HASH_B,
      mode: "once",
      status: "running",
      effectiveOptionsHash: effectiveOptions.contentHash,
      effectiveOptions,
      tasks: [
        {
          taskId: "vertical-slice",
          documentId: "root-prd",
          status: "evaluating",
          attemptIds: ["attempt-1"],
        },
      ],
      counters: {
        tasksSelected: 1,
        tasksCompleted: 0,
        tasksFailed: 0,
        tasksBlocked: 0,
        attempts: 1,
        modelCalls: 1,
        toolCalls: 2,
        wiggumIterations: 0,
        executorRetries: 0,
        judgeTransportRetries: 0,
        revisionAttempts: 0,
        gateRuns: 1,
        noChangeAttempts: 0,
      },
      reasons: [],
      createdAt: NOW,
      contentHash: HASH_A,
    })
    persistRunReport(workspace.ledger, { runId: "run-1", report, updatedAt: NOW })
    expect(getRunReport(workspace.ledger, "run-1")?.report).toEqual(report)

    const decision = CompletionDecisionSchema.parse({
      status: "passed",
      deterministicPassed: true,
      evaluationMode: "none",
      evidenceBundleId: evidence.id,
      reasons: ["Deterministic evidence and blocking gate passed."],
      decidedBy: "ralph-policy",
      decidedAt: NOW,
    })
    const prepared = prepareCompletion(workspace.ledger, {
      id: "completion-1",
      runId: "run-1",
      documentId: "root-prd",
      taskId: "vertical-slice",
      attemptId: "attempt-1",
      expectedBeforeHash: HASH_A,
      decision,
      preparedAt: NOW,
    })
    expect(prepared.status).toBe("prepared")
    expect(listPreparedCompletions(workspace.ledger, "run-1")).toHaveLength(1)
    expect(() =>
      commitCompletion(workspace.ledger, {
        completionId: "completion-1",
        markerContentHash: HASH_B,
      }),
    ).toThrow("cannot move from prepared")
    expect(getRunTask(workspace.ledger, "run-1", "root-prd", "vertical-slice")?.status).toBe(
      "evaluating",
    )

    const markerWritten = markCompletionMarkerWritten(workspace.ledger, {
      completionId: "completion-1",
      expectedAfterHash: HASH_B,
      markerWrittenAt: LATER,
    })
    expect(markerWritten.status).toBe("marker_written")
    expect(listPreparedCompletions(workspace.ledger, "run-1")[0]?.status).toBe("marker_written")

    const committed = commitCompletion(workspace.ledger, {
      completionId: "completion-1",
      markerContentHash: HASH_B,
      completion: decision,
      committedAt: LATEST,
    })
    expect(committed.status).toBe("committed")
    expect(getCompletionTransaction(workspace.ledger, "completion-1")?.committedAt).toBe(LATEST)
    expect(listPreparedCompletions(workspace.ledger, "run-1")).toEqual([])
    expect(getRunTask(workspace.ledger, "run-1", "root-prd", "vertical-slice")).toMatchObject({
      status: "completed",
      markerContentHash: HASH_B,
      completion: decision,
    })
    expect(getAttempt(workspace.ledger, "attempt-1")).toMatchObject({
      phase: "decision",
      status: "passed",
      completionDecision: decision,
    })
    expect(readEvents(workspace.ledger).map((event) => event.type)).toEqual([
      "run.created",
      "run.tasks.materialized",
      "task.state.updated",
      "attempt.created",
      "gate.persisted",
      "evidence.persisted",
      "run.report.persisted",
      "completion.prepared",
      "completion.marker_written",
      "task.completed",
      "progress.updated",
    ])
    const counts = withLedger(workspace.ledger, (database) => ({
      events: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
        ?.count,
      outbox: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM outbox").get()
        ?.count,
    }))
    expect(counts.events).toBe(counts.outbox)
  })
})
