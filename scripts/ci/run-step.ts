import { createHash } from "node:crypto"
import { once } from "node:events"
import { createReadStream } from "node:fs"
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

const projectRoot = resolve(import.meta.dir, "../..")
const MAX_ARGUMENTS = 256
const MAX_ARGUMENT_BYTES = 16 * 1024

function containsForbiddenArgumentControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint !== undefined &&
      (codePoint === 0 ||
        codePoint === 0x7f ||
        (codePoint >= 1 && codePoint <= 0x1f && ![0x09, 0x0a, 0x0d].includes(codePoint)))
    ) {
      return true
    }
  }
  return false
}

export interface CiStepOptions {
  readonly id: string
  readonly output: string
  readonly command: readonly string[]
}

interface StreamDigest {
  readonly bytes: number
  readonly sha256: string
}

interface ExecutableIdentity {
  readonly path: string
  readonly executable: string
  readonly bytes: number
  readonly sha256: string
}

export interface CiStepReceipt {
  readonly schemaVersion: 2
  readonly artifactClass: "ci-step-receipt"
  readonly id: string
  readonly status: "pass" | "fail" | "spawn-error"
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMilliseconds: number
  readonly workingDirectory: "."
  readonly command: {
    readonly requestedExecutable: string
    readonly executable: string
    readonly bytes: number | null
    readonly sha256: string | null
    readonly arguments: readonly string[]
  }
  readonly runtime: {
    readonly bunVersion: string
    readonly bunRevision: string
    readonly os: NodeJS.Platform
    readonly architecture: string
  }
  readonly exitCode: number | null
  readonly stdout: StreamDigest
  readonly stderr: StreamDigest
  readonly spawnError: string | null
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function safeArgument(value: string, label: string): string {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_BYTES) {
    throw new Error(`${label} must be non-empty and at most ${MAX_ARGUMENT_BYTES} UTF-8 bytes`)
  }
  if (containsForbiddenArgumentControl(value)) {
    throw new Error(`${label} contains a forbidden control character`)
  }
  return value
}

export function parseCiStepArguments(argv: readonly string[]): CiStepOptions {
  let id: string | undefined
  let output: string | undefined
  let separator = -1

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--") {
      separator = index
      break
    }
    if (flag === "--id") {
      if (id !== undefined) throw new Error("--id may be provided only once")
      id = requiredValue(argv, index, flag)
    } else if (flag === "--output") {
      if (output !== undefined) throw new Error("--output may be provided only once")
      output = requiredValue(argv, index, flag)
    } else {
      throw new Error(`Unknown argument before command separator: ${flag ?? "<missing>"}`)
    }
    index += 1
  }

  if (!id || !/^[a-z][a-z0-9-]{0,63}$/u.test(id)) {
    throw new Error("--id must match ^[a-z][a-z0-9-]{0,63}$")
  }
  if (!output) throw new Error("--output is required")
  if (separator < 0) throw new Error("A -- separator is required before the command")
  const command = argv.slice(separator + 1)
  if (command.length === 0) throw new Error("A command is required after --")
  if (command.length > MAX_ARGUMENTS) {
    throw new Error(`CI command exceeds the ${MAX_ARGUMENTS}-argument limit`)
  }
  return {
    id,
    output,
    command: command.map((value, index) =>
      safeArgument(value, index === 0 ? "Command executable" : `Command argument ${index}`),
    ),
  }
}

