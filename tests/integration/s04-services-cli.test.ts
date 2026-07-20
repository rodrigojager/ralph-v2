import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeCli } from "@ralph-next/commands"
import { FakeSecretStore, secretInputFromValue } from "@ralph-next/credentials"
import type { FetchLike } from "@ralph-next/openai-driver"
import {
  CachedModelCatalog,
  CURATED_CATALOG_SEED,
  createCuratedCatalogSource,
  InMemoryModelCatalogCache,
  type ModelCatalog,
  StaticCatalogSource,
} from "@ralph-next/providers"
import { type ChatGptAccountFlow, createS04Services } from "../../apps/ralph-cli/src/s04-services"

const NOW = Date.parse("2026-07-18T16:00:00.000Z")
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("S04 command-to-runtime integration", () => {
  test("configures independent profiles and runs a redacted read-only smoke", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ralph-s04-cli-")))
    temporaryDirectories.push(root)
    const apiCanary = "sk-S04-CLI-API-CANARY"
    const judgeCanary = "sk-S04-CLI-JUDGE-CANARY"
    const environment = {
      RALPH_CONFIG_HOME: root,
      ANTHROPIC_API_KEY: judgeCanary,
    }
    const keychainStore = new FakeSecretStore()
    const catalog = new CachedModelCatalog({
      source: createCuratedCatalogSource(),
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 86_400_000,
      clock: () => new Date(NOW),
    })
    const unusedAccountFlow: ChatGptAccountFlow = {
      connect: async () => {
        throw new Error("account flow must not run in this scenario")
      },
      refresh: async () => {
        throw new Error("account refresh must not run in this scenario")
      },
    }
    const modelFetch: FetchLike = async () =>
      new Response(
        JSON.stringify({
          output_text: `RALPH_SMOKE_OK ${apiCanary}`,
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          status: "completed",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    const services = createS04Services({
      dataRoot: root,
      environment,
      catalogFactory: () => catalog,
      keychainStore,
      accountFlow: unusedAccountFlow,
      readSecretStdin: async () => secretInputFromValue(apiCanary),
      modelFetch,
      now: () => NOW,
      callId: () => "cli-smoke",
    })
    const context = {
      version: "0.1.0-test",
      cwd: root,
      environment,
      resolveModelCatalog: services.resolveModelCatalog,
      credentials: services.credentials,
      modelSmoke: services.modelSmoke,
      profileForm: services.profileForm,
    }

    const headlessBrowser = await executeCli(
      [
        "auth",
        "connect",
        "openai",
        "--method",
        "oauth-browser",
        "--non-interactive",
        "--format",
        "json",
      ],
      context,
    )
    expect(headlessBrowser.exitCode).toBe(2)
    expect(headlessBrowser.execution.result.diagnostics[0]).toMatchObject({
      code: "RALPH_AUTH_BROWSER_OAUTH_UNAVAILABLE_HEADLESS",
      hint: expect.stringContaining("--method device-code"),
    })

    const executorAuth = await executeCli(
      [
        "auth",
        "connect",
        "openai",
        "--method",
        "api-key",
        "--credential",
        "executor-key",
        "--secret-stdin",
        "--non-interactive",
        "--headless",
        "--format",
        "json",
      ],
      context,
    )
    const judgeAuth = await executeCli(
      [
        "auth",
        "connect",
        "anthropic",
        "--method",
        "environment",
        "--environment",
        "ANTHROPIC_API_KEY",
        "--credential",
        "judge-key",
        "--non-interactive",
        "--headless",
        "--format",
        "json",
      ],
      context,
    )
    expect(executorAuth.exitCode).toBe(0)
    expect(judgeAuth.exitCode).toBe(0)

    const executorProfile = await executeCli(
      [
        "profiles",
        "configure",
        "executor-main",
        "--scope",
        "global",
        "--role",
        "executor",
        "--backend",
        "embedded",
        "--provider",
        "openai",
        "--model",
        "gpt-5.4-mini",
        "--credential",
        "executor-key",
        "--non-interactive",
        "--format",
        "json",
      ],
      context,
    )
    const judgeProfile = await executeCli(
      [
        "profiles",
        "configure",
        "judge-main",
        "--scope",
        "global",
        "--role",
        "judge",
        "--backend",
        "embedded",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-6",
        "--credential",
        "judge-key",
        "--non-interactive",
        "--format",
        "json",
      ],
      context,
    )
    expect(executorProfile.exitCode).toBe(0)
    expect(judgeProfile.exitCode).toBe(0)

    const coldComposition = (label: string) => {
      const catalogBase = new CachedModelCatalog({
        source: createCuratedCatalogSource(),
        cache: new InMemoryModelCatalogCache(),
        ttlMs: 86_400_000,
        clock: () => new Date(NOW),
      })
      const counts = { snapshotCalls: 0, providerListCalls: 0 }
      const catalog: ModelCatalog = {
        snapshot: (options) => {
          counts.snapshotCalls += 1
          return catalogBase.snapshot(options)
        },
        providers: (options) => {
          counts.providerListCalls += 1
          return catalogBase.providers(options)
        },
        models: (query, options) => catalogBase.models(query, options),
        inspect: (reference, options) => catalogBase.inspect(reference, options),
      }
      const concrete = createS04Services({
        dataRoot: root,
        environment,
        catalogFactory: () => catalog,
        keychainStore,
        accountFlow: unusedAccountFlow,
        readSecretStdin: async () => secretInputFromValue(apiCanary),
        modelFetch,
        now: () => NOW,
        callId: () => `cold-${label}`,
      })
      return {
        counts,
        context: {
          ...context,
          resolveModelCatalog: concrete.resolveModelCatalog,
          credentials: concrete.credentials,
          modelSmoke: concrete.modelSmoke,
          profileForm: concrete.profileForm,
        },
      }
    }

    const unsupportedAnthropic = coldComposition("anthropic-oauth")
    const unsupportedAnthropicResult = await executeCli(
      [
        "auth",
        "connect",
        "anthropic",
        "--method",
        "oauth-browser",
        "--non-interactive",
        "--format",
        "json",
      ],
      unsupportedAnthropic.context,
    )
    expect(unsupportedAnthropicResult.exitCode).toBe(2)
    expect(unsupportedAnthropicResult.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_AUTH_METHOD_UNSUPPORTED",
    )
    expect(JSON.stringify(unsupportedAnthropicResult.execution.result)).not.toContain("device-code")
    expect(unsupportedAnthropic.counts).toEqual({ snapshotCalls: 1, providerListCalls: 0 })

    const openAiHeadless = coldComposition("openai-headless")
    const openAiHeadlessResult = await executeCli(
      [
        "auth",
        "connect",
        "openai",
        "--method",
        "oauth-browser",
        "--non-interactive",
        "--format",
        "json",
      ],
      openAiHeadless.context,
    )
    expect(openAiHeadlessResult.exitCode).toBe(2)
    expect(openAiHeadlessResult.execution.result.diagnostics[0]).toMatchObject({
      code: "RALPH_AUTH_BROWSER_OAUTH_UNAVAILABLE_HEADLESS",
      hint: expect.stringContaining("--method device-code"),
    })
    expect(openAiHeadless.counts).toEqual({ snapshotCalls: 1, providerListCalls: 0 })

    const authConnect = coldComposition("auth-connect")
    const coldAuth = await executeCli(
      [
        "auth",
        "connect",
        "openai",
        "--method",
        "api-key",
        "--credential",
        "cold-auth-key",
        "--secret-stdin",
        "--non-interactive",
        "--format",
        "json",
      ],
      authConnect.context,
    )
    expect(coldAuth.exitCode).toBe(0)
    expect(authConnect.counts).toEqual({ snapshotCalls: 1, providerListCalls: 0 })

    const profileInspect = coldComposition("profile-inspect")
    const inspected = await executeCli(
      ["profiles", "inspect", "executor-main", "--format", "json"],
      profileInspect.context,
    )
    expect(inspected.exitCode).toBe(0)
    expect(profileInspect.counts).toEqual({ snapshotCalls: 1, providerListCalls: 0 })

    const doctorComposition = coldComposition("doctor")
    const doctor = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      doctorComposition.context,
    )
    expect(doctor.exitCode).toBe(0)
    expect(doctorComposition.counts).toEqual({ snapshotCalls: 1, providerListCalls: 0 })

    const smokeComposition = coldComposition("cli-smoke")
    const smoke = await executeCli(
      ["model", "smoke", "--profile", "executor-main", "--format", "json"],
      smokeComposition.context,
    )
    expect(smoke.exitCode).toBe(0)
    expect(smoke.execution.result.ok).toBe(true)
    expect(JSON.stringify(smoke.execution.result)).toContain("RALPH_SMOKE_OK [REDACTED]")
    expect(smokeComposition.counts).toEqual({ snapshotCalls: 1, providerListCalls: 0 })

    const config = await readFile(join(root, "config.yaml"), "utf8")
    const metadata = await readFile(services.paths.credentialMetadata, "utf8")
    const publicResults = JSON.stringify([
      executorAuth.execution.result,
      judgeAuth.execution.result,
      executorProfile.execution.result,
      judgeProfile.execution.result,
      coldAuth.execution.result,
      inspected.execution.result,
      doctor.execution.result,
      smoke.execution.result,
    ])
    for (const canary of [apiCanary, judgeCanary]) {
      expect(config).not.toContain(canary)
      expect(metadata).not.toContain(canary)
      expect(publicResults).not.toContain(canary)
    }
    expect(config).toContain("executor-key")
    expect(config).toContain("judge-key")
    expect(config).toContain("executor-main")
    expect(config).toContain("judge-main")
  })

  test("revokes local credentials when catalog eligibility drifts or the catalog is down", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ralph-s04-revoke-recovery-")))
    temporaryDirectories.push(root)
    const keychainStore = new FakeSecretStore()
    const catalogFailureCanary = "CATALOG-DOWN-S04-CANARY"
    const secretCanary = "sk-S04-REVOKE-CANARY" // gitleaks:allow -- synthetic redaction fixture
    const fullCatalog = new CachedModelCatalog({
      source: new StaticCatalogSource(CURATED_CATALOG_SEED),
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 86_400_000,
      clock: () => new Date(NOW),
    })
    const driftCatalog = new CachedModelCatalog({
      source: new StaticCatalogSource({
        ...CURATED_CATALOG_SEED,
        source: { ...CURATED_CATALOG_SEED.source, revision: "revoke-drift" },
        providers: CURATED_CATALOG_SEED.providers.map((provider) =>
          provider.id === "openai"
            ? {
                ...provider,
                credentialMethods: provider.credentialMethods.filter(
                  (method) => method.method !== "api-key",
                ),
              }
            : provider,
        ),
      }),
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 86_400_000,
      clock: () => new Date(NOW),
    })
    let catalogMode: "full" | "drift" | "down" = "full"
    const activeCatalog = (): ModelCatalog => {
      if (catalogMode === "down") throw new Error(catalogFailureCanary)
      return catalogMode === "full" ? fullCatalog : driftCatalog
    }
    const catalog: ModelCatalog = {
      snapshot: (options) => activeCatalog().snapshot(options),
      providers: (options) => activeCatalog().providers(options),
      models: (query, options) => activeCatalog().models(query, options),
      inspect: (reference, options) => activeCatalog().inspect(reference, options),
    }
    const unusedAccountFlow: ChatGptAccountFlow = {
      connect: async () => {
        throw new Error("account flow must not run in local cleanup")
      },
      refresh: async () => {
        throw new Error("account refresh must not run in local cleanup")
      },
    }
    const makeComposition = () => {
      const services = createS04Services({
        dataRoot: root,
        environment: { RALPH_CONFIG_HOME: root },
        catalogFactory: () => catalog,
        keychainStore,
        accountFlow: unusedAccountFlow,
        readSecretStdin: async () => secretInputFromValue(secretCanary),
        modelFetch: async () => {
          throw new Error("model fetch must not run in credential cleanup")
        },
        now: () => NOW,
        callId: () => "revoke-recovery",
      })
      return {
        services,
        context: {
          version: "0.1.0-test",
          cwd: root,
          environment: { RALPH_CONFIG_HOME: root },
          resolveModelCatalog: services.resolveModelCatalog,
          credentials: services.credentials,
        },
      }
    }

    const initial = makeComposition()
    for (const credential of ["drift-key", "outage-key"] as const) {
      const connected = await executeCli(
        [
          "auth",
          "connect",
          "openai",
          "--method",
          "api-key",
          "--credential",
          credential,
          "--secret-stdin",
          "--non-interactive",
          "--format",
          "json",
        ],
        initial.context,
      )
      expect(connected.exitCode).toBe(0)
    }
    const refs = new Map((await initial.services.credentials.list()).map((ref) => [ref.id, ref]))
    const driftRef = refs.get("drift-key")
    const outageRef = refs.get("outage-key")
    if (!driftRef || !outageRef) throw new Error("cleanup fixture credentials were not persisted")

    catalogMode = "drift"
    const afterDrift = makeComposition()
    const driftRevocation = await executeCli(
      ["auth", "revoke", "drift-key", "--format", "json"],
      afterDrift.context,
    )
    expect(driftRevocation.exitCode).toBe(0)
    expect(await keychainStore.get(driftRef.locator)).toBeUndefined()
    expect(
      (await afterDrift.services.credentials.list()).some((ref) => ref.id === driftRef.id),
    ).toBe(false)

    catalogMode = "down"
    const duringOutage = makeComposition()
    const outageStatus = await executeCli(
      ["auth", "status", "outage-key", "--format", "json"],
      duringOutage.context,
    )
    expect(outageStatus.exitCode).toBe(6)
    expect(outageStatus.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_CREDENTIAL_OPERATION_FAILED",
    )
    expect(JSON.stringify(outageStatus.execution.result)).not.toContain(catalogFailureCanary)

    const outageRevocation = await executeCli(
      ["auth", "revoke", "outage-key", "--format", "json"],
      duringOutage.context,
    )
    expect(outageRevocation.exitCode).toBe(0)
    expect(await keychainStore.get(outageRef.locator)).toBeUndefined()
    expect(
      (await duringOutage.services.credentials.list()).some((ref) => ref.id === outageRef.id),
    ).toBe(false)
  })
})
