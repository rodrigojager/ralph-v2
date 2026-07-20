import { z } from "zod"
import { DiagnosticSchema, type WatchdogConfig, WatchdogConfigSchema } from "./contracts"

const MillisecondsSchema = z.number().int().safe().nonnegative()
const PositiveMillisecondsSchema = z.number().int().safe().positive()
const TimestampSchema = z.iso.datetime({ offset: true })

export const WatchdogPhaseSchema = z.enum([
  "model-call",
  "tool",
  "gate",
  "judge",
  "child",
  "integration",
])
export type WatchdogPhase = z.infer<typeof WatchdogPhaseSchema>

export const WatchdogStateSchema = z.enum([
  "healthy",
  "quiet",
  "slow",
  "suspect",
  "stalled",
  "recovered",
])
export type WatchdogState = z.infer<typeof WatchdogStateSchema>

export const WatchdogActionSchema = z.enum(["notify", "cancel", "restart-attempt", "stop-run"])
export type WatchdogAction = z.infer<typeof WatchdogActionSchema>

export const WatchdogDecisionActionSchema = z.enum([
  "none",
  "notify",
  "cancel",
  "restart-attempt",
  "stop-run",
])
export type WatchdogDecisionAction = z.infer<typeof WatchdogDecisionActionSchema>

export const WatchdogTriStateSchema = z.enum(["yes", "no", "unknown"])
export type WatchdogTriState = z.infer<typeof WatchdogTriStateSchema>

const WatchdogPhaseProfileFields = {
  enabled: z.boolean(),
  heartbeatIntervalMs: PositiveMillisecondsSchema,
  heartbeatGraceMs: PositiveMillisecondsSchema,
  quietAfterMs: PositiveMillisecondsSchema,
  slowAfterMs: PositiveMillisecondsSchema,
  suspectAfterMs: PositiveMillisecondsSchema,
  hardTimeoutMs: PositiveMillisecondsSchema.optional(),
  probeIntervalMs: PositiveMillisecondsSchema,
  confirmations: z.number().int().safe().positive(),
  action: WatchdogActionSchema,
  maxRestarts: z.number().int().safe().nonnegative(),
} as const

type WatchdogTiming = {
  heartbeatIntervalMs: number
  heartbeatGraceMs: number
  quietAfterMs: number
  slowAfterMs: number
  suspectAfterMs: number
  hardTimeoutMs?: number | undefined
}

type TimingIssue = {
  path: keyof WatchdogTiming
  message: string
}

function timingIssues(value: WatchdogTiming): TimingIssue[] {
  const issues: TimingIssue[] = []
  if (value.heartbeatGraceMs < value.heartbeatIntervalMs) {
    issues.push({
      path: "heartbeatGraceMs",
      message: "heartbeatGraceMs must be greater than or equal to heartbeatIntervalMs",
    })
  }
  if (value.quietAfterMs < value.heartbeatGraceMs) {
    issues.push({
      path: "quietAfterMs",
      message: "quietAfterMs must be greater than or equal to heartbeatGraceMs",
    })
  }
  if (value.slowAfterMs < value.quietAfterMs) {
    issues.push({
      path: "slowAfterMs",
      message: "slowAfterMs must be greater than or equal to quietAfterMs",
    })
  }
  if (value.suspectAfterMs < value.slowAfterMs) {
    issues.push({
      path: "suspectAfterMs",
      message: "suspectAfterMs must be greater than or equal to slowAfterMs",
    })
  }
  if (value.hardTimeoutMs !== undefined && value.hardTimeoutMs < value.suspectAfterMs) {
    issues.push({
      path: "hardTimeoutMs",
      message: "hardTimeoutMs must be greater than or equal to suspectAfterMs",
    })
  }
  return issues
}

export const WatchdogPhaseProfileSchema = z
  .object(WatchdogPhaseProfileFields)
  .strict()
  .superRefine((value, context) => {
    for (const issue of timingIssues(value)) {
      context.addIssue({ code: "custom", path: [issue.path], message: issue.message })
    }
  })
export type WatchdogPhaseProfile = z.infer<typeof WatchdogPhaseProfileSchema>

