import { createInterface } from "node:readline/promises"

import {
  type PermissionPromptPort,
  type ToolPermissionRequest,
  type ToolPermissionResponse,
  ToolPermissionResponseSchema,
} from "@ralph/tool-host"

type TtyReadable = NodeJS.ReadableStream & { readonly isTTY?: boolean }
type TtyWritable = NodeJS.WritableStream & { readonly isTTY?: boolean }

export type TerminalPermissionQuestion = (message: string, signal?: AbortSignal) => Promise<string>

export type TerminalPermissionPromptOptions = {
  input?: TtyReadable
  output?: TtyWritable
  question?: TerminalPermissionQuestion
  now?: () => string
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Permission prompt was cancelled", "AbortError")
}

async function waitForTurn(turn: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return turn
  if (signal.aborted) throw cancellationReason(signal)
  await new Promise<void>((resolve, reject) => {
    const aborted = (): void => reject(cancellationReason(signal))
    signal.addEventListener("abort", aborted, { once: true })
    turn.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted))
  })
}

function safeTerminalText(value: string, maximumLength = 240): string {
  const normalized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, maximumLength - 1)}…`
}

function shortHash(value: string): string {
  return `${value.slice(0, 12)}…`
}

function promptMessage(request: ToolPermissionRequest): string {
  return [
    "\nRalph permission request",
    `Tool: ${safeTerminalText(request.tool, 80)}`,
    `Risk: ${request.risk}`,
    `Reason: ${safeTerminalText(request.reason)}`,
    `Request hash: ${shortHash(request.requestHash)}`,
    `Arguments hash: ${shortHash(request.argumentsHash)}`,
    "Allow this tool call? [y/N] ",
  ].join("\n")
}

/**
 * Command-owned terminal confirmation adapter. It never renders tool arguments,
 * fails closed without an attached input/error TTY, and serializes prompts so
 * concurrent model calls cannot interleave terminal input.
 */
export class TerminalPermissionPrompt implements PermissionPromptPort {
  readonly #input: TtyReadable
  readonly #output: TtyWritable
  readonly #question: TerminalPermissionQuestion
  readonly #now: () => string
  #tail: Promise<void> = Promise.resolve()

  constructor(options: TerminalPermissionPromptOptions = {}) {
    this.#input = options.input ?? process.stdin
    this.#output = options.output ?? process.stderr
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#question =
      options.question ??
      (async (message, signal) => {
        const terminal = createInterface({
          input: this.#input,
          output: this.#output,
          terminal: true,
        })
        try {
          return signal
            ? await terminal.question(message, { signal })
            : await terminal.question(message)
        } finally {
          terminal.close()
        }
      })
  }

  async request(
    request: ToolPermissionRequest,
    signal?: AbortSignal,
  ): Promise<ToolPermissionResponse> {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.#tail.catch(() => {})
    this.#tail = previous.then(() => held)

    try {
      await waitForTurn(previous, signal)
      if (signal?.aborted) throw cancellationReason(signal)

      if (this.#input.isTTY !== true || this.#output.isTTY !== true) {
        return ToolPermissionResponseSchema.parse({
          schemaVersion: 1,
          requestId: request.id,
          requestHash: request.requestHash,
          action: "deny",
          reason: "Interactive terminal is unavailable; permission denied without waiting",
          respondedAt: this.#now(),
        })
      }

      const answer = safeTerminalText(await this.#question(promptMessage(request), signal), 32)
        .toLowerCase()
        .trim()
      const allowed = answer === "y" || answer === "yes"
      return ToolPermissionResponseSchema.parse({
        schemaVersion: 1,
        requestId: request.id,
        requestHash: request.requestHash,
        action: allowed ? "allow" : "deny",
        reason: allowed
          ? "User allowed the command-owned terminal permission request"
          : "User denied the command-owned terminal permission request (default: deny)",
        respondedAt: this.#now(),
      })
    } finally {
      release()
    }
  }
}

export function createTerminalPermissionPrompt(
  options: TerminalPermissionPromptOptions = {},
): PermissionPromptPort {
  return new TerminalPermissionPrompt(options)
}
