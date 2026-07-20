import { createHash } from "node:crypto"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { lstat, mkdir, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  computeEvidenceBundleContentHash,
  type EvidenceBundle,
  EvidenceBundleSchema,
  EXIT_CODES,
  evidenceBundleCanonicalJson,
  RalphError,
} from "@ralph-next/domain"
import { writeFileAtomic } from "./atomic"
import type { RunLayout } from "./execution-store"

export type EvidenceObjectReceipt = {
  schemaVersion: 1
  contentRef: string
  storageHash: string
  sizeBytes: number
}

const SHA256 = /^[a-f0-9]{64}$/

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function portable(path: string): string {
  return path.split(sep).join("/")
}

function contained(root: string, candidate: string): boolean {
  const nested = relative(root, candidate)
  return nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))
}

function integrityError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RalphError {
  return new RalphError(code, message, {
    exitCode: EXIT_CODES.conflict,
    ...(details ? { details } : {}),
  })
}

function evidenceObjectMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  )
}

function missingEvidenceObject(receipt: EvidenceObjectReceipt, error: unknown): RalphError {
  return integrityError(
    "RALPH_EVIDENCE_OBJECT_MISSING",
    `Evidence object does not exist: ${receipt.contentRef}`,
    {
      contentRef: receipt.contentRef,
      cause: error instanceof Error ? error.message : String(error),
    },
  )
}

export function assertEvidenceBundleContentHash(bundle: EvidenceBundle): void {
  const expected = computeEvidenceBundleContentHash(bundle)
  if (bundle.contentHash !== expected) {
    throw integrityError(
      "RALPH_EVIDENCE_CONTENT_HASH_MISMATCH",
      `Evidence bundle ${bundle.id} failed canonical content-hash verification`,
      { evidenceBundleId: bundle.id, expected, actual: bundle.contentHash },
    )
  }
}

function validateReceipt(receipt: EvidenceObjectReceipt): void {
  if (
    receipt.schemaVersion !== 1 ||
    !receipt.contentRef ||
    isAbsolute(receipt.contentRef) ||
    !SHA256.test(receipt.storageHash) ||
    !Number.isSafeInteger(receipt.sizeBytes) ||
    receipt.sizeBytes < 0
  ) {
    throw integrityError(
      "RALPH_EVIDENCE_OBJECT_RECEIPT_INVALID",
      "Evidence object receipt is invalid",
    )
  }
}

