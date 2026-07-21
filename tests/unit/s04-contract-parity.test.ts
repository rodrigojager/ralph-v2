import { describe, expect, test } from "bun:test"
import {
  CredentialConnectRequestSchema as CredentialConnectRequestSchemaAuth,
  CredentialMethodInfoSchema as CredentialMethodInfoSchemaAuth,
  CredentialRefSchema as CredentialRefSchemaAuth,
} from "@ralph/credentials"
import { ProfileParametersSchema } from "@ralph/domain"
import {
  CredentialConnectRequestSchema as CredentialConnectRequestSchemaProvider,
  CredentialMethodInfoSchema as CredentialMethodInfoSchemaProvider,
  CredentialRefSchema as CredentialRefSchemaProvider,
  ModelParametersSchema,
} from "@ralph/providers"
import type { ZodType } from "zod"

function outcome(schema: ZodType, value: unknown): { success: boolean; data?: unknown } {
  const result = schema.safeParse(value)
  return result.success ? { success: true, data: result.data } : { success: false }
}

function expectParity(left: ZodType, right: ZodType, corpus: readonly unknown[]): void {
  for (const value of corpus) expect(outcome(left, value)).toEqual(outcome(right, value))
}

const VALID_CREDENTIAL = {
  id: "executor-key",
  provider: "openai",
  method: "api-key",
  store: "os-keychain",
  locator: "openai:credential-1",
  label: " OpenAI executor ",
  accountHint: "account@example.test",
  expiresAt: "2026-07-18T16:00:00.000Z",
} as const

describe("S04 duplicated contract parity", () => {
  test("keeps persisted profile parameters identical to provider model parameters", () => {
    const corpus: unknown[] = [
      {},
      { reasoning_effort: "high", temperature: 0, enabled: true, optional: null },
      { ["x".repeat(128)]: "allowed" },
      { "": "empty-name" },
      { "two words": "whitespace" },
      { ["x".repeat(129)]: "too-long" },
      JSON.parse('{"__proto__":"reserved"}'),
      { constructor: "reserved" },
      { prototype: "reserved" },
      { "escape\u001bname": "unsafe" },
      { c1: "unsafe\u009bvalue" },
      { newline: "unsafe\nvalue" },
      { infinity: Number.POSITIVE_INFINITY },
      { nan: Number.NaN },
      { object: { nested: true } },
      { array: ["not", "primitive"] },
      { missing: undefined },
    ]
    expectParity(ProfileParametersSchema, ModelParametersSchema, corpus)
    for (const unsafe of corpus.slice(3)) {
      expect(ProfileParametersSchema.safeParse(unsafe).success).toBe(false)
      expect(ModelParametersSchema.safeParse(unsafe).success).toBe(false)
    }
  })

  test("keeps credential references identical across auth and provider boundaries", () => {
    const corpus: unknown[] = [
      VALID_CREDENTIAL,
      { ...VALID_CREDENTIAL, accountHint: undefined, expiresAt: undefined },
      { ...VALID_CREDENTIAL, id: "Not-A-Slug" },
      { ...VALID_CREDENTIAL, provider: "open ai" },
      { ...VALID_CREDENTIAL, method: "password" },
      { ...VALID_CREDENTIAL, store: "plaintext" },
      { ...VALID_CREDENTIAL, locator: "\u001b[31munsafe" },
      { ...VALID_CREDENTIAL, label: "ok\u001b[31mBAD" },
      { ...VALID_CREDENTIAL, accountHint: "unsafe\u009bcontrol" },
      { ...VALID_CREDENTIAL, expiresAt: "not-a-timestamp" },
      { ...VALID_CREDENTIAL, secret: "forbidden" },
    ]
    expectParity(CredentialRefSchemaAuth, CredentialRefSchemaProvider, corpus)
    for (const unsafe of corpus.slice(2)) {
      expect(CredentialRefSchemaAuth.safeParse(unsafe).success).toBe(false)
      expect(CredentialRefSchemaProvider.safeParse(unsafe).success).toBe(false)
    }
  })

  test("keeps credential method metadata and connect inputs identical", () => {
    const methodCorpus: unknown[] = [
      { method: "api-key", label: "API key", access: ["api"], interactive: true },
      { method: "device-code", label: "ChatGPT", access: ["subscription"], interactive: true },
      { method: "api-key", label: "unsafe\u001b", access: ["api"], interactive: true },
      { method: "api-key", label: "duplicate", access: ["api", "api"], interactive: true },
      { method: "unknown", label: "bad", access: ["api"], interactive: false },
      { method: "api-key", label: "bad", access: [], interactive: false },
      { method: "api-key", label: "bad", access: ["other"], interactive: false },
      { method: "api-key", label: "bad", access: ["api"], interactive: false, extra: true },
    ]
    expectParity(CredentialMethodInfoSchemaAuth, CredentialMethodInfoSchemaProvider, methodCorpus)

    const connectCorpus: unknown[] = [
      {
        id: "executor-key",
        provider: "openai",
        method: "api-key",
        label: "Executor",
        nonInteractive: true,
      },
      { provider: "openai", method: "environment", nonInteractive: true },
      {
        provider: "openai",
        method: "api-key",
        label: "unsafe\u001b",
        nonInteractive: true,
      },
      { provider: "open ai", method: "api-key", nonInteractive: true },
      { provider: "openai", method: "password", nonInteractive: true },
      { provider: "openai", method: "api-key", nonInteractive: "yes" },
      { provider: "openai", method: "api-key", nonInteractive: true, secret: "forbidden" },
    ]
    expectParity(
      CredentialConnectRequestSchemaAuth,
      CredentialConnectRequestSchemaProvider,
      connectCorpus,
    )
  })
})
