import {
  DEFAULT_CONFIG,
  type EffectiveConfig,
  EXIT_CODES,
  type ProfileParameters,
  ProfileParametersSchema,
  RalphConfigLayerSchema,
  RalphError,
} from "@ralph/domain"
import type { RunOptionOverrides } from "@ralph/orchestration"
import {
  inspectWorkspace,
  type SettingsConfigMutation,
  type SettingsConfigPatch,
  type SettingsConfigScope,
  writeSettingsConfig,
} from "@ralph/persistence"
import {
  EVALUATION_SETTINGS_METADATA,
  EXECUTION_SECURITY_SETTINGS_METADATA,
  type SettingsFieldMetadata,
} from "./settings"

export type SettingsCategory =
  | "invocation"
  | "executor"
  | "judge"
  | "run"
  | "verification"
  | "watchdog"
  | "parallel"
  | "telemetry"
  | "tui"
  | "security"
  | "sandbox"
  | "git"

export type SettingsFieldTarget = "config-only" | "config-and-run" | "run-only"

export type SettingsJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SettingsJsonValue[]
  | { readonly [key: string]: SettingsJsonValue }

export type SettingsCommandField = Omit<SettingsFieldMetadata, "configPath"> & {
  category: SettingsCategory
  target: SettingsFieldTarget
  configPath?: string
  impact: string
  /** Optional inverse flag. Without it, false has no exact per-run CLI override. */
  cliFalseFlag?: string
}

export type SettingsDraftMode = "pre-run" | "attach" | "replay"

export type SettingsDraftChange = {
  fieldId: string
  value: SettingsJsonValue
}

export type SettingsDraft = {
  schemaVersion: 1
  mode: SettingsDraftMode
  revision: number
  changes: readonly SettingsDraftChange[]
}

export type SettingsFieldState = {
  field: SettingsCommandField
  value?: SettingsJsonValue
  source:
    | "builtin"
    | "global"
    | "workspace"
    | "env"
    | "profile"
    | "prd"
    | "task"
    | "cli"
    | "draft"
    | "unavailable"
  sourceRef?: string
}

export type SettingsPreviewEntry = {
  fieldId: string
  value: SettingsJsonValue
  configPath?: string
  configCommand?: string
  runArguments: readonly string[]
  runOverrideAvailable: boolean
}

export type SettingsDraftPreview = {
  schemaVersion: 1
  mode: SettingsDraftMode
  scope: SettingsConfigScope
  configPatch: SettingsConfigPatch
  configCommands: readonly string[]
  runArguments: readonly string[]
  runCommand: string
  entries: readonly SettingsPreviewEntry[]
  applyForRunAvailable: boolean
  applyForRunUnavailableReason?: string
}

export type SettingsPreRunInvocation = {
  schemaVersion: 1
  runOptions: RunOptionOverrides
  prd?: string
  ui?: string
  lang?: string
  cliArguments: readonly string[]
}

export type SaveSettingsDefaultsRequest = {
  draft: SettingsDraft
  scope: SettingsConfigScope
  workspaceRoot?: string
  environment?: Record<string, string | undefined>
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"])
const MAX_SETTINGS_VALUE_BYTES = 64 * 1_024
const MAX_SETTINGS_DEPTH = 24

function metadataById(id: string): SettingsFieldMetadata {
  const found = [...EVALUATION_SETTINGS_METADATA, ...EXECUTION_SECURITY_SETTINGS_METADATA].find(
    (candidate) => candidate.id === id,
  )
  if (!found) throw new Error(`Missing shared settings metadata: ${id}`)
  return found
}

function fieldFromMetadata(
  id: string,
  input: Pick<SettingsCommandField, "category" | "target" | "impact"> & {
    configPath?: string
    cliFalseFlag?: string
  },
): SettingsCommandField {
  const source = metadataById(id)
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    cliFlag: source.cliFlag,
    ...(source.cliAliases ? { cliAliases: source.cliAliases } : {}),
    ...(source.effectiveOptionKey ? { effectiveOptionKey: source.effectiveOptionKey } : {}),
    required: source.required,
    secret: source.secret,
    ...(source.choices ? { choices: source.choices } : {}),
    ...(source.defaultValue !== undefined ? { defaultValue: source.defaultValue } : {}),
    ...(source.minimum !== undefined ? { minimum: source.minimum } : {}),
    ...(source.maximum !== undefined ? { maximum: source.maximum } : {}),
    ...(source.visibleWhen ? { visibleWhen: source.visibleWhen } : {}),
    help: source.help,
    category: input.category,
    target: input.target,
    impact: input.impact,
    ...(input.configPath ? { configPath: input.configPath } : {}),
    ...(input.cliFalseFlag ? { cliFalseFlag: input.cliFalseFlag } : {}),
  }
}

