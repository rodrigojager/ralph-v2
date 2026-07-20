import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import {
  type ReleaseManifest,
  ReleaseManifestSchema,
  releaseManifestSigningSha256,
  type StandaloneReleaseCandidateReceipt,
  StandaloneReleaseCandidateReceiptSchema,
} from "@ralph-next/distribution"
import { compareUtf8Bytes } from "./release-order"

const MAXIMUM_CANDIDATE_METADATA_BYTES = 8 * 1024 * 1024
const MAXIMUM_CANDIDATE_PAYLOAD_BYTES = 8 * 1024 * 1024 * 1024

export interface StableJsonInput {
  readonly path: string
  readonly raw: unknown
  readonly sha256: string
  readonly sizeBytes: number
}

export interface VerifiedCandidatePayload {
  readonly path: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly verification: "declared-size-and-hash" | "observed-bounded-only"
}

interface CandidateSubject {
  readonly repository: string
  readonly commit: string
  readonly sourceFingerprintSha256: string
  readonly channel: string
}

type CandidatePayloadDescriptor =
  | {
      readonly path: string
      readonly sha256: string
      readonly sizeBytes: number
      readonly maximumSizeBytes?: never
    }
  | {
      readonly path: string
      readonly sha256?: never
      readonly sizeBytes?: never
      readonly maximumSizeBytes: number
    }

function assertCandidateVerificationActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Candidate verification was cancelled")
}

function filesystemErrorCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  ) {
    const code = (error as { readonly code: string }).code
    return /^[A-Z0-9_]{1,32}$/u.test(code) ? code : "UNKNOWN"
  }
  return null
}

export interface StandaloneCandidateInput extends StableJsonInput {
  readonly kind: "standalone-release-candidate-receipt"
  readonly receipt: StandaloneReleaseCandidateReceipt
  readonly subject: CandidateSubject
  readonly payloads: readonly VerifiedCandidatePayload[]
  readonly payloadContentAddress: string
}

export interface ReleaseManifestCandidateInput extends StableJsonInput {
  readonly kind: "release-manifest"
  readonly manifest: ReleaseManifest
  readonly subject: CandidateSubject
  readonly payloads: readonly VerifiedCandidatePayload[]
  readonly payloadContentAddress: string
}

export type ReleaseCandidateInput = StandaloneCandidateInput | ReleaseManifestCandidateInput

export function effectiveReleaseCandidateDigest(input: ReleaseCandidateInput): string {
  const canonical = JSON.stringify({
    schemaVersion: 1,
    artifactClass: "ralph-release-candidate-effective-digest",
    kind: input.kind,
    metadataSha256: input.sha256,
    metadataSizeBytes: input.sizeBytes,
    payloadContentAddress: input.payloadContentAddress,
  })
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`
}

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function samePath(left: string, right: string): boolean {
  const canonicalLeft = resolve(left)
  const canonicalRight = resolve(right)
  return process.platform === "win32"
    ? canonicalLeft.toLocaleLowerCase("und") === canonicalRight.toLocaleLowerCase("und")
    : canonicalLeft === canonicalRight
}

async function readStableJsonInputUnsafe(
  path: string,
  label: string,
  maximumBytes = MAXIMUM_CANDIDATE_METADATA_BYTES,
  signal?: AbortSignal,
): Promise<StableJsonInput> {
  assertCandidateVerificationActive(signal)
  const requested = resolve(path)
  const before = await lstat(requested).catch(() => undefined)
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > maximumBytes
  ) {
    throw new Error(`${label} must be a bounded regular file`)
  }
  const canonical = await realpath(requested)
  if (!samePath(canonical, requested)) {
    throw new Error(`${label} cannot resolve through a link or junction`)
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const handle = await open(requested, constants.O_RDONLY | noFollow)
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
      throw new Error(`${label} changed while it was opened`)
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1)
    let size = 0
    while (size < buffer.byteLength) {
      assertCandidateVerificationActive(signal)
      const result = await handle.read(buffer, size, buffer.byteLength - size, size)
      if (result.bytesRead === 0) break
      size += result.bytesRead
    }
    const afterHandle = await handle.stat()
    const afterPath = await lstat(requested)
    if (
      size === 0 ||
      size > maximumBytes ||
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
      (await realpath(requested)) !== canonical
    ) {
      throw new Error(`${label} changed while it was read`)
    }
    bytes = buffer.subarray(0, size)
  } finally {
    await handle.close()
  }
  assertCandidateVerificationActive(signal)
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8 JSON`, { cause: error })
  }
  return {
    path: canonical,
    raw,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  }
}

export async function readStableJsonInput(
  path: string,
  label: string,
  maximumBytes = MAXIMUM_CANDIDATE_METADATA_BYTES,
  signal?: AbortSignal,
): Promise<StableJsonInput> {
  try {
    return await readStableJsonInputUnsafe(path, label, maximumBytes, signal)
  } catch (error) {
    const code = filesystemErrorCode(error)
    if (code) throw new Error(`${label} filesystem state changed or is inaccessible (${code})`)
    throw error
  }
}

