import { createHash } from "node:crypto"
import type { Stats } from "node:fs"
import { constants } from "node:fs"
import { lstat, open } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { sourceFingerprint } from "./source-fingerprint"

export const RELEASE_TARGETS = [
  "bun-windows-x64-baseline",
  "bun-windows-arm64",
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
] as const

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number]

export const BuildMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    target: z.enum(RELEASE_TARGETS),
    status: z.literal("built-not-tested"),
    version: z.string().min(1),
    bunVersion: z.string().min(1),
    bunRevision: z.string().min(1),
    artifact: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    builtAt: z.iso.datetime({ offset: true }),
  })
  .strict()

const VersionManifestSchema = z.object({ version: z.string().min(1) }).loose()

export type BuildMetadata = z.infer<typeof BuildMetadataSchema>

export const BundleBuildMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("ralph-next-bundle"),
    target: z.literal("bun"),
    status: z.literal("built-not-tested"),
    version: z.string().min(1),
    bunVersion: z.string().min(1),
    bunRevision: z.string().min(1),
    artifact: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/iu),
    builtAt: z.iso.datetime({ offset: true }),
  })
  .strict()
export type BundleBuildMetadata = z.infer<typeof BundleBuildMetadataSchema>

export function releaseTargetFor(platform: string, architecture: string): ReleaseTarget {
  if (architecture !== "x64" && architecture !== "arm64") {
    throw new Error(`Unsupported native architecture: ${architecture}`)
  }
  if (platform === "win32") {
    return architecture === "arm64" ? "bun-windows-arm64" : "bun-windows-x64-baseline"
  }
  if (platform === "linux") {
    return architecture === "arm64" ? "bun-linux-arm64" : "bun-linux-x64-baseline"
  }
  if (platform === "darwin") {
    return architecture === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
  }
  throw new Error(`Unsupported native platform: ${platform}`)
}

export function nativeTarget(): ReleaseTarget {
  return releaseTargetFor(process.platform, process.arch)
}

export function parseBuildTargets(argv: readonly string[]): ReleaseTarget[] {
  if (argv.length === 0) return [nativeTarget()]
  if (argv.length === 1 && argv[0] === "--all") return [...RELEASE_TARGETS]
  if (argv.length === 2 && argv[0] === "--target") {
    const requested = argv[1]
    if (requested && RELEASE_TARGETS.includes(requested as ReleaseTarget)) {
      return [requested as ReleaseTarget]
    }
    throw new Error(`Unsupported target: ${requested ?? "<missing>"}`)
  }
  throw new Error(
    `Invalid build arguments: ${argv.join(" ") || "<none>"}. Use no flags, --all, or --target <target>.`,
  )
}

export async function sha256File(path: string): Promise<string> {
  const initial = await lstat(path)
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new Error(`SHA-256 input must be a regular non-symlink file: ${path}`)
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  const hash = createHash("sha256")
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      opened.size !== initial.size ||
      opened.mtimeMs !== initial.mtimeMs ||
      opened.ctimeMs !== initial.ctimeMs
    ) {
      throw new Error(`SHA-256 input changed before open: ${path}`)
    }
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < opened.size) {
      const maximum = Math.min(buffer.byteLength, opened.size - position)
      const result = await handle.read(buffer, 0, maximum, position)
      if (result.bytesRead <= 0) throw new Error(`SHA-256 input ended early: ${path}`)
      hash.update(buffer.subarray(0, result.bytesRead))
      position += result.bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await handle.read(extra, 0, 1, opened.size)).bytesRead !== 0) {
      throw new Error(`SHA-256 input grew while reading: ${path}`)
    }
    const settled = await handle.stat()
    if (
      settled.dev !== opened.dev ||
      settled.ino !== opened.ino ||
      settled.size !== opened.size ||
      settled.mtimeMs !== opened.mtimeMs ||
      settled.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`SHA-256 input changed while reading: ${path}`)
    }
    return hash.digest("hex")
  } finally {
    await handle.close()
  }
}

