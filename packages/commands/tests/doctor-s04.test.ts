import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
import type { CredentialCommandService, CredentialConnectCommandRequest } from "../src/handlers"
import { executeCli } from "../src/index"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ralph-doctor-s04-"))
  temporaryRoots.push(root)
  return root
}

class SnapshotOnlyCatalog implements ModelCatalog {
  readonly #catalog = new CachedModelCatalog({
    source: createCuratedCatalogSource(),
    cache: new InMemoryModelCatalogCache(),
    ttlMs: 60_000,
    clock: () => new Date("2026-07-18T16:00:00.000Z"),
  })

  readonly #origin: CatalogResolution["origin"]
  snapshotCalls = 0

  constructor(origin: CatalogResolution["origin"] = "source") {
    this.#origin = origin
  }

  async snapshot(options?: ModelCatalogReadOptions): Promise<CatalogResolution> {
    this.snapshotCalls += 1
    const resolution = await this.#catalog.snapshot(options)
    if (this.#origin === "source") return resolution
    return {
      snapshot: resolution.snapshot,
      origin: this.#origin,
      stale: this.#origin === "stale-cache",
      warning: "fixture catalog source is degraded",
    }
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
  listCalls = 0

  constructor(
    readonly refs: readonly CredentialRef[],
    readonly listFailure?: Error,
    readonly statusValue: CredentialStatus = "connected",
  ) {}

  async connect(_request: CredentialConnectCommandRequest): Promise<CredentialRef> {
    throw new Error("not used")
  }

  async list(): Promise<readonly CredentialRef[]> {
    this.listCalls += 1
    if (this.listFailure) throw this.listFailure
    return this.refs
  }

  async status(_ref: CredentialRef): Promise<CredentialStatus> {
    return this.statusValue
  }

  async revoke(_ref: CredentialRef): Promise<void> {
    throw new Error("not used")
  }
}

type DoctorCheck = {
  id: string
  status: "passed" | "warning" | "failed" | "skipped"
  required: boolean
  message: string
  hint?: string
}

function context(
  root: string,
  options: {
    catalog?: ModelCatalog
    credentials?: CredentialCommandService
    resolveCatalog?: () => ModelCatalog
  } = {},
) {
  return {
    version: "0.1.0-test",
    cwd: root,
    environment: { RALPH_CONFIG_HOME: join(root, "global-config") },
    ...(options.catalog ? { resolveModelCatalog: () => options.catalog as ModelCatalog } : {}),
    ...(options.resolveCatalog ? { resolveModelCatalog: options.resolveCatalog } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
  }
}

function checks(result: Awaited<ReturnType<typeof executeCli>>): Map<string, DoctorCheck> {
  const data = result.execution.result.data as { checks: DoctorCheck[] }
  return new Map(data.checks.map((check) => [check.id, check]))
}

async function writeProfiles(root: string, body: readonly string[]): Promise<void> {
  const configHome = join(root, "global-config")
  await mkdir(configHome, { recursive: true })
  await writeFile(join(configHome, "config.yaml"), ["schema_version: 1", ...body, ""].join("\n"))
}

const EXECUTOR_PROFILE = [
  "profiles:",
  "  executor-main:",
  "    role: executor",
  "    backend: embedded",
  "    provider: openai",
  "    model: gpt-5.4",
] as const

describe("doctor S04 checks", () => {
  test("skips provider, credential and runtime compatibility work honestly when profiles are empty", async () => {
    const root = await temporaryRoot()
    let catalogResolutions = 0
    const credentials = new FixtureCredentials([])
    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, {
        credentials,
        resolveCatalog: () => {
          catalogResolutions += 1
          return new SnapshotOnlyCatalog()
        },
      }),
    )

    expect(result.exitCode).toBe(0)
    expect(catalogResolutions).toBe(0)
    expect(credentials.listCalls).toBe(0)
    const assessment = checks(result)
    expect(assessment.get("providers.catalog")?.status).toBe("skipped")
    expect(assessment.get("credentials.metadata")?.status).toBe("skipped")
    expect(assessment.get("profiles.runtime")?.status).toBe("skipped")
  })

  test("validates against one exact fallback snapshot without exposing credential locators", async () => {
    const root = await temporaryRoot()
    await writeProfiles(root, [...EXECUTOR_PROFILE, "    credential: executor-ref"])
    const catalog = new SnapshotOnlyCatalog("fallback")
    const credentials = new FixtureCredentials([
      {
        id: "executor-ref",
        provider: "openai",
        method: "api-key",
        store: "os-keychain",
        locator: "vault:DO-NOT-EXPOSE",
        label: "Executor key",
      },
    ])

    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, { catalog, credentials }),
    )
    const assessment = checks(result)

    expect(result.exitCode).toBe(0)
    expect(catalog.snapshotCalls).toBe(1)
    expect(assessment.get("providers.catalog")).toMatchObject({
      status: "warning",
      required: true,
    })
    expect(assessment.get("credentials.metadata")?.status).toBe("passed")
    expect(assessment.get("profiles.runtime")?.status).toBe("passed")
    const catalogSnapshot = assessment
      .get("providers.catalog")
      ?.message.match(/catalog:[a-f0-9]{64}/)?.[0]
    expect(assessment.get("profiles.runtime")?.message).toContain(catalogSnapshot as string)
    expect(JSON.stringify(result.execution.result)).not.toContain("vault:DO-NOT-EXPOSE")
  })

  test("fails deterministically when a configured credential reference does not exist", async () => {
    const root = await temporaryRoot()
    await writeProfiles(root, [...EXECUTOR_PROFILE, "    credential: missing-ref"])
    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, {
        catalog: new SnapshotOnlyCatalog(),
        credentials: new FixtureCredentials([]),
      }),
    )
    const assessment = checks(result)

    expect(result.exitCode).toBe(1)
    expect(assessment.get("credentials.metadata")?.status).toBe("failed")
    expect(assessment.get("profiles.runtime")?.message).toContain(
      "RALPH_PROFILE_CREDENTIAL_NOT_FOUND",
    )
  })

  test("detects fallback cycles with the runtime profile mapper", async () => {
    const root = await temporaryRoot()
    await writeProfiles(root, [
      "profiles:",
      "  executor-main:",
      "    role: executor",
      "    backend: embedded",
      "    provider: openai",
      "    model: gpt-5.4",
      "    fallback_profiles: [executor-backup]",
      "  executor-backup:",
      "    role: executor",
      "    backend: embedded",
      "    provider: openai",
      "    model: gpt-5.4-mini",
      "    fallback_profiles: [executor-main]",
    ])
    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, { catalog: new SnapshotOnlyCatalog() }),
    )

    expect(result.exitCode).toBe(1)
    expect(checks(result).get("profiles.runtime")?.message).toContain(
      "RALPH_PROFILE_FALLBACK_CYCLE",
    )
  })

  test("detects model capability mismatches and redacts credential-reader failures", async () => {
    const root = await temporaryRoot()
    await writeProfiles(root, [
      ...EXECUTOR_PROFILE,
      "    credential: executor-ref",
      "    requirements:",
      "      minimum_context: 999999999",
    ])
    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, {
        catalog: new SnapshotOnlyCatalog(),
        credentials: new FixtureCredentials([], new Error("vault:SECRET-LOCATOR")),
      }),
    )
    const assessment = checks(result)

    expect(result.exitCode).toBe(1)
    expect(assessment.get("credentials.metadata")?.message).toBe(
      "Credential metadata or status could not be read safely",
    )
    expect(assessment.get("profiles.runtime")?.message).toContain(
      "RALPH_PROFILE_CREDENTIAL_NOT_FOUND",
    )
    expect(JSON.stringify(result.execution.result)).not.toContain("SECRET-LOCATOR")
  })

  test("fails when configured metadata exists but the underlying credential is expired", async () => {
    const root = await temporaryRoot()
    await writeProfiles(root, [...EXECUTOR_PROFILE, "    credential: executor-ref"])
    const credentials = new FixtureCredentials(
      [
        {
          id: "executor-ref",
          provider: "openai",
          method: "api-key",
          store: "os-keychain",
          locator: "vault:must-stay-private",
          label: "Expired executor key",
        },
      ],
      undefined,
      "expired",
    )
    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, { catalog: new SnapshotOnlyCatalog(), credentials }),
    )
    const assessment = checks(result)

    expect(result.exitCode).toBe(1)
    expect(assessment.get("credentials.metadata")).toMatchObject({
      status: "failed",
      required: true,
      message: "1 configured credential reference(s) are not connected",
    })
    expect(assessment.get("profiles.runtime")?.status).toBe("passed")
    expect(JSON.stringify(result.execution.result)).not.toContain("must-stay-private")
  })

  test("detects an incompatible model independently of credential metadata", async () => {
    const root = await temporaryRoot()
    await writeProfiles(root, [
      ...EXECUTOR_PROFILE,
      "    requirements:",
      "      minimum_context: 999999999",
    ])
    const result = await executeCli(
      ["doctor", "--non-interactive", "--format", "json"],
      context(root, { catalog: new SnapshotOnlyCatalog() }),
    )

    expect(result.exitCode).toBe(1)
    expect(checks(result).get("profiles.runtime")?.message).toContain(
      "RALPH_PROFILE_MODEL_CAPABILITY_MISMATCH",
    )
  })
})
