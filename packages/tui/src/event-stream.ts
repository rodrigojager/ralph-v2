import type {
  RunUiConnection,
  RunUiEntry,
  RunUiEventCursor,
  RunUiScopeProjection,
  RunUiSnapshot,
  RunUiSource,
  RunUiStreamMetrics,
  RunUiUsage,
  RunUiUsageCall,
} from "./contracts"
import { createEmptyRunUiSnapshot, runUiReducer } from "./state"

export type RunUiEventLevel = "trace" | "debug" | "info" | "warn" | "error"

/**
 * Consumer-side structural copy of the public event envelope. Keeping this
 * contract in the TUI package prevents a renderer from gaining a concrete
 * telemetry, persistence, provider, or supervisor dependency.
 */
export interface RunUiEventEnvelope {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly sequence: number
  readonly timestamp: string
  readonly monotonicMs: number
  readonly type: string
  readonly scope: "workspace" | "run"
  readonly streamId: string
  readonly workspaceId: string
  readonly runId?: string
  readonly documentId?: string
  readonly taskId?: string
  readonly attemptId?: string
  readonly callId?: string
  readonly workerId?: string
  readonly parentRunId?: string
  readonly correlationId?: string
  readonly causationId?: string
  readonly level: RunUiEventLevel
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * `cursor` is an inclusive scan watermark. A run-filtered stream may have
 * sequence gaps because unrelated workspace events share the same stream.
 */
export interface RunUiEventBatch {
  readonly cursor: RunUiEventCursor
  readonly events: readonly RunUiEventEnvelope[]
}

export interface RunUiIngestResult {
  readonly cursor: RunUiEventCursor
  readonly received: number
  readonly applied: number
  readonly duplicates: number
  readonly stale: number
}

export type RunUiEventProjector = (
  snapshot: RunUiSnapshot,
  event: RunUiEventEnvelope,
  limits: RunUiProjectionLimits,
) => RunUiSnapshot

export interface RunUiProjectionLimits {
  readonly activity: number
  readonly events: number
  readonly logs: number
  readonly engineOutput: number
}

export interface RunUiRenderScheduler {
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

export interface RunUiEventStoreOptions {
  readonly runId: string
  readonly initialSnapshot?: RunUiSnapshot
  readonly projector?: RunUiEventProjector
  readonly projectionLimits?: Partial<RunUiProjectionLimits>
  readonly maxRememberedEvents?: number
  readonly maxDisplaySegments?: number
  readonly maxDisplayCharactersPerSegment?: number
  readonly renderIntervalMs?: number
  readonly scheduler?: RunUiRenderScheduler
  readonly now?: () => string
  readonly onListenerError?: (error: unknown) => void
}

export interface IncrementalRunUiSource extends RunUiSource {
  getConnection(): RunUiConnection
  ingestBatch(batch: RunUiEventBatch): RunUiIngestResult
  acceptSnapshot(snapshot: RunUiSnapshot, cursor: RunUiEventCursor): void
  acceptReplaySnapshot(snapshot: RunUiSnapshot, cursor: RunUiEventCursor): void
  acceptHeartbeat(cursor: RunUiEventCursor): RunUiIngestResult
  markConnecting(reconnectAttempt?: number): void
  markReconnecting(reconnectAttempt: number): void
  markDisconnected(reason: string, nextRetryAt?: string | null): void
  markClosed(reason?: string): void
  flushNow(): void
}

export class RunUiStreamProtocolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "RunUiStreamProtocolError"
    this.code = code
  }
}

const EVENT_LEVELS = new Set<RunUiEventLevel>(["trace", "debug", "info", "warn", "error"])
const DEFAULT_LIMITS: RunUiProjectionLimits = {
  activity: 100,
  events: 160,
  logs: 120,
  engineOutput: 240,
}
const DEFAULT_SCHEDULER: RunUiRenderScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
const EMPTY_METRICS: RunUiStreamMetrics = {
  receivedEvents: 0,
  appliedEvents: 0,
  duplicateEvents: 0,
  staleEvents: 0,
  coalescedDisplayEvents: 0,
  droppedDisplayEvents: 0,
  droppedDisplayCharacters: 0,
  protocolErrors: 0,
  reconnects: 0,
  renderFlushes: 0,
}
const MAX_PROTOCOL_STRING_CHARACTERS = 262_144
const MAX_EVENT_PAYLOAD_CHARACTERS = 1_048_576
const MAX_EVENT_PAYLOAD_NODES = 50_000
const MAX_EVENT_PAYLOAD_DEPTH = 32
const MAX_EVENT_BATCH_EVENTS = 2_048
const MAX_SNAPSHOT_COLLECTION_ITEMS = 10_000
const MAX_PROJECTED_USAGE_CALLS = 512

function protocolError(code: string, message: string): never {
  throw new RunUiStreamProtocolError(code, message)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key]
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PROTOCOL_STRING_CHARACTERS
  ) {
    return protocolError("RALPH_TUI_EVENT_SCHEMA", `${key} must be a non-empty string`)
  }
  return value
}

function assertBoundedProtocolValue(
  value: unknown,
  budget: { characters: number; nodes: number },
  depth = 0,
): void {
  if (depth > MAX_EVENT_PAYLOAD_DEPTH) {
    protocolError("RALPH_TUI_EVENT_PAYLOAD_LIMIT", "event payload nesting is too deep")
  }
  budget.nodes += 1
  if (budget.nodes > MAX_EVENT_PAYLOAD_NODES) {
    protocolError("RALPH_TUI_EVENT_PAYLOAD_LIMIT", "event payload contains too many values")
  }
  if (typeof value === "string") {
    budget.characters += value.length
    if (budget.characters > MAX_EVENT_PAYLOAD_CHARACTERS) {
      protocolError("RALPH_TUI_EVENT_PAYLOAD_LIMIT", "event payload text is too large")
    }
    return
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SNAPSHOT_COLLECTION_ITEMS) {
      protocolError("RALPH_TUI_EVENT_PAYLOAD_LIMIT", "event payload array is too large")
    }
    for (const item of value) assertBoundedProtocolValue(item, budget, depth + 1)
    return
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
    if (entries.length > MAX_SNAPSHOT_COLLECTION_ITEMS) {
      protocolError("RALPH_TUI_EVENT_PAYLOAD_LIMIT", "event payload object is too large")
    }
    for (const [key, nested] of entries) {
      budget.characters += key.length
      assertBoundedProtocolValue(nested, budget, depth + 1)
    }
  }
}

function validateOptionalStrings(record: Readonly<Record<string, unknown>>): void {
  for (const key of [
    "runId",
    "documentId",
    "taskId",
    "attemptId",
    "callId",
    "workerId",
    "parentRunId",
    "correlationId",
    "causationId",
  ]) {
    const value = record[key]
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length > MAX_PROTOCOL_STRING_CHARACTERS)
    ) {
      protocolError("RALPH_TUI_EVENT_SCHEMA", `${key} must be a string when present`)
    }
  }
}

/** Consumer validation accepts future fields but rejects incompatible v1 data. */
export function parseRunUiEventEnvelope(value: unknown): RunUiEventEnvelope {
  if (!isRecord(value)) protocolError("RALPH_TUI_EVENT_SCHEMA", "event must be an object")
  if (value.schemaVersion !== 1) {
    protocolError(
      "RALPH_TUI_EVENT_VERSION",
      `unsupported event schema version: ${String(value.schemaVersion)}`,
    )
  }
  requireNonEmptyString(value, "eventId")
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0) {
    protocolError("RALPH_TUI_EVENT_SCHEMA", "sequence must be a positive integer")
  }
  const timestamp = requireNonEmptyString(value, "timestamp")
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    protocolError("RALPH_TUI_EVENT_SCHEMA", "timestamp must be an ISO-8601 date-time with offset")
  }
  if (
    typeof value.monotonicMs !== "number" ||
    !Number.isFinite(value.monotonicMs) ||
    value.monotonicMs < 0
  ) {
    protocolError("RALPH_TUI_EVENT_SCHEMA", "monotonicMs must be a non-negative number")
  }
  requireNonEmptyString(value, "type")
  if (value.scope !== "workspace" && value.scope !== "run") {
    protocolError("RALPH_TUI_EVENT_SCHEMA", "scope must be workspace or run")
  }
  requireNonEmptyString(value, "streamId")
  requireNonEmptyString(value, "workspaceId")
  if (typeof value.level !== "string" || !EVENT_LEVELS.has(value.level as RunUiEventLevel)) {
    protocolError("RALPH_TUI_EVENT_SCHEMA", `unsupported event level: ${String(value.level)}`)
  }
  if (!isRecord(value.payload)) {
    protocolError("RALPH_TUI_EVENT_SCHEMA", "payload must be an object")
  }
  assertBoundedProtocolValue(value.payload, { characters: 0, nodes: 0 })
  validateOptionalStrings(value)
  if (value.scope === "run" && (typeof value.runId !== "string" || value.runId.length === 0)) {
    protocolError("RALPH_TUI_EVENT_SCHEMA", "runId is required for run-scoped events")
  }
  return value as unknown as RunUiEventEnvelope
}

export function parseRunUiEventCursor(value: unknown): RunUiEventCursor {
  if (!isRecord(value)) protocolError("RALPH_TUI_CURSOR_SCHEMA", "cursor must be an object")
  if (value.schemaVersion !== 1) {
    protocolError(
      "RALPH_TUI_CURSOR_VERSION",
      `unsupported cursor schema version: ${String(value.schemaVersion)}`,
    )
  }
  const streamId = requireNonEmptyString(value, "streamId")
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) {
    protocolError("RALPH_TUI_CURSOR_SCHEMA", "cursor sequence must be a non-negative integer")
  }
  return { schemaVersion: 1, streamId, sequence: value.sequence as number }
}

function snapshotSchemaError(path: string, message: string): never {
  return protocolError("RALPH_TUI_SNAPSHOT_SCHEMA", `${path}: ${message}`)
}

function snapshotRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) snapshotSchemaError(path, "must be an object")
  return value
}

function snapshotString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): string {
  const value = record[key]
  if (typeof value !== "string") snapshotSchemaError(`${path}.${key}`, "must be a string")
  if (value.length > MAX_PROTOCOL_STRING_CHARACTERS) {
    snapshotSchemaError(`${path}.${key}`, "is too large")
  }
  return value
}

function snapshotOptionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
): void {
  const value = record[key]
  if (
    value !== undefined &&
    (typeof value !== "string" || value.length > MAX_PROTOCOL_STRING_CHARACTERS)
  ) {
    snapshotSchemaError(`${path}.${key}`, "must be a string when present")
  }
}

function snapshotSafeCount(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  optional = false,
): void {
  const value = record[key]
  if (optional && value === undefined) return
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    snapshotSchemaError(`${path}.${key}`, "must be a non-negative safe integer")
  }
}

function snapshotFiniteNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  optional = false,
): void {
  const value = record[key]
  if (optional && value === undefined) return
  if (typeof value !== "number" || !Number.isFinite(value)) {
    snapshotSchemaError(`${path}.${key}`, "must be a finite number")
  }
}

function snapshotStringList(value: unknown, path: string): void {
  if (
    !Array.isArray(value) ||
    value.length > MAX_SNAPSHOT_COLLECTION_ITEMS ||
    value.some((item) => typeof item !== "string" || item.length > MAX_PROTOCOL_STRING_CHARACTERS)
  ) {
    snapshotSchemaError(path, "must be an array of strings")
  }
}

function validateSnapshotEntries(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_COLLECTION_ITEMS) {
    snapshotSchemaError(path, "must be a bounded array")
  }
  for (const [index, entryValue] of value.entries()) {
    const entry = snapshotRecord(entryValue, `${path}[${index}]`)
    snapshotString(entry, "message", `${path}[${index}]`)
    snapshotOptionalString(entry, "timestamp", `${path}[${index}]`)
    snapshotOptionalString(entry, "type", `${path}[${index}]`)
    snapshotOptionalString(entry, "level", `${path}[${index}]`)
  }
}

function validateSnapshotUsage(value: unknown, path: string): void {
  const usage = snapshotRecord(value, path)
  if (typeof usage.available !== "boolean") {
    snapshotSchemaError(`${path}.available`, "must be a boolean")
  }
  snapshotString(usage, "source", path)
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    snapshotSafeCount(usage, key, path, true)
  }
  snapshotOptionalString(usage, "note", path)
  if (usage.cost !== undefined) {
    const cost = snapshotRecord(usage.cost, `${path}.cost`)
    snapshotFiniteNumber(cost, "amount", `${path}.cost`)
    if ((cost.amount as number) < 0) {
      snapshotSchemaError(`${path}.cost.amount`, "must not be negative")
    }
    snapshotString(cost, "currency", `${path}.cost`)
    snapshotOptionalString(cost, "source", `${path}.cost`)
  }
}

