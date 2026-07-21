import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { cp, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { type CommandContext, runCli } from "@ralph/commands"
import { FakeSecretStore, secretInputFromValue } from "@ralph/credentials"
import { RoleProfileConfigSchema } from "@ralph/domain"
import type { FetchLike } from "@ralph/openai-driver"
import { initializeWorkspace, workspaceLayout } from "@ralph/persistence"
import {
  CachedModelCatalog,
  createCuratedCatalogSource,
  InMemoryModelCatalogCache,
} from "@ralph/providers"
import { EventEnvelopeSchema, type OutputWriters } from "@ralph/telemetry"
import { stringify } from "yaml"

import { createS04Services } from "../../apps/ralph-cli/src/s04-services"
import { createS05Services } from "../../apps/ralph-cli/src/s05-services"

const VERSION = "0.1.0-s05-public-embedded-smoke"
const NOW = Date.parse("2026-07-18T20:30:00.000Z")
const CREDENTIAL_ID = "openai-s05-public-embedded"
const PROFILE_ID = "embedded-fixture-executor"
const EXECUTION_FIXTURE = resolve(import.meta.dir, "../fixtures/execution/single-pass")
const temporaryDirectories: string[] = []

setDefaultTimeout(20_000)

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

function captureWriters(): {
  writers: OutputWriters
  stdout: () => string
  stderr: () => string
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    writers: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  }
}

type OpenAiRequestBody = {
  model?: string
  input?: readonly unknown[]
  tools?: readonly { name?: string }[]
}

function requestBody(init: RequestInit | undefined): OpenAiRequestBody {
  if (typeof init?.body !== "string") throw new Error("Expected one JSON Responses request")
  return JSON.parse(init.body) as OpenAiRequestBody
}

function providerToolName(body: OpenAiRequestBody, originalName: string): string {
  const prefix = `ralph_${originalName.replaceAll(".", "_")}_`
  const name = body.tools?.find((tool) => tool.name?.startsWith(prefix))?.name
  if (!name) throw new Error(`Responses request did not materialize ${originalName}`)
  return name
}

function writeToolResponse(body: OpenAiRequestBody): Response {
  return Response.json({
    status: "completed",
    output: [
      {
        type: "function_call",
        id: "fc-public-embedded-write",
        call_id: "tool-public-embedded-write",
        name: providerToolName(body, "fs.write"),
        arguments: JSON.stringify({
          path: "product/capability.txt",
          content: "delivered",
          precondition: { kind: "absent" },
          createParents: true,
        }),
      },
    ],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  })
}

function finalResponse(): Response {
  return Response.json({
    status: "completed",
    output_text: JSON.stringify({
      status: "work_submitted",
      summary: "The embedded public CLI fixture submitted the vertical slice for verification.",
      intendedFiles: ["product/capability.txt"],
      artifactRefs: [],
      suggestedVerifications: [],
      risks: [],
    }),
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
  })
}

function embeddedProfile() {
  return RoleProfileConfigSchema.parse({
    role: "executor",
    backend: "embedded",
    provider: "openai",
    model: "gpt-5.4-mini",
    credential: CREDENTIAL_ID,
    parameters: {},
    requirements: { tools: true, structured_output: true },
    fallback_profiles: [],
    fallback_on: [],
    limits: {},
  })
}

