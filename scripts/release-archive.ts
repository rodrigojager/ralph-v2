import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { compareUtf8Bytes } from "./release-order"

const TAR_BLOCK_BYTES = 512
const TAR_NAME_BYTES = 100
const TAR_PREFIX_BYTES = 155

function containsC0OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

export interface ReleaseArchiveEntry {
  readonly absolutePath: string
  readonly archivePath: string
  readonly executable: boolean
  readonly size: number
  readonly device: number
  readonly inode: number
  readonly modifiedMilliseconds: number
  readonly changedMilliseconds: number
}

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

function validateArchiveSegment(segment: string, source: string): string {
  if (
    segment !== segment.normalize("NFC") ||
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    containsC0OrDeleteControl(segment) ||
    /[<>:"|?*]/u.test(segment) ||
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    WINDOWS_RESERVED_NAME.test(segment)
  ) {
    throw new Error(`Unsafe cross-platform release archive segment in ${source}: ${segment}`)
  }
  return segment
}

function archivePathFor(root: string, candidate: string): string {
  const child = relative(root, candidate)
  if (
    child === "" ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child) ||
    /^[A-Za-z]:/u.test(child)
  ) {
    throw new Error(`Release archive entry escapes source root: ${candidate}`)
  }
  const segments = child.split(sep).map((segment) => validateArchiveSegment(segment, candidate))
  const path = segments.join("/")
  if (path.startsWith("/") || path.includes("//")) {
    throw new Error(`Unsafe normalized release archive path: ${path}`)
  }
  return path
}

function collisionKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("und")
}

