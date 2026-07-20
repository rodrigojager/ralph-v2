import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import { redactValue } from "@ralph-next/telemetry"
import { appendEventInTransaction, persistenceSecretValues, withLedger } from "./ledger"

export const TOOL_CALL_RISKS = [
  "read",
  "write",
  "process",
  "network",
  "external-effect",
  "destructive",
] as const
export type ToolCallRisk = (typeof TOOL_CALL_RISKS)[number]

export const TOOL_CALL_EFFECT_CLASSES = [
  "read-only",
  "workspace-write",
  "process",
  "network",
  "external-effect",
  "destructive",
] as const
export type ToolCallEffectClass = (typeof TOOL_CALL_EFFECT_CLASSES)[number]

export const TOOL_CALL_AUTHORIZATIONS = ["allowed", "denied", "asked"] as const
export type ToolCallAuthorization = (typeof TOOL_CALL_AUTHORIZATIONS)[number]

export const TOOL_CALL_RECOVERY_STRATEGIES = [
  "safe-to-retry",
  "verify-preconditions",
  "inspect-process",
  "manual-reconciliation",
  "never-retry",
] as const
export type ToolCallRecoveryStrategy = (typeof TOOL_CALL_RECOVERY_STRATEGIES)[number]

export const TOOL_CALL_SETTLEMENT_OUTCOMES = [
  "succeeded",
  "failed",
  "nonzero",
  "denied",
  "timeout",
  "cancelled",
  "interrupted",
  "needs-reconciliation",
] as const
export type ToolCallSettlementOutcome = (typeof TOOL_CALL_SETTLEMENT_OUTCOMES)[number]

export const TOOL_CALL_JOURNAL_LIMITS = {
  identifierBytes: 512,
  toolNameBytes: 128,
  errorCodeBytes: 256,
  structuredValueBytes: 64 * 1024,
  structuredValueDepth: 16,
  structuredValueNodes: 4_096,
  structuredCollectionItems: 512,
  referenceCount: 64,
  referenceBytes: 1_024,
  referencesTotalBytes: 32 * 1024,
} as const

type JsonPrimitive = null | boolean | number | string
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type ToolCallIdentity = {
  runId: string
  documentId: string
  taskId: string
  attemptId: string
  modelCallId: string
  providerToolCallId: string
}

export type RecordToolCallIntentInput = ToolCallIdentity & {
  id: string
  tool: string
  argumentsHash: string
  arguments: unknown
  idempotencyKey?: string
  risk: ToolCallRisk
  effectClass: ToolCallEffectClass
  authorization: ToolCallAuthorization
  recoveryStrategy?: ToolCallRecoveryStrategy
  preconditionRefs?: readonly string[]
  requestedAt?: string
}

export type ToolCallIntentRecord = ToolCallIdentity & {
  schemaVersion: 1
  id: string
  tool: string
  argumentsHash: string
  argumentsRedacted: unknown
  idempotencyKey: string
  risk: ToolCallRisk
  effectClass: ToolCallEffectClass
  authorization: ToolCallAuthorization
  recoveryStrategy: ToolCallRecoveryStrategy
  preconditionRefsHash: string
  preconditionRefs: string[]
  requestedAt: string
}

export type ToolCallIntentResolution = {
  disposition: "created" | "existing"
  intent: ToolCallIntentRecord
}

export type SettleToolCallInput = {
  id: string
  intentId: string
  outcome: ToolCallSettlementOutcome
  resultHash: string
  result: unknown
  effectRefs?: readonly string[]
  outputRefs?: readonly string[]
  errorCode?: string
  settledAt?: string
}

export type ToolCallSettlementRecord = {
  schemaVersion: 1
  id: string
  intentId: string
  outcome: ToolCallSettlementOutcome
  resultHash: string
  resultRedacted: unknown
  effectRefsHash: string
  effectRefs: string[]
  outputRefsHash: string
  outputRefs: string[]
  errorCode?: string
  settledAt: string
}

export type UnsettledToolCallQuery = {
  runId?: string
  documentId?: string
  taskId?: string
  attemptId?: string
  modelCallId?: string
}

export type ToolCallJournalRecord = {
  intent: ToolCallIntentRecord
  settlement?: ToolCallSettlementRecord
}

export type ToolCallRecoveryClassification = {
  strategy: ToolCallRecoveryStrategy
  automaticReplayAllowed: boolean
  requiresReconciliation: boolean
  reason: string
}

export type UnsettledToolCallRecord = {
  intent: ToolCallIntentRecord
  recovery: ToolCallRecoveryClassification
}

