import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import {
  ContextTaskSchema,
  type EvaluationProfileSnapshot,
  EvidenceBundleSchema,
  type JudgeOutput,
  JudgeRubricSchema,
} from "@ralph/domain"
import {
  buildJudgeEvaluationBundle,
  buildJudgePrompt,
  createJudgeEvaluator,
  evaluationKind,
  type JudgeBackend,
  type JudgeBundleLimits,
  type JudgeCallHandle,
  type JudgeEventSink,
  type JudgeRequest,
  type JudgeTextAttachmentInput,
  JudgeTextAttachmentSchema,
} from "@ralph/evaluation"

const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const NOW = "2026-07-18T12:00:00.000Z"
const DIFF_TEXT = "diff --git a/src/feature.ts b/src/feature.ts\n+export const ready = true\n"
const ATTEMPT_DIFF_TEXT = "@@ -1 +1 @@\n-false\n+true\n"
const BEFORE_TEXT = "export const ready = false\n"
const AFTER_TEXT = "export const ready = true\n"
const ARTIFACT_TEXT = '{"ready":true}\n'
const GATE_TEXT = "1 test passed\n"

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

type BuildOptions = {
  result?: string
  maxStringBytes?: number
  limits?: Partial<JudgeBundleLimits>
  attachments?: readonly JudgeTextAttachmentInput[]
  changedFileKind?: "created" | "modified" | "deleted" | "renamed"
}

function build(overrides?: BuildOptions) {
  const changedFileKind = overrides?.changedFileKind ?? "modified"
  const task = ContextTaskSchema.parse({
    documentId: "prd-root",
    taskId: "task-1",
    title: "Deliver one vertical slice",
    result: overrides?.result ?? "The feature is observable end to end.",
    criteria: [{ id: "criterion-1", text: "The observable behavior works.", weight: 100 }],
    boundaries: ["Do not change unrelated modules."],
    evidenceMode: "criteria",
    verificationRefs: ["gate:test"],
    taskSpecHash: HASH,
  })
  const evidence = EvidenceBundleSchema.parse({
    schemaVersion: 1,
    id: "evidence-1",
    runId: "run-1",
    documentId: "prd-root",
    taskId: "task-1",
    attemptId: "attempt-1",
    taskSpecHash: HASH,
    baseline: {
      schemaVersion: 1,
      kind: "git",
      revision: "abc123",
      branch: "main",
      dirty: false,
      statusHash: HASH,
      workspaceSnapshotHash: HASH,
      capturedAt: NOW,
    },
    changes: {
      schemaVersion: 1,
      policy: "require-change",
      status: "changed",
      files: [
        {
          path: "src/feature.ts",
          kind: changedFileKind,
          ...(changedFileKind === "renamed" ? { previousPath: "src/old-feature.ts" } : {}),
          ...(changedFileKind === "deleted" ? {} : { contentHash: sha256(AFTER_TEXT) }),
          sizeBytes: 42,
        },
      ],
      outsideScopePaths: [],
      reproducible: true,
      missingContent: [],
      diffHash: sha256(DIFF_TEXT),
      diffRef: "evidence:diff",
      attemptDiffHash: sha256(ATTEMPT_DIFF_TEXT),
      attemptDiffRef: "evidence:attempt-diff",
    },
    artifacts: [
      {
        artifactId: "artifact-ready",
        path: "artifacts/ready.json",
        contentHash: sha256(ARTIFACT_TEXT),
        sizeBytes: ARTIFACT_TEXT.length,
        immutableRef: "evidence:artifact-ready",
        status: "passed",
      },
    ],
    gates: [
      {
        gateId: "test",
        category: "test",
        blocking: true,
        status: "passed",
        durationMs: 12,
        outputRefs: ["evidence:gate-test", "evidence:gate-extra"],
      },
    ],
    contextManifestHash: HASH,
    createdAt: NOW,
    contentHash: HASH,
  })
  const rubric = JudgeRubricSchema.parse({
    schemaVersion: 1,
    weightPolicy: "strict-100",
    criteria: [
      {
        criterion: "criterion-1",
        description: "Evaluate the declared observable behavior using supplied evidence.",
        weight: 100,
      },
    ],
  })
  return buildJudgeEvaluationBundle({
    task,
    evidence,
    rubric,
    ...(overrides?.attachments ? { attachments: overrides.attachments } : {}),
    ...(overrides?.maxStringBytes || overrides?.limits
      ? {
          limits: {
            ...overrides.limits,
            ...(overrides.maxStringBytes ? { maxStringBytes: overrides.maxStringBytes } : {}),
          },
        }
      : {}),
  })
}

