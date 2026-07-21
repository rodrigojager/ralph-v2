import {
  canTransitionWatchdogState,
  type Diagnostic,
  DiagnosticSchema,
  resolveWatchdogPhaseProfile,
  type WatchdogEvaluation,
  WatchdogEvaluationSchema,
  type WatchdogObservation,
  WatchdogObservationSchema,
  type WatchdogOperationalBudget,
  WatchdogOperationalBudgetSchema,
  type WatchdogPhaseProfile,
  type WatchdogProfile,
  WatchdogProfileSchema,
  type WatchdogReasonCode,
  type WatchdogRecoveryDecision,
  WatchdogRecoveryDecisionSchema,
  type WatchdogSignalAssessment,
  WatchdogSignalAssessmentSchema,
  type WatchdogSnapshot,
  WatchdogSnapshotSchema,
  type WatchdogState,
  watchdogRestartBudgetView,
} from "@ralph/domain"

export type EvaluateWatchdogInput = {
  profile: WatchdogProfile
  observation: WatchdogObservation
  budget: WatchdogOperationalBudget
  previousSnapshot?: WatchdogSnapshot
}

function age(now: number, marker: number | undefined, fallback: number): number {
  return Math.max(0, now - (marker ?? fallback))
}

function safeDeadline(start: number, duration: number | undefined): number | undefined {
  if (duration === undefined) return undefined
  return Math.min(Number.MAX_SAFE_INTEGER, start + duration)
}

function earliestDeadline(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length === 0 ? undefined : Math.min(...present)
}

function signal(
  name: WatchdogSignalAssessment["signal"],
  verdict: WatchdogSignalAssessment["verdict"],
  reason: WatchdogReasonCode,
  ageMs?: number,
): WatchdogSignalAssessment {
  return WatchdogSignalAssessmentSchema.parse({
    signal: name,
    verdict,
    reason,
    ...(ageMs !== undefined ? { ageMs } : {}),
  })
}

type SignalAnalysis = {
  signals: WatchdogSignalAssessment[]
  progressSilenceMs: number
  controlSilenceMs: number
  phaseDeadlineExceeded: boolean
  hardTimeoutExceeded: boolean
  negativeQuorum: boolean
  positiveSignals: number
  reasons: WatchdogReasonCode[]
}

