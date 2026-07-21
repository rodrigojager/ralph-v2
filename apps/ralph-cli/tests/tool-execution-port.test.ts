import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { AttemptCountersSchema, type EffectiveRunOptions, GitBaselineSchema } from "@ralph/domain"
import type { BackendEvent, ExecutionToolContext } from "@ralph/orchestration"
import { resolveEffectiveRunOptions } from "@ralph/orchestration"
import {
  createAttempt,
  createModelCall,
  createRun,
  initializeWorkspace,
  materializeRunTasks,
  runLayout,
  workspaceLayout,
} from "@ralph/persistence"
import type { ProviderJsonObject } from "@ralph/providers"
import { ToolSettlementSchema } from "@ralph/tool-host"
import { createTestDirectory, removeTestDirectory } from "../../../tests/helpers/temp-directory"
import {
  boundedSettlementOutput,
  commandRulesFromAllowedCommands,
  parseAllowedCommand,
  RalphExecutionToolPort,
  WorkspaceProcessOutputStore,
} from "../src/tool-execution-port"

const HASH_A = "a".repeat(64)
const HASH_B = "b".repeat(64)
const HASH_C = "c".repeat(64)
const NOW = "2026-07-18T18:00:00.000Z"
const temporaryDirectories: string[] = []

// The first case crosses SQLite, journal and atomic filesystem boundaries;
// five seconds is not a meaningful health budget on a contended Windows host.
setDefaultTimeout(30_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function executionFixture(initialToolCallsUsed = 0): Promise<{
  root: string
  options: EffectiveRunOptions
  events: BackendEvent[]
  context: ExecutionToolContext
}> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  const initialized = await initializeWorkspace(root, "0.1.0-test")
  const options = resolveEffectiveRunOptions({
    cli: {
      toolRules: { "artifact.publish": "allow" },
      readPaths: ["."],
      writePaths: ["."],
    },
  }).options
  const layout = workspaceLayout(root)
  createRun(layout.ledger, {
    id: "run-tools",
    schemaVersion: 1,
    workspaceId: initialized.workspaceId,
    rootPrdId: "root-prd",
    rootPrdFile: "PRD.md",
    definitionHash: HASH_A,
    graphHash: HASH_B,
    mode: "once",
    status: "running",
    effectiveOptionsHash: options.contentHash,
    effectiveOptions: options,
    createdAt: NOW,
    startedAt: NOW,
  })
  materializeRunTasks(layout.ledger, {
    runId: "run-tools",
    tasks: [
      {
        documentId: "root-prd",
        taskId: "vertical-slice",
        status: "active",
        markerContentHash: HASH_C,
      },
    ],
  })
  createAttempt(layout.ledger, {
    id: "attempt-tools",
    runId: "run-tools",
    documentId: "root-prd",
    taskId: "vertical-slice",
    ordinal: 1,
    phase: "invoking",
    status: "active",
    contextManifestHash: HASH_C,
    baseline: GitBaselineSchema.parse({
      schemaVersion: 1,
      kind: "workspace",
      revision: null,
      branch: null,
      dirty: false,
      statusHash: HASH_A,
      workspaceSnapshotHash: HASH_B,
      capturedAt: NOW,
    }),
    effectiveOptionsHash: options.contentHash,
    effectiveOptions: options,
    counters: AttemptCountersSchema.parse({
      modelCalls: 0,
      toolCalls: initialToolCallsUsed,
      wiggumIterations: 0,
      executorRetries: 0,
      judgeTransportRetries: 0,
      revisionAttempts: 0,
      noChangeAttempts: 0,
      gateRuns: 0,
    }),
    startedAt: NOW,
  })
  createModelCall(layout.ledger, {
    id: "model-call-tools",
    attemptId: "attempt-tools",
    ordinal: 1,
    requestHash: HASH_A,
    contextManifestHash: HASH_C,
    startedAt: NOW,
  })
  const events: BackendEvent[] = []
  return {
    root,
    options,
    events,
    context: {
      runId: "run-tools",
      documentId: "root-prd",
      taskId: "vertical-slice",
      attemptId: "attempt-tools",
      modelCallId: "model-call-tools",
      workspaceRoot: root,
      protectedPaths: ["PRD.md"],
      maximumToolCalls: 6,
      telemetry: {
        persist_raw_output: false,
        event_retention: null,
        redact: true,
      },
      security: {
        mode: options.securityMode.value,
        headlessAsk: options.headlessAsk.value,
        toolRules: options.toolRules.value,
        allowedCommands: ['bun test "apps/ralph-cli/tests/tool-execution-port.test.ts"'],
        readPaths: options.readPaths.value,
        writePaths: options.writePaths.value,
        allowShell: false,
        interactive: false,
      },
      environment: { ...process.env, RALPH_TEST_API_KEY: "port-secret-canary" },
      emit(event) {
        events.push(event)
      },
    },
  }
}

