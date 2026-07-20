import { RalphError } from "@ralph-next/domain"
import type {
  ModelInvokeOptions,
  OpenAiEvent,
  OpenAiEventSink,
  OpenAiModelRequest,
  OpenAiOpaqueReasoningItem,
  ResponseConsumption,
} from "@ralph-next/openai-driver"
import { OpenAiDriverError } from "@ralph-next/openai-driver"
import {
  type ModelAccess,
  type ModelInfo,
  ModelInfoSchema,
  type ProviderDriver,
  type ProviderEventSink,
  type ProviderInfo,
  ProviderInfoSchema,
  type ProviderModelInput,
  type ProviderModelRequest,
  ProviderModelRequestSchema,
  type ProviderModelResult,
  ProviderModelResultSchema,
} from "@ralph-next/providers"
import { redactText, redactValue } from "@ralph-next/telemetry"

import { OpenAiRawCaptureRedactor } from "./incremental-redactor"
import { OpenAiStrictToolCodec } from "./openai-strict-tools"
import {
  OpenAiProviderStreamAdapter,
  type ProviderCatalogProvenance,
} from "./provider-stream-adapter"

export interface OpenAiModelInvoker {
  invoke(
    request: OpenAiModelRequest,
    sink: OpenAiEventSink,
    options?: ModelInvokeOptions,
  ): Promise<ResponseConsumption>
}

export type OpenAiInvokerLease = {
  withInvoker<T>(
    consumer: (invoker: OpenAiModelInvoker, secrets: readonly string[]) => Promise<T>,
  ): Promise<T>
}

export type RawModelCallDescriptor = {
  callId: string
  provider: string
  model: string
  request: ProviderModelRequest
}

export interface RawModelCapture {
  readonly ref: string
  append(event: unknown): void | Promise<void>
  close(result: {
    status: "succeeded" | "failed" | "cancelled"
    error?: string
  }): void | Promise<void>
}

export interface RawModelCaptureFactory {
  open(descriptor: RawModelCallDescriptor): Promise<RawModelCapture>
}

export type OpenAiProviderDriverOptions = {
  provider: ProviderInfo
  models: readonly ModelInfo[]
  lease: OpenAiInvokerLease
  /** Omitted when command-owned telemetry policy forbids raw persistence. */
  raw?: RawModelCaptureFactory
  /** Exact credential access selected by the command-owned profile resolver. */
  access?: ModelAccess
  /** Immutable catalog provenance pinned when the backend was composed. */
  catalog?: ProviderCatalogProvenance
  timeoutMs?: number
  now?: () => number
}

function continuationKey(itemId: string, callId: string): string {
  return `${itemId}\0${callId}`
}

function mapInput(
  request: ProviderModelRequest,
  tools: OpenAiStrictToolCodec,
  continuations: ReadonlyMap<string, readonly OpenAiOpaqueReasoningItem[]>,
): {
  instructions?: string
  input: OpenAiModelRequest["input"]
  consumedContinuationKeys: readonly string[]
} {
  const source: readonly ProviderModelInput[] = request.input
    ? request.input
    : (request.messages ?? []).map((message) => ({ type: "message" as const, ...message }))
  const instructions: string[] = []
  const input: Array<OpenAiModelRequest["input"][number]> = []
  const consumedContinuationKeys = new Set<string>()
  for (const item of source) {
    if (item.type === "message") {
      if (item.role === "system") instructions.push(item.content)
      else input.push({ type: "message", role: item.role, content: item.content })
      continue
    }
    if (item.type === "function-call") {
      const key = continuationKey(item.itemId, item.callId)
      const opaqueItems = continuations.get(key) ?? []
      if (!consumedContinuationKeys.has(key)) {
        for (const opaque of opaqueItems) {
          input.push({
            ...opaque,
            summary: opaque.summary.map((entry) => structuredClone(entry)),
          })
        }
        consumedContinuationKeys.add(key)
      }
      const encoded = tools.encodeFunctionCall({
        name: item.name,
        argumentsJson: item.argumentsJson,
      })
      input.push({
        type: "function_call",
        itemId: item.itemId,
        callId: item.callId,
        name: encoded.name,
        argumentsJson: encoded.argumentsJson,
      })
      continue
    }
    input.push({ type: "function_call_output", callId: item.callId, output: item.output })
  }
  if (request.responseFormat === "json") {
    instructions.push("Return the final response as exactly one valid JSON object without fences.")
  }
  return {
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    input,
    consumedContinuationKeys: [...consumedContinuationKeys],
  }
}

