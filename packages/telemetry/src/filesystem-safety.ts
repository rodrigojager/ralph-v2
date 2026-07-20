import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises"
import { hostname as localHostname } from "node:os"
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path"

export type TrustedFileIdentity = {
  readonly dev: number
  readonly ino: number
  readonly nlink: number
  readonly size: number
  readonly mtimeMs: number
}

type TrustedDirectoryIdentity = {
  readonly path: string
  readonly dev: number
  readonly ino: number
}

export type FilesystemLeaseReceipt = {
  readonly schemaVersion: 1
  readonly token: string
  readonly pid: number
  readonly processStartToken: string
  readonly hostname: string
  readonly acquiredAt: string
  readonly heartbeatAt: string
  readonly graceMs: number
}

type FilesystemLeaseHeartbeat = {
  readonly schemaVersion: 1
  readonly token: string
  readonly heartbeatAt: string
}

export type FilesystemLeaseInspection = {
  readonly state: "absent" | "active" | "abandoned" | "blocked"
  readonly reason: string
  readonly receipt?: FilesystemLeaseReceipt
}

export type FilesystemLease = {
  readonly path: string
  readonly receipt: FilesystemLeaseReceipt
  /** Fails closed if the lock path/descriptor binding or ownership token changed. */
  assertOwned(): Promise<void>
  release(): Promise<void>
}

export class FilesystemLeaseBlockedError extends Error {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string) {
    super(`Filesystem lease is blocked: ${path} (${reason})`)
    this.name = "FilesystemLeaseBlockedError"
    this.path = path
    this.reason = reason
  }
}

const DEFAULT_LEASE_WAIT_MS = 10_000
const DEFAULT_LEASE_GRACE_MS = 120_000
const DEFAULT_HEARTBEAT_MS = 10_000
const MAXIMUM_RECEIPT_BYTES = 16_384
let currentProcessStartToken: Promise<string> | undefined

function comparable(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLocaleLowerCase("und") : normalized
}

/**
 * Bun currently renders the real path of a Windows drive root without its
 * trailing separator (for example, `realpath("C:\\")` returns `"C:"`). Feeding
 * that drive-relative spelling back through `resolve` would incorrectly bind it
 * to the process working directory. Accept that spelling only when the path we
 * actually inspected is the corresponding filesystem root; every non-root path
 * still has to match its real path exactly and therefore remains junction-safe.
 */
function sameCanonicalDirectoryPath(path: string, canonical: string): boolean {
  if (comparable(canonical) === comparable(path)) return true
  if (process.platform !== "win32") return false

  const target = resolve(path)
  const root = parse(target).root
  if (comparable(target) !== comparable(root) || !root.endsWith(sep)) return false

  const rootWithoutTrailingSeparator = root.slice(0, -sep.length)
  return (
    canonical.toLocaleLowerCase("und") === rootWithoutTrailingSeparator.toLocaleLowerCase("und")
  )
}

function sameIdentity(
  left: Pick<Stats, "dev" | "ino">,
  right: Pick<Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function fileIdentity(info: Stats): TrustedFileIdentity {
  return { dev: info.dev, ino: info.ino, nlink: info.nlink, size: info.size, mtimeMs: info.mtimeMs }
}

function assertSafeLeaf(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    basename(name) !== name ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error(`Managed filesystem leaf is invalid: ${name}`)
  }
}

function execute(executable: string, args: readonly string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1_024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolvePromise(stdout.trim())
      },
    )
  })
}

async function processStartToken(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process id: ${pid}`)
  if (process.platform === "linux") {
    const [processStat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ])
    const commandEnd = processStat.lastIndexOf(")")
    if (commandEnd < 0) throw new Error("Linux process stat has no command terminator")
    const fields = processStat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u)
    const startTicks = fields[19]
    if (!startTicks || !/^\d+$/u.test(startTicks)) {
      throw new Error("Linux process stat has no valid starttime field")
    }
    return `linux:${bootId.trim()}:${startTicks}`
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot
    const executable = systemRoot
      ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe"
    const ticks = await execute(executable, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid}; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`,
    ])
    if (!/^\d+$/u.test(ticks)) throw new Error("Windows process start time was not an integer")
    return `windows:${ticks}`
  }
  const started = await execute("ps", ["-p", String(pid), "-o", "lstart="])
  if (!started) throw new Error("POSIX process start time is unavailable")
  return `${process.platform}:${started.replace(/\s+/gu, " ")}`
}

async function cachedCurrentProcessStartToken(): Promise<string> {
  currentProcessStartToken ??= processStartToken(process.pid)
  try {
    return await currentProcessStartToken
  } catch (error) {
    currentProcessStartToken = undefined
    throw error
  }
}

