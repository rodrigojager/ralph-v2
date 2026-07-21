import {
  type CredentialDriver,
  CURATED_CATALOG_SEED,
  type ModelInfo,
  type ProviderDriver,
  type ProviderEvent,
  ProviderEventSchema,
  type ProviderEventSink,
  type ProviderInfo,
  type ProviderModelRequest,
  ProviderModelRequestSchema,
  type ProviderModelResult,
  ProviderModelResultSchema,
  type ProviderToolCall,
  ProviderToolCallSchema,
  type TokenUsage,
  TokenUsageSchema,
} from "@ralph/providers"

export type ScriptedProviderRateLimit = {
  retryAfterMs: number
  message?: string
  code?: string
}

export type ScriptedProviderStep = {
  expectedCallId?: string
  text?: string
  reasoningSummary?: string
  textDeltas?: readonly string[]
  reasoningDeltas?: readonly string[]
  toolCalls?: readonly ProviderToolCall[]
  usage?: TokenUsage
  rawRef?: string
  heartbeatCount?: number
  /** Waits without provider output until release(callId) is called. */
  silence?: boolean
  /** Never resumes normally; only cancellation can settle the invocation. */
  freeze?: boolean
  rateLimit?: ScriptedProviderRateLimit
  failure?: Error | string
  /** Deliberately bypasses the result schema so a consumer can test fail-closed parsing. */
  malformedResult?: unknown
}

export type ScriptedProviderOptions = {
  id?: string
  now?: () => string
}

type ActiveInvocation = {
  mode: "silence" | "freeze"
  promise: Promise<void>
  release: () => void
  reject: (error: Error) => void
}

export class ScriptedProviderRateLimitError extends Error {
  readonly kind = "rate-limit" as const
  readonly status = 429
  readonly retryAfterMs: number
  readonly code: string

  constructor(input: ScriptedProviderRateLimit) {
    super(input.message ?? "Scripted provider rate limit")
    this.name = "ScriptedProviderRateLimitError"
    this.retryAfterMs = input.retryAfterMs
    this.code = input.code ?? "rate_limit"
  }
}

function deferredInvocation(mode: ActiveInvocation["mode"]): ActiveInvocation {
  let release: (() => void) | undefined
  let reject: ((error: Error) => void) | undefined
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    release = resolvePromise
    reject = rejectPromise
  })
  return {
    mode,
    promise,
    release: () => release?.(),
    reject: (error) => reject?.(error),
  }
}

function providerCatalog(id: string): { info: ProviderInfo; models: readonly ModelInfo[] } {
  const info = CURATED_CATALOG_SEED.providers.find((candidate) => candidate.id === id)
  const models = CURATED_CATALOG_SEED.models.filter((candidate) => candidate.provider === id)
  if (!info || models.length === 0) {
    throw new Error(`Scripted provider requires a curated provider id: ${id}`)
  }
  return { info: structuredClone(info), models: structuredClone(models) }
}

function nonnegativeCount(value: number | undefined, label: string): number {
  const resolved = value ?? 0
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return resolved
}

/** A deterministic ProviderDriver with explicit adverse and streaming steps. */
export class ScriptedProviderDriver implements ProviderDriver {
  readonly id: string
  readonly requests: ProviderModelRequest[] = []
  readonly events: ProviderEvent[] = []
  readonly cancellations: Array<{ callId: string; reason: string }> = []
  readonly #queue: ScriptedProviderStep[]
  readonly #info: ProviderInfo
  readonly #models: readonly ModelInfo[]
  readonly #now: () => string
  readonly #active = new Map<string, ActiveInvocation>()
  #eventOrdinal = 0

  constructor(steps: readonly ScriptedProviderStep[] = [], options: ScriptedProviderOptions = {}) {
    this.id = options.id ?? "openai"
    const catalog = providerCatalog(this.id)
    this.#info = catalog.info
    this.#models = catalog.models
    this.#queue = [...steps]
    this.#now = options.now ?? (() => "2026-01-01T00:00:00.000Z")
  }

