import type { JudgeKind } from "@ralph/evaluation"
import { ProviderEventSchema } from "@ralph/providers"

const MAX_OUTPUT_REFERENCES = 64
const MAX_OUTPUT_REFERENCE_LENGTH = 32_768

/**
 * Preserves the original backend payload for durable protocol inspection while
 * promoting only a small, explicit set of display/usage/raw-reference fields.
 * Consumers must never recursively treat arbitrary backend JSON as authority
 * for raw capture selection.
 */
export function normalizeJudgeBackendEventPayload(
  value: unknown,
  kind: JudgeKind,
  callId: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = { callId, kind, backendPayload: value }
  const parsed = ProviderEventSchema.safeParse(value)
  if (!parsed.success) {
    const payload =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined
    if (!payload) return base
    const outputRefs = Array.isArray(payload.outputRefs)
      ? payload.outputRefs
          .filter(
            (reference): reference is string =>
              typeof reference === "string" &&
              reference.length > 0 &&
              reference.length <= MAX_OUTPUT_REFERENCE_LENGTH,
          )
          .slice(0, MAX_OUTPUT_REFERENCES)
      : undefined
    return {
      ...base,
      ...(typeof payload.delta === "string" ? { delta: payload.delta } : {}),
      ...(typeof payload.text === "string" ? { text: payload.text } : {}),
      ...(typeof payload.output === "string" ? { output: payload.output } : {}),
      ...(typeof payload.content === "string" ? { content: payload.content } : {}),
      ...(typeof payload.rawRef === "string" ? { rawRef: payload.rawRef } : {}),
      ...(outputRefs && outputRefs.length > 0 ? { outputRefs } : {}),
      ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
      ...(typeof payload.finishReason === "string" ? { finishReason: payload.finishReason } : {}),
    }
  }

  const providerEvent = parsed.data
  const providerPayload = providerEvent.payload as Record<string, unknown>
  return {
    ...base,
    providerCallId: providerEvent.callId,
    providerEventId: providerEvent.providerEventId ?? providerEvent.eventId,
    ...(providerPayload.usage !== undefined ? { usage: providerPayload.usage } : {}),
    ...(typeof providerPayload.rawRef === "string"
      ? { providerRawRef: providerPayload.rawRef }
      : {}),
    ...(typeof providerPayload.delta === "string" ? { delta: providerPayload.delta } : {}),
    ...(typeof providerPayload.text === "string" ? { text: providerPayload.text } : {}),
    ...(typeof providerPayload.summary === "string" ? { reasoning: providerPayload.summary } : {}),
    ...(typeof providerPayload.output === "string" ? { output: providerPayload.output } : {}),
    ...(typeof providerPayload.content === "string" ? { content: providerPayload.content } : {}),
    ...(typeof providerPayload.finishReason === "string"
      ? { finishReason: providerPayload.finishReason }
      : {}),
  }
}
