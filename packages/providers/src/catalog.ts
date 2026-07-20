import { createHash } from "node:crypto"

import {
  type CatalogResolution,
  CatalogResolutionSchema,
  type CatalogSeed,
  CatalogSeedSchema,
  type ModelCatalog,
  type ModelCatalogCache,
  type ModelCatalogQuery,
  type ModelCatalogReadOptions,
  type ModelCatalogSnapshot,
  ModelCatalogSnapshotSchema,
  type ModelCatalogSource,
  type ModelInfo,
  ModelInfoSchema,
  type ModelRef,
  ModelRefSchema,
  type ModelRequirements,
  ModelRequirementsSchema,
  type ProviderInfo,
  ProviderInfoSchema,
} from "./contracts"
import { errorMessage, ProviderCoreError } from "./errors"

type JsonPrimitive = boolean | number | string | null
type CanonicalValue =
  | JsonPrimitive
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue }

function clone<T>(value: T): T {
  return structuredClone(value)
}

function canonicalize(value: unknown): CanonicalValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize)
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    )
  }
  throw new ProviderCoreError(
    "PROVIDER_CATALOG_VALUE_INVALID",
    `Catalog contains a non-serializable ${typeof value} value`,
  )
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function normalizeSeed(input: CatalogSeed): CatalogSeed {
  const seed = CatalogSeedSchema.parse(input)
  return CatalogSeedSchema.parse({
    source: seed.source,
    providers: [...seed.providers].sort((left, right) => left.id.localeCompare(right.id)),
    models: [...seed.models].sort((left, right) => {
      const providerOrder = left.provider.localeCompare(right.provider)
      return providerOrder === 0 ? left.id.localeCompare(right.id) : providerOrder
    }),
  })
}

function warningFrom(error: unknown, prefix: string): string {
  const message = errorMessage(error)
    .replace(/[\r\n\t]+/g, " ")
    .trim()
  return message.length > 0 ? `${prefix}: ${message}` : prefix
}

function combineWarnings(...warnings: readonly (string | undefined)[]): string | undefined {
  const present = warnings.filter((warning): warning is string => warning !== undefined)
  return present.length > 0 ? present.join("; ") : undefined
}

function isFresh(snapshot: ModelCatalogSnapshot, now: Date): boolean {
  return now.getTime() < Date.parse(snapshot.expiresAt)
}

function snapshotContent(
  snapshot: ModelCatalogSnapshot,
): Omit<ModelCatalogSnapshot, "id" | "contentHash"> {
  return {
    schemaVersion: snapshot.schemaVersion,
    source: snapshot.source,
    providers: snapshot.providers,
    models: snapshot.models,
    createdAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
  }
}

function hashSnapshotContent(content: Omit<ModelCatalogSnapshot, "id" | "contentHash">): string {
  return createHash("sha256").update(stableJson(content)).digest("hex")
}

export function validateModelCatalogSnapshotIntegrity(input: unknown): ModelCatalogSnapshot {
  const snapshot = ModelCatalogSnapshotSchema.parse(input)
  const actualHash = hashSnapshotContent(snapshotContent(snapshot))
  if (actualHash !== snapshot.contentHash) {
    throw new ProviderCoreError(
      "PROVIDER_CATALOG_SNAPSHOT_INTEGRITY_FAILED",
      "Catalog snapshot content does not match its declared hash",
      { snapshotId: snapshot.id },
    )
  }
  return snapshot
}

function makeSnapshot(seedInput: CatalogSeed, now: Date, ttlMs: number): ModelCatalogSnapshot {
  const seed = normalizeSeed(seedInput)
  const expiresAtMs = now.getTime() + ttlMs
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new ProviderCoreError(
      "PROVIDER_CATALOG_TTL_OVERFLOW",
      "Catalog TTL exceeds the supported timestamp range",
    )
  }

  const content = {
    schemaVersion: 1 as const,
    source: seed.source,
    providers: seed.providers,
    models: seed.models,
    createdAt: now.toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  }
  const contentHash = hashSnapshotContent(content)
  return ModelCatalogSnapshotSchema.parse({
    ...content,
    id: `catalog:${contentHash}`,
    contentHash,
  })
}