  async info(): Promise<ProviderInfo> {
    return structuredClone(this.#info)
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return structuredClone(this.#models)
  }

  credentialDriver(): CredentialDriver | undefined {
    return undefined
  }

  async invoke(
    requestInput: ProviderModelRequest,
    sink: ProviderEventSink,
  ): Promise<ProviderModelResult> {
    const request = ProviderModelRequestSchema.parse(requestInput)
    this.requests.push(structuredClone(request))
    const step = this.#queue.shift()
    if (!step) throw new Error("Scripted provider has no remaining invocation step")
    if (step.expectedCallId && step.expectedCallId !== request.callId) {
      throw new Error(
        `Scripted provider expected call ${step.expectedCallId}, received ${request.callId}`,
      )
    }

    let sequence = 0
    const emit = async (
      event: Omit<
        ProviderEvent,
        "schemaVersion" | "eventId" | "callId" | "sequence" | "timestamp" | "synthesized"
      >,
    ): Promise<void> => {
      this.#eventOrdinal += 1
      sequence += 1
      const parsed = ProviderEventSchema.parse({
        schemaVersion: 1,
        eventId: `scripted-provider-event-${this.#eventOrdinal}`,
        callId: request.callId,
        sequence,
        timestamp: this.#now(),
        synthesized: false,
        ...event,
      })
      this.events.push(parsed)
      await sink.emit(parsed)
    }

    for (const delta of step.reasoningDeltas ?? []) {
      await emit({ type: "model.reasoning.delta", level: "debug", payload: { delta } })
    }
    for (const delta of step.textDeltas ?? []) {
      await emit({ type: "model.text.delta", level: "info", payload: { delta } })
    }
    for (
      let index = 0;
      index < nonnegativeCount(step.heartbeatCount, "heartbeatCount");
      index += 1
    ) {
      await emit({
        type: "model.provider.warning",
        level: "debug",
        payload: {
          kind: "heartbeat",
          message: `Scripted provider heartbeat ${index + 1}`,
        },
      })
    }

    if (step.silence || step.freeze) {
      const active = deferredInvocation(step.freeze ? "freeze" : "silence")
      this.#active.set(request.callId, active)
      try {
        await active.promise
      } finally {
        this.#active.delete(request.callId)
      }
    }

    if (step.rateLimit) {
      if (!Number.isSafeInteger(step.rateLimit.retryAfterMs) || step.rateLimit.retryAfterMs < 0) {
        throw new Error("Scripted provider retryAfterMs must be a non-negative safe integer")
      }
      await emit({
        type: "model.provider.error",
        level: "error",
        payload: {
          kind: "rate-limit",
          message: step.rateLimit.message ?? "Scripted provider rate limit",
          code: step.rateLimit.code ?? "rate_limit",
          retryAfterMs: step.rateLimit.retryAfterMs,
          ...(step.rawRef ? { rawRef: step.rawRef } : {}),
        },
      })
      throw new ScriptedProviderRateLimitError(step.rateLimit)
    }
    if (step.failure)
      throw typeof step.failure === "string" ? new Error(step.failure) : step.failure
    if (Object.hasOwn(step, "malformedResult")) {
      return step.malformedResult as ProviderModelResult
    }

    const toolCalls = (step.toolCalls ?? []).map((call) => ProviderToolCallSchema.parse(call))
    for (const call of toolCalls) {
      await emit({
        type: "model.tool.call",
        level: "info",
        payload: {
          toolCallId: call.callId,
          name: call.name,
          input: call.input,
          ...(step.rawRef ? { rawRef: step.rawRef } : {}),
        },
      })
    }
    if (step.text !== undefined) {
      await emit({
        type: "model.text.completed",
        level: "info",
        payload: { text: step.text, ...(step.rawRef ? { rawRef: step.rawRef } : {}) },
      })
    }
    if (step.reasoningSummary !== undefined) {
      await emit({
        type: "model.reasoning.completed",
        level: "debug",
        payload: {
          summary: step.reasoningSummary,
          ...(step.rawRef ? { rawRef: step.rawRef } : {}),
        },
      })
    }
    const usage = TokenUsageSchema.parse(
      step.usage ?? { source: "unavailable", semantics: "final" },
    )
    await emit({ type: "model.usage.updated", level: "info", payload: { usage } })
    const finishReason = toolCalls.length > 0 ? "tool-call" : "stop"
    await emit({
      type: "model.call.finished",
      level: "info",
      payload: { finishReason, ...(step.rawRef ? { rawRef: step.rawRef } : {}) },
    })
    return ProviderModelResultSchema.parse({
      schemaVersion: 1,
      callId: request.callId,
      status: "succeeded",
      finishReason,
      ...(step.text === undefined ? {} : { text: step.text }),
      ...(step.reasoningSummary === undefined ? {} : { reasoningSummary: step.reasoningSummary }),
      usage,
      toolCalls,
    })
  }

  async cancel(callId: string, reason: string): Promise<void> {
    this.cancellations.push({ callId, reason })
    this.#active.get(callId)?.reject(new Error(`Scripted provider call cancelled: ${reason}`))
  }

  release(callId: string): void {
    const active = this.#active.get(callId)
    if (!active) throw new Error(`Scripted provider call is not waiting: ${callId}`)
    if (active.mode === "freeze") {
      throw new Error(`Scripted provider call is frozen and must be cancelled: ${callId}`)
    }
    active.release()
  }

  activeCalls(): readonly string[] {
    return [...this.#active.keys()]
  }

  remaining(): number {
    return this.#queue.length
  }
}
