import { isAbsolute } from "node:path"
import { BunProcessSupervisor, type ProcessSupervisor } from "@ralph-next/supervisor"
import type { GitCommandPort } from "./git-runtime"
import type { SandboxProcessPort } from "./sandbox-runtime"

const SUMMARY_LIMIT_BYTES = 2 * 1_024 * 1_024
const RAW_LIMIT_BYTES = 16 * 1_024 * 1_024
const SERIAL_GIT_WORKTREE_OPERATIONS = new Set([
  "add",
  "lock",
  "move",
  "prune",
  "remove",
  "repair",
  "unlock",
])

class GitWorktreeMutationQueue {
  #tail: Promise<void> = Promise.resolve()

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.#tail
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#tail = predecessor.then(() => current)
    await predecessor
    try {
      return await operation()
    } finally {
      release()
    }
  }
}

function mutatesGitWorktreeMetadata(args: readonly string[]): boolean {
  return args[0] === "worktree" && SERIAL_GIT_WORKTREE_OPERATIONS.has(args[1] ?? "")
}

function environmentNames(environment: Readonly<Record<string, string>>): string[] {
  return Object.keys(environment)
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort()
}

export function createSandboxProcessPort(
  supervisor: ProcessSupervisor = new BunProcessSupervisor(),
): SandboxProcessPort {
  return {
    which(executable) {
      const resolved = isAbsolute(executable) ? executable : supervisor.which(executable)
      return resolved ?? undefined
    },
    async run(input) {
      const settlement = await supervisor.run({
        executable: input.executable,
        args: input.args,
        cwd: input.cwd,
        environment: input.environment,
        environmentAllowlist: environmentNames(input.environment),
        shell: false,
        timeoutMs: input.timeoutMs,
        gracePeriodMs: 1_000,
        outputLimitBytes: input.outputLimitBytes ?? SUMMARY_LIMIT_BYTES,
        rawOutputLimitBytes: input.rawOutputLimitBytes ?? RAW_LIMIT_BYTES,
        ...(input.secretValues ? { secretValues: input.secretValues } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onOutput ? { onOutput: input.onOutput } : {}),
        ...(input.onChunk ? { onChunk: input.onChunk } : {}),
      })
      return {
        ...(settlement.exitCode !== undefined ? { exitCode: settlement.exitCode } : {}),
        ...(settlement.signal ? { signal: settlement.signal } : {}),
        stdout: settlement.stdout,
        stderr: settlement.stderr || settlement.error || "",
        rawStdout: settlement.rawStdout,
        rawStderr: settlement.rawStderr,
        stdoutBytes: settlement.stdoutBytes,
        stderrBytes: settlement.stderrBytes,
        outputTruncated: settlement.outputTruncated,
        rawOutputTruncated: settlement.rawOutputTruncated,
        outputRefs: settlement.outputRefs,
        timedOut: settlement.timedOut,
        cancelled: settlement.cancelled,
        treeTerminated: settlement.treeTerminated,
        durationMs: settlement.durationMs,
      }
    },
  }
}

export function createGitCommandPort(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  supervisor: ProcessSupervisor = new BunProcessSupervisor(),
): GitCommandPort {
  const executable = supervisor.which("git", environment)
  // `git worktree add/remove/...` mutate shared repository administration
  // files even when their branches and paths are distinct. Some Git/platform
  // combinations fail immediately on those internal lock races. Serialize
  // only that short metadata boundary; commands inside the isolated
  // worktrees, including executor work, remain parallel.
  const worktreeMutations = new GitWorktreeMutationQueue()
  return {
    async run(input) {
      if (!executable) {
        return {
          stdout: "",
          stderr: "Git executable is unavailable",
          timedOut: false,
          cancelled: false,
          durationMs: 0,
        }
      }
      const invoke = () =>
        supervisor.run({
          executable,
          args: input.args,
          cwd: input.cwd,
          environment,
          shell: false,
          timeoutMs: input.timeoutMs,
          gracePeriodMs: 1_000,
          outputLimitBytes: SUMMARY_LIMIT_BYTES,
          rawOutputLimitBytes: RAW_LIMIT_BYTES,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      const settlement = mutatesGitWorktreeMetadata(input.args)
        ? await worktreeMutations.run(invoke)
        : await invoke()
      return {
        ...(settlement.exitCode !== undefined ? { exitCode: settlement.exitCode } : {}),
        stdout: settlement.stdout,
        stderr: settlement.stderr || settlement.error || "",
        timedOut: settlement.timedOut,
        cancelled: settlement.cancelled,
        durationMs: settlement.durationMs,
        outputTruncated: settlement.outputTruncated,
        rawOutputTruncated: settlement.rawOutputTruncated,
      }
    },
  }
}
