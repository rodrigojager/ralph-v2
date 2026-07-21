import { createHash, randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises"
import { hostname as localHostname } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { type TelemetryConfig, TelemetryConfigSchema } from "@ralph/domain"
import type { ProcessRecoveryProbeResult } from "@ralph/orchestration"
import { probeProcessIdentity } from "@ralph/orchestration"
import {
  acquireDurableLease,
  appendEvent,
  inspectWorkspace,
  rawPersistenceEnabled,
  readDurableLease,
  registerLedgerRedactionSecrets,
  releaseDurableLease,
  renewDurableLease,
  resolveDiagnosticRawRetention,
  runLayout,
  workspaceLayout,
  writeJsonAtomic,
} from "@ralph/persistence"
import {
  captureProcessIdentity,
  createWorkerCapabilityToken,
  hashWorkerCapabilityToken,
  inspectRunControlDescriptor,
  matchesWorkerCapabilityToken,
  type ProcessSettlement,
  processShutdownRegistry,
  processStartToken,
  type RunControlDescriptor,
  type SupervisedProcessHandle,
  sendRunControlRequest,
  startRunControlServer,
  type WorkerCommandInvocation,
  WorkerCommandInvocationSchema,
  workerCommandCapabilityFingerprint,
  workerExecutableContentHash,
} from "@ralph/supervisor"
import type { ProcessPortResult } from "@ralph/tool-host"
import { z } from "zod"

import { createWorkspaceBunProcessSupervisor } from "./process-output-store"

const OWNER_ENVIRONMENT_FLAG = "RALPH_DURABLE_PROCESS_OWNER"
const LIFECYCLE_SCHEMA_VERSION = 1 as const
const MAX_LIFECYCLE_BYTES = 4 * 1_024 * 1_024
const MAX_STOP_INTENT_BYTES = 64 * 1_024
const MAX_BOOTSTRAP_BYTES = 16 * 1_024 * 1_024
const STARTUP_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 200
const LEASE_DURATION_MS = 15_000
const LEASE_GRACE_MS = 15_000
const LEASE_RENEW_INTERVAL_MS = 5_000
const OWNER_IDENTITY_PROBE_INTERVAL_MS = 5_000
const MAX_LIVE_DELTA_CHARS = 65_536
// Leaves headroom for JSON escaping while keeping lifecycle.json below 4 MiB.
const MAX_DURABLE_SUMMARY_BYTES_PER_STREAM = 256 * 1_024

type OwnerLaunchBaseline = {
  readonly command: readonly string[]
  readonly executable: string
  readonly executableHash: string
  readonly entrypoint?: string
  readonly entrypointHash?: string
}

function captureOwnerLaunchBaseline(): OwnerLaunchBaseline {
  const executable = realpathSync.native(process.execPath)
  const standalone = process.env.RALPH_STANDALONE_INSTALL_ROOT !== undefined
  const candidate = process.argv[1]
  if (standalone || !candidate) {
    return {
      command: [executable],
      executable,
      executableHash: workerExecutableContentHash(executable),
    }
  }
  let entrypoint: string
  try {
    entrypoint = realpathSync.native(resolve(candidate))
  } catch {
    return {
      command: [executable],
      executable,
      executableHash: workerExecutableContentHash(executable),
    }
  }
  if (samePath(entrypoint, executable)) {
    return {
      command: [executable],
      executable,
      executableHash: workerExecutableContentHash(executable),
    }
  }
  return {
    command: [executable, entrypoint],
    executable,
    executableHash: workerExecutableContentHash(executable),
    entrypoint,
    entrypointHash: workerExecutableContentHash(entrypoint),
  }
}

// Captured when the command composition is loaded, before model-controlled work begins.
const OWNER_LAUNCH_BASELINE = captureOwnerLaunchBaseline()

const NonEmptyStringSchema = z.string().trim().min(1).max(4_096)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const TimestampSchema = z.iso.datetime({ offset: true })
const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine(isAbsolute, "Expected absolute path")
const ProcessIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    processStartToken: NonEmptyStringSchema,
    hostname: NonEmptyStringSchema,
  })
  .strict()

const DurableProcessBindingSchema = z
  .object({
    intentId: NonEmptyStringSchema,
    argumentsHash: Sha256Schema,
    idempotencyKey: Sha256Schema,
  })
  .strict()
export type DurableProcessBinding = z.infer<typeof DurableProcessBindingSchema>

const DurableProcessScopeSchema = z
  .object({
    workspaceId: NonEmptyStringSchema,
    workspaceRoot: AbsolutePathSchema,
    controlRoot: AbsolutePathSchema,
    runId: NonEmptyStringSchema,
    documentId: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    attemptId: NonEmptyStringSchema,
  })
  .strict()
export type DurableProcessScope = z.infer<typeof DurableProcessScopeSchema>

const DurableProcessRequestSchema = z
  .object({
    executable: AbsolutePathSchema,
    args: z.array(z.string().max(65_536)).max(1_024),
    cwd: AbsolutePathSchema,
    environment: z.record(z.string().min(1).max(32_767), z.string()),
    environmentRefs: z.record(z.string(), z.string()).optional(),
    shell: z.literal(false),
    stdin: z
      .string()
      .max(4 * 1_024 * 1_024)
      .optional(),
    timeoutMs: z.number().int().positive(),
    outputLimitBytes: z.number().int().positive(),
    rawOutputLimitBytes: z.number().int().positive(),
    secretValues: z.array(z.string()).max(4_096),
    telemetry: TelemetryConfigSchema,
  })
  .strict()
  .refine((value) => value.rawOutputLimitBytes >= value.outputLimitBytes, {
    message: "rawOutputLimitBytes must cover outputLimitBytes",
    path: ["rawOutputLimitBytes"],
  })
export type DurableProcessRequest = z.infer<typeof DurableProcessRequestSchema>

export const DurableProcessParentCallSchema = z
  .object({
    schemaVersion: z.literal(LIFECYCLE_SCHEMA_VERSION),
    scope: DurableProcessScopeSchema,
    binding: DurableProcessBindingSchema,
    command: WorkerCommandInvocationSchema,
    request: DurableProcessRequestSchema,
  })
  .strict()
export type DurableProcessParentCall = z.infer<typeof DurableProcessParentCallSchema>

export const DurableProcessResultSchema = z
  .object({
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    stdout: z.string(),
    stderr: z.string(),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    outputTruncated: z.boolean(),
    rawOutputTruncated: z.boolean(),
    timedOut: z.boolean(),
    cancelled: z.boolean(),
    treeTerminated: z.boolean(),
    outputRefs: z.array(z.string()),
    durationMs: z.number().nonnegative(),
    error: z.string().optional(),
  })
  .strict()

type ParsedDurableProcessResult = z.infer<typeof DurableProcessResultSchema>

