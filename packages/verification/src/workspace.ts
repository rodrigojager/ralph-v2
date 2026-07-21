import { createHash, randomUUID } from "node:crypto"
import { createReadStream, type Dirent } from "node:fs"
import { link, lstat, mkdir, open, readdir, readlink, realpath, unlink } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { processShutdownRegistry } from "@ralph/supervisor"

export type FileSnapshot = {
  kind: "file" | "symlink"
  sha256: string
  size: number
  retentionStatus:
    | "retained"
    | "inventory-only"
    | "out-of-scope"
    | "sensitive"
    | "per-file-limit"
    | "total-limit"
    | "control-plane"
  contentRef?: string
}

export type WorkspaceBaseline = {
  schemaVersion: 1
  capturedAt: string
  scope: string
  files: Record<string, FileSnapshot>
  git: {
    available: boolean
    dirty: boolean
    head?: string
    branch?: string
    statusHash?: string
  }
  snapshotHash: string
}

export type WorkspaceChanges = {
  schemaVersion: 1
  created: string[]
  modified: string[]
  deleted: string[]
  changed: string[]
  outsideScope: string[]
  hasChanges: boolean
  beforeHash: string
  afterHash: string
}

export type ContentAddressedStore = {
  directory: string
}

export type FrozenContent = {
  contentHash: string
  sizeBytes: number
  ref: string
}

export type CaptureWorkspaceOptions = {
  scope?: string
  ignore?: readonly string[]
  maxFiles?: number
  maxRetainedFileBytes?: number
  maxTotalRetainedBytes?: number
  retentionPriorityPaths?: readonly string[]
  objectStore?: ContentAddressedStore
  /** Root used only for immutable object references from an isolated worktree. */
  storageRoot?: string
}

export const DEFAULT_MAX_RETAINED_FILE_BYTES = 1_048_576
export const DEFAULT_MAX_TOTAL_RETAINED_BYTES = 16_777_216

const CONTROL_DIRECTORIES = new Set([".git", ".ralph"])
const GIT_FACT_PREFIX = ".git/ralph-observed/"
const MAX_GIT_POINTER_BYTES = 65_536
const SENSITIVE_FILE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "credentials",
  "secrets",
])

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function isSensitiveWorkspacePath(path: string): boolean {
  const name = portable(path).split("/").at(-1)?.toLowerCase() ?? ""
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name.endsWith(".pem") ||
    name.endsWith(".key") ||
    SENSITIVE_FILE_NAMES.has(name) ||
    name.startsWith("credentials.") ||
    name.startsWith("secrets.")
  )
}

async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest("hex")
}

function metadataFingerprint(value: {
  dev: number
  ino: number
  mode: number
  size: number
  mtimeMs: number
  ctimeMs: number
}): string {
  return [value.dev, value.ino, value.mode, value.size, value.mtimeMs, value.ctimeMs].join(":")
}

async function readStableFile(path: string): Promise<Uint8Array> {
  const beforePath = await lstat(path)
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error(`Workspace file changed type while being captured: ${path}`)
  }
  const handle = await open(path, "r")
  try {
    const beforeHandle = await handle.stat()
    if (!beforeHandle.isFile()) throw new Error(`Workspace entry is no longer a file: ${path}`)
    if (metadataFingerprint(beforePath) !== metadataFingerprint(beforeHandle)) {
      throw new Error(`Workspace file was replaced while being captured: ${path}`)
    }
    const bytes = await handle.readFile()
    const afterHandle = await handle.stat()
    const afterPath = await lstat(path)
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      metadataFingerprint(beforeHandle) !== metadataFingerprint(afterHandle) ||
      metadataFingerprint(afterHandle) !== metadataFingerprint(afterPath) ||
      bytes.byteLength !== afterHandle.size
    ) {
      throw new Error(`Workspace file changed while being captured: ${path}`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function hashStableFile(path: string): Promise<{ sha256: string; size: number }> {
  const beforePath = await lstat(path)
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error(`Workspace file changed type while being hashed: ${path}`)
  }
  const handle = await open(path, "r")
  try {
    const beforeHandle = await handle.stat()
    if (
      !beforeHandle.isFile() ||
      metadataFingerprint(beforePath) !== metadataFingerprint(beforeHandle)
    ) {
      throw new Error(`Workspace file was replaced while being hashed: ${path}`)
    }
    const digest = createHash("sha256")
    let size = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk)
      size += chunk.byteLength
    }
    const afterHandle = await handle.stat()
    const afterPath = await lstat(path)
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      metadataFingerprint(beforeHandle) !== metadataFingerprint(afterHandle) ||
      metadataFingerprint(afterHandle) !== metadataFingerprint(afterPath) ||
      size !== afterHandle.size
    ) {
      throw new Error(`Workspace file changed while being hashed: ${path}`)
    }
    return { sha256: digest.digest("hex"), size }
  } finally {
    await handle.close()
  }
}

