import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readdir, rename, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  assertReleaseVersionChannel,
  LauncherBuildMetadataSchema,
  type PromotionSupportBinding,
  ReleaseBuildMetadataSchema,
  type ReleaseChannel,
  ReleaseChannelSchema,
  type ReleaseManifest,
  ReleaseManifestSchema,
  type ReleasePayload,
  ReleasePayloadSchema,
  ReleaseSbomSchema,
  type ReleaseSupportPolicy,
  ReleaseSupportPolicySchema,
  type ReleaseTarget,
  ReleaseTargetSchema,
  releaseManifestSigningSha256,
  releaseSupportPolicySha256,
} from "@ralph/distribution"
import { TwoPhaseShutdownController } from "@ralph/supervisor"
import packageJson from "../package.json" with { type: "json" }
import { RELEASE_TARGETS, sha256File, validateStandaloneArtifact } from "./build-artifact"
import { PUBLIC_SCHEMA_DEFINITIONS, publicSchemaMismatches } from "./generate-schemas"
import { createDeterministicTar } from "./release-archive"
import {
  assertRegularReleaseFile,
  copyRegularDirectoryVerified,
  copyRegularVerified,
  prepareManagedReleaseDirectory,
  removeManagedReleaseOperation,
  resolveManagedReleaseDestination,
} from "./release-files"
import { materializeReleaseLicenseInventory } from "./release-licenses"
import { compareUtf8Bytes } from "./release-order"
import {
  type PromotionTargetArtifacts,
  type ValidatedPromotionRecord,
  validateReleasePromotionRecord,
} from "./release-promotion"
import { createReleaseSbom } from "./release-sbom"
import {
  assertReleaseSignatureReceipt,
  invokeReleaseSigner,
  loadReleaseSignerConfiguration,
  type ReleaseSignatureReceipt,
} from "./release-signer"
import { hashReleaseSourceTree, verifyReleaseGitSource } from "./release-source"

type ReleaseArguments = {
  readonly channel: ReleaseChannel
  readonly sourceRepository: string
  readonly sourceCommit: string
  readonly publishedAt: string
  readonly signatureConfigPath?: string
  readonly signatureUnavailableReason?: string
  readonly supportPolicyPath: string
  readonly targets: readonly ReleaseTarget[]
  readonly outputDirectory: string
  readonly baseUrl?: string
  readonly minimumWorkspaceSchema: number
  readonly maximumWorkspaceSchema: number
  readonly minimumLauncherSchema: number
  readonly maximumLauncherSchema: number
  readonly downgradeSafeThrough?: string
  readonly promotionRecordPath?: string
  readonly candidateOnly: boolean
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`)
  }
  return parsed
}

function httpsBaseUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("--base-url must be HTTPS without credentials, query or fragment")
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`
  return url.toString()
}

