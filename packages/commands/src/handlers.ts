import { constants } from "node:fs"
import { access, lstat, readFile, realpath, stat } from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path"
import {
  type AuthMethod,
  AuthMethodSchema,
  type CredentialRef,
  CredentialRefSchema,
  type CredentialStatus,
  CredentialStatusSchema,
  type SecretInput,
} from "@ralph/credentials"
import {
  type DeferredUninstallScheduler,
  type InstallOrigin,
  installOriginFromManifest,
  installStandalone,
  type ReleaseSignatureTrustPolicy,
  type ReleaseSignatureVerifier,
  rejectUnmanagedInstallOrigin,
  rollbackStandalone,
  uninstallStandalone,
  updateStandalone,
} from "@ralph/distribution"
import {
  type ChildUsageSummary,
  type CommandResult,
  composeRoleProfileConfigLayer,
  DEFAULT_CONFIG,
  type Diagnostic,
  EffectiveRunOptionsSchema,
  type EvidenceUsage,
  EXIT_CODES,
  type ExitCode,
  inheritRoleProfileConfigLayerPath,
  type JudgeAssessment,
  type JudgmentCommandReport,
  RalphError,
  type RoleProfileConfig,
  type RoleProfileConfigLayer,
  RoleProfileConfigLayerSchema,
  RoleProfileConfigSchema,
  type RunMode,
  type RunStatus,
  type RunStopMode,
  type SandboxCapability,
  SandboxCapabilitySchema,
  type SandboxConfig,
  type TelemetryConfig,
  type VerificationCommandReport,
} from "@ralph/domain"
import {
  type ExecutionBackendResolver,
  type ExecutionRuntimeDependencies,
  type ExecutionToolPort,
  effectiveJudgeRevisionMaximum,
  effectiveOptionsHash,
  executeJudgeCommand,
  executeRun,
  executeVerifyCommand,
  findPendingRecoveryDecision,
  grantJudgeRevisionAttempts,
  initialTaskRecords,
  type RunExecutionResult,
  type RunOptionOverrides,
  resolveEffectiveRunOptions,
  sandboxCapabilityProblem,
  selectTask,
  taskRefKey,
} from "@ralph/orchestration"
import {
  canonicalDirectory,
  composeEffectiveConfigLayers,
  effectiveValue,
  findWorkspaceRoot,
  getEvidenceBundle,
  getRun,
  getRunReport,
  globalConfigPath,
  initializeWorkspace,
  inspectWorkspace,
  listAttempts,
  listChildRunTree,
  listRuns,
  listRunTasks,
  loadEffectiveConfig,
  mutateConfigTransfer,
  readChildRunTreeAggregate,
  readConfigTransferLayer,
  readEventBatch,
  readEvents,
  resolveChildRunTreeRoot,
  snapshotLedgerWorkspaceEventRetention,
  workspaceLayout,
  writeFileAtomic,
  writeJsonAtomic,
  writeRoleProfileConfig,
} from "@ralph/persistence"
import {
  type CompiledPrdGraph,
  compilePrdGraph,
  detectPrdFile,
  formatPrdSource,
  migrateClassicFile,
  type PrdDocument,
  type PrdTask,
  parseClassicPrdFile,
} from "@ralph/prd"
import {
  type CatalogResolution,
  createModelCatalogRuntime,
  type ModelCatalog,
  type ModelParameters,
  ModelParametersSchema,
  type ModelRequirements,
  ProviderCoreError,
  type ProviderEvent,
  ProviderEventSchema,
  type ProviderInfo,
  type TokenUsage,
  TokenUsageSchema,
} from "@ralph/providers"
import {
  type CommandExecution,
  type CommandStreamItem,
  commandResult,
  type EventEnvelope,
  formatLogRecordHuman,
  type LogFilter,
  logRecordsForEvent,
  matchesLogFilter,
  projectLogRecords,
} from "@ralph/telemetry"

import {
  handleModelInspect,
  handleModelsList,
  handleProviderInspect,
  handleProvidersList,
} from "./catalog-handlers"
import {
  addWorkspaceRule,
  clearWorkspaceRules,
  createCatalogEntry,
  inspectCatalogEntry,
  listCatalogEntries,
  listWorkspaceRules,
} from "./catalog-operations"
import {
  applyRollbackCommand,
  createCheckpointCommand,
  previewRollbackCommand,
} from "./checkpoint-commands"
import {
  type ConfigEditorCommandService,
  editableConfigDocument,
  exportConfigTransfer,
  parseEditedConfigDocument,
  readConfigTransferInput,
} from "./config-transfer"
import {
  createGitHubIssueCommandService,
  type GitHubIssueCommandService,
  syncGitHubIssueTasks,
} from "./github-tasks-sync"
import { helpData, helpText } from "./help"
import {
  applyLegacyMigration,
  applyLegacyMigrationRollback,
  inspectLegacyWorkspace,
  previewLegacyMigrationRollback,
} from "./legacy-migration"
import {
  exportPersistedContext,
  inspectPersistedContext,
  listOperationalCheckpoints,
  showOperationalCheckpoint,
} from "./operational-inspection"
import type { ParsedCli } from "./parser"
import { resolveRuntimeProfiles } from "./profile-runtime"
import { inheritableRoleProfileFormField, roleProfileFormMetadata } from "./settings"
import {
  createSettingsDraft,
  decodeSettingsValue,
  explainSettingsField,
  listSettingsFields,
  previewSettingsDraft,
  SETTINGS_COMMAND_FIELDS,
  type SettingsPreRunInvocation,
  saveSettingsDefaults,
  settingsField,
  updateSettingsDraft,
} from "./settings-command"
import {
  compileOperationalPrd,
  completeOperationalTask,
  listOperationalTasks,
  nextOperationalTask,
  type TaskListFilter,
} from "./task-operations"
import { cleanV2Workspace } from "./workspace-operations"

function containsC0OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

/**
 * Opaque at the command boundary and capability-checked by the concrete
 * credential service. Its resolution is the single catalog view shared by the
 * command and every provider-backed credential operation in that command.
 */
export type CredentialCatalogHandle = {
  readonly resolution: CatalogResolution
}

export type CredentialConnectCommandRequest = {
  provider: string
  /** Exact provider record from the command's single pinned catalog snapshot. */
  providerInfo: ProviderInfo
  /** Concrete services reject missing or foreign handles before touching a provider flow. */
  catalogHandle?: CredentialCatalogHandle
  method: AuthMethod
  credentialId?: string
  label?: string
  nonInteractive: boolean
  headless: boolean
  timeoutMs?: number
  environmentName?: string
  secretSource: "stdin" | "masked-prompt" | "not-applicable"
  allowInsecureStore: boolean
}

/**
 * Safe command-facing credential port. Secret acquisition happens behind this
 * boundary; neither argv nor the command result can carry secret material.
 * Implementations should throw a sanitized RalphError for actionable OAuth or
 * keychain guidance; unknown errors are deliberately collapsed by the handler.
 */
export interface CredentialCommandService {
  /** Mints a service-owned handle for one exact catalog snapshot. */
  catalogSnapshot?(options?: { refresh: boolean }): Promise<CredentialCatalogHandle>
  connect(request: CredentialConnectCommandRequest): Promise<CredentialRef>
  /**
   * Optional renderer-safe API-key boundary. The one-shot value is never
   * placed in argv, command state, events or diagnostics.
   */
  connectWithSecretInput?(
    request: CredentialConnectCommandRequest,
    secret: SecretInput,
  ): Promise<CredentialRef>
  list(): Promise<readonly CredentialRef[]>
  status(
    ref: CredentialRef,
    options: {
      refresh: boolean
      provider: ProviderInfo
      catalogHandle?: CredentialCatalogHandle
    },
  ): Promise<CredentialStatus>
  /** Local cleanup must remain available when a provider or auth method disappears. */
  revoke(ref: CredentialRef): Promise<void>
}

export type ProfileFormRequest = {
  profileId: string
  existing?: RoleProfileConfig
  suggested: Partial<RoleProfileConfig>
  initialScope?: "global" | "workspace"
  /** An explicit command-line --scope is authoritative and cannot be changed by a form. */
  scopeLocked?: boolean
  scopedCandidates?: Readonly<
    Record<
      "global" | "workspace",
      { readonly existing?: RoleProfileConfig; readonly suggested: Partial<RoleProfileConfig> }
    >
  >
  /** Exact target layer plus its lower effective profile for tri-state forms. */
  scopedLayers?: Readonly<
    Record<
      "global" | "workspace",
      {
        readonly profileLayer?: RoleProfileConfigLayer
        readonly lowerProfile?: RoleProfileConfig
      }
    >
  >
  clearedFields?: readonly ("credential" | "variant" | "parameters")[]
  metadata: ReturnType<typeof roleProfileFormMetadata>
}

export type ProfileFormResponse = {
  scope: "global" | "workspace"
  profile: RoleProfileConfig
  /** Exact partial target layer; absent preserves the legacy complete replacement contract. */
  profileLayer?: RoleProfileConfigLayer
  /** Optional atomic update of defaults.<role>_profile chosen by an interactive form. */
  setDefault?: boolean
  /** Config snapshot observed when a long-lived form loaded its target layer. */
  expectedTargetSha256?: string | null
  /** Opposite config layer observed by the same form; protects composed profiles from stale peers. */
  expectedPeerSha256?: string | null
}

export type ModelSmokeCommandRequest = {
  profileId?: string
  provider: string
  model: string
  credentialId?: string
  variant?: string
  /** Explicit overrides; the service expands the variant against its single pinned snapshot. */
  parameters: ModelParameters
  requirements: ModelRequirements
  prompt: string
  tools: readonly []
  readOnly: true
  refreshCatalog: boolean
  timeoutMs?: number
  /** Exact command-resolved policy; model services never reread mutable config. */
  telemetry: TelemetryConfig
  /** Workspace/cwd scope used only to partition optional diagnostics. */
  diagnosticScope: string
}

export type ModelSmokeServiceResult = {
  provider: string
  model: string
  effectiveParameters: ModelParameters
  text?: string
  finishReason?: string
  usage?: TokenUsage
  events?: readonly ProviderEvent[]
  rawRef?: string
  catalogSnapshotId?: string
  catalogOrigin?: "cache" | "source" | "stale-cache" | "fallback"
  catalogStale?: boolean
}

export interface ModelSmokeCommandService {
  smoke(request: ModelSmokeCommandRequest): Promise<ModelSmokeServiceResult>
}

export interface RunUiCommandRequest {
  readonly workspaceRoot: string
  readonly runId: string
  readonly mode?: "attach" | "replay"
  /** Start/run clients may close automatically after observing a terminal run. */
  readonly closeWhenTerminal?: boolean
  readonly signal?: AbortSignal
}

export interface PrepareRunUiCommandRequest {
  readonly workspaceRoot: string
  readonly initialInvocation: SettingsPreRunInvocation
  readonly signal?: AbortSignal
}

export type PrepareRunUiCommandResult =
  | {
      readonly disposition: "applied"
      readonly invocation: SettingsPreRunInvocation
    }
  | {
      readonly disposition: "cancelled"
    }

export interface RunUiCommandResult {
  readonly runId: string
  readonly observedStatus: string
  readonly closeReason: "user" | "signal" | "renderer"
}

/**
 * Command-owned UI port. `prepare` may only return options for an unpersisted
 * invocation; attach/replay may project state and request explicit command
 * actions, but never mutate persisted run authority locally.
 */
export interface RunUiCommandService {
  prepare?(request: PrepareRunUiCommandRequest): Promise<PrepareRunUiCommandResult>
  attach(request: RunUiCommandRequest): Promise<RunUiCommandResult>
}

export type RunStopCommandRequest = {
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly runId: string
  readonly mode: RunStopMode
  readonly graceMs?: number
}

export type RunStopCommandResult = {
  readonly schemaVersion: 1
  readonly runId: string
  readonly mode: RunStopMode
  readonly previousStatus: RunStatus
  readonly status: RunStatus
  readonly disposition: "requested" | "already-requested" | "already-terminal"
  readonly requestedAt: string
  readonly graceMs?: number
  /** Honest transport boundary until supervisor IPC/process identity is composed. */
  readonly delivery: "durable-boundary" | "supervisor"
}

/** Commands request lifecycle changes; they never signal arbitrary PIDs themselves. */
export interface RunControlCommandService {
  stop(request: RunStopCommandRequest): Promise<RunStopCommandResult>
}

export type ContextRotationCommandRequest = {
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly runId: string
  readonly reason: string
  readonly signal?: AbortSignal
}

export type ContextRotationCommandResult = {
  readonly schemaVersion: 1
  readonly runId: string
  readonly disposition: "requested" | "already-requested" | "not-applicable"
  readonly requestedAt: string
  readonly nextBoundary: "next-model-call" | "next-task"
}

/** Rotation is a supervisor action; commands never edit context files or ask a model to rotate itself. */
export interface ContextControlCommandService {
  rotate(request: ContextRotationCommandRequest): Promise<ContextRotationCommandResult>
}

export type SandboxCapabilityDiscoveryRequest = {
  readonly backend: SandboxCapability["backend"]
  readonly signal?: AbortSignal
}

/** Local-only capability discovery; it never starts a task or grants sandbox authority. */
export interface SandboxCapabilityCommandService {
  discover(request: SandboxCapabilityDiscoveryRequest): Promise<SandboxCapability>
}

/**
 * Executable-owned distribution boundary. Production composition uses the
 * bundled installer functions by default; focused command tests may inject a
 * data-only port without loading, verifying or mutating release artifacts.
 */
export interface DistributionCommandService {
  readonly install: typeof installStandalone
  readonly update: typeof updateStandalone
  readonly rollback: typeof rollbackStandalone
  readonly uninstall: typeof uninstallStandalone
}

export type CommandContext = {
  version: string
  cwd: string
  environment: Record<string, string | undefined>
  /** True only when the command has an attached input/error TTY that may safely prompt. */
  interactive?: boolean
  /** Command-owned lifecycle signal (for example Ctrl+C/SIGTERM). */
  signal?: AbortSignal
  /**
   * Composition-root hook for real backends and scripted test doubles. The
   * product entrypoint supplies its isolated worker resolver explicitly; there
   * is no environment switch or hidden fake registration.
   */
  resolveBackend?: ExecutionBackendResolver
  /** Read-only judge composition; external and self profiles resolve independently. */
  resolveJudge?: NonNullable<ExecutionRuntimeDependencies["resolveJudge"]>
  /** Tool settlement remains command-composed and outside provider authority. */
  toolPort?: ExecutionToolPort
  /** Per-attempt typed-worker registry supplied by the executable composition root. */
  gateRegistryFactory?: NonNullable<ExecutionRuntimeDependencies["gateRegistryFactory"]>
  /** Typed-worker Git process boundary supplied by the executable composition root. */
  gitProcessSupervisorFactory?: NonNullable<
    ExecutionRuntimeDependencies["gitProcessSupervisorFactory"]
  >
  /** Supervised Ralph child coordinator process supplied by the executable composition root. */
  childRunWorkerSessionFactory?: NonNullable<
    ExecutionRuntimeDependencies["childRunWorkerSessionFactory"]
  >
  /** Explicit external-effect adapter for the create-pr integration strategy. */
  pullRequests?: NonNullable<ExecutionRuntimeDependencies["pullRequests"]>
  /** Lazily resolves the catalog only for provider/model/profile commands. */
  resolveModelCatalog?: () => ModelCatalog | Promise<ModelCatalog>
  /** Multi-provider credential composition root; never receives a raw secret. */
  credentials?: CredentialCommandService
  /** Optional interactive/TUI form adapter backed by the shared settings metadata. */
  profileForm?: (request: ProfileFormRequest) => Promise<ProfileFormResponse | undefined>
  /** Application-owned safe editor; command/domain code never spawns an arbitrary editor. */
  configEditor?: ConfigEditorCommandService
  /** Read-only smoke adapter. The command fixes prompt and tools before invoking it. */
  modelSmoke?: ModelSmokeCommandService
  /** Optional Solid/OpenTUI adapter composed only by the executable application. */
  runUi?: RunUiCommandService
  /** Supervisor-owned run lifecycle control; no model receives this capability. */
  runControl?: RunControlCommandService
  /** Optional supervisor-owned context rotation control for active runs. */
  contextControl?: ContextControlCommandService
  /** Executable-composed sandbox discovery shared with runtime preflight. */
  sandboxCapabilities?: SandboxCapabilityCommandService
  /** Authenticated live run-control server activated only after run persistence. */
  supervisorControl?: NonNullable<ExecutionRuntimeDependencies["supervisorControl"]>
  /** Bounded read-only GitHub issue projection used only by the tasks sync command. */
  githubIssues?: GitHubIssueCommandService
  /**
   * Local release-signature trust composition. A manifest identity is only a
   * claim; stable install/update remains fail-closed unless both capabilities
   * are supplied by the executable composition root.
   */
  distributionSignature?: {
    verifier: ReleaseSignatureVerifier
    trustPolicy: ReleaseSignatureTrustPolicy
  }
  /** Lazily loads executable-owned trust roots only for install/update. */
  resolveDistributionSignature?: () => Promise<
    | {
        verifier: ReleaseSignatureVerifier
        trustPolicy: ReleaseSignatureTrustPolicy
      }
    | undefined
  >
  /**
   * Application-composed invocation origin used only to return fail-closed
   * update guidance before a standalone install root is requested. It cannot
   * authorize a package-manager/Git command or any distribution mutation.
   */
  distributionOrigin?: Extract<InstallOrigin, { kind: "npm" | "dev-checkout" }>
  /** Optional distribution boundary; omitted by the executable to use the real bundled runtime. */
  distributionCommands?: DistributionCommandService
  /** External helper composition used so uninstall never removes a running binary in-place. */
  distributionUninstall?: {
    deferredCleanup: DeferredUninstallScheduler
    waitForPids?: readonly number[]
  }
}

export type HandledCommand<T = unknown> = {
  execution: CommandExecution<T>
  exitCode: ExitCode
}

function workspaceStart(parsed: ParsedCli, context: CommandContext): string {
  return resolve(context.cwd, parsed.options.workspace ?? ".")
}

function handled<T>(execution: CommandExecution<T>, exitCode: ExitCode = 0): HandledCommand<T> {
  return { execution, exitCode }
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

async function workspaceConfigPath(start: string, explicit: boolean): Promise<string | undefined> {
  const root = explicit ? start : await findWorkspaceRoot(start)
  if (!root) return undefined
  const status = await inspectWorkspace(root, { exact: true })
  if (!status.initialized) return undefined
  const path = workspaceLayout(root).config
  return path
}

const catalogsByContext = new WeakMap<CommandContext, Promise<ModelCatalog>>()

async function commandModelCatalog(context: CommandContext): Promise<ModelCatalog> {
  const existing = catalogsByContext.get(context)
  if (existing) return existing
  const pending = Promise.resolve().then(() => {
    if (context.resolveModelCatalog) return context.resolveModelCatalog()
    const configRoot = dirname(globalConfigPath(context.environment))
    return createModelCatalogRuntime({
      cachePath: join(configRoot, "cache", "model-catalog.json"),
    })
  })
  catalogsByContext.set(context, pending)
  try {
    return await pending
  } catch (error) {
    catalogsByContext.delete(context)
    throw error
  }
}

function catalogRequirements(parsed: ParsedCli): ModelRequirements | undefined {
  if (!parsed.options.requireTools && !parsed.options.requireStructuredOutput) return undefined
  return {
    input: [],
    tools: parsed.options.requireTools,
    toolStreaming: false,
    reasoning: false,
    structuredOutput: parsed.options.requireStructuredOutput,
    usage: [],
    access: [],
  }
}

function modelAddress(parsed: ParsedCli): { provider: string; model: string } {
  const argument = parsed.arguments[0] as string
  if (parsed.options.provider) {
    return { provider: parsed.options.provider, model: argument }
  }
  const separator = argument.indexOf("/")
  if (separator <= 0 || separator === argument.length - 1) {
    throw new RalphError(
      "RALPH_MODEL_PROVIDER_MISSING",
      "models inspect requires provider/model or --provider <provider>",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Use `models inspect openai/model-id` or `models inspect model-id --provider openai`.",
      },
    )
  }
  return {
    provider: argument.slice(0, separator),
    model: argument.slice(separator + 1),
  }
}

async function handleCatalogCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const catalog = await commandModelCatalog(context)
  const options = { refresh: parsed.options.refresh }
  const requirements = catalogRequirements(parsed)
  const result =
    parsed.command === "providers.list"
      ? await handleProvidersList(catalog, options)
      : parsed.command === "providers.inspect"
        ? await handleProviderInspect(catalog, parsed.arguments[0] as string, options)
        : parsed.command === "models.list"
          ? await handleModelsList(catalog, {
              ...options,
              ...(parsed.options.provider ? { provider: parsed.options.provider } : {}),
              ...(requirements ? { requirements } : {}),
            })
          : await handleModelInspect(catalog, {
              ...modelAddress(parsed),
              ...options,
              ...(parsed.options.variant ? { variant: parsed.options.variant } : {}),
            })
  return handled<unknown>({
    result: result.result as CommandResult<unknown>,
    human: result.human,
  })
}

function requireCredentialService(context: CommandContext): CredentialCommandService {
  if (context.credentials) return context.credentials
  throw new RalphError(
    "RALPH_CREDENTIAL_SERVICE_UNAVAILABLE",
    "Credential management is not configured in this Ralph composition",
    {
      exitCode: EXIT_CODES.providerUnavailable,
      hint: "Configure the embedded credential runtime before using auth commands.",
    },
  )
}

async function credentialOperation<T>(
  description: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof RalphError) throw error
    throw new RalphError("RALPH_CREDENTIAL_OPERATION_FAILED", description, {
      exitCode: EXIT_CODES.providerUnavailable,
      hint: "Inspect credential status and the provider authentication method, then retry.",
    })
  }
}

function credentialNotFound(id: string): never {
  throw new RalphError("RALPH_CREDENTIAL_NOT_FOUND", `Credential reference was not found: ${id}`, {
    exitCode: EXIT_CODES.providerUnavailable,
    details: { credential: id },
  })
}

async function listedCredentials(
  service: CredentialCommandService,
  provider?: string,
): Promise<readonly CredentialRef[]> {
  const credentials = await credentialOperation("Could not list credential references", async () =>
    (await service.list()).map((credential) => CredentialRefSchema.parse(credential)),
  )
  return provider
    ? credentials.filter((credential) => credential.provider === provider)
    : credentials
}

async function credentialStatus(
  service: CredentialCommandService,
  credential: CredentialRef,
  refresh: boolean,
  provider: ProviderInfo,
  catalogHandle?: CredentialCatalogHandle,
): Promise<CredentialStatus> {
  return credentialOperation("Could not inspect credential status", async () =>
    CredentialStatusSchema.parse(
      await service.status(credential, {
        refresh,
        provider,
        ...(catalogHandle ? { catalogHandle } : {}),
      }),
    ),
  )
}

type CredentialCatalogUse = {
  resolution: CatalogResolution
  handle?: CredentialCatalogHandle
}

async function credentialCatalogSnapshot(
  service: CredentialCommandService,
  context: CommandContext,
  options: { refresh: boolean } = { refresh: false },
): Promise<CredentialCatalogUse> {
  if (service.catalogSnapshot) {
    const handle = await service.catalogSnapshot(options)
    return { resolution: handle.resolution, handle }
  }
  return { resolution: await (await commandModelCatalog(context)).snapshot() }
}

async function authProvider(
  service: CredentialCommandService,
  context: CommandContext,
  providerId: string,
): Promise<{
  provider: ProviderInfo
  snapshotId: string
  catalogHandle?: CredentialCatalogHandle
}> {
  let catalog: CredentialCatalogUse
  try {
    catalog = await credentialCatalogSnapshot(service, context)
  } catch (error) {
    throw new RalphError(
      "RALPH_PROVIDER_CATALOG_UNAVAILABLE",
      "The provider catalog is unavailable for credential validation",
      {
        exitCode: EXIT_CODES.providerUnavailable,
        hint: "Retry when a provider catalog snapshot or cache is available.",
        cause: error,
      },
    )
  }
  const provider = catalog.resolution.snapshot.providers.find(
    (candidate) => candidate.id === providerId,
  )
  if (!provider) {
    throw new RalphError("RALPH_PROVIDER_NOT_FOUND", `Provider was not found: ${providerId}`, {
      exitCode: EXIT_CODES.providerUnavailable,
      details: { provider: providerId, catalogSnapshotId: catalog.resolution.snapshot.id },
    })
  }
  return {
    provider,
    snapshotId: catalog.resolution.snapshot.id,
    ...(catalog.handle ? { catalogHandle: catalog.handle } : {}),
  }
}

function credentialListHuman(credentials: readonly CredentialRef[]): string {
  if (credentials.length === 0) return "No credential references are configured."
  return credentials
    .map((credential) => {
      const expiry = credential.expiresAt ? `; expires ${credential.expiresAt}` : ""
      return `${credential.id}: ${credential.provider}/${credential.method} (${credential.store}${expiry}) — ${credential.label}`
    })
    .join("\n")
}

