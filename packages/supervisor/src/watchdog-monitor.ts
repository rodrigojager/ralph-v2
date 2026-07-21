import {
  resolveWatchdogPhaseProfile,
  type WatchdogEvaluation,
  type WatchdogObservation,
  WatchdogObservationSchema,
  type WatchdogOperationalBudget,
  WatchdogOperationalBudgetSchema,
  type WatchdogPhase,
  WatchdogPhaseSchema,
  type WatchdogProfile,
  WatchdogProfileSchema,
  type WatchdogSnapshot,
  WatchdogSnapshotSchema,
  type WatchdogTriState,
  WatchdogTriStateSchema,
} from "@ralph/domain"
import {
  type EventInput,
  type WatchdogEventContext,
  WatchdogEventContextSchema,
  watchdogEventInputs,
} from "@ralph/telemetry"
import { evaluateWatchdog } from "./watchdog"

export interface WatchdogClock {
  /** A process-local monotonic clock. Values must never move backwards. */
  monotonicMs(): number
  /** The wall clock is used only for human-readable/event timestamps. */
  wallNow(): Date
}

export interface WatchdogScheduledTask {
  cancel(): void
}

export interface WatchdogScheduler {
  /** Schedules one callback. The monitor never uses a repeating interval. */
  schedule(delayMs: number, callback: () => void): WatchdogScheduledTask
}

export const systemWatchdogClock: WatchdogClock = {
  monotonicMs: () => Math.floor(performance.now()),
  wallNow: () => new Date(),
}

export const systemWatchdogScheduler: WatchdogScheduler = {
  schedule(delayMs, callback) {
    const handle = setTimeout(callback, delayMs)
    return { cancel: () => clearTimeout(handle) }
  },
}

export type WatchdogEventContextSource = WatchdogEventContext | (() => WatchdogEventContext)

export type WatchdogProbeResult = Readonly<{
  observation: WatchdogObservation
  evaluation: WatchdogEvaluation
  events: readonly EventInput[]
}>

export type WatchdogMonitorErrorStage =
  | "clock"
  | "evaluation"
  | "scheduler"
  | "telemetry"
  | "on-evaluation"
  | "on-action"

export type WatchdogMonitorError = Readonly<{
  stage: WatchdogMonitorErrorStage
  error: unknown
  phase: WatchdogPhase
}>

export type WatchdogMonitorOptions = {
  profile: WatchdogProfile
  phase: WatchdogPhase
  eventContext: WatchdogEventContextSource
  initialBudget?: WatchdogOperationalBudget
  clock?: WatchdogClock
  scheduler?: WatchdogScheduler
  signal?: AbortSignal
  /**
   * Treat execution of the scheduled probe as a control-plane heartbeat.
   * This is useful for in-process phases and is deliberately disabled for
   * worker phases, whose IPC heartbeat must be recorded explicitly.
   */
  autoControlHeartbeat?: boolean
  probeId?: (sequence: number, phase: WatchdogPhase) => string
  onEvaluation?: (result: WatchdogProbeResult) => void
  onAction?: (result: WatchdogProbeResult) => void
  onError?: (failure: WatchdogMonitorError) => void | Promise<void>
}

export type WatchdogPhaseStart = {
  settlement?: "running" | "settled" | "unknown"
  phaseDeadlineMonotonicMs?: number
  hardDeadlineMonotonicMs?: number
}

export type WatchdogDeadlines = {
  phaseDeadlineMonotonicMs?: number | null
  hardDeadlineMonotonicMs?: number | null
}

type Moment = {
  monotonicMs: number
  timestamp: string
}

type SignalMarkers = {
  lastControlHeartbeat?: Moment
  lastProgress?: Moment
  lastProcessProbe?: Moment
  lastChildHeartbeat?: Moment
  processAlive: WatchdogTriState
  processActivity: WatchdogTriState
  providerPending: WatchdogTriState
  providerStreamOpen: WatchdogTriState
  providerRetryAfterMonotonicMs?: number
  settlement: "running" | "settled" | "unknown"
  phaseDeadlineMonotonicMs?: number
  hardDeadlineMonotonicMs?: number
}

