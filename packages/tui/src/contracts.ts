export type UiPrimitive = string | number | boolean | null

export type EvaluationFieldKind =
  | "boolean"
  | "integer"
  | "json"
  | "number"
  | "select"
  | "string"
  | "string-list"

export interface EvaluationFieldChoice<TValue extends UiPrimitive = UiPrimitive> {
  readonly label: string
  readonly value: TValue
  readonly description?: string
}

/**
 * Framework-neutral metadata consumed by the read-only evaluation popup.
 * The CLI may adapt its own versioned form metadata to this small structural port.
 */
export interface EvaluationFieldMetadata<TValue = unknown> {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly kind: EvaluationFieldKind | (string & {})
  readonly configPath?: string
  readonly cliFlag?: string
  readonly required?: boolean
  readonly secret?: boolean
  readonly defaultValue?: TValue
  readonly choices?: readonly EvaluationFieldChoice[]
  readonly visibleWhen?: {
    readonly fieldId: string
    readonly equals: UiPrimitive | readonly UiPrimitive[]
  }
}

export interface EvaluationFormMetadata {
  readonly schemaVersion: number
  readonly formId: string
  readonly fields: readonly EvaluationFieldMetadata[]
}

export interface RunUiEntry {
  readonly timestamp?: string
  readonly type?: string
  readonly level?: string
  readonly message: string
}

/**
 * Structural scan cursor used at the TUI boundary. `streamId` identifies the
 * ordered transport/ledger feed, not an individual event's producer stream.
 * The package deliberately does not import concrete telemetry or persistence.
 */
export interface RunUiEventCursor {
  readonly schemaVersion: 1
  readonly streamId: string
  readonly sequence: number
}

export type RunUiConnectionPhase =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "disconnected"
  | "replay"
  | "closed"

/** Display-pressure counters are explicit so coalescing is never invisible. */
export interface RunUiStreamMetrics {
  readonly receivedEvents: number
  readonly appliedEvents: number
  readonly duplicateEvents: number
  readonly staleEvents: number
  readonly coalescedDisplayEvents: number
  readonly droppedDisplayEvents: number
  readonly droppedDisplayCharacters: number
  readonly protocolErrors: number
  readonly reconnects: number
  readonly renderFlushes: number
}

export interface RunUiConnection {
  readonly phase: RunUiConnectionPhase
  readonly cursor: RunUiEventCursor | null
  readonly reconnectAttempt: number
  readonly connectedAt: string | null
  readonly disconnectedAt: string | null
  readonly lastEventAt: string | null
  readonly lastHeartbeatAt: string | null
  readonly lastSnapshotAt: string | null
  readonly nextRetryAt: string | null
  readonly reason: string | null
  readonly metrics: RunUiStreamMetrics
}

export interface RunUiTask {
  readonly id: string
  readonly title: string
  readonly status: string
  /** Durable run that owns this task (root or a pre-authored child run). */
  readonly runId?: string
  readonly attempt?: number
  readonly detail?: string
}

export interface RunUiTaskTreeEntry extends RunUiTask {
  /** Zero for root PRD tasks; child runs add deeper entries in S09. */
  readonly depth: number
  readonly documentId?: string
  readonly parentRunId?: string
}

export interface RunUiProgress {
  readonly completed: number
  readonly total: number
}

export interface RunUiCost {
  readonly amount: number
  readonly currency: string
  readonly source?: string
}

/** A role-specific usage record. Missing values are never inferred by the TUI. */
export interface RunUiUsage {
  readonly available: boolean
  readonly source: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cost?: RunUiCost
  readonly note?: string
}

/** Replay-safe per-call accumulator used to keep live usage honest. */
export interface RunUiUsageCall {
  readonly callId: string
  readonly role: "executor" | "judge" | "child" | "tool-model"
  readonly source: string
  readonly semantics: "delta" | "cumulative" | "final"
  readonly settled: boolean
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly cost?: RunUiCost
}

export interface RunUiJudgeFeedback {
  readonly adequate: readonly string[]
  readonly problems: readonly string[]
  readonly missing: readonly string[]
  readonly recommendations: readonly string[]
}

export interface RunUiJudge {
  readonly mode: string
  readonly profile?: string
  readonly score?: number | null
  readonly threshold?: number
  readonly revisionAttempt: number
  readonly maxRevisionAttempts: number
  readonly decision?: string
  readonly summary?: string
  readonly feedback: RunUiJudgeFeedback
}

export interface RunUiRuntimeStatus {
  readonly phase: string
  readonly attempt: number
  readonly modelCalls: number
  readonly toolCalls: number
  readonly gateRuns: number
  readonly elapsedMs?: number
}

