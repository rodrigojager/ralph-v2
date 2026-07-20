import { z } from "zod"
import {
  type EventEnvelope,
  EventEnvelopeConsumerSchema,
  type EventLevel,
  EventLevelSchema,
} from "./events"

export const LogSourceSchema = z.enum([
  "audit",
  "human",
  "raw-engine",
  "tool",
  "gate",
  "diagnostic",
])
export type LogSource = z.infer<typeof LogSourceSchema>

export const RawStreamKindSchema = z.enum(["call", "process"])
export type RawStreamKind = z.infer<typeof RawStreamKindSchema>

export const RawStreamChannelSchema = z.enum(["provider", "protocol", "stdout", "stderr"])
export type RawStreamChannel = z.infer<typeof RawStreamChannelSchema>

export const RawStreamRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    streamKind: RawStreamKindSchema,
    streamId: z.string().min(1).max(512),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    timestamp: z.iso.datetime({ offset: true }),
    channel: RawStreamChannelSchema,
    data: z.string(),
    redacted: z.literal(true),
    truncated: z.boolean(),
    originalBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** The producer had already bounded the source before this record was appended. */
    sourceTruncated: z.boolean().optional(),
    correlationId: z.string().min(1).max(512).optional(),
    callId: z.string().min(1).max(512).optional(),
    processId: z.string().min(1).max(512).optional(),
  })
  .strict()
export type RawStreamRecord = z.infer<typeof RawStreamRecordSchema>

export const LogRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: LogSourceSchema,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    eventId: z.string().min(1),
    timestamp: z.iso.datetime({ offset: true }),
    level: EventLevelSchema,
    type: z.string().min(1),
    message: z.string(),
    workspaceId: z.string().min(1),
    runId: z.string().min(1).optional(),
    documentId: z.string().optional(),
    taskId: z.string().optional(),
    attemptId: z.string().optional(),
    callId: z.string().optional(),
    workerId: z.string().optional(),
    correlationId: z.string().optional(),
    causationId: z.string().optional(),
    rawRefs: z.array(z.string().min(1)),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict()
export type LogRecord = z.infer<typeof LogRecordSchema>

export type LogFilter = {
  readonly runId?: string
  readonly documentId?: string
  readonly taskId?: string
  readonly workerId?: string
  readonly eventType?: string
  readonly minimumLevel?: EventLevel
  readonly since?: string
  readonly source?: LogSource
}

const LEVEL_RANK: Readonly<Record<EventLevel, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

function engineEvent(type: string): boolean {
  return (
    type.startsWith("model.") ||
    type.startsWith("external.cli.") ||
    type.startsWith("judge.backend.") ||
    type.startsWith("executor.backend.")
  )
}

function toolEvent(type: string): boolean {
  return type.startsWith("tool.")
}

function gateEvent(type: string): boolean {
  return (
    type.startsWith("gate.") || type.startsWith("verification.") || type === "evidence.collected"
  )
}

function diagnosticEvent(event: EventEnvelope): boolean {
  return (
    event.level === "error" ||
    event.type === "diagnostic.created" ||
    event.type.endsWith(".error") ||
    event.type.endsWith(".failed")
  )
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  return value
}

function payloadMessage(event: EventEnvelope): string {
  const payload = event.payload
  for (const key of [
    "message",
    "summary",
    "reason",
    "output",
    "text",
    "delta",
    "status",
    "outcome",
    "action",
  ]) {
    const value = stringValue(payload[key])
    if (value !== undefined) return value
  }
  return event.type
}

function diagnosticRawReference(value: string): boolean {
  return (
    value.startsWith("run-raw://") ||
    value.startsWith("workspace-raw://") ||
    value.startsWith("raw:model/") ||
    value.startsWith("raw://sha256/") ||
    value.startsWith("raw://model-smoke/") ||
    /^\.ralph\/runs\/[A-Za-z0-9][A-Za-z0-9._-]{0,511}\/raw\//u.test(value)
  )
}

function collectRawRefs(value: unknown, output: Set<string>, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const item of value) collectRawRefs(item, output, depth + 1)
    return
  }
  if (typeof value !== "object") return
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "rawRef" || key === "providerRawRef") && typeof nested === "string") {
      if (nested.length > 0) output.add(nested)
      continue
    }
    if ((key === "rawRefs" || key === "providerRawRefs") && Array.isArray(nested)) {
      for (const reference of nested) {
        if (typeof reference === "string" && reference.length > 0) output.add(reference)
      }
      continue
    }
    if (key === "outputRefs" && Array.isArray(nested)) {
      for (const reference of nested) {
        if (
          typeof reference === "string" &&
          reference.length > 0 &&
          diagnosticRawReference(reference)
        ) {
          output.add(reference)
        }
      }
      continue
    }
    collectRawRefs(nested, output, depth + 1)
  }
}

