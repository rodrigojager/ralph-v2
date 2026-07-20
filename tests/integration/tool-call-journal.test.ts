import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  ATTEMPT_EFFECTIVE_OPTIONS_MIGRATION_SQL,
  createSqliteToolCallJournal,
  EXECUTION_HARDENING_MIGRATION_SQL,
  getToolCallIntent,
  getToolCallSettlement,
  hashToolCallPayload,
  INITIAL_MIGRATION_SQL,
  initializeLedger,
  listUnsettledToolCalls,
  MODEL_CALL_CONTEXT_MIGRATION_SQL,
  ORCHESTRATION_MIGRATION_SQL,
  readEvents,
  recordToolCallIntent,
  registerLedgerRedactionSecrets,
  settleToolCall,
  TOOL_CALL_JOURNAL_LIMITS,
  TOOL_CALL_JOURNAL_MIGRATION_SQL,
  withLedger,
  workspaceLayout,
} from "@ralph-next/persistence"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const NOW = "2026-07-18T14:00:00.000Z"
const LATER = "2026-07-18T14:01:00.000Z"
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)
const HASH_C = "c".repeat(64)
const HASH_D = "d".repeat(64)
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

function seedExecutionScope(path: string): void {
  withLedger(path, (database) =>
    database.transaction(() => {
      database
        .query(
          `INSERT INTO runs(
            id, schema_version, workspace_id, root_prd_id, root_prd_file, definition_hash,
            graph_hash, mode, status, effective_options_hash, effective_options_json,
            created_at, updated_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, 'once', 'running', ?, ?, ?, ?)`,
        )
        .run(
          "run-tools",
          "workspace-tools",
          "root-prd",
          "PRD.md",
          HASH_A,
          HASH_B,
          HASH_C,
          JSON.stringify({ contentHash: HASH_C }),
          NOW,
          NOW,
        )
      database
        .query(
          `INSERT INTO run_tasks(
            run_id, document_id, task_id, status, marker_content_hash, updated_at
          ) VALUES (?, ?, ?, 'active', ?, ?)`,
        )
        .run("run-tools", "root-prd", "slice-one", HASH_A, NOW)
      database
        .query(
          `INSERT INTO attempts(
            id, run_id, document_id, task_id, ordinal, phase, status,
            context_manifest_hash, baseline_json, effective_options_hash,
            effective_options_json, counters_json, started_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, 'tools', 'active', ?, '{}', ?, ?, '{}', ?, ?)`,
        )
        .run(
          "attempt-tools",
          "run-tools",
          "root-prd",
          "slice-one",
          HASH_D,
          HASH_C,
          JSON.stringify({ contentHash: HASH_C }),
          NOW,
          NOW,
        )
      database
        .query(
          `INSERT INTO model_calls(
            schema_version, id, attempt_id, ordinal, status, request_hash,
            context_manifest_hash, started_at, updated_at
          ) VALUES (1, ?, ?, 1, 'started', ?, ?, ?, ?)`,
        )
        .run("model-call-tools", "attempt-tools", HASH_A, HASH_D, NOW, NOW)
    })(),
  )
}

function intentInput(overrides: Record<string, unknown> = {}) {
  const args = { path: "src/feature.ts", content: "hello" }
  return {
    id: "intent-1",
    runId: "run-tools",
    documentId: "root-prd",
    taskId: "slice-one",
    attemptId: "attempt-tools",
    modelCallId: "model-call-tools",
    providerToolCallId: "provider-tool-1",
    tool: "fs.write",
    argumentsHash: hashToolCallPayload(args),
    arguments: args,
    risk: "write" as const,
    effectClass: "workspace-write" as const,
    authorization: "allowed" as const,
    preconditionRefs: ["workspace:src/feature.ts#before=missing"],
    requestedAt: NOW,
    ...overrides,
  }
}

