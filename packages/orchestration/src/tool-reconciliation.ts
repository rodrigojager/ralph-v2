import {
  hashToolCallPayload,
  type ToolCallIntentRecord,
  type ToolCallJournal,
  type ToolCallSettlementOutcome,
  type UnsettledToolCallQuery,
} from "@ralph-next/persistence"

export type PreconditionProbeResult = {
  bindingHash: string
  effect: "present" | "absent" | "conflict" | "unknown"
  reason: string
  effectRefs?: readonly string[]
  outputRefs?: readonly string[]
}

export type ProcessRecoveryProbeResult = {
  identity: "same-alive" | "same-settled" | "same-exited" | "different-process" | "dead" | "unknown"
  reason: string
  exitCode?: number
  effectRefs?: readonly string[]
  outputRefs?: readonly string[]
}

export type ReplayedToolSettlement = {
  outcome: ToolCallSettlementOutcome
  result: unknown
  effectRefs?: readonly string[]
  outputRefs?: readonly string[]
  errorCode?: string
}

export type ToolReplayDecision =
  | { status: "settled"; settlement: ReplayedToolSettlement }
  | { status: "paused"; reason: string }

export type ToolReconciliationAction =
  | "replayed"
  | "effect-confirmed"
  | "reattached"
  | "interrupted"
  | "paused"

export type ToolReconciliationResult = {
  intentId: string
  strategy: ToolCallIntentRecord["recoveryStrategy"]
  action: ToolReconciliationAction
  automatic: boolean
  reason: string
  settlementOutcome?: ToolCallSettlementOutcome
}

export type ToolReconciliationPorts = {
  probePreconditions?(intent: ToolCallIntentRecord): Promise<PreconditionProbeResult>
  probeProcess?(intent: ToolCallIntentRecord): Promise<ProcessRecoveryProbeResult>
  replaySafe?(intent: ToolCallIntentRecord): Promise<ToolReplayDecision>
  reattachProcess?(
    intent: ToolCallIntentRecord,
    probe: ProcessRecoveryProbeResult,
  ): Promise<ReplayedToolSettlement>
  now?: () => string
}

export type ReconcileUnsettledToolCallsInput = ToolReconciliationPorts & {
  journal: ToolCallJournal
  query?: UnsettledToolCallQuery
}

function reconciliationSettlementId(intent: ToolCallIntentRecord, action: string): string {
  return `tool-recovery-${hashToolCallPayload({
    schemaVersion: 1,
    intentId: intent.id,
    idempotencyKey: intent.idempotencyKey,
    action,
  })}`
}

function settle(
  journal: ToolCallJournal,
  intent: ToolCallIntentRecord,
  action: string,
  settlement: ReplayedToolSettlement,
  settledAt: string,
): ToolReconciliationResult {
  journal.settle({
    id: reconciliationSettlementId(intent, action),
    intentId: intent.id,
    outcome: settlement.outcome,
    resultHash: hashToolCallPayload(settlement.result),
    result: settlement.result,
    effectRefs: settlement.effectRefs ?? [],
    outputRefs: settlement.outputRefs ?? [],
    ...(settlement.errorCode ? { errorCode: settlement.errorCode } : {}),
    settledAt,
  })
  return {
    intentId: intent.id,
    strategy: intent.recoveryStrategy,
    action:
      action === "effect-confirmed"
        ? "effect-confirmed"
        : action === "reattached"
          ? "reattached"
          : action === "interrupted"
            ? "interrupted"
            : "replayed",
    automatic: true,
    reason: String(
      (settlement.result as { reason?: unknown } | null)?.reason ??
        `Tool call reconciled by ${action}`,
    ),
    settlementOutcome: settlement.outcome,
  }
}

function paused(intent: ToolCallIntentRecord, reason: string): ToolReconciliationResult {
  return {
    intentId: intent.id,
    strategy: intent.recoveryStrategy,
    action: "paused",
    automatic: false,
    reason,
  }
}

function automaticStrategyDenial(intent: ToolCallIntentRecord): string | undefined {
  if (intent.authorization === "denied") {
    return "The durable intent was denied; automatic recovery is forbidden"
  }
  switch (intent.recoveryStrategy) {
    case "safe-to-retry":
      return intent.effectClass === "read-only" && intent.risk === "read"
        ? undefined
        : "Safe replay requires both read-only effect class and read risk"
    case "verify-preconditions":
      return intent.effectClass === "workspace-write" && intent.risk === "write"
        ? undefined
        : "Precondition replay requires both workspace-write effect class and write risk"
    case "inspect-process":
      return intent.effectClass === "process" && intent.risk === "process"
        ? undefined
        : "Process recovery requires both process effect class and process risk"
    case "manual-reconciliation":
    case "never-retry":
      return undefined
  }
}

async function replay(
  journal: ToolCallJournal,
  intent: ToolCallIntentRecord,
  ports: ToolReconciliationPorts,
  now: () => string,
): Promise<ToolReconciliationResult> {
  if (!ports.replaySafe) {
    return paused(intent, "No safe replay adapter is registered for this tool")
  }
  const decision = await ports.replaySafe(intent)
  if (decision.status === "paused") return paused(intent, decision.reason)
  return settle(journal, intent, "safe-replay", decision.settlement, now())
}

