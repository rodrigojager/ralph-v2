import type { Diagnostic, ExitCode } from "./contracts"
import { EXIT_CODES } from "./contracts"

type RalphErrorOptions = {
  exitCode?: ExitCode
  severity?: Diagnostic["severity"]
  hint?: string
  file?: string
  line?: number
  column?: number
  details?: Record<string, unknown>
  cause?: unknown
}

export class RalphError extends Error {
  readonly code: string
  readonly exitCode: ExitCode
  readonly diagnostic: Diagnostic

  constructor(code: string, message: string, options: RalphErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = "RalphError"
    this.code = code
    this.exitCode = options.exitCode ?? EXIT_CODES.operationalError

    const diagnostic: Diagnostic = {
      code,
      severity: options.severity ?? "error",
      message,
    }
    if (options.hint !== undefined) diagnostic.hint = options.hint
    if (options.file !== undefined) diagnostic.file = options.file
    if (options.line !== undefined) diagnostic.line = options.line
    if (options.column !== undefined) diagnostic.column = options.column
    if (options.details !== undefined) diagnostic.details = options.details
    this.diagnostic = diagnostic
  }
}

export function toRalphError(error: unknown): RalphError {
  if (error instanceof RalphError) return error
  if (error instanceof Error) {
    return new RalphError("RALPH_OPERATIONAL_ERROR", error.message, {
      cause: error,
    })
  }
  return new RalphError("RALPH_OPERATIONAL_ERROR", "An unknown operational error occurred", {
    details: { value: String(error) },
  })
}
