import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { extname, relative, resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "..", "..")
const scanRoots = ["apps", "packages", "scripts", "tests"] as const
const intentionallyVisible = ["apps/ralph-cli/src/config-editor.ts"] as const

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if (entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name))) files.push(path)
  }
  return files
}

type SpawnPolicy = {
  file: string
  line: number
  windowsHide: boolean | "missing" | "dynamic"
}

function callEnd(source: string, start: number): number {
  const open = source.indexOf("(", start)
  if (open < 0) return source.length
  let depth = 0
  let quote: "'" | '"' | "`" | undefined
  let lineComment = false
  let blockComment = false
  for (let index = open; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (current === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (current === "\\") index += 1
      else if (current === quote) quote = undefined
      continue
    }
    if (current === "/" && next === "/") {
      lineComment = true
      index += 1
      continue
    }
    if (current === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current
      continue
    }
    if (current === "(") depth += 1
    else if (current === ")" && --depth === 0) return index + 1
  }
  return source.length
}

function bunSpawnStarts(source: string): number[] {
  const starts: number[] = []
  let quote: "'" | '"' | "`" | undefined
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (current === "\n") lineComment = false
      continue
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote) {
      if (current === "\\") index += 1
      else if (current === quote) quote = undefined
      continue
    }
    if (current === "/" && next === "/") {
      lineComment = true
      index += 1
      continue
    }
    if (current === "/" && next === "*") {
      blockComment = true
      index += 1
      continue
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current
      continue
    }
    if (source.startsWith("Bun.spawn", index)) {
      starts.push(index)
      index += "Bun.spawn".length - 1
    }
  }
  return starts
}

async function collectSpawnPolicies(): Promise<SpawnPolicy[]> {
  const policies: SpawnPolicy[] = []
  for (const scanRoot of scanRoots) {
    for (const path of await sourceFiles(resolve(projectRoot, scanRoot))) {
      const sourceText = await readFile(path, "utf8")
      for (const start of bunSpawnStarts(sourceText)) {
        const call = sourceText.slice(start, callEnd(sourceText, start))
        const property = /\bwindowsHide\s*:\s*(true|false)\b/u.exec(call)
        policies.push({
          file: relative(projectRoot, path).replaceAll("\\", "/"),
          line: sourceText.slice(0, start).split("\n").length,
          windowsHide: property ? property[1] === "true" : "missing",
        })
      }
    }
  }
  return policies
}

describe("Windows subprocess focus policy", () => {
  test("every Bun subprocess declares whether its console window is hidden", async () => {
    const policies = await collectSpawnPolicies()
    expect(policies.length).toBeGreaterThan(0)
    expect(
      policies.filter(({ windowsHide }) => windowsHide === "missing" || windowsHide === "dynamic"),
    ).toEqual([])
    expect(
      policies.filter(({ windowsHide }) => windowsHide === false).map(({ file }) => file),
    ).toEqual([...intentionallyVisible])
  })

  test("the top-level PowerShell wrapper suppresses windows and preserves logs and exit status", async () => {
    const wrapper = await readFile(resolve(projectRoot, "scripts", "run-bun-hidden.ps1"), "utf8")
    expect(wrapper).toContain("$startInfo.UseShellExecute = $false")
    expect(wrapper).toContain("$startInfo.CreateNoWindow = $true")
    expect(wrapper).toContain("[Diagnostics.ProcessWindowStyle]::Hidden")
    expect(wrapper).toContain("$startInfo.RedirectStandardOutput = $true")
    expect(wrapper).toContain("$startInfo.RedirectStandardError = $true")
    expect(wrapper).toContain("[string] $Priority = 'BelowNormal'")
    expect(wrapper).toContain('Write-Output "EXIT_CODE=$exitCode"')
    expect(wrapper).toContain("exit $exitCode")
  })
})
