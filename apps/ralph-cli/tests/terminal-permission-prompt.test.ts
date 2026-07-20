import { describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"

import { ToolPermissionRequestSchema } from "@ralph-next/tool-host"

import { TerminalPermissionPrompt } from "../src/terminal-permission-prompt"

const NOW = "2026-07-18T20:00:00.000Z"
const REQUEST_HASH = "a".repeat(64)
const ARGUMENTS_HASH = "b".repeat(64)

function ttyStreams(interactive = true) {
  return {
    input: Object.assign(new PassThrough(), { isTTY: interactive }),
    output: Object.assign(new PassThrough(), { isTTY: interactive }),
  }
}

function request(id: string) {
  return ToolPermissionRequestSchema.parse({
    schemaVersion: 1,
    id: `permission-${id}`,
    requestHash: REQUEST_HASH,
    toolCallId: `secret-arguments-must-not-render-${id}`,
    tool: "process.exec",
    argumentsHash: ARGUMENTS_HASH,
    risk: "process",
    role: "executor",
    securityMode: "auto",
    reason: "Unlisted process execution requires an explicit per-call decision",
    requestedAt: NOW,
  })
}

describe("TerminalPermissionPrompt", () => {
  test("returns responses bound to the request and defaults to deny without rendering arguments", async () => {
    const streams = ttyStreams()
    const messages: string[] = []
    const answers = ["y", ""]
    const prompt = new TerminalPermissionPrompt({
      ...streams,
      now: () => NOW,
      async question(message) {
        messages.push(message)
        return answers.shift() ?? ""
      },
    })

    const allowed = await prompt.request(request("allow"))
    const denied = await prompt.request(request("deny"))

    expect(allowed).toEqual({
      schemaVersion: 1,
      requestId: "permission-allow",
      requestHash: REQUEST_HASH,
      action: "allow",
      reason: "User allowed the command-owned terminal permission request",
      respondedAt: NOW,
    })
    expect(denied).toMatchObject({
      requestId: "permission-deny",
      requestHash: REQUEST_HASH,
      action: "deny",
    })
    expect(messages[0]).toContain("Tool: process.exec")
    expect(messages[0]).toContain("Risk: process")
    expect(messages[0]).toContain(`Request hash: ${REQUEST_HASH.slice(0, 12)}…`)
    expect(messages[0]).toContain(`Arguments hash: ${ARGUMENTS_HASH.slice(0, 12)}…`)
    expect(messages.join("\n")).not.toContain("secret-arguments-must-not-render")
  })

  test("fails closed immediately when a terminal is unavailable", async () => {
    const streams = ttyStreams(false)
    let questions = 0
    const prompt = new TerminalPermissionPrompt({
      ...streams,
      now: () => NOW,
      async question() {
        questions += 1
        return "y"
      },
    })

    const response = await prompt.request(request("unavailable"))

    expect(response).toMatchObject({
      requestId: "permission-unavailable",
      requestHash: REQUEST_HASH,
      action: "deny",
      reason: "Interactive terminal is unavailable; permission denied without waiting",
    })
    expect(questions).toBe(0)
  })

  test("propagates cancellation to an active question", async () => {
    const streams = ttyStreams()
    const controller = new AbortController()
    let entered = false
    const prompt = new TerminalPermissionPrompt({
      ...streams,
      question: (_message, signal) =>
        new Promise((_resolve, reject) => {
          entered = true
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    })
    const pending = prompt.request(request("cancelled"), controller.signal)
    while (!entered) await Promise.resolve()
    const reason = new Error("cancel prompt")
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })

  test("serializes concurrent permission questions", async () => {
    const streams = ttyStreams()
    let calls = 0
    let active = 0
    let maximumActive = 0
    let releaseFirst = (): void => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const prompt = new TerminalPermissionPrompt({
      ...streams,
      now: () => NOW,
      async question() {
        const index = calls
        calls += 1
        active += 1
        maximumActive = Math.max(maximumActive, active)
        if (index === 0) await firstGate
        active -= 1
        return "n"
      },
    })

    const first = prompt.request(request("first"))
    while (calls === 0) await Promise.resolve()
    const second = prompt.request(request("second"))
    await Promise.resolve()
    expect(calls).toBe(1)
    releaseFirst()
    await Promise.all([first, second])

    expect(calls).toBe(2)
    expect(maximumActive).toBe(1)
  })
})
