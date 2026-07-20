import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type CommandContext, runCli } from "@ralph-next/commands"
import {
  type ExecuteRunInput,
  executeRun as executeRunInternal,
  type RunOptionOverrides,
  type RunOptionResolutionContext,
  resolveEffectiveRunOptions,
} from "@ralph-next/orchestration"
import {
  initializeWorkspace,
  listAttempts,
  listModelCalls,
  listRuns,
  listRunTasks,
  readEvents,
  workspaceLayout,
} from "@ralph-next/persistence"
import { compilePrdGraph } from "@ralph-next/prd"
import type { OutputWriters } from "@ralph-next/telemetry"
import { ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s03-control-flow-test"
const NO_CHANGE_POLICIES = [
  "require-change",
  "allow-no-change",
  "fail-on-no-change",
  "retry-on-no-change",
] as const
const temporaryDirectories: string[] = []

type TestExecuteRunInput = Omit<ExecuteRunInput, "optionResolution"> & {
  optionResolution?: RunOptionResolutionContext
}

function executeRun(input: TestExecuteRunInput) {
  const effective = input.effectiveOptions
  const cli: RunOptionOverrides = {
    ...(effective.mode.source === "cli" ? { mode: effective.mode.value } : {}),
    ...(effective.noChangePolicy.source === "cli"
      ? { noChangePolicy: effective.noChangePolicy.original ?? effective.noChangePolicy.value }
      : {}),
    ...(effective.maxNoChangeAttempts.source === "cli"
      ? { maxNoChangeAttempts: effective.maxNoChangeAttempts.value }
      : {}),
    ...(effective.maxIterations.source === "cli"
      ? { maxIterations: effective.maxIterations.value }
      : {}),
    ...(effective.maxModelCallsPerAttempt.source === "cli"
      ? { maxModelCallsPerAttempt: effective.maxModelCallsPerAttempt.value }
      : {}),
  }
  return executeRunInternal({
    ...input,
    optionResolution: input.optionResolution ?? { cli },
  })
}

setDefaultTimeout(60_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function fixtureWorkspace(): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await cp(resolve("tests", "fixtures", "execution", "single-pass"), root, { recursive: true })
  await initializeWorkspace(root, VERSION)
  return root
}

async function optionsFor(root: string, cli: RunOptionOverrides) {
  const compiled = await compilePrdGraph(resolve(root, "PRD.md"), {
    workspaceRoot: root,
    recursive: true,
    strict: true,
  })
  if (!compiled.ok || !compiled.graph) throw new Error("Expected the execution fixture to compile")
  const reference = compiled.graph.topologicalOrder[0]
  if (!reference) throw new Error("Expected one fixture task")
  const document = compiled.graph.documents[reference.documentId]
  const task = document?.tasks.find((candidate) => candidate.id === reference.taskId)
  if (!document || !task) throw new Error("Expected the compiled fixture task")
  return resolveEffectiveRunOptions({ document, task, cli }).options
}

function blockedBackend(summary = "A required external precondition is unavailable.") {
  return new ScriptedExecutionBackend([
    {
      expectedTask: "single-pass/deliver-capability",
      outcome: { status: "blocked_reported", summary },
    },
  ])
}

function captureWriters(): {
  writers: OutputWriters
  stdout: () => string
  stderr: () => string
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    writers: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  }
}

function commandContext(root: string, backend: ScriptedExecutionBackend): CommandContext {
  return {
    version: VERSION,
    cwd: root,
    environment: { RALPH_CONFIG_HOME: resolve(root, "isolated-global-config") },
    resolveBackend: (profile) => (profile === "fixture-executor" ? backend : undefined),
  }
}

async function durableSnapshot(root: string, runId?: string) {
  const layout = workspaceLayout(root)
  const ledger = await readFile(layout.ledger)
  return {
    prd: await readFile(resolve(root, "PRD.md"), "utf8"),
    ledgerHash: createHash("sha256").update(ledger).digest("hex"),
    runs: JSON.stringify(listRuns(layout.ledger)),
    tasks: runId ? JSON.stringify(listRunTasks(layout.ledger, runId)) : "[]",
    attempts: runId ? JSON.stringify(listAttempts(layout.ledger, { runId })) : "[]",
    events: JSON.stringify(readEvents(layout.ledger)),
  }
}

