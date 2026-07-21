import { describe, expect, test } from "bun:test"
import {
  ArtifactEvidenceV2Schema,
  ChangeEvidenceSchema,
  type GateResult,
  GateResultSchema,
  GitBaselineSchema,
} from "@ralph/domain"
import {
  compilePrdGraph,
  type PrdTask,
  type VerificationSpec,
  VerificationSpecSchema,
} from "@ralph/prd"
import { buildEvidenceBundle, decideDeterministicCompletion } from "@ralph/verification"

const HASH = "b".repeat(64)
const TASK_FIXTURE = "tests/fixtures/execution/single-pass/PRD.md"

async function compiledTask(): Promise<PrdTask> {
  const compiled = await compilePrdGraph(TASK_FIXTURE, {
    workspaceRoot: process.cwd(),
    recursive: true,
    strict: true,
  })
  const reference = compiled.graph?.topologicalOrder[0]
  const task = reference
    ? compiled.graph?.documents[reference.documentId]?.tasks.find(
        (candidate) => candidate.id === reference.taskId,
      )
    : undefined
  if (!compiled.ok || !task) throw new Error("Expected completion fixture task")
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

function changes(status: "changed" | "unchanged") {
  return ChangeEvidenceSchema.parse({
    schemaVersion: 1,
    policy: status === "changed" ? "require-change" : "allow-no-change",
    status,
    files:
      status === "changed"
        ? [{ path: "proof.json", kind: "created", contentHash: HASH, sizeBytes: 2 }]
        : [],
    outsideScopePaths: [],
    reproducible: true,
    missingContent: [],
    diffHash: HASH,
    diffRef: "evidence/task-diff.json",
    attemptDiffHash: HASH,
    attemptDiffRef: "evidence/attempt-diff.json",
  })
}

function result(
  specification: VerificationSpec,
  status: GateResult["status"] = "passed",
  options: { includeCriterionIds?: boolean } = {},
): GateResult {
  return GateResultSchema.parse({
    gateId: specification.id,
    category: specification.category,
    blocking: specification.blocking,
    skipPolicy: specification.skipPolicy,
    ...(options.includeCriterionIds !== false &&
    specification.type !== "instruction" &&
    specification.criterionIds
      ? { criterionIds: specification.criterionIds }
      : {}),
    status,
    durationMs: 1,
    attempts: 1,
    outputRefs: [],
    ...(status === "passed" ? {} : { reason: `Gate is ${status}` }),
  })
}

function artifact(id = "proof", path = "proof.json") {
  return ArtifactEvidenceV2Schema.parse({
    artifactId: id,
    path,
    contentHash: HASH,
    sizeBytes: 2,
    mediaType: "application/json",
    immutableRef: ".ralph/runs/run/artifacts/sha256/proof",
    status: "passed",
    validation: { status: "not_requested" },
  })
}

function evidence(input: {
  task: PrdTask
  gates: GateResult[]
  artifacts?: ReturnType<typeof artifact>[]
  changeStatus?: "changed" | "unchanged"
}) {
  return buildEvidenceBundle({
    id: `evidence-${input.task.evidenceMode}-${input.changeStatus ?? "changed"}`,
    runId: "run-s06-compositions",
    documentId: "single-pass",
    task: input.task,
    attemptId: "attempt-s06-compositions",
    baseline,
    changes: changes(input.changeStatus ?? "changed"),
    artifacts: input.artifacts ?? [],
    gates: input.gates,
    contextManifestHash: HASH,
    createdAt: "2026-07-18T12:00:01.000Z",
  })
}

function namedArtifactVerification(): Extract<VerificationSpec, { type: "artifact" }> {
  return VerificationSpecSchema.parse({
    type: "artifact",
    id: "slice:verification:artifact",
    artifactId: "proof",
    path: "proof.json",
    category: "artifact",
    skipPolicy: "required",
    blocking: true,
  }) as Extract<VerificationSpec, { type: "artifact" }>
}

describe("S06 deterministic evidence compositions", () => {
  test("criteria+artifact requires a criterion-linked gate and the exact named artifact", async () => {
    const base = await compiledTask()
    const criterionGate = VerificationSpecSchema.parse({
      type: "file",
      id: "slice:verification:criterion",
      path: "proof.json",
      expectation: { kind: "exists" },
      category: "file",
      skipPolicy: "required",
      blocking: true,
      criterionIds: ["c1"],
    })
    const artifactGate = namedArtifactVerification()
    const task: PrdTask = {
      ...base,
      evidenceMode: "criteria+artifact",
      verification: [criterionGate, artifactGate],
    }

    const passed = decideDeterministicCompletion({
      task,
      evidence: evidence({
        task,
        gates: [result(criterionGate), result(artifactGate)],
        artifacts: [artifact()],
      }),
    })
    expect(passed.decision).toMatchObject({ status: "passed", deterministicPassed: true })

    const unlinkedResult = decideDeterministicCompletion({
      task,
      evidence: evidence({
        task,
        gates: [
          result(criterionGate, "passed", { includeCriterionIds: false }),
          result(artifactGate),
        ],
        artifacts: [artifact()],
      }),
    })
    expect(unlinkedResult.decision.status).toBe("failed")
    expect(unlinkedResult.decision.reasons).toContain(
      "Criterion c1 has no passed linked deterministic evidence",
    )

    const wrongNamedArtifact = decideDeterministicCompletion({
      task,
      evidence: evidence({
        task,
        gates: [result(criterionGate), result(artifactGate)],
        artifacts: [artifact("other-proof")],
      }),
    })
    expect(wrongNamedArtifact.decision.status).toBe("failed")
    expect(wrongNamedArtifact.decision.reasons.join(" ")).toContain(
      "Required declared artifacts have no matching passed evidence: proof (proof.json)",
    )
  })

  test("artifact mode no longer accepts a generic passed file gate", async () => {
    const base = await compiledTask()
    const file = VerificationSpecSchema.parse({
      type: "file",
      id: "slice:verification:file-only",
      path: "proof.json",
      expectation: { kind: "exists" },
      category: "file",
      skipPolicy: "required",
      blocking: true,
    })
    const task: PrdTask = { ...base, evidenceMode: "artifact", verification: [file] }
    const decision = decideDeterministicCompletion({
      task,
      evidence: evidence({ task, gates: [result(file)] }),
    })

    expect(decision.decision.status).toBe("failed")
    expect(decision.decision.reasons).toContain(
      "Artifact evidence mode requires an explicitly named artifact declaration",
    )
  })

  test("change+artifact requires both a permitted delta and matching named artifact", async () => {
    const base = await compiledTask()
    const artifactGate = namedArtifactVerification()
    const task: PrdTask = {
      ...base,
      evidenceMode: "change+artifact",
      verification: [artifactGate],
    }
    const changed = decideDeterministicCompletion({
      task,
      evidence: evidence({ task, gates: [result(artifactGate)], artifacts: [artifact()] }),
    })
    const unchanged = decideDeterministicCompletion({
      task,
      evidence: evidence({
        task,
        gates: [result(artifactGate)],
        artifacts: [artifact()],
        changeStatus: "unchanged",
      }),
    })

    expect(changed.decision).toMatchObject({ status: "passed", deterministicPassed: true })
    expect(unchanged.decision.status).toBe("failed")
    expect(unchanged.decision.reasons).toContain(
      "Evidence mode change+artifact requires a permitted change",
    )
  })
})
