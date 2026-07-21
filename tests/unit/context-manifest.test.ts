import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  ContextAssessmentFeedbackSchema,
  ContextBudgetSchema,
  GitBaselineSchema,
  JudgeAssessmentSchema,
} from "@ralph/domain"
import { compilePrdGraph } from "@ralph/prd"
import {
  buildContextManifest,
  ContextBuildError,
  canonicalContextManifestBundle,
  contextManifestBundleHash,
} from "../../packages/orchestration/src/context"

const FIXTURE = "tests/fixtures/prd/v2/valid-en.md"
const HASH = "a".repeat(64)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const baseline = GitBaselineSchema.parse({
  schemaVersion: 1,
  kind: "git",
  revision: "abc123",
  branch: "feature/context",
  dirty: true,
  statusHash: HASH,
  workspaceSnapshotHash: HASH,
  capturedAt: "2026-07-18T12:00:00.000Z",
})

const budget = ContextBudgetSchema.parse({
  remainingModelCalls: 2,
  remainingToolCalls: 3,
  remainingIterations: 1,
  remainingInputTokens: 1_000,
  remainingOutputTokens: 500,
  deadlineAt: "2026-07-18T12:10:00.000Z",
})

async function compiledFixture(file = FIXTURE, workspaceRoot = process.cwd()) {
  const compiled = await compilePrdGraph(file, {
    workspaceRoot,
    recursive: true,
    strict: true,
  })
  if (!compiled.ok || !compiled.graph) throw new Error("Expected the valid PRD fixture to compile")
  const task = compiled.graph.topologicalOrder[0]
  if (!task) throw new Error("Expected one compiled task")
  return { graph: compiled.graph, task }
}

function caughtCode(error: unknown): string | undefined {
  return error instanceof ContextBuildError ? error.code : undefined
}

