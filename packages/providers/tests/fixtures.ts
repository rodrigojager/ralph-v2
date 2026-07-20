import {
  CURATED_CATALOG_SEED,
  type ModelRequirements,
  type ProviderDriver,
  type ProviderEventSink,
  ProviderInfoSchema,
  type ProviderModelRequest,
  ProviderModelRequestSchema,
  type ProviderModelResult,
  ProviderModelResultSchema,
  type RoleProfile,
  RoleProfileSchema,
} from "../src/index"

export const NO_REQUIREMENTS: ModelRequirements = {
  input: [],
  tools: false,
  toolStreaming: false,
  reasoning: false,
  structuredOutput: false,
  usage: [],
  access: [],
}

export function roleProfile(input: {
  id: string
  role?: "executor" | "judge"
  provider: string
  model: string
  variant?: string
  fallbackProfiles?: readonly string[]
  requirements?: ModelRequirements
}): RoleProfile {
  return RoleProfileSchema.parse({
    id: input.id,
    role: input.role ?? "executor",
    backend: "embedded",
    provider: input.provider,
    model: input.model,
    ...(input.variant === undefined ? {} : { variant: input.variant }),
    parameters: {},
    requirements: input.requirements ?? NO_REQUIREMENTS,
    fallbackProfiles: input.fallbackProfiles ?? [],
    limits: {},
  })
}

export function fakeProviderDriver(id = "openai"): ProviderDriver {
  const provider = ProviderInfoSchema.parse(
    CURATED_CATALOG_SEED.providers.find((candidate) => candidate.id === id),
  )
  const models = CURATED_CATALOG_SEED.models.filter((model) => model.provider === id)
  return {
    id,
    async info() {
      return provider
    },
    async listModels() {
      return models
    },
    credentialDriver() {
      return undefined
    },
    async invoke(
      requestInput: ProviderModelRequest,
      _sink: ProviderEventSink,
    ): Promise<ProviderModelResult> {
      const request = ProviderModelRequestSchema.parse(requestInput)
      return ProviderModelResultSchema.parse({
        schemaVersion: 1,
        callId: request.callId,
        status: "succeeded",
        finishReason: "stop",
        text: "ok",
        usage: { source: "unavailable", semantics: "final" },
      })
    },
    async cancel() {},
  }
}