export const WatchdogPhaseOverrideSchema = z
  .object({
    enabled: z.boolean().optional(),
    heartbeatIntervalMs: PositiveMillisecondsSchema.optional(),
    heartbeatGraceMs: PositiveMillisecondsSchema.optional(),
    quietAfterMs: PositiveMillisecondsSchema.optional(),
    slowAfterMs: PositiveMillisecondsSchema.optional(),
    suspectAfterMs: PositiveMillisecondsSchema.optional(),
    hardTimeoutMs: z.union([PositiveMillisecondsSchema, z.null()]).optional(),
    probeIntervalMs: PositiveMillisecondsSchema.optional(),
    confirmations: z.number().int().safe().positive().optional(),
    action: WatchdogActionSchema.optional(),
    maxRestarts: z.number().int().safe().nonnegative().optional(),
  })
  .strict()
export type WatchdogPhaseOverride = z.infer<typeof WatchdogPhaseOverrideSchema>

type WatchdogProfileShape = WatchdogPhaseProfile & {
  phases: Partial<Record<WatchdogPhase, WatchdogPhaseOverride>>
}

function baseProfile(value: WatchdogProfileShape): WatchdogPhaseProfile {
  return {
    enabled: value.enabled,
    heartbeatIntervalMs: value.heartbeatIntervalMs,
    heartbeatGraceMs: value.heartbeatGraceMs,
    quietAfterMs: value.quietAfterMs,
    slowAfterMs: value.slowAfterMs,
    suspectAfterMs: value.suspectAfterMs,
    ...(value.hardTimeoutMs !== undefined ? { hardTimeoutMs: value.hardTimeoutMs } : {}),
    probeIntervalMs: value.probeIntervalMs,
    confirmations: value.confirmations,
    action: value.action,
    maxRestarts: value.maxRestarts,
  }
}

const WatchdogProfileObjectSchema = z
  .object({
    ...WatchdogPhaseProfileFields,
    phases: z.partialRecord(WatchdogPhaseSchema, WatchdogPhaseOverrideSchema).default({}),
  })
  .strict()

export const WatchdogProfileSchema = WatchdogProfileObjectSchema.superRefine((value, context) => {
  for (const issue of timingIssues(value)) {
    context.addIssue({ code: "custom", path: [issue.path], message: issue.message })
  }

  const base = baseProfile(value)
  for (const phase of WatchdogPhaseSchema.options) {
    const override = value.phases[phase]
    if (!override) continue
    const candidate = WatchdogPhaseProfileSchema.safeParse({
      ...base,
      ...override,
      ...(override.hardTimeoutMs === null ? { hardTimeoutMs: undefined } : {}),
    })
    if (candidate.success) continue
    for (const issue of candidate.error.issues) {
      context.addIssue({
        code: "custom",
        path: ["phases", phase, ...issue.path],
        message: issue.message,
      })
    }
  }
})
export type WatchdogProfile = z.infer<typeof WatchdogProfileSchema>

const WATCHDOG_DURATION_MULTIPLIERS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const

export function parseWatchdogDuration(value: string, field = "watchdog duration"): number {
  const match = /^([1-9]\d*)(ms|s|m|h|d)$/i.exec(value)
  if (!match?.[1] || !match[2]) {
    throw new Error(`${field} must be a positive duration such as 500ms, 5s or 10m`)
  }
  const unit = match[2].toLocaleLowerCase("und") as keyof typeof WATCHDOG_DURATION_MULTIPLIERS
  const milliseconds = Number(match[1]) * WATCHDOG_DURATION_MULTIPLIERS[unit]
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(`${field} exceeds the supported millisecond range`)
  }
  return milliseconds
}