describe("durable tool-call journal", () => {
  test("upgrades a v5 ledger additively and installs immutable v6 tables", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await mkdir(dirname(layout.ledger), { recursive: true })
    const database = new Database(layout.ledger, { create: true, strict: true })
    try {
      for (const [version, name, sql] of [
        [1, "initial", INITIAL_MIGRATION_SQL],
        [2, "orchestration", ORCHESTRATION_MIGRATION_SQL],
        [3, "execution-hardening", EXECUTION_HARDENING_MIGRATION_SQL],
        [4, "attempt-effective-options", ATTEMPT_EFFECTIVE_OPTIONS_MIGRATION_SQL],
        [5, "model-call-context", MODEL_CALL_CONTEXT_MIGRATION_SQL],
      ] as const) {
        database.exec(sql)
        database
          .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
          .run(version, name, NOW)
      }
    } finally {
      database.close(true)
    }

    await initializeLedger(layout)
    const state = withLedger(layout.ledger, (ledger) => ({
      versions: ledger
        .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => row.version),
      intents: ledger
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pragma_table_info('tool_call_intents')",
        )
        .get()?.count,
      settlements: ledger
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM pragma_table_info('tool_call_settlements')",
        )
        .get()?.count,
    }))
    expect(state.versions).toEqual(CURRENT_LEDGER_VERSIONS)
    expect(state.intents).toBeGreaterThan(0)
    expect(state.settlements).toBeGreaterThan(0)
    expect(await Bun.file(`${layout.migrations}/0006-tool-call-journal.sql`).text()).toBe(
      TOOL_CALL_JOURNAL_MIGRATION_SQL,
    )
  })

  test("persists intent before effect, redacts bounded data and resumes unsettled work", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    seedExecutionScope(layout.ledger)
    const secret = "journal-secret-canary"
    const release = registerLedgerRedactionSecrets(layout.ledger, [secret])
    try {
      const journal = createSqliteToolCallJournal(layout.ledger)
      const args = { path: "src/feature.ts", authorization: secret, nested: { value: secret } }
      const created = journal.recordIntent(
        intentInput({
          arguments: args,
          argumentsHash: hashToolCallPayload(args),
          preconditionRefs: [`workspace:src/feature.ts?token=${secret}`],
        }),
      )
      expect(created.disposition).toBe("created")
      expect(JSON.stringify(created.intent.argumentsRedacted)).not.toContain(secret)
      expect(JSON.stringify(created.intent.argumentsRedacted)).toContain("[REDACTED]")
      expect(created.intent.preconditionRefs[0]).not.toContain(secret)

      const repeated = journal.recordIntent(
        intentInput({
          id: "intent-retry-with-new-local-id",
          arguments: args,
          argumentsHash: hashToolCallPayload(args),
          preconditionRefs: [`workspace:src/feature.ts?token=${secret}`],
        }),
      )
      expect(repeated).toEqual({ disposition: "existing", intent: created.intent })

      const resumed = createSqliteToolCallJournal(layout.ledger).listUnsettled({
        runId: "run-tools",
      })
      expect(resumed).toHaveLength(1)
      expect(resumed[0]).toMatchObject({
        intent: { id: "intent-1", recoveryStrategy: "verify-preconditions" },
        recovery: {
          strategy: "verify-preconditions",
          automaticReplayAllowed: false,
          requiresReconciliation: true,
        },
      })
      expect(
        readEvents(layout.ledger).filter((event) => event.type === "tool.call.requested"),
      ).toHaveLength(1)

      expect(() =>
        withLedger(layout.ledger, (database) =>
          database
            .query("UPDATE tool_call_intents SET tool_name = 'fs.read' WHERE id = 'intent-1'")
            .run(),
        ),
      ).toThrow("tool call intents are append-only")
    } finally {
      release()
    }
  })

  test("settles once, survives restart and rejects a divergent settlement", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    seedExecutionScope(layout.ledger)
    recordToolCallIntent(layout.ledger, intentInput())

    const secret = "settlement-secret-canary"
    const result = { ok: true, preview: `created using ${secret}` }
    const release = registerLedgerRedactionSecrets(layout.ledger, [secret])
    let first: ReturnType<typeof settleToolCall> | undefined
    try {
      first = settleToolCall(layout.ledger, {
        id: "settlement-1",
        intentId: "intent-1",
        outcome: "succeeded",
        resultHash: hashToolCallPayload(result),
        result,
        effectRefs: ["workspace:src/feature.ts"],
        outputRefs: [`raw://sha256/${HASH_A}?secret=${secret}`],
        settledAt: LATER,
      })
      expect(JSON.stringify(first.resultRedacted)).not.toContain(secret)
      expect(first.outputRefs[0]).not.toContain(secret)
      expect(listUnsettledToolCalls(layout.ledger)).toEqual([])
    } finally {
      release()
    }
    if (!first) throw new Error("fixture settlement was not created")

    const restarted = createSqliteToolCallJournal(layout.ledger)
    expect(restarted.getIntent("intent-1")).toEqual(getToolCallIntent(layout.ledger, "intent-1"))
    expect(restarted.getSettlement("intent-1")).toEqual(first)
    expect(getToolCallSettlement(layout.ledger, "intent-1")).toEqual(first)
    expect(
      restarted.settle({
        id: "settlement-retry-with-new-local-id",
        intentId: "intent-1",
        outcome: "succeeded",
        resultHash: hashToolCallPayload(result),
        result,
        effectRefs: ["workspace:src/feature.ts"],
        outputRefs: [`raw://sha256/${HASH_A}?secret=${secret}`],
        settledAt: "2026-07-18T14:02:00.000Z",
      }),
    ).toEqual(first)

    expect(() =>
      restarted.settle({
        id: "settlement-conflict",
        intentId: "intent-1",
        outcome: "failed",
        resultHash: HASH_B,
        result: { ok: false },
      }),
    ).toThrow("already has a different settlement")
    expect(
      readEvents(layout.ledger).filter((event) => event.type === "tool.call.settled"),
    ).toHaveLength(1)
  })

  test("rejects provider call-id reuse with divergent arguments without appending state", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    seedExecutionScope(layout.ledger)
    recordToolCallIntent(layout.ledger, intentInput())

    let caught: unknown
    try {
      recordToolCallIntent(
        layout.ledger,
        intentInput({
          id: "intent-conflict",
          arguments: { path: "src/other.ts" },
          argumentsHash: HASH_B,
        }),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RalphError)
    expect(caught).toMatchObject({
      code: "RALPH_TOOL_CALL_IDEMPOTENCY_CONFLICT",
      exitCode: EXIT_CODES.conflict,
    })
    const counts = withLedger(layout.ledger, (database) => ({
      intents: database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM tool_call_intents")
        .get()?.count,
      requestedEvents: readEvents(layout.ledger).filter(
        (event) => event.type === "tool.call.requested",
      ).length,
    }))
    expect(counts).toEqual({ intents: 1, requestedEvents: 1 })
  })

  test("classifies read-only and external unsettled intents without blind replay", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    seedExecutionScope(layout.ledger)
    recordToolCallIntent(
      layout.ledger,
      intentInput({
        id: "intent-read",
        providerToolCallId: "provider-read",
        tool: "fs.read",
        risk: "read",
        effectClass: "read-only",
      }),
    )
    recordToolCallIntent(
      layout.ledger,
      intentInput({
        id: "intent-external",
        providerToolCallId: "provider-external",
        tool: "artifact.publish",
        risk: "external-effect",
        effectClass: "external-effect",
      }),
    )

    expect(
      listUnsettledToolCalls(layout.ledger, { modelCallId: "model-call-tools" }).map((item) => ({
        id: item.intent.id,
        strategy: item.recovery.strategy,
        replay: item.recovery.automaticReplayAllowed,
      })),
    ).toEqual([
      { id: "intent-external", strategy: "manual-reconciliation", replay: false },
      { id: "intent-read", strategy: "safe-to-retry", replay: true },
    ])
  })

  test("fails closed before persisting oversized references or structured values", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    seedExecutionScope(layout.ledger)

    expect(() =>
      recordToolCallIntent(
        layout.ledger,
        intentInput({
          preconditionRefs: ["x".repeat(TOOL_CALL_JOURNAL_LIMITS.referenceBytes + 1)],
        }),
      ),
    ).toThrow("exceeds the 1024-byte persistence limit")
    expect(getToolCallIntent(layout.ledger, "intent-1")).toBeUndefined()

    recordToolCallIntent(layout.ledger, intentInput())
    expect(() =>
      settleToolCall(layout.ledger, {
        id: "settlement-too-large",
        intentId: "intent-1",
        outcome: "failed",
        resultHash: HASH_B,
        result: { output: "x".repeat(TOOL_CALL_JOURNAL_LIMITS.structuredValueBytes + 1) },
      }),
    ).toThrow("exceeds the 65536-byte persistence limit")
    expect(getToolCallSettlement(layout.ledger, "intent-1")).toBeUndefined()
    expect(listUnsettledToolCalls(layout.ledger)).toHaveLength(1)
  })
})
