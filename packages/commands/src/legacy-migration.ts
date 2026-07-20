import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rm, rmdir } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  EXIT_CODES,
  LEGACY_MIGRATION_ROLLBACK_MAX_FILES,
  LEGACY_MIGRATION_ROLLBACK_POLICY,
  type LegacyMigrationRollbackManifest,
  LegacyMigrationRollbackManifestSchema,
  RalphError,
} from "@ralph-next/domain"
import {
  canonicalDirectory,
  initializeWorkspace,
  listWorkspaceFiles,
  readWorkspaceConfig,
  workspaceLayout,
  writeFileAtomic,
  writeJsonAtomic,
} from "@ralph-next/persistence"
import { compilePrdGraph, migrateClassicFile, parseClassicPrdFile } from "@ralph-next/prd"
import {
  acquireFilesystemLease,
  FilesystemLeaseBlockedError,
  removeTrustedFile,
  type TrustedFileIdentity,
} from "@ralph-next/telemetry"
import { parseDocument, stringify } from "yaml"

const MAX_LEGACY_FILE_BYTES = 1_048_576
const MAX_IMPORT_FILES = 256
const MAX_ROLLBACK_TOTAL_BYTES = 256 * 1_048_576
const LEGACY_CONFIG_FILES = ["config.json", "config.yaml", "config.yml"] as const
const LEGACY_PRD_FILES = ["PRD.md", "PRD.yaml", "PRD.yml", "PRD.json"] as const
const TERMINAL_LEGACY_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "stopped",
  "idle",
])

type JsonRecord = Record<string, unknown>

export type LegacyConfigMapping = {
  readonly source: string
  readonly target?: string
  readonly classification: "direct" | "changed" | "unsupported" | "secret-reference"
  readonly value?: unknown
  readonly note: string
}

export type LegacySecretReference = {
  readonly source: string
  readonly suggestedReference: string
  readonly note: string
}

export type LegacyImportArtifact = {
  readonly kind: "adapter" | "recipe"
  readonly name: string
  readonly source: string
  readonly sha256: string
  readonly bytes: number
  readonly importable: boolean
  readonly reason?: string
  readonly summary?: JsonRecord
}

export type LegacyRecoveryArtifact = {
  readonly kind: "heartbeat" | "checkpoint"
  readonly source: string
  readonly sha256: string
  readonly bytes: number
  readonly imported: false
  readonly note: string
}

export type LegacyMigrationInspection = {
  readonly schemaVersion: 1
  readonly sourceProduct: "ralph-v1"
  readonly sourceRoot: string
  readonly inspectedAt: string
  readonly sourceFingerprint: string
  readonly prd: {
    readonly path: string
    readonly sha256: string
    readonly format: string
    readonly taskCount: number
    readonly completed: number
    readonly pending: number
    readonly review: number
    readonly firstUnfinished: {
      readonly index: number
      readonly id?: string
      readonly text: string
    } | null
  } | null
  readonly config: {
    readonly path: string
    readonly sha256: string
    readonly mappings: readonly LegacyConfigMapping[]
    readonly secretReferences: readonly LegacySecretReference[]
  } | null
  readonly state: {
    readonly path: string
    readonly sha256: string
    readonly runStatus: string | null
    readonly active: boolean
    readonly currentRunId: string | null
    readonly currentTaskId: string | null
    readonly lastHeartbeat: string | null
    readonly imported: false
  } | null
  readonly artifacts: readonly LegacyImportArtifact[]
  readonly recoveryArtifacts: readonly LegacyRecoveryArtifact[]
  readonly handoff: {
    readonly activeLegacyRunWillNotBeConverted: boolean
    readonly selectedTaskComesFromValidatedMarkers: boolean
    readonly nextTask: {
      readonly index: number
      readonly id?: string
      readonly text: string
    } | null
    readonly recommendation: string
  }
  readonly warnings: readonly string[]
}

export type LegacyMigrationApplyOptions = {
  readonly source: string
  readonly destination: string
  readonly version: string
  readonly importAdapters: boolean
  readonly importRecipes: boolean
}

export type LegacyMigrationApplyResult = {
  readonly schemaVersion: 1
  readonly migrationId: string
  readonly sourceRoot: string
  readonly destinationRoot: string
  readonly workspaceId: string
  readonly prd: string
  readonly config: string
  readonly report: string
  readonly rollbackManifest: string
  readonly imported: {
    readonly adapters: number
    readonly recipes: number
    readonly activation: "quarantined"
  }
  readonly recoveryArtifacts: {
    readonly inventoried: number
    readonly imported: 0
  }
  readonly handoff: {
    readonly nextTask: LegacyMigrationInspection["handoff"]["nextTask"]
    readonly legacyRunImported: false
    readonly command: string
    readonly requiresProfileSelection: true
  }
}

export type LegacyMigrationRollbackPreview = {
  readonly schemaVersion: 1
  readonly mode: "preview"
  readonly migrationId: string
  readonly manifestPath: string
  readonly manifestSha256: string
  readonly destinationRoot: string
  readonly createdFiles: readonly {
    readonly path: string
    readonly sha256: string
  }[]
  readonly fileCount: number
  readonly emptyDirectoryCandidates: readonly string[]
  readonly directoryCount: number
  readonly sourceFilesToDelete: readonly []
  readonly sourceWillBeModified: false
  readonly requiresExplicitConfirmation: true
  readonly planHash: string
  readonly mutationPerformed: false
}

export type LegacyMigrationRollbackApplyResult = {
  readonly schemaVersion: 1
  readonly mode: "applied"
  readonly migrationId: string
  readonly manifestPath: string
  readonly destinationRoot: string
  readonly confirmedPlanHash: string
  readonly removedFiles: readonly string[]
  readonly removedFileCount: number
  readonly removedEmptyDirectories: readonly string[]
  readonly removedDirectoryCount: number
  readonly sourceFilesDeleted: readonly []
  readonly sourceModified: false
  readonly mutationPerformed: true
}

type RollbackCreatedFile = {
  readonly path: string
  readonly absolutePath: string
  readonly sha256: string
}

type LoadedRollbackManifest = {
  readonly manifest: LegacyMigrationRollbackManifest
  readonly manifestPath: string
  readonly manifestSha256: string
  readonly destinationRoot: string
  readonly migrationRoot: string
  readonly createdFiles: readonly RollbackCreatedFile[]
  readonly emptyDirectoryCandidates: readonly string[]
}

type PreparedRollbackPlan = LoadedRollbackManifest & {
  readonly preview: LegacyMigrationRollbackPreview
}

type RollbackDirectoryIdentity = {
  readonly path: string
  readonly dev: number
  readonly ino: number
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function isContained(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
}

function pathsOverlap(left: string, right: string): boolean {
  return sameResolvedPath(left, right) || isContained(left, right) || isContained(right, left)
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function comparablePath(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized
}

function sameResolvedPath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right)
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function rollbackPolicyError(
  code: string,
  message: string,
  file: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): RalphError {
  return new RalphError(code, message, {
    exitCode: EXIT_CODES.policyDenied,
    file,
    ...(details ? { details } : {}),
    ...(cause !== undefined ? { cause } : {}),
  })
}

function rollbackConflictError(
  code: string,
  message: string,
  file: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): RalphError {
  return new RalphError(code, message, {
    exitCode: EXIT_CODES.conflict,
    file,
    ...(details ? { details } : {}),
    ...(cause !== undefined ? { cause } : {}),
  })
}

async function inspectExistingRollbackDirectories(
  root: string,
  target: string,
): Promise<readonly RollbackDirectoryIdentity[]> {
  const trustedRoot = resolve(root)
  const trustedTarget = resolve(target)
  if (!isContained(trustedRoot, trustedTarget)) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_DIRECTORY_ESCAPE",
      "Rollback directory resolves outside the manifest-bound destination",
      trustedTarget,
      { destinationRoot: trustedRoot },
    )
  }
  const segments = relative(trustedRoot, trustedTarget)
    .split(sep)
    .filter((segment) => segment.length > 0)
  let current = trustedRoot
  const identities: RollbackDirectoryIdentity[] = []
  for (let index = -1; index < segments.length; index += 1) {
    if (index >= 0) current = join(current, segments[index] as string)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(current)
    } catch (error) {
      if (missing(error)) {
        throw rollbackConflictError(
          "RALPH_MIGRATION_ROLLBACK_STATE_CHANGED",
          "A destination directory required by the rollback no longer exists",
          current,
        )
      }
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw rollbackPolicyError(
        "RALPH_MIGRATION_ROLLBACK_LINKED_DIRECTORY",
        "Rollback refuses a symlink, junction, or non-directory path component",
        current,
      )
    }
    const canonical = await realpath(current)
    if (!sameResolvedPath(current, canonical)) {
      throw rollbackPolicyError(
        "RALPH_MIGRATION_ROLLBACK_LINKED_DIRECTORY",
        "Rollback refuses a directory path that resolves through a symlink or junction",
        current,
        { canonical },
      )
    }
    identities.push({ path: current, dev: info.dev, ino: info.ino })
  }
  return identities
}

