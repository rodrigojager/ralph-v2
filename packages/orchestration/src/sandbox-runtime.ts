import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  EXIT_CODES,
  type ExitCode,
  RalphError,
  type ResourceClaimSetRecord,
  type SandboxCapability,
  SandboxCapabilitySchema,
  type SandboxSessionRecord,
  SandboxSessionRecordSchema,
  type SandboxSpec,
  SandboxSpecSchema,
} from "@ralph/domain"
import { createSandboxSessionRecord, transitionSandboxSessionRecord } from "@ralph/persistence"
import { assertAutomaticCommandIsNonDestructive } from "./security-runtime"

export type SandboxCommandResult = {
  exitCode?: number
  signal?: string
  stdout: string
  stderr: string
  rawStdout?: string
  rawStderr?: string
  stdoutBytes?: number
  stderrBytes?: number
  outputTruncated?: boolean
  rawOutputTruncated?: boolean
  outputRefs?: readonly string[]
  timedOut: boolean
  cancelled: boolean
  treeTerminated: boolean
  durationMs: number
}

export interface SandboxProcessPort {
  which(executable: string): string | undefined
  run(input: {
    executable: string
    args: readonly string[]
    cwd: string
    environment: Readonly<Record<string, string>>
    timeoutMs: number
    outputLimitBytes?: number
    rawOutputLimitBytes?: number
    signal?: AbortSignal
    secretValues?: readonly string[]
    onOutput?: (stream: "stdout" | "stderr", delta: string) => void | Promise<void>
    onChunk?: (chunk: {
      sequence: number
      stream: "stdout" | "stderr"
      text: string
      bytes: number
      totalBytes: number
      at: string
    }) => void | Promise<void>
  }): Promise<SandboxCommandResult>
}

