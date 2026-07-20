import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { helpData, helpText } from "@ralph-next/commands"
import { commandResult, serializeCommandResult } from "@ralph-next/telemetry"

const VERSION = "9.8.7-test"
const directory = resolve(import.meta.dir, "../tests/golden")

await mkdir(directory, { recursive: true })
await Promise.all([
  writeFile(resolve(directory, "help.human.txt"), `${helpText(VERSION)}\n`, "utf8"),
  writeFile(
    resolve(directory, "help.json.txt"),
    serializeCommandResult(commandResult("help", helpData(VERSION)), "json", []),
    "utf8",
  ),
])

console.log(`Updated help goldens in ${directory}`)
