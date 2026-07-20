import { OpenAiDriverError, type OpenAiFailureKind } from "./protocol"
import {
  ResponseBodyError,
  readBoundedResponseJson,
  readStreamChunk,
  responseByteLength,
} from "./response-body"

export const OPENAI_MAX_JSON_RESPONSE_BYTES = 1_048_576
export const OPENAI_MAX_SSE_RESPONSE_BYTES = 16_777_216
export const OPENAI_MAX_SSE_FRAME_BYTES = 1_048_576
export const OPENAI_MAX_RAW_EVENT_BYTES = 1_048_576
export const OPENAI_MAX_SSE_FRAMES = 65_536
export const OPENAI_MAX_NORMALIZED_EVENTS = 100_000
export const OPENAI_MAX_STRUCTURED_DEPTH = 128
export const OPENAI_MAX_STRUCTURED_NODES = 100_000
const PRIVATE_REASONING_OMITTED = "[PRIVATE_REASONING_OMITTED]"

export type OpenAiFinishReason =
  | "stop"
  | "length"
  | "tool-call"
  | "content-filter"
  | "error"
  | "cancelled"
  | "unknown"

export type UsageSource = "reported" | "derived" | "unavailable"
export type UsageSemantics = "delta" | "cumulative" | "final"

export type TokenUsage = {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  total?: number
}

export type NormalizedUsage = TokenUsage & {
  source: UsageSource
}

export type OpenAiToolCall = {
  itemId: string
  callId: string
  name: string
  input: Readonly<Record<string, unknown>>
  argumentsJson: string
}

export type OpenAiOpaqueReasoningItem = {
  type: "reasoning"
  itemId: string
  encryptedContent: string
  summary: readonly Readonly<Record<string, unknown>>[]
}

export type OpenAiEvent =
  | {
      type: "raw"
      sequence: number
      providerEvent?: string
      providerEventId?: string
      data: unknown
    }
  | {
      type: "text"
      sequence: number
      providerEventId?: string
      delta: string
    }
  | {
      type: "reasoning"
      sequence: number
      providerEventId?: string
      delta: string
    }
  | {
      type: "tool-input"
      sequence: number
      providerEventId?: string
      toolCallId: string
      delta: string
    }
  | {
      type: "tool-call"
      sequence: number
      providerEventId?: string
      call: OpenAiToolCall
    }
  | {
      type: "usage"
      sequence: number
      providerEventId?: string
      semantics: UsageSemantics
      delta: NormalizedUsage
      aggregate: NormalizedUsage
    }
  | {
      type: "finish"
      sequence: number
      providerEventId?: string
      reason: OpenAiFinishReason
    }
  | {
      type: "error"
      sequence: number
      providerEventId?: string
      error: {
        kind: OpenAiFailureKind
        message: string
        code?: string
      }
    }

export type OpenAiEventSink = (event: OpenAiEvent) => void | Promise<void>

export type ResponseConsumption = {
  eventCount: number
  finishReason: OpenAiFinishReason
  usage: NormalizedUsage
  toolCalls: readonly OpenAiToolCall[]
  reasoningItems: readonly OpenAiOpaqueReasoningItem[]
}

type UsageFields = keyof TokenUsage

const USAGE_FIELDS: UsageFields[] = [
  "input",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
  "total",
]

export class UsageAccumulator {
  readonly #totals: TokenUsage = {}
  #totalSource: "reported" | "derived" | undefined