function sameRollbackDirectoryIdentities(
  left: readonly RollbackDirectoryIdentity[],
  right: readonly RollbackDirectoryIdentity[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        sameResolvedPath(entry.path, right[index]?.path ?? "") &&
        entry.dev === right[index]?.dev &&
        entry.ino === right[index]?.ino,
    )
  )
}

function trustedIdentity(info: Stats): TrustedFileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    size: info.size,
    mtimeMs: info.mtimeMs,
  }
}

function sameTrustedFileIdentity(
  left: TrustedFileIdentity,
  right: TrustedFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  )
}

async function readRollbackFile(
  destinationRoot: string,
  path: string,
  kind: "manifest" | "created",
): Promise<{
  readonly bytes: Buffer
  readonly identity: TrustedFileIdentity
  readonly canonicalPath: string
}> {
  const target = resolve(path)
  const directoryIdentities = await inspectExistingRollbackDirectories(
    destinationRoot,
    dirname(target),
  )
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(target)
  } catch (error) {
    if (missing(error)) {
      if (kind === "manifest") {
        throw new RalphError(
          "RALPH_MIGRATION_ROLLBACK_MANIFEST_NOT_FOUND",
          "Migration rollback manifest was not found",
          { exitCode: EXIT_CODES.notFound, file: target },
        )
      }
      throw rollbackConflictError(
        "RALPH_MIGRATION_ROLLBACK_STATE_CHANGED",
        "A manifest-listed destination file is missing",
        target,
      )
    }
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_LINKED_FILE",
      "Rollback accepts only single-link regular files",
      target,
      { links: info.nlink },
    )
  }
  if (info.size > MAX_LEGACY_FILE_BYTES) {
    const error =
      kind === "manifest"
        ? rollbackPolicyError(
            "RALPH_MIGRATION_ROLLBACK_MANIFEST_TOO_LARGE",
            `Rollback manifest exceeds the ${MAX_LEGACY_FILE_BYTES} byte limit`,
            target,
            { bytes: info.size },
          )
        : rollbackConflictError(
            "RALPH_MIGRATION_ROLLBACK_STATE_CHANGED",
            "A manifest-listed file grew beyond its migration-time bound",
            target,
            { bytes: info.size },
          )
    throw error
  }
  const canonical = await realpath(target)
  if (!sameResolvedPath(target, canonical) || !isContained(destinationRoot, canonical)) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_FILE_ESCAPE",
      "Rollback file resolves outside the manifest-bound destination or through a link",
      target,
      { canonical, destinationRoot },
    )
  }
  const before = trustedIdentity(info)
  const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(target, constants.O_RDONLY | noFollow)
  } catch (error) {
    throw rollbackConflictError(
      "RALPH_MIGRATION_ROLLBACK_STATE_CHANGED",
      "A rollback file changed or became inaccessible while it was being opened",
      target,
      undefined,
      error,
    )
  }
  try {
    const descriptorBefore = await handle.stat()
    if (
      !descriptorBefore.isFile() ||
      descriptorBefore.nlink !== 1 ||
      !sameTrustedFileIdentity(before, trustedIdentity(descriptorBefore))
    ) {
      throw rollbackConflictError(
        "RALPH_MIGRATION_ROLLBACK_STATE_CHANGED",
        "A rollback file changed identity while it was being opened",
        target,
      )
    }
    const bytes = await handle.readFile()
    const [descriptorAfter, pathAfter, canonicalAfter, directoriesAfter] = await Promise.all([
      handle.stat(),
      lstat(target),
      realpath(target),
      inspectExistingRollbackDirectories(destinationRoot, dirname(target)),
    ])
    const after = trustedIdentity(descriptorAfter)
    if (
      !descriptorAfter.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      descriptorAfter.nlink !== 1 ||
      pathAfter.nlink !== 1 ||
      !sameTrustedFileIdentity(before, after) ||
      !sameTrustedFileIdentity(after, trustedIdentity(pathAfter)) ||
      !sameResolvedPath(canonical, canonicalAfter) ||
      !sameRollbackDirectoryIdentities(directoryIdentities, directoriesAfter)
    ) {
      throw rollbackConflictError(
        "RALPH_MIGRATION_ROLLBACK_STATE_CHANGED",
        "A rollback file or parent directory changed while it was being verified",
        target,
      )
    }
    return { bytes, identity: after, canonicalPath: canonicalAfter }
  } catch (error) {
    if (error instanceof RalphError) throw error
    throw rollbackConflictError(
      "RALPH_MIGRATION_ROLLBACK_STATE_CHANGED",
      "A rollback file changed or became unsafe while it was being verified",
      target,
      undefined,
      error,
    )
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function validatedRollbackRelativePath(
  destinationRoot: string,
  path: string,
  manifestPath: string,
): string {
  if (
    path.includes("\\") ||
    path.includes(":") ||
    path.startsWith("/") ||
    isAbsolute(path) ||
    containsControlCharacter(path)
  ) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_PATH_INVALID",
      "Rollback manifest contains a non-portable or absolute created-file path",
      manifestPath,
      { path },
    )
  }
  const segments = path.split("/")
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    )
  ) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_PATH_TRAVERSAL",
      "Rollback manifest contains an ambiguous or traversing created-file path",
      manifestPath,
      { path },
    )
  }
  if (path !== "PRD.migrated.md" && !path.startsWith(".ralph/")) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_PATH_UNMANAGED",
      "Rollback manifest may identify only PRD.migrated.md and files below .ralph",
      manifestPath,
      { path },
    )
  }
  const absolute = resolve(destinationRoot, ...segments)
  if (
    !isContained(destinationRoot, absolute) ||
    portable(relative(destinationRoot, absolute)) !== path
  ) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_PATH_TRAVERSAL",
      "Rollback manifest created-file path escapes or changes after normalization",
      manifestPath,
      { path },
    )
  }
  return absolute
}

function rollbackDirectoryCandidates(
  destinationRoot: string,
  manifestPath: string,
  createdFiles: readonly RollbackCreatedFile[],
): readonly string[] {
  const ralphRoot = join(destinationRoot, ".ralph")
  const candidates = new Set<string>()
  for (const file of [...createdFiles.map((entry) => entry.absolutePath), manifestPath]) {
    let current = dirname(file)
    while (!sameResolvedPath(current, destinationRoot)) {
      if (isContained(ralphRoot, current)) {
        candidates.add(portable(relative(destinationRoot, current)))
      }
      const parent = dirname(current)
      if (sameResolvedPath(parent, current)) break
      current = parent
    }
  }
  return [...candidates].sort((left, right) => {
    const depth = right.split("/").length - left.split("/").length
    return depth !== 0 ? depth : compareText(left, right)
  })
}

