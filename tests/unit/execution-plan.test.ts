import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { buildExecutionPlan, resolveEffectiveRunOptions } from "@ralph-next/orchestration"
import { compilePrdGraph } from "@ralph-next/prd"

async function graphFor(path: string) {
  const absolute = resolve(path)
  const result = await compilePrdGraph(absolute, {
    workspaceRoot: resolve(path, ".."),
    recursive: true,
    strict: true,
  })
  if (!result.ok || !result.graph) throw new Error(`Fixture graph did not compile: ${path}`)
  return result.graph
}

describe("S03 dry-run execution plan", () => {
  test("projects the selected task commands, gates and write-free predicted effects", async () => {
    const graph = await graphFor("tests/fixtures/execution/single-pass/PRD.md")
    const selection = graph.eligibleTasks[0]
    if (!selection) throw new Error("Fixture has no eligible task")
    const document = graph.documents[selection.documentId]
    const task = document?.tasks.find((candidate) => candidate.id === selection.taskId)
    if (!document || !task) throw new Error("Selected fixture task is missing")
    const options = resolveEffectiveRunOptions({
      document,
      task,
      cli: { mode: "once", executorProfile: "fixture-executor", dryRun: true },
    }).options

    const plan = buildExecutionPlan({
      graph,
      options,
      selection: { task: selection, reason: "first eligible task", dependencyOverride: false },
      backendAvailable: true,
    })

    expect(plan.verifications).toContainEqual(
      expect.objectContaining({
        type: "command",
        category: "test",
        blocking: true,
        command: expect.objectContaining({ executable: "bun" }),
      }),
    )
    expect(plan.effects).toEqual({
      createsRun: true,
      createsAttempt: true,
      invokesBackend: true,
      invokesJudge: false,
      verificationIds: plan.verifications.map((verification) => verification.id),
      mayUpdateMarkerAfterEvidence: true,
      writesDuringDryRun: false,
    })
    expect(plan.evaluation).toMatchObject({
      mode: "deterministic-only",
      threshold: 85,
      maxRevisionAttempts: 3,
    })
    expect(
      buildExecutionPlan({
        graph,
        options,
        selection: { task: selection, reason: "resume", dependencyOverride: false },
        backendAvailable: true,
        runAlreadyExists: true,
      }).effects,
    ).toMatchObject({ createsRun: false, createsAttempt: true, invokesBackend: true })
  })

  test("shows the command-owned child structure and normal dry-run effects", async () => {
    const graph = await graphFor("examples/PRD-v2-exemplo.md")
    const selection = graph.eligibleTasks[0]
    if (!selection) throw new Error("Child fixture has no eligible task")
    const options = resolveEffectiveRunOptions({
      cli: { mode: "once", executorProfile: "fixture-executor", dryRun: true },
    }).options

    const plan = buildExecutionPlan({
      graph,
      options,
      selection: { task: selection, reason: "first eligible task", dependencyOverride: false },
      backendAvailable: true,
    })

    expect(plan.childEdges.length).toBeGreaterThan(0)
    expect(plan.childEdges[0]).toMatchObject({
      parentTask: expect.objectContaining({ documentId: graph.rootDocumentId }),
      childDocument: expect.any(String),
    })
    expect(plan.childExecutionSupported).toBeTrue()
    expect(plan.effects).toMatchObject({
      createsRun: true,
      createsAttempt: true,
      invokesBackend: true,
      mayUpdateMarkerAfterEvidence: true,
      writesDuringDryRun: false,
    })
  })
})
