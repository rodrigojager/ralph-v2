import {
  AllowedCommandSchema,
  type EvaluationRubricConfig,
  EvaluationRubricConfigSchema,
  EXIT_CODES,
  ExternalCliAdapterSchema,
  ExternalCliEnvironmentNameSchema,
  ExternalCliEnvironmentRefSchema,
  ExternalCliMutationModeSchema,
  ExternalCliToolCallingSchema,
  ExternalCliUsageSchema,
  HeadlessAskSchema,
  PortableRelativePathSchema,
  PortableRelativeScopeSchema,
  ProfileParameterNameSchema,
  type ProfileParameterValue,
  RalphError,
  type ResumeDiscovery,
  ResumeDiscoverySchema,
  SecurityModeSchema,
  ToolNameSchema,
} from "@ralph-next/domain"
import type { EventLevel, LogSource, OutputFormat } from "@ralph-next/telemetry"
import { type CanonicalCommand, resolveCommandTokens } from "./command-registry"
import { inheritableRoleProfileFormField, inheritableRoleProfileFormFieldIds } from "./settings"

export type CanonicalNoChangePolicy =
  | "require-change"
  | "allow-no-change"
  | "fail-on-no-change"
  | "retry-on-no-change"

export type LegacyNoChangePolicy = "retry" | "fail-fast" | "fallback"

export type NoChangePolicyInput = CanonicalNoChangePolicy | LegacyNoChangePolicy

export type ProfileFallbackFailureInput =
  | "provider-unavailable"
  | "model-unavailable"
  | "rate-limit"
  | "transient"

export type CliCommand = CanonicalCommand

export type CliOptions = {
  format: OutputFormat
  workspace?: string
  noColor: boolean
  debug: boolean
  force: boolean
  nonInteractive: boolean
  effective: boolean
  recursive: boolean
  strict: boolean
  check: boolean
  inPlace: boolean
  dryRun: boolean
  failFast: boolean
  skipTests: boolean
  skipLint: boolean
  skipGates: string[]
  noGates: boolean
  fast: boolean
  noCommit: boolean
  wiggum: boolean
  refresh: boolean
  headless: boolean
  secretStdin: boolean
  allowInsecureStore: boolean
  requireTools: boolean
  requireStructuredOutput: boolean
  clearCredential: boolean
  clearVariant: boolean
  clearParameters: boolean
  clearExecutorCredential: boolean
  clearExecutorVariant: boolean
  clearExecutorParameters: boolean
  clearJudgeCredential: boolean
  clearJudgeVariant: boolean
  clearJudgeParameters: boolean
  setDefault: boolean
  allowShell: boolean
  newRun: boolean
  acceptWorkspaceChanges: boolean
  all: boolean
  graceful: boolean
  follow: boolean
  pending: boolean
  completed: boolean
  review: boolean
  importAdapters: boolean
  importRecipes: boolean
  mode?: string
  ui?: string
  lang?: string
  output?: string
  destination?: string
  report?: string
  prd?: string
  executorProfile?: string
  executorProvider?: string
  executorModel?: string
  executorCredential?: string
  executorVariant?: string
  executorParameters: Record<string, ProfileParameterValue>
  judgeProfile?: string
  judgeProvider?: string
  judgeModel?: string
  judgeCredential?: string
  judgeVariant?: string
  judgeParameters: Record<string, ProfileParameterValue>
  evaluationMode?: "deterministic-only" | "self" | "external" | "manual"
  judgeThreshold?: number
  maxRevisionAttempts?: number
  judgeCallRetries?: number
  judgeUnavailablePolicy?: "deterministic" | "pause" | "fail"
  judgeBlockingSeverities: ("info" | "minor" | "major" | "critical")[]
  judgeRubric?: EvaluationRubricConfig | null
  judgeExhaustedPolicy?: "manual-review" | "fail" | "stop-run"
  provider?: string
  model?: string
  profile?: string
  credential?: string
  method?: string
  label?: string
  repo?: string
  issueState?: "open" | "closed" | "all"
  environmentName?: string
  role?: string
  backend?: string
  variant?: string
  scope?: string
  serialization?: "yaml" | "json"
  fallbackProfiles: string[]
  fallbackOn: ProfileFallbackFailureInput[]
  parameters: Record<string, ProfileParameterValue>
  inheritProfileFields: string[]
  cliExecutable?: string
  cliArgs: string[]
  cliCwd?: string
  cliEnvironmentRefs: Record<string, string>
  cliAdapter?: "protocol" | "known-output" | "generic"
  cliAdapterId?: string
  cliStreaming?: boolean
  cliToolCalling?: "ralph" | "internal" | "unavailable"
  cliCancellation?: boolean
  cliUsage?: "reported" | "estimated" | "unavailable"
  cliMutationMode?: "read-only" | "workspace"
  cliTimeoutMs?: number
  cliOutputLimitBytes?: number
  securityMode?: "safe" | "auto" | "dangerous"
  headlessAsk?: "deny" | "allow"
  allowTools: string[]
  denyTools: string[]
  askTools: string[]
  allowCommands: string[]
  readPaths: string[]
  writePaths: string[]
  maxParallel?: number
  maxGlobalParallel?: number
  parallelAuto?: boolean
  parallelGroups: string[]
  retryFailed?: boolean
  maxFailureRetries?: number
  integrationStrategy?: "no-merge" | "none" | "merge" | "rebase-merge" | "cherry-pick" | "create-pr"
  branchPerTask?: boolean
  baseBranch?: string
  integrationBranch?: string
  sandboxEnabled?: boolean
  sandboxProvider?: "process" | "docker" | "podman"
  sandboxImage?: string
  task?: string
  /** Positional `once` text; never interpreted as a PRD task selector. */
  adHocDescription?: string
  maxTasks?: number
  retryDelay?: number
  maxIterations?: number
  maxModelCalls?: number
  timeout?: number
  noChangePolicy?: NoChangePolicyInput
  noChangeMaxRetries?: number
  runId?: string
  attemptId?: string
  evidenceBundleId?: string
  verificationOperationId?: string
  resumeDiscovery?: ResumeDiscovery
  grace?: number
  additionalRevisions?: number
  reason?: string
  level?: EventLevel
  source?: LogSource
  since?: string
  eventType?: string
  workerId?: string
  limit?: number
  evidencePaths: string[]
  checkpointPaths: string[]
  inventoryRoots: string[]
  confirmationPlanHash?: string
  rollbackExpires?: number
  installRoot?: string
  releaseManifest?: string
  releaseChannel?: "nightly" | "beta" | "stable"
  releaseVersion?: string
  allowDowngrade: boolean
}

export type ParsedCli = {
  command: CliCommand
  arguments: string[]
  options: CliOptions
}

const VALUE_FLAGS = new Map<string, keyof CliOptions>([
  ["--format", "format"],
  ["--workspace", "workspace"],
  ["--mode", "mode"],
  ["--ui", "ui"],
  ["--lang", "lang"],
  ["--output", "output"],
  ["--destination", "destination"],
  ["--report", "report"],
  ["--prd", "prd"],
  ["--executor-profile", "executorProfile"],
  ["--executor-provider", "executorProvider"],
  ["--executor-model", "executorModel"],
  ["--executor-credential", "executorCredential"],
  ["--executor-variant", "executorVariant"],
  ["--executor-parameter", "executorParameters"],
  ["--judge-profile", "judgeProfile"],
  ["--judge-provider", "judgeProvider"],
  ["--judge-model", "judgeModel"],
  ["--judge-credential", "judgeCredential"],
  ["--judge-variant", "judgeVariant"],
  ["--judge-parameter", "judgeParameters"],
  ["--evaluation", "evaluationMode"],
  ["--judge-threshold", "judgeThreshold"],
  ["--judge-max-revisions", "maxRevisionAttempts"],
  ["--max-revisions", "maxRevisionAttempts"],
  ["--judge-call-retries", "judgeCallRetries"],
  ["--judge-unavailable", "judgeUnavailablePolicy"],
  ["--judge-blocking-severity", "judgeBlockingSeverities"],
  ["--judge-rubric", "judgeRubric"],
  ["--judge-exhausted", "judgeExhaustedPolicy"],
  ["--provider", "provider"],
  ["--model", "model"],
  ["--profile", "profile"],
  ["--credential", "credential"],
  ["--method", "method"],
  ["--label", "label"],
  ["--repo", "repo"],
  ["--state", "issueState"],
  ["--environment", "environmentName"],
  ["--role", "role"],
  ["--backend", "backend"],
  ["--variant", "variant"],
  ["--scope", "scope"],
  ["--serialization", "serialization"],
  ["--fallback-profile", "fallbackProfiles"],
  ["--fallback-on", "fallbackOn"],
  ["--parameter", "parameters"],
  ["--inherit-profile-field", "inheritProfileFields"],
  ["--cli-executable", "cliExecutable"],
  ["--cli-arg", "cliArgs"],
  ["--cli-cwd", "cliCwd"],
  ["--cli-env", "cliEnvironmentRefs"],
  ["--cli-adapter", "cliAdapter"],
  ["--cli-adapter-id", "cliAdapterId"],
  ["--cli-streaming", "cliStreaming"],
  ["--cli-tool-calling", "cliToolCalling"],
  ["--cli-cancellation", "cliCancellation"],
  ["--cli-usage", "cliUsage"],
  ["--cli-mutation", "cliMutationMode"],
  ["--cli-timeout-ms", "cliTimeoutMs"],
  ["--cli-output-limit-bytes", "cliOutputLimitBytes"],
  ["--security", "securityMode"],
  ["--headless-ask", "headlessAsk"],
  ["--allow-tool", "allowTools"],
  ["--deny-tool", "denyTools"],
  ["--ask-tool", "askTools"],
  ["--allow-command", "allowCommands"],
  ["--read-path", "readPaths"],
  ["--write-path", "writePaths"],
  ["--max-parallel", "maxParallel"],
  ["--max-global-parallel", "maxGlobalParallel"],
  ["--parallel-group", "parallelGroups"],
  ["--max-failure-retries", "maxFailureRetries"],
  ["--integration", "integrationStrategy"],
  ["--base-branch", "baseBranch"],
  ["--integration-branch", "integrationBranch"],
  ["--sandbox-provider", "sandboxProvider"],
  ["--sandbox-image", "sandboxImage"],
  ["--task", "task"],
  ["--max-tasks", "maxTasks"],
  ["--retry-delay", "retryDelay"],
  ["--max-iterations", "maxIterations"],
  ["--max-model-calls", "maxModelCalls"],
  ["--timeout", "timeout"],
  ["--no-change-policy", "noChangePolicy"],
  ["--no-change-max-retries", "noChangeMaxRetries"],
  ["--skip-gates", "skipGates"],
  ["--run-id", "runId"],
  ["--attempt-id", "attemptId"],
  ["--evidence-bundle-id", "evidenceBundleId"],
  ["--verification-id", "verificationOperationId"],
  ["--grace", "grace"],
  ["--additional-revisions", "additionalRevisions"],
  ["--reason", "reason"],
  ["--level", "level"],
  ["--source", "source"],
  ["--since", "since"],
  ["--type", "eventType"],
  ["--worker-id", "workerId"],
  ["--limit", "limit"],
  ["--evidence", "evidencePaths"],
  ["--path", "checkpointPaths"],
  ["--inventory-root", "inventoryRoots"],
  ["--confirm-plan-hash", "confirmationPlanHash"],
  ["--expires-in", "rollbackExpires"],
  ["--install-root", "installRoot"],
  ["--manifest", "releaseManifest"],
  ["--channel", "releaseChannel"],
  ["--to-version", "releaseVersion"],
])

