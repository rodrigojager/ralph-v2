import { describe, expect, test } from "bun:test"

import {
  CachedModelCatalog,
  CatalogModelRouter,
  createCuratedCatalogSource,
  InMemoryModelCatalogCache,
  type ModelCatalogSnapshot,
  ProviderCoreError,
  type RoleProfile,
} from "../src/index"
import { NO_REQUIREMENTS, roleProfile } from "./fixtures"

async function curatedSnapshot(): Promise<ModelCatalogSnapshot> {
  const catalog = new CachedModelCatalog({
    source: createCuratedCatalogSource(),
    cache: new InMemoryModelCatalogCache(),
    ttlMs: 60_000,
    clock: () => new Date("2026-07-18T10:00:00.000Z"),
  })
  return (await catalog.snapshot()).snapshot
}

function profiles(...entries: readonly RoleProfile[]): Readonly<Record<string, RoleProfile>> {
  return Object.fromEntries(entries.map((entry) => [entry.id, entry]))
}

describe("CatalogModelRouter", () => {
  test("selects the requested profile and records the catalog snapshot", async () => {
    const snapshot = await curatedSnapshot()
    const main = roleProfile({
      id: "executor-main",
      provider: "openai",
      model: "gpt-5.3-codex",
      variant: "medium",
    })
    const route = new CatalogModelRouter().resolve({
      requestedProfileId: main.id,
      profiles: profiles(main),
      snapshot,
      fallbackPolicy: { allowedFailures: [] },
    })

    expect(route.selectedProfileId).toBe("executor-main")
    expect(route.fallback).toBe(false)
    expect(route.catalogSnapshotId).toBe(snapshot.id)
    expect(route.attemptedProfiles).toEqual(["executor-main"])
  })

  test("uses fallback profiles only for explicitly allowed eligible failures", async () => {
    const snapshot = await curatedSnapshot()
    const main = roleProfile({
      id: "executor-main",
      provider: "openai",
      model: "gpt-5.3-codex",
      fallbackProfiles: ["missing-model", "executor-backup"],
    })
    const missing = roleProfile({
      id: "missing-model",
      provider: "openai",
      model: "not-in-catalog",
    })
    const backup = roleProfile({
      id: "executor-backup",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    })
    const router = new CatalogModelRouter()

    expect(() =>
      router.resolve({
        requestedProfileId: main.id,
        profiles: profiles(main, missing, backup),
        snapshot,
        failure: "rate-limit",
        fallbackPolicy: { allowedFailures: [] },
      }),
    ).toThrow("Fallback is not allowed")

    const route = router.resolve({
      requestedProfileId: main.id,
      profiles: profiles(main, missing, backup),
      snapshot,
      attemptedProfiles: [main.id],
      failure: "rate-limit",
      fallbackPolicy: { allowedFailures: ["rate-limit"] },
    })
    expect(route.selectedProfileId).toBe("executor-backup")
    expect(route.fallback).toBe(true)
    expect(route.attemptedProfiles).toEqual(["executor-main", "executor-backup"])
  })

  test("hard failures never trigger fallback even if misconfigured as allowed", async () => {
    const snapshot = await curatedSnapshot()
    const main = roleProfile({
      id: "judge-main",
      role: "judge",
      provider: "openai",
      model: "gpt-5.4-mini",
      fallbackProfiles: ["judge-backup"],
    })
    const backup = roleProfile({
      id: "judge-backup",
      role: "judge",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    })

    try {
      new CatalogModelRouter().resolve({
        requestedProfileId: main.id,
        profiles: profiles(main, backup),
        snapshot,
        failure: "authentication",
        fallbackPolicy: { allowedFailures: ["authentication"] },
      })
      throw new Error("expected routing to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCoreError)
      expect((error as ProviderCoreError).code).toBe("PROVIDER_FALLBACK_NOT_ALLOWED")
    }
  })

  test("requirement and role mismatches are configuration errors, not silent fallback", async () => {
    const snapshot = await curatedSnapshot()
    const incompatible = roleProfile({
      id: "executor-main",
      provider: "openai",
      model: "gpt-5.3-codex",
      requirements: { ...NO_REQUIREMENTS, minimumContext: 2_000_000 },
    })
    expect(() =>
      new CatalogModelRouter().resolve({
        requestedProfileId: incompatible.id,
        profiles: profiles(incompatible),
        snapshot,
        fallbackPolicy: { allowedFailures: [] },
      }),
    ).toThrow("does not satisfy")

    const main = roleProfile({
      id: "executor-primary",
      provider: "openai",
      model: "gpt-5.3-codex",
      fallbackProfiles: ["judge-backup"],
    })
    const wrongRole = roleProfile({
      id: "judge-backup",
      role: "judge",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    })
    expect(() =>
      new CatalogModelRouter().resolve({
        requestedProfileId: main.id,
        profiles: profiles(main, wrongRole),
        snapshot,
        failure: "transient",
        fallbackPolicy: { allowedFailures: ["transient"] },
      }),
    ).toThrow("does not match role")
  })
})
