import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readdir, rename, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import {
  assertNpmReleaseBinding,
  assertNpmReleasePromotionBinding,
  assertReleaseDistTag,
  assertReleaseVersionChannel,
  canonicalNpmReleaseBindingSigningBytes,
  type NpmPromotionCandidateBinding,
  type NpmReleaseBinding,
  NpmReleaseBindingSchema,
  npmReleaseBindingSigningSha256,
  type ReleaseChannel,
  ReleaseChannelSchema,
  type ReleaseDistTag,
  ReleaseDistTagSchema,
  ReleaseSbomSchema,
} from "@ralph/distribution"
import { TwoPhaseShutdownController } from "@ralph/supervisor"
import packageJson from "../package.json" with { type: "json" }
import { BundleBuildMetadataSchema, sha256File, validateBundleArtifact } from "./build-artifact"
import { PUBLIC_SCHEMA_DEFINITIONS, publicSchemaMismatches } from "./generate-schemas"
import { createDeterministicTar } from "./release-archive"
import {
  readStableJsonInput,
  readStandaloneCandidateReceipt,
  type StableJsonInput,
  type StandaloneCandidateInput,
} from "./release-candidate-input"
import {
  assertRegularReleaseFile,
  copyRegularDirectoryVerified,
  copyRegularVerified,
  prepareManagedReleaseDirectory,
  removeManagedReleaseOperation,
  resolveManagedReleaseDestination,
  type VerifiedFileReceipt,
} from "./release-files"
import { createDeterministicGzip } from "./release-gzip"
import { materializeReleaseLicenseInventory } from "./release-licenses"
import { compareUtf8Bytes } from "./release-order"
import { createReleaseSbom } from "./release-sbom"
import {
  assertReleaseSignatureReceipt,
  invokeReleaseSubjectSigner,
  loadReleaseSignerConfiguration,
  type ReleaseSignatureReceipt,
} from "./release-signer"
import { verifyReleaseGitSource } from "./release-source"

type NpmPackageArguments = {
  readonly packageName: string
  readonly channel: ReleaseChannel
  readonly distTag: ReleaseDistTag
  readonly sourceRepository: string
  readonly sourceCommit: string
  readonly publishedAt: string
  readonly outputDirectory: string
  readonly signatureConfigPath?: string
  readonly signatureUnavailableReason?: string
  readonly promotionRecordPath?: string
  readonly releaseCandidateReceiptPath?: string
  readonly candidateOnly: boolean
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

type BoundFile = {
  readonly path: string
  readonly sha256: string
  readonly sizeBytes: number
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function parseArguments(argv: readonly string[], projectRoot: string): NpmPackageArguments {
  let packageName: string | undefined
  let channel: ReleaseChannel | undefined
  let distTag: ReleaseDistTag | undefined
  let sourceRepository: string | undefined
  let sourceCommit: string | undefined
  let publishedAt: string | undefined
  let outputDirectory: string | undefined
  let signatureConfigPath: string | undefined
  let signatureUnavailableReason: string | undefined
  let promotionRecordPath: string | undefined
  let releaseCandidateReceiptPath: string | undefined
  let candidateOnly = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--package-name") {
      packageName = valueAfter(argv, index, flag)
      index += 1
      continue
    }
    if (flag === "--channel") {
      const value = valueAfter(argv, index, flag)
      const parsedChannel = ReleaseChannelSchema.safeParse(value)
      if (!parsedChannel.success) throw new Error(`Unsupported release channel: ${value}`)
      channel = parsedChannel.data
      index += 1
      continue
    }
    if (flag === "--dist-tag") {
      const value = valueAfter(argv, index, flag)
      const parsedDistTag = ReleaseDistTagSchema.safeParse(value)
      if (!parsedDistTag.success) throw new Error(`Unsupported npm dist-tag: ${value}`)
      distTag = parsedDistTag.data
      index += 1
      continue
    }
    if (flag === "--source-repository") {
      sourceRepository = valueAfter(argv, index, flag)
      index += 1
      continue
    }
    if (flag === "--source-commit") {
      sourceCommit = valueAfter(argv, index, flag).toLowerCase()
      index += 1
      continue
    }
    if (flag === "--published-at") {
      publishedAt = valueAfter(argv, index, flag)
      index += 1
      continue
    }
    if (flag === "--output") {
      outputDirectory = valueAfter(argv, index, flag)
      index += 1
      continue
    }
    if (flag === "--signature-config") {
      signatureConfigPath = resolve(valueAfter(argv, index, flag))
      index += 1
      continue
    }
    if (flag === "--signature-unavailable-reason") {
      signatureUnavailableReason = valueAfter(argv, index, flag)
      index += 1
      continue
    }
    if (flag === "--promotion-record") {
      promotionRecordPath = resolve(valueAfter(argv, index, flag))
      index += 1
      continue
    }
    if (flag === "--release-candidate-receipt") {
      releaseCandidateReceiptPath = resolve(valueAfter(argv, index, flag))
      index += 1
      continue
    }
    if (flag === "--candidate-only") {
      if (candidateOnly) throw new Error("--candidate-only can be specified only once")
      candidateOnly = true
      continue
    }
    throw new Error(`Unknown npm packaging argument: ${flag ?? "<missing>"}`)
  }
  if (
    !packageName ||
    packageName.length > 214 ||
    !PACKAGE_NAME_PATTERN.test(packageName) ||
    packageName.includes("..")
  ) {
    throw new Error("--package-name must be an explicit lowercase npm package name")
  }
  if (!channel) throw new Error("--channel is required")
  if (!distTag) throw new Error("--dist-tag is required")
  if (!sourceRepository) throw new Error("--source-repository is required")
  const repository = new URL(sourceRepository)
  if (
    repository.protocol !== "https:" ||
    repository.username ||
    repository.password ||
    repository.search ||
    repository.hash
  ) {
    throw new Error("--source-repository must be HTTPS without credentials, query or fragment")
  }
  if (!sourceCommit || !COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("--source-commit must be a full lowercase 40-character Git commit")
  }
  if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) {
    throw new Error("--published-at must be an ISO-8601 timestamp")
  }
  const canonicalPublishedAt = new Date(publishedAt).toISOString()
  if (candidateOnly) {
    if (channel !== "stable") {
      throw new Error("--candidate-only is reserved for the first pass of a stable npm promotion")
    }
    if (
      promotionRecordPath ||
      releaseCandidateReceiptPath ||
      signatureConfigPath ||
      signatureUnavailableReason !== undefined
    ) {
      throw new Error("--candidate-only cannot be combined with promotion or signature options")
    }
    if (Date.parse(canonicalPublishedAt) <= Date.now() + 5 * 60_000) {
      throw new Error(
        "--candidate-only requires a fixed --published-at more than five minutes in the future",
      )
    }
  } else {
    if (signatureConfigPath && signatureUnavailableReason !== undefined) {
      throw new Error("Use either --signature-config or --signature-unavailable-reason, never both")
    }
    if (!signatureConfigPath && signatureUnavailableReason === undefined) {
      throw new Error("Use exactly one of --signature-config or --signature-unavailable-reason")
    }
  }
  if (
    signatureUnavailableReason !== undefined &&
    (signatureUnavailableReason.trim().length === 0 ||
      signatureUnavailableReason.trim().length > 1_000 ||
      containsAsciiControlCharacter(signatureUnavailableReason))
  ) {
    throw new Error("--signature-unavailable-reason must be a bounded non-control explanation")
  }
  if (channel === "stable" && !candidateOnly && !promotionRecordPath) {
    throw new Error("Stable npm packaging requires --promotion-record for the exact tarball")
  }
  if (Boolean(promotionRecordPath) !== Boolean(releaseCandidateReceiptPath)) {
    throw new Error("--promotion-record and --release-candidate-receipt must be supplied together")
  }
  if (channel === "stable" && !candidateOnly && !signatureConfigPath) {
    throw new Error(
      "Stable npm packaging requires --signature-config and a detached binding signature",
    )
  }
  if ((channel === "dev" || channel === "nightly") && promotionRecordPath) {
    throw new Error("npm promotion records are accepted only for beta or stable channels")
  }
  if (channel === "dev" && signatureConfigPath) {
    throw new Error("Dev is a source-checkout channel; npm detached signing starts at nightly")
  }
  const npmBase = resolve(projectRoot, "dist", "npm")
  const safeName = packageName.replace(/^@/u, "").replaceAll("/", "-")
  const output = resolve(
    outputDirectory ?? npmBase,
    `${safeName}-${packageJson.version}${candidateOnly ? "-candidate" : ""}`,
  )
  if (!inside(npmBase, output)) throw new Error(`npm package output must remain below ${npmBase}`)
  return {
    packageName,
    channel,
    distTag,
    sourceRepository: repository.toString(),
    sourceCommit,
    publishedAt: canonicalPublishedAt,
    outputDirectory: output,
    ...(signatureConfigPath ? { signatureConfigPath } : {}),
    ...(signatureUnavailableReason !== undefined
      ? { signatureUnavailableReason: signatureUnavailableReason.trim() }
      : {}),
    ...(promotionRecordPath ? { promotionRecordPath } : {}),
    ...(releaseCandidateReceiptPath ? { releaseCandidateReceiptPath } : {}),
    candidateOnly,
  }
}

