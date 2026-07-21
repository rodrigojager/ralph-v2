import { describe, expect, test } from "bun:test"

import type { JudgeRequest } from "@ralph/evaluation"
import { JudgeEvaluationBundleSchema } from "@ralph/evaluation"
import {
  EmbeddedJudgeBackend,
  ExternalCliJudgeBackend,
  ExternalCliJudgeInputSchema,
  JUDGE_OUTPUT_JSON_ADAPTER_ID,
  parseExternalJudgeOutput,
} from "@ralph/model-drivers"
import type {
  CredentialDriver,
  ModelInfo,
  ProviderDriver,
  ProviderEventSink,
  ProviderInfo,
  ProviderModelRequest,
} from "@ralph/providers"
import type {
  ProcessSettlement,
  ProcessSupervisor,
  SupervisedProcessHandle,
  SupervisedProcessRequest,
} from "@ralph/supervisor"

const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const NOW = "2026-07-18T12:00:00.000Z"
const EMBEDDED_RAW_REF = "raw://sha256/embedded-judge-response"
const OUTPUT = {
  schemaVersion: 1 as const,
  score: 91,
  summary: "Evidence supports the requested behavior.",
  adequate: ["The blocking gate passed."],
  problems: [],
  missingEvidence: [],
  recommendations: [],
  criterionScores: [{ criterion: "criterion-1", score: 91 }],
}

class CapturingProviderDriver implements ProviderDriver {
  readonly id = "fake-provider"
  request?: ProviderModelRequest

  async info(): Promise<ProviderInfo> {
    throw new Error("not used")
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    return []
  }

  credentialDriver(): CredentialDriver | undefined {
    return undefined
  }

  async invoke(request: ProviderModelRequest, sink: ProviderEventSink) {
    this.request = request
    await sink.emit({
      schemaVersion: 1,
      eventId: "event-judge-finished",
      callId: request.callId,
      sequence: 1,
      timestamp: NOW,
      level: "info",
      synthesized: false,
      type: "model.call.finished",
      payload: { finishReason: "stop", rawRef: EMBEDDED_RAW_REF },
    })
    return {
      schemaVersion: 1 as const,
      callId: request.callId,
      status: "succeeded" as const,
      finishReason: "stop" as const,
      text: JSON.stringify(OUTPUT),
      usage: { source: "reported" as const, semantics: "final" as const, total: 12 },
      toolCalls: [],
    }
  }

  async cancel(): Promise<void> {}
}

class CapturingSupervisor implements ProcessSupervisor {
  request?: SupervisedProcessRequest

  async start(processRequest: SupervisedProcessRequest): Promise<SupervisedProcessHandle> {
    this.request = processRequest
    const settlement: ProcessSettlement = {
      pid: 123,
      argv: [processRequest.executable, ...processRequest.args],
      cwd: processRequest.cwd,
      exitCode: 0,
      stdout: JSON.stringify(OUTPUT),
      stderr: "",
      rawStdout: JSON.stringify(OUTPUT),
      rawStderr: "",
      stdoutBytes: JSON.stringify(OUTPUT).length,
      stderrBytes: 0,
      outputTruncated: false,
      rawOutputTruncated: false,
      timedOut: false,
      cancelled: false,
      treeTerminated: true,
      outputRefs: ["process:judge/stdout"],
      durationMs: 5,
    }
    return {
      pid: 123,
      settlement: Promise.resolve(settlement),
      async cancel() {},
      async forceKill() {},
    }
  }

  async run(processRequest: SupervisedProcessRequest): Promise<ProcessSettlement> {
    return (await this.start(processRequest)).settlement
  }

  which(executable: string): string {
    return executable
  }
}

