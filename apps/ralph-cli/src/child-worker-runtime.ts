import { EffectiveRunOptionsSchema, EXIT_CODES, RalphError, type RunStatus } from "@ralph/domain"
import {
  type ChildTaskBudgetAuthority,
  type ChildTaskBudgetState,
  childRunWorkerLinkHash,
  effectiveOptionsHash,
  executeReservedChildWorker,
  parseRunOptionResolutionContext,
} from "@ralph/orchestration"
import { assertDurableLeaseOwned, getChildRunLink, workspaceLayout } from "@ralph/persistence"
import { compilePrdGraph } from "@ralph/prd"
import {
  type ChildRunWorkerRequest,
  ChildRunWorkerRequestSchema,
  type ChildRunWorkerResult,
  ChildRunWorkerResultSchema,
  ChildTaskBudgetBoundaryCallSchema,
  ChildTaskBudgetReportCallSchema,
  ChildTaskBudgetReserveCallSchema,
  ChildTaskBudgetReserveResultSchema,
  ChildTaskBudgetSnapshotSchema,
  type WorkerResourcePayload,
  type WorkerRoleAdapterContext,
} from "@ralph/supervisor"

import { createS04Services } from "./s04-services"
import { createS05Services } from "./s05-services"
import {
  createWorkerChildRunSession,
  createWorkerGateRegistry,
  createWorkerGitProcessSupervisor,
  createWorkerIsolatedExecutionServices,
  createWorkerIsolatedToolPort,
} from "./worker-composition"

function resourceJson(payload: WorkerResourcePayload): unknown {
  if (payload.content === undefined || payload.path !== undefined) {
    throw new Error(`Child worker resource was not materialized: ${payload.resource.ref}`)
  }
  try {
    return JSON.parse(payload.content)
  } catch (error) {
    throw new RalphError(
      "RALPH_CHILD_WORKER_RESOURCE_INVALID",
      `Child worker resource is not valid JSON: ${payload.resource.ref}`,
      { exitCode: EXIT_CODES.conflict, cause: error },
    )
  }
}

