import type {
  ToolCallRecoveryStrategy as PersistenceRecoveryStrategy,
  ToolCallSettlementOutcome as PersistenceSettlementOutcome,
  ToolCallIntentRecord,
  ToolCallJournal,
  ToolCallSettlementRecord,
} from "@ralph/persistence"
import { hashToolCallPayload } from "@ralph/persistence"
import { redactValue } from "@ralph/telemetry"
import {
  type ReserveToolCallInput,
  type ReserveToolCallResult,
  type ToolAuthorization,
  type ToolCallRecord,
  ToolCallRecordSchema,
  ToolHostError,
  type ToolJournal,
  type ToolRecoveryClassification,
  type ToolSettlement,
  ToolSettlementSchema,
} from "@ralph/tool-host"

export type DurableToolJournalScope = {
  runId: string
  documentId: string
  taskId: string
  attemptId: string
}

export type DurableToolJournalOptions = {
  journal: ToolCallJournal
  scope: DurableToolJournalScope
  /**
   * Durable attempt counter supplied by command-owned orchestration. The v6
   * journal intentionally exposes unsettled intents, not an aggregate count,
   * so the adapter must not guess how many settled calls preceded a restart.
   */
  initialToolCallsUsed: number
  secretValues?: readonly string[]
  /**
   * Captures bounded, non-secret pre/post hash bindings before a write can
   * start. Existing intents always retain their original immutable refs.
   */
  preconditionRefs?: (record: ToolCallRecord) => Promise<readonly string[]>
}

type LiveRecord = ToolCallRecord

function adapterError(code: string, message: string): ToolHostError {
  return new ToolHostError(code, message, "error", "manual-review", false)
}

function persistenceEffectClass(
  risk: ToolCallRecord["risk"],
): "read-only" | "workspace-write" | "process" | "network" | "external-effect" | "destructive" {
  switch (risk) {
    case "read":
      return "read-only"
    case "write":
      return "workspace-write"
    case "process":
    case "network":
    case "external-effect":
    case "destructive":
      return risk
  }
}

function persistenceRecovery(
  risk: ToolCallRecord["risk"],
  recovery: ToolRecoveryClassification,
): PersistenceRecoveryStrategy {
  switch (recovery) {
    case "safe-to-retry":
    case "effect-absent":
      return "safe-to-retry"
    case "reconcile-by-precondition":
      return "verify-preconditions"
    case "effect-confirmed":
      return risk === "write" ? "verify-preconditions" : "manual-reconciliation"
    case "unknown-external-effect":
      return risk === "process" ? "inspect-process" : "manual-reconciliation"
    case "manual-review":
      return risk === "destructive" ? "never-retry" : "manual-reconciliation"
  }
}

function hostRecovery(strategy: PersistenceRecoveryStrategy): ToolRecoveryClassification {
  switch (strategy) {
    case "safe-to-retry":
      return "safe-to-retry"
    case "verify-preconditions":
      return "reconcile-by-precondition"
    case "inspect-process":
    case "manual-reconciliation":
      return "unknown-external-effect"
    case "never-retry":
      return "manual-review"
  }
}

function persistenceOutcome(outcome: ToolSettlement["outcome"]): PersistenceSettlementOutcome {
  switch (outcome) {
    case "success":
      return "succeeded"
    case "nonzero":
      return "nonzero"
    case "denied":
      return "denied"
    case "invalid":
    case "error":
      return "failed"
    case "timeout":
      return "timeout"
    case "cancelled":
      return "cancelled"
    case "unsettled":
      return "needs-reconciliation"
  }
}

function settlementErrorCode(settlement: ToolSettlement): string | undefined {
  if (settlement.outcome === "success") return undefined
  return `RALPH_TOOL_${settlement.outcome.toUpperCase().replaceAll("-", "_")}`
}

function durableOutcomeMatches(
  outcome: ToolSettlement["outcome"],
  persisted: PersistenceSettlementOutcome,
): boolean {
  return (
    persistenceOutcome(outcome) === persisted ||
    (outcome === "cancelled" && persisted === "interrupted")
  )
}

function copyRecord(record: ToolCallRecord): ToolCallRecord {
  return ToolCallRecordSchema.parse(record)
}

function durableSettlement(
  intent: ToolCallIntentRecord,
  record: ToolCallSettlementRecord,
): ToolSettlement {
  const parsed = ToolSettlementSchema.safeParse(record.resultRedacted)
  if (!parsed.success) {
    throw adapterError(
      "RALPH_TOOL_DURABLE_SETTLEMENT_INVALID",
      `Durable settlement for tool call ${intent.id} cannot be projected safely`,
    )
  }
  if (
    parsed.data.toolCallId !== intent.id ||
    !durableOutcomeMatches(parsed.data.outcome, record.outcome)
  ) {
    throw adapterError(
      "RALPH_TOOL_DURABLE_SETTLEMENT_DRIFT",
      `Durable settlement for tool call ${intent.id} conflicts with its immutable intent`,
    )
  }
  return ToolSettlementSchema.parse({
    ...parsed.data,
    outputRefs: record.outputRefs,
    settledAt: record.settledAt,
  })
}

