import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph/domain"
import {
  acquireFilesystemLease,
  assertTrustedOpenFile,
  FilesystemLeaseBlockedError,
  openTrustedFile,
  type RawStreamChannel,
  RawStreamChannelSchema,
  type RawStreamKind,
  RawStreamKindSchema,
  type RawStreamRecord,
  RawStreamRecordSchema,
  readTrustedFile,
  redactText,
  removeTrustedFile,
  secretValuesFromEnvironment,
  trustedFileIdentity,
  writeTrustedFileExclusive,
} from "@ralph/telemetry"

export type RawStreamRetention = {
  readonly maxSegmentBytes: number
  readonly maxSegments: number
  readonly maxTotalBytes: number
  readonly maxAgeMs?: number
}

export const DEFAULT_RAW_STREAM_RETENTION: RawStreamRetention = {
  maxSegmentBytes: 1_048_576,
  maxSegments: 16,
  maxTotalBytes: 16_777_216,
}

export type AppendRawStreamInput = {
  readonly rawRoot: string
  readonly streamKind: RawStreamKind
  readonly streamId: string
  /** Safe run/workspace identity embedded in public refs, never a path. */
  readonly referenceScope?: string
  readonly channel: RawStreamChannel
  readonly data: string
  readonly timestamp?: string
  readonly correlationId?: string
  readonly callId?: string
  readonly processId?: string
  /** True when the producer had already bounded the source before this append. */
  readonly sourceTruncated?: boolean
  readonly secrets?: readonly string[]
  readonly retention?: Partial<RawStreamRetention>
}

export type RawStreamAppendResult = {
  readonly record: RawStreamRecord
  readonly rawRef: string
  readonly segment: number
  readonly retainedSegments: number
  readonly retainedBytes: number
}

type RawStreamManifest = {
  readonly schemaVersion: 1
  readonly streamKind: RawStreamKind
  readonly streamId: string
  readonly streamHash: string
  readonly createdAt: string
}

const SEGMENT_PATTERN = /^(\d{8,16})\.jsonl$/
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const queues = new Map<string, Promise<unknown>>()
const RAW_STREAM_LOCK_WAIT_MS = 10_000

function safeCounter(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RalphError(
      "RALPH_RAW_RETENTION_INVALID",
      `${label} must be a safe integer >= ${minimum}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
      },
    )
  }
  return value
}

function resolvedRetention(input: Partial<RawStreamRetention> = {}): RawStreamRetention {
  const retention = {
    ...DEFAULT_RAW_STREAM_RETENTION,
    ...input,
  }
  return {
    maxSegmentBytes: safeCounter(retention.maxSegmentBytes, "maxSegmentBytes", 1),
    maxSegments: safeCounter(retention.maxSegments, "maxSegments", 1),
    maxTotalBytes: safeCounter(retention.maxTotalBytes, "maxTotalBytes", 1),
    ...(retention.maxAgeMs === undefined
      ? {}
      : { maxAgeMs: safeCounter(retention.maxAgeMs, "maxAgeMs", 1) }),
  }
}

function streamHash(streamKind: RawStreamKind, streamId: string): string {
  if (streamId.length === 0 || streamId.length > 512) {
    throw new RalphError(
      "RALPH_RAW_STREAM_ID_INVALID",
      "Raw stream ID must use 1..512 characters",
      {
        exitCode: EXIT_CODES.invalidUsage,
      },
    )
  }
  return createHash("sha256").update(`${streamKind}\0${streamId}`).digest("hex")
}

function referenceScope(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/.test(value)) {
    throw new RalphError(
      "RALPH_RAW_REFERENCE_SCOPE_INVALID",
      "Raw stream reference scope must be a safe 1..512 character identifier",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  return value
}

function streamDirectory(rawRoot: string, streamKind: RawStreamKind, streamId: string): string {
  return join(
    rawRoot,
    streamKind === "call" ? "calls" : "processes",
    streamHash(streamKind, streamId),
  )
}

function segmentName(segment: number): string {
  return `${String(segment).padStart(8, "0")}.jsonl`
}

async function segments(directory: string): Promise<readonly { name: string; segment: number }[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && SEGMENT_PATTERN.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      segment: Number(SEGMENT_PATTERN.exec(entry.name)?.[1]),
    }))
    .filter((entry) => Number.isSafeInteger(entry.segment) && entry.segment > 0)
    .sort((left, right) => left.segment - right.segment)
}

async function withStreamQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  queues.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release?.()
    if (queues.get(key) === tail) queues.delete(key)
  }
}

async function ensureManifest(
  directory: string,
  streamKind: RawStreamKind,
  streamId: string,
  hash: string,
  timestamp: string,
): Promise<void> {
  const path = join(directory, "stream.json")
  try {
    const existing = JSON.parse(
      (await readTrustedFile(path)).toString("utf8"),
    ) as Partial<RawStreamManifest>
    if (
      existing.schemaVersion !== 1 ||
      existing.streamKind !== streamKind ||
      existing.streamId !== streamId ||
      existing.streamHash !== hash
    ) {
      throw new Error("raw stream manifest binding mismatch")
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      throw new RalphError(
        "RALPH_RAW_STREAM_MANIFEST_INVALID",
        `Raw stream manifest is invalid: ${path}`,
        { exitCode: EXIT_CODES.operationalError, file: path, cause: error },
      )
    }
    await writeTrustedFileExclusive(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        streamKind,
        streamId,
        streamHash: hash,
        createdAt: timestamp,
      } satisfies RawStreamManifest)}\n`,
    )
  }
}