export interface ToolCallJournal {
  recordIntent(input: RecordToolCallIntentInput): ToolCallIntentResolution
  settle(input: SettleToolCallInput): ToolCallSettlementRecord
  getIntent(intentId: string): ToolCallIntentRecord | undefined
  getByProviderIdentity(
    modelCallId: string,
    providerToolCallId: string,
  ): ToolCallIntentRecord | undefined
  getSettlement(intentId: string): ToolCallSettlementRecord | undefined
  list(query?: UnsettledToolCallQuery): ToolCallJournalRecord[]
  listUnsettled(query?: UnsettledToolCallQuery): UnsettledToolCallRecord[]
}

type IntentRow = {
  id: string
  schema_version: number
  run_id: string
  document_id: string
  task_id: string
  attempt_id: string
  model_call_id: string
  provider_tool_call_id: string
  tool_name: string
  arguments_hash: string
  arguments_redacted_json: string
  idempotency_key: string
  risk: string
  effect_class: string
  authorization: string
  recovery_strategy: string
  precondition_refs_hash: string
  precondition_refs_json: string
  requested_at: string
}

type SettlementRow = {
  id: string
  schema_version: number
  intent_id: string
  outcome: string
  result_hash: string
  result_redacted_json: string
  effect_refs_hash: string
  effect_refs_json: string
  output_refs_hash: string
  output_refs_json: string
  error_code: string | null
  settled_at: string
}

type ToolCallScopeRow = {
  workspace_id: string
  run_id: string
  document_id: string
  task_id: string
  attempt_id: string
}

const INTENT_COLUMNS = `id, schema_version, run_id, document_id, task_id, attempt_id,
  model_call_id, provider_tool_call_id, tool_name, arguments_hash, arguments_redacted_json,
  idempotency_key, risk, effect_class, authorization, recovery_strategy,
  precondition_refs_hash, precondition_refs_json, requested_at`

const SETTLEMENT_COLUMNS = `id, schema_version, intent_id, outcome, result_hash,
  result_redacted_json, effect_refs_hash, effect_refs_json, output_refs_hash,
  output_refs_json, error_code, settled_at`

function invalidInput(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RalphError {
  return new RalphError(code, message, {
    exitCode: EXIT_CODES.invalidUsage,
    ...(details === undefined ? {} : { details }),
  })
}

function conflict(code: string, message: string, details?: Record<string, unknown>): RalphError {
  return new RalphError(code, message, {
    exitCode: EXIT_CODES.conflict,
    ...(details === undefined ? {} : { details }),
  })
}

function invalidLedger(message: string, cause?: unknown): RalphError {
  return new RalphError("RALPH_TOOL_CALL_JOURNAL_INVALID_RECORD", message, {
    exitCode: EXIT_CODES.operationalError,
    ...(cause === undefined ? {} : { cause }),
  })
}

function boundedString(value: string, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw invalidInput("RALPH_TOOL_CALL_FIELD_INVALID", `${label} must be a non-empty string`)
  }
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes > maxBytes) {
    throw invalidInput(
      "RALPH_TOOL_CALL_FIELD_TOO_LARGE",
      `${label} exceeds the ${maxBytes}-byte persistence limit`,
      { field: label, bytes, maxBytes },
    )
  }
  return value
}

function digest(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw invalidInput(
      "RALPH_TOOL_CALL_HASH_INVALID",
      `${label} must be a lowercase SHA-256 digest`,
      { field: label },
    )
  }
  return value
}

function timestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw invalidInput(
      "RALPH_TOOL_CALL_TIMESTAMP_INVALID",
      `${label} must be an RFC 3339 timestamp`,
    )
  }
  return value
}

function enumValue<T extends readonly string[]>(
  values: T,
  value: string,
  label: string,
  persisted = false,
): T[number] {
  if ((values as readonly string[]).includes(value)) return value as T[number]
  if (persisted) throw invalidLedger(`Invalid ${label} in the tool-call journal: ${value}`)
  throw invalidInput("RALPH_TOOL_CALL_FIELD_INVALID", `Invalid ${label}: ${value}`)
}

type JsonTraversalState = {
  nodes: number
  seen: WeakSet<object>
}