async function readStableSymlink(path: string): Promise<Uint8Array> {
  const before = await lstat(path)
  if (!before.isSymbolicLink()) throw new Error(`Workspace entry is no longer a symlink: ${path}`)
  const first = await readlink(path, { encoding: "buffer" })
  const after = await lstat(path)
  const second = await readlink(path, { encoding: "buffer" })
  if (
    !after.isSymbolicLink() ||
    metadataFingerprint(before) !== metadataFingerprint(after) ||
    !first.equals(second)
  ) {
    throw new Error(`Workspace symlink changed while being captured: ${path}`)
  }
  return first
}

async function gitControlSnapshot(
  absolute: string,
  virtualPath: string,
): Promise<[string, FileSnapshot] | undefined> {
  const path = portable(virtualPath)
  try {
    const metadata = await lstat(absolute)
    if (metadata.isSymbolicLink()) {
      const bytes = await readStableSymlink(absolute)
      return [
        path,
        {
          kind: "symlink",
          sha256: sha256(bytes),
          size: bytes.byteLength,
          retentionStatus: "control-plane",
        },
      ]
    }
    if (!metadata.isFile()) return undefined
    const hashed = await hashStableFile(absolute)
    return [
      path,
      {
        kind: "file",
        sha256: hashed.sha256,
        size: hashed.size,
        retentionStatus: "control-plane",
      },
    ]
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

async function readGitPointer(path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined
    if (metadata.size > MAX_GIT_POINTER_BYTES) {
      throw new Error(`Git control pointer exceeds ${MAX_GIT_POINTER_BYTES} bytes: ${path}`)
    }
    return Buffer.from(await readStableFile(path))
      .toString("utf8")
      .trim()
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

async function resolvedGitDirectory(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
}

async function scanGitControlFacts(
  root: string,
  maxFiles: number,
): Promise<Record<string, FileSnapshot>> {
  const facts: Record<string, FileSnapshot> = {}
  const gitPath = resolve(root, ".git")
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(gitPath)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return facts
    throw error
  }
  let factCount = 0
  const addSnapshot = async (absolute: string, virtualPath: string): Promise<void> => {
    const normalizedVirtualPath = portable(virtualPath)
    if (
      normalizedVirtualPath.startsWith(".git/refs/heads/ralph/") ||
      normalizedVirtualPath.startsWith(".git/common/refs/heads/ralph/")
    ) {
      // Parallel lanes move their command-owned attempt refs independently.
      // Those refs are bound and verified by the Git integration records; a
      // sibling lane must not mistake that expected control-plane movement for
      // an executor workspace mutation.
      return
    }
    const snapshot = await gitControlSnapshot(absolute, virtualPath)
    if (!snapshot) return
    facts[snapshot[0]] = snapshot[1]
    factCount += 1
    if (factCount > maxFiles) {
      throw new Error(`Git control snapshot exceeds the ${maxFiles} file limit`)
    }
  }
  const walk = async (directory: string, virtualRoot: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === "ENOENT") return
      throw error
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const target = resolve(directory, entry.name)
      const targetMetadata = await lstat(target)
      if (targetMetadata.isDirectory() && !targetMetadata.isSymbolicLink()) {
        await walk(target, `${virtualRoot}/${entry.name}`)
      } else {
        await addSnapshot(target, `${virtualRoot}/${entry.name}`)
      }
    }
  }

  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    for (const name of ["config", "HEAD", "index", "packed-refs"]) {
      await addSnapshot(resolve(gitPath, name), `.git/${name}`)
    }
    await walk(resolve(gitPath, "refs"), ".git/refs")
    await walk(resolve(gitPath, "hooks"), ".git/hooks")
    return facts
  }

  await addSnapshot(gitPath, ".git")
  const pointer = await readGitPointer(gitPath)
  const match = pointer?.match(/^gitdir:\s*(.+)$/i)
  if (!match?.[1]) return facts
  const gitDirectory = await resolvedGitDirectory(resolve(dirname(gitPath), match[1].trim()))
  if (!gitDirectory) return facts

  const commonPointer = await readGitPointer(resolve(gitDirectory, "commondir"))
  const commonDirectory = commonPointer
    ? await resolvedGitDirectory(resolve(gitDirectory, commonPointer))
    : gitDirectory
  for (const name of ["HEAD", "index", "config", "packed-refs"]) {
    await addSnapshot(resolve(gitDirectory, name), `.git/worktree/${name}`)
  }
  await walk(resolve(gitDirectory, "refs"), ".git/worktree/refs")
  await walk(resolve(gitDirectory, "hooks"), ".git/worktree/hooks")

  if (commonDirectory && commonDirectory !== gitDirectory) {
    for (const name of ["config", "HEAD", "index", "packed-refs"]) {
      await addSnapshot(resolve(commonDirectory, name), `.git/common/${name}`)
    }
    await walk(resolve(commonDirectory, "refs"), ".git/common/refs")
    await walk(resolve(commonDirectory, "hooks"), ".git/common/hooks")
  }
  return facts
}