const ADDITIONAL_SETTINGS_FIELDS: readonly SettingsCommandField[] = [
  {
    id: "defaultMode",
    label: "Run mode",
    kind: "select",
    configPath: "defaults.mode",
    cliFlag: "--mode",
    required: true,
    secret: false,
    choices: ["once", "loop", "wiggum", "parallel"],
    defaultValue: DEFAULT_CONFIG.defaults.mode,
    help: "Select the default orchestration mode for future runs.",
    category: "run",
    target: "config-and-run",
    impact: "Changes how Ralph selects and repeats eligible tasks.",
  },
  {
    id: "executorProfile",
    label: "Executor profile",
    kind: "reference",
    configPath: "defaults.executor_profile",
    cliFlag: "--executor-profile",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.defaults.executor_profile,
    help: "Select a configured role=executor profile.",
    category: "executor",
    target: "config-and-run",
    impact: "Changes the provider/model route used to execute work.",
  },
  {
    id: "defaultUi",
    label: "UI mode",
    kind: "select",
    configPath: "defaults.ui",
    cliFlag: "--ui",
    required: true,
    secret: false,
    choices: ["auto", "tui", "plain", "none"],
    defaultValue: DEFAULT_CONFIG.defaults.ui,
    help: "Select whether a new invocation opens the TUI or uses plain output.",
    category: "tui",
    target: "config-and-run",
    impact: "Changes presentation only; it does not transfer control to the model.",
  },
  {
    id: "language",
    label: "Language",
    kind: "text",
    configPath: "defaults.lang",
    cliFlag: "--lang",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.defaults.lang,
    help: "Set the locale for future human-facing output.",
    category: "tui",
    target: "config-and-run",
    impact: "Changes translated labels and messages where a locale is available.",
  },
  {
    id: "runResume",
    label: "Resume by default",
    kind: "toggle",
    configPath: "run.resume",
    cliFlag: "--resume",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.run.resume,
    help: "Allow future invocations to discover compatible resumable runs.",
    category: "run",
    target: "config-only",
    impact: "Affects run discovery; it never rewrites an existing run snapshot.",
  },
  {
    id: "runMaxAttempts",
    label: "Maximum executor attempts",
    kind: "integer",
    configPath: "run.max_attempts",
    cliFlag: "--max-attempts",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.run.max_attempts,
    minimum: 1,
    help: "Bound ordinary executor attempts for future runs.",
    category: "run",
    target: "config-only",
    impact:
      "Limits repeated executor work independently from judge revisions and watchdog restarts.",
  },
  {
    id: "retryDelaySeconds",
    label: "Retry delay (seconds)",
    kind: "number",
    configPath: "run.retry_delay_seconds",
    cliFlag: "--retry-delay",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.run.retry_delay_seconds,
    minimum: 0,
    help: "Wait this many seconds between bounded executor attempts.",
    category: "run",
    target: "config-and-run",
    impact: "Changes retry pacing without changing retry budgets.",
  },
  {
    id: "includeProgressContext",
    label: "Include progress context",
    kind: "toggle",
    configPath: "run.include_progress_context",
    cliFlag: "--include-progress-context",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.run.include_progress_context,
    help: "Include bounded progress context in future executor calls.",
    category: "run",
    target: "config-only",
    impact: "May increase context size while carrying prior task progress.",
  },
  {
    id: "includeRepoMapContext",
    label: "Include repository map",
    kind: "toggle",
    configPath: "run.include_repo_map_context",
    cliFlag: "--include-repo-map-context",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.run.include_repo_map_context,
    help: "Include a bounded repository map in future executor calls.",
    category: "run",
    target: "config-only",
    impact: "May improve navigation while consuming additional context.",
  },
  {
    id: "noChangePolicy",
    label: "No-change policy",
    kind: "select",
    configPath: "run.no_change.policy",
    cliFlag: "--no-change-policy",
    required: true,
    secret: false,
    choices: ["fallback", "retry", "fail-fast"],
    defaultValue: DEFAULT_CONFIG.run.no_change.policy,
    help: "Choose the bounded response when an attempt produces no material change.",
    category: "verification",
    target: "config-and-run",
    impact: "Controls fallback/retry/failure without treating a model claim as evidence.",
  },
  {
    id: "noChangeMaxAttempts",
    label: "No-change maximum attempts",
    kind: "integer",
    configPath: "run.no_change.max_attempts",
    cliFlag: "--no-change-max-retries",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.run.no_change.max_attempts,
    minimum: 0,
    help: "Bound attempts consumed by the no-change policy.",
    category: "verification",
    target: "config-and-run",
    impact: "Prevents an unproductive task from looping indefinitely.",
  },
  {
    id: "noChangeStopOnExhausted",
    label: "Stop on no-change exhaustion",
    kind: "toggle",
    configPath: "run.no_change.stop_on_exhausted",
    cliFlag: "--stop-on-no-change-exhausted",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.run.no_change.stop_on_exhausted,
    help: "Stop future runs after the no-change budget is exhausted.",
    category: "verification",
    target: "config-only",
    impact: "Keeps exhaustion explicit instead of silently advancing work.",
  },
  {
    id: "allowNoGates",
    label: "Allow no-gates override",
    kind: "toggle",
    configPath: "verification.allow_no_gates",
    cliFlag: "--no-gates",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.verification.allow_no_gates,
    help: "Authorize future invocations to request an audited no-gates override.",
    category: "verification",
    target: "config-only",
    impact: "Changes authorization only; a run must still request --no-gates explicitly.",
  },
  {
    id: "watchdogEnabled",
    label: "Watchdog enabled",
    kind: "toggle",
    configPath: "watchdog.enabled",
    cliFlag: "--watchdog",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.watchdog.enabled,
    help: "Enable multi-signal liveness supervision for future attempts.",
    category: "watchdog",
    target: "config-only",
    impact:
      "Enables observation and configured recovery actions; normal processing delay is not enough to declare a stall.",
  },
  ...(
    [
      "heartbeat_interval",
      "heartbeat_grace",
      "quiet_after",
      "slow_after",
      "suspect_after",
      "probe_interval",
    ] as const
  ).map(
    (key): SettingsCommandField => ({
      id: `watchdog.${key}`,
      label: `Watchdog ${key.replaceAll("_", " ")}`,
      kind: "text",
      configPath: `watchdog.${key}`,
      cliFlag: `--watchdog-${key.replaceAll("_", "-")}`,
      required: true,
      secret: false,
      defaultValue: DEFAULT_CONFIG.watchdog[key],
      help: `Configure watchdog ${key.replaceAll("_", " ")} for future attempts.`,
      category: "watchdog",
      target: "config-only",
      impact: "Changes liveness timing while preserving multi-signal confirmation.",
    }),
  ),
  {
    id: "watchdog.hard_timeout",
    label: "Watchdog hard timeout",
    kind: "text",
    configPath: "watchdog.hard_timeout",
    cliFlag: "--watchdog-hard-timeout",
    required: false,
    secret: false,
    defaultValue: DEFAULT_CONFIG.watchdog.hard_timeout,
    help: "Set a hard phase deadline or null to disable it.",
    category: "watchdog",
    target: "config-only",
    impact: "A hard timeout can trigger recovery even when other signals continue.",
  },
  {
    id: "watchdog.confirmations",
    label: "Watchdog confirmations",
    kind: "integer",
    configPath: "watchdog.confirmations",
    cliFlag: "--watchdog-confirmations",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.watchdog.confirmations,
    minimum: 1,
    help: "Require this many suspect observations before recovery.",
    category: "watchdog",
    target: "config-only",
    impact: "Higher values reduce false recovery at the cost of slower detection.",
  },
  {
    id: "watchdog.action",
    label: "Watchdog recovery action",
    kind: "select",
    configPath: "watchdog.action",
    cliFlag: "--watchdog-action",
    required: true,
    secret: false,
    choices: ["notify", "cancel", "restart-attempt", "stop-run"],
    defaultValue: DEFAULT_CONFIG.watchdog.action,
    help: "Select the bounded action after a confirmed stall.",
    category: "watchdog",
    target: "config-only",
    impact: "Controls recovery while keeping judge revisions and watchdog restarts separate.",
  },
  {
    id: "watchdog.max_restarts",
    label: "Watchdog maximum restarts",
    kind: "integer",
    configPath: "watchdog.max_restarts",
    cliFlag: "--watchdog-max-restarts",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.watchdog.max_restarts,
    minimum: 0,
    help: "Bound restart-attempt actions per task.",
    category: "watchdog",
    target: "config-only",
    impact: "Prevents recovery from becoming an unbounded retry loop.",
  },
  {
    id: "watchdog.phases",
    label: "Watchdog phase overrides",
    kind: "json",
    configPath: "watchdog.phases",
    cliFlag: "--watchdog-phases",
    required: true,
    secret: false,
    help: "Override watchdog settings for model-call, tool, gate, judge, child or integration phases.",
    category: "watchdog",
    target: "config-only",
    impact: "Applies stricter or slower phase-specific liveness policy.",
  },
  {
    id: "parallelMax",
    label: "Maximum parallel workers",
    kind: "integer",
    configPath: "parallel.max_parallel",
    cliFlag: "--max-parallel",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.parallel.max_parallel,
    minimum: 1,
    help: "Bound concurrent work for future parallel runs.",
    category: "parallel",
    target: "config-only",
    impact: "Increases throughput and resource usage while preserving isolated task ownership.",
  },
  {
    id: "parallelIntegrationStrategy",
    label: "Integration strategy",
    kind: "select",
    configPath: "parallel.integration_strategy",
    cliFlag: "--integration",
    required: true,
    secret: false,
    choices: ["no-merge", "none", "merge", "rebase-merge", "cherry-pick", "create-pr"],
    defaultValue: DEFAULT_CONFIG.parallel.integration_strategy,
    help: "Select how isolated parallel results are integrated.",
    category: "parallel",
    target: "config-only",
    impact:
      "Controls integration; conflicts remain explicit and are never resolved by a blanket ours/theirs policy.",
  },
  ...(
    [
      ["parallelGlobalMax", "Maximum global workers", "parallel.max_global", "max_global", 1],
      [
        "parallelFailureRetries",
        "Maximum failed-task retries",
        "parallel.max_failure_retries",
        "max_failure_retries",
        0,
      ],
    ] as const
  ).map(
    ([id, label, configPath, key, minimum]): SettingsCommandField => ({
      id,
      label,
      kind: "integer",
      configPath,
      cliFlag: `--${configPath.split(".")[1]?.replaceAll("_", "-") ?? id}`,
      required: true,
      secret: false,
      defaultValue: DEFAULT_CONFIG.parallel[key],
      minimum,
      help: `${label} for durable parallel scheduling.`,
      category: "parallel",
      target: "config-only",
      impact: "Bounds command-owned scheduling without granting the model dispatch authority.",
    }),
  ),
  ...(
    [
      ["parallelAuto", "Automatic structural parallel eligibility", "parallel.auto", "auto"],
      [
        "parallelRequireIsolation",
        "Require isolated workspace",
        "parallel.require_isolation",
        "require_isolation",
      ],
      [
        "parallelRetryFailed",
        "Retry failed parallel tasks",
        "parallel.retry_failed",
        "retry_failed",
      ],
      ["parallelFailFast", "Drain on first parallel failure", "parallel.fail_fast", "fail_fast"],
    ] as const
  ).map(
    ([id, label, configPath, key]): SettingsCommandField => ({
      id,
      label,
      kind: "toggle",
      configPath,
      cliFlag: `--${configPath.split(".")[1]?.replaceAll("_", "-") ?? id}`,
      required: true,
      secret: false,
      defaultValue: DEFAULT_CONFIG.parallel[key],
      help: `${label} for future parallel runs.`,
      category: "parallel",
      target: "config-only",
      impact: "Changes deterministic scheduler admission or draining policy.",
    }),
  ),
  {
    id: "parallelAllowedGroups",
    label: "Allowed parallel groups",
    kind: "json",
    configPath: "parallel.allowed_groups",
    cliFlag: "--parallel-group",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.parallel.allowed_groups,
    help: "List explicitly admitted PRD parallel-group identifiers.",
    category: "parallel",
    target: "config-only",
    impact:
      "Restricts worker admission to structurally declared groups unless parallel-auto is enabled.",
  },
  ...(
    [
      [
        "persistRawOutput",
        "Persist raw output",
        "telemetry.persist_raw_output",
        "persist_raw_output",
      ],
      ["telemetryRedact", "Redact telemetry", "telemetry.redact", "redact"],
    ] as const
  ).map(
    ([id, label, configPath, key]): SettingsCommandField => ({
      id,
      label,
      kind: "toggle",
      configPath,
      cliFlag: `--${configPath.replaceAll(".", "-").replaceAll("_", "-")}`,
      required: true,
      secret: false,
      defaultValue: DEFAULT_CONFIG.telemetry[key],
      help:
        id === "telemetryRedact"
          ? "Mandatory persistence redaction remains active; false disables optional raw captures for future runs."
          : "Persist redacted diagnostic raw output for future runs.",
      category: "telemetry",
      target: "config-only",
      impact:
        id === "telemetryRedact"
          ? "Fails closed without weakening event, log, settlement or report redaction."
          : "Changes local observability storage without granting models additional authority.",
    }),
  ),
  {
    id: "eventRetention",
    label: "Event retention",
    kind: "text",
    configPath: "telemetry.event_retention",
    cliFlag: "--event-retention",
    required: false,
    secret: false,
    defaultValue: DEFAULT_CONFIG.telemetry.event_retention,
    help: "Use a positive duration such as 30m, 24h or 30d; null adds no age expiration.",
    category: "telemetry",
    target: "config-only",
    impact: "Changes event/raw age while safe quantity and byte budgets remain active.",
  },
  {
    id: "tuiTheme",
    label: "TUI theme",
    kind: "select",
    configPath: "tui.theme",
    cliFlag: "--theme",
    required: true,
    secret: false,
    choices: ["dark", "light", "high-contrast", "monochrome", "system"],
    defaultValue: DEFAULT_CONFIG.tui.theme,
    help: "Select the visual theme for future TUI sessions.",
    category: "tui",
    target: "config-only",
    impact: "Changes appearance only; OpenCode branding and logos are not copied.",
  },
  {
    id: "tuiAscii",
    label: "ASCII rendering",
    kind: "toggle",
    configPath: "tui.ascii",
    cliFlag: "--ascii",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.tui.ascii,
    help: "Use ASCII-safe borders and progress glyphs.",
    category: "tui",
    target: "config-only",
    impact: "Improves compatibility with terminals that cannot render Unicode reliably.",
  },
  {
    id: "tuiKeybindings",
    label: "TUI keybindings",
    kind: "json",
    configPath: "tui.keybindings",
    cliFlag: "--keybindings",
    required: true,
    secret: false,
    help: "Map safe action IDs to terminal key expressions.",
    category: "tui",
    target: "config-only",
    impact: "Remaps UI input without changing execution policy.",
  },
  ...(
    [
      ["sandboxEnabled", "Sandbox enabled", "sandbox.enabled", "enabled"],
      ["gitBranchPerTask", "Branch per task", "git.branch_per_task", "branch_per_task"],
      ["gitCreatePr", "Create pull request", "git.create_pr", "create_pr"],
      ["gitDraftPr", "Create draft pull request", "git.draft_pr", "draft_pr"],
      ["gitAutoCheckpoints", "Automatic checkpoints", "git.auto_checkpoints", "auto_checkpoints"],
      [
        "gitCheckpointBeforeTask",
        "Checkpoint before task",
        "git.checkpoint_before_task",
        "checkpoint_before_task",
      ],
      [
        "gitCheckpointAfterTask",
        "Checkpoint after task",
        "git.checkpoint_after_task",
        "checkpoint_after_task",
      ],
    ] as const
  ).map(([id, label, configPath, key]): SettingsCommandField => {
    const section = configPath.startsWith("sandbox.") ? "sandbox" : "git"
    const defaultValue =
      section === "sandbox"
        ? DEFAULT_CONFIG.sandbox.enabled
        : DEFAULT_CONFIG.git[key as keyof typeof DEFAULT_CONFIG.git]
    return {
      id,
      label,
      kind: "toggle",
      configPath,
      cliFlag: `--${configPath.split(".")[1]?.replaceAll("_", "-") ?? id}`,
      required: true,
      secret: false,
      defaultValue: defaultValue as boolean,
      help: `${label} for future runs.`,
      category: section,
      target: "config-only",
      impact:
        section === "sandbox"
          ? "Changes process isolation policy."
          : "Changes explicit Git automation policy.",
    }
  }),
  {
    id: "sandboxProvider",
    label: "Sandbox provider",
    kind: "select",
    configPath: "sandbox.provider",
    cliFlag: "--sandbox-provider",
    required: true,
    secret: false,
    choices: ["process", "docker", "podman"],
    defaultValue: DEFAULT_CONFIG.sandbox.provider,
    help: "Select the configured sandbox implementation.",
    category: "sandbox",
    target: "config-only",
    impact: "Changes how child execution is isolated when sandboxing is enabled.",
  },
  ...(
    [
      ["sandboxImage", "Sandbox image", "sandbox.image", "--sandbox-image"],
      ["sandboxNetwork", "Sandbox network", "sandbox.network", "--sandbox-network"],
      ["gitBaseBranch", "Git base branch", "git.base_branch", "--base-branch"],
    ] as const
  ).map(
    ([id, label, configPath, cliFlag]): SettingsCommandField => ({
      id,
      label,
      kind: "text",
      configPath,
      cliFlag,
      required: false,
      secret: false,
      help: `${label} used by future runs, or null to leave it unset.`,
      category: configPath.startsWith("sandbox.") ? "sandbox" : "git",
      target: "config-only",
      impact: configPath.startsWith("sandbox.")
        ? "Changes the selected isolation environment."
        : "Changes the branch used as the explicit integration base.",
    }),
  ),
  ...(
    [
      ["prd", "PRD path", "--prd", "Select the root PRD for the new invocation."],
      ["task", "Task", "--task", "Select one task for the new invocation."],
      [
        "executorProvider",
        "Executor provider override",
        "--executor-provider",
        "Override the executor provider only for the new run.",
      ],
      [
        "executorModel",
        "Executor model override",
        "--executor-model",
        "Override the executor model only for the new run.",
      ],
      [
        "executorCredential",
        "Executor credential reference",
        "--executor-credential",
        "Select a non-secret executor credential reference for the new run.",
      ],
      [
        "executorVariant",
        "Executor model variant",
        "--executor-variant",
        "Override the executor model variant only for the new run.",
      ],
    ] as const
  ).map(
    ([id, label, cliFlag, help]): SettingsCommandField => ({
      id,
      label,
      kind: id === "prd" || id === "task" ? "text" : "reference",
      cliFlag,
      required: false,
      secret: false,
      help,
      category: id === "prd" || id === "task" ? "invocation" : "executor",
      target: "run-only",
      impact: "Affects only the not-yet-persisted invocation draft.",
    }),
  ),
  ...(
    [
      [
        "executorParameters",
        "Executor model parameters",
        "--executor-parameter",
        "Replace the executor parameter map for the new run; an empty object clears it.",
        "executor",
      ],
      [
        "judgeParameters",
        "Judge model parameters",
        "--judge-parameter",
        "Replace the judge parameter map for the new run; an empty object clears it.",
        "judge",
      ],
    ] as const
  ).map(
    ([id, label, cliFlag, help, category]): SettingsCommandField => ({
      id,
      label,
      kind: "json",
      cliFlag,
      required: true,
      secret: false,
      defaultValue: {},
      help,
      category,
      target: "run-only",
      impact: "Replaces, rather than merges, the selected role's explicit parameter map.",
      ...(category === "judge"
        ? { visibleWhen: { fieldId: "evaluationMode", values: ["external"] } }
        : {}),
    }),
  ),
  ...(
    [
      ["force", "Force audited override", "--force"],
      ["dryRun", "Dry run", "--dry-run"],
      ["skipTests", "Skip test gates", "--skip-tests"],
      ["skipLint", "Skip lint gates", "--skip-lint"],
      ["noGates", "Skip all gates", "--no-gates"],
      ["fast", "Fast mode", "--fast"],
      ["noCommit", "Do not commit", "--no-commit"],
      ["failFast", "Fail fast", "--fail-fast"],
    ] as const
  ).map(
    ([id, label, cliFlag]): SettingsCommandField => ({
      id,
      label,
      kind: "toggle",
      cliFlag,
      required: true,
      secret: false,
      defaultValue: false,
      help: `${label} for the new invocation only.`,
      category:
        id === "skipTests" || id === "skipLint" || id === "noGates" ? "verification" : "run",
      target: "run-only",
      impact: "Affects only a new run and is captured in its immutable effective-options snapshot.",
    }),
  ),
  {
    id: "skipGates",
    label: "Skipped gates",
    kind: "multi-select",
    cliFlag: "--skip-gates",
    required: true,
    secret: false,
    defaultValue: [],
    help: "Select named gates to skip for the new invocation.",
    category: "verification",
    target: "run-only",
    impact: "Each skip remains explicit and visible in evidence/reporting.",
  },
  ...(
    [
      ["maxTasks", "Maximum tasks", "--max-tasks", 1],
      ["maxIterations", "Maximum iterations", "--max-iterations", 1],
      ["maxModelCalls", "Maximum model calls per attempt", "--max-model-calls", 1],
    ] as const
  ).map(
    ([id, label, cliFlag, minimum]): SettingsCommandField => ({
      id,
      label,
      kind: "integer",
      cliFlag,
      required: true,
      secret: false,
      minimum,
      help: `${label} for the new invocation.`,
      category: "run",
      target: "run-only",
      impact: "Adds a deterministic execution budget to the new run snapshot.",
    }),
  ),
]

