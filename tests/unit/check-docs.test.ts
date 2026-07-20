import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  checkDocumentation,
  sameCanonicalPath,
  writeDocumentationReport,
} from "../../scripts/check-docs"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, "utf8")
}

async function createFixture(scripts: readonly string[]): Promise<string> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  await writeText(
    resolve(root, "package.json"),
    `${JSON.stringify(
      { scripts: Object.fromEntries(scripts.map((script) => [script, "fixture"])) },
      null,
      2,
    )}\n`,
  )
  return root
}

async function createDirectoryLink(target: string, path: string): Promise<void> {
  // This is a security boundary test. An unavailable link fixture must fail
  // visibly instead of being reported as a passing assertion-free test.
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir")
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("documentation structure checker", () => {
  test("treats a Windows extended-length root as the same canonical volume", () => {
    if (process.platform === "win32") {
      expect(sameCanonicalPath("C:\\", "\\\\?\\C:\\")).toBeTrue()
      expect(sameCanonicalPath("C:\\", "C:")).toBeTrue()
      expect(sameCanonicalPath("\\\\server\\share", "\\\\?\\UNC\\server\\share")).toBeTrue()
      return
    }
    expect(sameCanonicalPath("/", "/")).toBeTrue()
  })

  test("keeps Unicode and duplicate heading anchors aligned through the AST", async () => {
    const root = await createFixture(["known"])
    await writeText(
      resolve(root, "README.md"),
      [
        "# Início 😀",
        "",
        "[Seção Unicode](docs/guia.md#seção-unicode)",
        "[Segundo título repetido](docs/guia.md#repetido-1)",
        "",
        "```sh",
        "bun run known",
        "[Isto é código, não link](missing-in-code.md)",
        "```",
        "",
        "`[Também não é link](missing-inline.md)`",
        "",
      ].join("\n"),
    )
    await writeText(
      resolve(root, "docs", "guia.md"),
      ["# Seção Unicode", "", "## Repetido", "", "## Repetido", ""].join("\n"),
    )

    const result = await checkDocumentation({ root })

    expect(result.status).toBe("pass")
    expect(result.counts.localLinks).toBe(2)
    expect(result.counts.packageScriptReferences).toBe(1)
    expect(result.issues).toEqual([])
  })

  test("reports missing local paths, anchors and package scripts deterministically", async () => {
    const root = await createFixture(["known"])
    await writeText(
      resolve(root, "README.md"),
      [
        "# Fixture",
        "",
        "[Missing](docs/missing.md)",
        "[Missing anchor](guide.md#absent)",
        "",
        "```sh",
        "bun run unknown",
        "```",
        "",
      ].join("\n"),
    )
    await writeText(resolve(root, "guide.md"), "# Present\n")

    const result = await checkDocumentation({ root })

    expect(result.status).toBe("fail")
    expect(result.issues.map((issue) => issue.kind)).toEqual([
      "missing-path",
      "missing-anchor",
      "unknown-package-script",
    ])
    expect(result.issues.map((issue) => issue.line)).toEqual([3, 4, 7])
  })

  test("uses CommonMark AST links, images, references and heading text", async () => {
    const root = await createFixture([])
    await writeText(
      resolve(root, "README.md"),
      [
        "# Fixture",
        "",
        "[Encoded destination](docs/guide%20draft.md#título-em-código)",
        "![Direct image](assets/logo%20mark.svg)",
        "[Reference link][guide]",
        "![Reference image][logo]",
        "",
        "[guide]: docs/guide%20draft.md#título-em-código",
        "[logo]: assets/logo%20mark.svg",
        "",
        "This malformed CommonMark destination is text: [broken](<unterminated",
        '<a href="missing-html.md">Raw HTML href is outside this checker contract.</a>',
        "",
        "\x60\x60\x60md",
        "[Code sample](missing-code.md)",
        "\x60\x60\x60",
        "",
      ].join("\n"),
    )
    await writeText(resolve(root, "docs", "guide draft.md"), "# Título em *código*\n")
    await writeText(resolve(root, "assets", "logo mark.svg"), "<svg></svg>\n")

    const result = await checkDocumentation({ root })

    expect(result.status).toBe("pass")
    expect(result.counts.localLinks).toBe(4)
    expect(result.issues).toEqual([])
  })

  test("reports malformed percent encoding at the CommonMark AST source line", async () => {
    const root = await createFixture([])
    await writeText(
      resolve(root, "README.md"),
      ["# Fixture", "", "[Malformed destination](docs/bad%ZZ.md)", ""].join("\n"),
    )

    const result = await checkDocumentation({ root })

    expect(result.status).toBe("fail")
    expect(result.counts.localLinks).toBe(1)
    expect(result.issues).toEqual([
      expect.objectContaining({
        kind: "invalid-link",
        file: "README.md",
        line: 3,
        value: "docs/bad%ZZ.md",
      }),
    ])
  })

  test("rejects malformed UTF-8 before parsing documentation", async () => {
    const root = await createFixture([])
    await writeFile(resolve(root, "README.md"), Uint8Array.of(0xff, 0xfe, 0xfd))

    await expect(checkDocumentation({ root })).rejects.toThrow(/not valid UTF-8/u)
  })

  test("reports a reference destination at the reference use line", async () => {
    const root = await createFixture([])
    await writeText(
      resolve(root, "README.md"),
      ["# Fixture", "", "[Missing by reference][guide]", "", "[guide]: docs/missing.md", ""].join(
        "\n",
      ),
    )

    const result = await checkDocumentation({ root })

    expect(result.status).toBe("fail")
    expect(result.counts.localLinks).toBe(1)
    expect(result.issues).toEqual([
      expect.objectContaining({
        kind: "missing-path",
        file: "README.md",
        line: 3,
        value: "docs/missing.md",
      }),
    ])
  })

  test("rejects a link destination routed through a directory link", async () => {
    const root = await createFixture([])
    const outside = await createTestDirectory()
    temporaryDirectories.push(outside)
    await writeText(resolve(root, "README.md"), "[Escaped](artifacts/external/secret.md)\n")
    await writeText(resolve(outside, "secret.md"), "# Outside\n")
    await mkdir(resolve(root, "artifacts"), { recursive: true })
    await createDirectoryLink(outside, resolve(root, "artifacts", "external"))

    const result = await checkDocumentation({ root })

    expect(result.status).toBe("fail")
    expect(result.counts.localLinks).toBe(1)
    expect(result.issues).toEqual([
      expect.objectContaining({
        kind: "unsafe-path",
        file: "README.md",
        line: 1,
      }),
    ])
  })

  test("rejects a project root reached through a symbolic link or junction", async () => {
    const root = await createFixture([])
    const aliasParent = await createTestDirectory()
    temporaryDirectories.push(aliasParent)
    await writeText(resolve(root, "README.md"), "# Fixture\n")
    const linkedRoot = resolve(aliasParent, "linked-root")
    await createDirectoryLink(root, linkedRoot)

    await expect(checkDocumentation({ root: linkedRoot })).rejects.toThrow(
      /symbolic link, junction, or reparse point/u,
    )
  })

  test("writes only through regular contained output ancestors", async () => {
    const root = await createFixture([])
    await writeText(resolve(root, "README.md"), "# Fixture\n")
    const result = await checkDocumentation({ root })
    const report = await writeDocumentationReport(result, "reports/docs.json", root)
    await writeDocumentationReport(result, "reports/docs.json", root)
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
      artifactClass: "documentation-structure-check",
      status: "pass",
    })

    const outside = await createTestDirectory()
    temporaryDirectories.push(outside)
    await mkdir(resolve(root, "artifacts"), { recursive: true })
    await createDirectoryLink(outside, resolve(root, "artifacts", "external"))

    await expect(
      writeDocumentationReport(result, "artifacts/external/escaped.json", root),
    ).rejects.toThrow(/symbolic link, junction, or reparse point/u)
    await createDirectoryLink(outside, resolve(root, "artifacts", "linked-report.json"))
    await expect(
      writeDocumentationReport(result, "artifacts/linked-report.json", root),
    ).rejects.toThrow(/symbolic link, junction, or reparse point/u)
    await expect(writeDocumentationReport(result, "../escaped.json", root)).rejects.toThrow(
      /must remain inside the project/u,
    )
  })
})
