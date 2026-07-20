import { z } from "zod"

export const EXIT_CODES = {
  success: 0,
  operationalError: 1,
  invalidUsage: 2,
  invalidPrd: 3,
  verificationFailed: 4,
  blocked: 5,
  providerUnavailable: 6,
  conflict: 7,
  interrupted: 8,
  budgetExceeded: 9,
  policyDenied: 10,
  /** Semantic alias for filesystem/resource absence; remains operational error code 1. */
  notFound: 1,
  /** Semantic alias for denied capabilities/policies; remains policy code 10. */
  permissionDenied: 10,
} as const

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES]

export const DiagnosticSeveritySchema = z.enum(["info", "warning", "error"])

export const DiagnosticSchema = z
  .object({
    code: z.string().min(1),
    severity: DiagnosticSeveritySchema,
    message: z.string().min(1),
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    hint: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export type Diagnostic = z.infer<typeof DiagnosticSchema>

export const CommandResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.boolean(),
    command: z.string().min(1),
    data: z.unknown().optional(),
    diagnostics: z.array(DiagnosticSchema),
    runId: z.string().min(1).optional(),
  })
  .strict()

type CommandResultEnvelope = z.infer<typeof CommandResultSchema>

export type CommandResult<T = unknown> = Omit<CommandResultEnvelope, "data"> & {
  data?: T
}

export const RunModeSchema = z.enum(["once", "loop", "wiggum", "parallel"])
export type RunMode = z.infer<typeof RunModeSchema>

export const UiModeSchema = z.enum(["auto", "tui", "plain", "none"])
export type UiMode = z.infer<typeof UiModeSchema>

export const WorkspaceIdentitySchema = z
  .object({
    schema_version: z.literal(1),
    product: z.literal("ralph-v2"),
    workspace_id: z.uuid(),
    canonical_root: z.string().min(1),
    created_at: z.iso.datetime({ offset: true }),
    created_by_version: z.string().min(1),
  })
  .strict()

export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>

const ReservedEmptyObjectSchema = z.object({}).strict()
export const ProfileIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)

function containsNoTerminalControls(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint > 31 && (codePoint < 127 || codePoint > 159)
  })
}

export const ProfileRoleSchema = z.enum(["executor", "judge"])
export type ProfileRole = z.infer<typeof ProfileRoleSchema>

export const ProfileBackendSchema = z.enum(["embedded", "external-cli"])
export type ProfileBackend = z.infer<typeof ProfileBackendSchema>

const PortablePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(containsNoTerminalControls, "Portable paths cannot contain control characters")
  .superRefine((value, context) => {
    if (
      value.includes("\\") ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      /[<>:"|]/.test(value)
    ) {
      context.addIssue({ code: "custom", message: "Expected a portable relative path" })
    }
    if (
      value !== "." &&
      value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "Portable relative paths cannot contain empty, dot or parent segments",
      })
    }
  })

/** A concrete workspace-relative path, serialized with forward slashes. */
export const PortableRelativePathSchema = PortablePathSchema.refine(
  (value) => !/[?*[\]{}]/.test(value),
  "Concrete portable paths cannot contain glob metacharacters",
)
export type PortableRelativePath = z.infer<typeof PortableRelativePathSchema>

/** A workspace-relative policy scope. Glob metacharacters are intentionally allowed. */
export const PortableRelativeScopeSchema = PortablePathSchema
export type PortableRelativeScope = z.infer<typeof PortableRelativeScopeSchema>

export const ExternalCliEnvironmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Expected an environment variable name")
export const ExternalCliEnvironmentRefSchema = z
  .string()
  .regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/, "Expected an env:<NAME> reference")

const ExternalCliArgumentSchema = z
  .string()
  .max(32_768)
  .refine(containsNoTerminalControls, "External CLI arguments cannot contain control characters")

export const ExternalCliAdapterSchema = z.enum(["protocol", "known-output", "generic"])
export type ExternalCliAdapter = z.infer<typeof ExternalCliAdapterSchema>
export const ExternalCliToolCallingSchema = z.enum(["ralph", "internal", "unavailable"])
export type ExternalCliToolCalling = z.infer<typeof ExternalCliToolCallingSchema>
export const ExternalCliUsageSchema = z.enum(["reported", "estimated", "unavailable"])
export type ExternalCliUsage = z.infer<typeof ExternalCliUsageSchema>
export const ExternalCliMutationModeSchema = z.enum(["read-only", "workspace"])
export type ExternalCliMutationMode = z.infer<typeof ExternalCliMutationModeSchema>

export const ExternalCliCapabilitiesSchema = z
  .object({
    streaming: z.boolean(),
    tool_calling: ExternalCliToolCallingSchema,
    cancellation: z.boolean(),
    usage: ExternalCliUsageSchema,
  })
  .strict()

const ExternalCliCapabilitiesLayerSchema = ExternalCliCapabilitiesSchema.partial()

