import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, mkdir, readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { CompiledPrdGraphSchema, compilePrdGraph } from "@ralph-next/prd"
import { parse as parseYaml } from "yaml"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const ROOT = resolve(import.meta.dir, "../..")
const SKILL_ROOT = resolve(ROOT, "skills", "ralph-loop-prd-generator")
const SAMPLE_ROOT = resolve(ROOT, "examples", "vertical-notes")
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown)
  if (!match?.[1]) throw new Error("Expected YAML frontmatter")
  const parsed: unknown = parseYaml(match[1])
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected object YAML frontmatter")
  }
  return parsed as Record<string, unknown>
}

describe("ralph-loop-prd-generator package", () => {
  test("keeps trigger metadata minimal and every progressive-disclosure resource resolvable", async () => {
    const markdown = await readFile(resolve(SKILL_ROOT, "SKILL.md"), "utf8")
    const metadata = frontmatter(markdown)
    expect(Object.keys(metadata).sort()).toEqual(["description", "name"])
    expect(metadata.name).toBe("ralph-loop-prd-generator")
    expect(metadata.description).toContain("vertical slices")
    expect(metadata.description).toContain("pre-authored Sub-PRDs")
    expect(metadata.description).toContain("preserving the project's chosen stack")

    const targets = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => match[1])
    expect(targets.length).toBeGreaterThanOrEqual(6)
    for (const target of targets) {
      if (!target) throw new Error("Expected a non-empty skill resource link")
      const absolute = resolve(SKILL_ROOT, target)
      expect(relative(SKILL_ROOT, absolute)).not.toStartWith("..")
      expect(await Bun.file(absolute).exists(), target).toBeTrue()
    }

    const interfaceMetadata = parseYaml(
      await readFile(resolve(SKILL_ROOT, "agents", "openai.yaml"), "utf8"),
    ) as { interface?: Record<string, unknown> }
    expect(interfaceMetadata.interface).toMatchObject({
      display_name: "Ralph Vertical PRD Generator",
      short_description: "Gera PRDs Ralph v2 em slices verticais",
    })
    expect(interfaceMetadata.interface?.default_prompt).toContain("$ralph-loop-prd-generator")
  })

  test("compiles the paired root and child assets through the official strict graph compiler", async () => {
    const workspace = await createTestDirectory()
    temporaryDirectories.push(workspace)
    await mkdir(resolve(workspace, "plans"), { recursive: true })
    await Promise.all([
      copyFile(resolve(SKILL_ROOT, "assets", "root-prd.template.md"), resolve(workspace, "PRD.md")),
      copyFile(
        resolve(SKILL_ROOT, "assets", "child-prd.template.md"),
        resolve(workspace, "plans", "capability-delivery.prd.md"),
      ),
    ])

    const compiled = await compilePrdGraph(resolve(workspace, "PRD.md"), {
      workspaceRoot: workspace,
      recursive: true,
      strict: true,
    })
    expect(compiled.ok).toBeTrue()
    expect(compiled.diagnostics).toEqual([])
    const graph = CompiledPrdGraphSchema.parse(compiled.graph)
    expect(Object.keys(graph.documents)).toEqual([
      "project-increment",
      "capability-delivery-details",
    ])
    expect(graph.childEdges).toHaveLength(1)
    expect(graph.topologicalOrder).toHaveLength(3)
  })

  test("proves the complex sample has parent refs, dependencies, criteria and planned artifacts", async () => {
    const compiled = await compilePrdGraph(resolve(SAMPLE_ROOT, "PRD.md"), {
      workspaceRoot: SAMPLE_ROOT,
      recursive: true,
      strict: true,
    })
    expect(compiled.ok).toBeTrue()
    expect(compiled.diagnostics).toEqual([])
    const graph = CompiledPrdGraphSchema.parse(compiled.graph)
    const tasks = Object.values(graph.documents).flatMap((document) => document.tasks)

    expect(Object.keys(graph.documents)).toHaveLength(2)
    expect(tasks).toHaveLength(5)
    expect(graph.childEdges).toHaveLength(1)
    expect(graph.dependencyEdges.length).toBeGreaterThanOrEqual(2)
    expect(tasks.every((task) => task.criteria.length > 0)).toBeTrue()
    expect(
      tasks.every((task) =>
        task.subPrd
          ? true
          : task.verification.some((specification) => specification.type === "artifact"),
      ),
    ).toBeTrue()
  })
})
