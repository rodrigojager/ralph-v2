import { createHash } from "node:crypto"
import { posix } from "node:path"
import {
  type ChildParentPolicy,
  type ChildRunLimits,
  ChildRunLimitsSchema,
  type ChildRunLinkRecord,
  type ChildRunObservability,
  ChildRunObservabilitySchema,
  type DurableLeaseRecord,
  type EffectiveRunOptions,
  EXIT_CODES,
  RalphError,
  type RunStatus,
} from "@ralph-next/domain"
import {
  acquireDurableLease,
  assertDurableLeaseOwned,
  assertParentChildCompletionReady,
  type ChildTaskMaterialization,
  findDeepestResumableChildRun,
  getChildRunLink,
  getChildRunLinkForParent,
  getRun,
  type LeaseOwnerIdentity,
  type LeaseOwnerProbeResult,
  listChildRunTree,
  listDirectChildRunLinks,
  projectChildEventToParent,
  type ReserveChildRunResult,
  type RunTaskRecord,
  releaseDurableLease,
  renewDurableLease,
  reserveChildRun,
  settleChildRun,
  updateChildRunObservation,
} from "@ralph-next/persistence"
import {
  type CompiledPrdGraph,
  CompiledPrdGraphSchema,
  hashCanonicalValue,
  type PrdDocument,
  type PrdTask,
  type TaskRef,
} from "@ralph-next/prd"
import type { EventEnvelope } from "@ralph-next/telemetry"

const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"]
const DEFAULT_CHILD_LIMITS = Object.freeze({
  maxDepth: 8,
  maxChildren: 100,
  maxConcurrentChildren: 1,
})

export type ValidatedChildRuntimeGraph = {
  graph: CompiledPrdGraph
  depthByDocument: ReadonlyMap<string, number>
  parentTaskByChildDocument: ReadonlyMap<string, TaskRef>
  childDocumentByParentTask: ReadonlyMap<string, string>
}

export type ChildMaterializationManifest = {
  schemaVersion: 1
  authority: "compiled-prd-graph"
  authorship: "preauthored-only"
  graphDefinitionHash: string
  parentRunId: string
  parentTask: TaskRef
  parentDocumentDefaults: PrdDocument["defaults"]
  parentTaskProfiles?: PrdTask["profiles"]
  parentTaskBudget?: PrdTask["budget"]
  childDocumentId: string
  childRootPrdFile: string
  childDocumentDefinitionHash: string
  childDocumentDefaults: PrdDocument["defaults"]
  childTaskSpecHashes: readonly { taskId: string; taskSpecHash: string }[]
  expectedDirectChildren: number
  inheritedOptionsHash: string
  depth: number
}

export type ReservePreauthoredChildInput = {
  ledger: string
  workspaceId: string
  parentRunId: string
  parentTask: TaskRef
  graph: CompiledPrdGraph
  effectiveOptions: EffectiveRunOptions
  limits?: Partial<ChildRunLimits>
  parentPolicy?: ChildParentPolicy
  now?: () => string
  childRunId?: string
  linkId?: string
}

export type ReservedPreauthoredChild = ReserveChildRunResult & {
  manifest: ChildMaterializationManifest
}

export type HierarchicalChildDecision =
  | { kind: "resume-child"; link: ChildRunLinkRecord; reason: string }
  | { kind: "reserve-child"; childDocumentId: string; reason: string }
  | { kind: "verify-parent"; link: ChildRunLinkRecord; reason: string }
  | { kind: "blocked-by-child"; link: ChildRunLinkRecord; reason: string }
  | { kind: "execute-parent"; reason: string }

export type ScopedChildWorkDecision =
  | { kind: "resume-child"; link: ChildRunLinkRecord; reason: string }
  | { kind: "reserve-child"; task: TaskRef; childDocumentId: string; reason: string }
  | { kind: "execute-task"; task: TaskRef; reason: "resume" | "eligible" }
  | { kind: "blocked-by-child"; task: TaskRef; link: ChildRunLinkRecord; reason: string }
  | { kind: "scope-complete"; documentId: string }
  | { kind: "scope-waiting"; documentId: string; reason: string }

export type ChildSupervisorLeaseOptions = {
  ledger: string
  link: ChildRunLinkRecord
  owner: LeaseOwnerIdentity
  workerId?: string
  parentWorkerId?: string
  command: string
  parentPolicy?: ChildParentPolicy
  independentOwner?: boolean
  leaseDurationMs?: number
  staleGraceMs?: number
  renewalIntervalMs?: number
  /**
   * Command-owned health gate evaluated immediately before every renewal.
   * Returning false permanently fails this lease instance; a frozen worker
   * must never keep ownership merely because the coordinator timer is alive.
   */
  renewalGuard?: () => boolean
  onRenewalFailure?: (error: unknown) => void
  probeOwner: (owner: DurableLeaseRecord) => Promise<LeaseOwnerProbeResult>
}

export type ChildSupervisorLease = {
  readonly id: string
  readonly owner: LeaseOwnerIdentity
  readonly current: DurableLeaseRecord
  assertOwned(): DurableLeaseRecord
  renew(): Promise<DurableLeaseRecord>
  release(): Promise<void>
}

export type ChildExecutionObservation = {
  /**
   * Non-terminal supervisor phase only. Omit this after the durable run enters
   * a terminal state: settleChildRun owns passed/failed/cancelled and must not
   * be preceded by a synthetic `running` observation that masks that state.
   */
  status?: "starting" | "running" | "waiting" | "blocked" | "interrupted"
  observability: ChildRunObservability
  heartbeatAt?: string
  reason?: string
}