async function loadRollbackManifest(requestedManifest: string): Promise<LoadedRollbackManifest> {
  const manifestPath = resolve(requestedManifest)
  const migrationRoot = dirname(manifestPath)
  const migrationDirectory = dirname(migrationRoot)
  const ralphRoot = dirname(migrationDirectory)
  const destinationRoot = dirname(ralphRoot)
  if (
    basename(manifestPath) !== "rollback-manifest.json" ||
    basename(migrationDirectory) !== "migration" ||
    basename(ralphRoot) !== ".ralph"
  ) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_MANIFEST_LOCATION_INVALID",
      "Rollback manifest must be .ralph/migration/<migration-id>/rollback-manifest.json",
      manifestPath,
    )
  }
  const manifestSnapshot = await readRollbackFile(destinationRoot, manifestPath, "manifest")
  let decoded: unknown
  try {
    decoded = JSON.parse(manifestSnapshot.bytes.toString("utf8"))
  } catch (error) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_MANIFEST_JSON_INVALID",
      "Rollback manifest is not valid JSON",
      manifestPath,
      undefined,
      error,
    )
  }
  const parsed = LegacyMigrationRollbackManifestSchema.safeParse(decoded)
  if (!parsed.success) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_MANIFEST_SCHEMA_INVALID",
      "Rollback manifest does not match the strict supported schema",
      manifestPath,
      {
        issues: parsed.error.issues.slice(0, 32).map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      },
    )
  }
  const manifest = parsed.data
  if (basename(migrationRoot) !== manifest.migrationId) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_ID_MISMATCH",
      "Rollback manifest migrationId does not match its containing directory",
      manifestPath,
      { migrationId: manifest.migrationId, directory: basename(migrationRoot) },
    )
  }
  if (
    !isAbsolute(manifest.destinationRoot) ||
    containsControlCharacter(manifest.destinationRoot) ||
    !sameResolvedPath(manifest.destinationRoot, destinationRoot)
  ) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_DESTINATION_MISMATCH",
      "Rollback manifest destinationRoot is not bound to the manifest location",
      manifestPath,
      { manifestDestination: manifest.destinationRoot, destinationRoot },
    )
  }
  const expectedManifestRelative = portable(relative(destinationRoot, manifestPath))
  validatedRollbackRelativePath(destinationRoot, manifest.manifestSelfExcluded, manifestPath)
  if (manifest.manifestSelfExcluded !== expectedManifestRelative) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_SELF_PATH_MISMATCH",
      "Rollback manifest self-exclusion path does not match the loaded manifest",
      manifestPath,
      { expected: expectedManifestRelative, actual: manifest.manifestSelfExcluded },
    )
  }
  if (
    !isAbsolute(manifest.sourceRoot) ||
    containsControlCharacter(manifest.sourceRoot) ||
    pathsOverlap(resolve(manifest.sourceRoot), destinationRoot)
  ) {
    throw rollbackPolicyError(
      "RALPH_MIGRATION_ROLLBACK_SOURCE_BOUNDARY_INVALID",
      "Rollback manifest must bind a separate absolute source that will remain untouched",
      manifestPath,
    )
  }

  const seen = new Set<string>()
  const createdFiles: RollbackCreatedFile[] = []
  for (const file of manifest.createdFiles) {
    const absolutePath = validatedRollbackRelativePath(destinationRoot, file.path, manifestPath)
    if (sameResolvedPath(absolutePath, manifestPath)) {
      throw rollbackPolicyError(
        "RALPH_MIGRATION_ROLLBACK_SELF_LISTED",
        "Rollback manifest must exclude itself from the created-file inventory",
        manifestPath,
      )
    }
    const key = process.platform === "win32" ? file.path.toLocaleLowerCase("en-US") : file.path
    if (seen.has(key)) {
      throw rollbackPolicyError(
        "RALPH_MIGRATION_ROLLBACK_DUPLICATE_PATH",
        "Rollback manifest contains a duplicate created-file path",
        manifestPath,
        { path: file.path },
      )
    }
    seen.add(key)
    createdFiles.push({ path: file.path, absolutePath, sha256: file.sha256 })
  }
  createdFiles.sort((left, right) => compareText(left.path, right.path))
  const seenCanonicalFiles = new Set<string>()
  let verifiedBytes = 0
  for (const file of createdFiles) {
    const snapshot = await readRollbackFile(destinationRoot, file.absolutePath, "created")
    verifiedBytes += snapshot.bytes.byteLength
    if (verifiedBytes > MAX_ROLLBACK_TOTAL_BYTES) {
      throw rollbackPolicyError(
        "RALPH_MIGRATION_ROLLBACK_INVENTORY_TOO_LARGE",
        `Rollback created-file inventory exceeds the ${MAX_ROLLBACK_TOTAL_BYTES} byte verification bound`,
        manifestPath,
        { verifiedBytes, maximumBytes: MAX_ROLLBACK_TOTAL_BYTES },
      )
    }
    const canonicalKey = comparablePath(snapshot.canonicalPath)
    if (seenCanonicalFiles.has(canonicalKey)) {
      throw rollbackPolicyError(
        "RALPH_MIGRATION_ROLLBACK_DUPLICATE_PATH",
        "Rollback manifest paths resolve to the same destination file",
        manifestPath,
        { path: file.path, canonicalPath: snapshot.canonicalPath },
      )
    }
    seenCanonicalFiles.add(canonicalKey)
    const actualHash = sha256(snapshot.bytes)
    if (actualHash !== file.sha256) {
      throw rollbackConflictError(
        "RALPH_MIGRATION_ROLLBACK_HASH_MISMATCH",
        "A manifest-listed destination file no longer matches its migration-time hash",
        file.absolutePath,
        { path: file.path, expectedSha256: file.sha256, actualSha256: actualHash },
      )
    }
  }
  return {
    manifest,
    manifestPath,
    manifestSha256: sha256(manifestSnapshot.bytes),
    destinationRoot,
    migrationRoot,
    createdFiles,
    emptyDirectoryCandidates: rollbackDirectoryCandidates(
      destinationRoot,
      manifestPath,
      createdFiles,
    ),
  }
}

async function prepareRollbackPlan(requestedManifest: string): Promise<PreparedRollbackPlan> {
  const loaded = await loadRollbackManifest(requestedManifest)
  const projection = {
    schemaVersion: 1,
    kind: "ralph.migration.rollback.plan.v1",
    migrationId: loaded.manifest.migrationId,
    destinationRoot: loaded.destinationRoot,
    manifest: {
      path: loaded.manifest.manifestSelfExcluded,
      sha256: loaded.manifestSha256,
    },
    createdFiles: loaded.createdFiles.map((file) => ({ path: file.path, sha256: file.sha256 })),
    emptyDirectoryCandidates: loaded.emptyDirectoryCandidates,
    sourceFilesToDelete: [] as const,
    sourceWillBeModified: false as const,
  }
  const planHash = sha256(`ralph.migration.rollback.plan.v1\n${stableJson(projection)}`)
  return {
    ...loaded,
    preview: {
      schemaVersion: 1,
      mode: "preview",
      migrationId: loaded.manifest.migrationId,
      manifestPath: loaded.manifestPath,
      manifestSha256: loaded.manifestSha256,
      destinationRoot: loaded.destinationRoot,
      createdFiles: projection.createdFiles,
      fileCount: projection.createdFiles.length,
      emptyDirectoryCandidates: loaded.emptyDirectoryCandidates,
      directoryCount: loaded.emptyDirectoryCandidates.length,
      sourceFilesToDelete: [],
      sourceWillBeModified: false,
      requiresExplicitConfirmation: true,
      planHash,
      mutationPerformed: false,
    },
  }
}

async function optionalRegularFile(root: string, path: string): Promise<Uint8Array | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new RalphError(
      "RALPH_LEGACY_ARTIFACT_UNSAFE",
      `Legacy artifact must be a regular non-linked file: ${path}`,
      { exitCode: EXIT_CODES.policyDenied, file: path },
    )
  }
  if (info.size > MAX_LEGACY_FILE_BYTES) {
    throw new RalphError(
      "RALPH_LEGACY_ARTIFACT_TOO_LARGE",
      `Legacy artifact exceeds the ${MAX_LEGACY_FILE_BYTES} byte inspection limit: ${path}`,
      { exitCode: EXIT_CODES.policyDenied, file: path, details: { bytes: info.size } },
    )
  }
  const canonical = await realpath(path)
  if (!isContained(root, canonical)) {
    throw new RalphError(
      "RALPH_LEGACY_ARTIFACT_OUTSIDE_SOURCE",
      `Legacy artifact resolves outside the selected source: ${path}`,
      { exitCode: EXIT_CODES.policyDenied, file: path },
    )
  }
  return readFile(canonical)
}

async function requireLegacyStateDirectory(root: string): Promise<string> {
  const path = join(root, ".ralph")
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if (missing(error)) {
      throw new RalphError(
        "RALPH_LEGACY_STATE_NOT_FOUND",
        `No Ralph v1 .ralph directory was found at ${root}`,
        { exitCode: EXIT_CODES.invalidUsage, file: path },
      )
    }
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RalphError(
      "RALPH_LEGACY_STATE_UNSAFE",
      "The selected legacy .ralph path must be a regular directory",
      { exitCode: EXIT_CODES.policyDenied, file: path },
    )
  }
  if (await optionalRegularFile(root, join(path, "workspace.json"))) {
    throw new RalphError(
      "RALPH_MIGRATION_SOURCE_IS_V2",
      "The selected source has a Ralph v2 workspace identity and is not a Ralph v1 migration source",
      { exitCode: EXIT_CODES.conflict, file: join(path, "workspace.json") },
    )
  }
  return path
}

