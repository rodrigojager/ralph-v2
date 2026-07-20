import type { CommandSpec, VerificationSpec } from "@ralph-next/prd"
import type { GateExecutionContext, GateExecutionOutcome } from "./gate-contracts"
import { pathWithinPortableScope, portablePath } from "./path-safety"
import { runStructuredCommand } from "./process"

type GitSpecification = Extract<VerificationSpec, { type: "git" }>

function gitCommand(args: string[], timeoutMs: number): CommandSpec {
  return {
    executable: "git",
    args,
    timeoutMs,
    successExitCodes: [0],
    outputLimitBytes: 1024 * 1024,
  }
}

async function persistOutput(
  specification: GitSpecification,
  context: GateExecutionContext,
  stdout: string,
  stderr: string,
): Promise<string[]> {
  if (!context.persistOutput) return []
  const refs: string[] = []
  if (stdout) refs.push(await context.persistOutput(specification.id, "stdout", stdout))
  if (stderr) refs.push(await context.persistOutput(specification.id, "stderr", stderr))
  return refs
}

function statusPaths(output: string): { paths: string[]; conflicts: string[] } {
  const tokens = output.split("\0").filter(Boolean)
  const paths: string[] = []
  const conflicts: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ""
    const status = token.slice(0, 2)
    const path = portablePath(token.slice(3))
    if (path) paths.push(path)
    if (status.includes("U") || ["AA", "DD"].includes(status)) conflicts.push(path)
    if (status.includes("R") || status.includes("C")) {
      const previous = tokens[index + 1]
      if (previous) {
        paths.push(portablePath(previous))
        index += 1
      }
    }
  }
  return { paths: [...new Set(paths)], conflicts: [...new Set(conflicts)] }
}

export async function executeGitGate(
  specification: GitSpecification,
  context: GateExecutionContext,
): Promise<GateExecutionOutcome> {
  const expectation = specification.expectation
  const command = gitCommand(
    expectation.kind === "branch"
      ? ["symbolic-ref", "--quiet", "--short", "HEAD"]
      : ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    specification.timeoutMs ?? 10_000,
  )
  const execution = await runStructuredCommand(command, {
    workspaceRoot: context.workspaceRoot,
    signal: context.signal,
    ...(context.environment ? { environment: context.environment } : {}),
    ...(context.environmentRoot ? { environmentRoot: context.environmentRoot } : {}),
    ...(context.rawOutputLimitBytes ? { rawOutputLimitBytes: context.rawOutputLimitBytes } : {}),
    ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
  })
  const outputRefs = await persistOutput(
    specification,
    context,
    execution.rawStdout,
    execution.rawStderr,
  )
  const shared = {
    command,
    ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
    outputRefs,
    stdoutBytes: execution.stdoutBytes,
    stderrBytes: execution.stderrBytes,
    outputTruncated: execution.truncated,
    rawOutputTruncated: execution.rawTruncated,
    deadlineExceeded: execution.deadlineExceeded,
  }
  if (execution.error) return { ...shared, status: "unavailable", reason: execution.error }
  if (execution.deadlineExceeded) {
    return { ...shared, status: "timeout", reason: "Task execution deadline was exceeded" }
  }
  if (execution.timedOut) return { ...shared, status: "timeout", reason: "Git gate timed out" }
  if (execution.rawTruncated) {
    return {
      ...shared,
      status: "unavailable",
      reason: "Git gate output exceeded the raw evidence limit",
    }
  }
  if (execution.exitCode !== 0) {
    if (expectation.kind === "branch" && execution.exitCode === 1) {
      return {
        ...shared,
        status: "failed",
        reason: `Git branch mismatch; expected ${expectation.value}, observed <detached>`,
      }
    }
    return {
      ...shared,
      status: "unavailable",
      reason: `Git command failed with exit code ${String(execution.exitCode)}: ${execution.stderr.trim()}`,
    }
  }

  if (expectation.kind === "branch") {
    const observed = execution.stdout.trim()
    const expected = expectation.value
    return observed === expected
      ? { ...shared, status: "passed" }
      : {
          ...shared,
          status: "failed",
          reason: `Git branch mismatch; expected ${expected}, observed ${observed || "<detached>"}`,
        }
  }

  const facts = statusPaths(execution.rawStdout)
  if (expectation.kind === "clean") {
    return facts.paths.length === 0
      ? { ...shared, status: "passed" }
      : {
          ...shared,
          status: "failed",
          reason: `Git workspace is not clean: ${facts.paths.join(", ")}`,
        }
  }
  if (expectation.kind === "changed") {
    return facts.paths.length > 0
      ? { ...shared, status: "passed" }
      : { ...shared, status: "failed", reason: "Git workspace has no changes" }
  }
  if (expectation.kind === "no-conflicts") {
    return facts.conflicts.length === 0
      ? { ...shared, status: "passed" }
      : {
          ...shared,
          status: "failed",
          reason: `Git workspace has unresolved conflicts: ${facts.conflicts.join(", ")}`,
        }
  }
  if (expectation.kind !== "paths-within") {
    return { ...shared, status: "error", reason: "Unsupported Git expectation" }
  }
  const outside = facts.paths.filter(
    (path) => !expectation.paths.some((scope) => pathWithinPortableScope(path, scope)),
  )
  if ((expectation.requireChanges ?? true) && facts.paths.length === 0) {
    return { ...shared, status: "failed", reason: "Git workspace has no changes" }
  }
  return outside.length === 0
    ? { ...shared, status: "passed" }
    : {
        ...shared,
        status: "failed",
        reason: `Git changes escaped allowed paths: ${outside.join(", ")}`,
      }
}