function phaseOverrideFromConfig(
  phase: WatchdogPhase,
  value: WatchdogConfig["phases"][WatchdogPhase],
): WatchdogPhaseOverride {
  if (!value) return {}
  return WatchdogPhaseOverrideSchema.parse({
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.heartbeat_interval !== undefined
      ? {
          heartbeatIntervalMs: parseWatchdogDuration(
            value.heartbeat_interval,
            `watchdog.phases.${phase}.heartbeat_interval`,
          ),
        }
      : {}),
    ...(value.heartbeat_grace !== undefined
      ? {
          heartbeatGraceMs: parseWatchdogDuration(
            value.heartbeat_grace,
            `watchdog.phases.${phase}.heartbeat_grace`,
          ),
        }
      : {}),
    ...(value.quiet_after !== undefined
      ? {
          quietAfterMs: parseWatchdogDuration(
            value.quiet_after,
            `watchdog.phases.${phase}.quiet_after`,
          ),
        }
      : {}),
    ...(value.slow_after !== undefined
      ? {
          slowAfterMs: parseWatchdogDuration(
            value.slow_after,
            `watchdog.phases.${phase}.slow_after`,
          ),
        }
      : {}),
    ...(value.suspect_after !== undefined
      ? {
          suspectAfterMs: parseWatchdogDuration(
            value.suspect_after,
            `watchdog.phases.${phase}.suspect_after`,
          ),
        }
      : {}),
    ...(value.hard_timeout !== undefined
      ? {
          hardTimeoutMs:
            value.hard_timeout === null
              ? null
              : parseWatchdogDuration(value.hard_timeout, `watchdog.phases.${phase}.hard_timeout`),
        }
      : {}),
    ...(value.probe_interval !== undefined
      ? {
          probeIntervalMs: parseWatchdogDuration(
            value.probe_interval,
            `watchdog.phases.${phase}.probe_interval`,
          ),
        }
      : {}),
    ...(value.confirmations !== undefined ? { confirmations: value.confirmations } : {}),
    ...(value.action !== undefined ? { action: value.action } : {}),
    ...(value.max_restarts !== undefined ? { maxRestarts: value.max_restarts } : {}),
  })
}

/** Converts the human-facing duration config into the monotonic runtime profile. */
export function watchdogProfileFromConfig(input: WatchdogConfig): WatchdogProfile {
  const config = WatchdogConfigSchema.parse(input)
  const phases = Object.fromEntries(
    WatchdogPhaseSchema.options.flatMap((phase) => {
      const value = config.phases[phase]
      return value ? [[phase, phaseOverrideFromConfig(phase, value)] as const] : []
    }),
  )
  return WatchdogProfileSchema.parse({
    enabled: config.enabled,
    heartbeatIntervalMs: parseWatchdogDuration(
      config.heartbeat_interval,
      "watchdog.heartbeat_interval",
    ),
    heartbeatGraceMs: parseWatchdogDuration(config.heartbeat_grace, "watchdog.heartbeat_grace"),
    quietAfterMs: parseWatchdogDuration(config.quiet_after, "watchdog.quiet_after"),
    slowAfterMs: parseWatchdogDuration(config.slow_after, "watchdog.slow_after"),
    suspectAfterMs: parseWatchdogDuration(config.suspect_after, "watchdog.suspect_after"),
    ...(config.hard_timeout === null
      ? {}
      : {
          hardTimeoutMs: parseWatchdogDuration(config.hard_timeout, "watchdog.hard_timeout"),
        }),
    probeIntervalMs: parseWatchdogDuration(config.probe_interval, "watchdog.probe_interval"),
    confirmations: config.confirmations,
    action: config.action,
    maxRestarts: config.max_restarts,
    phases,
  })
}

export function resolveWatchdogPhaseProfile(
  input: WatchdogProfile,
  requestedPhase: WatchdogPhase,
): WatchdogPhaseProfile {
  const profile = WatchdogProfileSchema.parse(input)
  const phase = WatchdogPhaseSchema.parse(requestedPhase)
  const override = profile.phases[phase]
  const resolved = {
    ...baseProfile(profile),
    ...override,
    ...(override?.hardTimeoutMs === null ? { hardTimeoutMs: undefined } : {}),
  }
  return WatchdogPhaseProfileSchema.parse(resolved)
}

export const WatchdogSignalNameSchema = z.enum([
  "control-heartbeat",
  "progress",
  "process",
  "process-activity",
  "provider",
  "provider-stream",
  "deadline",
  "child-heartbeat",
  "settlement",
])
export type WatchdogSignalName = z.infer<typeof WatchdogSignalNameSchema>