describe("S05 public embedded CLI smoke", () => {
  test("runs once through embedded OpenAI, ToolHost, evidence, gates and completion", async () => {
    const root = await temporaryDirectory("ralph-s05-public-embedded-")
    const dataRoot = await temporaryDirectory("ralph-s05-public-embedded-data-")
    await cp(EXECUTION_FIXTURE, root, { recursive: true })
    await unlink(resolve(root, "product", "capability.txt"))
    await initializeWorkspace(root, VERSION)

    const prdPath = resolve(root, "PRD.md")
    await writeFile(
      prdPath,
      (await readFile(prdPath, "utf8")).replace(
        "model_calls=1; timeout=20s",
        "model_calls=3; tool_calls=2; timeout=20s",
      ),
      "utf8",
    )
    await writeFile(
      workspaceLayout(root).config,
      stringify({
        schema_version: 1,
        profiles: { [PROFILE_ID]: embeddedProfile() },
        security: {
          mode: "safe",
          headless_ask: "deny",
          tool_rules: { "fs.write": "allow" },
          allowed_commands: [],
          read_paths: ["."],
          write_paths: ["product"],
          allow_shell: false,
        },
      }),
      "utf8",
    )

    const requests: OpenAiRequestBody[] = []
    const requestedUrls: string[] = []
    const modelFetch: FetchLike = async (url, init) => {
      requestedUrls.push(String(url))
      const body = requestBody(init)
      requests.push(body)
      if (requests.length === 1) return writeToolResponse(body)
      if (requests.length === 2) return finalResponse()
      throw new Error("Embedded public CLI smoke attempted an unexpected model call")
    }
    const catalog = new CachedModelCatalog({
      source: createCuratedCatalogSource(),
      cache: new InMemoryModelCatalogCache(),
      ttlMs: 86_400_000,
      clock: () => new Date(NOW),
    })
    const keychain = new FakeSecretStore()
    const environment = { RALPH_CONFIG_HOME: resolve(dataRoot, "isolated-global-config") }
    const s04 = createS04Services({
      environment,
      dataRoot,
      catalogFactory: () => catalog,
      modelFetch,
      keychainStore: keychain,
      readSecretStdin: async () => secretInputFromValue("sk-s05-public-embedded-fixture"),
      now: () => NOW,
    })
    const catalogHandle = await s04.credentials.catalogSnapshot()
    const providerInfo = catalogHandle.resolution.snapshot.providers.find(
      (provider) => provider.id === "openai",
    )
    if (!providerInfo) throw new Error("Curated OpenAI provider is unavailable")
    await s04.credentials.connect({
      provider: "openai",
      method: "api-key",
      credentialId: CREDENTIAL_ID,
      label: "S05 public embedded fixture key",
      nonInteractive: true,
      headless: true,
      secretSource: "stdin",
      allowInsecureStore: false,
      providerInfo,
      catalogHandle,
    })
    const s05 = createS05Services({ s04, environment, modelFetch, now: () => NOW })
    const context: CommandContext = {
      version: VERSION,
      cwd: root,
      environment,
      interactive: false,
      resolveModelCatalog: s04.resolveModelCatalog,
      credentials: s04.credentials,
      profileForm: s04.profileForm,
      modelSmoke: s04.modelSmoke,
      resolveBackend: s05.resolveBackend,
      toolPort: s05.toolPort,
    }
    const executionCapture = captureWriters()

    const exitCode = await runCli(
      [
        "once",
        "--workspace",
        root,
        "--prd",
        "PRD.md",
        "--executor-profile",
        PROFILE_ID,
        "--headless-ask",
        "deny",
        "--retry-delay",
        "0",
        "--no-change-policy",
        "fail-fast",
        "--no-change-max-retries",
        "0",
        "--format",
        "json",
      ],
      context,
      executionCapture.writers,
    )

    expect(exitCode).toBe(0)
    expect(executionCapture.stderr()).toBe("")
    const execution = JSON.parse(executionCapture.stdout()) as {
      ok: boolean
      command: string
      runId: string
      data: { kind: string; status: string }
    }
    expect(execution).toMatchObject({
      ok: true,
      command: "once",
      data: { kind: "executed", status: "completed" },
    })
    expect(await readFile(resolve(root, "product", "capability.txt"), "utf8")).toBe("delivered")
    expect(await readFile(prdPath, "utf8")).toContain("- [x] **deliver-capability")
    expect(requests).toHaveLength(2)
    expect(requests[1]?.input).toContainEqual(
      expect.objectContaining({
        type: "function_call_output",
        call_id: "tool-public-embedded-write",
      }),
    )
    expect(requestedUrls).toHaveLength(2)
    expect(requestedUrls.every((url) => url.startsWith("https://"))).toBeTrue()

    const eventsCapture = captureWriters()
    expect(
      await runCli(
        ["events", "--workspace", root, "--run-id", execution.runId, "--format", "jsonl"],
        context,
        eventsCapture.writers,
      ),
    ).toBe(0)
    expect(eventsCapture.stderr()).toBe("")
    const events = eventsCapture
      .stdout()
      .trim()
      .split(/\r?\n/)
      .map((line) => EventEnvelopeSchema.parse(JSON.parse(line)))
    const completion = events.find((event) => event.type === "task.completed")
    const completedGates = events.filter((event) => event.type === "gate.completed")
    const decision = events.find((event) => event.type === "verification.decision")
    expect(events.some((event) => event.type === "tool.call.settled")).toBeTrue()
    expect(completedGates.length).toBeGreaterThan(0)
    expect(decision).toBeDefined()
    expect(completion).toBeDefined()
    expect(completedGates.every((gate) => gate.sequence < (decision?.sequence ?? 0))).toBeTrue()
    expect((decision?.sequence ?? 0) < (completion?.sequence ?? 0)).toBeTrue()
  })
})
