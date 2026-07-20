import { lstat, readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

const MAX_INDEX_BYTES = 8 * 1024 * 1024
const MAX_FILES = 20_000
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const projectRoot = resolve(import.meta.dir, "../..")

export interface WhitespaceIssue {
  readonly path: string
  readonly line: number
  readonly kind: "trailing-whitespace" | "space-before-tab" | "conflict-marker"
}

function insideProject(path: string): boolean {
  const projectRelative = relative(projectRoot, path)
  return (
    projectRelative !== ".." &&
    !projectRelative.startsWith(`..${sep}`) &&
    !isAbsolute(projectRelative)
  )
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_INDEX_BYTES) {
      await reader.cancel("tracked index output exceeded its limit")
      throw new Error("git ls-files output exceeded its bounded capture")
    }
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

async function trackedPaths(): Promise<readonly string[]> {
  const gitExecutable = Bun.which("git")
  if (!gitExecutable) throw new Error("git executable was not found")
  const child = Bun.spawn([gitExecutable, "ls-files", "-z", "--cached"], {
    cwd: projectRoot,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, , exitCode] = await Promise.all([
    readBounded(child.stdout),
    readBounded(child.stderr),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`git ls-files failed with exit ${exitCode}`)
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(stdout)
  const paths = decoded.endsWith("\0")
    ? decoded.slice(0, -1).split("\0")
    : decoded.length === 0
      ? []
      : decoded.split("\0")
  if (paths.length === 0 || paths.length > MAX_FILES) {
    throw new Error(`Tracked file count must be between 1 and ${MAX_FILES}`)
  }
  const seen = new Set<string>()
  for (const path of paths) {
    const segments = path.split("/")
    if (
      path.length === 0 ||
      path.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      isAbsolute(path) ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      !insideProject(resolve(projectRoot, path)) ||
      seen.has(path)
    ) {
      throw new Error(`Unsafe or duplicate tracked path: ${JSON.stringify(path)}`)
    }
    seen.add(path)
  }
  return paths.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
}

export function whitespaceIssues(path: string, source: string): readonly WhitespaceIssue[] {
  const issues: WhitespaceIssue[] = []
  const lines = source.split(/\n/u)
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (/[ \t]+$/u.test(line)) {
      issues.push({ path, line: index + 1, kind: "trailing-whitespace" })
    }
    if (/^\t* +\t/u.test(line)) {
      issues.push({ path, line: index + 1, kind: "space-before-tab" })
    }
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?: |$)/u.test(line)) {
      issues.push({ path, line: index + 1, kind: "conflict-marker" })
    }
  }
  return issues
}

async function main(): Promise<void> {
  const issues: WhitespaceIssue[] = []
  let totalBytes = 0
  let textFiles = 0
  let binaryFiles = 0
  for (const path of await trackedPaths()) {
    const absolute = resolve(projectRoot, path)
    const information = await lstat(absolute)
    if (information.isSymbolicLink()) {
      binaryFiles += 1
      continue
    }
    if (!information.isFile() || information.size > MAX_FILE_BYTES) {
      throw new Error(`Tracked path is missing, unsupported or oversized: ${path}`)
    }
    totalBytes += information.size
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Tracked files exceed the total byte limit")
    const bytes = await readFile(absolute)
    if (bytes.includes(0)) {
      binaryFiles += 1
      continue
    }
    let source: string
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      binaryFiles += 1
      continue
    }
    textFiles += 1
    issues.push(...whitespaceIssues(path, source))
  }
  for (const issue of issues) {
    process.stderr.write(`${issue.path}:${issue.line}: ${issue.kind}\n`)
  }
  process.stdout.write(
    `${JSON.stringify({
      status: issues.length === 0 ? "pass" : "fail",
      textFiles,
      binaryFiles,
    })}\n`,
  )
  if (issues.length > 0) process.exitCode = 1
}

if (import.meta.main) await main()
