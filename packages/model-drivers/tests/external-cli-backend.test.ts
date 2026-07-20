import { afterEach, describe, expect, test } from "bun:test"

import type {
  ExecutionChannel,
  ExecutionRequest,
  ExecutionToolResult,
} from "@ralph-next/orchestration"
import type { ExternalCliRuntimeConfig, ProviderToolCall } from "@ralph-next/providers"
import type {
  ProcessSettlement,
  ProcessSupervisor,
  SupervisedProcessHandle,
  SupervisedProcessRequest,
} from "@ralph-next/supervisor"
import { ScriptedCliSupervisor } from "@ralph-next/test-kit"
import { createTestDirectory, removeTestDirectory } from "../../../tests/helpers/temp-directory"

import { ExternalCliExecutionBackend } from "../src/index"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

function settlement(stdout: string): ProcessSettlement {
  return {
    argv: ["fixture"],
    cwd: "fixture",
    exitCode: 0,
    stdout,
    stderr: "",
    rawStdout: stdout,
    rawStderr: "",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    outputTruncated: false,
    rawOutputTruncated: false,
    timedOut: false,
    cancelled: false,
    treeTerminated: false,
    outputRefs: ["raw:fixture/stdout"],
    durationMs: 1,
  }
}

function supervisor(results: readonly ProcessSettlement[]) {
  const queue = [...results]
  const requests: SupervisedProcessRequest[] = []
  const target: ProcessSupervisor = {
    async start(request): Promise<SupervisedProcessHandle> {
      requests.push(request)
      const next = queue.shift()
      if (!next) throw new Error("process settlement queue exhausted")
      return {
        settlement: Promise.resolve(next),
        async cancel() {},
        async forceKill() {},
      }
    },
    async run(request) {
      return (await this.start(request)).settlement
    },
    which(executable) {
      return executable
    },
  }
  return { target, requests }
}

async function request(): Promise<ExecutionRequest> {
  const workspaceRoot = await createTestDirectory()
  temporaryDirectories.push(workspaceRoot)
  return {
    runId: "run-1",
    documentId: "prd",
    taskId: "vertical-slice",
    attemptId: "attempt-1",
    modelCallId: "model-call-1",
    callOrdinal: 1,
    workspaceRoot,
    contextManifest: {} as ExecutionRequest["contextManifest"],
    contextBundle: {
      manifest: {} as ExecutionRequest["contextManifest"],
      resources: [],
      truncations: [],
      canonicalJson: '{"task":"vertical-slice"}',
    },
    task: {} as ExecutionRequest["task"],
    protectedPaths: ["PRD.md"],
  }
}

function channel(maximumToolCalls = 2) {
  const calls: ProviderToolCall[] = []
  let modelCalls = 0
  const target: ExecutionChannel = {
    emit() {},
    async reserveModelCall() {
      modelCalls += 1
    },
    async tools() {
      return [
        {
          name: "fs.read",
          description: "Read one bounded file",
          inputSchema: {
            type: "object" as const,
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false as const,
          },
        },
      ]
    },
    async executeTool(call): Promise<ExecutionToolResult> {
      calls.push(call)
      return {
        callId: call.callId,
        outcome: "success",
        output: '{"content":"fixture"}',
        retryable: false,
      }
    },
    stats() {
      return { modelCalls, maximumModelCalls: 3, toolCalls: calls.length, maximumToolCalls }
    },
  }
  return { target, calls }
}

function config(overrides: Partial<ExternalCliRuntimeConfig> = {}): ExternalCliRuntimeConfig {
  return {
    executable: "fixture-cli",
    args: ["--task", "{{task_id}}", "--turn", "{{turn}}"],
    cwd: ".",
    environmentRefs: {},
    inputMode: "stdin-json",
    adapter: "protocol",
    capabilities: {
      streaming: false,
      toolCalling: "ralph",
      cancellation: true,
      usage: "unavailable",
    },
    mutationMode: "read-only",
    timeoutMs: 10_000,
    outputLimitBytes: 1_048_576,
    ...overrides,
  }
}

