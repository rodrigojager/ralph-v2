import { type ExecutorOutcome, ExecutorOutcomeSchema } from "@ralph/domain"
import {
  ProviderModelInputSchema,
  ProviderToolCallSchema,
  ProviderToolDefinitionSchema,
} from "@ralph/providers"
import { redactText } from "@ralph/telemetry"
import { z } from "zod"

const MAX_EXTERNAL_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_GENERIC_SUMMARY_BYTES = 16 * 1024

const NonEmptyStringSchema = z.string().trim().min(1)

export const ExternalCliProtocolInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: z.literal("ralph.execution.external-cli.v1"),
    call: z
      .object({
        runId: NonEmptyStringSchema,
        documentId: NonEmptyStringSchema,
        taskId: NonEmptyStringSchema,
        attemptId: NonEmptyStringSchema,
        modelCallId: NonEmptyStringSchema,
        callOrdinal: z.number().int().positive(),
      })
      .strict(),
    workspaceRoot: NonEmptyStringSchema,
    protectedPaths: z.array(NonEmptyStringSchema),
    tools: z.array(ProviderToolDefinitionSchema),
    history: z.array(ProviderModelInputSchema),
    context: z
      .object({
        manifest: z.record(z.string(), z.unknown()),
        resources: z.array(z.record(z.string(), z.unknown())),
        truncations: z.array(z.record(z.string(), z.unknown())),
        canonicalJson: z.string().min(1),
      })
      .strict(),
  })
  .strict()
export type ExternalCliProtocolInput = z.infer<typeof ExternalCliProtocolInputSchema>

const ExternalCliProtocolOutcomeSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: z.literal("ralph.execution.external-cli.v1"),
    kind: z.literal("outcome"),
    outcome: ExecutorOutcomeSchema,
  })
  .strict()

const ExternalCliProtocolToolCallsSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: z.literal("ralph.execution.external-cli.v1"),
    kind: z.literal("tool-calls"),
    toolCalls: z.array(ProviderToolCallSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const callIds = new Set<string>()
    const itemIds = new Set<string>()
    for (const [index, call] of value.toolCalls.entries()) {
      if (callIds.has(call.callId)) {
        context.addIssue({
          code: "custom",
          message: "External CLI tool call ids must be unique within one batch",
          path: ["toolCalls", index, "callId"],
        })
      }
      if (itemIds.has(call.itemId)) {
        context.addIssue({
          code: "custom",
          message: "External CLI tool item ids must be unique within one batch",
          path: ["toolCalls", index, "itemId"],
        })
      }
      callIds.add(call.callId)
      itemIds.add(call.itemId)
    }
  })

export const ExternalCliProtocolOutputSchema = z.discriminatedUnion("kind", [
  ExternalCliProtocolOutcomeSchema,
  ExternalCliProtocolToolCallsSchema,
])
export type ExternalCliProtocolOutput = z.infer<typeof ExternalCliProtocolOutputSchema>

export function parseExternalProtocolOutput(stdout: string): ExternalCliProtocolOutput {
  assertBounded(stdout, "External CLI stdout")
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (cause) {
    throw new Error("External CLI protocol output is not one valid JSON document", { cause })
  }
  return ExternalCliProtocolOutputSchema.parse(value)
}

export type ExternalOutputAdapterKind = "protocol" | "known-output" | "generic"

export interface KnownExternalOutputAdapter {
  readonly id: string
  parse(input: { stdout: string; stderr: string }): unknown | Promise<unknown>
}

export const EXECUTOR_OUTCOME_JSON_ADAPTER_ID = "executor-outcome-json-v1"

/** Built-in, stack-neutral adapter for CLIs that print one ExecutorOutcome JSON object. */
export function builtinKnownExternalOutputAdapters(): readonly KnownExternalOutputAdapter[] {
  return Object.freeze([
    Object.freeze({
      id: EXECUTOR_OUTCOME_JSON_ADAPTER_ID,
      parse(input: { stdout: string }): unknown {
        try {
          return JSON.parse(input.stdout)
        } catch (cause) {
          throw new Error("Known external CLI output is not one ExecutorOutcome JSON object", {
            cause,
          })
        }
      },
    }),
  ])
}

