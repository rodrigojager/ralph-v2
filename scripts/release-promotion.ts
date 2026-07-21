import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { resolve } from "node:path"
import {
  assertReleasePromotionBinding,
  type PromotionCandidateBinding,
  type PromotionSupportBinding,
  type ReleasePromotionRecord,
  type ReleaseSupportPolicy,
  type ReleaseTarget,
} from "@ralph/distribution"

export interface PromotionTargetArtifacts {
  readonly target: ReleaseTarget
  readonly engineSha256: string
  readonly launcherSha256: string
  readonly buildMetadataSha256: string
  readonly launcherBuildMetadataSha256: string
  readonly archiveSha256: string
}

export interface ValidatedPromotionRecord {
  readonly record: ReleasePromotionRecord
  readonly path: string
  readonly sha256: string
}

export async function validateReleasePromotionRecord(input: {
  readonly recordPath: string
  readonly expectedVersion: string
  readonly expectedChannel: "beta" | "stable"
  readonly expectedRepository: string
  readonly expectedCommit: string
  readonly expectedSourceFingerprintSha256: string
  readonly support: PromotionSupportBinding
  readonly supportPolicy: ReleaseSupportPolicy
  readonly publishedAt: string
  readonly artifacts: readonly PromotionTargetArtifacts[]
  readonly now?: string
}): Promise<ValidatedPromotionRecord> {
  const requestedPath = resolve(input.recordPath)
  const before = await lstat(requestedPath).catch(() => undefined)
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > 4 * 1024 * 1024
  ) {
    throw new Error(`Promotion record must be a bounded regular file: ${requestedPath}`)
  }
  const path = await realpath(requestedPath)
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const handle = await open(requestedPath, constants.O_RDONLY | noFollow)
  let bytes: Uint8Array
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`Promotion record changed while it was opened: ${requestedPath}`)
    }
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024 + 1)
    let size = 0
    while (size < buffer.byteLength) {
      const result = await handle.read(buffer, size, buffer.byteLength - size, size)
      if (result.bytesRead === 0) break
      size += result.bytesRead
    }
    const afterHandle = await handle.stat()
    const afterPath = await lstat(requestedPath)
    if (
      size === 0 ||
      size > 4 * 1024 * 1024 ||
      !afterHandle.isFile() ||
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterHandle.dev !== opened.dev ||
      afterHandle.ino !== opened.ino ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      afterHandle.size !== size ||
      afterPath.size !== size ||
      afterHandle.mtimeMs !== opened.mtimeMs ||
      afterHandle.ctimeMs !== opened.ctimeMs ||
      afterPath.mtimeMs !== opened.mtimeMs ||
      afterPath.ctimeMs !== opened.ctimeMs ||
      (await realpath(requestedPath)) !== path
    ) {
      throw new Error(`Promotion record changed while it was read: ${requestedPath}`)
    }
    bytes = buffer.subarray(0, size)
  } finally {
    await handle.close()
  }
  let raw: unknown
  let sha256: string
  try {
    sha256 = createHash("sha256").update(bytes).digest("hex")
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error(`Promotion record is invalid JSON: ${path}`, { cause: error })
  }
  const candidate: PromotionCandidateBinding = {
    version: input.expectedVersion,
    channel: input.expectedChannel,
    repository: input.expectedRepository,
    commit: input.expectedCommit,
    sourceFingerprintSha256: input.expectedSourceFingerprintSha256,
    support: input.support,
    supportPolicy: input.supportPolicy,
    targets: input.artifacts,
    publishedAt: input.publishedAt,
    now: input.now ?? new Date().toISOString(),
  }
  return { record: assertReleasePromotionBinding(raw, candidate), path, sha256 }
}
