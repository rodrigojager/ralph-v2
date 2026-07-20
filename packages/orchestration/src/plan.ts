import type { EffectiveRunOptions } from "@ralph-next/domain"
import type {
  CompiledPrdGraph,
  ExecutableVerificationSpec,
  PrdTask,
  TaskRef,
} from "@ralph-next/prd"

export type PlannedVerification = {
  id: string
  type: PrdTask["verification"][number]["type"]
  category: PrdTask["verification"][number]["category"]
  skipPolicy: PrdTask["verification"][number]["skipPolicy"]
  blocking: boolean
  attempts?: number
  timeoutMs?: number
  applicability?: ExecutableVerificationSpec["applicability"]
  command?: Extract<PrdTask["verification"][number], { type: "command" }>["command"]
  details?: Readonly<Record<string, unknown>>
}

export type PlannedChildEdge = {
  parentTask: TaskRef
  childDocument: string
}

export type PlannedEffects = {
  createsRun: boolean
  createsAttempt: boolean
  invokesBackend: boolean
  invokesJudge: boolean
  verificationIds: string[]
  mayUpdateMarkerAfterEvidence: boolean
  writesDuringDryRun: false
}

export type ExecutionPlan = {
  sourceKind: "prd" | "ad-hoc"
  sourceDescriptionHash?: string
  rootPrdId: string
  rootPrdFile: string
  definitionHash: string
  graphHash: string
  task?: TaskRef
  selectionReason?: string
  dependencyOverride: boolean
  totalTasks: number
  completedTasks: number
  backendProfile: string
  /** Whether the selected deepest external task needs a backend in this plan. */
  backendRequired: boolean
  backendAvailable: boolean
  evaluation: {
    mode: EffectiveRunOptions["evaluationMode"]["value"]
    judgeProfile?: string
    judgeAvailable?: boolean
    threshold: number
    maxRevisionAttempts: number
    unavailablePolicy: EffectiveRunOptions["judgeUnavailablePolicy"]["value"]
  }
  gatePolicy: {
    noGates: boolean
    skipTests: boolean
    skipLint: boolean
    skipGates: string[]
    fast: boolean
  }
  verifications: PlannedVerification[]
  childEdges: PlannedChildEdge[]
  childExecutionSupported: boolean
  effects: PlannedEffects
}

function selectedTask(
  graph: CompiledPrdGraph,
  reference: TaskRef | undefined,
): PrdTask | undefined {
  if (!reference) return undefined
  return graph.documents[reference.documentId]?.tasks.find((task) => task.id === reference.taskId)
}

function completedMarkerCount(graph: CompiledPrdGraph): number {
  return Object.values(graph.documents).reduce(
    (count, document) =>
      count + document.tasks.filter((task) => task.status === "completed").length,
    0,
  )
}

export function buildExecutionPlan(input: {
  graph: CompiledPrdGraph
  options: EffectiveRunOptions
  sourceKind?: "prd" | "ad-hoc"
  sourceDescriptionHash?: string
  completedTasks?: number
  selection?: { task: TaskRef; reason: string; dependencyOverride: boolean }
  backendAvailable: boolean
  judgeAvailable?: boolean
  runAlreadyExists?: boolean
}): ExecutionPlan {
  const task = selectedTask(input.graph, input.selection?.task)
  const verifications: PlannedVerification[] = (task?.verification ?? [])
    .filter(
      (verification): verification is ExecutableVerificationSpec =>
        verification.type !== "instruction",
    )
    .map((verification) => {
      const details: Readonly<Record<string, unknown>> | undefined = (() => {
        switch (verification.type) {
          case "command":
            return undefined
          case "file":
            return { path: verification.path, expectation: verification.expectation }
          case "schema":
            return { path: verification.path, schema: verification.schema }
          case "git":
            return { expectation: verification.expectation }
          case "artifact":
            return {
              artifactId: verification.artifactId,
              path: verification.path,
              ...(verification.schema ? { schema: verification.schema } : {}),
              ...(verification.expectedSha256
                ? { expectedSha256: verification.expectedSha256 }
                : {}),
            }
          case "plugin":
            return { plugin: verification.plugin, input: verification.input }
        }
      })()
      return {
        id: verification.id,
        type: verification.type,
        category: verification.category,
        skipPolicy: verification.skipPolicy,
        blocking: verification.blocking,
        ...(verification.attempts !== undefined ? { attempts: verification.attempts } : {}),
        ...(verification.timeoutMs !== undefined ? { timeoutMs: verification.timeoutMs } : {}),
        ...(verification.applicability ? { applicability: verification.applicability } : {}),
        ...(verification.type === "command" ? { command: verification.command } : {}),
        ...(details ? { details } : {}),
      }
    })
  const childEdges = input.graph.childEdges.map((edge) => ({
    parentTask: edge.parentTask,
    childDocument: edge.childDocument,
  }))
  // Child edges are executed by the command-owned supervisor. They are not a
  // capability gap and must never make an otherwise selected execution plan
  // unavailable. The caller resolves backend availability for the actual
  // external task selected at the deepest active scope.
  const executable = input.selection !== undefined && input.backendAvailable

  return {
    sourceKind: input.sourceKind ?? "prd",
    ...(input.sourceDescriptionHash ? { sourceDescriptionHash: input.sourceDescriptionHash } : {}),
    rootPrdId: input.graph.rootDocumentId,
    rootPrdFile: input.graph.rootFile,
    definitionHash: input.graph.definitionHash,
    graphHash: input.graph.graphHash,
    ...(input.selection
      ? { task: input.selection.task, selectionReason: input.selection.reason }
      : {}),
    dependencyOverride: input.selection?.dependencyOverride ?? false,
    totalTasks: input.graph.topologicalOrder.length,
    completedTasks: input.completedTasks ?? completedMarkerCount(input.graph),
    backendProfile: input.options.executorProfile.value,
    backendRequired: input.selection !== undefined,
    backendAvailable: input.backendAvailable,
    evaluation: {
      mode: input.options.evaluationMode.value,
      ...(input.options.evaluationMode.value === "self"
        ? { judgeProfile: input.options.executorProfile.value }
        : input.options.judgeProfile?.value
          ? { judgeProfile: input.options.judgeProfile.value }
          : {}),
      ...(input.options.evaluationMode.value === "external" ||
      input.options.evaluationMode.value === "self"
        ? { judgeAvailable: input.judgeAvailable ?? false }
        : {}),
      threshold: input.options.judgeThreshold.value,
      maxRevisionAttempts: input.options.maxRevisionAttempts.value,
      unavailablePolicy: input.options.judgeUnavailablePolicy.value,
    },
    gatePolicy: {
      noGates: input.options.noGates.value,
      skipTests: input.options.skipTests.value,
      skipLint: input.options.skipLint.value,
      skipGates: [...input.options.skipGates.value],
      fast: input.options.fast.value,
    },
    verifications,
    childEdges,
    childExecutionSupported: true,
    effects: {
      createsRun: executable && !input.runAlreadyExists,
      createsAttempt: executable,
      invokesBackend: executable,
      invokesJudge:
        executable &&
        (input.options.evaluationMode.value === "external" ||
          input.options.evaluationMode.value === "self") &&
        input.judgeAvailable === true,
      verificationIds: verifications.map((verification) => verification.id),
      mayUpdateMarkerAfterEvidence: executable && input.sourceKind !== "ad-hoc",
      writesDuringDryRun: false,
    },
  }
}
