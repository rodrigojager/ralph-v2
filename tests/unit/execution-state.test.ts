import { describe, expect, test } from "bun:test"
import {
  ArtifactEvidenceSchema,
  ATTEMPT_PHASE_TRANSITIONS,
  ATTEMPT_STATUS_TRANSITIONS,
  AttemptCountersSchema,
  type AttemptPhase,
  AttemptPhaseSchema,
  type AttemptRecord,
  AttemptRecordSchema,
  type AttemptStatus,
  AttemptStatusSchema,
  ChangeEvidenceSchema,
  CompletionDecisionSchema,
  CompletionOverrideAuditSchema,
  ContextManifestSchema,
  canTransitionAttemptPhase,
  canTransitionAttemptStatus,
  canTransitionRunStatus,
  canTransitionTaskRuntimeStatus,
  completeTask,
  completeTaskWithOverride,
  EffectiveRunOptionsSchema,
  EvidenceBundleSchema,
  EvidencePersistenceReceiptSchema,
  ExecutionReportSchema,
  ExecutorOutcomeSchema,
  GateResultSchema,
  GitBaselineSchema,
  NoChangePolicySchema,
  normalizeNoChangePolicy,
  RUN_STATUS_TRANSITIONS,
  type RunRecord,
  RunRecordSchema,
  type RunStatus,
  RunStatusSchema,
  TASK_RUNTIME_STATUS_TRANSITIONS,
  TaskCompletionAuthorizationSchema,
  TaskExecutionReportSchema,
  TaskOverrideCompletionAuthorizationSchema,
  type TaskRecord,
  TaskRecordSchema,
  type TaskRuntimeStatus,
  TaskRuntimeStatusSchema,
  transitionAttemptPhase,
  transitionAttemptStatus,
  transitionRunStatus,
  transitionTaskRuntimeStatus,
} from "@ralph-next/domain"

const NOW = "2026-07-18T12:00:00.000Z"
const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)
const HASH_C = "c".repeat(64)
const HASH_D = "d".repeat(64)
const HASH_E = "e".repeat(64)

const counters = AttemptCountersSchema.parse({
  modelCalls: 1,
  toolCalls: 2,
  wiggumIterations: 3,
  executorRetries: 4,
  watchdogRestarts: 9,
  judgeTransportRetries: 5,
  revisionAttempts: 6,
  noChangeAttempts: 7,
  gateRuns: 8,
})

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

const changeEvidence = ChangeEvidenceSchema.parse({
  schemaVersion: 1,
  policy: "require-change",
  status: "changed",
  files: [
    {
      path: "src/feature.ts",
      kind: "modified",
      contentHash: HASH_B,
      sizeBytes: 42,
    },
  ],
  outsideScopePaths: [],
  reproducible: true,
  missingContent: [],
  diffHash: HASH_C,
  diffRef: "evidence/diff.patch",
  attemptDiffHash: HASH_D,
  attemptDiffRef: "evidence/attempt-diff.patch",
})

const artifact = ArtifactEvidenceSchema.parse({
  artifactId: "delivery-proof",
  path: "artifacts/proof.json",
  contentHash: HASH_D,
  sizeBytes: 20,
  immutableRef: "runs/run-1/artifacts/sha256/proof",
  status: "passed",
})

const blockingGate = GateResultSchema.parse({
  gateId: "contract-test",
  category: "test",
  blocking: true,
  status: "passed",
  command: {
    executable: "bun",
    args: ["test"],
    cwd: ".",
    timeoutMs: 30_000,
    successExitCodes: [0],
    outputLimitBytes: 64_000,
  },
  exitCode: 0,
  durationMs: 120,
  outputRefs: ["outputs/contract-test.stdout"],
})

const nonBlockingFailedGate = GateResultSchema.parse({
  gateId: "advisory-lint",
  category: "lint",
  blocking: false,
  status: "failed",
  exitCode: 1,
  durationMs: 30,
  outputRefs: [],
  reason: "Advisory only",
})

const skippedBlockingGate = GateResultSchema.parse({
  gateId: "contract-test",
  category: "test",
  blocking: true,
  status: "skipped_by_cli",
  durationMs: 0,
  outputRefs: [],
  reason: "Required gate skipped with an explicit forced CLI override.",
})