function parseArguments(argv: readonly string[], projectRoot: string): ReleaseArguments {
  let channel: ReleaseChannel | undefined
  let sourceRepository: string | undefined
  let sourceCommit: string | undefined
  let publishedAt: string | undefined
  let signatureUnavailableReason: string | undefined
  let signatureConfigPath: string | undefined
  let supportPolicyPath: string | undefined
  let outputDirectory: string | undefined
  let baseUrl: string | undefined
  let allTargets = false
  const targets: ReleaseTarget[] = []
  let minimumWorkspaceSchema = 1
  let maximumWorkspaceSchema = 1
  let minimumLauncherSchema = 1
  let maximumLauncherSchema = 1
  let downgradeSafeThrough: string | undefined
  let promotionRecordPath: string | undefined
  let candidateOnly = false

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--all") {
      allTargets = true
      continue
    }
    if (flag === "--channel") {
      const value = requiredValue(argv, index, flag)
      const parsedChannel = ReleaseChannelSchema.safeParse(value)
      if (!parsedChannel.success) {
        throw new Error(`Unsupported release channel: ${value}`)
      }
      channel = parsedChannel.data
      index += 1
      continue
    }
    if (flag === "--source-repository") {
      sourceRepository = requiredValue(argv, index, flag)
      index += 1
      continue
    }
    if (flag === "--source-commit") {
      sourceCommit = requiredValue(argv, index, flag).toLowerCase()
      index += 1
      continue
    }
    if (flag === "--published-at") {
      publishedAt = requiredValue(argv, index, flag)
      index += 1
      continue
    }
    if (flag === "--signature-unavailable-reason") {
      signatureUnavailableReason = requiredValue(argv, index, flag)
      index += 1
      continue
    }
    if (flag === "--signature-config") {
      signatureConfigPath = resolve(requiredValue(argv, index, flag))
      index += 1
      continue
    }
    if (flag === "--support-policy") {
      supportPolicyPath = resolve(requiredValue(argv, index, flag))
      index += 1
      continue
    }
    if (flag === "--target") {
      const value = requiredValue(argv, index, flag)
      targets.push(ReleaseTargetSchema.parse(value))
      index += 1
      continue
    }
    if (flag === "--output") {
      outputDirectory = requiredValue(argv, index, flag)
      index += 1
      continue
    }
    if (flag === "--base-url") {
      baseUrl = httpsBaseUrl(requiredValue(argv, index, flag))
      index += 1
      continue
    }
    if (flag === "--minimum-workspace-schema") {
      minimumWorkspaceSchema = positiveInteger(requiredValue(argv, index, flag), flag)
      index += 1
      continue
    }
    if (flag === "--maximum-workspace-schema") {
      maximumWorkspaceSchema = positiveInteger(requiredValue(argv, index, flag), flag)
      index += 1
      continue
    }
    if (flag === "--minimum-launcher-schema") {
      minimumLauncherSchema = positiveInteger(requiredValue(argv, index, flag), flag)
      index += 1
      continue
    }
    if (flag === "--maximum-launcher-schema") {
      maximumLauncherSchema = positiveInteger(requiredValue(argv, index, flag), flag)
      index += 1
      continue
    }
    if (flag === "--downgrade-safe-through") {
      downgradeSafeThrough = requiredValue(argv, index, flag)
      index += 1
      continue
    }
    if (flag === "--promotion-record") {
      promotionRecordPath = resolve(requiredValue(argv, index, flag))
      index += 1
      continue
    }
    if (flag === "--candidate-only") {
      if (candidateOnly) throw new Error("--candidate-only can be specified only once")
      candidateOnly = true
      continue
    }
    throw new Error(`Unknown release packaging argument: ${flag ?? "<missing>"}`)
  }

  if (!channel) throw new Error("--channel is required")
  if (!supportPolicyPath) {
    throw new Error(
      "--support-policy is required; target support is never inferred from built artifacts",
    )
  }
  if (candidateOnly) {
    if (channel !== "stable") {
      throw new Error("--candidate-only is reserved for the first pass of a stable release")
    }
    if (promotionRecordPath || signatureConfigPath || signatureUnavailableReason !== undefined) {
      throw new Error("--candidate-only cannot be combined with promotion or signature options")
    }
  }
  if (channel === "stable" && !candidateOnly && !promotionRecordPath) {
    throw new Error("Stable packaging requires --promotion-record with complete S11 evidence")
  }
  if ((channel === "dev" || channel === "nightly") && promotionRecordPath) {
    throw new Error("Promotion records are accepted only for beta or stable channels")
  }
  if (!candidateOnly) {
    if (signatureConfigPath && signatureUnavailableReason !== undefined) {
      throw new Error("Use either --signature-config or --signature-unavailable-reason, never both")
    }
    if (!signatureConfigPath && signatureUnavailableReason === undefined) {
      throw new Error("Use exactly one of --signature-config or --signature-unavailable-reason")
    }
  }
  if (channel === "stable" && !candidateOnly && !signatureConfigPath) {
    throw new Error("Stable packaging requires --signature-config and a detached signature")
  }
  if (channel === "dev" && signatureConfigPath) {
    throw new Error("Dev is a source-checkout channel; detached release signing starts at nightly")
  }
  if (!sourceRepository) throw new Error("--source-repository is required")
  const repository = new URL(sourceRepository)
  if (
    repository.protocol !== "https:" ||
    repository.username ||
    repository.password ||
    repository.search ||
    repository.hash
  ) {
    throw new Error(
      "--source-repository must be an HTTPS URL without credentials, query or fragment",
    )
  }
  if (!sourceCommit || !COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("--source-commit must be a full lowercase 40-character Git commit")
  }
  if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) {
    throw new Error("--published-at must be an ISO-8601 timestamp")
  }
  const canonicalPublishedAt = new Date(publishedAt).toISOString()
  if (candidateOnly && Date.parse(canonicalPublishedAt) <= Date.now() + 5 * 60_000) {
    throw new Error(
      "--candidate-only requires a fixed --published-at more than five minutes in the future",
    )
  }
  if (
    signatureUnavailableReason !== undefined &&
    (signatureUnavailableReason.trim().length === 0 ||
      signatureUnavailableReason.trim().length > 1_000 ||
      containsAsciiControlCharacter(signatureUnavailableReason))
  ) {
    throw new Error("--signature-unavailable-reason must be a bounded non-control explanation")
  }
  if (allTargets && targets.length > 0) throw new Error("Use either --all or repeated --target")
  const selectedTargets = allTargets ? [...RELEASE_TARGETS] : [...new Set(targets)]
  if (selectedTargets.length === 0) throw new Error("Select at least one --target or use --all")
  if (minimumWorkspaceSchema > maximumWorkspaceSchema) {
    throw new Error("Minimum workspace schema cannot exceed maximum workspace schema")
  }
  if (minimumLauncherSchema > maximumLauncherSchema) {
    throw new Error("Minimum launcher schema cannot exceed maximum launcher schema")
  }
  if (downgradeSafeThrough && !SEMVER_PATTERN.test(downgradeSafeThrough)) {
    throw new Error("--downgrade-safe-through must be SemVer")
  }

  const releaseBase = resolve(projectRoot, "dist", "release")
  const finalOutput = resolve(outputDirectory ?? join(releaseBase, packageJson.version))
  const output = candidateOnly ? `${finalOutput}-candidate` : finalOutput
  if (!inside(releaseBase, output)) {
    throw new Error(`Release output must remain below ${releaseBase}: ${output}`)
  }
  return {
    channel,
    sourceRepository: repository.toString(),
    sourceCommit,
    publishedAt: canonicalPublishedAt,
    ...(signatureConfigPath ? { signatureConfigPath } : {}),
    ...(signatureUnavailableReason !== undefined
      ? { signatureUnavailableReason: signatureUnavailableReason.trim() }
      : {}),
    supportPolicyPath,
    targets: selectedTargets,
    outputDirectory: output,
    ...(baseUrl ? { baseUrl } : {}),
    minimumWorkspaceSchema,
    maximumWorkspaceSchema,
    minimumLauncherSchema,
    maximumLauncherSchema,
    ...(downgradeSafeThrough ? { downgradeSafeThrough } : {}),
    ...(promotionRecordPath ? { promotionRecordPath } : {}),
    candidateOnly,
  }
}

async function regularFile(path: string, label: string): Promise<void> {
  await assertRegularReleaseFile(path, label)
}

async function readJson(path: string, label: string): Promise<unknown> {
  const resolved = resolve(path)
  await regularFile(resolved, label)
  const before = await lstat(resolved)
  if (before.size <= 0 || before.size > 4 * 1024 * 1024) {
    throw new Error(`${label} must be a non-empty JSON file no larger than 4 MiB: ${resolved}`)
  }
  const handle = await open(resolved, "r")
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error(`${label} identity changed before it could be read: ${resolved}`)
    }
    const bytes = await handle.readFile()
    const after = await lstat(resolved)
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`${label} changed while it was read: ${resolved}`)
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error(`${label} is not stable, bounded UTF-8 JSON: ${resolved}`, { cause: error })
  } finally {
    await handle.close()
  }
}

async function copyRegular(
  source: string,
  destination: string,
  executable = false,
  expectedSha256?: string,
): Promise<void> {
  await copyRegularVerified(source, destination, {
    executable,
    ...(expectedSha256 ? { expectedSha256 } : {}),
  })
}

async function copyRegularDirectoryForRelease(source: string, destination: string): Promise<void> {
  await copyRegularDirectoryVerified(source, destination)
}

