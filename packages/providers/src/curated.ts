import { StaticCatalogSource } from "./catalog"
import {
  type CatalogSeed,
  CatalogSeedSchema,
  type ModelAccess,
  type ModelInfo,
  type ModelInput,
  type ModelVariant,
  type ProviderInfo,
  type UsageMetric,
} from "./contracts"

export const CURATED_CATALOG_CAPTURED_AT = "2026-07-18T10:30:17.409Z"
export const CURATED_CATALOG_REVISION = "models-dev-2026-07-18t103017z"
export const CURATED_CATALOG_SOURCE_URL = "https://models.dev/api.json"

const CATALOG_SOURCE = `ralph-curated:${CURATED_CATALOG_REVISION}`

function credentialMethods(
  providerId: string,
  providerLabel: string,
): ProviderInfo["credentialMethods"] {
  const apiMethods: ProviderInfo["credentialMethods"] = [
    {
      method: "api-key",
      label: `${providerLabel} API key`,
      access: ["api"],
      interactive: true,
    },
    {
      method: "environment",
      label: `${providerLabel} API key from environment`,
      access: ["api"],
      interactive: false,
    },
  ]
  if (providerId !== "openai") return apiMethods
  return [
    ...apiMethods,
    {
      method: "oauth-browser",
      label: "ChatGPT account in browser",
      access: ["subscription"],
      interactive: true,
    },
    {
      method: "device-code",
      label: "ChatGPT account device flow",
      access: ["subscription"],
      interactive: false,
    },
    {
      method: "subscription-session",
      label: "ChatGPT Plus/Pro subscription session",
      access: ["subscription"],
      interactive: true,
    },
  ]
}

function provider(
  id: string,
  name: string,
  access: readonly ModelAccess[],
  status: ProviderInfo["status"],
): ProviderInfo {
  return {
    schemaVersion: 1,
    id,
    name,
    status,
    access: [...access],
    credentialMethods: credentialMethods(id, name),
    catalogSource: CATALOG_SOURCE,
    catalogUpdatedAt: CURATED_CATALOG_CAPTURED_AT,
  }
}

const OPENAI_REASONING_VARIANTS: readonly ModelVariant[] = [
  {
    id: "none",
    name: "No reasoning",
    description: "Disable additional reasoning where the model permits it",
    parameters: { reasoning_effort: "none" },
  },
  {
    id: "low",
    name: "Low reasoning",
    description: "Lower reasoning effort and latency",
    parameters: { reasoning_effort: "low" },
  },
  {
    id: "medium",
    name: "Medium reasoning",
    description: "Balanced reasoning effort",
    parameters: { reasoning_effort: "medium" },
  },
  {
    id: "high",
    name: "High reasoning",
    description: "Higher reasoning effort for difficult work",
    parameters: { reasoning_effort: "high" },
  },
  {
    id: "xhigh",
    name: "Extra-high reasoning",
    description: "Maximum declared reasoning effort",
    parameters: { reasoning_effort: "xhigh" },
  },
]

type CuratedModelInput = {
  provider: string
  id: string
  name: string
  family: string
  input: readonly ModelInput[]
  usage: readonly UsageMetric[]
  context: number
  output: number
  access: readonly ModelAccess[]
  inputPrice: number
  outputPrice: number
  cacheReadPrice: number
  cacheWritePrice?: number
  variants?: readonly ModelVariant[]
}

function model(input: CuratedModelInput): ModelInfo {
  return {
    schemaVersion: 1,
    provider: input.provider,
    id: input.id,
    name: input.name,
    family: input.family,
    status: "available",
    capabilities: {
      input: [...input.input],
      tools: true,
      toolStreaming: false,
      reasoning: true,
      structuredOutput: true,
      usage: [...input.usage],
    },
    limits: { context: input.context, output: input.output },
    variants: input.variants ? [...input.variants] : [],
    price: {
      id: `models-dev:${CURATED_CATALOG_REVISION}:${input.provider}:${input.id}`,
      status: "available",
      source: CURATED_CATALOG_SOURCE_URL,
      capturedAt: CURATED_CATALOG_CAPTURED_AT,
      appliesTo: ["api"],
      currency: "USD",
      unit: "per-million-tokens",
      input: input.inputPrice,
      output: input.outputPrice,
      reasoning: input.outputPrice,
      cacheRead: input.cacheReadPrice,
      ...(input.cacheWritePrice === undefined ? {} : { cacheWrite: input.cacheWritePrice }),
    },
    access: [...input.access],
    catalogSource: CATALOG_SOURCE,
    catalogUpdatedAt: CURATED_CATALOG_CAPTURED_AT,
  }
}