function mapRequest(
  request: ProviderModelRequest,
  tools: OpenAiStrictToolCodec,
  continuations: ReadonlyMap<string, readonly OpenAiOpaqueReasoningItem[]>,
  structuredOutput: boolean,
): { request: OpenAiModelRequest; consumedContinuationKeys: readonly string[] } {
  const mapped = mapInput(request, tools, continuations)
  return {
    consumedContinuationKeys: mapped.consumedContinuationKeys,
    request: {
      model: request.model.model,
      ...(mapped.instructions ? { instructions: mapped.instructions } : {}),
      input: mapped.input,
      tools: tools.tools,
      parameters: request.parameters,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.responseFormat === "json"
        ? {
            textFormat:
              structuredOutput && request.responseSchema
                ? {
                    type: "json_schema" as const,
                    name: request.responseSchema.name,
                    schema: request.responseSchema.schema,
                    strict: request.responseSchema.strict,
                  }
                : { type: "json_object" as const },
          }
        : {}),
    },
  }
}

function sanitizedError(error: unknown, secrets: readonly string[]): Error {
  const message = redactText(error instanceof Error ? error.message : String(error), secrets)
  if (error instanceof RalphError) {
    return new RalphError(error.code, message, {
      exitCode: error.exitCode,
      severity: error.diagnostic.severity,
      ...(error.diagnostic.hint ? { hint: redactText(error.diagnostic.hint, secrets) } : {}),
      ...(error.diagnostic.file ? { file: redactText(error.diagnostic.file, secrets) } : {}),
      ...(error.diagnostic.line !== undefined ? { line: error.diagnostic.line } : {}),
      ...(error.diagnostic.column !== undefined ? { column: error.diagnostic.column } : {}),
      ...(error.diagnostic.details !== undefined
        ? {
            details: redactValue(error.diagnostic.details, secrets) as Record<string, unknown>,
          }
        : {}),
      cause: error,
    })
  }
  if (error instanceof OpenAiDriverError) {
    return new OpenAiDriverError(error.kind, message, error.status, error.retryAfterMs)
  }
  const output = new Error(message)
  output.name = error instanceof Error ? error.name : "Error"
  return output
}

/**
 * One provider call only. This adapter normalizes transport events and reports
 * tool requests, but deliberately cannot execute tools or mutate Ralph state.
 */
export class OpenAiProviderDriver implements ProviderDriver {
  readonly id: string
  readonly #provider: ProviderInfo
  readonly #models: readonly ModelInfo[]
  readonly #active = new Map<string, AbortController>()
  readonly #continuations = new Map<string, readonly OpenAiOpaqueReasoningItem[]>()
  readonly #now: () => number

  constructor(private readonly options: OpenAiProviderDriverOptions) {
    this.#provider = ProviderInfoSchema.parse(options.provider)
    this.#models = options.models.map((model) => ModelInfoSchema.parse(model))
    if (this.#models.some((model) => model.provider !== this.#provider.id)) {
      throw new Error("OpenAI provider driver models must belong to its provider")
    }
    if (options.access && !this.#provider.access.includes(options.access)) {
      throw new Error(`OpenAI provider does not support ${options.access} access`)
    }
    this.id = this.#provider.id
    this.#now = options.now ?? Date.now
  }

