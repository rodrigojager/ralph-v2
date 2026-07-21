import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type CommandContext, executeCli } from "@ralph/commands"
import type {
  BackendCapabilities,
  CallHandle,
  ExecutionBackend,
  ExecutionChannel,
  ExecutionRequest,
  ExecutionToolPort,
} from "@ralph/orchestration"
import {
  getToolCallIntent,
  getToolCallSettlement,
  initializeWorkspace,
  listAttempts,
  listModelCalls,
  listRuns,
  listUnsettledToolCalls,
  type RecordToolCallIntentInput,
  readEvents,
  recordToolCallIntent,
  workspaceLayout,
} from "@ralph/persistence"
import { ScriptedExecutionBackend } from "@ralph/test-kit"
import { hashCanonical, sha256 } from "@ralph/tool-host"
import { createRalphExecutionToolPort } from "../../apps/ralph-cli/src/tool-execution-port"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s07-tool-reconciliation"
const TASK = "single-pass/deliver-capability"
const CRASH_REASON = "simulated crash after durable tool intents were persisted"
const WORKSPACE_MUTATION_RECOVERY_VERSION = "ralph.workspace-mutation-recovery.v1"
const temporaryDirectories: string[] = []
const CHANGE_ONLY_PRD = `---
ralph_prd: 2
id: single-pass
title: Tool reconciliation crash boundary
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: change-only
metadata:
  fixture: s07-tool-reconciliation
---

# Tool reconciliation crash boundary

## Vertical slices

- [ ] **deliver-capability — Reconcile the interrupted tool effects before new work**
  - Resultado: unsettled tool effects are settled or explicitly paused before another model call.
  - Dependências: nenhuma
  - Limites:
    - Never replay an effect whose durable identity or workspace hashes are ambiguous.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s
`

setDefaultTimeout(60_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

type IntentSpec = Pick<
  RecordToolCallIntentInput,
  | "id"
  | "providerToolCallId"
  | "tool"
  | "arguments"
  | "risk"
  | "effectClass"
  | "authorization"
  | "preconditionRefs"
>

type InterruptedFixture = {
  root: string
  ledger: string
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  modelCallId: string
}

function argumentsHash(argumentsValue: unknown): string {
  return hashCanonical("ralph.tool.arguments.v1", argumentsValue)
}

function workspaceMutationRefs(argumentsValue: unknown, content: string): string[] {
  const hash = argumentsHash(argumentsValue)
  return [
    WORKSPACE_MUTATION_RECOVERY_VERSION,
    `arguments:${hash}`,
    "targets:1",
    `after:0:${sha256(Buffer.from(content, "utf8"))}`,
  ]
}

class JournalCrashBackend implements ExecutionBackend {
  readonly id = "s07-journal-crash"
  readonly #ledger: string
  readonly #intents: readonly IntentSpec[]
  readonly #requests: ExecutionRequest[] = []

  constructor(ledger: string, intents: readonly IntentSpec[]) {
    this.#ledger = ledger
    this.#intents = intents
  }

  capabilities(): BackendCapabilities {
    return { streaming: true, toolCalling: false, cancellation: true, usage: "unavailable" }
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    this.#requests.push(request)
    const providerCallId = `s07-crash-provider-${request.modelCallId}`
    return {
      id: providerCallId,
      outcome: (async () => {
        await channel.reserveModelCall({ callId: providerCallId, turn: 1 })
        for (const [index, intent] of this.#intents.entries()) {
          recordToolCallIntent(this.#ledger, {
            ...intent,
            runId: request.runId,
            documentId: request.documentId,
            taskId: request.taskId,
            attemptId: request.attemptId,
            modelCallId: request.modelCallId,
            argumentsHash: argumentsHash(intent.arguments),
            requestedAt: new Date(Date.UTC(2026, 6, 19, 16, 0, index)).toISOString(),
          })
        }
        throw new Error(CRASH_REASON)
      })(),
    }
  }

  async cancel(): Promise<void> {}

  requests(): readonly ExecutionRequest[] {
    return [...this.#requests]
  }
}

class GuardedBackend implements ExecutionBackend {
  readonly id: string
  readonly #delegate: ExecutionBackend
  readonly #beforeStart: () => void
  starts = 0

  constructor(delegate: ExecutionBackend, beforeStart: () => void) {
    this.id = delegate.id
    this.#delegate = delegate
    this.#beforeStart = beforeStart
  }

  capabilities(): BackendCapabilities {
    return this.#delegate.capabilities()
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    this.starts += 1
    this.#beforeStart()
    return this.#delegate.start(request, channel)
  }

  async cancel(handle: CallHandle, reason: string): Promise<void> {
    await this.#delegate.cancel(handle, reason)
  }
}

function commandContext(input: {
  root: string
  backend: ExecutionBackend
  toolPort?: ExecutionToolPort
}): CommandContext {
  return {
    version: VERSION,
    cwd: input.root,
    environment: { RALPH_CONFIG_HOME: resolve(input.root, "isolated-global-config") },
    resolveBackend: (profile) => (profile === "fixture-executor" ? input.backend : undefined),
    ...(input.toolPort ? { toolPort: input.toolPort } : {}),
  }
}

function runArguments(root: string, runId?: string): string[] {
  return [
    "run",
    "--workspace",
    root,
    "--prd",
    "PRD.md",
    ...(runId ? ["--run-id", runId] : []),
    "--no-judge",
    "--no-change-policy",
    "allow-no-change",
    "--ui",
    "none",
    "--format",
    "json",
  ]
}

async function workspace(): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await cp(resolve(import.meta.dir, "../fixtures/execution/single-pass"), root, {
    recursive: true,
  })
  await writeFile(resolve(root, "PRD.md"), CHANGE_ONLY_PRD, "utf8")
  await initializeWorkspace(root, VERSION)
  return root
}

