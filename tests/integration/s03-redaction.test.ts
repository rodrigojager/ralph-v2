import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { type CommandContext, runCli } from "@ralph/commands"
import { ExecutorOutcomeSchema } from "@ralph/domain"
import type {
  BackendCapabilities,
  CallHandle,
  ExecutionBackend,
  ExecutionChannel,
  ExecutionRequest,
} from "@ralph/orchestration"
import { initializeWorkspace, workspaceLayout } from "@ralph/persistence"
import type { OutputWriters } from "@ralph/telemetry"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s03-redaction-test"
const temporaryDirectories: string[] = []

setDefaultTimeout(30_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

class CanaryBackend implements ExecutionBackend {
  readonly id = "canary-test-backend"

  constructor(private readonly canary: string) {}

  capabilities(): BackendCapabilities {
    return { streaming: true, toolCalling: false, cancellation: true, usage: "unavailable" }
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    const callId = `canary-call-${randomUUID()}`
    await channel.reserveModelCall({ callId, turn: 1 })
    const outcome = (async () => {
      await channel.emit({
        type: "model.provider.warning",
        level: "warning",
        payload: {
          message: `backend event contains ${this.canary}`,
          nested: { providerOutput: this.canary },
        },
      })
      const target = resolve(request.workspaceRoot, "product", "capability.txt")
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, "delivered", "utf8")
      return ExecutorOutcomeSchema.parse({
        schemaVersion: 1,
        status: "work_submitted",
        summary: `backend outcome contains ${this.canary}`,
        intendedFiles: ["product/capability.txt"],
        artifactRefs: [],
        suggestedVerifications: [`inspect without exposing ${this.canary}`],
        risks: [`secret canary ${this.canary}`],
        reportedAt: "2026-07-18T12:00:00.000Z",
      })
    })()
    return { id: callId, outcome }
  }

  async cancel(_handle: CallHandle, _reason: string): Promise<void> {}
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

async function filesBelow(root: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...(await filesBelow(path)))
    else if (entry.isFile()) output.push(path)
  }
  return output
}

async function joinedText(paths: readonly string[]): Promise<string> {
  return (await Promise.all(paths.map((path) => readFile(path)))).map(String).join("\n")
}

function redactionPrd(environmentKey: string): string {
  const command = JSON.stringify({
    category: "test",
    skipPolicy: "required",
    blocking: true,
    command: {
      executable: "bun",
      args: [
        "-e",
        "const value = process.env.CANARY; console.log('gate stdout ' + value); console.error('gate stderr ' + value); const text = await Bun.file('product/capability.txt').text(); if (text !== 'delivered') process.exit(1)",
      ],
      environmentRefs: { CANARY: `env:${environmentKey}` },
      shell: false,
      timeoutMs: 5_000,
      successExitCodes: [0],
      outputLimitBytes: 4_096,
    },
  })
  return `---
ralph_prd: 2
id: s03-redaction
title: S03 persistence redaction
kind: root
workspace: .
defaults:
  executor_profile: canary-executor
  evidence_mode: criteria
---

# S03 persistence redaction

The canary is supplied only through the command context.

## Vertical slices

- [ ] **redact-persistence — Persist only redacted execution values**
  - Result: the fixture produces a verified file without persisting its injected secret.
  - Dependencies: none
  - Criteria:
    1. Every durable execution surface contains the redaction marker instead of the canary.
  - Verification:
    - command: ${command}
  - Boundaries:
    - Do not read the canary from the host process environment.
  - Evidence mode: criteria
  - Sub-PRD: none
`
}

describe("S03 execution persistence redaction", () => {
  test("redacts a CommandContext-only canary from ledger, events, report and raw gates", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    await initializeWorkspace(root, VERSION)
    const environmentKey = "RALPH_S03_REDACTION_SECRET"
    const canary = `s03-command-context-only-${randomUUID()}`
    expect(process.env[environmentKey]).not.toBe(canary)
    expect(Object.values(process.env)).not.toContain(canary)
    await writeFile(resolve(root, "PRD.md"), redactionPrd(environmentKey), "utf8")

    const backend = new CanaryBackend(canary)
    const context: CommandContext = {
      version: VERSION,
      cwd: root,
      environment: {
        RALPH_CONFIG_HOME: resolve(root, "isolated-global-config"),
        [environmentKey]: canary,
      },
      resolveBackend: (profile) => (profile === "canary-executor" ? backend : undefined),
    }
    const capture = captureWriters()
    const exitCode = await runCli(
      ["once", "--workspace", root, "--prd", "PRD.md", "--format", "json"],
      context,
      capture.writers,
    )
    expect({ exitCode, stdout: capture.stdout(), stderr: capture.stderr() }).toMatchObject({
      exitCode: 0,
      stderr: "",
    })
    const output = JSON.parse(capture.stdout()) as { runId?: string }
    if (!output.runId) throw new Error("Expected the completed run ID")

    const layout = workspaceLayout(root)
    const sqliteFiles = (await filesBelow(dirname(layout.ledger))).filter((path) =>
      path.includes("ledger.sqlite"),
    )
    const eventFiles = (await filesBelow(layout.ralph)).filter((path) =>
      path.endsWith("events.jsonl"),
    )
    const reportFile = join(layout.runs, output.runId, "reports", "report.json")
    const rawFiles = await filesBelow(join(layout.runs, output.runId, "raw"))
    expect(sqliteFiles.length).toBeGreaterThan(0)
    expect(eventFiles.length).toBeGreaterThan(0)
    expect(rawFiles.length).toBeGreaterThanOrEqual(2)

    const persisted = {
      sqlite: await joinedText(sqliteFiles),
      events: await joinedText(eventFiles),
      report: await readFile(reportFile, "utf8"),
      raw: await joinedText(rawFiles),
    }
    for (const [surface, value] of Object.entries(persisted)) {
      expect(value, `${surface} leaked the CommandContext-only canary`).not.toContain(canary)
      expect(value, `${surface} did not retain an explicit redaction marker`).toContain(
        "[REDACTED]",
      )
    }
    expect(persisted.sqlite).toContain("backend event contains [REDACTED]")
    expect(persisted.events).toContain("backend event contains [REDACTED]")
    expect(persisted.report).toContain("backend outcome contains [REDACTED]")
    expect(persisted.raw).toContain("gate stdout [REDACTED]")
    expect(persisted.raw).toContain("gate stderr [REDACTED]")
  })
})
