import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

const MAX_STREAM_BYTES = 4 * 1024 * 1024
const projectRoot = resolve(import.meta.dir, "../..")

function outputPath(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    throw new Error("Usage: dependency-audit.ts --output <project-relative-path>")
  }
  const absolute = resolve(projectRoot, argv[1])
  const projectRelative = relative(projectRoot, absolute)
  if (
    projectRelative === ".." ||
    projectRelative.startsWith(`..${sep}`) ||
    isAbsolute(projectRelative)
  ) {
    throw new Error("Dependency audit output must remain inside the project")
  }
  return absolute
}

async function readBounded(stream: ReadableStream<Uint8Array>, label: string): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_STREAM_BYTES) {
      await reader.cancel(`${label} exceeded ${MAX_STREAM_BYTES} bytes`)
      throw new Error(`${label} exceeded the ${MAX_STREAM_BYTES}-byte limit`)
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

const output = outputPath(process.argv.slice(2))
const child = Bun.spawn([process.execPath, "audit", "--json"], {
  cwd: projectRoot,
  env: process.env,
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  windowsHide: true,
})
const [stdout, stderr, exitCode] = await Promise.all([
  readBounded(child.stdout, "bun audit stdout"),
  readBounded(child.stderr, "bun audit stderr"),
  child.exited,
])
let parsed: unknown
try {
  parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout))
} catch {
  const stdoutSha256 = digest(stdout)
  const stderrSha256 = digest(stderr)
  throw new Error(
    `bun audit returned invalid JSON (stdout sha256 ${stdoutSha256}, ` +
      `stderr sha256 ${stderrSha256})`,
  )
}
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  throw new Error("bun audit JSON must be a top-level object")
}
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(parsed, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
})
if (exitCode !== 0) {
  const stdoutSha256 = digest(stdout)
  const stderrSha256 = digest(stderr)
  throw new Error(
    `bun audit failed with exit ${exitCode} (stdout sha256 ${stdoutSha256}, ` +
      `stderr sha256 ${stderrSha256})`,
  )
}
if (Object.keys(parsed).length !== 0) {
  throw new Error("bun audit exit 0 did not return the pinned Bun 1.3.14 empty-object schema")
}
const summary = { reportSha256: digest(stdout), status: "pass" }
process.stdout.write(`${JSON.stringify(summary)}\n`)
