import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"

import { resolveRuntimeProfileCandidate } from "@ralph-next/commands"
import {
  EXIT_CODES,
  type ProfileParameters,
  RalphError,
  type RoleProfileConfig,
  RoleProfileConfigSchema,
  type TelemetryConfig,
} from "@ralph-next/domain"
import type {
  JudgeBackend,
  JudgeBackendCapabilities,
  JudgeCallHandle,
  JudgeEventSink,
  JudgeRequest,
} from "@ralph-next/evaluation"
import {
  builtinKnownExternalOutputAdapters,
  EmbeddedExecutionBackend,
  EmbeddedJudgeBackend,
  ExternalCliExecutionBackend,
  ExternalCliExecutionError,
  ExternalCliJudgeBackend,
  ExternalCliJudgeError,
  FileRawModelCaptureFactory,
  type KnownExternalOutputAdapter,
  OpenAiProviderDriver,
  validateExternalCliExecutionConfig,
} from "@ralph-next/model-drivers"
import { type FetchLike, OpenAiDriverError } from "@ralph-next/openai-driver"
import {
  type BackendCapabilities,
  type CallHandle,
  type ExecutionBackend,
  type ExecutionBackendLimits,
  type ExecutionBackendResolver,
  type ExecutionChannel,
  type ExecutionRequest,
  type ExecutionRuntimeDependencies,
  type ExecutionToolPort,
  telemetryPolicyForEffectiveOptions,
} from "@ralph-next/orchestration"
import {
  applyDiagnosticRawRetention,
  loadEffectiveConfig,
  rawPersistenceEnabled,
  resolveDiagnosticRawRetention,
  runLayout,
  workspaceLayout,
} from "@ralph-next/persistence"
import {
  type FallbackPolicy,
  FallbackPolicySchema,
  type ModelAccess,
  type ModelInfo,
  type ProviderInfo,
  type RoleProfile,
  type RoutingFailureClass,
} from "@ralph-next/providers"
import { WorkerRemoteOperationError } from "@ralph-next/supervisor"
import { secretValuesFromEnvironment } from "@ralph-next/telemetry"
import type { PermissionPromptPort } from "@ralph-next/tool-host"

import {
  createS04OpenAiInvokerLease,
  createS04OpenRouterInvokerLease,
  type S04Services,
} from "./s04-services"
import {
  createRalphExecutionToolPort,
  createWorkspaceBunProcessSupervisor,
} from "./tool-execution-port"

const FALLBACK_ELIGIBLE = new Set<RoutingFailureClass>([
  "provider-unavailable",
  "model-unavailable",
  "rate-limit",
  "transient",
])

function executableAvailable(executable: string): boolean {
  return isAbsolute(executable) ? existsSync(executable) : Boolean(Bun.which(executable))
}