describe("S03 context manifest bundle", () => {
  test("materializes a minimal once context with content-addressed verification resources", async () => {
    const { graph, task } = await compiledFixture()
    const bundle = await buildContextManifest({
      graph,
      task,
      runId: "run-context-golden",
      attemptId: "attempt-context-golden",
      mode: "once",
      baseline,
      budget,
      declaredFileRefs: ["contracts/api.json"],
      parentContextRefs: ["context://sha256/parent/context.json"],
      additionalInvariants: ["Preserve the fixture contract."],
      createdAt: "2026-07-18T12:00:01.000Z",
    })

    expect(bundle.manifest.fullPrd).toBeUndefined()
    expect(bundle.manifest.sharedContext).toContain("Context with Unicode")
    expect(bundle.manifest.task.documentId).toBe("english-contract")
    expect(bundle.manifest.task.taskId).toBe("english-slice")
    expect(bundle.manifest.task.evidenceMode).toBe("criteria")
    expect(bundle.manifest.task.boundaries[0]).toContain("Do not select a language")
    expect(bundle.manifest.task.criteria[0]?.id).toBe("c1")
    expect(bundle.manifest.task.criteria[0]?.text).toContain("observable result")
    expect(bundle.manifest.task.notes).toEqual(["Preserve the human wording."])
    expect(bundle.manifest.budget).toMatchObject({
      maxTotalTokens: 350,
      maxCost: { amount: 1.25, currency: "USD" },
      taskTimeout: { source: "90s", milliseconds: 90_000 },
      deadlineAt: "2026-07-18T12:10:00.000Z",
    })
    expect(bundle.resources).toHaveLength(1)
    const verificationResource = bundle.resources[0]
    if (!verificationResource) throw new Error("Expected a verification context resource")
    expect(verificationResource).toMatchObject({
      kind: "verification",
      mediaType: "application/json",
      truncated: false,
    })
    expect(bundle.manifest.task.verificationRefs).toEqual([verificationResource.ref])
    expect(bundle.manifest.declaredFileRefs).toContain("contracts/api.json")
    expect(bundle.manifest.authority).toEqual({
      taskSelection: "ralph",
      taskCompletion: "ralph-policy",
      subPrdCreation: "preauthored-only",
    })
    expect(bundle.canonicalJson).not.toContain(resolve(process.cwd()).replaceAll("\\", "/"))
    expect(canonicalContextManifestBundle(bundle)).toBe(bundle.canonicalJson)
    expect(contextManifestBundleHash(bundle)).toBe(bundle.manifest.contentHash)

    expect({
      hash: bundle.manifest.contentHash,
      id: bundle.manifest.id,
      resourceHashes: bundle.resources.map((resource) => resource.contentHash),
      canonicalBytes: Buffer.byteLength(bundle.canonicalJson, "utf8"),
    }).toEqual({
      hash: "24d36ab8433921c37a8c9d1d9a81ef30a2e6bb4447f15cd97fd032c830f0007e",
      id: "context-24d36ab8433921c37a8c9d1d",
      resourceHashes: ["c0b10b7b8d27e1996b8f04c3b6fc13674cc7e42af1543aa285221db9ab571745"],
      canonicalBytes: 2_735,
    })
  })

  test("excludes observational timestamps but authenticates the execution deadline", async () => {
    const { graph, task } = await compiledFixture()
    const first = await buildContextManifest({
      graph,
      task,
      runId: "run-stable",
      attemptId: "attempt-stable",
      mode: "loop",
      baseline,
      budget,
      createdAt: "2026-07-18T12:00:01.000Z",
    })
    const later = await buildContextManifest({
      graph,
      task,
      runId: "run-stable",
      attemptId: "attempt-stable",
      mode: "loop",
      baseline: {
        ...baseline,
        capturedAt: "2027-01-01T00:00:00.000Z",
      },
      budget,
      createdAt: "2027-01-01T00:00:01.000Z",
    })
    expect(later.manifest.createdAt).not.toBe(first.manifest.createdAt)
    expect(later.manifest.baseline.capturedAt).not.toBe(first.manifest.baseline.capturedAt)
    expect(later.manifest.contentHash).toBe(first.manifest.contentHash)
    expect(later.canonicalJson).toBe(first.canonicalJson)

    const changedDeadline = await buildContextManifest({
      graph,
      task,
      runId: "run-stable",
      attemptId: "attempt-stable",
      mode: "loop",
      baseline,
      budget: {
        ...budget,
        deadlineAt: "2027-01-01T01:00:00.000Z",
      },
      createdAt: "2026-07-18T12:00:01.000Z",
    })
    expect(changedDeadline.manifest.contentHash).not.toBe(first.manifest.contentHash)
    expect(changedDeadline.canonicalJson).not.toBe(first.canonicalJson)

    const tampered = {
      ...first,
      manifest: {
        ...first.manifest,
        budget: {
          ...first.manifest.budget,
          deadlineAt: "2027-01-01T01:00:00.000Z",
        },
      },
    }
    expect(contextManifestBundleHash(tampered)).not.toBe(tampered.manifest.contentHash)
  })

  test("preserves criterion policy metadata and bounded task notes", async () => {
    const { graph, task } = await compiledFixture()
    const document = graph.documents[task.documentId]
    if (!document) throw new Error("Expected the selected task document")
    const enrichedGraph = {
      ...graph,
      documents: {
        ...graph.documents,
        [document.id]: {
          ...document,
          tasks: document.tasks.map((candidate) =>
            candidate.id === task.taskId
              ? {
                  ...candidate,
                  criteria: candidate.criteria.map((criterion, index) =>
                    index === 0 ? { ...criterion, weight: 3, blocking: true } : criterion,
                  ),
                }
              : candidate,
          ),
        },
      },
    }
    const bundle = await buildContextManifest({
      graph: enrichedGraph,
      task,
      runId: "run-criterion-policy",
      attemptId: "attempt-criterion-policy",
      mode: "once",
      baseline,
      budget,
      createdAt: "2026-07-18T12:00:01.000Z",
    })

    expect(bundle.manifest.task.criteria[0]).toMatchObject({
      id: "c1",
      weight: 3,
      blocking: true,
    })
    expect(bundle.manifest.task.notes).toEqual(["Preserve the human wording."])
  })

  test("materializes prior judge feedback as a bounded, immutable assessment resource", async () => {
    const { graph, task } = await compiledFixture()
    const assessmentRef =
      ".ralph/runs/run-feedback/evaluation/assessments/assessment-feedback.assessment.json"
    const assessment = JudgeAssessmentSchema.parse({
      schemaVersion: 1,
      id: "assessment-feedback",
      kind: "external",
      profileSnapshot: {
        id: "judge-sensitive-profile",
        role: "judge",
        backend: "embedded",
        provider: "provider-sensitive",
        model: "model-sensitive",
        contentHash: "b".repeat(64),
      },
      evidenceBundleId: "evidence-before-revision",
      score: 60,
      summary: "The error state is not demonstrated.",
      adequate: ["The main path is connected."],
      problems: [
        {
          severity: "major",
          criterion: "c1",
          message: "The failure path lacks an assertion.",
          evidenceRefs: ["evidence://before-revision"],
        },
      ],
      missingEvidence: ["A deterministic failure-path result."],
      recommendations: ["Add the missing failure-path assertion."],
      criterionScores: [{ criterion: "c1", score: 60, rationale: "Only the main path passed." }],
      rawResponseRef: "raw://must-not-enter-executor-context",
      createdAt: "2026-07-18T12:00:00.000Z",
    })
    const bundle = await buildContextManifest({
      graph,
      task,
      runId: "run-feedback",
      attemptId: "attempt-revision",
      mode: "once",
      baseline,
      budget,
      previousAssessmentRef: assessmentRef,
      revisionFeedback: { assessment, assessmentRef, threshold: 85 },
      createdAt: "2026-07-18T12:00:01.000Z",
    })

    const resource = bundle.resources.find((candidate) => candidate.kind === "assessment")
    expect(resource).toBeDefined()
    if (!resource || !bundle.manifest.revisionFeedback) {
      throw new Error("Expected the revision assessment resource and manifest pointer")
    }
    const feedback = ContextAssessmentFeedbackSchema.parse(JSON.parse(resource.content))
    expect(feedback).toEqual({
      schemaVersion: 1,
      sourceAssessmentRef: assessmentRef,
      sourceAssessmentId: assessment.id,
      sourceEvidenceBundleId: assessment.evidenceBundleId,
      sourceKind: "external",
      score: 60,
      threshold: 85,
      summary: assessment.summary,
      adequate: assessment.adequate,
      problems: assessment.problems,
      missingEvidence: assessment.missingEvidence,
      recommendations: assessment.recommendations,
      criterionScores: assessment.criterionScores,
    })
    expect(bundle.manifest.previousAssessmentRef).toBe(assessmentRef)
    expect(bundle.manifest.revisionFeedback).toMatchObject({
      kind: "assessment",
      ref: resource.ref,
      sourceAssessmentRef: assessmentRef,
      sourceAssessmentId: assessment.id,
      sourceEvidenceBundleId: assessment.evidenceBundleId,
      contentHash: resource.contentHash,
      includedHash: resource.includedHash,
      score: 60,
      threshold: 85,
      truncated: false,
    })
    expect(resource.content).not.toContain("judge-sensitive-profile")
    expect(resource.content).not.toContain("provider-sensitive")
    expect(resource.content).not.toContain("model-sensitive")
    expect(resource.content).not.toContain("raw://must-not-enter-executor-context")
    expect(contextManifestBundleHash(bundle)).toBe(bundle.manifest.contentHash)

    const tampered = {
      ...bundle,
      resources: bundle.resources.map((candidate) =>
        candidate.ref === resource.ref
          ? { ...candidate, content: candidate.content.replace("failure-path", "success-path") }
          : candidate,
      ),
    }
    expect(contextManifestBundleHash(tampered)).not.toBe(tampered.manifest.contentHash)
  })

  test("keeps oversized assessment feedback valid JSON and reports deterministic truncation", async () => {
    const { graph, task } = await compiledFixture()
    const assessmentRef = ".ralph/runs/run-feedback/evaluation/assessment-large.json"
    const long = "specific-feedback-".repeat(1_000)
    const assessment = JudgeAssessmentSchema.parse({
      schemaVersion: 1,
      id: "assessment-large",
      kind: "self",
      profileSnapshot: {
        id: "judge-self",
        role: "executor",
        backend: "embedded",
        provider: "fixture",
        model: "fixture",
        contentHash: "c".repeat(64),
      },
      evidenceBundleId: "evidence-large",
      score: 40,
      summary: long,
      adequate: [long, long],
      problems: [{ severity: "major", message: long, evidenceRefs: [`evidence://${long}`] }],
      missingEvidence: [long],
      recommendations: [long],
      criterionScores: [{ criterion: `criterion-${long}`, score: 40, rationale: long }],
      createdAt: "2026-07-18T12:00:00.000Z",
    })
    const bundle = await buildContextManifest({
      graph,
      task,
      runId: "run-feedback",
      attemptId: "attempt-large-revision",
      mode: "once",
      baseline,
      budget,
      revisionFeedback: { assessment, assessmentRef, threshold: 85 },
      limits: {
        maxTotalPayloadBytes: 32 * 1_024,
        maxAssessmentFeedbackBytes: 4 * 1_024,
        maxAssessmentFeedbackFieldBytes: 512,
      },
    })
    const resource = bundle.resources.find((candidate) => candidate.kind === "assessment")
    expect(resource?.truncated).toBeTrue()
    expect(resource?.includedBytes).toBeLessThanOrEqual(4 * 1_024)
    expect(() =>
      ContextAssessmentFeedbackSchema.parse(JSON.parse(resource?.content ?? "")),
    ).not.toThrow()
    expect(bundle.manifest.revisionFeedback?.truncated).toBeTrue()
    expect(bundle.truncations).toContainEqual(
      expect.objectContaining({ field: `assessment:${assessment.id}` }),
    )
    expect(contextManifestBundleHash(bundle)).toBe(bundle.manifest.contentHash)
  })

  test("re-reads and verifies the full current PRD only for Wiggum", async () => {
    const { graph, task } = await compiledFixture()
    const bundle = await buildContextManifest({
      graph,
      task,
      runId: "run-wiggum",
      attemptId: "attempt-wiggum",
      mode: "wiggum",
      baseline,
      budget,
      workspaceRoot: process.cwd(),
      createdAt: "2026-07-18T12:00:01.000Z",
    })
    const document = graph.documents[task.documentId]
    const resource = bundle.resources.find((candidate) => candidate.kind === "full-prd")
    if (!document || !resource) throw new Error("Expected a verified full-PRD resource")
    expect(resource.content).toContain("## Vertical slices")
    expect(resource.contentHash).toBe(document.contentHash)
    expect(bundle.manifest.fullPrd).toEqual({
      ref: resource.ref,
      contentHash: document.contentHash,
    })
    expect(bundle.canonicalJson).not.toContain(resolve(process.cwd()).replaceAll("\\", "/"))
  })

  test("fails closed if the PRD changes between compilation and Wiggum materialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-context-race-"))
    temporaryDirectories.push(directory)
    const file = join(directory, "PRD.md")
    await copyFile(FIXTURE, file)
    const { graph, task } = await compiledFixture(file, directory)
    const original = await readFile(file, "utf8")
    await writeFile(file, `${original}\nExternal edit after compilation.\n`, "utf8")

    let error: unknown
    try {
      await buildContextManifest({
        graph,
        task,
        runId: "run-race",
        attemptId: "attempt-race",
        mode: "wiggum",
        baseline,
        budget,
        workspaceRoot: directory,
      })
    } catch (caught) {
      error = caught
    }
    expect(caughtCode(error)).toBe("RALPH_CONTEXT_PRD_HASH_MISMATCH")
  })

  test("reports every bounded truncation explicitly and rejects machine paths", async () => {
    const { graph, task } = await compiledFixture()
    const bundle = await buildContextManifest({
      graph,
      task,
      runId: "run-truncated",
      attemptId: "attempt-truncated",
      mode: "once",
      baseline,
      budget,
      limits: {
        maxTotalPayloadBytes: 48,
        maxSharedContextBytes: 8,
        maxTaskFieldBytes: 8,
        maxVerificationBytes: 8,
      },
    })
    expect(bundle.truncations.length).toBeGreaterThan(0)
    expect(bundle.manifest.sharedContext).toContain("RALPH_CONTEXT_TRUNCATED")
    expect(bundle.resources[0]?.truncated).toBeTrue()
    expect(bundle.canonicalJson).toContain('"truncations"')
    expect(
      bundle.truncations.every((notice) => /^[a-f0-9]{64}$/.test(notice.originalHash)),
    ).toBeTrue()

    let absoluteError: unknown
    try {
      await buildContextManifest({
        graph,
        task,
        runId: "run-absolute",
        attemptId: "attempt-absolute",
        mode: "once",
        baseline,
        budget,
        declaredFileRefs: ["C:\\machine-specific\\secret.txt"],
      })
    } catch (caught) {
      absoluteError = caught
    }
    expect(caughtCode(absoluteError)).toBe("RALPH_CONTEXT_REF_ABSOLUTE")
  })

  test("rejects dependency outputs that were not declared by the selected task", async () => {
    const { graph, task } = await compiledFixture()
    let error: unknown
    try {
      await buildContextManifest({
        graph,
        task,
        runId: "run-dependency",
        attemptId: "attempt-dependency",
        mode: "once",
        baseline,
        budget,
        dependencyOutputs: [{ taskId: "not-a-dependency", outputRefs: ["artifact://result"] }],
      })
    } catch (caught) {
      error = caught
    }
    expect(caughtCode(error)).toBe("RALPH_CONTEXT_DEPENDENCY_OUTPUT_UNDECLARED")
  })
})