async function interruptAfterIntents(
  root: string,
  intents: readonly IntentSpec[],
): Promise<InterruptedFixture> {
  const ledger = workspaceLayout(root).ledger
  const backend = new JournalCrashBackend(ledger, intents)
  const result = await executeCli(runArguments(root), commandContext({ root, backend }))
  expect(result.exitCode).not.toBe(0)
  expect(backend.requests()).toHaveLength(1)

  const run = listRuns(ledger, { limit: 1 })[0]
  if (!run) throw new Error("Expected the simulated crash run to be persisted")
  expect(run.status).toBe("interrupted")
  expect(run.stopReason).toContain(CRASH_REASON)
  const attempt = listAttempts(ledger, { runId: run.id })[0]
  if (!attempt) throw new Error("Expected the simulated crash attempt to be persisted")
  const modelCall = listModelCalls(ledger, attempt.id)[0]
  if (!modelCall) throw new Error("Expected the simulated crash model call to be persisted")
  expect(listUnsettledToolCalls(ledger, { runId: run.id })).toHaveLength(intents.length)
  return {
    root,
    ledger,
    runId: run.id,
    documentId: attempt.documentId,
    taskId: attempt.taskId,
    attemptId: attempt.id,
    modelCallId: modelCall.id,
  }
}

function taskQuery(fixture: InterruptedFixture) {
  return {
    runId: fixture.runId,
    documentId: fixture.documentId,
    taskId: fixture.taskId,
  }
}

function backendThatMustObserveSettledJournal(fixture: InterruptedFixture): GuardedBackend {
  return new GuardedBackend(
    new ScriptedExecutionBackend([
      {
        expectedTask: TASK,
        actions: [
          {
            type: "write",
            path: "recovered/backend-started.txt",
            content: "backend-started-after-reconciliation",
          },
        ],
      },
    ]),
    () => expect(listUnsettledToolCalls(fixture.ledger, taskQuery(fixture))).toEqual([]),
  )
}

function backendThatMustNotStart(): GuardedBackend {
  return new GuardedBackend(new ScriptedExecutionBackend([{ expectedTask: TASK }]), () => {
    throw new Error("Model execution started before ambiguous tool effects were reconciled")
  })
}

function reconcileTwice(
  delegate: ExecutionToolPort,
  secondPasses: Array<readonly unknown[]>,
): ExecutionToolPort {
  return {
    async reconcile(context) {
      const first = await delegate.reconcile(context)
      const second = await delegate.reconcile(context)
      secondPasses.push(second)
      return first
    },
    materialize: (context) => delegate.materialize(context),
    execute: (call, context) => delegate.execute(call, context),
  }
}

function reconciliationEvents(fixture: InterruptedFixture) {
  return readEvents(fixture.ledger).filter(
    (event) => event.runId === fixture.runId && event.type.startsWith("tool.reconciliation."),
  )
}