const IMPORTED_SETTINGS_FIELDS: readonly SettingsCommandField[] = [
  fieldFromMetadata("evaluationMode", {
    category: "judge",
    target: "config-and-run",
    configPath: "evaluation.mode",
    impact: "Selects deterministic-only, self-review, external judge or manual review.",
  }),
  fieldFromMetadata("judgeProfile", {
    category: "judge",
    target: "config-and-run",
    configPath: "defaults.judge_profile",
    impact: "Selects an independent judge profile without changing the executor route.",
  }),
  ...(["judgeProvider", "judgeModel", "judgeCredential", "judgeVariant"] as const).map((id) =>
    fieldFromMetadata(id, {
      category: "judge",
      target: "run-only",
      impact: "Overrides only the judge route for the not-yet-persisted run.",
    }),
  ),
  ...(
    [
      ["judgeThreshold", "evaluation.threshold"],
      ["maxRevisionAttempts", "evaluation.max_revision_attempts"],
      ["judgeCallRetries", "evaluation.judge_call_retries"],
      ["judgeUnavailablePolicy", "evaluation.on_judge_unavailable"],
      ["blockingJudgeSeverities", "evaluation.blocking_severities"],
      ["judgeRubric", "evaluation.rubric"],
      ["judgeExhaustedPolicy", "evaluation.exhausted_policy"],
    ] as const
  ).map(([id, configPath]) =>
    fieldFromMetadata(id, {
      category: "judge",
      target: "config-and-run",
      configPath,
      impact: "Changes bounded evaluation policy for future or not-yet-persisted runs.",
    }),
  ),
  ...EXECUTION_SECURITY_SETTINGS_METADATA.map(
    (source): SettingsCommandField => ({
      id: source.id,
      label: source.label,
      kind: source.kind,
      cliFlag: source.cliFlag,
      required: source.required,
      secret: source.secret,
      ...(source.choices ? { choices: source.choices } : {}),
      ...(source.defaultValue !== undefined ? { defaultValue: source.defaultValue } : {}),
      ...(source.minimum !== undefined ? { minimum: source.minimum } : {}),
      ...(source.maximum !== undefined ? { maximum: source.maximum } : {}),
      help: source.help,
      category: "security",
      target: "config-and-run",
      configPath: source.configPath,
      impact: "Changes command-owned tool authorization for future or not-yet-persisted runs.",
    }),
  ),
]

