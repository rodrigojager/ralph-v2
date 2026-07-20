import { z } from "zod"
import { ToolHostError } from "../errors"
import { jsonInputSchema, type RegisteredTool } from "../registry"

const GitPathSchema = z.string().min(1).max(4_096)

export const GitInspectInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status") }).strict(),
  z
    .object({
      operation: z.literal("diff"),
      staged: z.boolean().default(false),
      paths: z.array(GitPathSchema).max(256).default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("log"),
      maxCount: z.number().int().positive().max(200).default(20),
    })
    .strict(),
  z
    .object({
      operation: z.literal("show"),
      ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,255}$/),
      paths: z.array(GitPathSchema).max(256).default([]),
    })
    .strict(),
])

function paths(input: z.infer<typeof GitInspectInputSchema>): readonly string[] {
  return input.operation === "diff" || input.operation === "show" ? input.paths : []
}

function gitArgs(input: z.infer<typeof GitInspectInputSchema>): string[] {
  switch (input.operation) {
    case "status":
      return ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]
    case "diff":
      return ["diff", "--no-ext-diff", ...(input.staged ? ["--cached"] : []), "--", ...input.paths]
    case "log":
      return ["log", `--max-count=${input.maxCount}`, "--format=%H%x09%aI%x09%an%x09%s"]
    case "show":
      return ["show", "--no-ext-diff", "--format=fuller", input.ref, "--", ...input.paths]
  }
}

export function gitInspectTool(): RegisteredTool {
  return {
    definition: {
      schemaVersion: 1,
      name: "git.inspect",
      description:
        "Inspect Git status, diff, log, or one ref through a closed read-only operation set.",
      inputSchema: jsonInputSchema(GitInspectInputSchema),
      risk: "read",
      mutatesWorkspace: false,
    },
    inputSchema: GitInspectInputSchema,
    assess(input, context) {
      const parsed = GitInspectInputSchema.parse(input)
      const selected = paths(parsed)
      return {
        facts: {
          risk: "read",
          mutatesWorkspace: false,
          pathProtected: selected.some((path) => context.resolver.isProtected(path)),
          pathInReadScope:
            selected.length === 0 ||
            selected.every((path) => context.resolver.isInScope(path, "read")),
          pathInWriteScope: false,
          shell: false,
        },
        reason: `Read-only Git ${parsed.operation} requested`,
      }
    },
    async execute(input, context) {
      const parsed = GitInspectInputSchema.parse(input)
      for (const path of paths(parsed)) {
        await context.resolver.resolve(path, "read", { allowRoot: true })
      }
      const git = context.process.which("git", context.session.environment ?? process.env)
      if (!git) {
        throw new ToolHostError(
          "RALPH_TOOL_GIT_UNAVAILABLE",
          "Git executable is unavailable",
          "error",
          "safe-to-retry",
          true,
        )
      }
      const result = await context.process.run({
        executable: git,
        args: gitArgs(parsed),
        cwd: context.resolver.root,
        environment: context.session.environment ?? process.env,
        timeoutMs: Math.min(30_000, context.policy.limits.maxProcessTimeoutMs),
        outputLimitBytes: context.policy.limits.maxProcessOutputBytes,
        rawOutputLimitBytes: context.policy.limits.maxProcessRawOutputBytes,
        shell: false,
        ...(context.session.signal ? { signal: context.session.signal } : {}),
        ...(context.session.secretValues ? { secretValues: context.session.secretValues } : {}),
        onOutput: async (stream, delta) => {
          await context.events.emit({
            type: "tool.output.delta",
            toolCallId: context.toolCallId,
            payload: { stream, delta },
          })
        },
      })
      if (result.timedOut || result.cancelled || result.error || result.exitCode !== 0) {
        throw new ToolHostError(
          "RALPH_TOOL_GIT_FAILED",
          result.error ?? (result.stderr || `Git exited with ${String(result.exitCode)}`),
          result.cancelled ? "cancelled" : result.timedOut ? "timeout" : "nonzero",
          "safe-to-retry",
          true,
        )
      }
      return {
        content: {
          operation: parsed.operation,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          outputTruncated: result.outputTruncated,
          rawOutputTruncated: result.rawOutputTruncated,
        },
        outputRefs: result.outputRefs,
        recovery: "safe-to-retry",
      }
    },
  }
}
