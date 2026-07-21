import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { cp, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type CommandContext, executeCli, runCli } from "@ralph/commands"
import { AttemptRecordSchema, RunRecordSchema, TaskRecordSchema } from "@ralph/domain"
import { initializeWorkspace, workspaceLayout } from "@ralph/persistence"
import { EventEnvelopeSchema, type OutputWriters } from "@ralph/telemetry"
import { type ScriptedExecution, ScriptedExecutionBackend } from "@ralph/test-kit"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s03-cli-test"
const CLI_ENTRY = resolve(import.meta.dir, "../../apps/ralph-cli/src/main.ts")
const temporaryDirectories: string[] = []

setDefaultTimeout(60_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function fixtureWorkspace(name: string): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await cp(resolve("tests", "fixtures", "execution", name), root, { recursive: true })
  await initializeWorkspace(root, VERSION)
  return root
}

async function backendFor(root: string, file = "backend.json") {
  const script = JSON.parse(await readFile(resolve(root, file), "utf8")) as ScriptedExecution[]
  return new ScriptedExecutionBackend(script)
}

function commandContext(root: string, backend?: ScriptedExecutionBackend): CommandContext {
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
  }
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

describe("S03 public command handlers", () => {
  test("propagates a command-owned cancellation signal before executor I/O", async () => {
    const root = await fixtureWorkspace("single-pass")
    const backend = await backendFor(root)
    const controller = new AbortController()
    controller.abort(new Error("pre-cancelled command"))

    const result = await executeCli(
      ["once", "--workspace", root, "--dry-run", "--format", "json"],
      { ...commandContext(root, backend), signal: controller.signal },
    )

    expect(result.exitCode).toBe(8)
    expect(result.execution.result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "RALPH_EXECUTION_CANCELLED" }],
    })
    expect(backend.requests()).toHaveLength(0)
  })

  test("attach selects persisted state through a read-only UI port and requires a TTY", async () => {
    const root = await fixtureWorkspace("single-pass")
    const prdPath = resolve(root, "PRD.md")
    const fixturePrd = await readFile(prdPath, "utf8")
    const attachPrd = fixturePrd.replace("timeout=20s", "timeout=120s")
    if (attachPrd === fixturePrd) throw new Error("Attach fixture task timeout was not found")
    // This case validates attach/UI routing after a completed run, not the
    // shared fixture's short task deadline.
    await writeFile(prdPath, attachPrd, "utf8")
    const backend = await backendFor(root)
    const context = commandContext(root, backend)
    const executed = await executeCli(
      ["once", "--workspace", root, "--prd", "PRD.md", "--format", "json"],
      context,
    )
    expect(executed.exitCode).toBe(0)
    const runId = executed.execution.result.runId
    if (!runId) throw new Error("Attach fixture did not create a run")

    const headless = await executeCli(["attach", runId, "--workspace", root], context)
    expect(headless).toMatchObject({
      exitCode: 2,
      execution: { result: { diagnostics: [{ code: "RALPH_TUI_TTY_REQUIRED" }] } },
    })

    const requests: Array<{ workspaceRoot: string; runId: string }> = []
    const attached = await executeCli(["ui", "--workspace", root, "--run-id", runId], {
      ...context,
      interactive: true,
      runUi: {
        async attach(request) {
          requests.push({ workspaceRoot: request.workspaceRoot, runId: request.runId })
          return { runId: request.runId, observedStatus: "completed", closeReason: "user" }
        },
      },
    })
    expect(attached).toMatchObject({
      exitCode: 0,
      execution: {
        result: {
          command: "attach",
          runId,
          data: { attached: { runId, observedStatus: "completed", closeReason: "user" } },
        },
      },
    })
    expect(requests).toEqual([{ workspaceRoot: root, runId }])
  }, 60_000)

  test("dry-run exposes skip-policy provenance and exact impact without calling a skip passed", async () => {
    const root = await fixtureWorkspace("single-pass")
    const backend = await backendFor(root)
    const context = commandContext(root, backend)
    const args = [
      "run",
      "--workspace",
      root,
      "--mode",
      "once",
      "--dry-run",
      "--skip-tests",
      "--skip-lint",
      "--skip-gates",
      "contract-test",
      "--fast",
      "--force",
      "--fail-fast",
    ]
    const result = await executeCli([...args, "--format", "json"], context)
    expect(result.exitCode).toBe(0)
    const data = result.execution.result.data as {
      notices: string[]
      plan: { gatePolicy: { skipGates: string[] } }
    }
    expect(data.plan.gatePolicy.skipGates).toEqual(["contract-test"])
    expect(data.notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining("--skip-tests from cli (cli:--skip-tests)"),
        expect.stringContaining("--skip-lint from cli (cli:--skip-lint)"),
        expect.stringContaining("IDs/categories [contract-test]"),
        expect.stringContaining("--fast from cli (cli:--fast) expands"),
        expect.stringContaining("--force from cli (cli:--force)"),
        expect.stringContaining("--fail-fast from cli (cli:--fail-fast)"),
        expect.stringContaining("never passed"),
      ]),
    )
    expect(backend.requests()).toHaveLength(0)

    const capture = captureWriters()
    expect(await runCli(args, context, capture.writers)).toBe(0)
    expect(capture.stdout()).toContain("skip-gates=contract-test")
    expect(capture.stdout()).toContain("Notice:   --fast from cli")
  })

  test("generic run resolves explicit modes without erasing configuration defaults", async () => {
    const root = await fixtureWorkspace("single-pass")
    const backend = await backendFor(root)
    const context = commandContext(root, backend)

    for (const mode of ["once", "loop", "wiggum"] as const) {
      const result = await executeCli(
        ["run", "--workspace", root, "--mode", mode, "--dry-run", "--format", "json"],
        context,
      )
      expect(result.exitCode).toBe(0)
      expect(result.execution.result).toMatchObject({
        ok: true,
        command: "run",
        data: {
          mode,
          effectiveOptions: { mode: { value: mode, source: "cli", sourceRef: "cli:--mode" } },
        },
      })
    }

    await writeFile(workspaceLayout(root).config, "schema_version: 1\ndefaults:\n  mode: wiggum\n")
    const configured = await executeCli(
      ["run", "--workspace", root, "--dry-run", "--max-iterations", "2", "--format", "json"],
      context,
    )
    expect(configured.exitCode).toBe(0)
    expect(configured.execution.result).toMatchObject({
      ok: true,
      data: {
        mode: "wiggum",
        effectiveOptions: {
          mode: { value: "wiggum", source: "workspace" },
          maxIterations: { value: 2, source: "cli" },
        },
      },
    })
  })

  test("JSON and human output expose the options of the task actually planned", async () => {
    const root = await fixtureWorkspace("task-options")
    const firstBackend = await backendFor(root, "backend-one.json")
    const secondBackend = await backendFor(root, "backend-two.json")
    const context: CommandContext = {
      ...commandContext(root),
      resolveBackend: (profile) =>
        profile === "executor-one"
          ? firstBackend
          : profile === "executor-two"
            ? secondBackend
            : undefined,
    }
    const args = ["once", "--workspace", root, "--task", "second-profile", "--force", "--dry-run"]
    const json = await executeCli([...args, "--format", "json"], context)
    expect(json.exitCode).toBe(0)
    const data = json.execution.result.data as {
      plan: { backendProfile: string; task?: { taskId?: string } }
      effectiveOptions: {
        contentHash: string
        executorProfile: { value: string; source: string; sourceRef?: string }
      }
      optionsHash: string
    }
    expect(data.plan).toMatchObject({
      backendProfile: "executor-two",
      task: { taskId: "second-profile" },
    })
    expect(data.effectiveOptions.executorProfile).toEqual({
      value: "executor-two",
      source: "task",
      sourceRef: "task:task-options/second-profile",
    })
    expect(data.optionsHash).toBe(data.effectiveOptions.contentHash)

    const humanCapture = captureWriters()
    expect(await runCli(args, context, humanCapture.writers)).toBe(0)
    expect(humanCapture.stdout()).toContain("Backend:  executor-two (available)")
    expect(humanCapture.stdout()).toContain(`Options:  ${data.optionsHash}`)
    expect(firstBackend.requests()).toHaveLength(0)
    expect(secondBackend.requests()).toHaveLength(0)
  })

  test("explicit command spellings and --wiggum override configured generic mode", async () => {
    const root = await fixtureWorkspace("single-pass")
    const backend = await backendFor(root)
    const context = commandContext(root, backend)
    await writeFile(workspaceLayout(root).config, "schema_version: 1\ndefaults:\n  mode: wiggum\n")

    const once = await executeCli(
      ["once", "--workspace", root, "--dry-run", "--format", "json"],
      context,
    )
    const loop = await executeCli(
      ["loop", "--workspace", root, "--dry-run", "--format", "json"],
      context,
    )
    expect(once.execution.result).toMatchObject({
      data: { mode: "once", effectiveOptions: { mode: { value: "once", source: "cli" } } },
    })
    expect(loop.execution.result).toMatchObject({
      data: { mode: "loop", effectiveOptions: { mode: { value: "loop", source: "cli" } } },
    })

    await writeFile(workspaceLayout(root).config, "schema_version: 1\ndefaults:\n  mode: once\n")
    const wiggum = await executeCli(
      ["run", "--workspace", root, "--wiggum", "--dry-run", "--format", "json"],
      context,
    )
    expect(wiggum.execution.result).toMatchObject({
      data: { mode: "wiggum", effectiveOptions: { mode: { value: "wiggum", source: "cli" } } },
    })
  })

  test("generic run validates effective-mode-only Wiggum limits", async () => {
    const root = await fixtureWorkspace("single-pass")
    const result = await executeCli(
      ["run", "--workspace", root, "--max-iterations", "2", "--dry-run", "--format", "json"],
      commandContext(root),
    )

    expect(result.exitCode).toBe(2)
    expect(result.execution.result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "RALPH_OPTION_REQUIRES_WIGGUM" }],
    })
  })

  test("JSON integration preserves typed orchestration error codes and exit codes", async () => {
    const schedulingRoot = await fixtureWorkspace("single-pass")
    const schedulingCapture = captureWriters()
    expect(
      await runCli(
        [
          "once",
          "--task",
          "missing-task",
          "--workspace",
          schedulingRoot,
          "--dry-run",
          "--format",
          "json",
        ],
        commandContext(schedulingRoot),
        schedulingCapture.writers,
      ),
    ).toBe(2)
    expect(JSON.parse(schedulingCapture.stdout())).toMatchObject({
      ok: false,
      diagnostics: [{ code: "RALPH_TASK_NOT_FOUND" }],
    })

    const optionsRoot = await fixtureWorkspace("single-pass")
    await writeFile(
      workspaceLayout(optionsRoot).config,
      "schema_version: 1\nrun:\n  retry_delay_seconds: 9007199254740991\n",
    )
    const optionsCapture = captureWriters()
    expect(
      await runCli(
        ["run", "--workspace", optionsRoot, "--dry-run", "--format", "json"],
        commandContext(optionsRoot),
        optionsCapture.writers,
      ),
    ).toBe(2)
    expect(JSON.parse(optionsCapture.stdout())).toMatchObject({
      ok: false,
      diagnostics: [{ code: "RALPH_RETRY_DELAY_INVALID" }],
    })

    const contextRoot = await fixtureWorkspace("single-pass")
    const backend = await backendFor(contextRoot)
    let resolutions = 0
    const context: CommandContext = {
      ...commandContext(contextRoot),
      resolveBackend: async (profile) => {
        if (profile !== "fixture-executor") return undefined
        resolutions += 1
        return backend
      },
    }
    const contextCapture = captureWriters()
    expect(
      await runCli(
        ["run", "--workspace", contextRoot, "--wiggum", "--format", "json"],
        context,
        contextCapture.writers,
      ),
    ).toBe(0)
    expect(JSON.parse(contextCapture.stdout())).toMatchObject({
      ok: true,
      data: { status: "completed" },
    })
    expect(resolutions).toBe(1)
  }, 20_000)

  test("events JSONL preserves structured command errors and exit codes", async () => {
    const root = await fixtureWorkspace("single-pass")
    const capture = captureWriters()

    expect(
      await runCli(
        ["events", "--workspace", root, "--run-id", "missing-run", "--format", "jsonl"],
        commandContext(root),
        capture.writers,
      ),
    ).toBe(2)
    expect(capture.stderr()).toBe("")
    const lines = capture.stdout().trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "error",
      diagnostics: [{ code: "RALPH_RUN_NOT_FOUND" }],
    })
  })

  test("the product composition rejects fake instead of enabling a hidden backend", async () => {
    const root = await fixtureWorkspace("single-pass")
    const result = await executeCli(
      [
        "once",
        "--workspace",
        root,
        "--prd",
        "PRD.md",
        "--executor-profile",
        "fake",
        "--format",
        "json",
      ],
      commandContext(root),
    )

    expect(result.exitCode).toBe(6)
    expect(result.execution.result).toMatchObject({
      ok: false,
      command: "error",
      diagnostics: [{ code: "RALPH_EXECUTOR_PROFILE_UNAVAILABLE" }],
    })

    const productProcess = Bun.spawn(
      [
        process.execPath,
        CLI_ENTRY,
        "once",
        "--workspace",
        root,
        "--prd",
        "PRD.md",
        "--executor-profile",
        "fake",
        "--format",
        "json",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          RALPH_CONFIG_HOME: resolve(root, "subprocess-global-config"),
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const [productExitCode, productStdout, productStderr] = await Promise.all([
      productProcess.exited,
      new Response(productProcess.stdout).text(),
      new Response(productProcess.stderr).text(),
    ])
    expect(productExitCode).toBe(6)
    expect(productStderr).toBe("")
    expect(JSON.parse(productStdout)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "RALPH_EXECUTOR_PROFILE_UNAVAILABLE" }],
    })
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [ ] **deliver-capability")
  })

  test("an explicitly injected test composition executes and exposes ledger projections", async () => {
    const root = await fixtureWorkspace("single-pass")
    const backend = await backendFor(root)
    const context = commandContext(root, backend)
    const executionCapture = captureWriters()

    const executionExitCode = await runCli(
      ["once", "--workspace", root, "--prd", "PRD.md", "--format", "json"],
      context,
      executionCapture.writers,
    )
    expect({
      exitCode: executionExitCode,
      stdout: executionCapture.stdout(),
      stderr: executionCapture.stderr(),
    }).toMatchObject({ exitCode: 0, stderr: "" })
    const execution = JSON.parse(executionCapture.stdout()) as {
      ok: boolean
      runId: string
      data: {
        kind: string
        status: string
        effectiveOptions: {
          executorProfile: { value: string; source: string }
          mode: { value: string; source: string }
        }
        optionsHash: string
        notices: string[]
      }
    }
    expect(execution).toMatchObject({
      ok: true,
      data: {
        kind: "executed",
        status: "completed",
        effectiveOptions: {
          executorProfile: { value: "fixture-executor", source: "prd" },
          mode: { value: "once", source: "cli" },
        },
      },
    })
    expect(execution.data.optionsHash).toHaveLength(64)
    expect(execution.data.notices).toHaveLength(1)
    expect(await readFile(resolve(root, "product", "capability.txt"), "utf8")).toBe("delivered")
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [x] **deliver-capability")
    expect(backend.remaining()).toBe(0)

    const statusCapture = captureWriters()
    expect(
      await runCli(
        ["status", "run", "--workspace", root, "--run-id", execution.runId, "--json"],
        context,
        statusCapture.writers,
      ),
    ).toBe(0)
    const status = JSON.parse(statusCapture.stdout()) as {
      data: {
        run: { id: string; status: string }
        tasks: unknown[]
        progress: { completed: number; total: number }
        attempts: Array<{ id: string }>
      }
    }
    expect(status.data).toMatchObject({
      run: { id: execution.runId, status: "completed" },
      progress: { completed: 1, total: 1 },
    })
    expect(status.data.attempts).toHaveLength(1)
    expect(RunRecordSchema.safeParse(status.data.run).success).toBeTrue()
    expect(status.data.tasks.every((task) => TaskRecordSchema.safeParse(task).success)).toBeTrue()
    expect(
      status.data.attempts.every((attempt) => AttemptRecordSchema.safeParse(attempt).success),
    ).toBeTrue()
    const attemptId = status.data.attempts[0]?.id
    if (!attemptId) throw new Error("Completed run did not expose its attempt ID")

    const evidenceJsonCapture = captureWriters()
    expect(
      await runCli(
        ["evidence", "inspect", attemptId, "--workspace", root, "--format", "json"],
        context,
        evidenceJsonCapture.writers,
      ),
    ).toBe(0)
    expect(JSON.parse(evidenceJsonCapture.stdout())).toMatchObject({
      ok: true,
      command: "evidence.inspect",
      runId: execution.runId,
      data: {
        verified: true,
        attemptId,
        storage: {
          contentRef: expect.stringMatching(/evidence\/bundles\/sha256/),
          storageHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        bundle: {
          schemaVersion: 2,
          attemptId,
          task: { taskId: "deliver-capability" },
          toolCalls: [],
          truncations: [],
        },
      },
    })

    const evidenceHumanCapture = captureWriters()
    expect(
      await runCli(
        ["evidence", "inspect", attemptId, "--workspace", root, "--format", "human"],
        context,
        evidenceHumanCapture.writers,
      ),
    ).toBe(0)
    expect(evidenceHumanCapture.stdout()).toContain(`Attempt:   ${attemptId}`)
    expect(evidenceHumanCapture.stdout()).toContain("Schema:    v2")
    expect(evidenceHumanCapture.stdout()).toContain("Usage:")

    const workspaceStatusCapture = captureWriters()
    expect(
      await runCli(
        ["status", "--workspace", root, "--format", "json"],
        context,
        workspaceStatusCapture.writers,
      ),
    ).toBe(0)
    expect(JSON.parse(workspaceStatusCapture.stdout())).toMatchObject({
      ok: true,
      command: "status",
      data: { initialized: true },
    })
    const workspaceHumanStatus = captureWriters()
    expect(
      await runCli(
        ["status", "--workspace", root, "--format", "human", "--no-color"],
        context,
        workspaceHumanStatus.writers,
      ),
    ).toBe(0)
    expect(workspaceHumanStatus.stdout()).toContain("Runs:      1")
    expect(workspaceHumanStatus.stdout()).toContain(`Latest:    ${execution.runId} (completed)`)

    const eventsCapture = captureWriters()
    expect(
      await runCli(
        ["events", "--workspace", root, "--run-id", execution.runId, "--format", "jsonl"],
        context,
        eventsCapture.writers,
      ),
    ).toBe(0)
    expect(eventsCapture.stderr()).toBe("")
    const eventLines = eventsCapture.stdout().trim().split("\n")
    expect(eventLines.length).toBeGreaterThan(1)
    const events = eventLines.map((line) => EventEnvelopeSchema.parse(JSON.parse(line)))
    expect(events.every((event) => event.runId === execution.runId)).toBeTrue()
    expect(events.some((event) => event.type === "task.completed")).toBeTrue()

    const eventsJsonCapture = captureWriters()
    expect(
      await runCli(
        ["events", "--workspace", root, "--run-id", execution.runId, "--format", "json"],
        context,
        eventsJsonCapture.writers,
      ),
    ).toBe(0)
    const eventsJson = JSON.parse(eventsJsonCapture.stdout()) as {
      runId: string
      data: { count: number; events: Array<{ runId?: string; type: string }> }
    }
    expect(eventsJson.runId).toBe(execution.runId)
    expect(eventsJson.data.count).toBe(events.length)
    expect(eventsJson.data.events).toHaveLength(events.length)

    const reportCapture = captureWriters()
    expect(
      await runCli(
        ["report", "last", "--workspace", root, "--format", "json"],
        context,
        reportCapture.writers,
      ),
    ).toBe(0)
    expect(JSON.parse(reportCapture.stdout())).toMatchObject({
      ok: true,
      runId: execution.runId,
      data: {
        runId: execution.runId,
        status: "completed",
        counters: { tasksCompleted: 1, modelCalls: 1, gateRuns: 1 },
      },
    })

    const reportShowCapture = captureWriters()
    expect(
      await runCli(
        ["report", "show", execution.runId, "--workspace", root, "--format", "json"],
        context,
        reportShowCapture.writers,
      ),
    ).toBe(0)
    expect(JSON.parse(reportShowCapture.stdout())).toMatchObject({
      ok: true,
      command: "report.show",
      runId: execution.runId,
      data: { runId: execution.runId, status: "completed" },
    })
  }, 20_000)

  test("dry-run is human-readable and audits option origins without side effects", async () => {
    const root = await fixtureWorkspace("single-pass")
    const backend = await backendFor(root)
    const context = commandContext(root, backend)
    const humanCapture = captureWriters()

    expect(
      await runCli(
        [
          "run",
          "--workspace",
          root,
          "--prd",
          "PRD.md",
          "--wiggum",
          "--dry-run",
          "--retry-delay",
          "0.125",
          "--no-change-policy",
          "fallback",
        ],
        context,
        humanCapture.writers,
      ),
    ).toBe(0)
    expect(humanCapture.stdout()).toContain("Execution plan: planned")
    expect(humanCapture.stdout()).toContain("Mode:     wiggum")
    expect(humanCapture.stdout()).toContain("Progress: 0/1")
    expect(humanCapture.stdout()).toContain("Options:")
    expect(humanCapture.stdout()).toContain("Effects:  backend=yes, judge=no, attempt=yes")
    expect(humanCapture.stdout()).toContain("Gate:     deliver-capability:verification:1")
    expect(humanCapture.stdout()).toContain("command=bun -e")
    expect(humanCapture.stdout()).toContain("Children: none")
    expect(humanCapture.stdout()).toContain("Notice:")
    expect(humanCapture.stderr()).toContain("WARNING RALPH_RUN_OPTION_NOTICE")

    const jsonCapture = captureWriters()
    expect(
      await runCli(
        [
          "loop",
          "--workspace",
          root,
          "--prd",
          "PRD.md",
          "--dry-run",
          "--retry-delay",
          "0.125",
          "--no-change-policy",
          "fallback",
          "--judge-rubric",
          '{"criteria":[{"id":"delivery","description":"The delivery is complete.","weight":1}]}',
          "--format",
          "json",
        ],
        context,
        jsonCapture.writers,
      ),
    ).toBe(0)
    const output = JSON.parse(jsonCapture.stdout()) as {
      data: {
        kind: string
        mode: string
        effectiveOptions: {
          delayMs: { value: number; source: string }
          noChangePolicy: { value: string; original: string; source: string; notice: string }
          judgeRubric: {
            value: {
              weight_policy: string
              criteria: Array<{
                id: string
                description: string
                weight: number
                blocking: boolean
              }>
            }
            source: string
          }
        }
        notices: string[]
      }
    }
    expect(output.data).toMatchObject({
      kind: "dry-run",
      mode: "loop",
      effectiveOptions: {
        delayMs: { value: 125, source: "cli" },
        noChangePolicy: {
          value: "retry-on-no-change",
          original: "fallback",
          source: "cli",
        },
        judgeRubric: {
          value: {
            weight_policy: "normalize",
            criteria: [
              {
                id: "delivery",
                description: "The delivery is complete.",
                weight: 1,
                blocking: false,
              },
            ],
          },
          source: "cli",
        },
      },
    })
    expect(output.data.effectiveOptions.noChangePolicy.notice).toContain("does not switch")
    expect(output.data.notices).toHaveLength(1)
    expect(backend.remaining()).toBe(1)
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain("- [ ] **deliver-capability")
  })
})
