import type { OpenAiEvent, OpenAiFinishReason, OpenAiToolCall } from "@ralph-next/openai-driver"
import {
  type CatalogResolution,
  type ModelAccess,
  type ModelCatalogSnapshot,
  type PriceSnapshot,
  type ProviderEvent,
  ProviderEventSchema,
  type TokenUsage,
  TokenUsageSchema,
  type UsageMetric,
} from "@ralph-next/providers"
import { applyPriceSnapshot, redactText, redactValue } from "@ralph-next/telemetry"

import { IncrementalTextRedactor } from "./incremental-redactor"

export type ProviderCatalogProvenance = {
  snapshot: ModelCatalogSnapshot
  resolution: Pick<CatalogResolution, "origin" | "stale">
}

export type ProviderStreamAdapterOptions = {
  callId: string
  rawRef?: string
  secrets?: readonly string[]
  catalog?: ProviderCatalogProvenance
  pricing?: {
    price: PriceSnapshot
    access: ModelAccess
    usageMetrics: readonly UsageMetric[]
  }
  now?: () => number
  eventId?: (sequence: number) => string
}

export type ProviderStreamSummary = {
  text: string
  reasoningSummary: string
  finishReason: OpenAiFinishReason
  usage: TokenUsage
  toolCalls: readonly OpenAiToolCall[]
  events: readonly ProviderEvent[]
}

function usageFromOpenAi(
  value: Extract<OpenAiEvent, { type: "usage" }>["delta"],
  semantics: Extract<OpenAiEvent, { type: "usage" }>["semantics"],
  rawRef?: string,
): TokenUsage {
  if (value.source === "unavailable") {
    return TokenUsageSchema.parse({
      source: "unavailable",
      semantics,
      ...(rawRef ? { providerRawRef: rawRef } : {}),
    })
  }
  const cacheRead = value.cacheRead ?? 0
  const cacheWrite = value.cacheWrite ?? 0
  if (
    value.input !== undefined &&
    (cacheRead > value.input || cacheWrite > value.input - cacheRead)
  ) {
    throw new Error("Provider cache usage exceeds total input usage")
  }
  return TokenUsageSchema.parse({
    ...(value.input === undefined ? {} : { input: value.input }),
    ...(value.input === undefined ||
    (value.cacheRead === undefined && value.cacheWrite === undefined)
      ? {}
      : { inputNonCached: value.input - cacheRead - cacheWrite }),
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
    ...(value.cacheRead === undefined ? {} : { cacheRead: value.cacheRead }),
    ...(value.cacheWrite === undefined ? {} : { cacheWrite: value.cacheWrite }),
    ...(value.total === undefined ? {} : { total: value.total }),
    source: value.source,
    semantics,
    ...(rawRef ? { providerRawRef: rawRef } : {}),
  })
}

function rawReference(rawRef: string | undefined): { rawRef?: string } {
  return rawRef ? { rawRef } : {}
}

function applyConfiguredPrice(
  usage: TokenUsage,
  pricing: ProviderStreamAdapterOptions["pricing"],
): { usage: TokenUsage; reason?: string } {
  if (!pricing) {
    return {
      usage,
      ...(usage.cost ? {} : { reason: "no immutable price snapshot was configured" }),
    }
  }
  const result = applyPriceSnapshot(usage, pricing.price, pricing.access, pricing.usageMetrics)
  return {
    usage: result.usage,
    ...(!result.priced && result.reason ? { reason: result.reason } : {}),
  }
}

/**
 * Converts one provider stream into the closed Ralph event contract. It never
 * executes a tool and never emits a Ralph tool settlement: provider tool calls
 * remain requests until the command-owned execution channel authorizes them.
 */
export class OpenAiProviderStreamAdapter {
  readonly #events: ProviderEvent[] = []
  readonly #text: string[] = []
  readonly #reasoning: string[] = []
  readonly #toolCalls: OpenAiToolCall[] = []
  readonly #toolIds = new Set<string>()
  readonly #toolInputChannels = new Set<string>()
  readonly #secrets: readonly string[]
  readonly #streamRedactor: IncrementalTextRedactor
  readonly #now: () => number
  readonly #eventId: (sequence: number) => string
  #sourceSequence: number | undefined
  #sequence = 0
  #terminal = false
  #providerErrorEmitted = false
  #finalUsageEmitted = false
  #pricingWarningEmitted = false
  #finishReason: OpenAiFinishReason = "unknown"
  #usage: TokenUsage | undefined