export interface RunUiToolStatus {
  readonly callId: string
  readonly name: string
  readonly status: string
  readonly timestamp?: string
  readonly durationMs?: number
  readonly taskId?: string
  readonly attemptId?: string
  readonly preview?: string
}

export interface RunUiGateStatus {
  readonly id: string
  readonly status: string
  readonly timestamp?: string
  readonly category?: string
  readonly blocking?: boolean
  readonly durationMs?: number
  readonly attempts?: number
  readonly taskId?: string
  readonly attemptId?: string
  readonly reason?: string
}

export interface RunUiWatchdogSignal {
  readonly name: string
  readonly verdict: string
  readonly reason?: string
  readonly ageMs?: number
}

export interface RunUiWatchdogStatus {
  readonly enabled: boolean
  readonly state: string
  readonly phase?: string
  readonly observedAt?: string
  readonly lastProgressAt?: string
  readonly action?: string
  readonly reasons: readonly string[]
  readonly restartUsed: number
  readonly restartMaximum?: number
  readonly signals: readonly RunUiWatchdogSignal[]
}

export interface RunUiErrorDetail {
  readonly timestamp?: string
  readonly code?: string
  readonly origin?: string
  readonly message: string
  readonly taskId?: string
  readonly attemptId?: string
  readonly suggestedAction?: string
}

export interface RunUiErrors {
  readonly count: number
  readonly last?: RunUiErrorDetail
}

/**
 * One independently observable root/child run. Aggregate progress remains on
 * `RunUiSnapshot.progress`; this projection prevents a child from disappearing
 * inside that aggregate and keeps its usage/watchdog/error provenance intact.
 */
export interface RunUiScopeProjection {
  readonly runId: string
  readonly kind: "root" | "child"
  readonly depth: number
  readonly parentRunId?: string
  readonly title: string
  readonly status: string
  readonly currentTask: RunUiTask | null
  readonly progress: RunUiProgress
  readonly usage: {
    readonly combined: RunUiUsage
    readonly executor: RunUiUsage
    readonly judge: RunUiUsage
  }
  /** Bounded internal call state used to keep live scope totals cumulative. */
  readonly usageCalls?: Readonly<Record<string, RunUiUsageCall>>
  readonly runtime: RunUiRuntimeStatus
  readonly watchdog: RunUiWatchdogStatus
  readonly errors: RunUiErrors
}

/**
 * Complete, read-only projection expected by the dashboard. It intentionally
 * contains no persistence handles or engine objects.
 */
export interface RunUiSnapshot {
  readonly runId: string
  readonly title: string
  readonly status: string
  readonly currentTask: RunUiTask | null
  readonly progress: RunUiProgress
  readonly usage: {
    /** Combined usage is unavailable whenever an active role did not report usage. */
    readonly combined: RunUiUsage
    readonly executor: RunUiUsage
    readonly judge: RunUiUsage
  }
  /** Internal replay projection; observers may ignore it. */
  readonly usageCalls?: Readonly<Record<string, RunUiUsageCall>>
  readonly activity: readonly RunUiEntry[]
  readonly logs: readonly RunUiEntry[]
  readonly events: readonly RunUiEntry[]
  readonly engineOutput: readonly string[]
  /** Bounded lines read from authoritative persisted raw captures. */
  readonly rawEngineOutput?: readonly string[]
  /** Raw refs successfully resolved while producing the bounded view. */
  readonly rawEngineRefs?: readonly string[]
  readonly judge: RunUiJudge
  /** Rich operational projections remain optional for older replay snapshots. */
  readonly runtime?: RunUiRuntimeStatus
  readonly taskTree?: readonly RunUiTaskTreeEntry[]
  /** Root plus each pre-authored child run, in deterministic tree order. */
  readonly scopes?: readonly RunUiScopeProjection[]
  readonly tools?: readonly RunUiToolStatus[]
  /** Unique durable tool identities used for live counters beyond visible retention. */
  readonly observedToolCallIds?: readonly string[]
  readonly gates?: readonly RunUiGateStatus[]
  readonly watchdog?: RunUiWatchdogStatus
  readonly errorsSummary?: RunUiErrors
  readonly evaluationValues: Readonly<Record<string, unknown>>
  /** Human-readable EffectiveRunOptions provenance keyed by evaluation field ID. */
  readonly evaluationOrigins: Readonly<Record<string, string>>
  /**
   * Optional for compatibility with the original polling source. Incremental
   * sources always populate this field.
   */
  readonly connection?: RunUiConnection
}

export interface RunUiSource {
  getSnapshot(): RunUiSnapshot
  subscribe(listener: (snapshot: RunUiSnapshot) => void): () => void
}
