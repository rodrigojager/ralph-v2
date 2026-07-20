import { describe, expect, test } from "bun:test"

import { EXIT_CODES, RalphError } from "../../domain/src/index"
import {
  CachedModelCatalog,
  type CatalogResolution,
  CURATED_CATALOG_SEED,
  InMemoryModelCatalogCache,
  type ModelCatalog,
  type ModelCatalogQuery,
  type ModelCatalogReadOptions,
  type ModelInfo,
  type ModelRef,
  ProviderCoreError,
  type ProviderInfo,
  StaticCatalogSource,
} from "../../providers/src/index"
import {
  handleModelInspect,
  handleModelsList,
  handleProviderInspect,
  handleProvidersList,
} from "../src/catalog-handlers"

class RecordingCatalog implements ModelCatalog {
  snapshotReads: ModelCatalogReadOptions[] = []
  providerReads: ModelCatalogReadOptions[] = []
  modelReads: Array<{ query: ModelCatalogQuery; options: ModelCatalogReadOptions }> = []
  inspectReads: Array<{ ref: ModelRef; options: ModelCatalogReadOptions }> = []

  readonly #snapshots: CachedModelCatalog

  constructor(
    readonly providerValues: readonly ProviderInfo[] = CURATED_CATALOG_SEED.providers,
    readonly modelValues: readonly ModelInfo[] = CURATED_CATALOG_SEED.models,
  ) {
    this.#snapshots = new CachedModelCatalog({
      source: new StaticCatalogSource({
        source: CURATED_CATALOG_SEED.source,
        providers: [...providerValues],
        models: [...modelValues],
      }),
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 60_000,
      clock: () => new Date("2026-07-18T12:00:00.000Z"),
    })
  }

  async snapshot(options: ModelCatalogReadOptions = {}): Promise<CatalogResolution> {
    this.snapshotReads.push(options)
    return this.#snapshots.snapshot(options)
  }

  async providers(options: ModelCatalogReadOptions = {}): Promise<readonly ProviderInfo[]> {
    this.providerReads.push(options)
    return this.providerValues
  }

  async models(
    query: ModelCatalogQuery = {},
    options: ModelCatalogReadOptions = {},
  ): Promise<readonly ModelInfo[]> {
    this.modelReads.push({ query, options })
    return this.modelValues
      .filter((model) => query.provider === undefined || model.provider === query.provider)
      .filter((model) => query.includeDeprecated === true || model.status !== "deprecated")
  }

  async inspect(
    ref: ModelRef,
    options: ModelCatalogReadOptions = {},
  ): Promise<ModelInfo | undefined> {
    this.inspectReads.push({ ref, options })
    const model = this.modelValues.find(
      (candidate) => candidate.provider === ref.provider && candidate.id === ref.model,
    )
    if (!model) return undefined
    if (ref.variant && !model.variants.some((variant) => variant.id === ref.variant)) {
      return undefined
    }
    return model
  }
}

