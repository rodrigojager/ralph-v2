import { describe, expect, test } from "bun:test"
import {
  AuthMethodSchema as ProviderAuthMethodSchema,
  CredentialConnectRequestSchema as ProviderCredentialConnectRequestSchema,
  CredentialRefSchema as ProviderCredentialRefSchema,
  CredentialStatusSchema as ProviderCredentialStatusSchema,
} from "../../providers/src/contracts"
import {
  AuthMethodSchema,
  CredentialConnectRequestSchema,
  CredentialRefSchema,
  CredentialStatusSchema,
  EnvironmentSecretStore,
  FakeSecretStore,
  REDACTED_SECRET,
  readSecretStream,
  secretInputFromValue,
} from "../src/index"

const validRef = {
  id: "cred-123",
  provider: "openai",
  method: "api-key",
  store: "os-keychain",
  locator: "openai:cred-123",
  label: "primary",
} as const

describe("temporary credential contracts", () => {
  test("remain runtime-compatible with the provider contracts", () => {
    expect(AuthMethodSchema.options).toEqual(ProviderAuthMethodSchema.options)
    expect(CredentialStatusSchema.options).toEqual(ProviderCredentialStatusSchema.options)
    expect(CredentialRefSchema.parse(validRef)).toEqual(ProviderCredentialRefSchema.parse(validRef))
    const connectRequest = {
      id: "explicit-credential",
      provider: "openai",
      method: "api-key",
      nonInteractive: true,
    } as const
    expect(CredentialConnectRequestSchema.parse(connectRequest)).toEqual(
      ProviderCredentialConnectRequestSchema.parse(connectRequest),
    )

    const extra = { ...validRef, secret: "must-never-be-schema-data" }
    expect(CredentialRefSchema.safeParse(extra).success).toBe(false)
    expect(ProviderCredentialRefSchema.safeParse(extra).success).toBe(false)
  })
})

describe("secret input", () => {
  test("is consumed once and never serializes its value", async () => {
    const input = secretInputFromValue("secret-canary-input")
    expect(JSON.stringify({ input })).toBe(`{"input":"${REDACTED_SECRET}"}`)
    expect(String(input)).toBe(REDACTED_SECRET)
    expect(await input.readOnce()).toBe("secret-canary-input")
    await expect(input.readOnce()).rejects.toThrow("already been consumed")
  })

  test("reads bounded stdin without accepting an argv value", async () => {
    const stream = new Blob(["stream-secret\r\n"]).stream()
    const input = await readSecretStream(stream, { maxBytes: 32 })
    expect(await input.readOnce()).toBe("stream-secret")

    await expect(
      readSecretStream(new Blob(["too-large"]).stream(), { maxBytes: 3 }),
    ).rejects.toThrow("exceeds")
  })
})

describe("secret stores", () => {
  test("fake store is deterministic and fails closed when unavailable", async () => {
    const store = new FakeSecretStore()
    await store.put("provider:credential", "fake-secret")
    expect(await store.has("provider:credential")).toBe(true)
    expect(await store.get("provider:credential")).toBe("fake-secret")
    await store.delete("provider:credential")
    expect(await store.get("provider:credential")).toBeUndefined()

    store.available = false
    expect((await store.probe()).available).toBe(false)
    await expect(store.put("provider:other", "secret")).rejects.toThrow("unavailable")
  })

  test("environment store keeps only the variable reference", async () => {
    const environment = { OPENAI_API_KEY: "environment-secret-canary" }
    const store = new EnvironmentSecretStore(environment)
    expect(await store.has("OPENAI_API_KEY")).toBe(true)
    expect(await store.get("OPENAI_API_KEY")).toBe("environment-secret-canary")
    await expect(store.put("OPENAI_API_KEY", "other")).rejects.toThrow("read-only")
    await expect(store.get("bad-name")).rejects.toThrow("Invalid environment")

    await store.delete("OPENAI_API_KEY")
    expect(environment.OPENAI_API_KEY).toBe("environment-secret-canary")
  })
})