describe("S07.07 crash-safe tool-call reconciliation", () => {
  test("replays reads and hash-proven absent writes, confirms post-hash effects, and is idempotent before model work", async () => {
    const root = await workspace()
    const presentContent = "already-applied"
    const replayedContent = "replayed-once"
    const presentArguments = {
      path: "recovered/present.txt",
      content: presentContent,
      precondition: { kind: "absent" as const },
      createParents: true,
    }
    const replayedArguments = {
      path: "recovered/replayed.txt",
      content: replayedContent,
      precondition: { kind: "absent" as const },
      createParents: true,
    }
    const readOnlyOriginal = await readFile(resolve(root, "product", "capability.txt"), "utf8")
    await mkdir(resolve(root, "recovered"), { recursive: true })
    await writeFile(resolve(root, "recovered", "present.txt"), presentContent, "utf8")

    const fixture = await interruptAfterIntents(root, [
      {
        id: "intent-safe-read",
        providerToolCallId: "provider-safe-read",
        tool: "fs.read",
        arguments: { path: "product/capability.txt" },
        risk: "read",
        effectClass: "read-only",
        authorization: "allowed",
        preconditionRefs: [],
      },
      {
        id: "intent-present-write",
        providerToolCallId: "provider-present-write",
        tool: "fs.write",
        arguments: presentArguments,
        risk: "write",
        effectClass: "workspace-write",
        authorization: "allowed",
        preconditionRefs: workspaceMutationRefs(presentArguments, presentContent),
      },
      {
        id: "intent-absent-write",
        providerToolCallId: "provider-absent-write",
        tool: "fs.write",
        arguments: replayedArguments,
        risk: "write",
        effectClass: "workspace-write",
        authorization: "allowed",
        preconditionRefs: workspaceMutationRefs(replayedArguments, replayedContent),
      },
    ])
    const persistedKeys = [
      getToolCallIntent(fixture.ledger, "intent-safe-read")?.idempotencyKey,
      getToolCallIntent(fixture.ledger, "intent-present-write")?.idempotencyKey,
      getToolCallIntent(fixture.ledger, "intent-absent-write")?.idempotencyKey,
    ]
    expect(new Set(persistedKeys).size).toBe(3)

    const secondPasses: Array<readonly unknown[]> = []
    const backend = backendThatMustObserveSettledJournal(fixture)
    const toolPort = reconcileTwice(createRalphExecutionToolPort(), secondPasses)
    const resumed = await executeCli(
      runArguments(root, fixture.runId),
      commandContext({ root, backend, toolPort }),
    )

    expect(resumed).toMatchObject({
      exitCode: 0,
      execution: { result: { runId: fixture.runId, data: { status: "completed" } } },
    })
    expect(backend.starts).toBe(1)
    expect(secondPasses).toEqual([[]])
    expect(listUnsettledToolCalls(fixture.ledger, taskQuery(fixture))).toEqual([])
    expect(await readFile(resolve(root, "product", "capability.txt"), "utf8")).toBe(
      readOnlyOriginal,
    )
    expect(await readFile(resolve(root, "recovered", "present.txt"), "utf8")).toBe(presentContent)
    expect(await readFile(resolve(root, "recovered", "replayed.txt"), "utf8")).toBe(replayedContent)
    expect(
      ["intent-safe-read", "intent-present-write", "intent-absent-write"].map(
        (intentId) => getToolCallSettlement(fixture.ledger, intentId)?.outcome,
      ),
    ).toEqual(["succeeded", "succeeded", "succeeded"])
    expect(
      ["intent-safe-read", "intent-present-write", "intent-absent-write"].map(
        (intentId) => getToolCallIntent(fixture.ledger, intentId)?.idempotencyKey,
      ),
    ).toEqual(persistedKeys)

    const events = reconciliationEvents(fixture)
    expect(events.filter((event) => event.type === "tool.reconciliation.started")).toHaveLength(1)
    expect(events.filter((event) => event.type === "tool.reconciliation.replayed")).toHaveLength(2)
    expect(
      events.filter((event) => event.type === "tool.reconciliation.effect-confirmed"),
    ).toHaveLength(1)
    expect(events.some((event) => event.type === "tool.reconciliation.paused")).toBeFalse()
    const allTypes = readEvents(fixture.ledger).map((event) => event.type)
    const resumeIndex = allTypes.lastIndexOf("run.resumed")
    const reconciliationIndex = allTypes.indexOf("tool.reconciliation.started", resumeIndex)
    const resumedModelIndex = allTypes.indexOf("model.call.started", reconciliationIndex)
    expect(resumeIndex).toBeGreaterThanOrEqual(0)
    expect(reconciliationIndex).toBeGreaterThan(resumeIndex)
    expect(resumedModelIndex).toBeGreaterThan(reconciliationIndex)
  })

  test("pauses a workspace write whose current hash matches neither its precondition nor postcondition", async () => {
    const root = await workspace()
    const expectedContent = "expected-after-crash"
    const argumentsValue = {
      path: "recovered/conflict.txt",
      content: expectedContent,
      precondition: { kind: "absent" as const },
      createParents: true,
    }
    await mkdir(resolve(root, "recovered"), { recursive: true })
    await writeFile(resolve(root, "recovered", "conflict.txt"), "unexpected-current", "utf8")
    const fixture = await interruptAfterIntents(root, [
      {
        id: "intent-conflicting-write",
        providerToolCallId: "provider-conflicting-write",
        tool: "fs.write",
        arguments: argumentsValue,
        risk: "write",
        effectClass: "workspace-write",
        authorization: "allowed",
        preconditionRefs: workspaceMutationRefs(argumentsValue, expectedContent),
      },
    ])
    const backend = backendThatMustNotStart()
    const resumed = await executeCli(
      runArguments(root, fixture.runId),
      commandContext({ root, backend, toolPort: createRalphExecutionToolPort() }),
    )

    expect(resumed.exitCode).not.toBe(0)
    expect(resumed.execution.result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "RALPH_TOOL_RECONCILIATION_REQUIRED" }),
      ]),
    )
    expect(backend.starts).toBe(0)
    expect(getToolCallSettlement(fixture.ledger, "intent-conflicting-write")).toBeUndefined()
    expect(listUnsettledToolCalls(fixture.ledger, taskQuery(fixture))).toHaveLength(1)
    expect(await readFile(resolve(root, "recovered", "conflict.txt"), "utf8")).toBe(
      "unexpected-current",
    )
    const paused = reconciliationEvents(fixture).find(
      (event) => event.type === "tool.reconciliation.paused",
    )
    expect(paused?.payload).toMatchObject({
      intentId: "intent-conflicting-write",
      strategy: "verify-preconditions",
      automatic: false,
    })
    expect(String(paused?.payload.reason)).toContain("Workspace preconditions conflict")
  })

  test("uses the durable process probe and pauses missing process identity plus ambiguous external effects without replay", async () => {
    const root = await workspace()
    const processMarker = resolve(root, "process-must-not-run.txt")
    const processArguments = {
      mode: "direct" as const,
      executable: process.execPath,
      args: [
        "-e",
        `await Bun.write(${JSON.stringify(processMarker)}, "unexpected process replay")`,
      ],
      cwd: ".",
    }
    const fixture = await interruptAfterIntents(root, [
      {
        id: "intent-external-effect",
        providerToolCallId: "provider-external-effect",
        tool: "artifact.publish",
        arguments: { artifactId: "ambiguous", path: "product/capability.txt" },
        risk: "external-effect",
        effectClass: "external-effect",
        authorization: "allowed",
        preconditionRefs: [],
      },
      {
        id: "intent-process-without-owner",
        providerToolCallId: "provider-process-without-owner",
        tool: "process.exec",
        arguments: processArguments,
        risk: "process",
        effectClass: "process",
        authorization: "allowed",
        preconditionRefs: [],
      },
    ])
    const backend = backendThatMustNotStart()
    const resumed = await executeCli(
      runArguments(root, fixture.runId),
      commandContext({ root, backend, toolPort: createRalphExecutionToolPort() }),
    )

    expect(resumed.exitCode).not.toBe(0)
    expect(resumed.execution.result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "RALPH_TOOL_RECONCILIATION_REQUIRED" }),
      ]),
    )
    expect(backend.starts).toBe(0)
    expect(await Bun.file(processMarker).exists()).toBeFalse()
    expect(getToolCallSettlement(fixture.ledger, "intent-external-effect")).toBeUndefined()
    expect(getToolCallSettlement(fixture.ledger, "intent-process-without-owner")).toBeUndefined()
    expect(listUnsettledToolCalls(fixture.ledger, taskQuery(fixture))).toHaveLength(2)

    const paused = reconciliationEvents(fixture).filter(
      (event) => event.type === "tool.reconciliation.paused",
    )
    expect(paused).toHaveLength(2)
    const external = paused.find((event) => event.payload.intentId === "intent-external-effect")
    const processProbe = paused.find(
      (event) => event.payload.intentId === "intent-process-without-owner",
    )
    expect(external?.payload).toMatchObject({
      strategy: "manual-reconciliation",
      automatic: false,
    })
    expect(String(external?.payload.reason)).toContain("ambiguous")
    expect(processProbe?.payload).toMatchObject({
      strategy: "inspect-process",
      automatic: false,
    })
    expect(String(processProbe?.payload.reason)).toContain(
      "No durable process lifecycle is bound to this intent",
    )
    expect(
      reconciliationEvents(fixture).some(
        (event) =>
          event.type === "tool.reconciliation.replayed" ||
          event.type === "tool.reconciliation.reattached",
      ),
    ).toBeFalse()
  })
})
