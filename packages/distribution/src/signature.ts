import { createHash } from "node:crypto"
import { type ReleaseManifest, ReleaseManifestSchema } from "./contracts"

export function canonicalReleaseJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical release JSON rejects non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalReleaseJson(entry)).join(",")}]`
  if (typeof value !== "object") {
    throw new Error(`Canonical release JSON rejects ${typeof value}`)
  }
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalReleaseJson(record[key])}`)
  return `{${entries.join(",")}}`
}

/**
 * Produces the exact non-circular bytes signed by release tooling and verified
 * by installers. The detached envelope descriptor remains authenticated, while
 * its self-referential digest field is deliberately omitted.
 */
export function canonicalReleaseManifestSigningBytes(raw: ReleaseManifest): Uint8Array {
  const manifest = ReleaseManifestSchema.parse(raw)
  if (manifest.signature.status !== "present") {
    throw new Error("A release without a detached signature has no signing projection")
  }
  const projection = {
    ...manifest,
    signature: {
      status: manifest.signature.status,
      kind: manifest.signature.kind,
      identity: manifest.signature.identity,
      payload: manifest.signature.payload,
    },
  }
  return new TextEncoder().encode(canonicalReleaseJson(projection))
}

export function releaseManifestSigningSha256(raw: ReleaseManifest): string {
  return createHash("sha256").update(canonicalReleaseManifestSigningBytes(raw)).digest("hex")
}