function insideProject(path: string, label: string): string {
  const absolute = resolve(projectRoot, path)
  const projectRelative = relative(projectRoot, absolute)
  if (
    projectRelative === ".." ||
    projectRelative.startsWith(`..${sep}`) ||
    isAbsolute(projectRelative)
  ) {
    throw new Error(`${label} must remain inside the project: ${path}`)
  }
  return absolute
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function assertReceiptDoesNotExist(output: string): Promise<void> {
  try {
    await lstat(output)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  throw new Error(`CI step receipt already exists: ${relative(projectRoot, output)}`)
}

async function executableIdentity(requested: string): Promise<ExecutableIdentity> {
  const pathLike = isAbsolute(requested) || requested.includes("/") || requested.includes("\\")
  const located = pathLike ? resolve(projectRoot, requested) : Bun.which(requested)
  if (!located) throw new Error(`CI command executable was not found: ${requested}`)
  const canonical = await realpath(located)
  const before = await lstat(canonical)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`CI command executable is not a regular file: ${requested}`)
  }
  const hash = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(canonical)) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    bytes += buffer.byteLength
    hash.update(buffer)
  }
  const after = await lstat(canonical)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameFile(before, after) ||
    bytes !== after.size
  ) {
    throw new Error(`CI command executable changed while hashing: ${requested}`)
  }
  return {
    path: canonical,
    executable: basename(canonical),
    bytes,
    sha256: hash.digest("hex"),
  }
}

async function digestAndForward(
  stream: ReadableStream<Uint8Array>,
  destination: NodeJS.WriteStream,
): Promise<StreamDigest> {
  const digest = createHash("sha256")
  const reader = stream.getReader()
  let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    digest.update(next.value)
    if (!destination.write(next.value)) await once(destination, "drain")
  }
  return { bytes, sha256: digest.digest("hex") }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/gu, " ").slice(0, 2_048)
}

export async function runCiStep(options: CiStepOptions): Promise<CiStepReceipt> {
  const output = insideProject(options.output, "CI step receipt")
  await assertReceiptDoesNotExist(output)
  const startedAt = new Date()
  const monotonicStart = performance.now()
  let exitCode: number | null = null
  let stdout: StreamDigest = { bytes: 0, sha256: createHash("sha256").digest("hex") }
  let stderr: StreamDigest = { bytes: 0, sha256: createHash("sha256").digest("hex") }
  let spawnError: string | null = null
  let executable: ExecutableIdentity | null = null

  try {
    executable = await executableIdentity(options.command[0] as string)
    const child = Bun.spawn([executable.path, ...options.command.slice(1)], {
      cwd: projectRoot,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    ;[exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      digestAndForward(child.stdout, process.stdout),
      digestAndForward(child.stderr, process.stderr),
    ])
    const after = await executableIdentity(executable.path)
    if (
      after.path !== executable.path ||
      after.bytes !== executable.bytes ||
      after.sha256 !== executable.sha256
    ) {
      throw new Error("CI command executable changed while the step was running")
    }
  } catch (error) {
    spawnError = boundedError(error)
    process.stderr.write(
      `CI step ${options.id} could not start or capture its command: ${spawnError}\n`,
    )
  }

  const finishedAt = new Date()
  const receipt: CiStepReceipt = {
    schemaVersion: 2,
    artifactClass: "ci-step-receipt",
    id: options.id,
    status: spawnError ? "spawn-error" : exitCode === 0 ? "pass" : "fail",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMilliseconds: Math.max(
      0,
      Math.round((performance.now() - monotonicStart) * 1_000) / 1_000,
    ),
    workingDirectory: ".",
    command: {
      requestedExecutable: options.command[0] ?? "",
      executable: executable?.executable ?? basename(options.command[0] ?? ""),
      bytes: executable?.bytes ?? null,
      sha256: executable?.sha256 ?? null,
      arguments: options.command.slice(1),
    },
    runtime: {
      bunVersion: Bun.version,
      bunRevision: Bun.revision,
      os: process.platform,
      architecture: process.arch,
    },
    exitCode,
    stdout,
    stderr,
    spawnError,
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  })
  return receipt
}

if (import.meta.main) {
  const options = parseCiStepArguments(process.argv.slice(2))
  const result = await runCiStep(options)
  process.stdout.write(
    `${JSON.stringify({ id: result.id, status: result.status, exitCode: result.exitCode })}\n`,
  )
  if (result.status !== "pass") {
    process.exitCode = result.exitCode && result.exitCode > 0 ? result.exitCode : 1
  }
}
