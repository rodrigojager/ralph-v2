import type { Stats } from "node:fs"
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  EXIT_CODES,
  RalphError,
  type WorkspaceIdentity,
  WorkspaceIdentitySchema,
  type WorkspaceStatus,
} from "@ralph/domain"
import { replayWorkspaceEvents } from "@ralph/telemetry"
import { writeJsonAtomic } from "./atomic"
import { loadEffectiveConfig, readWorkspaceConfig, writeDefaultConfig } from "./config"
import {
  appendEvent,
  checkpointLedger,
  flushOutbox,
  initializeLedger,
  readEvents,
  snapshotLedgerWorkspaceEventRetention,
} from "./ledger"
import {
  assertWorkspaceWritable,
  canonicalDirectory,
  findWorkspaceRoot,
  isDirectoryEmpty,
  type WorkspaceLayout,
  workspaceLayout,
} from "./paths"

export type InitializeWorkspaceResult = {
  created: boolean
  repaired: boolean
  root: string
  workspaceId: string
  config: string
  ledger: string
  eventCount: number
}

async function readIdentity(path: string): Promise<WorkspaceIdentity> {
  let value: unknown
  try {
    value = JSON.parse(await Bun.file(path).text())
  } catch (error) {
    throw new RalphError(
      "RALPH_WORKSPACE_IDENTITY_INVALID",
      `Invalid workspace identity: ${path}`,
      {
        exitCode: EXIT_CODES.conflict,
        file: path,
        cause: error,
      },
    )
  }
  const parsed = WorkspaceIdentitySchema.safeParse(value)
  if (!parsed.success) {
    throw new RalphError(
      "RALPH_WORKSPACE_IDENTITY_INVALID",
      "Existing .ralph directory does not contain a valid Ralph v2 identity",
      {
        exitCode: EXIT_CODES.conflict,
        file: path,
        hint: "Use the future migration command or choose a separate workspace; do not overwrite legacy state.",
        details: { issues: parsed.error.issues },
      },
    )
  }
  return parsed.data
}

async function createLayoutDirectories(root: string): Promise<void> {
  const layout = workspaceLayout(root)
  await Promise.all([
    mkdir(layout.runs, { recursive: true }),
    mkdir(layout.locks, { recursive: true }),
    mkdir(layout.cache, { recursive: true }),
    mkdir(layout.checkpoints, { recursive: true }),
    mkdir(layout.migrations, { recursive: true }),
  ])
}

function requiredWorkspacePaths(layout: WorkspaceLayout): string[] {
  return [
    layout.config,
    layout.ledger,
    join(layout.migrations, "0001-initial.sql"),
    join(layout.migrations, "0002-orchestration.sql"),
    join(layout.migrations, "0003-execution-hardening.sql"),
    join(layout.migrations, "0004-attempt-effective-options.sql"),
    join(layout.migrations, "0005-model-call-context.sql"),
    join(layout.migrations, "0006-tool-call-journal.sql"),
    join(layout.migrations, "0007-evidence-store.sql"),
    join(layout.migrations, "0008-judge-assessment.sql"),
    join(layout.migrations, "0009-durable-leases.sql"),
    join(layout.migrations, "0010-parallel-git-security.sql"),
    join(layout.migrations, "0011-child-run-links.sql"),
    join(layout.migrations, "0012-run-work-source.sql"),
    join(layout.migrations, "0013-command-evidence-operations.sql"),
    join(layout.migrations, "0014-event-retention-snapshots.sql"),
    join(layout.migrations, "0015-parallel-reserved-attempts.sql"),
    layout.workspaceEvents,
    layout.runs,
    layout.locks,
    layout.cache,
    layout.checkpoints,
  ]
}

