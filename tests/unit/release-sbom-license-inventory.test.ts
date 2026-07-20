import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { OpenCodeProvenanceManifest } from "../../scripts/opencode-provenance"
import { materializeReleaseLicenseInventory } from "../../scripts/release-licenses"
import { type CycloneDxBom, createReleaseSbom } from "../../scripts/release-sbom"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const APPLICATION_VERSION = "0.1.0-test"
const BUN_VERSION = "1.3.14"
const BUN_REVISION = "a".repeat(40)
const DEPENDENCY_NAME = "fixture-lib"
const DEPENDENCY_VERSION = "1.2.3"
const PUBLISHED_AT = "2026-07-19T12:00:00.000Z"
const SOURCE_FINGERPRINT = "c".repeat(64)
const SYNTHETIC_LICENSE = "fixture-license-v1\n"
const SYNTHETIC_PROVENANCE = "fixture-provenance-v1\n"
const PROJECT_ROOT = resolve(import.meta.dir, "../..")

type CurationFile = {
  path: string
  kind: "license" | "copying" | "notice" | "provenance"
  sizeBytes: number
  sha256: string
}

type CurationManifest = {
  schemaVersion: 1
  runtime: "bun"
  version: string
  revision: string
  sourceRepository: "https://github.com/oven-sh/bun"
  sourceRevision: string
  completeScope: "license-notice-provenance-for-pinned-runtime"
  curatedAt: string
  curatedBy: string
  files: CurationFile[]
}

type InventoryManifest = {
  schemaVersion: 1
  publishedAt: string
  sbomSha256: string
  components: Array<{
    bomRef: string
    licenseExpression?: string
    sourceKind: "bun-store" | "curated-source" | "bun-runtime"
    files: Array<{
      path: string
      sizeBytes: number
      sha256: string
    }>
  }>
}

type ReleaseFixture = {
  root: string
  curationRoot: string
  curationManifestPath: string
  curationLicensePath: string
  installedManifestPath: string
  outputParent: string
  workspaceManifestPath: string
}

const temporaryDirectories: string[] = []

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function serializedSbomSha256(sbom: CycloneDxBom): string {
  return sha256(`${JSON.stringify(sbom, null, 2)}\n`)
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, "utf8")
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function copyRegular(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}

async function copyOpenCodeFixture(root: string): Promise<void> {
  const sourceRoot = resolve(PROJECT_ROOT, "third_party", "opencode")
  const manifest = JSON.parse(
    await readFile(resolve(sourceRoot, "PROVENANCE.json"), "utf8"),
  ) as OpenCodeProvenanceManifest
  const paths = [
    "third_party/opencode/LICENSE",
    "third_party/opencode/PROVENANCE.json",
    "third_party/opencode/UPSTREAM.md",
    "third_party/opencode/copied-files.md",
    "third_party/opencode/patches.md",
    "THIRD_PARTY_NOTICES.md",
    "packages/commands/src/settings-command.ts",
    ...manifest.destinations.map((destination) => destination.path),
  ]
  const provenanceWorkspaces = paths.flatMap((path) => {
    const match = /^(apps|packages)\/([^/]+)\//u.exec(path)
    return match ? [`${match[1]}/${match[2]}`] : []
  })
  await Promise.all([
    ...[...new Set(paths)].map((path) =>
      copyRegular(resolve(PROJECT_ROOT, path), resolve(root, path)),
    ),
    ...[...new Set(provenanceWorkspaces)].map((workspace) =>
      writeJson(resolve(root, workspace, "package.json"), {
        name: `@fixture/${workspace.replace("/", "-")}`,
        version: APPLICATION_VERSION,
      }),
    ),
  ])
}

function curationFile(path: string, kind: CurationFile["kind"], contents: string): CurationFile {
  return {
    path,
    kind,
    sizeBytes: Buffer.byteLength(contents),
    sha256: sha256(contents),
  }
}

