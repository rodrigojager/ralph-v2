import { createHash } from "node:crypto"

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue }

function canonicalize(value: unknown, seen = new Set<object>()): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical values cannot contain non-finite numbers")
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Canonical values cannot be cyclic")
    seen.add(value)
    try {
      return value.map((item) => canonicalize(item, seen))
    } finally {
      seen.delete(value)
    }
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) throw new Error("Canonical values cannot be cyclic")
    seen.add(value)
    try {
      const output: Record<string, CanonicalValue> = Object.create(null) as Record<
        string,
        CanonicalValue
      >
      for (const key of Object.keys(value).sort()) {
        const child = (value as Record<string, unknown>)[key]
        if (child !== undefined) output[key] = canonicalize(child, seen)
      }
      return output
    } finally {
      seen.delete(value)
    }
  }
  throw new Error(`Canonical values cannot contain ${typeof value}`)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function hashCanonical(namespace: string, value: unknown): string {
  return sha256(`${namespace}\0${canonicalJson(value)}`)
}
