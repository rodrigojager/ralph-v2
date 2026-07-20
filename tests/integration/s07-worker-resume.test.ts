import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type CommandContext, executeCli } from "@ralph-next/commands"
import { type JudgeOutput, RecoveryManifestSchema } from "@ralph-next/domain"
import type { JudgeBackend, JudgeEventSink, JudgeRequest } from "@ralph-next/evaluation"
import {
  buildContextManifest,
  executeRun,
  type RunOptionOverrides,
  resolveEffectiveRunOptions,
} from "@ralph-next/orchestration"
import {
  appendEvent,
  getCompletionTransaction,
  getEvidenceBundle,
  initializeLedger,
  initializeWorkspace,
  listAttempts,
  listJudgeAssessments,
  listPreparedCompletions,
  listRuns,
  listRunTasks,
  readEvents,
  runLayout,
  upsertRunTask,
  withLedger,
  workspaceLayout,
} from "@ralph-next/persistence"
import { compilePrdGraph, hashCanonicalValue } from "@ralph-next/prd"
import {
  executeTypedWorkerOperation,
  spawnTypedWorker,
  type TypedWorkerHandle,
  type WorkerCapabilityAction,
  type WorkerParentCallMethod,
  type WorkerRole,
  workerCommandCapabilityFingerprint,
  workerExecutableContentHash,
} from "@ralph-next/supervisor"
import { ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s07-worker-resume"
const HASH = "a".repeat(64)
const REPOSITORY_ROOT = realpathSync.native(resolve(import.meta.dir, "../.."))
const WORKER_ENTRYPOINT = realpathSync.native(
  resolve(REPOSITORY_ROOT, "tests/fixtures/worker/s07-role-worker.ts"),
)
const temporaryDirectories: string[] = []
const liveWorkers: TypedWorkerHandle[] = []

type RecoveryJudgeStep = {
  output: JudgeOutput
  beforeResolve?: () => Promise<void>
}

class RecoveryJudgeBackend implements JudgeBackend {
  readonly id = "s07-recovery-judge"
  readonly requests: JudgeRequest[] = []
  readonly #steps: RecoveryJudgeStep[]

  constructor(steps: readonly RecoveryJudgeStep[]) {
    this.#steps = [...steps]
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
    const step = this.#steps.shift()
    if (!step) throw new Error("S07 recovery judge has no remaining response")
    return {
      id: request.callId,
      outcome: Promise.resolve().then(async () => {
        await step.beforeResolve?.()
        return step.output
      }),
      rawResponseRef: Promise.resolve(`raw:s07-recovery:${request.callId}`),
    }
  }

  async cancel() {}

  remaining(): number {
    return this.#steps.length
  }
}

afterEach(async () => {
  for (const worker of liveWorkers.splice(0)) {
    if (worker.snapshot().state !== "exited")
      await worker.shutdown("bounded fixture cleanup", 5_000)
  }
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function temporaryDirectory(): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  return root
}

function workerEnvironment(): Record<string, string> {
  const names = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP"]
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  ) as Record<string, string>
}

function scope(workspaceRoot: string) {
  return {
    schemaVersion: 1 as const,
    workspaceId: "workspace-s07-worker",
    workspaceRoot,
    runId: "run-s07-worker",
    documentId: "english-contract",
    taskId: "english-slice",
    attemptId: "attempt-s07-worker",
    correlationId: "correlation-s07-worker",
  }
}

async function spawnRoleWorker(input: {
  workspaceRoot: string
  role: WorkerRole
  actions: WorkerCapabilityAction[]
  commandScopes?: string[]
  observedMessages: string[]
  observedStates: string[]
  observedProgress: string[]
}): Promise<TypedWorkerHandle> {
  const executable = realpathSync.native(process.execPath)
  const worker = await spawnTypedWorker(
    {
      workerId: `${input.role}-fixture`,
      workspaceId: "workspace-s07-worker",
      workspaceRoot: input.workspaceRoot,
      runId: "run-s07-worker",
      attemptId: "attempt-s07-worker",
      role: input.role,
      executable,
      executableHash: workerExecutableContentHash(executable),
      launch: {
        kind: "bundled-runtime-entrypoint",
        path: WORKER_ENTRYPOINT,
        contentHash: workerExecutableContentHash(WORKER_ENTRYPOINT),
      },
      args: [],
      cwd: REPOSITORY_ROOT,
      environment: workerEnvironment(),
      capabilities: input.actions.map((action) => ({
        action,
        pathScopes: [input.workspaceRoot],
        commandScopes: input.commandScopes ?? [],
      })),
      heartbeatIntervalMs: 100,
      startupTimeoutMs: 10_000,
      shutdownGraceMs: 5_000,
      requestCancellationGraceMs: 2_000,
      forceCleanupGraceMs: 1_000,
    },
    {
      onMessage(message) {
        input.observedMessages.push(String((message as { type?: unknown }).type))
      },
      onState(snapshot) {
        input.observedStates.push(snapshot.state)
      },
      onProgress(progress) {
        input.observedProgress.push(progress.phase)
      },
    },
  )
  liveWorkers.push(worker)
  await worker.ready
  return worker
}

async function executionWorkspace(): Promise<string> {
  const root = await temporaryDirectory()
  await cp(resolve(REPOSITORY_ROOT, "tests/fixtures/execution/single-pass"), root, {
    recursive: true,
  })
  await initializeWorkspace(root, VERSION)
  return root
}

async function git(root: string, ...args: string[]): Promise<string> {
  const executable = Bun.which("git")
  if (!executable) throw new Error("Git is required by the focused S07 resume matrix")
  const child = Bun.spawn([executable, ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Ralph S07 Resume",
      GIT_AUTHOR_EMAIL: "ralph-s07@example.invalid",
      GIT_COMMITTER_NAME: "Ralph S07 Resume",
      GIT_COMMITTER_EMAIL: "ralph-s07@example.invalid",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr}`)
  }
  return stdout.trim()
}

async function resumeMatrixWorkspace(): Promise<string> {
  const root = await temporaryDirectory()
  await cp(resolve(REPOSITORY_ROOT, "tests/fixtures/execution/s07-resume-matrix"), root, {
    recursive: true,
  })
  await writeFile(resolve(root, ".gitignore"), ".ralph/\n", "utf8")
  await git(root, "init", "-b", "main")
  await git(root, "config", "core.autocrlf", "false")
  await git(root, "add", "--all")
  await git(root, "commit", "-m", "S07 resume fixture baseline")
  await initializeWorkspace(root, VERSION)
  expect(await git(root, "status", "--porcelain=v1")).toBe("")
  return root
}

async function recoveryWorkspace(): Promise<string> {
  const root = await temporaryDirectory()
  await cp(resolve(REPOSITORY_ROOT, "tests/fixtures/execution/single-pass"), root, {
    recursive: true,
  })
  await writeFile(resolve(root, ".gitignore"), ".ralph/\n", "utf8")
  await git(root, "init", "-b", "main")
  await git(root, "config", "core.autocrlf", "false")
  await git(root, "add", "--all")
  await git(root, "commit", "-m", "S07 recovery fixture baseline")
  await initializeWorkspace(root, VERSION)
  expect(await git(root, "status", "--porcelain=v1")).toBe("")
  return root
}

async function fixtureOptions(root: string, cli: RunOptionOverrides) {
  const compiled = await compilePrdGraph(resolve(root, "PRD.md"), {
    workspaceRoot: root,
    recursive: true,
    strict: true,
  })
  if (!compiled.ok || !compiled.graph) throw new Error("Expected the S07 resume matrix to compile")
  const reference = compiled.graph.topologicalOrder[0]
  if (!reference) throw new Error("Expected a task in the S07 resume matrix")
  const document = compiled.graph.documents[reference.documentId]
  const task = document?.tasks.find((candidate) => candidate.id === reference.taskId)
  if (!document || !task) throw new Error("Expected the first S07 resume task")
  return resolveEffectiveRunOptions({ document, task, cli }).options
}

function commandContext(
  root: string,
  backend?: ScriptedExecutionBackend,
  judge?: JudgeBackend,
): CommandContext {
  return {
    version: VERSION,
    cwd: root,
    environment: { RALPH_CONFIG_HOME: resolve(root, "isolated-global-config") },
    ...(backend
      ? {
          resolveBackend: (profile: string) =>
            profile === "fixture-executor" ? backend : undefined,
        }
      : {}),
    ...(judge
      ? {
          resolveJudge: (profile: string) => (profile === "fixture-judge" ? judge : undefined),
        }
      : {}),
  }
}

function recoveryAssessment(score: number): JudgeOutput {
  return {
    schemaVersion: 1,
    score,
    summary: `S07 recovery fixture score ${score}`,
    adequate: score >= 85 ? ["The recovered vertical slice is connected and verified"] : [],
    problems:
      score >= 85
        ? []
        : [
            {
              severity: "major",
              criterion: "c1",
              message: "One bounded revision is required before acceptance",
              evidenceRefs: [],
            },
          ],
    missingEvidence: score >= 85 ? [] : ["Evidence from the bounded recovery revision"],
    recommendations: score >= 85 ? [] : ["Preserve the workspace and apply the revision"],
    criterionScores: [{ criterion: "c1", score }],
    confidence: 0.95,
  }
}

async function interruptRun(root: string): Promise<string> {
  const backend = new ScriptedExecutionBackend([
    {
      expectedTask: "single-pass/deliver-capability",
      actions: [{ type: "write", path: "product/capability.txt", content: "delivered" }],
      failureAfterActions: "controlled S07 resume fixture interruption",
    },
  ])
  const result = await executeCli(
    [
      "run",
      "--workspace",
      root,
      "--prd",
      "PRD.md",
      "--no-judge",
      "--no-change-policy",
      "allow-no-change",
      "--ui",
      "none",
      "--format",
      "json",
    ],
    commandContext(root, backend),
  )
  expect(result.exitCode).not.toBe(0)
  const interrupted = listRuns(workspaceLayout(root).ledger, { limit: 1 })[0]
  expect(interrupted?.status).toBe("interrupted")
  if (!interrupted) throw new Error("Expected a persisted interrupted run")
  return interrupted.id
}

function successfulResumeBackend(): ScriptedExecutionBackend {
  return new ScriptedExecutionBackend([
    {
      expectedTask: "single-pass/deliver-capability",
      outcome: { summary: "The preserved mutation is ready for deterministic verification." },
    },
  ])
}

describe("S07.04 typed worker isolation", () => {
  test("runs model, judge, tool/gate and Git roles through scoped IPC while only parent callbacks write the ledger", async () => {
    const workspaceRoot = await temporaryDirectory()
    const layout = workspaceLayout(workspaceRoot)
    await initializeLedger(layout)
    const observedMessages: string[] = []
    const observedStates: string[] = []
    const observedProgress: string[] = []
    const parentMethods: WorkerParentCallMethod[] = []
    const onParentCall = async (call: { method: WorkerParentCallMethod }) => {
      parentMethods.push(call.method)
      appendEvent(layout.ledger, {
        type: "worker.parent-call.persisted",
        scope: "workspace",
        streamId: "workspace:workspace-s07-worker",
        workspaceId: "workspace-s07-worker",
        payload: { method: call.method },
      })
      return { accepted: true }
    }

    const compiled = await compilePrdGraph("tests/fixtures/prd/v2/valid-en.md", {
      workspaceRoot: REPOSITORY_ROOT,
      recursive: true,
      strict: true,
    })
    if (!compiled.ok || !compiled.graph) throw new Error("Expected worker PRD fixture to compile")
    const selected = compiled.graph.topologicalOrder[0]
    if (!selected) throw new Error("Expected a worker task fixture")
    const contextBundle = await buildContextManifest({
      graph: compiled.graph,
      task: selected,
      runId: "run-s07-worker",
      attemptId: "attempt-s07-worker",
      mode: "once",
      baseline: {
        schemaVersion: 1,
        kind: "workspace",
        revision: null,
        branch: null,
        dirty: false,
        statusHash: HASH,
        workspaceSnapshotHash: HASH,
        capturedAt: "2026-07-19T12:00:00.000Z",
      },
      budget: { remainingModelCalls: 2, remainingToolCalls: 3, remainingIterations: 1 },
      createdAt: "2026-07-19T12:00:01.000Z",
    })
    const executor = await spawnRoleWorker({
      workspaceRoot,
      role: "executor-model",
      actions: ["model.execute"],
      observedMessages,
      observedStates,
      observedProgress,
    })
    await executeTypedWorkerOperation(
      executor,
      "executor-model.execute",
      {
        schemaVersion: 1,
        scope: scope(workspaceRoot),
        callId: "call-s07-worker",
        callOrdinal: 1,
        profile: {
          profileId: "fixture-executor",
          role: "executor",
          backend: "embedded",
          provider: "fixture",
          model: "fixture",
          configHash: HASH,
        },
        contextManifest: contextBundle.manifest,
        execution: {
          task: { documentId: selected.documentId, taskId: selected.taskId },
          effectiveOptions: {},
          controlRoot: workspaceRoot,
          contextCanonicalJson: contextBundle.canonicalJson,
          protectedPaths: [],
        },
        resources: contextBundle.resources.map((resource) => ({
          resource: {
            ref: resource.ref,
            contentHash: resource.contentHash,
            includedHash: resource.includedHash,
            kind: resource.kind,
            mediaType: resource.mediaType,
            byteLength: resource.originalBytes,
            includedByteLength: resource.includedBytes,
            truncated: resource.truncated,
          },
          content: resource.content,
        })),
        contextTruncations: [...contextBundle.truncations],
        tools: [],
        requestedReadPaths: [],
        limits: {
          maximumOutputBytes: 4_096,
          maximumModelCalls: 1,
          maximumToolCalls: 0,
          timeoutMs: 2_000,
        },
      },
      { onParentCall },
    )
    await executor.shutdown("executor fixture complete", 5_000)
    expect((await executor.settlement).exitCode).toBe(0)

    const evaluationBundle = { fixture: true }
    const judge = await spawnRoleWorker({
      workspaceRoot,
      role: "judge",
      actions: ["judge.evaluate"],
      observedMessages,
      observedStates,
      observedProgress,
    })
    await executeTypedWorkerOperation(
      judge,
      "judge.evaluate",
      {
        schemaVersion: 1,
        scope: scope(workspaceRoot),
        assessmentId: "assessment-s07-worker",
        profile: {
          profileId: "fixture-judge",
          role: "judge",
          backend: "embedded",
          provider: "fixture",
          model: "fixture",
          configHash: HASH,
        },
        evidence: {
          runId: "run-s07-worker",
          attemptId: "attempt-s07-worker",
          documentId: "english-contract",
          taskId: "english-slice",
        },
        policy: {
          schemaVersion: 1,
          mode: "external",
          threshold: 85,
          maxRevisionAttempts: 1,
          judgeCallRetries: 0,
          onJudgeUnavailable: "fail",
          blockingSeverities: ["critical", "major"],
          exhaustedPolicy: "fail",
          rubric: {
            schemaVersion: 1,
            weightPolicy: "strict-100",
            criteria: [
              {
                criterion: "c1",
                description: "Verify the fixture result.",
                weight: 100,
                blocking: true,
              },
            ],
          },
        },
        evaluation: {
          kind: "external",
          bundle: evaluationBundle,
          bundleHash: hashCanonicalValue(
            "ralph.worker.judge-evaluation-bundle.v1",
            evaluationBundle,
          ),
          prompt: { system: "Judge the fixture.", user: "Return a bounded assessment." },
          effectiveOptions: {},
          controlRoot: workspaceRoot,
        },
        attachments: [],
        requestedReadPaths: [],
        maximumOutputBytes: 4_096,
      },
      { onParentCall },
    )
    await judge.shutdown("judge fixture complete", 5_000)
    expect((await judge.settlement).exitCode).toBe(0)

    const toolGate = await spawnRoleWorker({
      workspaceRoot,
      role: "tool-gate",
      actions: ["tool.execute", "gate.execute"],
      observedMessages,
      observedStates,
      observedProgress,
    })
    await executeTypedWorkerOperation(
      toolGate,
      "tool.execute",
      {
        schemaVersion: 1,
        scope: scope(workspaceRoot),
        modelCallId: "call-s07-worker",
        toolCall: { callId: "tool-s07-worker", name: "fixture", arguments: {} },
        journalBinding: {
          intentId: "tool-s07-worker",
          argumentsHash: HASH,
          idempotencyKey: HASH,
        },
        runtime: { policy: {}, session: {}, controlRoot: workspaceRoot },
        executionKind: "builtin",
        authorization: {
          allowed: true,
          decisionRef: "decision-s07-worker",
          policyHash: HASH,
          risk: "read-only",
        },
        requestedReadPaths: [],
        requestedWritePaths: [],
        timeoutMs: 2_000,
        maximumOutputBytes: 4_096,
        maximumRawOutputBytes: 4_096,
      },
      { onParentCall },
    )
    const gateSpecification = { type: "fixture" }
    const gatePlanHash = hashCanonicalValue("ralph.worker.gate-plan.v1", gateSpecification)
    await executeTypedWorkerOperation(
      toolGate,
      "gate.execute",
      {
        schemaVersion: 1,
        scope: scope(workspaceRoot),
        gateId: "gate-s07-worker",
        gatePlanRef: `gate-plan:${gatePlanHash}`,
        gatePlanHash,
        category: "test",
        blocking: true,
        skipPolicy: "required",
        criterionIds: ["c1"],
        specification: gateSpecification,
        invocation: { kind: "adapter", adapterId: "fixture", input: {} },
        requestedReadPaths: [],
        requestedWritePaths: [],
        timeoutMs: 2_000,
        maximumOutputBytes: 4_096,
      },
      { onParentCall },
    )
    await toolGate.shutdown("tool/gate fixture complete", 5_000)
    expect((await toolGate.settlement).exitCode).toBe(0)

    const executable = realpathSync.native(process.execPath)
    const gitCommand = {
      intent: "git-inspect" as const,
      executable,
      executableHash: workerExecutableContentHash(executable),
      args: ["--version"],
      cwd: workspaceRoot,
      environmentNames: [],
    }
    const git = await spawnRoleWorker({
      workspaceRoot,
      role: "git-integration",
      actions: ["integration.execute"],
      commandScopes: [workerCommandCapabilityFingerprint(workspaceRoot, gitCommand)],
      observedMessages,
      observedStates,
      observedProgress,
    })
    await executeTypedWorkerOperation(git, "git-integration.execute", {
      schemaVersion: 1,
      scope: scope(workspaceRoot),
      integrationId: "integration-s07-worker",
      decisionRef: "decision-s07-worker",
      policyHash: HASH,
      action: "inspect",
      repositoryRoot: workspaceRoot,
      strategy: "none",
      gitCommand,
      timeoutMs: 2_000,
      maximumOutputBytes: 4_096,
      maximumRawOutputBytes: 4_096,
    })
    await git.shutdown("Git fixture complete", 5_000)
    expect((await git.settlement).exitCode).toBe(0)

    expect(parentMethods).toEqual([
      "execution.emit-event",
      "judge.emit-event",
      "tool.process.execute",
      "gate.persist-output",
    ])
    expect(readEvents(layout.ledger).map((event) => event.payload)).toEqual(
      parentMethods.map((method) => ({ method })),
    )
    expect(
      withLedger(layout.ledger, (database) => ({
        runs: database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM runs").get()
          ?.count,
        tasks: database
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM run_tasks")
          .get()?.count,
      })),
    ).toEqual({ runs: 0, tasks: 0 })
    expect(observedMessages).toContain("worker.heartbeat")
    expect(observedStates).toEqual(expect.arrayContaining(["ready", "busy", "closing", "exited"]))
    expect(observedProgress).toEqual(
      expect.arrayContaining([
        "fixture.executor",
        "fixture.judge",
        "fixture.tool",
        "fixture.gate",
        "fixture.git",
      ]),
    )
  }, 30_000)
})

describe("S07.05 resume command surface", () => {
  test("auto reconciles prepared Git evidence before active, interrupted and pending work", async () => {
    const root = await resumeMatrixWorkspace()
    const cli: RunOptionOverrides = {
      mode: "loop",
      maxTasks: 4,
      delayMs: 0,
      noChangePolicy: "require-change",
      evaluationMode: "deterministic-only",
      noCommit: true,
    }
    const options = await fixtureOptions(root, cli)
    const initialHead = await git(root, "rev-parse", "HEAD")
    const preparedBackend = new ScriptedExecutionBackend([
      {
        expectedTask: "s07-resume-matrix/prepared-first",
        actions: [{ type: "write", path: "delivery/prepared.txt", content: "prepared-result" }],
      },
    ])
    let injected = false
    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        optionResolution: { cli },
        resumeDiscovery: "auto",
        dependencies: {
          resolveBackend: () => preparedBackend,
          sleep: async () => undefined,
          fault(point) {
            if (point === "after-completion-prepared" && !injected) {
              injected = true
              throw new Error("focused S07 completion_prepared crash")
            }
          },
        },
      }),
    ).rejects.toThrow("focused S07 completion_prepared crash")
    expect(preparedBackend.remaining()).toBe(0)

    const layout = workspaceLayout(root)
    const interruptedRun = listRuns(layout.ledger, { limit: 1 })[0]
    if (!interruptedRun) throw new Error("Expected the interrupted S07 matrix run")
    expect(interruptedRun.status).toBe("interrupted")
    const prepared = listPreparedCompletions(layout.ledger, interruptedRun.id)
    expect(prepared).toHaveLength(1)
    expect(prepared[0]).toMatchObject({
      status: "prepared",
      documentId: "s07-resume-matrix",
      taskId: "prepared-first",
    })

    const preResumeTasks = listRunTasks(layout.ledger, interruptedRun.id)
    const interruptedTask = preResumeTasks.find((task) => task.taskId === "interrupted-third")
    if (!interruptedTask) throw new Error("Expected the interrupted-priority task")
    upsertRunTask(layout.ledger, {
      runId: interruptedRun.id,
      documentId: interruptedTask.documentId,
      taskId: interruptedTask.taskId,
      status: "interrupted",
      markerContentHash: interruptedTask.markerContentHash,
      event: { type: "task.resume-matrix.interrupted" },
    })
    expect(
      listRunTasks(layout.ledger, interruptedRun.id).map((task) => [task.taskId, task.status]),
    ).toEqual([
      ["active-second", "active"],
      ["interrupted-third", "interrupted"],
      ["pending-fourth", "pending"],
      ["prepared-first", "evaluating"],
    ])

    const firstAttempt = listAttempts(layout.ledger, { runId: interruptedRun.id })[0]
    if (!firstAttempt) throw new Error("Expected the prepared attempt")
    expect(firstAttempt.baseline).toMatchObject({
      kind: "git",
      revision: initialHead,
      branch: "main",
      dirty: false,
    })
    const preparedEvidence = getEvidenceBundle(layout.ledger, firstAttempt.id)?.bundle
    if (!preparedEvidence?.changes.diffRef) {
      throw new Error("Prepared evidence did not retain its Git-backed diff")
    }
    expect(preparedEvidence.baseline).toMatchObject({ kind: "git", revision: initialHead })
    const preparedDiff = JSON.parse(
      await readFile(resolve(root, preparedEvidence.changes.diffRef), "utf8"),
    ) as { files: Array<{ path: string }> }
    expect(preparedDiff.files.map((file) => file.path)).toContain("delivery/prepared.txt")

    const resumedBackend = new ScriptedExecutionBackend([
      {
        expectedTask: "s07-resume-matrix/active-second",
        actions: [{ type: "write", path: "delivery/active.txt", content: "active-result" }],
      },
      {
        expectedTask: "s07-resume-matrix/interrupted-third",
        actions: [
          { type: "write", path: "delivery/interrupted.txt", content: "interrupted-result" },
        ],
      },
      {
        expectedTask: "s07-resume-matrix/pending-fourth",
        actions: [{ type: "write", path: "delivery/pending.txt", content: "pending-result" }],
      },
    ])
    const resumed = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      optionResolution: { cli },
      resumeDiscovery: "auto",
      dependencies: {
        resolveBackend: () => resumedBackend,
        sleep: async () => undefined,
      },
    })
    expect(resumed).toMatchObject({
      runId: interruptedRun.id,
      status: "completed",
      exitCode: 0,
    })
    expect(resumedBackend.remaining()).toBe(0)
    expect(listPreparedCompletions(layout.ledger, interruptedRun.id)).toHaveLength(0)
    expect(
      prepared[0] ? getCompletionTransaction(layout.ledger, prepared[0].id) : undefined,
    ).toMatchObject({ status: "committed" })

    const attempts = listAttempts(layout.ledger, { runId: interruptedRun.id })
    expect(attempts.map((attempt) => attempt.taskId)).toEqual([
      "prepared-first",
      "active-second",
      "interrupted-third",
      "pending-fourth",
    ])
    expect(attempts.every((attempt) => attempt.baseline.kind === "git")).toBe(true)
    expect(attempts.every((attempt) => attempt.baseline.revision === initialHead)).toBe(true)

    const finalCompiled = await compilePrdGraph(resolve(root, "PRD.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    if (!finalCompiled.ok || !finalCompiled.graph) {
      throw new Error("Expected the reconciled S07 PRD to compile")
    }
    expect(
      finalCompiled.graph.topologicalOrder.map(
        (reference) =>
          finalCompiled.graph?.documents[reference.documentId]?.tasks.find(
            (task) => task.id === reference.taskId,
          )?.status,
      ),
    ).toEqual(["completed", "completed", "completed", "completed"])
    expect(
      listRunTasks(layout.ledger, interruptedRun.id).map((task) => [task.taskId, task.status]),
    ).toEqual([
      ["active-second", "completed"],
      ["interrupted-third", "completed"],
      ["pending-fourth", "completed"],
      ["prepared-first", "completed"],
    ])

    const eventTypes = readEvents(layout.ledger)
      .filter((event) => event.runId === interruptedRun.id)
      .map((event) => event.type)
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "completion.prepared",
        "run.resumed",
        "completion.reconciled.marker",
        "completion.reconciled.commit",
      ]),
    )
    expect(eventTypes.filter((type) => type === "completion.prepared")).toHaveLength(4)
    expect(await git(root, "rev-parse", "HEAD")).toBe(initialHead)
    expect(
      (await git(root, "status", "--porcelain=v1"))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.trim()),
    ).toEqual(expect.arrayContaining(["M PRD.md", "?? delivery/"]))
  }, 45_000)

  test("enforces discovery modes, resumes the same run, creates an explicit new run and projects status/stop", async () => {
    const requiredRoot = await executionWorkspace()
    const absent = await executeCli(
      [
        "run",
        "--workspace",
        requiredRoot,
        "--resume",
        "required",
        "--ui",
        "none",
        "--format",
        "json",
      ],
      commandContext(requiredRoot),
    )
    expect(absent.execution.result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "RALPH_RESUMABLE_RUN_NOT_FOUND" })]),
    )

    const requiredRunId = await interruptRun(requiredRoot)
    const disabled = await executeCli(
      ["run", "--workspace", requiredRoot, "--resume", "never", "--ui", "none", "--format", "json"],
      commandContext(requiredRoot),
    )
    expect(disabled.execution.result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "RALPH_RESUME_DISABLED_CONFLICT" })]),
    )
    const requiredResume = await executeCli(
      [
        "run",
        "--workspace",
        requiredRoot,
        "--prd",
        "PRD.md",
        "--resume",
        "required",
        "--no-judge",
        "--no-change-policy",
        "allow-no-change",
        "--ui",
        "none",
        "--format",
        "json",
      ],
      commandContext(requiredRoot, successfulResumeBackend()),
    )
    expect(requiredResume).toMatchObject({
      exitCode: 0,
      execution: { result: { runId: requiredRunId, data: { status: "completed" } } },
    })

    const explicitRoot = await executionWorkspace()
    const explicitResume = await executeCli(
      ["resume", "--workspace", explicitRoot, "--format", "json"],
      commandContext(explicitRoot),
    )
    expect(explicitResume.execution.result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "RALPH_RESUMABLE_RUN_NOT_FOUND" })]),
    )

    const freshRoot = await executionWorkspace()
    const interruptedRunId = await interruptRun(freshRoot)
    const stopRequests: unknown[] = []
    const stopped = await executeCli(
      [
        "stop",
        interruptedRunId,
        "--workspace",
        freshRoot,
        "--graceful",
        "--grace",
        "2",
        "--format",
        "json",
      ],
      {
        ...commandContext(freshRoot),
        runControl: {
          async stop(request) {
            stopRequests.push(request)
            return {
              schemaVersion: 1,
              runId: request.runId,
              mode: request.mode,
              previousStatus: "interrupted",
              status: "stopping",
              disposition: "requested",
              requestedAt: "2026-07-19T12:00:00.000Z",
              ...(request.graceMs === undefined ? {} : { graceMs: request.graceMs }),
              delivery: "supervisor",
            }
          },
        },
      },
    )
    expect(stopped.exitCode).toBe(0)
    expect(stopRequests).toEqual([
      expect.objectContaining({ runId: interruptedRunId, mode: "graceful", graceMs: 2_000 }),
    ])

    const fresh = await executeCli(
      [
        "run",
        "--workspace",
        freshRoot,
        "--new-run",
        "--no-judge",
        "--no-change-policy",
        "allow-no-change",
        "--ui",
        "none",
        "--format",
        "json",
      ],
      commandContext(freshRoot, successfulResumeBackend()),
    )
    expect(fresh.exitCode).toBe(0)
    expect(fresh.execution.result.runId).not.toBe(interruptedRunId)

    const status = await executeCli(
      ["status", "--all", "--workspace", freshRoot, "--format", "json"],
      commandContext(freshRoot),
    )
    const summaries = (
      status.execution.result.data as {
        runs: Array<{ run: { id: string }; progress: unknown; attemptCount: number }>
      }
    ).runs
    expect(summaries.map((summary) => summary.run.id)).toEqual(
      expect.arrayContaining([interruptedRunId, fresh.execution.result.runId]),
    )
    expect(summaries.every((summary) => summary.progress && summary.attemptCount >= 0)).toBe(true)
    expect(await readFile(resolve(freshRoot, "PRD.md"), "utf8")).toContain(
      "- [x] **deliver-capability",
    )
  }, 45_000)
})

describe("S07.06 auditable workspace recovery", () => {
  test("preserves an externally edited Git workspace and exposes inspect, continue, checkpoint and explicit rollback", async () => {
    const root = await recoveryWorkspace()
    const initialHead = await git(root, "rev-parse", "HEAD")
    const baselineCheckpointResult = await executeCli(
      [
        "checkpoint",
        "create",
        "--workspace",
        root,
        "--reason",
        "Clean boundary before the S07 recovery matrix",
        "--inventory-root",
        "product",
        "--inventory-root",
        "external",
        "--format",
        "json",
      ],
      commandContext(root),
    )
    expect(baselineCheckpointResult.exitCode).toBe(0)
    const baselineCheckpoint = baselineCheckpointResult.execution.result.data as {
      id: string
      manifestHash: string
      files: number
      mutationPerformed: boolean
    }
    expect(baselineCheckpoint).toMatchObject({ files: 2, mutationPerformed: true })

    const cli: RunOptionOverrides = {
      mode: "once",
      evaluationMode: "external",
      judgeProfile: "fixture-judge",
      judgeThreshold: 85,
      maxRevisionAttempts: 2,
      noChangePolicy: "require-change",
      noCommit: true,
    }
    const options = await fixtureOptions(root, cli)
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
            path: "product/revision-note.txt",
            content: "the bounded recovery revision was applied",
          },
        ],
      },
    ])
    const externalNote = resolve(root, "external", "operator-note.txt")
    const judge = new RecoveryJudgeBackend([
      {
        output: recoveryAssessment(60),
        beforeResolve: async () => {
          await mkdir(resolve(root, "external"), { recursive: true })
          await writeFile(
            externalNote,
            "edited outside Ralph while the first attempt was being judged",
            "utf8",
          )
        },
      },
      { output: recoveryAssessment(88) },
    ])
    const blocked = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      optionResolution: { cli },
      dependencies: {
        resolveBackend: (profile) => (profile === "fixture-executor" ? executor : undefined),
        resolveJudge: (profile) => (profile === "fixture-judge" ? judge : undefined),
        sleep: async () => undefined,
      },
    })
    expect(blocked.status).toBe("waiting")
    expect(blocked.exitCode).not.toBe(0)
    expect(executor.remaining()).toBe(1)
    expect(judge.remaining()).toBe(1)

    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    if (!run) throw new Error("Expected the S07 recovery run")
    expect(run.status).toBe("waiting")
    expect(listRunTasks(layout.ledger, run.id)[0]?.status).toBe("interrupted")
    const attempts = listAttempts(layout.ledger, { runId: run.id })
    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "interrupted"])
    const firstAttempt = attempts[0]
    const blockedAttempt = attempts[1]
    if (!firstAttempt || !blockedAttempt) throw new Error("Expected two recovery attempts")
    expect(firstAttempt.baseline).toMatchObject({
      kind: "git",
      revision: initialHead,
      branch: "main",
      dirty: true,
    })
    expect(blockedAttempt.baseline).toMatchObject({
      kind: "git",
      revision: initialHead,
      branch: "main",
      dirty: true,
    })

    const firstEvidence = getEvidenceBundle(layout.ledger, firstAttempt.id)?.bundle
    if (!firstEvidence?.changes.diffRef || !firstEvidence.changes.diffHash) {
      throw new Error("The rejected attempt did not retain its expected workspace diff")
    }
    const firstDiffBytes = await readFile(resolve(root, firstEvidence.changes.diffRef))
    expect(createHash("sha256").update(firstDiffBytes).digest("hex")).toBe(
      firstEvidence.changes.diffHash,
    )
    const firstDiff = JSON.parse(firstDiffBytes.toString("utf8")) as {
      afterHash: string
      files: Array<{ path: string }>
    }
    expect(firstDiff.files.map((file) => file.path)).toContain("product/capability.txt")

    const decisionEvent = readEvents(layout.ledger)
      .filter((event) => event.type === "recovery.operator_decision_required")
      .at(-1)
    if (!decisionEvent) throw new Error("Expected a durable recovery decision")
    const decision = decisionEvent.payload as {
      recoveryRef: string
      recoveryHash: string
      recoveryStorageHash: string
      taskBaselineHash: string
      expectedWorkspaceHash: string
      observedWorkspaceHash: string
      availableActions: string[]
      recommendedAction: string
    }
    expect(decision).toMatchObject({
      expectedWorkspaceHash: firstDiff.afterHash,
      availableActions: ["continue", "inspect", "checkpoint", "rollback-explicit"],
      recommendedAction: "inspect",
    })
    expect(decision.observedWorkspaceHash).not.toBe(decision.expectedWorkspaceHash)

    const recoveryBytes = await readFile(resolve(root, decision.recoveryRef))
    expect(createHash("sha256").update(recoveryBytes).digest("hex")).toBe(
      decision.recoveryStorageHash,
    )
    const recovery = RecoveryManifestSchema.parse(JSON.parse(recoveryBytes.toString("utf8")))
    expect(recovery).toMatchObject({
      runId: run.id,
      documentId: "single-pass",
      taskId: "deliver-capability",
      attemptId: blockedAttempt.id,
      state: "workspace_changed",
      taskBaselineHash: firstAttempt.baseline.workspaceSnapshotHash,
      expectedWorkspaceHash: firstDiff.afterHash,
      observedWorkspaceHash: blockedAttempt.baseline.workspaceSnapshotHash,
      externalMutation: "suspected",
      requiresOperatorDecision: true,
      recommendedAction: "inspect",
      availableActions: ["continue", "inspect", "checkpoint", "rollback-explicit"],
      previousAttemptIds: [firstAttempt.id],
      unsettledToolCallIds: [],
      changes: {
        total: 2,
        included: 2,
        truncated: false,
        created: ["external/operator-note.txt"],
        modified: ["product/capability.txt"],
        deleted: [],
        untrackedTotal: 1,
        untracked: ["external/operator-note.txt"],
      },
    })
    expect(recovery.contentHash).toBe(decision.recoveryHash)
    expect(recovery.notes).toContain(
      "Workspace state differs from the expected observation; no reset or rollback was applied.",
    )
    if (!recovery.diff) throw new Error("Recovery manifest did not bind its workspace diff")
    const recoveryDiffBytes = await readFile(resolve(root, recovery.diff.ref))
    expect(createHash("sha256").update(recoveryDiffBytes).digest("hex")).toBe(
      recovery.diff.contentHash,
    )
    const recoveryDiff = JSON.parse(recoveryDiffBytes.toString("utf8")) as {
      beforeHash: string
      afterHash: string
      files: Array<{
        path: string
        before: { contentRef?: string } | null
        after: { contentRef?: string } | null
      }>
    }
    expect(recoveryDiff).toMatchObject({
      beforeHash: recovery.taskBaselineHash,
      afterHash: recovery.observedWorkspaceHash,
    })
    expect(recoveryDiff.files.map((file) => file.path)).toEqual([
      "external/operator-note.txt",
      "product/capability.txt",
    ])
    const recoveryFiles = new Map(recovery.changes.files.map((file) => [file.path, file]))
    const capabilityArtifact = recoveryFiles.get("product/capability.txt")
    const externalArtifact = recoveryFiles.get("external/operator-note.txt")
    if (
      !capabilityArtifact?.beforeRef ||
      !capabilityArtifact.afterRef ||
      !externalArtifact?.afterRef
    ) {
      throw new Error("Recovery file inventory did not retain immutable before/after artifacts")
    }
    expect(await readFile(resolve(root, capabilityArtifact.beforeRef), "utf8")).toBe("pending\n")
    expect(await readFile(resolve(root, capabilityArtifact.afterRef), "utf8")).toBe("delivered")
    expect(await readFile(resolve(root, externalArtifact.afterRef), "utf8")).toBe(
      "edited outside Ralph while the first attempt was being judged",
    )

    const persistedContext = JSON.parse(
      await readFile(
        resolve(runLayout(layout, run.id).context, blockedAttempt.id, "bundle.json"),
        "utf8",
      ),
    ) as {
      manifest: {
        contentHash: string
        recovery?: {
          ref: string
          sourceRef: string
          manifestHash: string
          sourceStorageHash: string
          state: string
          changedFiles: number
          untrackedFiles: number
          previousAttempts: number
          recommendedAction: string
          requiresOperatorDecision: boolean
        }
      }
      resources: Array<{ ref: string; kind: string; content: string }>
    }
    expect(persistedContext.manifest).toMatchObject({
      contentHash: blockedAttempt.contextManifestHash,
      recovery: {
        sourceRef: decision.recoveryRef,
        manifestHash: decision.recoveryHash,
        sourceStorageHash: decision.recoveryStorageHash,
        state: "workspace_changed",
        changedFiles: 2,
        untrackedFiles: 1,
        previousAttempts: 1,
        recommendedAction: "inspect",
        requiresOperatorDecision: true,
      },
    })
    const recoveryResource = persistedContext.resources.find(
      (resource) => resource.kind === "recovery",
    )
    if (!recoveryResource || !persistedContext.manifest.recovery) {
      throw new Error("Blocked attempt context did not embed its recovery artifact")
    }
    expect(recoveryResource.ref).toBe(persistedContext.manifest.recovery.ref)
    expect(RecoveryManifestSchema.parse(JSON.parse(recoveryResource.content))).toEqual(recovery)

    expect(await readFile(resolve(root, "product/capability.txt"), "utf8")).toBe("delivered")
    expect(await readFile(externalNote, "utf8")).toBe(
      "edited outside Ralph while the first attempt was being judged",
    )
    expect(await git(root, "rev-parse", "HEAD")).toBe(initialHead)
    expect((await git(root, "status", "--porcelain=v1")).split(/\r?\n/)).toEqual(
      expect.arrayContaining([" M product/capability.txt", "?? external/"]),
    )
    expect(
      readEvents(layout.ledger).some(
        (event) => event.type.includes("rollback") || event.type.includes("reset"),
      ),
    ).toBeFalse()

    const inspected = await executeCli(
      ["status", "run", "--run-id", run.id, "--workspace", root, "--format", "json"],
      commandContext(root),
    )
    expect(inspected.exitCode).toBe(0)
    expect(inspected.execution.result.data).toMatchObject({
      pendingRecovery: {
        eventId: decisionEvent.eventId,
        payload: {
          recoveryRef: decision.recoveryRef,
          availableActions: ["continue", "inspect", "checkpoint", "rollback-explicit"],
          recommendedAction: "inspect",
        },
      },
    })
    expect(inspected.execution.human).toContain(
      `Recovery inspect: ralph-next status run --run-id ${run.id}`,
    )
    expect(inspected.execution.human).toContain(
      `Recovery continue: ralph-next resume ${run.id} --accept-workspace-changes`,
    )
    expect(inspected.execution.human).toContain(
      `Recovery checkpoint: ralph-next checkpoint create --run-id ${run.id}`,
    )
    expect(inspected.execution.human).toContain(
      "Recovery rollback: ralph-next rollback preview <checkpoint-id>",
    )

    const recoveryCheckpointResult = await executeCli(
      [
        "checkpoint",
        "create",
        "--workspace",
        root,
        "--run-id",
        run.id,
        "--reason",
        "Preserve the externally edited recovery boundary",
        "--inventory-root",
        "product",
        "--inventory-root",
        "external",
        "--format",
        "json",
      ],
      commandContext(root),
    )
    expect(recoveryCheckpointResult.exitCode).toBe(0)
    expect(recoveryCheckpointResult.execution.result.data).toMatchObject({
      files: 3,
      mutationPerformed: true,
    })

    const beforePreview = {
      prd: await readFile(resolve(root, "PRD.md"), "utf8"),
      capability: await readFile(resolve(root, "product/capability.txt"), "utf8"),
      external: await readFile(externalNote, "utf8"),
    }
    const blockedPreviewResult = await executeCli(
      ["rollback", "preview", baselineCheckpoint.id, "--workspace", root, "--format", "json"],
      commandContext(root),
    )
    expect(blockedPreviewResult.exitCode).toBe(0)
    const blockedPreview = blockedPreviewResult.execution.result.data as {
      operationCount: number
      conflictCount: number
      requiresExplicitConfirmation: boolean
      requiresSafetyCheckpoint: boolean
      mutationPerformed: boolean
    }
    expect(blockedPreview).toMatchObject({
      operationCount: 3,
      conflictCount: 0,
      requiresExplicitConfirmation: true,
      requiresSafetyCheckpoint: true,
      mutationPerformed: false,
    })
    expect(blockedPreviewResult.execution.human).toContain("Mutation:      none (preview only)")
    expect({
      prd: await readFile(resolve(root, "PRD.md"), "utf8"),
      capability: await readFile(resolve(root, "product/capability.txt"), "utf8"),
      external: await readFile(externalNote, "utf8"),
    }).toEqual(beforePreview)

    const continued = await executeCli(
      ["resume", run.id, "--workspace", root, "--accept-workspace-changes", "--format", "json"],
      commandContext(root, executor, judge),
    )
    expect(continued).toMatchObject({
      exitCode: 0,
      execution: { result: { runId: run.id, data: { status: "completed" } } },
    })
    expect(executor.remaining()).toBe(0)
    expect(judge.remaining()).toBe(0)
    expect(judge.requests).toHaveLength(2)
    const completedAttempts = listAttempts(layout.ledger, { runId: run.id })
    expect(completedAttempts.map((attempt) => attempt.status)).toEqual([
      "rejected",
      "interrupted",
      "passed",
    ])
    const assessments = listJudgeAssessments(layout.ledger, { runId: run.id })
    expect(assessments.map((assessment) => assessment.score)).toEqual([60, 88])
    expect(completedAttempts.at(-1)?.completionDecision).toMatchObject({
      status: "passed",
      evaluationMode: "external",
      score: 88,
      threshold: 85,
      assessmentId: assessments[1]?.id,
    })
    expect(
      readEvents(layout.ledger).filter((event) => event.type === "evaluation.decision"),
    ).toHaveLength(2)
    const acceptedEvent = readEvents(layout.ledger)
      .filter((event) => event.type === "recovery.operator_decision_accepted")
      .at(-1)
    expect(acceptedEvent).toMatchObject({
      causationId: decisionEvent.eventId,
      payload: {
        action: "continue",
        source: "cli",
        decisionEventId: decisionEvent.eventId,
        decisionAttemptId: blockedAttempt.id,
        decisionRecoveryRef: decision.recoveryRef,
        decisionRecoveryHash: decision.recoveryHash,
        decisionRecoveryStorageHash: decision.recoveryStorageHash,
        taskBaselineHash: decision.taskBaselineHash,
        expectedWorkspaceHash: decision.expectedWorkspaceHash,
        observedWorkspaceHash: decision.observedWorkspaceHash,
      },
    })
    const acceptedRequest = executor.requests()[1]
    expect(acceptedRequest?.contextManifest.recovery).toMatchObject({
      state: "workspace_changed",
      previousAttempts: 2,
      recommendedAction: "inspect",
      requiresOperatorDecision: true,
    })
    const acceptedPayload = acceptedEvent?.payload as {
      currentRecoveryRef: string
      currentRecoveryHash: string
      currentRecoveryStorageHash: string
    }
    expect(acceptedRequest?.contextManifest.recovery).toMatchObject({
      sourceRef: acceptedPayload.currentRecoveryRef,
      manifestHash: acceptedPayload.currentRecoveryHash,
      sourceStorageHash: acceptedPayload.currentRecoveryStorageHash,
    })
    expect(
      acceptedRequest?.contextBundle.resources.some(
        (resource) => resource.kind === "recovery" && JSON.parse(resource.content).contentHash,
      ),
    ).toBeTrue()
    expect(await readFile(externalNote, "utf8")).toBe(beforePreview.external)
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [x] **deliver-capability")

    const finalPreviewResult = await executeCli(
      ["rollback", "preview", baselineCheckpoint.id, "--workspace", root, "--format", "json"],
      commandContext(root),
    )
    expect(finalPreviewResult.exitCode).toBe(0)
    const finalPreview = finalPreviewResult.execution.result.data as {
      id: string
      planHash: string
      operations: Array<{ kind: string; path: string }>
      conflictCount: number
      mutationPerformed: boolean
    }
    expect(finalPreview).toMatchObject({ conflictCount: 0, mutationPerformed: false })
    expect(finalPreview.operations.map((operation) => [operation.kind, operation.path])).toEqual(
      expect.arrayContaining([
        ["restore-file", "PRD.md"],
        ["remove-file", "external/operator-note.txt"],
        ["restore-file", "product/capability.txt"],
        ["remove-file", "product/revision-note.txt"],
      ]),
    )
    const appliedResult = await executeCli(
      [
        "rollback",
        "apply",
        finalPreview.id,
        "--confirm-plan-hash",
        finalPreview.planHash,
        "--workspace",
        root,
        "--format",
        "json",
      ],
      commandContext(root),
    )
    expect(appliedResult.exitCode).toBe(0)
    const applied = appliedResult.execution.result.data as {
      rollbackPlanId: string
      checkpointId: string
      checkpointStatus: string
      safetyCheckpointId: string
      safetyCheckpointManifestHash: string
      mutationPerformed: boolean
    }
    expect(applied).toMatchObject({
      rollbackPlanId: finalPreview.id,
      checkpointId: baselineCheckpoint.id,
      checkpointStatus: "applied",
      mutationPerformed: true,
    })
    expect(applied.safetyCheckpointId).toBeTruthy()
    expect(applied.safetyCheckpointManifestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await readFile(resolve(root, "product/capability.txt"), "utf8")).toBe("pending\n")
    expect(await Bun.file(externalNote).exists()).toBeFalse()
    expect(await Bun.file(resolve(root, "product/revision-note.txt")).exists()).toBeFalse()
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [ ] **deliver-capability")
    expect(await git(root, "rev-parse", "HEAD")).toBe(initialHead)
    expect(await git(root, "status", "--porcelain=v1")).toBe("")

    const auditEvents = readEvents(layout.ledger)
    expect(
      auditEvents.filter((event) => event.type === "checkpoint.created").length,
    ).toBeGreaterThanOrEqual(3)
    expect(
      auditEvents.filter((event) => event.type === "checkpoint.rollback.previewed"),
    ).toHaveLength(2)
    expect(auditEvents.filter((event) => event.type === "checkpoint.rollback.applied")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          rollbackPlanId: finalPreview.id,
          planHash: finalPreview.planHash,
          safetyCheckpointId: applied.safetyCheckpointId,
          reason: "Explicit hash-bound rollback applied exact file operations",
        }),
      }),
    ])
  }, 75_000)
})