/**
 * Command-owned execution boundary. The port may invoke a supervised Ralph
 * worker, but receives only the already compiled graph/document and never a
 * capability to author, discover or expand a PRD.
 */
export type ChildRunExecutionPort = {
  execute(request: {
    link: ChildRunLinkRecord
    graph: CompiledPrdGraph
    childDocument: PrdDocument
    effectiveOptions: EffectiveRunOptions
    signal?: AbortSignal
    assertLease(): DurableLeaseRecord
    observe(observation: ChildExecutionObservation): Promise<void>
    projectEvent(event: EventEnvelope): Promise<void>
  }): Promise<{
    artifactsReconciled: boolean
    reason: string
  }>
  /**
   * Crash-safe settlement boundary. This method must only reconcile durable
   * artifacts/evidence for a run that is already terminal; it must never call
   * the executor model or start another attempt. Repeated calls are required
   * to be idempotent because a crash may occur before the terminal receipt is
   * committed.
   */
  reconcileTerminal(request: {
    link: ChildRunLinkRecord
    graph: CompiledPrdGraph
    childDocument: PrdDocument
    effectiveOptions: EffectiveRunOptions
    assertLease(): DurableLeaseRecord
    observe(observation: ChildExecutionObservation): Promise<void>
    projectEvent(event: EventEnvelope): Promise<void>
  }): Promise<{
    artifactsReconciled: boolean
    reason: string
  }>
  requestStop?(request: {
    link: ChildRunLinkRecord
    mode: "graceful"
    reason: string
    graceMs?: number
  }): Promise<void>
}

export type SuperviseChildRunInput = {
  ledger: string
  graph: CompiledPrdGraph
  linkId: string
  effectiveOptions: EffectiveRunOptions
  owner: LeaseOwnerIdentity
  workerId?: string
  parentWorkerId?: string
  command: string
  probeOwner: (owner: DurableLeaseRecord) => Promise<LeaseOwnerProbeResult>
  execution: ChildRunExecutionPort
  signal?: AbortSignal
  independentOwner?: boolean
  leaseDurationMs?: number
  staleGraceMs?: number
  renewalIntervalMs?: number
  leaseRenewalGuard?: () => boolean
  onLeaseRenewalFailure?: (error: unknown) => void
  now?: () => string
  projectedEventId?: (sourceEventId: string) => string
}

export type SupervisedChildResult = {
  link: ChildRunLinkRecord
  runStatus: RunStatus
  resumed: boolean
}

export function childRunWorkerLinkBinding(link: ChildRunLinkRecord) {
  return {
    schemaVersion: 1 as const,
    id: link.id,
    workspaceId: link.workspaceId,
    parentRunId: link.parentRunId,
    parentDocumentId: link.parentDocumentId,
    parentTaskId: link.parentTaskId,
    childRunId: link.childRunId,
    childDocumentId: link.childDocumentId,
    childRootPrdFile: link.childRootPrdFile,
    graphDefinitionHash: link.graphDefinitionHash,
    materializationHash: link.materializationHash,
    inheritedOptionsHash: link.inheritedOptionsHash,
    depth: link.depth,
    expectedDirectChildren: link.expectedDirectChildren,
    parentPolicy: link.parentPolicy,
    completionPolicy: link.completionPolicy,
  }
}

export function childRunWorkerLinkHash(link: ChildRunLinkRecord): string {
  return hashCanonicalValue("ralph.child.worker-link.v1", childRunWorkerLinkBinding(link))
}

function schedulingError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): RalphError {
  return new RalphError(code, message, {
    exitCode:
      code.includes("GRAPH") || code.includes("PREAUTHORED")
        ? EXIT_CODES.invalidPrd
        : EXIT_CODES.conflict,
    details,
  })
}

function taskKey(reference: Pick<TaskRef, "documentId" | "taskId">): string {
  return `${reference.documentId}/${reference.taskId}`
}

function graphTask(graph: CompiledPrdGraph, reference: TaskRef): PrdTask {
  const task = graph.documents[reference.documentId]?.tasks.find(
    (candidate) => candidate.id === reference.taskId,
  )
  if (!task || task.taskSpecHash !== reference.taskSpecHash) {
    throw schedulingError(
      "RALPH_CHILD_GRAPH_TASK_BINDING_INVALID",
      `Compiled parent task binding is invalid: ${taskKey(reference)}`,
    )
  }
  return task
}

function effectiveLimits(input?: Partial<ChildRunLimits>) {
  return ChildRunLimitsSchema.parse({ ...DEFAULT_CHILD_LIMITS, ...input })
}

/**
 * Runtime defense in depth. compilePrdGraph already performs these checks, but
 * a worker never trusts a caller-supplied object merely because it is typed.
 */
