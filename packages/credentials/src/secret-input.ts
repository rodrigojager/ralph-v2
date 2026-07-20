import type { SecretInput } from "./contracts"

export const REDACTED_SECRET = "[REDACTED]"

class OneShotSecretInput implements SecretInput {
  #value: string | undefined

  constructor(value: string) {
    this.#value = value
  }

  async readOnce(): Promise<string> {
    const value = this.#value
    if (value === undefined) throw new Error("Secret input has already been consumed")
    this.#value = undefined
    return value
  }

  toJSON(): string {
    return REDACTED_SECRET
  }

  toString(): string {
    return REDACTED_SECRET
  }
}

export function secretInputFromValue(value: string): SecretInput {
  return new OneShotSecretInput(value)
}

export async function readSecretStream(
  stream: ReadableStream<Uint8Array>,
  options: { maxBytes?: number; stripTrailingNewline?: boolean } = {},
): Promise<SecretInput> {
  const maxBytes = options.maxBytes ?? 64 * 1024
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Secret input maxBytes must be a positive safe integer")
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maxBytes) throw new Error("Secret input exceeds the configured byte limit")
    chunks.push(next.value)
  }

  let value = new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  )
  if (options.stripTrailingNewline !== false) value = value.replace(/\r?\n$/, "")
  return new OneShotSecretInput(value)
}
