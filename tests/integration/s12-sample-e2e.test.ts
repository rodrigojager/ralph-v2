import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { copyFile, cp, readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  ExternalCliJudgeBackend,
  JUDGE_OUTPUT_JSON_ADAPTER_ID,
} from "@ralph-next/model-drivers"
import {
  type ExecuteRunInput,
  type ExecutionRuntimeDependencies,
  executeRun,
  type RunOptionOverrides,
  resolveEffectiveRunOptions,
} from "@ralph-next/orchestration"
import {
  getEvidenceBundle,
  initializeWorkspace,
  listAttempts,
  listChildRunTree,
  listJudgeAssessments,
  listRuns,
  listRunTasks,
  readEvents,
  workspaceLayout,
} from "@ralph-next/persistence"
import { type CompiledPrdGraph, compilePrdGraph } from "@ralph-next/prd"
import {
  BunProcessSupervisor,
  type SupervisedProcessHandle,
  type SupervisedProcessRequest,
} from "@ralph-next/supervisor"
import { type ScriptedExecution, ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { buildSnapshotView } from "@ralph-next/tui"
import { buildRunUiSnapshot } from "../../apps/ralph-cli/src/tui-services"
import { createInProcessChildWorkerFactory } from "../helpers/in-process-child-worker"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

setDefaultTimeout(120_000)

const VERSION = "0.1.0-s12-sample-e2e"
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..")
const SAMPLE_SOURCE = resolve(REPOSITORY_ROOT, "examples", "vertical-notes")
const DELIVERY_SOURCE = resolve(
  REPOSITORY_ROOT,
  "tests",
  "fixtures",
  "s12-vertical-notes-delivery",
)
const SENSITIVE_NOTE_TEXT = "S12 private note body must never appear in an operator log"
const temporaryDirectories: string[] = []
const liveProcesses: SupervisedProcessHandle[] = []

type ArtifactExpectation = {
  ref: string
  runId: string
  documentId: string
  taskId: string
  mode: "change+artifact"
  artifactId: string
  path: string
}

type ProductProof = {
  healthContract: boolean
  htmlEntrypoint: boolean
  invalidStatus: number
  invalidCorrelationMatched: boolean
  createdThenListed: boolean
  persistedAfterRestart: boolean
  correlatedStructuredLog: boolean
  noteTextAbsentFromLogs: boolean
}

class CountingBunProcessSupervisor extends BunProcessSupervisor {
  starts = 0

  override async start(request: SupervisedProcessRequest): Promise<SupervisedProcessHandle> {
    this.starts += 1
    return super.start(request)
  }
}

afterEach(async () => {
  for (const processHandle of liveProcesses.splice(0)) {
    await processHandle.cancel("S12 sample fixture cleanup").catch(() => undefined)
    await processHandle.settlement.catch(() => undefined)
  }
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function temporaryDirectory(): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  return root
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function delivery(path: string): Promise<string> {
  return readFile(resolve(DELIVERY_SOURCE, path), "utf8")
}

async function scriptedDelivery(): Promise<ScriptedExecution[]> {
  return [
    {
      expectedTask: "vertical-notes/health-surface",
      actions: [
        { type: "write", path: "package.json", content: await delivery("package.json") },
        { type: "write", path: "server.mjs", content: await delivery("server-health.mjs") },
        {
          type: "write",
          path: "public/index.html",
          content: await delivery("public/index.html"),
        },
        {
          type: "write",
          path: "public/app-health.js",
          content: await delivery("public/app-health.js"),
        },
        {
          type: "write",
          path: "artifacts/health-runbook.md",
          content: await delivery("artifacts/health-runbook.md"),
        },
      ],
    },
    {
      expectedTask: "vertical-notes-lifecycle/note-create-flow",
      actions: [
        { type: "write", path: "server.mjs", content: await delivery("server.mjs") },
        { type: "write", path: "src/store.mjs", content: await delivery("src/store.mjs") },
        { type: "write", path: "public/app.js", content: await delivery("public/app.js") },
        {
          type: "write",
          path: "artifacts/note-contract.md",
          content: await delivery("artifacts/note-contract-draft.md"),
        },
      ],
    },
    {
      expectedTask: "vertical-notes-lifecycle/note-create-flow",
      actions: [
        {
          type: "write",
          path: "artifacts/note-contract.md",
          content: await delivery("artifacts/note-contract.md"),
        },
      ],
    },
    {
      expectedTask: "vertical-notes-lifecycle/note-resume-flow",
      actions: [
        {
          type: "write",
          path: "artifacts/resume-checkpoint.md",
          content: await delivery("artifacts/resume-checkpoint.md"),
        },
      ],
    },
    {
      expectedTask: "vertical-notes/notes-lifecycle",
      actions: [
        {
          type: "write",
          path: "artifacts/notes-lifecycle-e2e.md",
          content: await delivery("artifacts/notes-lifecycle-e2e.md"),
        },
      ],
    },
    {
      expectedTask: "vertical-notes/operator-diagnostics",
      actions: [
        { type: "write", path: "Dockerfile", content: await delivery("Dockerfile") },
        { type: "write", path: "compose.yaml", content: await delivery("compose.yaml") },
        {
          type: "write",
          path: "artifacts/operator-runbook.md",
          content: await delivery("artifacts/operator-runbook.md"),
        },
      ],
    },
  ]
}

function taskFrom(graph: CompiledPrdGraph, documentId: string, taskId: string) {
  const document = graph.documents[documentId]
  const task = document?.tasks.find((candidate) => candidate.id === taskId)
  if (!document || !task) throw new Error(`Missing sample task ${documentId}/${taskId}`)
  return { document, task }
}

async function preparedOptions(root: string, cli: RunOptionOverrides) {
  const compiled = await compilePrdGraph(resolve(root, "PRD.md"), {
    workspaceRoot: root,
    recursive: true,
    strict: true,
  })
  expect(compiled.ok).toBeTrue()
  if (!compiled.graph) throw new Error("The S12 sample graph did not compile")
  const selected = taskFrom(compiled.graph, "vertical-notes", "health-surface")
  const resolution = resolveEffectiveRunOptions({ ...selected, cli })
  return {
    graph: compiled.graph,
    options: resolution.options,
    optionResolution: { cli },
  }
}

function hostEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  const names = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TZ"]
  return {
    ...Object.fromEntries(names.map((name) => [name, process.env[name]])),
    ...extra,
  }
}

function executeInput(
  root: string,
  prepared: Awaited<ReturnType<typeof preparedOptions>>,
  dependencies: ExecutionRuntimeDependencies,
  runId?: string,
): ExecuteRunInput {
  return {
    workspaceRoot: root,
    prdFile: "PRD.md",
    effectiveOptions: prepared.options,
    optionResolution: prepared.optionResolution,
    environment: hostEnvironment({
      RALPH_CONFIG_HOME: resolve(root, ".ralph", "isolated-global-config"),
    }),
    dependencies,
    ...(runId ? { runId } : {}),
  }
}

async function waitForReady(
  readyFile: string,
  processHandle: SupervisedProcessHandle,
): Promise<{ host: string; port: number }> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(readyFile, "utf8")) as {
        host?: unknown
        port?: unknown
      }
      if (typeof parsed.host === "string" && typeof parsed.port === "number") {
        return { host: parsed.host, port: parsed.port }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const earlySettlement = await Promise.race([
      processHandle.settlement.then((settlement) => settlement),
      new Promise<undefined>((resolveDelay) => setTimeout(() => resolveDelay(undefined), 25)),
    ])
    if (earlySettlement) {
      throw new Error(
        `S12 sample server exited before ready: ${earlySettlement.error ?? earlySettlement.stderr}`,
      )
    }
  }
  throw new Error("S12 sample server did not publish its bounded ready file")
}

