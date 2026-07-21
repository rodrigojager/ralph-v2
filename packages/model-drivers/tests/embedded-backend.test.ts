import { describe, expect, test } from "bun:test"

import type { ExecutionChannel, ExecutionRequest, ExecutionToolResult } from "@ralph/orchestration"
import type {
  ProviderDriver,
  ProviderEventSink,
  ProviderModelRequest,
  ProviderModelResult,
  ProviderToolCall,
} from "@ralph/providers"

import { EmbeddedExecutionBackend } from "../src/index"

function request(): ExecutionRequest {
  return {
    runId: "run-1",
    documentId: "prd",
    taskId: "vertical-slice",
    attemptId: "attempt-1",
    modelCallId: "model-call-1",
    callOrdinal: 1,
    workspaceRoot: "C:/workspace",
    contextManifest: {} as ExecutionRequest["contextManifest"],
    contextBundle: {
      manifest: {} as ExecutionRequest["contextManifest"],
      resources: [],
      truncations: [],
      canonicalJson: '{"task":"vertical-slice"}',
    },
    task: { budget: { maxToolCallsPerModelCall: 2 } } as ExecutionRequest["task"],
    protectedPaths: ["PRD.md"],
  }
}

function provider(results: readonly ProviderModelResult[]) {
  const queue = [...results]
  const requests: ProviderModelRequest[] = []
  const cancelled: string[] = []
  const driver: ProviderDriver = {
    id: "openai",
    async info() {
      throw new Error("not needed")
    },
    async listModels() {
      return []
    },
    credentialDriver() {
      return undefined
    },
    async invoke(input: ProviderModelRequest, _sink: ProviderEventSink) {
      requests.push(input)
      const next = queue.shift()
      if (!next) throw new Error("provider result queue exhausted")
      return next
    },
    async cancel(callId: string) {
      cancelled.push(callId)
    },
  }
  return { driver, requests, cancelled }
}

function channel() {
  const calls: ProviderToolCall[] = []
  const events: string[] = []
  let modelCalls = 0
  const target: ExecutionChannel = {
    emit(event) {
      events.push(event.type)
    },
    async reserveModelCall() {
      modelCalls += 1
    },
    async tools() {
      return [
        {
          name: "fs.write",
          description: "Write one bounded workspace file",
          inputSchema: {
            type: "object" as const,
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
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
        output: JSON.stringify({ written: call.input.path }),
        retryable: false,
      }
    },
    stats() {
      return { modelCalls, maximumModelCalls: 3, toolCalls: calls.length, maximumToolCalls: 2 }
    },
  }
  return { target, calls, events }
}

const unavailableUsage = { source: "unavailable", semantics: "final" } as const

describe("embedded execution backend", () => {
  test("settles provider tool requests through the Ralph channel before final outcome", async () => {
    const firstCall: ProviderToolCall = {
      itemId: "item-1",
      callId: "tool-1",
      name: "fs.write",
      argumentsJson: '{"content":"done","path":"src/slice.ts"}',
      input: { content: "done", path: "src/slice.ts" },
    }
    const source = provider([
      {
        schemaVersion: 1,
        callId: "model-call-1-turn-1",
        status: "succeeded",
        finishReason: "tool-call",
        usage: unavailableUsage,
        toolCalls: [firstCall],
      },
      {
        schemaVersion: 1,
        callId: "model-call-1-turn-2",
        status: "succeeded",
        finishReason: "stop",
        text: JSON.stringify({
          status: "work_submitted",
          summary: "Vertical slice implemented",
          intendedFiles: ["src/slice.ts"],
          artifactRefs: [],
          suggestedVerifications: ["focused test"],
          risks: [],
        }),
        usage: unavailableUsage,
        toolCalls: [],
      },
    ])
    const execution = channel()
    const backend = new EmbeddedExecutionBackend({
      id: "embedded-openai",
      driver: source.driver,
      model: { provider: "openai", model: "gpt-test" },
      now: () => "2026-07-18T00:00:00.000Z",
    })

    const outcome = await (await backend.start(request(), execution.target)).outcome

    expect(outcome).toMatchObject({
      status: "work_submitted",
      summary: "Vertical slice implemented",
      reportedAt: "2026-07-18T00:00:00.000Z",
    })
    expect(execution.calls).toEqual([firstCall])
    expect(source.requests).toHaveLength(2)
    expect(source.requests[1]?.input?.slice(-2)).toEqual([
      { type: "function-call", ...firstCall },
      {
        type: "function-call-output",
        callId: "tool-1",
        output: '{"written":"src/slice.ts"}',
      },
    ])
    expect(execution.events).toContain("model.backend.turn.finished")
  })

  test("forwards the command-resolved output limit to the provider request", async () => {
    const source = provider([
      {
        schemaVersion: 1,
        callId: "model-call-1-turn-1",
        status: "succeeded",
        finishReason: "stop",
        text: JSON.stringify({
          status: "work_submitted",
          summary: "Bounded result",
          intendedFiles: [],
          artifactRefs: [],
          suggestedVerifications: [],
          risks: [],
        }),
        usage: { output: 2, total: 2, source: "reported", semantics: "final" },
        toolCalls: [],
      },
    ])
    const execution = channel()
    const boundedRequest = request()
    boundedRequest.task = {
      ...boundedRequest.task,
      budget: { maxToolCallsPerModelCall: 2, maxOutputTokens: 2 },
    }
    boundedRequest.contextManifest = {
      ...boundedRequest.contextManifest,
      budget: { remainingOutputTokens: 2 },
    } as ExecutionRequest["contextManifest"]
    const backend = new EmbeddedExecutionBackend({
      id: "embedded-openai",
      driver: source.driver,
      model: { provider: "openai", model: "gpt-test" },
      limits: { maxOutputTokens: 5 },
    })

    await (await backend.start(boundedRequest, execution.target)).outcome

    expect(backend.limits()).toEqual({ maxOutputTokens: 5 })
    expect(source.requests[0]?.maxOutputTokens).toBe(2)
  })

  test("plain completion language is rejected as an invalid allegation", async () => {
    const source = provider([
      {
        schemaVersion: 1,
        callId: "model-call-1-turn-1",
        status: "succeeded",
        finishReason: "stop",
        text: "TASK_COMPLETE",
        usage: unavailableUsage,
        toolCalls: [],
      },
    ])
    const execution = channel()
    const handle = await new EmbeddedExecutionBackend({
      id: "embedded-openai",
      driver: source.driver,
      model: { provider: "openai", model: "gpt-test" },
    }).start(request(), execution.target)

    await expect(handle.outcome).rejects.toThrow("not one valid JSON object")
  })
})
