import {
  decodeSettingsValue,
  type SettingsDraft,
  type SettingsDraftPreview,
  type SettingsFieldState,
  type SettingsJsonValue,
  type SettingsPreRunInvocation,
  settingsCommandModel,
} from "@ralph-next/commands"
import { type EffectiveConfig, EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  loadEffectiveConfig,
  type SettingsConfigMutation,
  workspaceLayout,
} from "@ralph-next/persistence"
import {
  createSettingsPaletteController,
  formatSettingsPaletteValue,
  SETTINGS_PALETTE_MASK,
  type SettingsPaletteController,
  type SettingsPaletteField,
  type SettingsPaletteFieldState,
  type SettingsPaletteJsonValue,
  type SettingsPaletteMode,
  type SettingsPalettePort,
  type SettingsPalettePreview,
  type SettingsPalettePreviewEntry,
  type SettingsPaletteSaveResponse,
  type SettingsPaletteScope,
  type SettingsPaletteSnapshot,
  type SettingsPaletteUpdateRequest,
} from "@ralph-next/tui"

export interface RalphTuiSettingsOptions {
  readonly mode: SettingsPaletteMode
  /** Resolved Ralph workspace root, when this palette has workspace context. */
  readonly workspaceRoot?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly initialScope?: SettingsPaletteScope
  /** Existing invocation values are display/provenance inputs, not draft changes. */
  readonly initialInvocation?: SettingsPreRunInvocation
  readonly initialOrigins?: Readonly<
    Record<string, { readonly source: string; readonly sourceRef?: string }>
  >
}

export interface RalphTuiSettingsApplyResult {
  readonly effect: "new-run-draft-only"
  readonly draftRevision: number
  /** The caller may pass this to its pre-run command-owned orchestration path. */
  readonly invocation: SettingsPreRunInvocation
}

export interface RalphTuiSettingsSaveResult {
  readonly effect: "future-runs-only"
  readonly scope: SettingsPaletteScope
  readonly mutation: SettingsConfigMutation
}

export type RalphTuiSettingsPort = SettingsPalettePort<
  RalphTuiSettingsApplyResult,
  RalphTuiSettingsSaveResult
>

export type RalphTuiSettingsController = SettingsPaletteController<
  RalphTuiSettingsApplyResult,
  RalphTuiSettingsSaveResult
>

function settingsAdapterError(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new RalphError(code, message, {
    exitCode: EXIT_CODES.invalidUsage,
    ...(details ? { details: { ...details } } : {}),
  })
}

function clonePaletteValue(value: SettingsJsonValue): SettingsPaletteJsonValue {
  return structuredClone(value) as SettingsPaletteJsonValue
}

function paletteField(state: SettingsFieldState): SettingsPaletteField {
  const field = state.field
  return {
    id: field.id,
    label: field.label,
    category: field.category,
    kind: field.kind,
    help: field.help,
    impact: field.impact,
    target: field.target,
    required: field.required,
    secret: field.secret,
    editable: !field.secret,
    ...(field.configPath ? { configPath: field.configPath } : {}),
    ...(field.cliFlag ? { cliFlag: field.cliFlag } : {}),
    ...(field.choices ? { choices: [...field.choices] } : {}),
    ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
    ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
    ...(field.visibleWhen
      ? {
          visibleWhen: {
            fieldId: field.visibleWhen.fieldId,
            values: [...field.visibleWhen.values],
          },
        }
      : {}),
  }
}

function paletteFieldState(
  state: SettingsFieldState,
  draft: SettingsDraft,
  initialValues: ReadonlyMap<string, SettingsJsonValue>,
  initialOrigins: Readonly<
    Record<string, { readonly source: string; readonly sourceRef?: string }>
  >,
): SettingsPaletteFieldState {
  const change = draft.changes.find((candidate) => candidate.fieldId === state.field.id)
  const hasInitialValue = initialValues.has(state.field.id)
  const initialValue = initialValues.get(state.field.id)
  const initialOrigin = initialOrigins[state.field.id]
  const value = change !== undefined ? change.value : hasInitialValue ? initialValue : state.value
  const masked = state.field.secret
  return {
    field: paletteField(state),
    displayValue: masked ? SETTINGS_PALETTE_MASK : formatSettingsPaletteValue(value),
    masked,
    changed: change !== undefined,
    source:
      change !== undefined
        ? "draft"
        : hasInitialValue
          ? (initialOrigin?.source ?? "cli")
          : state.source,
    ...(change !== undefined
      ? { sourceRef: `draft revision ${draft.revision}` }
      : hasInitialValue
        ? { sourceRef: initialOrigin?.sourceRef ?? "initial command invocation" }
        : state.sourceRef
          ? { sourceRef: state.sourceRef }
          : {}),
    ...(!masked && value !== undefined ? { value: clonePaletteValue(value) } : {}),
  }
}

