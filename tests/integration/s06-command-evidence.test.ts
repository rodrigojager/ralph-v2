import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, readFile, rename, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { type CommandContext, executeCli, runCli } from "@ralph-next/commands"
import {
  commandOperationReportHash,
  type JudgmentCommandReport,
  JudgmentCommandReportSchema,
  type JudgeOutput,
  type VerificationCommandReport,
} from "@ralph-next/domain"
import type { JudgeBackend, JudgeEventSink, JudgeRequest } from "@ralph-next/evaluation"
import { materializeAdHocExecutionSource } from "@ralph-next/orchestration"
import {
  finishCommandOperation,
  getEvidenceBundle,
  getRun,
  initializeWorkspace,
  listAttempts,
  listCommandOperations,
  listRunTasks,
  readEvents,
  readEvidenceBundleObject,
  workspaceLayout,
} from "@ralph-next/persistence"
import { type ScriptedExecution, ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { stringify } from "yaml"

import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.1.0-s06-command-evidence"
const temporaryDirectories: string[] = []

setDefaultTimeout(60_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

function externalProfile(role: "executor" | "judge") {
  return {
    role,
    backend: "external-cli",
    provider: "fixture",
    model: `${role}-fixture-v1`,
    parameters: {},
    requirements: role === "judge" ? { structured_output: true } : {},
    fallback_profiles: [],
    fallback_on: [],
    limits: {},
    external_cli: {
      executable: process.execPath,
      args: ["--version"],
      cwd: ".",
      environment_refs: {},
      input_mode: "stdin-json",
      adapter: role === "judge" ? "known-output" : "protocol",
      ...(role === "judge" ? { adapter_id: "judge-output-json-v1" } : {}),
      capabilities: {
        streaming: false,
        tool_calling: role === "judge" ? "unavailable" : "ralph",
        cancellation: true,
        usage: "reported",
      },
      mutation_mode: "read-only",
      timeout_ms: 10_000,
      output_limit_bytes: 1_048_576,
    },
  }
}

async function writeConfig(root: string): Promise<void> {
  await writeFile(
    workspaceLayout(root).config,
    stringify({
      schema_version: 1,
      defaults: {
        executor_profile: "fixture-executor",
        judge_profile: "fixture-judge",
      },
      evaluation: {
        mode: "deterministic-only",
        threshold: 85,
        max_revision_attempts: 2,
        judge_call_retries: 0,
        on_judge_unavailable: "fail",
        blocking_severities: ["critical", "major"],
        exhausted_policy: "fail",
      },
      profiles: {
        "fixture-executor": externalProfile("executor"),
        "fixture-judge": externalProfile("judge"),
      },
    }),
  )
}

async function fixtureWorkspace(name: "single-pass" | "two-task-order"): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await cp(resolve("tests", "fixtures", "execution", name), root, { recursive: true })
  await initializeWorkspace(root, VERSION)
  await writeConfig(root)
  return root
}

async function backendFor(root: string): Promise<ScriptedExecutionBackend> {
  const steps = JSON.parse(await readFile(resolve(root, "backend.json"), "utf8")) as ScriptedExecution[]
  return new ScriptedExecutionBackend(steps)
}

function contextFor(
  root: string,
  backend: ScriptedExecutionBackend,
  resolveJudge?: CommandContext["resolveJudge"],
): CommandContext {
  return {
    version: VERSION,
    cwd: root,
    environment: { RALPH_CONFIG_HOME: resolve(root, "isolated-global-config") },
    resolveBackend: (profile) => (profile === "fixture-executor" ? backend : undefined),
    ...(resolveJudge ? { resolveJudge } : {}),
  }
}

async function replaceCommandGatesWithFiles(root: string): Promise<void> {
  const prdPath = resolve(root, "PRD.md")
  let ordinal = 0
  const paths = ["delivery/contract.txt", "delivery/result.txt"]
  const source = await readFile(prdPath, "utf8")
  const rewritten = source.replace(/^    - command: .*$/gm, () => {
    const path = paths[ordinal]
    ordinal += 1
    if (!path) throw new Error("Unexpected command gate in two-task fixture")
    return `    - file: ${path}; exists`
  })
  expect(ordinal).toBe(2)
  await writeFile(prdPath, rewritten)
}

async function completeTwoTaskRun(root: string, context: CommandContext): Promise<string> {
  await replaceCommandGatesWithFiles(root)
  const executed = await executeCli(
    ["loop", "--workspace", root, "--prd", "PRD.md", "--no-judge", "--format", "json"],
    context,
  )
  expect(executed.exitCode).toBe(0)
  const runId = executed.execution.result.runId
  if (!runId) throw new Error("Two-task fixture did not create a run")
  return runId
}

function data<T>(result: Awaited<ReturnType<typeof executeCli>>): T {
  return result.execution.result.data as T
}

function diagnosticCodes(result: Awaited<ReturnType<typeof executeCli>>): string[] {
  return result.execution.result.diagnostics?.map((diagnostic) => diagnostic.code) ?? []
}

async function stateSnapshot(root: string, runId: string) {
  const layout = workspaceLayout(root)
  return {
    tasks: JSON.stringify(listRunTasks(layout.ledger, runId)),
    attempts: JSON.stringify(listAttempts(layout.ledger, { runId })),
    marker: await readFile(resolve(root, "PRD.md"), "utf8"),
  }
}

function assessmentOutput(score = 96): JudgeOutput {
  return {
    schemaVersion: 1,
    score,
    summary: `Standalone judge score ${score}`,
    adequate: ["The persisted evidence satisfies the deterministic contract"],
    problems: [],
    missingEvidence: [],
    recommendations: [],
    criterionScores: [{ criterion: "c1", score }],
    confidence: 0.95,
  }
}

class RecordingJudgeBackend implements JudgeBackend {
  readonly requests: JudgeRequest[] = []

  constructor(
    readonly id: string,
    private readonly output: JudgeOutput = assessmentOutput(),
  ) {}

  capabilities() {
    return {
      streaming: false,
      cancellation: true,
      structuredOutput: true,
      usage: "reported" as const,
      toolCalling: "unavailable" as const,
      mutationMode: "read-only" as const,
    }
  }

  async start(request: JudgeRequest, sink: JudgeEventSink) {
    this.requests.push(request)
    await sink.emit({
      type: "model.usage.updated",
      level: "info",
      payload: {
        schemaVersion: 1,
        eventId: `usage-${request.callId}`,
        callId: request.callId,
        sequence: 0,
        timestamp: new Date().toISOString(),
        level: "info",
        synthesized: true,
        type: "model.usage.updated",
        payload: {
          usage: {
            input: 8,
            output: 2,
            total: 10,
            source: "reported",
            semantics: "final",
            providerRawRef: `raw:provider:${request.callId}`,
          },
        },
      },
    })
    return {
      id: request.callId,
      outcome: Promise.resolve(this.output),
      rawResponseRef: Promise.resolve(`raw:judge:${request.callId}`),
    }
  }

  async cancel() {}
}

class UnsafeJudgeBackend extends RecordingJudgeBackend {
  override capabilities(): ReturnType<RecordingJudgeBackend["capabilities"]> {
    return {
      ...super.capabilities(),
      mutationMode: "workspace-write" as "read-only",
    }
  }
}

describe("S06.12 standalone verify and judge commands", () => {
  test("resolves exact selectors, rejects ambiguity, persists receipts/events, and never mutates task state", async () => {
    const root = await fixtureWorkspace("two-task-order")
    const backend = await backendFor(root)
    const context = contextFor(root, backend)
    const runId = await completeTwoTaskRun(root, context)
    const layout = workspaceLayout(root)
    const attempts = listAttempts(layout.ledger, { runId })
    const publish = attempts.find((attempt) => attempt.taskId === "publish-contract")
    if (!publish) throw new Error("Publish attempt is missing")
    const sourceEvidence = getEvidenceBundle(layout.ledger, publish.id)
    if (!sourceEvidence) throw new Error("Publish evidence is missing")
    const before = await stateSnapshot(root, runId)

    const taskWithoutRun = await executeCli(
      ["verify", "--workspace", root, "--task", "publish-contract", "--format", "json"],
      context,
    )
    expect(diagnosticCodes(taskWithoutRun)).toContain("RALPH_COMMAND_RUN_SELECTOR_REQUIRED")

    const positionalAmbiguous = await executeCli(
      ["verify", publish.id, "--workspace", root, "--format", "json"],
      context,
    )
    expect(diagnosticCodes(positionalAmbiguous)).toContain("RALPH_COMMAND_SELECTOR_AMBIGUOUS")

    const runAmbiguous = await executeCli(
      ["verify", "--workspace", root, "--run-id", runId, "--format", "json"],
      context,
    )
    expect(diagnosticCodes(runAmbiguous)).toContain("RALPH_COMMAND_SELECTOR_AMBIGUOUS")

    const mismatch = await executeCli(
      [
        "verify",
        "--workspace",
        root,
        "--run-id",
        "different-run",
        "--evidence-bundle-id",
        sourceEvidence.id,
        "--format",
        "json",
      ],
      context,
    )
    expect(diagnosticCodes(mismatch)).toContain("RALPH_COMMAND_RUN_SELECTOR_MISMATCH")

    const exact = await executeCli(
      [
        "verify",
        "task:two-task-order/publish-contract",
        "--workspace",
        root,
        "--run-id",
        runId,
        "--format",
        "json",
      ],
      context,
    )
    expect(exact.exitCode).toBe(0)
    const report = data<VerificationCommandReport>(exact)
    expect(report).toMatchObject({
      command: "verify",
      status: "passed",
      selection: {
        runId,
        attemptId: publish.id,
        evidenceBundleId: sourceEvidence.id,
        source: "execution-evidence",
      },
      executorInvoked: false,
      markerUpdated: false,
      workspaceStable: true,
      controlStateStable: true,
    })
    expect(report.evidence.id).not.toBe(sourceEvidence.id)
    expect(await readEvidenceBundleObject(root, report.evidenceObject)).toEqual(report.evidence)

    const attemptSelected = await executeCli(
      ["verify", `attempt:${publish.id}`, "--workspace", root, "--format", "json"],
      context,
    )
    expect(data<VerificationCommandReport>(attemptSelected).selection.attemptId).toBe(publish.id)

    const evidenceSelected = await executeCli(
      ["verify", `evidence:${sourceEvidence.id}`, "--workspace", root, "--format", "json"],
      context,
    )
    expect(data<VerificationCommandReport>(evidenceSelected).selection.evidenceBundleId).toBe(
      sourceEvidence.id,
    )

    const recursiveVerify = await executeCli(
      ["verify", `verification:${report.operationId}`, "--workspace", root, "--format", "json"],
      context,
    )
    expect(diagnosticCodes(recursiveVerify)).toContain("RALPH_VERIFY_SOURCE_INVALID")

    const operation = listCommandOperations(layout.ledger, { command: "verify" }).find(
      (candidate) => candidate.id === report.operationId,
    )
    expect(operation).toMatchObject({ status: "succeeded", requestHash: expect.any(String) })
    expect(operation?.report).toEqual(report)
    const eventTypes = readEvents(layout.ledger)
      .filter((event) => event.correlationId === report.operationId)
      .map((event) => event.type)
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "verify.command.started",
        "verify.evidence.persisted",
        "verify.command.finished",
      ]),
    )

    let verifyHuman = ""
    let verifyHumanError = ""
    const verifyHumanExit = await runCli(
      [
        "verify",
        `attempt:${publish.id}`,
        "--workspace",
        root,
        "--format",
        "human",
        "--no-color",
      ],
      context,
      {
        stdout: (text) => {
          verifyHuman += text
        },
        stderr: (text) => {
          verifyHumanError += text
        },
      },
    )
    expect(verifyHumanExit).toBe(0)
    expect(verifyHumanError).toBe("")
    expect(verifyHuman).toContain("Verification: passed")
    expect(verifyHuman).toContain("Report hash:")
    expect(verifyHuman).toContain("Evidence ref:")
    expect(verifyHuman).toContain("Control state: stable")
    expect(verifyHuman).toContain("Executor:     not invoked")
    expect(verifyHuman).toContain("PRD marker:   unchanged")
    expect(await stateSnapshot(root, runId)).toEqual(before)
  })

  test("defaults standalone judge to external, makes self explicit, binds receipts, and rejects unsafe mutation", async () => {
    const root = await fixtureWorkspace("two-task-order")
    const backend = await backendFor(root)
    const external = new RecordingJudgeBackend("standalone-external")
    const self = new RecordingJudgeBackend("standalone-self")
    const resolutions: Array<{ profile: string; kind: string }> = []
    const resolveJudge: NonNullable<CommandContext["resolveJudge"]> = (profile, resolution) => {
      resolutions.push({ profile, kind: resolution.kind })
      if (profile === "fixture-judge" && resolution.kind === "external") return external
      if (profile === "fixture-executor" && resolution.kind === "self") return self
      return undefined
    }
    const context = contextFor(root, backend, resolveJudge)
    const runId = await completeTwoTaskRun(root, context)
    const layout = workspaceLayout(root)
    const publish = listAttempts(layout.ledger, { runId }).find(
      (attempt) => attempt.taskId === "publish-contract",
    )
    if (!publish) throw new Error("Publish attempt is missing")
    const sourceEvidence = getEvidenceBundle(layout.ledger, publish.id)
    if (!sourceEvidence) throw new Error("Publish evidence is missing")
    const verified = await executeCli(
      ["verify", `evidence:${sourceEvidence.id}`, "--workspace", root, "--format", "json"],
      context,
    )
    const verification = data<VerificationCommandReport>(verified)
    const before = await stateSnapshot(root, runId)

    const defaultExternal = await executeCli(
      [
        "judge",
        `verification:${verification.operationId}`,
        "--workspace",
        root,
        "--format",
        "json",
      ],
      context,
    )
    expect(defaultExternal.exitCode).toBe(0)
    const externalReport = data<JudgmentCommandReport>(defaultExternal)
    expect(typeof externalReport.id).toBe("string")
    expect(typeof externalReport.operationId).toBe("string")
    expect(externalReport.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(typeof externalReport.assessment.id).toBe("string")
    expect(externalReport).toMatchObject({
      command: "judge",
      kind: "external",
      profileId: "fixture-judge",
      selection: {
        source: "verification-evidence",
        verificationOperationId: verification.operationId,
        evidenceBundleId: verification.evidence.id,
      },
      toolsAvailable: false,
      codeMutationApplied: false,
      markerUpdated: false,
      workspaceStable: true,
      controlStateStable: true,
      policy: { threshold: 85 },
      assessment: {
        score: 96,
        summary: "Standalone judge score 96",
        adequate: ["The persisted evidence satisfies the deterministic contract"],
        problems: [],
        missingEvidence: [],
        recommendations: [],
      },
      decision: { score: 96, threshold: 85 },
    })
    expect(externalReport.assessment.score).toBe(96)
    expect(externalReport.assessment.rawResponseRef).toContain("raw:judge:")

    const assessmentBytes = await readFile(resolve(root, externalReport.assessmentRef))
    expect(assessmentBytes.byteLength).toBe(externalReport.assessmentSizeBytes)
    expect(createHash("sha256").update(assessmentBytes).digest("hex")).toBe(
      externalReport.assessmentStorageHash,
    )

    const judgeEvents = readEvents(layout.ledger).filter(
      (event) => event.correlationId === externalReport.operationId,
    )
    expect(judgeEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "judge.command.started",
        "judge.attachments.materialized",
        "judge.call.started",
        "judge.backend.model.usage.updated",
        "judge.call.finished",
        "judge.assessment.persisted",
        "judge.command.finished",
      ]),
    )
    expect(JSON.stringify(judgeEvents)).toContain("raw:provider:")

    const selfReview = await executeCli(
      [
        "judge",
        `evidence:${sourceEvidence.id}`,
        "--workspace",
        root,
        "--self-review",
        "--format",
        "json",
      ],
      context,
    )
    expect(selfReview.exitCode).toBe(0)
    expect(data<JudgmentCommandReport>(selfReview)).toMatchObject({
      kind: "self",
      profileId: "fixture-executor",
      selection: { source: "execution-evidence", evidenceBundleId: sourceEvidence.id },
    })
    expect(resolutions).toEqual([
      { profile: "fixture-judge", kind: "external" },
      { profile: "fixture-executor", kind: "self" },
    ])

    let judgeHuman = ""
    let judgeHumanError = ""
    const judgeHumanExit = await runCli(
      [
        "judge",
        `verification:${verification.operationId}`,
        "--workspace",
        root,
        "--format",
        "human",
        "--no-color",
      ],
      context,
      {
        stdout: (text) => {
          judgeHuman += text
        },
        stderr: (text) => {
          judgeHumanError += text
        },
      },
    )
    expect(judgeHumanExit).toBe(0)
    expect(judgeHumanError).toBe("")
    expect(judgeHuman).toContain("Judgment:     passed")
    expect(judgeHuman).toContain("Report hash:")
    expect(judgeHuman).toContain("Assessment ref:")
    expect(judgeHuman).toContain("Score:        96/100 (threshold 85)")
    expect(judgeHuman).toContain("Adequate:  The persisted evidence satisfies")
    expect(judgeHuman).toContain("Problem:   none reported")
    expect(judgeHuman).toContain("Control state: stable")
    expect(judgeHuman).toContain("Tools:        unavailable")
    expect(judgeHuman).toContain("PRD marker:   unchanged")

    const idempotent = finishCommandOperation(layout.ledger, {
      id: externalReport.operationId,
      report: externalReport,
    })
    expect(idempotent.status).toBe("succeeded")
    const { contentHash: _contentHash, ...alteredBody } = {
      ...externalReport,
      finishedAt: new Date(Date.parse(externalReport.finishedAt) + 1_000).toISOString(),
    }
    const alteredReport = JudgmentCommandReportSchema.parse({
      ...alteredBody,
      contentHash: commandOperationReportHash(alteredBody),
    })
    expect(() =>
      finishCommandOperation(layout.ledger, {
        id: externalReport.operationId,
        report: alteredReport,
      }),
    ).toThrow("already terminal")

    const evidencePath = resolve(root, verification.evidenceObject.contentRef)
    const originalEvidenceBytes = await readFile(evidencePath)

    await expect(
      readEvidenceBundleObject(root, {
        ...verification.evidenceObject,
        sizeBytes: verification.evidenceObject.sizeBytes + 1,
      }),
    ).rejects.toMatchObject({ code: "RALPH_EVIDENCE_OBJECT_SIZE_MISMATCH" })
    await expect(
      readEvidenceBundleObject(root, {
        ...verification.evidenceObject,
        storageHash:
          verification.evidenceObject.storageHash === "0".repeat(64)
            ? "1".repeat(64)
            : "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "RALPH_EVIDENCE_OBJECT_HASH_MISMATCH" })
    await expect(
      readEvidenceBundleObject(root, {
        ...verification.evidenceObject,
        contentRef: "../escaped-evidence.json",
      }),
    ).rejects.toMatchObject({ code: "RALPH_EVIDENCE_OBJECT_REF_INVALID" })

    const missingEvidencePath = `${evidencePath}.temporarily-missing`
    await rename(evidencePath, missingEvidencePath)
    try {
      const missing = await executeCli(
        [
          "judge",
          `verification:${verification.operationId}`,
          "--workspace",
          root,
          "--format",
          "json",
        ],
        context,
      )
      expect(diagnosticCodes(missing)).toContain("RALPH_EVIDENCE_OBJECT_MISSING")
    } finally {
      await rename(missingEvidencePath, evidencePath)
    }

    const tamperedEvidenceBytes = Buffer.from(originalEvidenceBytes)
    tamperedEvidenceBytes[0] = tamperedEvidenceBytes[0] === 0x7b ? 0x5b : 0x7b
    await writeFile(evidencePath, tamperedEvidenceBytes)
    const tampered = await executeCli(
      [
        "judge",
        `verification:${verification.operationId}`,
        "--workspace",
        root,
        "--format",
        "json",
      ],
      context,
    )
    expect(diagnosticCodes(tampered)).toContain("RALPH_EVIDENCE_OBJECT_HASH_MISMATCH")
    await writeFile(evidencePath, originalEvidenceBytes)

    const unsafe = new UnsafeJudgeBackend("unsafe-judge")
    const unsafeResult = await executeCli(
      [
        "judge",
        `evidence:${sourceEvidence.id}`,
        "--workspace",
        root,
        "--judge-profile",
        "fixture-judge",
        "--format",
        "json",
      ],
      contextFor(root, backend, () => unsafe),
    )
    expect(diagnosticCodes(unsafeResult)).toContain("RALPH_JUDGE_CAPABILITY_UNSAFE")
    expect(listCommandOperations(layout.ledger, { command: "judge", status: "failed" })).toHaveLength(
      1,
    )
    expect(await stateSnapshot(root, runId)).toEqual(before)
  })

  test("reconstructs persisted ad-hoc source and verifies it without creating or changing a PRD marker", async () => {
    const root = await fixtureWorkspace("single-pass")
    const description = "Materialize a bounded ad-hoc proof"
    const materialized = materializeAdHocExecutionSource(description)
    if (materialized.source.kind !== "ad-hoc") {
      throw new Error("Ad-hoc materialization returned an unexpected source kind")
    }
    const backend = new ScriptedExecutionBackend([
      {
        expectedTask: `${materialized.graph.rootDocumentId}/request`,
        actions: [{ type: "write", path: "product/ad-hoc-proof.txt", content: "materialized" }],
      },
    ])
    const context = contextFor(root, backend)
    const originalPrd = await readFile(resolve(root, "PRD.md"), "utf8")
    const executed = await executeCli(
      ["once", description, "--workspace", root, "--no-judge", "--format", "json"],
      context,
    )
    expect(executed.exitCode).toBe(0)
    const runId = executed.execution.result.runId
    if (!runId) throw new Error("Ad-hoc fixture did not create a run")
    const layout = workspaceLayout(root)
    const run = getRun(layout.ledger, runId)
    expect(run?.source).toMatchObject({
      kind: "ad-hoc",
      description,
      descriptionHash: materialized.source.descriptionHash,
    })
    const attempt = listAttempts(layout.ledger, { runId })[0]
    if (!attempt) throw new Error("Ad-hoc attempt is missing")
    const before = await stateSnapshot(root, runId)
    const verified = await executeCli(
      ["verify", `attempt:${attempt.id}`, "--workspace", root, "--format", "json"],
      context,
    )
    expect(verified.exitCode).toBe(0)
    expect(data<VerificationCommandReport>(verified)).toMatchObject({
      status: "passed",
      selection: { runId, documentId: materialized.graph.rootDocumentId, taskId: "request" },
      gateCount: 0,
      markerUpdated: false,
      executorInvoked: false,
      workspaceStable: true,
      controlStateStable: true,
      evidence: { gates: [], task: { evidenceMode: "change-only" } },
    })
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toBe(originalPrd)
    expect(await stateSnapshot(root, runId)).toEqual(before)
  })
})
