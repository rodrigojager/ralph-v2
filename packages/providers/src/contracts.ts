import { z } from "zod"

function containsNoTerminalControls(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && codePoint > 31 && (codePoint < 127 || codePoint > 159)
  })
}

const NonEmptyStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine(containsNoTerminalControls, "Text cannot contain terminal control characters")
const ModelMessageContentSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0)
        return (
          codePoint !== undefined &&
          (codePoint === 9 ||
            codePoint === 10 ||
            codePoint === 13 ||
            (codePoint > 31 && (codePoint < 127 || codePoint > 159)))
        )
      }),
    "Model message text cannot contain unsafe terminal control characters",
  )
const TimestampSchema = z.iso.datetime({ offset: true })
const SafeCounterSchema = z.number().int().safe().min(0)
const PositiveSafeCounterSchema = z.number().int().safe().min(1)
const FiniteNonNegativeSchema = z.number().finite().nonnegative()
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const SlugSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
const ModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^\S+$/, "Model IDs cannot contain whitespace")
  .refine(containsNoTerminalControls, "Model IDs cannot contain control characters")

export type ProviderJsonValue =
  | null
  | boolean
  | number
  | string
  | ProviderJsonValue[]
  | { [key: string]: ProviderJsonValue }

export const ProviderJsonValueSchema: z.ZodType<ProviderJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(ProviderJsonValueSchema),
    z.record(z.string(), ProviderJsonValueSchema),
  ]),
)

export const ProviderJsonObjectSchema = z.record(z.string(), ProviderJsonValueSchema)
export type ProviderJsonObject = z.infer<typeof ProviderJsonObjectSchema>

const ProviderToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_.:-]*$/, "Expected a safe tool name")
  .refine(containsNoTerminalControls, "Tool names cannot contain control characters")

function uniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export const ProviderStatusSchema = z.enum(["available", "unavailable", "unknown", "deprecated"])
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>

export const ModelStatusSchema = ProviderStatusSchema
export type ModelStatus = z.infer<typeof ModelStatusSchema>

export const ModelAccessSchema = z.enum(["api", "subscription"])
export type ModelAccess = z.infer<typeof ModelAccessSchema>

export const AuthMethodSchema = z.enum([
  "api-key",
  "environment",
  "oauth-browser",
  "device-code",
  "subscription-session",
  "existing-session",
  "external-cli",
])
export type AuthMethod = z.infer<typeof AuthMethodSchema>

export const CredentialStoreSchema = z.enum([
  "os-keychain",
  "secret-provider",
  "encrypted-file",
  "environment",
  "insecure-file",
])
export type CredentialStore = z.infer<typeof CredentialStoreSchema>

export const CredentialMethodInfoSchema = z
  .object({
    method: AuthMethodSchema,
    label: NonEmptyStringSchema,
    access: z.array(ModelAccessSchema).min(1).refine(uniqueValues, "Access values must be unique"),
    interactive: z.boolean(),
  })
  .strict()
export type CredentialMethodInfo = z.infer<typeof CredentialMethodInfoSchema>

export const CredentialRefSchema = z
  .object({
    id: SlugSchema,
    provider: SlugSchema,
    method: AuthMethodSchema,
    store: CredentialStoreSchema,
    locator: NonEmptyStringSchema,
    label: NonEmptyStringSchema,
    accountHint: NonEmptyStringSchema.optional(),
    expiresAt: TimestampSchema.optional(),
  })
  .strict()
export type CredentialRef = z.infer<typeof CredentialRefSchema>

export const CredentialConnectRequestSchema = z
  .object({
    id: SlugSchema.optional(),
    provider: SlugSchema,
    method: AuthMethodSchema,
    label: NonEmptyStringSchema.optional(),
    nonInteractive: z.boolean(),
  })
  .strict()
export type CredentialConnectRequest = z.infer<typeof CredentialConnectRequestSchema>

export const CredentialStatusSchema = z.enum([
  "connected",
  "expired",
  "unavailable",
  "revoked",
  "unknown",
])
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>

/**
 * A resolved secret is deliberately exposed only through a scoped callback.
 * Implementations must not add the value to refs, events, errors or snapshots.
 */
