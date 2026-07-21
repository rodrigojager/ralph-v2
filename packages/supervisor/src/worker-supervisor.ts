import { createHash, randomUUID } from "node:crypto"
import { readFileSync, realpathSync, type Stats, statSync } from "node:fs"
import { hostname } from "node:os"
import { isAbsolute, relative, sep } from "node:path"
import { redactText, redactValue, secretValuesFromEnvironment } from "@ralph/telemetry"
import { z } from "zod"
import { processStartToken as captureProcessStartToken } from "./process-identity"
import { processShutdownRegistry } from "./shutdown"
import { WindowsProcessJob } from "./windows-job"
import {
  assertWorkerOperationAuthority,
  assertWorkerOperationResultBinding,
  type WorkerOperationName,
  WorkerOperationNameSchema,
  type WorkerOperationRequest,
  type WorkerOperationRequestMap,
  type WorkerOperationResult,
  type WorkerOperationResultMap,
  type WorkerProgressDetail,
  WorkerProgressDetailSchema,
  workerOperationCapability,
  workerOperationRole,
} from "./worker-operations"
import {
  assertWorkerMessageAuthority,
  createWorkerCapabilityToken,
  hashWorkerCapabilityToken,
  immutableWorkerIdentity,
  MAX_TIMER_DELAY_MS,
  MIN_WORKER_HEARTBEAT_INTERVAL_MS,
  mergeWorkerCapabilityGrants,
  parseSupervisorWorkerMessage,
  parseWorkerSupervisorMessage,
  redactWorkerProtocolMessage,
  type SupervisorWorkerMessage,
  WORKER_PROTOCOL_VERSION,
  type WorkerCancellationCause,
  type WorkerCapabilityAction,
  WorkerCapabilityGrantSchema,
  type WorkerIdentity,
  WorkerIdentitySchema,
  type WorkerParentCallMethod,
  WorkerRoleSchema,
  type WorkerSupervisorMessage,
  workerRoleAllowsCapability,
} from "./worker-protocol"

const TimestampSchema = z.iso.datetime({ offset: true })
const FORBIDDEN_WORKER_BOOTSTRAP_ENVIRONMENT = new Set([
  "BUN_OPTIONS",
  "BUN_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
])

export const WorkerLaunchSpecSchema = z
  .object({
    workerId: z.string().min(1).max(4_096),
    workspaceId: z.string().min(1).max(4_096),
    workspaceRoot: z
      .string()
      .min(1)
      .max(32_768)
      .refine(isAbsolute, "Worker workspace root must be absolute"),
    runId: z.string().min(1).max(4_096),
    attemptId: z.string().min(1).max(4_096).optional(),
    parentWorkerId: z.string().min(1).max(4_096).optional(),
    role: WorkerRoleSchema,
    executable: z
      .string()
      .min(1)
      .max(32_768)
      .refine(isAbsolute, "Worker executable must be absolute"),
    executableHash: z.string().regex(/^[a-f0-9]{64}$/),
    launch: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("standalone-executable") }).strict(),
      z
        .object({
          kind: z.literal("bundled-runtime-entrypoint"),
          path: z
            .string()
            .min(1)
            .max(32_768)
            .refine(isAbsolute, "Worker bundled entrypoint must be absolute"),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
    args: z.array(z.string().max(65_536)).max(1_024),
    cwd: z.string().min(1).max(32_768).refine(isAbsolute, "Worker cwd must be absolute"),
    environment: z.record(z.string().min(1).max(32_768), z.string()),
    capabilities: z.array(WorkerCapabilityGrantSchema).min(1).max(64),
    heartbeatIntervalMs: z
      .number()
      .int()
      .min(MIN_WORKER_HEARTBEAT_INTERVAL_MS)
      .max(MAX_TIMER_DELAY_MS),
    startupTimeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS).default(30_000),
    shutdownGraceMs: z.number().int().nonnegative().max(MAX_TIMER_DELAY_MS).default(5_000),
    requestCancellationGraceMs: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_TIMER_DELAY_MS)
      .default(2_000),
    forceCleanupGraceMs: z.number().int().nonnegative().max(MAX_TIMER_DELAY_MS).default(1_500),
    deadlineAt: TimestampSchema.optional(),
  })
  .strict()
export type WorkerLaunchSpec = z.input<typeof WorkerLaunchSpecSchema>

export type WorkerLifecycleState = "starting" | "ready" | "busy" | "closing" | "exited" | "failed"

export type WorkerLifecycleSnapshot = {
  readonly identity: WorkerIdentity
  readonly state: WorkerLifecycleState
  readonly activeRequestId?: string
  /** Receipt time of worker.ready/worker.heartbeat only; pong is tracked by its pending probe. */
  readonly lastControlHeartbeatAt?: string
  readonly lastControlHeartbeatMonotonicMs?: number
  readonly lastProgressAt?: string
  readonly lastProgressMonotonicMs?: number
  readonly lastSequence: number
  readonly exitCode?: number
  readonly signal?: string
}

export type WorkerExecutionRequest = {
  readonly requestId?: string
  readonly operation: WorkerOperationName
  readonly requiredCapability: WorkerCapabilityAction
  readonly payload: unknown
  readonly deadlineAt?: string
  readonly signal?: AbortSignal
  readonly onParentCall?: (call: {
    readonly workerId: string
    readonly requestId: string
    readonly parentCallId: string
    readonly method: WorkerParentCallMethod
    readonly payload: unknown
  }) => unknown | Promise<unknown>
}