function validateExternalCliAdapter(
  value: {
    adapter?: ExternalCliAdapter | undefined
    adapter_id?: string | undefined
  },
  context: {
    addIssue(issue: { code: "custom"; message: string; path: string[] }): void
  },
): void {
  if (value.adapter === "known-output" && !value.adapter_id) {
    context.addIssue({
      code: "custom",
      message: "known-output adapters require adapter_id",
      path: ["adapter_id"],
    })
  }
  if (value.adapter !== undefined && value.adapter !== "known-output" && value.adapter_id) {
    context.addIssue({
      code: "custom",
      message: "adapter_id is only valid for known-output adapters",
      path: ["adapter_id"],
    })
  }
}

export const ExternalCliProfileConfigSchema = z
  .object({
    executable: z
      .string()
      .min(1)
      .max(4_096)
      .refine(containsNoTerminalControls, "Executable cannot contain control characters"),
    args: z.array(ExternalCliArgumentSchema).max(1_024),
    cwd: PortableRelativePathSchema,
    environment_refs: z.record(ExternalCliEnvironmentNameSchema, ExternalCliEnvironmentRefSchema),
    input_mode: z.literal("stdin-json"),
    adapter: ExternalCliAdapterSchema,
    adapter_id: ProfileIdSchema.optional(),
    capabilities: ExternalCliCapabilitiesSchema,
    mutation_mode: ExternalCliMutationModeSchema,
    timeout_ms: z.number().int().safe().positive(),
    output_limit_bytes: z.number().int().safe().positive(),
  })
  .strict()
  .superRefine(validateExternalCliAdapter)
export type ExternalCliProfileConfig = z.infer<typeof ExternalCliProfileConfigSchema>

export const ExternalCliProfileConfigLayerSchema = z
  .object({
    executable: z
      .string()
      .min(1)
      .max(4_096)
      .refine(containsNoTerminalControls, "Executable cannot contain control characters")
      .optional(),
    args: z.array(ExternalCliArgumentSchema).max(1_024).optional(),
    cwd: PortableRelativePathSchema.optional(),
    environment_refs: z
      .record(ExternalCliEnvironmentNameSchema, ExternalCliEnvironmentRefSchema)
      .optional(),
    input_mode: z.literal("stdin-json").optional(),
    adapter: ExternalCliAdapterSchema.optional(),
    adapter_id: ProfileIdSchema.nullable().optional(),
    capabilities: ExternalCliCapabilitiesLayerSchema.optional(),
    mutation_mode: ExternalCliMutationModeSchema.optional(),
    timeout_ms: z.number().int().safe().positive().optional(),
    output_limit_bytes: z.number().int().safe().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    // A partial layer may inherit either side of this relationship. Only
    // reject a contradiction fully declared by the same layer; the composed
    // complete profile is validated again before any config commit.
    if (
      value.adapter !== undefined &&
      value.adapter !== "known-output" &&
      typeof value.adapter_id === "string"
    ) {
      context.addIssue({
        code: "custom",
        message: "adapter_id is only valid for known-output adapters",
        path: ["adapter_id"],
      })
    }
  })
export type ExternalCliProfileConfigLayer = z.infer<typeof ExternalCliProfileConfigLayerSchema>

export const ProfileFallbackFailureSchema = z.enum([
  "provider-unavailable",
  "model-unavailable",
  "rate-limit",
  "transient",
])
export type ProfileFallbackFailure = z.infer<typeof ProfileFallbackFailureSchema>

export const ProfileParameterNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\S+$/, "Profile parameter names cannot contain whitespace")
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
    "Profile parameter name is reserved",
  )
  .refine(containsNoTerminalControls, "Profile parameter names cannot contain control characters")

export const ProfileParameterValueSchema = z.union([
  z
    .string()
    .refine(
      containsNoTerminalControls,
      "Profile parameter values cannot contain control characters",
    ),
  z.number().finite(),
  z.boolean(),
  z.null(),
])
export type ProfileParameterValue = z.infer<typeof ProfileParameterValueSchema>

function rejectReservedProfileParameterNames(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).some((key) => ["__proto__", "constructor", "prototype"].includes(key))
      ? null
      : value
    : value
}

export const ProfileParametersSchema = z.preprocess(
  rejectReservedProfileParameterNames,
  z.record(ProfileParameterNameSchema, ProfileParameterValueSchema),
)
export type ProfileParameters = z.infer<typeof ProfileParametersSchema>

const ProfileRequirementsObjectSchema = z
  .object({
    input: z.array(z.enum(["text", "image", "file"])).default([]),
    tools: z.boolean().default(false),
    tool_streaming: z.boolean().default(false),
    reasoning: z.boolean().default(false),
    structured_output: z.boolean().default(false),
    usage: z
      .array(z.enum(["input", "output", "reasoning", "cache-read", "cache-write", "cost"]))
      .default([]),
    access: z.array(z.enum(["api", "subscription"])).default([]),
    minimum_context: z.number().int().positive().optional(),
    minimum_output: z.number().int().positive().optional(),
  })
  .strict()

const ProfileRequirementsConfigSchema = ProfileRequirementsObjectSchema.default({
  input: [],
  tools: false,
  tool_streaming: false,
  reasoning: false,
  structured_output: false,
  usage: [],
  access: [],
})