async function verifiedStoreRoot(workspaceRoot: string, directory: string): Promise<string> {
  const requested = resolve(workspaceRoot, directory)
  if (!contained(workspaceRoot, requested)) {
    throw new Error(`Content-addressed store escapes the workspace: ${directory}`)
  }
  await mkdir(requested, { recursive: true })
  const canonical = await realpath(requested)
  if (!contained(workspaceRoot, canonical)) {
    throw new Error(`Content-addressed store resolves outside the workspace: ${directory}`)
  }
  return canonical
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

export async function persistContentAddressedBytes(
  workspaceRoot: string,
  store: ContentAddressedStore,
  value: Uint8Array,
  options: { suffix?: string; expectedHash?: string } = {},
): Promise<FrozenContent> {
  const root = await realpath(resolve(workspaceRoot))
  const suffix = options.suffix ?? ""
  if (suffix !== "" && !/^\.[a-z0-9][a-z0-9._-]*$/i.test(suffix)) {
    throw new Error(`Invalid content-addressed object suffix: ${suffix}`)
  }
  const contentHash = sha256(value)
  if (options.expectedHash !== undefined && options.expectedHash !== contentHash) {
    throw new Error(
      `Content hash mismatch before persistence: expected ${options.expectedHash}, received ${contentHash}`,
    )
  }
  const storeRoot = await verifiedStoreRoot(root, store.directory)
  const bucket = resolve(storeRoot, "sha256", contentHash.slice(0, 2))
  await mkdir(bucket, { recursive: true })
  const canonicalBucket = await realpath(bucket)
  if (!contained(storeRoot, canonicalBucket)) {
    throw new Error("Content-addressed object bucket resolves outside its store")
  }
  const target = resolve(canonicalBucket, `${contentHash}${suffix}`)
  const temporary = resolve(canonicalBucket, `.${contentHash}.${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    try {
      await link(temporary, target)
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error
    })
  }
  const metadata = await lstat(target)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Content-addressed object is not a regular file: ${target}`)
  }
  if (metadata.size !== value.byteLength || (await fileHash(target)) !== contentHash) {
    throw new Error(`Content-addressed object failed integrity verification: ${target}`)
  }
  return {
    contentHash,
    sizeBytes: value.byteLength,
    ref: portable(relative(root, target)),
  }
}