/** Runtime guard for snapshots crossing an IPC/socket/adapter boundary. */
export function parseRunUiSnapshot(value: unknown): RunUiSnapshot {
  const snapshot = snapshotRecord(value, "snapshot")
  snapshotString(snapshot, "runId", "snapshot")
  snapshotString(snapshot, "title", "snapshot")
  snapshotString(snapshot, "status", "snapshot")

  if (snapshot.currentTask !== null) {
    const task = snapshotRecord(snapshot.currentTask, "snapshot.currentTask")
    snapshotString(task, "id", "snapshot.currentTask")
    snapshotString(task, "title", "snapshot.currentTask")
    snapshotString(task, "status", "snapshot.currentTask")
    snapshotOptionalString(task, "runId", "snapshot.currentTask")
    snapshotSafeCount(task, "attempt", "snapshot.currentTask", true)
    snapshotOptionalString(task, "detail", "snapshot.currentTask")
  }

  const progress = snapshotRecord(snapshot.progress, "snapshot.progress")
  snapshotSafeCount(progress, "completed", "snapshot.progress")
  snapshotSafeCount(progress, "total", "snapshot.progress")

  const usage = snapshotRecord(snapshot.usage, "snapshot.usage")
  validateSnapshotUsage(usage.combined, "snapshot.usage.combined")
  validateSnapshotUsage(usage.executor, "snapshot.usage.executor")
  validateSnapshotUsage(usage.judge, "snapshot.usage.judge")
  if (snapshot.usageCalls !== undefined) {
    const calls = snapshotRecord(snapshot.usageCalls, "snapshot.usageCalls")
    const callEntries = Object.entries(calls)
    if (callEntries.length > MAX_SNAPSHOT_COLLECTION_ITEMS) {
      snapshotSchemaError("snapshot.usageCalls", "contains too many calls")
    }
    for (const [callId, callValue] of callEntries) {
      const path = `snapshot.usageCalls.${callId}`
      const call = snapshotRecord(callValue, path)
      snapshotString(call, "callId", path)
      snapshotString(call, "role", path)
      snapshotString(call, "source", path)
      snapshotString(call, "semantics", path)
      if (typeof call.settled !== "boolean")
        snapshotSchemaError(`${path}.settled`, "must be a boolean")
      snapshotSafeCount(call, "inputTokens", path, true)
      snapshotSafeCount(call, "outputTokens", path, true)
      snapshotSafeCount(call, "totalTokens", path, true)
      if (call.cost !== undefined) {
        const cost = snapshotRecord(call.cost, `${path}.cost`)
        snapshotFiniteNumber(cost, "amount", `${path}.cost`)
        snapshotString(cost, "currency", `${path}.cost`)
        snapshotOptionalString(cost, "source", `${path}.cost`)
      }
    }
  }

  validateSnapshotEntries(snapshot.activity, "snapshot.activity")
  validateSnapshotEntries(snapshot.logs, "snapshot.logs")
  validateSnapshotEntries(snapshot.events, "snapshot.events")
  snapshotStringList(snapshot.engineOutput, "snapshot.engineOutput")
  if (snapshot.rawEngineOutput !== undefined) {
    snapshotStringList(snapshot.rawEngineOutput, "snapshot.rawEngineOutput")
  }
  if (snapshot.rawEngineRefs !== undefined) {
    snapshotStringList(snapshot.rawEngineRefs, "snapshot.rawEngineRefs")
  }

  const judge = snapshotRecord(snapshot.judge, "snapshot.judge")
  snapshotString(judge, "mode", "snapshot.judge")
  snapshotOptionalString(judge, "profile", "snapshot.judge")
  if (judge.score !== undefined && judge.score !== null) {
    snapshotFiniteNumber(judge, "score", "snapshot.judge")
  }
  snapshotFiniteNumber(judge, "threshold", "snapshot.judge", true)
  snapshotSafeCount(judge, "revisionAttempt", "snapshot.judge")
  snapshotSafeCount(judge, "maxRevisionAttempts", "snapshot.judge")
  snapshotOptionalString(judge, "decision", "snapshot.judge")
  snapshotOptionalString(judge, "summary", "snapshot.judge")
  const feedback = snapshotRecord(judge.feedback, "snapshot.judge.feedback")
  snapshotStringList(feedback.adequate, "snapshot.judge.feedback.adequate")
  snapshotStringList(feedback.problems, "snapshot.judge.feedback.problems")
  snapshotStringList(feedback.missing, "snapshot.judge.feedback.missing")
  snapshotStringList(feedback.recommendations, "snapshot.judge.feedback.recommendations")

  if (snapshot.runtime !== undefined) {
    const runtime = snapshotRecord(snapshot.runtime, "snapshot.runtime")
    snapshotString(runtime, "phase", "snapshot.runtime")
    snapshotSafeCount(runtime, "attempt", "snapshot.runtime")
    snapshotSafeCount(runtime, "modelCalls", "snapshot.runtime")
    snapshotSafeCount(runtime, "toolCalls", "snapshot.runtime")
    snapshotSafeCount(runtime, "gateRuns", "snapshot.runtime")
    snapshotSafeCount(runtime, "elapsedMs", "snapshot.runtime", true)
  }
  if (snapshot.taskTree !== undefined) {
    if (
      !Array.isArray(snapshot.taskTree) ||
      snapshot.taskTree.length > MAX_SNAPSHOT_COLLECTION_ITEMS
    ) {
      snapshotSchemaError("snapshot.taskTree", "must be a bounded array")
    }
    for (const [index, entryValue] of snapshot.taskTree.entries()) {
      const path = `snapshot.taskTree[${index}]`
      const entry = snapshotRecord(entryValue, path)
      snapshotString(entry, "id", path)
      snapshotString(entry, "title", path)
      snapshotString(entry, "status", path)
      snapshotOptionalString(entry, "runId", path)
      snapshotSafeCount(entry, "depth", path)
      snapshotSafeCount(entry, "attempt", path, true)
      snapshotOptionalString(entry, "detail", path)
      snapshotOptionalString(entry, "documentId", path)
      snapshotOptionalString(entry, "parentRunId", path)
    }
  }
  if (snapshot.scopes !== undefined) {
    if (!Array.isArray(snapshot.scopes) || snapshot.scopes.length > MAX_SNAPSHOT_COLLECTION_ITEMS) {
      snapshotSchemaError("snapshot.scopes", "must be a bounded array")
    }
    for (const [index, scopeValue] of snapshot.scopes.entries()) {
      const path = `snapshot.scopes[${index}]`
      const scope = snapshotRecord(scopeValue, path)
      snapshotString(scope, "runId", path)
      snapshotString(scope, "kind", path)
      snapshotSafeCount(scope, "depth", path)
      snapshotOptionalString(scope, "parentRunId", path)
      snapshotString(scope, "title", path)
      snapshotString(scope, "status", path)
      if (scope.currentTask !== null) {
        const task = snapshotRecord(scope.currentTask, `${path}.currentTask`)
        snapshotString(task, "id", `${path}.currentTask`)
        snapshotString(task, "title", `${path}.currentTask`)
        snapshotString(task, "status", `${path}.currentTask`)
        snapshotOptionalString(task, "runId", `${path}.currentTask`)
        snapshotSafeCount(task, "attempt", `${path}.currentTask`, true)
      }
      const progress = snapshotRecord(scope.progress, `${path}.progress`)
      snapshotSafeCount(progress, "completed", `${path}.progress`)
      snapshotSafeCount(progress, "total", `${path}.progress`)
      const usage = snapshotRecord(scope.usage, `${path}.usage`)
      validateSnapshotUsage(usage.combined, `${path}.usage.combined`)
      validateSnapshotUsage(usage.executor, `${path}.usage.executor`)
      validateSnapshotUsage(usage.judge, `${path}.usage.judge`)
      if (scope.usageCalls !== undefined) {
        const calls = snapshotRecord(scope.usageCalls, `${path}.usageCalls`)
        const callEntries = Object.entries(calls)
        if (callEntries.length > MAX_PROJECTED_USAGE_CALLS) {
          snapshotSchemaError(`${path}.usageCalls`, "contains too many calls")
        }
        for (const [callId, callValue] of callEntries) {
          const callPath = `${path}.usageCalls.${callId}`
          const call = snapshotRecord(callValue, callPath)
          snapshotString(call, "callId", callPath)
          snapshotString(call, "role", callPath)
          snapshotString(call, "source", callPath)
          snapshotString(call, "semantics", callPath)
          if (typeof call.settled !== "boolean") {
            snapshotSchemaError(`${callPath}.settled`, "must be a boolean")
          }
          snapshotSafeCount(call, "inputTokens", callPath, true)
          snapshotSafeCount(call, "outputTokens", callPath, true)
          snapshotSafeCount(call, "totalTokens", callPath, true)
          if (call.cost !== undefined) {
            const cost = snapshotRecord(call.cost, `${callPath}.cost`)
            snapshotFiniteNumber(cost, "amount", `${callPath}.cost`)
            snapshotString(cost, "currency", `${callPath}.cost`)
            snapshotOptionalString(cost, "source", `${callPath}.cost`)
          }
        }
      }
      const runtime = snapshotRecord(scope.runtime, `${path}.runtime`)
      snapshotString(runtime, "phase", `${path}.runtime`)
      snapshotSafeCount(runtime, "attempt", `${path}.runtime`)
      snapshotSafeCount(runtime, "modelCalls", `${path}.runtime`)
      snapshotSafeCount(runtime, "toolCalls", `${path}.runtime`)
      snapshotSafeCount(runtime, "gateRuns", `${path}.runtime`)
      const watchdog = snapshotRecord(scope.watchdog, `${path}.watchdog`)
      if (typeof watchdog.enabled !== "boolean") {
        snapshotSchemaError(`${path}.watchdog.enabled`, "must be a boolean")
      }
      snapshotString(watchdog, "state", `${path}.watchdog`)
      const errors = snapshotRecord(scope.errors, `${path}.errors`)
      snapshotSafeCount(errors, "count", `${path}.errors`)
    }
  }
  if (snapshot.tools !== undefined) {
    if (!Array.isArray(snapshot.tools) || snapshot.tools.length > MAX_SNAPSHOT_COLLECTION_ITEMS) {
      snapshotSchemaError("snapshot.tools", "must be a bounded array")
    }
    for (const [index, toolValue] of snapshot.tools.entries()) {
      const path = `snapshot.tools[${index}]`
      const tool = snapshotRecord(toolValue, path)
      snapshotString(tool, "callId", path)
      snapshotString(tool, "name", path)
      snapshotString(tool, "status", path)
      snapshotOptionalString(tool, "timestamp", path)
      snapshotOptionalString(tool, "taskId", path)
      snapshotOptionalString(tool, "attemptId", path)
      snapshotOptionalString(tool, "preview", path)
      snapshotSafeCount(tool, "durationMs", path, true)
    }
  }
  if (snapshot.observedToolCallIds !== undefined) {
    snapshotStringList(snapshot.observedToolCallIds, "snapshot.observedToolCallIds")
  }
  if (snapshot.gates !== undefined) {
    if (!Array.isArray(snapshot.gates) || snapshot.gates.length > MAX_SNAPSHOT_COLLECTION_ITEMS) {
      snapshotSchemaError("snapshot.gates", "must be a bounded array")
    }
    for (const [index, gateValue] of snapshot.gates.entries()) {
      const path = `snapshot.gates[${index}]`
      const gate = snapshotRecord(gateValue, path)
      snapshotString(gate, "id", path)
      snapshotString(gate, "status", path)
      snapshotOptionalString(gate, "timestamp", path)
      snapshotOptionalString(gate, "category", path)
      snapshotOptionalString(gate, "taskId", path)
      snapshotOptionalString(gate, "attemptId", path)
      snapshotOptionalString(gate, "reason", path)
      snapshotSafeCount(gate, "durationMs", path, true)
      snapshotSafeCount(gate, "attempts", path, true)
      if (gate.blocking !== undefined && typeof gate.blocking !== "boolean") {
        snapshotSchemaError(`${path}.blocking`, "must be a boolean when present")
      }
    }
  }
  if (snapshot.watchdog !== undefined) {
    const watchdog = snapshotRecord(snapshot.watchdog, "snapshot.watchdog")
    if (typeof watchdog.enabled !== "boolean") {
      snapshotSchemaError("snapshot.watchdog.enabled", "must be a boolean")
    }
    snapshotString(watchdog, "state", "snapshot.watchdog")
    snapshotOptionalString(watchdog, "phase", "snapshot.watchdog")
    snapshotOptionalString(watchdog, "observedAt", "snapshot.watchdog")
    snapshotOptionalString(watchdog, "lastProgressAt", "snapshot.watchdog")
    snapshotOptionalString(watchdog, "action", "snapshot.watchdog")
    snapshotStringList(watchdog.reasons, "snapshot.watchdog.reasons")
    snapshotSafeCount(watchdog, "restartUsed", "snapshot.watchdog")
    snapshotSafeCount(watchdog, "restartMaximum", "snapshot.watchdog", true)
    if (
      !Array.isArray(watchdog.signals) ||
      watchdog.signals.length > MAX_SNAPSHOT_COLLECTION_ITEMS
    ) {
      snapshotSchemaError("snapshot.watchdog.signals", "must be a bounded array")
    }
    for (const [index, signalValue] of watchdog.signals.entries()) {
      const path = `snapshot.watchdog.signals[${index}]`
      const signal = snapshotRecord(signalValue, path)
      snapshotString(signal, "name", path)
      snapshotString(signal, "verdict", path)
      snapshotOptionalString(signal, "reason", path)
      snapshotSafeCount(signal, "ageMs", path, true)
    }
  }
  if (snapshot.errorsSummary !== undefined) {
    const errors = snapshotRecord(snapshot.errorsSummary, "snapshot.errorsSummary")
    snapshotSafeCount(errors, "count", "snapshot.errorsSummary")
    if (errors.last !== undefined) {
      const last = snapshotRecord(errors.last, "snapshot.errorsSummary.last")
      snapshotString(last, "message", "snapshot.errorsSummary.last")
      snapshotOptionalString(last, "timestamp", "snapshot.errorsSummary.last")
      snapshotOptionalString(last, "code", "snapshot.errorsSummary.last")
      snapshotOptionalString(last, "origin", "snapshot.errorsSummary.last")
      snapshotOptionalString(last, "taskId", "snapshot.errorsSummary.last")
      snapshotOptionalString(last, "attemptId", "snapshot.errorsSummary.last")
      snapshotOptionalString(last, "suggestedAction", "snapshot.errorsSummary.last")
    }
  }

  snapshotRecord(snapshot.evaluationValues, "snapshot.evaluationValues")
  const origins = snapshotRecord(snapshot.evaluationOrigins, "snapshot.evaluationOrigins")
  for (const [key, origin] of Object.entries(origins)) {
    if (typeof origin !== "string") {
      snapshotSchemaError(`snapshot.evaluationOrigins.${key}`, "must be a string")
    }
  }
  return value as RunUiSnapshot
}