function projectDurableProcessResult(result: ParsedDurableProcessResult): ProcessPortResult {
  const { exitCode, signal, error, ...required } = result
  return {
    ...required,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

function parseDurableProcessResult(result: unknown): ProcessPortResult {
  return projectDurableProcessResult(DurableProcessResultSchema.parse(result))
}

const LifecycleBaseSchema = z.object({
  schemaVersion: z.literal(LIFECYCLE_SCHEMA_VERSION),
  scope: DurableProcessScopeSchema,
  binding: DurableProcessBindingSchema,
  commandFingerprint: Sha256Schema,
  launchCapabilityHash: Sha256Schema,
  launcher: ProcessIdentitySchema,
  revision: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
})

const LaunchingLifecycleSchema = LifecycleBaseSchema.extend({
  state: z.literal("launching"),
}).strict()
const OwnedLifecycleFields = {
  ownerInstanceId: NonEmptyStringSchema,
  owner: ProcessIdentitySchema,
  leaseId: NonEmptyStringSchema,
  startedAt: TimestampSchema,
}
const StartingLifecycleSchema = LifecycleBaseSchema.extend({
  state: z.literal("starting"),
  ...OwnedLifecycleFields,
}).strict()
const RunningLifecycleSchema = LifecycleBaseSchema.extend({
  state: z.literal("running"),
  ...OwnedLifecycleFields,
  child: ProcessIdentitySchema,
}).strict()
const SettledLifecycleSchema = LifecycleBaseSchema.extend({
  state: z.literal("settled"),
  ...OwnedLifecycleFields,
  child: ProcessIdentitySchema.optional(),
  result: DurableProcessResultSchema,
  finishedAt: TimestampSchema,
}).strict()
const DurableProcessLifecycleSchema = z.discriminatedUnion("state", [
  LaunchingLifecycleSchema,
  StartingLifecycleSchema,
  RunningLifecycleSchema,
  SettledLifecycleSchema,
])
export type DurableProcessLifecycle = z.infer<typeof DurableProcessLifecycleSchema>

const DurableProcessStopIntentSchema = z
  .object({
    schemaVersion: z.literal(LIFECYCLE_SCHEMA_VERSION),
    scope: DurableProcessScopeSchema,
    binding: DurableProcessBindingSchema,
    commandFingerprint: Sha256Schema,
    launchCapabilityHash: Sha256Schema,
    mode: z.enum(["graceful", "force"]),
    reason: NonEmptyStringSchema,
    requestId: NonEmptyStringSchema,
    requestedAt: TimestampSchema,
  })
  .strict()
type DurableProcessStopIntent = z.infer<typeof DurableProcessStopIntentSchema>

const OwnerBootstrapSchema = z
  .object({
    schemaVersion: z.literal(LIFECYCLE_SCHEMA_VERSION),
    launchCapabilityToken: z.string().min(32).max(512),
    scope: DurableProcessScopeSchema,
    binding: DurableProcessBindingSchema,
    command: WorkerCommandInvocationSchema,
    request: DurableProcessRequestSchema,
  })
  .strict()
type OwnerBootstrap = z.infer<typeof OwnerBootstrapSchema>

export type DurableProcessAuthority = {
  readonly scope: DurableProcessScope
  readonly binding: DurableProcessBinding
  readonly command: WorkerCommandInvocation
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly secretValues: readonly string[]
  readonly stdin?: string
  readonly maximumTimeoutMs: number
  readonly maximumOutputBytes: number
  readonly maximumRawOutputBytes: number
  readonly telemetry: TelemetryConfig
  readonly signal?: AbortSignal
}

export type DurableProcessRecoveryInput = {
  readonly controlRoot: string
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly runId: string
  readonly documentId: string
  readonly taskId: string
  readonly attemptId: string
  readonly intentId: string
  readonly argumentsHash: string
  readonly idempotencyKey: string
  readonly signal?: AbortSignal
}

type DurableProcessPaths = {
  readonly directory: string
  readonly lifecycle: string
  readonly control: string
  readonly stopIntent: string
  readonly resourceKey: string
  readonly intentDigest: string
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function processPaths(controlRoot: string, runId: string, intentId: string): DurableProcessPaths {
  const intentDigest = sha256(intentId)
  const directory = join(
    runLayout(workspaceLayout(resolve(controlRoot)), runId).root,
    "processes",
    intentDigest,
  )
  return {
    directory,
    lifecycle: join(directory, "lifecycle.json"),
    control: join(directory, "control.json"),
    stopIntent: join(directory, "stop-intent.json"),
    resourceKey: `tool-process:${intentDigest}`,
    intentDigest,
  }
}

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("und") : path
}

function samePath(left: string, right: string): boolean {
  return comparablePath(resolve(left)) === comparablePath(resolve(right))
}

function pathWithin(root: string, candidate: string): boolean {
  const relation = relative(comparablePath(resolve(root)), comparablePath(resolve(candidate)))
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  )
}

function sameHost(left: string, right: string): boolean {
  return left.toLocaleLowerCase("und") === right.toLocaleLowerCase("und")
}

function sameIdentity(
  left: z.infer<typeof ProcessIdentitySchema>,
  right: z.infer<typeof ProcessIdentitySchema>,
): boolean {
  return (
    left.pid === right.pid &&
    left.processStartToken === right.processStartToken &&
    sameHost(left.hostname, right.hostname)
  )
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en")),
  )
}

function sameEnvironment(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    JSON.stringify(normalizedEnvironment(left)) === JSON.stringify(normalizedEnvironment(right))
  )
}

function bindingForRecovery(input: DurableProcessRecoveryInput): DurableProcessBinding {
  return DurableProcessBindingSchema.parse({
    intentId: input.intentId,
    argumentsHash: input.argumentsHash,
    idempotencyKey: input.idempotencyKey,
  })
}

function scopeForRecovery(input: DurableProcessRecoveryInput): DurableProcessScope {
  return DurableProcessScopeSchema.parse({
    workspaceId: input.workspaceId,
    workspaceRoot: resolve(input.workspaceRoot),
    controlRoot: resolve(input.controlRoot),
    runId: input.runId,
    documentId: input.documentId,
    taskId: input.taskId,
    attemptId: input.attemptId,
  })
}

function sameBinding(left: DurableProcessBinding, right: DurableProcessBinding): boolean {
  return (
    left.intentId === right.intentId &&
    left.argumentsHash === right.argumentsHash &&
    left.idempotencyKey === right.idempotencyKey
  )
}

function sameScope(left: DurableProcessScope, right: DurableProcessScope): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    samePath(left.workspaceRoot, right.workspaceRoot) &&
    samePath(left.controlRoot, right.controlRoot) &&
    left.runId === right.runId &&
    left.documentId === right.documentId &&
    left.taskId === right.taskId &&
    left.attemptId === right.attemptId
  )
}

function assertLifecycleBinding(
  lifecycle: DurableProcessLifecycle,
  scope: DurableProcessScope,
  binding: DurableProcessBinding,
): void {
  if (!sameScope(lifecycle.scope, scope) || !sameBinding(lifecycle.binding, binding)) {
    throw new Error(
      "Durable process lifecycle belongs to another workspace/run/task/attempt/intent",
    )
  }
}

