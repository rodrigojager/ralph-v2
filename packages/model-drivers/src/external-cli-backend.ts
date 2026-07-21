import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { ExecutorOutcomeSchema } from "@ralph/domain"
import type {
  CallHandle,
  ExecutionBackend,
  ExecutionBackendLimits,
  ExecutionChannel,
  ExecutionRequest,
} from "@ralph/orchestration"
import {
  type ExternalCliRuntimeConfig,
  ExternalCliRuntimeConfigSchema,
  type ProviderModelInput,
  RoleProfileLimitsSchema,
} from "@ralph/providers"
import {
  type ProcessSettlement,
  type ProcessSupervisor,
  type SupervisedProcessHandle,
  workerExecutableContentHash,
} from "@ralph/supervisor"

import {
  ExternalCliProtocolInputSchema,
  type KnownExternalOutputAdapter,
  parseExternalOutcome,
  parseExternalProtocolOutput,
} from "./external-protocol"

export type ExternalCliExecutionBackendOptions = {
  id: string
  config: ExternalCliRuntimeConfig
  supervisor?: ProcessSupervisor
  supervisorFactory?: (request: ExecutionRequest) => ProcessSupervisor
  provider?: string
  model?: string
  limits?: ExecutionBackendLimits
  environment?: Readonly<Record<string, string | undefined>>
  knownAdapters?: readonly KnownExternalOutputAdapter[]
  secretValues?: readonly string[]
  /** Parent capability binding; checked again immediately before every process spawn. */
  expectedExecutableHash?: string
  now?: () => string
}

type ActiveExternalCall = {
  controller: AbortController
  process?: SupervisedProcessHandle
  detachCommandSignal?: () => void
}

function commandCancellationReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error && signal.reason.message.trim()) return signal.reason.message
  if (typeof signal.reason === "string" && signal.reason.trim()) return signal.reason
  return "Execution was cancelled by the command"
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function isolatedCwd(configured: string): Promise<{ root: string; cwd: string }> {
  const createdRoot = await mkdtemp(join(tmpdir(), "ralph-external-cli-"))
  try {
    const root = await realpath(createdRoot)
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("External CLI isolation root is not a regular canonical directory")
    }
    const requestedCwd = resolve(root, configured)
    if (!contained(root, requestedCwd)) {
      throw new Error("External CLI cwd escapes its isolated working directory")
    }
    await mkdir(requestedCwd, { recursive: true })
    const cwd = await realpath(requestedCwd)
    const cwdInfo = await lstat(cwd)
    if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink() || !contained(root, cwd)) {
      throw new Error("External CLI cwd is not a contained canonical directory")
    }
    return { root, cwd }
  } catch (error) {
    await rm(createdRoot, { recursive: true, force: true })
    throw error
  }
}

function expandArguments(
  source: readonly string[],
  values: Readonly<Record<string, string>>,
): string[] {
  return source.map((argument) =>
    argument.replace(/\{\{([a-z_]+)\}\}/g, (_match, name: string) => {
      const value = values[name]
      if (value === undefined) throw new Error(`Unknown external CLI argument template: ${name}`)
      return value
    }),
  )
}

function rawOutputLimit(outputLimit: number): number {
  return Math.max(outputLimit, Math.min(256 * 1_024 * 1_024, outputLimit * 4))
}

export type ExternalCliExecutionFailureKind = "cancelled" | "transient"

export class ExternalCliExecutionError extends Error {
  constructor(
    readonly kind: ExternalCliExecutionFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ExternalCliExecutionError"
  }
}

function processFailure(
  settlement: ProcessSettlement,
): { kind: ExternalCliExecutionFailureKind; message: string } | undefined {
  if (settlement.cancelled)
    return { kind: "cancelled", message: "External CLI execution was cancelled" }
  if (settlement.timedOut) return { kind: "transient", message: "External CLI execution timed out" }
  if (settlement.signal) {
    return {
      kind: "transient",
      message: `External CLI process was terminated by ${settlement.signal}`,
    }
  }
  if (settlement.error) return { kind: "transient", message: settlement.error }
  if (settlement.exitCode !== 0) {
    return {
      kind: "transient",
      message: `External CLI exited with status ${settlement.exitCode ?? "unavailable"}`,
    }
  }
  return undefined
}

export function validateExternalCliExecutionConfig(
  input: ExternalCliRuntimeConfig,
  knownAdapters: readonly KnownExternalOutputAdapter[] = [],
): ExternalCliRuntimeConfig {
  const config = ExternalCliRuntimeConfigSchema.parse(input)
  if (config.capabilities.toolCalling === "ralph" && config.adapter !== "protocol") {
    throw new Error("Ralph-governed external CLI tools require the versioned protocol adapter")
  }
  if (config.mutationMode !== "read-only") {
    throw new Error(
      "Direct external CLI workspace mutation is unavailable until an enforceable sandbox/reconciliation adapter is configured",
    )
  }
  if (config.capabilities.streaming) {
    throw new Error(
      "External CLI v1 transports one bounded JSON result; normalized streaming must be declared unavailable",
    )
  }
  if (config.capabilities.usage !== "unavailable") {
    throw new Error(
      "External CLI v1 has no versioned usage frame; usage must be declared unavailable",
    )
  }
  if (config.adapter === "known-output") {
    const matches = knownAdapters.filter((adapter) => adapter.id === config.adapterId)
    if (matches.length !== 1) {
      throw new Error(
        `Known external output adapter is unavailable or ambiguous: ${config.adapterId}`,
      )
    }
  }
  return config
}

