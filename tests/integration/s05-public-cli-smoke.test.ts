import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { type CommandContext, executeCli, runCli } from "@ralph-next/commands"
import { FakeSecretStore } from "@ralph-next/credentials"
import { RoleProfileConfigSchema } from "@ralph-next/domain"
import { JUDGE_OUTPUT_JSON_ADAPTER_ID } from "@ralph-next/model-drivers"
import type { FetchLike } from "@ralph-next/openai-driver"
import { initializeWorkspace, listRuns, workspaceLayout } from "@ralph-next/persistence"
import { EventEnvelopeSchema, type OutputWriters } from "@ralph-next/telemetry"
import { stringify } from "yaml"

import { createS04Services, type S04Services } from "../../apps/ralph-cli/src/s04-services"
import { createS05Services, type S05Services } from "../../apps/ralph-cli/src/s05-services"

const VERSION = "0.1.0-s05-public-cli-smoke"
const EXECUTION_FIXTURE = resolve(import.meta.dir, "../fixtures/execution/single-pass")
const EXTERNAL_PROTOCOL_FIXTURE = resolve(
  import.meta.dir,
  "../fixtures/s05/external-protocol-fixture.ts",
)
const temporaryDirectories: string[] = []

setDefaultTimeout(20_000)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

class TrackingSecretStore extends FakeSecretStore {
  calls = 0

  override async probe() {
    this.calls += 1
    return super.probe()
  }

  override async put(locator: string, secret: string): Promise<void> {
    this.calls += 1
    return super.put(locator, secret)
  }

  override async get(locator: string): Promise<string | undefined> {
    this.calls += 1
    return super.get(locator)
  }

  override async has(locator: string): Promise<boolean> {
    this.calls += 1
    return super.has(locator)
  }

