import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import {
  type DurableLeaseRecord,
  EXIT_CODES,
  type LeaseProbeRecord,
  RalphError,
  WorkspaceIdentitySchema,
} from "@ralph-next/domain"
import {
  acquireDurableLease,
  assertDurableLeaseOwned,
  bindDurableLeaseRun,
  flushOutbox,
  type LeaseOwnerIdentity,
  type LeaseOwnerProbeResult,
  releaseDurableLease,
  renewDurableLease,
  type WorkspaceLayout,
  workspaceLayout,
  writeFileAtomic,
} from "@ralph-next/persistence"
import {
  captureCurrentProcessIdentity,
  type ProcessIdentity,
  probePidLiveness,
  probeProcessIdentity,
} from "./process-identity"

const DEFAULT_LEASE_DURATION_MS = 30_000
const DEFAULT_STALE_GRACE_MS = 20_000

export type AcquireExecutionLockOptions = {
  layout: WorkspaceLayout
  workspaceId: string
  runId?: string
  ownerInstanceId?: string
  command?: string
  capabilityScope?: readonly string[]
  leaseDurationMs?: number
  staleGraceMs?: number
  renewalIntervalMs?: number
  processIdentity?: ProcessIdentity
  probeOwner?: (owner: DurableLeaseRecord) => Promise<LeaseOwnerProbeResult>
}

export type ExecutionLock = {
  path: string
  token: string
  release(): Promise<void>
}

export type DurableExecutionLock = ExecutionLock & {
  leaseId: string
  ownerInstanceId: string
  readonly lease: DurableLeaseRecord
  /**
   * Immutable proof that this ownership epoch displaced a stale writer only
   * after its grace period and exact process identity were checked. Consumers
   * may use it to terminalize work that could only have been owned by that
   * dead writer; an ordinary clean acquisition deliberately has no evidence.
   */
  readonly takeover?: {
    replacementLeaseId: string
    displacedLease: DurableLeaseRecord
    probes: readonly LeaseProbeRecord[]
  }
  renew(): Promise<DurableLeaseRecord>
  bindRun(runId: string): Promise<DurableLeaseRecord>
  assertOwned(): DurableLeaseRecord
}

function safeDefaultCommand(): string {
  const executable = basename(process.execPath)
  const entrypoint = process.argv[1] ? basename(process.argv[1]) : "ralph-next"
  const subcommand = process.argv[2]?.startsWith("-") ? undefined : process.argv[2]
  return [executable, entrypoint, subcommand].filter(Boolean).join(" ")
}

async function legacyOptions(
  locksDirectory: string,
  runId?: string,
): Promise<AcquireExecutionLockOptions> {
  const directory = resolve(locksDirectory)
  const ralphDirectory = dirname(directory)
  const root = dirname(ralphDirectory)
  const layout = workspaceLayout(root)
  if (
    basename(directory) !== "locks" ||
    basename(ralphDirectory) !== ".ralph" ||
    resolve(layout.locks) !== directory
  ) {
    throw new RalphError(
      "RALPH_EXECUTION_LOCK_PATH_INVALID",
      "Legacy execution lock path does not resolve to a Ralph workspace",
      { exitCode: EXIT_CODES.policyDenied, file: directory },
    )
  }
  let identity: unknown
  try {
    identity = JSON.parse(await readFile(layout.identity, "utf8"))
  } catch (error) {
    throw new RalphError(
      "RALPH_WORKSPACE_IDENTITY_INVALID",
      "Cannot acquire a durable execution lease without workspace identity",
      { exitCode: EXIT_CODES.conflict, file: layout.identity, cause: error },
    )
  }
  const parsed = WorkspaceIdentitySchema.parse(identity)
  return { layout, workspaceId: parsed.workspace_id, ...(runId ? { runId } : {}) }
}

async function normalizeOptions(
  input: string | AcquireExecutionLockOptions,
  runId?: string,
): Promise<AcquireExecutionLockOptions> {
  return typeof input === "string" ? legacyOptions(input, runId) : input
}

function isManagedWorkspaceLockDirectory(locksDirectory: string): boolean {
  const directory = resolve(locksDirectory)
  return basename(directory) === "locks" && basename(dirname(directory)) === ".ralph"
}