export const SETTINGS_COMMAND_FIELDS: readonly SettingsCommandField[] = Object.freeze(
  [...ADDITIONAL_SETTINGS_FIELDS, ...IMPORTED_SETTINGS_FIELDS].map((field) =>
    Object.freeze({ ...field }),
  ),
)

const SETTINGS_FIELDS_BY_ID = new Map(SETTINGS_COMMAND_FIELDS.map((field) => [field.id, field]))
const SETTINGS_FIELDS_BY_CONFIG_PATH = new Map(
  SETTINGS_COMMAND_FIELDS.flatMap((field) =>
    field.configPath ? ([[field.configPath, field]] as const) : [],
  ),
)

function settingsError(code: string, message: string, details?: Record<string, unknown>): never {
  throw new RalphError(code, message, {
    exitCode: EXIT_CODES.invalidUsage,
    ...(details ? { details } : {}),
  })
}

export function settingsField(identifier: string): SettingsCommandField {
  const field =
    SETTINGS_FIELDS_BY_ID.get(identifier) ?? SETTINGS_FIELDS_BY_CONFIG_PATH.get(identifier)
  if (!field) {
    return settingsError("RALPH_SETTINGS_FIELD_UNKNOWN", `Unknown settings field: ${identifier}`, {
      identifier,
    })
  }
  return field
}

