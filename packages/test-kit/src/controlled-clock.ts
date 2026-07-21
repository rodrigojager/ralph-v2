import type { OAuthClock } from "@ralph/credentials"
import type { WatchdogClock, WatchdogScheduledTask, WatchdogScheduler } from "@ralph/supervisor"

export type ControlledTestClockOptions = {
  monotonicMs?: number
  wallTime?: string | Date | number
  /** OAuth polling normally advances immediately; disable for explicitly controlled sleeps. */
  autoAdvanceSleeps?: boolean
  /** Keeps deadline/sentinel sleeps pending until their AbortSignal is cancelled. */
  freezeSleepsAtOrAboveMs?: number
}

type ScheduledEntry = {
  id: number
  dueAt: number
  callback: () => void
  cancelled: boolean
}

function nonnegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError")
}

/**
 * One deterministic clock for OAuth polling and watchdog monotonic/wall time.
 * It also implements the watchdog scheduler, so a test can advance all timers
 * without sleeping or depending on host load.
 */
export class ControlledTestClock implements OAuthClock, WatchdogClock, WatchdogScheduler {
  readonly sleeps: number[] = []
  readonly #autoAdvanceSleeps: boolean
  readonly #freezeSleepsAtOrAboveMs: number | undefined
  readonly #wallEpochMs: number
  readonly #scheduled = new Map<number, ScheduledEntry>()
  #monotonicMs: number
  #nextScheduledId = 1

  constructor(options: ControlledTestClockOptions = {}) {
    this.#monotonicMs = nonnegativeSafeInteger(options.monotonicMs ?? 0, "monotonicMs")
    const wallTime = options.wallTime ?? "2026-01-01T00:00:00.000Z"
    const parsedWallTime =
      wallTime instanceof Date ? wallTime.getTime() : new Date(wallTime).getTime()
    if (!Number.isFinite(parsedWallTime)) throw new Error("wallTime must be a valid date")
    this.#wallEpochMs = parsedWallTime - this.#monotonicMs
    this.#autoAdvanceSleeps = options.autoAdvanceSleeps ?? true
    this.#freezeSleepsAtOrAboveMs =
      options.freezeSleepsAtOrAboveMs === undefined
        ? undefined
        : nonnegativeSafeInteger(options.freezeSleepsAtOrAboveMs, "freezeSleepsAtOrAboveMs")
  }

  now(): number {
    return this.#wallEpochMs + this.#monotonicMs
  }

  monotonicMs(): number {
    return this.#monotonicMs
  }

  wallNow(): Date {
    return new Date(this.now())
  }

  sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    const delay = nonnegativeSafeInteger(milliseconds, "sleep milliseconds")
    if (signal?.aborted) return Promise.reject(abortError())
    if (this.#freezeSleepsAtOrAboveMs !== undefined && delay >= this.#freezeSleepsAtOrAboveMs) {
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(abortError()), { once: true })
      })
    }
    this.sleeps.push(delay)
    if (this.#autoAdvanceSleeps) {
      this.advanceBy(delay)
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      let scheduled: WatchdogScheduledTask | undefined
      const onAbort = (): void => {
        scheduled?.cancel()
        reject(abortError())
      }
      scheduled = this.schedule(delay, () => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      })
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  schedule(delayMs: number, callback: () => void): WatchdogScheduledTask {
    const delay = nonnegativeSafeInteger(delayMs, "scheduled delayMs")
    const dueAt = this.#monotonicMs + delay
    if (!Number.isSafeInteger(dueAt)) throw new Error("scheduled deadline exceeds safe range")
    const entry: ScheduledEntry = {
      id: this.#nextScheduledId,
      dueAt,
      callback,
      cancelled: false,
    }
    this.#nextScheduledId += 1
    this.#scheduled.set(entry.id, entry)
    return {
      cancel: () => {
        entry.cancelled = true
        this.#scheduled.delete(entry.id)
      },
    }
  }

  advanceBy(milliseconds: number): void {
    const delta = nonnegativeSafeInteger(milliseconds, "advance milliseconds")
    const target = this.#monotonicMs + delta
    if (!Number.isSafeInteger(target)) throw new Error("clock advance exceeds safe range")
    this.advanceTo(target)
  }

  advanceTo(monotonicMs: number): void {
    const target = nonnegativeSafeInteger(monotonicMs, "target monotonicMs")
    if (target < this.#monotonicMs) throw new Error("controlled clock cannot move backwards")
    while (true) {
      const next = [...this.#scheduled.values()]
        .filter((entry) => !entry.cancelled && entry.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0]
      if (!next) break
      this.#monotonicMs = next.dueAt
      this.#scheduled.delete(next.id)
      if (!next.cancelled) next.callback()
    }
    this.#monotonicMs = target
  }

  pendingScheduledTasks(): number {
    return [...this.#scheduled.values()].filter((entry) => !entry.cancelled).length
  }
}