  constructor(readonly options: ProviderStreamAdapterOptions) {
    this.#secrets = [...(options.secrets ?? [])]
    this.#streamRedactor = new IncrementalTextRedactor(this.#secrets)
    this.#now = options.now ?? Date.now
    this.#eventId = options.eventId ?? ((sequence) => `${options.callId}:${sequence}`)
  }

  accept(source: OpenAiEvent): readonly ProviderEvent[] {
    if (this.#terminal) throw new Error("Provider stream emitted an event after its terminal event")
    if (this.#sourceSequence !== undefined && source.sequence <= this.#sourceSequence) {
      throw new Error("Provider stream source sequence is duplicated or out of order")
    }
    this.#sourceSequence = source.sequence
    const before = this.#events.length
    if (source.type === "raw") return []
    if (source.type === "text") {
      const delta = this.#streamRedactor.push("text", source.delta)
      if (delta.length > 0) {
        this.#text.push(delta)
        this.#emit(
          "model.text.delta",
          "info",
          { delta, ...rawReference(this.options.rawRef) },
          false,
          source,
        )
      }
    } else if (source.type === "reasoning") {
      const delta = this.#streamRedactor.push("reasoning", source.delta)
      if (delta.length > 0) {
        this.#reasoning.push(delta)
        this.#emit(
          "model.reasoning.delta",
          "debug",
          { delta, ...rawReference(this.options.rawRef) },
          false,
          source,
        )
      }
    } else if (source.type === "tool-input") {
      this.#toolInputChannels.add(source.toolCallId)
      const delta = this.#streamRedactor.push(`tool-input:${source.toolCallId}`, source.delta)
      if (delta.length > 0) this.#emitToolInput(source.toolCallId, delta, source)
    } else if (source.type === "tool-call") {
      if (this.#toolIds.has(source.call.callId)) throw new Error("Provider duplicated a tool call")
      this.#toolIds.add(source.call.callId)
      this.#flushToolInput(source.call.callId, source)
      const executionCall: OpenAiToolCall = {
        ...source.call,
        input: structuredClone(source.call.input),
      }
      this.#toolCalls.push(executionCall)
      const safeCall = redactValue(source.call, this.#secrets) as OpenAiToolCall
      this.#emit(
        "model.tool.call",
        "info",
        {
          toolCallId: safeCall.callId,
          name: safeCall.name,
          input: safeCall.input,
          ...rawReference(this.options.rawRef),
        },
        false,
        source,
      )
    } else if (source.type === "usage") {
      if (this.#finalUsageEmitted) {
        throw new Error("Provider stream emitted usage after its final usage event")
      }
      const eventPricing = applyConfiguredPrice(
        usageFromOpenAi(
          source.semantics === "delta" ? source.delta : source.aggregate,
          source.semantics,
          this.options.rawRef,
        ),
        this.options.pricing,
      )
      const aggregatePricing = applyConfiguredPrice(
        usageFromOpenAi(source.aggregate, "final", this.options.rawRef),
        this.options.pricing,
      )
      this.#usage = aggregatePricing.usage
      if (source.semantics === "final") {
        this.#emitPricingWarning(aggregatePricing.reason, source)
      }
      this.#emit("model.usage.updated", "info", { usage: eventPricing.usage }, false, source)
      if (source.semantics === "final") this.#finalUsageEmitted = true
    } else if (source.type === "error") {
      this.#finishReason = "error"
      this.#providerErrorEmitted = true
      this.#emit(
        "model.provider.error",
        "error",
        {
          kind: source.error.kind,
          message: redactText(source.error.message, this.#secrets),
          ...(source.error.code ? { code: source.error.code } : {}),
          ...rawReference(this.options.rawRef),
        },
        false,
        source,
      )
    } else {
      this.#finishReason = source.reason
      this.#finish(source)
    }
    return this.#events.slice(before)
  }

  fail(error: unknown, synthesized = true): readonly ProviderEvent[] {
    if (this.#terminal) return []
    const before = this.#events.length
    this.#finishReason = "error"
    if (!this.#providerErrorEmitted) {
      this.#emit(
        "model.provider.error",
        "error",
        {
          kind: "provider",
          message: redactText(
            error instanceof Error ? error.message : String(error),
            this.#secrets,
          ),
          ...rawReference(this.options.rawRef),
        },
        synthesized,
      )
      this.#providerErrorEmitted = true
    }
    this.#finish(undefined, synthesized)
    return this.#events.slice(before)
  }

