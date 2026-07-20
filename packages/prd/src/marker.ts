import { createHash } from "node:crypto"
import { open, readFile, rm, stat } from "node:fs/promises"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import { writeFileAtomic } from "@ralph-next/persistence"
import {
  type MarkerUpdate,
  MarkerUpdateSchema,
  type TaskDefaults,
  type TaskStatusMarker,
} from "./contracts"
import { parsePrdBytesInternal, parsePrdFileInternal } from "./parser"

export type UpdateTaskMarkerOptions = {
  file: string
  taskId: string
  status: TaskStatusMarker
  expectedContentHash: string
  expectedStatus?: TaskStatusMarker
  inheritedDefaults?: TaskDefaults
  lockStaleMs?: number
}

const DEFAULT_STALE_LOCK_MS = 5 * 60_000

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function statusByte(status: TaskStatusMarker): number {
  if (status === "active") return "~".charCodeAt(0)
  if (status === "completed") return "x".charCodeAt(0)
  return " ".charCodeAt(0)
}

function markerStatus(byte: number): TaskStatusMarker | undefined {
  if (byte === " ".charCodeAt(0)) return "pending"
  if (byte === "~".charCodeAt(0)) return "active"
  if (byte === "x".charCodeAt(0)) return "completed"
  return undefined
}

function conflict(
  code: string,
  message: string,
  file: string,
  details?: Record<string, unknown>,
): never {
  throw new RalphError(code, message, {
    exitCode: EXIT_CODES.conflict,
    file,
    ...(details ? { details } : {}),
  })
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function recoverStaleMarkerLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const [content, metadata] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)])
    const firstLine = content.trim().split(/\s+/, 1)[0]
    let pid = Number(firstLine)
    try {
      const parsed: unknown = JSON.parse(content)
      if (parsed && typeof parsed === "object" && "pid" in parsed) {
        pid = Number((parsed as { pid: unknown }).pid)
      }
    } catch {
      // Ralph v2 initially wrote a plain PID; retain recovery compatibility.
    }
    if (Date.now() - metadata.mtimeMs < staleMs || processIsAlive(pid)) return false
    const latest = await stat(lockPath)
    if (
      latest.dev !== metadata.dev ||
      latest.ino !== metadata.ino ||
      latest.mtimeMs !== metadata.mtimeMs ||
      latest.size !== metadata.size
    )
      return false
    await rm(lockPath, { force: true })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    return false
  }
}

