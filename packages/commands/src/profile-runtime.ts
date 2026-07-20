import {
  EXIT_CODES,
  type ExitCode,
  ProfileIdSchema,
  RalphError,
  type RoleProfileConfig,
  RoleProfileConfigSchema,
} from "@ralph-next/domain"
import {
  type CredentialRef,
  CredentialRefSchema,
  type FallbackPolicy,
  FallbackPolicySchema,
  type ModelCatalogSnapshot,
  type ModelInfo,
  type ModelParameters,
  type ModelRequirements,
  modelSatisfiesRequirements,
  ProviderCoreError,
  type ProviderInfo,
  type RoleProfile,
  RoleProfileSchema,
  resolveModelParameters,
  validateModelCatalogSnapshotIntegrity,
} from "@ralph-next/providers"

export type RuntimeProfileResolution = {
  profiles: Readonly<Record<string, RoleProfile>>
  fallbackPolicies: Readonly<Record<string, FallbackPolicy>>
  catalogSnapshotId: string
}

const UNUSABLE_STATUSES = new Set(["unavailable", "deprecated"])

function profileError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  exitCode: ExitCode = EXIT_CODES.invalidUsage,
): RalphError {
  return new RalphError(code, message, { exitCode, details: { ...details } })
}

function parseSnapshot(input: ModelCatalogSnapshot): ModelCatalogSnapshot {
  try {
    return validateModelCatalogSnapshotIntegrity(input)
  } catch {
    throw profileError(
      "RALPH_PROFILE_CATALOG_INVALID",
      "The model catalog snapshot is invalid or failed its integrity check",
      {},
      EXIT_CODES.providerUnavailable,
    )
  }
}

function parseConfigs(
  input: Readonly<Record<string, RoleProfileConfig>>,
): Readonly<Record<string, RoleProfileConfig>> {
  const result: Record<string, RoleProfileConfig> = {}
  for (const [profileId, candidate] of Object.entries(input)) {
    if (!ProfileIdSchema.safeParse(profileId).success) {
      throw profileError("RALPH_PROFILE_ID_INVALID", `Role profile id is invalid: ${profileId}`, {
        profile: profileId,
      })
    }
    const parsed = RoleProfileConfigSchema.safeParse(candidate)
    if (!parsed.success) {
      throw profileError(
        "RALPH_PROFILE_CONFIG_INVALID",
        `Role profile configuration is invalid: ${profileId}`,
        {
          profile: profileId,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
          })),
        },
      )
    }
    result[profileId] = parsed.data
  }
  return result
}

function credentialIndex(input: readonly CredentialRef[]): ReadonlyMap<string, CredentialRef> {
  const result = new Map<string, CredentialRef>()
  for (const [index, candidate] of input.entries()) {
    const parsed = CredentialRefSchema.safeParse(candidate)
    if (!parsed.success) {
      throw profileError(
        "RALPH_PROFILE_CREDENTIAL_REF_INVALID",
        `Credential reference at index ${index} is invalid`,
        { credentialIndex: index },
      )
    }
    const ref = parsed.data
    if (result.has(ref.id)) {
      throw profileError(
        "RALPH_PROFILE_CREDENTIAL_REF_DUPLICATE",
        `Credential reference id is duplicated: ${ref.id}`,
        { credential: ref.id },
      )
    }
    result.set(ref.id, ref)
  }
  return result
}

function requirements(config: RoleProfileConfig): ModelRequirements {
  return {
    input: config.requirements.input,
    tools: config.requirements.tools,
    toolStreaming: config.requirements.tool_streaming,
    reasoning: config.requirements.reasoning,
    structuredOutput: config.requirements.structured_output,
    usage: config.requirements.usage,
    access: config.requirements.access,
    ...(config.requirements.minimum_context === undefined
      ? {}
      : { minimumContext: config.requirements.minimum_context }),
    ...(config.requirements.minimum_output === undefined
      ? {}
      : { minimumOutput: config.requirements.minimum_output }),
  }
}

