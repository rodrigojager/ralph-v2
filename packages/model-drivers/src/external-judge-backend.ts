import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { type JudgeOutput, JudgeOutputSchema } from "@ralph/domain"
import type {
  JudgeBackend,
  JudgeBackendCapabilities,
  JudgeCallHandle,
  JudgeEventSink,
  JudgeRequest,
} from "@ralph/evaluation"
import { type ExternalCliRuntimeConfig, ExternalCliRuntimeConfigSchema } from "@ralph/providers"
import type {
  ProcessSettlement,
  ProcessSupervisor,
  SupervisedProcessHandle,
} from "@ralph/supervisor"
import { workerExecutableContentHash } from "@ralph/supervisor"
import { z } from "zod"

export const JUDGE_OUTPUT_JSON_ADAPTER_ID = "judge-output-json-v1"
const MAX_JUDGE_OUTPUT_BYTES = 4 * 1024 * 1024

export const ExternalCliJudgeInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: z.literal("ralph.evaluation.external-cli.v1"),
    call: z
      .object({
        callId: z.string().trim().min(1),
        kind: z.enum(["external", "self"]),
        evidenceBundleId: z.string().trim().min(1),
      })
      .strict(),
    prompt: z
      .object({
        system: z.string().min(1),
        user: z.string().min(1),
      })
      .strict(),
    bundle: z.record(z.string(), z.unknown()),
    outputContract: z.literal(JUDGE_OUTPUT_JSON_ADAPTER_ID),
  })
  .strict()
export type ExternalCliJudgeInput = z.infer<typeof ExternalCliJudgeInputSchema>

export type ParseExternalJudgeOutputInput = {
  stdout: string
  stderr: string
  exitCode: number
  signal?: string
  timedOut?: boolean
  cancelled?: boolean
}

export type ExternalCliJudgeFailureKind = "cancelled" | "transient" | "candidate-failed"

/**
 * Classifies only transport/process failures that are safe for command-owned
 * fallback policy. Invalid judge output remains an ordinary error so a
 * malformed or contradictory assessment can never silently select another
 * judge profile.
 */