function sourcesFor(event: EventEnvelope): readonly LogSource[] {
  const sources: LogSource[] = ["audit", "human"]
  if (engineEvent(event.type)) sources.push("raw-engine")
  if (toolEvent(event.type)) sources.push("tool")
  if (gateEvent(event.type)) sources.push("gate")
  if (diagnosticEvent(event)) sources.push("diagnostic")
  return sources
}

/**
 * Projects one durable event into independent observer views. The event itself
 * remains the audit authority; these records are presentation indexes and may
 * always be rebuilt from the ledger.
 */
export function logRecordsForEvent(eventInput: EventEnvelope): readonly LogRecord[] {
  const event = EventEnvelopeConsumerSchema.parse(eventInput)
  const rawRefs = new Set<string>()
  collectRawRefs(event.payload, rawRefs)
  const common = {
    schemaVersion: 1 as const,
    sequence: event.sequence,
    eventId: event.eventId,
    timestamp: event.timestamp,
    level: event.level,
    type: event.type,
    message: payloadMessage(event),
    workspaceId: event.workspaceId,
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ...(event.documentId !== undefined ? { documentId: event.documentId } : {}),
    ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
    ...(event.attemptId !== undefined ? { attemptId: event.attemptId } : {}),
    ...(event.callId !== undefined ? { callId: event.callId } : {}),
    ...(event.workerId !== undefined ? { workerId: event.workerId } : {}),
    ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
    ...(event.causationId !== undefined ? { causationId: event.causationId } : {}),
    rawRefs: [...rawRefs].sort(),
    payload: event.payload,
  }
  return sourcesFor(event).map((source) => LogRecordSchema.parse({ ...common, source }))
}

export function parseLogSince(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`Invalid ISO-8601 log timestamp: ${value}`)
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error(`Invalid log timestamp: ${value}`)
  return new Date(milliseconds).toISOString()
}

export function matchesLogFilter(record: LogRecord, filter: LogFilter): boolean {
  if (filter.source !== undefined && record.source !== filter.source) return false
  if (filter.runId !== undefined && record.runId !== filter.runId) return false
  if (filter.documentId !== undefined && record.documentId !== filter.documentId) return false
  if (filter.taskId !== undefined && record.taskId !== filter.taskId) return false
  if (filter.workerId !== undefined && record.workerId !== filter.workerId) return false
  if (filter.eventType !== undefined && record.type !== filter.eventType) return false
  if (
    filter.minimumLevel !== undefined &&
    LEVEL_RANK[record.level] < LEVEL_RANK[filter.minimumLevel]
  ) {
    return false
  }
  if (filter.since !== undefined) {
    const since = Date.parse(filter.since)
    if (!Number.isFinite(since)) throw new Error(`Invalid log filter timestamp: ${filter.since}`)
    if (Date.parse(record.timestamp) < since) return false
  }
  return true
}

export function projectLogRecords(
  events: readonly EventEnvelope[],
  filter: LogFilter = {},
): LogRecord[] {
  const records: LogRecord[] = []
  for (const event of events) {
    for (const record of logRecordsForEvent(event)) {
      if (matchesLogFilter(record, filter)) records.push(record)
    }
  }
  return records
}

function scopeText(record: LogRecord): string {
  const values = [
    record.runId ? `run=${record.runId}` : undefined,
    record.documentId && record.taskId
      ? `task=${record.documentId}/${record.taskId}`
      : record.taskId
        ? `task=${record.taskId}`
        : undefined,
    record.workerId ? `worker=${record.workerId}` : undefined,
    record.callId ? `call=${record.callId}` : undefined,
  ].filter((value): value is string => value !== undefined)
  return values.length === 0 ? "" : ` ${values.join(" ")}`
}

export function formatLogRecordHuman(recordInput: LogRecord): string {
  const record = LogRecordSchema.parse(recordInput)
  const raw = record.rawRefs.length > 0 ? ` raw=${record.rawRefs.join(",")}` : ""
  const message = record.message.replace(/[\r\n]+/g, " ↩ ")
  return `${String(record.sequence).padStart(6)} ${record.timestamp} ${record.level.padEnd(5)} ${record.source.padEnd(10)} ${record.type}${scopeText(record)} — ${message}${raw}`
}
