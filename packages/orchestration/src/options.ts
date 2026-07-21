import {
  DEFAULT_CONFIG,
  type EffectiveConfig,
  type EffectiveOptionSource,
  type EffectiveRunOptions,
  EffectiveRunOptionsSchema,
  type EvaluationRubricConfig,
  EXIT_CODES,
  type HeadlessAsk,
  normalizeNoChangePolicy,
  type ProfileParameters,
  RalphConfigSchema,
  RalphError,
  type RunMode,
  type SecurityMode,
  type TelemetryConfig,
  type ToolRuleDecision,
  ToolRulesSchema,
} from "@ralph/domain"
import { hashCanonicalValue, type PrdDocument, type PrdTask } from "@ralph/prd"
import { z } from "zod"

const S03_BUILTIN_MAX_TASKS = 1_000
const S03_BUILTIN_MAX_ITERATIONS = 1
const S03_BUILTIN_MAX_MODEL_CALLS_PER_ATTEMPT = 1

export type RunOptionOverrides = {
  mode?: RunMode
  executorProfile?: string
  judgeProfile?: string
  executorProvider?: string
  executorModel?: string
  executorCredential?: string | null
  executorVariant?: string | null
  executorParameters?: ProfileParameters
  judgeProvider?: string
  judgeModel?: string
  judgeCredential?: string | null
  judgeVariant?: string | null
  judgeParameters?: ProfileParameters
  task?: string | null
  force?: boolean
  dryRun?: boolean
  skipTests?: boolean
  skipLint?: boolean
  skipGates?: readonly string[]
  noGates?: boolean
  fast?: boolean
  noCommit?: boolean
  failFast?: boolean
  maxTasks?: number
  delayMs?: number
  maxIterations?: number
  maxModelCallsPerAttempt?: number
  maxNoChangeAttempts?: number
  noChangePolicy?: string
  evaluationMode?: "deterministic-only" | "self" | "external" | "manual"
  judgeThreshold?: number
  maxRevisionAttempts?: number
  judgeCallRetries?: number
  judgeUnavailablePolicy?: "deterministic" | "pause" | "fail"
  blockingJudgeSeverities?: readonly ("info" | "minor" | "major" | "critical")[]
  judgeRubric?: EvaluationRubricConfig | null
  judgeExhaustedPolicy?: "manual-review" | "fail" | "stop-run"
  securityMode?: SecurityMode
  headlessAsk?: HeadlessAsk
  toolRules?: Readonly<Record<string, ToolRuleDecision>>
  allowedCommands?: readonly string[]
  readPaths?: readonly string[]
  writePaths?: readonly string[]
  allowShell?: boolean
  maxParallel?: number
  maxGlobalParallel?: number
  parallelAuto?: boolean
  parallelGroups?: readonly string[]
  retryFailed?: boolean
  maxFailureRetries?: number
  integrationStrategy?: "no-merge" | "none" | "merge" | "rebase-merge" | "cherry-pick" | "create-pr"
  branchPerTask?: boolean
  baseBranch?: string | null
  integrationBranch?: string | null
  sandboxEnabled?: boolean
  sandboxProvider?: "process" | "docker" | "podman"
  sandboxImage?: string | null
}

export type RunProfileOptions = {
  id: string
  maxModelCallsPerAttempt?: number
}

export type ResolveEffectiveRunOptionsInput = {
  config?: EffectiveConfig
  document?: Pick<PrdDocument, "id" | "file" | "defaults">
  task?: PrdTask
  profile?: RunProfileOptions
  cli?: RunOptionOverrides
}

export type ResolvedRunOptions = {
  options: EffectiveRunOptions
  optionsHash: string
  notices: readonly string[]
}

export type RunOptionResolutionContext = Pick<
  ResolveEffectiveRunOptionsInput,
  "config" | "profile" | "cli"
>

const SerializedEffectiveConfigSchema = z
  .object({
    config: RalphConfigSchema,
    values: z.record(
      z.string(),
      z
        .object({
          value: z.unknown(),
          source: z.enum([
            "builtin",
            "global",
            "workspace",
            "env",
            "profile",
            "prd",
            "task",
            "cli",
          ]),
          sourceRef: z.string().min(1).max(32_768).optional(),
        })
        .strict(),
    ),
  })
  .strict()

