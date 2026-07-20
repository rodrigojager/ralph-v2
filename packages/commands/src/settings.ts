import { DEFAULT_CONFIG, type EffectiveRunOptions } from "@ralph-next/domain"

export type SettingsFieldKind =
  | "select"
  | "text"
  | "reference"
  | "multi-select"
  | "toggle"
  | "integer"
  | "number"
  | "json"

export type SettingsFieldDefaultValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | Readonly<Record<string, string | number | boolean | null>>

export type SettingsFieldVisibility = {
  fieldId: string
  values: readonly (string | number | boolean | null)[]
}

export type SettingsFieldMetadata = {
  id: string
  label: string
  kind: SettingsFieldKind
  configPath: string
  cliFlag: string
  cliAliases?: readonly string[]
  effectiveOptionKey?: keyof EffectiveRunOptions
  required: boolean
  secret: boolean
  choices?: readonly string[]
  defaultValue?: SettingsFieldDefaultValue
  minimum?: number
  maximum?: number
  visibleWhen?: SettingsFieldVisibility
  help: string
}

export type EvaluationSettingsFieldMetadata = SettingsFieldMetadata & {
  effectiveOptionKey: keyof EffectiveRunOptions
}

/**
 * One source for the profile CLI, the S04 interactive form and the richer S08
 * OpenTUI popup. It contains no values and never carries credential material.
 */