async function startProduct(
  root: string,
  dataFile: string,
  readyFile: string,
): Promise<{ handle: SupervisedProcessHandle; baseUrl: string }> {
  const supervisor = new BunProcessSupervisor()
  const environment = hostEnvironment({
    S12_SAMPLE_HOST: "127.0.0.1",
    S12_SAMPLE_PORT: "0",
    S12_SAMPLE_DATA_FILE: dataFile,
    S12_SAMPLE_READY_FILE: readyFile,
  })
  const handle = await supervisor.start({
    executable: process.execPath,
    args: [resolve(root, "server.mjs")],
    cwd: root,
    environment,
    environmentAllowlist: ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TZ"],
    environmentRefs: {
      HOST: "env:S12_SAMPLE_HOST",
      PORT: "env:S12_SAMPLE_PORT",
      DATA_FILE: "env:S12_SAMPLE_DATA_FILE",
      READY_FILE: "env:S12_SAMPLE_READY_FILE",
    },
    shell: false,
    timeoutMs: 30_000,
    gracePeriodMs: 2_000,
    outputLimitBytes: 64 * 1_024,
    rawOutputLimitBytes: 64 * 1_024,
    maxInputBytes: 1_024,
  })
  liveProcesses.push(handle)
  const ready = await waitForReady(readyFile, handle)
  return { handle, baseUrl: `http://${ready.host}:${ready.port}` }
}