function nonnegativeMilliseconds(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer in milliseconds`)
  }
  return value
}

function deadlineAfter(now: number, delayMs: number, field: string): number {
  const delay = nonnegativeMilliseconds(delayMs, field)
  const deadline = now + delay
  if (!Number.isSafeInteger(deadline)) {
    throw new Error(`${field} exceeds the supported monotonic clock range`)
  }
  return deadline
}

function settlementValue(
  value: "running" | "settled" | "unknown",
): "running" | "settled" | "unknown" {
  switch (value) {
    case "running":
    case "settled":
    case "unknown":
      return value
  }
}

/**
 * Command-owned watchdog scheduler.
 *
 * Signal writers are synchronous and side-effect free. Each scheduled probe is
 * fully evaluated and durably observed before another probe can begin. The
 * evaluation/action hooks are deliberately synchronous so an operation cannot
 * settle between action reservation and attempt-local cancellation. Error
 * reporting may remain asynchronous.
 */
export class WatchdogMonitor {
  readonly #profile: WatchdogProfile
  readonly #eventContext: WatchdogEventContextSource
  readonly #clock: WatchdogClock
  readonly #scheduler: WatchdogScheduler
  readonly #signal: AbortSignal | undefined
  readonly #autoControlHeartbeat: boolean
  readonly #probeId: NonNullable<WatchdogMonitorOptions["probeId"]>
  readonly #onEvaluation: WatchdogMonitorOptions["onEvaluation"]
  readonly #onAction: WatchdogMonitorOptions["onAction"]
  readonly #onError: WatchdogMonitorOptions["onError"]

  #phase: WatchdogPhase
  #phaseStartedMonotonicMs: number
  #markers: SignalMarkers
  #budget: WatchdogOperationalBudget
  #previousSnapshot: WatchdogSnapshot | undefined
  #lastClockValue: number | undefined
  #lastError: WatchdogMonitorError | undefined
  #probeSequence = 0
  #generation = 0
  #signalRevision = 0
  #running = false
  #probeRequested = false
  #scheduled: WatchdogScheduledTask | undefined
  #inFlight: Promise<WatchdogProbeResult | undefined> | undefined

  constructor(options: WatchdogMonitorOptions) {
    this.#profile = WatchdogProfileSchema.parse(options.profile)
    this.#phase = WatchdogPhaseSchema.parse(options.phase)
    this.#eventContext =
      typeof options.eventContext === "function"
        ? options.eventContext
        : WatchdogEventContextSchema.parse(options.eventContext)
    this.#clock = options.clock ?? systemWatchdogClock
    this.#scheduler = options.scheduler ?? systemWatchdogScheduler
    this.#signal = options.signal
    this.#autoControlHeartbeat = options.autoControlHeartbeat ?? false
    this.#probeId = options.probeId ?? ((sequence) => `watchdog-${sequence}`)
    this.#onEvaluation = options.onEvaluation
    this.#onAction = options.onAction
    this.#onError = options.onError
    this.#budget = WatchdogOperationalBudgetSchema.parse(
      options.initialBudget ?? { schemaVersion: 1, watchdogRestarts: 0 },
    )

    const started = this.#readMoment()
    this.#lastClockValue = started.monotonicMs
    this.#phaseStartedMonotonicMs = started.monotonicMs
    this.#markers = this.#freshMarkers("running")
  }

  get running(): boolean {
    return this.#running
  }

  get phase(): WatchdogPhase {
    return this.#phase
  }

  get previousSnapshot(): WatchdogSnapshot | undefined {
    return this.#previousSnapshot ? WatchdogSnapshotSchema.parse(this.#previousSnapshot) : undefined
  }

  get budget(): WatchdogOperationalBudget {
    return WatchdogOperationalBudgetSchema.parse(this.#budget)
  }

  get lastError(): WatchdogMonitorError | undefined {
    return this.#lastError
  }

  /** Starts with an immediate probe and is safe to call repeatedly. */
  start(): void {
    if (this.#running || this.#signal?.aborted) return
    this.#running = true
    this.#generation += 1
    this.#signal?.addEventListener("abort", this.#onAbort, { once: true })
    this.#requestProbe(0)
  }

  /** Stops future work. An already-running observer hook is allowed to settle. */
  stop(): void {
    if (!this.#running && !this.#scheduled) return
    this.#running = false
    this.#generation += 1
    this.#probeRequested = false
    this.#cancelScheduled()
    this.#signal?.removeEventListener("abort", this.#onAbort)
  }

  /** Allows shutdown coordinators to await an observer hook without deadlocking stop(). */
  async whenIdle(): Promise<void> {
    await this.#inFlight
  }

  /**
   * Drains an existing probe and then evaluates the latest signal revision
   * immediately. Terminal command boundaries use this to persist settlement or
   * recovery instead of cancelling a queued zero-delay probe.
   */
  async flush(): Promise<WatchdogProbeResult | undefined> {
    await this.#inFlight
    if (!this.#running) return undefined
    this.#cancelScheduled()
    return this.#runProbe(this.#generation)
  }

  beginPhase(phaseInput: WatchdogPhase, input: WatchdogPhaseStart = {}): void {
    const phase = WatchdogPhaseSchema.parse(phaseInput)
    const started = this.#readMoment()
    const settlement = settlementValue(input.settlement ?? "running")
    const phaseDeadline =
      input.phaseDeadlineMonotonicMs === undefined
        ? undefined
        : nonnegativeMilliseconds(input.phaseDeadlineMonotonicMs, "phaseDeadlineMonotonicMs")
    const hardDeadline =
      input.hardDeadlineMonotonicMs === undefined
        ? undefined
        : nonnegativeMilliseconds(input.hardDeadlineMonotonicMs, "hardDeadlineMonotonicMs")
    this.#phase = phase
    this.#phaseStartedMonotonicMs = started.monotonicMs
    this.#markers = this.#freshMarkers(settlement)
    // A phase name can repeat across attempts. Its confirmation history cannot:
    // carrying a stalled snapshot into a fresh instance would make a healthy
    // restart look like an invalid stalled -> healthy transition.
    this.#previousSnapshot = undefined
    this.#signalRevision += 1
    if (phaseDeadline !== undefined) this.#markers.phaseDeadlineMonotonicMs = phaseDeadline
    if (hardDeadline !== undefined) this.#markers.hardDeadlineMonotonicMs = hardDeadline
    this.#generation += 1
    if (this.#running) this.#requestProbe(0)
  }

  recordControlHeartbeat(): void {
    this.#markers.lastControlHeartbeat = this.#readMoment()
    this.#signalRevision += 1
  }

  recordProgress(): void {
    this.#markers.lastProgress = this.#readMoment()
    this.#signalRevision += 1
  }

  recordProcessAlive(value: WatchdogTriState): void {
    const observed = this.#readMoment()
    this.#markers.processAlive = WatchdogTriStateSchema.parse(value)
    this.#markers.lastProcessProbe = observed
    this.#signalRevision += 1
  }

  recordProcessActivity(value: WatchdogTriState): void {
    const observed = this.#readMoment()
    this.#markers.processActivity = WatchdogTriStateSchema.parse(value)
    this.#markers.lastProcessProbe = observed
    this.#signalRevision += 1
  }

  recordProviderPending(value: WatchdogTriState): void {
    this.#markers.providerPending = WatchdogTriStateSchema.parse(value)
    this.#signalRevision += 1
  }

  recordProviderStream(value: WatchdogTriState): void {
    this.#markers.providerStreamOpen = WatchdogTriStateSchema.parse(value)
    this.#signalRevision += 1
  }

  /** Sets a Retry-After window relative to the injected monotonic clock. */
  recordProviderRetryAfter(delayMs: number | null): void {
    if (delayMs === null) {
      delete this.#markers.providerRetryAfterMonotonicMs
      this.#signalRevision += 1
      return
    }
    const now = this.#readMonotonic()
    this.#markers.providerRetryAfterMonotonicMs = deadlineAfter(
      now,
      delayMs,
      "provider retry-after",
    )
    this.#signalRevision += 1
  }

  recordProviderRetryAfterUntil(monotonicMs: number | null): void {
    if (monotonicMs === null) {
      delete this.#markers.providerRetryAfterMonotonicMs
      this.#signalRevision += 1
      return
    }
    this.#markers.providerRetryAfterMonotonicMs = nonnegativeMilliseconds(
      monotonicMs,
      "providerRetryAfterMonotonicMs",
    )
    this.#signalRevision += 1
  }

  recordChildHeartbeat(): void {
    this.#markers.lastChildHeartbeat = this.#readMoment()
    this.#signalRevision += 1
  }

  recordSettlement(value: "running" | "settled" | "unknown"): void {
    this.#markers.settlement = settlementValue(value)
    this.#signalRevision += 1
    if (value === "settled" && this.#running) this.#requestProbe(0)
  }

  /** Applies only the supplied deadlines; null explicitly clears a deadline. */
  setDeadlines(input: WatchdogDeadlines): void {
    const phaseDeadline =
      input.phaseDeadlineMonotonicMs === undefined || input.phaseDeadlineMonotonicMs === null
        ? input.phaseDeadlineMonotonicMs
        : nonnegativeMilliseconds(input.phaseDeadlineMonotonicMs, "phaseDeadlineMonotonicMs")
    const hardDeadline =
      input.hardDeadlineMonotonicMs === undefined || input.hardDeadlineMonotonicMs === null
        ? input.hardDeadlineMonotonicMs
        : nonnegativeMilliseconds(input.hardDeadlineMonotonicMs, "hardDeadlineMonotonicMs")
    if (Object.hasOwn(input, "phaseDeadlineMonotonicMs")) {
      if (phaseDeadline === null) {
        delete this.#markers.phaseDeadlineMonotonicMs
      } else if (phaseDeadline !== undefined) {
        this.#markers.phaseDeadlineMonotonicMs = phaseDeadline
      }
    }
    if (Object.hasOwn(input, "hardDeadlineMonotonicMs")) {
      if (hardDeadline === null) {
        delete this.#markers.hardDeadlineMonotonicMs
      } else if (hardDeadline !== undefined) {
        this.#markers.hardDeadlineMonotonicMs = hardDeadline
      }
    }
    if (
      Object.hasOwn(input, "phaseDeadlineMonotonicMs") ||
      Object.hasOwn(input, "hardDeadlineMonotonicMs")
    ) {
      this.#signalRevision += 1
    }
  }

  setDeadlinesAfter(input: {
    phaseTimeoutMs?: number | null
    hardTimeoutMs?: number | null
  }): void {
    const now = this.#readMonotonic()
    this.setDeadlines({
      ...(input.phaseTimeoutMs === null
        ? { phaseDeadlineMonotonicMs: null }
        : input.phaseTimeoutMs !== undefined
          ? {
              phaseDeadlineMonotonicMs: deadlineAfter(now, input.phaseTimeoutMs, "phase timeout"),
            }
          : {}),
      ...(input.hardTimeoutMs === null
        ? { hardDeadlineMonotonicMs: null }
        : input.hardTimeoutMs !== undefined
          ? {
              hardDeadlineMonotonicMs: deadlineAfter(now, input.hardTimeoutMs, "hard timeout"),
            }
          : {}),
    })
  }

  #freshMarkers(settlement: SignalMarkers["settlement"]): SignalMarkers {
    return {
      processAlive: "unknown",
      processActivity: "unknown",
      providerPending: "unknown",
      providerStreamOpen: "unknown",
      settlement,
    }
  }

  #readMonotonic(): number {
    const current = nonnegativeMilliseconds(
      Math.floor(this.#clock.monotonicMs()),
      "watchdog monotonic clock",
    )
    if (this.#lastClockValue !== undefined && current < this.#lastClockValue) {
      throw new Error(
        `The watchdog monotonic clock moved backwards: ${current} < ${this.#lastClockValue}`,
      )
    }
    this.#lastClockValue = current
    return current
  }

  #readMoment(): Moment {
    const monotonicMs = this.#readMonotonic()
    const wall = this.#clock.wallNow()
    if (!(wall instanceof Date) || Number.isNaN(wall.getTime())) {
      throw new Error("The watchdog wall clock returned an invalid Date")
    }
    return { monotonicMs, timestamp: wall.toISOString() }
  }

  #context(): WatchdogEventContext {
    const input =
      typeof this.#eventContext === "function" ? this.#eventContext() : this.#eventContext
    return WatchdogEventContextSchema.parse(input)
  }

  #observation(): WatchdogObservation | undefined {
    const observed = this.#readMoment()
    if (
      this.#previousSnapshot?.phase === this.#phase &&
      observed.monotonicMs <= this.#previousSnapshot.monotonicMs
    ) {
      return undefined
    }
    this.#probeSequence += 1
    const controlHeartbeat = this.#autoControlHeartbeat
      ? observed
      : this.#markers.lastControlHeartbeat
    return WatchdogObservationSchema.parse({
      schemaVersion: 1,
      probeId: this.#probeId(this.#probeSequence, this.#phase),
      phase: this.#phase,
      observedAt: observed.timestamp,
      monotonicMs: observed.monotonicMs,
      phaseStartedMonotonicMs: this.#phaseStartedMonotonicMs,
      ...(controlHeartbeat
        ? {
            lastControlHeartbeatAt: controlHeartbeat.timestamp,
            lastControlHeartbeatMonotonicMs: controlHeartbeat.monotonicMs,
          }
        : {}),
      ...(this.#markers.lastProgress
        ? {
            lastProgressAt: this.#markers.lastProgress.timestamp,
            lastProgressMonotonicMs: this.#markers.lastProgress.monotonicMs,
          }
        : {}),
      ...(this.#markers.lastProcessProbe
        ? {
            lastProcessProbeAt: this.#markers.lastProcessProbe.timestamp,
            lastProcessProbeMonotonicMs: this.#markers.lastProcessProbe.monotonicMs,
          }
        : {}),
      ...(this.#markers.lastChildHeartbeat
        ? {
            lastChildHeartbeatAt: this.#markers.lastChildHeartbeat.timestamp,
            lastChildHeartbeatMonotonicMs: this.#markers.lastChildHeartbeat.monotonicMs,
          }
        : {}),
      processAlive: this.#markers.processAlive,
      processActivity: this.#markers.processActivity,
      providerPending: this.#markers.providerPending,
      providerStreamOpen: this.#markers.providerStreamOpen,
      ...(this.#markers.providerRetryAfterMonotonicMs !== undefined
        ? {
            providerRetryAfterMonotonicMs: this.#markers.providerRetryAfterMonotonicMs,
          }
        : {}),
      settlement: this.#markers.settlement,
      ...(this.#markers.phaseDeadlineMonotonicMs !== undefined
        ? { phaseDeadlineMonotonicMs: this.#markers.phaseDeadlineMonotonicMs }
        : {}),
      ...(this.#markers.hardDeadlineMonotonicMs !== undefined
        ? { hardDeadlineMonotonicMs: this.#markers.hardDeadlineMonotonicMs }
        : {}),
    })
  }

  #cancelScheduled(): void {
    this.#scheduled?.cancel()
    this.#scheduled = undefined
  }

  #requestProbe(delayMs: number): void {
    if (!this.#running) return
    if (this.#inFlight) {
      this.#probeRequested = true
      return
    }
    this.#cancelScheduled()
    const generation = this.#generation
    try {
      this.#scheduled = this.#scheduler.schedule(delayMs, () => {
        this.#scheduled = undefined
        if (!this.#running || generation !== this.#generation) return
        this.#launchProbe(generation)
      })
    } catch (error) {
      this.stop()
      void this.#reportError("scheduler", error)
    }
  }

  #launchProbe(generation: number): void {
    if (!this.#running || generation !== this.#generation) return
    if (this.#inFlight) {
      this.#probeRequested = true
      return
    }
    // Deferring one microtask lets #inFlight become visible before any user
    // hook can synchronously write another signal or request another probe.
    const inFlight = Promise.resolve().then(() => this.#runProbe(generation))
    this.#inFlight = inFlight
    void inFlight
      .finally(() => {
        if (this.#inFlight === inFlight) this.#inFlight = undefined
        if (!this.#running) return
        const immediate = this.#probeRequested
        this.#probeRequested = false
        const interval = resolveWatchdogPhaseProfile(this.#profile, this.#phase).probeIntervalMs
        this.#requestProbe(immediate ? 0 : interval)
      })
      .catch(() => undefined)
  }

  async #runProbe(generation: number): Promise<WatchdogProbeResult | undefined> {
    if (!this.#running || generation !== this.#generation) return undefined
    const signalRevision = this.#signalRevision
    let observation: WatchdogObservation | undefined
    try {
      observation = this.#observation()
    } catch (error) {
      await this.#reportError("clock", error)
      return undefined
    }
    if (!observation) return undefined

    let evaluation: WatchdogEvaluation
    try {
      evaluation = evaluateWatchdog({
        profile: this.#profile,
        observation,
        budget: this.#budget,
        ...(this.#previousSnapshot ? { previousSnapshot: this.#previousSnapshot } : {}),
      })
    } catch (error) {
      await this.#reportError("evaluation", error)
      return undefined
    }

    let events: readonly EventInput[]
    try {
      events = watchdogEventInputs(this.#context(), evaluation)
    } catch (error) {
      await this.#reportError("telemetry", error)
      return undefined
    }

    if (
      !this.#running ||
      generation !== this.#generation ||
      signalRevision !== this.#signalRevision
    ) {
      this.#probeRequested = true
      return undefined
    }

    const result = { observation, evaluation, events } satisfies WatchdogProbeResult

    try {
      this.#onEvaluation?.(result)
    } catch (error) {
      await this.#reportError("on-evaluation", error)
      return undefined
    }

    if (
      !this.#running ||
      generation !== this.#generation ||
      signalRevision !== this.#signalRevision
    ) {
      this.#probeRequested = true
      return result
    }

    // The durable observer accepted this exact signal revision. Only now may
    // the in-memory snapshot/budget advance or an action be delivered.
    this.#previousSnapshot = evaluation.snapshot
    this.#budget = evaluation.nextBudget

    if (evaluation.decision.action !== "none" && this.#running && generation === this.#generation) {
      try {
        this.#onAction?.(result)
      } catch (error) {
        await this.#reportError("on-action", error)
      }
    }

    if (observation.settlement === "settled" && this.#running && generation === this.#generation) {
      this.stop()
    }
    return result
  }

  async #reportError(stage: WatchdogMonitorErrorStage, error: unknown): Promise<void> {
    const failure = { stage, error, phase: this.#phase } satisfies WatchdogMonitorError
    this.#lastError = failure
    try {
      await this.#onError?.(failure)
    } catch {
      // Error reporting is observational and must not create a recursive failure loop.
    }
  }

  readonly #onAbort = (): void => this.stop()
}