const BOOLEAN_FLAGS = new Map<string, keyof CliOptions>([
  ["--json", "format"],
  ["--no-color", "noColor"],
  ["--debug", "debug"],
  ["--force", "force"],
  ["--non-interactive", "nonInteractive"],
  ["--effective", "effective"],
  ["--recursive", "recursive"],
  ["--strict", "strict"],
  ["--check", "check"],
  ["--in-place", "inPlace"],
  ["--dry-run", "dryRun"],
  ["--fail-fast", "failFast"],
  ["--skip-tests", "skipTests"],
  ["--skip-lint", "skipLint"],
  ["--no-gates", "noGates"],
  ["--fast", "fast"],
  ["--no-commit", "noCommit"],
  ["--wiggum", "wiggum"],
  ["--refresh", "refresh"],
  ["--headless", "headless"],
  ["--secret-stdin", "secretStdin"],
  ["--allow-insecure-store", "allowInsecureStore"],
  ["--require-tools", "requireTools"],
  ["--require-structured-output", "requireStructuredOutput"],
  ["--clear-credential", "clearCredential"],
  ["--clear-variant", "clearVariant"],
  ["--clear-parameters", "clearParameters"],
  ["--clear-executor-credential", "clearExecutorCredential"],
  ["--clear-executor-variant", "clearExecutorVariant"],
  ["--clear-executor-parameters", "clearExecutorParameters"],
  ["--clear-judge-credential", "clearJudgeCredential"],
  ["--clear-judge-variant", "clearJudgeVariant"],
  ["--clear-judge-parameters", "clearJudgeParameters"],
  ["--set-default", "setDefault"],
  ["--allow-shell", "allowShell"],
  ["--new-run", "newRun"],
  ["--accept-workspace-changes", "acceptWorkspaceChanges"],
  ["--parallel-auto", "parallelAuto"],
  ["--retry-failed", "retryFailed"],
  ["--git-worktrees", "branchPerTask"],
  ["--sandbox", "sandboxEnabled"],
  ["--all", "all"],
  ["--graceful", "graceful"],
  ["--follow", "follow"],
  ["--pending", "pending"],
  ["--completed", "completed"],
  ["--review", "review"],
  ["--import-adapters", "importAdapters"],
  ["--import-recipes", "importRecipes"],
  ["--allow-downgrade", "allowDowngrade"],
])

type ProfileInheritConflict = {
  readonly key: keyof CliOptions
  readonly flag: string
}

/** Same-leaf set/clear conflicts; evaluated after argv parsing so order is irrelevant. */
const PROFILE_INHERIT_CONFLICTS: Readonly<Record<string, readonly ProfileInheritConflict[]>> = {
  backend: [{ key: "backend", flag: "--backend" }],
  provider: [{ key: "provider", flag: "--provider" }],
  model: [{ key: "model", flag: "--model" }],
  credential: [
    { key: "credential", flag: "--credential" },
    { key: "clearCredential", flag: "--clear-credential" },
  ],
  variant: [
    { key: "variant", flag: "--variant" },
    { key: "clearVariant", flag: "--clear-variant" },
  ],
  parameters: [
    { key: "parameters", flag: "--parameter" },
    { key: "clearParameters", flag: "--clear-parameters" },
  ],
  fallbackProfiles: [{ key: "fallbackProfiles", flag: "--fallback-profile" }],
  fallbackOn: [{ key: "fallbackOn", flag: "--fallback-on" }],
  requireTools: [{ key: "requireTools", flag: "--require-tools" }],
  requireStructuredOutput: [
    { key: "requireStructuredOutput", flag: "--require-structured-output" },
  ],
  cliExecutable: [{ key: "cliExecutable", flag: "--cli-executable" }],
  cliArgs: [{ key: "cliArgs", flag: "--cli-arg" }],
  cliCwd: [{ key: "cliCwd", flag: "--cli-cwd" }],
  cliEnvironmentRefs: [{ key: "cliEnvironmentRefs", flag: "--cli-env" }],
  cliAdapter: [{ key: "cliAdapter", flag: "--cli-adapter" }],
  cliAdapterId: [{ key: "cliAdapterId", flag: "--cli-adapter-id" }],
  cliStreaming: [{ key: "cliStreaming", flag: "--cli-streaming" }],
  cliToolCalling: [{ key: "cliToolCalling", flag: "--cli-tool-calling" }],
  cliCancellation: [{ key: "cliCancellation", flag: "--cli-cancellation" }],
  cliUsage: [{ key: "cliUsage", flag: "--cli-usage" }],
  cliMutationMode: [{ key: "cliMutationMode", flag: "--cli-mutation" }],
  cliTimeoutMs: [{ key: "cliTimeoutMs", flag: "--cli-timeout-ms" }],
  cliOutputLimitBytes: [{ key: "cliOutputLimitBytes", flag: "--cli-output-limit-bytes" }],
}

const EXTERNAL_CLI_PROFILE_OPTIONS: readonly ProfileInheritConflict[] = [
  { key: "cliExecutable", flag: "--cli-executable" },
  { key: "cliArgs", flag: "--cli-arg" },
  { key: "cliCwd", flag: "--cli-cwd" },
  { key: "cliEnvironmentRefs", flag: "--cli-env" },
  { key: "cliAdapter", flag: "--cli-adapter" },
  { key: "cliAdapterId", flag: "--cli-adapter-id" },
  { key: "cliStreaming", flag: "--cli-streaming" },
  { key: "cliToolCalling", flag: "--cli-tool-calling" },
  { key: "cliCancellation", flag: "--cli-cancellation" },
  { key: "cliUsage", flag: "--cli-usage" },
  { key: "cliMutationMode", flag: "--cli-mutation" },
  { key: "cliTimeoutMs", flag: "--cli-timeout-ms" },
  { key: "cliOutputLimitBytes", flag: "--cli-output-limit-bytes" },
]

const EXECUTION_OPTIONS = [
  "format",
  "workspace",
  "noColor",
  "debug",
  "force",
  "nonInteractive",
  "ui",
  "prd",
  "executorProfile",
  "executorProvider",
  "executorModel",
  "executorCredential",
  "executorVariant",
  "executorParameters",
  "clearExecutorCredential",
  "clearExecutorVariant",
  "clearExecutorParameters",
  "judgeProfile",
  "judgeProvider",
  "judgeModel",
  "judgeCredential",
  "judgeVariant",
  "judgeParameters",
  "clearJudgeCredential",
  "clearJudgeVariant",
  "clearJudgeParameters",
  "evaluationMode",
  "judgeThreshold",
  "maxRevisionAttempts",
  "judgeCallRetries",
  "judgeUnavailablePolicy",
  "judgeBlockingSeverities",
  "judgeRubric",
  "judgeExhaustedPolicy",
  "task",
  "dryRun",
  "retryDelay",
  "maxModelCalls",
  "noChangePolicy",
  "noChangeMaxRetries",
  "skipTests",
  "skipLint",
  "skipGates",
  "noGates",
  "fast",
  "noCommit",
  "runId",
  "resumeDiscovery",
  "newRun",
  "securityMode",
  "headlessAsk",
  "allowTools",
  "denyTools",
  "askTools",
  "allowCommands",
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
] as const satisfies readonly (keyof CliOptions)[]

function options(...keys: readonly (keyof CliOptions)[]): ReadonlySet<keyof CliOptions> {
  return new Set(keys)
}