function parseDataFile(bytes: Uint8Array, path: string): JsonRecord {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  let value: unknown
  if (extname(path).toLowerCase() === ".json") {
    try {
      value = JSON.parse(text)
    } catch (error) {
      throw new RalphError("RALPH_LEGACY_JSON_INVALID", `Invalid legacy JSON: ${path}`, {
        exitCode: EXIT_CODES.invalidUsage,
        file: path,
        cause: error,
      })
    }
  } else {
    const document = parseDocument(text, { strict: true, uniqueKeys: true })
    if (document.errors.length > 0) {
      throw new RalphError("RALPH_LEGACY_YAML_INVALID", `Invalid legacy YAML: ${path}`, {
        exitCode: EXIT_CODES.invalidUsage,
        file: path,
        details: { errors: document.errors.map((error) => error.message) },
      })
    }
    value = document.toJS({ maxAliasCount: 50 })
  }
  if (!isRecord(value)) {
    throw new RalphError(
      "RALPH_LEGACY_DOCUMENT_ROOT_INVALID",
      `Legacy document root must be an object: ${path}`,
      { exitCode: EXIT_CODES.invalidUsage, file: path },
    )
  }
  return value
}

function nestedValue(root: JsonRecord, path: string): unknown {
  let current: unknown = root
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function setNested(root: JsonRecord, path: string, value: unknown): void {
  const segments = path.split(".")
  let target = root
  for (const segment of segments.slice(0, -1)) {
    const existing = target[segment]
    if (isRecord(existing)) target = existing
    else {
      const next: JsonRecord = {}
      target[segment] = next
      target = next
    }
  }
  const leaf = segments.at(-1)
  if (leaf) target[leaf] = value
}

function environmentReference(path: string): string {
  const name = path
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
  return `env:RALPH_LEGACY_${name || "SECRET"}`
}

function looksSensitive(path: string, value: unknown): boolean {
  if (/(?:secret|token|password|api[_-]?key|credential)/i.test(path)) return true
  return (
    typeof value === "string" &&
    /(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:sk|ghp|github_pat|glpat)-?[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|password)\s*[=:]\s*\S+)/i.test(
      value,
    )
  )
}

function collectSecrets(value: unknown, output: LegacySecretReference[], prefix = "config"): void {
  if (!isRecord(value)) return
  for (const [key, item] of Object.entries(value)) {
    const path = `${prefix}.${key}`
    if (looksSensitive(path, item)) {
      output.push({
        source: path,
        suggestedReference: environmentReference(path),
        note: "Secret material was detected and deliberately omitted; create a credential/environment reference manually.",
      })
      continue
    }
    collectSecrets(item, output, path)
  }
}

function scalarMapping(
  source: JsonRecord,
  layer: JsonRecord,
  mappings: LegacyConfigMapping[],
  input: {
    legacy: string
    target: string
    classification?: "direct" | "changed"
    accept: (value: unknown) => boolean
    transform?: (value: unknown) => unknown
    note: string
  },
): void {
  const value = nestedValue(source, input.legacy)
  if (value === undefined) return
  if (!input.accept(value) || looksSensitive(input.legacy, value)) {
    mappings.push({
      source: input.legacy,
      classification: "unsupported",
      note: "Value is outside the Ralph v2 schema and was not imported.",
    })
    return
  }
  const mapped = input.transform ? input.transform(value) : value
  setNested(layer, input.target, mapped)
  mappings.push({
    source: input.legacy,
    target: input.target,
    classification: input.classification ?? "direct",
    value: mapped,
    note: input.note,
  })
}

function mapLegacyConfig(config: JsonRecord): {
  layer: JsonRecord
  mappings: LegacyConfigMapping[]
  secrets: LegacySecretReference[]
} {
  const layer: JsonRecord = { schema_version: 1 }
  const mappings: LegacyConfigMapping[] = []
  const secrets: LegacySecretReference[] = []
  collectSecrets(config, secrets)
  const integerAtLeast =
    (minimum: number) =>
    (value: unknown): boolean =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  const boolean = (value: unknown): boolean => typeof value === "boolean"
  const oneOf =
    (...values: readonly string[]) =>
    (value: unknown): boolean =>
      typeof value === "string" && values.includes(value)

  scalarMapping(config, layer, mappings, {
    legacy: "parallel.max_parallel",
    target: "parallel.max_parallel",
    accept: integerAtLeast(1),
    note: "Concurrency limit maps directly.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "parallel.integration_strategy",
    target: "parallel.integration_strategy",
    accept: oneOf("merge", "create-pr", "no-merge"),
    note: "Integration strategy maps directly.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "run.no_change_policy",
    target: "run.no_change.policy",
    classification: "changed",
    accept: oneOf("fallback", "retry", "fail-fast"),
    note: "The legacy flat key moved under run.no_change.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "run.no_change_max_attempts",
    target: "run.no_change.max_attempts",
    classification: "changed",
    accept: integerAtLeast(0),
    note: "The legacy flat key moved under run.no_change.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "run.no_change_stop_on_max_attempts",
    target: "run.no_change.stop_on_exhausted",
    classification: "changed",
    accept: boolean,
    note: "The exhaustion flag was renamed.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "run.include_progress_context",
    target: "run.include_progress_context",
    accept: boolean,
    note: "Progress-context behavior maps directly.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "run.include_repo_map_context",
    target: "run.include_repo_map_context",
    accept: boolean,
    note: "Repo-map context behavior maps directly.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "run.auto_checkpoints",
    target: "git.auto_checkpoints",
    classification: "changed",
    accept: boolean,
    note: "Checkpoint policy is now owned by the Git configuration block.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "security.mode",
    target: "security.mode",
    accept: oneOf("safe", "auto", "dangerous"),
    note: "Security mode maps directly; v2 applies stricter command/tool policy in addition.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "sandbox.enabled",
    target: "sandbox.enabled",
    accept: boolean,
    note: "Sandbox enablement maps directly.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "sandbox.provider",
    target: "sandbox.provider",
    accept: oneOf("process", "docker", "podman"),
    note: "Only v2-declared sandbox providers are imported.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "sandbox.image",
    target: "sandbox.image",
    accept: (value) => value === null || (typeof value === "string" && value.length > 0),
    note: "Sandbox image maps directly.",
  })
  scalarMapping(config, layer, mappings, {
    legacy: "sandbox.network",
    target: "sandbox.network",
    accept: (value) => value === null || (typeof value === "string" && value.length > 0),
    note: "Sandbox network maps directly.",
  })

  for (const legacy of ["engines", "fallback_engines", "context_rotation", "browser"] as const) {
    if (nestedValue(config, legacy) === undefined) continue
    mappings.push({
      source: legacy,
      classification: "unsupported",
      note:
        legacy === "engines"
          ? "Legacy engines require an explicit provider/profile decision; safe adapter candidates are quarantined when --import-adapters is used."
          : "No behaviorally equivalent v2 config field exists; the value remains in the migration report only.",
    })
  }
  for (const secret of secrets) {
    mappings.push({
      source: secret.source,
      classification: "secret-reference",
      note: secret.note,
    })
  }
  return { layer, mappings, secrets }
}

async function findFirstFile(
  root: string,
  paths: readonly string[],
): Promise<{ path: string; bytes: Uint8Array } | undefined> {
  for (const relativePath of paths) {
    const path = join(root, relativePath)
    const bytes = await optionalRegularFile(root, path)
    if (bytes) return { path, bytes }
  }
  return undefined
}

function safeArtifactName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return sanitized || "legacy-artifact"
}

function adapterSummary(value: JsonRecord): JsonRecord {
  const safeArray = (key: string): unknown[] =>
    Array.isArray(value[key])
      ? value[key].map((item) => (looksSensitive(`adapter.${key}`, item) ? "<redacted>" : item))
      : []
  const summary: JsonRecord = {
    schema_version: value.schema_version,
    name: value.name,
    command: looksSensitive("adapter.command", value.command) ? "<redacted>" : value.command,
    prompt_transport: value.prompt_transport,
    output_mode: value.output_mode,
    prompt_flag: value.prompt_flag,
    model_flag: value.model_flag,
    default_args: safeArray("default_args"),
    safe_args: safeArray("safe_args"),
    auto_args: safeArray("auto_args"),
    dangerous_args: safeArray("dangerous_args"),
  }
  return summary
}