describe("catalog command handlers", () => {
  test("renders provider list and inspect as human text plus CommandResult data", async () => {
    const catalog = new RecordingCatalog()
    const listed = await handleProvidersList(catalog, { refresh: true })
    expect(listed.result).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "providers.list",
      data: { count: 3 },
      diagnostics: [],
    })
    expect(listed.human).toContain("ID")
    expect(listed.human).toContain("openai")
    expect(catalog.snapshotReads[0]).toEqual({ forceRefresh: true })
    expect(listed.result.data?.catalog.snapshotId).toStartWith("catalog:")
    expect(catalog.providerReads).toEqual([])

    const inspected = await handleProviderInspect(catalog, "openai")
    expect(inspected.result.data?.provider.id).toBe("openai")
    expect(inspected.human).toContain("Provider: OpenAI (openai)")
    expect(inspected.human).toContain("Catalog source:")
  })

  test("forces one snapshot refresh and reports the exact catalog used", async () => {
    const catalog = new RecordingCatalog()
    const listed = await handleModelsList(catalog, { provider: "openai", refresh: true })
    expect(listed.result.command).toBe("models.list")
    expect(listed.result.data?.models).toHaveLength(
      CURATED_CATALOG_SEED.models.filter((model) => model.provider === "openai").length,
    )
    expect(listed.human).toContain("gpt-5.3-codex")
    expect(catalog.snapshotReads[0]).toEqual({ forceRefresh: true })
    expect(catalog.modelReads).toEqual([])

    const inspected = await handleModelInspect(catalog, {
      provider: "openai",
      model: "gpt-5.3-codex",
      variant: "high",
      refresh: true,
    })
    expect(inspected.result.data?.model.id).toBe("gpt-5.3-codex")
    expect(inspected.result.data).toMatchObject({
      selectedVariant: "high",
      effectiveParameters: { reasoning_effort: "high" },
    })
    expect(inspected.human).toContain("Structured output: yes")
    expect(inspected.human).toContain("Pricing source: https://models.dev/api.json")
    expect(inspected.human).toContain('Effective parameters: {"reasoning_effort":"high"}')
    expect(catalog.snapshotReads[1]).toEqual({ forceRefresh: true })
    expect(catalog.inspectReads).toEqual([])
  })

  test("derives every payload from the one catalog snapshot named in the response", async () => {
    const stable = new RecordingCatalog()
    const pinned = await stable.snapshot()
    let secondaryReads = 0
    const drifting: ModelCatalog = {
      snapshot: async () => pinned,
      providers: async () => {
        secondaryReads += 1
        return []
      },
      models: async () => {
        secondaryReads += 1
        return []
      },
      inspect: async () => {
        secondaryReads += 1
        return undefined
      },
    }

    const providers = await handleProvidersList(drifting)
    const models = await handleModelsList(drifting, { provider: "openai" })
    const inspected = await handleModelInspect(drifting, {
      provider: "openai",
      model: "gpt-5.3-codex",
    })

    expect(providers.result.data?.catalog.snapshotId).toBe(pinned.snapshot.id)
    expect(providers.result.data?.providers).toEqual(pinned.snapshot.providers)
    expect(models.result.data?.catalog.snapshotId).toBe(pinned.snapshot.id)
    expect(models.result.data?.models).toEqual(
      pinned.snapshot.models.filter(
        (model) => model.provider === "openai" && model.status !== "deprecated",
      ),
    )
    expect(inspected.result.data?.catalog.snapshotId).toBe(pinned.snapshot.id)
    expect(inspected.result.data?.model.id).toBe("gpt-5.3-codex")
    expect(secondaryReads).toBe(0)
  })

  test("maps missing and unavailable catalog entries to exit code 6", async () => {
    await expect(handleProviderInspect(new RecordingCatalog(), "missing")).rejects.toMatchObject({
      code: "RALPH_PROVIDER_NOT_FOUND",
      exitCode: EXIT_CODES.providerUnavailable,
    })
    await expect(
      handleModelInspect(new RecordingCatalog(), {
        provider: "openai",
        model: "missing",
      }),
    ).rejects.toMatchObject({
      code: "RALPH_MODEL_NOT_FOUND",
      exitCode: EXIT_CODES.providerUnavailable,
    })

    const unavailable = CURATED_CATALOG_SEED.providers.map((provider) =>
      provider.id === "openai" ? { ...provider, status: "unavailable" as const } : provider,
    )
    await expect(
      handleModelsList(new RecordingCatalog(unavailable), { provider: "openai" }),
    ).rejects.toMatchObject({
      code: "RALPH_PROVIDER_UNAVAILABLE",
      exitCode: EXIT_CODES.providerUnavailable,
    })
  })

  test("maps a terminal catalog outage to a typed provider-unavailable error", async () => {
    const catalog = new RecordingCatalog()
    catalog.snapshot = async () => {
      throw new ProviderCoreError("PROVIDER_CATALOG_UNAVAILABLE", "all sources failed")
    }

    try {
      await handleProvidersList(catalog)
      throw new Error("expected catalog outage")
    } catch (error) {
      expect(error).toBeInstanceOf(RalphError)
      expect(error).toMatchObject({
        code: "RALPH_PROVIDER_CATALOG_UNAVAILABLE",
        exitCode: EXIT_CODES.providerUnavailable,
      })
    }
  })
})
