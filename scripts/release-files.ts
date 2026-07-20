import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { compareUtf8Bytes } from "./release-order"

export interface VerifiedFileReceipt {
  readonly source: string
  readonly destination: string
  readonly sizeBytes: number
  readonly sha256: string
}

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

function containsC0OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function assertPortableSegment(segment: string): void {
  if (
    segment !== segment.normalize("NFC") ||
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    containsC0OrDeleteControl(segment) ||
    /[<>:"|?*]/u.test(segment) ||
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    WINDOWS_RESERVED_SEGMENT.test(segment)
  ) {
    throw new Error(`Unsafe managed release path segment: ${segment}`)
  }
}

async function lstatIfPresent(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * Creates a directory chain one component at a time while rejecting symlinks,
 * junctions/reparse points reported as links, non-directories and canonical
 * escapes. Callers retain an allowed-base check for the final destination.
 */
export async function prepareManagedReleaseDirectory(
  trustedRootPath: string,
  relativeSegments: readonly string[],
): Promise<string> {
  const requestedRoot = resolve(trustedRootPath)
  const root = await realpath(requestedRoot)
  const rootInformation = await lstat(root)
  if (!rootInformation.isDirectory() || rootInformation.isSymbolicLink()) {
    throw new Error(`Managed release root must resolve to a regular directory: ${requestedRoot}`)
  }
  let current = root
  for (const segment of relativeSegments) {
    assertPortableSegment(segment)
    const requested = resolve(current, segment)
    if (!inside(root, requested))
      throw new Error(`Managed release directory escapes root: ${requested}`)
    const existing = await lstatIfPresent(requested)
    if (!existing) await mkdir(requested, { recursive: false })
    const information = await lstat(requested)
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error(`Managed release path is not a regular directory: ${requested}`)
    }
    const canonical = await realpath(requested)
    if (!inside(root, canonical)) {
      throw new Error(`Managed release directory resolves outside its root: ${requested}`)
    }
    current = canonical
  }
  return current
}

export async function resolveManagedReleaseDestination(input: {
  readonly trustedRoot: string
  readonly allowedBaseSegments: readonly string[]
  readonly requestedDestination: string
}): Promise<string> {
  const root = await realpath(resolve(input.trustedRoot))
  const lexicalBase = resolve(root, ...input.allowedBaseSegments)
  const lexicalDestination = resolve(input.requestedDestination)
  if (!inside(lexicalBase, lexicalDestination)) {
    throw new Error(`Managed release destination escapes its allowed base: ${lexicalDestination}`)
  }
  const relativeDestination = relative(lexicalBase, lexicalDestination)
  const destinationSegments = relativeDestination.split(sep)
  for (const segment of [...input.allowedBaseSegments, ...destinationSegments]) {
    assertPortableSegment(segment)
  }
  const parent = await prepareManagedReleaseDirectory(root, [
    ...input.allowedBaseSegments,
    ...destinationSegments.slice(0, -1),
  ])
  const destination = resolve(parent, destinationSegments.at(-1) ?? "")
  if (await lstatIfPresent(destination)) {
    throw new Error(`Managed release destination already exists: ${destination}`)
  }
  return destination
}

export async function removeManagedReleaseOperation(
  stagingBasePath: string,
  operationDirectoryPath: string,
): Promise<void> {
  const stagingBase = await realpath(resolve(stagingBasePath))
  const operationDirectory = resolve(operationDirectoryPath)
  if (dirname(operationDirectory) !== stagingBase || !inside(stagingBase, operationDirectory)) {
    throw new Error(
      `Managed release cleanup target is not a direct staging child: ${operationDirectory}`,
    )
  }
  const information = await lstatIfPresent(operationDirectory)
  if (!information) return
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(
      `Managed release cleanup target is not a regular directory: ${operationDirectory}`,
    )
  }
  const canonicalOperation = await realpath(operationDirectory)
  if (!inside(stagingBase, canonicalOperation) || dirname(canonicalOperation) !== stagingBase) {
    throw new Error(
      `Managed release cleanup target resolves outside staging: ${operationDirectory}`,
    )
  }
  const quarantine = resolve(stagingBase, `.cleanup-${randomUUID()}`)
  await rename(operationDirectory, quarantine)
  const quarantinedInformation = await lstat(quarantine)
  if (!quarantinedInformation.isDirectory() || quarantinedInformation.isSymbolicLink()) {
    throw new Error(`Managed release cleanup quarantine is not a regular directory: ${quarantine}`)
  }
  const canonicalQuarantine = await realpath(quarantine)
  if (!inside(stagingBase, canonicalQuarantine) || dirname(canonicalQuarantine) !== stagingBase) {
    throw new Error(`Managed release cleanup quarantine escaped staging: ${quarantine}`)
  }
  await rm(quarantine, { recursive: true, force: false })
}