export const ROLE_PROFILE_FORM_METADATA: readonly SettingsFieldMetadata[] = [
  {
    id: "scope",
    label: "Configuration scope",
    kind: "select",
    configPath: "scope",
    cliFlag: "--scope",
    required: true,
    secret: false,
    choices: ["workspace", "global"],
    help: "Choose which configuration layer receives the profile.",
  },
  {
    id: "role",
    label: "Role",
    kind: "select",
    configPath: "profiles.<id>.role",
    cliFlag: "--role",
    required: true,
    secret: false,
    choices: ["executor", "judge"],
    help: "Executor and judge profiles resolve independently.",
  },
  {
    id: "setDefault",
    label: "Set as role default",
    kind: "toggle",
    configPath: "defaults.<role>_profile",
    cliFlag: "--set-default",
    required: false,
    secret: false,
    help: "Atomically point the selected role default at this profile; leave false to update only the profile.",
  },
  {
    id: "backend",
    label: "Backend",
    kind: "select",
    configPath: "profiles.<id>.backend",
    cliFlag: "--backend",
    required: true,
    secret: false,
    choices: ["embedded", "external-cli"],
    help: "Embedded drivers and external CLI adapters remain distinct.",
  },
  {
    id: "provider",
    label: "Provider",
    kind: "select",
    configPath: "profiles.<id>.provider",
    cliFlag: "--provider",
    required: true,
    secret: false,
    help: "The selected provider must be registered and capability-compatible.",
  },
  {
    id: "model",
    label: "Model",
    kind: "select",
    configPath: "profiles.<id>.model",
    cliFlag: "--model",
    required: true,
    secret: false,
    help: "Models are filtered by provider and role requirements.",
  },
  {
    id: "credential",
    label: "Credential reference",
    kind: "reference",
    configPath: "profiles.<id>.credential",
    cliFlag: "--credential",
    required: false,
    secret: false,
    help: "This is a reference ID. Secret values never enter config or form metadata.",
  },
  {
    id: "variant",
    label: "Model variant",
    kind: "select",
    configPath: "profiles.<id>.variant",
    cliFlag: "--variant",
    required: false,
    secret: false,
    help: "Only variants declared by the selected model are accepted.",
  },
  {
    id: "parameters",
    label: "Explicit model parameters",
    kind: "json",
    configPath: "profiles.<id>.parameters",
    cliFlag: "--parameter",
    required: false,
    secret: false,
    help: "Enter a JSON object. Names and primitive values must be declared by the selected model.",
  },
  {
    id: "fallbackProfiles",
    label: "Ordered fallback profiles",
    kind: "multi-select",
    configPath: "profiles.<id>.fallback_profiles",
    cliFlag: "--fallback-profile",
    required: false,
    secret: false,
    help: "Fallback is explicit, ordered and restricted to authorized failure classes.",
  },
  {
    id: "fallbackOn",
    label: "Fallback failure classes",
    kind: "multi-select",
    configPath: "profiles.<id>.fallback_on",
    cliFlag: "--fallback-on",
    required: false,
    secret: false,
    choices: ["provider-unavailable", "model-unavailable", "rate-limit", "transient"],
    help: "Only these transient availability classes may advance to the next fallback profile.",
  },
  {
    id: "requireTools",
    label: "Require tool calling",
    kind: "toggle",
    configPath: "profiles.<id>.requirements.tools",
    cliFlag: "--require-tools",
    required: false,
    secret: false,
    help: "Reject models without tool calling before a task starts.",
  },
  {
    id: "requireStructuredOutput",
    label: "Require structured output",
    kind: "toggle",
    configPath: "profiles.<id>.requirements.structured_output",
    cliFlag: "--require-structured-output",
    required: false,
    secret: false,
    help: "Useful for judge profiles that require a strict assessment schema.",
  },
  {
    id: "requireInput",
    label: "Required input capabilities",
    kind: "multi-select",
    configPath: "profiles.<id>.requirements.input",
    cliFlag: "config:requirements.input",
    required: false,
    secret: false,
    choices: ["text", "image", "file"],
    help: "Require every selected input modality before routing a task.",
  },
  {
    id: "requireToolStreaming",
    label: "Require streamed tool calls",
    kind: "toggle",
    configPath: "profiles.<id>.requirements.tool_streaming",
    cliFlag: "config:requirements.tool_streaming",
    required: false,
    secret: false,
    help: "Require streaming tool-call support; this also requires tool calling.",
  },
  {
    id: "requireReasoning",
    label: "Require reasoning capability",
    kind: "toggle",
    configPath: "profiles.<id>.requirements.reasoning",
    cliFlag: "config:requirements.reasoning",
    required: false,
    secret: false,
    help: "Reject routes that do not declare reasoning support.",
  },
  {
    id: "requireUsage",
    label: "Required usage metrics",
    kind: "multi-select",
    configPath: "profiles.<id>.requirements.usage",
    cliFlag: "config:requirements.usage",
    required: false,
    secret: false,
    choices: ["input", "output", "reasoning", "cache-read", "cache-write", "cost"],
    help: "Require the selected normalized usage metrics from the route.",
  },
  {
    id: "requireAccess",
    label: "Required access modes",
    kind: "multi-select",
    configPath: "profiles.<id>.requirements.access",
    cliFlag: "config:requirements.access",
    required: false,
    secret: false,
    choices: ["api", "subscription"],
    help: "Constrain the route to API, subscription, or both declared access modes.",
  },
  {
    id: "minimumContext",
    label: "Minimum context tokens",
    kind: "integer",
    configPath: "profiles.<id>.requirements.minimum_context",
    cliFlag: "config:requirements.minimum_context",
    required: false,
    secret: false,
    minimum: 1,
    help: "Reject models whose declared context window is below this positive token count.",
  },
  {
    id: "minimumOutput",
    label: "Minimum output tokens",
    kind: "integer",
    configPath: "profiles.<id>.requirements.minimum_output",
    cliFlag: "config:requirements.minimum_output",
    required: false,
    secret: false,
    minimum: 1,
    help: "Reject models whose declared output limit is below this positive token count.",
  },
  {
    id: "maxInputTokens",
    label: "Maximum input tokens",
    kind: "integer",
    configPath: "profiles.<id>.limits.max_input_tokens",
    cliFlag: "config:limits.max_input_tokens",
    required: false,
    secret: false,
    minimum: 1,
    help: "Bound input-token consumption for each model call using this profile.",
  },
  {
    id: "maxOutputTokens",
    label: "Maximum output tokens",
    kind: "integer",
    configPath: "profiles.<id>.limits.max_output_tokens",
    cliFlag: "config:limits.max_output_tokens",
    required: false,
    secret: false,
    minimum: 1,
    help: "Bound output-token consumption for each model call using this profile.",
  },
  {
    id: "maxReasoningTokens",
    label: "Maximum reasoning tokens",
    kind: "integer",
    configPath: "profiles.<id>.limits.max_reasoning_tokens",
    cliFlag: "config:limits.max_reasoning_tokens",
    required: false,
    secret: false,
    minimum: 1,
    help: "Bound reasoning-token consumption when the provider reports it.",
  },
  {
    id: "maxTotalTokens",
    label: "Maximum total tokens",
    kind: "integer",
    configPath: "profiles.<id>.limits.max_total_tokens",
    cliFlag: "config:limits.max_total_tokens",
    required: false,
    secret: false,
    minimum: 1,
    help: "Bound total normalized token consumption for a call.",
  },
  {
    id: "maxCost",
    label: "Maximum cost",
    kind: "json",
    configPath: "profiles.<id>.limits.max_cost",
    cliFlag: "config:limits.max_cost",
    required: false,
    secret: false,
    help: 'Optional JSON object {"amount": number, "currency": "USD"}; zero is allowed.',
  },
] as const