function normalizeJsonValue(
  value: unknown,
  label: string,
  state: JsonTraversalState,
  depth = 0,
): JsonValue {
  state.nodes += 1
  if (state.nodes > TOOL_CALL_JOURNAL_LIMITS.structuredValueNodes) {
    throw invalidInput(
      "RALPH_TOOL_CALL_VALUE_TOO_LARGE",
      `${label} exceeds the structured node limit`,
    )
  }
  if (depth > TOOL_CALL_JOURNAL_LIMITS.structuredValueDepth) {
    throw invalidInput(
      "RALPH_TOOL_CALL_VALUE_TOO_DEEP",
      `${label} exceeds the structured depth limit`,
    )
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidInput("RALPH_TOOL_CALL_VALUE_INVALID", `${label} contains a non-finite number`)
    }
    return value
  }
  if (typeof value !== "object") {
    throw invalidInput("RALPH_TOOL_CALL_VALUE_INVALID", `${label} must contain only JSON values`)
  }
  if (state.seen.has(value)) {
    throw invalidInput("RALPH_TOOL_CALL_VALUE_INVALID", `${label} contains a circular reference`)
  }
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > TOOL_CALL_JOURNAL_LIMITS.structuredCollectionItems) {
        throw invalidInput(
          "RALPH_TOOL_CALL_VALUE_TOO_LARGE",
          `${label} exceeds the collection item limit`,
        )
      }
      return value.map((item) => normalizeJsonValue(item, label, state, depth + 1))
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidInput("RALPH_TOOL_CALL_VALUE_INVALID", `${label} contains a non-plain object`)
    }
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    if (entries.length > TOOL_CALL_JOURNAL_LIMITS.structuredCollectionItems) {
      throw invalidInput(
        "RALPH_TOOL_CALL_VALUE_TOO_LARGE",
        `${label} exceeds the collection item limit`,
      )
    }
    const output: { [key: string]: JsonValue } = {}
    for (const [key, item] of entries) {
      boundedString(key, `${label} key`, TOOL_CALL_JOURNAL_LIMITS.identifierBytes)
      output[key] = normalizeJsonValue(item, label, state, depth + 1)
    }
    return output
  } finally {
    state.seen.delete(value)
  }
}

function canonicalJson(value: unknown, label: string): string {
  const normalized = normalizeJsonValue(value, label, { nodes: 0, seen: new WeakSet() })
  const json = JSON.stringify(normalized)
  const bytes = Buffer.byteLength(json, "utf8")
  if (bytes > TOOL_CALL_JOURNAL_LIMITS.structuredValueBytes) {
    throw invalidInput(
      "RALPH_TOOL_CALL_VALUE_TOO_LARGE",
      `${label} exceeds the ${TOOL_CALL_JOURNAL_LIMITS.structuredValueBytes}-byte persistence limit`,
      { bytes, maxBytes: TOOL_CALL_JOURNAL_LIMITS.structuredValueBytes },
    )
  }
  return json
}

function redactedJson(database: Database, value: unknown, label: string): string {
  const normalized = normalizeJsonValue(value, label, { nodes: 0, seen: new WeakSet() })
  return canonicalJson(redactValue(normalized, persistenceSecretValues(database)), label)
}

function parseStoredJson(json: string, label: string): unknown {
  try {
    return normalizeJsonValue(JSON.parse(json), label, { nodes: 0, seen: new WeakSet() })
  } catch (error) {
    if (error instanceof RalphError)
      throw invalidLedger(`Invalid ${label} in the tool-call journal`, error)
    throw invalidLedger(`Invalid ${label} JSON in the tool-call journal`, error)
  }
}

function redactedReferences(
  database: Database,
  refs: readonly string[] | undefined,
  label: string,
): { values: string[]; json: string; hash: string } {
  const input = refs ?? []
  if (input.length > TOOL_CALL_JOURNAL_LIMITS.referenceCount) {
    throw invalidInput(
      "RALPH_TOOL_CALL_REFERENCES_TOO_LARGE",
      `${label} exceeds the reference count limit`,
    )
  }
  const rawValues = input.map((ref, index) =>
    boundedString(ref, `${label}[${index}]`, TOOL_CALL_JOURNAL_LIMITS.referenceBytes),
  )
  const secrets = persistenceSecretValues(database)
  const values = rawValues.map((value, index) => {
    const redacted = redactValue(value, secrets)
    if (typeof redacted !== "string") {
      throw invalidInput("RALPH_TOOL_CALL_REFERENCE_INVALID", `${label}[${index}] is invalid`)
    }
    return redacted
  })
  const json = JSON.stringify(values)
  if (Buffer.byteLength(json, "utf8") > TOOL_CALL_JOURNAL_LIMITS.referencesTotalBytes) {
    throw invalidInput(
      "RALPH_TOOL_CALL_REFERENCES_TOO_LARGE",
      `${label} exceeds the total byte limit`,
    )
  }
  return { values, json, hash: hashToolCallPayload(rawValues) }
}

function parseStoredReferences(json: string, label: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw invalidLedger(`Invalid ${label} JSON in the tool-call journal`, error)
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalidLedger(`Invalid ${label} in the tool-call journal`)
  }
  if (value.length > TOOL_CALL_JOURNAL_LIMITS.referenceCount) {
    throw invalidLedger(`${label} exceeds the persisted reference count limit`)
  }
  return value
}

function defaultRecoveryStrategy(effectClass: ToolCallEffectClass): ToolCallRecoveryStrategy {
  switch (effectClass) {
    case "read-only":
      return "safe-to-retry"
    case "workspace-write":
      return "verify-preconditions"
    case "process":
      return "inspect-process"
    case "network":
    case "external-effect":
      return "manual-reconciliation"
    case "destructive":
      return "never-retry"
  }
}

