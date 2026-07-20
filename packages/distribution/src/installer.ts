import { createHash, randomUUID } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import { buildCurrentInstallPointer, serializeDistributionControlFile } from "./activation"
import {
  type CurrentInstallPointer,
  CurrentInstallPointerSchema,
  type DeferredUninstallRequest,
  DeferredUninstallRequestSchema,
  type DistributionLockOwner,
  DistributionLockOwnerSchema,
  type DistributionOperation,
  DistributionOperationSchema,
  type InstalledVersion,
  InstalledVersionSchema,
  type InstallOrigin,
  InstallOriginSchema,
  type InstallReceipt,
  InstallReceiptSchema,
  LauncherBuildMetadataSchema,
  PortableRelativePathSchema,
  type RalphAliasReceipt,
  RalphAliasReceiptSchema,
  type ReleaseArtifact,
  ReleaseBuildMetadataSchema,
  type ReleaseChannel,
  type ReleaseManifest,
  type ReleasePayload,
  ReleaseSbomSchema,
  type ReleaseSignatureKind,
  type ReleaseSignatureTrustPolicy,
  ReleaseSignatureTrustPolicySchema,
  type ReleaseTarget,
  releasePathCollisionKey,
  releaseSupportPolicySha256,
} from "./contracts"
import {
  type LoadedReleaseManifest,
  loadReleaseManifest,
  type ReleaseTransport,
  type StagedReleasePayload,
  stageDetachedSignaturePayload,
  stageReleasePayload,
} from "./loader"
import { releaseTargetFor, selectReleaseArtifact } from "./manifest"
import {
  assertManagedInstallPath,
  resolveStandaloneInstallLayout,
  type StandaloneInstallLayout,
  validateInstallReceiptPaths,
  versionDirectory,
} from "./paths"
import { assertReleasePromotionBinding } from "./promotion"
import { canonicalReleaseManifestSigningBytes, releaseManifestSigningSha256 } from "./signature"

const CONTROL_FILE_LIMIT_BYTES = 4 * 1024 * 1024
const CURRENT_WORKSPACE_SCHEMA = 1
const CURRENT_LAUNCHER_SCHEMA = 1
const OPERATION_DIRECTORY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const RALPH_ALIAS_RECEIPT_NAME = "alias-ralph-v1.json"
const RALPH_ALIAS_BINARY_LIMIT_BYTES = 512 * 1024 * 1024

export interface ReleaseSignatureVerificationRequest {
  readonly kind: ReleaseSignatureKind
  readonly claimedIdentity: string
  readonly trustPolicy: ReleaseSignatureTrustPolicy
  readonly canonicalManifestBytes: Uint8Array
  readonly signedManifestSha256: string
  readonly signaturePath: string
  readonly signatureSizeBytes: number
  readonly signatureSha256: string
  readonly signatureMaximumSizeBytes: number
  readonly signatureMediaType: string
  readonly signal?: AbortSignal
}

export interface ReleaseSignatureVerificationResult {
  readonly kind: ReleaseSignatureKind
  readonly identity: string
  readonly issuer?: string
  readonly signedManifestSha256: string
  readonly signatureSha256: string
}

export interface ReleaseSignatureVerifier {
  verify(request: ReleaseSignatureVerificationRequest): Promise<ReleaseSignatureVerificationResult>
}

export type DistributionFaultPoint = "planned" | "staged" | "verified" | "activated"

export interface DistributionFaultContext {
  readonly point: DistributionFaultPoint
  readonly operationId: string
  readonly action: DistributionOperation["action"]
  readonly status: DistributionOperation["status"]
  readonly installRoot: string
}

export interface DistributionRuntimeOptions {
  readonly signal?: AbortSignal
  readonly transport?: ReleaseTransport
  readonly signatureVerifier?: ReleaseSignatureVerifier
  readonly signatureTrustPolicy?: ReleaseSignatureTrustPolicy
  readonly now?: () => Date
  readonly platform?: NodeJS.Platform
  readonly architecture?: string
  /**
   * Deterministic crash-injection seam for install/update recovery drills.
   * Throwing from this callback models process loss after the named journal
   * boundary, so normal in-process cleanup is deliberately skipped.
   */
  readonly fault?: (context: DistributionFaultContext) => void | Promise<void>
}

export interface StandaloneInstallRequest extends DistributionRuntimeOptions {
  readonly installRoot: string
  readonly origin: InstallOrigin
  readonly expectedChannel?: ReleaseChannel
  readonly expectedVersion?: string
  readonly workspaceSchema?: number
  readonly dryRun?: boolean
}

export interface StandaloneUpdateRequest extends DistributionRuntimeOptions {
  readonly installRoot: string
  readonly origin?: InstallOrigin
  readonly expectedChannel?: ReleaseChannel
  readonly expectedVersion?: string
  readonly workspaceSchema?: number
  readonly allowDowngrade?: boolean
  readonly checkOnly?: boolean
  readonly dryRun?: boolean
}

export interface StandaloneRollbackRequest extends DistributionRuntimeOptions {
  readonly installRoot: string
  readonly version?: string
  readonly workspaceSchema?: number
  readonly dryRun?: boolean
}

export interface StandaloneUninstallRequest extends DistributionRuntimeOptions {
  readonly installRoot: string
  readonly dryRun?: boolean
  /** Required for mutation: cleanup must execute outside the running launcher/engine. */
  readonly deferredCleanup?: DeferredUninstallScheduler
  /** Foreground engine plus launcher/supervisor PIDs that must exit before cleanup. */
  readonly waitForPids?: readonly number[]
}

export interface DeferredUninstallScheduleResult {
  readonly helperPath: string
  readonly requestPath: string
}

export interface DeferredUninstallScheduler {
  schedule(request: DeferredUninstallRequest): Promise<DeferredUninstallScheduleResult>
}

export interface DistributionPlan {
  readonly action: "install" | "update" | "rollback" | "uninstall"
  readonly installRoot: string
  readonly currentVersion?: string
  readonly requestedVersion?: string
  readonly target?: ReleaseTarget
  readonly channel?: ReleaseChannel
  readonly origin?: InstallOrigin
  readonly mutationPerformed: false
  readonly runningBinaryReplaced: false
  readonly launcherMutation: "install" | "preserve" | "none"
}

export interface DistributionMutationResult {
  readonly action: "install" | "update" | "rollback" | "uninstall"
  readonly operationId: string
  readonly installRoot: string
  readonly previousVersion?: string
  readonly currentVersion?: string
  readonly target?: ReleaseTarget
  readonly channel?: ReleaseChannel
  readonly receiptPath?: string
  readonly pointerPath?: string
  readonly launcherPath?: string
  readonly mutationPerformed: true
  readonly runningBinaryReplaced: false
  readonly launcherMutation: "install" | "preserve" | "none"
  readonly preserved: readonly ["workspace-state", "global-config", "credentials"]
  readonly cleanupDisposition?: "scheduled" | "completed"
  readonly cleanupHelperPath?: string
  readonly cleanupRequestPath?: string
}

export type RalphAliasState =
  | "absent"
  | "installed"
  | "stale"
  | "install-recovery-required"
  | "remove-recovery-required"

export interface RalphAliasStatus {
  readonly action: "alias-status"
  readonly alias: "ralph"
  readonly state: RalphAliasState
  readonly installRoot: string
  readonly installId: string
  readonly currentVersion: string
  readonly channel: ReleaseChannel
  readonly activationEligible: boolean
  readonly sourceGeneration: number
  readonly currentReceiptSha256: string
  readonly launcherPath: string
  readonly launcherSha256: string
  readonly aliasPath: string
  readonly aliasReceiptPath: string
  readonly aliasRemovalQuarantinePath: string
  readonly aliasReceiptRemovalQuarantinePath: string
  readonly pendingAliasControlReceiptPath: string
  readonly pendingAliasControlReceiptQuarantinePath: string
  readonly aliasSha256?: string
  readonly aliasReceiptSha256?: string
  readonly aliasRemovalQuarantineSha256?: string
  readonly aliasReceiptRemovalQuarantineSha256?: string
  readonly pendingAliasControlReceiptSha256?: string
  readonly pendingAliasControlReceiptQuarantineSha256?: string
  readonly mutationPerformed: false
  readonly runningBinaryReplaced: false
}

export interface RalphAliasPlan extends Omit<RalphAliasStatus, "action"> {
  readonly action: "alias-install" | "alias-remove"
  readonly planHash: string
}

export interface RalphAliasMutationResult {
  readonly action: "alias-install" | "alias-remove"
  readonly operationId: string
  readonly alias: "ralph"
  readonly state: "installed" | "absent"
  readonly installRoot: string
  readonly installId: string
  readonly currentVersion: string
  readonly channel: ReleaseChannel
  readonly previousGeneration: number
  readonly currentGeneration: number
  readonly aliasPath: string
  readonly aliasReceiptPath: string
  readonly planHash: string
  readonly mutationPerformed: true
  readonly runningBinaryReplaced: false
}

export interface RalphAliasMutationRequest extends DistributionRuntimeOptions {
  readonly installRoot: string
  readonly confirmationPlanHash?: string
  readonly dryRun?: boolean
}

export interface UpdateCheckResult extends DistributionPlan {
  readonly action: "update"
  readonly available: boolean
  readonly evidenceStatus: ReleaseArtifact["evidenceStatus"]
  readonly evidenceTrust: "signature-verified" | "declared-unverified"
  readonly authenticity: "signature-verified" | "unsigned-integrity-verified"
  readonly limitations: readonly string[]
}

function distributionError(
  code: string,
  message: string,
  options: {
    exitCode?: (typeof EXIT_CODES)[keyof typeof EXIT_CODES]
    file?: string
    hint?: string
    cause?: unknown
    details?: Record<string, unknown>
  } = {},
): RalphError {
  return new RalphError(code, message, {
    exitCode: options.exitCode ?? EXIT_CODES.operationalError,
    ...(options.file ? { file: options.file } : {}),
    ...(options.hint ? { hint: options.hint } : {}),
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
    ...(options.details ? { details: options.details } : {}),
  })
}

class DistributionFaultInterruption extends Error {
  readonly point: DistributionFaultPoint

  constructor(point: DistributionFaultPoint, cause: unknown) {
    super(`Injected distribution interruption after ${point}`, { cause })
    this.name = "DistributionFaultInterruption"
    this.point = point
  }
}

async function injectDistributionFault(
  options: DistributionRuntimeOptions,
  operation: DistributionOperation,
  point: DistributionFaultPoint,
): Promise<void> {
  if (!options.fault) return
  try {
    await options.fault({
      point,
      operationId: operation.operationId,
      action: operation.action,
      status: operation.status,
      installRoot: operation.installRoot,
    })
  } catch (error) {
    throw new DistributionFaultInterruption(point, error)
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function pathInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate)
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function canonicalLayout(
  requestedRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<StandaloneInstallLayout> {
  const lexical = resolveStandaloneInstallLayout(requestedRoot, platform)
  let existing = lexical.root
  const suffix: string[] = []
  while (!(await optionalLstat(existing))) {
    const parent = dirname(existing)
    if (parent === existing) {
      throw distributionError(
        "RALPH_INSTALL_ROOT_ANCESTOR_UNAVAILABLE",
        `No existing ancestor was found for install root: ${lexical.root}`,
        { exitCode: EXIT_CODES.invalidUsage, file: lexical.root },
      )
    }
    suffix.unshift(basename(existing))
    existing = parent
  }
  const existingInformation = await lstat(existing)
  if (existingInformation.isSymbolicLink() || !existingInformation.isDirectory()) {
    throw distributionError(
      "RALPH_INSTALL_ROOT_ANCESTOR_INVALID",
      `Install root ancestor must be a regular directory: ${existing}`,
      { exitCode: EXIT_CODES.policyDenied, file: existing },
    )
  }
  const canonicalAncestor = await realpath(existing)
  const canonicalRoot = resolve(canonicalAncestor, ...suffix)
  return resolveStandaloneInstallLayout(canonicalRoot, platform)
}

type InstallLockAction = DistributionLockOwner["action"]

interface HeldInstallLock {
  readonly path: string
  readonly owner: DistributionLockOwner
  readonly handle: Awaited<ReturnType<typeof open>>
}

async function installLockPath(layout: StandaloneInstallLayout): Promise<string> {
  let directory = dirname(layout.root)
  while (!(await optionalLstat(directory))) {
    const parent = dirname(directory)
    if (parent === directory) {
      throw distributionError(
        "RALPH_INSTALL_LOCK_DIRECTORY_UNAVAILABLE",
        `No existing directory can host the install lock for ${layout.root}`,
        { exitCode: EXIT_CODES.invalidUsage, file: layout.root },
      )
    }
    directory = parent
  }
  await assertDirectory(directory)
  const rootKey = createHash("sha256").update(layout.root).digest("hex").slice(0, 32)
  return join(directory, `.ralph-next-install-${rootKey}.lock`)
}

function processLiveness(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return "dead"
    }
    return "unknown"
  }
}

async function readLockOwner(path: string): Promise<DistributionLockOwner> {
  const parsed = DistributionLockOwnerSchema.safeParse(await readJson(path))
  if (!parsed.success) {
    throw distributionError(
      "RALPH_INSTALL_LOCK_INVALID",
      `Install lock metadata is invalid and cannot be reclaimed automatically: ${path}`,
      {
        exitCode: EXIT_CODES.conflict,
        file: path,
        details: { issues: parsed.error.issues },
      },
    )
  }
  return parsed.data
}

async function acquireInstallLock(
  layout: StandaloneInstallLayout,
  action: InstallLockAction,
  options: DistributionRuntimeOptions,
): Promise<HeldInstallLock> {
  const path = await installLockPath(layout)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = DistributionLockOwnerSchema.parse({
      schemaVersion: 1,
      ownerToken: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      action,
      installRoot: layout.root,
      processStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
      acquiredAt: timestamp(options),
    })
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(path, "wx+", 0o600)
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")
      ) {
        throw distributionError(
          "RALPH_INSTALL_LOCK_ACQUIRE_FAILED",
          `Could not create the exclusive install lock: ${path}`,
          { exitCode: EXIT_CODES.conflict, file: path, cause: error },
        )
      }
      const observed = await readLockOwner(path)
      if (resolve(observed.installRoot) !== layout.root) {
        throw distributionError(
          "RALPH_INSTALL_LOCK_ROOT_MISMATCH",
          `Install lock hash collision or replacement detected: ${path}`,
          { exitCode: EXIT_CODES.conflict, file: path },
        )
      }
      const liveness = processLiveness(observed.pid)
      if (liveness !== "dead") {
        throw distributionError(
          "RALPH_INSTALL_LOCK_HELD",
          `Install root is owned by another ${observed.action} operation (PID ${observed.pid})`,
          {
            exitCode: EXIT_CODES.conflict,
            file: path,
            hint: "Wait for the owner to finish. Age alone never authorizes reclaiming this lock.",
            details: { owner: observed, liveness },
          },
        )
      }
      const confirmed = await readLockOwner(path)
      if (confirmed.ownerToken !== observed.ownerToken) {
        throw distributionError(
          "RALPH_INSTALL_LOCK_CHANGED",
          "Install lock ownership changed while stale-owner recovery was being evaluated",
          { exitCode: EXIT_CODES.conflict, file: path },
        )
      }
      await unlink(path)
      continue
    }
    try {
      await writeAll(handle, new TextEncoder().encode(serializeDistributionControlFile(owner)))
      await handle.sync()
      return { path, owner, handle }
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(path).catch(() => undefined)
      throw error
    }
  }
  throw distributionError(
    "RALPH_INSTALL_LOCK_RETRY_EXHAUSTED",
    `Install lock could not be acquired after reclaiming a proven-dead owner: ${path}`,
    { exitCode: EXIT_CODES.conflict, file: path },
  )
}

async function releaseInstallLock(lock: HeldInstallLock): Promise<void> {
  const observed = await readLockOwner(lock.path)
  if (observed.ownerToken !== lock.owner.ownerToken) {
    await lock.handle.close().catch(() => undefined)
    throw distributionError(
      "RALPH_INSTALL_LOCK_OWNERSHIP_LOST",
      "Install lock was replaced; refusing compare-and-delete release",
      { exitCode: EXIT_CODES.conflict, file: lock.path },
    )
  }
  await lock.handle.close()
  const confirmed = await readLockOwner(lock.path)
  if (confirmed.ownerToken !== lock.owner.ownerToken) {
    throw distributionError(
      "RALPH_INSTALL_LOCK_OWNERSHIP_LOST",
      "Install lock changed after handle close; refusing deletion",
      { exitCode: EXIT_CODES.conflict, file: lock.path },
    )
  }
  await unlink(lock.path)
}

async function withInstallLock<T>(
  layout: StandaloneInstallLayout,
  action: InstallLockAction,
  options: DistributionRuntimeOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireInstallLock(layout, action, options)
  try {
    return await operation()
  } finally {
    await releaseInstallLock(lock)
  }
}

async function assertDirectory(path: string): Promise<void> {
  const information = await lstat(path).catch((error: unknown) => {
    throw distributionError(
      "RALPH_INSTALL_DIRECTORY_UNAVAILABLE",
      `Managed install directory is unavailable: ${path}`,
      { file: path, cause: error },
    )
  })
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw distributionError(
      "RALPH_INSTALL_DIRECTORY_INVALID",
      `Managed install path must be a regular directory: ${path}`,
      { exitCode: EXIT_CODES.policyDenied, file: path },
    )
  }
}

async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await assertDirectory(path)
}

async function assertNoProjectCollision(root: string): Promise<void> {
  let cursor = root
  while (true) {
    const workspaceIdentity = join(cursor, ".ralph", "workspace.json")
    const gitBoundary = join(cursor, ".git")
    if (await optionalLstat(workspaceIdentity)) {
      throw distributionError(
        "RALPH_INSTALL_ROOT_IS_WORKSPACE",
        `Install root cannot be inside a Ralph workspace: ${root}`,
        {
          exitCode: EXIT_CODES.policyDenied,
          file: root,
          hint: "Choose a separate empty directory dedicated to the standalone installation.",
        },
      )
    }
    if (await optionalLstat(gitBoundary)) {
      throw distributionError(
        "RALPH_INSTALL_ROOT_IS_CHECKOUT",
        `Install root cannot be inside a source checkout: ${root}`,
        {
          exitCode: EXIT_CODES.policyDenied,
          file: root,
          hint: "Choose a separate empty directory dedicated to the standalone installation.",
        },
      )
    }
    const parent = dirname(cursor)
    if (parent === cursor) return
    cursor = parent
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (written.bytesWritten <= 0) {
      throw distributionError(
        "RALPH_INSTALL_WRITE_INCOMPLETE",
        "Distribution control file write made no progress",
      )
    }
    offset += written.bytesWritten
  }
}

function installDurability(
  platform: NodeJS.Platform = process.platform,
): InstallReceipt["durability"] {
  return platform === "win32"
    ? {
        fileSync: "fsync-before-rename",
        directorySync: "unsupported-file-sync-only",
        guarantee: "reduced",
      }
    : {
        fileSync: "fsync-before-rename",
        directorySync: "fsync-after-rename",
        guarantee: "full",
      }
}

function sameInstallDurability(
  left: InstallReceipt["durability"],
  right: InstallReceipt["durability"],
): boolean {
  return (
    left.fileSync === right.fileSync &&
    left.directorySync === right.directorySync &&
    left.guarantee === right.guarantee
  )
}

async function syncDirectoryAfterRename(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") return
  const resolved = resolve(directory)
  const handle = await open(resolved, "r").catch((error: unknown) => {
    throw distributionError(
      "RALPH_INSTALL_DIRECTORY_SYNC_OPEN_FAILED",
      `Could not open renamed entry parent for durability sync: ${resolved}`,
      { exitCode: EXIT_CODES.blocked, file: resolved, cause: error },
    )
  })
  try {
    await handle.sync()
  } catch (error) {
    throw distributionError(
      "RALPH_INSTALL_DIRECTORY_SYNC_FAILED",
      `Could not durably sync renamed entry parent: ${resolved}`,
      { exitCode: EXIT_CODES.blocked, file: resolved, cause: error },
    )
  } finally {
    await handle.close()
  }
}

async function syncRenameParents(
  source: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const parents = new Set([resolve(dirname(source)), resolve(dirname(destination))])
  for (const parent of parents) await syncDirectoryAfterRename(parent, platform)
}

async function writeBytesAtomic(path: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
  const target = resolve(path)
  await ensureDirectory(dirname(target))
  const existing = await optionalLstat(target)
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw distributionError(
      "RALPH_INSTALL_CONTROL_PATH_INVALID",
      `Distribution control target is not a regular file: ${target}`,
      { exitCode: EXIT_CODES.policyDenied, file: target },
    )
  }
  const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, "wx", mode)
  try {
    await writeAll(handle, bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, target)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw distributionError(
      "RALPH_INSTALL_ATOMIC_REPLACE_FAILED",
      `Atomic replacement failed without deleting the previous file: ${target}`,
      { file: target, cause: error },
    )
  }
  await syncDirectoryAfterRename(dirname(target))
}

/**
 * Creates an ownership-bearing file without replacing any pre-existing path.
 * A crash can leave an incomplete file, but that state is intentionally
 * fail-closed and is never reclassified as Ralph-owned without a valid receipt.
 */