export interface ResolvedCredential {
  readonly ref: CredentialRef
  useValue<T>(consumer: (secretValue: string) => Promise<T>): Promise<T>
}

export interface CredentialDriver {
  readonly providerId: string
  methods(): Promise<readonly CredentialMethodInfo[]>
  connect(request: CredentialConnectRequest): Promise<CredentialRef>
  status(ref: CredentialRef): Promise<CredentialStatus>
  resolve(ref: CredentialRef): Promise<ResolvedCredential>
  renew(ref: CredentialRef): Promise<CredentialRef>
  revoke(ref: CredentialRef): Promise<void>
}

export const ProviderInfoSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SlugSchema,
    name: NonEmptyStringSchema,
    status: ProviderStatusSchema,
    access: z.array(ModelAccessSchema).min(1).refine(uniqueValues, "Access values must be unique"),
    credentialMethods: z
      .array(CredentialMethodInfoSchema)
      .refine(
        (methods) => uniqueValues(methods.map((method) => method.method)),
        "Credential methods must be unique",
      ),
    catalogSource: NonEmptyStringSchema,
    catalogUpdatedAt: TimestampSchema,
  })
  .strict()
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>

export const UsageMetricSchema = z.enum([
  "input",
  "output",
  "reasoning",
  "cache-read",
  "cache-write",
  "cost",
])
export type UsageMetric = z.infer<typeof UsageMetricSchema>

export const ModelInputSchema = z.enum(["text", "image", "file"])
export type ModelInput = z.infer<typeof ModelInputSchema>

export const ModelCapabilitiesSchema = z
  .object({
    input: z
      .array(ModelInputSchema)
      .min(1)
      .refine(uniqueValues, "Input capabilities must be unique"),
    tools: z.boolean(),
    toolStreaming: z.boolean(),
    reasoning: z.boolean(),
    structuredOutput: z.boolean(),
    usage: z.array(UsageMetricSchema).refine(uniqueValues, "Usage capabilities must be unique"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.toolStreaming && !value.tools) {
      context.addIssue({
        code: "custom",
        message: "toolStreaming requires tools capability",
        path: ["toolStreaming"],
      })
    }
  })
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>

export const ModelLimitsSchema = z
  .object({
    context: PositiveSafeCounterSchema.optional(),
    output: PositiveSafeCounterSchema.optional(),
  })
  .strict()
export type ModelLimits = z.infer<typeof ModelLimitsSchema>

export const ModelParameterNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\S+$/, "Model parameter names cannot contain whitespace")
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
    "Model parameter name is reserved",
  )
  .refine(containsNoTerminalControls, "Model parameter names cannot contain control characters")

export const ModelParameterValueSchema = z.union([
  z
    .string()
    .refine(containsNoTerminalControls, "Model parameter values cannot contain control characters"),
  z.number().finite(),
  z.boolean(),
  z.null(),
])
export type ModelParameterValue = z.infer<typeof ModelParameterValueSchema>

function rejectReservedModelParameterNames(value: unknown): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).some((key) => ["__proto__", "constructor", "prototype"].includes(key))
      ? null
      : value
    : value
}

export const ModelParametersSchema = z.preprocess(
  rejectReservedModelParameterNames,
  z.record(ModelParameterNameSchema, ModelParameterValueSchema),
)
export type ModelParameters = z.infer<typeof ModelParametersSchema>

export const ModelVariantSchema = z
  .object({
    id: SlugSchema,
    name: NonEmptyStringSchema,
    description: NonEmptyStringSchema.optional(),
    parameters: ModelParametersSchema,
  })
  .strict()
export type ModelVariant = z.infer<typeof ModelVariantSchema>

