import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { moduleSpecifiers } from "../helpers/module-specifiers"

const packageRoot = resolve(import.meta.dir, "../../packages/openai-driver")

describe("openai-driver dependency and authority boundary", () => {
  test("uses only local source imports and has no OpenCode runtime dependency", async () => {
    const manifest = (await Bun.file(resolve(packageRoot, "package.json")).json()) as Record<
      string,
      unknown
    >
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.devDependencies).toBeUndefined()

    const sourceRoot = resolve(packageRoot, "src")
    const sourceFiles = (await readdir(sourceRoot)).filter((name) => name.endsWith(".ts"))
    expect(sourceFiles.sort()).toEqual([
      "device-auth.ts",
      "driver.ts",
      "index.ts",
      "protocol.ts",
      "response-body.ts",
      "stream.ts",
    ])
    for (const sourceFile of sourceFiles) {
      const source = await readFile(resolve(sourceRoot, sourceFile), "utf8")
      const imports = moduleSpecifiers(source, sourceFile)
      expect(
        imports.every((specifier) => specifier?.startsWith(".")),
        sourceFile,
      ).toBeTrue()
      expect(source, sourceFile).not.toContain("node:child_process")
      expect(source, sourceFile).not.toContain("Bun.spawn")
      expect(source, sourceFile).not.toContain("execFile")
      expect(source, sourceFile).not.toContain("@opencode-ai/")
    }
  })

  test("does not expose credential values through metadata or JSON serialization", async () => {
    const source = await readFile(resolve(packageRoot, "src/driver.ts"), "utf8")
    expect(source).toContain("#apiKey")
    expect(source).toContain("#credential")
    expect(source).not.toContain("accessToken: this.#credential.accessToken")
    expect(source).not.toContain("refreshToken: this.#credential.refreshToken")
  })
})