  summary(): ProviderStreamSummary {
    if (!this.#terminal) throw new Error("Provider stream summary requested before terminal event")
    return {
      text: this.#text.join(""),
      reasoningSummary: this.#reasoning.join(""),
      finishReason: this.#finishReason,
      usage: this.#usage as TokenUsage,
      toolCalls: this.#toolCalls.map((call) => structuredClone(call)),
      events: [...this.#events],
    }
  }

  #finish(source?: OpenAiEvent, synthesized = true): void {
    if (this.#terminal) throw new Error("Provider stream emitted more than one terminal event")
    const finalText = this.#streamRedactor.flush("text")
    if (finalText.length > 0) {
      this.#text.push(finalText)
      this.#emit(
        "model.text.delta",
        "info",
        { delta: finalText, ...rawReference(this.options.rawRef) },
        true,
        source,
      )
    }
    const finalReasoning = this.#streamRedactor.flush("reasoning")
    if (finalReasoning.length > 0) {
      this.#reasoning.push(finalReasoning)
      this.#emit(
        "model.reasoning.delta",
        "debug",
        { delta: finalReasoning, ...rawReference(this.options.rawRef) },
        true,
        source,
      )
    }
    for (const toolCallId of [...this.#toolInputChannels].sort()) {
      this.#flushToolInput(toolCallId, source)
    }
    if (this.#text.length > 0) {
      this.#emit(
        "model.text.completed",
        "info",
        { text: this.#text.join(""), ...rawReference(this.options.rawRef) },
        true,
      )
    }
    if (this.#reasoning.length > 0) {
      this.#emit(
        "model.reasoning.completed",
        "debug",
        { summary: this.#reasoning.join(""), ...rawReference(this.options.rawRef) },
        true,
      )
    }
    if (!this.#finalUsageEmitted) {
      // A compatible stream may publish only delta/cumulative usage and omit
      // usage from its terminal response. Preserve that deterministic
      // aggregate as the final settlement instead of overwriting it with an
      // unavailable marker.
      this.#usage ??= TokenUsageSchema.parse({
        source: "unavailable",
        semantics: "final",
        ...(this.options.rawRef ? { providerRawRef: this.options.rawRef } : {}),
      })
      this.#emit("model.usage.updated", "info", { usage: this.#usage }, true)
      this.#finalUsageEmitted = true
    }
    const provenance = this.options.catalog
      ? {
          catalogSnapshotId: this.options.catalog.snapshot.id,
          catalogOrigin: this.options.catalog.resolution.origin,
          catalogStale: this.options.catalog.resolution.stale,
          catalogSource: this.options.catalog.snapshot.source,
        }
      : {}
    this.#emit(
      "model.call.finished",
      "info",
      { finishReason: this.#finishReason, ...rawReference(this.options.rawRef), ...provenance },
      synthesized,
      source,
    )
    this.#terminal = true
  }

  #emitToolInput(
    toolCallId: string,
    delta: string,
    source?: Pick<OpenAiEvent, "providerEventId">,
    synthesized = false,
  ): void {
    this.#emit(
      "model.tool.input.delta",
      "debug",
      { toolCallId, delta, ...rawReference(this.options.rawRef) },
      synthesized,
      source,
    )
  }

  #flushToolInput(toolCallId: string, source?: Pick<OpenAiEvent, "providerEventId">): void {
    const delta = this.#streamRedactor.flush(`tool-input:${toolCallId}`)
    this.#toolInputChannels.delete(toolCallId)
    if (delta.length > 0) this.#emitToolInput(toolCallId, delta, source, true)
  }

  #emitPricingWarning(
    reason: string | undefined,
    source?: Pick<OpenAiEvent, "providerEventId">,
  ): void {
    if (!reason || this.#pricingWarningEmitted) return
    this.#emit(
      "model.provider.warning",
      "warn",
      {
        kind: "pricing-unavailable",
        code: "RALPH_MODEL_COST_UNAVAILABLE",
        message: reason,
        ...rawReference(this.options.rawRef),
      },
      true,
      source,
    )
    this.#pricingWarningEmitted = true
  }

  #emit(
    type: ProviderEvent["type"],
    level: ProviderEvent["level"],
    payload: Record<string, unknown>,
    synthesized: boolean,
    source?: Pick<OpenAiEvent, "providerEventId">,
  ): void {
    this.#sequence += 1
    this.#events.push(
      ProviderEventSchema.parse({
        schemaVersion: 1,
        eventId: this.#eventId(this.#sequence),
        ...(source?.providerEventId ? { providerEventId: source.providerEventId } : {}),
        callId: this.options.callId,
        sequence: this.#sequence,
        timestamp: new Date(this.#now()).toISOString(),
        type,
        level,
        synthesized,
        payload,
      }),
    )
  }
}
