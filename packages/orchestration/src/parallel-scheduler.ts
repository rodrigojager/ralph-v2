import {
  EXIT_CODES,
  RalphError,
  type ResourceClaimSetRecord,
  type ResourceClaimSpec,
} from "@ralph-next/domain"

export type ParallelTaskStatus =
  | "pending"
  | "claiming"
  | "active"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"

export type ParallelTaskCandidate = {
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  graphOrder: number
  status: ParallelTaskStatus
  dependencies: readonly string[]
  parallelGroup?: string
  providerId: string
  modelId: string
  declaredClaims: readonly ResourceClaimSpec[]
  childRequiresParentSequencing: boolean
  baselineConsistent: boolean
  isolation: "worktree" | "sandbox-copy" | "none"
  capabilitiesAvailable: boolean
  credentialsAvailable: boolean
  failureCount: number
  reconciliationOnly?: boolean
}

export type ParallelSchedulingPolicy = {
  parallelAuto: boolean
  allowedGroups: readonly string[]
  retryFailed: boolean
  maximumFailureRetries: number
  failFast: boolean
  requireIsolatedWorkspace: boolean
  allowCommandOwnedChildLane?: boolean
}

export type ParallelCapacity = {
  maximumGlobal: number
  activeGlobal: number
  maximumProject: number
  activeProject: number
  maximumByProvider: Readonly<Record<string, number>>
  activeByProvider: Readonly<Record<string, number>>
  maximumByModel: Readonly<Record<string, number>>
  activeByModel: Readonly<Record<string, number>>
}

export type ParallelEligibility =
  | { eligible: true }
  | {
      eligible: false
      code:
        | "terminal"
        | "status"
        | "dependency"
        | "group"
        | "child-sequencing"
        | "baseline"
        | "isolation"
        | "claims"
        | "capability"
        | "credential"
        | "retry-exhausted"
        | "capacity-global"
        | "capacity-project"
        | "capacity-provider"
        | "capacity-model"
      reason: string
    }

export type ParallelDispatch = {
  candidate: ParallelTaskCandidate
  ordinal: number
}

export type ParallelSelection = {
  dispatches: readonly ParallelDispatch[]
  deferred: readonly { candidate: ParallelTaskCandidate; eligibility: ParallelEligibility }[]
  draining: boolean
  reason?: string
}

function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RalphError("RALPH_PARALLEL_LIMIT_INVALID", `${name} must be a non-negative integer`, {
      exitCode: EXIT_CODES.invalidUsage,
      details: { name, value },
    })
  }
  return value
}

function modelCapacityKey(candidate: ParallelTaskCandidate): string {
  return `${candidate.providerId}/${candidate.modelId}`
}

function capacityEligibility(
  candidate: ParallelTaskCandidate,
  capacity: ParallelCapacity,
): ParallelEligibility {
  if (capacity.activeGlobal >= capacity.maximumGlobal) {
    return { eligible: false, code: "capacity-global", reason: "Global worker limit is full" }
  }
  if (capacity.activeProject >= capacity.maximumProject) {
    return { eligible: false, code: "capacity-project", reason: "Project worker limit is full" }
  }
  const providerMaximum = capacity.maximumByProvider[candidate.providerId]
  if (
    providerMaximum !== undefined &&
    (capacity.activeByProvider[candidate.providerId] ?? 0) >= providerMaximum
  ) {
    return {
      eligible: false,
      code: "capacity-provider",
      reason: `Provider worker limit is full for ${candidate.providerId}`,
    }
  }
  const key = modelCapacityKey(candidate)
  const modelMaximum = capacity.maximumByModel[key]
  if (modelMaximum !== undefined && (capacity.activeByModel[key] ?? 0) >= modelMaximum) {
    return {
      eligible: false,
      code: "capacity-model",
      reason: `Model worker limit is full for ${key}`,
    }
  }
  return { eligible: true }
}

