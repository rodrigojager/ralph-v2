import { CachedModelCatalog } from "./catalog"
import { createCuratedCatalogSource } from "./curated"
import { FileModelCatalogCache } from "./file-cache"
import { ModelsDevCatalogSource, type ModelsDevCatalogSourceOptions } from "./models-dev"

export const DEFAULT_MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1_000

export type ModelCatalogRuntimeOptions = {
  cachePath: string
  ttlMs?: number
  fetch?: ModelsDevCatalogSourceOptions["fetch"]
  clock?: () => Date
  modelsDevUrl?: string
  modelsDevTimeoutMs?: number
  modelsDevMaximumBytes?: number
  cacheMaximumBytes?: number
}

/**
 * Composes the production catalog without performing I/O. Network and disk are
 * touched only when a catalog read is requested.
 */
export function createModelCatalogRuntime(options: ModelCatalogRuntimeOptions): CachedModelCatalog {
  const source = new ModelsDevCatalogSource({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.modelsDevUrl === undefined ? {} : { url: options.modelsDevUrl }),
    ...(options.modelsDevTimeoutMs === undefined ? {} : { timeoutMs: options.modelsDevTimeoutMs }),
    ...(options.modelsDevMaximumBytes === undefined
      ? {}
      : { maximumBytes: options.modelsDevMaximumBytes }),
  })
  const cache = new FileModelCatalogCache({
    path: options.cachePath,
    ...(options.cacheMaximumBytes === undefined ? {} : { maximumBytes: options.cacheMaximumBytes }),
  })
  return new CachedModelCatalog({
    source,
    cache,
    fallbackSource: createCuratedCatalogSource(),
    ttlMs: options.ttlMs ?? DEFAULT_MODEL_CATALOG_TTL_MS,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })
}
