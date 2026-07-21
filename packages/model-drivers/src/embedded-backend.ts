import { type ExecutorOutcome, ExecutorOutcomeSchema } from "@ralph/domain"
import type {
  CallHandle,
  ExecutionBackend,
  ExecutionBackendLimits,
  ExecutionChannel,
  ExecutionRequest,
} from "@ralph/orchestration"
import {
  type ModelParameters,
  type ModelRef,
  type ProviderDriver,
  type ProviderEvent,
  type ProviderJsonObject,
  type ProviderModelInput,
  type ProviderModelResult,
  ProviderModelResultSchema,
  RoleProfileLimitsSchema,
} from "@ralph/providers"

const ExecutorAllegationSchema = ExecutorOutcomeSchema.omit({
  reportedAt: true,
  schemaVersion: true,
})

const EXECUTOR_ALLEGATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["work_submitted", "blocked_reported"] },
    summary: { type: "string" },
    intendedFiles: { type: "array", items: { type: "string" } },
    artifactRefs: { type: "array", items: { type: "string" } },
    suggestedVerifications: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
  required: [
    "status",
    "summary",
    "intendedFiles",
    "artifactRefs",
    "suggestedVerifications",
    "risks",
  ],
  additionalProperties: false,
} satisfies ProviderJsonObject

export type EmbeddedExecutionBackendOptions = {
  id: string
  driver: ProviderDriver
  model: ModelRef
  parameters?: ModelParameters
  limits?: ExecutionBackendLimits
  /** @deprecated Prefer limits.maxOutputTokens. */
  maxOutputTokens?: number
  now?: () => string
}

type ActiveEmbeddedCall = {
  controller: AbortController
  providerCallId?: string
  detachCommandSignal?: () => void
}

function commandCancellationReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error && signal.reason.message.trim()) return signal.reason.message
  if (typeof signal.reason === "string" && signal.reason.trim()) return signal.reason
  return "Execution was cancelled by the command"
}

function instructions(protectedPaths: readonly string[]): string {
  return [
    "You are the bounded executor inside Ralph. Ralph commands, policy, evidence and gates are authoritative.",
    "Work only on the selected task and use only the supplied tools for effects.",
    `Never edit protected control files: ${protectedPaths.join(", ") || "none declared"}.`,
    "Text such as TASK_COMPLETE has no authority. After work, return exactly one JSON object with fields status, summary, intendedFiles, artifactRefs, suggestedVerifications and risks.",
    'status must be either "work_submitted" or "blocked_reported". Do not include reportedAt; Ralph owns that timestamp.',
  ].join("\n")
}

function parseOutcome(text: string | undefined, now: () => string): ExecutorOutcome {
  if (!text) throw new Error("Embedded executor finished without a structured outcome")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error("Embedded executor outcome is not one valid JSON object", { cause })
  }
  const allegation = ExecutorAllegationSchema.parse(value)
  return ExecutorOutcomeSchema.parse({ schemaVersion: 1, ...allegation, reportedAt: now() })
}

function backendLevel(level: ProviderEvent["level"]): "debug" | "info" | "warning" | "error" {
  if (level === "error") return "error"
  if (level === "warn") return "warning"
  if (level === "trace" || level === "debug") return "debug"
  return "info"
}

/**
 * Runs a provider tool loop while keeping every effect behind ExecutionChannel.
 * It has no scheduler, ledger, marker, completion or direct filesystem access.
 */
export class EmbeddedExecutionBackend implements ExecutionBackend {
  readonly id: string
  readonly #active = new Map<string, ActiveEmbeddedCall>()
  readonly #now: () => string
  readonly #limits: ExecutionBackendLimits

