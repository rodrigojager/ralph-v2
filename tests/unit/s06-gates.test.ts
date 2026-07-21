import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { type VerificationSpec, VerificationSpecSchema } from "@ralph/prd"
import {
  collectArtifactEvidence,
  createDefaultGateExecutorRegistry,
  runVerification,
  runVerifications,
} from "@ralph/verification"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

async function runGit(root: string, args: string[]): Promise<void> {
  const git = Bun.which("git")
  if (!git) throw new Error("Git is required by the S06 git gate test")
  const child = Bun.spawn([git, ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  })
  const exitCode = await child.exited
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`)
  }
}

function pluginGate(
  id: string,
  plugin: string,
  overrides: Partial<Extract<VerificationSpec, { type: "plugin" }>> = {},
): Extract<VerificationSpec, { type: "plugin" }> {
  return VerificationSpecSchema.parse({
    type: "plugin",
    id,
    plugin,
    input: {},
    category: "plugin",
    skipPolicy: "required",
    blocking: true,
    ...overrides,
  }) as Extract<VerificationSpec, { type: "plugin" }>
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("S06 gate registry and pipeline", () => {
  test("registers explicit namespaced plugins and preserves retry/skip metadata", async () => {
    const root = await temporaryDirectory()
    let calls = 0
    const registry = createDefaultGateExecutorRegistry().registerPlugin(
      "acme/contract-audit",
      async () => {
        calls += 1
        return calls === 1
          ? { status: "failed", reason: "first attempt is incomplete" }
          : { status: "passed" }
      },
    )
    const result = await runVerification(
      pluginGate("contract", "acme/contract-audit", { attempts: 2 }),
      { workspaceRoot: root, registry },
    )

    expect(result).toMatchObject({
      status: "passed",
      attempts: 2,
      skipPolicy: "required",
      overridden: false,
    })
    expect(registry.pluginKeys()).toEqual(["plugin:acme/contract-audit"])
    await expect(
      runVerification(pluginGate("missing", "acme/missing"), { workspaceRoot: root, registry }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "Verification plugin is not registered: plugin:acme/missing",
    })
    expect(() =>
      registry.registerPlugin("acme/contract-audit", async () => ({ status: "passed" })),
    ).toThrow("already registered")
  })

  test("emits not_applicable before invoking an executor when platform or conditions do not match", async () => {
    const root = await temporaryDirectory()
    let calls = 0
    const registry = createDefaultGateExecutorRegistry().registerPlugin(
      "acme/platform",
      async () => {
        calls += 1
        return { status: "passed" }
      },
    )
    const platform = await runVerification(
      pluginGate("platform", "acme/platform", {
        applicability: { platforms: ["linux"] },
      }),
      { workspaceRoot: root, platform: "win32", registry },
    )
    const changed = await runVerification(
      pluginGate("changed", "acme/platform", {
        applicability: {
          conditions: [{ kind: "path-changed", path: "src", match: "prefix" }],
        },
      }),
      { workspaceRoot: root, changedPaths: new Set(["docs/readme.md"]), registry },
    )

    expect(platform).toMatchObject({ status: "not_applicable", attempts: 0 })
    expect(changed).toMatchObject({ status: "not_applicable", attempts: 0 })
    expect(calls).toBe(0)
  })

  test("bounds a plugin attempt by gate timeout and propagates AbortSignal", async () => {
    const root = await temporaryDirectory()
    let aborted = false
    const registry = createDefaultGateExecutorRegistry().registerPlugin(
      "acme/slow",
      async (_specification, context) =>
        new Promise((resolveOutcome) => {
          context.signal.addEventListener(
            "abort",
            () => {
              aborted = true
              resolveOutcome({ status: "error", reason: "aborted" })
            },
            { once: true },
          )
        }),
    )
    const result = await runVerification(pluginGate("slow", "acme/slow", { timeoutMs: 20 }), {
      workspaceRoot: root,
      registry,
    })

    expect(result).toMatchObject({ status: "timeout", attempts: 1, deadlineExceeded: false })
    expect(aborted).toBeTrue()
  })

  test("fail-fast preserves one auditable result per declared gate", async () => {
    const root = await temporaryDirectory()
    let secondCalls = 0
    const registry = createDefaultGateExecutorRegistry()
      .registerPlugin("acme/fail", async () => ({ status: "failed", reason: "blocked" }))
      .registerPlugin("acme/second", async () => {
        secondCalls += 1
        return { status: "passed" }
      })
    const results = await runVerifications(
      [pluginGate("first", "acme/fail"), pluginGate("second", "acme/second")],
      { workspaceRoot: root, registry, failFast: true },
    )

    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ status: "failed", attempts: 1 })
    expect(results[1]).toMatchObject({ status: "skipped_by_policy", attempts: 0 })
    expect(results[1]?.reason).toContain("fail-fast")
    expect(secondCalls).toBe(0)
  })

  test("noGates skips authorized gates but still executes required gates without force", async () => {
    const root = await temporaryDirectory()
    let requiredCalls = 0
    const registry = createDefaultGateExecutorRegistry()
      .registerPlugin("acme/allowed", async () => ({ status: "passed" }))
      .registerPlugin("acme/required", async () => {
        requiredCalls += 1
        return { status: "passed" }
      })
    const allowed = pluginGate("allowed", "acme/allowed", {
      skipPolicy: "allowed-to-skip",
    })
    const required = pluginGate("required", "acme/required")
    const results = await runVerifications([allowed, required], {
      workspaceRoot: root,
      registry,
      noGates: true,
      failFast: true,
    })
    const forced = await runVerification(required, {
      workspaceRoot: root,
      registry,
      noGates: true,
      force: true,
    })

    expect(results[0]).toMatchObject({ status: "skipped_by_cli", overridden: false })
    expect(results[1]).toMatchObject({ status: "passed" })
    expect(requiredCalls).toBe(1)
    expect(forced).toMatchObject({ status: "skipped_by_cli", overridden: true })
  })
})

describe("S06 schema, artifact and git gates", () => {
  test("validates schema gates, file schema expectations and artifact hash/schema evidence", async () => {
    const root = await temporaryDirectory()
    const schema = {
      type: "object",
      required: ["enabled"],
      properties: { enabled: { type: "boolean" } },
      additionalProperties: false,
    }
    await writeFile(resolve(root, "contract.schema.json"), JSON.stringify(schema))
    await writeFile(resolve(root, "valid.json"), JSON.stringify({ enabled: true }))
    await writeFile(resolve(root, "invalid.json"), JSON.stringify({ enabled: "yes" }))
    const validHash = createHash("sha256")
      .update(JSON.stringify({ enabled: true }))
      .digest("hex")
    const schemaGate = VerificationSpecSchema.parse({
      type: "schema",
      id: "schema-valid",
      path: "valid.json",
      schema: "contract.schema.json",
      category: "schema",
      skipPolicy: "required",
      blocking: true,
    })
    const invalidSchemaGate = VerificationSpecSchema.parse({
      ...schemaGate,
      id: "schema-invalid",
      path: "invalid.json",
    })
    const fileGate = VerificationSpecSchema.parse({
      type: "file",
      id: "file-schema",
      path: "valid.json",
      expectation: { kind: "json-schema", schema: "contract.schema.json" },
      category: "file",
      skipPolicy: "required",
      blocking: true,
    })
    const artifact = VerificationSpecSchema.parse({
      type: "artifact",
      id: "artifact-valid",
      artifactId: "contract",
      path: "valid.json",
      schema: "contract.schema.json",
      expectedSha256: validHash,
      category: "artifact",
      skipPolicy: "required",
      blocking: true,
    })

    await expect(runVerification(schemaGate, { workspaceRoot: root })).resolves.toMatchObject({
      status: "passed",
    })
    await expect(
      runVerification(invalidSchemaGate, { workspaceRoot: root }),
    ).resolves.toMatchObject({ status: "failed" })
    await expect(runVerification(fileGate, { workspaceRoot: root })).resolves.toMatchObject({
      status: "passed",
    })
    await expect(runVerification(artifact, { workspaceRoot: root })).resolves.toMatchObject({
      status: "passed",
    })
    await expect(
      runVerification(
        VerificationSpecSchema.parse({ ...artifact, expectedSha256: "0".repeat(64) }),
        { workspaceRoot: root },
      ),
    ).resolves.toMatchObject({ status: "failed" })

    const artifactEvidence = await collectArtifactEvidence(root, [artifact], {
      objectStore: { directory: resolve(root, ".ralph", "objects") },
    })
    expect(artifactEvidence[0]).toMatchObject({
      status: "passed",
      validation: { status: "passed", schemaRef: "contract.schema.json" },
      contentHash: validHash,
    })
    const mismatchedEvidence = await collectArtifactEvidence(
      root,
      [VerificationSpecSchema.parse({ ...artifact, expectedSha256: "0".repeat(64) })],
      { objectStore: { directory: resolve(root, ".ralph", "mismatched-objects") } },
    )
    expect(mismatchedEvidence[0]).toMatchObject({
      status: "failed",
      validation: { status: "unavailable" },
    })
    expect(mismatchedEvidence[0]?.reason).toContain("Artifact hash mismatch")

    const schemaMismatchArtifact = VerificationSpecSchema.parse({
      ...artifact,
      id: "artifact-schema-mismatch",
      path: "invalid.json",
      expectedSha256: undefined,
    })
    const schemaMismatchEvidence = await collectArtifactEvidence(root, [schemaMismatchArtifact], {
      objectStore: { directory: resolve(root, ".ralph", "schema-mismatch-objects") },
    })
    expect(schemaMismatchEvidence[0]).toMatchObject({
      status: "failed",
      validation: { status: "failed", schemaRef: "contract.schema.json" },
    })
    await expect(
      runVerification(schemaMismatchArtifact, { workspaceRoot: root }),
    ).resolves.toMatchObject({ status: "failed" })

    await writeFile(resolve(root, "broken.schema.json"), "{not-json")
    const invalidSchemaArtifact = VerificationSpecSchema.parse({
      ...artifact,
      id: "artifact-invalid-schema",
      schema: "broken.schema.json",
      expectedSha256: undefined,
    })
    const invalidSchemaEvidence = await collectArtifactEvidence(root, [invalidSchemaArtifact], {
      objectStore: { directory: resolve(root, ".ralph", "invalid-schema-objects") },
    })
    expect(invalidSchemaEvidence[0]).toMatchObject({
      status: "failed",
      validation: { status: "unavailable", schemaRef: "broken.schema.json" },
    })
    await expect(
      runVerification(invalidSchemaArtifact, { workspaceRoot: root }),
    ).resolves.toMatchObject({ status: "error" })
  })

  test("evaluates clean, changed, branch and allowed-path Git facts", async () => {
    const root = await temporaryDirectory()
    await runGit(root, ["init"])
    await runGit(root, ["config", "user.email", "ralph-test@example.invalid"])
    await runGit(root, ["config", "user.name", "Ralph Test"])
    await writeFile(resolve(root, "tracked.txt"), "baseline\n")
    await runGit(root, ["add", "tracked.txt"])
    await runGit(root, ["commit", "-m", "baseline"])
    const branchChild = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const branch = (await new Response(branchChild.stdout).text()).trim()
    expect(await branchChild.exited).toBe(0)

    const gitGate = (expectation: unknown, id: string) =>
      VerificationSpecSchema.parse({
        type: "git",
        id,
        expectation,
        category: "git",
        skipPolicy: "required",
        blocking: true,
      })
    await expect(
      runVerification(gitGate({ kind: "clean" }, "clean"), { workspaceRoot: root }),
    ).resolves.toMatchObject({ status: "passed" })
    await expect(
      runVerification(gitGate({ kind: "branch", value: branch }, "branch"), {
        workspaceRoot: root,
      }),
    ).resolves.toMatchObject({ status: "passed" })

    await writeFile(resolve(root, "tracked.txt"), "changed\n")
    await expect(
      runVerification(gitGate({ kind: "changed" }, "changed"), { workspaceRoot: root }),
    ).resolves.toMatchObject({ status: "passed" })
    await expect(
      runVerification(
        gitGate({ kind: "paths-within", paths: ["tracked.txt"], requireChanges: true }, "paths"),
        { workspaceRoot: root },
      ),
    ).resolves.toMatchObject({ status: "passed" })
  })
})