const executorOutcome = ExecutorOutcomeSchema.parse({
  schemaVersion: 1,
  status: "work_submitted",
  summary: "Implemented the requested vertical slice.",
  intendedFiles: ["src/feature.ts"],
  artifactRefs: ["delivery-proof"],
  suggestedVerifications: ["contract-test"],
  risks: [],
  reportedAt: NOW,
})

const contextManifest = ContextManifestSchema.parse({
  schemaVersion: 1,
  id: "context-1",
  runId: "run-1",
  attemptId: "attempt-1",
  mode: "once",
  sharedContext: "Shared contract context for the current document.",
  task: {
    documentId: "root-prd",
    taskId: "vertical-slice",
    title: "Deliver the vertical slice",
    result: "The user observes a complete increment.",
    criteria: [{ id: "c1", text: "The observable flow works end to end." }],
    boundaries: ["Do not choose a project stack."],
    evidenceMode: "criteria",
    verificationRefs: ["contract-test"],
    taskSpecHash: HASH_B,
  },
  invariants: ["Only Ralph can complete the task."],
  parentContextRefs: [],
  dependencyOutputs: [{ taskId: "dependency", outputRefs: ["contracts/api.json"] }],
  declaredFileRefs: ["src/feature.ts"],
  baseline,
  budget: {
    remainingModelCalls: 2,
    remainingToolCalls: 10,
    remainingIterations: 1,
  },
  authority: {
    taskSelection: "ralph",
    taskCompletion: "ralph-policy",
    subPrdCreation: "preauthored-only",
  },
  createdAt: NOW,
  contentHash: HASH_C,
})

const evidence = EvidenceBundleSchema.parse({
  schemaVersion: 1,
  id: "evidence-1",
  runId: "run-1",
  documentId: "root-prd",
  taskId: "vertical-slice",
  attemptId: "attempt-1",
  taskSpecHash: HASH_B,
  baseline,
  changes: changeEvidence,
  artifacts: [artifact],
  gates: [blockingGate, nonBlockingFailedGate],
  executorOutcome,
  contextManifestHash: contextManifest.contentHash,
  createdAt: NOW,
  contentHash: HASH_D,
})

const decision = CompletionDecisionSchema.parse({
  status: "passed",
  deterministicPassed: true,
  evaluationMode: "none",
  evidenceBundleId: evidence.id,
  reasons: ["Material change and blocking verification passed."],
  decidedBy: "ralph-policy",
  decidedAt: NOW,
})

const persistence = EvidencePersistenceReceiptSchema.parse({
  schemaVersion: 1,
  evidenceBundleId: evidence.id,
  contentHash: evidence.contentHash,
  persistedAt: NOW,
})

const authorization = TaskCompletionAuthorizationSchema.parse({
  decision,
  evidence,
  persistence,
})

const skippedBlockingEvidence = EvidenceBundleSchema.parse({
  ...evidence,
  gates: [skippedBlockingGate],
})

const overrideDecision = CompletionDecisionSchema.parse({
  ...decision,
  status: "overridden",
  deterministicPassed: false,
  evidenceBundleId: skippedBlockingEvidence.id,
  reasons: ["A forced required-gate override was explicitly authorized."],
})

const overrideAudit = CompletionOverrideAuditSchema.parse({
  schemaVersion: 1,
  eventId: "event-override-1",
  source: "cli",
  force: true,
  reason: "Operator accepted the known blocking gate failure.",
  overriddenGateIds: ["contract-test"],
  recordedAt: NOW,
})

const overrideAuthorization = TaskOverrideCompletionAuthorizationSchema.parse({
  decision: overrideDecision,
  evidence: skippedBlockingEvidence,
  persistence,
  audit: overrideAudit,
})