async function writeBytesExclusive(
  path: string,
  bytes: Uint8Array,
  mode = 0o600,
  finalMode?: number,
): Promise<void> {
  const target = resolve(path)
  await ensureDirectory(dirname(target))
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(target, "wx", mode)
  } catch (error) {
    throw distributionError(
      "RALPH_INSTALL_EXCLUSIVE_PATH_COLLISION",
      `Refusing to replace an existing ownership-bearing path: ${target}`,
      { exitCode: EXIT_CODES.conflict, file: target, cause: error },
    )
  }
  try {
    await writeAll(handle, bytes)
    if (finalMode !== undefined) {
      const information = await handle.stat()
      if (!information.isFile() || information.nlink !== 1) {
        throw distributionError(
          "RALPH_INSTALL_EXCLUSIVE_LINK_COUNT_INVALID",
          "Refusing to make an ownership-bearing path executable after its file identity gained another hard link",
          {
            exitCode: EXIT_CODES.conflict,
            file: target,
            details: { observedLinkCount: information.nlink },
          },
        )
      }
      await handle.chmod(finalMode)
      const finalized = await handle.stat()
      if (finalized.nlink !== 1) {
        throw distributionError(
          "RALPH_INSTALL_EXCLUSIVE_LINK_COUNT_CHANGED",
          "Ownership-bearing path link count changed while executable permissions were finalized",
          {
            exitCode: EXIT_CODES.conflict,
            file: target,
            details: { observedLinkCount: finalized.nlink },
          },
        )
      }
    }
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw distributionError(
      "RALPH_INSTALL_EXCLUSIVE_WRITE_FAILED",
      `Could not durably create ownership-bearing path: ${target}`,
      {
        exitCode: EXIT_CODES.blocked,
        file: target,
        hint: "Inspect the partial file before removing it; Ralph will not overwrite it automatically.",
        cause: error,
      },
    )
  }
  await handle.close()
  await syncDirectoryAfterRename(dirname(target))
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeBytesAtomic(path, new TextEncoder().encode(serializeDistributionControlFile(value)))
}

async function readRegularBytes(
  path: string,
  maximumBytes = CONTROL_FILE_LIMIT_BYTES,
): Promise<Uint8Array> {
  const resolved = resolve(path)
  const information = await lstat(resolved).catch((error: unknown) => {
    throw distributionError(
      "RALPH_INSTALL_FILE_UNAVAILABLE",
      `Distribution file is unavailable: ${resolved}`,
      { file: resolved, cause: error },
    )
  })
  if (information.isSymbolicLink() || !information.isFile()) {
    throw distributionError(
      "RALPH_INSTALL_FILE_NOT_REGULAR",
      `Distribution file must be regular: ${resolved}`,
      { exitCode: EXIT_CODES.policyDenied, file: resolved },
    )
  }
  if (information.size <= 0 || information.size > maximumBytes) {
    throw distributionError(
      "RALPH_INSTALL_FILE_SIZE_INVALID",
      `Distribution file has an invalid size: ${resolved}`,
      { file: resolved, details: { sizeBytes: information.size, maximumBytes } },
    )
  }
  return new Uint8Array(await readFile(resolved))
}

async function readJson(path: string): Promise<unknown> {
  const bytes = await readRegularBytes(path)
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw distributionError(
      "RALPH_INSTALL_CONTROL_JSON_INVALID",
      `Distribution control file is invalid JSON: ${resolve(path)}`,
      { file: resolve(path), cause: error },
    )
  }
}

async function fileSha256(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const information = await lstat(path).catch((error: unknown) => {
    throw distributionError(
      "RALPH_INSTALL_FILE_UNAVAILABLE",
      `Installed file is unavailable: ${path}`,
      {
        file: path,
        cause: error,
      },
    )
  })
  if (!information.isFile() || information.isSymbolicLink()) {
    throw distributionError(
      "RALPH_INSTALL_FILE_NOT_REGULAR",
      `Installed path must be a regular file: ${path}`,
      { exitCode: EXIT_CODES.policyDenied, file: path },
    )
  }
  const hash = createHash("sha256")
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let position = 0
    while (true) {
      const read = await handle.read(buffer, 0, buffer.byteLength, position)
      if (read.bytesRead === 0) break
      hash.update(buffer.subarray(0, read.bytesRead))
      position += read.bytesRead
    }
  } finally {
    await handle.close()
  }
  return { sha256: hash.digest("hex"), sizeBytes: information.size }
}

async function verifyFile(
  path: string,
  expectedSha256: string,
  expectedSize?: number,
): Promise<void> {
  const actual = await fileSha256(path)
  if (
    actual.sha256 !== expectedSha256.toLowerCase() ||
    (expectedSize !== undefined && actual.sizeBytes !== expectedSize)
  ) {
    throw distributionError(
      "RALPH_INSTALL_FILE_TAMPERED",
      `Installed file does not match its receipt: ${path}`,
      {
        exitCode: EXIT_CODES.conflict,
        file: path,
        details: {
          expectedSha256,
          actualSha256: actual.sha256,
          ...(expectedSize !== undefined ? { expectedSize, actualSize: actual.sizeBytes } : {}),
        },
      },
    )
  }
}

async function readPointer(layout: StandaloneInstallLayout) {
  const parsed = CurrentInstallPointerSchema.safeParse(await readJson(layout.currentPointer))
  if (!parsed.success) {
    throw distributionError(
      "RALPH_INSTALL_POINTER_INVALID",
      `Current install pointer does not satisfy schema v1: ${layout.currentPointer}`,
      {
        exitCode: EXIT_CODES.conflict,
        file: layout.currentPointer,
        details: { issues: parsed.error.issues },
      },
    )
  }
  return parsed.data
}

interface InstalledControlState {
  readonly pointer: CurrentInstallPointer
  readonly receipt: InstallReceipt
  readonly receiptPath: string
}

async function readControlState(layout: StandaloneInstallLayout): Promise<InstalledControlState> {
  const pointer = await readPointer(layout)
  const receiptPath = assertManagedInstallPath(layout, resolve(layout.root, pointer.receipt))
  if (!pathInside(layout.receipts, receiptPath)) {
    throw distributionError(
      "RALPH_INSTALL_POINTER_RECEIPT_ESCAPE",
      `Current pointer receipt escapes the immutable receipt directory: ${receiptPath}`,
      { exitCode: EXIT_CODES.conflict, file: receiptPath },
    )
  }
  const receiptBytes = await readRegularBytes(receiptPath)
  const receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex")
  if (receiptSha256 !== pointer.receiptSha256) {
    throw distributionError(
      "RALPH_INSTALL_RECEIPT_HASH_MISMATCH",
      "Current pointer does not match its immutable receipt bytes",
      {
        exitCode: EXIT_CODES.conflict,
        file: receiptPath,
        details: { expected: pointer.receiptSha256, actual: receiptSha256 },
      },
    )
  }
  let rawReceipt: unknown
  try {
    rawReceipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes))
  } catch (error) {
    throw distributionError(
      "RALPH_INSTALL_RECEIPT_INVALID",
      `Immutable install receipt is invalid JSON: ${receiptPath}`,
      { exitCode: EXIT_CODES.conflict, file: receiptPath, cause: error },
    )
  }
  const parsed = InstallReceiptSchema.safeParse(rawReceipt)
  if (!parsed.success) {
    throw distributionError(
      "RALPH_INSTALL_RECEIPT_INVALID",
      `Install receipt does not satisfy schema v1: ${receiptPath}`,
      {
        exitCode: EXIT_CODES.conflict,
        file: receiptPath,
        details: { issues: parsed.error.issues },
      },
    )
  }
  const receipt = validateInstallReceiptPaths(parsed.data, layout.root, receiptPath)
  const current = receipt.versions.find((entry) => entry.version === receipt.currentVersion)
  if (
    pointer.installId !== receipt.installId ||
    pointer.generation !== receipt.generation ||
    pointer.version !== receipt.currentVersion ||
    pointer.target !== receipt.currentTarget ||
    pointer.sha256 !== current?.sha256 ||
    resolve(layout.root, pointer.executable) !== resolve(receipt.currentExecutable)
  ) {
    throw distributionError(
      "RALPH_INSTALL_CONTROL_STATE_DIVERGED",
      "Atomic current pointer and immutable receipt are inconsistent",
      { exitCode: EXIT_CODES.conflict, file: layout.root },
    )
  }
  return { pointer, receipt, receiptPath }
}

async function assertInstallStateConsistent(
  layout: StandaloneInstallLayout,
  receipt: InstallReceipt,
): Promise<void> {
  const current = await readControlState(layout)
  if (
    current.receipt.installId !== receipt.installId ||
    current.receipt.generation !== receipt.generation ||
    current.receipt.currentVersion !== receipt.currentVersion
  ) {
    throw distributionError(
      "RALPH_INSTALL_CONTROL_STATE_DIVERGED",
      "Installed control state changed while the operation was reading it",
      { exitCode: EXIT_CODES.conflict, file: layout.root },
    )
  }
}

function timestamp(options: DistributionRuntimeOptions): string {
  return (options.now?.() ?? new Date()).toISOString()
}

function compareSemver(left: string, right: string): number {
  const parseVersion = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value)
    if (!match)
      throw distributionError("RALPH_RELEASE_VERSION_INVALID", `Invalid release version: ${value}`)
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
      prerelease: match[4]?.split(".") ?? [],
    }
  }
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index]! < b.numbers[index]! ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/u.test(leftPart)
    const rightNumeric = /^\d+$/u.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function validateReleaseSelection(
  manifest: ReleaseManifest,
  artifact: ReleaseArtifact,
  input: {
    expectedChannel?: ReleaseChannel
    expectedVersion?: string
    workspaceSchema?: number
    currentReceipt?: InstallReceipt
    allowDowngrade?: boolean
    platform?: NodeJS.Platform
  },
): void {
  const support = manifest.supportPolicy.matrix.find((entry) => entry.target === artifact.target)
  if (!support || support.status !== "included") {
    throw distributionError(
      "RALPH_RELEASE_TARGET_NOT_PROMOTED",
      `Release ${manifest.version} does not explicitly include ${artifact.target}`,
      {
        exitCode: EXIT_CODES.blocked,
        details: {
          target: artifact.target,
          status: support?.status ?? "missing",
          ...(support?.status === "not-promoted" ? { reason: support.reason } : {}),
        },
      },
    )
  }
  const computedSupportPolicySha256 = releaseSupportPolicySha256(manifest.supportPolicy)
  if (computedSupportPolicySha256 !== manifest.supportPolicySha256) {
    throw distributionError(
      "RALPH_RELEASE_SUPPORT_POLICY_HASH_MISMATCH",
      "Release support matrix is not bound by its declared canonical SHA-256",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const runtimeDurability = installDurability(input.platform)
  if (
    !sameInstallDurability(runtimeDurability, support.capabilities.installControlStateDurability)
  ) {
    throw distributionError(
      "RALPH_RELEASE_SUPPORT_CAPABILITY_MISMATCH",
      `Runtime install-control durability does not match the support policy for ${artifact.target}`,
      {
        exitCode: EXIT_CODES.blocked,
        details: {
          target: artifact.target,
          supportPolicySha256: manifest.supportPolicySha256,
          declared: support.capabilities.installControlStateDurability,
          observed: runtimeDurability,
        },
      },
    )
  }
  if (manifest.channel === "dev") {
    throw distributionError(
      "RALPH_RELEASE_DEV_CHANNEL_NOT_INSTALLABLE",
      "The dev channel is source-checkout only and cannot mutate standalone installations",
      { exitCode: EXIT_CODES.blocked },
    )
  }
  if (input.expectedChannel && manifest.channel !== input.expectedChannel) {
    throw distributionError(
      "RALPH_RELEASE_CHANNEL_MISMATCH",
      `Release channel ${manifest.channel} does not match requested channel ${input.expectedChannel}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (input.expectedVersion && manifest.version !== input.expectedVersion) {
    throw distributionError(
      "RALPH_RELEASE_VERSION_MISMATCH",
      `Release version ${manifest.version} does not match requested version ${input.expectedVersion}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const workspaceSchema = input.workspaceSchema ?? CURRENT_WORKSPACE_SCHEMA
  if (
    !Number.isSafeInteger(workspaceSchema) ||
    workspaceSchema <= 0 ||
    workspaceSchema < manifest.compatibility.minimumWorkspaceSchema ||
    workspaceSchema > manifest.compatibility.maximumWorkspaceSchema
  ) {
    throw distributionError(
      "RALPH_RELEASE_WORKSPACE_SCHEMA_INCOMPATIBLE",
      `Release ${manifest.version} does not support workspace schema ${String(workspaceSchema)}`,
      {
        exitCode: EXIT_CODES.blocked,
        hint: `Select a release supporting schema ${String(workspaceSchema)}; install/update never migrates workspace state implicitly.`,
        details: {
          workspaceSchema,
          minimumWorkspaceSchema: manifest.compatibility.minimumWorkspaceSchema,
          maximumWorkspaceSchema: manifest.compatibility.maximumWorkspaceSchema,
        },
      },
    )
  }
  if (manifest.channel === "stable" && artifact.evidenceStatus !== "tested") {
    throw distributionError(
      "RALPH_RELEASE_STABLE_TARGET_NOT_TESTED",
      `Stable release ${manifest.version} is not evidenced as tested for ${artifact.target}`,
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Use a stable manifest with tested target evidence; built-not-tested is not support proof.",
      },
    )
  }
  if (manifest.channel === "stable" && installDurability(input.platform).guarantee !== "full") {
    throw distributionError(
      "RALPH_RELEASE_STABLE_DURABILITY_UNAVAILABLE",
      `Stable install/update requires durable parent-directory fsync, unavailable on ${input.platform ?? process.platform}`,
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Use a non-stable channel with the reduced file-fsync-only guarantee, or install stable on a platform with directory fsync support.",
      },
    )
  }
  const current = input.currentReceipt
  if (!current) return
  if (!input.expectedChannel && manifest.channel !== current.channel) {
    throw distributionError(
      "RALPH_RELEASE_CHANNEL_CHANGE_EXPLICIT_REQUIRED",
      `Changing release channel from ${current.channel} to ${manifest.channel} requires --channel ${manifest.channel}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (compareSemver(manifest.version, current.currentVersion) < 0 && !input.allowDowngrade) {
    throw distributionError(
      "RALPH_RELEASE_DOWNGRADE_EXPLICIT_REQUIRED",
      `Release ${manifest.version} is older than installed ${current.currentVersion}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Use --allow-downgrade only after confirming workspace schema compatibility.",
      },
    )
  }
}

/**
 * Produces the command-owned, fail-closed result for installations whose
 * mutation lifecycle belongs to an external package manager or to Git. This
 * is public so the CLI can route an invocation before requiring a standalone
 * install root; it never performs the suggested external command.
 */
export function rejectUnmanagedInstallOrigin(
  origin: Extract<InstallOrigin, { kind: "npm" | "dev-checkout" }>,
): never {
  if (origin.kind === "npm") {
    const commands = {
      npm: `npm update --global ${origin.packageName}`,
      pnpm: `pnpm update --global ${origin.packageName}`,
      bun: `bun update --global ${origin.packageName}`,
    } as const
    const command =
      origin.packageManager === "unknown" ? undefined : commands[origin.packageManager]
    const owner =
      origin.packageManager === "unknown"
        ? "An external package manager"
        : `The ${origin.packageManager} package manager`
    throw distributionError(
      "RALPH_INSTALL_ORIGIN_NPM_EXTERNAL",
      `${owner} owns this installation; Ralph will not imitate its mutation semantics`,
      {
        exitCode: EXIT_CODES.blocked,
        hint: command
          ? `Run explicitly after reviewing package-manager scope: ${command}`
          : "Use the same package manager that installed this package; Ralph cannot safely infer its command.",
        details: {
          origin: origin.kind,
          packageName: origin.packageName,
          packageManager: origin.packageManager,
          ...(command ? { command } : {}),
        },
      },
    )
  }
  throw distributionError(
    "RALPH_INSTALL_ORIGIN_DEV_CHECKOUT_EXTERNAL",
    "A development checkout is owned by Git and is never updated automatically by Ralph",
    {
      exitCode: EXIT_CODES.blocked,
      hint: "Inspect the checkout with `git status --short --branch`, then choose an explicit Git update operation.",
      details: { origin: origin.kind, inspectionCommand: "git status --short --branch" },
    },
  )
}

function operationPath(operation: DistributionOperation): string {
  return join(operation.stagingRoot, "operation.json")
}

async function persistOperation(operation: DistributionOperation): Promise<void> {
  const parsed = DistributionOperationSchema.parse(operation)
  await writeJsonAtomic(operationPath(parsed), parsed)
}

function nextOperation(
  operation: DistributionOperation,
  status: DistributionOperation["status"],
  updatedAt: string,
  patch: Partial<DistributionOperation> = {},
  clear: readonly (
    | "pendingRename"
    | "pendingReceiptPath"
    | "pendingReceiptSha256"
    | "failure"
  )[] = [],
): DistributionOperation {
  const candidate: Record<string, unknown> = { ...operation, ...patch, status, updatedAt }
  for (const field of clear) delete candidate[field]
  return DistributionOperationSchema.parse(candidate)
}

async function createOperation(
  layout: StandaloneInstallLayout,
  action: DistributionOperation["action"],
  options: DistributionRuntimeOptions,
  input: Partial<DistributionOperation> = {},
): Promise<DistributionOperation> {
  const operationId = randomUUID()
  const stagingRoot = assertManagedInstallPath(layout, join(layout.staging, operationId))
  await ensureDirectory(stagingRoot)
  const now = timestamp(options)
  const operation = DistributionOperationSchema.parse({
    ...input,
    schemaVersion: 1,
    operationId,
    action,
    status: "planned",
    installRoot: layout.root,
    stagingRoot,
    stagedPaths: [stagingRoot, join(stagingRoot, "operation.json")],
    materializedPaths: [],
    launcherMutation: action === "install" ? "install" : action === "update" ? "preserve" : "none",
    createdAt: now,
    updatedAt: now,
  })
  try {
    await persistOperation(operation)
  } catch (error) {
    await removeOwnedTree(stagingRoot, layout.staging).catch(() => undefined)
    throw error
  }
  return operation
}

interface StagedRelease {
  readonly loaded: LoadedReleaseManifest
  readonly manifest: ReleaseManifest
  readonly artifact: ReleaseArtifact
  readonly launcher: StagedReleasePayload
  readonly versionFiles: readonly {
    readonly role: InstalledVersion["files"][number]["role"]
    readonly staged: StagedReleasePayload
    readonly finalName: string
  }[]
}

async function decodeNonEmptyText(path: string, label: string): Promise<string> {
  const bytes = await readRegularBytes(path)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw distributionError("RALPH_RELEASE_TEXT_INVALID", `${label} is not valid UTF-8`, {
      file: path,
      cause: error,
    })
  }
  if (text.trim().length === 0) {
    throw distributionError("RALPH_RELEASE_TEXT_EMPTY", `${label} must not be empty`, {
      file: path,
    })
  }
  return text
}