export async function assertRegularReleaseFile(path: string, label: string): Promise<void> {
  const information = await lstat(path).catch(() => undefined)
  if (!information?.isFile() || information.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`)
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  position: number,
): Promise<number> {
  let written = 0
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      position + written,
    )
    if (result.bytesWritten <= 0) throw new Error("Verified release copy made no write progress")
    written += result.bytesWritten
  }
  return position + written
}

export async function copyRegularVerified(
  sourcePath: string,
  destinationPath: string,
  options: {
    readonly expectedSha256?: string
    readonly expectedSizeBytes?: number
    readonly executable?: boolean
  } = {},
): Promise<VerifiedFileReceipt> {
  const source = resolve(sourcePath)
  const destination = resolve(destinationPath)
  if (source === destination) {
    throw new Error(`Verified release copy source and destination must differ: ${source}`)
  }
  const initial = await lstat(source).catch(() => undefined)
  if (!initial?.isFile() || initial.isSymbolicLink()) {
    throw new Error(`Verified release copy source must be a regular file: ${source}`)
  }
  if (options.expectedSizeBytes !== undefined && initial.size !== options.expectedSizeBytes) {
    throw new Error(`Verified release copy source size mismatch: ${source}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const input = await open(source, constants.O_RDONLY | noFollow)
  let output: Awaited<ReturnType<typeof open>> | undefined
  let destinationCreated = false
  try {
    const opened = await input.stat()
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      opened.size !== initial.size ||
      opened.mtimeMs !== initial.mtimeMs ||
      opened.ctimeMs !== initial.ctimeMs
    ) {
      throw new Error(`Verified release copy source changed before open: ${source}`)
    }
    output = await open(destination, "wx", 0o600)
    destinationCreated = true
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let inputPosition = 0
    let outputPosition = 0
    while (inputPosition < opened.size) {
      const maximum = Math.min(buffer.byteLength, opened.size - inputPosition)
      const result = await input.read(buffer, 0, maximum, inputPosition)
      if (result.bytesRead <= 0) throw new Error(`Verified release copy ended early: ${source}`)
      const chunk = buffer.subarray(0, result.bytesRead)
      hash.update(chunk)
      outputPosition = await writeAll(output, chunk, outputPosition)
      inputPosition += result.bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await input.read(extra, 0, 1, opened.size)).bytesRead !== 0) {
      throw new Error(`Verified release copy source grew while reading: ${source}`)
    }
    const settled = await input.stat()
    if (
      settled.dev !== opened.dev ||
      settled.ino !== opened.ino ||
      settled.size !== opened.size ||
      settled.mtimeMs !== opened.mtimeMs ||
      settled.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`Verified release copy source changed while reading: ${source}`)
    }
    const sha256 = hash.digest("hex")
    if (options.expectedSha256 && sha256 !== options.expectedSha256.toLowerCase()) {
      throw new Error(`Verified release copy SHA-256 mismatch: ${source}`)
    }
    await output.truncate(outputPosition)
    await output.chmod(options.executable ? 0o755 : 0o644)
    await output.sync()
    await output.close()
    output = undefined
    return { source, destination, sizeBytes: outputPosition, sha256 }
  } catch (error) {
    if (output) await output.close().catch(() => undefined)
    if (destinationCreated) await unlink(destination).catch(() => undefined)
    throw error
  } finally {
    await input.close()
  }
}

export async function copyRegularDirectoryVerified(
  sourcePath: string,
  destinationPath: string,
): Promise<readonly VerifiedFileReceipt[]> {
  const requestedSource = resolve(sourcePath)
  const initial = await lstat(requestedSource).catch(() => undefined)
  if (!initial?.isDirectory() || initial.isSymbolicLink()) {
    throw new Error(`Verified release copy source must be a regular directory: ${requestedSource}`)
  }
  const sourceRoot = await realpath(requestedSource)
  const destinationRoot = resolve(destinationPath)
  if (
    sourceRoot === destinationRoot ||
    inside(sourceRoot, destinationRoot) ||
    inside(destinationRoot, sourceRoot)
  ) {
    throw new Error("Verified release directory source and destination must not overlap")
  }
  await mkdir(dirname(destinationRoot), { recursive: true })
  await mkdir(destinationRoot, { recursive: false })
  const receipts: VerifiedFileReceipt[] = []

  const visit = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
    const entries = await readdir(sourceDirectory, { withFileTypes: true })
    entries.sort((left, right) => compareUtf8Bytes(left.name, right.name))
    for (const entry of entries) {
      const source = resolve(sourceDirectory, entry.name)
      const destination = resolve(destinationDirectory, entry.name)
      if (!inside(sourceRoot, source) || !inside(destinationRoot, destination)) {
        throw new Error(`Verified release directory copy escaped its root: ${source}`)
      }
      const information = await lstat(source)
      if (information.isSymbolicLink()) {
        throw new Error(`Verified release directory copy rejects symlinks: ${source}`)
      }
      const canonical = await realpath(source)
      if (!inside(sourceRoot, canonical)) {
        throw new Error(`Verified release directory entry resolves outside source: ${source}`)
      }
      if (information.isDirectory()) {
        await mkdir(destination, { recursive: false })
        await visit(source, destination)
      } else if (information.isFile()) {
        receipts.push(await copyRegularVerified(source, destination))
      } else {
        throw new Error(`Verified release directory accepts regular files only: ${source}`)
      }
    }
  }
  await visit(sourceRoot, destinationRoot)
  return receipts
}
