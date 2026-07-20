import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { cp, readFile, writeFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import {
  executeRun,
  type RunOptionOverrides,
  resolveEffectiveRunOptions,
} from "@ralph-next/orchestration"
import {
  initializeWorkspace,
  listAttempts,
  listGateResults,
  readEvents,
  workspaceLayout,
} from "@ralph-next/persistence"
import { compilePrdGraph } from "@ralph-next/prd"
import { type ScriptedExecution, ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s03-raw-gate-evidence-test"
const RAW_OUTPUT_CAP_BYTES = 16 * 1_024 * 1_024
const temporaryDirectories: string[] = []

setDefaultTimeout(90_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function fixtureWorkspace(name: string): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await cp(resolve("tests", "fixtures", "execution", name), root, { recursive: true })
  await initializeWorkspace(root, VERSION)
  return root
}

async function optionsFor(root: string, cli: RunOptionOverrides) {
  const compiled = await compilePrdGraph(resolve(root, "PRD.md"), {
    workspaceRoot: root,
    recursive: true,
    strict: true,
  })
  if (!compiled.ok || !compiled.graph) throw new Error("Expected the raw-gate fixture to compile")
  const reference = compiled.graph.topologicalOrder[0]
  if (!reference) throw new Error("Expected one raw-gate fixture task")
  const document = compiled.graph.documents[reference.documentId]
  const task = document?.tasks.find((candidate) => candidate.id === reference.taskId)
  if (!document || !task) throw new Error("Expected the compiled raw-gate fixture task")
  return resolveEffectiveRunOptions({ document, task, cli }).options
}

function contentHashFromReference(reference: string): string {
  const hash = /^([a-f0-9]{64})(?:\.|$)/.exec(basename(reference))?.[1]
  if (!hash) throw new Error(`Reference is not content-addressed: ${reference}`)
  return hash
}

async function readContentAddressedReference(root: string, reference: string): Promise<Buffer> {
  const bytes = await readFile(resolve(root, reference))
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(contentHashFromReference(reference))
  return bytes
}

function replaceCommand(prd: string, command: Record<string, unknown>): string {
  const replacement = `    - command: ${JSON.stringify(command)}`
  const updated = prd.replace(/^ {4}- command: .*$/m, replacement)
  if (updated === prd) throw new Error("Fixture command line was not replaced")
  return updated
}

describe("S03 immutable raw gate evidence", () => {
  test("keeps content-addressed output from an earlier attempt immutable after the same gate retries", async () => {
    const root = await fixtureWorkspace("blocking-gate-failure")
    const prdPath = resolve(root, "PRD.md")
    const command = {
      category: "test",
      skipPolicy: "required",
      blocking: true,
      command: {
        executable: "bun",
        args: [
          "-e",
          "import { readFileSync } from 'node:fs'; const value = readFileSync('product/capability.txt', 'utf8'); console.log('gate stdout ' + value); console.error('gate stderr ' + value); if (value !== 'accepted') process.exit(1)",
        ],
        cwd: ".",
        shell: false,
        timeoutMs: 5_000,
        successExitCodes: [0],
        outputLimitBytes: 4_096,
      },
    }
    await writeFile(prdPath, replaceCommand(await readFile(prdPath, "utf8"), command), "utf8")

    const steps: ScriptedExecution[] = [
      {
        expectedTask: "blocking-gate-failure/deliver-accepted-value",
        actions: [{ type: "write", path: "product/capability.txt", content: "rejected" }],
      },
      {
        expectedTask: "blocking-gate-failure/deliver-accepted-value",
        actions: [{ type: "write", path: "product/capability.txt", content: "accepted" }],
      },
    ]
    const backend = new ScriptedExecutionBackend(steps)
    const cli: RunOptionOverrides = {
      mode: "once",
      noChangePolicy: "require-change",
    }
    const options = await optionsFor(root, cli)
    const first = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      optionResolution: { cli },
      dependencies: { resolveBackend: () => backend },
    })
    expect(first).toMatchObject({ status: "interrupted", exitCode: 4 })
    if (!first.runId) throw new Error("Expected the retryable run ID")

    const layout = workspaceLayout(root)
    const firstAttempt = listAttempts(layout.ledger, { runId: first.runId })[0]
    if (!firstAttempt) throw new Error("Expected the first gate attempt")
    const firstGate = listGateResults(layout.ledger, firstAttempt.id)[0]?.result
    const firstStdoutRef = firstGate?.outputRefs.find((reference) =>
      reference.endsWith(".stdout.log"),
    )
    if (!firstStdoutRef) throw new Error("Expected immutable stdout from the first gate attempt")
    const firstBytesBeforeRetry = await readContentAddressedReference(root, firstStdoutRef)
    expect(firstBytesBeforeRetry.toString("utf8")).toContain("gate stdout rejected")

    const second = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      runId: first.runId,
      effectiveOptions: options,
      optionResolution: { cli },
      dependencies: { resolveBackend: () => backend },
    })
    expect(second).toMatchObject({ runId: first.runId, status: "completed", exitCode: 0 })

    const attempts = listAttempts(layout.ledger, { runId: first.runId })
    expect(attempts).toHaveLength(2)
    const secondGate = listGateResults(layout.ledger, attempts[1]?.id as string)[0]?.result
    const secondStdoutRef = secondGate?.outputRefs.find((reference) =>
      reference.endsWith(".stdout.log"),
    )
    if (!secondStdoutRef) throw new Error("Expected immutable stdout from the second gate attempt")
    const secondBytes = await readContentAddressedReference(root, secondStdoutRef)

    expect(firstStdoutRef).not.toBe(secondStdoutRef)
    expect(contentHashFromReference(firstStdoutRef)).not.toBe(
      contentHashFromReference(secondStdoutRef),
    )
    expect(secondBytes.toString("utf8")).toContain("gate stdout accepted")
    expect(await readContentAddressedReference(root, firstStdoutRef)).toEqual(firstBytesBeforeRetry)
  })

  test("persists complete capped Wiggum gate metadata while keeping raw output redacted", async () => {
    const root = await fixtureWorkspace("wiggum")
    const prdPath = resolve(root, "PRD.md")
    const environmentKey = "RALPH_S03_RAW_GATE_CANARY" // gitleaks:allow -- synthetic env-ref fixture
    const canary = `raw-gate-secret-${randomUUID()}`
    expect(process.env[environmentKey]).not.toBe(canary)
    const emittedPayloadBytes = RAW_OUTPUT_CAP_BYTES + 4_096
    const script = [
      "const value = await Bun.file('product/capability.txt').text()",
      "const secret = process.env.CANARY ?? ''",
      "process.stdout.write('wiggum stdout ' + value + ' ' + secret + '\\n')",
      `process.stdout.write('x'.repeat(${emittedPayloadBytes}))`,
      "process.stderr.write('wiggum stderr ' + value + ' ' + secret + '\\n')",
      "if (value !== 'converged') process.exit(1)",
    ].join("; ")
    const command = {
      category: "test",
      skipPolicy: "required",
      blocking: true,
      command: {
        executable: "bun",
        args: ["-e", script],
        cwd: ".",
        environmentRefs: { CANARY: `env:${environmentKey}` },
        shell: false,
        timeoutMs: 30_000,
        successExitCodes: [0],
        outputLimitBytes: 128,
      },
    }
    const updatedPrd = replaceCommand(await readFile(prdPath, "utf8"), command).replace(
      "timeout=20s",
      "timeout=60s",
    )
    await writeFile(prdPath, updatedPrd, "utf8")

    const steps = JSON.parse(
      await readFile(resolve(root, "backend-partial.json"), "utf8"),
    ) as ScriptedExecution[]
    const backend = new ScriptedExecutionBackend(steps)
    const cli: RunOptionOverrides = {
      mode: "wiggum",
      maxIterations: 2,
      maxModelCallsPerAttempt: 2,
      noChangePolicy: "require-change",
    }
    const options = await optionsFor(root, cli)
    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      optionResolution: { cli },
      environment: { ...process.env, [environmentKey]: canary },
      dependencies: { resolveBackend: () => backend },
    })
    expect(result).toMatchObject({ status: "completed", exitCode: 0 })
    if (!result.runId) throw new Error("Expected the Wiggum run ID")

    const layout = workspaceLayout(root)
    const assessmentEvent = readEvents(layout.ledger).find(
      (event) => event.type === "wiggum.iteration.assessed",
    )
    const payload = assessmentEvent?.payload as
      | { assessmentRef?: string; contentHash?: string }
      | undefined
    if (!payload?.assessmentRef || !payload.contentHash) {
      throw new Error("Expected a content-addressed Wiggum assessment event")
    }
    const assessmentBytes = await readFile(resolve(root, payload.assessmentRef))
    expect(createHash("sha256").update(assessmentBytes).digest("hex")).toBe(payload.contentHash)
    const assessmentText = assessmentBytes.toString("utf8")
    expect(assessmentText).not.toContain(canary)
    const assessment = JSON.parse(assessmentText) as {
      gates?: Array<{
        command?: unknown
        exitCode?: number
        durationMs?: number
        stdoutBytes?: number
        stderrBytes?: number
        outputTruncated?: boolean
        rawOutputTruncated?: boolean
        outputRefs?: string[]
      }>
    }
    const gate = assessment.gates?.[0]
    if (!gate || typeof gate.stdoutBytes !== "number") {
      throw new Error(`Wiggum assessment lost command-gate metadata: ${JSON.stringify(gate)}`)
    }
    expect(gate.command).toMatchObject({
      executable: "bun",
      environmentRefs: { CANARY: `env:${environmentKey}` },
    })
    expect(gate.exitCode).toBe(1)
    expect(gate.outputTruncated).toBeTrue()
    expect(gate.rawOutputTruncated).toBeTrue()
    expect(typeof gate.stdoutBytes).toBe("number")
    expect(gate.stdoutBytes).toBeGreaterThan(RAW_OUTPUT_CAP_BYTES)
    expect(typeof gate.stderrBytes).toBe("number")
    expect(gate.stderrBytes as number).toBeGreaterThan(0)
    expect(typeof gate.durationMs).toBe("number")
    expect(gate.durationMs as number).toBeGreaterThanOrEqual(0)
    expect(gate.outputRefs).toHaveLength(2)
    if (!gate.outputRefs?.every((reference) => typeof reference === "string")) {
      throw new Error("Wiggum assessment output references are not strings")
    }

    for (const reference of gate.outputRefs) {
      const raw = await readContentAddressedReference(root, reference)
      const text = raw.toString("utf8")
      expect(text).not.toContain(canary)
      expect(text).toContain("[REDACTED]")
      expect(text).toContain("partial")
    }
  })
})