const ProfileLimitsObjectSchema = z
  .object({
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    max_reasoning_tokens: z.number().int().positive().optional(),
    max_total_tokens: z.number().int().positive().optional(),
    max_cost: z
      .object({
        amount: z.number().finite().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .optional(),
  })
  .strict()

const ProfileLimitsConfigSchema = ProfileLimitsObjectSchema.default({})

const ProfileRequirementsLayerSchema = ProfileRequirementsObjectSchema.partial()
  .extend({
    minimum_context: z.number().int().positive().nullable().optional(),
    minimum_output: z.number().int().positive().nullable().optional(),
  })
  .strict()

const ProfileLimitsLayerSchema = ProfileLimitsObjectSchema.partial()
  .extend({
    max_input_tokens: z.number().int().positive().nullable().optional(),
    max_output_tokens: z.number().int().positive().nullable().optional(),
    max_reasoning_tokens: z.number().int().positive().nullable().optional(),
    max_total_tokens: z.number().int().positive().nullable().optional(),
    max_cost: z
      .object({
        amount: z.number().finite().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()

export const RoleProfileConfigSchema = z
  .object({
    role: ProfileRoleSchema,
    backend: ProfileBackendSchema,
    provider: z.string().min(1),
    model: z.string().min(1),
    credential: ProfileIdSchema.optional(),
    variant: ProfileIdSchema.optional(),
    parameters: ProfileParametersSchema.default({}),
    requirements: ProfileRequirementsConfigSchema,
    fallback_profiles: z.array(ProfileIdSchema).default([]),
    fallback_on: z.array(ProfileFallbackFailureSchema).default([]),
    limits: ProfileLimitsConfigSchema,
    external_cli: ExternalCliProfileConfigSchema.optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.requirements.tool_streaming && !profile.requirements.tools) {
      context.addIssue({
        code: "custom",
        message: "tool_streaming requires tools",
        path: ["requirements", "tool_streaming"],
      })
    }
    if (profile.backend === "external-cli" && !profile.external_cli) {
      context.addIssue({
        code: "custom",
        message: "external-cli profiles require external_cli configuration",
        path: ["external_cli"],
      })
    }
    if (profile.backend === "embedded" && profile.external_cli) {
      context.addIssue({
        code: "custom",
        message: "embedded profiles cannot declare external_cli configuration",
        path: ["external_cli"],
      })
    }
  })

export type RoleProfileConfig = z.infer<typeof RoleProfileConfigSchema>

export const RoleProfileConfigLayerSchema = z
  .object({
    role: ProfileRoleSchema.optional(),
    backend: ProfileBackendSchema.optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    credential: ProfileIdSchema.nullable().optional(),
    variant: ProfileIdSchema.nullable().optional(),
    parameters: ProfileParametersSchema.optional(),
    requirements: ProfileRequirementsLayerSchema.optional(),
    fallback_profiles: z.array(ProfileIdSchema).optional(),
    fallback_on: z.array(ProfileFallbackFailureSchema).optional(),
    limits: ProfileLimitsLayerSchema.optional(),
    external_cli: ExternalCliProfileConfigLayerSchema.nullable().optional(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.backend === "external-cli" && profile.external_cli === null) {
      context.addIssue({
        code: "custom",
        message: "A layer selecting external-cli cannot clear external_cli",
        path: ["external_cli"],
      })
    }
    if (
      profile.backend === "embedded" &&
      profile.external_cli !== undefined &&
      profile.external_cli !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "A layer selecting embedded may only clear external_cli",
        path: ["external_cli"],
      })
    }
  })

export type RoleProfileConfigLayer = z.infer<typeof RoleProfileConfigLayerSchema>

export type RoleProfileLayerPathSemantics = "merge" | "replace" | "tombstone"

const ROLE_PROFILE_TOMBSTONE_PATHS = new Set([
  "credential",
  "variant",
  "external_cli",
  "external_cli.adapter_id",
  "requirements.minimum_context",
  "requirements.minimum_output",
  "limits.max_input_tokens",
  "limits.max_output_tokens",
  "limits.max_reasoning_tokens",
  "limits.max_total_tokens",
  "limits.max_cost",
])

const ROLE_PROFILE_REPLACE_PATHS = new Set(["parameters", "external_cli.environment_refs"])

/**
 * Returns the deterministic merge behavior for a path relative to one
 * profiles.<id> object. `null` is a deletion marker only on the explicit
 * tombstone paths below; parameter values and unrelated config nulls remain
 * ordinary data.
 */
export function roleProfileLayerPathSemantics(
  path: readonly string[] | string,
): RoleProfileLayerPathSemantics {
  const key = typeof path === "string" ? path : path.join(".")
  if (ROLE_PROFILE_TOMBSTONE_PATHS.has(key)) return "tombstone"
  if (ROLE_PROFILE_REPLACE_PATHS.has(key)) return "replace"
  return "merge"
}

function isProfileLayerObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function mergeRoleProfileLayer(
  target: Record<string, unknown>,
  layer: Record<string, unknown>,
  prefix: readonly string[] = [],
): void {
  for (const [key, value] of Object.entries(layer)) {
    const path = [...prefix, key]
    const semantics = roleProfileLayerPathSemantics(path)
    if (value === null && semantics === "tombstone") {
      delete target[key]
      continue
    }
    if (semantics === "replace") {
      target[key] = structuredClone(value)
      continue
    }
    const existing = Object.hasOwn(target, key) ? target[key] : undefined
    if (isProfileLayerObject(value) && isProfileLayerObject(existing)) {
      mergeRoleProfileLayer(existing, value, path)
    } else if (isProfileLayerObject(value)) {
      const created: Record<string, unknown> = {}
      mergeRoleProfileLayer(created, value, path)
      target[key] = created
    } else {
      // A non-tombstone null is data. In particular, this branch must never
      // reinterpret profiles.*.parameters.* null values as deletions.
      target[key] = structuredClone(value)
    }
  }
}

/** Composes one raw profile layer over a lower partial or complete profile. */
export function composeRoleProfileConfigLayer(
  lower: Readonly<Record<string, unknown>>,
  layer: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const composed = structuredClone(lower) as Record<string, unknown>
  mergeRoleProfileLayer(composed, layer as Record<string, unknown>)
  return composed
}

function deleteRoleProfileLayerPath(
  target: Record<string, unknown>,
  path: readonly string[],
): void {
  if (path.length === 0) return
  const parents: Array<{ parent: Record<string, unknown>; key: string }> = []
  let current = target
  for (const segment of path.slice(0, -1)) {
    const child = isProfileLayerObject(current[segment]) ? current[segment] : undefined
    if (!child || !isProfileLayerObject(child)) return
    parents.push({ parent: current, key: segment })
    current = child
  }
  const leaf = path.at(-1)
  if (!leaf) return
  delete current[leaf]
  for (const { parent, key } of parents.reverse()) {
    const child = parent[key]
    if (isProfileLayerObject(child) && Object.keys(child).length === 0) delete parent[key]
    else break
  }
}

/**
 * Applies one tri-state `inherit` action to a raw layer and synchronizes the
 * cross-field relationships whose validity depends on the inherited value.
 */
export function inheritRoleProfileConfigLayerPath(
  layer: Readonly<Record<string, unknown>>,
  lower: Readonly<Record<string, unknown>>,
  path: readonly string[],
): Record<string, unknown> {
  const inherited = structuredClone(layer) as Record<string, unknown>
  deleteRoleProfileLayerPath(inherited, path)
  const serializedPath = path.join(".")

  if (serializedPath === "backend") {
    if (lower.backend !== "external-cli") delete inherited.external_cli
    if (lower.backend === "external-cli" && inherited.external_cli === null) {
      delete inherited.external_cli
    }
  }
  if (serializedPath === "external_cli.adapter") {
    const composed = composeRoleProfileConfigLayer(lower, inherited)
    const external = isProfileLayerObject(composed.external_cli) ? composed.external_cli : undefined
    const externalLayer = isProfileLayerObject(inherited.external_cli)
      ? inherited.external_cli
      : undefined
    if (external?.adapter !== "known-output" || externalLayer?.adapter_id === null) {
      deleteRoleProfileLayerPath(inherited, ["external_cli", "adapter_id"])
    }
  }
  if (serializedPath === "requirements.tools") {
    const composed = composeRoleProfileConfigLayer(lower, inherited)
    const requirements = isProfileLayerObject(composed.requirements)
      ? composed.requirements
      : undefined
    const requirementsLayer = isProfileLayerObject(inherited.requirements)
      ? inherited.requirements
      : undefined
    if (requirements?.tools !== true && requirementsLayer?.tool_streaming === true) {
      deleteRoleProfileLayerPath(inherited, ["requirements", "tool_streaming"])
    }
  }
  return inherited
}

/**
 * Converts the legacy complete-profile command contract into an explicit
 * replacement layer. Optional omissions become typed tombstones so a lower
 * global value cannot reappear accidentally in workspace scope.
 */
export function completeRoleProfileConfigLayer(profile: RoleProfileConfig): RoleProfileConfigLayer {
  const layer: RoleProfileConfigLayer = {
    ...structuredClone(profile),
    credential: profile.credential ?? null,
    variant: profile.variant ?? null,
    requirements: {
      ...structuredClone(profile.requirements),
      minimum_context: profile.requirements.minimum_context ?? null,
      minimum_output: profile.requirements.minimum_output ?? null,
    },
    limits: {
      ...structuredClone(profile.limits),
      max_input_tokens: profile.limits.max_input_tokens ?? null,
      max_output_tokens: profile.limits.max_output_tokens ?? null,
      max_reasoning_tokens: profile.limits.max_reasoning_tokens ?? null,
      max_total_tokens: profile.limits.max_total_tokens ?? null,
      max_cost: profile.limits.max_cost ? structuredClone(profile.limits.max_cost) : null,
    },
    external_cli: profile.external_cli
      ? {
          ...structuredClone(profile.external_cli),
          adapter_id: profile.external_cli.adapter_id ?? null,
        }
      : null,
  }
  return RoleProfileConfigLayerSchema.parse(layer)
}

const ProfilesConfigSchema = z.record(ProfileIdSchema, RoleProfileConfigSchema)
const ProfilesConfigLayerSchema = z.record(ProfileIdSchema, RoleProfileConfigLayerSchema)

const DefaultsConfigSchema = z
  .object({
    mode: RunModeSchema,
    executor_profile: z.string().min(1),
    judge_profile: z.string().min(1).nullable(),
    ui: UiModeSchema,
    lang: z.string().min(2),
  })
  .strict()

const NoChangeConfigSchema = z
  .object({
    policy: z.enum(["fallback", "retry", "fail-fast"]),
    max_attempts: z.number().int().nonnegative(),
    stop_on_exhausted: z.boolean(),
  })
  .strict()

const RunConfigSchema = z
  .object({
    resume: z.boolean(),
    max_attempts: z.number().int().positive(),
    retry_delay_seconds: z.number().nonnegative(),
    include_progress_context: z.boolean(),
    include_repo_map_context: z.boolean(),
    no_change: NoChangeConfigSchema,
  })
  .strict()

export const EvaluationRubricCriterionConfigSchema = z
  .object({
    id: z.string().trim().min(1),
    description: z.string().trim().min(1),
    weight: z.number().finite().positive(),
    blocking: z.boolean().default(false),
  })
  .strict()
export type EvaluationRubricCriterionConfig = z.infer<typeof EvaluationRubricCriterionConfigSchema>

export const EvaluationRubricConfigSchema = z
  .object({
    weight_policy: z.enum(["strict-100", "normalize"]).default("normalize"),
    criteria: z.array(EvaluationRubricCriterionConfigSchema).min(1),
  })
  .strict()
  .superRefine((rubric, context) => {
    if (new Set(rubric.criteria.map((criterion) => criterion.id)).size !== rubric.criteria.length) {
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "Rubric criterion IDs must be unique",
      })
    }
    if (
      rubric.weight_policy === "strict-100" &&
      Math.abs(rubric.criteria.reduce((total, criterion) => total + criterion.weight, 0) - 100) >
        Number.EPSILON
    ) {
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "A strict rubric must have weights totaling 100",
      })
    }
  })
