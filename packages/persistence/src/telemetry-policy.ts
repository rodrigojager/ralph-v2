import { createHash } from "node:crypto"
import type { Dirent } from "node:fs"
import { lstat, readdir, rmdir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import { parseTelemetryEventRetention, type TelemetryConfig } from "@ralph-next/domain"
import {
  acquireFilesystemLease,
  clearAbandonedFilesystemLease,
  ensureTrustedDirectory,
  FilesystemLeaseBlockedError,
  readTrustedFile,
  removeTrustedFile,
  type TrustedFileIdentity,
  trustedFileIdentity,
} from "@ralph-next/telemetry"

import { DEFAULT_RAW_STREAM_RETENTION } from "./raw-streams"

export type DiagnosticRawRetentionPolicy = {
  readonly maximumFileBytes: number
  readonly maximumFiles: number
  readonly maximumTotalBytes: number
  readonly maximumAgeMs?: number
}

export type DiagnosticRawRetentionReceipt = {
  readonly removedFiles: number
  readonly removedBytes: number
  readonly retainedFiles: number
  readonly retainedBytes: number
  /** True when retained data exceeds budget or enforcement was safely blocked. */
  readonly overBudget: boolean
  /** A live/unverifiable owner prevented safe enforcement; no file was removed. */
  readonly blocked: boolean
  readonly blockedReason?: string
}

const RETENTION_LOCK_WAIT_MS = 10_000
const RAW_STREAM_SEGMENT_PATTERN = /^\d{8,16}\.jsonl$/u
const RAW_STREAM_MANIFEST = "stream.json"
const queues = new Map<string, Promise<unknown>>()

function comparable(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLocaleLowerCase("und") : normalized
}

async function withQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  let release: (() => void) | undefined
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise
  })
  const tail = previous.catch(() => undefined).then(() => current)
  queues.set(key, tail)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release?.()
    if (queues.get(key) === tail) queues.delete(key)
  }
}

async function assertSafeRoot(root: string): Promise<string> {
  return ensureTrustedDirectory(root)
}

type Candidate = TrustedFileIdentity & {
  readonly path: string
}

function portableRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/")
}

function recognizedDiagnosticCapture(root: string, path: string): boolean {
  const value = portableRelative(root, path)
  return (
    /^[a-f0-9]{64}\.jsonl?$/u.test(value) ||
    /^model\/[a-f0-9]{2}\/[a-f0-9]{64}\.jsonl$/u.test(value) ||
    /^process\/process-[A-Za-z0-9._-]{1,64}-[0-9a-f-]{36}\.(?:stdout|stderr)(?:\.truncated)?\.log$/u.test(
      value,
    ) ||
    /^(?:calls|processes)\/[a-f0-9]{64}\/\d{8,16}\.jsonl$/u.test(value)
  )
}

async function captureIsOpen(path: string): Promise<boolean> {
  const lockPath = `${path}.capture.lock`
  const inspection = await clearAbandonedFilesystemLease(lockPath)
  return inspection.state !== "absent"
}

async function collectCandidates(
  root: string,
  directory = root,
  protectedSet: ReadonlySet<string> = new Set(),
): Promise<Candidate[]> {
  const output: Candidate[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.name === ".raw.mutation.lock" ||
      entry.name.endsWith(".capture.lock") ||
      entry.name === ".append.lock"
    ) {
      continue
    }
    const path = join(directory, entry.name)
    const pathInfo = await lstat(path)
    if (pathInfo.isSymbolicLink()) {
      throw new Error(`Diagnostic raw retention refuses a symbolic link or junction: ${path}`)
    }
    if (pathInfo.isDirectory()) {
      output.push(...(await collectCandidates(root, path, protectedSet)))
      continue
    }
    if (!pathInfo.isFile() || !recognizedDiagnosticCapture(root, path)) continue
    if (pathInfo.nlink !== 1) {
      throw new Error(`Diagnostic raw retention refuses a hard-linked capture: ${path}`)
    }
    if ((await captureIsOpen(path)) && !protectedSet.has(comparable(path))) continue
    const relativePath = relative(root, path)
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      comparable(resolve(root, relativePath)) !== comparable(path)
    ) {
      throw new Error(`Diagnostic raw retention candidate escapes its root: ${path}`)
    }
    output.push({
      path,
      size: pathInfo.size,
      mtimeMs: pathInfo.mtimeMs,
      dev: pathInfo.dev,
      ino: pathInfo.ino,
      nlink: pathInfo.nlink,
    })
  }
  return output
}