async function verifyCandidatePayload(
  root: string,
  payload: CandidatePayloadDescriptor,
  signal?: AbortSignal,
  maximumBytes = MAXIMUM_CANDIDATE_PAYLOAD_BYTES,
  excludedIdentity?: { readonly dev: number | bigint; readonly ino: number | bigint },
): Promise<VerifiedCandidatePayload> {
  assertCandidateVerificationActive(signal)
  const payloadPath = payload.path
  if (
    payload.sha256 === undefined &&
    payload.sizeBytes === undefined &&
    payload.maximumSizeBytes === undefined
  ) {
    throw new Error(`Candidate payload has no verifiable size or hash constraint: ${payloadPath}`)
  }
  const requested = resolve(root, payload.path)
  if (!inside(root, requested)) {
    throw new Error(`Candidate payload escapes its metadata directory: ${payload.path}`)
  }
  const before = await lstat(requested).catch(() => undefined)
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > maximumBytes ||
    (payload.sizeBytes !== undefined && before.size !== payload.sizeBytes) ||
    (payload.maximumSizeBytes !== undefined && before.size > payload.maximumSizeBytes)
  ) {
    throw new Error(`Candidate payload is not the declared regular file: ${payload.path}`)
  }
  if (
    excludedIdentity &&
    before.dev === excludedIdentity.dev &&
    before.ino === excludedIdentity.ino
  ) {
    throw new Error(`Candidate payload cannot alias its own metadata file: ${payload.path}`)
  }
  const canonical = await realpath(requested)
  if (!inside(root, canonical)) {
    throw new Error(`Candidate payload resolves outside its metadata directory: ${payload.path}`)
  }
  if (!samePath(canonical, requested)) {
    throw new Error(`Candidate payload cannot resolve through a link or junction: ${payload.path}`)
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const handle = await open(requested, constants.O_RDONLY | noFollow)
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
      throw new Error(`Candidate payload changed before open: ${payload.path}`)
    }
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < opened.size) {
      assertCandidateVerificationActive(signal)
      const maximum = Math.min(buffer.byteLength, opened.size - position)
      const result = await handle.read(buffer, 0, maximum, position)
      if (result.bytesRead <= 0) {
        throw new Error(`Candidate payload ended early: ${payload.path}`)
      }
      hash.update(buffer.subarray(0, result.bytesRead))
      position += result.bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await handle.read(extra, 0, 1, opened.size)).bytesRead !== 0) {
      throw new Error(`Candidate payload grew while hashing: ${payload.path}`)
    }
    const afterHandle = await handle.stat()
    const afterPath = await lstat(requested)
    const sha256 = hash.digest("hex")
    if (
      !afterHandle.isFile() ||
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterHandle.dev !== opened.dev ||
      afterHandle.ino !== opened.ino ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      afterHandle.size !== opened.size ||
      afterPath.size !== opened.size ||
      afterHandle.mtimeMs !== opened.mtimeMs ||
      afterHandle.ctimeMs !== opened.ctimeMs ||
      afterPath.mtimeMs !== opened.mtimeMs ||
      afterPath.ctimeMs !== opened.ctimeMs ||
      (payload.sha256 !== undefined && sha256 !== payload.sha256) ||
      (await realpath(requested)) !== canonical
    ) {
      throw new Error(`Candidate payload changed or failed its receipt: ${payload.path}`)
    }
    return {
      path: payload.path,
      sha256,
      sizeBytes: opened.size,
      verification:
        payload.sha256 !== undefined && payload.sizeBytes !== undefined
          ? "declared-size-and-hash"
          : "observed-bounded-only",
    }
  } finally {
    await handle.close()
  }
}

function payloadAddress(payloads: readonly VerifiedCandidatePayload[]): string {
  const sorted = [...payloads].sort((left, right) => compareUtf8Bytes(left.path, right.path))
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        files: sorted.map((payload) => [
          payload.path,
          payload.sizeBytes,
          payload.sha256,
          payload.verification,
        ]),
      }),
    )
    .digest("hex")
}

async function verifyPayloadsUnsafe(
  metadataPath: string,
  payloads: readonly CandidatePayloadDescriptor[],
  signal?: AbortSignal,
): Promise<readonly VerifiedCandidatePayload[]> {
  const root = await realpath(dirname(metadataPath))
  const metadataInformation = await lstat(metadataPath)
  const verified: VerifiedCandidatePayload[] = []
  let aggregateBytes = 0
  for (const payload of payloads) {
    assertCandidateVerificationActive(signal)
    if (samePath(resolve(root, payload.path), metadataPath)) {
      throw new Error(`Candidate payload cannot be its own metadata file: ${payload.path}`)
    }
    const item = await verifyCandidatePayload(
      root,
      payload,
      signal,
      MAXIMUM_CANDIDATE_PAYLOAD_BYTES - aggregateBytes,
      { dev: metadataInformation.dev, ino: metadataInformation.ino },
    )
    aggregateBytes += item.sizeBytes
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > MAXIMUM_CANDIDATE_PAYLOAD_BYTES) {
      throw new Error(
        `Candidate payload inventory exceeds the ${MAXIMUM_CANDIDATE_PAYLOAD_BYTES}-byte safety bound`,
      )
    }
    verified.push(item)
  }
  return verified.sort((left, right) => compareUtf8Bytes(left.path, right.path))
}