function baseRecord(intent: ToolCallIntentRecord): ToolCallRecord {
  return ToolCallRecordSchema.parse({
    schemaVersion: 1,
    id: intent.id,
    attemptId: intent.attemptId,
    modelCallId: intent.modelCallId,
    providerToolCallId: intent.providerToolCallId,
    tool: intent.tool,
    argumentsHash: intent.argumentsHash,
    argumentsRedacted: intent.argumentsRedacted,
    idempotencyKey: intent.idempotencyKey,
    risk: intent.risk,
    status: "unsettled",
    effects: [],
    recovery: hostRecovery(intent.recoveryStrategy),
    requestedAt: intent.requestedAt,
    updatedAt: intent.requestedAt,
  })
}

/**
 * Adapts the immutable SQLite v6 intent/settlement journal to the mutable
 * ToolJournal projection expected by ToolHost.
 *
 * `authorize`, `start`, and explicit `markUnsettled` are live projections. An
 * intent is already durable before any of those transitions can lead to an
 * effect. After restart, an intent without a settlement is always projected as
 * `unsettled`; duplicate reserve returns it and ToolHost refuses blind replay.
 */
export class DurableToolJournal implements ToolJournal {
  readonly #journal: ToolCallJournal
  readonly #scope: DurableToolJournalScope
  readonly #secretValues: readonly string[]
  readonly #preconditionRefs: ((record: ToolCallRecord) => Promise<readonly string[]>) | undefined
  readonly #live = new Map<string, LiveRecord>()
  #toolCallsUsed: number