describe("external CLI execution backend", () => {
  test("uses the versioned stdin protocol and settles Ralph tool calls", async () => {
    const toolCall: ProviderToolCall = {
      itemId: "item-1",
      callId: "tool-1",
      name: "fs.read",
      argumentsJson: '{"path":"README.md"}',
      input: { path: "README.md" },
    }
    const process = new ScriptedCliSupervisor([
      {
        stdout: JSON.stringify({
          schemaVersion: 1,
          protocol: "ralph.execution.external-cli.v1",
          kind: "tool-calls",
          toolCalls: [toolCall],
        }),
      },
      {
        stdout: JSON.stringify({
          schemaVersion: 1,
          protocol: "ralph.execution.external-cli.v1",
          kind: "outcome",
          outcome: {
            schemaVersion: 1,
            status: "work_submitted",
            summary: "External slice submitted",
            intendedFiles: [],
            artifactRefs: [],
            suggestedVerifications: [],
            risks: [],
            reportedAt: "2026-07-18T00:00:00.000Z",
          },
        }),
      },
    ])
    const execution = channel()
    const backend = new ExternalCliExecutionBackend({
      id: "external-fixture",
      config: config({
        args: [
          "--task",
          "{{task_id}}",
          "--turn",
          "{{turn}}",
          "--provider",
          "{{provider}}",
          "--model",
          "{{model}}",
        ],
      }),
      supervisor: process,
      provider: "fixture-provider",
      model: "fixture-model",
    })

    const executionRequest = await request()
    const outcome = await (await backend.start(executionRequest, execution.target)).outcome

    expect(outcome.summary).toBe("External slice submitted")
    expect(execution.calls).toEqual([toolCall])
    expect(process.requests).toHaveLength(2)
    expect(process.requests[0]?.cwd).not.toBe(executionRequest.workspaceRoot)
    expect(process.requests[0]?.args).toEqual([
      "--task",
      "vertical-slice",
      "--turn",
      "1",
      "--provider",
      "fixture-provider",
      "--model",
      "fixture-model",
    ])
    const continuation = JSON.parse(String(process.requests[1]?.stdin)) as {
      tools: unknown[]
      history: unknown[]
      call: { modelCallId: string }
    }
    expect(continuation.call.modelCallId).toBe("model-call-1")
    expect(continuation.tools).toHaveLength(1)
    expect(continuation.history).toEqual([
      { type: "function-call", ...toolCall },
      { type: "function-call-output", callId: "tool-1", output: '{"content":"fixture"}' },
    ])
  })

  test("generic output remains an allegation even when it says TASK_COMPLETE", async () => {
    const process = supervisor([settlement("TASK_COMPLETE")])
    const execution = channel(0)
    const backend = new ExternalCliExecutionBackend({
      id: "external-generic",
      config: config({
        adapter: "generic",
        capabilities: {
          streaming: false,
          toolCalling: "unavailable",
          cancellation: false,
          usage: "unavailable",
        },
      }),
      supervisor: process.target,
      now: () => "2026-07-18T00:00:00.000Z",
    })

    const outcome = await (await backend.start(await request(), execution.target)).outcome

    expect(outcome).toMatchObject({ status: "work_submitted", summary: "TASK_COMPLETE" })
    expect(execution.calls).toHaveLength(0)
  })

  test("rejects direct workspace mutation until a sandboxed reconciliation adapter exists", () => {
    const process = supervisor([])
    expect(
      () =>
        new ExternalCliExecutionBackend({
          id: "external-unsafe",
          config: config({ mutationMode: "workspace" }),
          supervisor: process.target,
        }),
    ).toThrow("Direct external CLI workspace mutation is unavailable")
  })
})
