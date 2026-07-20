import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import {
  type CredentialCatalogHandle,
  type CredentialCommandService,
  evaluationFormMetadata,
  inheritableRoleProfileFormField,
  type RunControlCommandService,
  type RunUiCommandRequest,
  type RunUiCommandResult,
  type RunUiCommandService,
  resolveRuntimeProfiles,
  roleProfileFormMetadata,
  type SettingsFieldMetadata,
  type SettingsPreRunInvocation,
} from "@ralph-next/commands"
import {
  type ChildUsageSummary,
  DEFAULT_CONFIG,
  type EffectiveRunOptions,
  type EffectiveValue,
  type EvidenceUsage,
  type RoleProfileConfig,
  type RoleProfileConfigLayer,
  RoleProfileConfigSchema,
} from "@ralph-next/domain"
import {
  getRun,
  getRunReport,
  listAttempts,
  listChildRunTree,
  listGateResults,
  listJudgeAssessments,
  listRunTasks,
  listToolCalls,
  loadEffectiveConfig,
  readChildRunTreeAggregate,
  readConfigTransferLayer,
  readEventBatch,
  readEventHighWater,
  readRunEventBatch,
  workspaceLayout,
} from "@ralph-next/persistence"
import type { ModelCatalog, ProviderInfo } from "@ralph-next/providers"
import {
  type EventEnvelope,
  ingestUsageEvent,
  RawStreamRecordSchema,
  TokenUsageAggregator,
  type UsageAggregate,
  type UsageBreakdown,
} from "@ralph-next/telemetry"
import {
  createEmptyRunUiSnapshot,
  createProviderPaletteController,
  type ProviderPaletteMode,
  type ProviderPalettePort,
  type ProviderPaletteProfileForm,
  type ProviderPaletteRole,
  type ProviderPaletteScope,
  type ProviderPaletteSelection,
  projectRunUiEvent,
  type RunUiEntry,
  type RunUiEventCursor,
  type RunUiEventEnvelope,
  RunUiEventStore,
  RunUiFollowClient,
  type RunUiFollowFrame,
  type RunUiFollowRequest,
  type RunUiFollowTransport,
  type RunUiScopeProjection,
  type RunUiSnapshot,
  type RunUiSource,
  type RunUiUsage,
  renderRunDashboard,
  resolveRalphTuiLocale,
  resolveRalphTuiTheme,
  truncateDisplayWidth,
  tuiText,
} from "@ralph-next/tui"
import {
  applyProfileFormFieldValue,
  clearProfileFormField,
  createProfileFormState,
  decodeProfileFormFieldText,
  displayProfileFormValue,
  inheritProfileFormField,
  type ProfileFormState,
  parseProfileFormLayer,
  parseProfileFormState,
  profileFormFieldMode,
  profileFormFieldPath,
  profileFormFieldValue,
  profileFormFieldVisible,
} from "./profile-form-model"
import {
  createRalphTuiSettingsController,
  type RalphTuiSettingsApplyResult,
  type RalphTuiSettingsController,
} from "./tui-settings"

const EVENT_POLL_INTERVAL_MS = 250
const EVENT_HEARTBEAT_INTERVAL_MS = 4_000
const EVENT_BATCH_SIZE = 256
const MAX_VISIBLE_EVENTS = 80
const MAX_ENGINE_LINES = 120
const MAX_VISIBLE_USAGE_CALLS = 512
const MAX_RAW_CAPTURE_REFS = 32
const MAX_RAW_CAPTURE_BYTES_PER_REF = 64 * 1024
const MAX_AD_HOC_TITLE_WIDTH = 80

function adHocRunTitle(run: ReturnType<typeof getRun>): string | undefined {
  if (run?.source?.kind !== "ad-hoc") return undefined
  const singleLine = Array.from(run.source.description, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)
      ? " "
      : character
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
  return truncateDisplayWidth(singleLine || "Ad-hoc request", MAX_AD_HOC_TITLE_WIDTH)
}

async function tuiPresentation(workspaceRoot: string) {
  const layout = workspaceLayout(workspaceRoot)
  const effectiveConfig = await loadEffectiveConfig({
    workspaceConfig: layout.config,
    environment: process.env,
  })
  const configuredTui = effectiveConfig.config.tui
  return {
    ascii:
      process.env.RALPH_TUI_ASCII === "1"
        ? true
        : process.env.RALPH_TUI_ASCII === "0"
          ? false
          : configuredTui.ascii,
    theme: resolveRalphTuiTheme(
      process.env.RALPH_TUI_THEME ?? configuredTui.theme,
      process.env.NO_COLOR !== undefined,
      process.env,
    ),
    keybindings: configuredTui.keybindings,
    locale: resolveRalphTuiLocale(effectiveConfig.config.defaults.lang),
  }
}

function settingsApplyResult(value: unknown): RalphTuiSettingsApplyResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  if (Reflect.get(value, "effect") !== "new-run-draft-only") return undefined
  const invocation = Reflect.get(value, "invocation")
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) return undefined
  if (Reflect.get(invocation, "schemaVersion") !== 1) return undefined
  return value as RalphTuiSettingsApplyResult
}

function mergeSettingsInvocation(
  initial: SettingsPreRunInvocation,
  draft: SettingsPreRunInvocation,
): SettingsPreRunInvocation {
  return {
    schemaVersion: 1,
    runOptions: { ...initial.runOptions, ...draft.runOptions },
    ...(draft.prd !== undefined
      ? { prd: draft.prd }
      : initial.prd !== undefined
        ? { prd: initial.prd }
        : {}),
    ...(draft.ui !== undefined
      ? { ui: draft.ui }
      : initial.ui !== undefined
        ? { ui: initial.ui }
        : {}),
    ...(draft.lang !== undefined
      ? { lang: draft.lang }
      : initial.lang !== undefined
        ? { lang: initial.lang }
        : {}),
    cliArguments: [...initial.cliArguments, ...draft.cliArguments],
  }
}

function persistedSettingsInvocation(
  options: EffectiveRunOptions,
  prd?: string,
): SettingsPreRunInvocation {
  return {
    schemaVersion: 1,
    ...(prd !== undefined ? { prd } : {}),
    cliArguments: [],
    runOptions: {
      mode: options.mode.value,
      executorProfile: options.executorProfile.value,
      ...(options.judgeProfile ? { judgeProfile: options.judgeProfile.value } : {}),
      ...(options.executorProvider ? { executorProvider: options.executorProvider.value } : {}),
      ...(options.executorModel ? { executorModel: options.executorModel.value } : {}),
      ...(options.executorCredential
        ? { executorCredential: options.executorCredential.value }
        : {}),
      ...(options.executorVariant ? { executorVariant: options.executorVariant.value } : {}),
      ...(options.executorParameters
        ? { executorParameters: options.executorParameters.value }
        : {}),
      ...(options.judgeProvider ? { judgeProvider: options.judgeProvider.value } : {}),
      ...(options.judgeModel ? { judgeModel: options.judgeModel.value } : {}),
      ...(options.judgeCredential ? { judgeCredential: options.judgeCredential.value } : {}),
      ...(options.judgeVariant ? { judgeVariant: options.judgeVariant.value } : {}),
      ...(options.judgeParameters ? { judgeParameters: options.judgeParameters.value } : {}),
      task: options.task.value,
      force: options.force.value,
      dryRun: options.dryRun.value,
      skipTests: options.skipTests.value,
      skipLint: options.skipLint.value,
      skipGates: options.skipGates.value,
      noGates: options.noGates.value,
      fast: options.fast.value,
      noCommit: options.noCommit.value,
      failFast: options.failFast.value,
      maxTasks: options.maxTasks.value,
      delayMs: options.delayMs.value,
      maxIterations: options.maxIterations.value,
      maxModelCallsPerAttempt: options.maxModelCallsPerAttempt.value,
      maxNoChangeAttempts: options.maxNoChangeAttempts.value,
      noChangePolicy: options.noChangePolicy.value,
      evaluationMode: options.evaluationMode.value,
      judgeThreshold: options.judgeThreshold.value,
      maxRevisionAttempts: options.maxRevisionAttempts.value,
      judgeCallRetries: options.judgeCallRetries.value,
      judgeUnavailablePolicy: options.judgeUnavailablePolicy.value,
      blockingJudgeSeverities: options.blockingJudgeSeverities.value,
      ...(options.judgeRubric ? { judgeRubric: options.judgeRubric.value } : {}),
      judgeExhaustedPolicy: options.judgeExhaustedPolicy.value,
      securityMode: options.securityMode.value,
      headlessAsk: options.headlessAsk.value,
      toolRules: options.toolRules.value,
      allowedCommands: options.allowedCommands.value,
      readPaths: options.readPaths.value,
      writePaths: options.writePaths.value,
      allowShell: options.allowShell.value,
    },
  }
}

function persistedSettingsOrigins(
  options: EffectiveRunOptions,
): Readonly<Record<string, { readonly source: string; readonly sourceRef?: string }>> {
  const pairs: readonly [
    string,
    { readonly source: string; readonly sourceRef?: string | undefined } | undefined,
  ][] = [
    ["defaultMode", options.mode],
    ["executorProfile", options.executorProfile],
    ["judgeProfile", options.judgeProfile],
    ["executorProvider", options.executorProvider],
    ["executorModel", options.executorModel],
    ["executorCredential", options.executorCredential],
    ["executorVariant", options.executorVariant],
    ["executorParameters", options.executorParameters],
    ["judgeProvider", options.judgeProvider],
    ["judgeModel", options.judgeModel],
    ["judgeCredential", options.judgeCredential],
    ["judgeVariant", options.judgeVariant],
    ["judgeParameters", options.judgeParameters],
    ["task", options.task],
    ["force", options.force],
    ["dryRun", options.dryRun],
    ["skipTests", options.skipTests],
    ["skipLint", options.skipLint],
    ["skipGates", options.skipGates],
    ["noGates", options.noGates],
    ["fast", options.fast],
    ["noCommit", options.noCommit],
    ["failFast", options.failFast],
    ["maxTasks", options.maxTasks],
    ["retryDelaySeconds", options.delayMs],
    ["maxIterations", options.maxIterations],
    ["maxModelCalls", options.maxModelCallsPerAttempt],
    ["noChangeMaxAttempts", options.maxNoChangeAttempts],
    ["noChangePolicy", options.noChangePolicy],
    ["evaluationMode", options.evaluationMode],
    ["judgeThreshold", options.judgeThreshold],
    ["maxRevisionAttempts", options.maxRevisionAttempts],
    ["judgeCallRetries", options.judgeCallRetries],
    ["judgeUnavailablePolicy", options.judgeUnavailablePolicy],
    ["blockingJudgeSeverities", options.blockingJudgeSeverities],
    ["judgeRubric", options.judgeRubric],
    ["judgeExhaustedPolicy", options.judgeExhaustedPolicy],
    ["securityMode", options.securityMode],
    ["headlessAsk", options.headlessAsk],
    ["toolRules", options.toolRules],
    ["allowedCommands", options.allowedCommands],
    ["readPaths", options.readPaths],
    ["writePaths", options.writePaths],
    ["allowShell", options.allowShell],
  ]
  return Object.fromEntries(
    pairs.flatMap(([fieldId, option]) =>
      option
        ? [
            [
              fieldId,
              {
                source: option.source,
                ...(option.sourceRef ? { sourceRef: option.sourceRef } : {}),
              },
            ] as const,
          ]
        : [],
    ),
  )
}

function usageView(usage: EvidenceUsage): RunUiUsage {
  if (usage.source === "unavailable") {
    return {
      available: false,
      source: usage.source,
      note:
        usage.providerCallCount > 0
          ? `${usage.providerCallCount} call(s) without comparable reported usage`
          : "no provider call usage was reported",
    }
  }
  return {
    available: true,
    source: usage.source,
    ...(usage.input !== undefined ? { inputTokens: usage.input } : {}),
    ...(usage.output !== undefined ? { outputTokens: usage.output } : {}),
    ...(usage.total !== undefined ? { totalTokens: usage.total } : {}),
    ...(usage.cost
      ? {
          cost: {
            amount: usage.cost.amount,
            currency: usage.cost.currency,
            source: usage.cost.source ?? usage.source,
          },
        }
      : {}),
    note: `${usage.providerCallCount} provider call(s)`,
  }
}

function aggregateUsageView(usage: UsageAggregate | undefined, role: string): RunUiUsage {
  if (!usage || usage.availability === "unavailable") {
    return {
      available: false,
      source: usage?.source ?? "unavailable",
      note: usage
        ? `${role}: ${usage.callCount} call(s); ${usage.unavailableCalls} without comparable usage`
        : `${role}: no durable usage calls`,
    }
  }
  return {
    available: true,
    source: usage.source,
    ...(usage.input !== undefined ? { inputTokens: usage.input } : {}),
    ...(usage.output !== undefined ? { outputTokens: usage.output } : {}),
    ...(usage.total !== undefined ? { totalTokens: usage.total } : {}),
    ...(usage.cost
      ? {
          cost: {
            amount: usage.cost.amount,
            currency: usage.cost.currency,
            source: usage.cost.source,
          },
        }
      : {}),
    note: `${role}: ${usage.availability}; calls=${usage.callCount}; settled=${usage.settledCalls}; unavailable=${usage.unavailableCalls}`,
  }
}