async function persistStableWorkspaceFile(
  workspaceRoot: string,
  absolute: string,
  store: ContentAddressedStore,
  expected: { sha256: string; size: number },
  storageRoot = workspaceRoot,
): Promise<FrozenContent> {
  const root = await realpath(resolve(workspaceRoot))
  const storage = await realpath(resolve(storageRoot))
  if (!contained(root, absolute)) throw new Error(`Workspace file escapes the root: ${absolute}`)
  const beforePath = await lstat(absolute)
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size !== expected.size) {
    throw new Error(`Workspace file changed before retention recapture: ${absolute}`)
  }

  const storeRoot = await verifiedStoreRoot(storage, store.directory)
  const bucket = resolve(storeRoot, "sha256", expected.sha256.slice(0, 2))
  await mkdir(bucket, { recursive: true })
  const canonicalBucket = await realpath(bucket)
  if (!contained(storeRoot, canonicalBucket)) {
    throw new Error("Content-addressed object bucket resolves outside its store")
  }
  const target = resolve(canonicalBucket, expected.sha256)
  const temporary = resolve(canonicalBucket, `.${expected.sha256}.${randomUUID()}.tmp`)
  const source = await open(absolute, "r")
  let destination: Awaited<ReturnType<typeof open>> | undefined
  let captureFailed = false
  let captureError: unknown
  try {
    const beforeHandle = await source.stat()
    if (
      !beforeHandle.isFile() ||
      metadataFingerprint(beforePath) !== metadataFingerprint(beforeHandle)
    ) {
      throw new Error(`Workspace file was replaced before retention recapture: ${absolute}`)
    }
    destination = await open(temporary, "wx", 0o600)
    const digest = createHash("sha256")
    let size = 0
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)
      digest.update(bytes)
      size += bytes.byteLength
      let offset = 0
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await destination.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          null,
        )
        if (bytesWritten === 0) throw new Error(`Could not persist workspace file: ${absolute}`)
        offset += bytesWritten
      }
    }
    await destination.sync()
    const afterHandle = await source.stat()
    const afterPath = await lstat(absolute)
    const actualHash = digest.digest("hex")
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      metadataFingerprint(beforeHandle) !== metadataFingerprint(afterHandle) ||
      metadataFingerprint(afterHandle) !== metadataFingerprint(afterPath) ||
      size !== expected.size ||
      actualHash !== expected.sha256
    ) {
      throw new Error(`Workspace file changed during retention recapture: ${absolute}`)
    }
  } catch (error) {
    captureFailed = true
    captureError = error
  } finally {
    await source.close()
    if (destination) await destination.close()
  }
  if (captureFailed) {
    await unlink(temporary).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error
    })
    throw captureError
  }

  try {
    try {
      await link(temporary, target)
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (errorCode(error) !== "ENOENT") throw error
    })
  }
  const metadata = await lstat(target)
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== expected.size ||
    (await fileHash(target)) !== expected.sha256
  ) {
    throw new Error(`Content-addressed workspace file failed integrity verification: ${target}`)
  }
  return {
    contentHash: expected.sha256,
    sizeBytes: expected.size,
    ref: portable(relative(storage, target)),
  }
}

async function persistStableWorkspaceSymlink(
  workspaceRoot: string,
  absolute: string,
  store: ContentAddressedStore,
  expected: { sha256: string; size: number },
  storageRoot = workspaceRoot,
): Promise<FrozenContent> {
  const bytes = await readStableSymlink(absolute)
  if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) {
    throw new Error(`Workspace symlink changed during retention recapture: ${absolute}`)
  }
  return persistContentAddressedBytes(storageRoot, store, bytes, {
    expectedHash: expected.sha256,
  })
}

export async function readVerifiedContentReference(
  workspaceRoot: string,
  ref: string,
  expectedHash: string,
  expectedSize?: number,
): Promise<Uint8Array> {
  const root = await realpath(resolve(workspaceRoot))
  const target = resolve(root, ref)
  if (isAbsolute(ref) || !contained(root, target)) {
    throw new Error(`Content reference escapes the workspace: ${ref}`)
  }
  const metadata = await lstat(target)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Content reference is not a regular file: ${ref}`)
  }
  const canonical = await realpath(target)
  if (!contained(root, canonical)) {
    throw new Error(`Content reference resolves outside the workspace: ${ref}`)
  }
  const bytes = await readStableFile(canonical)
  const actualHash = sha256(bytes)
  if (actualHash !== expectedHash) {
    throw new Error(
      `Content reference hash mismatch for ${ref}: expected ${expectedHash}, received ${actualHash}`,
    )
  }
  if (expectedSize !== undefined && bytes.byteLength !== expectedSize) {
    throw new Error(
      `Content reference size mismatch for ${ref}: expected ${expectedSize}, received ${bytes.byteLength}`,
    )
  }
  return bytes
}

export async function freezeWorkspaceFile(
  workspaceRoot: string,
  path: string,
  store: ContentAddressedStore,
  options: { maxBytes?: number; storageRoot?: string } = {},
): Promise<FrozenContent> {
  const root = await realpath(resolve(workspaceRoot))
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RETAINED_FILE_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Artifact retention maxBytes must be a non-negative safe integer")
  }
  if (isSensitiveWorkspacePath(path)) {
    throw new Error(`Artifact path is sensitive and cannot be retained: ${path}`)
  }
  const target = resolve(root, path)
  if (isAbsolute(path) || !contained(root, target)) {
    throw new Error(`Workspace file escapes the workspace: ${path}`)
  }
  const metadata = await lstat(target)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Workspace artifact is not a regular file: ${path}`)
  }
  if (metadata.size > maxBytes) {
    throw new Error(`Artifact exceeds immutable retention limit (${maxBytes} bytes): ${path}`)
  }
  const canonical = await realpath(target)
  if (!contained(root, canonical)) {
    throw new Error(`Workspace artifact resolves outside the workspace: ${path}`)
  }
  const bytes = await readStableFile(canonical)
  return persistContentAddressedBytes(options.storageRoot ?? root, store, bytes)
}