export function createToolCallIdempotencyKey(
  identity: ToolCallIdentity,
  argumentsHash: string,
): string {
  const segments = [
    boundedString(identity.runId, "runId", TOOL_CALL_JOURNAL_LIMITS.identifierBytes),
    boundedString(identity.documentId, "documentId", TOOL_CALL_JOURNAL_LIMITS.identifierBytes),
    boundedString(identity.taskId, "taskId", TOOL_CALL_JOURNAL_LIMITS.identifierBytes),
    boundedString(identity.attemptId, "attemptId", TOOL_CALL_JOURNAL_LIMITS.identifierBytes),
    boundedString(identity.modelCallId, "modelCallId", TOOL_CALL_JOURNAL_LIMITS.identifierBytes),
    boundedString(
      identity.providerToolCallId,
      "providerToolCallId",
      TOOL_CALL_JOURNAL_LIMITS.identifierBytes,
    ),
    digest(argumentsHash, "argumentsHash"),
  ]
  const hash = createHash("sha256")
  for (const segment of segments) {
    hash.update(String(Buffer.byteLength(segment, "utf8")))
    hash.update(":")
    hash.update(segment)
    hash.update(";")
  }
  return hash.digest("hex")
}

export function hashToolCallPayload(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value, "tool-call payload"), "utf8")
    .digest("hex")
}

function intentFromRow(row: IntentRow): ToolCallIntentRecord {
  if (row.schema_version !== 1) {
    throw invalidLedger(`Unsupported tool-call intent schema version: ${row.schema_version}`)
  }
  return {
    schemaVersion: 1,
    id: row.id,
    runId: row.run_id,
    documentId: row.document_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    modelCallId: row.model_call_id,
    providerToolCallId: row.provider_tool_call_id,
    tool: row.tool_name,
    argumentsHash: digest(row.arguments_hash, "persisted argumentsHash"),
    argumentsRedacted: parseStoredJson(row.arguments_redacted_json, "redacted tool arguments"),
    idempotencyKey: digest(row.idempotency_key, "persisted idempotencyKey"),
    risk: enumValue(TOOL_CALL_RISKS, row.risk, "tool-call risk", true),
    effectClass: enumValue(
      TOOL_CALL_EFFECT_CLASSES,
      row.effect_class,
      "tool-call effect class",
      true,
    ),
    authorization: enumValue(
      TOOL_CALL_AUTHORIZATIONS,
      row.authorization,
      "tool-call authorization",
      true,
    ),
    recoveryStrategy: enumValue(
      TOOL_CALL_RECOVERY_STRATEGIES,
      row.recovery_strategy,
      "tool-call recovery strategy",
      true,
    ),
    preconditionRefsHash: digest(row.precondition_refs_hash, "persisted preconditionRefsHash"),
    preconditionRefs: parseStoredReferences(row.precondition_refs_json, "precondition refs"),
    requestedAt: row.requested_at,
  }
}

function settlementFromRow(row: SettlementRow): ToolCallSettlementRecord {
  if (row.schema_version !== 1) {
    throw invalidLedger(`Unsupported tool-call settlement schema version: ${row.schema_version}`)
  }
  const record: ToolCallSettlementRecord = {
    schemaVersion: 1,
    id: row.id,
    intentId: row.intent_id,
    outcome: enumValue(
      TOOL_CALL_SETTLEMENT_OUTCOMES,
      row.outcome,
      "tool-call settlement outcome",
      true,
    ),
    resultHash: digest(row.result_hash, "persisted resultHash"),
    resultRedacted: parseStoredJson(row.result_redacted_json, "redacted tool result"),
    effectRefsHash: digest(row.effect_refs_hash, "persisted effectRefsHash"),
    effectRefs: parseStoredReferences(row.effect_refs_json, "effect refs"),
    outputRefsHash: digest(row.output_refs_hash, "persisted outputRefsHash"),
    outputRefs: parseStoredReferences(row.output_refs_json, "output refs"),
    settledAt: row.settled_at,
  }
  if (row.error_code !== null) record.errorCode = row.error_code
  return record
}

function findIntentById(database: Database, intentId: string): ToolCallIntentRecord | undefined {
  const row = database
    .query<IntentRow, [string]>(`SELECT ${INTENT_COLUMNS} FROM tool_call_intents WHERE id = ?`)
    .get(intentId)
  return row ? intentFromRow(row) : undefined
}

function findIntentByProviderIdentity(
  database: Database,
  modelCallId: string,
  providerToolCallId: string,
): ToolCallIntentRecord | undefined {
  const row = database
    .query<IntentRow, [string, string]>(
      `SELECT ${INTENT_COLUMNS} FROM tool_call_intents
       WHERE model_call_id = ? AND provider_tool_call_id = ?`,
    )
    .get(modelCallId, providerToolCallId)
  return row ? intentFromRow(row) : undefined
}