export type EvaluationRubricConfig = z.infer<typeof EvaluationRubricConfigSchema>

const EvaluationConfigSchema = z
  .object({
    mode: z.enum(["deterministic-only", "self", "external", "manual"]),
    threshold: z.number().int().min(0).max(100),
    max_revision_attempts: z.number().int().nonnegative(),
    judge_call_retries: z.number().int().nonnegative(),
    on_judge_unavailable: z.enum(["deterministic", "pause", "fail"]),
    blocking_severities: z
      .array(z.enum(["info", "minor", "major", "critical"]))
      .refine((values) => new Set(values).size === values.length, "Severities must be unique"),
    exhausted_policy: z.enum(["manual-review", "fail", "stop-run"]),
    rubric: EvaluationRubricConfigSchema.nullable().optional(),
  })
  .strict()

const VerificationConfigSchema = z
  .object({
    allow_no_gates: z.boolean(),
  })
  .strict()

const WatchdogDurationSchema = z
  .string()
  .regex(/^[1-9]\d*(?:ms|s|m|h|d)$/i, "Expected a positive duration such as 500ms, 5s or 10m")

const WatchdogRecoveryActionConfigSchema = z.enum([
  "notify",
  "cancel",
  "restart-attempt",
  "stop-run",
])

const WatchdogPhaseConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    heartbeat_interval: WatchdogDurationSchema.optional(),
    heartbeat_grace: WatchdogDurationSchema.optional(),
    quiet_after: WatchdogDurationSchema.optional(),
    slow_after: WatchdogDurationSchema.optional(),
    suspect_after: WatchdogDurationSchema.optional(),
    hard_timeout: WatchdogDurationSchema.nullable().optional(),
    probe_interval: WatchdogDurationSchema.optional(),
    confirmations: z.number().int().positive().optional(),
    action: WatchdogRecoveryActionConfigSchema.optional(),
    max_restarts: z.number().int().nonnegative().optional(),
  })
  .strict()