async function stageRelease(
  operation: DistributionOperation,
  loaded: LoadedReleaseManifest,
  artifact: ReleaseArtifact,
  options: DistributionRuntimeOptions,
): Promise<StagedRelease> {
  const launcherDirectory = join(operation.stagingRoot, "launcher")
  const versionRoot = join(operation.stagingRoot, "version")
  await ensureDirectory(launcherDirectory)
  await ensureDirectory(versionRoot)
  const extension = artifact.target.startsWith("bun-windows-") ? ".exe" : ""
  const staged = async (payload: ReleasePayload, destination: string) =>
    stageReleasePayload(loaded, payload, destination, {
      containmentRoot: operation.stagingRoot,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.transport ? { transport: options.transport } : {}),
    })

  const launcher = await staged(
    artifact.launcher,
    join(launcherDirectory, `ralph-next${extension}`),
  )
  const versionFiles: Array<StagedRelease["versionFiles"][number]> = []
  const add = async (
    role: InstalledVersion["files"][number]["role"],
    payload: ReleasePayload,
    finalName: string,
  ) => {
    const receipt = await staged(payload, join(versionRoot, finalName))
    versionFiles.push({ role, staged: receipt, finalName })
    return receipt
  }
  const executable = await add("executable", artifact.executable, `ralph-next${extension}`)
  const buildMetadata = await add("build-metadata", artifact.buildMetadata, "build-metadata.json")
  const launcherBuildMetadata = await add(
    "launcher-build-metadata",
    artifact.launcherBuildMetadata,
    "launcher-build-metadata.json",
  )
  const license = await add("license", loaded.manifest.license, "LICENSE")
  const notices = await add(
    "third-party-notices",
    loaded.manifest.thirdPartyNotices,
    "THIRD_PARTY_NOTICES.md",
  )
  const sbom = await add("sbom", loaded.manifest.sbom, "SBOM.cdx.json")
  const skill = await add("skill", loaded.manifest.skill, "ralph-loop-prd-generator.tar")
  const checksums = await add("checksums", loaded.manifest.checksums, "SHA256SUMS")
  let promotionRecord: StagedReleasePayload | undefined
  if (loaded.manifest.promotionRecord) {
    promotionRecord = await add(
      "promotion-record",
      loaded.manifest.promotionRecord,
      "promotion-record.json",
    )
  }
  const manifestPath = join(versionRoot, "release-manifest.json")
  await writeBytesAtomic(manifestPath, loaded.rawBytes)
  versionFiles.push({
    role: "release-manifest",
    staged: { path: manifestPath, sizeBytes: loaded.rawBytes.byteLength, sha256: loaded.sha256 },
    finalName: "release-manifest.json",
  })
  let signature: StagedReleasePayload | undefined
  if (loaded.manifest.signature.status === "present") {
    const finalName = `release-signature.${loaded.manifest.signature.kind}`
    const signaturePayload = loaded.manifest.signature.payload
    signature = await stageDetachedSignaturePayload(
      loaded,
      {
        path: signaturePayload.path,
        ...(signaturePayload.url !== undefined ? { url: signaturePayload.url } : {}),
        maximumSizeBytes: signaturePayload.maximumSizeBytes,
        mediaType: signaturePayload.mediaType,
      },
      join(versionRoot, finalName),
      {
        containmentRoot: operation.stagingRoot,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.transport ? { transport: options.transport } : {}),
      },
    )
    versionFiles.push({ role: "signature", staged: signature, finalName })
  }

  const engineMetadata = ReleaseBuildMetadataSchema.safeParse(await readJson(buildMetadata.path))
  if (!engineMetadata.success) {
    throw distributionError(
      "RALPH_RELEASE_BUILD_METADATA_INVALID",
      "Engine build metadata does not satisfy schema v1",
      { file: buildMetadata.path, details: { issues: engineMetadata.error.issues } },
    )
  }
  const launcherMetadata = LauncherBuildMetadataSchema.safeParse(
    await readJson(launcherBuildMetadata.path),
  )
  if (!launcherMetadata.success) {
    throw distributionError(
      "RALPH_RELEASE_LAUNCHER_METADATA_INVALID",
      "Launcher build metadata does not satisfy schema v1",
      { file: launcherBuildMetadata.path, details: { issues: launcherMetadata.error.issues } },
    )
  }
  for (const [label, metadata, expected] of [
    ["engine", engineMetadata.data, executable],
    ["launcher", launcherMetadata.data, launcher],
  ] as const) {
    if (
      metadata.version !== loaded.manifest.version ||
      metadata.target !== artifact.target ||
      metadata.status === "not-evidenced" ||
      metadata.sha256 !== expected.sha256 ||
      metadata.sourceSha256 !== loaded.manifest.source.fingerprintSha256
    ) {
      throw distributionError(
        "RALPH_RELEASE_BUILD_METADATA_MISMATCH",
        `${label} build metadata does not match manifest, target, source or payload`,
        {
          file: label === "engine" ? buildMetadata.path : launcherBuildMetadata.path,
          details: {
            releaseVersion: loaded.manifest.version,
            metadataVersion: metadata.version,
            releaseTarget: artifact.target,
            metadataTarget: metadata.target,
          },
        },
      )
    }
  }

  await decodeNonEmptyText(license.path, "Release LICENSE")
  await decodeNonEmptyText(notices.path, "Release THIRD_PARTY_NOTICES")
  let sbomDocument: unknown
  try {
    sbomDocument = JSON.parse(await decodeNonEmptyText(sbom.path, "Release SBOM"))
  } catch (error) {
    throw distributionError("RALPH_RELEASE_SBOM_INVALID", "Release SBOM is not valid JSON", {
      file: sbom.path,
      cause: error,
    })
  }
  const parsedSbom = ReleaseSbomSchema.safeParse(sbomDocument)
  if (!parsedSbom.success) {
    throw distributionError(
      "RALPH_RELEASE_SBOM_CONTRACT_INVALID",
      "Release SBOM must satisfy the bounded CycloneDX 1.6 release profile",
      { file: sbom.path, details: { issues: parsedSbom.error.issues } },
    )
  }
  const sbomSourceFingerprint = parsedSbom.data.metadata.properties.find(
    (property) => property.name === "ralph:source-fingerprint-sha256",
  )?.value
  const expectedApplicationPurl = `pkg:npm/ralph-next@${encodeURIComponent(loaded.manifest.version)}`
  if (
    parsedSbom.data.metadata.component.name !== "ralph-next" ||
    parsedSbom.data.metadata.component.type !== "application" ||
    parsedSbom.data.metadata.component.version !== loaded.manifest.version ||
    parsedSbom.data.metadata.component.purl !== expectedApplicationPurl ||
    parsedSbom.data.metadata.component["bom-ref"] !== expectedApplicationPurl ||
    sbomSourceFingerprint !== loaded.manifest.source.fingerprintSha256
  ) {
    throw distributionError(
      "RALPH_RELEASE_SBOM_BINDING_MISMATCH",
      "Release SBOM does not bind the product version and source fingerprint in the manifest",
      {
        file: sbom.path,
        details: {
          expectedVersion: loaded.manifest.version,
          observedVersion: parsedSbom.data.metadata.component.version,
          expectedApplicationPurl,
          observedApplicationPurl: parsedSbom.data.metadata.component.purl,
          expectedSourceFingerprintSha256: loaded.manifest.source.fingerprintSha256,
          observedSourceFingerprintSha256: sbomSourceFingerprint,
        },
      },
    )
  }

  const checksumText = await decodeNonEmptyText(checksums.path, "Release checksums")
  const checksumEntries = new Map<string, string>()
  const checksumCollisionKeys = new Map<string, string>()
  for (const [lineIndex, line] of checksumText.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) continue
    const match = /^([0-9a-f]{64})[ \t]+\*?(.+)$/u.exec(line)
    const checksumPath = match?.[2]
    const parsedChecksumPath = PortableRelativePathSchema.safeParse(checksumPath)
    if (!match || !parsedChecksumPath.success) {
      throw distributionError(
        "RALPH_RELEASE_CHECKSUMS_INVALID",
        `Invalid checksum ledger entry at line ${lineIndex + 1}`,
        { file: checksums.path },
      )
    }
    const collisionKey = releasePathCollisionKey(parsedChecksumPath.data)
    const collision = checksumCollisionKeys.get(collisionKey)
    if (collision) {
      throw distributionError(
        "RALPH_RELEASE_CHECKSUMS_DUPLICATE",
        `Checksum ledger path collides cross-platform with ${collision}: ${parsedChecksumPath.data}`,
        { file: checksums.path },
      )
    }
    checksumCollisionKeys.set(collisionKey, parsedChecksumPath.data)
    checksumEntries.set(parsedChecksumPath.data, match[1]!)
  }
  const requiredPayloads = [
    artifact.launcher,
    artifact.launcherBuildMetadata,
    artifact.executable,
    artifact.buildMetadata,
    loaded.manifest.license,
    loaded.manifest.thirdPartyNotices,
    loaded.manifest.sbom,
    loaded.manifest.skill,
  ]
  if (artifact.archive) requiredPayloads.push(artifact.archive)
  if (loaded.manifest.promotionRecord) requiredPayloads.push(loaded.manifest.promotionRecord)
  for (const payload of requiredPayloads) {
    if (checksumEntries.get(payload.path) !== payload.sha256) {
      throw distributionError(
        "RALPH_RELEASE_CHECKSUMS_MISMATCH",
        `Checksum ledger does not bind release payload: ${payload.path}`,
        { file: checksums.path },
      )
    }
  }

  if (promotionRecord) {
    let record: unknown
    try {
      record = JSON.parse(
        await decodeNonEmptyText(promotionRecord.path, "Release promotion record"),
      )
    } catch (error) {
      throw distributionError(
        "RALPH_RELEASE_PROMOTION_RECORD_INVALID",
        "Release promotion record is not valid JSON",
        { file: promotionRecord.path, cause: error },
      )
    }
    const promotionChannel = loaded.manifest.channel
    if (promotionChannel !== "beta" && promotionChannel !== "stable") {
      throw distributionError(
        "RALPH_RELEASE_PROMOTION_RECORD_CONTRACT_INVALID",
        `Promotion records are not valid for the ${promotionChannel} channel`,
        { file: promotionRecord.path },
      )
    }
    const promotedTargets = loaded.manifest.artifacts.map((candidateArtifact) => {
      if (!candidateArtifact.archive) {
        throw distributionError(
          "RALPH_RELEASE_PROMOTION_ARCHIVE_MISSING",
          `Promoted target has no archive payload: ${candidateArtifact.target}`,
          { file: promotionRecord.path },
        )
      }
      return {
        target: candidateArtifact.target,
        engineSha256: candidateArtifact.executable.sha256,
        launcherSha256: candidateArtifact.launcher.sha256,
        buildMetadataSha256: candidateArtifact.buildMetadata.sha256,
        launcherBuildMetadataSha256: candidateArtifact.launcherBuildMetadata.sha256,
        archiveSha256: candidateArtifact.archive.sha256,
      }
    })
    try {
      assertReleasePromotionBinding(record, {
        version: loaded.manifest.version,
        channel: promotionChannel,
        repository: loaded.manifest.source.repository,
        commit: loaded.manifest.source.commit,
        sourceFingerprintSha256: loaded.manifest.source.fingerprintSha256,
        support: {
          licenseSha256: license.sha256,
          thirdPartyNoticesSha256: notices.sha256,
          sbomSha256: sbom.sha256,
          skillArtifactSha256: skill.sha256,
          supportPolicySha256: loaded.manifest.supportPolicySha256,
        },
        supportPolicy: loaded.manifest.supportPolicy,
        targets: promotedTargets,
        publishedAt: loaded.manifest.publishedAt,
        now: timestamp(options),
      })
    } catch (error) {
      if (error instanceof RalphError) throw error
      throw distributionError(
        "RALPH_RELEASE_PROMOTION_BINDING_INVALID",
        "Release promotion record does not canonically bind source, support files, targets and evidence",
        { file: promotionRecord.path, cause: error },
      )
    }
  }

  if (loaded.manifest.signature.status === "present") {
    if (!signature || !options.signatureVerifier || !options.signatureTrustPolicy) {
      throw distributionError(
        "RALPH_RELEASE_SIGNATURE_VERIFIER_UNAVAILABLE",
        `Release declares ${loaded.manifest.signature.kind} provenance but no verifier and local trust policy are configured`,
        {
          exitCode: EXIT_CODES.blocked,
          hint: "Compose a matching verifier and a local origin/channel trust policy; manifest identity is never a trust anchor.",
        },
      )
    }
    const trustPolicy = ReleaseSignatureTrustPolicySchema.parse(options.signatureTrustPolicy)
    const trustedOrigin =
      loaded.source.kind === "local" ? "local-artifact" : `${loaded.source.url.origin}/`
    const signatureChannel = loaded.manifest.channel
    if (
      trustPolicy.kind !== loaded.manifest.signature.kind ||
      signatureChannel === "dev" ||
      !trustPolicy.channels.includes(signatureChannel) ||
      !trustPolicy.origins.includes(trustedOrigin) ||
      !trustPolicy.trustedIdentities.includes(loaded.manifest.signature.identity)
    ) {
      throw distributionError(
        "RALPH_RELEASE_SIGNATURE_TRUST_POLICY_MISMATCH",
        "Release signature descriptor is outside the locally configured kind, channel, origin or identity policy",
        {
          exitCode: EXIT_CODES.blocked,
          details: {
            kind: loaded.manifest.signature.kind,
            channel: loaded.manifest.channel,
            origin: trustedOrigin,
          },
        },
      )
    }
    const canonicalManifestBytes = canonicalReleaseManifestSigningBytes(loaded.manifest)
    const computedSignedManifestSha256 = releaseManifestSigningSha256(loaded.manifest)
    if (computedSignedManifestSha256 !== loaded.manifest.signature.signedManifestSha256) {
      throw distributionError(
        "RALPH_RELEASE_SIGNED_MANIFEST_HASH_MISMATCH",
        "Detached signature descriptor does not bind the canonical release manifest",
        {
          exitCode: EXIT_CODES.conflict,
          details: {
            expected: loaded.manifest.signature.signedManifestSha256,
            actual: computedSignedManifestSha256,
          },
        },
      )
    }
    const verified = await options.signatureVerifier.verify({
      kind: loaded.manifest.signature.kind,
      claimedIdentity: loaded.manifest.signature.identity,
      trustPolicy,
      canonicalManifestBytes,
      signedManifestSha256: computedSignedManifestSha256,
      signaturePath: signature.path,
      signatureSizeBytes: signature.sizeBytes,
      signatureSha256: signature.sha256,
      signatureMaximumSizeBytes: loaded.manifest.signature.payload.maximumSizeBytes,
      signatureMediaType: loaded.manifest.signature.payload.mediaType,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (
      verified.kind !== loaded.manifest.signature.kind ||
      verified.identity !== loaded.manifest.signature.identity ||
      !trustPolicy.trustedIdentities.includes(verified.identity) ||
      verified.signedManifestSha256 !== computedSignedManifestSha256 ||
      verified.signatureSha256 !== signature.sha256 ||
      (trustPolicy.trustedIssuers.length > 0 &&
        (!verified.issuer || !trustPolicy.trustedIssuers.includes(verified.issuer)))
    ) {
      throw distributionError(
        "RALPH_RELEASE_SIGNATURE_IDENTITY_MISMATCH",
        "Cryptographic verification result does not match the signature scheme, signature snapshot, signed manifest or local identity/issuer trust policy",
        { exitCode: EXIT_CODES.blocked },
      )
    }
  }

  return { loaded, manifest: loaded.manifest, artifact, launcher, versionFiles }
}

function managedPaths(
  layout: StandaloneInstallLayout,
  versions: readonly InstalledVersion[],
  additional: readonly string[] = [],
): string[] {
  const paths = new Set<string>([
    layout.currentPointer,
    layout.receipts,
    layout.bin,
    layout.launcher,
    layout.versions,
    layout.staging,
    layout.rollback,
  ])
  for (const version of versions) {
    paths.add(version.directory)
    for (const file of version.files) paths.add(file.path)
  }
  for (const path of additional) paths.add(assertManagedInstallPath(layout, path))
  return [...paths].sort()
}

async function makeExecutable(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform !== "win32") await chmod(path, 0o755)
}

async function removeOwnedTree(path: string, containmentRoot: string): Promise<void> {
  const root = resolve(path)
  const containment = resolve(containmentRoot)
  if (!pathInside(containment, root)) {
    throw distributionError(
      "RALPH_INSTALL_REMOVE_PATH_ESCAPE",
      `Refusing to remove path outside managed operation root: ${root}`,
      { exitCode: EXIT_CODES.policyDenied, file: root },
    )
  }
  const information = await optionalLstat(root)
  if (!information) return
  if (information.isSymbolicLink()) {
    throw distributionError(
      "RALPH_INSTALL_REMOVE_SYMLINK_REFUSED",
      `Refusing to remove a symbolic link from managed distribution state: ${root}`,
      { exitCode: EXIT_CODES.policyDenied, file: root },
    )
  }
  if (information.isDirectory()) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = resolve(root, entry.name)
      if (!pathInside(root, child)) {
        throw distributionError(
          "RALPH_INSTALL_REMOVE_PATH_ESCAPE",
          `Invalid managed child path: ${child}`,
        )
      }
      await removeOwnedTree(child, containment)
    }
    await rmdir(root)
    return
  }
  if (!information.isFile()) {
    throw distributionError(
      "RALPH_INSTALL_REMOVE_SPECIAL_FILE_REFUSED",
      `Refusing to remove a non-regular managed path: ${root}`,
      { exitCode: EXIT_CODES.policyDenied, file: root },
    )
  }
  await unlink(root)
}

export interface DistributionRecoveryRecord {
  readonly operationId: string
  readonly action: DistributionOperation["action"]
  readonly previousStatus: DistributionOperation["status"]
  readonly disposition: "cleaned" | "finalized" | "repair-required" | "uninstall-resume-required"
}

async function readOperation(path: string): Promise<DistributionOperation> {
  const parsed = DistributionOperationSchema.safeParse(await readJson(path))
  if (!parsed.success) {
    throw distributionError(
      "RALPH_INSTALL_OPERATION_JOURNAL_INVALID",
      `Distribution operation journal does not satisfy schema v1: ${path}`,
      { exitCode: EXIT_CODES.conflict, file: path, details: { issues: parsed.error.issues } },
    )
  }
  return parsed.data
}

async function controlsSelectVersion(
  layout: StandaloneInstallLayout,
  version: string | undefined,
): Promise<boolean> {
  if (!version || !(await optionalLstat(layout.currentPointer))) {
    return false
  }
  try {
    const { receipt, pointer } = await readControlState(layout)
    return (
      receipt.currentVersion === version &&
      pointer.version === version &&
      pointer.installId === receipt.installId &&
      pointer.sha256 === receipt.versions.find((entry) => entry.version === version)?.sha256
    )
  } catch {
    return false
  }
}

async function recoverLayoutOperations(
  layout: StandaloneInstallLayout,
  options: DistributionRuntimeOptions & { readonly cleanupRepairRequired?: boolean } = {},
): Promise<DistributionRecoveryRecord[]> {
  const stagingInformation = await optionalLstat(layout.staging)
  if (!stagingInformation) return []
  if (stagingInformation.isSymbolicLink() || !stagingInformation.isDirectory()) {
    throw distributionError(
      "RALPH_INSTALL_STAGING_INVALID",
      `Distribution staging root is not a regular directory: ${layout.staging}`,
      { exitCode: EXIT_CODES.policyDenied, file: layout.staging },
    )
  }
  const recovered: DistributionRecoveryRecord[] = []
  for (const entry of await readdir(layout.staging, { withFileTypes: true })) {
    if (!entry.isDirectory() || !OPERATION_DIRECTORY_PATTERN.test(entry.name)) {
      throw distributionError(
        "RALPH_INSTALL_STAGING_UNKNOWN_ENTRY",
        `Distribution staging contains an unowned entry: ${entry.name}`,
        { exitCode: EXIT_CODES.conflict, file: join(layout.staging, entry.name) },
      )
    }
    const stagingRoot = assertManagedInstallPath(layout, join(layout.staging, entry.name))
    const journalPath = join(stagingRoot, "operation.json")
    if (!(await optionalLstat(journalPath))) {
      const children = await readdir(stagingRoot)
      if (
        children.length === 0 ||
        children.every((name) => /^\.operation\.json\.[0-9a-f-]{36}\.tmp$/iu.test(name))
      ) {
        await removeOwnedTree(stagingRoot, layout.staging)
        continue
      }
      throw distributionError(
        "RALPH_INSTALL_OPERATION_JOURNAL_MISSING",
        `Distribution staging has effects without its write-ahead journal: ${stagingRoot}`,
        { exitCode: EXIT_CODES.conflict, file: stagingRoot },
      )
    }
    const operation = await readOperation(journalPath)
    if (
      operation.operationId !== entry.name ||
      resolve(operation.installRoot) !== layout.root ||
      resolve(operation.stagingRoot) !== stagingRoot
    ) {
      throw distributionError(
        "RALPH_INSTALL_OPERATION_IDENTITY_MISMATCH",
        `Distribution journal is not bound to its staging directory: ${stagingRoot}`,
        { exitCode: EXIT_CODES.conflict, file: stagingRoot },
      )
    }
    for (const path of [
      ...operation.stagedPaths,
      ...operation.materializedPaths,
      ...operation.uninstallPaths,
    ]) {
      assertManagedInstallPath(layout, path)
    }
    if (operation.pendingRename) {
      assertManagedInstallPath(layout, operation.pendingRename.source)
      assertManagedInstallPath(layout, operation.pendingRename.destination)
    }
    if (operation.pendingReceiptPath) {
      const pendingReceipt = assertManagedInstallPath(layout, operation.pendingReceiptPath)
      if (!pathInside(layout.receipts, pendingReceipt)) {
        throw distributionError(
          "RALPH_INSTALL_OPERATION_RECEIPT_ESCAPE",
          `Pending immutable receipt escapes receipts/: ${pendingReceipt}`,
          { exitCode: EXIT_CODES.conflict, file: pendingReceipt },
        )
      }
    }
    if (Boolean(operation.pendingReceiptPath) !== Boolean(operation.pendingReceiptSha256)) {
      throw distributionError(
        "RALPH_INSTALL_OPERATION_RECEIPT_BINDING_INCOMPLETE",
        `Pending receipt path/hash binding is incomplete: ${operation.operationId}`,
        { exitCode: EXIT_CODES.conflict, file: journalPath },
      )
    }
    if (operation.handoffReceiptPath) {
      const handoffReceipt = assertManagedInstallPath(layout, operation.handoffReceiptPath)
      if (!pathInside(layout.receipts, handoffReceipt)) {
        throw distributionError(
          "RALPH_INSTALL_OPERATION_HANDOFF_RECEIPT_ESCAPE",
          `Deferred uninstall handoff receipt escapes receipts/: ${handoffReceipt}`,
          { exitCode: EXIT_CODES.conflict, file: handoffReceipt },
        )
      }
    }
    if (Boolean(operation.handoffReceiptPath) !== Boolean(operation.handoffReceiptSha256)) {
      throw distributionError(
        "RALPH_INSTALL_OPERATION_HANDOFF_BINDING_INCOMPLETE",
        `Deferred uninstall handoff receipt binding is incomplete: ${operation.operationId}`,
        { exitCode: EXIT_CODES.conflict, file: journalPath },
      )
    }
    if (operation.status === "repair-required") {
      if (!options.cleanupRepairRequired) {
        recovered.push({
          operationId: operation.operationId,
          action: operation.action,
          previousStatus: operation.status,
          disposition: "repair-required",
        })
        continue
      }
      await removeOwnedTree(stagingRoot, layout.staging)
      recovered.push({
        operationId: operation.operationId,
        action: operation.action,
        previousStatus: operation.status,
        disposition: "cleaned",
      })
      continue
    }
    if (operation.status === "uninstalling" || operation.status === "removing-control-state") {
      recovered.push({
        operationId: operation.operationId,
        action: operation.action,
        previousStatus: operation.status,
        disposition: "uninstall-resume-required",
      })
      continue
    }
    if (
      operation.action !== "uninstall" &&
      (await controlsSelectVersion(layout, operation.requestedVersion))
    ) {
      await finalizeOperationHistory(layout, operation, options)
      recovered.push({
        operationId: operation.operationId,
        action: operation.action,
        previousStatus: operation.status,
        disposition: "finalized",
      })
      continue
    }
    if (operation.rollbackPointerPath) {
      const pointerSnapshot = await optionalLstat(operation.rollbackPointerPath)
      if (!pointerSnapshot) {
        throw distributionError(
          "RALPH_INSTALL_RECOVERY_SNAPSHOT_INCOMPLETE",
          `Distribution recovery snapshot is incomplete: ${operation.operationId}`,
          { exitCode: EXIT_CODES.conflict, file: stagingRoot },
        )
      }
      await restoreControlSnapshot(layout, operation)
    } else if (operation.action === "install") {
      await unlink(layout.currentPointer).catch(() => undefined)
    }
    const currentState = (await optionalLstat(layout.currentPointer))
      ? await readControlState(layout)
      : undefined
    const receipt = currentState?.receipt
    for (const path of [...operation.materializedPaths].reverse()) {
      const stillOwned =
        receipt?.managedPaths.some((managed) => resolve(managed) === resolve(path)) ?? false
      if (!stillOwned) await removeOwnedTree(path, layout.root)
    }
    if (
      operation.pendingReceiptPath &&
      resolve(operation.pendingReceiptPath) !== resolve(currentState?.receiptPath ?? "")
    ) {
      await unlink(operation.pendingReceiptPath).catch(() => undefined)
    }
    const rollbackRoot = join(layout.rollback, operation.operationId)
    if (await optionalLstat(rollbackRoot)) {
      const stillOwned =
        receipt?.managedPaths.some((managed) => resolve(managed) === resolve(rollbackRoot)) ?? false
      if (!stillOwned) await removeOwnedTree(rollbackRoot, layout.rollback)
    }
    await removeOwnedTree(stagingRoot, layout.staging)
    recovered.push({
      operationId: operation.operationId,
      action: operation.action,
      previousStatus: operation.status,
      disposition: "cleaned",
    })
  }
  return recovered
}

