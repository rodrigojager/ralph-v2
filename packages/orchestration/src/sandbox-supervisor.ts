import { relative } from "node:path"
import type { ResourceClaimSetRecord, SandboxCapability, SandboxConfig } from "@ralph-next/domain"
import {
  type ProcessSettlement,
  ProcessSettlementSchema,
  type ProcessSupervisor,
  type SupervisedProcessHandle,
  type SupervisedProcessRequest,
} from "@ralph-next/supervisor"
import { createSandboxProcessPort } from "./command-runtime-ports"
import {
  cleanupSandboxSession,
  prepareSandbox,
  runSandboxCommand,
  type SandboxProcessPort,
} from "./sandbox-runtime"

function durationMilliseconds(value: string): number {
  const match = /^([1-9]\d*)(ms|s|m|h|d)$/i.exec(value)
  if (!match) throw new Error(`Invalid sandbox duration: ${value}`)
  const amount = Number(match[1])
  const unit = match[2]?.toLocaleLowerCase("und")
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000
  const milliseconds = amount * multiplier
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error(`Sandbox duration cannot be represented safely: ${value}`)
  }
  return milliseconds
}

function portable(value: string): string {
  return value.replaceAll("\\", "/") || "."
}

function unsupportedSettlement(
  request: SupervisedProcessRequest,
  reason: string,
): ProcessSettlement {
  return ProcessSettlementSchema.parse({
    argv: [request.executable, ...request.args],
    cwd: request.cwd,
    stdout: "",
    stderr: "",
    rawStdout: "",
    rawStderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTruncated: false,
    rawOutputTruncated: false,
    timedOut: false,
    cancelled: false,
    treeTerminated: true,
    outputRefs: [],
    durationMs: 0,
    error: reason,
  })
}

export class CommandOwnedSandboxSupervisor implements ProcessSupervisor {
  readonly #ledgerPath: string
  readonly #workspaceId: string
  readonly #runId: string
  readonly #taskId: string
  readonly #attemptId: string
  readonly #workerId: string
  readonly #workspaceRoot: string
  readonly #config: SandboxConfig
  readonly #capability: SandboxCapability
  readonly #claimSet: ResourceClaimSetRecord
  readonly #host: ProcessSupervisor
  readonly #processPort: SandboxProcessPort

  constructor(input: {
    ledgerPath: string
    workspaceId: string
    runId: string
    taskId: string
    attemptId: string
    workerId: string
    workspaceRoot: string
    config: SandboxConfig
    capability: SandboxCapability
    claimSet: ResourceClaimSetRecord
    host: ProcessSupervisor
  }) {
    this.#ledgerPath = input.ledgerPath
    this.#workspaceId = input.workspaceId
    this.#runId = input.runId
    this.#taskId = input.taskId
    this.#attemptId = input.attemptId
    this.#workerId = input.workerId
    this.#workspaceRoot = input.workspaceRoot
    this.#config = input.config
    this.#capability = input.capability
    this.#claimSet = input.claimSet
    this.#host = input.host
    this.#processPort = createSandboxProcessPort(input.host)
  }

