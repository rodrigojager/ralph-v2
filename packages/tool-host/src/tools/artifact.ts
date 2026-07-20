import { z } from "zod"
import { Sha256Schema } from "../contracts"
import { jsonInputSchema, type RegisteredTool } from "../registry"

export const ArtifactPublishInputSchema = z
  .object({
    artifactId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    path: z.string().min(1).max(4_096),
    expectedSha256: Sha256Schema.optional(),
    maximumBytes: z.number().int().positive().optional(),
  })
  .strict()

export function artifactPublishTool(): RegisteredTool {
  return {
    definition: {
      schemaVersion: 1,
      name: "artifact.publish",
      description:
        "Publish an existing regular workspace file through the orchestrator-owned artifact store.",
      inputSchema: jsonInputSchema(ArtifactPublishInputSchema),
      risk: "external-effect",
      mutatesWorkspace: false,
    },
    inputSchema: ArtifactPublishInputSchema,
    assess(input, context) {
      const parsed = ArtifactPublishInputSchema.parse(input)
      return {
        facts: {
          risk: "external-effect",
          mutatesWorkspace: false,
          pathProtected: context.resolver.isProtected(parsed.path),
          pathInReadScope: context.resolver.isInScope(parsed.path, "read"),
          pathInWriteScope: false,
          shell: false,
        },
        reason: `Artifact publication requested for ${parsed.path}`,
      }
    },
    async execute(input, context) {
      const parsed = ArtifactPublishInputSchema.parse(input)
      const resolved = await context.resolver.resolve(parsed.path, "read", { mustExist: true })
      const artifact = await context.artifacts.publish({
        artifactId: parsed.artifactId,
        workspaceRoot: context.resolver.root,
        path: resolved.portablePath,
        ...(parsed.expectedSha256 ? { expectedSha256: parsed.expectedSha256 } : {}),
        maximumBytes: Math.min(
          parsed.maximumBytes ?? context.policy.limits.maxReadBytes,
          context.policy.limits.maxReadBytes,
        ),
      })
      return {
        content: artifact,
        effects: [
          {
            path: artifact.path,
            kind: "artifact",
            afterSha256: artifact.contentHash,
            ref: artifact.ref,
          },
        ],
        outputRefs: [artifact.ref],
        recovery: "effect-confirmed",
      }
    },
  }
}
