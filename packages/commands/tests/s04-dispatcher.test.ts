import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CredentialRef, CredentialStatus } from "../../credentials/src/index"
import {
  CachedModelCatalog,
  type CatalogResolution,
  createCuratedCatalogSource,
  InMemoryModelCatalogCache,
  type ModelCatalog,
  type ModelCatalogQuery,
  type ModelCatalogReadOptions,
  type ModelInfo,
  type ModelRef,
  type ProviderInfo,
} from "../../providers/src/index"
import type {
  CredentialCommandService,
  CredentialConnectCommandRequest,
  ModelSmokeCommandRequest,
  ModelSmokeServiceResult,
} from "../src/handlers"
import { executeCli } from "../src/index"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ralph-s04-commands-"))
  temporaryRoots.push(root)
  return root
}

class FixtureCatalog implements ModelCatalog {
  readonly #catalog = new CachedModelCatalog({
    source: createCuratedCatalogSource(),
    cache: new InMemoryModelCatalogCache(),
    ttlMs: 60_000,
    clock: () => new Date("2026-07-18T12:00:00.000Z"),
  })
  lastResolution?: CatalogResolution

  async snapshot(options?: ModelCatalogReadOptions): Promise<CatalogResolution> {
    const resolution = await this.#catalog.snapshot(options)
    this.lastResolution = resolution
    return resolution
  }

  async providers(options?: ModelCatalogReadOptions): Promise<readonly ProviderInfo[]> {
    return this.#catalog.providers(options)
  }

  async models(
    query: ModelCatalogQuery = {},
    options?: ModelCatalogReadOptions,
  ): Promise<readonly ModelInfo[]> {
    return this.#catalog.models(query, options)
  }

  async inspect(ref: ModelRef, options?: ModelCatalogReadOptions): Promise<ModelInfo | undefined> {
    return this.#catalog.inspect(ref, options)
  }
}

class FixtureCredentials implements CredentialCommandService {
  readonly refs: CredentialRef[] = [
    {
      id: "executor-ref",
      provider: "openai",
      method: "api-key",
      store: "os-keychain",
      locator: "openai:executor-ref",
      label: "Executor key",
    },
    {
      id: "judge-ref",
      provider: "anthropic",
      method: "api-key",
      store: "os-keychain",
      locator: "anthropic:judge-ref",
      label: "Judge key",
    },
  ]
  readonly connectRequests: CredentialConnectCommandRequest[] = []
  readonly revoked: string[] = []

  async connect(request: CredentialConnectCommandRequest): Promise<CredentialRef> {
    this.connectRequests.push(request)
    const ref: CredentialRef = {
      id: request.credentialId ?? "connected-ref",
      provider: request.provider,
      method: request.method,
      store: request.method === "environment" ? "environment" : "os-keychain",
      locator:
        request.method === "environment"
          ? (request.environmentName as string)
          : `${request.provider}:${request.credentialId ?? "connected-ref"}`,
      label: request.label ?? "Connected credential",
    }
    this.refs.push(ref)
    return ref
  }

  async list(): Promise<readonly CredentialRef[]> {
    return this.refs
  }

  async status(): Promise<CredentialStatus> {
    return "connected"
  }

  async revoke(ref: CredentialRef): Promise<void> {
    this.revoked.push(ref.id)
    const index = this.refs.findIndex((candidate) => candidate.id === ref.id)
    if (index >= 0) this.refs.splice(index, 1)
  }
}

function commandContext(
  root: string,
  options: {
    catalog?: ModelCatalog
    credentials?: CredentialCommandService
    modelSmoke?: (request: ModelSmokeCommandRequest) => Promise<ModelSmokeServiceResult>
  } = {},
) {
  return {
    version: "0.1.0-test",
    cwd: root,
    environment: {
      RALPH_CONFIG_HOME: join(root, "global-config"),
    },
    ...(options.catalog ? { resolveModelCatalog: () => options.catalog as ModelCatalog } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.modelSmoke ? { modelSmoke: { smoke: options.modelSmoke } } : {}),
  }
}

function resultData<T>(result: Awaited<ReturnType<typeof executeCli>>): T {
  expect(result.exitCode).toBe(0)
  expect(result.execution.result.ok).toBe(true)
  return result.execution.result.data as T
}