  constructor(options: DurableToolJournalOptions) {
    if (!Number.isSafeInteger(options.initialToolCallsUsed) || options.initialToolCallsUsed < 0) {
      throw adapterError(
        "RALPH_TOOL_COUNTER_INVALID",
        "initialToolCallsUsed must be a non-negative safe integer",
      )
    }
    this.#journal = options.journal
    this.#scope = { ...options.scope }
    this.#secretValues = [...(options.secretValues ?? [])]
    this.#preconditionRefs = options.preconditionRefs
    const durableUnsettled = this.#journal.listUnsettled({
      attemptId: this.#scope.attemptId,
    }).length
    this.#toolCallsUsed = Math.max(options.initialToolCallsUsed, durableUnsettled)
  }

  async reserve(input: ReserveToolCallInput): Promise<ReserveToolCallResult> {
    const candidate = copyRecord(input.record)
    this.#assertScope(candidate)
    const existing = this.#journal.getByProviderIdentity(
      candidate.modelCallId,
      candidate.providerToolCallId,
    )
    if (!existing && this.#toolCallsUsed >= Math.max(0, Math.trunc(input.maximumToolCalls))) {
      return { status: "budget-exhausted" }
    }

    const preconditionRefs = existing
      ? existing.preconditionRefs
      : ((await this.#preconditionRefs?.(candidate)) ?? [])
    const resolution = this.#journal.recordIntent({
      id: candidate.id,
      ...this.#scope,
      modelCallId: candidate.modelCallId,
      providerToolCallId: candidate.providerToolCallId,
      tool: candidate.tool,
      argumentsHash: candidate.argumentsHash,
      arguments: redactValue(candidate.argumentsRedacted, this.#secretValues),
      risk: candidate.risk,
      effectClass: persistenceEffectClass(candidate.risk),
      // Persistence v6 has no `pending` value. `asked` is the conservative
      // immutable reservation marker; the effective decision remains live.
      authorization: "asked",
      recoveryStrategy: persistenceRecovery(candidate.risk, candidate.recovery),
      preconditionRefs,
      requestedAt: candidate.requestedAt,
    })
    const settlementRecord = this.#journal.getSettlement(resolution.intent.id)

    if (resolution.disposition === "existing") {
      const record = this.#project(resolution.intent, settlementRecord)
      return {
        status: "duplicate",
        record,
        ...(record.settlement ? { settlement: record.settlement } : {}),
      }
    }

    this.#toolCallsUsed += 1
    const live = ToolCallRecordSchema.parse({
      ...candidate,
      id: resolution.intent.id,
      argumentsRedacted: resolution.intent.argumentsRedacted,
      idempotencyKey: resolution.intent.idempotencyKey,
      requestedAt: resolution.intent.requestedAt,
      updatedAt: resolution.intent.requestedAt,
    })
    this.#live.set(live.id, live)
    return { status: "reserved", record: copyRecord(live) }
  }

  async authorize(id: string, authorization: ToolAuthorization): Promise<ToolCallRecord> {
    const current = this.#require(id)
    if (current.status !== "requested") {
      throw adapterError(
        "RALPH_TOOL_JOURNAL_TRANSITION",
        "Only a live requested call may be authorized",
      )
    }
    const next = ToolCallRecordSchema.parse({
      ...current,
      authorization,
      status: "authorized",
      updatedAt: authorization.decidedAt,
    })
    this.#live.set(id, next)
    return copyRecord(next)
  }

  async start(id: string, startedAt: string): Promise<ToolCallRecord> {
    const current = this.#require(id)
    if (current.status !== "authorized" || current.authorization?.action !== "allow") {
      throw adapterError(
        "RALPH_TOOL_JOURNAL_TRANSITION",
        "Only a live allowed call may start effects",
      )
    }
    const next = ToolCallRecordSchema.parse({
      ...current,
      status: "started",
      startedAt,
      updatedAt: startedAt,
    })
    this.#live.set(id, next)
    return copyRecord(next)
  }

  async settle(id: string, settlementInput: ToolSettlement): Promise<ToolCallRecord> {
    const current = this.#require(id)
    if (
      current.status !== "authorized" &&
      current.status !== "started" &&
      current.status !== "unsettled"
    ) {
      throw adapterError(
        "RALPH_TOOL_JOURNAL_TRANSITION",
        "Only authorized, started, or reconciled-unsettled calls may settle",
      )
    }
    const settlement = ToolSettlementSchema.parse(settlementInput)
    if (settlement.toolCallId !== id) {
      throw adapterError(
        "RALPH_TOOL_SETTLEMENT_ID_MISMATCH",
        "Settlement targets another tool call",
      )
    }
    const durableResult = redactValue(
      {
        ...settlement,
        content: settlement.content ?? null,
      },
      this.#secretValues,
    )
    const errorCode = settlementErrorCode(settlement)
    const persisted = this.#journal.settle({
      id: `tool-settlement-${hashToolCallPayload({ intentId: id })}`,
      intentId: id,
      outcome: persistenceOutcome(settlement.outcome),
      resultHash: hashToolCallPayload(durableResult),
      result: durableResult,
      effectRefs: settlement.effects.map(
        (effect, index) => `effect:${index}:${hashToolCallPayload(effect)}`,
      ),
      outputRefs: settlement.outputRefs,
      ...(errorCode === undefined ? {} : { errorCode }),
      settledAt: settlement.settledAt,
    })
    const projectedSettlement = durableSettlement(this.#requireIntent(id), persisted)
    const next = ToolCallRecordSchema.parse({
      ...current,
      status: "settled",
      effects: projectedSettlement.effects,
      settlement: projectedSettlement,
      recovery: projectedSettlement.recovery,
      settledAt: projectedSettlement.settledAt,
      updatedAt: projectedSettlement.settledAt,
    })
    this.#live.set(id, next)
    return copyRecord(next)
  }

  async markUnsettled(
    id: string,
    recovery: ToolRecoveryClassification,
    updatedAt: string,
  ): Promise<ToolCallRecord> {
    const current = this.#require(id)
    if (current.status !== "started") {
      throw adapterError(
        "RALPH_TOOL_JOURNAL_TRANSITION",
        "Only a started call may be marked unsettled",
      )
    }
    const next = ToolCallRecordSchema.parse({
      ...current,
      status: "unsettled",
      recovery,
      updatedAt,
    })
    this.#live.set(id, next)
    return copyRecord(next)
  }

  async get(id: string): Promise<ToolCallRecord | undefined> {
    const intent = this.#journal.getIntent(id)
    if (!intent || intent.attemptId !== this.#scope.attemptId) return undefined
    return this.#project(intent, this.#journal.getSettlement(id))
  }

  async listUnsettled(attemptId: string): Promise<readonly ToolCallRecord[]> {
    if (attemptId !== this.#scope.attemptId) return []
    return this.#journal
      .listUnsettled({ attemptId })
      .map(({ intent }) => this.#project(intent, undefined, true))
  }

  #assertScope(record: ToolCallRecord): void {
    if (record.attemptId !== this.#scope.attemptId) {
      throw adapterError(
        "RALPH_TOOL_CALL_SCOPE_MISMATCH",
        `Tool call ${record.id} does not belong to adapter attempt ${this.#scope.attemptId}`,
      )
    }
  }

  #requireIntent(id: string): ToolCallIntentRecord {
    const intent = this.#journal.getIntent(id)
    if (!intent || intent.attemptId !== this.#scope.attemptId) {
      throw adapterError("RALPH_TOOL_CALL_NOT_FOUND", `Tool call not found: ${id}`)
    }
    return intent
  }

  #require(id: string): ToolCallRecord {
    const intent = this.#requireIntent(id)
    return this.#project(intent, this.#journal.getSettlement(id))
  }

  #project(
    intent: ToolCallIntentRecord,
    settlementRecord: ToolCallSettlementRecord | undefined,
    forceUnsettled = false,
  ): ToolCallRecord {
    if (settlementRecord) {
      const settlement = durableSettlement(intent, settlementRecord)
      return ToolCallRecordSchema.parse({
        ...baseRecord(intent),
        status: "settled",
        effects: settlement.effects,
        settlement,
        recovery: settlement.recovery,
        settledAt: settlement.settledAt,
        updatedAt: settlement.settledAt,
      })
    }
    if (!forceUnsettled) {
      const live = this.#live.get(intent.id)
      if (live) return copyRecord(live)
    }
    return baseRecord(intent)
  }
}

export function createDurableToolJournal(options: DurableToolJournalOptions): ToolJournal {
  return new DurableToolJournal(options)
}
