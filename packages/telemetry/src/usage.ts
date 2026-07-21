import {
  type ModelAccess,
  type PriceSnapshot,
  PriceSnapshotSchema,
  type TokenUsage,
  TokenUsageSchema,
  type UsageMetric,
  type UsageSource,
} from "@ralph/providers"
import type { EventEnvelope } from "./events"

export type UsageRole = "executor" | "judge" | "child" | "tool-model"

export type UsageScope = {
  readonly runId: string
  readonly documentId?: string
  readonly taskId?: string
  readonly attemptId?: string
  readonly parentRunId?: string
  readonly childRunId?: string
}

export type UsageUpdate = {
  readonly callId: string
  readonly role: UsageRole
  readonly scope: UsageScope
  readonly usage: TokenUsage
}

const TOKEN_FIELDS = [
  "input",
  "inputNonCached",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
  "total",
] as const
type TokenField = (typeof TOKEN_FIELDS)[number]
type CostSource = Exclude<UsageSource, "unavailable">

export type UsageFieldCoverage = Readonly<Record<TokenField, number>>

export type NormalizedCallUsage = {
  readonly callId: string
  readonly role: UsageRole
  readonly scope: UsageScope
  readonly source: UsageSource
  readonly availability: "available" | "partial" | "unavailable"
  readonly semantics: "final"
  readonly settled: boolean
  readonly updates: number
  readonly input?: number
  readonly inputNonCached?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly output?: number
  readonly reasoning?: number
  readonly total?: number
  readonly cost?: {
    readonly amount: number
    readonly currency: string
    readonly source: CostSource
    readonly priceSnapshotIds: readonly string[]
  }
  readonly providerRawRefs: readonly string[]
}

export type UsageAggregate = {
  readonly semantics: "final"
  readonly source: UsageSource
  readonly availability: "complete" | "partial" | "unavailable"
  readonly callCount: number
  readonly unavailableCalls: number
  readonly partialCalls: number
  readonly reportedCalls: number
  readonly derivedCalls: number
  readonly estimatedCalls: number
  readonly settledCalls: number
  readonly fieldCoverage: UsageFieldCoverage
  readonly input?: number
  readonly inputNonCached?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly output?: number
  readonly reasoning?: number
  readonly total?: number
  readonly cost?: {
    readonly amount: number
    readonly currency: string
    readonly source: CostSource
    readonly priceSnapshotIds: readonly string[]
    readonly coverage: number
  }
  readonly costCurrencies: readonly string[]
  readonly providerRawRefs: readonly string[]
  readonly issues: readonly string[]
}

export type UsageBreakdown = {
  readonly runId: string
  readonly total: UsageAggregate
  readonly roles: Readonly<Partial<Record<UsageRole, UsageAggregate>>>
  readonly attempts: Readonly<Record<string, UsageAggregate>>
  readonly tasks: Readonly<Record<string, UsageAggregate>>
  readonly children: Readonly<Record<string, UsageAggregate>>
  readonly calls: Readonly<Record<string, NormalizedCallUsage>>
}