export async function recoverStandaloneInstall(
  requestedRoot: string,
  options: DistributionRuntimeOptions & { readonly cleanupRepairRequired?: boolean } = {},
): Promise<readonly DistributionRecoveryRecord[]> {
  const layout = await canonicalLayout(requestedRoot, options.platform ?? process.platform)
  return withInstallLock(layout, "recover", options, () => recoverLayoutOperations(layout, options))
}

async function initializeFreshLayout(layout: StandaloneInstallLayout): Promise<void> {
  await assertNoProjectCollision(layout.root)
  const existing = await optionalLstat(layout.root)
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw distributionError(
        "RALPH_INSTALL_ROOT_INVALID",
        `Install root must be a regular directory: ${layout.root}`,
        { exitCode: EXIT_CODES.policyDenied, file: layout.root },
      )
    }
    const entries = await readdir(layout.root)
    const allowedRecoveredScaffolding = new Set([
      "bin",
      "versions",
      "receipts",
      "staging",
      "rollback",
    ])
    if (entries.some((entry) => !allowedRecoveredScaffolding.has(entry))) {
      throw distributionError(
        "RALPH_INSTALL_ROOT_NOT_EMPTY",
        `Install root is not empty or already identified: ${layout.root}`,
        {
          exitCode: EXIT_CODES.conflict,
          file: layout.root,
          hint: "Choose a new empty directory; --force never erases an unknown target.",
        },
      )
    }
    for (const entry of entries) {
      const path = join(layout.root, entry)
      await assertDirectory(path)
      if ((await readdir(path)).length > 0) {
        throw distributionError(
          "RALPH_INSTALL_ROOT_NOT_EMPTY",
          `Recovered install scaffolding is not empty: ${path}`,
          { exitCode: EXIT_CODES.conflict, file: path },
        )
      }
    }
  } else {
    await ensureDirectory(layout.root)
  }
  for (const directory of [
    layout.bin,
    layout.versions,
    layout.receipts,
    layout.staging,
    layout.rollback,
  ]) {
    await ensureDirectory(directory)
  }
}

async function openIdentifiedLayout(
  requestedRoot: string,
  platform: NodeJS.Platform,
): Promise<{ layout: StandaloneInstallLayout; receipt: InstallReceipt }> {
  const layout = await canonicalLayout(requestedRoot, platform)
  await assertDirectory(layout.root)
  const state = await readControlState(layout)
  await verifyFile(layout.launcher, state.receipt.launcher.sha256)
  const current = state.receipt.versions.find(
    (entry) => entry.version === state.receipt.currentVersion,
  )
  if (!current) {
    throw distributionError(
      "RALPH_INSTALL_CURRENT_VERSION_MISSING",
      "Immutable receipt does not contain its selected version",
      { exitCode: EXIT_CODES.conflict, file: state.receiptPath },
    )
  }
  await verifyInstalledVersion(current)
  return { layout, receipt: state.receipt }
}

async function snapshotControls(
  layout: StandaloneInstallLayout,
  operation: DistributionOperation,
  options: DistributionRuntimeOptions,
): Promise<DistributionOperation> {
  const rollbackRoot = assertManagedInstallPath(
    layout,
    join(layout.rollback, operation.operationId),
  )
  await ensureDirectory(rollbackRoot)
  const pointerPath = join(rollbackRoot, "current.before.json")
  await writeBytesAtomic(pointerPath, await readRegularBytes(layout.currentPointer))
  return nextOperation(operation, operation.status, timestamp(options), {
    rollbackPointerPath: pointerPath,
    stagedPaths: [...operation.stagedPaths, rollbackRoot, pointerPath],
  })
}

async function restoreControlSnapshot(
  layout: StandaloneInstallLayout,
  operation: DistributionOperation,
): Promise<void> {
  if (!operation.rollbackPointerPath) {
    throw distributionError(
      "RALPH_INSTALL_ROLLBACK_SNAPSHOT_MISSING",
      "Distribution activation cannot be restored because its control snapshot is missing",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  await writeBytesAtomic(
    layout.currentPointer,
    await readRegularBytes(operation.rollbackPointerPath),
  )
  await readControlState(layout)
}

function immutableReceiptPath(
  layout: StandaloneInstallLayout,
  installId: string,
  generation: number,
): string {
  return assertManagedInstallPath(
    layout,
    join(layout.receipts, `${String(generation).padStart(10, "0")}-${installId}.json`),
  )
}

async function persistControlState(
  layout: StandaloneInstallLayout,
  operation: DistributionOperation,
  receipt: InstallReceipt,
  now: string,
): Promise<{ operation: DistributionOperation; receiptPath: string }> {
  const parsed = InstallReceiptSchema.parse(receipt)
  const receiptPath = immutableReceiptPath(layout, parsed.installId, parsed.generation)
  if (!parsed.managedPaths.some((path) => resolve(path) === receiptPath)) {
    throw distributionError(
      "RALPH_INSTALL_RECEIPT_SELF_OWNERSHIP_MISSING",
      `Immutable receipt does not own its own path: ${receiptPath}`,
      { exitCode: EXIT_CODES.conflict, file: receiptPath },
    )
  }
  const receiptBytes = new TextEncoder().encode(serializeDistributionControlFile(parsed))
  const receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex")
  const pointer = buildCurrentInstallPointer(
    parsed,
    receiptPath,
    receiptSha256,
    parsed.currentVersion,
    now,
  )
  const prepared = nextOperation(operation, "persisting-control-state", now, {
    pendingReceiptPath: receiptPath,
    pendingReceiptSha256: receiptSha256,
  })
  await persistOperation(prepared)
  const existing = await optionalLstat(receiptPath)
  if (existing) {
    await verifyFile(receiptPath, receiptSha256, receiptBytes.byteLength)
  } else {
    await writeBytesAtomic(receiptPath, receiptBytes)
  }
  await writeJsonAtomic(layout.currentPointer, pointer)
  await assertInstallStateConsistent(layout, parsed)
  return { operation: prepared, receiptPath }
}

async function finalizeOperationHistory(
  layout: StandaloneInstallLayout,
  operation: DistributionOperation,
  options: DistributionRuntimeOptions,
): Promise<void> {
  const completed = nextOperation(operation, "completed", timestamp(options))
  await persistOperation(completed)
  const historyRoot = assertManagedInstallPath(layout, join(layout.rollback, completed.operationId))
  await ensureDirectory(historyRoot)
  await writeJsonAtomic(join(historyRoot, "operation.json"), completed)
  await removeOwnedTree(completed.stagingRoot, layout.staging)
}

async function materializeVersion(
  layout: StandaloneInstallLayout,
  operation: DistributionOperation,
  staged: StagedRelease,
  platform: NodeJS.Platform,
  options: DistributionRuntimeOptions,
): Promise<{ operation: DistributionOperation; version: InstalledVersion }> {
  const finalDirectory = versionDirectory(layout, staged.manifest.version)
  if (await optionalLstat(finalDirectory)) {
    throw distributionError(
      "RALPH_INSTALL_VERSION_COLLISION",
      `Immutable version directory already exists: ${finalDirectory}`,
      { exitCode: EXIT_CODES.conflict, file: finalDirectory },
    )
  }
  const stagedDirectory = join(operation.stagingRoot, "version")
  const prepared = nextOperation(operation, "materializing-version", timestamp(options), {
    pendingRename: {
      kind: "version",
      source: stagedDirectory,
      destination: finalDirectory,
    },
    materializedPaths: [...operation.materializedPaths, finalDirectory],
  })
  await persistOperation(prepared)
  await rename(stagedDirectory, finalDirectory)
  await syncRenameParents(stagedDirectory, finalDirectory, platform)
  const executableFile = staged.versionFiles.find((file) => file.role === "executable")!
  const executable = join(finalDirectory, executableFile.finalName)
  await makeExecutable(executable, platform)
  const version = InstalledVersionSchema.parse({
    version: staged.manifest.version,
    channel: staged.manifest.channel,
    target: staged.artifact.target,
    directory: finalDirectory,
    executable,
    sha256: executableFile.staged.sha256,
    evidenceStatus: staged.artifact.evidenceStatus,
    compatibility: {
      minimumWorkspaceSchema: staged.manifest.compatibility.minimumWorkspaceSchema,
      maximumWorkspaceSchema: staged.manifest.compatibility.maximumWorkspaceSchema,
      minimumLauncherSchema: staged.manifest.compatibility.minimumLauncherSchema,
      maximumLauncherSchema: staged.manifest.compatibility.maximumLauncherSchema,
    },
    files: staged.versionFiles.map((file) => ({
      path: join(finalDirectory, file.finalName),
      sha256: file.staged.sha256,
      sizeBytes: file.staged.sizeBytes,
      role: file.role,
    })),
    installedAt: timestamp(options),
  })
  return {
    operation: nextOperation(prepared, "activating", timestamp(options), {}, ["pendingRename"]),
    version,
  }
}

async function verifyInstalledVersion(
  version: InstalledVersion,
  allowMissing = false,
): Promise<void> {
  for (const file of version.files) {
    const information = await optionalLstat(file.path)
    if (!information && allowMissing) continue
    await verifyFile(file.path, file.sha256, file.sizeBytes)
  }
}

async function loadSelectedRelease(
  origin: InstallOrigin,
  options: DistributionRuntimeOptions,
): Promise<{ loaded: LoadedReleaseManifest; artifact: ReleaseArtifact; target: ReleaseTarget }> {
  const parsedOrigin = InstallOriginSchema.parse(origin)
  if (parsedOrigin.kind !== "standalone" && parsedOrigin.kind !== "local-artifact") {
    return rejectUnmanagedInstallOrigin(parsedOrigin)
  }
  const loaded = await loadReleaseManifest(parsedOrigin, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
  })
  const target = releaseTargetFor(options.platform, options.architecture)
  return { loaded, artifact: selectReleaseArtifact(loaded.manifest, target), target }
}

function historyPaths(layout: StandaloneInstallLayout, operationId: string): string[] {
  const root = join(layout.rollback, operationId)
  return [root, join(root, "operation.json"), join(root, "current.before.json")]
}

export function installOriginFromManifest(value: string): InstallOrigin {
  const windowsDrivePath = /^[A-Za-z]:[\\/]/u.test(value)
  const windowsUncPath = /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)
  if (windowsDrivePath || windowsUncPath) {
    return { kind: "local-artifact", manifestPath: resolve(value) }
  }
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw distributionError(
        "RALPH_RELEASE_MANIFEST_URL_FORBIDDEN",
        "Remote release manifest must use HTTPS without credentials, query or fragment",
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    return { kind: "standalone", manifestUrl: url.toString() }
  } catch (error) {
    if (error instanceof RalphError) throw error
    return { kind: "local-artifact", manifestPath: resolve(value) }
  }
}