  apply(
    snapshot: TokenUsage,
    semantics: UsageSemantics,
  ): {
    delta: NormalizedUsage
    aggregate: NormalizedUsage
  } | null {
    const delta: TokenUsage = {}
    for (const field of USAGE_FIELDS.filter((candidate) => candidate !== "total")) {
      const next = snapshot[field]
      if (next === undefined) continue
      assertTokenCount(field, next)
      const prior = this.#totals[field] ?? 0
      if (semantics === "delta") {
        this.#totals[field] = safeTokenSum(field, prior, next)
        delta[field] = next
      } else {
        if (next < prior) {
          throw new OpenAiDriverError(
            "protocol-drift",
            `Cumulative usage field ${field} decreased within one model call`,
          )
        }
        this.#totals[field] = next
        delta[field] = next - prior
      }
    }

    if (snapshot.total !== undefined) {
      assertTokenCount("total", snapshot.total)
      const prior = this.#totals.total ?? 0
      const priorSource = this.#totalSource
      const next =
        semantics === "delta" ? safeTokenSum("total", prior, snapshot.total) : snapshot.total
      if (semantics !== "delta" && next < prior) {
        throw new OpenAiDriverError(
          "protocol-drift",
          "Cumulative usage field total decreased within one model call",
        )
      }
      assertTotalConsistency(next, this.#totals)
      this.#totals.total = next
      delta.total = semantics === "delta" ? snapshot.total : next - prior
      this.#totalSource =
        semantics === "delta" && priorSource === "derived" ? "derived" : "reported"
    } else if (semantics === "delta") {
      if (
        snapshot.input !== undefined ||
        snapshot.output !== undefined ||
        snapshot.reasoning !== undefined
      ) {
        const derivedDelta = safeTokenSum(
          "total",
          safeTokenSum("total", delta.input ?? 0, delta.output ?? 0),
          delta.reasoning ?? 0,
        )
        const next = safeTokenSum("total", this.#totals.total ?? 0, derivedDelta)
        assertTotalConsistency(next, this.#totals)
        this.#totals.total = next
        delta.total = derivedDelta
        this.#totalSource = "derived"
      }
    } else if (this.#totalSource === "reported") {
      assertTotalConsistency(this.#totals.total ?? 0, this.#totals)
    } else if (
      snapshot.input !== undefined ||
      snapshot.output !== undefined ||
      snapshot.reasoning !== undefined
    ) {
      const prior = this.#totals.total ?? 0
      const next = safeTokenSum(
        "total",
        safeTokenSum("total", this.#totals.input ?? 0, this.#totals.output ?? 0),
        this.#totals.reasoning ?? 0,
      )
      if (next < prior) {
        throw new OpenAiDriverError(
          "protocol-drift",
          "Derived cumulative usage total decreased within one model call",
        )
      }
      this.#totals.total = next
      delta.total = next - prior
      this.#totalSource = "derived"
    }

    const source = this.#totalSource ?? "derived"
    if (semantics !== "final" && USAGE_FIELDS.every((field) => (delta[field] ?? 0) === 0)) {
      return null
    }
    return {
      delta: { ...delta, source },
      aggregate: { ...this.#totals, source },
    }
  }

  snapshot(): NormalizedUsage {
    if (USAGE_FIELDS.every((field) => this.#totals[field] === undefined)) {
      return { source: "unavailable" }
    }
    return { ...this.#totals, source: this.#totalSource ?? "derived" }
  }
}

function assertTotalConsistency(total: number, totals: TokenUsage): void {
  assertTokenCount("total", total)
  const accounted = safeTokenSum(
    "total",
    safeTokenSum("total", totals.input ?? 0, totals.output ?? 0),
    totals.reasoning ?? 0,
  )
  if (total < accounted) {
    throw new OpenAiDriverError(
      "protocol-drift",
      "Provider total usage is smaller than cumulative input and output usage (visible output plus reasoning)",
    )
  }
}

function safeTokenSum(field: UsageFields, left: number, right: number): number {
  const value = left + right
  assertTokenCount(field, value)
  return value
}

export async function consumeOpenAiResponse(
  response: Response,
  sink: OpenAiEventSink,
  signal?: AbortSignal,
): Promise<ResponseConsumption> {
  const normalizer = new ResponseNormalizer(sink)
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  if (contentType.includes("text/event-stream")) {
    if (!response.body) {
      throw new OpenAiDriverError("protocol-drift", "Provider SSE response has no body")
    }
    await consumeSse(response.body, normalizer, signal)
  } else {
    let value: unknown
    try {
      value = await readBoundedResponseJson(response, {
        maxBytes: OPENAI_MAX_JSON_RESPONSE_BYTES,
        ...(signal ? { signal } : {}),
        label: "Provider JSON response",
      })
    } catch (cause) {
      if (cause instanceof ResponseBodyError && cause.reason === "aborted") {
        throw new OpenAiDriverError("cancelled", "Provider response was cancelled")
      }
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider response is neither SSE nor valid JSON",
        response.status,
        undefined,
        { cause },
      )
    }
    await normalizer.consumeJsonResponse(value)
  }
  return normalizer.result()
}

class ResponseNormalizer {
  readonly #usage = new UsageAccumulator()
  readonly #pendingToolCalls = new Map<
    string,
    {
      itemId: string
      callId: string
      name: string
      argumentsJson: string
      outputIndex?: number
      emitted: boolean
    }
  >()
  readonly #toolCallKeysByOutputIndex = new Map<number, string>()
  readonly #toolCalls: OpenAiToolCall[] = []
  readonly #reasoningItems = new Map<string, OpenAiOpaqueReasoningItem>()
  #sequence = 0
  #eventCount = 0
  #finishReason: OpenAiFinishReason | undefined
  #lastProviderSequence: number | undefined

  constructor(private readonly sink: OpenAiEventSink) {}

  async raw(data: unknown, providerEvent?: string, providerEventId?: string): Promise<void> {
    await this.emit({
      type: "raw",
      sequence: this.nextSequence(),
      data,
      ...(providerEvent ? { providerEvent } : {}),
      ...(providerEventId ? { providerEventId } : {}),
    })
  }

  async consumeSseData(data: string, providerEvent?: string, sseEventId?: string): Promise<void> {
    if (responseByteLength(data) > OPENAI_MAX_RAW_EVENT_BYTES) {
      throw new OpenAiDriverError("protocol-drift", "Provider raw event exceeded the safe limit")
    }
    if (data === "[DONE]") {
      if (this.#finishReason) return
      await this.raw(data, providerEvent, sseEventId)
      await this.finish("stop", sseEventId)
      return
    }
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch (cause) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider SSE data is not valid JSON",
        undefined,
        undefined,
        { cause },
      )
    }
    const providerEventId = sseEventId ?? providerEventIdentifier(value)
    const valueEvent = isRecord(value) ? optionalString(value.type) : undefined
    if (providerEvent && valueEvent && providerEvent !== valueEvent) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider SSE event name does not match the JSON event type",
      )
    }
    this.observeProviderSequence(value)
    const eventType = valueEvent ?? providerEvent
    if (this.#finishReason) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider stream emitted an event after its terminal event",
      )
    }
    await this.raw(sanitizeProviderRawValue(value, eventType), providerEvent, providerEventId)
    if (isPrivateReasoningEventType(eventType)) return
    await this.consumeProviderEvent(value, providerEvent, providerEventId)
  }

  async consumeJsonResponse(value: unknown): Promise<void> {
    const providerEventId = providerEventIdentifier(value)
    await this.raw(sanitizeProviderRawValue(value), undefined, providerEventId)
    if (!isRecord(value)) {
      throw new OpenAiDriverError("protocol-drift", "Provider JSON response is not an object")
    }
    if (value.error !== undefined) await this.fail(value.error, providerEventId)

    const outputText = optionalString(value.output_text)
    if (outputText) await this.text(outputText, providerEventId)
    else if (Array.isArray(value.output)) await this.consumeOutput(value.output, providerEventId)

    if (value.usage !== undefined) await this.usage(value.usage, "final", providerEventId)
    const status = optionalString(value.status)
    if (!status) {
      throw new OpenAiDriverError("protocol-drift", "Provider JSON response omitted final status")
    }
    await this.assertEveryToolCallSettled()
    await this.finish(
      this.#toolCalls.length > 0 ? "tool-call" : normalizeFinishReason(status, value),
      providerEventId,
    )
  }

  async consumeProviderEvent(
    value: unknown,
    sseEvent?: string,
    providerEventId?: string,
  ): Promise<void> {
    if (!isRecord(value)) {
      throw new OpenAiDriverError("protocol-drift", "Provider stream event is not an object")
    }
    const type = optionalString(value.type) ?? sseEvent
    if (!type) {
      throw new OpenAiDriverError("protocol-drift", "Provider stream event omitted its type")
    }
    switch (type) {
      case "response.output_text.delta":
        await this.text(requiredString(value.delta, "text delta"), providerEventId)
        return
      case "response.reasoning_summary_text.delta":
        await this.reasoning(requiredString(value.delta, "reasoning delta"), providerEventId)
        return
      case "response.reasoning_text.delta":
        return
      case "response.output_item.added":
        await this.observeOutputItem(value.item, value.output_index, providerEventId)
        return
      case "response.function_call_arguments.delta":
        await this.toolInputDelta(value, providerEventId)
        return
      case "response.function_call_arguments.done":
        await this.finishToolArguments(value, providerEventId)
        return
      case "response.output_item.done":
        await this.finishOutputItem(value.item, value.output_index, providerEventId)
        return
      case "response.usage":
      case "response.usage.updated":
        await this.usage(value.usage ?? value, "cumulative", providerEventId)
        return
      case "response.usage.delta":
        await this.usage(value.usage ?? value, "delta", providerEventId)
        return
      case "response.completed": {
        const completed = isRecord(value.response) ? value.response : value
        if (Array.isArray(completed.output)) this.captureReasoningFromOutput(completed.output)
        if (completed.usage !== undefined)
          await this.usage(completed.usage, "final", providerEventId)
        await this.assertEveryToolCallSettled()
        await this.finish(this.#toolCalls.length > 0 ? "tool-call" : "stop", providerEventId)
        return
      }
      case "response.incomplete": {
        const incomplete = isRecord(value.response) ? value.response : value
        if (incomplete.usage !== undefined)
          await this.usage(incomplete.usage, "final", providerEventId)
        await this.finish(normalizeFinishReason("incomplete", incomplete), providerEventId)
        return
      }
      case "response.failed": {
        const failed = isRecord(value.response) ? value.response : value
        if (failed.usage !== undefined) await this.usage(failed.usage, "final", providerEventId)
        await this.fail(failed.error ?? value.error, providerEventId)
        return
      }
      case "error":
        await this.fail(value.error ?? value, providerEventId)
        return
      default:
        return
    }
  }

  result(): ResponseConsumption {
    if (!this.#finishReason) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider response ended without a finish event",
      )
    }
    return {
      eventCount: this.#eventCount,
      finishReason: this.#finishReason,
      usage: this.#usage.snapshot(),
      toolCalls: this.#toolCalls.map((call) => ({ ...call, input: { ...call.input } })),
      reasoningItems: [...this.#reasoningItems.values()].map((item) => ({
        ...item,
        summary: item.summary.map((entry) => structuredClone(entry)),
      })),
    }
  }

  private async consumeOutput(output: unknown[], providerEventId?: string): Promise<void> {
    for (const item of output) {
      if (!isRecord(item)) continue
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (!isRecord(content)) continue
          if (content.type === "output_text" && optionalString(content.text)) {
            await this.text(String(content.text), providerEventId)
          }
        }
      }
      if (item.type === "reasoning" && Array.isArray(item.summary)) {
        this.observeReasoningItem(item)
        for (const summary of item.summary) {
          if (!isRecord(summary)) continue
          const text = optionalString(summary.text)
          if (text) await this.reasoning(text, providerEventId)
        }
      }
      if (item.type === "function_call") {
        await this.finishOutputItem(item, undefined, providerEventId)
      }
    }
  }

  private async observeOutputItem(
    value: unknown,
    outputIndex: unknown,
    providerEventId?: string,
    allowExisting = false,
  ): Promise<void> {
    if (!isRecord(value)) return
    if (value.type === "reasoning") {
      this.observeReasoningItem(value)
      return
    }
    if (value.type !== "function_call") return
    const itemId = requiredIdentifier(value.id, "function call item id")
    const callId = requiredIdentifier(value.call_id, "function call id")
    const name = requiredIdentifier(value.name, "function name")
    const index = optionalSafeIndex(outputIndex)
    const existing = this.#pendingToolCalls.get(itemId)
    if (existing) {
      if (existing.callId !== callId || existing.name !== name || existing.outputIndex !== index) {
        throw new OpenAiDriverError("protocol-drift", "Provider changed a function call identity")
      }
      if (!allowExisting) {
        throw new OpenAiDriverError("protocol-drift", "Provider duplicated a function call item")
      }
      return
    }
    if ([...this.#pendingToolCalls.values()].some((candidate) => candidate.callId === callId)) {
      throw new OpenAiDriverError("protocol-drift", "Provider duplicated a function call id")
    }
    const argumentsJson = optionalString(value.arguments) ?? ""
    this.#pendingToolCalls.set(itemId, {
      itemId,
      callId,
      name,
      argumentsJson,
      ...(index === undefined ? {} : { outputIndex: index }),
      emitted: false,
    })
    if (index !== undefined) {
      if (this.#toolCallKeysByOutputIndex.has(index)) {
        throw new OpenAiDriverError(
          "protocol-drift",
          "Provider duplicated a function call output index",
        )
      }
      this.#toolCallKeysByOutputIndex.set(index, itemId)
    }
    if (argumentsJson) {
      await this.emit({
        type: "tool-input",
        sequence: this.nextSequence(),
        toolCallId: callId,
        delta: argumentsJson,
        ...(providerEventId ? { providerEventId } : {}),
      })
    }
  }

  private async toolInputDelta(
    value: Record<string, unknown>,
    providerEventId?: string,
  ): Promise<void> {
    const pending = this.resolvePendingToolCall(value)
    if (pending.emitted) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider emitted function arguments after the completed tool call",
      )
    }
    const delta = requiredString(value.delta, "function arguments delta")
    if (
      responseByteLength(pending.argumentsJson) + responseByteLength(delta) >
      OPENAI_MAX_RAW_EVENT_BYTES
    ) {
      throw new OpenAiDriverError("protocol-drift", "Function arguments exceeded the safe limit")
    }
    pending.argumentsJson += delta
    await this.emit({
      type: "tool-input",
      sequence: this.nextSequence(),
      toolCallId: pending.callId,
      delta,
      ...(providerEventId ? { providerEventId } : {}),
    })
  }

  private async finishToolArguments(
    value: Record<string, unknown>,
    providerEventId?: string,
  ): Promise<void> {
    const item = isRecord(value.item) ? value.item : undefined
    if (item) await this.observeOutputItem(item, value.output_index, providerEventId, true)
    const pending = this.resolvePendingToolCall(item ? { ...value, item_id: item.id } : value)
    const completedArguments = optionalString(value.arguments) ?? optionalString(item?.arguments)
    if (completedArguments !== undefined) {
      if (pending.argumentsJson && pending.argumentsJson !== completedArguments) {
        throw new OpenAiDriverError(
          "protocol-drift",
          "Provider function argument deltas do not match the completed arguments",
        )
      }
      pending.argumentsJson = completedArguments
    }
    await this.emitToolCall(pending, providerEventId)
  }

  private async finishOutputItem(
    value: unknown,
    outputIndex: unknown,
    providerEventId?: string,
  ): Promise<void> {
    if (!isRecord(value)) return
    if (value.type === "reasoning") {
      this.observeReasoningItem(value)
      return
    }
    if (value.type !== "function_call") return
    await this.observeOutputItem(value, outputIndex, providerEventId, true)
    const pending = this.resolvePendingToolCall({
      item_id: value.id,
      output_index: outputIndex,
    })
    const completedArguments = requiredString(value.arguments, "function arguments")
    if (pending.argumentsJson && pending.argumentsJson !== completedArguments) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider function argument deltas do not match the output item",
      )
    }
    pending.argumentsJson = completedArguments
    await this.emitToolCall(pending, providerEventId)
  }

  private resolvePendingToolCall(value: Record<string, unknown>) {
    const itemId = optionalString(value.item_id)
    const outputIndex = optionalSafeIndex(value.output_index)
    const key =
      itemId ??
      (outputIndex === undefined ? undefined : this.#toolCallKeysByOutputIndex.get(outputIndex))
    const pending = key ? this.#pendingToolCalls.get(key) : undefined
    if (!pending) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider function arguments referenced an unknown tool call",
      )
    }
    if (
      outputIndex !== undefined &&
      pending.outputIndex !== undefined &&
      pending.outputIndex !== outputIndex
    ) {
      throw new OpenAiDriverError("protocol-drift", "Provider changed a function call output index")
    }
    return pending
  }

  private async emitToolCall(
    pending: {
      itemId: string
      callId: string
      name: string
      argumentsJson: string
      emitted: boolean
    },
    providerEventId?: string,
  ): Promise<void> {
    if (pending.emitted) return
    let input: unknown
    try {
      input = JSON.parse(pending.argumentsJson)
    } catch (cause) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider function arguments are not valid JSON",
        undefined,
        undefined,
        { cause },
      )
    }
    if (!isRecord(input)) {
      throw new OpenAiDriverError("protocol-drift", "Provider function arguments must be an object")
    }
    const call: OpenAiToolCall = {
      itemId: pending.itemId,
      callId: pending.callId,
      name: pending.name,
      input,
      argumentsJson: pending.argumentsJson,
    }
    pending.emitted = true
    this.#toolCalls.push(call)
    await this.emit({
      type: "tool-call",
      sequence: this.nextSequence(),
      call,
      ...(providerEventId ? { providerEventId } : {}),
    })
  }

  private async assertEveryToolCallSettled(): Promise<void> {
    for (const pending of this.#pendingToolCalls.values()) {
      if (!pending.emitted) await this.emitToolCall(pending)
    }
  }

  private captureReasoningFromOutput(output: readonly unknown[]): void {
    for (const item of output) {
      if (isRecord(item) && item.type === "reasoning") this.observeReasoningItem(item)
    }
  }

  private observeReasoningItem(value: Record<string, unknown>): void {
    const encryptedContent = optionalString(value.encrypted_content)
    if (!encryptedContent) return
    if (responseByteLength(encryptedContent) > OPENAI_MAX_RAW_EVENT_BYTES) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Opaque reasoning continuation exceeded the safe limit",
      )
    }
    // Some compatible providers include an encrypted diagnostic field on a
    // reasoning-shaped item without an input-replay ID. It remains private and
    // is omitted rather than being treated as a usable continuation.
    if (!optionalString(value.id)) return
    const itemId = requiredIdentifier(value.id, "reasoning item id")
    const summary = Array.isArray(value.summary)
      ? value.summary.filter(isRecord).map((entry) => structuredClone(entry))
      : []
    const existing = this.#reasoningItems.get(itemId)
    if (existing && existing.encryptedContent !== encryptedContent) {
      throw new OpenAiDriverError("protocol-drift", "Provider changed opaque reasoning content")
    }
    this.#reasoningItems.set(itemId, {
      type: "reasoning",
      itemId,
      encryptedContent,
      summary,
    })
  }

  private async text(delta: string, providerEventId?: string): Promise<void> {
    if (delta)
      await this.emit({
        type: "text",
        sequence: this.nextSequence(),
        delta,
        ...(providerEventId ? { providerEventId } : {}),
      })
  }

  private async reasoning(delta: string, providerEventId?: string): Promise<void> {
    if (delta)
      await this.emit({
        type: "reasoning",
        sequence: this.nextSequence(),
        delta,
        ...(providerEventId ? { providerEventId } : {}),
      })
  }

  private async usage(
    value: unknown,
    semantics: UsageSemantics,
    providerEventId?: string,
  ): Promise<void> {
    const applied = this.#usage.apply(
      parseUsage(value, semantics, this.#usage.snapshot().reasoning),
      semantics,
    )
    if (applied) {
      await this.emit({
        type: "usage",
        sequence: this.nextSequence(),
        semantics,
        ...applied,
        ...(providerEventId ? { providerEventId } : {}),
      })
    }
  }

  private async finish(reason: OpenAiFinishReason, providerEventId?: string): Promise<void> {
    if (this.#finishReason) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider stream emitted more than one terminal event",
      )
    }
    this.#finishReason = reason
    await this.emit({
      type: "finish",
      sequence: this.nextSequence(),
      reason,
      ...(providerEventId ? { providerEventId } : {}),
    })
  }

  private async fail(value: unknown, providerEventId?: string): Promise<never> {
    const code = providerErrorCode(value)
    const error = new OpenAiDriverError("provider", "Provider stream reported an error")
    await this.emit({
      type: "error",
      sequence: this.nextSequence(),
      ...(providerEventId ? { providerEventId } : {}),
      error: {
        kind: error.kind,
        message: error.message,
        ...(code ? { code } : {}),
      },
    })
    throw error
  }

  private nextSequence(): number {
    this.#sequence += 1
    return this.#sequence
  }

  private async emit(event: OpenAiEvent): Promise<void> {
    if (this.#eventCount >= OPENAI_MAX_NORMALIZED_EVENTS) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider response exceeded the safe normalized event count limit",
      )
    }
    this.#eventCount += 1
    await this.sink(event)
  }

  private observeProviderSequence(value: unknown): void {
    if (!isRecord(value) || value.sequence_number === undefined) return
    const sequence = value.sequence_number
    if (!Number.isSafeInteger(sequence) || Number(sequence) < 0) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider stream sequence_number must be a non-negative safe integer",
      )
    }
    const providerSequence = Number(sequence)
    if (
      this.#lastProviderSequence !== undefined &&
      providerSequence <= this.#lastProviderSequence
    ) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider stream sequence_number is duplicated or out of order",
      )
    }
    this.#lastProviderSequence = providerSequence
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  normalizer: ResponseNormalizer,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffer = ""
  let totalBytes = 0
  const frameBudget = { count: 0 }
  let completed = false
  try {
    while (true) {
      if (signal?.aborted)
        throw new OpenAiDriverError("cancelled", "Provider response was cancelled")
      const result = await readStreamChunk(reader, signal, "Provider SSE response")
      if (result.done) {
        completed = true
        break
      }
      totalBytes += result.value.byteLength
      if (totalBytes > OPENAI_MAX_SSE_RESPONSE_BYTES) {
        throw new OpenAiDriverError(
          "protocol-drift",
          "Provider SSE response exceeded the safe total size limit",
        )
      }
      try {
        buffer += decoder.decode(result.value, { stream: true })
      } catch (cause) {
        throw new OpenAiDriverError(
          "protocol-drift",
          "Provider SSE response is not valid UTF-8",
          undefined,
          undefined,
          { cause },
        )
      }
      buffer = await drainSseFrames(buffer, normalizer, frameBudget)
      assertSseFrameLimit(buffer)
    }
    try {
      buffer += decoder.decode()
    } catch (cause) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider SSE response is not valid UTF-8",
        undefined,
        undefined,
        { cause },
      )
    }
    if (buffer.trim()) {
      observeSseFrame(frameBudget)
      assertSseFrameLimit(buffer)
      const parsed = parseSseFrame(buffer)
      if (parsed) await normalizer.consumeSseData(parsed.data, parsed.event, parsed.id)
    }
  } catch (cause) {
    if (cause instanceof ResponseBodyError && cause.reason === "aborted") {
      throw new OpenAiDriverError("cancelled", "Provider response was cancelled")
    }
    throw cause
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined)
    if (completed) reader.releaseLock()
  }
}