export async function verifyWorkspaceBaselineContent(
  workspaceRoot: string,
  baseline: WorkspaceBaseline,
  paths: readonly string[] = Object.entries(baseline.files)
    .filter(([, snapshot]) => snapshot.contentRef !== undefined)
    .map(([path]) => path),
): Promise<void> {
  const actualSnapshotHash = sha256(
    canonicalJson({
      scope: baseline.scope,
      files: snapshotFacts(baseline.files),
      git: baseline.git,
    }),
  )
  if (actualSnapshotHash !== baseline.snapshotHash) {
    throw new Error(
      `Workspace snapshot hash mismatch: expected ${baseline.snapshotHash}, received ${actualSnapshotHash}`,
    )
  }
  for (const path of [...new Set(paths)].sort()) {
    const snapshot = baseline.files[path]
    if (!snapshot) continue
    if (!snapshot.contentRef) {
      throw new Error(`Workspace snapshot has no immutable content reference: ${path}`)
    }
    await readVerifiedContentReference(
      workspaceRoot,
      snapshot.contentRef,
      snapshot.sha256,
      snapshot.size,
    )
  }
}

async function gitValue(
  root: string,
  args: string[],
  timeoutMs = 5_000,
): Promise<string | undefined> {
  const git = Bun.which("git")
  if (!git) return undefined
  const child = Bun.spawn([git, ...args], {
    cwd: root,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  })
  const unregisterProcess = processShutdownRegistry.register({
    pid: child.pid,
    cancel: async () => {
      child.kill()
    },
    forceKill: async () => {
      child.kill(9)
    },
  })
  void child.exited.finally(unregisterProcess).catch(() => undefined)
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolveDeadline) => {
    timeout = setTimeout(() => resolveDeadline(undefined), timeoutMs)
  })
  const exitCode = await Promise.race([child.exited, deadline])
  if (timeout) clearTimeout(timeout)
  if (exitCode === undefined) {
    child.kill(9)
    await child.exited.catch(() => undefined)
    return undefined
  }
  if (exitCode !== 0) return undefined
  return new Response(child.stdout).text().then((value) => value.trim())
}

async function captureGitFacts(root: string): Promise<WorkspaceBaseline["git"]> {
  const head = await gitValue(root, ["rev-parse", "HEAD"])
  const [branch, status] = head
    ? await Promise.all([
        gitValue(root, ["branch", "--show-current"]),
        gitValue(root, ["status", "--porcelain=v2", "--untracked-files=all"]),
      ])
    : [undefined, undefined]
  return {
    available: head !== undefined,
    dirty: status !== undefined && status.length > 0,
    ...(head ? { head } : {}),
    ...(branch ? { branch } : {}),
    ...(status !== undefined ? { statusHash: sha256(status) } : {}),
  }
}

function observedGitFactSnapshots(git: WorkspaceBaseline["git"]): Record<string, FileSnapshot> {
  const facts: Record<string, FileSnapshot> = {}
  for (const [name, value] of [
    ["head", git.head],
    ["branch", git.branch],
    ["status", git.statusHash],
  ] as const) {
    if (value === undefined) continue
    facts[`${GIT_FACT_PREFIX}${name}`] = {
      kind: "file",
      sha256: sha256(value),
      size: Buffer.byteLength(value),
      retentionStatus: "control-plane",
    }
  }
  return facts
}

