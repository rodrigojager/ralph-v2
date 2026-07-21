import { realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

import {
  type EffectiveConfig,
  type EffectiveRunOptions,
  EffectiveRunOptionsSchema,
  EXIT_CODES,
  GateResultSchema,
  type ProfileParameters,
  RalphConfigSchema,
  RalphError,
  type RoleProfileConfig,
  RoleProfileConfigSchema,
  TelemetryConfigSchema,
} from "@ralph/domain"
import {
  type JudgeBackendEvent,
  JudgeEvaluationBundleSchema,
  type JudgeRequest,
} from "@ralph/evaluation"
import { ExternalCliExecutionError, ExternalCliJudgeError } from "@ralph/model-drivers"
import { OpenAiDriverError } from "@ralph/openai-driver"
import type { ContextTruncation, ExecutionChannel } from "@ralph/orchestration"
import { rawPersistenceEnabled, resolveDiagnosticRawRetention } from "@ralph/persistence"
import { PrdTaskSchema, VerificationSpecSchema } from "@ralph/prd"
import { ProviderToolCallSchema, ProviderToolDefinitionSchema } from "@ralph/providers"
import {
  type BuiltinWorkerAdapterFactory,
  BunProcessSupervisor,
  type ExecutorModelWorkerRequest,
  type GitIntegrationWorkerRequest,
  ProcessSettlementSchema,
  type RalphWorkerRoleAdapter,
  shellProcessArgv,
  type ToolWorkerRequest,
  type WorkerCommandInvocation,
  type WorkerJsonValue,
  WorkerOperationError,
  type WorkerProfileSnapshot,
  type WorkerRoleAdapterContext,
} from "@ralph/supervisor"
import { secretValuesFromEnvironment } from "@ralph/telemetry"
import {
  createBuiltinToolRegistry,
  type ProcessExecutorPort,
  type ProcessPortResult,
  SupervisorProcessExecutorAdapter,
  type ToolEvent,
  type ToolExecutionResult,
  ToolPolicySchema,
  type ToolSession,
  WorkspacePathResolver,
} from "@ralph/tool-host"
import { createDefaultGateExecutorRegistry, type GateExecutionOutcome } from "@ralph/verification"
import { executeChildWorkerRuntime } from "./child-worker-runtime"
import { DurableProcessResultSchema } from "./durable-process-owner"
import { createS04Services } from "./s04-services"
import { createS05Services } from "./s05-services"
import {
  createWorkspaceBunProcessSupervisor,
  WorkspaceArtifactPublisher,
} from "./tool-execution-port"
import { workerProfileConfigHash } from "./worker-profile"

const SUPERVISED_COMMAND_ENVIRONMENT_NAMES = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "SystemDrive",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
] as const

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerOperationError("RALPH_WORKER_PAYLOAD_INVALID", `${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringEnvironment(value: unknown, name: string): Record<string, string> {
  const source = record(value, name)
  const environment: Record<string, string> = {}
  for (const [key, item] of Object.entries(source)) {
    if (typeof item !== "string") {
      throw new WorkerOperationError(
        "RALPH_WORKER_PAYLOAD_INVALID",
        `${name}.${key} must be a string`,
      )
    }
    environment[key] = item
  }
  return environment
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new WorkerOperationError("RALPH_WORKER_PAYLOAD_INVALID", `${name} must be a string array`)
  }
  return [...value]
}

function effectiveConfig(value: WorkerJsonValue | undefined): EffectiveConfig | undefined {
  if (value === undefined) return undefined
  const candidate = record(value, "effectiveConfig")
  return {
    config: RalphConfigSchema.parse(candidate.config),
    values: record(candidate.values, "effectiveConfig.values") as EffectiveConfig["values"],
  }
}

function executorWorkerFailure(error: unknown): WorkerOperationError {
  if (error instanceof WorkerOperationError) return error
  if (error instanceof ExternalCliExecutionError) {
    return new WorkerOperationError(
      error.kind === "transient"
        ? "RALPH_EXECUTOR_TRANSPORT_TRANSIENT"
        : "RALPH_EXECUTOR_TRANSPORT_CANCELLED",
      error.message,
      error.kind === "transient",
    )
  }
  if (error instanceof OpenAiDriverError) {
    switch (error.kind) {
      case "rate-limit":
        return new WorkerOperationError("RALPH_EXECUTOR_RATE_LIMIT", error.message, true)
      case "eligibility":
        return new WorkerOperationError("RALPH_EXECUTOR_MODEL_UNAVAILABLE", error.message, true)
      case "transport":
      case "timeout":
      case "provider":
        return new WorkerOperationError("RALPH_EXECUTOR_TRANSPORT_TRANSIENT", error.message, true)
      case "authentication":
        return new WorkerOperationError("RALPH_EXECUTOR_AUTHENTICATION_FAILED", error.message)
      case "invalid-input":
      case "protocol-drift":
        return new WorkerOperationError("RALPH_EXECUTOR_CONFIGURATION_FAILED", error.message)
      case "cancelled":
        return new WorkerOperationError("RALPH_EXECUTOR_TRANSPORT_CANCELLED", error.message)
    }
  }
  if (error instanceof RalphError) {
    const authenticationOrConfiguration =
      error.code.includes("AUTH") || error.code.includes("CREDENTIAL")
    return new WorkerOperationError(
      error.code,
      error.message,
      error.exitCode === EXIT_CODES.providerUnavailable && !authenticationOrConfiguration,
    )
  }
  return new WorkerOperationError(
    "RALPH_EXECUTOR_CANDIDATE_FAILED",
    error instanceof Error ? error.message : String(error),
  )
}

function judgeWorkerFailure(error: unknown): WorkerOperationError {
  if (error instanceof WorkerOperationError) return error
  if (error instanceof ExternalCliJudgeError) {
    const code =
      error.kind === "transient"
        ? "RALPH_JUDGE_TRANSPORT_TRANSIENT"
        : error.kind === "cancelled"
          ? "RALPH_JUDGE_TRANSPORT_CANCELLED"
          : "RALPH_JUDGE_CANDIDATE_FAILED"
    return new WorkerOperationError(code, error.message, error.kind === "transient")
  }
  if (error instanceof OpenAiDriverError) {
    switch (error.kind) {
      case "rate-limit":
        return new WorkerOperationError("RALPH_JUDGE_RATE_LIMIT", error.message, true)
      case "eligibility":
        return new WorkerOperationError("RALPH_JUDGE_MODEL_UNAVAILABLE", error.message, true)
      case "transport":
      case "timeout":
      case "provider":
        return new WorkerOperationError("RALPH_JUDGE_TRANSPORT_TRANSIENT", error.message, true)
      case "authentication":
        return new WorkerOperationError("RALPH_JUDGE_AUTHENTICATION_FAILED", error.message)
      case "invalid-input":
      case "protocol-drift":
        return new WorkerOperationError("RALPH_JUDGE_CONFIGURATION_FAILED", error.message)
      case "cancelled":
        return new WorkerOperationError("RALPH_JUDGE_TRANSPORT_CANCELLED", error.message)
    }
  }
  if (error instanceof RalphError) {
    const authenticationOrConfiguration =
      error.code.includes("AUTH") || error.code.includes("CREDENTIAL")
    return new WorkerOperationError(
      error.code,
      error.message,
      error.exitCode === EXIT_CODES.providerUnavailable && !authenticationOrConfiguration,
    )
  }
  return new WorkerOperationError(
    "RALPH_JUDGE_CANDIDATE_FAILED",
    error instanceof Error ? error.message : String(error),
  )
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value
}

function canonicalProcessExecutable(declared: string): string {
  const candidate = isAbsolute(declared) ? declared : Bun.which(declared)
  if (!candidate) {
    throw new WorkerOperationError(
      "RALPH_WORKER_TOOL_COMMAND_BINDING_INVALID",
      `Authorized process executable is unavailable: ${declared}`,
    )
  }
  return realpathSync.native(candidate)
}

function assertTransportBinding(input: {
  subject: "executor" | "judge"
  codePrefix: "RALPH_EXECUTOR_TRANSPORT" | "RALPH_JUDGE_TRANSPORT"
  command: WorkerCommandInvocation | undefined
  profile: RoleProfileConfig
  workspaceRoot: string
}): void {
  const { command, profile } = input
  if (profile.backend !== "external-cli") {
    if (command) {
      throw new WorkerOperationError(
        `${input.codePrefix}_BINDING_INVALID`,
        `An embedded ${input.subject} profile cannot receive an external transport command`,
      )
    }
    return
  }
  if (!profile.external_cli || !command) {
    throw new WorkerOperationError(
      `${input.codePrefix}_BINDING_REQUIRED`,
      `An external ${input.subject} profile requires its exact command binding`,
    )
  }
  const executable = realpathSync.native(profile.external_cli.executable)
  const cwd = realpathSync.native(resolve(input.workspaceRoot, profile.external_cli.cwd))
  const environmentNames = Object.keys(profile.external_cli.environment_refs ?? {})
    .map((name) => (process.platform === "win32" ? name.toLocaleUpperCase("en-US") : name))
    .sort()
  const commandEnvironmentNames = command.environmentNames
    .map((name) => (process.platform === "win32" ? name.toLocaleUpperCase("en-US") : name))
    .sort()
  if (
    comparable(executable) !== comparable(command.executable) ||
    comparable(cwd) !== comparable(command.cwd) ||
    JSON.stringify(profile.external_cli.args) !== JSON.stringify(command.args) ||
    JSON.stringify(environmentNames) !== JSON.stringify(commandEnvironmentNames)
  ) {
    throw new WorkerOperationError(
      `${input.codePrefix}_BINDING_MISMATCH`,
      `External ${input.subject} config does not match its canonical command capability`,
    )
  }
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

function workerProfileConfig(
  profileId: string,
  kind: "executor" | "external-judge" | "self-judge",
  options: EffectiveRunOptions,
  effective: EffectiveConfig,
): RoleProfileConfig {
  const selected = effective.config.profiles[profileId]
  if (!selected) {
    throw new WorkerOperationError(
      "RALPH_WORKER_PROFILE_MISSING",
      `Worker profile is absent from the immutable configuration: ${profileId}`,
    )
  }
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

function assertWorkerProfileBinding(
  snapshot: WorkerProfileSnapshot,
  config: RoleProfileConfig,
): void {
  const expectedHash = workerProfileConfigHash(config)
  const matches =
    snapshot.configHash === expectedHash &&
    snapshot.role === config.role &&
    snapshot.backend === config.backend &&
    snapshot.provider === config.provider &&
    snapshot.model === config.model &&
    snapshot.variant === config.variant &&
    snapshot.credentialRef === config.credential
  if (!matches) {
    throw new WorkerOperationError(
      "RALPH_WORKER_PROFILE_BINDING_INVALID",
      `Worker profile snapshot no longer matches immutable configuration: ${snapshot.profileId}`,
    )
  }
}

function boundedJson(value: unknown, maximumBytes: number, name: string): string {
  const output = JSON.stringify(value)
  if (output === undefined) {
    throw new WorkerOperationError(
      "RALPH_WORKER_RESULT_INVALID",
      `${name} is not JSON-serializable`,
    )
  }
  if (Buffer.byteLength(output, "utf8") > maximumBytes) {
    throw new WorkerOperationError(
      "RALPH_WORKER_RESULT_TOO_LARGE",
      `${name} exceeds the authenticated worker result boundary`,
    )
  }
  return output
}

function durableProcessResult(value: unknown): ProcessPortResult {
  const parsed = DurableProcessResultSchema.parse(value)
  const { exitCode, signal, error, ...required } = parsed
  return {
    ...required,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

function environmentFor(names: readonly string[]): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const requested of names) {
    const expected = process.platform === "win32" ? requested.toLocaleLowerCase("und") : requested
    const match = Object.entries(process.env).find(([name, value]) => {
      if (value === undefined) return false
      return (process.platform === "win32" ? name.toLocaleLowerCase("und") : name) === expected
    })
    if (match?.[1] !== undefined) environment[requested] = match[1]
  }
  return environment
}

async function runDeclaredCommand(
  invocation: WorkerCommandInvocation,
  context: WorkerRoleAdapterContext,
  options: {
    timeoutMs: number
    maximumOutputBytes: number
    maximumRawOutputBytes?: number
    stdin?: string
    environmentRefs?: Readonly<Record<string, string>>
  },
) {
  const command = context.canonicalCommands([invocation])[0]
  if (!command) throw new WorkerOperationError("RALPH_WORKER_COMMAND_DENIED", "Command is absent")
  const sourceEnvironmentNames = Object.values(options.environmentRefs ?? {}).map((reference) => {
    const sourceName = /^(?:env|environment):([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference)?.[1]
    if (!sourceName) {
      throw new WorkerOperationError(
        "RALPH_WORKER_COMMAND_ENVIRONMENT_INVALID",
        `Command contains an unsupported environment reference: ${reference}`,
      )
    }
    return sourceName
  })
  const supervisor = new BunProcessSupervisor()
  return supervisor.run({
    executable: command.executable,
    args: command.args,
    cwd: command.cwd,
    environment: environmentFor([
      ...SUPERVISED_COMMAND_ENVIRONMENT_NAMES,
      ...command.environmentNames,
      ...sourceEnvironmentNames,
    ]),
    ...(options.environmentRefs ? { environmentRefs: options.environmentRefs } : {}),
    shell: false,
    timeoutMs: options.timeoutMs,
    gracePeriodMs: 750,
    outputLimitBytes: options.maximumOutputBytes,
    rawOutputLimitBytes: options.maximumRawOutputBytes ?? options.maximumOutputBytes,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    expectedCanonicalCwd: command.cwd,
    expectedExecutableSha256: command.executableHash,
    signal: context.signal,
    secretValues: secretValuesFromEnvironment(process.env),
  })
}

function contextResources(request: ExecutorModelWorkerRequest) {
  return request.resources.map((payload) => {
    if (payload.content === undefined) {
      throw new WorkerOperationError(
        "RALPH_WORKER_RESOURCE_UNMATERIALIZED",
        `Context resource was not materialized: ${payload.resource.ref}`,
      )
    }
    const kind = payload.resource.kind
    if (!["verification", "full-prd", "assessment", "recovery"].includes(kind)) {
      throw new WorkerOperationError(
        "RALPH_WORKER_RESOURCE_KIND_INVALID",
        `Context resource has an unknown kind: ${kind}`,
      )
    }
    return {
      ref: payload.resource.ref,
      kind: kind as "verification" | "full-prd" | "assessment" | "recovery",
      mediaType: (payload.resource.mediaType ?? "text/markdown") as
        | "application/json"
        | "text/markdown",
      encoding: "utf-8" as const,
      content: payload.content,
      contentHash: payload.resource.contentHash,
      includedHash: payload.resource.includedHash ?? payload.resource.contentHash,
      originalBytes: payload.resource.byteLength ?? Buffer.byteLength(payload.content, "utf8"),
      includedBytes:
        payload.resource.includedByteLength ?? Buffer.byteLength(payload.content, "utf8"),
      truncated: payload.resource.truncated,
    }
  })
}

function contextTruncations(request: ExecutorModelWorkerRequest): ContextTruncation[] {
  return request.contextTruncations.map((truncation) => ({
    field: truncation.field,
    reason: truncation.reason,
    originalHash: truncation.originalHash,
    ...(truncation.originalBytes !== undefined ? { originalBytes: truncation.originalBytes } : {}),
    ...(truncation.includedBytes !== undefined ? { includedBytes: truncation.includedBytes } : {}),
    ...(truncation.originalCount !== undefined ? { originalCount: truncation.originalCount } : {}),
    ...(truncation.includedCount !== undefined ? { includedCount: truncation.includedCount } : {}),
  }))
}

function createExecutorAdapter(): RalphWorkerRoleAdapter {
  return {
    role: "executor-model",
    async execute(request, context) {
      const transportCommand = request.transportCommand
        ? context.canonicalCommands([request.transportCommand])[0]
        : undefined
      const options = EffectiveRunOptionsSchema.parse(request.execution.effectiveOptions)
      const config = effectiveConfig(request.execution.effectiveConfig)
      if (!config) {
        throw new WorkerOperationError(
          "RALPH_WORKER_CONFIG_REQUIRED",
          "Executor worker requires the command-resolved immutable configuration",
        )
      }
      const boundProfile = workerProfileConfig(
        request.profile.profileId,
        "executor",
        options,
        config,
      )
      assertWorkerProfileBinding(request.profile, boundProfile)
      assertTransportBinding({
        subject: "executor",
        codePrefix: "RALPH_EXECUTOR_TRANSPORT",
        command: transportCommand,
        profile: boundProfile,
        workspaceRoot: request.scope.workspaceRoot,
      })
      const s04 = createS04Services({ environment: process.env })
      const s05 = createS05Services({
        s04,
        environment: process.env,
        ...(transportCommand
          ? {
              externalExecutorExecutableHashes: {
                [request.profile.profileId]: transportCommand.executableHash,
              },
            }
          : {}),
      })
      const backend = await Promise.resolve(
        s05.resolveBackend(request.profile.profileId, {
          workspaceRoot: request.scope.workspaceRoot,
          runId: request.scope.runId,
          workspaceId: request.scope.workspaceId,
          controlRoot: request.execution.controlRoot,
          effectiveOptions: options,
          dryRun: false,
          config,
        }),
      ).catch((error: unknown) => {
        throw executorWorkerFailure(error)
      })
      if (!backend) {
        throw new WorkerOperationError(
          "RALPH_EXECUTOR_BACKEND_UNAVAILABLE",
          `Executor profile is unavailable inside its worker: ${request.profile.profileId}`,
          true,
        )
      }
      const task = PrdTaskSchema.parse(request.execution.task)
      const tools = request.tools.map((tool) => ProviderToolDefinitionSchema.parse(tool))
      let modelCalls = 0
      let toolCalls = 0
      const channel: ExecutionChannel = {
        emit: (event) =>
          context.callSupervisor("execution.emit-event", event).then(() => undefined),
        async reserveModelCall(input: { callId: string; turn: number }) {
          await context.callSupervisor("execution.reserve-model-call", input)
          modelCalls += 1
        },
        async tools() {
          return tools
        },
        async executeTool(callInput: unknown, callOptions?: { signal?: AbortSignal }) {
          const call = ProviderToolCallSchema.parse(callInput)
          if (callOptions?.signal?.aborted || context.signal.aborted) {
            throw (
              callOptions?.signal?.reason ??
              context.signal.reason ??
              new Error("Tool call cancelled")
            )
          }
          const result = await context.callSupervisor("execution.execute-tool", call)
          const parsed = record(result, "execution tool result")
          if (
            parsed.callId !== call.callId ||
            typeof parsed.output !== "string" ||
            typeof parsed.retryable !== "boolean" ||
            ![
              "success",
              "nonzero",
              "denied",
              "invalid",
              "error",
              "timeout",
              "cancelled",
              "unsettled",
            ].includes(String(parsed.outcome))
          ) {
            throw new WorkerOperationError(
              "RALPH_WORKER_TOOL_RESULT_INVALID",
              "Supervisor returned an invalid tool settlement",
            )
          }
          toolCalls += 1
          return parsed as {
            callId: string
            outcome:
              | "success"
              | "nonzero"
              | "denied"
              | "invalid"
              | "error"
              | "timeout"
              | "cancelled"
              | "unsettled"
            output: string
            retryable: boolean
            settlementRef?: string
          }
        },
        stats() {
          return {
            modelCalls,
            maximumModelCalls: request.limits.maximumModelCalls,
            toolCalls,
            maximumToolCalls: request.limits.maximumToolCalls,
          }
        },
      }
      try {
        const handle = await backend.start(
          {
            runId: request.scope.runId,
            documentId: request.scope.documentId as string,
            taskId: request.scope.taskId as string,
            attemptId: request.scope.attemptId as string,
            modelCallId: request.callId,
            callOrdinal: request.callOrdinal,
            workspaceRoot: request.scope.workspaceRoot,
            contextManifest: request.contextManifest,
            contextBundle: {
              manifest: request.contextManifest,
              resources: contextResources(request),
              truncations: contextTruncations(request),
              canonicalJson: request.execution.contextCanonicalJson,
            },
            task,
            protectedPaths: request.execution.protectedPaths,
            ...(request.scope.deadlineAt ? { deadlineAt: request.scope.deadlineAt } : {}),
            signal: context.signal,
          },
          channel,
        )
        const cancel = (): void => {
          void backend.cancel(handle, "Executor worker request cancelled").catch(() => undefined)
        }
        context.signal.addEventListener("abort", cancel, { once: true })
        try {
          const outcome = await handle.outcome
          return {
            schemaVersion: 1,
            callId: request.callId,
            outcome,
            requestedToolCalls: [],
            observations: [],
            finishReason: outcome.status,
          }
        } finally {
          context.signal.removeEventListener("abort", cancel)
        }
      } catch (error) {
        throw executorWorkerFailure(error)
      }
    },
  }
}

function createJudgeAdapter(): RalphWorkerRoleAdapter {
  return {
    role: "judge",
    async evaluate(request, context) {
      const transportCommand = request.transportCommand
        ? context.canonicalCommands([request.transportCommand])[0]
        : undefined
      const s04 = createS04Services({ environment: process.env })
      const s05 = createS05Services({
        s04,
        environment: process.env,
        ...(transportCommand
          ? {
              externalJudgeExecutableHashes: {
                [request.profile.profileId]: transportCommand.executableHash,
              },
            }
          : {}),
      })
      const options = EffectiveRunOptionsSchema.parse(request.evaluation.effectiveOptions)
      const config = effectiveConfig(request.evaluation.effectiveConfig)
      if (!config) {
        throw new WorkerOperationError(
          "RALPH_WORKER_CONFIG_REQUIRED",
          "Judge worker requires the command-resolved immutable configuration",
        )
      }
      const boundProfile = workerProfileConfig(
        request.profile.profileId,
        request.evaluation.kind === "external" ? "external-judge" : "self-judge",
        options,
        config,
      )
      assertWorkerProfileBinding(request.profile, boundProfile)
      assertTransportBinding({
        subject: "judge",
        codePrefix: "RALPH_JUDGE_TRANSPORT",
        command: transportCommand,
        profile: boundProfile,
        workspaceRoot: request.scope.workspaceRoot,
      })
      const backend = await Promise.resolve(
        s05.resolveJudge(request.profile.profileId, {
          workspaceRoot: request.scope.workspaceRoot,
          runId: request.scope.runId,
          workspaceId: request.scope.workspaceId,
          controlRoot: request.evaluation.controlRoot,
          kind: request.evaluation.kind,
          effectiveOptions: options,
          dryRun: false,
          config,
        }),
      ).catch((error: unknown) => {
        throw judgeWorkerFailure(error)
      })
      if (!backend) {
        throw new WorkerOperationError(
          "RALPH_JUDGE_BACKEND_UNAVAILABLE",
          `Judge profile is unavailable inside its worker: ${request.profile.profileId}`,
          true,
        )
      }
      const judgeRequest: JudgeRequest = {
        callId: request.assessmentId,
        kind: request.evaluation.kind,
        evidenceBundleId: String(record(request.evidence, "judge evidence").id),
        bundle: JudgeEvaluationBundleSchema.parse(request.evaluation.bundle),
        prompt: request.evaluation.prompt,
        signal: context.signal,
      }
      const handle = await backend
        .start(judgeRequest, {
          emit(event: JudgeBackendEvent) {
            return context.callSupervisor("judge.emit-event", event).then(() => undefined)
          },
        })
        .catch((error: unknown) => {
          throw judgeWorkerFailure(error)
        })
      const cancel = (): void => {
        void backend.cancel(handle, "Judge worker request cancelled").catch(() => undefined)
      }
      context.signal.addEventListener("abort", cancel, { once: true })
      try {
        const output = await handle.outcome.catch((error: unknown) => {
          throw judgeWorkerFailure(error)
        })
        const rawResponseRef = handle.rawResponseRef
          ? await handle.rawResponseRef.catch(() => undefined)
          : undefined
        return {
          schemaVersion: 1,
          assessmentId: request.assessmentId,
          output,
          observations: [],
          ...(rawResponseRef ? { rawResponseRef } : {}),
        }
      } finally {
        context.signal.removeEventListener("abort", cancel)
      }
    },
  }
}

function createToolGateAdapter(): RalphWorkerRoleAdapter {
  return {
    role: "tool-gate",
    async executeTool(request: ToolWorkerRequest, context) {
      if ((request.toolCall.name === "process.exec") !== (request.command !== undefined)) {
        throw new WorkerOperationError(
          "RALPH_WORKER_TOOL_COMMAND_BINDING_INVALID",
          "Only process.exec may carry an exact command, and direct process.exec requires it",
        )
      }
      const command = request.command ? context.canonicalCommands([request.command])[0] : undefined
      const registry = createBuiltinToolRegistry()
      const registered = registry.get(request.toolCall.name)
      if (!registered) {
        throw new WorkerOperationError(
          "RALPH_WORKER_TOOL_UNAVAILABLE",
          `Tool is not available in the built-in worker registry: ${request.toolCall.name}`,
        )
      }
      const policy = ToolPolicySchema.parse(request.runtime.policy)
      const sessionInput = record(request.runtime.session, "tool session")
      const sessionEnvironment = stringEnvironment(
        sessionInput.environment ?? {},
        "tool session environment",
      )
      const sessionSecretValues = stringArray(
        sessionInput.secretValues ?? [],
        "tool session secretValues",
      )
      const telemetry = TelemetryConfigSchema.parse(sessionInput.telemetry)
      const session: ToolSession = {
        runId: request.scope.runId,
        documentId: request.scope.documentId as string,
        taskId: request.scope.taskId as string,
        attemptId: request.scope.attemptId as string,
        modelCallId: request.modelCallId,
        workspaceRoot: request.scope.workspaceRoot,
        policy,
        maximumToolCalls:
          typeof sessionInput.maximumToolCalls === "number" ? sessionInput.maximumToolCalls : 1,
        ...(request.scope.deadlineAt ? { deadlineAt: request.scope.deadlineAt } : {}),
        signal: context.signal,
        environment: sessionEnvironment,
        secretValues: sessionSecretValues,
      }
      const resolver = await WorkspacePathResolver.create(request.scope.workspaceRoot, policy)
      const processSupervisor = createWorkspaceBunProcessSupervisor({
        workspaceRoot: request.runtime.controlRoot ?? request.scope.workspaceRoot,
        runId: request.scope.runId,
        secretValues: sessionSecretValues,
        persistRawOutput: rawPersistenceEnabled(telemetry),
        retention: resolveDiagnosticRawRetention(telemetry),
      })
      const processExecutor: ProcessExecutorPort = command
        ? {
            async run(processRequest) {
              const projectedArgv = processRequest.shell
                ? shellProcessArgv(processRequest.shell, processRequest.environment)
                : [processRequest.executable, ...processRequest.args]
              const [declaredExecutable, ...projectedArgs] = projectedArgv
              if (!declaredExecutable) {
                throw new WorkerOperationError(
                  "RALPH_WORKER_TOOL_COMMAND_BINDING_INVALID",
                  "Authorized process projection produced no executable",
                )
              }
              const projectedExecutable = canonicalProcessExecutable(declaredExecutable)
              const projectedCwd = realpathSync.native(processRequest.cwd)
              if (
                comparable(projectedExecutable) !== comparable(command.executable) ||
                comparable(projectedCwd) !== comparable(command.cwd) ||
                JSON.stringify(projectedArgs) !== JSON.stringify(command.args)
              ) {
                throw new WorkerOperationError(
                  "RALPH_WORKER_TOOL_COMMAND_BINDING_INVALID",
                  "Process request differs from its exact canonical command capability",
                )
              }
              if (processRequest.stdin instanceof Uint8Array) {
                throw new WorkerOperationError(
                  "RALPH_WORKER_TOOL_COMMAND_BINDING_INVALID",
                  "Durable worker process stdin must use the bounded text contract",
                )
              }
              const environment = Object.fromEntries(
                Object.entries(processRequest.environment).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              )
              return durableProcessResult(
                await context.callSupervisor("tool.process.execute", {
                  schemaVersion: 1,
                  scope: {
                    workspaceId: request.scope.workspaceId,
                    workspaceRoot: request.scope.workspaceRoot,
                    controlRoot: request.runtime.controlRoot ?? request.scope.workspaceRoot,
                    runId: request.scope.runId,
                    documentId: request.scope.documentId,
                    taskId: request.scope.taskId,
                    attemptId: request.scope.attemptId,
                  },
                  binding: request.journalBinding,
                  command,
                  request: {
                    executable: command.executable,
                    args: [...command.args],
                    // Hand the durable owner the already-canonical path that is
                    // part of the exact command capability. The worker checked
                    // the caller's projection above; forwarding that original
                    // spelling would make authority depend on the worker's cwd.
                    cwd: command.cwd,
                    environment,
                    ...(processRequest.environmentRefs
                      ? { environmentRefs: { ...processRequest.environmentRefs } }
                      : {}),
                    shell: false,
                    ...(processRequest.stdin !== undefined ? { stdin: processRequest.stdin } : {}),
                    timeoutMs: processRequest.timeoutMs,
                    outputLimitBytes: processRequest.outputLimitBytes,
                    rawOutputLimitBytes: processRequest.rawOutputLimitBytes,
                    secretValues: [...(processRequest.secretValues ?? [])],
                    telemetry,
                  },
                }),
              )
            },
            which() {
              return command.executable
            },
          }
        : new SupervisorProcessExecutorAdapter(processSupervisor)
      const input = registered.inputSchema.parse(request.toolCall.arguments)
      const result: ToolExecutionResult = await registered.execute(input, {
        toolCallId: request.toolCall.callId,
        session,
        policy,
        resolver,
        argumentsHash: request.journalBinding.argumentsHash,
        idempotencyKey: request.journalBinding.idempotencyKey,
        process: processExecutor,
        artifacts: new WorkspaceArtifactPublisher({
          workspaceRoot: request.scope.workspaceRoot,
          ...(request.runtime.controlRoot ? { controlRoot: request.runtime.controlRoot } : {}),
          runId: request.scope.runId,
        }),
        events: {
          emit(event: ToolEvent) {
            context.emitProgress("tool.event", {
              summary: event.type,
              eventType: event.type,
              stream: "tool-output",
              text: boundedJson(event, 65_536, "tool event"),
              redacted: true,
            })
          },
        },
      })
      const outcome = result.outcome ?? "success"
      const content = boundedJson(result, 1_048_576, "tool execution result")
      const exitCode = (() => {
        if (outcome !== "nonzero") return undefined
        const resultContent = record(result.content, "tool nonzero content")
        return typeof resultContent.exitCode === "number" ? resultContent.exitCode : -1
      })()
      return {
        schemaVersion: 1,
        callId: request.toolCall.callId,
        outcome,
        output: content,
        retryable: result.retryable ?? false,
        ...(exitCode === undefined ? {} : { exitCode }),
        outputRefs: [...(result.outputRefs ?? [])],
        observations: [],
      }
    },
    async executeGate(request, context) {
      const specification = VerificationSpecSchema.parse(request.specification)
      if (specification.id !== request.gateId) {
        throw new WorkerOperationError(
          "RALPH_WORKER_GATE_BINDING_INVALID",
          "Gate specification ID differs from its dispatched identity",
        )
      }
      let executionSpecification = specification
      let gateCommand: WorkerCommandInvocation | undefined
      if (request.invocation.kind === "command") {
        if (specification.type !== "command") {
          throw new WorkerOperationError(
            "RALPH_WORKER_GATE_COMMAND_INVALID",
            "Command gate invocation requires a command specification",
          )
        }
        const command = context.canonicalCommands([request.invocation.command])[0]
        if (!command) {
          throw new WorkerOperationError(
            "RALPH_WORKER_GATE_COMMAND_INVALID",
            "Command gate capability did not contain its invocation",
          )
        }
        gateCommand = command
        const expectedExecutable = canonicalProcessExecutable(specification.command.executable)
        const expectedCwd = realpathSync.native(
          resolve(request.scope.workspaceRoot, specification.command.cwd ?? "."),
        )
        const expectedEnvironmentNames = Object.keys(
          specification.command.environmentRefs ?? {},
        ).sort()
        const commandEnvironmentNames = [...command.environmentNames].sort()
        if (
          comparable(expectedExecutable) !== comparable(command.executable) ||
          comparable(expectedCwd) !== comparable(command.cwd) ||
          JSON.stringify(specification.command.args) !== JSON.stringify(command.args) ||
          JSON.stringify(expectedEnvironmentNames) !== JSON.stringify(commandEnvironmentNames)
        ) {
          throw new WorkerOperationError(
            "RALPH_WORKER_GATE_COMMAND_INVALID",
            "Command gate specification differs from its exact canonical capability",
          )
        }
        executionSpecification = {
          ...specification,
          command: {
            ...specification.command,
            executable: command.executable,
            args: [...command.args],
            cwd: command.cwd,
          },
        }
      }
      const started = performance.now()
      const persistOutput = async (
        gateId: string,
        stream: "stdout" | "stderr",
        content: string,
      ): Promise<string> => {
        const result = await context.callSupervisor("gate.persist-output", {
          gateId,
          stream,
          content,
        })
        if (typeof result !== "string" || result.length === 0) {
          throw new WorkerOperationError(
            "RALPH_WORKER_GATE_OUTPUT_REF_INVALID",
            "Supervisor returned an invalid gate output reference",
          )
        }
        return result
      }
      let outcome: GateExecutionOutcome
      if (gateCommand && executionSpecification.type === "command") {
        const settlement = await runDeclaredCommand(gateCommand, context, {
          timeoutMs: executionSpecification.command.timeoutMs,
          maximumOutputBytes: executionSpecification.command.outputLimitBytes,
          maximumRawOutputBytes: Math.max(
            executionSpecification.command.outputLimitBytes,
            16 * 1_024 * 1_024,
          ),
          ...(executionSpecification.command.environmentRefs
            ? { environmentRefs: executionSpecification.command.environmentRefs }
            : {}),
        })
        if (settlement.cancelled) {
          throw context.signal.reason instanceof Error
            ? context.signal.reason
            : new WorkerOperationError("RALPH_WORKER_GATE_CANCELLED", "Gate command was cancelled")
        }
        const outputRefs: string[] = []
        if (settlement.rawStdout) {
          outputRefs.push(
            await persistOutput(executionSpecification.id, "stdout", settlement.rawStdout),
          )
        }
        if (settlement.rawStderr) {
          outputRefs.push(
            await persistOutput(executionSpecification.id, "stderr", settlement.rawStderr),
          )
        }
        const shared = {
          command: executionSpecification.command,
          ...(settlement.exitCode === undefined ? {} : { exitCode: settlement.exitCode }),
          outputRefs,
          stdoutBytes: settlement.stdoutBytes,
          stderrBytes: settlement.stderrBytes,
          outputTruncated: settlement.outputTruncated,
          rawOutputTruncated: settlement.rawOutputTruncated,
        }
        if (settlement.error) {
          outcome = { ...shared, status: "unavailable", reason: settlement.error }
        } else if (settlement.timedOut) {
          outcome = { ...shared, status: "timeout", reason: "Command timed out" }
        } else if (
          settlement.exitCode !== undefined &&
          executionSpecification.command.successExitCodes.includes(settlement.exitCode)
        ) {
          outcome = { ...shared, status: "passed" }
        } else {
          outcome = {
            ...shared,
            status: "failed",
            reason: `Unexpected exit code ${String(settlement.exitCode)}`,
          }
        }
      } else {
        outcome = await createDefaultGateExecutorRegistry().execute(executionSpecification, {
          workspaceRoot: request.scope.workspaceRoot,
          environment: process.env,
          ...(request.scope.deadlineAt ? { deadlineAt: request.scope.deadlineAt } : {}),
          signal: context.signal,
          attempt: 1,
          persistOutput,
        })
      }
      const result = GateResultSchema.parse({
        gateId: request.gateId,
        category: request.category,
        blocking: request.blocking,
        skipPolicy: request.skipPolicy,
        ...(request.criterionIds.length > 0 ? { criterionIds: request.criterionIds } : {}),
        status: outcome.status,
        ...(outcome.command ? { command: outcome.command } : {}),
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        attempts: 1,
        outputRefs: outcome.outputRefs ?? [],
        ...(outcome.stdoutBytes === undefined ? {} : { stdoutBytes: outcome.stdoutBytes }),
        ...(outcome.stderrBytes === undefined ? {} : { stderrBytes: outcome.stderrBytes }),
        ...(outcome.outputTruncated === undefined
          ? {}
          : { outputTruncated: outcome.outputTruncated }),
        ...(outcome.rawOutputTruncated === undefined
          ? {}
          : { rawOutputTruncated: outcome.rawOutputTruncated }),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      })
      return { schemaVersion: 1, result, observations: [] }
    },
  }
}

function createGitAdapter(): RalphWorkerRoleAdapter {
  return {
    role: "git-integration",
    async integrate(request: GitIntegrationWorkerRequest, context) {
      const settlement = ProcessSettlementSchema.parse(
        await runDeclaredCommand(request.gitCommand, context, {
          timeoutMs: request.timeoutMs,
          maximumOutputBytes: request.maximumOutputBytes,
          maximumRawOutputBytes: request.maximumRawOutputBytes,
        }),
      )
      const status = settlement.cancelled
        ? "cancelled"
        : settlement.exitCode === 0 && !settlement.timedOut && !settlement.error
          ? "succeeded"
          : "failed"
      return {
        schemaVersion: 1,
        integrationId: request.integrationId,
        action: request.action,
        status,
        conflictPaths: [],
        artifactRefs: settlement.outputRefs,
        summary:
          status === "succeeded"
            ? `Git ${request.action} command completed`
            : `Git ${request.action} command failed`,
        process: settlement,
        observations: [],
      }
    },
  }
}

function createChildAdapter(): RalphWorkerRoleAdapter {
  return {
    role: "child-run",
    async executeChild(request, context) {
      return executeChildWorkerRuntime(request, context)
    },
  }
}

export const createBuiltinRalphWorkerRoleAdapter: BuiltinWorkerAdapterFactory = async ({
  role,
}) => {
  switch (role) {
    case "executor-model":
      return createExecutorAdapter()
    case "judge":
      return createJudgeAdapter()
    case "tool-gate":
      return createToolGateAdapter()
    case "git-integration":
      return createGitAdapter()
    case "child-run":
      return createChildAdapter()
  }
}

export { workerProfileConfigHash }