function assertJsonValue(
  value: unknown,
  path = "value",
  depth = 0,
): asserts value is SettingsJsonValue {
  if (depth > MAX_SETTINGS_DEPTH) {
    settingsError("RALPH_SETTINGS_VALUE_TOO_DEEP", "Settings value exceeds the nesting limit", {
      path,
      maximumDepth: MAX_SETTINGS_DEPTH,
    })
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJsonValue(item, `${path}[${index}]`, depth + 1)
    })
    return
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      settingsError(
        "RALPH_SETTINGS_VALUE_INVALID",
        "Settings objects must be plain JSON mappings",
        { path },
      )
    }
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        settingsError("RALPH_SETTINGS_KEY_FORBIDDEN", `Forbidden settings key: ${key}`, { path })
      }
      assertJsonValue(item, `${path}.${key}`, depth + 1)
    }
    return
  }
  settingsError("RALPH_SETTINGS_VALUE_INVALID", "Settings values must be finite JSON values", {
    path,
  })
}

function serializedSize(value: SettingsJsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function normalizeFieldValue(field: SettingsCommandField, input: unknown): SettingsJsonValue {
  assertJsonValue(input)
  if (serializedSize(input) > MAX_SETTINGS_VALUE_BYTES) {
    return settingsError(
      "RALPH_SETTINGS_VALUE_TOO_LARGE",
      "Settings value exceeds the size limit",
      {
        fieldId: field.id,
        maximumBytes: MAX_SETTINGS_VALUE_BYTES,
      },
    )
  }
  if (input === null) {
    if (field.required && field.defaultValue !== null) {
      return settingsError("RALPH_SETTINGS_VALUE_REQUIRED", `${field.label} cannot be null`, {
        fieldId: field.id,
      })
    }
    return null
  }
  if (field.kind === "toggle" && typeof input !== "boolean") {
    return settingsError("RALPH_SETTINGS_VALUE_TYPE", `${field.label} requires a boolean`)
  }
  if (field.kind === "integer" && (typeof input !== "number" || !Number.isSafeInteger(input))) {
    return settingsError("RALPH_SETTINGS_VALUE_TYPE", `${field.label} requires a safe integer`)
  }
  if (field.kind === "number" && typeof input !== "number") {
    return settingsError("RALPH_SETTINGS_VALUE_TYPE", `${field.label} requires a finite number`)
  }
  if (
    (field.kind === "select" || field.kind === "text" || field.kind === "reference") &&
    (typeof input !== "string" || (field.required && input.trim().length === 0))
  ) {
    return settingsError("RALPH_SETTINGS_VALUE_TYPE", `${field.label} requires a string`)
  }
  if (
    field.kind === "multi-select" &&
    (!Array.isArray(input) || input.some((item) => typeof item !== "string"))
  ) {
    return settingsError("RALPH_SETTINGS_VALUE_TYPE", `${field.label} requires a string array`)
  }
  if (typeof input === "number") {
    if (field.minimum !== undefined && input < field.minimum) {
      return settingsError("RALPH_SETTINGS_VALUE_RANGE", `${field.label} is below its minimum`, {
        minimum: field.minimum,
      })
    }
    if (field.maximum !== undefined && input > field.maximum) {
      return settingsError("RALPH_SETTINGS_VALUE_RANGE", `${field.label} is above its maximum`, {
        maximum: field.maximum,
      })
    }
  }
  if (field.choices) {
    const selected = Array.isArray(input) ? input : [input]
    const invalid = selected.find(
      (item) => typeof item !== "string" || !field.choices?.includes(item),
    )
    if (invalid !== undefined) {
      return settingsError(
        "RALPH_SETTINGS_VALUE_CHOICE",
        `${field.label} has an unsupported value`,
        {
          value: invalid,
          choices: field.choices,
        },
      )
    }
  }
  return structuredClone(input)
}

export function decodeSettingsValue(field: SettingsCommandField, text: string): SettingsJsonValue {
  if (new TextEncoder().encode(text).byteLength > MAX_SETTINGS_VALUE_BYTES) {
    return settingsError(
      "RALPH_SETTINGS_VALUE_TOO_LARGE",
      "Settings input exceeds the size limit",
      {
        fieldId: field.id,
        maximumBytes: MAX_SETTINGS_VALUE_BYTES,
      },
    )
  }
  let candidate: unknown
  if (field.kind === "text" || field.kind === "reference" || field.kind === "select") {
    if (text === "null") candidate = null
    else if (text.startsWith('"')) {
      try {
        candidate = JSON.parse(text)
      } catch {
        return settingsError(
          "RALPH_SETTINGS_VALUE_JSON_INVALID",
          "Quoted setting value is invalid JSON",
        )
      }
    } else candidate = text
  } else if (field.kind === "toggle") {
    if (text !== "true" && text !== "false") {
      return settingsError("RALPH_SETTINGS_VALUE_TYPE", `${field.label} requires true or false`)
    }
    candidate = text === "true"
  } else if (field.kind === "integer" || field.kind === "number") {
    candidate = Number(text)
  } else {
    try {
      candidate = JSON.parse(text)
    } catch {
      return settingsError("RALPH_SETTINGS_VALUE_JSON_INVALID", `${field.label} requires JSON`)
    }
  }
  return validateSettingsFieldValue(field, candidate)
}

function setConfigPath(
  target: Record<string, unknown>,
  path: string,
  value: SettingsJsonValue,
): void {
  const segments = path.split(".")
  let current = target
  segments.forEach((segment, index) => {
    if (!segment || FORBIDDEN_KEYS.has(segment)) {
      settingsError("RALPH_SETTINGS_CONFIG_PATH_INVALID", `Unsafe settings path: ${path}`)
    }
    if (index === segments.length - 1) {
      current[segment] = structuredClone(value)
      return
    }
    const existing = current[segment]
    if (existing === undefined) {
      const child: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      current[segment] = child
      current = child
      return
    }
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      settingsError("RALPH_SETTINGS_CONFIG_PATH_CONFLICT", `Conflicting settings path: ${path}`)
    }
    current = existing as Record<string, unknown>
  })
}

