import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import {
  type EffectiveConfig,
  type EffectiveRunOptions,
  EvaluationPolicySchema,
  type EvaluationProfileSnapshot,
  EvaluationProfileSnapshotSchema,
  EXIT_CODES,
  type ProfileParameters,
  RalphError,
  type RoleProfileConfig,
  RoleProfileConfigSchema,
} from "@ralph-next/domain"
import type {
  JudgeBackend,
  JudgeBackendEvent,
  JudgeBackendResolutionContext,
  JudgeCallHandle,
  JudgeEventSink,
  JudgeRequest,
} from "@ralph-next/evaluation"
import {
  type BackendCapabilities,
  type CallHandle,
  type ChildExecutionObservation,
  type ChildRunExecutionPort,
  type ChildRunWorkerSessionFactory,
  type ChildTaskBudgetState,
  childRunWorkerLinkHash,
  type ExecutionBackend,
  type ExecutionBackendLimits,
  type ExecutionBackendResolutionContext,
  type ExecutionChannel,
  type ExecutionRequest,
  type ExecutionToolContext,
  type ExecutionToolPort,
  type ExecutionToolReconciliationContext,
} from "@ralph-next/orchestration"
import {
  inspectWorkspace,
  listChildRunTree,
  loadEffectiveConfig,
  workspaceLayout,
} from "@ralph-next/persistence"
import { hashCanonicalValue } from "@ralph-next/prd"
import {
  FallbackPolicySchema,
  ProviderToolCallSchema,
  ProviderToolDefinitionSchema,
} from "@ralph-next/providers"
import {
  ChildRunObservationCallSchema,
  ChildRunProjectEventCallSchema,
  ChildTaskBudgetBoundaryCallSchema,
  ChildTaskBudgetReportCallSchema,
  ChildTaskBudgetReserveCallSchema,
  ChildTaskBudgetReserveResultSchema,
  ChildTaskBudgetSnapshotSchema,
  executeTypedWorkerOperation,
  type GitIntegrationWorkerRequest,
  type ProcessSettlement,
  type ProcessSupervisor,
  RALPH_WORKER_ADAPTER_KIND_ENV,
  type RalphWorkerRoleAdapter,
  type SupervisedProcessHandle,
  type SupervisedProcessRequest,
  shellProcessArgv,
  spawnTypedWorker,
  type TypedWorkerHandle,
  type WorkerCapabilityGrant,
  type WorkerCommandInvocation,
  type WorkerJsonValue,
  type WorkerProfileSnapshot,
  type WorkerResourcePayload,
  type WorkerRole,
  type WorkerSupervisorObserver,
  workerCommandCapabilityFingerprint,
  workerExecutableContentHash,
} from "@ralph-next/supervisor"
import {
  createBuiltinToolRegistry,
  type PermissionPromptPort,
  ProcessExecInputSchema,
  type RegisteredTool,
  ToolEffectSchema,
  ToolEffectUnsettledError,
  type ToolEvent,
  type ToolExecutionResult,
  ToolRecoveryClassificationSchema,
  ToolRegistry,
  type ToolRuntimeContext,
  ToolSettlementOutcomeSchema,
} from "@ralph-next/tool-host"
import {
  type GateExecutionContext,
  type GateExecutionOutcome,
  GateExecutorRegistry,
} from "@ralph-next/verification"
import {
  assertDurableProcessOwnerLaunchAvailable,
  executeDurableProcessParentCall,
} from "./durable-process-owner"
import {
  CommandFallbackExecutionBackend,
  CommandFallbackJudgeBackend,
  configuredExecutionCapabilities,
  configuredExecutionLimits,
  configuredJudgeCapabilities,
  type ExecutionBackendCandidate,
  type JudgeBackendCandidate,
  type S05Services,
} from "./s05-services"
import { createRalphExecutionToolPort } from "./tool-execution-port"
import { workerProfileConfigHash } from "./worker-profile"

const WORKER_HEARTBEAT_MS = 1_000
const WORKER_STARTUP_TIMEOUT_MS = 30_000
const WORKER_SHUTDOWN_GRACE_MS = 5_000
const WORKER_REQUEST_CANCEL_GRACE_MS = 2_000
const WORKER_FORCE_CLEANUP_GRACE_MS = 1_500
const DEFAULT_OPERATION_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const DEFAULT_OUTPUT_BYTES = 1_048_576
const FORBIDDEN_WORKER_ENVIRONMENT = new Set([
  "BUN_OPTIONS",
  "BUN_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "RALPH_WORKER",
  "RALPH_WORKER_ADAPTER_MODULE",
  "RALPH_WORKER_ADAPTER_HASH",
  "RALPH_DURABLE_PROCESS_OWNER",
])

type WorkerExecutionServices = Pick<S05Services, "resolveBackend" | "resolveJudge"> & {
  readonly toolPort: ExecutionToolPort
}

export type WorkerGateScope = {
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly runId: string
  readonly documentId: string
  readonly taskId: string
  readonly attemptId: string
}

export type WorkerGitScope = {
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly runId: string
  readonly attemptId?: string
}

function workerJson(value: unknown): WorkerJsonValue {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("Worker payload has no JSON representation")
  return JSON.parse(encoded) as WorkerJsonValue
}

function workerJsonObject(value: unknown): Record<string, WorkerJsonValue> {
  const serialized = workerJson(value)
  if (!serialized || typeof serialized !== "object" || Array.isArray(serialized)) {
    throw new Error("Worker payload must serialize to a JSON object")
  }
  return serialized
}

const TOOL_EVENT_TYPES = new Set<ToolEvent["type"]>([
  "tool.call.requested",
  "tool.call.authorized",
  "tool.call.started",
  "tool.output.delta",
  "tool.call.settled",
])

function isToolEventType(value: string): value is ToolEvent["type"] {
  return TOOL_EVENT_TYPES.has(value as ToolEvent["type"])
}

function boundedTimeout(deadlineAt: string | undefined): number {
  if (!deadlineAt) return DEFAULT_OPERATION_TIMEOUT_MS
  return Math.max(1, Math.min(DEFAULT_OPERATION_TIMEOUT_MS, Date.parse(deadlineAt) - Date.now()))
}

function sanitizedWorkerEnvironment(
  role: WorkerRole,
  overlay: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const environment: Record<string, string> = {}
  const selectedNames = new Map<string, string>()
  for (const source of [process.env, overlay]) {
    for (const [name, value] of Object.entries(source)) {
      if (value === undefined) continue
      const authorityName = name.toLocaleUpperCase("en-US")
      if (FORBIDDEN_WORKER_ENVIRONMENT.has(authorityName)) continue
      if (authorityName === "RALPH_WORKER_ROLE") continue
      if (authorityName === RALPH_WORKER_ADAPTER_KIND_ENV) continue

      const identity = process.platform === "win32" ? authorityName : name
      const previousName = selectedNames.get(identity)
      if (previousName !== undefined && previousName !== name) delete environment[previousName]
      environment[name] = value
      selectedNames.set(identity, name)
    }
  }
  environment.RALPH_WORKER_ROLE = role
  environment[RALPH_WORKER_ADAPTER_KIND_ENV] = "builtin"
  return environment
}

function workerLaunch() {
  const executable = realpathSync.native(process.execPath)
  const standalone = process.env.RALPH_STANDALONE_INSTALL_ROOT !== undefined
  const candidate = process.argv[1]
  if (standalone || !candidate) {
    return {
      executable,
      executableHash: workerExecutableContentHash(executable),
      launch: { kind: "standalone-executable" as const },
      args: [] as string[],
    }
  }
  let entrypoint: string
  try {
    entrypoint = realpathSync.native(resolve(candidate))
  } catch {
    return {
      executable,
      executableHash: workerExecutableContentHash(executable),
      launch: { kind: "standalone-executable" as const },
      args: [] as string[],
    }
  }
  if (entrypoint === executable) {
    return {
      executable,
      executableHash: workerExecutableContentHash(executable),
      launch: { kind: "standalone-executable" as const },
      args: [] as string[],
    }
  }
  return {
    executable,
    executableHash: workerExecutableContentHash(executable),
    launch: {
      kind: "bundled-runtime-entrypoint" as const,
      path: entrypoint,
      contentHash: workerExecutableContentHash(entrypoint),
    },
    args: [] as string[],
  }
}

