import { basename } from "node:path"
import { z } from "zod"
import type { CommandRule, PermissionFacts, ProcessPortRequest } from "../contracts"
import { ToolHostError } from "../errors"
import { jsonInputSchema, type RegisteredTool, type ToolRuntimeContext } from "../registry"

const ProcessCommonSchema = {
  cwd: z.string().min(1).max(4_096).default("."),
  timeoutMs: z.number().int().positive().optional(),
  outputLimitBytes: z.number().int().positive().optional(),
  stdin: z
    .string()
    .max(4 * 1_024 * 1_024)
    .optional(),
}

const DirectProcessSchema = z
  .object({
    mode: z.literal("direct"),
    executable: z.string().min(1).max(4_096),
    args: z.array(z.string().max(65_536)).max(1_024).default([]),
    ...ProcessCommonSchema,
  })
  .strict()

const ShellProcessSchema = z
  .object({
    mode: z.literal("shell"),
    shell: z
      .object({
        kind: z.enum(["powershell", "cmd", "sh", "bash", "custom"]),
        executable: z.string().min(1).max(4_096).optional(),
      })
      .strict(),
    script: z.string().min(1).max(1_048_576),
    ...ProcessCommonSchema,
  })
  .strict()
  .refine((value) => value.shell.kind !== "custom" || value.shell.executable !== undefined, {
    message: "A custom shell requires an executable",
    path: ["shell", "executable"],
  })

export const ProcessExecInputSchema = z.discriminatedUnion("mode", [
  DirectProcessSchema,
  ShellProcessSchema,
])

const DESTRUCTIVE_EXECUTABLES = new Set([
  "del",
  "erase",
  "format",
  "mkfs",
  "remove-item",
  "rm",
  "rmdir",
  "shutdown",
])

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("und") : value
}

function commandExecutable(input: z.infer<typeof ProcessExecInputSchema>): string {
  return input.mode === "direct" ? input.executable : (input.shell.executable ?? input.shell.kind)
}

function commandArguments(input: z.infer<typeof ProcessExecInputSchema>): readonly string[] {
  return input.mode === "direct" ? input.args : [input.script]
}

function ruleMatches(rule: CommandRule, input: z.infer<typeof ProcessExecInputSchema>): boolean {
  const executable = commandExecutable(input)
  const executableMatches =
    comparable(rule.executable) === comparable(executable) ||
    comparable(rule.executable) === comparable(basename(executable))
  if (!executableMatches || rule.shell !== (input.mode === "shell")) return false
  const args = commandArguments(input)
  if (rule.exactArgs) {
    return (
      args.length === rule.exactArgs.length &&
      args.every((argument, index) => argument === rule.exactArgs?.[index])
    )
  }
  if (rule.argsPrefix) {
    return rule.argsPrefix.every((argument, index) => args[index] === argument)
  }
  return true
}

function looksDestructive(input: z.infer<typeof ProcessExecInputSchema>): boolean {
  if (input.mode === "shell") return true
  const executable = basename(input.executable).replace(/\.(?:cmd|exe|bat|ps1)$/i, "")
  if (DESTRUCTIVE_EXECUTABLES.has(executable.toLocaleLowerCase("en-US"))) return true
  if (executable.toLocaleLowerCase("en-US") === "git") {
    const command = input.args[0]?.toLocaleLowerCase("en-US")
    if (command === "clean") return input.args.some((argument) => /^-[a-z]*f/i.test(argument))
    if (command === "reset") return input.args.includes("--hard")
    if (command === "push") return input.args.some((argument) => /^(?:--force|-f)$/.test(argument))
  }
  return false
}

function permissionFacts(
  input: z.infer<typeof ProcessExecInputSchema>,
  context: ToolRuntimeContext,
): PermissionFacts {
  const rule = context.policy.commandRules.find((candidate) => ruleMatches(candidate, input))
  const destructive = looksDestructive(input) || rule?.risk === "destructive"
  return {
    risk: destructive ? "destructive" : "process",
    mutatesWorkspace: true,
    pathProtected: context.resolver.isProtected(input.cwd),
    pathInReadScope: context.resolver.isInScope(input.cwd, "read"),
    pathInWriteScope: context.resolver.isInScope(input.cwd, "write"),
    ...(rule ? { commandRuleId: rule.id, commandRuleRisk: rule.risk } : {}),
    shell: input.mode === "shell",
  }
}