function paletteSnapshot(
  config: EffectiveConfig,
  draft: SettingsDraft,
  initialValues: ReadonlyMap<string, SettingsJsonValue>,
  initialOrigins: Readonly<
    Record<string, { readonly source: string; readonly sourceRef?: string }>
  >,
): SettingsPaletteSnapshot {
  const fields = settingsCommandModel
    .list(config)
    .map((state) => paletteFieldState(state, draft, initialValues, initialOrigins))
  return {
    schemaVersion: 1,
    mode: draft.mode,
    draftRevision: draft.revision,
    fields,
    changedFieldIds: draft.changes.map((change) => change.fieldId),
  }
}

function initialInvocationValues(
  invocation: SettingsPreRunInvocation | undefined,
): ReadonlyMap<string, SettingsJsonValue> {
  const values = new Map<string, SettingsJsonValue>()
  if (!invocation) return values
  const run = invocation.runOptions
  const mappings: readonly [string, unknown][] = [
    ["defaultMode", run.mode],
    ["executorProfile", run.executorProfile],
    ["judgeProfile", run.judgeProfile],
    ["executorProvider", run.executorProvider],
    ["executorModel", run.executorModel],
    ["executorCredential", run.executorCredential],
    ["executorVariant", run.executorVariant],
    ["executorParameters", run.executorParameters],
    ["judgeProvider", run.judgeProvider],
    ["judgeModel", run.judgeModel],
    ["judgeCredential", run.judgeCredential],
    ["judgeVariant", run.judgeVariant],
    ["judgeParameters", run.judgeParameters],
    ["task", run.task],
    ["force", run.force],
    ["dryRun", run.dryRun],
    ["skipTests", run.skipTests],
    ["skipLint", run.skipLint],
    ["skipGates", run.skipGates],
    ["noGates", run.noGates],
    ["fast", run.fast],
    ["noCommit", run.noCommit],
    ["failFast", run.failFast],
    ["maxTasks", run.maxTasks],
    ["retryDelaySeconds", run.delayMs === undefined ? undefined : run.delayMs / 1_000],
    ["maxIterations", run.maxIterations],
    ["maxModelCalls", run.maxModelCallsPerAttempt],
    ["noChangeMaxAttempts", run.maxNoChangeAttempts],
    ["noChangePolicy", run.noChangePolicy],
    ["evaluationMode", run.evaluationMode],
    ["judgeThreshold", run.judgeThreshold],
    ["maxRevisionAttempts", run.maxRevisionAttempts],
    ["judgeCallRetries", run.judgeCallRetries],
    ["judgeUnavailablePolicy", run.judgeUnavailablePolicy],
    ["blockingJudgeSeverities", run.blockingJudgeSeverities],
    ["judgeRubric", run.judgeRubric],
    ["judgeExhaustedPolicy", run.judgeExhaustedPolicy],
    ["securityMode", run.securityMode],
    ["headlessAsk", run.headlessAsk],
    ["toolRules", run.toolRules],
    ["allowedCommands", run.allowedCommands],
    ["readPaths", run.readPaths],
    ["writePaths", run.writePaths],
    ["allowShell", run.allowShell],
    ["prd", invocation.prd],
    ["defaultUi", invocation.ui],
    ["language", invocation.lang],
  ]
  for (const [fieldId, value] of mappings) {
    if (value !== undefined) values.set(fieldId, structuredClone(value) as SettingsJsonValue)
  }
  return values
}

function displayCommand(argumentsValue: readonly string[]): string {
  return argumentsValue.map((argument) => JSON.stringify(argument)).join(" ")
}

function palettePreviewEntry(
  entry: SettingsDraftPreview["entries"][number],
  states: ReadonlyMap<string, SettingsFieldState>,
): SettingsPalettePreviewEntry {
  const secret = states.get(entry.fieldId)?.field.secret ?? false
  return {
    fieldId: entry.fieldId,
    displayValue: secret ? SETTINGS_PALETTE_MASK : formatSettingsPaletteValue(entry.value),
    masked: secret,
    ...(!secret ? { value: clonePaletteValue(entry.value) } : {}),
    ...(!secret && entry.configPath ? { configPath: entry.configPath } : {}),
    ...(!secret && entry.configCommand ? { configCommand: entry.configCommand } : {}),
    runArguments: secret ? [] : [...entry.runArguments],
    runOverrideAvailable: !secret && entry.runOverrideAvailable,
  }
}