async function drainSseFrames(
  buffer: string,
  normalizer: ResponseNormalizer,
  budget: { count: number },
): Promise<string> {
  const separator = /\r?\n\r?\n/g
  let cursor = 0
  while (true) {
    const match = separator.exec(buffer)
    if (!match || match.index === undefined) return buffer.slice(cursor)
    const frame = buffer.slice(cursor, match.index)
    cursor = match.index + match[0].length
    separator.lastIndex = cursor
    observeSseFrame(budget)
    if (!frame.trim()) continue
    assertSseFrameLimit(frame)
    const parsed = parseSseFrame(frame)
    if (parsed) await normalizer.consumeSseData(parsed.data, parsed.event, parsed.id)
  }
}

function observeSseFrame(budget: { count: number }): void {
  budget.count += 1
  if (budget.count > OPENAI_MAX_SSE_FRAMES) {
    throw new OpenAiDriverError(
      "protocol-drift",
      "Provider SSE response exceeded the safe frame count limit",
    )
  }
}

function parseSseFrame(frame: string): { event?: string; id?: string; data: string } | undefined {
  let event: string | undefined
  let id: string | undefined
  const data: string[] = []
  for (const line of frame.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue
    const separator = line.indexOf(":")
    const field = separator === -1 ? line : line.slice(0, separator)
    let value = separator === -1 ? "" : line.slice(separator + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    if (field === "id" && !value.includes("\0")) id = safeProviderEventId(value)
    if (field === "data") data.push(value)
  }
  if (data.length === 0) return undefined
  return { ...(event ? { event } : {}), ...(id ? { id } : {}), data: data.join("\n") }
}

function assertSseFrameLimit(value: string): void {
  if (responseByteLength(value) > OPENAI_MAX_SSE_FRAME_BYTES) {
    throw new OpenAiDriverError("protocol-drift", "Provider SSE frame exceeded the safe size limit")
  }
}

function providerEventIdentifier(value: unknown): string | undefined {
  return isRecord(value) ? safeProviderEventId(value.id) : undefined
}

function safeProviderEventId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !hasControlCharacter(value)
    ? value
    : undefined
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}