function childUsageView(usage: ChildUsageSummary, role: string): RunUiUsage {
  if (!usage.available) {
    return { available: false, source: usage.source, note: `${role}: child usage unavailable` }
  }
  return {
    available: true,
    source: usage.source,
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(usage.cost
      ? {
          cost: {
            amount: usage.cost.amount,
            currency: usage.cost.currency,
            source: usage.cost.source ?? usage.source,
          },
        }
      : {}),
    note: `${role}: aggregated from durable child observations`,
  }
}

function mergeUsageViews(
  root: RunUiUsage,
  child: RunUiUsage,
  role: string,
  rootHasCalls: boolean,
): RunUiUsage {
  if (!rootHasCalls) return child
  if (!root.available || !child.available) {
    return {
      available: false,
      source: "root+child:partial-unavailable",
      note: `${role}: at least one scope has unavailable usage`,
    }
  }
  const sum = (left: number | undefined, right: number | undefined): number | undefined =>
    left !== undefined && right !== undefined ? left + right : undefined
  const inputTokens = sum(root.inputTokens, child.inputTokens)
  const outputTokens = sum(root.outputTokens, child.outputTokens)
  const totalTokens = sum(root.totalTokens, child.totalTokens)
  const cost =
    root.cost && child.cost && root.cost.currency === child.cost.currency
      ? {
          amount: root.cost.amount + child.cost.amount,
          currency: root.cost.currency,
          source: "root+child:sum",
        }
      : undefined
  return {
    available: true,
    source: "root+child",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cost ? { cost } : {}),
    note: `${role}: root and child scopes`,
  }
}

function eventMessage(event: EventEnvelope): string {
  const payload = event.payload
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const key of ["message", "reason", "status", "policy", "outcome"] as const) {
      const value = payload[key]
      if (typeof value === "string" && value.trim().length > 0) return value
    }
  }
  return event.type
}

function eventEntry(event: EventEnvelope): RunUiEntry {
  return {
    timestamp: event.timestamp,
    type: event.type,
    level: event.level,
    message: eventMessage(event),
  }
}

function engineDelta(event: EventEnvelope): string | undefined {
  const displayable =
    event.type === "model.text.delta" ||
    event.type === "model.reasoning.delta" ||
    event.type === "model.tool.input.delta" ||
    event.type === "model.text.completed" ||
    event.type === "external.cli.output.delta" ||
    event.type === "external.cli.output.completed" ||
    event.type === "tool.output.delta" ||
    event.type === "tool.output.completed" ||
    event.type === "gate.output.delta" ||
    event.type.startsWith("judge.backend.") ||
    event.type.startsWith("executor.backend.")
  if (!displayable) return undefined
  const payload = event.payload
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined
  for (const key of ["delta", "text", "output"] as const) {
    const value = payload[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function feedbackProblems(
  problems: readonly { severity: string; criterion?: string | undefined; message: string }[],
): string[] {
  return problems.map(
    (problem) =>
      `[${problem.severity}]${problem.criterion ? ` ${problem.criterion}:` : ""} ${problem.message}`,
  )
}

function effectiveOptionOrigin(option: unknown): string {
  if (!option || typeof option !== "object" || Array.isArray(option)) return "unavailable"
  const source = Reflect.get(option, "source")
  if (typeof source !== "string" || source.length === 0) return "unavailable"
  const sourceRef = Reflect.get(option, "sourceRef")
  return typeof sourceRef === "string" && sourceRef.length > 0 ? `${source} (${sourceRef})` : source
}

interface RunUiSnapshotState {
  readonly snapshot: RunUiSnapshot
  readonly cursor: RunUiEventCursor
  /** Last observed byte per authoritative capture; never exposed to the renderer. */
  readonly rawCaptureOffsets: ReadonlyMap<string, number>
}

type ScopedTask = ReturnType<typeof listRunTasks>[number] & {
  readonly scopeRunId: string
  readonly depth: number
  readonly parentRunId?: string
}
type AttemptRecord = ReturnType<typeof listAttempts>[number]

const CURRENT_TASK_PRIORITY: Readonly<Record<string, number>> = {
  evaluating: 0,
  verifying: 0,
  active: 0,
  interrupted: 1,
  retryable_failed: 2,
  eligible: 3,
  pending: 4,
  blocked: 5,
}

function selectCurrentTask(tasks: readonly ScopedTask[]): ScopedTask | undefined {
  return [...tasks]
    .filter((task) => CURRENT_TASK_PRIORITY[task.status] !== undefined)
    .sort((left, right) => {
      const priority =
        (CURRENT_TASK_PRIORITY[left.status] ?? Number.MAX_SAFE_INTEGER) -
        (CURRENT_TASK_PRIORITY[right.status] ?? Number.MAX_SAFE_INTEGER)
      if (priority !== 0) return priority
      const activeAttempt =
        Number(Boolean(right.activeAttemptId)) - Number(Boolean(left.activeAttemptId))
      if (activeAttempt !== 0) return activeAttempt
      if (left.depth !== right.depth) return right.depth - left.depth
      if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt)
      return (
        left.scopeRunId.localeCompare(right.scopeRunId) ||
        left.documentId.localeCompare(right.documentId) ||
        left.taskId.localeCompare(right.taskId)
      )
    })[0]
}

function latestAttemptForTask(
  task: ScopedTask | undefined,
  attempts: readonly AttemptRecord[],
): AttemptRecord | undefined {
  if (!task) return undefined
  if (task.activeAttemptId) {
    const active = attempts.find(
      (attempt) => attempt.runId === task.scopeRunId && attempt.id === task.activeAttemptId,
    )
    if (active) return active
  }
  return attempts
    .filter(
      (attempt) =>
        attempt.runId === task.scopeRunId &&
        attempt.documentId === task.documentId &&
        attempt.taskId === task.taskId,
    )
    .sort(
      (left, right) =>
        left.ordinal - right.ordinal ||
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.id.localeCompare(right.id),
    )
    .at(-1)
}

function boundedBySequence<T extends { readonly sequence: number }>(
  values: readonly T[],
  value: T,
  limit: number,
): T[] {
  return [...values, value]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-Math.max(1, limit))
}

function addRawReference(output: Set<string>, value: unknown): void {
  if (output.size >= MAX_RAW_CAPTURE_REFS) return
  if (typeof value === "string" && value.length > 0) output.add(value)
}

function addRawReferenceList(output: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return
  for (const reference of value) {
    addRawReference(output, reference)
    if (output.size >= MAX_RAW_CAPTURE_REFS) return
  }
}

function rawReferenceRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Reads only contract-owned reference slots from an event that belongs to the
 * attached root/child scope. Model/tool payload content is intentionally not
 * traversed: arbitrary nested JSON is not authority to select a raw capture.
 */
function trustedEventRawReferences(
  event: EventEnvelope,
  allowedRunIds: ReadonlySet<string>,
): readonly string[] {
  if (!event.runId || !allowedRunIds.has(event.runId)) return []
  const output = new Set<string>()
  const payload = event.payload as Record<string, unknown>

  if (event.type.startsWith("model.")) {
    addRawReference(output, payload.rawRef)
    const usage = rawReferenceRecord(payload.usage)
    if (usage) {
      addRawReference(output, usage.providerRawRef)
      addRawReferenceList(output, usage.providerRawRefs)
    }
  }

  if (event.type.startsWith("judge.backend.")) {
    addRawReference(output, payload.providerRawRef)
    addRawReference(output, payload.rawRef)
    addRawReferenceList(output, payload.outputRefs)
    const usage = rawReferenceRecord(payload.usage)
    if (usage) {
      addRawReference(output, usage.providerRawRef)
      addRawReferenceList(output, usage.providerRawRefs)
    }
  }

  if (
    event.type === "external.cli.settled" ||
    event.type === "judge.external.settled" ||
    event.type === "tool.call.settled"
  ) {
    addRawReferenceList(output, payload.outputRefs)
  }

  if (event.type === "judge.assessment.persisted") {
    const assessment = rawReferenceRecord(payload.assessment)
    if (assessment) addRawReference(output, assessment.rawResponseRef)
  }

  return [...output]
}

function setBoundedRawCaptureOffset(
  offsets: Map<string, number>,
  reference: string,
  offset: number,
): void {
  // Map insertion order is the LRU order. A hit is moved to the newest slot,
  // and eviction is deterministic because the oldest key is always first.
  offsets.delete(reference)
  offsets.set(reference, offset)
  while (offsets.size > MAX_RAW_CAPTURE_REFS) {
    const oldest = offsets.keys().next().value as string | undefined
    if (oldest === undefined) break
    offsets.delete(oldest)
  }
}

interface ScopeDescriptor {
  readonly runId: string
  readonly depth: number
  readonly parentRunId?: string
}

interface HistoryScan {
  readonly recentEvents: readonly EventEnvelope[]
  readonly engineOutput: readonly string[]
  readonly scopeProjection: ReadonlyMap<string, RunUiSnapshot>
  readonly usage: ReadonlyMap<string, UsageBreakdown>
  readonly rawRefs: readonly string[]
  readonly revisionMaximumByTask: ReadonlyMap<string, number>
}

function taskScopeKey(runId: string, documentId: string, taskId: string): string {
  return `${runId}\u0000${documentId}\u0000${taskId}`
}

function scanRunUiHistory(
  ledger: string,
  scopes: readonly ScopeDescriptor[],
  throughSequence: number,
): HistoryScan {
  let recentEvents: readonly EventEnvelope[] = []
  let engineLines: readonly { readonly sequence: number; readonly text: string }[] = []
  const scopeProjection = new Map<string, RunUiSnapshot>()
  const usageAggregators = new Map<string, TokenUsageAggregator>()
  const rawRefSequence = new Map<string, number>()
  const revisionMaximumByTask = new Map<string, number>()
  const allowedRawRunIds = new Set(scopes.map((scope) => scope.runId))

  for (const scope of scopes) {
    let projection = createEmptyRunUiSnapshot(scope.runId)
    const usage = new TokenUsageAggregator(scope.runId)
    let afterSequence = 0
    while (afterSequence < throughSequence) {
      const page = readRunEventBatch(ledger, {
        runId: scope.runId,
        afterSequence,
        throughSequence,
        limit: EVENT_BATCH_SIZE,
      })
      for (const event of page.events) {
        if (event.type === "child.event.projected") continue
        ingestUsageEvent(usage, event, scope.runId)
        projection = projectRunUiEvent(projection, event as RunUiEventEnvelope)
        recentEvents = boundedBySequence(recentEvents, event, MAX_VISIBLE_EVENTS)
        const delta = engineDelta(event)
        if (delta !== undefined) {
          engineLines = boundedBySequence(
            engineLines,
            { sequence: event.sequence, text: delta },
            MAX_ENGINE_LINES,
          )
        }
        for (const reference of trustedEventRawReferences(event, allowedRawRunIds)) {
          rawRefSequence.delete(reference)
          rawRefSequence.set(reference, event.sequence)
          while (rawRefSequence.size > MAX_RAW_CAPTURE_REFS) {
            const oldest = rawRefSequence.keys().next().value as string | undefined
            if (!oldest) break
            rawRefSequence.delete(oldest)
          }
        }
        if (
          event.type === "evaluation.revisions.extended" &&
          event.documentId &&
          event.taskId &&
          typeof event.payload.effectiveMaximum === "number" &&
          Number.isSafeInteger(event.payload.effectiveMaximum) &&
          event.payload.effectiveMaximum >= 0
        ) {
          revisionMaximumByTask.set(
            taskScopeKey(scope.runId, event.documentId, event.taskId),
            event.payload.effectiveMaximum,
          )
        }
      }
      if (page.exhausted) break
      if (page.cursorSequence <= afterSequence) {
        throw new Error(
          `Run event bootstrap cursor did not advance for ${scope.runId}: ${afterSequence}`,
        )
      }
      afterSequence = page.cursorSequence
    }
    scopeProjection.set(scope.runId, projection)
    usageAggregators.set(scope.runId, usage)
  }

  return {
    recentEvents,
    engineOutput: engineLines.map((entry) => entry.text),
    scopeProjection,
    usage: new Map(
      [...usageAggregators].map(([scopeRunId, aggregator]) => [scopeRunId, aggregator.snapshot()]),
    ),
    rawRefs: [...rawRefSequence.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([reference]) => reference),
    revisionMaximumByTask,
  }
}

interface RawCaptureWindow {
  readonly lines: readonly string[]
  readonly nextOffset: number
}

type TrustedSyncDirectoryIdentity = {
  readonly path: string
  readonly dev: number
  readonly ino: number
}

type TrustedSyncOpenFile = {
  readonly path: string
  readonly descriptor: number
  readonly initial: Stats
  readonly parent: TrustedSyncDirectoryIdentity
}

function comparableFilesystemPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLocaleLowerCase("und") : normalized
}