function singleFieldConfigPatch(
  field: SettingsCommandField,
  value: SettingsJsonValue,
): SettingsConfigPatch {
  if (!field.configPath) return {}
  const candidate: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  candidate.schema_version = 1
  setConfigPath(candidate, field.configPath, value)
  const parsed = RalphConfigLayerSchema.safeParse(candidate)
  if (!parsed.success) {
    return settingsError(
      "RALPH_SETTINGS_CONFIG_VALUE_INVALID",
      `${field.label} does not satisfy the configuration schema`,
      {
        fieldId: field.id,
        configPath: field.configPath,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    )
  }
  const output = structuredClone(parsed.data) as Record<string, unknown>
  delete output.schema_version
  delete output.profiles
  delete output.extensions
  return output as SettingsConfigPatch
}

export function validateSettingsFieldValue(
  field: SettingsCommandField,
  value: unknown,
): SettingsJsonValue {
  if (field.secret) {
    return settingsError(
      "RALPH_SETTINGS_SECRET_FORBIDDEN",
      "Secret values cannot be represented by the settings command model",
      { fieldId: field.id },
    )
  }
  const normalized = normalizeFieldValue(field, value)
  if (field.id === "executorParameters" || field.id === "judgeParameters") {
    const parsed = ProfileParametersSchema.safeParse(normalized)
    if (!parsed.success) {
      return settingsError(
        "RALPH_SETTINGS_PROFILE_PARAMETERS_INVALID",
        `${field.label} requires a flat map of primitive profile parameters`,
        {
          fieldId: field.id,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      )
    }
    return structuredClone(parsed.data)
  }
  if (field.configPath) singleFieldConfigPatch(field, normalized)
  return normalized
}

export function createSettingsDraft(mode: SettingsDraftMode = "pre-run"): SettingsDraft {
  return { schemaVersion: 1, mode, revision: 0, changes: [] }
}

export function updateSettingsDraft(
  draft: SettingsDraft,
  identifier: string,
  value: unknown,
): SettingsDraft {
  const field = settingsField(identifier)
  const normalized = validateSettingsFieldValue(field, value)
  const changes = draft.changes.filter((change) => change.fieldId !== field.id)
  changes.push({ fieldId: field.id, value: normalized })
  return {
    schemaVersion: 1,
    mode: draft.mode,
    revision: draft.revision + 1,
    changes,
  }
}

function mergeSettingsPatch(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(key))
      settingsError("RALPH_SETTINGS_KEY_FORBIDDEN", `Forbidden key: ${key}`)
    const existing = target[key]
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      mergeSettingsPatch(existing as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      target[key] = structuredClone(value)
    }
  }
}

function displayCommand(argumentsValue: readonly string[]): string {
  return argumentsValue.map((argument) => JSON.stringify(argument)).join(" ")
}

const RUN_CLEAR_FLAGS: Readonly<Record<string, string>> = {
  executorCredential: "--clear-executor-credential",
  executorVariant: "--clear-executor-variant",
  executorParameters: "--clear-executor-parameters",
  judgeCredential: "--clear-judge-credential",
  judgeVariant: "--clear-judge-variant",
  judgeParameters: "--clear-judge-parameters",
}

