import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { cp, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { executeRun, resolveEffectiveRunOptions } from "@ralph/orchestration"
import {
  getEvidenceBundle,
  initializeWorkspace,
  listAttempts,
  workspaceLayout,
} from "@ralph/persistence"
import { compilePrdGraph } from "@ralph/prd"
import { type ScriptedExecution, ScriptedExecutionBackend } from "@ralph/test-kit"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

setDefaultTimeout(20_000)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("S03 Wiggum intermediate gate stability", () => {
  test("retains a first-run gate mutation as blocking evidence when the final gate passes", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    await cp(resolve("tests", "fixtures", "execution", "wiggum"), root, { recursive: true })
    await initializeWorkspace(root, "0.1.0-test")

    const prdFile = resolve(root, "PRD.md")
    const original = await readFile(prdFile, "utf8")
    const readOnlyGate =
      "import { readFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'converged') process.exit(1)"
    const writeOnceThenValidate =
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs'; const target = 'product/capability.txt'; if (readFileSync(target, 'utf8').trim() === 'pending') { writeFileSync(target, 'converged'); process.exit(1) } if (!existsSync(target) || readFileSync(target, 'utf8') !== 'converged') process.exit(1)"
    const adversarial = original.replace(readOnlyGate, writeOnceThenValidate)
    expect(adversarial).not.toBe(original)
    await writeFile(prdFile, adversarial)

    const compiled = await compilePrdGraph(prdFile, {
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

    const steps = JSON.parse(
      await readFile(resolve(root, "backend-converges.json"), "utf8"),
    ) as ScriptedExecution[]
    const backend = new ScriptedExecutionBackend(steps)
    const cli = {
      mode: "wiggum" as const,
      maxIterations: 2,
      maxModelCallsPerAttempt: 2,
      noChangePolicy: "allow-no-change",
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
        sleep: async () => undefined,
      },
    })

    expect(result).toMatchObject({ kind: "executed", status: "failed", exitCode: 4 })
    expect(backend.requests()).toHaveLength(1)
    expect(backend.remaining()).toBe(1)
    expect(await readFile(resolve(root, "product", "capability.txt"), "utf8")).toBe("converged")
    expect(await readFile(prdFile, "utf8")).toContain("- [~] **converge-capability")

    const layout = workspaceLayout(root)
    const attempt = listAttempts(layout.ledger, { runId: result.runId as string })[0]
    const evidence = attempt ? getEvidenceBundle(layout.ledger, attempt.id)?.bundle : undefined
    if (!evidence) throw new Error("Adversarial Wiggum run has no evidence")

    expect(
      evidence.gates.some(
        (gate) =>
          gate.gateId !== "ralph.workspace-stability.wiggum-intermediate" &&
          gate.category === "test" &&
          gate.status === "passed",
      ),
    ).toBeTrue()
    const stability = evidence.gates.find(
      (gate) => gate.gateId === "ralph.workspace-stability.wiggum-intermediate",
    )
    expect(stability).toMatchObject({
      category: "security",
      blocking: true,
      status: "failed",
    })
    expect(stability?.reason).toContain("call 1 (product/capability.txt)")
    expect(stability?.outputRefs).toHaveLength(1)

    const diffRef = stability?.outputRefs[0]
    if (!diffRef) throw new Error("Intermediate mutation has no immutable diff reference")
    const diff = JSON.parse(await readFile(resolve(root, diffRef), "utf8")) as {
      kind: string
      modified: string[]
      reproducible: boolean
    }
    expect(diff).toMatchObject({
      kind: "gate",
      modified: ["product/capability.txt"],
      reproducible: true,
    })
  })
})