export function validateChildRuntimeGraph(
  candidate: CompiledPrdGraph,
  limitOverrides?: Partial<ChildRunLimits>,
): ValidatedChildRuntimeGraph {
  const graph = CompiledPrdGraphSchema.parse(candidate)
  const limits = effectiveLimits(limitOverrides)
  const errors = graph.diagnostics.filter((diagnostic) => diagnostic.severity === "error")
  if (errors.length > 0) {
    throw schedulingError(
      "RALPH_CHILD_GRAPH_HAS_DIAGNOSTICS",
      "A graph with error diagnostics cannot create child runs",
      { diagnostics: errors },
    )
  }
  if (graph.childEdges.length > limits.maxChildren) {
    throw schedulingError(
      "RALPH_CHILD_GRAPH_COUNT_LIMIT",
      `Compiled child count exceeds maxChildren=${limits.maxChildren}`,
      { childCount: graph.childEdges.length },
    )
  }

  const childDocumentByParentTask = new Map<string, string>()
  const parentTaskByChildDocument = new Map<string, TaskRef>()
  for (const edge of graph.childEdges) {
    const parentTask = graphTask(graph, edge.parentTask)
    if (!parentTask.subPrd) {
      throw schedulingError(
        "RALPH_CHILD_RUNTIME_GENERATION_FORBIDDEN",
        "A child edge without a pre-authored Sub-PRD reference is forbidden",
        { parentTask: taskKey(edge.parentTask), childDocumentId: edge.childDocument },
      )
    }
    const child = graph.documents[edge.childDocument]
    if (!child || child.kind !== "child" || !child.parent) {
      throw schedulingError(
        "RALPH_CHILD_GRAPH_DOCUMENT_INVALID",
        `Child edge targets an invalid child document: ${edge.childDocument}`,
      )
    }
    const expectedParentFile = graph.canonicalReferences[edge.parentTask.documentId]
    const declaredParentFile = posix.normalize(
      posix.join(posix.dirname(child.file), child.parent.prd.replaceAll("\\", "/")),
    )
    if (
      expectedParentFile === undefined ||
      declaredParentFile !== expectedParentFile.replaceAll("\\", "/") ||
      child.parent.task !== edge.parentTask.taskId
    ) {
      throw schedulingError(
        "RALPH_CHILD_GRAPH_PARENT_MISMATCH",
        "Child frontmatter parent.prd/task does not match its compiled edge",
        {
          childDocumentId: child.id,
          expected: {
            prd: expectedParentFile,
            task: edge.parentTask.taskId,
          },
          actual: { ...child.parent, resolvedPrd: declaredParentFile },
        },
      )
    }
    if (childDocumentByParentTask.has(taskKey(edge.parentTask))) {
      throw schedulingError(
        "RALPH_CHILD_GRAPH_MULTIPLE_CHILDREN",
        "One parent task cannot create multiple runtime children",
        { parentTask: taskKey(edge.parentTask) },
      )
    }
    if (parentTaskByChildDocument.has(child.id)) {
      throw schedulingError(
        "RALPH_CHILD_GRAPH_MULTIPLE_PARENTS",
        "A child document cannot have multiple runtime parents",
        { childDocumentId: child.id },
      )
    }
    childDocumentByParentTask.set(taskKey(edge.parentTask), child.id)
    parentTaskByChildDocument.set(child.id, edge.parentTask)
  }

  for (const [documentId, document] of Object.entries(graph.documents)) {
    for (const task of document.tasks) {
      const key = `${documentId}/${task.id}`
      if (task.subPrd && !childDocumentByParentTask.has(key)) {
        throw schedulingError(
          "RALPH_CHILD_PREAUTHORED_EDGE_MISSING",
          "A Sub-PRD reference is absent from the validated compiled child edges",
          { parentTask: key, subPrd: task.subPrd },
        )
      }
      if (!task.subPrd && childDocumentByParentTask.has(key)) {
        throw schedulingError(
          "RALPH_CHILD_RUNTIME_GENERATION_FORBIDDEN",
          "Runtime child edge has no pre-authored task reference",
          { parentTask: key },
        )
      }
    }
  }

  const depthByDocument = new Map<string, number>([[graph.rootDocumentId, 0]])
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const walk = (documentId: string, depth: number): void => {
    if (visiting.has(documentId)) {
      throw schedulingError(
        "RALPH_CHILD_GRAPH_CYCLE",
        `Child document cycle detected at ${documentId}`,
      )
    }
    if (depth > limits.maxDepth) {
      throw schedulingError(
        "RALPH_CHILD_GRAPH_DEPTH_LIMIT",
        `Child depth exceeds maxDepth=${limits.maxDepth}`,
        { documentId, depth },
      )
    }
    const previous = depthByDocument.get(documentId)
    if (previous !== undefined && previous !== depth) {
      throw schedulingError(
        "RALPH_CHILD_GRAPH_MULTIPLE_PARENTS",
        "A child document resolves to more than one depth",
        { documentId, previous, depth },
      )
    }
    depthByDocument.set(documentId, depth)
    if (visited.has(documentId)) return
    visiting.add(documentId)
    const document = graph.documents[documentId]
    if (!document) {
      throw schedulingError(
        "RALPH_CHILD_GRAPH_DOCUMENT_MISSING",
        `Compiled document is missing: ${documentId}`,
      )
    }
    for (const task of document.tasks) {
      const childId = childDocumentByParentTask.get(`${documentId}/${task.id}`)
      if (childId) walk(childId, depth + 1)
    }
    visiting.delete(documentId)
    visited.add(documentId)
  }
  walk(graph.rootDocumentId, 0)
  if (visited.size !== Object.keys(graph.documents).length) {
    const unreachable = Object.keys(graph.documents).filter(
      (documentId) => !visited.has(documentId),
    )
    throw schedulingError(
      "RALPH_CHILD_GRAPH_UNREACHABLE_DOCUMENT",
      "Every compiled document must be reachable from the root through a pre-authored edge",
      { unreachable },
    )
  }
  return {
    graph,
    depthByDocument,
    parentTaskByChildDocument,
    childDocumentByParentTask,
  }
}