function configEngineArtifacts(
  sourceRoot: string,
  configPath: string,
  configBytes: Uint8Array,
  config: JsonRecord,
): LegacyImportArtifact[] {
  const engines = config.engines
  if (!isRecord(engines)) return []
  return Object.entries(engines).flatMap(([name, candidate]) => {
    if (!isRecord(candidate)) return []
    const secrets: LegacySecretReference[] = []
    collectSecrets(candidate, secrets, `config.engines.${name}`)
    const command =
      typeof candidate.command === "string" && candidate.command.trim().length > 0
        ? candidate.command
        : name
    const summary: JsonRecord = {
      source_kind: "config-engine",
      name,
      command: secrets.length > 0 ? "<redacted>" : command,
      default_model: candidate.default_model,
      max_tokens: candidate.max_tokens,
      temperature: candidate.temperature,
      adapter: candidate.adapter,
      activation: "manual-profile-conversion-required",
    }
    return [
      {
        kind: "adapter" as const,
        name: `engine-${name}`,
        source: portable(relative(sourceRoot, configPath)),
        sha256: sha256(configBytes),
        bytes: configBytes.byteLength,
        importable: secrets.length === 0,
        ...(secrets.length > 0
          ? { reason: "Engine configuration contains possible inline secret material." }
          : {}),
        summary,
      },
    ]
  })
}

async function inspectArtifactDirectory(
  sourceRoot: string,
  directory: string,
  kind: LegacyImportArtifact["kind"],
): Promise<LegacyImportArtifact[]> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(directory)
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RalphError(
      "RALPH_LEGACY_IMPORT_DIRECTORY_UNSAFE",
      `Legacy ${kind} path must be a regular directory: ${directory}`,
      { exitCode: EXIT_CODES.policyDenied, file: directory },
    )
  }
  const extension = kind === "adapter" ? ".json" : ".md"
  const names = (await readdir(directory)).filter(
    (name) => extname(name).toLowerCase() === extension,
  )
  if (names.length > MAX_IMPORT_FILES) {
    throw new RalphError(
      "RALPH_LEGACY_IMPORT_LIMIT_EXCEEDED",
      `Legacy ${kind} directory exceeds the ${MAX_IMPORT_FILES} file inspection limit`,
      { exitCode: EXIT_CODES.policyDenied, file: directory },
    )
  }
  const output: LegacyImportArtifact[] = []
  for (const name of names.sort((left, right) => left.localeCompare(right))) {
    const path = join(directory, name)
    const bytes = await optionalRegularFile(sourceRoot, path)
    if (!bytes) continue
    let importable = true
    let reason: string | undefined
    let summary: JsonRecord | undefined
    if (kind === "adapter") {
      try {
        const value = parseDataFile(bytes, path)
        summary = adapterSummary(value)
        if (
          typeof value.name !== "string" ||
          value.name.trim().length === 0 ||
          typeof value.command !== "string" ||
          value.command.trim().length === 0
        ) {
          importable = false
          reason = "Adapter lacks a non-empty name or command."
        } else {
          const secrets: LegacySecretReference[] = []
          collectSecrets(value, secrets, "adapter")
          if (secrets.length > 0) {
            importable = false
            reason = "Adapter contains possible inline secret material."
          }
        }
      } catch (error) {
        importable = false
        reason = error instanceof Error ? error.message : "Adapter JSON is invalid."
      }
    } else {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      if (looksSensitive("recipe", content)) {
        importable = false
        reason = "Recipe contains possible inline secret material."
      }
    }
    output.push({
      kind,
      name: basename(name, extension),
      source: portable(relative(sourceRoot, path)),
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
      importable,
      ...(reason ? { reason } : {}),
      ...(summary ? { summary } : {}),
    })
  }
  return output
}

async function inspectRecoveryArtifacts(
  sourceRoot: string,
  legacyState: string,
): Promise<LegacyRecoveryArtifact[]> {
  const output: LegacyRecoveryArtifact[] = []
  const heartbeatPath = join(legacyState, "heartbeat.json")
  const heartbeat = await optionalRegularFile(sourceRoot, heartbeatPath)
  if (heartbeat) {
    output.push({
      kind: "heartbeat",
      source: portable(relative(sourceRoot, heartbeatPath)),
      sha256: sha256(heartbeat),
      bytes: heartbeat.byteLength,
      imported: false,
      note: "Heartbeat is evidence for handoff inspection only and never becomes a v2 lease.",
    })
  }

  const checkpointRoot = join(legacyState, "checkpoints")
  let rootInfo: Awaited<ReturnType<typeof lstat>>
  try {
    rootInfo = await lstat(checkpointRoot)
  } catch (error) {
    if (missing(error)) return output
    throw error
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new RalphError(
      "RALPH_LEGACY_CHECKPOINT_DIRECTORY_UNSAFE",
      "Legacy checkpoints path must be a regular directory",
      { exitCode: EXIT_CODES.policyDenied, file: checkpointRoot },
    )
  }
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) {
      throw new RalphError(
        "RALPH_LEGACY_CHECKPOINT_DEPTH_EXCEEDED",
        "Legacy checkpoint tree exceeds the inspection depth limit",
        { exitCode: EXIT_CODES.policyDenied, file: directory },
      )
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (output.filter((artifact) => artifact.kind === "checkpoint").length >= MAX_IMPORT_FILES) {
        throw new RalphError(
          "RALPH_LEGACY_CHECKPOINT_LIMIT_EXCEEDED",
          `Legacy checkpoints exceed the ${MAX_IMPORT_FILES} file inspection limit`,
          { exitCode: EXIT_CODES.policyDenied, file: checkpointRoot },
        )
      }
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new RalphError(
          "RALPH_LEGACY_CHECKPOINT_LINKED",
          "Legacy checkpoint trees may not contain links",
          { exitCode: EXIT_CODES.policyDenied, file: path },
        )
      }
      if (entry.isDirectory()) {
        await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile()) {
        throw new RalphError(
          "RALPH_LEGACY_CHECKPOINT_UNSAFE",
          "Legacy checkpoint entries must be regular files or directories",
          { exitCode: EXIT_CODES.policyDenied, file: path },
        )
      }
      const bytes = await optionalRegularFile(sourceRoot, path)
      if (!bytes) continue
      output.push({
        kind: "checkpoint",
        source: portable(relative(sourceRoot, path)),
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        imported: false,
        note: "Legacy checkpoints are inventoried but not replayed into v2 Git/ledger authority.",
      })
    }
  }
  await walk(checkpointRoot, 0)
  return output
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