export class ExternalCliJudgeError extends Error {
  constructor(
    readonly kind: ExternalCliJudgeFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ExternalCliJudgeError"
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/** Built-in JSON v1 adapter. It validates an assessment claim and never decides completion. */
export function parseExternalJudgeOutput(input: ParseExternalJudgeOutputInput): JudgeOutput {
  if (byteLength(input.stdout) > MAX_JUDGE_OUTPUT_BYTES) {
    throw new Error("External judge stdout exceeds the output adapter limit")
  }
  if (byteLength(input.stderr) > MAX_JUDGE_OUTPUT_BYTES) {
    throw new Error("External judge stderr exceeds the output adapter limit")
  }
  if (input.cancelled) throw new Error("External judge execution was cancelled")
  if (input.timedOut) throw new Error("External judge execution timed out")
  if (input.signal) throw new Error(`External judge process was terminated by ${input.signal}`)
  if (input.exitCode !== 0) throw new Error(`External judge exited with status ${input.exitCode}`)
  let value: unknown
  try {
    value = JSON.parse(input.stdout)
  } catch (cause) {
    throw new Error("External judge output is not one JudgeOutput JSON v1 object", { cause })
  }
  return JudgeOutputSchema.parse(value)
}

export type ExternalCliJudgeBackendOptions = {
  id: string
  config: ExternalCliRuntimeConfig
  supervisor: ProcessSupervisor
  environment?: Readonly<Record<string, string | undefined>>
  /** Parent capability binding; checked again immediately before process spawn. */
  expectedExecutableHash?: string
}

type ActiveExternalJudgeCall = {
  controller: AbortController
  process?: SupervisedProcessHandle
  detachSignal?: () => void
}

type ExternalJudgeCallResult = {
  output: JudgeOutput
  rawResponseRef?: string
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function isolatedCwd(configured: string): Promise<{ root: string; cwd: string }> {
  const createdRoot = await mkdtemp(join(tmpdir(), "ralph-external-judge-"))
  try {
    const root = await realpath(createdRoot)
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error("External judge CLI isolation root is not a regular canonical directory")
    }
    const requestedCwd = resolve(root, configured)
    if (!contained(root, requestedCwd)) {
      throw new Error("External judge CLI cwd escapes its isolated working directory")
    }
    await mkdir(requestedCwd, { recursive: true })
    const cwd = await realpath(requestedCwd)
    const cwdInfo = await lstat(cwd)
    if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink() || !contained(root, cwd)) {
      throw new Error("External judge CLI cwd is not a contained canonical directory")
    }
    return { root, cwd }
  } catch (error) {
    await rm(createdRoot, { recursive: true, force: true })
    throw error
  }
}

function validateConfig(input: ExternalCliRuntimeConfig): ExternalCliRuntimeConfig {
  const config = ExternalCliRuntimeConfigSchema.parse(input)
  if (config.mutationMode !== "read-only" || config.capabilities.toolCalling !== "unavailable") {
    throw new Error("External judge CLI must be read-only and declare tool calling unavailable")
  }
  if (config.capabilities.streaming || config.capabilities.usage !== "unavailable") {
    throw new Error(
      "External judge CLI v1 requires bounded non-streaming output and unavailable usage",
    )
  }
  if (config.adapter !== "known-output" || config.adapterId !== JUDGE_OUTPUT_JSON_ADAPTER_ID) {
    throw new Error(`External judge CLI v1 requires adapter ${JUDGE_OUTPUT_JSON_ADAPTER_ID}`)
  }
  return config
}

function settlementFailure(
  settlement: ProcessSettlement,
): { kind: ExternalCliJudgeFailureKind; message: string } | undefined {
  if (settlement.cancelled) {
    return { kind: "cancelled", message: "External judge execution was cancelled" }
  }
  if (settlement.timedOut) {
    return { kind: "transient", message: "External judge execution timed out" }
  }
  if (settlement.signal) {
    return {
      kind: "transient",
      message: `External judge process was terminated by ${settlement.signal}`,
    }
  }
  if (settlement.error) return { kind: "transient", message: settlement.error }
  if (settlement.exitCode !== 0) {
    return {
      kind: "candidate-failed",
      message: `External judge exited with status ${settlement.exitCode ?? "unavailable"}`,
    }
  }
  return undefined
}

function rawOutputLimit(outputLimit: number): number {
  return Math.max(outputLimit, Math.min(256 * 1024 * 1024, outputLimit * 4))
}

/** Executes an isolated one-shot judge protocol with no workspace path and no tools. */
export class ExternalCliJudgeBackend implements JudgeBackend {
  readonly id: string
  readonly #config: ExternalCliRuntimeConfig
  readonly #active = new Map<string, ActiveExternalJudgeCall>()
  readonly #environment: Readonly<Record<string, string | undefined>>

  constructor(private readonly options: ExternalCliJudgeBackendOptions) {
    if (!options.id.trim()) throw new Error("External judge backend id is required")
    this.id = options.id
    this.#config = validateConfig(options.config)
    this.#environment = options.environment ?? process.env
    if (
      options.expectedExecutableHash !== undefined &&
      !/^[a-f0-9]{64}$/.test(options.expectedExecutableHash)
    ) {
      throw new Error("External judge executable binding must be a SHA-256 hash")
    }
  }

  capabilities(): JudgeBackendCapabilities {
    return {
      streaming: false,
      cancellation: true,
      structuredOutput: true,
      usage: "unavailable",
      toolCalling: "unavailable",
      mutationMode: "read-only",
    }
  }