async function verifyPayloads(
  metadataPath: string,
  payloads: readonly CandidatePayloadDescriptor[],
  signal?: AbortSignal,
): Promise<readonly VerifiedCandidatePayload[]> {
  try {
    return await verifyPayloadsUnsafe(metadataPath, payloads, signal)
  } catch (error) {
    const code = filesystemErrorCode(error)
    if (code) {
      throw new Error(`Candidate payload filesystem state changed or is inaccessible (${code})`)
    }
    throw error
  }
}

function standalonePayloads(receipt: StandaloneReleaseCandidateReceipt) {
  return [
    receipt.files.license,
    receipt.files.thirdPartyNotices,
    receipt.files.sbom,
    receipt.files.skill,
    receipt.files.checksums,
    ...receipt.files.targets.flatMap((target) => [
      target.launcher,
      target.executable,
      target.buildMetadata,
      target.launcherBuildMetadata,
      target.archive,
    ]),
  ]
}

function manifestPayloads(manifest: ReleaseManifest) {
  return [
    manifest.license,
    manifest.thirdPartyNotices,
    manifest.sbom,
    manifest.skill,
    manifest.checksums,
    ...(manifest.promotionRecord ? [manifest.promotionRecord] : []),
    ...(manifest.signature.status === "present"
      ? [
          {
            path: manifest.signature.payload.path,
            maximumSizeBytes: manifest.signature.payload.maximumSizeBytes,
          },
        ]
      : []),
    ...manifest.artifacts.flatMap((artifact) => [
      artifact.launcher,
      artifact.executable,
      artifact.buildMetadata,
      artifact.launcherBuildMetadata,
      ...(artifact.archive ? [artifact.archive] : []),
    ]),
  ]
}

export async function readStandaloneCandidateReceipt(
  path: string,
  signal?: AbortSignal,
): Promise<StandaloneCandidateInput> {
  const input = await readStableJsonInput(
    path,
    "Standalone release candidate receipt",
    MAXIMUM_CANDIDATE_METADATA_BYTES,
    signal,
  )
  const receipt = StandaloneReleaseCandidateReceiptSchema.parse(input.raw)
  const payloads = await verifyPayloads(input.path, standalonePayloads(receipt), signal)
  return {
    ...input,
    kind: "standalone-release-candidate-receipt",
    receipt,
    subject: {
      repository: receipt.promotionCandidate.repository,
      commit: receipt.promotionCandidate.commit,
      sourceFingerprintSha256: receipt.promotionCandidate.sourceFingerprintSha256,
      channel: receipt.promotionCandidate.channel,
    },
    payloads,
    payloadContentAddress: payloadAddress(payloads),
  }
}

export async function readReleaseCandidateInput(
  path: string,
  signal?: AbortSignal,
): Promise<ReleaseCandidateInput> {
  const input = await readStableJsonInput(
    path,
    "Ralph release candidate metadata",
    MAXIMUM_CANDIDATE_METADATA_BYTES,
    signal,
  )
  const standalone = StandaloneReleaseCandidateReceiptSchema.safeParse(input.raw)
  if (standalone.success) {
    const payloads = await verifyPayloads(input.path, standalonePayloads(standalone.data), signal)
    return {
      ...input,
      kind: "standalone-release-candidate-receipt",
      receipt: standalone.data,
      subject: {
        repository: standalone.data.promotionCandidate.repository,
        commit: standalone.data.promotionCandidate.commit,
        sourceFingerprintSha256: standalone.data.promotionCandidate.sourceFingerprintSha256,
        channel: standalone.data.promotionCandidate.channel,
      },
      payloads,
      payloadContentAddress: payloadAddress(payloads),
    }
  }
  const manifest = ReleaseManifestSchema.parse(input.raw)
  if (
    manifest.signature.status === "present" &&
    manifest.signature.signedManifestSha256 !== releaseManifestSigningSha256(manifest)
  ) {
    throw new Error("Release manifest signature descriptor does not bind its canonical projection")
  }
  const payloads = await verifyPayloads(input.path, manifestPayloads(manifest), signal)
  return {
    ...input,
    kind: "release-manifest",
    manifest,
    subject: {
      repository: manifest.source.repository,
      commit: manifest.source.commit,
      sourceFingerprintSha256: manifest.source.fingerprintSha256,
      channel: manifest.channel,
    },
    payloads,
    payloadContentAddress: payloadAddress(payloads),
  }
}
