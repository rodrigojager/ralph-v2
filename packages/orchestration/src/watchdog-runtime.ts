import {
  type WatchdogEvaluation,
  type WatchdogOperationalBudget,
  type WatchdogPhase,
  type WatchdogProfile,
  type WatchdogRecoveryDecision,
  WatchdogRecoveryDecisionSchema,
  type WatchdogTriState,
} from "@ralph-next/domain"
import {
  type WatchdogClock,
  type WatchdogDeadlines,
  type WatchdogEventContextSource,
  WatchdogMonitor,
  type WatchdogMonitorError,
  type WatchdogPhaseStart,
  type WatchdogProbeResult,
  type WatchdogScheduler,
} from "@ralph-next/supervisor"
import type { EventInput } from "@ralph-next/telemetry"

export type WatchdogRuntimeAction = Exclude<WatchdogRecoveryDecision["action"], "none">

export type DestructiveWatchdogRuntimeAction = Exclude<WatchdogRuntimeAction, "notify">

export function isDestructiveWatchdogRuntimeAction(
  action: WatchdogRuntimeAction,
): action is DestructiveWatchdogRuntimeAction {
  return action === "cancel" || action === "restart-attempt" || action === "stop-run"
}

/**
 * Tagged reason placed on the attempt AbortSignal for destructive watchdog
 * decisions. `notify` uses the same type but is only exposed through
 * activeAction/throwIfActionRequested and never aborts the signal.
 */
export class WatchdogRuntimeActionError extends Error {
  readonly code = "WATCHDOG_RUNTIME_ACTION" as const
  readonly action: WatchdogRuntimeAction
  readonly destructive: boolean
  readonly eventsPersisted: boolean
  readonly probeId: string
  readonly decision: WatchdogRecoveryDecision
  readonly evaluation: WatchdogEvaluation

  constructor(result: WatchdogProbeResult, eventsPersisted: boolean) {
    const action = result.evaluation.decision.action
    if (action === "none") {
      throw new Error("A watchdog runtime action error requires an actionable decision")
    }
    super(`Watchdog requested ${action} during ${result.evaluation.snapshot.phase}`)
    this.name = "WatchdogRuntimeActionError"
    this.action = action
    this.destructive = isDestructiveWatchdogRuntimeAction(action)
    this.eventsPersisted = eventsPersisted
    this.probeId = result.observation.probeId
    this.decision = WatchdogRecoveryDecisionSchema.parse(result.evaluation.decision)
    this.evaluation = result.evaluation
  }
}

export function isWatchdogRuntimeActionError(error: unknown): error is WatchdogRuntimeActionError {
  return error instanceof WatchdogRuntimeActionError
}

export class WatchdogRuntimePersistenceError extends Error {
  readonly code = "WATCHDOG_EVENT_PERSISTENCE_FAILED" as const
  readonly probeId: string

  constructor(probeId: string, cause: unknown) {
    super(`Could not persist watchdog events for probe ${probeId}`, { cause })
    this.name = "WatchdogRuntimePersistenceError"
    this.probeId = probeId
  }
}

export class WatchdogRuntimeMonitorError extends Error {
  readonly code = "WATCHDOG_MONITOR_FAILED" as const
  readonly stage: WatchdogMonitorError["stage"]
  readonly phase: WatchdogPhase

  constructor(failure: WatchdogMonitorError) {
    super(`Watchdog monitor failed during ${failure.stage}`, { cause: failure.error })
    this.name = "WatchdogRuntimeMonitorError"
    this.stage = failure.stage
    this.phase = failure.phase
  }
}

export type WatchdogRuntimeError =
  | WatchdogRuntimeActionError
  | WatchdogRuntimePersistenceError
  | WatchdogRuntimeMonitorError

/**
 * The callback owns the durable transaction/outbox boundary. It must preserve
 * array order and reject when any event was not durably accepted.
 */
export type PersistWatchdogEvents = (
  events: readonly EventInput[],
  evaluation: WatchdogEvaluation,
) => void

