export type ResponseBodyFailureReason = "aborted" | "missing-body" | "too-large" | "invalid-utf8"

export class ResponseBodyError extends Error {
  constructor(
    readonly reason: ResponseBodyFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "ResponseBodyError"
  }
}

export type BoundedBodyOptions = {
  maxBytes: number
  signal?: AbortSignal
  label: string
}

type ResponseReaderResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>

export async function readBoundedResponseText(
  response: Response,
  options: BoundedBodyOptions,
): Promise<string> {
  if (!response.body) {
    throw new ResponseBodyError("missing-body", `${options.label} has no response body`)
  }
  const bytes = await readBoundedBody(response.body, options)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new ResponseBodyError("invalid-utf8", `${options.label} is not valid UTF-8`, { cause })
  }
}

export async function readBoundedResponseJson(
  response: Response,
  options: BoundedBodyOptions,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, options)
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new SyntaxError(`${options.label} is not valid JSON`, { cause })
  }
}

export async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  options: BoundedBodyOptions,
): Promise<Uint8Array> {
  assertLimit(options.maxBytes)
  throwIfAborted(options.signal, options.label)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let completed = false
  try {
    while (true) {
      const result = await readWithAbort(reader, options.signal, options.label)
      if (result.done) {
        completed = true
        break
      }
      totalBytes += result.value.byteLength
      if (totalBytes > options.maxBytes) {
        throw new ResponseBodyError(
          "too-large",
          `${options.label} exceeded the ${options.maxBytes}-byte limit`,
        )
      }
      chunks.push(result.value)
    }
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined)
    if (completed) reader.releaseLock()
  }

  const output = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

export async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<ResponseReaderResult> {
  return readWithAbort(reader, signal, label)
}

export function responseByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Response body byte limit must be a positive safe integer")
  }
}

function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) {
    throw new ResponseBodyError("aborted", `${label} was cancelled`)
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<ResponseReaderResult> {
  throwIfAborted(signal, label)
  if (!signal) return reader.read()

  let rejectAbort: ((error: ResponseBodyError) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => {
    rejectAbort?.(new ResponseBodyError("aborted", `${label} was cancelled`))
  }
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await Promise.race([reader.read(), aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}