function exactEmbeddedAccess(
  profile: RoleProfile,
  provider: ProviderInfo,
  model: ModelInfo,
): ModelAccess {
  const credential = profile.credential
  if (!credential) {
    throw new RalphError(
      "RALPH_EMBEDDED_ACCESS_UNAVAILABLE",
      `Embedded profile has no credential access binding: ${profile.id}`,
      { exitCode: EXIT_CODES.providerUnavailable },
    )
  }
  const method = provider.credentialMethods.find((entry) => entry.method === credential.method)
  const required = new Set(profile.requirements.access)
  const candidates = (method?.access ?? []).filter(
    (access) =>
      provider.access.includes(access) &&
      model.access.includes(access) &&
      (required.size === 0 || required.has(access)),
  )
  if (candidates.length !== 1) {
    throw new RalphError(
      "RALPH_EMBEDDED_ACCESS_AMBIGUOUS",
      `Embedded profile must resolve to exactly one credential access mode: ${profile.id}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: {
          profile: profile.id,
          provider: provider.id,
          model: model.id,
          method: credential.method,
          candidates,
        },
        hint: "Select a credential method or profile access requirement with one exact access mode.",
      },
    )
  }
  return candidates[0] as ModelAccess
}

type JudgeBackendResolver = NonNullable<ExecutionRuntimeDependencies["resolveJudge"]>

export type ExecutionBackendCandidate = {
  profileId: string
  capabilities: BackendCapabilities
  limits: ExecutionBackendLimits
  create: () => Promise<ExecutionBackend>
}

export type JudgeBackendCandidate = {
  profileId: string
  capabilities: JudgeBackendCapabilities
  create: () => Promise<JudgeBackend>
}

type ActiveFallback = {
  backend?: ExecutionBackend
  handle?: CallHandle
  cancelReason?: string
}

type ActiveJudgeFallback = {
  backend?: JudgeBackend
  handle?: JudgeCallHandle
  cancelReason?: string
}

function classifyFallbackFailure(error: unknown): RoutingFailureClass | undefined {
  if (error instanceof ExternalCliExecutionError) {
    return error.kind === "transient" ? "transient" : undefined
  }
  if (error instanceof ExternalCliJudgeError) {
    return error.kind === "transient" ? "transient" : undefined
  }
  if (error instanceof WorkerRemoteOperationError) {
    if (error.code.includes("RATE_LIMIT")) return "rate-limit"
    if (error.code.includes("AUTH") || error.code.includes("CREDENTIAL")) {
      return "authentication"
    }
    if (error.code.includes("MODEL_UNAVAILABLE") || error.code.includes("MODEL_NOT_FOUND")) {
      return "model-unavailable"
    }
    if (
      error.code.includes("PROVIDER_UNAVAILABLE") ||
      error.code.includes("EXECUTABLE_UNAVAILABLE") ||
      error.code.includes("BACKEND_UNAVAILABLE") ||
      error.code.includes("CATALOG_UNAVAILABLE") ||
      error.code.includes("DRIVER_UNAVAILABLE")
    ) {
      return "provider-unavailable"
    }
    return error.retryable ? "transient" : undefined
  }
  if (error instanceof OpenAiDriverError) {
    switch (error.kind) {
      case "rate-limit":
        return "rate-limit"
      case "transport":
      case "timeout":
      case "provider":
        return "transient"
      case "eligibility":
        return "model-unavailable"
      case "authentication":
        return "authentication"
      case "invalid-input":
      case "protocol-drift":
        return "configuration"
      case "cancelled":
        return undefined
    }
  }
  if (error instanceof RalphError) {
    if (error.code.includes("AUTH") || error.code.includes("CREDENTIAL")) {
      return "authentication"
    }
    if (
      error.code.includes("MODEL_NOT_FOUND") ||
      error.code.includes("MODEL_UNAVAILABLE") ||
      error.code === "RALPH_EXECUTOR_MODEL_UNAVAILABLE"
    ) {
      return "model-unavailable"
    }
    if (error.exitCode === EXIT_CODES.providerUnavailable) return "provider-unavailable"
    return undefined
  }
  return undefined
}

/**
 * Fallback remains command-owned. A candidate may only be replaced when no
 * tool request was settled during that candidate; after any observable tool
 * call, Ralph fails closed and requires reconciliation instead of replaying an
 * effect through another provider.
 */
export class CommandFallbackExecutionBackend implements ExecutionBackend {
  readonly id: string
  readonly #active = new Map<string, ActiveFallback>()

  constructor(
    private readonly requestedProfileId: string,
    private readonly candidates: readonly ExecutionBackendCandidate[],
    private readonly policy: FallbackPolicy,
  ) {
    if (candidates.length === 0) throw new Error("Fallback backend requires one candidate")
    this.id = `command-fallback:${requestedProfileId}`
  }

  capabilities(): BackendCapabilities {
    const primary = (this.candidates[0] as ExecutionBackendCandidate).capabilities
    const usage = this.candidates.some(
      (candidate) => candidate.capabilities.usage === "unavailable",
    )
      ? "unavailable"
      : this.candidates.some((candidate) => candidate.capabilities.usage === "estimated")
        ? "estimated"
        : "reported"
    return { ...primary, usage }
  }

  limits(): ExecutionBackendLimits {
    return minimumProfileLimits(this.candidates.map((candidate) => candidate.limits))
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    if (this.#active.has(request.modelCallId)) {
      throw new Error(`Fallback backend call is already active: ${request.modelCallId}`)
    }
    const active: ActiveFallback = {}
    this.#active.set(request.modelCallId, active)
    const outcome = this.#run(request, channel, active).finally(() => {
      this.#active.delete(request.modelCallId)
    })
    void outcome.catch(() => undefined)
    return { id: request.modelCallId, outcome }
  }

  async cancel(handle: CallHandle, reason: string): Promise<void> {
    const active = this.#active.get(handle.id)
    if (!active) return
    active.cancelReason = reason
    if (active.backend && active.handle) await active.backend.cancel(active.handle, reason)
  }

  async #run(request: ExecutionRequest, channel: ExecutionChannel, active: ActiveFallback) {
    for (const [index, candidate] of this.candidates.entries()) {
      const toolCallsBefore = channel.stats().toolCalls
      try {
        if (active.cancelReason) throw new Error(active.cancelReason)
        const backend = await candidate.create()
        active.backend = backend
        if (active.cancelReason) throw new Error(active.cancelReason)
        const candidateRequest = {
          ...request,
          modelCallId: `${request.modelCallId}-candidate-${index + 1}-${candidate.profileId}`,
        }
        const handle = await backend.start(candidateRequest, channel)
        active.handle = handle
        if (active.cancelReason) {
          await backend.cancel(handle, active.cancelReason)
          throw new Error(active.cancelReason)
        }
        return await handle.outcome
      } catch (error) {
        delete active.backend
        delete active.handle
        const toolCallsAfter = channel.stats().toolCalls
        if (toolCallsAfter !== toolCallsBefore) {
          throw new RalphError(
            "RALPH_FALLBACK_RECONCILIATION_REQUIRED",
            "Provider failed after a tool call; fallback was blocked to prevent replaying an effect",
            {
              exitCode: EXIT_CODES.conflict,
              details: {
                requestedProfile: this.requestedProfileId,
                failedProfile: candidate.profileId,
                toolCallsBefore,
                toolCallsAfter,
              },
              cause: error,
            },
          )
        }
        const failure = classifyFallbackFailure(error)
        const next = this.candidates[index + 1]
        if (
          !failure ||
          !next ||
          !FALLBACK_ELIGIBLE.has(failure) ||
          !this.policy.allowedFailures.includes(failure)
        ) {
          throw error
        }
        await channel.emit({
          type: "model.provider.warning",
          level: "warning",
          payload: {
            kind: "fallback",
            message: `Command-owned fallback selected ${next.profileId} after ${failure}`,
            failedProfile: candidate.profileId,
            selectedProfile: next.profileId,
          },
        })
      }
    }
    throw new Error(`Fallback candidates were exhausted for ${this.requestedProfileId}`)
  }
}

/**
 * Judge fallback is also command-owned, but is simpler than executor fallback:
 * every candidate is read-only and tool calling is unavailable. Only failures
 * classified by the transport/driver and explicitly allowed by `fallback_on`
 * can advance to the next independently configured judge profile.
 */
export class CommandFallbackJudgeBackend implements JudgeBackend {
  readonly id: string
  readonly #active = new Map<string, ActiveJudgeFallback>()

  constructor(
    private readonly requestedProfileId: string,
    private readonly candidates: readonly JudgeBackendCandidate[],
    private readonly policy: FallbackPolicy,
  ) {
    if (candidates.length === 0) throw new Error("Judge fallback backend requires one candidate")
    this.id = `judge-command-fallback:${requestedProfileId}`
  }

  capabilities(): JudgeBackendCapabilities {
    const primary = this.candidates[0] as JudgeBackendCandidate
    const usage = this.candidates.some(
      (candidate) => candidate.capabilities.usage === "unavailable",
    )
      ? "unavailable"
      : this.candidates.some((candidate) => candidate.capabilities.usage === "estimated")
        ? "estimated"
        : "reported"
    return {
      ...primary.capabilities,
      streaming: this.candidates.every((candidate) => candidate.capabilities.streaming),
      cancellation: this.candidates.every((candidate) => candidate.capabilities.cancellation),
      structuredOutput: this.candidates.every(
        (candidate) => candidate.capabilities.structuredOutput,
      ),
      usage,
      toolCalling: "unavailable",
      mutationMode: "read-only",
    }
  }

  async start(request: JudgeRequest, sink: JudgeEventSink): Promise<JudgeCallHandle> {
    if (this.#active.has(request.callId)) {
      throw new Error(`Judge fallback call is already active: ${request.callId}`)
    }
    const active: ActiveJudgeFallback = {}
    this.#active.set(request.callId, active)
    const operation = this.#run(request, sink, active).finally(() => {
      this.#active.delete(request.callId)
    })
    const outcome = operation.then((result) => result.output)
    const rawResponseRef = operation.then(
      (result) => result.rawResponseRef,
      () => undefined,
    )
    const profileSnapshot = operation.then(
      (result) => result.profileSnapshot,
      () => undefined,
    )
    void operation.catch(() => undefined)
    return { id: request.callId, outcome, rawResponseRef, profileSnapshot }
  }

  async cancel(handle: JudgeCallHandle, reason: string): Promise<void> {
    const active = this.#active.get(handle.id)
    if (!active) return
    active.cancelReason = reason
    if (active.backend && active.handle) await active.backend.cancel(active.handle, reason)
  }

  async #run(
    request: JudgeRequest,
    sink: JudgeEventSink,
    active: ActiveJudgeFallback,
  ): Promise<{
    output: Awaited<JudgeCallHandle["outcome"]>
    rawResponseRef?: string
    profileSnapshot?: Awaited<NonNullable<JudgeCallHandle["profileSnapshot"]>>
  }> {
    for (const [index, candidate] of this.candidates.entries()) {
      try {
        if (active.cancelReason) throw new Error(active.cancelReason)
        const backend = await candidate.create()
        active.backend = backend
        if (active.cancelReason) throw new Error(active.cancelReason)
        const candidateRequest = {
          ...request,
          callId: `${request.callId}-candidate-${index + 1}-${candidate.profileId}`,
        }
        const handle = await backend.start(candidateRequest, sink)
        active.handle = handle
        if (active.cancelReason) {
          await backend.cancel(handle, active.cancelReason)
          throw new Error(active.cancelReason)
        }
        const output = await handle.outcome
        const rawResponseRef = handle.rawResponseRef
          ? await handle.rawResponseRef.catch(() => undefined)
          : undefined
        const profileSnapshot = handle.profileSnapshot
          ? await handle.profileSnapshot.catch(() => undefined)
          : undefined
        return {
          output,
          ...(rawResponseRef ? { rawResponseRef } : {}),
          ...(profileSnapshot ? { profileSnapshot } : {}),
        }
      } catch (error) {
        delete active.backend
        delete active.handle
        const failure = classifyFallbackFailure(error)
        const next = this.candidates[index + 1]
        if (
          !failure ||
          !next ||
          !FALLBACK_ELIGIBLE.has(failure) ||
          !this.policy.allowedFailures.includes(failure)
        ) {
          throw error
        }
        await sink.emit({
          type: "judge.fallback.selected",
          level: "warning",
          payload: {
            kind: "fallback",
            message: `Command-owned judge fallback selected ${next.profileId} after ${failure}`,
            failedProfile: candidate.profileId,
            selectedProfile: next.profileId,
            failure,
          },
        })
      }
    }
    throw new Error(`Judge fallback candidates were exhausted for ${this.requestedProfileId}`)
  }
}

export function configuredExecutionCapabilities(config: RoleProfileConfig): BackendCapabilities {
  if (config.backend === "external-cli" && config.external_cli) {
    return {
      streaming: config.external_cli.capabilities.streaming,
      toolCalling: config.external_cli.capabilities.tool_calling,
      cancellation: true,
      usage: config.external_cli.capabilities.usage,
    }
  }
  return { streaming: true, toolCalling: "ralph", cancellation: true, usage: "reported" }
}

export function configuredJudgeCapabilities(config: RoleProfileConfig): JudgeBackendCapabilities {
  if (config.backend === "external-cli") {
    return {
      streaming: false,
      cancellation: true,
      structuredOutput: true,
      usage: "unavailable",
      toolCalling: "unavailable",
      mutationMode: "read-only",
    }
  }
  return {
    streaming: true,
    cancellation: true,
    structuredOutput: true,
    usage: "reported",
    toolCalling: "unavailable",
    mutationMode: "read-only",
  }
}

export function configuredExecutionLimits(config: RoleProfileConfig): ExecutionBackendLimits {
  return {
    ...(config.limits.max_input_tokens === undefined
      ? {}
      : { maxInputTokens: config.limits.max_input_tokens }),
    ...(config.limits.max_output_tokens === undefined
      ? {}
      : { maxOutputTokens: config.limits.max_output_tokens }),
    ...(config.limits.max_reasoning_tokens === undefined
      ? {}
      : { maxReasoningTokens: config.limits.max_reasoning_tokens }),
    ...(config.limits.max_total_tokens === undefined
      ? {}
      : { maxTotalTokens: config.limits.max_total_tokens }),
    ...(config.limits.max_cost === undefined ? {} : { maxCost: config.limits.max_cost }),
  }
}

function minimumProfileLimits(values: readonly ExecutionBackendLimits[]): ExecutionBackendLimits {
  const minimum = (select: (value: ExecutionBackendLimits) => number | undefined) => {
    const candidates = values.map(select).filter((value): value is number => value !== undefined)
    return candidates.length === 0 ? undefined : Math.min(...candidates)
  }
  const costs = values
    .map((value) => value.maxCost)
    .filter((value): value is NonNullable<ExecutionBackendLimits["maxCost"]> => value !== undefined)
  const currencies = new Set(costs.map((cost) => cost.currency))
  if (currencies.size > 1) {
    throw new RalphError(
      "RALPH_PROFILE_FALLBACK_COST_CURRENCY_MISMATCH",
      "Fallback executor profiles declare incomparable cost-limit currencies",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: { currencies: [...currencies].sort() },
      },
    )
  }
  const maxInputTokens = minimum((value) => value.maxInputTokens)
  const maxOutputTokens = minimum((value) => value.maxOutputTokens)
  const maxReasoningTokens = minimum((value) => value.maxReasoningTokens)
  const maxTotalTokens = minimum((value) => value.maxTotalTokens)
  const costAmount = costs.length === 0 ? undefined : Math.min(...costs.map((cost) => cost.amount))
  return {
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(maxReasoningTokens === undefined ? {} : { maxReasoningTokens }),
    ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
    ...(costAmount === undefined
      ? {}
      : { maxCost: { amount: costAmount, currency: costs[0]?.currency as string } }),
  }
}

function fallbackCandidateIds(
  profiles: Readonly<Record<string, RoleProfileConfig>>,
  requestedProfileId: string,
): readonly string[] {
  const requested = profiles[requestedProfileId]
  if (!requested) return []
  const result: string[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (profileId: string): void => {
    if (visiting.has(profileId)) {
      throw new RalphError(
        "RALPH_PROFILE_FALLBACK_CYCLE",
        `Role profile fallback cycle detected at ${profileId}`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (visited.has(profileId)) return
    const profile = profiles[profileId]
    if (!profile) {
      throw new RalphError(
        "RALPH_PROFILE_FALLBACK_NOT_FOUND",
        `Fallback role profile was not found: ${profileId}`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (profile.role !== requested.role) {
      throw new RalphError(
        "RALPH_PROFILE_FALLBACK_ROLE_MISMATCH",
        `Fallback role does not match role profile ${requestedProfileId}`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    visiting.add(profileId)
    visited.add(profileId)
    result.push(profileId)
    for (const fallbackId of profile.fallback_profiles) visit(fallbackId)
    visiting.delete(profileId)
  }
  visit(requestedProfileId)
  return result
}

class DryRunExecutionBackend implements ExecutionBackend {
  readonly id: string

  constructor(
    profileId: string,
    private readonly declared: BackendCapabilities,
    private readonly declaredLimits: ExecutionBackendLimits,
  ) {
    this.id = `dry-run:${profileId}`
    if (Object.keys(declaredLimits).length > 0 && declared.usage === "unavailable") {
      throw new RalphError(
        "RALPH_MODEL_USAGE_LIMIT_UNENFORCEABLE",
        `Executor profile ${profileId} declares token or cost limits but its usage is unavailable`,
        {
          exitCode: EXIT_CODES.invalidUsage,
          details: { profileId, limits: declaredLimits },
        },
      )
    }
  }

  capabilities(): BackendCapabilities {
    return this.declared
  }

  limits(): ExecutionBackendLimits {
    return structuredClone(this.declaredLimits)
  }

  async start(): Promise<CallHandle> {
    throw new Error("A dry-run backend cannot be invoked")
  }

  async cancel(): Promise<void> {}
}

class DryRunJudgeBackend implements JudgeBackend {
  readonly id: string

  constructor(
    profileId: string,
    private readonly declared: JudgeBackendCapabilities,
  ) {
    this.id = `dry-run-judge:${profileId}`
  }

  capabilities(): JudgeBackendCapabilities {
    return structuredClone(this.declared)
  }

  async start(): Promise<never> {
    throw new Error("A dry-run judge backend cannot be invoked")
  }

  async cancel(): Promise<void> {}
}

type RoleRunOverrides = {
  provider: string | undefined
  model: string | undefined
  credential: string | null | undefined
  variant: string | null | undefined
  parameters: ProfileParameters | undefined
}

function profileWithRunOverrides(
  selected: RoleProfileConfig,
  overrides: RoleRunOverrides,
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

function applyExecutorOverrides(
  profiles: Readonly<Record<string, RoleProfileConfig>>,
  profileId: string,
  context: Parameters<ExecutionBackendResolver>[1],
): Readonly<Record<string, RoleProfileConfig>> {
  const selected = profiles[profileId]
  if (!selected) return profiles
  const options = context.effectiveOptions
  const candidate = profileWithRunOverrides(selected, {
    provider: options.executorProvider?.value,
    model: options.executorModel?.value,
    credential: options.executorCredential?.value,
    variant: options.executorVariant?.value,
    parameters: options.executorParameters?.value,
  })
  return { ...profiles, [profileId]: candidate }
}

function applyJudgeOverrides(
  profiles: Readonly<Record<string, RoleProfileConfig>>,
  profileId: string,
  context: Parameters<JudgeBackendResolver>[1],
): Readonly<Record<string, RoleProfileConfig>> {
  const selected = profiles[profileId]
  if (!selected) return profiles
  const options = context.effectiveOptions
  const candidate = profileWithRunOverrides(
    selected,
    context.kind === "external"
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
        },
  )
  return { ...profiles, [profileId]: candidate }
}

export type S05ServicesOptions = {
  s04: S04Services
  environment?: Record<string, string | undefined>
  modelFetch?: FetchLike
  now?: () => number
  toolPort?: ExecutionToolPort
  permissionPrompt?: PermissionPromptPort
  knownExternalAdapters?: readonly KnownExternalOutputAdapter[]
  /** Canonical worker capability bindings keyed by the exact external executor profile. */
  externalExecutorExecutableHashes?: Readonly<Record<string, string>>
  /** Canonical worker capability bindings keyed by the exact external judge profile. */
  externalJudgeExecutableHashes?: Readonly<Record<string, string>>
}

export type S05Services = {
  resolveBackend: ExecutionBackendResolver
  resolveJudge: JudgeBackendResolver
  toolPort: ExecutionToolPort
}

export function createS05Services(options: S05ServicesOptions): S05Services {
  const environment = options.environment ?? process.env
  const now = options.now ?? Date.now
  const toolPort =
    options.toolPort ??
    createRalphExecutionToolPort(
      options.permissionPrompt ? { prompt: options.permissionPrompt } : undefined,
    )
  const knownExternalAdapters = [
    ...builtinKnownExternalOutputAdapters(),
    ...(options.knownExternalAdapters ?? []),
  ]
  if (
    new Set(knownExternalAdapters.map((adapter) => adapter.id)).size !==
    knownExternalAdapters.length
  ) {
    throw new Error("Known external output adapter ids must be unique")
  }

  const backendFor = (
    profile: RoleProfile,
    catalogHandle: Awaited<ReturnType<S04Services["credentials"]["catalogSnapshot"]>> | undefined,
    _workspaceRoot: string,
    controlRoot: string,
    runId: string | undefined,
    telemetry: TelemetryConfig,
  ): ExecutionBackend => {
    if (profile.role !== "executor") {
      throw new RalphError(
        "RALPH_EXECUTOR_PROFILE_ROLE_MISMATCH",
        `Executor selected a ${profile.role} profile: ${profile.id}`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (profile.backend === "external-cli") {
      if (!profile.externalCli) throw new Error(`External CLI config is missing: ${profile.id}`)
      return new ExternalCliExecutionBackend({
        id: `external-cli:${profile.id}`,
        config: profile.externalCli,
        supervisorFactory: (request) =>
          createWorkspaceBunProcessSupervisor({
            workspaceRoot: controlRoot,
            runId: request.runId,
            secretValues: secretValuesFromEnvironment(environment),
            persistRawOutput: rawPersistenceEnabled(telemetry),
            retention: resolveDiagnosticRawRetention(telemetry),
          }),
        provider: profile.provider,
        model: profile.model,
        limits: profile.limits,
        environment,
        knownAdapters: knownExternalAdapters,
        secretValues: secretValuesFromEnvironment(environment),
        ...(options.externalExecutorExecutableHashes?.[profile.id]
          ? { expectedExecutableHash: options.externalExecutorExecutableHashes[profile.id] }
          : {}),
        now: () => new Date(now()).toISOString(),
      })
    }
    if (profile.provider !== "openai" && profile.provider !== "openrouter") {
      throw new RalphError(
        "RALPH_EMBEDDED_PROVIDER_DRIVER_UNAVAILABLE",
        `No audited embedded execution driver is installed for ${profile.provider}`,
        { exitCode: EXIT_CODES.providerUnavailable },
      )
    }
    if (!profile.credential) {
      throw new RalphError(
        "RALPH_EXECUTOR_CREDENTIAL_REQUIRED",
        `Embedded executor profile requires a credential reference: ${profile.id}`,
        { exitCode: EXIT_CODES.providerUnavailable },
      )
    }
    if (!catalogHandle) {
      throw new RalphError(
        "RALPH_EXECUTOR_CATALOG_REQUIRED",
        `Embedded executor requires a catalog snapshot: ${profile.id}`,
        { exitCode: EXIT_CODES.providerUnavailable },
      )
    }
    const snapshot = catalogHandle.resolution.snapshot
    const provider = snapshot.providers.find((item) => item.id === profile.provider)
    const model = snapshot.models.find(
      (item) => item.provider === profile.provider && item.id === profile.model,
    )
    if (!provider || !model) {
      throw new RalphError(
        "RALPH_EXECUTOR_MODEL_UNAVAILABLE",
        `Executor model is absent from the catalog: ${profile.provider}/${profile.model}`,
        { exitCode: EXIT_CODES.providerUnavailable },
      )
    }
    if (rawPersistenceEnabled(telemetry) && !runId) {
      throw new RalphError(
        "RALPH_TELEMETRY_RUN_SCOPE_REQUIRED",
        "Embedded executor raw capture requires a command-reserved run identity",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    const rawRoot = runId
      ? join(runLayout(workspaceLayout(controlRoot), runId).raw, "diagnostic")
      : undefined
    const rawRetention = resolveDiagnosticRawRetention(telemetry)
    const driver = new OpenAiProviderDriver({
      provider,
      models: [model],
      access: exactEmbeddedAccess(profile, provider, model),
      catalog: {
        snapshot,
        resolution: {
          origin: catalogHandle.resolution.origin,
          stale: catalogHandle.resolution.stale,
        },
      },
      lease:
        profile.provider === "openrouter"
          ? createS04OpenRouterInvokerLease({
              credentials: options.s04.credentials,
              credential: profile.credential,
              provider,
              catalogHandle,
              ...(options.modelFetch ? { fetch: options.modelFetch } : {}),
            })
          : createS04OpenAiInvokerLease({
              credentials: options.s04.credentials,
              credential: profile.credential,
              provider,
              catalogHandle,
              ...(options.modelFetch ? { fetch: options.modelFetch } : {}),
              now,
            }),
      ...(rawRoot && rawPersistenceEnabled(telemetry)
        ? {
            raw: new FileRawModelCaptureFactory({
              directory: join(rawRoot, "model"),
              coordinationRoot: rawRoot,
              referencePrefix: `raw:model/${runId}`,
              maximumBytes: rawRetention.maximumFileBytes,
              afterClose: async () => {
                const receipt = await applyDiagnosticRawRetention(rawRoot, rawRetention)
                if (receipt.blocked || receipt.overBudget) {
                  throw new Error(
                    `Diagnostic raw retention was not enforced: ${receipt.blockedReason ?? "root remains over budget"}`,
                  )
                }
              },
              now: () => new Date(now()).toISOString(),
            }),
          }
        : {}),
      now,
    })
    return new EmbeddedExecutionBackend({
      id: `embedded:${profile.id}:${profile.provider}/${profile.model}`,
      driver,
      model: {
        provider: profile.provider,
        model: profile.model,
        ...(profile.variant ? { variant: profile.variant } : {}),
      },
      parameters: profile.parameters,
      limits: profile.limits,
      now: () => new Date(now()).toISOString(),
    })
  }

  const judgeBackendFor = (
    profile: RoleProfile,
    catalogHandle: Awaited<ReturnType<S04Services["credentials"]["catalogSnapshot"]>> | undefined,
    _workspaceRoot: string,
    controlRoot: string,
    runId: string | undefined,
    telemetry: TelemetryConfig,
  ): JudgeBackend => {
    if (profile.backend === "external-cli") {
      if (!profile.externalCli) {
        throw new Error(`External judge CLI config is missing: ${profile.id}`)
      }
      return new ExternalCliJudgeBackend({
        id: `judge:external-cli:${profile.id}`,
        config: profile.externalCli,
        supervisor: createWorkspaceBunProcessSupervisor({
          workspaceRoot: controlRoot,
          ...(runId ? { runId } : {}),
          secretValues: secretValuesFromEnvironment(environment),
          persistRawOutput: rawPersistenceEnabled(telemetry),
          retention: resolveDiagnosticRawRetention(telemetry),
        }),
        environment,
        ...(options.externalJudgeExecutableHashes?.[profile.id]
          ? { expectedExecutableHash: options.externalJudgeExecutableHashes[profile.id] }
          : {}),
      })
    }
    if (profile.provider !== "openai" && profile.provider !== "openrouter") {
      throw new RalphError(
        "RALPH_EMBEDDED_PROVIDER_DRIVER_UNAVAILABLE",
        `No audited embedded judge driver is installed for ${profile.provider}`,
        { exitCode: EXIT_CODES.providerUnavailable },
      )
    }
    if (!profile.credential) {
      throw new RalphError(
        "RALPH_JUDGE_CREDENTIAL_REQUIRED",
        `Embedded judge profile requires a credential reference: ${profile.id}`,
        { exitCode: EXIT_CODES.providerUnavailable },
      )
    }
    if (!catalogHandle) {
      throw new RalphError(
        "RALPH_JUDGE_CATALOG_REQUIRED",
        `Embedded judge requires a catalog snapshot: ${profile.id}`,
        { exitCode: EXIT_CODES.providerUnavailable },
      )
    }
    const snapshot = catalogHandle.resolution.snapshot
    const provider = snapshot.providers.find((item) => item.id === profile.provider)
    const model = snapshot.models.find(
      (item) => item.provider === profile.provider && item.id === profile.model,
    )
    if (!provider || !model) {
      throw new RalphError(
        "RALPH_JUDGE_MODEL_UNAVAILABLE",
        `Judge model is absent from the catalog: ${profile.provider}/${profile.model}`,
        { exitCode: EXIT_CODES.providerUnavailable },
      )
    }
    if (rawPersistenceEnabled(telemetry) && !runId) {
      throw new RalphError(
        "RALPH_TELEMETRY_RUN_SCOPE_REQUIRED",
        "Embedded judge raw capture requires a persisted run identity",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    const rawRoot = runId
      ? join(runLayout(workspaceLayout(controlRoot), runId).raw, "diagnostic")
      : undefined
    const rawRetention = resolveDiagnosticRawRetention(telemetry)
    const driver = new OpenAiProviderDriver({
      provider,
      models: [model],
      access: exactEmbeddedAccess(profile, provider, model),
      catalog: {
        snapshot,
        resolution: {
          origin: catalogHandle.resolution.origin,
          stale: catalogHandle.resolution.stale,
        },
      },
      lease:
        profile.provider === "openrouter"
          ? createS04OpenRouterInvokerLease({
              credentials: options.s04.credentials,
              credential: profile.credential,
              provider,
              catalogHandle,
              ...(options.modelFetch ? { fetch: options.modelFetch } : {}),
            })
          : createS04OpenAiInvokerLease({
              credentials: options.s04.credentials,
              credential: profile.credential,
              provider,
              catalogHandle,
              ...(options.modelFetch ? { fetch: options.modelFetch } : {}),
              now,
            }),
      ...(rawRoot && rawPersistenceEnabled(telemetry)
        ? {
            raw: new FileRawModelCaptureFactory({
              directory: join(rawRoot, "model"),
              coordinationRoot: rawRoot,
              referencePrefix: `raw:model/${runId}`,
              maximumBytes: rawRetention.maximumFileBytes,
              afterClose: async () => {
                const receipt = await applyDiagnosticRawRetention(rawRoot, rawRetention)
                if (receipt.blocked || receipt.overBudget) {
                  throw new Error(
                    `Diagnostic raw retention was not enforced: ${receipt.blockedReason ?? "root remains over budget"}`,
                  )
                }
              },
              now: () => new Date(now()).toISOString(),
            }),
          }
        : {}),
      now,
    })
    return new EmbeddedJudgeBackend({
      id: `judge:embedded:${profile.id}:${profile.provider}/${profile.model}`,
      driver,
      model: {
        provider: profile.provider,
        model: profile.model,
        ...(profile.variant ? { variant: profile.variant } : {}),
      },
      parameters: profile.parameters,
      ...(profile.limits.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: profile.limits.maxOutputTokens }),
      structuredOutput: model.capabilities.structuredOutput,
      usage: model.capabilities.usage.length > 0 ? "reported" : "unavailable",
    })
  }

  const resolveBackend: ExecutionBackendResolver = async (profileId, context) => {
    const layout = workspaceLayout(context.workspaceRoot)
    const effective =
      context.config ?? (await loadEffectiveConfig({ workspaceConfig: layout.config, environment }))
    const profileConfigs = applyExecutorOverrides(effective.config.profiles, profileId, context)
    const candidateIds = fallbackCandidateIds(profileConfigs, profileId)
    if (candidateIds.length === 0) return undefined
    const requestedConfig = profileConfigs[profileId]
    if (requestedConfig?.role !== "executor") {
      throw new RalphError(
        "RALPH_EXECUTOR_PROFILE_ROLE_MISMATCH",
        `Executor profile is unavailable or has the wrong role: ${profileId}`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }

    if (context.dryRun) {
      const available = candidateIds.find((candidateId) => {
        const config = profileConfigs[candidateId]
        if (!config) return false
        if (config.backend !== "external-cli") {
          return config.provider === "openai" || config.provider === "openrouter"
        }
        if (!config.external_cli || !executableAvailable(config.external_cli.executable))
          return false
        resolveRuntimeProfileCandidate(
          candidateId,
          RoleProfileConfigSchema.parse({ ...config, credential: undefined }),
          [],
        )
        validateExternalCliExecutionConfig(
          {
            executable: config.external_cli.executable,
            args: config.external_cli.args,
            cwd: config.external_cli.cwd,
            environmentRefs: config.external_cli.environment_refs,
            inputMode: config.external_cli.input_mode,
            adapter: config.external_cli.adapter,
            ...(config.external_cli.adapter_id
              ? { adapterId: config.external_cli.adapter_id }
              : {}),
            capabilities: {
              streaming: config.external_cli.capabilities.streaming,
              toolCalling: config.external_cli.capabilities.tool_calling,
              cancellation: config.external_cli.capabilities.cancellation,
              usage: config.external_cli.capabilities.usage,
            },
            mutationMode: config.external_cli.mutation_mode,
            timeoutMs: config.external_cli.timeout_ms,
            outputLimitBytes: config.external_cli.output_limit_bytes,
          },
          knownExternalAdapters,
        )
        return true
      })
      if (!available) return undefined
      const config = profileConfigs[available]
      return config
        ? new DryRunExecutionBackend(
            available,
            configuredExecutionCapabilities(config),
            configuredExecutionLimits(config),
          )
        : undefined
    }

    let credentialsPromise: ReturnType<S04Services["credentials"]["list"]> | undefined
    let catalogPromise: ReturnType<S04Services["credentials"]["catalogSnapshot"]> | undefined
    const credentials = () => (credentialsPromise ??= options.s04.credentials.list())
    const catalog = () =>
      (catalogPromise ??= options.s04.credentials
        .catalogSnapshot({ refresh: false })
        .catch((cause) => {
          throw new RalphError(
            "RALPH_MODEL_CATALOG_UNAVAILABLE",
            "Model catalog is unavailable for the selected embedded executor",
            { exitCode: EXIT_CODES.providerUnavailable, cause },
          )
        }))
    const candidates: ExecutionBackendCandidate[] = candidateIds.map((candidateId) => {
      const config = profileConfigs[candidateId]
      if (!config) throw new Error(`Runtime fallback profile disappeared: ${candidateId}`)
      return {
        profileId: candidateId,
        capabilities: configuredExecutionCapabilities(config),
        limits: configuredExecutionLimits(config),
        create: async () => {
          if (
            config.backend === "external-cli" &&
            config.external_cli &&
            !executableAvailable(config.external_cli.executable)
          ) {
            throw new RalphError(
              "RALPH_EXTERNAL_CLI_EXECUTABLE_UNAVAILABLE",
              `External CLI executable is unavailable for ${candidateId}`,
              { exitCode: EXIT_CODES.providerUnavailable },
            )
          }
          const catalogHandle = config.backend === "embedded" ? await catalog() : undefined
          const credentialRefs = config.credential ? await credentials() : []
          const profile = resolveRuntimeProfileCandidate(
            candidateId,
            config,
            credentialRefs,
            catalogHandle?.resolution.snapshot,
          )
          return backendFor(
            profile,
            catalogHandle,
            context.workspaceRoot,
            context.controlRoot ?? context.workspaceRoot,
            context.runId,
            telemetryPolicyForEffectiveOptions(context.effectiveOptions),
          )
        },
      }
    })
    if (candidates.length === 1) return (candidates[0] as ExecutionBackendCandidate).create()
    const policy = FallbackPolicySchema.parse({
      allowedFailures: requestedConfig.fallback_on,
    })
    return new CommandFallbackExecutionBackend(profileId, candidates, policy)
  }

  const resolveJudge: JudgeBackendResolver = async (profileId, context) => {
    const layout = workspaceLayout(context.workspaceRoot)
    const effective =
      context.config ?? (await loadEffectiveConfig({ workspaceConfig: layout.config, environment }))
    const profileConfigs = applyJudgeOverrides(effective.config.profiles, profileId, context)
    const candidateIds = fallbackCandidateIds(profileConfigs, profileId)
    if (candidateIds.length === 0) return undefined
    const requestedConfig = profileConfigs[profileId]
    const expectedRole = context.kind === "external" ? "judge" : "executor"
    if (!requestedConfig || requestedConfig.role !== expectedRole) {
      throw new RalphError(
        "RALPH_JUDGE_PROFILE_ROLE_MISMATCH",
        `${context.kind === "external" ? "External judge" : "Self-review"} requires a ${expectedRole} profile: ${profileId}`,
        {
          exitCode: EXIT_CODES.invalidUsage,
          details: {
            profileId,
            kind: context.kind,
            expectedRole,
            actualRole: requestedConfig?.role ?? "missing",
          },
        },
      )
    }

    if (context.dryRun) {
      for (const [index, candidateId] of candidateIds.entries()) {
        const config = profileConfigs[candidateId]
        if (!config) continue
        if (config.backend !== "external-cli") {
          if (config.provider === "openai" || config.provider === "openrouter") {
            return new DryRunJudgeBackend(candidateId, configuredJudgeCapabilities(config))
          }
        } else if (config.external_cli && executableAvailable(config.external_cli.executable)) {
          const profile = resolveRuntimeProfileCandidate(
            candidateId,
            RoleProfileConfigSchema.parse({ ...config, credential: undefined }),
            [],
          )
          const backend = judgeBackendFor(
            profile,
            undefined,
            context.workspaceRoot,
            context.controlRoot ?? context.workspaceRoot,
            context.runId,
            telemetryPolicyForEffectiveOptions(context.effectiveOptions),
          )
          return new DryRunJudgeBackend(candidateId, backend.capabilities())
        }
        const hasNext = candidateIds[index + 1] !== undefined
        if (!hasNext || !requestedConfig.fallback_on.includes("provider-unavailable")) {
          return undefined
        }
      }
      return undefined
    }

    let credentialsPromise: ReturnType<S04Services["credentials"]["list"]> | undefined
    let catalogPromise: ReturnType<S04Services["credentials"]["catalogSnapshot"]> | undefined
    const credentials = () => (credentialsPromise ??= options.s04.credentials.list())
    const catalog = () =>
      (catalogPromise ??= options.s04.credentials
        .catalogSnapshot({ refresh: false })
        .catch((cause) => {
          throw new RalphError(
            "RALPH_MODEL_CATALOG_UNAVAILABLE",
            "Model catalog is unavailable for the selected embedded judge route",
            { exitCode: EXIT_CODES.providerUnavailable, cause },
          )
        }))
    const candidates: JudgeBackendCandidate[] = candidateIds.map((candidateId) => {
      const config = profileConfigs[candidateId]
      if (!config) throw new Error(`Runtime judge fallback profile disappeared: ${candidateId}`)
      return {
        profileId: candidateId,
        capabilities: configuredJudgeCapabilities(config),
        create: async () => {
          if (
            config.backend === "external-cli" &&
            config.external_cli &&
            !executableAvailable(config.external_cli.executable)
          ) {
            throw new RalphError(
              "RALPH_EXTERNAL_CLI_EXECUTABLE_UNAVAILABLE",
              `External judge CLI executable is unavailable for ${candidateId}`,
              { exitCode: EXIT_CODES.providerUnavailable },
            )
          }
          const catalogHandle = config.backend === "embedded" ? await catalog() : undefined
          const credentialRefs = config.credential ? await credentials() : []
          const profile = resolveRuntimeProfileCandidate(
            candidateId,
            config,
            credentialRefs,
            catalogHandle?.resolution.snapshot,
          )
          if (profile.role !== expectedRole) {
            throw new RalphError(
              "RALPH_JUDGE_PROFILE_ROLE_MISMATCH",
              `Resolved ${context.kind} profile has the wrong role: ${candidateId}`,
              { exitCode: EXIT_CODES.invalidUsage },
            )
          }
          return judgeBackendFor(
            profile,
            catalogHandle,
            context.workspaceRoot,
            context.controlRoot ?? context.workspaceRoot,
            context.runId,
            telemetryPolicyForEffectiveOptions(context.effectiveOptions),
          )
        },
      }
    })
    if (candidates.length === 1) {
      const only = candidates[0] as JudgeBackendCandidate
      const config = profileConfigs[only.profileId]
      if (
        config?.backend === "external-cli" &&
        config.external_cli &&
        !executableAvailable(config.external_cli.executable)
      ) {
        return undefined
      }
      return only.create()
    }
    const policy = FallbackPolicySchema.parse({
      allowedFailures: requestedConfig.fallback_on,
    })
    return new CommandFallbackJudgeBackend(profileId, candidates, policy)
  }

  return { resolveBackend, resolveJudge, toolPort }
}