async function stopProduct(handle: SupervisedProcessHandle) {
  await handle.cancel("S12 sample restart boundary")
  const settlement = await handle.settlement
  const index = liveProcesses.indexOf(handle)
  if (index >= 0) liveProcesses.splice(index, 1)
  return settlement
}

async function exerciseProduct(root: string): Promise<ProductProof> {
  const dataFile = resolve(root, "var", "notes.json")
  const first = await startProduct(root, dataFile, resolve(root, ".ralph", "s12-ready-1.json"))
  let firstSettlement: Awaited<ReturnType<typeof stopProduct>> | undefined
  let secondSettlement: Awaited<ReturnType<typeof stopProduct>> | undefined
  try {
    const healthResponse = await fetch(`${first.baseUrl}/api/health`)
    const health = (await healthResponse.json()) as { status?: unknown; version?: unknown }
    const htmlResponse = await fetch(first.baseUrl)
    const html = await htmlResponse.text()

    const invalidResponse = await fetch(`${first.baseUrl}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    })
    const invalid = (await invalidResponse.json()) as {
      error?: { correlationId?: unknown }
    }
    const invalidCorrelation = invalid.error?.correlationId
    const correlationHeader = invalidResponse.headers.get("x-correlation-id")

    const createdResponse = await fetch(`${first.baseUrl}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: SENSITIVE_NOTE_TEXT }),
    })
    const created = (await createdResponse.json()) as { note?: { id?: unknown; text?: unknown } }
    const listedResponse = await fetch(`${first.baseUrl}/api/notes`)
    const listed = (await listedResponse.json()) as {
      notes?: Array<{ id?: unknown; text?: unknown }>
    }
    const createdThenListed =
      createdResponse.status === 201 &&
      typeof created.note?.id === "string" &&
      created.note.text === SENSITIVE_NOTE_TEXT &&
      listedResponse.status === 200 &&
      Array.isArray(listed.notes) &&
      listed.notes.some(
        (note) => note.id === created.note?.id && note.text === SENSITIVE_NOTE_TEXT,
      )

    firstSettlement = await stopProduct(first.handle)
    const second = await startProduct(
      root,
      dataFile,
      resolve(root, ".ralph", "s12-ready-2.json"),
    )
    try {
      const resumedResponse = await fetch(`${second.baseUrl}/api/notes`)
      const resumed = (await resumedResponse.json()) as { notes?: Array<{ text?: unknown }> }
      secondSettlement = await stopProduct(second.handle)

      const output = [
        firstSettlement.rawStdout,
        firstSettlement.rawStderr,
        secondSettlement.rawStdout,
        secondSettlement.rawStderr,
      ].join("\n")
      return {
        healthContract:
          healthResponse.status === 200 && health.status === "ok" && health.version === 1,
        htmlEntrypoint:
          htmlResponse.status === 200 &&
          html.includes("Vertical Notes") &&
          html.includes('type="module" src="/app.js"'),
        invalidStatus: invalidResponse.status,
        invalidCorrelationMatched:
          typeof invalidCorrelation === "string" && invalidCorrelation === correlationHeader,
        createdThenListed,
        persistedAfterRestart:
          resumedResponse.status === 200 &&
          Array.isArray(resumed.notes) &&
          resumed.notes.some((note) => note.text === SENSITIVE_NOTE_TEXT),
        correlatedStructuredLog:
          typeof invalidCorrelation === "string" &&
          output.includes(`"correlationId":"${invalidCorrelation}"`) &&
          output.includes('"errorCode":"note_invalid"'),
        noteTextAbsentFromLogs: !output.includes(SENSITIVE_NOTE_TEXT),
      }
    } finally {
      if (!secondSettlement) await stopProduct(second.handle).catch(() => undefined)
    }
  } finally {
    if (!firstSettlement) await stopProduct(first.handle).catch(() => undefined)
  }
}