export type PreparedSandbox = {
  session: SandboxSessionRecord
  spec: SandboxSpec
  capability: SandboxCapability
  canonicalWorkspace: string
  canonicalWorkingDirectory: string
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`
}

function specHash(spec: SandboxSpec): string {
  return createHash("sha256")
    .update(`ralph.sandbox.spec.v1\0${canonicalJson(spec)}`)
    .digest("hex")
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function safeContainerName(runId: string, sessionId: string): string {
  const value = `ralph-${runId}-${sessionId}`
    .toLocaleLowerCase("und")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 120)
  if (!value) {
    throw new RalphError("RALPH_SANDBOX_ID_INVALID", "Sandbox identity cannot form a safe name", {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  return value
}

function containerClientEnvironment(
  containerEnvironment: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "HOME",
    "USERPROFILE",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "CONTAINER_HOST",
    "XDG_RUNTIME_DIR",
    "TMP",
    "TEMP",
  ]) {
    const value = process.env[name]
    if (value !== undefined) result[name] = value
  }
  return { ...result, ...containerEnvironment }
}

async function inspectContainerCapability(
  backend: "docker" | "podman",
  processPort: SandboxProcessPort,
  signal?: AbortSignal,
): Promise<SandboxCapability> {
  const executable = processPort.which(backend)
  if (!executable) {
    return SandboxCapabilitySchema.parse({
      schemaVersion: 1,
      backend,
      available: false,
      filesystemIsolation: "container",
      networkIsolation: "container",
      processIsolation: "container",
      supportsNetworkAllowlist: false,
      reason: `${backend} executable is not available`,
    })
  }
  const result = await processPort.run({
    executable,
    args: ["version", "--format", "{{.Server.Version}}"],
    cwd: process.cwd(),
    environment: containerClientEnvironment(),
    timeoutMs: 15_000,
    ...(signal ? { signal } : {}),
  })
  if (result.cancelled) {
    throw new RalphError(
      "RALPH_SANDBOX_CAPABILITY_DISCOVERY_CANCELLED",
      `${backend} capability discovery was cancelled`,
      { exitCode: EXIT_CODES.interrupted },
    )
  }
  const available = result.exitCode === 0 && !result.timedOut
  return SandboxCapabilitySchema.parse({
    schemaVersion: 1,
    backend,
    available,
    ...(available && result.stdout.trim() ? { version: result.stdout.trim().slice(0, 4_096) } : {}),
    filesystemIsolation: "container",
    networkIsolation: "container",
    processIsolation: "container",
    supportsNetworkAllowlist: false,
    ...(!available
      ? {
          reason: result.timedOut
            ? `${backend} capability discovery timed out`
            : result.stderr.trim() || `${backend} service is unavailable`,
        }
      : {}),
  })
}

export type SandboxCapabilityRequirements = {
  readonly backend: SandboxCapability["backend"]
  readonly requireContainerIsolation: boolean
  readonly requireNetworkIsolation: boolean
  readonly networkMode: SandboxSpec["network"]["mode"]
}

export type SandboxCapabilityProblem = {
  readonly code:
    | "RALPH_SANDBOX_CAPABILITY_UNAVAILABLE"
    | "RALPH_SANDBOX_ISOLATION_INSUFFICIENT"
    | "RALPH_SANDBOX_NETWORK_ISOLATION_INSUFFICIENT"
    | "RALPH_SANDBOX_NETWORK_ALLOWLIST_UNSUPPORTED"
  readonly message: string
  readonly exitCode: ExitCode
  readonly hint?: string
}

/** One shared compatibility decision for scheduler preflight, preparation and diagnostics. */
export function sandboxCapabilityProblem(input: {
  readonly capability: SandboxCapability
  readonly requirements: SandboxCapabilityRequirements
}): SandboxCapabilityProblem | undefined {
  const { capability, requirements } = input
  if (capability.backend !== requirements.backend || !capability.available) {
    return {
      code: "RALPH_SANDBOX_CAPABILITY_UNAVAILABLE",
      message: `Requested sandbox backend ${requirements.backend} is unavailable`,
      exitCode: EXIT_CODES.invalidUsage,
      hint: "Choose process isolation explicitly, start the configured container service, or select another available adapter.",
    }
  }
  if (requirements.requireContainerIsolation && capability.filesystemIsolation !== "container") {
    return {
      code: "RALPH_SANDBOX_ISOLATION_INSUFFICIENT",
      message: "Effective policy requires a container filesystem boundary",
      exitCode: EXIT_CODES.policyDenied,
    }
  }
  if (requirements.requireNetworkIsolation && capability.networkIsolation !== "container") {
    return {
      code: "RALPH_SANDBOX_NETWORK_ISOLATION_INSUFFICIENT",
      message: "Effective policy requires enforceable network isolation",
      exitCode: EXIT_CODES.policyDenied,
    }
  }
  if (requirements.networkMode === "allowlist" && !capability.supportsNetworkAllowlist) {
    return {
      code: "RALPH_SANDBOX_NETWORK_ALLOWLIST_UNSUPPORTED",
      message: `${requirements.backend} adapter cannot honestly enforce destination allowlists`,
      exitCode: EXIT_CODES.invalidUsage,
      hint: "Use network none, a separately configured allowlist-capable adapter, or an explicitly audited full network policy.",
    }
  }
  return undefined
}

export async function discoverSandboxCapabilities(
  processPort: SandboxProcessPort,
  signal?: AbortSignal,
): Promise<readonly SandboxCapability[]> {
  return Promise.all([
    discoverSandboxCapability(processPort, "process", signal),
    discoverSandboxCapability(processPort, "docker", signal),
    discoverSandboxCapability(processPort, "podman", signal),
  ])
}

/**
 * Discovers one explicitly selected backend using the same rules as run
 * preflight. Operational commands use this narrower entrypoint so `doctor`
 * does not probe unrelated container services.
 */
export async function discoverSandboxCapability(
  processPort: SandboxProcessPort,
  backend: SandboxCapability["backend"],
  signal?: AbortSignal,
): Promise<SandboxCapability> {
  if (signal?.aborted) {
    throw new RalphError(
      "RALPH_SANDBOX_CAPABILITY_DISCOVERY_CANCELLED",
      `${backend} capability discovery was cancelled`,
      { exitCode: EXIT_CODES.interrupted },
    )
  }
  if (backend !== "process") {
    return inspectContainerCapability(backend, processPort, signal)
  }
  return SandboxCapabilitySchema.parse({
    schemaVersion: 1,
    backend: "process",
    available: true,
    filesystemIsolation: "policy",
    networkIsolation: "none",
    processIsolation: "supervised",
    supportsNetworkAllowlist: false,
    reason:
      "Local process backend relies on Ralph path/command policy and supervised process trees; it is not a container boundary",
  })
}

async function validateSandboxPaths(spec: SandboxSpec): Promise<{
  workspace: string
  workingDirectory: string
  mounts: readonly { source: string; target: string; mode: "read-only" | "read-write" }[]
}> {
  const workspace = await realpath(resolve(spec.workspaceRoot))
  const workingDirectory = await realpath(resolve(workspace, spec.workingDirectory))
  if (!contained(workspace, workingDirectory)) {
    throw new RalphError(
      "RALPH_SANDBOX_CWD_ESCAPE",
      "Sandbox working directory resolves outside the canonical workspace",
      { exitCode: EXIT_CODES.policyDenied, file: workingDirectory },
    )
  }
  const mounts: { source: string; target: string; mode: "read-only" | "read-write" }[] = []
  for (const mount of spec.mounts) {
    const source = await realpath(resolve(workspace, mount.source))
    if (!contained(workspace, source)) {
      throw new RalphError(
        "RALPH_SANDBOX_MOUNT_ESCAPE",
        "Sandbox mount source resolves outside the workspace",
        { exitCode: EXIT_CODES.policyDenied, file: source },
      )
    }
    if (
      !mount.target.startsWith("/") ||
      /(^|\/)\.\.(\/|$)/.test(mount.target) ||
      mount.target.includes("\0") ||
      mount.target.includes(",")
    ) {
      throw new RalphError(
        "RALPH_SANDBOX_MOUNT_TARGET_INVALID",
        "Container mount target must be an absolute safe POSIX path without commas",
        { exitCode: EXIT_CODES.invalidUsage, details: { target: mount.target } },
      )
    }
    if (source.includes(",")) {
      throw new RalphError(
        "RALPH_SANDBOX_MOUNT_SOURCE_UNSUPPORTED",
        "Container CLI mount adapter cannot safely encode a source path containing a comma",
        { exitCode: EXIT_CODES.invalidUsage, file: source },
      )
    }
    mounts.push({ source, target: mount.target, mode: mount.mode })
  }
  return { workspace, workingDirectory, mounts }
}

function assertSandboxClaims(input: {
  claimSet: ResourceClaimSetRecord
  workspaceId: string
  ports: readonly number[]
}): void {
  if (input.claimSet.status !== "active") {
    throw new RalphError("RALPH_SANDBOX_CLAIM_INACTIVE", "Sandbox requires active claims", {
      exitCode: EXIT_CODES.conflict,
      details: { claimSetId: input.claimSet.id },
    })
  }
  const missingPorts = input.ports.filter(
    (port) =>
      !input.claimSet.claims.some(
        (claim) =>
          claim.kind === "port" &&
          claim.resourceKey.startsWith(`${input.workspaceId}:`) &&
          claim.resourceKey.endsWith(`:${port}`),
      ),
  )
  if (missingPorts.length > 0) {
    throw new RalphError(
      "RALPH_SANDBOX_PORT_CLAIM_MISSING",
      "Sandbox ports are not covered by active resource claims",
      {
        exitCode: EXIT_CODES.policyDenied,
        details: { claimSetId: input.claimSet.id, missingPorts },
      },
    )
  }
}

export async function prepareSandbox(input: {
  ledgerPath: string
  workspaceId: string
  runId: string
  taskId: string
  attemptId: string
  workerId: string
  spec: SandboxSpec
  capability: SandboxCapability
  claimSet: ResourceClaimSetRecord
  requireContainerIsolation: boolean
  requireNetworkIsolation: boolean
  now?: () => Date
  id?: () => string
}): Promise<PreparedSandbox> {
  const spec = SandboxSpecSchema.parse(input.spec)
  const capability = SandboxCapabilitySchema.parse(input.capability)
  const capabilityProblem = sandboxCapabilityProblem({
    capability,
    requirements: {
      backend: spec.backend,
      requireContainerIsolation: input.requireContainerIsolation,
      requireNetworkIsolation: input.requireNetworkIsolation,
      networkMode: spec.network.mode,
    },
  })
  if (capabilityProblem) {
    throw new RalphError(capabilityProblem.code, capabilityProblem.message, {
      exitCode: capabilityProblem.exitCode,
      details: { capability },
      ...(capabilityProblem.hint ? { hint: capabilityProblem.hint } : {}),
    })
  }
  assertSandboxClaims({
    claimSet: input.claimSet,
    workspaceId: input.workspaceId,
    ports: spec.ports,
  })
  const paths = await validateSandboxPaths(spec)
  const now = input.now ?? (() => new Date())
  const id = (input.id ?? (() => crypto.randomUUID()))()
  const timestamp = now().toISOString()
  let session = createSandboxSessionRecord(
    input.ledgerPath,
    SandboxSessionRecordSchema.parse({
      schemaVersion: 1,
      id,
      workspaceId: input.workspaceId,
      runId: input.runId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      workerId: input.workerId,
      backend: spec.backend,
      status: "preparing",
      capability,
      specHash: specHash(spec),
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 0,
    }),
  )
  session = transitionSandboxSessionRecord(input.ledgerPath, session.id, session.revision, {
    status: "ready",
    ...(spec.backend !== "process"
      ? { backendResourceId: safeContainerName(input.runId, session.id) }
      : {}),
    updatedAt: now().toISOString(),
  })
  return {
    session,
    spec,
    capability,
    canonicalWorkspace: paths.workspace,
    canonicalWorkingDirectory: paths.workingDirectory,
  }
}

function minimalEnvironment(spec: SandboxSpec): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of spec.environmentAllowlist) {
    const value = spec.environment[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

function containerMountArgs(
  mounts: readonly { source: string; target: string; mode: "read-only" | "read-write" }[],
): string[] {
  return mounts.flatMap((mount) => [
    "--mount",
    `type=bind,source=${mount.source},target=${mount.target}${mount.mode === "read-only" ? ",readonly" : ""}`,
  ])
}

function containerResourceArgs(spec: SandboxSpec): string[] {
  const args: string[] = []
  if (spec.resources.cpuCount !== undefined) args.push("--cpus", String(spec.resources.cpuCount))
  if (spec.resources.memoryBytes !== undefined)
    args.push("--memory", String(spec.resources.memoryBytes))
  if (spec.resources.processCount !== undefined) {
    args.push("--pids-limit", String(spec.resources.processCount))
  }
  return args
}

function portableRelative(root: string, target: string): string {
  return relative(root, target).replaceAll("\\", "/")
}

function containerWorkingDirectory(
  workingDirectory: string,
  mounts: readonly { source: string; target: string; mode: "read-only" | "read-write" }[],
): string {
  const mount = mounts
    .filter((candidate) => contained(candidate.source, workingDirectory))
    .sort((left, right) => right.source.length - left.source.length)[0]
  if (!mount) {
    throw new RalphError(
      "RALPH_SANDBOX_CWD_UNMOUNTED",
      "Container working directory is not contained by any declared mount",
      { exitCode: EXIT_CODES.invalidUsage, details: { workingDirectory } },
    )
  }
  const child = portableRelative(mount.source, workingDirectory)
  return child ? `${mount.target.replace(/\/+$/, "")}/${child}` : mount.target
}

export async function runSandboxCommand(input: {
  ledgerPath: string
  prepared: PreparedSandbox
  processPort: SandboxProcessPort
  executable: string
  args: readonly string[]
  signal?: AbortSignal
  secretValues?: readonly string[]
  outputLimitBytes?: number
  rawOutputLimitBytes?: number
  onOutput?: (stream: "stdout" | "stderr", delta: string) => void | Promise<void>
  onChunk?: (chunk: {
    sequence: number
    stream: "stdout" | "stderr"
    text: string
    bytes: number
    totalBytes: number
    at: string
  }) => void | Promise<void>
  now?: () => Date
}): Promise<{ session: SandboxSessionRecord; result: SandboxCommandResult }> {
  assertAutomaticCommandIsNonDestructive(input.executable, input.args)
  const now = input.now ?? (() => new Date())
  let session = transitionSandboxSessionRecord(
    input.ledgerPath,
    input.prepared.session.id,
    input.prepared.session.revision,
    { status: "running", updatedAt: now().toISOString() },
  )
  const environment = minimalEnvironment(input.prepared.spec)
  const redactionValues = [
    ...new Set([...(input.secretValues ?? []), ...Object.values(environment)].filter(Boolean)),
  ]
  let request: Parameters<SandboxProcessPort["run"]>[0]
  if (input.prepared.spec.backend === "process") {
    const resolvedExecutable = isAbsolute(input.executable)
      ? input.executable
      : input.processPort.which(input.executable)
    if (!resolvedExecutable || !isAbsolute(resolvedExecutable)) {
      throw new RalphError(
        "RALPH_SANDBOX_EXECUTABLE_UNRESOLVED",
        "Local process sandbox requires an executable resolved to an absolute path",
        { exitCode: EXIT_CODES.policyDenied, details: { executable: input.executable } },
      )
    }
    request = {
      executable: resolvedExecutable,
      args: input.args,
      cwd: input.prepared.canonicalWorkingDirectory,
      environment,
      timeoutMs: input.prepared.spec.resources.timeoutMs,
      ...(input.outputLimitBytes ? { outputLimitBytes: input.outputLimitBytes } : {}),
      ...(input.rawOutputLimitBytes ? { rawOutputLimitBytes: input.rawOutputLimitBytes } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(redactionValues.length > 0 ? { secretValues: redactionValues } : {}),
      ...(input.onOutput ? { onOutput: input.onOutput } : {}),
      ...(input.onChunk ? { onChunk: input.onChunk } : {}),
    }
  } else {
    const backend = input.prepared.spec.backend
    const executable = input.processPort.which(backend)
    if (!executable || !input.prepared.session.backendResourceId || !input.prepared.spec.image) {
      throw new RalphError(
        "RALPH_SANDBOX_CAPABILITY_LOST",
        "Container capability disappeared after sandbox preparation",
        { exitCode: EXIT_CODES.operationalError, details: { backend } },
      )
    }
    const mounts = await validateSandboxPaths(input.prepared.spec)
    const envArgs = Object.keys(environment)
      .sort()
      .flatMap((name) => ["--env", name])
    const networkArgs = input.prepared.spec.network.mode === "none" ? ["--network", "none"] : []
    const portArgs = input.prepared.spec.ports.flatMap((port) => [
      "--publish",
      `127.0.0.1:${port}:${port}`,
    ])
    request = {
      executable,
      args: [
        "run",
        "--name",
        input.prepared.session.backendResourceId,
        "--label",
        `io.ralph.workspace=${input.prepared.session.workspaceId}`,
        "--label",
        `io.ralph.run=${input.prepared.session.runId}`,
        "--label",
        `io.ralph.session=${input.prepared.session.id}`,
        "--label",
        `io.ralph.worker=${input.prepared.session.workerId}`,
        ...containerMountArgs(mounts.mounts),
        ...networkArgs,
        ...containerResourceArgs(input.prepared.spec),
        ...portArgs,
        ...envArgs,
        ...(input.prepared.spec.user ? ["--user", input.prepared.spec.user] : []),
        "--workdir",
        containerWorkingDirectory(input.prepared.canonicalWorkingDirectory, mounts.mounts),
        input.prepared.spec.image,
        input.executable,
        ...input.args,
      ],
      cwd: input.prepared.canonicalWorkspace,
      environment: containerClientEnvironment(environment),
      timeoutMs: input.prepared.spec.resources.timeoutMs,
      ...(input.outputLimitBytes ? { outputLimitBytes: input.outputLimitBytes } : {}),
      ...(input.rawOutputLimitBytes ? { rawOutputLimitBytes: input.rawOutputLimitBytes } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(redactionValues.length > 0 ? { secretValues: redactionValues } : {}),
      ...(input.onOutput ? { onOutput: input.onOutput } : {}),
      ...(input.onChunk ? { onChunk: input.onChunk } : {}),
    }
  }
  try {
    const result = await input.processPort.run(request)
    session = transitionSandboxSessionRecord(input.ledgerPath, session.id, session.revision, {
      status: result.exitCode === 0 && !result.timedOut && !result.cancelled ? "stopped" : "failed",
      ...(result.exitCode === 0 && !result.timedOut && !result.cancelled
        ? {}
        : {
            failureReason: result.timedOut
              ? "Sandbox command timed out"
              : result.cancelled
                ? "Sandbox command was cancelled"
                : result.stderr.slice(0, 4_096) || "Sandbox command failed",
          }),
      // treeTerminated records whether the supervisor had to terminate a live
      // tree. A naturally exited process has treeTerminated=false, while its
      // durable exit code still confirms there is no running command to clean.
      terminationConfirmed: result.treeTerminated || result.exitCode !== undefined,
      updatedAt: now().toISOString(),
    })
    return { session, result }
  } catch (error) {
    transitionSandboxSessionRecord(input.ledgerPath, session.id, session.revision, {
      status: "orphaned",
      terminationConfirmed: false,
      failureReason: error instanceof Error ? error.message : String(error),
      updatedAt: now().toISOString(),
    })
    throw error
  }
}

export async function cleanupSandboxSession(input: {
  ledgerPath: string
  session: SandboxSessionRecord
  processPort: SandboxProcessPort
  workspaceRoot: string
  signal?: AbortSignal
  now?: () => Date
}): Promise<SandboxSessionRecord> {
  if (input.session.backend === "process") {
    if (input.session.terminationConfirmed === true) return input.session
    throw new RalphError(
      "RALPH_SANDBOX_PROCESS_TERMINATION_UNCONFIRMED",
      "Local sandbox process termination cannot be inferred from session status",
      {
        exitCode: EXIT_CODES.interrupted,
        details: { sandboxSessionId: input.session.id, status: input.session.status },
      },
    )
  }
  const expectedResource = safeContainerName(input.session.runId, input.session.id)
  if (input.session.backendResourceId !== expectedResource) {
    throw new RalphError(
      "RALPH_SANDBOX_CLEANUP_IDENTITY_MISMATCH",
      "Sandbox cleanup refuses an unverified backend resource ID",
      { exitCode: EXIT_CODES.policyDenied, details: { expectedResource } },
    )
  }
  const executable = input.processPort.which(input.session.backend)
  if (!executable) {
    throw new RalphError(
      "RALPH_SANDBOX_CAPABILITY_UNAVAILABLE",
      "Container backend is unavailable during cleanup",
      { exitCode: EXIT_CODES.operationalError },
    )
  }
  const workspace = await realpath(resolve(input.workspaceRoot))
  const inspect = await input.processPort.run({
    executable,
    args: [
      "inspect",
      "--format",
      '{{.Name}}|{{index .Config.Labels "io.ralph.workspace"}}|{{index .Config.Labels "io.ralph.run"}}|{{index .Config.Labels "io.ralph.session"}}|{{index .Config.Labels "io.ralph.worker"}}',
      expectedResource,
    ],
    cwd: workspace,
    environment: containerClientEnvironment(),
    timeoutMs: 30_000,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  if (inspect.exitCode === 0) {
    const [rawName, workspaceId, runId, sessionId, workerId] = inspect.stdout.trim().split("|")
    const observedName = rawName?.replace(/^\//, "")
    if (
      observedName !== expectedResource ||
      workspaceId !== input.session.workspaceId ||
      runId !== input.session.runId ||
      sessionId !== input.session.id ||
      workerId !== input.session.workerId
    ) {
      throw new RalphError(
        "RALPH_SANDBOX_CLEANUP_IDENTITY_MISMATCH",
        "Container inspect returned a different ownership identity",
        {
          exitCode: EXIT_CODES.policyDenied,
          details: {
            expectedResource,
            observedName,
            workspaceId,
            runId,
            sessionId,
            workerId,
          },
        },
      )
    }
    const stop = await input.processPort.run({
      executable,
      args: ["stop", "--time", "10", expectedResource],
      cwd: workspace,
      environment: containerClientEnvironment(),
      timeoutMs: 30_000,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (stop.exitCode !== 0 && !/not running/i.test(stop.stderr)) {
      throw new RalphError("RALPH_SANDBOX_CLEANUP_FAILED", "Container stop failed", {
        exitCode: EXIT_CODES.operationalError,
        details: { stderr: stop.stderr.slice(0, 4_096) },
      })
    }
    const remove = await input.processPort.run({
      executable,
      args: ["rm", expectedResource],
      cwd: workspace,
      environment: containerClientEnvironment(),
      timeoutMs: 30_000,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (remove.exitCode !== 0) {
      throw new RalphError("RALPH_SANDBOX_CLEANUP_FAILED", "Container removal failed", {
        exitCode: EXIT_CODES.operationalError,
        details: { stderr: remove.stderr.slice(0, 4_096) },
      })
    }
  } else if (!/no such|not found/i.test(inspect.stderr)) {
    throw new RalphError("RALPH_SANDBOX_CLEANUP_FAILED", "Container inspection failed", {
      exitCode: EXIT_CODES.operationalError,
      details: { stderr: inspect.stderr.slice(0, 4_096) },
    })
  }
  return transitionSandboxSessionRecord(
    input.ledgerPath,
    input.session.id,
    input.session.revision,
    {
      status: "stopped",
      terminationConfirmed: true,
      updatedAt: (input.now ?? (() => new Date()))().toISOString(),
    },
  )
}