export const PriceSnapshotSchema = z
  .object({
    id: NonEmptyStringSchema,
    status: z.enum(["available", "unavailable"]),
    source: NonEmptyStringSchema,
    capturedAt: TimestampSchema,
    appliesTo: z
      .array(ModelAccessSchema)
      .min(1)
      .refine(uniqueValues, "Price access values must be unique"),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    unit: z.literal("per-million-tokens").optional(),
    input: FiniteNonNegativeSchema.optional(),
    output: FiniteNonNegativeSchema.optional(),
    reasoning: FiniteNonNegativeSchema.optional(),
    cacheRead: FiniteNonNegativeSchema.optional(),
    cacheWrite: FiniteNonNegativeSchema.optional(),
    reason: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const amounts = [value.input, value.output, value.reasoning, value.cacheRead, value.cacheWrite]
    if (value.status === "available") {
      if (!value.currency) {
        context.addIssue({
          code: "custom",
          message: "Available pricing requires currency",
          path: ["currency"],
        })
      }
      if (!value.unit) {
        context.addIssue({
          code: "custom",
          message: "Available pricing requires unit",
          path: ["unit"],
        })
      }
      if (amounts.every((amount) => amount === undefined)) {
        context.addIssue({
          code: "custom",
          message: "Available pricing requires at least one amount",
          path: ["status"],
        })
      }
    } else {
      if (!value.reason) {
        context.addIssue({
          code: "custom",
          message: "Unavailable pricing requires a reason",
          path: ["reason"],
        })
      }
      if (value.currency || value.unit || amounts.some((amount) => amount !== undefined)) {
        context.addIssue({
          code: "custom",
          message: "Unavailable pricing cannot contain currency, unit or amounts",
          path: ["status"],
        })
      }
    }
  })
export type PriceSnapshot = z.infer<typeof PriceSnapshotSchema>

export const ModelInfoSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: SlugSchema,
    id: ModelIdSchema,
    name: NonEmptyStringSchema,
    family: NonEmptyStringSchema.optional(),
    status: ModelStatusSchema,
    capabilities: ModelCapabilitiesSchema,
    limits: ModelLimitsSchema,
    variants: z
      .array(ModelVariantSchema)
      .refine(
        (variants) => uniqueValues(variants.map((variant) => variant.id)),
        "Variant IDs must be unique",
      ),
    price: PriceSnapshotSchema,
    access: z.array(ModelAccessSchema).min(1).refine(uniqueValues, "Access values must be unique"),
    catalogSource: NonEmptyStringSchema,
    catalogUpdatedAt: TimestampSchema,
  })
  .strict()
export type ModelInfo = z.infer<typeof ModelInfoSchema>

export const ModelRefSchema = z
  .object({
    provider: SlugSchema,
    model: ModelIdSchema,
    variant: SlugSchema.optional(),
  })
  .strict()
export type ModelRef = z.infer<typeof ModelRefSchema>

export const ModelRequirementsSchema = z
  .object({
    input: z.array(ModelInputSchema).refine(uniqueValues, "Required inputs must be unique"),
    tools: z.boolean(),
    toolStreaming: z.boolean(),
    reasoning: z.boolean(),
    structuredOutput: z.boolean(),
    usage: z.array(UsageMetricSchema).refine(uniqueValues, "Required usage metrics must be unique"),
    access: z
      .array(ModelAccessSchema)
      .refine(uniqueValues, "Required access values must be unique"),
    minimumContext: PositiveSafeCounterSchema.optional(),
    minimumOutput: PositiveSafeCounterSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.toolStreaming && !value.tools) {
      context.addIssue({
        code: "custom",
        message: "toolStreaming requirement requires tools",
        path: ["toolStreaming"],
      })
    }
  })
export type ModelRequirements = z.infer<typeof ModelRequirementsSchema>

export const RoleProfileLimitsSchema = z
  .object({
    maxInputTokens: PositiveSafeCounterSchema.optional(),
    maxOutputTokens: PositiveSafeCounterSchema.optional(),
    maxReasoningTokens: PositiveSafeCounterSchema.optional(),
    maxTotalTokens: PositiveSafeCounterSchema.optional(),
    maxCost: z
      .object({ amount: FiniteNonNegativeSchema, currency: z.string().regex(/^[A-Z]{3}$/) })
      .strict()
      .optional(),
  })
  .strict()
export type RoleProfileLimits = z.infer<typeof RoleProfileLimitsSchema>

const RuntimePortableRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(containsNoTerminalControls, "External CLI cwd cannot contain control characters")
  .superRefine((value, context) => {
    if (
      value.includes("\\") ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      /[<>:"|]/.test(value) ||
      /[?*[\]{}]/.test(value) ||
      (value !== "." &&
        value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."))
    ) {
      context.addIssue({ code: "custom", message: "Expected a portable relative cwd" })
    }
  })

export const ExternalCliRuntimeConfigSchema = z
  .object({
    executable: NonEmptyStringSchema.max(4_096),
    args: z
      .array(
        z
          .string()
          .max(32_768)
          .refine(
            containsNoTerminalControls,
            "External CLI arguments cannot contain control characters",
          ),
      )
      .max(1_024),
    cwd: RuntimePortableRelativePathSchema,
    environmentRefs: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/),
    ),
    inputMode: z.literal("stdin-json"),
    adapter: z.enum(["protocol", "known-output", "generic"]),
    adapterId: SlugSchema.optional(),
    capabilities: z
      .object({
        streaming: z.boolean(),
        toolCalling: z.enum(["ralph", "internal", "unavailable"]),
        cancellation: z.boolean(),
        usage: z.enum(["reported", "estimated", "unavailable"]),
      })
      .strict(),
    mutationMode: z.enum(["read-only", "workspace"]),
    timeoutMs: PositiveSafeCounterSchema,
    outputLimitBytes: PositiveSafeCounterSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.adapter === "known-output" && !value.adapterId) {
      context.addIssue({
        code: "custom",
        message: "known-output adapters require adapterId",
        path: ["adapterId"],
      })
    }
    if (value.adapter !== "known-output" && value.adapterId) {
      context.addIssue({
        code: "custom",
        message: "adapterId is only valid for known-output adapters",
        path: ["adapterId"],
      })
    }
  })
export type ExternalCliRuntimeConfig = z.infer<typeof ExternalCliRuntimeConfigSchema>

export const RoleProfileSchema = z
  .object({
    id: SlugSchema,
    role: z.enum(["executor", "judge"]),
    backend: z.enum(["embedded", "external-cli"]),
    provider: SlugSchema,
    model: ModelIdSchema,
    credential: CredentialRefSchema.optional(),
    variant: SlugSchema.optional(),
    parameters: ModelParametersSchema,
    requirements: ModelRequirementsSchema,
    fallbackProfiles: z.array(SlugSchema).refine(uniqueValues, "Fallback profiles must be unique"),
    limits: RoleProfileLimitsSchema,
    externalCli: ExternalCliRuntimeConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.credential && value.credential.provider !== value.provider) {
      context.addIssue({
        code: "custom",
        message: "Credential provider must match role profile provider",
        path: ["credential", "provider"],
      })
    }
    if (value.fallbackProfiles.includes(value.id)) {
      context.addIssue({
        code: "custom",
        message: "A role profile cannot fall back to itself",
        path: ["fallbackProfiles"],
      })
    }
    if (value.backend === "external-cli" && !value.externalCli) {
      context.addIssue({
        code: "custom",
        message: "external-cli role profiles require externalCli",
        path: ["externalCli"],
      })
    }
    if (value.backend === "embedded" && value.externalCli) {
      context.addIssue({
        code: "custom",
        message: "embedded role profiles cannot declare externalCli",
        path: ["externalCli"],
      })
    }
  })
export type RoleProfile = z.infer<typeof RoleProfileSchema>

export const UsageSourceSchema = z.enum(["reported", "derived", "estimated", "unavailable"])
export type UsageSource = z.infer<typeof UsageSourceSchema>

export const UsageSemanticsSchema = z.enum(["delta", "cumulative", "final"])
export type UsageSemantics = z.infer<typeof UsageSemanticsSchema>