function analyzeSignals(
  observation: WatchdogObservation,
  profile: WatchdogPhaseProfile,
): SignalAnalysis {
  const now = observation.monotonicMs
  const phaseStart = observation.phaseStartedMonotonicMs
  const controlSilenceMs = age(now, observation.lastControlHeartbeatMonotonicMs, phaseStart)
  const progressSilenceMs = age(now, observation.lastProgressMonotonicMs, phaseStart)
  const childSilenceMs = age(now, observation.lastChildHeartbeatMonotonicMs, phaseStart)
  const profileHardDeadline = safeDeadline(phaseStart, profile.hardTimeoutMs)
  const effectiveHardDeadline = earliestDeadline(
    profileHardDeadline,
    observation.hardDeadlineMonotonicMs,
  )
  const hardTimeoutExceeded = effectiveHardDeadline !== undefined && now >= effectiveHardDeadline
  const phaseDeadlineExceeded =
    observation.phaseDeadlineMonotonicMs !== undefined &&
    now >= observation.phaseDeadlineMonotonicMs

  const signals: WatchdogSignalAssessment[] = []
  signals.push(
    controlSilenceMs <= profile.heartbeatGraceMs
      ? signal("control-heartbeat", "positive", "control-heartbeat-fresh", controlSilenceMs)
      : signal("control-heartbeat", "negative", "control-heartbeat-missing", controlSilenceMs),
  )

  if (progressSilenceMs < profile.quietAfterMs) {
    signals.push(signal("progress", "positive", "progress-recent", progressSilenceMs))
  } else if (progressSilenceMs < profile.slowAfterMs) {
    signals.push(signal("progress", "positive", "progress-quiet", progressSilenceMs))
  } else if (progressSilenceMs < profile.suspectAfterMs) {
    signals.push(signal("progress", "unknown", "progress-slow", progressSilenceMs))
  } else {
    signals.push(signal("progress", "negative", "progress-stale", progressSilenceMs))
  }

  switch (observation.processAlive) {
    case "yes":
      signals.push(signal("process", "positive", "process-alive"))
      break
    case "no":
      signals.push(signal("process", "negative", "process-dead"))
      break
    case "unknown":
      signals.push(signal("process", "unknown", "process-unknown"))
      break
  }

  signals.push(
    observation.processActivity === "yes"
      ? signal("process-activity", "positive", "process-active")
      : signal("process-activity", "unknown", "process-idle"),
  )

  const providerPhase = observation.phase === "model-call" || observation.phase === "judge"
  const providerRetryActive =
    observation.providerRetryAfterMonotonicMs !== undefined &&
    observation.providerRetryAfterMonotonicMs > now
  if (!providerPhase) {
    signals.push(signal("provider", "not-applicable", "provider-unknown"))
    signals.push(signal("provider-stream", "not-applicable", "provider-stream-quiet"))
  } else if (providerRetryActive) {
    signals.push(signal("provider", "positive", "provider-retry-after"))
    signals.push(
      observation.providerStreamOpen === "yes"
        ? signal("provider-stream", "positive", "provider-stream-open")
        : signal("provider-stream", "unknown", "provider-stream-quiet"),
    )
  } else {
    switch (observation.providerPending) {
      case "yes":
        signals.push(signal("provider", "positive", "provider-pending"))
        break
      case "no":
        signals.push(signal("provider", "negative", "provider-idle"))
        break
      case "unknown":
        signals.push(signal("provider", "unknown", "provider-unknown"))
        break
    }
    signals.push(
      observation.providerStreamOpen === "yes"
        ? signal("provider-stream", "positive", "provider-stream-open")
        : signal("provider-stream", "unknown", "provider-stream-quiet"),
    )
  }

  if (hardTimeoutExceeded) {
    signals.push(signal("deadline", "negative", "hard-timeout-exceeded"))
  } else if (phaseDeadlineExceeded) {
    signals.push(signal("deadline", "negative", "phase-deadline-exceeded"))
  } else if (
    effectiveHardDeadline !== undefined ||
    observation.phaseDeadlineMonotonicMs !== undefined
  ) {
    signals.push(signal("deadline", "positive", "deadline-within-limit"))
  } else {
    signals.push(signal("deadline", "not-applicable", "deadline-within-limit"))
  }

  signals.push(
    observation.phase === "child"
      ? childSilenceMs <= profile.heartbeatGraceMs
        ? signal("child-heartbeat", "positive", "child-heartbeat-fresh", childSilenceMs)
        : signal("child-heartbeat", "negative", "child-heartbeat-missing", childSilenceMs)
      : signal("child-heartbeat", "not-applicable", "child-heartbeat-fresh"),
  )

  switch (observation.settlement) {
    case "running":
      signals.push(signal("settlement", "positive", "settlement-running"))
      break
    case "settled":
      signals.push(signal("settlement", "positive", "settlement-finished"))
      break
    case "unknown":
      signals.push(signal("settlement", "unknown", "settlement-unknown"))
      break
  }

  const negativeSignals = signals.filter((item) => item.verdict === "negative")
  const negativeSignalFamilies = new Set(
    negativeSignals.map((item) => {
      // A child periodic heartbeat and an active ping/pong are independent
      // probes, but they share one IPC control plane. Losing that transport
      // may make both observations negative and must still occupy only one
      // quorum slot; a destructive decision needs another signal family.
      if (
        observation.phase === "child" &&
        (item.signal === "control-heartbeat" || item.signal === "child-heartbeat")
      ) {
        return "child-ipc-control-plane"
      }
      return item.signal
    }),
  )
  const positiveSignals = signals.filter((item) => item.verdict === "positive").length
  const negativeQuorum = negativeSignalFamilies.size >= 2
  const reasons = [...new Set(signals.map((item) => item.reason))]
  if (negativeQuorum) reasons.push("negative-quorum")
  else if (negativeSignals.length > 0) reasons.push("insufficient-negative-signals")

  return {
    signals,
    progressSilenceMs,
    controlSilenceMs,
    phaseDeadlineExceeded,
    hardTimeoutExceeded,
    negativeQuorum,
    positiveSignals,
    reasons: [...new Set(reasons)],
  }
}