const ALLOWED_OPTIONS: Record<CliCommand, ReadonlySet<keyof CliOptions>> = {
  help: options("format", "noColor", "debug"),
  version: options("format", "noColor", "debug"),
  about: options("format", "noColor", "debug"),
  init: options("format", "workspace", "noColor", "debug", "force", "nonInteractive"),
  clean: options("format", "workspace", "noColor", "debug", "force", "dryRun", "nonInteractive"),
  status: options("format", "workspace", "noColor", "debug", "all"),
  "status.run": options("format", "workspace", "noColor", "debug", "runId"),
  resume: options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "nonInteractive",
    "prd",
    "runId",
    "resumeDiscovery",
    "acceptWorkspaceChanges",
  ),
  stop: options("format", "workspace", "noColor", "debug", "runId", "graceful", "grace", "force"),
  attach: options("format", "workspace", "noColor", "debug", "runId"),
  replay: options("format", "workspace", "noColor", "debug", "runId"),
  doctor: options("format", "workspace", "noColor", "debug", "nonInteractive"),
  "config.explain": options("format", "workspace", "noColor", "debug", "mode", "ui", "lang"),
  "config.list": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "effective",
    "mode",
    "ui",
    "lang",
  ),
  "config.get": options("format", "workspace", "noColor", "debug", "mode", "ui", "lang"),
  "config.preview": options("format", "workspace", "noColor", "debug", "scope"),
  "config.set": options("format", "workspace", "noColor", "debug", "scope"),
  "config.unset": options("format", "workspace", "noColor", "debug", "scope", "dryRun"),
  "config.edit": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "scope",
    "dryRun",
    "nonInteractive",
  ),
  "config.import": options("format", "workspace", "noColor", "debug", "scope", "dryRun"),
  "config.export": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "scope",
    "serialization",
    "output",
    "force",
  ),
  "config.validate": options("format", "workspace", "noColor", "debug", "mode", "ui", "lang"),
  "prd.validate": options("format", "workspace", "noColor", "debug", "recursive", "strict"),
  "prd.inspect": options("format", "workspace", "noColor", "debug", "recursive", "strict"),
  "prd.format": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "strict",
    "check",
    "output",
    "inPlace",
    "force",
  ),
  "prd.migrate": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "strict",
    "output",
    "report",
    "inPlace",
    "force",
  ),
  once: options(...EXECUTION_OPTIONS),
  run: options(...EXECUTION_OPTIONS, "failFast", "maxTasks", "maxIterations", "wiggum", "mode"),
  loop: options(...EXECUTION_OPTIONS, "failFast", "maxTasks"),
  parallel: options(...EXECUTION_OPTIONS, "failFast", "maxTasks"),
  events: options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "runId",
    "follow",
    "level",
    "since",
    "eventType",
    "workerId",
    "task",
    "limit",
  ),
  "logs.tail": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "runId",
    "follow",
    "level",
    "source",
    "since",
    "eventType",
    "workerId",
    "task",
    "limit",
  ),
  "tasks.list": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "prd",
    "all",
    "pending",
    "completed",
    "review",
  ),
  "tasks.next": options("format", "workspace", "noColor", "debug", "prd"),
  "tasks.done": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "prd",
    "force",
    "reason",
    "evidencePaths",
  ),
  "tasks.sync": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "repo",
    "issueState",
    "label",
    "output",
    "force",
  ),
  "migrate.inspect": options("format", "noColor", "debug"),
  "migrate.apply": options(
    "format",
    "noColor",
    "debug",
    "destination",
    "importAdapters",
    "importRecipes",
  ),
  "migrate.rollback": options("format", "noColor", "debug", "dryRun", "confirmationPlanHash"),
  verify: options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "runId",
    "attemptId",
    "evidenceBundleId",
    "task",
    "skipTests",
    "skipLint",
    "skipGates",
    "noGates",
    "fast",
    "force",
    "failFast",
  ),
  judge: options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "runId",
    "attemptId",
    "evidenceBundleId",
    "verificationOperationId",
    "task",
    "executorProfile",
    "executorProvider",
    "executorModel",
    "executorCredential",
    "executorVariant",
    "executorParameters",
    "clearExecutorCredential",
    "clearExecutorVariant",
    "clearExecutorParameters",
    "judgeProfile",
    "judgeProvider",
    "judgeModel",
    "judgeCredential",
    "judgeVariant",
    "judgeParameters",
    "clearJudgeCredential",
    "clearJudgeVariant",
    "clearJudgeParameters",
    "evaluationMode",
    "judgeThreshold",
    "judgeCallRetries",
    "judgeBlockingSeverities",
    "judgeRubric",
  ),
  "evidence.inspect": options("format", "workspace", "noColor", "debug"),
  "report.last": options("format", "workspace", "noColor", "debug"),
  "report.show": options("format", "workspace", "noColor", "debug", "runId"),
  "review.retry": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "runId",
    "task",
    "additionalRevisions",
    "reason",
  ),
  "providers.list": options("format", "workspace", "noColor", "debug", "refresh"),
  "providers.inspect": options("format", "workspace", "noColor", "debug", "refresh"),
  "models.list": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "provider",
    "refresh",
    "requireTools",
    "requireStructuredOutput",
  ),
  "models.inspect": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "provider",
    "variant",
    "refresh",
  ),
  "auth.connect": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "nonInteractive",
    "provider",
    "credential",
    "method",
    "label",
    "environmentName",
    "headless",
    "secretStdin",
    "allowInsecureStore",
    "timeout",
  ),
  "auth.list": options("format", "workspace", "noColor", "debug", "provider"),
  "auth.status": options("format", "workspace", "noColor", "debug", "provider", "refresh"),
  "auth.revoke": options("format", "workspace", "noColor", "debug", "force"),
  "adapters.list": options("format", "workspace", "noColor", "debug"),
  "adapters.new": options("format", "workspace", "noColor", "debug", "force"),
  "adapters.inspect": options("format", "workspace", "noColor", "debug"),
  "recipes.list": options("format", "workspace", "noColor", "debug"),
  "recipes.new": options("format", "workspace", "noColor", "debug", "force"),
  "recipes.show": options("format", "workspace", "noColor", "debug"),
  "rules.list": options("format", "workspace", "noColor", "debug"),
  "rules.add": options("format", "workspace", "noColor", "debug"),
  "rules.clear": options("format", "workspace", "noColor", "debug", "force"),
  "context.inspect": options("format", "workspace", "noColor", "debug", "runId", "limit"),
  "context.export": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "runId",
    "limit",
    "output",
    "force",
  ),
  "context.rotate": options("format", "workspace", "noColor", "debug", "runId", "reason"),
  "checkpoint.create": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "prd",
    "runId",
    "reason",
    "checkpointPaths",
    "inventoryRoots",
  ),
  "checkpoint.list": options("format", "workspace", "noColor", "debug", "runId", "limit"),
  "checkpoint.show": options("format", "workspace", "noColor", "debug"),
  "rollback.preview": options("format", "workspace", "noColor", "debug", "prd", "rollbackExpires"),
  "rollback.apply": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "prd",
    "confirmationPlanHash",
  ),
  "lang.current": options("format", "workspace", "noColor", "debug"),
  "lang.list": options("format", "workspace", "noColor", "debug"),
  "lang.set": options("format", "workspace", "noColor", "debug", "scope"),
  "lang.update": options("format", "workspace", "noColor", "debug"),
  install: options(
    "format",
    "noColor",
    "debug",
    "nonInteractive",
    "dryRun",
    "installRoot",
    "releaseManifest",
    "releaseChannel",
    "releaseVersion",
  ),
  update: options(
    "format",
    "noColor",
    "debug",
    "nonInteractive",
    "dryRun",
    "check",
    "installRoot",
    "releaseManifest",
    "releaseChannel",
    "releaseVersion",
    "allowDowngrade",
  ),
  "install.rollback": options(
    "format",
    "noColor",
    "debug",
    "nonInteractive",
    "dryRun",
    "installRoot",
    "releaseVersion",
  ),
  uninstall: options("format", "noColor", "debug", "nonInteractive", "dryRun", "installRoot"),
  "alias.ralph.status": options("format", "noColor", "debug", "installRoot"),
  "alias.ralph.install": options(
    "format",
    "noColor",
    "debug",
    "nonInteractive",
    "dryRun",
    "installRoot",
    "confirmationPlanHash",
  ),
  "alias.ralph.remove": options(
    "format",
    "noColor",
    "debug",
    "nonInteractive",
    "dryRun",
    "installRoot",
    "confirmationPlanHash",
  ),
  "profiles.list": options("format", "workspace", "noColor", "debug", "role"),
  "profiles.inspect": options("format", "workspace", "noColor", "debug"),
  "profiles.configure": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "nonInteractive",
    "profile",
    "scope",
    "role",
    "backend",
    "provider",
    "model",
    "credential",
    "variant",
    "clearCredential",
    "clearVariant",
    "clearParameters",
    "setDefault",
    "fallbackProfiles",
    "fallbackOn",
    "parameters",
    "inheritProfileFields",
    "requireTools",
    "requireStructuredOutput",
    "force",
    "cliExecutable",
    "cliArgs",
    "cliCwd",
    "cliEnvironmentRefs",
    "cliAdapter",
    "cliAdapterId",
    "cliStreaming",
    "cliToolCalling",
    "cliCancellation",
    "cliUsage",
    "cliMutationMode",
    "cliTimeoutMs",
    "cliOutputLimitBytes",
  ),
  "model.smoke": options(
    "format",
    "workspace",
    "noColor",
    "debug",
    "profile",
    "provider",
    "model",
    "credential",
    "variant",
    "parameters",
    "refresh",
    "timeout",
  ),
}

const NO_CHANGE_POLICIES = new Set<NoChangePolicyInput>([
  "require-change",
  "allow-no-change",
  "fail-on-no-change",
  "retry-on-no-change",
  "retry",
  "fail-fast",
  "fallback",
])

const EXECUTABLE_RUN_MODES = new Set(["once", "loop", "wiggum", "parallel"])
const PROFILE_FALLBACK_FAILURES = new Set<ProfileFallbackFailureInput>([
  "provider-unavailable",
  "model-unavailable",
  "rate-limit",
  "transient",
])
const EVALUATION_MODES = new Set(["deterministic-only", "self", "external", "manual"] as const)
const JUDGE_UNAVAILABLE_POLICIES = new Set(["deterministic", "pause", "fail"] as const)
const JUDGE_SEVERITIES = new Set(["info", "minor", "major", "critical"] as const)
const JUDGE_EXHAUSTED_POLICIES = new Set(["manual-review", "fail", "stop-run"] as const)
const RESUME_DISCOVERY_MODES = new Set(ResumeDiscoverySchema.options)
const EVENT_LEVELS = new Set<EventLevel>(["trace", "debug", "info", "warn", "error"])
const LOG_SOURCES = new Set<LogSource>([
  "audit",
  "human",
  "raw-engine",
  "tool",
  "gate",
  "diagnostic",
])

function invalidUsage(code: string, message: string, hint?: string): never {
  throw new RalphError(code, message, {
    exitCode: EXIT_CODES.invalidUsage,
    ...(hint ? { hint } : {}),
  })
}

function parseFormat(value: string): OutputFormat {
  if (value === "human" || value === "json" || value === "jsonl") return value
  return invalidUsage(
    "RALPH_FORMAT_INVALID",
    `Invalid output format: ${value}`,
    "Use one of: human, json, jsonl.",
  )
}

function parseNonBlank(flag: string, value: string): string {
  if (value.trim().length > 0) return value
  return invalidUsage("RALPH_OPTION_VALUE_INVALID", `Option requires a non-blank value: ${flag}`)
}

function parseSafeInteger(flag: string, value: string, minimum: number): number {
  if (!/^\d+$/.test(value)) {
    return invalidUsage(
      "RALPH_OPTION_INTEGER_INVALID",
      `Option requires a base-10 integer: ${flag}`,
    )
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    return invalidUsage(
      "RALPH_OPTION_INTEGER_RANGE",
      `${flag} must be a safe integer greater than or equal to ${minimum}`,
    )
  }
  return parsed
}

