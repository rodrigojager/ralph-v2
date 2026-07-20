import { describe, expect, test } from "bun:test"
import { ScriptedProviderDriver } from "@ralph-next/test-kit"

import { ProviderCoreError } from "../src/errors"
import { LazyProviderRegistry } from "../src/registry"

const fakeProviderDriver = (id = "openai"): ScriptedProviderDriver =>
  new ScriptedProviderDriver([], { id })

describe("LazyProviderRegistry", () => {
  test("registration is lazy and concurrent resolution loads exactly once", async () => {
    const registry = new LazyProviderRegistry()
    let loads = 0
    registry.register("openai", async () => {
      loads += 1
      await Promise.resolve()
      return fakeProviderDriver()
    })

    expect(loads).toBe(0)
    expect(registry.ids()).toEqual(["openai"])
    const [first, second, third] = await Promise.all([
      registry.require("openai"),
      registry.require("openai"),
      registry.require("openai"),
    ])

    expect(loads).toBe(1)
    expect(first).toBe(second)
    expect(second).toBe(third)
  })

  test("a failed lazy load is evicted and can be retried", async () => {
    const registry = new LazyProviderRegistry()
    let loads = 0
    registry.register("openai", () => {
      loads += 1
      if (loads === 1) {
        throw new Error("temporary loader failure")
      }
      return fakeProviderDriver()
    })

    await expect(registry.require("openai")).rejects.toThrow("temporary loader failure")
    await expect(registry.require("openai")).resolves.toMatchObject({ id: "openai" })
    expect(loads).toBe(2)
  })

  test("duplicate ids and mismatched driver ids are rejected deterministically", async () => {
    const duplicate = new LazyProviderRegistry()
    duplicate.register("openai", () => fakeProviderDriver())
    expect(() => duplicate.register("openai", () => fakeProviderDriver())).toThrow(
      "already registered",
    )

    const mismatch = new LazyProviderRegistry()
    mismatch.register("openai", () => fakeProviderDriver("anthropic"))
    try {
      await mismatch.require("openai")
      throw new Error("expected mismatch to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCoreError)
      expect((error as ProviderCoreError).code).toBe("PROVIDER_DRIVER_ID_MISMATCH")
    }
  })

  test("unknown providers resolve optionally or fail through require", async () => {
    const registry = new LazyProviderRegistry()
    await expect(registry.resolve("missing")).resolves.toBeUndefined()
    await expect(registry.require("missing")).rejects.toMatchObject({
      code: "PROVIDER_NOT_REGISTERED",
    })
  })
})
