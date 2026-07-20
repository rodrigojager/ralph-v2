import { createHash } from "node:crypto"

import { type CatalogSeed, CatalogSeedSchema, type ModelInfo, type ProviderInfo } from "./contracts"
import { CURATED_CATALOG_SEED, CURATED_CATALOG_SOURCE_URL } from "./curated"
import { ProviderCoreError } from "./errors"

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type ModelsDevModel = {
  id?: unknown
  name?: unknown
  family?: unknown
  status?: unknown
  attachment?: unknown
  reasoning?: unknown
  reasoning_options?: unknown
  tool_call?: unknown
  structured_output?: unknown
  modalities?: unknown
  limit?: unknown
  cost?: unknown
}

type ModelsDevProvider = {
  id?: unknown
  name?: unknown
  models?: unknown
}

const SELECTED_MODEL_REFS = CURATED_CATALOG_SEED.models.map((model) => ({
  provider: model.provider,
  model: model.id,
}))

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderCoreError("MODELS_DEV_SCHEMA_INVALID", `${context} must be an object`)
  }
  return value as Record<string, unknown>
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback
}

function modelStatus(value: unknown): ModelInfo["status"] {
  if (value === "deprecated") return "deprecated"
  if (value === "unavailable") return "unavailable"
  if (value === "unknown") return "unknown"
  return "available"
}

function inputModalities(value: unknown): ModelInfo["capabilities"]["input"] {
  const raw = record(value, "models.dev modalities").input
  if (!Array.isArray(raw)) return ["text"]
  const mapped = raw.flatMap((entry): Array<"text" | "image" | "file"> => {
    if (entry === "text" || entry === "image") return [entry]
    if (entry === "pdf" || entry === "file") return ["file"]
    return []
  })
  const normalized: Array<"text" | "image" | "file"> = mapped.length > 0 ? mapped : ["text"]
  return [...new Set(normalized)]
}

function reasoningVariants(value: unknown): ModelInfo["variants"] {
  if (!Array.isArray(value)) return []
  const variants = new Map<string, ModelInfo["variants"][number]>()
  for (const option of value) {
    const source = record(option, "models.dev reasoning option")
    if (source.type !== "effort" || !Array.isArray(source.values)) continue
    for (const item of source.values) {
      if (typeof item !== "string" || !/^[a-z][a-z0-9-]*$/.test(item)) continue
      variants.set(item, {
        id: item,
        name: `${item[0]?.toUpperCase()}${item.slice(1)} reasoning`,
        parameters: { reasoning_effort: item },
      })
    }
  }
  return [...variants.values()]
}

function price(
  provider: string,
  model: string,
  value: unknown,
  reasoningModel: boolean,
  capturedAt: string,
  revision: string,
): ModelInfo["price"] {
  const cost = record(value ?? {}, "models.dev model cost")
  const output = finiteNumber(cost.output)
  const amounts = {
    input: finiteNumber(cost.input),
    output,
    reasoning: finiteNumber(cost.reasoning) ?? (reasoningModel ? output : undefined),
    cacheRead: finiteNumber(cost.cache_read),
    cacheWrite: finiteNumber(cost.cache_write),
  }
  if (Object.values(amounts).every((amount) => amount === undefined)) {
    return {
      id: `models-dev:${revision}:${provider}:${model}`,
      status: "unavailable",
      source: CURATED_CATALOG_SOURCE_URL,
      capturedAt,
      appliesTo: ["api"],
      reason: "models.dev did not publish pricing for this model snapshot",
    }
  }
  return {
    id: `models-dev:${revision}:${provider}:${model}`,
    status: "available",
    source: CURATED_CATALOG_SOURCE_URL,
    capturedAt,
    appliesTo: ["api"],
    currency: "USD",
    unit: "per-million-tokens",
    ...Object.fromEntries(Object.entries(amounts).filter(([, amount]) => amount !== undefined)),
  }
}

function normalizeModel(
  providerId: string,
  modelId: string,
  input: ModelsDevModel,
  capturedAt: string,
  revision: string,
): ModelInfo {
  const curated = CURATED_CATALOG_SEED.models.find(
    (candidate) => candidate.provider === providerId && candidate.id === modelId,
  )
  if (!curated) {
    throw new ProviderCoreError(
      "MODELS_DEV_MODEL_NOT_CURATED",
      `Remote model ${providerId}/${modelId} is outside the curated Ralph catalog`,
    )
  }
  const limits = record(input.limit ?? {}, "models.dev model limit")
  const cost = record(input.cost ?? {}, "models.dev model cost")
  const usage: ModelInfo["capabilities"]["usage"] = ["input", "output"]
  if (input.reasoning === true) usage.push("reasoning")
  if (finiteNumber(cost.cache_read) !== undefined) usage.push("cache-read")
  if (finiteNumber(cost.cache_write) !== undefined) usage.push("cache-write")
  if (Object.values(cost).some((item) => finiteNumber(item) !== undefined)) usage.push("cost")
  const catalogSource = `models-dev:${revision}`
  return {
    schemaVersion: 1,
    provider: providerId,
    id: stringValue(input.id, modelId),
    name: stringValue(input.name, curated.name),
    family: stringValue(input.family, curated.family ?? "unknown"),
    status: modelStatus(input.status),
    capabilities: {
      input: inputModalities(input.modalities ?? { input: ["text"] }),
      tools: input.tool_call === true,
      toolStreaming: false,
      reasoning: input.reasoning === true,
      structuredOutput: input.structured_output === true,
      usage,
    },
    limits: {
      ...(positiveInteger(limits.context) ? { context: positiveInteger(limits.context) } : {}),
      ...(positiveInteger(limits.output) ? { output: positiveInteger(limits.output) } : {}),
    },
    variants: reasoningVariants(input.reasoning_options),
    price: price(providerId, modelId, input.cost, input.reasoning === true, capturedAt, revision),
    access: curated.access,
    catalogSource,
    catalogUpdatedAt: capturedAt,
  }
}