function remainingTimeout(deadlineAt: string | undefined): number | undefined {
  if (!deadlineAt) return undefined
  const deadline = Date.parse(deadlineAt)
  if (!Number.isFinite(deadline)) {
    throw new ToolHostError("RALPH_TOOL_DEADLINE_INVALID", "Task deadline is invalid", "invalid")
  }
  return Math.max(0, deadline - Date.now())
}

export function processExecTool(): RegisteredTool {
  return {
    definition: {
      schemaVersion: 1,
      name: "process.exec",
      description:
        "Run a supervised direct argv command, or an explicitly declared shell script, under policy.",
      inputSchema: jsonInputSchema(ProcessExecInputSchema),
      risk: "process",
      mutatesWorkspace: true,
    },
    inputSchema: ProcessExecInputSchema,
    assess(input, context) {
      const parsed = ProcessExecInputSchema.parse(input)
      return { facts: permissionFacts(parsed, context), reason: "Supervised process requested" }
    },
    async execute(input, context) {
      const parsed = ProcessExecInputSchema.parse(input)
      const cwd = await context.resolver.resolve(parsed.cwd, "write", {
        mustExist: true,
        allowRoot: true,
      })
      if (cwd.kind !== "directory") {
        throw new ToolHostError(
          "RALPH_TOOL_PROCESS_CWD",
          `Process cwd is not a directory: ${parsed.cwd}`,
        )
      }
      const deadlineRemaining = remainingTimeout(context.session.deadlineAt)
      if (deadlineRemaining === 0) {
        throw new ToolHostError(
          "RALPH_TOOL_DEADLINE_EXCEEDED",
          "Task deadline was exceeded before process start",
          "timeout",
          "unknown-external-effect",
        )
      }
      const timeoutMs = Math.min(
        parsed.timeoutMs ?? context.policy.limits.maxProcessTimeoutMs,
        context.policy.limits.maxProcessTimeoutMs,
        deadlineRemaining ?? Number.POSITIVE_INFINITY,
      )
      const outputLimitBytes = Math.min(
        parsed.outputLimitBytes ?? context.policy.limits.maxProcessOutputBytes,
        context.policy.limits.maxProcessOutputBytes,
      )
      const request: ProcessPortRequest = {
        executable: commandExecutable(parsed),
        args: parsed.mode === "direct" ? parsed.args : [],
        cwd: cwd.canonicalPath ?? cwd.absolutePath,
        environment: context.session.environment ?? process.env,
        ...(parsed.mode === "shell"
          ? {
              shell: {
                kind: parsed.shell.kind,
                script: parsed.script,
                ...(parsed.shell.executable ? { executable: parsed.shell.executable } : {}),
              },
            }
          : { shell: false }),
        ...(parsed.stdin !== undefined ? { stdin: parsed.stdin } : {}),
        timeoutMs,
        outputLimitBytes,
        rawOutputLimitBytes: context.policy.limits.maxProcessRawOutputBytes,
        ...(context.session.signal ? { signal: context.session.signal } : {}),
        ...(context.session.secretValues ? { secretValues: context.session.secretValues } : {}),
        onOutput: async (stream, delta) => {
          await context.events.emit({
            type: "tool.output.delta",
            toolCallId: context.toolCallId,
            payload: { stream, delta },
          })
        },
      }
      const result = await context.process.run(request)
      const outcome = result.cancelled
        ? "cancelled"
        : result.timedOut
          ? "timeout"
          : result.error
            ? "error"
            : result.exitCode === 0
              ? "success"
              : "nonzero"
      return {
        outcome,
        content: {
          executable: request.executable,
          args: request.args,
          cwd: parsed.cwd,
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
        },
        outputRefs: result.outputRefs,
        effects: [{ kind: "process" }],
        retryable: false,
        recovery: "unknown-external-effect",
        ...(result.error ? { reason: result.error } : {}),
      }
    },
  }
}