  async info(): Promise<ProviderInfo> {
    return structuredClone(this.#provider)
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return this.#models.map((model) => structuredClone(model))
  }

  credentialDriver(): undefined {
    return undefined
  }

  async invoke(
    requestInput: ProviderModelRequest,
    sink: ProviderEventSink,
  ): Promise<ProviderModelResult> {
    const request = ProviderModelRequestSchema.parse(requestInput)
    if (request.model.provider !== this.id) {
      throw new Error(`Provider request ${request.model.provider} does not match ${this.id}`)
    }
    const selectedModel = this.#models.find((model) => model.id === request.model.model)
    if (!selectedModel) {
      throw new Error(`Model is not registered by ${this.id}: ${request.model.model}`)
    }
    if (this.options.access && !selectedModel.access.includes(this.options.access)) {
      throw new Error(
        `Model does not support ${this.options.access} access: ${request.model.model}`,
      )
    }
    if (this.#active.has(request.callId))
      throw new Error(`Provider call is already active: ${request.callId}`)

    const capture = this.options.raw
      ? await this.options.raw.open({
          callId: request.callId,
          provider: this.id,
          model: request.model.model,
          request,
        })
      : undefined
    const controller = new AbortController()
    this.#active.set(request.callId, controller)
    let secrets: readonly string[] = []
    const access = this.options.access
    const createStreamAdapter = (adapterSecrets: readonly string[]) =>
      new OpenAiProviderStreamAdapter({
        callId: request.callId,
        ...(capture ? { rawRef: capture.ref } : {}),
        secrets: adapterSecrets,
        now: this.#now,
        ...(this.options.catalog ? { catalog: this.options.catalog } : {}),
        ...(access
          ? {
              pricing: {
                price: selectedModel.price,
                access,
                usageMetrics: selectedModel.capabilities.usage,
              },
            }
          : {}),
      })
    let adapter: OpenAiProviderStreamAdapter | undefined
    let rawRedactor: OpenAiRawCaptureRedactor | undefined
    let rawFlushed = false
    const flushRawCapture = async (): Promise<void> => {
      if (!capture || !rawRedactor || rawFlushed) return
      rawFlushed = true
      for (const event of rawRedactor.flush()) await capture.append(event)
    }
    let failure: unknown
    let result: ProviderModelResult | undefined
    let consumption: ResponseConsumption | undefined
    let consumedContinuationKeys: readonly string[] = []
    try {
      const toolCodec = new OpenAiStrictToolCodec(request.tools)
      const mapped = mapRequest(
        request,
        toolCodec,
        this.#continuations,
        selectedModel.capabilities.structuredOutput,
      )
      consumedContinuationKeys = mapped.consumedContinuationKeys
      await this.options.lease.withInvoker(async (invoker, leasedSecrets) => {
        secrets = [...leasedSecrets]
        rawRedactor = capture ? new OpenAiRawCaptureRedactor(secrets) : undefined
        adapter = createStreamAdapter(secrets)
        const eventSink: OpenAiEventSink = async (event: OpenAiEvent) => {
          if (capture) {
            await capture.append(rawRedactor?.redact(event) ?? redactValue(event, secrets))
          }
          const normalizedSource =
            event.type === "tool-call"
              ? { ...event, call: toolCodec.decodeToolCall(event.call) }
              : event
          for (const normalized of adapter?.accept(normalizedSource) ?? []) {
            await sink.emit(normalized)
          }
        }
        consumption = await invoker.invoke(mapped.request, eventSink, {
          signal: controller.signal,
          ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
        })
      })
      if (!adapter) throw new Error("OpenAI invoker lease returned without an invocation")
      const summary = adapter.summary()
      result = ProviderModelResultSchema.parse({
        schemaVersion: 1,
        callId: request.callId,
        status: "succeeded",
        finishReason: summary.finishReason,
        ...(summary.text ? { text: summary.text } : {}),
        ...(summary.reasoningSummary ? { reasoningSummary: summary.reasoningSummary } : {}),
        usage: summary.usage,
        toolCalls: summary.toolCalls.map((call) => ({
          itemId: call.itemId,
          callId: call.callId,
          name: call.name,
          argumentsJson: call.argumentsJson,
          input: call.input,
        })),
      })
    } catch (error) {
      failure = error
      const failedAdapter = adapter ?? createStreamAdapter(secrets)
      try {
        for (const normalized of failedAdapter.fail(error)) await sink.emit(normalized)
      } catch {
        // A failed observer must never prevent raw capture settlement.
      }
    } finally {
      try {
        await flushRawCapture()
      } catch (error) {
        failure ??= error
      }
      const status = failure ? (controller.signal.aborted ? "cancelled" : "failed") : "succeeded"
      if (capture) {
        try {
          await capture.close({
            status,
            ...(failure
              ? {
                  error: redactText(
                    failure instanceof Error ? failure.message : String(failure),
                    secrets,
                  ),
                }
              : {}),
          })
        } catch (error) {
          failure ??= error
        }
      }
      this.#active.delete(request.callId)
    }
    if (failure) throw sanitizedError(failure, secrets)
    if (!result || !consumption) throw new Error("OpenAI invocation settled without a result")
    for (const key of consumedContinuationKeys) this.#continuations.delete(key)
    if (consumption.reasoningItems.length > 0) {
      const opaque = consumption.reasoningItems.map((item) => ({
        ...item,
        summary: item.summary.map((entry) => structuredClone(entry)),
      }))
      for (const call of result.toolCalls) {
        this.#continuations.set(continuationKey(call.itemId, call.callId), opaque)
      }
    }
    return result
  }

  async cancel(callId: string, reason: string): Promise<void> {
    this.#active.get(callId)?.abort(new Error(reason))
  }
}
