import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  nativeTarget,
  parseBuildTargets,
  releaseTargetFor,
  sha256File,
  validateStandaloneArtifact,
} from "../../scripts/build-artifact"
import { sourceFingerprint } from "../../scripts/source-fingerprint"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

async function projectFixture(): Promise<{ root: string; binary: string; source: string }> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  const source = join(root, "apps", "cli", "main.ts")
  const files = new Map([
    [source, "console.log('fixture')\n"],
    [join(root, "packages", "domain", "index.ts"), "export const fixture = true\n"],
    [join(root, "scripts", "build.ts"), "// build recipe\n"],
    [join(root, "scripts", "build-artifact.ts"), "// validator recipe\n"],
    [join(root, "scripts", "source-fingerprint.ts"), "// fingerprint recipe\n"],
    [join(root, "package.json"), '{"version":"0.1.0-test"}\n'],
    [join(root, "bun.lock"), "{}\n"],
    [join(root, "tsconfig.json"), "{}\n"],
  ])
  for (const [path, contents] of files) {
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, contents)
  }

  const directory = join(root, "dist", "standalone", nativeTarget())
  await mkdir(directory, { recursive: true })
  const binary = join(directory, process.platform === "win32" ? "ralph.exe" : "ralph")
  await writeFile(binary, "standalone fixture bytes")
  const metadata = {
    schemaVersion: 1,
    target: nativeTarget(),
    status: "built-not-tested",
    version: "0.1.0-test",
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    artifact: binary.slice(root.length + 1).replaceAll("\\", "/"),
    sha256: await sha256File(binary),
    sourceSha256: await sourceFingerprint(root),
    builtAt: new Date().toISOString(),
  }
  await writeFile(join(directory, "build-metadata.json"), `${JSON.stringify(metadata)}\n`)
  return { root, binary, source }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("standalone build evidence", () => {
  test("maps only the closed platform matrix and parses only documented build flags", () => {
    expect(releaseTargetFor("win32", "x64")).toBe("bun-windows-x64-baseline")
    expect(releaseTargetFor("win32", "arm64")).toBe("bun-windows-arm64")
    expect(releaseTargetFor("linux", "x64")).toBe("bun-linux-x64-baseline")
    expect(releaseTargetFor("linux", "arm64")).toBe("bun-linux-arm64")
    expect(releaseTargetFor("darwin", "x64")).toBe("bun-darwin-x64")
    expect(releaseTargetFor("darwin", "arm64")).toBe("bun-darwin-arm64")
    expect(() => releaseTargetFor("freebsd", "x64")).toThrow("Unsupported native platform")
    expect(() => releaseTargetFor("linux", "riscv64")).toThrow("Unsupported native architecture")

    expect(parseBuildTargets([])).toEqual([nativeTarget()])
    expect(parseBuildTargets(["--all"])).toHaveLength(6)
    expect(parseBuildTargets(["--target", "bun-linux-arm64"])).toEqual(["bun-linux-arm64"])
    expect(() => parseBuildTargets(["--all", "--target", "bun-linux-arm64"])).toThrow(
      "Invalid build arguments",
    )
    expect(() => parseBuildTargets(["--al"])).toThrow("Invalid build arguments")
    expect(() => parseBuildTargets(["--target"])).toThrow("Invalid build arguments")
  })

  test("keeps workspace manifest versions synchronized with the root version authority", async () => {
    const projectRoot = resolve(import.meta.dir, "../..")
    const rootManifest = (await Bun.file(join(projectRoot, "package.json")).json()) as {
      version: string
    }
    const manifests = [
      "apps/ralph-cli/package.json",
      "packages/commands/package.json",
      "packages/domain/package.json",
      "packages/persistence/package.json",
      "packages/telemetry/package.json",
    ]
    for (const manifest of manifests) {
      const value = (await Bun.file(join(projectRoot, manifest)).json()) as { version: string }
      expect(value.version).toBe(rootManifest.version)
    }
  })

  test("accepts matching metadata and rejects stale source or changed binary", async () => {
    const fixture = await projectFixture()
    expect(
      (await validateStandaloneArtifact(fixture.binary, fixture.root, nativeTarget())).metadata
        .target,
    ).toBe(nativeTarget())

    await writeFile(fixture.source, "console.log('changed')\n")
    await expect(
      validateStandaloneArtifact(fixture.binary, fixture.root, nativeTarget()),
    ).rejects.toThrow("stale relative to current source")

    await writeFile(fixture.source, "console.log('fixture')\n")
    await writeFile(fixture.binary, "tampered standalone bytes")
    await expect(
      validateStandaloneArtifact(fixture.binary, fixture.root, nativeTarget()),
    ).rejects.toThrow("hash does not match")
  })
})