function sameFilesystemIdentity(
  left: Pick<Stats, "dev" | "ino">,
  right: Pick<Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** Synchronous, read-only counterpart of telemetry's trusted path binding. */
function trustedSyncDirectory(path: string): TrustedSyncDirectoryIdentity {
  const target = resolve(path)
  const before = lstatSync(target)
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Raw capture ancestry is not a trusted directory: ${target}`)
  }
  const canonical = realpathSync(target)
  const after = lstatSync(target)
  if (
    comparableFilesystemPath(canonical) !== comparableFilesystemPath(target) ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !sameFilesystemIdentity(before, after)
  ) {
    throw new Error(`Raw capture ancestry changed or traverses a link: ${target}`)
  }
  return { path: target, dev: after.dev, ino: after.ino }
}

function assertTrustedSyncDirectory(expected: TrustedSyncDirectoryIdentity): void {
  const current = trustedSyncDirectory(expected.path)
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Raw capture ancestry changed identity: ${expected.path}`)
  }
}

function openTrustedSyncRead(path: string): TrustedSyncOpenFile {
  const target = resolve(path)
  const parent = trustedSyncDirectory(dirname(target))
  const before = lstatSync(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`Raw capture is not a trusted regular file: ${target}`)
  }
  assertTrustedSyncDirectory(parent)
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
  const descriptor = openSync(target, constants.O_RDONLY | noFollow)
  try {
    const opened = fstatSync(descriptor)
    const bound = lstatSync(target)
    if (
      !opened.isFile() ||
      !bound.isFile() ||
      bound.isSymbolicLink() ||
      opened.nlink !== 1 ||
      bound.nlink !== 1 ||
      !sameFilesystemIdentity(before, opened) ||
      !sameFilesystemIdentity(opened, bound)
    ) {
      throw new Error(`Raw capture changed identity while opening: ${target}`)
    }
    assertTrustedSyncDirectory(parent)
    return { path: target, descriptor, initial: opened, parent }
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

function assertTrustedSyncRead(opened: TrustedSyncOpenFile): void {
  const descriptor = fstatSync(opened.descriptor)
  const bound = lstatSync(opened.path)
  if (
    !descriptor.isFile() ||
    !bound.isFile() ||
    bound.isSymbolicLink() ||
    descriptor.nlink !== 1 ||
    bound.nlink !== 1 ||
    !sameFilesystemIdentity(opened.initial, descriptor) ||
    !sameFilesystemIdentity(descriptor, bound) ||
    descriptor.size !== opened.initial.size ||
    descriptor.mtimeMs !== opened.initial.mtimeMs
  ) {
    throw new Error(`Raw capture changed identity while being read: ${opened.path}`)
  }
  assertTrustedSyncDirectory(opened.parent)
}

function modelCapturePath(
  ralphRoot: string,
  rawRef: string,
  allowedRunIds: ReadonlySet<string>,
): string | undefined {
  const runScoped = /^raw:model\/([A-Za-z0-9][A-Za-z0-9._-]{0,511})\/([a-f0-9]{64})\.jsonl$/.exec(
    rawRef,
  )
  const legacy = /^raw:model\/([a-f0-9]{64})\.jsonl$/.exec(rawRef)
  const runId = runScoped?.[1]
  const digest = runScoped?.[2] ?? legacy?.[1]
  if (!digest || (runId && !allowedRunIds.has(runId))) return undefined
  const rawRoot = runId
    ? join(ralphRoot, "runs", runId, "raw", "diagnostic")
    : join(ralphRoot, "raw")
  const modelRoot = join(rawRoot, "model")
  const shardRoot = join(modelRoot, digest.slice(0, 2))
  try {
    const ancestry = runId
      ? [
          ralphRoot,
          join(ralphRoot, "runs"),
          join(ralphRoot, "runs", runId),
          join(ralphRoot, "runs", runId, "raw"),
          rawRoot,
          modelRoot,
          shardRoot,
        ]
      : [ralphRoot, rawRoot, modelRoot, shardRoot]
    for (const directory of ancestry) {
      trustedSyncDirectory(directory)
    }
  } catch {
    // Stale refs and missing shards are expected in retained histories. Raw
    // projection is best-effort and must never make attach fail.
    return undefined
  }
  return join(shardRoot, `${digest}.jsonl`)
}

function processCapturePath(
  ralphRoot: string,
  rawRef: string,
  allowedRunIds: ReadonlySet<string>,
): string | undefined {
  const match =
    /^\.ralph\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,511})\/raw\/((?:diagnostic\/process\/)?process-[A-Za-z0-9._-]{1,64}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:stdout|stderr)(?:\.truncated)?\.log)$/u.exec(
      rawRef,
    )
  const runId = match?.[1]
  const rawRelative = match?.[2]
  if (!runId || !rawRelative || !allowedRunIds.has(runId)) return undefined
  const runsRoot = join(ralphRoot, "runs")
  const runRoot = join(runsRoot, runId)
  const rawRoot = join(runRoot, "raw")
  try {
    const captureDirectory = dirname(join(rawRoot, rawRelative))
    for (const directory of [ralphRoot, runsRoot, runRoot, rawRoot, captureDirectory]) {
      trustedSyncDirectory(directory)
    }
  } catch {
    return undefined
  }
  return join(rawRoot, rawRelative)
}

function rawStreamCapturePath(
  ralphRoot: string,
  rawRef: string,
  allowedRunIds: ReadonlySet<string>,
): string | undefined {
  const workspace =
    /^workspace-raw:\/\/(call|process)\/([a-f0-9]{64})\/(stream|\d{8,16}\.jsonl)$/u.exec(rawRef)
  const workspaceKind = workspace?.[1]
  const workspaceDigest = workspace?.[2]
  const workspaceSegment = workspace?.[3]
  if (workspaceKind && workspaceDigest && workspaceSegment) {
    const cacheRoot = join(ralphRoot, "cache")
    const outputRoot = join(cacheRoot, "process-output")
    const kindRoot = join(outputRoot, workspaceKind === "call" ? "calls" : "processes")
    const streamRoot = join(kindRoot, workspaceDigest)
    try {
      for (const directory of [ralphRoot, cacheRoot, outputRoot, kindRoot, streamRoot]) {
        trustedSyncDirectory(directory)
      }
      return workspaceSegment === "stream" ? streamRoot : join(streamRoot, workspaceSegment)
    } catch {
      return undefined
    }
  }
  const scoped =
    /^run-raw:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,511})\/(call|process)\/([a-f0-9]{64})\/(stream|\d{8,16}\.jsonl)$/u.exec(
      rawRef,
    )
  const legacy = /^run-raw:\/\/(call|process)\/([a-f0-9]{64})\/(stream|\d{8,16}\.jsonl)$/u.exec(
    rawRef,
  )
  const kind = scoped?.[2] ?? legacy?.[1]
  const digest = scoped?.[3] ?? legacy?.[2]
  const segment = scoped?.[4] ?? legacy?.[3]
  if (!kind || !digest || !segment) return undefined
  const scopedRunId = scoped?.[1]
  const candidateRunIds = scopedRunId
    ? allowedRunIds.has(scopedRunId)
      ? [scopedRunId]
      : []
    : [...allowedRunIds].filter((runId) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/u.test(runId))
  const runsRoot = join(ralphRoot, "runs")
  const matches: string[] = []
  for (const runId of candidateRunIds) {
    const runRoot = join(runsRoot, runId)
    const rawRoot = join(runRoot, "raw")
    const diagnosticRoot = join(rawRoot, "diagnostic")
    const kindRoot = join(diagnosticRoot, kind === "call" ? "calls" : "processes")
    const streamRoot = join(kindRoot, digest)
    try {
      for (const directory of [
        ralphRoot,
        runsRoot,
        runRoot,
        rawRoot,
        diagnosticRoot,
        kindRoot,
        streamRoot,
      ]) {
        trustedSyncDirectory(directory)
      }
      matches.push(segment === "stream" ? streamRoot : join(streamRoot, segment))
    } catch {
      // Missing retained streams are expected. Legacy unscoped refs are
      // resolved only when exactly one allowed run owns the digest.
    }
  }
  return matches.length === 1 ? matches[0] : undefined
}

function rawCapturePath(
  ralphRoot: string,
  rawRef: string,
  allowedRunIds: ReadonlySet<string>,
): string | undefined {
  return (
    modelCapturePath(ralphRoot, rawRef, allowedRunIds) ??
    processCapturePath(ralphRoot, rawRef, allowedRunIds) ??
    rawStreamCapturePath(ralphRoot, rawRef, allowedRunIds)
  )
}

function projectRawCaptureLines(rawRef: string, text: string): readonly string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
  if (!rawRef.startsWith("run-raw://") && !rawRef.startsWith("workspace-raw://")) {
    return lines.slice(-MAX_ENGINE_LINES)
  }
  const projected: string[] = []
  for (const line of lines) {
    const record = RawStreamRecordSchema.parse(JSON.parse(line))
    projected.push(...record.data.split(/\r?\n/).filter((value) => value.length > 0))
    if (record.truncated) {
      projected.push(`[ralph: persisted raw record truncated from ${record.originalBytes} bytes]`)
    }
    if (record.sourceTruncated) {
      projected.push("[ralph: source output was already truncated before persistence]")
    }
  }
  return projected.slice(-MAX_ENGINE_LINES)
}

function readRawStreamWindow(
  directory: string,
  previousSequence = 0,
): RawCaptureWindow | undefined {
  try {
    const directoryIdentity = trustedSyncDirectory(directory)
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d{8,16}\.jsonl$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    assertTrustedSyncDirectory(directoryIdentity)
    const chunks: string[] = []
    let remaining = MAX_RAW_CAPTURE_BYTES_PER_REF
    for (const name of [...entries].reverse()) {
      if (remaining <= 0) break
      const path = join(directory, name)
      const openedFile = openTrustedSyncRead(path)
      try {
        const length = Math.min(openedFile.initial.size, remaining)
        const start = openedFile.initial.size - length
        const buffer = Buffer.alloc(length)
        const bytesRead = readSync(openedFile.descriptor, buffer, 0, length, start)
        assertTrustedSyncRead(openedFile)
        let text = buffer.subarray(0, bytesRead).toString("utf8")
        if (start > 0) {
          const firstLineEnd = text.indexOf("\n")
          text = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : ""
        }
        if (text.length > 0) chunks.unshift(text)
        remaining -= bytesRead
      } finally {
        closeSync(openedFile.descriptor)
      }
    }
    let nextSequence = previousSequence
    const lines: string[] = []
    for (const line of chunks.join("").split(/\r?\n/u)) {
      if (line.length === 0) continue
      const record = RawStreamRecordSchema.parse(JSON.parse(line))
      if (record.sequence <= previousSequence) continue
      nextSequence = Math.max(nextSequence, record.sequence)
      lines.push(...record.data.split(/\r?\n/u).filter((value) => value.length > 0))
      if (record.truncated) {
        lines.push(`[ralph: persisted raw record truncated from ${record.originalBytes} bytes]`)
      }
      if (record.sourceTruncated) {
        lines.push("[ralph: source output was already truncated before persistence]")
      }
    }
    assertTrustedSyncDirectory(directoryIdentity)
    return { lines: lines.slice(-MAX_ENGINE_LINES), nextOffset: nextSequence }
  } catch {
    return undefined
  }
}

function readRawCaptureWindow(
  ralphRoot: string,
  rawRef: string,
  allowedRunIds: ReadonlySet<string>,
  previousOffset?: number,
): RawCaptureWindow | undefined {
  const path = rawCapturePath(ralphRoot, rawRef, allowedRunIds)
  if (!path) return undefined
  let openedFile: TrustedSyncOpenFile | undefined
  try {
    if (rawRef.endsWith("/stream")) {
      trustedSyncDirectory(path)
      return readRawStreamWindow(path, previousOffset)
    }
    openedFile = openTrustedSyncRead(path)
    const openedStat = openedFile.initial
    const requestedStart =
      previousOffset === undefined
        ? Math.max(0, openedStat.size - MAX_RAW_CAPTURE_BYTES_PER_REF)
        : Math.min(Math.max(0, previousOffset), openedStat.size)
    const start = Math.max(requestedStart, openedStat.size - MAX_RAW_CAPTURE_BYTES_PER_REF)
    const length = Math.max(0, openedStat.size - start)
    if (length === 0) {
      assertTrustedSyncRead(openedFile)
      return { lines: [], nextOffset: openedStat.size }
    }
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(openedFile.descriptor, buffer, 0, length, start)
    assertTrustedSyncRead(openedFile)
    let text = buffer.subarray(0, bytesRead).toString("utf8")
    if (start > 0) {
      const firstLineEnd = text.indexOf("\n")
      text = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : ""
    }
    return {
      lines: projectRawCaptureLines(rawRef, text),
      nextOffset: openedStat.size,
    }
  } catch {
    return undefined
  } finally {
    if (openedFile !== undefined) {
      try {
        closeSync(openedFile.descriptor)
      } catch {
        // The read result (or original read failure) is authoritative; a close
        // failure must not crash an otherwise read-only dashboard bootstrap.
      }
    }
  }
}