function providerCall(callId: string, name: string, input: ProviderJsonObject) {
  return {
    itemId: `item-${callId}`,
    callId,
    name,
    argumentsJson: JSON.stringify(input),
    input,
  }
}

describe("RalphExecutionToolPort", () => {
  test("maps builtins, durably executes a vertical write, publishes it, and denies PRD access", async () => {
    const fixture = await executionFixture()
    const port = new RalphExecutionToolPort({ now: () => NOW })
    const definitions = await port.materialize(fixture.context)
    expect(definitions).toHaveLength(10)
    expect(
      definitions.find((definition) => definition.name === "fs.write")?.inputSchema,
    ).toMatchObject({ type: "object", additionalProperties: false })

    const writeInput = {
      path: "deliverable.txt",
      content: "vertical port-secret-canary",
      precondition: { kind: "absent" },
      createParents: false,
    }
    const writeCall = providerCall("provider-write", "fs.write", writeInput)
    const written = await port.execute(writeCall, fixture.context)
    expect(written).toMatchObject({ callId: "provider-write", outcome: "success" })
    expect(written.output).not.toContain("port-secret-canary")
    expect(await Bun.file(`${fixture.root}/deliverable.txt`).text()).toBe(
      "vertical port-secret-canary",
    )

    // The same provider identity is idempotent across freshly composed hosts.
    expect(await port.execute(writeCall, fixture.context)).toEqual(written)

    const published = await port.execute(
      providerCall("provider-artifact", "artifact.publish", {
        artifactId: "deliverable.txt",
        path: "deliverable.txt",
        maximumBytes: 1_024,
      }),
      fixture.context,
    )
    expect(published.outcome).toBe("success")
    const artifact = `${runLayout(workspaceLayout(fixture.root), "run-tools").artifacts}/deliverable.txt`
    expect(await Bun.file(artifact).text()).toBe("vertical port-secret-canary")

    const protectedRead = await port.execute(
      providerCall("provider-protected", "fs.read", {
        path: "PRD.md",
        offsetBytes: 0,
        limitBytes: 100,
        encoding: "utf8",
      }),
      fixture.context,
    )
    expect(protectedRead.outcome).toBe("denied")
    expect(fixture.events.map((event) => event.type)).toContain("tool.call.started")
    expect(fixture.events.map((event) => event.type)).toContain("tool.call.settled")
    expect(JSON.stringify(fixture.events)).not.toContain("port-secret-canary")
  })

  test("parses configured commands as exact direct argv without implicit shell", () => {
    expect(
      parseAllowedCommand(`bun test "tests/unit/parser test.ts" --filter='vertical slice'`),
    ).toEqual({
      executable: "bun",
      args: ["test", "tests/unit/parser test.ts", "--filter=vertical slice"],
    })
    const [rule] = commandRulesFromAllowedCommands(["bun test && rm -rf ."])
    expect(rule).toMatchObject({
      executable: "bun",
      exactArgs: ["test", "&&", "rm", "-rf", "."],
      shell: false,
    })
    expect(() => parseAllowedCommand(`bun test "unterminated`)).toThrow("unterminated quote")
    expect(parseAllowedCommand(String.raw`"C:\Program Files\Bun\bun.exe" test`)).toEqual({
      executable: String.raw`C:\Program Files\Bun\bun.exe`,
      args: ["test"],
    })
  })

  test("adds the current per-model allowance to the durable attempt counter", async () => {
    const fixture = await executionFixture(2)
    fixture.context.maximumToolCalls = 1
    const port = new RalphExecutionToolPort({ now: () => NOW })
    const first = await port.execute(
      providerCall("provider-budget-one", "fs.write", {
        path: "one.txt",
        content: "one",
        precondition: { kind: "absent" },
        createParents: false,
      }),
      fixture.context,
    )
    expect(first.outcome).toBe("success")

    const second = await port.execute(
      providerCall("provider-budget-two", "fs.write", {
        path: "two.txt",
        content: "two",
        precondition: { kind: "absent" },
        createParents: false,
      }),
      fixture.context,
    )
    expect(second.outcome).toBe("denied")
    expect(second.output).toContain("RALPH_TOOL_BUDGET_EXHAUSTED")
    expect(await Bun.file(`${fixture.root}/one.txt`).exists()).toBeTrue()
    expect(await Bun.file(`${fixture.root}/two.txt`).exists()).toBeFalse()
  })

  test("rejects model-selected environment refs before process execution", async () => {
    const fixture = await executionFixture()
    fixture.context.environment = {
      ...fixture.context.environment,
      DATABASE_URL: "postgres://database-url-canary",
      NODE_OPTIONS: "--require=node-options-canary.js",
    }
    fixture.context.security.allowedCommands = [
      `bun -e "console.log(process.env.DATABASE_URL ?? 'missing')"`,
    ]
    const port = new RalphExecutionToolPort({ now: () => NOW })
    const processDefinition = (await port.materialize(fixture.context)).find(
      (definition) => definition.name === "process.exec",
    )
    expect(JSON.stringify(processDefinition?.inputSchema)).not.toContain("environmentRefs")

    const result = await port.execute(
      providerCall("provider-secret-env", "process.exec", {
        mode: "direct",
        executable: "bun",
        args: ["-e", "console.log(process.env.DATABASE_URL ?? 'missing')"],
        cwd: ".",
        environmentRefs: {
          DATABASE_URL: "env:DATABASE_URL",
          NODE_OPTIONS: "env:NODE_OPTIONS",
        },
      }),
      fixture.context,
    )
    expect(result.outcome).toBe("invalid")
    expect(result.output).toContain("Unrecognized key")
    expect(result.output).not.toContain("database-url-canary")
    expect(result.output).not.toContain("node-options-canary")
  })

  test("passes only command-owned operational environment to model-started processes", async () => {
    const fixture = await executionFixture()
    fixture.context.environment = {
      ...fixture.context.environment,
      DATABASE_URL: "postgres://database-url-canary",
      NODE_OPTIONS: "--require=node-options-canary.js",
    }
    const script =
      'console.log([process.env.DATABASE_URL ?? "missing", process.env.NODE_OPTIONS ?? "missing"].join("|"))'
    fixture.context.security.allowedCommands = [`bun -e '${script}'`]
    const port = new RalphExecutionToolPort({ now: () => NOW })

    const result = await port.execute(
      providerCall("provider-operational-env", "process.exec", {
        mode: "direct",
        executable: "bun",
        args: ["-e", script],
        cwd: ".",
      }),
      fixture.context,
    )

    expect(result.outcome).toBe("success")
    expect(result.output).toContain("missing|missing")
    expect(result.output).not.toContain("database-url-canary")
    expect(result.output).not.toContain("node-options-canary")
  })

  test("keeps oversized settlement metadata redacted at the model boundary", async () => {
    const outputText = boundedSettlementOutput(
      ToolSettlementSchema.parse({
        schemaVersion: 1,
        toolCallId: "tool-large-output",
        outcome: "success",
        content: { body: "x".repeat(1_100_000) },
        outputRefs: ["raw/port-secret-canary.log"],
        effects: [
          {
            kind: "read",
            path: "port-secret-canary.txt",
            ref: "artifact:port-secret-canary",
          },
        ],
        durationMs: 1,
        retryable: false,
        recovery: "effect-confirmed",
        reason: "metadata contains port-secret-canary",
        settledAt: NOW,
      }),
      ["port-secret-canary"],
    )
    const output = JSON.parse(outputText)

    expect(output.content).toMatchObject({ omitted: true })
    expect(output.outputRefs).toEqual(["raw/[REDACTED].log"])
    expect(output.effects).toEqual([
      {
        kind: "read",
        path: "[REDACTED].txt",
        ref: "artifact:[REDACTED]",
      },
    ])
    expect(output.reason).toBe("metadata contains [REDACTED]")
    expect(outputText).not.toContain("port-secret-canary")
  })

  test("persists bounded process output under the run and redacts supplied secrets", async () => {
    const fixture = await executionFixture()
    const store = new WorkspaceProcessOutputStore({
      workspaceRoot: fixture.root,
      runId: "run-tools",
      maximumBytes: 32,
      secretValues: ["port-secret-canary"],
    })
    const ref = await store.persist({
      processId: "pid/unsafe",
      stream: "stdout",
      content: `before port-secret-canary after ${"x".repeat(80)}`,
      truncated: false,
    })
    const reference = /^run-raw:\/\/run-tools\/process\/([a-f0-9]{64})\/stream$/u.exec(ref)
    expect(reference).not.toBeNull()
    const streamHash = reference?.[1]
    if (!streamHash) throw new Error("Process output did not return a valid opaque raw reference")

    const rawRoot = runLayout(workspaceLayout(fixture.root), "run-tools").raw
    const persisted = await Bun.file(
      join(rawRoot, "diagnostic", "processes", streamHash, "00000001.jsonl"),
    ).text()
    expect(persisted).not.toContain("port-secret-canary")
    const record = JSON.parse(persisted.trim()) as {
      data: string
      sourceTruncated?: boolean
    }
    expect(record.sourceTruncated).toBe(true)
    expect(Buffer.byteLength(record.data, "utf8")).toBeLessThanOrEqual(32)
  })
})
