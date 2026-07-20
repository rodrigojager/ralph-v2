export type WindowsLauncherRequest = {
  schemaVersion: 3
  argv: readonly string[]
  cwd: string
  environment: Readonly<Record<string, string>>
  stdinBase64: string | null
  /** Private launcher control data; never forwarded to target argv or environment. */
  expectedExecutableSha256: string | null
  /** Private launcher control data; never forwarded to target argv or environment. */
  expectedCanonicalCwd: string | null
}

// The launcher deliberately waits for its request on stdin. The supervisor
// assigns it to a Job Object before sending this payload, eliminating the race
// in which the target could create descendants before containment exists.
export const WINDOWS_LAUNCHER_SOURCE = `
const { createHash } = await import("node:crypto")
const { lstatSync, readFileSync, realpathSync, statSync } = await import("node:fs")
const { isAbsolute, resolve } = await import("node:path")

const comparablePath = (value) => resolve(value).toLocaleLowerCase("en-US")
const sameFileSnapshot = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs

const verifiedExecutablePath = (executable, expectedSha256) => {
  if (!isAbsolute(executable)) throw new Error("Hash-bound executable must be absolute")
  const canonical = realpathSync.native(executable)
  if (comparablePath(canonical) !== comparablePath(executable)) {
    throw new Error("Hash-bound executable path must already be canonical")
  }
  const before = statSync(canonical)
  if (!before.isFile()) throw new Error("Hash-bound executable must be a regular file")
  const bytes = readFileSync(canonical)
  const after = statSync(canonical)
  const canonicalAfter = realpathSync.native(canonical)
  if (
    !after.isFile() ||
    !sameFileSnapshot(before, after) ||
    comparablePath(canonicalAfter) !== comparablePath(canonical)
  ) throw new Error("Hash-bound executable changed while it was revalidated")
  const actualSha256 = createHash("sha256").update(bytes).digest("hex")
  if (actualSha256 !== expectedSha256) {
    throw new Error("Hash-bound executable differs from its authorized content")
  }
  return canonical
}

const verifiedCwdPath = (cwd, expectedCanonicalCwd) => {
  if (!isAbsolute(cwd) || !isAbsolute(expectedCanonicalCwd)) {
    throw new Error("Hash-bound process cwd must be absolute")
  }
  const canonical = realpathSync.native(cwd)
  if (
    comparablePath(canonical) !== comparablePath(cwd) ||
    comparablePath(canonical) !== comparablePath(expectedCanonicalCwd)
  ) {
    throw new Error("Process cwd differs from its authorized canonical directory")
  }
  const before = lstatSync(canonical)
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Authorized process cwd must be a regular directory")
  }
  const canonicalAfter = realpathSync.native(canonical)
  const after = lstatSync(canonical)
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    !sameFileSnapshot(before, after) ||
    comparablePath(canonicalAfter) !== comparablePath(canonical)
  ) {
    throw new Error("Authorized process cwd changed while it was revalidated")
  }
  return canonical
}

const forward = async (stream, destination) => {
  const reader = stream.getReader()
  const writer = destination.writer()
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      await writer.write(item.value)
    }
    await writer.flush()
  } finally {
    await writer.end()
  }
}

try {
  const request = await new Response(Bun.stdin.stream()).json()
  if (
    request?.schemaVersion !== 3 ||
    !Array.isArray(request.argv) ||
    request.argv.length === 0 ||
    request.argv.length > 1025 ||
    !request.argv.every(
      (value, index) =>
        typeof value === "string" &&
        (index !== 0 || value.length > 0) &&
        value.length <= (index === 0 ? 4096 : 65536),
    ) ||
    typeof request.cwd !== "string" || request.cwd.length === 0 || request.cwd.length > 32768 ||
    request.environment === null ||
    typeof request.environment !== "object" ||
    Array.isArray(request.environment) ||
    Object.keys(request.environment).length > 1024 ||
    !Object.entries(request.environment).every(
      ([key, value]) => key.length > 0 && key.length <= 32767 && typeof value === "string",
    ) ||
    (request.stdinBase64 !== null && typeof request.stdinBase64 !== "string") ||
    (request.expectedExecutableSha256 !== null &&
      (typeof request.expectedExecutableSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(request.expectedExecutableSha256))) ||
    (request.expectedCanonicalCwd !== null &&
      (typeof request.expectedCanonicalCwd !== "string" ||
        request.expectedCanonicalCwd.length === 0 ||
        request.expectedCanonicalCwd.length > 32768 ||
        !isAbsolute(request.expectedCanonicalCwd)))
  ) throw new Error("Invalid supervisor launcher request")

  const argv = [...request.argv]
  if (request.expectedExecutableSha256 !== null) {
    argv[0] = verifiedExecutablePath(argv[0], request.expectedExecutableSha256)
  }
  const cwd = request.expectedCanonicalCwd === null
    ? request.cwd
    : verifiedCwdPath(request.cwd, request.expectedCanonicalCwd)
  // These are the final synchronous userspace checks before Bun asks Windows
  // to create the target. Filesystem replacement can still race this call; the
  // guarantee is deliberately reduced, not atomic.
  const child = Bun.spawn(argv, {
    cwd,
    env: request.environment,
    stdin: request.stdinBase64 === null ? "ignore" : Buffer.from(request.stdinBase64, "base64"),
    stdout: "pipe",
    stderr: "pipe",
    detached: false,
    windowsHide: true,
  })
  const [exitCode] = await Promise.all([
    child.exited,
    forward(child.stdout, Bun.stdout),
    forward(child.stderr, Bun.stderr),
  ])
  process.exitCode = exitCode
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exitCode = 125
}
`
