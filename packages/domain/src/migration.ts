import { z } from "zod"

const BoundedPathSchema = z.string().min(1).max(4_096)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const MigrationIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

export const LEGACY_MIGRATION_ROLLBACK_MAX_FILES = 8_192
export const LEGACY_MIGRATION_ROLLBACK_POLICY =
  "Delete only listed files whose hashes still match, then remove empty v2 directories. Refuse if any file changed."

export const LegacyMigrationRollbackFileSchema = z
  .object({
    path: BoundedPathSchema,
    sha256: Sha256Schema,
  })
  .strict()
export type LegacyMigrationRollbackFile = z.infer<typeof LegacyMigrationRollbackFileSchema>

/**
 * Exact on-disk contract emitted by `migrate apply` and consumed by
 * `migrate rollback`. Path containment, canonical destination binding and
 * platform-specific duplicate detection are intentionally enforced by the
 * command boundary because they depend on the manifest's resolved location.
 */
export const LegacyMigrationRollbackManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    migrationId: MigrationIdSchema,
    sourceRoot: BoundedPathSchema,
    sourceFingerprint: Sha256Schema,
    destinationRoot: BoundedPathSchema,
    destinationWasFresh: z.literal(true),
    createdFiles: z
      .array(LegacyMigrationRollbackFileSchema)
      .min(1)
      .max(LEGACY_MIGRATION_ROLLBACK_MAX_FILES),
    manifestSelfExcluded: BoundedPathSchema,
    rollbackPolicy: z
      .object({
        automaticOnApplyFailure: z.literal(true),
        laterRollback: z.literal(LEGACY_MIGRATION_ROLLBACK_POLICY),
        sourceFilesToDelete: z.array(z.never()).max(0),
        sourceWasModified: z.literal(false),
      })
      .strict(),
  })
  .strict()
export type LegacyMigrationRollbackManifest = z.infer<
  typeof LegacyMigrationRollbackManifestSchema
>
