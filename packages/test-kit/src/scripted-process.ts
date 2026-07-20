import { type ExecutorOutcome, ExecutorOutcomeSchema } from "@ralph-next/domain"
import { type ProviderToolCall, ProviderToolCallSchema } from "@ralph-next/providers"
import type {
  PidLiveness,
  ProcessIdentity,
  ProcessOutputChunk,
  ProcessSettlement,
  ProcessSupervisor,
  SupervisedProcessHandle,
  SupervisedProcessRequest,
} from "@ralph-next/supervisor"

export type ScriptedProcessOutput = {
  stream: "stdout" | "stderr"
  text: string
  at?: string
}

export type ScriptedProcessStep = {
  pid?: number
  stdout?: string
  stderr?: string
  rawStdout?: string
  rawStderr?: string
  exitCode?: number
  signal?: string
  timedOut?: boolean
  cancelled?: boolean
  treeTerminated?: boolean
  outputTruncated?: boolean
  rawOutputTruncated?: boolean
  outputRefs?: readonly string[]
  durationMs?: number
  chunks?: readonly ScriptedProcessOutput[]
  error?: string
  startFailure?: Error | string
  /** Emits configured chunks but leaves settlement pending until cancel/forceKill/release. */
  freeze?: boolean
}

type ActiveProcess = {
  pid: number
  step: ScriptedProcessStep
  request: SupervisedProcessRequest
  settled: boolean
  settle(overrides?: Partial<ScriptedProcessStep>): void
  reject(error: unknown): void
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function positivePid(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid scripted PID: ${value}`)
  return value
}

function settlement(
  request: SupervisedProcessRequest,
  step: ScriptedProcessStep,
  pid: number,
): ProcessSettlement {
  const stdoutFromChunks = (step.chunks ?? [])
    .filter((chunk) => chunk.stream === "stdout")
    .map((chunk) => chunk.text)
    .join("")
  const stderrFromChunks = (step.chunks ?? [])
    .filter((chunk) => chunk.stream === "stderr")
    .map((chunk) => chunk.text)
    .join("")
  const stdout = step.stdout ?? stdoutFromChunks
  const stderr = step.stderr ?? stderrFromChunks
  const cancelled = step.cancelled ?? false
  const timedOut = step.timedOut ?? false
  const signal = step.signal
  return {
    pid,
    argv: [request.executable, ...request.args],
    cwd: request.cwd,
    ...(!cancelled && !timedOut && !signal ? { exitCode: step.exitCode ?? 0 } : {}),
    ...(signal ? { signal } : {}),
    stdout,
    stderr,
    rawStdout: step.rawStdout ?? stdout,
    rawStderr: step.rawStderr ?? stderr,
    stdoutBytes: byteLength(stdout),
    stderrBytes: byteLength(stderr),
    outputTruncated: step.outputTruncated ?? false,
    rawOutputTruncated: step.rawOutputTruncated ?? false,
    timedOut,
    cancelled,
    treeTerminated: step.treeTerminated ?? (cancelled || timedOut || Boolean(signal)),
    outputRefs: [...(step.outputRefs ?? [`scripted-process:${pid}:stdout`])],
    durationMs: step.durationMs ?? 1,
    ...(step.error ? { error: step.error } : {}),
  }
}

async function emitChunks(
  request: SupervisedProcessRequest,
  step: ScriptedProcessStep,
): Promise<void> {
  const configured = step.chunks ?? [
    ...(step.stdout ? [{ stream: "stdout" as const, text: step.stdout }] : []),
    ...(step.stderr ? [{ stream: "stderr" as const, text: step.stderr }] : []),
  ]
  const totals = { stdout: 0, stderr: 0 }
  for (const [index, chunk] of configured.entries()) {
    const bytes = byteLength(chunk.text)
    totals[chunk.stream] += bytes
    await request.onOutput?.(chunk.stream, chunk.text)
    const outputChunk: ProcessOutputChunk = {
      sequence: index + 1,
      stream: chunk.stream,
      text: chunk.text,
      bytes,
      totalBytes: totals[chunk.stream],
      at: chunk.at ?? "2026-01-01T00:00:00.000Z",
    }
    await request.onChunk?.(outputChunk)
  }
}

/** ProcessSupervisor fake used by generic/protocol CLIs and process lifecycle tests. */
export class ScriptedProcessSupervisor implements ProcessSupervisor {
  readonly requests: SupervisedProcessRequest[] = []
  readonly cancellations: Array<{ pid: number; kind: "cancel" | "force-kill"; reason?: string }> =
    []
  readonly #queue: ScriptedProcessStep[]
  readonly #active: ActiveProcess[] = []
  readonly #availableExecutables: ReadonlySet<string> | undefined
  #nextPid: number

  constructor(
    steps: readonly ScriptedProcessStep[],
    options: { firstPid?: number; availableExecutables?: readonly string[] } = {},
  ) {
    this.#queue = [...steps]
    this.#nextPid = positivePid(options.firstPid ?? 41_000)
    this.#availableExecutables = options.availableExecutables
      ? new Set(options.availableExecutables)
      : undefined
  }

  async start(request: SupervisedProcessRequest): Promise<SupervisedProcessHandle> {
    this.requests.push(request)
    const step = this.#queue.shift()
    if (!step) throw new Error("Scripted process supervisor queue exhausted")
    if (step.startFailure) {
      throw typeof step.startFailure === "string" ? new Error(step.startFailure) : step.startFailure
    }
    const pid = positivePid(step.pid ?? this.#nextPid)
    this.#nextPid = Math.max(this.#nextPid + 1, pid + 1)
    let resolveSettlement: ((value: ProcessSettlement) => void) | undefined
    let rejectSettlement: ((error: unknown) => void) | undefined
    const settlementPromise = new Promise<ProcessSettlement>((resolvePromise, rejectPromise) => {
      resolveSettlement = resolvePromise
      rejectSettlement = rejectPromise
    })
    const active: ActiveProcess = {
      pid,
      step,
      request,
      settled: false,
      settle: (overrides = {}) => {
        if (active.settled) return
        active.settled = true
        resolveSettlement?.(settlement(request, { ...step, ...overrides }, pid))
      },
      reject: (error) => {
        if (active.settled) return
        active.settled = true
        rejectSettlement?.(error)
      },
    }
    this.#active.push(active)
    const handle: SupervisedProcessHandle = {
      pid,
      settlement: settlementPromise,
      cancel: async (reason) => {
        this.cancellations.push({ pid, kind: "cancel", ...(reason ? { reason } : {}) })
        active.settle({
          cancelled: true,
          treeTerminated: true,
          ...(reason ? { error: reason } : {}),
        })
      },
      forceKill: async (reason) => {
        this.cancellations.push({ pid, kind: "force-kill", ...(reason ? { reason } : {}) })
        active.settle({
          signal: "SIGKILL",
          treeTerminated: true,
          ...(reason ? { error: reason } : {}),
        })
      },
    }
    if (request.signal) {
      request.signal.addEventListener("abort", () => void handle.cancel("request signal aborted"), {
        once: true,
      })
      if (request.signal.aborted) await handle.cancel("request signal aborted")
    }
    void (async () => {
      try {
        await emitChunks(request, step)
        if (!step.freeze) active.settle()
      } catch (error) {
        active.reject(error)
      }
    })()
    void settlementPromise
      .finally(() => {
        const index = this.#active.indexOf(active)
        if (index >= 0) this.#active.splice(index, 1)
      })
      .catch(() => undefined)
    return handle
  }

  async run(request: SupervisedProcessRequest): Promise<ProcessSettlement> {
    return (await this.start(request)).settlement
  }

  which(executable: string): string | null {
    return this.#availableExecutables && !this.#availableExecutables.has(executable)
      ? null
      : executable
  }

  releaseNextFrozen(overrides: Partial<ScriptedProcessStep> = {}): number {
    const active = this.#active.find((candidate) => candidate.step.freeze && !candidate.settled)
    if (!active) throw new Error("No frozen scripted process is waiting")
    active.settle({ freeze: false, ...overrides })
    return active.pid
  }

  activePids(): readonly number[] {
    return this.#active.filter((active) => !active.settled).map((active) => active.pid)
  }

  remaining(): number {
    return this.#queue.length
  }
}

/** Semantic name for a ProcessSupervisor used as an external CLI fixture. */
export class ScriptedCliSupervisor extends ScriptedProcessSupervisor {}

export function scriptedCliOutcomeStep(
  outcomeInput: ExecutorOutcome,
  overrides: Omit<ScriptedProcessStep, "stdout"> = {},
): ScriptedProcessStep {
  const outcome = ExecutorOutcomeSchema.parse(outcomeInput)
  return {
    ...overrides,
    stdout: JSON.stringify({
      schemaVersion: 1,
      protocol: "ralph.execution.external-cli.v1",
      kind: "outcome",
      outcome,
    }),
  }
}

export function scriptedCliToolCallsStep(
  calls: readonly ProviderToolCall[],
  overrides: Omit<ScriptedProcessStep, "stdout"> = {},
): ScriptedProcessStep {
  return {
    ...overrides,
    stdout: JSON.stringify({
      schemaVersion: 1,
      protocol: "ralph.execution.external-cli.v1",
      kind: "tool-calls",
      toolCalls: calls.map((call) => ProviderToolCallSchema.parse(call)),
    }),
  }
}

export function scriptedCliMalformedStep(output = "{not-json"): ScriptedProcessStep {
  return { stdout: output }
}

export function scriptedCliSilenceStep(): ScriptedProcessStep {
  return { stdout: "", stderr: "" }
}

export function scriptedCliFreezeStep(pid?: number): ScriptedProcessStep {
  return { ...(pid === undefined ? {} : { pid }), freeze: true }
}

export function scriptedProcessHeartbeatStep(count: number, pid?: number): ScriptedProcessStep {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("heartbeat count must be a non-negative safe integer")
  }
  return {
    ...(pid === undefined ? {} : { pid }),
    chunks: Array.from({ length: count }, (_, index) => ({
      stream: "stderr" as const,
      text: `${JSON.stringify({ type: "heartbeat", sequence: index + 1 })}\n`,
    })),
  }
}

export type ScriptedLeaseOwnerProbeResult =
  | { status: "alive"; reason: string; observedProcessStartToken?: string }
  | { status: "dead"; reason: string }
  | { status: "unreachable"; reason: string }
  | { status: "identity-mismatch"; reason: string; observedProcessStartToken: string }

type ScriptedProcessRecord = ProcessIdentity & PidLiveness

/** Deterministic process table whose reuse() keeps a PID while replacing its start token. */
export class ScriptedProcessTable {
  readonly #records = new Map<number, ScriptedProcessRecord>()
  readonly hostname: string

  constructor(hostname = "scripted-host") {
    this.hostname = hostname
  }

  register(identity: ProcessIdentity, liveness: Partial<PidLiveness> = {}): void {
    this.#records.set(positivePid(identity.pid), {
      ...identity,
      alive: liveness.alive ?? true,
      inaccessible: liveness.inaccessible ?? false,
    })
  }

  reuse(pid: number, processStartToken: string): ProcessIdentity {
    const current = this.#records.get(positivePid(pid))
    const identity = {
      pid,
      processStartToken,
      hostname: current?.hostname ?? this.hostname,
    }
    this.register(identity)
    return identity
  }

  exit(pid: number): void {
    const current = this.#records.get(positivePid(pid))
    if (current) this.#records.set(pid, { ...current, alive: false, inaccessible: false })
  }

  makeInaccessible(pid: number): void {
    const current = this.#records.get(positivePid(pid))
    if (!current) throw new Error(`Unknown scripted PID: ${pid}`)
    this.#records.set(pid, { ...current, alive: true, inaccessible: true })
  }

  probePidLiveness(pid: number): PidLiveness {
    const current = this.#records.get(pid)
    return current
      ? { alive: current.alive, inaccessible: current.inaccessible }
      : { alive: false, inaccessible: false }
  }

  async processStartToken(pid: number): Promise<string> {
    const current = this.#records.get(pid)
    if (!current?.alive) throw new Error(`Scripted PID is not alive: ${pid}`)
    if (current.inaccessible) throw new Error(`Scripted PID identity is inaccessible: ${pid}`)
    return current.processStartToken
  }

  async captureProcessIdentity(pid: number): Promise<ProcessIdentity> {
    const current = this.#records.get(pid)
    if (!current?.alive) throw new Error(`Scripted PID is not alive: ${pid}`)
    return {
      pid: current.pid,
      processStartToken: await this.processStartToken(pid),
      hostname: current.hostname,
    }
  }

  async probeOwner(owner: ProcessIdentity): Promise<ScriptedLeaseOwnerProbeResult> {
    if (owner.hostname.toLocaleLowerCase("und") !== this.hostname.toLocaleLowerCase("und")) {
      return {
        status: "unreachable",
        reason: `owner host ${owner.hostname} cannot be probed from ${this.hostname}`,
      }
    }
    const liveness = this.probePidLiveness(owner.pid)
    if (!liveness.alive && !liveness.inaccessible) {
      return { status: "dead", reason: `PID ${owner.pid} is not present` }
    }
    if (liveness.inaccessible) {
      return { status: "alive", reason: `PID ${owner.pid} identity is inaccessible` }
    }
    const observedProcessStartToken = await this.processStartToken(owner.pid)
    if (observedProcessStartToken !== owner.processStartToken) {
      return {
        status: "identity-mismatch",
        observedProcessStartToken,
        reason: `PID ${owner.pid} was reused by another process identity`,
      }
    }
    return {
      status: "alive",
      observedProcessStartToken,
      reason: `PID ${owner.pid} still matches its process identity`,
    }
  }
}
