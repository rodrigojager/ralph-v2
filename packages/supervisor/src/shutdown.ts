import type { SupervisedProcessHandle } from "./contracts"
import { MAX_TIMER_DELAY_MS } from "./worker-protocol"

export type ShutdownParticipant = Pick<SupervisedProcessHandle, "cancel" | "forceKill"> & {
  readonly pid?: number
}

export class ProcessShutdownRegistry {
  readonly #participants = new Set<ShutdownParticipant>()
  readonly #idleWaiters = new Set<() => void>()

  register(participant: ShutdownParticipant): () => void {
    this.#participants.add(participant)
    let registered = true
    return () => {
      if (!registered) return
      registered = false
      this.#participants.delete(participant)
      if (this.#participants.size !== 0) return
      for (const resolve of this.#idleWaiters) resolve()
      this.#idleWaiters.clear()
    }
  }

  get activeCount(): number {
    return this.#participants.size
  }

  async cancelAll(reason: string): Promise<void> {
    await Promise.allSettled(
      [...this.#participants].map((participant) => participant.cancel(reason)),
    )
  }

  async forceKillAll(reason: string): Promise<void> {
    await Promise.allSettled(
      [...this.#participants].map((participant) => participant.forceKill(reason)),
    )
  }

  /** Resolves only after every participant has run its settlement unregister hook. */
  async whenIdle(): Promise<void> {
    if (this.#participants.size === 0) return
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve))
  }
}

export const processShutdownRegistry = new ProcessShutdownRegistry()

export type TwoPhaseShutdownState = "running" | "graceful" | "forced" | "closed"

export type TwoPhaseShutdownOptions = {
  abortController: AbortController
  registry?: ProcessShutdownRegistry
  forceExit?: (exitCode: number) => void
  forceExitCode?: number
  forceExitTimeoutMs?: number
  onStateChange?: (state: TwoPhaseShutdownState, reason: string) => void
}

/**
 * Command-owned two-phase shutdown: the first signal stops scheduling and
 * requests graceful cancellation; a subsequent signal force-kills every
 * registered process tree before terminating the command process.
 */
export class TwoPhaseShutdownController {
  readonly #abortController: AbortController
  readonly #registry: ProcessShutdownRegistry
  readonly #forceExit: (exitCode: number) => void
  readonly #forceExitCode: number
  readonly #forceExitTimeoutMs: number
  readonly #onStateChange: TwoPhaseShutdownOptions["onStateChange"]
  #state: TwoPhaseShutdownState = "running"
  #gracefulPromise: Promise<void> | undefined
  #forcePromise: Promise<void> | undefined
  #closePromise: Promise<void> | undefined

  constructor(options: TwoPhaseShutdownOptions) {
    this.#abortController = options.abortController
    this.#registry = options.registry ?? processShutdownRegistry
    this.#forceExit = options.forceExit ?? ((exitCode) => process.exit(exitCode))
    this.#forceExitCode = options.forceExitCode ?? 130
    const forceExitTimeoutMs = options.forceExitTimeoutMs ?? 1_500
    if (
      !Number.isSafeInteger(forceExitTimeoutMs) ||
      forceExitTimeoutMs < 0 ||
      forceExitTimeoutMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error("Force-exit timeout must be a non-negative timer-safe integer")
    }
    this.#forceExitTimeoutMs = forceExitTimeoutMs
    this.#onStateChange = options.onStateChange
  }

  get state(): TwoPhaseShutdownState {
    return this.#state
  }

  handleSignal(signal: "SIGINT" | "SIGTERM"): void {
    const reason = `Received ${signal}`
    if (this.#state === "closed") return
    if (this.#state === "running") {
      this.#state = "graceful"
      this.#onStateChange?.(this.#state, reason)
      if (!this.#abortController.signal.aborted) {
        this.#abortController.abort(new Error(reason))
      }
      this.#gracefulPromise ??= this.#registry.cancelAll(reason)
      return
    }
    if (this.#state === "forced") return
    this.#state = "forced"
    this.#onStateChange?.(this.#state, reason)
    this.#forcePromise ??= this.#force(reason)
  }

  close(): Promise<void> {
    if (this.#state === "closed") return Promise.resolve()
    this.#closePromise ??= this.#close()
    return this.#closePromise
  }

  async #close(): Promise<void> {
    const reason = "Command settlement completed"
    // Normal settlement preserves the existing background/detach contract.
    // A signal-owned settlement must instead drain every participant and keep
    // the controller graceful long enough for a second signal to escalate it.
    if (this.#state === "running") {
      this.#state = "closed"
      this.#onStateChange?.(this.#state, reason)
      return
    }
    if (this.#state === "graceful" && this.#gracefulPromise) await this.#gracefulPromise
    if (this.#state === "forced" && this.#forcePromise) await this.#forcePromise
    await this.#registry.whenIdle()
    // The second signal may have arrived while close awaited graceful
    // settlement or registry idleness.
    if (this.#state === "forced" && this.#forcePromise) await this.#forcePromise
    if (this.#state === "closed") return
    this.#state = "closed"
    this.#onStateChange?.(this.#state, reason)
  }

  async #force(reason: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.#registry.forceKillAll(reason),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.#forceExitTimeoutMs)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
      this.#forceExit(this.#forceExitCode)
    }
  }
}