async function expectedProjection<T>(root: string, name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(root, "expected", name), "utf8")) as T
}

describe("S12.08 executable Vertical Notes sample", () => {
  test("delivers root and child slices through judge revision, crash/resume, TUI and real HTTP", async () => {
    const root = await temporaryDirectory()
    await cp(SAMPLE_SOURCE, root, { recursive: true })
    const externalJudgeRoot = await temporaryDirectory()
    const externalJudgeScript = resolve(externalJudgeRoot, "ralph-sample-judge.mjs")
    await copyFile(resolve(SAMPLE_SOURCE, "tools", "ralph-sample-judge.mjs"), externalJudgeScript)
    expect(contained(root, externalJudgeScript)).toBeFalse()

    await initializeWorkspace(root, VERSION)
    const cli = {
      mode: "loop",
      executorProfile: "sample-scripted-executor",
      evaluationMode: "external",
      judgeProfile: "sample-fake-judge",
      judgeThreshold: 85,
      maxRevisionAttempts: 1,
      maxTasks: 5,
      maxModelCallsPerAttempt: 1,
      noChangePolicy: "allow-no-change",
      failFast: true,
      noCommit: true,
    } satisfies RunOptionOverrides
    const prepared = await preparedOptions(root, cli)
    expect(prepared.graph.documents).toHaveProperty("vertical-notes")
    expect(prepared.graph.documents).toHaveProperty("vertical-notes-lifecycle")

    const executor = new ScriptedExecutionBackend(await scriptedDelivery())
    const judgeSupervisor = new CountingBunProcessSupervisor()
    const judge = new ExternalCliJudgeBackend({
      id: "sample-fake-judge",
      supervisor: judgeSupervisor,
      environment: hostEnvironment(),
      config: {
        executable: process.execPath,
        args: [externalJudgeScript],
        cwd: ".",
        environmentRefs: {},
        inputMode: "stdin-json",
        adapter: "known-output",
        adapterId: JUDGE_OUTPUT_JSON_ADAPTER_ID,
        capabilities: {
          streaming: false,
          toolCalling: "unavailable",
          cancellation: true,
          usage: "unavailable",
        },
        mutationMode: "read-only",
        timeoutMs: 30_000,
        outputLimitBytes: 256 * 1_024,
      },
    })
    let crashInjected = false
    const dependencies: ExecutionRuntimeDependencies = {
      resolveBackend: (profile) =>
        profile === "sample-scripted-executor" ? executor : undefined,
      resolveJudge: (profile, context) =>
        profile === "sample-fake-judge" && context.kind === "external" ? judge : undefined,
      sleep: async () => undefined,
      fault(point) {
        if (point !== "after-completion-committed" || crashInjected) return
        crashInjected = true
        throw new Error("S12 sample crash after first durably completed leaf")
      },
    }
    dependencies.childRunWorkerSessionFactory = createInProcessChildWorkerFactory(dependencies)

    await expect(executeRun(executeInput(root, prepared, dependencies))).rejects.toThrow(
      "S12 sample crash after first durably completed leaf",
    )
    expect(crashInjected).toBeTrue()
    expect(executor.requests().map((request) => request.taskId)).toEqual(["health-surface"])

    const layout = workspaceLayout(root)
    const interrupted = listRuns(layout.ledger, { limit: 20 }).find(
      (run) => run.rootPrdId === "vertical-notes",
    )
    expect(interrupted).toMatchObject({ status: "interrupted" })
    if (!interrupted) throw new Error("The interrupted S12 root run was not persisted")
    expect(listRunTasks(layout.ledger, interrupted.id)).toContainEqual(
      expect.objectContaining({ taskId: "health-surface", status: "completed" }),
    )
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain(
      "- [x] **health-surface",
    )
    expect(
      listJudgeAssessments(layout.ledger, {
        runId: interrupted.id,
        documentId: "vertical-notes",
        taskId: "health-surface",
      }).map((record) => record.score),
    ).toEqual([96])

    const resumed = await executeRun(executeInput(root, prepared, dependencies, interrupted.id))
    expect(resumed).toMatchObject({
      runId: interrupted.id,
      status: "completed",
      exitCode: 0,
    })
    expect(executor.remaining()).toBe(0)
    const requestOrder = executor
      .requests()
      .map((request) => `${request.documentId}/${request.taskId}`)
    expect(requestOrder).toEqual([
      "vertical-notes/health-surface",
      "vertical-notes-lifecycle/note-create-flow",
      "vertical-notes-lifecycle/note-create-flow",
      "vertical-notes-lifecycle/note-resume-flow",
      "vertical-notes/notes-lifecycle",
      "vertical-notes/operator-diagnostics",
    ])
    expect(requestOrder.filter((task) => task === "vertical-notes/health-surface")).toHaveLength(1)

    const childLinks = listChildRunTree(layout.ledger, interrupted.id)
    expect(childLinks).toHaveLength(1)
    const childLink = childLinks[0]
    if (!childLink) throw new Error("The completed S12 run has no child link")
    expect(childLink).toMatchObject({
      childDocumentId: "vertical-notes-lifecycle",
      parentTaskId: "notes-lifecycle",
      status: "passed",
    })
    const childRunId = childLink.childRunId
    const rootTasks = listRunTasks(layout.ledger, interrupted.id)
    const childTasks = listRunTasks(layout.ledger, childRunId)
    expect(rootTasks.map((task) => [task.taskId, task.status])).toEqual([
      ["health-surface", "completed"],
      ["notes-lifecycle", "completed"],
      ["operator-diagnostics", "completed"],
    ])
    expect(childTasks.map((task) => [task.taskId, task.status])).toEqual([
      ["note-create-flow", "completed"],
      ["note-resume-flow", "completed"],
    ])

    const noteCreateAttempts = listAttempts(layout.ledger, { runId: childRunId }).filter(
      (attempt) => attempt.taskId === "note-create-flow",
    )
    const noteCreateAssessments = listJudgeAssessments(layout.ledger, {
      runId: childRunId,
      documentId: "vertical-notes-lifecycle",
      taskId: "note-create-flow",
    })
    expect(noteCreateAttempts.map((attempt) => attempt.status)).toEqual(["rejected", "passed"])
    expect(noteCreateAttempts.map((attempt) => attempt.counters.revisionAttempts)).toEqual([0, 1])
    expect(noteCreateAttempts.map((attempt) => attempt.completionDecision?.status)).toEqual([
      "revision_required",
      "passed",
    ])
    expect(noteCreateAssessments.map((record) => record.score)).toEqual([72, 96])

    const rootAttempts = listAttempts(layout.ledger, { runId: interrupted.id })
    const childAttempts = listAttempts(layout.ledger, { runId: childRunId })
    const allAssessments = [
      ...listJudgeAssessments(layout.ledger, { runId: interrupted.id }),
      ...listJudgeAssessments(layout.ledger, { runId: childRunId }),
    ]
    expect(rootAttempts).toHaveLength(3)
    expect(childAttempts).toHaveLength(3)
    expect(allAssessments).toHaveLength(6)
    expect(judgeSupervisor.starts).toBe(6)
    expect(allAssessments.every((record) => record.kind === "external")).toBeTrue()

    const artifactExpectations: ArtifactExpectation[] = [
      {
        ref: "vertical-notes/health-surface",
        runId: interrupted.id,
        documentId: "vertical-notes",
        taskId: "health-surface",
        mode: "change+artifact",
        artifactId: "health-runbook",
        path: "artifacts/health-runbook.md",
      },
      {
        ref: "vertical-notes-lifecycle/note-create-flow",
        runId: childRunId,
        documentId: "vertical-notes-lifecycle",
        taskId: "note-create-flow",
        mode: "change+artifact",
        artifactId: "note-contract",
        path: "artifacts/note-contract.md",
      },
      {
        ref: "vertical-notes-lifecycle/note-resume-flow",
        runId: childRunId,
        documentId: "vertical-notes-lifecycle",
        taskId: "note-resume-flow",
        mode: "change+artifact",
        artifactId: "resume-checkpoint",
        path: "artifacts/resume-checkpoint.md",
      },
      {
        ref: "vertical-notes/operator-diagnostics",
        runId: interrupted.id,
        documentId: "vertical-notes",
        taskId: "operator-diagnostics",
        mode: "change+artifact",
        artifactId: "operator-runbook",
        path: "artifacts/operator-runbook.md",
      },
    ]
    const evidenceProjection = artifactExpectations.map((expected) => {
      const attempts = listAttempts(layout.ledger, { runId: expected.runId }).filter(
        (attempt) =>
          attempt.documentId === expected.documentId && attempt.taskId === expected.taskId,
      )
      const passed = attempts.findLast((attempt) => attempt.status === "passed")
      if (!passed) throw new Error(`No passing attempt exists for ${expected.ref}`)
      const evidence = getEvidenceBundle(layout.ledger, passed.id)?.bundle
      if (!evidence) throw new Error(`No evidence bundle exists for ${expected.ref}`)
      const artifact = evidence.artifacts.find(
        (candidate) => candidate.artifactId === expected.artifactId,
      )
      expect(artifact).toMatchObject({
        artifactId: expected.artifactId,
        path: expected.path,
        status: "passed",
      })
      expect(evidence.changes.status).toBe("changed")
      expect(evidence.changes.diffHash).toMatch(/^[a-f0-9]{64}$/)
      return {
        ref: expected.ref,
        mode: expected.mode,
        artifact: expected.path,
        artifactStatus: artifact?.status,
        filePresent: true,
        attemptStatuses: attempts.map((attempt) => attempt.status),
        ...(expected.taskId === "note-create-flow"
          ? { judgeSequence: noteCreateAssessments.map((record) => record.score) }
          : {}),
      }
    })
    expect(
      await Promise.all(
        artifactExpectations.map((artifact) =>
          Bun.file(resolve(root, artifact.path)).exists(),
        ),
      ),
    ).toEqual([true, true, true, true])

    const rootSnapshot = buildRunUiSnapshot(root, interrupted.id)
    const childSnapshot = buildRunUiSnapshot(root, childRunId)
    const rootView = buildSnapshotView(rootSnapshot, 20, "ascii", "en")
    const childView = buildSnapshotView(childSnapshot, 12, "ascii", "en")
    expect(rootSnapshot).toMatchObject({
      status: "completed",
      progress: { completed: 4, total: 4 },
      judge: { mode: "external", profile: "sample-fake-judge", score: 96, threshold: 85 },
      usage: {
        combined: { available: false, source: "root+child:partial-unavailable" },
        executor: { available: false, source: "root+child:partial-unavailable" },
        judge: { available: false, source: "root+child:partial-unavailable" },
      },
    })
    expect(childSnapshot).toMatchObject({
      status: "completed",
      progress: { completed: 2, total: 2 },
      judge: {
        mode: "external",
        profile: "sample-fake-judge",
        score: 96,
        threshold: 85,
        revisionAttempt: 1,
      },
      usage: {
        combined: { available: false, source: "unavailable" },
        executor: { available: false, source: "unavailable" },
        judge: { available: false, source: "unavailable" },
      },
    })
    expect(rootView).toMatchObject({
      progressLabel: "4/4 · 100%",
      progressBar: "####################",
      progressPercentage: 100,
    })
    expect(childView).toMatchObject({
      progressLabel: "2/2 · 100%",
      progressBar: "############",
      progressPercentage: 100,
    })
    expect(childView.judgeLabel).toContain("96/85")
    expect(childView.judgeLabel).toContain("revisions 1/1")
    expect(rootView.combinedUsage).toContain("unavailable")
    expect(childView.judgeUsage).toContain("unavailable")
    const scopes = rootSnapshot.scopes ?? []
    expect(scopes.map((scope) => [scope.kind, scope.progress.completed, scope.progress.total])).toEqual(
      [
        ["root", 3, 3],
        ["child", 2, 2],
      ],
    )

    const product = await exerciseProduct(root)
    expect(product).toEqual({
      healthContract: true,
      htmlEntrypoint: true,
      invalidStatus: 400,
      invalidCorrelationMatched: true,
      createdThenListed: true,
      persistedAfterRestart: true,
      correlatedStructuredLog: true,
      noteTextAbsentFromLogs: true,
    })

    const events = readEvents(layout.ledger)
    expect(
      events.filter((event) => event.runId === interrupted.id && event.type === "run.resumed"),
    ).toHaveLength(1)
    expect(
      events.filter(
        (event) =>
          event.documentId === "vertical-notes" &&
          event.taskId === "health-surface" &&
          event.type === "task.completed",
      ),
    ).toHaveLength(1)

    const reportProjection = {
      $schema: "ralph.sample.executed-run-projection.v1",
      evidenceStatus: "executed-local-integration",
      run: {
        terminalStatus: resumed.status,
        sameRunResumed: resumed.runId === interrupted.id,
        firstLeafNotReplayed:
          requestOrder.filter((task) => task === "vertical-notes/health-surface").length === 1,
        leafProgress: {
          completed: rootSnapshot.progress.completed,
          total: rootSnapshot.progress.total,
          barAtCompletion: rootView.progressBar,
          percentage: rootView.progressPercentage,
        },
        rootScopeProgress: scopes[0]?.progress,
        composedParents: childLinks.length,
      },
      children: [
        {
          documentId: childLink.childDocumentId,
          parentTaskId: childLink.parentTaskId,
          status: childLink.status,
          progress: childSnapshot.progress,
          barAtCompletion: childView.progressBar,
        },
      ],
      judge: {
        backend: "external-cli",
        profile: "sample-fake-judge",
        scriptOutsideWorkspace: !contained(root, externalJudgeScript),
        supervisedProcessStarts: judgeSupervisor.starts,
        threshold: 85,
        intentionalRevision: {
          taskId: "note-create-flow",
          scores: noteCreateAssessments.map((record) => record.score),
          revisionAttempts: noteCreateAttempts.at(-1)?.counters.revisionAttempts,
        },
        finalRootLabel: rootView.judgeLabel,
        finalChildLabel: childView.judgeLabel,
      },
      resume: {
        crashBoundary: "after-completion-committed",
        interruptedStatus: interrupted.status,
        resumedStatus: resumed.status,
        sameRunId: resumed.runId === interrupted.id,
        completedLeafReplayed: false,
      },
      usage: {
        combined: {
          available: rootSnapshot.usage.combined.available,
          source: rootSnapshot.usage.combined.source,
        },
        executor: {
          available: rootSnapshot.usage.executor.available,
          source: rootSnapshot.usage.executor.source,
        },
        judge: {
          available: rootSnapshot.usage.judge.available,
          source: rootSnapshot.usage.judge.source,
        },
      },
      product,
      redaction: {
        containsRunIds: false,
        containsHashes: false,
        containsTokenValues: false,
        containsCredentialValues: false,
        containsNoteText: false,
      },
    }
    const evidenceIndexProjection = {
      $schema: "ralph.sample.executed-evidence-index.v1",
      evidenceStatus: "executed-local-integration",
      hashes: "redacted-after-runtime-validation",
      tasks: evidenceProjection,
      parentReconciliation: {
        ref: "vertical-notes/notes-lifecycle",
        child: "plans/notes-lifecycle.prd.md",
        childStatus: childLink.status,
        parentStatus: rootTasks.find((task) => task.taskId === "notes-lifecycle")?.status,
        requiresAllChildLeaves: true,
        allChildLeavesCompleted: childTasks.every((task) => task.status === "completed"),
      },
      containsTokenValues: false,
      containsCredentialValues: false,
      containsNoteText: false,
    }

    const redactedProjection = JSON.stringify({
      report: reportProjection,
      evidence: evidenceIndexProjection,
    })
    expect(redactedProjection).not.toContain(SENSITIVE_NOTE_TEXT)
    expect(redactedProjection).not.toContain(interrupted.id)
    expect(redactedProjection).not.toContain(childRunId)
    expect(redactedProjection).not.toContain(externalJudgeScript)
    expect(redactedProjection).not.toMatch(/[a-f0-9]{64}/)

    const expectedReport = await expectedProjection<typeof reportProjection>(
      root,
      "run-report.redacted.json",
    )
    const expectedEvidence = await expectedProjection<typeof evidenceIndexProjection>(
      root,
      "evidence-index.redacted.json",
    )
    expect({
      report: reportProjection,
      evidence: evidenceIndexProjection,
    }).toEqual({
      report: expectedReport,
      evidence: expectedEvidence,
    })
  })
})