export async function inspectLegacyWorkspace(
  requestedSource: string,
): Promise<LegacyMigrationInspection> {
  const sourceRoot = await canonicalDirectory(requestedSource)
  const legacyState = await requireLegacyStateDirectory(sourceRoot)
  const warnings: string[] = []

  const prdFile = await findFirstFile(sourceRoot, LEGACY_PRD_FILES)
  let prd: LegacyMigrationInspection["prd"] = null
  if (prdFile) {
    const parsed = await parseClassicPrdFile(
      prdFile.path,
      portable(relative(sourceRoot, prdFile.path)),
    )
    if (!parsed.ok || !parsed.document) {
      throw new RalphError(
        "RALPH_LEGACY_PRD_INVALID",
        "The legacy PRD could not be parsed safely; migration was not inferred",
        {
          exitCode: EXIT_CODES.invalidPrd,
          file: prdFile.path,
          details: { diagnostics: parsed.diagnostics },
        },
      )
    }
    const firstIndex = parsed.document.tasks.findIndex((task) => task.status !== "completed")
    const first = firstIndex >= 0 ? parsed.document.tasks[firstIndex] : undefined
    prd = {
      path: portable(relative(sourceRoot, prdFile.path)),
      sha256: sha256(prdFile.bytes),
      format: parsed.document.sourceFormat,
      taskCount: parsed.document.tasks.length,
      completed: parsed.document.tasks.filter((task) => task.status === "completed").length,
      pending: parsed.document.tasks.filter((task) => task.status === "pending").length,
      review: parsed.document.tasks.filter((task) => task.status === "skipped-for-review").length,
      firstUnfinished: first
        ? {
            index: firstIndex + 1,
            ...(first.id ? { id: first.id } : {}),
            text: first.text,
          }
        : null,
    }
  } else warnings.push("No PRD.md, PRD.yaml, PRD.yml or PRD.json was found in the legacy root.")

  const configFile = await findFirstFile(
    sourceRoot,
    LEGACY_CONFIG_FILES.map((name) => portable(join(".ralph", name))),
  )
  let config: LegacyMigrationInspection["config"] = null
  let configEngines: LegacyImportArtifact[] = []
  if (configFile) {
    const parsed = parseDataFile(configFile.bytes, configFile.path)
    const mapped = mapLegacyConfig(parsed)
    configEngines = configEngineArtifacts(sourceRoot, configFile.path, configFile.bytes, parsed)
    config = {
      path: portable(relative(sourceRoot, configFile.path)),
      sha256: sha256(configFile.bytes),
      mappings: mapped.mappings,
      secretReferences: mapped.secrets,
    }
  } else warnings.push("No recognized Ralph v1 config file was found; v2 defaults will be used.")

  const statePath = join(legacyState, "state.json")
  const stateBytes = await optionalRegularFile(sourceRoot, statePath)
  let state: LegacyMigrationInspection["state"] = null
  if (stateBytes) {
    const value = parseDataFile(stateBytes, statePath)
    const runStatus = stringOrNull(value.run_status)
    const active = runStatus
      ? !TERMINAL_LEGACY_RUN_STATUSES.has(runStatus.toLowerCase())
      : stringOrNull(value.current_task_id) !== null
    state = {
      path: portable(relative(sourceRoot, statePath)),
      sha256: sha256(stateBytes),
      runStatus,
      active,
      currentRunId: stringOrNull(value.current_run_id),
      currentTaskId: stringOrNull(value.current_task_id),
      lastHeartbeat: stringOrNull(value.last_heartbeat),
      imported: false,
    }
  }

  const artifacts = [
    ...configEngines,
    ...(await inspectArtifactDirectory(sourceRoot, join(legacyState, "adapters"), "adapter")),
    ...(await inspectArtifactDirectory(sourceRoot, join(legacyState, "recipes"), "recipe")),
  ]
  const recoveryArtifacts = await inspectRecoveryArtifacts(sourceRoot, legacyState)
  const handoff = {
    activeLegacyRunWillNotBeConverted: state?.active ?? false,
    selectedTaskComesFromValidatedMarkers: prd !== null,
    nextTask: prd?.firstUnfinished ?? null,
    recommendation: state?.active
      ? "Stop or finish the Ralph v1 run first. The v2 destination will start a new run from the first validated unfinished marker."
      : "Start a new Ralph v2 run from the migrated PRD after selecting an executor profile.",
  }
  const fingerprintPayload = {
    prd: prd ? { path: prd.path, sha256: prd.sha256 } : null,
    config: config ? { path: config.path, sha256: config.sha256 } : null,
    state: state ? { path: state.path, sha256: state.sha256 } : null,
    artifacts: artifacts.map((artifact) => ({ source: artifact.source, sha256: artifact.sha256 })),
    recoveryArtifacts: recoveryArtifacts.map((artifact) => ({
      source: artifact.source,
      sha256: artifact.sha256,
    })),
  }
  return {
    schemaVersion: 1,
    sourceProduct: "ralph-v1",
    sourceRoot,
    inspectedAt: new Date().toISOString(),
    sourceFingerprint: sha256(stableJson(fingerprintPayload)),
    prd,
    config,
    state,
    artifacts,
    recoveryArtifacts,
    handoff,
    warnings,
  }
}

async function mappedConfigLayer(
  sourceRoot: string,
  expected: { readonly path: string; readonly sha256: string } | null,
): Promise<JsonRecord> {
  const configFile = await findFirstFile(
    sourceRoot,
    LEGACY_CONFIG_FILES.map((name) => portable(join(".ralph", name))),
  )
  if (!configFile) {
    if (expected) {
      throw new RalphError(
        "RALPH_MIGRATION_SOURCE_CHANGED",
        "Legacy config disappeared after inspection; apply must be restarted",
        { exitCode: EXIT_CODES.conflict, file: resolve(sourceRoot, expected.path) },
      )
    }
    return { schema_version: 1 }
  }
  if (!expected) {
    throw new RalphError(
      "RALPH_MIGRATION_SOURCE_CHANGED",
      "A legacy config appeared after inspection; apply must be restarted",
      { exitCode: EXIT_CODES.conflict, file: configFile.path },
    )
  }
  if (
    portable(relative(sourceRoot, configFile.path)) !== expected.path ||
    sha256(configFile.bytes) !== expected.sha256
  ) {
    throw new RalphError(
      "RALPH_MIGRATION_SOURCE_CHANGED",
      "Legacy config changed after inspection; apply must be restarted from a fresh inspect",
      { exitCode: EXIT_CODES.conflict, file: configFile.path },
    )
  }
  return mapLegacyConfig(parseDataFile(configFile.bytes, configFile.path)).layer
}

async function copyQuarantinedImports(
  inspection: LegacyMigrationInspection,
  destinationRoot: string,
  options: { importAdapters: boolean; importRecipes: boolean },
): Promise<{ adapters: number; recipes: number }> {
  const importRoot = join(destinationRoot, ".ralph", "imports", "ralph-v1")
  let adapters = 0
  let recipes = 0
  for (const artifact of inspection.artifacts) {
    const requested = artifact.kind === "adapter" ? options.importAdapters : options.importRecipes
    if (!requested || !artifact.importable) continue
    const source = resolve(inspection.sourceRoot, artifact.source)
    const directory = join(importRoot, artifact.kind === "adapter" ? "adapters" : "recipes")
    await mkdir(directory, { recursive: true })
    const extension = artifact.kind === "adapter" ? ".json" : ".md"
    const destination = join(
      directory,
      `${safeArtifactName(artifact.name)}-${artifact.sha256.slice(0, 12)}${extension}`,
    )
    const bytes = await optionalRegularFile(inspection.sourceRoot, source)
    if (!bytes || sha256(bytes) !== artifact.sha256) {
      throw new RalphError(
        "RALPH_MIGRATION_SOURCE_CHANGED",
        `Legacy ${artifact.kind} changed after inspection: ${artifact.source}`,
        { exitCode: EXIT_CODES.conflict, file: source },
      )
    }
    if (artifact.kind === "adapter") {
      const value = parseDataFile(bytes, source)
      await writeJsonAtomic(
        destination,
        {
          schemaVersion: 1,
          status: "quarantined",
          activation: "manual-profile-conversion-required",
          source: artifact.source,
          sourceSha256: artifact.sha256,
          manifest: artifact.summary ?? adapterSummary(value),
        },
        { overwrite: false },
      )
      adapters += 1
    } else {
      await writeFileAtomic(destination, bytes, { overwrite: false, mode: 0o600 })
      recipes += 1
    }
  }
  if (adapters + recipes > 0) {
    await writeJsonAtomic(
      join(importRoot, "IMPORT-MANIFEST.json"),
      {
        schemaVersion: 1,
        sourceRoot: inspection.sourceRoot,
        sourceFingerprint: inspection.sourceFingerprint,
        status: "quarantined",
        executableScriptsWereRun: false,
        adaptersRequireManualProfileActivation: true,
        counts: { adapters, recipes },
      },
      { overwrite: false },
    )
  }
  return { adapters, recipes }
}

async function hashCreatedFiles(
  root: string,
  extra: readonly string[],
): Promise<Array<{ path: string; sha256: string }>> {
  const paths = [...(await listWorkspaceFiles(root)), ...extra]
  if (paths.length > LEGACY_MIGRATION_ROLLBACK_MAX_FILES) {
    throw new RalphError(
      "RALPH_MIGRATION_ROLLBACK_INVENTORY_TOO_LARGE",
      "Migration created too many files for a bounded deterministic rollback manifest",
      {
        exitCode: EXIT_CODES.policyDenied,
        details: {
          files: paths.length,
          maximumFiles: LEGACY_MIGRATION_ROLLBACK_MAX_FILES,
        },
      },
    )
  }
  const output: Array<{ path: string; sha256: string }> = []
  let totalBytes = 0
  for (const relativePath of paths) {
    const path = resolve(root, relativePath)
    const bytes = await optionalRegularFile(root, path)
    if (bytes) {
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_ROLLBACK_TOTAL_BYTES) {
        throw new RalphError(
          "RALPH_MIGRATION_ROLLBACK_INVENTORY_TOO_LARGE",
          "Migration created files exceed the bounded rollback verification budget",
          {
            exitCode: EXIT_CODES.policyDenied,
            details: {
              totalBytes,
              maximumBytes: MAX_ROLLBACK_TOTAL_BYTES,
              path: portable(relativePath),
            },
          },
        )
      }
      output.push({ path: portable(relativePath), sha256: sha256(bytes) })
    }
  }
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

function shellQuote(path: string): string {
  return `"${path.replaceAll('"', '\\"')}"`
}