/** Conditional fields for backend=external-cli. Values are references or non-secret process metadata. */
export const EXTERNAL_CLI_PROFILE_SETTINGS_METADATA: readonly SettingsFieldMetadata[] = [
  {
    id: "cliExecutable",
    label: "CLI executable",
    kind: "text",
    configPath: "profiles.<id>.external_cli.executable",
    cliFlag: "--cli-executable",
    required: true,
    secret: false,
    help: "Executable name or path. Credentials must not be embedded here or in arguments.",
  },
  {
    id: "cliArgs",
    label: "CLI arguments",
    kind: "json",
    configPath: "profiles.<id>.external_cli.args",
    cliFlag: "--cli-arg",
    required: true,
    secret: false,
    help: "Ordered string arguments; repeat the flag and use JSON strings when quoting is needed.",
  },
  {
    id: "cliCwd",
    label: "CLI working directory",
    kind: "text",
    configPath: "profiles.<id>.external_cli.cwd",
    cliFlag: "--cli-cwd",
    required: true,
    secret: false,
    help: "Portable workspace-relative directory, using forward slashes.",
  },
  {
    id: "cliEnvironmentRefs",
    label: "Environment references",
    kind: "json",
    configPath: "profiles.<id>.external_cli.environment_refs",
    cliFlag: "--cli-env",
    required: true,
    secret: false,
    help: "Map TARGET=env:SOURCE references. Secret values never enter config or argv.",
  },
  {
    id: "cliInputMode",
    label: "Input protocol",
    kind: "select",
    configPath: "profiles.<id>.external_cli.input_mode",
    cliFlag: "config:external_cli.input_mode",
    required: true,
    secret: false,
    choices: ["stdin-json"],
    help: "The command-owned external transport currently accepts the versioned stdin-json request protocol only.",
  },
  {
    id: "cliAdapter",
    label: "Output adapter",
    kind: "select",
    configPath: "profiles.<id>.external_cli.adapter",
    cliFlag: "--cli-adapter",
    required: true,
    secret: false,
    choices: ["protocol", "known-output", "generic"],
    help: "Select the deterministic process protocol or output normalization strategy.",
  },
  {
    id: "cliAdapterId",
    label: "Known output adapter",
    kind: "text",
    configPath: "profiles.<id>.external_cli.adapter_id",
    cliFlag: "--cli-adapter-id",
    required: false,
    secret: false,
    help: "Required only when adapter=known-output.",
  },
  {
    id: "cliStreaming",
    label: "Streaming capability",
    kind: "toggle",
    configPath: "profiles.<id>.external_cli.capabilities.streaming",
    cliFlag: "--cli-streaming",
    required: true,
    secret: false,
    help: "Declare whether normalized output can stream.",
  },
  {
    id: "cliToolCalling",
    label: "Tool calling owner",
    kind: "select",
    configPath: "profiles.<id>.external_cli.capabilities.tool_calling",
    cliFlag: "--cli-tool-calling",
    required: true,
    secret: false,
    choices: ["ralph", "internal", "unavailable"],
    help: "Declare whether Ralph settles tools, the CLI does internally, or tools are unavailable.",
  },
  {
    id: "cliCancellation",
    label: "Cancellation capability",
    kind: "toggle",
    configPath: "profiles.<id>.external_cli.capabilities.cancellation",
    cliFlag: "--cli-cancellation",
    required: true,
    secret: false,
    help: "Declare whether the child process adapter supports bounded cancellation.",
  },
  {
    id: "cliUsage",
    label: "Usage accounting",
    kind: "select",
    configPath: "profiles.<id>.external_cli.capabilities.usage",
    cliFlag: "--cli-usage",
    required: true,
    secret: false,
    choices: ["reported", "estimated", "unavailable"],
    help: "Declare how token usage is normalized.",
  },
  {
    id: "cliMutationMode",
    label: "Mutation mode",
    kind: "select",
    configPath: "profiles.<id>.external_cli.mutation_mode",
    cliFlag: "--cli-mutation",
    required: true,
    secret: false,
    choices: ["read-only", "workspace"],
    help: "Bound whether this CLI may mutate the selected workspace.",
  },
  {
    id: "cliTimeoutMs",
    label: "Attempt timeout (ms)",
    kind: "integer",
    configPath: "profiles.<id>.external_cli.timeout_ms",
    cliFlag: "--cli-timeout-ms",
    required: true,
    secret: false,
    minimum: 1,
    help: "Positive safe integer process deadline in milliseconds.",
  },
  {
    id: "cliOutputLimitBytes",
    label: "Output limit (bytes)",
    kind: "integer",
    configPath: "profiles.<id>.external_cli.output_limit_bytes",
    cliFlag: "--cli-output-limit-bytes",
    required: true,
    secret: false,
    minimum: 1,
    help: "Positive safe integer cap for captured child output.",
  },
] as const