async function installStandaloneUnlocked(
  input: StandaloneInstallRequest,
): Promise<DistributionPlan | DistributionMutationResult> {
  const platform = input.platform ?? process.platform
  const layout = await canonicalLayout(input.installRoot, platform)
  const origin = InstallOriginSchema.parse(input.origin)
  if (origin.kind !== "standalone" && origin.kind !== "local-artifact") {
    return rejectUnmanagedInstallOrigin(origin)
  }
  if (input.dryRun) {
    return {
      action: "install",
      installRoot: layout.root,
      origin,
      ...(input.expectedVersion ? { requestedVersion: input.expectedVersion } : {}),
      ...(input.expectedChannel ? { channel: input.expectedChannel } : {}),
      mutationPerformed: false,
      runningBinaryReplaced: false,
      launcherMutation: "install",
    }
  }
  const recovery = await recoverLayoutOperations(layout, input)
  const repair = recovery.find((entry) => entry.disposition === "repair-required")
  if (repair) {
    throw distributionError(
      "RALPH_INSTALL_LAUNCHER_REPAIR_REQUIRED",
      `A verified update is waiting for explicit launcher repair: ${repair.operationId}`,
      {
        exitCode: EXIT_CODES.blocked,
        file: layout.root,
        hint: "Use the identified installation's repair/uninstall path; a fresh install never discards verified staging implicitly.",
      },
    )
  }
  await initializeFreshLayout(layout)
  let operation = await createOperation(layout, "install", input)
  await injectDistributionFault(input, operation, "planned")
  try {
    const selected = await loadSelectedRelease(origin, input)
    validateReleaseSelection(selected.loaded.manifest, selected.artifact, input)
    operation = nextOperation(operation, "staged", timestamp(input), {
      requestedVersion: selected.loaded.manifest.version,
      target: selected.target,
    })
    await persistOperation(operation)
    await injectDistributionFault(input, operation, "staged")
    const staged = await stageRelease(operation, selected.loaded, selected.artifact, input)
    operation = nextOperation(operation, "verified", timestamp(input), {
      stagedPaths: [
        ...operation.stagedPaths,
        staged.launcher.path,
        ...staged.versionFiles.map((file) => file.staged.path),
      ],
    })
    await persistOperation(operation)
    await injectDistributionFault(input, operation, "verified")
    const materialized = await materializeVersion(layout, operation, staged, platform, input)
    operation = materialized.operation
    await persistOperation(operation)
    operation = nextOperation(operation, "installing-launcher", timestamp(input), {
      pendingRename: {
        kind: "launcher",
        source: staged.launcher.path,
        destination: layout.launcher,
      },
      materializedPaths: [...operation.materializedPaths, layout.launcher],
    })
    await persistOperation(operation)
    await rename(staged.launcher.path, layout.launcher)
    await syncRenameParents(staged.launcher.path, layout.launcher, platform)
    await makeExecutable(layout.launcher, platform)
    operation = nextOperation(operation, "activating", timestamp(input), {}, ["pendingRename"])
    await persistOperation(operation)
    const installId = randomUUID()
    const now = timestamp(input)
    const generation = 1
    const receiptPath = immutableReceiptPath(layout, installId, generation)
    const history = historyPaths(layout, operation.operationId).slice(0, 2)
    const receipt = InstallReceiptSchema.parse({
      schemaVersion: 1,
      installId,
      product: "ralph-next",
      generation,
      installRoot: layout.root,
      origin,
      channel: staged.manifest.channel,
      currentVersion: staged.manifest.version,
      currentTarget: staged.artifact.target,
      currentExecutable: materialized.version.executable,
      launcher: {
        schemaVersion: 1,
        executable: layout.launcher,
        sha256: staged.launcher.sha256,
        installedAt: now,
      },
      durability: installDurability(platform),
      versions: [materialized.version],
      managedPaths: managedPaths(layout, [materialized.version], [...history, receiptPath]),
      createdAt: now,
      updatedAt: now,
    })
    operation = nextOperation(operation, "activating", now, { installId })
    await persistOperation(operation)
    const control = await persistControlState(layout, operation, receipt, now)
    operation = nextOperation(control.operation, "activated", now, {}, [
      "pendingReceiptPath",
      "pendingReceiptSha256",
    ])
    await persistOperation(operation)
    await injectDistributionFault(input, operation, "activated")
    await finalizeOperationHistory(layout, operation, input)
    return {
      action: "install",
      operationId: operation.operationId,
      installRoot: layout.root,
      currentVersion: receipt.currentVersion,
      target: receipt.currentTarget,
      channel: receipt.channel,
      receiptPath: control.receiptPath,
      pointerPath: layout.currentPointer,
      launcherPath: layout.launcher,
      mutationPerformed: true,
      runningBinaryReplaced: false,
      launcherMutation: "install",
      preserved: ["workspace-state", "global-config", "credentials"],
    }
  } catch (error) {
    if (error instanceof DistributionFaultInterruption) throw error
    operation = await readOperation(operationPath(operation)).catch(() => operation)
    if (await controlsSelectVersion(layout, operation.requestedVersion)) {
      const state = await readControlState(layout)
      const committed = nextOperation(operation, "activated", timestamp(input), {}, [
        "pendingRename",
        "pendingReceiptPath",
        "pendingReceiptSha256",
        "failure",
      ])
      await finalizeOperationHistory(layout, committed, input)
      return {
        action: "install",
        operationId: committed.operationId,
        installRoot: layout.root,
        currentVersion: state.receipt.currentVersion,
        target: state.receipt.currentTarget,
        channel: state.receipt.channel,
        receiptPath: state.receiptPath,
        pointerPath: layout.currentPointer,
        launcherPath: layout.launcher,
        mutationPerformed: true,
        runningBinaryReplaced: false,
        launcherMutation: "install",
        preserved: ["workspace-state", "global-config", "credentials"],
      }
    }
    const failed = nextOperation(operation, "failed", timestamp(input), {
      failure: {
        code: error instanceof RalphError ? error.code : "RALPH_INSTALL_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    })
    await persistOperation(failed).catch(() => undefined)
    for (const path of [...failed.materializedPaths].reverse()) {
      if (pathInside(layout.root, path))
        await removeOwnedTree(path, layout.root).catch(() => undefined)
    }
    if (failed.pendingReceiptPath) {
      await unlink(failed.pendingReceiptPath).catch(() => undefined)
    }
    await unlink(layout.currentPointer).catch(() => undefined)
    throw error
  }
}

async function checkStandaloneUpdateUnlocked(
  input: StandaloneUpdateRequest,
): Promise<UpdateCheckResult> {
  const platform = input.platform ?? process.platform
  const { layout, receipt } = await openIdentifiedLayout(input.installRoot, platform)
  const recovery = await recoverLayoutOperations(layout, input)
  const blocking = recovery.find(
    (entry) =>
      entry.disposition === "repair-required" || entry.disposition === "uninstall-resume-required",
  )
  if (blocking) {
    throw distributionError(
      "RALPH_INSTALL_RECOVERY_REQUIRED",
      `Update preflight is blocked by operation ${blocking.operationId} (${blocking.disposition})`,
      { exitCode: EXIT_CODES.blocked, file: layout.root },
    )
  }
  const origin = InstallOriginSchema.parse(input.origin ?? receipt.origin)
  let operation = await createOperation(layout, "update", input, {
    installId: receipt.installId,
    previousVersion: receipt.currentVersion,
  })
  try {
    const selected = await loadSelectedRelease(origin, input)
    validateReleaseSelection(selected.loaded.manifest, selected.artifact, {
      ...input,
      currentReceipt: receipt,
    })
    operation = nextOperation(operation, "staged", timestamp(input), {
      requestedVersion: selected.loaded.manifest.version,
      target: selected.target,
    })
    await persistOperation(operation)
    const staged = await stageRelease(operation, selected.loaded, selected.artifact, input)
    operation = nextOperation(operation, "verified", timestamp(input), {
      stagedPaths: [
        ...operation.stagedPaths,
        staged.launcher.path,
        ...staged.versionFiles.map((file) => file.staged.path),
      ],
    })
    await persistOperation(operation)
    const signatureVerified = selected.loaded.manifest.signature.status === "present"
    const result: UpdateCheckResult = {
      action: "update",
      installRoot: layout.root,
      currentVersion: receipt.currentVersion,
      requestedVersion: selected.loaded.manifest.version,
      target: selected.target,
      channel: selected.loaded.manifest.channel,
      origin,
      available: compareSemver(selected.loaded.manifest.version, receipt.currentVersion) !== 0,
      evidenceStatus: selected.artifact.evidenceStatus,
      evidenceTrust: signatureVerified ? "signature-verified" : "declared-unverified",
      authenticity: signatureVerified ? "signature-verified" : "unsigned-integrity-verified",
      limitations: selected.artifact.limitations,
      mutationPerformed: false,
      runningBinaryReplaced: false,
      launcherMutation: "preserve",
    }
    await removeOwnedTree(operation.stagingRoot, layout.staging)
    return result
  } catch (error) {
    operation = await readOperation(operationPath(operation)).catch(() => operation)
    await removeOwnedTree(operation.stagingRoot, layout.staging).catch(() => undefined)
    throw error
  }
}

async function updateStandaloneUnlocked(
  input: StandaloneUpdateRequest,
): Promise<DistributionPlan | UpdateCheckResult | DistributionMutationResult> {
  if (input.checkOnly) return checkStandaloneUpdateUnlocked(input)
  const platform = input.platform ?? process.platform
  const recoveryLayout = await canonicalLayout(input.installRoot, platform)
  if (!input.dryRun) {
    const recovery = await recoverLayoutOperations(recoveryLayout, input)
    const blocking = recovery.find(
      (entry) =>
        entry.disposition === "repair-required" ||
        entry.disposition === "uninstall-resume-required",
    )
    if (blocking) {
      throw distributionError(
        blocking.disposition === "repair-required"
          ? "RALPH_INSTALL_LAUNCHER_REPAIR_REQUIRED"
          : "RALPH_INSTALL_UNINSTALL_RESUME_REQUIRED",
        blocking.disposition === "repair-required"
          ? `A verified update is waiting for explicit launcher repair: ${blocking.operationId}`
          : `An interrupted uninstall must be resumed before update: ${blocking.operationId}`,
        { exitCode: EXIT_CODES.blocked, file: recoveryLayout.root },
      )
    }
  }
  const { layout, receipt: currentReceipt } = await openIdentifiedLayout(
    input.installRoot,
    platform,
  )
  const origin = InstallOriginSchema.parse(input.origin ?? currentReceipt.origin)
  if (origin.kind !== "standalone" && origin.kind !== "local-artifact") {
    return rejectUnmanagedInstallOrigin(origin)
  }
  if (input.dryRun) {
    return {
      action: "update",
      installRoot: layout.root,
      currentVersion: currentReceipt.currentVersion,
      origin,
      ...(input.expectedVersion ? { requestedVersion: input.expectedVersion } : {}),
      ...(input.expectedChannel ? { channel: input.expectedChannel } : {}),
      mutationPerformed: false,
      runningBinaryReplaced: false,
      launcherMutation: "preserve",
    }
  }
  let operation = await createOperation(layout, "update", input, {
    installId: currentReceipt.installId,
    previousVersion: currentReceipt.currentVersion,
  })
  await injectDistributionFault(input, operation, "planned")
  try {
    const selected = await loadSelectedRelease(origin, input)
    validateReleaseSelection(selected.loaded.manifest, selected.artifact, {
      ...input,
      currentReceipt,
    })
    if (selected.loaded.manifest.version === currentReceipt.currentVersion) {
      throw distributionError(
        "RALPH_RELEASE_ALREADY_CURRENT",
        `Standalone installation is already at ${currentReceipt.currentVersion}`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    if (
      currentReceipt.versions.some((entry) => entry.version === selected.loaded.manifest.version)
    ) {
      throw distributionError(
        "RALPH_INSTALL_VERSION_ALREADY_PRESENT",
        `Version is already materialized; use rollback to activate it: ${selected.loaded.manifest.version}`,
        { exitCode: EXIT_CODES.conflict },
      )
    }
    operation = nextOperation(operation, "staged", timestamp(input), {
      requestedVersion: selected.loaded.manifest.version,
      target: selected.target,
    })
    await persistOperation(operation)
    await injectDistributionFault(input, operation, "staged")
    const staged = await stageRelease(operation, selected.loaded, selected.artifact, input)
    operation = nextOperation(operation, "verified", timestamp(input), {
      stagedPaths: [
        ...operation.stagedPaths,
        staged.launcher.path,
        ...staged.versionFiles.map((file) => file.staged.path),
      ],
    })
    await persistOperation(operation)
    await injectDistributionFault(input, operation, "verified")
    if (
      CURRENT_LAUNCHER_SCHEMA < selected.loaded.manifest.compatibility.minimumLauncherSchema ||
      CURRENT_LAUNCHER_SCHEMA > selected.loaded.manifest.compatibility.maximumLauncherSchema
    ) {
      operation = nextOperation(operation, "repair-required", timestamp(input), {
        launcherMutation: "repair-required",
      })
      await persistOperation(operation)
      throw distributionError(
        "RALPH_INSTALL_LAUNCHER_REPAIR_REQUIRED",
        `Release ${selected.loaded.manifest.version} requires launcher schema ${selected.loaded.manifest.compatibility.minimumLauncherSchema}..${selected.loaded.manifest.compatibility.maximumLauncherSchema}; installed launcher schema is ${CURRENT_LAUNCHER_SCHEMA}`,
        {
          exitCode: EXIT_CODES.blocked,
          file: operation.stagingRoot,
          hint: "The verified engine remains staged. Exit the launcher and perform an explicit repair/reinstall; the running launcher was not overwritten.",
        },
      )
    }
    operation = await snapshotControls(layout, operation, input)
    await persistOperation(operation)
    const materialized = await materializeVersion(layout, operation, staged, platform, input)
    operation = materialized.operation
    await persistOperation(operation)
    const now = timestamp(input)
    const versions = [...currentReceipt.versions, materialized.version]
    const generation = currentReceipt.generation + 1
    const receiptPath = immutableReceiptPath(layout, currentReceipt.installId, generation)
    const history = historyPaths(layout, operation.operationId)
    const receipt = InstallReceiptSchema.parse({
      ...currentReceipt,
      generation,
      origin,
      channel: selected.loaded.manifest.channel,
      currentVersion: materialized.version.version,
      currentTarget: materialized.version.target,
      currentExecutable: materialized.version.executable,
      previousVersion: currentReceipt.currentVersion,
      durability: installDurability(platform),
      versions,
      managedPaths: managedPaths(layout, versions, [
        ...currentReceipt.managedPaths,
        ...history,
        receiptPath,
      ]),
      updatedAt: now,
    })
    let control: Awaited<ReturnType<typeof persistControlState>>
    try {
      control = await persistControlState(layout, operation, receipt, now)
    } catch (error) {
      operation = await readOperation(operationPath(operation)).catch(() => operation)
      await restoreControlSnapshot(layout, operation)
      throw error
    }
    operation = nextOperation(control.operation, "activated", now, {}, [
      "pendingReceiptPath",
      "pendingReceiptSha256",
    ])
    await persistOperation(operation)
    await injectDistributionFault(input, operation, "activated")
    await finalizeOperationHistory(layout, operation, input)
    return {
      action: "update",
      operationId: operation.operationId,
      installRoot: layout.root,
      previousVersion: currentReceipt.currentVersion,
      currentVersion: receipt.currentVersion,
      target: receipt.currentTarget,
      channel: receipt.channel,
      receiptPath: control.receiptPath,
      pointerPath: layout.currentPointer,
      launcherPath: layout.launcher,
      mutationPerformed: true,
      runningBinaryReplaced: false,
      launcherMutation: "preserve",
      preserved: ["workspace-state", "global-config", "credentials"],
    }
  } catch (error) {
    if (error instanceof DistributionFaultInterruption) throw error
    operation = await readOperation(operationPath(operation)).catch(() => operation)
    if (operation.status !== "repair-required") {
      if (await controlsSelectVersion(layout, operation.requestedVersion)) {
        const state = await readControlState(layout)
        const committed = nextOperation(operation, "activated", timestamp(input), {}, [
          "pendingRename",
          "pendingReceiptPath",
          "pendingReceiptSha256",
          "failure",
        ])
        await finalizeOperationHistory(layout, committed, input)
        return {
          action: "update",
          operationId: committed.operationId,
          installRoot: layout.root,
          previousVersion: currentReceipt.currentVersion,
          currentVersion: state.receipt.currentVersion,
          target: state.receipt.currentTarget,
          channel: state.receipt.channel,
          receiptPath: state.receiptPath,
          pointerPath: layout.currentPointer,
          launcherPath: layout.launcher,
          mutationPerformed: true,
          runningBinaryReplaced: false,
          launcherMutation: "preserve",
          preserved: ["workspace-state", "global-config", "credentials"],
        }
      }
      const failed = nextOperation(operation, "failed", timestamp(input), {
        failure: {
          code: error instanceof RalphError ? error.code : "RALPH_UPDATE_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      })
      await persistOperation(failed).catch(() => undefined)
      if (failed.rollbackPointerPath) {
        await restoreControlSnapshot(layout, failed).catch(() => undefined)
      }
      if (failed.pendingReceiptPath) {
        await unlink(failed.pendingReceiptPath).catch(() => undefined)
      }
      for (const path of [...failed.materializedPaths].reverse()) {
        if (!currentReceipt.managedPaths.includes(path)) {
          await removeOwnedTree(path, layout.root).catch(() => undefined)
        }
      }
    }
    throw error
  }
}

async function rollbackStandaloneUnlocked(
  input: StandaloneRollbackRequest,
): Promise<DistributionPlan | DistributionMutationResult> {
  const platform = input.platform ?? process.platform
  if (!input.dryRun) {
    const recoveryLayout = await canonicalLayout(input.installRoot, platform)
    const recovery = await recoverLayoutOperations(recoveryLayout, {
      ...input,
      cleanupRepairRequired: true,
    })
    const uninstall = recovery.find((entry) => entry.disposition === "uninstall-resume-required")
    if (uninstall) {
      throw distributionError(
        "RALPH_INSTALL_UNINSTALL_RESUME_REQUIRED",
        `An interrupted uninstall must be resumed before rollback: ${uninstall.operationId}`,
        { exitCode: EXIT_CODES.blocked, file: recoveryLayout.root },
      )
    }
  }
  const { layout, receipt: currentReceipt } = await openIdentifiedLayout(
    input.installRoot,
    platform,
  )
  const requestedVersion = input.version ?? currentReceipt.previousVersion
  if (!requestedVersion) {
    throw distributionError(
      "RALPH_INSTALL_ROLLBACK_VERSION_MISSING",
      "No previous version is recorded; select an installed version explicitly",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const target = currentReceipt.versions.find((entry) => entry.version === requestedVersion)
  if (!target) {
    throw distributionError(
      "RALPH_INSTALL_ROLLBACK_VERSION_UNKNOWN",
      `Version is not present in this install receipt: ${requestedVersion}`,
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  if (target.channel === "stable" && installDurability(platform).guarantee !== "full") {
    throw distributionError(
      "RALPH_RELEASE_STABLE_DURABILITY_UNAVAILABLE",
      `Rollback cannot activate stable with reduced directory durability on ${platform}`,
      { exitCode: EXIT_CODES.blocked },
    )
  }
  const workspaceSchema = input.workspaceSchema ?? CURRENT_WORKSPACE_SCHEMA
  if (
    workspaceSchema < target.compatibility.minimumWorkspaceSchema ||
    workspaceSchema > target.compatibility.maximumWorkspaceSchema
  ) {
    throw distributionError(
      "RALPH_INSTALL_ROLLBACK_SCHEMA_INCOMPATIBLE",
      `Version ${target.version} does not support workspace schema ${workspaceSchema}`,
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Restore a compatible state backup or choose a version whose manifest supports the current schema.",
      },
    )
  }
  await verifyInstalledVersion(target)
  if (input.dryRun) {
    return {
      action: "rollback",
      installRoot: layout.root,
      currentVersion: currentReceipt.currentVersion,
      requestedVersion: target.version,
      target: target.target,
      channel: target.channel,
      mutationPerformed: false,
      runningBinaryReplaced: false,
      launcherMutation: "none",
    }
  }
  let operation = await createOperation(layout, "rollback", input, {
    installId: currentReceipt.installId,
    requestedVersion: target.version,
    previousVersion: currentReceipt.currentVersion,
    target: target.target,
  })
  try {
    operation = await snapshotControls(layout, operation, input)
    operation = nextOperation(operation, "rolling-back", timestamp(input))
    await persistOperation(operation)
    const now = timestamp(input)
    const generation = currentReceipt.generation + 1
    const receiptPath = immutableReceiptPath(layout, currentReceipt.installId, generation)
    const history = historyPaths(layout, operation.operationId)
    const receipt = InstallReceiptSchema.parse({
      ...currentReceipt,
      generation,
      channel: target.channel,
      currentVersion: target.version,
      currentTarget: target.target,
      currentExecutable: target.executable,
      previousVersion: currentReceipt.currentVersion,
      durability: installDurability(platform),
      managedPaths: managedPaths(layout, currentReceipt.versions, [
        ...currentReceipt.managedPaths,
        ...history,
        receiptPath,
      ]),
      updatedAt: now,
    })
    let control: Awaited<ReturnType<typeof persistControlState>>
    try {
      control = await persistControlState(layout, operation, receipt, now)
    } catch (error) {
      operation = await readOperation(operationPath(operation)).catch(() => operation)
      await restoreControlSnapshot(layout, operation)
      throw error
    }
    operation = nextOperation(control.operation, "rolled-back", now, {}, [
      "pendingReceiptPath",
      "pendingReceiptSha256",
    ])
    await persistOperation(operation)
    await finalizeOperationHistory(layout, operation, input)
    return {
      action: "rollback",
      operationId: operation.operationId,
      installRoot: layout.root,
      previousVersion: currentReceipt.currentVersion,
      currentVersion: target.version,
      target: target.target,
      channel: target.channel,
      receiptPath: control.receiptPath,
      pointerPath: layout.currentPointer,
      launcherPath: layout.launcher,
      mutationPerformed: true,
      runningBinaryReplaced: false,
      launcherMutation: "none",
      preserved: ["workspace-state", "global-config", "credentials"],
    }
  } catch (error) {
    operation = await readOperation(operationPath(operation)).catch(() => operation)
    if (await controlsSelectVersion(layout, operation.requestedVersion)) {
      const state = await readControlState(layout)
      const committed = nextOperation(operation, "rolled-back", timestamp(input), {}, [
        "pendingReceiptPath",
        "pendingReceiptSha256",
        "failure",
      ])
      await finalizeOperationHistory(layout, committed, input)
      return {
        action: "rollback",
        operationId: committed.operationId,
        installRoot: layout.root,
        previousVersion: currentReceipt.currentVersion,
        currentVersion: state.receipt.currentVersion,
        target: state.receipt.currentTarget,
        channel: state.receipt.channel,
        receiptPath: state.receiptPath,
        pointerPath: layout.currentPointer,
        launcherPath: layout.launcher,
        mutationPerformed: true,
        runningBinaryReplaced: false,
        launcherMutation: "none",
        preserved: ["workspace-state", "global-config", "credentials"],
      }
    }
    const failed = nextOperation(operation, "failed", timestamp(input), {
      failure: {
        code: error instanceof RalphError ? error.code : "RALPH_ROLLBACK_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    })
    await persistOperation(failed).catch(() => undefined)
    if (failed.rollbackPointerPath) {
      await restoreControlSnapshot(layout, failed).catch(() => undefined)
    }
    if (failed.pendingReceiptPath) {
      await unlink(failed.pendingReceiptPath).catch(() => undefined)
    }
    throw error
  }
}

async function collectTreePaths(root: string): Promise<string[]> {
  const output: string[] = []
  const visit = async (path: string): Promise<void> => {
    const information = await lstat(path)
    if (information.isSymbolicLink()) {
      throw distributionError(
        "RALPH_INSTALL_UNINSTALL_SYMLINK_REFUSED",
        `Uninstall refuses symbolic links in the managed install root: ${path}`,
        { exitCode: EXIT_CODES.policyDenied, file: path },
      )
    }
    output.push(path)
    if (!information.isDirectory()) return
    for (const entry of await readdir(path)) await visit(resolve(path, entry))
  }
  for (const entry of await readdir(root)) await visit(resolve(root, entry))
  return output
}

function pathOrSame(parent: string, candidate: string): boolean {
  return resolve(parent) === resolve(candidate) || pathInside(resolve(parent), resolve(candidate))
}

function preservedPathClosure(
  layout: StandaloneInstallLayout,
  preserved: readonly string[],
): Set<string> {
  const closure = new Set<string>()
  for (const requested of preserved) {
    let current = assertManagedInstallPath(layout, requested)
    while (current !== layout.root) {
      closure.add(current)
      current = dirname(current)
    }
  }
  return closure
}

async function assertUninstallSnapshotOwned(
  layout: StandaloneInstallLayout,
  receipt: InstallReceipt,
  observed: readonly string[],
): Promise<void> {
  const allowed = new Set(
    receipt.managedPaths.map((path) => assertManagedInstallPath(layout, path)),
  )
  const unknown = observed.filter((path) => !allowed.has(path))
  const firstUnknown = unknown[0]
  if (firstUnknown !== undefined) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_UNKNOWN_PATH",
      "Uninstall found files that are not owned by the install receipt",
      {
        exitCode: EXIT_CODES.conflict,
        file: firstUnknown,
        hint: "Move or inspect the unowned files; --force never broadens receipt ownership.",
        details: { unknown: unknown.slice(0, 32), truncated: unknown.length > 32 },
      },
    )
  }
}

async function removeRecordedUninstallPaths(
  layout: StandaloneInstallLayout,
  recorded: readonly string[],
  preserve: readonly string[] = [],
): Promise<void> {
  const preserved = preservedPathClosure(layout, preserve)
  const unique = new Set(recorded.map((path) => assertManagedInstallPath(layout, path)))
  const paths = [...unique]
    .filter((path) => !preserved.has(path))
    .sort((left, right) => right.split(/[\\/]/u).length - left.split(/[\\/]/u).length)
  for (const path of paths) {
    const information = await optionalLstat(path)
    if (!information) continue
    if (information.isDirectory()) await rmdir(path)
    else if (information.isFile()) await unlink(path)
    else {
      throw distributionError(
        "RALPH_INSTALL_UNINSTALL_SPECIAL_FILE_REFUSED",
        `Uninstall refuses a non-regular managed path: ${path}`,
        { exitCode: EXIT_CODES.policyDenied, file: path },
      )
    }
  }
}

async function readBoundImmutableReceipt(
  layout: StandaloneInstallLayout,
  path: string,
  expectedSha256: string,
): Promise<InstallReceipt> {
  const receiptPath = assertManagedInstallPath(layout, path)
  if (!pathInside(layout.receipts, receiptPath)) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_RECEIPT_ESCAPE",
      `Deferred uninstall receipt escapes receipts/: ${receiptPath}`,
      { exitCode: EXIT_CODES.policyDenied, file: receiptPath },
    )
  }
  const bytes = await readRegularBytes(receiptPath)
  const actualSha256 = createHash("sha256").update(bytes).digest("hex")
  if (actualSha256 !== expectedSha256) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_RECEIPT_HASH_MISMATCH",
      "Deferred uninstall receipt bytes do not match their authenticated handoff",
      {
        exitCode: EXIT_CODES.conflict,
        file: receiptPath,
        details: { expectedSha256, actualSha256 },
      },
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_RECEIPT_INVALID",
      `Deferred uninstall receipt is not valid UTF-8 JSON: ${receiptPath}`,
      { exitCode: EXIT_CODES.conflict, file: receiptPath, cause: error },
    )
  }
  return validateInstallReceiptPaths(raw, layout.root, receiptPath)
}

function assertDeferredOperationBinding(
  operation: DistributionOperation,
  request: DeferredUninstallRequest,
): void {
  const tokenSha256 = createHash("sha256").update(request.handoffToken).digest("hex")
  if (
    operation.action !== "uninstall" ||
    operation.deferredRequestId !== request.requestId ||
    operation.deferredHandoffTokenSha256 !== tokenSha256 ||
    resolve(operation.handoffReceiptPath ?? "") !== resolve(request.receiptPath) ||
    operation.handoffReceiptSha256 !== request.receiptSha256 ||
    operation.installId !== request.installId ||
    operation.previousVersion !== request.currentVersion ||
    operation.target !== request.target
  ) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_HANDOFF_DIVERGED",
      "Interrupted uninstall journal does not match the authenticated deferred handoff",
      { exitCode: EXIT_CODES.conflict, file: operationPath(operation) },
    )
  }
}

async function interruptedUninstallOperation(
  layout: StandaloneInstallLayout,
  options: DistributionRuntimeOptions,
): Promise<DistributionOperation | undefined> {
  const recovery = await recoverLayoutOperations(layout, options)
  const interrupted = recovery.filter((entry) => entry.disposition === "uninstall-resume-required")
  if (interrupted.length > 1) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_MULTIPLE_JOURNALS",
      "More than one interrupted uninstall journal exists for this install root",
      { exitCode: EXIT_CODES.conflict, file: layout.staging },
    )
  }
  if (interrupted.length === 0) return undefined
  return readOperation(join(layout.staging, interrupted[0]!.operationId, "operation.json"))
}

async function cleanupDeferredUninstallUnlocked(
  request: DeferredUninstallRequest,
  options: DistributionRuntimeOptions,
): Promise<DistributionMutationResult> {
  const layout = await canonicalLayout(request.installRoot, options.platform ?? process.platform)
  if (layout.root !== resolve(request.installRoot)) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_ROOT_NOT_CANONICAL",
      "Deferred uninstall root changed after handoff",
      { exitCode: EXIT_CODES.conflict, file: request.installRoot },
    )
  }
  let operation = await interruptedUninstallOperation(layout, options)
  if (operation) assertDeferredOperationBinding(operation, request)

  const pointerAvailable = await optionalLstat(layout.currentPointer)
  let state = pointerAvailable ? await readControlState(layout) : undefined
  if (!operation) {
    if (!state) {
      throw distributionError(
        "RALPH_INSTALL_UNINSTALL_CONTROL_STATE_MISSING",
        "Deferred uninstall has neither an atomic current pointer nor a resumable journal",
        { exitCode: EXIT_CODES.conflict, file: layout.root },
      )
    }
    if (
      state.receipt.installId !== request.installId ||
      state.receipt.generation !== request.generation ||
      state.receipt.currentVersion !== request.currentVersion ||
      state.receipt.currentTarget !== request.target ||
      resolve(state.receiptPath) !== resolve(request.receiptPath) ||
      state.pointer.receiptSha256 !== request.receiptSha256
    ) {
      throw distributionError(
        "RALPH_INSTALL_UNINSTALL_STATE_CHANGED",
        "Installed control state changed after deferred uninstall was scheduled",
        { exitCode: EXIT_CODES.conflict, file: layout.currentPointer },
      )
    }
    const handoffReceipt = await readBoundImmutableReceipt(
      layout,
      request.receiptPath,
      request.receiptSha256,
    )
    await verifyFile(layout.launcher, handoffReceipt.launcher.sha256)
    for (const version of handoffReceipt.versions) await verifyInstalledVersion(version)
    await inspectRalphAliasSnapshot(layout, state, options.platform ?? process.platform)
    const tokenSha256 = createHash("sha256").update(request.handoffToken).digest("hex")
    operation = await createOperation(layout, "uninstall", options, {
      installId: handoffReceipt.installId,
      previousVersion: handoffReceipt.currentVersion,
      target: handoffReceipt.currentTarget,
      deferredRequestId: request.requestId,
      deferredHandoffTokenSha256: tokenSha256,
      handoffReceiptPath: request.receiptPath,
      handoffReceiptSha256: request.receiptSha256,
    })
    const now = timestamp(options)
    const generation = handoffReceipt.generation + 1
    const receiptPath = immutableReceiptPath(layout, handoffReceipt.installId, generation)
    const uninstallReceipt = InstallReceiptSchema.parse({
      ...handoffReceipt,
      generation,
      durability: installDurability(options.platform ?? process.platform),
      managedPaths: managedPaths(layout, handoffReceipt.versions, [
        ...handoffReceipt.managedPaths,
        operation.stagingRoot,
        operationPath(operation),
        receiptPath,
      ]),
      updatedAt: now,
    })
    const control = await persistControlState(layout, operation, uninstallReceipt, now)
    operation = nextOperation(control.operation, "uninstalling", now)
    await persistOperation(operation)
    state = await readControlState(layout)
  }

  assertDeferredOperationBinding(operation, request)
  let activeReceipt: InstallReceipt | undefined
  let activeReceiptPath = operation.pendingReceiptPath
  if (state && state.receipt.installId === request.installId) {
    activeReceipt = state.receipt
    activeReceiptPath = state.receiptPath
  } else if (operation.pendingReceiptPath && operation.pendingReceiptSha256) {
    if (await optionalLstat(operation.pendingReceiptPath)) {
      activeReceipt = await readBoundImmutableReceipt(
        layout,
        operation.pendingReceiptPath,
        operation.pendingReceiptSha256,
      )
    }
  }

  if (operation.uninstallPaths.length === 0) {
    if (!activeReceipt || !activeReceiptPath) {
      throw distributionError(
        "RALPH_INSTALL_UNINSTALL_SNAPSHOT_MISSING",
        "Uninstall cannot resume because both its owned-path snapshot and active receipt are missing",
        { exitCode: EXIT_CODES.conflict, file: operationPath(operation) },
      )
    }
    const observed = await collectTreePaths(layout.root)
    await assertUninstallSnapshotOwned(layout, activeReceipt, observed)
    operation = nextOperation(operation, "uninstalling", timestamp(options), {
      uninstallPaths: observed,
    })
    await persistOperation(operation)
  }

  const activeControlPaths = [
    layout.currentPointer,
    ...(activeReceiptPath ? [activeReceiptPath] : []),
    request.receiptPath,
    operationPath(operation),
    operation.stagingRoot,
    layout.staging,
  ]
  if (activeReceipt) {
    const observed = await collectTreePaths(layout.root)
    await assertUninstallSnapshotOwned(layout, activeReceipt, observed)
    const recorded = new Set(operation.uninstallPaths.map((path) => resolve(path)))
    const unrecorded = observed.filter((path) => !recorded.has(resolve(path)))
    const firstUnrecorded = unrecorded[0]
    if (firstUnrecorded !== undefined) {
      throw distributionError(
        "RALPH_INSTALL_UNINSTALL_TREE_CHANGED",
        "Managed install tree changed after the uninstall write-ahead snapshot",
        {
          exitCode: EXIT_CODES.conflict,
          file: firstUnrecorded,
          details: { unrecorded: unrecorded.slice(0, 32) },
        },
      )
    }
  }

  await removeRecordedUninstallPaths(layout, operation.uninstallPaths, activeControlPaths)
  operation = nextOperation(operation, "removing-control-state", timestamp(options))
  await persistOperation(operation)

  await unlink(layout.currentPointer).catch((error: unknown) => {
    if (!isMissing(error)) throw error
  })
  for (const receiptPath of new Set(
    [activeReceiptPath, request.receiptPath].filter((path): path is string => Boolean(path)),
  )) {
    await unlink(receiptPath).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  }
  await removeRecordedUninstallPaths(layout, operation.uninstallPaths)
  const rootInformation = await optionalLstat(layout.root)
  if (rootInformation) {
    await assertDirectory(layout.root)
    await rmdir(layout.root)
  }
  return {
    action: "uninstall",
    operationId: operation.operationId,
    installRoot: layout.root,
    previousVersion: request.currentVersion,
    target: request.target,
    mutationPerformed: true,
    runningBinaryReplaced: false,
    launcherMutation: "none",
    preserved: ["workspace-state", "global-config", "credentials"],
    cleanupDisposition: "completed",
  }
}

function deferredRequestPathIsAllowed(tempRoot: string, requestPath: string): boolean {
  const parent = dirname(requestPath)
  return (
    basename(requestPath) === "cleanup-request.json" &&
    dirname(parent) === tempRoot &&
    /^ralph-next-uninstall-[A-Za-z0-9_-]+$/u.test(basename(parent))
  )
}

async function waitForDeferredProcesses(request: DeferredUninstallRequest): Promise<void> {
  const deadline = Date.now() + request.maximumWaitMilliseconds
  for (const pid of request.waitForPids) {
    if (pid === process.pid) {
      throw distributionError(
        "RALPH_INSTALL_UNINSTALL_HELPER_SELF_WAIT",
        "Deferred uninstall helper was asked to wait for itself",
        { exitCode: EXIT_CODES.conflict },
      )
    }
    while (processLiveness(pid) !== "dead") {
      if (Date.now() >= deadline) {
        throw distributionError(
          "RALPH_INSTALL_UNINSTALL_WAIT_TIMEOUT",
          `Deferred cleanup did not observe PID ${pid} exit within its conservative wait window`,
          {
            exitCode: EXIT_CODES.blocked,
            hint: "The install was not modified. Inspect the PID before retrying the retained helper request.",
          },
        )
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 500))
    }
  }
}

export async function executeDeferredUninstallCleanup(input: {
  readonly requestPath: string
  readonly expectedSha256: string
  readonly handoffToken: string
  readonly platform?: NodeJS.Platform
}): Promise<DistributionMutationResult> {
  if (!/^[0-9a-f]{64}$/u.test(input.expectedSha256)) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_REQUEST_HASH_INVALID",
      "Deferred uninstall request hash must be lowercase SHA-256",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const lexicalTempRoot = resolve(tmpdir())
  const canonicalTempRoot = await realpath(lexicalTempRoot)
  const requestPath = resolve(input.requestPath)
  if (!deferredRequestPathIsAllowed(canonicalTempRoot, requestPath)) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_REQUEST_PATH_FORBIDDEN",
      "Deferred uninstall request must be cleanup-request.json in a direct Ralph-owned OS temp directory",
      { exitCode: EXIT_CODES.policyDenied, file: requestPath },
    )
  }
  const requestParent = await realpath(dirname(requestPath))
  if (
    !deferredRequestPathIsAllowed(canonicalTempRoot, join(requestParent, basename(requestPath)))
  ) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_REQUEST_PARENT_DIVERGED",
      "Deferred uninstall request parent resolves outside its Ralph-owned OS temp directory",
      { exitCode: EXIT_CODES.policyDenied, file: requestPath },
    )
  }
  const requestBytes = await readRegularBytes(requestPath)
  const requestSha256 = createHash("sha256").update(requestBytes).digest("hex")
  if (requestSha256 !== input.expectedSha256) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_REQUEST_TAMPERED",
      "Deferred uninstall request bytes do not match the foreground handoff hash",
      { exitCode: EXIT_CODES.conflict, file: requestPath },
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(requestBytes))
  } catch (error) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_REQUEST_INVALID",
      "Deferred uninstall request is not valid UTF-8 JSON",
      { exitCode: EXIT_CODES.conflict, file: requestPath, cause: error },
    )
  }
  const request = DeferredUninstallRequestSchema.parse(raw)
  if (request.handoffToken !== input.handoffToken) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_TOKEN_MISMATCH",
      "Deferred uninstall token does not match its foreground handoff",
      { exitCode: EXIT_CODES.conflict, file: requestPath },
    )
  }
  const layout = await canonicalLayout(request.installRoot, input.platform ?? process.platform)
  const helperExecutable = await realpath(process.execPath)
  if (pathOrSame(layout.root, helperExecutable)) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_HELPER_NOT_EXTERNAL",
      "Deferred uninstall helper is still executing from inside the install root",
      { exitCode: EXIT_CODES.blocked, file: helperExecutable },
    )
  }
  await waitForDeferredProcesses(request)
  const result = await withInstallLock(layout, "uninstall", input, () =>
    cleanupDeferredUninstallUnlocked(request, input),
  )
  await unlink(requestPath).catch(() => undefined)
  return result
}