const effectiveOptions = EffectiveRunOptionsSchema.parse({
  schemaVersion: 1,
  mode: { value: "once", source: "cli", sourceRef: "--once" },
  executorProfile: { value: "fake-executor", source: "profile", sourceRef: "test-kit" },
  task: { value: null, source: "builtin" },
  force: { value: false, source: "builtin" },
  dryRun: { value: false, source: "builtin" },
  skipTests: { value: false, source: "builtin" },
  skipLint: { value: false, source: "builtin" },
  skipGates: { value: [], source: "builtin" },
  fast: { value: false, source: "builtin" },
  noCommit: { value: true, source: "workspace", sourceRef: "config.yaml" },
  failFast: { value: true, source: "cli", sourceRef: "--fail-fast" },
  maxTasks: { value: 1, source: "builtin" },
  delayMs: { value: 0, source: "builtin" },
  maxIterations: { value: 1, source: "builtin" },
  maxModelCallsPerAttempt: { value: 2, source: "task", sourceRef: "vertical-slice" },
  maxNoChangeAttempts: { value: 1, source: "workspace", sourceRef: "config.yaml" },
  noChangePolicy: {
    ...normalizeNoChangePolicy("fallback"),
    source: "workspace",
    sourceRef: "config.yaml",
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

function runRecord(status: RunStatus): RunRecord {
  return RunRecordSchema.parse({
    schemaVersion: 1,
    id: "run-1",
    workspaceId: "workspace-1",
    rootPrdId: "root-prd",
    rootPrdFile: "PRD.md",
    definitionHash: HASH_A,
    graphHash: HASH_B,
    mode: "once",
    status,
    effectiveOptionsHash: effectiveOptions.contentHash,
    effectiveOptions,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

function taskRecord(status: TaskRuntimeStatus): TaskRecord {
  return TaskRecordSchema.parse({
    runId: "run-1",
    taskId: "vertical-slice",
    documentId: "root-prd",
    status,
    markerContentHash: HASH_A,
    activeAttemptId: "attempt-1",
    updatedAt: NOW,
  })
}

function attemptRecord(phase: AttemptPhase, status: AttemptStatus): AttemptRecord {
  return AttemptRecordSchema.parse({
    id: "attempt-1",
    runId: "run-1",
    documentId: "root-prd",
    taskId: "vertical-slice",
    ordinal: 1,
    phase,
    status,
    baseline,
    contextManifestHash: contextManifest.contentHash,
    effectiveOptionsHash: effectiveOptions.contentHash,
    effectiveOptions,
    counters,
    startedAt: NOW,
    updatedAt: NOW,
  })
}

const taskReport = TaskExecutionReportSchema.parse({
  taskId: "vertical-slice",
  documentId: "root-prd",
  status: "evaluating",
  attemptIds: ["attempt-1"],
  executorOutcome,
})

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
  tasks: [taskReport],
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
    gateRuns: 2,
    noChangeAttempts: 0,
  },
  reasons: [],
  createdAt: NOW,
  contentHash: HASH_A,
})

function caughtCode(action: () => unknown): string | undefined {
  try {
    action()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe("S03 execution schemas", () => {
  test("exports exact closed status vocabularies and immutable transition matrices", () => {
    expect(RunStatusSchema.options).toEqual([
      "created",
      "running",
      "stopping",
      "interrupted",
      "waiting",
      "completed",
      "failed",
      "cancelled",
    ])
    expect(TaskRuntimeStatusSchema.options).toEqual([
      "pending",
      "eligible",
      "active",
      "verifying",
      "evaluating",
      "retryable_failed",
      "interrupted",
      "blocked",
      "rejected",
      "cancelled",
      "completed",
      "completed_with_override",
    ])
    expect(AttemptPhaseSchema.options).toEqual([
      "created",
      "preparing",
      "invoking",
      "tools",
      "settling",
      "evidence",
      "gates",
      "judgment",
      "decision",
    ])
    expect(AttemptStatusSchema.options).toEqual([
      "active",
      "passed",
      "failed",
      "interrupted",
      "rejected",
    ])
    expect(Object.keys(RUN_STATUS_TRANSITIONS)).toEqual(RunStatusSchema.options)
    expect(Object.keys(TASK_RUNTIME_STATUS_TRANSITIONS)).toEqual(TaskRuntimeStatusSchema.options)
    expect(Object.keys(ATTEMPT_PHASE_TRANSITIONS)).toEqual(AttemptPhaseSchema.options)
    expect(Object.keys(ATTEMPT_STATUS_TRANSITIONS)).toEqual(AttemptStatusSchema.options)
    expect(Object.isFrozen(RUN_STATUS_TRANSITIONS)).toBeTrue()
    expect(Object.values(RUN_STATUS_TRANSITIONS).every(Object.isFrozen)).toBeTrue()
  })

  test("keeps every attempt counter distinct, required and non-negative", () => {
    expect(counters).toEqual({
      modelCalls: 1,
      toolCalls: 2,
      wiggumIterations: 3,
      executorRetries: 4,
      watchdogRestarts: 9,
      judgeTransportRetries: 5,
      revisionAttempts: 6,
      noChangeAttempts: 7,
      gateRuns: 8,
    })
    expect(
      AttemptCountersSchema.safeParse({ ...counters, noChangeAttempts: -1 }).success,
    ).toBeFalse()
    expect(AttemptCountersSchema.parse({ ...counters, watchdogRestarts: undefined })).toMatchObject(
      {
        watchdogRestarts: 0,
      },
    )
    expect(report.counters.watchdogRestarts).toBe(0)
    const { gateRuns: _removed, ...missingCounter } = counters
    expect(AttemptCountersSchema.safeParse(missingCounter).success).toBeFalse()
  })

  test("binds every attempt to its immutable effective options snapshot", () => {
    const attempt = attemptRecord("created", "active")
    expect(attempt.effectiveOptionsHash).toBe(effectiveOptions.contentHash)
    expect(attempt.effectiveOptions).toEqual(effectiveOptions)
    expect(
      AttemptRecordSchema.safeParse({ ...attempt, effectiveOptionsHash: HASH_A }).success,
    ).toBeFalse()
  })

  test("normalizes only the four canonical policies and ADR 0006 aliases with provenance", () => {
    expect(NoChangePolicySchema.options).toEqual([
      "require-change",
      "allow-no-change",
      "fail-on-no-change",
      "retry-on-no-change",
    ])
    for (const value of NoChangePolicySchema.options) {
      expect(normalizeNoChangePolicy(value)).toEqual({ value, original: value })
    }
    expect(normalizeNoChangePolicy("retry")).toMatchObject({
      value: "retry-on-no-change",
      original: "retry",
      notice: expect.stringContaining("retry"),
    })
    expect(normalizeNoChangePolicy("fail-fast")).toMatchObject({
      value: "fail-on-no-change",
      original: "fail-fast",
      notice: expect.stringContaining("fail-fast"),
    })
    expect(normalizeNoChangePolicy("fallback")).toMatchObject({
      value: "retry-on-no-change",
      original: "fallback",
      notice: expect.stringContaining("does not switch provider or model"),
    })
    expect(caughtCode(() => normalizeNoChangePolicy("invented"))).toBe(
      "RALPH_NO_CHANGE_POLICY_INVALID",
    )
  })

  test("accepts the minimum S03 records and rejects additive producer fields", () => {
    const cases: Array<{
      name: string
      schema: { safeParse: (value: unknown) => { success: boolean } }
      value: Record<string, unknown>
    }> = [
      { name: "effective options", schema: EffectiveRunOptionsSchema, value: effectiveOptions },
      { name: "baseline", schema: GitBaselineSchema, value: baseline },
      { name: "change", schema: ChangeEvidenceSchema, value: changeEvidence },
      { name: "artifact", schema: ArtifactEvidenceSchema, value: artifact },
      { name: "gate", schema: GateResultSchema, value: blockingGate },
      { name: "outcome", schema: ExecutorOutcomeSchema, value: executorOutcome },
      { name: "context", schema: ContextManifestSchema, value: contextManifest },
      { name: "evidence", schema: EvidenceBundleSchema, value: evidence },
      { name: "decision", schema: CompletionDecisionSchema, value: decision },
      { name: "receipt", schema: EvidencePersistenceReceiptSchema, value: persistence },
      { name: "authorization", schema: TaskCompletionAuthorizationSchema, value: authorization },
      { name: "override audit", schema: CompletionOverrideAuditSchema, value: overrideAudit },
      {
        name: "override authorization",
        schema: TaskOverrideCompletionAuthorizationSchema,
        value: overrideAuthorization,
      },
      { name: "run", schema: RunRecordSchema, value: runRecord("created") },
      { name: "task", schema: TaskRecordSchema, value: taskRecord("active") },
      {
        name: "attempt",
        schema: AttemptRecordSchema,
        value: attemptRecord("created", "active"),
      },
      { name: "task report", schema: TaskExecutionReportSchema, value: taskReport },
      { name: "report", schema: ExecutionReportSchema, value: report },
    ]

    for (const entry of cases) {
      expect(entry.schema.safeParse(entry.value).success, entry.name).toBeTrue()
      expect(
        entry.schema.safeParse({ ...entry.value, futureProducerField: true }).success,
        entry.name,
      ).toBeFalse()
    }
  })

  test("requires missing content details exactly when change evidence is not reproducible", () => {
    expect(
      ChangeEvidenceSchema.safeParse({
        ...changeEvidence,
        reproducible: false,
        missingContent: [],
      }).success,
    ).toBeFalse()
    expect(
      ChangeEvidenceSchema.safeParse({
        ...changeEvidence,
        reproducible: false,
        missingContent: [
          {
            path: ".git/config",
            side: "after",
            reason: "control-plane content is hash-only",
          },
        ],
      }).success,
    ).toBeTrue()
  })

  test("keeps ExecutorOutcome an allegation with no completion vocabulary", () => {
    expect(
      ExecutorOutcomeSchema.safeParse({ ...executorOutcome, status: "completed" }).success,
    ).toBeFalse()
    expect(
      ContextManifestSchema.safeParse({
        ...contextManifest,
        authority: { ...contextManifest.authority, taskCompletion: "executor" },
      }).success,
    ).toBeFalse()
  })

  test("requires stable run identities and bounded full-PRD context for wiggum", () => {
    expect(runRecord("created")).toMatchObject({
      rootPrdFile: "PRD.md",
      definitionHash: HASH_A,
      graphHash: HASH_B,
    })
    expect(
      ContextManifestSchema.safeParse({ ...contextManifest, mode: "wiggum" }).success,
    ).toBeFalse()
    expect(
      ContextManifestSchema.safeParse({
        ...contextManifest,
        mode: "wiggum",
        fullPrd: { ref: "contexts/root-prd.md", contentHash: HASH_E },
      }).success,
    ).toBeTrue()
    expect(effectiveOptions.executorProfile).toEqual({
      value: "fake-executor",
      source: "profile",
      sourceRef: "test-kit",
    })
  })
})

describe("closed S03 state transitions", () => {
  test("exhaustively enforces every run status pair", () => {
    for (const from of RunStatusSchema.options) {
      for (const to of RunStatusSchema.options) {
        const allowed = RUN_STATUS_TRANSITIONS[from].includes(to)
        expect(canTransitionRunStatus(from, to), `${from} -> ${to}`).toBe(allowed)
        const original = runRecord(from)
        if (allowed) {
          expect(transitionRunStatus(original, to).status, `${from} -> ${to}`).toBe(to)
          expect(original.status).toBe(from)
        } else {
          expect(
            caughtCode(() => transitionRunStatus(original, to)),
            `${from} -> ${to}`,
          ).toBe("RALPH_RUN_STATUS_TRANSITION_INVALID")
        }
      }
    }
  })

  test("exhaustively enforces every task status pair and reserves completion authority", () => {
    for (const from of TaskRuntimeStatusSchema.options) {
      for (const to of TaskRuntimeStatusSchema.options) {
        const allowed = TASK_RUNTIME_STATUS_TRANSITIONS[from].includes(to)
        expect(canTransitionTaskRuntimeStatus(from, to), `${from} -> ${to}`).toBe(allowed)
        const original = taskRecord(from)
        const completionTarget = to === "completed" || to === "completed_with_override"
        if (!allowed) {
          expect(
            caughtCode(() => transitionTaskRuntimeStatus(original, to)),
            `${from} -> ${to}`,
          ).toBe("RALPH_TASK_STATUS_TRANSITION_INVALID")
        } else if (completionTarget) {
          expect(
            caughtCode(() => transitionTaskRuntimeStatus(original, to)),
            `${from} -> ${to}`,
          ).toBe("RALPH_TASK_COMPLETION_AUTHORITY_REQUIRED")
        } else {
          expect(transitionTaskRuntimeStatus(original, to).status, `${from} -> ${to}`).toBe(to)
          expect(original.status).toBe(from)
        }
      }
    }
  })

  test("exhaustively enforces every active attempt phase pair", () => {
    for (const from of AttemptPhaseSchema.options) {
      for (const to of AttemptPhaseSchema.options) {
        const allowed = ATTEMPT_PHASE_TRANSITIONS[from].includes(to)
        expect(canTransitionAttemptPhase(from, to), `${from} -> ${to}`).toBe(allowed)
        const original = attemptRecord(from, "active")
        if (allowed) {
          expect(transitionAttemptPhase(original, to).phase, `${from} -> ${to}`).toBe(to)
          expect(original.phase).toBe(from)
        } else {
          expect(
            caughtCode(() => transitionAttemptPhase(original, to)),
            `${from} -> ${to}`,
          ).toBe("RALPH_ATTEMPT_PHASE_TRANSITION_INVALID")
        }
      }
    }
    expect(
      caughtCode(() => transitionAttemptPhase(attemptRecord("decision", "passed"), "created")),
    ).toBe("RALPH_ATTEMPT_PHASE_TERMINAL")
  })

  test("exhaustively enforces every attempt status pair", () => {
    for (const from of AttemptStatusSchema.options) {
      for (const to of AttemptStatusSchema.options) {
        const allowed = ATTEMPT_STATUS_TRANSITIONS[from].includes(to)
        expect(canTransitionAttemptStatus(from, to), `${from} -> ${to}`).toBe(allowed)
        const original = attemptRecord("decision", from)
        if (allowed) {
          expect(transitionAttemptStatus(original, to).status, `${from} -> ${to}`).toBe(to)
          expect(original.status).toBe(from)
        } else {
          expect(
            caughtCode(() => transitionAttemptStatus(original, to)),
            `${from} -> ${to}`,
          ).toBe("RALPH_ATTEMPT_STATUS_TRANSITION_INVALID")
        }
      }
    }
  })
})

describe("authoritative task completion guard", () => {
  test("completes only from evaluating with passed decision, persisted evidence and passed blockers", () => {
    const original = taskRecord("evaluating")
    const completed = completeTask(original, authorization)

    expect(completed).toMatchObject({
      runId: original.runId,
      taskId: original.taskId,
      status: "completed",
      completion: decision,
    })
    expect(completed.activeAttemptId).toBeUndefined()
    expect(original).toMatchObject({ status: "evaluating", activeAttemptId: "attempt-1" })
  })

  test("never accepts ExecutorOutcome or a direct transition as completion authority", () => {
    const task = taskRecord("evaluating")
    expect(caughtCode(() => transitionTaskRuntimeStatus(task, "completed"))).toBe(
      "RALPH_TASK_COMPLETION_AUTHORITY_REQUIRED",
    )
    expect(() => completeTask(task, executorOutcome as never)).toThrow()
    expect(task.status).toBe("evaluating")
  })

  test("rejects every non-passed decision and deterministic failure", () => {
    for (const status of CompletionDecisionSchema.shape.status.options.filter(
      (candidate) => candidate !== "passed",
    )) {
      expect(
        caughtCode(() =>
          completeTask(taskRecord("evaluating"), {
            ...authorization,
            decision: { ...decision, status },
          }),
        ),
        status,
      ).toBe("RALPH_TASK_COMPLETION_DECISION_NOT_PASSED")
    }
    expect(
      caughtCode(() =>
        completeTask(taskRecord("evaluating"), {
          ...authorization,
          decision: { ...decision, deterministicPassed: false },
        }),
      ),
    ).toBe("RALPH_TASK_COMPLETION_DECISION_NOT_PASSED")
  })

  test("rejects missing/mismatched persistence and task-attempt evidence", () => {
    expect(
      caughtCode(() =>
        completeTask(taskRecord("evaluating"), {
          ...authorization,
          persistence: { ...persistence, contentHash: HASH_E },
        }),
      ),
    ).toBe("RALPH_TASK_COMPLETION_EVIDENCE_NOT_PERSISTED")

    expect(
      caughtCode(() =>
        completeTask(taskRecord("evaluating"), {
          ...authorization,
          evidence: { ...evidence, attemptId: "attempt-other" },
        }),
      ),
    ).toBe("RALPH_TASK_COMPLETION_CONTEXT_MISMATCH")

    expect(
      caughtCode(() =>
        completeTask(taskRecord("evaluating"), {
          ...authorization,
          evidence: { ...evidence, documentId: "other-document" },
        }),
      ),
    ).toBe("RALPH_TASK_COMPLETION_CONTEXT_MISMATCH")

    expect(
      caughtCode(() =>
        completeTask(taskRecord("evaluating"), {
          ...authorization,
          decision: { ...decision, evidenceBundleId: "evidence-other" },
        }),
      ),
    ).toBe("RALPH_TASK_COMPLETION_EVIDENCE_MISMATCH")
  })

  test("rejects non-reproducible evidence even if a producer claims deterministic pass", () => {
    const nonReproducibleEvidence = EvidenceBundleSchema.parse({
      ...evidence,
      changes: {
        ...changeEvidence,
        reproducible: false,
        missingContent: [
          {
            path: ".git/hooks/pre-commit",
            side: "after",
            reason: "control-plane content is hash-only",
          },
        ],
      },
    })

    expect(
      caughtCode(() =>
        completeTask(taskRecord("evaluating"), {
          ...authorization,
          evidence: nonReproducibleEvidence,
        }),
      ),
    ).toBe("RALPH_TASK_COMPLETION_EVIDENCE_NOT_REPRODUCIBLE")
    expect(
      caughtCode(() =>
        completeTaskWithOverride(taskRecord("evaluating"), {
          ...overrideAuthorization,
          evidence: EvidenceBundleSchema.parse({
            ...skippedBlockingEvidence,
            changes: nonReproducibleEvidence.changes,
          }),
        }),
      ),
    ).toBe("RALPH_TASK_COMPLETION_EVIDENCE_NOT_REPRODUCIBLE")
  })

  test("rejects every non-passed blocking gate but ignores non-blocking failure", () => {
    for (const status of GateResultSchema.shape.status.options.filter(
      (candidate) => candidate !== "passed",
    )) {
      expect(
        caughtCode(() =>
          completeTask(taskRecord("evaluating"), {
            ...authorization,
            evidence: {
              ...evidence,
              gates: [{ ...blockingGate, status }, nonBlockingFailedGate],
            },
          }),
        ),
        status,
      ).toBe("RALPH_TASK_COMPLETION_BLOCKING_GATE_NOT_PASSED")
    }

    expect(
      completeTask(taskRecord("evaluating"), {
        ...authorization,
        evidence: { ...evidence, gates: [nonBlockingFailedGate] },
      }).status,
    ).toBe("completed")
  })

  test("rejects score below threshold or failed severity rules", () => {
    expect(
      caughtCode(() =>
        completeTask(taskRecord("evaluating"), {
          ...authorization,
          decision: { ...decision, score: 79, threshold: 80 },
        }),
      ),
    ).toBe("RALPH_TASK_COMPLETION_EVALUATION_NOT_PASSED")
    expect(
      caughtCode(() =>
        completeTask(taskRecord("evaluating"), {
          ...authorization,
          decision: { ...decision, severityRulesPassed: false },
        }),
      ),
    ).toBe("RALPH_TASK_COMPLETION_EVALUATION_NOT_PASSED")
  })

  test("supports only an explicitly audited override path to completed_with_override", () => {
    const original = taskRecord("evaluating")
    const completed = completeTaskWithOverride(original, overrideAuthorization)

    expect(completed).toMatchObject({
      status: "completed_with_override",
      completion: { status: "overridden", evidenceBundleId: evidence.id },
    })
    expect(completed.activeAttemptId).toBeUndefined()
    expect(original.status).toBe("evaluating")

    expect(
      caughtCode(() =>
        completeTaskWithOverride(taskRecord("evaluating"), {
          ...overrideAuthorization,
          audit: { ...overrideAudit, overriddenGateIds: [] },
        }),
      ),
    ).toBe("RALPH_TASK_OVERRIDE_AUDIT_MISMATCH")
    expect(
      caughtCode(() =>
        completeTaskWithOverride(taskRecord("evaluating"), {
          ...overrideAuthorization,
          decision,
        }),
      ),
    ).toBe("RALPH_TASK_OVERRIDE_DECISION_REQUIRED")
    expect(
      caughtCode(() =>
        completeTaskWithOverride(taskRecord("evaluating"), {
          ...overrideAuthorization,
          evidence: {
            ...skippedBlockingEvidence,
            gates: [{ ...blockingGate, status: "failed", exitCode: 1 }],
          },
        }),
      ),
    ).toBe("RALPH_TASK_OVERRIDE_BLOCKING_GATE_NOT_OVERRIDABLE")
    expect(() =>
      completeTaskWithOverride(taskRecord("evaluating"), executorOutcome as never),
    ).toThrow()
  })
})
