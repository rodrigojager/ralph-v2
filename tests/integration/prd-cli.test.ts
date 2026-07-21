import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { runCli } from "@ralph/commands"
import { CommandResultSchema } from "@ralph/domain"
import { CompiledPrdGraphSchema, PrdMigrationReportSchema, parsePrdFile } from "@ralph/prd"
import type { OutputWriters } from "@ralph/telemetry"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "0.2.0-s02-test"
const FIXTURES = resolve(import.meta.dir, "../fixtures/prd")
const EXAMPLES = resolve(import.meta.dir, "../../examples")
const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

function context(cwd: string) {
  return {
    version: VERSION,
    cwd,
    environment: { RALPH_CONFIG_HOME: resolve(cwd, "isolated-global-config") },
  }
}

function captureWriters(): {
  writers: OutputWriters
  stdout: () => string
  stderr: () => string
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    writers: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  }
}

async function invokeJson(root: string, args: string[]) {
  const capture = captureWriters()
  const exitCode = await runCli(
    [...args, "--workspace", root, "--json"],
    context(root),
    capture.writers,
  )
  return {
    exitCode,
    stdout: capture.stdout(),
    stderr: capture.stderr(),
    result: CommandResultSchema.parse(JSON.parse(capture.stdout())),
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("PRD CLI", () => {
  test("validates and inspects the example graph as stable schema-valid JSON", async () => {
    const root = await temporaryDirectory()
    await Promise.all([
      copyFile(resolve(EXAMPLES, "PRD-v2-exemplo.md"), resolve(root, "PRD-v2-exemplo.md")),
      copyFile(resolve(EXAMPLES, "subprd-v2-exemplo.md"), resolve(root, "subprd-v2-exemplo.md")),
    ])

    const validated = await invokeJson(root, [
      "prd",
      "validate",
      "PRD-v2-exemplo.md",
      "--recursive",
      "--strict",
    ])
    expect(validated).toMatchObject({ exitCode: 0, stderr: "" })
    expect(validated.result).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "prd.validate",
      data: {
        format: "v2",
        recursive: true,
        strict: true,
        documentCount: 2,
        taskCount: 6,
      },
      diagnostics: [],
    })

    const inspected = await invokeJson(root, [
      "prd",
      "inspect",
      "PRD-v2-exemplo.md",
      "--recursive",
      "--strict",
    ])
    const inspectedAgain = await invokeJson(root, [
      "prd",
      "inspect",
      "PRD-v2-exemplo.md",
      "--recursive",
      "--strict",
    ])
    expect(inspected).toMatchObject({ exitCode: 0, stderr: "" })
    const graph = CompiledPrdGraphSchema.parse(inspected.result.data)
    const validationData = validated.result.data as { graphHash: string }
    expect(graph.rootDocumentId).toBe("checkout-incremental")
    expect(validationData.graphHash).toBeString()
    expect(graph.graphHash).toBe(validationData.graphHash)
    expect(inspectedAgain.stdout).toBe(inspected.stdout)
  })

  test("formats to a separate output and the resulting file passes --check", async () => {
    const root = await temporaryDirectory()
    const input = resolve(root, "human plan.md")
    const output = resolve(root, "canonical plan.md")
    await copyFile(resolve(FIXTURES, "v2/valid-en.md"), input)
    const original = await readFile(input, "utf8")

    const formatted = await invokeJson(root, [
      "prd",
      "format",
      "human plan.md",
      "--output",
      "canonical plan.md",
    ])
    expect(formatted).toMatchObject({ exitCode: 0, stderr: "" })
    expect(formatted.result).toMatchObject({
      ok: true,
      command: "prd.format",
      data: { file: "canonical plan.md", changed: true, written: true },
      diagnostics: [],
    })
    expect(await readFile(input, "utf8")).toBe(original)
    expect(await readFile(output, "utf8")).toContain("  - Resultado:")

    const checked = await invokeJson(root, ["prd", "format", "canonical plan.md", "--check"])
    expect(checked).toMatchObject({ exitCode: 0, stderr: "" })
    expect(checked.result).toMatchObject({
      ok: true,
      command: "prd.format",
      data: { file: "canonical plan.md", changed: false, checked: true },
      diagnostics: [],
    })
  })

  test("rejects format warnings in strict mode without writing an output", async () => {
    const root = await temporaryDirectory()
    const input = resolve(root, "noncanonical.md")
    const output = resolve(root, "strict-output.md")
    const source = (await readFile(resolve(FIXTURES, "v2/valid-en.md"), "utf8")).replace(
      "english-slice — Deliver",
      "english-slice - Deliver",
    )
    await writeFile(input, source)

    const formatted = await invokeJson(root, [
      "prd",
      "format",
      "noncanonical.md",
      "--strict",
      "--output",
      "strict-output.md",
    ])

    expect(formatted).toMatchObject({ exitCode: 3, stderr: "" })
    expect(formatted.result).toMatchObject({
      ok: false,
      command: "prd.format",
      data: null,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "RALPH_PRD_TASK_TITLE_NONCANONICAL",
          severity: "warning",
        }),
        expect.objectContaining({ code: "RALPH_PRD_STRICT_REJECTED", severity: "error" }),
      ]),
    })
    expect(await readFile(input, "utf8")).toBe(source)
    expect(await Bun.file(output).exists()).toBeFalse()
  })

  test("refuses an output routed through a directory link outside the workspace", async () => {
    const outside = await temporaryDirectory()
    const root = await temporaryDirectory()
    const input = resolve(root, "input.md")
    const linkedDirectory = resolve(root, "linked-outside")
    const escapedOutput = resolve(outside, "escaped.md")
    await copyFile(resolve(FIXTURES, "v2/valid-en.md"), input)

    try {
      await symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) return
      throw error
    }

    try {
      const formatted = await invokeJson(root, [
        "prd",
        "format",
        "input.md",
        "--output",
        "linked-outside/escaped.md",
      ])

      expect(formatted).toMatchObject({ exitCode: 10, stderr: "" })
      expect(formatted.result).toMatchObject({
        ok: false,
        command: "error",
        diagnostics: [{ code: "RALPH_PRD_OUTPUT_PATH_UNSAFE", severity: "error" }],
      })
      expect(await Bun.file(escapedOutput).exists()).toBeFalse()
    } finally {
      await rm(linkedDirectory, { force: true, recursive: true })
    }
  })

  test("refuses format --output equal to its input without writing", async () => {
    const root = await temporaryDirectory()
    const input = resolve(root, "same.md")
    await copyFile(resolve(FIXTURES, "v2/valid-en.md"), input)
    const original = await readFile(input, "utf8")

    const formatted = await invokeJson(root, ["prd", "format", "same.md", "--output", "same.md"])

    expect(formatted).toMatchObject({ exitCode: 2, stderr: "" })
    expect(formatted.result).toMatchObject({
      ok: false,
      command: "error",
      diagnostics: [{ code: "RALPH_PRD_OUTPUT_EQUALS_INPUT", severity: "error" }],
    })
    expect(await readFile(input, "utf8")).toBe(original)
  })

  test("migrates classic input without overwriting it or inventing criteria", async () => {
    const root = await temporaryDirectory()
    const input = resolve(root, "classic.md")
    const output = resolve(root, "migrated.md")
    const reportPath = resolve(root, "migration.json")
    await copyFile(resolve(FIXTURES, "classic/grouped.md"), input)
    const original = await readFile(input, "utf8")

    const migrated = await invokeJson(root, [
      "prd",
      "migrate",
      "classic.md",
      "--output",
      "migrated.md",
      "--report",
      "migration.json",
    ])
    expect(migrated).toMatchObject({ exitCode: 0, stderr: "" })
    expect(migrated.result).toMatchObject({
      ok: true,
      command: "prd.migrate",
      data: {
        schemaVersion: 1,
        source: "classic.md",
        output: "migrated.md",
        report: "migration.json",
        detected: "classic",
        taskCount: 3,
      },
      diagnostics: [],
    })
    expect(await readFile(input, "utf8")).toBe(original)
    const report = PrdMigrationReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")))
    expect(report.lossless).toBeFalse()

    const parsed = await parsePrdFile(output, { file: "migrated.md" })
    expect(parsed.ok).toBeTrue()
    expect(parsed.document?.tasks[0]?.criteria).toHaveLength(2)
    expect(parsed.document?.tasks[1]).toMatchObject({
      status: "pending",
      criteria: [],
      evidenceMode: "change-only",
    })
    expect(parsed.document?.tasks[2]).toMatchObject({
      criteria: [],
      dependencies: ["api-contract", "ui-state"],
      evidenceMode: "change-only",
    })
  })

  test("refuses migrate --output equal to its input without writing", async () => {
    const root = await temporaryDirectory()
    const input = resolve(root, "classic.md")
    await copyFile(resolve(FIXTURES, "classic/grouped.md"), input)
    const original = await readFile(input, "utf8")

    const migrated = await invokeJson(root, [
      "prd",
      "migrate",
      "classic.md",
      "--output",
      "classic.md",
    ])

    expect(migrated).toMatchObject({ exitCode: 2, stderr: "" })
    expect(migrated.result).toMatchObject({
      ok: false,
      command: "error",
      diagnostics: [{ code: "RALPH_PRD_OUTPUT_EQUALS_INPUT", severity: "error" }],
    })
    expect(await readFile(input, "utf8")).toBe(original)
    expect(await Bun.file(resolve(root, "classic.md.migration.json")).exists()).toBeFalse()
  })

  test.each([
    ["classic.md", "input"],
    ["migrated.md", "output"],
  ])("refuses a migration report path colliding with the %s", async (report, _kind) => {
    const root = await temporaryDirectory()
    const input = resolve(root, "classic.md")
    const output = resolve(root, "migrated.md")
    await copyFile(resolve(FIXTURES, "classic/grouped.md"), input)
    const original = await readFile(input, "utf8")

    const migrated = await invokeJson(root, [
      "prd",
      "migrate",
      "classic.md",
      "--output",
      "migrated.md",
      "--report",
      report,
    ])

    expect(migrated).toMatchObject({ exitCode: 2, stderr: "" })
    expect(migrated.result).toMatchObject({
      ok: false,
      command: "error",
      diagnostics: [{ code: "RALPH_PRD_REPORT_PATH_COLLISION", severity: "error" }],
    })
    expect(await readFile(input, "utf8")).toBe(original)
    expect(await Bun.file(output).exists()).toBeFalse()
  })
})
