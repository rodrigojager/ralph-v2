import { type CommandResult, EXIT_CODES, type ExitCode, toRalphError } from "@ralph-next/domain"
import {
  type CommandExecution,
  type OutputFormat,
  type OutputWriters,
  redactText,
  secretValuesFromEnvironment,
  writeCommandExecution,
  writeCommandStream,
} from "@ralph-next/telemetry"
import { type CommandContext, handleCommand } from "./handlers"
import { inferRequestedFormat, parseCli } from "./parser"

export * from "./catalog-operations"
export {
  type CanonicalCommand,
  COMMAND_DISCOVERY,
  COMMAND_REGISTRY,
  type CommandCompatibility,
  type CommandCompletionEntry,
  type CommandDiscoveryEntry,
  type CommandMetadata,
  type CommandPaletteEntry,
  commandCompletionData,
  commandDiscoveryData,
  commandPaletteData,
  commandRegistryData,
  type ResolvedCommandSpelling,
  resolveCommandTokens,
  TOP_LEVEL_COMMAND_ALIASES,
} from "./command-registry"
export * from "./config-transfer"
export * from "./github-tasks-sync"
export * from "./handlers"
export * from "./help"
export * from "./operational-inspection"
export * from "./parser"
export * from "./profile-runtime"
export * from "./settings"
export * from "./settings-command"

export type CliRunResult = {
  exitCode: ExitCode
  format: OutputFormat
  execution: CommandExecution<unknown>
}

export async function executeCli(
  argv: readonly string[],
  context: CommandContext,
): Promise<CliRunResult> {
  const requestedFormat = inferRequestedFormat(argv)
  try {
    const parsed = parseCli(argv)
    const handled = await handleCommand(parsed, context)
    return {
      exitCode: handled.exitCode,
      format: parsed.options.format,
      execution: handled.execution,
    }
  } catch (error) {
    const ralphError = toRalphError(error)
    const debugRequested = context.environment.RALPH_DEBUG === "1" || argv.includes("--debug")
    const diagnostic = debugRequested
      ? {
          ...ralphError.diagnostic,
          details: {
            ...ralphError.diagnostic.details,
            stack: ralphError.stack,
          },
        }
      : ralphError.diagnostic
    const result: CommandResult<never> = {
      schemaVersion: 1,
      ok: false,
      command: "error",
      diagnostics: [diagnostic],
    }
    return {
      exitCode: ralphError.exitCode,
      format: requestedFormat,
      execution: { result },
    }
  }
}

export async function runCli(
  argv: readonly string[],
  context: CommandContext,
  writers?: OutputWriters,
): Promise<ExitCode> {
  const result = await executeCli(argv, context)
  const secrets = secretValuesFromEnvironment(context.environment)
  const outputWriters: OutputWriters = writers ?? {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }
  if (result.execution.stream) {
    try {
      await writeCommandStream(result.execution, result.format, outputWriters, secrets)
    } catch (error) {
      const failure = toRalphError(error)
      outputWriters.stderr(
        `${redactText(`${failure.diagnostic.severity.toUpperCase()} ${failure.diagnostic.code}: ${failure.diagnostic.message}`, secrets)}\n`,
      )
      return failure.exitCode
    }
  } else {
    writeCommandExecution(result.execution, result.format, outputWriters, secrets)
  }
  return result.exitCode ?? EXIT_CODES.operationalError
}
