import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { cp } from "node:fs/promises"
import { resolve } from "node:path"
import { executeCli } from "@ralph-next/commands"
import { ContextAssessmentFeedbackSchema, type JudgeOutput } from "@ralph-next/domain"
import type { JudgeBackend, JudgeEventSink, JudgeRequest } from "@ralph-next/evaluation"
import {
  effectiveJudgeRevisionMaximum,
  executeRun,
  grantJudgeRevisionAttempts,
  type RunOptionOverrides,
  resolveEffectiveRunOptions,
} from "@ralph-next/orchestration"
import {
  initializeWorkspace,
  listAttempts,
  listJudgeAssessments,
  listRuns,
  listRunTasks,
  readEvents,
  registerLedgerRedactionSecrets,
  workspaceLayout,
} from "@ralph-next/persistence"
import { compilePrdGraph } from "@ralph-next/prd"
import { ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

// Recovery scenarios execute multiple durable runs and judge turns. This
// envelope prevents hosted Windows scheduling pressure from aborting them;
// command-owned production deadlines are asserted independently.
setDefaultTimeout(60_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

class SequenceJudgeBackend implements JudgeBackend {
  readonly id = "recovery-fixture-judge"
  readonly requests: JudgeRequest[] = []
  readonly #outputs: JudgeOutput[]

  constructor(outputs: readonly JudgeOutput[]) {
    this.#outputs = [...outputs]
  }

  capabilities() {
    return {
      streaming: false,
      cancellation: true,
      structuredOutput: true,
      usage: "unavailable" as const,
      toolCalling: "unavailable" as const,
      mutationMode: "read-only" as const,
    }
  }

  async start(request: JudgeRequest, _sink: JudgeEventSink) {
    this.requests.push(request)
    const output = this.#outputs.shift()
    if (!output) throw new Error("Recovery fixture judge has no remaining output")
    return {
      id: request.callId,
      outcome: Promise.resolve(output),
      rawResponseRef: Promise.resolve(`raw:recovery:${request.callId}`),
    }
  }

  async cancel() {}
}

function assessment(score: number): JudgeOutput {
  return {
    schemaVersion: 1,
    score,
    summary: `Recovery fixture score ${score}`,
    adequate: score >= 85 ? ["The vertical slice is accepted"] : [],
    problems:
      score >= 85
        ? []
        : [
            {
              severity: "major",
              criterion: "c1",
              message: "One more bounded revision is required",
              evidenceRefs: [],
            },
          ],
    missingEvidence: score >= 85 ? [] : ["Evidence from the next revision"],
    recommendations: score >= 85 ? [] : ["Apply the prior assessment feedback"],
    criterionScores: [{ criterion: "c1", score }],
    confidence: 0.95,
  }
}

async function fixtureWorkspace(): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await cp(resolve("tests", "fixtures", "execution", "single-pass"), root, {
    recursive: true,
  })
  await initializeWorkspace(root, "0.1.0-test")
  return root
}

async function executionOptions(root: string, cli: RunOptionOverrides) {
  const compiled = await compilePrdGraph(resolve(root, "PRD.md"), {
    workspaceRoot: root,
    recursive: true,
    strict: true,
  })
  expect(compiled.ok).toBeTrue()
  const graph = compiled.graph
  if (!graph) throw new Error("Recovery fixture graph did not compile")
  const reference = graph.topologicalOrder[0]
  if (!reference) throw new Error("Recovery fixture graph has no task")
  const document = graph.documents[reference.documentId]
  const task = document?.tasks.find((candidate) => candidate.id === reference.taskId)
  if (!document || !task) throw new Error("Recovery fixture task is missing")
  return resolveEffectiveRunOptions({ document, task, cli }).options
}

describe("audit-ready judge revision recovery", () => {
  test("manual-review grant reopens and resumes the same run with prior feedback", async () => {
    const root = await fixtureWorkspace()
    const cli: RunOptionOverrides = {
      mode: "once",
      evaluationMode: "external",
      judgeProfile: "fixture-judge",
      judgeThreshold: 85,
      maxRevisionAttempts: 1,
      judgeExhaustedPolicy: "manual-review",
      noChangePolicy: "require-change",
    }
    const options = await executionOptions(root, cli)
    const executor = new ScriptedExecutionBackend([
      {
        expectedTask: "single-pass/deliver-capability",
        actions: [{ type: "write", path: "product/capability.txt", content: "delivered" }],
      },
      {
        expectedTask: "single-pass/deliver-capability",
        actions: [
          {
            type: "write",
            path: "product/revision-one.txt",
            content: "first judge feedback addressed",
          },
        ],
      },
      {
        expectedTask: "single-pass/deliver-capability",
        actions: [
          {
            type: "write",
            path: "product/revision-two.txt",
            content: "manual review feedback addressed",
          },
        ],
      },
    ])
    const judge = new SequenceJudgeBackend([assessment(60), assessment(70), assessment(88)])
    const dependencies = {
      resolveBackend: (profile: string) => (profile === "fixture-executor" ? executor : undefined),
      resolveJudge: (profile: string) => (profile === "fixture-judge" ? judge : undefined),
      sleep: async () => undefined,
    }

    const first = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      optionResolution: { cli },
      dependencies,
    })
    expect(first).toMatchObject({ status: "waiting", exitCode: 5 })

    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    if (!run) throw new Error("Recovery fixture run was not persisted")
    expect(listRunTasks(layout.ledger, run.id)[0]?.status).toBe("blocked")

    const review = await executeCli(
      [
        "review",
        "retry",
        "--run-id",
        run.id,
        "--task",
        "single-pass/deliver-capability",
        "--additional-revisions",
        "1",
        "--reason",
        "Manual reviewer authorized one bounded correction",
      ],
      { version: "0.1.0-test", cwd: root, environment: {} },
    )
    expect(review.exitCode).toBe(0)
    expect(review.execution.result).toMatchObject({
      ok: true,
      command: "review.retry",
      data: {
        runId: run.id,
        task: { documentId: "single-pass", taskId: "deliver-capability" },
        receipt: {
          schemaVersion: 1,
          previousMaximum: 1,
          additionalRevisions: 1,
          effectiveMaximum: 2,
          source: "cli",
          previousTaskStatus: "blocked",
          taskStatus: "eligible",
          idempotent: false,
        },
      },
    })
    expect(review.execution.human).toContain("Revisions: +1 (1 -> 2)")
    expect(review.execution.human).toContain("Status:    eligible")
    expect(review.execution.human).toContain(`resume the same run with --run-id`)
    expect(listRunTasks(layout.ledger, run.id)[0]?.status).toBe("eligible")
    expect(listRuns(layout.ledger, { limit: 1 })[0]?.status).toBe("waiting")
    expect(
      readEvents(layout.ledger).filter((event) => event.type === "evaluation.revisions.extended"),
    ).toHaveLength(1)
    expect(
      effectiveJudgeRevisionMaximum({
        baseMaximum: 1,
        events: readEvents(layout.ledger),
        scope: {
          runId: run.id,
          documentId: "single-pass",
          taskId: "deliver-capability",
        },
      }),
    ).toBe(2)
    const waitingStatus = await executeCli(["status", "run", "--run-id", run.id], {
      version: "0.1.0-test",
      cwd: root,
      environment: {},
    })
    expect(waitingStatus.execution.human).toContain("Revisions: 1/2")

    const resumed = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      runId: run.id,
      effectiveOptions: options,
      optionResolution: { cli },
      dependencies,
    })
    expect(resumed).toMatchObject({ status: "completed", exitCode: 0, runId: run.id })
    expect(listRuns(layout.ledger)).toHaveLength(1)
    expect(listRunTasks(layout.ledger, run.id)[0]?.status).toBe("completed")

    const attempts = listAttempts(layout.ledger, { runId: run.id })
    expect(attempts.map((attempt) => attempt.ordinal)).toEqual([1, 2, 3])
    expect(attempts.map((attempt) => attempt.counters.revisionAttempts)).toEqual([0, 1, 1])
    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected", "passed"])
    const assessments = listJudgeAssessments(layout.ledger, { runId: run.id })
    expect(assessments.map((record) => record.score)).toEqual([60, 70, 88])
    const recoveredRevisionRequest = executor.requests()[2]
    expect(recoveredRevisionRequest?.contextManifest.previousAssessmentRef).toBe(
      assessments[1]?.contentRef,
    )
    const recoveredFeedbackResource = recoveredRevisionRequest?.contextBundle.resources.find(
      (resource) => resource.kind === "assessment",
    )
    expect(
      recoveredFeedbackResource
        ? ContextAssessmentFeedbackSchema.parse(JSON.parse(recoveredFeedbackResource.content))
        : undefined,
    ).toMatchObject({
      sourceAssessmentId: assessments[1]?.id,
      sourceEvidenceBundleId: assessments[1]?.evidenceBundleId,
      score: 70,
      threshold: 85,
      recommendations: ["Apply the prior assessment feedback"],
    })
    const eventTypes = readEvents(layout.ledger).map((event) => event.type)
    expect(eventTypes).toContain("task.revision_recovery.eligible")
    expect(eventTypes.filter((type) => type === "evaluation.revisions.exhausted")).toHaveLength(1)
  })

  test("grant validates inputs and rejects non-idempotent or conflicting repeats", async () => {
    const root = await fixtureWorkspace()
    const cli: RunOptionOverrides = {
      mode: "once",
      evaluationMode: "external",
      judgeProfile: "fixture-judge",
      judgeThreshold: 85,
      maxRevisionAttempts: 0,
      judgeExhaustedPolicy: "manual-review",
      noChangePolicy: "require-change",
    }
    const options = await executionOptions(root, cli)
    const executor = new ScriptedExecutionBackend([
      {
        expectedTask: "single-pass/deliver-capability",
        actions: [{ type: "write", path: "product/capability.txt", content: "delivered" }],
      },
    ])
    const judge = new SequenceJudgeBackend([assessment(60)])
    await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      optionResolution: { cli },
      dependencies: {
        resolveBackend: () => executor,
        resolveJudge: () => judge,
        sleep: async () => undefined,
      },
    })
    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    if (!run) throw new Error("Recovery rejection fixture run was not persisted")
    const base = {
      ledger: layout.ledger,
      runId: run.id,
      documentId: "single-pass",
      taskId: "deliver-capability",
      source: "api" as const,
    }

    expect(() =>
      grantJudgeRevisionAttempts({ ...base, additionalRevisions: 0, reason: "invalid" }),
    ).toThrow("additionalRevisions must be a positive safe integer")
    expect(() =>
      grantJudgeRevisionAttempts({
        ...base,
        additionalRevisions: Number.MAX_SAFE_INTEGER + 1,
        reason: "invalid",
      }),
    ).toThrow("additionalRevisions must be a positive safe integer")
    expect(() =>
      grantJudgeRevisionAttempts({ ...base, additionalRevisions: 1, reason: "   " }),
    ).toThrow("non-empty recovery reason")

    const secret = "recovery-secret-value"
    const releaseRedaction = registerLedgerRedactionSecrets(layout.ledger, [secret])
    try {
      grantJudgeRevisionAttempts({
        ...base,
        additionalRevisions: 1,
        reason: `Explicit API recovery authorized by ${secret}`,
        requestId: "api-recovery-1",
      })
    } finally {
      releaseRedaction()
    }
    const extension = readEvents(layout.ledger).find(
      (event) => event.type === "evaluation.revisions.extended",
    )
    expect(JSON.stringify(extension?.payload)).not.toContain(secret)
    expect(extension?.payload.reason).toContain("[REDACTED]")
    expect(
      grantJudgeRevisionAttempts({
        ...base,
        additionalRevisions: 1,
        reason: `Explicit API recovery authorized by ${secret}`,
        requestId: "api-recovery-1",
      }).idempotent,
    ).toBeTrue()
    expect(() =>
      grantJudgeRevisionAttempts({
        ...base,
        additionalRevisions: 2,
        reason: `Explicit API recovery authorized by ${secret}`,
        requestId: "api-recovery-1",
      }),
    ).toThrow("requestId was already used with different")
    expect(() =>
      grantJudgeRevisionAttempts({
        ...base,
        additionalRevisions: 1,
        reason: "A second grant without a new exhaustion",
      }),
    ).toThrow("task must be blocked")
  })
})
