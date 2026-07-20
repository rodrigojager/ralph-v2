import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { helpData, helpText } from "@ralph-next/commands"
import { commandResult, serializeCommandResult } from "@ralph-next/telemetry"

const VERSION = "9.8.7-test"
const GOLDEN_DIRECTORY = resolve(import.meta.dir, "../golden")

async function golden(name: string): Promise<string> {
  return readFile(resolve(GOLDEN_DIRECTORY, name), "utf8")
}

describe("help/version golden output", () => {
  test("human help remains stable", async () => {
    expect(`${helpText(VERSION)}\n`).toBe(await golden("help.human.txt"))
  })

  test("JSON help remains a banner-free CommandResult", async () => {
    const output = serializeCommandResult(commandResult("help", helpData(VERSION)), "json", [])
    expect(output).toBe(await golden("help.json.txt"))
    expect(output).not.toContain(String.fromCharCode(27))
  })

  test("human and JSON version remain stable", async () => {
    const data = { name: "ralph-next", version: VERSION }
    expect(`ralph-next ${VERSION}\n`).toBe(await golden("version.human.txt"))
    expect(serializeCommandResult(commandResult("version", data), "json", [])).toBe(
      await golden("version.json.txt"),
    )
  })
})
