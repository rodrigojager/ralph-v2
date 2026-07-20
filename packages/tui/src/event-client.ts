import type { RunUiEventCursor, RunUiSnapshot } from "./contracts"
import {
  type IncrementalRunUiSource,
  type RunUiEventBatch,
  RunUiStreamProtocolError,
} from "./event-stream"

export type RunUiFollowFrame =
  | {
      readonly kind: "snapshot"
      readonly snapshot: RunUiSnapshot
      readonly cursor: RunUiEventCursor
      readonly mode?: "live" | "replay"
    }
  | { readonly kind: "events"; readonly batch: RunUiEventBatch }
  | { readonly kind: "heartbeat"; readonly cursor: RunUiEventCursor }
  | { readonly kind: "disconnect"; readonly reason: string; readonly retryable: boolean }

export interface RunUiFollowRequest {
  readonly runId: string
  /** Inclusive watermark; the feed must return only events after this cursor. */
  readonly after: RunUiEventCursor | null
  readonly signal: AbortSignal
}

/**
 * Local supervisor, IPC, socket, or ledger adapters implement this tiny port.
 * The TUI package never reaches through it into persistence or a provider.
 */
export interface RunUiFollowTransport {
  follow(request: RunUiFollowRequest): AsyncIterable<RunUiFollowFrame>
}

export interface RunUiReconnectPolicy {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly maximumDelayMs: number
  readonly multiplier: number
}

export type RunUiReconnectDelay = (delayMs: number, signal: AbortSignal) => Promise<void>

export interface RunUiFollowClientOptions {
  readonly runId: string
  readonly source: IncrementalRunUiSource
  readonly transport: RunUiFollowTransport
  readonly reconnect?: Partial<RunUiReconnectPolicy>
  readonly signal?: AbortSignal
  readonly delay?: RunUiReconnectDelay
  readonly nowEpochMs?: () => number
  readonly onError?: (error: unknown, retryable: boolean) => void
}

export class RunUiRemoteDisconnectError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = "RunUiRemoteDisconnectError"
    this.retryable = retryable
  }
}

const DEFAULT_RECONNECT: RunUiReconnectPolicy = {
  maxAttempts: Number.POSITIVE_INFINITY,
  initialDelayMs: 250,
  maximumDelayMs: 10_000,
  multiplier: 2,
}

function abortError(): Error {
  const error = new Error("TUI event follow was aborted")
  error.name = "AbortError"
  return error
}

const DEFAULT_DELAY: RunUiReconnectDelay = (delayMs, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(abortError())
    }
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)
    signal.addEventListener("abort", onAbort, { once: true })
  })

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value))
}

function reconnectAttemptLimit(value: number | undefined, fallback: number): number {
  if (value === Number.POSITIVE_INFINITY) return value
  return finiteNonNegative(value, fallback)
}

function positiveMultiplier(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value < 1 ? fallback : value
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message.slice(0, 500)
  return String(error).slice(0, 500)
}

function retryableError(error: unknown): boolean {
  if (error instanceof RunUiRemoteDisconnectError) return error.retryable
  if (error instanceof RunUiStreamProtocolError) return false
  return true
}

function reconnectDelay(policy: RunUiReconnectPolicy, attempt: number): number {
  if (policy.initialDelayMs === 0) return 0
  const unbounded = policy.initialDelayMs * policy.multiplier ** Math.max(0, attempt - 1)
  return Math.min(policy.maximumDelayMs, Math.floor(unbounded))
}