export const TokenUsageSchema = z
  .object({
    input: SafeCounterSchema.optional(),
    inputNonCached: SafeCounterSchema.optional(),
    cacheRead: SafeCounterSchema.optional(),
    cacheWrite: SafeCounterSchema.optional(),
    output: SafeCounterSchema.optional(),
    reasoning: SafeCounterSchema.optional(),
    total: SafeCounterSchema.optional(),
    cost: z
      .object({
        amount: FiniteNonNegativeSchema,
        currency: z.string().regex(/^[A-Z]{3}$/),
        priceSnapshotId: NonEmptyStringSchema,
        /** Cost provenance is independent from the token-counter provenance. */
        source: z.enum(["reported", "derived", "estimated"]).optional(),
      })
      .strict()
      .optional(),
    source: UsageSourceSchema,
    semantics: UsageSemanticsSchema,
    providerRawRef: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const measured = [
      value.input,
      value.inputNonCached,
      value.cacheRead,
      value.cacheWrite,
      value.output,
      value.reasoning,
      value.total,
      value.cost,
    ]
    if (value.source === "unavailable" && measured.some((item) => item !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Unavailable usage cannot contain measured token or cost values",
        path: ["source"],
      })
    }
  })
export type TokenUsage = z.infer<typeof TokenUsageSchema>

export const ProviderEventTypeSchema = z.enum([
  "model.text.delta",
  "model.text.completed",
  "model.reasoning.delta",
  "model.reasoning.completed",
  "model.tool.input.delta",
  "model.tool.call",
  "model.provider.warning",
  "model.provider.error",
  "model.usage.updated",
  "model.call.finished",
])
export type ProviderEventType = z.infer<typeof ProviderEventTypeSchema>

export const CatalogSourceInfoSchema = z
  .object({
    id: SlugSchema,
    kind: z.enum(["curated", "remote", "test"]),
    revision: NonEmptyStringSchema,
    url: z.url().optional(),
  })
  .strict()
export type CatalogSourceInfo = z.infer<typeof CatalogSourceInfoSchema>

const ProviderEventBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: NonEmptyStringSchema,
    providerEventId: NonEmptyStringSchema.optional(),
    callId: NonEmptyStringSchema,
    sequence: SafeCounterSchema,
    timestamp: TimestampSchema,
    level: z.enum(["trace", "debug", "info", "warn", "error"]),
    synthesized: z.boolean(),
  })
  .strict()

const ProviderRawRefSchema = NonEmptyStringSchema
const ProviderFinishReasonSchema = z.enum([
  "stop",
  "length",
  "tool-call",
  "content-filter",
  "error",
  "cancelled",
  "unknown",
])
const ProviderCallFinishedPayloadSchema = z.union([
  z
    .object({
      finishReason: ProviderFinishReasonSchema,
      rawRef: ProviderRawRefSchema.optional(),
      catalogSnapshotId: z.string().regex(/^catalog:[a-f0-9]{64}$/),
      catalogOrigin: z.enum(["source", "cache", "stale-cache", "fallback"]),
      catalogStale: z.boolean(),
      catalogSource: CatalogSourceInfoSchema,
    })
    .strict(),
  z
    .object({
      finishReason: ProviderFinishReasonSchema,
      rawRef: ProviderRawRefSchema.optional(),
    })
    .strict(),
])

