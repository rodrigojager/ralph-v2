import { type JudgeOutput, JudgeOutputSchema } from "@ralph-next/domain"
import type {
  JudgeBackend,
  JudgeBackendCapabilities,
  JudgeCallHandle,
  JudgeEventSink,
  JudgeRequest,
} from "@ralph-next/evaluation"
import {
  type ModelParameters,
  type ModelRef,
  type ProviderDriver,
  type ProviderEvent,
  type ProviderJsonObject,
  ProviderModelResultSchema,
} from "@ralph-next/providers"

const JUDGE_OUTPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    score: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string", minLength: 1 },
    adequate: { type: "array", items: { type: "string", minLength: 1 } },
    problems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["info", "minor", "major", "critical"] },
          criterion: { type: "string", minLength: 1 },
          message: { type: "string", minLength: 1 },
          evidenceRefs: { type: "array", items: { type: "string", minLength: 1 } },
        },
        required: ["severity", "criterion", "message", "evidenceRefs"],
        additionalProperties: false,
      },
    },
    missingEvidence: { type: "array", items: { type: "string", minLength: 1 } },
    recommendations: { type: "array", items: { type: "string", minLength: 1 } },
    criterionScores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string", minLength: 1 },
          score: { type: "integer", minimum: 0, maximum: 100 },
          rationale: { type: "string", minLength: 1 },
        },
        required: ["criterion", "score", "rationale"],
        additionalProperties: false,
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "schemaVersion",
    "score",
    "summary",
    "adequate",
    "problems",
    "missingEvidence",
    "recommendations",
    "criterionScores",
    "confidence",
  ],
  additionalProperties: false,
} satisfies ProviderJsonObject

export type EmbeddedJudgeBackendOptions = {
  id: string
  driver: ProviderDriver
  model: ModelRef
  parameters?: ModelParameters
  maxOutputTokens?: number
  structuredOutput?: boolean
  usage?: "reported" | "estimated" | "unavailable"
}

type ActiveJudgeCall = {
  controller: AbortController
  detachSignal?: () => void
}

type EmbeddedJudgeCallResult = {
  output: JudgeOutput
  rawResponseRef?: string
}

function eventLevel(level: ProviderEvent["level"]): "debug" | "info" | "warning" | "error" {
  if (level === "error") return "error"
  if (level === "warn") return "warning"
  if (level === "debug" || level === "trace") return "debug"
  return "info"
}

function cancellationReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error && signal.reason.message.trim()) return signal.reason.message
  if (typeof signal.reason === "string" && signal.reason.trim()) return signal.reason
  return "Judge evaluation was cancelled"
}

function parseJudgeOutput(text: string | undefined): JudgeOutput {
  if (!text) throw new Error("Embedded judge finished without a JSON assessment")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error("Embedded judge output is not one valid JSON object", { cause })
  }
  return JudgeOutputSchema.parse(value)
}

function providerRawResponseRef(event: ProviderEvent): string | undefined {
  const payload: unknown = event.payload
  if (!payload || typeof payload !== "object" || !("rawRef" in payload)) return undefined
  const rawRef = payload.rawRef
  return typeof rawRef === "string" && rawRef.trim() ? rawRef : undefined
}

/** A single read-only provider call. Tools and workspace handles are never accepted or forwarded. */
export class EmbeddedJudgeBackend implements JudgeBackend {
  readonly id: string
  readonly #active = new Map<string, ActiveJudgeCall>()

  constructor(private readonly options: EmbeddedJudgeBackendOptions) {
    if (!options.id.trim()) throw new Error("Embedded judge backend id is required")
    this.id = options.id
  }

  capabilities(): JudgeBackendCapabilities {
    return {
      streaming: true,
      cancellation: true,
      structuredOutput: this.options.structuredOutput ?? true,
      usage: this.options.usage ?? "reported",
      toolCalling: "unavailable",
      mutationMode: "read-only",
    }
  }

  async start(request: JudgeRequest, sink: JudgeEventSink): Promise<JudgeCallHandle> {
    if (!request.callId.trim()) throw new Error("Judge call id is required")
    if (this.#active.has(request.callId)) {
      throw new Error(`Embedded judge call is already active: ${request.callId}`)
    }
    const active: ActiveJudgeCall = { controller: new AbortController() }
    this.#active.set(request.callId, active)
    if (request.signal) {
      const cancel = (): void => {
        void this.#cancel(request.callId, cancellationReason(request.signal as AbortSignal)).catch(
          () => undefined,
        )
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
    await this.options.driver.cancel(callId, reason)
  }

  async #run(
    request: JudgeRequest,
    sink: JudgeEventSink,
    active: ActiveJudgeCall,
  ): Promise<EmbeddedJudgeCallResult> {
    if (active.controller.signal.aborted) throw active.controller.signal.reason
    let rawResponseRef: string | undefined
    const result = ProviderModelResultSchema.parse(
      await this.options.driver.invoke(
        {
          schemaVersion: 1,
          callId: request.callId,
          model: this.options.model,
          input: [
            { type: "message", role: "system", content: request.prompt.system },
            { type: "message", role: "user", content: request.prompt.user },
          ],
          tools: [],
          parameters: this.options.parameters ?? {},
          ...(this.options.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: this.options.maxOutputTokens }),
          responseFormat: "json",
          responseSchema: {
            name: "ralph_judge_output_v1",
            schema: JUDGE_OUTPUT_JSON_SCHEMA,
            strict: true,
          },
        },
        {
          emit: (event) => {
            rawResponseRef = providerRawResponseRef(event) ?? rawResponseRef
            return sink.emit({
              type: event.type,
              level: eventLevel(event.level),
              payload: event,
            })
          },
        },
      ),
    )
    if (result.status !== "succeeded") {
      throw new Error(`Embedded judge provider call ${request.callId} ${result.status}`)
    }
    if (result.finishReason === "tool-call" || result.toolCalls.length > 0) {
      throw new Error("Judge attempted a tool call, but judge evaluation is strictly read-only")
    }
    return {
      output: parseJudgeOutput(result.text),
      ...(rawResponseRef ? { rawResponseRef } : {}),
    }
  }
}
