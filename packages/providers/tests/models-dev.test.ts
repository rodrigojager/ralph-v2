import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CachedModelCatalog,
  CURATED_CATALOG_SEED,
  createCuratedCatalogSource,
  FileModelCatalogCache,
  ModelsDevCatalogSource,
} from "../src/index"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

function modelsDevPayload(): Record<string, unknown> {
  const providers: Record<string, { id: string; name: string; models: Record<string, unknown> }> =
    {}
  for (const provider of CURATED_CATALOG_SEED.providers) {
    providers[provider.id] = { id: provider.id, name: provider.name, models: {} }
  }
  for (const model of CURATED_CATALOG_SEED.models) {
    const provider = providers[model.provider]
    if (!provider) throw new Error(`Missing provider fixture: ${model.provider}`)
    provider.models[model.id] = {
      id: model.id,
      name: model.name,
      family: model.family,
      attachment: model.capabilities.input.includes("file"),
      reasoning: model.capabilities.reasoning,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      tool_call: model.capabilities.tools,
      structured_output: model.capabilities.structuredOutput,
      modalities: {
        input: model.capabilities.input.map((input) => (input === "file" ? "pdf" : input)),
        output: ["text"],
      },
      limit: model.limits,
      cost:
        model.price.status === "available"
          ? {
              input: model.price.input,
              output: model.price.output,
              cache_read: model.price.cacheRead,
              cache_write: model.price.cacheWrite,
            }
          : {},
    }
  }
  return providers
}

describe("models.dev source and file cache", () => {
  test("normalizes the selected remote snapshot into Ralph-owned metadata", async () => {
    const body = JSON.stringify(modelsDevPayload())
    let request: { input: string; init?: RequestInit } | undefined
    const source = new ModelsDevCatalogSource({
      fetch: async (input, init) => {
        request = { input: String(input), ...(init ? { init } : {}) }
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
      },
      clock: () => new Date("2026-07-18T12:34:56.000Z"),
    })

    const seed = await source.load()
    expect(request?.input).toBe("https://models.dev/api.json")
    expect(request?.init?.method).toBe("GET")
    expect(seed.source).toMatchObject({ id: "models-dev", kind: "remote" })
    expect(seed.source.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(seed.providers).toHaveLength(3)
    expect(seed.models).toHaveLength(9)
    expect(
      seed.models.find((model) => model.provider === "openai" && model.id === "gpt-5.4"),
    ).toMatchObject({
      capabilities: { input: ["text", "image", "file"], tools: true },
      limits: { context: 1_050_000, output: 128_000 },
      access: ["api", "subscription"],
      catalogUpdatedAt: "2026-07-18T12:34:56.000Z",
    })
  })

  test("fails closed when the curated remote shape drifts or the response is oversized", async () => {
    const payload = modelsDevPayload()
    const openai = payload.openai as { models: Record<string, unknown> }
    delete openai.models["gpt-5.4"]
    const missing = new ModelsDevCatalogSource({
      fetch: async () => new Response(JSON.stringify(payload)),
    })
    await expect(missing.load()).rejects.toMatchObject({ code: "MODELS_DEV_SCHEMA_INVALID" })

    const oversized = new ModelsDevCatalogSource({
      fetch: async () => new Response("{}", { headers: { "content-length": "100" } }),
      maximumBytes: 10,
    })
    await expect(oversized.load()).rejects.toMatchObject({
      code: "MODELS_DEV_RESPONSE_TOO_LARGE",
    })

    const streamedOversized = new ModelsDevCatalogSource({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("123456"))
              controller.enqueue(new TextEncoder().encode("789012"))
              controller.close()
            },
          }),
        ),
      maximumBytes: 10,
    })
    await expect(streamedOversized.load()).rejects.toMatchObject({
      code: "MODELS_DEV_RESPONSE_TOO_LARGE",
    })
  })

  test("times out even when the injected fetch ignores abort", async () => {
    const source = new ModelsDevCatalogSource({
      fetch: () => new Promise<Response>(() => undefined),
      timeoutMs: 10,
    })
    const startedAt = Date.now()
    await expect(source.load()).rejects.toMatchObject({ code: "MODELS_DEV_TIMEOUT" })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  test("rejects remote display text containing terminal controls", async () => {
    const payload = modelsDevPayload()
    const openai = payload.openai as { name: string }
    openai.name = `OpenAI${String.fromCharCode(27)}[31m`
    const source = new ModelsDevCatalogSource({
      fetch: async () => new Response(JSON.stringify(payload)),
    })

    await expect(source.load()).rejects.toThrow("terminal control")
  })

  test("persists a content-addressed snapshot and reuses it across catalog instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-v2-model-cache-"))
    temporaryDirectories.push(root)
    const path = join(root, "nested", "models.snapshot.json")
    const cache = new FileModelCatalogCache({ path })
    const first = new CachedModelCatalog({
      source: createCuratedCatalogSource(),
      cache,
      ttlMs: 60_000,
      clock: () => new Date("2026-07-18T10:00:00.000Z"),
    })
    const written = await first.snapshot()
    expect(written.origin).toBe("source")

    const neverCalled = {
      async load(): Promise<never> {
        throw new Error("fresh file cache should have won")
      },
    }
    const second = new CachedModelCatalog({
      source: neverCalled,
      cache: new FileModelCatalogCache({ path }),
      ttlMs: 60_000,
      clock: () => new Date("2026-07-18T10:00:01.000Z"),
    })
    const reused = await second.snapshot()
    expect(reused.origin).toBe("cache")
    expect(reused.snapshot.id).toBe(written.snapshot.id)
  })
})
