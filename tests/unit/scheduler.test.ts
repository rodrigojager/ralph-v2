import { describe, expect, test } from "bun:test"
import { type TaskRecord, TaskRecordSchema, type TaskRuntimeStatus } from "@ralph-next/domain"
import {
  initialTaskRecords,
  SchedulingError,
  selectTask,
  taskRefKey,
} from "@ralph-next/orchestration"
import { type CompiledPrdGraph, compilePrdGraph, type TaskRef } from "@ralph-next/prd"

const TWO_TASK_FIXTURE = "tests/fixtures/execution/two-task-order/PRD.md"
const CHILD_GRAPH_EXAMPLE = "examples/PRD-v2-exemplo.md"

async function compileGraph(file: string): Promise<CompiledPrdGraph> {
  const compiled = await compilePrdGraph(file, {
    workspaceRoot: process.cwd(),
    recursive: true,
    strict: true,
  })
  if (!compiled.ok || !compiled.graph) {
    throw new Error(`Expected fixture graph to compile: ${JSON.stringify(compiled.diagnostics)}`)
  }
  return compiled.graph
}

function taskPair(graph: CompiledPrdGraph): readonly [TaskRef, TaskRef] {
  const first = graph.topologicalOrder[0]
  const second = graph.topologicalOrder[1]
  if (!first || !second) throw new Error("Expected a graph with at least two tasks")
  return [first, second]
}

function recordsFor(graph: CompiledPrdGraph): Map<string, TaskRecord> {
  return new Map(
    initialTaskRecords("run-scheduler", graph).map((record) => [taskRefKey(record), record]),
  )
}

function setStatus(
  records: Map<string, TaskRecord>,
  reference: TaskRef,
  status: TaskRuntimeStatus,
): void {
  const key = taskRefKey(reference)
  const current = records.get(key)
  if (!current) throw new Error(`Missing task record ${key}`)
  records.set(key, TaskRecordSchema.parse({ ...current, status }))
}

function schedulingCode(action: () => unknown): string | undefined {
  try {
    action()
  } catch (error) {
    if (error instanceof SchedulingError) return error.code
    throw error
  }
  return undefined
}

describe("S03 deterministic task scheduler", () => {
  test("respects dependency eligibility and textual/topological order", async () => {
    const graph = await compileGraph(TWO_TASK_FIXTURE)
    const [first, second] = taskPair(graph)
    const records = recordsFor(graph)

    expect(selectTask({ graph, records })).toEqual({
      task: first,
      reason: "eligible",
      dependencyOverride: false,
    })
    expect(
      schedulingCode(() => selectTask({ graph, records, requestedTask: taskRefKey(second) })),
    ).toBe("RALPH_TASK_NOT_ELIGIBLE")

    setStatus(records, first, "completed")
    expect(selectTask({ graph, records })).toEqual({
      task: second,
      reason: "eligible",
      dependencyOverride: false,
    })
  })

  test("resolves document/task and a unique bare task ID deterministically", async () => {
    const graph = await compileGraph(TWO_TASK_FIXTURE)
    const [first, second] = taskPair(graph)
    const records = recordsFor(graph)
    setStatus(records, first, "completed")

    for (const requestedTask of [taskRefKey(second), second.taskId]) {
      expect(selectTask({ graph, records, requestedTask })).toEqual({
        task: second,
        reason: "requested",
        dependencyOverride: false,
      })
    }
  })

  test("rejects an ambiguous bare ID and reports every document-qualified match", async () => {
    const graph = await compileGraph(CHILD_GRAPH_EXAMPLE)
    const rootTask = graph.topologicalOrder.find(
      (reference) => reference.documentId === graph.rootDocumentId,
    )
    const childDocumentId = Object.keys(graph.documents).find(
      (documentId) => documentId !== graph.rootDocumentId,
    )
    if (!rootTask || !childDocumentId) throw new Error("Expected a root and child task")

    const duplicate: TaskRef = { ...rootTask, documentId: childDocumentId }
    const ambiguousGraph: CompiledPrdGraph = {
      ...graph,
      topologicalOrder: [rootTask, duplicate],
    }
    let caught: SchedulingError | undefined
    try {
      selectTask({
        graph: ambiguousGraph,
        records: new Map(),
        requestedTask: rootTask.taskId,
      })
    } catch (error) {
      if (error instanceof SchedulingError) caught = error
      else throw error
    }

    expect(caught?.code).toBe("RALPH_TASK_AMBIGUOUS")
    expect(caught?.details.matches).toEqual([taskRefKey(rootTask), taskRefKey(duplicate)])
  })

  test("requires force for unmet dependencies and exposes an auditable override flag", async () => {
    const graph = await compileGraph(TWO_TASK_FIXTURE)
    const [, second] = taskPair(graph)
    const records = recordsFor(graph)

    expect(
      selectTask({
        graph,
        records,
        requestedTask: taskRefKey(second),
        force: true,
      }),
    ).toEqual({ task: second, reason: "forced", dependencyOverride: true })
  })

  test("prioritizes resumable work over a fresh eligible task", async () => {
    const graph = await compileGraph(TWO_TASK_FIXTURE)
    const [first, second] = taskPair(graph)
    const records = recordsFor(graph)
    setStatus(records, second, "interrupted")

    expect(selectTask({ graph, records })).toEqual({
      task: second,
      reason: "resume",
      dependencyOverride: false,
    })

    setStatus(records, first, "active")
    expect(selectTask({ graph, records })?.task).toEqual(first)
  })

  test.each(["completed", "completed_with_override"] as const)(
    "never reopens a %s task, even with force",
    async (status) => {
      const graph = await compileGraph(TWO_TASK_FIXTURE)
      const [, second] = taskPair(graph)
      const records = recordsFor(graph)
      setStatus(records, second, status)

      expect(
        schedulingCode(() =>
          selectTask({
            graph,
            records,
            requestedTask: taskRefKey(second),
            force: true,
          }),
        ),
      ).toBe("RALPH_TASK_ALREADY_COMPLETED")
    },
  )
})