function parseBooleanValue(flag: string, value: string): boolean {
  if (value === "true") return true
  if (value === "false") return false
  return invalidUsage("RALPH_OPTION_BOOLEAN_INVALID", `${flag} requires true or false`)
}

function parseCliArgument(flag: string, value: string): string {
  if (!value.startsWith('"')) return value
  try {
    const decoded: unknown = JSON.parse(value)
    if (typeof decoded !== "string") throw new Error("not a string")
    return decoded
  } catch {
    return invalidUsage(
      "RALPH_EXTERNAL_CLI_ARGUMENT_INVALID",
      `${flag} contains an invalid JSON string argument`,
      'Use a literal argument or a JSON string such as --cli-arg="\\"two words\\"".',
    )
  }
}

function pushUniqueOption(target: string[], flag: string, value: string): void {
  if (target.includes(value)) {
    invalidUsage(
      "RALPH_OPTION_VALUE_DUPLICATED",
      `Value specified more than once for ${flag}: ${value}`,
    )
  }
  target.push(value)
}

function parseToolName(flag: string, value: string): string {
  const parsed = ToolNameSchema.safeParse(value)
  if (parsed.success) return parsed.data
  return invalidUsage("RALPH_TOOL_NAME_INVALID", `Invalid tool name for ${flag}: ${value}`)
}

function assertNoToolRuleConflict(optionsValue: CliOptions, tool: string, flag: string): void {
  const decisions = [
    ["--allow-tool", optionsValue.allowTools],
    ["--deny-tool", optionsValue.denyTools],
    ["--ask-tool", optionsValue.askTools],
  ] as const
  const conflict = decisions.find(
    ([candidateFlag, values]) => candidateFlag !== flag && values.includes(tool),
  )
  if (conflict) {
    invalidUsage(
      "RALPH_TOOL_RULE_CONFLICT",
      `Tool ${tool} has conflicting rules from ${conflict[0]} and ${flag}`,
    )
  }
}

function parseDelay(flag: string, value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return invalidUsage(
      "RALPH_OPTION_NUMBER_INVALID",
      `${flag} must be a finite number of seconds greater than or equal to 0`,
    )
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return invalidUsage(
      "RALPH_OPTION_NUMBER_INVALID",
      `${flag} must be a finite number of seconds greater than or equal to 0`,
    )
  }
  return parsed
}

function parseNoChangePolicy(value: string): NoChangePolicyInput {
  if (NO_CHANGE_POLICIES.has(value as NoChangePolicyInput)) return value as NoChangePolicyInput
  return invalidUsage(
    "RALPH_NO_CHANGE_POLICY_INVALID",
    `Invalid no-change policy: ${value}`,
    "Use require-change, allow-no-change, fail-on-no-change, retry-on-no-change or a documented legacy alias.",
  )
}

function parseProfileParameter(
  flag: string,
  input: string,
): {
  name: string
  value: ProfileParameterValue
} {
  const separator = input.indexOf("=")
  if (separator <= 0) {
    return invalidUsage(
      "RALPH_PROFILE_PARAMETER_SYNTAX_INVALID",
      `${flag} requires NAME=VALUE`,
      "Use a provider-declared parameter name and a string, finite number, boolean or null value.",
    )
  }
  const nameResult = ProfileParameterNameSchema.safeParse(input.slice(0, separator))
  if (!nameResult.success) {
    return invalidUsage(
      "RALPH_PROFILE_PARAMETER_NAME_INVALID",
      `${flag} contains an invalid parameter name`,
    )
  }
  const literal = input.slice(separator + 1)
  let value: ProfileParameterValue
  if (literal === "true") value = true
  else if (literal === "false") value = false
  else if (literal === "null") value = null
  else if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(literal)) {
    const numeric = Number(literal)
    if (!Number.isFinite(numeric)) {
      return invalidUsage(
        "RALPH_PROFILE_PARAMETER_VALUE_INVALID",
        `${flag} contains a non-finite numeric value`,
      )
    }
    value = numeric
  } else if (literal.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(literal)
      if (typeof decoded !== "string") throw new Error("not a string")
      value = decoded
    } catch {
      return invalidUsage(
        "RALPH_PROFILE_PARAMETER_VALUE_INVALID",
        `${flag} contains an invalid quoted string`,
      )
    }
  } else value = literal
  return { name: nameResult.data, value }
}