async function canForwardMigrateLedger(layout: WorkspaceLayout): Promise<boolean> {
  const previousVersionPaths = [
    layout.config,
    layout.ledger,
    layout.workspaceEvents,
    layout.runs,
    layout.locks,
    layout.cache,
    layout.checkpoints,
    layout.migrations,
    join(layout.migrations, "0001-initial.sql"),
    join(layout.migrations, "0002-orchestration.sql"),
    join(layout.migrations, "0003-execution-hardening.sql"),
    join(layout.migrations, "0004-attempt-effective-options.sql"),
    join(layout.migrations, "0005-model-call-context.sql"),
    join(layout.migrations, "0006-tool-call-journal.sql"),
    join(layout.migrations, "0007-evidence-store.sql"),
    join(layout.migrations, "0008-judge-assessment.sql"),
  ]
  return (await Promise.all(previousVersionPaths.map(pathExists))).every(Boolean)
}

function persistedWorkspacePath(root: string, path: string): string {
  const value = relative(root, path)
  if (!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new RalphError(
      "RALPH_WORKSPACE_PATH_OUTSIDE_ROOT",
      `Refusing to persist a managed path outside the workspace: ${path}`,
      {
        exitCode: EXIT_CODES.policyDenied,
        file: path,
      },
    )
  }
  return value.replaceAll("\\", "/")
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw new RalphError(
      "RALPH_WORKSPACE_INSPECTION_FAILED",
      `Could not inspect managed Ralph path: ${path}`,
      {
        exitCode: EXIT_CODES.policyDenied,
        file: path,
        hint: "Fix filesystem access or inspect the existing state manually before retrying.",
        cause: error,
      },
    )
  }
}