function normalizedScope(value: string | undefined): string {
  const normalized = portable(value?.trim() || ".")
    .replace(/^\.\//, "")
    .replace(/\/$/, "")
  return normalized || "."
}

function pathInScope(path: string, scope: string): boolean {
  if (scope === ".") return true
  return path === scope || path.startsWith(`${scope}/`)
}

type WorkspaceFileFacts = Pick<FileSnapshot, "kind" | "sha256" | "size">

function snapshotFacts(files: Record<string, FileSnapshot>): Record<string, WorkspaceFileFacts> {
  return Object.fromEntries(
    Object.entries(files).map(([path, snapshot]) => [
      path,
      { kind: snapshot.kind, sha256: snapshot.sha256, size: snapshot.size },
    ]),
  )
}

function retentionStatusFor(
  path: string,
  size: number,
  options: {
    scope: string
    maxRetainedFileBytes: number
    objectStore?: ContentAddressedStore
  },
): FileSnapshot["retentionStatus"] {
  if (!options.objectStore) return "inventory-only"
  if (!pathInScope(path, options.scope)) return "out-of-scope"
  if (isSensitiveWorkspacePath(path)) return "sensitive"
  if (size > options.maxRetainedFileBytes) return "per-file-limit"
  return "total-limit"
}

type RetentionCandidate = {
  absolute: string
  path: string
  kind: FileSnapshot["kind"]
  sha256: string
  size: number
}

function retentionPrioritySet(values: readonly string[]): ReadonlySet<string> {
  const paths = new Set<string>()
  for (const value of values) {
    const normalized = portable(value.trim()).replace(/^\.\//, "").replace(/\/$/, "")
    if (
      !normalized ||
      isAbsolute(normalized) ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`Retention priority path escapes the workspace: ${value}`)
    }
    paths.add(normalized)
  }
  return paths
}

async function scanWorkspace(
  root: string,
  options: {
    ignored: ReadonlySet<string>
    maxFiles: number
    scope: string
    maxRetainedFileBytes: number
    maxTotalRetainedBytes: number
    retentionPriorityPaths: ReadonlySet<string>
    objectStore?: ContentAddressedStore
    storageRoot?: string
  },
): Promise<Record<string, FileSnapshot>> {
  const files: Record<string, FileSnapshot> = {}
  const objectStore = options.objectStore
  const candidates: RetentionCandidate[] = []
  let fileCount = 0
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name)
      const path = portable(relative(root, absolute))
      if (!path || options.ignored.has(path)) continue
      if (CONTROL_DIRECTORIES.has(entry.name.toLowerCase())) continue
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) {
        const bytes = await readStableSymlink(absolute)
        const retentionStatus = retentionStatusFor(path, bytes.byteLength, options)
        const digest = sha256(bytes)
        files[path] = {
          kind: "symlink",
          sha256: digest,
          size: bytes.byteLength,
          retentionStatus,
        }
        if (retentionStatus === "total-limit") {
          candidates.push({
            absolute,
            path,
            kind: "symlink",
            sha256: digest,
            size: bytes.byteLength,
          })
        }
      } else if (metadata.isDirectory()) {
        await walk(absolute)
      } else if (metadata.isFile()) {
        const hashed = await hashStableFile(absolute)
        const retentionStatus = retentionStatusFor(path, hashed.size, options)
        files[path] = {
          kind: "file",
          sha256: hashed.sha256,
          size: hashed.size,
          retentionStatus,
        }
        if (retentionStatus === "total-limit") {
          candidates.push({
            absolute,
            path,
            kind: "file",
            sha256: hashed.sha256,
            size: hashed.size,
          })
        }
      } else {
        continue
      }
      fileCount += 1
      if (fileCount > options.maxFiles) {
        throw new Error(`Workspace snapshot exceeds the ${options.maxFiles} file limit`)
      }
    }
  }
  await walk(root)
  if (!objectStore) return files

  candidates.sort((left, right) => {
    const leftPriority = options.retentionPriorityPaths.has(left.path) ? 0 : 1
    const rightPriority = options.retentionPriorityPaths.has(right.path) ? 0 : 1
    return (
      leftPriority - rightPriority || left.size - right.size || left.path.localeCompare(right.path)
    )
  })
  let retainedBytes = 0
  for (const candidate of candidates) {
    if (retainedBytes + candidate.size > options.maxTotalRetainedBytes) continue
    const expected = { sha256: candidate.sha256, size: candidate.size }
    const frozen =
      candidate.kind === "file"
        ? await persistStableWorkspaceFile(
            root,
            candidate.absolute,
            objectStore,
            expected,
            options.storageRoot,
          )
        : await persistStableWorkspaceSymlink(
            root,
            candidate.absolute,
            objectStore,
            expected,
            options.storageRoot,
          )
    files[candidate.path] = {
      kind: candidate.kind,
      sha256: candidate.sha256,
      size: candidate.size,
      retentionStatus: "retained",
      contentRef: frozen.ref,
    }
    retainedBytes += candidate.size
  }
  return files
}