export function evaluateParallelEligibility(input: {
  candidate: ParallelTaskCandidate
  completedTaskIds: ReadonlySet<string>
  policy: ParallelSchedulingPolicy
  capacity: ParallelCapacity
}): ParallelEligibility {
  const { candidate, completedTaskIds, policy, capacity } = input
  if (candidate.status === "completed") {
    return {
      eligible: false,
      code: "terminal",
      reason: "Completed tasks are never dispatched again",
    }
  }
  if (candidate.status === "active" || candidate.status === "claiming") {
    return {
      eligible: false,
      code: "status",
      reason: `Task already has live work in status ${candidate.status}`,
    }
  }
  if (candidate.status === "blocked") {
    return { eligible: false, code: "status", reason: "Blocked task requires explicit resolution" }
  }
  if (candidate.status === "failed" || candidate.status === "interrupted") {
    if (!policy.retryFailed) {
      return { eligible: false, code: "status", reason: "Failed-task retry policy is disabled" }
    }
    if (candidate.failureCount > policy.maximumFailureRetries) {
      return {
        eligible: false,
        code: "retry-exhausted",
        reason: "Failed-task retry budget is exhausted",
      }
    }
  } else if (candidate.status !== "pending") {
    return { eligible: false, code: "status", reason: `Task status is not dispatchable` }
  }
  const missingDependency = candidate.dependencies.find((taskId) => !completedTaskIds.has(taskId))
  if (missingDependency) {
    return {
      eligible: false,
      code: "dependency",
      reason: `Dependency ${missingDependency} is not durably completed`,
    }
  }
  const commandOwnedChildLane =
    candidate.childRequiresParentSequencing && policy.allowCommandOwnedChildLane === true
  const groupAllowed =
    candidate.parallelGroup !== undefined && policy.allowedGroups.includes(candidate.parallelGroup)
  if (
    !candidate.reconciliationOnly &&
    !commandOwnedChildLane &&
    !groupAllowed &&
    !policy.parallelAuto
  ) {
    return {
      eligible: false,
      code: "group",
      reason: "Task is not in an allowed parallel group and parallel-auto is disabled",
    }
  }
  if (candidate.childRequiresParentSequencing && !commandOwnedChildLane) {
    return {
      eligible: false,
      code: "child-sequencing",
      reason: "Child graph requires parent sequencing",
    }
  }
  if (!candidate.baselineConsistent) {
    return { eligible: false, code: "baseline", reason: "Git baseline is not consistent" }
  }
  if (policy.requireIsolatedWorkspace && candidate.isolation === "none") {
    return {
      eligible: false,
      code: "isolation",
      reason: "Parallel task has no isolated worktree or explicit sandbox copy",
    }
  }
  if (candidate.declaredClaims.length === 0) {
    return {
      eligible: false,
      code: "claims",
      reason: "Parallel task declares no task/path/artifact/port/integration claims",
    }
  }
  if (!candidate.capabilitiesAvailable) {
    return {
      eligible: false,
      code: "capability",
      reason: "Required worker, Git or sandbox capability is unavailable",
    }
  }
  if (!candidate.credentialsAvailable) {
    return {
      eligible: false,
      code: "credential",
      reason: "Required provider credentials are unavailable for another worker",
    }
  }
  return capacityEligibility(candidate, capacity)
}

function reserveCapacity(capacity: ParallelCapacity, candidate: ParallelTaskCandidate): void {
  capacity.activeGlobal += 1
  capacity.activeProject += 1
  const provider = candidate.providerId
  capacity.activeByProvider = {
    ...capacity.activeByProvider,
    [provider]: (capacity.activeByProvider[provider] ?? 0) + 1,
  }
  const model = modelCapacityKey(candidate)
  capacity.activeByModel = {
    ...capacity.activeByModel,
    [model]: (capacity.activeByModel[model] ?? 0) + 1,
  }
}

function mutableCapacity(capacity: ParallelCapacity): ParallelCapacity {
  positiveLimit("maximumGlobal", capacity.maximumGlobal)
  positiveLimit("activeGlobal", capacity.activeGlobal)
  positiveLimit("maximumProject", capacity.maximumProject)
  positiveLimit("activeProject", capacity.activeProject)
  for (const [key, value] of Object.entries(capacity.maximumByProvider)) {
    positiveLimit(`maximumByProvider.${key}`, value)
  }
  for (const [key, value] of Object.entries(capacity.activeByProvider)) {
    positiveLimit(`activeByProvider.${key}`, value)
  }
  for (const [key, value] of Object.entries(capacity.maximumByModel)) {
    positiveLimit(`maximumByModel.${key}`, value)
  }
  for (const [key, value] of Object.entries(capacity.activeByModel)) {
    positiveLimit(`activeByModel.${key}`, value)
  }
  return {
    ...capacity,
    activeByProvider: { ...capacity.activeByProvider },
    activeByModel: { ...capacity.activeByModel },
  }
}