function attachmentFixtures(): JudgeTextAttachmentInput[] {
  return [
    {
      id: "05-gate",
      kind: "gate-output",
      gateId: "test",
      sourceRef: "evidence:gate-test",
      contentHash: sha256(GATE_TEXT),
      text: GATE_TEXT,
    },
    {
      id: "02-before",
      kind: "before-file",
      path: "src/feature.ts",
      sourceRef: "evidence:file-before",
      contentHash: sha256(BEFORE_TEXT),
      text: BEFORE_TEXT,
    },
    {
      id: "04-artifact",
      kind: "artifact",
      artifactId: "artifact-ready",
      path: "artifacts/ready.json",
      sourceRef: "evidence:artifact-ready",
      contentHash: sha256(ARTIFACT_TEXT),
      text: ARTIFACT_TEXT,
    },
    {
      id: "01-diff",
      kind: "diff",
      scope: "cumulative",
      sourceRef: "evidence:diff",
      contentHash: sha256(DIFF_TEXT),
      text: DIFF_TEXT,
    },
    {
      id: "03-after",
      kind: "after-file",
      path: "src/feature.ts",
      sourceRef: "evidence:file-after",
      contentHash: sha256(AFTER_TEXT),
      text: AFTER_TEXT,
    },
    {
      id: "01b-attempt-diff",
      kind: "diff",
      scope: "attempt",
      sourceRef: "evidence:attempt-diff",
      contentHash: sha256(ATTEMPT_DIFF_TEXT),
      text: ATTEMPT_DIFF_TEXT,
    },
  ]
}

const OUTPUT: JudgeOutput = {
  schemaVersion: 1,
  score: 88,
  summary: "The supplied evidence supports the criterion.",
  adequate: ["The blocking test passed."],
  problems: [],
  missingEvidence: [],
  recommendations: [],
  criterionScores: [{ criterion: "criterion-1", score: 88 }],
  confidence: 0.9,
}

class CapturingBackend implements JudgeBackend {
  readonly id = "capturing-judge"
  readonly requests: JudgeRequest[] = []
  rawResponseRef?: string

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

  async start(request: JudgeRequest, _sink: JudgeEventSink): Promise<JudgeCallHandle> {
    this.requests.push(request)
    return {
      id: request.callId,
      outcome: Promise.resolve(OUTPUT),
      ...(this.rawResponseRef ? { rawResponseRef: Promise.resolve(this.rawResponseRef) } : {}),
    }
  }

  async cancel(): Promise<void> {}
}

function profile(role: "executor" | "judge"): EvaluationProfileSnapshot {
  return {
    id: `${role}-profile`,
    role,
    backend: "fake",
    provider: "fake",
    model: "fake-model",
    contentHash: HASH,
  }
}

