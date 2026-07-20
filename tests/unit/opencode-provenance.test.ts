import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  assertOpenCodeSbomComponent,
  createOpenCodeSbomComponent,
  type OpenCodeProvenanceManifest,
  parseOpenCodeProvenanceManifest,
  verifyOpenCodeProvenance,
} from "../../scripts/opencode-provenance"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const PROJECT_ROOT = resolve(import.meta.dir, "../..")
const MANIFEST_PATH = resolve(PROJECT_ROOT, "third_party/opencode/PROVENANCE.json")
const PINNED_COMMIT = "45cd8d76920839e4a7b6b931c4e26b52e1495636"
const MANIFEST_SHA256 = "cd99039cd6c896980690c167e57a249058fca2f7fc5912d98c4aa77fcc99d2d8"
const LICENSE_LF_SHA256 = "625f0f619133f89bbbb2abe37369613dfa1885eba1e50d02170deb62bb42cb6b"
const SOURCE_PATHS = [
  "LICENSE",
  "packages/core/src/model.ts",
  "packages/core/src/models-dev.ts",
  "packages/core/src/provider.ts",
  "packages/opencode/src/auth/index.ts",
  "packages/opencode/src/plugin/openai/codex.ts",
  "packages/opencode/src/provider/provider.ts",
] as const
const DESTINATION_PATHS = [
  "apps/ralph-cli/src/s04-services.ts",
  "packages/openai-driver/src/device-auth.ts",
  "packages/openai-driver/src/driver.ts",
  "packages/openai-driver/src/protocol.ts",
  "packages/providers/src/catalog.ts",
  "packages/providers/src/contracts.ts",
  "packages/providers/src/curated.ts",
  "packages/providers/src/file-cache.ts",
  "packages/providers/src/models-dev.ts",
  "packages/providers/src/registry.ts",
  "packages/providers/src/runtime.ts",
  "third_party/opencode/LICENSE",
] as const
const temporaryDirectories: string[] = []

function cloneManifest(manifest: OpenCodeProvenanceManifest): Record<string, unknown> {
  return structuredClone(manifest) as unknown as Record<string, unknown>
}

async function copyRegular(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, "utf8")
}