async function acquireCompatibilityFileLock(
  locksDirectory: string,
  runId?: string,
): Promise<ExecutionLock> {
  const directory = resolve(locksDirectory)
  await mkdir(directory, { recursive: true })
  const path = resolve(directory, "execution.lock")
  if (dirname(path) !== directory || basename(path) !== "execution.lock") {
    throw new RalphError("RALPH_EXECUTION_LOCK_PATH_INVALID", "Execution lock path is invalid", {
      exitCode: EXIT_CODES.policyDenied,
      file: path,
    })
  }
  const token = randomUUID()
  const content = `${JSON.stringify({
    schemaVersion: 1,
    token,
    pid: process.pid,
    runId: runId ?? null,
    createdAt: new Date().toISOString(),
  })}\n`
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, "wx", 0o600)
    await handle.writeFile(content, "utf8")
    await handle.sync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const owner = await readFile(path, "utf8").catch(() => "unreadable")
      throw new RalphError(
        "RALPH_EXECUTION_ALREADY_ACTIVE",
        "Another Ralph execution owns this workspace lock",
        {
          exitCode: EXIT_CODES.conflict,
          file: path,
          details: { owner: owner.trim() },
          hint: "S03 compatibility never steals an execution lock heuristically; managed v2 workspaces use durable ledger leases.",
        },
      )
    }
    throw error
  }

  let released = false
  return {
    path,
    token,
    async release(): Promise<void> {
      if (released) return
      released = true
      await handle.close()
      const current = await readFile(path, "utf8").catch(() => undefined)
      if (current === content) await rm(path, { force: true })
    },
  }
}