function budgetState(raw: unknown): ChildTaskBudgetState {
  const snapshot = ChildTaskBudgetSnapshotSchema.parse(raw)
  if (
    snapshot.lastExecution &&
    (snapshot.lastExecution.optionsHash !== snapshot.lastExecution.effectiveOptions.contentHash ||
      effectiveOptionsHash(snapshot.lastExecution.effectiveOptions) !==
        snapshot.lastExecution.optionsHash)
  ) {
    throw new RalphError(
      "RALPH_CHILD_TASK_BUDGET_STATE_INVALID",
      "The child task-budget snapshot contains an invalid effective-options binding",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  return {
    limit: snapshot.limit,
    consumed: snapshot.consumed,
    ...(snapshot.lastExecution
      ? {
          lastExecution: {
            runId: snapshot.lastExecution.runId,
            documentId: snapshot.lastExecution.documentId,
            taskId: snapshot.lastExecution.taskId,
            resolution: {
              options: snapshot.lastExecution.effectiveOptions,
              optionsHash: snapshot.lastExecution.optionsHash,
              notices: snapshot.lastExecution.notices,
            },
            ...(snapshot.lastExecution.judgeAvailable !== undefined
              ? { judgeAvailable: snapshot.lastExecution.judgeAvailable }
              : {}),
          },
        }
      : {}),
  }
}

function childWorkerStatus(status: RunStatus): ChildRunWorkerResult["status"] {
  switch (status) {
    case "completed":
      return "passed"
    case "failed":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "waiting":
      return "blocked"
    case "created":
    case "running":
    case "stopping":
    case "interrupted":
      return "interrupted"
  }
}

function ownerFromContext(context: WorkerRoleAdapterContext) {
  return {
    ownerInstanceId: context.identity.workerId,
    pid: context.identity.pid,
    processStartToken: context.identity.processStartToken,
    hostname: context.identity.hostname,
  }
}

function remoteTaskBudget(
  request: ChildRunWorkerRequest,
  context: WorkerRoleAdapterContext,
): ChildTaskBudgetAuthority {
  let state = budgetState(request.taskBudget)
  const binding = {
    schemaVersion: 1 as const,
    childRunId: request.childRunId,
    parentLinkRef: request.parentLinkRef,
  }
  return {
    snapshot: () => state,
    async reserve(input) {
      const response = ChildTaskBudgetReserveResultSchema.parse(
        await context.callSupervisor(
          "child.budget.reserve",
          ChildTaskBudgetReserveCallSchema.parse({
            ...binding,
            task: {
              runId: input.runId,
              documentId: input.task.documentId,
              taskId: input.task.taskId,
              taskSpecHash: input.task.taskSpecHash,
            },
            effectiveOptions: input.resolution.options,
            optionsHash: input.resolution.optionsHash,
            notices: [...input.resolution.notices],
          }),
        ),
      )
      state = budgetState(response.snapshot)
      return { granted: response.granted, state }
    },
    async report(input) {
      const response = await context.callSupervisor(
        "child.budget.report",
        ChildTaskBudgetReportCallSchema.parse({
          ...binding,
          task: {
            runId: input.runId,
            documentId: input.task.documentId,
            taskId: input.task.taskId,
            taskSpecHash: input.task.taskSpecHash,
          },
          ...(input.judgeAvailable !== undefined ? { judgeAvailable: input.judgeAvailable } : {}),
        }),
      )
      state = budgetState(response)
      return state
    },
    async markBoundary(runId) {
      await context.callSupervisor(
        "child.budget.mark-boundary",
        ChildTaskBudgetBoundaryCallSchema.parse({
          ...binding,
          boundaryRunId: runId,
        }),
      )
    },
  }
}

export async function executeChildWorkerRuntime(
  rawRequest: ChildRunWorkerRequest,
  context: WorkerRoleAdapterContext,
): Promise<ChildRunWorkerResult> {
  const request = ChildRunWorkerRequestSchema.parse(rawRequest)
  const startedAt = new Date().toISOString()
  if (request.parentPolicy === "survive-parent") {
    throw new RalphError(
      "RALPH_CHILD_SURVIVE_PARENT_OWNER_REQUIRED",
      "survive-parent is unavailable inside the parent-owned child worker process tree",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const compilation = await compilePrdGraph(request.graphRootFile, {
    workspaceRoot: request.executionRoot,
    recursive: true,
    strict: true,
    maxDepth: request.maximumDepth,
    maxDocuments: 100,
  })
  if (!compilation.ok || !compilation.graph) {
    throw new RalphError(
      "RALPH_CHILD_WORKER_GRAPH_INVALID",
      "The child worker could not reproduce the pre-authorized compiled PRD graph",
      {
        exitCode: EXIT_CODES.invalidPrd,
        details: { diagnostics: compilation.diagnostics },
      },
    )
  }
  if (compilation.graph.definitionHash !== request.graphDefinitionHash) {
    throw new RalphError(
      "RALPH_CHILD_WORKER_GRAPH_CHANGED",
      "The PRD definition changed between child reservation and worker execution",
      {
        exitCode: EXIT_CODES.conflict,
        details: {
          expected: request.graphDefinitionHash,
          actual: compilation.graph.definitionHash,
        },
      },
    )
  }
  const compiledChildDocument = compilation.graph.documents[request.childDocumentId]
  if (
    !compiledChildDocument ||
    compiledChildDocument.kind !== "child" ||
    compiledChildDocument.definitionHash !== request.childDocumentDefinitionHash
  ) {
    throw new RalphError(
      "RALPH_CHILD_WORKER_DOCUMENT_CHANGED",
      "The child document no longer matches its pre-authorized compiled snapshot",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const effectiveOptions = EffectiveRunOptionsSchema.parse(resourceJson(request.effectiveOptions))
  if (effectiveOptionsHash(effectiveOptions) !== effectiveOptions.contentHash) {
    throw new RalphError(
      "RALPH_CHILD_WORKER_OPTIONS_CHANGED",
      "The child worker effective-options payload does not match its content hash",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const optionResolution = parseRunOptionResolutionContext(resourceJson(request.optionResolution))
  const ledger = workspaceLayout(request.scope.workspaceRoot).ledger
  const link = getChildRunLink(ledger, request.parentLinkRef)
  if (
    !link ||
    link.childRunId !== request.childRunId ||
    link.parentRunId !== request.parentRunId ||
    link.parentDocumentId !== request.parentDocumentId ||
    link.parentTaskId !== request.parentTaskId ||
    link.childDocumentId !== request.childDocumentId ||
    link.childRootPrdFile !== compiledChildDocument.file ||
    link.depth !== request.depth ||
    link.parentPolicy !== request.parentPolicy ||
    request.mode !== effectiveOptions.mode.value ||
    childRunWorkerLinkHash(link) !== request.parentLinkHash
  ) {
    throw new RalphError(
      "RALPH_CHILD_WORKER_LINK_CHANGED",
      "The durable parent/child link changed before worker execution",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const owner = ownerFromContext(context)
  const assertLease = () => {
    const lease = assertDurableLeaseOwned(ledger, request.leaseId, owner)
    if (
      lease.kind !== "run-supervisor" ||
      lease.resourceKey !== `child-run:${request.childRunId}` ||
      lease.workspaceId !== request.scope.workspaceId ||
      lease.runId !== request.childRunId ||
      lease.workerId !== context.identity.workerId ||
      lease.parentRunId !== request.parentRunId ||
      lease.parentWorkerId !== context.identity.parentWorkerId ||
      link.leaseId !== lease.id ||
      !lease.scope.includes("child:supervise")
    ) {
      throw new RalphError(
        "RALPH_CHILD_WORKER_LEASE_BINDING_INVALID",
        "The child worker lease is not bound to its authorized run, parent and process identity",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    return lease
  }
  assertLease()

  const toolPort = createWorkerIsolatedToolPort()
  const s04 = createS04Services({ environment: process.env })
  const baseExecution = createS05Services({
    s04,
    environment: process.env,
    toolPort,
  })
  const execution = await createWorkerIsolatedExecutionServices({
    base: baseExecution,
    environment: process.env,
  })
  const result = await executeReservedChildWorker({
    operation: request.operation,
    workspaceRoot: request.scope.workspaceRoot,
    executionRoot: request.executionRoot,
    workspaceId: request.scope.workspaceId,
    link,
    graph: compilation.graph,
    childDocument: compiledChildDocument,
    effectiveOptions,
    optionResolution,
    environment: process.env,
    owner,
    taskBudget: remoteTaskBudget(request, context),
    dependencies: {
      resolveBackend: execution.resolveBackend,
      resolveJudge: execution.resolveJudge,
      toolPort: execution.toolPort,
      gateRegistryFactory: createWorkerGateRegistry,
      gitProcessSupervisorFactory: createWorkerGitProcessSupervisor,
      childRunWorkerSessionFactory: (input) =>
        createWorkerChildRunSession({
          ...input,
          parentWorkerId: context.identity.workerId,
        }),
    },
    ...(request.operation === "execute" ? { signal: context.signal } : {}),
    assertLease,
    async observe(observation) {
      await context.callSupervisor("child.observe", {
        schemaVersion: 1,
        childRunId: request.childRunId,
        parentLinkRef: request.parentLinkRef,
        observation,
      })
      context.emitProgress("child.observed", {
        summary: (observation.reason ?? `Child run ${request.childRunId} reported progress`).slice(
          0,
          4_096,
        ),
        eventType: "child.worker.observed",
        stream: "status",
        completedUnits: observation.observability.progress.completed,
        ...(observation.observability.progress.total > 0
          ? { totalUnits: observation.observability.progress.total }
          : {}),
        redacted: true,
      })
    },
    async projectEvent(event) {
      await context.callSupervisor("child.project-event", {
        schemaVersion: 1,
        childRunId: request.childRunId,
        parentLinkRef: request.parentLinkRef,
        event,
      })
    },
  })
  return ChildRunWorkerResultSchema.parse({
    schemaVersion: 1,
    childRunId: request.childRunId,
    status: childWorkerStatus(result.runStatus),
    artifactsReconciled: result.artifactsReconciled,
    summary: (result.reason || `Child run ${request.childRunId} settled`).slice(0, 4_096),
    eventRefs: [],
    artifactRefs: [],
    startedAt,
    finishedAt: new Date().toISOString(),
    observations: [],
  })
}