async function spawnOperationWorker(input: {
  role: WorkerRole
  workspaceRoot: string
  workspaceId: string
  runId: string
  attemptId?: string
  parentWorkerId?: string
  deadlineAt?: string
  action: WorkerCapabilityGrant["action"]
  pathScopes: readonly string[]
  commands?: readonly WorkerCommandInvocation[]
  environment?: Readonly<Record<string, string | undefined>>
  shutdownGraceMs?: number
  requestCancellationGraceMs?: number
  forceCleanupGraceMs?: number
  onProgress?: WorkerSupervisorObserver["onProgress"]
  onState?: WorkerSupervisorObserver["onState"]
}): Promise<TypedWorkerHandle> {
  const launch = workerLaunch()
  const commandScopes = (input.commands ?? []).map((command) =>
    workerCommandCapabilityFingerprint(input.workspaceRoot, command),
  )
  return spawnTypedWorker(
    {
      workerId: `${input.role}-${randomUUID()}`,
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      runId: input.runId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.parentWorkerId ? { parentWorkerId: input.parentWorkerId } : {}),
      role: input.role,
      ...launch,
      cwd: input.workspaceRoot,
      environment: sanitizedWorkerEnvironment(input.role, input.environment),
      capabilities: [
        {
          action: input.action,
          pathScopes: [...new Set(input.pathScopes)],
          commandScopes,
        },
      ],
      heartbeatIntervalMs: WORKER_HEARTBEAT_MS,
      startupTimeoutMs: WORKER_STARTUP_TIMEOUT_MS,
      shutdownGraceMs: input.shutdownGraceMs ?? WORKER_SHUTDOWN_GRACE_MS,
      requestCancellationGraceMs:
        input.requestCancellationGraceMs ?? WORKER_REQUEST_CANCEL_GRACE_MS,
      forceCleanupGraceMs: input.forceCleanupGraceMs ?? WORKER_FORCE_CLEANUP_GRACE_MS,
      ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
    },
    {
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.onState ? { onState: input.onState } : {}),
    },
  )
}

function combinedAbort(external: AbortSignal | undefined): {
  controller: AbortController
  dispose(): void
} {
  const controller = new AbortController()
  const forward = (): void => {
    if (!controller.signal.aborted) controller.abort(external?.reason)
  }
  external?.addEventListener("abort", forward, { once: true })
  if (external?.aborted) forward()
  return {
    controller,
    dispose() {
      external?.removeEventListener("abort", forward)
    },
  }
}

async function effectiveConfiguration(
  context: { workspaceRoot: string; controlRoot?: string; config?: EffectiveConfig },
  environment: Readonly<Record<string, string | undefined>>,
): Promise<EffectiveConfig> {
  if (context.config) return context.config
  const root = context.controlRoot ?? context.workspaceRoot
  return loadEffectiveConfig({
    workspaceConfig: workspaceLayout(root).config,
    environment,
  })
}

type WorkerRoleRunOverrides = {
  provider: string | undefined
  model: string | undefined
  credential: string | null | undefined
  variant: string | null | undefined
  parameters: ProfileParameters | undefined
}

function profileWithRunOverrides(
  selected: RoleProfileConfig,
  overrides: WorkerRoleRunOverrides,
): RoleProfileConfig {
  const candidate: RoleProfileConfig = {
    ...selected,
    ...(overrides.provider !== undefined ? { provider: overrides.provider } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.parameters !== undefined ? { parameters: { ...overrides.parameters } } : {}),
  }
  if (overrides.credential === null) delete candidate.credential
  else if (overrides.credential !== undefined) candidate.credential = overrides.credential
  if (overrides.variant === null) delete candidate.variant
  else if (overrides.variant !== undefined) candidate.variant = overrides.variant
  return RoleProfileConfigSchema.parse(candidate)
}

function effectiveProfile(
  profileId: string,
  kind: "executor" | "external-judge" | "self-judge",
  options: EffectiveRunOptions,
  effective: EffectiveConfig,
): RoleProfileConfig {
  const selected = effective.config.profiles[profileId]
  if (!selected) throw new Error(`Worker role profile was not found: ${profileId}`)
  const overrides =
    kind === "external-judge"
      ? {
          provider: options.judgeProvider?.value,
          model: options.judgeModel?.value,
          credential: options.judgeCredential?.value,
          variant: options.judgeVariant?.value,
          parameters: options.judgeParameters?.value,
        }
      : {
          provider: options.executorProvider?.value,
          model: options.executorModel?.value,
          credential: options.executorCredential?.value,
          variant: options.executorVariant?.value,
          parameters: options.executorParameters?.value,
        }
  return profileWithRunOverrides(selected, overrides)
}

function profileSnapshot(profileId: string, config: RoleProfileConfig): WorkerProfileSnapshot {
  return {
    profileId,
    role: config.role,
    backend: config.backend,
    provider: config.provider,
    model: config.model,
    ...(config.variant ? { variant: config.variant } : {}),
    ...(config.credential ? { credentialRef: config.credential } : {}),
    configHash: workerProfileConfigHash(config),
  }
}

function evaluationProfileSnapshot(profile: WorkerProfileSnapshot): EvaluationProfileSnapshot {
  const body = {
    id: profile.profileId,
    role: profile.role,
    backend: profile.backend,
    provider: profile.provider,
    model: profile.model,
    ...(profile.variant ? { variant: profile.variant } : {}),
  }
  return EvaluationProfileSnapshotSchema.parse({
    ...body,
    contentHash: hashCanonicalValue("ralph.evaluation.profile-snapshot.v1", body),
  })
}

function orderedFallbackProfileIds(
  profileId: string,
  effective: EffectiveConfig,
): readonly string[] {
  const result: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (candidateId: string): void => {
    if (visiting.has(candidateId)) {
      throw new Error(`Worker role profile fallback cycle detected at ${candidateId}`)
    }
    if (visited.has(candidateId)) return
    const candidate = effective.config.profiles[candidateId]
    if (!candidate) throw new Error(`Worker fallback role profile was not found: ${candidateId}`)
    visiting.add(candidateId)
    visited.add(candidateId)
    result.push(candidateId)
    for (const fallbackId of candidate.fallback_profiles) visit(fallbackId)
    visiting.delete(candidateId)
  }
  visit(profileId)
  return result
}

function resolveExecutable(executable: string): string {
  const candidate = isAbsolute(executable) ? executable : Bun.which(executable)
  if (!candidate) throw new Error(`Worker command executable is unavailable: ${executable}`)
  return realpathSync.native(candidate)
}

function roleTransportCommand(
  profileId: string,
  config: RoleProfileConfig,
  workspaceRoot: string,
  intent: "executor-transport" | "judge-transport",
): WorkerCommandInvocation | undefined {
  if (config.backend !== "external-cli" || !config.external_cli) return undefined
  const declared = config.external_cli.executable
  const candidate = isAbsolute(declared) ? declared : Bun.which(declared)
  if (!candidate) {
    throw new RalphError(
      "RALPH_EXTERNAL_CLI_EXECUTABLE_UNAVAILABLE",
      `External ${
        intent === "judge-transport" ? "judge" : "executor"
      } CLI executable is unavailable for ${profileId}`,
      { exitCode: EXIT_CODES.providerUnavailable },
    )
  }
  let executable: string
  try {
    executable = realpathSync.native(candidate)
  } catch (cause) {
    throw new RalphError(
      "RALPH_EXTERNAL_CLI_EXECUTABLE_UNAVAILABLE",
      `External ${
        intent === "judge-transport" ? "judge" : "executor"
      } CLI executable cannot be resolved for ${profileId}`,
      { exitCode: EXIT_CODES.providerUnavailable, cause },
    )
  }
  const cwd = realpathSync.native(resolve(workspaceRoot, config.external_cli.cwd))
  return {
    intent,
    executable,
    executableHash: workerExecutableContentHash(executable),
    args: [...config.external_cli.args],
    cwd,
    environmentNames: Object.keys(config.external_cli.environment_refs ?? {}).sort(),
  }
}

function judgeCandidateOptions(
  options: EffectiveRunOptions,
  kind: "external" | "self",
  requestedCandidate: boolean,
): EffectiveRunOptions {
  if (requestedCandidate) return options
  const candidate = { ...options }
  if (kind === "external") {
    delete candidate.judgeProvider
    delete candidate.judgeModel
    delete candidate.judgeCredential
    delete candidate.judgeVariant
    delete candidate.judgeParameters
  } else {
    delete candidate.executorProvider
    delete candidate.executorModel
    delete candidate.executorCredential
    delete candidate.executorVariant
    delete candidate.executorParameters
  }
  return candidate
}

function executorCandidateOptions(
  options: EffectiveRunOptions,
  requestedCandidate: boolean,
): EffectiveRunOptions {
  if (requestedCandidate) return options
  const candidate = { ...options }
  delete candidate.executorProvider
  delete candidate.executorModel
  delete candidate.executorCredential
  delete candidate.executorVariant
  delete candidate.executorParameters
  return candidate
}

function roleCandidateConfig(
  effective: EffectiveConfig,
  profileId: string,
  profile: RoleProfileConfig,
): EffectiveConfig {
  return {
    ...effective,
    config: {
      ...effective.config,
      profiles: {
        ...effective.config.profiles,
        [profileId]: profile,
      },
    },
  }
}

