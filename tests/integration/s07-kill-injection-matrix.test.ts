import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { ExecutorOutcomeSchema, type JudgeOutput } from "@ralph-next/domain"
import type { JudgeBackend, JudgeEventSink, JudgeRequest } from "@ralph-next/evaluation"
import {
  type BackendCapabilities,
  type CallHandle,
  type ExecuteRunInput,
  type ExecutionBackend,
  type ExecutionChannel,
  type ExecutionRequest,
  type ExecutionToolPort,
  executeRun,
  type RunOptionOverrides,
  resolveEffectiveRunOptions,
} from "@ralph-next/orchestration"
import {
  getEvidenceBundle,
  initializeWorkspace,
  listAttempts,
  listGateResults,
  listJudgeAssessments,
  listModelCalls,
  listPreparedCompletions,
  listRuns,
  listRunTasks,
  listToolCalls,
  listUnsettledToolCalls,
  readEvents,
  withLedger,
  workspaceLayout,
} from "@ralph-next/persistence"
import { compilePrdGraph } from "@ralph-next/prd"
import type { ProviderToolCall } from "@ralph-next/providers"
import { ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { createRalphExecutionToolPort } from "../../apps/ralph-cli/src/tool-execution-port"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const TASK = "single-pass/deliver-capability"
const temporaryDirectories: string[] = []

type FaultPoint = Parameters<NonNullable<ExecuteRunInput["dependencies"]["fault"]>>[0]

setDefaultTimeout(120_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function fixtureWorkspace(toolBudget = false): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await cp(resolve("tests", "fixtures", "execution", "single-pass"), root, {
    recursive: true,
  })
  const prdPath = resolve(root, "PRD.md")
  const fixturePrd = await readFile(prdPath, "utf8")
  let recoveryPrd = fixturePrd.replace("timeout=20s", "timeout=120s")
  if (recoveryPrd === fixturePrd) throw new Error("Kill-matrix task timeout was not found")
  if (toolBudget) {
    recoveryPrd = recoveryPrd.replace(
      "model_calls=1; timeout=120s",
      "model_calls=1; tool_calls=1; timeout=120s",
    )
  }
  // Literal crash/restart boundaries validate durable convergence, not the
  // shared fixture's short deadline. A separate suite owns deadline behavior.
  await writeFile(prdPath, recoveryPrd, "utf8")
  await initializeWorkspace(root, "0.1.0-s07-kill-matrix")
  return root
}

async function optionsFor(root: string, cli: RunOptionOverrides) {
  const compiled = await compilePrdGraph(resolve(root, "PRD.md"), {
    workspaceRoot: root,
    recursive: true,
    strict: true,
  })
  expect(compiled.ok).toBeTrue()
  const graph = compiled.graph
  const reference = graph?.topologicalOrder[0]
  const document = reference ? graph?.documents[reference.documentId] : undefined
  const task = document?.tasks.find((candidate) => candidate.id === reference?.taskId)
  if (!document || !task) throw new Error("Kill-matrix fixture has no task")
  return resolveEffectiveRunOptions({ document, task, cli }).options
}

function executorSteps(count: 1 | 2): ScriptedExecutionBackend {
  return new ScriptedExecutionBackend([
    {
      expectedTask: TASK,
      actions: [{ type: "write", path: "product/capability.txt", content: "delivered" }],
    },
    ...(count === 2
      ? [
          {
            expectedTask: TASK,
            actions: [
              {
                type: "write" as const,
                path: "product/resumed-after-kill.txt",
                content: "resumed exactly once",
              },
            ],
          },
        ]
      : []),
  ])
}

async function run(input: {
  root: string
  cli: RunOptionOverrides
  options: Awaited<ReturnType<typeof optionsFor>>
  backend: ExecutionBackend
  runId?: string
  fault?: ExecuteRunInput["dependencies"]["fault"]
  toolPort?: ExecutionToolPort
  judge?: JudgeBackend
}) {
  return executeRun({
    workspaceRoot: input.root,
    prdFile: "PRD.md",
    effectiveOptions: input.options,
    optionResolution: { cli: input.cli },
    ...(input.runId ? { runId: input.runId } : {}),
    dependencies: {
      resolveBackend: (profile) => (profile === "fixture-executor" ? input.backend : undefined),
      ...(input.judge
        ? {
            resolveJudge: (profile: string, context: { kind: string }) =>
              profile === "fixture-judge" && context.kind === "external" ? input.judge : undefined,
          }
        : {}),
      ...(input.toolPort ? { toolPort: input.toolPort } : {}),
      ...(input.fault ? { fault: input.fault } : {}),
      sleep: async () => undefined,
    },
  })
}

function interruptedRun(root: string) {
  const layout = workspaceLayout(root)
  const runs = listRuns(layout.ledger)
  expect(runs).toHaveLength(1)
  expect(runs[0]?.status).toBe("interrupted")
  if (!runs[0]) throw new Error("Injected kill did not persist its run")
  return runs[0]
}

async function assertConverged(input: {
  root: string
  runId: string
  result: Awaited<ReturnType<typeof run>>
  expectedAttempts: number
  expectedFiles: readonly string[]
}): Promise<void> {
  const { root, runId, result } = input
  const layout = workspaceLayout(root)
  expect(result).toMatchObject({
    runId,
    status: "completed",
    exitCode: 0,
  })
  expect(listRuns(layout.ledger)).toHaveLength(1)
  expect(listRunTasks(layout.ledger, runId)).toEqual([
    expect.objectContaining({
      documentId: "single-pass",
      taskId: "deliver-capability",
      status: "completed",
    }),
  ])

  const prd = await readFile(resolve(root, "PRD.md"), "utf8")
  expect(prd.match(/- \[x\] \*\*deliver-capability/g)).toHaveLength(1)
  expect(prd).not.toContain("- [ ] **deliver-capability")
  expect(prd).not.toContain("- [~] **deliver-capability")

  const attempts = listAttempts(layout.ledger, { runId })
  expect(attempts).toHaveLength(input.expectedAttempts)
  expect(attempts.map((attempt) => attempt.ordinal)).toEqual(
    Array.from({ length: input.expectedAttempts }, (_, index) => index + 1),
  )
  expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(attempts.length)
  expect(attempts.at(-1)?.status).toBe("passed")
  expect(attempts.some((attempt) => attempt.status === "active")).toBeFalse()

  for (const attempt of attempts) {
    const modelCalls = listModelCalls(layout.ledger, attempt.id)
    const gates = listGateResults(layout.ledger, attempt.id)
    expect(new Set(modelCalls.map((call) => call.id)).size).toBe(modelCalls.length)
    expect(attempt.counters.modelCalls).toBe(modelCalls.length)
    expect(attempt.counters.gateRuns).toBe(gates.length)
  }

  const finalAttempt = attempts.at(-1)
  const evidence = finalAttempt
    ? getEvidenceBundle(layout.ledger, finalAttempt.id)?.bundle
    : undefined
  if (!evidence) throw new Error("Resumed task has no final evidence bundle")
  const changedPaths = new Set(evidence.changes.files.map((file) => file.path))
  for (const expected of input.expectedFiles) expect(changedPaths.has(expected)).toBeTrue()
  expect(evidence.changes.diffHash).toMatch(/^[a-f0-9]{64}$/)
  expect(evidence.changes.diffRef).toBeTruthy()

  const events = readEvents(layout.ledger).filter((event) => event.runId === runId)
  expect(events.filter((event) => event.type === "run.resumed")).toHaveLength(1)
  expect(events.filter((event) => event.type === "completion.prepared")).toHaveLength(1)
  expect(
    events.filter(
      (event) => event.type === "task.completed" || event.type === "completion.reconciled.commit",
    ),
  ).toHaveLength(1)
  expect(events.some((event) => event.type.includes("skipped"))).toBeFalse()
  expect(listPreparedCompletions(layout.ledger, runId)).toEqual([])

  const reportCounters = result.report?.counters
  expect(reportCounters?.attempts).toBe(attempts.length)
  expect(reportCounters?.modelCalls).toBe(
    attempts.reduce((sum, attempt) => sum + attempt.counters.modelCalls, 0),
  )
  expect(reportCounters?.toolCalls).toBe(
    attempts.reduce((sum, attempt) => sum + attempt.counters.toolCalls, 0),
  )
  expect(reportCounters?.gateRuns).toBe(
    attempts.reduce((sum, attempt) => sum + attempt.counters.gateRuns, 0),
  )
}

const deterministicCli: RunOptionOverrides = {
  mode: "once",
  evaluationMode: "deterministic-only",
  noChangePolicy: "require-change",
  failFast: true,
}

const runnerBoundaries: ReadonlyArray<{
  name: string
  point: FaultPoint
  attempts: 1 | 2
  completionBoundary: boolean
}> = [
  {
    name: "task active",
    point: "after-task-active",
    attempts: 1,
    completionBoundary: false,
  },
  {
    name: "gate results",
    point: "after-gates-persisted",
    attempts: 2,
    completionBoundary: false,
  },
  {
    name: "completion_prepared",
    point: "after-completion-prepared",
    attempts: 1,
    completionBoundary: true,
  },
  {
    name: "completion marker file",
    point: "after-completion-marker-file-written",
    attempts: 1,
    completionBoundary: true,
  },
  {
    name: "completion marker event",
    point: "after-completion-marker-written",
    attempts: 1,
    completionBoundary: true,
  },
  {
    name: "completion terminal event",
    point: "after-completion-committed",
    attempts: 1,
    completionBoundary: true,
  },
]

describe("S07.11 literal kill-injection boundaries", () => {
  for (const boundary of runnerBoundaries) {
    test(`${boundary.name} resumes the same task without duplicate, skip, or divergence`, async () => {
      const root = await fixtureWorkspace()
      const options = await optionsFor(root, deterministicCli)
      const backend = executorSteps(boundary.attempts === 2 ? 2 : 1)
      let injected = false
      await expect(
        run({
          root,
          cli: deterministicCli,
          options,
          backend,
          fault(point) {
            if (point === boundary.point && !injected) {
              injected = true
              throw new Error(`kill-injected:${boundary.point}`)
            }
          },
        }),
      ).rejects.toThrow(`kill-injected:${boundary.point}`)
      expect(injected).toBeTrue()

      const interrupted = interruptedRun(root)
      const beforeResumeAttempts = listAttempts(workspaceLayout(root).ledger, {
        runId: interrupted.id,
      })
      if (boundary.point === "after-task-active") {
        expect(beforeResumeAttempts).toEqual([])
        expect(backend.remaining()).toBe(1)
      } else if (boundary.point === "after-gates-persisted") {
        const attempt = beforeResumeAttempts[0]
        if (!attempt) throw new Error("Gate boundary has no persisted attempt")
        expect(attempt.counters.gateRuns).toBeGreaterThan(0)
        expect(attempt.counters.gateRuns).toBe(
          listGateResults(workspaceLayout(root).ledger, attempt.id).length,
        )
        expect(backend.remaining()).toBe(1)
      } else {
        expect(backend.remaining()).toBe(0)
      }

      const resumed = await run({
        root,
        cli: deterministicCli,
        options,
        backend,
        runId: interrupted.id,
      })
      await assertConverged({
        root,
        runId: interrupted.id,
        result: resumed,
        expectedAttempts: boundary.attempts,
        expectedFiles:
          boundary.attempts === 2
            ? ["product/capability.txt", "product/resumed-after-kill.txt"]
            : ["product/capability.txt"],
      })
      expect(backend.remaining()).toBe(0)
      if (boundary.completionBoundary) {
        expect(
          readEvents(workspaceLayout(root).ledger).some(
            (event) => event.type === "completion.reconciled.commit",
          ),
        ).toBe(boundary.point !== "after-completion-committed")
      }
    })
  }

  for (const boundary of ["tool intent", "tool write"] as const) {
    test(`${boundary} uses the durable journal and resumes without replaying an applied effect`, async () => {
      const root = await fixtureWorkspace(true)
      const cli: RunOptionOverrides = {
        ...deterministicCli,
        securityMode: "auto",
        headlessAsk: "allow",
        toolRules: { "fs.write": "allow" },
        writePaths: ["product/**"],
      }
      const options = await optionsFor(root, cli)
      const expectedEvent = boundary === "tool intent" ? "tool.call.started" : "tool.call.settled"
      let injected = false
      const toolPort = createRalphExecutionToolPort({
        onEvent(event) {
          if (event.type === expectedEvent && !injected) {
            injected = true
            throw new Error(`kill-injected:${boundary}`)
          }
        },
      })
      const crashingBackend = new ToolBoundaryBackend(boundary)
      await expect(
        run({
          root,
          cli,
          options,
          backend: crashingBackend,
          toolPort,
        }),
      ).rejects.toThrow(`kill-injected:${boundary}`)
      expect(injected).toBeTrue()

      const interrupted = interruptedRun(root)
      const ledger = workspaceLayout(root).ledger
      const callsBeforeResume = listToolCalls(ledger, { runId: interrupted.id })
      expect(callsBeforeResume).toHaveLength(1)
      expect(callsBeforeResume[0]?.settlement !== undefined).toBe(boundary === "tool write")
      expect(listUnsettledToolCalls(ledger, { runId: interrupted.id })).toHaveLength(
        boundary === "tool intent" ? 1 : 0,
      )

      const finishingBackend = executorSteps(1)
      const resumed = await run({
        root,
        cli,
        options,
        backend: finishingBackend,
        toolPort,
        runId: interrupted.id,
      })
      await assertConverged({
        root,
        runId: interrupted.id,
        result: resumed,
        expectedAttempts: 2,
        expectedFiles: ["product/capability.txt", "product/tool-boundary.txt"],
      })
      expect(await readFile(resolve(root, "product", "tool-boundary.txt"), "utf8")).toBe(
        `effect from ${boundary}`,
      )
      const calls = listToolCalls(ledger, { runId: interrupted.id })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.settlement?.outcome).toBe("succeeded")
      expect(listUnsettledToolCalls(ledger, { runId: interrupted.id })).toEqual([])
      const events = readEvents(ledger).filter((event) => event.runId === interrupted.id)
      expect(events.filter((event) => event.type === "tool.reconciliation.replayed")).toHaveLength(
        boundary === "tool intent" ? 1 : 0,
      )
      expect(
        events.filter((event) => event.type === "tool.reconciliation.effect-confirmed"),
      ).toHaveLength(0)
      expect(crashingBackend.starts).toBe(1)
      expect(finishingBackend.remaining()).toBe(0)
    })
  }

  test("judge assessment resumes with durable assessments and exact attempt counters", async () => {
    const root = await fixtureWorkspace()
    const cli: RunOptionOverrides = {
      ...deterministicCli,
      evaluationMode: "external",
      judgeProfile: "fixture-judge",
      judgeThreshold: 85,
      maxRevisionAttempts: 0,
    }
    const options = await optionsFor(root, cli)
    const backend = executorSteps(2)
    const judge = new PassingJudgeBackend(2)
    let injected = false
    await expect(
      run({
        root,
        cli,
        options,
        backend,
        judge,
        fault(point) {
          if (point === "after-judge-assessment-persisted" && !injected) {
            injected = true
            throw new Error("kill-injected:judge")
          }
        },
      }),
    ).rejects.toThrow("kill-injected:judge")
    expect(injected).toBeTrue()

    const interrupted = interruptedRun(root)
    const ledger = workspaceLayout(root).ledger
    const firstAttempts = listAttempts(ledger, { runId: interrupted.id })
    expect(firstAttempts).toHaveLength(1)
    expect(firstAttempts[0]?.counters.judgeTransportRetries).toBe(0)
    expect(listJudgeAssessments(ledger, { runId: interrupted.id })).toHaveLength(1)

    const resumed = await run({
      root,
      cli,
      options,
      backend,
      judge,
      runId: interrupted.id,
    })
    await assertConverged({
      root,
      runId: interrupted.id,
      result: resumed,
      expectedAttempts: 2,
      expectedFiles: ["product/capability.txt", "product/resumed-after-kill.txt"],
    })
    const assessments = listJudgeAssessments(ledger, { runId: interrupted.id })
    expect(assessments).toHaveLength(2)
    expect(new Set(assessments.map((assessment) => assessment.id)).size).toBe(2)
    expect(new Set(assessments.map((assessment) => assessment.attemptId)).size).toBe(2)
    expect(judge.requests).toHaveLength(2)
    expect(judge.remaining).toBe(0)
  })

  test("event outbox projection crash resumes the committed task without duplicate events or model work", async () => {
    const root = await fixtureWorkspace()
    const options = await optionsFor(root, deterministicCli)
    const backend = executorSteps(1)
    const layout = workspaceLayout(root)
    let injected = false

    await expect(
      run({
        root,
        cli: deterministicCli,
        options,
        backend,
        async fault(point) {
          if (point !== "after-completion-committed" || injected) return
          injected = true
          await rm(layout.workspaceEvents, { force: true })
          await mkdir(layout.workspaceEvents)
          throw new Error("kill-injected:event-outbox-projection")
        },
      }),
    ).rejects.toThrow()
    expect(injected).toBeTrue()
    expect(backend.remaining()).toBe(0)

    const interrupted = interruptedRun(root)
    const beforeResume = withLedger(layout.ledger, (database) => ({
      events:
        database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()
          ?.count ?? 0,
      outbox:
        database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM outbox").get()
          ?.count ?? 0,
      unpublished:
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM outbox WHERE published_at IS NULL",
          )
          .get()?.count ?? 0,
    }))
    expect(beforeResume.events).toBe(beforeResume.outbox)
    expect(beforeResume.unpublished).toBeGreaterThan(0)
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [x] **deliver-capability")

    await rm(layout.workspaceEvents, { recursive: true, force: true })
    await writeFile(layout.workspaceEvents, "", "utf8")
    const resumed = await run({
      root,
      cli: deterministicCli,
      options,
      backend,
      runId: interrupted.id,
    })
    await assertConverged({
      root,
      runId: interrupted.id,
      result: resumed,
      expectedAttempts: 1,
      expectedFiles: ["product/capability.txt"],
    })

    const afterResume = withLedger(layout.ledger, (database) =>
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM outbox WHERE published_at IS NULL",
        )
        .get(),
    )
    expect(afterResume?.count).toBe(0)
    const projected = (await readFile(layout.workspaceEvents, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { eventId: string })
    expect(new Set(projected.map((event) => event.eventId)).size).toBe(projected.length)
    expect(projected).toHaveLength(readEvents(layout.ledger).length)
    expect(backend.remaining()).toBe(0)
  })
})