async function cleanupOrphanRawStreamManifests(root: string, directory = root): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  const relativeDirectory = portableRelative(root, directory)
  const isRawStreamDirectory = /^(?:calls|processes)\/[a-f0-9]{64}$/u.test(relativeDirectory)
  if (isRawStreamDirectory) {
    const hasSegment = entries.some(
      (entry) => entry.isFile() && RAW_STREAM_SEGMENT_PATTERN.test(entry.name),
    )
    const manifestEntry = entries.find((entry) => entry.name === RAW_STREAM_MANIFEST)
    if (!hasSegment && manifestEntry?.isFile() && !manifestEntry.isSymbolicLink()) {
      const path = join(directory, RAW_STREAM_MANIFEST)
      try {
        const value = JSON.parse((await readTrustedFile(path)).toString("utf8")) as {
          schemaVersion?: unknown
          streamKind?: unknown
          streamId?: unknown
          streamHash?: unknown
        }
        const expectedKind = relativeDirectory.startsWith("calls/") ? "call" : "process"
        const expectedHash = relativeDirectory.slice(relativeDirectory.lastIndexOf("/") + 1)
        if (
          value.schemaVersion === 1 &&
          value.streamKind === expectedKind &&
          typeof value.streamId === "string" &&
          value.streamId.length >= 1 &&
          value.streamId.length <= 512 &&
          createHash("sha256").update(`${expectedKind}\0${value.streamId}`).digest("hex") ===
            expectedHash &&
          value.streamHash === expectedHash
        ) {
          await removeTrustedFile(root, path, await trustedFileIdentity(path))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // Invalid or concurrently changed manifests are unknown data and are retained.
        }
      }
    }
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    await cleanupOrphanRawStreamManifests(root, join(directory, entry.name))
  }
}

async function removeEmptyRawStreamDirectories(root: string): Promise<void> {
  for (const group of ["calls", "processes"] as const) {
    const groupRoot = join(root, group)
    let entries: Dirent[]
    try {
      const info = await lstat(groupRoot)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Raw stream group is not a trusted directory: ${groupRoot}`)
      }
      entries = await readdir(groupRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const directory = join(groupRoot, entry.name)
      await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error
      })
    }
    await rmdir(groupRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error
    })
  }
}

async function removeCandidate(root: string, candidate: Candidate): Promise<void> {
  if (await captureIsOpen(candidate.path)) {
    throw new Error(`Diagnostic raw capture became active before retention: ${candidate.path}`)
  }
  await removeTrustedFile(root, candidate.path, candidate)
}

/**
 * The existing raw-stream defaults are the product defaults for diagnostic
 * capture quantity/bytes. A configured event_retention adds an age bound; null
 * deliberately adds no age policy instead of inventing a duration.
 */
export function resolveDiagnosticRawRetention(
  telemetry: TelemetryConfig,
): DiagnosticRawRetentionPolicy {
  const maximumAgeMs = parseTelemetryEventRetention(telemetry.event_retention)
  return {
    maximumFileBytes: Math.min(
      DEFAULT_RAW_STREAM_RETENTION.maxSegmentBytes,
      DEFAULT_RAW_STREAM_RETENTION.maxTotalBytes,
    ),
    maximumFiles: DEFAULT_RAW_STREAM_RETENTION.maxSegments,
    maximumTotalBytes: DEFAULT_RAW_STREAM_RETENTION.maxTotalBytes,
    ...(maximumAgeMs === undefined ? {} : { maximumAgeMs }),
  }
}

/** Mandatory persistence redaction cannot be disabled. A false redact setting
 * therefore fails closed by disabling optional raw persistence. */
export function rawPersistenceEnabled(telemetry: TelemetryConfig): boolean {
  return telemetry.persist_raw_output && telemetry.redact
}

function assertRetentionLimit(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Diagnostic raw retention ${label} must be a positive safe integer`)
  }
}

/**
 * Applies one oldest-first budget across the specialized model/process files
 * below a caller-selected run/workspace diagnostic root. Unknown files are
 * never treated as retention authority and are never removed.
 */