async function uninstallStandaloneUnlocked(
  input: StandaloneUninstallRequest,
): Promise<DistributionPlan | DistributionMutationResult> {
  const platform = input.platform ?? process.platform
  const { layout, receipt } = await openIdentifiedLayout(input.installRoot, platform)
  const state = await readControlState(layout)
  await assertInstallStateConsistent(layout, receipt)
  if (input.dryRun) {
    return {
      action: "uninstall",
      installRoot: layout.root,
      currentVersion: receipt.currentVersion,
      target: receipt.currentTarget,
      channel: receipt.channel,
      mutationPerformed: false,
      runningBinaryReplaced: false,
      launcherMutation: "none",
    }
  }
  if (!input.deferredCleanup) {
    throw distributionError(
      "RALPH_INSTALL_UNINSTALL_HELPER_REQUIRED",
      "Standalone uninstall requires an external deferred-cleanup helper",
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Use the packaged Ralph CLI composition; it copies a bounded helper outside the install root before returning.",
      },
    )
  }
  const waitForPids = [...new Set([...(input.waitForPids ?? []), process.pid])]
  const request = DeferredUninstallRequestSchema.parse({
    schemaVersion: 1,
    requestId: randomUUID(),
    handoffToken: randomUUID(),
    installRoot: layout.root,
    installId: receipt.installId,
    generation: receipt.generation,
    receiptPath: state.receiptPath,
    receiptSha256: state.pointer.receiptSha256,
    currentVersion: receipt.currentVersion,
    target: receipt.currentTarget,
    waitForPids,
    createdByPid: process.pid,
    createdAt: timestamp(input),
    maximumWaitMilliseconds: 24 * 60 * 60 * 1_000,
  })
  const scheduled = await input.deferredCleanup.schedule(request)
  for (const [label, path] of [
    ["helper", scheduled.helperPath],
    ["request", scheduled.requestPath],
  ] as const) {
    if (pathOrSame(layout.root, resolve(path))) {
      throw distributionError(
        "RALPH_INSTALL_UNINSTALL_SCHEDULER_PATH_FORBIDDEN",
        `Deferred uninstall ${label} must be outside the install root`,
        { exitCode: EXIT_CODES.policyDenied, file: path },
      )
    }
  }
  return {
    action: "uninstall",
    operationId: request.requestId,
    installRoot: layout.root,
    previousVersion: receipt.currentVersion,
    target: receipt.currentTarget,
    channel: receipt.channel,
    mutationPerformed: true,
    runningBinaryReplaced: false,
    launcherMutation: "none",
    preserved: ["workspace-state", "global-config", "credentials"],
    cleanupDisposition: "scheduled",
    cleanupHelperPath: scheduled.helperPath,
    cleanupRequestPath: scheduled.requestPath,
  }
}

type RalphAliasSnapshot = {
  readonly status: RalphAliasStatus
  readonly receipt?: RalphAliasReceipt
}

function ralphAliasPaths(
  layout: StandaloneInstallLayout,
  platform: NodeJS.Platform,
): { aliasPath: string; aliasReceiptPath: string } {
  return {
    aliasPath: assertManagedInstallPath(
      layout,
      join(layout.bin, platform === "win32" ? "ralph.exe" : "ralph"),
    ),
    aliasReceiptPath: assertManagedInstallPath(
      layout,
      join(layout.receipts, RALPH_ALIAS_RECEIPT_NAME),
    ),
  }
}

function ralphAliasRemovalQuarantinePath(layout: StandaloneInstallLayout, target: string): string {
  return assertManagedInstallPath(
    layout,
    join(dirname(target), `.${basename(target)}.ralph-next-remove`),
  )
}

function sameRalphAliasFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertRalphAliasRemovalFile(
  path: string,
  information: Awaited<ReturnType<typeof lstat>>,
): void {
  if (information.isSymbolicLink() || !information.isFile() || information.nlink !== 1) {
    throw distributionError(
      "RALPH_ALIAS_REMOVE_PATH_INVALID",
      "Optional alias removal refuses symbolic links, hard-linked files or non-regular targets",
      {
        exitCode: EXIT_CODES.conflict,
        file: path,
        details: { observedLinkCount: information.nlink },
      },
    )
  }
}

type RalphAliasManagedDirectoryIdentity = {
  readonly path: string
  readonly dev: number
  readonly ino: number
}

function sameRalphAliasManagedPath(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const resolvedLeft = resolve(left)
  const resolvedRight = resolve(right)
  return platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight
}

async function captureRalphAliasManagedDirectory(
  path: string,
  platform: NodeJS.Platform,
): Promise<RalphAliasManagedDirectoryIdentity> {
  const target = resolve(path)
  const beforeRealpath = await lstat(target).catch((error: unknown) => {
    throw distributionError(
      "RALPH_ALIAS_MANAGED_DIRECTORY_UNAVAILABLE",
      `Optional alias managed directory is unavailable: ${target}`,
      { exitCode: EXIT_CODES.conflict, file: target, cause: error },
    )
  })
  if (beforeRealpath.isSymbolicLink() || !beforeRealpath.isDirectory()) {
    throw distributionError(
      "RALPH_ALIAS_MANAGED_DIRECTORY_INVALID",
      "Optional alias managed parent must be a real directory, not a symlink or junction",
      { exitCode: EXIT_CODES.conflict, file: target },
    )
  }
  const canonical = await realpath(target)
  if (!sameRalphAliasManagedPath(canonical, target, platform)) {
    throw distributionError(
      "RALPH_ALIAS_MANAGED_DIRECTORY_REDIRECTED",
      "Optional alias managed parent resolves outside its canonical install-root pathname",
      {
        exitCode: EXIT_CODES.conflict,
        file: target,
        details: { canonicalPath: canonical },
      },
    )
  }
  const afterRealpath = await lstat(target)
  if (
    afterRealpath.isSymbolicLink() ||
    !afterRealpath.isDirectory() ||
    beforeRealpath.dev !== afterRealpath.dev ||
    beforeRealpath.ino !== afterRealpath.ino
  ) {
    throw distributionError(
      "RALPH_ALIAS_MANAGED_DIRECTORY_CHANGED",
      "Optional alias managed parent changed identity during canonicalization",
      { exitCode: EXIT_CODES.conflict, file: target },
    )
  }
  return { path: target, dev: afterRealpath.dev, ino: afterRealpath.ino }
}

async function assertRalphAliasManagedDirectoryIdentity(
  expected: RalphAliasManagedDirectoryIdentity,
  platform: NodeJS.Platform,
): Promise<void> {
  const observed = await captureRalphAliasManagedDirectory(expected.path, platform)
  if (observed.dev !== expected.dev || observed.ino !== expected.ino) {
    throw distributionError(
      "RALPH_ALIAS_MANAGED_DIRECTORY_REPLACED",
      "Optional alias managed parent changed identity during mutation",
      { exitCode: EXIT_CODES.conflict, file: expected.path },
    )
  }
}

type RalphAliasManagedParents = {
  readonly bin: RalphAliasManagedDirectoryIdentity
  readonly receipts: RalphAliasManagedDirectoryIdentity
}

async function captureRalphAliasManagedParents(
  layout: StandaloneInstallLayout,
  platform: NodeJS.Platform,
): Promise<RalphAliasManagedParents> {
  const [bin, receipts] = await Promise.all([
    captureRalphAliasManagedDirectory(layout.bin, platform),
    captureRalphAliasManagedDirectory(layout.receipts, platform),
  ])
  return { bin, receipts }
}

async function assertRalphAliasManagedParents(
  expected: RalphAliasManagedParents,
  platform: NodeJS.Platform,
): Promise<void> {
  await Promise.all([
    assertRalphAliasManagedDirectoryIdentity(expected.bin, platform),
    assertRalphAliasManagedDirectoryIdentity(expected.receipts, platform),
  ])
}

async function verifyRalphAliasRemovalQuarantine(
  path: string,
  expectedSha256: string,
  maximumBytes: number,
  platform: NodeJS.Platform,
  expectedIdentity?: Awaited<ReturnType<typeof lstat>>,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const target = resolve(path)
  const beforeOpen = await lstat(target).catch((error: unknown) => {
    throw distributionError(
      "RALPH_ALIAS_REMOVE_QUARANTINE_UNAVAILABLE",
      `Optional alias removal quarantine is unavailable: ${target}`,
      { exitCode: EXIT_CODES.conflict, file: target, cause: error },
    )
  })
  assertRalphAliasRemovalFile(target, beforeOpen)
  if (expectedIdentity && !sameRalphAliasFileIdentity(beforeOpen, expectedIdentity)) {
    throw distributionError(
      "RALPH_ALIAS_REMOVE_IDENTITY_CHANGED",
      "Optional alias removal target changed identity while it was moved to quarantine",
      { exitCode: EXIT_CODES.conflict, file: target },
    )
  }

  const flags =
    platform === "win32" ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(target, flags)
  } catch (error) {
    throw distributionError(
      "RALPH_ALIAS_REMOVE_QUARANTINE_OPEN_FAILED",
      "Optional alias removal could not open the quarantined file without following links",
      { exitCode: EXIT_CODES.conflict, file: target, cause: error },
    )
  }

  try {
    const descriptor = await handle.stat()
    const boundPath = await lstat(target)
    assertRalphAliasRemovalFile(target, descriptor)
    assertRalphAliasRemovalFile(target, boundPath)
    if (
      !sameRalphAliasFileIdentity(descriptor, boundPath) ||
      (expectedIdentity && !sameRalphAliasFileIdentity(descriptor, expectedIdentity))
    ) {
      throw distributionError(
        "RALPH_ALIAS_REMOVE_QUARANTINE_REBOUND",
        "Optional alias removal quarantine was rebound to another file during verification",
        { exitCode: EXIT_CODES.conflict, file: target },
      )
    }
    if (descriptor.size <= 0 || descriptor.size > maximumBytes) {
      throw distributionError(
        "RALPH_ALIAS_REMOVE_QUARANTINE_SIZE_INVALID",
        "Optional alias removal quarantine has an invalid bounded size",
        {
          exitCode: EXIT_CODES.conflict,
          file: target,
          details: { sizeBytes: descriptor.size, maximumBytes },
        },
      )
    }

    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let position = 0
    while (true) {
      const read = await handle.read(buffer, 0, buffer.byteLength, position)
      if (read.bytesRead === 0) break
      hash.update(buffer.subarray(0, read.bytesRead))
      position += read.bytesRead
    }
    const observedSha256 = hash.digest("hex")
    if (observedSha256 !== expectedSha256.toLowerCase()) {
      throw distributionError(
        "RALPH_ALIAS_REMOVE_QUARANTINE_TAMPERED",
        "Optional alias removal quarantine does not match its ownership receipt",
        {
          exitCode: EXIT_CODES.conflict,
          file: target,
          details: { expectedSha256, observedSha256 },
        },
      )
    }
    return boundPath
  } finally {
    await handle.close()
  }
}