function normalizeFinishReason(
  status: string,
  value?: Record<string, unknown>,
): OpenAiFinishReason {
  const normalized = status.toLowerCase().replace(/[._ ]+/g, "-")
  const incomplete = isRecord(value?.incomplete_details)
    ? optionalString(value.incomplete_details.reason)
    : undefined
  const detail = incomplete?.toLowerCase().replace(/[._ ]+/g, "-")
  if (normalized === "completed" || normalized === "stop" || normalized === "end-turn") {
    return "stop"
  }
  if (normalized === "incomplete") {
    if (detail === "content-filter" || detail === "content-filtered") return "content-filter"
    if (["length", "max-tokens", "max-output", "max-output-tokens"].includes(detail ?? "")) {
      return "length"
    }
    return "unknown"
  }
  if (
    normalized === "length" ||
    normalized === "max-output" ||
    normalized === "max-output-tokens" ||
    detail === "max-output" ||
    detail === "max-output-tokens"
  ) {
    return "length"
  }
  if (["tool-call", "tool-calls", "function-call"].includes(normalized)) return "tool-call"
  if (["content-filter", "content-filtered"].includes(normalized)) return "content-filter"
  if (["error", "failed", "failure"].includes(normalized)) return "error"
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled"
  return "unknown"
}

function sanitizeProviderRawValue(value: unknown, rootEventType?: string): unknown {
  let nodes = 0
  const clone = (entry: unknown): unknown =>
    Array.isArray(entry) ? [] : isRecord(entry) ? {} : entry
  const output = clone(value)
  const stack: Array<{
    source: unknown
    target: unknown
    depth: number
    forcedType?: string
  }> = [
    {
      source: value,
      target: output,
      depth: 0,
      ...(rootEventType ? { forcedType: rootEventType } : {}),
    },
  ]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    nodes += 1
    if (nodes > OPENAI_MAX_STRUCTURED_NODES) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider response exceeded the safe structured node count limit",
      )
    }
    if (current.depth > OPENAI_MAX_STRUCTURED_DEPTH) {
      throw new OpenAiDriverError(
        "protocol-drift",
        "Provider response exceeded the safe structured depth limit",
      )
    }
    if (Array.isArray(current.source) && Array.isArray(current.target)) {
      for (const entry of current.source) {
        const child = clone(entry)
        current.target.push(child)
        if (Array.isArray(entry) || isRecord(entry)) {
          stack.push({ source: entry, target: child, depth: current.depth + 1 })
        } else {
          nodes += 1
          if (nodes > OPENAI_MAX_STRUCTURED_NODES) {
            throw new OpenAiDriverError(
              "protocol-drift",
              "Provider response exceeded the safe structured node count limit",
            )
          }
        }
      }
      continue
    }
    if (!isRecord(current.source) || !isRecord(current.target)) continue
    const type = optionalString(current.source.type) ?? current.forcedType
    for (const [key, entry] of Object.entries(current.source)) {
      if (isPrivateReasoningField(type, key)) {
        defineRecordValue(current.target, key, PRIVATE_REASONING_OMITTED)
        nodes += 1
        if (nodes > OPENAI_MAX_STRUCTURED_NODES) {
          throw new OpenAiDriverError(
            "protocol-drift",
            "Provider response exceeded the safe structured node count limit",
          )
        }
        continue
      }
      const child = clone(entry)
      defineRecordValue(current.target, key, child)
      if (Array.isArray(entry) || isRecord(entry)) {
        stack.push({ source: entry, target: child, depth: current.depth + 1 })
      } else {
        nodes += 1
        if (nodes > OPENAI_MAX_STRUCTURED_NODES) {
          throw new OpenAiDriverError(
            "protocol-drift",
            "Provider response exceeded the safe structured node count limit",
          )
        }
      }
    }
  }
  return output
}

