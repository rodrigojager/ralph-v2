import { type CommandResult, EXIT_CODES, RalphError } from "@ralph/domain"
import {
  type CatalogResolution,
  type ModelCatalog,
  type ModelInfo,
  type ModelParameters,
  type ModelRef,
  type ModelRequirements,
  modelSatisfiesRequirements,
  ProviderCoreError,
  type ProviderInfo,
  resolveModelParameters,
} from "@ralph/providers"

export type CatalogHandlerResult<T> = {
  result: CommandResult<T>
  human: string
}

export type CatalogReadCommandOptions = {
  refresh?: boolean
}

export type ProvidersListData = {
  count: number
  providers: readonly ProviderInfo[]
  catalog: CatalogUse
}

export type ProviderInspectData = {
  provider: ProviderInfo
  catalog: CatalogUse
}

export type ModelsListOptions = CatalogReadCommandOptions & {
  provider?: string
  includeDeprecated?: boolean
  requirements?: ModelRequirements
}

export type ModelsListData = {
  count: number
  provider?: string
  models: readonly ModelInfo[]
  catalog: CatalogUse
}

export type ModelInspectOptions = CatalogReadCommandOptions & ModelRef

export type ModelInspectData = {
  model: ModelInfo
  selectedVariant?: string
  effectiveParameters: ModelParameters
  catalog: CatalogUse
}

export type CatalogUse = {
  snapshotId: string
  source: CatalogResolution["snapshot"]["source"]
  origin: CatalogResolution["origin"]
  stale: boolean
  warning?: string
}

function result<T>(command: string, data: T, human: string): CatalogHandlerResult<T> {
  return {
    result: {
      schemaVersion: 1,
      ok: true,
      command,
      data,
      diagnostics: [],
    },
    human,
  }
}

function readOptions(options: CatalogReadCommandOptions): { forceRefresh?: boolean } {
  return options.refresh === true ? { forceRefresh: true } : {}
}

async function catalogResolution(
  catalog: ModelCatalog,
  options: CatalogReadCommandOptions,
): Promise<CatalogResolution> {
  return catalogRead(() => catalog.snapshot(readOptions(options)))
}

function catalogUse(resolution: CatalogResolution): CatalogUse {
  return {
    snapshotId: resolution.snapshot.id,
    source: resolution.snapshot.source,
    origin: resolution.origin,
    stale: resolution.stale,
    ...(resolution.warning ? { warning: resolution.warning } : {}),
  }
}

function catalogHuman(catalog: CatalogUse): string {
  return [
    `Catalog snapshot: ${catalog.snapshotId}`,
    `Catalog origin: ${catalog.origin}${catalog.stale ? " (stale)" : ""}`,
    ...(catalog.warning ? [`Catalog warning: ${catalog.warning}`] : []),
  ].join("\n")
}

async function catalogRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ProviderCoreError && error.code === "PROVIDER_CATALOG_UNAVAILABLE") {
      throw new RalphError(
        "RALPH_PROVIDER_CATALOG_UNAVAILABLE",
        "The provider catalog is unavailable",
        {
          exitCode: EXIT_CODES.providerUnavailable,
          hint: "Retry later or use a previously cached catalog snapshot.",
          details: { providerError: error.code },
          cause: error,
        },
      )
    }
    throw error
  }
}

function providerNotFound(providerId: string): never {
  throw new RalphError("RALPH_PROVIDER_NOT_FOUND", `Provider was not found: ${providerId}`, {
    exitCode: EXIT_CODES.providerUnavailable,
    details: { provider: providerId },
  })
}

function ensureProviderAvailable(provider: ProviderInfo): void {
  if (provider.status === "unavailable") {
    throw new RalphError("RALPH_PROVIDER_UNAVAILABLE", `Provider is unavailable: ${provider.id}`, {
      exitCode: EXIT_CODES.providerUnavailable,
      details: { provider: provider.id, status: provider.status },
    })
  }
}