/** Shared metadata for per-run security overrides and the settings popup. */
export const EXECUTION_SECURITY_SETTINGS_METADATA: readonly SettingsFieldMetadata[] = [
  {
    id: "securityMode",
    label: "Security mode",
    kind: "select",
    configPath: "security.mode",
    cliFlag: "--security",
    required: true,
    secret: false,
    choices: ["safe", "auto", "dangerous"],
    help: "Select the base tool-authorization posture for this execution.",
  },
  {
    id: "headlessAsk",
    label: "Headless ask behavior",
    kind: "select",
    configPath: "security.headless_ask",
    cliFlag: "--headless-ask",
    required: true,
    secret: false,
    choices: ["deny", "allow"],
    help: "Resolve ask rules deterministically when no interactive approver exists.",
  },
  {
    id: "toolRules",
    label: "Tool rules",
    kind: "json",
    configPath: "security.tool_rules",
    cliFlag: "--allow-tool/--deny-tool/--ask-tool",
    required: true,
    secret: false,
    help: "Map safe tool names to allow, deny or ask without conflicting decisions.",
  },
  {
    id: "allowedCommands",
    label: "Allowed commands",
    kind: "multi-select",
    configPath: "security.allowed_commands",
    cliFlag: "--allow-command",
    required: true,
    secret: false,
    help: "Add exact command policy entries; repeat as needed.",
  },
  {
    id: "readPaths",
    label: "Readable scopes",
    kind: "multi-select",
    configPath: "security.read_paths",
    cliFlag: "--read-path",
    required: true,
    secret: false,
    help: "Add portable workspace-relative read scopes.",
  },
  {
    id: "writePaths",
    label: "Writable scopes",
    kind: "multi-select",
    configPath: "security.write_paths",
    cliFlag: "--write-path",
    required: true,
    secret: false,
    help: "Add portable workspace-relative write scopes.",
  },
  {
    id: "allowShell",
    label: "Allow shell",
    kind: "toggle",
    configPath: "security.allow_shell",
    cliFlag: "--allow-shell",
    required: true,
    secret: false,
    help: "Permit shell execution only within the remaining command and path policy.",
  },
] as const

/**
 * Shared, value-free rendering contract for S06 evaluation controls and the
 * settings popup. `effectiveOptionKey` lets clients join these static fields
 * with the already provenance-bearing EffectiveRunOptions snapshot.
 */