function materializeRawCaptures(
  ralphRoot: string,
  rawRefs: readonly string[],
  allowedRunIds: ReadonlySet<string>,
  previousOffsets: ReadonlyMap<string, number> = new Map(),
): {
  readonly lines: readonly string[]
  readonly offsets: ReadonlyMap<string, number>
  readonly resolvedRefs: readonly string[]
} {
  const offsets = new Map<string, number>()
  const lines: string[] = []
  const resolvedRefs: string[] = []
  for (const rawRef of rawRefs.slice(-MAX_RAW_CAPTURE_REFS)) {
    const window = readRawCaptureWindow(
      ralphRoot,
      rawRef,
      allowedRunIds,
      previousOffsets.get(rawRef),
    )
    if (!window) continue
    setBoundedRawCaptureOffset(offsets, rawRef, window.nextOffset)
    resolvedRefs.push(rawRef)
    lines.push(...window.lines)
  }
  return {
    lines: lines.slice(-MAX_ENGINE_LINES),
    offsets,
    resolvedRefs,
  }
}

function scopeUsageView(
  usage: UsageBreakdown,
  reportUsage:
    | {
        readonly combined: EvidenceUsage
        readonly executor: EvidenceUsage
        readonly judge: EvidenceUsage
      }
    | undefined,
): RunUiScopeProjection["usage"] {
  const unavailable: EvidenceUsage = {
    source: "unavailable",
    semantics: "final",
    providerRawRefs: [],
    providerCallCount: 0,
  }
  return {
    combined:
      usage.total.callCount > 0
        ? aggregateUsageView(usage.total, "combined")
        : usageView(reportUsage?.combined ?? unavailable),
    executor:
      (usage.roles.executor?.callCount ?? 0) > 0
        ? aggregateUsageView(usage.roles.executor, "executor")
        : usageView(reportUsage?.executor ?? unavailable),
    judge:
      (usage.roles.judge?.callCount ?? 0) > 0
        ? aggregateUsageView(usage.roles.judge, "judge")
        : usageView(reportUsage?.judge ?? unavailable),
  }
}

function usageCallProjection(
  scopeRunId: string,
  aggregateRunId: string,
  usage: UsageBreakdown,
  asChild: boolean,
): Readonly<Record<string, NonNullable<RunUiSnapshot["usageCalls"]>[string]>> {
  return Object.fromEntries(
    Object.values(usage.calls)
      .map((call) => {
        const role = asChild ? ("child" as const) : call.role
        const key = JSON.stringify([
          aggregateRunId,
          asChild ? scopeRunId : null,
          role,
          call.scope.attemptId ?? null,
          call.callId,
        ])
        return [
          key,
          {
            callId: call.callId,
            role,
            source: call.source,
            semantics: "final" as const,
            settled: call.settled,
            ...(call.input !== undefined ? { inputTokens: call.input } : {}),
            ...(call.output !== undefined ? { outputTokens: call.output } : {}),
            ...(call.total !== undefined ? { totalTokens: call.total } : {}),
            ...(call.cost
              ? {
                  cost: {
                    amount: call.cost.amount,
                    currency: call.cost.currency,
                    source: call.cost.source,
                  },
                }
              : {}),
          },
        ] as const
      })
      .slice(-MAX_VISIBLE_USAGE_CALLS),
  )
}

function buildRunUiSnapshotState(workspaceRoot: string, runId: string): RunUiSnapshotState {
  const layout = workspaceLayout(workspaceRoot)
  // Capture the durable high-water mark before reading materialized state.
  // Concurrent writes may make the snapshot slightly newer than this cursor,
  // but the follow feed will replay those events; no state transition is skipped.
  const snapshotHighWaterSequence = readEventHighWater(layout.ledger)
  const run = getRun(layout.ledger, runId)
  if (!run) throw new Error(`Persisted run disappeared while attached: ${runId}`)
  const childLinks = listChildRunTree(layout.ledger, runId)
  const childAggregate = readChildRunTreeAggregate(layout.ledger, runId)
  const scopes: ScopeDescriptor[] = [
    { runId, depth: 0 },
    ...childLinks.map((link) => ({
      runId: link.childRunId,
      depth: link.depth,
      parentRunId: link.parentRunId,
    })),
  ]
  const history = scanRunUiHistory(layout.ledger, scopes, snapshotHighWaterSequence)
  const tasks: ScopedTask[] = scopes.flatMap((scope) =>
    listRunTasks(layout.ledger, scope.runId).map((task) => ({
      ...task,
      scopeRunId: scope.runId,
      depth: scope.depth,
      ...(scope.parentRunId ? { parentRunId: scope.parentRunId } : {}),
    })),
  )
  const attempts = scopes.flatMap((scope) => listAttempts(layout.ledger, { runId: scope.runId }))
  const scopedUsageBreakdowns = scopes.map((scope) => ({
    scope,
    usage: history.usage.get(scope.runId) ?? new TokenUsageAggregator(scope.runId).snapshot(),
  }))
  const usageBreakdown =
    scopedUsageBreakdowns[0]?.usage ?? new TokenUsageAggregator(runId).snapshot()
  const report = getRunReport(layout.ledger, runId)?.report
  const assessments = scopes
    .flatMap((scope) => listJudgeAssessments(layout.ledger, { runId: scope.runId }))
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.assessment.id.localeCompare(right.assessment.id),
    )
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt] as const))
  const currentTask = selectCurrentTask(tasks)
  const taskAttempts = currentTask
    ? attempts
        .filter(
          (attempt) =>
            attempt.runId === currentTask.scopeRunId &&
            attempt.documentId === currentTask.documentId &&
            attempt.taskId === currentTask.taskId,
        )
        .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    : []
  const latestAttempt = latestAttemptForTask(currentTask, attempts)
  const taskAssessments = currentTask
    ? assessments.filter((record) => {
        const attempt = attemptById.get(record.attemptId)
        return (
          attempt?.runId === currentTask.scopeRunId &&
          attempt.documentId === currentTask.documentId &&
          attempt.taskId === currentTask.taskId
        )
      })
    : assessments
  const latestAssessmentRecord = taskAssessments.at(-1)
  const latestAssessment = latestAssessmentRecord?.assessment
  const latestAssessmentAttempt = latestAssessmentRecord
    ? attemptById.get(latestAssessmentRecord.attemptId)
    : undefined
  const completed = childAggregate.completed
  const baseMaximum = run.effectiveOptions.maxRevisionAttempts.value
  const revisionScope = currentTask ?? latestAssessmentAttempt
  const revisionRunId = currentTask?.scopeRunId ?? latestAssessmentAttempt?.runId ?? runId
  const maximum = revisionScope
    ? (history.revisionMaximumByTask.get(
        taskScopeKey(revisionRunId, revisionScope.documentId, revisionScope.taskId),
      ) ?? baseMaximum)
    : baseMaximum
  const optionValues = Object.fromEntries(
    evaluationFormMetadata().fields.map((field) => {
      const option = (run.effectiveOptions as unknown as Record<string, { value?: unknown }>)[
        field.effectiveOptionKey
      ]
      return [field.id, option?.value]
    }),
  )
  const optionOrigins = Object.fromEntries(
    evaluationFormMetadata().fields.map((field) => {
      const option = (run.effectiveOptions as unknown as Record<string, unknown>)[
        field.effectiveOptionKey
      ]
      return [field.id, effectiveOptionOrigin(option)]
    }),
  )
  const recentEvents = history.recentEvents
  const activity = recentEvents
    .filter(
      (event) =>
        !event.type.endsWith(".delta") &&
        event.type !== "model.usage.updated" &&
        event.type !== "judge.backend.model.usage.updated" &&
        event.type !== "watchdog.probe" &&
        event.level !== "trace",
    )
    .slice(-30)
    .map(eventEntry)
  const logs = recentEvents
    .filter((event) => event.level === "warn" || event.level === "error")
    .slice(-30)
    .map(eventEntry)
  const engineOutput = history.engineOutput
  const rawCaptures = materializeRawCaptures(
    layout.ralph,
    history.rawRefs,
    new Set(scopes.map((scope) => scope.runId)),
  )
  const unavailable: EvidenceUsage = {
    source: "unavailable",
    semantics: "final",
    providerRawRefs: [],
    providerCallCount: 0,
  }
  const judgeMode = run.effectiveOptions.evaluationMode.value
  const judgeProfile =
    judgeMode === "self"
      ? run.effectiveOptions.executorProfile.value
      : run.effectiveOptions.judgeProfile?.value
  const latestTaskAttemptOrdinal = latestAttempt?.ordinal
  const rootAdHocTitle = adHocRunTitle(run)
  const aggregateCounters = attempts.reduce(
    (sum, attempt) => ({
      modelCalls: sum.modelCalls + attempt.counters.modelCalls,
      toolCalls: sum.toolCalls + attempt.counters.toolCalls,
      gateRuns: sum.gateRuns + attempt.counters.gateRuns,
      watchdogRestarts: sum.watchdogRestarts + attempt.counters.watchdogRestarts,
    }),
    { modelCalls: 0, toolCalls: 0, gateRuns: 0, watchdogRestarts: 0 },
  )
  const attemptOrdinals = new Map(attempts.map((attempt) => [attempt.id, attempt.ordinal]))
  const taskTree = tasks.map((task) => {
    const activeOrdinal = task.activeAttemptId
      ? attemptOrdinals.get(task.activeAttemptId)
      : undefined
    return {
      id: `${task.documentId}/${task.taskId}`,
      title: task.scopeRunId === runId ? (rootAdHocTitle ?? task.taskId) : task.taskId,
      status: task.status,
      runId: task.scopeRunId,
      depth: task.depth,
      documentId: task.documentId,
      ...(task.parentRunId ? { parentRunId: task.parentRunId } : {}),
      ...(activeOrdinal !== undefined ? { attempt: activeOrdinal } : {}),
    }
  })
  const durableToolCalls = scopes.flatMap((scope) =>
    listToolCalls(layout.ledger, { runId: scope.runId }),
  )
  const tools = durableToolCalls.slice(-60).map(({ intent, settlement }) => ({
    callId: intent.providerToolCallId,
    name: intent.tool,
    status: settlement?.outcome ?? "unsettled",
    timestamp: settlement?.settledAt ?? intent.requestedAt,
    taskId: intent.taskId,
    attemptId: intent.attemptId,
    preview: `${intent.risk} · ${intent.effectClass}`,
  }))
  const gates = attempts
    .flatMap((attempt) =>
      listGateResults(layout.ledger, attempt.id).map(({ result, createdAt }) => ({
        id: result.gateId,
        status: result.status,
        timestamp: createdAt,
        category: result.category,
        blocking: result.blocking,
        durationMs: result.durationMs,
        ...(result.attempts !== undefined ? { attempts: result.attempts } : {}),
        taskId: attempt.taskId,
        attemptId: attempt.id,
        ...(result.reason ? { reason: result.reason } : {}),
      })),
    )
    .slice(-60)
  const runStartedAt = Date.parse(run.startedAt ?? run.createdAt)
  const runObservedAt = Date.parse(run.finishedAt ?? new Date().toISOString())
  const elapsedMs =
    Number.isFinite(runStartedAt) && Number.isFinite(runObservedAt)
      ? Math.max(0, runObservedAt - runStartedAt)
      : undefined
  const usageCalls = Object.fromEntries(
    scopedUsageBreakdowns
      .flatMap(({ scope, usage }) =>
        Object.entries(usageCallProjection(scope.runId, runId, usage, scope.runId !== runId)),
      )
      .slice(-MAX_VISIBLE_USAGE_CALLS),
  )
  const rootUsage = {
    combined:
      usageBreakdown.total.callCount > 0
        ? aggregateUsageView(usageBreakdown.total, "combined")
        : usageView(report?.usage.combined ?? unavailable),
    executor:
      (usageBreakdown.roles.executor?.callCount ?? 0) > 0
        ? aggregateUsageView(usageBreakdown.roles.executor, "executor")
        : usageView(report?.usage.executor ?? unavailable),
    judge:
      (usageBreakdown.roles.judge?.callCount ?? 0) > 0
        ? aggregateUsageView(usageBreakdown.roles.judge, "judge")
        : usageView(report?.usage.judge ?? unavailable),
  }
  const visibleUsage =
    childLinks.length === 0
      ? rootUsage
      : {
          combined: mergeUsageViews(
            rootUsage.combined,
            childUsageView(childAggregate.usage.combined, "child combined"),
            "combined",
            usageBreakdown.total.callCount > 0,
          ),
          executor: mergeUsageViews(
            rootUsage.executor,
            childUsageView(childAggregate.usage.executor, "child executor"),
            "executor",
            (usageBreakdown.roles.executor?.callCount ?? 0) > 0,
          ),
          judge: mergeUsageViews(
            rootUsage.judge,
            childUsageView(childAggregate.usage.judge, "child judge"),
            "judge",
            (usageBreakdown.roles.judge?.callCount ?? 0) > 0,
          ),
        }

  const scopeViews: RunUiScopeProjection[] = scopes.map((scope) => {
    const scopeRun = getRun(layout.ledger, scope.runId)
    const scopeAdHocTitle = adHocRunTitle(scopeRun)
    const scopeTasks = tasks.filter((task) => task.scopeRunId === scope.runId)
    const scopeAttempts = attempts.filter((attempt) => attempt.runId === scope.runId)
    const scopeCurrentTask = selectCurrentTask(scopeTasks)
    const scopeLatestAttempt = latestAttemptForTask(scopeCurrentTask, scopeAttempts)
    const scopeCounters = scopeAttempts.reduce(
      (sum, attempt) => ({
        modelCalls: sum.modelCalls + attempt.counters.modelCalls,
        toolCalls: sum.toolCalls + attempt.counters.toolCalls,
        gateRuns: sum.gateRuns + attempt.counters.gateRuns,
        watchdogRestarts: sum.watchdogRestarts + attempt.counters.watchdogRestarts,
      }),
      { modelCalls: 0, toolCalls: 0, gateRuns: 0, watchdogRestarts: 0 },
    )
    const scopeEventProjection = history.scopeProjection.get(scope.runId)
    const scopeUsage =
      history.usage.get(scope.runId) ?? new TokenUsageAggregator(scope.runId).snapshot()
    const scopeReport = getRunReport(layout.ledger, scope.runId)?.report
    const startedAt = Date.parse(scopeRun?.startedAt ?? scopeRun?.createdAt ?? "")
    const observedAt = Date.parse(scopeRun?.finishedAt ?? new Date().toISOString())
    const scopeElapsedMs =
      Number.isFinite(startedAt) && Number.isFinite(observedAt)
        ? Math.max(0, observedAt - startedAt)
        : undefined
    const scopeWatchdog = scopeEventProjection?.watchdog
      ? {
          ...scopeEventProjection.watchdog,
          restartUsed: Math.max(
            scopeEventProjection.watchdog.restartUsed,
            scopeCounters.watchdogRestarts,
          ),
        }
      : {
          enabled: false,
          state: "unavailable",
          reasons: [],
          restartUsed: scopeCounters.watchdogRestarts,
          signals: [],
        }
    const scopeCompleted = scopeTasks.filter(
      (task) => task.status === "completed" || task.status === "completed_with_override",
    ).length
    return {
      runId: scope.runId,
      kind: scope.runId === runId ? "root" : "child",
      depth: scope.depth,
      ...(scope.parentRunId ? { parentRunId: scope.parentRunId } : {}),
      title: scopeAdHocTitle ?? scopeRun?.rootPrdId ?? scope.runId,
      status: scopeRun?.status ?? "unknown",
      currentTask: scopeCurrentTask
        ? {
            id: `${scopeCurrentTask.documentId}/${scopeCurrentTask.taskId}`,
            title: scopeAdHocTitle ?? scopeCurrentTask.taskId,
            status: scopeCurrentTask.status,
            runId: scope.runId,
            ...(scopeLatestAttempt ? { attempt: scopeLatestAttempt.ordinal } : {}),
          }
        : null,
      progress: { completed: scopeCompleted, total: scopeTasks.length },
      usage: scopeUsageView(scopeUsage, scopeReport?.usage),
      usageCalls: usageCallProjection(scope.runId, scope.runId, scopeUsage, false),
      runtime: {
        phase: scopeLatestAttempt?.phase ?? scopeRun?.status ?? "unknown",
        attempt: scopeLatestAttempt?.ordinal ?? 0,
        modelCalls: scopeCounters.modelCalls,
        toolCalls: scopeCounters.toolCalls,
        gateRuns: scopeCounters.gateRuns,
        ...(scopeElapsedMs !== undefined ? { elapsedMs: scopeElapsedMs } : {}),
      },
      watchdog: scopeWatchdog,
      errors: scopeEventProjection?.errorsSummary ?? { count: 0 },
    }
  })
  const selectedScope =
    scopeViews.find((scope) => scope.runId === currentTask?.scopeRunId) ?? scopeViews[0]
  const aggregateErrors = scopeViews.reduce(
    (summary, scope) => {
      const candidate = scope.errors.last
      const current = summary.last
      const candidateIsNewer =
        candidate &&
        (!current || (candidate.timestamp ?? "").localeCompare(current.timestamp ?? "") >= 0)
      return {
        count: summary.count + scope.errors.count,
        ...(candidateIsNewer ? { last: candidate } : current ? { last: current } : {}),
      }
    },
    { count: 0 } as NonNullable<RunUiSnapshot["errorsSummary"]>,
  )

  const snapshot: RunUiSnapshot = {
    runId,
    title: rootAdHocTitle ?? run.rootPrdId,
    status: run.status,
    currentTask: currentTask
      ? {
          id: `${currentTask.documentId}/${currentTask.taskId}`,
          title:
            currentTask.scopeRunId === runId
              ? (rootAdHocTitle ?? currentTask.taskId)
              : currentTask.taskId,
          status: currentTask.status,
          runId: currentTask.scopeRunId,
          ...(latestTaskAttemptOrdinal !== undefined ? { attempt: latestTaskAttemptOrdinal } : {}),
        }
      : null,
    progress: { completed, total: childAggregate.total },
    usage: visibleUsage,
    usageCalls,
    activity,
    logs,
    events: recentEvents.slice(-30).map(eventEntry),
    engineOutput,
    rawEngineOutput: rawCaptures.lines,
    rawEngineRefs: rawCaptures.resolvedRefs,
    judge: {
      mode: judgeMode,
      ...(judgeProfile ? { profile: judgeProfile } : {}),
      score: latestAssessment?.score ?? null,
      threshold: run.effectiveOptions.judgeThreshold.value,
      revisionAttempt: currentTask
        ? taskAttempts.reduce((sum, attempt) => sum + attempt.counters.revisionAttempts, 0)
        : (report?.counters.revisionAttempts ?? 0),
      maxRevisionAttempts: maximum,
      decision:
        currentTask?.completion?.status ??
        (latestAssessment
          ? latestAssessment.score >= run.effectiveOptions.judgeThreshold.value
            ? "accepted"
            : "revision-required"
          : "pending"),
      ...(latestAssessment?.summary ? { summary: latestAssessment.summary } : {}),
      feedback: {
        adequate: latestAssessment?.adequate ?? [],
        problems: feedbackProblems(latestAssessment?.problems ?? []),
        missing: latestAssessment?.missingEvidence ?? [],
        recommendations: latestAssessment?.recommendations ?? [],
      },
    },
    runtime: {
      phase: latestAttempt?.phase ?? run.status,
      attempt: latestAttempt?.ordinal ?? 0,
      modelCalls: aggregateCounters.modelCalls,
      toolCalls: aggregateCounters.toolCalls,
      gateRuns: aggregateCounters.gateRuns,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    },
    taskTree,
    scopes: scopeViews,
    tools,
    observedToolCallIds: [
      ...new Set(durableToolCalls.map(({ intent }) => intent.providerToolCallId)),
    ],
    gates,
    watchdog: selectedScope?.watchdog ?? {
      enabled: false,
      state: "unavailable",
      reasons: [],
      restartUsed: aggregateCounters.watchdogRestarts,
      signals: [],
    },
    errorsSummary: aggregateErrors,
    evaluationValues: optionValues,
    evaluationOrigins: optionOrigins,
  }
  return {
    snapshot,
    cursor: {
      schemaVersion: 1,
      streamId: `workspace:${run.workspaceId}`,
      sequence: snapshotHighWaterSequence,
    },
    rawCaptureOffsets: rawCaptures.offsets,
  }
}

