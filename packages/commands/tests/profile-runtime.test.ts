import { describe, expect, test } from "bun:test"

import { RalphError, type RoleProfileConfig, RoleProfileConfigSchema } from "../../domain/src/index"
import {
  CachedModelCatalog,
  type CredentialRef,
  CredentialRefSchema,
  CURATED_CATALOG_SEED,
  InMemoryModelCatalogCache,
  type ModelCatalogSnapshot,
  StaticCatalogSource,
} from "../../providers/src/index"
import { resolveRuntimeProfileCandidate, resolveRuntimeProfiles } from "../src/profile-runtime"

function profile(
  input: Pick<RoleProfileConfig, "role" | "provider" | "model"> &
    Partial<Omit<RoleProfileConfig, "role" | "provider" | "model">>,
): RoleProfileConfig {
  return RoleProfileConfigSchema.parse({
    backend: "embedded",
    parameters: {},
    requirements: {},
    fallback_profiles: [],
    fallback_on: [],
    limits: {},
    ...input,
  })
}

function credential(
  input: Pick<CredentialRef, "id" | "provider" | "method" | "store" | "locator">,
): CredentialRef {
  return CredentialRefSchema.parse({
    label: `${input.id} label`,
    ...input,
  })
}

async function snapshot(
  options: {
    providerStatus?: { id: string; status: "unavailable" | "deprecated" }
    modelStatus?: { provider: string; id: string; status: "unavailable" | "deprecated" }
  } = {},
): Promise<ModelCatalogSnapshot> {
  const providers = CURATED_CATALOG_SEED.providers.map((provider) =>
    provider.id === options.providerStatus?.id
      ? { ...provider, status: options.providerStatus.status }
      : provider,
  )
  const models = CURATED_CATALOG_SEED.models.map((model) =>
    model.provider === options.modelStatus?.provider && model.id === options.modelStatus.id
      ? { ...model, status: options.modelStatus.status }
      : model,
  )
  const catalog = new CachedModelCatalog({
    source: new StaticCatalogSource({ source: CURATED_CATALOG_SEED.source, providers, models }),
    cache: new InMemoryModelCatalogCache(),
    ttlMs: 60_000,
    clock: () => new Date("2026-07-18T15:00:00.000Z"),
  })
  return (await catalog.snapshot()).snapshot
}

function thrown(action: () => unknown): RalphError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(RalphError)
    return error as RalphError
  }
  throw new Error("expected action to throw")
}

