import { afterEach, describe, expect, test } from "bun:test"
import {
  createSqliteToolCallJournal,
  initializeLedger,
  registerLedgerRedactionSecrets,
  withLedger,
  workspaceLayout,
} from "@ralph-next/persistence"
import {
  hashCanonical,
  type ToolAuthorization,
  type ToolCallRecord,
  type ToolSettlement,
} from "@ralph-next/tool-host"
import { createTestDirectory, removeTestDirectory } from "../../../tests/helpers/temp-directory"
import { DurableToolJournal } from "../src/tool-journal-adapter"

const NOW = "2026-07-18T14:00:00.000Z"
const AUTHORIZED_AT = "2026-07-18T14:00:01.000Z"
const STARTED_AT = "2026-07-18T14:00:02.000Z"
const SETTLED_AT = "2026-07-18T14:00:03.000Z"
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)
const HASH_C = "c".repeat(64)
const HASH_D = "d".repeat(64)

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

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

const scope = {
  runId: "run-tools",
  documentId: "root-prd",
  taskId: "slice-one",
  attemptId: "attempt-tools",
}

function candidate(
  overrides: Partial<ToolCallRecord> & { argumentsRedacted?: unknown } = {},
): ToolCallRecord {
  const argumentsRedacted = overrides.argumentsRedacted ?? {
    path: "src/feature.ts",
    content: "hello",
  }
  return {
    schemaVersion: 1,
    id: "tool-call-1",
    attemptId: scope.attemptId,
    modelCallId: "model-call-tools",
    providerToolCallId: "provider-tool-1",
    tool: "fs.write",
    argumentsHash: hashCanonical("ralph.tool.arguments.v1", argumentsRedacted),
    argumentsRedacted,
    idempotencyKey: HASH_A,
    risk: "write",
    status: "requested",
    effects: [],
    recovery: "reconcile-by-precondition",
    requestedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

const authorization: ToolAuthorization = {
  schemaVersion: 1,
  requestId: "permission-1",
  requestHash: HASH_B,
  action: "allow",
  reason: "Policy allows the bounded workspace write",
  auditedOverride: false,
  decidedAt: AUTHORIZED_AT,
}

function successfulSettlement(secret: string): ToolSettlement {
  return {
    schemaVersion: 1,
    toolCallId: "tool-call-1",
    outcome: "success",
    content: { message: `wrote ${secret}` },
    outputRefs: [`artifact:${secret}`],
    effects: [
      {
        path: "src/feature.ts",
        kind: "modified",
        beforeSha256: null,
        afterSha256: HASH_C,
      },
    ],
    durationMs: 10,
    retryable: false,
    recovery: "effect-confirmed",
    settledAt: SETTLED_AT,
  }
}

describe("durable ToolJournal adapter", () => {
  test("persists intent first, settles redacted output, and returns an idempotent duplicate", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    seedExecutionScope(layout.ledger)
    const secret = "adapter-secret-canary"
    const releaseSecrets = registerLedgerRedactionSecrets(layout.ledger, [secret])
    try {
      const persistence = createSqliteToolCallJournal(layout.ledger)
      const adapter = new DurableToolJournal({
        journal: persistence,
        scope,
        initialToolCallsUsed: 0,
        secretValues: [secret],
      })

      const reserved = await adapter.reserve({ record: candidate(), maximumToolCalls: 4 })
      expect(reserved.status).toBe("reserved")
      const intent = persistence.getIntent("tool-call-1")
      expect(intent).toMatchObject({
        id: "tool-call-1",
        authorization: "asked",
        effectClass: "workspace-write",
        recoveryStrategy: "verify-preconditions",
      })
      expect(intent?.idempotencyKey).not.toBe(HASH_A)
      expect(persistence.getSettlement("tool-call-1")).toBeUndefined()

      await adapter.authorize("tool-call-1", authorization)
      await adapter.start("tool-call-1", STARTED_AT)
      const settled = await adapter.settle("tool-call-1", successfulSettlement(secret))
      expect(settled.status).toBe("settled")
      expect(JSON.stringify(persistence.getSettlement("tool-call-1"))).not.toContain(secret)

      const restarted = new DurableToolJournal({
        journal: createSqliteToolCallJournal(layout.ledger),
        scope,
        initialToolCallsUsed: 1,
        secretValues: [secret],
      })
      const duplicate = await restarted.reserve({
        record: candidate({ id: "local-retry-id" }),
        maximumToolCalls: 4,
      })
      expect(duplicate.status).toBe("duplicate")
      if (duplicate.status !== "duplicate") throw new Error("Expected a duplicate")
      expect(duplicate.record.id).toBe("tool-call-1")
      expect(duplicate.record.status).toBe("settled")
      expect(duplicate.settlement?.outcome).toBe("success")
      expect(JSON.stringify(duplicate.settlement)).not.toContain(secret)
      expect(JSON.stringify(duplicate.settlement)).toContain("[REDACTED]")

      const changedArguments = { path: "src/feature.ts", content: "different" }
      await expect(
        restarted.reserve({
          record: candidate({
            id: "conflicting-local-id",
            argumentsRedacted: changedArguments,
            argumentsHash: hashCanonical("ralph.tool.arguments.v1", changedArguments),
          }),
          maximumToolCalls: 4,
        }),
      ).rejects.toMatchObject({ code: "RALPH_TOOL_CALL_IDEMPOTENCY_CONFLICT" })
    } finally {
      releaseSecrets()
    }
  })

  test("classifies a durable intent without settlement as unsettled after restart", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    seedExecutionScope(layout.ledger)
    const persistence = createSqliteToolCallJournal(layout.ledger)
    const firstProcess = new DurableToolJournal({
      journal: persistence,
      scope,
      initialToolCallsUsed: 0,
    })
    const unfinished = candidate({
      id: "tool-call-unfinished",
      providerToolCallId: "provider-tool-unfinished",
    })
    expect(await firstProcess.reserve({ record: unfinished, maximumToolCalls: 2 })).toMatchObject({
      status: "reserved",
    })

    const restarted = new DurableToolJournal({
      journal: createSqliteToolCallJournal(layout.ledger),
      scope,
      initialToolCallsUsed: 1,
    })
    const duplicate = await restarted.reserve({
      record: candidate({
        id: "another-local-id",
        providerToolCallId: "provider-tool-unfinished",
      }),
      maximumToolCalls: 2,
    })
    expect(duplicate).toMatchObject({
      status: "duplicate",
      record: {
        id: "tool-call-unfinished",
        status: "unsettled",
        recovery: "reconcile-by-precondition",
      },
    })
    if (duplicate.status !== "duplicate") throw new Error("Expected a duplicate")
    expect(duplicate.settlement).toBeUndefined()
    expect(await restarted.listUnsettled(scope.attemptId)).toMatchObject([
      { id: "tool-call-unfinished", status: "unsettled" },
    ])

    const budgeted = await restarted.reserve({
      record: candidate({ id: "third", providerToolCallId: "provider-tool-3" }),
      maximumToolCalls: 1,
    })
    expect(budgeted).toEqual({ status: "budget-exhausted" })
    expect(persistence.getByProviderIdentity("model-call-tools", "provider-tool-3")).toBeUndefined()
  })
})