export function deterministicChildIdentity(input: {
  workspaceId: string
  parentRunId: string
  parentTask: Pick<TaskRef, "documentId" | "taskId" | "taskSpecHash">
  childDocumentId: string
  graphDefinitionHash: string
}): { childRunId: string; linkId: string } {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "ralph-child-run-v1",
        input.workspaceId,
        input.parentRunId,
        input.parentTask.documentId,
        input.parentTask.taskId,
        input.parentTask.taskSpecHash,
        input.childDocumentId,
        input.graphDefinitionHash,
      ]),
    )
    .digest("hex")
  return {
    childRunId: `child-${digest.slice(0, 40)}`,
    linkId: `child-link-${digest}`,
  }
}

function directTaskMaterialization(document: PrdDocument): ChildTaskMaterialization[] {
  return document.tasks.map((task) => ({
    documentId: document.id,
    taskId: task.id,
    status:
      task.status === "completed" ? "completed" : task.status === "active" ? "active" : "pending",
    markerContentHash: document.contentHash,
  }))
}

function initialObservability(document: PrdDocument): ChildRunObservability {
  const completed = document.tasks.filter((task) => task.status === "completed").length
  return ChildRunObservabilitySchema.parse({
    progress: { completed, total: document.tasks.length },
    executorUsage: { available: false, source: "unavailable" },
    judgeUsage: { available: false, source: "unavailable" },
    combinedUsage: { available: false, source: "unavailable" },
    lastSourceEventSequence: 0,
    lastLogSequence: 0,
    watchdogStatus: "idle",
  })
}

export function childMaterializationManifest(input: {
  graph: CompiledPrdGraph
  parentRunId: string
  parentTask: TaskRef
  childDocumentId: string
  inheritedOptionsHash: string
  depth: number
}): ChildMaterializationManifest {
  const parentDocument = input.graph.documents[input.parentTask.documentId]
  const parentTask = graphTask(input.graph, input.parentTask)
  const child = input.graph.documents[input.childDocumentId]
  if (!parentDocument || !child) {
    throw schedulingError(
      "RALPH_CHILD_GRAPH_DOCUMENT_MISSING",
      "Cannot materialize a child with missing parent or child document",
    )
  }
  return {
    schemaVersion: 1,
    authority: "compiled-prd-graph",
    authorship: "preauthored-only",
    graphDefinitionHash: input.graph.definitionHash,
    parentRunId: input.parentRunId,
    parentTask: input.parentTask,
    parentDocumentDefaults: parentDocument.defaults,
    ...(parentTask.profiles ? { parentTaskProfiles: parentTask.profiles } : {}),
    ...(parentTask.budget ? { parentTaskBudget: parentTask.budget } : {}),
    childDocumentId: child.id,
    childRootPrdFile: child.file,
    childDocumentDefinitionHash: child.definitionHash,
    childDocumentDefaults: child.defaults,
    childTaskSpecHashes: child.tasks.map((task) => ({
      taskId: task.id,
      taskSpecHash: task.taskSpecHash,
    })),
    expectedDirectChildren: child.tasks.filter((task) => task.subPrd !== undefined).length,
    inheritedOptionsHash: input.inheritedOptionsHash,
    depth: input.depth,
  }
}

export function reservePreauthoredChildRun(
  input: ReservePreauthoredChildInput,
): ReservedPreauthoredChild {
  const validated = validateChildRuntimeGraph(input.graph, input.limits)
  const childDocumentId = validated.childDocumentByParentTask.get(taskKey(input.parentTask))
  if (!childDocumentId) {
    throw schedulingError(
      "RALPH_CHILD_PREAUTHORED_REFERENCE_REQUIRED",
      "The selected task has no pre-authored child edge in the compiled graph",
      { parentTask: taskKey(input.parentTask) },
    )
  }
  const child = validated.graph.documents[childDocumentId]
  const depth = validated.depthByDocument.get(childDocumentId)
  if (!child || depth === undefined || depth < 1) {
    throw schedulingError(
      "RALPH_CHILD_GRAPH_DOCUMENT_INVALID",
      "The compiled child document cannot be materialized",
      { childDocumentId },
    )
  }
  const manifest = childMaterializationManifest({
    graph: validated.graph,
    parentRunId: input.parentRunId,
    parentTask: input.parentTask,
    childDocumentId,
    inheritedOptionsHash: input.effectiveOptions.contentHash,
    depth,
  })
  const deterministic = deterministicChildIdentity({
    workspaceId: input.workspaceId,
    parentRunId: input.parentRunId,
    parentTask: input.parentTask,
    childDocumentId,
    graphDefinitionHash: validated.graph.definitionHash,
  })
  const reserved = reserveChildRun(input.ledger, {
    linkId: input.linkId ?? deterministic.linkId,
    childRunId: input.childRunId ?? deterministic.childRunId,
    workspaceId: input.workspaceId,
    parentRunId: input.parentRunId,
    parentDocumentId: input.parentTask.documentId,
    parentTaskId: input.parentTask.taskId,
    childDocumentId,
    childRootPrdFile: child.file,
    graphDefinitionHash: validated.graph.definitionHash,
    graphHash: validated.graph.graphHash,
    inheritedOptionsHash: input.effectiveOptions.contentHash,
    materializationHash: hashCanonicalValue("ralph.child.materialization.v1", manifest),
    depth,
    expectedDirectChildren: manifest.expectedDirectChildren,
    parentPolicy: input.parentPolicy ?? "pause-with-parent",
    effectiveOptions: input.effectiveOptions,
    tasks: directTaskMaterialization(child),
    observability: initialObservability(child),
    ...(input.now ? { createdAt: input.now() } : {}),
  })
  return { ...reserved, manifest }
}