  which(
    executable: string,
    environment?: Readonly<Record<string, string | undefined>>,
  ): string | null {
    if (this.#config.provider === "process") return this.#host.which(executable, environment)
    const normalized = executable.trim()
    return normalized && !/[\0\r\n]/.test(normalized) ? normalized : null
  }

  async start(request: SupervisedProcessRequest): Promise<SupervisedProcessHandle> {
    const controller = new AbortController()
    const relay = () => controller.abort(request.signal?.reason)
    request.signal?.addEventListener("abort", relay, { once: true })
    if (request.signal?.aborted) relay()
    const settlement = this.run({ ...request, signal: controller.signal }).finally(() => {
      request.signal?.removeEventListener("abort", relay)
    })
    return {
      settlement,
      async cancel(reason) {
        controller.abort(reason ?? "Sandbox process cancellation requested")
        await settlement.catch(() => undefined)
      },
      async forceKill(reason) {
        controller.abort(reason ?? "Sandbox process force termination requested")
        await settlement.catch(() => undefined)
      },
    }
  }

  async run(request: SupervisedProcessRequest): Promise<ProcessSettlement> {
    if (request.shell !== false && request.shell !== undefined) {
      return unsupportedSettlement(
        request,
        "The sandbox boundary accepts direct argv only; shell scripts require a separately audited adapter",
      )
    }
    if (request.stdin !== undefined) {
      return unsupportedSettlement(
        request,
        "The sandbox boundary does not silently forward stdin; use a declared input artifact",
      )
    }
    const configuredTimeout = durationMilliseconds(this.#config.resources.timeout)
    const timeoutMs = Math.min(configuredTimeout, request.timeoutMs)
    const allowedEnvironment = Object.fromEntries(
      this.#config.environment_allowlist.flatMap((name) => {
        const value = request.environment[name]
        return value === undefined ? [] : [[name, value] as const]
      }),
    )
    const workingDirectory = portable(relative(this.#workspaceRoot, request.cwd))
    const mounts =
      this.#config.mounts.length > 0
        ? this.#config.mounts
        : [{ source: ".", target: "/workspace", mode: "read-write" as const }]
    const prepared = await prepareSandbox({
      ledgerPath: this.#ledgerPath,
      workspaceId: this.#workspaceId,
      runId: this.#runId,
      taskId: this.#taskId,
      attemptId: this.#attemptId,
      workerId: this.#workerId,
      spec: {
        schemaVersion: 1,
        backend: this.#config.provider,
        workspaceRoot: this.#workspaceRoot,
        workingDirectory,
        ...(this.#config.image ? { image: this.#config.image } : {}),
        mounts,
        network: {
          mode: this.#config.network_mode,
          destinations: this.#config.network_destinations,
        },
        environmentAllowlist: this.#config.environment_allowlist,
        environment: allowedEnvironment,
        resources: {
          ...(this.#config.resources.cpu_count
            ? { cpuCount: this.#config.resources.cpu_count }
            : {}),
          ...(this.#config.resources.memory_bytes
            ? { memoryBytes: this.#config.resources.memory_bytes }
            : {}),
          ...(this.#config.resources.process_count
            ? { processCount: this.#config.resources.process_count }
            : {}),
          timeoutMs,
        },
        ports: [],
        ...(this.#config.user ? { user: this.#config.user } : {}),
      },
      capability: this.#capability,
      claimSet: this.#claimSet,
      requireContainerIsolation: this.#config.require_container_isolation,
      requireNetworkIsolation: this.#config.require_network_isolation,
    })
    const started = performance.now()
    try {
      const executed = await runSandboxCommand({
        ledgerPath: this.#ledgerPath,
        prepared,
        processPort: this.#processPort,
        executable: request.executable,
        args: request.args,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.secretValues ? { secretValues: request.secretValues } : {}),
        outputLimitBytes: request.outputLimitBytes,
        rawOutputLimitBytes: request.rawOutputLimitBytes,
        ...(request.onOutput ? { onOutput: request.onOutput } : {}),
        ...(request.onChunk ? { onChunk: request.onChunk } : {}),
      })
      await cleanupSandboxSession({
        ledgerPath: this.#ledgerPath,
        session: executed.session,
        processPort: this.#processPort,
        workspaceRoot: this.#workspaceRoot,
      })
      const result = executed.result
      return ProcessSettlementSchema.parse({
        argv: [request.executable, ...request.args],
        cwd: request.cwd,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        ...(result.signal ? { signal: result.signal } : {}),
        stdout: result.stdout,
        stderr: result.stderr,
        rawStdout: result.rawStdout ?? result.stdout,
        rawStderr: result.rawStderr ?? result.stderr,
        stdoutBytes: result.stdoutBytes ?? Buffer.byteLength(result.stdout),
        stderrBytes: result.stderrBytes ?? Buffer.byteLength(result.stderr),
        outputTruncated: result.outputTruncated ?? false,
        rawOutputTruncated: result.rawOutputTruncated ?? false,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        treeTerminated: result.treeTerminated,
        outputRefs: [...(result.outputRefs ?? [])],
        durationMs: performance.now() - started,
      })
    } catch (error) {
      await cleanupSandboxSession({
        ledgerPath: this.#ledgerPath,
        session: prepared.session,
        processPort: this.#processPort,
        workspaceRoot: this.#workspaceRoot,
      }).catch(() => undefined)
      throw error
    }
  }
}