/** One-shot supervised process adapter, optionally repeated for the v1 Ralph tool protocol. */
export class ExternalCliExecutionBackend implements ExecutionBackend {
  readonly id: string
  readonly #config: ExternalCliRuntimeConfig
  readonly #active = new Map<string, ActiveExternalCall>()
  readonly #environment: Readonly<Record<string, string | undefined>>
  readonly #now: () => string
  readonly #limits: ExecutionBackendLimits

  constructor(private readonly options: ExternalCliExecutionBackendOptions) {
    if (!options.id.trim()) throw new Error("External CLI backend id is required")
    this.id = options.id
    this.#config = validateExternalCliExecutionConfig(options.config, options.knownAdapters ?? [])
    this.#environment = options.environment ?? process.env
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#limits = RoleProfileLimitsSchema.parse(options.limits ?? {})
    if (
      options.expectedExecutableHash !== undefined &&
      !/^[a-f0-9]{64}$/.test(options.expectedExecutableHash)
    ) {
      throw new Error("External CLI expected executable hash must be a lowercase SHA-256")
    }
    if ((options.supervisor === undefined) === (options.supervisorFactory === undefined)) {
      throw new Error("External CLI backend requires exactly one supervisor or supervisor factory")
    }
  }

  capabilities() {
    return {
      streaming: this.#config.capabilities.streaming,
      toolCalling: this.#config.capabilities.toolCalling,
      // The supervisor can always terminate the process tree, even when the
      // child declares no cooperative cancellation protocol.
      cancellation: true,
      usage: this.#config.capabilities.usage,
    }
  }

