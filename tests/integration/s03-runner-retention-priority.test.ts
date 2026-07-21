import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { executeRun, resolveEffectiveRunOptions } from "@ralph/orchestration"
import {
  getEvidenceBundle,
  initializeWorkspace,
  listAttempts,
  workspaceLayout,
} from "@ralph/persistence"
import { compilePrdGraph } from "@ralph/prd"
import { ScriptedExecutionBackend } from "@ralph/test-kit"
import { readVerifiedContentReference } from "@ralph/verification"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []
const DEFAULT_TOTAL_RETENTION_BYTES = 16_777_216
const FILLER_SIZE_BYTES = 524_288
const FILLER_COUNT = DEFAULT_TOTAL_RETENTION_BYTES / FILLER_SIZE_BYTES
const PROOF_SIZE_BYTES = 1_048_576
const PROOF_PATH = "product/declared-proof.bin"

type DiffManifest = {
  kind: "task" | "attempt" | "gate"
  reproducible: boolean
  missingContent: unknown[]
  files: Array<{
    path: string
    before: { sha256: string; size: number; contentRef?: string } | null
    after: { sha256: string; size: number; contentRef?: string } | null
  }>
}

setDefaultTimeout(120_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("S03 runner retention priorities", () => {
  test("preserves both diff sides and the artifact snapshot after non-priority files exhaust 16 MiB", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    await Promise.all([
      mkdir(resolve(root, "pressure"), { recursive: true }),
      mkdir(resolve(root, "product"), { recursive: true }),
    ])

    const prd = `---
ralph_prd: 2
id: retention-priority
title: Retention priority integration
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: criteria+artifact
---

# Retention priority integration

## Vertical slices

- [ ] **retain-declared-proof — Preserve a declared proof under retention pressure**
  - Resultado: \`product/declared-proof.bin\` is updated and retained as reproducible evidence.
  - Dependências: nenhuma
  - Critérios:
    1. The declared proof remains non-empty and is frozen as the final artifact.
  - Verificação:
    - file: \`product/declared-proof.bin\`; non-empty
    - artifact: declared-proof; path=product/declared-proof.bin
  - Limites:
    - Unrelated pressure files must not consume the declared proof's retention reservation.
  - Modo de evidência: criteria+artifact
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=90s
`
    await writeFile(resolve(root, "PRD.md"), prd)
    const filler = "f".repeat(FILLER_SIZE_BYTES)
    await Promise.all(
      Array.from({ length: FILLER_COUNT }, (_, index) =>
        writeFile(resolve(root, "pressure", `${index.toString().padStart(2, "0")}.bin`), filler),
      ),
    )
    const beforeProof = "a".repeat(PROOF_SIZE_BYTES)
    const afterProof = "b".repeat(PROOF_SIZE_BYTES)
    await writeFile(resolve(root, PROOF_PATH), beforeProof)
    await initializeWorkspace(root, "0.1.0-test")

    const compiled = await compilePrdGraph(resolve(root, "PRD.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    expect(compiled.ok).toBeTrue()
    const graph = compiled.graph
    const reference = graph?.topologicalOrder[0]
    const document = reference ? graph?.documents[reference.documentId] : undefined
    const task = document?.tasks.find((candidate) => candidate.id === reference?.taskId)
    if (!graph || !reference || !document || !task) throw new Error("Fixture did not compile")

    const backend = new ScriptedExecutionBackend([
      {
        expectedTask: "retention-priority/retain-declared-proof",
        actions: [{ type: "write", path: PROOF_PATH, content: afterProof }],
        outcome: { summary: "The declared proof was updated under retention pressure." },
      },
    ])
    const cli = {
      mode: "once" as const,
      noChangePolicy: "require-change",
      failFast: true,
    }
    const options = resolveEffectiveRunOptions({
      document,
      task,
      cli,
    }).options
    const result = await executeRun({
      workspaceRoot: root,
      prdFile: "PRD.md",
      effectiveOptions: options,
      optionResolution: { cli },
      dependencies: {
        resolveBackend: (profile) => (profile === "fixture-executor" ? backend : undefined),
      },
    })

    expect(result).toMatchObject({ kind: "executed", status: "completed", exitCode: 0 })
    expect(backend.remaining()).toBe(0)
    expect(await readFile(resolve(root, "PRD.md"), "utf8")).toContain(
      "- [x] **retain-declared-proof",
    )

    const layout = workspaceLayout(root)
    const attempt = listAttempts(layout.ledger, { runId: result.runId as string })[0]
    const evidence = attempt ? getEvidenceBundle(layout.ledger, attempt.id)?.bundle : undefined
    if (!evidence) throw new Error("Completed retention run has no evidence")
    expect(evidence.changes).toMatchObject({ reproducible: true, missingContent: [] })

    const taskDiffRef = evidence.changes.diffRef
    const attemptDiffRef = evidence.changes.attemptDiffRef
    if (!taskDiffRef || !attemptDiffRef) throw new Error("Evidence has no task/attempt diff refs")
    const taskDiff = JSON.parse(await readFile(resolve(root, taskDiffRef), "utf8")) as DiffManifest
    const attemptDiff = JSON.parse(
      await readFile(resolve(root, attemptDiffRef), "utf8"),
    ) as DiffManifest
    expect(taskDiff).toMatchObject({ kind: "task", reproducible: true, missingContent: [] })
    expect(attemptDiff).toMatchObject({ kind: "attempt", reproducible: true, missingContent: [] })

    const taskProof = taskDiff.files.find((file) => file.path === PROOF_PATH)
    const attemptProof = attemptDiff.files.find((file) => file.path === PROOF_PATH)
    for (const proof of [taskProof, attemptProof]) {
      expect(proof?.before).toMatchObject({ size: PROOF_SIZE_BYTES })
      expect(proof?.after).toMatchObject({ size: PROOF_SIZE_BYTES })
      expect(proof?.before?.contentRef).toBeString()
      expect(proof?.after?.contentRef).toBeString()
      expect(proof?.before?.sha256).not.toBe(proof?.after?.sha256)
    }

    const artifact = evidence.artifacts.find((item) => item.artifactId === "declared-proof")
    expect(artifact).toMatchObject({
      path: PROOF_PATH,
      status: "passed",
      sizeBytes: PROOF_SIZE_BYTES,
    })
    expect(artifact?.immutableRef).toBeString()
    if (!artifact?.immutableRef) throw new Error("Declared artifact has no immutable ref")
    expect(taskProof?.after?.contentRef).toBe(artifact.immutableRef)
    expect(attemptProof?.after?.contentRef).toBe(artifact.immutableRef)
    expect(
      Buffer.from(
        await readVerifiedContentReference(
          root,
          artifact.immutableRef,
          artifact.contentHash,
          artifact.sizeBytes,
        ),
      ).toString("utf8"),
    ).toBe(afterProof)
  })
})