export const ProviderEventSchema = z.discriminatedUnion("type", [
  ProviderEventBaseSchema.extend({
    type: z.literal("model.text.delta"),
    payload: z
      .object({
        delta: z.string(),
        rawRef: ProviderRawRefSchema.optional(),
      })
      .strict(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("model.text.completed"),
    payload: z
      .object({
        text: z.string(),
        rawRef: ProviderRawRefSchema.optional(),
      })
      .strict(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("model.reasoning.delta"),
    payload: z
      .object({
        delta: z.string(),
        rawRef: ProviderRawRefSchema.optional(),
      })
      .strict(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("model.reasoning.completed"),
    payload: z
      .object({
        summary: z.string(),
        rawRef: ProviderRawRefSchema.optional(),
      })
      .strict(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("model.tool.input.delta"),
    payload: z
      .object({
        toolCallId: NonEmptyStringSchema,
        delta: z.string(),
        rawRef: ProviderRawRefSchema.optional(),
      })
      .strict(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("model.tool.call"),
    payload: z
      .object({
        toolCallId: NonEmptyStringSchema,
        name: NonEmptyStringSchema,
        input: z.record(z.string(), z.unknown()),
        rawRef: ProviderRawRefSchema.optional(),
      })
      .strict(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("model.provider.warning"),
    payload: z
      .object({
        kind: NonEmptyStringSchema.optional(),
        message: NonEmptyStringSchema,
        code: NonEmptyStringSchema.optional(),
        rawRef: ProviderRawRefSchema.optional(),
      })
      .strict(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("model.provider.error"),
    payload: z
      .object({
        kind: NonEmptyStringSchema,
        message: NonEmptyStringSchema,
        code: NonEmptyStringSchema.optional(),
        retryAfterMs: SafeCounterSchema.optional(),
        rawRef: ProviderRawRefSchema.optional(),
      })
      .strict(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("model.usage.updated"),
    payload: z
      .object({
        usage: TokenUsageSchema,
      })
      .strict(),
  }),
  ProviderEventBaseSchema.extend({
    type: z.literal("model.call.finished"),
    payload: ProviderCallFinishedPayloadSchema,
  }),
])
export type ProviderEvent = z.infer<typeof ProviderEventSchema>

export interface ProviderEventSink {
  emit(event: ProviderEvent): void | Promise<void>
}

export const ModelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: ModelMessageContentSchema,
  })
  .strict()
export type ModelMessage = z.infer<typeof ModelMessageSchema>

export const ProviderToolInputSchemaSchema = ProviderJsonObjectSchema.superRefine(
  (schema, context) => {
    if (schema.type !== "object") {
      context.addIssue({
        code: "custom",
        message: "Tool input schemas must have type=object",
        path: ["type"],
      })
    }
    if (schema.additionalProperties !== false) {
      context.addIssue({
        code: "custom",
        message: "Tool input schemas must set additionalProperties=false",
        path: ["additionalProperties"],
      })
    }
  },
)
export type ProviderToolInputSchema = z.infer<typeof ProviderToolInputSchemaSchema>

export const ProviderToolDefinitionSchema = z
  .object({
    name: ProviderToolNameSchema,
    description: NonEmptyStringSchema,
    inputSchema: ProviderToolInputSchemaSchema,
  })
  .strict()
export type ProviderToolDefinition = z.infer<typeof ProviderToolDefinitionSchema>

export const ProviderResponseJsonSchemaSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/, "Expected a safe structured response schema name"),
    schema: ProviderToolInputSchemaSchema,
    strict: z.literal(true),
  })
  .strict()
export type ProviderResponseJsonSchema = z.infer<typeof ProviderResponseJsonSchemaSchema>

export const ProviderMessageInputSchema = ModelMessageSchema.extend({
  type: z.literal("message"),
}).strict()
export type ProviderMessageInput = z.infer<typeof ProviderMessageInputSchema>

function canonicalProviderJson(value: ProviderJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalProviderJson).join(",")}]`
  return `{${Object.keys(value)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalProviderJson(value[key] as ProviderJsonValue)}`,
    )
    .join(",")}}`
}

function validateFunctionCallArguments(
  value: { argumentsJson: string; input: ProviderJsonObject },
  context: {
    addIssue(issue: { code: "custom"; message: string; path: string[] }): void
  },
): void {
  try {
    const decoded = ProviderJsonObjectSchema.parse(JSON.parse(value.argumentsJson))
    if (canonicalProviderJson(decoded) !== canonicalProviderJson(value.input)) {
      context.addIssue({
        code: "custom",
        message: "argumentsJson and input must describe the same JSON object",
        path: ["argumentsJson"],
      })
    }
  } catch {
    context.addIssue({
      code: "custom",
      message: "argumentsJson must encode a JSON object",
      path: ["argumentsJson"],
    })
  }
}

const ProviderFunctionCallShape = {
  itemId: NonEmptyStringSchema,
  callId: NonEmptyStringSchema,
  name: ProviderToolNameSchema,
  argumentsJson: z.string().min(2),
  input: ProviderJsonObjectSchema,
} as const

export const ProviderToolCallSchema = z
  .object(ProviderFunctionCallShape)
  .strict()
  .superRefine(validateFunctionCallArguments)
export type ProviderToolCall = z.infer<typeof ProviderToolCallSchema>

export const ProviderFunctionCallInputSchema = z
  .object({ type: z.literal("function-call"), ...ProviderFunctionCallShape })
  .strict()
  .superRefine(validateFunctionCallArguments)
export type ProviderFunctionCallInput = z.infer<typeof ProviderFunctionCallInputSchema>

export const ProviderFunctionCallOutputInputSchema = z
  .object({
    type: z.literal("function-call-output"),
    callId: NonEmptyStringSchema,
    output: z.string(),
  })
  .strict()
export type ProviderFunctionCallOutputInput = z.infer<typeof ProviderFunctionCallOutputInputSchema>

export const ProviderModelInputSchema = z.discriminatedUnion("type", [
  ProviderMessageInputSchema,
  ProviderFunctionCallInputSchema,
  ProviderFunctionCallOutputInputSchema,
])
export type ProviderModelInput = z.infer<typeof ProviderModelInputSchema>

export const ProviderModelRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    callId: NonEmptyStringSchema,
    model: ModelRefSchema,
    messages: z.array(ModelMessageSchema).min(1).optional(),
    input: z.array(ProviderModelInputSchema).min(1).optional(),
    tools: z
      .array(ProviderToolDefinitionSchema)
      .refine((tools) => uniqueValues(tools.map((tool) => tool.name)), "Tool names must be unique")
      .default([]),
    parameters: ModelParametersSchema,
    maxOutputTokens: PositiveSafeCounterSchema.optional(),
    responseFormat: z.enum(["text", "json"]),
    responseSchema: ProviderResponseJsonSchemaSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (Boolean(request.messages) === Boolean(request.input)) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of messages or input",
        path: request.messages ? ["input"] : ["messages"],
      })
    }
    if (request.responseSchema && request.responseFormat !== "json") {
      context.addIssue({
        code: "custom",
        message: "A structured response schema requires responseFormat=json",
        path: ["responseSchema"],
      })
    }
  })