function profileParameters(
  field: SettingsCommandField,
  value: SettingsJsonValue,
): ProfileParameters {
  const parsed = ProfileParametersSchema.safeParse(value)
  if (parsed.success) return parsed.data
  return settingsError(
    "RALPH_SETTINGS_PROFILE_PARAMETERS_INVALID",
    `${field.label} requires a flat map of primitive profile parameters`,
    { fieldId: field.id },
  )
}

function profileParameterLiteral(value: ProfileParameters[string]): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value)
}

function cliArguments(field: SettingsCommandField, value: SettingsJsonValue): string[] {
  if (field.target === "config-only") return []
  if (field.id === "executorParameters" || field.id === "judgeParameters") {
    const parameters = profileParameters(field, value)
    const entries = Object.entries(parameters).sort(([left], [right]) =>
      left.localeCompare(right, "en"),
    )
    if (entries.length === 0) return [RUN_CLEAR_FLAGS[field.id] as string]
    return entries.flatMap(([name, parameter]) => [
      field.cliFlag,
      `${name}=${profileParameterLiteral(parameter)}`,
    ])
  }
  if (field.id === "toolRules" && value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([tool, decision]) => [`--${String(decision)}-tool`, tool])
  }
  if (typeof value === "boolean") {
    if (value) return [field.cliFlag]
    return field.cliFalseFlag ? [field.cliFalseFlag] : []
  }
  if (Array.isArray(value)) return value.flatMap((item) => [field.cliFlag, String(item)])
  if (value === null) {
    const clearFlag = RUN_CLEAR_FLAGS[field.id]
    return clearFlag ? [clearFlag] : []
  }
  if (typeof value === "object") return [field.cliFlag, JSON.stringify(value)]
  return [field.cliFlag, String(value)]
}

function runOverrideAvailable(field: SettingsCommandField, value: SettingsJsonValue): boolean {
  if (field.target === "config-only") return false
  return cliArguments(field, value).length > 0
}

export function previewSettingsDraft(
  draft: SettingsDraft,
  scope: SettingsConfigScope = "workspace",
): SettingsDraftPreview {
  const configPatch: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const entries = draft.changes.map((change): SettingsPreviewEntry => {
    const field = settingsField(change.fieldId)
    const runArguments = cliArguments(field, change.value)
    if (field.configPath) {
      mergeSettingsPatch(
        configPatch,
        singleFieldConfigPatch(field, change.value) as Record<string, unknown>,
      )
    }
    const configArguments = field.configPath
      ? ["ralph", "config", "set", field.configPath, JSON.stringify(change.value), "--scope", scope]
      : undefined
    return {
      fieldId: field.id,
      value: structuredClone(change.value),
      ...(field.configPath ? { configPath: field.configPath } : {}),
      ...(configArguments ? { configCommand: displayCommand(configArguments) } : {}),
      runArguments,
      runOverrideAvailable: runOverrideAvailable(field, change.value),
    }
  })
  const runArguments = entries.flatMap((entry) => entry.runArguments)
  const unavailable =
    draft.mode === "pre-run"
      ? entries.filter((entry) => !entry.runOverrideAvailable).map((entry) => entry.fieldId)
      : entries.map((entry) => entry.fieldId)
  const unavailableReason =
    draft.mode !== "pre-run"
      ? "Apply for this run is unavailable after a run has been persisted; attach/replay is read-only."
      : unavailable.length > 0
        ? `The draft contains settings without an exact per-run override: ${unavailable.join(", ")}`
        : undefined
  return {
    schemaVersion: 1,
    mode: draft.mode,
    scope,
    configPatch: configPatch as SettingsConfigPatch,
    configCommands: entries.flatMap((entry) => (entry.configCommand ? [entry.configCommand] : [])),
    runArguments,
    runCommand: displayCommand(["ralph", "run", ...runArguments]),
    entries,
    applyForRunAvailable: unavailableReason === undefined,
    ...(unavailableReason ? { applyForRunUnavailableReason: unavailableReason } : {}),
  }
}

function changeValue(draft: SettingsDraft, fieldId: string): SettingsJsonValue | undefined {
  return draft.changes.find((change) => change.fieldId === fieldId)?.value
}