export function decideHierarchicalChildWork(input: {
  ledger: string
  rootRunId: string
  parentRunId: string
  parentTask: TaskRef
  graph: CompiledPrdGraph
}): HierarchicalChildDecision {
  const validated = validateChildRuntimeGraph(input.graph)
  const deepest = findDeepestResumableChildRun(input.ledger, input.rootRunId)
  if (deepest) {
    return {
      kind: "resume-child",
      link: deepest,
      reason: "Resume always descends to the deepest non-terminal durable child first",
    }
  }
  const childDocumentId = validated.childDocumentByParentTask.get(taskKey(input.parentTask))
  if (!childDocumentId) {
    return { kind: "execute-parent", reason: "The task has no pre-authored child document" }
  }
  const existing = getChildRunLinkForParent(
    input.ledger,
    input.parentRunId,
    input.parentTask.documentId,
    input.parentTask.taskId,
  )
  if (!existing) {
    return {
      kind: "reserve-child",
      childDocumentId,
      reason: "The compiled child edge has not yet been durably materialized",
    }
  }
  if (existing.status === "passed") {
    return {
      kind: "verify-parent",
      link: existing,
      reason: "Child passed; the independent parent completion contract must now be verified",
    }
  }
  if (existing.status === "failed" || existing.status === "cancelled") {
    return {
      kind: "blocked-by-child",
      link: existing,
      reason: `Parent cannot complete because its child is ${existing.status}`,
    }
  }
  return {
    kind: "resume-child",
    link: existing,
    reason: "The existing child identity is resumable and must not be duplicated",
  }
}

function completedTaskStatus(status: RunTaskRecord["status"]): boolean {
  return status === "completed" || status === "completed_with_override"
}

/**
 * Selects work only from one run's root document. Descendant documents are
 * represented by separate child runs, so they can never be double-materialized
 * into the parent's task table.
 */
export function selectScopedChildWork(input: {
  ledger: string
  rootRunId: string
  scopeRunId: string
  documentId: string
  graph: CompiledPrdGraph
  records: readonly RunTaskRecord[]
}): ScopedChildWorkDecision {
  const validated = validateChildRuntimeGraph(input.graph)
  const document = validated.graph.documents[input.documentId]
  if (!document) {
    throw schedulingError(
      "RALPH_CHILD_GRAPH_DOCUMENT_MISSING",
      `Scoped scheduler document is missing: ${input.documentId}`,
    )
  }
  const deepest = findDeepestResumableChildRun(input.ledger, input.rootRunId)
  if (deepest && deepest.childRunId !== input.scopeRunId) {
    return {
      kind: "resume-child",
      link: deepest,
      reason: "A deeper durable child is non-terminal and takes resume priority",
    }
  }
  const recordByTask = new Map(
    input.records
      .filter(
        (record) => record.runId === input.scopeRunId && record.documentId === input.documentId,
      )
      .map((record) => [record.taskId, record]),
  )
  for (const task of document.tasks) {
    if (!recordByTask.has(task.id)) {
      throw schedulingError(
        "RALPH_CHILD_SCOPE_TASK_NOT_MATERIALIZED",
        "Every direct document task must be materialized in its owning run",
        { runId: input.scopeRunId, documentId: input.documentId, taskId: task.id },
      )
    }
  }
  const order = validated.graph.topologicalOrder.filter(
    (reference) => reference.documentId === input.documentId,
  )
  const dependencyPassed = (taskId: string): boolean =>
    validated.graph.dependencyEdges
      .filter((edge) => edge.task.documentId === input.documentId && edge.task.taskId === taskId)
      .every((edge) => {
        const dependency = recordByTask.get(edge.dependsOn.taskId)
        return dependency ? completedTaskStatus(dependency.status) : false
      })

  const resumable = order.find((reference) => {
    const status = recordByTask.get(reference.taskId)?.status
    return (
      status !== undefined &&
      ["active", "verifying", "evaluating", "interrupted", "retryable_failed"].includes(status)
    )
  })
  const eligible =
    resumable ??
    order.find((reference) => {
      const record = recordByTask.get(reference.taskId)
      return Boolean(
        record &&
          !completedTaskStatus(record.status) &&
          record.status !== "blocked" &&
          record.status !== "rejected" &&
          record.status !== "cancelled" &&
          dependencyPassed(reference.taskId),
      )
    })
  if (!eligible) {
    const incomplete = [...recordByTask.values()].filter(
      (record) => !completedTaskStatus(record.status),
    )
    return incomplete.length === 0
      ? { kind: "scope-complete", documentId: input.documentId }
      : {
          kind: "scope-waiting",
          documentId: input.documentId,
          reason: "No direct task is eligible while incomplete scoped work remains",
        }
  }
  const childDocumentId = validated.childDocumentByParentTask.get(taskKey(eligible))
  if (!childDocumentId) {
    return {
      kind: "execute-task",
      task: eligible,
      reason: resumable ? "resume" : "eligible",
    }
  }
  const link = getChildRunLinkForParent(
    input.ledger,
    input.scopeRunId,
    eligible.documentId,
    eligible.taskId,
  )
  if (!link) {
    return {
      kind: "reserve-child",
      task: eligible,
      childDocumentId,
      reason: "The direct task is refined by a pre-authored child that is not yet reserved",
    }
  }
  if (link.status === "failed" || link.status === "cancelled") {
    return {
      kind: "blocked-by-child",
      task: eligible,
      link,
      reason: `The task's child is terminal ${link.status}`,
    }
  }
  if (link.status !== "passed") {
    return {
      kind: "resume-child",
      link,
      reason: "The direct task's existing child must resume before parent verification",
    }
  }
  return {
    kind: "execute-task",
    task: eligible,
    reason: resumable ? "resume" : "eligible",
  }
}