export const EVALUATION_SETTINGS_METADATA: readonly EvaluationSettingsFieldMetadata[] = [
  {
    id: "evaluationMode",
    label: "Evaluation mode",
    kind: "select",
    configPath: "evaluation.mode",
    cliFlag: "--evaluation",
    cliAliases: ["--judge", "--no-judge", "--self-review"],
    effectiveOptionKey: "evaluationMode",
    required: true,
    secret: false,
    choices: ["deterministic-only", "self", "external", "manual"],
    defaultValue: DEFAULT_CONFIG.evaluation.mode,
    help: "Choose deterministic completion, self-review, an independent judge, or manual review.",
  },
  {
    id: "judgeProfile",
    label: "Judge profile",
    kind: "reference",
    configPath: "defaults.judge_profile",
    cliFlag: "--judge-profile",
    effectiveOptionKey: "judgeProfile",
    required: false,
    secret: false,
    defaultValue: DEFAULT_CONFIG.defaults.judge_profile,
    visibleWhen: { fieldId: "evaluationMode", values: ["external"] },
    help: "Select an independent role=judge profile. Self-review reuses the executor profile instead.",
  },
  {
    id: "judgeProvider",
    label: "Judge provider override",
    kind: "select",
    configPath: "profiles.<judge-profile>.provider",
    cliFlag: "--judge-provider",
    effectiveOptionKey: "judgeProvider",
    required: false,
    secret: false,
    visibleWhen: { fieldId: "evaluationMode", values: ["external"] },
    help: "Override the provider for this run without changing the executor route.",
  },
  {
    id: "judgeModel",
    label: "Judge model override",
    kind: "select",
    configPath: "profiles.<judge-profile>.model",
    cliFlag: "--judge-model",
    effectiveOptionKey: "judgeModel",
    required: false,
    secret: false,
    visibleWhen: { fieldId: "evaluationMode", values: ["external"] },
    help: "Override the judge model for this run independently from the executor model.",
  },
  {
    id: "judgeCredential",
    label: "Judge credential reference override",
    kind: "reference",
    configPath: "profiles.<judge-profile>.credential",
    cliFlag: "--judge-credential",
    effectiveOptionKey: "judgeCredential",
    required: false,
    secret: false,
    visibleWhen: { fieldId: "evaluationMode", values: ["external"] },
    help: "Select only a credential reference ID; secret material never enters metadata or config.",
  },
  {
    id: "judgeVariant",
    label: "Judge model variant override",
    kind: "select",
    configPath: "profiles.<judge-profile>.variant",
    cliFlag: "--judge-variant",
    effectiveOptionKey: "judgeVariant",
    required: false,
    secret: false,
    visibleWhen: { fieldId: "evaluationMode", values: ["external"] },
    help: "Override the declared judge model variant for this run.",
  },
  {
    id: "judgeThreshold",
    label: "Approval threshold",
    kind: "integer",
    configPath: "evaluation.threshold",
    cliFlag: "--judge-threshold",
    effectiveOptionKey: "judgeThreshold",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.evaluation.threshold,
    minimum: 0,
    maximum: 100,
    visibleWhen: { fieldId: "evaluationMode", values: ["self", "external"] },
    help: "Minimum integer score accepted after deterministic gates pass.",
  },
  {
    id: "maxRevisionAttempts",
    label: "Maximum revision attempts",
    kind: "integer",
    configPath: "evaluation.max_revision_attempts",
    cliFlag: "--judge-max-revisions",
    cliAliases: ["--max-revisions"],
    effectiveOptionKey: "maxRevisionAttempts",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.evaluation.max_revision_attempts,
    minimum: 0,
    visibleWhen: { fieldId: "evaluationMode", values: ["self", "external"] },
    help: "Bound executor modifications requested by valid judge assessments; zero allows no revision.",
  },
  {
    id: "judgeCallRetries",
    label: "Judge transport retries",
    kind: "integer",
    configPath: "evaluation.judge_call_retries",
    cliFlag: "--judge-call-retries",
    effectiveOptionKey: "judgeCallRetries",
    required: true,
    secret: false,
    defaultValue: DEFAULT_CONFIG.evaluation.judge_call_retries,
    minimum: 0,
    visibleWhen: { fieldId: "evaluationMode", values: ["self", "external"] },
    help: "Bound transport/schema retries separately from revision attempts.",
  },
  {
    id: "judgeUnavailablePolicy",
    label: "Judge unavailable policy",
    kind: "select",
    configPath: "evaluation.on_judge_unavailable",
    cliFlag: "--judge-unavailable",
    effectiveOptionKey: "judgeUnavailablePolicy",
    required: true,
    secret: false,
    choices: ["deterministic", "pause", "fail"],
    defaultValue: DEFAULT_CONFIG.evaluation.on_judge_unavailable,
    visibleWhen: { fieldId: "evaluationMode", values: ["self", "external"] },
    help: "Choose explicit deterministic fallback, pause, or failure when evaluation is unavailable.",
  },
  {
    id: "blockingJudgeSeverities",
    label: "Blocking judge severities",
    kind: "multi-select",
    configPath: "evaluation.blocking_severities",
    cliFlag: "--judge-blocking-severity",
    effectiveOptionKey: "blockingJudgeSeverities",
    required: true,
    secret: false,
    choices: ["info", "minor", "major", "critical"],
    defaultValue: [...DEFAULT_CONFIG.evaluation.blocking_severities],
    visibleWhen: { fieldId: "evaluationMode", values: ["self", "external"] },
    help: "Reject an assessment containing any selected severity even when its score reaches threshold.",
  },
  {
    id: "judgeRubric",
    label: "Judge rubric",
    kind: "json",
    configPath: "evaluation.rubric",
    cliFlag: "--judge-rubric",
    effectiveOptionKey: "judgeRubric",
    required: false,
    secret: false,
    visibleWhen: { fieldId: "evaluationMode", values: ["self", "external"] },
    help: "Define tool-agnostic weighted criteria, or leave empty to derive them from the task.",
  },
  {
    id: "judgeExhaustedPolicy",
    label: "Revision exhaustion policy",
    kind: "select",
    configPath: "evaluation.exhausted_policy",
    cliFlag: "--judge-exhausted",
    effectiveOptionKey: "judgeExhaustedPolicy",
    required: true,
    secret: false,
    choices: ["manual-review", "fail", "stop-run"],
    defaultValue: DEFAULT_CONFIG.evaluation.exhausted_policy,
    visibleWhen: { fieldId: "evaluationMode", values: ["self", "external"] },
    help: "Choose the terminal action after the bounded revision budget is exhausted.",
  },
]

