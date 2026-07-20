import {
  type ReserveToolCallInput,
  type ReserveToolCallResult,
  type ToolAuthorization,
  type ToolCallRecord,
  ToolCallRecordSchema,
  type ToolJournal,
  type ToolRecoveryClassification,
  type ToolSettlement,
} from "./contracts"
import { ToolHostError } from "./errors"

function copyRecord(record: ToolCallRecord): ToolCallRecord {
  return ToolCallRecordSchema.parse(record)
}

function providerKey(record: Pick<ToolCallRecord, "modelCallId" | "providerToolCallId">): string {
  return `${record.modelCallId}\0${record.providerToolCallId}`
}

/**
 * Deterministic journal used by package tests and embedders without SQLite.
 * Production composition should implement the same port transactionally.
 */
export class InMemoryToolJournal implements ToolJournal {
  readonly #records = new Map<string, ToolCallRecord>()
  readonly #providerKeys = new Map<string, string>()

  async reserve(input: ReserveToolCallInput): Promise<ReserveToolCallResult> {
    const candidate = copyRecord(input.record)
    const existingId = this.#providerKeys.get(providerKey(candidate))
    if (existingId) {
      const existing = this.#records.get(existingId)
      if (!existing) throw new Error("Tool journal provider index is corrupt")
      if (
        existing.argumentsHash !== candidate.argumentsHash ||
        existing.idempotencyKey !== candidate.idempotencyKey ||
        existing.tool !== candidate.tool
      ) {
        throw new ToolHostError(
          "RALPH_TOOL_CALL_ID_REUSED",
          "Provider tool call ID was reused with different arguments",
          "invalid",
        )
      }
      return {
        status: "duplicate",
        record: copyRecord(existing),
        ...(existing.settlement ? { settlement: existing.settlement } : {}),
      }
    }
    const used = [...this.#records.values()].filter(
      (record) => record.attemptId === candidate.attemptId,
    ).length
    if (used >= input.maximumToolCalls) return { status: "budget-exhausted" }
    if (this.#records.has(candidate.id)) {
      throw new ToolHostError(
        "RALPH_TOOL_CALL_ID_DUPLICATE",
        "Tool call ID already exists",
        "invalid",
      )
    }
    this.#records.set(candidate.id, candidate)
    this.#providerKeys.set(providerKey(candidate), candidate.id)
    return { status: "reserved", record: copyRecord(candidate) }
  }

  async authorize(id: string, authorization: ToolAuthorization): Promise<ToolCallRecord> {
    const current = this.#require(id)
    if (current.status !== "requested") {
      throw new ToolHostError(
        "RALPH_TOOL_JOURNAL_TRANSITION",
        "Only requested calls may be authorized",
      )
    }
    return this.#store({
      ...current,
      authorization,
      status: "authorized",
      updatedAt: authorization.decidedAt,
    })
  }

  async start(id: string, startedAt: string): Promise<ToolCallRecord> {
    const current = this.#require(id)
    if (current.status !== "authorized" || current.authorization?.action !== "allow") {
      throw new ToolHostError(
        "RALPH_TOOL_JOURNAL_TRANSITION",
        "Only allowed calls may start effects",
      )
    }
    return this.#store({ ...current, status: "started", startedAt, updatedAt: startedAt })
  }

  async settle(id: string, settlement: ToolSettlement): Promise<ToolCallRecord> {
    const current = this.#require(id)
    if (
      current.status !== "authorized" &&
      current.status !== "started" &&
      current.status !== "unsettled"
    ) {
      throw new ToolHostError(
        "RALPH_TOOL_JOURNAL_TRANSITION",
        "Only authorized, started, or unsettled calls may settle",
      )
    }
    if (settlement.toolCallId !== id) {
      throw new ToolHostError(
        "RALPH_TOOL_SETTLEMENT_ID_MISMATCH",
        "Settlement targets another call",
      )
    }
    return this.#store({
      ...current,
      status: "settled",
      effects: settlement.effects,
      settlement,
      recovery: settlement.recovery,
      settledAt: settlement.settledAt,
      updatedAt: settlement.settledAt,
    })
  }

  async markUnsettled(
    id: string,
    recovery: ToolRecoveryClassification,
    updatedAt: string,
  ): Promise<ToolCallRecord> {
    const current = this.#require(id)
    if (current.status !== "started") {
      throw new ToolHostError(
        "RALPH_TOOL_JOURNAL_TRANSITION",
        "Only a started call may be unsettled",
      )
    }
    return this.#store({ ...current, status: "unsettled", recovery, updatedAt })
  }

  async get(id: string): Promise<ToolCallRecord | undefined> {
    const record = this.#records.get(id)
    return record ? copyRecord(record) : undefined
  }

  async listUnsettled(attemptId: string): Promise<readonly ToolCallRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.attemptId === attemptId && record.status === "unsettled")
      .map(copyRecord)
  }

  records(): readonly ToolCallRecord[] {
    return [...this.#records.values()].map(copyRecord)
  }

  #require(id: string): ToolCallRecord {
    const record = this.#records.get(id)
    if (!record) throw new ToolHostError("RALPH_TOOL_CALL_NOT_FOUND", `Tool call not found: ${id}`)
    return record
  }

  #store(record: ToolCallRecord): ToolCallRecord {
    const parsed = copyRecord(record)
    this.#records.set(parsed.id, parsed)
    return copyRecord(parsed)
  }
}