async function createReleaseFixture(): Promise<ReleaseFixture> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  const curationRoot = resolve(root, "third_party", "bun", "runtime", BUN_VERSION, BUN_REVISION)
  const curationManifestPath = resolve(curationRoot, "CURATION.json")
  const curationLicensePath = resolve(curationRoot, "LICENSE.fixture.txt")
  const installedPackageRoot = resolve(
    root,
    "node_modules",
    ".bun",
    `${DEPENDENCY_NAME}@${DEPENDENCY_VERSION}`,
    "node_modules",
    DEPENDENCY_NAME,
  )
  const installedManifestPath = resolve(installedPackageRoot, "package.json")
  const workspaceManifestPath = resolve(root, "packages", "ralph-next", "package.json")
  const outputParent = resolve(root, "output")

  const lock = {
    lockfileVersion: 1,
    workspaces: {
      "apps/ralph-launcher": {
        name: "@ralph-next/launcher",
        version: APPLICATION_VERSION,
      },
      "packages/ralph-next": {
        name: "ralph-next",
        version: APPLICATION_VERSION,
        dependencies: { [DEPENDENCY_NAME]: DEPENDENCY_VERSION },
      },
    },
    packages: {
      [DEPENDENCY_NAME]: [
        `${DEPENDENCY_NAME}@${DEPENDENCY_VERSION}`,
        "",
        {},
        `sha512-${Buffer.alloc(64).toString("base64")}`,
      ],
    },
  }
  await Promise.all([
    writeJson(resolve(root, "package.json"), {
      name: "ralph-v2-release-fixture",
      version: APPLICATION_VERSION,
      private: true,
      license: "MIT",
    }),
    writeText(resolve(root, "LICENSE"), "Synthetic root license for tests only.\n"),
    writeJson(resolve(root, "bun.lock"), lock),
    writeJson(resolve(root, "apps", "ralph-launcher", "package.json"), {
      name: "@ralph-next/launcher",
      version: APPLICATION_VERSION,
    }),
    writeJson(workspaceManifestPath, {
      name: "ralph-next",
      version: APPLICATION_VERSION,
      dependencies: { [DEPENDENCY_NAME]: DEPENDENCY_VERSION },
    }),
    writeJson(installedManifestPath, {
      name: DEPENDENCY_NAME,
      version: DEPENDENCY_VERSION,
      license: "MIT",
    }),
    writeText(resolve(installedPackageRoot, "LICENSE"), "Synthetic dependency license.\n"),
    copyOpenCodeFixture(root),
    writeText(curationLicensePath, SYNTHETIC_LICENSE),
    writeText(resolve(curationRoot, "PROVENANCE.fixture.txt"), SYNTHETIC_PROVENANCE),
    mkdir(outputParent, { recursive: true }),
  ])

  // This object exists only below the OS test temp directory. It exercises the
  // parser contract and is not a claim that any real Bun material was curated.
  const curation: CurationManifest = {
    schemaVersion: 1,
    runtime: "bun",
    version: BUN_VERSION,
    revision: BUN_REVISION,
    sourceRepository: "https://github.com/oven-sh/bun",
    sourceRevision: BUN_REVISION,
    completeScope: "license-notice-provenance-for-pinned-runtime",
    curatedAt: PUBLISHED_AT,
    curatedBy: "synthetic deterministic test fixture; not an owner review",
    files: [
      curationFile("LICENSE.fixture.txt", "license", SYNTHETIC_LICENSE),
      curationFile("PROVENANCE.fixture.txt", "provenance", SYNTHETIC_PROVENANCE),
    ],
  }
  await writeJson(curationManifestPath, curation)
  return {
    root,
    curationRoot,
    curationManifestPath,
    curationLicensePath,
    installedManifestPath,
    outputParent,
    workspaceManifestPath,
  }
}

async function createFixtureSbom(
  fixture: ReleaseFixture,
  embeddedBun = true,
): Promise<CycloneDxBom> {
  return createReleaseSbom({
    projectRoot: fixture.root,
    version: APPLICATION_VERSION,
    licenseExpression: "MIT",
    publishedAt: PUBLISHED_AT,
    sourceFingerprintSha256: SOURCE_FINGERPRINT,
    ...(embeddedBun ? { bunRuntime: { version: BUN_VERSION, revision: BUN_REVISION } } : {}),
  })
}

async function materializeFixture(fixture: ReleaseFixture, sbom: CycloneDxBom, outputName: string) {
  const outputDirectory = resolve(fixture.outputParent, outputName)
  const receipt = await materializeReleaseLicenseInventory({
    projectRoot: fixture.root,
    sbom,
    sbomSha256: serializedSbomSha256(sbom),
    publishedAt: PUBLISHED_AT,
    outputDirectory,
    bunRuntime: { version: BUN_VERSION, revision: BUN_REVISION },
  })
  return { outputDirectory, receipt }
}

async function readCurationManifest(fixture: ReleaseFixture): Promise<CurationManifest> {
  return JSON.parse(await readFile(fixture.curationManifestPath, "utf8")) as CurationManifest
}

