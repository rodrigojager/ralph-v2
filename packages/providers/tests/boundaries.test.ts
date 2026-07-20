import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { moduleSpecifiers } from "../../../tests/helpers/module-specifiers"

const PACKAGE_ROOT = resolve(import.meta.dir, "..")
const SOURCE_ROOT = resolve(PACKAGE_ROOT, "src")

async function sourceFiles(): Promise<readonly string[]> {
  const entries = await readdir(SOURCE_ROOT, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolve(SOURCE_ROOT, entry.name))
    .sort()
}

describe("provider package dependency boundary", () => {
  test("source imports only public runtime dependencies and local modules", async () => {
    const allowedExternalImports = new Set(["node:crypto", "node:fs/promises", "node:path", "zod"])

    for (const file of await sourceFiles()) {
      const source = await readFile(file, "utf8")
      const imports = moduleSpecifiers(source, file)
      for (const specifier of imports) {
        expect(
          specifier.startsWith(".") || allowedExternalImports.has(specifier),
          `${file} imports non-provider dependency ${specifier}`,
        ).toBe(true)
      }
      expect(source).not.toMatch(/\b(?:Bun\.spawn|child_process|execFile|spawnSync)\b/)
    }
  })

  test("the package has no private or workspace dependencies", async () => {
    const manifest = JSON.parse(await readFile(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(manifest.dependencies).toEqual({ zod: "4.4.3" })
    expect(manifest.devDependencies ?? {}).toEqual({})
  })
})