export const WatchdogSignalVerdictSchema = z.enum([
  "positive",
  "negative",
  "unknown",
  "not-applicable",
])
export type WatchdogSignalVerdict = z.infer<typeof WatchdogSignalVerdictSchema>

export const WatchdogReasonCodeSchema = z.enum([
  "watchdog-disabled",
  "control-heartbeat-fresh",
  "control-heartbeat-missing",
  "progress-recent",
  "progress-quiet",
  "progress-slow",
  "progress-stale",
  "process-alive",
  "process-dead",
  "process-unknown",
  "process-active",
  "process-idle",
  "provider-pending",
  "provider-idle",
  "provider-unknown",
  "provider-stream-open",
  "provider-stream-quiet",
  "provider-retry-after",
  "child-heartbeat-fresh",
  "child-heartbeat-missing",
  "settlement-running",
  "settlement-finished",
  "settlement-unknown",
  "deadline-within-limit",
  "phase-deadline-exceeded",
  "hard-timeout-exceeded",
  "negative-quorum",
  "insufficient-negative-signals",
  "awaiting-confirmation",
  "recovered-signals",
  "restart-budget-exhausted",
])
export type WatchdogReasonCode = z.infer<typeof WatchdogReasonCodeSchema>

export const WatchdogSignalAssessmentSchema = z
  .object({
    signal: WatchdogSignalNameSchema,
    verdict: WatchdogSignalVerdictSchema,
    reason: WatchdogReasonCodeSchema,
    ageMs: MillisecondsSchema.optional(),
  })
  .strict()
export type WatchdogSignalAssessment = z.infer<typeof WatchdogSignalAssessmentSchema>

export const WatchdogObservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    probeId: z.string().min(1),
    phase: WatchdogPhaseSchema,
    observedAt: TimestampSchema,
    monotonicMs: MillisecondsSchema,
    phaseStartedMonotonicMs: MillisecondsSchema,
    lastControlHeartbeatAt: TimestampSchema.optional(),
    lastControlHeartbeatMonotonicMs: MillisecondsSchema.optional(),
    lastProgressAt: TimestampSchema.optional(),
    lastProgressMonotonicMs: MillisecondsSchema.optional(),
    lastProcessProbeAt: TimestampSchema.optional(),
    lastProcessProbeMonotonicMs: MillisecondsSchema.optional(),
    lastChildHeartbeatAt: TimestampSchema.optional(),
    lastChildHeartbeatMonotonicMs: MillisecondsSchema.optional(),
    processAlive: WatchdogTriStateSchema.default("unknown"),
    processActivity: WatchdogTriStateSchema.default("unknown"),
    providerPending: WatchdogTriStateSchema.default("unknown"),
    providerStreamOpen: WatchdogTriStateSchema.default("unknown"),
    providerRetryAfterMonotonicMs: MillisecondsSchema.optional(),
    settlement: z.enum(["running", "settled", "unknown"]).default("unknown"),
    phaseDeadlineMonotonicMs: MillisecondsSchema.optional(),
    hardDeadlineMonotonicMs: MillisecondsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const markers = [
      "phaseStartedMonotonicMs",
      "lastControlHeartbeatMonotonicMs",
      "lastProgressMonotonicMs",
      "lastProcessProbeMonotonicMs",
      "lastChildHeartbeatMonotonicMs",
    ] as const
    for (const marker of markers) {
      const markerValue = value[marker]
      if (markerValue !== undefined && markerValue > value.monotonicMs) {
        context.addIssue({
          code: "custom",
          path: [marker],
          message: `${marker} cannot be later than monotonicMs`,
        })
      }
    }
  })
export type WatchdogObservation = z.infer<typeof WatchdogObservationSchema>