const providers: readonly ProviderInfo[] = [
  provider("openai", "OpenAI", ["api", "subscription"], "available"),
  provider("openrouter", "OpenRouter", ["api"], "available"),
  provider("anthropic", "Anthropic", ["api"], "unknown"),
]

const models: readonly ModelInfo[] = [
  model({
    provider: "openai",
    id: "gpt-5.5",
    name: "GPT-5.5",
    family: "gpt",
    input: ["text", "image", "file"],
    usage: ["input", "output", "reasoning", "cache-read", "cost"],
    context: 1_050_000,
    output: 128_000,
    access: ["api", "subscription"],
    inputPrice: 5,
    outputPrice: 30,
    cacheReadPrice: 0.5,
    variants: OPENAI_REASONING_VARIANTS,
  }),
  model({
    provider: "openai",
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    family: "gpt-codex",
    input: ["text", "image", "file"],
    usage: ["input", "output", "reasoning", "cache-read", "cost"],
    context: 400_000,
    output: 128_000,
    access: ["api"],
    inputPrice: 1.75,
    outputPrice: 14,
    cacheReadPrice: 0.175,
    variants: OPENAI_REASONING_VARIANTS,
  }),
  model({
    provider: "openai",
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    family: "gpt-codex-spark",
    input: ["text", "image", "file"],
    usage: ["input", "output", "reasoning", "cache-read", "cost"],
    context: 128_000,
    output: 32_000,
    access: ["api", "subscription"],
    inputPrice: 1.75,
    outputPrice: 14,
    cacheReadPrice: 0.175,
    variants: OPENAI_REASONING_VARIANTS,
  }),
  model({
    provider: "openai",
    id: "gpt-5.4",
    name: "GPT-5.4",
    family: "gpt",
    input: ["text", "image", "file"],
    usage: ["input", "output", "reasoning", "cache-read", "cost"],
    context: 1_050_000,
    output: 128_000,
    access: ["api", "subscription"],
    inputPrice: 2.5,
    outputPrice: 15,
    cacheReadPrice: 0.25,
    variants: OPENAI_REASONING_VARIANTS,
  }),
  model({
    provider: "openai",
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    family: "gpt-mini",
    input: ["text", "image"],
    usage: ["input", "output", "reasoning", "cache-read", "cost"],
    context: 400_000,
    output: 128_000,
    access: ["api", "subscription"],
    inputPrice: 0.75,
    outputPrice: 4.5,
    cacheReadPrice: 0.075,
    variants: OPENAI_REASONING_VARIANTS,
  }),
  model({
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    family: "claude-sonnet",
    input: ["text", "image", "file"],
    usage: ["input", "output", "cache-read", "cache-write", "cost"],
    context: 1_000_000,
    output: 128_000,
    access: ["api"],
    inputPrice: 3,
    outputPrice: 15,
    cacheReadPrice: 0.3,
    cacheWritePrice: 3.75,
  }),
  model({
    provider: "anthropic",
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    family: "claude-haiku",
    input: ["text", "image", "file"],
    usage: ["input", "output", "cache-read", "cache-write", "cost"],
    context: 200_000,
    output: 64_000,
    access: ["api"],
    inputPrice: 1,
    outputPrice: 5,
    cacheReadPrice: 0.1,
    cacheWritePrice: 1.25,
  }),
  model({
    provider: "openrouter",
    id: "openai/gpt-5.3-codex",
    name: "GPT-5.3 Codex through OpenRouter",
    family: "gpt-codex",
    input: ["text", "image", "file"],
    usage: ["input", "output", "reasoning", "cache-read", "cost"],
    context: 400_000,
    output: 128_000,
    access: ["api"],
    inputPrice: 1.75,
    outputPrice: 14,
    cacheReadPrice: 0.175,
  }),
  model({
    provider: "openrouter",
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6 through OpenRouter",
    family: "claude-sonnet",
    input: ["text", "image", "file"],
    usage: ["input", "output", "cache-read", "cache-write", "cost"],
    context: 1_000_000,
    output: 128_000,
    access: ["api"],
    inputPrice: 3,
    outputPrice: 15,
    cacheReadPrice: 0.3,
    cacheWritePrice: 3.75,
  }),
]

export const CURATED_CATALOG_SEED: CatalogSeed = CatalogSeedSchema.parse({
  source: {
    id: "ralph-curated",
    kind: "curated",
    revision: CURATED_CATALOG_REVISION,
    url: CURATED_CATALOG_SOURCE_URL,
  },
  providers,
  models,
})

export function createCuratedCatalogSource(): StaticCatalogSource {
  return new StaticCatalogSource(CURATED_CATALOG_SEED)
}
