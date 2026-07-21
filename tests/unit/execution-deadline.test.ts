import { describe, expect, test } from "bun:test"
import { ExecutorOutcomeSchema } from "@ralph/domain"
import {
  awaitBackendOutcome,
  awaitBackendStart,
  type BackendCapabilities,
  type CallHandle,
  type ExecutionBackend,
  type ExecutionRequest,
  isExecutionCancelled,
  isExecutionDeadlineExceeded,
  type ModelEventSink,
} from "@ralph/orchestration"

function outcome() {
  return ExecutorOutcomeSchema.parse({
    schemaVersion: 1,
    status: "work_submitted",
    summary: "bounded execution",
    intendedFiles: [],
    artifactRefs: [],
    suggestedVerifications: [],
    risks: [],
    reportedAt: "2026-07-18T12:00:00.000Z",
  })
}

class DeadlineBackend implements ExecutionBackend {
  readonly id = "deadline-test"
  cancelled: Array<{ handleId: string; reason: string }> = []
  cancellationFailure?: Error
  cancellationNeverSettles = false

  capabilities(): BackendCapabilities {
    return { streaming: false, toolCalling: false, cancellation: true, usage: "unavailable" }
  }

  start(_request: ExecutionRequest, _sink: ModelEventSink): Promise<CallHandle> {
    throw new Error("not used by the deadline unit test")
  }

  async cancel(handle: CallHandle, reason: string): Promise<void> {
    this.cancelled.push({ handleId: handle.id, reason })
    if (this.cancellationNeverSettles) await new Promise<never>(() => undefined)
    if (this.cancellationFailure) throw this.cancellationFailure
  }
}