export function assertChildPassedBeforeParentVerification(input: {
  ledger: string
  parentRunId: string
  parentTask: TaskRef
  graph: CompiledPrdGraph
}): ChildRunLinkRecord | undefined {
  const validated = validateChildRuntimeGraph(input.graph)
  const childDocumentId = validated.childDocumentByParentTask.get(taskKey(input.parentTask))
  if (!childDocumentId) return undefined
  return assertParentChildCompletionReady(input.ledger, {
    parentRunId: input.parentRunId,
    parentDocumentId: input.parentTask.documentId,
    parentTaskId: input.parentTask.taskId,
    expectedChildDocumentId: childDocumentId,
  })
}

export async function acquireChildSupervisorLease(
  options: ChildSupervisorLeaseOptions,
): Promise<ChildSupervisorLease> {
  const parentPolicy = options.parentPolicy ?? options.link.parentPolicy
  if (parentPolicy === "survive-parent" && !options.independentOwner) {
    throw schedulingError(
      "RALPH_CHILD_SURVIVE_PARENT_OWNER_REQUIRED",
      "survive-parent requires a process owner and lease independent from the parent worker tree",
      { linkId: options.link.id },
    )
  }
  const leaseDurationMs = options.leaseDurationMs ?? 30_000
  const staleGraceMs = options.staleGraceMs ?? 20_000
  const renewalIntervalMs =
    options.renewalIntervalMs ?? Math.max(1_000, Math.floor(leaseDurationMs / 3))
  if (
    !Number.isSafeInteger(renewalIntervalMs) ||
    renewalIntervalMs < 250 ||
    renewalIntervalMs >= leaseDurationMs
  ) {
    throw schedulingError(
      "RALPH_CHILD_LEASE_RENEWAL_INVALID",
      "Child lease renewal interval must be shorter than its duration",
      { renewalIntervalMs, leaseDurationMs },
    )
  }
  const acquired = await acquireDurableLease(
    options.ledger,
    {
      kind: "run-supervisor",
      resourceKey: `child-run:${options.link.childRunId}`,
      workspaceId: options.link.workspaceId,
      runId: options.link.childRunId,
      ...(options.workerId ? { workerId: options.workerId } : {}),
      command: options.command,
      scope: [
        "child:supervise",
        `run:${options.link.childRunId}`,
        `parent-run:${options.link.parentRunId}`,
        `parent-task:${options.link.parentDocumentId}/${options.link.parentTaskId}`,
      ],
      parentRunId: options.link.parentRunId,
      ...(options.parentWorkerId ? { parentWorkerId: options.parentWorkerId } : {}),
      ...options.owner,
      leaseDurationMs,
      staleGraceMs,
      staleProbeConfirmations: 2,
      staleProbeIntervalMs: 250,
    },
    { probeOwner: options.probeOwner },
  )
  let current = acquired.lease
  let released = false
  let renewalFailure: unknown
  let renewal: Promise<void> | undefined
  const renewOnce = (): Promise<void> => {
    if (released) return Promise.resolve()
    if (renewalFailure) return Promise.reject(renewalFailure)
    if (renewal) return renewal
    const operation = Promise.resolve().then(() => {
      if (options.renewalGuard && !options.renewalGuard()) {
        throw schedulingError(
          "RALPH_CHILD_LEASE_HEALTH_REJECTED",
          "Child lease renewal was rejected because the exact worker health proof expired",
          { linkId: options.link.id, childRunId: options.link.childRunId },
        )
      }
      current = renewDurableLease(
        options.ledger,
        current.id,
        options.owner,
        leaseDurationMs,
        staleGraceMs,
      )
    })
    renewal = operation
    void operation
      .catch((error) => {
        if (!renewalFailure) {
          renewalFailure = error
          try {
            options.onRenewalFailure?.(error)
          } catch {
            // The renewal failure remains authoritative even if its observer fails.
          }
        }
      })
      .finally(() => {
        if (renewal === operation) renewal = undefined
      })
    return operation
  }
  const timer = setInterval(() => {
    void renewOnce().catch(() => undefined)
  }, renewalIntervalMs)
  timer.unref()
  return {
    id: current.id,
    owner: options.owner,
    get current() {
      return current
    },
    assertOwned(): DurableLeaseRecord {
      if (renewalFailure) throw renewalFailure
      current = assertDurableLeaseOwned(options.ledger, current.id, options.owner)
      return current
    },
    async renew(): Promise<DurableLeaseRecord> {
      if (renewalFailure) throw renewalFailure
      await renewOnce()
      if (renewalFailure) throw renewalFailure
      return current
    },
    async release(): Promise<void> {
      if (released) return
      released = true
      clearInterval(timer)
      if (renewal) await renewal.catch(() => undefined)
      current = releaseDurableLease(options.ledger, current.id, options.owner)
    },
  }
}

function projectedEventId(linkId: string, sourceEventId: string): string {
  return `child-projection-${createHash("sha256")
    .update(`${linkId}\u0000${sourceEventId}`)
    .digest("hex")}`
}