async function reconcilePreconditions(
  journal: ToolCallJournal,
  intent: ToolCallIntentRecord,
  ports: ToolReconciliationPorts,
  now: () => string,
): Promise<ToolReconciliationResult> {
  if (!ports.probePreconditions) {
    return paused(intent, "Workspace write requires a registered pre/post hash probe")
  }
  const probe = await ports.probePreconditions(intent)
  if (probe.bindingHash !== intent.preconditionRefsHash) {
    return paused(intent, "Precondition probe is not bound to the durable intent")
  }
  switch (probe.effect) {
    case "present": {
      const settledAt = now()
      return settle(
        journal,
        intent,
        "effect-confirmed",
        {
          outcome: "succeeded",
          result: {
            schemaVersion: 1,
            toolCallId: intent.id,
            outcome: "success",
            content: {
              recovery: "effect-confirmed",
              reason: probe.reason,
            },
            outputRefs: [...(probe.outputRefs ?? [])],
            effects: [],
            durationMs: 0,
            retryable: false,
            recovery: "effect-confirmed",
            reason: probe.reason,
            settledAt,
          },
          effectRefs: probe.effectRefs ?? [],
          outputRefs: probe.outputRefs ?? [],
        },
        settledAt,
      )
    }
    case "absent":
      return replay(journal, intent, ports, now)
    case "conflict":
      return paused(intent, `Workspace preconditions conflict: ${probe.reason}`)
    case "unknown":
      return paused(intent, `Workspace effect cannot be proven: ${probe.reason}`)
  }
}

async function reconcileProcess(
  journal: ToolCallJournal,
  intent: ToolCallIntentRecord,
  ports: ToolReconciliationPorts,
  now: () => string,
): Promise<ToolReconciliationResult> {
  if (!ports.probeProcess) {
    return paused(intent, "Process recovery requires an identity probe")
  }
  const probe = await ports.probeProcess(intent)
  switch (probe.identity) {
    case "same-settled":
    case "same-alive": {
      if (!ports.reattachProcess) {
        return paused(
          intent,
          probe.identity === "same-alive"
            ? "The original process is alive but no reattachment adapter exists"
            : "The exact process settlement exists but no durable result adapter is registered",
        )
      }
      const settlement = await ports.reattachProcess(intent, probe)
      return settle(journal, intent, "reattached", settlement, now())
    }
    case "same-exited": {
      const settledAt = now()
      const successful = probe.exitCode === 0
      return settle(
        journal,
        intent,
        "interrupted",
        {
          outcome: successful ? "succeeded" : "interrupted",
          result: {
            schemaVersion: 1,
            toolCallId: intent.id,
            outcome: successful ? "success" : "cancelled",
            content: {
              recovery: "process-exit-observed",
              exitCode: probe.exitCode ?? null,
              reason: probe.reason,
            },
            outputRefs: [...(probe.outputRefs ?? [])],
            effects: [],
            durationMs: 0,
            retryable: false,
            recovery: successful ? "effect-confirmed" : "unknown-external-effect",
            reason: probe.reason,
            settledAt,
          },
          effectRefs: probe.effectRefs ?? [],
          outputRefs: probe.outputRefs ?? [],
          ...(successful ? {} : { errorCode: "RALPH_TOOL_PROCESS_INTERRUPTED" }),
        },
        settledAt,
      )
    }
    case "dead": {
      return paused(
        intent,
        `The exact process identities are dead but no authoritative settlement or deterministic postcondition proves whether the effect happened; explicit recovery is required: ${probe.reason}`,
      )
    }
    case "different-process":
      return paused(intent, `PID was reused by a different process: ${probe.reason}`)
    case "unknown":
      return paused(intent, `Process identity cannot be proven: ${probe.reason}`)
  }
}

/**
 * Reconciles durable intents that have no settlement after a crash.
 *
 * Only read-only replay, hash-proven workspace writes, and process identities
 * proven by a supplied adapter may settle automatically. Network, external,
 * destructive, conflicting, and unknown effects remain paused for an explicit
 * decision. The original immutable intent is never replaced.
 */
export async function reconcileUnsettledToolCalls(
  input: ReconcileUnsettledToolCallsInput,
): Promise<readonly ToolReconciliationResult[]> {
  const now = input.now ?? (() => new Date().toISOString())
  const unsettled = input.journal.listUnsettled(input.query)
  const results: ToolReconciliationResult[] = []
  for (const record of unsettled) {
    const intent = record.intent
    const denial = automaticStrategyDenial(intent)
    if (denial) {
      results.push(paused(intent, denial))
      continue
    }
    switch (intent.recoveryStrategy) {
      case "safe-to-retry":
        results.push(await replay(input.journal, intent, input, now))
        break
      case "verify-preconditions":
        results.push(await reconcilePreconditions(input.journal, intent, input, now))
        break
      case "inspect-process":
        results.push(await reconcileProcess(input.journal, intent, input, now))
        break
      case "manual-reconciliation":
        results.push(
          paused(intent, "External or network effect is ambiguous and cannot be replayed safely"),
        )
        break
      case "never-retry":
        results.push(paused(intent, "Destructive effects are never replayed automatically"))
        break
    }
  }
  return results
}
