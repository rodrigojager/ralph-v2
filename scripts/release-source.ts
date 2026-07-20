import { createHash } from "node:crypto"
import { lstat, readdir, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { sha256File } from "./build-artifact"
import { compareUtf8Bytes } from "./release-order"

export interface VerifiedReleaseSource {
  readonly repository: string
  readonly commit: string
  readonly root: string
}

function inside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

async function hashTreeEntries(
  root: string,
  current: string,
  hash: ReturnType<typeof createHash>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  entries.sort((left, right) => compareUtf8Bytes(left.name, right.name))
  for (const entry of entries) {
    const path = resolve(current, entry.name)
    if (!inside(root, path)) throw new Error("Release source tree path escapes its verified root")
    const relativePath = relative(root, path).split(sep).join("/")
    const information = await lstat(path)
    if (information.isSymbolicLink())
      throw new Error(`Release source tree cannot contain symlinks: ${relativePath}`)
    if (information.isDirectory()) {
      await hashTreeEntries(root, path, hash)
      continue
    }
    if (!information.isFile())
      throw new Error(`Release source tree accepts regular files only: ${relativePath}`)
    hash.update(`${relativePath}\0${information.size}\0${await sha256File(path)}\0`)
  }
}

export async function hashReleaseSourceTree(directory: string): Promise<string> {
  const root = await realpath(resolve(directory))
  const information = await lstat(root)
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("Release source tree must be a regular canonical directory")
  }
  const hash = createHash("sha256")
  await hashTreeEntries(root, root, hash)
  return hash.digest("hex")
}

async function git(projectRoot: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    const diagnostic = Buffer.from(stderr, "utf8")
    throw new Error(
      `Git release-source check failed (${exitCode}): git ${args.join(" ")} ` +
        `(stderr ${diagnostic.byteLength} bytes sha256:` +
        `${createHash("sha256").update(diagnostic).digest("hex")})`,
    )
  }
  return stdout.trim()
}

export function canonicalReleaseRepository(value: string): string {
  let candidate = value.trim()
  const scp = /^git@([^:]+):(.+)$/u.exec(candidate)
  if (scp) candidate = `https://${scp[1]}/${scp[2]}`
  const ssh = /^ssh:\/\/git@([^/]+)\/(.+)$/u.exec(candidate)
  if (ssh) candidate = `https://${ssh[1]}/${ssh[2]}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error("Release repository must be a valid canonical URL")
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Release repository must resolve to HTTPS without credentials, query or fragment",
    )
  }
  url.hostname = url.hostname.toLowerCase()
  url.pathname = url.pathname.replace(/\.git\/?$/u, "").replace(/\/+$/u, "")
  if (!url.pathname || url.pathname === "/") throw new Error("Release repository path is empty")
  return url.toString().replace(/\/$/u, "")
}

export async function verifyReleaseGitSource(input: {
  readonly projectRoot: string
  readonly expectedRepository: string
  readonly expectedCommit: string
}): Promise<VerifiedReleaseSource> {
  const root = await realpath(resolve(input.projectRoot))
  const gitRoot = await realpath(resolve(await git(root, ["rev-parse", "--show-toplevel"])))
  if (gitRoot !== root) {
    throw new Error("Release project root differs from the canonical Git top-level")
  }
  const commit = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).toLowerCase()
  if (commit !== input.expectedCommit.toLowerCase()) {
    throw new Error(`Release source commit differs from HEAD: ${input.expectedCommit} != ${commit}`)
  }
  const status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (status) {
    const diagnostic = Buffer.from(status, "utf8")
    throw new Error(
      "Release source must be clean, including untracked files " +
        `(status ${diagnostic.byteLength} bytes sha256:` +
        `${createHash("sha256").update(diagnostic).digest("hex")})`,
    )
  }
  const origin = canonicalReleaseRepository(await git(root, ["remote", "get-url", "origin"]))
  const expected = canonicalReleaseRepository(input.expectedRepository)
  if (origin !== expected) {
    throw new Error(
      "Release repository identity differs from origin " +
        `(expected sha256:${createHash("sha256").update(expected).digest("hex")}, ` +
        `observed sha256:${createHash("sha256").update(origin).digest("hex")})`,
    )
  }
  return { repository: expected, commit, root }
}