export function buildRunUiSnapshot(workspaceRoot: string, runId: string): RunUiSnapshot {
  return buildRunUiSnapshotState(workspaceRoot, runId).snapshot
}

function waitForNextEventPoll(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    timer = setTimeout(finish, delayMs)
    signal.addEventListener("abort", finish, { once: true })
  })
}

function normalizeRelatedEventForRoot(input: {
  event: EventEnvelope
  rootRunId: string
  scope?: { depth: number; parentRunId?: string }
  aggregate?: { completed: number; total: number }
  raw?: { readonly content?: string; readonly resolvedRefs: readonly string[] }
}): RunUiEventEnvelope {
  const childRunId = input.event.runId !== input.rootRunId ? input.event.runId : undefined
  const scopeCompleted =
    input.event.type === "progress.updated" && typeof input.event.payload.completed === "number"
      ? input.event.payload.completed
      : undefined
  const scopeTotal =
    input.event.type === "progress.updated" && typeof input.event.payload.total === "number"
      ? input.event.payload.total
      : undefined
  const payload = {
    ...input.event.payload,
    sourceRunId: input.event.runId ?? input.rootRunId,
    ...(childRunId ? { childRunId, sourceRunId: childRunId } : {}),
    ...(input.scope ? { depth: input.scope.depth } : {}),
    ...(scopeCompleted !== undefined ? { scopeCompleted } : {}),
    ...(scopeTotal !== undefined ? { scopeTotal } : {}),
    ...(input.raw?.content ? { rawContent: input.raw.content } : {}),
    ...(input.raw && input.raw.resolvedRefs.length > 0
      ? { rawRefsResolved: input.raw.resolvedRefs }
      : {}),
    ...(input.event.type === "progress.updated" && input.aggregate
      ? {
          completed: input.aggregate.completed,
          total: input.aggregate.total,
          aggregateScope: "leaf-tasks",
        }
      : {}),
  }
  return {
    schemaVersion: input.event.schemaVersion,
    eventId: input.event.eventId,
    sequence: input.event.sequence,
    timestamp: input.event.timestamp,
    monotonicMs: input.event.monotonicMs,
    type:
      childRunId && input.event.type.startsWith("run.")
        ? `child.${input.event.type}`
        : input.event.type,
    scope: input.event.scope,
    streamId: input.event.streamId,
    workspaceId: input.event.workspaceId,
    runId: input.rootRunId,
    ...(input.event.documentId ? { documentId: input.event.documentId } : {}),
    ...(input.event.taskId ? { taskId: input.event.taskId } : {}),
    ...(input.event.attemptId ? { attemptId: input.event.attemptId } : {}),
    ...(input.event.callId ? { callId: input.event.callId } : {}),
    ...(input.event.workerId ? { workerId: input.event.workerId } : {}),
    ...(input.event.correlationId ? { correlationId: input.event.correlationId } : {}),
    ...(input.event.causationId ? { causationId: input.event.causationId } : {}),
    level: input.event.level,
    payload,
    ...(childRunId
      ? { parentRunId: input.event.parentRunId ?? input.scope?.parentRunId ?? input.rootRunId }
      : {}),
  }
}

function materializeEventRawContent(
  ralphRoot: string,
  event: EventEnvelope,
  allowedRunIds: ReadonlySet<string>,
  offsets: Map<string, number>,
): { readonly content?: string; readonly resolvedRefs: readonly string[] } {
  const references = trustedEventRawReferences(event, allowedRunIds)
  if (references.length === 0) return { resolvedRefs: [] }
  const materialized = materializeRawCaptures(ralphRoot, references, allowedRunIds, offsets)
  for (const [reference, offset] of materialized.offsets) {
    setBoundedRawCaptureOffset(offsets, reference, offset)
  }
  return {
    ...(materialized.lines.length > 0 ? { content: materialized.lines.join("\n") } : {}),
    resolvedRefs: materialized.resolvedRefs,
  }
}

class LedgerRunFollowTransport implements RunUiFollowTransport {
  readonly #workspaceRoot: string
  readonly #runId: string
  readonly #rawCaptureOffsets: Map<string, number>

