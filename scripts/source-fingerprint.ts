import { createHash, type Hash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { compareUtf8Bytes } from "./release-order"

const SOURCE_DIRECTORIES = ["apps", "packages", "scripts"] as const
const SOURCE_FILES = ["package.json", "bun.lock", "tsconfig.json"] as const
const GENERATED_DEPENDENCY_DIRECTORY = "node_modules"

async function collectFiles(path: string, output: string[]): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error(`Source fingerprint rejects symlinks: ${path}`)
  if (info.isFile()) {
    output.push(path)
    return
  }
  if (!info.isDirectory()) throw new Error(`Source fingerprint accepts regular files only: ${path}`)
  const entries = await readdir(path, { withFileTypes: true })
  entries.sort((left, right) => compareUtf8Bytes(left.name, right.name))
  for (const entry of entries) {
    // Bun materializes workspace dependency links below every package. They are
    // lockfile-derived build inputs, not source files, and must not make the
    // fingerprint depend on installation layout or symlink representation.
    if (entry.name === GENERATED_DEPENDENCY_DIRECTORY) continue
    if (entry.isSymbolicLink())
      throw new Error(`Source fingerprint rejects symlinks: ${join(path, entry.name)}`)
    await collectFiles(join(path, entry.name), output)
  }
}

async function hashFileInto(hash: Hash, path: string): Promise<void> {
  const initial = await lstat(path)
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new Error(`Source fingerprint input must be a regular file: ${path}`)
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
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
      throw new Error(`Source fingerprint input changed before open: ${path}`)
    }
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < opened.size) {
      const maximum = Math.min(buffer.byteLength, opened.size - position)
      const result = await handle.read(buffer, 0, maximum, position)
      if (result.bytesRead <= 0) throw new Error(`Source fingerprint input ended early: ${path}`)
      hash.update(buffer.subarray(0, result.bytesRead))
      position += result.bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await handle.read(extra, 0, 1, opened.size)).bytesRead !== 0) {
      throw new Error(`Source fingerprint input grew while reading: ${path}`)
    }
    const settled = await handle.stat()
    if (
      settled.dev !== opened.dev ||
      settled.ino !== opened.ino ||
      settled.size !== opened.size ||
      settled.mtimeMs !== opened.mtimeMs ||
      settled.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error(`Source fingerprint input changed while reading: ${path}`)
    }
  } finally {
    await handle.close()
  }
}

export async function sourceFingerprint(projectRoot: string): Promise<string> {
  const root = resolve(projectRoot)
  const files: string[] = []
  for (const directory of SOURCE_DIRECTORIES) {
    await collectFiles(join(root, directory), files)
  }
  for (const file of SOURCE_FILES) files.push(join(root, file))
  files.sort(compareUtf8Bytes)

  const hasher = createHash("sha256")
  for (const file of files) {
    const path = relative(root, file).replaceAll("\\", "/")
    hasher.update(`${path}\0`)
    await hashFileInto(hasher, file)
    hasher.update("\0")
  }
  return hasher.digest("hex")
}