async function applyRetention(
  directory: string,
  retention: RawStreamRetention,
  nowMs: number,
  assertLease: () => Promise<void>,
): Promise<{ retainedSegments: number; retainedBytes: number }> {
  const candidates = await segments(directory)
  const metadata = await Promise.all(
    candidates.map(async (entry) => ({
      ...entry,
      path: join(directory, entry.name),
      info: await trustedFileIdentity(join(directory, entry.name)),
    })),
  )
  let retainedBytes = metadata.reduce((total, entry) => total + entry.info.size, 0)
  let retainedSegments = metadata.length
  for (const [index, entry] of metadata.entries()) {
    const newest = index === metadata.length - 1
    const expired =
      !newest && retention.maxAgeMs !== undefined && nowMs - entry.info.mtimeMs > retention.maxAgeMs
    const overCount = retainedSegments > retention.maxSegments
    const overBytes = retainedBytes > retention.maxTotalBytes && retainedSegments > 1
    if (!expired && !overCount && !overBytes) continue
    await assertLease()
    await removeTrustedFile(directory, entry.path, entry.info)
    retainedBytes -= entry.info.size
    retainedSegments -= 1
  }
  return { retainedSegments, retainedBytes }
}

function fitRecordToRetention(
  input: Omit<RawStreamRecord, "data" | "truncated" | "originalBytes">,
  data: string,
  maximumBytes: number,
): { record: RawStreamRecord; line: string } {
  const originalBytes = Buffer.byteLength(data)
  const candidate = (length: number, truncated: boolean): RawStreamRecord =>
    RawStreamRecordSchema.parse({
      ...input,
      data: data.slice(0, length),
      truncated,
      originalBytes,
    })
  const serialized = (record: RawStreamRecord): string => `${JSON.stringify(record)}\n`
  const complete = candidate(data.length, false)
  const completeLine = serialized(complete)
  if (Buffer.byteLength(completeLine) <= maximumBytes) {
    return { record: complete, line: completeLine }
  }

  const empty = candidate(0, true)
  if (Buffer.byteLength(serialized(empty)) > maximumBytes) {
    throw new RalphError(
      "RALPH_RAW_RETENTION_TOO_SMALL",
      "Raw stream retention cannot fit even an empty structured record",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  let lower = 0
  let upper = data.length
  let best = empty
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2)
    const attempt = candidate(middle, true)
    if (Buffer.byteLength(serialized(attempt)) <= maximumBytes) {
      best = attempt
      lower = middle + 1
    } else {
      upper = middle - 1
    }
  }
  return { record: best, line: serialized(best) }
}

/**
 * Appends a redacted record to a call/process stream and applies bounded,
 * oldest-first retention inside that one stream. The hash-derived directory
 * prevents provider/process identifiers from becoming filesystem paths.
 */