export type EvaluationFormMetadata = {
  schemaVersion: 1
  formId: "evaluation"
  fields: readonly EvaluationSettingsFieldMetadata[]
}

export function evaluationFormMetadata(): EvaluationFormMetadata {
  return {
    schemaVersion: 1,
    formId: "evaluation",
    fields: EVALUATION_SETTINGS_METADATA,
  }
}

export function roleProfileFormMetadata(profileId?: string): {
  schemaVersion: 1
  formId: "role-profile"
  profileId?: string
  fields: readonly SettingsFieldMetadata[]
} {
  return {
    schemaVersion: 1,
    formId: "role-profile",
    ...(profileId ? { profileId } : {}),
    fields: [
      ...ROLE_PROFILE_FORM_METADATA,
      ...EXTERNAL_CLI_PROFILE_SETTINGS_METADATA.map((field) => ({
        ...field,
        visibleWhen:
          field.id === "cliAdapterId"
            ? { fieldId: "cliAdapter", values: ["known-output"] }
            : { fieldId: "backend", values: ["external-cli"] },
      })),
    ],
  }
}

const ROLE_PROFILE_CONFIG_PATH_PREFIX = "profiles.<id>."
const NON_INHERITABLE_ROLE_PROFILE_FIELD_IDS = new Set(["scope", "role", "setDefault"])

export type InheritableRoleProfileFormField = {
  readonly field: SettingsFieldMetadata
  /** Path relative to profiles.<id>; safe to pass to profile-layer mutation helpers. */
  readonly relativePath: readonly string[]
}

/**
 * Resolves only fields that represent one concrete leaf inside a role-profile
 * layer. Scope, role and set-default remain command-owned and can never be
 * removed through the generic inherit flag.
 */
export function inheritableRoleProfileFormField(
  fieldId: string,
): InheritableRoleProfileFormField | undefined {
  const field = roleProfileFormMetadata().fields.find((candidate) => candidate.id === fieldId)
  if (!field || NON_INHERITABLE_ROLE_PROFILE_FIELD_IDS.has(field.id)) return undefined
  if (!field.configPath.startsWith(ROLE_PROFILE_CONFIG_PATH_PREFIX)) return undefined
  const relativePath = field.configPath.slice(ROLE_PROFILE_CONFIG_PATH_PREFIX.length).split(".")
  if (relativePath.length === 0 || relativePath.some((segment) => segment.length === 0)) {
    return undefined
  }
  return { field, relativePath }
}

export function inheritableRoleProfileFormFieldIds(): readonly string[] {
  return roleProfileFormMetadata().fields.flatMap((field) =>
    inheritableRoleProfileFormField(field.id) ? [field.id] : [],
  )
}
