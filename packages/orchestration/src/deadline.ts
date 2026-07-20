import { EXIT_CODES, type ExecutorOutcome, RalphError } from "@ralph-next/domain"
import type { CallHandle, ExecutionBackend } from "./backend"

const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_CANCEL_GRACE_MS = 5_000
const DEFAULT_SETTLEMENT_GRACE_MS = 10_000

export const EXECUTION_DEADLINE_EXCEEDED = "RALPH_EXECUTION_DEADLINE_EXCEEDED"
export const EXECUTION_CANCELLED = "RALPH_EXECUTION_CANCELLED"

export type AwaitBackendOutcomeInput = {
  backend: ExecutionBackend
  handle: CallHandle
  deadlineAt?: string
  signal?: AbortSignal
  now?: () => number
  cancelGraceMs?: number
  settlementGraceMs?: number
}

export type AwaitBackendStartInput = {
  backend: ExecutionBackend
  start: () => Promise<CallHandle>
  deadlineAt?: string
  signal?: AbortSignal
  now?: () => number
  onLateHandle?: (handle: CallHandle, error: RalphError) => void | Promise<void>
}

export type AwaitExecutionDeadlineInput<T> = {
  operation: Promise<T>
  deadlineAt?: string
  signal?: AbortSignal
  phase: string
  now?: () => number
  onLateResolve?: (value: T, error: RalphError) => void | Promise<void>
}

type BoundedSettlement<T> =
  | { status: "settled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timed_out" }

function boundedMilliseconds(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RalphError(
      "RALPH_EXECUTION_CANCEL_GRACE_INVALID",
      `${name} must be a non-negative safe integer`,
      { exitCode: EXIT_CODES.operationalError, details: { [name]: resolved } },
    )
  }
  return resolved
}

async function settleWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<BoundedSettlement<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<BoundedSettlement<T>>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ status: "timed_out" }), milliseconds)
  })
  try {
    return await Promise.race([
      promise.then<BoundedSettlement<T>, BoundedSettlement<T>>(
        (value) => ({ status: "settled", value }),
        (error: unknown) => ({ status: "rejected", error }),
      ),
      timeout,
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function deadlineMilliseconds(deadlineAt: string): number {
  const value = Date.parse(deadlineAt)
  if (!Number.isFinite(value)) {
    throw new RalphError(
      "RALPH_EXECUTION_DEADLINE_INVALID",
      `Execution deadline is not a valid timestamp: ${deadlineAt}`,
      { exitCode: EXIT_CODES.operationalError, details: { deadlineAt } },
    )
  }
  return value
}

export function executionDeadlineExceededError(deadlineAt: string, phase?: string): RalphError {
  return new RalphError(
    EXECUTION_DEADLINE_EXCEEDED,
    `Execution deadline was exceeded at ${deadlineAt}`,
    {
      exitCode: EXIT_CODES.budgetExceeded,
      details: { deadlineAt, ...(phase ? { phase } : {}) },
    },
  )
}

export function remainingExecutionDeadlineMilliseconds(
  deadlineAt: string,
  now: () => number = Date.now,
): number {
  return deadlineMilliseconds(deadlineAt) - now()
}

export function assertExecutionDeadline(
  deadlineAt: string | undefined,
  phase?: string,
  now: () => number = Date.now,
): void {
  if (!deadlineAt) return
  if (remainingExecutionDeadlineMilliseconds(deadlineAt, now) <= 0) {
    throw executionDeadlineExceededError(deadlineAt, phase)
  }
}

function deadlineSignal(
  deadlineAt: string,
  clock: () => number,
  phase?: string,
): { promise: Promise<never>; cancel: () => void } {
  const deadline = deadlineMilliseconds(deadlineAt)
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false

  const promise = new Promise<never>((_resolve, reject) => {
    const check = (): void => {
      if (cancelled) return
      const remaining = deadline - clock()
      if (remaining <= 0) {
        reject(executionDeadlineExceededError(deadlineAt, phase))
        return
      }
      timer = setTimeout(check, Math.min(remaining, MAX_TIMER_DELAY_MS))
    }
    check()
  })

  return {
    promise,
    cancel: () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    },
  }
}

function cancellationReason(signal: AbortSignal): string | undefined {
  if (signal.reason instanceof Error && signal.reason.message.trim()) return signal.reason.message
  if (typeof signal.reason === "string" && signal.reason.trim()) return signal.reason
  return undefined
}

export function executionCancelledError(signal: AbortSignal, phase?: string): RalphError {
  return new RalphError(EXECUTION_CANCELLED, "Execution was cancelled by the command", {
    exitCode: EXIT_CODES.interrupted,
    details: {
      ...(phase ? { phase } : {}),
      ...(cancellationReason(signal) ? { reason: cancellationReason(signal) } : {}),
    },
  })
}

export function isExecutionCancelled(error: unknown): error is RalphError {
  return error instanceof RalphError && error.code === EXECUTION_CANCELLED
}

export function assertExecutionNotCancelled(signal: AbortSignal | undefined, phase?: string): void {
  if (signal?.aborted) throw executionCancelledError(signal, phase)
}

function cancellationSignal(
  signal: AbortSignal,
  phase?: string,
): { promise: Promise<never>; cancel: () => void } {
  let listener: (() => void) | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    listener = () => reject(executionCancelledError(signal, phase))
    if (signal.aborted) {
      listener()
      return
    }
    signal.addEventListener("abort", listener, { once: true })
  })
  return {
    promise,
    cancel: () => {
      if (listener) signal.removeEventListener("abort", listener)
    },
  }
}

