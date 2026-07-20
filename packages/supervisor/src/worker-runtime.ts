import { randomUUID } from "node:crypto"
import { redactText, secretValuesFromEnvironment } from "@ralph-next/telemetry"
import { processShutdownRegistry } from "./shutdown"
import {
  assertWorkerOperationAuthority,
  assertWorkerOperationResultBinding,
  WorkerOperationError,
  WorkerOperationNameSchema,
  type WorkerOperationRequest,
} from "./worker-operations"
import {
  assertWorkerMessageAuthority,
  hashWorkerCapabilityToken,
  immutableWorkerIdentity,
  MAX_TIMER_DELAY_MS,
  matchesWorkerCapabilityToken,
  mergeWorkerCapabilityGrants,
  parseSupervisorWorkerMessage,
  parseWorkerSupervisorMessage,
  type SupervisorWorkerMessage,
  WORKER_PROTOCOL_VERSION,
  type WorkerCancellationCause,
  type WorkerCapabilityAction,
  type WorkerCapabilityGrant,
  type WorkerIdentity,
  type WorkerParentCallMethod,
  type WorkerRole,
  type WorkerSupervisorMessage,
} from "./worker-protocol"

export type WorkerOperationContext = {
  readonly workerId: string
  readonly requestId: string
  readonly identity: WorkerIdentity
  readonly signal: AbortSignal
  readonly capability: WorkerCapabilityGrant
  emitProgress(phase: string, detail?: unknown): void
  callSupervisor(method: WorkerParentCallMethod, payload: unknown): Promise<unknown>
}

export type WorkerOperationHandler = {
  readonly role: WorkerRole
  readonly capability: WorkerCapabilityAction
  handle(payload: unknown, context: WorkerOperationContext): Promise<unknown>
}

export type WorkerOperationRegistry = Readonly<Record<string, WorkerOperationHandler>>

export type WorkerRuntimeOptions = {
  readonly operations?: WorkerOperationRegistry
  readonly loadOperations?: (
    identity: WorkerIdentity,
  ) => WorkerOperationRegistry | Promise<WorkerOperationRegistry>
  readonly expectedRole?: WorkerRole
  readonly maximumMessageBytes?: number
  readonly cancellationGraceMs?: number
  readonly disconnectGraceMs?: number
  readonly forceCleanupGraceMs?: number
  readonly ownsProcessGroup?: boolean
  readonly terminateProcess?: (exitCode: number) => void
  readonly now?: () => string
  readonly onProtocolError?: (error: unknown) => void
}

