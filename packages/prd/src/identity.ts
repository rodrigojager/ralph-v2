import { createHash } from "node:crypto"
import type {
  ChildEdgeSchema,
  CompiledPrdGraph,
  DependencyEdgeSchema,
  PrdDocument,
  PrdTask,
  TaskDefaults,
  TaskRef,
} from "./contracts"

type DependencyEdge = typeof DependencyEdgeSchema._output
type ChildEdge = typeof ChildEdgeSchema._output

export type TaskSpecificationInput = Omit<PrdTask, "taskSpecHash"> | PrdTask
export type PrdDefinitionInput = Omit<PrdDocument, "definitionHash"> | PrdDocument
export type TaskSpecificationNamespace = Pick<PrdDocument, "id" | "defaults">

export type GraphDefinitionInput = {
  rootDocumentId: string
  documents: Record<string, PrdDocument>
  dependencyEdges: DependencyEdge[]
  childEdges: ChildEdge[]
  topologicalOrder: TaskRef[]
  parallelGroups: CompiledPrdGraph["parallelGroups"]
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareKeys(left, right))
      .map(([key, child]) => [key, stableValue(child)]),
  )
}

export function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

export function hashCanonicalValue(namespace: string, value: unknown): string {
  return createHash("sha256").update(namespace).update("\0").update(stableJson(value)).digest("hex")
}

export function taskSpecificationProjection(
  task: TaskSpecificationInput,
  defaults: TaskDefaults = {},
): unknown {
  const { status: _status, taskSpecHash: _taskSpecHash, ...specification } = task as PrdTask
  const effectiveProfiles = {
    ...(defaults.executorProfile ? { executor: defaults.executorProfile } : {}),
    ...(defaults.judgeProfile ? { judge: defaults.judgeProfile } : {}),
    ...specification.profiles,
  }
  const effectiveBudget =
    defaults.budget || specification.budget
      ? { ...defaults.budget, ...specification.budget }
      : undefined
  return {
    schemaVersion: 1,
    ...specification,
    effectiveProfiles,
    effectiveBudget,
  }
}

export function computeTaskSpecHash(
  document: TaskSpecificationNamespace,
  task: TaskSpecificationInput,
): string {
  return hashCanonicalValue("ralph.prd.task-spec.v1", {
    documentId: document.id,
    taskId: task.id,
    specification: taskSpecificationProjection(task, document.defaults),
  })
}

export function prdDefinitionProjection(document: PrdDefinitionInput): unknown {
  return {
    schemaVersion: 1,
    prdSchemaVersion: document.schemaVersion,
    id: document.id,
    title: document.title,
    kind: document.kind,
    workspace: document.workspace,
    parent: document.parent,
    defaults: document.defaults,
    sharedContext: document.sharedContext,
    tasks: document.tasks.map((task) => ({
      id: task.id,
      taskSpecHash: computeTaskSpecHash(document, task),
      specification: taskSpecificationProjection(task, document.defaults),
    })),
    metadata: document.metadata,
  }
}

export function computePrdDefinitionHash(document: PrdDefinitionInput): string {
  return hashCanonicalValue("ralph.prd.document-definition.v1", prdDefinitionProjection(document))
}

export function graphDefinitionProjection(graph: GraphDefinitionInput): unknown {
  return {
    schemaVersion: 1,
    rootDocumentId: graph.rootDocumentId,
    documents: Object.fromEntries(
      Object.entries(graph.documents).map(([id, document]) => [
        id,
        {
          id: document.id,
          definitionHash: computePrdDefinitionHash(document),
          definition: prdDefinitionProjection(document),
        },
      ]),
    ),
    dependencyEdges: graph.dependencyEdges,
    childEdges: graph.childEdges,
    topologicalOrder: graph.topologicalOrder,
    parallelGroups: graph.parallelGroups,
  }
}

export function computeGraphDefinitionHash(graph: GraphDefinitionInput): string {
  return hashCanonicalValue("ralph.prd.graph-definition.v1", graphDefinitionProjection(graph))
}

export function computeGraphHash(revision: unknown): string {
  return hashCanonicalValue("ralph.prd.graph-revision.v1", revision)
}
