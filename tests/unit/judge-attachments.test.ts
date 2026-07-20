import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  ContextTaskSchema,
  type EvidenceBundle,
  EvidenceBundleSchema,
  JudgeRubricSchema,
} from "@ralph-next/domain"
import { buildJudgeEvaluationBundle } from "@ralph-next/evaluation"
import { materializeJudgeTextAttachments } from "@ralph-next/orchestration"
import { type FrozenContent, persistContentAddressedBytes } from "@ralph-next/verification"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const NOW = "2026-07-18T12:00:00.000Z"
const RUN_ID = "run-judge-attachments"
const ATTEMPT_ID = "attempt-1"
const BEFORE_TEXT = "export const ready = false\n"
const AFTER_TEXT = "export const ready = true\n"
const ARTIFACT_TEXT = '{"ready":true}\n'
const GATE_TEXT = "1 test passed\n"
const temporaryDirectories: string[] = []

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function persist(
  root: string,
  directory: string,
  value: string | Uint8Array,
  suffix?: string,
): Promise<FrozenContent> {
  return persistContentAddressedBytes(
    root,
    { directory: resolve(root, ".ralph", "runs", RUN_ID, directory) },
    typeof value === "string" ? Buffer.from(value, "utf8") : value,
    suffix ? { suffix } : {},
  )
}

type Fixture = {
  evidence: EvidenceBundle
  refs: {
    artifact: FrozenContent
    before: FrozenContent
    after: FrozenContent
    cumulativeDiff: FrozenContent
    attemptDiff: FrozenContent
    gate: FrozenContent
  }
  expectedSourceBytes: number
}

async function fixture(root: string): Promise<Fixture> {
  const before = await persist(root, "artifacts", BEFORE_TEXT)
  const after = await persist(root, "artifacts", AFTER_TEXT)
  const artifact = await persist(root, "artifacts", ARTIFACT_TEXT)
  const gate = await persist(root, "raw/attempt-1/test", GATE_TEXT, ".stdout.log")
  const cumulativeManifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      mediaType: "application/vnd.ralph.workspace-diff+json",
      kind: "task",
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      files: [
        {
          path: "src/feature.ts",
          before: {
            kind: "file",
            sha256: before.contentHash,
            size: before.sizeBytes,
            retentionStatus: "retained",
            contentRef: before.ref,
          },
          after: {
            kind: "file",
            sha256: after.contentHash,
            size: after.sizeBytes,
            retentionStatus: "retained",
            contentRef: after.ref,
          },
        },
      ],
    },
    null,
    2,
  )}\n`
  const attemptManifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      mediaType: "application/vnd.ralph.workspace-diff+json",
      kind: "attempt",
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      files: [],
    },
    null,
    2,
  )}\n`
  const cumulativeDiff = await persist(root, "evidence/diffs", cumulativeManifest, ".json")
  const attemptDiff = await persist(root, "evidence/diffs", attemptManifest, ".json")
  const evidence = EvidenceBundleSchema.parse({
    schemaVersion: 1,
    id: "evidence-1",
    runId: RUN_ID,
    documentId: "prd-root",
    taskId: "task-1",
    attemptId: ATTEMPT_ID,
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
          kind: "modified",
          contentHash: after.contentHash,
          sizeBytes: after.sizeBytes,
        },
      ],
      outsideScopePaths: [],
      reproducible: true,
      missingContent: [],
      diffHash: cumulativeDiff.contentHash,
      diffRef: cumulativeDiff.ref,
      attemptDiffHash: attemptDiff.contentHash,
      attemptDiffRef: attemptDiff.ref,
    },
    artifacts: [
      {
        artifactId: "ready",
        path: "artifacts/ready.json",
        contentHash: artifact.contentHash,
        sizeBytes: artifact.sizeBytes,
        immutableRef: artifact.ref,
        status: "passed",
      },
    ],
    gates: [
      {
        gateId: "test",
        category: "test",
        blocking: true,
        status: "passed",
        durationMs: 10,
        outputRefs: [gate.ref],
      },
    ],
    contextManifestHash: HASH,
    createdAt: NOW,
    contentHash: HASH,
  })
  return {
    evidence,
    refs: { artifact, before, after, cumulativeDiff, attemptDiff, gate },
    expectedSourceBytes:
      before.sizeBytes +
      after.sizeBytes +
      artifact.sizeBytes +
      gate.sizeBytes +
      cumulativeDiff.sizeBytes +
      attemptDiff.sizeBytes,
  }
}