function runIsTerminal(status: string): boolean {
  return /^(completed|failed|cancelled|canceled|stopped|blocked|rejected)$/i.test(status)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseFollowFrame(value: unknown): RunUiFollowFrame {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new RunUiStreamProtocolError(
      "RALPH_TUI_FOLLOW_FRAME",
      "follow frame must be an object with a kind",
    )
  }
  switch (value.kind) {
    case "snapshot":
      if (!isRecord(value.snapshot) || !isRecord(value.cursor)) {
        throw new RunUiStreamProtocolError(
          "RALPH_TUI_FOLLOW_FRAME",
          "snapshot frame requires snapshot and cursor objects",
        )
      }
      if (value.mode !== undefined && value.mode !== "live" && value.mode !== "replay") {
        throw new RunUiStreamProtocolError(
          "RALPH_TUI_FOLLOW_FRAME",
          `unsupported snapshot mode: ${String(value.mode)}`,
        )
      }
      return value as unknown as RunUiFollowFrame
    case "events":
      if (!isRecord(value.batch)) {
        throw new RunUiStreamProtocolError(
          "RALPH_TUI_FOLLOW_FRAME",
          "events frame requires a batch object",
        )
      }
      return value as unknown as RunUiFollowFrame
    case "heartbeat":
      if (!isRecord(value.cursor)) {
        throw new RunUiStreamProtocolError(
          "RALPH_TUI_FOLLOW_FRAME",
          "heartbeat frame requires a cursor object",
        )
      }
      return value as unknown as RunUiFollowFrame
    case "disconnect":
      if (typeof value.reason !== "string" || typeof value.retryable !== "boolean") {
        throw new RunUiStreamProtocolError(
          "RALPH_TUI_FOLLOW_FRAME",
          "disconnect frame requires reason and retryable",
        )
      }
      return value as unknown as RunUiFollowFrame
    default:
      throw new RunUiStreamProtocolError(
        "RALPH_TUI_FOLLOW_FRAME",
        `unsupported follow frame kind: ${value.kind}`,
      )
  }
}

interface FeedOutcome {
  readonly replayComplete: boolean
}

/**
 * Cursor-aware reconnect loop. It is intentionally renderer-independent: the
 * run and feed continue to exist when the OpenTUI renderer is replaced.
 */
export class RunUiFollowClient {
  readonly #options: RunUiFollowClientOptions
  readonly #policy: RunUiReconnectPolicy
  readonly #delay: RunUiReconnectDelay
  readonly #nowEpochMs: () => number
  #controller: AbortController | null = null
  #iterator: AsyncIterator<RunUiFollowFrame> | null = null
  #running: Promise<void> | null = null
  #stopRequested = false

  constructor(options: RunUiFollowClientOptions) {
    if (options.runId.length === 0) {
      throw new RunUiStreamProtocolError("RALPH_TUI_RUN_ID", "runId must not be empty")
    }
    this.#options = options
    const policy: RunUiReconnectPolicy = {
      maxAttempts: reconnectAttemptLimit(
        options.reconnect?.maxAttempts,
        DEFAULT_RECONNECT.maxAttempts,
      ),
      initialDelayMs: finiteNonNegative(
        options.reconnect?.initialDelayMs,
        DEFAULT_RECONNECT.initialDelayMs,
      ),
      maximumDelayMs: finiteNonNegative(
        options.reconnect?.maximumDelayMs,
        DEFAULT_RECONNECT.maximumDelayMs,
      ),
      multiplier: positiveMultiplier(options.reconnect?.multiplier, DEFAULT_RECONNECT.multiplier),
    }
    this.#policy =
      policy.maximumDelayMs < policy.initialDelayMs
        ? { ...policy, maximumDelayMs: policy.initialDelayMs }
        : policy
    this.#delay = options.delay ?? DEFAULT_DELAY
    this.#nowEpochMs = options.nowEpochMs ?? Date.now
  }

  start(): Promise<void> {
    if (this.#running) return this.#running
    if (this.#stopRequested) {
      return Promise.reject(
        new RunUiStreamProtocolError(
          "RALPH_TUI_CLIENT_CLOSED",
          "a stopped follow client cannot be restarted; create a new client",
        ),
      )
    }
    const controller = new AbortController()
    this.#controller = controller
    const externalSignal = this.#options.signal
    const onExternalAbort = () => this.stop("external signal")
    if (externalSignal?.aborted) {
      this.stop("external signal")
      return Promise.resolve()
    }
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true })

