import { afterEach, describe, expect, test } from "bun:test"
import { readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  detectPrdBytes,
  formatPrdSource,
  migrateClassicDocument,
  PrdMigrationReportSchema,
  parseClassicPrdBytes,
  parsePrdFile,
  parsePrdSource,
  updateTaskMarker,
} from "@ralph/prd"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const FIXTURES = resolve(import.meta.dir, "../fixtures/prd")
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

async function fixture(path: string): Promise<string> {
  return readFile(resolve(FIXTURES, path), "utf8")
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("transactional PRD marker editing", () => {
  test("changes exactly one marker byte and preserves Unicode CRLF content", async () => {
    const root = await temporaryDirectory()
    const path = resolve(root, "unicode-crlf.md")
    const source = (await fixture("v2/unicode-template.md")).replaceAll("\n", "\r\n")
    await writeFile(path, source)
    const parsed = await parsePrdFile(path, { file: "unicode-crlf.md" })
    expect(parsed.ok).toBeTrue()
    const before = await readFile(path)

    const update = await updateTaskMarker(path, {
      file: "unicode-crlf.md",
      taskId: "unicode-slice",
      status: "active",
      expectedStatus: "pending",
      expectedContentHash: parsed.document?.contentHash ?? "",
    })

    const after = await readFile(path)
    const differences: Array<{ index: number; before: number; after: number | undefined }> = []
    for (let index = 0; index < before.length; index += 1) {
      const beforeByte = before[index]
      const afterByte = after[index]
      if (beforeByte !== afterByte && beforeByte !== undefined) {
        differences.push({ index, before: beforeByte, after: afterByte })
      }
    }
    expect(differences).toEqual([
      {
        index: update.markerByteOffset + 1,
        before: " ".charCodeAt(0),
        after: "~".charCodeAt(0),
      },
    ])
    expect(after.length).toBe(before.length)
    expect(after.toString("utf8").match(/\r\n/g)?.length).toBe(
      before.toString("utf8").match(/\r\n/g)?.length,
    )
    expect(update).toMatchObject({
      previousStatus: "pending",
      status: "active",
      previousContentHash: parsed.document?.contentHash,
      changed: true,
      reparsed: true,
    })
    const reparsed = await parsePrdFile(path, { file: "unicode-crlf.md" })
    expect(reparsed.document?.tasks[0]?.status).toBe("active")
    expect(reparsed.document?.contentHash).toBe(update.contentHash)
    expect(reparsed.document?.definitionHash).toBe(parsed.document?.definitionHash)
    expect(reparsed.document?.tasks[0]?.taskSpecHash).toBe(parsed.document?.tasks[0]?.taskSpecHash)
  })

  test("rejects an external edit using the compiled content hash precondition", async () => {
    const root = await temporaryDirectory()
    const path = resolve(root, "concurrent.md")
    const source = await fixture("v2/unicode-template.md")
    await writeFile(path, source)
    const parsed = await parsePrdFile(path, { file: "concurrent.md" })
    expect(parsed.ok).toBeTrue()
    await writeFile(path, source.replace("ação observável", "ação editada externamente"))

    let caught: unknown
    try {
      await updateTaskMarker(path, {
        file: "concurrent.md",
        taskId: "unicode-slice",
        status: "completed",
        expectedContentHash: parsed.document?.contentHash ?? "",
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({ code: "RALPH_PRD_MARKER_HASH_CONFLICT", exitCode: 7 })
    expect(await readFile(path, "utf8")).toContain("ação editada externamente")
    expect(await readFile(path, "utf8")).toContain("- [ ] **unicode-slice")
  })

  test("recovers an orphan marker lock immediately when lockStaleMs is zero", async () => {
    const root = await temporaryDirectory()
    const path = resolve(root, "orphan-lock.md")
    const lockPath = `${path}.ralph-marker.lock`
    await writeFile(path, await fixture("v2/unicode-template.md"))
    const parsed = await parsePrdFile(path, { file: "orphan-lock.md" })
    expect(parsed.ok).toBeTrue()
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2_147_483_647, createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
    )

    const update = await updateTaskMarker(path, {
      file: "orphan-lock.md",
      taskId: "unicode-slice",
      status: "active",
      expectedStatus: "pending",
      expectedContentHash: parsed.document?.contentHash ?? "",
      lockStaleMs: 0,
    })

    expect(update).toMatchObject({ previousStatus: "pending", status: "active", changed: true })
    expect(await Bun.file(lockPath).exists()).toBeFalse()
    expect(await readFile(path, "utf8")).toContain("- [~] **unicode-slice")
  })

  test("does not steal a marker lock owned by the live current PID", async () => {
    const root = await temporaryDirectory()
    const path = resolve(root, "live-lock.md")
    const lockPath = `${path}.ralph-marker.lock`
    await writeFile(path, await fixture("v2/unicode-template.md"))
    const parsed = await parsePrdFile(path, { file: "live-lock.md" })
    expect(parsed.ok).toBeTrue()
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" })}\n`,
    )

    try {
      let caught: unknown
      try {
        await updateTaskMarker(path, {
          file: "live-lock.md",
          taskId: "unicode-slice",
          status: "active",
          expectedStatus: "pending",
          expectedContentHash: parsed.document?.contentHash ?? "",
          lockStaleMs: 0,
        })
      } catch (error) {
        caught = error
      }

      expect(caught).toMatchObject({ code: "RALPH_PRD_MARKER_LOCKED", exitCode: 7 })
      expect(await Bun.file(lockPath).exists()).toBeTrue()
      expect(await readFile(path, "utf8")).toContain("- [ ] **unicode-slice")
    } finally {
      await rm(lockPath, { force: true })
    }
  })
})

describe("canonical PRD formatter", () => {
  test("is idempotent after canonicalizing English aliases and active markers", async () => {
    const source = await fixture("v2/valid-en.md")
    const original = parsePrdSource(source, { file: "valid-en.md" })
    const first = formatPrdSource(source, { file: "valid-en.md" })

    expect(first.ok).toBeTrue()
    expect(first.changed).toBeTrue()
    expect(first.source).toContain("- [~] **english-slice — Deliver one observable increment**")
    expect(first.source).toContain("  - Resultado:")
    expect(first.source).toContain("  - Orçamento:")
    expect(first.source).not.toContain("  - Result:")

    const second = formatPrdSource(first.source ?? "", { file: "valid-en.md" })
    expect(second).toMatchObject({ ok: true, changed: false, source: first.source })
    const canonical = parsePrdSource(second.source ?? "", { file: "valid-en.md" })
    expect(canonical.ok).toBeTrue()
    expect(canonical.document?.definitionHash).toBe(original.document?.definitionHash)
    expect(canonical.document?.tasks[0]?.taskSpecHash).toBe(
      original.document?.tasks[0]?.taskSpecHash,
    )
  })

  test("keeps direct command syntax and canonicalizes explicit command wrappers", async () => {
    const source = (await fixture("v2/valid-en.md")).replace(
      "file: README.md; exists",
      `command: ${JSON.stringify({
        category: "test",
        skipPolicy: "allowed-to-skip",
        blocking: true,
        command: {
          executable: "project-check",
          args: ["--slice", "english"],
          timeoutMs: 1_000,
          successExitCodes: [0],
          outputLimitBytes: 1_024,
        },
      })}`,
    )
    const formatted = formatPrdSource(source, { file: "wrapped-command.md" })

    expect(formatted.ok).toBeTrue()
    expect(formatted.source).toContain(
      'command: {"category":"test","skipPolicy":"allowed-to-skip","blocking":true,"command":',
    )
    const reparsed = parsePrdSource(formatted.source ?? "", { file: "wrapped-command.md" })
    expect(reparsed.document?.tasks[0]?.verification[0]).toMatchObject({
      type: "command",
      category: "test",
      skipPolicy: "allowed-to-skip",
      blocking: true,
    })
  })
})

describe("classic PRD compatibility and migration", () => {
  test("ignores checkbox-shaped examples in tilde fences and indented code blocks", async () => {
    const source = await fixture("classic/excluded-checkboxes.md")
    const parsed = parseClassicPrdBytes(Buffer.from(source, "utf8"), {
      file: "classic/excluded-checkboxes.md",
      extension: ".md",
    })

    expect(parsed.ok).toBeTrue()
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.document?.tasks).toHaveLength(1)
    expect(parsed.document?.tasks[0]).toMatchObject({
      id: "real-task",
      text: "Deliver the real classic task",
      acceptanceCriteria: ["The real task is recognized"],
    })
  })

  test("fails explicitly when classic Markdown frontmatter contains invalid YAML", async () => {
    const source = await fixture("classic/invalid-frontmatter.md")
    const parsed = parseClassicPrdBytes(Buffer.from(source, "utf8"), {
      file: "classic/invalid-frontmatter.md",
      extension: ".md",
    })

    expect(parsed.ok).toBeFalse()
    expect(parsed.document).toBeUndefined()
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "RALPH_PRD_CLASSIC_FRONTMATTER_INVALID",
        severity: "error",
        line: 1,
        column: 1,
      }),
    )
  })

  test("preserves [~] as skipped-for-review and resolves depends_on groups", async () => {
    const source = await fixture("classic/grouped.md")
    const bytes = Buffer.from(source, "utf8")
    const detection = detectPrdBytes(bytes, { file: "classic/grouped.md", extension: ".md" })
    const parsed = parseClassicPrdBytes(bytes, {
      file: "classic/grouped.md",
      extension: ".md",
    })

    expect(detection).toMatchObject({ format: "classic", diagnostics: [] })
    expect(parsed.ok).toBeTrue()
    expect(parsed.document?.tasks.map((task) => task.status)).toEqual([
      "pending",
      "skipped-for-review",
      "pending",
    ])
    expect(parsed.document?.tasks[0]).toMatchObject({
      id: "api-contract",
      group: "foundation",
      acceptanceCriteria: ["The contract is versioned", "The contract fixture is valid"],
    })
    expect(parsed.document?.tasks[2]).toMatchObject({
      id: "end-to-end",
      dependsOnGroups: ["foundation"],
    })

    const classicDocument = parsed.document
    expect(classicDocument).toBeDefined()
    if (!classicDocument) throw new Error("Expected a parsed classic PRD fixture")
    const migration = migrateClassicDocument(classicDocument, {
      sourceFile: "classic/grouped.md",
      outputFile: "classic/grouped.v2.md",
    })
    expect(migration.ok).toBeTrue()
    const report = PrdMigrationReportSchema.parse(migration.report)
    expect(report.lossless).toBeFalse()
    expect(report.notices.map((notice) => notice.code)).toEqual(
      expect.arrayContaining([
        "RALPH_PRD_MIGRATION_SKIPPED_REVIEW_TO_PENDING",
        "RALPH_PRD_MIGRATION_GROUP_DEPENDENCY_EXPANDED",
      ]),
    )

    const migrated = parsePrdSource(migration.markdown ?? "", {
      file: "classic/grouped.v2.md",
    })
    expect(migrated.ok).toBeTrue()
    const [api, ui, endToEnd] = migrated.document?.tasks ?? []
    expect(api?.criteria.map((criterion) => criterion.text.text)).toEqual([
      "The contract is versioned",
      "The contract fixture is valid",
    ])
    expect(ui).toMatchObject({ status: "pending", criteria: [], evidenceMode: "change-only" })
    expect(ui?.notes?.some((note) => note.text.includes("[~]"))).toBeTrue()
    expect(endToEnd).toMatchObject({
      criteria: [],
      evidenceMode: "change-only",
      dependencies: ["api-contract", "ui-state"],
    })
  })
})