export async function captureWorkspaceBaseline(
  workspaceRoot: string,
  options: CaptureWorkspaceOptions = {},
): Promise<WorkspaceBaseline> {
  const root = await realpath(resolve(workspaceRoot))
  const scope = normalizedScope(options.scope)
  const scopeTarget = resolve(root, scope)
  if (!contained(root, scopeTarget)) throw new Error(`Workspace scope escapes the root: ${scope}`)
  const ignored = new Set((options.ignore ?? []).map((value) => portable(value)))
  const maxFiles = options.maxFiles ?? 20_000
  const maxRetainedFileBytes = options.maxRetainedFileBytes ?? DEFAULT_MAX_RETAINED_FILE_BYTES
  const maxTotalRetainedBytes = options.maxTotalRetainedBytes ?? DEFAULT_MAX_TOTAL_RETAINED_BYTES
  const retentionPriorityPaths = retentionPrioritySet(options.retentionPriorityPaths ?? [])
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("maxFiles must be positive")
  if (!Number.isSafeInteger(maxRetainedFileBytes) || maxRetainedFileBytes < 0) {
    throw new Error("maxRetainedFileBytes must be a non-negative safe integer")
  }
  if (!Number.isSafeInteger(maxTotalRetainedBytes) || maxTotalRetainedBytes < 0) {
    throw new Error("maxTotalRetainedBytes must be a non-negative safe integer")
  }

  const files = await scanWorkspace(root, {
    ignored,
    maxFiles,
    scope,
    maxRetainedFileBytes,
    maxTotalRetainedBytes,
    retentionPriorityPaths,
    ...(options.objectStore ? { objectStore: options.objectStore } : {}),
    ...(options.storageRoot ? { storageRoot: options.storageRoot } : {}),
  })
  // Git status may refresh index metadata. Capture it before hashing the selected
  // control-plane files so Ralph's own observation cannot look like a later mutation.
  const git = await captureGitFacts(root)
  const gitControl = {
    ...(await scanGitControlFacts(root, maxFiles)),
    ...observedGitFactSnapshots(git),
  }
  if (Object.keys(files).length + Object.keys(gitControl).length > maxFiles) {
    throw new Error(`Workspace snapshot exceeds the ${maxFiles} file limit`)
  }
  Object.assign(files, gitControl)

  const snapshotHash = sha256(canonicalJson({ scope, files: snapshotFacts(files), git }))
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    scope,
    files,
    git,
    snapshotHash,
  }
}

export function compareWorkspaceBaselines(
  before: WorkspaceBaseline,
  after: WorkspaceBaseline,
): WorkspaceChanges {
  if (before.scope !== after.scope)
    throw new Error("Cannot compare baselines with different scopes")
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  const all = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort()
  for (const path of all) {
    const previous = before.files[path]
    const current = after.files[path]
    if (!previous && current) created.push(path)
    else if (previous && !current) deleted.push(path)
    else if (
      previous &&
      current &&
      canonicalJson(snapshotFacts({ value: previous })) !==
        canonicalJson(snapshotFacts({ value: current }))
    ) {
      modified.push(path)
    }
  }
  const rawChanged = [...created, ...modified, ...deleted]
  const workspaceContentChanged = rawChanged.some((path) => !path.startsWith(".git/"))
  const include = (path: string): boolean =>
    path !== `${GIT_FACT_PREFIX}status` || !workspaceContentChanged
  const selectedCreated = created.filter(include)
  const selectedModified = modified.filter(include)
  const selectedDeleted = deleted.filter(include)
  const changed = [...selectedCreated, ...selectedModified, ...selectedDeleted].sort()
  return {
    schemaVersion: 1,
    created: selectedCreated,
    modified: selectedModified,
    deleted: selectedDeleted,
    changed,
    outsideScope: changed.filter((path) => !pathInScope(path, before.scope)),
    hasChanges: changed.length > 0,
    beforeHash: before.snapshotHash,
    afterHash: after.snapshotHash,
  }
}