/**
 * Moves a receipt-bound file away from its public pathname, proves the moved
 * identity and bytes, and only then unlinks it. A substitution at the public
 * pathname is therefore moved for inspection rather than accidentally
 * deleted. The deterministic quarantine name also lets a later confirmed
 * remove resume after a crash between rename and unlink.
 */
async function removeRalphAliasFileThroughQuarantine(
  layout: StandaloneInstallLayout,
  path: string,
  expectedSha256: string,
  maximumBytes: number,
  platform: NodeJS.Platform,
): Promise<void> {
  const target = assertManagedInstallPath(layout, path)
  const quarantine = ralphAliasRemovalQuarantinePath(layout, target)
  if (dirname(target) !== dirname(quarantine)) {
    throw distributionError(
      "RALPH_ALIAS_REMOVE_QUARANTINE_PARENT_MISMATCH",
      "Optional alias removal quarantine must share the target managed parent",
      { exitCode: EXIT_CODES.conflict, file: quarantine },
    )
  }
  const parentIdentity = await captureRalphAliasManagedDirectory(dirname(target), platform)
  const targetInformation = await optionalLstat(target)
  const quarantineInformation = await optionalLstat(quarantine)
  if (targetInformation && quarantineInformation) {
    throw distributionError(
      "RALPH_ALIAS_REMOVE_QUARANTINE_COLLISION",
      "Optional alias removal found both the public target and its recovery quarantine",
      {
        exitCode: EXIT_CODES.conflict,
        file: quarantine,
        hint: "Preserve both paths for inspection; Ralph will not choose one or overwrite either.",
      },
    )
  }
  if (!targetInformation && !quarantineInformation) return

  let movedIdentity = quarantineInformation
  if (targetInformation) {
    assertRalphAliasRemovalFile(target, targetInformation)
    try {
      await assertRalphAliasManagedDirectoryIdentity(parentIdentity, platform)
      await rename(target, quarantine)
      movedIdentity = targetInformation
      await syncRenameParents(target, quarantine, platform)
      await assertRalphAliasManagedDirectoryIdentity(parentIdentity, platform)
    } catch (error) {
      throw distributionError(
        "RALPH_ALIAS_REMOVE_QUARANTINE_RENAME_FAILED",
        "Optional alias removal could not move the receipt-bound file to quarantine",
        { exitCode: EXIT_CODES.blocked, file: target, cause: error },
      )
    }
  }

  try {
    const verified = await verifyRalphAliasRemovalQuarantine(
      quarantine,
      expectedSha256,
      maximumBytes,
      platform,
      movedIdentity,
    )
    const immediatelyBeforeUnlink = await lstat(quarantine)
    assertRalphAliasRemovalFile(quarantine, immediatelyBeforeUnlink)
    if (!sameRalphAliasFileIdentity(verified, immediatelyBeforeUnlink)) {
      throw distributionError(
        "RALPH_ALIAS_REMOVE_QUARANTINE_CHANGED",
        "Optional alias removal quarantine changed after verification",
        { exitCode: EXIT_CODES.conflict, file: quarantine },
      )
    }
    await assertRalphAliasManagedDirectoryIdentity(parentIdentity, platform)
    await unlink(quarantine)
    await syncDirectoryAfterRename(dirname(quarantine), platform)
    await assertRalphAliasManagedDirectoryIdentity(parentIdentity, platform)
  } catch (error) {
    // Leave a proven or ambiguous quarantine in place. A later confirmed
    // remove binds it into a new preview hash and resumes cleanup. Portable
    // rename cannot restore without risking replacement of a public pathname
    // that appears concurrently.
    throw error
  }
}

function currentReceiptOwnsPath(receipt: InstallReceipt, path: string): boolean {
  return receipt.managedPaths.some((managed) => resolve(managed) === resolve(path))
}

async function readRalphAliasReceipt(
  layout: StandaloneInstallLayout,
  state: InstalledControlState,
  aliasPath: string,
  aliasReceiptPath: string,
): Promise<{ receipt: RalphAliasReceipt; sha256: string } | undefined> {
  const information = await optionalLstat(aliasReceiptPath)
  if (!information) return undefined
  if (information.isSymbolicLink() || !information.isFile() || information.nlink !== 1) {
    throw distributionError(
      "RALPH_ALIAS_RECEIPT_NOT_REGULAR",
      `Optional alias receipt must be a regular single-link file: ${aliasReceiptPath}`,
      {
        exitCode: EXIT_CODES.conflict,
        file: aliasReceiptPath,
        details: { observedLinkCount: information.nlink },
      },
    )
  }
  const bytes = await readRegularBytes(aliasReceiptPath, 64 * 1024)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch (error) {
    throw distributionError(
      "RALPH_ALIAS_RECEIPT_INVALID",
      `Optional alias receipt is not valid UTF-8 JSON: ${aliasReceiptPath}`,
      { exitCode: EXIT_CODES.conflict, file: aliasReceiptPath, cause: error },
    )
  }
  const parsed = RalphAliasReceiptSchema.safeParse(raw)
  if (!parsed.success) {
    throw distributionError(
      "RALPH_ALIAS_RECEIPT_INVALID",
      `Optional alias receipt does not satisfy schema v1: ${aliasReceiptPath}`,
      {
        exitCode: EXIT_CODES.conflict,
        file: aliasReceiptPath,
        details: { issues: parsed.error.issues },
      },
    )
  }
  const receipt = parsed.data
  const sourceReceiptPath = assertManagedInstallPath(layout, receipt.sourceReceiptPath)
  if (
    resolve(receipt.installRoot) !== layout.root ||
    receipt.installId !== state.receipt.installId ||
    resolve(receipt.launcherPath) !== layout.launcher ||
    resolve(receipt.aliasPath) !== aliasPath ||
    !pathInside(layout.receipts, sourceReceiptPath)
  ) {
    throw distributionError(
      "RALPH_ALIAS_RECEIPT_BINDING_DIVERGED",
      "Optional alias receipt does not belong to this identified standalone installation",
      { exitCode: EXIT_CODES.conflict, file: aliasReceiptPath },
    )
  }
  await verifyFile(sourceReceiptPath, receipt.sourceReceiptSha256)
  const sourceReceipt = validateInstallReceiptPaths(
    await readJson(sourceReceiptPath),
    layout.root,
    sourceReceiptPath,
  )
  if (
    sourceReceipt.installId !== receipt.installId ||
    sourceReceipt.generation !== receipt.sourceGeneration ||
    resolve(sourceReceipt.launcher.executable) !== layout.launcher ||
    sourceReceipt.launcher.sha256 !== receipt.launcherSha256
  ) {
    throw distributionError(
      "RALPH_ALIAS_SOURCE_RECEIPT_DIVERGED",
      "Optional alias receipt does not match its immutable source install receipt",
      { exitCode: EXIT_CODES.conflict, file: sourceReceiptPath },
    )
  }
  return { receipt, sha256 }
}

type PendingAliasControlReceiptSnapshot = {
  readonly path: string
  readonly quarantinePath: string
  readonly sha256?: string
  readonly quarantineSha256?: string
}

async function inspectPendingAliasControlReceipt(
  layout: StandaloneInstallLayout,
  state: InstalledControlState,
  aliasPath: string,
  aliasReceiptPath: string,
  aliasState: RalphAliasState,
  platform: NodeJS.Platform,
): Promise<PendingAliasControlReceiptSnapshot> {
  const path = immutableReceiptPath(layout, state.receipt.installId, state.receipt.generation + 1)
  const quarantinePath = ralphAliasRemovalQuarantinePath(layout, path)
  const [information, quarantineInformation] = await Promise.all([
    optionalLstat(path),
    optionalLstat(quarantinePath),
  ])
  if (information && quarantineInformation) {
    throw distributionError(
      "RALPH_ALIAS_PENDING_RECEIPT_QUARANTINE_COLLISION",
      "Pending alias control receipt and its removal quarantine both exist",
      { exitCode: EXIT_CODES.conflict, file: quarantinePath },
    )
  }
  if (!information && !quarantineInformation) return { path, quarantinePath }
  if (aliasState !== "install-recovery-required" && aliasState !== "remove-recovery-required") {
    throw distributionError(
      "RALPH_ALIAS_PENDING_RECEIPT_UNEXPECTED",
      "A next-generation alias control receipt exists without an alias recovery state",
      { exitCode: EXIT_CODES.conflict, file: information ? path : quarantinePath },
    )
  }

  const observedPath = information ? path : quarantinePath
  const observedInformation = information ?? quarantineInformation
  if (!observedInformation) {
    throw distributionError(
      "RALPH_ALIAS_PENDING_RECEIPT_UNAVAILABLE",
      "Pending alias control receipt disappeared during inspection",
      { exitCode: EXIT_CODES.conflict, file: observedPath },
    )
  }
  assertRalphAliasRemovalFile(observedPath, observedInformation)
  const parsed = InstallReceiptSchema.safeParse(await readJson(observedPath))
  if (!parsed.success) {
    throw distributionError(
      "RALPH_ALIAS_PENDING_RECEIPT_INVALID",
      "Pending alias control receipt does not satisfy the immutable receipt schema",
      {
        exitCode: EXIT_CODES.conflict,
        file: observedPath,
        details: { issues: parsed.error.issues },
      },
    )
  }

  const ownsAlias = currentReceiptOwnsPath(state.receipt, aliasPath)
  const expected = buildAliasControlReceipt(
    layout,
    state,
    ownsAlias ? [] : [aliasPath, aliasReceiptPath],
    ownsAlias ? [aliasPath, aliasReceiptPath] : [],
    parsed.data.updatedAt,
    platform,
  )
  const expectedBytes = new TextEncoder().encode(serializeDistributionControlFile(expected))
  const expectedSha256 = createHash("sha256").update(expectedBytes).digest("hex")
  await verifyFile(observedPath, expectedSha256, expectedBytes.byteLength)
  return {
    path,
    quarantinePath,
    ...(information ? { sha256: expectedSha256 } : { quarantineSha256: expectedSha256 }),
  }
}

async function inspectRalphAliasSnapshot(
  layout: StandaloneInstallLayout,
  state: InstalledControlState,
  platform: NodeJS.Platform,
): Promise<RalphAliasSnapshot> {
  const { aliasPath, aliasReceiptPath } = ralphAliasPaths(layout, platform)
  const aliasRemovalQuarantinePath = ralphAliasRemovalQuarantinePath(layout, aliasPath)
  const aliasReceiptRemovalQuarantinePath = ralphAliasRemovalQuarantinePath(
    layout,
    aliasReceiptPath,
  )
  const ownsAlias = currentReceiptOwnsPath(state.receipt, aliasPath)
  const ownsAliasReceipt = currentReceiptOwnsPath(state.receipt, aliasReceiptPath)
  if (ownsAlias !== ownsAliasReceipt) {
    throw distributionError(
      "RALPH_ALIAS_CURRENT_RECEIPT_INCOMPLETE",
      "Current install receipt must own both optional alias paths or neither of them",
      { exitCode: EXIT_CODES.conflict, file: state.receiptPath },
    )
  }

  const [
    aliasInformation,
    aliasRemovalQuarantineInformation,
    aliasReceiptInformation,
    aliasReceiptRemovalQuarantineInformation,
  ] = await Promise.all([
    optionalLstat(aliasPath),
    optionalLstat(aliasRemovalQuarantinePath),
    optionalLstat(aliasReceiptPath),
    optionalLstat(aliasReceiptRemovalQuarantinePath),
  ])
  if (aliasInformation && aliasRemovalQuarantineInformation) {
    throw distributionError(
      "RALPH_ALIAS_REMOVE_QUARANTINE_COLLISION",
      "Optional alias and its removal quarantine both exist; refusing to choose or overwrite either",
      { exitCode: EXIT_CODES.conflict, file: aliasRemovalQuarantinePath },
    )
  }
  if (aliasReceiptInformation && aliasReceiptRemovalQuarantineInformation) {
    throw distributionError(
      "RALPH_ALIAS_REMOVE_RECEIPT_QUARANTINE_COLLISION",
      "Optional alias receipt and its removal quarantine both exist; refusing to choose or overwrite either",
      { exitCode: EXIT_CODES.conflict, file: aliasReceiptRemovalQuarantinePath },
    )
  }
  if (aliasInformation) assertRalphAliasRemovalFile(aliasPath, aliasInformation)
  if (aliasRemovalQuarantineInformation) {
    assertRalphAliasRemovalFile(aliasRemovalQuarantinePath, aliasRemovalQuarantineInformation)
  }
  const aliasFile = aliasInformation ? await fileSha256(aliasPath) : undefined
  const aliasRemovalQuarantineFile = aliasRemovalQuarantineInformation
    ? await fileSha256(aliasRemovalQuarantinePath)
    : undefined
  const aliasReceipt = aliasReceiptInformation
    ? await readRalphAliasReceipt(layout, state, aliasPath, aliasReceiptPath)
    : undefined
  const aliasReceiptRemovalQuarantine = aliasReceiptRemovalQuarantineInformation
    ? await readRalphAliasReceipt(layout, state, aliasPath, aliasReceiptRemovalQuarantinePath)
    : undefined
  const ownershipReceipt = aliasReceipt ?? aliasReceiptRemovalQuarantine
  const hasRemovalQuarantine = Boolean(aliasRemovalQuarantineFile || aliasReceiptRemovalQuarantine)

  let aliasState: RalphAliasState
  if (hasRemovalQuarantine) {
    if (!ownershipReceipt) {
      throw distributionError(
        "RALPH_ALIAS_REMOVE_QUARANTINE_UNOWNED",
        "Optional alias removal quarantine has no valid ownership receipt binding",
        {
          exitCode: EXIT_CODES.conflict,
          file: aliasRemovalQuarantinePath,
          hint: "Preserve the quarantine for inspection; Ralph will not delete or adopt it.",
        },
      )
    }
    const receipt = ownershipReceipt.receipt
    const observedAlias = aliasFile ?? aliasRemovalQuarantineFile
    if (observedAlias && observedAlias.sha256 !== receipt.aliasSha256) {
      throw distributionError(
        "RALPH_ALIAS_REMOVE_QUARANTINE_TAMPERED",
        "Optional alias removal quarantine does not match its ownership receipt",
        { exitCode: EXIT_CODES.conflict, file: aliasRemovalQuarantinePath },
      )
    }
    if (
      !ownsAlias &&
      (receipt.sourceGeneration !== state.receipt.generation ||
        resolve(receipt.sourceReceiptPath) !== resolve(state.receiptPath) ||
        receipt.sourceReceiptSha256 !== state.pointer.receiptSha256)
    ) {
      throw distributionError(
        "RALPH_ALIAS_REMOVE_QUARANTINE_RECEIPT_DIVERGED",
        "Uncommitted alias removal quarantine does not bind to the current immutable install receipt",
        { exitCode: EXIT_CODES.conflict, file: aliasReceiptRemovalQuarantinePath },
      )
    }
    aliasState = "remove-recovery-required"
  } else if (!ownsAlias) {
    if (!aliasReceipt && !aliasFile) {
      aliasState = "absent"
    } else if (!aliasReceipt) {
      throw distributionError(
        "RALPH_ALIAS_PATH_COLLISION",
        "A ralph executable exists in the standalone bin directory without a Ralph v2 alias receipt",
        {
          exitCode: EXIT_CODES.conflict,
          file: aliasPath,
          hint: "Move or inspect the existing file. --force never claims an unreceipted alias.",
        },
      )
    } else {
      const receipt = aliasReceipt.receipt
      if (
        receipt.sourceGeneration !== state.receipt.generation ||
        resolve(receipt.sourceReceiptPath) !== resolve(state.receiptPath) ||
        receipt.sourceReceiptSha256 !== state.pointer.receiptSha256 ||
        (aliasFile && aliasFile.sha256 !== receipt.aliasSha256)
      ) {
        throw distributionError(
          "RALPH_ALIAS_UNOWNED_RECEIPT_DIVERGED",
          "Uncommitted alias files do not bind to the current immutable install receipt",
          {
            exitCode: EXIT_CODES.conflict,
            file: aliasReceiptPath,
            hint: "Inspect the files manually; Ralph will not adopt or replace them.",
          },
        )
      }
      aliasState = "install-recovery-required"
    }
  } else if (!aliasReceipt) {
    if (aliasFile) {
      throw distributionError(
        "RALPH_ALIAS_RECEIPT_MISSING",
        "Current install receipt owns the alias paths, but the ownership receipt is missing while the alias still exists",
        { exitCode: EXIT_CODES.conflict, file: aliasReceiptPath },
      )
    }
    aliasState = "remove-recovery-required"
  } else if (!aliasFile) {
    aliasState = "remove-recovery-required"
  } else {
    if (aliasFile.sha256 !== aliasReceipt.receipt.aliasSha256) {
      throw distributionError(
        "RALPH_ALIAS_TAMPERED",
        "Optional ralph alias bytes no longer match their ownership receipt",
        { exitCode: EXIT_CODES.conflict, file: aliasPath },
      )
    }
    aliasState =
      aliasReceipt.receipt.launcherSha256 === state.receipt.launcher.sha256 ? "installed" : "stale"
  }

  const pendingControlReceipt = await inspectPendingAliasControlReceipt(
    layout,
    state,
    aliasPath,
    aliasReceiptPath,
    aliasState,
    platform,
  )
  if (pendingControlReceipt.quarantineSha256) {
    aliasState = "remove-recovery-required"
  }

  return {
    status: {
      action: "alias-status",
      alias: "ralph",
      state: aliasState,
      installRoot: layout.root,
      installId: state.receipt.installId,
      currentVersion: state.receipt.currentVersion,
      channel: state.receipt.channel,
      activationEligible: state.receipt.channel === "stable",
      sourceGeneration: state.receipt.generation,
      currentReceiptSha256: state.pointer.receiptSha256,
      launcherPath: layout.launcher,
      launcherSha256: state.receipt.launcher.sha256,
      aliasPath,
      aliasReceiptPath,
      aliasRemovalQuarantinePath,
      aliasReceiptRemovalQuarantinePath,
      pendingAliasControlReceiptPath: pendingControlReceipt.path,
      pendingAliasControlReceiptQuarantinePath: pendingControlReceipt.quarantinePath,
      ...(aliasFile ? { aliasSha256: aliasFile.sha256 } : {}),
      ...(aliasReceipt ? { aliasReceiptSha256: aliasReceipt.sha256 } : {}),
      ...(aliasRemovalQuarantineFile
        ? { aliasRemovalQuarantineSha256: aliasRemovalQuarantineFile.sha256 }
        : {}),
      ...(aliasReceiptRemovalQuarantine
        ? { aliasReceiptRemovalQuarantineSha256: aliasReceiptRemovalQuarantine.sha256 }
        : {}),
      ...(pendingControlReceipt.sha256
        ? { pendingAliasControlReceiptSha256: pendingControlReceipt.sha256 }
        : {}),
      ...(pendingControlReceipt.quarantineSha256
        ? {
            pendingAliasControlReceiptQuarantineSha256: pendingControlReceipt.quarantineSha256,
          }
        : {}),
      mutationPerformed: false,
      runningBinaryReplaced: false,
    },
    ...(ownershipReceipt ? { receipt: ownershipReceipt.receipt } : {}),
  }
}

function ralphAliasPlan(
  action: "alias-install" | "alias-remove",
  status: RalphAliasStatus,
): RalphAliasPlan {
  const subject = {
    schemaVersion: 1,
    action,
    alias: status.alias,
    state: status.state,
    installRoot: status.installRoot,
    installId: status.installId,
    currentVersion: status.currentVersion,
    channel: status.channel,
    activationEligible: status.activationEligible,
    sourceGeneration: status.sourceGeneration,
    currentReceiptSha256: status.currentReceiptSha256,
    launcherPath: status.launcherPath,
    launcherSha256: status.launcherSha256,
    aliasPath: status.aliasPath,
    aliasReceiptPath: status.aliasReceiptPath,
    aliasRemovalQuarantinePath: status.aliasRemovalQuarantinePath,
    aliasReceiptRemovalQuarantinePath: status.aliasReceiptRemovalQuarantinePath,
    pendingAliasControlReceiptPath: status.pendingAliasControlReceiptPath,
    pendingAliasControlReceiptQuarantinePath: status.pendingAliasControlReceiptQuarantinePath,
    aliasSha256: status.aliasSha256 ?? null,
    aliasReceiptSha256: status.aliasReceiptSha256 ?? null,
    aliasRemovalQuarantineSha256: status.aliasRemovalQuarantineSha256 ?? null,
    aliasReceiptRemovalQuarantineSha256: status.aliasReceiptRemovalQuarantineSha256 ?? null,
    pendingAliasControlReceiptSha256: status.pendingAliasControlReceiptSha256 ?? null,
    pendingAliasControlReceiptQuarantineSha256:
      status.pendingAliasControlReceiptQuarantineSha256 ?? null,
  }
  const planHash = createHash("sha256")
    .update(new TextEncoder().encode(serializeDistributionControlFile(subject)))
    .digest("hex")
  return {
    ...status,
    action,
    planHash,
  }
}