function pidLiveness(pid: number): "dead" | "alive" | "inaccessible" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "inaccessible"
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return "dead"
    if (code === "EPERM" || code === "EACCES") return "inaccessible"
    return "inaccessible"
  }
}

function parseReceipt(value: string): FilesystemLeaseReceipt | undefined {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_RECEIPT_BYTES) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<FilesystemLeaseReceipt>
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.token !== "string" ||
      parsed.token.length < 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      Number(parsed.pid) <= 0 ||
      typeof parsed.processStartToken !== "string" ||
      parsed.processStartToken.length < 1 ||
      typeof parsed.hostname !== "string" ||
      parsed.hostname.length < 1 ||
      typeof parsed.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.acquiredAt)) ||
      typeof parsed.heartbeatAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.heartbeatAt)) ||
      !Number.isSafeInteger(parsed.graceMs) ||
      Number(parsed.graceMs) < 1
    ) {
      return undefined
    }
    return parsed as FilesystemLeaseReceipt
  } catch {
    return undefined
  }
}

function parseHeartbeat(value: string): FilesystemLeaseHeartbeat | undefined {
  if (Buffer.byteLength(value, "utf8") > MAXIMUM_RECEIPT_BYTES) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<FilesystemLeaseHeartbeat>
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.token !== "string" ||
      parsed.token.length < 1 ||
      typeof parsed.heartbeatAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.heartbeatAt))
    ) {
      return undefined
    }
    return parsed as FilesystemLeaseHeartbeat
  } catch {
    return undefined
  }
}

function leaseOwnerTemporaryLeaf(lockPath: string, token: string): string {
  const separator = token.lastIndexOf(":")
  const suffix = separator >= 0 ? token.slice(separator + 1) : ""
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(suffix)) {
    throw new Error("Filesystem lease token cannot bind an immutable owner file")
  }
  const leaf = `.${basename(lockPath)}.owner-${suffix}.tmp`
  assertSafeLeaf(leaf)
  return leaf
}

function leaseHeartbeatPath(lockPath: string, token: string): string {
  const separator = token.lastIndexOf(":")
  const suffix = separator >= 0 ? token.slice(separator + 1) : ""
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(suffix)) {
    throw new Error("Filesystem lease token cannot bind a heartbeat file")
  }
  return join(dirname(lockPath), `.${basename(lockPath)}.heartbeat-${suffix}`)
}

async function directoryIdentity(path: string): Promise<TrustedDirectoryIdentity> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    throw new Error(`Managed path refuses a symbolic link or junction: ${path}`)
  }
  if (!info.isDirectory()) {
    throw new Error(`Managed path is not a trusted directory: ${path}`)
  }
  const canonical = await realpath(path)
  if (!sameCanonicalDirectoryPath(path, canonical)) {
    throw new Error(`Managed directory changed identity or traverses a junction: ${path}`)
  }
  return { path, dev: info.dev, ino: info.ino }
}

async function assertDirectoryIdentity(expected: TrustedDirectoryIdentity): Promise<void> {
  const current = await directoryIdentity(expected.path)
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`Managed directory changed identity: ${expected.path}`)
  }
}

/**
 * Lease owners are normally single-link files. During the two-syscall atomic
 * publication protocol they may temporarily have exactly two managed links:
 * the public lock path and the token-derived owner temp path. No other managed
 * data path accepts hard links.
 */
async function readTrustedLeaseOwner(
  path: string,
): Promise<{ readonly content: Buffer; readonly identity: TrustedFileIdentity }> {
  const target = resolve(path)
  const parentPath = await ensureTrustedDirectory(dirname(target))
  const parent = await directoryIdentity(parentPath)
  const before = await lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || (before.nlink !== 1 && before.nlink !== 2)) {
    throw new Error(`Lease owner is not a trusted regular file: ${target}`)
  }
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
  await assertDirectoryIdentity(parent)
  const handle = await open(target, constants.O_RDONLY | noFollow)
  try {
    const descriptor = await handle.stat()
    if (
      !descriptor.isFile() ||
      descriptor.nlink !== before.nlink ||
      !sameIdentity(before, descriptor)
    ) {
      throw new Error(`Lease owner changed identity while opening: ${target}`)
    }
    const content = await handle.readFile()
    const [descriptorAfter, after] = await Promise.all([handle.stat(), lstat(target)])
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      (after.nlink !== 1 && after.nlink !== 2) ||
      descriptorAfter.nlink !== after.nlink ||
      !sameIdentity(descriptor, descriptorAfter) ||
      !sameIdentity(descriptorAfter, after) ||
      descriptorAfter.size !== before.size ||
      descriptorAfter.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(`Lease owner changed identity while being read: ${target}`)
    }
    await assertDirectoryIdentity(parent)
    return { content, identity: fileIdentity(descriptorAfter) }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function assertTrustedLeaseOpenFile(
  path: string,
  handle: FileHandle,
): Promise<TrustedFileIdentity> {
  const target = resolve(path)
  const parent = await directoryIdentity(dirname(target))
  const [descriptor, boundPath] = await Promise.all([handle.stat(), lstat(target)])
  if (
    !descriptor.isFile() ||
    !boundPath.isFile() ||
    boundPath.isSymbolicLink() ||
    (descriptor.nlink !== 1 && descriptor.nlink !== 2) ||
    descriptor.nlink !== boundPath.nlink ||
    !sameIdentity(descriptor, boundPath)
  ) {
    throw new Error(`Open lease owner is no longer bound to its path: ${target}`)
  }
  await assertDirectoryIdentity(parent)
  return fileIdentity(descriptor)
}

