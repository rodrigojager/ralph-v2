import type { ToolEffect, ToolRecoveryClassification, ToolSettlementOutcome } from "./contracts"

export type ToolHostErrorOptions = ErrorOptions & {
  content?: unknown
  effects?: readonly ToolEffect[]
  outputRefs?: readonly string[]
}

export class ToolHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: ToolSettlementOutcome = "error",
    readonly recovery: ToolRecoveryClassification = "manual-review",
    readonly retryable = false,
    options?: ToolHostErrorOptions,
  ) {
    super(message, options)
    this.name = "ToolHostError"
    this.content = options?.content
    this.effects = options?.effects ?? []
    this.outputRefs = options?.outputRefs ?? []
  }

  readonly content: unknown
  readonly effects: readonly ToolEffect[]
  readonly outputRefs: readonly string[]
}

/**
 * Signals that an effect-capable tool lost its execution transport after the
 * durable intent was started. ToolHost must leave the journal intent open so
 * command-owned reconciliation can inspect the effect; converting this into a
 * normal error settlement would erase the recovery boundary.
 */
export class ToolEffectUnsettledError extends Error {
  constructor(
    message = "Tool effect transport was lost before a terminal settlement",
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ToolEffectUnsettledError"
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