export type AttemptWatchdogRuntimeOptions = {
  profile: WatchdogProfile
  initialPhase: WatchdogPhase
  eventContext: WatchdogEventContextSource
  /** Run-level operational budget carried into this attempt. */
  initialBudget: WatchdogOperationalBudget
  persistEvents: PersistWatchdogEvents
  externalSignal?: AbortSignal
  autoControlHeartbeat?: boolean
  clock?: WatchdogClock
  scheduler?: WatchdogScheduler
  probeId?: (sequence: number, phase: WatchdogPhase) => string
  onError?: (
    error: WatchdogRuntimePersistenceError | WatchdogRuntimeMonitorError,
  ) => void | Promise<void>
}

export type WatchdogProviderUpdate = {
  pending?: WatchdogTriState
  streamOpen?: WatchdogTriState
  retryAfterMs?: number | null
  retryAfterMonotonicMs?: number | null
  progress?: boolean
  settlement?: "running" | "settled" | "unknown"
}

export type WatchdogProcessUpdate = {
  alive?: WatchdogTriState
  activity?: WatchdogTriState
  progress?: boolean
  settlement?: "running" | "settled" | "unknown"
}

export type WatchdogChildUpdate = WatchdogProcessUpdate & {
  heartbeat?: boolean
}

export type WatchdogPhaseProgressUpdate = {
  progress?: boolean
  settlement?: "running" | "settled" | "unknown"
}

/**
 * Attempt-scoped orchestration adapter around WatchdogMonitor.
 *
 * It translates watchdog recovery decisions into a typed attempt-local signal
 * reason. It does not decide how to cancel a backend, kill a process tree,
 * restart an attempt, stop a run or mutate task completion.
 */
export class AttemptWatchdogRuntime {
  readonly #controller = new AbortController()
  readonly #monitor: WatchdogMonitor
  readonly #persistEvents: PersistWatchdogEvents
  readonly #externalSignal: AbortSignal | undefined
  readonly #onError: AttemptWatchdogRuntimeOptions["onError"]
  readonly #externalAbortListener: (() => void) | undefined

  #activeAction: WatchdogRuntimeActionError | undefined
  #lastError: WatchdogRuntimePersistenceError | WatchdogRuntimeMonitorError | undefined
  #persistedProbeId: string | undefined
  #phaseGeneration = 0
  #started = false
  #closed = false