  async start(request: JudgeRequest, sink: JudgeEventSink): Promise<JudgeCallHandle> {
    if (this.#active.has(request.callId)) {
      throw new Error(`External judge call is already active: ${request.callId}`)
    }
    const active: ActiveExternalJudgeCall = { controller: new AbortController() }
    this.#active.set(request.callId, active)
    if (request.signal) {
      const cancel = (): void => {
        const reason =
          request.signal?.reason instanceof Error
            ? request.signal.reason.message
            : "External judge evaluation was cancelled"
        void this.#cancel(request.callId, reason).catch(() => undefined)
      }
      request.signal.addEventListener("abort", cancel, { once: true })
      active.detachSignal = () => request.signal?.removeEventListener("abort", cancel)
      if (request.signal.aborted) cancel()
    }
    const operation = this.#run(request, sink, active).finally(() => {
      active.detachSignal?.()
      this.#active.delete(request.callId)
    })
    const outcome = operation.then((result) => result.output)
    const rawResponseRef = operation.then(
      (result) => result.rawResponseRef,
      () => undefined,
    )
    void operation.catch(() => undefined)
    return { id: request.callId, outcome, rawResponseRef }
  }

  async cancel(handle: JudgeCallHandle, reason: string): Promise<void> {
    await this.#cancel(handle.id, reason)
  }

  async #cancel(callId: string, reason: string): Promise<void> {
    const active = this.#active.get(callId)
    if (!active) return
    active.controller.abort(new Error(reason))
    await active.process?.cancel(reason)
  }

  async #run(
    request: JudgeRequest,
    sink: JudgeEventSink,
    active: ActiveExternalJudgeCall,
  ): Promise<ExternalJudgeCallResult> {
    if (active.controller.signal.aborted) throw active.controller.signal.reason
    const isolation = await isolatedCwd(this.#config.cwd)
    try {
      const input = ExternalCliJudgeInputSchema.parse({
        schemaVersion: 1,
        protocol: "ralph.evaluation.external-cli.v1",
        call: {
          callId: request.callId,
          kind: request.kind,
          evidenceBundleId: request.evidenceBundleId,
        },
        prompt: request.prompt,
        bundle: request.bundle,
        outputContract: JUDGE_OUTPUT_JSON_ADAPTER_ID,
      })
      if (this.options.expectedExecutableHash) {
        const executableHash = workerExecutableContentHash(this.#config.executable)
        if (executableHash !== this.options.expectedExecutableHash) {
          throw new Error("External judge executable changed after its capability was granted")
        }
      }
      await sink.emit({
        type: "judge.external.started",
        level: "info",
        payload: { callId: request.callId, backendId: this.id, isolation: "empty-temporary-cwd" },
      })
      try {
        active.process = await this.options.supervisor.start({
          executable: this.#config.executable,
          args: this.#config.args,
          cwd: isolation.cwd,
          expectedCanonicalCwd: isolation.cwd,
          environment: this.#environment,
          environmentRefs: this.#config.environmentRefs,
          shell: false,
          timeoutMs: this.#config.timeoutMs,
          outputLimitBytes: this.#config.outputLimitBytes,
          rawOutputLimitBytes: rawOutputLimit(this.#config.outputLimitBytes),
          maxInputBytes: 1024 * 1024,
          stdin: `${JSON.stringify(input)}\n`,
          ...(this.options.expectedExecutableHash
            ? { expectedExecutableSha256: this.options.expectedExecutableHash }
            : {}),
          signal: active.controller.signal,
          onOutput: (stream, delta) =>
            sink.emit({
              type: "judge.external.output.delta",
              level: stream === "stderr" ? "warning" : "info",
              payload: { callId: request.callId, stream, delta },
            }),
        })
      } catch (cause) {
        if (active.controller.signal.aborted) {
          throw new ExternalCliJudgeError("cancelled", "External judge execution was cancelled", {
            cause,
          })
        }
        throw new ExternalCliJudgeError(
          "transient",
          "External judge process could not be started",
          { cause },
        )
      }
      const settlement = await active.process.settlement
      delete active.process
      const failure = settlementFailure(settlement)
      await sink.emit({
        type: "judge.external.settled",
        level: failure ? "error" : "info",
        payload: {
          callId: request.callId,
          exitCode: settlement.exitCode,
          durationMs: settlement.durationMs,
          outputRefs: settlement.outputRefs,
          outputTruncated: settlement.outputTruncated,
          rawOutputTruncated: settlement.rawOutputTruncated,
        },
      })
      if (failure) throw new ExternalCliJudgeError(failure.kind, failure.message)
      const rawResponseRef = settlement.outputRefs.find((reference) => reference.trim())
      return {
        output: parseExternalJudgeOutput({
          stdout: settlement.stdout,
          stderr: settlement.stderr,
          exitCode: settlement.exitCode ?? -1,
          ...(settlement.signal ? { signal: settlement.signal } : {}),
          timedOut: settlement.timedOut,
          cancelled: settlement.cancelled,
        }),
        ...(rawResponseRef ? { rawResponseRef } : {}),
      }
    } finally {
      await rm(isolation.root, { recursive: true, force: true })
    }
  }
}
