import type { ProcessSupervisor } from "@ralph-next/supervisor"
import type { ProcessExecutorPort, ProcessPortRequest, ProcessPortResult } from "./contracts"

/** Keeps the tool host coupled to the supervisor port, never its Bun backend. */
export class SupervisorProcessExecutorAdapter implements ProcessExecutorPort {
  readonly #supervisor: ProcessSupervisor

  constructor(supervisor: ProcessSupervisor) {
    this.#supervisor = supervisor
  }

  async run(request: ProcessPortRequest): Promise<ProcessPortResult> {
    const result = await this.#supervisor.run({
      executable: request.executable,
      args: request.args,
      cwd: request.cwd,
      environment: request.environment,
      ...(request.environmentRefs ? { environmentRefs: request.environmentRefs } : {}),
      ...(request.shell !== undefined ? { shell: request.shell } : {}),
      ...(request.stdin !== undefined
        ? {
            stdin:
              typeof request.stdin === "string" ? request.stdin : Uint8Array.from(request.stdin),
          }
        : {}),
      timeoutMs: request.timeoutMs,
      outputLimitBytes: request.outputLimitBytes,
      rawOutputLimitBytes: request.rawOutputLimitBytes,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.secretValues ? { secretValues: request.secretValues } : {}),
      ...(request.onOutput ? { onOutput: request.onOutput } : {}),
    })
    return {
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.signal !== undefined ? { signal: result.signal } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      outputTruncated: result.outputTruncated,
      rawOutputTruncated: result.rawOutputTruncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      treeTerminated: result.treeTerminated,
      outputRefs: result.outputRefs,
      durationMs: result.durationMs,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }
  }

  which(
    executable: string,
    environment?: Readonly<Record<string, string | undefined>>,
  ): string | null {
    return this.#supervisor.which(executable, environment)
  }
}
