import { describe, expect, test } from "bun:test"
import {
  refreshOAuthToken,
  secretInputFromValue,
  startBrowserOAuth,
  startDeviceOAuth,
} from "@ralph/credentials"
import { JudgeOutputSchema } from "@ralph/domain"
import type { JudgeRequest } from "@ralph/evaluation"
import { parseExternalProtocolOutput } from "@ralph/model-drivers"
import {
  type ProviderEvent,
  ProviderModelRequestSchema,
  ProviderModelResultSchema,
  type ProviderToolCall,
} from "@ralph/providers"
import type { SupervisedProcessRequest } from "@ralph/supervisor"
import {
  ControlledTestClock,
  deterministicOAuthRandom,
  oauthFreezeStep,
  oauthJsonStep,
  oauthMalformedStep,
  ScriptedCliSupervisor,
  ScriptedJudgeBackend,
  ScriptedLoopbackOAuth,
  ScriptedOAuthFetch,
  ScriptedProcessTable,
  ScriptedProviderDriver,
  ScriptedProviderRateLimitError,
  scriptedCliFreezeStep,
  scriptedCliMalformedStep,
  scriptedCliOutcomeStep,
  scriptedCliSilenceStep,
  scriptedCliToolCallsStep,
  scriptedProcessHeartbeatStep,
} from "../src/index"

const NOW = "2026-07-18T12:00:00.000Z"

