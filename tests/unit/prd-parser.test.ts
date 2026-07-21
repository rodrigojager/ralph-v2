import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  PrdDocumentSchema,
  parseMarkdownFragment,
  parsePrdFile,
  parsePrdSource,
  parseVerification,
} from "@ralph/prd"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const FIXTURES = resolve(import.meta.dir, "../fixtures/prd")
const EXAMPLES = resolve(import.meta.dir, "../../examples")
const SCHEMAS = resolve(import.meta.dir, "../../schemas")
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

async function fixture(path: string): Promise<string> {
  return readFile(resolve(FIXTURES, path), "utf8")
}

function codes(result: { diagnostics: ReadonlyArray<{ code: string }> }): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("PRD v2 deterministic parser", () => {
  test("normalizes canonical Portuguese task labels from the root example", async () => {
    const source = await readFile(resolve(EXAMPLES, "PRD-v2-exemplo.md"), "utf8")
    const parsed = parsePrdSource(source, { file: "examples/PRD-v2-exemplo.md" })

    expect(parsed.ok).toBeTrue()
    expect(parsed.diagnostics).toEqual([])
    const document = PrdDocumentSchema.parse(parsed.document)
    expect(document).toMatchObject({
      schemaVersion: 2,
      id: "checkout-incremental",
      kind: "root",
      workspace: ".",
      defaults: { executorProfile: "default", evidenceMode: "change-only" },
    })
    expect(document.sharedContext.markdown).toContain("# Checkout incremental")
    expect(document.sharedContext.markdown).toContain("## Contexto compartilhado")
    expect(document.sharedContext.markdown).not.toContain("## Vertical slices")
    expect(document.sharedContext.text).toContain("O produto já possui catálogo")
    expect(document.definitionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(document.tasks.map((task) => task.id)).toEqual([
      "cart-add",
      "cart-review",
      "checkout-readiness-note",
    ])
    expect(document.tasks[0]).toMatchObject({
      status: "pending",
      dependencies: [],
      evidenceMode: "change-only",
      taskSpecHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(document.tasks[0]?.subPrd).toBeUndefined()
    expect(document.tasks[0]?.criteria.map((criterion) => criterion.id)).toEqual(["c1", "c2", "c3"])
    expect(document.tasks[2]?.verification).toEqual([
      expect.objectContaining({
        type: "artifact",
        artifactId: "checkout-readiness",
        path: "artifacts/checkout-readiness.md",
        category: "artifact",
        skipPolicy: "required",
        blocking: true,
      }),
    ])
  })

  test("normalizes every declared English alias, profiles and budgets", async () => {
    const source = await fixture("v2/valid-en.md")
    const parsed = parsePrdSource(source, { file: "valid-en.md" })

    expect(parsed.ok).toBeTrue()
    expect(parsed.diagnostics).toEqual([])
    const document = PrdDocumentSchema.parse(parsed.document)
    const task = document.tasks[0]
    expect(document.defaults).toMatchObject({
      executorProfile: "runner",
      judgeProfile: "reviewer",
      evidenceMode: "criteria",
      budget: {
        maxModelCallsPerAttempt: 4,
        taskTimeout: { source: "2m", milliseconds: 120_000 },
      },
    })
    expect(task).toMatchObject({
      id: "english-slice",
      status: "active",
      dependencies: [],
      parallelGroup: "delivery",
      profiles: { executor: "runner", judge: "reviewer" },
      budget: {
        maxModelCallsPerAttempt: 2,
        maxToolCallsPerModelCall: 3,
        maxInputTokens: 100,
        maxOutputTokens: 200,
        maxReasoningTokens: 50,
        maxTotalTokens: 350,
        maxCost: { amount: 1.25, currency: "USD" },
        taskTimeout: { source: "90s", milliseconds: 90_000 },
        maxRevisionAttempts: 1,
      },
    })
    expect(task?.verification).toEqual([
      expect.objectContaining({
        type: "file",
        id: "english-slice:verification:1",
        path: "README.md",
        expectation: { kind: "exists" },
        category: "file",
        skipPolicy: "required",
        blocking: true,
      }),
    ])
    expect(task?.notes?.[0]?.text).toBe("Preserve the human wording.")
  })

  test("fails closed on YAML aliases, forbidden keys and invalid UTF-8", async () => {
    const valid = await fixture("v2/valid-en.md")
    const aliasSource = valid
      .replace("title: English task vocabulary", "title: &shared English task vocabulary")
      .replace("fixture: english-labels", "fixture: *shared")
    const aliased = parsePrdSource(aliasSource, { file: "alias-bomb.md" })
    expect(aliased.ok).toBeFalse()
    expect(codes(aliased)).toContain("RALPH_PRD_YAML_ALIAS_FORBIDDEN")

    const forbiddenSource = valid.replace(
      "  fixture: english-labels",
      "  constructor:\n    polluted: true",
    )
    const forbidden = parsePrdSource(forbiddenSource, { file: "forbidden-key.md" })
    expect(forbidden.ok).toBeFalse()
    expect(codes(forbidden)).toContain("RALPH_PRD_KEY_FORBIDDEN")
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()

    const root = await temporaryDirectory()
    const invalidUtf8Path = resolve(root, "invalid-utf8.md")
    await writeFile(invalidUtf8Path, Buffer.from([0xff, 0xfe, 0xfd]))
    const invalidUtf8 = await parsePrdFile(invalidUtf8Path, { file: "invalid-utf8.md" })
    expect(invalidUtf8.ok).toBeFalse()
    expect(codes(invalidUtf8)).toEqual(["RALPH_PRD_UTF8_INVALID"])
  })

  test("namespaces task identity by document and excludes diagnostic file paths", async () => {
    const source = await fixture("v2/valid-en.md")
    const relative = parsePrdSource(source, { file: "plans/root.md" })
    const absoluteDiagnostic = parsePrdSource(source, {
      file: "C:/machine-specific/workspace/plans/root.md",
    })
    const renamedDocument = parsePrdSource(
      source.replace("id: english-contract", "id: renamed-contract"),
      { file: "plans/root.md" },
    )

    expect(relative.ok).toBeTrue()
    expect(absoluteDiagnostic.ok).toBeTrue()
    expect(renamedDocument.ok).toBeTrue()
    expect(absoluteDiagnostic.document?.definitionHash).toBe(relative.document?.definitionHash)
    expect(absoluteDiagnostic.document?.tasks[0]?.taskSpecHash).toBe(
      relative.document?.tasks[0]?.taskSpecHash,
    )
    expect(renamedDocument.document?.tasks[0]?.taskSpecHash).not.toBe(
      relative.document?.tasks[0]?.taskSpecHash,
    )
  })

  test("materializes an empty shared context instead of omitting it", async () => {
    const source = (await fixture("v2/valid-en.md")).replace(
      /\n# English contract[\s\S]*?\n## Vertical slices/,
      "\n## Vertical slices",
    )
    const parsed = parsePrdSource(source, { file: "empty-context.md" })

    expect(parsed.ok).toBeTrue()
    expect(parsed.document?.sharedContext).toEqual({ markdown: "\n", text: "", ast: [] })
  })

  test.each([
    ["../../", "RALPH_PRD_PATH_ESCAPE"],
    ["C:relative", "RALPH_PRD_PATH_ABSOLUTE"],
  ])("rejects an unsafe CommandSpec cwd %s", (cwd, expectedCode) => {
    const command = JSON.stringify({
      executable: "bun",
      args: ["test"],
      cwd,
      timeoutMs: 1_000,
      successExitCodes: [0],
      outputLimitBytes: 1_024,
    })

    let caught: unknown
    try {
      parseVerification(parseMarkdownFragment(`command: ${command}`), "safe-command", 1)
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({ code: expectedCode })
  })

  test("keeps direct commands compatible and parses explicit command metadata without inference", () => {
    const command = {
      executable: "project-check",
      args: ["--slice", "current"],
      cwd: ".",
      shell: false as const,
      timeoutMs: 1_000,
      successExitCodes: [0],
      outputLimitBytes: 1_024,
    }

    const direct = parseVerification(
      parseMarkdownFragment(`command: ${JSON.stringify(command)}`),
      "direct-command",
      1,
    )
    expect(direct).toMatchObject({
      type: "command",
      category: "command",
      skipPolicy: "required",
      blocking: true,
      command,
    })

    const wrapped = parseVerification(
      parseMarkdownFragment(
        `command: ${JSON.stringify({
          category: "test",
          skipPolicy: "allowed-to-skip",
          blocking: true,
          command,
        })}`,
      ),
      "wrapped-command",
      1,
    )
    expect(wrapped).toMatchObject({
      type: "command",
      category: "test",
      skipPolicy: "allowed-to-skip",
      blocking: true,
      command,
    })
  })

  test("rejects an optional or never-run command wrapper that remains blocking", () => {
    const command = {
      executable: "project-check",
      args: [],
      timeoutMs: 1_000,
      successExitCodes: [0],
      outputLimitBytes: 1_024,
    }
    for (const skipPolicy of ["optional", "never-run"]) {
      expect(() =>
        parseVerification(
          parseMarkdownFragment(
            `command: ${JSON.stringify({
              category: "test",
              skipPolicy,
              blocking: true,
              command,
            })}`,
          ),
          "invalid-wrapper",
          1,
        ),
      ).toThrow()
    }
  })

  test("parses plugin JSON containing semicolons inside string values", () => {
    const verification = parseVerification(
      parseMarkdownFragment(
        'plugin: contract-audit; {"query":"api;ui","nested":{"message":"keep;the;value"}}',
      ),
      "plugin-contract",
      1,
    )

    expect(verification).toEqual({
      type: "plugin",
      id: "plugin-contract:verification:1",
      plugin: "contract-audit",
      input: {
        query: "api;ui",
        nested: { message: "keep;the;value" },
      },
      category: "plugin",
      skipPolicy: "required",
      blocking: true,
    })
  })

  test.each([
    ["v2/invalid/unknown-label.md", "RALPH_PRD_FIELD_LABEL_UNKNOWN"],
    ["v2/invalid/duplicate-label.md", "RALPH_PRD_FIELD_DUPLICATED"],
  ])("rejects invalid declared field grammar in %s", async (path, expectedCode) => {
    const parsed = parsePrdSource(await fixture(path), { file: path })

    expect(parsed.ok).toBeFalse()
    expect(codes(parsed)).toContain(expectedCode)
    const diagnostic = parsed.diagnostics.find((candidate) => candidate.code === expectedCode)
    expect(diagnostic).toMatchObject({
      severity: "error",
      file: path,
      line: expect.any(Number),
      column: expect.any(Number),
    })
  })

  test("reports UTF-8 byte offsets correctly for Unicode content with CRLF", async () => {
    const root = await temporaryDirectory()
    const path = resolve(root, "unicode-crlf.md")
    const source = (await fixture("v2/unicode-template.md")).replaceAll("\n", "\r\n")
    const bytes = Buffer.from(source, "utf8")
    await writeFile(path, bytes)

    const parsed = await parsePrdFile(path, { file: "unicode-crlf.md" })

    expect(parsed.ok).toBeTrue()
    expect(parsed.diagnostics).toEqual([])
    const document = PrdDocumentSchema.parse(parsed.document)
    const location = document.sourceMap["unicode-slice"]
    const expectedMarkerOffset = bytes.indexOf(Buffer.from("[ ] **unicode-slice", "utf8"))
    expect(expectedMarkerOffset).toBeGreaterThan(0)
    expect(location?.marker).toEqual({
      line: expect.any(Number),
      column: 3,
      offset: expectedMarkerOffset,
      length: 3,
    })
    expect(
      bytes.subarray(location?.marker.offset, (location?.marker.offset ?? 0) + 3).toString(),
    ).toBe("[ ]")
    expect(location?.marker.offset).toBeGreaterThan(source.indexOf("[ ] **unicode-slice"))
    expect(document.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"))
  })

  test("keeps generated JSON Schema and runtime document schema aligned on public fields", async () => {
    const source = await fixture("v2/valid-en.md")
    const parsed = parsePrdSource(source, { file: "valid-en.md" })
    const document = PrdDocumentSchema.parse(parsed.document)
    const schema = JSON.parse(
      await readFile(resolve(SCHEMAS, "prd-document.schema.json"), "utf8"),
    ) as {
      $schema: string
      $id: string
      additionalProperties: boolean
      required: string[]
      properties: Record<string, unknown>
    }

    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://rodrigojager.github.io/ralph-v2/schemas/v2/prd-document.schema.json",
      additionalProperties: false,
    })
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "schemaVersion",
        "id",
        "kind",
        "file",
        "workspace",
        "contentHash",
        "definitionHash",
        "defaults",
        "sharedContext",
        "tasks",
        "sourceMap",
      ]),
    )
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(Object.keys(document)))
  })
})
