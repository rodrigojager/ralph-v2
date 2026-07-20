import {
  assertWorkerCommandCapability,
  assertWorkerOperationResultBinding,
  assertWorkerPathCapability,
  type ChildRunWorkerRequest,
  ChildRunWorkerRequestSchema,
  type ChildRunWorkerResult,
  ChildRunWorkerResultSchema,
  canonicalWorkerAuthorizedCommands,
  canonicalWorkerAuthorizedPaths,
  type ExecutorModelWorkerRequest,
  ExecutorModelWorkerRequestSchema,
  type ExecutorModelWorkerResult,
  ExecutorModelWorkerResultSchema,
  type GateWorkerRequest,
  GateWorkerRequestSchema,
  type GateWorkerResult,
  GateWorkerResultSchema,
  type GitIntegrationWorkerRequest,
  GitIntegrationWorkerRequestSchema,
  type GitIntegrationWorkerResult,
  GitIntegrationWorkerResultSchema,
  type JudgeWorkerRequest,
  JudgeWorkerRequestSchema,
  type JudgeWorkerResult,
  JudgeWorkerResultSchema,
  type ToolWorkerRequest,
  ToolWorkerRequestSchema,
  type ToolWorkerResult,
  ToolWorkerResultSchema,
  type WorkerCommandInvocation,
  type WorkerProgressDetail,
  WorkerProgressDetailSchema,
} from "./worker-operations"
import type {
  WorkerCapabilityGrant,
  WorkerIdentity,
  WorkerParentCallMethod,
  WorkerRole,
} from "./worker-protocol"
import type {
  WorkerOperationContext,
  WorkerOperationHandler,
  WorkerOperationRegistry,
} from "./worker-runtime"

export type WorkerRoleAdapterContext = {
  readonly workerId: string
  readonly requestId: string
  readonly identity: WorkerIdentity
  readonly capability: WorkerCapabilityGrant
  readonly signal: AbortSignal
  assertPaths(paths: readonly string[]): void
  /** Revalidates links/containment and returns paths adapters must use for the immediate access. */
  canonicalPaths(paths: readonly string[]): readonly string[]
  /** Revalidates the executable bytes and exact invocation immediately before spawn. */
  assertCommands(commands: readonly WorkerCommandInvocation[]): void
  /** Revalidates and returns canonical exact command invocations for the immediate spawn. */
  canonicalCommands(
    commands: readonly WorkerCommandInvocation[],
  ): readonly WorkerCommandInvocation[]
  emitProgress(phase: string, detail?: WorkerProgressDetail): void
  callSupervisor(method: WorkerParentCallMethod, payload: unknown): Promise<unknown>
}

export type ExecutorModelWorkerAdapter = {
  readonly role: "executor-model"
  execute(
    request: ExecutorModelWorkerRequest,
    context: WorkerRoleAdapterContext,
  ): Promise<ExecutorModelWorkerResult>
}

export type JudgeWorkerAdapter = {
  readonly role: "judge"
  evaluate(
    request: JudgeWorkerRequest,
    context: WorkerRoleAdapterContext,
  ): Promise<JudgeWorkerResult>
}

export type ToolGateWorkerAdapter = {
  readonly role: "tool-gate"
  executeTool?(
    request: ToolWorkerRequest,
    context: WorkerRoleAdapterContext,
  ): Promise<ToolWorkerResult>
  executeGate?(
    request: GateWorkerRequest,
    context: WorkerRoleAdapterContext,
  ): Promise<GateWorkerResult>
}

export type ChildRunWorkerAdapter = {
  readonly role: "child-run"
  executeChild(
    request: ChildRunWorkerRequest,
    context: WorkerRoleAdapterContext,
  ): Promise<ChildRunWorkerResult>
}

export type GitIntegrationWorkerAdapter = {
  readonly role: "git-integration"
  integrate(
    request: GitIntegrationWorkerRequest,
    context: WorkerRoleAdapterContext,
  ): Promise<GitIntegrationWorkerResult>
}

export type RalphWorkerRoleAdapter =
  | ExecutorModelWorkerAdapter
  | JudgeWorkerAdapter
  | ToolGateWorkerAdapter
  | ChildRunWorkerAdapter
  | GitIntegrationWorkerAdapter

function adapterContext(context: WorkerOperationContext): WorkerRoleAdapterContext {
  return {
    workerId: context.workerId,
    requestId: context.requestId,
    identity: context.identity,
    capability: context.capability,
    signal: context.signal,
    assertPaths(paths) {
      assertWorkerPathCapability({
        workspaceRoot: context.identity.workspaceRoot,
        capability: context.capability,
        paths,
      })
    },
    canonicalPaths(paths) {
      return canonicalWorkerAuthorizedPaths({
        workspaceRoot: context.identity.workspaceRoot,
        capability: context.capability,
        paths,
      })
    },
    assertCommands(commands) {
      assertWorkerCommandCapability({
        workspaceRoot: context.identity.workspaceRoot,
        capability: context.capability,
        commands,
      })
    },
    canonicalCommands(commands) {
      return canonicalWorkerAuthorizedCommands({
        workspaceRoot: context.identity.workspaceRoot,
        capability: context.capability,
        commands,
      })
    },
    emitProgress(phase, detail) {
      context.emitProgress(
        phase,
        detail === undefined ? undefined : WorkerProgressDetailSchema.parse(detail),
      )
    },
    callSupervisor(method, payload) {
      return context.callSupervisor(method, payload)
    },
  }
}

