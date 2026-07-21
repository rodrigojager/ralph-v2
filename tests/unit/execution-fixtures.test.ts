import { afterEach, describe, expect, test } from "bun:test"
import { cp, readdir } from "node:fs/promises"
import { resolve } from "node:path"
import { CompiledPrdGraphSchema, compilePrdGraph } from "@ralph/prd"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const FIXTURES = resolve(import.meta.dir, "../fixtures/execution")
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("S03 executable PRD fixtures", () => {
  test("copies and compiles every root fixture recursively in strict mode without executing it", async () => {
    const entries = await readdir(FIXTURES, { withFileTypes: true })
    const fixtureNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    expect(fixtureNames).toEqual([
      "adversarial-task-complete",
      "blocking-gate-failure",
      "deadline",
      "no-change-change-only",
      "s07-resume-matrix",
      "single-pass",
      "task-options",
      "two-task-order",
      "wiggum",
    ])

    for (const fixtureName of fixtureNames) {
      const temporaryRoot = await temporaryDirectory()
      const workspaceRoot = resolve(temporaryRoot, fixtureName)
      await cp(resolve(FIXTURES, fixtureName), workspaceRoot, { recursive: true })

      const compiled = await compilePrdGraph(resolve(workspaceRoot, "PRD.md"), {
        workspaceRoot,
        recursive: true,
        strict: true,
      })

      expect(compiled.ok, `${fixtureName}: ${JSON.stringify(compiled.diagnostics)}`).toBeTrue()
      expect(compiled.diagnostics, fixtureName).toEqual([])
      const graph = CompiledPrdGraphSchema.parse(compiled.graph)
      const root = graph.documents[graph.rootDocumentId]

      expect(root, fixtureName).toBeDefined()
      expect(root?.kind, fixtureName).toBe("root")
      expect(Object.keys(graph.documents), fixtureName).toEqual([graph.rootDocumentId])
      expect(graph.childEdges, fixtureName).toEqual([])
      expect(graph.topologicalOrder, fixtureName).toHaveLength(root?.tasks.length ?? 0)

      for (const task of root?.tasks ?? []) {
        expect(task.subPrd, `${fixtureName}/${task.id}`).toBeUndefined()
        expect(task.verification.length, `${fixtureName}/${task.id}`).toBeGreaterThan(0)
        for (const verification of task.verification) {
          expect(
            ["command", "artifact", "file"].includes(verification.type),
            `${fixtureName}/${task.id}`,
          ).toBeTrue()
          expect(verification.category, `${fixtureName}/${task.id}`).toBeDefined()
          expect(verification.skipPolicy, `${fixtureName}/${task.id}`).toBe("required")
          expect(verification.blocking, `${fixtureName}/${task.id}`).toBeTrue()
          if (verification.type === "command") {
            expect(verification.command.shell, `${fixtureName}/${task.id}`).toBeFalse()
            expect(verification.command.timeoutMs, `${fixtureName}/${task.id}`).toBeGreaterThan(0)
            expect(
              verification.command.outputLimitBytes,
              `${fixtureName}/${task.id}`,
            ).toBeGreaterThan(0)
          }
        }
      }
    }
  })
})
