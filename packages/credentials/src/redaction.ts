import { REDACTED_SECRET } from "./secret-input"

const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|password|passwd|secret|credential|private[_-]?key)/i
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const URL_SECRET_PATTERN =
  /([?&](?:token|access_token|refresh_token|api_key|apikey|key|secret)=)[^&\s]+/gi

export class SecretRedactor {
  readonly #values = new Map<string, number>()

  register(secret: string): () => void {
    if (secret.length < 4) return () => undefined
    this.#values.set(secret, (this.#values.get(secret) ?? 0) + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      const count = this.#values.get(secret) ?? 0
      if (count <= 1) this.#values.delete(secret)
      else this.#values.set(secret, count - 1)
    }
  }

  redactText(value: string, additionalSecrets: readonly string[] = []): string {
    let output = value.replace(BEARER_PATTERN, `Bearer ${REDACTED_SECRET}`)
    output = output.replace(URL_SECRET_PATTERN, `$1${REDACTED_SECRET}`)
    const secrets = [...this.#values.keys(), ...additionalSecrets]
      .filter((secret) => secret.length >= 4)
      .sort((left, right) => right.length - left.length)
    for (const secret of secrets) output = output.split(secret).join(REDACTED_SECRET)
    return output
  }

  redactValue(value: unknown, additionalSecrets: readonly string[] = []): unknown {
    return redactUnknown(value, (text) => this.redactText(text, additionalSecrets), new WeakSet())
  }
}

function redactUnknown(
  value: unknown,
  redact: (value: string) => string,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redact(value)
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[CIRCULAR]"
  seen.add(value)

  try {
    if (Array.isArray(value)) return value.map((item) => redactUnknown(item, redact, seen))
    if (value instanceof Error) {
      return {
        name: value.name,
        message: redact(value.message),
        ...(value.stack ? { stack: redact(value.stack) } : {}),
        ...("cause" in value ? { cause: redactUnknown(value.cause, redact, seen) } : {}),
      }
    }

    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] =
        SECRET_KEY_PATTERN.test(key) && typeof item !== "boolean"
          ? REDACTED_SECRET
          : redactUnknown(item, redact, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}