function stringValue(value: SettingsJsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function applySettingsDraftForRun(draft: SettingsDraft): SettingsPreRunInvocation {
  const preview = previewSettingsDraft(draft)
  if (!preview.applyForRunAvailable) {
    return settingsError(
      "RALPH_SETTINGS_APPLY_UNAVAILABLE",
      preview.applyForRunUnavailableReason ?? "The settings draft cannot be applied to this run",
      { mode: draft.mode },
    )
  }

  const runOptions: RunOptionOverrides = {}
  for (const change of draft.changes) {
    switch (change.fieldId) {
      case "defaultMode":
        runOptions.mode = change.value as Exclude<RunOptionOverrides["mode"], undefined>
        break
      case "executorProfile":
        runOptions.executorProfile = change.value as string
        break
      case "judgeProfile":
        runOptions.judgeProfile = change.value as string
        break
      case "executorProvider":
        runOptions.executorProvider = change.value as string
        break
      case "executorModel":
        runOptions.executorModel = change.value as string
        break
      case "executorCredential":
        runOptions.executorCredential = change.value as string | null
        break
      case "executorVariant":
        runOptions.executorVariant = change.value as string | null
        break
      case "executorParameters":
        runOptions.executorParameters = profileParameters(
          settingsField(change.fieldId),
          change.value,
        )
        break
      case "judgeProvider":
        runOptions.judgeProvider = change.value as string
        break
      case "judgeModel":
        runOptions.judgeModel = change.value as string
        break
      case "judgeCredential":
        runOptions.judgeCredential = change.value as string | null
        break
      case "judgeVariant":
        runOptions.judgeVariant = change.value as string | null
        break
      case "judgeParameters":
        runOptions.judgeParameters = profileParameters(settingsField(change.fieldId), change.value)
        break
      case "task":
        runOptions.task = change.value as string
        break
      case "force":
        runOptions.force = change.value as boolean
        break
      case "dryRun":
        runOptions.dryRun = change.value as boolean
        break
      case "skipTests":
        runOptions.skipTests = change.value as boolean
        break
      case "skipLint":
        runOptions.skipLint = change.value as boolean
        break
      case "skipGates":
        runOptions.skipGates = change.value as readonly string[]
        break
      case "noGates":
        runOptions.noGates = change.value as boolean
        break
      case "fast":
        runOptions.fast = change.value as boolean
        break
      case "noCommit":
        runOptions.noCommit = change.value as boolean
        break
      case "failFast":
        runOptions.failFast = change.value as boolean
        break
      case "maxTasks":
        runOptions.maxTasks = change.value as number
        break
      case "retryDelaySeconds":
        runOptions.delayMs = (change.value as number) * 1_000
        break
      case "maxIterations":
        runOptions.maxIterations = change.value as number
        break
      case "maxModelCalls":
        runOptions.maxModelCallsPerAttempt = change.value as number
        break
      case "noChangeMaxAttempts":
        runOptions.maxNoChangeAttempts = change.value as number
        break
      case "noChangePolicy":
        runOptions.noChangePolicy = change.value as string
        break
      case "evaluationMode":
        runOptions.evaluationMode = change.value as Exclude<
          RunOptionOverrides["evaluationMode"],
          undefined
        >
        break
      case "judgeThreshold":
        runOptions.judgeThreshold = change.value as number
        break
      case "maxRevisionAttempts":
        runOptions.maxRevisionAttempts = change.value as number
        break
      case "judgeCallRetries":
        runOptions.judgeCallRetries = change.value as number
        break
      case "judgeUnavailablePolicy":
        runOptions.judgeUnavailablePolicy = change.value as Exclude<
          RunOptionOverrides["judgeUnavailablePolicy"],
          undefined
        >
        break
      case "blockingJudgeSeverities":
        runOptions.blockingJudgeSeverities = change.value as readonly (
          | "info"
          | "minor"
          | "major"
          | "critical"
        )[]
        break
      case "judgeRubric":
        runOptions.judgeRubric = change.value as Exclude<
          RunOptionOverrides["judgeRubric"],
          undefined
        >
        break
      case "judgeExhaustedPolicy":
        runOptions.judgeExhaustedPolicy = change.value as Exclude<
          RunOptionOverrides["judgeExhaustedPolicy"],
          undefined
        >
        break
      case "securityMode":
        runOptions.securityMode = change.value as Exclude<
          RunOptionOverrides["securityMode"],
          undefined
        >
        break
      case "headlessAsk":
        runOptions.headlessAsk = change.value as Exclude<
          RunOptionOverrides["headlessAsk"],
          undefined
        >
        break
      case "toolRules":
        runOptions.toolRules = change.value as Readonly<Record<string, "allow" | "deny" | "ask">>
        break
      case "allowedCommands":
        runOptions.allowedCommands = change.value as readonly string[]
        break
      case "readPaths":
        runOptions.readPaths = change.value as readonly string[]
        break
      case "writePaths":
        runOptions.writePaths = change.value as readonly string[]
        break
      case "allowShell":
        runOptions.allowShell = change.value as boolean
        break
    }
  }
  const prd = stringValue(changeValue(draft, "prd"))
  const ui = stringValue(changeValue(draft, "defaultUi"))
  const lang = stringValue(changeValue(draft, "language"))
  return {
    schemaVersion: 1,
    runOptions,
    ...(prd !== undefined ? { prd } : {}),
    ...(ui !== undefined ? { ui } : {}),
    ...(lang !== undefined ? { lang } : {}),
    cliArguments: preview.runArguments,
  }
}

function valueAtConfigPath(config: EffectiveConfig, path: string): SettingsJsonValue | undefined {
  const source = config.values[path]
  if (!source) return undefined
  assertJsonValue(source.value, path)
  return structuredClone(source.value)
}

export function listSettingsFields(config?: EffectiveConfig): readonly SettingsFieldState[] {
  return SETTINGS_COMMAND_FIELDS.map((field): SettingsFieldState => {
    if (config && field.configPath) {
      const source = config.values[field.configPath]
      const value = valueAtConfigPath(config, field.configPath)
      if (source && value !== undefined) {
        return {
          field,
          value,
          source: source.source,
          ...(source.sourceRef ? { sourceRef: source.sourceRef } : {}),
        }
      }
    }
    if (field.defaultValue !== undefined) {
      assertJsonValue(field.defaultValue, field.id)
      return { field, value: structuredClone(field.defaultValue), source: "builtin" }
    }
    return { field, source: "unavailable" }
  })
}

export function explainSettingsField(
  identifier: string,
  config?: EffectiveConfig,
): SettingsFieldState {
  const field = settingsField(identifier)
  return listSettingsFields(config).find(
    (state) => state.field.id === field.id,
  ) as SettingsFieldState
}

export async function saveSettingsDefaults(
  request: SaveSettingsDefaultsRequest,
): Promise<SettingsConfigMutation> {
  if (request.draft.changes.length === 0) {
    return settingsError("RALPH_SETTINGS_DRAFT_EMPTY", "The settings draft has no changes to save")
  }
  const unsaveable = request.draft.changes
    .map((change) => settingsField(change.fieldId))
    .filter((field) => !field.configPath)
  if (unsaveable.length > 0) {
    return settingsError(
      "RALPH_SETTINGS_DEFAULT_UNAVAILABLE",
      `Run-only settings cannot be saved as defaults: ${unsaveable.map((field) => field.id).join(", ")}`,
    )
  }
  const preview = previewSettingsDraft(request.draft, request.scope)
  if (request.scope === "workspace") {
    if (!request.workspaceRoot) {
      return settingsError(
        "RALPH_SETTINGS_WORKSPACE_REQUIRED",
        "Saving workspace defaults requires a resolved Ralph v2 workspace root",
      )
    }
    const workspace = await inspectWorkspace(request.workspaceRoot, { exact: true })
    if (!workspace.initialized) {
      return settingsError(
        "RALPH_SETTINGS_WORKSPACE_REQUIRED",
        "The selected settings target is not an initialized Ralph v2 workspace",
        { workspaceRoot: request.workspaceRoot },
      )
    }
    return writeSettingsConfig({
      scope: "workspace",
      workspaceRoot: workspace.root,
      patch: preview.configPatch,
    })
  }
  return writeSettingsConfig({
    scope: "global",
    ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
    ...(request.environment ? { environment: request.environment } : {}),
    patch: preview.configPatch,
  })
}

/** Shared command model for headless handlers and the future mutable TUI popups. */
export const settingsCommandModel = Object.freeze({
  fields: SETTINGS_COMMAND_FIELDS,
  createDraft: createSettingsDraft,
  updateDraft: updateSettingsDraft,
  preview: previewSettingsDraft,
  applyForRun: applySettingsDraftForRun,
  saveDefaults: saveSettingsDefaults,
  list: listSettingsFields,
  explain: explainSettingsField,
})