async function handleAuthCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  if (parsed.command === "auth.connect") {
    const parsedMethod = AuthMethodSchema.safeParse(parsed.options.method)
    if (!parsedMethod.success) {
      throw new RalphError(
        "RALPH_AUTH_METHOD_INVALID",
        `Unsupported authentication method: ${parsed.options.method ?? "missing"}`,
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: "Use a method advertised by `providers inspect <provider>`.",
        },
      )
    }
    const method = parsedMethod.data
    // Syntax validation is composition-independent: a bogus argv method must
    // remain invalid usage even when no credential service is configured.
    const service = requireCredentialService(context)
    const providerId = parsed.options.provider as string
    const resolvedProvider = await authProvider(service, context, providerId)
    if (
      !resolvedProvider.provider.credentialMethods.some((candidate) => candidate.method === method)
    ) {
      throw new RalphError(
        "RALPH_AUTH_METHOD_UNSUPPORTED",
        `Authentication method ${method} is not advertised by provider ${providerId}`,
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: `Inspect \`providers inspect ${providerId}\` and choose an advertised authentication method.`,
          details: {
            provider: providerId,
            method,
            catalogSnapshotId: resolvedProvider.snapshotId,
          },
        },
      )
    }
    if (method === "environment" && !parsed.options.environmentName) {
      throw new RalphError(
        "RALPH_AUTH_ENVIRONMENT_MISSING",
        "Environment authentication requires --environment <variable-name>",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (method !== "environment" && parsed.options.environmentName) {
      throw new RalphError(
        "RALPH_AUTH_ENVIRONMENT_UNEXPECTED",
        "--environment is only valid with the environment authentication method",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (parsed.options.secretStdin && method !== "api-key") {
      throw new RalphError(
        "RALPH_AUTH_SECRET_STDIN_UNEXPECTED",
        "--secret-stdin is only valid with the api-key authentication method",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (method === "api-key" && parsed.options.nonInteractive && !parsed.options.secretStdin) {
      throw new RalphError(
        "RALPH_AUTH_SECRET_INPUT_REQUIRED",
        "Non-interactive API key connection requires --secret-stdin",
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: "Pipe the secret to stdin; secret values are never accepted in argv.",
        },
      )
    }
    if (method === "oauth-browser" && (parsed.options.headless || parsed.options.nonInteractive)) {
      throw new RalphError(
        "RALPH_AUTH_BROWSER_OAUTH_UNAVAILABLE_HEADLESS",
        "Browser OAuth cannot wait for a loopback callback in headless or non-interactive mode",
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: "Use `auth connect <provider> --method device-code` for a headless subscription login.",
        },
      )
    }
    const credential = await credentialOperation("Credential connection failed", async () =>
      CredentialRefSchema.parse(
        await service.connect({
          provider: providerId,
          providerInfo: resolvedProvider.provider,
          ...(resolvedProvider.catalogHandle
            ? { catalogHandle: resolvedProvider.catalogHandle }
            : {}),
          method,
          ...(parsed.options.credential ? { credentialId: parsed.options.credential } : {}),
          ...(parsed.options.label ? { label: parsed.options.label } : {}),
          nonInteractive: parsed.options.nonInteractive,
          // Non-interactive mode must never launch a browser or another UI.
          // Browser OAuth will fail with device-code guidance; device flows
          // stay headless and print their actionable URL/code instead.
          headless: parsed.options.headless || parsed.options.nonInteractive,
          ...(parsed.options.timeout ? { timeoutMs: parsed.options.timeout * 1_000 } : {}),
          ...(parsed.options.environmentName
            ? { environmentName: parsed.options.environmentName }
            : {}),
          secretSource:
            method !== "api-key"
              ? "not-applicable"
              : parsed.options.secretStdin
                ? "stdin"
                : "masked-prompt",
          allowInsecureStore: parsed.options.allowInsecureStore,
        }),
      ),
    )
    return handled({
      result: commandResult("auth.connect", { credential }),
      human: `Connected credential ${credential.id}\nProvider: ${credential.provider}\nMethod: ${credential.method}\nStore: ${credential.store}`,
    })
  }

  const service = requireCredentialService(context)
  if (parsed.command === "auth.list") {
    const credentials = await listedCredentials(service, parsed.options.provider)
    return handled({
      result: commandResult("auth.list", { count: credentials.length, credentials }),
      human: credentialListHuman(credentials),
    })
  }

  if (parsed.command === "auth.status") {
    const requestedId = parsed.arguments[0]
    const credentials = await listedCredentials(service, parsed.options.provider)
    const selected = requestedId
      ? credentials.filter((credential) => credential.id === requestedId)
      : credentials
    if (requestedId && selected.length === 0) credentialNotFound(requestedId)
    const catalog =
      selected.length === 0
        ? undefined
        : await credentialOperation(
            "Could not load the provider catalog for credential status",
            () => credentialCatalogSnapshot(service, context),
          )
    const statuses = await Promise.all(
      selected.map(async (credential) => {
        if (!catalog) {
          throw new Error("Credential status requires one exact catalog snapshot")
        }
        const provider = catalog?.resolution.snapshot.providers.find(
          (candidate) => candidate.id === credential.provider,
        )
        if (!provider) {
          throw new RalphError(
            "RALPH_CREDENTIAL_PROVIDER_NOT_FOUND",
            `Credential provider is absent from the exact catalog snapshot: ${credential.provider}`,
            {
              exitCode: EXIT_CODES.providerUnavailable,
              details: { credential: credential.id, provider: credential.provider },
            },
          )
        }
        return {
          credential,
          status: await credentialStatus(
            service,
            credential,
            parsed.options.refresh,
            provider,
            catalog.handle,
          ),
        }
      }),
    )
    const human =
      statuses.length === 0
        ? "No credential references matched the status query."
        : statuses
            .map(({ credential, status }) => `${credential.id}: ${status} (${credential.provider})`)
            .join("\n")
    return handled({
      result: commandResult("auth.status", { count: statuses.length, credentials: statuses }),
      human,
    })
  }

  const credentialId = parsed.arguments[0] as string
  const credentials = await listedCredentials(service)
  const credential = credentials.find((candidate) => candidate.id === credentialId)
  if (!credential) credentialNotFound(credentialId)
  await credentialOperation("Credential revocation failed", () => service.revoke(credential))
  return handled({
    result: commandResult("auth.revoke", {
      credential: credential.id,
      provider: credential.provider,
      revoked: true,
    }),
    human: `Revoked credential ${credential.id} (${credential.provider}).`,
  })
}

async function effectiveConfigForCommand(parsed: ParsedCli, context: CommandContext) {
  const start = workspaceStart(parsed, context)
  const configPath = await workspaceConfigPath(start, parsed.options.workspace !== undefined)
  const effective = await loadEffectiveConfig({
    ...(configPath ? { workspaceConfig: configPath } : {}),
    environment: context.environment,
  })
  if (configPath) {
    const workspaceRoot = dirname(dirname(configPath))
    snapshotLedgerWorkspaceEventRetention(
      workspaceLayout(workspaceRoot).ledger,
      effective.config.telemetry.event_retention,
    )
  }
  return { effective, workspaceConfig: configPath }
}

function profileRole(value: string | undefined): "executor" | "judge" | undefined {
  if (value === undefined) return undefined
  if (value === "executor" || value === "judge") return value
  throw new RalphError("RALPH_PROFILE_ROLE_INVALID", `Invalid profile role: ${value}`, {
    exitCode: EXIT_CODES.invalidUsage,
    hint: "Use executor or judge.",
  })
}

function profileBackend(value: string | undefined): "embedded" | "external-cli" | undefined {
  if (value === undefined) return undefined
  if (value === "embedded" || value === "external-cli") return value
  throw new RalphError("RALPH_PROFILE_BACKEND_INVALID", `Invalid profile backend: ${value}`, {
    exitCode: EXIT_CODES.invalidUsage,
    hint: "Use embedded or external-cli.",
  })
}

function profileScope(value: string | undefined): "global" | "workspace" | undefined {
  if (value === undefined) return undefined
  if (value === "global" || value === "workspace") return value
  throw new RalphError("RALPH_PROFILE_SCOPE_INVALID", `Invalid profile scope: ${value}`, {
    exitCode: EXIT_CODES.invalidUsage,
    hint: "Use global or workspace.",
  })
}

function hasExternalCliProfileOptions(parsed: ParsedCli): boolean {
  return (
    parsed.options.cliExecutable !== undefined ||
    parsed.options.cliArgs.length > 0 ||
    parsed.options.cliCwd !== undefined ||
    Object.keys(parsed.options.cliEnvironmentRefs).length > 0 ||
    parsed.options.cliAdapter !== undefined ||
    parsed.options.cliAdapterId !== undefined ||
    parsed.options.cliStreaming !== undefined ||
    parsed.options.cliToolCalling !== undefined ||
    parsed.options.cliCancellation !== undefined ||
    parsed.options.cliUsage !== undefined ||
    parsed.options.cliMutationMode !== undefined ||
    parsed.options.cliTimeoutMs !== undefined ||
    parsed.options.cliOutputLimitBytes !== undefined
  )
}

function assertProfileBackendOptionCompatibility(parsed: ParsedCli): void {
  if (
    profileBackend(parsed.options.backend) !== "embedded" ||
    !hasExternalCliProfileOptions(parsed)
  ) {
    return
  }
  throw new RalphError(
    "RALPH_PROFILE_BACKEND_CLI_CONFLICT",
    "An embedded role profile cannot accept external CLI options",
    {
      exitCode: EXIT_CODES.invalidUsage,
      hint: "Remove the --cli-* options, or select --backend external-cli.",
    },
  )
}

function suggestedProfile(
  parsed: ParsedCli,
  existing: RoleProfileConfig | undefined,
): Partial<RoleProfileConfig> {
  const role = profileRole(parsed.options.role)
  const backend = profileBackend(parsed.options.backend)
  const selectedBackend = backend ?? existing?.backend
  const hasExternalCliOptions = hasExternalCliProfileOptions(parsed)
  const existingExternalCli = existing?.external_cli
  const selectedAdapter = parsed.options.cliAdapter ?? existingExternalCli?.adapter ?? "generic"
  const externalCli =
    selectedBackend === "external-cli" || hasExternalCliOptions
      ? {
          executable: parsed.options.cliExecutable ?? existingExternalCli?.executable ?? "",
          args:
            parsed.options.cliArgs.length > 0
              ? parsed.options.cliArgs
              : (existingExternalCli?.args ?? []),
          cwd: parsed.options.cliCwd ?? existingExternalCli?.cwd ?? ".",
          environment_refs:
            Object.keys(parsed.options.cliEnvironmentRefs).length > 0
              ? parsed.options.cliEnvironmentRefs
              : (existingExternalCli?.environment_refs ?? {}),
          input_mode: "stdin-json" as const,
          adapter: selectedAdapter,
          ...(selectedAdapter === "known-output"
            ? {
                adapter_id: parsed.options.cliAdapterId ?? existingExternalCli?.adapter_id,
              }
            : parsed.options.cliAdapterId
              ? { adapter_id: parsed.options.cliAdapterId }
              : {}),
          capabilities: {
            streaming:
              parsed.options.cliStreaming ?? existingExternalCli?.capabilities.streaming ?? false,
            tool_calling:
              parsed.options.cliToolCalling ??
              existingExternalCli?.capabilities.tool_calling ??
              "unavailable",
            cancellation:
              parsed.options.cliCancellation ??
              existingExternalCli?.capabilities.cancellation ??
              false,
            usage:
              parsed.options.cliUsage ?? existingExternalCli?.capabilities.usage ?? "unavailable",
          },
          mutation_mode:
            parsed.options.cliMutationMode ?? existingExternalCli?.mutation_mode ?? "read-only",
          timeout_ms: parsed.options.cliTimeoutMs ?? existingExternalCli?.timeout_ms ?? 300_000,
          output_limit_bytes:
            parsed.options.cliOutputLimitBytes ??
            existingExternalCli?.output_limit_bytes ??
            1_048_576,
        }
      : undefined
  const candidate: Partial<RoleProfileConfig> = {
    ...(existing ?? {}),
    ...(role ? { role } : {}),
    ...(backend ? { backend } : {}),
    ...(parsed.options.provider ? { provider: parsed.options.provider } : {}),
    ...(parsed.options.model ? { model: parsed.options.model } : {}),
    ...(parsed.options.credential ? { credential: parsed.options.credential } : {}),
    ...(parsed.options.variant ? { variant: parsed.options.variant } : {}),
    parameters:
      Object.keys(parsed.options.parameters).length > 0
        ? parsed.options.parameters
        : (existing?.parameters ?? {}),
    requirements: {
      input: existing?.requirements.input ?? [],
      tools: parsed.options.requireTools || (existing?.requirements.tools ?? false),
      tool_streaming: existing?.requirements.tool_streaming ?? false,
      reasoning: existing?.requirements.reasoning ?? false,
      structured_output:
        parsed.options.requireStructuredOutput ||
        (existing?.requirements.structured_output ?? false),
      usage: existing?.requirements.usage ?? [],
      access: existing?.requirements.access ?? [],
      ...(existing?.requirements.minimum_context
        ? { minimum_context: existing.requirements.minimum_context }
        : {}),
      ...(existing?.requirements.minimum_output
        ? { minimum_output: existing.requirements.minimum_output }
        : {}),
    },
    fallback_profiles:
      parsed.options.fallbackProfiles.length > 0
        ? parsed.options.fallbackProfiles
        : (existing?.fallback_profiles ?? []),
    fallback_on:
      parsed.options.fallbackOn.length > 0
        ? parsed.options.fallbackOn
        : (existing?.fallback_on ?? []),
    limits: existing?.limits ?? {},
    ...(externalCli ? { external_cli: externalCli } : {}),
  }
  if (parsed.options.clearCredential) delete candidate.credential
  if (parsed.options.clearVariant) delete candidate.variant
  if (parsed.options.clearParameters) candidate.parameters = {}
  return candidate
}

function profileLayerObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function commandProfileLayer(
  parsed: ParsedCli,
  currentLayer: RoleProfileConfigLayer | undefined,
  lowerProfile: RoleProfileConfig | undefined,
  suggested: Partial<RoleProfileConfig>,
): RoleProfileConfigLayer {
  let layer = structuredClone(currentLayer ?? {}) as Record<string, unknown>
  const setNested = (path: readonly string[], value: unknown): void => {
    let current = layer
    for (const segment of path.slice(0, -1)) {
      const existing = profileLayerObject(current[segment])
      if (existing) current = existing
      else {
        const created: Record<string, unknown> = {}
        current[segment] = created
        current = created
      }
    }
    const leaf = path.at(-1)
    if (leaf) current[leaf] = structuredClone(value)
  }

  const role = profileRole(parsed.options.role)
  const backend = profileBackend(parsed.options.backend)
  if (role) layer.role = role
  if (backend) layer.backend = backend
  if (parsed.options.provider !== undefined) layer.provider = parsed.options.provider
  if (parsed.options.model !== undefined) layer.model = parsed.options.model
  if (parsed.options.credential !== undefined) layer.credential = parsed.options.credential
  if (parsed.options.variant !== undefined) layer.variant = parsed.options.variant
  if (parsed.options.clearCredential) layer.credential = null
  if (parsed.options.clearVariant) layer.variant = null
  if (Object.keys(parsed.options.parameters).length > 0) {
    layer.parameters = structuredClone(parsed.options.parameters)
  }
  if (parsed.options.clearParameters) layer.parameters = {}
  if (parsed.options.fallbackProfiles.length > 0) {
    layer.fallback_profiles = [...parsed.options.fallbackProfiles]
  }
  if (parsed.options.fallbackOn.length > 0) {
    layer.fallback_on = [...parsed.options.fallbackOn]
  }
  if (parsed.options.requireTools) setNested(["requirements", "tools"], true)
  if (parsed.options.requireStructuredOutput) {
    setNested(["requirements", "structured_output"], true)
  }

  const hasExternalCliOptions = hasExternalCliProfileOptions(parsed)

  if (backend === "external-cli" && layer.external_cli === null) delete layer.external_cli
  const composedBeforeExternal = composeRoleProfileConfigLayer(
    (lowerProfile ?? {}) as Record<string, unknown>,
    layer,
  )
  const needsExternalSeed =
    (backend === "external-cli" || hasExternalCliOptions) &&
    !profileLayerObject(composedBeforeExternal.external_cli)
  if (needsExternalSeed) {
    const seed = structuredClone(suggested.external_cli ?? {}) as Record<string, unknown>
    if (seed.executable === "") delete seed.executable
    layer.external_cli = seed
  }
  if (hasExternalCliOptions) {
    if (!profileLayerObject(layer.external_cli)) layer.external_cli = {}
    if (parsed.options.cliExecutable !== undefined) {
      setNested(["external_cli", "executable"], parsed.options.cliExecutable)
    }
    if (parsed.options.cliArgs.length > 0) {
      setNested(["external_cli", "args"], parsed.options.cliArgs)
    }
    if (parsed.options.cliCwd !== undefined) {
      setNested(["external_cli", "cwd"], parsed.options.cliCwd)
    }
    if (Object.keys(parsed.options.cliEnvironmentRefs).length > 0) {
      setNested(["external_cli", "environment_refs"], parsed.options.cliEnvironmentRefs)
    }
    if (parsed.options.cliAdapter !== undefined) {
      setNested(["external_cli", "adapter"], parsed.options.cliAdapter)
      if (parsed.options.cliAdapter !== "known-output") {
        setNested(["external_cli", "adapter_id"], null)
      } else {
        const externalLayer = profileLayerObject(layer.external_cli)
        if (externalLayer?.adapter_id === null) delete externalLayer.adapter_id
      }
    }
    if (parsed.options.cliAdapterId !== undefined) {
      setNested(["external_cli", "adapter_id"], parsed.options.cliAdapterId)
    }
    if (parsed.options.cliStreaming !== undefined) {
      setNested(["external_cli", "capabilities", "streaming"], parsed.options.cliStreaming)
    }
    if (parsed.options.cliToolCalling !== undefined) {
      setNested(["external_cli", "capabilities", "tool_calling"], parsed.options.cliToolCalling)
    }
    if (parsed.options.cliCancellation !== undefined) {
      setNested(["external_cli", "capabilities", "cancellation"], parsed.options.cliCancellation)
    }
    if (parsed.options.cliUsage !== undefined) {
      setNested(["external_cli", "capabilities", "usage"], parsed.options.cliUsage)
    }
    if (parsed.options.cliMutationMode !== undefined) {
      setNested(["external_cli", "mutation_mode"], parsed.options.cliMutationMode)
    }
    if (parsed.options.cliTimeoutMs !== undefined) {
      setNested(["external_cli", "timeout_ms"], parsed.options.cliTimeoutMs)
    }
    if (parsed.options.cliOutputLimitBytes !== undefined) {
      setNested(["external_cli", "output_limit_bytes"], parsed.options.cliOutputLimitBytes)
    }
  }
  if (backend === "embedded") layer.external_cli = null

  // Inherit is applied after every explicit mutation. The parser rejects a
  // same-field set/clear conflict independent of argv order, while this shared
  // helper also repairs dependent backend/adapter/tool-streaming leaves.
  for (const fieldId of parsed.options.inheritProfileFields) {
    const field = inheritableRoleProfileFormField(fieldId)
    if (!field) {
      throw new RalphError(
        "RALPH_PROFILE_INHERIT_FIELD_INVALID",
        `Unknown or non-inheritable role-profile field: ${fieldId}`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (
      fieldId === "backend" &&
      hasExternalCliOptions &&
      lowerProfile?.backend !== "external-cli"
    ) {
      throw new RalphError(
        "RALPH_PROFILE_INHERIT_DEPENDENCY_CONFLICT",
        "Inheriting backend would select a non-external backend and discard explicit external CLI options",
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: "Remove the --cli-* options, or set --backend external-cli explicitly.",
        },
      )
    }
    if (
      fieldId === "cliAdapter" &&
      parsed.options.cliAdapterId !== undefined &&
      lowerProfile?.external_cli?.adapter !== "known-output"
    ) {
      throw new RalphError(
        "RALPH_PROFILE_INHERIT_DEPENDENCY_CONFLICT",
        "Inheriting cliAdapter would select an adapter that cannot use the explicit --cli-adapter-id",
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: "Remove --cli-adapter-id, or set --cli-adapter known-output explicitly.",
        },
      )
    }
    layer = inheritRoleProfileConfigLayerPath(
      layer,
      (lowerProfile ?? {}) as Record<string, unknown>,
      field.relativePath,
    )
  }

  const validated = RoleProfileConfigLayerSchema.safeParse(layer)
  if (validated.success) return validated.data
  throw new RalphError(
    "RALPH_PROFILE_CONFIG_LAYER_INVALID",
    "Profile flags would produce an invalid target layer",
    {
      exitCode: EXIT_CODES.invalidUsage,
      details: {
        issues: validated.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    },
  )
}

function parseProfileCandidate(input: unknown): RoleProfileConfig {
  const parsed = RoleProfileConfigSchema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new RalphError(
    "RALPH_PROFILE_CONFIG_INCOMPLETE",
    "The role profile is incomplete or invalid",
    {
      exitCode: EXIT_CODES.invalidUsage,
      hint: "Provide --scope, --role, --backend, --provider and --model. External CLI profiles also require --cli-executable; use env references instead of secret arguments.",
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    },
  )
}

function providerRequirements(profile: RoleProfileConfig): ModelRequirements {
  return {
    input: profile.requirements.input,
    tools: profile.requirements.tools,
    toolStreaming: profile.requirements.tool_streaming,
    reasoning: profile.requirements.reasoning,
    structuredOutput: profile.requirements.structured_output,
    usage: profile.requirements.usage,
    access: profile.requirements.access,
    ...(profile.requirements.minimum_context
      ? { minimumContext: profile.requirements.minimum_context }
      : {}),
    ...(profile.requirements.minimum_output
      ? { minimumOutput: profile.requirements.minimum_output }
      : {}),
  }
}

async function profileCommandDependencies(
  profileSets: readonly Readonly<Record<string, RoleProfileConfig>>[],
  context: CommandContext,
): Promise<{
  credentials: readonly CredentialRef[]
  catalog: Awaited<ReturnType<ModelCatalog["snapshot"]>>
  catalogHandle?: CredentialCatalogHandle
}> {
  const referencesCredential = profileSets.some((profileSet) =>
    Object.values(profileSet).some((profile) => profile.credential !== undefined),
  )
  const credentialService = referencesCredential ? requireCredentialService(context) : undefined
  const credentials = credentialService ? await listedCredentials(credentialService) : []
  const catalogUse = credentialService
    ? await credentialCatalogSnapshot(credentialService, context)
    : { resolution: await (await commandModelCatalog(context)).snapshot() }
  const catalog = catalogUse.resolution
  return {
    credentials,
    catalog,
    ...(catalogUse.handle ? { catalogHandle: catalogUse.handle } : {}),
  }
}

async function resolveProfileCommandSet(
  profiles: Readonly<Record<string, RoleProfileConfig>>,
  context: CommandContext,
): Promise<{
  credentials: readonly CredentialRef[]
  catalog: Awaited<ReturnType<ModelCatalog["snapshot"]>>
  catalogHandle?: CredentialCatalogHandle
  runtime: ReturnType<typeof resolveRuntimeProfiles>
}> {
  const dependencies = await profileCommandDependencies([profiles], context)
  return {
    ...dependencies,
    runtime: resolveRuntimeProfiles(
      profiles,
      dependencies.credentials,
      dependencies.catalog.snapshot,
    ),
  }
}

function profileCatalogUse(
  catalog: Awaited<ReturnType<ModelCatalog["snapshot"]>>,
): Record<string, unknown> {
  return {
    snapshotId: catalog.snapshot.id,
    source: catalog.snapshot.source,
    origin: catalog.origin,
    stale: catalog.stale,
    ...(catalog.warning ? { warning: catalog.warning } : {}),
  }
}

function profileSources(
  profileId: string,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const prefix = `profiles.${profileId}.`
  return Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith(prefix)))
}

function profileHuman(
  profileId: string,
  profile: RoleProfileConfig,
  effectiveParameters: ModelParameters = profile.parameters,
): string {
  return [
    `Profile: ${profileId}`,
    `Role: ${profile.role}`,
    `Backend: ${profile.backend}`,
    `Provider/model: ${profile.provider}/${profile.model}`,
    `Credential ref: ${profile.credential ?? "none"}`,
    `Variant: ${profile.variant ?? "default"}`,
    `Effective parameters: ${JSON.stringify(effectiveParameters)}`,
    `Fallbacks: ${profile.fallback_profiles.join(", ") || "none"}`,
    `Requires tools: ${profile.requirements.tools ? "yes" : "no"}`,
    `Requires structured output: ${profile.requirements.structured_output ? "yes" : "no"}`,
    ...(profile.external_cli
      ? [
          `External executable: ${profile.external_cli.executable}`,
          `External adapter: ${profile.external_cli.adapter}${profile.external_cli.adapter_id ? `/${profile.external_cli.adapter_id}` : ""}`,
          `External mutation: ${profile.external_cli.mutation_mode}`,
          `External tool calling: ${profile.external_cli.capabilities.tool_calling}`,
          `External env refs: ${Object.keys(profile.external_cli.environment_refs).length}`,
        ]
      : []),
  ].join("\n")
}

async function handleProfilesCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const { effective, workspaceConfig } = await effectiveConfigForCommand(parsed, context)
  if (parsed.command === "profiles.list") {
    const role = profileRole(parsed.options.role)
    const profiles = Object.entries(effective.config.profiles)
      .filter(([, profile]) => !role || profile.role === role)
      .map(([id, profile]) => ({ id, profile }))
    return handled({
      result: commandResult("profiles.list", { count: profiles.length, profiles }),
      human:
        profiles.length === 0
          ? "No role profiles are configured."
          : profiles
              .map(
                ({ id, profile }) =>
                  `${id}: ${profile.role} ${profile.provider}/${profile.model} credential=${profile.credential ?? "none"}`,
              )
              .join("\n"),
    })
  }

  const profileId =
    parsed.command === "profiles.configure"
      ? (parsed.options.profile as string)
      : (parsed.arguments[0] as string)
  const effectiveExisting = effective.config.profiles[profileId]

  if (parsed.command === "profiles.inspect") {
    if (!effectiveExisting) {
      throw new RalphError("RALPH_PROFILE_NOT_FOUND", `Profile was not found: ${profileId}`, {
        exitCode: EXIT_CODES.invalidUsage,
      })
    }
    const resolved = await resolveProfileCommandSet(effective.config.profiles, context)
    const credential = effectiveExisting.credential
      ? resolved.credentials.find((candidate) => candidate.id === effectiveExisting.credential)
      : undefined
    const credentialProvider = credential
      ? resolved.catalog.snapshot.providers.find(
          (candidate) => candidate.id === credential.provider,
        )
      : undefined
    if (credential && !credentialProvider) {
      throw new RalphError(
        "RALPH_PROFILE_CREDENTIAL_PROVIDER_NOT_FOUND",
        `Credential provider is absent from the exact catalog snapshot for profile ${profileId}`,
        {
          exitCode: EXIT_CODES.providerUnavailable,
          details: {
            profile: profileId,
            credential: credential.id,
            provider: credential.provider,
            catalogSnapshotId: resolved.catalog.snapshot.id,
          },
        },
      )
    }
    const resolvedCredentialStatus =
      credential && credentialProvider
        ? await credentialStatus(
            requireCredentialService(context),
            credential,
            false,
            credentialProvider,
            resolved.catalogHandle,
          )
        : undefined
    const model =
      effectiveExisting.backend === "embedded"
        ? resolved.catalog.snapshot.models.find(
            (candidate) =>
              candidate.provider === effectiveExisting.provider &&
              candidate.id === effectiveExisting.model,
          )
        : undefined
    const data = {
      id: profileId,
      profile: effectiveExisting,
      runtimeProfile: resolved.runtime.profiles[profileId],
      effectiveParameters: resolved.runtime.profiles[profileId]?.parameters ?? {},
      fallbackPolicy: resolved.runtime.fallbackPolicies[profileId],
      catalog: profileCatalogUse(resolved.catalog),
      sources: profileSources(profileId, effective.values),
      ...(credential ? { credential: { ref: credential, status: resolvedCredentialStatus } } : {}),
      ...(model ? { model } : {}),
      form: roleProfileFormMetadata(profileId),
    }
    return handled({
      result: commandResult("profiles.inspect", data),
      human: profileHuman(
        profileId,
        effectiveExisting,
        resolved.runtime.profiles[profileId]?.parameters ?? effectiveExisting.parameters,
      ),
    })
  }

  assertProfileBackendOptionCompatibility(parsed)
  const commandScope = profileScope(parsed.options.scope)
  let scope = commandScope
  const activeWorkspaceRoot = workspaceConfig ? dirname(dirname(workspaceConfig)) : undefined
  const globalBaseline = await readConfigTransferLayer({
    scope: "global",
    ...(context.environment ? { environment: context.environment } : {}),
  })
  const workspaceBaseline = activeWorkspaceRoot
    ? await readConfigTransferLayer({
        scope: "workspace",
        workspaceRoot: activeWorkspaceRoot,
        ...(context.environment ? { environment: context.environment } : {}),
      })
    : undefined
  const globalEffective = composeEffectiveConfigLayers({ global: globalBaseline.layer })
  const workspaceEffective = workspaceBaseline
    ? composeEffectiveConfigLayers({
        global: globalBaseline.layer,
        workspace: workspaceBaseline.layer,
      })
    : globalEffective
  const existingByScope = {
    global: globalEffective.profiles[profileId],
    workspace: workspaceEffective.profiles[profileId],
  } as const
  const expectedShaByScope = {
    global: globalBaseline.sha256,
    workspace: workspaceBaseline?.sha256 ?? null,
  } as const
  const suggestedByScope = {
    global: suggestedProfile(parsed, existingByScope.global),
    workspace: suggestedProfile(parsed, existingByScope.workspace),
  } as const
  const rawLayerByScope = {
    global: globalBaseline.layer.profiles?.[profileId],
    workspace: workspaceBaseline?.layer.profiles?.[profileId],
  } as const
  const lowerProfileByScope = {
    global: DEFAULT_CONFIG.profiles[profileId],
    workspace: globalEffective.profiles[profileId],
  } as const
  const initialScope = scope ?? "workspace"
  const commandLayerByScope = {
    global:
      !scope || scope === "global"
        ? commandProfileLayer(
            parsed,
            rawLayerByScope.global,
            lowerProfileByScope.global,
            suggestedByScope.global,
          )
        : structuredClone(rawLayerByScope.global ?? {}),
    workspace:
      !scope || scope === "workspace"
        ? commandProfileLayer(
            parsed,
            rawLayerByScope.workspace,
            lowerProfileByScope.workspace,
            suggestedByScope.workspace,
          )
        : structuredClone(rawLayerByScope.workspace ?? {}),
  } as const
  const existing = existingByScope[initialScope]
  const suggested = suggestedByScope[initialScope]
  let selectedProfileLayer: RoleProfileConfigLayer | undefined = commandLayerByScope[initialScope]
  let profileInput: unknown = composeRoleProfileConfigLayer(
    (lowerProfileByScope[initialScope] ?? {}) as Record<string, unknown>,
    selectedProfileLayer,
  )
  let profileResult = RoleProfileConfigSchema.safeParse(profileInput)
  let formSetDefault = false
  let formExpectedTargetSha256: string | null | undefined
  let formExpectedPeerSha256: string | null | undefined
  if (!scope || !profileResult.success) {
    if (parsed.options.nonInteractive) {
      if (!scope) {
        throw new RalphError(
          "RALPH_PROFILE_SCOPE_MISSING",
          "Non-interactive profile configuration requires --scope global|workspace",
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      parseProfileCandidate(suggested)
      throw new RalphError(
        "RALPH_PROFILE_FORM_UNAVAILABLE",
        "Interactive profile configuration is unavailable in this composition",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    const form = context.profileForm
    if (!form) {
      if (!scope) {
        throw new RalphError(
          "RALPH_PROFILE_SCOPE_MISSING",
          "Profile configuration requires --scope global|workspace",
          {
            exitCode: EXIT_CODES.invalidUsage,
            hint: "Supply all profile flags directly or run in a composition with an interactive form adapter.",
          },
        )
      }
      parseProfileCandidate(suggested)
      throw new RalphError(
        "RALPH_PROFILE_FORM_UNAVAILABLE",
        "Interactive profile configuration is unavailable in this composition",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    const response = await form({
      profileId,
      ...(existing ? { existing } : {}),
      suggested,
      initialScope,
      ...(commandScope ? { scopeLocked: true } : {}),
      scopedCandidates: {
        global: {
          ...(existingByScope.global ? { existing: existingByScope.global } : {}),
          suggested: suggestedByScope.global,
        },
        workspace: {
          ...(existingByScope.workspace ? { existing: existingByScope.workspace } : {}),
          suggested: suggestedByScope.workspace,
        },
      },
      scopedLayers: {
        global: {
          profileLayer: commandLayerByScope.global,
          ...(lowerProfileByScope.global ? { lowerProfile: lowerProfileByScope.global } : {}),
        },
        workspace: {
          profileLayer: commandLayerByScope.workspace,
          ...(lowerProfileByScope.workspace ? { lowerProfile: lowerProfileByScope.workspace } : {}),
        },
      },
      ...(parsed.options.clearCredential ||
      parsed.options.clearVariant ||
      parsed.options.clearParameters
        ? {
            clearedFields: [
              ...(parsed.options.clearCredential ? ["credential" as const] : []),
              ...(parsed.options.clearVariant ? ["variant" as const] : []),
              ...(parsed.options.clearParameters ? ["parameters" as const] : []),
            ],
          }
        : {}),
      metadata: roleProfileFormMetadata(profileId),
    })
    if (!response) {
      throw new RalphError(
        "RALPH_PROFILE_CONFIGURATION_CANCELLED",
        "Profile configuration was cancelled",
        {
          exitCode: EXIT_CODES.interrupted,
        },
      )
    }
    const responseScope = profileScope(response.scope)
    if (commandScope && responseScope !== commandScope) {
      throw new RalphError(
        "RALPH_PROFILE_SCOPE_CONFLICT",
        `The profile form returned scope ${responseScope} after the command fixed scope ${commandScope}`,
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: "Omit --scope to choose the destination in the form, or keep the explicit command scope.",
        },
      )
    }
    scope = responseScope
    profileInput = response.profile
    if (response.profileLayer !== undefined) {
      const parsedLayer = RoleProfileConfigLayerSchema.safeParse(response.profileLayer)
      if (!parsedLayer.success) {
        throw new RalphError(
          "RALPH_PROFILE_CONFIG_LAYER_INVALID",
          "The profile form returned an invalid target layer",
          {
            exitCode: EXIT_CODES.invalidUsage,
            details: {
              issues: parsedLayer.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          },
        )
      }
      selectedProfileLayer = parsedLayer.data
    } else {
      selectedProfileLayer = undefined
    }
    formSetDefault = response.setDefault === true
    if (Object.hasOwn(response, "expectedTargetSha256")) {
      formExpectedTargetSha256 = response.expectedTargetSha256
    }
    if (Object.hasOwn(response, "expectedPeerSha256")) {
      formExpectedPeerSha256 = response.expectedPeerSha256
    }
    profileResult = RoleProfileConfigSchema.safeParse(profileInput)
  }
  const parsedProfile = profileResult.success
    ? profileResult.data
    : parseProfileCandidate(profileInput)
  const clearedProfile = { ...parsedProfile }
  if (parsed.options.clearCredential) delete clearedProfile.credential
  if (parsed.options.clearVariant) delete clearedProfile.variant
  if (parsed.options.clearParameters) clearedProfile.parameters = {}
  const profile = RoleProfileConfigSchema.parse(clearedProfile)
  if (selectedProfileLayer) {
    const authoritativeLayer = structuredClone(selectedProfileLayer)
    if (parsed.options.clearCredential) authoritativeLayer.credential = null
    if (parsed.options.clearVariant) authoritativeLayer.variant = null
    if (parsed.options.clearParameters) authoritativeLayer.parameters = {}
    selectedProfileLayer = RoleProfileConfigLayerSchema.parse(authoritativeLayer)
  }
  if (!scope) {
    throw new RalphError("RALPH_PROFILE_SCOPE_MISSING", "Profile configuration scope is missing", {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  const currentTargetSha256 = expectedShaByScope[scope]
  const currentPeerSha256 =
    scope === "workspace" ? globalBaseline.sha256 : workspaceBaseline?.sha256
  if (formExpectedTargetSha256 !== undefined && formExpectedTargetSha256 !== currentTargetSha256) {
    throw new RalphError(
      "RALPH_PROFILE_CONFIG_CONFLICT",
      "Role profile target configuration changed after the form was loaded",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  if (formExpectedPeerSha256 !== undefined && formExpectedPeerSha256 !== currentPeerSha256) {
    throw new RalphError(
      "RALPH_PROFILE_CONFIG_CONFLICT",
      "Role profile peer configuration changed after the form was loaded",
      { exitCode: EXIT_CODES.conflict },
    )
  }

  const dependencies = await profileCommandDependencies(
    [globalEffective.profiles, workspaceEffective.profiles, { [profileId]: profile }],
    context,
  )
  let committedRuntime: ReturnType<typeof resolveRuntimeProfiles> | undefined

  const target =
    scope === "global"
      ? globalBaseline.path
      : (workspaceBaseline?.path ??
        (await requireInitializedWorkspace(parsed, context)).layout.config)
  const peerConfigSnapshot =
    scope === "workspace"
      ? {
          path: globalBaseline.path,
          expectedSha256: formExpectedPeerSha256 ?? globalBaseline.sha256,
        }
      : workspaceBaseline
        ? {
            path: workspaceBaseline.path,
            expectedSha256: formExpectedPeerSha256 ?? workspaceBaseline.sha256,
          }
        : undefined
  const mutation = await writeRoleProfileConfig(target, profileId, profile, {
    workspace: scope === "workspace",
    ...(selectedProfileLayer ? { profileLayer: selectedProfileLayer } : {}),
    ...(parsed.options.setDefault || formSetDefault ? { setDefault: true } : {}),
    ...(context.environment ? { environment: context.environment } : {}),
    ...(scope === "global" && workspaceConfig
      ? { workspaceRoot: dirname(dirname(workspaceConfig)) }
      : {}),
    expectedTargetSha256: formExpectedTargetSha256 ?? expectedShaByScope[scope],
    ...(peerConfigSnapshot ? { peerConfigSnapshot } : {}),
    validateEffective(candidate) {
      committedRuntime = resolveRuntimeProfiles(
        candidate.profiles,
        dependencies.credentials,
        dependencies.catalog.snapshot,
      )
    },
  })
  if (!committedRuntime) {
    throw new RalphError(
      "RALPH_PROFILE_EFFECTIVE_VALIDATION_MISSING",
      "The latest effective profile graph was not validated before commit",
      { exitCode: EXIT_CODES.operationalError, file: mutation.path },
    )
  }
  const resolved = { ...dependencies, runtime: committedRuntime }
  return handled({
    result: commandResult("profiles.configure", {
      scope,
      profileId,
      profile,
      runtimeProfile: resolved.runtime.profiles[profileId],
      effectiveParameters: resolved.runtime.profiles[profileId]?.parameters ?? {},
      fallbackPolicy: resolved.runtime.fallbackPolicies[profileId],
      catalog: profileCatalogUse(resolved.catalog),
      created: mutation.created,
      path: mutation.path,
      ...(mutation.defaultSelection ? { defaultSelection: mutation.defaultSelection } : {}),
      form: roleProfileFormMetadata(profileId),
    }),
    human: `${mutation.created ? "Created" : "Updated"} ${scope} profile ${profileId}.${
      mutation.defaultSelection
        ? `\nDefault ${mutation.defaultSelection.role} profile: ${mutation.defaultSelection.profileId} (previous: ${mutation.defaultSelection.previous ?? "none"})`
        : ""
    }\n${profileHuman(
      profileId,
      profile,
      resolved.runtime.profiles[profileId]?.parameters ?? profile.parameters,
    )}`,
  })
}

const MODEL_SMOKE_PROMPT =
  "Reply with exactly RALPH_SMOKE_OK. Do not call tools and do not perform side effects."

async function modelSmokeOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof RalphError) throw error
    if (error instanceof ProviderCoreError) {
      throw new RalphError("RALPH_MODEL_SMOKE_PARAMETER_INVALID", error.message, {
        exitCode: EXIT_CODES.invalidUsage,
        details: { providerCode: error.code, ...error.details },
      })
    }
    throw new RalphError("RALPH_MODEL_SMOKE_FAILED", "The read-only model smoke call failed", {
      exitCode: EXIT_CODES.providerUnavailable,
      hint: "Inspect the selected profile, credential status and provider availability.",
    })
  }
}

async function handleModelSmoke(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const smokeService = context.modelSmoke
  if (!smokeService) {
    throw new RalphError(
      "RALPH_MODEL_SMOKE_SERVICE_UNAVAILABLE",
      "The model smoke runtime is not configured in this Ralph composition",
      {
        exitCode: EXIT_CODES.providerUnavailable,
        hint: "Configure an embedded provider driver before making a model smoke call.",
      },
    )
  }
  const { effective, workspaceConfig } = await effectiveConfigForCommand(parsed, context)
  const profileId = parsed.options.profile
  const profile = profileId ? effective.config.profiles[profileId] : undefined
  if (profileId && !profile) {
    throw new RalphError("RALPH_PROFILE_NOT_FOUND", `Profile was not found: ${profileId}`, {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  if (profile?.backend === "external-cli") {
    throw new RalphError(
      "RALPH_MODEL_SMOKE_BACKEND_UNSUPPORTED",
      "S04 model smoke accepts embedded provider profiles only",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "External CLI backend smoke belongs to the S05 execution adapter.",
      },
    )
  }
  const provider = parsed.options.provider ?? profile?.provider
  const model = parsed.options.model ?? profile?.model
  const credentialId = parsed.options.credential ?? profile?.credential
  const variant = parsed.options.variant ?? profile?.variant
  if (!provider || !model) {
    throw new RalphError(
      "RALPH_MODEL_SMOKE_TARGET_MISSING",
      "model smoke requires --profile or both --provider and --model",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }

  let credential: CredentialRef | undefined
  if (credentialId) {
    const service = requireCredentialService(context)
    credential = (await listedCredentials(service)).find(
      (candidate) => candidate.id === credentialId,
    )
    if (!credential) credentialNotFound(credentialId)
    if (credential.provider !== provider) {
      throw new RalphError(
        "RALPH_MODEL_SMOKE_CREDENTIAL_PROVIDER_MISMATCH",
        `Credential ${credential.id} belongs to ${credential.provider}, not ${provider}`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
  }

  const request: ModelSmokeCommandRequest = {
    ...(profileId ? { profileId } : {}),
    provider,
    model,
    ...(credentialId ? { credentialId } : {}),
    ...(variant ? { variant } : {}),
    parameters:
      Object.keys(parsed.options.parameters).length > 0
        ? parsed.options.parameters
        : (profile?.parameters ?? {}),
    requirements: profile
      ? providerRequirements(profile)
      : {
          input: ["text"],
          tools: false,
          toolStreaming: false,
          reasoning: false,
          structuredOutput: false,
          usage: [],
          access: [],
        },
    prompt: MODEL_SMOKE_PROMPT,
    tools: [],
    readOnly: true,
    refreshCatalog: parsed.options.refresh,
    ...(parsed.options.timeout ? { timeoutMs: parsed.options.timeout * 1_000 } : {}),
    telemetry: effective.config.telemetry,
    diagnosticScope: workspaceConfig
      ? dirname(dirname(workspaceConfig))
      : workspaceStart(parsed, context),
  }
  const smoke = await modelSmokeOperation(() => smokeService.smoke(request))
  if (!smoke || smoke.provider !== provider || smoke.model !== model) {
    throw new RalphError(
      "RALPH_MODEL_SMOKE_RESULT_MISMATCH",
      "The smoke adapter returned a result for a different provider or model",
      { exitCode: EXIT_CODES.providerUnavailable },
    )
  }
  const normalized = await modelSmokeOperation(async () => ({
    effectiveParameters: ModelParametersSchema.parse(smoke.effectiveParameters),
    usage: smoke.usage ? TokenUsageSchema.parse(smoke.usage) : undefined,
    events: smoke.events?.map((event) => ProviderEventSchema.parse(event)),
  }))
  const usage = normalized.usage
  const events = normalized.events
  const effectiveParameters = normalized.effectiveParameters
  const hasAnyCatalogProvenance =
    smoke.catalogSnapshotId !== undefined ||
    smoke.catalogOrigin !== undefined ||
    smoke.catalogStale !== undefined
  const hasCompleteCatalogProvenance =
    /^catalog:[a-f0-9]{64}$/.test(smoke.catalogSnapshotId ?? "") &&
    smoke.catalogOrigin !== undefined &&
    smoke.catalogStale !== undefined
  if (hasAnyCatalogProvenance && !hasCompleteCatalogProvenance) {
    throw new RalphError(
      "RALPH_MODEL_SMOKE_CATALOG_PROVENANCE_INVALID",
      "The smoke adapter returned incomplete catalog provenance",
      { exitCode: EXIT_CODES.providerUnavailable },
    )
  }
  const data = {
    provider,
    model,
    ...(profileId ? { profile: profileId } : {}),
    ...(credentialId ? { credential: credentialId } : {}),
    ...(variant ? { variant } : {}),
    parameters: effectiveParameters,
    readOnly: true,
    tools: [],
    text: smoke.text ?? "",
    finishReason: smoke.finishReason ?? "unknown",
    ...(usage ? { usage } : {}),
    ...(events ? { events } : {}),
    ...(smoke.rawRef ? { rawRef: smoke.rawRef } : {}),
    ...(hasCompleteCatalogProvenance
      ? {
          catalog: {
            snapshotId: smoke.catalogSnapshotId as string,
            origin: smoke.catalogOrigin,
            stale: smoke.catalogStale,
          },
        }
      : {}),
  }
  const usageText = usage
    ? `Usage: ${usage.source}${usage.total === undefined ? "" : ` total=${usage.total}`}`
    : "Usage: unavailable"
  return handled({
    result: commandResult("model.smoke", data),
    human: `Read-only smoke completed for ${provider}/${model}.\nFinish: ${data.finishReason}\n${usageText}\n${data.text}`,
  })
}

async function handleTasks(parsed: ParsedCli, context: CommandContext): Promise<HandledCommand> {
  const workspaceRoot = await canonicalDirectory(workspaceStart(parsed, context))
  const prdPath = parsed.options.prd ?? "PRD.md"
  if (parsed.command === "tasks.sync") {
    const data = await syncGitHubIssueTasks({
      workspaceRoot,
      output: parsed.options.output ?? "PRD.md",
      repository: parsed.options.repo as string,
      state: parsed.options.issueState ?? "open",
      ...(parsed.options.label ? { label: parsed.options.label } : {}),
      force: parsed.options.force,
      service:
        context.githubIssues ??
        createGitHubIssueCommandService({ environment: context.environment }),
      ...(context.signal ? { signal: context.signal } : {}),
    })
    return handled({
      result: commandResult("tasks.sync", data),
      human: [
        `GitHub issues synchronized as PRD v2: ${data.output}`,
        `Repository: ${data.repository}`,
        `Filter:     state=${data.state}${data.label ? ` label=${data.label}` : ""}`,
        `Tasks:      ${data.issueCount}`,
        `Hash:       ${data.contentHash}`,
        `Overwrite:  ${data.overwritten ? "yes (--force)" : "no"}`,
      ].join("\n"),
    })
  }
  if (parsed.command === "tasks.done") {
    const data = await completeOperationalTask({
      workspaceRoot,
      prdPath,
      requested: parsed.arguments[0] as string,
      force: parsed.options.force,
      ...(parsed.options.reason ? { reason: parsed.options.reason } : {}),
      evidencePaths: parsed.options.evidencePaths,
      environment: context.environment,
    })
    return handled({
      result: commandResult("tasks.done", data),
      human: [
        `${data.changed ? "Completed" : "Already completed"}: ${data.ref}`,
        `Override: audited (${data.automaticEvaluationChanged ? "evaluation changed" : "automatic evaluation preserved"})`,
        `Evidence: ${data.evidence.length}`,
        `Reason:   ${data.reason}`,
        `Events:   ${data.auditEvents.join(", ")}`,
      ].join("\n"),
    })
  }

  const graph = await compileOperationalPrd(workspaceRoot, prdPath)
  if (parsed.command === "tasks.next") {
    const task = nextOperationalTask(graph)
    const data = {
      graphHash: graph.graphHash,
      definitionHash: graph.definitionHash,
      task,
    }
    return handled({
      result: commandResult("tasks.next", data),
      human: task
        ? `${task.ref}  [${task.status}] ${task.title}`
        : "No dependency-eligible unfinished task is available.",
    })
  }

  const filter: TaskListFilter = parsed.options.pending
    ? "pending"
    : parsed.options.completed
      ? "completed"
      : parsed.options.review
        ? "review"
        : "all"
  const tasks = listOperationalTasks(graph, filter)
  const data = {
    graphHash: graph.graphHash,
    definitionHash: graph.definitionHash,
    filter,
    count: tasks.length,
    tasks,
  }
  const marker = { pending: "[ ]", active: "[~]", completed: "[x]" } as const
  return handled({
    result: commandResult("tasks.list", data),
    human:
      tasks.length === 0
        ? `No tasks match filter: ${filter}`
        : tasks
            .map(
              (task) =>
                `${String(task.index).padStart(3)}. ${marker[task.status]} ${task.ref}${task.eligible ? "  <next>" : ""}\n     ${task.title}`,
            )
            .join("\n"),
  })
}

async function handleMigration(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const requestedSource = resolve(context.cwd, parsed.arguments[0] as string)
  if (parsed.command === "migrate.rollback") {
    if (parsed.options.dryRun) {
      const data = await previewLegacyMigrationRollback(requestedSource)
      return handled({
        result: commandResult("migrate.rollback", data),
        human: [
          "Migration rollback preview (no files changed)",
          `Manifest:       ${data.manifestPath}`,
          `Destination:    ${data.destinationRoot}`,
          `Files:          ${data.fileCount} unchanged created files + manifest`,
          `Empty dirs:     ${data.directoryCount} candidates; non-empty directories are preserved`,
          "Legacy source: untouched (the source is never read or written by rollback)",
          `Plan SHA-256:   ${data.planHash}`,
          "Created files authorized only while these hashes remain exact:",
          ...data.createdFiles.map((file) => `  - ${file.path}  ${file.sha256}`),
          `  - ${data.manifestPath}  ${data.manifestSha256}  (manifest; removed last)`,
          "Empty-directory candidates (deepest first; non-empty paths remain):",
          ...(data.emptyDirectoryCandidates.length > 0
            ? data.emptyDirectoryCandidates.map((path) => `  - ${path}`)
            : ["  (none)"]),
          "Apply only after inspecting this exact plan:",
          `  ralph migrate rollback ${JSON.stringify(data.manifestPath)} --confirm-plan-hash ${data.planHash}`,
        ].join("\n"),
      })
    }
    const confirmationPlanHash = parsed.options.confirmationPlanHash
    if (!confirmationPlanHash) {
      throw new RalphError(
        "RALPH_MIGRATION_ROLLBACK_CONFIRMATION_MISSING",
        "migrate rollback requires the exact preview plan hash",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    const data = await applyLegacyMigrationRollback({
      manifestPath: requestedSource,
      confirmationPlanHash,
    })
    return handled({
      result: commandResult("migrate.rollback", data),
      human: [
        "Migration rollback applied",
        `Destination:     ${data.destinationRoot}`,
        `Confirmed plan:  ${data.confirmedPlanHash}`,
        `Removed files:   ${data.removedFileCount}`,
        `Removed dirs:    ${data.removedDirectoryCount} empty directories`,
        "Legacy source:  untouched",
        "Unrelated files and non-empty directories were preserved.",
        "Removed paths:",
        ...data.removedFiles.map((path) => `  - ${path}`),
        ...(data.removedEmptyDirectories.length > 0
          ? [
              "Removed empty directories:",
              ...data.removedEmptyDirectories.map((path) => `  - ${path}`),
            ]
          : []),
      ].join("\n"),
    })
  }
  if (parsed.command === "migrate.inspect") {
    const data = await inspectLegacyWorkspace(requestedSource)
    return handled({
      result: commandResult("migrate.inspect", data),
      human: [
        `Legacy source: ${data.sourceRoot}`,
        `Fingerprint:   ${data.sourceFingerprint}`,
        `PRD:           ${data.prd ? `${data.prd.taskCount} tasks (${data.prd.completed} completed, ${data.prd.review} review, ${data.prd.pending} pending)` : "not found"}`,
        `Config:        ${data.config ? `${data.config.mappings.length} classified mappings` : "not found"}`,
        `Secrets:       ${data.config?.secretReferences.length ?? 0} omitted; references required`,
        `Artifacts:     ${data.artifacts.length} inspected; none executed`,
        `Recovery:      ${data.recoveryArtifacts.length} heartbeat/checkpoint artifacts inventoried; none imported`,
        `Legacy run:    ${data.state?.active ? "active — will NOT be converted" : "not active"}`,
        `Next marker:   ${data.handoff.nextTask ? `${data.handoff.nextTask.index}. ${data.handoff.nextTask.text}` : "none"}`,
        `Recommendation: ${data.handoff.recommendation}`,
      ].join("\n"),
    })
  }
  const destination = resolve(context.cwd, parsed.options.destination as string)
  const data = await applyLegacyMigration({
    source: requestedSource,
    destination,
    version: context.version,
    importAdapters: parsed.options.importAdapters,
    importRecipes: parsed.options.importRecipes,
  })
  return handled({
    result: commandResult("migrate.apply", data),
    human: [
      `Ralph v2 workspace created separately at ${data.destinationRoot}`,
      `PRD:      ${data.prd}`,
      `Config:   ${data.config}`,
      `Report:   ${data.report}`,
      `Rollback: ${data.rollbackManifest}`,
      `Imports:  ${data.imported.adapters} adapters, ${data.imported.recipes} recipes (quarantined)`,
      `Recovery: ${data.recoveryArtifacts.inventoried} heartbeat/checkpoint artifacts inventoried, ${data.recoveryArtifacts.imported} imported`,
      "Legacy active run/state was not converted.",
      "Select an executor profile, then start the handoff explicitly:",
      `  ${data.handoff.command}`,
    ].join("\n"),
  })
}

async function handleClean(parsed: ParsedCli, context: CommandContext): Promise<HandledCommand> {
  const data = await cleanV2Workspace({
    root: workspaceStart(parsed, context),
    force: parsed.options.force,
    dryRun: parsed.options.dryRun,
  })
  return handled({
    result: commandResult("clean", data),
    human: data.removed
      ? `Removed Ralph v2 state only: ${data.statePath}\nFiles removed: ${data.files.length}\nRecovery: unavailable (PRD and project files were not touched).`
      : `Clean preview for ${data.statePath}\nFiles: ${data.files.length}\nNon-terminal runs: none\nRepeat with --force to remove only this v2 state directory.`,
  })
}

async function handleOperationalCatalog(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const workspaceRoot = workspaceStart(parsed, context)
  if (parsed.command === "rules.list") {
    const data = await listWorkspaceRules({ workspaceRoot })
    return handled({
      result: commandResult("rules.list", data),
      human:
        data.rules.length === 0
          ? `No workspace rules are configured (${data.path}).`
          : data.rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n"),
    })
  }
  if (parsed.command === "rules.add") {
    const data = await addWorkspaceRule({
      workspaceRoot,
      rule: parsed.arguments[0] as string,
    })
    return handled({
      result: commandResult("rules.add", data),
      human: `${data.changed ? "Added" : "Already present"}: ${data.rule}\nRules: ${data.count}\nFile:  ${data.path}`,
    })
  }
  if (parsed.command === "rules.clear") {
    const data = await clearWorkspaceRules({
      workspaceRoot,
      force: parsed.options.force,
    })
    return handled({
      result: commandResult("rules.clear", data),
      human: `Cleared ${data.cleared} workspace rules.\nFile retained as a human-readable empty rules document: ${data.path}`,
    })
  }

  const kind = parsed.command.startsWith("adapters.") ? "adapter" : "recipe"
  if (parsed.command.endsWith(".list")) {
    const entries = await listCatalogEntries({ workspaceRoot, kind })
    const data = { kind, count: entries.length, entries }
    return handled({
      result: commandResult(parsed.command, data),
      human:
        entries.length === 0
          ? `No ${kind} entries are present.`
          : entries
              .map(
                (entry) =>
                  `${entry.id.padEnd(28)} ${entry.status.padEnd(11)} ${entry.source}  ${entry.path}`,
              )
              .join("\n"),
    })
  }
  if (parsed.command.endsWith(".new")) {
    const data = await createCatalogEntry({
      workspaceRoot,
      kind,
      id: parsed.arguments[0] as string,
      force: parsed.options.force,
    })
    return handled({
      result: commandResult(parsed.command, data),
      human: [
        `${kind === "adapter" ? "Disabled adapter" : "Draft recipe"} created: ${data.id}`,
        `Path:       ${data.path}`,
        "Activation: manual only",
        `Overwrite:  ${data.overwritten ? "yes (--force)" : "no"}`,
      ].join("\n"),
    })
  }
  const data = await inspectCatalogEntry({
    workspaceRoot,
    kind,
    id: parsed.arguments[0] as string,
  })
  return handled({
    result: commandResult(parsed.command, data),
    human:
      kind === "recipe"
        ? `${data.entry.path}\nStatus: ${data.entry.status}\n\n${data.content ?? ""}`
        : [
            `Adapter: ${data.entry.id}`,
            `Status:  ${data.entry.status}`,
            `Source:  ${data.entry.source}`,
            `Path:    ${data.entry.path}`,
            `Hash:    ${data.entry.sha256}`,
            "Activation/execution: not performed",
            JSON.stringify(data.manifest ?? {}, null, 2),
          ].join("\n"),
  })
}

async function selectedOperationalRun(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<{
  workspaceRoot: string
  workspaceId: string
  run: NonNullable<ReturnType<typeof getRun>>
}> {
  const workspaceRoot = await canonicalDirectory(workspaceStart(parsed, context))
  const workspace = await inspectWorkspace(workspaceRoot, { exact: true })
  if (!workspace.initialized || !workspace.workspaceId) {
    throw new RalphError(
      "RALPH_OPERATIONAL_WORKSPACE_REQUIRED",
      "This command requires an initialized Ralph v2 workspace",
      { exitCode: EXIT_CODES.blocked },
    )
  }
  const layout = workspaceLayout(workspaceRoot)
  const run = parsed.options.runId
    ? getRun(layout.ledger, parsed.options.runId)
    : listRuns(layout.ledger, { workspaceId: workspace.workspaceId, limit: 1 })[0]
  if (!run || run.workspaceId !== workspace.workspaceId) {
    throw new RalphError(
      "RALPH_OPERATIONAL_RUN_NOT_FOUND",
      parsed.options.runId
        ? `Run was not found: ${parsed.options.runId}`
        : "No persisted run exists",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  return { workspaceRoot, workspaceId: workspace.workspaceId, run }
}

async function handleContextCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const limit = parsed.options.limit ?? 100
  if (parsed.command === "context.inspect") {
    const data = await inspectPersistedContext({
      workspaceRoot: workspaceStart(parsed, context),
      ...(parsed.options.runId ? { runId: parsed.options.runId } : {}),
      limit,
    })
    const contexts = data.contexts as readonly Record<string, unknown>[]
    const verified = contexts.filter((item) => item.integrity === "verified").length
    const run = data.run as Record<string, unknown>
    return handled({
      result: commandResult("context.inspect", data),
      human: [
        `Run:      ${String(run.id)} (${String(run.status)})`,
        `Contexts: ${contexts.length} (${verified} integrity-verified)`,
        `Attempts: ${String(data.attempts)}/${String(data.totalAttempts)}`,
        "Policy:   metadata-only; shared context, criteria, notes and resource bodies were not emitted",
        ...contexts.map(
          (item) =>
            `${String(item.attemptId)} call=${String(item.callOrdinal)} ${String(item.integrity)} ${String(item.expectedContextManifestHash)}`,
        ),
      ].join("\n"),
    })
  }
  if (parsed.command === "context.export") {
    const data = await exportPersistedContext({
      workspaceRoot: workspaceStart(parsed, context),
      ...(parsed.options.runId ? { runId: parsed.options.runId } : {}),
      limit,
      output: parsed.options.output as string,
      force: parsed.options.force,
    })
    return handled({
      result: commandResult("context.export", data),
      human: [
        `Context metadata exported: ${data.output}`,
        `Hash:      ${data.sha256}`,
        `Policy:    ${data.policy}; sensitive context bodies were not exported`,
        `Overwrite: ${data.overwritten ? "yes (--force)" : "no"}`,
      ].join("\n"),
    })
  }
  if (!context.contextControl) {
    throw new RalphError(
      "RALPH_CONTEXT_ROTATION_CONTROL_UNAVAILABLE",
      "Context rotation is unavailable because no supervisor control port is composed",
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Inspect the run context now; rotation becomes available only through the active supervisor, never by editing persisted files.",
      },
    )
  }
  const selected = await selectedOperationalRun(parsed, context)
  const reason = parsed.options.reason?.trim() || "Explicit command-authorized context rotation"
  if (reason.length > 500 || containsC0OrDeleteControl(reason)) {
    throw new RalphError(
      "RALPH_CONTEXT_ROTATION_REASON_INVALID",
      "Context rotation reason must be a bounded single-line value",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const data = await context.contextControl.rotate({
    workspaceRoot: selected.workspaceRoot,
    workspaceId: selected.workspaceId,
    runId: selected.run.id,
    reason,
    ...(context.signal ? { signal: context.signal } : {}),
  })
  return handled({
    result: commandResult("context.rotate", data),
    human: `Context rotation ${data.disposition} for ${data.runId}.\nBoundary: ${data.nextBoundary}\nRequested: ${data.requestedAt}`,
  })
}

async function handleCheckpointCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  if (parsed.command === "checkpoint.create") {
    const data = await createCheckpointCommand({
      workspaceRoot: workspaceStart(parsed, context),
      environment: context.environment,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(parsed.options.prd ? { prd: parsed.options.prd } : {}),
      ...(parsed.options.runId ? { runId: parsed.options.runId } : {}),
      ...(parsed.options.reason ? { reason: parsed.options.reason } : {}),
      paths: parsed.options.checkpointPaths,
      inventoryRoots: parsed.options.inventoryRoots,
    })
    return handled({
      result: commandResult("checkpoint.create", data),
      human: [
        `Checkpoint created: ${String(data.id)}`,
        `Manifest:           ${String(data.manifestHash)}`,
        `Files:              ${String(data.files)}`,
        `Git HEAD:           ${String(data.gitHead)}`,
      ].join("\n"),
    })
  }
  if (parsed.command === "checkpoint.list") {
    const data = await listOperationalCheckpoints({
      workspaceRoot: workspaceStart(parsed, context),
      ...(parsed.options.runId ? { runId: parsed.options.runId } : {}),
      limit: parsed.options.limit ?? 100,
    })
    return handled({
      result: commandResult("checkpoint.list", data),
      human:
        data.checkpoints.length === 0
          ? "No persisted checkpoints match this workspace/run."
          : data.checkpoints
              .map(
                (item) =>
                  `${String(item.id)}  ${String(item.status).padEnd(10)} files=${String(item.files)} ${String(item.createdAt)}${item.runId ? ` run=${String(item.runId)}` : ""}`,
              )
              .join("\n"),
    })
  }
  const data = await showOperationalCheckpoint({
    workspaceRoot: workspaceStart(parsed, context),
    checkpointId: parsed.arguments[0] as string,
  })
  return handled({
    result: commandResult("checkpoint.show", data),
    human: [
      `Checkpoint: ${String(data.id)}`,
      `Status:     ${String(data.status)}`,
      `Created:    ${String(data.createdAt)}`,
      `Reason:     ${String(data.reason)}`,
      `Files:      ${String(data.fileCount)} (${String(data.filesTruncated)} omitted from bounded preview)`,
      `Manifest:   ${String(data.manifestHash)}`,
      "Mutation:   none (show is read-only)",
    ].join("\n"),
  })
}

async function handleRollbackCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  if (parsed.command === "rollback.preview") {
    const data = await previewRollbackCommand({
      workspaceRoot: workspaceStart(parsed, context),
      environment: context.environment,
      ...(context.signal ? { signal: context.signal } : {}),
      checkpointId: parsed.arguments[0] as string,
      ...(parsed.options.prd ? { prd: parsed.options.prd } : {}),
      ...(parsed.options.rollbackExpires
        ? { expiresInMs: parsed.options.rollbackExpires * 1_000 }
        : {}),
    })
    return handled({
      result: commandResult("rollback.preview", data),
      human: [
        `Rollback plan: ${String(data.id)}`,
        `Checkpoint:    ${String(data.checkpointId)}`,
        `Operations:    ${String(data.operationCount)}`,
        `Conflicts:     ${String(data.conflictCount)}`,
        `Expires:       ${String(data.expiresAt)}`,
        `Plan hash:     ${String(data.planHash)}`,
        "Mutation:      none (preview only)",
        `Apply:         rollback apply ${String(data.id)} --confirm-plan-hash ${String(data.planHash)}`,
      ].join("\n"),
    })
  }
  const confirmationPlanHash = parsed.options.confirmationPlanHash
  if (!confirmationPlanHash) {
    throw new RalphError(
      "RALPH_ROLLBACK_CONFIRMATION_MISSING",
      "rollback apply requires the exact preview plan hash",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const data = await applyRollbackCommand({
    workspaceRoot: workspaceStart(parsed, context),
    environment: context.environment,
    ...(context.signal ? { signal: context.signal } : {}),
    rollbackPlanId: parsed.arguments[0] as string,
    confirmationPlanHash,
    ...(parsed.options.prd ? { prd: parsed.options.prd } : {}),
  })
  return handled({
    result: commandResult("rollback.apply", data),
    human: [
      `Rollback applied: ${String(data.rollbackPlanId)}`,
      `Checkpoint:       ${String(data.checkpointId)}`,
      `Safety checkpoint:${String(data.safetyCheckpointId)}`,
      "Mutation:         exact previewed operations applied",
    ].join("\n"),
  })
}

function supportedLocale(value: string): "en" | "pt-BR" {
  const normalized = value.trim().toLocaleLowerCase("en")
  if (normalized === "en" || normalized === "en-us" || normalized === "en_us") return "en"
  if (
    normalized === "pt" ||
    normalized === "pt-br" ||
    normalized === "pt_br" ||
    normalized === "portuguese"
  ) {
    return "pt-BR"
  }
  throw new RalphError("RALPH_LANG_UNSUPPORTED", `Unsupported bundled locale: ${value}`, {
    exitCode: EXIT_CODES.invalidUsage,
    hint: "Use en or pt-BR. Language catalogs are bundled with releases.",
  })
}

async function handleLangCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const locales = [
    { id: "en", label: "English", aliases: ["en-US"] },
    { id: "pt-BR", label: "Português (Brasil)", aliases: ["pt", "pt_BR"] },
  ] as const
  if (parsed.command === "lang.list") {
    const data = { locales, update: "release-managed" as const }
    return handled({
      result: commandResult("lang.list", data),
      human: locales.map((locale) => `${locale.id.padEnd(8)} ${locale.label}`).join("\n"),
    })
  }
  if (parsed.command === "lang.update") {
    const data = {
      changed: false,
      update: "release-managed" as const,
      locales,
      owner: "install/update release artifacts",
    }
    return handled({
      result: commandResult("lang.update", data),
      human:
        "Language catalogs are release-managed; S12 must compose verified artifacts before updates are enabled. No network or file mutation was performed.",
    })
  }
  if (parsed.command === "lang.set") {
    const locale = supportedLocale(parsed.arguments[0] as string)
    const scope = parsed.options.scope
    if (scope !== "workspace" && scope !== "global") {
      throw new RalphError("RALPH_LANG_SCOPE_INVALID", `Invalid language scope: ${scope}`, {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Use --scope workspace or --scope global.",
      })
    }
    const draft = updateSettingsDraft(createSettingsDraft("pre-run"), "language", locale)
    let workspaceRoot: string | undefined
    if (scope === "workspace") {
      const candidate = parsed.options.workspace
        ? workspaceStart(parsed, context)
        : await findWorkspaceRoot(workspaceStart(parsed, context))
      if (!candidate) {
        throw new RalphError(
          "RALPH_LANG_WORKSPACE_REQUIRED",
          "No initialized workspace was found for language scope workspace",
          { exitCode: EXIT_CODES.invalidUsage },
        )
      }
      const status = await inspectWorkspace(candidate, { exact: true })
      if (!status.initialized) {
        throw new RalphError(
          "RALPH_LANG_WORKSPACE_REQUIRED",
          "Language workspace defaults require an initialized Ralph v2 workspace",
          { exitCode: EXIT_CODES.invalidUsage, file: candidate },
        )
      }
      workspaceRoot = status.root
    }
    const mutation = await saveSettingsDefaults({
      draft,
      scope,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      environment: context.environment,
    })
    const data = { locale, scope, mutation, affects: "future-runs" as const }
    return handled({
      result: commandResult("lang.set", data),
      human: `Saved locale ${locale}.\nScope: ${scope}\nFile:  ${mutation.path}\nEffect: future human/TUI presentation; persisted runs were not modified.`,
    })
  }
  const start = workspaceStart(parsed, context)
  const configPath = await workspaceConfigPath(start, parsed.options.workspace !== undefined)
  const effective = await loadEffectiveConfig({
    ...(configPath ? { workspaceConfig: configPath } : {}),
    environment: context.environment,
  })
  const value = effectiveValue(effective, "defaults.lang")
  const configured = effective.config.defaults.lang
  const presentation = configured.trim().toLocaleLowerCase("en").startsWith("pt") ? "pt-BR" : "en"
  const data = {
    configured,
    presentation,
    source: value?.source ?? "builtin",
    ...(value?.sourceRef ? { sourceRef: value.sourceRef } : {}),
    bundled: configured === "en" || configured === "pt-BR",
  }
  return handled({
    result: commandResult("lang.current", data),
    human: `Configured:   ${configured}\nPresentation: ${presentation}\nSource:       ${data.source}${data.sourceRef ? ` (${data.sourceRef})` : ""}`,
  })
}

function releaseManifestOrigin(parsed: ParsedCli, context: CommandContext) {
  const manifest = parsed.options.releaseManifest
  if (!manifest) return undefined
  const normalized = /^https:\/\//iu.test(manifest) ? manifest : resolve(context.cwd, manifest)
  return installOriginFromManifest(normalized)
}

function distributionInstallRoot(parsed: ParsedCli, context: CommandContext): string {
  const positional =
    parsed.command === "install" || parsed.command === "uninstall" ? parsed.arguments[0] : undefined
  if (positional && parsed.options.installRoot) {
    throw new RalphError(
      "RALPH_INSTALL_ROOT_DUPLICATED",
      "Install root was provided both positionally and with --install-root",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const requested =
    parsed.options.installRoot ??
    positional ??
    context.environment.RALPH_INSTALL_ROOT ??
    context.environment.RALPH_STANDALONE_INSTALL_ROOT
  if (!requested) {
    throw new RalphError(
      "RALPH_INSTALL_ROOT_REQUIRED",
      "A standalone install root is required for this command",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Use --install-root <dedicated-directory>; install and uninstall also accept it positionally. An installed launcher supplies its own root automatically.",
      },
    )
  }
  return resolve(context.cwd, requested)
}

function hasRequestedDistributionInstallRoot(parsed: ParsedCli, context: CommandContext): boolean {
  return Boolean(
    parsed.options.installRoot ??
      context.environment.RALPH_INSTALL_ROOT ??
      context.environment.RALPH_STANDALONE_INSTALL_ROOT,
  )
}

function distributionHuman(data: {
  action: string
  installRoot: string
  mutationPerformed: boolean
  runningBinaryReplaced: boolean
  currentVersion?: string
  previousVersion?: string
  requestedVersion?: string
  channel?: string
  available?: boolean
  preserved?: readonly string[]
  cleanupDisposition?: "scheduled" | "completed"
  cleanupHelperPath?: string
  cleanupRequestPath?: string
}): string {
  return [
    `Action:       ${data.action}`,
    `Install root: ${data.installRoot}`,
    ...(data.previousVersion ? [`Previous:     ${data.previousVersion}`] : []),
    ...(data.currentVersion ? [`Current:      ${data.currentVersion}`] : []),
    ...(data.requestedVersion ? [`Requested:    ${data.requestedVersion}`] : []),
    ...(data.channel ? [`Channel:      ${data.channel}`] : []),
    ...(data.available !== undefined
      ? [`Update:       ${data.available ? "available" : "current"}`]
      : []),
    `Mutation:     ${data.mutationPerformed ? "performed" : "none"}`,
    `Running file: ${data.runningBinaryReplaced ? "replaced" : "not replaced"}`,
    ...(data.cleanupDisposition ? [`Cleanup:      ${data.cleanupDisposition}`] : []),
    ...(data.cleanupHelperPath ? [`Helper:       ${data.cleanupHelperPath}`] : []),
    ...(data.cleanupRequestPath ? [`Recovery:     ${data.cleanupRequestPath}`] : []),
    ...(data.preserved ? [`Preserved:    ${data.preserved.join(", ")}`] : []),
  ].join("\n")
}

async function handleDistributionCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const origin = releaseManifestOrigin(parsed, context)
  if (
    parsed.command === "update" &&
    !origin &&
    !hasRequestedDistributionInstallRoot(parsed, context) &&
    context.distributionOrigin
  ) {
    rejectUnmanagedInstallOrigin(context.distributionOrigin)
  }
  const installRoot = distributionInstallRoot(parsed, context)
  const requiresReleaseVerification =
    (parsed.command === "install" || parsed.command === "update") &&
    (!parsed.options.dryRun || parsed.options.check)
  const distributionSignature = requiresReleaseVerification
    ? (context.distributionSignature ?? (await context.resolveDistributionSignature?.()))
    : undefined
  const common = {
    installRoot,
    ...(parsed.options.releaseChannel ? { expectedChannel: parsed.options.releaseChannel } : {}),
    ...(parsed.options.releaseVersion ? { expectedVersion: parsed.options.releaseVersion } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(distributionSignature
      ? {
          signatureVerifier: distributionSignature.verifier,
          signatureTrustPolicy: distributionSignature.trustPolicy,
        }
      : {}),
    dryRun: parsed.options.dryRun,
  }
  const distribution = context.distributionCommands
  const data =
    parsed.command === "install"
      ? await (distribution?.install ?? installStandalone)({
          ...common,
          origin:
            origin ??
            (() => {
              throw new RalphError(
                "RALPH_RELEASE_MANIFEST_REQUIRED",
                "install requires --manifest <local-release-manifest|https-url>",
                { exitCode: EXIT_CODES.invalidUsage },
              )
            })(),
        })
      : parsed.command === "update"
        ? await (distribution?.update ?? updateStandalone)({
            ...common,
            ...(origin ? { origin } : {}),
            allowDowngrade: parsed.options.allowDowngrade,
            checkOnly: parsed.options.check,
          })
        : parsed.command === "install.rollback"
          ? await (distribution?.rollback ?? rollbackStandalone)({
              installRoot,
              ...(parsed.options.releaseVersion ? { version: parsed.options.releaseVersion } : {}),
              ...(context.signal ? { signal: context.signal } : {}),
              dryRun: parsed.options.dryRun,
            })
          : await (distribution?.uninstall ?? uninstallStandalone)({
              installRoot,
              ...(context.signal ? { signal: context.signal } : {}),
              ...(context.distributionUninstall
                ? {
                    deferredCleanup: context.distributionUninstall.deferredCleanup,
                    ...(context.distributionUninstall.waitForPids
                      ? { waitForPids: context.distributionUninstall.waitForPids }
                      : {}),
                  }
                : {}),
              dryRun: parsed.options.dryRun,
            })
  const command = parsed.command === "install.rollback" ? "rollback" : parsed.command
  return handled({
    result: commandResult(command, data),
    human: distributionHuman(data),
  })
}

async function handleConfig(parsed: ParsedCli, context: CommandContext): Promise<HandledCommand> {
  const start = workspaceStart(parsed, context)

  const initializedWorkspaceRoot = async (required: boolean): Promise<string | undefined> => {
    const candidate = parsed.options.workspace ? start : await findWorkspaceRoot(start)
    if (!candidate) {
      if (!required) return undefined
      throw new RalphError(
        "RALPH_SETTINGS_WORKSPACE_REQUIRED",
        "The selected config operation requires an initialized Ralph v2 workspace",
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: "Run `ralph init`, pass --workspace, or select --scope global.",
        },
      )
    }
    const status = await inspectWorkspace(candidate, { exact: true })
    if (!status.initialized) {
      if (!required && !parsed.options.workspace) return undefined
      throw new RalphError(
        "RALPH_SETTINGS_WORKSPACE_REQUIRED",
        "The selected directory is not an initialized Ralph v2 workspace",
        {
          exitCode: EXIT_CODES.invalidUsage,
          file: candidate,
          hint: "Run `ralph init` before using workspace configuration.",
        },
      )
    }
    return status.root
  }

  if (parsed.command === "config.unset") {
    const field = settingsField(parsed.arguments[0] as string)
    if (!field.configPath || field.secret || field.target === "run-only") {
      throw new RalphError(
        "RALPH_CONFIG_UNSET_FIELD_FORBIDDEN",
        "config unset accepts only schema-known, non-secret, non-profile persisted settings",
        {
          exitCode: EXIT_CODES.policyDenied,
          details: { field: field.id, configPath: field.configPath ?? null },
        },
      )
    }
    const scope = parsed.options.scope as "workspace" | "global"
    const workspaceRoot =
      scope === "workspace"
        ? await initializedWorkspaceRoot(true)
        : await initializedWorkspaceRoot(false)
    const mutation = await mutateConfigTransfer({
      mode: "unset",
      scope,
      unsetPath: field.configPath.split("."),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      environment: context.environment,
      dryRun: parsed.options.dryRun,
    })
    const data = { field, mutation }
    return handled({
      result: commandResult("config.unset", data),
      human: [
        `${parsed.options.dryRun ? "Preview" : mutation.applied ? "Removed" : "No change"}: ${field.configPath}`,
        `Scope: ${scope}`,
        `File:  ${mutation.path}`,
        `Changes: ${mutation.changes.length}`,
        ...mutation.changes.map((change) => `  ${change.operation.padEnd(7)} ${change.path}`),
        "Effect: future runs only; persisted run snapshots were not modified.",
      ].join("\n"),
    })
  }

  if (parsed.command === "config.import") {
    const scope = parsed.options.scope as "workspace" | "global"
    const workspaceRoot =
      scope === "workspace"
        ? await initializedWorkspaceRoot(true)
        : await initializedWorkspaceRoot(false)
    const input = await readConfigTransferInput(parsed.arguments[0] as string, context.cwd)
    const mutation = await mutateConfigTransfer({
      mode: "merge",
      scope,
      candidate: input.value,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      environment: context.environment,
      dryRun: parsed.options.dryRun,
    })
    const data = {
      input: { path: input.path, bytes: input.bytes, sha256: input.sha256 },
      policy: "schema-known-merge-no-secret-material" as const,
      mutation,
    }
    return handled({
      result: commandResult("config.import", data),
      human: [
        `${parsed.options.dryRun ? "Import preview" : mutation.applied ? "Imported" : "No change"}: ${input.path}`,
        `Scope:   ${scope}`,
        `Target:  ${mutation.path}`,
        `Changes: ${mutation.changes.length}`,
        ...mutation.changes.map((change) => `  ${change.operation.padEnd(7)} ${change.path}`),
        "Policy: schema-known config and typed profiles only; extensions and secret material are rejected.",
        "Effect: future runs only; persisted run snapshots were not modified.",
      ].join("\n"),
    })
  }

  if (parsed.command === "config.edit") {
    const scope = parsed.options.scope as "workspace" | "global"
    const workspaceRoot =
      scope === "workspace"
        ? await initializedWorkspaceRoot(true)
        : await initializedWorkspaceRoot(false)
    const editable = await editableConfigDocument({
      scope,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      environment: context.environment,
    })
    let candidate: unknown
    let source: { kind: "input" | "editor"; path: string; sha256?: string }
    const inputPath = parsed.arguments[0]
    if (inputPath) {
      const input = await readConfigTransferInput(inputPath, context.cwd)
      candidate = input.value
      source = { kind: "input", path: input.path, sha256: input.sha256 }
    } else {
      if (parsed.options.nonInteractive || context.interactive !== true) {
        throw new RalphError(
          "RALPH_CONFIG_EDITOR_INTERACTION_REQUIRED",
          "config edit without an input file requires an interactive terminal",
          {
            exitCode: EXIT_CODES.invalidUsage,
            hint: "Use `config edit <file> --scope ... --non-interactive` or `config import <file> --scope ...`.",
          },
        )
      }
      if (!context.configEditor) {
        throw new RalphError(
          "RALPH_CONFIG_EDITOR_UNAVAILABLE",
          "No safe config editor is composed for this executable",
          {
            exitCode: EXIT_CODES.blocked,
            hint: "Set RALPH_CONFIG_EDITOR to one trusted executable path or use the explicit input-file form.",
          },
        )
      }
      const response = await context.configEditor.edit({
        scope,
        path: editable.path,
        serialization: "yaml",
        document: editable.document,
        ...(context.signal ? { signal: context.signal } : {}),
      })
      if (response.status === "cancelled") {
        throw new RalphError("RALPH_CONFIG_EDIT_CANCELLED", "Configuration edit was cancelled", {
          exitCode: EXIT_CODES.interrupted,
          file: editable.path,
        })
      }
      candidate = parseEditedConfigDocument(response.document, editable.path)
      source = { kind: "editor", path: editable.path }
    }
    const mutation = await mutateConfigTransfer({
      mode: "replace-managed",
      scope,
      candidate,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      environment: context.environment,
      dryRun: parsed.options.dryRun,
      expectedTargetSha256: editable.expectedTargetSha256,
    })
    const data = { source, policy: "validated-core-replacement" as const, mutation }
    return handled({
      result: commandResult("config.edit", data),
      human: [
        `${parsed.options.dryRun ? "Edit preview" : mutation.applied ? "Configuration updated" : "No change"}`,
        `Scope:   ${scope}`,
        `Source:  ${source.kind} (${source.path})`,
        `Target:  ${mutation.path}`,
        `Changes: ${mutation.changes.length}`,
        ...mutation.changes.map((change) => `  ${change.operation.padEnd(7)} ${change.path}`),
        "Effect: future runs only; persisted run snapshots were not modified.",
      ].join("\n"),
    })
  }

  if (parsed.command === "config.export") {
    const scope = parsed.options.scope as "workspace" | "global" | "effective"
    const workspaceRoot =
      scope === "workspace"
        ? await initializedWorkspaceRoot(true)
        : scope === "effective" || parsed.options.workspace !== undefined
          ? await initializedWorkspaceRoot(false)
          : undefined
    const outputBase = workspaceRoot ?? (await canonicalDirectory(start))
    const exported = await exportConfigTransfer({
      scope,
      serialization: parsed.options.serialization ?? "yaml",
      ...(workspaceRoot ? { workspaceRoot } : {}),
      environment: context.environment,
      outputBase,
      ...(parsed.options.output ? { output: parsed.options.output } : {}),
      force: parsed.options.force,
    })
    return handled({
      result: commandResult("config.export", exported),
      human:
        exported.output === null
          ? exported.document
          : [
              `Exported redacted ${exported.scope} configuration.`,
              `Serialization: ${exported.serialization}`,
              `Output:        ${exported.output}`,
              `SHA-256:       ${exported.sha256}`,
              `Bytes:         ${exported.bytes}`,
              "Policy: credential values were not resolved or copied.",
            ].join("\n"),
    })
  }

  const configPath = await workspaceConfigPath(start, parsed.options.workspace !== undefined)
  const effective = await loadEffectiveConfig({
    ...(configPath ? { workspaceConfig: configPath } : {}),
    environment: context.environment,
    cli: {
      ...(parsed.options.mode ? { mode: parsed.options.mode } : {}),
      ...(parsed.options.ui ? { ui: parsed.options.ui } : {}),
      ...(parsed.options.lang ? { lang: parsed.options.lang } : {}),
    },
  })

  if (parsed.command === "config.get") {
    const key = parsed.arguments[0] as string
    const knownField = SETTINGS_COMMAND_FIELDS.find(
      (field) => field.id === key || field.configPath === key,
    )
    const effectiveKey = knownField?.configPath ?? key
    const value = effectiveValue(effective, effectiveKey)
    if (!value && !knownField) {
      throw new RalphError("RALPH_CONFIG_KEY_UNKNOWN", `Unknown configuration key: ${key}`, {
        exitCode: EXIT_CODES.invalidUsage,
      })
    }
    const setting = knownField ? explainSettingsField(key, effective) : undefined
    const data = {
      key: effectiveKey,
      value: value?.value ?? setting?.value ?? null,
      source: value?.source ?? setting?.source ?? "unavailable",
      ...(value?.sourceRef ? { sourceRef: value.sourceRef } : {}),
      secret: knownField?.secret ?? false,
    }
    return handled({
      result: commandResult("config.get", data),
      human: data.secret ? "<secret-reference>" : valueText(data.value),
    })
  }

  if (parsed.command === "config.validate") {
    const data = {
      valid: true,
      workspaceConfig: configPath ?? null,
      globalConfig: globalConfigPath(context.environment),
      effectiveSchemaVersion: effective.config.schema_version,
      sourceCount: Object.keys(effective.values).length,
    }
    return handled({
      result: commandResult("config.validate", data),
      human: [
        "Configuration is valid.",
        `Global:    ${data.globalConfig}`,
        `Workspace: ${data.workspaceConfig ?? "not selected"}`,
        `Schema:    ${data.effectiveSchemaVersion}`,
      ].join("\n"),
    })
  }

  if (parsed.command === "config.explain") {
    const key = parsed.arguments[0] as string
    const knownField = SETTINGS_COMMAND_FIELDS.find(
      (field) => field.id === key || field.configPath === key,
    )
    const effectiveKey = knownField?.configPath ?? key
    const value = effectiveValue(effective, effectiveKey)
    if (!value && !knownField) {
      throw new RalphError("RALPH_CONFIG_KEY_UNKNOWN", `Unknown configuration key: ${key}`, {
        exitCode: EXIT_CODES.invalidUsage,
      })
    }
    const setting = knownField ? explainSettingsField(key, effective) : undefined
    const data = {
      key: effectiveKey,
      ...(value
        ? value
        : { value: setting?.value ?? null, source: setting?.source ?? "unavailable" }),
      ...(setting ? { setting } : {}),
    }
    return handled({
      result: commandResult("config.explain", data),
      human: [
        `${effectiveKey} = ${valueText(value?.value ?? setting?.value ?? null)}`,
        `Source: ${value?.source ?? setting?.source ?? "unavailable"}${value?.sourceRef ? ` (${value.sourceRef})` : setting?.sourceRef ? ` (${setting.sourceRef})` : ""}`,
        ...(setting
          ? [
              `Field:  ${setting.field.label} (${setting.field.id})`,
              `Impact: ${setting.field.impact}`,
              `Config: ${setting.field.configPath ?? "run-only"}`,
              `CLI:    ${setting.field.target === "config-only" ? `config set ${setting.field.configPath ?? setting.field.id} <value> --scope <workspace|global>` : setting.field.cliFlag}`,
            ]
          : []),
      ].join("\n"),
    })
  }

  if (parsed.command === "config.preview" || parsed.command === "config.set") {
    const identifier = parsed.arguments[0] as string
    const field = settingsField(identifier)
    const value = decodeSettingsValue(field, parsed.arguments[1] as string)
    const scope = parsed.options.scope ?? "workspace"
    if (scope !== "workspace" && scope !== "global") {
      throw new RalphError("RALPH_SETTINGS_SCOPE_INVALID", `Invalid settings scope: ${scope}`, {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Use --scope workspace or --scope global.",
      })
    }
    const draft = updateSettingsDraft(createSettingsDraft("pre-run"), field.id, value)
    const preview = previewSettingsDraft(draft, scope)
    if (parsed.command === "config.preview") {
      const data = { field, draft, preview }
      return handled({
        result: commandResult("config.preview", data),
        human: [
          `${field.label}: ${valueText(value)}`,
          `Target: ${field.target}`,
          `Scope:  ${scope}`,
          ...(preview.configCommands.length > 0
            ? [`Config: ${preview.configCommands.join("\n        ")}`]
            : ["Config: unavailable for this run-only field"]),
          `Run:    ${preview.runCommand}`,
          ...(preview.applyForRunUnavailableReason
            ? [`Apply:  unavailable (${preview.applyForRunUnavailableReason})`]
            : ["Apply:  available before the run is persisted"]),
        ].join("\n"),
      })
    }

    if (!parsed.options.scope) {
      throw new RalphError(
        "RALPH_SETTINGS_SCOPE_REQUIRED",
        "config set requires an explicit --scope workspace|global",
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: "Use config preview first, then select --scope workspace or --scope global.",
        },
      )
    }
    let workspaceRoot: string | undefined
    if (scope === "workspace") {
      const candidate = parsed.options.workspace
        ? workspaceStart(parsed, context)
        : await findWorkspaceRoot(workspaceStart(parsed, context))
      if (!candidate) {
        throw new RalphError(
          "RALPH_SETTINGS_WORKSPACE_REQUIRED",
          "No initialized Ralph v2 workspace was found for the workspace settings scope",
          {
            exitCode: EXIT_CODES.invalidUsage,
            hint: "Run `ralph init` or select --scope global.",
          },
        )
      }
      const status = await inspectWorkspace(candidate, { exact: true })
      if (!status.initialized) {
        throw new RalphError(
          "RALPH_SETTINGS_WORKSPACE_REQUIRED",
          "Workspace defaults can only be saved to an initialized Ralph v2 workspace",
          {
            exitCode: EXIT_CODES.invalidUsage,
            file: candidate,
            hint: "Run `ralph init` before saving workspace defaults.",
          },
        )
      }
      workspaceRoot = status.root
    }
    const mutation = await saveSettingsDefaults({
      draft,
      scope,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      environment: context.environment,
    })
    const data = { field, draft, preview, mutation, affects: "future-runs" as const }
    return handled({
      result: commandResult("config.set", data),
      human: [
        `Saved ${field.configPath ?? field.id} = ${valueText(value)}`,
        `Scope: ${mutation.scope}`,
        `File:  ${mutation.path}`,
        "Effect: future runs only; persisted run snapshots were not modified.",
      ].join("\n"),
    })
  }

  const data = {
    effective: true,
    config: effective.config,
    sources: effective.values,
    settings: listSettingsFields(effective),
  }
  return handled({
    result: commandResult("config.list", data),
    human: `${JSON.stringify(effective.config, null, 2)}\n\nUse \`config explain <key>\` to inspect value origin.`,
  })
}

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function isInside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function prdInput(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<{
  base: string
  path: string
  file: string
}> {
  const base = await canonicalDirectory(workspaceStart(parsed, context))
  const path = resolve(base, parsed.arguments[0] ?? "PRD.md")
  if (!isInside(base, path)) {
    throw new RalphError("RALPH_PRD_PATH_OUTSIDE_WORKSPACE", "PRD path is outside the workspace", {
      exitCode: EXIT_CODES.invalidUsage,
      file: portable(parsed.arguments[0] ?? "PRD.md"),
    })
  }
  const file = portable(relative(base, path)) || basename(path)
  try {
    const canonicalInput = await realpath(path)
    if (!isInside(base, canonicalInput)) {
      throw new RalphError(
        "RALPH_PRD_PATH_OUTSIDE_WORKSPACE",
        "PRD resolves outside the canonical workspace",
        {
          exitCode: EXIT_CODES.policyDenied,
          file,
        },
      )
    }
  } catch (error) {
    if (error instanceof RalphError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new RalphError("RALPH_PRD_PATH_INSPECTION_FAILED", "Could not inspect PRD path", {
        exitCode: EXIT_CODES.policyDenied,
        file,
        cause: error,
      })
    }
  }
  return { base, path, file }
}

function strictDiagnostics(diagnostics: readonly Diagnostic[], strict: boolean): Diagnostic[] {
  const output = [...diagnostics]
  if (
    strict &&
    !output.some((diagnostic) => diagnostic.severity === "error") &&
    output.some((diagnostic) => diagnostic.severity === "warning")
  ) {
    output.push({
      code: "RALPH_PRD_STRICT_REJECTED",
      severity: "error",
      message: "Strict PRD validation rejects noncanonical warnings",
      hint: "Resolve the warnings or run without --strict for compatibility inspection.",
    })
  }
  return output
}

function handledPrd<T>(
  command: string,
  data: T,
  diagnostics: Diagnostic[],
  successHuman: string,
): HandledCommand<T> {
  const failed = diagnostics.some((diagnostic) => diagnostic.severity === "error")
  return handled(
    {
      result: commandResult(command, data, diagnostics),
      ...(failed ? {} : { human: successHuman }),
    },
    failed ? EXIT_CODES.invalidPrd : EXIT_CODES.success,
  )
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function outputPath(base: string, value: string): string {
  const path = resolve(base, value)
  if (!isInside(base, path)) {
    throw new RalphError(
      "RALPH_PRD_OUTPUT_OUTSIDE_WORKSPACE",
      "Output path is outside the workspace",
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: portable(value),
      },
    )
  }
  return path
}

async function assertSafePrdOutput(base: string, target: string): Promise<void> {
  let probe = target
  while (true) {
    try {
      const info = await lstat(probe)
      const canonical = await realpath(probe)
      if (info.isSymbolicLink() || !isInside(base, canonical)) {
        throw new RalphError(
          "RALPH_PRD_OUTPUT_PATH_UNSAFE",
          "PRD output resolves through a linked path or outside the workspace",
          {
            exitCode: EXIT_CODES.policyDenied,
            file: portable(relative(base, target)),
          },
        )
      }
      return
    } catch (error) {
      if (error instanceof RalphError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new RalphError(
          "RALPH_PRD_OUTPUT_PATH_INSPECTION_FAILED",
          "Could not inspect PRD output path",
          {
            exitCode: EXIT_CODES.policyDenied,
            file: portable(relative(base, target)),
            cause: error,
          },
        )
      }
      const parent = dirname(probe)
      if (parent === probe) {
        throw new RalphError(
          "RALPH_PRD_OUTPUT_PATH_UNSAFE",
          "Could not find a contained existing ancestor for PRD output",
          {
            exitCode: EXIT_CODES.policyDenied,
            file: portable(relative(base, target)),
          },
        )
      }
      probe = parent
    }
  }
}

function defaultMigrationOutput(source: string): string {
  const parsed = parsePath(source)
  return resolve(parsed.dir, `${parsed.name}.v2${parsed.ext || ".md"}`)
}

async function handlePrd(parsed: ParsedCli, context: CommandContext): Promise<HandledCommand> {
  const input = await prdInput(parsed, context)
  const detection = await detectPrdFile(input.path, input.file)

  if (parsed.command === "prd.validate" || parsed.command === "prd.inspect") {
    if (detection.format === "v2") {
      const compiled = await compilePrdGraph(input.path, {
        workspaceRoot: input.base,
        recursive: parsed.options.recursive,
        strict: parsed.options.strict,
      })
      const diagnostics = strictDiagnostics(compiled.diagnostics, parsed.options.strict)
      if (parsed.command === "prd.inspect") {
        return handledPrd(
          "prd.inspect",
          compiled.graph ?? null,
          diagnostics,
          compiled.graph
            ? `PRD graph ${compiled.graph.rootDocumentId}: ${Object.keys(compiled.graph.documents).length} documents, ${compiled.graph.topologicalOrder.length} tasks\nGraph hash: ${compiled.graph.graphHash}`
            : "",
        )
      }
      const graph = compiled.graph
      const data = {
        format: "v2",
        recursive: parsed.options.recursive,
        strict: parsed.options.strict,
        documentCount: graph ? Object.keys(graph.documents).length : 0,
        taskCount: graph?.topologicalOrder.length ?? 0,
        graphHash: graph?.graphHash,
      }
      return handledPrd(
        "prd.validate",
        data,
        diagnostics,
        graph
          ? `Valid PRD v2 graph: ${data.documentCount} documents, ${data.taskCount} vertical slices\nGraph hash: ${graph.graphHash}`
          : "",
      )
    }
    if (detection.format === "classic") {
      const classic = await parseClassicPrdFile(input.path, input.file)
      const compatibilityDiagnostics = [
        ...classic.diagnostics,
        ...(parsed.options.recursive
          ? [
              {
                code: "RALPH_PRD_CLASSIC_RECURSIVE_UNAVAILABLE",
                severity: "warning" as const,
                message: "Classic PRDs have no strong recursive Sub-PRD graph",
                file: input.file,
                hint: "Migrate to PRD v2 before using recursive child validation.",
              },
            ]
          : []),
      ]
      const diagnostics = strictDiagnostics(compatibilityDiagnostics, parsed.options.strict)
      if (parsed.command === "prd.inspect") {
        return handledPrd(
          "prd.inspect",
          classic.document ?? null,
          diagnostics,
          classic.document
            ? `Classic PRD compatibility document: ${classic.document.tasks.length} tasks\nRun \`ralph prd migrate ${input.file}\` for a v2 conversion report.`
            : "",
        )
      }
      const data = {
        format: "classic",
        compatibilityMode: true,
        recursive: false,
        strict: parsed.options.strict,
        taskCount: classic.document?.tasks.length ?? 0,
        contentHash: classic.document?.contentHash,
      }
      return handledPrd(
        "prd.validate",
        data,
        diagnostics,
        classic.document
          ? `Valid classic PRD in compatibility mode: ${classic.document.tasks.length} tasks`
          : "",
      )
    }
    return handledPrd(parsed.command, null, detection.diagnostics, "")
  }

  if (parsed.command === "prd.format") {
    if (detection.format !== "v2") {
      const diagnostics = [
        ...detection.diagnostics,
        {
          code: "RALPH_PRD_FORMAT_REQUIRES_V2",
          severity: "error" as const,
          message: "Canonical formatting only accepts PRD v2",
          file: input.file,
          hint: "Use `prd migrate` to convert a classic PRD explicitly.",
        },
      ]
      return handledPrd("prd.format", null, diagnostics, "")
    }
    const original = await readFile(input.path, "utf8")
    const formatted = formatPrdSource(original, { file: input.file })
    if (!formatted.ok || formatted.source === undefined) {
      return handledPrd("prd.format", null, formatted.diagnostics, "")
    }
    const formatDiagnostics = strictDiagnostics(formatted.diagnostics, parsed.options.strict)
    if (formatDiagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return handledPrd("prd.format", null, formatDiagnostics, "")
    }
    if (parsed.options.check) {
      const diagnostics = formatted.changed
        ? [
            ...formatDiagnostics,
            {
              code: "RALPH_PRD_FORMAT_REQUIRED",
              severity: "error" as const,
              message: "PRD task grammar is valid but not in canonical form",
              file: input.file,
              hint: "Run `ralph prd format <file> --in-place` or use --output.",
            },
          ]
        : formatDiagnostics
      return handledPrd(
        "prd.format",
        { file: input.file, changed: formatted.changed ?? false, checked: true },
        diagnostics,
        `PRD is already canonical: ${input.file}`,
      )
    }
    if (parsed.options.inPlace || parsed.options.output) {
      const target = parsed.options.inPlace
        ? input.path
        : outputPath(input.base, parsed.options.output ?? "")
      if (!parsed.options.inPlace && target === input.path) {
        throw new RalphError(
          "RALPH_PRD_OUTPUT_EQUALS_INPUT",
          "Refusing to overwrite the input through --output",
          {
            exitCode: EXIT_CODES.invalidUsage,
            file: input.file,
            hint: "Use --in-place when replacing the source is intentional.",
          },
        )
      }
      await assertSafePrdOutput(input.base, target)
      if (target !== input.path && (await fileExists(target)) && !parsed.options.force) {
        throw new RalphError("RALPH_PRD_OUTPUT_EXISTS", "Refusing to overwrite PRD output", {
          exitCode: EXIT_CODES.conflict,
          file: portable(relative(input.base, target)),
          hint: "Choose another --output path or pass --force explicitly.",
        })
      }
      const sourceMode = (await stat(input.path)).mode & 0o777
      await writeFileAtomic(target, formatted.source, {
        overwrite: target === input.path || parsed.options.force,
        mode: sourceMode,
      })
      const targetFile = portable(relative(input.base, target))
      return handledPrd(
        "prd.format",
        { file: targetFile, changed: formatted.changed ?? false, written: true },
        formatDiagnostics,
        `Canonical PRD written to ${targetFile}`,
      )
    }
    return handledPrd(
      "prd.format",
      { file: input.file, changed: formatted.changed ?? false, source: formatted.source },
      formatDiagnostics,
      formatted.source,
    )
  }

  if (detection.format !== "classic") {
    const diagnostics = [
      ...detection.diagnostics,
      {
        code: "RALPH_PRD_MIGRATE_REQUIRES_CLASSIC",
        severity: "error" as const,
        message:
          detection.format === "v2"
            ? "PRD is already version 2"
            : "Input is not a recognized classic PRD",
        file: input.file,
      },
    ]
    return handledPrd("prd.migrate", null, diagnostics, "")
  }
  const target = parsed.options.inPlace
    ? input.path
    : parsed.options.output
      ? outputPath(input.base, parsed.options.output)
      : defaultMigrationOutput(input.path)
  const targetFile = portable(relative(input.base, target))
  const reportPath = parsed.options.report
    ? outputPath(input.base, parsed.options.report)
    : resolve(dirname(target), `${basename(target)}.migration.json`)
  if (!parsed.options.inPlace && target === input.path) {
    throw new RalphError(
      "RALPH_PRD_OUTPUT_EQUALS_INPUT",
      "Refusing to overwrite the classic PRD through --output",
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: input.file,
        hint: "Use --in-place to request a backed-up source replacement.",
      },
    )
  }
  if (reportPath === input.path || reportPath === target) {
    throw new RalphError(
      "RALPH_PRD_REPORT_PATH_COLLISION",
      "Migration report must use a path distinct from both input and output",
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: portable(relative(input.base, reportPath)),
      },
    )
  }
  await assertSafePrdOutput(input.base, target)
  await assertSafePrdOutput(input.base, reportPath)
  const reportFile = portable(relative(input.base, reportPath))
  const migration = await migrateClassicFile(input.path, {
    sourceFile: input.file,
    outputFile: targetFile,
  })
  if (!migration.ok || !migration.markdown || !migration.report) {
    return handledPrd("prd.migrate", migration.report ?? null, migration.diagnostics, "")
  }
  if (parsed.options.strict && !migration.report.lossless) {
    return handledPrd(
      "prd.migrate",
      migration.report,
      [
        ...migration.diagnostics,
        {
          code: "RALPH_PRD_MIGRATION_LOSSY_STRICT",
          severity: "error",
          message: "Strict migration refused semantic changes or dropped classic fields",
          file: input.file,
          hint: "Inspect the migration report and rerun without --strict when the changes are acceptable.",
        },
      ],
      "",
    )
  }
  for (const candidate of [target, reportPath]) {
    if ((await fileExists(candidate)) && candidate !== input.path && !parsed.options.force) {
      throw new RalphError("RALPH_PRD_OUTPUT_EXISTS", "Refusing to overwrite migration output", {
        exitCode: EXIT_CODES.conflict,
        file: portable(relative(input.base, candidate)),
        hint: "Choose another output/report path or pass --force explicitly.",
      })
    }
  }
  const sourceMode = (await stat(input.path)).mode & 0o777
  if (parsed.options.inPlace) {
    const backup = `${input.path}.v1.bak`
    if ((await fileExists(backup)) && !parsed.options.force) {
      throw new RalphError("RALPH_PRD_BACKUP_EXISTS", "In-place migration backup already exists", {
        exitCode: EXIT_CODES.conflict,
        file: portable(relative(input.base, backup)),
      })
    }
    await writeFileAtomic(backup, await readFile(input.path), {
      overwrite: parsed.options.force,
      mode: sourceMode,
    })
  }
  await writeFileAtomic(target, migration.markdown, {
    overwrite: target === input.path || parsed.options.force,
    mode: sourceMode,
  })
  await writeJsonAtomic(reportPath, migration.report, { overwrite: parsed.options.force })
  return handledPrd(
    "prd.migrate",
    { ...migration.report, report: reportFile },
    migration.diagnostics,
    `Classic PRD migrated to ${targetFile}\nMigration report: ${reportFile}`,
  )
}

type InitializedCommandWorkspace = {
  root: string
  workspaceId: string
  layout: ReturnType<typeof workspaceLayout>
}

async function requireInitializedWorkspace(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<InitializedCommandWorkspace> {
  const status = await inspectWorkspace(workspaceStart(parsed, context), {
    exact: parsed.options.workspace !== undefined,
  })
  if (!status.initialized || !status.workspaceId) {
    throw new RalphError(
      "RALPH_WORKSPACE_NOT_INITIALIZED",
      "Ralph v2 workspace is not initialized",
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: status.root,
        hint: "Run `ralph init` first.",
      },
    )
  }
  return {
    root: status.root,
    workspaceId: status.workspaceId,
    layout: workspaceLayout(status.root),
  }
}

type OptionPrdContext = {
  graph?: CompiledPrdGraph
  document?: PrdDocument
  task?: PrdTask
}

/**
 * The runner remains the authoritative executable-PRD boundary. This preview
 * is deliberately best-effort and read-only: it exists only so PRD/task
 * defaults can participate in option precedence before the runner performs
 * its own strict v2/recursive compilation and capability checks.
 */
async function previewPrdOptionContext(
  workspaceRoot: string,
  prdFile: string,
  requestedTask: string | undefined,
  force: boolean,
): Promise<OptionPrdContext> {
  const absolutePrd = resolve(workspaceRoot, prdFile)
  if (!isInside(workspaceRoot, absolutePrd)) return {}
  try {
    const canonicalPrd = await realpath(absolutePrd)
    if (!isInside(workspaceRoot, canonicalPrd)) return {}
    const compiled = await compilePrdGraph(canonicalPrd, {
      workspaceRoot,
      recursive: true,
      strict: true,
    })
    if (!compiled.ok || !compiled.graph) return {}
    const graph = compiled.graph
    const rootDocument = graph.documents[graph.rootDocumentId]
    if (!rootDocument) return { graph }
    const records = initialTaskRecords("option-preview", graph, graph.rootDocumentId)
    const selection = selectTask({
      graph,
      records: new Map(records.map((record) => [taskRefKey(record), record])),
      documentId: graph.rootDocumentId,
      ...(requestedTask ? { requestedTask } : {}),
      force,
    })
    if (!selection) return { graph, document: rootDocument }
    const document = graph.documents[selection.task.documentId]
    const task = document?.tasks.find((candidate) => candidate.id === selection.task.taskId)
    return {
      graph,
      document: document ?? rootDocument,
      ...(task ? { task } : {}),
    }
  } catch {
    // Strict format, graph, task-selection and child diagnostics are emitted by
    // executeRun. The option preview must never become a competing validator.
    return {}
  }
}

function retryDelayMilliseconds(seconds: number): number {
  const milliseconds = Math.round(seconds * 1_000)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RalphError(
      "RALPH_RETRY_DELAY_INVALID",
      "--retry-delay cannot be represented safely in milliseconds",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: { seconds },
      },
    )
  }
  return milliseconds
}

function executableRunMode(value: string): RunMode {
  if (value === "once" || value === "loop" || value === "wiggum" || value === "parallel") {
    return value
  }
  throw new RalphError("RALPH_RUN_MODE_INVALID", `Invalid execution mode for run: ${value}`, {
    exitCode: EXIT_CODES.invalidUsage,
    hint: "Use one of: once, loop, wiggum, parallel.",
  })
}

function executionOverrides(parsed: ParsedCli): RunOptionOverrides {
  if (parsed.command === "run" && parsed.options.wiggum && parsed.options.mode !== undefined) {
    throw new RalphError(
      "RALPH_RUN_MODE_CONFLICT",
      "--wiggum and --mode cannot be combined; select the run mode only once",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const mode =
    parsed.command === "once"
      ? "once"
      : parsed.command === "loop"
        ? "loop"
        : parsed.command === "parallel"
          ? "parallel"
          : parsed.options.wiggum
            ? "wiggum"
            : parsed.options.mode !== undefined
              ? executableRunMode(parsed.options.mode)
              : undefined
  const toolRules = Object.fromEntries([
    ...parsed.options.allowTools.map((tool) => [tool, "allow"] as const),
    ...parsed.options.denyTools.map((tool) => [tool, "deny"] as const),
    ...parsed.options.askTools.map((tool) => [tool, "ask"] as const),
  ])
  return {
    ...(mode ? { mode } : {}),
    ...(parsed.options.executorProfile ? { executorProfile: parsed.options.executorProfile } : {}),
    ...(parsed.options.judgeProfile ? { judgeProfile: parsed.options.judgeProfile } : {}),
    ...(parsed.options.executorProvider
      ? { executorProvider: parsed.options.executorProvider }
      : {}),
    ...(parsed.options.executorModel ? { executorModel: parsed.options.executorModel } : {}),
    ...(parsed.options.clearExecutorCredential
      ? { executorCredential: null }
      : parsed.options.executorCredential
        ? { executorCredential: parsed.options.executorCredential }
        : {}),
    ...(parsed.options.clearExecutorVariant
      ? { executorVariant: null }
      : parsed.options.executorVariant
        ? { executorVariant: parsed.options.executorVariant }
        : {}),
    ...(parsed.options.clearExecutorParameters
      ? { executorParameters: {} }
      : Object.keys(parsed.options.executorParameters).length > 0
        ? { executorParameters: parsed.options.executorParameters }
        : {}),
    ...(parsed.options.judgeProvider ? { judgeProvider: parsed.options.judgeProvider } : {}),
    ...(parsed.options.judgeModel ? { judgeModel: parsed.options.judgeModel } : {}),
    ...(parsed.options.clearJudgeCredential
      ? { judgeCredential: null }
      : parsed.options.judgeCredential
        ? { judgeCredential: parsed.options.judgeCredential }
        : {}),
    ...(parsed.options.clearJudgeVariant
      ? { judgeVariant: null }
      : parsed.options.judgeVariant
        ? { judgeVariant: parsed.options.judgeVariant }
        : {}),
    ...(parsed.options.clearJudgeParameters
      ? { judgeParameters: {} }
      : Object.keys(parsed.options.judgeParameters).length > 0
        ? { judgeParameters: parsed.options.judgeParameters }
        : {}),
    ...(parsed.options.evaluationMode ? { evaluationMode: parsed.options.evaluationMode } : {}),
    ...(parsed.options.judgeThreshold !== undefined
      ? { judgeThreshold: parsed.options.judgeThreshold }
      : {}),
    ...(parsed.options.maxRevisionAttempts !== undefined
      ? { maxRevisionAttempts: parsed.options.maxRevisionAttempts }
      : {}),
    ...(parsed.options.judgeCallRetries !== undefined
      ? { judgeCallRetries: parsed.options.judgeCallRetries }
      : {}),
    ...(parsed.options.judgeUnavailablePolicy
      ? { judgeUnavailablePolicy: parsed.options.judgeUnavailablePolicy }
      : {}),
    ...(parsed.options.judgeBlockingSeverities.length > 0
      ? { blockingJudgeSeverities: parsed.options.judgeBlockingSeverities }
      : {}),
    ...(parsed.options.judgeRubric !== undefined
      ? { judgeRubric: parsed.options.judgeRubric }
      : {}),
    ...(parsed.options.judgeExhaustedPolicy
      ? { judgeExhaustedPolicy: parsed.options.judgeExhaustedPolicy }
      : {}),
    ...(parsed.options.task ? { task: parsed.options.task } : {}),
    ...(parsed.options.force ? { force: true } : {}),
    ...(parsed.options.dryRun ? { dryRun: true } : {}),
    ...(parsed.options.skipTests ? { skipTests: true } : {}),
    ...(parsed.options.skipLint ? { skipLint: true } : {}),
    ...(parsed.options.skipGates.length > 0 ? { skipGates: parsed.options.skipGates } : {}),
    ...(parsed.options.noGates ? { noGates: true } : {}),
    ...(parsed.options.fast ? { fast: true } : {}),
    ...(parsed.options.noCommit ? { noCommit: true } : {}),
    ...(parsed.options.failFast ? { failFast: true } : {}),
    ...(parsed.options.maxTasks !== undefined ? { maxTasks: parsed.options.maxTasks } : {}),
    ...(parsed.options.retryDelay !== undefined
      ? { delayMs: retryDelayMilliseconds(parsed.options.retryDelay) }
      : {}),
    ...(parsed.options.maxIterations !== undefined
      ? { maxIterations: parsed.options.maxIterations }
      : {}),
    ...(parsed.options.maxModelCalls !== undefined
      ? { maxModelCallsPerAttempt: parsed.options.maxModelCalls }
      : {}),
    ...(parsed.options.noChangeMaxRetries !== undefined
      ? { maxNoChangeAttempts: parsed.options.noChangeMaxRetries }
      : {}),
    ...(parsed.options.noChangePolicy ? { noChangePolicy: parsed.options.noChangePolicy } : {}),
    ...(parsed.options.securityMode ? { securityMode: parsed.options.securityMode } : {}),
    ...(parsed.options.headlessAsk ? { headlessAsk: parsed.options.headlessAsk } : {}),
    ...(Object.keys(toolRules).length > 0 ? { toolRules } : {}),
    ...(parsed.options.allowCommands.length > 0
      ? { allowedCommands: parsed.options.allowCommands }
      : {}),
    ...(parsed.options.readPaths.length > 0 ? { readPaths: parsed.options.readPaths } : {}),
    ...(parsed.options.writePaths.length > 0 ? { writePaths: parsed.options.writePaths } : {}),
    ...(parsed.options.allowShell ? { allowShell: true } : {}),
    ...(parsed.options.maxParallel !== undefined
      ? { maxParallel: parsed.options.maxParallel }
      : {}),
    ...(parsed.options.maxGlobalParallel !== undefined
      ? { maxGlobalParallel: parsed.options.maxGlobalParallel }
      : {}),
    ...(parsed.options.parallelAuto ? { parallelAuto: true } : {}),
    ...(parsed.options.parallelGroups.length > 0
      ? { parallelGroups: parsed.options.parallelGroups }
      : {}),
    ...(parsed.options.retryFailed ? { retryFailed: true } : {}),
    ...(parsed.options.maxFailureRetries !== undefined
      ? { maxFailureRetries: parsed.options.maxFailureRetries }
      : {}),
    ...(parsed.options.integrationStrategy
      ? { integrationStrategy: parsed.options.integrationStrategy }
      : {}),
    ...(parsed.options.branchPerTask ? { branchPerTask: true } : {}),
    ...(parsed.options.baseBranch ? { baseBranch: parsed.options.baseBranch } : {}),
    ...(parsed.options.integrationBranch
      ? { integrationBranch: parsed.options.integrationBranch }
      : {}),
    ...(parsed.options.sandboxEnabled ? { sandboxEnabled: true } : {}),
    ...(parsed.options.sandboxProvider ? { sandboxProvider: parsed.options.sandboxProvider } : {}),
    ...(parsed.options.sandboxImage ? { sandboxImage: parsed.options.sandboxImage } : {}),
  }
}

function executionFailureDiagnostic(result: RunExecutionResult): Diagnostic | undefined {
  if (result.exitCode === EXIT_CODES.success) return undefined
  const code =
    result.exitCode === EXIT_CODES.providerUnavailable
      ? "RALPH_EXECUTOR_PROFILE_UNAVAILABLE"
      : result.exitCode === EXIT_CODES.verificationFailed
        ? "RALPH_EXECUTION_VERIFICATION_FAILED"
        : result.exitCode === EXIT_CODES.blocked
          ? "RALPH_EXECUTION_BLOCKED"
          : result.exitCode === EXIT_CODES.budgetExceeded
            ? "RALPH_EXECUTION_LIMIT_REACHED"
            : "RALPH_EXECUTION_NOT_COMPLETED"
  return {
    code,
    severity: "error",
    message: result.reason,
    details: {
      status: result.status,
      mode: result.mode,
      ...(result.runId ? { runId: result.runId } : {}),
    },
  }
}

function judgeAssessmentHuman(task: string, assessment: JudgeAssessment): string[] {
  const lines = [
    `Assessment: ${task} ${assessment.kind} score=${assessment.score}/100`,
    `Judge summary: ${assessment.summary}`,
  ]
  if (assessment.adequate.length === 0) lines.push("Adequate:  none reported")
  for (const item of assessment.adequate) lines.push(`Adequate:  ${item}`)
  if (assessment.problems.length === 0) lines.push("Problem:   none reported")
  for (const problem of assessment.problems) {
    lines.push(
      `Problem:   [${problem.severity}]${problem.criterion ? ` ${problem.criterion}:` : ""} ${problem.message}`,
    )
  }
  if (assessment.missingEvidence.length === 0) lines.push("Missing:   none reported")
  for (const item of assessment.missingEvidence) lines.push(`Missing:   ${item}`)
  if (assessment.recommendations.length === 0) lines.push("Recommend: none reported")
  for (const item of assessment.recommendations) lines.push(`Recommend: ${item}`)
  return lines
}

function progressBar(completed: number, total: number, width = 24): string {
  const ratio = total === 0 ? 0 : Math.min(1, Math.max(0, completed / total))
  const filled = Math.min(width, Math.floor(ratio * width))
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`
}

function usageHuman(label: string, usage: EvidenceUsage): string {
  if (usage.source === "unavailable") {
    return `${label}: unavailable (${usage.providerCallCount} calls)`
  }
  const cost = usage.cost
    ? ` cost=${usage.cost.amount} ${usage.cost.currency}`
    : " cost=unavailable"
  return `${label}: total=${usage.total ?? "unavailable"} input=${usage.input ?? "unavailable"} output=${usage.output ?? "unavailable"} reasoning=${usage.reasoning ?? "unavailable"} calls=${usage.providerCallCount} source=${usage.source}${cost}`
}

function childUsageHuman(label: string, usage: ChildUsageSummary): string {
  if (!usage.available) return `${label}: unavailable (${usage.source})`
  const cost = usage.cost
    ? ` cost=${usage.cost.amount} ${usage.cost.currency}`
    : " cost=unavailable"
  return `${label}: total=${usage.totalTokens ?? "unavailable"} input=${usage.inputTokens ?? "unavailable"} output=${usage.outputTokens ?? "unavailable"} reasoning=${usage.reasoningTokens ?? "unavailable"} source=${usage.source}${cost}`
}

function reportUsageHuman(
  report: NonNullable<ReturnType<typeof getRunReport>>["report"],
): string[] {
  const childUsage = report.usage.children
  const aggregateUsage = report.usage.aggregate
  if (aggregateUsage && childUsage && childUsage.runCount > 0) {
    return [
      childUsageHuman("Aggregate total usage", aggregateUsage.combined),
      childUsageHuman("Aggregate executor usage", aggregateUsage.executor),
      childUsageHuman("Aggregate judge usage", aggregateUsage.judge),
      usageHuman("Root total usage", report.usage.combined),
      usageHuman("Root executor usage", report.usage.executor),
      usageHuman("Root judge usage", report.usage.judge),
      childUsageHuman("Child total usage", childUsage.combined),
      childUsageHuman("Child executor usage", childUsage.executor),
      childUsageHuman("Child judge usage", childUsage.judge),
    ]
  }
  return [
    usageHuman("Total usage", report.usage.combined),
    usageHuman("Executor usage", report.usage.executor),
    usageHuman("Judge usage", report.usage.judge),
  ]
}

function executionHuman(
  result: RunExecutionResult,
  optionsHash: string,
  notices: readonly string[],
): string {
  const task = result.plan.task
    ? result.plan.sourceKind === "ad-hoc"
      ? "ad-hoc request"
      : taskRefKey(result.plan.task)
    : "none"
  const completed = result.report?.progress?.completed ?? result.plan.completedTasks
  const total = result.report?.progress?.total ?? result.plan.totalTasks
  const lines = [
    `${result.kind === "dry-run" ? "Execution plan" : "Execution"}: ${result.status}`,
    `Mode:     ${result.mode}`,
    `Source:   ${result.plan.sourceKind}${result.plan.sourceDescriptionHash ? ` hash=${result.plan.sourceDescriptionHash}` : ""}`,
    ...(result.runId ? [`Run:      ${result.runId}`] : []),
    `Task:     ${task}`,
    `Progress: ${completed}/${total}${result.report?.progress ? " (leaf tasks)" : ""}`,
    `Backend:  ${result.plan.backendProfile} (${result.plan.backendRequired ? (result.plan.backendAvailable ? "available" : "unavailable") : "not required for current plan"})`,
    `Judge:    ${result.plan.evaluation.mode}${result.plan.evaluation.judgeProfile ? ` profile=${result.plan.evaluation.judgeProfile}` : ""}${result.plan.evaluation.judgeAvailable === undefined ? "" : ` (${result.plan.evaluation.judgeAvailable ? "available" : "unavailable"})`} threshold=${result.plan.evaluation.threshold} revisions=${result.plan.evaluation.maxRevisionAttempts}`,
    `Gate policy: no-gates=${result.plan.gatePolicy.noGates ? "yes" : "no"}, fast=${result.plan.gatePolicy.fast ? "yes" : "no"}, skip-tests=${result.plan.gatePolicy.skipTests ? "yes" : "no"}, skip-lint=${result.plan.gatePolicy.skipLint ? "yes" : "no"}, skip-gates=${result.plan.gatePolicy.skipGates.length > 0 ? result.plan.gatePolicy.skipGates.join(",") : "none"}`,
    `Options:  ${optionsHash}`,
    `Reason:   ${result.reason}`,
  ]
  if (result.kind === "dry-run") {
    lines.push(
      `Effects:  backend=${result.plan.effects.invokesBackend ? "yes" : "no"}, judge=${result.plan.effects.invokesJudge ? "yes" : "no"}, attempt=${result.plan.effects.createsAttempt ? "yes" : "no"}, marker=${result.plan.effects.mayUpdateMarkerAfterEvidence ? "after-evidence" : "no"}, writes=${result.plan.effects.writesDuringDryRun ? "yes" : "no"}`,
    )
    if (result.plan.verifications.length === 0) lines.push("Gates:    none")
    for (const verification of result.plan.verifications) {
      const command = verification.command
        ? ` command=${[verification.command.executable, ...verification.command.args].join(" ")}`
        : ""
      lines.push(
        `Gate:     ${verification.id} (${verification.category}, ${verification.blocking ? "blocking" : "non-blocking"}, ${verification.skipPolicy})${command}`,
      )
    }
    if (result.plan.childEdges.length === 0) lines.push("Children: none")
    if (result.plan.childEdges.length > 0) {
      lines.push(
        `Children: command-owned (${result.plan.childExecutionSupported ? "supported" : "unavailable"})`,
      )
    }
    for (const edge of result.plan.childEdges) {
      lines.push(`Child:    ${taskRefKey(edge.parentTask)} -> ${edge.childDocument}`)
    }
  }
  const latestAssessment = result.report?.tasks
    .flatMap((taskReport) =>
      (taskReport.judgeAssessments ?? []).map((assessment) => ({
        task: `${taskReport.documentId}/${taskReport.taskId}`,
        assessment,
      })),
    )
    .at(-1)
  if (latestAssessment) {
    lines.push(...judgeAssessmentHuman(latestAssessment.task, latestAssessment.assessment))
  }
  if (result.report) {
    lines.push(...reportUsageHuman(result.report))
  }
  for (const notice of notices) lines.push(`Notice:   ${notice}`)
  return lines.join("\n")
}

async function handleExecution(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const workspace = await requireInitializedWorkspace(parsed, context)
  const requestedResumePrd = parsed.options.prd
    ? portable(relative(workspace.root, resolve(workspace.root, parsed.options.prd)))
    : undefined
  const resumeTarget =
    parsed.command === "resume"
      ? parsed.options.runId
        ? requireStoredRun(workspace, parsed.options.runId)
        : latestResumableStoredRun(workspace, requestedResumePrd)
      : undefined
  if (parsed.command === "resume" && !resumeTarget) {
    throw new RalphError(
      "RALPH_RESUMABLE_RUN_NOT_FOUND",
      "No compatible non-terminal run is available to resume",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Use `ralph status --all` to inspect persisted runs.",
      },
    )
  }
  const requestedRunId = parsed.options.runId ?? resumeTarget?.id
  if (resumeTarget?.source?.kind === "ad-hoc" && parsed.options.prd) {
    throw new RalphError(
      "RALPH_RESUME_SOURCE_CONFLICT",
      "An ad-hoc run cannot be resumed with a PRD override",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const adHocDescription =
    parsed.options.adHocDescription ??
    (resumeTarget?.source?.kind === "ad-hoc" ? resumeTarget.source.description : undefined)
  const invocationCli = executionOverrides(parsed)
  let config = await loadEffectiveConfig({
    workspaceConfig: workspace.layout.config,
    environment: context.environment,
    cli: parsed.options.ui ? { ui: parsed.options.ui } : {},
  })
  let preparedInvocation: SettingsPreRunInvocation | undefined
  const uiMode = parsed.options.ui ?? config.config.defaults.ui
  const interactivePresentation = context.interactive === true && !parsed.options.nonInteractive
  if (uiMode === "tui" && !interactivePresentation) {
    throw new RalphError(
      "RALPH_TUI_TTY_REQUIRED",
      "The requested TUI requires an interactive terminal",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Use --ui plain/none or the equivalent config and run flags in headless environments.",
      },
    )
  }
  const useTui =
    context.runUi !== undefined &&
    (uiMode === "tui" || (uiMode === "auto" && interactivePresentation))
  if (uiMode === "tui" && !context.runUi) {
    throw new RalphError(
      "RALPH_TUI_UNAVAILABLE",
      "This Ralph executable or runtime platform has no TUI adapter",
      {
        exitCode: EXIT_CODES.operationalError,
        hint: "Use --ui plain/none; Windows ARM64 on Bun 1.3.14 cannot initialize OpenTUI because bun:ffi is unavailable.",
      },
    )
  }
  if (parsed.command !== "resume" && useTui && context.runUi?.prepare) {
    if (!interactivePresentation) {
      throw new RalphError(
        "RALPH_TUI_TTY_REQUIRED",
        "Pre-run TUI configuration requires an interactive terminal",
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: "Use --ui plain/none or the equivalent config and run flags in headless environments.",
        },
      )
    }
    const preparation = await context.runUi.prepare({
      workspaceRoot: workspace.root,
      initialInvocation: {
        schemaVersion: 1,
        runOptions: invocationCli,
        ...(!adHocDescription && parsed.options.prd ? { prd: parsed.options.prd } : {}),
        ui: uiMode,
        cliArguments: [],
      },
      ...(context.signal ? { signal: context.signal } : {}),
    })
    if (preparation.disposition === "cancelled") {
      if (context.signal?.aborted) {
        throw new RalphError(
          "RALPH_RUN_PREPARATION_INTERRUPTED",
          "Run preparation was interrupted",
          {
            exitCode: EXIT_CODES.interrupted,
          },
        )
      }
      const data = {
        status: "cancelled-before-persist" as const,
        persisted: false,
      }
      return handled({
        result: commandResult(parsed.command, data),
        human: "Run preparation closed without applying the draft; no run was persisted.",
      })
    }
    preparedInvocation = preparation.invocation
    if (
      adHocDescription &&
      (preparedInvocation.prd || preparedInvocation.runOptions.task != null)
    ) {
      throw new RalphError(
        "RALPH_ONCE_SOURCE_CONFLICT",
        "The pre-run TUI cannot associate a PRD or PRD task with a positional ad-hoc request",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    // Workspace/global saves made in the popup affect only the not-yet-created
    // run after a fresh effective-config read. Explicit invocation/draft values
    // remain provenance-bearing overrides below.
    config = await loadEffectiveConfig({
      workspaceConfig: workspace.layout.config,
      environment: context.environment,
      cli: parsed.options.ui ? { ui: parsed.options.ui } : {},
    })
  } else if (parsed.command !== "resume" && uiMode === "tui" && !context.runUi?.prepare) {
    throw new RalphError(
      "RALPH_TUI_PREPARE_UNAVAILABLE",
      "The configured TUI adapter cannot prepare an unpersisted run",
      {
        exitCode: EXIT_CODES.operationalError,
        hint: "Use --ui plain/none or install the full distribution.",
      },
    )
  }
  const prdFile =
    preparedInvocation?.prd ?? parsed.options.prd ?? resumeTarget?.rootPrdFile ?? "PRD.md"
  const cli = preparedInvocation?.runOptions ?? invocationCli
  const preview: OptionPrdContext = adHocDescription
    ? {}
    : await previewPrdOptionContext(
        workspace.root,
        prdFile,
        cli.task ?? undefined,
        cli.force ?? false,
      )
  const resumeOptionsCandidate = resumeTarget
    ? {
        ...resumeTarget.effectiveOptions,
        task: { value: null, source: "cli" as const, sourceRef: "cli:resume" },
        dryRun: { value: false, source: "cli" as const, sourceRef: "cli:resume" },
      }
    : undefined
  const resumeOptions = resumeOptionsCandidate
    ? EffectiveRunOptionsSchema.parse({
        ...resumeOptionsCandidate,
        contentHash: effectiveOptionsHash(resumeOptionsCandidate),
      })
    : undefined
  const resolved = resumeOptions
    ? {
        options: resumeOptions,
        optionsHash: resumeOptions.contentHash,
        notices: [
          "Resume uses the immutable effective-options snapshot persisted with the run; invocation-only task and dry-run selectors were cleared.",
        ],
      }
    : resolveEffectiveRunOptions({
        config,
        ...(preview.document ? { document: preview.document } : {}),
        cli,
      })
  if (cli.maxIterations !== undefined && resolved.options.mode.value !== "wiggum") {
    throw new RalphError(
      "RALPH_OPTION_REQUIRES_WIGGUM",
      "max iterations is only valid when the effective run mode is wiggum",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const liveTuiAbort = new AbortController()
  const relayCommandAbort = () => liveTuiAbort.abort(context.signal?.reason)
  context.signal?.addEventListener("abort", relayCommandAbort, { once: true })
  if (context.signal?.aborted) relayCommandAbort()
  let liveTui: Promise<RunUiCommandResult | undefined> | undefined
  let liveTuiFailure: string | undefined
  let execution: RunExecutionResult
  try {
    execution = await executeRun({
      workspaceRoot: workspace.root,
      source: adHocDescription
        ? { kind: "ad-hoc", description: adHocDescription }
        : { kind: "prd", prdFile },
      effectiveOptions: resolved.options,
      optionResolution: { config, cli },
      environment: context.environment,
      interactive: interactivePresentation,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(requestedRunId ? { runId: requestedRunId } : {}),
      ...(parsed.options.resumeDiscovery
        ? { resumeDiscovery: parsed.options.resumeDiscovery }
        : {}),
      ...(parsed.options.newRun ? { newRun: true } : {}),
      ...(parsed.options.acceptWorkspaceChanges ? { acceptWorkspaceChanges: true } : {}),
      ...(useTui && !resolved.options.dryRun.value && context.runUi
        ? {
            onRunReady: ({ runId }: { readonly runId: string }) => {
              liveTui = context.runUi
                ?.attach({
                  workspaceRoot: workspace.root,
                  runId,
                  mode: "attach",
                  closeWhenTerminal: true,
                  signal: liveTuiAbort.signal,
                })
                .catch((error) => {
                  liveTuiFailure = error instanceof Error ? error.message : String(error)
                  return undefined
                })
            },
          }
        : {}),
      dependencies: {
        resolveBackend: context.resolveBackend ?? (() => undefined),
        ...(context.resolveJudge ? { resolveJudge: context.resolveJudge } : {}),
        ...(context.toolPort ? { toolPort: context.toolPort } : {}),
        ...(context.gateRegistryFactory
          ? { gateRegistryFactory: context.gateRegistryFactory }
          : {}),
        ...(context.gitProcessSupervisorFactory
          ? { gitProcessSupervisorFactory: context.gitProcessSupervisorFactory }
          : {}),
        ...(context.childRunWorkerSessionFactory
          ? { childRunWorkerSessionFactory: context.childRunWorkerSessionFactory }
          : {}),
        ...(context.pullRequests ? { pullRequests: context.pullRequests } : {}),
        ...(context.supervisorControl ? { supervisorControl: context.supervisorControl } : {}),
      },
    })
  } finally {
    liveTuiAbort.abort("execution settled")
    context.signal?.removeEventListener("abort", relayCommandAbort)
    await liveTui
  }
  const data = execution
  const diagnostics: Diagnostic[] = execution.notices.map((notice) => ({
    code: "RALPH_RUN_OPTION_NOTICE",
    severity: "warning",
    message: notice,
  }))
  const failure = executionFailureDiagnostic(execution)
  if (failure) diagnostics.push(failure)
  if (liveTuiFailure) {
    diagnostics.push({
      code: "RALPH_TUI_DEGRADED",
      severity: "warning",
      message: `The run continued after the TUI adapter failed: ${liveTuiFailure}`,
    })
  }
  const result: CommandResult<typeof data> = {
    schemaVersion: 1,
    ok: execution.exitCode === EXIT_CODES.success,
    command: parsed.command,
    data,
    diagnostics,
    ...(execution.runId ? { runId: execution.runId } : {}),
  }
  return handled(
    {
      result,
      human: executionHuman(execution, execution.optionsHash, execution.notices),
    },
    execution.exitCode,
  )
}

function requireStoredRun(
  workspace: InitializedCommandWorkspace,
  runId: string,
): NonNullable<ReturnType<typeof getRun>> {
  const run = getRun(workspace.layout.ledger, runId)
  if (!run || run.workspaceId !== workspace.workspaceId) {
    throw new RalphError("RALPH_RUN_NOT_FOUND", `Run was not found in this workspace: ${runId}`, {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  return run
}

function latestStoredRun(workspace: InitializedCommandWorkspace) {
  const latest = listRuns(workspace.layout.ledger, {
    workspaceId: workspace.workspaceId,
    limit: 1,
  })[0]
  if (!latest) return undefined
  const rootRunId = resolveChildRunTreeRoot(workspace.layout.ledger, latest.id)
  return getRun(workspace.layout.ledger, rootRunId) ?? latest
}

const RESUMABLE_RUN_STATUSES: readonly RunStatus[] = [
  "created",
  "running",
  "stopping",
  "interrupted",
  "waiting",
]

function latestResumableStoredRun(workspace: InitializedCommandWorkspace, rootPrdFile?: string) {
  const seen = new Set<string>()
  for (const candidate of listRuns(workspace.layout.ledger, {
    workspaceId: workspace.workspaceId,
    statuses: RESUMABLE_RUN_STATUSES,
    limit: 1_000,
  })) {
    const rootRunId = resolveChildRunTreeRoot(workspace.layout.ledger, candidate.id)
    if (seen.has(rootRunId)) continue
    seen.add(rootRunId)
    const root = getRun(workspace.layout.ledger, rootRunId)
    if (
      root &&
      RESUMABLE_RUN_STATUSES.includes(root.status) &&
      (rootPrdFile === undefined || root.rootPrdFile === rootPrdFile)
    ) {
      return root
    }
  }
  return undefined
}

function stopGraceMilliseconds(seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined
  const milliseconds = Math.round(seconds * 1_000)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RalphError(
      "RALPH_STOP_GRACE_INVALID",
      "--grace cannot be represented safely in milliseconds",
      { exitCode: EXIT_CODES.invalidUsage, details: { seconds } },
    )
  }
  return milliseconds
}

async function handleStop(parsed: ParsedCli, context: CommandContext): Promise<HandledCommand> {
  const workspace = await requireInitializedWorkspace(parsed, context)
  const run = parsed.options.runId
    ? requireStoredRun(workspace, parsed.options.runId)
    : (latestResumableStoredRun(workspace) ?? latestStoredRun(workspace))
  if (!run) {
    throw new RalphError("RALPH_RUN_NOT_FOUND", "No persisted execution run is available", {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  if (!context.runControl) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_UNAVAILABLE",
      "This Ralph executable has no supervisor-owned run-control adapter",
      {
        exitCode: EXIT_CODES.operationalError,
        hint: "Inspect the run with `ralph status --all`; do not signal an unverified PID manually.",
      },
    )
  }
  const graceMs = stopGraceMilliseconds(parsed.options.grace)
  const stopped = await context.runControl.stop({
    workspaceRoot: workspace.root,
    workspaceId: workspace.workspaceId,
    runId: run.id,
    mode: parsed.options.force ? "force" : "graceful",
    ...(graceMs !== undefined ? { graceMs } : {}),
  })
  const data = { stop: stopped }
  const result: CommandResult<typeof data> = {
    ...commandResult("stop", data),
    runId: run.id,
  }
  const delivery =
    stopped.delivery === "supervisor"
      ? "delivered to supervisor"
      : "persisted for the next durable supervisor boundary"
  return handled({
    result,
    human: `Stop ${stopped.disposition} for run ${run.id}: ${stopped.previousStatus} -> ${stopped.status} (${delivery}).`,
  })
}

async function handleRunStatus(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const workspace = await requireInitializedWorkspace(parsed, context)
  const run = parsed.options.runId
    ? requireStoredRun(workspace, parsed.options.runId)
    : latestStoredRun(workspace)
  if (!run) {
    const data = {
      run: null,
      tasks: [],
      attempts: [],
      report: null,
      progress: null,
      pendingRecovery: null,
      recoveryInspectionError: null,
    }
    return handled({
      result: commandResult("status.run", data),
      human: "No persisted execution runs were found in this workspace.",
    })
  }
  const tasks = listRunTasks(workspace.layout.ledger, run.id)
  const childLinks = listChildRunTree(workspace.layout.ledger, run.id)
  const childAggregate = readChildRunTreeAggregate(workspace.layout.ledger, run.id)
  const childTaskScopes = childLinks.map((link) => ({
    link,
    tasks: listRunTasks(workspace.layout.ledger, link.childRunId),
  }))
  const taskTree = [
    ...tasks.map((task) => ({ ...task, scopeRunId: run.id, parentRunId: null, depth: 0 })),
    ...childTaskScopes.flatMap(({ link, tasks: childTasks }) =>
      childTasks.map((task) => ({
        ...task,
        scopeRunId: link.childRunId,
        parentRunId: link.parentRunId,
        depth: link.depth,
      })),
    ),
  ]
  const attempts = [
    ...listAttempts(workspace.layout.ledger, { runId: run.id }),
    ...childLinks.flatMap((link) =>
      listAttempts(workspace.layout.ledger, { runId: link.childRunId }),
    ),
  ]
  const report = getRunReport(workspace.layout.ledger, run.id)
  const events = readEvents(workspace.layout.ledger)
  let pendingRecovery: ReturnType<typeof findPendingRecoveryDecision> | null = null
  let recoveryInspectionError: string | null = null
  try {
    pendingRecovery = findPendingRecoveryDecision(events, run.id) ?? null
  } catch (error) {
    recoveryInspectionError = error instanceof Error ? error.message : String(error)
  }
  const completed = childAggregate.completed
  const progress = {
    completed,
    total: childAggregate.total,
    ratio: childAggregate.total === 0 ? 0 : completed / childAggregate.total,
    scope: childAggregate.scope,
  }
  const active = [...taskTree]
    .sort((left, right) => right.depth - left.depth)
    .find((task) => task.status !== "completed" && task.status !== "completed_with_override")
  const revisionScope = active ?? attempts.at(-1)
  const revisionRunId = active?.scopeRunId ?? revisionScope?.runId ?? run.id
  const revisionMaximum = revisionScope
    ? effectiveJudgeRevisionMaximum({
        baseMaximum: run.effectiveOptions.maxRevisionAttempts.value,
        events,
        scope: {
          runId: revisionRunId,
          documentId: revisionScope.documentId,
          taskId: revisionScope.taskId,
        },
      })
    : run.effectiveOptions.maxRevisionAttempts.value
  const data = {
    run,
    tasks,
    taskTree,
    childLinks,
    childAggregate,
    attempts,
    report: report?.report ?? null,
    progress,
    pendingRecovery,
    recoveryInspectionError,
  }
  const human = [
    `Run:      ${run.id}`,
    `Status:   ${run.status}`,
    `Mode:     ${run.mode}`,
    `Source:   ${run.source?.kind ?? "legacy-prd"}${run.source?.kind === "ad-hoc" ? ` hash=${run.source.descriptionHash}` : ""}`,
    ...(run.source?.kind === "ad-hoc" ? [`Request:  ${run.source.description.slice(0, 240)}`] : []),
    `Progress: ${completed}/${childAggregate.total} ${progressBar(completed, childAggregate.total)} (leaf tasks)`,
    `Task:     ${active ? `${run.source?.kind === "ad-hoc" ? "ad-hoc request" : `${active.documentId}/${active.taskId}`} (${active.status}, depth ${active.depth}, run ${active.scopeRunId})` : "none"}`,
    `Children: ${childLinks.length} (${childAggregate.runningChildren} running, ${childAggregate.blockedChildren} waiting/interrupted, ${childAggregate.failedChildren} failed/cancelled)`,
    `Attempts: ${attempts.length}`,
    `Judge:    ${run.effectiveOptions.evaluationMode.value}${run.effectiveOptions.judgeProfile ? ` profile=${run.effectiveOptions.judgeProfile.value}` : ""} threshold=${run.effectiveOptions.judgeThreshold.value}`,
    `Revisions: ${report?.report.counters.revisionAttempts ?? 0}/${revisionMaximum}`,
    `Watchdog restarts: ${report?.report.counters.watchdogRestarts ?? 0}`,
    ...(pendingRecovery
      ? [
          `Recovery: decision required for ${pendingRecovery.documentId}/${pendingRecovery.taskId}`,
          `Recovery manifest: ${pendingRecovery.payload.recoveryRef}`,
          `Recovery manifest hash: ${pendingRecovery.payload.recoveryHash}`,
          `Recovery expected: ${pendingRecovery.payload.expectedWorkspaceHash}`,
          `Recovery observed: ${pendingRecovery.payload.observedWorkspaceHash}`,
          `Recovery inspect: ralph status run --run-id ${run.id}`,
          `Recovery continue: ralph resume ${run.id} --accept-workspace-changes`,
          `Recovery checkpoint: ralph checkpoint create --run-id ${run.id}`,
          "Recovery rollback: ralph rollback preview <checkpoint-id>, then rollback apply <plan-id> --confirm-plan-hash <plan-hash>",
        ]
      : recoveryInspectionError
        ? [`Recovery: invalid durable decision (${recoveryInspectionError})`]
        : ["Recovery: none pending"]),
    ...(report
      ? [
          usageHuman("Total usage", report.report.usage.combined),
          usageHuman("Executor usage", report.report.usage.executor),
          usageHuman("Judge usage", report.report.usage.judge),
        ]
      : []),
    ...(childLinks.length > 0
      ? [
          childUsageHuman("Child executor usage", childAggregate.usage.executor),
          childUsageHuman("Child judge usage", childAggregate.usage.judge),
          childUsageHuman("Child combined usage", childAggregate.usage.combined),
          ...childLinks.map(
            (link) =>
              `${"  ".repeat(link.depth)}Child ${link.childDocumentId} run=${link.childRunId} status=${link.status} progress=${link.observability.progress.completed}/${link.observability.progress.total} watchdog=${link.observability.watchdogStatus}`,
          ),
        ]
      : []),
    ...(run.stopReason ? [`Reason:   ${run.stopReason}`] : []),
  ]
  const latestAssessment = report?.report.tasks
    .flatMap((taskReport) =>
      (taskReport.judgeAssessments ?? []).map((assessment) => ({
        task: `${taskReport.documentId}/${taskReport.taskId}`,
        assessment,
      })),
    )
    .at(-1)
  if (latestAssessment) {
    human.push(...judgeAssessmentHuman(latestAssessment.task, latestAssessment.assessment))
  }
  return handled({ result: commandResult("status.run", data), human: human.join("\n") })
}

async function handleAttach(parsed: ParsedCli, context: CommandContext): Promise<HandledCommand> {
  const replay = parsed.command === "replay"
  const workspace = await requireInitializedWorkspace(parsed, context)
  const run = parsed.options.runId
    ? requireStoredRun(workspace, parsed.options.runId)
    : latestStoredRun(workspace)
  if (!run) {
    throw new RalphError("RALPH_RUN_NOT_FOUND", "No persisted execution run is available", {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  if (!context.interactive) {
    throw new RalphError(
      "RALPH_TUI_TTY_REQUIRED",
      `The ${replay ? "replay" : "attach"} TUI requires an interactive terminal`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: `Use \`ralph status run --run-id ${run.id}\` in headless environments.`,
      },
    )
  }
  if (!context.runUi) {
    throw new RalphError("RALPH_TUI_UNAVAILABLE", "This Ralph executable has no TUI adapter", {
      exitCode: EXIT_CODES.operationalError,
      hint: `Use \`ralph status run --run-id ${run.id}\` or install the full distribution.`,
    })
  }
  const attached = await context.runUi.attach({
    workspaceRoot: workspace.root,
    runId: run.id,
    mode: replay ? "replay" : "attach",
    ...(context.signal ? { signal: context.signal } : {}),
  })
  const data = { attached }
  const result: CommandResult<typeof data> = {
    ...commandResult(replay ? "replay" : "attach", data),
    runId: run.id,
  }
  return handled({
    result,
    human: `${replay ? "Replay" : "Live TUI"} closed for run ${run.id}; last observed status: ${attached.observedStatus}.`,
  })
}

async function handleEvents(parsed: ParsedCli, context: CommandContext): Promise<HandledCommand> {
  const workspace = await requireInitializedWorkspace(parsed, context)
  const selectedRun = parsed.options.runId
    ? requireStoredRun(workspace, parsed.options.runId)
    : undefined
  const allEvents = readEvents(workspace.layout.ledger)
  const filter = eventLogFilter(parsed, "audit")
  const events = allEvents.filter((event) => eventMatchesLogFilter(event, filter))
  const limited = events.slice(-(parsed.options.limit ?? events.length))
  const data = {
    runId: parsed.options.runId ?? null,
    count: limited.length,
    totalMatching: events.length,
    events: limited,
  }
  const human =
    limited.length === 0
      ? "No matching events were found."
      : limited
          .map(
            (event) =>
              `${String(event.sequence).padStart(6)} ${event.timestamp} ${event.level.padEnd(5)} ${event.type}`,
          )
          .join("\n")
  const result: CommandResult<typeof data> = {
    ...commandResult("events", data),
    ...(parsed.options.runId ? { runId: parsed.options.runId } : {}),
  }
  if (!parsed.options.follow) return handled({ result, human, jsonlEvents: limited })
  const stream = followEvents({
    ledger: workspace.layout.ledger,
    initialEvents: limited,
    initialCursor: allEvents.at(-1)?.sequence ?? 0,
    filter,
    ...(selectedRun ? { selectedRun } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  })
  return handled({ result, stream })
}

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["completed", "failed", "cancelled"])

function eventLogFilter(parsed: ParsedCli, source: LogFilter["source"]): LogFilter {
  const task = parsed.options.task
  const parts = task?.split("/")
  if (parts && (parts.length > 2 || parts.some((part) => part.length === 0))) {
    throw new RalphError("RALPH_LOG_TASK_FILTER_INVALID", `Invalid task log filter: ${task}`, {
      exitCode: EXIT_CODES.invalidUsage,
      hint: "Use a task ID or the exact document-id/task-id pair.",
    })
  }
  const documentId = parts?.length === 2 ? parts[0] : undefined
  const taskId = parts?.length === 2 ? parts[1] : task
  return {
    ...(parsed.options.runId ? { runId: parsed.options.runId } : {}),
    ...(documentId ? { documentId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(parsed.options.workerId ? { workerId: parsed.options.workerId } : {}),
    ...(parsed.options.eventType ? { eventType: parsed.options.eventType } : {}),
    ...(parsed.options.level ? { minimumLevel: parsed.options.level } : {}),
    ...(parsed.options.since ? { since: parsed.options.since } : {}),
    ...(source ? { source } : {}),
  }
}

function eventMatchesLogFilter(event: EventEnvelope, filter: LogFilter): boolean {
  const audit = logRecordsForEvent(event).find(
    (record) => record.source === (filter.source ?? "audit"),
  )
  return audit !== undefined && matchesLogFilter(audit, filter)
}

function eventHuman(event: EventEnvelope): string {
  return `${String(event.sequence).padStart(6)} ${event.timestamp} ${event.level.padEnd(5)} ${event.type}`
}

function waitForFollow(signal?: AbortSignal, intervalMs = 250): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, intervalMs)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

type FollowEventsInput = {
  readonly ledger: string
  readonly initialEvents: readonly EventEnvelope[]
  readonly initialCursor: number
  readonly filter: LogFilter
  readonly selectedRun?: ReturnType<typeof getRun>
  readonly signal?: AbortSignal
}

async function* followEvents(input: FollowEventsInput): AsyncGenerator<CommandStreamItem> {
  for (const event of input.initialEvents) {
    if (input.signal?.aborted) return
    yield { value: event, human: eventHuman(event) }
  }
  if (input.selectedRun && TERMINAL_RUN_STATUSES.has(input.selectedRun.status)) return

  let cursor = input.initialCursor
  while (!input.signal?.aborted) {
    await waitForFollow(input.signal)
    if (input.signal?.aborted) return
    const batch = readEventBatch(input.ledger, {
      afterSequence: cursor,
      limit: 512,
      ...(input.filter.runId ? { runId: input.filter.runId } : {}),
    })
    cursor = batch.cursorSequence
    for (const event of batch.events) {
      if (!eventMatchesLogFilter(event, input.filter)) continue
      yield { value: event, human: eventHuman(event) }
    }
    if (input.selectedRun) {
      const current = getRun(input.ledger, input.selectedRun.id)
      if ((!current || TERMINAL_RUN_STATUSES.has(current.status)) && batch.scanned < 512) return
    }
  }
}

async function handleLogsTail(parsed: ParsedCli, context: CommandContext): Promise<HandledCommand> {
  const workspace = await requireInitializedWorkspace(parsed, context)
  const selectedRun = parsed.options.runId
    ? requireStoredRun(workspace, parsed.options.runId)
    : latestStoredRun(workspace)
  const effectiveRunId = parsed.options.runId ?? selectedRun?.id
  const allEvents = readEvents(workspace.layout.ledger)
  const filter = eventLogFilter(
    {
      ...parsed,
      options: { ...parsed.options, ...(effectiveRunId ? { runId: effectiveRunId } : {}) },
    },
    parsed.options.source ?? "human",
  )
  const records = projectLogRecords(allEvents, filter)
  const limited = records.slice(-(parsed.options.limit ?? 100))
  const data = {
    runId: effectiveRunId ?? null,
    source: filter.source ?? "human",
    following: parsed.options.follow,
    count: limited.length,
    totalMatching: records.length,
    filters: filter,
  }
  const result: CommandResult<typeof data> = {
    ...commandResult("logs.tail", data),
    ...(effectiveRunId ? { runId: effectiveRunId } : {}),
  }
  const initial = limited.map((record) => ({
    value: record,
    human: formatLogRecordHuman(record),
  }))
  const stream = parsed.options.follow
    ? followLogs({
        ledger: workspace.layout.ledger,
        initial,
        initialCursor: allEvents.at(-1)?.sequence ?? 0,
        filter,
        ...(selectedRun ? { selectedRun } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      })
    : (async function* (): AsyncGenerator<CommandStreamItem> {
        yield* initial
      })()
  return handled({ result, stream })
}

type FollowLogsInput = {
  readonly ledger: string
  readonly initial: readonly CommandStreamItem[]
  readonly initialCursor: number
  readonly filter: LogFilter
  readonly selectedRun?: ReturnType<typeof getRun>
  readonly signal?: AbortSignal
}

async function* followLogs(input: FollowLogsInput): AsyncGenerator<CommandStreamItem> {
  for (const item of input.initial) {
    if (input.signal?.aborted) return
    yield item
  }
  if (input.selectedRun && TERMINAL_RUN_STATUSES.has(input.selectedRun.status)) return

  let cursor = input.initialCursor
  while (!input.signal?.aborted) {
    await waitForFollow(input.signal)
    if (input.signal?.aborted) return
    const batch = readEventBatch(input.ledger, {
      afterSequence: cursor,
      limit: 512,
      ...(input.filter.runId ? { runId: input.filter.runId } : {}),
    })
    cursor = batch.cursorSequence
    for (const event of batch.events) {
      for (const record of logRecordsForEvent(event)) {
        if (!matchesLogFilter(record, input.filter)) continue
        yield { value: record, human: formatLogRecordHuman(record) }
      }
    }
    if (input.selectedRun) {
      const current = getRun(input.ledger, input.selectedRun.id)
      if ((!current || TERMINAL_RUN_STATUSES.has(current.status)) && batch.scanned < 512) return
    }
  }
}

function evidenceHuman(record: NonNullable<ReturnType<typeof getEvidenceBundle>>): string {
  const bundle = record.bundle
  const lines = [
    `Evidence:  ${bundle.id}`,
    `Attempt:   ${bundle.attemptId}`,
    `Schema:    v${bundle.schemaVersion}`,
    `Run:       ${bundle.runId}`,
    `Task:      ${bundle.documentId}/${bundle.taskId}`,
    `Hash:      ${bundle.contentHash}`,
    `Object:    ${record.contentRef ?? "legacy ledger-only bundle"}`,
    `Changes:   ${bundle.changes.status} (${bundle.changes.files.length} files)`,
    `Artifacts: ${bundle.artifacts.length}`,
    `Gates:     ${bundle.gates.filter((gate) => gate.status === "passed").length}/${bundle.gates.length} passed`,
  ]
  if (bundle.schemaVersion === 1) {
    lines.push("Detail:    legacy S03 evidence bundle; extended S06 fields are unavailable")
    return lines.join("\n")
  }
  const settledTools = bundle.toolCalls.filter((tool) => tool.settlement).length
  const usage =
    bundle.usage.source === "unavailable"
      ? "unavailable"
      : `input=${bundle.usage.input ?? 0} output=${bundle.usage.output ?? 0} reasoning=${bundle.usage.reasoning ?? 0} total=${bundle.usage.total ?? 0}`
  lines.push(
    `Title:     ${bundle.task.title}`,
    `Criteria:  ${bundle.task.criteria.length}`,
    `Tools:     ${settledTools}/${bundle.toolCalls.length} settled`,
    `Usage:     ${usage} (${bundle.usage.source})`,
    `Profile:   ${bundle.profile.profileId} backend=${bundle.profile.backendId}${bundle.profile.provider ? ` provider=${bundle.profile.provider}` : ""}${bundle.profile.model ? ` model=${bundle.profile.model}` : ""}`,
    `Prior:     ${bundle.priorAttempts.length} attempts, ${bundle.priorAssessments.length} assessments`,
    `Truncated: ${bundle.truncations.length}`,
    `Missing:   ${bundle.missingEvidence.length}`,
  )
  for (const notice of bundle.truncations) {
    lines.push(`  truncated ${notice.source}/${notice.field}: ${notice.reason}`)
  }
  for (const missing of bundle.missingEvidence) {
    lines.push(
      `  missing ${missing.blocking ? "[blocking] " : ""}${missing.source}/${missing.code}: ${missing.message}`,
    )
  }
  return lines.join("\n")
}

function commandEvidenceSelector(parsed: ParsedCli) {
  return {
    ...(parsed.options.runId ? { runId: parsed.options.runId } : {}),
    ...(parsed.options.task ? { task: parsed.options.task } : {}),
    ...(parsed.options.attemptId ? { attemptId: parsed.options.attemptId } : {}),
    ...(parsed.options.evidenceBundleId
      ? { evidenceBundleId: parsed.options.evidenceBundleId }
      : {}),
    ...(parsed.options.verificationOperationId
      ? { verificationOperationId: parsed.options.verificationOperationId }
      : {}),
    ...(parsed.arguments[0] ? { positional: parsed.arguments[0] } : {}),
  }
}

function verificationCommandHuman(report: VerificationCommandReport): string {
  return [
    `Verification: ${report.status}`,
    `Operation:    ${report.operationId}`,
    `Report:       ${report.id}`,
    `Report hash:  ${report.contentHash}`,
    `Run:          ${report.selection.runId}`,
    `Task:         ${report.selection.documentId}/${report.selection.taskId}`,
    `Attempt:      ${report.selection.attemptId}`,
    `Source:       ${report.selection.evidenceBundleId}`,
    `Evidence:     ${report.evidence.id}`,
    `Hash:         ${report.evidence.contentHash}`,
    `Evidence ref: ${report.evidenceObject.contentRef} (${report.evidenceObject.sizeBytes} bytes, ${report.evidenceObject.storageHash})`,
    `Gates:        ${report.evidence.gates.filter((gate) => gate.status === "passed").length}/${report.gateCount} passed`,
    `Stable:       ${report.workspaceStable ? "yes" : "no"}`,
    `Control state:${report.controlStateStable ? " stable" : " changed"}`,
    "Executor:     not invoked",
    "PRD marker:   unchanged",
    `Decision:     ${report.decision.status} — ${report.decision.reasons.join("; ")}`,
  ].join("\n")
}

function judgmentCommandHuman(report: JudgmentCommandReport): string {
  return [
    `Judgment:     ${report.status}`,
    `Operation:    ${report.operationId}`,
    `Report:       ${report.id}`,
    `Report hash:  ${report.contentHash}`,
    `Run:          ${report.selection.runId}`,
    `Task:         ${report.selection.documentId}/${report.selection.taskId}`,
    `Attempt:      ${report.selection.attemptId}`,
    `Evidence:     ${report.selection.evidenceBundleId}`,
    `Mode:         ${report.kind}`,
    `Profile:      ${report.profileId}`,
    `Assessment:   ${report.assessment.id}`,
    `Assessment ref: ${report.assessmentRef} (${report.assessmentSizeBytes} bytes, ${report.assessmentStorageHash})`,
    `Raw response: ${report.assessment.rawResponseRef ?? "unavailable"}`,
    `Score:        ${report.assessment.score}/100 (threshold ${report.policy.threshold})`,
    `Stable:       ${report.workspaceStable ? "yes" : "no"}`,
    `Control state:${report.controlStateStable ? " stable" : " changed"}`,
    "Tools:        unavailable",
    "PRD marker:   unchanged",
    ...judgeAssessmentHuman(
      `${report.selection.documentId}/${report.selection.taskId}`,
      report.assessment,
    ),
    `Decision:     ${report.decision.status} — ${report.decision.reasons.join("; ")}`,
  ].join("\n")
}

function commandEvidenceExitCode(
  status: VerificationCommandReport["status"] | JudgmentCommandReport["status"],
): ExitCode {
  if (status === "passed" || status === "overridden") return EXIT_CODES.success
  if (status === "blocked") return EXIT_CODES.blocked
  return EXIT_CODES.verificationFailed
}

async function handleVerifyCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  if (parsed.options.format === "jsonl") {
    throw new RalphError(
      "RALPH_VERIFY_FORMAT_INVALID",
      "verify supports --format human or --format json; use events for incremental JSONL",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const workspace = await requireInitializedWorkspace(parsed, context)
  const report = await executeVerifyCommand({
    workspaceRoot: workspace.root,
    workspaceId: workspace.workspaceId,
    selector: commandEvidenceSelector(parsed),
    environment: context.environment,
    ...(context.signal ? { signal: context.signal } : {}),
    gatePolicy: {
      skipTests: parsed.options.skipTests,
      skipLint: parsed.options.skipLint,
      skipGates: parsed.options.skipGates,
      noGates: parsed.options.noGates,
      fast: parsed.options.fast,
      force: parsed.options.force,
      failFast: parsed.options.failFast,
    },
    ...(context.gateRegistryFactory ? { gateRegistryFactory: context.gateRegistryFactory } : {}),
  })
  const result: CommandResult<VerificationCommandReport> = {
    ...commandResult("verify", report),
    runId: report.selection.runId,
  }
  return handled(
    { result, human: verificationCommandHuman(report) },
    commandEvidenceExitCode(report.status),
  )
}

async function handleJudgeCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  if (parsed.options.format === "jsonl") {
    throw new RalphError(
      "RALPH_JUDGE_FORMAT_INVALID",
      "judge supports --format human or --format json; use events for incremental JSONL",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const requestedEvaluation = parsed.options.evaluationMode ?? "external"
  if (requestedEvaluation !== "external" && requestedEvaluation !== "self") {
    throw new RalphError(
      "RALPH_JUDGE_MODE_INVALID",
      `The standalone judge command requires external or self evaluation, received ${requestedEvaluation}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Use the command default external judge, --judge, --self-review, or --evaluation external|self.",
      },
    )
  }
  const unusedRoleOverrides =
    requestedEvaluation === "external"
      ? ([
          ["--executor-profile", parsed.options.executorProfile !== undefined],
          ["--executor-provider", parsed.options.executorProvider !== undefined],
          ["--executor-model", parsed.options.executorModel !== undefined],
          ["--executor-credential", parsed.options.executorCredential !== undefined],
          ["--executor-variant", parsed.options.executorVariant !== undefined],
          ["--executor-parameter", Object.keys(parsed.options.executorParameters).length > 0],
          ["--clear-executor-credential", parsed.options.clearExecutorCredential],
          ["--clear-executor-variant", parsed.options.clearExecutorVariant],
          ["--clear-executor-parameters", parsed.options.clearExecutorParameters],
        ] as const)
      : ([
          ["--judge-profile", parsed.options.judgeProfile !== undefined],
          ["--judge-provider", parsed.options.judgeProvider !== undefined],
          ["--judge-model", parsed.options.judgeModel !== undefined],
          ["--judge-credential", parsed.options.judgeCredential !== undefined],
          ["--judge-variant", parsed.options.judgeVariant !== undefined],
          ["--judge-parameter", Object.keys(parsed.options.judgeParameters).length > 0],
          ["--clear-judge-credential", parsed.options.clearJudgeCredential],
          ["--clear-judge-variant", parsed.options.clearJudgeVariant],
          ["--clear-judge-parameters", parsed.options.clearJudgeParameters],
        ] as const)
  const unusedRoleOverride = unusedRoleOverrides.find(([, present]) => present)
  if (unusedRoleOverride) {
    throw new RalphError(
      "RALPH_JUDGE_ROLE_OVERRIDE_UNUSED",
      `${unusedRoleOverride[0]} is not used by ${requestedEvaluation} evaluation`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint:
          requestedEvaluation === "external"
            ? "Use judge profile/provider/model/credential/variant/parameter overrides."
            : "Use executor profile/provider/model/credential/variant/parameter overrides for self-review.",
      },
    )
  }
  const resolveJudge = context.resolveJudge
  if (!resolveJudge) {
    throw new RalphError(
      "RALPH_JUDGE_BACKEND_UNAVAILABLE",
      "This Ralph composition has no judge backend resolver",
      { exitCode: EXIT_CODES.providerUnavailable },
    )
  }
  const workspace = await requireInitializedWorkspace(parsed, context)
  const { effective } = await effectiveConfigForCommand(parsed, context)
  const optionOverrides: RunOptionOverrides = {
    evaluationMode: requestedEvaluation,
    ...(requestedEvaluation === "self" && parsed.options.executorProfile
      ? { executorProfile: parsed.options.executorProfile }
      : {}),
    ...(requestedEvaluation === "self" && parsed.options.executorProvider
      ? { executorProvider: parsed.options.executorProvider }
      : {}),
    ...(requestedEvaluation === "self" && parsed.options.executorModel
      ? { executorModel: parsed.options.executorModel }
      : {}),
    ...(requestedEvaluation === "self" && parsed.options.clearExecutorCredential
      ? { executorCredential: null }
      : requestedEvaluation === "self" && parsed.options.executorCredential
        ? { executorCredential: parsed.options.executorCredential }
        : {}),
    ...(requestedEvaluation === "self" && parsed.options.clearExecutorVariant
      ? { executorVariant: null }
      : requestedEvaluation === "self" && parsed.options.executorVariant
        ? { executorVariant: parsed.options.executorVariant }
        : {}),
    ...(requestedEvaluation === "self" && parsed.options.clearExecutorParameters
      ? { executorParameters: {} }
      : requestedEvaluation === "self" && Object.keys(parsed.options.executorParameters).length > 0
        ? { executorParameters: parsed.options.executorParameters }
        : {}),
    ...(requestedEvaluation === "external" && parsed.options.judgeProfile
      ? { judgeProfile: parsed.options.judgeProfile }
      : {}),
    ...(requestedEvaluation === "external" && parsed.options.judgeProvider
      ? { judgeProvider: parsed.options.judgeProvider }
      : {}),
    ...(requestedEvaluation === "external" && parsed.options.judgeModel
      ? { judgeModel: parsed.options.judgeModel }
      : {}),
    ...(requestedEvaluation === "external" && parsed.options.clearJudgeCredential
      ? { judgeCredential: null }
      : requestedEvaluation === "external" && parsed.options.judgeCredential
        ? { judgeCredential: parsed.options.judgeCredential }
        : {}),
    ...(requestedEvaluation === "external" && parsed.options.clearJudgeVariant
      ? { judgeVariant: null }
      : requestedEvaluation === "external" && parsed.options.judgeVariant
        ? { judgeVariant: parsed.options.judgeVariant }
        : {}),
    ...(requestedEvaluation === "external" && parsed.options.clearJudgeParameters
      ? { judgeParameters: {} }
      : requestedEvaluation === "external" && Object.keys(parsed.options.judgeParameters).length > 0
        ? { judgeParameters: parsed.options.judgeParameters }
        : {}),
    ...(parsed.options.judgeThreshold !== undefined
      ? { judgeThreshold: parsed.options.judgeThreshold }
      : {}),
    ...(parsed.options.judgeCallRetries !== undefined
      ? { judgeCallRetries: parsed.options.judgeCallRetries }
      : {}),
    ...(parsed.options.judgeBlockingSeverities.length > 0
      ? { blockingJudgeSeverities: parsed.options.judgeBlockingSeverities }
      : {}),
    ...(parsed.options.judgeRubric !== undefined
      ? { judgeRubric: parsed.options.judgeRubric }
      : {}),
  }
  const report = await executeJudgeCommand({
    workspaceRoot: workspace.root,
    workspaceId: workspace.workspaceId,
    selector: commandEvidenceSelector(parsed),
    environment: context.environment,
    effectiveConfig: effective,
    optionOverrides,
    resolveJudge,
    ...(context.signal ? { signal: context.signal } : {}),
  })
  const result: CommandResult<JudgmentCommandReport> = {
    ...commandResult("judge", report),
    runId: report.selection.runId,
  }
  return handled(
    { result, human: judgmentCommandHuman(report) },
    commandEvidenceExitCode(report.status),
  )
}

async function handleEvidenceInspect(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  if (parsed.options.format === "jsonl") {
    throw new RalphError(
      "RALPH_EVIDENCE_FORMAT_INVALID",
      "evidence inspect supports --format human or --format json",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const workspace = await requireInitializedWorkspace(parsed, context)
  const attemptId = parsed.arguments[0] as string
  const record = getEvidenceBundle(workspace.layout.ledger, attemptId)
  if (!record) {
    throw new RalphError(
      "RALPH_EVIDENCE_NOT_FOUND",
      `No persisted evidence bundle is available for attempt: ${attemptId}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Inspect `status run` to find attempts that reached the evidence boundary.",
      },
    )
  }
  const data = {
    verified: true,
    attemptId,
    evidenceBundleId: record.id,
    storage: record.contentRef
      ? {
          contentRef: record.contentRef,
          storageHash: record.storageHash,
          sizeBytes: record.sizeBytes,
        }
      : null,
    bundle: record.bundle,
  }
  const result: CommandResult<typeof data> = {
    ...commandResult("evidence.inspect", data),
    runId: record.bundle.runId,
  }
  return handled({ result, human: evidenceHuman(record) })
}

function reportHuman(report: NonNullable<ReturnType<typeof getRunReport>>["report"]): string {
  const completed = report.progress?.completed ?? report.counters.tasksCompleted
  const total = report.progress?.total ?? report.tasks.length
  const lines = [
    `Run report: ${report.runId}`,
    `Status:     ${report.status}`,
    `Mode:       ${report.mode}`,
    `Source:     ${report.source?.kind ?? "legacy-prd"}${report.source?.kind === "ad-hoc" ? ` hash=${report.source.descriptionHash}` : ""}`,
    `Progress:   ${completed}/${total} ${progressBar(completed, total)}${report.progress ? " (leaf tasks)" : ""}`,
    ...(report.progress ? [`Child runs: ${report.progress.childRunCount}`] : []),
    `Attempts:   ${report.counters.attempts}`,
    `Model calls: ${report.counters.modelCalls}`,
    `Judge retries: ${report.counters.judgeTransportRetries}`,
    `Revisions:  ${report.counters.revisionAttempts}`,
    `Watchdog restarts: ${report.counters.watchdogRestarts}`,
    ...reportUsageHuman(report),
    ...(report.reasons.length > 0 ? [`Reason:     ${report.reasons.join("; ")}`] : []),
  ]
  for (const task of report.tasks) {
    if (task.completion) {
      lines.push(
        `Completion: ${task.documentId}/${task.taskId} ${task.completion.status} marker-updated=${task.markerUpdated === true ? "yes" : "no"} — ${task.completion.reasons.join("; ")}`,
      )
    }
    for (const caveat of task.evidenceCaveats) {
      lines.push(`Evidence caveat: ${task.documentId}/${task.taskId} — ${caveat}`)
    }
    for (const assessment of task.judgeAssessments ?? []) {
      lines.push(...judgeAssessmentHuman(`${task.documentId}/${task.taskId}`, assessment))
    }
  }
  return lines.join("\n")
}

async function handleReport(parsed: ParsedCli, context: CommandContext): Promise<HandledCommand> {
  const workspace = await requireInitializedWorkspace(parsed, context)
  const requestedRunId =
    parsed.command === "report.show"
      ? (parsed.arguments[0] ?? parsed.options.runId)
      : latestStoredRun(workspace)?.id
  if (!requestedRunId) {
    throw new RalphError("RALPH_RUN_NOT_FOUND", "No persisted execution run is available", {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  const run = requireStoredRun(workspace, requestedRunId)
  const record = getRunReport(workspace.layout.ledger, run.id)
  if (!record) {
    throw new RalphError(
      "RALPH_RUN_REPORT_NOT_FOUND",
      `No persisted report is available for run: ${run.id}`,
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Inspect `status run` and retry after the run reaches a report boundary.",
      },
    )
  }
  const result: CommandResult<typeof record.report> = {
    ...commandResult(parsed.command, record.report),
    runId: run.id,
  }
  return handled({ result, human: reportHuman(record.report) })
}

function parseRevisionRecoveryTaskRef(taskRef: string): {
  documentId: string
  taskId: string
} {
  const parts = taskRef.split("/")
  const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !slug.test(parts[0]) ||
    !slug.test(parts[1])
  ) {
    throw new RalphError("RALPH_REVIEW_TASK_INVALID", `Invalid task reference: ${taskRef}`, {
      exitCode: EXIT_CODES.invalidUsage,
      hint: "Use the exact lowercase PRD identity: --task <document-id/task-id>.",
    })
  }
  return { documentId: parts[0], taskId: parts[1] }
}

async function handleReviewRetry(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const workspace = await requireInitializedWorkspace(parsed, context)
  const runId = parsed.options.runId
  const taskRef = parsed.options.task
  const additionalRevisions = parsed.options.additionalRevisions
  const reason = parsed.options.reason
  if (!runId || !taskRef || additionalRevisions === undefined || !reason) {
    throw new RalphError(
      "RALPH_REVIEW_RETRY_INCOMPLETE",
      "review retry requires --run-id, --task, --additional-revisions and --reason",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  requireStoredRun(workspace, runId)
  const task = parseRevisionRecoveryTaskRef(taskRef)
  const receipt = grantJudgeRevisionAttempts({
    ledger: workspace.layout.ledger,
    runId,
    ...task,
    additionalRevisions,
    reason,
    source: "cli",
  })
  const data = { runId, task, receipt }
  const result: CommandResult<typeof data> = {
    ...commandResult("review.retry", data),
    runId,
  }
  const human = [
    `Run:       ${runId}`,
    `Task:      ${task.documentId}/${task.taskId}`,
    `Revisions: +${receipt.additionalRevisions} (${receipt.previousMaximum} -> ${receipt.effectiveMaximum})`,
    `Status:    eligible`,
    `Audit:     ${receipt.eventId}`,
    `Reason:    ${receipt.reason}`,
    "Next:      resume the same run with --run-id; Ralph will continue from this task.",
  ].join("\n")
  return handled({ result, human })
}

type DoctorCheck = {
  id: string
  status: "passed" | "warning" | "failed" | "skipped"
  required: boolean
  message: string
  hint?: string
  details?: Record<string, unknown>
}

const S04_DOCTOR_CHECK_IDS = {
  catalog: "providers.catalog",
  credentials: "credentials.metadata",
  profiles: "profiles.runtime",
} as const

function skippedS04DoctorChecks(message: string): DoctorCheck[] {
  return [
    {
      id: S04_DOCTOR_CHECK_IDS.catalog,
      status: "skipped",
      required: false,
      message,
    },
    {
      id: S04_DOCTOR_CHECK_IDS.credentials,
      status: "skipped",
      required: false,
      message,
    },
    {
      id: S04_DOCTOR_CHECK_IDS.profiles,
      status: "skipped",
      required: false,
      message,
    },
  ]
}

function runtimeProfileFailure(error: unknown): Pick<DoctorCheck, "message" | "hint"> {
  if (error instanceof RalphError && error.code.startsWith("RALPH_PROFILE_")) {
    let hint = "Inspect the effective role profiles and run `ralph doctor` again."
    if (error.code.includes("CREDENTIAL")) {
      hint = "Inspect `auth list` and the credential reference configured for each role profile."
    } else if (error.code.includes("FALLBACK")) {
      hint = "Inspect fallback_profiles for missing targets, role mismatches or cycles."
    } else if (
      error.code.includes("MODEL") ||
      error.code.includes("PROVIDER") ||
      error.code.includes("VARIANT")
    ) {
      hint = "Inspect `models list` and align the profile requirements with a compatible model."
    }
    return { message: `${error.code}: ${error.message}`, hint }
  }
  return {
    message: "Runtime role profile validation failed",
    hint: "Inspect the effective role profiles and run `ralph doctor` again.",
  }
}

async function s04DoctorChecks(parsed: ParsedCli, context: CommandContext): Promise<DoctorCheck[]> {
  let profiles: Readonly<Record<string, RoleProfileConfig>>
  try {
    profiles = (await effectiveConfigForCommand(parsed, context)).effective.config.profiles
  } catch {
    return [
      {
        id: "profiles.config",
        status: "failed",
        required: true,
        message: "Effective role profile configuration could not be loaded",
        hint: "Inspect global and workspace configuration syntax, then run doctor again.",
      },
      ...skippedS04DoctorChecks(
        "S04 validation requires a valid effective role profile configuration",
      ),
    ]
  }

  const profileCount = Object.keys(profiles).length
  if (profileCount === 0) {
    return skippedS04DoctorChecks(
      "No role profiles are configured; provider, credential and runtime compatibility checks are not required",
    )
  }

  const configuredCredentialIds = new Set(
    Object.values(profiles).flatMap((profile) =>
      profile.credential === undefined ? [] : [profile.credential],
    ),
  )

  // Resolve one catalog snapshot before touching provider-backed credential
  // status. Every cold manager below receives the ProviderInfo from this exact
  // snapshot and therefore cannot trigger a secondary catalog.providers() read.
  let snapshot: Awaited<ReturnType<ModelCatalog["snapshot"]>>["snapshot"] | undefined
  let credentialCatalogHandle: CredentialCatalogHandle | undefined
  let catalogCheck: DoctorCheck
  try {
    const catalogUse = context.credentials
      ? await credentialCatalogSnapshot(context.credentials, context)
      : { resolution: await (await commandModelCatalog(context)).snapshot() }
    const resolution = catalogUse.resolution
    credentialCatalogHandle = catalogUse.handle
    snapshot = resolution.snapshot
    const degraded =
      resolution.stale ||
      resolution.origin === "fallback" ||
      resolution.origin === "stale-cache" ||
      resolution.warning !== undefined
    catalogCheck = {
      id: S04_DOCTOR_CHECK_IDS.catalog,
      status: degraded ? "warning" : "passed",
      required: true,
      message: `Catalog snapshot ${snapshot.id} loaded from ${resolution.origin} (${snapshot.providers.length} provider(s), ${snapshot.models.length} model(s))`,
      ...(degraded
        ? {
            hint: "Validation used the exact returned snapshot; refresh the catalog when source access is available.",
          }
        : {}),
    }
  } catch {
    catalogCheck = {
      id: S04_DOCTOR_CHECK_IDS.catalog,
      status: "failed",
      required: true,
      message: "A model catalog snapshot could not be loaded for role profile validation",
      hint: "Check catalog source/cache availability, then run doctor again.",
    }
  }

  let credentials: CredentialRef[] = []
  let credentialCheck: DoctorCheck
  if (!context.credentials) {
    credentialCheck =
      configuredCredentialIds.size === 0
        ? {
            id: S04_DOCTOR_CHECK_IDS.credentials,
            status: "skipped",
            required: false,
            message: "No configured role profile references credential metadata",
          }
        : {
            id: S04_DOCTOR_CHECK_IDS.credentials,
            status: "failed",
            required: true,
            message: `Credential metadata service is unavailable for ${configuredCredentialIds.size} configured reference(s)`,
            hint: "Configure the credential runtime and inspect `auth list`.",
          }
  } else {
    try {
      credentials = (await context.credentials.list()).map((credential) =>
        CredentialRefSchema.parse(credential),
      )
      const availableIds = new Set(credentials.map((credential) => credential.id))
      const configuredCredentials = credentials.filter((credential) =>
        configuredCredentialIds.has(credential.id),
      )
      const missingCount = [...configuredCredentialIds].filter((id) => !availableIds.has(id)).length
      if (missingCount > 0) {
        credentialCheck = {
          id: S04_DOCTOR_CHECK_IDS.credentials,
          status: "failed",
          required: true,
          message: `Credential metadata is missing ${missingCount} reference(s) required by role profiles`,
          hint: "Inspect `auth list` and update or reconnect the missing credential references.",
        }
      } else if (configuredCredentials.length === 0) {
        credentialCheck = {
          id: S04_DOCTOR_CHECK_IDS.credentials,
          status: "passed",
          required: false,
          message: `Credential metadata loaded (${credentials.length} reference(s)); no role profile requires one`,
        }
      } else {
        if (!snapshot) {
          throw new Error("Credential status requires the exact doctor catalog snapshot")
        }
        const providers = new Map(snapshot.providers.map((provider) => [provider.id, provider]))
        const statuses = await Promise.all(
          configuredCredentials.map(async (credential) => {
            const provider = providers.get(credential.provider)
            if (!provider) {
              throw new Error(
                `Credential provider is absent from the exact doctor snapshot: ${credential.provider}`,
              )
            }
            return CredentialStatusSchema.parse(
              await context.credentials?.status(credential, {
                refresh: false,
                provider,
                ...(credentialCatalogHandle ? { catalogHandle: credentialCatalogHandle } : {}),
              }),
            )
          }),
        )
        const unavailableCount = statuses.filter((status) => status !== "connected").length
        credentialCheck =
          unavailableCount === 0
            ? {
                id: S04_DOCTOR_CHECK_IDS.credentials,
                status: "passed",
                required: true,
                message: `${configuredCredentials.length} configured credential reference(s) exist and are connected`,
              }
            : {
                id: S04_DOCTOR_CHECK_IDS.credentials,
                status: "failed",
                required: true,
                message: `${unavailableCount} configured credential reference(s) are not connected`,
                hint: "Inspect `auth status` and reconnect or refresh unavailable credentials.",
              }
      }
    } catch {
      credentialCheck = {
        id: S04_DOCTOR_CHECK_IDS.credentials,
        status: configuredCredentialIds.size > 0 ? "failed" : "warning",
        required: configuredCredentialIds.size > 0,
        message: "Credential metadata or status could not be read safely",
        hint: "Inspect the credential store with `auth list` and `auth status`; no locator or secret was included.",
      }
    }
  }

  let profileCheck: DoctorCheck
  if (!snapshot) {
    profileCheck = {
      id: S04_DOCTOR_CHECK_IDS.profiles,
      status: "skipped",
      required: true,
      message: "Runtime role profiles were not validated because no catalog snapshot is available",
    }
  } else {
    try {
      const resolved = resolveRuntimeProfiles(profiles, credentials, snapshot)
      profileCheck = {
        id: S04_DOCTOR_CHECK_IDS.profiles,
        status: "passed",
        required: true,
        message: `${Object.keys(resolved.profiles).length} runtime role profile(s) are valid against catalog snapshot ${resolved.catalogSnapshotId}`,
      }
    } catch (error) {
      profileCheck = {
        id: S04_DOCTOR_CHECK_IDS.profiles,
        status: "failed",
        required: true,
        ...runtimeProfileFailure(error),
      }
    }
  }

  return [catalogCheck, credentialCheck, profileCheck]
}

function sandboxIsolationSummary(capability: SandboxCapability): string {
  return [
    `filesystem=${capability.filesystemIsolation}`,
    `network=${capability.networkIsolation}`,
    `process=${capability.processIsolation}`,
  ].join(", ")
}

async function sandboxDoctorCheck(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<DoctorCheck> {
  let sandbox: SandboxConfig
  try {
    sandbox = (await effectiveConfigForCommand(parsed, context)).effective.config.sandbox
  } catch {
    return {
      id: "sandbox.capability",
      status: "failed",
      required: true,
      message: "Effective sandbox configuration could not be loaded",
      hint: "Inspect global and workspace sandbox configuration, then run doctor again.",
    }
  }

  const details = {
    enabled: sandbox.enabled,
    configuredProvider: sandbox.provider,
    requirements: {
      containerIsolation: sandbox.require_container_isolation,
      networkIsolation: sandbox.require_network_isolation,
      networkMode: sandbox.network_mode,
    },
  }
  if (!sandbox.enabled) {
    return {
      id: "sandbox.capability",
      status: "skipped",
      required: false,
      message: `Sandbox is disabled; configured provider ${sandbox.provider} was not probed`,
      details,
    }
  }
  if (!context.sandboxCapabilities) {
    return {
      id: "sandbox.capability",
      status: "failed",
      required: true,
      message: `Sandbox is enabled with provider ${sandbox.provider}, but capability discovery is not composed`,
      hint: "Use the Ralph executable with its sandbox runtime composition or disable sandbox explicitly.",
      details,
    }
  }

  try {
    const capability = SandboxCapabilitySchema.parse(
      await context.sandboxCapabilities.discover({
        backend: sandbox.provider,
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    )
    const capabilityDetails = { ...details, capability }
    const capabilityProblem = sandboxCapabilityProblem({
      capability,
      requirements: {
        backend: sandbox.provider,
        requireContainerIsolation: sandbox.require_container_isolation,
        requireNetworkIsolation: sandbox.require_network_isolation,
        networkMode: sandbox.network_mode,
      },
    })
    if (capabilityProblem) {
      return {
        id: "sandbox.capability",
        status: "failed",
        required: true,
        message: `${capabilityProblem.message}${capability.reason ? `: ${capability.reason}` : ""}`,
        ...(capabilityProblem.hint ? { hint: capabilityProblem.hint } : {}),
        details: { ...capabilityDetails, capabilityProblem },
      }
    }

    const isolation = sandboxIsolationSummary(capability)
    const completeContainerBoundary =
      capability.filesystemIsolation === "container" &&
      capability.networkIsolation === "container" &&
      capability.processIsolation === "container"
    return {
      id: "sandbox.capability",
      status: completeContainerBoundary ? "passed" : "warning",
      required: true,
      message: completeContainerBoundary
        ? `Configured sandbox provider ${sandbox.provider} is available (${isolation})`
        : `Configured sandbox provider ${sandbox.provider} is available (${isolation}), but it is not a complete container boundary${capability.reason ? `: ${capability.reason}` : ""}`,
      ...(!completeContainerBoundary
        ? {
            hint: "Use Docker, Podman or another audited OS sandbox when the workspace requires strong isolation.",
          }
        : {}),
      details: capabilityDetails,
    }
  } catch (error) {
    if (error instanceof RalphError && error.exitCode === EXIT_CODES.interrupted) throw error
    if (context.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new RalphError(
        "RALPH_SANDBOX_CAPABILITY_DISCOVERY_CANCELLED",
        `Capability discovery was cancelled for configured sandbox provider ${sandbox.provider}`,
        { exitCode: EXIT_CODES.interrupted },
      )
    }
    return {
      id: "sandbox.capability",
      status: "failed",
      required: true,
      message: `Capability discovery failed for configured sandbox provider ${sandbox.provider}`,
      hint: "Inspect the local backend and run doctor again; no alternate provider was selected.",
      details,
    }
  }
}

async function doctorChecks(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<{ checks: DoctorCheck[]; diagnostics: Diagnostic[] }> {
  const checks: DoctorCheck[] = []
  const diagnostics: Diagnostic[] = []
  checks.push({
    id: "runtime.bun",
    status: typeof Bun.version === "string" ? "passed" : "failed",
    required: true,
    message: `Bun ${Bun.version ?? "unavailable"}`,
  })

  const git = Bun.which("git")
  checks.push({
    id: "runtime.git",
    status: git ? "passed" : "failed",
    required: true,
    message: git ? `Git executable: ${git}` : "Git executable was not found",
    ...(!git ? { hint: "Install Git and ensure it is available on PATH." } : {}),
  })

  const start = workspaceStart(parsed, context)
  try {
    await access(start, constants.R_OK | constants.W_OK)
    checks.push({
      id: "filesystem.workspace",
      status: "passed",
      required: true,
      message: `Workspace directory is readable and writable: ${start}`,
    })
  } catch {
    checks.push({
      id: "filesystem.workspace",
      status: "failed",
      required: true,
      message: `Workspace directory is not readable and writable: ${start}`,
    })
  }

  try {
    const status = await inspectWorkspace(start, { exact: parsed.options.workspace !== undefined })
    checks.push({
      id: "workspace.v2",
      status: status.initialized ? "passed" : "warning",
      required: false,
      message: status.initialized
        ? `Ralph v2 workspace ${status.workspaceId} is ready`
        : "Ralph v2 workspace is not initialized",
      ...(!status.initialized ? { hint: "Run `ralph init` when you are ready." } : {}),
    })
  } catch (error) {
    checks.push({
      id: "workspace.v2",
      status: "failed",
      required: true,
      message: error instanceof Error ? error.message : "Workspace validation failed",
    })
  }

  checks.push(await sandboxDoctorCheck(parsed, context))

  checks.push({
    id: "terminal.tty",
    status: process.stdout.isTTY ? "passed" : "skipped",
    required: false,
    message: process.stdout.isTTY
      ? "Interactive terminal detected"
      : "No TTY; headless mode is available",
  })

  checks.push(...(await s04DoctorChecks(parsed, context)))

  for (const check of checks) {
    if (check.status === "failed") {
      diagnostics.push({
        code: `RALPH_DOCTOR_${check.id.toUpperCase().replaceAll(".", "_")}`,
        severity: "error",
        message: check.message,
        ...(check.hint ? { hint: check.hint } : {}),
        ...(check.details ? { details: check.details } : {}),
      })
    } else if (check.status === "warning") {
      diagnostics.push({
        code: `RALPH_DOCTOR_${check.id.toUpperCase().replaceAll(".", "_")}`,
        severity: "warning",
        message: check.message,
        ...(check.hint ? { hint: check.hint } : {}),
        ...(check.details ? { details: check.details } : {}),
      })
    }
  }

  return { checks, diagnostics }
}

export async function handleCommand(
  parsed: ParsedCli,
  context: CommandContext,
): Promise<HandledCommand> {
  const command = parsed.command
  switch (command) {
    case "help": {
      const data = helpData(context.version)
      return handled({ result: commandResult("help", data), human: helpText(context.version) })
    }
    case "version": {
      const data = { name: "ralph", version: context.version }
      return handled({
        result: commandResult("version", data),
        human: `ralph ${context.version}`,
      })
    }
    case "about": {
      const data = {
        name: "Ralph v2",
        binary: "ralph",
        version: context.version,
        authority: "Commands and deterministic policy govern models, tools, evidence and state.",
        status: "development",
      }
      return handled({
        result: commandResult("about", data),
        human: `Ralph v2 (${context.version})\nCommand-authoritative execution for small, verifiable vertical slices.\nDevelopment binary: ralph`,
      })
    }
    case "init": {
      const data = await initializeWorkspace(workspaceStart(parsed, context), context.version, {
        force: parsed.options.force,
      })
      return handled({
        result: commandResult("init", data),
        human: data.created
          ? `Ralph v2 workspace initialized at ${data.root}\nWorkspace ID: ${data.workspaceId}`
          : `Ralph v2 workspace already initialized at ${data.root}\nWorkspace ID: ${data.workspaceId}`,
      })
    }
    case "clean":
      return handleClean(parsed, context)
    case "status": {
      const workspace = await inspectWorkspace(workspaceStart(parsed, context), {
        exact: parsed.options.workspace !== undefined,
      })
      let human: string
      if (workspace.initialized && workspace.workspaceId) {
        const runs = listRuns(workspaceLayout(workspace.root).ledger, {
          workspaceId: workspace.workspaceId,
          ...(parsed.options.all ? { limit: 1_000 } : {}),
        })
        if (parsed.options.all) {
          const layout = workspaceLayout(workspace.root)
          const summaries = runs.map((run) => {
            const tasks = listRunTasks(layout.ledger, run.id)
            const completed = tasks.filter(
              (task) => task.status === "completed" || task.status === "completed_with_override",
            ).length
            const currentTask = tasks.find(
              (task) =>
                task.status !== "pending" &&
                task.status !== "completed" &&
                task.status !== "completed_with_override",
            )
            return {
              run,
              progress: {
                completed,
                total: tasks.length,
                ratio: tasks.length === 0 ? 0 : completed / tasks.length,
              },
              currentTask: currentTask ?? null,
              attemptCount: listAttempts(layout.ledger, { runId: run.id }).length,
            }
          })
          const data = { workspace, runs: summaries }
          human =
            summaries.length === 0
              ? `Workspace: ${workspace.root}\nRuns:      none`
              : [
                  `Workspace: ${workspace.root}`,
                  `Runs:      ${summaries.length}`,
                  ...summaries.map(
                    (summary) =>
                      `${summary.run.id}  ${summary.run.status.padEnd(11)} ${summary.progress.completed}/${summary.progress.total} ${progressBar(summary.progress.completed, summary.progress.total)}${summary.currentTask ? `  ${summary.currentTask.documentId}/${summary.currentTask.taskId}` : ""}`,
                  ),
                ].join("\n")
          return handled({ result: commandResult("status", data), human })
        }
        const latest = runs[0]
        human = `Workspace: initialized\nRoot:      ${workspace.root}\nState:     ${workspace.state}\nID:        ${workspace.workspaceId}\nEvents:    ${workspace.eventCount} (cursor ${workspace.eventCursor})\nRuns:      ${runs.length}\nLatest:    ${latest ? `${latest.id} (${latest.status})` : "none"}`
      } else {
        if (parsed.options.all) {
          const data = { workspace, runs: [] as const }
          return handled({
            result: commandResult("status", data),
            human: `Workspace: not initialized\nRoot:      ${workspace.root}\nRuns:      none`,
          })
        }
        human = `Workspace: not initialized\nRoot:      ${workspace.root}\nState:     ${workspace.state}\nEvents:    0\nRuns:      0\nLatest:    none`
      }
      return handled({ result: commandResult("status", workspace), human })
    }
    case "status.run":
      return handleRunStatus(parsed, context)
    case "resume":
      return handleExecution(parsed, context)
    case "stop":
      return handleStop(parsed, context)
    case "attach":
    case "replay":
      return handleAttach(parsed, context)
    case "once":
    case "loop":
    case "parallel":
    case "run":
      return handleExecution(parsed, context)
    case "events":
      return handleEvents(parsed, context)
    case "logs.tail":
      return handleLogsTail(parsed, context)
    case "tasks.list":
    case "tasks.next":
    case "tasks.done":
    case "tasks.sync":
      return handleTasks(parsed, context)
    case "migrate.inspect":
    case "migrate.apply":
    case "migrate.rollback":
      return handleMigration(parsed, context)
    case "verify":
      return handleVerifyCommand(parsed, context)
    case "judge":
      return handleJudgeCommand(parsed, context)
    case "evidence.inspect":
      return handleEvidenceInspect(parsed, context)
    case "report.last":
    case "report.show":
      return handleReport(parsed, context)
    case "review.retry":
      return handleReviewRetry(parsed, context)
    case "providers.list":
    case "providers.inspect":
    case "models.list":
    case "models.inspect":
      return handleCatalogCommand(parsed, context)
    case "auth.connect":
    case "auth.list":
    case "auth.status":
    case "auth.revoke":
      return handleAuthCommand(parsed, context)
    case "adapters.list":
    case "adapters.new":
    case "adapters.inspect":
    case "recipes.list":
    case "recipes.new":
    case "recipes.show":
    case "rules.list":
    case "rules.add":
    case "rules.clear":
      return handleOperationalCatalog(parsed, context)
    case "context.inspect":
    case "context.export":
    case "context.rotate":
      return handleContextCommand(parsed, context)
    case "checkpoint.create":
    case "checkpoint.list":
    case "checkpoint.show":
      return handleCheckpointCommand(parsed, context)
    case "rollback.preview":
    case "rollback.apply":
      return handleRollbackCommand(parsed, context)
    case "lang.current":
    case "lang.list":
    case "lang.set":
    case "lang.update":
      return handleLangCommand(parsed, context)
    case "install":
    case "update":
    case "install.rollback":
    case "uninstall":
      return handleDistributionCommand(parsed, context)
    case "profiles.list":
    case "profiles.inspect":
    case "profiles.configure":
      return handleProfilesCommand(parsed, context)
    case "model.smoke":
      return handleModelSmoke(parsed, context)
    case "config.explain":
    case "config.list":
    case "config.get":
    case "config.preview":
    case "config.set":
    case "config.unset":
    case "config.edit":
    case "config.import":
    case "config.export":
    case "config.validate":
      return handleConfig(parsed, context)
    case "prd.validate":
    case "prd.inspect":
    case "prd.format":
    case "prd.migrate":
      return handlePrd(parsed, context)
    case "doctor": {
      const assessment = await doctorChecks(parsed, context)
      const data = { checks: assessment.checks }
      const result: CommandResult<typeof data> = {
        schemaVersion: 1,
        ok: !assessment.checks.some((check) => check.required && check.status === "failed"),
        command: "doctor",
        data,
        diagnostics: assessment.diagnostics,
      }
      const symbols: Record<DoctorCheck["status"], string> = {
        passed: "PASS",
        warning: "WARN",
        failed: "FAIL",
        skipped: "SKIP",
      }
      const human = assessment.checks
        .map((check) => `${symbols[check.status].padEnd(4)} ${check.id}: ${check.message}`)
        .join("\n")
      return handled(
        { result, human },
        result.ok ? EXIT_CODES.success : EXIT_CODES.operationalError,
      )
    }
    default: {
      const unreachable: never = command
      throw new RalphError(
        "RALPH_COMMAND_UNREACHABLE",
        `Command parser returned an unknown command: ${String(unreachable)}`,
        {
          exitCode: EXIT_CODES.operationalError,
        },
      )
    }
  }
}