export type WorkerExecutionResult = {
  readonly requestId: string
  readonly result: WorkerOperationResult
}

export type WorkerSupervisorObserver = {
  onMessage?(message: ReturnType<typeof redactWorkerProtocolMessage>): void | Promise<void>
  onState?(snapshot: WorkerLifecycleSnapshot): void | Promise<void>
  onProgress?(progress: {
    workerId: string
    requestId: string
    phase: string
    sentAt: string
    receivedAt: string
    receivedMonotonicMs: number
    detail?: WorkerProgressDetail
  }): void | Promise<void>
  onOutput?(stream: "stdout" | "stderr", text: string): void | Promise<void>
}

export type TypedWorkerHandle = {
  readonly identity: WorkerIdentity
  readonly ready: Promise<WorkerIdentity>
  readonly settlement: Promise<{ exitCode: number; snapshot: WorkerLifecycleSnapshot }>
  snapshot(): WorkerLifecycleSnapshot
  execute(request: WorkerExecutionRequest): Promise<WorkerExecutionResult>
  ping(timeoutMs?: number): Promise<void>
  cancel(requestId: string, reason: string): void
  shutdown(reason: string, graceMs?: number): Promise<void>
  forceKill(reason: string): Promise<void>
}

export type TypedWorkerOperationOptions = {
  readonly requestId?: string
  readonly deadlineAt?: string
  readonly signal?: AbortSignal
  readonly onParentCall?: WorkerExecutionRequest["onParentCall"]
}

export class WorkerRemoteOperationError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly operation: WorkerOperationName
  readonly requestId: string

  constructor(input: {
    code: string
    message: string
    retryable: boolean
    operation: WorkerOperationName
    requestId: string
  }) {
    super(`${input.code}: ${input.message}`)
    this.name = "WorkerRemoteOperationError"
    this.code = input.code
    this.retryable = input.retryable
    this.operation = input.operation
    this.requestId = input.requestId
  }
}

export class WorkerRequestCancelledError extends Error {
  readonly cancellationCause: WorkerCancellationCause
  readonly operation: WorkerOperationName
  readonly requestId: string

  constructor(input: {
    cause: WorkerCancellationCause
    reason: string
    operation: WorkerOperationName
    requestId: string
  }) {
    super(`Worker request cancelled (${input.cause}): ${input.reason}`)
    this.name = "WorkerRequestCancelledError"
    this.cancellationCause = input.cause
    this.operation = input.operation
    this.requestId = input.requestId
  }
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path
}