function ensureModelAvailable(model: ModelInfo): void {
  if (model.status === "unavailable") {
    throw new RalphError(
      "RALPH_MODEL_UNAVAILABLE",
      `Model is unavailable: ${model.provider}/${model.id}`,
      {
        exitCode: EXIT_CODES.providerUnavailable,
        details: { provider: model.provider, model: model.id, status: model.status },
      },
    )
  }
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  )
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd()
  return [
    line(headers),
    line(headers.map((header) => "-".repeat(header.length))),
    ...rows.map(line),
  ].join("\n")
}

function providerListHuman(providers: readonly ProviderInfo[]): string {
  if (providers.length === 0) return "No providers are available in the catalog."
  return table(
    ["ID", "STATUS", "ACCESS", "NAME"],
    providers.map((provider) => [
      provider.id,
      provider.status,
      provider.access.join(","),
      provider.name,
    ]),
  )
}

function providerInspectHuman(provider: ProviderInfo): string {
  const methods = provider.credentialMethods
    .map((method) => `${method.method} (${method.access.join(",")})`)
    .join(", ")
  return [
    `Provider: ${provider.name} (${provider.id})`,
    `Status: ${provider.status}`,
    `Access: ${provider.access.join(", ")}`,
    `Credentials: ${methods || "none"}`,
    `Catalog source: ${provider.catalogSource}`,
    `Catalog updated: ${provider.catalogUpdatedAt}`,
  ].join("\n")
}

function modelListHuman(models: readonly ModelInfo[]): string {
  if (models.length === 0) return "No models matched the catalog query."
  return table(
    ["PROVIDER", "MODEL", "STATUS", "CONTEXT", "OUTPUT", "ACCESS", "NAME"],
    models.map((model) => [
      model.provider,
      model.id,
      model.status,
      model.limits.context?.toString() ?? "unknown",
      model.limits.output?.toString() ?? "unknown",
      model.access.join(","),
      model.name,
    ]),
  )
}

function enabled(value: boolean): string {
  return value ? "yes" : "no"
}

function priceHuman(model: ModelInfo): readonly string[] {
  const price = model.price
  if (price.status === "unavailable") {
    return [
      `Pricing: unavailable (${price.reason})`,
      `Pricing source: ${price.source}`,
      `Pricing captured: ${price.capturedAt}`,
    ]
  }
  const amounts = [
    price.input === undefined ? undefined : `input=${price.input}`,
    price.output === undefined ? undefined : `output=${price.output}`,
    price.reasoning === undefined ? undefined : `reasoning=${price.reasoning}`,
    price.cacheRead === undefined ? undefined : `cache-read=${price.cacheRead}`,
    price.cacheWrite === undefined ? undefined : `cache-write=${price.cacheWrite}`,
  ].filter((entry): entry is string => entry !== undefined)
  return [
    `Pricing: ${price.currency} ${amounts.join(", ")} (${price.unit})`,
    `Pricing source: ${price.source}`,
    `Pricing captured: ${price.capturedAt}`,
  ]
}

function modelInspectHuman(model: ModelInfo): string {
  const variants = model.variants.map((variant) => variant.id).join(", ") || "none"
  return [
    `Model: ${model.name} (${model.provider}/${model.id})`,
    `Status: ${model.status}`,
    `Family: ${model.family ?? "unknown"}`,
    `Input: ${model.capabilities.input.join(", ")}`,
    `Access: ${model.access.join(", ")}`,
    `Tools: ${enabled(model.capabilities.tools)}`,
    `Tool streaming: ${enabled(model.capabilities.toolStreaming)}`,
    `Reasoning: ${enabled(model.capabilities.reasoning)}`,
    `Structured output: ${enabled(model.capabilities.structuredOutput)}`,
    `Usage: ${model.capabilities.usage.join(", ") || "unavailable"}`,
    `Context limit: ${model.limits.context ?? "unknown"}`,
    `Output limit: ${model.limits.output ?? "unknown"}`,
    `Variants: ${variants}`,
    ...priceHuman(model),
    `Catalog source: ${model.catalogSource}`,
    `Catalog updated: ${model.catalogUpdatedAt}`,
  ].join("\n")
}

