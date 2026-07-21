import { afterEach, describe, expect, test } from "bun:test"

import { FakeSecretStore, secretInputFromValue } from "@ralph/credentials"
import {
  cloneDefaultConfig,
  type EffectiveConfig,
  type EffectiveRunOptions,
  type RoleProfileConfig,
  RoleProfileConfigSchema,
} from "@ralph/domain"
import type { JudgeRequest } from "@ralph/evaluation"
import { JUDGE_OUTPUT_JSON_ADAPTER_ID } from "@ralph/model-drivers"
import type { FetchLike } from "@ralph/openai-driver"
import type {
  BackendEvent,
  ExecutionChannel,
  ExecutionRequest,
  ExecutionToolResult,
} from "@ralph/orchestration"
import { initializeWorkspace } from "@ralph/persistence"
import {
  CachedModelCatalog,
  createCuratedCatalogSource,
  InMemoryModelCatalogCache,
  type ProviderToolCall,
} from "@ralph/providers"
import { createTestDirectory, removeTestDirectory } from "../../../tests/helpers/temp-directory"
import { createS04Services } from "../src/s04-services"
import { createS05Services } from "../src/s05-services"

const temporaryDirectories: string[] = []
const NOW = Date.parse("2026-07-18T12:00:00.000Z")
const JUDGE_CREDENTIAL_ID = "judge-openai-s05"
const JUDGE_OUTPUT = {
  schemaVersion: 1 as const,
  score: 91,
  summary: "The bounded evidence satisfies the task.",
  adequate: ["The declared result is supported."],
  problems: [],
  missingEvidence: [],
  recommendations: [],
  criterionScores: [{ criterion: "criterion-1", score: 91 }],
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function temporaryWorkspace(): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await initializeWorkspace(root, "0.1.0-test")
  return root
}

function externalProfile(input: {
  script: string
  fallbackProfiles?: readonly string[]
  fallbackOn?: readonly string[]
  adapter?: "generic" | "known-output"
  adapterId?: string
}): RoleProfileConfig {
  return RoleProfileConfigSchema.parse({
    role: "executor",
    backend: "external-cli",
    provider: "fixture-provider",
    model: "fixture-model",
    parameters: {},
    requirements: {},
    fallback_profiles: input.fallbackProfiles ?? [],
    fallback_on: input.fallbackOn ?? [],
    limits: {},
    external_cli: {
      executable: process.execPath,
      args: ["-e", input.script],
      cwd: ".",
      environment_refs: {},
      input_mode: "stdin-json",
      adapter: input.adapter ?? "generic",
      ...(input.adapterId ? { adapter_id: input.adapterId } : {}),
      capabilities: {
        streaming: false,
        tool_calling: "unavailable",
        cancellation: true,
        usage: "unavailable",
      },
      mutation_mode: "read-only",
      timeout_ms: 5_000,
      output_limit_bytes: 64 * 1_024,
    },
  })
}