type MutableCall = {
  callId: string
  role: UsageRole
  scope: UsageScope
  values: Partial<Record<TokenField, number>>
  source: UsageSource
  unavailable: boolean
  settled: boolean
  updates: number
  cost?: { amount: number; currency: string; source: CostSource }
  priceSnapshotIds: Set<string>
  providerRawRefs: Set<string>
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Usage counter overflow at ${label}`)
  }
  return result
}

function sourceRank(source: UsageSource): number {
  if (source === "reported") return 0
  if (source === "derived") return 1
  if (source === "estimated") return 2
  return 3
}

function measuredSource(left: UsageSource, right: UsageSource): UsageSource {
  if (left === "unavailable") return right
  if (right === "unavailable") return left
  return sourceRank(left) >= sourceRank(right) ? left : right
}

function scopeEqual(left: UsageScope, right: UsageScope): boolean {
  return (
    left.runId === right.runId &&
    left.documentId === right.documentId &&
    left.taskId === right.taskId &&
    left.attemptId === right.attemptId &&
    left.parentRunId === right.parentRunId &&
    left.childRunId === right.childRunId
  )
}

function callBindingKey(input: {
  readonly callId: string
  readonly role: UsageRole
  readonly scope: UsageScope
}): string {
  return JSON.stringify([
    input.scope.runId,
    input.scope.childRunId ?? null,
    input.role,
    input.scope.attemptId ?? null,
    input.callId,
  ])
}

function stateHasMeasuredValue(state: MutableCall): boolean {
  return Object.keys(state.values).length > 0 || state.cost !== undefined
}

function cloneCall(state: MutableCall): MutableCall {
  return {
    ...state,
    values: { ...state.values },
    ...(state.cost ? { cost: { ...state.cost } } : {}),
    priceSnapshotIds: new Set(state.priceSnapshotIds),
    providerRawRefs: new Set(state.providerRawRefs),
  }
}

function emptyCoverage(): Record<TokenField, number> {
  return {
    input: 0,
    inputNonCached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  }
}

function finalCall(state: MutableCall): NormalizedCallUsage {
  const measured = stateHasMeasuredValue(state)
  return {
    callId: state.callId,
    role: state.role,
    scope: state.scope,
    source: state.unavailable && !measured ? "unavailable" : state.source,
    availability: state.unavailable
      ? measured
        ? "partial"
        : "unavailable"
      : state.settled
        ? "available"
        : "partial",
    semantics: "final",
    settled: state.settled,
    updates: state.updates,
    ...state.values,
    ...(state.cost
      ? {
          cost: {
            ...state.cost,
            priceSnapshotIds: [...state.priceSnapshotIds].sort(),
          },
        }
      : {}),
    providerRawRefs: [...state.providerRawRefs].sort(),
  }
}

function aggregateCalls(calls: readonly NormalizedCallUsage[]): UsageAggregate {
  const values: Partial<Record<TokenField, number>> = {}
  const fieldCoverage = emptyCoverage()
  const providerRawRefs = new Set<string>()
  const priceSnapshotIds = new Set<string>()
  const costCurrencies = new Set<string>()
  const costSources = new Set<CostSource>()
  const issues: string[] = []
  let unavailableCalls = 0
  let partialCalls = 0
  let reportedCalls = 0
  let derivedCalls = 0
  let estimatedCalls = 0
  let settledCalls = 0
  let aggregateSource: UsageSource = "unavailable"
  let costAmount = 0
  let costCoverage = 0

  for (const call of calls) {
    if (call.availability === "unavailable") unavailableCalls += 1
    else if (call.availability === "partial") {
      partialCalls += 1
      aggregateSource = measuredSource(aggregateSource, call.source)
      if (call.source === "reported") reportedCalls += 1
      else if (call.source === "derived") derivedCalls += 1
      else if (call.source === "estimated") estimatedCalls += 1
    } else {
      aggregateSource = measuredSource(aggregateSource, call.source)
      if (call.source === "reported") reportedCalls += 1
      else if (call.source === "derived") derivedCalls += 1
      else if (call.source === "estimated") estimatedCalls += 1
    }
    if (call.settled) settledCalls += 1
    for (const field of TOKEN_FIELDS) {
      const value = call[field]
      if (value === undefined) continue
      values[field] = safeAdd(values[field] ?? 0, value, `aggregate.${field}`)
      fieldCoverage[field] += 1
    }
    if (call.cost) {
      costAmount += call.cost.amount
      if (!Number.isFinite(costAmount) || costAmount < 0) throw new Error("Usage cost overflow")
      costCoverage += 1
      costCurrencies.add(call.cost.currency)
      costSources.add(call.cost.source)
      for (const id of call.cost.priceSnapshotIds) priceSnapshotIds.add(id)
    }
    for (const reference of call.providerRawRefs) providerRawRefs.add(reference)
  }

  if (costCurrencies.size > 1) {
    issues.push("cost currencies are not comparable; no combined cost was produced")
  }
  const availability =
    calls.length === 0 || unavailableCalls === calls.length
      ? "unavailable"
      : unavailableCalls > 0 || partialCalls > 0
        ? "partial"
        : "complete"
  return {
    semantics: "final",
    source: availability === "unavailable" ? "unavailable" : aggregateSource,
    availability,
    callCount: calls.length,
    unavailableCalls,
    partialCalls,
    reportedCalls,
    derivedCalls,
    estimatedCalls,
    settledCalls,
    fieldCoverage,
    ...values,
    ...(costCoverage > 0 && costCurrencies.size === 1
      ? {
          cost: {
            amount: costAmount,
            currency: [...costCurrencies][0] as string,
            source: costSources.size === 1 ? ([...costSources][0] as CostSource) : "estimated",
            priceSnapshotIds: [...priceSnapshotIds].sort(),
            coverage: costCoverage,
          },
        }
      : {}),
    costCurrencies: [...costCurrencies].sort(),
    providerRawRefs: [...providerRawRefs].sort(),
    issues,
  }
}

function groupAggregate(
  calls: readonly NormalizedCallUsage[],
  key: (call: NormalizedCallUsage) => string | undefined,
): Record<string, UsageAggregate> {
  const groups = new Map<string, NormalizedCallUsage[]>()
  for (const call of calls) {
    const value = key(call)
    if (value === undefined) continue
    const group = groups.get(value) ?? []
    group.push(call)
    groups.set(value, group)
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([groupKey, group]) => [groupKey, aggregateCalls(group)]),
  )
}

export class TokenUsageAggregator {
  readonly #runId: string
  readonly #calls = new Map<string, MutableCall>()

  constructor(runId: string) {
    if (runId.length === 0) throw new Error("Usage runId cannot be empty")
    this.#runId = runId
  }

  registerCall(input: {
    readonly callId: string
    readonly role: UsageRole
    readonly scope: UsageScope
  }): void {
    if (input.scope.runId !== this.#runId) throw new Error("Usage call belongs to another run")
    const key = callBindingKey(input)
    const existing = this.#calls.get(key)
    if (existing) {
      if (existing.role !== input.role || !scopeEqual(existing.scope, input.scope)) {
        throw new Error(`Usage call binding changed: ${input.callId}`)
      }
      return
    }
    this.#calls.set(key, {
      callId: input.callId,
      role: input.role,
      scope: input.scope,
      values: {},
      source: "unavailable",
      unavailable: true,
      settled: false,
      updates: 0,
      priceSnapshotIds: new Set(),
      providerRawRefs: new Set(),
    })
  }

  /**
   * Closes a call whose provider supplied no final comparable usage. Existing
   * final usage remains authoritative; cumulative/delta observations are kept
   * and become a settled partial result instead of being discarded.
   */
  settleUnavailableIfOpen(input: {
    readonly callId: string
    readonly role: UsageRole
    readonly scope: UsageScope
  }): void {
    if (input.scope.runId !== this.#runId) throw new Error("Usage call belongs to another run")
    const key = callBindingKey(input)
    const existing = this.#calls.get(key)
    if (existing && (existing.role !== input.role || !scopeEqual(existing.scope, input.scope))) {
      throw new Error(`Usage call binding changed: ${input.callId}`)
    }
    if (existing?.settled) return
    this.update({
      ...input,
      usage: { source: "unavailable", semantics: "final" },
    })
  }

  update(input: UsageUpdate): void {
    const usage = TokenUsageSchema.parse(input.usage)
    if (input.scope.runId !== this.#runId) throw new Error("Usage call belongs to another run")
    const key = callBindingKey(input)
    const existing = this.#calls.get(key)
    if (existing && (existing.role !== input.role || !scopeEqual(existing.scope, input.scope))) {
      throw new Error(`Usage call binding changed: ${input.callId}`)
    }
    const state: MutableCall = existing
      ? cloneCall(existing)
      : {
          callId: input.callId,
          role: input.role,
          scope: input.scope,
          values: {},
          source: "unavailable" as const,
          unavailable: true,
          settled: false,
          updates: 0,
          priceSnapshotIds: new Set<string>(),
          providerRawRefs: new Set<string>(),
        }
    if (state.settled) throw new Error(`Usage call already received final usage: ${input.callId}`)
    state.updates += 1
    if (usage.providerRawRef) state.providerRawRefs.add(usage.providerRawRef)
    if (usage.source === "unavailable") {
      state.unavailable = true
      if (usage.semantics === "final") state.settled = true
      this.#calls.set(key, state)
      return
    }

    state.unavailable = false
    state.source = measuredSource(state.source, usage.source)
    for (const field of TOKEN_FIELDS) {
      const next = usage[field]
      if (next === undefined) continue
      const previous = state.values[field]
      if (usage.semantics === "delta") {
        state.values[field] = safeAdd(previous ?? 0, next, `${input.callId}.${field}`)
      } else {
        if (previous !== undefined && next < previous) {
          throw new Error(
            `Cumulative/final usage regressed for ${input.callId}.${field}: ${next} < ${previous}`,
          )
        }
        state.values[field] = next
      }
    }
    if (usage.cost) {
      const previous = state.cost
      const nextSource = (usage.cost.source ?? usage.source) as CostSource
      if (previous && previous.currency !== usage.cost.currency) {
        throw new Error(`Usage currency changed within call ${input.callId}`)
      }
      if (usage.semantics !== "delta" && previous && usage.cost.amount < previous.amount) {
        throw new Error(`Cumulative/final cost regressed for call ${input.callId}`)
      }
      state.cost = {
        amount:
          usage.semantics === "delta"
            ? (previous?.amount ?? 0) + usage.cost.amount
            : usage.cost.amount,
        currency: usage.cost.currency,
        source: previous ? (measuredSource(previous.source, nextSource) as CostSource) : nextSource,
      }
      if (!Number.isFinite(state.cost.amount) || state.cost.amount < 0) {
        throw new Error(`Usage cost overflow for call ${input.callId}`)
      }
      state.priceSnapshotIds.add(usage.cost.priceSnapshotId)
    }
    if (usage.semantics === "final") state.settled = true
    this.#calls.set(key, state)
  }

  snapshot(): UsageBreakdown {
    const calls = [...this.#calls.values()]
      .map(finalCall)
      .sort((left, right) => callBindingKey(left).localeCompare(callBindingKey(right)))
    const roles = groupAggregate(calls, (call) => call.role) as Partial<
      Record<UsageRole, UsageAggregate>
    >
    return {
      runId: this.#runId,
      total: aggregateCalls(calls),
      roles,
      attempts: groupAggregate(calls, (call) => call.scope.attemptId),
      tasks: groupAggregate(calls, (call) =>
        call.scope.documentId && call.scope.taskId
          ? `${call.scope.documentId}/${call.scope.taskId}`
          : undefined,
      ),
      children: groupAggregate(calls, (call) => call.scope.childRunId),
      calls: Object.fromEntries(calls.map((call) => [callBindingKey(call), call])),
    }
  }
}

export type PriceApplicationResult = {
  /** Token counters retain their original provider/tokenizer provenance. */
  readonly usage: TokenUsage
  readonly priced: boolean
  /** Cost has independent provenance because TokenUsage.source describes its measured fields as a whole. */
  readonly cost?: {
    readonly amount: number
    readonly currency: string
    readonly priceSnapshotId: string
    readonly source: Exclude<UsageSource, "unavailable">
  }
  readonly reason?: string
}

/**
 * Computes separately sourced cost only when the complete billable metric
 * vector is present and every non-zero metric has a price. Omission is never
 * interpreted as a zero counter unless the pinned model capability snapshot
 * proves that dimension inapplicable. When pricing succeeds, `usage` is the same
 * normalized token observation enriched with
 * the immutable price-snapshot binding. Token provenance remains on
 * `usage.source`; the independently derived cost source remains available on
 * `cost.source`.
 */
export function applyPriceSnapshot(
  usageInput: TokenUsage,
  priceInput: PriceSnapshot,
  access: ModelAccess,
  applicableMetrics?: readonly UsageMetric[],
): PriceApplicationResult {
  const usage = TokenUsageSchema.parse(usageInput)
  const price = PriceSnapshotSchema.parse(priceInput)
  if (usage.source === "unavailable") {
    return { usage, priced: false, reason: "token usage is unavailable" }
  }
  if (usage.cost) {
    const source = (usage.cost.source ?? usage.source) as Exclude<UsageSource, "unavailable">
    return {
      usage: TokenUsageSchema.parse({
        ...usage,
        cost: { ...usage.cost, source },
      }),
      priced: true,
      cost: {
        ...usage.cost,
        source,
      },
    }
  }
  if (price.status === "unavailable") {
    return {
      usage,
      priced: false,
      ...(price.reason !== undefined ? { reason: price.reason } : {}),
    }
  }
  if (!price.appliesTo.includes(access)) {
    return {
      usage,
      priced: false,
      reason: `price snapshot does not apply to ${access} access`,
    }
  }
  if (!price.currency) {
    return { usage, priced: false, reason: "price snapshot has no currency" }
  }
  if (
    usage.input !== undefined &&
    usage.inputNonCached !== undefined &&
    usage.inputNonCached > usage.input
  ) {
    return {
      usage,
      priced: false,
      reason: "non-cached input exceeds total input",
    }
  }
  if (
    usage.inputNonCached === undefined &&
    usage.input !== undefined &&
    ((usage.cacheRead ?? 0) > 0 || (usage.cacheWrite ?? 0) > 0)
  ) {
    return {
      usage,
      priced: false,
      reason: "input includes cache activity but non-cached input was not reported",
    }
  }

  const capabilities = applicableMetrics ? new Set(applicableMetrics) : undefined
  const supportsCacheRead = capabilities?.has("cache-read") ?? true
  const supportsCacheWrite = capabilities?.has("cache-write") ?? true
  const supportsCache = supportsCacheRead || supportsCacheWrite
  const supportsInput = capabilities?.has("input") === true || supportsCache
  const missingMetrics = capabilities
    ? [
        supportsInput && usage.input === undefined ? "input" : undefined,
        supportsCache && usage.inputNonCached === undefined ? "inputNonCached" : undefined,
        supportsCacheRead && usage.cacheRead === undefined ? "cacheRead" : undefined,
        supportsCacheWrite && usage.cacheWrite === undefined ? "cacheWrite" : undefined,
        capabilities.has("output") && usage.output === undefined ? "output" : undefined,
        capabilities.has("reasoning") && usage.reasoning === undefined ? "reasoning" : undefined,
      ].filter((metric): metric is string => metric !== undefined)
    : [
        usage.input === undefined ? "input" : undefined,
        usage.inputNonCached === undefined ? "inputNonCached" : undefined,
        usage.cacheRead === undefined ? "cacheRead" : undefined,
        usage.cacheWrite === undefined ? "cacheWrite" : undefined,
        usage.output === undefined ? "output" : undefined,
        usage.reasoning === undefined ? "reasoning" : undefined,
      ].filter((metric): metric is string => metric !== undefined)
  if (missingMetrics.length > 0) {
    return {
      usage,
      priced: false,
      reason: `derived cost requires a complete billable usage vector: ${missingMetrics.join(", ")}`,
    }
  }
  const unsupportedObserved = capabilities
    ? [
        !supportsInput && ((usage.input ?? 0) > 0 || (usage.inputNonCached ?? 0) > 0)
          ? "input/inputNonCached"
          : undefined,
        !supportsCacheRead && (usage.cacheRead ?? 0) > 0 ? "cacheRead" : undefined,
        !supportsCacheWrite && (usage.cacheWrite ?? 0) > 0 ? "cacheWrite" : undefined,
        !capabilities.has("output") && (usage.output ?? 0) > 0 ? "output" : undefined,
        !capabilities.has("reasoning") && (usage.reasoning ?? 0) > 0 ? "reasoning" : undefined,
      ].filter((metric): metric is string => metric !== undefined)
    : []
  if (unsupportedObserved.length > 0) {
    return {
      usage,
      priced: false,
      reason: `usage reported metrics excluded by the pinned model capability snapshot: ${unsupportedObserved.join(", ")}`,
    }
  }
  if (
    capabilities &&
    supportsInput &&
    !supportsCache &&
    usage.inputNonCached !== undefined &&
    usage.inputNonCached !== usage.input
  ) {
    return {
      usage,
      priced: false,
      reason: "non-cached input differs from total input although cache metrics are inapplicable",
    }
  }
  if (
    supportsCache &&
    usage.input !== undefined &&
    usage.inputNonCached !== undefined &&
    usage.inputNonCached + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) !== usage.input
  ) {
    return {
      usage,
      priced: false,
      reason: "cached and non-cached input usage does not partition total input exactly",
    }
  }

  const components = [
    [
      "input",
      !capabilities || supportsInput
        ? supportsCache
          ? usage.inputNonCached
          : usage.input
        : undefined,
      price.input,
    ],
    [
      "cacheRead",
      !capabilities || supportsCacheRead ? usage.cacheRead : undefined,
      price.cacheRead,
    ],
    [
      "cacheWrite",
      !capabilities || supportsCacheWrite ? usage.cacheWrite : undefined,
      price.cacheWrite,
    ],
    [
      "output",
      !capabilities || capabilities.has("output") ? usage.output : undefined,
      price.output,
    ],
    [
      "reasoning",
      !capabilities || capabilities.has("reasoning") ? usage.reasoning : undefined,
      price.reasoning,
    ],
  ] as const
  let amount = 0
  let observed = false
  for (const [name, tokens, rate] of components) {
    if (tokens === undefined) continue
    observed = true
    if (tokens === 0) continue
    if (rate === undefined) {
      return { usage, priced: false, reason: `price snapshot has no ${name} rate` }
    }
    amount += (tokens * rate) / 1_000_000
  }
  if (!observed) {
    return { usage, priced: false, reason: "no billable token metric was reported" }
  }
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Derived usage cost overflowed")
  }
  const cost = {
    amount,
    currency: price.currency,
    priceSnapshotId: price.id,
    source: usage.source === "estimated" ? ("estimated" as const) : ("derived" as const),
  }
  return {
    usage: TokenUsageSchema.parse({
      ...usage,
      cost: {
        amount: cost.amount,
        currency: cost.currency,
        priceSnapshotId: cost.priceSnapshotId,
        source: cost.source,
      },
    }),
    priced: true,
    cost,
  }
}

function usageScope(event: EventEnvelope, aggregateRunId: string): UsageScope | undefined {
  if (!event.runId) return undefined
  const projectedChild = event.runId !== aggregateRunId
  return {
    runId: aggregateRunId,
    ...(event.documentId !== undefined ? { documentId: event.documentId } : {}),
    ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
    ...(event.attemptId !== undefined ? { attemptId: event.attemptId } : {}),
    ...(projectedChild && event.parentRunId !== undefined
      ? { parentRunId: event.parentRunId, childRunId: event.runId }
      : {}),
  }
}

/**
 * Applies one normalized durable event to an existing usage accumulator.
 *
 * Snapshot/replay clients use this entrypoint while reading bounded ledger
 * pages, so rebuilding usage never requires retaining the complete event
 * history in memory. The accumulator remains the single authority for
 * delta/cumulative/final semantics and call binding.
 */
export function ingestUsageEvent(
  aggregate: TokenUsageAggregator,
  event: EventEnvelope,
  runId: string,
): void {
  if (event.runId !== runId && event.parentRunId !== runId) return
  const scope = usageScope(event, runId)
  if (!scope) return
  const role: UsageRole =
    event.runId !== runId
      ? "child"
      : event.type.startsWith("judge.")
        ? "judge"
        : event.type.startsWith("tool-model.")
          ? "tool-model"
          : "executor"
  if (event.type === "judge.call.started") {
    if (event.callId) aggregate.registerCall({ callId: event.callId, role, scope })
    return
  }
  if (event.type === "judge.call.finished") {
    if (event.callId) {
      aggregate.settleUnavailableIfOpen({ callId: event.callId, role, scope })
    }
    return
  }
  if (event.type === "model.backend.call.reserved") {
    const providerCallId = event.payload.providerCallId
    if (typeof providerCallId === "string" && providerCallId.length > 0) {
      aggregate.registerCall({ callId: providerCallId, role, scope })
    }
    return
  }
  if (
    event.type !== "model.usage.updated" &&
    event.type !== "judge.backend.model.usage.updated" &&
    event.type !== "tool-model.usage.updated"
  ) {
    return
  }
  const backendPayload =
    typeof event.payload.backendPayload === "object" && event.payload.backendPayload !== null
      ? (event.payload.backendPayload as Record<string, unknown>)
      : undefined
  const nestedBackendPayload =
    backendPayload && typeof backendPayload.payload === "object" && backendPayload.payload !== null
      ? (backendPayload.payload as Record<string, unknown>)
      : undefined
  const rawUsage =
    event.type === "judge.backend.model.usage.updated"
      ? (event.payload.usage ?? backendPayload?.usage ?? nestedBackendPayload?.usage)
      : event.payload.usage
  const parsed = TokenUsageSchema.safeParse(rawUsage)
  if (!parsed.success) return
  const callId =
    event.type === "model.usage.updated" && typeof event.payload.providerCallId === "string"
      ? event.payload.providerCallId
      : (event.callId ??
        (typeof event.payload.providerCallId === "string"
          ? event.payload.providerCallId
          : `usage-event:${event.eventId}`))
  aggregate.update({ callId, role, scope, usage: parsed.data })
}

/** Rebuilds a run breakdown from normalized durable usage events. */
export function aggregateUsageEvents(
  events: readonly EventEnvelope[],
  runId: string,
): UsageBreakdown {
  const aggregate = new TokenUsageAggregator(runId)
  for (const event of events) ingestUsageEvent(aggregate, event, runId)
  return aggregate.snapshot()
}
