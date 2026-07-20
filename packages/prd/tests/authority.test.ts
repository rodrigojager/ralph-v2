import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { PRD_AUTHORSHIP_POLICY } from "../src"

async function typeScriptSources(path: string): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== "tests") output.push(...(await typeScriptSources(child)))
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      output.push(child)
    }
  }
  return output
}

describe("PRD authorship boundary", () => {
  test("declares the runtime as a fail-before-model consumer", () => {
    expect(PRD_AUTHORSHIP_POLICY).toEqual({
      schemaVersion: 1,
      author: "external-skill",
      runtime: "consumer-only",
      missingPlan: "fail-before-model",
      childCreation: "pre-run-only",
    })
  })

  test("exposes no runtime command or callable that authors PRDs", async () => {
    const projectRoot = resolve(import.meta.dir, "../../..")
    const sources = [
      ...(await typeScriptSources(resolve(projectRoot, "apps"))),
      ...(await typeScriptSources(resolve(projectRoot, "packages"))),
    ]
    const forbidden = [
      /\bprd\.(?:create|generate|author)\b/i,
      /\bsub-?prd\.(?:create|generate|author)\b/i,
      /\b(?:create|generate|author)(?:sub)?prd\s*\(/i,
      /\b(?:criar|gerar)\s+(?:um\s+)?(?:sub-?)?prd\b/i,
      /\b(?:create|generate)\s+(?:a\s+)?(?:sub-?)?prd\b/i,
    ]

    const violations: string[] = []
    for (const source of sources) {
      const text = await readFile(source, "utf8")
      if (forbidden.some((pattern) => pattern.test(text))) violations.push(source)
    }
    expect(violations).toEqual([])
  })
})