function assertNotAborted(context: WorkerRoleAdapterContext): void {
  if (context.signal.aborted) {
    throw context.signal.reason instanceof Error
      ? context.signal.reason
      : new Error("Worker operation was cancelled")
  }
}

function immutableAdapterRequest<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) {
    immutableAdapterRequest(child, seen)
  }
  return Object.freeze(value as object) as T
}

function started(context: WorkerRoleAdapterContext, summary: string): void {
  assertNotAborted(context)
  context.emitProgress("adapter.started", { summary, redacted: true })
}

function completed(context: WorkerRoleAdapterContext, summary: string): void {
  assertNotAborted(context)
  context.emitProgress("adapter.completed", { summary, redacted: true })
}

function handler(input: {
  role: WorkerRole
  capability: WorkerOperationHandler["capability"]
  handle(payload: unknown, context: WorkerOperationContext): Promise<unknown>
}): WorkerOperationHandler {
  return input
}

/**
 * Builds only the operations implemented by the selected role adapter. The
 * adapter receives no ledger, marker or transition port, so results remain
 * allegations for the command-owned supervisor to validate and persist.
 */
export function createWorkerRoleOperationRegistry(
  adapter: RalphWorkerRoleAdapter,
): WorkerOperationRegistry {
  switch (adapter.role) {
    case "executor-model":
      return {
        "executor-model.execute": handler({
          role: adapter.role,
          capability: "model.execute",
          async handle(payload, runtimeContext) {
            const request = immutableAdapterRequest(ExecutorModelWorkerRequestSchema.parse(payload))
            const context = adapterContext(runtimeContext)
            started(context, `Executor model call ${request.callId} started`)
            const result = ExecutorModelWorkerResultSchema.parse(
              await adapter.execute(request, context),
            )
            if (result.callId !== request.callId) {
              throw new Error("Executor worker result is bound to a different model call")
            }
            completed(context, `Executor model call ${request.callId} completed`)
            return result
          },
        }),
      }
    case "judge":
      return {
        "judge.evaluate": handler({
          role: adapter.role,
          capability: "judge.evaluate",
          async handle(payload, runtimeContext) {
            const request = immutableAdapterRequest(JudgeWorkerRequestSchema.parse(payload))
            const context = adapterContext(runtimeContext)
            started(context, `Judge assessment ${request.assessmentId} started`)
            const result = JudgeWorkerResultSchema.parse(await adapter.evaluate(request, context))
            if (result.assessmentId !== request.assessmentId) {
              throw new Error("Judge worker result is bound to a different assessment")
            }
            completed(context, `Judge assessment ${request.assessmentId} completed`)
            return result
          },
        }),
      }
    case "tool-gate": {
      const operations: Record<string, WorkerOperationHandler> = {}
      if (adapter.executeTool) {
        const executeTool = adapter.executeTool.bind(adapter)
        operations["tool.execute"] = handler({
          role: adapter.role,
          capability: "tool.execute",
          async handle(payload, runtimeContext) {
            const request = immutableAdapterRequest(ToolWorkerRequestSchema.parse(payload))
            const context = adapterContext(runtimeContext)
            started(context, `Tool call ${request.toolCall.callId} started`)
            const result = ToolWorkerResultSchema.parse(await executeTool(request, context))
            if (result.callId !== request.toolCall.callId) {
              throw new Error("Tool worker result is bound to a different tool call")
            }
            completed(context, `Tool call ${request.toolCall.callId} settled`)
            return result
          },
        })
      }
      if (adapter.executeGate) {
        const executeGate = adapter.executeGate.bind(adapter)
        operations["gate.execute"] = handler({
          role: adapter.role,
          capability: "gate.execute",
          async handle(payload, runtimeContext) {
            const request = immutableAdapterRequest(GateWorkerRequestSchema.parse(payload))
            const context = adapterContext(runtimeContext)
            started(context, `Gate ${request.gateId} started`)
            const result = GateWorkerResultSchema.parse(await executeGate(request, context))
            assertWorkerOperationResultBinding("gate.execute", request, result)
            completed(context, `Gate ${request.gateId} settled`)
            return result
          },
        })
      }
      if (!adapter.executeTool && !adapter.executeGate) {
        throw new Error("A tool-gate worker adapter must implement at least one operation")
      }
      return operations
    }
    case "child-run":
      return {
        "child-run.execute": handler({
          role: adapter.role,
          capability: "child.execute",
          async handle(payload, runtimeContext) {
            const request = immutableAdapterRequest(ChildRunWorkerRequestSchema.parse(payload))
            const context = adapterContext(runtimeContext)
            started(context, `Child run ${request.childRunId} started`)
            const result = ChildRunWorkerResultSchema.parse(
              await adapter.executeChild(request, context),
            )
            if (result.childRunId !== request.childRunId) {
              throw new Error("Child worker result is bound to a different child run")
            }
            completed(context, `Child run ${request.childRunId} settled`)
            return result
          },
        }),
      }
    case "git-integration":
      return {
        "git-integration.execute": handler({
          role: adapter.role,
          capability: "integration.execute",
          async handle(payload, runtimeContext) {
            const request = immutableAdapterRequest(
              GitIntegrationWorkerRequestSchema.parse(payload),
            )
            const context = adapterContext(runtimeContext)
            started(context, `Git integration ${request.integrationId} started`)
            const result = GitIntegrationWorkerResultSchema.parse(
              await adapter.integrate(request, context),
            )
            if (
              result.integrationId !== request.integrationId ||
              result.action !== request.action
            ) {
              throw new Error("Git worker result is bound to a different integration action")
            }
            completed(context, `Git integration ${request.integrationId} settled`)
            return result
          },
        }),
      }
  }
}