const SerializedRunOptionResolutionContextSchema = z
  .object({
    config: SerializedEffectiveConfigSchema.optional(),
    profile: z
      .object({
        id: z.string().min(1).max(4_096),
        maxModelCallsPerAttempt: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    cli: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export function parseRunOptionResolutionContext(input: unknown): RunOptionResolutionContext {
  const parsed = SerializedRunOptionResolutionContextSchema.parse(input)
  const cli = parsed.cli as RunOptionOverrides | undefined
  assertKnownCliOptions(cli)
  const config: EffectiveConfig | undefined = parsed.config
    ? {
        config: parsed.config.config,
        values: Object.fromEntries(
          Object.entries(parsed.config.values).map(([path, entry]) => [
            path,
            {
              value: entry.value,
              source: entry.source,
              ...(entry.sourceRef !== undefined ? { sourceRef: entry.sourceRef } : {}),
            },
          ]),
        ),
      }
    : undefined
  const profile: RunProfileOptions | undefined = parsed.profile
    ? {
        id: parsed.profile.id,
        ...(parsed.profile.maxModelCallsPerAttempt !== undefined
          ? { maxModelCallsPerAttempt: parsed.profile.maxModelCallsPerAttempt }
          : {}),
      }
    : undefined
  return {
    ...(config ? { config } : {}),
    ...(profile ? { profile } : {}),
    ...(cli ? { cli } : {}),
  }
}

type EffectiveOption<T> = {
  value: T
  source: EffectiveOptionSource
  sourceRef?: string
}

export class RunOptionsResolutionError extends RalphError {
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, { exitCode: EXIT_CODES.invalidUsage, details })
    this.name = "RunOptionsResolutionError"
    this.details = Object.freeze({ ...details })
  }
}

function option<T>(
  value: T,
  source: EffectiveOptionSource,
  sourceRef?: string,
): EffectiveOption<T> {
  return {
    value,
    source,
    ...(sourceRef ? { sourceRef } : {}),
  }
}

function lastDefined<T>(...values: Array<EffectiveOption<T> | undefined>): EffectiveOption<T> {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (value) return value
  }
  throw new RunOptionsResolutionError(
    "RALPH_EFFECTIVE_OPTION_MISSING",
    "An effective run option has no builtin or override value.",
  )
}

function configSource(
  config: EffectiveConfig | undefined,
  path: string,
): Pick<EffectiveOption<unknown>, "source" | "sourceRef"> {
  const sourceOrder: Readonly<Record<EffectiveOptionSource, number>> = {
    builtin: 0,
    global: 1,
    workspace: 2,
    env: 3,
    profile: 4,
    prd: 5,
    task: 6,
    cli: 7,
  }
  const direct = config?.values[path]?.source
  const descendants = config
    ? Object.entries(config.values)
        .filter(([candidate]) => candidate.startsWith(`${path}.`))
        .map(([, value]) => value.source)
    : []
  const source =
    direct ??
    descendants.reduce<EffectiveOptionSource>(
      (winner, candidate) => (sourceOrder[candidate] > sourceOrder[winner] ? candidate : winner),
      "builtin",
    )
  if (source === "builtin") return { source }
  return { source, sourceRef: `${source}:${path}` }
}

function configOption<T>(
  config: EffectiveConfig | undefined,
  path: string,
  value: T,
): EffectiveOption<T> {
  const source = configSource(config, path)
  return option(value, source.source, source.sourceRef)
}

function prdOption<T>(
  document: ResolveEffectiveRunOptionsInput["document"],
  value: T | undefined,
): EffectiveOption<T> | undefined {
  return document && value !== undefined ? option(value, "prd", `prd:${document.id}`) : undefined
}

function taskOption<T>(
  document: ResolveEffectiveRunOptionsInput["document"],
  task: PrdTask | undefined,
  value: T | undefined,
): EffectiveOption<T> | undefined {
  return document && task && value !== undefined
    ? option(value, "task", `task:${document.id}/${task.id}`)
    : undefined
}

function cliOption<T>(value: T | undefined, flag: string): EffectiveOption<T> | undefined {
  return value !== undefined ? option(value, "cli", `cli:${flag}`) : undefined
}

function profileOption<T>(
  profile: RunProfileOptions | undefined,
  value: T | undefined,
): EffectiveOption<T> | undefined {
  return profile && value !== undefined
    ? option(value, "profile", `profile:${profile.id}`)
    : undefined
}

function normalizeGateList(values: readonly string[]): string[] {
  const normalized = values.map((value) => value.trim())
  const emptyIndex = normalized.findIndex((value) => value.length === 0)
  if (emptyIndex >= 0) {
    throw new RunOptionsResolutionError(
      "RALPH_SKIP_GATE_EMPTY",
      "A skipped gate identifier cannot be empty.",
      { index: emptyIndex },
    )
  }
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right, "en"))
}