function request(): JudgeRequest {
  const bundle = JudgeEvaluationBundleSchema.parse({
    schemaVersion: 1,
    task: {
      documentId: "prd-root",
      taskId: "task-1",
      title: "Feature",
      result: "Observable result",
      criteria: [{ id: "criterion-1", text: "Behavior works", weight: 100 }],
      boundaries: [],
      evidenceMode: "criteria",
      verificationRefs: [],
      taskSpecHash: HASH,
    },
    evidence: {
      id: "evidence-1",
      runId: "run-1",
      documentId: "prd-root",
      taskId: "task-1",
      attemptId: "attempt-1",
      taskSpecHash: HASH,
      changes: {
        policy: "require-change",
        status: "changed",
        files: [],
        outsideScopePaths: [],
        reproducible: true,
        missingContent: [],
        diffHash: HASH,
        diffRef: "evidence:diff",
        attemptDiffHash: HASH,
        attemptDiffRef: "evidence:attempt-diff",
      },
      artifacts: [],
      gates: [],
      contextManifestHash: HASH,
      createdAt: NOW,
      contentHash: HASH,
    },
    rubric: {
      schemaVersion: 1,
      weightPolicy: "strict-100",
      criteria: [
        {
          criterion: "criterion-1",
          description: "Evaluate behavior",
          weight: 100,
        },
      ],
    },
    truncations: [],
  })
  return {
    callId: "judge-call-1",
    kind: "external",
    evidenceBundleId: "evidence-1",
    bundle,
    prompt: { system: "Read-only evaluation. No tools.", user: "Evaluate bounded evidence." },
  }
}

describe("judge model backends", () => {
  test("embedded judge sends no tools and selects the judge JSON schema", async () => {
    const driver = new CapturingProviderDriver()
    const backend = new EmbeddedJudgeBackend({
      id: "judge",
      driver,
      model: { provider: "fake-provider", model: "judge-model" },
    })
    const handle = await backend.start(request(), { emit() {} })
    expect(await handle.outcome).toEqual(OUTPUT)
    expect(await handle.rawResponseRef).toBe(EMBEDDED_RAW_REF)
    expect(driver.request?.tools).toEqual([])
    expect(driver.request?.responseFormat).toBe("json")
    expect(driver.request?.responseSchema?.name).toBe("ralph_judge_output_v1")
    expect(driver.request).not.toHaveProperty("workspaceRoot")
  })

  test("external JSON v1 adapter validates score and process settlement", () => {
    expect(
      parseExternalJudgeOutput({ stdout: JSON.stringify(OUTPUT), stderr: "", exitCode: 0 }).score,
    ).toBe(91)
    expect(() =>
      parseExternalJudgeOutput({
        stdout: JSON.stringify({ ...OUTPUT, score: 101 }),
        stderr: "",
        exitCode: 0,
      }),
    ).toThrow()
    expect(() =>
      parseExternalJudgeOutput({ stdout: JSON.stringify(OUTPUT), stderr: "", exitCode: 2 }),
    ).toThrow("status 2")
  })

  test("external judge runs in an isolated cwd with a no-tools JSON v1 request", async () => {
    const supervisor = new CapturingSupervisor()
    const backend = new ExternalCliJudgeBackend({
      id: "external-judge",
      supervisor,
      environment: {},
      config: {
        executable: "judge-cli",
        args: ["evaluate"],
        cwd: ".",
        environmentRefs: {},
        inputMode: "stdin-json",
        adapter: "known-output",
        adapterId: JUDGE_OUTPUT_JSON_ADAPTER_ID,
        capabilities: {
          streaming: false,
          toolCalling: "unavailable",
          cancellation: true,
          usage: "unavailable",
        },
        mutationMode: "read-only",
        timeoutMs: 30_000,
        outputLimitBytes: 1024 * 1024,
      },
    })
    const handle = await backend.start(request(), { emit() {} })
    expect((await handle.outcome).score).toBe(91)
    expect(await handle.rawResponseRef).toBe("process:judge/stdout")
    const stdin = supervisor.request?.stdin
    if (typeof stdin !== "string") throw new Error("Expected a JSON stdin request")
    const input = ExternalCliJudgeInputSchema.parse(JSON.parse(stdin))
    expect(input.protocol).toBe("ralph.evaluation.external-cli.v1")
    expect(input.outputContract).toBe(JUDGE_OUTPUT_JSON_ADAPTER_ID)
    expect(input).not.toHaveProperty("tools")
    expect(input).not.toHaveProperty("workspaceRoot")
    expect(supervisor.request?.cwd).toContain("ralph-external-judge-")
  })
})