function writeText(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.byteLength > length) throw new Error(`Tar header value is too long: ${value}`)
  bytes.copy(target, offset)
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid tar integer: ${value}`)
  const octal = value.toString(8)
  if (octal.length > length - 1) throw new Error(`Tar integer exceeds field width: ${value}`)
  writeText(target, offset, length, `${octal.padStart(length - 1, "0")}\0`)
}

function splitArchivePath(path: string): { name: string; prefix: string } {
  const encoded = Buffer.byteLength(path, "utf8")
  if (encoded <= TAR_NAME_BYTES) return { name: path, prefix: "" }
  const separators = [...path.matchAll(/\//gu)].map((match) => match.index ?? -1).reverse()
  for (const index of separators) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (
      Buffer.byteLength(prefix, "utf8") <= TAR_PREFIX_BYTES &&
      Buffer.byteLength(name, "utf8") <= TAR_NAME_BYTES
    ) {
      return { name, prefix }
    }
  }
  throw new Error(`Release archive path exceeds ustar limits: ${path}`)
}

function tarHeader(entry: ReleaseArchiveEntry, epochSeconds: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES)
  const { name, prefix } = splitArchivePath(entry.archivePath)
  writeText(header, 0, 100, name)
  writeOctal(header, 100, 8, entry.executable ? 0o755 : 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, entry.size)
  writeOctal(header, 136, 12, epochSeconds)
  header.fill(0x20, 148, 156)
  writeText(header, 156, 1, "0")
  writeText(header, 257, 6, "ustar\0")
  writeText(header, 263, 2, "00")
  writeText(header, 345, 155, prefix)
  let checksum = 0
  for (const byte of header) checksum += byte
  const checksumText = checksum.toString(8)
  if (checksumText.length > 6) throw new Error(`Tar checksum exceeds field width: ${checksum}`)
  writeText(header, 148, 8, `${checksumText.padStart(6, "0")}\0 `)
  return header
}

async function collectEntries(
  root: string,
  current: string,
  output: ReleaseArchiveEntry[],
  executablePaths: ReadonlySet<string>,
): Promise<void> {
  const children = await readdir(current, { withFileTypes: true })
  children.sort((left, right) => compareUtf8Bytes(left.name, right.name))
  for (const child of children) {
    const absolutePath = resolve(current, child.name)
    if (!inside(root, absolutePath))
      throw new Error(`Archive entry escapes source root: ${absolutePath}`)
    const information = await lstat(absolutePath)
    if (information.isSymbolicLink()) {
      throw new Error(`Release archives cannot contain symbolic links: ${absolutePath}`)
    }
    if (information.isDirectory()) {
      await collectEntries(root, absolutePath, output, executablePaths)
      continue
    }
    if (!information.isFile()) {
      throw new Error(`Release archives accept regular files only: ${absolutePath}`)
    }
    const archivePath = archivePathFor(root, absolutePath)
    output.push({
      absolutePath,
      archivePath,
      executable: executablePaths.has(archivePath) || (information.mode & 0o111) !== 0,
      size: information.size,
      device: information.dev,
      inode: information.ino,
      modifiedMilliseconds: information.mtimeMs,
      changedMilliseconds: information.ctimeMs,
    })
  }
}

async function writeBuffer(
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
    if (result.bytesWritten <= 0) throw new Error("Release archive write made no progress")
    written += result.bytesWritten
  }
  return position + written
}

async function writeEntryContents(
  output: Awaited<ReturnType<typeof open>>,
  entry: ReleaseArchiveEntry,
  outputPosition: number,
  expectedSha256?: string,
): Promise<number> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const input = await open(entry.absolutePath, constants.O_RDONLY | noFollow)
  try {
    const opened = await input.stat()
    if (
      !opened.isFile() ||
      opened.size !== entry.size ||
      opened.dev !== entry.device ||
      opened.ino !== entry.inode ||
      opened.mtimeMs !== entry.modifiedMilliseconds ||
      opened.ctimeMs !== entry.changedMilliseconds
    ) {
      throw new Error(`Release archive input changed before it was opened: ${entry.absolutePath}`)
    }
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const hash = expectedSha256 ? createHash("sha256") : undefined
    let inputPosition = 0
    let position = outputPosition
    while (inputPosition < entry.size) {
      const maximum = Math.min(buffer.byteLength, entry.size - inputPosition)
      const result = await input.read(buffer, 0, maximum, inputPosition)
      if (result.bytesRead <= 0) {
        throw new Error(`Release archive input ended early: ${entry.absolutePath}`)
      }
      const chunk = buffer.subarray(0, result.bytesRead)
      hash?.update(chunk)
      position = await writeBuffer(output, chunk, position)
      inputPosition += result.bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await input.read(extra, 0, 1, entry.size)).bytesRead !== 0) {
      throw new Error(`Release archive input grew while being read: ${entry.absolutePath}`)
    }
    const settled = await input.stat()
    if (
      settled.size !== opened.size ||
      settled.dev !== opened.dev ||
      settled.ino !== opened.ino ||
      settled.mtimeMs !== opened.mtimeMs ||
      settled.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`Release archive input changed while being read: ${entry.absolutePath}`)
    }
    if (hash && hash.digest("hex") !== expectedSha256) {
      throw new Error(
        `Release archive input differs from its expected receipt: ${entry.archivePath}`,
      )
    }
    return position
  } finally {
    await input.close()
  }
}

export async function createDeterministicTar(
  sourceDirectory: string,
  destination: string,
  epochSeconds: number,
  options: {
    readonly executablePaths?: readonly string[]
    readonly expectedSha256ByPath?: Readonly<Record<string, string>>
  } = {},
): Promise<readonly ReleaseArchiveEntry[]> {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0) {
    throw new Error(`Release archive epoch must be a non-negative integer: ${epochSeconds}`)
  }
  const source = resolve(sourceDirectory)
  const target = resolve(destination)
  const sourceInformation = await lstat(source)
  if (!sourceInformation.isDirectory() || sourceInformation.isSymbolicLink()) {
    throw new Error(`Release archive source must be a regular directory: ${source}`)
  }
  if (inside(source, target) || target === source) {
    throw new Error(`Release archive destination cannot be inside its source: ${target}`)
  }
  const entries: ReleaseArchiveEntry[] = []
  const executablePaths = new Set(
    (options.executablePaths ?? []).map((path) => {
      const segments = path.split("/").map((segment) => validateArchiveSegment(segment, path))
      const normalized = segments.join("/")
      if (normalized !== path) throw new Error(`Executable archive path is not normalized: ${path}`)
      return normalized
    }),
  )
  await collectEntries(source, source, entries, executablePaths)
  if (entries.length === 0) throw new Error(`Release archive cannot be empty: ${source}`)
  const seenArchivePaths = new Map<string, string>()
  for (const entry of entries) {
    const key = collisionKey(entry.archivePath)
    const previous = seenArchivePaths.get(key)
    if (previous) {
      throw new Error(
        `Release archive paths collide after cross-platform normalization: ${previous} and ${entry.archivePath}`,
      )
    }
    seenArchivePaths.set(key, entry.archivePath)
  }
  const archivedPaths = new Set(entries.map((entry) => entry.archivePath))
  for (const executablePath of executablePaths) {
    if (!archivedPaths.has(executablePath)) {
      throw new Error(`Declared executable is absent from release archive: ${executablePath}`)
    }
  }
  const expectedSha256ByPath = new Map<string, string>()
  for (const [path, sha256] of Object.entries(options.expectedSha256ByPath ?? {})) {
    const segments = path.split("/").map((segment) => validateArchiveSegment(segment, path))
    const normalized = segments.join("/")
    if (normalized !== path || !/^[0-9a-f]{64}$/u.test(sha256)) {
      throw new Error(`Invalid expected release archive receipt: ${path}`)
    }
    expectedSha256ByPath.set(path, sha256)
  }
  if (options.expectedSha256ByPath) {
    if (expectedSha256ByPath.size !== entries.length) {
      throw new Error(
        "Expected release archive receipts must cover every regular file exactly once",
      )
    }
    for (const entry of entries) {
      if (!expectedSha256ByPath.has(entry.archivePath)) {
        throw new Error(`Expected release archive receipt is missing: ${entry.archivePath}`)
      }
    }
  }

  await mkdir(dirname(target), { recursive: true })
  const handle = await open(target, "wx", 0o600)
  let position = 0
  try {
    for (const entry of entries) {
      position = await writeBuffer(handle, tarHeader(entry, epochSeconds), position)
      position = await writeEntryContents(
        handle,
        entry,
        position,
        expectedSha256ByPath.get(entry.archivePath),
      )
      const padding = (TAR_BLOCK_BYTES - (entry.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
      if (padding > 0) position = await writeBuffer(handle, Buffer.alloc(padding), position)
    }
    position = await writeBuffer(handle, Buffer.alloc(TAR_BLOCK_BYTES * 2), position)
    await handle.truncate(position)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(target).catch(() => undefined)
    throw error
  }
  try {
    await handle.close()
  } catch (error) {
    await unlink(target).catch(() => undefined)
    throw error
  }
  return entries
}