  constructor(
    workspaceRoot: string,
    runId: string,
    rawCaptureOffsets: ReadonlyMap<string, number> = new Map(),
  ) {
    this.#workspaceRoot = workspaceRoot
    this.#runId = runId
    this.#rawCaptureOffsets = new Map()
    for (const [reference, offset] of [...rawCaptureOffsets].slice(-MAX_RAW_CAPTURE_REFS)) {
      setBoundedRawCaptureOffset(this.#rawCaptureOffsets, reference, offset)
    }
  }

  async *follow(request: RunUiFollowRequest): AsyncIterable<RunUiFollowFrame> {
    if (request.runId !== this.#runId) {
      yield {
        kind: "disconnect",
        reason: `Requested run ${request.runId} does not match ${this.#runId}`,
        retryable: false,
      }
      return
    }
    const layout = workspaceLayout(this.#workspaceRoot)
    const run = getRun(layout.ledger, this.#runId)
    if (!run) {
      yield {
        kind: "disconnect",
        reason: `Persisted run disappeared while attached: ${this.#runId}`,
        retryable: false,
      }
      return
    }
    const streamId = `workspace:${run.workspaceId}`
    let cursor = request.after
    if (cursor && cursor.streamId !== streamId) {
      yield {
        kind: "disconnect",
        reason: `Event cursor stream ${cursor.streamId} does not match ${streamId}`,
        retryable: false,
      }
      return
    }
    if (!cursor) {
      const initial = buildRunUiSnapshotState(this.#workspaceRoot, this.#runId)
      this.#rawCaptureOffsets.clear()
      for (const [reference, offset] of initial.rawCaptureOffsets) {
        setBoundedRawCaptureOffset(this.#rawCaptureOffsets, reference, offset)
      }
      cursor = initial.cursor
      yield { kind: "snapshot", snapshot: initial.snapshot, cursor, mode: "live" }
    } else {
      // Establish a healthy frame immediately; otherwise a quiet run would
      // remain visually stuck in the connecting phase until the heartbeat.
      yield { kind: "heartbeat", cursor }
    }

    let lastFrameAt = Date.now()
    while (!request.signal.aborted) {
      const page = readEventBatch(layout.ledger, {
        afterSequence: cursor.sequence,
        limit: EVENT_BATCH_SIZE,
      })
      if (page.cursorSequence > cursor.sequence) {
        cursor = { schemaVersion: 1, streamId, sequence: page.cursorSequence }
        const childLinks = listChildRunTree(layout.ledger, this.#runId)
        const scopeByRunId = new Map<string, { depth: number; parentRunId?: string }>([
          [this.#runId, { depth: 0 }],
          ...childLinks.map(
            (link) =>
              [link.childRunId, { depth: link.depth, parentRunId: link.parentRunId }] as const,
          ),
        ])
        const related = page.events.filter(
          (event) =>
            event.runId !== undefined &&
            scopeByRunId.has(event.runId) &&
            event.type !== "child.event.projected",
        )
        const needsAggregate = related.some((event) => event.type === "progress.updated")
        const aggregate = needsAggregate
          ? readChildRunTreeAggregate(layout.ledger, this.#runId)
          : undefined
        const allowedRawRunIds = new Set(scopeByRunId.keys())
        const events = related.map((event) => {
          const scope = event.runId ? scopeByRunId.get(event.runId) : undefined
          const raw = materializeEventRawContent(
            layout.ralph,
            event,
            allowedRawRunIds,
            this.#rawCaptureOffsets,
          )
          return normalizeRelatedEventForRoot({
            event,
            rootRunId: this.#runId,
            ...(scope ? { scope } : {}),
            raw,
            ...(aggregate
              ? { aggregate: { completed: aggregate.completed, total: aggregate.total } }
              : {}),
          })
        })
        yield { kind: "events", batch: { cursor, events } }
        lastFrameAt = Date.now()
        if (page.scanned === EVENT_BATCH_SIZE) continue
      } else if (Date.now() - lastFrameAt >= EVENT_HEARTBEAT_INTERVAL_MS) {
        yield { kind: "heartbeat", cursor }
        lastFrameAt = Date.now()
      }
      await waitForNextEventPoll(EVENT_POLL_INTERVAL_MS, request.signal)
    }
  }
}

interface LedgerRunSession {
  readonly source: RunUiSource
  close(): Promise<void>
}

function ledgerRunSession(workspaceRoot: string, runId: string): LedgerRunSession {
  const initial = buildRunUiSnapshotState(workspaceRoot, runId)
  const source = new RunUiEventStore({
    runId,
    initialSnapshot: initial.snapshot,
    projectionLimits: {
      activity: 30,
      events: 30,
      logs: 30,
      engineOutput: MAX_ENGINE_LINES,
    },
  })
  source.acceptSnapshot(initial.snapshot, initial.cursor)
  const client = new RunUiFollowClient({
    runId,
    source,
    transport: new LedgerRunFollowTransport(workspaceRoot, runId, initial.rawCaptureOffsets),
  })
  const running = client.start()
  // Ownership remains with close(); this prevents a late transport failure
  // from becoming an unhandled rejection while the renderer is active.
  void running.catch(() => undefined)
  return {
    source,
    async close() {
      client.stop("dashboard closed")
      await running.catch(() => undefined)
    },
  }
}

function evaluationFields() {
  return evaluationFormMetadata().fields.map((field) => ({
    id: field.id,
    label: field.label,
    description: field.help,
    kind:
      field.kind === "toggle"
        ? "boolean"
        : field.kind === "reference"
          ? "string"
          : field.kind === "multi-select"
            ? "string-list"
            : field.kind,
    configPath: field.configPath,
    cliFlag: field.cliFlag,
    required: field.required,
    secret: field.secret,
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    ...(field.choices
      ? { choices: field.choices.map((value) => ({ label: String(value), value })) }
      : {}),
    ...(field.visibleWhen
      ? {
          visibleWhen: {
            fieldId: field.visibleWhen.fieldId,
            equals: field.visibleWhen.values,
          },
        }
      : {}),
  }))
}

function tuiAuthMethodSupported(method: string, credentials: CredentialCommandService): boolean {
  return (
    method === "environment" ||
    (method === "api-key" && credentials.connectWithSecretInput !== undefined) ||
    method === "oauth-browser" ||
    method === "device-code" ||
    method === "subscription-session"
  )
}

type TuiProfileDraft = {
  readonly profileId: string
  readonly role: ProviderPaletteRole
  readonly scope: ProviderPaletteScope
  readonly state: ProfileFormState
  /** Provenance of the lower effective profile, indexed by concrete config leaf. */
  readonly inheritSources: Readonly<Record<string, EffectiveValue>>
  readonly expectedTargetSha256: string | null
  readonly expectedPeerSha256: string | null
  revision: number
}

const PROFILE_SOURCE_ORDER: readonly EffectiveValue["source"][] = [
  "builtin",
  "global",
  "workspace",
  "env",
  "profile",
  "prd",
  "task",
  "cli",
]

function inheritedTuiProfileFieldSource(
  draft: TuiProfileDraft,
  field: SettingsFieldMetadata,
): string {
  const relativePath = profileFormFieldPath(field)
  if (!relativePath) return "command"
  const path = `profiles.${draft.profileId}.${relativePath.join(".")}`
  const matching = Object.entries(draft.inheritSources).filter(
    ([candidate]) => candidate === path || candidate.startsWith(`${path}.`),
  )
  if (matching.length === 0) return "builtin"
  const sources = new Set(matching.map(([, value]) => value.source))
  const ordered = PROFILE_SOURCE_ORDER.filter((source) => sources.has(source))
  return ordered.length === 1 ? (ordered[0] as string) : `mixed(${ordered.join("+")})`
}

function profileFormIssues(state: ProfileFormState): readonly string[] {
  const parsed = RoleProfileConfigSchema.safeParse(state.candidate)
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`)
}

function projectTuiProfileForm(
  draft: TuiProfileDraft,
  metadata: readonly SettingsFieldMetadata[],
): ProviderPaletteProfileForm {
  const issues = profileFormIssues(draft.state)
  return {
    schemaVersion: 1,
    revision: draft.revision,
    profileId: draft.profileId,
    role: draft.role,
    scope: draft.scope,
    setDefault: draft.state.setDefault,
    valid: issues.length === 0,
    issues,
    fields: metadata.map((field) => {
      const value = profileFormFieldValue(field, draft.state)
      const mode = profileFormFieldMode(field, draft.state)
      return {
        field: {
          id: field.id,
          label: field.label,
          kind: field.kind,
          configPath: field.configPath,
          cliFlag: field.cliFlag,
          required: field.required,
          editable: field.id !== "scope" && field.id !== "role",
          ...(field.choices ? { choices: [...field.choices] } : {}),
          help: inheritableRoleProfileFormField(field.id)
            ? `${field.help} Headless inherit: --inherit-profile-field ${field.id}.`
            : field.help,
        },
        mode,
        displayValue:
          field.kind === "json" && value !== undefined
            ? JSON.stringify(value)
            : displayProfileFormValue(value),
        source:
          mode === "inherit"
            ? inheritedTuiProfileFieldSource(draft, field)
            : `${draft.scope} layer`,
        visible: profileFormFieldVisible(field, draft.state, metadata),
      }
    }),
  }
}

function profileDraftKey(role: ProviderPaletteRole, scope: ProviderPaletteScope): string {
  return `${role}:${scope}`
}

function providerPalettePort(options: {
  readonly resolveModelCatalog: () => Promise<ModelCatalog>
  readonly credentials: CredentialCommandService
  readonly settings: RalphTuiSettingsController
  readonly mode: ProviderPaletteMode
  readonly workspaceRoot: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly configureProfile?: TuiRoleProfileConfigure
}): ProviderPalettePort {
  let catalogHandle: CredentialCatalogHandle | undefined
  let catalogSnapshot: Awaited<ReturnType<ModelCatalog["snapshot"]>>["snapshot"] | undefined
  let providerById = new Map<string, ProviderInfo>()
  let modelKeys = new Set<string>()
  let credentialById = new Map<
    string,
    Awaited<ReturnType<CredentialCommandService["list"]>>[number]
  >()
  const savedProfileByRole = new Map<ProviderPaletteRole, string>()
  const profileMetadata = roleProfileFormMetadata().fields
  const profileDrafts = new Map<string, TuiProfileDraft>()

  const load: ProviderPalettePort["load"] = async ({ refresh, resetProfileDrafts }) => {
    if (resetProfileDrafts) profileDrafts.clear()
    const resolution = await (async () => {
      if (options.credentials.catalogSnapshot) {
        catalogHandle = await options.credentials.catalogSnapshot({ refresh })
        return catalogHandle.resolution
      }
      return (await options.resolveModelCatalog()).snapshot({ forceRefresh: refresh })
    })()
    catalogSnapshot = resolution.snapshot
    providerById = new Map(resolution.snapshot.providers.map((provider) => [provider.id, provider]))
    modelKeys = new Set(resolution.snapshot.models.map((model) => `${model.provider}/${model.id}`))
    const credentialRefs = await options.credentials.list()
    credentialById = new Map(credentialRefs.map((credential) => [credential.id, credential]))
    const credentialStatuses = await Promise.all(
      credentialRefs.map(async (credential) => {
        const provider = providerById.get(credential.provider)
        if (!provider) return [credential.id, "unavailable"] as const
        try {
          return [
            credential.id,
            await options.credentials.status(credential, {
              refresh,
              provider,
              ...(catalogHandle ? { catalogHandle } : {}),
            }),
          ] as const
        } catch {
          return [credential.id, "unknown"] as const
        }
      }),
    )
    const statusByCredential = new Map(credentialStatuses)
    // Re-project invocation overrides and config provenance before every
    // provider snapshot. The settings controller preserves its draft while
    // refreshing config, so close/reopen observes external default changes
    // without losing explicit pre-run edits (including credential=null).
    await options.settings.reload()
    savedProfileByRole.clear()
    const globalProfileBaseline = await readConfigTransferLayer({
      scope: "global",
      environment: { ...options.environment },
    })
    const workspaceProfileBaseline = await readConfigTransferLayer({
      scope: "workspace",
      workspaceRoot: options.workspaceRoot,
      environment: { ...options.environment },
    })
    const effective = await loadEffectiveConfig({
      workspaceConfig: workspaceLayout(options.workspaceRoot).config,
      environment: { ...options.environment },
    })
    const globalEffective = await loadEffectiveConfig({
      environment: { ...options.environment },
    })
    const confirmedGlobalProfileBaseline = await readConfigTransferLayer({
      scope: "global",
      environment: { ...options.environment },
    })
    const confirmedWorkspaceProfileBaseline = await readConfigTransferLayer({
      scope: "workspace",
      workspaceRoot: options.workspaceRoot,
      environment: { ...options.environment },
    })
    if (
      confirmedGlobalProfileBaseline.sha256 !== globalProfileBaseline.sha256 ||
      confirmedWorkspaceProfileBaseline.sha256 !== workspaceProfileBaseline.sha256
    ) {
      throw new Error("Role-profile configuration changed while the TUI snapshot was being loaded")
    }
    const executorProfileId = await profileIdForRole("executor")
    const judgeProfileId = await profileIdForRole("judge")
    const firstModel = resolution.snapshot.models[0]
    const ensureProfileDraft = (
      role: ProviderPaletteRole,
      scope: ProviderPaletteScope,
      profileId: string,
    ): TuiProfileDraft => {
      const key = profileDraftKey(role, scope)
      const retained = profileDrafts.get(key)
      if (retained?.profileId === profileId) return retained
      const scopedConfig = scope === "workspace" ? effective.config : globalEffective.config
      const existing = scopedConfig.profiles[profileId]
      const compatibleExisting = existing?.role === role ? existing : undefined
      const lowerProfile =
        scope === "workspace"
          ? globalEffective.config.profiles[profileId]?.role === role
            ? globalEffective.config.profiles[profileId]
            : undefined
          : DEFAULT_CONFIG.profiles[profileId]?.role === role
            ? DEFAULT_CONFIG.profiles[profileId]
            : undefined
      const targetLayer =
        scope === "workspace" ? workspaceProfileBaseline.layer : globalProfileBaseline.layer
      const rawProfileLayer = targetLayer.profiles?.[profileId]
      const suggested: Partial<RoleProfileConfig> = compatibleExisting ?? {
        role,
        backend: "embedded",
        provider: firstModel?.provider ?? "",
        model: firstModel?.id ?? "",
        parameters: {},
        requirements: {
          input: [],
          tools: false,
          tool_streaming: false,
          reasoning: false,
          structured_output: false,
          usage: [],
          access: [],
        },
        fallback_profiles: [],
        fallback_on: [],
        limits: {},
      }
      const initialProfileLayer: RoleProfileConfigLayer = compatibleExisting
        ? structuredClone(rawProfileLayer ?? {})
        : structuredClone(suggested as RoleProfileConfigLayer)
      const state = createProfileFormState(
        {
          profileId,
          ...(compatibleExisting ? { existing: compatibleExisting } : {}),
          suggested,
          initialScope: scope,
          scopedLayers: {
            global:
              scope === "global"
                ? {
                    profileLayer: initialProfileLayer,
                    ...(lowerProfile ? { lowerProfile } : {}),
                  }
                : {},
            workspace:
              scope === "workspace"
                ? {
                    profileLayer: initialProfileLayer,
                    ...(lowerProfile ? { lowerProfile } : {}),
                  }
                : {},
          },
          metadata: roleProfileFormMetadata(profileId),
        },
        scope,
      )
      const created: TuiProfileDraft = {
        profileId,
        role,
        scope,
        state,
        inheritSources: scope === "workspace" && lowerProfile ? globalEffective.values : {},
        expectedTargetSha256:
          scope === "workspace" ? workspaceProfileBaseline.sha256 : globalProfileBaseline.sha256,
        expectedPeerSha256:
          scope === "workspace" ? globalProfileBaseline.sha256 : workspaceProfileBaseline.sha256,
        revision: 0,
      }
      profileDrafts.set(key, created)
      return created
    }
    const settingValue = (fieldId: string) =>
      options.settings.state.snapshot?.fields.find((entry) => entry.field.id === fieldId)?.value
    const roleProfile = (role: ProviderPaletteRole, profileId: string) => {
      const profile = effective.config.profiles[profileId]
      const configuredProfile = profile?.role === role ? profile : undefined
      const configured = configuredProfile !== undefined
      const prefix = role === "executor" ? "executor" : "judge"
      const providerOverride = settingValue(`${prefix}Provider`)
      const modelOverride = settingValue(`${prefix}Model`)
      const credentialOverride = settingValue(`${prefix}Credential`)
      const provider =
        typeof providerOverride === "string" && providerOverride.trim().length > 0
          ? providerOverride
          : configuredProfile?.provider
      const model =
        typeof modelOverride === "string" && modelOverride.trim().length > 0
          ? modelOverride
          : configuredProfile?.model
      const credentialId =
        credentialOverride === null
          ? undefined
          : typeof credentialOverride === "string" && credentialOverride.trim().length > 0
            ? credentialOverride
            : configuredProfile?.credential
      const globalProfileId =
        role === "executor"
          ? globalEffective.config.defaults.executor_profile
          : (globalEffective.config.defaults.judge_profile ?? profileId)
      const forms = {
        global: projectTuiProfileForm(
          ensureProfileDraft(role, "global", globalProfileId),
          profileMetadata,
        ),
        workspace: projectTuiProfileForm(
          ensureProfileDraft(role, "workspace", profileId),
          profileMetadata,
        ),
      } as const
      return {
        id: profileId,
        configured,
        forms,
        ...(provider && model
          ? {
              route: {
                provider,
                model,
                ...(credentialId ? { credentialId } : {}),
              },
            }
          : {}),
      }
    }
    return {
      schemaVersion: 1,
      catalogSnapshotId: resolution.snapshot.id,
      catalogOrigin: resolution.origin,
      catalogStale: resolution.stale,
      providers: resolution.snapshot.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        status: provider.status,
        access: provider.access,
        catalogSource: provider.catalogSource,
        catalogUpdatedAt: provider.catalogUpdatedAt,
        authMethods: provider.credentialMethods.map((method) => {
          const supported = tuiAuthMethodSupported(method.method, options.credentials)
          return {
            method: method.method,
            label: method.label,
            access: method.access,
            interactive: method.interactive,
            tuiConnectSupported: supported,
            ...(!supported
              ? {
                  unsupportedReason:
                    method.method === "api-key"
                      ? "This credential service has no one-shot TUI secret boundary; use the command-owned masked CLI prompt."
                      : "This credential method is not implemented by the embedded TUI composition.",
                }
              : {}),
            cliCommand:
              method.method === "environment"
                ? `ralph-next auth connect ${provider.id} --method environment --environment <NAME>`
                : `ralph-next auth connect ${provider.id} --method ${method.method}`,
          }
        }),
      })),
      models: resolution.snapshot.models.map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        ...(model.family ? { family: model.family } : {}),
        status: model.status,
        access: model.access,
        capabilities: model.capabilities,
        limits: {
          ...(model.limits.context !== undefined ? { context: model.limits.context } : {}),
          ...(model.limits.output !== undefined ? { output: model.limits.output } : {}),
        },
        variants: model.variants.map((variant) => ({ id: variant.id, name: variant.name })),
        price: {
          status: model.price.status,
          source: model.price.source,
          ...(model.price.currency ? { currency: model.price.currency } : {}),
          ...(model.price.unit ? { unit: model.price.unit } : {}),
          ...(model.price.reason ? { reason: model.price.reason } : {}),
        },
        cliInspectCommand: `ralph-next models inspect ${model.provider}/${model.id}`,
      })),
      credentials: credentialRefs.map((credential) => ({
        id: credential.id,
        provider: credential.provider,
        method: credential.method,
        store: credential.store,
        label: credential.label,
        ...(credential.accountHint ? { accountHint: credential.accountHint } : {}),
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
        status: statusByCredential.get(credential.id) ?? "unknown",
        cliRevokeCommand: `ralph-next auth revoke ${credential.id}`,
      })),
      roleProfiles: {
        executor: roleProfile("executor", executorProfileId),
        judge: roleProfile("judge", judgeProfileId),
      },
    }
  }

  const ensureLoaded = async (): Promise<void> => {
    if (providerById.size === 0 || modelKeys.size === 0) await load({ refresh: false })
  }

  const settingString = async (fieldId: string): Promise<string | undefined> => {
    if (!options.settings.state.snapshot) await options.settings.reload()
    const value = options.settings.state.snapshot?.fields.find(
      (entry) => entry.field.id === fieldId,
    )?.value
    return typeof value === "string" && value.trim().length > 0 ? value : undefined
  }

  const profileIdForRole = async (role: ProviderPaletteRole): Promise<string> => {
    const cached = savedProfileByRole.get(role)
    if (cached) return cached
    const fieldId = role === "executor" ? "executorProfile" : "judgeProfile"
    return (await settingString(fieldId)) ?? (role === "executor" ? "default" : "judge-default")
  }

  const assertSelection = async (selection: ProviderPaletteSelection): Promise<void> => {
    await ensureLoaded()
    if (!providerById.has(selection.provider)) {
      throw new Error(`Provider is absent from the pinned catalog: ${selection.provider}`)
    }
    if (!modelKeys.has(`${selection.provider}/${selection.model}`)) {
      throw new Error(
        `Model is absent from the pinned provider catalog: ${selection.provider}/${selection.model}`,
      )
    }
    if (selection.credentialId) {
      const credential = credentialById.get(selection.credentialId)
      if (!credential) {
        throw new Error(`Credential reference was not found: ${selection.credentialId}`)
      }
      if (credential.provider !== selection.provider) {
        throw new Error(
          `Credential ${selection.credentialId} belongs to ${credential.provider}, not ${selection.provider}`,
        )
      }
    }
  }

  const activeEmbeddedProfile = async (
    selection: ProviderPaletteSelection,
    profileId: string,
  ): Promise<void> => {
    const effective = await loadEffectiveConfig({
      workspaceConfig: workspaceLayout(options.workspaceRoot).config,
      environment: { ...options.environment },
    })
    const profile = effective.config.profiles[profileId]
    if (!profile) {
      throw new Error(
        `Role profile ${profileId} is not configured; save a workspace/global ${selection.role} default before applying this route`,
      )
    }
    if (profile.role !== selection.role) {
      throw new Error(`Role profile ${profileId} is ${profile.role}, not ${selection.role}`)
    }
    if (profile.backend !== "embedded") {
      throw new Error(
        `Role profile ${profileId} uses ${profile.backend}; catalog provider/model overrides require an embedded profile`,
      )
    }
    await ensureLoaded()
    if (!catalogSnapshot) throw new Error("Pinned catalog snapshot is unavailable")
    const selectedProfile = {
      ...profile,
      provider: selection.provider,
      model: selection.model,
      parameters: {},
    }
    delete selectedProfile.variant
    if (selection.credentialId) selectedProfile.credential = selection.credentialId
    else delete selectedProfile.credential
    resolveRuntimeProfiles(
      {
        ...effective.config.profiles,
        [profileId]: selectedProfile,
      },
      [...credentialById.values()],
      catalogSnapshot,
    )
  }

  const stageSelection = async (
    selection: ProviderPaletteSelection,
    profileId: string,
  ): Promise<void> => {
    const prefix = selection.role === "executor" ? "executor" : "judge"
    // Clear model-specific state before changing the route so a failed staged
    // update cannot leave an incompatible variant/parameter set behind.
    await options.settings.updateValue(`${prefix}Credential`, null)
    await options.settings.updateValue(`${prefix}Variant`, null)
    await options.settings.updateValue(`${prefix}Parameters`, {})
    await options.settings.updateValue(`${prefix}Profile`, profileId)
    await options.settings.updateValue(`${prefix}Provider`, selection.provider)
    await options.settings.updateValue(`${prefix}Model`, selection.model)
    if (selection.credentialId) {
      await options.settings.updateValue(`${prefix}Credential`, selection.credentialId)
    }
  }

  const requireProfileDraft = (
    role: ProviderPaletteRole,
    scope: ProviderPaletteScope,
  ): TuiProfileDraft => {
    const draft = profileDrafts.get(profileDraftKey(role, scope))
    if (!draft) throw new Error(`The ${scope} ${role} profile form has not been loaded`)
    return draft
  }

  const profileField = (fieldId: string): SettingsFieldMetadata => {
    const field = profileMetadata.find((candidate) => candidate.id === fieldId)
    if (!field) throw new Error(`Unknown role-profile field: ${fieldId}`)
    if (field.secret)
      throw new Error(`Secret field is forbidden in role-profile metadata: ${fieldId}`)
    if (field.id === "scope" || field.id === "role") {
      throw new Error(`${field.label} is controlled by the popup role/scope selectors`)
    }
    return field
  }

  return {
    load,
    async connect(request) {
      if (!catalogHandle || providerById.size === 0) await load({ refresh: false })
      const provider = providerById.get(request.provider)
      if (!provider)
        throw new Error(`Provider is absent from the pinned catalog: ${request.provider}`)
      const method = provider.credentialMethods.find(
        (candidate) => candidate.method === request.method,
      )
      if (!method || !tuiAuthMethodSupported(method.method, options.credentials)) {
        throw new Error(
          `Authentication method requires its direct CLI flow: ralph-next auth connect ${provider.id} --method ${request.method}`,
        )
      }
      const connectRequest = {
        provider: provider.id,
        providerInfo: provider,
        ...(catalogHandle ? { catalogHandle } : {}),
        method: method.method,
        nonInteractive: false,
        headless: false,
        allowInsecureStore: false,
      } as const
      let credential: Awaited<ReturnType<CredentialCommandService["connect"]>>
      if (method.method === "api-key") {
        if (request.input.kind !== "api-key") {
          throw new Error("The masked API-key input was not supplied")
        }
        if (!options.credentials.connectWithSecretInput) {
          throw new Error(
            `This runtime requires the masked CLI flow: ralph-next auth connect ${provider.id} --method api-key`,
          )
        }
        credential = await options.credentials.connectWithSecretInput(
          { ...connectRequest, secretSource: "not-applicable" },
          request.input.secret,
        )
      } else if (method.method === "environment") {
        if (request.input.kind !== "environment") {
          throw new Error("The environment variable name was not supplied")
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(request.input.variable)) {
          throw new Error("Environment variable name is invalid")
        }
        credential = await options.credentials.connect({
          ...connectRequest,
          environmentName: request.input.variable,
          secretSource: "not-applicable",
        })
      } else {
        credential = await options.credentials.connect({
          ...connectRequest,
          secretSource: "not-applicable",
        })
      }
      credentialById.set(credential.id, credential)
      return {
        id: credential.id,
        provider: credential.provider,
        method: credential.method,
        store: credential.store,
        label: credential.label,
        ...(credential.accountHint ? { accountHint: credential.accountHint } : {}),
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
        status: "connected",
        cliRevokeCommand: `ralph-next auth revoke ${credential.id}`,
      }
    },
    async revoke({ credentialId }) {
      if (credentialById.size === 0) await load({ refresh: false })
      const credential = credentialById.get(credentialId)
      if (!credential) throw new Error(`Credential reference was not found: ${credentialId}`)
      await options.credentials.revoke(credential)
      credentialById.delete(credentialId)
    },
    async updateProfile(request) {
      const draft = requireProfileDraft(request.role, request.scope)
      if (request.expectedRevision !== draft.revision) {
        throw new Error(
          `Role-profile draft is stale: expected revision ${request.expectedRevision}, current ${draft.revision}`,
        )
      }
      const field = profileField(request.fieldId)
      if (request.action === "inherit") {
        if (!inheritableRoleProfileFormField(field.id)) {
          throw new Error(`${field.label} is command-owned and cannot inherit from a profile layer`)
        }
        inheritProfileFormField(field, draft.state)
      } else if (request.action === "clear") {
        clearProfileFormField(field, draft.state)
      } else {
        let value: unknown
        if (request.action === "set") {
          if (request.text === undefined) throw new Error(`${field.label} requires an input value`)
          value = decodeProfileFormFieldText(field, request.text)
        } else if (field.kind === "toggle") {
          value = profileFormFieldValue(field, draft.state) !== true
        } else if (field.choices && field.choices.length > 0) {
          const current = profileFormFieldValue(field, draft.state)
          const index = typeof current === "string" ? field.choices.indexOf(current) : -1
          const direction = request.direction ?? 1
          value =
            index < 0
              ? direction > 0
                ? field.choices[0]
                : field.choices.at(-1)
              : field.choices[(index + direction + field.choices.length) % field.choices.length]
          if (value === undefined) throw new Error(`${field.label} has no selectable value`)
        } else {
          throw new Error(`${field.label} cannot be cycled; edit its text value`)
        }
        applyProfileFormFieldValue(field, value, draft.state)
      }
      draft.revision += 1
      return projectTuiProfileForm(draft, profileMetadata)
    },
    async applyForRun(selection) {
      if (options.mode !== "pre-run") {
        throw new Error(
          "Apply for this run is unavailable after persistence; attach/replay remains read-only",
        )
      }
      await assertSelection(selection)
      const profileId = await profileIdForRole(selection.role)
      await activeEmbeddedProfile(selection, profileId)
      await stageSelection(selection, profileId)
      const result = await options.settings.applyForRun()
      return {
        effect: "new-run-draft-only",
        role: selection.role,
        profileId,
        message: `${selection.role} route ${selection.provider}/${selection.model} applied to the unpersisted run draft through shared settings metadata.`,
        result,
      }
    },
    async saveDefault(selection) {
      if (!options.configureProfile) {
        throw new Error("The shared role-profile configuration handler is unavailable")
      }
      await assertSelection(selection)
      const draft = requireProfileDraft(selection.role, selection.scope)
      const profileId = draft.profileId
      applyProfileFormFieldValue(profileField("backend"), "embedded", draft.state)
      applyProfileFormFieldValue(profileField("provider"), selection.provider, draft.state)
      applyProfileFormFieldValue(profileField("model"), selection.model, draft.state)
      applyProfileFormFieldValue(profileField("parameters"), {}, draft.state)
      clearProfileFormField(profileField("variant"), draft.state)
      if (selection.credentialId) {
        applyProfileFormFieldValue(profileField("credential"), selection.credentialId, draft.state)
      } else {
        clearProfileFormField(profileField("credential"), draft.state)
      }
      const profile = parseProfileFormState(draft.state)
      const profileLayer = parseProfileFormLayer(draft.state)
      if (!profileLayer) throw new Error("The TUI role-profile layer is unavailable")
      await options.configureProfile({
        workspaceRoot: options.workspaceRoot,
        scope: selection.scope,
        profileId,
        profile,
        profileLayer,
        setDefault: draft.state.setDefault,
        expectedTargetSha256: draft.expectedTargetSha256,
        expectedPeerSha256: draft.expectedPeerSha256,
      })
      // Keep the just-committed profile only for this open snapshot. The next
      // load refreshes settings/config first and clears this transient cache.
      savedProfileByRole.set(selection.role, profileId)
      profileDrafts.delete(profileDraftKey(selection.role, selection.scope))
      return {
        effect: "future-runs-only",
        role: selection.role,
        scope: selection.scope,
        profileId,
        message: `${selection.scope} profile ${profileId} saved atomically${draft.state.setDefault ? " and selected as the role default" : " without changing the role default"}.`,
      }
    },
    async saveProfile(request) {
      if (!options.configureProfile) {
        throw new Error("The shared role-profile configuration handler is unavailable")
      }
      const draft = requireProfileDraft(request.role, request.scope)
      if (request.expectedRevision !== draft.revision) {
        throw new Error(
          `Role-profile draft is stale: expected revision ${request.expectedRevision}, current ${draft.revision}`,
        )
      }
      const profile = parseProfileFormState(draft.state)
      const profileLayer = parseProfileFormLayer(draft.state)
      if (!profileLayer) throw new Error("The TUI role-profile layer is unavailable")
      await options.configureProfile({
        workspaceRoot: options.workspaceRoot,
        scope: request.scope,
        profileId: draft.profileId,
        profile,
        profileLayer,
        setDefault: draft.state.setDefault,
        expectedTargetSha256: draft.expectedTargetSha256,
        expectedPeerSha256: draft.expectedPeerSha256,
      })
      profileDrafts.delete(profileDraftKey(request.role, request.scope))
      savedProfileByRole.set(request.role, draft.profileId)
      return {
        effect: "future-runs-only",
        role: request.role,
        scope: request.scope,
        profileId: draft.profileId,
        message: `${request.scope} profile ${draft.profileId} saved atomically${draft.state.setDefault ? " and selected as the role default" : " without changing the role default"}.`,
      }
    },
  }
}

export interface TuiRoleProfileConfigureRequest {
  readonly workspaceRoot: string
  readonly scope: ProviderPaletteScope
  readonly profileId: string
  readonly profile: RoleProfileConfig
  readonly profileLayer: RoleProfileConfigLayer
  readonly setDefault: boolean
  readonly expectedTargetSha256: string | null
  readonly expectedPeerSha256: string | null
}

export type TuiRoleProfileConfigure = (request: TuiRoleProfileConfigureRequest) => Promise<void>

export interface TuiServiceOptions {
  readonly runControl?: RunControlCommandService
  /** Application-owned signal bridge; the renderer never owns process shutdown. */
  readonly interrupt?: (signal: "SIGINT" | "SIGTERM") => void
  readonly resolveModelCatalog?: () => Promise<ModelCatalog>
  readonly credentials?: CredentialCommandService
  /** Reuses the command-owned profiles.configure handler; the TUI never writes profiles itself. */
  readonly configureProfile?: TuiRoleProfileConfigure
}

export function createTuiServices(options: TuiServiceOptions = {}): RunUiCommandService {
  const createProviders = (
    settings: RalphTuiSettingsController,
    mode: ProviderPaletteMode,
    workspaceRoot: string,
  ) =>
    options.resolveModelCatalog && options.credentials
      ? createProviderPaletteController(
          providerPalettePort({
            resolveModelCatalog: options.resolveModelCatalog,
            credentials: options.credentials,
            settings,
            mode,
            workspaceRoot,
            environment: process.env,
            ...(options.configureProfile ? { configureProfile: options.configureProfile } : {}),
          }),
          { mode, scope: "workspace" },
        )
      : undefined
  return {
    async prepare(request) {
      const presentation = await tuiPresentation(request.workspaceRoot)
      const settings = createRalphTuiSettingsController({
        mode: "pre-run",
        workspaceRoot: request.workspaceRoot,
        environment: process.env,
        initialInvocation: request.initialInvocation,
      })
      const providers = createProviders(settings, "pre-run", request.workspaceRoot)
      const pending = createEmptyRunUiSnapshot("pre-run")
      const snapshot: RunUiSnapshot = {
        ...pending,
        title: tuiText(presentation.locale, "Prepare Ralph run", "Preparar run do Ralph"),
        status: "configuring",
        runtime: {
          phase: tuiText(presentation.locale, "pre-run configuration", "configuração pré-run"),
          attempt: pending.runtime?.attempt ?? 0,
          modelCalls: pending.runtime?.modelCalls ?? 0,
          toolCalls: pending.runtime?.toolCalls ?? 0,
          gateRuns: pending.runtime?.gateRuns ?? 0,
          ...(pending.runtime?.elapsedMs !== undefined
            ? { elapsedMs: pending.runtime.elapsedMs }
            : {}),
        },
      }
      const source: RunUiSource = {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
      }
      let applied: SettingsPreRunInvocation | undefined
      let handle: Awaited<ReturnType<typeof renderRunDashboard>> | undefined
      try {
        handle = await renderRunDashboard({
          source,
          settings,
          ...(providers ? { providers } : {}),
          ...(options.interrupt ? { onInterrupt: () => options.interrupt?.("SIGINT") } : {}),
          ...presentation,
          onSettingsApply: (value) => {
            const result = settingsApplyResult(value)
            if (!result) return
            applied = mergeSettingsInvocation(request.initialInvocation, result.invocation)
            handle?.destroy()
          },
        })
        const abort = () => handle?.destroy()
        request.signal?.addEventListener("abort", abort, { once: true })
        if (request.signal?.aborted) abort()
        try {
          await settings.open()
          await handle.closed
        } finally {
          request.signal?.removeEventListener("abort", abort)
        }
      } finally {
        settings.close()
        providers?.close()
        handle?.destroy()
      }
      return applied
        ? { disposition: "applied" as const, invocation: applied }
        : { disposition: "cancelled" as const }
    },

    async attach(request: RunUiCommandRequest): Promise<RunUiCommandResult> {
      const replay = request.mode === "replay"
      const session = replay ? undefined : ledgerRunSession(request.workspaceRoot, request.runId)
      const replaySnapshot = replay
        ? buildRunUiSnapshotState(request.workspaceRoot, request.runId).snapshot
        : undefined
      const source: RunUiSource = session
        ? session.source
        : {
            getSnapshot: () => replaySnapshot as RunUiSnapshot,
            subscribe: () => () => {},
          }
      const layout = workspaceLayout(request.workspaceRoot)
      const attachedRun = getRun(layout.ledger, request.runId)
      if (!attachedRun)
        throw new Error(`Persisted run disappeared while attached: ${request.runId}`)
      const presentation = await tuiPresentation(request.workspaceRoot)
      const runControl = options.runControl
      const settings = createRalphTuiSettingsController({
        mode: replay ? "replay" : "attach",
        workspaceRoot: request.workspaceRoot,
        environment: process.env,
        initialInvocation: persistedSettingsInvocation(
          attachedRun.effectiveOptions,
          attachedRun.source?.kind === "ad-hoc" ? undefined : attachedRun.rootPrdFile,
        ),
        initialOrigins: {
          ...persistedSettingsOrigins(attachedRun.effectiveOptions),
          ...(attachedRun.source?.kind === "ad-hoc"
            ? {}
            : { prd: { source: "run" as const, sourceRef: "persisted root PRD" } }),
        },
      })
      const providers = createProviders(
        settings,
        replay ? "replay" : "attach",
        request.workspaceRoot,
      )
      let handle: Awaited<ReturnType<typeof renderRunDashboard>>
      try {
        handle = await renderRunDashboard({
          source,
          evaluationFields: evaluationFields(),
          ...presentation,
          settings,
          ...(providers ? { providers } : {}),
          ...(options.interrupt ? { onInterrupt: () => options.interrupt?.("SIGINT") } : {}),
          ...(!replay && runControl
            ? {
                onStop: async () => {
                  const result = await runControl.stop({
                    workspaceRoot: request.workspaceRoot,
                    workspaceId: attachedRun.workspaceId,
                    runId: request.runId,
                    mode: "graceful",
                  })
                  return `${result.disposition} · status=${result.status} · delivery=${result.delivery}`
                },
              }
            : {}),
        })
      } catch (error) {
        await session?.close()
        providers?.close()
        throw error
      }
      const abort = () => handle.destroy()
      const unsubscribeTerminal = request.closeWhenTerminal
        ? source.subscribe((snapshot) => {
            if (
              snapshot.status === "completed" ||
              snapshot.status === "failed" ||
              snapshot.status === "cancelled"
            ) {
              handle.destroy()
            }
          })
        : undefined
      request.signal?.addEventListener("abort", abort, { once: true })
      if (request.signal?.aborted) abort()
      try {
        await handle.closed
      } finally {
        request.signal?.removeEventListener("abort", abort)
        unsubscribeTerminal?.()
        await session?.close()
        handle.destroy()
      }
      return {
        runId: request.runId,
        observedStatus: source.getSnapshot().status,
        closeReason: request.signal?.aborted ? "signal" : "user",
      }
    },
  }
}