async function assertRegular(path: string, label: string): Promise<void> {
  await assertRegularReleaseFile(path, label)
}

async function copyRegular(
  source: string,
  destination: string,
  executable = false,
  expectedSha256?: string,
): Promise<VerifiedFileReceipt> {
  return copyRegularVerified(source, destination, {
    executable,
    ...(expectedSha256 ? { expectedSha256 } : {}),
  })
}

async function copyRegularDirectory(
  source: string,
  destination: string,
  label: string,
): Promise<void> {
  try {
    await copyRegularDirectoryVerified(source, destination)
  } catch (error) {
    throw new Error(`${label} could not be copied as a verified regular directory`, {
      cause: error,
    })
  }
}

async function collectFiles(root: string, current = root): Promise<string[]> {
  const output: string[] = []
  const entries = await readdir(current, { withFileTypes: true })
  entries.sort((left, right) => compareUtf8Bytes(left.name, right.name))
  for (const entry of entries) {
    const path = resolve(current, entry.name)
    if (!inside(root, path)) throw new Error(`npm payload escapes package root: ${path}`)
    const information = await lstat(path)
    if (information.isSymbolicLink())
      throw new Error(`npm package cannot contain symlinks: ${path}`)
    if (information.isDirectory()) output.push(...(await collectFiles(root, path)))
    else if (information.isFile()) output.push(path)
    else throw new Error(`npm package accepts regular files only: ${path}`)
  }
  return output
}

async function boundFile(path: string, bindingPath: string): Promise<BoundFile> {
  const information = await lstat(path)
  if (!information.isFile() || information.isSymbolicLink() || information.size <= 0) {
    throw new Error(`npm release binding requires a non-empty regular file: ${path}`)
  }
  return {
    path: bindingPath,
    sha256: await sha256File(path),
    sizeBytes: information.size,
  }
}

async function writeBoundJson(
  path: string,
  bindingPath: string,
  value: unknown,
): Promise<BoundFile> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
  await chmod(path, 0o644)
  const receipt = await boundFile(path, bindingPath)
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex")
  if (receipt.sizeBytes !== bytes.byteLength || receipt.sha256 !== expectedSha256) {
    throw new Error(`npm JSON sidecar changed while it was written: ${path}`)
  }
  return receipt
}

