import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { type CommandContext, executeCli } from "@ralph-next/commands"
import { ExecutorOutcomeSchema } from "@ralph-next/domain"
import type {
  BackendCapabilities,
  CallHandle,
  ExecutionBackend,
  ExecutionChannel,
  ExecutionRequest,
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
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s07-watchdog-recovery"
const DOCUMENT_ID = "s07-watchdog-recovery"
const temporaryDirectories: string[] = []

setDefaultTimeout(60_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

type BackendStep = {
  taskId: string
  kind: "stall" | "unsettled" | "success" | "delayed-success"
  path: string
  content: string
  delayMs?: number
}

type PendingCall = {
  reject(error: Error): void
  settleOnCancel: boolean
}

class RecoveryBackend implements ExecutionBackend {
  readonly id = "s07-watchdog-recovery-backend"
  readonly #steps: BackendStep[]
  readonly #pending = new Map<string, PendingCall>()
  readonly requests: ExecutionRequest[] = []
  readonly trace: string[] = []

  constructor(steps: readonly BackendStep[]) {
    this.#steps = [...steps]
  }

  capabilities(): BackendCapabilities {
    return { streaming: true, toolCalling: false, cancellation: true, usage: "unavailable" }
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    const step = this.#steps.shift()
    if (!step) throw new Error("Recovery backend has no remaining step")
    if (`${request.documentId}/${request.taskId}` !== `${DOCUMENT_ID}/${step.taskId}`) {
      throw new Error(
        `Recovery backend expected ${DOCUMENT_ID}/${step.taskId}, received ${request.documentId}/${request.taskId}`,
      )
    }
    this.requests.push(request)
    const id = `recovery-${request.modelCallId}`
    this.trace.push(`start:${step.taskId}`)
    const outcome = (async () => {
      await channel.reserveModelCall({ callId: id, turn: 1 })
      await mkdir(dirname(resolve(request.workspaceRoot, step.path)), { recursive: true })
      if (step.kind === "delayed-success") {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, step.delayMs ?? 200))
      }
      await writeFile(resolve(request.workspaceRoot, step.path), step.content, "utf8")
      if (step.kind === "stall" || step.kind === "unsettled") {
        await new Promise<never>((_resolve, reject) => {
          this.#pending.set(id, { reject, settleOnCancel: step.kind === "stall" })
        })
      }
      return ExecutorOutcomeSchema.parse({
        schemaVersion: 1,
        status: "work_submitted",
        summary: `Completed ${step.taskId} after its command-owned watchdog boundary.`,
        intendedFiles: [step.path],
        artifactRefs: [],
        suggestedVerifications: [],
        risks: [],
        reportedAt: new Date().toISOString(),
      })
    })().finally(() => {
      this.#pending.delete(id)
      this.trace.push(`settled:${step.taskId}`)
    })
    void outcome.catch(() => undefined)
    return { id, outcome }
  }

  async cancel(handle: CallHandle, reason: string): Promise<void> {
    const pending = this.#pending.get(handle.id)
    this.trace.push(`cancel:${this.requests.find((request) => `recovery-${request.modelCallId}` === handle.id)?.taskId ?? "unknown"}`)
    if (pending?.settleOnCancel) {
      pending.reject(new Error(`Graceful watchdog cancellation: ${reason}`))
    }
  }

  remaining(): number {
    return this.#steps.length
  }
}

function prd(taskIds: readonly string[]): string {
  const tasks = taskIds
    .map(
      (taskId) => `- [ ] **${taskId} — Exercise bounded watchdog recovery**
  - Resultado: the task leaves a deterministic workspace delivery after recovery.
  - Dependências: nenhuma
  - Limites:
    - Preserve all partial workspace changes across watchdog actions.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum`,
    )
    .join("\n\n")
  return `---
ralph_prd: 2
id: ${DOCUMENT_ID}
title: Watchdog recovery actions
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: change-only
metadata:
  fixture: s07-watchdog-recovery-actions
---

# Watchdog recovery actions

## Vertical slices

${tasks}
`
}

function watchdogConfig(action: "notify" | "cancel" | "restart-attempt" | "stop-run", maxRestarts: number): string {
  return `schema_version: 1
watchdog:
  enabled: true
  heartbeat_interval: 10ms
  heartbeat_grace: 20ms
  quiet_after: 30ms
  slow_after: 40ms
  suspect_after: 60ms
  hard_timeout: 80ms
  probe_interval: 10ms
  confirmations: 2
  action: ${action}
  max_restarts: ${maxRestarts}
`
}

async function prepareWorkspace(input: {
  taskIds: readonly string[]
  action: "notify" | "cancel" | "restart-attempt" | "stop-run"
  maxRestarts: number
}): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await writeFile(resolve(root, "PRD.md"), prd(input.taskIds), "utf8")
  await initializeWorkspace(root, VERSION)
  await writeFile(
    workspaceLayout(root).config,
    watchdogConfig(input.action, input.maxRestarts),
    "utf8",
  )
  return root
}