describe("bounded shared judge evaluation", () => {
  test("builds an identity-bound canonical bundle and reports deterministic truncation", () => {
    const value = build({ result: "x".repeat(100), maxStringBytes: 24 })
    expect(value.byteLength).toBeGreaterThan(0)
    expect(value.bundle.task.result.length).toBe(24)
    expect(value.bundle.truncations).toContainEqual(
      expect.objectContaining({ field: "task.result", reason: "field-limit" }),
    )
    expect(JSON.parse(value.canonicalJson)).toEqual(value.bundle)
  })

  test("projects every supported Ralph-provided attachment with evidence-bound identities", () => {
    const value = build({ attachments: attachmentFixtures() })
    expect(value.bundle.attachments.map((attachment) => attachment.id)).toEqual([
      "01-diff",
      "01b-attempt-diff",
      "02-before",
      "03-after",
      "04-artifact",
      "05-gate",
    ])
    for (const attachment of value.bundle.attachments) {
      expect(attachment.evidenceBundleId).toBe(value.bundle.evidence.id)
      expect(attachment.evidenceContentHash).toBe(value.bundle.evidence.contentHash)
      expect(attachment.attemptId).toBe(value.bundle.evidence.attemptId)
      expect(attachment.includedContentHash).toBe(sha256(attachment.text))
      expect(attachment.truncated).toBe(false)
    }
    expect(JSON.parse(value.canonicalJson).attachments).toEqual(value.bundle.attachments)
    expect(buildJudgePrompt(value).system).toContain("immutable hash-bound excerpts")

    const first = value.bundle.attachments[0]
    if (!first) throw new Error("Expected an attachment fixture")
    expect(() =>
      JudgeTextAttachmentSchema.parse({ ...first, identityHash: "f".repeat(64) }),
    ).toThrow("Judge attachment identity hash is invalid")
  })

  test("applies deterministic per-item and combined attachment byte limits", () => {
    const firstText = "abcdefghij"
    const secondText = "ABCDEFGHIJ"
    const value = build({
      attachments: [
        {
          id: "b-output",
          kind: "gate-output",
          gateId: "test",
          sourceRef: "evidence:gate-extra",
          contentHash: sha256(secondText),
          text: secondText,
        },
        {
          id: "a-output",
          kind: "gate-output",
          gateId: "test",
          sourceRef: "evidence:gate-test",
          contentHash: sha256(firstText),
          text: firstText,
        },
      ],
      limits: {
        maxAttachmentBytes: 8,
        maxAttachmentTotalBytes: 10,
        maxTotalBytes: 100_000,
      },
    })
    expect(value.bundle.attachments.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "a-output", text: "abcdefgh" },
      { id: "b-output", text: "AB" },
    ])
    expect(value.bundle.truncations).toContainEqual({
      field: "attachments.a-output.text",
      reason: "field-limit",
      originalBytes: 10,
      includedBytes: 8,
    })
    expect(value.bundle.truncations).toContainEqual({
      field: "attachments.b-output.text",
      reason: "total-limit",
      originalBytes: 10,
      includedBytes: 2,
    })
    expect(value.bundle.attachments[1]?.includedContentHash).toBe(sha256("AB"))
    expect(value.bundle.attachments[1]?.contentHash).toBe(sha256(secondText))
    expect(value.bundle.attachments.every((attachment) => attachment.truncated)).toBe(true)
  })

  test("rejects invalid attachment hashes, references and file sides deterministically", () => {
    const diff = attachmentFixtures().find((attachment) => attachment.id === "01-diff")
    const before = attachmentFixtures().find((attachment) => attachment.kind === "before-file")
    const after = attachmentFixtures().find((attachment) => attachment.kind === "after-file")
    if (!diff || !before || !after) throw new Error("Expected attachment fixtures")

    expect(() => build({ attachments: [{ ...diff, contentHash: HASH }] })).toThrow(
      "Judge attachment 01-diff content hash mismatch",
    )
    expect(() => build({ attachments: [{ ...diff, sourceRef: "evidence:wrong" }] })).toThrow(
      "Judge attachment 01-diff source ref mismatch",
    )
    expect(() => build({ attachments: [before], changedFileKind: "created" })).toThrow(
      "Judge attachment 02-before has an invalid before-file side",
    )
    expect(() => build({ attachments: [after], changedFileKind: "deleted" })).toThrow(
      "Judge attachment 03-after has an invalid after-file side",
    )
  })

  test("uses the same neutral read-only prompt for self and external evaluation", async () => {
    const backend = new CapturingBackend()
    const value = build()
    const sink: JudgeEventSink = { emit() {} }
    const external = createJudgeEvaluator({
      backend,
      profileSnapshot: profile("judge"),
      now: () => NOW,
      idFactory: () => "assessment-external",
    })
    const self = createJudgeEvaluator({
      backend,
      profileSnapshot: profile("executor"),
      now: () => NOW,
      idFactory: () => "assessment-self",
    })
    const externalAssessment = await external.evaluate(
      { callId: "judge-external", kind: "external", build: value },
      sink,
    )
    const selfAssessment = await self.evaluate(
      { callId: "judge-self", kind: "self", build: value },
      sink,
    )
    expect(externalAssessment.kind).toBe("external")
    expect(selfAssessment.kind).toBe("self")
    expect(backend.requests[0]?.prompt).toEqual(backend.requests[1]?.prompt)
    expect(backend.requests[0]?.prompt.system).toContain("read-only")
    expect(backend.requests[0]?.prompt.system).toContain("Do not use tools")
    expect(backend.requests[0]).not.toHaveProperty("workspaceRoot")
  })

  test("keeps deterministic-only and manual modes outside model evaluation", () => {
    expect(evaluationKind("deterministic-only")).toBeUndefined()
    expect(evaluationKind("manual")).toBeUndefined()
    expect(evaluationKind("external")).toBe("external")
    expect(evaluationKind("self")).toBe("self")
  })

  test("bounds the final prompt as well as individual fields", () => {
    const value = build()
    expect(() => buildJudgePrompt(value, 32)).toThrow("prompt")
  })

  test("adds a real bounded repair instruction without exceeding the prompt budget", async () => {
    const backend = new CapturingBackend()
    const value = build()
    const base = buildJudgePrompt(value)
    const baseBytes =
      new TextEncoder().encode(base.system).byteLength +
      new TextEncoder().encode(base.user).byteLength
    const maxPromptBytes = baseBytes + 256
    const evaluator = createJudgeEvaluator({
      backend,
      profileSnapshot: profile("judge"),
      now: () => NOW,
      idFactory: () => "assessment-repair",
      maxPromptBytes,
    })
    await evaluator.evaluate(
      {
        callId: "judge-repair",
        kind: "external",
        build: value,
        repairInstruction: `Previous response failed validation: summary is required. ${"á".repeat(16_384)} END-OF-UNBOUNDED-ERROR`,
      },
      { emit() {} },
    )

    const repaired = backend.requests[0]?.prompt
    if (!repaired) throw new Error("Expected the repaired judge request")
    const repairedBytes =
      new TextEncoder().encode(repaired.system).byteLength +
      new TextEncoder().encode(repaired.user).byteLength
    expect(repaired).not.toEqual(base)
    expect(repaired.user).toContain("Retry repair instruction (bounded)")
    expect(repaired.user).toContain("Previous response failed validation")
    expect(repaired.user).toContain("return one fresh, complete JudgeOutput v1 JSON object")
    expect(repaired.user).not.toContain("END-OF-UNBOUNDED-ERROR")
    expect(repairedBytes).toBeLessThanOrEqual(maxPromptBytes)
  })

  test("copies an optional backend raw response reference into the assessment", async () => {
    const backend = new CapturingBackend()
    backend.rawResponseRef = "raw://sha256/backend-response"
    const evaluator = createJudgeEvaluator({
      backend,
      profileSnapshot: profile("judge"),
      now: () => NOW,
      idFactory: () => "assessment-with-raw-ref",
    })
    const assessment = await evaluator.evaluate(
      { callId: "judge-with-raw-ref", kind: "external", build: build() },
      { emit() {} },
    )
    expect(assessment.rawResponseRef).toBe("raw://sha256/backend-response")
  })
})