  limits(): ExecutionBackendLimits {
    return structuredClone(this.#limits)
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    if (this.#active.has(request.modelCallId)) {
      throw new Error(`External CLI backend call is already active: ${request.modelCallId}`)
    }
    const active: ActiveExternalCall = { controller: new AbortController() }
    this.#active.set(request.modelCallId, active)
    if (request.signal) {
      const cancel = (): void => {
        void this.#cancelActive(
          request.modelCallId,
          commandCancellationReason(request.signal as AbortSignal),
        ).catch(() => undefined)
      }
      request.signal.addEventListener("abort", cancel, { once: true })
      active.detachCommandSignal = () => request.signal?.removeEventListener("abort", cancel)
      if (request.signal.aborted) cancel()
    }
    const outcome = this.#run(request, channel, active).finally(() => {
      active.detachCommandSignal?.()
      this.#active.delete(request.modelCallId)
    })
    void outcome.catch(() => undefined)
    return { id: request.modelCallId, outcome }
  }

  async cancel(handle: CallHandle, reason: string): Promise<void> {
    await this.#cancelActive(handle.id, reason)
  }

  async #cancelActive(callId: string, reason: string): Promise<void> {
    const active = this.#active.get(callId)
    if (!active) return
    active.controller.abort(new Error(reason))
    await active.process?.cancel(reason)
  }

  async #run(request: ExecutionRequest, channel: ExecutionChannel, active: ActiveExternalCall) {
    if (active.controller.signal.aborted) throw active.controller.signal.reason
    const isolation = await isolatedCwd(this.#config.cwd)
    if (active.controller.signal.aborted) {
      await rm(isolation.root, { recursive: true, force: true })
      throw active.controller.signal.reason
    }
    const cwd = isolation.cwd
    const supervisor = this.options.supervisorFactory?.(request) ?? this.options.supervisor
    if (!supervisor) throw new Error("External CLI process supervisor is unavailable")
    const history: ProviderModelInput[] = []
    const observedCallIds = new Set<string>()
    const observedItemIds = new Set<string>()
    try {
      const tools = this.#config.capabilities.toolCalling === "ralph" ? await channel.tools() : []
      const maximumTurns =
        this.#config.capabilities.toolCalling === "ralph"
          ? Math.max(1, channel.stats().maximumToolCalls + 1)
          : 1
      await channel.emit({
        type: "external.cli.started",
        payload: {
          backendId: this.id,
          adapter: this.#config.adapter,
          mutationMode: this.#config.mutationMode,
          isolation: "empty-temporary-cwd",
          maximumTurns,
        },
      })
      for (let turn = 1; turn <= maximumTurns; turn += 1) {
        if (active.controller.signal.aborted) throw active.controller.signal.reason
        const input = ExternalCliProtocolInputSchema.parse({
          schemaVersion: 1,
          protocol: "ralph.execution.external-cli.v1",
          call: {
            runId: request.runId,
            documentId: request.documentId,
            taskId: request.taskId,
            attemptId: request.attemptId,
            modelCallId: request.modelCallId,
            callOrdinal: request.callOrdinal,
          },
          workspaceRoot: ".",
          protectedPaths: request.protectedPaths,
          tools,
          history,
          context: {
            manifest: request.contextManifest,
            resources: request.contextBundle.resources,
            truncations: request.contextBundle.truncations,
            canonicalJson: request.contextBundle.canonicalJson,
          },
        })
        const processId = `${request.modelCallId}-external-${turn}`
        await channel.reserveModelCall({ callId: processId, turn })
        const args = expandArguments(this.#config.args, {
          run_id: request.runId,
          document_id: request.documentId,
          task_id: request.taskId,
          attempt_id: request.attemptId,
          model_call_id: request.modelCallId,
          provider: this.options.provider ?? "external-cli",
          model: this.options.model ?? "external-cli",
          turn: String(turn),
          workspace: isolation.root,
        })
        if (this.options.expectedExecutableHash) {
          const executableHash = workerExecutableContentHash(this.#config.executable)
          if (executableHash !== this.options.expectedExecutableHash) {
            throw new Error("External CLI executable changed after its capability was granted")
          }
        }
        active.process = await supervisor.start({
          executable: this.#config.executable,
          args,
          cwd,
          expectedCanonicalCwd: cwd,
          environment: this.#environment,
          environmentRefs: this.#config.environmentRefs,
          shell: false,
          timeoutMs: this.#config.timeoutMs,
          outputLimitBytes: this.#config.outputLimitBytes,
          rawOutputLimitBytes: rawOutputLimit(this.#config.outputLimitBytes),
          maxInputBytes: 16 * 1_024 * 1_024,
          stdin: `${JSON.stringify(input)}\n`,
          ...(this.options.expectedExecutableHash
            ? { expectedExecutableSha256: this.options.expectedExecutableHash }
            : {}),
          signal: active.controller.signal,
          onOutput: async (stream, delta) => {
            await channel.emit({
              type: "external.cli.output.delta",
              level: stream === "stderr" ? "warning" : "info",
              payload: { processId, turn, stream, delta },
            })
          },
        })
        const settlement = await active.process.settlement
        delete active.process
        await channel.emit({
          type: "external.cli.settled",
          level: processFailure(settlement) ? "error" : "info",
          payload: {
            processId,
            turn,
            exitCode: settlement.exitCode,
            timedOut: settlement.timedOut,
            cancelled: settlement.cancelled,
            treeTerminated: settlement.treeTerminated,
            outputTruncated: settlement.outputTruncated,
            rawOutputTruncated: settlement.rawOutputTruncated,
            outputRefs: settlement.outputRefs,
            durationMs: settlement.durationMs,
          },
        })
        const failure = processFailure(settlement)
        if (failure) throw new ExternalCliExecutionError(failure.kind, failure.message)

        if (this.#config.adapter === "protocol") {
          const message = parseExternalProtocolOutput(settlement.stdout)
          if (message.kind === "outcome") {
            return ExecutorOutcomeSchema.parse({
              ...message.outcome,
              reportedAt: this.#now(),
            })
          }
          if (this.#config.capabilities.toolCalling !== "ralph") {
            throw new Error("External CLI requested Ralph tools without declaring that capability")
          }
          for (const call of message.toolCalls) {
            if (observedCallIds.has(call.callId) || observedItemIds.has(call.itemId)) {
              throw new Error("External CLI repeated a tool call identity across protocol turns")
            }
            observedCallIds.add(call.callId)
            observedItemIds.add(call.itemId)
            history.push({ type: "function-call", ...call })
            const result = await channel.executeTool(call, { signal: active.controller.signal })
            history.push({
              type: "function-call-output",
              callId: call.callId,
              output: result.output,
            })
          }
          continue
        }
        const parsed = await parseExternalOutcome({
          adapter: this.#config.adapter,
          ...(this.#config.adapterId ? { adapterId: this.#config.adapterId } : {}),
          stdout: settlement.stdout,
          stderr: settlement.stderr,
          exitCode: settlement.exitCode ?? -1,
          ...(settlement.signal ? { signal: settlement.signal } : {}),
          timedOut: settlement.timedOut,
          cancelled: settlement.cancelled,
          ...(this.options.knownAdapters ? { knownAdapters: this.options.knownAdapters } : {}),
          ...(this.options.secretValues ? { secrets: this.options.secretValues } : {}),
          now: this.#now,
        })
        return ExecutorOutcomeSchema.parse({ ...parsed, reportedAt: this.#now() })
      }
      throw new Error(`External CLI exceeded its bounded tool loop of ${maximumTurns} turns`)
    } finally {
      await rm(isolation.root, { recursive: true, force: true })
    }
  }
}