async function assertLeaseOwnerLinkShape(
  path: string,
  receipt: FilesystemLeaseReceipt,
  identity: TrustedFileIdentity,
): Promise<void> {
  if (identity.nlink === 1) return
  if (identity.nlink !== 2) throw new Error(`Lease owner has unexpected links: ${path}`)
  const temporaryPath = join(dirname(path), leaseOwnerTemporaryLeaf(path, receipt.token))
  const temporary = await lstat(temporaryPath)
  if (
    !temporary.isFile() ||
    temporary.isSymbolicLink() ||
    temporary.nlink !== 2 ||
    !sameIdentity(temporary, identity)
  ) {
    throw new Error(`Lease owner hard-link publication is not token-bound: ${path}`)
  }
}

/**
 * Creates one directory component at a time below the filesystem root and
 * revalidates each parent. Recursive mkdir is intentionally avoided because it
 * cannot prove that an intermediate component was not swapped for a link.
 */
export async function ensureTrustedDirectory(path: string): Promise<string> {
  const target = resolve(path)
  const anchor = parse(target).root
  let parent = await directoryIdentity(anchor)
  const remainder = relative(anchor, target)
  if (remainder === "") return target
  for (const segment of remainder.split(sep)) {
    assertSafeLeaf(segment)
    const child = join(parent.path, segment)
    await assertDirectoryIdentity(parent)
    try {
      await mkdir(child, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const childIdentity = await directoryIdentity(child)
    await assertDirectoryIdentity(parent)
    parent = childIdentity
  }
  if (comparable(parent.path) !== comparable(target)) {
    throw new Error(`Managed directory escaped its requested target: ${target}`)
  }
  return target
}

function openFlags(kind: "exclusive" | "append"): number {
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
  return kind === "exclusive"
    ? constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow
    : constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | noFollow
}

/** Opens a regular file only after proving its parent and path binding. */
export async function openTrustedFile(
  path: string,
  kind: "exclusive" | "append",
  mode = 0o600,
): Promise<FileHandle> {
  const target = resolve(path)
  const leaf = basename(target)
  assertSafeLeaf(leaf)
  const parentPath = await ensureTrustedDirectory(dirname(target))
  const parent = await directoryIdentity(parentPath)
  let before: Stats | undefined
  try {
    before = await lstat(target)
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
      throw new Error(`Managed target is not a trusted regular file: ${target}`)
    }
    if (kind === "exclusive") {
      const conflict = new Error(
        `Managed target already exists: ${target}`,
      ) as NodeJS.ErrnoException
      conflict.code = "EEXIST"
      throw conflict
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await assertDirectoryIdentity(parent)
  const handle = await open(target, openFlags(kind), mode)
  try {
    const [descriptor, boundPath] = await Promise.all([handle.stat(), lstat(target)])
    if (
      !descriptor.isFile() ||
      !boundPath.isFile() ||
      boundPath.isSymbolicLink() ||
      descriptor.nlink !== 1 ||
      boundPath.nlink !== 1 ||
      !sameIdentity(descriptor, boundPath) ||
      (before !== undefined && !sameIdentity(before, descriptor))
    ) {
      throw new Error(`Managed target changed identity while opening: ${target}`)
    }
    await assertDirectoryIdentity(parent)
    return handle
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

/** Reads through a descriptor whose inode remains bound to the inspected path. */
export async function readTrustedFile(path: string): Promise<Buffer> {
  const target = resolve(path)
  const leaf = basename(target)
  assertSafeLeaf(leaf)
  const parentPath = await ensureTrustedDirectory(dirname(target))
  const parent = await directoryIdentity(parentPath)
  const before = await lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`Managed target is not a trusted regular file: ${target}`)
  }
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
  await assertDirectoryIdentity(parent)
  const handle = await open(target, constants.O_RDONLY | noFollow)
  try {
    const descriptor = await handle.stat()
    if (!descriptor.isFile() || descriptor.nlink !== 1 || !sameIdentity(before, descriptor)) {
      throw new Error(`Managed target changed identity while opening for read: ${target}`)
    }
    const content = await handle.readFile()
    const [descriptorAfter, after] = await Promise.all([handle.stat(), lstat(target)])
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      descriptorAfter.nlink !== 1 ||
      after.nlink !== 1 ||
      !sameIdentity(descriptor, descriptorAfter) ||
      !sameIdentity(descriptorAfter, after) ||
      descriptorAfter.size !== before.size ||
      descriptorAfter.mtimeMs !== before.mtimeMs
    ) {
      throw new Error(`Managed target changed identity while being read: ${target}`)
    }
    await assertDirectoryIdentity(parent)
    return content
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function writeTrustedFileExclusive(
  path: string,
  content: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const handle = await openTrustedFile(path, "exclusive", mode)
  try {
    await assertTrustedOpenFile(path, handle)
    await handle.writeFile(content)
    await handle.sync()
    await assertTrustedOpenFile(path, handle)
  } finally {
    await handle.close()
  }
}

export async function trustedFileIdentity(path: string): Promise<TrustedFileIdentity> {
  const target = resolve(path)
  await ensureTrustedDirectory(dirname(target))
  const info = await lstat(target)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`Managed target is not a trusted regular file: ${target}`)
  }
  return fileIdentity(info)
}

export async function assertTrustedOpenFile(
  path: string,
  handle: FileHandle,
): Promise<TrustedFileIdentity> {
  const target = resolve(path)
  const parent = await directoryIdentity(dirname(target))
  const [descriptor, boundPath] = await Promise.all([handle.stat(), lstat(target)])
  if (
    !descriptor.isFile() ||
    !boundPath.isFile() ||
    boundPath.isSymbolicLink() ||
    descriptor.nlink !== 1 ||
    boundPath.nlink !== 1 ||
    !sameIdentity(descriptor, boundPath)
  ) {
    throw new Error(`Open managed file is no longer bound to its path: ${target}`)
  }
  await assertDirectoryIdentity(parent)
  return fileIdentity(descriptor)
}

/**
 * Renames first, then proves the moved inode before unlinking. This avoids the
 * lstat/unlink substitution window available to a path-only deletion.
 */
export async function removeTrustedFile(
  root: string,
  path: string,
  expected: TrustedFileIdentity,
): Promise<void> {
  const trustedRoot = await ensureTrustedDirectory(root)
  const target = resolve(path)
  const rel = relative(trustedRoot, target)
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Managed removal target escapes its trusted root: ${target}`)
  }
  const parent = await directoryIdentity(dirname(target))
  const current = await lstat(target)
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1 ||
    expected.nlink !== 1 ||
    !sameIdentity(current, expected) ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs
  ) {
    throw new Error(`Managed file changed identity before removal: ${target}`)
  }
  await assertDirectoryIdentity(parent)
  const quarantine = join(dirname(target), `.${basename(target)}.remove-${randomUUID()}`)
  await rename(target, quarantine)
  try {
    const moved = await lstat(quarantine)
    if (
      !moved.isFile() ||
      moved.isSymbolicLink() ||
      moved.nlink !== 1 ||
      !sameIdentity(moved, expected)
    ) {
      throw new Error(`Managed file changed identity during removal: ${target}`)
    }
    await assertDirectoryIdentity(parent)
    await unlink(quarantine)
  } catch (error) {
    // A failed post-rename operation must not silently strand managed data
    // under a name that neither its rawRef nor retention can discover. Restore
    // the proven inode whenever the original target is still absent. If an
    // attacker/concurrent actor already occupied the target, finish the
    // originally requested deletion only after proving the quarantine inode.
    try {
      const moved = await lstat(quarantine)
      if (
        moved.isFile() &&
        !moved.isSymbolicLink() &&
        moved.nlink === 1 &&
        sameIdentity(moved, expected)
      ) {
        let targetIsAbsent = false
        try {
          await lstat(target)
        } catch (targetError) {
          if ((targetError as NodeJS.ErrnoException).code === "ENOENT") targetIsAbsent = true
        }
        await assertDirectoryIdentity(parent)
        if (targetIsAbsent) {
          await rename(quarantine, target)
          const restored = await lstat(target)
          if (
            !restored.isFile() ||
            restored.isSymbolicLink() ||
            restored.nlink !== 1 ||
            !sameIdentity(restored, expected)
          ) {
            throw new Error(`Managed file rollback changed identity: ${target}`)
          }
        } else {
          await unlink(quarantine)
        }
      }
    } catch {
      // Preserve the original failure. A best-effort rollback cannot safely
      // overwrite a path that appeared concurrently.
    }
    throw error
  }
}

async function inspectLeasePath(
  path: string,
  nowMs = Date.now(),
): Promise<FilesystemLeaseInspection> {
  let info: Stats
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent", reason: "lease file does not exist" }
    }
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.nlink !== 1 && info.nlink !== 2)) {
    return { state: "blocked", reason: "lease path is linked or is not a regular file" }
  }
  let owner: Awaited<ReturnType<typeof readTrustedLeaseOwner>>
  try {
    owner = await readTrustedLeaseOwner(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent", reason: "lease was retired during inspection" }
    }
    throw error
  }
  const receipt = parseReceipt(owner.content.toString("utf8"))
  if (!receipt) {
    return {
      state: "blocked",
      reason: "legacy lease receipt is malformed and has no durable owner identity",
    }
  }
  try {
    await assertLeaseOwnerLinkShape(path, receipt, owner.identity)
  } catch (error) {
    return {
      state: "blocked",
      reason: error instanceof Error ? error.message : "lease owner link shape is invalid",
      receipt,
    }
  }
  const heartbeat = await readTrustedFile(leaseHeartbeatPath(path, receipt.token))
    .then((value) => parseHeartbeat(value.toString("utf8")))
    .catch(() => undefined)
  const effectiveReceipt =
    heartbeat?.token === receipt.token
      ? { ...receipt, heartbeatAt: heartbeat.heartbeatAt }
      : receipt
  const heartbeatMs = Date.parse(effectiveReceipt.heartbeatAt)
  const heartbeatIsFresh = nowMs - heartbeatMs <= receipt.graceMs
  if (receipt.processStartToken === `released:${receipt.token}`) {
    return { state: "abandoned", reason: "lease owner durably marked release", receipt }
  }
  const isLocalHost =
    receipt.hostname.toLocaleLowerCase("und") === localHostname().toLocaleLowerCase("und")
  if (!isLocalHost && heartbeatIsFresh) {
    return {
      state: "active",
      reason: "lease heartbeat is within its grace window",
      receipt: effectiveReceipt,
    }
  }
  if (!isLocalHost) {
    return {
      state: "blocked",
      reason: "expired remote-host lease cannot be reclaimed without a process identity probe",
      receipt,
    }
  }
  const liveness = pidLiveness(receipt.pid)
  if (liveness === "dead") {
    return { state: "abandoned", reason: "lease owner process no longer exists", receipt }
  }
  if (liveness === "inaccessible") {
    return heartbeatIsFresh
      ? {
          state: "active",
          reason: "lease heartbeat is fresh while process identity is inaccessible",
          receipt: effectiveReceipt,
        }
      : { state: "blocked", reason: "lease owner process identity is inaccessible", receipt }
  }
  try {
    const observed = await processStartToken(receipt.pid)
    return observed === receipt.processStartToken
      ? {
          state: "active",
          reason: "lease owner process identity is still alive",
          receipt: effectiveReceipt,
        }
      : { state: "abandoned", reason: "lease owner PID was reused", receipt }
  } catch {
    return heartbeatIsFresh
      ? {
          state: "active",
          reason: "lease heartbeat is fresh while start token verification is unavailable",
          receipt: effectiveReceipt,
        }
      : { state: "blocked", reason: "lease owner start token could not be verified", receipt }
  }
}

export async function inspectFilesystemLease(path: string): Promise<FilesystemLeaseInspection> {
  const target = resolve(path)
  await ensureTrustedDirectory(dirname(target))
  return inspectLeasePath(target)
}

/** Reclaims only a locally provable abandoned lease; active/unknown owners are untouched. */
export async function clearAbandonedFilesystemLease(
  path: string,
): Promise<FilesystemLeaseInspection> {
  const target = resolve(path)
  await ensureTrustedDirectory(dirname(target))
  const inspection = await inspectLeasePath(target)
  if (inspection.state !== "abandoned") return inspection
  if (!inspection.receipt) return inspection
  const reclaimed = await reclaimAbandonedLease(target, inspection.receipt).catch(() => false)
  return reclaimed
    ? { state: "absent", reason: `abandoned lease reclaimed: ${inspection.reason}` }
    : inspectLeasePath(target)
}

async function reclaimAbandonedLease(
  path: string,
  expected: FilesystemLeaseReceipt,
): Promise<boolean> {
  const owner = await readTrustedLeaseOwner(path)
  const current = parseReceipt(owner.content.toString("utf8"))
  if (
    !current ||
    current.token !== expected.token ||
    current.pid !== expected.pid ||
    current.processStartToken !== expected.processStartToken ||
    current.hostname !== expected.hostname ||
    current.acquiredAt !== expected.acquiredAt ||
    current.graceMs !== expected.graceMs
  ) {
    return false
  }
  await assertLeaseOwnerLinkShape(path, current, owner.identity)
  const inspection = await inspectLeasePath(path)
  if (inspection.state !== "abandoned" || inspection.receipt?.token !== expected.token) return false
  await retireLeaseOwner(dirname(path), path, owner.identity)
  await removeLeaseHeartbeat(path, current.token)
  const temporaryPath = join(dirname(path), leaseOwnerTemporaryLeaf(path, current.token))
  try {
    const temporary = await lstat(temporaryPath)
    if (sameIdentity(temporary, owner.identity)) await unlink(temporaryPath)
  } catch {
    // Public lock path is already retired; publication temp is non-authoritative.
  }
  return true
}

async function writeLeaseReceipt(
  path: string,
  handle: FileHandle,
  receipt: FilesystemLeaseReceipt,
): Promise<void> {
  const serialized = `${JSON.stringify(receipt)}\n`
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_RECEIPT_BYTES) {
    throw new Error("Filesystem lease receipt exceeds its bounded size")
  }
  await assertTrustedOpenFile(path, handle)
  await handle.truncate(0)
  const content = Buffer.from(serialized, "utf8")
  let offset = 0
  while (offset < content.length) {
    const result = await handle.write(content, offset, content.length - offset, offset)
    if (result.bytesWritten < 1) throw new Error("Filesystem lease receipt write made no progress")
    offset += result.bytesWritten
  }
  await handle.sync()
  await assertTrustedOpenFile(path, handle)
}

async function createImmutableLeaseOwner(
  directory: string,
  path: string,
  receipt: FilesystemLeaseReceipt,
): Promise<FileHandle> {
  const temporaryPath = join(directory, leaseOwnerTemporaryLeaf(path, receipt.token))
  const temporaryHandle = await openTrustedFile(temporaryPath, "exclusive")
  try {
    await writeLeaseReceipt(temporaryPath, temporaryHandle, receipt)
  } finally {
    await temporaryHandle.close()
  }
  const temporaryIdentity = await trustedFileIdentity(temporaryPath)
  try {
    await link(temporaryPath, path)
  } catch (error) {
    await removeTrustedFile(directory, temporaryPath, temporaryIdentity).catch(() => undefined)
    throw error
  }
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
  let ownerHandle: FileHandle | undefined
  try {
    ownerHandle = await open(path, constants.O_RDONLY | noFollow)
    const published = await assertTrustedLeaseOpenFile(path, ownerHandle)
    if (!sameIdentity(published, temporaryIdentity) || published.nlink !== 2) {
      throw new Error(`Immutable lease owner publication changed identity: ${path}`)
    }
    await unlink(temporaryPath).catch(() => undefined)
    const owner = await readTrustedLeaseOwner(path)
    const parsed = parseReceipt(owner.content.toString("utf8"))
    if (!parsed || parsed.token !== receipt.token) {
      throw new Error(`Immutable lease owner receipt changed during publication: ${path}`)
    }
    await assertLeaseOwnerLinkShape(path, parsed, owner.identity)
    return ownerHandle
  } catch (error) {
    await ownerHandle?.close().catch(() => undefined)
    try {
      const owner = await readTrustedLeaseOwner(path)
      const parsed = parseReceipt(owner.content.toString("utf8"))
      if (parsed?.token === receipt.token && sameIdentity(owner.identity, temporaryIdentity)) {
        await retireLeaseOwner(directory, path, owner.identity)
      }
    } catch {
      // If publication was replaced/tampered, it is no longer this attempt's
      // authority to remove the public path.
    }
    try {
      const temporary = await lstat(temporaryPath)
      if (sameIdentity(temporary, temporaryIdentity)) await unlink(temporaryPath)
    } catch {
      // Orphan temp is non-authoritative and can be diagnosed separately.
    }
    throw error
  }
}

async function writeLeaseHeartbeat(path: string, receipt: FilesystemLeaseReceipt): Promise<void> {
  const heartbeatPath = leaseHeartbeatPath(path, receipt.token)
  const handle = await openTrustedFile(heartbeatPath, "append")
  const heartbeat = `${JSON.stringify({
    schemaVersion: 1,
    token: receipt.token,
    heartbeatAt: receipt.heartbeatAt,
  } satisfies FilesystemLeaseHeartbeat)}\n`
  try {
    await assertTrustedOpenFile(heartbeatPath, handle)
    await handle.truncate(0)
    await handle.writeFile(heartbeat, "utf8")
    await handle.sync()
    await assertTrustedOpenFile(heartbeatPath, handle)
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function removeLeaseHeartbeat(path: string, token: string): Promise<void> {
  const heartbeatPath = leaseHeartbeatPath(path, token)
  try {
    const before = await trustedFileIdentity(heartbeatPath)
    const heartbeat = parseHeartbeat((await readTrustedFile(heartbeatPath)).toString("utf8"))
    const after = await trustedFileIdentity(heartbeatPath)
    if (
      heartbeat?.token === token &&
      sameIdentity(before, after) &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs
    ) {
      await removeTrustedFile(dirname(path), heartbeatPath, after)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Heartbeat is advisory; immutable owner identity remains authoritative.
    }
  }
}

async function retireLeaseOwner(
  root: string,
  path: string,
  expected: TrustedFileIdentity,
): Promise<void> {
  const trustedRoot = await ensureTrustedDirectory(root)
  const target = resolve(path)
  const rel = relative(trustedRoot, target)
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`Lease retirement target escapes its trusted root: ${target}`)
  }
  const parent = await directoryIdentity(dirname(target))
  const current = await lstat(target)
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    (current.nlink !== 1 && current.nlink !== 2) ||
    !sameIdentity(current, expected) ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs
  ) {
    throw new Error(`Lease owner changed identity before retirement: ${target}`)
  }
  await assertDirectoryIdentity(parent)
  const quarantine = join(dirname(target), `.${basename(target)}.released-${randomUUID()}`)
  await rename(target, quarantine)
  const moved = await lstat(quarantine)
  if (
    !moved.isFile() ||
    moved.isSymbolicLink() ||
    !sameIdentity(moved, expected) ||
    moved.size !== expected.size ||
    moved.mtimeMs !== expected.mtimeMs
  ) {
    throw new Error(`Lease owner changed identity during retirement: ${target}`)
  }
  await assertDirectoryIdentity(parent)
  await unlink(quarantine).catch(() => undefined)
}

export async function acquireFilesystemLease(
  root: string,
  name: string,
  options: {
    readonly waitMs?: number
    readonly graceMs?: number
    readonly heartbeatMs?: number
  } = {},
): Promise<FilesystemLease> {
  assertSafeLeaf(name)
  const directory = await ensureTrustedDirectory(root)
  const path = join(directory, name)
  const waitMs = options.waitMs ?? DEFAULT_LEASE_WAIT_MS
  const graceMs = options.graceMs ?? DEFAULT_LEASE_GRACE_MS
  const heartbeatMs = options.heartbeatMs ?? Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(graceMs / 3))
  for (const [label, value] of [
    ["waitMs", waitMs],
    ["graceMs", graceMs],
    ["heartbeatMs", heartbeatMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${label} must be a positive safe integer`)
  }
  if (heartbeatMs >= graceMs)
    throw new Error("Filesystem lease heartbeat must be shorter than grace")
  const deadline = Date.now() + waitMs
  const identity = {
    pid: process.pid,
    processStartToken: await cachedCurrentProcessStartToken(),
    hostname: localHostname(),
  }
  let delayMs = 20
  let lastBlockedReason = "lease is held by another process"
  while (true) {
    try {
      const acquiredAt = new Date().toISOString()
      let receipt: FilesystemLeaseReceipt = {
        schemaVersion: 1,
        token: `${identity.pid}:${randomUUID()}`,
        ...identity,
        acquiredAt,
        heartbeatAt: acquiredAt,
        graceMs,
      }
      let handle = await createImmutableLeaseOwner(directory, path, receipt)
      let handleIsOpen = true
      let released = false
      let releasing = false
      let heartbeatFailure: unknown
      let heartbeatTail: Promise<void> = Promise.resolve()
      const queueLeaseOperation = (operation: () => Promise<void>): Promise<void> => {
        const pending = heartbeatTail.then(async () => {
          if (heartbeatFailure !== undefined) throw heartbeatFailure
          await operation()
        })
        heartbeatTail = pending.catch((error: unknown) => {
          heartbeatFailure ??= error
        })
        return pending
      }
      let timer: ReturnType<typeof setInterval> | undefined
      const startHeartbeat = (): void => {
        timer = setInterval(() => {
          if (released || releasing || heartbeatFailure !== undefined) return
          void queueLeaseOperation(async () => {
            if (released || releasing) return
            receipt = { ...receipt, heartbeatAt: new Date().toISOString() }
            await assertTrustedLeaseOpenFile(path, handle)
            await writeLeaseHeartbeat(path, receipt)
            await assertTrustedLeaseOpenFile(path, handle)
          }).catch(() => undefined)
        }, heartbeatMs)
        timer.unref()
      }
      startHeartbeat()
      const assertOwned = async (): Promise<void> => {
        if (released || releasing) {
          throw new Error(`Filesystem lease is not active: ${path}`)
        }
        await queueLeaseOperation(async () => {
          if (released || releasing) throw new Error(`Filesystem lease is not active: ${path}`)
          const binding = await assertTrustedLeaseOpenFile(path, handle)
          const owner = await readTrustedLeaseOwner(path)
          const current = parseReceipt(owner.content.toString("utf8"))
          if (
            current?.token !== receipt.token ||
            current.processStartToken !== identity.processStartToken ||
            !sameIdentity(binding, owner.identity)
          ) {
            throw new Error(`Filesystem lease ownership changed: ${path}`)
          }
          await assertLeaseOwnerLinkShape(path, current, owner.identity)
        }).catch((error: unknown) => {
          throw new Error(`Filesystem lease lost ownership: ${path}`, { cause: error })
        })
      }
      return {
        path,
        get receipt() {
          return receipt
        },
        assertOwned,
        release: async () => {
          if (released) return
          if (releasing) throw new Error(`Filesystem lease release is already in progress: ${path}`)
          if (!handleIsOpen) {
            const owner = await readTrustedLeaseOwner(path)
            const current = parseReceipt(owner.content.toString("utf8"))
            if (
              current?.token !== receipt.token ||
              current.processStartToken !== identity.processStartToken
            ) {
              released = true
              throw new Error(`Filesystem lease ownership changed before release retry: ${path}`)
            }
            const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
            const reopened = await open(path, constants.O_RDONLY | noFollow)
            try {
              const rebound = await assertTrustedLeaseOpenFile(path, reopened)
              if (!sameIdentity(rebound, owner.identity)) {
                throw new Error(`Filesystem lease changed before release retry: ${path}`)
              }
              handle = reopened
              handleIsOpen = true
            } catch (error) {
              await reopened.close().catch(() => undefined)
              throw error
            }
          }
          releasing = true
          if (timer) clearInterval(timer)
          await heartbeatTail.catch(() => undefined)
          let handleClosed = false
          try {
            const binding = await assertTrustedLeaseOpenFile(path, handle)
            const owner = await readTrustedLeaseOwner(path)
            const current = parseReceipt(owner.content.toString("utf8"))
            if (
              current?.token !== receipt.token ||
              current.processStartToken !== identity.processStartToken ||
              !sameIdentity(binding, owner.identity)
            ) {
              throw new Error(`Filesystem lease ownership changed before release: ${path}`)
            }
            await assertLeaseOwnerLinkShape(path, current, owner.identity)
            await handle.close()
            handleIsOpen = false
            handleClosed = true
            const closedOwner = await readTrustedLeaseOwner(path)
            const closedReceipt = parseReceipt(closedOwner.content.toString("utf8"))
            if (
              closedReceipt?.token !== receipt.token ||
              !sameIdentity(owner.identity, closedOwner.identity)
            ) {
              throw new Error(`Filesystem lease path changed while closing: ${path}`)
            }
            await retireLeaseOwner(directory, path, closedOwner.identity)
            released = true
            releasing = false
            await removeLeaseHeartbeat(path, receipt.token)
            const temporaryPath = join(directory, leaseOwnerTemporaryLeaf(path, receipt.token))
            try {
              const temporary = await lstat(temporaryPath)
              if (sameIdentity(temporary, closedOwner.identity)) await unlink(temporaryPath)
            } catch {
              // A crash-only publication link is non-authoritative once the
              // public lock path has been retired.
            }
          } catch (error) {
            const owner = await readTrustedLeaseOwner(path).catch(() => undefined)
            const current = owner ? parseReceipt(owner.content.toString("utf8")) : undefined
            if (!owner) {
              released = true
              releasing = false
              if (!handleClosed) {
                await handle.close().catch(() => undefined)
                handleIsOpen = false
              }
              await removeLeaseHeartbeat(path, receipt.token)
              return
            }
            if (
              current?.token === receipt.token &&
              current.processStartToken === identity.processStartToken
            ) {
              if (!handleClosed) {
                await handle.close().catch(() => undefined)
                handleIsOpen = false
              }
              const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
              const reopened = await open(path, constants.O_RDONLY | noFollow)
              try {
                const rebound = await assertTrustedLeaseOpenFile(path, reopened)
                if (!sameIdentity(rebound, owner.identity)) {
                  throw new Error(`Filesystem lease changed before release retry: ${path}`)
                }
                handle = reopened
                handleIsOpen = true
              } catch (reopenError) {
                await reopened.close().catch(() => undefined)
                releasing = false
                throw reopenError
              }
              heartbeatFailure = undefined
              releasing = false
              startHeartbeat()
            } else {
              released = true
              releasing = false
              if (!handleClosed) {
                await handle.close().catch(() => undefined)
                handleIsOpen = false
              }
            }
            throw error
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const inspection = await inspectLeasePath(path)
      lastBlockedReason = inspection.reason
      if (inspection.state === "abandoned") {
        const reclaimed = inspection.receipt
          ? await reclaimAbandonedLease(path, inspection.receipt).catch(() => false)
          : false
        if (reclaimed) continue
      }
      if (Date.now() >= deadline) throw new FilesystemLeaseBlockedError(path, lastBlockedReason)
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs))
      delayMs = Math.min(200, delayMs * 2)
    }
  }
}
