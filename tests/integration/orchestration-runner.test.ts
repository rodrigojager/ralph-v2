import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { appendFile, cp, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type ExecuteRunInput,
  type ExecutionBackend,
  type ExecutionBackendLimits,
  executeRun as executeRunInternal,
  type RunOptionOverrides,
  type RunOptionResolutionContext,
  resolveEffectiveRunOptions,
} from "@ralph-next/orchestration"
import {
  getEvidenceBundle,
  initializeWorkspace,
  listAttempts,
  listGateResults,
  listModelCalls,
  listPreparedCompletions,
  listRuns,
  listRunTasks,
  readEvents,
  workspaceLayout,
} from "@ralph-next/persistence"
import { compilePrdGraph } from "@ralph-next/prd"
import { type ScriptedExecution, ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { readVerifiedContentReference } from "@ralph-next/verification"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

type TestExecuteRunInput = Omit<ExecuteRunInput, "optionResolution"> & {
  optionResolution?: RunOptionResolutionContext
}

function materializedCliOverrides(
  options: ExecuteRunInput["effectiveOptions"],
): RunOptionOverrides {
  return {
    ...(options.mode.source === "cli" ? { mode: options.mode.value } : {}),
    ...(options.executorProfile.source === "cli"
      ? { executorProfile: options.executorProfile.value }
      : {}),
    ...(options.task.source === "cli" ? { task: options.task.value } : {}),
    ...(options.force.source === "cli" ? { force: options.force.value } : {}),
    ...(options.dryRun.source === "cli" ? { dryRun: options.dryRun.value } : {}),
    ...(options.skipTests.source === "cli" ? { skipTests: options.skipTests.value } : {}),
    ...(options.skipLint.source === "cli" ? { skipLint: options.skipLint.value } : {}),
    ...(options.skipGates.source === "cli" ? { skipGates: options.skipGates.value } : {}),
    ...(options.fast.source === "cli" ? { fast: options.fast.value } : {}),
    ...(options.noCommit.source === "cli" ? { noCommit: options.noCommit.value } : {}),
    ...(options.failFast.source === "cli" ? { failFast: options.failFast.value } : {}),
    ...(options.maxTasks.source === "cli" ? { maxTasks: options.maxTasks.value } : {}),
    ...(options.delayMs.source === "cli" ? { delayMs: options.delayMs.value } : {}),
    ...(options.maxIterations.source === "cli"
      ? { maxIterations: options.maxIterations.value }
      : {}),
    ...(options.maxModelCallsPerAttempt.source === "cli"
      ? { maxModelCallsPerAttempt: options.maxModelCallsPerAttempt.value }
      : {}),
    ...(options.maxNoChangeAttempts.source === "cli"
      ? { maxNoChangeAttempts: options.maxNoChangeAttempts.value }
      : {}),
    ...(options.noChangePolicy.source === "cli"
      ? { noChangePolicy: options.noChangePolicy.original ?? options.noChangePolicy.value }
      : {}),
  }
}

function executeRun(input: TestExecuteRunInput) {
  return executeRunInternal({
    ...input,
    optionResolution: input.optionResolution ?? {
      cli: materializedCliOverrides(input.effectiveOptions),
    },
  })
}

setDefaultTimeout(20_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("S05 backend authority and budget boundary", () => {
  function backendWith(
    run: (
      request: Parameters<ExecutionBackend["start"]>[0],
      channel: Parameters<ExecutionBackend["start"]>[1],
    ) => Promise<never>,
    limits?: ExecutionBackendLimits,
  ): ExecutionBackend {
    return {
      id: "s05-adversarial-backend",
      capabilities() {
        return {
          streaming: true,
          toolCalling: "ralph",
          cancellation: true,
          usage: "reported",
        }
      },
      ...(limits
        ? {
            limits() {
              return structuredClone(limits)
            },
          }
        : {}),
      async start(request, channel) {
        const outcome = run(request, channel)
        void outcome.catch(() => undefined)
        return { id: request.modelCallId, outcome }
      },
      async cancel() {},
    }
  }

  test("rejects a backend event that impersonates an authoritative task transition", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      executorProfile: "fixture-executor",
      maxModelCallsPerAttempt: 1,
    })
    const backend = backendWith(async (_request, channel) => {
      await channel.emit({ type: "task.completed", payload: { forged: true } })
      throw new Error("forged event unexpectedly accepted")
    })

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      }),
    ).rejects.toMatchObject({ code: "RALPH_BACKEND_EVENT_TYPE_FORBIDDEN", exitCode: 10 })
    expect(readEvents(workspaceLayout(root).ledger).map((event) => event.type)).not.toContain(
      "task.completed",
    )
  })

  test("counts a failed provider turn and blocks a second turn at max_model_calls=1", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      executorProfile: "fixture-executor",
      maxModelCallsPerAttempt: 1,
    })
    const backend = backendWith(async (request, channel) => {
      const firstProviderCallId = `${request.modelCallId}-one`
      await channel.reserveModelCall({ callId: firstProviderCallId, turn: 1 })
      await channel.emit({
        type: "model.usage.updated",
        payload: {
          providerCallId: firstProviderCallId,
          usage: {
            input: 0,
            output: 0,
            total: 0,
            source: "reported",
            semantics: "final",
            providerRawRef: "raw:test/failed-provider-turn",
          },
        },
      })
      await channel.reserveModelCall({ callId: `${request.modelCallId}-two`, turn: 2 })
      throw new Error("second provider turn unexpectedly accepted")
    })

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      }),
    ).rejects.toMatchObject({ code: "RALPH_MODEL_CALL_BUDGET_EXCEEDED", exitCode: 9 })
    const run = listRuns(workspaceLayout(root).ledger, { limit: 1 })[0]
    expect(run).toBeDefined()
    const attempts = listAttempts(workspaceLayout(root).ledger, { runId: run?.id as string })
    expect(attempts[0]?.counters.modelCalls).toBe(1)
    expect(listModelCalls(workspaceLayout(root).ledger, attempts[0]?.id as string)).toHaveLength(1)
  })

  test("rejects cumulative model usage above the task token budget", async () => {
    const root = await fixtureWorkspace("single-pass")
    const prdPath = resolve(root, "PRD.md")
    await writeFile(
      prdPath,
      (await readFile(prdPath, "utf8")).replace(
        "model_calls=1; timeout=20s",
        "model_calls=1; output_tokens=1; timeout=20s",
      ),
    )
    const options = await optionsFor(root, {
      mode: "once",
      executorProfile: "fixture-executor",
      maxModelCallsPerAttempt: 1,
    })
    const backend = backendWith(async (request, channel) => {
      const providerCallId = `${request.modelCallId}-usage`
      await channel.reserveModelCall({ callId: providerCallId, turn: 1 })
      await channel.emit({
        type: "model.usage.updated",
        payload: {
          providerCallId,
          usage: {
            output: 2,
            total: 2,
            source: "reported",
            semantics: "final",
            providerRawRef: "raw:test/usage",
          },
        },
      })
      throw new Error("usage budget unexpectedly accepted")
    })

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      }),
    ).rejects.toMatchObject({ code: "RALPH_MODEL_USAGE_BUDGET_EXCEEDED", exitCode: 9 })
    expect(readEvents(workspaceLayout(root).ledger).map((event) => event.type)).toContain(
      "budget.model_usage.exceeded",
    )
  })

  test("enforces an executor profile token limit when the task declares none", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      executorProfile: "fixture-executor",
      maxModelCallsPerAttempt: 1,
    })
    const backend = backendWith(
      async (request, channel) => {
        expect(request.contextManifest.budget.remainingOutputTokens).toBe(1)
        const providerCallId = `${request.modelCallId}-profile-usage`
        await channel.reserveModelCall({ callId: providerCallId, turn: 1 })
        await channel.emit({
          type: "model.usage.updated",
          payload: {
            providerCallId,
            usage: {
              output: 2,
              total: 2,
              source: "reported",
              semantics: "final",
              providerRawRef: "raw:test/profile-usage",
            },
          },
        })
        throw new Error("profile usage limit unexpectedly accepted")
      },
      { maxOutputTokens: 1 },
    )

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      }),
    ).rejects.toMatchObject({
      code: "RALPH_MODEL_USAGE_BUDGET_EXCEEDED",
      exitCode: 9,
      diagnostic: {
        details: { kind: "output", source: "profile", maximum: 1, actual: 2 },
      },
    })
    const violation = readEvents(workspaceLayout(root).ledger).find(
      (event) => event.type === "budget.model_usage.exceeded",
    )
    expect(violation?.payload).toMatchObject({
      kind: "output",
      source: "profile",
      maximum: 1,
      actual: 2,
    })
  })

  test("combines task and profile token limits using the stricter task bound", async () => {
    const root = await fixtureWorkspace("single-pass")
    const prdPath = resolve(root, "PRD.md")
    await writeFile(
      prdPath,
      (await readFile(prdPath, "utf8")).replace(
        "model_calls=1; timeout=20s",
        "model_calls=1; output_tokens=2; timeout=20s",
      ),
    )
    const options = await optionsFor(root, {
      mode: "once",
      executorProfile: "fixture-executor",
      maxModelCallsPerAttempt: 1,
    })
    const backend = backendWith(
      async (request, channel) => {
        expect(request.contextManifest.budget.remainingOutputTokens).toBe(2)
        const providerCallId = `${request.modelCallId}-combined-usage`
        await channel.reserveModelCall({ callId: providerCallId, turn: 1 })
        await channel.emit({
          type: "model.usage.updated",
          payload: {
            providerCallId,
            usage: {
              output: 3,
              total: 3,
              source: "reported",
              semantics: "final",
              providerRawRef: "raw:test/combined-usage",
            },
          },
        })
        throw new Error("combined usage limit unexpectedly accepted")
      },
      { maxOutputTokens: 5 },
    )

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      }),
    ).rejects.toMatchObject({
      code: "RALPH_MODEL_USAGE_BUDGET_EXCEEDED",
      exitCode: 9,
      diagnostic: {
        details: { kind: "output", source: "task", maximum: 2, actual: 3 },
      },
    })
  })

  test("rejects profile limits when an external-style backend cannot report usage", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      executorProfile: "fixture-executor",
      maxModelCallsPerAttempt: 1,
    })
    let started = false
    const backend: ExecutionBackend = {
      id: "external-cli:usage-unavailable",
      capabilities() {
        return {
          streaming: false,
          toolCalling: false,
          cancellation: true,
          usage: "unavailable",
        }
      },
      limits() {
        return { maxTotalTokens: 10 }
      },
      async start() {
        started = true
        throw new Error("unobservable limited backend unexpectedly started")
      },
      async cancel() {},
    }

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      }),
    ).rejects.toMatchObject({
      code: "RALPH_MODEL_USAGE_LIMIT_UNENFORCEABLE",
      exitCode: 2,
    })
    expect(started).toBeFalse()
  })

  test("command cancellation interrupts the active model call and leaves a resumable task", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      executorProfile: "fixture-executor",
      maxModelCallsPerAttempt: 1,
    })
    const controller = new AbortController()
    let announceStart: (() => void) | undefined
    const started = new Promise<void>((resolveStart) => {
      announceStart = resolveStart
    })
    let rejectOutcome: ((error: Error) => void) | undefined
    const cancellations: string[] = []
    const backend: ExecutionBackend = {
      id: "s05-command-cancellation",
      capabilities() {
        return {
          streaming: false,
          toolCalling: false,
          cancellation: true,
          usage: "unavailable",
        }
      },
      async start(request) {
        const outcome = new Promise<never>((_resolve, reject) => {
          rejectOutcome = reject
        })
        announceStart?.()
        return { id: request.modelCallId, outcome }
      },
      async cancel(_handle, reason) {
        cancellations.push(reason)
        rejectOutcome?.(new Error("backend settled after command cancellation"))
      },
    }

    const execution = executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      signal: controller.signal,
      dependencies: { resolveBackend: () => backend },
    })
    await started
    controller.abort(new Error("focused Ctrl+C"))

    await expect(execution).rejects.toMatchObject({
      code: "RALPH_EXECUTION_CANCELLED",
      exitCode: 8,
    })
    expect(cancellations).toEqual(["Execution was cancelled by the command"])

    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    expect(run).toMatchObject({ status: "interrupted" })
    const attempt = run ? listAttempts(layout.ledger, { runId: run.id })[0] : undefined
    expect(attempt).toMatchObject({ status: "interrupted" })
    expect(attempt ? listModelCalls(layout.ledger, attempt.id)[0] : undefined).toMatchObject({
      status: "cancelled",
    })
    expect(run ? listRunTasks(layout.ledger, run.id)[0] : undefined).toMatchObject({
      status: "interrupted",
    })
  })
})