function commandContext(root: string, backend: ExecutionBackend): CommandContext {
  return {
    version: VERSION,
    cwd: root,
    environment: { RALPH_CONFIG_HOME: resolve(root, "isolated-global-config") },
    resolveBackend: (profile) => (profile === "fixture-executor" ? backend : undefined),
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

function watchdogActions(root: string, runId: string) {
  return readEvents(workspaceLayout(root).ledger).filter(
    (event) => event.runId === runId && event.type === "watchdog.action",
  )
}

function actionDecision(event: ReturnType<typeof watchdogActions>[number]) {
  return event.payload.decision as {
    action?: string
    cause?: string
    watchdogRestartDelta?: number
    consumesJudgeRevision?: boolean
    preserveTask?: boolean
    preserveDiff?: boolean
    resumable?: boolean
  }
}

describe("S07.09 watchdog recovery actions", () => {
  test("notify records a stalled diagnostic without cancelling otherwise successful work", async () => {
    const root = await prepareWorkspace({ taskIds: ["notify-slice"], action: "notify", maxRestarts: 1 })
    const backend = new RecoveryBackend([
      {
        taskId: "notify-slice",
        kind: "delayed-success",
        delayMs: 180,
        path: "delivery/notify.txt",
        content: "completed-after-notify",
      },
    ])
    const result = await executeCli(
      runArguments(root),
      commandContext(root, backend),
    )

    expect(result).toMatchObject({ exitCode: 0, execution: { result: { data: { status: "completed" } } } })
    expect(backend.trace).toEqual(["start:notify-slice", "settled:notify-slice"])
    const runId = result.execution.result.runId as string
    const decisions = watchdogActions(root, runId).map(actionDecision)
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "notify", preserveTask: true, preserveDiff: true }),
      ]),
    )
    expect(await readFile(resolve(root, "delivery", "notify.txt"), "utf8")).toBe(
      "completed-after-notify",
    )
  })

  test("restart-attempt cancels before the next attempt and keeps max restarts scoped per task, separate from revisions", async () => {
    const root = await prepareWorkspace({
      taskIds: ["restart-one", "restart-two"],
      action: "restart-attempt",
      maxRestarts: 1,
    })
    const backend = new RecoveryBackend([
      { taskId: "restart-one", kind: "stall", path: "delivery/one.partial", content: "one-partial" },
      { taskId: "restart-one", kind: "success", path: "delivery/one.final", content: "one-final" },
      { taskId: "restart-two", kind: "stall", path: "delivery/two.partial", content: "two-partial" },
      { taskId: "restart-two", kind: "success", path: "delivery/two.final", content: "two-final" },
    ])
    const result = await executeCli(runArguments(root), commandContext(root, backend))

    expect(result).toMatchObject({ exitCode: 0, execution: { result: { data: { status: "completed" } } } })
    expect(backend.remaining()).toBe(0)
    expect(backend.trace).toEqual([
      "start:restart-one",
      "cancel:restart-one",
      "settled:restart-one",
      "start:restart-one",
      "settled:restart-one",
      "start:restart-two",
      "cancel:restart-two",
      "settled:restart-two",
      "start:restart-two",
      "settled:restart-two",
    ])
    const runId = result.execution.result.runId as string
    const attempts = listAttempts(workspaceLayout(root).ledger, { runId })
    for (const taskId of ["restart-one", "restart-two"]) {
      const taskAttempts = attempts.filter((attempt) => attempt.taskId === taskId)
      expect(taskAttempts).toHaveLength(2)
      expect(taskAttempts.reduce((sum, attempt) => sum + attempt.counters.watchdogRestarts, 0)).toBe(1)
      expect(taskAttempts.every((attempt) => attempt.counters.revisionAttempts === 0)).toBeTrue()
      const resumedRequest = backend.requests.filter((request) => request.taskId === taskId)[1]
      expect(resumedRequest?.contextBundle.canonicalJson).toContain(`${taskId === "restart-one" ? "one" : "two"}.partial`)
    }
    expect(
      watchdogActions(root, runId)
        .map(actionDecision)
        .filter((decision) => decision.action === "restart-attempt"),
    ).toHaveLength(2)
  })

  test("does not overlap a restart when the cancelled backend cannot confirm terminal settlement", async () => {
    const root = await prepareWorkspace({
      taskIds: ["unsettled-slice"],
      action: "restart-attempt",
      maxRestarts: 1,
    })
    const backend = new RecoveryBackend([
      {
        taskId: "unsettled-slice",
        kind: "unsettled",
        path: "delivery/unsettled.partial",
        content: "partial-with-unknown-owner",
      },
      {
        taskId: "unsettled-slice",
        kind: "success",
        path: "delivery/unsettled.final",
        content: "must-not-overlap",
      },
    ])
    const result = await executeCli(runArguments(root), commandContext(root, backend))

    expect(result.exitCode).not.toBe(0)
    const runId = result.execution.result.runId as string
    expect(backend.trace).toEqual(["start:unsettled-slice", "cancel:unsettled-slice"])
    expect(backend.remaining()).toBe(1)
    const attempt = listAttempts(workspaceLayout(root).ledger, { runId })[0]
    expect(attempt ? listModelCalls(workspaceLayout(root).ledger, attempt.id)[0] : undefined).toMatchObject({
      status: "started",
    })
    expect(
      readEvents(workspaceLayout(root).ledger).some(
        (event) =>
          event.runId === runId && event.type === "attempt.watchdog_restart_deferred",
      ),
    ).toBeTrue()
    expect(await Bun.file(resolve(root, "delivery", "unsettled.final")).exists()).toBeFalse()
  }, 30_000)

  test("cancel defers only the affected task, preserves its diff, and resumes the same run", async () => {
    const root = await prepareWorkspace({
      taskIds: ["cancelled-slice", "independent-slice"],
      action: "cancel",
      maxRestarts: 1,
    })
    const firstBackend = new RecoveryBackend([
      { taskId: "cancelled-slice", kind: "stall", path: "delivery/cancel.partial", content: "partial" },
      { taskId: "independent-slice", kind: "success", path: "delivery/independent.txt", content: "independent" },
    ])
    const first = await executeCli(runArguments(root), commandContext(root, firstBackend))
    expect(first.exitCode).not.toBe(0)
    const runId = first.execution.result.runId as string
    expect(firstBackend.trace).toEqual([
      "start:cancelled-slice",
      "cancel:cancelled-slice",
      "settled:cancelled-slice",
      "start:independent-slice",
      "settled:independent-slice",
    ])
    expect(
      listRunTasks(workspaceLayout(root).ledger, runId).map((task) => [task.taskId, task.status]),
    ).toEqual([
      ["cancelled-slice", "interrupted"],
      ["independent-slice", "completed"],
    ])
    expect(await readFile(resolve(root, "delivery", "cancel.partial"), "utf8")).toBe("partial")

    const resumeBackend = new RecoveryBackend([
      { taskId: "cancelled-slice", kind: "success", path: "delivery/cancel.final", content: "final" },
    ])
    const resumed = await executeCli(
      runArguments(root, runId),
      commandContext(root, resumeBackend),
    )
    expect(resumed).toMatchObject({
      exitCode: 0,
      execution: { result: { runId, data: { status: "completed" } } },
    })
    expect(resumeBackend.requests[0]?.contextBundle.canonicalJson).toContain("cancel.partial")
    expect(await readFile(resolve(root, "delivery", "cancel.partial"), "utf8")).toBe("partial")
  })

  test("restart exhaustion selects stop-run without spending a revision and remains resumable", async () => {
    const root = await prepareWorkspace({
      taskIds: ["exhausted-slice", "not-started-slice"],
      action: "restart-attempt",
      maxRestarts: 0,
    })
    const firstBackend = new RecoveryBackend([
      { taskId: "exhausted-slice", kind: "stall", path: "delivery/exhausted.partial", content: "partial" },
    ])
    const first = await executeCli(runArguments(root), commandContext(root, firstBackend))
    expect(first.exitCode).not.toBe(0)
    const runId = first.execution.result.runId as string
    expect(firstBackend.trace).toEqual([
      "start:exhausted-slice",
      "cancel:exhausted-slice",
      "settled:exhausted-slice",
    ])
    const decision = watchdogActions(root, runId)
      .map(actionDecision)
      .find((candidate) => candidate.cause === "restart-budget-exhausted")
    expect(decision).toMatchObject({
      action: "stop-run",
      cause: "restart-budget-exhausted",
      watchdogRestartDelta: 0,
      consumesJudgeRevision: false,
      preserveTask: true,
      preserveDiff: true,
      resumable: true,
    })
    const firstAttempts = listAttempts(workspaceLayout(root).ledger, { runId })
    expect(firstAttempts).toHaveLength(1)
    expect(firstAttempts[0]?.counters).toMatchObject({ watchdogRestarts: 0, revisionAttempts: 0 })
    expect(firstBackend.requests.some((request) => request.taskId === "not-started-slice")).toBeFalse()

    const resumeBackend = new RecoveryBackend([
      { taskId: "exhausted-slice", kind: "success", path: "delivery/exhausted.final", content: "final" },
      { taskId: "not-started-slice", kind: "success", path: "delivery/second.final", content: "second" },
    ])
    const resumed = await executeCli(
      runArguments(root, runId),
      commandContext(root, resumeBackend),
    )
    expect(resumed).toMatchObject({
      exitCode: 0,
      execution: { result: { runId, data: { status: "completed" } } },
    })
    expect(resumeBackend.requests[0]?.contextBundle.canonicalJson).toContain("exhausted.partial")
    expect(listRuns(workspaceLayout(root).ledger, { limit: 1 })[0]?.status).toBe("completed")
  })
})
