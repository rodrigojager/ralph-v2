import { afterEach, describe, expect, test } from "bun:test"
import { lstat, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CURATED_CATALOG_SEED } from "../src/curated"
import { createModelCatalogRuntime } from "../src/runtime"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

describe("model catalog runtime", () => {
  test("is lazy, persists the curated fallback and honors TTL and forced refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-v2-catalog-runtime-"))
    temporaryDirectories.push(root)
    const cachePath = join(root, "nested", "models.snapshot.json")
    let now = new Date("2026-07-18T10:00:00.000Z")
    let fetchCalls = 0
    const catalog = createModelCatalogRuntime({
      cachePath,
      ttlMs: 1_000,
      clock: () => now,
      fetch: async () => {
        fetchCalls += 1
        throw new Error("remote catalog offline")
      },
    })

    expect(fetchCalls).toBe(0)
    await expect(lstat(cachePath)).rejects.toMatchObject({ code: "ENOENT" })

    const first = await catalog.models()
    expect(first).toHaveLength(CURATED_CATALOG_SEED.models.length)
    expect(fetchCalls).toBe(1)
    await expect(lstat(cachePath)).resolves.toMatchObject({ size: expect.any(Number) })

    now = new Date("2026-07-18T10:00:00.999Z")
    await catalog.models()
    expect(fetchCalls).toBe(1)

    await expect(
      catalog.inspect({ provider: "openai", model: "gpt-5.3-codex" }, { forceRefresh: true }),
    ).resolves.toMatchObject({ id: "gpt-5.3-codex" })
    expect(fetchCalls).toBe(2)

    now = new Date("2026-07-18T10:00:01.000Z")
    await catalog.models()
    expect(fetchCalls).toBe(3)
  })
})