describe("resolveRuntimeProfiles", () => {
  test("materializes independent executor and judge profiles against one fixed snapshot", async () => {
    const catalog = await snapshot()
    const executorCredential = credential({
      id: "openai-executor",
      provider: "openai",
      method: "api-key",
      store: "os-keychain",
      locator: "ralph/openai-executor",
    })
    const judgeCredential = credential({
      id: "anthropic-judge",
      provider: "anthropic",
      method: "environment",
      store: "environment",
      locator: "ANTHROPIC_JUDGE_API_KEY",
    })
    const configs = {
      "executor-main": profile({
        role: "executor",
        provider: "openai",
        model: "gpt-5.3-codex",
        credential: executorCredential.id,
        variant: "high",
        parameters: {},
        requirements: {
          input: ["text"],
          tools: true,
          tool_streaming: false,
          reasoning: true,
          structured_output: true,
          usage: ["input", "output"],
          access: ["api"],
          minimum_context: 200_000,
          minimum_output: 32_000,
        },
        fallback_on: ["rate-limit", "transient"],
        limits: {
          max_input_tokens: 100_000,
          max_output_tokens: 16_000,
          max_reasoning_tokens: 8_000,
          max_total_tokens: 120_000,
          max_cost: { amount: 5, currency: "USD" },
        },
      }),
      "judge-main": profile({
        role: "judge",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        credential: judgeCredential.id,
        requirements: {
          input: ["text"],
          tools: false,
          tool_streaming: false,
          reasoning: false,
          structured_output: true,
          usage: ["input", "output"],
          access: ["api"],
        },
      }),
    }

    const result = resolveRuntimeProfiles(configs, [executorCredential, judgeCredential], catalog)

    expect(result.catalogSnapshotId).toBe(catalog.id)
    expect(result.profiles["executor-main"]?.credential?.id).toBe("openai-executor")
    expect(result.profiles["executor-main"]?.parameters).toEqual({ reasoning_effort: "high" })
    expect(result.profiles["judge-main"]?.credential?.id).toBe("anthropic-judge")
    expect(result.profiles["executor-main"]?.requirements).toEqual({
      input: ["text"],
      tools: true,
      toolStreaming: false,
      reasoning: true,
      structuredOutput: true,
      usage: ["input", "output"],
      access: ["api"],
      minimumContext: 200_000,
      minimumOutput: 32_000,
    })
    expect(result.profiles["executor-main"]?.limits).toEqual({
      maxInputTokens: 100_000,
      maxOutputTokens: 16_000,
      maxReasoningTokens: 8_000,
      maxTotalTokens: 120_000,
      maxCost: { amount: 5, currency: "USD" },
    })
    expect(result.fallbackPolicies).toEqual({
      "executor-main": { allowedFailures: ["rate-limit", "transient"] },
      "judge-main": { allowedFailures: [] },
    })
  })

  test("never infers or shares a credential between profiles", async () => {
    const catalog = await snapshot()
    const executorCredential = credential({
      id: "executor-only",
      provider: "openai",
      method: "api-key",
      store: "os-keychain",
      locator: "executor-only",
    })
    const result = resolveRuntimeProfiles(
      {
        executor: profile({
          role: "executor",
          provider: "openai",
          model: "gpt-5.3-codex",
          credential: executorCredential.id,
        }),
        judge: profile({
          role: "judge",
          provider: "openai",
          model: "gpt-5.4-mini",
        }),
      },
      [executorCredential],
      catalog,
    )
    expect(result.profiles.executor?.credential?.id).toBe("executor-only")
    expect(result.profiles.judge?.credential).toBeUndefined()
  })

  test("rejects missing and mismatched credential refs without exposing their locator", async () => {
    const catalog = await snapshot()
    const secretCanary = "secret-canary-must-not-leak"
    const wrongProvider = credential({
      id: "wrong-provider",
      provider: "anthropic",
      method: "api-key",
      store: "os-keychain",
      locator: secretCanary,
    })
    const missing = thrown(() =>
      resolveRuntimeProfiles(
        {
          executor: profile({
            role: "executor",
            provider: "openai",
            model: "gpt-5.3-codex",
            credential: "missing-credential",
          }),
        },
        [],
        catalog,
      ),
    )
    expect(missing.code).toBe("RALPH_PROFILE_CREDENTIAL_NOT_FOUND")

    const mismatch = thrown(() =>
      resolveRuntimeProfiles(
        {
          executor: profile({
            role: "executor",
            provider: "openai",
            model: "gpt-5.3-codex",
            credential: wrongProvider.id,
          }),
        },
        [wrongProvider],
        catalog,
      ),
    )
    expect(mismatch.code).toBe("RALPH_PROFILE_CREDENTIAL_PROVIDER_MISMATCH")
    expect(JSON.stringify(mismatch.diagnostic)).not.toContain(secretCanary)
  })

  test("rejects unsupported credential methods and incompatible access", async () => {
    const catalog = await snapshot()
    const unsupported = credential({
      id: "anthropic-oauth",
      provider: "anthropic",
      method: "oauth-browser",
      store: "os-keychain",
      locator: "anthropic-oauth",
    })
    expect(
      thrown(() =>
        resolveRuntimeProfiles(
          {
            judge: profile({
              role: "judge",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              credential: unsupported.id,
            }),
          },
          [unsupported],
          catalog,
        ),
      ).code,
    ).toBe("RALPH_PROFILE_CREDENTIAL_METHOD_UNSUPPORTED")

    const subscription = credential({
      id: "chatgpt-subscription",
      provider: "openai",
      method: "oauth-browser",
      store: "os-keychain",
      locator: "chatgpt-subscription",
    })
    expect(
      thrown(() =>
        resolveRuntimeProfiles(
          {
            executor: profile({
              role: "executor",
              provider: "openai",
              model: "gpt-5.3-codex",
              credential: subscription.id,
            }),
          },
          [subscription],
          catalog,
        ),
      ).code,
    ).toBe("RALPH_PROFILE_CREDENTIAL_ACCESS_MISMATCH")
  })

  test("rejects unknown variants and unmet model capabilities", async () => {
    const catalog = await snapshot()
    expect(
      thrown(() =>
        resolveRuntimeProfiles(
          {
            executor: profile({
              role: "executor",
              provider: "openai",
              model: "gpt-5.3-codex",
              variant: "unknown-variant",
            }),
          },
          [],
          catalog,
        ),
      ).code,
    ).toBe("RALPH_PROFILE_VARIANT_NOT_FOUND")

    expect(
      thrown(() =>
        resolveRuntimeProfiles(
          {
            executor: profile({
              role: "executor",
              provider: "openai",
              model: "gpt-5.3-codex",
              requirements: {
                input: [],
                tools: false,
                tool_streaming: false,
                reasoning: false,
                structured_output: false,
                usage: [],
                access: [],
                minimum_context: 2_000_000,
              },
            }),
          },
          [],
          catalog,
        ),
      ).code,
    ).toBe("RALPH_PROFILE_MODEL_CAPABILITY_MISMATCH")
  })

  test("rejects unknown, undeclared and conflicting model parameters", async () => {
    const catalog = await snapshot()
    const errorFor = (
      parameters: Record<string, string | number | boolean | null>,
      variant?: string,
    ) =>
      thrown(() =>
        resolveRuntimeProfiles(
          {
            executor: profile({
              role: "executor",
              provider: "openai",
              model: "gpt-5.4",
              ...(variant ? { variant } : {}),
              parameters,
            }),
          },
          [],
          catalog,
        ),
      )

    expect(errorFor({ temperature: 0 }).code).toBe("RALPH_PROFILE_PARAMETER_UNKNOWN")
    expect(errorFor({ reasoning_effort: "extreme" }).code).toBe(
      "RALPH_PROFILE_PARAMETER_VALUE_UNDECLARED",
    )
    expect(errorFor({ reasoning_effort: "low" }, "high").code).toBe(
      "RALPH_PROFILE_PARAMETER_CONFLICT",
    )
  })

  test("rejects missing, self, wrong-role and cyclic fallbacks before routing", async () => {
    const catalog = await snapshot()
    const base = profile({ role: "executor", provider: "openai", model: "gpt-5.3-codex" })

    expect(
      thrown(() =>
        resolveRuntimeProfiles({ main: { ...base, fallback_profiles: ["missing"] } }, [], catalog),
      ).code,
    ).toBe("RALPH_PROFILE_FALLBACK_NOT_FOUND")
    expect(
      thrown(() =>
        resolveRuntimeProfiles({ main: { ...base, fallback_profiles: ["main"] } }, [], catalog),
      ).code,
    ).toBe("RALPH_PROFILE_FALLBACK_SELF_REFERENCE")

    const judge = profile({ role: "judge", provider: "openai", model: "gpt-5.4-mini" })
    expect(
      thrown(() =>
        resolveRuntimeProfiles(
          { main: { ...base, fallback_profiles: ["judge"] }, judge },
          [],
          catalog,
        ),
      ).code,
    ).toBe("RALPH_PROFILE_FALLBACK_ROLE_MISMATCH")
    expect(
      thrown(() =>
        resolveRuntimeProfiles(
          {
            first: { ...base, fallback_profiles: ["second"] },
            second: { ...base, fallback_profiles: ["first"] },
          },
          [],
          catalog,
        ),
      ).code,
    ).toBe("RALPH_PROFILE_FALLBACK_CYCLE")
  })

  test("rejects unavailable or deprecated embedded catalog targets", async () => {
    const unavailableProvider = await snapshot({
      providerStatus: { id: "openai", status: "unavailable" },
    })
    const config = {
      executor: profile({ role: "executor", provider: "openai", model: "gpt-5.3-codex" }),
    }
    expect(thrown(() => resolveRuntimeProfiles(config, [], unavailableProvider))).toMatchObject({
      code: "RALPH_PROFILE_PROVIDER_UNAVAILABLE",
      exitCode: 6,
    })

    const deprecatedModel = await snapshot({
      modelStatus: { provider: "openai", id: "gpt-5.3-codex", status: "deprecated" },
    })
    expect(thrown(() => resolveRuntimeProfiles(config, [], deprecatedModel))).toMatchObject({
      code: "RALPH_PROFILE_MODEL_UNAVAILABLE",
      exitCode: 6,
    })
  })

  test("keeps external CLI profiles distinct from embedded catalog validation", async () => {
    const catalog = await snapshot()
    const result = resolveRuntimeProfiles(
      {
        "external-worker": profile({
          role: "executor",
          backend: "external-cli",
          provider: "custom-cli",
          model: "managed-by-cli",
          fallback_on: ["transient"],
          external_cli: {
            executable: "custom-agent",
            args: ["--protocol", "jsonl"],
            cwd: ".",
            environment_refs: { CUSTOM_TOKEN: "env:RALPH_CUSTOM_TOKEN" },
            input_mode: "stdin-json",
            adapter: "protocol",
            capabilities: {
              streaming: true,
              tool_calling: "ralph",
              cancellation: true,
              usage: "reported",
            },
            mutation_mode: "workspace",
            timeout_ms: 120_000,
            output_limit_bytes: 1_048_576,
          },
        }),
      },
      [],
      catalog,
    )
    expect(result.profiles["external-worker"]).toMatchObject({
      backend: "external-cli",
      provider: "custom-cli",
      model: "managed-by-cli",
      externalCli: {
        executable: "custom-agent",
        args: ["--protocol", "jsonl"],
        cwd: ".",
        environmentRefs: { CUSTOM_TOKEN: "env:RALPH_CUSTOM_TOKEN" },
        inputMode: "stdin-json",
        adapter: "protocol",
        capabilities: {
          streaming: true,
          toolCalling: "ralph",
          cancellation: true,
          usage: "reported",
        },
        mutationMode: "workspace",
        timeoutMs: 120_000,
        outputLimitBytes: 1_048_576,
      },
    })
    expect(result.fallbackPolicies["external-worker"]).toEqual({
      allowedFailures: ["transient"],
    })
  })

  test("fails closed when external declarations cannot satisfy profile requirements", async () => {
    const catalog = await snapshot()
    const external = profile({
      role: "executor",
      backend: "external-cli",
      provider: "fixture-cli",
      model: "fixture-model",
      requirements: {
        input: [],
        tools: true,
        tool_streaming: false,
        reasoning: false,
        structured_output: true,
        usage: ["input"],
        access: [],
      },
      external_cli: {
        executable: "fixture-cli",
        args: [],
        cwd: ".",
        environment_refs: {},
        input_mode: "stdin-json",
        adapter: "generic",
        capabilities: {
          streaming: false,
          tool_calling: "unavailable",
          cancellation: true,
          usage: "unavailable",
        },
        mutation_mode: "read-only",
        timeout_ms: 10_000,
        output_limit_bytes: 65_536,
      },
    })

    expect(thrown(() => resolveRuntimeProfiles({ external }, [], catalog))).toMatchObject({
      code: "RALPH_PROFILE_EXTERNAL_CAPABILITY_MISMATCH",
      exitCode: 2,
    })
  })

  test("resolves one external fallback candidate without catalog or unrelated profiles", () => {
    const external = profile({
      role: "executor",
      backend: "external-cli",
      provider: "fixture-cli",
      model: "fixture-model",
      external_cli: {
        executable: "fixture-cli",
        args: [],
        cwd: ".",
        environment_refs: {},
        input_mode: "stdin-json",
        adapter: "protocol",
        capabilities: {
          streaming: false,
          tool_calling: "ralph",
          cancellation: true,
          usage: "unavailable",
        },
        mutation_mode: "read-only",
        timeout_ms: 10_000,
        output_limit_bytes: 65_536,
      },
    })

    expect(resolveRuntimeProfileCandidate("external", external, [])).toMatchObject({
      id: "external",
      backend: "external-cli",
      provider: "fixture-cli",
    })
  })
})
