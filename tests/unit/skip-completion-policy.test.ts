import { afterEach, describe, expect, test } from "bun:test"
import {
  ChangeEvidenceSchema,
  type GateResult,
  GateResultSchema,
  GitBaselineSchema,
} from "@ralph-next/domain"
import {
  compilePrdGraph,
  type PrdTask,
  type VerificationSpec,
  VerificationSpecSchema,
} from "@ralph-next/prd"
import {
  buildEvidenceBundle,
  decideDeterministicCompletion,
  runVerification,
} from "@ralph-next/verification"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const TASK_FIXTURE = "tests/fixtures/execution/single-pass/PRD.md"
const HASH = "b".repeat(64)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

function commandVerification(input: {
  id: string
  category: Extract<VerificationSpec, { type: "command" }>["category"]
  skipPolicy: VerificationSpec["skipPolicy"]
  blocking: boolean
  exitCode?: number
}): VerificationSpec {
  return VerificationSpecSchema.parse({
    type: "command",
    id: input.id,
    category: input.category,
    skipPolicy: input.skipPolicy,
    blocking: input.blocking,
    command: {
      executable: process.execPath,
      args: ["-e", `process.exit(${input.exitCode ?? 0})`],
      shell: false,
      timeoutMs: 5_000,
      successExitCodes: [0],
      outputLimitBytes: 1_024,
    },
  })
}

async function compiledTask(): Promise<PrdTask> {
  const compiled = await compilePrdGraph(TASK_FIXTURE, {
    workspaceRoot: process.cwd(),
    recursive: true,
    strict: true,
  })
  if (!compiled.ok || !compiled.graph) throw new Error("Expected completion fixture to compile")
  const reference = compiled.graph.topologicalOrder[0]
  const task = reference
    ? compiled.graph.documents[reference.documentId]?.tasks.find(
        (candidate) => candidate.id === reference.taskId,
      )
    : undefined
  if (!task) throw new Error("Expected one completion fixture task")
  return task
}

const baseline = GitBaselineSchema.parse({
  schemaVersion: 1,
  kind: "workspace",
  revision: null,
  branch: null,
  dirty: false,
  statusHash: HASH,
  workspaceSnapshotHash: HASH,
  capturedAt: "2026-07-18T12:00:00.000Z",
})

const changed = ChangeEvidenceSchema.parse({
  schemaVersion: 1,
  policy: "require-change",
  status: "changed",
  files: [
    {
      path: "product/capability.txt",
      kind: "created",
      contentHash: HASH,
      sizeBytes: 9,
    },
  ],
  outsideScopePaths: [],
  reproducible: true,
  missingContent: [],
  diffHash: HASH,
  diffRef: "evidence/workspace-diff.json",
  attemptDiffHash: HASH,
  attemptDiffRef: "evidence/attempt-diff.json",
})

function gate(gateId: string, status: GateResult["status"], category = "test"): GateResult {
  return GateResultSchema.parse({
    gateId,
    category,
    blocking: true,
    status,
    durationMs: 0,
    outputRefs: [],
    ...(status === "passed" ? {} : { reason: `Fixture gate is ${status}` }),
  })
}

function evidence(task: PrdTask, id: string, gates: GateResult[]) {
  return buildEvidenceBundle({
    id,
    runId: "run-completion-policy",
    documentId: "single-pass",
    task,
    attemptId: `attempt-${id}`,
    baseline,
    changes: changed,
    artifacts: [],
    gates,
    contextManifestHash: HASH,
    createdAt: "2026-07-18T12:00:01.000Z",
  })
}

describe("S03 verification skip policy", () => {
  test("skips allowed-to-skip gates, executes required gates, and requires force to skip required", async () => {
    const workspaceRoot = await temporaryDirectory()
    const allowed = commandVerification({
      id: "allowed-test",
      category: "test",
      skipPolicy: "allowed-to-skip",
      blocking: true,
      exitCode: 9,
    })
    const required = commandVerification({
      id: "required-test",
      category: "test",
      skipPolicy: "required",
      blocking: true,
    })

    const allowedResult = await runVerification(allowed, { workspaceRoot, skipTests: true })
    expect(allowedResult).toMatchObject({
      status: "skipped_by_cli",
      overridden: false,
      reason: "Skipped by explicit test skip request",
    })

    const requiredResult = await runVerification(required, { workspaceRoot, skipTests: true })
    expect(requiredResult).toMatchObject({ status: "passed", overridden: false })

    const forcedResult = await runVerification(required, {
      workspaceRoot,
      skipTests: true,
      force: true,
    })
    expect(forcedResult).toMatchObject({
      status: "skipped_by_cli",
      overridden: true,
      reason:
        "Required verification skipped by explicit --force override (Skipped by explicit test skip request)",
    })
  })

  test.each(["test", "lint", "typecheck", "build", "security"] as const)(
    "fast explicitly skips an allowed-to-skip %s gate",
    async (category) => {
      const workspaceRoot = await temporaryDirectory()
      const result = await runVerification(
        commandVerification({
          id: `fast-${category}`,
          category,
          skipPolicy: "allowed-to-skip",
          blocking: true,
          exitCode: 9,
        }),
        { workspaceRoot, fast: true },
      )

      expect(result).toMatchObject({ status: "skipped_by_cli", overridden: false })
    },
  )

  test("fast skips every policy-skippable category but not required gates without force", async () => {
    const workspaceRoot = await temporaryDirectory()
    const generic = await runVerification(
      commandVerification({
        id: "generic-command",
        category: "command",
        skipPolicy: "allowed-to-skip",
        blocking: true,
      }),
      { workspaceRoot, fast: true },
    )
    const required = await runVerification(
      commandVerification({
        id: "required-fast-test",
        category: "test",
        skipPolicy: "required",
        blocking: true,
      }),
      { workspaceRoot, fast: true },
    )

    expect(generic).toMatchObject({
      status: "skipped_by_cli",
      reason: "Skipped by explicit --fast request",
    })
    expect(required.status).toBe("passed")
  })

  test("never-run is represented as skipped_by_policy rather than pass", async () => {
    const workspaceRoot = await temporaryDirectory()
    const result = await runVerification(
      commandVerification({
        id: "policy-disabled",
        category: "command",
        skipPolicy: "never-run",
        blocking: false,
      }),
      { workspaceRoot },
    )

    expect(result).toMatchObject({
      status: "skipped_by_policy",
      overridden: false,
      reason: "Verification policy is never-run",
    })
  })
})