function judgeCompatibleExternalProfile(role: "executor" | "judge"): RoleProfileConfig {
  return RoleProfileConfigSchema.parse({
    role,
    backend: "external-cli",
    provider: "fixture-provider",
    model: "fixture-judge",
    parameters: {},
    requirements: { structured_output: true },
    fallback_profiles: [],
    fallback_on: [],
    limits: {},
    external_cli: {
      executable: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(JUDGE_OUTPUT))})`],
      cwd: ".",
      environment_refs: {},
      input_mode: "stdin-json",
      adapter: "known-output",
      adapter_id: JUDGE_OUTPUT_JSON_ADAPTER_ID,
      capabilities: {
        streaming: false,
        tool_calling: "unavailable",
        cancellation: true,
        usage: "unavailable",
      },
      mutation_mode: "read-only",
      timeout_ms: 5_000,
      output_limit_bytes: 64 * 1_024,
    },
  })
}

function embeddedJudgeProfile(role: "executor" | "judge"): RoleProfileConfig {
  return RoleProfileConfigSchema.parse({
    role,
    backend: "embedded",
    provider: "openai",
    model: "gpt-5.4-mini",
    credential: JUDGE_CREDENTIAL_ID,
    parameters: {},
    requirements: { input: ["text"], structured_output: true },
    fallback_profiles: [],
    fallback_on: [],
    limits: { max_output_tokens: 2_048 },
  })
}

function effectiveConfig(profiles: Readonly<Record<string, RoleProfileConfig>>): EffectiveConfig {
  const config = cloneDefaultConfig()
  config.profiles = { ...profiles }
  return { config, values: {} }
}

function request(workspaceRoot: string): ExecutionRequest {
  return {
    runId: "run-s05-services",
    documentId: "prd",
    taskId: "slice",
    attemptId: "attempt-1",
    modelCallId: "model-call-outer",
    callOrdinal: 1,
    workspaceRoot,
    contextManifest: {} as ExecutionRequest["contextManifest"],
    contextBundle: {
      manifest: {} as ExecutionRequest["contextManifest"],
      resources: [],
      truncations: [],
      canonicalJson: '{"task":"slice"}',
    },
    task: {} as ExecutionRequest["task"],
    protectedPaths: ["PRD.md"],
  }
}

function judgeRequest(kind: "external" | "self" = "external"): JudgeRequest {
  return {
    callId: `judge-call-${kind}`,
    kind,
    evidenceBundleId: "evidence-s05",
    bundle: {} as JudgeRequest["bundle"],
    prompt: {
      system: "Evaluate the evidence read-only. Never call tools.",
      user: "Return the bounded assessment.",
    },
  }
}

function channel(maximumModelCalls = 3) {
  const providerCalls: string[] = []
  const events: BackendEvent[] = []
  const target: ExecutionChannel = {
    emit(event) {
      events.push(event)
    },
    async reserveModelCall(input) {
      if (providerCalls.includes(input.callId)) throw new Error(`duplicate call: ${input.callId}`)
      if (providerCalls.length >= maximumModelCalls) throw new Error("model budget exceeded")
      providerCalls.push(input.callId)
    },
    async tools() {
      return []
    },
    async executeTool(call: ProviderToolCall): Promise<ExecutionToolResult> {
      throw new Error(`unexpected tool: ${call.name}`)
    },
    stats() {
      return {
        modelCalls: providerCalls.length,
        maximumModelCalls,
        toolCalls: 0,
        maximumToolCalls: 0,
      }
    },
  }
  return { target, providerCalls, events }
}

function services(workspaceRoot: string) {
  const dataRoot = `${workspaceRoot}-data`
  temporaryDirectories.push(dataRoot)
  return createS05Services({
    s04: createS04Services({
      environment: {},
      dataRoot,
      keychainStore: new FakeSecretStore(),
    }),
    environment: {},
    now: () => NOW,
  })
}

async function servicesWithEmbeddedCredential(workspaceRoot: string, modelFetch: FetchLike) {
  const dataRoot = `${workspaceRoot}-embedded-judge-data`
  temporaryDirectories.push(dataRoot)
  const catalog = new CachedModelCatalog({
    source: createCuratedCatalogSource(),
    cache: new InMemoryModelCatalogCache(),
    ttlMs: 86_400_000,
    clock: () => new Date(NOW),
  })
  const s04 = createS04Services({
    environment: {},
    dataRoot,
    catalogFactory: () => catalog,
    modelFetch,
    keychainStore: new FakeSecretStore(),
    readSecretStdin: async () => secretInputFromValue("sk-s05-judge-test"),
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
    credentialId: JUDGE_CREDENTIAL_ID,
    label: "S05 judge fixture",
    nonInteractive: true,
    headless: true,
    secretSource: "stdin",
    allowInsecureStore: false,
    providerInfo,
    catalogHandle,
  })
  return createS05Services({ s04, environment: {}, modelFetch, now: () => NOW })
}

describe("S05 command composition", () => {
  test("uses distinct provider-call identities and succeeds through an authorized transient fallback", async () => {
    const workspaceRoot = await temporaryWorkspace()
    const profiles = {
      primary: externalProfile({
        script: "process.exit(17)",
        fallbackProfiles: ["secondary"],
        fallbackOn: ["transient"],
      }),
      secondary: externalProfile({ script: "process.stdout.write('fallback delivered')" }),
    }
    const backend = await services(workspaceRoot).resolveBackend("primary", {
      workspaceRoot,
      effectiveOptions: {} as EffectiveRunOptions,
      dryRun: false,
      config: effectiveConfig(profiles),
    })
    if (!backend) throw new Error("fallback backend was not resolved")
    const execution = channel(2)

    const outcome = await (await backend.start(request(workspaceRoot), execution.target)).outcome

    expect(outcome.summary).toBe("fallback delivered")
    expect(execution.providerCalls).toHaveLength(2)
    expect(new Set(execution.providerCalls).size).toBe(2)
    expect(execution.target.stats()).toMatchObject({ modelCalls: 2, maximumModelCalls: 2 })
    expect(execution.events.some((event) => event.type === "model.provider.warning")).toBeTrue()
    const settlements = execution.events.filter((event) => event.type === "external.cli.settled")
    const outputRefs = settlements.at(-1)?.payload?.outputRefs as string[] | undefined
    expect(outputRefs?.length).toBeGreaterThan(0)
    expect(
      outputRefs?.every((ref) =>
        /^run-raw:\/\/run-s05-services\/process\/[0-9a-f]{64}\/stream$/.test(ref),
      ),
    ).toBeTrue()
  })

  test("uses the command snapshot and ignores an unrelated invalid judge profile", async () => {
    const workspaceRoot = await temporaryWorkspace()
    const profiles = {
      executor: externalProfile({ script: "process.stdout.write('snapshot executor')" }),
      brokenJudge: RoleProfileConfigSchema.parse({
        role: "judge",
        backend: "embedded",
        provider: "missing-provider",
        model: "missing-model",
        parameters: {},
        requirements: {},
        fallback_profiles: [],
        fallback_on: [],
        limits: {},
      }),
    }
    const backend = await services(workspaceRoot).resolveBackend("executor", {
      workspaceRoot,
      effectiveOptions: {} as EffectiveRunOptions,
      dryRun: false,
      config: effectiveConfig(profiles),
    })
    if (!backend) throw new Error("snapshot executor was not resolved")

    const outcome = await (await backend.start(request(workspaceRoot), channel().target)).outcome

    expect(outcome.summary).toBe("snapshot executor")
  })

  test("wires the built-in known-output adapter through the real composition", async () => {
    const workspaceRoot = await temporaryWorkspace()
    const output = JSON.stringify({
      schemaVersion: 1,
      status: "work_submitted",
      summary: "known output",
      intendedFiles: [],
      artifactRefs: [],
      suggestedVerifications: [],
      risks: [],
      reportedAt: "2000-01-01T00:00:00.000Z",
    })
    const profile = externalProfile({
      script: `process.stdout.write(${JSON.stringify(output)})`,
      adapter: "known-output",
      adapterId: "executor-outcome-json-v1",
    })
    const backend = await services(workspaceRoot).resolveBackend("known", {
      workspaceRoot,
      effectiveOptions: {} as EffectiveRunOptions,
      dryRun: false,
      config: effectiveConfig({ known: profile }),
    })
    if (!backend) throw new Error("known-output backend was not resolved")

    const outcome = await (await backend.start(request(workspaceRoot), channel(1).target)).outcome

    expect(outcome).toMatchObject({
      summary: "known output",
      status: "work_submitted",
      reportedAt: "2026-07-18T12:00:00.000Z",
    })
  })

  test("dry-run rejects a missing executable without touching credentials or catalog", async () => {
    const workspaceRoot = await temporaryWorkspace()
    const profile = externalProfile({ script: "process.stdout.write('unused')" })
    if (!profile.external_cli) throw new Error("external fixture config disappeared")
    profile.external_cli.executable = "ralph-definitely-missing-executable-s05"
    const s05 = services(workspaceRoot)

    const backend = await s05.resolveBackend("missing", {
      workspaceRoot,
      effectiveOptions: {} as EffectiveRunOptions,
      dryRun: true,
      config: effectiveConfig({ missing: profile }),
    })

    expect(backend).toBeUndefined()
  })

  test("dry-run fails closed on external v1 capabilities that execution cannot honor", async () => {
    const workspaceRoot = await temporaryWorkspace()
    const profile = externalProfile({ script: "process.stdout.write('unused')" })
    if (!profile.external_cli) throw new Error("external fixture config disappeared")
    profile.external_cli.capabilities.streaming = true
    profile.external_cli.capabilities.usage = "reported"
    profile.external_cli.mutation_mode = "workspace"
    const s05 = services(workspaceRoot)

    await expect(
      s05.resolveBackend("invalid-v1", {
        workspaceRoot,
        effectiveOptions: {} as EffectiveRunOptions,
        dryRun: true,
        config: effectiveConfig({ "invalid-v1": profile }),
      }),
    ).rejects.toThrow("Direct external CLI workspace mutation is unavailable")
  })

  test("resolves an independent external judge through the isolated read-only CLI backend", async () => {
    const workspaceRoot = await temporaryWorkspace()
    const profile = judgeCompatibleExternalProfile("judge")
    const s05 = services(workspaceRoot)
    const backend = await s05.resolveJudge("reviewer", {
      workspaceRoot,
      runId: "run-s05-services",
      kind: "external",
      effectiveOptions: {} as EffectiveRunOptions,
      dryRun: false,
      config: effectiveConfig({ reviewer: profile }),
    })
    if (!backend) throw new Error("External judge backend was not resolved")
    const events: string[] = []

    const outcome = await (
      await backend.start(judgeRequest(), {
        emit(event) {
          events.push(event.type)
        },
      })
    ).outcome

    expect(outcome).toEqual(JUDGE_OUTPUT)
    expect(backend.capabilities()).toMatchObject({
      toolCalling: "unavailable",
      mutationMode: "read-only",
      structuredOutput: true,
    })
    expect(events).toContain("judge.external.started")
    expect(events).toContain("judge.external.settled")
  })

  test("uses judge profiles for external review and executor profiles for self-review", async () => {
    const workspaceRoot = await temporaryWorkspace()
    const s05 = services(workspaceRoot)
    const config = effectiveConfig({
      reviewer: judgeCompatibleExternalProfile("judge"),
      executor: judgeCompatibleExternalProfile("executor"),
    })
    const base = {
      workspaceRoot,
      effectiveOptions: {} as EffectiveRunOptions,
      dryRun: true,
      config,
    }

    const external = await s05.resolveJudge("reviewer", { ...base, kind: "external" })
    const self = await s05.resolveJudge("executor", { ...base, kind: "self" })

    expect(external?.id).toBe("dry-run-judge:reviewer")
    expect(self?.id).toBe("dry-run-judge:executor")
    expect(external?.capabilities()).toMatchObject({
      toolCalling: "unavailable",
      mutationMode: "read-only",
    })
    await expect(s05.resolveJudge("executor", { ...base, kind: "external" })).rejects.toThrow(
      "requires a judge profile",
    )
    await expect(s05.resolveJudge("reviewer", { ...base, kind: "self" })).rejects.toThrow(
      "requires a executor profile",
    )
  })

  test("dry-run validates an embedded judge without invoking the model", async () => {
    const workspaceRoot = await temporaryWorkspace()
    let modelCalls = 0
    const modelFetch: FetchLike = async () => {
      modelCalls += 1
      throw new Error("dry-run must not invoke the judge model")
    }
    const s05 = await servicesWithEmbeddedCredential(workspaceRoot, modelFetch)

    const backend = await s05.resolveJudge("reviewer", {
      workspaceRoot,
      kind: "external",
      effectiveOptions: {} as EffectiveRunOptions,
      dryRun: true,
      config: effectiveConfig({ reviewer: embeddedJudgeProfile("judge") }),
    })

    expect(backend?.id).toBe("dry-run-judge:reviewer")
    expect(backend?.capabilities()).toMatchObject({
      toolCalling: "unavailable",
      mutationMode: "read-only",
      structuredOutput: true,
    })
    expect(modelCalls).toBe(0)
    if (!backend) throw new Error("Embedded judge dry-run backend was not resolved")
    await expect(backend.start(judgeRequest(), { emit() {} })).rejects.toThrow(
      "dry-run judge backend cannot be invoked",
    )
    expect(modelCalls).toBe(0)
  })

  test("materializes the embedded judge with structured output and no tools", async () => {
    const workspaceRoot = await temporaryWorkspace()
    const requests: Record<string, unknown>[] = []
    const modelFetch: FetchLike = async (_url, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected one JSON model request")
      requests.push(JSON.parse(init.body) as Record<string, unknown>)
      return Response.json({
        status: "completed",
        output_text: JSON.stringify(JUDGE_OUTPUT),
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      })
    }
    const s05 = await servicesWithEmbeddedCredential(workspaceRoot, modelFetch)
    const backend = await s05.resolveJudge("reviewer", {
      workspaceRoot,
      runId: "run-s05-services",
      kind: "external",
      effectiveOptions: {} as EffectiveRunOptions,
      dryRun: false,
      config: effectiveConfig({ reviewer: embeddedJudgeProfile("judge") }),
    })
    if (!backend) throw new Error("Embedded judge backend was not resolved")

    const outcome = await (await backend.start(judgeRequest(), { emit() {} })).outcome

    expect(outcome).toEqual(JUDGE_OUTPUT)
    expect(requests).toHaveLength(1)
    expect(requests[0]).not.toHaveProperty("tools")
    expect(requests[0]).not.toHaveProperty("workspaceRoot")
  })
})
