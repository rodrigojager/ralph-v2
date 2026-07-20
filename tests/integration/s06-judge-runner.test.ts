import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { executeCli } from "@ralph-next/commands"
import { ContextAssessmentFeedbackSchema, type JudgeOutput } from "@ralph-next/domain"
import type { JudgeBackend, JudgeEventSink, JudgeRequest } from "@ralph-next/evaluation"
import {
  type ExecuteRunInput,
  type ExecutionBackend,
  executeRun,
  type RunOptionOverrides,
  resolveEffectiveRunOptions,
} from "@ralph-next/orchestration"
import {
  getEvidenceBundle,
  initializeWorkspace,
  listAttempts,
  listJudgeAssessments,
  listRuns,
  listRunTasks,
  readEvents,
  workspaceLayout,
} from "@ralph-next/persistence"
import { compilePrdGraph } from "@ralph-next/prd"
import { ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { buildRunUiSnapshot } from "../../apps/ralph-cli/src/tui-services"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

// The full Windows quality matrix can spend tens of seconds in filesystem and
// process cleanup while 130+ files share the runner. Individual production
// deadlines remain asserted by their dedicated tests; this runner guard stays
// above the judge fixture's own 60 s task budget.
setDefaultTimeout(120_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

type JudgeStep = JudgeOutput | unknown | Error | ((request: JudgeRequest) => JudgeOutput | unknown)

class SequenceJudgeBackend implements JudgeBackend {
  readonly id = "fake-judge"
  readonly requests: JudgeRequest[] = []
  readonly events: Array<{ callId: string; type: string }> = []
  readonly #steps: JudgeStep[]

  constructor(steps: readonly JudgeStep[]) {
    this.#steps = [...steps]
  }

  capabilities() {
    return {
      streaming: false,
      cancellation: true,
      structuredOutput: true,
      usage: "reported" as const,
      toolCalling: "unavailable" as const,
      mutationMode: "read-only" as const,
    }
  }

  async start(request: JudgeRequest, sink: JudgeEventSink) {
    this.requests.push(request)
    const step = this.#steps.shift()
    if (step === undefined) throw new Error("Fake judge has no remaining response")
    await sink.emit({
      type: "fixture.started",
      level: "info",
      payload: { callId: request.callId },
    })
    this.events.push({ callId: request.callId, type: "fixture.started" })
    await sink.emit({
      type: "model.usage.updated",
      level: "info",
      payload: {
        schemaVersion: 1,
        eventId: `usage-${request.callId}`,
        callId: request.callId,
        sequence: 0,
        timestamp: new Date().toISOString(),
        level: "info",
        synthesized: true,
        type: "model.usage.updated",
        payload: {
          usage: {
            input: 10,
            output: 2,
            total: 12,
            cost: {
              amount: 0.01,
              currency: "USD",
              priceSnapshotId: "fixture-price-v1",
            },
            source: "reported",
            semantics: "final",
            providerRawRef: `raw:${request.callId}`,
          },
        },
      },
    })
    const outcome = Promise.resolve().then(() => {
      if (step instanceof Error) throw step
      return (typeof step === "function" ? step(request) : step) as JudgeOutput
    })
    return {
      id: request.callId,
      outcome,
      rawResponseRef: Promise.resolve(`raw:judge:${request.callId}`),
    }
  }

  async cancel() {}

  remaining(): number {
    return this.#steps.length
  }
}

function assessmentOutput(score: number, summary = `Fixture judge score ${score}`): JudgeOutput {
  return {
    schemaVersion: 1,
    score,
    summary,
    adequate: score >= 85 ? ["The deterministic delivery is connected and verified"] : [],
    problems:
      score >= 85
        ? []
        : [
            {
              severity: "major",
              criterion: "c1",
              message: "The delivery needs one bounded revision",
              evidenceRefs: [],
            },
          ],
    missingEvidence: score >= 85 ? [] : ["Evidence from the requested revision"],
    recommendations: score >= 85 ? [] : ["Apply the judge feedback and submit fresh evidence"],
    criterionScores: [{ criterion: "c1", score }],
    confidence: 0.9,
  }
}

async function fixtureWorkspace(): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await cp(resolve("tests", "fixtures", "execution", "single-pass"), root, {
    recursive: true,
  })
  const prdFile = resolve(root, "PRD.md")
  await writeFile(
    prdFile,
    (await readFile(prdFile, "utf8")).replace("timeout=20s", "timeout=60s"),
    "utf8",
  )
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
  if (!graph) throw new Error("Fixture graph did not compile")
  const reference = graph.topologicalOrder[0]
  if (!reference) throw new Error("Fixture graph has no task")
  const document = graph.documents[reference.documentId]
  const task = document?.tasks.find((candidate) => candidate.id === reference.taskId)
  if (!document || !task) throw new Error("Fixture task is missing")
  return resolveEffectiveRunOptions({ document, task, cli }).options
}

async function runScenario(input: {
  root: string
  cli: RunOptionOverrides
  executor: ExecutionBackend
  judge?: SequenceJudgeBackend
  resolveJudge?: ExecuteRunInput["dependencies"]["resolveJudge"]
}) {
  const effectiveOptions = await executionOptions(input.root, input.cli)
  return executeRun({
    workspaceRoot: input.root,
    prdFile: "PRD.md",
    effectiveOptions,
    optionResolution: { cli: input.cli },
    dependencies: {
      resolveBackend: (profile) => (profile === "fixture-executor" ? input.executor : undefined),
      ...(input.resolveJudge
        ? { resolveJudge: input.resolveJudge }
        : input.judge
          ? {
              resolveJudge: (profile, context) =>
                profile === "fixture-judge" && context.kind === "external"
                  ? input.judge
                  : undefined,
            }
          : {}),
      sleep: async () => undefined,
    },
  })
}

function executorForRevision(): ScriptedExecutionBackend {
  return new ScriptedExecutionBackend([
    {
      expectedTask: "single-pass/deliver-capability",
      actions: [{ type: "write", path: "product/capability.txt", content: "delivered" }],
    },
    {
      expectedTask: "single-pass/deliver-capability",
      actions: [
        {
          type: "write",
          path: "product/revision-note.txt",
          content: "judge feedback addressed",
        },
      ],
    },
  ])
}

function onePassExecutor(): ScriptedExecutionBackend {
  return new ScriptedExecutionBackend([
    {
      expectedTask: "single-pass/deliver-capability",
      actions: [{ type: "write", path: "product/capability.txt", content: "delivered" }],
    },
  ])
}

describe("S06 judge and persisted revision loop", () => {
  test("external score 60 requests one revision and score 88 completes at threshold 85", async () => {
    const root = await fixtureWorkspace()
    const executor = executorForRevision()
    const judge = new SequenceJudgeBackend([assessmentOutput(60), assessmentOutput(88)])
    const result = await runScenario({
      root,
      executor,
      judge,
      cli: {
        mode: "once",
        evaluationMode: "external",
        judgeProfile: "fixture-judge",
        judgeThreshold: 85,
        maxRevisionAttempts: 1,
        noChangePolicy: "require-change",
      },
    })

    expect(result).toMatchObject({ status: "completed", exitCode: 0 })
    expect(executor.remaining()).toBe(0)
    expect(judge.remaining()).toBe(0)
    expect(judge.requests).toHaveLength(2)
    expect(
      judge.requests[0]?.bundle.attachments.some(
        (attachment) => attachment.kind === "diff" && attachment.scope === "attempt",
      ),
    ).toBeTrue()
    expect(
      judge.requests[0]?.bundle.attachments.some(
        (attachment) =>
          attachment.kind === "after-file" &&
          attachment.path === "product/capability.txt" &&
          attachment.text === "delivered",
      ),
    ).toBeTrue()

    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    expect(run).toBeDefined()
    const attempts = listAttempts(layout.ledger, { runId: run?.id as string })
    expect(attempts).toHaveLength(2)
    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "passed"])
    expect(attempts.map((attempt) => attempt.counters.revisionAttempts)).toEqual([0, 1])
    expect(attempts.map((attempt) => attempt.counters.judgeTransportRetries)).toEqual([0, 0])
    expect(result.report?.counters).toMatchObject({
      attempts: 2,
      revisionAttempts: 1,
      judgeTransportRetries: 0,
    })
    expect(result.report?.usage).toMatchObject({
      combined: { source: "unavailable", providerCallCount: 4 },
      executor: { source: "unavailable", providerCallCount: 2 },
      judge: {
        source: "reported",
        input: 20,
        output: 4,
        total: 24,
        providerCallCount: 2,
        cost: { amount: 0.02, currency: "USD" },
      },
      judgeRequested: true,
    })
    const uiSnapshot = buildRunUiSnapshot(root, run?.id as string)
    expect(uiSnapshot).toMatchObject({
      status: "completed",
      progress: { completed: 1, total: 1 },
      usage: {
        combined: {
          available: true,
          source: "reported",
          inputTokens: 20,
          outputTokens: 4,
          totalTokens: 24,
          cost: { amount: 0.02, currency: "USD", source: "reported" },
        },
        executor: { available: false, source: "unavailable" },
        judge: {
          available: true,
          source: "reported",
          inputTokens: 20,
          outputTokens: 4,
          totalTokens: 24,
          cost: { amount: 0.02, currency: "USD", source: "reported" },
        },
      },
      judge: {
        mode: "external",
        profile: "fixture-judge",
        score: 88,
        threshold: 85,
        decision: "accepted",
        feedback: { adequate: ["The deterministic delivery is connected and verified"] },
      },
      evaluationValues: { evaluationMode: "external", judgeThreshold: 85 },
      evaluationOrigins: {
        evaluationMode: "cli (cli:--evaluation/--judge/--no-judge/--self-review)",
        judgeThreshold: "cli (cli:--judge-threshold)",
      },
    })
    expect(uiSnapshot.usage.combined.note).toBe(
      "combined: partial; calls=4; settled=2; unavailable=2",
    )
    expect(uiSnapshot.usage.executor.note).toBe("executor: 2 call(s); 2 without comparable usage")
    expect(uiSnapshot.usage.judge.note).toBe("judge: complete; calls=2; settled=2; unavailable=0")
    const uiUsageCalls = Object.values(uiSnapshot.usageCalls ?? {})
    const executorUsageCalls = uiUsageCalls.filter((call) => call.role === "executor")
    const judgeUsageCalls = uiUsageCalls.filter((call) => call.role === "judge")
    expect(executorUsageCalls).toHaveLength(2)
    expect(
      executorUsageCalls.every(
        (call) =>
          call.source === "unavailable" &&
          call.inputTokens === undefined &&
          call.outputTokens === undefined &&
          call.totalTokens === undefined &&
          call.cost === undefined,
      ),
    ).toBeTrue()
    expect(judgeUsageCalls).toHaveLength(2)
    expect(
      judgeUsageCalls.every(
        (call) =>
          call.source === "reported" &&
          call.settled &&
          call.inputTokens === 10 &&
          call.outputTokens === 2 &&
          call.totalTokens === 12 &&
          call.cost?.amount === 0.01 &&
          call.cost.currency === "USD" &&
          call.cost.source === "reported",
      ),
    ).toBeTrue()
    expect(
      readEvents(layout.ledger).filter((event) => event.type === "judge.attachments.materialized"),
    ).toHaveLength(2)

    const assessments = listJudgeAssessments(layout.ledger, {
      runId: run?.id as string,
      documentId: "single-pass",
      taskId: "deliver-capability",
    })
    expect(assessments.map((record) => record.score)).toEqual([60, 88])
    expect(assessments.map((record) => record.assessment.rawResponseRef)).toEqual(
      judge.requests.map((request) => `raw:judge:${request.callId}`),
    )
    expect(assessments.every((record) => record.contentRef !== undefined)).toBeTrue()
    expect(
      await Promise.all(
        assessments.map((record) => Bun.file(resolve(root, record.contentRef as string)).exists()),
      ),
    ).toEqual([true, true])
    expect(attempts.map((attempt) => attempt.evidenceBundleId)).toEqual(
      assessments.map((record) => record.evidenceBundleId),
    )
    expect(attempts[0]?.completionDecision).toMatchObject({
      status: "revision_required",
      score: 60,
      threshold: 85,
      assessmentId: assessments[0]?.id,
    })
    expect(attempts[1]?.completionDecision).toMatchObject({
      status: "passed",
      score: 88,
      threshold: 85,
      assessmentId: assessments[1]?.id,
    })

    const firstAssessmentRef = assessments[0]?.contentRef
    expect(firstAssessmentRef).toBeDefined()
    if (!firstAssessmentRef) throw new Error("First persisted assessment has no content reference")
    const revisionRequest = executor.requests()[1]
    expect(revisionRequest?.contextManifest.previousAssessmentRef).toBe(firstAssessmentRef)
    expect(revisionRequest?.contextManifest.revisionFeedback).toMatchObject({
      kind: "assessment",
      sourceAssessmentRef: firstAssessmentRef,
      sourceAssessmentId: assessments[0]?.id,
      sourceEvidenceBundleId: assessments[0]?.evidenceBundleId,
      score: 60,
      threshold: 85,
      truncated: false,
    })
    const feedbackResource = revisionRequest?.contextBundle.resources.find(
      (resource) => resource.kind === "assessment",
    )
    expect(feedbackResource).toBeDefined()
    if (!feedbackResource || !revisionRequest?.contextManifest.revisionFeedback) {
      throw new Error("Revision request has no structured assessment resource")
    }
    const feedback = ContextAssessmentFeedbackSchema.parse(JSON.parse(feedbackResource.content))
    expect(feedback).toMatchObject({
      sourceAssessmentRef: firstAssessmentRef,
      sourceAssessmentId: assessments[0]?.id,
      sourceEvidenceBundleId: assessments[0]?.evidenceBundleId,
      sourceKind: "external",
      score: 60,
      threshold: 85,
      summary: "Fixture judge score 60",
      recommendations: ["Apply the judge feedback and submit fresh evidence"],
    })
    expect(feedbackResource.ref).toBe(revisionRequest.contextManifest.revisionFeedback.ref)
    expect(feedbackResource.contentHash).toBe(
      revisionRequest.contextManifest.revisionFeedback.contentHash,
    )
    expect(createHash("sha256").update(feedbackResource.content).digest("hex")).toBe(
      revisionRequest.contextManifest.revisionFeedback.includedHash,
    )
    expect(feedbackResource.content).not.toContain("profileSnapshot")
    expect(feedbackResource.content).not.toContain("credential")
    expect(feedbackResource.content).not.toContain("rawResponseRef")
    const secondEvidence = attempts[1]
      ? getEvidenceBundle(layout.ledger, attempts[1].id)?.bundle
      : undefined
    expect(secondEvidence?.schemaVersion).toBe(2)
    if (secondEvidence?.schemaVersion === 2) {
      expect(secondEvidence.context.previousAssessmentRef).toBe(firstAssessmentRef)
      expect(secondEvidence.priorAssessments).toContainEqual({
        kind: "external",
        ref: firstAssessmentRef,
      })
    }
    expect(listRunTasks(layout.ledger, run?.id as string)[0]).toMatchObject({
      status: "completed",
      completion: { score: 88, threshold: 85, assessmentId: assessments[1]?.id },
    })
    const humanReport = await executeCli(["report", "show", run?.id as string], {
      version: "0.1.0-test",
      cwd: root,
      environment: {},
    })
    expect(humanReport.exitCode).toBe(0)
    expect(humanReport.execution.human).toContain("external score=60/100")
    expect(humanReport.execution.human).toContain("external score=88/100")
    expect(humanReport.execution.human).toContain("Adequate:")
    expect(humanReport.execution.human).toContain("Problem:")
    expect(humanReport.execution.human).toContain("Missing:")
    expect(humanReport.execution.human).toContain("Recommend:")
    expect(humanReport.execution.human).toContain("Total usage: unavailable")
    expect(humanReport.execution.human).toContain("Executor usage: unavailable")
    expect(humanReport.execution.human).toContain("Judge usage: total=24")
    expect(humanReport.execution.human).toContain("cost=0.02 USD")
    const humanStatus = await executeCli(["status", "run", "--run-id", run?.id as string], {
      version: "0.1.0-test",
      cwd: root,
      environment: {},
    })
    expect(humanStatus.exitCode).toBe(0)
    expect(humanStatus.execution.human).toContain("Progress: 1/1 [########################]")
    expect(humanStatus.execution.human).toContain("Judge:    external profile=fixture-judge")
    expect(humanStatus.execution.human).toContain("Revisions: 1/1")
    expect(humanStatus.execution.human).toContain("external score=88/100")
    expect(humanStatus.execution.human).toContain("Total usage: unavailable")
    expect(humanStatus.execution.human).toContain("Judge usage: total=24")
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [x] **deliver-capability")
  })

  test("manual-review exhaustion keeps the task incomplete and awaiting explicit review", async () => {
    const root = await fixtureWorkspace()
    const executor = executorForRevision()
    const judge = new SequenceJudgeBackend([assessmentOutput(60), assessmentOutput(70)])
    const result = await runScenario({
      root,
      executor,
      judge,
      cli: {
        mode: "once",
        evaluationMode: "external",
        judgeProfile: "fixture-judge",
        judgeThreshold: 85,
        maxRevisionAttempts: 1,
        judgeExhaustedPolicy: "manual-review",
        noChangePolicy: "require-change",
      },
    })

    expect(result).toMatchObject({ status: "waiting", exitCode: 5 })
    expect(result.reason).toContain("revision budget exhausted (1)")
    expect(executor.remaining()).toBe(0)
    expect(judge.requests).toHaveLength(2)

    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    const attempts = listAttempts(layout.ledger, { runId: run?.id as string })
    const assessments = listJudgeAssessments(layout.ledger, { runId: run?.id as string })
    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"])
    expect(attempts.map((attempt) => attempt.counters.revisionAttempts)).toEqual([0, 1])
    expect(assessments.map((record) => record.score)).toEqual([60, 70])
    expect(result.report?.counters.revisionAttempts).toBe(1)
    expect(listRunTasks(layout.ledger, run?.id as string)[0]).toMatchObject({ status: "blocked" })
    expect(readEvents(layout.ledger).map((event) => event.type)).toContain(
      "evaluation.revisions.exhausted",
    )
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [~] **deliver-capability")
  })

  for (const scenario of [
    {
      policy: "fail" as const,
      failFast: true,
      status: "failed",
      exitCode: 4,
      taskStatus: "rejected",
      event: "task.revision_budget_failed",
    },
    {
      policy: "stop-run" as const,
      failFast: false,
      status: "interrupted",
      exitCode: 9,
      taskStatus: "retryable_failed",
      event: "task.revision_budget_stopped",
    },
  ] as const) {
    test(`revision exhaustion policy ${scenario.policy} has a distinct terminal settlement`, async () => {
      const root = await fixtureWorkspace()
      const result = await runScenario({
        root,
        executor: executorForRevision(),
        judge: new SequenceJudgeBackend([assessmentOutput(60), assessmentOutput(70)]),
        cli: {
          mode: "once",
          evaluationMode: "external",
          judgeProfile: "fixture-judge",
          judgeThreshold: 85,
          maxRevisionAttempts: 1,
          judgeExhaustedPolicy: scenario.policy,
          failFast: scenario.failFast,
          noChangePolicy: "require-change",
        },
      })

      expect(result).toMatchObject({ status: scenario.status, exitCode: scenario.exitCode })
      const layout = workspaceLayout(root)
      const run = listRuns(layout.ledger, { limit: 1 })[0]
      expect(listRunTasks(layout.ledger, run?.id as string)[0]?.status).toBe(scenario.taskStatus)
      expect(result.report?.counters).toMatchObject({ revisionAttempts: 1, attempts: 2 })
      expect(readEvents(layout.ledger).map((event) => event.type)).toContain(scenario.event)
      expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain(
        "- [~] **deliver-capability",
      )
    })
  }

  test("malformed output and a transport failure use judge retries without consuming revisions", async () => {
    const root = await fixtureWorkspace()
    const executor = onePassExecutor()
    const judge = new SequenceJudgeBackend([
      { schemaVersion: 1, score: 120 },
      new Error("fixture transport unavailable"),
      assessmentOutput(90),
    ])
    const result = await runScenario({
      root,
      executor,
      judge,
      cli: {
        mode: "once",
        evaluationMode: "external",
        judgeProfile: "fixture-judge",
        judgeThreshold: 85,
        judgeCallRetries: 2,
        maxRevisionAttempts: 0,
        noChangePolicy: "require-change",
      },
    })

    expect(result).toMatchObject({ status: "completed", exitCode: 0 })
    expect(judge.requests).toHaveLength(3)
    expect(judge.requests[0]?.prompt.user).not.toContain("Retry repair instruction")
    expect(judge.requests[1]?.prompt.user).toContain("Retry repair instruction")
    expect(judge.requests[1]?.prompt.user).toContain("score")
    expect(judge.requests[2]?.prompt.user).toContain("fixture transport unavailable")
    expect(new Set(judge.requests.map((request) => request.prompt.user)).size).toBe(3)
    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    const attempt = listAttempts(layout.ledger, { runId: run?.id as string })[0]
    expect(attempt?.counters).toMatchObject({ judgeTransportRetries: 2, revisionAttempts: 0 })
    expect(result.report?.counters).toMatchObject({
      judgeTransportRetries: 2,
      revisionAttempts: 0,
    })
    expect(listJudgeAssessments(layout.ledger, { runId: run?.id as string })).toHaveLength(1)
    const events = readEvents(layout.ledger)
    expect(events.filter((event) => event.type === "judge.call.started")).toHaveLength(3)
    expect(events.filter((event) => event.type === "judge.call.finished")).toHaveLength(3)
    expect(events.filter((event) => event.type === "judge.repair.requested")).toHaveLength(2)
  })

  test("terminally malformed judge output exhausts transport retries without inventing a score", async () => {
    const root = await fixtureWorkspace()
    const judge = new SequenceJudgeBackend([
      { schemaVersion: 1, score: 120 },
      { schemaVersion: 1, score: -1 },
      { schemaVersion: 1, score: 101 },
    ])
    const result = await runScenario({
      root,
      executor: onePassExecutor(),
      judge,
      cli: {
        mode: "once",
        evaluationMode: "external",
        judgeProfile: "fixture-judge",
        judgeCallRetries: 2,
        judgeUnavailablePolicy: "pause",
        maxRevisionAttempts: 0,
        noChangePolicy: "require-change",
      },
    })

    expect(result).toMatchObject({ status: "waiting", exitCode: 5 })
    expect(judge.requests).toHaveLength(3)
    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    const attempt = listAttempts(layout.ledger, { runId: run?.id as string })[0]
    expect(attempt?.counters).toMatchObject({ judgeTransportRetries: 2, revisionAttempts: 0 })
    expect(attempt?.completionDecision).toMatchObject({
      status: "blocked",
      evaluationMode: "external",
    })
    expect(attempt?.completionDecision?.score).toBeUndefined()
    expect(attempt?.completionDecision?.assessmentId).toBeUndefined()
    expect(listJudgeAssessments(layout.ledger, { runId: run?.id as string })).toHaveLength(0)
    expect(
      readEvents(layout.ledger).filter(
        (event) => event.type === "judge.call.finished" && event.payload?.status === "failed",
      ),
    ).toHaveLength(3)
  })

  test("self-review uses a fresh read-only assessment call with the executor profile identity", async () => {
    const root = await fixtureWorkspace()
    const executor = onePassExecutor()
    const judge = new SequenceJudgeBackend([assessmentOutput(92)])
    const result = await runScenario({
      root,
      executor,
      cli: {
        mode: "once",
        evaluationMode: "self",
        judgeThreshold: 85,
        noChangePolicy: "require-change",
      },
      resolveJudge: (profile, context) =>
        profile === "fixture-executor" && context.kind === "self" ? judge : undefined,
    })

    expect(result).toMatchObject({ status: "completed", exitCode: 0 })
    expect(judge.requests).toHaveLength(1)
    expect(judge.requests[0]?.kind).toBe("self")
    expect(judge.requests[0]).not.toHaveProperty("workspaceRoot")
    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    const assessments = listJudgeAssessments(layout.ledger, { runId: run?.id as string })
    expect(assessments).toHaveLength(1)
    expect(assessments[0]?.assessment).toMatchObject({
      kind: "self",
      score: 92,
      profileSnapshot: {
        role: "executor",
        id: "fixture-executor",
      },
    })
    expect(
      listAttempts(layout.ledger, { runId: run?.id as string })[0]?.completionDecision,
    ).toMatchObject({
      status: "passed",
      evaluationMode: "self",
      score: 92,
    })
    expect(buildRunUiSnapshot(root, run?.id as string)).toMatchObject({
      judge: { mode: "self", profile: "fixture-executor", score: 92 },
    })
  })

  for (const scenario of [
    {
      policy: "deterministic" as const,
      runStatus: "completed",
      exitCode: 0,
      taskStatus: "completed",
      decisionStatus: "passed",
      marker: "[x]",
    },
    {
      policy: "pause" as const,
      runStatus: "waiting",
      exitCode: 5,
      taskStatus: "blocked",
      decisionStatus: "blocked",
      marker: "[~]",
    },
    {
      policy: "fail" as const,
      runStatus: "failed",
      exitCode: 4,
      taskStatus: "retryable_failed",
      decisionStatus: "failed",
      marker: "[~]",
    },
  ] as const) {
    test(`judge unavailable policy ${scenario.policy} is explicit and does not invent an assessment`, async () => {
      const root = await fixtureWorkspace()
      const executor = onePassExecutor()
      let resolutions = 0
      const result = await runScenario({
        root,
        executor,
        cli: {
          mode: "once",
          evaluationMode: "external",
          judgeProfile: "fixture-judge",
          judgeUnavailablePolicy: scenario.policy,
          failFast: true,
          noChangePolicy: "require-change",
        },
        resolveJudge: () => {
          resolutions += 1
          return undefined
        },
      })

      expect(result).toMatchObject({ status: scenario.runStatus, exitCode: scenario.exitCode })
      expect(resolutions).toBe(1)
      const layout = workspaceLayout(root)
      const run = listRuns(layout.ledger, { limit: 1 })[0]
      const attempt = listAttempts(layout.ledger, { runId: run?.id as string })[0]
      expect(attempt?.completionDecision).toMatchObject({
        status: scenario.decisionStatus,
        evaluationMode: "external",
      })
      expect(attempt?.completionDecision?.score).toBeUndefined()
      expect(attempt?.completionDecision?.assessmentId).toBeUndefined()
      expect(listJudgeAssessments(layout.ledger, { runId: run?.id as string })).toHaveLength(0)
      expect(listRunTasks(layout.ledger, run?.id as string)[0]?.status).toBe(scenario.taskStatus)
      expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain(
        `- ${scenario.marker} **deliver-capability`,
      )
    })
  }

  test("a failed blocking deterministic gate never invokes or yields to a score-100 judge", async () => {
    const root = await fixtureWorkspace()
    const prdPath = resolve(root, "PRD.md")
    const original = await readFile(prdPath, "utf8")
    const failing = original.replace("!== 'delivered'", "!== 'value-that-is-not-delivered'")
    expect(failing).not.toBe(original)
    await writeFile(prdPath, failing)
    const executor = onePassExecutor()
    const judge = new SequenceJudgeBackend([assessmentOutput(100)])
    const result = await runScenario({
      root,
      executor,
      judge,
      cli: {
        mode: "once",
        evaluationMode: "external",
        judgeProfile: "fixture-judge",
        judgeThreshold: 85,
        failFast: true,
        noChangePolicy: "require-change",
      },
    })

    expect(result).toMatchObject({ status: "failed", exitCode: 4 })
    expect(judge.requests).toHaveLength(0)
    expect(judge.remaining()).toBe(1)
    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    const attempt = listAttempts(layout.ledger, { runId: run?.id as string })[0]
    expect(attempt?.completionDecision).toMatchObject({
      status: "failed",
      deterministicPassed: false,
    })
    expect(attempt?.completionDecision?.score).toBeUndefined()
    expect(listJudgeAssessments(layout.ledger, { runId: run?.id as string })).toHaveLength(0)
  })

  test("deterministic-only completion creates no judge call, assessment, or synthetic score", async () => {
    const root = await fixtureWorkspace()
    const executor = onePassExecutor()
    let judgeResolutions = 0
    const result = await runScenario({
      root,
      executor,
      cli: {
        mode: "once",
        evaluationMode: "deterministic-only",
        judgeProfile: "configured-but-unused",
        noChangePolicy: "require-change",
      },
      resolveJudge: () => {
        judgeResolutions += 1
        return new SequenceJudgeBackend([assessmentOutput(100)])
      },
    })

    expect(result).toMatchObject({ status: "completed", exitCode: 0 })
    expect(judgeResolutions).toBe(0)
    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    const attempt = listAttempts(layout.ledger, { runId: run?.id as string })[0]
    expect(attempt?.completionDecision).toMatchObject({
      status: "passed",
      evaluationMode: "none",
    })
    expect(attempt?.completionDecision?.score).toBeUndefined()
    expect(attempt?.completionDecision?.assessmentId).toBeUndefined()
    expect(listJudgeAssessments(layout.ledger, { runId: run?.id as string })).toHaveLength(0)
    expect(
      readEvents(layout.ledger).filter((event) => event.type.startsWith("judge.")),
    ).toHaveLength(0)
    expect(buildRunUiSnapshot(root, run?.id as string)).toMatchObject({
      judge: { mode: "deterministic-only", score: null },
      usage: { judge: { available: false, source: "unavailable" } },
    })
  })

  test("run report separates reported executor usage from absent judge usage", async () => {
    const root = await fixtureWorkspace()
    const inner = onePassExecutor()
    const backend: ExecutionBackend = {
      id: "usage-fixture-executor",
      capabilities: () => ({
        streaming: true,
        toolCalling: false,
        cancellation: true,
        usage: "reported",
      }),
      async start(request, channel) {
        const handle = await inner.start(request, channel)
        return {
          id: handle.id,
          outcome: handle.outcome.then(async (outcome) => {
            await channel.emit({
              type: "model.usage.updated",
              payload: {
                providerCallId: handle.id,
                usage: {
                  input: 11,
                  output: 3,
                  reasoning: 1,
                  total: 15,
                  cost: {
                    amount: 0.015,
                    currency: "USD",
                    priceSnapshotId: "fixture-executor-price-v1",
                  },
                  source: "reported",
                  semantics: "final",
                  providerRawRef: `raw:executor:${handle.id}`,
                },
              },
            })
            return outcome
          }),
        }
      },
      cancel: (handle, reason) => inner.cancel(handle, reason),
    }
    const result = await runScenario({
      root,
      executor: backend,
      cli: {
        mode: "once",
        evaluationMode: "deterministic-only",
        noChangePolicy: "require-change",
      },
    })

    expect(result).toMatchObject({ status: "completed", exitCode: 0 })
    expect(result.report?.usage).toMatchObject({
      combined: {
        source: "derived",
        input: 11,
        output: 3,
        reasoning: 1,
        total: 15,
        providerCallCount: 1,
        cost: { amount: 0.015, currency: "USD" },
      },
      executor: {
        source: "reported",
        input: 11,
        output: 3,
        reasoning: 1,
        total: 15,
        providerCallCount: 1,
        cost: { amount: 0.015, currency: "USD" },
      },
      judge: { source: "unavailable", providerCallCount: 0 },
      judgeRequested: false,
    })
  })

  test("public CLI completes change-only evidence and reports its semantic caveat", async () => {
    const root = await fixtureWorkspace()
    const prd = resolve(root, "PRD.md")
    await writeFile(
      prd,
      (await readFile(prd, "utf8"))
        .replace("evidence_mode: criteria", "evidence_mode: change-only")
        .replace("Modo de evidência: criteria", "Modo de evidência: change-only"),
    )
    const backend = onePassExecutor()
    const execution = await executeCli(
      [
        "once",
        "--workspace",
        root,
        "--prd",
        "PRD.md",
        "--executor-profile",
        "fixture-executor",
        "--no-change-policy",
        "require-change",
        "--format",
        "json",
      ],
      {
        version: "0.1.0-test",
        cwd: root,
        environment: {},
        resolveBackend: (profile) => (profile === "fixture-executor" ? backend : undefined),
      },
    )
    expect(execution.exitCode).toBe(0)
    expect(execution.execution.result).toMatchObject({
      ok: true,
      command: "once",
      data: {
        status: "completed",
        report: {
          tasks: [
            {
              evidenceCaveats: [expect.stringContaining("not semantic correctness")],
            },
          ],
        },
      },
    })
    const run = listRuns(workspaceLayout(root).ledger, { limit: 1 })[0]
    const report = await executeCli(["report", "show", run?.id as string], {
      version: "0.1.0-test",
      cwd: root,
      environment: {},
    })
    expect(report.exitCode).toBe(0)
    expect(report.execution.human).toContain("Evidence caveat:")
    expect(report.execution.human).toContain("not semantic correctness")
    expect(await readFile(prd, "utf8")).toContain("- [x] **deliver-capability")
  })

  test("public CLI completes an exact named artifact and preserves its immutable evidence", async () => {
    const root = await fixtureWorkspace()
    const prd = resolve(root, "PRD.md")
    await writeFile(
      prd,
      `---
ralph_prd: 2
id: artifact-delivery
title: Named artifact delivery
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: artifact
---

# Named artifact delivery

## Vertical slices

- [ ] **publish-proof — Publish one inspectable proof**
  - Resultado: existe um artefato nomeado e verificável.
  - Dependências: nenhuma
  - Critérios:
    1. O arquivo de prova foi materializado.
  - Verificação:
    - artifact: delivery-proof; path=artifacts/proof.json
  - Limites:
    - Não produzir arquivos não relacionados.
  - Modo de evidência: artifact
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s
`,
    )
    const backend = new ScriptedExecutionBackend([
      {
        expectedTask: "artifact-delivery/publish-proof",
        actions: [{ type: "write", path: "artifacts/proof.json", content: '{"ok":true}' }],
      },
    ])
    const execution = await executeCli(
      [
        "once",
        "--workspace",
        root,
        "--prd",
        "PRD.md",
        "--executor-profile",
        "fixture-executor",
        "--format",
        "json",
      ],
      {
        version: "0.1.0-test",
        cwd: root,
        environment: {},
        resolveBackend: (profile) => (profile === "fixture-executor" ? backend : undefined),
      },
    )

    expect(execution.exitCode).toBe(0)
    expect(execution.execution.result).toMatchObject({
      ok: true,
      data: {
        status: "completed",
        report: {
          tasks: [
            {
              completion: { status: "passed" },
              evidenceCaveats: [expect.stringContaining("Artifact existence")],
            },
          ],
        },
      },
    })
    const run = listRuns(workspaceLayout(root).ledger, { limit: 1 })[0]
    const attempt = listAttempts(workspaceLayout(root).ledger, { runId: run?.id as string })[0]
    const evidence = attempt
      ? getEvidenceBundle(workspaceLayout(root).ledger, attempt.id)?.bundle
      : undefined
    expect(evidence?.artifacts[0]).toMatchObject({
      artifactId: "delivery-proof",
      path: "artifacts/proof.json",
      status: "passed",
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      immutableRef: expect.stringContaining("artifacts/sha256/"),
    })
    expect(await readFile(prd, "utf8")).toContain("- [x] **publish-proof")
  })
})