type ActiveRequest = {
  id: string
  controller: AbortController
  cancellationCause?: WorkerCancellationCause
  phase?: string
  cancelEscalation?: () => void
  parentCalls: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedProtocolText(value: unknown, fallback: string): string {
  const message = errorMessage(value)
  return redactText(
    message.length > 0 ? message : fallback,
    secretValuesFromEnvironment(process.env),
  ).slice(0, 4_096)
}

function sendToSupervisor(message: WorkerSupervisorMessage): void {
  if (typeof process.send !== "function") {
    throw new Error("Worker was not launched with an IPC channel")
  }
  process.send(message)
}

function timerSafeDelay(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} timer-safe integer`,
    )
  }
  return value
}

function scheduleAt(deadlineAt: string, callback: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const arm = (): void => {
    if (cancelled) return
    const remaining = Date.parse(deadlineAt) - Date.now()
    if (!Number.isFinite(remaining) || remaining <= 0) {
      callback()
      return
    }
    timer = setTimeout(arm, Math.min(MAX_TIMER_DELAY_MS, Math.ceil(remaining)))
  }
  arm()
  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}

function earlierDeadline(
  requestDeadline: string | undefined,
  workerDeadline: string | undefined,
): string | undefined {
  if (!requestDeadline) return workerDeadline
  if (!workerDeadline) return requestDeadline
  return Date.parse(requestDeadline) <= Date.parse(workerDeadline)
    ? requestDeadline
    : workerDeadline
}

/**
 * Runs the child side of Ralph's typed worker protocol.
 *
 * The runtime has no persistence dependency and never owns task transitions.
 * It accepts one command at a time, proves the boot capability on every IPC
 * message, emits an independent control heartbeat, and acknowledges ordered
 * shutdown. The supervisor remains the sole durable writer.
 */
export async function runWorkerRuntime(options: WorkerRuntimeOptions): Promise<void> {
  if ((options.operations ? 1 : 0) + (options.loadOperations ? 1 : 0) !== 1) {
    throw new Error("Worker runtime requires exactly one operation registry source")
  }
  const now = options.now ?? (() => new Date().toISOString())
  const observeProtocolError = (error: unknown): void => {
    try {
      options.onProtocolError?.(error)
    } catch {
      // Diagnostics cannot change worker ownership or shutdown behavior.
    }
  }
  let cancellationGraceMs = timerSafeDelay(
    options.cancellationGraceMs ?? 2_000,
    "Worker cancellation grace",
    true,
  )
  let disconnectGraceMs = timerSafeDelay(
    options.disconnectGraceMs ?? 5_000,
    "Worker disconnect grace",
    true,
  )
  let forceCleanupGraceMs = timerSafeDelay(
    options.forceCleanupGraceMs ?? 1_500,
    "Worker force cleanup grace",
    true,
  )
  const terminateProcess =
    options.terminateProcess ?? ((exitCode: number) => process.exit(exitCode))
  const ownsProcessGroup = options.ownsProcessGroup ?? process.env.RALPH_WORKER === "1"
  let operations = options.operations
  let workerId: string | undefined
  let capabilityToken: string | undefined
  let capabilityHash: string | undefined
  let processStartToken: string | undefined
  let heartbeatIntervalMs: number | undefined
  let identity: WorkerIdentity | undefined
  let capabilities: readonly WorkerCapabilityGrant[] = []
  let inboundSequence = -1
  let outboundSequence = 0
  let active: ActiveRequest | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let shuttingDown = false
  let disconnected = false
  let shutdownReason: string | undefined
  let shutdownAcknowledged = false
  let gracefulCleanupPending = false
  let shutdownEscalation: (() => void) | undefined
  let forceTerminationStarted = false

  let finish: (() => void) | undefined
  const completed = new Promise<void>((resolve) => {
    finish = resolve
  })

  const nextEnvelope = () => ({
    schemaVersion: WORKER_PROTOCOL_VERSION,
    workerId: workerId as string,
    sequence: outboundSequence++,
    sentAt: now(),
    capabilityToken: capabilityToken as string,
  })
  const send = (message: WorkerSupervisorMessage): void =>
    sendToSupervisor(parseWorkerSupervisorMessage(message, options.maximumMessageBytes))
  const sendError = (input: {
    requestId?: string
    code: string
    message: string
    retryable: boolean
  }): void => {
    if (!workerId || !capabilityToken) return
    send({
      ...nextEnvelope(),
      type: "worker.error",
      ...input,
      message: boundedProtocolText(input.message, "Worker operation failed"),
    })
  }
  const clearHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
  }
  const forceTerminate = (reason: string): void => {
    if (forceTerminationStarted) return
    forceTerminationStarted = true
    clearHeartbeat()
    void (async () => {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          processShutdownRegistry.forceKillAll(reason),
          new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, forceCleanupGraceMs)
          }),
        ])
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer)
        if (ownsProcessGroup && process.platform !== "win32") {
          try {
            process.kill(-process.pid, "SIGKILL")
          } catch {
            // Fall back to terminating this worker if its process group vanished.
          }
        }
        terminateProcess(137)
        finish?.()
      }
    })()
  }
  const stopActive = (
    reason: string,
    cause: WorkerCancellationCause,
    escalationDeadlineAt = new Date(Date.now() + cancellationGraceMs).toISOString(),
  ): void => {
    if (!active) return
    if (!active.controller.signal.aborted) {
      active.cancellationCause = cause
      active.controller.abort(new Error(reason))
    }
    for (const pending of active.parentCalls.values()) pending.reject(new Error(reason))
    active.parentCalls.clear()
    active.cancelEscalation?.()
    active.cancelEscalation = scheduleAt(escalationDeadlineAt, () => forceTerminate(reason))
  }

  const acknowledgeShutdown = (): void => {
    if (
      !shuttingDown ||
      shutdownAcknowledged ||
      active ||
      gracefulCleanupPending ||
      !workerId ||
      !capabilityToken
    ) {
      return
    }
    shutdownAcknowledged = true
    if (disconnected) {
      shutdownEscalation?.()
      shutdownEscalation = undefined
      finish?.()
      return
    }
    try {
      send({
        ...nextEnvelope(),
        type: "worker.shutdown-ack",
        reason: shutdownReason ?? "Worker shutdown requested",
      })
      process.disconnect?.()
    } catch (error) {
      observeProtocolError(error)
      disconnected = true
    }
    shutdownEscalation?.()
    shutdownEscalation = undefined
    finish?.()
  }
  const beginGracefulCleanup = (reason: string): void => {
    if (gracefulCleanupPending) return
    gracefulCleanupPending = true
    void processShutdownRegistry.cancelAll(reason).finally(() => {
      gracefulCleanupPending = false
      acknowledgeShutdown()
    })
  }

  const dispatch = async (raw: unknown): Promise<void> => {
    let message: SupervisorWorkerMessage
    try {
      message = parseSupervisorWorkerMessage(raw, options.maximumMessageBytes)
      if (message.type === "worker.bootstrap") {
        if (workerId) throw new Error("Worker bootstrap may only be accepted once")
        if (message.identity.workerId !== message.workerId) {
          throw new Error("Worker bootstrap identity does not match its envelope")
        }
        if (
          !matchesWorkerCapabilityToken(message.capabilityToken, message.identity.capabilityHash)
        ) {
          throw new Error("Worker bootstrap capability proof is invalid")
        }
        workerId = message.workerId
        capabilityToken = message.capabilityToken
        capabilityHash = message.identity.capabilityHash
        processStartToken = message.identity.processStartToken
        capabilities = message.identity.capabilities
        heartbeatIntervalMs = message.heartbeatIntervalMs
        cancellationGraceMs = timerSafeDelay(
          message.cancellationGraceMs,
          "Worker cancellation grace",
          true,
        )
        disconnectGraceMs = timerSafeDelay(
          message.disconnectGraceMs,
          "Worker disconnect grace",
          true,
        )
        forceCleanupGraceMs = timerSafeDelay(
          message.forceCleanupGraceMs,
          "Worker force cleanup grace",
          true,
        )
        if (options.expectedRole && message.identity.role !== options.expectedRole) {
          throw new Error(
            `Worker entrypoint role ${options.expectedRole} does not match bootstrap role ${message.identity.role}`,
          )
        }
        identity = immutableWorkerIdentity({
          ...message.identity,
          pid: process.pid,
          startedAt: now(),
        })
        capabilities = identity.capabilities
        operations ??= await options.loadOperations?.(identity)
        if (!operations || Object.keys(operations).length === 0) {
          throw new Error("Worker operation registry is empty after bootstrap")
        }
        inboundSequence = message.sequence
        send({
          ...nextEnvelope(),
          type: "worker.ready",
          pid: process.pid,
          processStartToken,
          startedAt: identity.startedAt,
        })
        heartbeat = setInterval(() => {
          try {
            send({
              ...nextEnvelope(),
              type: "worker.heartbeat",
              ...(active ? { activeRequestId: active.id } : {}),
              ...(active?.phase ? { phase: active.phase } : {}),
              controlResponsive: true,
            })
          } catch (error) {
            observeProtocolError(error)
            forceTerminate("Worker heartbeat could not reach its supervisor")
          }
        }, heartbeatIntervalMs)
        return
      }
      if (!workerId || !capabilityToken || !capabilityHash) {
        throw new Error("Worker must receive bootstrap before other messages")
      }
      assertWorkerMessageAuthority(message, {
        workerId,
        capabilityHash,
        minimumSequenceExclusive: inboundSequence,
      })
      inboundSequence = message.sequence
    } catch (error) {
      observeProtocolError(error)
      sendError({
        code: "RALPH_WORKER_PROTOCOL_INVALID",
        message: errorMessage(error),
        retryable: false,
      })
      return
    }

    switch (message.type) {
      case "worker.ping":
        send({ ...nextEnvelope(), type: "worker.pong", pingId: message.pingId })
        return
      case "worker.cancel":
        if (active?.id === message.requestId) stopActive(message.reason, message.cause)
        return
      case "worker.shutdown":
        if (shuttingDown) return
        shuttingDown = true
        shutdownReason = message.reason
        shutdownEscalation?.()
        shutdownEscalation = scheduleAt(message.deadlineAt, () => forceTerminate(message.reason))
        stopActive(message.reason, "shutdown", message.deadlineAt)
        beginGracefulCleanup(message.reason)
        clearHeartbeat()
        acknowledgeShutdown()
        return
      case "worker.parent-result": {
        if (active?.id !== message.requestId) {
          throw new Error("Supervisor result is not bound to the active worker request")
        }
        const pending = active.parentCalls.get(message.parentCallId)
        if (!pending) throw new Error("Supervisor result has no pending worker call")
        active.parentCalls.delete(message.parentCallId)
        pending.resolve(message.result)
        return
      }
      case "worker.parent-error": {
        if (active?.id !== message.requestId) {
          throw new Error("Supervisor error is not bound to the active worker request")
        }
        const pending = active.parentCalls.get(message.parentCallId)
        if (!pending) throw new Error("Supervisor error has no pending worker call")
        active.parentCalls.delete(message.parentCallId)
        pending.reject(new Error(`${message.code}: ${message.message}`))
        return
      }
      case "worker.execute": {
        if (shuttingDown) {
          sendError({
            requestId: message.requestId,
            code: "RALPH_WORKER_CLOSING",
            message: "Worker is closing and cannot accept new work",
            retryable: true,
          })
          return
        }
        if (active) {
          sendError({
            requestId: message.requestId,
            code: "RALPH_WORKER_BUSY",
            message: `Worker is already executing ${active.id}`,
            retryable: true,
          })
          return
        }
        const operation = WorkerOperationNameSchema.safeParse(message.operation)
        const handler = operation.success ? operations?.[operation.data] : undefined
        if (
          !operation.success ||
          !handler ||
          handler.capability !== message.requiredCapability ||
          handler.role !== identity?.role
        ) {
          sendError({
            requestId: message.requestId,
            code: "RALPH_WORKER_OPERATION_DENIED",
            message: `Worker operation is not registered with the requested capability: ${message.operation}`,
            retryable: false,
          })
          return
        }
        const capability = mergeWorkerCapabilityGrants(capabilities, message.requiredCapability)
        if (!capability) {
          sendError({
            requestId: message.requestId,
            code: "RALPH_WORKER_CAPABILITY_DENIED",
            message: `Worker capability does not authorize ${message.requiredCapability}`,
            retryable: false,
          })
          return
        }
        if (!identity) {
          sendError({
            requestId: message.requestId,
            code: "RALPH_WORKER_IDENTITY_UNAVAILABLE",
            message: "Worker identity was not established by bootstrap",
            retryable: false,
          })
          return
        }
        const requestIdentity = identity
        let payload: WorkerOperationRequest
        try {
          payload = assertWorkerOperationAuthority(operation.data, message.payload, {
            identity: requestIdentity,
            capability,
          })
        } catch (error) {
          sendError({
            requestId: message.requestId,
            code: "RALPH_WORKER_REQUEST_DENIED",
            message: boundedProtocolText(error, "Worker request authority validation failed"),
            retryable: false,
          })
          return
        }
        const controller = new AbortController()
        active = { id: message.requestId, controller, parentCalls: new Map() }
        const effectiveDeadline = earlierDeadline(
          earlierDeadline(message.deadlineAt, payload.scope.deadlineAt),
          requestIdentity.deadlineAt,
        )
        const deadline = effectiveDeadline
          ? scheduleAt(effectiveDeadline, () => {
              if (active?.id === message.requestId) {
                stopActive("Worker request deadline expired", "deadline")
              }
            })
          : undefined
        void Promise.resolve()
          .then(() => {
            if (controller.signal.aborted) {
              throw controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new Error("Worker request was cancelled before operation dispatch")
            }
            return handler.handle(payload, {
              workerId: requestIdentity.workerId,
              requestId: message.requestId,
              identity: requestIdentity,
              signal: controller.signal,
              capability,
              emitProgress: (phase, detail) => {
                if (shuttingDown || active?.id !== message.requestId) return
                active.phase = phase
                send({
                  ...nextEnvelope(),
                  type: "worker.progress",
                  requestId: message.requestId,
                  phase,
                  ...(detail === undefined ? {} : { detail }),
                })
              },
              callSupervisor: (method, payloadValue) => {
                if (shuttingDown || active?.id !== message.requestId || controller.signal.aborted) {
                  return Promise.reject(new Error("Worker request cannot call its supervisor now"))
                }
                if (active.parentCalls.size >= 256) {
                  return Promise.reject(new Error("Worker supervisor-call limit exceeded"))
                }
                const parentCallId = randomUUID()
                return new Promise<unknown>((resolveCall, rejectCall) => {
                  active?.parentCalls.set(parentCallId, {
                    resolve: resolveCall,
                    reject: rejectCall,
                  })
                  try {
                    send({
                      ...nextEnvelope(),
                      type: "worker.parent-call",
                      requestId: message.requestId,
                      parentCallId,
                      method,
                      payload: payloadValue,
                    })
                  } catch (error) {
                    active?.parentCalls.delete(parentCallId)
                    rejectCall(error instanceof Error ? error : new Error(String(error)))
                  }
                })
              },
            })
          })
          .then((result) => {
            if (shuttingDown || active?.id !== message.requestId) return
            if (controller.signal.aborted) {
              send({
                ...nextEnvelope(),
                type: "worker.cancelled",
                requestId: message.requestId,
                cause: active.cancellationCause ?? "cancel-request",
                reason: boundedProtocolText(controller.signal.reason, "Worker request cancelled"),
              })
              return
            }
            send({
              ...nextEnvelope(),
              type: "worker.result",
              requestId: message.requestId,
              result: assertWorkerOperationResultBinding(operation.data, payload, result),
            })
          })
          .catch((error) => {
            if (shuttingDown || active?.id !== message.requestId) return
            if (controller.signal.aborted) {
              send({
                ...nextEnvelope(),
                type: "worker.cancelled",
                requestId: message.requestId,
                cause: active.cancellationCause ?? "cancel-request",
                reason: boundedProtocolText(
                  controller.signal.reason ?? error,
                  "Worker request cancelled",
                ),
              })
              return
            }
            sendError({
              requestId: message.requestId,
              code:
                error instanceof WorkerOperationError
                  ? error.code
                  : "RALPH_WORKER_OPERATION_FAILED",
              message: boundedProtocolText(error, "Worker operation failed"),
              retryable: error instanceof WorkerOperationError && error.retryable,
            })
          })
          .finally(() => {
            deadline?.()
            if (active?.id === message.requestId) {
              for (const pending of active.parentCalls.values()) {
                pending.reject(new Error("Worker operation settled before its supervisor call"))
              }
              active.parentCalls.clear()
              active.cancelEscalation?.()
              active = undefined
            }
            acknowledgeShutdown()
          })
          .catch(observeProtocolError)
        return
      }
    }
  }

  const onMessage = (message: unknown): void => {
    void dispatch(message).catch(observeProtocolError)
  }
  const onDisconnect = (): void => {
    shuttingDown = true
    disconnected = true
    shutdownReason = "Supervisor IPC disconnected"
    const disconnectDeadline = new Date(Date.now() + disconnectGraceMs).toISOString()
    shutdownEscalation?.()
    shutdownEscalation = scheduleAt(disconnectDeadline, () =>
      forceTerminate("Supervisor IPC disconnected"),
    )
    stopActive("Supervisor IPC disconnected", "supervisor-disconnect", disconnectDeadline)
    beginGracefulCleanup("Supervisor IPC disconnected")
    clearHeartbeat()
    acknowledgeShutdown()
  }
  process.on("message", onMessage)
  process.once("disconnect", onDisconnect)
  try {
    await completed
  } finally {
    clearHeartbeat()
    shutdownEscalation?.()
    active?.cancelEscalation?.()
    process.off("message", onMessage)
    process.off("disconnect", onDisconnect)
  }
}

export function workerCapabilityFingerprint(
  capabilityToken: string,
  capabilities: readonly WorkerCapabilityGrant[],
): { capabilityHash: string; grantFingerprint: string } {
  return {
    capabilityHash: hashWorkerCapabilityToken(capabilityToken),
    grantFingerprint: hashWorkerCapabilityToken(JSON.stringify(capabilities)),
  }
}