export const WatchdogSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    probeId: z.string().min(1),
    state: WatchdogStateSchema,
    phase: WatchdogPhaseSchema,
    observedAt: TimestampSchema,
    monotonicMs: MillisecondsSchema,
    lastControlHeartbeatAt: TimestampSchema.optional(),
    lastProgressAt: TimestampSchema.optional(),
    processAlive: WatchdogTriStateSchema,
    providerPending: WatchdogTriStateSchema,
    negativeConfirmations: z.number().int().safe().nonnegative(),
    elapsedMs: MillisecondsSchema,
    progressSilenceMs: MillisecondsSchema,
    controlSilenceMs: MillisecondsSchema,
    phaseDeadlineExceeded: z.boolean(),
    hardTimeoutExceeded: z.boolean(),
    negativeQuorum: z.boolean(),
    signals: z
      .array(WatchdogSignalAssessmentSchema)
      .length(WatchdogSignalNameSchema.options.length),
    reasons: z.array(WatchdogReasonCodeSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const signalNames = value.signals.map((signal) => signal.signal)
    if (new Set(signalNames).size !== WatchdogSignalNameSchema.options.length) {
      context.addIssue({
        code: "custom",
        path: ["signals"],
        message: "A watchdog snapshot must contain each signal exactly once",
      })
    }
    const derivedQuorum =
      value.signals.filter((signal) => signal.verdict === "negative").length >= 2
    if (value.negativeQuorum !== derivedQuorum) {
      context.addIssue({
        code: "custom",
        path: ["negativeQuorum"],
        message: "negativeQuorum must be derived from the signal assessments",
      })
    }
    if (
      value.state !== "suspect" &&
      value.state !== "stalled" &&
      value.negativeConfirmations !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["negativeConfirmations"],
        message: "Only suspect or stalled states may retain negative confirmations",
      })
    }
    if (
      (value.state === "suspect" || value.state === "stalled") &&
      value.negativeConfirmations === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["negativeConfirmations"],
        message: "Suspect and stalled states require at least one negative confirmation",
      })
    }
    if (new Set(value.reasons).size !== value.reasons.length) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "Watchdog reasons must be unique",
      })
    }
  })
export type WatchdogSnapshot = z.infer<typeof WatchdogSnapshotSchema>

export const WatchdogOperationalBudgetSchema = z
  .object({
    schemaVersion: z.literal(1),
    watchdogRestarts: z.number().int().safe().nonnegative(),
  })
  .strict()
export type WatchdogOperationalBudget = z.infer<typeof WatchdogOperationalBudgetSchema>

export const WatchdogRestartBudgetViewSchema = z
  .object({
    used: z.number().int().safe().nonnegative(),
    maximum: z.number().int().safe().nonnegative(),
    remaining: z.number().int().safe().nonnegative(),
    exhausted: z.boolean(),
  })
  .strict()
  .refine((value) => value.remaining === Math.max(0, value.maximum - value.used), {
    message: "remaining must be derived from maximum and used",
    path: ["remaining"],
  })
  .refine((value) => value.exhausted === value.used >= value.maximum, {
    message: "exhausted must be derived from maximum and used",
    path: ["exhausted"],
  })
export type WatchdogRestartBudgetView = z.infer<typeof WatchdogRestartBudgetViewSchema>

export function watchdogRestartBudgetView(
  budget: WatchdogOperationalBudget,
  maximum: number,
): WatchdogRestartBudgetView {
  const validated = WatchdogOperationalBudgetSchema.parse(budget)
  const maxRestarts = z.number().int().safe().nonnegative().parse(maximum)
  return WatchdogRestartBudgetViewSchema.parse({
    used: validated.watchdogRestarts,
    maximum: maxRestarts,
    remaining: Math.max(0, maxRestarts - validated.watchdogRestarts),
    exhausted: validated.watchdogRestarts >= maxRestarts,
  })
}

export const WatchdogDecisionCauseSchema = z.enum([
  "none",
  "disabled",
  "settled",
  "suspect",
  "stalled",
  "hard-timeout",
  "restart-budget-exhausted",
])
export type WatchdogDecisionCause = z.infer<typeof WatchdogDecisionCauseSchema>