class ToolBoundaryBackend implements ExecutionBackend {
  readonly id = "s07-tool-boundary"
  readonly boundary: "tool intent" | "tool write"
  starts = 0

  constructor(boundary: "tool intent" | "tool write") {
    this.boundary = boundary
  }

  capabilities(): BackendCapabilities {
    return { streaming: true, toolCalling: "ralph", cancellation: true, usage: "unavailable" }
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    this.starts += 1
    const id = `tool-boundary-${request.modelCallId}`
    const outcome = (async () => {
      await channel.reserveModelCall({ callId: id, turn: 1 })
      const definitions = await channel.tools()
      if (!definitions.some((definition) => definition.name === "fs.write")) {
        throw new Error("fs.write was not materialized for the kill matrix")
      }
      const input = {
        path: "product/tool-boundary.txt",
        content: `effect from ${this.boundary}`,
        precondition: { kind: "absent" as const },
        createParents: true,
      }
      const call: ProviderToolCall = {
        itemId: `item-${request.attemptId}`,
        callId: `provider-tool-${request.attemptId}`,
        name: "fs.write",
        input,
        argumentsJson: JSON.stringify(input),
      }
      await channel.executeTool(call)
      return ExecutorOutcomeSchema.parse({
        schemaVersion: 1,
        status: "work_submitted",
        summary: "Tool boundary completed without an injected kill.",
        intendedFiles: ["product/tool-boundary.txt"],
        artifactRefs: [],
        suggestedVerifications: [],
        risks: [],
        reportedAt: new Date().toISOString(),
      })
    })()
    void outcome.catch(() => undefined)
    return { id, outcome }
  }

  async cancel(): Promise<void> {}
}

class PassingJudgeBackend implements JudgeBackend {
  readonly id = "s07-passing-judge"
  readonly requests: JudgeRequest[] = []
  remaining: number

  constructor(responses: number) {
    this.remaining = responses
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
    if (this.remaining <= 0) throw new Error("Passing judge has no remaining response")
    this.remaining -= 1
    this.requests.push(request)
    const output: JudgeOutput = {
      schemaVersion: 1,
      score: 95,
      summary: "The vertical slice satisfies its deterministic criterion.",
      adequate: ["The expected file and gate evidence are present"],
      problems: [],
      missingEvidence: [],
      recommendations: [],
      criterionScores: [{ criterion: "c1", score: 95 }],
      confidence: 0.99,
    }
    return {
      id: request.callId,
      outcome: Promise.resolve(output),
      rawResponseRef: Promise.resolve(undefined),
    }
  }

  async cancel(): Promise<void> {}
}
