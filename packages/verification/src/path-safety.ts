import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

export type SafeWorkspaceTarget = {
  root: string
  target: string
  exists: boolean
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

export async function resolveSafeWorkspaceTarget(
  workspaceRoot: string,
  path: string,
): Promise<SafeWorkspaceTarget> {
  const root = await realpath(resolve(workspaceRoot))
  const target = resolve(root, path)
  if (!contained(root, target)) throw new Error(`Verification path escapes workspace: ${path}`)
  let probe = target
  let exists = true
  while (true) {
    try {
      const metadata = await lstat(probe)
      const canonical = await realpath(probe)
      if (metadata.isSymbolicLink() || !contained(root, canonical)) {
        throw new Error(`Verification path is linked or escapes workspace: ${path}`)
      }
      return { root, target, exists }
    } catch (error) {
      if (error instanceof Error && !("code" in error)) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      exists = false
      const parent = dirname(probe)
      if (parent === probe) throw new Error(`No safe ancestor for verification path: ${path}`)
      probe = parent
    }
  }
}

export function portablePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "")
}

export function pathWithinPortableScope(path: string, scope: string): boolean {
  const candidate = portablePath(path)
  const boundary = portablePath(scope).replace(/\/$/, "")
  return boundary === "." || candidate === boundary || candidate.startsWith(`${boundary}/`)
}