export async function applyLegacyMigration(
  options: LegacyMigrationApplyOptions,
): Promise<LegacyMigrationApplyResult> {
  const inspection = await inspectLegacyWorkspace(options.source)
  if (!inspection.prd) {
    throw new RalphError(
      "RALPH_MIGRATION_PRD_REQUIRED",
      "migrate apply requires a validated legacy PRD; inspect reported none",
      { exitCode: EXIT_CODES.invalidPrd, file: inspection.sourceRoot },
    )
  }
  let requestedDestination = resolve(options.destination)
  try {
    const destinationInfo = await lstat(requestedDestination)
    if (destinationInfo.isSymbolicLink()) {
      throw new RalphError(
        "RALPH_MIGRATION_DESTINATION_LINKED",
        "Migration destination must not be a symlink or junction",
        { exitCode: EXIT_CODES.policyDenied, file: requestedDestination },
      )
    }
  } catch (error) {
    if (!missing(error)) throw error
    const parent = await canonicalDirectory(dirname(requestedDestination))
    requestedDestination = join(parent, basename(requestedDestination))
    if (pathsOverlap(inspection.sourceRoot, requestedDestination)) {
      throw new RalphError(
        "RALPH_MIGRATION_WORKSPACES_OVERLAP",
        "Legacy source and Ralph v2 destination must be separate, non-nested directories",
        {
          exitCode: EXIT_CODES.conflict,
          details: { source: inspection.sourceRoot, destination: requestedDestination },
        },
      )
    }
    await mkdir(requestedDestination)
  }
  const destinationRoot = await canonicalDirectory(requestedDestination)
  if (pathsOverlap(inspection.sourceRoot, destinationRoot)) {
    throw new RalphError(
      "RALPH_MIGRATION_WORKSPACES_OVERLAP",
      "Legacy source and Ralph v2 destination must be separate, non-nested directories",
      {
        exitCode: EXIT_CODES.conflict,
        details: { source: inspection.sourceRoot, destination: destinationRoot },
      },
    )
  }
  const layout = workspaceLayout(destinationRoot)
  try {
    await lstat(layout.ralph)
    throw new RalphError(
      "RALPH_MIGRATION_DESTINATION_STATE_EXISTS",
      "Destination already has .ralph state; migration never merges or overwrites it",
      { exitCode: EXIT_CODES.conflict, file: layout.ralph },
    )
  } catch (error) {
    if (!missing(error)) throw error
  }
  const outputPrd = join(destinationRoot, "PRD.migrated.md")
  try {
    await lstat(outputPrd)
    throw new RalphError(
      "RALPH_MIGRATION_DESTINATION_PRD_EXISTS",
      "Destination already contains PRD.migrated.md; migration will not overwrite it",
      { exitCode: EXIT_CODES.conflict, file: outputPrd },
    )
  } catch (error) {
    if (!missing(error)) throw error
  }

  const sourcePrd = resolve(inspection.sourceRoot, inspection.prd.path)
  const sourcePrdBytes = await optionalRegularFile(inspection.sourceRoot, sourcePrd)
  if (!sourcePrdBytes || sha256(sourcePrdBytes) !== inspection.prd.sha256) {
    throw new RalphError(
      "RALPH_MIGRATION_SOURCE_CHANGED",
      "Legacy PRD changed after inspection; apply must be restarted from a fresh inspect",
      { exitCode: EXIT_CODES.conflict, file: sourcePrd },
    )
  }
  if (inspection.state) {
    const statePath = resolve(inspection.sourceRoot, inspection.state.path)
    const stateBytes = await optionalRegularFile(inspection.sourceRoot, statePath)
    if (!stateBytes || sha256(stateBytes) !== inspection.state.sha256) {
      throw new RalphError(
        "RALPH_MIGRATION_SOURCE_CHANGED",
        "Legacy state changed after inspection; apply will not use a stale handoff decision",
        { exitCode: EXIT_CODES.conflict, file: statePath },
      )
    }
  } else {
    const unexpectedState = await optionalRegularFile(
      inspection.sourceRoot,
      join(inspection.sourceRoot, ".ralph", "state.json"),
    )
    if (unexpectedState) {
      throw new RalphError(
        "RALPH_MIGRATION_SOURCE_CHANGED",
        "Legacy state appeared after inspection; apply will not infer whether a run started",
        {
          exitCode: EXIT_CODES.conflict,
          file: join(inspection.sourceRoot, ".ralph", "state.json"),
        },
      )
    }
  }
  const migrated = await migrateClassicFile(sourcePrd, {
    sourceFile: inspection.prd.path,
    outputFile: "PRD.migrated.md",
  })
  if (!migrated.ok || !migrated.markdown || !migrated.report) {
    throw new RalphError(
      "RALPH_MIGRATION_PRD_FAILED",
      "Legacy PRD migration did not produce a valid v2 document",
      {
        exitCode: EXIT_CODES.invalidPrd,
        file: sourcePrd,
        details: { diagnostics: migrated.diagnostics },
      },
    )
  }

  let initialized = false
  let prdWritten = false
  try {
    const workspace = await initializeWorkspace(destinationRoot, options.version)
    initialized = workspace.created
    if (!initialized) {
      throw new RalphError(
        "RALPH_MIGRATION_DESTINATION_NOT_FRESH",
        "Destination initialization did not create a fresh Ralph v2 identity",
        { exitCode: EXIT_CODES.conflict, file: layout.ralph },
      )
    }
    const migrationId = crypto.randomUUID()
    const migrationRoot = join(layout.ralph, "migration", migrationId)
    const backupRoot = join(migrationRoot, "backup")
    await mkdir(backupRoot, { recursive: true })
    await copyFile(layout.config, join(backupRoot, "generated-config.yaml"))

    const layer = await mappedConfigLayer(
      inspection.sourceRoot,
      inspection.config ? { path: inspection.config.path, sha256: inspection.config.sha256 } : null,
    )
    await writeFileAtomic(layout.config, stringify(layer, { indent: 2, lineWidth: 100 }), {
      overwrite: true,
      mode: 0o600,
    })
    await readWorkspaceConfig(layout.config)
    await writeFileAtomic(outputPrd, migrated.markdown, { overwrite: false, mode: 0o600 })
    prdWritten = true
    const compiledPrd = await compilePrdGraph(outputPrd, {
      workspaceRoot: destinationRoot,
      recursive: true,
    })
    if (!compiledPrd.ok || !compiledPrd.graph) {
      throw new RalphError(
        "RALPH_MIGRATION_PRD_VALIDATION_FAILED",
        "The written PRD did not compile in the destination workspace",
        {
          exitCode: EXIT_CODES.invalidPrd,
          file: outputPrd,
          details: { diagnostics: compiledPrd.diagnostics },
        },
      )
    }

    const imported = await copyQuarantinedImports(inspection, destinationRoot, options)
    const confirmedSource = await inspectLegacyWorkspace(inspection.sourceRoot)
    if (confirmedSource.sourceFingerprint !== inspection.sourceFingerprint) {
      throw new RalphError(
        "RALPH_MIGRATION_SOURCE_CHANGED",
        "Legacy source changed while migration was being prepared; destination was rolled back",
        {
          exitCode: EXIT_CODES.conflict,
          details: {
            inspected: inspection.sourceFingerprint,
            confirmed: confirmedSource.sourceFingerprint,
          },
        },
      )
    }
    const reportPath = join(migrationRoot, "report.json")
    await writeJsonAtomic(
      reportPath,
      {
        schemaVersion: 1,
        migrationId,
        source: inspection,
        destination: {
          root: destinationRoot,
          workspaceId: workspace.workspaceId,
          config: portable(relative(destinationRoot, layout.config)),
          prd: portable(relative(destinationRoot, outputPrd)),
        },
        prdMigration: migrated.report,
        imported: { ...imported, activation: "quarantined" },
        statePolicy: {
          legacyRunImported: false,
          recoveryArtifactsInventoried: inspection.recoveryArtifacts.length,
          recoveryArtifactsImported: 0,
          legacyRunWasActive: inspection.state?.active ?? false,
          selectedTaskComesFromValidatedMarkers: true,
          nextTask: inspection.handoff.nextTask,
        },
      },
      { overwrite: false },
    )

    const rollbackPath = join(migrationRoot, "rollback-manifest.json")
    const createdFiles = await hashCreatedFiles(destinationRoot, ["PRD.migrated.md"])
    const rollbackManifest = LegacyMigrationRollbackManifestSchema.parse({
      schemaVersion: 1,
      migrationId,
      sourceRoot: inspection.sourceRoot,
      sourceFingerprint: inspection.sourceFingerprint,
      destinationRoot,
      destinationWasFresh: true,
      createdFiles,
      manifestSelfExcluded: portable(relative(destinationRoot, rollbackPath)),
      rollbackPolicy: {
        automaticOnApplyFailure: true,
        laterRollback: LEGACY_MIGRATION_ROLLBACK_POLICY,
        sourceFilesToDelete: [],
        sourceWasModified: false,
      },
    })
    await writeJsonAtomic(
      rollbackPath,
      rollbackManifest,
      { overwrite: false },
    )

    return {
      schemaVersion: 1,
      migrationId,
      sourceRoot: inspection.sourceRoot,
      destinationRoot,
      workspaceId: workspace.workspaceId,
      prd: outputPrd,
      config: layout.config,
      report: reportPath,
      rollbackManifest: rollbackPath,
      imported: { ...imported, activation: "quarantined" },
      recoveryArtifacts: {
        inventoried: inspection.recoveryArtifacts.length,
        imported: 0,
      },
      handoff: {
        nextTask: inspection.handoff.nextTask,
        legacyRunImported: false,
        command: `ralph-next run --workspace ${shellQuote(destinationRoot)} --prd PRD.migrated.md --new-run`,
        requiresProfileSelection: true,
      },
    }
  } catch (error) {
    if (prdWritten) await rm(outputPrd, { force: true }).catch(() => undefined)
    if (initialized && isContained(destinationRoot, layout.ralph)) {
      await rm(layout.ralph, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }
}

export async function previewLegacyMigrationRollback(
  manifestPath: string,
): Promise<LegacyMigrationRollbackPreview> {
  return (await prepareRollbackPlan(manifestPath)).preview
}

async function removeVerifiedRollbackFile(input: {
  readonly destinationRoot: string
  readonly path: string
  readonly relativePath: string
  readonly expectedSha256: string
  readonly kind: "manifest" | "created"
}): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof readRollbackFile>>
  try {
    snapshot = await readRollbackFile(input.destinationRoot, input.path, input.kind)
  } catch (error) {
    if (
      input.kind === "manifest" &&
      error instanceof RalphError &&
      error.code === "RALPH_MIGRATION_ROLLBACK_MANIFEST_NOT_FOUND"
    ) {
      throw rollbackConflictError(
        "RALPH_MIGRATION_ROLLBACK_STATE_CHANGED",
        "Rollback manifest disappeared after the confirmed plan was rebuilt",
        input.path,
      )
    }
    throw error
  }
  const actualSha256 = sha256(snapshot.bytes)
  if (actualSha256 !== input.expectedSha256) {
    throw rollbackConflictError(
      "RALPH_MIGRATION_ROLLBACK_HASH_MISMATCH",
      "A rollback file changed after the confirmed plan was rebuilt",
      input.path,
      {
        path: input.relativePath,
        expectedSha256: input.expectedSha256,
        actualSha256,
      },
    )
  }
  try {
    await removeTrustedFile(input.destinationRoot, input.path, snapshot.identity)
  } catch (error) {
    throw rollbackConflictError(
      "RALPH_MIGRATION_ROLLBACK_STATE_CHANGED",
      "A rollback file changed identity before its safe removal",
      input.path,
      { path: input.relativePath },
      error,
    )
  }
}

async function pruneEmptyRollbackDirectories(
  destinationRoot: string,
  candidates: readonly string[],
): Promise<readonly string[]> {
  const removed: string[] = []
  for (const candidate of candidates) {
    const path = resolve(destinationRoot, ...candidate.split("/"))
    if (sameResolvedPath(path, destinationRoot) || !isContained(destinationRoot, path)) continue
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(path)
    } catch (error) {
      if (missing(error)) continue
      throw error
    }
    // Directory cleanup is deliberately best-effort and non-recursive. A
    // linked, replaced, or non-empty candidate is left untouched.
    if (info.isSymbolicLink() || !info.isDirectory()) continue
    const canonical = await realpath(path).catch(() => undefined)
    if (!canonical || !sameResolvedPath(path, canonical)) continue
    try {
      await rmdir(path)
      removed.push(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
        continue
      }
      throw new RalphError(
        "RALPH_MIGRATION_ROLLBACK_DIRECTORY_PRUNE_FAILED",
        "Rollback removed the confirmed files but could not prune an empty directory candidate",
        {
          exitCode: EXIT_CODES.operationalError,
          file: path,
          details: { removedDirectories: removed, candidate },
          cause: error,
        },
      )
    }
  }
  return removed
}