async function assertBoundPayloads(
  resultDirectory: string,
  files: readonly BoundFile[],
): Promise<void> {
  for (const file of files) {
    const path = resolve(resultDirectory, file.path)
    if (!inside(resultDirectory, path)) {
      throw new Error(`npm release binding payload escaped result root: ${file.path}`)
    }
    const information = await lstat(path)
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.size !== file.sizeBytes ||
      (await sha256File(path)) !== file.sha256
    ) {
      throw new Error(`npm release binding payload changed before package commit: ${file.path}`)
    }
  }
}

async function assertExactResultInventory(
  resultDirectory: string,
  expectedPaths: ReadonlySet<string>,
): Promise<void> {
  const actualPaths = new Set(
    (await collectFiles(resultDirectory)).map((path) => portable(relative(resultDirectory, path))),
  )
  if (
    actualPaths.size !== expectedPaths.size ||
    [...actualPaths].some((path) => !expectedPaths.has(path))
  ) {
    throw new Error("npm result directory contains missing or unbound sidecars")
  }
}

async function readPromotionRecord(path: string, signal: AbortSignal): Promise<StableJsonInput> {
  return readStableJsonInput(path, "npm promotion record", 8 * 1024 * 1024, signal)
}

function assertPackagingActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("npm packaging was cancelled")
}