function isPrivateReasoningEventType(value: string | undefined): boolean {
  return value === "reasoning_text" || value?.startsWith("response.reasoning_text.") === true
}

function isPrivateReasoningField(type: string | undefined, key: string): boolean {
  if (key === "encrypted_content" || key === "reasoning_text") return true
  if (type === "reasoning" && ["content", "delta", "text"].includes(key)) return true
  return isPrivateReasoningEventType(type) && ["content", "delta", "text"].includes(key)
}

function defineRecordValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function parseUsage(
  value: unknown,
  semantics: UsageSemantics,
  priorReasoning?: number,
): TokenUsage {
  if (!isRecord(value))
    throw new OpenAiDriverError("protocol-drift", "Provider usage is not an object")
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined
  const outputDetails = isRecord(value.output_tokens_details)
    ? value.output_tokens_details
    : undefined
  const inclusiveOutput = optionalCount("output", value.output_tokens).output
  const reasoning = optionalCount("reasoning", outputDetails?.reasoning_tokens).reasoning
  if (semantics === "final" && reasoning === undefined && priorReasoning !== undefined) {
    throw new OpenAiDriverError(
      "protocol-drift",
      "Final provider usage omitted reasoning after reporting it cumulatively",
    )
  }
  const reasoningForOutput = reasoning
  if (
    inclusiveOutput !== undefined &&
    reasoningForOutput !== undefined &&
    reasoningForOutput > inclusiveOutput
  ) {
    throw new OpenAiDriverError(
      "protocol-drift",
      "Provider reasoning usage exceeds inclusive output usage",
    )
  }
  const usage: TokenUsage = {
    ...optionalCount("input", value.input_tokens),
    // Responses output_tokens includes reasoning when the provider also
    // reports output_tokens_details.reasoning_tokens. Compatible providers
    // are allowed to emit usage deltas without that optional breakdown; in
    // that case the whole delta is visible output rather than an unknown
    // counter that gets silently discarded.
    ...(inclusiveOutput === undefined
      ? {}
      : { output: inclusiveOutput - (reasoningForOutput ?? 0) }),
    ...optionalCount("total", value.total_tokens),
    ...optionalCount("cacheRead", inputDetails?.cached_tokens),
    ...optionalCount("cacheWrite", inputDetails?.cache_write_tokens),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
  if (Object.keys(usage).length === 0) {
    throw new OpenAiDriverError("protocol-drift", "Provider usage has no recognized counters")
  }
  if (
    usage.total !== undefined &&
    usage.input !== undefined &&
    usage.output !== undefined &&
    usage.total !== usage.input + usage.output + (reasoningForOutput ?? 0)
  ) {
    throw new OpenAiDriverError("protocol-drift", "Provider total usage is internally inconsistent")
  }
  return usage
}

function optionalCount<Key extends UsageFields>(key: Key, value: unknown): Partial<TokenUsage> {
  if (value === undefined) return {}
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OpenAiDriverError("protocol-drift", `Provider usage field ${key} is invalid`)
  }
  return { [key]: value }
}

function assertTokenCount(field: UsageFields, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OpenAiDriverError("protocol-drift", `Provider usage field ${field} is invalid`)
  }
}

function providerErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const code = optionalString(value.code) ?? optionalString(value.type)
  return code && /^[A-Za-z0-9._:-]{1,128}$/.test(code) ? code : undefined
}

function requiredString(value: unknown, field: string): string {
  const text = optionalString(value)
  if (!text) throw new OpenAiDriverError("protocol-drift", `Provider ${field} is invalid`)
  return text
}

function requiredIdentifier(value: unknown, field: string): string {
  const text = requiredString(value, field)
  if (
    text.length > 512 ||
    [...text].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint === undefined || codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
    })
  ) {
    throw new OpenAiDriverError("protocol-drift", `Provider ${field} is invalid`)
  }
  return text
}

function optionalSafeIndex(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new OpenAiDriverError("protocol-drift", "Provider function output index is invalid")
  }
  return Number(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
