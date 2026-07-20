const ENVIRONMENT_SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|(?:^|[_-])token(?:$|[_-])|authorization|bearer|password|passwd|secret|credential|private[_-]?key)/i
const STRUCTURED_SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|(?:^|[_-])token(?:$|[_-])|authorization|bearer|password|passwd|secret|private[_-]?key)/i

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const URL_SECRET_PATTERN =
  /([?&](?:token|access_token|refresh_token|api_key|apikey|key|secret)=)[^&\s]+/gi

export const REDACTED = "[REDACTED]"

export function secretValuesFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): string[] {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        ENVIRONMENT_SECRET_KEY_PATTERN.test(key) && value !== undefined && value.length >= 4,
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length)
}

export function redactText(value: string, secretValues: readonly string[] = []): string {
  let redacted = value.replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
  redacted = redacted.replace(URL_SECRET_PATTERN, `$1${REDACTED}`)

  for (const secret of secretValues) {
    if (secret.length < 4) continue
    redacted = redacted.split(secret).join(REDACTED)
  }
  return redacted
}

export function redactValue(
  value: unknown,
  secretValues: readonly string[] = [],
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") return redactText(value, secretValues)
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[CIRCULAR]"
  seen.add(value)

  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, secretValues, seen))
    }

    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      output[key] =
        STRUCTURED_SECRET_KEY_PATTERN.test(key) && typeof item !== "boolean"
          ? REDACTED
          : redactValue(item, secretValues, seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}