async function collectRegularFiles(root: string, current = root): Promise<string[]> {
  const output: string[] = []
  const entries = await readdir(current, { withFileTypes: true })
  entries.sort((left, right) => compareUtf8Bytes(left.name, right.name))
  for (const entry of entries) {
    const path = resolve(current, entry.name)
    if (!inside(root, path)) throw new Error(`Release payload escapes staging root: ${path}`)
    const information = await lstat(path)
    if (information.isSymbolicLink())
      throw new Error(`Release payload cannot be a symlink: ${path}`)
    if (information.isDirectory()) output.push(...(await collectRegularFiles(root, path)))
    else if (information.isFile()) output.push(path)
    else throw new Error(`Release payload must be a regular file: ${path}`)
  }
  return output
}

async function expectedArchiveHashes(root: string): Promise<Readonly<Record<string, string>>> {
  const expected = Object.create(null) as Record<string, string>
  for (const path of await collectRegularFiles(root)) {
    const archivePath = portable(relative(root, path))
    expected[archivePath] = await sha256File(path)
  }
  return expected
}

async function payloadFor(
  releaseDirectory: string,
  absolutePath: string,
  mediaType: string,
  baseUrl?: string,
): Promise<ReleasePayload> {
  const relativePath = portable(relative(releaseDirectory, absolutePath))
  if (!relativePath || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    throw new Error(`Release payload path escapes release directory: ${absolutePath}`)
  }
  const before = await lstat(absolutePath)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Release payload must be a regular non-symlink file: ${absolutePath}`)
  }
  const sha256 = await sha256File(absolutePath)
  const after = await lstat(absolutePath)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw new Error(`Release payload changed while its receipt was created: ${absolutePath}`)
  }
  const url = baseUrl ? new URL(relativePath, baseUrl).toString() : undefined
  return ReleasePayloadSchema.parse({
    path: relativePath,
    ...(url ? { url } : {}),
    sha256,
    sizeBytes: before.size,
    mediaType,
  })
}

async function writeBoundJson(
  releaseDirectory: string,
  absolutePath: string,
  value: unknown,
  baseUrl?: string,
): Promise<ReleasePayload> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
  await writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 })
  await chmod(absolutePath, 0o644)
  const receipt = await payloadFor(releaseDirectory, absolutePath, "application/json", baseUrl)
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex")
  if (receipt.sizeBytes !== bytes.byteLength || receipt.sha256 !== expectedSha256) {
    throw new Error(`Release JSON sidecar changed while it was written: ${absolutePath}`)
  }
  return receipt
}

async function assertReleasePayloads(
  releaseDirectory: string,
  payloads: readonly ReleasePayload[],
): Promise<void> {
  for (const payload of payloads) {
    const absolutePath = resolve(releaseDirectory, payload.path)
    if (!inside(releaseDirectory, absolutePath)) {
      throw new Error(`Release payload receipt escaped result root: ${payload.path}`)
    }
    const information = await lstat(absolutePath)
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.size !== payload.sizeBytes ||
      (await sha256File(absolutePath)) !== payload.sha256
    ) {
      throw new Error(`Release payload changed before package commit: ${payload.path}`)
    }
  }
}

async function assertExactReleaseInventory(
  releaseDirectory: string,
  expectedPaths: ReadonlySet<string>,
): Promise<void> {
  const actualPaths = new Set(
    (await collectRegularFiles(releaseDirectory)).map((path) =>
      portable(relative(releaseDirectory, path)),
    ),
  )
  if (
    actualPaths.size !== expectedPaths.size ||
    [...actualPaths].some((path) => !expectedPaths.has(path))
  ) {
    throw new Error("Release candidate directory contains missing or unbound sidecars")
  }
}

async function copyBundleSupport(
  projectRoot: string,
  bundleRoot: string,
  sharedLicense: string,
  sharedNotices: string,
  sharedLicenseInventory: string,
  supportBinding: PromotionSupportBinding,
): Promise<void> {
  const copies = [
    [resolve(projectRoot, "AGENTS.md"), resolve(bundleRoot, "AGENTS.md")],
    [resolve(projectRoot, "CHANGELOG.md"), resolve(bundleRoot, "CHANGELOG.md")],
    [resolve(projectRoot, "DEVELOPMENT.md"), resolve(bundleRoot, "DEVELOPMENT.md")],
    [resolve(projectRoot, "PRD.md"), resolve(bundleRoot, "PRD.md")],
    [resolve(projectRoot, "README.md"), resolve(bundleRoot, "README.md")],
  ] as const
  for (const [source, destination] of copies) await copyRegular(source, destination)
  for (const directory of ["docs", "examples", "implementation", "skill-contract"] as const) {
    await copyRegularDirectoryVerified(
      resolve(projectRoot, directory),
      resolve(bundleRoot, directory),
    )
  }
  await copyRegular(
    sharedLicense,
    resolve(bundleRoot, "LICENSE"),
    false,
    supportBinding.licenseSha256,
  )
  await copyRegular(
    sharedNotices,
    resolve(bundleRoot, "THIRD_PARTY_NOTICES.md"),
    false,
    supportBinding.thirdPartyNoticesSha256,
  )
  for (const project of ["opencode", "opentui", "solid-js"] as const) {
    await copyRegular(
      resolve(projectRoot, "third_party", project, "LICENSE"),
      resolve(bundleRoot, "third_party", project, "LICENSE"),
    )
  }
  for (const file of ["PROVENANCE.json", "UPSTREAM.md", "copied-files.md", "patches.md"] as const) {
    await copyRegular(
      resolve(projectRoot, "third_party", "opencode", file),
      resolve(bundleRoot, "third_party", "opencode", file),
    )
  }
  await copyRegularDirectoryVerified(
    sharedLicenseInventory,
    resolve(bundleRoot, "third_party", "licenses"),
  )
  const skillSource = resolve(projectRoot, "skills", "ralph-loop-prd-generator")
  const skillInformation = await lstat(skillSource)
  if (!skillInformation.isDirectory() || skillInformation.isSymbolicLink()) {
    throw new Error(`Release skill must be a regular directory: ${skillSource}`)
  }
  await copyRegularDirectoryVerified(
    skillSource,
    resolve(bundleRoot, "skills", "ralph-loop-prd-generator"),
  )
  await copyRegularDirectoryVerified(
    resolve(projectRoot, "schemas"),
    resolve(bundleRoot, "schemas"),
  )
}

function assertPackagingActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Release packaging was cancelled")
}

async function packageRelease(signal: AbortSignal): Promise<void> {
  assertPackagingActive(signal)
  const projectRoot = resolve(import.meta.dir, "..")
  const args = parseArguments(process.argv.slice(2), projectRoot)
  assertReleaseVersionChannel(packageJson.version, args.channel)
  const rootManifest = packageJson as typeof packageJson & { readonly license?: string }
  if (!rootManifest.license?.trim()) {
    throw new Error(
      "Release packaging is blocked until the owner selects an explicit root package license",
    )
  }
  const supportPolicy: ReleaseSupportPolicy = ReleaseSupportPolicySchema.parse(
    await readJson(args.supportPolicyPath, "Release support policy"),
  )
  if (supportPolicy.version !== packageJson.version || supportPolicy.channel !== args.channel) {
    throw new Error(
      "Release support policy must bind the root package version and selected channel",
    )
  }
  const supportPolicySha256 = releaseSupportPolicySha256(supportPolicy)
  const releaseTargets = supportPolicy.matrix
    .filter((entry) => entry.status === "included")
    .map((entry) => entry.target)
  const requestedTargets = new Set(args.targets)
  if (
    requestedTargets.size !== releaseTargets.length ||
    releaseTargets.some((target) => !requestedTargets.has(target))
  ) {
    throw new Error(
      "--target/--all must select exactly the targets marked included by --support-policy; inclusion is not tested support and non-promoted targets remain visible in the matrix",
    )
  }
  const signerConfiguration = args.signatureConfigPath
    ? await loadReleaseSignerConfiguration(args.signatureConfigPath)
    : undefined
  await regularFile(resolve(projectRoot, "LICENSE"), "Root project LICENSE")
  await regularFile(resolve(projectRoot, "THIRD_PARTY_NOTICES.md"), "Third-party notices")
  const schemaMismatches = await publicSchemaMismatches(resolve(projectRoot, "schemas"))
  if (schemaMismatches.length > 0) {
    throw new Error(
      `Standalone packaging requires exactly ${PUBLIC_SCHEMA_DEFINITIONS.length} current generated JSON Schemas; generation is a separate explicit step:\n${schemaMismatches.map((path) => `- ${path}`).join("\n")}`,
    )
  }
  const verifiedSource = await verifyReleaseGitSource({
    projectRoot,
    expectedRepository: args.sourceRepository,
    expectedCommit: args.sourceCommit,
  })
  const safeOutputDirectory = await resolveManagedReleaseDestination({
    trustedRoot: verifiedSource.root,
    allowedBaseSegments: ["dist", "release"],
    requestedDestination: args.outputDirectory,
  })
  const stagingBase = await prepareManagedReleaseDirectory(verifiedSource.root, [
    "dist",
    "release-staging",
  ])
  const operationDirectory = resolve(stagingBase, randomUUID())
  if (!inside(stagingBase, operationDirectory))
    throw new Error("Release staging identity escaped base")
  const releaseDirectory = resolve(operationDirectory, "release")
  const bundlesDirectory = resolve(operationDirectory, "bundles")
  await mkdir(operationDirectory, { recursive: true })
  await mkdir(releaseDirectory, { recursive: false })
  await mkdir(bundlesDirectory, { recursive: false })

  let committed = false
  try {
    const sharedLicense = resolve(releaseDirectory, "LICENSE")
    const sharedNotices = resolve(releaseDirectory, "THIRD_PARTY_NOTICES.md")
    await copyRegular(resolve(projectRoot, "LICENSE"), sharedLicense)
    await copyRegular(resolve(projectRoot, "THIRD_PARTY_NOTICES.md"), sharedNotices)

    const firstTarget = releaseTargets[0]
    if (!firstTarget) throw new Error("Release target list became empty")
    const firstExtension = firstTarget.startsWith("bun-windows-") ? ".exe" : ""
    const firstBinary = resolve(
      projectRoot,
      "dist",
      "standalone",
      firstTarget,
      `ralph${firstExtension}`,
    )
    const firstValidated = await validateStandaloneArtifact(firstBinary, projectRoot, firstTarget)
    const sourceFingerprintSha256 = firstValidated.metadata.sourceSha256.toLowerCase()
    const bunRuntime = {
      version: firstValidated.metadata.bunVersion,
      revision: firstValidated.metadata.bunRevision,
    } as const

    const sbom = await createReleaseSbom({
      projectRoot,
      version: packageJson.version,
      licenseExpression: rootManifest.license.trim(),
      publishedAt: args.publishedAt,
      sourceFingerprintSha256,
      bunRuntime,
    })
    ReleaseSbomSchema.parse(sbom)
    const sbomPath = resolve(releaseDirectory, "SBOM.cdx.json")
    await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await chmod(sbomPath, 0o644)
    const sbomSha256 = await sha256File(sbomPath)
    const sharedThirdPartyDirectory = resolve(releaseDirectory, "third_party")
    await mkdir(sharedThirdPartyDirectory, { recursive: false })
    for (const project of ["opencode", "opentui", "solid-js"] as const) {
      await copyRegular(
        resolve(projectRoot, "third_party", project, "LICENSE"),
        resolve(sharedThirdPartyDirectory, project, "LICENSE"),
      )
    }
    for (const file of [
      "PROVENANCE.json",
      "UPSTREAM.md",
      "copied-files.md",
      "patches.md",
    ] as const) {
      await copyRegular(
        resolve(projectRoot, "third_party", "opencode", file),
        resolve(sharedThirdPartyDirectory, "opencode", file),
      )
    }
    const licenseInventory = await materializeReleaseLicenseInventory({
      projectRoot,
      sbom,
      sbomSha256,
      publishedAt: args.publishedAt,
      outputDirectory: resolve(sharedThirdPartyDirectory, "licenses"),
      bunRuntime,
    })
    const skillBundleRoot = resolve(bundlesDirectory, "skill-package")
    const skillArchiveSource = resolve(skillBundleRoot, "skill")
    await copyRegularDirectoryForRelease(
      resolve(projectRoot, "skills", "ralph-loop-prd-generator"),
      resolve(skillArchiveSource, "ralph-loop-prd-generator"),
    )
    await copyRegular(sharedLicense, resolve(skillArchiveSource, "LICENSE"))
    await copyRegular(sharedNotices, resolve(skillArchiveSource, "THIRD_PARTY_NOTICES.md"))
    const skillArchivePath = resolve(releaseDirectory, "skills", "ralph-loop-prd-generator.tar")
    await createDeterministicTar(
      skillArchiveSource,
      skillArchivePath,
      Math.floor(Date.parse(args.publishedAt) / 1000),
      { expectedSha256ByPath: await expectedArchiveHashes(skillArchiveSource) },
    )
    const supportBinding: PromotionSupportBinding = {
      licenseSha256: await sha256File(sharedLicense),
      thirdPartyNoticesSha256: await sha256File(sharedNotices),
      sbomSha256,
      skillArtifactSha256: await sha256File(skillArchivePath),
      supportPolicySha256,
    }
    const sourceSkillTreeSha256 = await hashReleaseSourceTree(
      resolve(projectRoot, "skills", "ralph-loop-prd-generator"),
    )
    const copiedSkillTreeSha256 = await hashReleaseSourceTree(
      resolve(skillArchiveSource, "ralph-loop-prd-generator"),
    )
    if (copiedSkillTreeSha256 !== sourceSkillTreeSha256) {
      throw new Error("Standalone skill artifact differs from the clean source tree")
    }

    const artifacts: Record<string, unknown>[] = []
    const promotedArtifactInputs: PromotionTargetArtifacts[] = []
    const targetPayloadReceipts: ReleasePayload[] = []
    const epochSeconds = Math.floor(Date.parse(args.publishedAt) / 1000)
    for (const target of releaseTargets) {
      assertPackagingActive(signal)
      const targetPolicy = supportPolicy.matrix.find((entry) => entry.target === target)
      if (targetPolicy?.status !== "included") {
        throw new Error(`Included release target lost its support-policy binding: ${target}`)
      }
      const extension = target.startsWith("bun-windows-") ? ".exe" : ""
      const buildDirectory = resolve(projectRoot, "dist", "standalone", target)
      const binary = resolve(buildDirectory, `ralph${extension}`)
      const launcher = resolve(buildDirectory, `ralph-launcher${extension}`)
      const metadataPath = resolve(buildDirectory, "build-metadata.json")
      const launcherMetadataPath = resolve(buildDirectory, "launcher-build-metadata.json")
      const validated = await validateStandaloneArtifact(binary, projectRoot, target)
      if (
        validated.metadata.sourceSha256.toLowerCase() !== sourceFingerprintSha256 ||
        validated.metadata.bunVersion !== firstValidated.metadata.bunVersion ||
        validated.metadata.bunRevision !== firstValidated.metadata.bunRevision
      ) {
        throw new Error(
          `Target ${target} was built from a different source fingerprint or Bun runtime identity`,
        )
      }
      await regularFile(launcher, "Standalone launcher")
      const parsedLauncherMetadata = LauncherBuildMetadataSchema.parse(
        await readJson(launcherMetadataPath, "Launcher build metadata"),
      )
      const expectedLauncherArtifact = portable(relative(projectRoot, launcher))
      if (
        parsedLauncherMetadata.target !== target ||
        parsedLauncherMetadata.version !== packageJson.version ||
        parsedLauncherMetadata.sourceSha256.toLowerCase() !== sourceFingerprintSha256 ||
        parsedLauncherMetadata.bunVersion !== firstValidated.metadata.bunVersion ||
        parsedLauncherMetadata.bunRevision !== firstValidated.metadata.bunRevision ||
        parsedLauncherMetadata.artifact !== expectedLauncherArtifact ||
        parsedLauncherMetadata.sha256.toLowerCase() !== (await sha256File(launcher)).toLowerCase()
      ) {
        throw new Error(`Launcher build metadata does not bind target artifact: ${target}`)
      }

      const artifactDirectory = resolve(releaseDirectory, "artifacts", target)
      await mkdir(artifactDirectory, { recursive: true })
      const releaseBinary = resolve(artifactDirectory, `ralph${extension}`)
      const releaseLauncher = resolve(artifactDirectory, `ralph-launcher${extension}`)
      const releaseMetadata = resolve(artifactDirectory, "build-metadata.json")
      const releaseLauncherMetadata = resolve(artifactDirectory, "launcher-build-metadata.json")
      await copyRegular(binary, releaseBinary, true, validated.metadata.sha256)
      await copyRegular(launcher, releaseLauncher, true, parsedLauncherMetadata.sha256)
      await copyRegular(metadataPath, releaseMetadata)
      await copyRegular(launcherMetadataPath, releaseLauncherMetadata)
      const copiedBuildMetadata = ReleaseBuildMetadataSchema.parse(
        await readJson(releaseMetadata, "Copied engine build metadata"),
      )
      const copiedLauncherMetadata = LauncherBuildMetadataSchema.parse(
        await readJson(releaseLauncherMetadata, "Copied launcher build metadata"),
      )
      if (
        JSON.stringify(copiedBuildMetadata) !== JSON.stringify(validated.metadata) ||
        JSON.stringify(copiedLauncherMetadata) !== JSON.stringify(parsedLauncherMetadata)
      ) {
        throw new Error(`Copied build metadata changed after validation for target ${target}`)
      }
      const copiedBuildMetadataSha256 = await sha256File(releaseMetadata)
      const copiedLauncherMetadataSha256 = await sha256File(releaseLauncherMetadata)

      const bundleRoot = resolve(bundlesDirectory, target)
      await mkdir(resolve(bundleRoot, "bin"), { recursive: true })
      await copyRegular(
        binary,
        resolve(bundleRoot, "bin", `ralph${extension}`),
        true,
        validated.metadata.sha256,
      )
      await copyRegular(
        launcher,
        resolve(bundleRoot, "bin", `ralph-launcher${extension}`),
        true,
        parsedLauncherMetadata.sha256,
      )
      await copyRegular(
        releaseMetadata,
        resolve(bundleRoot, "build-metadata.json"),
        false,
        copiedBuildMetadataSha256,
      )
      await copyRegular(
        releaseLauncherMetadata,
        resolve(bundleRoot, "launcher-build-metadata.json"),
        false,
        copiedLauncherMetadataSha256,
      )
      await copyRegular(
        sbomPath,
        resolve(bundleRoot, "SBOM.cdx.json"),
        false,
        supportBinding.sbomSha256,
      )
      await copyBundleSupport(
        projectRoot,
        bundleRoot,
        sharedLicense,
        sharedNotices,
        licenseInventory.rootDirectory,
        supportBinding,
      )
      const bundledSkillSha256 = await hashReleaseSourceTree(
        resolve(bundleRoot, "skills", "ralph-loop-prd-generator"),
      )
      if (bundledSkillSha256 !== sourceSkillTreeSha256) {
        throw new Error(`Packaged skill tree differs from the clean source for target ${target}`)
      }
      const archive = resolve(artifactDirectory, `ralph-${packageJson.version}-${target}.tar`)
      await createDeterministicTar(bundleRoot, archive, epochSeconds, {
        executablePaths: [`bin/ralph${extension}`, `bin/ralph-launcher${extension}`],
        expectedSha256ByPath: await expectedArchiveHashes(bundleRoot),
      })
      const archiveSha256 = await sha256File(archive)

      const engineSha256 = await sha256File(releaseBinary)
      const launcherSha256 = await sha256File(releaseLauncher)
      const buildMetadataSha256 = await sha256File(releaseMetadata)
      const launcherBuildMetadataSha256 = await sha256File(releaseLauncherMetadata)
      promotedArtifactInputs.push({
        target,
        engineSha256,
        launcherSha256,
        buildMetadataSha256,
        launcherBuildMetadataSha256,
        archiveSha256,
      })
      const launcherPayload = await payloadFor(
        releaseDirectory,
        releaseLauncher,
        "application/vnd.ralph.launcher",
        args.baseUrl,
      )
      const executablePayload = await payloadFor(
        releaseDirectory,
        releaseBinary,
        "application/vnd.ralph.executable",
        args.baseUrl,
      )
      const buildMetadataPayload = await payloadFor(
        releaseDirectory,
        releaseMetadata,
        "application/json",
        args.baseUrl,
      )
      const launcherBuildMetadataPayload = await payloadFor(
        releaseDirectory,
        releaseLauncherMetadata,
        "application/json",
        args.baseUrl,
      )
      const archivePayload = await payloadFor(
        releaseDirectory,
        archive,
        "application/x-tar",
        args.baseUrl,
      )
      targetPayloadReceipts.push(
        launcherPayload,
        executablePayload,
        buildMetadataPayload,
        launcherBuildMetadataPayload,
        archivePayload,
      )
      artifacts.push({
        target,
        evidenceStatus: validated.metadata.status,
        launcher: launcherPayload,
        executable: executablePayload,
        buildMetadata: buildMetadataPayload,
        launcherBuildMetadata: launcherBuildMetadataPayload,
        archive: archivePayload,
        limitations: [
          ...targetPolicy.limitations,
          "Artifact was built but has not been runtime-tested on its declared target by this packaging step.",
        ],
      })
    }

    let promotionRecordPath: string | undefined
    let validatedPromotionInput: ValidatedPromotionRecord | undefined
    assertPackagingActive(signal)
    if (args.promotionRecordPath) {
      if (args.channel !== "beta" && args.channel !== "stable") {
        throw new Error(`Promotion record is not valid for channel ${args.channel}`)
      }
      const validatedPromotion = await validateReleasePromotionRecord({
        recordPath: args.promotionRecordPath,
        expectedVersion: packageJson.version,
        expectedChannel: args.channel,
        expectedRepository: verifiedSource.repository,
        expectedCommit: args.sourceCommit,
        expectedSourceFingerprintSha256: sourceFingerprintSha256,
        support: supportBinding,
        supportPolicy,
        publishedAt: args.publishedAt,
        artifacts: promotedArtifactInputs,
      })
      validatedPromotionInput = validatedPromotion
      const promotionDirectory = resolve(releaseDirectory, "promotion")
      promotionRecordPath = resolve(promotionDirectory, "promotion-record.json")
      await copyRegular(
        validatedPromotion.path,
        promotionRecordPath,
        false,
        validatedPromotion.sha256,
      )
      for (const artifact of artifacts) {
        const targetPolicy = supportPolicy.matrix.find((entry) => entry.target === artifact.target)
        artifact.evidenceStatus = "tested"
        artifact.limitations = [
          ...(targetPolicy?.status === "included" ? targetPolicy.limitations : []),
          ...validatedPromotion.record.limitations,
        ]
      }
    }

    // The detached envelope is intentionally created after this receipt. Its
    // cryptographic bytes depend on the canonical manifest, which itself binds
    // this checksum payload; adding the envelope here would create a cycle.
    const checksumInputs = await collectRegularFiles(releaseDirectory)
    const checksumLines: string[] = []
    const checksumReceipts: { readonly path: string; readonly sha256: string }[] = []
    for (const path of checksumInputs) {
      assertPackagingActive(signal)
      const sha256 = await sha256File(path)
      checksumReceipts.push({ path, sha256 })
      checksumLines.push(`${sha256}  ${portable(relative(releaseDirectory, path))}`)
    }
    checksumLines.sort(compareUtf8Bytes)
    const checksumsPath = resolve(releaseDirectory, "SHA256SUMS")
    await writeFile(checksumsPath, `${checksumLines.join("\n")}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await chmod(checksumsPath, 0o644)

    const licensePayload = await payloadFor(
      releaseDirectory,
      sharedLicense,
      "text/plain",
      args.baseUrl,
    )
    const thirdPartyNoticesPayload = await payloadFor(
      releaseDirectory,
      sharedNotices,
      "text/markdown",
      args.baseUrl,
    )
    const sbomPayload = await payloadFor(
      releaseDirectory,
      sbomPath,
      "application/vnd.cyclonedx+json",
      args.baseUrl,
    )
    const skillPayload = await payloadFor(
      releaseDirectory,
      skillArchivePath,
      "application/x-tar",
      args.baseUrl,
    )
    const checksumsPayload = await payloadFor(
      releaseDirectory,
      checksumsPath,
      "text/plain",
      args.baseUrl,
    )

    // Candidate/final flow branches only after every support file, skill archive and target archive
    // has been materialized. Keeping candidateOnly out of those inputs is the byte-identity contract
    // for the two stable passes; only flow sidecars differ below this point.
    if (args.candidateOnly) {
      const candidateReceipt = await writeBoundJson(
        releaseDirectory,
        resolve(releaseDirectory, "release-candidate-receipt.json"),
        {
          schemaVersion: 1,
          product: "ralph",
          subject: "standalone-release-candidate",
          status: "candidate-only",
          publishable: false,
          reason:
            "This first-pass stable candidate has no release manifest, promotion record or detached signature and must not be published.",
          promotionCandidate: {
            version: packageJson.version,
            channel: args.channel,
            repository: verifiedSource.repository,
            commit: verifiedSource.commit,
            sourceFingerprintSha256,
            support: supportBinding,
            supportPolicy,
            targets: promotedArtifactInputs,
            publishedAt: args.publishedAt,
          },
          files: {
            license: licensePayload,
            thirdPartyNotices: thirdPartyNoticesPayload,
            sbom: sbomPayload,
            skill: skillPayload,
            checksums: checksumsPayload,
            targets: artifacts,
          },
        },
        args.baseUrl,
      )
      const packageResultReceipt = await writeBoundJson(
        releaseDirectory,
        resolve(releaseDirectory, "package-result.json"),
        {
          schemaVersion: 2,
          status: "candidate-only",
          publishable: false,
          version: packageJson.version,
          channel: args.channel,
          publishedAt: args.publishedAt,
          outputKind: "standalone-release-candidate",
          candidate: candidateReceipt,
          manifest: { status: "not-created" },
          promotion: { status: "not-created" },
          signature: { status: "not-created" },
          supportPolicySha256,
          targets: promotedArtifactInputs,
        },
        args.baseUrl,
      )

      await verifyReleaseGitSource({
        projectRoot,
        expectedRepository: verifiedSource.repository,
        expectedCommit: verifiedSource.commit,
      })
      for (const receipt of checksumReceipts) {
        if ((await sha256File(receipt.path)) !== receipt.sha256) {
          throw new Error(`Release candidate payload changed after SHA256SUMS: ${receipt.path}`)
        }
      }
      await assertReleasePayloads(releaseDirectory, [
        licensePayload,
        thirdPartyNoticesPayload,
        sbomPayload,
        skillPayload,
        checksumsPayload,
        ...targetPayloadReceipts,
        candidateReceipt,
        packageResultReceipt,
      ])
      await assertExactReleaseInventory(
        releaseDirectory,
        new Set([
          ...checksumReceipts.map((receipt) => portable(relative(releaseDirectory, receipt.path))),
          checksumsPayload.path,
          candidateReceipt.path,
          packageResultReceipt.path,
        ]),
      )
      assertPackagingActive(signal)
      const recheckedOutputDirectory = await resolveManagedReleaseDestination({
        trustedRoot: verifiedSource.root,
        allowedBaseSegments: ["dist", "release"],
        requestedDestination: args.outputDirectory,
      })
      if (recheckedOutputDirectory !== safeOutputDirectory) {
        throw new Error("Release candidate destination changed during packaging")
      }
      if (Date.parse(args.publishedAt) <= Date.now() + 5 * 60_000) {
        throw new Error(
          "Release candidate creation consumed its evidence window; choose a later --published-at",
        )
      }
      assertPackagingActive(signal)
      await rename(releaseDirectory, safeOutputDirectory)
      committed = true
      await removeManagedReleaseOperation(stagingBase, operationDirectory).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(
            `ralph release candidate: committed with stale staging (${message})\n`,
          )
        },
      )
      process.stdout.write(
        `${JSON.stringify({
          status: "candidate-only",
          publishable: false,
          version: packageJson.version,
          channel: args.channel,
          publishedAt: args.publishedAt,
          output: safeOutputDirectory,
          candidate: resolve(safeOutputDirectory, candidateReceipt.path),
          manifest: "not-created",
          promotion: "not-created",
          signature: "not-created",
          supportPolicySha256,
          targets: releaseTargets,
        })}\n`,
      )
      return
    }

    const manifestBase = {
      schemaVersion: 2,
      product: "ralph",
      version: packageJson.version,
      channel: args.channel,
      publishedAt: args.publishedAt,
      source: {
        repository: verifiedSource.repository,
        commit: verifiedSource.commit,
        fingerprintSha256: sourceFingerprintSha256,
      },
      compatibility: {
        minimumWorkspaceSchema: args.minimumWorkspaceSchema,
        maximumWorkspaceSchema: args.maximumWorkspaceSchema,
        minimumLauncherSchema: args.minimumLauncherSchema,
        maximumLauncherSchema: args.maximumLauncherSchema,
        ...(args.downgradeSafeThrough ? { downgradeSafeThrough: args.downgradeSafeThrough } : {}),
      },
      supportPolicy,
      supportPolicySha256,
      artifacts,
      license: licensePayload,
      thirdPartyNotices: thirdPartyNoticesPayload,
      sbom: sbomPayload,
      skill: skillPayload,
      checksums: checksumsPayload,
      ...(promotionRecordPath
        ? {
            promotionRecord: await payloadFor(
              releaseDirectory,
              promotionRecordPath,
              "application/vnd.ralph.promotion+json",
              args.baseUrl,
            ),
          }
        : {}),
    }
    let signatureReceipt: ReleaseSignatureReceipt | undefined
    let signatureRelativePath: string | undefined
    let manifestValue: ReleaseManifest
    if (signerConfiguration) {
      assertPackagingActive(signal)
      signatureRelativePath = `signatures/release-signature.${signerConfiguration.signature.kind}`
      const signatureUrl = args.baseUrl
        ? new URL(signatureRelativePath, args.baseUrl).toString()
        : undefined
      const manifestWithDescriptor = ReleaseManifestSchema.parse({
        ...manifestBase,
        signature: {
          status: "present",
          kind: signerConfiguration.signature.kind,
          identity: signerConfiguration.signature.identity,
          signedManifestSha256: "0".repeat(64),
          payload: {
            path: signatureRelativePath,
            ...(signatureUrl ? { url: signatureUrl } : {}),
            maximumSizeBytes: signerConfiguration.signature.maximumSizeBytes,
            mediaType: signerConfiguration.signature.mediaType,
          },
        },
      })
      const signedManifestSha256 = releaseManifestSigningSha256(manifestWithDescriptor)
      manifestValue = ReleaseManifestSchema.parse({
        ...manifestWithDescriptor,
        signature: {
          ...manifestWithDescriptor.signature,
          signedManifestSha256,
        },
      })
      signatureReceipt = await invokeReleaseSigner({
        configuration: signerConfiguration,
        manifest: manifestValue,
        signatureDestination: resolve(releaseDirectory, signatureRelativePath),
        environment: process.env,
        signal,
      })
    } else {
      if (!args.signatureUnavailableReason) {
        throw new Error("Release signature unavailability reason became unavailable")
      }
      manifestValue = ReleaseManifestSchema.parse({
        ...manifestBase,
        signature: {
          status: "unavailable",
          reason: args.signatureUnavailableReason,
        },
      })
    }
    const manifestPath = resolve(releaseDirectory, "release-manifest.json")
    await writeFile(manifestPath, `${JSON.stringify(manifestValue, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await chmod(manifestPath, 0o644)
    const manifestSha256 = await sha256File(manifestPath)

    await verifyReleaseGitSource({
      projectRoot,
      expectedRepository: verifiedSource.repository,
      expectedCommit: verifiedSource.commit,
    })
    for (const receipt of checksumReceipts) {
      if ((await sha256File(receipt.path)) !== receipt.sha256) {
        throw new Error(`Release payload changed after SHA256SUMS was created: ${receipt.path}`)
      }
    }
    if ((await sha256File(checksumsPath)) !== manifestValue.checksums.sha256) {
      throw new Error("SHA256SUMS changed after release manifest creation")
    }
    if ((await sha256File(manifestPath)) !== manifestSha256) {
      throw new Error("Release manifest changed before package commit")
    }
    if (signatureReceipt) await assertReleaseSignatureReceipt(signatureReceipt)

    assertPackagingActive(signal)
    const recheckedOutputDirectory = await resolveManagedReleaseDestination({
      trustedRoot: verifiedSource.root,
      allowedBaseSegments: ["dist", "release"],
      requestedDestination: args.outputDirectory,
    })
    if (recheckedOutputDirectory !== safeOutputDirectory) {
      throw new Error("Release destination changed during packaging")
    }
    if (validatedPromotionInput && promotionRecordPath) {
      if (args.channel !== "beta" && args.channel !== "stable") {
        throw new Error(`Promotion record became invalid for channel ${args.channel}`)
      }
      const revalidatedPromotion = await validateReleasePromotionRecord({
        recordPath: promotionRecordPath,
        expectedVersion: packageJson.version,
        expectedChannel: args.channel,
        expectedRepository: verifiedSource.repository,
        expectedCommit: args.sourceCommit,
        expectedSourceFingerprintSha256: sourceFingerprintSha256,
        support: supportBinding,
        supportPolicy,
        publishedAt: args.publishedAt,
        artifacts: promotedArtifactInputs,
      })
      if (revalidatedPromotion.sha256 !== validatedPromotionInput.sha256) {
        throw new Error("Promotion record changed before release commit")
      }
    }
    await assertExactReleaseInventory(
      releaseDirectory,
      new Set([
        ...checksumReceipts.map((receipt) => portable(relative(releaseDirectory, receipt.path))),
        checksumsPayload.path,
        portable(relative(releaseDirectory, manifestPath)),
        ...(signatureRelativePath ? [signatureRelativePath] : []),
      ]),
    )
    assertPackagingActive(signal)
    await rename(releaseDirectory, safeOutputDirectory)
    committed = true
    await removeManagedReleaseOperation(stagingBase, operationDirectory).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`ralph release package: committed with stale staging (${message})\n`)
    })
    process.stdout.write(
      `${JSON.stringify({
        status: promotionRecordPath ? "packaged-tested" : "packaged-not-tested",
        version: packageJson.version,
        channel: args.channel,
        output: safeOutputDirectory,
        manifest: resolve(safeOutputDirectory, "release-manifest.json"),
        signature: manifestValue.signature.status,
        supportPolicySha256,
        supportMatrix: supportPolicy.matrix.map((entry) => ({
          target: entry.target,
          status: entry.status,
          ...(entry.status === "not-promoted" ? { reason: entry.reason } : {}),
          capabilities: entry.capabilities,
        })),
        targets: releaseTargets,
      })}\n`,
    )
  } catch (error) {
    if (committed) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Release was committed at ${safeOutputDirectory}, but post-commit reporting failed: ${message}`,
        { cause: error },
      )
    }
    await removeManagedReleaseOperation(stagingBase, operationDirectory).catch(() => undefined)
    throw error
  }
}

const releaseAbort = new AbortController()
const releaseShutdown = new TwoPhaseShutdownController({ abortController: releaseAbort })
const cancelFromProcessSignal = (name: "SIGINT" | "SIGTERM") => (): void => {
  releaseShutdown.handleSignal(name)
}
const cancelFromSigint = cancelFromProcessSignal("SIGINT")
const cancelFromSigterm = cancelFromProcessSignal("SIGTERM")
process.on("SIGINT", cancelFromSigint)
process.on("SIGTERM", cancelFromSigterm)

try {
  await packageRelease(releaseAbort.signal)
  if (releaseAbort.signal.aborted) process.exitCode = 130
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`ralph release package: ${message}\n`)
  process.exitCode = releaseAbort.signal.aborted ? 130 : 1
} finally {
  releaseShutdown.close()
  process.off("SIGINT", cancelFromSigint)
  process.off("SIGTERM", cancelFromSigterm)
}