    let execution: Promise<void>
    execution = this.#run(controller.signal).finally(() => {
      externalSignal?.removeEventListener("abort", onExternalAbort)
      if (this.#running === execution) this.#running = null
      if (this.#controller === controller) this.#controller = null
    })
    this.#running = execution
    return execution
  }

  stop(reason = "client stopped"): void {
    if (this.#stopRequested) return
    this.#stopRequested = true
    this.#controller?.abort()
    const iterator = this.#iterator
    if (iterator?.return) {
      void Promise.resolve(iterator.return()).catch(() => {
        // Abort is already authoritative; transport cleanup failure is secondary.
      })
    }
    this.#options.source.markClosed(reason)
  }

  whenStopped(): Promise<void> {
    return this.#running ?? Promise.resolve()
  }

  async #run(signal: AbortSignal): Promise<void> {
    let reconnectAttempt = 0
    this.#options.source.markConnecting()
    while (!signal.aborted && !this.#stopRequested) {
      if (reconnectAttempt > 0) this.#options.source.markReconnecting(reconnectAttempt)
      try {
        const outcome = await this.#consumeFeed(signal, () => {
          reconnectAttempt = 0
        })
        if (outcome.replayComplete || runIsTerminal(this.#options.source.getSnapshot().status))
          return
        if (signal.aborted || this.#stopRequested) return
        throw new RunUiRemoteDisconnectError("event feed ended without a terminal frame", true)
      } catch (error) {
        if (signal.aborted || this.#stopRequested) return
        const retryable = retryableError(error)
        try {
          this.#options.onError?.(error, retryable)
        } catch {
          // An observer cannot take ownership of the reconnect state machine.
        }
        if (!retryable || reconnectAttempt >= this.#policy.maxAttempts) {
          this.#options.source.markDisconnected(errorMessage(error))
          return
        }
        reconnectAttempt += 1
        const delayMs = reconnectDelay(this.#policy, reconnectAttempt)
        const nextRetryAt = new Date(this.#nowEpochMs() + delayMs).toISOString()
        this.#options.source.markDisconnected(errorMessage(error), nextRetryAt)
        try {
          await this.#delay(delayMs, signal)
        } catch (delayError) {
          if (!signal.aborted && !this.#stopRequested) throw delayError
          return
        }
      }
    }
  }

  async #consumeFeed(signal: AbortSignal, onHealthyFrame: () => void): Promise<FeedOutcome> {
    const request: RunUiFollowRequest = {
      runId: this.#options.runId,
      after: this.#options.source.getConnection().cursor,
      signal,
    }
    const iterator = this.#options.transport.follow(request)[Symbol.asyncIterator]()
    this.#iterator = iterator
    let replayComplete = false
    let heartbeatCount = 0
    try {
      while (!signal.aborted && !this.#stopRequested) {
        const item = await iterator.next()
        if (item.done) return { replayComplete }
        const frame = parseFollowFrame(item.value)
        switch (frame.kind) {
          case "snapshot":
            if (frame.mode === "replay") {
              this.#options.source.acceptReplaySnapshot(frame.snapshot, frame.cursor)
              replayComplete = true
            } else {
              this.#options.source.acceptSnapshot(frame.snapshot, frame.cursor)
            }
            onHealthyFrame()
            break
          case "events":
            this.#options.source.ingestBatch(frame.batch)
            onHealthyFrame()
            break
          case "heartbeat":
            this.#options.source.acceptHeartbeat(frame.cursor)
            heartbeatCount += 1
            // A transport may emit one optimistic heartbeat before its first
            // durable read. Require a second heartbeat before resetting the
            // reconnect budget so persistent ledger failures still back off.
            if (heartbeatCount > 1) onHealthyFrame()
            break
          case "disconnect":
            throw new RunUiRemoteDisconnectError(frame.reason, frame.retryable)
          default: {
            const unreachable: never = frame
            throw new RunUiStreamProtocolError(
              "RALPH_TUI_FOLLOW_FRAME",
              `unsupported follow frame: ${String(unreachable)}`,
            )
          }
        }
      }
      return { replayComplete }
    } finally {
      if (this.#iterator === iterator) this.#iterator = null
      if (!signal.aborted && iterator.return) {
        try {
          await iterator.return()
        } catch {
          // Closing a failed transport must not replace the original failure.
        }
      }
    }
  }
}