function findSettlementByIntent(
  database: Database,
  intentId: string,
): ToolCallSettlementRecord | undefined {
  const row = database
    .query<SettlementRow, [string]>(
      `SELECT ${SETTLEMENT_COLUMNS} FROM tool_call_settlements WHERE intent_id = ?`,
    )
    .get(intentId)
  return row ? settlementFromRow(row) : undefined
}

function requireScope(database: Database, input: ToolCallIdentity): ToolCallScopeRow {
  const row = database
    .query<ToolCallScopeRow, [string, string]>(
      `SELECT run.workspace_id, attempt.run_id, attempt.document_id, attempt.task_id,
              attempt.id AS attempt_id
       FROM model_calls AS model_call
       JOIN attempts AS attempt ON attempt.id = model_call.attempt_id
       JOIN runs AS run ON run.id = attempt.run_id
       WHERE model_call.id = ? AND attempt.id = ?`,
    )
    .get(input.modelCallId, input.attemptId)
  if (!row) {
    throw conflict(
      "RALPH_TOOL_CALL_SCOPE_MISMATCH",
      `Model call ${input.modelCallId} does not belong to attempt ${input.attemptId}`,
    )
  }
  if (
    row.run_id !== input.runId ||
    row.document_id !== input.documentId ||
    row.task_id !== input.taskId
  ) {
    throw conflict(
      "RALPH_TOOL_CALL_SCOPE_MISMATCH",
      "Tool-call identity does not match the persisted model call scope",
      {
        modelCallId: input.modelCallId,
        expectedRunId: row.run_id,
        expectedDocumentId: row.document_id,
        expectedTaskId: row.task_id,
      },
    )
  }
  return row
}

function assertExistingIntentMatches(
  existing: ToolCallIntentRecord,
  normalized: Omit<ToolCallIntentRecord, "schemaVersion" | "argumentsRedacted" | "requestedAt">,
): void {
  if (existing.argumentsHash !== normalized.argumentsHash) {
    throw conflict(
      "RALPH_TOOL_CALL_IDEMPOTENCY_CONFLICT",
      `Provider tool call ${existing.providerToolCallId} was reused with different arguments`,
      {
        modelCallId: existing.modelCallId,
        providerToolCallId: existing.providerToolCallId,
        persistedArgumentsHash: existing.argumentsHash,
        receivedArgumentsHash: normalized.argumentsHash,
      },
    )
  }
  const drift =
    existing.idempotencyKey !== normalized.idempotencyKey ||
    existing.runId !== normalized.runId ||
    existing.documentId !== normalized.documentId ||
    existing.taskId !== normalized.taskId ||
    existing.attemptId !== normalized.attemptId ||
    existing.modelCallId !== normalized.modelCallId ||
    existing.providerToolCallId !== normalized.providerToolCallId ||
    existing.tool !== normalized.tool ||
    existing.risk !== normalized.risk ||
    existing.effectClass !== normalized.effectClass ||
    existing.authorization !== normalized.authorization ||
    existing.recoveryStrategy !== normalized.recoveryStrategy ||
    existing.preconditionRefsHash !== normalized.preconditionRefsHash
  if (drift) {
    throw conflict(
      "RALPH_TOOL_CALL_INTENT_DRIFT",
      `Provider tool call ${existing.providerToolCallId} conflicts with its persisted intent`,
      { modelCallId: existing.modelCallId, providerToolCallId: existing.providerToolCallId },
    )
  }
}

