import type {
  ContextManifest,
  EffectiveConfig,
  EffectiveRunOptions,
  ExecutorOutcome,
  TelemetryConfig,
} from "@ralph-next/domain"
import type { PrdTask } from "@ralph-next/prd"
import type {
  ProviderToolCall,
  ProviderToolDefinition,
  RoleProfileLimits,
} from "@ralph-next/providers"
import type { ProcessSupervisor } from "@ralph-next/supervisor"
import type { ContextManifestBundle } from "./context"
import type { ToolReconciliationResult } from "./tool-reconciliation"

export type BackendCapabilities = {
  streaming: boolean
  toolCalling: boolean | "ralph" | "internal" | "unavailable"
  cancellation: boolean
  usage: "reported" | "estimated" | "unavailable"
}

/**
 * Immutable profile-level model limits selected by the command resolver.
 * The runner combines these with task limits and remains the enforcement
 * authority; a backend must not interpret them as permission to self-govern.
 */
export type ExecutionBackendLimits = RoleProfileLimits

export type BackendEvent = {
  type: string
  level?: "debug" | "info" | "warning" | "error"
  payload?: Readonly<Record<string, unknown>>
}

export type ModelEventSink = {
  emit(event: BackendEvent): void | Promise<void>
}

export type ExecutionToolOutcome =
  | "success"
  | "nonzero"
  | "denied"
  | "invalid"
  | "error"
  | "timeout"
  | "cancelled"
  | "unsettled"

export type ExecutionToolResult = {
  callId: string
  outcome: ExecutionToolOutcome
  /** Bounded serialized result returned to the model as function_call_output. */
  output: string
  retryable: boolean
  settlementRef?: string
}

export type ExecutionToolContext = {
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  modelCallId: string
  workspaceRoot: string
  /** Authoritative Ralph state root when workspaceRoot is an isolated worktree. */
  controlRoot?: string
  /** Command-owned task process boundary; never supplied by the model/backend. */
  processSupervisor?: ProcessSupervisor
  protectedPaths: readonly string[]
  maximumToolCalls: number
  /** Immutable command-owned telemetry policy captured with the run. */
  telemetry: TelemetryConfig
  security: {
    mode: "safe" | "auto" | "dangerous"
    headlessAsk: "deny" | "allow"
    toolRules: Readonly<Record<string, "allow" | "deny" | "ask">>
    allowedCommands: readonly string[]
    readPaths: readonly string[]
    writePaths: readonly string[]
    allowShell: boolean
    interactive: boolean
  }
  deadlineAt?: string
  signal?: AbortSignal
  environment: Readonly<Record<string, string | undefined>>
  /** Routes tool-host observations through the same command-owned event boundary. */
  emit(event: BackendEvent): void | Promise<void>
}

/**
 * Task-scoped recovery boundary used before the runner starts more model work.
 * It deliberately has no fresh attempt/model-call identity: reconciliation
 * targets immutable intents already persisted for this task.
 */
export type ExecutionToolReconciliationContext = {
  runId: string
  documentId: string
  taskId: string
  workspaceRoot: string
  /** Authoritative Ralph state root when workspaceRoot is an isolated worktree. */
  controlRoot?: string
  /** Command-owned task process boundary used only for safe reconciliation. */
  processSupervisor?: ProcessSupervisor
  protectedPaths: readonly string[]
  telemetry: TelemetryConfig
  security: ExecutionToolContext["security"]
  signal?: AbortSignal
  environment: Readonly<Record<string, string | undefined>>
  emit(event: BackendEvent): void | Promise<void>
}

/** Command-composed port. The provider/model backend never receives ToolHost itself. */
export interface ExecutionToolPort {
  reconcile(
    context: ExecutionToolReconciliationContext,
  ): Promise<readonly ToolReconciliationResult[]>
  materialize(context: ExecutionToolContext): Promise<readonly ProviderToolDefinition[]>
  execute(call: ProviderToolCall, context: ExecutionToolContext): Promise<ExecutionToolResult>
}

export interface ExecutionChannel extends ModelEventSink {
  /**
   * Reserves one real provider/process turn before it starts. This is separate
   * from an outer executor invocation because a tool loop can require several
   * model calls while still producing one executor allegation.
   */
  reserveModelCall(input: { callId: string; turn: number }): Promise<void>
  tools(): Promise<readonly ProviderToolDefinition[]>
  executeTool(
    call: ProviderToolCall,
    options?: { signal?: AbortSignal },
  ): Promise<ExecutionToolResult>
  stats(): {
    modelCalls: number
    maximumModelCalls: number
    toolCalls: number
    maximumToolCalls: number
  }
}

export type ExecutionRequest = {
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  modelCallId: string
  callOrdinal: number
  workspaceRoot: string
  contextManifest: ContextManifest
  contextBundle: ContextManifestBundle
  task: PrdTask
  protectedPaths: readonly string[]
  deadlineAt?: string
  /** Command-owned cancellation, propagated from the CLI entrypoint. */
  signal?: AbortSignal
}

export type CallHandle = {
  id: string
  outcome: Promise<ExecutorOutcome>
}

/**
 * Port owned by the command-authoritative orchestrator. A backend receives an
 * already selected task and can only return an allegation about work. It has
 * no access to scheduler, ledger, marker or completion APIs.
 */
export interface ExecutionBackend {
  readonly id: string
  capabilities(): BackendCapabilities
  /** Profile limits, when the selected backend/profile declares any. */
  limits?(): ExecutionBackendLimits
  start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle>
  cancel(handle: CallHandle, reason: string): Promise<void>
}

export type ExecutionBackendResolutionContext = {
  workspaceRoot: string
  /** Persisted or reserved run identity used to scope optional raw captures. */
  runId?: string
  /** Stable command-owned workspace identity used to bind isolated workers. */
  workspaceId?: string
  /** Durable control workspace when execution occurs in an isolated worktree. */
  controlRoot?: string
  effectiveOptions: EffectiveRunOptions
  dryRun: boolean
  /** Immutable command-resolved configuration snapshot; avoids disk/config TOCTOU. */
  config?: EffectiveConfig
}

export type ExecutionBackendResolver = (
  profile: string,
  context: ExecutionBackendResolutionContext,
) => ExecutionBackend | undefined | Promise<ExecutionBackend | undefined>