export const WatchdogConfigSchema = z
  .object({
    enabled: z.boolean(),
    heartbeat_interval: WatchdogDurationSchema,
    heartbeat_grace: WatchdogDurationSchema,
    quiet_after: WatchdogDurationSchema,
    slow_after: WatchdogDurationSchema,
    suspect_after: WatchdogDurationSchema,
    hard_timeout: WatchdogDurationSchema.nullable(),
    probe_interval: WatchdogDurationSchema,
    confirmations: z.number().int().positive(),
    action: WatchdogRecoveryActionConfigSchema,
    max_restarts: z.number().int().nonnegative(),
    phases: z
      .partialRecord(
        z.enum(["model-call", "tool", "gate", "judge", "child", "integration"]),
        WatchdogPhaseConfigSchema,
      )
      .default({}),
  })
  .strict()
export type WatchdogConfig = z.infer<typeof WatchdogConfigSchema>

export const ParallelIntegrationStrategyConfigSchema = z.enum([
  "no-merge",
  "none",
  "merge",
  "rebase-merge",
  "cherry-pick",
  "create-pr",
])

const ParallelLimitMapSchema = z.record(
  z.string().trim().min(1).max(512),
  z.number().int().positive().max(1_024),
)

export const ParallelConfigSchema = z
  .object({
    max_parallel: z.number().int().positive().max(1_024),
    max_global: z.number().int().positive().max(1_024),
    max_per_provider: ParallelLimitMapSchema,
    max_per_model: ParallelLimitMapSchema,
    auto: z.boolean(),
    allowed_groups: z
      .array(z.string().trim().min(1).max(256))
      .max(1_024)
      .refine((values) => new Set(values).size === values.length, "Parallel groups must be unique"),
    require_isolation: z.boolean(),
    integration_strategy: ParallelIntegrationStrategyConfigSchema,
    retry_failed: z.boolean(),
    max_failure_retries: z.number().int().nonnegative().max(100),
    fail_fast: z.boolean(),
    scope_expansion: z.enum(["deny", "pause", "accept-if-unclaimed"]),
  })
  .strict()