function parseEvidenceObject(bytes: Uint8Array, receipt: EvidenceObjectReceipt): EvidenceBundle {
  if (bytes.byteLength !== receipt.sizeBytes) {
    throw integrityError(
      "RALPH_EVIDENCE_OBJECT_SIZE_MISMATCH",
      `Evidence object size does not match its receipt: ${receipt.contentRef}`,
      { expected: receipt.sizeBytes, actual: bytes.byteLength },
    )
  }
  const actualStorageHash = sha256(bytes)
  if (actualStorageHash !== receipt.storageHash) {
    throw integrityError(
      "RALPH_EVIDENCE_OBJECT_HASH_MISMATCH",
      `Evidence object bytes do not match their storage hash: ${receipt.contentRef}`,
      { expected: receipt.storageHash, actual: actualStorageHash },
    )
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch (error) {
    throw new RalphError(
      "RALPH_EVIDENCE_OBJECT_JSON_INVALID",
      `Evidence object is not valid JSON: ${receipt.contentRef}`,
      { exitCode: EXIT_CODES.conflict, cause: error },
    )
  }
  const bundle = EvidenceBundleSchema.parse(value)
  assertEvidenceBundleContentHash(bundle)
  return bundle
}

function resolveEvidenceReference(workspaceRoot: string, ref: string): string {
  const target = resolve(workspaceRoot, ref)
  if (isAbsolute(ref) || !contained(workspaceRoot, target)) {
    throw new RalphError(
      "RALPH_EVIDENCE_OBJECT_REF_INVALID",
      `Evidence object reference escapes the workspace: ${ref}`,
      { exitCode: EXIT_CODES.policyDenied },
    )
  }
  return target
}

export async function persistEvidenceBundleObject(
  workspaceRoot: string,
  layout: RunLayout,
  input: EvidenceBundle,
): Promise<EvidenceObjectReceipt> {
  const root = await realpath(resolve(workspaceRoot))
  const bundle = EvidenceBundleSchema.parse(input)
  assertEvidenceBundleContentHash(bundle)
  const bytes = Buffer.from(`${evidenceBundleCanonicalJson(bundle)}\n`, "utf8")
  const storageHash = sha256(bytes)
  const storeRoot = resolve(layout.evidence, "bundles", "sha256")
  if (!contained(root, storeRoot)) {
    throw new RalphError(
      "RALPH_EVIDENCE_STORE_OUTSIDE_WORKSPACE",
      "Evidence object store resolves outside the workspace",
      { exitCode: EXIT_CODES.policyDenied },
    )
  }
  const bucket = resolve(storeRoot, storageHash.slice(0, 2))
  await mkdir(bucket, { recursive: true })
  const canonicalBucket = await realpath(bucket)
  if (!contained(root, canonicalBucket)) {
    throw new RalphError(
      "RALPH_EVIDENCE_STORE_OUTSIDE_WORKSPACE",
      "Evidence object bucket resolves outside the workspace",
      { exitCode: EXIT_CODES.policyDenied },
    )
  }
  const target = resolve(canonicalBucket, `${storageHash}.json`)
  const receipt: EvidenceObjectReceipt = {
    schemaVersion: 1,
    contentRef: portable(relative(root, target)),
    storageHash,
    sizeBytes: bytes.byteLength,
  }
  try {
    await writeFileAtomic(target, bytes, { overwrite: false })
  } catch (error) {
    try {
      const existing = await readFile(target)
      parseEvidenceObject(existing, receipt)
    } catch {
      throw error
    }
  }
  const verified = await readEvidenceBundleObject(root, receipt)
  if (verified.id !== bundle.id || verified.contentHash !== bundle.contentHash) {
    throw integrityError(
      "RALPH_EVIDENCE_OBJECT_IDENTITY_MISMATCH",
      "Persisted evidence object does not match the requested bundle identity",
    )
  }
  return receipt
}

export async function readEvidenceBundleObject(
  workspaceRoot: string,
  receipt: EvidenceObjectReceipt,
): Promise<EvidenceBundle> {
  validateReceipt(receipt)
  const root = await realpath(resolve(workspaceRoot))
  const target = resolveEvidenceReference(root, receipt.contentRef)
  let metadata: Awaited<ReturnType<typeof lstat>>
  try {
    metadata = await lstat(target)
  } catch (error) {
    if (evidenceObjectMissing(error)) throw missingEvidenceObject(receipt, error)
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw integrityError(
      "RALPH_EVIDENCE_OBJECT_TYPE_INVALID",
      `Evidence object is not a regular file: ${receipt.contentRef}`,
    )
  }
  const canonical = await realpath(target)
  if (!contained(root, canonical)) {
    throw new RalphError(
      "RALPH_EVIDENCE_OBJECT_REF_INVALID",
      `Evidence object resolves outside the workspace: ${receipt.contentRef}`,
      { exitCode: EXIT_CODES.policyDenied },
    )
  }
  return parseEvidenceObject(await readFile(canonical), receipt)
}

export function readEvidenceBundleObjectSync(
  workspaceRoot: string,
  receipt: EvidenceObjectReceipt,
): EvidenceBundle {
  validateReceipt(receipt)
  const root = realpathSync(resolve(workspaceRoot))
  const target = resolveEvidenceReference(root, receipt.contentRef)
  let metadata: ReturnType<typeof lstatSync>
  try {
    metadata = lstatSync(target)
  } catch (error) {
    if (evidenceObjectMissing(error)) throw missingEvidenceObject(receipt, error)
    throw error
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw integrityError(
      "RALPH_EVIDENCE_OBJECT_TYPE_INVALID",
      `Evidence object is not a regular file: ${receipt.contentRef}`,
    )
  }
  const canonical = realpathSync(target)
  if (!contained(root, canonical)) {
    throw new RalphError(
      "RALPH_EVIDENCE_OBJECT_REF_INVALID",
      `Evidence object resolves outside the workspace: ${receipt.contentRef}`,
      { exitCode: EXIT_CODES.policyDenied },
    )
  }
  return parseEvidenceObject(readFileSync(canonical), receipt)
}
