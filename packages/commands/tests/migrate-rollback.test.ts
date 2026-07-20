import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  EXIT_CODES,
  LEGACY_MIGRATION_ROLLBACK_POLICY,
  type LegacyMigrationRollbackManifest,
} from "../../domain/src/index"
import { executeCli } from "../src/index"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

type MigrationFixture = {
  readonly root: string
  readonly sourceRoot: string
  readonly destinationRoot: string
  readonly manifestPath: string
  readonly configPath: string
  readonly prdPath: string
  readonly reportPath: string
  readonly sourceSentinel: string
  readonly destinationSentinel: string
  readonly managedAreaSentinel: string
  readonly manifest: LegacyMigrationRollbackManifest
}

async function writeManifest(fixture: MigrationFixture): Promise<void> {
  await writeFile(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8")
}

async function fixture(): Promise<MigrationFixture> {
  const root = await mkdtemp(join(tmpdir(), "ralph-migrate-rollback-"))
  temporaryRoots.push(root)
  const requestedSource = join(root, "legacy source")
  const requestedDestination = join(root, "v2 destino ünicode")
  await mkdir(requestedSource, { recursive: true })
  await mkdir(requestedDestination, { recursive: true })
  const sourceRoot = await realpath(requestedSource)
  const destinationRoot = await realpath(requestedDestination)
  const migrationId = randomUUID()
  const migrationRoot = join(destinationRoot, ".ralph", "migration", migrationId)
  const configPath = join(destinationRoot, ".ralph", "config.yaml")
  const prdPath = join(destinationRoot, "PRD.migrated.md")
  const reportPath = join(migrationRoot, "report.json")
  const manifestPath = join(migrationRoot, "rollback-manifest.json")
  const sourceSentinel = join(sourceRoot, "source-sentinel.txt")
  const destinationSentinel = join(destinationRoot, "unrelated-sentinel.txt")
  const managedAreaSentinel = join(destinationRoot, ".ralph", "operator-note.txt")
  await mkdir(migrationRoot, { recursive: true })
  const files = [
    { path: ".ralph/config.yaml", absolutePath: configPath, content: "schema_version: 1\n" },
    {
      path: `.ralph/migration/${migrationId}/report.json`,
      absolutePath: reportPath,
      content: '{"schemaVersion":1}\n',
    },
    { path: "PRD.migrated.md", absolutePath: prdPath, content: "# migrated\n" },
  ]
  for (const file of files) await writeFile(file.absolutePath, file.content, "utf8")
  await writeFile(sourceSentinel, "legacy stays unchanged\n", "utf8")
  await writeFile(destinationSentinel, "unrelated stays unchanged\n", "utf8")
  await writeFile(managedAreaSentinel, "post-migration operator file stays unchanged\n", "utf8")
  const manifest: LegacyMigrationRollbackManifest = {
    schemaVersion: 1,
    migrationId,
    sourceRoot,
    sourceFingerprint: sha256("source-fixture"),
    destinationRoot,
    destinationWasFresh: true,
    createdFiles: files.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
    manifestSelfExcluded: `.ralph/migration/${migrationId}/rollback-manifest.json`,
    rollbackPolicy: {
      automaticOnApplyFailure: true,
      laterRollback: LEGACY_MIGRATION_ROLLBACK_POLICY,
      sourceFilesToDelete: [],
      sourceWasModified: false,
    },
  }
  const result = {
    root,
    sourceRoot,
    destinationRoot,
    manifestPath,
    configPath,
    prdPath,
    reportPath,
    sourceSentinel,
    destinationSentinel,
    managedAreaSentinel,
    manifest,
  }
  await writeManifest(result)
  return result
}

function context(root: string) {
  return { version: "0.1.0-test", cwd: root, environment: {} }
}

describe("migrate rollback", () => {
  test("requires exactly one preview or hash-confirmed apply mode", async () => {
    const setup = await fixture()
    const missingMode = await executeCli(
      ["migrate", "rollback", setup.manifestPath],
      context(setup.root),
    )
    expect(missingMode.exitCode).toBe(EXIT_CODES.invalidUsage)
    expect(missingMode.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_MIGRATION_ROLLBACK_CONFIRMATION_MISSING",
    )

    const conflictingModes = await executeCli(
      [
        "migrate",
        "rollback",
        setup.manifestPath,
        "--dry-run",
        "--confirm-plan-hash",
        "0".repeat(64),
      ],
      context(setup.root),
    )
    expect(conflictingModes.exitCode).toBe(EXIT_CODES.invalidUsage)
    expect(conflictingModes.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_MIGRATION_ROLLBACK_CONFIRMATION_MODE_CONFLICT",
    )
  })

  test("previews by hash and removes only unchanged created files plus empty directories", async () => {
    const setup = await fixture()
    const sourceBefore = await readFile(setup.sourceSentinel, "utf8")
    const destinationSentinelBefore = await readFile(setup.destinationSentinel, "utf8")
    const managedAreaSentinelBefore = await readFile(setup.managedAreaSentinel, "utf8")

    const preview = await executeCli(
      ["migrate", "rollback", setup.manifestPath, "--dry-run", "--format", "json"],
      context(setup.root),
    )
    const previewData = preview.execution.result.data as {
      planHash: string
      mutationPerformed: boolean
      sourceWillBeModified: boolean
    }
    expect(preview.exitCode).toBe(EXIT_CODES.success)
    expect(previewData).toMatchObject({ mutationPerformed: false, sourceWillBeModified: false })
    expect(previewData.planHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await exists(setup.configPath)).toBe(true)
    expect(await exists(setup.manifestPath)).toBe(true)

    const applied = await executeCli(
      [
        "migrate",
        "rollback",
        setup.manifestPath,
        "--confirm-plan-hash",
        previewData.planHash,
        "--format",
        "json",
      ],
      context(setup.root),
    )
    expect(applied.exitCode).toBe(EXIT_CODES.success)
    expect(applied.execution.result.data).toMatchObject({
      mutationPerformed: true,
      sourceModified: false,
      removedFileCount: 4,
    })
    expect(await exists(setup.configPath)).toBe(false)
    expect(await exists(setup.prdPath)).toBe(false)
    expect(await exists(setup.reportPath)).toBe(false)
    expect(await exists(setup.manifestPath)).toBe(false)
    expect(await readFile(setup.sourceSentinel, "utf8")).toBe(sourceBefore)
    expect(await readFile(setup.destinationSentinel, "utf8")).toBe(destinationSentinelBefore)
    expect(await readFile(setup.managedAreaSentinel, "utf8")).toBe(managedAreaSentinelBefore)
    expect(await exists(join(setup.destinationRoot, ".ralph"))).toBe(true)
    expect(await exists(setup.destinationRoot)).toBe(true)
  })

  test("refuses a stale confirmed plan without removing any listed file", async () => {
    const setup = await fixture()
    const preview = await executeCli(
      ["migrate", "rollback", setup.manifestPath, "--dry-run"],
      context(setup.root),
    )
    const planHash = (preview.execution.result.data as { planHash: string }).planHash
    await writeFile(setup.configPath, "schema_version: 1\nchanged: true\n", "utf8")

    const applied = await executeCli(
      ["migrate", "rollback", setup.manifestPath, "--confirm-plan-hash", planHash],
      context(setup.root),
    )
    expect(applied.exitCode).toBe(EXIT_CODES.conflict)
    expect(applied.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_MIGRATION_ROLLBACK_HASH_MISMATCH",
    )
    expect(await exists(setup.configPath)).toBe(true)
    expect(await exists(setup.prdPath)).toBe(true)
    expect(await exists(setup.reportPath)).toBe(true)
    expect(await exists(setup.manifestPath)).toBe(true)
  })

  test("rejects traversal and duplicate manifest paths", async () => {
    const traversal = await fixture()
    traversal.manifest.createdFiles.push({ path: "../outside.txt", sha256: sha256("outside") })
    await writeManifest(traversal)
    const traversalResult = await executeCli(
      ["migrate", "rollback", traversal.manifestPath, "--dry-run"],
      context(traversal.root),
    )
    expect(traversalResult.exitCode).toBe(EXIT_CODES.policyDenied)
    expect(traversalResult.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_MIGRATION_ROLLBACK_PATH_TRAVERSAL",
    )

    const duplicate = await fixture()
    duplicate.manifest.createdFiles.push({ ...duplicate.manifest.createdFiles[0]! })
    await writeManifest(duplicate)
    const duplicateResult = await executeCli(
      ["migrate", "rollback", duplicate.manifestPath, "--dry-run"],
      context(duplicate.root),
    )
    expect(duplicateResult.exitCode).toBe(EXIT_CODES.policyDenied)
    expect(duplicateResult.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_MIGRATION_ROLLBACK_DUPLICATE_PATH",
    )
  })

  test("rejects a linked created-file ancestor when the platform permits the fixture link", async () => {
    const setup = await fixture()
    const outside = join(setup.root, "outside")
    const linked = join(setup.destinationRoot, ".ralph", "linked")
    const payload = join(outside, "payload.txt")
    await mkdir(outside, { recursive: true })
    await writeFile(payload, "outside payload\n", "utf8")
    try {
      await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return
      throw error
    }
    setup.manifest.createdFiles.push({
      path: ".ralph/linked/payload.txt",
      sha256: sha256("outside payload\n"),
    })
    await writeManifest(setup)

    const result = await executeCli(
      ["migrate", "rollback", setup.manifestPath, "--dry-run"],
      context(setup.root),
    )
    expect(result.exitCode).toBe(EXIT_CODES.policyDenied)
    expect(result.execution.result.diagnostics[0]?.code).toBe(
      "RALPH_MIGRATION_ROLLBACK_LINKED_DIRECTORY",
    )
  })
})