export async function superviseChildRun(
  input: SuperviseChildRunInput,
): Promise<SupervisedChildResult> {
  const validated = validateChildRuntimeGraph(input.graph)
  const existingLink = getChildRunLink(input.ledger, input.linkId)
  if (!existingLink) {
    throw schedulingError(
      "RALPH_CHILD_LINK_NOT_FOUND",
      `Child link does not exist: ${input.linkId}`,
    )
  }
  let link = existingLink
  const childDocument = validated.graph.documents[link.childDocumentId]
  if (!childDocument || childDocument.kind !== "child") {
    throw schedulingError(
      "RALPH_CHILD_GRAPH_DOCUMENT_INVALID",
      "Durable child link is not bound to a compiled child document",
      { linkId: link.id, childDocumentId: link.childDocumentId },
    )
  }
  const compiledChildDocumentId = validated.childDocumentByParentTask.get(
    `${link.parentDocumentId}/${link.parentTaskId}`,
  )
  if (compiledChildDocumentId !== link.childDocumentId) {
    throw schedulingError(
      "RALPH_CHILD_RESUME_BINDING_MISMATCH",
      "Durable child link no longer matches its compiled parent task edge",
      {
        linkId: link.id,
        expectedChildDocumentId: compiledChildDocumentId,
        actualChildDocumentId: link.childDocumentId,
      },
    )
  }
  if (
    link.graphDefinitionHash !== validated.graph.definitionHash ||
    link.inheritedOptionsHash !== input.effectiveOptions.contentHash
  ) {
    throw schedulingError(
      "RALPH_CHILD_RESUME_BINDING_MISMATCH",
      "Child resume graph/options differ from its immutable reservation",
      {
        expectedDefinitionHash: link.graphDefinitionHash,
        actualDefinitionHash: validated.graph.definitionHash,
        expectedOptionsHash: link.inheritedOptionsHash,
        actualOptionsHash: input.effectiveOptions.contentHash,
      },
    )
  }
  if (["passed", "failed", "cancelled"].includes(link.status)) {
    const run = getRun(input.ledger, link.childRunId)
    if (!run) throw schedulingError("RALPH_CHILD_RUN_NOT_FOUND", "Terminal child run is missing")
    return { link, runStatus: run.status, resumed: true }
  }

  const initialRun = getRun(input.ledger, link.childRunId)
  if (!initialRun) {
    throw schedulingError("RALPH_CHILD_RUN_NOT_FOUND", `Child run is missing: ${link.childRunId}`)
  }
  const resumed = link.status !== "reserved" || initialRun.status !== "created"
  const lease = await acquireChildSupervisorLease({
    ledger: input.ledger,
    link,
    owner: input.owner,
    ...(input.workerId ? { workerId: input.workerId } : {}),
    ...(input.parentWorkerId ? { parentWorkerId: input.parentWorkerId } : {}),
    command: input.command,
    probeOwner: input.probeOwner,
    parentPolicy: link.parentPolicy,
    ...(input.independentOwner !== undefined ? { independentOwner: input.independentOwner } : {}),
    ...(input.leaseDurationMs !== undefined ? { leaseDurationMs: input.leaseDurationMs } : {}),
    ...(input.staleGraceMs !== undefined ? { staleGraceMs: input.staleGraceMs } : {}),
    ...(input.renewalIntervalMs !== undefined
      ? { renewalIntervalMs: input.renewalIntervalMs }
      : {}),
    ...(input.leaseRenewalGuard ? { renewalGuard: input.leaseRenewalGuard } : {}),
    ...(input.onLeaseRenewalFailure ? { onRenewalFailure: input.onLeaseRenewalFailure } : {}),
  })
  const timestamp = input.now ?? (() => new Date().toISOString())
  let mutation = Promise.resolve()
  const serialize = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const next = mutation.then(operation, operation)
    mutation = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const observe = (observation: ChildExecutionObservation): Promise<void> =>
    serialize(async () => {
      lease.assertOwned()
      const current = getChildRunLink(input.ledger, link.id)
      if (!current || ["passed", "failed", "cancelled"].includes(current.status)) return
      link = updateChildRunObservation(input.ledger, {
        linkId: current.id,
        expectedRevision: current.revision,
        ...(observation.status ? { status: observation.status } : {}),
        leaseId: lease.id,
        observability: ChildRunObservabilitySchema.parse(observation.observability),
        heartbeatAt: observation.heartbeatAt ?? timestamp(),
        updatedAt: timestamp(),
        ...(observation.reason ? { reason: observation.reason } : {}),
      })
    })
  const projectEvent = (event: EventEnvelope): Promise<void> =>
    serialize(async () => {
      lease.assertOwned()
      projectChildEventToParent(input.ledger, {
        linkId: link.id,
        sourceEvent: event,
        projectedEventId:
          input.projectedEventId?.(event.eventId) ?? projectedEventId(link.id, event.eventId),
        projectedAt: timestamp(),
      })
      link = getChildRunLink(input.ledger, link.id) ?? link
    })
  try {
    if (TERMINAL_RUN_STATUSES.includes(initialRun.status)) {
      link = updateChildRunObservation(input.ledger, {
        linkId: link.id,
        expectedRevision: link.revision,
        leaseId: lease.id,
        heartbeatAt: timestamp(),
        updatedAt: timestamp(),
      })
      const reconciliation = await input.execution.reconcileTerminal({
        link,
        graph: validated.graph,
        childDocument,
        effectiveOptions: input.effectiveOptions,
        assertLease: () => lease.assertOwned(),
        observe,
        projectEvent,
      })
      await mutation
      lease.assertOwned()
      const current = getChildRunLink(input.ledger, link.id)
      if (!current) throw schedulingError("RALPH_CHILD_LINK_NOT_FOUND", "Child link disappeared")
      link = settleChildRun(input.ledger, {
        linkId: current.id,
        expectedRevision: current.revision,
        artifactsReconciled: reconciliation.artifactsReconciled,
        reason: reconciliation.reason,
        finishedAt: timestamp(),
      })
      return { link, runStatus: initialRun.status, resumed: true }
    }
    link = updateChildRunObservation(input.ledger, {
      linkId: link.id,
      expectedRevision: link.revision,
      status: link.status === "running" ? "running" : "starting",
      leaseId: lease.id,
      heartbeatAt: timestamp(),
      updatedAt: timestamp(),
    })
    const result = await input.execution.execute({
      link,
      graph: validated.graph,
      childDocument,
      effectiveOptions: input.effectiveOptions,
      ...(link.parentPolicy === "pause-with-parent" && input.signal
        ? { signal: input.signal }
        : {}),
      assertLease: () => lease.assertOwned(),
      observe,
      projectEvent,
    })
    await mutation
    lease.assertOwned()
    const run = getRun(input.ledger, link.childRunId)
    if (!run) throw schedulingError("RALPH_CHILD_RUN_NOT_FOUND", "Executed child run is missing")
    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      const current = getChildRunLink(input.ledger, link.id)
      if (!current) throw schedulingError("RALPH_CHILD_LINK_NOT_FOUND", "Child link disappeared")
      link = settleChildRun(input.ledger, {
        linkId: current.id,
        expectedRevision: current.revision,
        artifactsReconciled: result.artifactsReconciled,
        reason: result.reason,
        finishedAt: timestamp(),
      })
    } else {
      const current = getChildRunLink(input.ledger, link.id)
      if (!current) throw schedulingError("RALPH_CHILD_LINK_NOT_FOUND", "Child link disappeared")
      const status =
        run.status === "waiting" ? "waiting" : run.status === "running" ? "running" : "interrupted"
      link = updateChildRunObservation(input.ledger, {
        linkId: current.id,
        expectedRevision: current.revision,
        status,
        leaseId: lease.id,
        heartbeatAt: timestamp(),
        updatedAt: timestamp(),
        reason: result.reason,
      })
    }
    return { link, runStatus: run.status, resumed }
  } catch (error) {
    await mutation.catch(() => undefined)
    const run = getRun(input.ledger, link.childRunId)
    const current = getChildRunLink(input.ledger, link.id)
    if (run && current && !["passed", "failed", "cancelled"].includes(current.status)) {
      if (TERMINAL_RUN_STATUSES.includes(run.status)) {
        try {
          link = settleChildRun(input.ledger, {
            linkId: current.id,
            expectedRevision: current.revision,
            artifactsReconciled: false,
            reason: error instanceof Error ? error.message : String(error),
            finishedAt: timestamp(),
          })
        } catch {
          // Preserve the original execution failure; reconciliation will retry the terminal receipt.
        }
      } else {
        try {
          link = updateChildRunObservation(input.ledger, {
            linkId: current.id,
            expectedRevision: current.revision,
            status: "interrupted",
            leaseId: lease.id,
            heartbeatAt: timestamp(),
            updatedAt: timestamp(),
            reason: error instanceof Error ? error.message : String(error),
          })
        } catch {
          // A lost lease/revision must not be overwritten by this stale supervisor.
        }
      }
    }
    throw error
  } finally {
    await lease.release().catch(() => undefined)
  }
}

