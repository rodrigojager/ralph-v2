import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  type ClaimedParallelDispatch,
  claimParallelDispatches,
  type ParallelCapacity,
  type ParallelCapacityLeasePort,
  type ParallelClaimReleasePort,
  type ParallelSchedulingPolicy,
  type ParallelTaskCandidate,
  type ParallelWorkerTerminal,
  selectParallelDispatches,
} from "./parallel-scheduler"

export type ParallelClaimLifecyclePort = ParallelClaimReleasePort

export type ParallelWorkerResult<T> = {
  terminal: ParallelWorkerTerminal
  value?: T
  error?: unknown
}

export type ParallelWaveSnapshot = {
  candidates: readonly ParallelTaskCandidate[]
  completedTaskIds: ReadonlySet<string>
  capacity: ParallelCapacity
}

export type ParallelRunObservation = {
  type:
    | "wave-selected"
    | "claim-conflict"
    | "worker-started"
    | "worker-settled"
    | "integration-settled"
    | "draining"
  taskId?: string
  attemptId?: string
  workerId?: string
  details?: Readonly<Record<string, unknown>>
}

export type ParallelRunSummary<T> = {
  started: number
  waves: number
  failureObserved: boolean
  draining: boolean
  terminals: readonly ParallelWorkerResult<T>[]
  claimConflicts: number
  reason: string
}

/**
 * Command-owned wave scheduler. Models never receive this port or choose work.
 * Active workers are allowed to settle under fail-fast; the next wave is then
 * suppressed. Capacity and resource claims are released in finally blocks.
 */