class DeclaredWorkerJudgeBackend implements JudgeBackend {
  readonly id: string

  constructor(
    profileId: string,
    private readonly declared: ReturnType<typeof configuredJudgeCapabilities>,
  ) {
    this.id = `declared-worker-judge:${profileId}`
  }

  capabilities() {
    return { ...this.declared }
  }

  async start(): Promise<never> {
    throw new Error("A declared worker judge backend cannot be invoked directly")
  }

  async cancel(): Promise<void> {}
}

function contextResources(request: ExecutionRequest) {
  return request.contextBundle.resources.map((resource) => ({
    resource: {
      ref: resource.ref,
      contentHash: resource.contentHash,
      includedHash: resource.includedHash,
      kind: resource.kind,
      mediaType: resource.mediaType,
      byteLength: resource.originalBytes,
      includedByteLength: resource.includedBytes,
      truncated: resource.truncated,
    },
    content: resource.content,
  }))
}

class WorkerExecutionBackend implements ExecutionBackend {
  readonly id: string
  readonly #active = new Map<
    string,
    { controller: AbortController; worker?: TypedWorkerHandle; dispose(): void }
  >()

  constructor(
    private readonly base: ExecutionBackend,
    private readonly profile: WorkerProfileSnapshot,
    private readonly resolution: ExecutionBackendResolutionContext & {
      workspaceId: string
      controlRoot: string
      config: EffectiveConfig
    },
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly transport: WorkerCommandInvocation | undefined,
  ) {
    this.id = `worker:${base.id}`
  }

  capabilities(): BackendCapabilities {
    return this.base.capabilities()
  }