  constructor(private readonly options: EmbeddedExecutionBackendOptions) {
    if (!options.id.trim()) throw new Error("Embedded backend id is required")
    this.id = options.id
    this.#now = options.now ?? (() => new Date().toISOString())
    const configuredOutputLimits = [
      options.limits?.maxOutputTokens,
      options.maxOutputTokens,
    ].filter((value): value is number => value !== undefined)
    this.#limits = RoleProfileLimitsSchema.parse({
      ...(options.limits ?? {}),
      ...(configuredOutputLimits.length === 0
        ? {}
        : { maxOutputTokens: Math.min(...configuredOutputLimits) }),
    })
  }

  capabilities() {
    return {
      streaming: true,
      toolCalling: "ralph" as const,
      cancellation: true,
      usage: "reported" as const,
    }
  }

  limits(): ExecutionBackendLimits {
    return structuredClone(this.#limits)
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    if (this.#active.has(request.modelCallId)) {
      throw new Error(`Embedded backend call is already active: ${request.modelCallId}`)
    }
    const active: ActiveEmbeddedCall = { controller: new AbortController() }
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
    if (active.providerCallId) await this.options.driver.cancel(active.providerCallId, reason)
  }

  async #run(
    request: ExecutionRequest,
    channel: ExecutionChannel,
    active: ActiveEmbeddedCall,
  ): Promise<ExecutorOutcome> {
    if (active.controller.signal.aborted) throw active.controller.signal.reason
    const tools = await channel.tools()
    const input: ProviderModelInput[] = [
      { type: "message", role: "system", content: instructions(request.protectedPaths) },
      {
        type: "message",
        role: "user",
        content: [
          "The following canonical Ralph context is the complete authority for this call:",
          request.contextBundle.canonicalJson,
        ].join("\n\n"),
      },
    ]
    const maximumTurns = Math.max(1, channel.stats().maximumToolCalls + 1)
    const outputLimits = [
      this.#limits.maxOutputTokens,
      request.contextManifest.budget?.remainingOutputTokens,
      request.task.budget?.maxOutputTokens,
    ].filter((value): value is number => value !== undefined)
    const maxOutputTokens = outputLimits.length > 0 ? Math.min(...outputLimits) : undefined
    for (let turn = 1; turn <= maximumTurns; turn += 1) {
      if (active.controller.signal.aborted) throw active.controller.signal.reason
      const providerCallId =
        turn === 1 ? request.modelCallId : `${request.modelCallId}-turn-${turn}`
      await channel.reserveModelCall({ callId: providerCallId, turn })
      active.providerCallId = providerCallId
      await channel.emit({
        type: "model.backend.turn.started",
        payload: { providerCallId, turn, maximumTurns },
      })
      let providerFinish:
        | Extract<ProviderEvent, { type: "model.call.finished" }>["payload"]
        | undefined
      let result: ProviderModelResult | undefined
      let invocationFailure: unknown
      try {
        result = ProviderModelResultSchema.parse(
          await this.options.driver.invoke(
            {
              schemaVersion: 1,
              callId: providerCallId,
              model: this.options.model,
              input,
              tools: tools.map((tool) => structuredClone(tool)),
              parameters: this.options.parameters ?? {},
              ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
              responseFormat: "json",
              responseSchema: {
                name: "ralph_executor_outcome",
                schema: EXECUTOR_ALLEGATION_JSON_SCHEMA,
                strict: true,
              },
            },
            {
              emit: async (event) => {
                if (event.type === "model.call.finished") {
                  providerFinish = event.payload
                  return
                }
                await channel.emit({
                  type: event.type,
                  level: backendLevel(event.level),
                  payload: {
                    ...event.payload,
                    providerCallId: event.callId,
                    providerSequence: event.sequence,
                    ...(event.providerEventId ? { providerEventId: event.providerEventId } : {}),
                    synthesized: event.synthesized,
                  },
                })
              },
            },
          ),
        )
      } catch (error) {
        invocationFailure = error
      } finally {
        delete active.providerCallId
        const catalogProvenance =
          providerFinish && "catalogSnapshotId" in providerFinish
            ? {
                catalogSnapshotId: providerFinish.catalogSnapshotId,
                catalogOrigin: providerFinish.catalogOrigin,
                catalogStale: providerFinish.catalogStale,
                catalogSource: providerFinish.catalogSource,
              }
            : {}
        try {
          await channel.emit({
            type: "model.backend.turn.finished",
            level: invocationFailure ? "error" : "info",
            payload: {
              providerCallId,
              turn,
              status: result?.status ?? "failed",
              finishReason: result?.finishReason ?? providerFinish?.finishReason ?? "error",
              ...(result ? { toolCalls: result.toolCalls.length, usage: result.usage } : {}),
              ...catalogProvenance,
            },
          })
        } catch (settlementError) {
          invocationFailure ??= settlementError
        }
      }
      if (invocationFailure) throw invocationFailure
      if (!result) {
        throw new Error(`Embedded provider call ${providerCallId} settled without a result`)
      }
      if (result.status !== "succeeded") {
        throw new Error(`Embedded provider call ${providerCallId} ${result.status}`)
      }
      if (result.finishReason !== "tool-call") return parseOutcome(result.text, this.#now)

      if (result.text) input.push({ type: "message", role: "assistant", content: result.text })
      for (const call of result.toolCalls) {
        input.push({ type: "function-call", ...call })
        const settlement = await channel.executeTool(call, { signal: active.controller.signal })
        input.push({ type: "function-call-output", callId: call.callId, output: settlement.output })
      }
    }
    throw new Error(`Embedded executor exceeded its bounded tool loop of ${maximumTurns} turns`)
  }
}