export async function applyLegacyMigrationRollback(input: {
  readonly manifestPath: string
  readonly confirmationPlanHash: string
}): Promise<LegacyMigrationRollbackApplyResult> {
  const initialPlan = await prepareRollbackPlan(input.manifestPath)
  if (initialPlan.preview.planHash !== input.confirmationPlanHash) {
    throw rollbackConflictError(
      "RALPH_MIGRATION_ROLLBACK_CONFIRMATION_MISMATCH",
      "Migration rollback confirmation is not bound to the current preview plan hash",
      initialPlan.manifestPath,
      {
        expectedPlanHash: initialPlan.preview.planHash,
        confirmationPlanHash: input.confirmationPlanHash,
      },
    )
  }

  let lease: Awaited<ReturnType<typeof acquireFilesystemLease>>
  try {
    lease = await acquireFilesystemLease(initialPlan.migrationRoot, ".migration-rollback.lock", {
      waitMs: 1_000,
      graceMs: 30_000,
      heartbeatMs: 5_000,
    })
  } catch (error) {
    if (error instanceof FilesystemLeaseBlockedError) {
      throw rollbackConflictError(
        "RALPH_MIGRATION_ROLLBACK_BUSY",
        "Another process owns or blocks this migration rollback",
        error.path,
        { reason: error.reason },
        error,
      )
    }
    throw error
  }

  const removedFiles: string[] = []
  let confirmedPlan: PreparedRollbackPlan | undefined
  let operationFailure: unknown
  try {
    await lease.assertOwned()
    confirmedPlan = await prepareRollbackPlan(initialPlan.manifestPath)
    if (confirmedPlan.preview.planHash !== input.confirmationPlanHash) {
      throw rollbackConflictError(
        "RALPH_MIGRATION_ROLLBACK_CONFIRMATION_MISMATCH",
        "Migration rollback state changed after preview; generate and confirm a new plan",
        confirmedPlan.manifestPath,
        {
          expectedPlanHash: confirmedPlan.preview.planHash,
          confirmationPlanHash: input.confirmationPlanHash,
        },
      )
    }

    // The plan rebuild above is a complete preflight. Every removal still
    // re-reads, re-hashes and identity-binds the individual file immediately
    // before unlink, preventing a stale preview from authorizing new bytes.
    for (const file of confirmedPlan.createdFiles) {
      await lease.assertOwned()
      await removeVerifiedRollbackFile({
        destinationRoot: confirmedPlan.destinationRoot,
        path: file.absolutePath,
        relativePath: file.path,
        expectedSha256: file.sha256,
        kind: "created",
      })
      removedFiles.push(file.path)
    }
    await lease.assertOwned()
    await removeVerifiedRollbackFile({
      destinationRoot: confirmedPlan.destinationRoot,
      path: confirmedPlan.manifestPath,
      relativePath: confirmedPlan.manifest.manifestSelfExcluded,
      expectedSha256: confirmedPlan.manifestSha256,
      kind: "manifest",
    })
    removedFiles.push(confirmedPlan.manifest.manifestSelfExcluded)
  } catch (error) {
    operationFailure = error
    throw error
  } finally {
    try {
      await lease.release()
    } catch (error) {
      if (operationFailure === undefined) {
        throw new RalphError(
          "RALPH_MIGRATION_ROLLBACK_LEASE_RELEASE_FAILED",
          "Migration rollback removed its confirmed files but could not release its ownership lease",
          {
            exitCode: EXIT_CODES.operationalError,
            file: lease.path,
            details: { removedFiles },
            cause: error,
          },
        )
      }
    }
  }

  if (!confirmedPlan) {
    throw new RalphError(
      "RALPH_MIGRATION_ROLLBACK_INTERNAL_STATE_INVALID",
      "Migration rollback completed without a confirmed plan",
    )
  }
  const removedEmptyDirectories = await pruneEmptyRollbackDirectories(
    confirmedPlan.destinationRoot,
    confirmedPlan.emptyDirectoryCandidates,
  )
  return {
    schemaVersion: 1,
    mode: "applied",
    migrationId: confirmedPlan.manifest.migrationId,
    manifestPath: confirmedPlan.manifestPath,
    destinationRoot: confirmedPlan.destinationRoot,
    confirmedPlanHash: input.confirmationPlanHash,
    removedFiles,
    removedFileCount: removedFiles.length,
    removedEmptyDirectories,
    removedDirectoryCount: removedEmptyDirectories.length,
    sourceFilesDeleted: [],
    sourceModified: false,
    mutationPerformed: true,
  }
}