export async function executeParallelWaves<T>(input: {
  policy: ParallelSchedulingPolicy
  maximumDispatches: number
  snapshot(): Promise<ParallelWaveSnapshot>
  claimPort: ParallelClaimLifecyclePort
  capacityPort: ParallelCapacityLeasePort
  workerId(candidate: ParallelTaskCandidate, ordinal: number): string
  execute(dispatch: ClaimedParallelDispatch): Promise<ParallelWorkerResult<T>>
  integrate(results: readonly ParallelWorkerResult<T>[]): Promise<void>
  observe?(observation: ParallelRunObservation): void | Promise<void>
}): Promise<ParallelRunSummary<T>> {
  if (!Number.isSafeInteger(input.maximumDispatches) || input.maximumDispatches < 1) {
    throw new RalphError(
      "RALPH_PARALLEL_DISPATCH_LIMIT_INVALID",
      "Parallel execution requires a positive bounded dispatch limit",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: { maximumDispatches: input.maximumDispatches },
      },
    )
  }
  const terminalResults: ParallelWorkerResult<T>[] = []
  let started = 0
  let waves = 0
  let failureObserved = false
  let draining = false
  let claimConflicts = 0
  let reason = "No parallel task was eligible"

  while (started < input.maximumDispatches) {
    const snapshot = await input.snapshot()
    const selection = selectParallelDispatches({
      candidates: snapshot.candidates,
      completedTaskIds: snapshot.completedTaskIds,
      policy: input.policy,
      capacity: {
        ...snapshot.capacity,
        maximumGlobal: Math.min(snapshot.capacity.maximumGlobal, input.maximumDispatches - started),
        maximumProject: Math.min(
          snapshot.capacity.maximumProject,
          input.maximumDispatches - started,
        ),
      },
      failureObserved,
    })
    await input.observe?.({
      type: "wave-selected",
      details: {
        dispatches: selection.dispatches.length,
        deferred: selection.deferred.length,
        draining: selection.draining,
      },
    })
    if (selection.draining) {
      draining = true
      reason = selection.reason ?? "Fail-fast is draining active workers"
      await input.observe?.({ type: "draining", details: { reason } })
      break
    }
    if (selection.dispatches.length === 0) {
      reason =
        selection.deferred.length > 0
          ? selection.deferred
              .map((item) =>
                item.eligibility.eligible
                  ? `Task ${item.candidate.taskId} was deferred after eligibility selection`
                  : item.eligibility.reason,
              )
              .join("; ")
          : "No incomplete parallel task remains"
      break
    }

    const claimed = await claimParallelDispatches({
      selection,
      claimPort: input.claimPort,
      capacityPort: input.capacityPort,
      workerId: input.workerId,
    })
    claimConflicts += claimed.conflicts.length
    for (const conflict of claimed.conflicts) {
      await input.observe?.({
        type: "claim-conflict",
        taskId: conflict.dispatch.candidate.taskId,
        attemptId: conflict.dispatch.candidate.attemptId,
        details: {
          code: conflict.error.code,
          message: conflict.error.message,
          ...(conflict.capacityScope ? { capacityScope: conflict.capacityScope } : {}),
        },
      })
    }
    if (claimed.claimed.length === 0) {
      reason = "Every selected worker was deferred by a durable capacity or resource claim"
      break
    }

    waves += 1
    started += claimed.claimed.length
    const workerSettlements = await Promise.allSettled(
      claimed.claimed.map(async (dispatch): Promise<ParallelWorkerResult<T>> => {
        await input.observe?.({
          type: "worker-started",
          taskId: dispatch.candidate.taskId,
          attemptId: dispatch.candidate.attemptId,
          workerId: dispatch.workerId,
        })
        try {
          const result = await input.execute(dispatch)
          await input.observe?.({
            type: "worker-settled",
            taskId: dispatch.candidate.taskId,
            attemptId: dispatch.candidate.attemptId,
            workerId: dispatch.workerId,
            details: { outcome: result.terminal.outcome },
          })
          return result
        } catch (error) {
          await input.observe?.({
            type: "worker-settled",
            taskId: dispatch.candidate.taskId,
            attemptId: dispatch.candidate.attemptId,
            workerId: dispatch.workerId,
            details: {
              outcome: "interrupted",
              error: error instanceof Error ? error.message : String(error),
            },
          })
          return {
            terminal: {
              taskId: dispatch.candidate.taskId,
              attemptId: dispatch.candidate.attemptId,
              outcome: "interrupted",
              failureCount: dispatch.candidate.failureCount + 1,
            },
            error,
          }
        }
      }),
    )
    const workerFailure = workerSettlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    )
    if (workerFailure) {
      throw new RalphError(
        "RALPH_PARALLEL_WORKER_SETTLEMENT_FAILED",
        "A parallel worker could not produce a durable terminal observation",
        { exitCode: EXIT_CODES.operationalError, cause: workerFailure.reason },
      )
    }
    const settled = workerSettlements.map(
      (settlement) => (settlement as PromiseFulfilledResult<ParallelWorkerResult<T>>).value,
    )
    const ordered = [...settled].sort(
      (left, right) =>
        left.terminal.taskId.localeCompare(right.terminal.taskId) ||
        left.terminal.attemptId.localeCompare(right.terminal.attemptId),
    )
    terminalResults.push(...ordered)
    if (ordered.some((item) => item.terminal.outcome !== "completed")) {
      failureObserved = true
    }
    let integrationError: unknown
    try {
      await input.integrate(ordered)
    } catch (error) {
      integrationError = error
    }
    const releases = await Promise.allSettled(
      claimed.claimed.map(async (dispatch) => {
        try {
          await input.claimPort.release({
            claimSet: dispatch.claimSet,
            reason: `Parallel worker ${dispatch.workerId} and its integration boundary settled`,
          })
        } finally {
          await input.capacityPort.release(
            dispatch.capacityLeaseId,
            `Parallel worker ${dispatch.workerId} and its integration boundary settled`,
          )
        }
      }),
    )
    const releaseFailure = releases.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    )
    if (releaseFailure) {
      throw new RalphError(
        "RALPH_PARALLEL_RESOURCE_RELEASE_FAILED",
        "Parallel integration settled but a durable resource/capacity release failed",
        {
          exitCode: EXIT_CODES.operationalError,
          cause: releaseFailure.reason,
          ...(integrationError
            ? {
                details: {
                  integrationFailure:
                    integrationError instanceof Error
                      ? integrationError.message
                      : String(integrationError),
                },
              }
            : {}),
        },
      )
    }
    if (integrationError) throw integrationError
    await input.observe?.({
      type: "integration-settled",
      details: { tasks: ordered.map((item) => item.terminal.taskId) },
    })
    if (failureObserved && input.policy.failFast) {
      draining = true
      reason = "A worker failed; active workers settled and fail-fast stopped new dispatch"
      break
    }
    reason = `Parallel wave ${waves} settled ${ordered.length} worker(s)`
  }

  return {
    started,
    waves,
    failureObserved,
    draining,
    terminals: terminalResults,
    claimConflicts,
    reason,
  }
}
