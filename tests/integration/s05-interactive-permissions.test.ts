import { afterEach, describe, expect, test } from "bun:test"
import { cp, readFile, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { type CommandContext, executeCli } from "@ralph/commands"
import { ExecutorOutcomeSchema } from "@ralph/domain"
import type {
  BackendCapabilities,
  CallHandle,
  ExecutionBackend,
  ExecutionChannel,
  ExecutionRequest,
} from "@ralph/orchestration"
import { initializeWorkspace } from "@ralph/persistence"
import type {
  PermissionPromptPort,
  ToolPermissionRequest,
  ToolPermissionResponse,
} from "@ralph/tool-host"
import { createRalphExecutionToolPort } from "../../apps/ralph-cli/src/tool-execution-port"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s05-interactive-test"
const NOW = "2026-07-18T20:00:00.000Z"
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

class RecordingPermissionPrompt implements PermissionPromptPort {
  readonly requests: ToolPermissionRequest[] = []

  constructor(readonly action: "allow" | "deny") {}

  async request(input: ToolPermissionRequest): Promise<ToolPermissionResponse> {
    this.requests.push(input)
    return {
      schemaVersion: 1,
      requestId: input.id,
      requestHash: input.requestHash,
      action: this.action,
      reason: `Fixture ${this.action}`,
      respondedAt: NOW,
    }
  }
}

class ToolWritingBackend implements ExecutionBackend {
  readonly id = "interactive-tool-fixture"

  capabilities(): BackendCapabilities {
    return { streaming: false, toolCalling: true, cancellation: true, usage: "unavailable" }
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    const id = `fixture-turn-${request.modelCallId}`
    return {
      id,
      outcome: (async () => {
        await channel.reserveModelCall({ callId: id, turn: 1 })
        await channel.tools()
        const input = {
          path: "product/capability.txt",
          content: "delivered",
          precondition: { kind: "absent" },
          createParents: false,
        }
        const settlement = await channel.executeTool({
          itemId: `item-${id}`,
          callId: `write-${id}`,
          name: "fs.write",
          argumentsJson: JSON.stringify(input),
          input,
        })
        return ExecutorOutcomeSchema.parse({
          schemaVersion: 1,
          status: settlement.outcome === "success" ? "work_submitted" : "blocked_reported",
          summary:
            settlement.outcome === "success"
              ? "Tool-host write submitted for deterministic verification."
              : "The command-owned permission policy denied the requested write.",
          intendedFiles: ["product/capability.txt"],
          artifactRefs: [],
          suggestedVerifications: [],
          risks: [],
          reportedAt: NOW,
        })
      })(),
    }
  }

  async cancel(): Promise<void> {}
}

async function fixtureWorkspace(): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await cp(resolve("tests", "fixtures", "execution", "single-pass"), root, { recursive: true })
  const prdPath = resolve(root, "PRD.md")
  await writeFile(
    prdPath,
    (await readFile(prdPath, "utf8")).replace(
      "model_calls=1; timeout=20s",
      "model_calls=1; tool_calls=2; timeout=20s",
    ),
    "utf8",
  )
  await unlink(resolve(root, "product", "capability.txt"))
  await initializeWorkspace(root, VERSION)
  return root
}

async function runPermissionScenario(input: {
  interactive: boolean
  prompt: RecordingPermissionPrompt
  nonInteractive?: boolean
  headlessAsk?: "allow" | "deny"
}) {
  const root = await fixtureWorkspace()
  const backend = new ToolWritingBackend()
  const context: CommandContext = {
    version: VERSION,
    cwd: root,
    environment: { RALPH_CONFIG_HOME: resolve(root, "isolated-global-config") },
    interactive: input.interactive,
    resolveBackend: (profile) => (profile === "fixture-executor" ? backend : undefined),
    toolPort: createRalphExecutionToolPort({ prompt: input.prompt, now: () => NOW }),
  }
  const result = await executeCli(
    [
      "once",
      "--workspace",
      root,
      "--ask-tool",
      "fs.write",
      ...(input.nonInteractive ? ["--non-interactive"] : []),
      ...(input.headlessAsk ? ["--headless-ask", input.headlessAsk] : []),
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
  )
  const capability = Bun.file(resolve(root, "product", "capability.txt"))
  return {
    root,
    result,
    content: (await capability.exists()) ? await capability.text() : undefined,
  }
}

describe("S05 command-owned interactive permission propagation", () => {
  test("an interactive allow decision invokes the bound prompt and permits the write", async () => {
    const allowingPrompt = new RecordingPermissionPrompt("allow")
    const allowed = await runPermissionScenario({ interactive: true, prompt: allowingPrompt })
    expect(allowed.result.exitCode).toBe(0)
    expect(allowed.content).toBe("delivered")
    expect(allowingPrompt.requests).toHaveLength(1)
    expect(allowingPrompt.requests[0]).toMatchObject({ tool: "fs.write", risk: "write" })
  }, 20_000)

  test("an interactive deny decision invokes the bound prompt and blocks the write", async () => {
    const denyingPrompt = new RecordingPermissionPrompt("deny")
    const denied = await runPermissionScenario({ interactive: true, prompt: denyingPrompt })
    expect(denied.result.exitCode).not.toBe(0)
    expect(denied.content).toBeUndefined()
    expect(denyingPrompt.requests).toHaveLength(1)
  }, 20_000)

  test("--non-interactive suppresses prompts and applies headlessAsk", async () => {
    const prompt = new RecordingPermissionPrompt("deny")
    const execution = await runPermissionScenario({
      interactive: true,
      nonInteractive: true,
      headlessAsk: "allow",
      prompt,
    })

    expect(execution.result.exitCode).toBe(0)
    expect(execution.content).toBe("delivered")
    expect(prompt.requests).toHaveLength(0)
  }, 20_000)

  test("a command without terminal capability never opens a hidden prompt", async () => {
    const prompt = new RecordingPermissionPrompt("allow")
    const execution = await runPermissionScenario({
      interactive: false,
      headlessAsk: "deny",
      prompt,
    })

    expect(execution.result.exitCode).not.toBe(0)
    expect(execution.content).toBeUndefined()
    expect(prompt.requests).toHaveLength(0)
  }, 20_000)
})