  limits(): ExecutionBackendLimits {
    return this.base.limits?.() ?? {}
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    if (this.#active.has(request.modelCallId)) {
      throw new Error(`Executor worker call is already active: ${request.modelCallId}`)
    }
    const cancellation = combinedAbort(request.signal)
    const active: {
      controller: AbortController
      worker?: TypedWorkerHandle
      dispose(): void
    } = { controller: cancellation.controller, dispose: cancellation.dispose }
    this.#active.set(request.modelCallId, active)
    const outcome = (async () => {
      const tools = (await channel.tools()).map((tool) => ProviderToolDefinitionSchema.parse(tool))
      const stats = channel.stats()
      const worker = await spawnOperationWorker({
        role: "executor-model",
        workspaceRoot: request.workspaceRoot,
        workspaceId: this.resolution.workspaceId,
        runId: request.runId,
        attemptId: request.attemptId,
        ...(request.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
        action: "model.execute",
        pathScopes: [request.workspaceRoot, this.resolution.controlRoot],
        ...(this.transport ? { commands: [this.transport] } : {}),
        environment: this.environment,
      })
      active.worker = worker
      try {
        const result = await worker.execute({
          requestId: request.modelCallId,
          operation: "executor-model.execute",
          requiredCapability: "model.execute",
          signal: cancellation.controller.signal,
          ...(request.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
          payload: {
            schemaVersion: 1,
            scope: {
              schemaVersion: 1,
              workspaceId: this.resolution.workspaceId,
              workspaceRoot: request.workspaceRoot,
              runId: request.runId,
              documentId: request.documentId,
              taskId: request.taskId,
              attemptId: request.attemptId,
              correlationId: request.modelCallId,
              ...(request.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
            },
            callId: request.modelCallId,
            callOrdinal: request.callOrdinal,
            profile: this.profile,
            contextManifest: request.contextManifest,
            execution: {
              task: workerJson(request.task),
              effectiveOptions: workerJson(this.resolution.effectiveOptions),
              effectiveConfig: workerJson(this.resolution.config),
              controlRoot: this.resolution.controlRoot,
              contextCanonicalJson: request.contextBundle.canonicalJson,
              protectedPaths: [...request.protectedPaths],
            },
            resources: contextResources(request),
            contextTruncations: request.contextBundle.truncations,
            tools,
            requestedReadPaths: [request.workspaceRoot],
            ...(this.transport ? { transportCommand: this.transport } : {}),
            limits: {
              maximumOutputBytes: DEFAULT_OUTPUT_BYTES,
              maximumModelCalls: stats.maximumModelCalls,
              maximumToolCalls: stats.maximumToolCalls,
              timeoutMs: boundedTimeout(request.deadlineAt),
            },
          },
          async onParentCall(call) {
            switch (call.method) {
              case "execution.reserve-model-call": {
                const value = call.payload as { callId?: unknown; turn?: unknown }
                if (typeof value?.callId !== "string" || !Number.isSafeInteger(value.turn)) {
                  throw new Error("Executor worker requested an invalid model-call reservation")
                }
                await channel.reserveModelCall({ callId: value.callId, turn: value.turn as number })
                return { reserved: true }
              }
              case "execution.execute-tool":
                return channel.executeTool(ProviderToolCallSchema.parse(call.payload), {
                  signal: cancellation.controller.signal,
                })
              case "execution.emit-event": {
                const event = call.payload as {
                  type?: unknown
                  level?: unknown
                  payload?: unknown
                }
                if (typeof event?.type !== "string") {
                  throw new Error("Executor worker emitted an invalid backend event")
                }
                await channel.emit({
                  type: event.type,
                  ...(event.level === "debug" ||
                  event.level === "info" ||
                  event.level === "warning" ||
                  event.level === "error"
                    ? { level: event.level }
                    : {}),
                  ...(event.payload &&
                  typeof event.payload === "object" &&
                  !Array.isArray(event.payload)
                    ? { payload: event.payload as Readonly<Record<string, unknown>> }
                    : {}),
                })
                return { emitted: true }
              }
              default:
                throw new Error(`Executor worker requested an unsupported service: ${call.method}`)
            }
          },
        })
        return (result.result as { outcome: Awaited<CallHandle["outcome"]> }).outcome
      } finally {
        await worker.shutdown("Executor operation settled").catch(() => undefined)
      }
    })().finally(() => {
      active.dispose()
      this.#active.delete(request.modelCallId)
    })
    void outcome.catch(() => undefined)
    return { id: request.modelCallId, outcome }
  }

  async cancel(handle: CallHandle, reason: string): Promise<void> {
    const active = this.#active.get(handle.id)
    if (!active) return
    if (!active.controller.signal.aborted) active.controller.abort(new Error(reason))
    active.worker?.cancel(handle.id, reason)
  }
}

class WorkerJudgeBackend implements JudgeBackend {
  readonly id: string
  readonly #active = new Map<
    string,
    { controller: AbortController; worker?: TypedWorkerHandle; dispose(): void }
  >()

  constructor(
    private readonly base: JudgeBackend,
    private readonly profile: WorkerProfileSnapshot,
    private readonly resolution: JudgeBackendResolutionContext & {
      workspaceId: string
      controlRoot: string
      config: EffectiveConfig
    },
    private readonly environment: Readonly<Record<string, string | undefined>>,
    private readonly transport: WorkerCommandInvocation | undefined,
  ) {
    this.id = `worker:${base.id}`
  }

  capabilities() {
    return this.base.capabilities()
  }

  async start(request: JudgeRequest, sink: JudgeEventSink): Promise<JudgeCallHandle> {
    if (this.#active.has(request.callId)) {
      throw new Error(`Judge worker call is already active: ${request.callId}`)
    }
    const cancellation = combinedAbort(request.signal)
    const active: {
      controller: AbortController
      worker?: TypedWorkerHandle
      dispose(): void
    } = { controller: cancellation.controller, dispose: cancellation.dispose }
    this.#active.set(request.callId, active)
    let rawResolve!: (value: string | undefined) => void
    const rawResponseRef = new Promise<string | undefined>((resolveRaw) => {
      rawResolve = resolveRaw
    })
    const outcome = (async () => {
      const evidence = request.bundle.evidence
      const worker = await spawnOperationWorker({
        role: "judge",
        workspaceRoot: this.resolution.workspaceRoot,
        workspaceId: this.resolution.workspaceId,
        runId: evidence.runId,
        attemptId: evidence.attemptId,
        action: "judge.evaluate",
        pathScopes: [this.resolution.workspaceRoot, this.resolution.controlRoot],
        ...(this.transport ? { commands: [this.transport] } : {}),
        environment: this.environment,
      })
      active.worker = worker
      try {
        const rubric = request.bundle.rubric
        const policy = EvaluationPolicySchema.parse({
          schemaVersion: 1,
          mode: this.resolution.kind,
          threshold: this.resolution.effectiveOptions.judgeThreshold.value,
          maxRevisionAttempts: this.resolution.effectiveOptions.maxRevisionAttempts.value,
          judgeCallRetries: this.resolution.effectiveOptions.judgeCallRetries.value,
          onJudgeUnavailable: this.resolution.effectiveOptions.judgeUnavailablePolicy.value,
          blockingSeverities: this.resolution.effectiveOptions.blockingJudgeSeverities.value,
          exhaustedPolicy: this.resolution.effectiveOptions.judgeExhaustedPolicy.value,
          rubric,
        })
        const bundle = workerJson(request.bundle)
        const result = await worker.execute({
          requestId: request.callId,
          operation: "judge.evaluate",
          requiredCapability: "judge.evaluate",
          signal: cancellation.controller.signal,
          payload: {
            schemaVersion: 1,
            scope: {
              schemaVersion: 1,
              workspaceId: this.resolution.workspaceId,
              workspaceRoot: this.resolution.workspaceRoot,
              runId: evidence.runId,
              documentId: evidence.documentId,
              taskId: evidence.taskId,
              attemptId: evidence.attemptId,
              correlationId: request.callId,
            },
            assessmentId: request.callId,
            profile: this.profile,
            evidence: workerJson(evidence),
            policy,
            evaluation: {
              kind: request.kind,
              bundle,
              bundleHash: hashCanonicalValue("ralph.worker.judge-evaluation-bundle.v1", bundle),
              prompt: request.prompt,
              effectiveOptions: workerJson(this.resolution.effectiveOptions),
              effectiveConfig: workerJson(this.resolution.config),
              controlRoot: this.resolution.controlRoot,
            },
            attachments: request.bundle.attachments.map((attachment) => ({
              resource: {
                ref: attachment.sourceRef,
                contentHash: attachment.contentHash,
                includedHash: attachment.includedContentHash,
                kind: attachment.kind,
                mediaType: "text/plain",
                byteLength: attachment.originalBytes,
                includedByteLength: attachment.includedBytes,
                truncated: attachment.truncated,
              },
              content: attachment.text,
            })),
            requestedReadPaths: [this.resolution.workspaceRoot],
            ...(this.transport ? { transportCommand: this.transport } : {}),
            maximumOutputBytes: DEFAULT_OUTPUT_BYTES,
          },
          async onParentCall(call) {
            if (call.method !== "judge.emit-event") {
              throw new Error(`Judge worker requested an unsupported service: ${call.method}`)
            }
            const event = call.payload as JudgeBackendEvent
            if (!event || typeof event !== "object" || typeof event.type !== "string") {
              throw new Error("Judge worker emitted an invalid backend event")
            }
            await sink.emit(event)
            return { emitted: true }
          },
        })
        const workerResult = result.result as {
          output: Awaited<JudgeCallHandle["outcome"]>
          rawResponseRef?: string
        }
        rawResolve(workerResult.rawResponseRef)
        return workerResult.output
      } catch (error) {
        rawResolve(undefined)
        throw error
      } finally {
        await worker.shutdown("Judge operation settled").catch(() => undefined)
      }
    })().finally(() => {
      active.dispose()
      this.#active.delete(request.callId)
    })
    void outcome.catch(() => {
      rawResolve(undefined)
    })
    return {
      id: request.callId,
      outcome,
      rawResponseRef,
      profileSnapshot: Promise.resolve(evaluationProfileSnapshot(this.profile)),
    }
  }

  async cancel(handle: JudgeCallHandle, reason: string): Promise<void> {
    const active = this.#active.get(handle.id)
    if (!active) return
    if (!active.controller.signal.aborted) active.controller.abort(new Error(reason))
    active.worker?.cancel(handle.id, reason)
  }
}

export async function createWorkerIsolatedExecutionServices(input: {
  base: S05Services
  environment?: Readonly<Record<string, string | undefined>>
}): Promise<WorkerExecutionServices> {
  const environment = input.environment ?? process.env
  return {
    toolPort: input.base.toolPort,
    async resolveBackend(profileId, context) {
      if (context.dryRun) return input.base.resolveBackend(profileId, context)
      const config = await effectiveConfiguration(context, environment)
      if (!config.config.profiles[profileId]) return undefined
      const profileConfig = effectiveProfile(
        profileId,
        "executor",
        context.effectiveOptions,
        config,
      )
      const workspaceId = context.workspaceId
      if (!workspaceId) {
        throw new Error("Executor worker resolution requires a command-supplied workspace identity")
      }
      const candidateIds = orderedFallbackProfileIds(profileId, config)
      const candidates: ExecutionBackendCandidate[] = candidateIds.map((candidateId) => {
        const requestedCandidate = candidateId === profileId
        const selectedCandidateProfile = requestedCandidate
          ? profileConfig
          : config.config.profiles[candidateId]
        if (!selectedCandidateProfile) {
          throw new Error(`Executor worker fallback profile disappeared: ${candidateId}`)
        }
        const candidateProfile = RoleProfileConfigSchema.parse(selectedCandidateProfile)
        if (candidateProfile.role !== "executor") {
          throw new RalphError(
            "RALPH_PROFILE_FALLBACK_ROLE_MISMATCH",
            `Executor fallback ${candidateId} does not preserve role executor`,
            { exitCode: EXIT_CODES.invalidUsage },
          )
        }
        return {
          profileId: candidateId,
          capabilities: configuredExecutionCapabilities(candidateProfile),
          limits: configuredExecutionLimits(candidateProfile),
          create: async () => {
            const transport = roleTransportCommand(
              candidateId,
              candidateProfile,
              context.workspaceRoot,
              "executor-transport",
            )
            const boundProfile =
              transport &&
              candidateProfile.backend === "external-cli" &&
              candidateProfile.external_cli
                ? RoleProfileConfigSchema.parse({
                    ...candidateProfile,
                    external_cli: {
                      ...candidateProfile.external_cli,
                      executable: transport.executable,
                    },
                  })
                : candidateProfile
            const candidateOptions = executorCandidateOptions(
              context.effectiveOptions,
              requestedCandidate,
            )
            const isolatedProfile = RoleProfileConfigSchema.parse({
              ...boundProfile,
              fallback_profiles: [],
              fallback_on: [],
            })
            const candidateConfig = roleCandidateConfig(config, candidateId, isolatedProfile)
            const resolution = {
              ...context,
              effectiveOptions: candidateOptions,
              workspaceId,
              controlRoot: context.controlRoot ?? context.workspaceRoot,
              config: candidateConfig,
            }
            const base = await input.base.resolveBackend(candidateId, resolution)
            if (!base) {
              throw new RalphError(
                "RALPH_EXECUTOR_BACKEND_UNAVAILABLE",
                `Executor backend is unavailable for fallback candidate ${candidateId}`,
                { exitCode: EXIT_CODES.providerUnavailable },
              )
            }
            return new WorkerExecutionBackend(
              base,
              profileSnapshot(candidateId, isolatedProfile),
              resolution,
              environment,
              transport,
            )
          },
        }
      })
      if (candidates.length === 1) {
        return (candidates[0] as ExecutionBackendCandidate).create()
      }
      return new CommandFallbackExecutionBackend(
        profileId,
        candidates,
        FallbackPolicySchema.parse({ allowedFailures: profileConfig.fallback_on }),
      )
    },
    async resolveJudge(profileId, context) {
      if (context.dryRun) return input.base.resolveJudge(profileId, context)
      const config = await effectiveConfiguration(context, environment)
      if (!config.config.profiles[profileId]) return undefined
      const profileConfig = effectiveProfile(
        profileId,
        context.kind === "external" ? "external-judge" : "self-judge",
        context.effectiveOptions,
        config,
      )
      const workspaceId = context.workspaceId
      if (!workspaceId) {
        throw new Error("Judge worker resolution requires a command-supplied workspace identity")
      }
      const expectedRole = context.kind === "external" ? "judge" : "executor"
      const candidateIds = orderedFallbackProfileIds(profileId, config)
      const candidates: JudgeBackendCandidate[] = candidateIds.map((candidateId) => {
        const requestedCandidate = candidateId === profileId
        const selectedCandidateProfile = requestedCandidate
          ? profileConfig
          : config.config.profiles[candidateId]
        if (!selectedCandidateProfile) {
          throw new Error(`Judge worker fallback profile disappeared: ${candidateId}`)
        }
        const candidateProfile = RoleProfileConfigSchema.parse(selectedCandidateProfile)
        if (candidateProfile.role !== expectedRole) {
          throw new RalphError(
            "RALPH_PROFILE_FALLBACK_ROLE_MISMATCH",
            `Judge fallback ${candidateId} does not preserve role ${expectedRole}`,
            { exitCode: EXIT_CODES.invalidUsage },
          )
        }
        return {
          profileId: candidateId,
          capabilities: configuredJudgeCapabilities(candidateProfile),
          create: async () => {
            const transport = roleTransportCommand(
              candidateId,
              candidateProfile,
              context.workspaceRoot,
              "judge-transport",
            )
            const boundProfile =
              transport &&
              candidateProfile.backend === "external-cli" &&
              candidateProfile.external_cli
                ? RoleProfileConfigSchema.parse({
                    ...candidateProfile,
                    external_cli: {
                      ...candidateProfile.external_cli,
                      executable: transport.executable,
                    },
                  })
                : candidateProfile
            const candidateOptions = judgeCandidateOptions(
              context.effectiveOptions,
              context.kind,
              requestedCandidate,
            )
            const isolatedProfile = RoleProfileConfigSchema.parse({
              ...boundProfile,
              fallback_profiles: [],
              fallback_on: [],
            })
            const candidateConfig = roleCandidateConfig(config, candidateId, isolatedProfile)
            const candidateProfileSnapshot = profileSnapshot(candidateId, isolatedProfile)
            return new WorkerJudgeBackend(
              new DeclaredWorkerJudgeBackend(
                candidateId,
                configuredJudgeCapabilities(isolatedProfile),
              ),
              candidateProfileSnapshot,
              {
                ...context,
                effectiveOptions: candidateOptions,
                workspaceId,
                controlRoot: context.controlRoot ?? context.workspaceRoot,
                config: candidateConfig,
              },
              environment,
              transport,
            )
          },
        }
      })
      if (candidates.length === 1) return (candidates[0] as JudgeBackendCandidate).create()
      return new CommandFallbackJudgeBackend(
        profileId,
        candidates,
        FallbackPolicySchema.parse({ allowedFailures: profileConfig.fallback_on }),
      )
    },
  }
}

type ToolOuterContext = ExecutionToolContext | ExecutionToolReconciliationContext

function riskForWorker(risk: RegisteredTool["definition"]["risk"]) {
  switch (risk) {
    case "read":
      return "read-only" as const
    case "write":
      return "workspace-write" as const
    case "process":
      return "command" as const
    case "network":
      return "network" as const
    case "external-effect":
      return "external-effect" as const
    case "destructive":
      return "destructive" as const
  }
}

function toolCommand(
  tool: RegisteredTool,
  input: unknown,
  runtime: ToolRuntimeContext,
): WorkerCommandInvocation | undefined {
  if (tool.definition.name !== "process.exec") return undefined
  const parsed = ProcessExecInputSchema.parse(input)
  const argv =
    parsed.mode === "direct"
      ? [parsed.executable, ...parsed.args]
      : shellProcessArgv(
          {
            kind: parsed.shell.kind,
            script: parsed.script,
            ...(parsed.shell.executable ? { executable: parsed.shell.executable } : {}),
          },
          runtime.session.environment ?? {},
        )
  const [declaredExecutable, ...args] = argv
  if (!declaredExecutable) throw new Error("Process tool produced an empty command projection")
  const executable = resolveExecutable(declaredExecutable)
  const cwd = realpathSync.native(resolve(runtime.session.workspaceRoot, parsed.cwd))
  return {
    intent: "tool",
    executable,
    executableHash: workerExecutableContentHash(executable),
    args,
    cwd,
    environmentNames: Object.keys(runtime.session.environment ?? {}).sort(),
  }
}

function validatedToolExecutionResult(
  value: unknown,
  expectedOutcome: string,
): ToolExecutionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool worker returned a non-object execution result")
  }
  const record = value as Record<string, unknown>
  const outcome =
    record.outcome === undefined ? "success" : ToolSettlementOutcomeSchema.parse(record.outcome)
  if (outcome !== expectedOutcome) throw new Error("Tool worker outcome binding is inconsistent")
  const outputRefs = Array.isArray(record.outputRefs)
    ? record.outputRefs.map((item) => String(item))
    : []
  const effects = Array.isArray(record.effects)
    ? record.effects.map((effect) => ToolEffectSchema.parse(effect))
    : []
  return {
    outcome,
    content: record.content ?? null,
    outputRefs,
    effects,
    retryable: record.retryable === true,
    recovery: ToolRecoveryClassificationSchema.parse(record.recovery),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  }
}

export function createWorkerIsolatedToolPort(
  input: { prompt?: PermissionPromptPort } = {},
): ExecutionToolPort {
  const activeContext = new AsyncLocalStorage<ToolOuterContext>()
  const builtins = createBuiltinToolRegistry()
  const proxies = new ToolRegistry()
  for (const name of builtins.names()) {
    const tool = builtins.get(name)
    if (!tool) continue
    proxies.register({
      definition: tool.definition,
      inputSchema: tool.inputSchema,
      assess(toolInput, runtime) {
        if (tool.definition.name === "process.exec") {
          assertDurableProcessOwnerLaunchAvailable(runtime.session.workspaceRoot)
        }
        return tool.assess(toolInput, runtime)
      },
      async execute(toolInput, runtime) {
        const outer = activeContext.getStore()
        if (!outer) throw new Error("Tool worker execution lost its command-owned context")
        const workspace = await inspectWorkspace(outer.controlRoot ?? outer.workspaceRoot, {
          exact: true,
        })
        if (!workspace.initialized || !workspace.workspaceId) {
          throw new Error("Tool worker execution requires an initialized workspace identity")
        }
        const workspaceId = workspace.workspaceId
        const command = toolCommand(tool, toolInput, runtime)
        const processInput = command ? ProcessExecInputSchema.parse(toolInput) : undefined
        const controlRoot = outer.controlRoot ?? outer.workspaceRoot
        const worker = await spawnOperationWorker({
          role: "tool-gate",
          workspaceRoot: runtime.session.workspaceRoot,
          workspaceId,
          runId: runtime.session.runId,
          attemptId: runtime.session.attemptId,
          ...(runtime.session.deadlineAt ? { deadlineAt: runtime.session.deadlineAt } : {}),
          action: "tool.execute",
          pathScopes: [runtime.session.workspaceRoot, controlRoot],
          ...(command ? { commands: [command] } : {}),
          ...(runtime.session.environment ? { environment: runtime.session.environment } : {}),
          onProgress: async (progress) => {
            const detail = progress.detail
            if (!detail) return
            const eventType = detail.eventType
            if (!eventType || !isToolEventType(eventType)) return
            await runtime.events.emit({
              type: eventType,
              toolCallId: runtime.toolCallId,
              payload: {
                source: "typed-worker",
                summary: detail.summary,
                ...(detail.text ? { text: detail.text } : {}),
              },
            })
          },
        })
        try {
          const risk = riskForWorker(tool.definition.risk)
          const result = await executeTypedWorkerOperation(
            worker,
            "tool.execute",
            {
              schemaVersion: 1,
              scope: {
                schemaVersion: 1,
                workspaceId,
                workspaceRoot: runtime.session.workspaceRoot,
                runId: runtime.session.runId,
                documentId: runtime.session.documentId,
                taskId: runtime.session.taskId,
                attemptId: runtime.session.attemptId,
                correlationId: runtime.toolCallId,
                ...(runtime.session.deadlineAt ? { deadlineAt: runtime.session.deadlineAt } : {}),
              },
              modelCallId: runtime.session.modelCallId,
              toolCall: {
                callId: runtime.toolCallId,
                name: tool.definition.name,
                arguments: workerJsonObject(toolInput),
              },
              journalBinding: {
                intentId: runtime.toolCallId,
                argumentsHash: runtime.argumentsHash,
                idempotencyKey: runtime.idempotencyKey,
              },
              runtime: {
                policy: workerJson(runtime.policy),
                session: workerJson({
                  maximumToolCalls: runtime.session.maximumToolCalls,
                  environment: runtime.session.environment ?? {},
                  secretValues: runtime.session.secretValues ?? [],
                  telemetry: outer.telemetry,
                }),
                controlRoot,
              },
              executionKind: command ? "command" : "builtin",
              authorization: {
                allowed: true,
                decisionRef: `tool-journal:${runtime.toolCallId}`,
                policyHash: hashCanonicalValue("ralph.worker.tool-policy.v1", runtime.policy),
                risk,
              },
              requestedReadPaths: [runtime.session.workspaceRoot],
              requestedWritePaths: risk === "read-only" ? [] : [runtime.session.workspaceRoot],
              ...(command ? { command } : {}),
              timeoutMs: boundedTimeout(runtime.session.deadlineAt),
              maximumOutputBytes: DEFAULT_OUTPUT_BYTES,
              maximumRawOutputBytes: DEFAULT_OUTPUT_BYTES,
            },
            {
              ...(runtime.session.signal && !command ? { signal: runtime.session.signal } : {}),
              async onParentCall(parentCall) {
                if (parentCall.method !== "tool.process.execute" || !command || !processInput) {
                  throw new Error("Tool worker requested an unavailable command-supervisor service")
                }
                return executeDurableProcessParentCall(parentCall.payload, {
                  scope: {
                    workspaceId,
                    workspaceRoot: runtime.session.workspaceRoot,
                    controlRoot,
                    runId: runtime.session.runId,
                    documentId: runtime.session.documentId,
                    taskId: runtime.session.taskId,
                    attemptId: runtime.session.attemptId,
                  },
                  binding: {
                    intentId: runtime.toolCallId,
                    argumentsHash: runtime.argumentsHash,
                    idempotencyKey: runtime.idempotencyKey,
                  },
                  command,
                  environment: runtime.session.environment ?? {},
                  secretValues: runtime.session.secretValues ?? [],
                  ...(processInput.stdin !== undefined ? { stdin: processInput.stdin } : {}),
                  maximumTimeoutMs: Math.min(
                    processInput.timeoutMs ?? runtime.policy.limits.maxProcessTimeoutMs,
                    runtime.policy.limits.maxProcessTimeoutMs,
                  ),
                  maximumOutputBytes: Math.min(
                    processInput.outputLimitBytes ?? runtime.policy.limits.maxProcessOutputBytes,
                    runtime.policy.limits.maxProcessOutputBytes,
                  ),
                  maximumRawOutputBytes: runtime.policy.limits.maxProcessRawOutputBytes,
                  telemetry: outer.telemetry,
                  ...(runtime.session.signal ? { signal: runtime.session.signal } : {}),
                })
              },
            },
          )
          const decoded = JSON.parse(result.result.output)
          return validatedToolExecutionResult(decoded, result.result.outcome)
        } catch (error) {
          if (command) {
            throw new ToolEffectUnsettledError(
              "Durable process transport ended before the owner result reached ToolHost",
              { cause: error },
            )
          }
          throw error
        } finally {
          await worker.shutdown("Tool effect settled").catch(() => undefined)
        }
      },
    })
  }
  const base = createRalphExecutionToolPort({
    registry: proxies,
    ...(input.prompt ? { prompt: input.prompt } : {}),
  })
  return {
    reconcile(context) {
      return activeContext.run(context, () => base.reconcile(context))
    },
    materialize(context) {
      return activeContext.run(context, () => base.materialize(context))
    },
    execute(call, context) {
      return activeContext.run(context, () => base.execute(call, context))
    },
  }
}

function gateCommand(
  specification: Parameters<GateExecutorRegistry["execute"]>[0],
  workspaceRoot: string,
): WorkerCommandInvocation | undefined {
  if (specification.type !== "command") return undefined
  const executable = resolveExecutable(specification.command.executable)
  const cwd = realpathSync.native(resolve(workspaceRoot, specification.command.cwd ?? "."))
  return {
    intent: "gate",
    executable,
    executableHash: workerExecutableContentHash(executable),
    args: [...specification.command.args],
    cwd,
    environmentNames: Object.keys(specification.command.environmentRefs ?? {}).sort(),
  }
}

async function executeGateWorker(
  scope: WorkerGateScope,
  specification: Parameters<GateExecutorRegistry["execute"]>[0],
  context: GateExecutionContext,
): Promise<GateExecutionOutcome> {
  const command = gateCommand(specification, scope.workspaceRoot)
  const worker = await spawnOperationWorker({
    role: "tool-gate",
    workspaceRoot: scope.workspaceRoot,
    workspaceId: scope.workspaceId,
    runId: scope.runId,
    attemptId: scope.attemptId,
    ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
    action: "gate.execute",
    pathScopes: [scope.workspaceRoot],
    ...(command ? { commands: [command] } : {}),
    ...(context.environment ? { environment: context.environment } : {}),
  })
  try {
    const planHash = hashCanonicalValue("ralph.worker.gate-plan.v1", specification)
    const outcome = await executeTypedWorkerOperation(
      worker,
      "gate.execute",
      {
        schemaVersion: 1,
        scope: {
          schemaVersion: 1,
          workspaceId: scope.workspaceId,
          workspaceRoot: scope.workspaceRoot,
          runId: scope.runId,
          documentId: scope.documentId,
          taskId: scope.taskId,
          attemptId: scope.attemptId,
          correlationId: `${scope.attemptId}:${specification.id}`,
          ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
        },
        gateId: specification.id,
        gatePlanRef: `gate-plan:${planHash}`,
        gatePlanHash: planHash,
        category: specification.category,
        blocking: specification.blocking,
        skipPolicy: specification.skipPolicy,
        criterionIds:
          specification.type === "instruction" ? [] : [...(specification.criterionIds ?? [])],
        specification: workerJson(specification),
        invocation: command
          ? {
              kind: "command",
              command,
              successExitCodes:
                specification.type === "command" ? specification.command.successExitCodes : [0],
            }
          : {
              kind: "adapter",
              adapterId: specification.type,
              input: workerJsonObject(specification),
            },
        requestedReadPaths: [scope.workspaceRoot],
        requestedWritePaths: command ? [scope.workspaceRoot] : [],
        // The worker/scope deadline can stop the operation sooner, but this
        // field remains the command-owned timeout recorded in gate evidence.
        timeoutMs:
          specification.type === "command"
            ? specification.command.timeoutMs
            : boundedTimeout(context.deadlineAt),
        maximumOutputBytes:
          specification.type === "command"
            ? specification.command.outputLimitBytes
            : DEFAULT_OUTPUT_BYTES,
      },
      {
        signal: context.signal,
        async onParentCall(call) {
          if (call.method !== "gate.persist-output" || !context.persistOutput) {
            throw new Error("Gate worker requested unavailable output persistence")
          }
          const value = call.payload as { gateId?: unknown; stream?: unknown; content?: unknown }
          if (
            value.gateId !== specification.id ||
            (value.stream !== "stdout" && value.stream !== "stderr") ||
            typeof value.content !== "string"
          ) {
            throw new Error("Gate worker output persistence request is invalid")
          }
          return context.persistOutput(value.gateId, value.stream, value.content)
        },
      },
    )
    const result = outcome.result.result
    return {
      status: result.status,
      ...(result.command !== undefined ? { command: result.command } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      outputRefs: [...result.outputRefs],
      ...(result.stdoutBytes !== undefined ? { stdoutBytes: result.stdoutBytes } : {}),
      ...(result.stderrBytes !== undefined ? { stderrBytes: result.stderrBytes } : {}),
      ...(result.outputTruncated !== undefined ? { outputTruncated: result.outputTruncated } : {}),
      ...(result.rawOutputTruncated !== undefined
        ? { rawOutputTruncated: result.rawOutputTruncated }
        : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    }
  } finally {
    await worker.shutdown("Gate operation settled").catch(() => undefined)
  }
}

export function createWorkerGateRegistry(scope: WorkerGateScope): GateExecutorRegistry {
  const registry = new GateExecutorRegistry()
  for (const type of ["instruction", "command", "file", "schema", "git", "artifact"] as const) {
    registry.register(type, (specification, context) =>
      executeGateWorker(scope, specification, context),
    )
  }
  return registry
}

function gitCommandInvocation(request: SupervisedProcessRequest): WorkerCommandInvocation {
  if (request.shell !== false && request.shell !== undefined) {
    throw new Error("Git worker accepts direct argv commands only")
  }
  const executable = resolveExecutable(request.executable)
  return {
    intent: "git-integrate",
    executable,
    executableHash: workerExecutableContentHash(executable),
    args: [...request.args],
    cwd: realpathSync.native(request.cwd),
    environmentNames: Object.keys(request.environment).sort(),
  }
}

class WorkerGitProcessSupervisor implements ProcessSupervisor {
  constructor(private readonly scope: WorkerGitScope) {}

  which(executable: string): string | null {
    return Bun.which(executable)
  }

  async start(request: SupervisedProcessRequest): Promise<SupervisedProcessHandle> {
    if (request.stdin !== undefined) {
      throw new Error("Git worker does not accept stdin-bearing commands")
    }
    const cancellation = combinedAbort(request.signal)
    let worker: TypedWorkerHandle | undefined
    const requestId = `git-command-${randomUUID()}`
    const settlement = (async (): Promise<ProcessSettlement> => {
      const command = gitCommandInvocation(request)
      worker = await spawnOperationWorker({
        role: "git-integration",
        workspaceRoot: this.scope.workspaceRoot,
        workspaceId: this.scope.workspaceId,
        runId: this.scope.runId,
        ...(this.scope.attemptId ? { attemptId: this.scope.attemptId } : {}),
        action: "integration.execute",
        pathScopes: [this.scope.workspaceRoot],
        commands: [command],
        environment: request.environment,
      })
      try {
        const result = await executeTypedWorkerOperation(
          worker,
          "git-integration.execute",
          {
            schemaVersion: 1,
            scope: {
              schemaVersion: 1,
              workspaceId: this.scope.workspaceId,
              workspaceRoot: this.scope.workspaceRoot,
              runId: this.scope.runId,
              ...(this.scope.attemptId ? { attemptId: this.scope.attemptId } : {}),
              correlationId: requestId,
            },
            integrationId: requestId,
            decisionRef: `command-owned:${requestId}`,
            policyHash: hashCanonicalValue("ralph.worker.git-command.v1", command),
            action: "command",
            repositoryRoot: this.scope.workspaceRoot,
            strategy: "none",
            gitCommand: command,
            timeoutMs: request.timeoutMs,
            maximumOutputBytes: request.outputLimitBytes,
            maximumRawOutputBytes: request.rawOutputLimitBytes,
          } satisfies GitIntegrationWorkerRequest,
          { requestId, signal: cancellation.controller.signal },
        )
        const processResult = result.result.process
        if (!processResult) throw new Error("Git worker omitted its process settlement")
        if (processResult.stdout) await request.onOutput?.("stdout", processResult.stdout)
        if (processResult.stderr) await request.onOutput?.("stderr", processResult.stderr)
        return processResult
      } finally {
        await worker.shutdown("Git command settled").catch(() => undefined)
      }
    })().finally(cancellation.dispose)
    void settlement.catch(() => undefined)
    return {
      settlement,
      async cancel(reason = "Git worker cancellation requested") {
        if (!cancellation.controller.signal.aborted) {
          cancellation.controller.abort(new Error(reason))
        }
        worker?.cancel(requestId, reason)
      },
      async forceKill(reason = "Git worker force termination requested") {
        if (!cancellation.controller.signal.aborted) {
          cancellation.controller.abort(new Error(reason))
        }
        await worker?.forceKill(reason)
      },
    }
  }

  async run(request: SupervisedProcessRequest): Promise<ProcessSettlement> {
    return (await this.start(request)).settlement
  }
}

export function createWorkerGitProcessSupervisor(scope: WorkerGitScope): ProcessSupervisor {
  return new WorkerGitProcessSupervisor(scope)
}

function inlineJsonResource(ref: string, kind: string, value: unknown): WorkerResourcePayload {
  const content = JSON.stringify(workerJson(value))
  const byteLength = Buffer.byteLength(content, "utf8")
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex")
  return {
    resource: {
      ref,
      kind,
      contentHash,
      includedHash: contentHash,
      mediaType: "application/json",
      byteLength,
      includedByteLength: byteLength,
      truncated: false,
    },
    content,
  }
}

function workerBudgetSnapshot(state: ChildTaskBudgetState) {
  return ChildTaskBudgetSnapshotSchema.parse({
    limit: state.limit,
    consumed: state.consumed,
    ...(state.lastExecution
      ? {
          lastExecution: {
            runId: state.lastExecution.runId,
            documentId: state.lastExecution.documentId,
            taskId: state.lastExecution.taskId,
            effectiveOptions: state.lastExecution.resolution.options,
            optionsHash: state.lastExecution.resolution.optionsHash,
            notices: [...state.lastExecution.resolution.notices],
            ...(state.lastExecution.judgeAvailable !== undefined
              ? { judgeAvailable: state.lastExecution.judgeAvailable }
              : {}),
          },
        }
      : {}),
  })
}

export const createWorkerChildRunSession: ChildRunWorkerSessionFactory = async (input) => {
  if (input.parentPolicy === "survive-parent") {
    throw new RalphError(
      "RALPH_CHILD_SURVIVE_PARENT_OWNER_REQUIRED",
      "survive-parent cannot use the parent-owned worker process tree without a separately transferable writer/supervisor",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  if (!Number.isSafeInteger(input.maximumDepth) || input.maximumDepth < 1) {
    throw new RalphError(
      "RALPH_CHILD_MAXIMUM_DEPTH_INVALID",
      "The child worker requires a positive maximum depth authorized by the compiled graph",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  if (!Number.isSafeInteger(input.cancellationGraceMs) || input.cancellationGraceMs < 250) {
    throw new RalphError(
      "RALPH_CHILD_CANCELLATION_GRACE_INVALID",
      "The child worker cancellation grace must be a positive bounded duration",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  let activeObserve: ((observation: ChildExecutionObservation) => Promise<void>) | undefined
  let latestObservation: ChildExecutionObservation | undefined
  const parentWorkerId = input.parentWorkerId ?? `run:${input.parentRunId}`
  const worker = await spawnOperationWorker({
    role: "child-run",
    workspaceRoot: input.workspaceRoot,
    workspaceId: input.workspaceId,
    runId: input.childRunId,
    parentWorkerId,
    action: "child.execute",
    pathScopes: [input.workspaceRoot, input.executionRoot],
    environment: input.environment,
    shutdownGraceMs: input.cancellationGraceMs,
    requestCancellationGraceMs: input.cancellationGraceMs,
    ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
    onState: async (snapshot) => {
      if (
        snapshot.state !== "busy" ||
        !snapshot.lastControlHeartbeatAt ||
        !activeObserve ||
        !latestObservation
      ) {
        return
      }
      await activeObserve({
        ...latestObservation,
        heartbeatAt: snapshot.lastControlHeartbeatAt,
      })
    },
  })
  const identity = await worker.ready
  const owner = {
    ownerInstanceId: identity.workerId,
    pid: identity.pid,
    processStartToken: identity.processStartToken,
    hostname: identity.hostname,
  }
  let used = false
  let activeRequestId: string | undefined
  let lifecycleMutation = Promise.resolve()
  let terminateAfterOperation: ((reason: string) => Promise<void>) | undefined
  const orderedLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = lifecycleMutation.then(operation, operation)
    lifecycleMutation = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const assertAuthorizedChildTreeRun = (runId: string): void => {
    if (runId === input.childRunId) return
    const descendants = listChildRunTree(
      workspaceLayout(input.workspaceRoot).ledger,
      input.childRunId,
    )
    if (!descendants.some((link) => link.childRunId === runId)) {
      throw new Error("Child worker requested authority for a run outside its durable subtree")
    }
  }

  const execute = async (
    operation: "execute" | "reconcile-terminal",
    request:
      | Parameters<ChildRunExecutionPort["execute"]>[0]
      | Parameters<ChildRunExecutionPort["reconcileTerminal"]>[0],
  ) => {
    if (used) throw new Error("A child-run worker session accepts one coordinator operation")
    const terminateOperation = terminateAfterOperation
    if (!terminateOperation) {
      throw new Error("Child worker termination boundary was not initialized")
    }
    used = true
    if (
      request.link.id !== input.linkId ||
      request.link.childRunId !== input.childRunId ||
      request.link.parentRunId !== input.parentRunId ||
      request.link.parentDocumentId !== input.parentDocumentId ||
      request.link.parentTaskId !== input.parentTaskId ||
      request.link.parentPolicy !== input.parentPolicy
    ) {
      throw new Error("Child-run worker session request changed its durable parent/child binding")
    }
    const lease = request.assertLease()
    if (
      lease.id.length === 0 ||
      lease.workspaceId !== input.workspaceId ||
      lease.runId !== input.childRunId ||
      lease.ownerInstanceId !== owner.ownerInstanceId ||
      lease.pid !== owner.pid ||
      lease.processStartToken !== owner.processStartToken ||
      lease.hostname !== owner.hostname ||
      lease.kind !== "run-supervisor" ||
      lease.resourceKey !== `child-run:${input.childRunId}` ||
      lease.parentRunId !== input.parentRunId ||
      lease.parentWorkerId !== parentWorkerId ||
      lease.workerId !== identity.workerId ||
      request.link.leaseId !== lease.id ||
      !lease.scope.includes("child:supervise") ||
      lease.status !== "active"
    ) {
      throw new Error("Child-run worker lease is not owned by the spawned Ralph child instance")
    }
    const graphRootFile = realpathSync.native(resolve(input.executionRoot, request.graph.rootFile))
    const effectiveOptions = inlineJsonResource(
      `effective-options:${input.childRunId}`,
      "effective-run-options",
      request.effectiveOptions,
    )
    const optionResolution = inlineJsonResource(
      `option-resolution:${input.childRunId}`,
      "run-option-resolution",
      input.optionResolution,
    )
    const parentLinkHash = childRunWorkerLinkHash(request.link)
    activeObserve = request.observe
    latestObservation = {
      status: "starting",
      observability: request.link.observability,
      heartbeatAt: new Date().toISOString(),
    }
    if (input.maximumDepth < request.link.depth) {
      throw new Error("Child-run worker maximum depth is narrower than its durable link")
    }
    const workerRequestId = `child-run:${request.link.id}:${operation}`
    const executionSignal =
      operation === "execute"
        ? ((request as Parameters<ChildRunExecutionPort["execute"]>[0]).signal ?? input.signal)
        : undefined
    activeRequestId = workerRequestId
    try {
      const result = await executeTypedWorkerOperation(
        worker,
        "child-run.execute",
        {
          schemaVersion: 1,
          scope: {
            schemaVersion: 1,
            workspaceId: input.workspaceId,
            workspaceRoot: input.workspaceRoot,
            runId: input.childRunId,
            documentId: request.childDocument.id,
            correlationId: request.link.id,
            ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
          },
          operation,
          parentRunId: input.parentRunId,
          childRunId: input.childRunId,
          parentDocumentId: input.parentDocumentId,
          parentTaskId: input.parentTaskId,
          parentLinkRef: request.link.id,
          parentLinkHash,
          leaseId: lease.id,
          executionRoot: input.executionRoot,
          graphRootFile,
          childDocumentId: request.childDocument.id,
          childDocumentDefinitionHash: request.childDocument.definitionHash,
          graphDefinitionHash: request.graph.definitionHash,
          effectiveOptions,
          optionResolution,
          taskBudget: workerBudgetSnapshot(input.taskBudget.snapshot()),
          mode: request.effectiveOptions.mode.value,
          depth: request.link.depth,
          maximumDepth: input.maximumDepth,
          parentPolicy: request.link.parentPolicy,
        },
        {
          requestId: workerRequestId,
          ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}),
          ...(executionSignal ? { signal: executionSignal } : {}),
          async onParentCall(call) {
            switch (call.method) {
              case "child.budget.reserve": {
                const budgetRequest = ChildTaskBudgetReserveCallSchema.parse(call.payload)
                if (
                  budgetRequest.childRunId !== input.childRunId ||
                  budgetRequest.parentLinkRef !== input.linkId
                ) {
                  throw new Error("Child budget reservation escaped its worker session binding")
                }
                assertAuthorizedChildTreeRun(budgetRequest.task.runId)
                const reserved = await input.taskBudget.reserve({
                  runId: budgetRequest.task.runId,
                  task: {
                    documentId: budgetRequest.task.documentId,
                    taskId: budgetRequest.task.taskId,
                    taskSpecHash: budgetRequest.task.taskSpecHash,
                  },
                  resolution: {
                    options: budgetRequest.effectiveOptions,
                    optionsHash: budgetRequest.optionsHash,
                    notices: budgetRequest.notices,
                  },
                })
                return ChildTaskBudgetReserveResultSchema.parse({
                  schemaVersion: 1,
                  granted: reserved.granted,
                  snapshot: workerBudgetSnapshot(reserved.state),
                })
              }
              case "child.budget.report": {
                const report = ChildTaskBudgetReportCallSchema.parse(call.payload)
                if (
                  report.childRunId !== input.childRunId ||
                  report.parentLinkRef !== input.linkId
                ) {
                  throw new Error("Child budget report escaped its worker session binding")
                }
                assertAuthorizedChildTreeRun(report.task.runId)
                return workerBudgetSnapshot(
                  await input.taskBudget.report({
                    runId: report.task.runId,
                    task: {
                      documentId: report.task.documentId,
                      taskId: report.task.taskId,
                      taskSpecHash: report.task.taskSpecHash,
                    },
                    ...(report.judgeAvailable !== undefined
                      ? { judgeAvailable: report.judgeAvailable }
                      : {}),
                  }),
                )
              }
              case "child.budget.mark-boundary": {
                const boundary = ChildTaskBudgetBoundaryCallSchema.parse(call.payload)
                if (
                  boundary.childRunId !== input.childRunId ||
                  boundary.parentLinkRef !== input.linkId
                ) {
                  throw new Error("Child budget boundary escaped its worker session binding")
                }
                assertAuthorizedChildTreeRun(boundary.boundaryRunId)
                await input.taskBudget.markBoundary(boundary.boundaryRunId)
                return { schemaVersion: 1, accepted: true }
              }
              case "child.observe": {
                const observation = ChildRunObservationCallSchema.parse(call.payload)
                if (
                  observation.childRunId !== input.childRunId ||
                  observation.parentLinkRef !== input.linkId
                ) {
                  throw new Error("Child observation escaped its worker session binding")
                }
                const parsed = observation.observation
                const normalized: ChildExecutionObservation = {
                  observability: parsed.observability,
                  ...(parsed.status !== undefined ? { status: parsed.status } : {}),
                  ...(parsed.heartbeatAt !== undefined ? { heartbeatAt: parsed.heartbeatAt } : {}),
                  ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
                }
                latestObservation = normalized
                await request.observe(normalized)
                return { schemaVersion: 1, accepted: true }
              }
              case "child.project-event": {
                const projection = ChildRunProjectEventCallSchema.parse(call.payload)
                if (
                  projection.childRunId !== input.childRunId ||
                  projection.parentLinkRef !== input.linkId ||
                  projection.event.runId !== input.childRunId
                ) {
                  throw new Error("Child event projection escaped its worker session binding")
                }
                await request.projectEvent(projection.event)
                return { schemaVersion: 1, accepted: true }
              }
              default:
                throw new Error(
                  `Child-run worker requested unavailable parent service: ${call.method}`,
                )
            }
          },
        },
      )
      return {
        artifactsReconciled: result.result.artifactsReconciled,
        reason: result.result.summary,
      }
    } finally {
      if (activeRequestId === workerRequestId) activeRequestId = undefined
      activeObserve = undefined
      latestObservation = undefined
      await terminateOperation(`Child operation ${workerRequestId} settled`)
    }
  }

  const confirmTerminated = async (reason: string): Promise<void> => {
    await worker.settlement
    const snapshot = worker.snapshot()
    if (snapshot.state !== "exited" && snapshot.state !== "failed") {
      throw new Error(
        `Child worker ${identity.workerId} did not confirm termination after ${reason}`,
      )
    }
    if (
      snapshot.identity.pid !== owner.pid ||
      snapshot.identity.processStartToken !== owner.processStartToken ||
      snapshot.identity.workerId !== identity.workerId
    ) {
      throw new Error("Child worker termination receipt changed its immutable process identity")
    }
  }

  const terminateGracefully = async (reason: string, graceMs?: number): Promise<void> => {
    try {
      await worker.shutdown(reason, graceMs)
    } catch (shutdownError) {
      try {
        await worker.forceKill(reason)
      } catch (killError) {
        throw new AggregateError(
          [shutdownError, killError],
          "Child worker did not terminate after graceful shutdown and forced cleanup",
        )
      }
    }
    await confirmTerminated(reason)
  }
  terminateAfterOperation = (reason) =>
    orderedLifecycle(() => terminateGracefully(reason, input.cancellationGraceMs))

  const requestStop: NonNullable<ChildRunExecutionPort["requestStop"]> = async (request) => {
    if (request.link.id === input.linkId) {
      if (
        request.link.childRunId !== input.childRunId ||
        request.link.workspaceId !== input.workspaceId
      ) {
        throw new Error("Child stop changed the root session link binding")
      }
    } else {
      const descendant = listChildRunTree(
        workspaceLayout(input.workspaceRoot).ledger,
        input.childRunId,
      ).find(
        (candidate) =>
          candidate.id === request.link.id &&
          candidate.childRunId === request.link.childRunId &&
          candidate.workspaceId === input.workspaceId,
      )
      if (!descendant) {
        throw new Error("Child stop target is outside the session's durable subtree")
      }
    }
    await orderedLifecycle(async () => {
      const snapshot = worker.snapshot()
      const requestId = snapshot.activeRequestId ?? activeRequestId
      if (requestId && activeRequestId && requestId !== activeRequestId) {
        throw new Error("Child stop refused an active operation outside its ordered session")
      }
      const directedReason = `${request.reason} [target=${request.link.childRunId}]`
      if (requestId) worker.cancel(requestId, directedReason)
      await terminateGracefully(directedReason, request.graceMs)
    })
  }

  return {
    owner,
    workerId: identity.workerId,
    parentWorkerId,
    execution: {
      execute: (request) => execute("execute", request),
      reconcileTerminal: (request) => execute("reconcile-terminal", request),
      requestStop,
    },
    snapshot() {
      const snapshot = worker.snapshot()
      return {
        state: snapshot.state,
        ...(snapshot.activeRequestId ? { activeRequestId: snapshot.activeRequestId } : {}),
        ...(snapshot.lastControlHeartbeatAt
          ? { lastControlHeartbeatAt: snapshot.lastControlHeartbeatAt }
          : {}),
        ...(snapshot.lastProgressAt ? { lastProgressAt: snapshot.lastProgressAt } : {}),
      }
    },
    async ping(timeoutMs) {
      await worker.ping(timeoutMs)
    },
    async forceKill(reason) {
      await orderedLifecycle(async () => {
        await worker.forceKill(reason)
        await confirmTerminated(reason)
      })
    },
    async close(reason) {
      await orderedLifecycle(() => terminateGracefully(reason))
    },
  }
}

/** Child coordination is process-isolated while remaining pause-with-parent and command-owned. */
export const CHILD_RUN_ISOLATION_POLICY = "supervised-worker-pause-with-parent" as const

export type { RalphWorkerRoleAdapter }