export function selectParallelDispatches(input: {
  candidates: readonly ParallelTaskCandidate[]
  completedTaskIds: ReadonlySet<string>
  policy: ParallelSchedulingPolicy
  capacity: ParallelCapacity
  failureObserved: boolean
}): ParallelSelection {
  if (input.failureObserved && input.policy.failFast) {
    return {
      dispatches: [],
      deferred: input.candidates.map((candidate) => ({
        candidate,
        eligibility: {
          eligible: false,
          code: "status",
          reason: "Fail-fast is draining active workers and schedules no new work",
        },
      })),
      draining: true,
      reason: "A task failed under fail-fast policy",
    }
  }
  const capacity = mutableCapacity(input.capacity)
  const ordered = [...input.candidates].sort(
    (left, right) => left.graphOrder - right.graphOrder || left.taskId.localeCompare(right.taskId),
  )
  const dispatches: ParallelDispatch[] = []
  const deferred: { candidate: ParallelTaskCandidate; eligibility: ParallelEligibility }[] = []
  if (input.policy.allowCommandOwnedChildLane === true) {
    const laneCandidate = ordered.find((candidate) => {
      if (!candidate.childRequiresParentSequencing) return false
      return evaluateParallelEligibility({
        candidate,
        completedTaskIds: input.completedTaskIds,
        policy: input.policy,
        capacity,
      }).eligible
    })
    if (laneCandidate) {
      reserveCapacity(capacity, laneCandidate)
      return {
        dispatches: [{ candidate: laneCandidate, ordinal: 0 }],
        deferred: ordered
          .filter((candidate) => candidate !== laneCandidate)
          .map((candidate) => ({
            candidate,
            eligibility: {
              eligible: false,
              code: "status" as const,
              reason: "A command-owned child lane has exclusive scheduling for this wave",
            },
          })),
        draining: false,
      }
    }
  }
  for (const candidate of ordered) {
    const eligibility = evaluateParallelEligibility({
      candidate,
      completedTaskIds: input.completedTaskIds,
      policy: input.policy,
      capacity,
    })
    if (!eligibility.eligible) {
      deferred.push({ candidate, eligibility })
      continue
    }
    dispatches.push({ candidate, ordinal: dispatches.length })
    reserveCapacity(capacity, candidate)
  }
  return { dispatches, deferred, draining: false }
}

export interface ParallelClaimPort {
  acquire(input: {
    candidate: ParallelTaskCandidate
    workerId: string
    claims: readonly ResourceClaimSpec[]
  }): Promise<ResourceClaimSetRecord>
}

export interface ParallelClaimReleasePort extends ParallelClaimPort {
  release(input: { claimSet: ResourceClaimSetRecord; reason: string }): Promise<void>
}

export interface ParallelCapacityLeasePort {
  reserve(input: {
    runId: string
    taskId: string
    attemptId: string
    workerId: string
    providerId: string
    modelId: string
  }): Promise<
    | { status: "reserved"; leaseId: string }
    | { status: "full"; scope: "global" | "project" | "provider" | "model"; reason: string }
  >
  release(leaseId: string, reason: string): Promise<void>
}

export type ClaimedParallelDispatch = ParallelDispatch & {
  workerId: string
  capacityLeaseId: string
  claimSet: ResourceClaimSetRecord
}

