import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { cp, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { FakeSecretStore } from "@ralph/credentials"
import { RoleProfileConfigSchema } from "@ralph/domain"
import { executeRun, resolveEffectiveRunOptions } from "@ralph/orchestration"
import {
  initializeWorkspace,
  listAttempts,
  loadEffectiveConfig,
  readEvents,
  workspaceLayout,
} from "@ralph/persistence"
import { compilePrdGraph } from "@ralph/prd"
import {
  CachedModelCatalog,
  createCuratedCatalogSource,
  InMemoryModelCatalogCache,
} from "@ralph/providers"
import { stringify } from "yaml"

import { createS04Services } from "../../apps/ralph-cli/src/s04-services"
import { createS05Services } from "../../apps/ralph-cli/src/s05-services"

const temporaryDirectories: string[] = []

// Windows quality runners can be heavily contended while the full integration suite is active.
// Keep this vertical protocol test bounded without letting runner latency preempt its assertions.
setDefaultTimeout(120_000)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function testDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

describe("S05 external CLI vertical execution", () => {
  test("settles a protocol tool call through Ralph and completes only after evidence and gates", async () => {
    const workspaceRoot = await testDirectory("ralph-s05-e2e-")
    const dataRoot = await testDirectory("ralph-s05-data-")
    await cp(resolve("tests", "fixtures", "execution", "single-pass"), workspaceRoot, {
      recursive: true,
    })
    await unlink(resolve(workspaceRoot, "product", "capability.txt"))
    await initializeWorkspace(workspaceRoot, "0.1.0-test")
    const prdPath = resolve(workspaceRoot, "PRD.md")
    await writeFile(
      prdPath,
      (await readFile(prdPath, "utf8")).replace(
        "model_calls=1; timeout=20s",
        "model_calls=3; tool_calls=2; timeout=60s",
      ),
    )

    const profile = RoleProfileConfigSchema.parse({
      role: "executor",
      backend: "external-cli",
      provider: "external-fixture",
      model: "protocol-v1",
      parameters: {},
      requirements: {},
      fallback_profiles: [],
      fallback_on: [],
      limits: {},
      external_cli: {
        executable: process.execPath,
        args: [resolve("tests", "fixtures", "s05", "external-protocol-fixture.ts")],
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
        output_limit_bytes: 1_048_576,
      },
    })
    const layout = workspaceLayout(workspaceRoot)
    await writeFile(
      layout.config,
      stringify({
        schema_version: 1,
        profiles: { "fixture-executor": profile },
        security: {
          mode: "auto",
          headless_ask: "deny",
          tool_rules: { "fs.write": "allow" },
          allowed_commands: [],
          read_paths: ["."],
          write_paths: ["product"],
          allow_shell: false,
        },
      }),
    )

    const catalog = new CachedModelCatalog({
      source: createCuratedCatalogSource(),
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 86_400_000,
      clock: () => new Date("2026-07-18T15:00:00.000Z"),
    })
    const s04 = createS04Services({
      environment: {},
      dataRoot,
      catalogFactory: () => catalog,
      keychainStore: new FakeSecretStore(),
      now: () => Date.parse("2026-07-18T15:00:00.000Z"),
    })
    const s05 = createS05Services({ s04, environment: {} })
    const compiled = await compilePrdGraph(prdPath, {
      workspaceRoot,
      recursive: true,
      strict: true,
    })
    if (!compiled.ok || !compiled.graph) throw new Error("S05 fixture did not compile")
    const reference = compiled.graph.topologicalOrder[0]
    if (!reference) throw new Error("S05 fixture has no task")
    const document = compiled.graph.documents[reference.documentId]
    const task = document?.tasks.find((candidate) => candidate.id === reference.taskId)
    if (!document || !task) throw new Error("S05 fixture task was not found")
    const config = await loadEffectiveConfig({ workspaceConfig: layout.config, environment: {} })
    const cli = {
      mode: "once" as const,
      delayMs: 0,
      noChangePolicy: "fail-on-no-change" as const,
      maxNoChangeAttempts: 0,
    }
    const effective = resolveEffectiveRunOptions({ config, document, task, cli })

    const result = await executeRun({
      workspaceRoot,
      prdFile: "PRD.md",
      effectiveOptions: effective.options,
      optionResolution: { config, cli },
      environment: {},
      dependencies: {
        resolveBackend: s05.resolveBackend,
        toolPort: s05.toolPort,
      },
    })

    expect(result).toMatchObject({ status: "completed", exitCode: 0 })
    expect(await readFile(resolve(workspaceRoot, "product", "capability.txt"), "utf8")).toBe(
      "delivered",
    )
    expect(await readFile(prdPath, "utf8")).toContain("- [x] **deliver-capability")
    const attempt = listAttempts(layout.ledger, { runId: result.runId as string })[0]
    expect(attempt?.counters).toMatchObject({ modelCalls: 2, toolCalls: 1 })
    const eventTypes = readEvents(layout.ledger).map((event) => event.type)
    expect(eventTypes).toContain("external.cli.started")
    expect(eventTypes).toContain("tool.call.settled")
    expect(eventTypes).toContain("task.completed")
  })
})