export async function requestGracefulChildTreeStop(input: {
  ledger: string
  rootRunId: string
  execution: ChildRunExecutionPort
  reason: string
  graceMs?: number
}): Promise<readonly string[]> {
  const links = listChildRunTree(input.ledger, input.rootRunId)
    .filter((link) => !["passed", "failed", "cancelled"].includes(link.status))
    .sort((left, right) => right.depth - left.depth || left.id.localeCompare(right.id))
  const requested: string[] = []
  for (const link of links) {
    if (!input.execution.requestStop) break
    await input.execution.requestStop({
      link,
      mode: "graceful",
      reason: input.reason,
      ...(input.graceMs !== undefined ? { graceMs: input.graceMs } : {}),
    })
    requested.push(link.childRunId)
  }
  return requested
}

export function childConcurrencyAvailable(input: {
  ledger: string
  rootRunId: string
  maxConcurrentChildren: number
}): { available: boolean; active: number; limit: number } {
  const limit = ChildRunLimitsSchema.shape.maxConcurrentChildren.parse(input.maxConcurrentChildren)
  const active = listChildRunTree(input.ledger, input.rootRunId).filter((link) =>
    ["starting", "running"].includes(link.status),
  ).length
  return { available: active < limit, active, limit }
}

export function directChildOwnership(input: { ledger: string; parentRunId: string }): readonly {
  childRunId: string
  parentPolicy: ChildParentPolicy
  terminal: boolean
}[] {
  return listDirectChildRunLinks(input.ledger, input.parentRunId).map((link) => ({
    childRunId: link.childRunId,
    parentPolicy: link.parentPolicy,
    terminal: ["passed", "failed", "cancelled"].includes(link.status),
  }))
}