describe("judge attachment materialization", () => {
  test("reads all supported persisted text sources and produces builder-compatible inputs", async () => {
    const root = await temporaryDirectory()
    const value = await fixture(root)
    const materialized = await materializeJudgeTextAttachments({
      workspaceRoot: root,
      evidence: value.evidence,
    })

    expect(materialized.diagnostics).toEqual([])
    expect(materialized.sourceBytesRead).toBe(value.expectedSourceBytes)
    expect(materialized.attachments.map((attachment) => attachment.id)).toEqual([
      "00:diff:cumulative",
      "01:diff:attempt",
      "10:file:before:src/feature.ts",
      "11:file:after:src/feature.ts",
      "20:artifact:ready:artifacts/ready.json",
      "30:gate:test:1",
    ])
    expect(
      materialized.attachments.find((attachment) => attachment.kind === "before-file")?.text,
    ).toBe(BEFORE_TEXT)
    expect(
      materialized.attachments.find((attachment) => attachment.kind === "after-file")?.text,
    ).toBe(AFTER_TEXT)
    expect(
      materialized.attachments.find((attachment) => attachment.kind === "artifact")?.text,
    ).toBe(ARTIFACT_TEXT)
    expect(
      materialized.attachments.find((attachment) => attachment.kind === "gate-output")?.text,
    ).toBe(GATE_TEXT)

    const task = ContextTaskSchema.parse({
      documentId: "prd-root",
      taskId: "task-1",
      title: "Deliver one slice",
      result: "The slice works end to end.",
      criteria: [{ id: "criterion-1", text: "The behavior is observable.", weight: 100 }],
      boundaries: ["Do not change unrelated files."],
      evidenceMode: "criteria",
      verificationRefs: ["gate:test"],
      taskSpecHash: HASH,
    })
    const rubric = JudgeRubricSchema.parse({
      schemaVersion: 1,
      weightPolicy: "strict-100",
      criteria: [
        {
          criterion: "criterion-1",
          description: "Evaluate the observable behavior.",
          weight: 100,
        },
      ],
    })
    expect(
      buildJudgeEvaluationBundle({
        task,
        evidence: value.evidence,
        rubric,
        attachments: materialized.attachments,
      }).bundle.attachments,
    ).toHaveLength(6)
  })

  test("omits sources before reading when per-source or total budgets would be exceeded", async () => {
    const root = await temporaryDirectory()
    const value = await fixture(root)
    const oversized = await materializeJudgeTextAttachments({
      workspaceRoot: root,
      evidence: value.evidence,
      selection: { diffScopes: [], fileSides: [], artifactIds: [], gateIds: ["test"] },
      limits: { maxSourceBytes: value.refs.gate.sizeBytes - 1 },
    })
    expect(oversized.attachments).toEqual([])
    expect(oversized.sourceBytesRead).toBe(0)
    expect(oversized.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "attachment-source-too-large",
        attachmentId: "30:gate:test:1",
      }),
    )

    const totalLimited = await materializeJudgeTextAttachments({
      workspaceRoot: root,
      evidence: value.evidence,
      selection: { diffScopes: [], fileSides: [], gateIds: ["test"] },
      limits: {
        maxSourceBytes: 1_000,
        maxTotalSourceBytes: value.refs.artifact.sizeBytes,
      },
    })
    expect(totalLimited.attachments.map((attachment) => attachment.kind)).toEqual(["artifact"])
    expect(totalLimited.sourceBytesRead).toBe(value.refs.artifact.sizeBytes)
    expect(totalLimited.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "attachment-total-limit",
        attachmentId: "30:gate:test:1",
      }),
    )
  })

  test("does not follow a run-local symlink and reports the omitted gate source", async () => {
    const root = await temporaryDirectory()
    const value = await fixture(root)
    const outside = resolve(root, "outside-run")
    const payload = "must not be read\n"
    const hash = sha256(payload)
    await mkdir(resolve(outside, "sha256", hash.slice(0, 2)), { recursive: true })
    await writeFile(
      resolve(outside, "sha256", hash.slice(0, 2), `${hash}.stdout.log`),
      payload,
      "utf8",
    )
    const link = resolve(root, ".ralph", "runs", RUN_ID, "raw", "escape")
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
    const sourceRef = `.ralph/runs/${RUN_ID}/raw/escape/sha256/${hash.slice(0, 2)}/${hash}.stdout.log`
    const evidence = EvidenceBundleSchema.parse({
      ...value.evidence,
      gates: [{ ...value.evidence.gates[0], outputRefs: [sourceRef] }],
    })

    const materialized = await materializeJudgeTextAttachments({
      workspaceRoot: root,
      evidence,
      selection: { diffScopes: [], fileSides: [], artifactIds: [], gateIds: ["test"] },
    })
    expect(materialized.attachments).toEqual([])
    expect(materialized.sourceBytesRead).toBe(0)
    expect(materialized.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "attachment-ref-invalid",
        attachmentId: "30:gate:test:1",
        sourceRef,
      }),
    )
    expect(materialized.diagnostics[0]?.message).toContain("symbolic link")

    const pluginLikeEvidence = EvidenceBundleSchema.parse({
      ...value.evidence,
      gates: [{ ...value.evidence.gates[0], outputRefs: [value.refs.artifact.ref] }],
    })
    const pluginLike = await materializeJudgeTextAttachments({
      workspaceRoot: root,
      evidence: pluginLikeEvidence,
      selection: { diffScopes: [], fileSides: [], artifactIds: [], gateIds: ["test"] },
    })
    expect(pluginLike.attachments).toEqual([])
    expect(pluginLike.sourceBytesRead).toBe(0)
    expect(pluginLike.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "attachment-ref-invalid",
        attachmentId: "30:gate:test:1",
        sourceRef: value.refs.artifact.ref,
      }),
    )
  })

  test("reports immutable-object corruption without throwing or forwarding bytes", async () => {
    const root = await temporaryDirectory()
    const value = await fixture(root)
    await writeFile(resolve(root, value.refs.gate.ref), "corrupted but same-ish", "utf8")

    const materialized = await materializeJudgeTextAttachments({
      workspaceRoot: root,
      evidence: value.evidence,
      selection: { diffScopes: [], fileSides: [], artifactIds: [], gateIds: ["test"] },
    })
    expect(materialized.attachments).toEqual([])
    expect(materialized.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "attachment-source-integrity",
        attachmentId: "30:gate:test:1",
      }),
    )
  })
})