  constructor(options: AttemptWatchdogRuntimeOptions) {
    this.#persistEvents = options.persistEvents
    this.#externalSignal = options.externalSignal
    this.#onError = options.onError
    this.#monitor = new WatchdogMonitor({
      profile: options.profile,
      phase: options.initialPhase,
      eventContext: options.eventContext,
      initialBudget: options.initialBudget,
      signal: this.#controller.signal,
      autoControlHeartbeat: options.autoControlHeartbeat ?? false,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
      ...(options.probeId ? { probeId: options.probeId } : {}),
      onEvaluation: (result) => this.#onEvaluation(result),
      onAction: (result) => this.#onAction(result),
      onError: (failure) => this.#onMonitorError(failure),
    })

    if (this.#externalSignal) {
      this.#externalAbortListener = () => {
        if (!this.#controller.signal.aborted) {
          this.#controller.abort(this.#externalSignal?.reason)
        }
      }
      if (this.#externalSignal.aborted) this.#externalAbortListener()
      else {
        this.#externalSignal.addEventListener("abort", this.#externalAbortListener, {
          once: true,
        })
      }
    } else {
      this.#externalAbortListener = undefined
    }
  }

  /** Signal passed to the currently monitored attempt/backend/tool/gate. */
  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get phase(): WatchdogPhase {
    return this.#monitor.phase
  }

  get monitoring(): boolean {
    return this.#monitor.running
  }

  get activeAction(): WatchdogRuntimeActionError | undefined {
    return this.#activeAction
  }

  get activeDecision(): WatchdogRecoveryDecision | undefined {
    return this.#activeAction
      ? WatchdogRecoveryDecisionSchema.parse(this.#activeAction.decision)
      : undefined
  }

  get lastError(): WatchdogRuntimePersistenceError | WatchdogRuntimeMonitorError | undefined {
    return this.#lastError
  }

  /** The returned budget is suitable as initialBudget for the next attempt. */
  get budget(): WatchdogOperationalBudget {
    return this.#monitor.budget
  }

  get watchdogRestarts(): number {
    return this.#monitor.budget.watchdogRestarts
  }

  start(): void {
    if (this.#closed || this.#controller.signal.aborted) return
    this.#started = true
    this.#monitor.start()
  }

  beginPhase(phase: WatchdogPhase, input: WatchdogPhaseStart = {}): void {
    this.#assertOpen()
    this.#monitor.beginPhase(phase, input)
    this.#phaseGeneration += 1
    this.#activeAction = undefined
    this.#persistedProbeId = undefined
    if (this.#started && !this.#controller.signal.aborted) this.#monitor.start()
  }

  beginModelCall(input: WatchdogPhaseStart = {}): void {
    this.beginPhase("model-call", input)
    this.#monitor.recordProviderPending("yes")
  }

  beginTool(input: WatchdogPhaseStart = {}): void {
    this.beginPhase("tool", input)
  }

  beginGate(input: WatchdogPhaseStart = {}): void {
    this.beginPhase("gate", input)
  }

  beginJudge(input: WatchdogPhaseStart = {}): void {
    this.beginPhase("judge", input)
    this.#monitor.recordProviderPending("yes")
  }

  beginChild(input: WatchdogPhaseStart = {}): void {
    this.beginPhase("child", input)
  }

  beginIntegration(input: WatchdogPhaseStart = {}): void {
    this.beginPhase("integration", input)
  }

  recordControlHeartbeat(): void {
    this.#assertOpen()
    this.#monitor.recordControlHeartbeat()
  }

  recordProgress(): void {
    this.#assertOpen()
    this.#monitor.recordProgress()
  }

  recordProvider(update: WatchdogProviderUpdate): void {
    this.#assertOpen()
    if (Object.hasOwn(update, "retryAfterMs") && Object.hasOwn(update, "retryAfterMonotonicMs")) {
      throw new Error(
        "Provider watchdog update cannot set relative and absolute retry-after together",
      )
    }
    if (update.pending !== undefined) this.#monitor.recordProviderPending(update.pending)
    if (update.streamOpen !== undefined) {
      this.#monitor.recordProviderStream(update.streamOpen)
    }
    if (Object.hasOwn(update, "retryAfterMs")) {
      this.#monitor.recordProviderRetryAfter(update.retryAfterMs ?? null)
    }
    if (Object.hasOwn(update, "retryAfterMonotonicMs")) {
      this.#monitor.recordProviderRetryAfterUntil(update.retryAfterMonotonicMs ?? null)
    }
    if (update.progress) this.#monitor.recordProgress()
    if (update.settlement !== undefined) {
      this.#monitor.recordSettlement(update.settlement)
    }
  }

  recordTool(update: WatchdogProcessUpdate = {}): void {
    this.#recordProcessPhase(update)
  }

  recordGate(update: WatchdogProcessUpdate = {}): void {
    this.#recordProcessPhase(update)
  }

  recordJudge(update: WatchdogProviderUpdate = {}): void {
    this.recordProvider(update)
  }

  recordChild(update: WatchdogChildUpdate = {}): void {
    this.#assertOpen()
    if (update.heartbeat) this.#monitor.recordChildHeartbeat()
    this.#recordProcessPhase(update)
  }

  recordIntegration(update: WatchdogProcessUpdate = {}): void {
    this.#recordProcessPhase(update)
  }

  recordPhaseProgress(update: WatchdogPhaseProgressUpdate = { progress: true }): void {
    this.#assertOpen()
    if (update.progress) this.#monitor.recordProgress()
    if (update.settlement !== undefined) {
      this.#monitor.recordSettlement(update.settlement)
    }
  }

  setDeadlines(input: WatchdogDeadlines): void {
    this.#assertOpen()
    this.#monitor.setDeadlines(input)
  }

  setDeadlinesAfter(input: {
    phaseTimeoutMs?: number | null
    hardTimeoutMs?: number | null
  }): void {
    this.#assertOpen()
    this.#monitor.setDeadlinesAfter(input)
  }

  /** Throws the tagged action; notify is opt-in because it never aborts work. */
  throwIfActionRequested(options: { includeNotify?: boolean } = {}): void {
    const action = this.#activeAction
    if (!action) return
    if (action.destructive || options.includeNotify) throw action
  }

  /** Acknowledges a notification without weakening a destructive decision. */
  acknowledgeNotification(): WatchdogRuntimeActionError | undefined {
    if (this.#activeAction?.action !== "notify") return undefined
    const notification = this.#activeAction
    this.#activeAction = undefined
    return notification
  }

  /** Stops monitoring; it does not abort otherwise healthy attempt work. */
  stop(): void {
    if (this.#closed) return
    this.#closed = true
    this.#started = false
    this.#phaseGeneration += 1
    this.#monitor.stop()
    if (this.#externalSignal && this.#externalAbortListener) {
      this.#externalSignal.removeEventListener("abort", this.#externalAbortListener)
    }
  }

  async whenIdle(): Promise<void> {
    await this.#monitor.whenIdle()
  }

  async flush(): Promise<void> {
    await this.#monitor.flush()
  }

  #recordProcessPhase(update: WatchdogProcessUpdate): void {
    this.#assertOpen()
    if (update.alive !== undefined) this.#monitor.recordProcessAlive(update.alive)
    if (update.activity !== undefined) {
      this.#monitor.recordProcessActivity(update.activity)
    }
    if (update.progress) this.#monitor.recordProgress()
    if (update.settlement !== undefined) {
      this.#monitor.recordSettlement(update.settlement)
    }
  }

  #onEvaluation(result: WatchdogProbeResult): void {
    const phaseGeneration = this.#phaseGeneration
    const action = result.evaluation.decision.action
    try {
      this.#persistEvents(result.events, result.evaluation)
      if (phaseGeneration !== this.#phaseGeneration) return
      this.#persistedProbeId = result.observation.probeId
    } catch (cause) {
      this.#persistedProbeId = undefined
      const error = new WatchdogRuntimePersistenceError(result.observation.probeId, cause)
      this.#lastError = error
      // A watchdog transition cannot safely continue after its diagnostic and
      // action events failed to cross the durable command boundary. This abort
      // is an infrastructure failure, never a recovery action masquerading as
      // notify/cancel/restart/stop.
      if (!this.#controller.signal.aborted) this.#controller.abort(error)
      throw error
    }

    if (
      action === "none" &&
      this.#activeAction?.decision.phase === result.evaluation.snapshot.phase &&
      (result.evaluation.snapshot.state === "healthy" ||
        result.evaluation.snapshot.state === "recovered")
    ) {
      this.#activeAction = undefined
    }
  }

  #onAction(result: WatchdogProbeResult): void {
    const persisted = this.#persistedProbeId === result.observation.probeId
    if (!persisted) return
    const action = new WatchdogRuntimeActionError(result, true)
    this.#activeAction = action
    if (action.destructive && !this.#controller.signal.aborted) {
      this.#controller.abort(action)
    }
  }

  async #onMonitorError(failure: WatchdogMonitorError): Promise<void> {
    const error =
      failure.error instanceof WatchdogRuntimePersistenceError
        ? failure.error
        : new WatchdogRuntimeMonitorError(failure)
    this.#lastError = error
    // A broken clock/evaluator/telemetry hook is as unsafe as failed event
    // persistence: continuing would silently execute without a functioning
    // watchdog. Abort the attempt and let the command boundary reconcile it.
    this.#started = false
    this.#monitor.stop()
    if (!this.#controller.signal.aborted) this.#controller.abort(error)
    try {
      await this.#onError?.(error)
    } catch {
      // Error observers cannot replace the command-owned watchdog outcome.
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The attempt watchdog runtime is closed")
    if (this.#controller.signal.aborted) {
      const reason: unknown = this.#controller.signal.reason
      if (reason instanceof Error) throw reason
      throw new Error("The monitored attempt was aborted", { cause: reason })
    }
  }
}