/**
 * Bounds any orchestration phase by the command-owned task deadline. The late
 * operation is always observed; callers may additionally cancel a resource
 * that only becomes identifiable after the deadline.
 */
export async function awaitExecutionDeadline<T>(input: AwaitExecutionDeadlineInput<T>): Promise<T> {
  assertExecutionNotCancelled(input.signal, input.phase)
  if (!input.deadlineAt && !input.signal) return input.operation
  const clock = input.now ?? Date.now
  const deadline = input.deadlineAt
    ? deadlineSignal(input.deadlineAt, clock, input.phase)
    : undefined
  const cancellation = input.signal ? cancellationSignal(input.signal, input.phase) : undefined
  try {
    const value = await Promise.race([
      input.operation,
      ...(deadline ? [deadline.promise] : []),
      ...(cancellation ? [cancellation.promise] : []),
    ])
    assertExecutionNotCancelled(input.signal, input.phase)
    assertExecutionDeadline(input.deadlineAt, input.phase, clock)
    return value
  } catch (error) {
    const authoritativeError =
      input.signal?.aborted && !isExecutionDeadlineExceeded(error)
        ? executionCancelledError(input.signal, input.phase)
        : error
    if (
      !isExecutionDeadlineExceeded(authoritativeError) &&
      !isExecutionCancelled(authoritativeError)
    ) {
      throw authoritativeError
    }

    void input.operation
      .then(async (value) => {
        await input.onLateResolve?.(value, authoritativeError)
      })
      .catch(() => undefined)
    throw authoritativeError
  } finally {
    deadline?.cancel()
    cancellation?.cancel()
  }
}

/**
 * Bounds backend startup itself. A handle arriving after the deadline is
 * immediately cancelled and its outcome observed, so a provider cannot keep
 * the command waiting merely by never settling `start()`.
 */
export async function awaitBackendStart(input: AwaitBackendStartInput): Promise<CallHandle> {
  assertExecutionNotCancelled(input.signal, "backend-start")
  const start = Promise.resolve().then(input.start)
  return awaitExecutionDeadline({
    operation: start,
    ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    phase: "backend-start",
    ...(input.now ? { now: input.now } : {}),
    onLateResolve: async (handle, error) => {
      void handle.outcome.catch(() => undefined)
      const cancellation = Promise.resolve().then(() => input.backend.cancel(handle, error.message))
      void cancellation.catch(() => undefined)
      await input.onLateHandle?.(handle, error)
    },
  })
}

export function isExecutionDeadlineExceeded(error: unknown): error is RalphError {
  return error instanceof RalphError && error.code === EXECUTION_DEADLINE_EXCEEDED
}