export async function appendRawStream(input: AppendRawStreamInput): Promise<RawStreamAppendResult> {
  const streamKind = RawStreamKindSchema.parse(input.streamKind)
  const channel = RawStreamChannelSchema.parse(input.channel)
  const hash = streamHash(streamKind, input.streamId)
  const directory = streamDirectory(input.rawRoot, streamKind, input.streamId)
  return withStreamQueue(input.rawRoot, async () => {
    let lease: Awaited<ReturnType<typeof acquireFilesystemLease>>
    try {
      lease = await acquireFilesystemLease(input.rawRoot, ".raw.mutation.lock", {
        waitMs: RAW_STREAM_LOCK_WAIT_MS,
      })
    } catch (error) {
      if (error instanceof FilesystemLeaseBlockedError) {
        throw new RalphError(
          "RALPH_RAW_STREAM_LOCK_TIMEOUT",
          "Timed out waiting for another Ralph process to release diagnostic raw storage",
          {
            exitCode: EXIT_CODES.conflict,
            file: error.path,
            details: { reason: error.reason },
          },
        )
      }
      throw error
    }
    try {
      await lease.assertOwned()
      const requestedTimestamp = input.timestamp ?? new Date().toISOString()
      const scope = referenceScope(input.referenceScope)
      if (!ISO_TIMESTAMP_PATTERN.test(requestedTimestamp)) {
        throw new RalphError(
          "RALPH_RAW_STREAM_TIMESTAMP_INVALID",
          "Raw stream timestamp requires an ISO-8601 timezone",
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      const timestampMs = Date.parse(requestedTimestamp)
      if (!Number.isFinite(timestampMs)) {
        throw new RalphError(
          "RALPH_RAW_STREAM_TIMESTAMP_INVALID",
          "Raw stream timestamp is invalid",
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      const timestamp = new Date(timestampMs).toISOString()
      const retention = resolvedRetention(input.retention)
      await ensureManifest(directory, streamKind, input.streamId, hash, timestamp)
      await lease.assertOwned()
      const existing = await segments(directory)
      const last = existing.at(-1)
      let segment = last?.segment ?? 1
      let sequence = 1
      if (last) {
        const content = (await readTrustedFile(join(directory, last.name))).toString("utf8")
        const lines = content.split("\n").filter((line) => line.length > 0)
        const latest = lines.at(-1)
        if (latest !== undefined) {
          const previousSequence = RawStreamRecordSchema.parse(JSON.parse(latest)).sequence
          if (previousSequence >= Number.MAX_SAFE_INTEGER) {
            throw new RalphError(
              "RALPH_RAW_STREAM_SEQUENCE_EXHAUSTED",
              "Raw stream sequence exhausted",
              { exitCode: EXIT_CODES.operationalError },
            )
          }
          sequence = previousSequence + 1
        }
      }
      const recordBase = {
        schemaVersion: 1,
        streamKind,
        streamId: input.streamId,
        sequence,
        timestamp,
        channel,
        redacted: true,
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        ...(input.callId !== undefined ? { callId: input.callId } : {}),
        ...(input.processId !== undefined ? { processId: input.processId } : {}),
        ...(input.sourceTruncated === undefined ? {} : { sourceTruncated: input.sourceTruncated }),
      } as const
      const fitted = fitRecordToRetention(
        recordBase,
        redactText(input.data, input.secrets ?? secretValuesFromEnvironment()),
        Math.min(retention.maxSegmentBytes, retention.maxTotalBytes),
      )
      const { record, line } = fitted
      let path = join(directory, segmentName(segment))
      const currentSize = last ? (await trustedFileIdentity(path)).size : 0
      if (currentSize > 0 && currentSize + Buffer.byteLength(line) > retention.maxSegmentBytes) {
        if (segment >= Number.MAX_SAFE_INTEGER) {
          throw new RalphError(
            "RALPH_RAW_STREAM_SEGMENT_EXHAUSTED",
            "Raw stream segment exhausted",
            { exitCode: EXIT_CODES.operationalError },
          )
        }
        segment += 1
        path = join(directory, segmentName(segment))
      }
      const handle = await openTrustedFile(path, "append", 0o600)
      try {
        await lease.assertOwned()
        await assertTrustedOpenFile(path, handle)
        await handle.writeFile(line, "utf8")
        await handle.sync()
        await assertTrustedOpenFile(path, handle)
        await lease.assertOwned()
      } finally {
        await handle.close()
      }
      const retained = await applyRetention(directory, retention, Date.now(), () =>
        lease.assertOwned(),
      )
      await lease.assertOwned()
      return {
        record,
        rawRef: scope
          ? `run-raw://${scope}/${streamKind}/${hash}/stream`
          : `run-raw://${streamKind}/${hash}/stream`,
        segment,
        ...retained,
      }
    } finally {
      await lease.release()
    }
  })
}

export type ReadRawStreamQuery = {
  readonly streamKind: RawStreamKind
  readonly streamId: string
  readonly channel?: RawStreamChannel
  readonly since?: string
  readonly limit?: number
}

export async function readRawStream(
  rawRoot: string,
  query: ReadRawStreamQuery,
): Promise<RawStreamRecord[]> {
  const limit = safeCounter(query.limit ?? 200, "limit", 1)
  const streamKind = RawStreamKindSchema.parse(query.streamKind)
  const channel =
    query.channel === undefined ? undefined : RawStreamChannelSchema.parse(query.channel)
  let since: string | undefined
  if (query.since !== undefined) {
    if (!ISO_TIMESTAMP_PATTERN.test(query.since)) {
      throw new RalphError(
        "RALPH_RAW_STREAM_SINCE_INVALID",
        "Raw stream since requires an ISO-8601 timezone",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    const sinceMs = Date.parse(query.since)
    if (!Number.isFinite(sinceMs)) {
      throw new RalphError("RALPH_RAW_STREAM_SINCE_INVALID", "Raw stream since is invalid", {
        exitCode: EXIT_CODES.invalidUsage,
      })
    }
    since = new Date(sinceMs).toISOString()
  }
  const directory = streamDirectory(rawRoot, streamKind, query.streamId)
  try {
    const records: RawStreamRecord[] = []
    for (const entry of await segments(directory)) {
      const content = (await readTrustedFile(join(directory, entry.name))).toString("utf8")
      for (const line of content.split("\n")) {
        if (line.length === 0) continue
        const record = RawStreamRecordSchema.parse(JSON.parse(line))
        if (channel !== undefined && record.channel !== channel) continue
        if (since !== undefined && record.timestamp < since) continue
        records.push(record)
      }
    }
    return records.slice(-limit)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new RalphError("RALPH_RAW_STREAM_READ_FAILED", "Could not read raw stream", {
      exitCode: EXIT_CODES.operationalError,
      file: directory,
      cause: error,
    })
  }
}