export function modelSatisfiesRequirements(
  modelInput: ModelInfo,
  requirementsInput: ModelRequirements,
): boolean {
  const model = ModelInfoSchema.parse(modelInput)
  const requirements = ModelRequirementsSchema.parse(requirementsInput)
  const input = new Set(model.capabilities.input)
  const usage = new Set(model.capabilities.usage)
  const access = new Set(model.access)

  return (
    requirements.input.every((entry) => input.has(entry)) &&
    (!requirements.tools || model.capabilities.tools) &&
    (!requirements.toolStreaming || model.capabilities.toolStreaming) &&
    (!requirements.reasoning || model.capabilities.reasoning) &&
    (!requirements.structuredOutput || model.capabilities.structuredOutput) &&
    requirements.usage.every((entry) => usage.has(entry)) &&
    requirements.access.every((entry) => access.has(entry)) &&
    (requirements.minimumContext === undefined ||
      (model.limits.context !== undefined &&
        model.limits.context >= requirements.minimumContext)) &&
    (requirements.minimumOutput === undefined ||
      (model.limits.output !== undefined && model.limits.output >= requirements.minimumOutput))
  )
}

export class StaticCatalogSource implements ModelCatalogSource {
  readonly #seed: CatalogSeed

  constructor(seed: CatalogSeed) {
    this.#seed = normalizeSeed(seed)
  }

  async load(): Promise<CatalogSeed> {
    return clone(this.#seed)
  }
}

export class InMemoryModelCatalogCache implements ModelCatalogCache {
  #snapshot: ModelCatalogSnapshot | undefined

  constructor(initial?: ModelCatalogSnapshot) {
    if (initial !== undefined) {
      this.#snapshot = clone(validateModelCatalogSnapshotIntegrity(initial))
    }
  }

  async read(): Promise<ModelCatalogSnapshot | undefined> {
    return this.#snapshot === undefined ? undefined : clone(this.#snapshot)
  }

  async write(snapshot: ModelCatalogSnapshot): Promise<void> {
    this.#snapshot = clone(validateModelCatalogSnapshotIntegrity(snapshot))
  }
}

export type CachedModelCatalogOptions = {
  source: ModelCatalogSource
  cache: ModelCatalogCache
  fallbackSource?: ModelCatalogSource
  ttlMs: number
  clock?: () => Date
}

export class CachedModelCatalog implements ModelCatalog {
  readonly #source: ModelCatalogSource
  readonly #cache: ModelCatalogCache
  readonly #fallbackSource: ModelCatalogSource | undefined
  readonly #ttlMs: number
  readonly #clock: () => Date
  #refreshInFlight: Promise<CatalogResolution> | undefined