  override async delete(locator: string): Promise<void> {
    this.calls += 1
    return super.delete(locator)
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

function externalProfile(executable: string, args: readonly string[]) {
  return RoleProfileConfigSchema.parse({
    role: "executor",
    backend: "external-cli",
    provider: "external-fixture",
    model: "protocol-v1",
    parameters: {},
    requirements: {},
    fallback_profiles: [],
    fallback_on: [],
    limits: {},
    external_cli: {
      executable,
      args,
      cwd: ".",
      environment_refs: {},
      input_mode: "stdin-json",
      adapter: "protocol",
      capabilities: {
        streaming: false,
        tool_calling: "ralph",
        cancellation: true,
        usage: "unavailable",
      },
      mutation_mode: "read-only",
      timeout_ms: 10_000,
      output_limit_bytes: 1_048_576,
    },
  })
}

function externalJudgeProfile() {
  return RoleProfileConfigSchema.parse({
    role: "judge",
    backend: "external-cli",
    provider: "external-fixture",
    model: "judge-v1",
    parameters: {},
    requirements: { structured_output: true },
    fallback_profiles: [],
    fallback_on: [],
    limits: {},
    external_cli: {
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: ".",
      environment_refs: {},
      input_mode: "stdin-json",
      adapter: "known-output",
      adapter_id: JUDGE_OUTPUT_JSON_ADAPTER_ID,
      capabilities: {
        streaming: false,
        tool_calling: "unavailable",
        cancellation: true,
        usage: "unavailable",
      },
      mutation_mode: "read-only",
      timeout_ms: 10_000,
      output_limit_bytes: 1_048_576,
    },
  })
}

type PublicComposition = {
  root: string
  context: CommandContext
  keychain: TrackingSecretStore
  networkCalls: () => number
  catalogCalls: () => number
}

async function publicComposition(): Promise<PublicComposition> {
  const root = await temporaryDirectory("ralph-s05-public-cli-")
  const dataRoot = await temporaryDirectory("ralph-s05-public-data-")
  await cp(EXECUTION_FIXTURE, root, { recursive: true })
  await unlink(resolve(root, "product", "capability.txt"))
  await initializeWorkspace(root, VERSION)

  const prdPath = resolve(root, "PRD.md")
  await writeFile(
    prdPath,
    (await readFile(prdPath, "utf8")).replace(
      "model_calls=1; timeout=20s",
      "model_calls=3; tool_calls=2; timeout=20s",
    ),
  )

  const missingExecutable = `ralph-s05-missing-${crypto.randomUUID()}.exe`
  await writeFile(
    workspaceLayout(root).config,
    stringify({
      schema_version: 1,
      profiles: {
        "fixture-executor": externalProfile(process.execPath, [EXTERNAL_PROTOCOL_FIXTURE]),
        "missing-executor": externalProfile(missingExecutable, []),
        "fixture-judge": externalJudgeProfile(),
      },
      security: {
        mode: "auto",
        headless_ask: "deny",
        tool_rules: { "fs.write": "allow" },
        allowed_commands: [],
        read_paths: ["."],
        write_paths: ["product"],
        allow_shell: false,
      },
    }),
  )

  const keychain = new TrackingSecretStore()
  let networkCallCount = 0
  let catalogCallCount = 0
  const modelFetch: FetchLike = async () => {
    networkCallCount += 1
    throw new Error("S05 public CLI smoke attempted model network I/O")
  }
  const environment = {
    RALPH_CONFIG_HOME: resolve(dataRoot, "isolated-global-config"),
  }
  const s04: S04Services = createS04Services({
    environment,
    dataRoot,
    keychainStore: keychain,
    modelFetch,
    catalogFactory: async () => {
      catalogCallCount += 1
      throw new Error("S05 public CLI smoke attempted catalog resolution")
    },
  })
  const s05: S05Services = createS05Services({ s04, environment })
  const context: CommandContext = {
    version: VERSION,
    cwd: root,
    environment,
    resolveModelCatalog: s04.resolveModelCatalog,
    credentials: s04.credentials,
    profileForm: s04.profileForm,
    modelSmoke: s04.modelSmoke,
    resolveBackend: s05.resolveBackend,
    resolveJudge: s05.resolveJudge,
    toolPort: s05.toolPort,
  }
  return {
    root,
    context,
    keychain,
    networkCalls: () => networkCallCount,
    catalogCalls: () => catalogCallCount,
  }
}

describe("S05 public CLI composition", () => {
  test("runs once headlessly through the real external protocol and exposes ordered JSONL events", async () => {
    const composition = await publicComposition()
    const executionCapture = captureWriters()

    const exitCode = await runCli(
      [
        "once",
        "--workspace",
        composition.root,
        "--prd",
        "PRD.md",
        "--executor-profile",
        "fixture-executor",
        "--headless-ask",
        "deny",
        "--format",
        "json",
      ],
      composition.context,
      executionCapture.writers,
    )

    expect(exitCode).toBe(0)
    expect(executionCapture.stderr()).toBe("")
    const execution = JSON.parse(executionCapture.stdout()) as {
      ok: boolean
      command: string
      runId: string
      data: {
        kind: string
        status: string
        effectiveOptions: {
          executorProfile: { value: string; source: string }
          headlessAsk: { value: string; source: string }
        }
      }
    }
    expect(execution).toMatchObject({
      ok: true,
      command: "once",
      data: {
        kind: "executed",
        status: "completed",
        effectiveOptions: {
          executorProfile: { value: "fixture-executor", source: "cli" },
          headlessAsk: { value: "deny", source: "cli" },
        },
      },
    })
    expect(await readFile(resolve(composition.root, "product", "capability.txt"), "utf8")).toBe(
      "delivered",
    )
    expect(await readFile(resolve(composition.root, "PRD.md"), "utf8")).toContain(
      "- [x] **deliver-capability",
    )

    const eventsCapture = captureWriters()
    expect(
      await runCli(
        [
          "events",
          "--workspace",
          composition.root,
          "--run-id",
          execution.runId,
          "--format",
          "jsonl",
        ],
        composition.context,
        eventsCapture.writers,
      ),
    ).toBe(0)
    expect(eventsCapture.stderr()).toBe("")
    const events = eventsCapture
      .stdout()
      .trim()
      .split(/\r?\n/)
      .map((line) => EventEnvelopeSchema.parse(JSON.parse(line)))
    expect(events.length).toBeGreaterThan(1)
    expect(events.every((event) => event.runId === execution.runId)).toBeTrue()
    expect(events.some((event) => event.type === "external.cli.started")).toBeTrue()
    expect(events.some((event) => event.type === "tool.call.settled")).toBeTrue()
    const completion = events.find((event) => event.type === "task.completed")
    const completedGates = events.filter((event) => event.type === "gate.completed")
    expect(completion).toBeDefined()
    expect(completedGates.length).toBeGreaterThan(0)
    expect(completedGates.every((gate) => gate.sequence < (completion?.sequence ?? 0))).toBeTrue()
    expect(
      events.some(
        (event) =>
          event.type === "verification.decision" && event.sequence < (completion?.sequence ?? 0),
      ),
    ).toBeTrue()
    expect(composition.networkCalls()).toBe(0)
    expect(composition.catalogCalls()).toBe(0)
    expect(composition.keychain.calls).toBe(0)
  })

  test("dry-run remains side-effect free and reports a missing external executable as unavailable", async () => {
    const composition = await publicComposition()
    const dryRunCapture = captureWriters()

    expect(
      await runCli(
        [
          "once",
          "--workspace",
          composition.root,
          "--prd",
          "PRD.md",
          "--executor-profile",
          "fixture-executor",
          "--headless-ask",
          "deny",
          "--dry-run",
          "--format",
          "json",
        ],
        composition.context,
        dryRunCapture.writers,
      ),
    ).toBe(0)
    expect(JSON.parse(dryRunCapture.stdout())).toMatchObject({
      ok: true,
      command: "once",
      data: {
        kind: "dry-run",
        status: "planned",
        plan: {
          backendAvailable: true,
          effects: {
            writesDuringDryRun: false,
          },
        },
      },
    })

    const unavailable = await executeCli(
      [
        "once",
        "--workspace",
        composition.root,
        "--prd",
        "PRD.md",
        "--executor-profile",
        "missing-executor",
        "--headless-ask",
        "deny",
        "--dry-run",
        "--format",
        "json",
      ],
      composition.context,
    )
    expect(unavailable.exitCode).toBe(6)
    expect(unavailable.execution.result).toMatchObject({
      ok: false,
      command: "once",
      data: {
        kind: "dry-run",
        status: "planned",
        plan: { backendAvailable: false },
      },
    })
    expect(
      unavailable.execution.result.diagnostics?.some(
        (diagnostic) => diagnostic.code === "RALPH_EXECUTOR_PROFILE_UNAVAILABLE",
      ),
    ).toBeTrue()
    expect(composition.networkCalls()).toBe(0)
    expect(composition.catalogCalls()).toBe(0)
    expect(composition.keychain.calls).toBe(0)
    expect(listRuns(workspaceLayout(composition.root).ledger)).toHaveLength(0)
    expect(
      await Bun.file(resolve(composition.root, "product", "capability.txt")).exists(),
    ).toBeFalse()
    expect(await readFile(resolve(composition.root, "PRD.md"), "utf8")).toContain(
      "- [ ] **deliver-capability",
    )
  })

  test("forwards the composition-root judge resolver into dry-run availability planning", async () => {
    const composition = await publicComposition()
    const capture = captureWriters()

    const exitCode = await runCli(
      [
        "once",
        "--dry-run",
        "--workspace",
        composition.root,
        "--prd",
        "PRD.md",
        "--executor-profile",
        "fixture-executor",
        "--evaluation",
        "external",
        "--judge-profile",
        "fixture-judge",
        "--format",
        "json",
      ],
      composition.context,
      capture.writers,
    )

    expect(exitCode).toBe(0)
    const result = JSON.parse(capture.stdout()) as {
      data: {
        plan: {
          evaluation: { mode: string; judgeProfile?: string; judgeAvailable?: boolean }
          effects: { invokesJudge: boolean; writesDuringDryRun: boolean }
        }
      }
    }
    expect(result.data.plan.evaluation).toMatchObject({
      mode: "external",
      judgeProfile: "fixture-judge",
      judgeAvailable: true,
    })
    expect(result.data.plan.effects).toMatchObject({
      invokesJudge: true,
      writesDuringDryRun: false,
    })
    expect(composition.networkCalls()).toBe(0)
    expect(composition.catalogCalls()).toBe(0)
    expect(composition.keychain.calls).toBe(0)
  })
})