export async function applyDiagnosticRawRetention(
  root: string,
  policy: DiagnosticRawRetentionPolicy,
  nowMs = Date.now(),
  protectedPaths: readonly string[] = [],
): Promise<DiagnosticRawRetentionReceipt> {
  assertRetentionLimit("maximumFileBytes", policy.maximumFileBytes)
  assertRetentionLimit("maximumFiles", policy.maximumFiles)
  assertRetentionLimit("maximumTotalBytes", policy.maximumTotalBytes)
  if (policy.maximumAgeMs !== undefined) {
    assertRetentionLimit("maximumAgeMs", policy.maximumAgeMs)
  }
  const canonical = await assertSafeRoot(root)
  const protectedSet = new Set(
    protectedPaths.map((path) => {
      const target = resolve(path)
      const relativePath = relative(canonical, target)
      if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
        throw new Error(`Protected diagnostic raw path escapes its retention root: ${target}`)
      }
      return comparable(target)
    }),
  )
  return withQueue(comparable(canonical), async () => {
    let lease: Awaited<ReturnType<typeof acquireFilesystemLease>>
    try {
      lease = await acquireFilesystemLease(canonical, ".raw.mutation.lock", {
        waitMs: RETENTION_LOCK_WAIT_MS,
      })
    } catch (error) {
      if (error instanceof FilesystemLeaseBlockedError) {
        return {
          removedFiles: 0,
          removedBytes: 0,
          retainedFiles: 0,
          retainedBytes: 0,
          overBudget: true,
          blocked: true,
          blockedReason: error.reason,
        }
      }
      throw error
    }
    try {
      await lease.assertOwned()
      const candidates = (await collectCandidates(canonical, canonical, protectedSet)).sort(
        (left, right) => {
          const leftProtected = protectedSet.has(comparable(left.path))
          const rightProtected = protectedSet.has(comparable(right.path))
          if (leftProtected !== rightProtected) return leftProtected ? 1 : -1
          return left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path)
        },
      )
      let retainedFiles = candidates.length
      let retainedBytes = candidates.reduce((total, item) => total + item.size, 0)
      let removedFiles = 0
      let removedBytes = 0
      for (const candidate of candidates) {
        if (protectedSet.has(comparable(candidate.path))) continue
        const isNewest = retainedFiles === 1
        const expired =
          policy.maximumAgeMs !== undefined && nowMs - candidate.mtimeMs > policy.maximumAgeMs
        const overCount = retainedFiles > policy.maximumFiles
        const overBytes = retainedBytes > policy.maximumTotalBytes && !isNewest
        const overFile = candidate.size > policy.maximumFileBytes
        if (!expired && !overCount && !overBytes && !overFile) continue
        await lease.assertOwned()
        await removeCandidate(canonical, candidate)
        retainedFiles -= 1
        retainedBytes -= candidate.size
        removedFiles += 1
        removedBytes += candidate.size
      }
      await lease.assertOwned()
      await cleanupOrphanRawStreamManifests(canonical)
      await removeEmptyRawStreamDirectories(canonical)
      await lease.assertOwned()
      return {
        removedFiles,
        removedBytes,
        retainedFiles,
        retainedBytes,
        overBudget:
          retainedFiles > policy.maximumFiles ||
          retainedBytes > policy.maximumTotalBytes ||
          candidates.some(
            (candidate) =>
              protectedSet.has(comparable(candidate.path)) &&
              candidate.size > policy.maximumFileBytes,
          ),
        blocked: false,
      }
    } finally {
      await lease.release()
    }
  })
}

async function removeEmptyDescendants(root: string, directory = root): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const child = join(directory, entry.name)
    await removeEmptyDescendants(root, child)
    await rmdir(child).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error
    })
  }
}

/**
 * Removes only recognized optional diagnostic captures for a terminal run
 * whose configured age window expired. Evidence/artifacts and unknown files
 * are outside this root and outside this deletion authority.
 */
export async function purgeDiagnosticRawCaptures(root: string): Promise<number> {
  try {
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(`Expired diagnostic raw root is not a trusted directory: ${root}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw error
  }
  const canonical = await assertSafeRoot(root)
  return withQueue(comparable(canonical), async () => {
    const lease = await acquireFilesystemLease(canonical, ".raw.mutation.lock", {
      waitMs: RETENTION_LOCK_WAIT_MS,
    })
    let removed = 0
    try {
      for (const candidate of await collectCandidates(canonical)) {
        await lease.assertOwned()
        await removeCandidate(canonical, candidate)
        removed += 1
      }
      await lease.assertOwned()
      await cleanupOrphanRawStreamManifests(canonical)
      await removeEmptyDescendants(canonical)
      await lease.assertOwned()
    } finally {
      await lease.release()
    }
    return removed
  })
}
