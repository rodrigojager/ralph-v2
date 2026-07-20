import { lstat } from "node:fs/promises"
import type { VerificationSpec } from "@ralph-next/prd"
import { resolveSafeWorkspaceTarget } from "./path-safety"
import { validateFileSha256, validateJsonDocumentAgainstSchema } from "./schema-gate"

type ArtifactSpecification = Extract<VerificationSpec, { type: "artifact" }>

export type ArtifactContractResult = {
  status: "passed" | "failed" | "error"
  schemaStatus: "passed" | "failed" | "not_requested" | "unavailable"
  contentHash?: string
  reason?: string
}

export async function validateArtifactContract(
  workspaceRoot: string,
  specification: ArtifactSpecification,
  options: { capturedContentHash?: string } = {},
): Promise<ArtifactContractResult> {
  try {
    const target = await resolveSafeWorkspaceTarget(workspaceRoot, specification.path)
    if (!target.exists) {
      return {
        status: "failed",
        schemaStatus: specification.schema ? "unavailable" : "not_requested",
        reason: `Artifact does not exist: ${specification.path}`,
      }
    }
    const metadata = await lstat(target.target)
    if (!metadata.isFile() || metadata.size === 0) {
      return {
        status: "failed",
        schemaStatus: specification.schema ? "unavailable" : "not_requested",
        reason: `Artifact must be a non-empty regular file: ${specification.path}`,
      }
    }

    const expectedHash = specification.expectedSha256 ?? options.capturedContentHash
    let contentHash: string | undefined
    if (expectedHash) {
      const hash = await validateFileSha256(workspaceRoot, specification.path, expectedHash)
      contentHash = hash.contentHash
      if (hash.status !== "passed") {
        const reason = specification.expectedSha256
          ? `Artifact hash mismatch: expected ${specification.expectedSha256}, observed ${contentHash ?? "unavailable"}`
          : `Artifact changed after immutable capture: ${specification.path}`
        return {
          status: hash.status,
          schemaStatus: specification.schema ? "unavailable" : "not_requested",
          ...(contentHash ? { contentHash } : {}),
          reason,
        }
      }
    }

    if (specification.schema) {
      const schema = await validateJsonDocumentAgainstSchema(
        workspaceRoot,
        specification.path,
        specification.schema,
      )
      if (contentHash && schema.contentHash && contentHash !== schema.contentHash) {
        return {
          status: "error",
          schemaStatus: "unavailable",
          contentHash: schema.contentHash,
          reason: `Artifact changed while its hash and schema were being validated: ${specification.path}`,
        }
      }
      if (schema.status !== "passed") {
        return {
          status: schema.status,
          schemaStatus: schema.status === "failed" ? "failed" : "unavailable",
          ...(schema.contentHash ? { contentHash: schema.contentHash } : {}),
          ...(schema.reason ? { reason: schema.reason } : {}),
        }
      }
      const validatedContentHash = schema.contentHash ?? contentHash
      return {
        status: "passed",
        schemaStatus: "passed",
        ...(validatedContentHash ? { contentHash: validatedContentHash } : {}),
      }
    }

    return {
      status: "passed",
      schemaStatus: "not_requested",
      ...(contentHash ? { contentHash } : {}),
    }
  } catch (error) {
    return {
      status: "error",
      schemaStatus: specification.schema ? "unavailable" : "not_requested",
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