function mirrorContent(token: string, lease: DurableLeaseRecord): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    authority: "ledger-lease",
    token,
    leaseId: lease.id,
    workspaceId: lease.workspaceId,
    runId: lease.runId ?? null,
    ownerInstanceId: lease.ownerInstanceId,
    pid: lease.pid,
    processStartToken: lease.processStartToken,
    hostname: lease.hostname,
    renewedAt: lease.renewedAt,
    expiresAt: lease.expiresAt,
    graceExpiresAt: lease.graceExpiresAt,
  })}\n`
}

async function removeOwnedMirror(path: string, token: string, leaseId: string): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => undefined)
  if (!current) return
  try {
    const parsed = JSON.parse(current) as { token?: unknown; leaseId?: unknown }
    if (parsed.token === token && parsed.leaseId === leaseId) await rm(path, { force: true })
  } catch {
    // A malformed or concurrently replaced diagnostic mirror is never deleted heuristically.
  }
}

async function writeInitialMirror(path: string, content: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600)
      try {
        await handle.writeFile(content, "utf8")
        await handle.sync()
      } finally {
        await handle.close()
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }

    let info: Awaited<ReturnType<typeof lstat>>
    let existing: string
    try {
      info = await lstat(path)
      existing = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new RalphError(
        "RALPH_EXECUTION_LOCK_PATH_UNSAFE",
        "Execution lock mirror is linked or is not a regular file",
        { exitCode: EXIT_CODES.policyDenied, file: path },
      )
    }

    let parsed: {
      schemaVersion?: unknown
      authority?: unknown
      pid?: unknown
      runId?: unknown
      createdAt?: unknown
    }
    try {
      parsed = JSON.parse(existing) as typeof parsed
    } catch (error) {
      throw new RalphError(
        "RALPH_EXECUTION_LOCK_MIRROR_INVALID",
        "Existing execution lock mirror is malformed",
        {
          exitCode: EXIT_CODES.conflict,
          file: path,
          hint: "Inspect the file manually; Ralph will not overwrite an unidentified lock artifact.",
          cause: error,
        },
      )
    }

    if (parsed.schemaVersion === 1 && typeof parsed.pid === "number") {
      const liveness = probePidLiveness(parsed.pid)
      if (liveness.alive || liveness.inaccessible) {
        throw new RalphError(
          "RALPH_LEGACY_EXECUTION_LOCK_ACTIVE",
          "A legacy Ralph process may still own the workspace",
          {
            exitCode: EXIT_CODES.conflict,
            file: path,
            details: {
              pid: parsed.pid,
              runId: parsed.runId,
              createdAt: parsed.createdAt,
              processIdentityVerifiable: false,
            },
            hint: "Stop the legacy process cleanly before upgrading to durable ledger leases.",
          },
        )
      }
      await writeFileAtomic(path, content, { overwrite: true })
      return
    }
    if (parsed.schemaVersion === 2 && parsed.authority === "ledger-lease") {
      await writeFileAtomic(path, content, { overwrite: true })
      return
    }
    throw new RalphError(
      "RALPH_EXECUTION_LOCK_MIRROR_INVALID",
      "Existing execution lock mirror has an unknown format",
      {
        exitCode: EXIT_CODES.conflict,
        file: path,
        hint: "Inspect the file manually; only a verified ledger lease may replace it.",
      },
    )
  }
  throw new RalphError(
    "RALPH_EXECUTION_LOCK_MIRROR_RACE",
    "Execution lock mirror changed repeatedly during acquisition",
    { exitCode: EXIT_CODES.conflict, file: path },
  )
}

export function acquireExecutionLock(
  options: AcquireExecutionLockOptions,
): Promise<DurableExecutionLock>
export function acquireExecutionLock(locksDirectory: string, runId?: string): Promise<ExecutionLock>
export async function acquireExecutionLock(
  input: string | AcquireExecutionLockOptions,
  legacyRunId?: string,
): Promise<ExecutionLock | DurableExecutionLock> {
  if (typeof input === "string" && !isManagedWorkspaceLockDirectory(input)) {
    return acquireCompatibilityFileLock(input, legacyRunId)
  }
  const options = await normalizeOptions(input, legacyRunId)
  const directory = resolve(options.layout.locks)
  const path = resolve(directory, "execution.lock")
  if (dirname(path) !== directory || basename(path) !== "execution.lock") {
    throw new RalphError("RALPH_EXECUTION_LOCK_PATH_INVALID", "Execution lock path is invalid", {
      exitCode: EXIT_CODES.policyDenied,
      file: path,
    })
  }

  const processIdentity = options.processIdentity ?? (await captureCurrentProcessIdentity())
  const ownerInstanceId = options.ownerInstanceId ?? randomUUID()
  const owner: LeaseOwnerIdentity = { ownerInstanceId, ...processIdentity }
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS
  const staleGraceMs = options.staleGraceMs ?? DEFAULT_STALE_GRACE_MS
  const renewalIntervalMs =
    options.renewalIntervalMs ?? Math.max(1_000, Math.floor(leaseDurationMs / 3))
  if (
    !Number.isSafeInteger(renewalIntervalMs) ||
    renewalIntervalMs < 250 ||
    renewalIntervalMs >= leaseDurationMs
  ) {
    throw new RalphError(
      "RALPH_LEASE_INPUT_INVALID",
      "Execution lease renewal interval must be shorter than its duration",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: { renewalIntervalMs, leaseDurationMs },
      },
    )
  }

  const acquired = await acquireDurableLease(
    options.layout.ledger,
    {
      kind: "workspace-supervisor",
      resourceKey: "workspace-writer",
      workspaceId: options.workspaceId,
      ...(options.runId ? { runId: options.runId } : {}),
      ...owner,
      command: options.command ?? safeDefaultCommand(),
      scope: options.capabilityScope ?? ["run:supervise", "workspace:write"],
      leaseDurationMs,
      staleGraceMs,
      staleProbeConfirmations: 2,
      staleProbeIntervalMs: 250,
    },
    { probeOwner: options.probeOwner ?? probeProcessIdentity },
  )
  const takeover = acquired.displacedLease
    ? {
        replacementLeaseId: acquired.lease.id,
        displacedLease: acquired.displacedLease,
        probes: acquired.probes,
      }
    : undefined

  const token = randomUUID()
  let currentLease = acquired.lease
  try {
    await writeInitialMirror(path, mirrorContent(token, currentLease))
  } catch (error) {
    releaseDurableLease(options.layout.ledger, currentLease.id, owner)
    throw error
  }

  let released = false
  let renewalFailure: unknown
  let renewalInFlight: Promise<void> | undefined
  let timer: NodeJS.Timeout | undefined
  const renewOnce = (): Promise<void> => {
    if (released) return Promise.resolve()
    if (renewalInFlight) return renewalInFlight
    const operation = (async () => {
      currentLease = renewDurableLease(
        options.layout.ledger,
        currentLease.id,
        owner,
        leaseDurationMs,
        staleGraceMs,
      )
      await writeFileAtomic(path, mirrorContent(token, currentLease), { overwrite: true })
    })()
    renewalInFlight = operation
    void operation
      .catch((error) => {
        renewalFailure = error
        if (timer) clearInterval(timer)
      })
      .finally(() => {
        if (renewalInFlight === operation) renewalInFlight = undefined
      })
    return operation
  }
  timer = setInterval(() => {
    void renewOnce().catch(() => undefined)
  }, renewalIntervalMs)
  timer.unref()

  return {
    path,
    token,
    leaseId: currentLease.id,
    ownerInstanceId,
    get lease(): DurableLeaseRecord {
      return currentLease
    },
    ...(takeover ? { takeover } : {}),
    async renew(): Promise<DurableLeaseRecord> {
      if (renewalFailure) throw renewalFailure
      await renewOnce()
      if (renewalFailure) throw renewalFailure
      return currentLease
    },
    async bindRun(runId: string): Promise<DurableLeaseRecord> {
      if (renewalFailure) throw renewalFailure
      if (renewalInFlight) await renewalInFlight
      currentLease = assertDurableLeaseOwned(options.layout.ledger, currentLease.id, owner)
      currentLease = bindDurableLeaseRun(options.layout.ledger, currentLease.id, owner, runId)
      await writeFileAtomic(path, mirrorContent(token, currentLease), { overwrite: true })
      return currentLease
    },
    assertOwned(): DurableLeaseRecord {
      if (renewalFailure) throw renewalFailure
      currentLease = assertDurableLeaseOwned(options.layout.ledger, currentLease.id, owner)
      return currentLease
    },
    async release(): Promise<void> {
      if (released) return
      released = true
      if (timer) clearInterval(timer)
      if (renewalInFlight) await renewalInFlight.catch(() => undefined)
      currentLease = releaseDurableLease(options.layout.ledger, currentLease.id, owner)
      await flushOutbox(options.layout)
      await removeOwnedMirror(path, token, currentLease.id)
    },
  }
}
