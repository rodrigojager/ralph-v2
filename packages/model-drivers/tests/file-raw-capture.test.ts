import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FileRawModelCaptureFactory } from "../src/index"

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("file raw model capture", () => {
  test("keeps a terminal settlement inside the byte bound after truncation", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "ralph-raw-capture-")))
    directories.push(directory)
    const factory = new FileRawModelCaptureFactory({
      directory,
      maximumBytes: 1_024,
      now: () => "2026-07-18T00:00:00.000Z",
    })
    const capture = await factory.open({
      callId: "call-truncated",
      provider: "openai",
      model: "gpt-fixture",
      request: {} as never,
    })

    await capture.append({ delta: "x".repeat(2_000) })
    await capture.close({ status: "failed", error: "e".repeat(2_000) })

    const digest = capture.ref.slice("raw:model/".length, -".jsonl".length)
    const bytes = await readFile(join(directory, digest.slice(0, 2), `${digest}.jsonl`))
    expect(bytes.byteLength).toBeLessThanOrEqual(1_024)
    const records = bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.some((record) => record.type === "capture.truncated")).toBeTrue()
    expect(records.at(-1)).toMatchObject({
      schemaVersion: 1,
      type: "capture.finished",
      status: "failed",
      truncated: true,
    })
    expect(String(records.at(-1)?.error).length).toBeLessThanOrEqual(256)
    await expect(capture.append({ late: true })).rejects.toThrow("already closed")
  })
})