export type ProviderModelRequest = z.infer<typeof ProviderModelRequestSchema>

export const ProviderModelResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    callId: NonEmptyStringSchema,
    status: z.enum(["succeeded", "failed", "cancelled"]),
    finishReason: ProviderFinishReasonSchema,
    text: z.string().optional(),
    reasoningSummary: z.string().optional(),
    usage: TokenUsageSchema,
    toolCalls: z.array(ProviderToolCallSchema).default([]),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.finishReason === "tool-call" && result.toolCalls.length === 0) {
      context.addIssue({
        code: "custom",
        message: "tool-call results require at least one tool call",
        path: ["toolCalls"],
      })
    }
    if (result.finishReason !== "tool-call" && result.toolCalls.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Tool calls require finishReason=tool-call",
        path: ["finishReason"],
      })
    }
  })
export type ProviderModelResult = z.infer<typeof ProviderModelResultSchema>

export interface ProviderDriver {
  readonly id: string
  info(): Promise<ProviderInfo>
  listModels(): Promise<readonly ModelInfo[]>
  credentialDriver(): CredentialDriver | undefined
  invoke(request: ProviderModelRequest, sink: ProviderEventSink): Promise<ProviderModelResult>
  cancel(callId: string, reason: string): Promise<void>
}

export const CatalogSeedSchema = z
  .object({
    source: CatalogSourceInfoSchema,
    providers: z.array(ProviderInfoSchema).min(1),
    models: z.array(ModelInfoSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const providerIds = value.providers.map((provider) => provider.id)
    const modelRefs = value.models.map((model) => `${model.provider}/${model.id}`)
    if (!uniqueValues(providerIds)) {
      context.addIssue({
        code: "custom",
        message: "Provider IDs must be unique",
        path: ["providers"],
      })
    }
    if (!uniqueValues(modelRefs)) {
      context.addIssue({ code: "custom", message: "Model refs must be unique", path: ["models"] })
    }
    const knownProviders = new Map(
      value.providers.map((provider) => [provider.id, new Set(provider.access)]),
    )
    for (const [index, model] of value.models.entries()) {
      const providerAccess = knownProviders.get(model.provider)
      if (!providerAccess) {
        context.addIssue({
          code: "custom",
          message: `Unknown provider for model: ${model.provider}`,
          path: ["models", index, "provider"],
        })
        continue
      }
      if (model.access.some((access) => !providerAccess.has(access))) {
        context.addIssue({
          code: "custom",
          message: `Model access is not exposed by provider: ${model.provider}`,
          path: ["models", index, "access"],
        })
      }
    }
  })
export type CatalogSeed = z.infer<typeof CatalogSeedSchema>

export const ModelCatalogSnapshotSchema = CatalogSeedSchema.safeExtend({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^catalog:[a-f0-9]{64}$/),
  contentHash: Sha256Schema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
})
  .strict()
  .superRefine((value, context) => {
    if (value.id !== `catalog:${value.contentHash}`) {
      context.addIssue({
        code: "custom",
        message: "Catalog snapshot id must contain its content hash",
        path: ["id"],
      })
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "Catalog snapshot expiration must be after creation",
        path: ["expiresAt"],
      })
    }
  })