async function createWaitingRunThroughCli(root: string) {
  const backend = blockedBackend()
  const capture = captureWriters()
  const exitCode = await runCli(
    ["run", "--workspace", root, "--no-change-policy", "allow-no-change", "--format", "json"],
    commandContext(root, backend),
    capture.writers,
  )
  expect({ exitCode, stderr: capture.stderr() }).toEqual({ exitCode: 5, stderr: "" })
  const output = JSON.parse(capture.stdout()) as { runId?: string; data?: { status?: string } }
  expect(output.data?.status).toBe("waiting")
  if (!output.runId) throw new Error("Expected a waiting run ID")
  return output.runId
}

describe("S03 control-flow edge cases", () => {
  test("blocked_reported outranks every no-change policy in once and Wiggum", async () => {
    for (const mode of ["once", "wiggum"] as const) {
      for (const noChangePolicy of NO_CHANGE_POLICIES) {
        const root = await fixtureWorkspace()
        const backend = blockedBackend(`${mode}/${noChangePolicy} is externally blocked.`)
        const options = await optionsFor(root, {
          mode,
          noChangePolicy,
          maxNoChangeAttempts: 3,
          ...(mode === "wiggum" ? { maxIterations: 3, maxModelCallsPerAttempt: 3 } : {}),
        })
        const result = await executeRun({
          workspaceRoot: root,
          prdFile: "PRD.md",
          effectiveOptions: options,
          dependencies: {
            resolveBackend: () => backend,
            sleep: async () => undefined,
          },
        })
        if (!result.runId) throw new Error("Expected the blocked run ID")
        const layout = workspaceLayout(root)
        const attempts = listAttempts(layout.ledger, { runId: result.runId })
        const modelCalls = attempts.flatMap((attempt) => listModelCalls(layout.ledger, attempt.id))

        expect(result, `${mode}/${noChangePolicy}`).toMatchObject({
          status: "waiting",
          exitCode: 5,
          report: { counters: { tasksBlocked: 1, attempts: 1, modelCalls: 1 } },
        })
        expect(backend.requests(), `${mode}/${noChangePolicy}`).toHaveLength(1)
        expect(attempts, `${mode}/${noChangePolicy}`).toHaveLength(1)
        expect(modelCalls, `${mode}/${noChangePolicy}`).toHaveLength(1)
        expect(listRunTasks(layout.ledger, result.runId)[0]?.status).toBe("blocked")
        expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain(
          "- [~] **deliver-capability",
        )
      }
    }
  })

  test("reopening a waiting run with no eligible task preserves waiting without backend work", async () => {
    const root = await fixtureWorkspace()
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "allow-no-change",
    })
    const firstBackend = blockedBackend("The task remains blocked across reopen.")
    const first = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => firstBackend },
    })
    if (!first.runId) throw new Error("Expected the initial waiting run ID")
    const productBefore = await readFile(resolve(root, "product", "capability.txt"), "utf8")
    const secondBackend = new ScriptedExecutionBackend([
      {
        expectedTask: "single-pass/deliver-capability",
        actions: [{ type: "write", path: "product/capability.txt", content: "must-not-run" }],
      },
    ])
    let reopenResolverCalls = 0
    const reopened = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      runId: first.runId,
      effectiveOptions: options,
      dependencies: {
        resolveBackend: () => {
          reopenResolverCalls += 1
          return secondBackend
        },
      },
    })
    const layout = workspaceLayout(root)

    expect(reopened).toMatchObject({
      runId: first.runId,
      status: "waiting",
      exitCode: 5,
    })
    expect(secondBackend.requests()).toHaveLength(0)
    expect(secondBackend.remaining()).toBe(1)
    expect(reopenResolverCalls).toBe(0)
    expect(listRuns(layout.ledger)[0]?.status).toBe("waiting")
    expect(listAttempts(layout.ledger, { runId: first.runId })).toHaveLength(1)
    expect(await readFile(resolve(root, "product", "capability.txt"), "utf8")).toBe(productBefore)
  })

  test("rejects a blocked ledger task whose active marker was reverted to pending", async () => {
    const root = await fixtureWorkspace()
    const options = await optionsFor(root, {
      mode: "once",
      noChangePolicy: "allow-no-change",
    })
    const first = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      dependencies: { resolveBackend: () => blockedBackend() },
    })
    if (!first.runId) throw new Error("Expected the waiting run ID")
    const layout = workspaceLayout(root)
    const graphHashBefore = listRuns(layout.ledger)[0]?.graphHash
    const prdPath = resolve(root, "PRD.md")
    const activePrd = await readFile(prdPath, "utf8")
    expect(activePrd).toContain("- [~] **deliver-capability")
    await writeFile(
      prdPath,
      activePrd.replace("- [~] **deliver-capability", "- [ ] **deliver-capability"),
    )
    let resolverCalls = 0

    const conflict = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      runId: first.runId,
      effectiveOptions: options,
      dependencies: {
        resolveBackend: () => {
          resolverCalls += 1
          return blockedBackend()
        },
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect((conflict as { code?: string }).code).toBe("RALPH_EXECUTION_MARKER_LEDGER_CONFLICT")
    expect((conflict as { exitCode?: number }).exitCode).toBe(7)
    expect(resolverCalls).toBe(0)
    expect(listRuns(layout.ledger)[0]?.graphHash).toBe(graphHashBefore)
    expect(listRunTasks(layout.ledger, first.runId)[0]?.status).toBe("blocked")
  })

  test("dry-run --run-id plans from resumable state without mutating the PRD or ledger", async () => {
    const root = await fixtureWorkspace()
    const runId = await createWaitingRunThroughCli(root)
    const before = await durableSnapshot(root, runId)
    const backend = blockedBackend("Dry-run must not invoke this backend.")
    const capture = captureWriters()
    const exitCode = await runCli(
      [
        "run",
        "--workspace",
        root,
        "--run-id",
        runId,
        "--dry-run",
        "--no-change-policy",
        "allow-no-change",
        "--format",
        "json",
      ],
      commandContext(root, backend),
      capture.writers,
    )
    expect({ exitCode, stdout: capture.stdout(), stderr: capture.stderr() }).toMatchObject({
      exitCode: 0,
      stderr: "",
    })
    const output = JSON.parse(capture.stdout()) as {
      ok: boolean
      runId?: string
      data?: {
        kind?: string
        runId?: string
        status?: string
        reason?: string
        plan?: { task?: unknown }
      }
    }
    expect(output).toMatchObject({
      ok: true,
      runId,
      data: {
        kind: "dry-run",
        runId,
        status: "planned",
        reason: "No pending task is eligible; the resumable run remains waiting",
      },
    })
    expect(output.data?.plan?.task).toBeUndefined()
    expect(backend.requests()).toHaveLength(0)
    expect(await durableSnapshot(root, runId)).toEqual(before)
  })

  test("dry-run with a missing --run-id fails without mutating the PRD or ledger", async () => {
    const root = await fixtureWorkspace()
    const before = await durableSnapshot(root)
    const backend = blockedBackend("A missing run ID must not invoke this backend.")
    const capture = captureWriters()
    const exitCode = await runCli(
      ["run", "--workspace", root, "--run-id", "missing-run", "--dry-run", "--format", "json"],
      commandContext(root, backend),
      capture.writers,
    )

    expect(exitCode).toBe(2)
    expect(capture.stderr()).toBe("")
    expect(JSON.parse(capture.stdout())).toMatchObject({
      ok: false,
      diagnostics: [{ code: "RALPH_RESUMABLE_RUN_NOT_FOUND" }],
    })
    expect(backend.requests()).toHaveLength(0)
    expect(await durableSnapshot(root)).toEqual(before)
  })
})