export async function updateTaskMarker(
  path: string,
  options: UpdateTaskMarkerOptions,
): Promise<MarkerUpdate> {
  const lockPath = `${path}.ralph-marker.lock`
  const staleLockMs = options.lockStaleMs ?? DEFAULT_STALE_LOCK_MS
  if (!Number.isFinite(staleLockMs) || staleLockMs < 0) {
    throw new RalphError(
      "RALPH_PRD_MARKER_LOCK_POLICY_INVALID",
      "lockStaleMs must be non-negative",
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: options.file,
      },
    )
  }
  let lock: Awaited<ReturnType<typeof open>> | undefined
  try {
    let lockError: unknown
    for (let attempt = 0; attempt < 2 && !lock; attempt += 1) {
      try {
        lock = await open(lockPath, "wx", 0o600)
        await lock.writeFile(
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        )
        await lock.sync()
      } catch (error) {
        lockError = error
        if (attempt === 0 && (await recoverStaleMarkerLock(lockPath, staleLockMs))) continue
      }
    }
    if (!lock) {
      conflict(
        "RALPH_PRD_MARKER_LOCKED",
        "Another marker update is already in progress",
        options.file,
        {
          reason: lockError instanceof Error ? lockError.message : String(lockError),
        },
      )
    }

    const bytes = await readFile(path)
    const actualHash = hash(bytes)
    if (actualHash !== options.expectedContentHash) {
      conflict(
        "RALPH_PRD_MARKER_HASH_CONFLICT",
        "PRD changed after it was compiled; marker update was not applied",
        options.file,
        { expected: options.expectedContentHash, actual: actualHash },
      )
    }
    const parsed = parsePrdBytesInternal(bytes, {
      file: options.file,
      ...(options.inheritedDefaults ? { inheritedDefaults: options.inheritedDefaults } : {}),
    })
    const document = parsed.document
    if (!parsed.ok || !document) {
      throw new RalphError("RALPH_PRD_MARKER_REPARSE_FAILED", "PRD no longer compiles", {
        exitCode: EXIT_CODES.invalidPrd,
        file: options.file,
        details: { diagnostics: parsed.diagnostics },
      })
    }
    const task = document.tasks.find((candidate) => candidate.id === options.taskId)
    const location = document.sourceMap[options.taskId]
    if (!task || !location) {
      conflict(
        "RALPH_PRD_MARKER_TASK_CONFLICT",
        `Task no longer exists at the compiled source location: ${options.taskId}`,
        options.file,
      )
    }
    if (options.expectedStatus && task.status !== options.expectedStatus) {
      conflict(
        "RALPH_PRD_MARKER_STATUS_CONFLICT",
        `Task status changed from the expected ${options.expectedStatus} to ${task.status}`,
        options.file,
      )
    }
    const offset = location.marker.offset
    if (
      bytes[offset] !== "[".charCodeAt(0) ||
      bytes[offset + 2] !== "]".charCodeAt(0) ||
      markerStatus(bytes[offset + 1] ?? -1) !== task.status
    ) {
      conflict(
        "RALPH_PRD_MARKER_SOURCE_CONFLICT",
        `Task marker bytes no longer match the compiled source map: ${options.taskId}`,
        options.file,
      )
    }
    if (task.status === options.status) {
      return MarkerUpdateSchema.parse({
        schemaVersion: 1,
        file: options.file,
        taskId: options.taskId,
        previousStatus: task.status,
        status: task.status,
        previousContentHash: actualHash,
        contentHash: actualHash,
        markerByteOffset: offset,
        changed: false,
        reparsed: true,
      })
    }

    const updated = Buffer.from(bytes)
    updated[offset + 1] = statusByte(options.status)
    const metadata = await stat(path)
    await writeFileAtomic(path, updated, {
      overwrite: true,
      mode: metadata.mode & 0o777,
      beforeCommit: async () => {
        const currentHash = hash(await readFile(path))
        if (currentHash !== actualHash) {
          conflict(
            "RALPH_PRD_MARKER_HASH_CONFLICT",
            "PRD changed while its marker update was being prepared",
            options.file,
            { expected: actualHash, actual: currentHash },
          )
        }
      },
    })

    const reparsed = await parsePrdFileInternal(path, {
      file: options.file,
      ...(options.inheritedDefaults ? { inheritedDefaults: options.inheritedDefaults } : {}),
    })
    const reparsedTask = reparsed.document?.tasks.find(
      (candidate) => candidate.id === options.taskId,
    )
    if (!reparsed.ok || !reparsed.document || reparsedTask?.status !== options.status) {
      throw new RalphError(
        "RALPH_PRD_MARKER_RECONCILIATION_FAILED",
        "Marker was written but the PRD did not reconcile to the requested status",
        {
          exitCode: EXIT_CODES.conflict,
          file: options.file,
          details: { diagnostics: reparsed.diagnostics, requestedStatus: options.status },
        },
      )
    }
    const finalBytes = await readFile(path)
    if (
      !bytes.subarray(0, offset + 1).equals(finalBytes.subarray(0, offset + 1)) ||
      !bytes.subarray(offset + 2).equals(finalBytes.subarray(offset + 2))
    ) {
      throw new RalphError(
        "RALPH_PRD_MARKER_BYTE_PRESERVATION_FAILED",
        "Content outside the task marker changed during marker reconciliation",
        { exitCode: EXIT_CODES.conflict, file: options.file },
      )
    }
    return MarkerUpdateSchema.parse({
      schemaVersion: 1,
      file: options.file,
      taskId: options.taskId,
      previousStatus: task.status,
      status: options.status,
      previousContentHash: actualHash,
      contentHash: reparsed.document.contentHash,
      markerByteOffset: offset,
      changed: true,
      reparsed: true,
    })
  } finally {
    if (lock) {
      await lock.close().catch(() => undefined)
      await rm(lockPath, { force: true })
    }
  }
}
