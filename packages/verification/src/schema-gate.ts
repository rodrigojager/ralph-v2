import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { z } from "zod"
import { resolveSafeWorkspaceTarget } from "./path-safety"

const DEFAULT_MAX_SCHEMA_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

export type FileValidationResult =
  | { status: "passed"; contentHash?: string }
  | { status: "failed" | "error"; reason: string; contentHash?: string }

async function readBoundedRegularFile(
  workspaceRoot: string,
  path: string,
  role: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const target = await resolveSafeWorkspaceTarget(workspaceRoot, path)
  if (!target.exists) throw new Error(`${role} does not exist: ${path}`)
  const metadata = await lstat(target.target)
  if (!metadata.isFile()) throw new Error(`${role} is not a regular file: ${path}`)
  if (metadata.size > maxBytes) {
    throw new Error(`${role} exceeds the ${maxBytes}-byte validation limit: ${path}`)
  }
  return readFile(target.target)
}

function jsonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function validateJsonDocumentAgainstSchema(
  workspaceRoot: string,
  documentPath: string,
  schemaPath: string,
  options: { maxDocumentBytes?: number; maxSchemaBytes?: number } = {},
): Promise<FileValidationResult> {
  let documentBytes: Uint8Array
  let schemaBytes: Uint8Array
  try {
    ;[documentBytes, schemaBytes] = await Promise.all([
      readBoundedRegularFile(
        workspaceRoot,
        documentPath,
        "JSON document",
        options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
      ),
      readBoundedRegularFile(
        workspaceRoot,
        schemaPath,
        "JSON Schema",
        options.maxSchemaBytes ?? DEFAULT_MAX_SCHEMA_BYTES,
      ),
    ])
  } catch (error) {
    return { status: "failed", reason: jsonError(error) }
  }

  const contentHash = createHash("sha256").update(documentBytes).digest("hex")
  let document: unknown
  let schemaDocument: unknown
  try {
    document = JSON.parse(new TextDecoder().decode(documentBytes))
  } catch (error) {
    return {
      status: "failed",
      reason: `Target is not valid JSON: ${documentPath}: ${jsonError(error)}`,
      contentHash,
    }
  }
  try {
    schemaDocument = JSON.parse(new TextDecoder().decode(schemaBytes))
  } catch (error) {
    return {
      status: "error",
      reason: `Schema is not valid JSON: ${schemaPath}: ${jsonError(error)}`,
      contentHash,
    }
  }
  if (
    typeof schemaDocument !== "boolean" &&
    (schemaDocument === null || typeof schemaDocument !== "object" || Array.isArray(schemaDocument))
  ) {
    return {
      status: "error",
      reason: `JSON Schema root must be an object or boolean: ${schemaPath}`,
      contentHash,
    }
  }

  let validator: z.ZodType
  try {
    validator = z.fromJSONSchema(schemaDocument as never)
  } catch (error) {
    return {
      status: "error",
      reason: `JSON Schema could not be compiled: ${schemaPath}: ${jsonError(error)}`,
      contentHash,
    }
  }
  const result = validator.safeParse(document)
  if (result.success) return { status: "passed", contentHash }
  const details = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ")
  return {
    status: "failed",
    reason: `JSON document does not satisfy schema ${schemaPath}: ${details}`,
    contentHash,
  }
}

export async function validateFileSha256(
  workspaceRoot: string,
  path: string,
  expectedSha256: string,
): Promise<FileValidationResult> {
  let bytes: Uint8Array
  try {
    bytes = await readBoundedRegularFile(
      workspaceRoot,
      path,
      "Hash target",
      Number.MAX_SAFE_INTEGER,
    )
  } catch (error) {
    return { status: "failed", reason: jsonError(error) }
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex")
  if (contentHash === expectedSha256) return { status: "passed", contentHash }
  return {
    status: "failed",
    reason: `File hash mismatch: ${path}; expected ${expectedSha256}, observed ${contentHash}`,
    contentHash,
  }
}