export function recordToolCallIntent(
  path: string,
  input: RecordToolCallIntentInput,
): ToolCallIntentResolution {
  const identity: ToolCallIdentity = {
    runId: boundedString(input.runId, "runId", TOOL_CALL_JOURNAL_LIMITS.identifierBytes),
    documentId: boundedString(
      input.documentId,
      "documentId",
      TOOL_CALL_JOURNAL_LIMITS.identifierBytes,
    ),
    taskId: boundedString(input.taskId, "taskId", TOOL_CALL_JOURNAL_LIMITS.identifierBytes),
    attemptId: boundedString(
      input.attemptId,
      "attemptId",
      TOOL_CALL_JOURNAL_LIMITS.identifierBytes,
    ),
    modelCallId: boundedString(
      input.modelCallId,
      "modelCallId",
      TOOL_CALL_JOURNAL_LIMITS.identifierBytes,
    ),
    providerToolCallId: boundedString(
      input.providerToolCallId,
      "providerToolCallId",
      TOOL_CALL_JOURNAL_LIMITS.identifierBytes,
    ),
  }
  const id = boundedString(input.id, "intent id", TOOL_CALL_JOURNAL_LIMITS.identifierBytes)
  const tool = boundedString(input.tool, "tool", TOOL_CALL_JOURNAL_LIMITS.toolNameBytes)
  const argumentsHash = digest(input.argumentsHash, "argumentsHash")
  const computedKey = createToolCallIdempotencyKey(identity, argumentsHash)
  if (
    input.idempotencyKey !== undefined &&
    digest(input.idempotencyKey, "idempotencyKey") !== computedKey
  ) {
    throw conflict(
      "RALPH_TOOL_CALL_IDEMPOTENCY_KEY_MISMATCH",
      "Provided tool-call idempotency key does not match the canonical identity",
      { computedKey },
    )
  }
  const risk = enumValue(TOOL_CALL_RISKS, input.risk, "tool-call risk")
  const effectClass = enumValue(
    TOOL_CALL_EFFECT_CLASSES,
    input.effectClass,
    "tool-call effect class",
  )
  const authorization = enumValue(
    TOOL_CALL_AUTHORIZATIONS,
    input.authorization,
    "tool-call authorization",
  )
  const recoveryStrategy =
    input.recoveryStrategy === undefined
      ? defaultRecoveryStrategy(effectClass)
      : enumValue(
          TOOL_CALL_RECOVERY_STRATEGIES,
          input.recoveryStrategy,
          "tool-call recovery strategy",
        )
  const requestedAt = timestamp(input.requestedAt ?? new Date().toISOString(), "requestedAt")

  return withLedger(path, (database) =>
    database.transaction(() => {
      const scope = requireScope(database, identity)
      const argumentsRedactedJson = redactedJson(database, input.arguments, "tool arguments")
      const preconditionRefs = redactedReferences(
        database,
        input.preconditionRefs,
        "preconditionRefs",
      )
      const normalized = {
        id,
        ...identity,
        tool,
        argumentsHash,
        idempotencyKey: computedKey,
        risk,
        effectClass,
        authorization,
        recoveryStrategy,
        preconditionRefsHash: preconditionRefs.hash,
        preconditionRefs: preconditionRefs.values,
      }
      const existing = findIntentByProviderIdentity(
        database,
        identity.modelCallId,
        identity.providerToolCallId,
      )
      if (existing) {
        assertExistingIntentMatches(existing, normalized)
        return { disposition: "existing" as const, intent: existing }
      }
      const reusedId = findIntentById(database, id)
      if (reusedId) {
        throw conflict(
          "RALPH_TOOL_CALL_INTENT_ID_CONFLICT",
          `Tool-call intent id is already bound to another provider call: ${id}`,
        )
      }
      const keyRow = database
        .query<{ id: string }, [string]>(
          "SELECT id FROM tool_call_intents WHERE idempotency_key = ?",
        )
        .get(computedKey)
      if (keyRow) {
        throw conflict(
          "RALPH_TOOL_CALL_IDEMPOTENCY_CONFLICT",
          "Canonical tool-call idempotency key is already bound to another intent",
          { intentId: keyRow.id, idempotencyKey: computedKey },
        )
      }

      database
        .query(
          `INSERT INTO tool_call_intents(
            id, schema_version, run_id, document_id, task_id, attempt_id, model_call_id,
            provider_tool_call_id, tool_name, arguments_hash, arguments_redacted_json,
            idempotency_key, risk, effect_class, authorization, recovery_strategy,
            precondition_refs_hash, precondition_refs_json, requested_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          identity.runId,
          identity.documentId,
          identity.taskId,
          identity.attemptId,
          identity.modelCallId,
          identity.providerToolCallId,
          tool,
          argumentsHash,
          argumentsRedactedJson,
          computedKey,
          risk,
          effectClass,
          authorization,
          recoveryStrategy,
          preconditionRefs.hash,
          preconditionRefs.json,
          requestedAt,
        )

      appendEventInTransaction(database, {
        type: "tool.call.requested",
        scope: "run",
        streamId: `run:${identity.runId}`,
        workspaceId: scope.workspace_id,
        runId: identity.runId,
        documentId: identity.documentId,
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        callId: identity.modelCallId,
        payload: {
          intentId: id,
          providerToolCallId: identity.providerToolCallId,
          tool,
          argumentsHash,
          idempotencyKey: computedKey,
          risk,
          effectClass,
          authorization,
          recoveryStrategy,
          preconditionRefsHash: preconditionRefs.hash,
          preconditionRefs: preconditionRefs.values,
        },
      })
      const intent = findIntentById(database, id)
      if (!intent) throw invalidLedger(`Tool-call intent was not persisted: ${id}`)
      return { disposition: "created" as const, intent }
    })(),
  )
}

function sameSettlement(
  existing: ToolCallSettlementRecord,
  expected: Omit<ToolCallSettlementRecord, "schemaVersion" | "id" | "settledAt">,
): boolean {
  return (
    existing.intentId === expected.intentId &&
    existing.outcome === expected.outcome &&
    existing.resultHash === expected.resultHash &&
    existing.effectRefsHash === expected.effectRefsHash &&
    existing.outputRefsHash === expected.outputRefsHash &&
    existing.errorCode === expected.errorCode
  )
}

export function settleToolCall(path: string, input: SettleToolCallInput): ToolCallSettlementRecord {
  const id = boundedString(input.id, "settlement id", TOOL_CALL_JOURNAL_LIMITS.identifierBytes)
  const intentId = boundedString(
    input.intentId,
    "intentId",
    TOOL_CALL_JOURNAL_LIMITS.identifierBytes,
  )
  const outcome = enumValue(
    TOOL_CALL_SETTLEMENT_OUTCOMES,
    input.outcome,
    "tool-call settlement outcome",
  )
  const resultHash = digest(input.resultHash, "resultHash")
  const settledAt = timestamp(input.settledAt ?? new Date().toISOString(), "settledAt")

  return withLedger(path, (database) =>
    database.transaction(() => {
      const intent = findIntentById(database, intentId)
      if (!intent) {
        throw invalidInput(
          "RALPH_TOOL_CALL_INTENT_NOT_FOUND",
          `Tool-call intent record not found: ${intentId}`,
        )
      }
      const resultRedactedJson = redactedJson(database, input.result, "tool result")
      const resultRedacted = parseStoredJson(resultRedactedJson, "redacted tool result")
      const effectRefs = redactedReferences(database, input.effectRefs, "effectRefs")
      const outputRefs = redactedReferences(database, input.outputRefs, "outputRefs")
      const errorCode =
        input.errorCode === undefined
          ? undefined
          : (redactValue(
              boundedString(input.errorCode, "errorCode", TOOL_CALL_JOURNAL_LIMITS.errorCodeBytes),
              persistenceSecretValues(database),
            ) as string)
      const expected = {
        intentId,
        outcome,
        resultHash,
        resultRedacted,
        effectRefsHash: effectRefs.hash,
        effectRefs: effectRefs.values,
        outputRefsHash: outputRefs.hash,
        outputRefs: outputRefs.values,
        ...(errorCode === undefined ? {} : { errorCode }),
      }
      const existing = findSettlementByIntent(database, intentId)
      if (existing) {
        if (!sameSettlement(existing, expected)) {
          throw conflict(
            "RALPH_TOOL_CALL_SETTLEMENT_CONFLICT",
            `Tool-call intent ${intentId} already has a different settlement`,
            {
              settlementId: existing.id,
              persistedOutcome: existing.outcome,
              receivedOutcome: outcome,
              persistedResultHash: existing.resultHash,
              receivedResultHash: resultHash,
            },
          )
        }
        return existing
      }
      const reusedId = database
        .query<{ intent_id: string }, [string]>(
          "SELECT intent_id FROM tool_call_settlements WHERE id = ?",
        )
        .get(id)
      if (reusedId) {
        throw conflict(
          "RALPH_TOOL_CALL_SETTLEMENT_ID_CONFLICT",
          `Tool-call settlement id is already bound to another intent: ${id}`,
          { persistedIntentId: reusedId.intent_id },
        )
      }

      database
        .query(
          `INSERT INTO tool_call_settlements(
            id, schema_version, intent_id, outcome, result_hash, result_redacted_json,
            effect_refs_hash, effect_refs_json, output_refs_hash, output_refs_json,
            error_code, settled_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          intentId,
          outcome,
          resultHash,
          resultRedactedJson,
          effectRefs.hash,
          effectRefs.json,
          outputRefs.hash,
          outputRefs.json,
          errorCode ?? null,
          settledAt,
        )

      appendEventInTransaction(database, {
        type: "tool.call.settled",
        scope: "run",
        streamId: `run:${intent.runId}`,
        workspaceId: requireScope(database, intent).workspace_id,
        runId: intent.runId,
        documentId: intent.documentId,
        taskId: intent.taskId,
        attemptId: intent.attemptId,
        callId: intent.modelCallId,
        level: outcome === "succeeded" ? "info" : outcome === "denied" ? "warn" : "error",
        payload: {
          intentId,
          settlementId: id,
          providerToolCallId: intent.providerToolCallId,
          tool: intent.tool,
          outcome,
          resultHash,
          effectRefsHash: effectRefs.hash,
          effectRefs: effectRefs.values,
          outputRefsHash: outputRefs.hash,
          outputRefs: outputRefs.values,
          ...(errorCode === undefined ? {} : { errorCode }),
        },
      })
      const settlement = findSettlementByIntent(database, intentId)
      if (!settlement) throw invalidLedger(`Tool-call settlement was not persisted: ${id}`)
      return settlement
    })(),
  )
}

export function getToolCallIntent(
  path: string,
  intentId: string,
): ToolCallIntentRecord | undefined {
  return withLedger(path, (database) => findIntentById(database, intentId))
}

export function getToolCallIntentByProviderIdentity(
  path: string,
  modelCallId: string,
  providerToolCallId: string,
): ToolCallIntentRecord | undefined {
  return withLedger(path, (database) =>
    findIntentByProviderIdentity(database, modelCallId, providerToolCallId),
  )
}

export function getToolCallSettlement(
  path: string,
  intentId: string,
): ToolCallSettlementRecord | undefined {
  return withLedger(path, (database) => findSettlementByIntent(database, intentId))
}

function recoveryClassification(
  strategy: ToolCallRecoveryStrategy,
): ToolCallRecoveryClassification {
  switch (strategy) {
    case "safe-to-retry":
      return {
        strategy,
        automaticReplayAllowed: true,
        requiresReconciliation: false,
        reason: "The recorded operation is read-only and can be replayed after restart.",
      }
    case "verify-preconditions":
      return {
        strategy,
        automaticReplayAllowed: false,
        requiresReconciliation: true,
        reason:
          "Inspect pre/post hashes before deciding whether a workspace mutation may run again.",
      }
    case "inspect-process":
      return {
        strategy,
        automaticReplayAllowed: false,
        requiresReconciliation: true,
        reason: "Inspect the persisted process identity and outputs before restarting the command.",
      }
    case "manual-reconciliation":
      return {
        strategy,
        automaticReplayAllowed: false,
        requiresReconciliation: true,
        reason:
          "The operation may have produced a remote or external effect and must not be replayed blindly.",
      }
    case "never-retry":
      return {
        strategy,
        automaticReplayAllowed: false,
        requiresReconciliation: true,
        reason: "The destructive operation is never replayed automatically.",
      }
  }
}

export function listUnsettledToolCalls(
  path: string,
  query: UnsettledToolCallQuery = {},
): UnsettledToolCallRecord[] {
  return withLedger(path, (database) => {
    const rows = database
      .query<
        IntentRow,
        [string, string, string, string, string, string, string, string, string, string]
      >(
        `SELECT ${INTENT_COLUMNS.split(",")
          .map((column) => `intent.${column.trim()}`)
          .join(", ")}
         FROM tool_call_intents AS intent
         LEFT JOIN tool_call_settlements AS settlement ON settlement.intent_id = intent.id
         WHERE settlement.intent_id IS NULL
           AND (? = '' OR intent.run_id = ?)
           AND (? = '' OR intent.document_id = ?)
           AND (? = '' OR intent.task_id = ?)
           AND (? = '' OR intent.attempt_id = ?)
           AND (? = '' OR intent.model_call_id = ?)
         ORDER BY intent.requested_at, intent.id`,
      )
      .all(
        query.runId ?? "",
        query.runId ?? "",
        query.documentId ?? "",
        query.documentId ?? "",
        query.taskId ?? "",
        query.taskId ?? "",
        query.attemptId ?? "",
        query.attemptId ?? "",
        query.modelCallId ?? "",
        query.modelCallId ?? "",
      )
    return rows.map((row) => {
      const intent = intentFromRow(row)
      return { intent, recovery: recoveryClassification(intent.recoveryStrategy) }
    })
  })
}

export function listToolCalls(
  path: string,
  query: UnsettledToolCallQuery = {},
): ToolCallJournalRecord[] {
  return withLedger(path, (database) => {
    const rows = database
      .query<
        IntentRow,
        [string, string, string, string, string, string, string, string, string, string]
      >(
        `SELECT ${INTENT_COLUMNS}
         FROM tool_call_intents AS intent
         WHERE (? = '' OR intent.run_id = ?)
           AND (? = '' OR intent.document_id = ?)
           AND (? = '' OR intent.task_id = ?)
           AND (? = '' OR intent.attempt_id = ?)
           AND (? = '' OR intent.model_call_id = ?)
         ORDER BY intent.requested_at, intent.id`,
      )
      .all(
        query.runId ?? "",
        query.runId ?? "",
        query.documentId ?? "",
        query.documentId ?? "",
        query.taskId ?? "",
        query.taskId ?? "",
        query.attemptId ?? "",
        query.attemptId ?? "",
        query.modelCallId ?? "",
        query.modelCallId ?? "",
      )
    return rows.map((row) => {
      const intent = intentFromRow(row)
      const settlement = findSettlementByIntent(database, intent.id)
      return { intent, ...(settlement ? { settlement } : {}) }
    })
  })
}

export function createSqliteToolCallJournal(path: string): ToolCallJournal {
  return {
    recordIntent: (input) => recordToolCallIntent(path, input),
    settle: (input) => settleToolCall(path, input),
    getIntent: (intentId) => getToolCallIntent(path, intentId),
    getByProviderIdentity: (modelCallId, providerToolCallId) =>
      getToolCallIntentByProviderIdentity(path, modelCallId, providerToolCallId),
    getSettlement: (intentId) => getToolCallSettlement(path, intentId),
    list: (query) => listToolCalls(path, query),
    listUnsettled: (query) => listUnsettledToolCalls(path, query),
  }
}