export async function handleProvidersList(
  catalog: ModelCatalog,
  options: CatalogReadCommandOptions = {},
): Promise<CatalogHandlerResult<ProvidersListData>> {
  const resolution = await catalogResolution(catalog, options)
  const used = catalogUse(resolution)
  const providers = resolution.snapshot.providers
  const data = { count: providers.length, providers, catalog: used }
  return result("providers.list", data, `${providerListHuman(providers)}\n\n${catalogHuman(used)}`)
}

export async function handleProviderInspect(
  catalog: ModelCatalog,
  providerId: string,
  options: CatalogReadCommandOptions = {},
): Promise<CatalogHandlerResult<ProviderInspectData>> {
  const resolution = await catalogResolution(catalog, options)
  const used = catalogUse(resolution)
  const providers = resolution.snapshot.providers
  const provider = providers.find((candidate) => candidate.id === providerId)
  if (!provider) providerNotFound(providerId)
  ensureProviderAvailable(provider)
  return result(
    "providers.inspect",
    { provider, catalog: used },
    `${providerInspectHuman(provider)}\n${catalogHuman(used)}`,
  )
}

export async function handleModelsList(
  catalog: ModelCatalog,
  options: ModelsListOptions = {},
): Promise<CatalogHandlerResult<ModelsListData>> {
  const resolution = await catalogResolution(catalog, options)
  const used = catalogUse(resolution)
  const models = resolution.snapshot.models
    .filter((model) => options.provider === undefined || model.provider === options.provider)
    .filter((model) => options.includeDeprecated === true || model.status !== "deprecated")
    .filter(
      (model) =>
        options.requirements === undefined ||
        modelSatisfiesRequirements(model, options.requirements),
    )
  if (options.provider !== undefined) {
    const provider = resolution.snapshot.providers.find(
      (candidate) => candidate.id === options.provider,
    )
    if (!provider) providerNotFound(options.provider)
    ensureProviderAvailable(provider)
  }
  const data: ModelsListData = {
    count: models.length,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    models,
    catalog: used,
  }
  return result("models.list", data, `${modelListHuman(models)}\n\n${catalogHuman(used)}`)
}

export async function handleModelInspect(
  catalog: ModelCatalog,
  options: ModelInspectOptions,
): Promise<CatalogHandlerResult<ModelInspectData>> {
  const resolution = await catalogResolution(catalog, options)
  const used = catalogUse(resolution)
  const ref: ModelRef = {
    provider: options.provider,
    model: options.model,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
  }
  const model = resolution.snapshot.models.find(
    (candidate) =>
      candidate.provider === ref.provider &&
      candidate.id === ref.model &&
      (ref.variant === undefined ||
        candidate.variants.some((variant) => variant.id === ref.variant)),
  )
  const provider = resolution.snapshot.providers.find(
    (candidate) => candidate.id === options.provider,
  )
  if (!provider) providerNotFound(options.provider)
  ensureProviderAvailable(provider)
  if (!model) {
    throw new RalphError(
      "RALPH_MODEL_NOT_FOUND",
      `Model was not found: ${options.provider}/${options.model}`,
      {
        exitCode: EXIT_CODES.providerUnavailable,
        details: {
          provider: options.provider,
          model: options.model,
          ...(options.variant === undefined ? {} : { variant: options.variant }),
        },
      },
    )
  }
  ensureModelAvailable(model)
  const resolvedParameters = resolveModelParameters(model, {
    ...(options.variant ? { variant: options.variant } : {}),
  })
  return result(
    "models.inspect",
    {
      model,
      ...(options.variant ? { selectedVariant: options.variant } : {}),
      effectiveParameters: resolvedParameters.parameters,
      catalog: used,
    },
    `${modelInspectHuman(model)}${
      options.variant
        ? `\nSelected variant: ${options.variant}\nEffective parameters: ${JSON.stringify(
            resolvedParameters.parameters,
          )}`
        : ""
    }\n${catalogHuman(used)}`,
  )
}
