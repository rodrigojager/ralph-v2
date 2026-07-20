import { randomUUID } from "node:crypto"
import {
  type ChildRunExecutionPort,
  type ChildRunWorkerSessionFactory,
  captureCurrentProcessIdentity,
  type ExecutionRuntimeDependencies,
  executeReservedChildWorker,
} from "@ralph-next/orchestration"

/**
 * Test-only worker transport that preserves the real child reservation,
 * execution and reconciliation paths while keeping the fixture in one hidden
 * Bun process. Production never imports this adapter.
 */
export function createInProcessChildWorkerFactory(
  dependencies: ExecutionRuntimeDependencies,
): ChildRunWorkerSessionFactory {
  let sessionOrdinal = 0
  let factory!: ChildRunWorkerSessionFactory

  factory = async (request) => {
    const ordinal = ++sessionOrdinal
    const identity = await captureCurrentProcessIdentity()
    const owner = {
      ownerInstanceId: `fixture-child-${ordinal}-${randomUUID()}`,
      ...identity,
    }
    const workerId = owner.ownerInstanceId
    const parentWorkerId = request.parentWorkerId ?? `run:${request.parentRunId}`
    let state: "ready" | "busy" | "closing" | "exited" = "ready"
    let activeRequestId: string | undefined
    let lastControlHeartbeatAt = new Date().toISOString()
    let lastProgressAt = lastControlHeartbeatAt
    let used = false

    const operate = async (
      operation: "execute" | "reconcile-terminal",
      childRequest:
        | Parameters<ChildRunExecutionPort["execute"]>[0]
        | Parameters<ChildRunExecutionPort["reconcileTerminal"]>[0],
    ) => {
      if (used) throw new Error("The bounded in-process child session accepts one operation")
      used = true
      state = "busy"
      activeRequestId = `fixture-child-operation-${ordinal}`
      lastControlHeartbeatAt = new Date().toISOString()
      try {
        const result = await executeReservedChildWorker({
          operation,
          workspaceRoot: request.workspaceRoot,
          executionRoot: request.executionRoot,
          workspaceId: request.workspaceId,
          link: childRequest.link,
          graph: childRequest.graph,
          childDocument: childRequest.childDocument,
          effectiveOptions: childRequest.effectiveOptions,
          optionResolution: request.optionResolution,
          environment: { ...request.environment },
          owner,
          taskBudget: request.taskBudget,
          dependencies: {
            ...dependencies,
            childRunWorkerSessionFactory: factory,
          },
          ...(operation === "execute" && "signal" in childRequest && childRequest.signal
            ? { signal: childRequest.signal }
            : {}),
          assertLease: childRequest.assertLease,
          observe: childRequest.observe,
          projectEvent: childRequest.projectEvent,
        })
        lastProgressAt = new Date().toISOString()
        return { artifactsReconciled: result.artifactsReconciled, reason: result.reason }
      } finally {
        activeRequestId = undefined
        if (state === "busy") state = "ready"
        lastControlHeartbeatAt = new Date().toISOString()
      }
    }

    return {
      owner,
      workerId,
      parentWorkerId,
      execution: {
        execute: (childRequest) => operate("execute", childRequest),
        reconcileTerminal: (childRequest) => operate("reconcile-terminal", childRequest),
        async requestStop() {
          state = "closing"
        },
      },
      snapshot() {
        return {
          state,
          ...(activeRequestId ? { activeRequestId } : {}),
          lastControlHeartbeatAt,
          lastProgressAt,
        }
      },
      async ping() {
        if (state === "exited") throw new Error("child worker is not alive")
        lastControlHeartbeatAt = new Date().toISOString()
      },
      async forceKill() {
        state = "exited"
      },
      async close() {
        state = "exited"
      },
    }
  }

  return factory
}