function assertRalphAliasPlanConfirmation(
  expected: string | undefined,
  plan: RalphAliasPlan,
): void {
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected)) {
    throw distributionError(
      "RALPH_ALIAS_PLAN_CONFIRMATION_REQUIRED",
      "Optional alias mutation requires the exact plan hash from the matching --dry-run preview",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: `Run alias ralph ${plan.action === "alias-install" ? "install" : "remove"} --dry-run with the same install root.`,
      },
    )
  }
  if (expected !== plan.planHash) {
    throw distributionError(
      "RALPH_ALIAS_PLAN_CHANGED",
      "Optional alias state changed after preview; refusing to mutate a different plan",
      {
        exitCode: EXIT_CODES.conflict,
        details: { expectedPlanHash: expected, observedPlanHash: plan.planHash },
      },
    )
  }
}

async function copyLauncherToAliasExclusive(
  layout: StandaloneInstallLayout,
  aliasPath: string,
  expectedSha256: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const launcher = await readRegularBytes(layout.launcher, RALPH_ALIAS_BINARY_LIMIT_BYTES)
  const launcherSha256 = createHash("sha256").update(launcher).digest("hex")
  if (launcherSha256 !== expectedSha256) {
    throw distributionError(
      "RALPH_ALIAS_LAUNCHER_CHANGED",
      "Stable launcher changed after the alias plan was bound",
      { exitCode: EXIT_CODES.conflict, file: layout.launcher },
    )
  }
  // A crash during the exclusive write must not leave a partially copied
  // POSIX launcher executable. Execution permission is granted on the same
  // exclusive descriptor only after the complete bytes have been written.
  await writeBytesExclusive(aliasPath, launcher, 0o600, platform === "win32" ? undefined : 0o755)
  // Once the exclusive descriptor is closed, a failed pathname verification
  // deliberately leaves the entry for fail-closed inspection/recovery. It
  // must not unlink a same-authority collision swapped into this path.
  await verifyFile(aliasPath, expectedSha256, launcher.byteLength)
  await verifyFile(layout.launcher, expectedSha256, launcher.byteLength)
}

async function verifyAndMakeAliasExecutable(
  path: string,
  expectedSha256: string,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "win32") {
    await verifyFile(path, expectedSha256)
    return
  }

  const target = resolve(path)
  const entry = await lstat(target).catch((error: unknown) => {
    throw distributionError(
      "RALPH_ALIAS_RECOVERY_FILE_UNAVAILABLE",
      `Optional alias recovery target is unavailable: ${target}`,
      { exitCode: EXIT_CODES.conflict, file: target, cause: error },
    )
  })
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw distributionError(
      "RALPH_ALIAS_RECOVERY_PATH_INVALID",
      "Optional alias recovery refuses symbolic links, hard-linked files or non-regular targets",
      {
        exitCode: EXIT_CODES.conflict,
        file: target,
        details: { observedLinkCount: entry.nlink },
      },
    )
  }

  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    throw distributionError(
      "RALPH_ALIAS_RECOVERY_OPEN_FAILED",
      "Optional alias recovery could not open the receipt-bound file without following links",
      { exitCode: EXIT_CODES.conflict, file: target, cause: error },
    )
  }

  try {
    const information = await handle.stat()
    if (
      !information.isFile() ||
      information.nlink !== 1 ||
      information.size <= 0 ||
      information.size > RALPH_ALIAS_BINARY_LIMIT_BYTES
    ) {
      throw distributionError(
        "RALPH_ALIAS_RECOVERY_IDENTITY_INVALID",
        "Optional alias recovery target no longer has the receipt-bound file identity",
        {
          exitCode: EXIT_CODES.conflict,
          file: target,
          details: {
            observedSize: information.size,
            observedLinkCount: information.nlink,
            maximumSize: RALPH_ALIAS_BINARY_LIMIT_BYTES,
          },
        },
      )
    }

    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let position = 0
    while (true) {
      const read = await handle.read(buffer, 0, buffer.byteLength, position)
      if (read.bytesRead === 0) break
      hash.update(buffer.subarray(0, read.bytesRead))
      position += read.bytesRead
    }
    const observedSha256 = hash.digest("hex")
    if (observedSha256 !== expectedSha256) {
      throw distributionError(
        "RALPH_ALIAS_RECOVERY_HASH_MISMATCH",
        "Optional alias recovery target no longer matches its ownership receipt",
        {
          exitCode: EXIT_CODES.conflict,
          file: target,
          details: { expectedSha256, observedSha256 },
        },
      )
    }

    // The permission change is bound to the same no-follow descriptor whose
    // bytes and size were verified, so a path swap cannot redirect chmod.
    await handle.chmod(0o755)
    const finalized = await handle.stat()
    if (finalized.nlink !== 1) {
      throw distributionError(
        "RALPH_ALIAS_RECOVERY_LINK_COUNT_CHANGED",
        "Optional alias link count changed while executable permissions were finalized",
        {
          exitCode: EXIT_CODES.conflict,
          file: target,
          details: { observedLinkCount: finalized.nlink },
        },
      )
    }
    await handle.sync()
  } finally {
    await handle.close()
  }

  await verifyFile(target, expectedSha256)
}

async function writeRalphAliasReceiptExclusive(
  layout: StandaloneInstallLayout,
  state: InstalledControlState,
  status: Pick<RalphAliasStatus, "aliasPath" | "aliasReceiptPath">,
  now: string,
): Promise<RalphAliasReceipt> {
  const receipt = RalphAliasReceiptSchema.parse({
    schemaVersion: 1,
    product: "ralph-next",
    alias: "ralph",
    installId: state.receipt.installId,
    installRoot: layout.root,
    sourceGeneration: state.receipt.generation,
    sourceReceiptPath: state.receiptPath,
    sourceReceiptSha256: state.pointer.receiptSha256,
    launcherPath: layout.launcher,
    launcherSha256: state.receipt.launcher.sha256,
    aliasPath: status.aliasPath,
    aliasSha256: state.receipt.launcher.sha256,
    createdAt: now,
  })
  await writeBytesExclusive(
    status.aliasReceiptPath,
    new TextEncoder().encode(serializeDistributionControlFile(receipt)),
  )
  return receipt
}

function buildAliasControlReceipt(
  layout: StandaloneInstallLayout,
  state: InstalledControlState,
  additions: readonly string[],
  removals: readonly string[],
  updatedAt: string,
  platform: NodeJS.Platform,
): InstallReceipt {
  const generation = state.receipt.generation + 1
  const receiptPath = immutableReceiptPath(layout, state.receipt.installId, generation)
  const removalSet = new Set(removals.map((path) => resolve(path)))
  const retained = state.receipt.managedPaths.filter((managed) => !removalSet.has(resolve(managed)))
  const receipt = InstallReceiptSchema.parse({
    ...state.receipt,
    generation,
    durability: installDurability(platform),
    managedPaths: managedPaths(layout, state.receipt.versions, [
      ...retained,
      ...additions,
      receiptPath,
    ]),
    updatedAt,
  })
  validateInstallReceiptPaths(receipt, layout.root, receiptPath)
  return receipt
}

async function advanceAliasControlReceipt(
  layout: StandaloneInstallLayout,
  state: InstalledControlState,
  options: DistributionRuntimeOptions,
  additions: readonly string[],
  removals: readonly string[],
): Promise<InstallReceipt> {
  const generation = state.receipt.generation + 1
  const receiptPath = immutableReceiptPath(layout, state.receipt.installId, generation)
  const existingInformation = await optionalLstat(receiptPath)
  let updatedAt = timestamp(options)
  if (existingInformation) {
    const existing = InstallReceiptSchema.safeParse(await readJson(receiptPath))
    if (!existing.success) {
      throw distributionError(
        "RALPH_ALIAS_PENDING_RECEIPT_INVALID",
        "Next immutable install receipt already exists but is invalid",
        { exitCode: EXIT_CODES.conflict, file: receiptPath },
      )
    }
    updatedAt = existing.data.updatedAt
  }
  const receipt = buildAliasControlReceipt(
    layout,
    state,
    additions,
    removals,
    updatedAt,
    options.platform ?? process.platform,
  )
  const receiptBytes = new TextEncoder().encode(serializeDistributionControlFile(receipt))
  const receiptSha256 = createHash("sha256").update(receiptBytes).digest("hex")
  if (existingInformation) {
    await verifyFile(receiptPath, receiptSha256, receiptBytes.byteLength)
  } else {
    // The immutable generation must appear complete or not at all. A crash in
    // writeBytesExclusive could reserve N+1 with partial JSON and permanently
    // block recovery; atomic publication leaves only an uncommitted temp while
    // preserving the previous pathname until the final rename.
    await writeBytesAtomic(receiptPath, receiptBytes)
    await verifyFile(receiptPath, receiptSha256, receiptBytes.byteLength)
  }
  const pointer = buildCurrentInstallPointer(
    receipt,
    receiptPath,
    receiptSha256,
    receipt.currentVersion,
    updatedAt,
  )
  await writeJsonAtomic(layout.currentPointer, pointer)
  await assertInstallStateConsistent(layout, receipt)
  return receipt
}

async function discardPendingAliasControlReceipt(
  layout: StandaloneInstallLayout,
  status: RalphAliasStatus,
  platform: NodeJS.Platform,
): Promise<void> {
  const expectedSha256 =
    status.pendingAliasControlReceiptSha256 ?? status.pendingAliasControlReceiptQuarantineSha256
  if (!expectedSha256) return
  await removeRalphAliasFileThroughQuarantine(
    layout,
    status.pendingAliasControlReceiptPath,
    expectedSha256,
    CONTROL_FILE_LIMIT_BYTES,
    platform,
  )
}

async function readRalphAliasState(
  requestedRoot: string,
  platform: NodeJS.Platform,
): Promise<{
  layout: StandaloneInstallLayout
  state: InstalledControlState
  snapshot: RalphAliasSnapshot
}> {
  const { layout, receipt } = await openIdentifiedLayout(requestedRoot, platform)
  const managedParents = await captureRalphAliasManagedParents(layout, platform)
  const state = await readControlState(layout)
  await assertInstallStateConsistent(layout, receipt)
  const snapshot = await inspectRalphAliasSnapshot(layout, state, platform)
  await assertRalphAliasManagedParents(managedParents, platform)
  return {
    layout,
    state,
    snapshot,
  }
}

export async function inspectRalphAlias(
  requestedRoot: string,
  options: Pick<DistributionRuntimeOptions, "platform"> = {},
): Promise<RalphAliasStatus> {
  return (await readRalphAliasState(requestedRoot, options.platform ?? process.platform)).snapshot
    .status
}

export async function installRalphAlias(
  input: RalphAliasMutationRequest,
): Promise<RalphAliasPlan | RalphAliasMutationResult> {
  const platform = input.platform ?? process.platform
  if (input.dryRun) {
    const current = await readRalphAliasState(input.installRoot, platform)
    return ralphAliasPlan("alias-install", current.snapshot.status)
  }
  const layout = await canonicalLayout(input.installRoot, platform)
  return withInstallLock(layout, "alias-install", input, async () => {
    const current = await readRalphAliasState(layout.root, platform)
    const plan = ralphAliasPlan("alias-install", current.snapshot.status)
    assertRalphAliasPlanConfirmation(input.confirmationPlanHash, plan)
    if (current.state.receipt.channel !== "stable") {
      throw distributionError(
        "RALPH_ALIAS_STABLE_RECEIPT_REQUIRED",
        "The optional ralph alias can be installed only from a promoted stable install receipt after the beta cut gate",
        {
          exitCode: EXIT_CODES.policyDenied,
          file: current.state.receiptPath,
          hint: "Keep using ralph-next. Beta/nightly may inspect and preview the alias but cannot activate it.",
        },
      )
    }
    if (plan.state === "installed") return plan
    if (plan.state === "stale" || plan.state === "remove-recovery-required") {
      throw distributionError(
        "RALPH_ALIAS_REMOVE_REQUIRED",
        "Existing receipt-owned alias must be removed before it can be installed again",
        {
          exitCode: EXIT_CODES.conflict,
          file: plan.aliasPath,
          hint: "Preview and confirm `alias ralph remove`, then preview installation again.",
        },
      )
    }

    const managedParents = await captureRalphAliasManagedParents(current.layout, platform)
    let receipt = current.snapshot.receipt
    if (!receipt) {
      await assertRalphAliasManagedParents(managedParents, platform)
      receipt = await writeRalphAliasReceiptExclusive(
        current.layout,
        current.state,
        plan,
        timestamp(input),
      )
      await assertRalphAliasManagedParents(managedParents, platform)
    }
    if (!(await optionalLstat(plan.aliasPath))) {
      await assertRalphAliasManagedParents(managedParents, platform)
      await copyLauncherToAliasExclusive(
        current.layout,
        plan.aliasPath,
        receipt.aliasSha256,
        platform,
      )
      await assertRalphAliasManagedParents(managedParents, platform)
    } else {
      // Recovery may observe complete bytes created with the deliberately
      // non-executable staging mode after a crash before chmod. Re-apply the
      // final mode through the same no-follow descriptor whose identity and
      // receipt-bound bytes were confirmed.
      await verifyAndMakeAliasExecutable(plan.aliasPath, receipt.aliasSha256, platform)
      await assertRalphAliasManagedParents(managedParents, platform)
    }
    const ownsAlias = currentReceiptOwnsPath(current.state.receipt, plan.aliasPath)
    await assertRalphAliasManagedParents(managedParents, platform)
    const nextReceipt = ownsAlias
      ? current.state.receipt
      : await advanceAliasControlReceipt(
          current.layout,
          current.state,
          input,
          [plan.aliasPath, plan.aliasReceiptPath],
          [],
        )
    await assertRalphAliasManagedParents(managedParents, platform)
    return {
      action: "alias-install",
      operationId: randomUUID(),
      alias: "ralph",
      state: "installed",
      installRoot: current.layout.root,
      installId: current.state.receipt.installId,
      currentVersion: current.state.receipt.currentVersion,
      channel: current.state.receipt.channel,
      previousGeneration: current.state.receipt.generation,
      currentGeneration: nextReceipt.generation,
      aliasPath: plan.aliasPath,
      aliasReceiptPath: plan.aliasReceiptPath,
      planHash: plan.planHash,
      mutationPerformed: true,
      runningBinaryReplaced: false,
    }
  })
}

export async function removeRalphAlias(
  input: RalphAliasMutationRequest,
): Promise<RalphAliasPlan | RalphAliasMutationResult> {
  const platform = input.platform ?? process.platform
  if (input.dryRun) {
    const current = await readRalphAliasState(input.installRoot, platform)
    return ralphAliasPlan("alias-remove", current.snapshot.status)
  }
  const layout = await canonicalLayout(input.installRoot, platform)
  return withInstallLock(layout, "alias-remove", input, async () => {
    const current = await readRalphAliasState(layout.root, platform)
    const plan = ralphAliasPlan("alias-remove", current.snapshot.status)
    assertRalphAliasPlanConfirmation(input.confirmationPlanHash, plan)
    const managedParents = await captureRalphAliasManagedParents(current.layout, platform)

    const aliasQuarantinePath = plan.aliasRemovalQuarantinePath
    const aliasReceiptQuarantinePath = plan.aliasReceiptRemovalQuarantinePath
    const aliasReceipt = current.snapshot.receipt
    const aliasReceiptSha256 =
      current.snapshot.status.aliasReceiptSha256 ??
      current.snapshot.status.aliasReceiptRemovalQuarantineSha256
    const hasAliasRemovalQuarantine = Boolean(
      current.snapshot.status.aliasRemovalQuarantineSha256 ||
        current.snapshot.status.aliasReceiptRemovalQuarantineSha256,
    )
    const ownsAliasBeforeRemoval = currentReceiptOwnsPath(current.state.receipt, plan.aliasPath)

    if (
      current.snapshot.status.pendingAliasControlReceiptQuarantineSha256 ||
      (!ownsAliasBeforeRemoval && current.snapshot.status.pendingAliasControlReceiptSha256)
    ) {
      await discardPendingAliasControlReceipt(current.layout, current.snapshot.status, platform)
    }

    if (!aliasReceipt && hasAliasRemovalQuarantine) {
      throw distributionError(
        "RALPH_ALIAS_REMOVE_QUARANTINE_UNOWNED",
        "Optional alias removal quarantine has no valid ownership receipt binding",
        {
          exitCode: EXIT_CODES.conflict,
          file: aliasQuarantinePath,
          hint: "Preserve the quarantined bytes for inspection; Ralph will not delete them.",
        },
      )
    }
    if (plan.state === "absent" && !aliasReceipt && !hasAliasRemovalQuarantine) return plan

    if (aliasReceipt) {
      await removeRalphAliasFileThroughQuarantine(
        current.layout,
        plan.aliasPath,
        aliasReceipt.aliasSha256,
        RALPH_ALIAS_BINARY_LIMIT_BYTES,
        platform,
      )
      if (!aliasReceiptSha256) {
        throw distributionError(
          "RALPH_ALIAS_REMOVE_RECEIPT_HASH_MISSING",
          "Optional alias removal cannot prove the ownership receipt hash",
          { exitCode: EXIT_CODES.conflict, file: plan.aliasReceiptPath },
        )
      }
      await removeRalphAliasFileThroughQuarantine(
        current.layout,
        plan.aliasReceiptPath,
        aliasReceiptSha256,
        64 * 1024,
        platform,
      )
    }

    for (const remaining of [
      plan.aliasPath,
      plan.aliasReceiptPath,
      aliasQuarantinePath,
      aliasReceiptQuarantinePath,
    ]) {
      if (await optionalLstat(remaining)) {
        throw distributionError(
          "RALPH_ALIAS_REMOVE_PATH_REMAINS",
          "Optional alias removal did not reach a clean, receipt-free filesystem state",
          { exitCode: EXIT_CODES.conflict, file: remaining },
        )
      }
    }

    await assertRalphAliasManagedParents(managedParents, platform)
    const nextReceipt = ownsAliasBeforeRemoval
      ? await advanceAliasControlReceipt(
          current.layout,
          current.state,
          input,
          [],
          [plan.aliasPath, plan.aliasReceiptPath],
        )
      : current.state.receipt
    await assertRalphAliasManagedParents(managedParents, platform)
    return {
      action: "alias-remove",
      operationId: randomUUID(),
      alias: "ralph",
      state: "absent",
      installRoot: current.layout.root,
      installId: current.state.receipt.installId,
      currentVersion: current.state.receipt.currentVersion,
      channel: current.state.receipt.channel,
      previousGeneration: current.state.receipt.generation,
      currentGeneration: nextReceipt.generation,
      aliasPath: plan.aliasPath,
      aliasReceiptPath: plan.aliasReceiptPath,
      planHash: plan.planHash,
      mutationPerformed: true,
      runningBinaryReplaced: false,
    }
  })
}

export async function installStandalone(
  input: StandaloneInstallRequest,
): Promise<DistributionPlan | DistributionMutationResult> {
  if (input.dryRun) return installStandaloneUnlocked(input)
  const layout = await canonicalLayout(input.installRoot, input.platform ?? process.platform)
  return withInstallLock(layout, "install", input, () => installStandaloneUnlocked(input))
}

export async function updateStandalone(
  input: StandaloneUpdateRequest,
): Promise<DistributionPlan | UpdateCheckResult | DistributionMutationResult> {
  if (input.dryRun) return updateStandaloneUnlocked(input)
  if (input.checkOnly) return checkStandaloneUpdate(input)
  const layout = await canonicalLayout(input.installRoot, input.platform ?? process.platform)
  return withInstallLock(layout, "update", input, () => updateStandaloneUnlocked(input))
}

export async function checkStandaloneUpdate(
  input: StandaloneUpdateRequest,
): Promise<UpdateCheckResult> {
  const layout = await canonicalLayout(input.installRoot, input.platform ?? process.platform)
  return withInstallLock(layout, "update", input, () => checkStandaloneUpdateUnlocked(input))
}

export async function rollbackStandalone(
  input: StandaloneRollbackRequest,
): Promise<DistributionPlan | DistributionMutationResult> {
  if (input.dryRun) return rollbackStandaloneUnlocked(input)
  const layout = await canonicalLayout(input.installRoot, input.platform ?? process.platform)
  return withInstallLock(layout, "rollback", input, () => rollbackStandaloneUnlocked(input))
}

export async function uninstallStandalone(
  input: StandaloneUninstallRequest,
): Promise<DistributionPlan | DistributionMutationResult> {
  if (input.dryRun) return uninstallStandaloneUnlocked(input)
  const layout = await canonicalLayout(input.installRoot, input.platform ?? process.platform)
  return withInstallLock(layout, "uninstall", input, () => uninstallStandaloneUnlocked(input))
}

export async function inspectStandaloneInstall(
  requestedRoot: string,
  options: Pick<DistributionRuntimeOptions, "platform"> = {},
): Promise<{ layout: StandaloneInstallLayout; receipt: InstallReceipt }> {
  return openIdentifiedLayout(requestedRoot, options.platform ?? process.platform)
}