export async function validateStandaloneArtifact(
  binary: string,
  projectRoot: string,
  expectedTarget?: ReleaseTarget,
): Promise<{ binary: string; metadataPath: string; metadata: BuildMetadata }> {
  const resolvedBinary = resolve(binary)
  const resolvedProjectRoot = resolve(projectRoot)
  const metadataPath = join(dirname(resolvedBinary), "build-metadata.json")

  let binaryInfo: Stats
  try {
    binaryInfo = await lstat(resolvedBinary)
  } catch {
    throw new Error(`Standalone binary not found: ${resolvedBinary}. Run bun run build first.`)
  }
  if (binaryInfo.isSymbolicLink() || !binaryInfo.isFile()) {
    throw new Error(`Standalone binary must be a regular file: ${resolvedBinary}`)
  }

  let rawMetadata: unknown
  try {
    rawMetadata = JSON.parse(await Bun.file(metadataPath).text())
  } catch {
    throw new Error(`Standalone build metadata is missing or invalid: ${metadataPath}`)
  }
  const parsed = BuildMetadataSchema.safeParse(rawMetadata)
  if (!parsed.success) {
    throw new Error(`Standalone build metadata does not satisfy schema v1: ${metadataPath}`)
  }
  const metadata = parsed.data
  if (expectedTarget && metadata.target !== expectedTarget) {
    throw new Error(
      `Standalone target ${metadata.target} cannot be tested as native target ${expectedTarget}`,
    )
  }

  let manifest: z.infer<typeof VersionManifestSchema>
  try {
    manifest = VersionManifestSchema.parse(
      JSON.parse(await Bun.file(join(resolvedProjectRoot, "package.json")).text()),
    )
  } catch {
    throw new Error(`Project version manifest is missing or invalid: ${resolvedProjectRoot}`)
  }
  if (metadata.version !== manifest.version) {
    throw new Error(
      `Standalone version ${metadata.version} does not match project version ${manifest.version}`,
    )
  }
  const projectRelativeBinary = relative(resolvedProjectRoot, resolvedBinary)
  const isInsideProject =
    projectRelativeBinary !== ".." &&
    !projectRelativeBinary.startsWith(`..${sep}`) &&
    !isAbsolute(projectRelativeBinary)
  if (
    isInsideProject &&
    metadata.artifact.replaceAll("\\", "/") !== projectRelativeBinary.replaceAll("\\", "/")
  ) {
    throw new Error(`Standalone artifact path does not match build metadata: ${resolvedBinary}`)
  }

  const [artifactSha256, currentSourceSha256] = await Promise.all([
    sha256File(resolvedBinary),
    sourceFingerprint(resolvedProjectRoot),
  ])
  if (artifactSha256.toLowerCase() !== metadata.sha256.toLowerCase()) {
    throw new Error(`Standalone hash does not match build metadata: ${resolvedBinary}`)
  }
  if (currentSourceSha256.toLowerCase() !== metadata.sourceSha256.toLowerCase()) {
    throw new Error("Standalone is stale relative to current source; run `bun run build` first")
  }

  return { binary: resolvedBinary, metadataPath, metadata }
}

export async function validateBundleArtifact(
  bundle: string,
  projectRoot: string,
): Promise<{ bundle: string; metadataPath: string; metadata: BundleBuildMetadata }> {
  const resolvedBundle = resolve(bundle)
  const resolvedProjectRoot = resolve(projectRoot)
  const metadataPath = join(dirname(resolvedBundle), "bundle-build-metadata.json")
  let bundleInfo: Stats
  try {
    bundleInfo = await lstat(resolvedBundle)
  } catch {
    throw new Error(`CLI bundle not found: ${resolvedBundle}. Run the build step first.`)
  }
  if (bundleInfo.isSymbolicLink() || !bundleInfo.isFile()) {
    throw new Error(`CLI bundle must be a regular file: ${resolvedBundle}`)
  }
  let rawMetadata: unknown
  try {
    rawMetadata = JSON.parse(await Bun.file(metadataPath).text())
  } catch {
    throw new Error(`Bundle build metadata is missing or invalid: ${metadataPath}`)
  }
  const parsed = BundleBuildMetadataSchema.safeParse(rawMetadata)
  if (!parsed.success) {
    throw new Error(`Bundle build metadata does not satisfy schema v1: ${metadataPath}`)
  }
  const metadata = parsed.data
  const manifest = VersionManifestSchema.parse(
    JSON.parse(await Bun.file(join(resolvedProjectRoot, "package.json")).text()),
  )
  if (metadata.version !== manifest.version) {
    throw new Error(
      `Bundle version ${metadata.version} does not match project version ${manifest.version}`,
    )
  }
  const relativeBundle = relative(resolvedProjectRoot, resolvedBundle)
  if (
    relativeBundle === "" ||
    relativeBundle === ".." ||
    relativeBundle.startsWith(`..${sep}`) ||
    isAbsolute(relativeBundle) ||
    metadata.artifact.replaceAll("\\", "/") !== relativeBundle.replaceAll("\\", "/")
  ) {
    throw new Error(`Bundle artifact path does not match build metadata: ${resolvedBundle}`)
  }
  const [artifactSha256, currentSourceSha256] = await Promise.all([
    sha256File(resolvedBundle),
    sourceFingerprint(resolvedProjectRoot),
  ])
  if (artifactSha256.toLowerCase() !== metadata.sha256.toLowerCase()) {
    throw new Error(`CLI bundle hash does not match build metadata: ${resolvedBundle}`)
  }
  if (currentSourceSha256.toLowerCase() !== metadata.sourceSha256.toLowerCase()) {
    throw new Error("CLI bundle is stale relative to current source; rebuild before packaging")
  }
  return { bundle: resolvedBundle, metadataPath, metadata }
}