function assignValueOption(
  optionsValue: CliOptions,
  key: keyof CliOptions,
  flag: string,
  value: string,
) {
  switch (key) {
    case "format":
      optionsValue.format = parseFormat(value)
      return
    case "maxTasks":
    case "maxParallel":
    case "maxGlobalParallel":
    case "maxIterations":
    case "maxModelCalls":
    case "timeout":
    case "cliTimeoutMs":
    case "cliOutputLimitBytes":
    case "limit":
      optionsValue[key] = parseSafeInteger(flag, value, 1)
      return
    case "rollbackExpires":
      optionsValue.rollbackExpires = parseSafeInteger(flag, value, 1)
      if (optionsValue.rollbackExpires > 3_600) {
        return invalidUsage(
          "RALPH_ROLLBACK_EXPIRY_INVALID",
          `${flag} must be between 1 and 3600 seconds`,
        )
      }
      return
    case "noChangeMaxRetries":
      optionsValue.noChangeMaxRetries = parseSafeInteger(flag, value, 0)
      return
    case "maxFailureRetries":
      optionsValue.maxFailureRetries = parseSafeInteger(flag, value, 0)
      return
    case "judgeThreshold": {
      const threshold = parseSafeInteger(flag, value, 0)
      if (threshold > 100) {
        return invalidUsage(
          "RALPH_JUDGE_THRESHOLD_INVALID",
          `${flag} must be an integer between 0 and 100`,
        )
      }
      optionsValue.judgeThreshold = threshold
      return
    }
    case "maxRevisionAttempts":
      optionsValue.maxRevisionAttempts = parseSafeInteger(flag, value, 0)
      return
    case "judgeCallRetries":
      optionsValue.judgeCallRetries = parseSafeInteger(flag, value, 0)
      return
    case "additionalRevisions":
      optionsValue.additionalRevisions = parseSafeInteger(flag, value, 1)
      return
    case "evaluationMode": {
      if (!EVALUATION_MODES.has(value as never)) {
        return invalidUsage(
          "RALPH_EVALUATION_MODE_INVALID",
          `Invalid evaluation mode: ${value}`,
          "Use deterministic-only, self, external or manual.",
        )
      }
      optionsValue.evaluationMode = value as Exclude<CliOptions["evaluationMode"], undefined>
      return
    }
    case "judgeUnavailablePolicy": {
      if (!JUDGE_UNAVAILABLE_POLICIES.has(value as never)) {
        return invalidUsage(
          "RALPH_JUDGE_UNAVAILABLE_POLICY_INVALID",
          `Invalid judge-unavailable policy: ${value}`,
          "Use deterministic, pause or fail.",
        )
      }
      optionsValue.judgeUnavailablePolicy = value as Exclude<
        CliOptions["judgeUnavailablePolicy"],
        undefined
      >
      return
    }
    case "judgeBlockingSeverities": {
      if (!JUDGE_SEVERITIES.has(value as never)) {
        return invalidUsage(
          "RALPH_JUDGE_SEVERITY_INVALID",
          `Invalid blocking judge severity: ${value}`,
          "Use info, minor, major or critical.",
        )
      }
      const severity = value as CliOptions["judgeBlockingSeverities"][number]
      if (optionsValue.judgeBlockingSeverities.includes(severity)) {
        return invalidUsage(
          "RALPH_OPTION_VALUE_DUPLICATED",
          `Judge severity specified more than once: ${severity}`,
        )
      }
      optionsValue.judgeBlockingSeverities.push(severity)
      return
    }
    case "judgeRubric": {
      if (value.trim().toLocaleLowerCase("und") === "derive") {
        optionsValue.judgeRubric = null
        return
      }
      let candidate: unknown
      try {
        candidate = JSON.parse(value)
      } catch {
        return invalidUsage(
          "RALPH_JUDGE_RUBRIC_INVALID",
          `${flag} must be one JSON object or the literal derive`,
        )
      }
      const rubric = EvaluationRubricConfigSchema.safeParse(candidate)
      if (!rubric.success) {
        const issue = rubric.error.issues[0]
        return invalidUsage(
          "RALPH_JUDGE_RUBRIC_INVALID",
          `${flag} contains an invalid rubric${issue ? ` at ${issue.path.join(".") || "root"}: ${issue.message}` : ""}`,
        )
      }
      optionsValue.judgeRubric = rubric.data
      return
    }
    case "judgeExhaustedPolicy": {
      if (!JUDGE_EXHAUSTED_POLICIES.has(value as never)) {
        return invalidUsage(
          "RALPH_JUDGE_EXHAUSTED_POLICY_INVALID",
          `Invalid judge exhaustion policy: ${value}`,
          "Use manual-review, fail or stop-run.",
        )
      }
      optionsValue.judgeExhaustedPolicy = value as Exclude<
        CliOptions["judgeExhaustedPolicy"],
        undefined
      >
      return
    }
    case "retryDelay":
      optionsValue.retryDelay = parseDelay(flag, value)
      return
    case "grace":
      optionsValue.grace = parseDelay(flag, value)
      return
    case "noChangePolicy":
      optionsValue.noChangePolicy = parseNoChangePolicy(value)
      return
    case "skipGates": {
      const gate = parseNonBlank(flag, value)
      if (optionsValue.skipGates.includes(gate)) {
        return invalidUsage(
          "RALPH_OPTION_VALUE_DUPLICATED",
          `Gate specified more than once for --skip-gates: ${gate}`,
        )
      }
      optionsValue.skipGates.push(gate)
      return
    }
    case "parallelGroups":
      pushUniqueOption(optionsValue.parallelGroups, flag, parseNonBlank(flag, value))
      return
    case "integrationStrategy": {
      if (
        value !== "no-merge" &&
        value !== "none" &&
        value !== "merge" &&
        value !== "rebase-merge" &&
        value !== "cherry-pick" &&
        value !== "create-pr"
      ) {
        return invalidUsage(
          "RALPH_PARALLEL_INTEGRATION_INVALID",
          `Invalid integration strategy: ${value}`,
          "Use none, merge, rebase-merge, cherry-pick or create-pr.",
        )
      }
      optionsValue.integrationStrategy = value
      return
    }
    case "sandboxProvider": {
      if (value !== "process" && value !== "docker" && value !== "podman") {
        return invalidUsage(
          "RALPH_SANDBOX_PROVIDER_INVALID",
          `Invalid sandbox provider: ${value}`,
          "Use process, docker or podman.",
        )
      }
      optionsValue.sandboxProvider = value
      return
    }
    case "fallbackProfiles": {
      const profile = parseNonBlank(flag, value)
      if (optionsValue.fallbackProfiles.includes(profile)) {
        return invalidUsage(
          "RALPH_OPTION_VALUE_DUPLICATED",
          `Profile specified more than once for --fallback-profile: ${profile}`,
        )
      }
      optionsValue.fallbackProfiles.push(profile)
      return
    }
    case "fallbackOn": {
      const failure = parseNonBlank(flag, value) as ProfileFallbackFailureInput
      if (!PROFILE_FALLBACK_FAILURES.has(failure)) {
        return invalidUsage(
          "RALPH_PROFILE_FALLBACK_FAILURE_INVALID",
          `Invalid fallback failure class: ${failure}`,
          "Use provider-unavailable, model-unavailable, rate-limit or transient.",
        )
      }
      if (optionsValue.fallbackOn.includes(failure)) {
        return invalidUsage(
          "RALPH_OPTION_VALUE_DUPLICATED",
          `Failure class specified more than once for --fallback-on: ${failure}`,
        )
      }
      optionsValue.fallbackOn.push(failure)
      return
    }
    case "parameters":
    case "executorParameters":
    case "judgeParameters": {
      const parameter = parseProfileParameter(flag, value)
      const parameters = optionsValue[key]
      if (Object.hasOwn(parameters, parameter.name)) {
        return invalidUsage(
          "RALPH_PROFILE_PARAMETER_DUPLICATED",
          `Parameter specified more than once for --parameter: ${parameter.name}`,
        )
      }
      parameters[parameter.name] = parameter.value
      return
    }
    case "inheritProfileFields": {
      const fieldId = parseNonBlank(flag, value)
      if (!inheritableRoleProfileFormField(fieldId)) {
        return invalidUsage(
          "RALPH_PROFILE_INHERIT_FIELD_INVALID",
          `${flag} does not name an inheritable role-profile field: ${fieldId}`,
          `Use one of: ${inheritableRoleProfileFormFieldIds().join(", ")}. Scope, role and setDefault are command-owned.`,
        )
      }
      pushUniqueOption(optionsValue.inheritProfileFields, flag, fieldId)
      return
    }
    case "cliArgs":
      optionsValue.cliArgs.push(parseCliArgument(flag, value))
      return
    case "cliEnvironmentRefs": {
      const equals = value.indexOf("=")
      const name = equals > 0 ? value.slice(0, equals) : ""
      const reference = equals > 0 ? value.slice(equals + 1) : ""
      const parsedName = ExternalCliEnvironmentNameSchema.safeParse(name)
      const parsedReference = ExternalCliEnvironmentRefSchema.safeParse(reference)
      if (!parsedName.success || !parsedReference.success) {
        return invalidUsage(
          "RALPH_EXTERNAL_CLI_ENV_REF_INVALID",
          `${flag} requires TARGET=env:SOURCE using environment variable names`,
        )
      }
      if (Object.hasOwn(optionsValue.cliEnvironmentRefs, parsedName.data)) {
        return invalidUsage(
          "RALPH_EXTERNAL_CLI_ENV_REF_DUPLICATED",
          `External CLI environment target specified more than once: ${parsedName.data}`,
        )
      }
      optionsValue.cliEnvironmentRefs[parsedName.data] = parsedReference.data
      return
    }
    case "cliAdapter": {
      const parsed = ExternalCliAdapterSchema.safeParse(value)
      if (!parsed.success) {
        return invalidUsage(
          "RALPH_EXTERNAL_CLI_ADAPTER_INVALID",
          `Invalid external CLI adapter: ${value}`,
          "Use protocol, known-output or generic.",
        )
      }
      optionsValue.cliAdapter = parsed.data
      return
    }
    case "cliStreaming":
      optionsValue.cliStreaming = parseBooleanValue(flag, value)
      return
    case "cliCancellation":
      optionsValue.cliCancellation = parseBooleanValue(flag, value)
      return
    case "cliToolCalling": {
      const parsed = ExternalCliToolCallingSchema.safeParse(value)
      if (!parsed.success) {
        return invalidUsage(
          "RALPH_EXTERNAL_CLI_TOOL_CALLING_INVALID",
          `Invalid external CLI tool-calling capability: ${value}`,
          "Use ralph, internal or unavailable.",
        )
      }
      optionsValue.cliToolCalling = parsed.data
      return
    }
    case "cliUsage": {
      const parsed = ExternalCliUsageSchema.safeParse(value)
      if (!parsed.success) {
        return invalidUsage(
          "RALPH_EXTERNAL_CLI_USAGE_INVALID",
          `Invalid external CLI usage capability: ${value}`,
          "Use reported, estimated or unavailable.",
        )
      }
      optionsValue.cliUsage = parsed.data
      return
    }
    case "cliMutationMode": {
      const parsed = ExternalCliMutationModeSchema.safeParse(value)
      if (!parsed.success) {
        return invalidUsage(
          "RALPH_EXTERNAL_CLI_MUTATION_INVALID",
          `Invalid external CLI mutation mode: ${value}`,
          "Use read-only or workspace.",
        )
      }
      optionsValue.cliMutationMode = parsed.data
      return
    }
    case "securityMode": {
      const parsed = SecurityModeSchema.safeParse(value)
      if (!parsed.success) {
        return invalidUsage(
          "RALPH_SECURITY_MODE_INVALID",
          `Invalid execution security mode: ${value}`,
          "Use safe, auto or dangerous.",
        )
      }
      optionsValue.securityMode = parsed.data
      return
    }
    case "headlessAsk": {
      const parsed = HeadlessAskSchema.safeParse(value)
      if (!parsed.success) {
        return invalidUsage(
          "RALPH_HEADLESS_ASK_INVALID",
          `Invalid headless ask policy: ${value}`,
          "Use deny or allow.",
        )
      }
      optionsValue.headlessAsk = parsed.data
      return
    }
    case "allowTools":
    case "denyTools":
    case "askTools": {
      const tool = parseToolName(flag, value)
      assertNoToolRuleConflict(optionsValue, tool, flag)
      pushUniqueOption(optionsValue[key], flag, tool)
      return
    }
    case "allowCommands": {
      const parsed = AllowedCommandSchema.safeParse(value)
      if (!parsed.success) {
        return invalidUsage("RALPH_ALLOWED_COMMAND_INVALID", `Invalid allowed command: ${value}`)
      }
      pushUniqueOption(optionsValue.allowCommands, flag, parsed.data)
      return
    }
    case "readPaths":
    case "writePaths": {
      const parsed = PortableRelativeScopeSchema.safeParse(value)
      if (!parsed.success) {
        return invalidUsage(
          "RALPH_SECURITY_PATH_INVALID",
          `${flag} requires a portable workspace-relative scope: ${value}`,
        )
      }
      pushUniqueOption(optionsValue[key], flag, parsed.data)
      return
    }
    case "evidencePaths":
      pushUniqueOption(optionsValue.evidencePaths, flag, parseNonBlank(flag, value))
      return
    case "checkpointPaths":
    case "inventoryRoots": {
      const parsed = PortableRelativePathSchema.safeParse(value)
      if (!parsed.success) {
        return invalidUsage(
          "RALPH_CHECKPOINT_PATH_INVALID",
          `${flag} requires a concrete portable workspace-relative path`,
        )
      }
      pushUniqueOption(optionsValue[key], flag, parsed.data)
      return
    }
    case "confirmationPlanHash":
      if (!/^[a-f0-9]{64}$/.test(value)) {
        return invalidUsage(
          "RALPH_CONFIRMATION_PLAN_HASH_INVALID",
          `${flag} requires the exact lowercase SHA-256 plan hash returned by the matching preview`,
        )
      }
      optionsValue.confirmationPlanHash = value
      return
    case "cliCwd": {
      const parsed = PortableRelativePathSchema.safeParse(value)
      if (!parsed.success) {
        return invalidUsage(
          "RALPH_EXTERNAL_CLI_CWD_INVALID",
          `${flag} requires a concrete portable workspace-relative path`,
        )
      }
      optionsValue.cliCwd = parsed.data
      return
    }
    case "level": {
      if (!EVENT_LEVELS.has(value as EventLevel)) {
        return invalidUsage(
          "RALPH_LOG_LEVEL_INVALID",
          `Invalid event/log level: ${value}`,
          "Use trace, debug, info, warn or error.",
        )
      }
      optionsValue.level = value as EventLevel
      return
    }
    case "source": {
      if (!LOG_SOURCES.has(value as LogSource)) {
        return invalidUsage(
          "RALPH_LOG_SOURCE_INVALID",
          `Invalid log source: ${value}`,
          "Use audit, human, raw-engine, tool, gate or diagnostic.",
        )
      }
      optionsValue.source = value as LogSource
      return
    }
    case "issueState": {
      if (value !== "open" && value !== "closed" && value !== "all") {
        return invalidUsage(
          "RALPH_GITHUB_ISSUE_STATE_INVALID",
          `Invalid GitHub issue state: ${value}`,
          "Use open, closed or all.",
        )
      }
      optionsValue.issueState = value
      return
    }
    case "releaseChannel": {
      if (value !== "nightly" && value !== "beta" && value !== "stable") {
        return invalidUsage(
          "RALPH_RELEASE_CHANNEL_INVALID",
          `Invalid release channel: ${value}`,
          "Use nightly, beta or stable. The dev channel is checkout-only.",
        )
      }
      optionsValue.releaseChannel = value
      return
    }
    case "serialization": {
      if (value !== "yaml" && value !== "json") {
        return invalidUsage(
          "RALPH_CONFIG_SERIALIZATION_INVALID",
          `Invalid configuration serialization: ${value}`,
          "Use yaml or json.",
        )
      }
      optionsValue.serialization = value
      return
    }
    case "since": {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
        return invalidUsage(
          "RALPH_LOG_SINCE_INVALID",
          `${flag} requires an ISO-8601 timestamp with timezone`,
        )
      }
      const milliseconds = Date.parse(value)
      if (!Number.isFinite(milliseconds)) {
        return invalidUsage("RALPH_LOG_SINCE_INVALID", `${flag} requires an ISO-8601 timestamp`)
      }
      optionsValue.since = new Date(milliseconds).toISOString()
      return
    }
    case "workspace":
    case "mode":
    case "baseBranch":
    case "integrationBranch":
    case "sandboxImage":
    case "ui":
    case "lang":
    case "output":
    case "destination":
    case "report":
    case "prd":
    case "executorProfile":
    case "executorProvider":
    case "executorModel":
    case "executorCredential":
    case "executorVariant":
    case "judgeProfile":
    case "judgeProvider":
    case "judgeModel":
    case "judgeCredential":
    case "judgeVariant":
    case "provider":
    case "model":
    case "profile":
    case "credential":
    case "method":
    case "label":
    case "repo":
    case "environmentName":
    case "role":
    case "backend":
    case "variant":
    case "scope":
    case "cliExecutable":
    case "cliAdapterId":
    case "task":
    case "runId":
    case "attemptId":
    case "evidenceBundleId":
    case "verificationOperationId":
    case "reason":
    case "eventType":
    case "workerId":
    case "installRoot":
    case "releaseManifest":
    case "releaseVersion":
      optionsValue[key] = parseNonBlank(flag, value)
      return
    default:
      return invalidUsage("RALPH_OPTION_INTERNAL_INVALID", `Option is not value-bearing: ${flag}`)
  }
}