function normalizeUniqueList(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => value.trim())
  const emptyIndex = normalized.findIndex((value) => value.length === 0)
  if (emptyIndex >= 0) {
    throw new RunOptionsResolutionError(
      "RALPH_SECURITY_VALUE_EMPTY",
      `${label} cannot contain an empty value.`,
      { label, index: emptyIndex },
    )
  }
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right, "en"))
}

function normalizeToolRules(
  configured: Readonly<Record<string, ToolRuleDecision>>,
  overrides: Readonly<Record<string, ToolRuleDecision>> | undefined,
): Record<string, ToolRuleDecision> {
  const merged = { ...configured, ...(overrides ?? {}) }
  const parsed = ToolRulesSchema.safeParse(merged)
  if (!parsed.success) {
    throw new RunOptionsResolutionError(
      "RALPH_TOOL_RULE_INVALID",
      "The effective tool rules are invalid.",
      { issues: parsed.error.issues },
    )
  }
  return Object.fromEntries(
    Object.entries(parsed.data).sort(([left], [right]) => left.localeCompare(right, "en")),
  )
}

function milliseconds(seconds: number): number {
  const value = Math.round(seconds * 1_000)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RunOptionsResolutionError(
      "RALPH_RETRY_DELAY_INVALID",
      "The configured retry delay cannot be represented safely in milliseconds.",
      { seconds },
    )
  }
  return value
}

const RUN_OPTION_KEYS = new Set<keyof RunOptionOverrides>([
  "mode",
  "executorProfile",
  "judgeProfile",
  "executorProvider",
  "executorModel",
  "executorCredential",
  "executorVariant",
  "executorParameters",
  "judgeProvider",
  "judgeModel",
  "judgeCredential",
  "judgeVariant",
  "judgeParameters",
  "task",
  "force",
  "dryRun",
  "skipTests",
  "skipLint",
  "skipGates",
  "noGates",
  "fast",
  "noCommit",
  "failFast",
  "maxTasks",
  "delayMs",
  "maxIterations",
  "maxModelCallsPerAttempt",
  "maxNoChangeAttempts",
  "noChangePolicy",
  "evaluationMode",
  "judgeThreshold",
  "maxRevisionAttempts",
  "judgeCallRetries",
  "judgeUnavailablePolicy",
  "blockingJudgeSeverities",
  "judgeRubric",
  "judgeExhaustedPolicy",
  "securityMode",
  "headlessAsk",
  "toolRules",
  "allowedCommands",
  "readPaths",
  "writePaths",
  "allowShell",
  "maxParallel",
  "maxGlobalParallel",
  "parallelAuto",
  "parallelGroups",
  "retryFailed",
  "maxFailureRetries",
  "integrationStrategy",
  "branchPerTask",
  "baseBranch",
  "integrationBranch",
  "sandboxEnabled",
  "sandboxProvider",
  "sandboxImage",
])

