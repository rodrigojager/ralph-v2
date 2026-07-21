import {
  EXIT_CODES,
  RalphError,
  type TaskRecord,
  TaskRecordSchema,
  type TaskRuntimeStatus,
} from "@ralph/domain"
import type { CompiledPrdGraph, TaskRef } from "@ralph/prd"

export type TaskSelection = {
  task: TaskRef
  reason: "resume" | "eligible" | "requested" | "forced"
  dependencyOverride: boolean
}

export class SchedulingError extends RalphError {
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, {
      exitCode:
        code === "RALPH_TASK_NOT_ELIGIBLE" || code === "RALPH_TASK_ALREADY_COMPLETED"
          ? EXIT_CODES.conflict
          : code === "RALPH_TASK_GRAPH_INCONSISTENT"
            ? EXIT_CODES.operationalError
            : EXIT_CODES.invalidUsage,
      details,
    })
    this.name = "SchedulingError"
    this.details = Object.freeze({ ...details })
  }
}

export function taskRefKey(reference: Pick<TaskRef, "documentId" | "taskId">): string {
  return `${reference.documentId}/${reference.taskId}`
}

function taskFor(graph: CompiledPrdGraph, reference: TaskRef) {
  return graph.documents[reference.documentId]?.tasks.find((task) => task.id === reference.taskId)
}

function completed(status: TaskRuntimeStatus): boolean {
  return status === "completed" || status === "completed_with_override"
}

function effectiveStatus(
  graph: CompiledPrdGraph,
  records: ReadonlyMap<string, TaskRecord>,
  reference: TaskRef,
): TaskRuntimeStatus {
  const record = records.get(taskRefKey(reference))
  if (record) return record.status
  const marker = taskFor(graph, reference)?.status
  if (marker === "completed") return "completed"
  if (marker === "active") return "active"
  return "pending"
}

function dependenciesPassed(
  graph: CompiledPrdGraph,
  records: ReadonlyMap<string, TaskRecord>,
  reference: TaskRef,
): boolean {
  return graph.dependencyEdges
    .filter((edge) => taskRefKey(edge.task) === taskRefKey(reference))
    .every((edge) => completed(effectiveStatus(graph, records, edge.dependsOn)))
}

function resolveRequestedTask(
  graph: CompiledPrdGraph,
  value: string,
  scopeDocumentId?: string,
): TaskRef {
  const normalized = value.trim()
  if (!normalized)
    throw new SchedulingError("RALPH_TASK_SELECTION_EMPTY", "Task selection is empty")
  if (normalized.includes("/")) {
    const [requestedDocumentId, taskId, ...extra] = normalized.split("/")
    if (!requestedDocumentId || !taskId || extra.length > 0) {
      throw new SchedulingError(
        "RALPH_TASK_SELECTION_INVALID",
        `Task reference must be document-id/task-id: ${value}`,
      )
    }
    const match = graph.topologicalOrder.find(
      (reference) => reference.documentId === requestedDocumentId && reference.taskId === taskId,
    )
    if (!match || (scopeDocumentId !== undefined && match.documentId !== scopeDocumentId)) {
      throw new SchedulingError("RALPH_TASK_NOT_FOUND", `Task does not exist: ${value}`)
    }
    return match
  }
  const matches = graph.topologicalOrder.filter(
    (reference) =>
      reference.taskId === normalized &&
      (scopeDocumentId === undefined || reference.documentId === scopeDocumentId),
  )
  if (matches.length === 0) {
    throw new SchedulingError("RALPH_TASK_NOT_FOUND", `Task does not exist: ${value}`)
  }
  if (matches.length > 1) {
    throw new SchedulingError(
      "RALPH_TASK_AMBIGUOUS",
      `Task ID is present in multiple documents: ${value}`,
      { matches: matches.map(taskRefKey) },
    )
  }
  return matches[0] as TaskRef
}

export function selectTask(input: {
  graph: CompiledPrdGraph
  records: ReadonlyMap<string, TaskRecord>
  documentId?: string
  requestedTask?: string
  force?: boolean
  excludedTaskKeys?: ReadonlySet<string>
}): TaskSelection | undefined {
  const { graph, records } = input
  const order = input.documentId
    ? graph.topologicalOrder.filter((reference) => reference.documentId === input.documentId)
    : graph.topologicalOrder
  if (input.requestedTask) {
    const task = resolveRequestedTask(graph, input.requestedTask, input.documentId)
    const status = effectiveStatus(graph, records, task)
    if (completed(status)) {
      throw new SchedulingError(
        "RALPH_TASK_ALREADY_COMPLETED",
        `Completed task cannot be reopened by --force: ${taskRefKey(task)}`,
      )
    }
    const eligible = dependenciesPassed(graph, records, task)
    if (!eligible && !input.force) {
      throw new SchedulingError(
        "RALPH_TASK_NOT_ELIGIBLE",
        `Task dependencies are not completed: ${taskRefKey(task)}`,
        {
          dependencies: graph.dependencyEdges.filter(
            (edge) => taskRefKey(edge.task) === taskRefKey(task),
          ),
        },
      )
    }
    return {
      task,
      reason: eligible ? "requested" : "forced",
      dependencyOverride: !eligible,
    }
  }

  const resumable = order.find((reference) => {
    if (input.excludedTaskKeys?.has(taskRefKey(reference))) return false
    const status = effectiveStatus(graph, records, reference)
    return ["active", "verifying", "evaluating", "interrupted", "retryable_failed"].includes(status)
  })
  if (resumable) return { task: resumable, reason: "resume", dependencyOverride: false }

  const next = order.find((reference) => {
    if (input.excludedTaskKeys?.has(taskRefKey(reference))) return false
    const status = effectiveStatus(graph, records, reference)
    return (
      !completed(status) && status !== "blocked" && dependenciesPassed(graph, records, reference)
    )
  })
  return next ? { task: next, reason: "eligible", dependencyOverride: false } : undefined
}

export function initialTaskRecords(
  runId: string,
  graph: CompiledPrdGraph,
  documentId?: string,
): TaskRecord[] {
  const order = documentId
    ? graph.topologicalOrder.filter((reference) => reference.documentId === documentId)
    : graph.topologicalOrder
  return order.map((reference) => {
    const task = taskFor(graph, reference)
    if (!task) {
      throw new SchedulingError(
        "RALPH_TASK_GRAPH_INCONSISTENT",
        `Compiled task is missing: ${taskRefKey(reference)}`,
      )
    }
    const status: TaskRuntimeStatus =
      task.status === "completed" ? "completed" : task.status === "active" ? "active" : "pending"
    return TaskRecordSchema.parse({
      runId,
      documentId: reference.documentId,
      taskId: reference.taskId,
      status,
      markerContentHash: graph.documents[reference.documentId]?.contentHash,
      updatedAt: "1970-01-01T00:00:00.000Z",
    })
  })
}