function payloadString(event: RunUiEventEnvelope, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = event.payload[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function payloadNumber(event: RunUiEventEnvelope, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = event.payload[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function recordStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | undefined {
  const value = record[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

function eventMessage(event: RunUiEventEnvelope): string {
  return (
    payloadString(event, "message", "reason", "status", "policy", "outcome", "phase", "action") ??
    event.type
  )
}

function eventEntry(event: RunUiEventEnvelope): RunUiEntry {
  return {
    timestamp: event.timestamp,
    type: event.type,
    level: event.level,
    message: eventMessage(event),
  }
}

function taskDisplayPriority(status: string): number {
  if (/^(active|running|verifying|evaluating)$/i.test(status)) return 0
  if (/^(interrupted|retryable_failed|revision_required)$/i.test(status)) return 1
  if (/^(eligible|pending|selected)$/i.test(status)) return 2
  if (/^blocked$/i.test(status)) return 3
  return 10
}

function shouldProjectCurrentTask(
  snapshot: RunUiSnapshot,
  candidate: NonNullable<RunUiSnapshot["currentTask"]>,
  event: RunUiEventEnvelope,
): boolean {
  const current = snapshot.currentTask
  if (!current) return taskDisplayPriority(candidate.status) < 10
  if (current.id === candidate.id && current.runId === candidate.runId) return true
  const candidatePriority = taskDisplayPriority(candidate.status)
  const currentPriority = taskDisplayPriority(current.status)
  if (candidatePriority !== currentPriority) return candidatePriority < currentPriority
  const currentDepth = snapshot.scopes?.find((scope) => scope.runId === current.runId)?.depth ?? 0
  const candidateDepth = payloadNumber(event, "depth") ?? 0
  return candidateDepth > currentDepth
}

function eventBelongsToCurrentTask(
  event: RunUiEventEnvelope,
  current: RunUiSnapshot["currentTask"],
): boolean {
  if (!current) return true
  const sourceRunId = scopeSourceRunId(event)
  if (current.runId !== undefined && sourceRunId !== undefined && current.runId !== sourceRunId) {
    return false
  }
  if (!event.taskId) return true
  const eventId = event.documentId ? `${event.documentId}/${event.taskId}` : event.taskId
  return (
    (current.id === eventId || current.id.endsWith(`/${event.taskId}`)) &&
    (current.runId === undefined || sourceRunId === undefined || current.runId === sourceRunId)
  )
}

function rawEngineLine(event: RunUiEventEnvelope): string | undefined {
  // Only the command-owned ledger transport may materialize this field after
  // reading an authoritative persisted capture. Provider payloads and raw refs
  // alone are deliberately insufficient for the raw toggle.
  return payloadString(event, "rawContent")
}

interface DisplayDelta {
  readonly field: string
  readonly text: string
  readonly key: string
}

function displayDelta(event: RunUiEventEnvelope): DisplayDelta | undefined {
  const explicitlyDisplayable =
    event.type === "model.text.delta" ||
    event.type === "model.reasoning.delta" ||
    event.type === "model.tool.input.delta" ||
    event.type === "tool.output.delta" ||
    event.type === "gate.output.delta" ||
    event.type === "external.cli.output.delta" ||
    event.type.startsWith("judge.backend.") ||
    event.type.startsWith("executor.backend.")
  if (!event.type.endsWith(".delta") || !explicitlyDisplayable) return undefined

  for (const field of ["delta", "text", "output", "reasoning", "content"]) {
    const value = event.payload[field]
    if (typeof value === "string" && value.length > 0) {
      const identity = event.callId ?? event.workerId ?? event.attemptId ?? event.taskId ?? "stream"
      return { field, text: value, key: `${event.type}\u0000${identity}` }
    }
  }
  return undefined
}

export function isCoalescibleDisplayEvent(event: RunUiEventEnvelope): boolean {
  return displayDelta(event) !== undefined
}

function lifecycleStatus(event: RunUiEventEnvelope): string | undefined {
  const persistedStatus = payloadString(event, "status")
  if (event.type.startsWith("run.") && persistedStatus) return persistedStatus
  switch (event.type) {
    case "run.created":
      return "created"
    case "run.started":
    case "run.resumed":
      return "running"
    case "run.stopping":
    case "run.stop.requested":
      return "stopping"
    case "run.completed":
      return "completed"
    case "run.failed":
      return "failed"
    case "run.interrupted":
      return "interrupted"
    case "run.cancelled":
      return "cancelled"
    case "run.waiting":
      return "waiting"
    default:
      return undefined
  }
}

function taskStatus(event: RunUiEventEnvelope): string | undefined {
  const persistedStatus = payloadString(event, "status")
  if (event.type.startsWith("task.") && persistedStatus) return persistedStatus
  switch (event.type) {
    case "task.selected":
      return "selected"
    case "task.started":
      return "running"
    case "task.interrupted":
      return "interrupted"
    case "task.completed":
    case "task.completed.record_only":
      return "completed"
    case "task.blocked":
      return "blocked"
    case "task.verifying":
      return "verifying"
    case "task.evaluating":
      return "evaluating"
    case "task.revision_required":
      return "revision_required"
    case "task.state.updated":
      return payloadString(event, "status")
    default:
      return undefined
  }
}

function usageRole(event: RunUiEventEnvelope): RunUiUsageCall["role"] {
  if (event.parentRunId) return "child"
  if (event.type.startsWith("tool-model.")) return "tool-model"
  if (event.type.startsWith("judge.")) return "judge"
  return "executor"
}

function safeUsageCounter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function usageAggregate(calls: readonly RunUiUsageCall[], label: string): RunUiUsage {
  if (calls.length === 0) {
    return { available: false, source: "unavailable", note: `${label}: no calls` }
  }
  const availableCalls = calls.filter(
    (call) =>
      call.source !== "unavailable" &&
      (call.inputTokens !== undefined ||
        call.outputTokens !== undefined ||
        call.totalTokens !== undefined ||
        call.cost !== undefined),
  )
  if (availableCalls.length !== calls.length) {
    return {
      available: false,
      source: "unavailable",
      note: `${label}: usage unavailable for ${calls.length - availableCalls.length}/${calls.length} call(s)`,
    }
  }
  const sumCovered = (
    field: "inputTokens" | "outputTokens" | "totalTokens",
  ): number | undefined => {
    if (availableCalls.some((call) => call[field] === undefined)) return undefined
    const total = availableCalls.reduce((sum, call) => sum + (call[field] ?? 0), 0)
    return Number.isSafeInteger(total) ? total : undefined
  }
  const sources = [...new Set(availableCalls.map((call) => call.source))]
  const costs = availableCalls.map((call) => call.cost)
  const currencies = new Set(costs.flatMap((cost) => (cost ? [cost.currency] : [])))
  const costSources = new Set(
    availableCalls.flatMap((call) => (call.cost ? [call.cost.source ?? call.source] : [])),
  )
  const comparableCost = costs.every((cost) => cost !== undefined) && currencies.size === 1
  const costAmount = comparableCost
    ? costs.reduce((sum, cost) => sum + (cost?.amount ?? 0), 0)
    : undefined
  const inputTokens = sumCovered("inputTokens")
  const outputTokens = sumCovered("outputTokens")
  const totalTokens = sumCovered("totalTokens")
  return {
    available: true,
    source: sources.length === 1 ? (sources[0] ?? "unavailable") : "mixed",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costAmount !== undefined && Number.isFinite(costAmount)
      ? {
          cost: {
            amount: costAmount,
            currency: [...currencies][0] as string,
            source: costSources.size === 1 ? ([...costSources][0] as string) : "mixed",
          },
        }
      : {}),
    note: `${label}: ${calls.length} call(s); ${calls.filter((call) => call.settled).length} settled`,
  }
}

function projectUsage(snapshot: RunUiSnapshot, event: RunUiEventEnvelope): RunUiSnapshot {
  const reservesCall =
    event.type === "model.backend.call.reserved" || event.type === "judge.call.started"
  const updatesUsage = event.type.endsWith("usage.updated")
  if (!reservesCall && !updatesUsage) return snapshot

  const providerCallId =
    typeof event.payload.providerCallId === "string" && event.payload.providerCallId.length > 0
      ? event.payload.providerCallId
      : undefined
  const callId = providerCallId ?? event.callId ?? `usage-event:${event.eventId}`
  const calls: Record<string, RunUiUsageCall> = { ...(snapshot.usageCalls ?? {}) }
  const projectedRole = usageRole(event)
  const storageKey = JSON.stringify([
    snapshot.runId,
    event.parentRunId ? (scopeSourceRunId(event) ?? null) : null,
    projectedRole,
    event.attemptId ?? null,
    callId,
  ])
  const current = calls[storageKey]
  const role = current?.role ?? projectedRole
  if (reservesCall && !updatesUsage) {
    calls[storageKey] = current ?? {
      callId,
      role,
      source: "unavailable",
      semantics: "cumulative",
      settled: false,
    }
  }
  if (updatesUsage) {
    const backendPayload = isRecord(event.payload.backendPayload)
      ? event.payload.backendPayload
      : undefined
    const nestedBackendPayload =
      backendPayload && isRecord(backendPayload.payload) ? backendPayload.payload : undefined
    const usagePayload = isRecord(event.payload.usage)
      ? event.payload.usage
      : backendPayload && isRecord(backendPayload.usage)
        ? backendPayload.usage
        : nestedBackendPayload && isRecord(nestedBackendPayload.usage)
          ? nestedBackendPayload.usage
          : event.payload
    const numericUsageField = (...keys: readonly string[]): number | undefined => {
      for (const key of keys) {
        const value = safeUsageCounter(usagePayload[key])
        if (value !== undefined) return value
      }
      return undefined
    }
    const source = typeof usagePayload.source === "string" ? usagePayload.source : "unavailable"
    const semantics =
      usagePayload.semantics === "delta" ||
      usagePayload.semantics === "cumulative" ||
      usagePayload.semantics === "final"
        ? usagePayload.semantics
        : "cumulative"
    const nextCounter = (
      field: "inputTokens" | "outputTokens" | "totalTokens",
      ...keys: readonly string[]
    ): number | undefined => {
      const incoming = numericUsageField(...keys)
      if (incoming === undefined) return current?.[field]
      if (semantics !== "delta") return incoming
      const total = (current?.[field] ?? 0) + incoming
      return Number.isSafeInteger(total) ? total : current?.[field]
    }
    const rawCost = usagePayload.cost
    const incomingCost = isRecord(rawCost)
      ? typeof rawCost.amount === "number" &&
        Number.isFinite(rawCost.amount) &&
        rawCost.amount >= 0 &&
        typeof rawCost.currency === "string"
        ? {
            amount: rawCost.amount,
            currency: rawCost.currency,
            ...(typeof rawCost.source === "string" ? { source: rawCost.source } : {}),
          }
        : undefined
      : undefined
    const normalizedIncomingCost = incomingCost
      ? { ...incomingCost, source: incomingCost.source ?? source }
      : undefined
    const cost =
      semantics === "delta" &&
      normalizedIncomingCost &&
      current?.cost?.currency === normalizedIncomingCost.currency
        ? {
            ...normalizedIncomingCost,
            amount: current.cost.amount + normalizedIncomingCost.amount,
            source:
              (current.cost.source ?? current.source) === normalizedIncomingCost.source
                ? normalizedIncomingCost.source
                : "mixed",
          }
        : (normalizedIncomingCost ?? current?.cost)
    const inputTokens = nextCounter("inputTokens", "inputTokens", "input")
    const outputTokens = nextCounter("outputTokens", "outputTokens", "output")
    const totalTokens = nextCounter("totalTokens", "totalTokens", "total")
    calls[storageKey] = {
      callId,
      role,
      source,
      semantics,
      settled: semantics === "final" || current?.settled === true,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(cost ? { cost } : {}),
    }
  }
  const entries = Object.entries(calls)
  const overflowed =
    entries.length > MAX_PROJECTED_USAGE_CALLS ||
    snapshot.usage.combined.source === "bounded-call-window"
  const boundedCalls = Object.fromEntries(entries.slice(-MAX_PROJECTED_USAGE_CALLS))
  const values = Object.values(boundedCalls)
  if (overflowed) {
    const unavailable = (roleLabel: string): RunUiUsage => ({
      available: false,
      source: "bounded-call-window",
      note: `${roleLabel}: live call-detail limit exceeded; inspect the durable report`,
    })
    return {
      ...snapshot,
      usageCalls: boundedCalls,
      usage: {
        combined: unavailable("combined"),
        executor: unavailable("executor"),
        judge: unavailable("judge"),
      },
    }
  }
  return {
    ...snapshot,
    usageCalls: boundedCalls,
    usage: {
      combined: usageAggregate(values, "combined"),
      executor: usageAggregate(
        values.filter((call) => call.role === "executor"),
        "executor",
      ),
      judge: usageAggregate(
        values.filter((call) => call.role === "judge"),
        "judge",
      ),
    },
  }
}

function projectJudge(snapshot: RunUiSnapshot, event: RunUiEventEnvelope): RunUiSnapshot {
  if (event.type !== "judge.assessment.persisted" && event.type !== "evaluation.decision") {
    return snapshot
  }
  const assessment = isRecord(event.payload.assessment) ? event.payload.assessment : event.payload
  const feedback = isRecord(assessment.feedback) ? assessment.feedback : assessment
  const adequate = Array.isArray(feedback.adequate)
    ? feedback.adequate.filter((item): item is string => typeof item === "string")
    : snapshot.judge.feedback.adequate
  const problems = Array.isArray(feedback.problems)
    ? feedback.problems.map((item) =>
        typeof item === "string"
          ? item
          : isRecord(item) && typeof item.message === "string"
            ? item.message
            : String(item),
      )
    : snapshot.judge.feedback.problems
  const missing =
    recordStringArray(feedback, "missing") ??
    recordStringArray(feedback, "missingEvidence") ??
    recordStringArray(assessment, "missing") ??
    recordStringArray(assessment, "missingEvidence") ??
    snapshot.judge.feedback.missing
  const recommendations =
    recordStringArray(feedback, "recommendations") ??
    recordStringArray(assessment, "recommendations") ??
    snapshot.judge.feedback.recommendations
  const scoreValue = assessment.score ?? event.payload.score
  const score =
    scoreValue === null || (typeof scoreValue === "number" && Number.isFinite(scoreValue))
      ? scoreValue
      : snapshot.judge.score
  const threshold = payloadNumber(event, "threshold") ?? snapshot.judge.threshold
  const revisionAttempt =
    payloadNumber(event, "revisionAttempt", "revision") ?? snapshot.judge.revisionAttempt
  const maxRevisionAttempts =
    payloadNumber(event, "maxRevisionAttempts", "maxRevisions") ??
    snapshot.judge.maxRevisionAttempts
  const explicitDecision = payloadString(event, "decision", "outcome")
  const decision =
    explicitDecision ??
    (typeof score === "number" && threshold !== undefined
      ? score >= threshold
        ? "accepted"
        : "revision-required"
      : undefined)
  const summary =
    (typeof assessment.summary === "string" ? assessment.summary : undefined) ??
    payloadString(event, "summary", "opinion")
  return runUiReducer(snapshot, {
    type: "judge",
    judge: {
      ...snapshot.judge,
      ...(score !== undefined ? { score } : {}),
      ...(threshold !== undefined ? { threshold } : {}),
      revisionAttempt: Math.max(0, Math.floor(revisionAttempt)),
      maxRevisionAttempts: Math.max(0, Math.floor(maxRevisionAttempts)),
      ...(decision ? { decision } : {}),
      ...(summary ? { summary } : {}),
      feedback: { adequate, problems, missing, recommendations },
    },
  })
}

function boundedUpsert<T>(
  items: readonly T[],
  matches: (item: T) => boolean,
  value: T,
  limit = 80,
): readonly T[] {
  const index = items.findIndex(matches)
  const next =
    index < 0 ? [...items, value] : items.map((item, offset) => (offset === index ? value : item))
  return next.slice(-Math.max(1, limit))
}

function projectRuntime(snapshot: RunUiSnapshot, event: RunUiEventEnvelope): RunUiSnapshot {
  const current = snapshot.runtime ?? {
    phase: "unknown",
    attempt: 0,
    modelCalls: 0,
    toolCalls: 0,
    gateRuns: 0,
  }
  let phase = current.phase
  if (event.type.startsWith("model.")) phase = "model-call"
  else if (event.type.startsWith("tool.")) phase = "tool"
  else if (event.type.startsWith("gate.")) phase = "gate"
  else if (event.type.startsWith("judge.") || event.type.startsWith("evaluation.")) phase = "judge"
  else if (event.type.startsWith("attempt.")) phase = payloadString(event, "phase") ?? phase
  else if (event.type === "task.completed" || event.type === "task.completed.record_only") {
    phase = "completed"
  }
  const attempt = payloadNumber(event, "attempt", "ordinal")
  const runtime = {
    ...current,
    phase,
    ...(attempt !== undefined ? { attempt: Math.max(0, Math.floor(attempt)) } : {}),
    modelCalls: current.modelCalls + (event.type === "model.call.started" ? 1 : 0),
    // Tool count is reconciled by projectTool from unique durable identities.
    toolCalls: current.toolCalls,
    gateRuns:
      current.gateRuns + (event.type === "gate.completed" || event.type === "gate.skipped" ? 1 : 0),
  }
  return runUiReducer(snapshot, { type: "runtime", runtime })
}

function projectTaskTree(snapshot: RunUiSnapshot, event: RunUiEventEnvelope): RunUiSnapshot {
  const status = taskStatus(event)
  const taskId = event.taskId ?? payloadString(event, "taskId")
  if (!status || !taskId) return snapshot
  const documentId = event.documentId ?? payloadString(event, "documentId")
  const id = documentId ? `${documentId}/${taskId}` : taskId
  const ownerRunId = scopeSourceRunId(event)
  const current = snapshot.taskTree ?? []
  const existing = current.find(
    (entry) =>
      (entry.runId === undefined || entry.runId === ownerRunId) &&
      (entry.id === id || entry.id === taskId),
  )
  const attempt = payloadNumber(event, "attempt", "ordinal")
  const detail = payloadString(event, "reason", "detail")
  const depth = payloadNumber(event, "depth")
  const parentRunId = event.parentRunId ?? payloadString(event, "parentRunId")
  const entry = {
    id,
    title: payloadString(event, "title", "taskTitle") ?? existing?.title ?? taskId,
    status,
    ...(ownerRunId ? { runId: ownerRunId } : {}),
    depth: depth !== undefined ? Math.max(0, Math.floor(depth)) : (existing?.depth ?? 0),
    ...(documentId
      ? { documentId }
      : existing?.documentId
        ? { documentId: existing.documentId }
        : {}),
    ...(attempt !== undefined
      ? { attempt: Math.max(0, Math.floor(attempt)) }
      : existing?.attempt !== undefined
        ? { attempt: existing.attempt }
        : {}),
    ...(parentRunId
      ? { parentRunId }
      : existing?.parentRunId
        ? { parentRunId: existing.parentRunId }
        : {}),
    ...(detail ? { detail } : existing?.detail ? { detail: existing.detail } : {}),
  }
  return runUiReducer(snapshot, {
    type: "task-tree",
    entries: boundedUpsert(
      current,
      (candidate) =>
        candidate.runId === ownerRunId && (candidate.id === existing?.id || candidate.id === id),
      entry,
    ),
  })
}

function projectTool(snapshot: RunUiSnapshot, event: RunUiEventEnvelope): RunUiSnapshot {
  if (!event.type.startsWith("tool.")) return snapshot
  // The outer callId may identify the model turn. Tool-journal payload IDs are
  // the durable identity and must win so sibling tools never collapse.
  const callId = payloadString(event, "providerToolCallId", "toolCallId", "callId") ?? event.callId
  if (!callId) return snapshot
  const current = snapshot.tools ?? []
  const existing = current.find((tool) => tool.callId === callId)
  const name = payloadString(event, "tool", "name") ?? existing?.name ?? "unknown"
  let status = existing?.status ?? "observed"
  if (event.type === "tool.call.requested") status = "requested"
  else if (event.type === "tool.call.authorized")
    status = payloadString(event, "action") ?? "authorized"
  else if (event.type === "tool.call.started") status = "running"
  else if (event.type === "tool.call.settled") status = payloadString(event, "outcome") ?? "settled"
  else if (event.type === "tool.call.rejected.budget") status = "budget-rejected"
  const durationMs = payloadNumber(event, "durationMs")
  const preview = payloadString(event, "reason", "action", "risk", "recovery")
  const tool = {
    callId,
    name,
    status,
    timestamp: event.timestamp,
    ...(durationMs !== undefined ? { durationMs: Math.max(0, Math.floor(durationMs)) } : {}),
    ...(event.taskId
      ? { taskId: event.taskId }
      : existing?.taskId
        ? { taskId: existing.taskId }
        : {}),
    ...(event.attemptId
      ? { attemptId: event.attemptId }
      : existing?.attemptId
        ? { attemptId: existing.attemptId }
        : {}),
    ...(preview ? { preview } : existing?.preview ? { preview: existing.preview } : {}),
  }
  const projected = runUiReducer(snapshot, {
    type: "tools",
    tools: boundedUpsert(current, (candidate) => candidate.callId === callId, tool, 60),
  })
  const observedToolCallIds = [...new Set([...(snapshot.observedToolCallIds ?? []), callId])]
  return {
    ...projected,
    observedToolCallIds,
    ...(projected.runtime
      ? { runtime: { ...projected.runtime, toolCalls: observedToolCallIds.length } }
      : {}),
  }
}

function projectGate(snapshot: RunUiSnapshot, event: RunUiEventEnvelope): RunUiSnapshot {
  if (!event.type.startsWith("gate.")) return snapshot
  const id = payloadString(event, "gateId", "id")
  if (!id) return snapshot
  const current = snapshot.gates ?? []
  const existing = current.find((gate) => gate.id === id && gate.attemptId === event.attemptId)
  const durationMs = payloadNumber(event, "durationMs")
  const attempts = payloadNumber(event, "attempts")
  const blocking = event.payload.blocking
  const category = payloadString(event, "category")
  const reason = payloadString(event, "reason")
  const derivedStatus =
    event.type === "gate.skipped"
      ? "skipped"
      : event.type === "gate.completed"
        ? "completed"
        : "persisted"
  const gate = {
    id,
    status: payloadString(event, "status") ?? existing?.status ?? derivedStatus,
    timestamp: event.timestamp,
    ...(category ? { category } : existing?.category ? { category: existing.category } : {}),
    ...(typeof blocking === "boolean"
      ? { blocking }
      : existing?.blocking !== undefined
        ? { blocking: existing.blocking }
        : {}),
    ...(durationMs !== undefined ? { durationMs: Math.max(0, Math.floor(durationMs)) } : {}),
    ...(attempts !== undefined ? { attempts: Math.max(0, Math.floor(attempts)) } : {}),
    ...(event.taskId
      ? { taskId: event.taskId }
      : existing?.taskId
        ? { taskId: existing.taskId }
        : {}),
    ...(event.attemptId
      ? { attemptId: event.attemptId }
      : existing?.attemptId
        ? { attemptId: existing.attemptId }
        : {}),
    ...(reason ? { reason } : existing?.reason ? { reason: existing.reason } : {}),
  }
  return runUiReducer(snapshot, {
    type: "gates",
    gates: boundedUpsert(
      current,
      (candidate) => candidate.id === id && candidate.attemptId === gate.attemptId,
      gate,
      60,
    ),
  })
}

function projectWatchdog(snapshot: RunUiSnapshot, event: RunUiEventEnvelope): RunUiSnapshot {
  if (!event.type.startsWith("watchdog.")) return snapshot
  const current = snapshot.watchdog ?? {
    enabled: true,
    state: "unknown",
    reasons: [],
    restartUsed: 0,
    signals: [],
  }
  const rawSnapshot = isRecord(event.payload.snapshot) ? event.payload.snapshot : event.payload
  const rawDecision = isRecord(event.payload.decision) ? event.payload.decision : undefined
  const rawSignals = Array.isArray(rawSnapshot.signals) ? rawSnapshot.signals : []
  const signals = rawSignals.flatMap((value) => {
    if (!isRecord(value) || typeof value.signal !== "string" || typeof value.verdict !== "string") {
      return []
    }
    return [
      {
        name: value.signal,
        verdict: value.verdict,
        ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
        ...(typeof value.ageMs === "number" && Number.isFinite(value.ageMs)
          ? { ageMs: Math.max(0, Math.floor(value.ageMs)) }
          : {}),
      },
    ]
  })
  const budget =
    rawDecision && isRecord(rawDecision.budgetAfter) ? rawDecision.budgetAfter : undefined
  const reasons = Array.isArray(rawSnapshot.reasons)
    ? rawSnapshot.reasons.filter((value): value is string => typeof value === "string")
    : current.reasons
  const watchdog = {
    enabled: true,
    state: typeof rawSnapshot.state === "string" ? rawSnapshot.state : current.state,
    ...(typeof rawSnapshot.phase === "string"
      ? { phase: rawSnapshot.phase }
      : current.phase
        ? { phase: current.phase }
        : {}),
    ...(typeof rawSnapshot.observedAt === "string"
      ? { observedAt: rawSnapshot.observedAt }
      : current.observedAt
        ? { observedAt: current.observedAt }
        : {}),
    ...(typeof rawSnapshot.lastProgressAt === "string"
      ? { lastProgressAt: rawSnapshot.lastProgressAt }
      : current.lastProgressAt
        ? { lastProgressAt: current.lastProgressAt }
        : {}),
    ...(rawDecision && typeof rawDecision.action === "string"
      ? { action: rawDecision.action }
      : current.action
        ? { action: current.action }
        : {}),
    reasons,
    restartUsed:
      budget && typeof budget.used === "number" && Number.isSafeInteger(budget.used)
        ? Math.max(0, budget.used)
        : current.restartUsed,
    ...(budget && typeof budget.maximum === "number" && Number.isSafeInteger(budget.maximum)
      ? { restartMaximum: Math.max(0, budget.maximum) }
      : current.restartMaximum !== undefined
        ? { restartMaximum: current.restartMaximum }
        : {}),
    signals: signals.length > 0 ? signals : current.signals,
  }
  return runUiReducer(snapshot, { type: "watchdog", watchdog })
}

function projectErrorSummary(snapshot: RunUiSnapshot, event: RunUiEventEnvelope): RunUiSnapshot {
  if (event.level !== "error") return snapshot
  const current = snapshot.errorsSummary ?? { count: 0 }
  const message = eventMessage(event)
  const code = payloadString(event, "code")
  const suggestedAction = payloadString(event, "hint", "suggestedAction")
  const last = {
    timestamp: event.timestamp,
    message,
    origin: event.type,
    ...(code ? { code } : {}),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
  }
  return runUiReducer(snapshot, { type: "errors", errors: { count: current.count + 1, last } })
}

/** Pure projection for one run scope. Child-scope fan-out is applied by the public wrapper. */
function projectRunUiEventCore(
  snapshot: RunUiSnapshot,
  event: RunUiEventEnvelope,
  limits: RunUiProjectionLimits = DEFAULT_LIMITS,
): RunUiSnapshot {
  const rawLine = rawEngineLine(event)
  let next = rawLine
    ? runUiReducer(snapshot, {
        type: "raw-engine-output",
        line: rawLine,
        limit: limits.engineOutput,
      })
    : snapshot
  const resolvedRawRefs = recordStringArray(event.payload, "rawRefsResolved")
  if (resolvedRawRefs && resolvedRawRefs.length > 0) {
    next = runUiReducer(next, {
      type: "raw-engine-refs",
      refs: [...new Set([...(next.rawEngineRefs ?? []), ...resolvedRawRefs])].slice(-64),
    })
  }
  const delta = displayDelta(event)
  if (delta) {
    return runUiReducer(next, {
      type: "engine-output",
      line: delta.text,
      limit: limits.engineOutput,
    })
  }

  next = runUiReducer(next, {
    type: "append",
    channel: "events",
    entry: eventEntry(event),
    limit: limits.events,
  })
  if (!event.type.endsWith(".delta") && !event.type.endsWith("usage.updated")) {
    if (event.type !== "watchdog.probe" && event.level !== "trace") {
      next = runUiReducer(next, {
        type: "append",
        channel: "activity",
        entry: eventEntry(event),
        limit: limits.activity,
      })
    }
  }
  if (
    event.level === "warn" ||
    event.level === "error" ||
    event.type === "log.message" ||
    event.type === "diagnostic.created"
  ) {
    next = runUiReducer(next, {
      type: "append",
      channel: "logs",
      entry: eventEntry(event),
      limit: limits.logs,
    })
  }

  const status = lifecycleStatus(event)
  if (status) next = runUiReducer(next, { type: "status", status })

  const currentTaskBeforeTaskProjection = next.currentTask
  const nextTaskStatus = taskStatus(event)
  if (nextTaskStatus) {
    const taskId = event.taskId ?? payloadString(event, "taskId", "id") ?? "unknown-task"
    const id = event.documentId ? `${event.documentId}/${taskId}` : taskId
    const taskRunId = scopeSourceRunId(event)
    const existingTitle =
      next.currentTask?.id === id &&
      (next.currentTask.runId === undefined || next.currentTask.runId === taskRunId)
        ? next.currentTask.title
        : undefined
    const title = payloadString(event, "title", "taskTitle") ?? existingTitle ?? id
    const attempt = payloadNumber(event, "attempt", "ordinal")
    const detail = payloadString(event, "detail", "reason")
    const task = {
      id,
      title,
      status: nextTaskStatus,
      ...(taskRunId ? { runId: taskRunId } : {}),
      ...(attempt !== undefined ? { attempt: Math.max(0, Math.floor(attempt)) } : {}),
      ...(detail ? { detail } : {}),
    }
    const terminalTask = /^(completed|completed_with_override|rejected|cancelled)$/i.test(
      nextTaskStatus,
    )
    const isDisplayedTask =
      next.currentTask?.id === task.id && next.currentTask.runId === task.runId
    if (terminalTask && isDisplayedTask) {
      next = runUiReducer(next, { type: "task", task: null })
    } else if (shouldProjectCurrentTask(next, task, event)) {
      next = runUiReducer(next, { type: "task", task })
    }
  }

  if (event.type === "progress.updated") {
    const completed = payloadNumber(event, "completed", "completedTasks")
    const total = payloadNumber(event, "total", "totalTasks")
    if (completed !== undefined && total !== undefined) {
      const safeTotal = Math.max(0, Math.floor(total))
      next = runUiReducer(next, {
        type: "progress",
        completed: Math.min(safeTotal, Math.max(0, Math.floor(completed))),
        total: safeTotal,
      })
    }
  }

  next = projectUsage(next, event)
  if (eventBelongsToCurrentTask(event, next.currentTask ?? currentTaskBeforeTaskProjection)) {
    next = projectJudge(next, event)
    next = projectRuntime(next, event)
    next = projectWatchdog(next, event)
  }
  next = projectTaskTree(next, event)
  next = projectTool(next, event)
  next = projectGate(next, event)
  next = projectErrorSummary(next, event)

  if (
    event.type === "model.text.completed" ||
    event.type === "external.cli.output.completed" ||
    event.type === "tool.output.completed"
  ) {
    const text = payloadString(event, "text", "output", "content")
    if (text) {
      next = runUiReducer(next, {
        type: "engine-output",
        line: text,
        limit: limits.engineOutput,
      })
    }
  }
  return next
}

function scopeSourceRunId(event: RunUiEventEnvelope): string | undefined {
  const source = event.payload.sourceRunId
  return typeof source === "string" && source.length > 0 ? source : event.runId
}

function scopeSnapshot(scope: RunUiScopeProjection): RunUiSnapshot {
  return {
    ...createEmptyRunUiSnapshot(scope.runId),
    title: scope.title,
    status: scope.status,
    currentTask: scope.currentTask,
    progress: scope.progress,
    usage: scope.usage,
    usageCalls: scope.usageCalls ?? {},
    runtime: scope.runtime,
    watchdog: scope.watchdog,
    errorsSummary: scope.errors,
  }
}

function projectScopeList(
  snapshot: RunUiSnapshot,
  event: RunUiEventEnvelope,
  limits: RunUiProjectionLimits,
): RunUiSnapshot {
  const scopes = snapshot.scopes
  const sourceRunId = scopeSourceRunId(event)
  if (!scopes || !sourceRunId) return snapshot
  const index = scopes.findIndex((scope) => scope.runId === sourceRunId)
  if (index < 0) return snapshot
  const current = scopes[index] as RunUiScopeProjection
  const scopeCompleted = payloadNumber(event, "scopeCompleted")
  const scopeTotal = payloadNumber(event, "scopeTotal")
  const { parentRunId: _parentRunId, ...eventWithoutParent } = event
  // The parent relationship belongs to the outer root/child projection. A
  // child event projected as its own run must not inherit the root envelope's
  // relationship marker.
  void _parentRunId
  const scopedEvent: RunUiEventEnvelope = {
    ...eventWithoutParent,
    type: event.type.startsWith("child.run.") ? event.type.slice("child.".length) : event.type,
    runId: sourceRunId,
    payload:
      scopeCompleted !== undefined && scopeTotal !== undefined
        ? { ...event.payload, completed: scopeCompleted, total: scopeTotal }
        : event.payload,
  }
  const projected = projectRunUiEventCore(scopeSnapshot(current), scopedEvent, limits)
  const nextScope: RunUiScopeProjection = {
    ...current,
    status: projected.status,
    currentTask: projected.currentTask,
    progress: projected.progress,
    usage: projected.usage,
    usageCalls: projected.usageCalls ?? current.usageCalls ?? {},
    runtime: projected.runtime ?? current.runtime,
    watchdog: projected.watchdog ?? current.watchdog,
    errors: projected.errorsSummary ?? current.errors,
  }
  const nextScopes = [...scopes]
  nextScopes[index] = nextScope
  return runUiReducer(snapshot, { type: "scopes", scopes: nextScopes })
}

/** Pure default projection used by replay and live ingestion. */
export function projectRunUiEvent(
  snapshot: RunUiSnapshot,
  event: RunUiEventEnvelope,
  limits: RunUiProjectionLimits = DEFAULT_LIMITS,
): RunUiSnapshot {
  return projectScopeList(projectRunUiEventCore(snapshot, event, limits), event, limits)
}

interface DisplaySegment {
  readonly key: string
  readonly field: string
  readonly firstSequence: number
  readonly lastSequence: number
  readonly event: RunUiEventEnvelope
  readonly text: string
  readonly eventCount: number
  readonly omittedCharacters: number
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value))
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value))
}

function withoutConnection(snapshot: RunUiSnapshot): RunUiSnapshot {
  const copy = { ...snapshot }
  delete copy.connection
  return copy
}

export class RunUiEventStore implements IncrementalRunUiSource {
  readonly #runId: string
  readonly #projector: RunUiEventProjector
  readonly #limits: RunUiProjectionLimits
  readonly #maxRememberedEvents: number
  readonly #maxDisplaySegments: number
  readonly #maxDisplayCharactersPerSegment: number
  readonly #renderIntervalMs: number
  readonly #scheduler: RunUiRenderScheduler
  readonly #now: () => string
  readonly #onListenerError: ((error: unknown) => void) | undefined
  readonly #listeners = new Set<(snapshot: RunUiSnapshot) => void>()
  readonly #eventSequenceById = new Map<string, number>()
  readonly #eventIdBySequence = new Map<number, string>()
  #snapshot: RunUiSnapshot
  #connection: RunUiConnection
  #displaySegments: DisplaySegment[] = []
  #scheduledRenderHandle: unknown = undefined
  #renderScheduled = false
  #renderGeneration = 0
  #dirty = false

  constructor(options: RunUiEventStoreOptions) {
    if (options.runId.length === 0) {
      throw new RunUiStreamProtocolError("RALPH_TUI_RUN_ID", "runId must not be empty")
    }
    const initial = parseRunUiSnapshot(
      options.initialSnapshot ?? createEmptyRunUiSnapshot(options.runId),
    )
    if (initial.runId !== options.runId) {
      throw new RunUiStreamProtocolError(
        "RALPH_TUI_RUN_MISMATCH",
        `initial snapshot belongs to ${initial.runId}, expected ${options.runId}`,
      )
    }
    this.#runId = options.runId
    this.#snapshot = withoutConnection(initial)
    this.#projector = options.projector ?? projectRunUiEvent
    this.#limits = {
      activity: positiveInteger(options.projectionLimits?.activity, DEFAULT_LIMITS.activity),
      events: positiveInteger(options.projectionLimits?.events, DEFAULT_LIMITS.events),
      logs: positiveInteger(options.projectionLimits?.logs, DEFAULT_LIMITS.logs),
      engineOutput: positiveInteger(
        options.projectionLimits?.engineOutput,
        DEFAULT_LIMITS.engineOutput,
      ),
    }
    this.#maxRememberedEvents = positiveInteger(options.maxRememberedEvents, 2_048)
    this.#maxDisplaySegments = positiveInteger(options.maxDisplaySegments, 32)
    this.#maxDisplayCharactersPerSegment = positiveInteger(
      options.maxDisplayCharactersPerSegment,
      16_384,
    )
    this.#renderIntervalMs = nonNegativeInteger(options.renderIntervalMs, 50)
    this.#scheduler = options.scheduler ?? DEFAULT_SCHEDULER
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#onListenerError = options.onListenerError
    this.#connection = {
      phase: "idle",
      cursor: null,
      reconnectAttempt: 0,
      connectedAt: null,
      disconnectedAt: null,
      lastEventAt: null,
      lastHeartbeatAt: null,
      lastSnapshotAt: null,
      nextRetryAt: null,
      reason: null,
      metrics: EMPTY_METRICS,
    }
  }

  getSnapshot(): RunUiSnapshot {
    return { ...this.#snapshot, connection: this.#connection }
  }

  getConnection(): RunUiConnection {
    return this.#connection
  }

  subscribe(listener: (snapshot: RunUiSnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  markConnecting(reconnectAttempt = 0): void {
    this.#setConnection({
      phase: reconnectAttempt > 0 ? "reconnecting" : "connecting",
      reconnectAttempt: Math.max(0, Math.floor(reconnectAttempt)),
      nextRetryAt: null,
      reason: null,
    })
  }

  markReconnecting(reconnectAttempt: number): void {
    const nextAttempt = Math.max(1, Math.floor(reconnectAttempt))
    const metrics = {
      ...this.#connection.metrics,
      reconnects: this.#connection.metrics.reconnects + 1,
    }
    this.#setConnection({
      phase: "reconnecting",
      reconnectAttempt: nextAttempt,
      nextRetryAt: null,
      reason: this.#connection.reason,
      metrics,
    })
  }

  markDisconnected(reason: string, nextRetryAt: string | null = null): void {
    this.#flushDisplaySegments()
    this.#setConnection({
      phase: "disconnected",
      disconnectedAt: this.#now(),
      nextRetryAt,
      reason: reason.slice(0, 500),
    })
  }

  markClosed(reason = "client closed"): void {
    this.#flushDisplaySegments()
    this.#setConnection({
      phase: "closed",
      disconnectedAt: this.#now(),
      nextRetryAt: null,
      reason: reason.slice(0, 500),
    })
    this.flushNow()
  }

  acceptSnapshot(snapshot: RunUiSnapshot, cursorValue: RunUiEventCursor): void {
    try {
      this.#acceptSnapshot(snapshot, cursorValue, "live")
    } catch (error) {
      if (error instanceof RunUiStreamProtocolError) this.#recordProtocolError()
      throw error
    }
  }

  acceptReplaySnapshot(snapshot: RunUiSnapshot, cursorValue: RunUiEventCursor): void {
    try {
      this.#acceptSnapshot(snapshot, cursorValue, "replay")
    } catch (error) {
      if (error instanceof RunUiStreamProtocolError) this.#recordProtocolError()
      throw error
    }
  }

  acceptHeartbeat(cursor: RunUiEventCursor): RunUiIngestResult {
    const result = this.ingestBatch({ cursor, events: [] })
    this.#setConnection({ lastHeartbeatAt: this.#now() })
    return result
  }

  ingestBatch(batch: RunUiEventBatch): RunUiIngestResult {
    try {
      return this.#ingestValidatedBatch(batch)
    } catch (error) {
      if (error instanceof RunUiStreamProtocolError) this.#recordProtocolError()
      throw error
    }
  }

  flushNow(): void {
    if (this.#renderScheduled) {
      this.#renderScheduled = false
      this.#renderGeneration += 1
      this.#scheduler.cancel(this.#scheduledRenderHandle)
      this.#scheduledRenderHandle = undefined
    }
    this.#flushDisplaySegments()
    this.#emitIfDirty()
  }

  #acceptSnapshot(
    snapshot: RunUiSnapshot,
    cursorValue: RunUiEventCursor,
    phase: "live" | "replay",
  ): void {
    const validatedSnapshot = parseRunUiSnapshot(snapshot)
    const cursor = parseRunUiEventCursor(cursorValue)
    if (validatedSnapshot.runId !== this.#runId) {
      protocolError(
        "RALPH_TUI_RUN_MISMATCH",
        `snapshot belongs to ${validatedSnapshot.runId}, expected ${this.#runId}`,
      )
    }
    const currentCursor = this.#connection.cursor
    if (currentCursor && currentCursor.streamId !== cursor.streamId) {
      protocolError(
        "RALPH_TUI_STREAM_MISMATCH",
        `snapshot stream ${cursor.streamId} does not match ${currentCursor.streamId}`,
      )
    }
    if (currentCursor && cursor.sequence < currentCursor.sequence) {
      protocolError(
        "RALPH_TUI_CURSOR_REGRESSION",
        `snapshot cursor ${cursor.sequence} regresses from ${currentCursor.sequence}`,
      )
    }
    this.#displaySegments = []
    this.#eventSequenceById.clear()
    this.#eventIdBySequence.clear()
    this.#snapshot = withoutConnection(validatedSnapshot)
    const now = this.#now()
    this.#setConnection({
      phase,
      cursor,
      reconnectAttempt: 0,
      connectedAt: now,
      disconnectedAt: null,
      lastSnapshotAt: now,
      nextRetryAt: null,
      reason: null,
    })
  }

  #ingestValidatedBatch(batch: RunUiEventBatch): RunUiIngestResult {
    if (!isRecord(batch) || !Array.isArray(batch.events)) {
      protocolError("RALPH_TUI_BATCH_SCHEMA", "event batch must contain an events array")
    }
    if (batch.events.length > MAX_EVENT_BATCH_EVENTS) {
      protocolError("RALPH_TUI_BATCH_LIMIT", `event batch exceeds ${MAX_EVENT_BATCH_EVENTS} events`)
    }
    const cursor = parseRunUiEventCursor(batch.cursor)
    const events = batch.events.map((event) => parseRunUiEventEnvelope(event))
    const currentCursor = this.#connection.cursor
    if (currentCursor && currentCursor.streamId !== cursor.streamId) {
      protocolError(
        "RALPH_TUI_STREAM_MISMATCH",
        `batch stream ${cursor.streamId} does not match ${currentCursor.streamId}`,
      )
    }

    const localSequenceIds = new Map<number, string>()
    const localIdSequences = new Map<string, number>()
    for (const event of events) {
      // The cursor identifies the shared ordered ledger feed. Events inside a
      // run-filtered page may legitimately retain different producer streamIds
      // (for example `run:<id>` and `<id>`) while sharing that ledger sequence.
      if (event.sequence > cursor.sequence) {
        protocolError(
          "RALPH_TUI_CURSOR_BEHIND_EVENT",
          `cursor ${cursor.sequence} is behind event ${event.sequence}`,
        )
      }
      if (event.runId !== undefined && event.runId !== this.#runId) {
        protocolError(
          "RALPH_TUI_RUN_MISMATCH",
          `event ${event.eventId} belongs to ${String(event.runId)}, expected ${this.#runId}`,
        )
      }
      const sequenceOwner = localSequenceIds.get(event.sequence)
      if (sequenceOwner !== undefined && sequenceOwner !== event.eventId) {
        protocolError(
          "RALPH_TUI_SEQUENCE_CONFLICT",
          `sequence ${event.sequence} is shared by ${sequenceOwner} and ${event.eventId}`,
        )
      }
      const idSequence = localIdSequences.get(event.eventId)
      if (idSequence !== undefined && idSequence !== event.sequence) {
        protocolError(
          "RALPH_TUI_EVENT_ID_CONFLICT",
          `event ${event.eventId} changed sequence from ${idSequence} to ${event.sequence}`,
        )
      }
      localSequenceIds.set(event.sequence, event.eventId)
      localIdSequences.set(event.eventId, event.sequence)
    }

    const ordered = [...events].sort(
      (left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId),
    )
    let applied = 0
    let duplicates = 0
    let stale = 0
    const previousSequence = currentCursor?.sequence ?? -1

    // Detect all durable-identity conflicts before mutating the projection.
    for (const event of ordered) {
      const rememberedSequence = this.#eventSequenceById.get(event.eventId)
      const rememberedId = this.#eventIdBySequence.get(event.sequence)
      if (rememberedSequence !== undefined && rememberedSequence !== event.sequence) {
        protocolError(
          "RALPH_TUI_EVENT_ID_CONFLICT",
          `event ${event.eventId} changed sequence from ${rememberedSequence} to ${event.sequence}`,
        )
      }
      if (rememberedId !== undefined && rememberedId !== event.eventId) {
        protocolError(
          "RALPH_TUI_SEQUENCE_CONFLICT",
          `sequence ${event.sequence} changed event from ${rememberedId} to ${event.eventId}`,
        )
      }
    }

    if (cursor.sequence < previousSequence) {
      stale = ordered.length
    } else {
      for (const event of ordered) {
        const rememberedSequence = this.#eventSequenceById.get(event.eventId)
        const rememberedId = this.#eventIdBySequence.get(event.sequence)
        if (rememberedSequence !== undefined || rememberedId !== undefined) {
          duplicates += 1
          continue
        }
        if (event.sequence <= previousSequence) {
          stale += 1
          continue
        }
        this.#applyEvent(event)
        this.#rememberEvent(event)
        applied += 1
      }
    }

    const now = this.#now()
    const returningFromDisconnect =
      this.#connection.phase === "disconnected" || this.#connection.phase === "reconnecting"
    const nextPhase = this.#connection.phase === "replay" ? "replay" : "live"
    this.#setConnection({
      phase: nextPhase,
      cursor: cursor.sequence >= previousSequence ? cursor : (currentCursor ?? cursor),
      reconnectAttempt: 0,
      connectedAt: returningFromDisconnect ? now : (this.#connection.connectedAt ?? now),
      disconnectedAt: null,
      lastEventAt: applied > 0 ? now : this.#connection.lastEventAt,
      nextRetryAt: null,
      reason: null,
      metrics: {
        ...this.#connection.metrics,
        receivedEvents: this.#connection.metrics.receivedEvents + ordered.length,
        appliedEvents: this.#connection.metrics.appliedEvents + applied,
        duplicateEvents: this.#connection.metrics.duplicateEvents + duplicates,
        staleEvents: this.#connection.metrics.staleEvents + stale,
      },
    })
    return {
      cursor: this.#connection.cursor ?? cursor,
      received: ordered.length,
      applied,
      duplicates,
      stale,
    }
  }

  #applyEvent(event: RunUiEventEnvelope): void {
    const delta = displayDelta(event)
    if (delta) {
      this.#stageDisplayEvent(event, delta)
      return
    }
    this.#flushDisplaySegments()
    this.#snapshot = this.#projector(this.#snapshot, event, this.#limits)
    this.#dirty = true
  }

  #stageDisplayEvent(event: RunUiEventEnvelope, delta: DisplayDelta): void {
    const last = this.#displaySegments.at(-1)
    if (last && last.key === delta.key && last.field === delta.field) {
      const combined = `${last.text}${delta.text}`
      const dropped = Math.max(0, combined.length - this.#maxDisplayCharactersPerSegment)
      this.#displaySegments[this.#displaySegments.length - 1] = {
        ...last,
        lastSequence: event.sequence,
        event,
        text: dropped > 0 ? combined.slice(dropped) : combined,
        eventCount: last.eventCount + 1,
        omittedCharacters: last.omittedCharacters + dropped,
      }
      this.#connection = {
        ...this.#connection,
        metrics: {
          ...this.#connection.metrics,
          coalescedDisplayEvents: this.#connection.metrics.coalescedDisplayEvents + 1,
          droppedDisplayEvents:
            this.#connection.metrics.droppedDisplayEvents + (dropped > 0 ? 1 : 0),
          droppedDisplayCharacters: this.#connection.metrics.droppedDisplayCharacters + dropped,
        },
      }
    } else {
      if (this.#displaySegments.length >= this.#maxDisplaySegments) {
        const oldest = this.#displaySegments.shift()
        if (oldest) this.#flushDisplaySegment(oldest)
      }
      const dropped = Math.max(0, delta.text.length - this.#maxDisplayCharactersPerSegment)
      this.#displaySegments.push({
        key: delta.key,
        field: delta.field,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        event,
        text: dropped > 0 ? delta.text.slice(dropped) : delta.text,
        eventCount: 1,
        omittedCharacters: dropped,
      })
      if (dropped > 0) {
        this.#connection = {
          ...this.#connection,
          metrics: {
            ...this.#connection.metrics,
            droppedDisplayEvents: this.#connection.metrics.droppedDisplayEvents + 1,
            droppedDisplayCharacters: this.#connection.metrics.droppedDisplayCharacters + dropped,
          },
        }
      }
    }
    this.#dirty = true
    this.#requestRender()
  }

  #flushDisplaySegments(): void {
    if (this.#displaySegments.length === 0) return
    const segments = this.#displaySegments
    this.#displaySegments = []
    for (const segment of segments) this.#flushDisplaySegment(segment)
  }

  #flushDisplaySegment(segment: DisplaySegment): void {
    const prefix =
      segment.omittedCharacters > 0
        ? `[display omitted ${segment.omittedCharacters} chars; raw stream remains authoritative]\n`
        : ""
    const payload = {
      ...segment.event.payload,
      [segment.field]: `${prefix}${segment.text}`,
      tuiDisplay: {
        firstSequence: segment.firstSequence,
        lastSequence: segment.lastSequence,
        eventCount: segment.eventCount,
        omittedCharacters: segment.omittedCharacters,
      },
    }
    this.#snapshot = this.#projector(this.#snapshot, { ...segment.event, payload }, this.#limits)
    this.#dirty = true
  }

  #rememberEvent(event: RunUiEventEnvelope): void {
    this.#eventSequenceById.set(event.eventId, event.sequence)
    this.#eventIdBySequence.set(event.sequence, event.eventId)
    while (this.#eventSequenceById.size > this.#maxRememberedEvents) {
      const oldest = this.#eventSequenceById.entries().next().value as
        | readonly [string, number]
        | undefined
      if (!oldest) break
      const [eventId, sequence] = oldest
      this.#eventSequenceById.delete(eventId)
      if (this.#eventIdBySequence.get(sequence) === eventId) {
        this.#eventIdBySequence.delete(sequence)
      }
    }
  }

  #setConnection(patch: Partial<RunUiConnection>): void {
    this.#connection = { ...this.#connection, ...patch }
    this.#dirty = true
    this.#requestRender()
  }

  #recordProtocolError(): void {
    this.#setConnection({
      metrics: {
        ...this.#connection.metrics,
        protocolErrors: this.#connection.metrics.protocolErrors + 1,
      },
    })
  }

  #requestRender(): void {
    if (this.#renderScheduled) return
    this.#renderScheduled = true
    const generation = ++this.#renderGeneration
    let callbackRanSynchronously = false
    const handle = this.#scheduler.schedule(() => {
      callbackRanSynchronously = true
      if (generation !== this.#renderGeneration) return
      this.#renderScheduled = false
      this.#scheduledRenderHandle = undefined
      this.#flushDisplaySegments()
      this.#emitIfDirty()
    }, this.#renderIntervalMs)
    if (!callbackRanSynchronously) this.#scheduledRenderHandle = handle
  }

  #emitIfDirty(): void {
    if (!this.#dirty) return
    this.#dirty = false
    this.#connection = {
      ...this.#connection,
      metrics: {
        ...this.#connection.metrics,
        renderFlushes: this.#connection.metrics.renderFlushes + 1,
      },
    }
    const view = this.getSnapshot()
    for (const listener of this.#listeners) {
      try {
        listener(view)
      } catch (error) {
        try {
          this.#onListenerError?.(error)
        } catch {
          // Listener diagnostics cannot block other subscribers.
        }
      }
    }
  }
}