export type ModelsDevCatalogSourceOptions = {
  fetch?: FetchLike
  clock?: () => Date
  url?: string
  timeoutMs?: number
  maximumBytes?: number
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  controller: AbortController,
): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maximumBytes) {
        controller.abort("models.dev response exceeds byte limit")
        await reader.cancel().catch(() => undefined)
        throw new ProviderCoreError(
          "MODELS_DEV_RESPONSE_TOO_LARGE",
          "models.dev response is too large",
        )
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new ProviderCoreError(
      "MODELS_DEV_RESPONSE_ENCODING_INVALID",
      "models.dev response is not valid UTF-8",
    )
  }
}

/** Fetches data only. The response is validated and normalized into Ralph-owned schemas. */
export class ModelsDevCatalogSource {
  readonly #fetch: FetchLike
  readonly #clock: () => Date
  readonly #url: string
  readonly #timeoutMs: number
  readonly #maximumBytes: number

  constructor(options: ModelsDevCatalogSourceOptions = {}) {
    this.#fetch = options.fetch ?? fetch
    this.#clock = options.clock ?? (() => new Date())
    this.#url = options.url ?? CURATED_CATALOG_SOURCE_URL
    this.#timeoutMs = options.timeoutMs ?? 10_000
    this.#maximumBytes = options.maximumBytes ?? 25 * 1024 * 1024
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new ProviderCoreError(
        "MODELS_DEV_TIMEOUT_INVALID",
        "models.dev timeout must be positive",
      )
    }
    if (!Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes <= 0) {
      throw new ProviderCoreError(
        "MODELS_DEV_LIMIT_INVALID",
        "models.dev byte limit must be positive",
      )
    }
  }

  async load(): Promise<CatalogSeed> {
    const controller = new AbortController()
    let rejectTimeout: ((error: ProviderCoreError) => void) | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject
    })
    const timeout = setTimeout(() => {
      controller.abort("models.dev timeout")
      rejectTimeout?.(new ProviderCoreError("MODELS_DEV_TIMEOUT", "models.dev request timed out"))
    }, this.#timeoutMs)
    let response: Response
    try {
      response = await Promise.race([
        this.#fetch(this.#url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        }),
        timeoutPromise,
      ])
    } catch (error) {
      clearTimeout(timeout)
      if (error instanceof ProviderCoreError) throw error
      throw new ProviderCoreError("MODELS_DEV_REQUEST_FAILED", "Could not fetch models.dev", {
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    let text: string
    try {
      if (!response.ok) {
        throw new ProviderCoreError(
          "MODELS_DEV_HTTP_ERROR",
          `models.dev returned HTTP ${response.status}`,
          { status: response.status },
        )
      }
      const declaredLength = Number(response.headers.get("content-length"))
      if (Number.isFinite(declaredLength) && declaredLength > this.#maximumBytes) {
        controller.abort("models.dev response exceeds declared byte limit")
        throw new ProviderCoreError(
          "MODELS_DEV_RESPONSE_TOO_LARGE",
          "models.dev response is too large",
        )
      }
      text = await Promise.race([
        readBoundedBody(response, this.#maximumBytes, controller),
        timeoutPromise,
      ])
    } finally {
      clearTimeout(timeout)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ProviderCoreError("MODELS_DEV_JSON_INVALID", "models.dev returned invalid JSON")
    }
    const root = record(parsed, "models.dev root")
    const revision = createHash("sha256").update(text).digest("hex")
    const capturedAt = this.#clock().toISOString()
    const providerIds = [...new Set(SELECTED_MODEL_REFS.map((entry) => entry.provider))]
    const providers: ProviderInfo[] = providerIds.map((providerId) => {
      const raw = record(root[providerId], `models.dev provider ${providerId}`) as ModelsDevProvider
      const curated = CURATED_CATALOG_SEED.providers.find((item) => item.id === providerId)
      if (!curated) throw new ProviderCoreError("MODELS_DEV_PROVIDER_NOT_CURATED", providerId)
      return {
        ...curated,
        name: stringValue(raw.name, curated.name),
        catalogSource: `models-dev:${revision}`,
        catalogUpdatedAt: capturedAt,
      }
    })
    const models = SELECTED_MODEL_REFS.map(({ provider, model }) => {
      const rawProvider = record(root[provider], `models.dev provider ${provider}`)
      const rawModels = record(rawProvider.models, `models.dev models for ${provider}`)
      const rawModel = record(rawModels[model], `models.dev model ${provider}/${model}`)
      return normalizeModel(provider, model, rawModel, capturedAt, revision)
    })
    return CatalogSeedSchema.parse({
      source: {
        id: "models-dev",
        kind: "remote",
        revision,
        url: this.#url,
      },
      providers,
      models,
    })
  }
}