function palettePreview(
  source: SettingsDraftPreview,
  config: EffectiveConfig,
  draftRevision: number,
): SettingsPalettePreview {
  const states = new Map(
    settingsCommandModel.list(config).map((state) => [state.field.id, state] as const),
  )
  const entries = source.entries.map((entry) => palettePreviewEntry(entry, states))
  const containsMaskedEntry = entries.some((entry) => entry.masked)
  const runArguments = entries.flatMap((entry) => entry.runArguments)
  const configCommands = entries.flatMap((entry) =>
    entry.configCommand ? [entry.configCommand] : [],
  )
  const applyForRunUnavailableReason = containsMaskedEntry
    ? "Secret-bearing settings cannot be applied from the TUI."
    : source.applyForRunUnavailableReason
  return {
    schemaVersion: 1,
    mode: source.mode,
    scope: source.scope,
    draftRevision,
    entries,
    configCommands,
    runArguments,
    runCommand: displayCommand(["ralph-next", "run", ...runArguments]),
    applyForRunAvailable: source.applyForRunAvailable && !containsMaskedEntry,
    ...(applyForRunUnavailableReason ? { applyForRunUnavailableReason } : {}),
    saveEffect: "future-runs-only",
  }
}

/**
 * Adapts the shared command model to the format-neutral TUI port. The concrete
 * draft stays in this closure; the renderer cannot bypass validation or write a
 * configuration file directly.
 */
export function createRalphTuiSettingsPort(options: RalphTuiSettingsOptions): RalphTuiSettingsPort {
  const environment = options.environment ? { ...options.environment } : undefined
  let draft = settingsCommandModel.createDraft(options.mode)
  const initialValues = initialInvocationValues(options.initialInvocation)
  const initialOrigins = options.initialOrigins ?? {}
  let effectiveConfig: EffectiveConfig | undefined

  async function loadConfig(force = false): Promise<EffectiveConfig> {
    if (!force && effectiveConfig) return effectiveConfig
    effectiveConfig = await loadEffectiveConfig({
      ...(options.workspaceRoot
        ? { workspaceConfig: workspaceLayout(options.workspaceRoot).config }
        : {}),
      ...(environment ? { environment } : {}),
    })
    return effectiveConfig
  }

  function assertRevision(expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      settingsAdapterError(
        "RALPH_TUI_SETTINGS_REVISION_INVALID",
        "Settings draft revision must be a non-negative safe integer",
        { expectedRevision },
      )
    }
    if (expectedRevision !== draft.revision) {
      settingsAdapterError(
        "RALPH_TUI_SETTINGS_DRAFT_STALE",
        "The settings popup is stale; reload it before retrying the mutation",
        { expectedRevision, actualRevision: draft.revision },
      )
    }
  }

  async function snapshot(forceConfigReload = false): Promise<SettingsPaletteSnapshot> {
    return paletteSnapshot(
      await loadConfig(forceConfigReload),
      draft,
      initialValues,
      initialOrigins,
    )
  }

  return {
    async load() {
      return snapshot(true)
    },

    async update(request: SettingsPaletteUpdateRequest) {
      assertRevision(request.expectedRevision)
      const config = await loadConfig()
      const field = settingsCommandModel.explain(request.fieldId, config).field
      const value =
        request.input === "text" ? decodeSettingsValue(field, request.text) : request.value
      draft = settingsCommandModel.updateDraft(draft, field.id, value)
      return paletteSnapshot(config, draft, initialValues, initialOrigins)
    },

    async preview(request) {
      assertRevision(request.expectedRevision)
      const config = await loadConfig()
      return palettePreview(
        settingsCommandModel.preview(draft, request.scope),
        config,
        draft.revision,
      )
    },

    async applyForRun(request) {
      assertRevision(request.expectedRevision)
      if (draft.mode !== "pre-run") {
        settingsAdapterError(
          "RALPH_TUI_SETTINGS_APPLY_UNAVAILABLE",
          "Attach and replay settings are read-only for the persisted run; save defaults for future runs instead",
          { mode: draft.mode },
        )
      }
      const invocation = settingsCommandModel.applyForRun(draft)
      return {
        effect: "new-run-draft-only",
        draftRevision: draft.revision,
        invocation,
      }
    },

    async saveDefaults(request): Promise<SettingsPaletteSaveResponse<RalphTuiSettingsSaveResult>> {
      assertRevision(request.expectedRevision)
      const mutation = await settingsCommandModel.saveDefaults({
        draft,
        scope: request.scope,
        ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(environment ? { environment } : {}),
      })

      const nextRevision = draft.revision + 1
      draft = { ...settingsCommandModel.createDraft(draft.mode), revision: nextRevision }
      const nextSnapshot = await snapshot(true)
      return {
        effect: "future-runs-only",
        snapshot: nextSnapshot,
        result: {
          effect: "future-runs-only",
          scope: request.scope,
          mutation,
        },
      }
    },
  }
}

/** Convenience factory for wiring directly into a dashboard popup. */
export function createRalphTuiSettingsController(
  options: RalphTuiSettingsOptions,
): RalphTuiSettingsController {
  return createSettingsPaletteController(createRalphTuiSettingsPort(options), {
    scope: options.initialScope ?? (options.workspaceRoot ? "workspace" : "global"),
  })
}