/**
 * Waits for a backend allegation without transferring timeout authority to the
 * backend. When the orchestrator deadline wins, cancellation is requested and
 * the late outcome is observed so it cannot become an unhandled rejection.
 */
export async function awaitBackendOutcome(
  input: AwaitBackendOutcomeInput,
): Promise<ExecutorOutcome> {
  if (!input.deadlineAt && !input.signal) return input.handle.outcome

  const deadline = input.deadlineAt
    ? deadlineSignal(input.deadlineAt, input.now ?? Date.now, "backend-outcome")
    : undefined
  const cancellationWatch = input.signal
    ? cancellationSignal(input.signal, "backend-outcome")
    : undefined
  try {
    const value = await Promise.race([
      input.handle.outcome,
      ...(deadline ? [deadline.promise] : []),
      ...(cancellationWatch ? [cancellationWatch.promise] : []),
    ])
    assertExecutionNotCancelled(input.signal, "backend-outcome")
    return value
  } catch (error) {
    const authoritativeError =
      input.signal?.aborted && !isExecutionDeadlineExceeded(error)
        ? executionCancelledError(input.signal, "backend-outcome")
        : error
    if (
      !isExecutionDeadlineExceeded(authoritativeError) &&
      !isExecutionCancelled(authoritativeError)
    ) {
      throw authoritativeError
    }

    // Observe both promises even when their bounded grace expires. A provider
    // must never be able to create an unhandled rejection after the command
    // has already persisted the authoritative timeout outcome.
    void input.handle.outcome.catch(() => undefined)
    const cancelGraceMs = boundedMilliseconds(
      input.cancelGraceMs,
      DEFAULT_CANCEL_GRACE_MS,
      "cancelGraceMs",
    )
    const settlementGraceMs = boundedMilliseconds(
      input.settlementGraceMs,
      DEFAULT_SETTLEMENT_GRACE_MS,
      "settlementGraceMs",
    )
    const cancellationPromise = Promise.resolve().then(() =>
      input.backend.cancel(input.handle, authoritativeError.message),
    )
    void cancellationPromise.catch(() => undefined)
    const cancellation = await settleWithin(cancellationPromise, cancelGraceMs)
    const settlement = await settleWithin(input.handle.outcome, settlementGraceMs)

    if (cancellation.status === "rejected") {
      const cancellationError = cancellation.error
      throw new RalphError(
        isExecutionCancelled(authoritativeError)
          ? EXECUTION_CANCELLED
          : EXECUTION_DEADLINE_EXCEEDED,
        `${authoritativeError.message}; backend cancellation failed`,
        {
          exitCode: isExecutionCancelled(authoritativeError)
            ? EXIT_CODES.interrupted
            : EXIT_CODES.budgetExceeded,
          details: {
            ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
            cancellationError:
              cancellationError instanceof Error
                ? cancellationError.message
                : String(cancellationError),
            outcomeSettlement: settlement.status,
          },
          cause: cancellationError,
        },
      )
    }
    if (cancellation.status === "timed_out" || settlement.status === "timed_out") {
      throw new RalphError(
        isExecutionCancelled(authoritativeError)
          ? EXECUTION_CANCELLED
          : EXECUTION_DEADLINE_EXCEEDED,
        authoritativeError.message,
        {
          exitCode: isExecutionCancelled(authoritativeError)
            ? EXIT_CODES.interrupted
            : EXIT_CODES.budgetExceeded,
          details: {
            ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
            cancellationStatus: cancellation.status,
            outcomeSettlement: settlement.status,
            cancelGraceMs,
            settlementGraceMs,
          },
        },
      )
    }
    throw new RalphError(
      isExecutionCancelled(authoritativeError) ? EXECUTION_CANCELLED : EXECUTION_DEADLINE_EXCEEDED,
      authoritativeError.message,
      {
        exitCode: isExecutionCancelled(authoritativeError)
          ? EXIT_CODES.interrupted
          : EXIT_CODES.budgetExceeded,
        details: {
          ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
          cancellationStatus: cancellation.status,
          outcomeSettlement: settlement.status,
        },
      },
    )
  } finally {
    deadline?.cancel()
    cancellationWatch?.cancel()
  }
}
