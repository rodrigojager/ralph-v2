import {
  type CommandResult,
  CommandResultSchema,
  type Diagnostic,
  DiagnosticSchema,
} from "@ralph-next/domain"
import { type EventEnvelope, EventEnvelopeConsumerSchema } from "./events"
import { redactText, redactValue, secretValuesFromEnvironment } from "./redaction"

export type OutputFormat = "human" | "json" | "jsonl"

export type CommandExecution<T> = {
  result: CommandResult<T>
  human?: string
  jsonlEvents?: readonly EventEnvelope[]
  /**
   * A command-owned live stream. Items are format-neutral so redaction and the
   * exact stdout contract remain owned by telemetry rather than by handlers.
   */
  stream?: AsyncIterable<CommandStreamItem>
}

export type CommandStreamItem = {
  /** Structured record emitted by JSON and JSONL modes. */
  value: unknown
  /** One concise line emitted by human mode. */
  human: string
}

export type OutputWriters = {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const DEFAULT_WRITERS: OutputWriters = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
}

function diagnosticLine(diagnostic: Diagnostic): string {
  const location = diagnostic.file
    ? ` ${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}${diagnostic.column ? `:${diagnostic.column}` : ""}`
    : ""
  const hint = diagnostic.hint ? `\n  Hint: ${diagnostic.hint}` : ""
  const details = diagnostic.details ? `\n  Details: ${JSON.stringify(diagnostic.details)}` : ""
  return `${diagnostic.severity.toUpperCase()} ${diagnostic.code}${location}: ${diagnostic.message}${hint}${details}`
}

export function serializeCommandResult<T>(
  result: CommandResult<T>,
  format: Exclude<OutputFormat, "human">,
  secrets: readonly string[] = secretValuesFromEnvironment(),
): string {
  const safe = redactValue(result, secrets)
  return format === "json" ? `${JSON.stringify(safe, null, 2)}\n` : `${JSON.stringify(safe)}\n`
}

export function serializeEventEnvelopes(
  events: readonly EventEnvelope[],
  secrets: readonly string[] = secretValuesFromEnvironment(),
): string {
  if (events.length === 0) return ""

  return `${events
    .map((event) => {
      const validated = EventEnvelopeConsumerSchema.parse(event)
      return JSON.stringify(redactValue(validated, secrets))
    })
    .join("\n")}\n`
}

export function writeCommandExecution<T>(
  execution: CommandExecution<T>,
  format: OutputFormat,
  writers: OutputWriters = DEFAULT_WRITERS,
  secrets: readonly string[] = secretValuesFromEnvironment(),
): void {
  if (execution.stream) {
    throw new Error("Streaming command executions require writeCommandStream")
  }
  CommandResultSchema.parse(execution.result)
  if (format === "jsonl" && execution.jsonlEvents) {
    const output = serializeEventEnvelopes(execution.jsonlEvents, secrets)
    if (output.length > 0) writers.stdout(output)
    return
  }
  if (format === "json" || format === "jsonl") {
    writers.stdout(serializeCommandResult(execution.result, format, secrets))
    return
  }

  if (execution.human) {
    writers.stdout(`${redactText(execution.human, secrets).replace(/\s+$/, "")}\n`)
  }
  for (const diagnostic of execution.result.diagnostics) {
    const safeDiagnostic = DiagnosticSchema.parse(redactValue(diagnostic, secrets))
    const line = `${diagnosticLine(safeDiagnostic)}\n`
    writers.stderr(line)
  }
}

/**
 * Writes an unbounded or bounded command stream without decorative banners.
 * JSON is one array closed when the stream finishes (including graceful
 * cancellation); JSONL is one independently parseable record per line.
 */
export async function writeCommandStream<T>(
  execution: CommandExecution<T>,
  format: OutputFormat,
  writers: OutputWriters = DEFAULT_WRITERS,
  secrets: readonly string[] = secretValuesFromEnvironment(),
): Promise<void> {
  CommandResultSchema.parse(execution.result)
  if (!execution.stream) {
    writeCommandExecution(execution, format, writers, secrets)
    return
  }

  for (const diagnostic of execution.result.diagnostics) {
    const safeDiagnostic = DiagnosticSchema.parse(redactValue(diagnostic, secrets))
    writers.stderr(`${diagnosticLine(safeDiagnostic)}\n`)
  }

  if (format === "json") writers.stdout("[\n")
  let emitted = 0
  try {
    for await (const item of execution.stream) {
      if (format === "human") {
        const line = redactText(item.human, secrets)
          .replace(/[\r\n]+/g, " ↩ ")
          .trimEnd()
        writers.stdout(`${line}\n`)
        emitted += 1
        continue
      }
      const serialized =
        JSON.stringify(redactValue(item.value, secrets), null, format === "json" ? 2 : 0) ?? "null"
      if (format === "jsonl") {
        writers.stdout(`${serialized}\n`)
      } else {
        writers.stdout(`${emitted === 0 ? "" : ",\n"}${serialized}`)
      }
      emitted += 1
    }
  } finally {
    if (format === "json") writers.stdout(`${emitted === 0 ? "" : "\n"}]\n`)
  }
}

export function commandResult<T>(
  command: string,
  data: T,
  diagnostics: Diagnostic[] = [],
): CommandResult<T> {
  return {
    schemaVersion: 1,
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    command,
    data,
    diagnostics,
  }
}