describe("S04 command dispatcher", () => {
  test("resolves the catalog lazily and dispatches provider/model reads with capability filters", async () => {
    const root = await temporaryRoot()
    const catalog = new FixtureCatalog()
    let resolutions = 0
    const context = {
      ...commandContext(root),
      resolveModelCatalog: () => {
        resolutions += 1
        return catalog
      },
    }

    expect((await executeCli(["version"], context)).exitCode).toBe(0)
    expect(resolutions).toBe(0)

    const providers = resultData<{ providers: ProviderInfo[] }>(
      await executeCli(["providers", "list", "--format", "json"], context),
    )
    expect(providers.providers.map((provider) => provider.id)).toContain("openai")

    const models = resultData<{ models: ModelInfo[] }>(
      await executeCli(
        ["models", "list", "--provider", "openai", "--require-tools", "--format", "json"],
        context,
      ),
    )
    expect(models.models.length).toBeGreaterThan(0)
    expect(models.models.every((model) => model.capabilities.tools)).toBe(true)

    const inspected = resultData<{ model: ModelInfo }>(
      await executeCli(["models", "inspect", "openai/gpt-5.4", "--format", "json"], context),
    )
    expect(inspected.model.id).toBe("gpt-5.4")
    expect(resolutions).toBe(1)
  })

  test("keeps API key material out of argv while dispatching connect/status/revoke", async () => {
    const root = await temporaryRoot()
    const credentials = new FixtureCredentials()
    const catalog = new FixtureCatalog()
    const context = commandContext(root, { catalog, credentials })

    const connected = resultData<{ credential: CredentialRef }>(
      await executeCli(
        [
          "auth",
          "connect",
          "openai",
          "--method",
          "api-key",
          "--credential",
          "new-api-ref",
          "--secret-stdin",
          "--non-interactive",
          "--format",
          "json",
        ],
        context,
      ),
    )
    expect(connected.credential.id).toBe("new-api-ref")
    expect(credentials.connectRequests).toEqual([
      expect.objectContaining({
        provider: "openai",
        method: "api-key",
        credentialId: "new-api-ref",
        secretSource: "stdin",
        nonInteractive: true,
        headless: true,
      }),
    ])
    expect(credentials.connectRequests[0]?.providerInfo).toBe(
      catalog.lastResolution?.snapshot.providers.find((provider) => provider.id === "openai"),
    )
    expect(JSON.stringify(credentials.connectRequests)).not.toContain("apiKey")
    expect(JSON.stringify(credentials.connectRequests)).not.toContain("secretValue")

    const status = resultData<{
      credentials: Array<{ credential: CredentialRef; status: string }>
    }>(await executeCli(["auth", "status", "new-api-ref", "--format", "json"], context))
    expect(status.credentials[0]).toMatchObject({
      credential: { id: "new-api-ref" },
      status: "connected",
    })

    resultData(await executeCli(["auth", "revoke", "new-api-ref", "--format", "json"], context))
    expect(credentials.revoked).toEqual(["new-api-ref"])
  })

  test("rejects an invalid auth method before requiring a credential composition", async () => {
    const root = await temporaryRoot()
    const result = await executeCli(
      ["auth", "connect", "openai", "--method", "not-a-method", "--format", "json"],
      commandContext(root),
    )
    expect(result.exitCode).toBe(2)
    expect(result.execution.result.diagnostics[0]?.code).toBe("RALPH_AUTH_METHOD_INVALID")
  })

  test("persists and inspects independent executor/judge profiles using credential refs only", async () => {
    const root = await temporaryRoot()
    const catalog = new FixtureCatalog()
    const credentials = new FixtureCredentials()
    const context = commandContext(root, { catalog, credentials })
    resultData(await executeCli(["init", "--format", "json"], context))

    const executorConfigured = resultData<{
      runtimeProfile: {
        id: string
        role: string
        credential?: CredentialRef
        parameters: Record<string, unknown>
      }
      effectiveParameters: Record<string, unknown>
      fallbackPolicy: { allowedFailures: string[] }
      catalog: { snapshotId: string }
    }>(
      await executeCli(
        [
          "profiles",
          "configure",
          "executor-main",
          "--scope",
          "workspace",
          "--role",
          "executor",
          "--backend",
          "embedded",
          "--provider",
          "openai",
          "--model",
          "gpt-5.4",
          "--credential",
          "executor-ref",
          "--variant",
          "high",
          "--parameter",
          "reasoning_effort=high",
          "--require-tools",
          "--fallback-on",
          "rate-limit",
          "--non-interactive",
          "--format",
          "json",
        ],
        context,
      ),
    )
    expect(executorConfigured).toMatchObject({
      runtimeProfile: {
        id: "executor-main",
        role: "executor",
        credential: { id: "executor-ref" },
        parameters: { reasoning_effort: "high" },
      },
      effectiveParameters: { reasoning_effort: "high" },
      fallbackPolicy: { allowedFailures: ["rate-limit"] },
    })
    expect(executorConfigured.catalog.snapshotId).toMatch(/^catalog:[a-f0-9]{64}$/)

    const judgeConfigured = resultData<{
      runtimeProfile: { id: string; role: string; credential?: CredentialRef }
      catalog: { snapshotId: string }
    }>(
      await executeCli(
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
          "judge-ref",
          "--require-structured-output",
          "--non-interactive",
          "--format",
          "json",
        ],
        context,
      ),
    )
    expect(judgeConfigured).toMatchObject({
      runtimeProfile: {
        id: "judge-main",
        role: "judge",
        credential: { id: "judge-ref" },
      },
    })
    expect(judgeConfigured.catalog.snapshotId).toBe(executorConfigured.catalog.snapshotId)

    const listed = resultData<{
      profiles: Array<{ id: string; profile: { provider: string; credential?: string } }>
    }>(await executeCli(["profiles", "list", "--format", "json"], context))
    expect(listed.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "executor-main",
          profile: expect.objectContaining({ provider: "openai", credential: "executor-ref" }),
        }),
        expect.objectContaining({
          id: "judge-main",
          profile: expect.objectContaining({ provider: "anthropic", credential: "judge-ref" }),
        }),
      ]),
    )

    const judge = resultData<{
      profile: { role: string; provider: string; credential: string }
      credential: { ref: CredentialRef; status: string }
      runtimeProfile: { id: string; role: string; credential?: CredentialRef }
      catalog: { snapshotId: string }
    }>(await executeCli(["profiles", "inspect", "judge-main", "--format", "json"], context))
    expect(judge.profile).toMatchObject({
      role: "judge",
      provider: "anthropic",
      credential: "judge-ref",
    })
    expect(judge.credential).toMatchObject({ ref: { id: "judge-ref" }, status: "connected" })
    expect(judge.runtimeProfile).toMatchObject({
      id: "judge-main",
      role: "judge",
      credential: { id: "judge-ref" },
    })
    expect(judge.catalog.snapshotId).toBe(executorConfigured.catalog.snapshotId)

    const executor = resultData<{
      effectiveParameters: Record<string, unknown>
      runtimeProfile: { parameters: Record<string, unknown> }
    }>(await executeCli(["profiles", "inspect", "executor-main", "--format", "json"], context))
    expect(executor.effectiveParameters).toEqual({ reasoning_effort: "high" })
    expect(executor.runtimeProfile.parameters).toEqual({ reasoning_effort: "high" })

    const workspaceConfig = await readFile(join(root, ".ralph", "config.yaml"), "utf8")
    const globalConfig = await readFile(join(root, "global-config", "config.yaml"), "utf8")
    expect(workspaceConfig).toContain("credential: executor-ref")
    expect(workspaceConfig).toContain("fallback_on:")
    expect(workspaceConfig).toContain("rate-limit")
    expect(workspaceConfig).toContain("reasoning_effort: high")
    expect(workspaceConfig).not.toContain("judge-ref")
    expect(globalConfig).toContain("credential: judge-ref")
    expect(globalConfig).not.toContain("executor-ref")
    expect(`${workspaceConfig}\n${globalConfig}`).not.toContain("openai:executor-ref")
    expect(`${workspaceConfig}\n${globalConfig}`).not.toContain("anthropic:judge-ref")
  })

  test("persists a complete external CLI profile and materializes its camelCase runtime contract", async () => {
    const root = await temporaryRoot()
    const context = commandContext(root, { catalog: new FixtureCatalog() })
    resultData(await executeCli(["init", "--format", "json"], context))

    const configured = resultData<{
      profile: { external_cli: { environment_refs: Record<string, string> } }
      runtimeProfile: {
        externalCli: {
          args: string[]
          environmentRefs: Record<string, string>
          capabilities: { toolCalling: string }
        }
      }
    }>(
      await executeCli(
        [
          "profiles",
          "configure",
          "external-worker",
          "--scope",
          "workspace",
          "--role",
          "executor",
          "--backend",
          "external-cli",
          "--provider",
          "custom-cli",
          "--model",
          "managed-by-cli",
          "--cli-executable",
          "custom-agent",
          "--cli-arg=--json",
          "--cli-env",
          "CUSTOM_TOKEN=env:RALPH_CUSTOM_TOKEN",
          "--cli-adapter",
          "protocol",
          "--cli-tool-calling",
          "ralph",
          "--cli-streaming",
          "true",
          "--cli-cancellation",
          "true",
          "--cli-usage",
          "reported",
          "--cli-mutation",
          "workspace",
          "--cli-timeout-ms",
          "120000",
          "--cli-output-limit-bytes",
          "1048576",
          "--non-interactive",
          "--format",
          "json",
        ],
        context,
      ),
    )
    expect(configured.profile.external_cli.environment_refs).toEqual({
      CUSTOM_TOKEN: "env:RALPH_CUSTOM_TOKEN",
    })
    expect(configured.runtimeProfile.externalCli).toMatchObject({
      args: ["--json"],
      environmentRefs: { CUSTOM_TOKEN: "env:RALPH_CUSTOM_TOKEN" },
      capabilities: { toolCalling: "ralph" },
    })
    const persisted = await readFile(join(root, ".ralph", "config.yaml"), "utf8")
    expect(persisted).toContain("CUSTOM_TOKEN: env:RALPH_CUSTOM_TOKEN")
    expect(persisted).not.toContain("raw-secret")
  })

  test("rejects unsupported credential methods and model access before persisting a profile", async () => {
    const root = await temporaryRoot()
    const catalog = new FixtureCatalog()
    const credentials = new FixtureCredentials()
    credentials.refs.push(
      {
        id: "anthropic-oauth",
        provider: "anthropic",
        method: "oauth-browser",
        store: "os-keychain",
        locator: "anthropic:oauth",
        label: "Unsupported Anthropic OAuth",
      },
      {
        id: "chatgpt-api-only",
        provider: "openai",
        method: "oauth-browser",
        store: "os-keychain",
        locator: "openai:subscription",
        label: "ChatGPT subscription",
      },
    )
    const context = commandContext(root, { catalog, credentials })
    resultData(await executeCli(["init", "--format", "json"], context))

    const unsupported = await executeCli(
      [
        "profiles",
        "configure",
        "unsupported-judge",
        "--scope",
        "workspace",
        "--role",
        "judge",
        "--backend",
        "embedded",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-6",
        "--credential",
        "anthropic-oauth",
        "--non-interactive",
        "--format",
        "json",
      ],
      context,
    )
    expect(unsupported.exitCode).toBe(2)
    expect(unsupported.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_PROFILE_CREDENTIAL_METHOD_UNSUPPORTED",
    )

    const incompatibleAccess = await executeCli(
      [
        "profiles",
        "configure",
        "subscription-api-model",
        "--scope",
        "workspace",
        "--role",
        "executor",
        "--backend",
        "embedded",
        "--provider",
        "openai",
        "--model",
        "gpt-5.3-codex",
        "--credential",
        "chatgpt-api-only",
        "--non-interactive",
        "--format",
        "json",
      ],
      context,
    )
    expect(incompatibleAccess.exitCode).toBe(2)
    expect(incompatibleAccess.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_PROFILE_CREDENTIAL_ACCESS_MISMATCH",
    )

    const workspaceConfig = await readFile(join(root, ".ralph", "config.yaml"), "utf8")
    expect(workspaceConfig).not.toContain("unsupported-judge")
    expect(workspaceConfig).not.toContain("subscription-api-model")
  })

  test("rejects unknown and variant-conflicting parameters before persisting a profile", async () => {
    const root = await temporaryRoot()
    const context = commandContext(root, {
      catalog: new FixtureCatalog(),
      credentials: new FixtureCredentials(),
    })
    resultData(await executeCli(["init", "--format", "json"], context))
    const base = [
      "profiles",
      "configure",
      "invalid-parameters",
      "--scope",
      "workspace",
      "--role",
      "executor",
      "--backend",
      "embedded",
      "--provider",
      "openai",
      "--model",
      "gpt-5.4",
      "--non-interactive",
      "--format",
      "json",
    ]

    const unknown = await executeCli([...base, "--parameter", "temperature=0"], context)
    expect(unknown.exitCode).toBe(2)
    expect(unknown.execution.result.diagnostics[0]?.code).toBe("RALPH_PROFILE_PARAMETER_UNKNOWN")
    const conflict = await executeCli(
      [...base, "--variant", "high", "--parameter", "reasoning_effort=low"],
      context,
    )
    expect(conflict.exitCode).toBe(2)
    expect(conflict.execution.result.diagnostics[0]?.code).toBe("RALPH_PROFILE_PARAMETER_CONFLICT")
    const workspaceConfig = await readFile(join(root, ".ralph", "config.yaml"), "utf8")
    expect(workspaceConfig).not.toContain("invalid-parameters")
  })

  test("revalidates credential access against the exact catalog snapshot on inspect", async () => {
    const root = await temporaryRoot()
    const catalog = new FixtureCatalog()
    const credentials = new FixtureCredentials()
    const context = commandContext(root, { catalog, credentials })
    resultData(await executeCli(["init", "--format", "json"], context))
    resultData(
      await executeCli(
        [
          "profiles",
          "configure",
          "inspect-access",
          "--scope",
          "workspace",
          "--role",
          "executor",
          "--backend",
          "embedded",
          "--provider",
          "openai",
          "--model",
          "gpt-5.3-codex",
          "--credential",
          "executor-ref",
          "--non-interactive",
          "--format",
          "json",
        ],
        context,
      ),
    )

    const credentialIndex = credentials.refs.findIndex((ref) => ref.id === "executor-ref")
    expect(credentialIndex).toBeGreaterThanOrEqual(0)
    credentials.refs[credentialIndex] = {
      ...(credentials.refs[credentialIndex] as CredentialRef),
      method: "oauth-browser",
    }

    const inspected = await executeCli(
      ["profiles", "inspect", "inspect-access", "--format", "json"],
      context,
    )
    expect(inspected.exitCode).toBe(2)
    expect(inspected.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_PROFILE_CREDENTIAL_ACCESS_MISMATCH",
    )
  })

  test("dispatches a fixed read-only no-tools smoke request and preserves honest usage", async () => {
    const root = await temporaryRoot()
    const catalog = new FixtureCatalog()
    const credentials = new FixtureCredentials()
    const requests: ModelSmokeCommandRequest[] = []
    const context = commandContext(root, {
      catalog,
      credentials,
      modelSmoke: async (request) => {
        requests.push(request)
        return {
          provider: request.provider,
          model: request.model,
          effectiveParameters: request.parameters,
          text: "RALPH_SMOKE_OK",
          finishReason: "stop",
          usage: { input: 10, output: 2, total: 12, source: "reported", semantics: "final" },
          rawRef: "raw:smoke-fixture",
          catalogSnapshotId: `catalog:${"a".repeat(64)}`,
          catalogOrigin: "cache",
          catalogStale: false,
        }
      },
    })

    const smoke = resultData<{
      readOnly: boolean
      tools: unknown[]
      text: string
      usage: { total: number; source: string }
      catalog: { snapshotId: string; origin: string; stale: boolean }
    }>(
      await executeCli(
        [
          "model",
          "smoke",
          "--provider",
          "openai",
          "--model",
          "gpt-5.4",
          "--credential",
          "executor-ref",
          "--format",
          "json",
        ],
        context,
      ),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.4",
      credentialId: "executor-ref",
      parameters: {},
      requirements: { input: ["text"], tools: false },
      tools: [],
      readOnly: true,
    })
    expect(requests[0]?.prompt).toContain("RALPH_SMOKE_OK")
    expect(smoke).toMatchObject({
      readOnly: true,
      tools: [],
      text: "RALPH_SMOKE_OK",
      usage: { total: 12, source: "reported" },
      catalog: {
        snapshotId: `catalog:${"a".repeat(64)}`,
        origin: "cache",
        stale: false,
      },
    })
  })

  test("does not echo a secret-bearing service error even in JSON diagnostics", async () => {
    const root = await temporaryRoot()
    const credentials = new FixtureCredentials()
    const canary = "S04_SECRET_CANARY_7281"
    credentials.connect = async () => {
      throw new Error(`provider rejected ${canary}`)
    }
    const result = await executeCli(
      [
        "auth",
        "connect",
        "openai",
        "--method",
        "api-key",
        "--secret-stdin",
        "--non-interactive",
        "--format",
        "json",
      ],
      commandContext(root, { catalog: new FixtureCatalog(), credentials }),
    )
    expect(result.exitCode).toBe(6)
    expect(JSON.stringify(result.execution)).not.toContain(canary)
  })
})