async function ensureSafeDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const canonical = await realpath(path)
  if (!samePath(canonical, path)) {
    throw new Error(`Durable process directory traverses a link or junction: ${path}`)
  }
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Durable process path is not a safe directory: ${path}`)
  }
  return canonical
}

async function readLifecycleOnce(path: string): Promise<DurableProcessLifecycle> {
  const absolute = resolve(path)
  const canonicalParent = await realpath(dirname(absolute))
  if (!samePath(canonicalParent, dirname(absolute))) {
    throw new Error("Durable process lifecycle directory traverses a link or junction")
  }
  const before = await lstat(absolute)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > MAX_LIFECYCLE_BYTES ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  ) {
    throw new Error("Durable process lifecycle is linked, non-regular, oversized, or unprotected")
  }
  const handle = await open(absolute, "r")
  try {
    const opened = await handle.stat()
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("Durable process lifecycle changed while it was read")
    }
    return DurableProcessLifecycleSchema.parse(JSON.parse(bytes.toString("utf8")))
  } finally {
    await handle.close()
  }
}

async function readLifecycle(path: string): Promise<DurableProcessLifecycle> {
  let failure: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await readLifecycleOnce(path)
    } catch (error) {
      failure = error
      if (attempt < 4) {
        await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, 25))
      }
    }
  }
  throw failure
}

async function readLifecycleIfPresent(path: string): Promise<DurableProcessLifecycle | undefined> {
  try {
    return await readLifecycle(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function readStopIntentOnce(path: string): Promise<DurableProcessStopIntent> {
  const absolute = resolve(path)
  const canonicalParent = await realpath(dirname(absolute))
  if (!samePath(canonicalParent, dirname(absolute))) {
    throw new Error("Durable process stop-intent directory traverses a link or junction")
  }
  const before = await lstat(absolute)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > MAX_STOP_INTENT_BYTES ||
    (process.platform !== "win32" && (before.mode & 0o077) !== 0)
  ) {
    throw new Error("Durable process stop intent is linked, non-regular, oversized, or unprotected")
  }
  const handle = await open(absolute, "r")
  try {
    const opened = await handle.stat()
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("Durable process stop intent changed while it was read")
    }
    return DurableProcessStopIntentSchema.parse(JSON.parse(bytes.toString("utf8")))
  } finally {
    await handle.close()
  }
}

async function readStopIntent(path: string): Promise<DurableProcessStopIntent> {
  let failure: unknown
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await readStopIntentOnce(path)
    } catch (error) {
      failure = error
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error
      if (attempt < 4) await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, 25))
    }
  }
  throw failure
}

async function readStopIntentIfPresent(
  path: string,
): Promise<DurableProcessStopIntent | undefined> {
  try {
    return await readStopIntent(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function writeLifecycle(
  path: string,
  lifecycle: DurableProcessLifecycle,
  overwrite: boolean,
): Promise<void> {
  if (!overwrite) {
    await writeExclusiveJson(path, DurableProcessLifecycleSchema.parse(lifecycle))
    return
  }
  await writeJsonAtomic(path, DurableProcessLifecycleSchema.parse(lifecycle), {
    overwrite: true,
    mode: 0o600,
  })
}

async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    const directory = await open(dirname(path), "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } catch {
    // Directory fsync is not available on every supported Windows/filesystem combination.
  }
}

function assertStopIntentBinding(
  intent: DurableProcessStopIntent,
  lifecycle: DurableProcessLifecycle,
  scope: DurableProcessScope,
  binding: DurableProcessBinding,
): void {
  if (
    !sameScope(intent.scope, scope) ||
    !sameBinding(intent.binding, binding) ||
    intent.commandFingerprint !== lifecycle.commandFingerprint ||
    intent.launchCapabilityHash !== lifecycle.launchCapabilityHash
  ) {
    throw new Error(
      "Durable process stop intent belongs to another lifecycle capability or command",
    )
  }
}

async function persistStopIntent(input: {
  paths: DurableProcessPaths
  lifecycle: DurableProcessLifecycle
  scope: DurableProcessScope
  binding: DurableProcessBinding
  mode: "graceful" | "force"
  reason: string
}): Promise<DurableProcessStopIntent> {
  assertLifecycleBinding(input.lifecycle, input.scope, input.binding)
  const requested = DurableProcessStopIntentSchema.parse({
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    scope: input.scope,
    binding: input.binding,
    commandFingerprint: input.lifecycle.commandFingerprint,
    launchCapabilityHash: input.lifecycle.launchCapabilityHash,
    mode: input.mode,
    reason: input.reason.slice(0, 4_096) || `${input.mode} shutdown`,
    requestId: randomUUID(),
    requestedAt: new Date().toISOString(),
  })
  try {
    await writeExclusiveJson(input.paths.stopIntent, requested)
    return requested
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }

  const existing = await readStopIntent(input.paths.stopIntent)
  assertStopIntentBinding(existing, input.lifecycle, input.scope, input.binding)
  if (existing.mode === "force" || input.mode === "graceful") return existing

  await writeJsonAtomic(input.paths.stopIntent, requested, { overwrite: true, mode: 0o600 })
  return requested
}

function ownerLaunchCommand(workspaceRoot: string): string[] {
  const baseline = OWNER_LAUNCH_BASELINE
  const currentExecutable = realpathSync.native(process.execPath)
  if (
    !samePath(currentExecutable, baseline.executable) ||
    workerExecutableContentHash(currentExecutable) !== baseline.executableHash
  ) {
    throw new Error("Ralph executable changed after command composition; owner launch is refused")
  }
  if (pathWithin(workspaceRoot, currentExecutable)) {
    throw new Error(
      "Durable process owner executable is inside the model-writable execution workspace",
    )
  }
  if (baseline.entrypoint) {
    const currentEntrypoint = realpathSync.native(baseline.entrypoint)
    if (
      !baseline.entrypointHash ||
      !samePath(currentEntrypoint, baseline.entrypoint) ||
      workerExecutableContentHash(currentEntrypoint) !== baseline.entrypointHash
    ) {
      throw new Error(
        "Ralph source entrypoint changed after command composition; owner launch is refused",
      )
    }
    if (pathWithin(workspaceRoot, currentEntrypoint)) {
      throw new Error(
        "Durable process owner source entrypoint is inside the model-writable execution workspace; use an installed/bundled Ralph executable",
      )
    }
  }
  return [...baseline.command]
}

function assertDurableTargetExecutableOutsideWorkspace(
  workspaceRoot: string,
  executable: string,
): void {
  const canonicalExecutable = realpathSync.native(executable)
  if (!samePath(canonicalExecutable, executable)) {
    throw new Error("Durable process target executable must use its canonical real path")
  }
  if (pathWithin(workspaceRoot, canonicalExecutable)) {
    throw new Error(
      "Durable process target executable is inside the model-writable workspace; use an installed executable outside the workspace so its authorized bytes cannot be replaced before spawn",
    )
  }
}

/** Preflight used before ToolHost authorizes/starts an effect-capable intent. */
export function assertDurableProcessOwnerLaunchAvailable(workspaceRoot: string): void {
  ownerLaunchCommand(workspaceRoot)
}

function ownerEnvironment(): Record<string, string> {
  const allowed = new Set([
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "SystemDrive",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "RALPH_STANDALONE_INSTALL_ROOT",
  ])
  const environment: Record<string, string> = { [OWNER_ENVIRONMENT_FLAG]: "1" }
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(name)) environment[name] = value
  }
  return environment
}

async function validateWorkspace(scope: DurableProcessScope): Promise<void> {
  const workspace = await inspectWorkspace(scope.controlRoot, { exact: true })
  if (!workspace.initialized || workspace.workspaceId !== scope.workspaceId) {
    throw new Error("Durable process scope does not match the initialized control workspace")
  }
  const canonicalControl = await realpath(scope.controlRoot)
  const canonicalWorkspace = await realpath(scope.workspaceRoot)
  if (
    !samePath(canonicalControl, scope.controlRoot) ||
    !samePath(canonicalWorkspace, scope.workspaceRoot)
  ) {
    throw new Error("Durable process scope is not canonical")
  }
}

function assertAuthority(call: DurableProcessParentCall, authority: DurableProcessAuthority): void {
  const expectedScope = DurableProcessScopeSchema.parse(authority.scope)
  const expectedBinding = DurableProcessBindingSchema.parse(authority.binding)
  const expectedCommand = WorkerCommandInvocationSchema.parse(authority.command)
  if (!sameScope(call.scope, expectedScope) || !sameBinding(call.binding, expectedBinding)) {
    throw new Error("Worker durable-process call is not bound to the active journal scope")
  }
  const actualFingerprint = workerCommandCapabilityFingerprint(
    call.scope.workspaceRoot,
    call.command,
  )
  const expectedFingerprint = workerCommandCapabilityFingerprint(
    expectedScope.workspaceRoot,
    expectedCommand,
  )
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error("Worker durable-process call differs from the exact authorized command")
  }
  const request = call.request
  if (
    call.command.intent !== "tool" ||
    !samePath(request.executable, call.command.executable) ||
    !samePath(request.cwd, call.command.cwd) ||
    !sameStrings(request.args, call.command.args) ||
    request.shell !== false
  ) {
    throw new Error("Durable process request differs from the authorized direct argv invocation")
  }
  if (request.environmentRefs !== undefined) {
    throw new Error("Model-facing process.exec cannot introduce environment references")
  }
  if (
    !sameEnvironment(request.environment, authority.environment) ||
    !sameStrings(request.secretValues, authority.secretValues) ||
    request.stdin !== authority.stdin ||
    JSON.stringify(request.telemetry) !== JSON.stringify(authority.telemetry)
  ) {
    throw new Error("Durable process request differs from the command-owned environment or stdin")
  }
  const environmentNames = Object.keys(request.environment).sort()
  if (!sameStrings(environmentNames, [...call.command.environmentNames].sort())) {
    throw new Error("Durable process environment names differ from the command capability")
  }
  if (
    request.timeoutMs > authority.maximumTimeoutMs ||
    request.outputLimitBytes > authority.maximumOutputBytes ||
    request.rawOutputLimitBytes > authority.maximumRawOutputBytes
  ) {
    throw new Error("Durable process request exceeds command-owned resource limits")
  }
  if (workerExecutableContentHash(request.executable) !== call.command.executableHash) {
    throw new Error("Authorized durable process executable changed before supervisor handoff")
  }
}

function projectSettlement(result: ProcessSettlement): ProcessPortResult {
  const boundedSummary = (value: string): { text: string; truncated: boolean } => {
    const bytes = Buffer.from(value, "utf8")
    if (bytes.byteLength <= MAX_DURABLE_SUMMARY_BYTES_PER_STREAM) {
      return { text: value, truncated: false }
    }
    return {
      text: bytes.subarray(0, MAX_DURABLE_SUMMARY_BYTES_PER_STREAM).toString("utf8"),
      truncated: true,
    }
  }
  const stdout = boundedSummary(result.stdout)
  const stderr = boundedSummary(result.stderr)
  return parseDurableProcessResult({
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.signal !== undefined ? { signal: result.signal } : {}),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    outputTruncated: result.outputTruncated || stdout.truncated || stderr.truncated,
    rawOutputTruncated: result.rawOutputTruncated,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    treeTerminated: result.treeTerminated,
    outputRefs: result.outputRefs,
    durationMs: result.durationMs,
    ...(result.error !== undefined ? { error: result.error } : {}),
  })
}

function startFailure(error: unknown): ProcessPortResult {
  return parseDurableProcessResult({
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTruncated: false,
    rawOutputTruncated: false,
    timedOut: false,
    cancelled: false,
    treeTerminated: false,
    outputRefs: [],
    durationMs: 0,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 4_096),
  })
}

function cancelledBeforeStart(reason: string): ProcessPortResult {
  return parseDurableProcessResult({
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTruncated: false,
    rawOutputTruncated: false,
    timedOut: false,
    cancelled: true,
    treeTerminated: false,
    outputRefs: [],
    durationMs: 0,
    error: reason.slice(0, 4_096),
  })
}

function appendOwnerOutputEvent(
  bootstrap: OwnerBootstrap,
  ownerInstanceId: string,
  stream: "stdout" | "stderr",
  delta: string,
): void {
  const ledger = workspaceLayout(bootstrap.scope.controlRoot).ledger
  for (let offset = 0; offset < delta.length; offset += MAX_LIVE_DELTA_CHARS) {
    appendEvent(ledger, {
      type: "tool.output.delta",
      scope: "run",
      streamId: bootstrap.scope.runId,
      workspaceId: bootstrap.scope.workspaceId,
      runId: bootstrap.scope.runId,
      documentId: bootstrap.scope.documentId,
      taskId: bootstrap.scope.taskId,
      attemptId: bootstrap.scope.attemptId,
      callId: bootstrap.binding.intentId,
      workerId: ownerInstanceId,
      correlationId: bootstrap.binding.intentId,
      payload: {
        schemaVersion: 1,
        source: "durable-process-owner",
        toolCallId: bootstrap.binding.intentId,
        stream,
        delta: delta.slice(offset, offset + MAX_LIVE_DELTA_CHARS),
      },
    })
  }
}

function appendOwnerOutputCompleted(
  bootstrap: OwnerBootstrap,
  ownerInstanceId: string,
  result: ProcessPortResult,
): void {
  appendEvent(workspaceLayout(bootstrap.scope.controlRoot).ledger, {
    type: "tool.output.completed",
    scope: "run",
    streamId: bootstrap.scope.runId,
    workspaceId: bootstrap.scope.workspaceId,
    runId: bootstrap.scope.runId,
    documentId: bootstrap.scope.documentId,
    taskId: bootstrap.scope.taskId,
    attemptId: bootstrap.scope.attemptId,
    callId: bootstrap.binding.intentId,
    workerId: ownerInstanceId,
    correlationId: bootstrap.binding.intentId,
    payload: {
      schemaVersion: 1,
      source: "durable-process-owner",
      toolCallId: bootstrap.binding.intentId,
      exitCode: result.exitCode ?? null,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      outputRefs: [...result.outputRefs],
    },
  })
}

function assertLeaseBinding(
  lifecycle: Extract<DurableProcessLifecycle, { state: "starting" | "running" | "settled" }>,
  paths: DurableProcessPaths,
  requireActive: boolean,
): void {
  const ledger = workspaceLayout(lifecycle.scope.controlRoot).ledger
  const lease = readDurableLease(ledger, lifecycle.leaseId)
  if (
    !lease ||
    lease.kind !== "worker" ||
    lease.resourceKey !== paths.resourceKey ||
    lease.workspaceId !== lifecycle.scope.workspaceId ||
    lease.runId !== lifecycle.scope.runId ||
    lease.ownerInstanceId !== lifecycle.ownerInstanceId ||
    lease.workerId !== lifecycle.ownerInstanceId ||
    lease.pid !== lifecycle.owner.pid ||
    lease.processStartToken !== lifecycle.owner.processStartToken ||
    !sameHost(lease.hostname, lifecycle.owner.hostname) ||
    !lease.scope.includes("tool-process:own") ||
    !lease.scope.includes(`tool-intent:${paths.intentDigest}`) ||
    (!requireActive && lease.status !== "active" && lease.status !== "released") ||
    (requireActive && (lease.status !== "active" || Date.now() >= Date.parse(lease.expiresAt)))
  ) {
    throw new Error("Durable process lifecycle is not backed by its exact owner lease")
  }
}

async function assertLiveOwner(
  lifecycle: Extract<DurableProcessLifecycle, { state: "starting" | "running" }>,
  paths: DurableProcessPaths,
): Promise<void> {
  assertLeaseBinding(lifecycle, paths, true)
  const probe = await probeProcessIdentity(lifecycle.owner)
  if (
    probe.status !== "alive" ||
    probe.observedProcessStartToken !== lifecycle.owner.processStartToken
  ) {
    throw new Error(`Durable process owner identity is not live: ${probe.reason}`)
  }
}

async function requestOwnerStopFromLifecycle(input: {
  paths: DurableProcessPaths
  scope: DurableProcessScope
  binding: DurableProcessBinding
  mode: "graceful" | "force"
  reason: string
}): Promise<"already-settled" | "requested"> {
  const lifecycle = await readLifecycle(input.paths.lifecycle)
  assertLifecycleBinding(lifecycle, input.scope, input.binding)
  if (lifecycle.state === "settled") return "already-settled"
  const reason = input.reason.trim().slice(0, 4_096) || `${input.mode} shutdown`
  await persistStopIntent({ ...input, lifecycle, reason })

  if (lifecycle.state !== "launching") {
    // The file is authoritative. The authenticated control request is only a
    // low-latency wake-up and must not hold forced shutdown behind OS helpers.
    void sendRunControlRequest({
      descriptorPath: input.paths.control,
      workspaceId: lifecycle.scope.workspaceId,
      runId: lifecycle.scope.runId,
      action: { kind: "stop", mode: input.mode, reason },
    }).catch(() => undefined)
  }
  return "requested"
}

type DurableShutdownRegistration = {
  request(mode: "graceful" | "force", reason: string): void
  flush(): Promise<void>
  unregister(): void
}

function registerDurableShutdown(
  paths: DurableProcessPaths,
  scope: DurableProcessScope,
  binding: DurableProcessBinding,
): DurableShutdownRegistration {
  let pending: { mode: "graceful" | "force"; reason: string } | undefined
  const request = (mode: "graceful" | "force", reason: string): void => {
    if (pending?.mode === "force" && mode === "graceful") return
    pending = { mode, reason: reason.trim().slice(0, 4_096) || `${mode} shutdown` }
  }
  const flush = async (): Promise<void> => {
    const current = pending
    if (!current) return
    try {
      await requestOwnerStopFromLifecycle({ paths, scope, binding, ...current })
    } catch (error) {
      // Registration deliberately precedes lifecycle creation. Keep the
      // pending request in memory so the creator can flush it after its
      // exclusive lifecycle write and before spawning the owner.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
  const unregister = processShutdownRegistry.register({
    async cancel(reason) {
      request("graceful", reason ?? "graceful shutdown")
      await flush()
    },
    async forceKill(reason) {
      request("force", reason ?? "force shutdown")
      await flush()
    },
  })
  return { request, flush, unregister }
}

async function waitForSettlement(
  paths: DurableProcessPaths,
  scope: DurableProcessScope,
  binding: DurableProcessBinding,
  signal?: AbortSignal,
  registeredShutdown?: DurableShutdownRegistration,
): Promise<Extract<DurableProcessLifecycle, { state: "settled" }>> {
  let cancellationSent = false
  let nextOwnerIdentityProbeAt = 0
  const shutdown = registeredShutdown ?? registerDurableShutdown(paths, scope, binding)
  try {
    while (true) {
      const lifecycle = await readLifecycle(paths.lifecycle)
      assertLifecycleBinding(lifecycle, scope, binding)
      if (lifecycle.state === "settled") {
        assertLeaseBinding(lifecycle, paths, false)
        return lifecycle
      }
      if (signal?.aborted && !cancellationSent) {
        const reason =
          signal.reason instanceof Error
            ? signal.reason.message
            : String(signal.reason ?? "cancelled")
        shutdown.request("graceful", reason)
        await shutdown.flush()
        cancellationSent = true
      }
      if (lifecycle.state === "launching") {
        const age = Date.now() - Date.parse(lifecycle.updatedAt)
        if (age >= STARTUP_TIMEOUT_MS) {
          const launcherProbe = await probeProcessIdentity(lifecycle.launcher)
          throw new Error(
            `Durable process launch did not establish an owner within the bounded startup window; replay is forbidden: ${launcherProbe.reason}`,
          )
        }
      } else {
        // Lifecycle settlement is polled frequently for responsive completion,
        // but a full start-token probe can spawn an OS helper on Windows/macOS.
        // Keep lease binding hot and perform the expensive identity proof once
        // per lease-renewal epoch rather than on every 200 ms poll.
        assertLeaseBinding(lifecycle, paths, true)
        const observedAt = Date.now()
        if (observedAt >= nextOwnerIdentityProbeAt) {
          await assertLiveOwner(lifecycle, paths)
          nextOwnerIdentityProbeAt = Date.now() + OWNER_IDENTITY_PROBE_INTERVAL_MS
        }
      }
      await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS))
    }
  } finally {
    if (!registeredShutdown) shutdown.unregister()
  }
}

async function spawnOwner(bootstrap: OwnerBootstrap): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(OwnerBootstrapSchema.parse(bootstrap)), "utf8")
  if (encoded.byteLength > MAX_BOOTSTRAP_BYTES) {
    throw new Error("Durable process bootstrap exceeds its private handoff limit")
  }
  const command = ownerLaunchCommand(bootstrap.scope.workspaceRoot)
  const owner = Bun.spawn(command, {
    cwd: bootstrap.scope.controlRoot,
    env: ownerEnvironment(),
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
    windowsHide: true,
  })
  try {
    await owner.stdin.write(encoded)
    await owner.stdin.end()
  } catch (error) {
    owner.kill()
    throw error
  }
  owner.unref()
}

/**
 * Command-supervisor side of the worker reverse RPC. Existing lifecycle state
 * is always reattached; only the process that atomically creates `launching`
 * may hand a one-use capability to a new independent owner.
 */
export async function executeDurableProcessParentCall(
  rawCall: unknown,
  authorityInput: DurableProcessAuthority,
): Promise<ProcessPortResult> {
  const call = DurableProcessParentCallSchema.parse(rawCall)
  const authority: DurableProcessAuthority = {
    ...authorityInput,
    scope: DurableProcessScopeSchema.parse(authorityInput.scope),
    binding: DurableProcessBindingSchema.parse(authorityInput.binding),
    command: WorkerCommandInvocationSchema.parse(authorityInput.command),
    telemetry: TelemetryConfigSchema.parse(authorityInput.telemetry),
  }
  assertAuthority(call, authority)
  await validateWorkspace(call.scope)
  assertDurableTargetExecutableOutsideWorkspace(call.scope.workspaceRoot, call.command.executable)
  const paths = processPaths(call.scope.controlRoot, call.scope.runId, call.binding.intentId)
  await ensureSafeDirectory(paths.directory)
  const commandFingerprint = workerCommandCapabilityFingerprint(
    call.scope.workspaceRoot,
    call.command,
  )
  const shutdown = registerDurableShutdown(paths, call.scope, call.binding)
  const flushPendingStop = async (): Promise<void> => {
    if (authority.signal?.aborted) {
      const reason =
        authority.signal.reason instanceof Error
          ? authority.signal.reason.message
          : String(authority.signal.reason ?? "cancelled")
      shutdown.request("graceful", reason)
    }
    await shutdown.flush()
  }
  try {
    const existing = await readLifecycleIfPresent(paths.lifecycle)
    if (existing) {
      assertLifecycleBinding(existing, call.scope, call.binding)
      if (existing.commandFingerprint !== commandFingerprint) {
        throw new Error("Durable process intent already exists with another command fingerprint")
      }
      await flushPendingStop()
      return projectDurableProcessResult(
        (await waitForSettlement(paths, call.scope, call.binding, authority.signal, shutdown))
          .result,
      )
    }

    const launcher = await captureProcessIdentity()
    const launchCapabilityToken = createWorkerCapabilityToken()
    const now = new Date().toISOString()
    const launching = LaunchingLifecycleSchema.parse({
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      state: "launching",
      scope: call.scope,
      binding: call.binding,
      commandFingerprint,
      launchCapabilityHash: hashWorkerCapabilityToken(launchCapabilityToken),
      launcher,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
    try {
      await writeLifecycle(paths.lifecycle, launching, false)
    } catch (error) {
      const raced = await readLifecycleIfPresent(paths.lifecycle)
      if (!raced) throw error
      assertLifecycleBinding(raced, call.scope, call.binding)
      if (raced.commandFingerprint !== commandFingerprint) {
        throw new Error("Racing durable process intent has another command fingerprint")
      }
      await flushPendingStop()
      return projectDurableProcessResult(
        (await waitForSettlement(paths, call.scope, call.binding, authority.signal, shutdown))
          .result,
      )
    }
    // Registration is already live, and any stop observed before lifecycle
    // creation is now persisted before the independent owner can be spawned.
    await flushPendingStop()
    await spawnOwner({
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      launchCapabilityToken,
      scope: call.scope,
      binding: call.binding,
      command: call.command,
      request: call.request,
    })
    return projectDurableProcessResult(
      (await waitForSettlement(paths, call.scope, call.binding, authority.signal, shutdown)).result,
    )
  } finally {
    shutdown.unregister()
  }
}

async function readOwnerBootstrap(): Promise<OwnerBootstrap> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of Bun.stdin.stream()) {
    const bytes = Buffer.from(chunk)
    total += bytes.byteLength
    if (total > MAX_BOOTSTRAP_BYTES) throw new Error("Durable process bootstrap is too large")
    chunks.push(bytes)
  }
  return OwnerBootstrapSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
}

async function removeOwnedControlDescriptor(
  path: string,
  descriptor: RunControlDescriptor,
): Promise<void> {
  const current = await inspectRunControlDescriptor(path).catch(() => undefined)
  if (
    current &&
    current.instanceId === descriptor.instanceId &&
    current.capabilityHash === descriptor.capabilityHash &&
    sameIdentity(current.process, descriptor.process)
  ) {
    await rm(path, { force: true })
  }
}

async function assertAuthorizedCwdImmediatelyBeforeSpawn(
  bootstrap: OwnerBootstrap,
): Promise<string> {
  const canonicalWorkspace = await realpath(bootstrap.scope.workspaceRoot)
  const canonicalCwd = await realpath(bootstrap.request.cwd)
  const info = await lstat(canonicalCwd)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Authorized durable process cwd is no longer a regular directory")
  }
  if (
    !samePath(canonicalCwd, bootstrap.request.cwd) ||
    !samePath(canonicalCwd, bootstrap.command.cwd) ||
    !pathWithin(canonicalWorkspace, canonicalCwd)
  ) {
    throw new Error(
      "Authorized durable process cwd changed, traverses a link, or escaped the execution workspace before spawn",
    )
  }
  return canonicalCwd
}

async function ownDurableProcess(bootstrap: OwnerBootstrap): Promise<void> {
  await validateWorkspace(bootstrap.scope)
  const paths = processPaths(
    bootstrap.scope.controlRoot,
    bootstrap.scope.runId,
    bootstrap.binding.intentId,
  )
  const launching = await readLifecycle(paths.lifecycle)
  if (launching.state !== "launching") {
    throw new Error("Durable process owner refuses a lifecycle that has already advanced")
  }
  assertLifecycleBinding(launching, bootstrap.scope, bootstrap.binding)
  const commandFingerprint = workerCommandCapabilityFingerprint(
    bootstrap.scope.workspaceRoot,
    bootstrap.command,
  )
  if (
    launching.commandFingerprint !== commandFingerprint ||
    !matchesWorkerCapabilityToken(bootstrap.launchCapabilityToken, launching.launchCapabilityHash)
  ) {
    throw new Error("Durable process owner bootstrap capability or command binding is invalid")
  }
  if (
    !samePath(bootstrap.request.executable, bootstrap.command.executable) ||
    !samePath(bootstrap.request.cwd, bootstrap.command.cwd) ||
    !sameStrings(bootstrap.request.args, bootstrap.command.args) ||
    workerExecutableContentHash(bootstrap.request.executable) !== bootstrap.command.executableHash
  ) {
    throw new Error("Durable process executable changed between authorization and owner start")
  }
  assertDurableTargetExecutableOutsideWorkspace(
    bootstrap.scope.workspaceRoot,
    bootstrap.request.executable,
  )

  const owner = await captureProcessIdentity()
  const ownerInstanceId = `tool-process-${paths.intentDigest}-${randomUUID()}`
  const ownerIdentity = {
    ownerInstanceId,
    pid: owner.pid,
    processStartToken: owner.processStartToken,
    hostname: owner.hostname,
  }
  const leaseResult = await acquireDurableLease(
    workspaceLayout(bootstrap.scope.controlRoot).ledger,
    {
      ...ownerIdentity,
      kind: "worker",
      resourceKey: paths.resourceKey,
      workspaceId: bootstrap.scope.workspaceId,
      runId: bootstrap.scope.runId,
      workerId: ownerInstanceId,
      command: "ralph internal durable process owner",
      scope: ["tool-process:own", `tool-intent:${paths.intentDigest}`],
      leaseDurationMs: LEASE_DURATION_MS,
      staleGraceMs: LEASE_GRACE_MS,
    },
    { probeOwner: probeProcessIdentity },
  )
  const startedAt = new Date().toISOString()
  let lifecycle: Extract<DurableProcessLifecycle, { state: "starting" | "running" | "settled" }> =
    StartingLifecycleSchema.parse({
      ...launching,
      state: "starting",
      ownerInstanceId,
      owner,
      leaseId: leaseResult.lease.id,
      startedAt,
      revision: launching.revision + 1,
      updatedAt: startedAt,
    })
  await writeLifecycle(paths.lifecycle, lifecycle, true)

  const cancellation = new AbortController()
  let processHandle: SupervisedProcessHandle | undefined
  let renewing = false
  let leaseFailure: unknown
  const renew = setInterval(() => {
    if (renewing) return
    renewing = true
    try {
      renewDurableLease(
        workspaceLayout(bootstrap.scope.controlRoot).ledger,
        leaseResult.lease.id,
        ownerIdentity,
        LEASE_DURATION_MS,
        LEASE_GRACE_MS,
      )
    } catch (error) {
      leaseFailure = error
      if (!cancellation.signal.aborted) cancellation.abort(error)
    } finally {
      renewing = false
    }
  }, LEASE_RENEW_INTERVAL_MS)

  let control: Awaited<ReturnType<typeof startRunControlServer>>
  try {
    control = await startRunControlServer({
      workspaceId: bootstrap.scope.workspaceId,
      runId: bootstrap.scope.runId,
      instanceId: ownerInstanceId,
      process: owner,
      async publish(descriptor) {
        await writeExclusiveJson(paths.control, descriptor)
      },
      async unpublish(descriptor) {
        await removeOwnedControlDescriptor(paths.control, descriptor)
      },
      async handle(request) {
        if (request.action.kind !== "stop") {
          throw new Error("Durable process owner accepts only authenticated stop requests")
        }
        const reason = `Durable process ${request.action.mode} stop: ${request.action.reason}`
        if (!cancellation.signal.aborted) cancellation.abort(new Error(reason))
        if (request.action.mode === "force") await processHandle?.forceKill(reason)
        else await processHandle?.cancel(reason)
        return { disposition: "requested", intentId: bootstrap.binding.intentId }
      },
    })
  } catch (error) {
    clearInterval(renew)
    const finishedAt = new Date().toISOString()
    await writeLifecycle(
      paths.lifecycle,
      SettledLifecycleSchema.parse({
        ...lifecycle,
        state: "settled",
        result: startFailure(error),
        finishedAt,
        revision: lifecycle.revision + 1,
        updatedAt: finishedAt,
      }),
      true,
    )
    releaseDurableLease(
      workspaceLayout(bootstrap.scope.controlRoot).ledger,
      leaseResult.lease.id,
      ownerIdentity,
    )
    return
  }

  let result: ProcessPortResult | undefined
  let stopObservationFailure: unknown
  let stopIntentApplication: Promise<DurableProcessStopIntent | undefined> | undefined
  let appliedStopRequestId: string | undefined
  let stopWatcher: ReturnType<typeof setInterval> | undefined
  const applyPersistedStopIntent = (): Promise<DurableProcessStopIntent | undefined> => {
    if (stopIntentApplication) return stopIntentApplication
    const application = (async () => {
      const intent = await readStopIntentIfPresent(paths.stopIntent)
      if (!intent) return undefined
      assertStopIntentBinding(intent, lifecycle, bootstrap.scope, bootstrap.binding)
      if (intent.requestId === appliedStopRequestId) return intent
      appliedStopRequestId = intent.requestId
      const reason = `Durable process ${intent.mode} stop: ${intent.reason}`
      if (!cancellation.signal.aborted) cancellation.abort(new Error(reason))
      if (intent.mode === "force") await processHandle?.forceKill(reason)
      else await processHandle?.cancel(reason)
      return intent
    })().finally(() => {
      stopIntentApplication = undefined
    })
    stopIntentApplication = application
    return application
  }
  const observePersistedStop = (): void => {
    void applyPersistedStopIntent().catch((error) => {
      stopObservationFailure ??= error
      const reason = `Durable stop intent could not be trusted: ${
        error instanceof Error ? error.message : String(error)
      }`
      if (!cancellation.signal.aborted) cancellation.abort(new Error(reason))
      if (processHandle) void processHandle.forceKill(reason).catch(() => undefined)
    })
  }
  const unregisterRedaction = registerLedgerRedactionSecrets(
    workspaceLayout(bootstrap.scope.controlRoot).ledger,
    bootstrap.request.secretValues,
  )
  try {
    const supervisor = createWorkspaceBunProcessSupervisor({
      workspaceRoot: bootstrap.scope.controlRoot,
      runId: bootstrap.scope.runId,
      secretValues: bootstrap.request.secretValues,
      persistRawOutput: rawPersistenceEnabled(bootstrap.request.telemetry),
      retention: resolveDiagnosticRawRetention(bootstrap.request.telemetry),
    })
    const initialStop = await applyPersistedStopIntent()
    if (initialStop) {
      result = cancelledBeforeStart(
        `Durable process ${initialStop.mode} stop: ${initialStop.reason}`,
      )
    } else {
      stopWatcher = setInterval(observePersistedStop, POLL_INTERVAL_MS)
      const expectedCanonicalCwd = await assertAuthorizedCwdImmediatelyBeforeSpawn(bootstrap)
      const finalStop = await applyPersistedStopIntent()
      if (finalStop) {
        result = cancelledBeforeStart(`Durable process ${finalStop.mode} stop: ${finalStop.reason}`)
      } else {
        processHandle = await supervisor.start({
          executable: bootstrap.request.executable,
          expectedExecutableSha256: bootstrap.command.executableHash,
          args: bootstrap.request.args,
          cwd: bootstrap.request.cwd,
          expectedCanonicalCwd,
          environment: bootstrap.request.environment,
          ...(bootstrap.request.environmentRefs
            ? { environmentRefs: bootstrap.request.environmentRefs }
            : {}),
          shell: false,
          ...(bootstrap.request.stdin !== undefined ? { stdin: bootstrap.request.stdin } : {}),
          timeoutMs: bootstrap.request.timeoutMs,
          outputLimitBytes: bootstrap.request.outputLimitBytes,
          rawOutputLimitBytes: bootstrap.request.rawOutputLimitBytes,
          secretValues: bootstrap.request.secretValues,
          signal: cancellation.signal,
          onOutput(stream, delta) {
            appendOwnerOutputEvent(bootstrap, ownerInstanceId, stream, delta)
          },
        })
        if (!processHandle.pid) throw new Error("Durable process supervisor returned no child PID")
        let child: z.infer<typeof ProcessIdentitySchema> | undefined
        try {
          child = {
            pid: processHandle.pid,
            processStartToken: await processStartToken(processHandle.pid),
            hostname: localHostname(),
          }
        } catch {
          // Very short commands may settle before their child start token can be
          // observed. The owner identity and lease remain authoritative; retain
          // the exact supervisor settlement instead of inventing an error.
          result = projectSettlement(await processHandle.settlement)
        }
        if (child) {
          const runningAt = new Date().toISOString()
          lifecycle = RunningLifecycleSchema.parse({
            ...lifecycle,
            state: "running",
            child,
            revision: lifecycle.revision + 1,
            updatedAt: runningAt,
          })
          await writeLifecycle(paths.lifecycle, lifecycle, true)
          result = projectSettlement(await processHandle.settlement)
        }
      }
    }
  } catch (error) {
    result = processHandle
      ? await processHandle.settlement.then(projectSettlement).catch(() => startFailure(error))
      : startFailure(error)
  } finally {
    if (stopWatcher) clearInterval(stopWatcher)
    await stopIntentApplication?.catch(() => undefined)
    clearInterval(renew)
    unregisterRedaction()
  }

  let terminalResult =
    result ?? startFailure("Durable process owner produced no terminal settlement")
  if (leaseFailure && !terminalResult.error) {
    terminalResult = parseDurableProcessResult({
      ...terminalResult,
      error: `Durable process owner lost its lease: ${
        leaseFailure instanceof Error ? leaseFailure.message : String(leaseFailure)
      }`,
    })
  }
  if (stopObservationFailure && !terminalResult.error) {
    terminalResult = parseDurableProcessResult({
      ...terminalResult,
      error: `Durable stop observation failed closed: ${
        stopObservationFailure instanceof Error
          ? stopObservationFailure.message
          : String(stopObservationFailure)
      }`.slice(0, 4_096),
    })
  }
  try {
    appendOwnerOutputCompleted(bootstrap, ownerInstanceId, terminalResult)
  } catch {
    // Live/TUI event projection is observational; lifecycle settlement remains authoritative.
  }

  const finishedAt = new Date().toISOString()
  const settled = SettledLifecycleSchema.parse({
    ...lifecycle,
    state: "settled",
    result: terminalResult,
    finishedAt,
    revision: lifecycle.revision + 1,
    updatedAt: finishedAt,
  })
  await writeLifecycle(paths.lifecycle, settled, true)
  await control.close().catch(() => undefined)
  releaseDurableLease(
    workspaceLayout(bootstrap.scope.controlRoot).ledger,
    leaseResult.lease.id,
    ownerIdentity,
  )
}

/** Internal entrypoint; it is selected before normal CLI/worker dispatch. */
export async function runDurableProcessOwnerMain(): Promise<number> {
  if (process.env[OWNER_ENVIRONMENT_FLAG] !== "1") {
    throw new Error("Durable process owner entrypoint was called without its internal mode")
  }
  try {
    await ownDurableProcess(await readOwnerBootstrap())
    return 0
  } catch {
    // Bootstrap may contain secrets. Never echo its failure through inherited output.
    return 1
  }
}

async function validatedRecoveryState(input: DurableProcessRecoveryInput): Promise<{
  readonly paths: DurableProcessPaths
  readonly scope: DurableProcessScope
  readonly binding: DurableProcessBinding
  readonly lifecycle: DurableProcessLifecycle
}> {
  const scope = scopeForRecovery(input)
  const binding = bindingForRecovery(input)
  await validateWorkspace(scope)
  const paths = processPaths(scope.controlRoot, scope.runId, binding.intentId)
  const lifecycle = await readLifecycle(paths.lifecycle)
  assertLifecycleBinding(lifecycle, scope, binding)
  if (lifecycle.state !== "launching")
    assertLeaseBinding(lifecycle, paths, lifecycle.state !== "settled")
  return { paths, scope, binding, lifecycle }
}

export type DurableProcessStopIntentInput = DurableProcessRecoveryInput & {
  readonly mode: "graceful" | "force"
  readonly reason: string
}

export type DurableProcessJournalRecoveryInput = Omit<DurableProcessRecoveryInput, "workspaceRoot">

export class DurableProcessLifecycleMissingError extends Error {
  readonly code = "RALPH_DURABLE_PROCESS_LIFECYCLE_MISSING"

  constructor(
    readonly lifecyclePath: string,
    options?: { cause?: unknown },
  ) {
    super("No durable process lifecycle is bound to the journal intent", options)
    this.name = "DurableProcessLifecycleMissingError"
  }
}

/**
 * Resolves the execution workspace from the immutable lifecycle after binding
 * every identity available in the authoritative tool-call journal. Dormant
 * run control therefore never guesses a worktree path or scans process files.
 */
export async function resolveDurableProcessRecoveryFromJournal(
  input: DurableProcessJournalRecoveryInput,
): Promise<DurableProcessRecoveryInput> {
  const controlRoot = resolve(input.controlRoot)
  const binding = DurableProcessBindingSchema.parse({
    intentId: input.intentId,
    argumentsHash: input.argumentsHash,
    idempotencyKey: input.idempotencyKey,
  })
  const paths = processPaths(controlRoot, input.runId, binding.intentId)
  let lifecycle: DurableProcessLifecycle
  try {
    lifecycle = await readLifecycle(paths.lifecycle)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DurableProcessLifecycleMissingError(paths.lifecycle, { cause: error })
    }
    throw error
  }
  if (
    !samePath(lifecycle.scope.controlRoot, controlRoot) ||
    lifecycle.scope.workspaceId !== input.workspaceId ||
    lifecycle.scope.runId !== input.runId ||
    lifecycle.scope.documentId !== input.documentId ||
    lifecycle.scope.taskId !== input.taskId ||
    lifecycle.scope.attemptId !== input.attemptId ||
    !sameBinding(lifecycle.binding, binding)
  ) {
    throw new Error(
      "Durable process lifecycle does not match its authoritative journal scope and binding",
    )
  }
  await validateWorkspace(lifecycle.scope)
  if (lifecycle.state !== "launching") {
    assertLeaseBinding(lifecycle, paths, lifecycle.state !== "settled")
  }
  return {
    controlRoot: lifecycle.scope.controlRoot,
    workspaceRoot: lifecycle.scope.workspaceRoot,
    workspaceId: lifecycle.scope.workspaceId,
    runId: lifecycle.scope.runId,
    documentId: lifecycle.scope.documentId,
    taskId: lifecycle.scope.taskId,
    attemptId: lifecycle.scope.attemptId,
    intentId: lifecycle.binding.intentId,
    argumentsHash: lifecycle.binding.argumentsHash,
    idempotencyKey: lifecycle.binding.idempotencyKey,
    ...(input.signal ? { signal: input.signal } : {}),
  }
}

/**
 * Persists a lifecycle-bound stop request before using the authenticated
 * control channel as a best-effort low-latency wake-up. This is suitable for
 * dormant-run cleanup because the independent owner observes the file even
 * when the original command supervisor no longer exists.
 */
export async function stopDurableProcessIntent(
  input: DurableProcessStopIntentInput,
): Promise<"already-settled" | "requested"> {
  const state = await validatedRecoveryState(input)
  if (state.lifecycle.state === "settled") return "already-settled"
  return requestOwnerStopFromLifecycle({
    paths: state.paths,
    scope: state.scope,
    binding: state.binding,
    mode: input.mode,
    reason: input.reason,
  })
}

/** Exact PID + start-token + lease probe used by tool-journal reconciliation. */
export async function probeDurableProcessIntent(
  input: DurableProcessRecoveryInput,
): Promise<ProcessRecoveryProbeResult> {
  let state: Awaited<ReturnType<typeof validatedRecoveryState>>
  try {
    state = await validatedRecoveryState(input)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      identity: "unknown",
      reason:
        code === "ENOENT"
          ? "No durable process lifecycle is bound to this intent"
          : `Durable process lifecycle cannot be trusted: ${
              error instanceof Error ? error.message : String(error)
            }`,
    }
  }
  if (state.lifecycle.state === "settled") {
    return {
      identity: "same-settled",
      reason: "The exact leased process owner persisted a terminal settlement",
      ...(state.lifecycle.result.exitCode !== undefined
        ? { exitCode: state.lifecycle.result.exitCode }
        : {}),
      outputRefs: state.lifecycle.result.outputRefs,
    }
  }
  if (state.lifecycle.state === "launching") {
    const probe = await probeProcessIdentity(state.lifecycle.launcher)
    return {
      identity: "unknown",
      reason: `Process launch has no independently leased owner yet: ${probe.reason}`,
    }
  }
  const probe = await probeProcessIdentity(state.lifecycle.owner)
  if (
    probe.status === "alive" &&
    probe.observedProcessStartToken === state.lifecycle.owner.processStartToken
  ) {
    return {
      identity: "same-alive",
      reason: "Durable process owner PID, start token, host and active lease all match",
      ...(state.lifecycle.state === "running"
        ? { effectRefs: [`process:${state.lifecycle.child.pid}`] }
        : {}),
    }
  }
  if (probe.status === "identity-mismatch") {
    return { identity: "different-process", reason: probe.reason }
  }
  if (probe.status === "dead") {
    if (state.lifecycle.state === "starting") {
      return {
        identity: "unknown",
        reason:
          "The leased owner died while process start was not durably bound to a child identity; the effect may still be alive, so automatic settlement and replay are forbidden",
      }
    }
    if (state.lifecycle.state === "running") {
      const childProbe = await probeProcessIdentity(state.lifecycle.child)
      if (
        childProbe.status === "alive" &&
        childProbe.observedProcessStartToken === state.lifecycle.child.processStartToken
      ) {
        return {
          identity: "unknown",
          reason:
            "The leased owner died while its exact child identity remains alive; automatic settlement and replay are forbidden",
        }
      }
    }
    return { identity: "dead", reason: probe.reason }
  }
  return { identity: "unknown", reason: probe.reason }
}

/** Waits for the already-owned effect; it never spawns or replays a command. */
export async function reattachDurableProcessIntent(
  input: DurableProcessRecoveryInput,
): Promise<ProcessPortResult> {
  const state = await validatedRecoveryState(input)
  if (state.lifecycle.state === "settled") {
    return projectDurableProcessResult(state.lifecycle.result)
  }
  if (state.lifecycle.state === "launching") {
    throw new Error("Cannot reattach before an independent process owner has acquired its lease")
  }
  await assertLiveOwner(state.lifecycle, state.paths)
  return projectDurableProcessResult(
    (await waitForSettlement(state.paths, state.scope, state.binding, input.signal)).result,
  )
}