export function inferRequestedFormat(argv: readonly string[]): OutputFormat {
  let format: OutputFormat = "human"
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--json") format = "json"
    if (token === "--format") {
      const next = argv[index + 1]
      if (next === "human" || next === "json" || next === "jsonl") format = next
    }
    if (token?.startsWith("--format=")) {
      const value = token.slice("--format=".length)
      if (value === "human" || value === "json" || value === "jsonl") format = value
    }
  }
  return format
}

export function parseCli(argv: readonly string[]): ParsedCli {
  const parsedOptions: CliOptions = {
    format: "human",
    noColor: false,
    debug: false,
    force: false,
    nonInteractive: false,
    effective: false,
    recursive: false,
    strict: false,
    check: false,
    inPlace: false,
    dryRun: false,
    failFast: false,
    skipTests: false,
    skipLint: false,
    skipGates: [],
    noGates: false,
    fast: false,
    noCommit: false,
    wiggum: false,
    refresh: false,
    headless: false,
    secretStdin: false,
    allowInsecureStore: false,
    requireTools: false,
    requireStructuredOutput: false,
    clearCredential: false,
    clearVariant: false,
    clearParameters: false,
    clearExecutorCredential: false,
    clearExecutorVariant: false,
    clearExecutorParameters: false,
    clearJudgeCredential: false,
    clearJudgeVariant: false,
    clearJudgeParameters: false,
    setDefault: false,
    allowShell: false,
    newRun: false,
    acceptWorkspaceChanges: false,
    all: false,
    graceful: false,
    follow: false,
    pending: false,
    completed: false,
    review: false,
    importAdapters: false,
    importRecipes: false,
    fallbackProfiles: [],
    fallbackOn: [],
    inheritProfileFields: [],
    judgeBlockingSeverities: [],
    parameters: {},
    executorParameters: {},
    judgeParameters: {},
    cliArgs: [],
    cliEnvironmentRefs: {},
    allowTools: [],
    denyTools: [],
    askTools: [],
    allowCommands: [],
    readPaths: [],
    writePaths: [],
    parallelGroups: [],
    evidencePaths: [],
    checkpointPaths: [],
    inventoryRoots: [],
    allowDowngrade: false,
  }
  const positionals: string[] = []
  const present = new Set<keyof CliOptions>()
  let explicitFormat: OutputFormat | undefined
  let jsonAlias = false
  let shortcut: "help" | "version" | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (token === "--") {
      return invalidUsage(
        "RALPH_PASSTHROUGH_UNAVAILABLE",
        "Argument passthrough is not part of the deterministic command contract; configure repeatable --cli-arg values on the external profile",
      )
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token)
      continue
    }

    const equalsIndex = token.indexOf("=")
    const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token
    const inlineValue = equalsIndex >= 0 ? token.slice(equalsIndex + 1) : undefined

    if (flag === "--help" || flag === "-h" || flag === "--version" || flag === "-V") {
      const requested = resolveCommandTokens([flag])?.command
      if (requested !== "help" && requested !== "version") {
        throw new Error(`Command registry is missing the built-in shortcut: ${flag}`)
      }
      if (inlineValue !== undefined) {
        return invalidUsage(
          "RALPH_BOOLEAN_VALUE_UNEXPECTED",
          `Boolean option takes no value: ${flag}`,
        )
      }
      if (shortcut === requested) {
        return invalidUsage("RALPH_OPTION_DUPLICATED", `Option specified more than once: ${flag}`)
      }
      if (shortcut) {
        return invalidUsage(
          "RALPH_SHORTCUT_CONFLICT",
          "Help and version shortcuts cannot be requested together",
        )
      }
      shortcut = requested
      continue
    }

    if (flag === "--judge" || flag === "--no-judge" || flag === "--self-review") {
      if (present.has("evaluationMode")) {
        return invalidUsage(
          "RALPH_OPTION_DUPLICATED",
          `Evaluation mode specified more than once: ${flag}`,
        )
      }
      if (flag === "--judge") {
        let requested = inlineValue
        if (requested === undefined && argv[index + 1] === "external") {
          requested = argv[index + 1]
          index += 1
        }
        if (requested !== undefined && requested !== "external") {
          return invalidUsage(
            "RALPH_EVALUATION_MODE_INVALID",
            `--judge only accepts external, received: ${requested}`,
          )
        }
        parsedOptions.evaluationMode = "external"
      } else {
        if (inlineValue !== undefined) {
          return invalidUsage(
            "RALPH_BOOLEAN_VALUE_UNEXPECTED",
            `Boolean option takes no value: ${flag}`,
          )
        }
        parsedOptions.evaluationMode = flag === "--self-review" ? "self" : "deterministic-only"
      }
      present.add("evaluationMode")
      continue
    }

    if (flag === "--resume" || flag === "--no-resume") {
      if (present.has("resumeDiscovery")) {
        return invalidUsage(
          "RALPH_OPTION_DUPLICATED",
          `Resume discovery was specified more than once: ${flag}`,
        )
      }
      if (flag === "--no-resume") {
        if (inlineValue !== undefined) {
          return invalidUsage(
            "RALPH_BOOLEAN_VALUE_UNEXPECTED",
            "Boolean compatibility alias takes no value: --no-resume",
          )
        }
        parsedOptions.resumeDiscovery = "never"
      } else {
        let requested = inlineValue
        const following = argv[index + 1]
        if (
          requested === undefined &&
          following !== undefined &&
          RESUME_DISCOVERY_MODES.has(following as ResumeDiscovery)
        ) {
          requested = following
          index += 1
        }
        requested ??= "auto"
        const parsed = ResumeDiscoverySchema.safeParse(requested)
        if (!parsed.success) {
          return invalidUsage(
            "RALPH_RESUME_DISCOVERY_INVALID",
            `Invalid resume discovery mode: ${requested}`,
            "Use auto, never or required.",
          )
        }
        parsedOptions.resumeDiscovery = parsed.data
      }
      present.add("resumeDiscovery")
      continue
    }

    const valueKey = VALUE_FLAGS.get(flag)
    if (valueKey) {
      const repeatable =
        valueKey === "skipGates" ||
        valueKey === "judgeBlockingSeverities" ||
        valueKey === "fallbackProfiles" ||
        valueKey === "fallbackOn" ||
        valueKey === "parameters" ||
        valueKey === "inheritProfileFields" ||
        valueKey === "executorParameters" ||
        valueKey === "judgeParameters" ||
        valueKey === "cliArgs" ||
        valueKey === "cliEnvironmentRefs" ||
        valueKey === "allowTools" ||
        valueKey === "denyTools" ||
        valueKey === "askTools" ||
        valueKey === "allowCommands" ||
        valueKey === "readPaths" ||
        valueKey === "writePaths" ||
        valueKey === "parallelGroups" ||
        valueKey === "evidencePaths" ||
        valueKey === "checkpointPaths" ||
        valueKey === "inventoryRoots"
      if (
        !repeatable &&
        (valueKey === "format" ? explicitFormat !== undefined : present.has(valueKey))
      ) {
        return invalidUsage("RALPH_OPTION_DUPLICATED", `Option specified more than once: ${flag}`)
      }
      const value = inlineValue ?? argv[index + 1]
      if (
        value === undefined ||
        value.length === 0 ||
        (inlineValue === undefined && value.startsWith("-"))
      ) {
        return invalidUsage("RALPH_OPTION_VALUE_MISSING", `Option requires a value: ${flag}`)
      }
      if (inlineValue === undefined) index += 1
      assignValueOption(parsedOptions, valueKey, flag, value)
      if (valueKey === "format") explicitFormat = parsedOptions.format
      present.add(valueKey)
      continue
    }

    const booleanKey = BOOLEAN_FLAGS.get(flag)
    if (booleanKey) {
      if (inlineValue !== undefined) {
        return invalidUsage(
          "RALPH_BOOLEAN_VALUE_UNEXPECTED",
          `Boolean option takes no value: ${flag}`,
        )
      }
      if (flag === "--json") {
        if (jsonAlias) {
          return invalidUsage("RALPH_OPTION_DUPLICATED", "Option specified more than once: --json")
        }
        jsonAlias = true
        parsedOptions.format = "json"
        present.add("format")
      } else {
        if (present.has(booleanKey)) {
          return invalidUsage("RALPH_OPTION_DUPLICATED", `Option specified more than once: ${flag}`)
        }
        parsedOptions[booleanKey] = true as never
        present.add(booleanKey)
      }
      continue
    }

    return invalidUsage(
      "RALPH_OPTION_UNKNOWN",
      `Unknown option: ${flag}`,
      "Run `ralph-next help` for supported options.",
    )
  }

  if (jsonAlias && explicitFormat) {
    if (explicitFormat !== "json") {
      return invalidUsage(
        "RALPH_FORMAT_CONFLICT",
        "--json conflicts with a non-JSON --format value",
      )
    }
    return invalidUsage(
      "RALPH_OPTION_DUPLICATED",
      "--json and --format=json specify the same option more than once",
    )
  }

  // Global help/version shortcuts must never accidentally execute a command.
  // Recognized command-specific options are harmless here and are ignored.
  if (shortcut) return { command: shortcut, arguments: [], options: parsedOptions }

  const resolution =
    positionals.length === 0 ? resolveCommandTokens(["help"]) : resolveCommandTokens(positionals)
  if (!resolution) {
    return invalidUsage(
      "RALPH_COMMAND_UNKNOWN",
      "Unknown command",
      "Run `ralph-next help` for available commands.",
    )
  }
  positionals.splice(0, resolution.consumed)
  const command: CliCommand = resolution.command
  const allowed = ALLOWED_OPTIONS[command]
  for (const key of present) {
    if (!allowed.has(key)) {
      return invalidUsage(
        "RALPH_OPTION_NOT_ALLOWED",
        `Option is not valid for ${command}: ${String(key)}`,
      )
    }
  }

  const conflictingClear = (
    clearKey: keyof CliOptions,
    valueKey: keyof CliOptions,
    clearFlag: string,
    valueFlag: string,
  ): void => {
    if (present.has(clearKey) && present.has(valueKey)) {
      invalidUsage(
        "RALPH_OPTION_CLEAR_CONFLICT",
        `${clearFlag} cannot be combined with ${valueFlag}`,
      )
    }
  }
  conflictingClear("clearCredential", "credential", "--clear-credential", "--credential")
  conflictingClear("clearVariant", "variant", "--clear-variant", "--variant")
  conflictingClear("clearParameters", "parameters", "--clear-parameters", "--parameter")
  for (const fieldId of parsedOptions.inheritProfileFields) {
    for (const conflict of PROFILE_INHERIT_CONFLICTS[fieldId] ?? []) {
      if (present.has(conflict.key)) {
        return invalidUsage(
          "RALPH_PROFILE_INHERIT_CONFLICT",
          `--inherit-profile-field ${fieldId} cannot be combined with ${conflict.flag}`,
        )
      }
    }
  }
  if (parsedOptions.backend === "embedded") {
    const conflictingExternalOption = EXTERNAL_CLI_PROFILE_OPTIONS.find((option) =>
      present.has(option.key),
    )
    if (conflictingExternalOption) {
      return invalidUsage(
        "RALPH_PROFILE_BACKEND_CLI_CONFLICT",
        `--backend embedded cannot be combined with ${conflictingExternalOption.flag}`,
        "Remove the --cli-* options, or select --backend external-cli.",
      )
    }
  }
  conflictingClear(
    "clearExecutorCredential",
    "executorCredential",
    "--clear-executor-credential",
    "--executor-credential",
  )
  conflictingClear(
    "clearExecutorVariant",
    "executorVariant",
    "--clear-executor-variant",
    "--executor-variant",
  )
  conflictingClear(
    "clearExecutorParameters",
    "executorParameters",
    "--clear-executor-parameters",
    "--executor-parameter",
  )
  conflictingClear(
    "clearJudgeCredential",
    "judgeCredential",
    "--clear-judge-credential",
    "--judge-credential",
  )
  conflictingClear("clearJudgeVariant", "judgeVariant", "--clear-judge-variant", "--judge-variant")
  conflictingClear(
    "clearJudgeParameters",
    "judgeParameters",
    "--clear-judge-parameters",
    "--judge-parameter",
  )

  if (
    (command === "alias.ralph.status" ||
      command === "alias.ralph.install" ||
      command === "alias.ralph.remove") &&
    positionals.length !== 0
  ) {
    return invalidUsage(
      "RALPH_ALIAS_ARGUMENT_UNEXPECTED",
      `${command.replaceAll(".", " ")} does not accept positional arguments; use --install-root`,
    )
  }
  if (command === "alias.ralph.install" || command === "alias.ralph.remove") {
    if (parsedOptions.dryRun && parsedOptions.confirmationPlanHash) {
      return invalidUsage(
        "RALPH_ALIAS_CONFIRMATION_MODE_CONFLICT",
        `${command.replaceAll(".", " ")} requires exactly one mode: --dry-run without --confirm-plan-hash, or apply with --confirm-plan-hash`,
      )
    }
    if (!parsedOptions.dryRun && !parsedOptions.confirmationPlanHash) {
      return invalidUsage(
        "RALPH_ALIAS_CONFIRMATION_MISSING",
        `${command.replaceAll(".", " ")} apply requires --confirm-plan-hash <exact-preview-hash>; use --dry-run to preview without applying`,
      )
    }
  }

  const maximumArguments =
    command === "config.explain" ||
    command === "config.get" ||
    command === "config.unset" ||
    command === "config.import" ||
    command === "config.edit"
      ? 1
      : command === "config.preview" || command === "config.set"
        ? 2
        : command.startsWith("prd.") ||
            command === "resume" ||
            command === "stop" ||
            command === "attach" ||
            command === "replay" ||
            command === "report.show" ||
            command === "evidence.inspect" ||
            command === "verify" ||
            command === "judge" ||
            command === "once" ||
            command === "providers.inspect" ||
            command === "models.inspect" ||
            command === "auth.connect" ||
            command === "auth.status" ||
            command === "auth.revoke" ||
            command === "adapters.new" ||
            command === "adapters.inspect" ||
            command === "recipes.new" ||
            command === "recipes.show" ||
            command === "rules.add" ||
            command === "checkpoint.show" ||
            command === "rollback.preview" ||
            command === "rollback.apply" ||
            command === "lang.set" ||
            command === "install" ||
            command === "uninstall" ||
            command === "profiles.inspect" ||
            command === "profiles.configure" ||
            command === "tasks.done" ||
            command === "migrate.inspect" ||
            command === "migrate.apply" ||
            command === "migrate.rollback"
          ? 1
          : 0
  if (positionals.length > maximumArguments) {
    return invalidUsage(
      "RALPH_ARGUMENT_UNEXPECTED",
      `Unexpected positional argument for ${command}; expected at most ${maximumArguments}`,
    )
  }
  if ((command === "config.explain" || command === "config.get") && positionals.length !== 1) {
    return invalidUsage(
      "RALPH_CONFIG_KEY_MISSING",
      `${command === "config.get" ? "config get" : "config explain"} requires a dotted configuration key`,
    )
  }
  if ((command === "config.preview" || command === "config.set") && positionals.length !== 2) {
    return invalidUsage(
      "RALPH_CONFIG_VALUE_MISSING",
      `${command === "config.set" ? "config set" : "config preview"} requires a setting key and value`,
    )
  }
  if (command === "config.unset" && positionals.length !== 1) {
    return invalidUsage(
      "RALPH_CONFIG_KEY_MISSING",
      "config unset requires exactly one schema-known settings key",
    )
  }
  if (command === "config.import" && positionals.length !== 1) {
    return invalidUsage(
      "RALPH_CONFIG_IMPORT_INPUT_MISSING",
      "config import requires exactly one explicit YAML/JSON input file",
    )
  }
  if (command === "config.unset" || command === "config.edit" || command === "config.import") {
    if (parsedOptions.scope !== "workspace" && parsedOptions.scope !== "global") {
      return invalidUsage(
        "RALPH_CONFIG_SCOPE_REQUIRED",
        `${command.replace(".", " ")} requires --scope workspace|global`,
      )
    }
  }
  if (
    command === "config.export" &&
    parsedOptions.scope !== "workspace" &&
    parsedOptions.scope !== "global" &&
    parsedOptions.scope !== "effective"
  ) {
    return invalidUsage(
      "RALPH_CONFIG_EXPORT_SCOPE_REQUIRED",
      "config export requires --scope workspace|global|effective",
    )
  }
  if (command === "context.export" && !parsedOptions.output) {
    return invalidUsage(
      "RALPH_CONTEXT_EXPORT_OUTPUT_MISSING",
      "context export requires --output <workspace-relative-file>",
    )
  }
  if (command === "checkpoint.show" && positionals.length !== 1) {
    return invalidUsage(
      "RALPH_CHECKPOINT_ID_MISSING",
      "checkpoint show requires exactly one checkpoint ID",
    )
  }
  if (
    (command === "rollback.preview" || command === "rollback.apply") &&
    positionals.length !== 1
  ) {
    return invalidUsage(
      "RALPH_ROLLBACK_ID_MISSING",
      `${command === "rollback.preview" ? "rollback preview" : "rollback apply"} requires exactly one persisted ID`,
    )
  }
  if (command === "rollback.apply" && !parsedOptions.confirmationPlanHash) {
    return invalidUsage(
      "RALPH_ROLLBACK_CONFIRMATION_MISSING",
      "rollback apply requires --confirm-plan-hash <exact-preview-hash>",
    )
  }
  if (command === "lang.set") {
    if (positionals.length !== 1) {
      return invalidUsage("RALPH_LANG_VALUE_MISSING", "lang set requires exactly one locale")
    }
    if (!parsedOptions.scope) {
      return invalidUsage("RALPH_LANG_SCOPE_MISSING", "lang set requires --scope workspace|global")
    }
  }
  if (command.startsWith("prd.") && positionals.length === 0) positionals.push("PRD.md")
  if (command === "tasks.done" && positionals.length !== 1) {
    return invalidUsage(
      "RALPH_TASK_REFERENCE_MISSING",
      "tasks done requires a task ID, one-based index or `next`",
    )
  }
  if (command === "tasks.sync" && !parsedOptions.repo) {
    return invalidUsage(
      "RALPH_GITHUB_REPOSITORY_MISSING",
      "tasks sync requires --repo owner/repository",
    )
  }
  if (
    (command === "adapters.new" ||
      command === "adapters.inspect" ||
      command === "recipes.new" ||
      command === "recipes.show" ||
      command === "rules.add") &&
    positionals.length !== 1
  ) {
    return invalidUsage(
      "RALPH_CATALOG_ARGUMENT_MISSING",
      `${command.replace(".", " ")} requires exactly one ID or rule text argument`,
    )
  }
  if ((command === "migrate.inspect" || command === "migrate.apply") && positionals.length !== 1) {
    return invalidUsage(
      "RALPH_MIGRATION_SOURCE_MISSING",
      `${command === "migrate.apply" ? "migrate apply" : "migrate inspect"} requires a legacy workspace path`,
    )
  }
  if (command === "migrate.apply" && !parsedOptions.destination) {
    return invalidUsage(
      "RALPH_MIGRATION_DESTINATION_MISSING",
      "migrate apply requires --destination <separate-v2-workspace>",
    )
  }
  if (command === "migrate.rollback") {
    if (positionals.length !== 1) {
      return invalidUsage(
        "RALPH_MIGRATION_ROLLBACK_MANIFEST_MISSING",
        "migrate rollback requires exactly one rollback-manifest.json path",
      )
    }
    if (parsedOptions.dryRun && parsedOptions.confirmationPlanHash) {
      return invalidUsage(
        "RALPH_MIGRATION_ROLLBACK_CONFIRMATION_MODE_CONFLICT",
        "migrate rollback requires exactly one mode: --dry-run preview or --confirm-plan-hash apply",
      )
    }
    if (!parsedOptions.dryRun && !parsedOptions.confirmationPlanHash) {
      return invalidUsage(
        "RALPH_MIGRATION_ROLLBACK_CONFIRMATION_MISSING",
        "migrate rollback apply requires --confirm-plan-hash <exact-preview-hash>; use --dry-run first",
      )
    }
  }
  const taskFilters = [parsedOptions.pending, parsedOptions.completed, parsedOptions.review].filter(
    Boolean,
  )
  if (command === "tasks.list" && (parsedOptions.all ? 1 : 0) + taskFilters.length > 1) {
    return invalidUsage(
      "RALPH_TASK_FILTER_CONFLICT",
      "tasks list accepts only one of --all, --pending, --completed or --review",
    )
  }
  if ((command === "attach" || command === "replay") && positionals.length === 1) {
    if (parsedOptions.runId) {
      return invalidUsage(
        "RALPH_RUN_ID_CONFLICT",
        `Specify the ${command === "replay" ? "replayed" : "attached"} run ID either positionally or with --run-id, not both`,
      )
    }
    parsedOptions.runId = positionals.shift() as string
  }
  if ((command === "resume" || command === "stop") && positionals.length === 1) {
    if (parsedOptions.runId) {
      return invalidUsage(
        "RALPH_RUN_ID_CONFLICT",
        `Specify the ${command} run ID either positionally or with --run-id, not both`,
      )
    }
    parsedOptions.runId = positionals.shift() as string
  }
  if (command === "once" && positionals.length === 1) {
    const description = (positionals.shift() as string).trim()
    if (!description) {
      return invalidUsage(
        "RALPH_AD_HOC_DESCRIPTION_EMPTY",
        "The positional once description cannot be empty",
      )
    }
    if (description.length > 65_536) {
      return invalidUsage(
        "RALPH_AD_HOC_DESCRIPTION_TOO_LARGE",
        "The positional once description exceeds the 65,536-character limit",
        "Use a concise ad-hoc request or generate an explicit PRD for larger work.",
      )
    }
    if (parsedOptions.task) {
      return invalidUsage(
        "RALPH_ONCE_SOURCE_CONFLICT",
        "Choose either a positional ad-hoc description or --task for a PRD task, not both",
      )
    }
    if (parsedOptions.prd) {
      return invalidUsage(
        "RALPH_ONCE_SOURCE_CONFLICT",
        "A positional ad-hoc description cannot be combined with --prd",
      )
    }
    parsedOptions.adHocDescription = description
  }
  if (command === "report.show") {
    if (positionals.length === 0 && !parsedOptions.runId) {
      return invalidUsage(
        "RALPH_REPORT_RUN_ID_MISSING",
        "report show requires a run ID argument or --run-id",
      )
    }
    if (positionals.length === 1 && parsedOptions.runId) {
      return invalidUsage(
        "RALPH_RUN_ID_CONFLICT",
        "Specify the report run ID either positionally or with --run-id, not both",
      )
    }
  }
  if (command === "review.retry") {
    if (!parsedOptions.runId) {
      return invalidUsage("RALPH_REVIEW_RUN_ID_MISSING", "review retry requires --run-id")
    }
    if (!parsedOptions.task) {
      return invalidUsage(
        "RALPH_REVIEW_TASK_MISSING",
        "review retry requires --task <document-id/task-id>",
      )
    }
    if (parsedOptions.additionalRevisions === undefined) {
      return invalidUsage(
        "RALPH_REVIEW_REVISIONS_MISSING",
        "review retry requires --additional-revisions <positive-integer>",
      )
    }
    if (!parsedOptions.reason) {
      return invalidUsage(
        "RALPH_REVIEW_REASON_MISSING",
        "review retry requires --reason <audit-reason>",
      )
    }
  }
  if (command === "evidence.inspect" && positionals.length !== 1) {
    return invalidUsage(
      "RALPH_EVIDENCE_ATTEMPT_ID_MISSING",
      "evidence inspect requires an attempt ID",
    )
  }
  if ((command === "verify" || command === "judge") && positionals.length > 1) {
    return invalidUsage(
      "RALPH_COMMAND_SELECTOR_COUNT_INVALID",
      `${command} accepts at most one positional task/attempt selector`,
    )
  }
  if (command === "providers.inspect" && positionals.length !== 1) {
    return invalidUsage("RALPH_PROVIDER_ID_MISSING", "providers inspect requires a provider ID")
  }
  if (command === "models.inspect" && positionals.length !== 1) {
    return invalidUsage("RALPH_MODEL_ID_MISSING", "models inspect requires a model ID")
  }
  if (command === "auth.connect") {
    const positionalProvider = positionals[0]
    if (!positionalProvider && !parsedOptions.provider) {
      return invalidUsage("RALPH_AUTH_PROVIDER_MISSING", "auth connect requires a provider")
    }
    if (
      positionalProvider &&
      parsedOptions.provider &&
      positionalProvider !== parsedOptions.provider
    ) {
      return invalidUsage(
        "RALPH_AUTH_PROVIDER_CONFLICT",
        "The positional provider conflicts with --provider",
      )
    }
    if (positionalProvider) parsedOptions.provider ??= positionalProvider
    positionals.length = 0
    if (!parsedOptions.method) {
      return invalidUsage("RALPH_AUTH_METHOD_MISSING", "auth connect requires --method")
    }
  }
  if (command === "auth.revoke" && positionals.length !== 1) {
    return invalidUsage("RALPH_CREDENTIAL_ID_MISSING", "auth revoke requires a credential ID")
  }
  if (command === "profiles.inspect" && positionals.length !== 1) {
    return invalidUsage("RALPH_PROFILE_ID_MISSING", "profiles inspect requires a profile ID")
  }
  if (command === "profiles.configure") {
    const positionalProfile = positionals[0]
    if (!positionalProfile && !parsedOptions.profile) {
      return invalidUsage("RALPH_PROFILE_ID_MISSING", "profiles configure requires a profile ID")
    }
    if (positionalProfile && parsedOptions.profile && positionalProfile !== parsedOptions.profile) {
      return invalidUsage(
        "RALPH_PROFILE_ID_CONFLICT",
        "The positional profile conflicts with --profile",
      )
    }
    if (positionalProfile) parsedOptions.profile ??= positionalProfile
    positionals.length = 0
  }
  if (
    command === "run" &&
    parsedOptions.mode !== undefined &&
    !EXECUTABLE_RUN_MODES.has(parsedOptions.mode)
  ) {
    return invalidUsage(
      "RALPH_RUN_MODE_INVALID",
      `Invalid execution mode for run: ${parsedOptions.mode}`,
      "Use one of: once, loop, wiggum, parallel.",
    )
  }
  if (command === "resume" && present.has("resumeDiscovery")) {
    return invalidUsage(
      "RALPH_RESUME_COMMAND_POLICY_CONFLICT",
      "The resume command already requires an existing run; do not combine it with --resume or --no-resume",
    )
  }
  if (command === "resume") parsedOptions.resumeDiscovery = "required"
  if (parsedOptions.newRun && present.has("resumeDiscovery")) {
    return invalidUsage(
      "RALPH_NEW_RUN_RESUME_CONFLICT",
      "--new-run cannot be combined with --resume or --no-resume",
    )
  }
  if (parsedOptions.newRun && parsedOptions.runId) {
    return invalidUsage("RALPH_NEW_RUN_ID_CONFLICT", "--new-run cannot target an existing --run-id")
  }
  if (parsedOptions.resumeDiscovery === "never" && parsedOptions.runId) {
    return invalidUsage(
      "RALPH_RUN_ID_RESUME_CONFLICT",
      "--run-id selects existing work and cannot be combined with --resume never or --no-resume",
    )
  }
  if (command === "stop" && parsedOptions.force && parsedOptions.graceful) {
    return invalidUsage(
      "RALPH_STOP_MODE_CONFLICT",
      "--force and --graceful select different stop modes",
    )
  }
  if (command === "stop" && parsedOptions.force && parsedOptions.grace !== undefined) {
    return invalidUsage(
      "RALPH_STOP_GRACE_CONFLICT",
      "--grace applies only to a graceful stop and cannot be combined with --force",
    )
  }
  if (command === "run" && parsedOptions.wiggum && parsedOptions.mode !== undefined) {
    return invalidUsage(
      "RALPH_RUN_MODE_CONFLICT",
      "--wiggum and --mode cannot be combined; select the run mode only once",
    )
  }
  if (
    command === "run" &&
    parsedOptions.maxIterations !== undefined &&
    parsedOptions.mode !== undefined &&
    parsedOptions.mode !== "wiggum"
  ) {
    return invalidUsage(
      "RALPH_OPTION_REQUIRES_WIGGUM",
      "--max-iterations is only valid when the effective run mode is wiggum",
    )
  }
  if (command === "prd.format") {
    if (parsedOptions.check && (parsedOptions.output || parsedOptions.inPlace)) {
      return invalidUsage(
        "RALPH_PRD_FORMAT_TARGET_CONFLICT",
        "--check cannot be combined with --output or --in-place",
      )
    }
    if (parsedOptions.output && parsedOptions.inPlace) {
      return invalidUsage(
        "RALPH_PRD_FORMAT_TARGET_CONFLICT",
        "--output and --in-place are mutually exclusive",
      )
    }
  }
  if (command === "prd.migrate" && parsedOptions.output && parsedOptions.inPlace) {
    return invalidUsage(
      "RALPH_PRD_MIGRATE_TARGET_CONFLICT",
      "--output and --in-place are mutually exclusive",
    )
  }

  return { command, arguments: positionals, options: parsedOptions }
}