function providerRequest(callId: string) {
  return ProviderModelRequestSchema.parse({
    schemaVersion: 1,
    callId,
    model: { provider: "openai", model: "gpt-5.3-codex" },
    messages: [{ role: "user", content: "Execute the bounded fixture" }],
    tools: [],
    parameters: {},
    responseFormat: "text",
  })
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function judgeRequest(callId: string): JudgeRequest {
  return {
    callId,
    kind: "external",
    evidenceBundleId: "evidence-scripted",
    bundle: {
      rubric: { criteria: [{ criterion: "criterion-1" }] },
    } as JudgeRequest["bundle"],
    prompt: { system: "Read-only", user: "Evaluate" },
  }
}

function processRequest(): SupervisedProcessRequest {
  return {
    executable: "fixture-cli",
    args: ["run"],
    cwd: "C:/fixture",
    environment: {},
    shell: false,
    timeoutMs: 10_000,
    gracePeriodMs: 100,
    outputLimitBytes: 1_048_576,
    rawOutputLimitBytes: 1_048_576,
    maxInputBytes: 1_048_576,
  }
}

describe("S11.02 reusable deterministic test kit", () => {
  test("provider fake streams text/reasoning/tools and exposes silence, heartbeat and freeze", async () => {
    const toolCall: ProviderToolCall = {
      itemId: "item-1",
      callId: "tool-1",
      name: "fs.read",
      argumentsJson: '{"path":"README.md"}',
      input: { path: "README.md" },
    }
    const driver = new ScriptedProviderDriver([
      {
        text: "tool requested",
        reasoningSummary: "bounded reasoning",
        textDeltas: ["tool ", "requested"],
        reasoningDeltas: ["bounded ", "reasoning"],
        toolCalls: [toolCall],
        rawRef: "raw:provider/one",
      },
      { text: "after silence", heartbeatCount: 2, silence: true },
      { freeze: true },
    ])
    const observed: ProviderEvent[] = []
    const sink = { emit: (event: ProviderEvent) => void observed.push(event) }

    const first = await driver.invoke(providerRequest("provider-stream"), sink)
    expect(first.toolCalls).toEqual([toolCall])
    expect(first.finishReason).toBe("tool-call")
    expect(observed.map((event) => event.type)).toContain("model.reasoning.delta")
    expect(observed.map((event) => event.type)).toContain("model.text.delta")
    expect(observed.map((event) => event.type)).toContain("model.tool.call")

    const silent = driver.invoke(providerRequest("provider-silent"), sink)
    await waitFor(() => driver.activeCalls().includes("provider-silent"), "silent provider call")
    expect(
      observed.filter(
        (event) =>
          event.callId === "provider-silent" &&
          event.type === "model.provider.warning" &&
          event.payload.kind === "heartbeat",
      ),
    ).toHaveLength(2)
    driver.release("provider-silent")
    expect((await silent).text).toBe("after silence")

    const frozen = driver.invoke(providerRequest("provider-frozen"), sink)
    await waitFor(() => driver.activeCalls().includes("provider-frozen"), "frozen provider call")
    expect(() => driver.release("provider-frozen")).toThrow("must be cancelled")
    await driver.cancel("provider-frozen", "fixture cleanup")
    await expect(frozen).rejects.toThrow("fixture cleanup")
    expect(driver.remaining()).toBe(0)
  })

  test("provider fake models rate-limit and malformed results without a paid service", async () => {
    const driver = new ScriptedProviderDriver([
      { rateLimit: { retryAfterMs: 2_000, code: "fixture_rate_limit" } },
      { malformedResult: { callId: "missing-required-fields" } },
    ])
    const events: ProviderEvent[] = []
    const sink = { emit: (event: ProviderEvent) => void events.push(event) }
    const rateLimit = driver.invoke(providerRequest("rate-limited"), sink)
    await expect(rateLimit).rejects.toBeInstanceOf(ScriptedProviderRateLimitError)
    await expect(rateLimit).rejects.toMatchObject({
      kind: "rate-limit",
      retryAfterMs: 2_000,
      status: 429,
    })
    expect(events.at(-1)).toMatchObject({
      type: "model.provider.error",
      payload: { kind: "rate-limit", retryAfterMs: 2_000 },
    })
    const malformed = await driver.invoke(providerRequest("malformed"), sink)
    expect(ProviderModelResultSchema.safeParse(malformed).success).toBe(false)
  })

  test("judge fake emits score sequences and fails closed around malformed/frozen calls", async () => {
    const scores = ScriptedJudgeBackend.fromScores([55, 91])
    const adverse = new ScriptedJudgeBackend([
      { malformedOutput: { score: 101 }, heartbeatCount: 1 },
      { score: 82, silence: true },
      { freeze: true },
    ])
    const events: string[] = []
    const sink = { emit: (event: { type: string }) => void events.push(event.type) }
    expect(await (await scores.start(judgeRequest("judge-1"), sink)).outcome).toMatchObject({
      score: 55,
      problems: [{ severity: "major" }],
    })
    expect((await (await scores.start(judgeRequest("judge-2"), sink)).outcome).score).toBe(91)
    const malformed = await (await adverse.start(judgeRequest("judge-malformed"), sink)).outcome
    expect(JudgeOutputSchema.safeParse(malformed).success).toBe(false)
    expect(events).toContain("judge.heartbeat")

    const silentHandle = await adverse.start(judgeRequest("judge-silent"), sink)
    await waitFor(() => adverse.activeCalls().includes("judge-silent"), "silent judge call")
    adverse.release("judge-silent")
    expect((await silentHandle.outcome).score).toBe(82)

    const frozenHandle = await adverse.start(judgeRequest("judge-frozen"), sink)
    await waitFor(() => adverse.activeCalls().includes("judge-frozen"), "frozen judge call")
    await adverse.cancel(frozenHandle, "fixture cleanup")
    await expect(frozenHandle.outcome).rejects.toThrow("fixture cleanup")
    expect(scores.requests.map((request) => request.callId)).toEqual(["judge-1", "judge-2"])
    expect(adverse.requests.map((request) => request.callId)).toEqual([
      "judge-malformed",
      "judge-silent",
      "judge-frozen",
    ])
  })

  test("OAuth fake drives device polling, malformed responses and abortable freeze", async () => {
    const transport = new ScriptedOAuthFetch([
      oauthJsonStep({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.example.test/device",
        expires_in: 600,
        interval: 2,
      }),
      oauthJsonStep({ error: "authorization_pending" }, 400),
      oauthJsonStep({ error: "slow_down" }, 400),
      oauthJsonStep({ access_token: "access-canary", token_type: "Bearer" }),
      oauthMalformedStep(),
      oauthFreezeStep(),
    ])
    const clock = new ControlledTestClock({
      wallTime: NOW,
      freezeSleepsAtOrAboveMs: 60_000,
    })
    const session = await startDeviceOAuth(
      {
        deviceAuthorizationEndpoint: "https://accounts.example.test/device/code",
        tokenEndpoint: "https://accounts.example.test/token",
        clientId: "ralph-test-client",
        scopes: ["models.read"],
        timeoutMs: 60_000,
        headless: true,
      },
      {
        fetch: transport.fetch,
        clock,
        randomBytes: deterministicOAuthRandom(),
      },
    )
    expect(await (await session.complete()).accessToken.readOnce()).toBe("access-canary")
    expect(clock.sleeps).toEqual([2_000, 7_000])

    await expect(
      refreshOAuthToken(
        {
          tokenEndpoint: "https://accounts.example.test/token",
          clientId: "ralph-test-client",
        },
        secretInputFromValue("refresh-canary"),
        { fetch: transport.fetch },
      ),
    ).rejects.toMatchObject({ code: "invalid_response" })

    const controller = new AbortController()
    const frozen = transport.fetch("https://accounts.example.test/token", {
      signal: controller.signal,
    })
    await waitFor(() => transport.pendingFrozen() === 1, "frozen OAuth request")
    controller.abort()
    await expect(frozen).rejects.toMatchObject({ name: "AbortError" })
    expect(transport.remaining()).toBe(0)
  })

  test("OAuth loopback fake completes browser PKCE without opening a socket", async () => {
    const transport = new ScriptedOAuthFetch([
      oauthJsonStep({ access_token: "browser-access-canary", token_type: "Bearer" }),
    ])
    const loopback = new ScriptedLoopbackOAuth([{ kind: "code", code: "scripted-callback-code" }])
    const session = await startBrowserOAuth(
      {
        authorizationEndpoint: "https://accounts.example.test/authorize",
        tokenEndpoint: "https://accounts.example.test/token",
        clientId: "ralph-browser-client",
        scopes: ["models.read"],
        callbackPort: 32_123,
        headless: true,
      },
      {
        fetch: transport.fetch,
        createLoopbackCallback: loopback.factory,
        randomBytes: deterministicOAuthRandom(),
        openBrowser: async () => false,
      },
    )
    expect(await (await session.complete()).accessToken.readOnce()).toBe("browser-access-canary")
    expect(loopback.requests).toHaveLength(1)
    expect(loopback.closed).toBe(1)
    const form = transport.requests[0]?.init?.body
    expect(form).toBeInstanceOf(URLSearchParams)
    expect((form as URLSearchParams).get("code")).toBe("scripted-callback-code")
  })

  test("CLI/process fake covers protocol, malformed, silence, heartbeat and freeze", async () => {
    const toolCall: ProviderToolCall = {
      itemId: "item-cli",
      callId: "tool-cli",
      name: "fs.read",
      argumentsJson: '{"path":"README.md"}',
      input: { path: "README.md" },
    }
    const executorOutcome = {
      schemaVersion: 1 as const,
      status: "work_submitted" as const,
      summary: "CLI submitted a bounded slice",
      intendedFiles: [],
      artifactRefs: [],
      suggestedVerifications: [],
      risks: [],
      reportedAt: NOW,
    }
    const supervisor = new ScriptedCliSupervisor([
      scriptedCliToolCallsStep([toolCall], { pid: 51_001 }),
      scriptedCliOutcomeStep(executorOutcome, { pid: 51_002 }),
      scriptedCliMalformedStep(),
      { ...scriptedCliSilenceStep(), pid: 51_004 },
      scriptedProcessHeartbeatStep(2, 51_005),
      scriptedCliFreezeStep(51_006),
    ])
    const toolSettlement = await supervisor.run(processRequest())
    expect(parseExternalProtocolOutput(toolSettlement.stdout)).toMatchObject({
      kind: "tool-calls",
      toolCalls: [toolCall],
    })
    const outcomeSettlement = await supervisor.run(processRequest())
    expect(parseExternalProtocolOutput(outcomeSettlement.stdout)).toMatchObject({
      kind: "outcome",
      outcome: executorOutcome,
    })
    const malformedSettlement = await supervisor.run(processRequest())
    expect(() => parseExternalProtocolOutput(malformedSettlement.stdout)).toThrow()
    expect((await supervisor.run(processRequest())).stdout).toBe("")
    const chunks: string[] = []
    await supervisor.run({
      ...processRequest(),
      onOutput: (_stream, delta) => void chunks.push(delta),
    })
    expect(chunks).toHaveLength(2)
    const frozen = await supervisor.start(processRequest())
    await waitFor(() => supervisor.activePids().includes(51_006), "frozen CLI process")
    await frozen.cancel("fixture cleanup")
    expect(await frozen.settlement).toMatchObject({ cancelled: true, treeTerminated: true })
    expect(supervisor.requests).toHaveLength(6)
  })

  test("controlled clock orders timers and process table detects PID reuse", async () => {
    const clock = new ControlledTestClock({ autoAdvanceSleeps: false, wallTime: NOW })
    const order: string[] = []
    clock.schedule(20, () => order.push("second"))
    clock.schedule(10, () => order.push("first"))
    const sleeping = clock.sleep(30).then(() => order.push("sleep"))
    clock.advanceBy(20)
    expect(order).toEqual(["first", "second"])
    expect(clock.pendingScheduledTasks()).toBe(1)
    clock.advanceBy(10)
    await sleeping
    expect(order).toEqual(["first", "second", "sleep"])
    expect(clock.wallNow().toISOString()).toBe("2026-07-18T12:00:00.030Z")

    const table = new ScriptedProcessTable("fixture-host")
    const original = { pid: 61_001, processStartToken: "start-A", hostname: "fixture-host" }
    table.register(original)
    expect(await table.probeOwner(original)).toMatchObject({ status: "alive" })
    table.reuse(original.pid, "start-B")
    expect(await table.probeOwner(original)).toMatchObject({
      status: "identity-mismatch",
      observedProcessStartToken: "start-B",
    })
    table.exit(original.pid)
    expect(await table.probeOwner(original)).toMatchObject({ status: "dead" })
  })
})