function assertKnownCliOptions(cli: RunOptionOverrides | undefined): void {
  if (!cli) return
  const unknown = Object.keys(cli).filter(
    (key) => !RUN_OPTION_KEYS.has(key as keyof RunOptionOverrides),
  )
  if (unknown.length > 0) {
    throw new RunOptionsResolutionError(
      "RALPH_RUN_OPTION_UNKNOWN",
      `Unknown run option${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
      { unknown },
    )
  }
}

function schemaIssues(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("issues" in error)) return String(error)
  return (error as { issues: unknown }).issues
}

/**
 * Materializes the S03 execution settings using the normative precedence:
 * CLI > task > PRD > profile > effective config > versioned builtin.
 *
 * `EffectiveConfig` already records which config layer won for each leaf, so
 * global/workspace/env provenance is retained without persisting an absolute
 * config-file path in the options snapshot.
 */
export function resolveEffectiveRunOptions(
  input: ResolveEffectiveRunOptionsInput = {},
): ResolvedRunOptions {
  assertKnownCliOptions(input.cli)
  if (input.task && !input.document) {
    throw new RunOptionsResolutionError(
      "RALPH_RUN_OPTION_TASK_DOCUMENT_REQUIRED",
      "Task overrides require their compiled PRD document namespace.",
    )
  }

  const config = input.config?.config ?? DEFAULT_CONFIG
  const cli = input.cli
  const document = input.document
  const task = input.task

  const mode = lastDefined(
    configOption(input.config, "defaults.mode", config.defaults.mode),
    cliOption(cli?.mode, "--mode"),
  )
  const executorProfile = lastDefined(
    configOption(input.config, "defaults.executor_profile", config.defaults.executor_profile),
    prdOption(document, document?.defaults.executorProfile),
    taskOption(document, task, task?.profiles?.executor),
    cliOption(cli?.executorProfile, "--executor-profile"),
  )
  const judgeProfile = lastDefined(
    configOption(input.config, "defaults.judge_profile", config.defaults.judge_profile),
    prdOption(document, document?.defaults.judgeProfile),
    taskOption(document, task, task?.profiles?.judge),
    cliOption(cli?.judgeProfile, "--judge-profile"),
  )
  const executorProvider = cliOption(cli?.executorProvider, "--executor-provider")
  const executorModel = cliOption(cli?.executorModel, "--executor-model")
  const executorCredential = cliOption(
    cli?.executorCredential,
    cli?.executorCredential === null ? "--clear-executor-credential" : "--executor-credential",
  )
  const executorVariant = cliOption(
    cli?.executorVariant,
    cli?.executorVariant === null ? "--clear-executor-variant" : "--executor-variant",
  )
  const executorParameters = cliOption(
    cli?.executorParameters,
    cli?.executorParameters !== undefined && Object.keys(cli.executorParameters).length === 0
      ? "--clear-executor-parameters"
      : "--executor-parameter",
  )
  const judgeProvider = cliOption(cli?.judgeProvider, "--judge-provider")
  const judgeModel = cliOption(cli?.judgeModel, "--judge-model")
  const judgeCredential = cliOption(
    cli?.judgeCredential,
    cli?.judgeCredential === null ? "--clear-judge-credential" : "--judge-credential",
  )
  const judgeVariant = cliOption(
    cli?.judgeVariant,
    cli?.judgeVariant === null ? "--clear-judge-variant" : "--judge-variant",
  )
  const judgeParameters = cliOption(
    cli?.judgeParameters,
    cli?.judgeParameters !== undefined && Object.keys(cli.judgeParameters).length === 0
      ? "--clear-judge-parameters"
      : "--judge-parameter",
  )
  const selectedTask = lastDefined(
    option<string | null>(null, "builtin"),
    cliOption(cli?.task, "--task"),
  )
  const force = lastDefined(option(false, "builtin"), cliOption(cli?.force, "--force"))
  const dryRun = lastDefined(option(false, "builtin"), cliOption(cli?.dryRun, "--dry-run"))
  const skipTests = lastDefined(option(false, "builtin"), cliOption(cli?.skipTests, "--skip-tests"))
  const skipLint = lastDefined(option(false, "builtin"), cliOption(cli?.skipLint, "--skip-lint"))
  const skipGates = lastDefined(
    option<string[]>([], "builtin"),
    cliOption(cli?.skipGates ? normalizeGateList(cli.skipGates) : undefined, "--skip-gates"),
  )
  const noGates = lastDefined(option(false, "builtin"), cliOption(cli?.noGates, "--no-gates"))
  if (noGates.value && !config.verification.allow_no_gates && !force.value) {
    throw new RunOptionsResolutionError(
      "RALPH_NO_GATES_NOT_AUTHORIZED",
      "--no-gates is disabled by verification.allow_no_gates; use an explicit audited --force override or enable the workspace policy",
    )
  }
  const fast = lastDefined(option(false, "builtin"), cliOption(cli?.fast, "--fast"))
  const noCommit = lastDefined(option(false, "builtin"), cliOption(cli?.noCommit, "--no-commit"))
  const failFast = lastDefined(option(false, "builtin"), cliOption(cli?.failFast, "--fail-fast"))
  const maxTasks = lastDefined(
    option(S03_BUILTIN_MAX_TASKS, "builtin"),
    cliOption(cli?.maxTasks, "--max-tasks"),
  )
  const delayMs = lastDefined(
    configOption(
      input.config,
      "run.retry_delay_seconds",
      milliseconds(config.run.retry_delay_seconds),
    ),
    cliOption(cli?.delayMs, "--retry-delay"),
  )
  const maxIterations = lastDefined(
    option(S03_BUILTIN_MAX_ITERATIONS, "builtin"),
    cliOption(cli?.maxIterations, "--max-iterations"),
  )
  const maxModelCallsPerAttempt = lastDefined(
    option(S03_BUILTIN_MAX_MODEL_CALLS_PER_ATTEMPT, "builtin"),
    profileOption(input.profile, input.profile?.maxModelCallsPerAttempt),
    prdOption(document, document?.defaults.budget?.maxModelCallsPerAttempt),
    taskOption(document, task, task?.budget?.maxModelCallsPerAttempt),
    cliOption(cli?.maxModelCallsPerAttempt, "--max-model-calls"),
  )
  const maxNoChangeAttempts = lastDefined(
    configOption(input.config, "run.no_change.max_attempts", config.run.no_change.max_attempts),
    cliOption(cli?.maxNoChangeAttempts, "--no-change-max-retries"),
  )

  const configuredNoChange = configOption(
    input.config,
    "run.no_change.policy",
    config.run.no_change.policy,
  )
  const noChangeInput = lastDefined(
    configuredNoChange,
    cliOption(cli?.noChangePolicy, "--no-change-policy"),
  )
  const normalizedNoChange = normalizeNoChangePolicy(noChangeInput.value)
  const noChangePolicy = {
    ...normalizedNoChange,
    source: noChangeInput.source,
    ...(noChangeInput.sourceRef ? { sourceRef: noChangeInput.sourceRef } : {}),
  }
  const evaluationMode = lastDefined(
    configOption(input.config, "evaluation.mode", config.evaluation.mode),
    cliOption(cli?.evaluationMode, "--evaluation/--judge/--no-judge/--self-review"),
  )
  const judgeThreshold = lastDefined(
    configOption(input.config, "evaluation.threshold", config.evaluation.threshold),
    cliOption(cli?.judgeThreshold, "--judge-threshold"),
  )
  const maxRevisionAttempts = lastDefined(
    configOption(
      input.config,
      "evaluation.max_revision_attempts",
      config.evaluation.max_revision_attempts,
    ),
    taskOption(document, task, task?.budget?.maxRevisionAttempts),
    cliOption(cli?.maxRevisionAttempts, "--judge-max-revisions/--max-revisions"),
  )
  const judgeCallRetries = lastDefined(
    configOption(
      input.config,
      "evaluation.judge_call_retries",
      config.evaluation.judge_call_retries,
    ),
    cliOption(cli?.judgeCallRetries, "--judge-call-retries"),
  )
  const judgeUnavailablePolicy = lastDefined(
    configOption(
      input.config,
      "evaluation.on_judge_unavailable",
      config.evaluation.on_judge_unavailable,
    ),
    cliOption(cli?.judgeUnavailablePolicy, "--judge-unavailable"),
  )
  const blockingJudgeSeverities = lastDefined(
    configOption(input.config, "evaluation.blocking_severities", [
      ...config.evaluation.blocking_severities,
    ]),
    cliOption(
      cli?.blockingJudgeSeverities ? [...cli.blockingJudgeSeverities] : undefined,
      "--judge-blocking-severity",
    ),
  )
  const configuredJudgeRubric = Object.hasOwn(config.evaluation, "rubric")
    ? configOption(input.config, "evaluation.rubric", config.evaluation.rubric ?? null)
    : undefined
  const judgeRubric = cliOption(cli?.judgeRubric, "--judge-rubric") ?? configuredJudgeRubric
  const judgeExhaustedPolicy = lastDefined(
    configOption(input.config, "evaluation.exhausted_policy", config.evaluation.exhausted_policy),
    cliOption(cli?.judgeExhaustedPolicy, "--judge-exhausted"),
  )
  const securityMode = lastDefined(
    configOption(input.config, "security.mode", config.security.mode),
    cliOption(cli?.securityMode, "--security"),
  )
  const headlessAsk = lastDefined(
    configOption(input.config, "security.headless_ask", config.security.headless_ask),
    cliOption(cli?.headlessAsk, "--headless-ask"),
  )
  const effectiveToolRules = normalizeToolRules(config.security.tool_rules, cli?.toolRules)
  const toolRules = cli?.toolRules
    ? option(effectiveToolRules, "cli", "cli:--allow-tool/--deny-tool/--ask-tool")
    : configOption(input.config, "security.tool_rules", effectiveToolRules)
  const effectiveAllowedCommands = normalizeUniqueList(
    [...config.security.allowed_commands, ...(cli?.allowedCommands ?? [])],
    "Allowed commands",
  )
  const allowedCommands = cli?.allowedCommands
    ? option(effectiveAllowedCommands, "cli", "cli:--allow-command")
    : configOption(input.config, "security.allowed_commands", effectiveAllowedCommands)
  const effectiveReadPaths = normalizeUniqueList(
    [...config.security.read_paths, ...(cli?.readPaths ?? [])],
    "Read paths",
  )
  const readPaths = cli?.readPaths
    ? option(effectiveReadPaths, "cli", "cli:--read-path")
    : configOption(input.config, "security.read_paths", effectiveReadPaths)
  const effectiveWritePaths = normalizeUniqueList(
    [...config.security.write_paths, ...(cli?.writePaths ?? [])],
    "Write paths",
  )
  const writePaths = cli?.writePaths
    ? option(effectiveWritePaths, "cli", "cli:--write-path")
    : configOption(input.config, "security.write_paths", effectiveWritePaths)
  const allowShell = lastDefined(
    configOption(input.config, "security.allow_shell", config.security.allow_shell),
    cliOption(cli?.allowShell, "--allow-shell"),
  )
  const parallelPolicyValue = {
    ...config.parallel,
    ...(cli?.maxParallel !== undefined ? { max_parallel: cli.maxParallel } : {}),
    ...(cli?.maxGlobalParallel !== undefined ? { max_global: cli.maxGlobalParallel } : {}),
    ...(cli?.parallelAuto !== undefined ? { auto: cli.parallelAuto } : {}),
    ...(cli?.parallelGroups !== undefined ? { allowed_groups: [...cli.parallelGroups] } : {}),
    ...(cli?.retryFailed !== undefined ? { retry_failed: cli.retryFailed } : {}),
    ...(cli?.maxFailureRetries !== undefined ? { max_failure_retries: cli.maxFailureRetries } : {}),
    ...(cli?.integrationStrategy !== undefined
      ? { integration_strategy: cli.integrationStrategy }
      : {}),
    fail_fast: failFast.value,
  }
  const parallelPolicy =
    cli?.maxParallel !== undefined ||
    cli?.maxGlobalParallel !== undefined ||
    cli?.parallelAuto !== undefined ||
    cli?.parallelGroups !== undefined ||
    cli?.retryFailed !== undefined ||
    cli?.maxFailureRetries !== undefined ||
    cli?.integrationStrategy !== undefined
      ? option(parallelPolicyValue, "cli", "cli:parallel-policy")
      : configOption(input.config, "parallel", parallelPolicyValue)
  const gitPolicyValue = {
    ...config.git,
    ...(cli?.branchPerTask !== undefined ? { branch_per_task: cli.branchPerTask } : {}),
    ...(cli?.baseBranch !== undefined ? { base_branch: cli.baseBranch } : {}),
    ...(cli?.integrationBranch !== undefined ? { integration_branch: cli.integrationBranch } : {}),
    commit_per_task: !noCommit.value,
  }
  const gitPolicy =
    cli?.branchPerTask !== undefined ||
    cli?.baseBranch !== undefined ||
    cli?.integrationBranch !== undefined
      ? option(gitPolicyValue, "cli", "cli:git-policy")
      : configOption(input.config, "git", gitPolicyValue)
  const sandboxPolicyValue = {
    ...config.sandbox,
    ...(cli?.sandboxEnabled !== undefined ? { enabled: cli.sandboxEnabled } : {}),
    ...(cli?.sandboxProvider !== undefined ? { provider: cli.sandboxProvider } : {}),
    ...(cli?.sandboxImage !== undefined ? { image: cli.sandboxImage } : {}),
  }
  const sandboxPolicy =
    cli?.sandboxEnabled !== undefined ||
    cli?.sandboxProvider !== undefined ||
    cli?.sandboxImage !== undefined
      ? option(sandboxPolicyValue, "cli", "cli:sandbox-policy")
      : configOption(input.config, "sandbox", sandboxPolicyValue)
  const securityPolicy = configOption(input.config, "security", {
    ...config.security,
    mode: securityMode.value,
    headless_ask: headlessAsk.value,
    tool_rules: toolRules.value,
    allowed_commands: allowedCommands.value,
    read_paths: readPaths.value,
    write_paths: writePaths.value,
    allow_shell: allowShell.value,
  })
  const telemetryPolicy = configOption(input.config, "telemetry", config.telemetry)

  const unhashed = {
    schemaVersion: 1 as const,
    mode,
    executorProfile,
    ...(judgeProfile.value ? { judgeProfile: { ...judgeProfile, value: judgeProfile.value } } : {}),
    ...(executorProvider ? { executorProvider } : {}),
    ...(executorModel ? { executorModel } : {}),
    ...(executorCredential ? { executorCredential } : {}),
    ...(executorVariant ? { executorVariant } : {}),
    ...(executorParameters ? { executorParameters } : {}),
    ...(judgeProvider ? { judgeProvider } : {}),
    ...(judgeModel ? { judgeModel } : {}),
    ...(judgeCredential ? { judgeCredential } : {}),
    ...(judgeVariant ? { judgeVariant } : {}),
    ...(judgeParameters ? { judgeParameters } : {}),
    task: selectedTask,
    force,
    dryRun,
    skipTests,
    skipLint,
    skipGates,
    noGates,
    fast,
    noCommit,
    failFast,
    maxTasks,
    delayMs,
    maxIterations,
    maxModelCallsPerAttempt,
    maxNoChangeAttempts,
    noChangePolicy,
    evaluationMode,
    judgeThreshold,
    maxRevisionAttempts,
    judgeCallRetries,
    judgeUnavailablePolicy,
    blockingJudgeSeverities,
    ...(judgeRubric ? { judgeRubric } : {}),
    judgeExhaustedPolicy,
    securityMode,
    headlessAsk,
    toolRules,
    allowedCommands,
    readPaths,
    writePaths,
    allowShell,
    parallelPolicy,
    gitPolicy,
    sandboxPolicy,
    securityPolicy,
    telemetryPolicy,
  }
  const contentHash = hashCanonicalValue("ralph.execution.effective-options.v1", unhashed)

  let options: EffectiveRunOptions
  try {
    options = EffectiveRunOptionsSchema.parse({ ...unhashed, contentHash })
  } catch (error) {
    throw new RunOptionsResolutionError(
      "RALPH_EFFECTIVE_RUN_OPTIONS_INVALID",
      "The resolved run options do not satisfy the S03 execution contract.",
      { issues: schemaIssues(error) },
    )
  }

  return {
    options,
    optionsHash: options.contentHash,
    notices: normalizedNoChange.notice ? [normalizedNoChange.notice] : [],
  }
}

export function effectiveOptionsHash(options: EffectiveRunOptions): string {
  const { contentHash: _contentHash, ...projection } = options
  return hashCanonicalValue("ralph.execution.effective-options.v1", projection)
}

/**
 * Ledgers written before telemetryPolicy existed retain their original hash
 * and receive the historical builtin policy, never mutable current config.
 */
export function telemetryPolicyForEffectiveOptions(options: EffectiveRunOptions): TelemetryConfig {
  return options.telemetryPolicy?.value ?? DEFAULT_CONFIG.telemetry
}

/**
 * `--task` controls only which eligible task an invocation starts with and
 * `--dry-run` controls whether the invocation executes or only renders its
 * plan. Both are excluded from resumable-run compatibility so an existing run
 * can be inspected read-only and `once --task B` can later be resumed without
 * repeating the selector. Attempts still persist the full, exact options
 * snapshot; every execution-semantic option remains compared.
 */
export function effectiveOptionsResumeCompatibilityHash(options: EffectiveRunOptions): string {
  const {
    contentHash: _contentHash,
    task: _task,
    dryRun: _dryRun,
    telemetryPolicy,
    ...projection
  } = options
  return hashCanonicalValue("ralph.execution.resume-compatible-options.v1", {
    ...projection,
    telemetryPolicy: telemetryPolicy ?? {
      value: DEFAULT_CONFIG.telemetry,
      source: "builtin" as const,
    },
  })
}

export function effectiveOptionsAreResumeCompatible(
  stored: EffectiveRunOptions,
  incoming: EffectiveRunOptions,
): boolean {
  return (
    effectiveOptionsResumeCompatibilityHash(stored) ===
    effectiveOptionsResumeCompatibilityHash(incoming)
  )
}
