import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { CompiledPrdGraphSchema, compilePrdGraph } from "@ralph-next/prd"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const FIXTURES = resolve(import.meta.dir, "../fixtures/prd")
const EXAMPLES = resolve(import.meta.dir, "../../examples")
const SCHEMAS = resolve(import.meta.dir, "../../schemas")
const GOLDENS = resolve(FIXTURES, "golden")
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

async function copyFixtureSet(directory: string, names: readonly string[]): Promise<string> {
  const root = await temporaryDirectory()
  await Promise.all(
    names.map((name) => copyFile(resolve(FIXTURES, directory, name), resolve(root, name))),
  )
  return root
}

function codes(result: { diagnostics: ReadonlyArray<{ code: string }> }): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("compiled PRD graph", () => {
  test("compiles the root and child examples recursively in strict mode with stable output", async () => {
    const root = await temporaryDirectory()
    await Promise.all([
      copyFile(resolve(EXAMPLES, "PRD-v2-exemplo.md"), resolve(root, "PRD-v2-exemplo.md")),
      copyFile(resolve(EXAMPLES, "subprd-v2-exemplo.md"), resolve(root, "subprd-v2-exemplo.md")),
    ])

    const first = await compilePrdGraph(resolve(root, "PRD-v2-exemplo.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    const second = await compilePrdGraph(resolve(root, "PRD-v2-exemplo.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })

    expect(first.ok).toBeTrue()
    expect(first.diagnostics).toEqual([])
    const graph = CompiledPrdGraphSchema.parse(first.graph)
    expect(graph.rootDocumentId).toBe("checkout-incremental")
    expect(Object.keys(graph.documents)).toEqual([
      "checkout-incremental",
      "checkout-cart-review-detail",
    ])
    const parentTaskHash = graph.documents["checkout-incremental"]?.tasks.find(
      (task) => task.id === "cart-review",
    )?.taskSpecHash
    expect(parentTaskHash).toMatch(/^[a-f0-9]{64}$/)
    if (!parentTaskHash) throw new Error("Expected parent task specification hash")
    expect(graph.childEdges).toEqual([
      {
        parentTask: {
          documentId: "checkout-incremental",
          taskId: "cart-review",
          taskSpecHash: parentTaskHash,
        },
        childDocument: "checkout-cart-review-detail",
      },
    ])
    expect(graph.topologicalOrder).toHaveLength(6)
    for (const reference of graph.topologicalOrder) {
      const task = graph.documents[reference.documentId]?.tasks.find(
        (candidate) => candidate.id === reference.taskId,
      )
      expect(task).toBeDefined()
      expect(reference.taskSpecHash).toBe(task?.taskSpecHash as string)
    }
    const childProof = graph.topologicalOrder.findIndex(
      (reference) =>
        reference.documentId === "checkout-cart-review-detail" &&
        reference.taskId === "cart-review-proof",
    )
    const parentReview = graph.topologicalOrder.findIndex(
      (reference) =>
        reference.documentId === "checkout-incremental" && reference.taskId === "cart-review",
    )
    expect(childProof).toBeGreaterThanOrEqual(0)
    expect(parentReview).toBeGreaterThan(childProof)
    const eligibleTaskHash = graph.documents["checkout-incremental"]?.tasks[0]?.taskSpecHash
    if (!eligibleTaskHash) throw new Error("Expected eligible task specification hash")
    expect(graph.eligibleTasks).toEqual([
      {
        documentId: "checkout-incremental",
        taskId: "cart-add",
        taskSpecHash: eligibleTaskHash,
      },
    ])
    expect(graph.definitionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(second.graph?.graphHash).toBe(graph.graphHash)
    expect(second.graph).toEqual(graph)

    const reference = (value: { documentId: string; taskId: string }): string =>
      `${value.documentId}/${value.taskId}`
    const summary = {
      rootDocumentId: graph.rootDocumentId,
      documents: Object.values(graph.documents).map((document) => ({
        id: document.id,
        tasks: document.tasks.map((task) => [task.id, task.status, task.evidenceMode]),
      })),
      dependencyEdges: graph.dependencyEdges.map(
        (edge) => `${reference(edge.task)}<-${reference(edge.dependsOn)}`,
      ),
      childEdges: graph.childEdges.map(
        (edge) => `${reference(edge.parentTask)}->${edge.childDocument}`,
      ),
      topologicalOrder: graph.topologicalOrder.map(reference),
      eligibleTasks: graph.eligibleTasks.map(reference),
      definitionHash: graph.definitionHash,
      graphHash: graph.graphHash,
    }
    expect(summary).toEqual(
      JSON.parse(await readFile(resolve(GOLDENS, "example-graph.summary.json"), "utf8")),
    )
  })

  test("separates stable plan identity from marker revisions and task specification changes", async () => {
    const root = await temporaryDirectory()
    const path = resolve(root, "root.md")
    const source = await readFile(resolve(FIXTURES, "v2/valid-en.md"), "utf8")
    await writeFile(path, source)

    const active = await compilePrdGraph(path, {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    expect(active.ok).toBeTrue()
    const activeGraph = CompiledPrdGraphSchema.parse(active.graph)
    const activeTask = activeGraph.documents[activeGraph.rootDocumentId]?.tasks[0]

    await writeFile(path, source.replace("- [~] **english-slice", "- [ ] **english-slice"))
    const pending = await compilePrdGraph(path, {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    expect(pending.ok).toBeTrue()
    const pendingGraph = CompiledPrdGraphSchema.parse(pending.graph)
    const pendingTask = pendingGraph.documents[pendingGraph.rootDocumentId]?.tasks[0]

    expect(pendingGraph.definitionHash).toBe(activeGraph.definitionHash)
    expect(pendingTask?.taskSpecHash).toBe(activeTask?.taskSpecHash)
    expect(pendingGraph.graphHash).not.toBe(activeGraph.graphHash)

    await writeFile(
      path,
      source
        .replace("Context with Unicode before the queue", "Changed shared context before the queue")
        .replace("- [~] **english-slice", "- [ ] **english-slice"),
    )
    const contextChanged = await compilePrdGraph(path, {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    expect(contextChanged.ok).toBeTrue()
    const contextGraph = CompiledPrdGraphSchema.parse(contextChanged.graph)
    const contextTask = contextGraph.documents[contextGraph.rootDocumentId]?.tasks[0]
    expect(contextGraph.definitionHash).not.toBe(pendingGraph.definitionHash)
    expect(contextTask?.taskSpecHash).toBe(pendingTask?.taskSpecHash)

    await writeFile(
      path,
      source
        .replace(
          "the user observes one complete increment",
          "the user observes a revised increment",
        )
        .replace("- [~] **english-slice", "- [ ] **english-slice"),
    )
    const taskChanged = await compilePrdGraph(path, {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })
    expect(taskChanged.ok).toBeTrue()
    const taskGraph = CompiledPrdGraphSchema.parse(taskChanged.graph)
    expect(taskGraph.definitionHash).not.toBe(pendingGraph.definitionHash)
    expect(taskGraph.documents[taskGraph.rootDocumentId]?.tasks[0]?.taskSpecHash).not.toBe(
      pendingTask?.taskSpecHash,
    )
  })

  test.each([
    ["v2/invalid/dependency-missing.md", "RALPH_PRD_DEPENDENCY_MISSING"],
    ["v2/invalid/dependency-cycle.md", "RALPH_PRD_DEPENDENCY_CYCLE"],
  ])("rejects invalid local dependency graphs from %s", async (fixturePath, expectedCode) => {
    const root = await temporaryDirectory()
    const target = resolve(root, "root.md")
    await writeFile(target, await readFile(resolve(FIXTURES, fixturePath)))

    const compiled = await compilePrdGraph(target, {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })

    expect(compiled.ok).toBeFalse()
    expect(compiled.graph).toBeUndefined()
    expect(codes(compiled)).toContain(expectedCode)
  })

  test("rejects a missing child before producing a graph", async () => {
    const root = await copyFixtureSet("graph/child-missing", ["root.md"])
    const compiled = await compilePrdGraph(resolve(root, "root.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })

    expect(compiled.ok).toBeFalse()
    expect(compiled.graph).toBeUndefined()
    expect(codes(compiled)).toContain("RALPH_PRD_CHILD_MISSING")
  })

  test("rejects a child whose declared parent resolves to another file", async () => {
    const root = await copyFixtureSet("graph/parent-mismatch", ["root.md", "child.md", "other.md"])
    const compiled = await compilePrdGraph(resolve(root, "root.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })

    expect(compiled.ok).toBeFalse()
    expect(compiled.graph).toBeUndefined()
    expect(codes(compiled)).toContain("RALPH_PRD_CHILD_PARENT_MISMATCH")
  })

  test("rejects a canonical child path cycle", async () => {
    const root = await copyFixtureSet("graph/child-cycle", ["root.md", "child.md"])
    const compiled = await compilePrdGraph(resolve(root, "root.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })

    expect(compiled.ok).toBeFalse()
    expect(compiled.graph).toBeUndefined()
    expect(codes(compiled)).toContain("RALPH_PRD_CHILD_CYCLE")
  })

  test("rejects a completed parent with an incomplete child before releasing its dependent", async () => {
    const root = await copyFixtureSet("graph/parent-completed-child-incomplete", [
      "root.md",
      "child.md",
    ])
    const compiled = await compilePrdGraph(resolve(root, "root.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
    })

    expect(compiled.ok).toBeFalse()
    expect(compiled.graph).toBeUndefined()
    expect(codes(compiled)).toContain("RALPH_PRD_PARENT_COMPLETED_CHILD_INCOMPLETE")
    expect(compiled.graph?.eligibleTasks ?? []).not.toContainEqual({
      documentId: "completed-parent-root",
      taskId: "dependent-slice",
    })
  })

  test("enforces the configured recursive child depth", async () => {
    const root = await copyFixtureSet("graph/max-depth", [
      "root.md",
      "child-one.md",
      "child-two.md",
    ])
    const compiled = await compilePrdGraph(resolve(root, "root.md"), {
      workspaceRoot: root,
      recursive: true,
      strict: true,
      maxDepth: 1,
    })

    expect(compiled.ok).toBeFalse()
    expect(compiled.graph).toBeUndefined()
    expect(codes(compiled)).toContain("RALPH_PRD_CHILD_MAX_DEPTH")
  })

  test("keeps the generated compiled graph JSON Schema closed and versioned", async () => {
    const schema = JSON.parse(
      await readFile(resolve(SCHEMAS, "compiled-prd-graph.schema.json"), "utf8"),
    ) as {
      $schema: string
      $id: string
      additionalProperties: boolean
      required: string[]
      properties: Record<string, unknown>
    }

    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://rodrigojager.github.io/ralph-v2/schemas/v2/compiled-prd-graph.schema.json",
      additionalProperties: false,
    })
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "rootDocumentId",
        "rootFile",
        "documents",
        "canonicalReferences",
        "dependencyEdges",
        "childEdges",
        "topologicalOrder",
        "eligibleTasks",
        "parallelGroups",
        "diagnostics",
        "definitionHash",
        "graphHash",
      ]),
    )
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(schema.required))
  })
})