export type ParallelConfig = z.infer<typeof ParallelConfigSchema>

const TELEMETRY_RETENTION_MULTIPLIERS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const

export const TelemetryEventRetentionSchema = z
  .string()
  .regex(
    /^[1-9]\d*(?:ms|s|m|h|d)$/,
    "Expected a positive retention duration such as 30m, 24h or 30d",
  )
  .refine((value) => {
    const match = /^([1-9]\d*)(ms|s|m|h|d)$/.exec(value)
    if (!match?.[1] || !match[2]) return false
    const unit = match[2] as keyof typeof TELEMETRY_RETENTION_MULTIPLIERS
    const milliseconds = Number(match[1]) * TELEMETRY_RETENTION_MULTIPLIERS[unit]
    return Number.isSafeInteger(milliseconds) && milliseconds > 0
  }, "Retention duration exceeds the supported millisecond range")

export function parseTelemetryEventRetention(value: string | null): number | undefined {
  if (value === null) return undefined
  const parsed = TelemetryEventRetentionSchema.parse(value)
  const match = /^([1-9]\d*)(ms|s|m|h|d)$/.exec(parsed)
  if (!match?.[1] || !match[2]) throw new Error("Telemetry retention parser invariant failed")
  const unit = match[2] as keyof typeof TELEMETRY_RETENTION_MULTIPLIERS
  return Number(match[1]) * TELEMETRY_RETENTION_MULTIPLIERS[unit]
}

export const TelemetryConfigSchema = z
  .object({
    persist_raw_output: z.boolean(),
    event_retention: TelemetryEventRetentionSchema.nullable(),
    redact: z.boolean(),
  })
  .strict()
export type TelemetryConfig = z.infer<typeof TelemetryConfigSchema>

export const TuiThemeSchema = z.enum(["dark", "light", "high-contrast", "monochrome", "system"])
export type TuiTheme = z.infer<typeof TuiThemeSchema>

const TuiKeyActionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/, "Expected a safe TUI action name")

export const TuiConfigSchema = z
  .object({
    theme: TuiThemeSchema,
    ascii: z.boolean(),
    keybindings: z.record(TuiKeyActionSchema, z.string().trim().min(1).max(64)),
  })
  .strict()
export type TuiConfig = z.infer<typeof TuiConfigSchema>

export const SecurityModeSchema = z.enum(["safe", "auto", "dangerous"])
export type SecurityMode = z.infer<typeof SecurityModeSchema>
export const HeadlessAskSchema = z.enum(["deny", "allow"])
export type HeadlessAsk = z.infer<typeof HeadlessAskSchema>
export const ToolRuleDecisionSchema = z.enum(["allow", "deny", "ask"])
export type ToolRuleDecision = z.infer<typeof ToolRuleDecisionSchema>
export const ToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.:-]*$/, "Expected a safe lowercase tool name")
export const ToolRulesSchema = z.record(ToolNameSchema, ToolRuleDecisionSchema)
export type ToolRules = z.infer<typeof ToolRulesSchema>

export const AllowedCommandSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(containsNoTerminalControls, "Allowed commands cannot contain control characters")

const SecurityExternalEffectRuleSchema = z
  .object({
    capability: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[a-z][a-z0-9_.:-]*$/),
    action: z.enum(["deny", "ask", "allow"]),
    require_idempotency_key: z.boolean(),
  })
  .strict()

const SecurityConfigObjectSchema = z
  .object({
    mode: SecurityModeSchema,
    headless_ask: HeadlessAskSchema,
    tool_rules: ToolRulesSchema,
    allowed_commands: z
      .array(AllowedCommandSchema)
      .refine(
        (values) => new Set(values).size === values.length,
        "Allowed commands must be unique",
      ),
    read_paths: z
      .array(PortableRelativeScopeSchema)
      .refine((values) => new Set(values).size === values.length, "Read paths must be unique"),
    write_paths: z
      .array(PortableRelativeScopeSchema)
      .refine((values) => new Set(values).size === values.length, "Write paths must be unique"),
    allow_shell: z.boolean(),
    network_mode: z.enum(["none", "allowlist", "full"]),
    network_destinations: z
      .array(z.string().trim().min(1).max(4_096))
      .max(1_024)
      .refine(
        (values) => new Set(values).size === values.length,
        "Security network destinations must be unique",
      ),
    external_effects: z.array(SecurityExternalEffectRuleSchema).max(1_024),
    dangerous_override_reason: z.string().trim().min(1).max(4_096).nullable(),
  })
  .strict()