export type ModelCatalogSnapshot = z.infer<typeof ModelCatalogSnapshotSchema>

export const CatalogResolutionSchema = z
  .object({
    snapshot: ModelCatalogSnapshotSchema,
    origin: z.enum(["source", "cache", "stale-cache", "fallback"]),
    stale: z.boolean(),
    warning: NonEmptyStringSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.stale !== (value.origin === "stale-cache")) {
      context.addIssue({
        code: "custom",
        message: "Only stale-cache resolutions may be marked stale",
        path: ["stale"],
      })
    }
  })
export type CatalogResolution = z.infer<typeof CatalogResolutionSchema>

export type ModelCatalogQuery = {
  provider?: string
  requirements?: ModelRequirements
  includeDeprecated?: boolean
}

export type ModelCatalogReadOptions = {
  forceRefresh?: boolean
}

export interface ModelCatalog {
  snapshot(options?: ModelCatalogReadOptions): Promise<CatalogResolution>
  providers(options?: ModelCatalogReadOptions): Promise<readonly ProviderInfo[]>
  models(
    query?: ModelCatalogQuery,
    options?: ModelCatalogReadOptions,
  ): Promise<readonly ModelInfo[]>
  inspect(ref: ModelRef, options?: ModelCatalogReadOptions): Promise<ModelInfo | undefined>
}

export const RoutingFailureClassSchema = z.enum([
  "provider-unavailable",
  "model-unavailable",
  "rate-limit",
  "transient",
  "authentication",
  "configuration",
  "permission",
  "deterministic-gate",
  "budget",
])
export type RoutingFailureClass = z.infer<typeof RoutingFailureClassSchema>

export const FallbackPolicySchema = z
  .object({
    allowedFailures: z
      .array(RoutingFailureClassSchema)
      .refine(uniqueValues, "Allowed failure classes must be unique"),
  })
  .strict()
export type FallbackPolicy = z.infer<typeof FallbackPolicySchema>

export const ResolvedModelRouteSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestedProfileId: SlugSchema,
    selectedProfileId: SlugSchema,
    role: z.enum(["executor", "judge"]),
    provider: ProviderInfoSchema,
    model: ModelInfoSchema,
    profile: RoleProfileSchema,
    catalogSnapshotId: z.string().regex(/^catalog:[a-f0-9]{64}$/),
    fallback: z.boolean(),
    attemptedProfiles: z.array(SlugSchema),
    reason: NonEmptyStringSchema,
  })
  .strict()
export type ResolvedModelRoute = z.infer<typeof ResolvedModelRouteSchema>

export type ModelRouteRequest = {
  requestedProfileId: string
  profiles: Readonly<Record<string, RoleProfile>>
  snapshot: ModelCatalogSnapshot
  attemptedProfiles?: readonly string[]
  failure?: RoutingFailureClass
  fallbackPolicy: FallbackPolicy
}

export interface ModelRouter {
  resolve(request: ModelRouteRequest): ResolvedModelRoute
}

export interface ModelCatalogSource {
  load(): Promise<CatalogSeed>
}

export interface ModelCatalogCache {
  read(): Promise<ModelCatalogSnapshot | undefined>
  write(snapshot: ModelCatalogSnapshot): Promise<void>
}
