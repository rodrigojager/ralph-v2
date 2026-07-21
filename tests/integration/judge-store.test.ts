import { Database } from "bun:sqlite"
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { type JudgeAssessment, JudgeAssessmentSchema } from "@ralph/domain"
import {
  ATTEMPT_EFFECTIVE_OPTIONS_MIGRATION_SQL,
  createJudgeCall,
  EVIDENCE_STORE_MIGRATION_SQL,
  EXECUTION_HARDENING_MIGRATION_SQL,
  finishJudgeCall,
  getJudgeAssessmentForAttempt,
  INITIAL_MIGRATION_SQL,
  initializeLedger,
  JUDGE_ASSESSMENT_MIGRATION_SQL,
  listJudgeAssessments,
  MODEL_CALL_CONTEXT_MIGRATION_SQL,
  ORCHESTRATION_MIGRATION_SQL,
  persistJudgeAssessment,
  readEvents,
  TOOL_CALL_JOURNAL_MIGRATION_SQL,
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
const CURRENT_LEDGER_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

const temporaryDirectories: string[] = []

// A complete legacy-ledger migration can cross Bun's five-second default on
// a saturated hosted Windows runner. Production migration guards remain
// unchanged; this is only the outer test-runner scheduling envelope.
setDefaultTimeout(60_000)

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

type SeedAttempt = {
  attemptId: string
  evidenceId: string
  documentId: string
  taskId: string
  ordinal: number
}

function seedExecutionScope(path: string, attempts: readonly SeedAttempt[]): void {
  withLedger(path, (database) =>
    database.transaction(() => {
      database
        .query(
          `INSERT INTO runs(
             id, schema_version, workspace_id, root_prd_id, root_prd_file,
             definition_hash, graph_hash, mode, status, effective_options_hash,
             effective_options_json, created_at, updated_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?, 'once', 'running', ?, ?, ?, ?)`,
        )
        .run(
          "run-judge",
          "workspace-judge",
          "root-prd",
          "PRD.md",
          HASH_A,
          HASH_B,
          HASH_C,
          JSON.stringify({ contentHash: HASH_C }),
          NOW,
          NOW,
        )
      for (const attempt of attempts) {
        database
          .query(
            `INSERT INTO attempts(
               id, run_id, document_id, task_id, ordinal, phase, status,
               context_manifest_hash, baseline_json, effective_options_hash,
               effective_options_json, counters_json, started_at, updated_at
             ) VALUES (?, 'run-judge', ?, ?, ?, 'judgment', 'active', ?, '{}', ?, ?, '{}', ?, ?)`,
          )
          .run(
            attempt.attemptId,
            attempt.documentId,
            attempt.taskId,
            attempt.ordinal,
            HASH_A,
            HASH_C,
            JSON.stringify({ contentHash: HASH_C }),
            NOW,
            NOW,
          )
        database
          .query(
            `INSERT INTO evidence_bundles(
               id, attempt_id, content_hash, bundle_json, created_at, schema_version
             ) VALUES (?, ?, ?, '{}', ?, 2)`,
          )
          .run(attempt.evidenceId, attempt.attemptId, HASH_A, NOW)
      }
    })(),
  )
}

function assessment(input: {
  id: string
  evidenceBundleId: string
  score: number
  createdAt?: string
  kind?: "external" | "self"
}): JudgeAssessment {
  const kind = input.kind ?? "external"
  return JudgeAssessmentSchema.parse({
    schemaVersion: 1,
    id: input.id,
    kind,
    profileSnapshot: {
      id: kind === "external" ? "judge-profile" : "executor-profile",
      role: kind === "external" ? "judge" : "executor",
      backend: "fake",
      provider: "fake",
      model: "judge-model",
      contentHash: HASH_B,
    },
    evidenceBundleId: input.evidenceBundleId,
    score: input.score,
    summary: `Assessment ${input.score}`,
    adequate: input.score >= 85 ? ["The bounded evidence is adequate."] : [],
    problems: [],
    missingEvidence: [],
    recommendations: input.score >= 85 ? [] : ["Revise the incomplete behavior."],
    criterionScores: [{ criterion: "criterion-1", score: input.score }],
    confidence: 0.9,
    createdAt: input.createdAt ?? NOW,
  })
}

function completeCall(
  path: string,
  input: {
    id: string
    attemptId: string
    ordinal: number
    kind?: "external" | "self"
  },
): void {
  createJudgeCall(path, {
    id: input.id,
    attemptId: input.attemptId,
    ordinal: input.ordinal,
    transportOrdinal: input.ordinal - 1,
    kind: input.kind ?? "external",
    profileId: input.kind === "self" ? "executor-profile" : "judge-profile",
    backendId: "fake-judge",
    requestHash: HASH_A,
    startedAt: NOW,
  })
  finishJudgeCall(path, { id: input.id, status: "succeeded", finishedAt: LATER })
}

describe("judge assessment persistence", () => {
  test("upgrades a populated v7 ledger additively and installs guarded v8 tables", async () => {
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
        [6, "tool-call-journal", TOOL_CALL_JOURNAL_MIGRATION_SQL],
        [7, "evidence-store", EVIDENCE_STORE_MIGRATION_SQL],
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
    await initializeLedger(layout)

    const state = withLedger(layout.ledger, (ledger) => ({
      versions: ledger
        .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => row.version),
      callColumns: ledger
        .query<{ name: string }, []>("PRAGMA table_info(judge_calls)")
        .all()
        .map((row) => row.name),
      assessmentColumns: ledger
        .query<{ name: string }, []>("PRAGMA table_info(judge_assessments)")
        .all()
        .map((row) => row.name),
      triggers: ledger
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'judge_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name),
    }))
    expect(state.versions).toEqual(CURRENT_LEDGER_VERSIONS)
    expect(state.callColumns).toContain("schema_version")
    expect(state.assessmentColumns).toContain("schema_version")
    expect(state.triggers).toEqual(
      expect.arrayContaining([
        "judge_calls_transition_guard",
        "judge_calls_immutable_delete",
        "judge_assessments_scope_guard",
        "judge_assessments_json_guard",
        "judge_assessments_immutable_update",
        "judge_assessments_immutable_delete",
      ]),
    )
    expect(await Bun.file(`${layout.migrations}/0008-judge-assessment.sql`).text()).toBe(
      JUDGE_ASSESSMENT_MIGRATION_SQL,
    )
  })

  test("persists calls and assessments idempotently while rejecting conflicting replays", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    seedExecutionScope(layout.ledger, [
      {
        attemptId: "attempt-1",
        evidenceId: "evidence-1",
        documentId: "root-prd",
        taskId: "slice-one",
        ordinal: 1,
      },
    ])

    const callInput = {
      id: "judge-call-1",
      attemptId: "attempt-1",
      ordinal: 1,
      transportOrdinal: 0,
      kind: "external" as const,
      profileId: "judge-profile",
      backendId: "fake-judge",
      requestHash: HASH_A,
      startedAt: NOW,
    }
    const created = createJudgeCall(layout.ledger, callInput)
    expect(created.schemaVersion).toBe(1)
    expect(createJudgeCall(layout.ledger, callInput)).toEqual(created)
    expect(() => createJudgeCall(layout.ledger, { ...callInput, requestHash: HASH_B })).toThrow(
      "different immutable data",
    )

    const finished = finishJudgeCall(layout.ledger, {
      id: callInput.id,
      status: "succeeded",
      finishedAt: LATER,
    })
    expect(
      finishJudgeCall(layout.ledger, {
        id: callInput.id,
        status: "succeeded",
        finishedAt: LATER,
      }),
    ).toEqual(finished)
    expect(() =>
      finishJudgeCall(layout.ledger, {
        id: callInput.id,
        status: "succeeded",
        finishedAt: LATEST,
      }),
    ).toThrow("immutable result")
    expect(() =>
      finishJudgeCall(layout.ledger, {
        id: callInput.id,
        status: "succeeded",
        errorMessage: "unexpected",
      }),
    ).toThrow("cannot persist an error")

    createJudgeCall(layout.ledger, {
      ...callInput,
      id: "judge-call-failed",
      ordinal: 2,
      transportOrdinal: 1,
      requestHash: HASH_B,
    })
    const boundedFailure = finishJudgeCall(layout.ledger, {
      id: "judge-call-failed",
      status: "failed",
      errorMessage: "x".repeat(70_000),
      finishedAt: LATER,
    })
    expect(boundedFailure.errorMessage?.length).toBeLessThanOrEqual(65_536)
    expect(boundedFailure.errorMessage).toEndWith("[truncated]")

    const value = assessment({ id: "assessment-1", evidenceBundleId: "evidence-1", score: 88 })
    const persisted = persistJudgeAssessment(layout.ledger, {
      attemptId: "attempt-1",
      judgeCallId: callInput.id,
      assessment: value,
      contentRef: ".ralph/runs/run-judge/raw/judge-call-1.json",
    })
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      id: "assessment-1",
      score: 88,
      assessment: value,
    })
    expect(
      persistJudgeAssessment(layout.ledger, {
        attemptId: "attempt-1",
        judgeCallId: callInput.id,
        assessment: value,
        contentRef: ".ralph/runs/run-judge/raw/judge-call-1.json",
      }),
    ).toEqual(persisted)
    expect(() =>
      persistJudgeAssessment(layout.ledger, {
        attemptId: "attempt-1",
        judgeCallId: callInput.id,
        assessment: assessment({
          id: "assessment-1",
          evidenceBundleId: "evidence-1",
          score: 91,
        }),
        contentRef: ".ralph/runs/run-judge/raw/judge-call-1.json",
      }),
    ).toThrow("different immutable data")
    expect(() =>
      persistJudgeAssessment(layout.ledger, {
        attemptId: "attempt-1",
        judgeCallId: callInput.id,
        assessment: value,
        contentRef: "\u0000invalid",
      }),
    ).toThrow("content reference is invalid")

    expect(
      readEvents(layout.ledger).filter(
        (event) => event.type === "judge.call.started" && event.callId === callInput.id,
      ),
    ).toHaveLength(1)
    expect(
      readEvents(layout.ledger).filter((event) => event.type === "judge.assessment.persisted"),
    ).toHaveLength(1)
  })

  test("enforces database immutability and attempt/evidence/call scope", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    seedExecutionScope(layout.ledger, [
      {
        attemptId: "attempt-1",
        evidenceId: "evidence-1",
        documentId: "root-prd",
        taskId: "slice-one",
        ordinal: 1,
      },
      {
        attemptId: "attempt-2",
        evidenceId: "evidence-2",
        documentId: "root-prd",
        taskId: "slice-one",
        ordinal: 2,
      },
    ])
    completeCall(layout.ledger, { id: "judge-call-1", attemptId: "attempt-1", ordinal: 1 })
    completeCall(layout.ledger, { id: "judge-call-2", attemptId: "attempt-2", ordinal: 1 })
    const value = assessment({ id: "assessment-1", evidenceBundleId: "evidence-1", score: 88 })
    persistJudgeAssessment(layout.ledger, {
      attemptId: "attempt-1",
      judgeCallId: "judge-call-1",
      assessment: value,
    })

    expect(() =>
      withLedger(layout.ledger, (database) =>
        database.query("UPDATE judge_assessments SET score = 1 WHERE id = ?").run("assessment-1"),
      ),
    ).toThrow("append-only")
    expect(() =>
      withLedger(layout.ledger, (database) =>
        database.query("DELETE FROM judge_assessments WHERE id = ?").run("assessment-1"),
      ),
    ).toThrow("append-only")
    expect(() =>
      withLedger(layout.ledger, (database) =>
        database
          .query("UPDATE judge_calls SET error_message = 'changed' WHERE id = ?")
          .run("judge-call-1"),
      ),
    ).toThrow("invalid or immutable")
    expect(() =>
      withLedger(layout.ledger, (database) =>
        database.query("DELETE FROM judge_calls WHERE id = ?").run("judge-call-1"),
      ),
    ).toThrow("durable")

    const mismatched = assessment({
      id: "assessment-mismatch",
      evidenceBundleId: "evidence-2",
      score: 75,
    })
    expect(() =>
      withLedger(layout.ledger, (database) =>
        database
          .query(
            `INSERT INTO judge_assessments(
               id, schema_version, attempt_id, evidence_bundle_id, judge_call_id,
               kind, score, content_hash, assessment_json, created_at
             ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            mismatched.id,
            "attempt-1",
            mismatched.evidenceBundleId,
            "judge-call-1",
            mismatched.kind,
            mismatched.score,
            HASH_A,
            JSON.stringify(mismatched),
            mismatched.createdAt,
          ),
      ),
    ).toThrow("scope mismatch")
    const fractional = assessment({
      id: "assessment-fractional",
      evidenceBundleId: "evidence-2",
      score: 75,
    })
    expect(() =>
      withLedger(layout.ledger, (database) =>
        database
          .query(
            `INSERT INTO judge_assessments(
               id, schema_version, attempt_id, evidence_bundle_id, judge_call_id,
               kind, score, content_hash, assessment_json, created_at
             ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            fractional.id,
            "attempt-2",
            fractional.evidenceBundleId,
            "judge-call-2",
            fractional.kind,
            75.5,
            HASH_A,
            JSON.stringify({ ...fractional, score: 75.5 }),
            fractional.createdAt,
          ),
      ),
    ).toThrow()
  })

  test("lists assessments deterministically and restores them by attempt for resume", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    const attempts: SeedAttempt[] = [
      {
        attemptId: "attempt-1",
        evidenceId: "evidence-1",
        documentId: "doc-a",
        taskId: "slice-a",
        ordinal: 1,
      },
      {
        attemptId: "attempt-2",
        evidenceId: "evidence-2",
        documentId: "doc-a",
        taskId: "slice-a",
        ordinal: 2,
      },
      {
        attemptId: "attempt-3",
        evidenceId: "evidence-3",
        documentId: "doc-b",
        taskId: "slice-b",
        ordinal: 1,
      },
    ]
    seedExecutionScope(layout.ledger, attempts)
    for (const [index, attempt] of attempts.entries()) {
      const callId = `judge-call-${index + 1}`
      completeCall(layout.ledger, {
        id: callId,
        attemptId: attempt.attemptId,
        ordinal: 1,
      })
      persistJudgeAssessment(layout.ledger, {
        attemptId: attempt.attemptId,
        judgeCallId: callId,
        assessment: assessment({
          id: `assessment-${index + 1}`,
          evidenceBundleId: attempt.evidenceId,
          score: 80 + index,
          createdAt: [NOW, NOW, LATER][index] ?? NOW,
        }),
      })
    }

    expect(
      listJudgeAssessments(layout.ledger, { runId: "run-judge" }).map((item) => item.id),
    ).toEqual(["assessment-1", "assessment-3", "assessment-2"])
    expect(
      listJudgeAssessments(layout.ledger, { runId: "run-judge", documentId: "doc-a" }).map(
        (item) => item.id,
      ),
    ).toEqual(["assessment-1", "assessment-2"])
    expect(
      listJudgeAssessments(layout.ledger, { runId: "run-judge", taskId: "slice-b" }).map(
        (item) => item.id,
      ),
    ).toEqual(["assessment-3"])
    expect(getJudgeAssessmentForAttempt(layout.ledger, "attempt-2")).toMatchObject({
      id: "assessment-2",
      attemptId: "attempt-2",
      evidenceBundleId: "evidence-2",
    })
    expect(getJudgeAssessmentForAttempt(layout.ledger, "attempt-missing")).toBeUndefined()
  })
})