function pathIsWithin(scope: string, candidate: string): boolean {
  const child = relative(comparablePath(scope), comparablePath(candidate))
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`))
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

export function workerExecutableContentHash(executable: string): string {
  if (!isAbsolute(executable)) throw new Error("Worker executable must be absolute")
  const canonical = realpathSync.native(executable)
  const before = statSync(canonical)
  if (!before.isFile()) {
    throw new Error(`Worker executable is not a regular file: ${executable}`)
  }
  const bytes = readFileSync(canonical)
  const after = statSync(canonical)
  const canonicalAfter = realpathSync.native(canonical)
  if (
    !sameFileSnapshot(before, after) ||
    comparablePath(canonicalAfter) !== comparablePath(canonical)
  ) {
    throw new Error(`Worker executable changed while it was hashed: ${executable}`)
  }
  return createHash("sha256").update(bytes).digest("hex")
}

/** Derives the capability from the operation and preserves payload/result types. */
export async function executeTypedWorkerOperation<Operation extends WorkerOperationName>(
  worker: TypedWorkerHandle,
  operation: Operation,
  payload: WorkerOperationRequestMap[Operation],
  options: TypedWorkerOperationOptions = {},
): Promise<{
  readonly requestId: string
  readonly result: WorkerOperationResultMap[Operation]
}> {
  const outcome = await worker.execute({
    operation,
    requiredCapability: workerOperationCapability(operation),
    payload,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.deadlineAt ? { deadlineAt: options.deadlineAt } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onParentCall ? { onParentCall: options.onParentCall } : {}),
  })
  return {
    requestId: outcome.requestId,
    result: outcome.result as WorkerOperationResultMap[Operation],
  }
}

type PendingRequest = {
  operation: WorkerOperationName
  request: WorkerOperationRequest
  resolve(value: WorkerExecutionResult): void
  reject(error: Error): void
  abort?: () => void
  onParentCall?: WorkerExecutionRequest["onParentCall"]
}

type PendingPing = {
  resolve(): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function earlierDeadline(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right
  if (!right) return left
  return Date.parse(left) <= Date.parse(right) ? left : right
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

async function waitForSettlementOrTimeout(
  settlement: Promise<unknown>,
  timeoutMs: number,
): Promise<"settled" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      settlement.then(() => "settled" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function safeObserve(operation: () => void | Promise<void>): void {
  try {
    void Promise.resolve(operation()).catch(() => undefined)
  } catch {
    // Observers cannot influence worker ownership or settlement.
  }
}

async function consumeOutput(
  stream: ReadableStream<Uint8Array>,
  kind: "stdout" | "stderr",
  observer: WorkerSupervisorObserver,
  secrets: readonly string[],
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const item = await reader.read()
    if (item.done) break
    const text = decoder.decode(item.value, { stream: true })
    if (text) safeObserve(() => observer.onOutput?.(kind, redactText(text, secrets)))
  }
  const tail = decoder.decode()
  if (tail) safeObserve(() => observer.onOutput?.(kind, redactText(tail, secrets)))
}

/**
 * Spawns one isolated worker with a private typed IPC channel.
 *
 * The handle owns process-tree termination and capability proof. Consumers
 * receive results and diagnostics only; durable run/task transitions remain a
 * responsibility of the command-owned orchestrator.
 */
export async function spawnTypedWorker(
  input: WorkerLaunchSpec,
  observer: WorkerSupervisorObserver = {},
): Promise<TypedWorkerHandle> {
  const spec = WorkerLaunchSpecSchema.parse(input)
  if (spec.deadlineAt && Date.parse(spec.deadlineAt) <= Date.now()) {
    throw new Error(`Worker ${spec.workerId} deadline expired before spawn`)
  }
  const normalizedEnvironmentNames = new Set<string>()
  for (const name of Object.keys(spec.environment)) {
    const normalizedName = process.platform === "win32" ? name.toLocaleUpperCase("en-US") : name
    const authorityName = name.toLocaleUpperCase("en-US")
    if (normalizedEnvironmentNames.has(normalizedName)) {
      throw new Error(`Worker bootstrap environment contains duplicate name ${name}`)
    }
    normalizedEnvironmentNames.add(normalizedName)
    if (authorityName === "RALPH_WORKER") {
      throw new Error("Worker bootstrap environment cannot predeclare RALPH_WORKER")
    }
    if (
      authorityName === "RALPH_WORKER_ROLE" &&
      (name !== "RALPH_WORKER_ROLE" || spec.environment[name] !== spec.role)
    ) {
      throw new Error("Worker bootstrap environment role must exactly match the launch role")
    }
    if (FORBIDDEN_WORKER_BOOTSTRAP_ENVIRONMENT.has(authorityName)) {
      throw new Error(`Worker bootstrap environment cannot inject runtime code via ${name}`)
    }
  }
  const workerExecutable = realpathSync.native(spec.executable)
  const executableHash = workerExecutableContentHash(workerExecutable)
  if (executableHash !== spec.executableHash) {
    throw new Error(`Worker executable hash mismatch: ${spec.executable}`)
  }
  const workerCwd = realpathSync.native(spec.cwd)
  if (!statSync(workerCwd).isDirectory()) {
    throw new Error(`Worker cwd is not a directory: ${spec.cwd}`)
  }
  const workerWorkspaceRoot = realpathSync.native(spec.workspaceRoot)
  if (!statSync(workerWorkspaceRoot).isDirectory()) {
    throw new Error(`Worker workspace root is not a directory: ${spec.workspaceRoot}`)
  }
  const workerLaunch = spec.launch
  const workerEntrypoint =
    workerLaunch.kind === "bundled-runtime-entrypoint"
      ? realpathSync.native(workerLaunch.path)
      : undefined
  if (workerEntrypoint && workerLaunch.kind === "bundled-runtime-entrypoint") {
    if (pathIsWithin(workerWorkspaceRoot, workerEntrypoint)) {
      throw new Error(
        "Worker runtime entrypoint inside the mutable target workspace requires S09 sandbox/bundling",
      )
    }
    if (workerExecutableContentHash(workerEntrypoint) !== workerLaunch.contentHash) {
      throw new Error(`Worker bundled entrypoint hash mismatch: ${workerLaunch.path}`)
    }
  }
  for (const grant of spec.capabilities) {
    if (!workerRoleAllowsCapability(spec.role, grant.action)) {
      throw new Error(`Worker role ${spec.role} cannot receive capability ${grant.action}`)
    }
  }

  const capabilityToken = createWorkerCapabilityToken()
  const capabilityHash = hashWorkerCapabilityToken(capabilityToken)
  const workerSecrets = secretValuesFromEnvironment(spec.environment)
  let processStartToken: string
  const startedAt = new Date().toISOString()
  let inboundSequence = -1
  let outboundSequence = 0
  let state: WorkerLifecycleState = "starting"
  let activeRequestId: string | undefined
  let lastControlHeartbeatAt: string | undefined
  let lastControlHeartbeatMonotonicMs: number | undefined
  let lastProgressAt: string | undefined
  let lastProgressMonotonicMs: number | undefined
  let exitCode: number | undefined
  let exitSignal: string | undefined
  let windowsJob: WindowsProcessJob | undefined
  const requests = new Map<string, PendingRequest>()
  const pings = new Map<string, PendingPing>()
  const cancellationEscalations = new Map<string, () => void>()
  const activeParentCalls = new Map<string, Set<string>>()

  let readyResolve!: (identity: WorkerIdentity) => void
  let readyReject!: (error: Error) => void
  const ready = new Promise<WorkerIdentity>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  void ready.catch(() => undefined)

  let identity!: WorkerIdentity

  const snapshot = (): WorkerLifecycleSnapshot => ({
    identity,
    state,
    ...(activeRequestId ? { activeRequestId } : {}),
    ...(lastControlHeartbeatAt ? { lastControlHeartbeatAt } : {}),
    ...(lastControlHeartbeatMonotonicMs === undefined ? {} : { lastControlHeartbeatMonotonicMs }),
    ...(lastProgressAt ? { lastProgressAt } : {}),
    ...(lastProgressMonotonicMs === undefined ? {} : { lastProgressMonotonicMs }),
    lastSequence: inboundSequence,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(exitSignal ? { signal: exitSignal } : {}),
  })
  const observeState = (): void => {
    if (!identity) return
    safeObserve(() => observer.onState?.(snapshot()))
  }
  const rejectAll = (error: Error): void => {
    for (const pending of requests.values()) {
      pending.abort?.()
      pending.reject(error)
    }
    requests.clear()
    activeParentCalls.clear()
    for (const cancelTimer of cancellationEscalations.values()) cancelTimer()
    cancellationEscalations.clear()
    for (const pending of pings.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    pings.clear()
  }

  let child!: Bun.Subprocess<"ignore", "pipe", "pipe">
  const killWorkerTree = (): void => {
    if (!child) return
    if (process.platform === "win32") {
      if (windowsJob?.terminate()) return
      try {
        const helper = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
        helper.unref()
        return
      } catch {
        // Fall through to the direct-child last resort below.
      }
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL")
        return
      } catch {
        // Fall back to the direct child when the process group no longer exists.
      }
    }
    child.kill(9)
  }
  const assertInboundLifecycle = (message: WorkerSupervisorMessage): void => {
    const assertActiveRequest = (requestId: string, type: string): void => {
      if (state !== "busy" || activeRequestId !== requestId || !requests.has(requestId)) {
        throw new Error(`${type} is not bound to the active worker request ${requestId}`)
      }
    }
    switch (message.type) {
      case "worker.ready":
        if (state !== "starting") {
          throw new Error("Worker sent ready outside the startup handshake")
        }
        return
      case "worker.heartbeat":
        // Shutdown travels supervisor -> worker while heartbeats travel in the
        // opposite direction. An authenticated heartbeat emitted immediately
        // before shutdown can therefore arrive after local state is already
        // closing. It is stale-but-valid lifecycle evidence, not a protocol
        // violation that warrants killing an otherwise graceful worker.
        if (state === "closing") return
        if (state !== "ready" && state !== "busy") {
          throw new Error(`Worker heartbeat is invalid while lifecycle state is ${state}`)
        }
        if (
          // Result delivery and the next supervisor dispatch travel in opposite
          // IPC directions. A heartbeat captured while the worker is between
          // those requests may arrive after the supervisor already marked the
          // next request busy. An omitted request id is therefore a valid
          // boundary snapshot; a different non-empty id still fails closed.
          (state === "busy" &&
            message.activeRequestId !== undefined &&
            message.activeRequestId !== activeRequestId) ||
          (state === "ready" && message.activeRequestId !== undefined)
        ) {
          throw new Error("Worker heartbeat active request does not match supervisor state")
        }
        return
      case "worker.progress":
      case "worker.parent-call":
      case "worker.result":
      case "worker.cancelled":
        assertActiveRequest(message.requestId, message.type)
        if (
          message.type === "worker.result" &&
          (activeParentCalls.get(message.requestId)?.size ?? 0) > 0
        ) {
          throw new Error("Worker returned a result while supervisor calls were still unsettled")
        }
        return
      case "worker.error":
        if (message.requestId) assertActiveRequest(message.requestId, message.type)
        return
      case "worker.pong":
        if (!pings.has(message.pingId)) {
          throw new Error(`Worker pong is not bound to a pending ping ${message.pingId}`)
        }
        return
      case "worker.shutdown-ack":
        if (state !== "closing") {
          throw new Error("Worker acknowledged shutdown before the supervisor requested it")
        }
        return
    }
  }
  const onIpc = (raw: unknown): void => {
    let message: WorkerSupervisorMessage
    let progressDetail: WorkerProgressDetail | undefined
    const receivedAt = new Date().toISOString()
    const receivedMonotonicMs = performance.now()
    try {
      message = parseWorkerSupervisorMessage(raw)
      assertWorkerMessageAuthority(message, {
        workerId: spec.workerId,
        capabilityHash,
        minimumSequenceExclusive: inboundSequence,
      })
      assertInboundLifecycle(message)
      inboundSequence = message.sequence
      if (message.type === "worker.progress" && message.detail !== undefined) {
        progressDetail = WorkerProgressDetailSchema.parse(
          redactValue(WorkerProgressDetailSchema.parse(message.detail), workerSecrets),
        )
      }
    } catch (error) {
      state = "failed"
      const failure = new Error(`Worker IPC validation failed: ${errorMessage(error)}`)
      readyReject(failure)
      rejectAll(failure)
      observeState()
      killWorkerTree()
      return
    }
    safeObserve(() => observer.onMessage?.(redactWorkerProtocolMessage(message, workerSecrets)))
    switch (message.type) {
      case "worker.ready":
        if (message.pid !== child.pid || message.processStartToken !== processStartToken) {
          state = "failed"
          const failure = new Error("Worker ready identity does not match the spawned process")
          readyReject(failure)
          rejectAll(failure)
          observeState()
          killWorkerTree()
          return
        }
        state = "ready"
        lastControlHeartbeatAt = receivedAt
        lastControlHeartbeatMonotonicMs = receivedMonotonicMs
        readyResolve(identity)
        observeState()
        return
      case "worker.heartbeat":
        lastControlHeartbeatAt = receivedAt
        lastControlHeartbeatMonotonicMs = receivedMonotonicMs
        observeState()
        return
      case "worker.progress":
        safeObserve(() =>
          observer.onProgress?.({
            workerId: message.workerId,
            requestId: message.requestId,
            phase: message.phase,
            sentAt: message.sentAt,
            receivedAt,
            receivedMonotonicMs,
            ...(progressDetail === undefined ? {} : { detail: progressDetail }),
          }),
        )
        lastProgressAt = receivedAt
        lastProgressMonotonicMs = receivedMonotonicMs
        observeState()
        return
      case "worker.parent-call": {
        const pending = requests.get(message.requestId)
        if (!pending?.onParentCall) {
          state = "failed"
          const failure = new Error(
            `Worker requested unavailable supervisor service ${message.method}`,
          )
          rejectAll(failure)
          observeState()
          killWorkerTree()
          return
        }
        const allowed =
          (pending.operation === "executor-model.execute" &&
            message.method.startsWith("execution.")) ||
          (pending.operation === "judge.evaluate" && message.method === "judge.emit-event") ||
          (pending.operation === "gate.execute" && message.method === "gate.persist-output") ||
          (pending.operation === "tool.execute" && message.method === "tool.process.execute") ||
          (pending.operation === "child-run.execute" &&
            (message.method === "child.budget.reserve" ||
              message.method === "child.budget.report" ||
              message.method === "child.budget.mark-boundary" ||
              message.method === "child.observe" ||
              message.method === "child.project-event"))
        if (!allowed) {
          state = "failed"
          const failure = new Error(
            `Worker operation ${pending.operation} cannot call supervisor service ${message.method}`,
          )
          rejectAll(failure)
          observeState()
          killWorkerTree()
          return
        }
        const calls = activeParentCalls.get(message.requestId) ?? new Set<string>()
        if (calls.has(message.parentCallId) || calls.size >= 256) {
          state = "failed"
          const failure = new Error("Worker repeated or exceeded bounded supervisor call IDs")
          rejectAll(failure)
          observeState()
          killWorkerTree()
          return
        }
        calls.add(message.parentCallId)
        activeParentCalls.set(message.requestId, calls)
        const settleParentCall = (): void => {
          const current = activeParentCalls.get(message.requestId)
          current?.delete(message.parentCallId)
          if (current?.size === 0) activeParentCalls.delete(message.requestId)
        }
        void Promise.resolve(
          pending.onParentCall({
            workerId: message.workerId,
            requestId: message.requestId,
            parentCallId: message.parentCallId,
            method: message.method,
            payload: message.payload,
          }),
        )
          .then((result) => {
            settleParentCall()
            if (!requests.has(message.requestId) || child.exitCode !== null) return
            send({
              ...nextEnvelope(),
              type: "worker.parent-result",
              requestId: message.requestId,
              parentCallId: message.parentCallId,
              result: result ?? null,
            })
          })
          .catch((error) => {
            settleParentCall()
            if (!requests.has(message.requestId) || child.exitCode !== null) return
            send({
              ...nextEnvelope(),
              type: "worker.parent-error",
              requestId: message.requestId,
              parentCallId: message.parentCallId,
              code: "RALPH_WORKER_PARENT_CALL_FAILED",
              message: errorMessage(error).slice(0, 4_096) || "Supervisor service failed",
            })
          })
          .catch(() => undefined)
        return
      }
      case "worker.result": {
        const pending = requests.get(message.requestId)
        if (!pending) return
        if ((activeParentCalls.get(message.requestId)?.size ?? 0) > 0) {
          state = "failed"
          const failure = new Error(
            `Worker returned ${pending.operation} before its supervisor calls settled`,
          )
          pending.reject(failure)
          requests.delete(message.requestId)
          activeParentCalls.delete(message.requestId)
          pending.abort?.()
          activeRequestId = undefined
          rejectAll(failure)
          observeState()
          killWorkerTree()
          return
        }
        requests.delete(message.requestId)
        activeParentCalls.delete(message.requestId)
        pending.abort?.()
        activeRequestId = undefined
        state = "ready"
        try {
          const validated = assertWorkerOperationResultBinding(
            pending.operation,
            pending.request,
            message.result,
          )
          pending.resolve({
            requestId: message.requestId,
            result: assertWorkerOperationResultBinding(
              pending.operation,
              pending.request,
              redactValue(validated, workerSecrets),
            ),
          })
        } catch (error) {
          const failure = new Error(
            `Worker returned an invalid ${pending.operation} result: ${errorMessage(error)}`,
          )
          state = "failed"
          pending.reject(failure)
          rejectAll(failure)
          observeState()
          killWorkerTree()
          return
        }
        observeState()
        return
      }
      case "worker.error": {
        if (!message.requestId) {
          state = "failed"
          const failure = new Error(
            `${message.code}: ${redactText(message.message, workerSecrets)}`,
          )
          readyReject(failure)
          rejectAll(failure)
          observeState()
          killWorkerTree()
          return
        }
        const pending = requests.get(message.requestId)
        if (!pending) return
        requests.delete(message.requestId)
        activeParentCalls.delete(message.requestId)
        pending.abort?.()
        activeRequestId = undefined
        state = "ready"
        pending.reject(
          new WorkerRemoteOperationError({
            code: message.code,
            message: redactText(message.message, workerSecrets),
            retryable: message.retryable,
            operation: pending.operation,
            requestId: message.requestId,
          }),
        )
        observeState()
        return
      }
      case "worker.cancelled": {
        const pending = requests.get(message.requestId)
        if (!pending) return
        requests.delete(message.requestId)
        activeParentCalls.delete(message.requestId)
        pending.abort?.()
        activeRequestId = undefined
        state = "ready"
        pending.reject(
          new WorkerRequestCancelledError({
            cause: message.cause,
            reason: redactText(message.reason, workerSecrets),
            operation: pending.operation,
            requestId: message.requestId,
          }),
        )
        observeState()
        return
      }
      case "worker.pong": {
        const pending = pings.get(message.pingId)
        if (!pending) return
        pings.delete(message.pingId)
        clearTimeout(pending.timeout)
        // Pong is an active semantic IPC probe. It must not refresh the
        // independently emitted periodic control-heartbeat marker.
        pending.resolve()
        observeState()
        return
      }
      case "worker.shutdown-ack":
        if (activeRequestId) {
          const pending = requests.get(activeRequestId)
          if (pending) {
            requests.delete(activeRequestId)
            pending.abort?.()
            pending.reject(
              new WorkerRequestCancelledError({
                cause: "shutdown",
                reason: redactText(message.reason, workerSecrets),
                operation: pending.operation,
                requestId: activeRequestId,
              }),
            )
          }
          activeRequestId = undefined
        }
        state = "closing"
        observeState()
        return
    }
  }

  if (workerExecutableContentHash(workerExecutable) !== spec.executableHash) {
    throw new Error(`Worker executable changed before spawn: ${spec.executable}`)
  }
  if (
    workerEntrypoint &&
    workerExecutableContentHash(workerEntrypoint) !==
      (workerLaunch.kind === "bundled-runtime-entrypoint" ? workerLaunch.contentHash : "")
  ) {
    throw new Error("Worker bundled entrypoint changed before spawn")
  }
  child = Bun.spawn(
    [workerExecutable, ...(workerEntrypoint ? [workerEntrypoint] : []), ...spec.args],
    {
      cwd: workerCwd,
      env: { ...spec.environment, RALPH_WORKER: "1", RALPH_WORKER_ROLE: spec.role },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      windowsHide: true,
      serialization: "json",
      ipc: onIpc,
      onDisconnect() {
        if (state === "starting") {
          const failure = new Error(`Worker ${spec.workerId} disconnected before becoming ready`)
          state = "failed"
          readyReject(failure)
          rejectAll(failure)
          killWorkerTree()
        } else if (state === "ready" || state === "busy") {
          const failure = new Error(`Worker ${spec.workerId} lost its private IPC channel`)
          state = "failed"
          rejectAll(failure)
          killWorkerTree()
        }
        if (state !== "exited" && state !== "failed") state = "closing"
        observeState()
      },
    },
  )
  try {
    processStartToken = await captureProcessStartToken(child.pid)
  } catch (error) {
    killWorkerTree()
    await waitForSettlementOrTimeout(
      child.exited.catch(() => undefined),
      spec.forceCleanupGraceMs,
    )
    if (child.exitCode === null) killWorkerTree()
    throw new Error(`Could not capture worker process identity: ${errorMessage(error)}`)
  }
  identity = immutableWorkerIdentity(
    WorkerIdentitySchema.parse({
      schemaVersion: WORKER_PROTOCOL_VERSION,
      workerId: spec.workerId,
      workspaceId: spec.workspaceId,
      workspaceRoot: workerWorkspaceRoot,
      runId: spec.runId,
      ...(spec.attemptId ? { attemptId: spec.attemptId } : {}),
      ...(spec.parentWorkerId ? { parentWorkerId: spec.parentWorkerId } : {}),
      role: spec.role,
      pid: child.pid,
      processStartToken,
      hostname: hostname(),
      capabilityHash,
      capabilities: spec.capabilities,
      startedAt,
      ...(spec.deadlineAt ? { deadlineAt: spec.deadlineAt } : {}),
    }),
  )
  if (process.platform === "win32") {
    try {
      windowsJob = await WindowsProcessJob.createForProcess(child.pid)
    } catch (error) {
      await windowsJob?.close()
      windowsJob = undefined
      killWorkerTree()
      state = "failed"
      const failure = new Error(
        `Could not assign worker to Windows Job Object: ${errorMessage(error)}`,
      )
      readyReject(failure)
      rejectAll(failure)
      observeState()
    }
  }
  void consumeOutput(child.stdout, "stdout", observer, workerSecrets).catch(() => undefined)
  void consumeOutput(child.stderr, "stderr", observer, workerSecrets).catch(() => undefined)

  const nextEnvelope = () => ({
    schemaVersion: WORKER_PROTOCOL_VERSION,
    workerId: spec.workerId,
    sequence: outboundSequence++,
    sentAt: new Date().toISOString(),
    capabilityToken,
  })
  const send = (message: SupervisorWorkerMessage): void => {
    if (child.exitCode !== null) throw new Error(`Worker ${spec.workerId} has already exited`)
    child.send(parseSupervisorWorkerMessage(message))
  }
  if (state === "starting") {
    try {
      send({
        ...nextEnvelope(),
        type: "worker.bootstrap",
        identity: {
          schemaVersion: WORKER_PROTOCOL_VERSION,
          workerId: spec.workerId,
          workspaceId: spec.workspaceId,
          workspaceRoot: workerWorkspaceRoot,
          runId: spec.runId,
          ...(spec.attemptId ? { attemptId: spec.attemptId } : {}),
          ...(spec.parentWorkerId ? { parentWorkerId: spec.parentWorkerId } : {}),
          role: spec.role,
          processStartToken,
          hostname: identity.hostname,
          capabilityHash,
          capabilities: spec.capabilities,
          ...(spec.deadlineAt ? { deadlineAt: spec.deadlineAt } : {}),
        },
        heartbeatIntervalMs: spec.heartbeatIntervalMs,
        cancellationGraceMs: spec.requestCancellationGraceMs,
        disconnectGraceMs: spec.shutdownGraceMs,
        forceCleanupGraceMs: spec.forceCleanupGraceMs,
      })
    } catch (error) {
      state = "failed"
      const failure = new Error(`Could not bootstrap worker: ${errorMessage(error)}`)
      readyReject(failure)
      rejectAll(failure)
      observeState()
      killWorkerTree()
    }
  }

  const startupTimeout = setTimeout(() => {
    if (state !== "starting") return
    state = "failed"
    const failure = new Error(`Worker ${spec.workerId} did not become ready in time`)
    readyReject(failure)
    rejectAll(failure)
    observeState()
    killWorkerTree()
  }, spec.startupTimeoutMs)
  void ready.finally(() => clearTimeout(startupTimeout)).catch(() => undefined)

  const settlement = child.exited.then(async (code) => {
    if (state === "starting") {
      readyReject(new Error(`Worker ${spec.workerId} exited before becoming ready (code ${code})`))
    }
    exitCode = code
    exitSignal = child.signalCode ?? undefined
    state = state === "failed" ? "failed" : "exited"
    await windowsJob?.close()
    rejectAll(new Error(`Worker ${spec.workerId} exited with code ${code}`))
    observeState()
    return { exitCode: code, snapshot: snapshot() }
  })

  const forceWorkerTreeAndWait = async (reason: string): Promise<void> => {
    killWorkerTree()
    const outcome = await waitForSettlementOrTimeout(settlement, spec.forceCleanupGraceMs)
    if (outcome === "timeout" && child.exitCode === null) {
      killWorkerTree()
      if (process.platform === "win32" && windowsJob) {
        await windowsJob.close()
        windowsJob = undefined
      }
      throw new Error(
        `Worker ${spec.workerId} did not settle within the forced-cleanup grace: ${reason}`,
      )
    }
  }
  const stopWorkerDeadline = spec.deadlineAt
    ? scheduleAt(spec.deadlineAt, () => {
        if (child.exitCode !== null || state === "exited" || state === "failed") return
        const failure = new Error(`Worker ${spec.workerId} lifetime deadline expired`)
        state = "failed"
        readyReject(failure)
        rejectAll(failure)
        observeState()
        void forceWorkerTreeAndWait(failure.message).catch(() => undefined)
      })
    : undefined

  const cancel = (
    requestId: string,
    reason: string,
    cause: Extract<WorkerCancellationCause, "cancel-request" | "deadline"> = "cancel-request",
  ): void => {
    if (!requests.has(requestId) || child.exitCode !== null) return
    const boundedReason = reason.length > 0 ? reason.slice(0, 4_096) : "Cancellation requested"
    try {
      send({
        ...nextEnvelope(),
        type: "worker.cancel",
        requestId,
        cause,
        reason: boundedReason,
      })
    } catch {
      // Process settlement or the shutdown path will reject the pending request.
    }
    if (!cancellationEscalations.has(requestId)) {
      const escalationDeadline = new Date(
        Date.now() + spec.requestCancellationGraceMs,
      ).toISOString()
      let escalatedSynchronously = false
      const cancelEscalation = scheduleAt(escalationDeadline, () => {
        escalatedSynchronously = true
        cancellationEscalations.delete(requestId)
        const pending = requests.get(requestId)
        if (!pending || child.exitCode !== null) return
        state = "failed"
        const failure = new WorkerRequestCancelledError({
          cause,
          reason: `${boundedReason}; worker exceeded cancellation grace`,
          operation: pending.operation,
          requestId,
        })
        rejectAll(failure)
        observeState()
        void forceWorkerTreeAndWait(boundedReason).catch(() => undefined)
      })
      if (!escalatedSynchronously) cancellationEscalations.set(requestId, cancelEscalation)
    }
  }

  const handle: TypedWorkerHandle = {
    identity,
    ready,
    settlement,
    snapshot,
    async execute(request) {
      await ready
      if (state !== "ready" || activeRequestId) {
        throw new Error(`Worker ${spec.workerId} is not available for new work`)
      }
      const operation = WorkerOperationNameSchema.parse(request.operation)
      if (workerOperationRole(operation) !== spec.role) {
        throw new Error(`Worker role ${spec.role} cannot execute ${operation}`)
      }
      if (workerOperationCapability(operation) !== request.requiredCapability) {
        throw new Error(
          `Worker operation ${operation} requires ${workerOperationCapability(operation)}`,
        )
      }
      const capability = mergeWorkerCapabilityGrants(spec.capabilities, request.requiredCapability)
      if (!capability) {
        throw new Error(`Worker ${spec.workerId} lacks ${request.requiredCapability}`)
      }
      const payload = assertWorkerOperationAuthority(operation, request.payload, {
        identity,
        capability,
      })
      const explicitDeadline = request.deadlineAt
        ? TimestampSchema.parse(request.deadlineAt)
        : undefined
      const effectiveDeadline = earlierDeadline(
        earlierDeadline(explicitDeadline, payload.scope.deadlineAt),
        identity.deadlineAt,
      )
      if (effectiveDeadline && Date.parse(effectiveDeadline) <= Date.now()) {
        throw new WorkerRequestCancelledError({
          cause: "deadline",
          reason: "Worker request deadline expired before dispatch",
          operation,
          requestId: request.requestId ?? "not-dispatched",
        })
      }
      const requestId = request.requestId ?? randomUUID()
      activeRequestId = requestId
      lastProgressAt = undefined
      lastProgressMonotonicMs = undefined
      state = "busy"
      observeState()
      return new Promise<WorkerExecutionResult>((resolve, reject) => {
        const onAbort = (): void => cancel(requestId, errorMessage(request.signal?.reason))
        let cancelDeadline: (() => void) | undefined
        if (request.signal?.aborted) {
          activeRequestId = undefined
          state = "ready"
          reject(new Error(`Worker request was cancelled before dispatch`))
          observeState()
          return
        }
        request.signal?.addEventListener("abort", onAbort, { once: true })
        const cleanup = (): void => {
          request.signal?.removeEventListener("abort", onAbort)
          cancelDeadline?.()
          const cancelEscalation = cancellationEscalations.get(requestId)
          cancelEscalation?.()
          cancellationEscalations.delete(requestId)
        }
        requests.set(requestId, {
          operation,
          request: payload,
          resolve,
          reject,
          abort: cleanup,
          ...(request.onParentCall ? { onParentCall: request.onParentCall } : {}),
        })
        try {
          send({
            ...nextEnvelope(),
            type: "worker.execute",
            requestId,
            operation,
            requiredCapability: request.requiredCapability,
            payload,
            ...(request.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
          })
          if (effectiveDeadline) {
            cancelDeadline = scheduleAt(effectiveDeadline, () =>
              cancel(requestId, "Worker request deadline expired", "deadline"),
            )
          }
        } catch (error) {
          const pending = requests.get(requestId)
          requests.delete(requestId)
          pending?.abort?.()
          activeRequestId = undefined
          state = "ready"
          reject(error instanceof Error ? error : new Error(String(error)))
          observeState()
        }
      })
    },
    async ping(
      timeoutMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(1_000, spec.heartbeatIntervalMs * 2)),
    ) {
      await ready
      if (state !== "ready" && state !== "busy") {
        throw new Error(`Worker ${spec.workerId} cannot be pinged while state is ${state}`)
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
        throw new Error("Worker ping timeout must be a positive timer-safe integer")
      }
      const pingId = randomUUID()
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pings.delete(pingId)
          reject(new Error(`Worker ${spec.workerId} did not answer ping ${pingId}`))
        }, timeoutMs)
        pings.set(pingId, { resolve, reject, timeout })
        try {
          send({ ...nextEnvelope(), type: "worker.ping", pingId })
        } catch (error) {
          pings.delete(pingId)
          clearTimeout(timeout)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    cancel,
    async shutdown(reason, graceMs = spec.shutdownGraceMs) {
      if (child.exitCode !== null) return
      if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > MAX_TIMER_DELAY_MS) {
        throw new Error("Worker shutdown grace must be a non-negative timer-safe integer")
      }
      const boundedReason = reason.length > 0 ? reason.slice(0, 4_096) : "Shutdown requested"
      state = "closing"
      observeState()
      const deadlineAt = new Date(Date.now() + graceMs).toISOString()
      try {
        send({ ...nextEnvelope(), type: "worker.shutdown", reason: boundedReason, deadlineAt })
      } catch {
        state = "failed"
        rejectAll(new Error(`Worker shutdown IPC failed: ${boundedReason}`))
        observeState()
        await forceWorkerTreeAndWait(boundedReason)
        return
      }
      const outcome = await waitForSettlementOrTimeout(settlement, graceMs)
      if (outcome === "timeout" && child.exitCode === null) {
        state = "failed"
        rejectAll(new Error(`Worker shutdown grace expired: ${boundedReason}`))
        observeState()
        await forceWorkerTreeAndWait(boundedReason)
      }
    },
    async forceKill(reason) {
      if (child.exitCode !== null) return
      state = "closing"
      rejectAll(new Error(`Worker force-killed: ${reason}`))
      await forceWorkerTreeAndWait(reason)
    },
  }
  const unregister = processShutdownRegistry.register({
    pid: child.pid,
    cancel: (reason) => handle.shutdown(reason ?? "Command shutdown requested"),
    forceKill: (reason) => handle.forceKill(reason ?? "Command force shutdown requested"),
  })
  void settlement
    .finally(() => {
      stopWorkerDeadline?.()
      unregister()
    })
    .catch(() => undefined)
  return handle
}
