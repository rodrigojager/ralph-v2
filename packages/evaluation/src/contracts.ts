import type {
  EffectiveConfig,
  EffectiveRunOptions,
  EvaluationProfileSnapshot,
  JudgeOutput,
} from "@ralph/domain"

import type { JudgeEvaluationBundle } from "./bundle"

export type JudgeKind = "external" | "self"

export type JudgePrompt = {
  system: string
  user: string
}

export type JudgeRequest = {
  callId: string
  kind: JudgeKind
  evidenceBundleId: string
  bundle: JudgeEvaluationBundle
  prompt: JudgePrompt
  signal?: AbortSignal
}

export type JudgeCallHandle = {
  id: string
  outcome: Promise<JudgeOutput>
  /** Effective candidate that produced the accepted output after explicit routing/fallback. */
  profileSnapshot?: Promise<EvaluationProfileSnapshot | undefined>
  /**
   * Immutable reference to the provider/process response that produced `outcome`.
   *
   * The promise is optional so existing and synthetic backends remain compatible. A
   * backend that exposes it must resolve it from the same underlying call as
   * `outcome`; it should resolve `undefined`, rather than reject, when no raw capture
   * is available.
   */
  rawResponseRef?: Promise<string | undefined>
}

export type JudgeBackendCapabilities = {
  streaming: boolean
  cancellation: boolean
  structuredOutput: boolean
  usage: "reported" | "estimated" | "unavailable"
  toolCalling: "unavailable"
  mutationMode: "read-only"
}

export type JudgeBackendEvent = {
  type: string
  level: "debug" | "info" | "warning" | "error"
  payload: unknown
}

export interface JudgeEventSink {
  emit(event: JudgeBackendEvent): void | Promise<void>
}

export interface JudgeBackend {
  readonly id: string
  capabilities(): JudgeBackendCapabilities
  start(request: JudgeRequest, sink: JudgeEventSink): Promise<JudgeCallHandle>
  cancel(handle: JudgeCallHandle, reason: string): Promise<void>
}

export type JudgeBackendResolutionContext = {
  workspaceRoot: string
  /** Persisted run whose raw judge output must remain in the run-scoped store. */
  runId?: string
  /** Stable command-owned workspace identity used to bind isolated workers. */
  workspaceId?: string
  /** Durable control workspace when evaluation targets an isolated worktree. */
  controlRoot?: string
  kind: JudgeKind
  effectiveOptions: EffectiveRunOptions
  dryRun: boolean
  /** Immutable command-resolved configuration snapshot; avoids disk/config TOCTOU. */
  config?: EffectiveConfig
}

export type JudgeBackendResolver = (
  profile: string,
  context: JudgeBackendResolutionContext,
) => JudgeBackend | undefined | Promise<JudgeBackend | undefined>