function classifyState(input: {
  profile: WatchdogPhaseProfile
  observation: WatchdogObservation
  analysis: SignalAnalysis
  previous?: WatchdogSnapshot
}): { state: WatchdogState; negativeConfirmations: number; reasons: WatchdogReasonCode[] } {
  const { profile, observation, analysis, previous } = input
  const samePhase = previous?.phase === observation.phase
  const previousConfirmations = samePhase ? (previous?.negativeConfirmations ?? 0) : 0
  const reasons = [...analysis.reasons]

  let state: WatchdogState
  let negativeConfirmations = 0
  if (!profile.enabled) {
    state = "healthy"
    reasons.push("watchdog-disabled")
  } else if (observation.settlement === "settled") {
    state = "healthy"
  } else if (analysis.hardTimeoutExceeded) {
    // A hard timeout is an absolute negative signal, so positive heartbeat,
    // process, or provider observations cannot make the phase healthy again.
    // It still needs the configured number of distinct probes before a
    // destructive recovery action. This avoids encoding a single clock read
    // as multiple confirmations while preserving confirmations=1 semantics.
    if (samePhase && previous?.state === "stalled") {
      state = "stalled"
      negativeConfirmations = previousConfirmations
    } else {
      const previousHardTimeoutConfirmations =
        samePhase && previous?.hardTimeoutExceeded ? previousConfirmations : 0
      negativeConfirmations = previousHardTimeoutConfirmations + 1
      state = negativeConfirmations >= profile.confirmations ? "stalled" : "suspect"
      if (state === "suspect") reasons.push("awaiting-confirmation")
    }
  } else {
    const processDefinitelyGone =
      observation.processAlive === "no" && observation.settlement === "running"
    const suspicionWindowReached =
      analysis.progressSilenceMs >= profile.suspectAfterMs ||
      analysis.controlSilenceMs > profile.heartbeatGraceMs ||
      analysis.phaseDeadlineExceeded ||
      processDefinitelyGone
    if (analysis.negativeQuorum && suspicionWindowReached) {
      negativeConfirmations = previousConfirmations + 1
      state = negativeConfirmations >= profile.confirmations ? "stalled" : "suspect"
      if (state === "suspect") reasons.push("awaiting-confirmation")
    } else if (
      analysis.progressSilenceMs >= profile.slowAfterMs ||
      analysis.controlSilenceMs > profile.heartbeatGraceMs
    ) {
      state = "slow"
    } else if (analysis.progressSilenceMs >= profile.quietAfterMs) {
      state = "quiet"
    } else {
      state = "healthy"
    }
  }

  const previousWasActionable = previous?.state === "suspect" || previous?.state === "stalled"
  const leftActionableState = state !== "suspect" && state !== "stalled"
  const recoveryConfirmed =
    !profile.enabled || observation.settlement === "settled" || analysis.positiveSignals >= 2
  if (samePhase && previous && previousWasActionable && leftActionableState) {
    if (recoveryConfirmed) {
      state = "recovered"
      negativeConfirmations = 0
      reasons.push("recovered-signals")
    } else {
      state = previous.state
      negativeConfirmations = previous.negativeConfirmations
      reasons.push("awaiting-confirmation")
    }
  } else if (
    samePhase &&
    previous?.state === "slow" &&
    (state === "healthy" || state === "quiet") &&
    recoveryConfirmed
  ) {
    state = "recovered"
    negativeConfirmations = 0
    reasons.push("recovered-signals")
  }

  if (samePhase && previous && !canTransitionWatchdogState(previous.state, state)) {
    throw new Error(`Invalid watchdog state transition: ${previous.state} -> ${state}`)
  }
  return { state, negativeConfirmations, reasons: [...new Set(reasons)] }
}