export async function claimParallelDispatches(input: {
  selection: ParallelSelection
  claimPort: ParallelClaimReleasePort
  capacityPort: ParallelCapacityLeasePort
  workerId: (candidate: ParallelTaskCandidate, ordinal: number) => string
}): Promise<{
  claimed: readonly ClaimedParallelDispatch[]
  conflicts: readonly { dispatch: ParallelDispatch; error: RalphError; capacityScope?: string }[]
}> {
  const claimed: ClaimedParallelDispatch[] = []
  const conflicts: { dispatch: ParallelDispatch; error: RalphError; capacityScope?: string }[] = []
  const releaseClaimedAfterFatalError = async (cause: unknown): Promise<never> => {
    const releases = await Promise.allSettled(
      [...claimed].reverse().map(async (dispatch) => {
        try {
          await input.claimPort.release({
            claimSet: dispatch.claimSet,
            reason: "Parallel dispatch preparation aborted before workers started",
          })
        } finally {
          await input.capacityPort.release(
            dispatch.capacityLeaseId,
            "Parallel dispatch preparation aborted before workers started",
          )
        }
      }),
    )
    const releaseFailure = releases.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    )
    if (releaseFailure) {
      throw new RalphError(
        "RALPH_PARALLEL_PRESTART_RELEASE_FAILED",
        "Parallel dispatch failed and a previously acquired claim/capacity bundle could not be released",
        {
          exitCode: EXIT_CODES.operationalError,
          cause: releaseFailure.reason,
          details: { originalFailure: cause instanceof Error ? cause.message : String(cause) },
        },
      )
    }
    throw cause
  }
  for (const dispatch of input.selection.dispatches) {
    const workerId = input.workerId(dispatch.candidate, dispatch.ordinal)
    let capacity: Awaited<ReturnType<ParallelCapacityLeasePort["reserve"]>>
    try {
      capacity = await input.capacityPort.reserve({
        runId: dispatch.candidate.runId,
        taskId: dispatch.candidate.taskId,
        attemptId: dispatch.candidate.attemptId,
        workerId,
        providerId: dispatch.candidate.providerId,
        modelId: dispatch.candidate.modelId,
      })
    } catch (error) {
      return releaseClaimedAfterFatalError(error)
    }
    if (capacity.status === "full") {
      conflicts.push({
        dispatch,
        capacityScope: capacity.scope,
        error: new RalphError(
          "RALPH_PARALLEL_CAPACITY_FULL",
          "Parallel capacity became full before dispatch",
          {
            exitCode: EXIT_CODES.conflict,
            details: { scope: capacity.scope, reason: capacity.reason },
          },
        ),
      })
      continue
    }
    try {
      const claimSet = await input.claimPort.acquire({
        candidate: dispatch.candidate,
        workerId,
        claims: dispatch.candidate.declaredClaims,
      })
      claimed.push({ ...dispatch, workerId, capacityLeaseId: capacity.leaseId, claimSet })
    } catch (error) {
      try {
        await input.capacityPort.release(
          capacity.leaseId,
          `Resource claim failed for ${dispatch.candidate.taskId}`,
        )
      } catch (releaseError) {
        return releaseClaimedAfterFatalError(
          new RalphError(
            "RALPH_PARALLEL_CAPACITY_RELEASE_FAILED",
            "Resource claim failed and its reserved capacity could not be released",
            {
              exitCode: EXIT_CODES.operationalError,
              cause: releaseError,
              details: {
                taskId: dispatch.candidate.taskId,
                claimFailure: error instanceof Error ? error.message : String(error),
              },
            },
          ),
        )
      }
      const converted =
        error instanceof RalphError
          ? error
          : new RalphError("RALPH_PARALLEL_CLAIM_FAILED", "Parallel resource claim failed", {
              cause: error,
              details: { taskId: dispatch.candidate.taskId },
            })
      if (converted.code !== "RALPH_RESOURCE_CLAIM_CONFLICT") {
        return releaseClaimedAfterFatalError(converted)
      }
      conflicts.push({ dispatch, error: converted })
    }
  }
  return { claimed, conflicts }
}

export type ParallelWorkerTerminal = {
  taskId: string
  attemptId: string
  outcome: "completed" | "failed" | "interrupted"
  failureCount: number
}

export function nextParallelWorkerAction(
  terminal: ParallelWorkerTerminal,
  policy: ParallelSchedulingPolicy,
): "complete" | "retry" | "drain" | "leave-failed" {
  if (terminal.outcome === "completed") return "complete"
  if (policy.failFast) return "drain"
  if (policy.retryFailed && terminal.failureCount <= policy.maximumFailureRetries) return "retry"
  return "leave-failed"
}