function limits(config: RoleProfileConfig): RoleProfile["limits"] {
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

function resolveCredential(
  profileId: string,
  config: RoleProfileConfig,
  credentials: ReadonlyMap<string, CredentialRef>,
): CredentialRef | undefined {
  if (config.credential === undefined) return undefined
  const credential = credentials.get(config.credential)
  if (!credential) {
    throw profileError(
      "RALPH_PROFILE_CREDENTIAL_NOT_FOUND",
      `Credential reference was not found for role profile ${profileId}`,
      { profile: profileId, credential: config.credential },
    )
  }
  if (credential.provider !== config.provider) {
    throw profileError(
      "RALPH_PROFILE_CREDENTIAL_PROVIDER_MISMATCH",
      `Credential provider does not match role profile ${profileId}`,
      {
        profile: profileId,
        credential: credential.id,
        expectedProvider: config.provider,
        actualProvider: credential.provider,
      },
    )
  }
  return credential
}

function embeddedTarget(
  profileId: string,
  config: RoleProfileConfig,
  snapshot: ModelCatalogSnapshot,
): { provider: ProviderInfo; model: ModelInfo; parameters: ModelParameters } {
  const provider = snapshot.providers.find((candidate) => candidate.id === config.provider)
  if (!provider) {
    throw profileError(
      "RALPH_PROFILE_PROVIDER_NOT_FOUND",
      `Provider is not present in the catalog for role profile ${profileId}`,
      { profile: profileId, provider: config.provider },
      EXIT_CODES.providerUnavailable,
    )
  }
  if (UNUSABLE_STATUSES.has(provider.status)) {
    throw profileError(
      "RALPH_PROFILE_PROVIDER_UNAVAILABLE",
      `Provider is not usable for role profile ${profileId}`,
      { profile: profileId, provider: provider.id, status: provider.status },
      EXIT_CODES.providerUnavailable,
    )
  }

  const model = snapshot.models.find(
    (candidate) => candidate.provider === provider.id && candidate.id === config.model,
  )
  if (!model) {
    throw profileError(
      "RALPH_PROFILE_MODEL_NOT_FOUND",
      `Model is not present in the catalog for role profile ${profileId}`,
      { profile: profileId, provider: provider.id, model: config.model },
      EXIT_CODES.providerUnavailable,
    )
  }
  if (UNUSABLE_STATUSES.has(model.status)) {
    throw profileError(
      "RALPH_PROFILE_MODEL_UNAVAILABLE",
      `Model is not usable for role profile ${profileId}`,
      { profile: profileId, provider: provider.id, model: model.id, status: model.status },
      EXIT_CODES.providerUnavailable,
    )
  }
  let parameters: ModelParameters
  try {
    parameters = resolveModelParameters(model, {
      ...(config.variant ? { variant: config.variant } : {}),
      parameters: config.parameters,
    }).parameters
  } catch (error) {
    if (!(error instanceof ProviderCoreError)) throw error
    const codeByProviderError: Readonly<Record<string, string>> = {
      PROVIDER_MODEL_VARIANT_NOT_FOUND: "RALPH_PROFILE_VARIANT_NOT_FOUND",
      PROVIDER_MODEL_PARAMETER_UNKNOWN: "RALPH_PROFILE_PARAMETER_UNKNOWN",
      PROVIDER_MODEL_PARAMETER_VALUE_INVALID: "RALPH_PROFILE_PARAMETER_VALUE_INVALID",
      PROVIDER_MODEL_PARAMETER_VALUE_UNDECLARED: "RALPH_PROFILE_PARAMETER_VALUE_UNDECLARED",
      PROVIDER_MODEL_PARAMETER_CONFLICT: "RALPH_PROFILE_PARAMETER_CONFLICT",
    }
    throw profileError(
      codeByProviderError[error.code] ?? "RALPH_PROFILE_PARAMETER_INVALID",
      `Model variant or parameters are invalid for role profile ${profileId}: ${error.message}`,
      { profile: profileId, ...error.details },
    )
  }

  const required = requirements(config)
  if (!modelSatisfiesRequirements(model, required)) {
    throw profileError(
      "RALPH_PROFILE_MODEL_CAPABILITY_MISMATCH",
      `Model does not satisfy the requirements of role profile ${profileId}`,
      { profile: profileId, provider: provider.id, model: model.id },
    )
  }

  if (
    config.limits.max_input_tokens !== undefined &&
    model.limits.context !== undefined &&
    config.limits.max_input_tokens > model.limits.context
  ) {
    throw profileError(
      "RALPH_PROFILE_MODEL_LIMIT_MISMATCH",
      `Input token limit exceeds the catalog limit for role profile ${profileId}`,
      { profile: profileId, provider: provider.id, model: model.id, limit: "input" },
    )
  }
  if (
    config.limits.max_output_tokens !== undefined &&
    model.limits.output !== undefined &&
    config.limits.max_output_tokens > model.limits.output
  ) {
    throw profileError(
      "RALPH_PROFILE_MODEL_LIMIT_MISMATCH",
      `Output token limit exceeds the catalog limit for role profile ${profileId}`,
      { profile: profileId, provider: provider.id, model: model.id, limit: "output" },
    )
  }

  return { provider, model, parameters }
}

function validateCredentialCompatibility(
  profileId: string,
  config: RoleProfileConfig,
  credential: CredentialRef | undefined,
  provider: ProviderInfo,
  model: ModelInfo,
): void {
  if (!credential) return
  const method = provider.credentialMethods.find(
    (candidate) => candidate.method === credential.method,
  )
  if (!method) {
    throw profileError(
      "RALPH_PROFILE_CREDENTIAL_METHOD_UNSUPPORTED",
      `Credential method is not supported by the provider for role profile ${profileId}`,
      {
        profile: profileId,
        credential: credential.id,
        provider: provider.id,
        method: credential.method,
      },
    )
  }

  const providerAccess = new Set(provider.access)
  const modelAccess = new Set(model.access)
  const methodAccess = new Set(method.access)
  const usableAccess = method.access.filter(
    (entry) => providerAccess.has(entry) && modelAccess.has(entry),
  )
  const requiredAccessSupported = config.requirements.access.every((entry) =>
    methodAccess.has(entry),
  )
  if (usableAccess.length === 0 || !requiredAccessSupported) {
    throw profileError(
      "RALPH_PROFILE_CREDENTIAL_ACCESS_MISMATCH",
      `Credential access is incompatible with role profile ${profileId}`,
      {
        profile: profileId,
        credential: credential.id,
        provider: provider.id,
        model: model.id,
        method: credential.method,
        credentialAccess: method.access,
        requiredAccess: config.requirements.access,
      },
    )
  }
}

function validateExternalCapabilities(profileId: string, config: RoleProfileConfig): void {
  if (config.backend !== "external-cli" || !config.external_cli) return
  const required = config.requirements
  const declared = config.external_cli.capabilities
  const unsupportedInput = required.input.filter((kind) => kind !== "text")
  const mismatches: string[] = []
  if (unsupportedInput.length > 0) mismatches.push(`input:${unsupportedInput.join(",")}`)
  if (required.tools && declared.tool_calling !== "ralph") mismatches.push("tools")
  if (required.tool_streaming && !declared.streaming) mismatches.push("tool_streaming")
  if (required.reasoning) mismatches.push("reasoning")
  if (required.structured_output && config.external_cli.adapter === "generic") {
    mismatches.push("structured_output")
  }
  if (required.usage.length > 0 && declared.usage === "unavailable") {
    mismatches.push(`usage:${required.usage.join(",")}`)
  }
  if (required.minimum_context !== undefined) mismatches.push("minimum_context")
  if (required.minimum_output !== undefined) mismatches.push("minimum_output")
  if (mismatches.length === 0) return
  throw profileError(
    "RALPH_PROFILE_EXTERNAL_CAPABILITY_MISMATCH",
    `External CLI capabilities do not satisfy role profile ${profileId}`,
    {
      profile: profileId,
      provider: config.provider,
      model: config.model,
      mismatches,
      declared,
    },
  )
}

function validateFallbackGraph(configs: Readonly<Record<string, RoleProfileConfig>>): void {
  for (const [profileId, config] of Object.entries(configs)) {
    for (const fallbackId of config.fallback_profiles) {
      if (fallbackId === profileId) {
        throw profileError(
          "RALPH_PROFILE_FALLBACK_SELF_REFERENCE",
          `Role profile cannot fall back to itself: ${profileId}`,
          { profile: profileId },
        )
      }
      const fallback = configs[fallbackId]
      if (!fallback) {
        throw profileError(
          "RALPH_PROFILE_FALLBACK_NOT_FOUND",
          `Fallback role profile was not found: ${fallbackId}`,
          { profile: profileId, fallback: fallbackId },
        )
      }
      if (fallback.role !== config.role) {
        throw profileError(
          "RALPH_PROFILE_FALLBACK_ROLE_MISMATCH",
          `Fallback role does not match role profile ${profileId}`,
          {
            profile: profileId,
            fallback: fallbackId,
            expectedRole: config.role,
            actualRole: fallback.role,
          },
        )
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (profileId: string, path: readonly string[]): void => {
    if (visiting.has(profileId)) {
      throw profileError(
        "RALPH_PROFILE_FALLBACK_CYCLE",
        `Role profile fallback cycle detected: ${[...path, profileId].join(" -> ")}`,
        { profiles: [...path, profileId] },
      )
    }
    if (visited.has(profileId)) return
    visiting.add(profileId)
    const config = configs[profileId]
    for (const fallbackId of config?.fallback_profiles ?? []) {
      visit(fallbackId, [...path, profileId])
    }
    visiting.delete(profileId)
    visited.add(profileId)
  }
  for (const profileId of Object.keys(configs)) visit(profileId, [])
}

function runtimeProfile(
  profileId: string,
  config: RoleProfileConfig,
  credential: CredentialRef | undefined,
  parameters: ModelParameters = config.parameters,
): RoleProfile {
  const parsed = RoleProfileSchema.safeParse({
    id: profileId,
    role: config.role,
    backend: config.backend,
    provider: config.provider,
    model: config.model,
    ...(credential === undefined ? {} : { credential }),
    ...(config.variant === undefined ? {} : { variant: config.variant }),
    parameters,
    requirements: requirements(config),
    fallbackProfiles: config.fallback_profiles,
    limits: limits(config),
    ...(config.external_cli
      ? {
          externalCli: {
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
        }
      : {}),
  })
  if (!parsed.success) {
    throw profileError(
      "RALPH_PROFILE_RUNTIME_INVALID",
      `Role profile cannot be represented by the runtime contract: ${profileId}`,
      {
        profile: profileId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    )
  }
  return parsed.data
}

/**
 * Materializes immutable attempt inputs from human-facing config. Credential values are never
 * resolved here: only the exact reference named by each profile can cross this boundary.
 */
export function resolveRuntimeProfiles(
  configInput: Readonly<Record<string, RoleProfileConfig>>,
  credentialInput: readonly CredentialRef[],
  snapshotInput: ModelCatalogSnapshot,
): RuntimeProfileResolution {
  const snapshot = parseSnapshot(snapshotInput)
  const configs = parseConfigs(configInput)
  const credentials = credentialIndex(credentialInput)
  validateFallbackGraph(configs)

  const profiles: Record<string, RoleProfile> = {}
  const fallbackPolicies: Record<string, FallbackPolicy> = {}
  for (const [profileId, config] of Object.entries(configs)) {
    const credential = resolveCredential(profileId, config, credentials)
    let parameters: ModelParameters = config.parameters
    if (config.backend === "embedded") {
      const target = embeddedTarget(profileId, config, snapshot)
      validateCredentialCompatibility(profileId, config, credential, target.provider, target.model)
      parameters = target.parameters
    } else {
      validateExternalCapabilities(profileId, config)
    }
    profiles[profileId] = runtimeProfile(profileId, config, credential, parameters)
    fallbackPolicies[profileId] = FallbackPolicySchema.parse({
      allowedFailures: config.fallback_on,
    })
  }

  return {
    profiles,
    fallbackPolicies,
    catalogSnapshotId: snapshot.id,
  }
}

/**
 * Resolves one already-selected profile without eagerly materializing sibling
 * roles or fallback targets. Commands use this at the fallback boundary so an
 * unavailable primary can be classified before the next authorized candidate
 * is constructed.
 */
export function resolveRuntimeProfileCandidate(
  profileId: string,
  configInput: RoleProfileConfig,
  credentialInput: readonly CredentialRef[],
  snapshotInput?: ModelCatalogSnapshot,
): RoleProfile {
  if (!ProfileIdSchema.safeParse(profileId).success) {
    throw profileError("RALPH_PROFILE_ID_INVALID", `Role profile id is invalid: ${profileId}`, {
      profile: profileId,
    })
  }
  const parsed = RoleProfileConfigSchema.safeParse(configInput)
  if (!parsed.success) {
    throw profileError(
      "RALPH_PROFILE_CONFIG_INVALID",
      `Role profile configuration is invalid: ${profileId}`,
      {
        profile: profileId,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    )
  }
  const config = parsed.data
  const credentials = credentialIndex(credentialInput)
  const credential = resolveCredential(profileId, config, credentials)
  let parameters: ModelParameters = config.parameters
  if (config.backend === "embedded") {
    if (!snapshotInput) {
      throw profileError(
        "RALPH_PROFILE_CATALOG_REQUIRED",
        `Embedded role profile requires a catalog snapshot: ${profileId}`,
        { profile: profileId },
        EXIT_CODES.providerUnavailable,
      )
    }
    const snapshot = parseSnapshot(snapshotInput)
    const target = embeddedTarget(profileId, config, snapshot)
    validateCredentialCompatibility(profileId, config, credential, target.provider, target.model)
    parameters = target.parameters
  } else {
    validateExternalCapabilities(profileId, config)
  }
  return runtimeProfile(profileId, config, credential, parameters)
}