async function assertManagedPathShapes(root: string): Promise<void> {
  const layout = workspaceLayout(root)
  const managed = [
    { path: layout.ralph, kind: "directory" },
    { path: layout.identity, kind: "file" },
    { path: layout.config, kind: "file" },
    { path: layout.workspaceEvents, kind: "file" },
    { path: dirname(layout.ledger), kind: "directory" },
    { path: layout.ledger, kind: "file" },
    { path: layout.migrations, kind: "directory" },
    { path: join(layout.migrations, "0001-initial.sql"), kind: "file" },
    { path: join(layout.migrations, "0002-orchestration.sql"), kind: "file" },
    { path: join(layout.migrations, "0003-execution-hardening.sql"), kind: "file" },
    { path: join(layout.migrations, "0004-attempt-effective-options.sql"), kind: "file" },
    { path: join(layout.migrations, "0005-model-call-context.sql"), kind: "file" },
    { path: join(layout.migrations, "0006-tool-call-journal.sql"), kind: "file" },
    { path: join(layout.migrations, "0007-evidence-store.sql"), kind: "file" },
    { path: join(layout.migrations, "0008-judge-assessment.sql"), kind: "file" },
    { path: join(layout.migrations, "0009-durable-leases.sql"), kind: "file" },
    { path: join(layout.migrations, "0010-parallel-git-security.sql"), kind: "file" },
    { path: join(layout.migrations, "0011-child-run-links.sql"), kind: "file" },
    { path: join(layout.migrations, "0012-run-work-source.sql"), kind: "file" },
    { path: join(layout.migrations, "0013-command-evidence-operations.sql"), kind: "file" },
    { path: join(layout.migrations, "0014-event-retention-snapshots.sql"), kind: "file" },
    { path: join(layout.migrations, "0015-parallel-reserved-attempts.sql"), kind: "file" },
    { path: layout.runs, kind: "directory" },
    { path: layout.locks, kind: "directory" },
    { path: layout.cache, kind: "directory" },
    { path: layout.checkpoints, kind: "directory" },
  ] as const

  for (const item of managed) {
    let info: Stats
    try {
      info = await lstat(item.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new RalphError(
        "RALPH_WORKSPACE_INSPECTION_FAILED",
        `Could not inspect managed Ralph path: ${item.path}`,
        {
          exitCode: EXIT_CODES.policyDenied,
          file: item.path,
          hint: "Fix filesystem access or inspect the existing state manually before retrying.",
          cause: error,
        },
      )
    }
    const validType = item.kind === "directory" ? info.isDirectory() : info.isFile()
    if (info.isSymbolicLink() || !validType) {
      const isRalphRoot = item.path === layout.ralph
      throw new RalphError(
        isRalphRoot ? "RALPH_FOREIGN_STATE_EXISTS" : "RALPH_MANAGED_PATH_UNSAFE",
        `Managed Ralph path is linked or has the wrong type: ${item.path}`,
        {
          exitCode: EXIT_CODES.conflict,
          file: item.path,
          hint: "Replace linked/foreign managed paths with regular v2 files or directories after inspection.",
          details: { expected: item.kind },
        },
      )
    }
  }
}

async function preflightWorkspace(root: string): Promise<void> {
  const layout = workspaceLayout(root)
  if (!(await pathExists(layout.ralph))) return
  await assertManagedPathShapes(root)
  const identityExists = await pathExists(layout.identity)
  if (!identityExists && !(await isDirectoryEmpty(layout.ralph))) {
    throw new RalphError(
      "RALPH_FOREIGN_STATE_EXISTS",
      `Refusing to initialize over an unidentified .ralph directory: ${layout.ralph}`,
      {
        exitCode: EXIT_CODES.conflict,
        file: layout.ralph,
        hint: "Keep legacy state intact and inspect it with `ralph migrate inspect <legacy-workspace>` before choosing a separate v2 destination.",
      },
    )
  }
}

async function acquireInitLock(root: string): Promise<() => Promise<void>> {
  const lockPath = join(root, ".ralph-v2-init.lock")
  const deadline = Date.now() + 10_000
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600)
      try {
        await handle.writeFile(
          `${JSON.stringify({ schemaVersion: 1, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        )
        await handle.sync()
      } catch (error) {
        await handle.close()
        await rm(lockPath, { force: true })
        throw error
      }
      return async () => {
        try {
          await handle.close()
        } finally {
          await rm(lockPath, { force: true })
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (Date.now() >= deadline) {
        throw new RalphError(
          "RALPH_INIT_LOCKED",
          "Another workspace initialization is still active",
          {
            exitCode: EXIT_CODES.blocked,
            file: lockPath,
            hint: "Wait for the other initializer. If it crashed, inspect and remove only this lock file.",
          },
        )
      }
      await Bun.sleep(50)
    }
  }
}

async function initializeWorkspaceLocked(
  requestedRoot: string,
  version: string,
  options: { force?: boolean } = {},
): Promise<InitializeWorkspaceResult> {
  const root = await canonicalDirectory(requestedRoot)
  await assertWorkspaceWritable(root)
  const layout = workspaceLayout(root)
  await preflightWorkspace(root)
  const ralphExists = await pathExists(layout.ralph)
  const identityExists = ralphExists && (await pathExists(layout.identity))

  let created = false
  let repaired = false
  let identity: WorkspaceIdentity
  if (identityExists) {
    identity = await readIdentity(layout.identity)
  } else {
    identity = {
      schema_version: 1,
      product: "ralph-v2",
      workspace_id: crypto.randomUUID(),
      canonical_root: root,
      created_at: new Date().toISOString(),
      created_by_version: version,
    }
    await writeJsonAtomic(layout.identity, identity, { overwrite: false })
    created = true
  }

  const configExists = await Bun.file(layout.config).exists()
  const ledgerExists = await Bun.file(layout.ledger).exists()
  if (identityExists && ledgerExists && (await canForwardMigrateLedger(layout))) {
    await initializeLedger(layout)
  }
  const requiredPaths = requiredWorkspacePaths(layout)
  const missingPaths = identityExists
    ? (
        await Promise.all(
          requiredPaths.map(async (path) => ({ path, exists: await pathExists(path) })),
        )
      )
        .filter((item) => !item.exists)
        .map((item) => item.path)
    : []
  if (missingPaths.length > 0 && !options.force) {
    throw new RalphError(
      "RALPH_WORKSPACE_INCOMPLETE",
      "Ralph v2 workspace is incomplete; refusing to guess missing state",
      {
        exitCode: EXIT_CODES.blocked,
        file: layout.ralph,
        hint: "Inspect the directory, then run `ralph init --force` to recreate only missing v2 files.",
        details: { missingPaths },
      },
    )
  }

  await createLayoutDirectories(root)
  if (missingPaths.length > 0) repaired = true

  if (!configExists) {
    await writeDefaultConfig(layout.config)
    repaired = !created
  } else {
    await readWorkspaceConfig(layout.config)
  }

  await initializeLedger(layout)
  if (!ledgerExists) repaired = !created
  const eventRetention = (await loadEffectiveConfig({ workspaceConfig: layout.config })).config
    .telemetry.event_retention
  snapshotLedgerWorkspaceEventRetention(layout.ledger, eventRetention)

  let events = readEvents(layout.ledger)
  if (events.length === 0 || repaired) {
    const eventType = created ? "workspace.initialized" : "workspace.repaired"
    appendEvent(layout.ledger, {
      type: eventType,
      scope: "workspace",
      streamId: `workspace:${identity.workspace_id}`,
      workspaceId: identity.workspace_id,
      eventRetention,
      payload: {
        created,
        repaired,
        version,
        ...(missingPaths.length > 0
          ? { repairedPaths: missingPaths.map((path) => persistedWorkspacePath(root, path)) }
          : {}),
      },
    })
  }
  await flushOutbox(layout)
  events = readEvents(layout.ledger)
  checkpointLedger(layout.ledger)

  return {
    created,
    repaired,
    root,
    workspaceId: identity.workspace_id,
    config: layout.config,
    ledger: layout.ledger,
    eventCount: events.length,
  }
}

export async function initializeWorkspace(
  requestedRoot: string,
  version: string,
  options: { force?: boolean } = {},
): Promise<InitializeWorkspaceResult> {
  const root = await canonicalDirectory(requestedRoot)
  await assertWorkspaceWritable(root)
  await preflightWorkspace(root)
  const release = await acquireInitLock(root)
  try {
    return await initializeWorkspaceLocked(root, version, options)
  } finally {
    await release()
  }
}

export async function inspectWorkspace(
  requestedStart: string,
  options: { exact?: boolean } = {},
): Promise<WorkspaceStatus> {
  const start = await canonicalDirectory(requestedStart)
  const root = options.exact ? start : ((await findWorkspaceRoot(start)) ?? start)
  const layout = workspaceLayout(root)
  await preflightWorkspace(root)
  if (!(await pathExists(layout.identity))) {
    return {
      initialized: false,
      state: "uninitialized",
      root,
      eventCursor: 0,
      eventCount: 0,
    }
  }

  const identity = await readIdentity(layout.identity)
  if (await canForwardMigrateLedger(layout)) {
    // Existing v2 workspaces are upgraded forward before completeness is
    // assessed. Missing ledgers are still treated as incomplete and are never
    // recreated by this inspection path.
    await initializeLedger(layout)
  }
  const requiredPaths = requiredWorkspacePaths(layout)
  const missingPaths = (
    await Promise.all(requiredPaths.map(async (path) => ({ path, exists: await pathExists(path) })))
  )
    .filter((item) => !item.exists)
    .map((item) => item.path)
  if (missingPaths.length > 0) {
    throw new RalphError("RALPH_WORKSPACE_INCOMPLETE", "Ralph v2 workspace is incomplete", {
      exitCode: EXIT_CODES.blocked,
      file: layout.ralph,
      hint: "Inspect the directory, then run `ralph init --force` to recreate only missing v2 files.",
      details: { missingPaths },
    })
  }
  const config = await readWorkspaceConfig(layout.config)
  const replay = replayWorkspaceEvents(readEvents(layout.ledger))
  return {
    initialized: replay.initialized,
    state: replay.initialized ? "ready" : "invalid",
    root,
    workspaceId: identity.workspace_id,
    workspaceSchemaVersion: identity.schema_version,
    configSchemaVersion: config.schema_version,
    eventCursor: replay.eventCursor,
    eventCount: replay.eventCount,
    moved: resolve(identity.canonical_root) !== resolve(root),
    ...(replay.lastEventType ? { lastEventType: replay.lastEventType } : {}),
  }
}

export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const layout = workspaceLayout(root)
  const output: string[] = []
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative)
      else output.push(relative)
    }
  }
  await walk(layout.ralph, ".ralph")
  return output.sort()
}
