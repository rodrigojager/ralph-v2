import { describe, expect, test } from "bun:test"

import {
  CachedModelCatalog,
  type CatalogSeed,
  CURATED_CATALOG_SEED,
  createCuratedCatalogSource,
  InMemoryModelCatalogCache,
  type ModelCatalogSource,
  StaticCatalogSource,
} from "../src/index"

class CountingSource implements ModelCatalogSource {
  calls = 0
  failure: Error | undefined

  constructor(readonly seed: CatalogSeed) {}

  async load(): Promise<CatalogSeed> {
    this.calls += 1
    if (this.failure) {
      throw this.failure
    }
    return structuredClone(this.seed)
  }
}

describe("CachedModelCatalog", () => {
  test("uses a fresh cache and refreshes exactly at the TTL boundary", async () => {
    let now = new Date("2026-07-18T10:00:00.000Z")
    const source = new CountingSource(CURATED_CATALOG_SEED)
    const catalog = new CachedModelCatalog({
      source,
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 1_000,
      clock: () => now,
    })

    const first = await catalog.snapshot()
    expect(first.origin).toBe("source")
    expect(source.calls).toBe(1)

    now = new Date("2026-07-18T10:00:00.999Z")
    expect((await catalog.snapshot()).origin).toBe("cache")
    expect(source.calls).toBe(1)

    now = new Date("2026-07-18T10:00:01.000Z")
    expect((await catalog.snapshot()).origin).toBe("source")
    expect(source.calls).toBe(2)
  })

  test("returns a stale snapshot deterministically when refresh fails", async () => {
    let now = new Date("2026-07-18T10:00:00.000Z")
    const source = new CountingSource(CURATED_CATALOG_SEED)
    const catalog = new CachedModelCatalog({
      source,
      cache: new InMemoryModelCatalogCache(),
      fallbackSource: createCuratedCatalogSource(),
      ttlMs: 1_000,
      clock: () => now,
    })
    const first = await catalog.snapshot()
    source.failure = new Error("remote source offline")
    now = new Date("2026-07-18T10:00:02.000Z")

    const stale = await catalog.snapshot()
    expect(stale.origin).toBe("stale-cache")
    expect(stale.stale).toBe(true)
    expect(stale.snapshot.id).toBe(first.snapshot.id)
    expect(stale.warning).toContain("remote source offline")
  })

  test("uses the explicit fallback source when no valid cache exists", async () => {
    const failing: ModelCatalogSource = {
      async load() {
        throw new Error("remote unavailable")
      },
    }
    const catalog = new CachedModelCatalog({
      source: failing,
      cache: new InMemoryModelCatalogCache(),
      fallbackSource: createCuratedCatalogSource(),
      ttlMs: 60_000,
      clock: () => new Date("2026-07-18T10:00:00.000Z"),
    })

    const resolution = await catalog.snapshot()
    expect(resolution.origin).toBe("fallback")
    expect(resolution.stale).toBe(false)
    expect(resolution.snapshot.source.id).toBe("ralph-curated")
    expect(resolution.warning).toContain("remote unavailable")
  })

  test("rejects a syntactically valid but tampered cache snapshot", async () => {
    const original = new CachedModelCatalog({
      source: createCuratedCatalogSource(),
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 60_000,
      clock: () => new Date("2026-07-18T10:00:00.000Z"),
    })
    const valid = (await original.snapshot()).snapshot
    const tampered = structuredClone(valid)
    const firstProvider = tampered.providers[0]
    if (!firstProvider) {
      throw new Error("curated catalog must contain a provider")
    }
    firstProvider.name = "Tampered provider"
    const source = new CountingSource(CURATED_CATALOG_SEED)
    const catalog = new CachedModelCatalog({
      source,
      cache: {
        async read() {
          return tampered
        },
        async write() {},
      },
      ttlMs: 60_000,
      clock: () => new Date("2026-07-18T10:00:00.100Z"),
    })

    const refreshed = await catalog.snapshot()
    expect(refreshed.origin).toBe("source")
    expect(refreshed.warning).toContain("does not match its declared hash")
    expect(source.calls).toBe(1)
  })

  test("snapshot ids are stable for equivalent seeds regardless of input order", async () => {
    const reversed: CatalogSeed = {
      ...CURATED_CATALOG_SEED,
      providers: [...CURATED_CATALOG_SEED.providers].reverse(),
      models: [...CURATED_CATALOG_SEED.models].reverse(),
    }
    const options = {
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 60_000,
      clock: () => new Date("2026-07-18T10:00:00.000Z"),
    }
    const orderedCatalog = new CachedModelCatalog({
      ...options,
      source: new StaticCatalogSource(CURATED_CATALOG_SEED),
    })
    const reversedCatalog = new CachedModelCatalog({
      ...options,
      cache: new InMemoryModelCatalogCache(),
      source: new StaticCatalogSource(reversed),
    })

    const ordered = await orderedCatalog.snapshot()
    const unordered = await reversedCatalog.snapshot()
    expect(ordered.snapshot.id).toBe(unordered.snapshot.id)
    expect(ordered.snapshot.contentHash).toBe(unordered.snapshot.contentHash)
  })

  test("filters by normalized requirements and inspects variants exactly", async () => {
    const catalog = new CachedModelCatalog({
      source: createCuratedCatalogSource(),
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 60_000,
      clock: () => new Date("2026-07-18T10:00:00.000Z"),
    })

    const matches = await catalog.models({
      provider: "openai",
      requirements: {
        input: ["file"],
        tools: true,
        toolStreaming: false,
        reasoning: true,
        structuredOutput: true,
        usage: ["reasoning", "cost"],
        access: ["subscription"],
        minimumContext: 400_000,
      },
    })
    expect(matches.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.5"])
    await expect(
      catalog.inspect({ provider: "openai", model: "gpt-5.4", variant: "high" }),
    ).resolves.toMatchObject({ id: "gpt-5.4" })
    await expect(
      catalog.inspect({ provider: "openai", model: "gpt-5.4", variant: "unknown" }),
    ).resolves.toBeUndefined()
  })
})