export type ParseExternalOutcomeInput = {
  adapter: ExternalOutputAdapterKind
  adapterId?: string
  stdout: string
  stderr: string
  exitCode: number
  signal?: string
  timedOut?: boolean
  cancelled?: boolean
  knownAdapters?: readonly KnownExternalOutputAdapter[]
  secrets?: readonly string[]
  now?: () => string
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function assertBounded(value: string, label: string): void {
  if (byteLength(value) > MAX_EXTERNAL_OUTPUT_BYTES) {
    throw new Error(`${label} exceeds the external output adapter limit`)
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: sanitizing external terminal output intentionally matches ANSI escape bytes.
const ANSI_ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: the protocol boundary deliberately strips unsafe C0/C1 control bytes.
const UNSAFE_TERMINAL_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

function safeSummary(value: string, secrets: readonly string[]): string {
  const withoutTerminalControls = value
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(UNSAFE_TERMINAL_CONTROL, "")
    .trim()
  const redacted = redactText(withoutTerminalControls, secrets)
  if (byteLength(redacted) <= MAX_GENERIC_SUMMARY_BYTES) return redacted
  const bytes = new TextEncoder().encode(redacted).slice(0, MAX_GENERIC_SUMMARY_BYTES)
  return `${new TextDecoder()
    .decode(bytes)
    .replace(/\uFFFD$/u, "")
    .trimEnd()}\n[output truncated]`
}

function assertSuccessfulProcess(input: ParseExternalOutcomeInput): void {
  if (input.cancelled) throw new Error("External CLI execution was cancelled")
  if (input.timedOut) throw new Error("External CLI execution timed out")
  if (input.signal) throw new Error(`External CLI process was terminated by ${input.signal}`)
  if (input.exitCode !== 0) throw new Error(`External CLI exited with status ${input.exitCode}`)
}

/**
 * Deterministic boundary between an arbitrary external process and the Ralph
 * outcome allegation. Parsing never changes task state; evidence and gates are
 * still collected by the command-owned orchestrator after this function.
 */
export async function parseExternalOutcome(
  input: ParseExternalOutcomeInput,
): Promise<ExecutorOutcome> {
  assertBounded(input.stdout, "External CLI stdout")
  assertBounded(input.stderr, "External CLI stderr")
  assertSuccessfulProcess(input)

  if (input.adapter === "protocol") {
    const message = parseExternalProtocolOutput(input.stdout)
    if (message.kind !== "outcome") {
      throw new Error("External CLI protocol requested tools outside an execution tool loop")
    }
    return message.outcome
  }

  if (input.adapter === "known-output") {
    if (!input.adapterId) throw new Error("Known external output requires an adapter id")
    const candidates = (input.knownAdapters ?? []).filter(
      (candidate) => candidate.id === input.adapterId,
    )
    if (candidates.length !== 1) {
      throw new Error(
        `Known external output adapter is unavailable or ambiguous: ${input.adapterId}`,
      )
    }
    return ExecutorOutcomeSchema.parse(
      await candidates[0]?.parse({ stdout: input.stdout, stderr: input.stderr }),
    )
  }

  if (input.adapterId) throw new Error("Generic external output cannot select a known adapter")
  const secrets = input.secrets ?? []
  const summary = safeSummary(input.stdout || input.stderr, secrets)
  return ExecutorOutcomeSchema.parse({
    schemaVersion: 1,
    status: "work_submitted",
    summary:
      summary || "External CLI finished without textual output; inspect deterministic evidence.",
    intendedFiles: [],
    artifactRefs: [],
    suggestedVerifications: [],
    risks: [
      "Generic external output provides no structured tool or completion claim; Ralph must rely on workspace evidence and gates.",
    ],
    reportedAt: (input.now ?? (() => new Date().toISOString()))(),
  })
}