export const WatchdogRecoveryDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: WatchdogDecisionActionSchema,
    configuredAction: WatchdogActionSchema,
    cause: WatchdogDecisionCauseSchema,
    phase: WatchdogPhaseSchema,
    state: WatchdogStateSchema,
    requiresDiagnosticSnapshot: z.boolean(),
    requestProtocolPing: z.boolean(),
    gracefulCancelFirst: z.boolean(),
    forceKillAfterGrace: z.boolean(),
    preserveTask: z.literal(true),
    preserveDiff: z.literal(true),
    resumable: z.literal(true),
    consumesJudgeRevision: z.literal(false),
    watchdogRestartDelta: z.union([z.literal(0), z.literal(1)]),
    budgetBefore: WatchdogRestartBudgetViewSchema,
    budgetAfter: WatchdogRestartBudgetViewSchema,
    reasons: z.array(WatchdogReasonCodeSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedDelta = value.budgetAfter.used - value.budgetBefore.used
    if (expectedDelta !== value.watchdogRestartDelta) {
      context.addIssue({
        code: "custom",
        path: ["watchdogRestartDelta"],
        message: "watchdogRestartDelta must match the budget change",
      })
    }
    if (value.watchdogRestartDelta === 1 && value.action !== "restart-attempt") {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "Only restart-attempt may consume the watchdog restart budget",
      })
    }
    if (value.action === "restart-attempt" && value.watchdogRestartDelta !== 1) {
      context.addIssue({
        code: "custom",
        path: ["watchdogRestartDelta"],
        message: "restart-attempt must reserve exactly one watchdog restart",
      })
    }
    if (value.budgetBefore.maximum !== value.budgetAfter.maximum) {
      context.addIssue({
        code: "custom",
        path: ["budgetAfter", "maximum"],
        message: "A recovery decision cannot change the restart budget maximum",
      })
    }
    const destructive =
      value.action === "cancel" || value.action === "restart-attempt" || value.action === "stop-run"
    if (value.gracefulCancelFirst !== destructive || value.forceKillAfterGrace !== destructive) {
      context.addIssue({
        code: "custom",
        path: ["gracefulCancelFirst"],
        message: "Destructive recovery actions must cancel gracefully before force",
      })
    }
  })
export type WatchdogRecoveryDecision = z.infer<typeof WatchdogRecoveryDecisionSchema>

export const WatchdogEvaluationSchema = z
  .object({
    schemaVersion: z.literal(1),
    previousSnapshot: WatchdogSnapshotSchema.optional(),
    effectiveProfile: WatchdogPhaseProfileSchema,
    snapshot: WatchdogSnapshotSchema,
    decision: WatchdogRecoveryDecisionSchema,
    nextBudget: WatchdogOperationalBudgetSchema,
    diagnostics: z.array(DiagnosticSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.snapshot.phase !== value.decision.phase ||
      value.snapshot.state !== value.decision.state
    ) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "The recovery decision must bind the evaluated snapshot state and phase",
      })
    }
    if (value.effectiveProfile.maxRestarts !== value.decision.budgetAfter.maximum) {
      context.addIssue({
        code: "custom",
        path: ["decision", "budgetAfter", "maximum"],
        message: "The recovery budget maximum must come from the effective phase profile",
      })
    }
    if (value.nextBudget.watchdogRestarts !== value.decision.budgetAfter.used) {
      context.addIssue({
        code: "custom",
        path: ["nextBudget", "watchdogRestarts"],
        message: "nextBudget must match the restart reservation in the decision",
      })
    }
  })
export type WatchdogEvaluation = z.infer<typeof WatchdogEvaluationSchema>

export const WATCHDOG_STATE_TRANSITIONS: Readonly<Record<WatchdogState, readonly WatchdogState[]>> =
  {
    healthy: ["healthy", "quiet", "slow", "suspect", "stalled"],
    quiet: ["healthy", "quiet", "slow", "suspect", "stalled", "recovered"],
    slow: ["healthy", "quiet", "slow", "suspect", "stalled", "recovered"],
    suspect: ["suspect", "stalled", "recovered"],
    stalled: ["stalled", "recovered"],
    recovered: ["healthy", "quiet", "slow", "suspect", "stalled", "recovered"],
  }

export function canTransitionWatchdogState(from: WatchdogState, to: WatchdogState): boolean {
  return WATCHDOG_STATE_TRANSITIONS[from].includes(to)
}