  constructor(options: CachedModelCatalogOptions) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new ProviderCoreError(
        "PROVIDER_CATALOG_TTL_INVALID",
        "Catalog TTL must be a positive safe integer",
        { ttlMs: options.ttlMs },
      )
    }
    this.#source = options.source
    this.#cache = options.cache
    this.#fallbackSource = options.fallbackSource
    this.#ttlMs = options.ttlMs
    this.#clock = options.clock ?? (() => new Date())
  }

  async snapshot(options: ModelCatalogReadOptions = {}): Promise<CatalogResolution> {
    const now = this.#validatedNow()
    const cachedRead = await this.#readCache()
    if (!options.forceRefresh && cachedRead.snapshot && isFresh(cachedRead.snapshot, now)) {
      return CatalogResolutionSchema.parse({
        snapshot: cachedRead.snapshot,
        origin: "cache",
        stale: false,
        ...(cachedRead.warning ? { warning: cachedRead.warning } : {}),
      })
    }

    const existing = this.#refreshInFlight
    if (existing) {
      return clone(await existing)
    }

    const refresh = this.#refresh(now, cachedRead.snapshot, cachedRead.warning)
    this.#refreshInFlight = refresh
    try {
      return clone(await refresh)
    } finally {
      if (this.#refreshInFlight === refresh) {
        this.#refreshInFlight = undefined
      }
    }
  }

  async providers(options: ModelCatalogReadOptions = {}): Promise<readonly ProviderInfo[]> {
    const resolution = await this.snapshot(options)
    return resolution.snapshot.providers.map((provider) =>
      clone(ProviderInfoSchema.parse(provider)),
    )
  }

  async models(
    query: ModelCatalogQuery = {},
    options: ModelCatalogReadOptions = {},
  ): Promise<readonly ModelInfo[]> {
    const resolution = await this.snapshot(options)
    return resolution.snapshot.models
      .filter((model) => query.provider === undefined || model.provider === query.provider)
      .filter((model) => query.includeDeprecated === true || model.status !== "deprecated")
      .filter(
        (model) =>
          query.requirements === undefined || modelSatisfiesRequirements(model, query.requirements),
      )
      .map((model) => clone(ModelInfoSchema.parse(model)))
  }

  async inspect(
    refInput: ModelRef,
    options: ModelCatalogReadOptions = {},
  ): Promise<ModelInfo | undefined> {
    const ref = ModelRefSchema.parse(refInput)
    const resolution = await this.snapshot(options)
    const model = resolution.snapshot.models.find(
      (candidate) => candidate.provider === ref.provider && candidate.id === ref.model,
    )
    if (!model) {
      return undefined
    }
    if (
      ref.variant !== undefined &&
      !model.variants.some((variant) => variant.id === ref.variant)
    ) {
      return undefined
    }
    return clone(ModelInfoSchema.parse(model))
  }

  #validatedNow(): Date {
    const now = this.#clock()
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new ProviderCoreError(
        "PROVIDER_CATALOG_CLOCK_INVALID",
        "Catalog clock returned an invalid date",
      )
    }
    return new Date(now.getTime())
  }

  async #readCache(): Promise<{
    snapshot: ModelCatalogSnapshot | undefined
    warning: string | undefined
  }> {
    try {
      const candidate = await this.#cache.read()
      if (candidate === undefined) {
        return { snapshot: undefined, warning: undefined }
      }
      return { snapshot: validateModelCatalogSnapshotIntegrity(candidate), warning: undefined }
    } catch (error) {
      return {
        snapshot: undefined,
        warning: warningFrom(error, "Catalog cache was invalid or unavailable"),
      }
    }
  }

  async #refresh(
    now: Date,
    cached: ModelCatalogSnapshot | undefined,
    cacheWarning: string | undefined,
  ): Promise<CatalogResolution> {
    try {
      const snapshot = makeSnapshot(await this.#source.load(), now, this.#ttlMs)
      const writeWarning = await this.#writeCache(snapshot)
      return CatalogResolutionSchema.parse({
        snapshot,
        origin: "source",
        stale: false,
        ...(cacheWarning || writeWarning
          ? { warning: combineWarnings(cacheWarning, writeWarning) }
          : {}),
      })
    } catch (sourceError) {
      const sourceWarning = warningFrom(sourceError, "Primary catalog source failed")
      if (cached !== undefined) {
        return CatalogResolutionSchema.parse({
          snapshot: cached,
          origin: "stale-cache",
          stale: true,
          warning: combineWarnings(cacheWarning, sourceWarning),
        })
      }

      if (this.#fallbackSource !== undefined) {
        try {
          const snapshot = makeSnapshot(await this.#fallbackSource.load(), now, this.#ttlMs)
          const writeWarning = await this.#writeCache(snapshot)
          return CatalogResolutionSchema.parse({
            snapshot,
            origin: "fallback",
            stale: false,
            warning: combineWarnings(cacheWarning, sourceWarning, writeWarning),
          })
        } catch (fallbackError) {
          throw new ProviderCoreError(
            "PROVIDER_CATALOG_UNAVAILABLE",
            "Primary and fallback catalog sources failed",
            {
              primaryError: errorMessage(sourceError),
              fallbackError: errorMessage(fallbackError),
            },
          )
        }
      }

      throw new ProviderCoreError(
        "PROVIDER_CATALOG_UNAVAILABLE",
        "Catalog source failed and no valid cache or fallback was available",
        { sourceError: errorMessage(sourceError) },
      )
    }
  }

  async #writeCache(snapshot: ModelCatalogSnapshot): Promise<string | undefined> {
    try {
      await this.#cache.write(snapshot)
      return undefined
    } catch (error) {
      return warningFrom(error, "Catalog snapshot could not be cached")
    }
  }
}
