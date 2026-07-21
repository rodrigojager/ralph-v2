import type { OpenAiEvent } from "@ralph/openai-driver"
import { REDACTED, redactText, redactValue } from "@ralph/telemetry"

type PendingStream = {
  channel: string
  value: string
}

/**
 * Redacts known secret values without assuming that provider deltas align with
 * secret boundaries. A suffix that could still become a secret is retained
 * until a later delta proves it safe or completes the secret.
 */
export class IncrementalTextRedactor {
  readonly #secrets: readonly string[]
  readonly #pending = new Map<string, string>()

  constructor(secrets: readonly string[]) {
    this.#secrets = [...new Set(secrets.filter((secret) => secret.length >= 4))].sort(
      (left, right) => right.length - left.length,
    )
  }

  push(channel: string, delta: string): string {
    const combined = `${this.#pending.get(channel) ?? ""}${delta}`
    if (this.#secrets.length === 0) return redactText(combined)

    let safeEnd = combined.length - this.#unsafeSuffixLength(combined)
    safeEnd = this.#avoidSplittingCompleteSecret(combined, safeEnd)
    const safe = combined.slice(0, safeEnd)
    const pending = combined.slice(safeEnd)
    if (pending.length > 0) this.#pending.set(channel, pending)
    else this.#pending.delete(channel)
    return redactText(safe, this.#secrets)
  }

  flush(channel: string): string {
    const pending = this.#pending.get(channel) ?? ""
    this.#pending.delete(channel)
    if (pending.length === 0) return ""

    const unsafeLength = this.#unsafeSuffixLength(pending)
    if (unsafeLength === 0) return redactText(pending, this.#secrets)
    const safe = pending.slice(0, pending.length - unsafeLength)
    return `${redactText(safe, this.#secrets)}${REDACTED}`
  }

  flushAll(): readonly PendingStream[] {
    return [...this.#pending.keys()]
      .sort()
      .map((channel) => ({ channel, value: this.flush(channel) }))
      .filter((entry) => entry.value.length > 0)
  }

  #unsafeSuffixLength(value: string): number {
    let longest = 0
    for (const secret of this.#secrets) {
      const limit = Math.min(secret.length - 1, value.length)
      for (let length = limit; length > longest; length -= 1) {
        if (value.endsWith(secret.slice(0, length))) {
          longest = length
          break
        }
      }
    }
    return longest
  }

  #avoidSplittingCompleteSecret(value: string, initialSafeEnd: number): number {
    let safeEnd = initialSafeEnd
    let changed = true
    while (changed) {
      changed = false
      for (const secret of this.#secrets) {
        let start = value.indexOf(secret)
        while (start >= 0) {
          const end = start + secret.length
          if (start < safeEnd && end > safeEnd) {
            safeEnd = start
            changed = true
          }
          start = value.indexOf(secret, start + 1)
        }
      }
    }
    return safeEnd
  }
}

const STREAM_VALUE_KEY = /^(?:arguments|arguments_json|content|delta|message|output|text)$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rawIdentity(value: unknown): string {
  if (!isRecord(value)) return "unknown"
  return [value.type, value.call_id, value.item_id, value.output_index]
    .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
    .map(String)
    .join(":")
}

/** Redacts both normalized events and the provider-native payloads retained by raw capture. */
export class OpenAiRawCaptureRedactor {
  readonly #streams: IncrementalTextRedactor
  readonly #secrets: readonly string[]

  constructor(secrets: readonly string[]) {
    this.#secrets = [...secrets]
    this.#streams = new IncrementalTextRedactor(secrets)
  }

  redact(event: OpenAiEvent): OpenAiEvent {
    if (event.type === "text" || event.type === "reasoning") {
      return {
        ...event,
        delta: this.#streams.push(`normalized:${event.type}`, event.delta),
      }
    }
    if (event.type === "tool-input") {
      return {
        ...event,
        delta: this.#streams.push(`normalized:tool-input:${event.toolCallId}`, event.delta),
      }
    }
    if (event.type === "raw") {
      const identity = rawIdentity(event.data)
      return {
        ...event,
        ...(event.providerEvent
          ? { providerEvent: redactText(event.providerEvent, this.#secrets) }
          : {}),
        ...(event.providerEventId
          ? { providerEventId: redactText(event.providerEventId, this.#secrets) }
          : {}),
        data: this.#redactRawValue(event.data, `raw:${identity}`, []),
      }
    }
    return redactValue(event, this.#secrets) as OpenAiEvent
  }

  flush(): readonly unknown[] {
    return this.#streams.flushAll().map((entry) => ({
      schemaVersion: 1,
      type: "redaction.stream.flush",
      stream: redactText(entry.channel, this.#secrets),
      value: entry.value,
    }))
  }

  #redactRawValue(value: unknown, channel: string, path: readonly string[]): unknown {
    if (typeof value === "string") {
      const key = path.at(-1) ?? ""
      return STREAM_VALUE_KEY.test(key)
        ? this.#streams.push(
            `${channel}:${path.filter((item) => !/^\d+$/.test(item)).join(".")}`,
            value,
          )
        : redactText(value, this.#secrets)
    }
    if (value === null || typeof value !== "object") return value
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.#redactRawValue(item, channel, [...path, String(index)]),
      )
    }
    const safe = redactValue(value, this.#secrets)
    if (!isRecord(safe)) return safe
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(safe)) {
      output[key] = this.#redactRawValue(item, channel, [...path, key])
    }
    return output
  }
}