export const SecurityConfigSchema = SecurityConfigObjectSchema.superRefine((value, context) => {
  if (value.network_mode === "full" && value.mode !== "dangerous") {
    context.addIssue({
      code: "custom",
      path: ["network_mode"],
      message: "Full network mode requires dangerous security mode",
    })
  }
  if (value.network_mode === "allowlist" && value.network_destinations.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["network_destinations"],
      message: "Security network allowlist cannot be empty",
    })
  }
  if (value.network_mode !== "allowlist" && value.network_destinations.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["network_destinations"],
      message: "Security network destinations are only valid in allowlist mode",
    })
  }
  if (value.mode === "dangerous" && !value.dangerous_override_reason) {
    context.addIssue({
      code: "custom",
      path: ["dangerous_override_reason"],
      message: "Dangerous security mode requires an auditable override reason",
    })
  }
})
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>

const SandboxMountConfigSchema = z
  .object({
    source: PortableRelativeScopeSchema,
    target: z.string().trim().min(1).max(4_096),
    mode: z.enum(["read-only", "read-write"]),
  })
  .strict()

const SandboxResourceConfigSchema = z
  .object({
    cpu_count: z.number().positive().max(1_024).nullable(),
    memory_bytes: z.number().int().positive().nullable(),
    process_count: z.number().int().positive().max(1_000_000).nullable(),
    timeout: WatchdogDurationSchema,
  })
  .strict()

const SandboxConfigObjectSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(["process", "docker", "podman"]),
    image: z.string().min(1).nullable(),
    /** Legacy free-form network field retained for migration/inspection only. */
    network: z.string().min(1).nullable(),
    network_mode: z.enum(["none", "allowlist", "full"]),
    network_destinations: z
      .array(z.string().trim().min(1).max(4_096))
      .max(1_024)
      .refine(
        (values) => new Set(values).size === values.length,
        "Sandbox network destinations must be unique",
      ),
    require_container_isolation: z.boolean(),
    require_network_isolation: z.boolean(),
    mounts: z.array(SandboxMountConfigSchema).max(256),
    environment_allowlist: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(1_024)
      .refine(
        (values) => new Set(values).size === values.length,
        "Sandbox environment names must be unique",
      ),
    resources: SandboxResourceConfigSchema,
    user: z.string().trim().min(1).max(512).nullable(),
  })
  .strict()

export const SandboxConfigSchema = SandboxConfigObjectSchema.superRefine((value, context) => {
  if (value.provider !== "process" && !value.image) {
    context.addIssue({
      code: "custom",
      path: ["image"],
      message: "Docker and Podman sandbox providers require an image",
    })
  }
  if (value.network_mode === "allowlist" && value.network_destinations.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["network_destinations"],
      message: "Sandbox network allowlist cannot be empty",
    })
  }
  if (value.network_mode !== "allowlist" && value.network_destinations.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["network_destinations"],
      message: "Sandbox network destinations are only valid in allowlist mode",
    })
  }
})
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>

export const GitConfigSchema = z
  .object({
    branch_per_task: z.boolean(),
    base_branch: z.string().min(1).nullable(),
    integration_branch: z.string().min(1).nullable(),
    create_pr: z.boolean(),
    draft_pr: z.boolean(),
    pr_labels: z
      .array(z.string().trim().min(1).max(256))
      .max(256)
      .refine((values) => new Set(values).size === values.length, "PR labels must be unique"),
    dirty_baseline: z.enum(["deny", "allow", "checkpoint-required"]),
    commit_per_task: z.boolean(),
    commit_message_template: z.string().trim().min(1).max(8_192),
    sign_commits: z.boolean(),
    worktree_retention: z.enum(["remove-after-integration", "keep-on-failure", "always-keep"]),
    auto_rollback: z.boolean(),
    auto_checkpoints: z.boolean(),
    checkpoint_before_task: z.boolean(),
    checkpoint_after_task: z.boolean(),
    rollback_preview_ttl: WatchdogDurationSchema,
  })
  .strict()
export type GitConfig = z.infer<typeof GitConfigSchema>

export const RalphConfigSchema = z
  .object({
    schema_version: z.literal(1),
    defaults: DefaultsConfigSchema,
    profiles: ProfilesConfigSchema,
    run: RunConfigSchema,
    verification: VerificationConfigSchema,
    evaluation: EvaluationConfigSchema,
    watchdog: WatchdogConfigSchema,
    parallel: ParallelConfigSchema,
    telemetry: TelemetryConfigSchema,
    tui: TuiConfigSchema,
    security: SecurityConfigSchema,
    sandbox: SandboxConfigSchema,
    git: GitConfigSchema,
    extensions: ReservedEmptyObjectSchema.optional(),
  })
  .strict()

export type RalphConfig = z.infer<typeof RalphConfigSchema>