async function mutateCurationManifest(
  fixture: ReleaseFixture,
  mutate: (manifest: CurationManifest) => void,
): Promise<void> {
  const manifest = await readCurationManifest(fixture)
  mutate(manifest)
  await writeJson(fixture.curationManifestPath, manifest)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("release SBOM and license inventory boundary", () => {
  test("is deterministic and content-addresses every copied license/provenance file", async () => {
    const fixture = await createReleaseFixture()
    const firstSbom = await createFixtureSbom(fixture)
    const secondSbom = await createFixtureSbom(fixture)

    expect(secondSbom).toEqual(firstSbom)
    expect(firstSbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/u)
    expect(firstSbom.components.map((component) => component.name)).toEqual([
      DEPENDENCY_NAME,
      "opencode-curated-source",
      "bun-runtime",
    ])
    expect(firstSbom.components[0]?.hashes?.[0]?.content).toBe("0".repeat(128))
    const bunComponent = firstSbom.components.find((component) => component.name === "bun-runtime")
    const bunCurationLicenseExpression = `LicenseRef-Bun-Runtime-Curation-${sha256(
      await readFile(fixture.curationManifestPath),
    )}`
    expect(bunComponent).toMatchObject({
      type: "application",
      "bom-ref": `runtime:bun@${BUN_VERSION}#${BUN_REVISION}`,
      version: BUN_VERSION,
      licenses: [
        {
          expression: bunCurationLicenseExpression,
        },
      ],
    })
    expect(bunComponent?.properties).toContainEqual({
      name: "ralph:bun-runtime-revision",
      value: BUN_REVISION,
    })
    expect(firstSbom.dependencies[0]?.dependsOn).toContain(
      `runtime:bun@${BUN_VERSION}#${BUN_REVISION}`,
    )
    expect(firstSbom.metadata.properties).toContainEqual({
      name: "ralph:bun-runtime-distribution",
      value: "embedded-and-locally-curated",
    })

    const first = await materializeFixture(fixture, firstSbom, "inventory-one")
    const second = await materializeFixture(fixture, secondSbom, "inventory-two")
    const firstManifestBytes = await readFile(first.receipt.manifestPath)
    const secondManifestBytes = await readFile(second.receipt.manifestPath)

    expect(second.receipt.manifestSha256).toBe(first.receipt.manifestSha256)
    expect(second.receipt.totalBytes).toBe(first.receipt.totalBytes)
    expect(second.receipt.totalFiles).toBe(first.receipt.totalFiles)
    expect(first.receipt.totalFiles).toBe(9)
    expect(first.receipt.manifestSha256).toBe(sha256(firstManifestBytes))
    expect(secondManifestBytes).toEqual(firstManifestBytes)

    const manifest = JSON.parse(firstManifestBytes.toString("utf8")) as InventoryManifest
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      publishedAt: PUBLISHED_AT,
      sbomSha256: serializedSbomSha256(firstSbom),
    })
    expect(manifest.components.map((component) => component.sourceKind).sort()).toEqual([
      "bun-runtime",
      "bun-store",
      "curated-source",
    ])
    expect(
      manifest.components.find((component) => component.sourceKind === "bun-runtime"),
    ).toMatchObject({
      bomRef: `runtime:bun@${BUN_VERSION}#${BUN_REVISION}`,
      licenseExpression: bunCurationLicenseExpression,
    })
    expect(
      manifest.components
        .find((component) => component.sourceKind === "curated-source")
        ?.files.some((file) => file.path.endsWith("/PROVENANCE.json")),
    ).toBe(true)
    const materializedFiles = manifest.components.flatMap((component) => component.files)
    expect(materializedFiles).toHaveLength(first.receipt.totalFiles)
    expect(materializedFiles.reduce((sum, file) => sum + file.sizeBytes, 0)).toBe(
      first.receipt.totalBytes,
    )
    for (const component of manifest.components) {
      for (const file of component.files) {
        const bytes = await readFile(resolve(first.outputDirectory, ...file.path.split("/")))
        expect(bytes.byteLength).toBe(file.sizeBytes)
        expect(sha256(bytes)).toBe(file.sha256)
      }
    }
  })

  test("keeps the npm SBOM and inventory free of embedded Bun claims", async () => {
    const fixture = await createReleaseFixture()
    const sbom = await createFixtureSbom(fixture, false)

    expect(sbom.components.some((component) => component.name === "bun-runtime")).toBe(false)
    expect(
      sbom.dependencies[0]?.dependsOn.some((reference) => reference.startsWith("runtime:bun@")),
    ).toBe(false)
    expect(sbom.metadata.properties).toContainEqual({
      name: "ralph:bun-runtime-distribution",
      value: "not-embedded-host-runtime-required",
    })

    const outputDirectory = resolve(fixture.outputParent, "npm-inventory")
    const receipt = await materializeReleaseLicenseInventory({
      projectRoot: fixture.root,
      sbom,
      sbomSha256: serializedSbomSha256(sbom),
      publishedAt: PUBLISHED_AT,
      outputDirectory,
    })
    const manifest = JSON.parse(await readFile(receipt.manifestPath, "utf8")) as InventoryManifest
    expect(receipt.totalFiles).toBe(6)
    expect(manifest.components.some((component) => component.sourceKind === "bun-runtime")).toBe(
      false,
    )
  })

  test("requires Bun curation before constructing a standalone SBOM", async () => {
    const fixture = await createReleaseFixture()
    await rm(fixture.curationRoot, { recursive: true, force: true })

    await expect(createFixtureSbom(fixture)).rejects.toThrow(
      "curate the exact Bun runtime license/provenance bundle",
    )
  })

  test("rejects a standalone Bun binding without an exact lowercase commit revision", async () => {
    const fixture = await createReleaseFixture()

    await expect(
      createReleaseSbom({
        projectRoot: fixture.root,
        version: APPLICATION_VERSION,
        licenseExpression: "MIT",
        publishedAt: PUBLISHED_AT,
        sourceFingerprintSha256: SOURCE_FINGERPRINT,
        bunRuntime: { version: BUN_VERSION, revision: "A".repeat(40) },
      }),
    ).rejects.toThrow("exact SemVer and lowercase 40-hex revision")
  })

  test("rejects missing, extra or mismatched Bun SBOM correspondence", async () => {
    const fixture = await createReleaseFixture()
    const standaloneSbom = await createFixtureSbom(fixture)
    const npmSbom = await createFixtureSbom(fixture, false)

    await expect(materializeFixture(fixture, npmSbom, "missing-bun-component")).rejects.toThrow(
      "Bun component does not exactly match validated local curation",
    )

    await expect(
      materializeReleaseLicenseInventory({
        projectRoot: fixture.root,
        sbom: standaloneSbom,
        sbomSha256: serializedSbomSha256(standaloneSbom),
        publishedAt: PUBLISHED_AT,
        outputDirectory: resolve(fixture.outputParent, "extra-bun-component"),
      }),
    ).rejects.toThrow("npm release SBOM must not claim an embedded Bun runtime")

    const mismatchedSbom: CycloneDxBom = {
      ...standaloneSbom,
      components: standaloneSbom.components.map((component) =>
        component.name === "bun-runtime"
          ? {
              ...component,
              properties: (component.properties ?? []).map((property) =>
                property.name === "ralph:bun-runtime-revision"
                  ? { ...property, value: "d".repeat(40) }
                  : property,
              ),
            }
          : component,
      ),
    }
    await expect(
      materializeFixture(fixture, mismatchedSbom, "mismatched-bun-component"),
    ).rejects.toThrow("Bun component does not exactly match validated local curation")
  })

  test("rejects a standalone root graph that omits the embedded Bun edge", async () => {
    const fixture = await createReleaseFixture()
    const sbom = await createFixtureSbom(fixture)
    const bunReference = `runtime:bun@${BUN_VERSION}#${BUN_REVISION}`
    const invalidSbom: CycloneDxBom = {
      ...sbom,
      dependencies: sbom.dependencies.map((dependency) => ({
        ...dependency,
        dependsOn: dependency.dependsOn.filter((reference) => reference !== bunReference),
      })),
    }

    await expect(materializeFixture(fixture, invalidSbom, "missing-bun-edge")).rejects.toThrow(
      "root dependency graph does not exactly match declared runtime components",
    )
  })

  test("blocks a missing Bun runtime curation directory", async () => {
    const fixture = await createReleaseFixture()
    const sbom = await createFixtureSbom(fixture)
    await rm(fixture.curationRoot, { recursive: true, force: true })

    await expect(materializeFixture(fixture, sbom, "missing-curation")).rejects.toThrow(
      "curate the exact Bun runtime license/provenance bundle",
    )
  })

  test("rejects an extra unmanifested Bun curation file", async () => {
    const fixture = await createReleaseFixture()
    const sbom = await createFixtureSbom(fixture)
    await writeText(resolve(fixture.curationRoot, "EXTRA.txt"), "not declared\n")

    await expect(materializeFixture(fixture, sbom, "extra-curation")).rejects.toThrow(
      "missing, extra or unmanifested files",
    )
  })

  test("rejects a symlink inside Bun curation", async () => {
    const fixture = await createReleaseFixture()
    const sbom = await createFixtureSbom(fixture)
    const target = resolve(fixture.root, "outside-curation")
    await mkdir(target)
    await symlink(
      target,
      resolve(fixture.curationRoot, "linked-directory"),
      process.platform === "win32" ? "junction" : "dir",
    )

    await expect(materializeFixture(fixture, sbom, "symlink-curation")).rejects.toThrow(
      "Bun runtime curation rejects symlinks",
    )
  })

  test("rejects Bun curation content tampered after its receipt was written", async () => {
    const fixture = await createReleaseFixture()
    const sbom = await createFixtureSbom(fixture)
    await writeText(fixture.curationLicensePath, "fixture-license-v2\n")

    await expect(materializeFixture(fixture, sbom, "tampered-curation")).rejects.toThrow(
      "does not match its receipt",
    )
  })

  test("rejects a false Bun curation SHA-256 receipt", async () => {
    const fixture = await createReleaseFixture()
    const sbom = await createFixtureSbom(fixture)
    await mutateCurationManifest(fixture, (manifest) => {
      const license = manifest.files.find((file) => file.kind === "license")
      if (!license) throw new Error("Fixture lost its synthetic license")
      license.sha256 = "f".repeat(64)
    })

    await expect(materializeFixture(fixture, sbom, "hash-curation")).rejects.toThrow(
      "does not match its receipt",
    )
  })

  test("rejects a false Bun curation size receipt", async () => {
    const fixture = await createReleaseFixture()
    const sbom = await createFixtureSbom(fixture)
    await mutateCurationManifest(fixture, (manifest) => {
      const license = manifest.files.find((file) => file.kind === "license")
      if (!license) throw new Error("Fixture lost its synthetic license")
      license.sizeBytes += 1
    })

    await expect(materializeFixture(fixture, sbom, "size-curation")).rejects.toThrow(
      "does not match its receipt",
    )
  })

  test("rejects Bun curation bound to a different runtime revision", async () => {
    const fixture = await createReleaseFixture()
    const sbom = await createFixtureSbom(fixture)
    await mutateCurationManifest(fixture, (manifest) => {
      manifest.revision = "d".repeat(40)
    })

    await expect(materializeFixture(fixture, sbom, "revision-curation")).rejects.toThrow(
      "does not bind the exact runtime/version/revision and complete scope",
    )
  })

  test("rejects absent dependency license metadata at SBOM and inventory boundaries", async () => {
    const sbomFixture = await createReleaseFixture()
    await writeJson(sbomFixture.installedManifestPath, {
      name: DEPENDENCY_NAME,
      version: DEPENDENCY_VERSION,
    })
    await expect(createFixtureSbom(sbomFixture)).rejects.toThrow(
      "Dependency has no explicit installed license metadata",
    )

    const inventoryFixture = await createReleaseFixture()
    const validSbom = await createFixtureSbom(inventoryFixture)
    const invalidSbom: CycloneDxBom = {
      ...validSbom,
      components: validSbom.components.map((component) =>
        component.name === DEPENDENCY_NAME ? { ...component, licenses: [] } : component,
      ),
    }
    await expect(
      materializeReleaseLicenseInventory({
        projectRoot: inventoryFixture.root,
        sbom: invalidSbom,
        sbomSha256: serializedSbomSha256(invalidSbom),
        publishedAt: PUBLISHED_AT,
        outputDirectory: resolve(inventoryFixture.outputParent, "missing-component-license"),
        bunRuntime: { version: BUN_VERSION, revision: BUN_REVISION },
      }),
    ).rejects.toThrow("SBOM component must declare exactly one license expression")
  })

  test("rejects a source workspace that diverges from bun.lock", async () => {
    const fixture = await createReleaseFixture()
    await writeJson(fixture.workspaceManifestPath, {
      name: "ralph-next",
      version: APPLICATION_VERSION,
      dependencies: { [DEPENDENCY_NAME]: `^${DEPENDENCY_VERSION}` },
    })

    await expect(createFixtureSbom(fixture)).rejects.toThrow(
      "Source workspace differs from bun.lock; regenerate the lockfile before release",
    )
  })
})