async function fixtureWorkspace(name: string): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await cp(resolve("tests", "fixtures", "execution", name), root, { recursive: true })
  await initializeWorkspace(root, "0.1.0-test")
  return root
}

async function scriptedBackend(root: string, file = "backend.json") {
  const steps = JSON.parse(await readFile(resolve(root, file), "utf8")) as ScriptedExecution[]
  return new ScriptedExecutionBackend(steps)
}

async function optionsFor(root: string, cli: RunOptionOverrides, prdFile = "PRD.md") {
  const compiled = await compilePrdGraph(resolve(root, prdFile), {
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

async function runFixture(name: string, cli: RunOptionOverrides, backendFile = "backend.json") {
  const root = await fixtureWorkspace(name)
  const backend = await scriptedBackend(root, backendFile)
  const options = await optionsFor(root, cli)
  const result = await executeRun({
    workspaceRoot: root,
    prdFile: "PRD.md",
    effectiveOptions: options,
    dependencies: {
      resolveBackend: (profile) => (profile === "fixture-executor" ? backend : undefined),
      sleep: async () => undefined,
    },
  })
  return { root, backend, result }
}

describe("S03 command-authoritative runner", () => {
  test("dry-run plans without creating a run, attempt, model call or marker update", async () => {
    const root = await fixtureWorkspace("single-pass")
    const backend = await scriptedBackend(root)
    const options = await optionsFor(root, {
      mode: "once",
      dryRun: true,
      noChangePolicy: "require-change",
    })
    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => backend },
    })

    expect(result).toMatchObject({ kind: "dry-run", status: "planned", exitCode: 0 })
    expect(backend.remaining()).toBe(1)
    expect(listRuns(workspaceLayout(root).ledger)).toHaveLength(0)
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [ ] **deliver-capability")
  })

  test("does not create a run when the first ledger-backed task has no available backend", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
    })
    let resolverCalls = 0

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: {
          resolveBackend: () => {
            resolverCalls += 1
            return undefined
          },
        },
      }),
    ).rejects.toMatchObject({ code: "RALPH_EXECUTOR_PROFILE_UNAVAILABLE", exitCode: 6 })
    expect(resolverCalls).toBe(1)
    expect(listRuns(workspaceLayout(root).ledger)).toHaveLength(0)
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [ ] **deliver-capability")
  })

  test("classic PRDs fail with migration guidance before run state or backend resolution", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    await cp(resolve("tests", "fixtures", "prd", "classic", "grouped.md"), resolve(root, "PRD.md"))
    await initializeWorkspace(root, "0.1.0-test")
    const options = resolveEffectiveRunOptions({
      cli: { mode: "once", executorProfile: "fixture-executor" },
    }).options
    let resolverCalls = 0

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: {
          resolveBackend: () => {
            resolverCalls += 1
            throw new Error("backend resolver must not run for a classic PRD")
          },
        },
      }),
    ).rejects.toThrow("migrate the classic PRD")
    expect(resolverCalls).toBe(0)
    expect(listRuns(workspaceLayout(root).ledger)).toHaveLength(0)
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [ ]")
  })

  test("a valid child graph plans its deepest executable child task without persisting a run", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    await Promise.all([
      cp(resolve("examples", "PRD-v2-exemplo.md"), resolve(root, "PRD-v2-exemplo.md")),
      cp(resolve("examples", "subprd-v2-exemplo.md"), resolve(root, "subprd-v2-exemplo.md")),
    ])
    await initializeWorkspace(root, "0.1.0-test")
    const options = await optionsFor(
      root,
      {
        mode: "once",
        executorProfile: "fixture-executor",
        task: "cart-review",
        force: true,
        dryRun: true,
      },
      "PRD-v2-exemplo.md",
    )
    let resolverCalls = 0
    const backend = new ScriptedExecutionBackend([])

    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD-v2-exemplo.md",
      effectiveOptions: options,
      dependencies: {
        resolveBackend: (profile) => {
          resolverCalls += 1
          return profile === "fixture-executor" ? backend : undefined
        },
      },
    })

    expect(result).toMatchObject({
      kind: "dry-run",
      status: "planned",
      exitCode: 0,
      reason:
        "Deepest executable task checkout-cart-review-detail/cart-review-contract is ready for command-owned execution",
    })
    expect(resolverCalls).toBe(1)
    expect(listRuns(workspaceLayout(root).ledger)).toHaveLength(0)
    expect(await readFile(resolve(root, "PRD-v2-exemplo.md"), "utf8")).toContain("- [ ]")
  })

  test("executes one vertical slice through backend, command gate, evidence and completion", async () => {
    const { root, backend, result } = await runFixture("single-pass", {
      mode: "once",
      noChangePolicy: "require-change",
    })

    expect(result).toMatchObject({ kind: "executed", status: "completed", exitCode: 0 })
    expect(await readFile(resolve(root, "product", "capability.txt"), "utf8")).toBe("delivered")
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [x] **deliver-capability")
    expect(backend.remaining()).toBe(0)

    const layout = workspaceLayout(root)
    const attempts = listAttempts(layout.ledger, { runId: result.runId as string })
    expect(attempts).toHaveLength(1)
    const attempt = attempts[0]
    if (!attempt) throw new Error("Completed run has no persisted attempt")
    expect(attempt).toMatchObject({ status: "passed", phase: "decision" })
    expect(listModelCalls(layout.ledger, attempt.id)).toHaveLength(1)
    expect(listGateResults(layout.ledger, attempt.id)[0]?.result.status).toBe("passed")
    const evidenceRecord = getEvidenceBundle(layout.ledger, attempt.id)
    const evidence = evidenceRecord?.bundle
    if (!evidence || !evidenceRecord) {
      throw new Error("Completed attempt has no persisted evidence bundle")
    }
    expect(evidence.schemaVersion).toBe(2)
    if (evidence.schemaVersion !== 2) throw new Error("New attempts must produce evidence v2")
    expect(evidenceRecord.contentRef).toMatch(
      /^\.ralph\/runs\/[^/]+\/evidence\/bundles\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/,
    )
    expect(evidence).toMatchObject({
      task: {
        taskId: "deliver-capability",
        evidenceMode: "criteria",
      },
      context: { manifestHash: attempt.contextManifestHash },
      profile: { role: "executor", backendId: backend.id },
      provenance: { task: "derived", changes: "derived", gates: "derived" },
    })
    expect(evidence.task.criteria.length).toBeGreaterThan(0)
    expect(evidence.limits.modelCallsPerAttempt.maximum).toBeGreaterThan(0)
    expect(evidence.toolCalls).toEqual([])
    expect(evidence.truncations).toEqual([])
    if (!evidenceRecord.contentRef || !evidenceRecord.storageHash) {
      throw new Error("Evidence v2 has no immutable object binding")
    }
    const evidenceObject = await readFile(resolve(root, evidenceRecord.contentRef))
    expect(createHash("sha256").update(evidenceObject).digest("hex")).toBe(
      evidenceRecord.storageHash,
    )
    const diffRef = evidence?.changes.diffRef
    const attemptDiffRef = evidence?.changes.attemptDiffRef
    const diffHash = evidence.changes.diffHash
    const attemptDiffHash = evidence.changes.attemptDiffHash
    expect(diffRef).toMatch(/^\.ralph\/runs\//)
    expect(attemptDiffRef).toMatch(/^\.ralph\/runs\//)
    if (!diffRef || !attemptDiffRef || !diffHash || !attemptDiffHash) {
      throw new Error("Persisted diff references or hashes are missing")
    }
    const diffBytes = await readFile(resolve(root, diffRef))
    expect(createHash("sha256").update(diffBytes).digest("hex")).toBe(diffHash)
    const diffArtifact = JSON.parse(diffBytes.toString("utf8")) as {
      files: Array<{
        path: string
        before: { sha256: string; size: number; contentRef: string } | null
        after: { sha256: string; size: number; contentRef: string } | null
      }>
    }
    const changedFile = diffArtifact.files.find((file) => file.path === "product/capability.txt")
    if (!changedFile?.before || !changedFile.after) {
      throw new Error("Diff manifest did not preserve both versions of the modified file")
    }
    const attemptDiffBytes = await readFile(resolve(root, attemptDiffRef))
    expect(createHash("sha256").update(attemptDiffBytes).digest("hex")).toBe(attemptDiffHash)
    const attemptDiffArtifact = JSON.parse(attemptDiffBytes.toString("utf8")) as {
      beforeHash: string
    }
    expect(attemptDiffArtifact.beforeHash).toBe(attempt.baseline.workspaceSnapshotHash)
    expect(diffArtifact).toMatchObject({
      beforeHash: evidence.baseline.workspaceSnapshotHash,
    })

    await writeFile(resolve(root, "product", "capability.txt"), "changed after evidence")
    await unlink(resolve(root, "product", "capability.txt"))
    expect(
      Buffer.from(
        await readVerifiedContentReference(
          root,
          changedFile.before.contentRef,
          changedFile.before.sha256,
          changedFile.before.size,
        ),
      ).toString("utf8"),
    ).toBe("pending\n")
    expect(
      Buffer.from(
        await readVerifiedContentReference(
          root,
          changedFile.after.contentRef,
          changedFile.after.sha256,
          changedFile.after.size,
        ),
      ).toString("utf8"),
    ).toBe("delivered")
    expect(result.report?.counters).toMatchObject({
      tasksCompleted: 1,
      attempts: 1,
      modelCalls: 1,
      gateRuns: 1,
    })
    expect(readEvents(layout.ledger).map((event) => event.type)).toContain("task.completed")
    await writeFile(resolve(root, evidenceRecord.contentRef), "{}\n")
    expect(() => getEvidenceBundle(layout.ledger, attempt.id)).toThrow("does not match")
  })

  test("loop rebuilds context and completes two dependent tasks in order", async () => {
    const { root, backend, result } = await runFixture("two-task-order", {
      mode: "loop",
      maxTasks: 2,
      noChangePolicy: "require-change",
    })

    expect(result).toMatchObject({ status: "completed", exitCode: 0 })
    expect(await readFile(resolve(root, "delivery", "contract.txt"), "utf8")).toBe("v1")
    expect(await readFile(resolve(root, "delivery", "result.txt"), "utf8")).toBe("ready")
    expect((await readFile(resolve(root, "PRD.md"), "utf8")).match(/- \[x\]/g)).toHaveLength(2)
    expect(backend.remaining()).toBe(0)
    expect(result.report?.counters).toMatchObject({
      tasksCompleted: 2,
      attempts: 2,
      modelCalls: 2,
      gateRuns: 3,
    })
    const attempts = listAttempts(workspaceLayout(root).ledger, { runId: result.runId as string })
    const consumerAttempt = attempts.find((attempt) => attempt.taskId === "consume-contract")
    expect(consumerAttempt).toBeDefined()
    const consumerContext = JSON.parse(
      await readFile(
        resolve(
          root,
          ".ralph",
          "runs",
          result.runId as string,
          "context",
          consumerAttempt?.id as string,
          "manifest.json",
        ),
        "utf8",
      ),
    ) as { dependencyOutputs: Array<{ taskId: string; outputRefs: string[] }> }
    const dependency = consumerContext.dependencyOutputs[0]
    expect(dependency?.taskId).toBe("publish-contract")
    expect(dependency?.outputRefs).toHaveLength(3)
    expect(
      dependency?.outputRefs.filter((reference) =>
        /^\.ralph\/runs\/[^/]+\/evidence\/diffs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.json$/.test(
          reference,
        ),
      ),
    ).toHaveLength(2)
    const artifactRef = dependency?.outputRefs.find((reference) =>
      /^\.ralph\/runs\/[^/]+\/artifacts\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(reference),
    )
    expect(artifactRef).toBeDefined()
    if (!artifactRef) throw new Error("Dependency output has no immutable artifact reference")
    for (const reference of consumerContext.dependencyOutputs[0]?.outputRefs ?? []) {
      expect(await Bun.file(resolve(root, reference)).exists()).toBeTrue()
    }
    const consumerRequest = backend
      .requests()
      .find((request) => request.taskId === "consume-contract")
    expect(consumerRequest?.contextBundle.manifest.dependencyOutputs).toEqual(
      consumerContext.dependencyOutputs,
    )
    expect(consumerRequest?.contextBundle.resources.length).toBeGreaterThan(0)
    const producerAttempt = attempts.find((attempt) => attempt.taskId === "publish-contract")
    const producerEvidence = producerAttempt
      ? getEvidenceBundle(workspaceLayout(root).ledger, producerAttempt.id)?.bundle
      : undefined
    const frozenArtifact = producerEvidence?.artifacts.find(
      (artifact) => artifact.artifactId === "published-contract",
    )
    if (!frozenArtifact?.immutableRef) {
      throw new Error("Dependency artifact was not frozen into the run object store")
    }
    expect(frozenArtifact.immutableRef).toBe(artifactRef)
    await writeFile(resolve(root, "delivery", "contract.txt"), "later")
    await unlink(resolve(root, "delivery", "contract.txt"))
    expect(
      Buffer.from(
        await readVerifiedContentReference(
          root,
          frozenArtifact.immutableRef,
          frozenArtifact.contentHash,
          frozenArtifact.sizeBytes,
        ),
      ).toString("utf8"),
    ).toBe("v1")
  })

  test("resolves and persists exact executor/budget options independently for every selected task", async () => {
    const root = await fixtureWorkspace("task-options")
    const graphResult = await compilePrdGraph(resolve(root, "PRD.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    const graph = graphResult.graph
    const document = graph?.documents[graph.rootDocumentId]
    if (!graph || !document) throw new Error("Task-options fixture did not compile")
    const cli: RunOptionOverrides = {
      mode: "loop",
      maxTasks: 2,
      noChangePolicy: "require-change",
    }
    const invocation = resolveEffectiveRunOptions({ document, cli }).options
    const firstBackend = await scriptedBackend(root, "backend-one.json")
    const secondBackend = await scriptedBackend(root, "backend-two.json")

    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: invocation,
      optionResolution: { cli },
      dependencies: {
        resolveBackend: (profile) =>
          profile === "executor-one"
            ? firstBackend
            : profile === "executor-two"
              ? secondBackend
              : undefined,
      },
    })

    expect(result).toMatchObject({ status: "completed", exitCode: 0 })
    const attempts = listAttempts(workspaceLayout(root).ledger, { runId: result.runId as string })
    expect(
      attempts.map((attempt) => ({
        taskId: attempt.taskId,
        executor: attempt.effectiveOptions.executorProfile.value,
        maxCalls: attempt.effectiveOptions.maxModelCallsPerAttempt.value,
        hashMatches: attempt.effectiveOptionsHash === attempt.effectiveOptions.contentHash,
      })),
    ).toEqual([
      { taskId: "first-profile", executor: "executor-one", maxCalls: 1, hashMatches: true },
      { taskId: "second-profile", executor: "executor-two", maxCalls: 2, hashMatches: true },
    ])
  })

  test("rejects task-specific execution when option-resolution context is absent", async () => {
    const root = await fixtureWorkspace("task-options")
    const compiled = await compilePrdGraph(resolve(root, "PRD.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    const graph = compiled.graph
    const document = graph?.documents[graph.rootDocumentId]
    if (!graph || !document) throw new Error("Task-options fixture did not compile")
    const effectiveOptions = resolveEffectiveRunOptions({
      document,
      cli: { mode: "loop", maxTasks: 2 },
    }).options
    let resolverCalls = 0

    await expect(
      executeRunInternal({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions,
        dependencies: {
          resolveBackend: () => {
            resolverCalls += 1
            return undefined
          },
        },
      } as unknown as ExecuteRunInput),
    ).rejects.toMatchObject({ code: "RALPH_RUN_OPTION_RESOLUTION_REQUIRED", exitCode: 2 })
    expect(resolverCalls).toBe(0)
    expect(listRuns(workspaceLayout(root).ledger)).toHaveLength(0)
  })

  test("resumes once --task without requiring the invocation-only selector again", async () => {
    const root = await fixtureWorkspace("task-options")
    const compiled = await compilePrdGraph(resolve(root, "PRD.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    const graph = compiled.graph
    const document = graph?.documents[graph.rootDocumentId]
    if (!graph || !document) throw new Error("Task-options fixture did not compile")
    const selectedCli: RunOptionOverrides = {
      mode: "once",
      task: "first-profile",
      noChangePolicy: "require-change",
    }
    const firstBackend = await scriptedBackend(root, "backend-one.json")
    const first = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: resolveEffectiveRunOptions({ document, cli: selectedCli }).options,
      optionResolution: { cli: selectedCli },
      dependencies: { resolveBackend: () => firstBackend },
    })
    expect(first).toMatchObject({ status: "interrupted", exitCode: 0 })
    if (!first.runId) throw new Error("Expected the resumable run ID")
    const storedAfterFirst = listRuns(workspaceLayout(root).ledger)[0]
    expect(first.report?.effectiveOptionsHash).toBe(storedAfterFirst?.effectiveOptionsHash)
    expect(first.report?.effectiveOptions).toEqual(storedAfterFirst?.effectiveOptions)

    const resumeCli: RunOptionOverrides = {
      mode: "once",
      noChangePolicy: "require-change",
    }
    const secondBackend = await scriptedBackend(root, "backend-two.json")
    const dryCli: RunOptionOverrides = { ...resumeCli, dryRun: true }
    const dryResume = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      runId: first.runId,
      effectiveOptions: resolveEffectiveRunOptions({ document, cli: dryCli }).options,
      optionResolution: { cli: dryCli },
      dependencies: { resolveBackend: () => secondBackend },
    })
    expect(dryResume.plan).toMatchObject({
      task: { taskId: "second-profile" },
      backendProfile: "executor-two",
      effects: { createsRun: false, createsAttempt: true, invokesBackend: true },
    })
    expect(dryResume.effectiveOptions.executorProfile.value).toBe("executor-two")
    expect(secondBackend.requests()).toHaveLength(0)

    const resumed = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: resolveEffectiveRunOptions({ document, cli: resumeCli }).options,
      optionResolution: { cli: resumeCli },
      dependencies: { resolveBackend: () => secondBackend },
    })
    expect(resumed).toMatchObject({ runId: first.runId, status: "completed", exitCode: 0 })
    const storedAfterResume = listRuns(workspaceLayout(root).ledger)[0]
    expect(resumed.report?.effectiveOptionsHash).toBe(storedAfterResume?.effectiveOptionsHash)
    expect(resumed.report?.effectiveOptions).toEqual(storedAfterResume?.effectiveOptions)
    expect(resumed.optionsHash).toBe(resumed.effectiveOptions.contentHash)
    expect(resumed.effectiveOptions.executorProfile.value).toBe("executor-two")
  })

  test("a forced dependency override executes with empty outputs and an explicit invariant", async () => {
    const root = await fixtureWorkspace("two-task-order")
    const options = await optionsFor(root, {
      mode: "once",
      task: "consume-contract",
      force: true,
      noChangePolicy: "require-change",
    })
    const backend = new ScriptedExecutionBackend([
      {
        expectedTask: "two-task-order/consume-contract",
        actions: [
          { type: "write", path: "delivery/contract.txt", content: "v1" },
          { type: "write", path: "delivery/result.txt", content: "ready" },
        ],
      },
    ])
    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => backend },
    })

    expect(result).toMatchObject({ status: "interrupted", exitCode: 0 })
    const request = backend.requests()[0]
    expect(request?.taskId).toBe("consume-contract")
    expect(request?.contextManifest.dependencyOutputs).toEqual([
      { taskId: "publish-contract", outputRefs: [] },
    ])
    expect(request?.contextManifest.invariants).toContainEqual(
      expect.stringContaining("--force authorized selection with incomplete dependencies"),
    )
    const prd = await readFile(resolve(root, "PRD.md"), "utf8")
    expect(prd).toContain("- [ ] **publish-contract")
    expect(prd).toContain("- [x] **consume-contract")
    expect(readEvents(workspaceLayout(root).ledger).map((event) => event.type)).toContain(
      "task.selection.overridden",
    )
  })

  test("a blocking gate failure preserves work and never writes a completed marker", async () => {
    const { root, result } = await runFixture("blocking-gate-failure", {
      mode: "once",
      noChangePolicy: "require-change",
      failFast: true,
    })

    expect(result).toMatchObject({ status: "failed", exitCode: 4 })
    expect(await readFile(resolve(root, "product", "capability.txt"), "utf8")).toBe("rejected")
    const prd = await readFile(resolve(root, "PRD.md"), "utf8")
    expect(prd).toContain("- [~] **deliver-accepted-value")
    expect(prd).not.toContain("- [x] **deliver-accepted-value")
    const layout = workspaceLayout(root)
    const attempt = listAttempts(layout.ledger, { runId: result.runId as string })[0]
    expect(listGateResults(layout.ledger, attempt?.id as string)[0]?.result.status).toBe("failed")
  })

  test("a gate that mutates or deletes delivery produces post-gate evidence and never completes", async () => {
    const root = await fixtureWorkspace("single-pass")
    const original = await readFile(resolve(root, "PRD.md"), "utf8")
    const readOnlyScript =
      "import { readFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'delivered') process.exit(1)"
    const mutatingScript =
      "import { readFileSync, unlinkSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'delivered') process.exit(1); unlinkSync('product/capability.txt')"
    const adversarial = original.replace(readOnlyScript, mutatingScript)
    expect(adversarial).not.toBe(original)
    await writeFile(resolve(root, "PRD.md"), adversarial)
    const backend = await scriptedBackend(root)
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
      failFast: true,
    })
    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => backend },
    })

    expect(result).toMatchObject({ status: "failed", exitCode: 4 })
    expect(await Bun.file(resolve(root, "product", "capability.txt")).exists()).toBeFalse()
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [~] **deliver-capability")
    const layout = workspaceLayout(root)
    const attempt = listAttempts(layout.ledger, { runId: result.runId as string })[0]
    const evidence = attempt ? getEvidenceBundle(layout.ledger, attempt.id)?.bundle : undefined
    if (!evidence) throw new Error("Adversarial gate run has no evidence")
    expect(evidence.changes.status).toBe("changed")
    expect(evidence.changes.outsideScopePaths).toEqual([])
    const stability = evidence.gates.find((gate) => gate.gateId === "ralph.workspace-stability")
    expect(stability).toMatchObject({ blocking: true, status: "failed" })
    const gateDiffRef = stability?.outputRefs[0]
    if (!gateDiffRef) throw new Error("Workspace stability gate has no immutable diff")
    const gateDiffBytes = await readFile(resolve(root, gateDiffRef))
    const gateDiffHash = gateDiffRef.match(/\/([a-f0-9]{64})\.json$/)?.[1]
    if (!gateDiffHash) throw new Error("Gate diff reference is not content-addressed")
    expect(createHash("sha256").update(gateDiffBytes).digest("hex")).toBe(gateDiffHash)
    const gateDiff = JSON.parse(gateDiffBytes.toString("utf8")) as {
      kind: string
      reproducible: boolean
      missingContent: unknown[]
      files: Array<{ path: string; before: unknown; after: unknown }>
    }
    expect(gateDiff.kind).toBe("gate")
    expect(gateDiff).toMatchObject({ reproducible: true, missingContent: [] })
    expect(gateDiff.files).toContainEqual({
      path: "product/capability.txt",
      before: expect.objectContaining({ contentRef: expect.any(String) }),
      after: null,
    })
    expect(readEvents(layout.ledger).map((event) => event.type)).not.toContain("task.completed")
  })

  test("a gate write outside scope fails closed without archiving or completing it", async () => {
    const root = await fixtureWorkspace("single-pass")
    const original = await readFile(resolve(root, "PRD.md"), "utf8")
    const readOnlyScript =
      "import { readFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'delivered') process.exit(1)"
    const outsideScopeScript =
      "import { readFileSync, writeFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'delivered') process.exit(1); writeFileSync('rogue.txt', 'must not be archived')"
    const adversarial = original
      .replace("workspace: .", "workspace: product")
      .replace(readOnlyScript, outsideScopeScript)
    await writeFile(resolve(root, "PRD.md"), adversarial)
    const backend = await scriptedBackend(root)
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
      failFast: true,
    })

    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => backend },
    })
    expect(result).toMatchObject({ status: "failed", exitCode: 4 })
    expect(await readFile(resolve(root, "rogue.txt"), "utf8")).toBe("must not be archived")
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [~] **deliver-capability")
    const layout = workspaceLayout(root)
    const attempt = listAttempts(layout.ledger, { runId: result.runId as string })[0]
    const evidence = attempt ? getEvidenceBundle(layout.ledger, attempt.id)?.bundle : undefined
    if (!evidence) throw new Error("Out-of-scope gate run has no evidence")
    expect(evidence.changes).toMatchObject({
      status: "out_of_scope",
      reproducible: false,
      outsideScopePaths: ["rogue.txt"],
    })
    expect(evidence.changes.missingContent).toContainEqual({
      path: "rogue.txt",
      side: "after",
      reason: "path is outside the declared workspace scope",
    })
    const diffManifest = JSON.parse(
      await readFile(resolve(root, evidence.changes.diffRef as string), "utf8"),
    ) as { reproducible: boolean; missingContent: unknown[] }
    expect(diffManifest).toMatchObject({
      reproducible: false,
      missingContent: [
        {
          path: "rogue.txt",
          side: "after",
          reason: "path is outside the declared workspace scope",
        },
      ],
    })
    expect(readEvents(layout.ledger).map((event) => event.type)).not.toContain("task.completed")
    const rogueHash = createHash("sha256").update("must not be archived").digest("hex")
    expect(
      await Bun.file(
        resolve(
          root,
          ".ralph",
          "runs",
          result.runId as string,
          "artifacts",
          "sha256",
          rogueHash.slice(0, 2),
          rogueHash,
        ),
      ).exists(),
    ).toBeFalse()
  })

  test("a gate that changes Git control facts is detected without archiving their bytes", async () => {
    const root = await fixtureWorkspace("single-pass")
    await mkdir(resolve(root, ".git", "hooks"), { recursive: true })
    await writeFile(resolve(root, ".git", "hooks", "pre-commit"), "original hook")
    const original = await readFile(resolve(root, "PRD.md"), "utf8")
    const readOnlyScript =
      "import { readFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'delivered') process.exit(1)"
    const mutatingScript =
      "import { readFileSync, writeFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'delivered') process.exit(1); writeFileSync('.git/hooks/pre-commit', 'changed hook')"
    const adversarial = original.replace(readOnlyScript, mutatingScript)
    expect(adversarial).not.toBe(original)
    await writeFile(resolve(root, "PRD.md"), adversarial)
    const backend = await scriptedBackend(root)
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
      failFast: true,
    })

    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => backend },
    })

    expect(result).toMatchObject({ status: "failed", exitCode: 4 })
    const layout = workspaceLayout(root)
    const attempt = listAttempts(layout.ledger, { runId: result.runId as string })[0]
    const evidence = attempt ? getEvidenceBundle(layout.ledger, attempt.id)?.bundle : undefined
    if (!evidence) throw new Error("Git-control mutation run has no evidence")
    expect(evidence.changes.reproducible).toBeFalse()
    expect(evidence.changes.files).toContainEqual(
      expect.objectContaining({ path: ".git/hooks/pre-commit", kind: "modified" }),
    )
    expect(evidence.changes.missingContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ".git/hooks/pre-commit", side: "before" }),
        expect.objectContaining({ path: ".git/hooks/pre-commit", side: "after" }),
      ]),
    )
    expect(
      evidence.gates.find((gate) => gate.gateId === "ralph.workspace-stability"),
    ).toMatchObject({ blocking: true, status: "failed" })
    for (const content of ["original hook", "changed hook"]) {
      const contentHash = createHash("sha256").update(content).digest("hex")
      expect(
        await Bun.file(
          resolve(
            root,
            ".ralph",
            "runs",
            result.runId as string,
            "artifacts",
            "sha256",
            contentHash.slice(0, 2),
            contentHash,
          ),
        ).exists(),
      ).toBeFalse()
    }
    expect(readEvents(layout.ledger).map((event) => event.type)).not.toContain("task.completed")
  })

  test("a declared artifact collection failure becomes a blocking internal gate", async () => {
    const root = await fixtureWorkspace("single-pass")
    const original = await readFile(resolve(root, "PRD.md"), "utf8")
    const withMissingArtifact = original.replace(
      "  - Limites:",
      "    - artifact: required-proof; path=product/missing-proof.txt\n  - Limites:",
    )
    expect(withMissingArtifact).not.toBe(original)
    await writeFile(resolve(root, "PRD.md"), withMissingArtifact)
    const backend = await scriptedBackend(root)
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
      failFast: true,
    })

    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => backend },
    })

    expect(result).toMatchObject({ status: "failed", exitCode: 4 })
    const layout = workspaceLayout(root)
    const attempt = listAttempts(layout.ledger, { runId: result.runId as string })[0]
    const evidence = attempt ? getEvidenceBundle(layout.ledger, attempt.id)?.bundle : undefined
    if (!evidence) throw new Error("Artifact collection failure has no evidence")
    expect(evidence.artifacts).toContainEqual(
      expect.objectContaining({
        artifactId: "required-proof",
        path: "product/missing-proof.txt",
        status: "failed",
      }),
    )
    expect(
      evidence.gates.find((gate) => gate.gateId === "ralph.artifact-collection.required-proof"),
    ).toMatchObject({ category: "artifact", blocking: true, status: "failed" })
    expect(readEvents(layout.ledger).map((event) => event.type)).not.toContain("task.completed")
  })

  test("an executor blocking report leaves the task and report explicitly blocked", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "allow-no-change",
    })
    const backend = new ScriptedExecutionBackend([
      {
        expectedTask: "single-pass/deliver-capability",
        outcome: {
          status: "blocked_reported",
          summary: "A required external precondition is unavailable.",
        },
      },
    ])
    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => backend },
    })

    expect(result).toMatchObject({ status: "waiting", exitCode: 5 })
    expect(result.report?.counters.tasksBlocked).toBe(1)
    expect(listRunTasks(workspaceLayout(root).ledger, result.runId as string)[0]?.status).toBe(
      "blocked",
    )
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [~] **deliver-capability")
  })

  test("loop fail-fast never starts the dependent task after a blocking failure", async () => {
    const root = await fixtureWorkspace("two-task-order")
    const options = await optionsFor(root, {
      mode: "loop",
      maxTasks: 2,
      noChangePolicy: "require-change",
      failFast: true,
    })
    const backend = new ScriptedExecutionBackend([
      {
        expectedTask: "two-task-order/publish-contract",
        actions: [{ type: "write", path: "delivery/contract.txt", content: "invalid" }],
      },
      {
        expectedTask: "two-task-order/consume-contract",
        actions: [{ type: "write", path: "delivery/result.txt", content: "must-not-run" }],
      },
    ])
    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => backend },
    })

    expect(result).toMatchObject({ status: "failed", exitCode: 4 })
    expect(backend.remaining()).toBe(1)
    expect(await Bun.file(resolve(root, "delivery", "result.txt")).exists()).toBeFalse()
    const prd = await readFile(resolve(root, "PRD.md"), "utf8")
    expect(prd).toContain("- [~] **publish-contract")
    expect(prd).toContain("- [ ] **consume-contract")
  })

  test("loop continues with independent work only when fail-fast is disabled", async () => {
    for (const failFast of [false, true]) {
      const root = await fixtureWorkspace("two-task-order")
      const prdPath = resolve(root, "PRD.md")
      await Bun.write(
        prdPath,
        (await readFile(prdPath, "utf8")).replace(
          "- Dependências: publish-contract",
          "- Dependências: nenhuma",
        ),
      )
      const options = await optionsFor(root, {
        mode: "loop",
        maxTasks: 2,
        noChangePolicy: "require-change",
        failFast,
      })
      const backend = new ScriptedExecutionBackend([
        {
          expectedTask: "two-task-order/publish-contract",
          actions: [{ type: "write", path: "delivery/contract.txt", content: "v1" }],
          outcome: {
            status: "blocked_reported",
            summary: "The first independent task remains blocked after materializing its draft.",
          },
        },
        {
          expectedTask: "two-task-order/consume-contract",
          actions: [{ type: "write", path: "delivery/result.txt", content: "ready" }],
        },
      ])
      const result = await executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      })
      const records = listRunTasks(workspaceLayout(root).ledger, result.runId as string)

      expect(result).toMatchObject({ status: "waiting", exitCode: 5 })
      expect(records.find((task) => task.taskId === "publish-contract")?.status).toBe("blocked")
      if (failFast) {
        expect(backend.remaining()).toBe(1)
        expect(records.find((task) => task.taskId === "consume-contract")?.status).toBe("pending")
      } else {
        expect(backend.remaining()).toBe(0)
        expect(records.find((task) => task.taskId === "consume-contract")?.status).toBe("completed")
        expect(await readFile(resolve(root, "delivery", "result.txt"), "utf8")).toBe("ready")
      }
    }
  })

  test("change-only and adversarial TASK_COMPLETE remain allegations without a delta", async () => {
    for (const fixture of ["no-change-change-only", "adversarial-task-complete"]) {
      const { root, result } = await runFixture(fixture, {
        mode: "once",
        noChangePolicy: "require-change",
        failFast: true,
      })
      expect(result.exitCode).toBe(4)
      expect(await readFile(resolve(root, "PRD.md"), "utf8")).not.toContain("- [x] **")
    }
  })

  test("wiggum converges within separate iteration/model-call limits and exhausts finitely", async () => {
    const converged = await runFixture(
      "wiggum",
      {
        mode: "wiggum",
        maxIterations: 2,
        maxModelCallsPerAttempt: 2,
        noChangePolicy: "retry-on-no-change",
      },
      "backend-converges.json",
    )
    expect(converged.result).toMatchObject({ status: "completed", exitCode: 0 })
    expect(await readFile(resolve(converged.root, "product", "capability.txt"), "utf8")).toBe(
      "converged",
    )
    expect(converged.result.report?.counters.modelCalls).toBe(2)

    const exhausted = await runFixture(
      "wiggum",
      {
        mode: "wiggum",
        maxIterations: 2,
        maxModelCallsPerAttempt: 2,
        noChangePolicy: "retry-on-no-change",
      },
      "backend-exhausts.json",
    )
    expect(exhausted.result).toMatchObject({ status: "interrupted", exitCode: 9 })
    expect(await readFile(resolve(exhausted.root, "PRD.md"), "utf8")).toContain(
      "- [~] **converge-capability",
    )
    expect(exhausted.backend.remaining()).toBe(0)
  })

  test("wiggum revises a changed partial delivery after a failed gate with fresh bounded context", async () => {
    const partial = await runFixture(
      "wiggum",
      {
        mode: "wiggum",
        maxIterations: 2,
        maxModelCallsPerAttempt: 2,
        noChangePolicy: "retry-on-no-change",
      },
      "backend-partial.json",
    )

    expect(partial.result).toMatchObject({ status: "completed", exitCode: 0 })
    expect(await readFile(resolve(partial.root, "product", "capability.txt"), "utf8")).toBe(
      "converged",
    )
    const requests = partial.backend.requests()
    expect(requests).toHaveLength(2)
    expect(requests[0]?.contextManifest.contentHash).not.toBe(
      requests[1]?.contextManifest.contentHash,
    )
    expect(requests[0]?.contextManifest.budget).toMatchObject({
      remainingModelCalls: 2,
      remainingIterations: 2,
    })
    expect(requests[1]?.contextManifest.budget).toMatchObject({
      remainingModelCalls: 1,
      remainingIterations: 1,
    })
    expect(requests[1]?.contextManifest.previousAssessmentRef).toMatch(/\.assessment\.json$/)

    const attempt = listAttempts(workspaceLayout(partial.root).ledger, {
      runId: partial.result.runId as string,
    })[0]
    const calls = attempt ? listModelCalls(workspaceLayout(partial.root).ledger, attempt.id) : []
    expect(calls.map((call) => call.contextManifestHash)).toEqual(
      requests.map((request) => request.contextManifest.contentHash),
    )
  })

  test("controlled interruption preserves the task baseline and resumes the same run", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "allow-no-change",
    })
    const interruptedBackend = new ScriptedExecutionBackend([
      {
        expectedTask: "single-pass/deliver-capability",
        actions: [{ type: "write", path: "product/capability.txt", content: "delivered" }],
        failureAfterActions: "controlled interruption after workspace mutation",
      },
    ])

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => interruptedBackend },
      }),
    ).rejects.toThrow("controlled interruption")
    expect(await readFile(resolve(root, "product", "capability.txt"), "utf8")).toBe("delivered")
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [~] **deliver-capability")

    const layout = workspaceLayout(root)
    const interruptedRun = listRuns(layout.ledger, { limit: 1 })[0]
    expect(interruptedRun?.status).toBe("interrupted")
    const resumedBackend = new ScriptedExecutionBackend([
      {
        expectedTask: "single-pass/deliver-capability",
        outcome: { summary: "The preserved mutation is ready for deterministic verification." },
      },
    ])
    const resumed = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => resumedBackend },
    })
    expect(resumed).toMatchObject({
      runId: interruptedRun?.id,
      status: "completed",
      exitCode: 0,
    })
    expect(listAttempts(layout.ledger, { runId: resumed.runId as string })).toHaveLength(2)
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [x] **deliver-capability")
  })

  test("a cumulative change cannot hide a no-change retry under require-change", async () => {
    const root = await fixtureWorkspace("no-change-change-only")
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
    })
    const interrupted = new ScriptedExecutionBackend([
      {
        expectedTask: "no-change-change-only/materialize-change",
        actions: [{ type: "write", path: "product/partial.txt", content: "partial" }],
        failureAfterActions: "interrupted after the first attempt changed the workspace",
      },
    ])
    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => interrupted },
      }),
    ).rejects.toThrow("interrupted after the first attempt")

    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    const noOp = new ScriptedExecutionBackend([
      {
        expectedTask: "no-change-change-only/materialize-change",
        outcome: { summary: "The retry made no additional change." },
      },
    ])
    const resumed = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      ...(run ? { runId: run.id } : {}),
      dependencies: { resolveBackend: () => noOp },
    })
    expect(resumed).toMatchObject({ status: "interrupted", exitCode: 4 })
    expect(await readFile(resolve(root, "product", "partial.txt"), "utf8")).toBe("partial")
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [~] **materialize-change")

    const attempts = run ? listAttempts(layout.ledger, { runId: run.id }) : []
    expect(attempts).toHaveLength(2)
    const finalEvidence = attempts[1]
      ? getEvidenceBundle(layout.ledger, attempts[1].id)?.bundle
      : undefined
    expect(
      finalEvidence?.gates.find((gate) => gate.gateId === "ralph.attempt-change-required"),
    ).toMatchObject({ status: "failed", blocking: true })
  })

  test("task timeout cancels the backend, persists resumable state and prevents a delayed write", async () => {
    const root = await fixtureWorkspace("deadline")
    const backend = await scriptedBackend(root)
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
    })
    let caught: unknown
    try {
      await executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({ code: "RALPH_EXECUTION_DEADLINE_EXCEEDED", exitCode: 9 })
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75))
    expect(await Bun.file(resolve(root, "delivery", "late.txt")).exists()).toBeFalse()
    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    expect(run).toMatchObject({ status: "interrupted" })
    const attempt = run ? listAttempts(layout.ledger, { runId: run.id })[0] : undefined
    expect(attempt).toMatchObject({ status: "interrupted" })
    expect(attempt ? listModelCalls(layout.ledger, attempt.id)[0] : undefined).toMatchObject({
      status: "cancelled",
      contextManifestHash: attempt?.contextManifestHash,
    })
  })

  test("a backend start that never returns is bounded and blocks a concurrent resume", async () => {
    const root = await fixtureWorkspace("deadline")
    // This case is specifically about bounding a start() call that was reached.
    // Leave enough budget for Windows/CI filesystem and SQLite setup even when
    // the complete test suite is running concurrently; the separate deadline
    // test above keeps the intentionally tight two-second fixture coverage.
    const prdPath = resolve(root, "PRD.md")
    const prd = await readFile(prdPath, "utf8")
    await writeFile(prdPath, prd.replace("timeout=2s", "timeout=8s"))
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
    })
    let startCalls = 0
    const hangingStartBackend = {
      id: "hanging-start",
      capabilities: () => ({
        streaming: false,
        toolCalling: false,
        cancellation: true,
        usage: "unavailable" as const,
      }),
      start: () => {
        startCalls += 1
        return new Promise<never>(() => undefined)
      },
      cancel: async () => undefined,
    }

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => hangingStartBackend },
      }),
    ).rejects.toMatchObject({ code: "RALPH_EXECUTION_DEADLINE_EXCEEDED", exitCode: 9 })
    expect(startCalls).toBe(1)

    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    const attempt = run ? listAttempts(layout.ledger, { runId: run.id })[0] : undefined
    const call = attempt ? listModelCalls(layout.ledger, attempt.id)[0] : undefined
    expect(call).toMatchObject({ status: "started" })

    let replacementStarts = 0
    const replacement = {
      ...hangingStartBackend,
      id: "replacement-must-not-start",
      start: () => {
        replacementStarts += 1
        return Promise.resolve({
          id: "unsafe-replacement",
          outcome: Promise.reject(new Error("replacement must not start")),
        })
      },
    }
    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        ...(run ? { runId: run.id } : {}),
        dependencies: { resolveBackend: () => replacement },
      }),
    ).rejects.toMatchObject({ code: "RALPH_MODEL_CALL_UNSETTLED", exitCode: 8 })
    expect(replacementStarts).toBe(0)
  })

  test("task deadline shortens a slow gate and prevents its delayed write", async () => {
    const root = await fixtureWorkspace("deadline")
    const prdPath = resolve(root, "PRD.md")
    const original = await readFile(prdPath, "utf8")
    const slowGate = {
      category: "test",
      skipPolicy: "required",
      blocking: true,
      command: {
        executable: "bun",
        args: [
          "-e",
          "await Bun.sleep(4000); await Bun.write('delivery/gate-late.txt', 'too late')",
        ],
        cwd: ".",
        shell: false,
        timeoutMs: 10_000,
        successExitCodes: [0],
        outputLimitBytes: 4096,
      },
    }
    const withSlowGate = original.replace(
      /^ {4}- command: .*$/m,
      `    - command: ${JSON.stringify(slowGate)}`,
    )
    expect(withSlowGate).not.toBe(original)
    await writeFile(prdPath, withSlowGate)
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
    })
    const backend = new ScriptedExecutionBackend([
      {
        expectedTask: "deadline-bounded/deadline-slice",
        actions: [{ type: "write", path: "delivery/model.txt", content: "submitted" }],
      },
    ])

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      }),
    ).rejects.toMatchObject({ code: "RALPH_EXECUTION_DEADLINE_EXCEEDED", exitCode: 9 })

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_200))
    expect(await Bun.file(resolve(root, "delivery", "gate-late.txt")).exists()).toBeFalse()
  })

  test("a hung completion boundary is deadline-bounded and reconciles without another call", async () => {
    const root = await fixtureWorkspace("single-pass")
    const prdPath = resolve(root, "PRD.md")
    const original = await readFile(prdPath, "utf8")
    await writeFile(prdPath, original.replace("timeout=20s", "timeout=5s"))
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
    })
    const backend = await scriptedBackend(root)

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: {
          resolveBackend: () => backend,
          fault: (point) =>
            point === "after-completion-prepared" ? new Promise<never>(() => undefined) : undefined,
        },
      }),
    ).rejects.toMatchObject({ code: "RALPH_EXECUTION_DEADLINE_EXCEEDED", exitCode: 9 })

    const layout = workspaceLayout(root)
    const run = listRuns(layout.ledger, { limit: 1 })[0]
    expect(run).toMatchObject({ status: "interrupted" })
    expect(run ? listPreparedCompletions(layout.ledger, run.id) : []).toHaveLength(1)
    expect(await readFile(prdPath, "utf8")).toContain("- [~] **deliver-capability")

    const resumed = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      ...(run ? { runId: run.id } : {}),
      dependencies: { resolveBackend: () => backend },
    })
    expect(resumed).toMatchObject({ status: "completed", exitCode: 0 })
    expect(backend.remaining()).toBe(0)
    expect(await readFile(prdPath, "utf8")).toContain("- [x] **deliver-capability")
  })

  test("refuses to replace an interrupted run when the PRD definition changes", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "allow-no-change",
    })
    const interruptedBackend = new ScriptedExecutionBackend([
      {
        expectedTask: "single-pass/deliver-capability",
        failure: "controlled interruption before work",
      },
    ])
    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => interruptedBackend },
      }),
    ).rejects.toThrow("controlled interruption before work")

    const prdPath = resolve(root, "PRD.md")
    const original = await readFile(prdPath, "utf8")
    await Bun.write(
      prdPath,
      original.replace(
        "o consumidor encontra a capacidade materializada",
        "o consumidor encontra a capacidade alterada materializada",
      ),
    )
    const replacementBackend = new ScriptedExecutionBackend([
      {
        expectedTask: "single-pass/deliver-capability",
        actions: [{ type: "write", path: "product/capability.txt", content: "delivered" }],
      },
    ])
    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => replacementBackend },
      }),
    ).rejects.toThrow("PRD definition changed while resumable work still exists")

    const layout = workspaceLayout(root)
    expect(listRuns(layout.ledger)).toHaveLength(1)
    expect(listRuns(layout.ledger)[0]?.status).toBe("interrupted")
    expect(replacementBackend.remaining()).toBe(1)
    expect(await readFile(prdPath, "utf8")).toContain("- [~] **deliver-capability")
  })

  test("renaming the root PRD ID cannot evade the resumable-definition conflict", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "allow-no-change",
    })
    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: {
          resolveBackend: () =>
            new ScriptedExecutionBackend([
              {
                expectedTask: "single-pass/deliver-capability",
                failure: "controlled root-ID interruption",
              },
            ]),
        },
      }),
    ).rejects.toThrow("controlled root-ID interruption")

    const prdPath = resolve(root, "PRD.md")
    await Bun.write(
      prdPath,
      (await readFile(prdPath, "utf8")).replace("id: single-pass", "id: single-pass-renamed"),
    )
    const replacement = new ScriptedExecutionBackend([
      {
        expectedTask: "single-pass-renamed/deliver-capability",
        actions: [{ type: "write", path: "product/capability.txt", content: "delivered" }],
      },
    ])
    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => replacement },
      }),
    ).rejects.toThrow("PRD definition changed while resumable work still exists")
    expect(listRuns(workspaceLayout(root).ledger)).toHaveLength(1)
    expect(replacement.remaining()).toBe(1)
  })

  test("a byte-only edit after prepared completion conflicts instead of being absorbed", async () => {
    const root = await fixtureWorkspace("single-pass")
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "require-change",
    })
    const backend = await scriptedBackend(root)
    let injected = false
    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: {
          resolveBackend: () => backend,
          fault: (point) => {
            if (point === "after-completion-prepared" && !injected) {
              injected = true
              throw new Error("injected after-completion-prepared")
            }
          },
        },
      }),
    ).rejects.toThrow("injected after-completion-prepared")
    await appendFile(resolve(root, "PRD.md"), "\n")

    await expect(
      executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      }),
    ).rejects.toThrow("PRD changed after completion was prepared")
    expect(backend.remaining()).toBe(0)
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [~] **deliver-capability")
    expect(listRuns(workspaceLayout(root).ledger)).toHaveLength(1)
  })

  test("reconciles every controlled completion crash boundary without another backend call", async () => {
    for (const point of [
      "after-completion-prepared",
      "after-completion-marker-file-written",
      "after-completion-marker-written",
    ] as const) {
      const root = await fixtureWorkspace("single-pass")
      const options = await optionsFor(root, {
        mode: "once",
        noChangePolicy: "require-change",
      })
      const backend = await scriptedBackend(root)
      let injected = false
      await expect(
        executeRun({
          workspaceRoot: root,
          prdFile: "PRD.md",
          effectiveOptions: options,
          dependencies: {
            resolveBackend: () => backend,
            fault: (current) => {
              if (current === point && !injected) {
                injected = true
                throw new Error(`injected ${point}`)
              }
            },
          },
        }),
      ).rejects.toThrow(`injected ${point}`)
      expect(backend.remaining()).toBe(0)

      const layout = workspaceLayout(root)
      const interruptedRun = listRuns(layout.ledger, { limit: 1 })[0]
      expect(interruptedRun?.status).toBe("interrupted")
      const resumed = await executeRun({
        workspaceRoot: root,
        prdFile: "PRD.md",
        effectiveOptions: options,
        dependencies: { resolveBackend: () => backend },
      })
      expect(resumed).toMatchObject({
        runId: interruptedRun?.id,
        status: "completed",
        exitCode: 0,
      })
      expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain(
        "- [x] **deliver-capability",
      )
      expect(listAttempts(layout.ledger, { runId: resumed.runId as string })).toHaveLength(1)
    }
  })
})