async function packageNpm(signal: AbortSignal): Promise<void> {
  assertPackagingActive(signal)
  const projectRoot = resolve(import.meta.dir, "..")
  const args = parseArguments(process.argv.slice(2), projectRoot)
  assertReleaseVersionChannel(packageJson.version, args.channel)
  assertReleaseDistTag(args.channel, args.distTag)
  const signerConfiguration = args.signatureConfigPath
    ? await loadReleaseSignerConfiguration(args.signatureConfigPath)
    : undefined
  const rootManifest = packageJson as typeof packageJson & { readonly license?: string }
  if (!rootManifest.license?.trim()) {
    throw new Error("npm packaging is blocked until the owner selects an explicit project license")
  }
  await assertRegular(resolve(projectRoot, "LICENSE"), "Root project LICENSE")
  const verifiedSource = await verifyReleaseGitSource({
    projectRoot,
    expectedRepository: args.sourceRepository,
    expectedCommit: args.sourceCommit,
  })
  assertPackagingActive(signal)
  const bundle = await validateBundleArtifact(resolve(projectRoot, "dist", "ralph.js"), projectRoot)
  assertPackagingActive(signal)
  const safeOutputDirectory = await resolveManagedReleaseDestination({
    trustedRoot: verifiedSource.root,
    allowedBaseSegments: ["dist", "npm"],
    requestedDestination: args.outputDirectory,
  })
  assertPackagingActive(signal)
  const stagingBase = await prepareManagedReleaseDirectory(verifiedSource.root, [
    "dist",
    "npm",
    ".staging",
  ])
  const operationDirectory = resolve(stagingBase, randomUUID())
  if (!inside(stagingBase, operationDirectory)) {
    throw new Error("npm staging operation escaped its base")
  }
  const packageDirectory = resolve(operationDirectory, "archive", "package")
  const resultDirectory = resolve(operationDirectory, "result")
  let committed = false
  try {
    assertPackagingActive(signal)
    await mkdir(packageDirectory, { recursive: true })
    await mkdir(resultDirectory, { recursive: true })
    assertPackagingActive(signal)
    const sourceSha256 = bundle.metadata.sourceSha256
    // A tarball does not know whether npm, pnpm or Bun eventually installs it.
    // Keep ownership unknown so update diagnostics cannot invent a command.
    const wrapperOrigin = JSON.stringify({
      kind: "npm",
      packageName: args.packageName,
      packageManager: "unknown",
    })
    // The generated package is ESM (`type: module`) and Bun supports top-level
    // await. Dynamic import is intentional: it publishes the immutable,
    // diagnostic-only origin before the application bundle runs any side effect.
    const wrapper = `#!/usr/bin/env bun\nglobalThis[Symbol.for("ralph.distribution-origin")] = Object.freeze(${wrapperOrigin})\nawait import("../dist/ralph.js")\n`
    const wrapperPath = resolve(packageDirectory, "bin", "ralph.js")
    await mkdir(dirname(wrapperPath), { recursive: true })
    await writeFile(wrapperPath, wrapper, { encoding: "utf8", flag: "wx", mode: 0o700 })
    await chmod(wrapperPath, 0o755)
    await copyRegular(
      bundle.bundle,
      resolve(packageDirectory, "dist", "ralph.js"),
      false,
      bundle.metadata.sha256,
    )
    const stagedBundleMetadataPath = resolve(packageDirectory, "bundle-build-metadata.json")
    const stagedBundleMetadataReceipt = await copyRegular(
      bundle.metadataPath,
      stagedBundleMetadataPath,
    )
    const copiedBundleMetadata = BundleBuildMetadataSchema.parse(
      JSON.parse(await Bun.file(stagedBundleMetadataPath).text()),
    )
    if (JSON.stringify(copiedBundleMetadata) !== JSON.stringify(bundle.metadata)) {
      throw new Error("Copied bundle build metadata changed after validation")
    }

    for (const file of [
      "AGENTS.md",
      "CHANGELOG.md",
      "DEVELOPMENT.md",
      "LICENSE",
      "PRD.md",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
    ] as const) {
      assertPackagingActive(signal)
      await copyRegular(resolve(projectRoot, file), resolve(packageDirectory, file))
    }
    for (const directory of ["docs", "examples", "implementation", "skill-contract"] as const) {
      assertPackagingActive(signal)
      await copyRegularDirectory(
        resolve(projectRoot, directory),
        resolve(packageDirectory, directory),
        `Release documentation (${directory})`,
      )
    }
    for (const project of ["opencode", "opentui", "solid-js"] as const) {
      assertPackagingActive(signal)
      await copyRegular(
        resolve(projectRoot, "third_party", project, "LICENSE"),
        resolve(packageDirectory, "third_party", project, "LICENSE"),
      )
    }
    for (const file of [
      "PROVENANCE.json",
      "UPSTREAM.md",
      "copied-files.md",
      "patches.md",
    ] as const) {
      assertPackagingActive(signal)
      await copyRegular(
        resolve(projectRoot, "third_party", "opencode", file),
        resolve(packageDirectory, "third_party", "opencode", file),
      )
    }
    const schemasDirectory = resolve(projectRoot, "schemas")
    assertPackagingActive(signal)
    const schemaMismatches = await publicSchemaMismatches(schemasDirectory)
    if (schemaMismatches.length > 0) {
      throw new Error(
        `npm packaging requires exactly ${PUBLIC_SCHEMA_DEFINITIONS.length} current generated JSON Schemas; generation is a separate explicit step:\n${schemaMismatches.map((path) => `- ${path}`).join("\n")}`,
      )
    }
    assertPackagingActive(signal)
    await copyRegularDirectory(
      schemasDirectory,
      resolve(packageDirectory, "schemas"),
      "Generated schemas",
    )
    await copyRegularDirectory(
      resolve(projectRoot, "skills", "ralph-loop-prd-generator"),
      resolve(packageDirectory, "skills", "ralph-loop-prd-generator"),
      "PRD generator skill",
    )

    assertPackagingActive(signal)
    const sbom = await createReleaseSbom({
      projectRoot,
      applicationName: args.packageName,
      version: packageJson.version,
      licenseExpression: rootManifest.license.trim(),
      publishedAt: args.publishedAt,
      sourceFingerprintSha256: sourceSha256,
    })
    ReleaseSbomSchema.parse(sbom)
    const sbomPath = resolve(packageDirectory, "SBOM.cdx.json")
    await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await chmod(sbomPath, 0o644)
    const sbomSha256 = await sha256File(sbomPath)
    await materializeReleaseLicenseInventory({
      projectRoot,
      sbom,
      sbomSha256,
      publishedAt: args.publishedAt,
      outputDirectory: resolve(packageDirectory, "third_party", "licenses"),
    })

    assertPackagingActive(signal)
    const generatedManifest = {
      name: args.packageName,
      version: packageJson.version,
      description: "Command-authoritative AI task runner for vertical-slice PRDs",
      license: rootManifest.license.trim(),
      type: "module",
      bin: { ralph: "bin/ralph.js" },
      engines: { bun: ">=1.3.14" },
      files: [
        "bin",
        "dist",
        "docs",
        "examples",
        "implementation",
        "schemas",
        "skill-contract",
        "skills",
        "third_party",
        "AGENTS.md",
        "DEVELOPMENT.md",
        "LICENSE",
        "PRD.md",
        "THIRD_PARTY_NOTICES.md",
        "README.md",
        "CHANGELOG.md",
        "bundle-build-metadata.json",
        "SBOM.cdx.json",
        "PROVENANCE.json",
        "SHA256SUMS",
      ],
      repository: { type: "git", url: verifiedSource.repository },
      publishConfig: {
        tag: args.distTag,
        ...(args.packageName.startsWith("@") ? { access: "public" } : {}),
      },
    }
    const packageManifestPath = resolve(packageDirectory, "package.json")
    await writeFile(packageManifestPath, `${JSON.stringify(generatedManifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await chmod(packageManifestPath, 0o644)
    const provenancePath = resolve(packageDirectory, "PROVENANCE.json")
    await writeFile(
      provenancePath,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          product: "ralph",
          packageName: args.packageName,
          version: packageJson.version,
          channel: args.channel,
          distTag: args.distTag,
          source: {
            repository: verifiedSource.repository,
            commit: verifiedSource.commit,
            fingerprintSha256: sourceSha256,
          },
          bundle: {
            path: "dist/ralph.js",
            sha256: bundle.metadata.sha256,
            buildMetadataSha256: stagedBundleMetadataReceipt.sha256,
          },
          evidenceStatus: "candidate-only",
          publicationStatus: "non-publishable-without-valid-external-binding",
          packagedAt: args.publishedAt,
          externalBinding: {
            schemaVersion: 1,
            status: "required",
            subject: "npm-package",
            reason:
              "The final tarball digest, promotion evidence and detached signature are bound by npm-release-binding.json beside the tarball to avoid a self-referential archive hash.",
          },
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    )
    await chmod(provenancePath, 0o644)

    assertPackagingActive(signal)
    const checksumInputs = (await collectFiles(packageDirectory)).filter(
      (path) => portable(relative(packageDirectory, path)) !== "SHA256SUMS",
    )
    const checksumLines: string[] = []
    const checksumReceipts: { readonly path: string; readonly sha256: string }[] = []
    for (const path of checksumInputs) {
      assertPackagingActive(signal)
      const sha256 = await sha256File(path)
      checksumReceipts.push({ path, sha256 })
      checksumLines.push(`${sha256}  ${portable(relative(packageDirectory, path))}`)
    }
    checksumLines.sort(compareUtf8Bytes)
    const checksumsPath = resolve(packageDirectory, "SHA256SUMS")
    await writeFile(checksumsPath, `${checksumLines.join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await chmod(checksumsPath, 0o644)
    const checksumsSha256 = await sha256File(checksumsPath)

    const safeName = args.packageName.replace(/^@/u, "").replaceAll("/", "-")
    const tarPath = resolve(operationDirectory, `${safeName}-${packageJson.version}.tar`)
    const tgzName = `${safeName}-${packageJson.version}.tgz`
    const tgzPath = resolve(resultDirectory, tgzName)
    for (const receipt of checksumReceipts) {
      assertPackagingActive(signal)
      if ((await sha256File(receipt.path)) !== receipt.sha256) {
        throw new Error(`npm payload changed after SHA256SUMS was created: ${receipt.path}`)
      }
    }
    if ((await sha256File(checksumsPath)) !== checksumsSha256) {
      throw new Error("npm SHA256SUMS changed before archive creation")
    }
    const archiveRoot = resolve(operationDirectory, "archive")
    const expectedArchiveReceipts = Object.create(null) as Record<string, string>
    expectedArchiveReceipts["package/SHA256SUMS"] = checksumsSha256
    for (const receipt of checksumReceipts) {
      const relativePath = portable(relative(packageDirectory, receipt.path))
      expectedArchiveReceipts[`package/${relativePath}`] = receipt.sha256
    }
    assertPackagingActive(signal)
    await createDeterministicTar(
      archiveRoot,
      tarPath,
      Math.floor(Date.parse(args.publishedAt) / 1000),
      {
        executablePaths: ["package/bin/ralph.js"],
        expectedSha256ByPath: expectedArchiveReceipts,
      },
    )
    assertPackagingActive(signal)
    await createDeterministicGzip(tarPath, tgzPath)
    assertPackagingActive(signal)
    const packageCopy = resolve(resultDirectory, "package")
    await rename(packageDirectory, packageCopy)
    const expectedArchivePaths = new Set(Object.keys(expectedArchiveReceipts))
    const assertExactPackageArchiveBinding = async (): Promise<void> => {
      assertPackagingActive(signal)
      const actualArchivePaths = new Set(
        (await collectFiles(packageCopy)).map(
          (path) => `package/${portable(relative(packageCopy, path))}`,
        ),
      )
      if (
        actualArchivePaths.size !== expectedArchivePaths.size ||
        [...actualArchivePaths].some((path) => !expectedArchivePaths.has(path))
      ) {
        throw new Error("npm unpacked package inventory differs from the tar receipt")
      }
      for (const [archivePath, sha256] of Object.entries(expectedArchiveReceipts)) {
        assertPackagingActive(signal)
        if (!archivePath.startsWith("package/")) {
          throw new Error(`npm archive receipt escaped package prefix: ${archivePath}`)
        }
        const relativePath = archivePath.slice("package/".length)
        if ((await sha256File(resolve(packageCopy, relativePath))) !== sha256) {
          throw new Error(`npm unpacked package differs from tar receipt: ${relativePath}`)
        }
      }
      const settledArchivePaths = new Set(
        (await collectFiles(packageCopy)).map(
          (path) => `package/${portable(relative(packageCopy, path))}`,
        ),
      )
      if (
        settledArchivePaths.size !== expectedArchivePaths.size ||
        [...settledArchivePaths].some((path) => !expectedArchivePaths.has(path))
      ) {
        throw new Error("npm unpacked package inventory changed while receipts were checked")
      }
    }
    await assertExactPackageArchiveBinding()
    const packageIdentity = {
      name: args.packageName,
      version: packageJson.version,
      channel: args.channel,
      distTag: args.distTag,
    } as const
    const sourceBinding = {
      repository: verifiedSource.repository,
      commit: verifiedSource.commit,
      fingerprintSha256: sourceSha256,
    } as const
    const artifactBinding = {
      tarball: await boundFile(tgzPath, tgzName),
      packageManifest: await boundFile(
        resolve(packageCopy, "package.json"),
        "package/package.json",
      ),
      bundle: await boundFile(resolve(packageCopy, "dist", "ralph.js"), "package/dist/ralph.js"),
      buildMetadata: await boundFile(
        resolve(packageCopy, "bundle-build-metadata.json"),
        "package/bundle-build-metadata.json",
      ),
      checksums: await boundFile(resolve(packageCopy, "SHA256SUMS"), "package/SHA256SUMS"),
    } as const
    const supportBinding = {
      sbom: await boundFile(resolve(packageCopy, "SBOM.cdx.json"), "package/SBOM.cdx.json"),
      provenance: await boundFile(
        resolve(packageCopy, "PROVENANCE.json"),
        "package/PROVENANCE.json",
      ),
      license: await boundFile(resolve(packageCopy, "LICENSE"), "package/LICENSE"),
      thirdPartyNotices: await boundFile(
        resolve(packageCopy, "THIRD_PARTY_NOTICES.md"),
        "package/THIRD_PARTY_NOTICES.md",
      ),
    } as const
    const promotionCandidateBase = {
      package: packageIdentity,
      source: sourceBinding,
      artifact: artifactBinding,
      support: supportBinding,
      publishedAt: args.publishedAt,
    } as const
    if (args.candidateOnly) {
      assertPackagingActive(signal)
      const candidatePath = resolve(resultDirectory, "npm-candidate-receipt.json")
      const candidateReceipt = await writeBoundJson(candidatePath, "npm-candidate-receipt.json", {
        schemaVersion: 1,
        product: "ralph",
        subject: "npm-package-candidate",
        status: "candidate-only",
        publishable: false,
        reason:
          "This first-pass stable candidate has no promotion record, release binding or detached signature and must not be published.",
        package: packageIdentity,
        publishedAt: args.publishedAt,
        source: sourceBinding,
        artifact: artifactBinding,
        support: supportBinding,
      })
      const packageResultPath = resolve(resultDirectory, "package-result.json")
      const packageResultReceipt = await writeBoundJson(packageResultPath, "package-result.json", {
        schemaVersion: 2,
        status: "candidate-only",
        publishable: false,
        packageName: args.packageName,
        version: packageJson.version,
        channel: args.channel,
        distTag: args.distTag,
        publishedAt: args.publishedAt,
        tarball: artifactBinding.tarball,
        candidate: candidateReceipt,
        binding: { status: "not-created" },
        promotion: { status: "not-created" },
        signature: { status: "not-created" },
        sourceCommit: verifiedSource.commit,
        sourceFingerprintSha256: sourceSha256,
      })
      if (
        (await sha256File(resolve(packageCopy, "bundle-build-metadata.json"))) !==
        stagedBundleMetadataReceipt.sha256
      ) {
        throw new Error("Staged bundle build metadata changed before npm candidate commit")
      }
      await verifyReleaseGitSource({
        projectRoot,
        expectedRepository: verifiedSource.repository,
        expectedCommit: verifiedSource.commit,
      })
      assertPackagingActive(signal)
      const recheckedOutputDirectory = await resolveManagedReleaseDestination({
        trustedRoot: verifiedSource.root,
        allowedBaseSegments: ["dist", "npm"],
        requestedDestination: args.outputDirectory,
      })
      if (recheckedOutputDirectory !== safeOutputDirectory) {
        throw new Error("npm candidate destination changed during packaging")
      }
      await assertExactPackageArchiveBinding()
      await assertBoundPayloads(resultDirectory, [
        ...Object.values(artifactBinding),
        ...Object.values(supportBinding),
        candidateReceipt,
        packageResultReceipt,
      ])
      await assertExactResultInventory(
        resultDirectory,
        new Set([
          ...expectedArchivePaths,
          tgzName,
          candidateReceipt.path,
          packageResultReceipt.path,
        ]),
      )
      if (Date.parse(args.publishedAt) <= Date.now() + 5 * 60_000) {
        throw new Error(
          "npm candidate creation consumed its evidence window; choose a later --published-at",
        )
      }
      assertPackagingActive(signal)
      await rename(resultDirectory, safeOutputDirectory)
      committed = true
      await removeManagedReleaseOperation(stagingBase, operationDirectory).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(`ralph npm candidate: committed with stale staging (${message})\n`)
        },
      )
      process.stdout.write(
        `${JSON.stringify({
          status: "candidate-only",
          publishable: false,
          packageName: args.packageName,
          version: packageJson.version,
          channel: args.channel,
          distTag: args.distTag,
          output: safeOutputDirectory,
          tarball: resolve(safeOutputDirectory, tgzName),
          candidate: resolve(safeOutputDirectory, candidateReceipt.path),
          binding: "not-created",
          promotion: "not-created",
          signature: "not-created",
        })}\n`,
      )
      return
    }
    let promotionBinding:
      | { readonly path: string; readonly sha256: string; readonly sizeBytes: number }
      | undefined
    let releaseCandidateReceiptBinding:
      | { readonly path: string; readonly sha256: string; readonly sizeBytes: number }
      | undefined
    let validatedPromotionRecord: unknown
    let validatedReleaseCandidateInput: StandaloneCandidateInput | undefined
    let validatedPromotionCandidate: NpmPromotionCandidateBinding | undefined
    if (args.promotionRecordPath) {
      assertPackagingActive(signal)
      if (!args.releaseCandidateReceiptPath) {
        throw new Error(
          "npm promotion requires the independent standalone --release-candidate-receipt",
        )
      }
      const releaseCandidateInput = await readStandaloneCandidateReceipt(
        args.releaseCandidateReceiptPath,
        signal,
      )
      assertPackagingActive(signal)
      const promotionCandidate: NpmPromotionCandidateBinding = {
        ...promotionCandidateBase,
        releaseCandidate: {
          receipt: {
            subject: releaseCandidateInput.receipt.subject,
            path: "standalone-release-candidate-snapshot.json",
            sha256: releaseCandidateInput.sha256,
            sizeBytes: releaseCandidateInput.sizeBytes,
          },
          promotionCandidate: releaseCandidateInput.receipt.promotionCandidate,
        },
        now: new Date().toISOString(),
      }
      const suppliedPromotion = await readPromotionRecord(args.promotionRecordPath, signal)
      assertPackagingActive(signal)
      validatedPromotionRecord = assertNpmReleasePromotionBinding(
        suppliedPromotion.raw,
        promotionCandidate,
      )
      validatedReleaseCandidateInput = releaseCandidateInput
      validatedPromotionCandidate = promotionCandidate
      const copiedReleaseCandidateReceipt = await copyRegularVerified(
        releaseCandidateInput.path,
        resolve(resultDirectory, "standalone-release-candidate-snapshot.json"),
        {
          expectedSha256: releaseCandidateInput.sha256,
          expectedSizeBytes: releaseCandidateInput.sizeBytes,
        },
      )
      releaseCandidateReceiptBinding = {
        path: "standalone-release-candidate-snapshot.json",
        sha256: copiedReleaseCandidateReceipt.sha256,
        sizeBytes: copiedReleaseCandidateReceipt.sizeBytes,
      }
      const promotionPath = resolve(resultDirectory, "npm-promotion-record.json")
      const copiedPromotion = await copyRegularVerified(suppliedPromotion.path, promotionPath, {
        expectedSha256: suppliedPromotion.sha256,
        expectedSizeBytes: suppliedPromotion.sizeBytes,
      })
      promotionBinding = {
        path: "npm-promotion-record.json",
        sha256: copiedPromotion.sha256,
        sizeBytes: copiedPromotion.sizeBytes,
      }
    }

    const evidence =
      promotionBinding && releaseCandidateReceiptBinding
        ? {
            status: "packaged-tested" as const,
            promotion: promotionBinding,
            releaseCandidateReceipt: releaseCandidateReceiptBinding,
          }
        : { status: "packaged-not-tested" as const }
    const bindingBase = {
      schemaVersion: 1,
      product: "ralph",
      subject: "npm-package",
      package: packageIdentity,
      publishedAt: args.publishedAt,
      source: sourceBinding,
      artifact: artifactBinding,
      support: supportBinding,
      evidence,
    } as const
    let signatureReceipt: ReleaseSignatureReceipt | undefined
    let binding: NpmReleaseBinding
    if (signerConfiguration) {
      const signatureRelativePath = `signatures/npm-release-binding.${signerConfiguration.signature.kind}`
      const described = NpmReleaseBindingSchema.parse({
        ...bindingBase,
        signature: {
          status: "present",
          kind: signerConfiguration.signature.kind,
          identity: signerConfiguration.signature.identity,
          signedBindingSha256: "0".repeat(64),
          payload: {
            path: signatureRelativePath,
            maximumSizeBytes: signerConfiguration.signature.maximumSizeBytes,
            mediaType: signerConfiguration.signature.mediaType,
          },
        },
      })
      if (described.signature.status !== "present") {
        throw new Error("npm signed binding descriptor was not preserved by its schema")
      }
      const signedBindingSha256 = npmReleaseBindingSigningSha256(described)
      binding = assertNpmReleaseBinding({
        ...described,
        signature: {
          ...described.signature,
          signedBindingSha256,
        },
      })
      const canonicalBindingBytes = canonicalNpmReleaseBindingSigningBytes(binding)
      assertPackagingActive(signal)
      signatureReceipt = await invokeReleaseSubjectSigner({
        configuration: signerConfiguration,
        subjectKind: "npm-release-binding",
        canonicalSubjectBytes: canonicalBindingBytes,
        signedSubjectSha256: signedBindingSha256,
        signatureDestination: resolve(resultDirectory, signatureRelativePath),
        environment: process.env,
        signal,
      })
      assertPackagingActive(signal)
    } else {
      if (!args.signatureUnavailableReason) {
        throw new Error("npm signature unavailability reason became unavailable")
      }
      binding = assertNpmReleaseBinding({
        ...bindingBase,
        signature: {
          status: "unavailable",
          reason: args.signatureUnavailableReason,
        },
      })
    }
    assertPackagingActive(signal)
    const bindingPath = resolve(resultDirectory, "npm-release-binding.json")
    const bindingReceipt = await writeBoundJson(bindingPath, "npm-release-binding.json", binding)
    const status = evidence.status
    const packageResultReceipt = await writeBoundJson(
      resolve(resultDirectory, "package-result.json"),
      "package-result.json",
      {
        schemaVersion: 2,
        status,
        packageName: args.packageName,
        version: packageJson.version,
        channel: args.channel,
        distTag: args.distTag,
        publishedAt: args.publishedAt,
        tarball: artifactBinding.tarball,
        binding: bindingReceipt,
        ...(promotionBinding ? { promotion: promotionBinding } : {}),
        ...(releaseCandidateReceiptBinding
          ? { releaseCandidateReceipt: releaseCandidateReceiptBinding }
          : {}),
        ...(releaseCandidateReceiptBinding && validatedReleaseCandidateInput
          ? {
              releaseCandidateSnapshot: {
                relocatable: false,
                reason:
                  "Payload paths remain relative to the original standalone candidate directory; this copied file is an opaque hash-bound metadata snapshot, not a standalone receipt to validate in place.",
                metadata: releaseCandidateReceiptBinding,
                payloadContentAddress: `sha256:${validatedReleaseCandidateInput.payloadContentAddress}`,
                payloads: validatedReleaseCandidateInput.payloads,
              },
            }
          : {}),
        signature:
          binding.signature.status === "present" && signatureReceipt
            ? {
                status: "present",
                kind: binding.signature.kind,
                identity: binding.signature.identity,
                path: binding.signature.payload.path,
                signedBindingSha256: binding.signature.signedBindingSha256,
                sha256: signatureReceipt.sha256,
                sizeBytes: signatureReceipt.size,
              }
            : binding.signature,
        sourceCommit: verifiedSource.commit,
        sourceFingerprintSha256: sourceSha256,
      },
    )
    await assertBoundPayloads(resultDirectory, [
      ...Object.values(binding.artifact),
      ...Object.values(binding.support),
      ...(binding.evidence.status === "packaged-tested"
        ? [binding.evidence.promotion, binding.evidence.releaseCandidateReceipt]
        : []),
      bindingReceipt,
      packageResultReceipt,
    ])
    if ((await sha256File(bindingPath)) !== bindingReceipt.sha256) {
      throw new Error("npm release binding changed before package commit")
    }
    if (signatureReceipt) await assertReleaseSignatureReceipt(signatureReceipt)
    if (
      (await sha256File(resolve(packageCopy, "bundle-build-metadata.json"))) !==
      stagedBundleMetadataReceipt.sha256
    ) {
      throw new Error("Staged bundle build metadata changed before npm package commit")
    }
    await verifyReleaseGitSource({
      projectRoot,
      expectedRepository: verifiedSource.repository,
      expectedCommit: verifiedSource.commit,
    })
    assertPackagingActive(signal)
    const recheckedOutputDirectory = await resolveManagedReleaseDestination({
      trustedRoot: verifiedSource.root,
      allowedBaseSegments: ["dist", "npm"],
      requestedDestination: args.outputDirectory,
    })
    if (recheckedOutputDirectory !== safeOutputDirectory) {
      throw new Error("npm package destination changed during packaging")
    }
    await assertExactPackageArchiveBinding()
    await assertBoundPayloads(resultDirectory, [
      ...Object.values(binding.artifact),
      ...Object.values(binding.support),
      ...(binding.evidence.status === "packaged-tested"
        ? [binding.evidence.promotion, binding.evidence.releaseCandidateReceipt]
        : []),
      bindingReceipt,
      packageResultReceipt,
    ])
    if (signatureReceipt) await assertReleaseSignatureReceipt(signatureReceipt)
    await assertExactResultInventory(
      resultDirectory,
      new Set([
        ...expectedArchivePaths,
        tgzName,
        bindingReceipt.path,
        packageResultReceipt.path,
        ...(promotionBinding ? [promotionBinding.path] : []),
        ...(releaseCandidateReceiptBinding ? [releaseCandidateReceiptBinding.path] : []),
        ...(binding.signature.status === "present" ? [binding.signature.payload.path] : []),
      ]),
    )
    assertPackagingActive(signal)
    if (validatedPromotionRecord !== undefined) {
      if (
        !validatedReleaseCandidateInput ||
        !validatedPromotionCandidate ||
        !args.releaseCandidateReceiptPath
      ) {
        throw new Error("npm promotion lost its independent standalone candidate binding")
      }
      const currentReleaseCandidateInput = await readStandaloneCandidateReceipt(
        args.releaseCandidateReceiptPath,
        signal,
      )
      if (
        currentReleaseCandidateInput.path !== validatedReleaseCandidateInput.path ||
        currentReleaseCandidateInput.sha256 !== validatedReleaseCandidateInput.sha256 ||
        currentReleaseCandidateInput.sizeBytes !== validatedReleaseCandidateInput.sizeBytes
      ) {
        throw new Error("Standalone release candidate receipt changed before npm package commit")
      }
      assertNpmReleasePromotionBinding(validatedPromotionRecord, {
        ...validatedPromotionCandidate,
        releaseCandidate: {
          receipt: {
            subject: currentReleaseCandidateInput.receipt.subject,
            path: "standalone-release-candidate-snapshot.json",
            sha256: currentReleaseCandidateInput.sha256,
            sizeBytes: currentReleaseCandidateInput.sizeBytes,
          },
          promotionCandidate: currentReleaseCandidateInput.receipt.promotionCandidate,
        },
        now: new Date().toISOString(),
      })
    }
    assertPackagingActive(signal)
    await verifyReleaseGitSource({
      projectRoot,
      expectedRepository: verifiedSource.repository,
      expectedCommit: verifiedSource.commit,
    })
    const finalOutputDirectory = await resolveManagedReleaseDestination({
      trustedRoot: verifiedSource.root,
      allowedBaseSegments: ["dist", "npm"],
      requestedDestination: args.outputDirectory,
    })
    if (finalOutputDirectory !== safeOutputDirectory) {
      throw new Error("npm package destination changed before final commit")
    }
    await assertExactPackageArchiveBinding()
    await assertBoundPayloads(resultDirectory, [
      ...Object.values(binding.artifact),
      ...Object.values(binding.support),
      ...(binding.evidence.status === "packaged-tested"
        ? [binding.evidence.promotion, binding.evidence.releaseCandidateReceipt]
        : []),
      bindingReceipt,
      packageResultReceipt,
    ])
    if ((await sha256File(bindingPath)) !== bindingReceipt.sha256) {
      throw new Error("npm release binding changed during final promotion validation")
    }
    if (signatureReceipt) await assertReleaseSignatureReceipt(signatureReceipt)
    if (
      (await sha256File(resolve(packageCopy, "bundle-build-metadata.json"))) !==
      stagedBundleMetadataReceipt.sha256
    ) {
      throw new Error("Staged bundle build metadata changed during final promotion validation")
    }
    await assertExactResultInventory(
      resultDirectory,
      new Set([
        ...expectedArchivePaths,
        tgzName,
        bindingReceipt.path,
        packageResultReceipt.path,
        ...(promotionBinding ? [promotionBinding.path] : []),
        ...(releaseCandidateReceiptBinding ? [releaseCandidateReceiptBinding.path] : []),
        ...(binding.signature.status === "present" ? [binding.signature.payload.path] : []),
      ]),
    )
    assertPackagingActive(signal)
    await rename(resultDirectory, safeOutputDirectory)
    committed = true
    await removeManagedReleaseOperation(stagingBase, operationDirectory).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`ralph npm package: committed with stale staging (${message})\n`)
    })
    process.stdout.write(
      `${JSON.stringify({
        status,
        packageName: args.packageName,
        version: packageJson.version,
        channel: args.channel,
        distTag: args.distTag,
        output: safeOutputDirectory,
        tarball: resolve(safeOutputDirectory, tgzName),
        binding: resolve(safeOutputDirectory, "npm-release-binding.json"),
        promotion: promotionBinding ? "present" : "unavailable",
        releaseCandidateReceipt: releaseCandidateReceiptBinding
          ? resolve(safeOutputDirectory, releaseCandidateReceiptBinding.path)
          : "unavailable",
        signature: binding.signature.status,
      })}\n`,
    )
  } catch (error) {
    if (committed) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `npm package was committed at ${safeOutputDirectory}, but post-commit reporting failed: ${message}`,
        { cause: error },
      )
    }
    await removeManagedReleaseOperation(stagingBase, operationDirectory).catch(() => undefined)
    throw error
  }
}

const npmAbort = new AbortController()
const npmShutdown = new TwoPhaseShutdownController({ abortController: npmAbort })
const cancelFromProcessSignal = (name: "SIGINT" | "SIGTERM") => (): void => {
  npmShutdown.handleSignal(name)
}
const cancelFromSigint = cancelFromProcessSignal("SIGINT")
const cancelFromSigterm = cancelFromProcessSignal("SIGTERM")
process.on("SIGINT", cancelFromSigint)
process.on("SIGTERM", cancelFromSigterm)

try {
  await packageNpm(npmAbort.signal)
  if (npmAbort.signal.aborted) process.exitCode = 130
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`ralph npm package: ${message}\n`)
  process.exitCode = npmAbort.signal.aborted ? 130 : 1
} finally {
  npmShutdown.close()
  process.off("SIGINT", cancelFromSigint)
  process.off("SIGTERM", cancelFromSigterm)
}