export const RalphConfigLayerSchema = z
  .object({
    schema_version: z.literal(1),
    defaults: DefaultsConfigSchema.partial().optional(),
    profiles: ProfilesConfigLayerSchema.optional(),
    run: RunConfigSchema.partial()
      .extend({ no_change: NoChangeConfigSchema.partial().optional() })
      .strict()
      .optional(),
    verification: VerificationConfigSchema.partial().optional(),
    evaluation: EvaluationConfigSchema.partial().optional(),
    watchdog: WatchdogConfigSchema.partial().optional(),
    parallel: ParallelConfigSchema.partial().optional(),
    telemetry: TelemetryConfigSchema.partial().optional(),
    tui: TuiConfigSchema.partial().optional(),
    security: SecurityConfigObjectSchema.partial().optional(),
    sandbox: SandboxConfigObjectSchema.partial()
      .extend({ resources: SandboxResourceConfigSchema.partial().optional() })
      .strict()
      .optional(),
    git: GitConfigSchema.partial().optional(),
    extensions: ReservedEmptyObjectSchema.optional(),
  })
  .strict()

export type RalphConfigLayer = z.infer<typeof RalphConfigLayerSchema>

export const GlobalConfigLayerSchema = RalphConfigLayerSchema.extend({
  schema_version: z.literal(1).optional(),
}).strict()

export const DEFAULT_CONFIG: RalphConfig = {
  schema_version: 1,
  defaults: {
    mode: "loop",
    executor_profile: "default",
    judge_profile: null,
    ui: "auto",
    lang: "pt-BR",
  },
  profiles: {},
  run: {
    resume: true,
    max_attempts: 3,
    retry_delay_seconds: 2,
    include_progress_context: false,
    include_repo_map_context: false,
    no_change: {
      policy: "fallback",
      max_attempts: 3,
      stop_on_exhausted: true,
    },
  },
  verification: {
    allow_no_gates: false,
  },
  evaluation: {
    mode: "deterministic-only",
    threshold: 85,
    max_revision_attempts: 3,
    judge_call_retries: 2,
    on_judge_unavailable: "pause",
    blocking_severities: ["critical"],
    exhausted_policy: "manual-review",
  },
  watchdog: {
    enabled: true,
    heartbeat_interval: "5s",
    heartbeat_grace: "20s",
    quiet_after: "45s",
    slow_after: "5m",
    suspect_after: "10m",
    hard_timeout: "45m",
    probe_interval: "10s",
    confirmations: 3,
    action: "restart-attempt",
    max_restarts: 1,
    phases: {},
  },
  parallel: {
    max_parallel: 2,
    max_global: 4,
    max_per_provider: {},
    max_per_model: {},
    auto: false,
    allowed_groups: [],
    require_isolation: true,
    integration_strategy: "no-merge",
    retry_failed: false,
    max_failure_retries: 1,
    fail_fast: false,
    scope_expansion: "pause",
  },
  telemetry: {
    persist_raw_output: true,
    event_retention: null,
    redact: true,
  },
  tui: {
    theme: "dark",
    ascii: false,
    keybindings: {},
  },
  security: {
    mode: "safe",
    headless_ask: "deny",
    tool_rules: {},
    allowed_commands: [],
    read_paths: ["."],
    write_paths: ["."],
    allow_shell: false,
    network_mode: "none",
    network_destinations: [],
    external_effects: [],
    dangerous_override_reason: null,
  },
  sandbox: {
    enabled: false,
    provider: "process",
    image: null,
    network: null,
    network_mode: "none",
    network_destinations: [],
    require_container_isolation: false,
    require_network_isolation: false,
    mounts: [],
    environment_allowlist: [],
    resources: {
      cpu_count: null,
      memory_bytes: null,
      process_count: null,
      timeout: "45m",
    },
    user: null,
  },
  git: {
    branch_per_task: false,
    base_branch: null,
    integration_branch: null,
    create_pr: false,
    draft_pr: false,
    pr_labels: [],
    dirty_baseline: "deny",
    commit_per_task: true,
    commit_message_template: "ralph: {taskId}",
    sign_commits: false,
    worktree_retention: "keep-on-failure",
    auto_rollback: false,
    auto_checkpoints: false,
    checkpoint_before_task: false,
    checkpoint_after_task: false,
    rollback_preview_ttl: "15m",
  },
}

export type ConfigSource =
  | "builtin"
  | "global"
  | "workspace"
  | "env"
  | "profile"
  | "prd"
  | "task"
  | "cli"

export type EffectiveValue<T = unknown> = {
  value: T
  source: ConfigSource
  sourceRef?: string
}

export type EffectiveConfig = {
  config: RalphConfig
  values: Record<string, EffectiveValue>
}

export const WorkspaceStatusSchema = z
  .object({
    initialized: z.boolean(),
    state: z.enum(["uninitialized", "ready", "invalid"]),
    root: z.string(),
    workspaceId: z.string().optional(),
    workspaceSchemaVersion: z.number().int().optional(),
    configSchemaVersion: z.number().int().optional(),
    eventCursor: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    lastEventType: z.string().optional(),
    moved: z.boolean().optional(),
  })
  .strict()

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>

export function cloneDefaultConfig(): RalphConfig {
  return structuredClone(DEFAULT_CONFIG)
}