async function createProvenanceFixture(): Promise<{
  readonly root: string
  readonly manifest: OpenCodeProvenanceManifest
}> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as OpenCodeProvenanceManifest
  const paths = [
    "package.json",
    "THIRD_PARTY_NOTICES.md",
    "third_party/opencode/LICENSE",
    "third_party/opencode/PROVENANCE.json",
    "third_party/opencode/UPSTREAM.md",
    "third_party/opencode/copied-files.md",
    "third_party/opencode/patches.md",
    "packages/commands/src/settings-command.ts",
    ...manifest.destinations.map((destination) => destination.path),
  ]
  await Promise.all(
    [...new Set(paths)].map((path) =>
      copyRegular(resolve(PROJECT_ROOT, path), resolve(root, path)),
    ),
  )
  return { root, manifest }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("OpenCode structured provenance gate", () => {
  test("verifies the exact source, destination, patch and branding inventory", async () => {
    const verified = await verifyOpenCodeProvenance(PROJECT_ROOT)

    expect(verified.manifestSha256).toBe(MANIFEST_SHA256)
    expect(verified.manifest.upstream).toEqual({
      repository: "https://github.com/anomalyco/opencode",
      revision: PINNED_COMMIT,
      packageVersion: "1.18.3",
      licenseExpression: "MIT",
      licensePath: "third_party/opencode/LICENSE",
      licenseSha256Lf: LICENSE_LF_SHA256,
      snapshotVerifiedDate: "2026-07-18",
    })
    expect(verified.manifest.sources.map((source) => source.path)).toEqual([...SOURCE_PATHS])
    expect(verified.manifest.destinations.map((destination) => destination.path)).toEqual([
      ...DESTINATION_PATHS,
    ])
    expect(verified.manifest.patches.map((patch) => patch.id)).toEqual(["P0001", "P0002", "P0003"])
    expect(verified.manifest.brandingPolicy).toMatchObject({
      productIdentityCopied: false,
      forbiddenTokens: ["@opencode-ai", "anomalyco", "opencode"],
      allowedAssets: [],
    })
    expect(
      verified.manifest.brandingPolicy.allowedOccurrences.map((entry) => ({
        path: entry.path,
        token: entry.token,
        count: entry.exactCount,
        classification: entry.classification,
      })),
    ).toEqual([
      {
        path: "packages/commands/src/settings-command.ts",
        token: "opencode",
        count: 1,
        classification: "attribution-disclaimer",
      },
      {
        path: "packages/openai-driver/src/protocol.ts",
        token: "opencode",
        count: 1,
        classification: "protocol-required",
      },
    ])
    expect(JSON.stringify(verified.manifest)).not.toMatch(/reviewer|approved|legalReview/iu)
  })

  test("rejects missing, extra, duplicate and asymmetric structured records", async () => {
    const manifest = (await verifyOpenCodeProvenance(PROJECT_ROOT)).manifest

    const extraKey = cloneManifest(manifest)
    extraKey.approved = true
    expect(() => parseOpenCodeProvenanceManifest(extraKey)).toThrow("keys must be exactly")

    const missingDestination = cloneManifest(manifest)
    const destinations = missingDestination.destinations as unknown[]
    destinations.splice(0, 1)
    expect(() => parseOpenCodeProvenanceManifest(missingDestination)).toThrow(
      "asymmetric destination",
    )

    const duplicateSource = cloneManifest(manifest)
    const sources = duplicateSource.sources as unknown[]
    sources.push(structuredClone(sources.at(-1)))
    expect(() => parseOpenCodeProvenanceManifest(duplicateSource)).toThrow(
      "unique and sorted by path",
    )

    const unlistedPatch = cloneManifest(manifest)
    const firstSource = (unlistedPatch.sources as Array<Record<string, unknown>>)[0]
    if (!firstSource) throw new Error("Fixture lost its first source")
    firstSource.patchIds = ["P9999"]
    expect(() => parseOpenCodeProvenanceManifest(unlistedPatch)).toThrow("unknown patch P9999")

    const referenceOnlyClaim = cloneManifest(manifest)
    const referenceSource = (referenceOnlyClaim.sources as Array<Record<string, unknown>>).find(
      (source) => source.classification === "reference-only",
    )
    if (!referenceSource) throw new Error("Fixture lost its reference-only source")
    referenceSource.destinationPaths = [DESTINATION_PATHS[0]]
    expect(() => parseOpenCodeProvenanceManifest(referenceOnlyClaim)).toThrow(
      "reference-only sources cannot claim",
    )
  })

  test("recalculates destination hashes and rejects missing, extra and undeclared branding", async () => {
    const fixture = await createProvenanceFixture()
    await expect(verifyOpenCodeProvenance(fixture.root)).resolves.toMatchObject({
      manifestSha256: MANIFEST_SHA256,
    })

    const destination = fixture.manifest.destinations[0]
    if (!destination) throw new Error("Fixture lost its first destination")
    const destinationPath = resolve(fixture.root, destination.path)
    const originalDestination = await readFile(destinationPath)
    await writeFile(destinationPath, Buffer.concat([originalDestination, Buffer.from("\n")]))
    await expect(verifyOpenCodeProvenance(fixture.root)).rejects.toThrow(
      "current bytes do not match",
    )
    await writeFile(destinationPath, originalDestination)

    await rm(destinationPath)
    await expect(verifyOpenCodeProvenance(fixture.root)).rejects.toThrow(
      "must be a bounded non-empty regular file",
    )
    await writeFile(destinationPath, originalDestination)

    const extraProvenance = resolve(fixture.root, "third_party/opencode/EXTRA.svg")
    await writeText(extraProvenance, "<svg/>\n")
    await expect(verifyOpenCodeProvenance(fixture.root)).rejects.toThrow(
      "contains a missing, extra or non-regular file",
    )
    await rm(extraProvenance)

    const rogueSource = resolve(fixture.root, "packages/rogue/src/identity.ts")
    await writeText(rogueSource, 'export const identity = "OpenCode"\n')
    await expect(verifyOpenCodeProvenance(fixture.root)).rejects.toThrow(
      "undeclared or mismatched product token",
    )
    await rm(resolve(fixture.root, "packages/rogue"), { recursive: true })

    const rogueAsset = resolve(fixture.root, "packages/rogue/src/opencode-logo.svg")
    await writeText(rogueAsset, "<svg/>\n")
    await expect(verifyOpenCodeProvenance(fixture.root)).rejects.toThrow(
      "undeclared OpenCode-named asset",
    )
  })

  test("rejects an OpenCode runtime dependency even when the source inventory is intact", async () => {
    const fixture = await createProvenanceFixture()
    const packagePath = resolve(fixture.root, "package.json")
    const packageManifest = JSON.parse(await readFile(packagePath, "utf8")) as Record<
      string,
      unknown
    >
    packageManifest.dependencies = { opencode: "1.18.3" }
    await writeText(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`)

    await expect(verifyOpenCodeProvenance(fixture.root)).rejects.toThrow(
      "contains undeclared OpenCode dependency opencode",
    )
  })

  test("binds the SBOM component exactly to repository, revision, license and manifest", async () => {
    const provenance = await verifyOpenCodeProvenance(PROJECT_ROOT)
    const component = createOpenCodeSbomComponent(provenance)

    expect(() => assertOpenCodeSbomComponent(component, provenance)).not.toThrow()
    expect(component).toMatchObject({
      type: "library",
      "bom-ref": `pkg:github/anomalyco/opencode@${PINNED_COMMIT}`,
      name: "opencode-curated-source",
      version: `1.18.3+${PINNED_COMMIT.slice(0, 7)}`,
      purl: `pkg:github/anomalyco/opencode@${PINNED_COMMIT}`,
      licenses: [{ expression: "MIT" }],
    })
    expect(component.properties).toContainEqual({
      name: "ralph:provenance-manifest-sha256",
      value: MANIFEST_SHA256,
    })
    expect(component.properties).toContainEqual({
      name: "ralph:upstream-license-sha256-lf",
      value: LICENSE_LF_SHA256,
    })

    for (const tampered of [
      { ...component, licenses: [{ expression: "Apache-2.0" }] },
      { ...component, purl: "pkg:github/example/not-opencode@deadbeef" },
      { ...component, "bom-ref": `pkg:github/anomalyco/opencode@${"f".repeat(40)}` },
      {
        ...component,
        properties: component.properties.map((property) =>
          property.name === "ralph:provenance-manifest-sha256"
            ? { ...property, value: "f".repeat(64) }
            : property,
        ),
      },
    ]) {
      expect(() => assertOpenCodeSbomComponent(tampered, provenance)).toThrow(
        "must exactly bind repository, revision, license, license hash and manifest hash",
      )
    }
  })
})