describe("command-authoritative execution deadline", () => {
  test("does not start backend I/O when command cancellation is already active", async () => {
    const backend = new DeadlineBackend()
    const controller = new AbortController()
    controller.abort(new Error("immediate Ctrl+C"))
    let starts = 0

    let caught: unknown
    try {
      await awaitBackendStart({
        backend,
        signal: controller.signal,
        start: async () => {
          starts += 1
          return { id: "must-not-start", outcome: Promise.resolve(outcome()) }
        },
      })
    } catch (error) {
      caught = error
    }

    expect(isExecutionCancelled(caught)).toBeTrue()
    expect(caught).toMatchObject({ code: "RALPH_EXECUTION_CANCELLED", exitCode: 8 })
    expect(starts).toBe(0)
  })

  test("cancels a handle that arrives after command cancellation won backend startup", async () => {
    const backend = new DeadlineBackend()
    const controller = new AbortController()
    let resolveStart: ((handle: CallHandle) => void) | undefined
    const start = new Promise<CallHandle>((resolveHandle) => {
      resolveStart = resolveHandle
    })
    const pending = awaitBackendStart({
      backend,
      signal: controller.signal,
      start: () => start,
    })

    controller.abort(new Error("Ctrl+C during backend setup"))
    await expect(pending).rejects.toMatchObject({ code: "RALPH_EXECUTION_CANCELLED", exitCode: 8 })

    resolveStart?.({ id: "late-after-cancel", outcome: new Promise<never>(() => undefined) })
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0))
    expect(backend.cancelled).toEqual([
      {
        handleId: "late-after-cancel",
        reason: "Execution was cancelled by the command",
      },
    ])
  })

  test("command cancellation owns backend cancellation and bounded settlement", async () => {
    const backend = new DeadlineBackend()
    const controller = new AbortController()
    let rejectOutcome: ((error: Error) => void) | undefined
    const handle: CallHandle = {
      id: "active-command-call",
      outcome: new Promise((_resolve, reject) => {
        rejectOutcome = reject
      }),
    }
    backend.cancel = async (active, reason) => {
      backend.cancelled.push({ handleId: active.id, reason })
      rejectOutcome?.(new Error("backend observed command cancellation"))
    }
    const pending = awaitBackendOutcome({
      backend,
      handle,
      signal: controller.signal,
      cancelGraceMs: 20,
      settlementGraceMs: 20,
    })

    controller.abort(new Error("Ctrl+C"))
    await expect(pending).rejects.toMatchObject({ code: "RALPH_EXECUTION_CANCELLED", exitCode: 8 })
    expect(backend.cancelled).toEqual([
      { handleId: "active-command-call", reason: "Execution was cancelled by the command" },
    ])
  })

  test("cancels a known handle when the signal aborted just before outcome waiting", async () => {
    const backend = new DeadlineBackend()
    const controller = new AbortController()
    let rejectOutcome: ((error: Error) => void) | undefined
    const handle: CallHandle = {
      id: "known-before-outcome-wait",
      outcome: new Promise((_resolve, reject) => {
        rejectOutcome = reject
      }),
    }
    backend.cancel = async (active, reason) => {
      backend.cancelled.push({ handleId: active.id, reason })
      rejectOutcome?.(new Error("known handle cancelled"))
    }
    controller.abort(new Error("Ctrl+C between start and outcome"))

    await expect(
      awaitBackendOutcome({
        backend,
        handle,
        signal: controller.signal,
        cancelGraceMs: 20,
        settlementGraceMs: 20,
      }),
    ).rejects.toMatchObject({ code: "RALPH_EXECUTION_CANCELLED", exitCode: 8 })
    expect(backend.cancelled).toEqual([
      { handleId: "known-before-outcome-wait", reason: "Execution was cancelled by the command" },
    ])
  })

  test("bounds backend startup even when start never returns a handle", async () => {
    const backend = new DeadlineBackend()

    await expect(
      awaitBackendStart({
        backend,
        start: () => new Promise<never>(() => undefined),
        deadlineAt: new Date(Date.now() + 5).toISOString(),
      }),
    ).rejects.toMatchObject({
      code: "RALPH_EXECUTION_DEADLINE_EXCEEDED",
      exitCode: 9,
      diagnostic: { details: { phase: "backend-start" } },
    })
  })

  test("cancels and observes a backend handle that arrives after startup timed out", async () => {
    const backend = new DeadlineBackend()
    let resolveStart: ((handle: CallHandle) => void) | undefined
    const lateHandle = { id: "late-start", outcome: new Promise<never>(() => undefined) }
    const start = new Promise<CallHandle>((resolveHandle) => {
      resolveStart = resolveHandle
    })

    await expect(
      awaitBackendStart({
        backend,
        start: () => start,
        deadlineAt: new Date(Date.now() + 5).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "RALPH_EXECUTION_DEADLINE_EXCEEDED", exitCode: 9 })

    resolveStart?.(lateHandle)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0))
    expect(backend.cancelled).toEqual([
      {
        handleId: "late-start",
        reason: expect.stringContaining("Execution deadline was exceeded"),
      },
    ])
  })

  test("returns an outcome that settles before the declared deadline", async () => {
    const backend = new DeadlineBackend()
    const handle = { id: "call-fast", outcome: Promise.resolve(outcome()) }

    await expect(
      awaitBackendOutcome({
        backend,
        handle,
        deadlineAt: "2026-07-18T12:00:01.000Z",
        now: () => Date.parse("2026-07-18T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "work_submitted" })
    expect(backend.cancelled).toEqual([])
  })

  test("cancels a pending call when the orchestrator deadline is exhausted", async () => {
    const backend = new DeadlineBackend()
    const handle = { id: "call-pending", outcome: new Promise<never>(() => undefined) }
    let caught: unknown

    try {
      await awaitBackendOutcome({
        backend,
        handle,
        deadlineAt: "2026-07-18T12:00:00.000Z",
        now: () => Date.parse("2026-07-18T12:00:00.001Z"),
        cancelGraceMs: 5,
        settlementGraceMs: 5,
      })
    } catch (error) {
      caught = error
    }

    expect(isExecutionDeadlineExceeded(caught)).toBeTrue()
    expect(caught).toMatchObject({ code: "RALPH_EXECUTION_DEADLINE_EXCEEDED", exitCode: 9 })
    expect(backend.cancelled).toEqual([
      {
        handleId: "call-pending",
        reason: "Execution deadline was exceeded at 2026-07-18T12:00:00.000Z",
      },
    ])
  })

  test("keeps the budget failure authoritative when backend cancellation also fails", async () => {
    const backend = new DeadlineBackend()
    backend.cancellationFailure = new Error("transport already disconnected")
    const handle = { id: "call-cancel-fails", outcome: new Promise<never>(() => undefined) }

    await expect(
      awaitBackendOutcome({
        backend,
        handle,
        deadlineAt: "2026-07-18T12:00:00.000Z",
        now: () => Date.parse("2026-07-18T12:00:00.001Z"),
        cancelGraceMs: 5,
        settlementGraceMs: 5,
      }),
    ).rejects.toMatchObject({
      code: "RALPH_EXECUTION_DEADLINE_EXCEEDED",
      exitCode: 9,
      diagnostic: { details: { cancellationError: "transport already disconnected" } },
    })
  })

  test("bounds a provider cancel call that never settles", async () => {
    const backend = new DeadlineBackend()
    backend.cancellationNeverSettles = true
    const handle = { id: "call-cancel-hangs", outcome: new Promise<never>(() => undefined) }

    await expect(
      awaitBackendOutcome({
        backend,
        handle,
        deadlineAt: "2026-07-18T12:00:00.000Z",
        now: () => Date.parse("2026-07-18T12:00:00.001Z"),
        cancelGraceMs: 5,
        settlementGraceMs: 5,
      }),
    ).rejects.toMatchObject({
      code: "RALPH_EXECUTION_DEADLINE_EXCEEDED",
      exitCode: 9,
      diagnostic: {
        details: {
          cancellationStatus: "timed_out",
          outcomeSettlement: "timed_out",
        },
      },
    })
  })

  test("requests cancellation before returning and prevents delayed work in a cooperative backend", async () => {
    const backend = new DeadlineBackend()
    let wroteAfterDeadline = false
    let cancelled = false
    backend.cancel = async (handle: CallHandle, reason: string): Promise<void> => {
      backend.cancelled.push({ handleId: handle.id, reason })
      cancelled = true
    }
    const handle = {
      id: "call-delayed-write",
      outcome: (async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 30))
        if (!cancelled) wroteAfterDeadline = true
        if (cancelled) throw new Error("cancelled before delayed write")
        return outcome()
      })(),
    }

    await expect(
      awaitBackendOutcome({
        backend,
        handle,
        deadlineAt: "2026-07-18T12:00:00.000Z",
        now: () => Date.parse("2026-07-18T12:00:00.001Z"),
        cancelGraceMs: 5,
        settlementGraceMs: 5,
      }),
    ).rejects.toMatchObject({ code: "RALPH_EXECUTION_DEADLINE_EXCEEDED", exitCode: 9 })

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
    expect(wroteAfterDeadline).toBeFalse()
  })
})
