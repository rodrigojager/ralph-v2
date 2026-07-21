import { constants, type Stats } from "node:fs"
import { access, lstat, readdir, realpath, stat } from "node:fs/promises"
import { dirname, join, parse, resolve } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph/domain"

export const RALPH_DIRECTORY = ".ralph"

export type WorkspaceLayout = {
  root: string
  ralph: string
  identity: string
  config: string
  ledger: string
  migrations: string
  workspaceEvents: string
  runs: string
  locks: string
  cache: string
  checkpoints: string
}

export function workspaceLayout(root: string): WorkspaceLayout {
  const ralph = join(root, RALPH_DIRECTORY)
  return {
    root,
    ralph,
    identity: join(ralph, "workspace.json"),
    config: join(ralph, "config.yaml"),
    ledger: join(ralph, "state", "ledger.sqlite"),
    migrations: join(ralph, "state", "migrations"),
    workspaceEvents: join(ralph, "events.jsonl"),
    runs: join(ralph, "runs"),
    locks: join(ralph, "locks"),
    cache: join(ralph, "cache"),
    checkpoints: join(ralph, "checkpoints"),
  }
}

export async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path)
  let info: Stats
  try {
    info = await stat(absolute)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new RalphError(
        "RALPH_WORKSPACE_INSPECTION_FAILED",
        `Could not inspect workspace directory: ${absolute}`,
        {
          exitCode: EXIT_CODES.policyDenied,
          file: absolute,
          hint: "Fix filesystem access before retrying.",
          cause: error,
        },
      )
    }
    throw new RalphError(
      "RALPH_WORKSPACE_NOT_FOUND",
      `Workspace directory not found: ${absolute}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: absolute,
        cause: error,
      },
    )
  }
  if (!info.isDirectory()) {
    throw new RalphError(
      "RALPH_WORKSPACE_NOT_DIRECTORY",
      `Workspace is not a directory: ${absolute}`,
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: absolute,
      },
    )
  }
  try {
    return await realpath(absolute)
  } catch (error) {
    throw new RalphError(
      "RALPH_WORKSPACE_INSPECTION_FAILED",
      `Could not resolve canonical workspace directory: ${absolute}`,
      {
        exitCode: EXIT_CODES.policyDenied,
        file: absolute,
        hint: "Fix filesystem access or linked-path resolution before retrying.",
        cause: error,
      },
    )
  }
}

export async function findWorkspaceRoot(start: string): Promise<string | undefined> {
  let current = await canonicalDirectory(start)
  const filesystemRoot = parse(current).root
  while (true) {
    const stateRoot = join(current, RALPH_DIRECTORY)
    try {
      await lstat(stateRoot)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new RalphError(
          "RALPH_WORKSPACE_INSPECTION_FAILED",
          `Could not inspect Ralph workspace boundary: ${stateRoot}`,
          {
            exitCode: EXIT_CODES.policyDenied,
            file: stateRoot,
            hint: "Fix filesystem access before workspace discovery; Ralph will not skip an unreadable ancestor.",
            cause: error,
          },
        )
      }
    }
    if (current === filesystemRoot) return undefined
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export async function isDirectoryEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw new RalphError(
      "RALPH_WORKSPACE_INSPECTION_FAILED",
      `Could not inspect workspace state directory: ${path}`,
      {
        exitCode: EXIT_CODES.policyDenied,
        file: path,
        hint: "Fix directory access or inspect the existing state manually before initialization.",
        cause: error,
      },
    )
  }
}

export async function assertWorkspaceWritable(root: string): Promise<void> {
  try {
    await access(root, constants.R_OK | constants.W_OK)
  } catch (error) {
    throw new RalphError(
      "RALPH_WORKSPACE_NOT_WRITABLE",
      `Workspace is not readable and writable: ${root}`,
      {
        exitCode: EXIT_CODES.policyDenied,
        file: root,
        cause: error,
      },
    )
  }
}
