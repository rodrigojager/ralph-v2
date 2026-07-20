import { afterEach, describe, expect, test } from "bun:test"
import { cp, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { ContextBudgetSchema, GitBaselineSchema } from "@ralph-next/domain"
import {
  type BackendEvent,
  buildContextManifest,
  type ExecutionChannel,
  type ExecutionRequest,
} from "@ralph-next/orchestration"
import { compilePrdGraph } from "@ralph-next/prd"
import { ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const FIXTURE = resolve("tests", "fixtures", "execution", "single-pass")
const HASH = "a".repeat(64)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function executionRequest(): Promise<{
  request: ExecutionRequest
  events: BackendEvent[]
  originalPrd: string
}> {
  const workspaceRoot = await createTestDirectory()
  temporaryDirectories.push(workspaceRoot)
  await cp(FIXTURE, workspaceRoot, { recursive: true })
  const prdFile = resolve(workspaceRoot, "PRD.md")
  const compiled = await compilePrdGraph(prdFile, {
    workspaceRoot,
    recursive: true,
    strict: true,
  })
  if (!compiled.ok || !compiled.graph) throw new Error("Expected backend fixture to compile")
  const reference = compiled.graph.topologicalOrder[0]
  const task = reference
    ? compiled.graph.documents[reference.documentId]?.tasks.find(
        (candidate) => candidate.id === reference.taskId,
      )
    : undefined
  if (!reference || !task) throw new Error("Expected one backend fixture task")

  const context = await buildContextManifest({
    graph: compiled.graph,
    task: reference,
    runId: "run-scripted-backend",
    attemptId: "attempt-scripted-backend",
    mode: "once",
    baseline: GitBaselineSchema.parse({
      schemaVersion: 1,
      kind: "workspace",
      revision: null,
      branch: null,
      dirty: false,
      statusHash: HASH,
      workspaceSnapshotHash: HASH,
      capturedAt: "2026-07-18T12:00:00.000Z",
    }),
    budget: ContextBudgetSchema.parse({
      remainingModelCalls: 1,
      remainingToolCalls: 0,
      remainingIterations: 1,
    }),
    createdAt: "2026-07-18T12:00:01.000Z",
  })
  const events: BackendEvent[] = []
  return {
    request: {
      runId: "run-scripted-backend",
      documentId: reference.documentId,
      taskId: reference.taskId,
      attemptId: "attempt-scripted-backend",
      modelCallId: "model-call-scripted-backend",
      callOrdinal: 1,
      workspaceRoot,
      contextManifest: context.manifest,
      contextBundle: context,
      task,
      protectedPaths: ["PRD.md"],
    },
    events,
    originalPrd: await readFile(prdFile, "utf8"),
  }
}

function channel(events: BackendEvent[]): ExecutionChannel {
  let modelCalls = 0
  return {
    emit(event: BackendEvent): void {
      events.push(event)
    },
    async reserveModelCall(): Promise<void> {
      modelCalls += 1
    },
    async tools() {
      return []
    },
    async executeTool(call) {
      return {
        callId: call.callId,
        outcome: "invalid",
        output: JSON.stringify({ error: "Scripted backend fixture exposes no tools" }),
        retryable: false,
      }
    },
    stats() {
      return {
        modelCalls,
        maximumModelCalls: 1,
        toolCalls: 0,
        maximumToolCalls: 0,
      }
    },
  }
}

describe("S03 scripted execution backend isolation", () => {
  test.each([
    ["the PRD", "PRD.md", "control-plane path"],
    ["the Ralph state directory", ".ralph/state/ledger.sqlite", "control-plane path"],
    ["Git hooks", ".git/hooks/post-commit", "control-plane path"],
    ["a workspace escape", "../outside.txt", "escapes workspace"],
  ])("refuses to modify %s", async (_label, path, expectedMessage) => {
    const fixture = await executionRequest()
    const backend = new ScriptedExecutionBackend([
      { actions: [{ type: "write", path, content: "forbidden" }] },
    ])
    const handle = await backend.start(fixture.request, channel(fixture.events))

    await expect(handle.outcome).rejects.toThrow(expectedMessage)
    expect(await readFile(resolve(fixture.request.workspaceRoot, "PRD.md"), "utf8")).toBe(
      fixture.originalPrd,
    )
    expect(fixture.events.map((event) => event.type)).not.toContain("model.backend.turn.finished")
  })

  test("returns work_submitted as an allegation and cannot mark the official PRD", async () => {
    const fixture = await executionRequest()
    const backend = new ScriptedExecutionBackend([
      {
        expectedTask: `${fixture.request.documentId}/${fixture.request.taskId}`,
        actions: [{ type: "write", path: "product/submitted.txt", content: "candidate" }],
        outcome: {
          status: "work_submitted",
          summary: "TASK_COMPLETE",
          intendedFiles: ["PRD.md", "product/submitted.txt"],
        },
      },
    ])
    const handle = await backend.start(fixture.request, channel(fixture.events))
    const outcome = await handle.outcome

    expect(outcome).toMatchObject({ status: "work_submitted", summary: "TASK_COMPLETE" })
    expect(
      await readFile(resolve(fixture.request.workspaceRoot, "product/submitted.txt"), "utf8"),
    ).toBe("candidate")
    const prd = await readFile(resolve(fixture.request.workspaceRoot, "PRD.md"), "utf8")
    expect(prd).toBe(fixture.originalPrd)
    expect(prd).toContain("- [ ] **deliver-capability")
    expect(fixture.events.map((event) => event.type)).toEqual([
      "model.backend.turn.started",
      "tool.call.settled",
      "model.backend.turn.finished",
    ])
  })

  test("cancels before delayed actions and emits no false completion", async () => {
    const fixture = await executionRequest()
    const backend = new ScriptedExecutionBackend([
      {
        delayMs: 75,
        actions: [{ type: "write", path: "product/cancelled.txt", content: "must-not-exist" }],
      },
    ])
    const handle = await backend.start(fixture.request, channel(fixture.events))

    await backend.cancel(handle, "unit-test cancellation")
    await expect(handle.outcome).rejects.toThrow(
      "Scripted execution cancelled: unit-test cancellation",
    )
    await expect(
      readFile(resolve(fixture.request.workspaceRoot, "product/cancelled.txt"), "utf8"),
    ).rejects.toThrow()
    expect(fixture.events.map((event) => event.type)).toEqual(["model.backend.turn.started"])
  })
})