function buildSnapshot(input: {
  profile: WatchdogPhaseProfile
  observation: WatchdogObservation
  analysis: SignalAnalysis
  previous?: WatchdogSnapshot
}): WatchdogSnapshot {
  const classified = classifyState(input)
  return WatchdogSnapshotSchema.parse({
    schemaVersion: 1,
    probeId: input.observation.probeId,
    state: classified.state,
    phase: input.observation.phase,
    observedAt: input.observation.observedAt,
    monotonicMs: input.observation.monotonicMs,
    ...(input.observation.lastControlHeartbeatAt
      ? { lastControlHeartbeatAt: input.observation.lastControlHeartbeatAt }
      : {}),
    ...(input.observation.lastProgressAt
      ? { lastProgressAt: input.observation.lastProgressAt }
      : {}),
    processAlive: input.observation.processAlive,
    providerPending: input.observation.providerPending,
    negativeConfirmations: classified.negativeConfirmations,
    elapsedMs: input.observation.monotonicMs - input.observation.phaseStartedMonotonicMs,
    progressSilenceMs: input.analysis.progressSilenceMs,
    controlSilenceMs: input.analysis.controlSilenceMs,
    phaseDeadlineExceeded: input.analysis.phaseDeadlineExceeded,
    hardTimeoutExceeded: input.analysis.hardTimeoutExceeded,
    negativeQuorum: input.analysis.negativeQuorum,
    signals: input.analysis.signals,
    reasons: classified.reasons,
  })
}

function recoveryDecision(input: {
  profile: WatchdogPhaseProfile
  snapshot: WatchdogSnapshot
  budget: WatchdogOperationalBudget
  previous?: WatchdogSnapshot
}): { decision: WatchdogRecoveryDecision; nextBudget: WatchdogOperationalBudget } {
  const { profile, snapshot, budget, previous } = input
  const sameState =
    previous !== undefined && previous.phase === snapshot.phase && previous.state === snapshot.state
  const enteredActionableState = !sameState
  const before = watchdogRestartBudgetView(budget, profile.maxRestarts)
  let action: WatchdogRecoveryDecision["action"] = "none"
  let cause: WatchdogRecoveryDecision["cause"] = "none"
  let watchdogRestartDelta: 0 | 1 = 0
  const reasons = [...snapshot.reasons]

  if (!profile.enabled) {
    cause = "disabled"
  } else if (snapshot.reasons.includes("settlement-finished")) {
    cause = "settled"
  } else if (snapshot.state === "suspect" && enteredActionableState) {
    action = "notify"
    cause = "suspect"
  } else if (snapshot.state === "stalled" && enteredActionableState) {
    cause = snapshot.hardTimeoutExceeded ? "hard-timeout" : "stalled"
    if (profile.action === "restart-attempt" && before.exhausted) {
      action = "stop-run"
      cause = "restart-budget-exhausted"
      reasons.push("restart-budget-exhausted")
    } else {
      action = profile.action
      watchdogRestartDelta = action === "restart-attempt" ? 1 : 0
    }
  }

  const nextBudget = WatchdogOperationalBudgetSchema.parse({
    schemaVersion: 1,
    watchdogRestarts: budget.watchdogRestarts + watchdogRestartDelta,
  })
  const after = watchdogRestartBudgetView(nextBudget, profile.maxRestarts)
  const destructive = action === "cancel" || action === "restart-attempt" || action === "stop-run"
  const decision = WatchdogRecoveryDecisionSchema.parse({
    schemaVersion: 1,
    action,
    configuredAction: profile.action,
    cause,
    phase: snapshot.phase,
    state: snapshot.state,
    requiresDiagnosticSnapshot:
      enteredActionableState && (snapshot.state === "suspect" || snapshot.state === "stalled"),
    requestProtocolPing: enteredActionableState && snapshot.state === "suspect",
    gracefulCancelFirst: destructive,
    forceKillAfterGrace: destructive,
    preserveTask: true,
    preserveDiff: true,
    resumable: true,
    consumesJudgeRevision: false,
    watchdogRestartDelta,
    budgetBefore: before,
    budgetAfter: after,
    reasons: [...new Set(reasons)],
  })
  return { decision, nextBudget }
}