describe("S03 deterministic completion policy", () => {
  test("an allowed blocking skip remains skipped evidence without blocking completion", async () => {
    const task = await compiledTask()
    const declaredProof = task.verification.find(
      (specification) =>
        specification.type !== "instruction" && specification.skipPolicy !== "never-run",
    )
    if (!declaredProof) throw new Error("Expected one declared deterministic verification")
    const allowedSkip = GateResultSchema.parse({
      gateId: "optional-expensive-test",
      category: "test",
      blocking: true,
      skipPolicy: "allowed-to-skip",
      status: "skipped_by_cli",
      durationMs: 0,
      attempts: 0,
      outputRefs: [],
      reason: "Skipped by explicit test skip request",
    })
    const result = decideDeterministicCompletion({
      task,
      evidence: evidence(task, "evidence-authorized-skip", [
        gate(declaredProof.id, "passed"),
        allowedSkip,
      ]),
      decidedAt: "2026-07-18T12:00:02.000Z",
    })

    expect(result.decision.status).toBe("passed")
    expect(result.overrideUsed).toBeFalse()
    expect(result.decision.reasons.join(" ")).toContain("allowed-to-skip")
  })

  test("never completes from non-reproducible change evidence", async () => {
    const task = await compiledTask()
    const missingChanges = ChangeEvidenceSchema.parse({
      ...changed,
      reproducible: false,
      missingContent: [
        {
          path: "large-output.bin",
          side: "after",
          reason: "per-file retention limit",
        },
      ],
    })
    const bundle = buildEvidenceBundle({
      id: "evidence-non-reproducible",
      runId: "run-completion-policy",
      documentId: "single-pass",
      task,
      attemptId: "attempt-non-reproducible",
      baseline,
      changes: missingChanges,
      artifacts: [],
      gates: [gate("criterion-proof", "passed")],
      contextManifestHash: HASH,
      createdAt: "2026-07-18T12:00:01.000Z",
    })

    const result = decideDeterministicCompletion({
      task,
      evidence: bundle,
      decidedAt: "2026-07-18T12:00:02.000Z",
    })

    expect(result.decision).toMatchObject({ status: "failed", deterministicPassed: false })
    expect(result.decision.reasons.join("\n")).toContain("not reproducible")
    expect(result.decision.reasons.join("\n")).toContain("large-output.bin")
  })

  test("a blocking failure never passes, even when criteria evidence passes", async () => {
    const task = await compiledTask()
    const bundle = evidence(task, "evidence-blocking-failure", [
      gate("criterion-proof", "passed"),
      gate("blocking-failure", "failed"),
    ])
    const result = decideDeterministicCompletion({
      task,
      evidence: bundle,
      overrideGateIds: new Set(["blocking-failure"]),
      decidedAt: "2026-07-18T12:00:02.000Z",
    })

    expect(result.decision).toMatchObject({ status: "failed", deterministicPassed: false })
    expect(result.overrideUsed).toBeFalse()
    expect(result.decision.reasons).toContain("Blocking gate blocking-failure is failed")
  })

  test("a required skip needs its audit and another passed proof before override completion", async () => {
    const baseTask = await compiledTask()
    const skippedGate = baseTask.verification.find(
      (specification) =>
        specification.type !== "instruction" && specification.skipPolicy !== "never-run",
    )
    if (!skippedGate) throw new Error("Expected one declared deterministic verification")
    const criterionProof = commandVerification({
      id: "criterion-proof",
      category: "test",
      skipPolicy: "required",
      blocking: true,
    })
    const task: PrdTask = {
      ...baseTask,
      verification: [...baseTask.verification, criterionProof],
    }
    const skippedGateId = skippedGate.id
    const sufficient = evidence(task, "evidence-sufficient-override", [
      gate(skippedGateId, "skipped_by_cli"),
      gate(criterionProof.id, "passed"),
    ])

    const unaudited = decideDeterministicCompletion({
      task,
      evidence: sufficient,
      decidedAt: "2026-07-18T12:00:02.000Z",
    })
    expect(unaudited.decision.status).toBe("failed")

    const audited = decideDeterministicCompletion({
      task,
      evidence: sufficient,
      overrideGateIds: new Set([skippedGateId]),
      decidedAt: "2026-07-18T12:00:02.000Z",
    })
    expect(audited).toMatchObject({ overrideUsed: true, retryNoChange: false })
    expect(audited.decision).toMatchObject({
      status: "overridden",
      deterministicPassed: true,
    })

    const noCriterionProof = decideDeterministicCompletion({
      task,
      evidence: evidence(task, "evidence-insufficient-override", [
        gate(skippedGateId, "skipped_by_cli"),
      ]),
      overrideGateIds: new Set([skippedGateId]),
      decidedAt: "2026-07-18T12:00:02.000Z",
    })
    expect(noCriterionProof.decision).toMatchObject({
      status: "failed",
      deterministicPassed: false,
    })
    expect(noCriterionProof.decision.reasons).toContain(
      "Criteria mode has no passed deterministic verification",
    )
  })
})
