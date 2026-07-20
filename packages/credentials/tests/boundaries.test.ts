import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { moduleSpecifiers } from "../../../tests/helpers/module-specifiers"

const PACKAGE_ROOT = resolve(import.meta.dir, "..")
const SOURCE_ROOT = resolve(PACKAGE_ROOT, "src")
const EXPECTED_SOURCE_FILES = [
  "atomic-file.ts",
  "contracts.ts",
  "environment-secret-store.ts",
  "fake-secret-store.ts",
  "index.ts",
  "manager.ts",
  "metadata-registry.ts",
  "oauth.ts",
  "os-keychain-secret-store.ts",
  "redaction.ts",
  "secret-input.ts",
  "secret-process.ts",
] as const

async function sourceFiles(): Promise<readonly string[]> {
  const entries = await readdir(SOURCE_ROOT, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolve(SOURCE_ROOT, entry.name))
    .sort()
}

describe("credential package dependency and authority boundary", () => {
  test("imports only credential infrastructure and keeps process execution in the keychain adapter", async () => {
    const files = await sourceFiles()
    expect(files.map((file) => basename(file))).toEqual([...EXPECTED_SOURCE_FILES].sort())
    const allowedExternalImports = new Set([
      "node:crypto",
      "node:fs/promises",
      "node:http",
      "node:path",
      "zod",
    ])

    for (const file of files) {
      const source = await readFile(file, "utf8")
      const imports = moduleSpecifiers(source, file)
      for (const specifier of imports) {
        expect(
          specifier.startsWith(".") || allowedExternalImports.has(specifier),
          `${file} imports outside the credential boundary: ${specifier}`,
        ).toBe(true)
      }
      expect(source, file).not.toContain("@ralph-next/")
      expect(source, file).not.toMatch(/\b(?:child_process|execFile|spawnSync)\b/)
      if (basename(file) === "secret-process.ts") {
        expect(source.match(/\bBun\.spawn\b/g) ?? []).toHaveLength(1)
        expect(source).toContain("Bun.spawn([request.executable, ...request.args]")
      } else if (basename(file) === "oauth.ts") {
        expect(source.match(/\bBun\.spawn\b/g) ?? []).toHaveLength(1)
        expect(source).toContain("export const systemBrowserOpener")
        expect(source).toContain("assertBrowserUrl(url)")
        for (const executable of ["rundll32.exe", "/usr/bin/open", "xdg-open"]) {
          expect(source).toContain(executable)
        }
      } else {
        expect(source, file).not.toContain("Bun.spawn")
      }
    }
  })

  test("has no workspace, orchestration, PRD, persistence or Git dependency", async () => {
    const manifest = JSON.parse(await readFile(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(manifest.dependencies).toEqual({ zod: "4.4.3" })
    expect(manifest.devDependencies ?? {}).toEqual({})
  })
})