function evaluationDiagnostics(input: {
  snapshot: WatchdogSnapshot
  decision: WatchdogRecoveryDecision
  previous?: WatchdogSnapshot
}): Diagnostic[] {
  const { snapshot, decision, previous } = input
  const changed =
    !previous || previous.phase !== snapshot.phase || previous.state !== snapshot.state
  if (!changed) return []
  const details = {
    phase: snapshot.phase,
    state: snapshot.state,
    probeId: snapshot.probeId,
    elapsedMs: snapshot.elapsedMs,
    negativeConfirmations: snapshot.negativeConfirmations,
    negativeQuorum: snapshot.negativeQuorum,
    configuredAction: decision.configuredAction,
    selectedAction: decision.action,
    reasons: snapshot.reasons,
  }

  if (decision.cause === "restart-budget-exhausted") {
    return [
      DiagnosticSchema.parse({
        code: "WATCHDOG_RESTART_BUDGET_EXHAUSTED",
        severity: "error",
        message: "The watchdog restart budget is exhausted; the run must stop resumably.",
        hint: "Inspect the diagnostic snapshot and resume the same task after correcting the stall.",
        details,
      }),
    ]
  }
  if (snapshot.state === "stalled") {
    return [
      DiagnosticSchema.parse({
        code: "WATCHDOG_STALLED",
        severity: "error",
        message: "Multiple watchdog signals confirmed that the monitored phase is stalled.",
        details,
      }),
    ]
  }
  if (snapshot.state === "suspect") {
    return [
      DiagnosticSchema.parse({
        code: "WATCHDOG_SUSPECT",
        severity: "warning",
        message: "Multiple watchdog signals are negative and require confirmation.",
        details,
      }),
    ]
  }
  if (snapshot.state === "recovered") {
    return [
      DiagnosticSchema.parse({
        code: "WATCHDOG_RECOVERED",
        severity: "info",
        message:
          "The monitored phase produced independent signs of life before destructive action.",
        details,
      }),
    ]
  }
  return []
}

export function evaluateWatchdog(input: EvaluateWatchdogInput): WatchdogEvaluation {
  const profile = WatchdogProfileSchema.parse(input.profile)
  const observation = WatchdogObservationSchema.parse(input.observation)
  const budget = WatchdogOperationalBudgetSchema.parse(input.budget)
  const previous = input.previousSnapshot
    ? WatchdogSnapshotSchema.parse(input.previousSnapshot)
    : undefined
  if (previous?.phase === observation.phase && observation.monotonicMs <= previous.monotonicMs) {
    throw new Error(
      `Watchdog probes must advance monotonically: ${observation.monotonicMs} <= ${previous.monotonicMs}`,
    )
  }

  const effectiveProfile = resolveWatchdogPhaseProfile(profile, observation.phase)
  const analysis = analyzeSignals(observation, effectiveProfile)
  const snapshot = buildSnapshot({
    profile: effectiveProfile,
    observation,
    analysis,
    ...(previous ? { previous } : {}),
  })
  const recovery = recoveryDecision({
    profile: effectiveProfile,
    snapshot,
    budget,
    ...(previous ? { previous } : {}),
  })
  const diagnostics = evaluationDiagnostics({
    snapshot,
    decision: recovery.decision,
    ...(previous ? { previous } : {}),
  })

  return WatchdogEvaluationSchema.parse({
    schemaVersion: 1,
    ...(previous ? { previousSnapshot: previous } : {}),
    effectiveProfile,
    snapshot,
    decision: recovery.decision,
    nextBudget: recovery.nextBudget,
    diagnostics,
  })
}
