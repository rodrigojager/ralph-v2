import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import type { ConfigEditorCommandService } from "@ralph/commands"
import { EXIT_CODES, RalphError } from "@ralph/domain"
import { writeFileAtomic } from "@ralph/persistence"

const MAX_EDITOR_DOCUMENT_BYTES = 1024 * 1024

const EDITOR_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
] as const

function editorEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    EDITOR_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = source[key]
      return value === undefined ? [] : [[key, value] as const]
    }),
  )
}

function editorArguments(environment: Record<string, string | undefined>): string[] {
  const raw = environment.RALPH_CONFIG_EDITOR_ARGS_JSON
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new RalphError(
      "RALPH_CONFIG_EDITOR_ARGS_INVALID",
      "RALPH_CONFIG_EDITOR_ARGS_JSON must be a JSON array of argument strings",
      { exitCode: EXIT_CODES.invalidUsage, cause: error },
    )
  }
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        item.length > 4_096 ||
        [...item].some((character) => (character.codePointAt(0) ?? 0) < 32),
    )
  ) {
    throw new RalphError(
      "RALPH_CONFIG_EDITOR_ARGS_INVALID",
      "RALPH_CONFIG_EDITOR_ARGS_JSON contains an invalid editor argument",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  return value as string[]
}

async function resolveEditorExecutable(
  environment: Record<string, string | undefined>,
): Promise<string> {
  const configured = environment.RALPH_CONFIG_EDITOR?.trim()
  if (!configured || [...configured].some((character) => (character.codePointAt(0) ?? 0) < 32)) {
    throw new RalphError(
      "RALPH_CONFIG_EDITOR_UNAVAILABLE",
      "RALPH_CONFIG_EDITOR must name one trusted executable without shell syntax",
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Set RALPH_CONFIG_EDITOR to an executable path and optionally RALPH_CONFIG_EDITOR_ARGS_JSON to a JSON argv array.",
      },
    )
  }
  const selected = isAbsolute(configured) ? configured : Bun.which(configured)
  if (!selected) {
    throw new RalphError(
      "RALPH_CONFIG_EDITOR_UNAVAILABLE",
      `Configured editor executable was not found: ${configured}`,
      { exitCode: EXIT_CODES.blocked },
    )
  }
  const executable = await realpath(resolve(selected))
  const entry = await lstat(executable)
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new RalphError(
      "RALPH_CONFIG_EDITOR_UNSAFE",
      "Configured editor must resolve to a regular executable file",
      { exitCode: EXIT_CODES.policyDenied, file: executable },
    )
  }
  return executable
}

async function removeEditorTemporaryDirectory(path: string): Promise<void> {
  const canonicalTemp = await realpath(resolve(tmpdir()))
  const parent = await realpath(dirname(path))
  if (parent !== canonicalTemp || !basename(path).startsWith("ralph-config-edit-")) {
    throw new RalphError(
      "RALPH_CONFIG_EDITOR_TEMP_UNSAFE",
      "Refusing to clean an unexpected config editor temporary directory",
      { exitCode: EXIT_CODES.policyDenied, file: path },
    )
  }
  await rm(path, { recursive: true, force: true })
}

async function readStableEditorDocument(
  path: string,
  initial: Awaited<ReturnType<typeof lstat>>,
): Promise<Uint8Array> {
  const handle = await open(path, "r")
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      opened.size !== initial.size
    ) {
      throw new RalphError(
        "RALPH_CONFIG_EDITOR_RESULT_CHANGED",
        "Config editor result identity changed before it was read",
        { exitCode: EXIT_CODES.conflict, file: path },
      )
    }

    const buffer = Buffer.allocUnsafe(MAX_EDITOR_DOCUMENT_BYTES + 1)
    let size = 0
    while (size < buffer.byteLength) {
      const read = await handle.read(buffer, size, buffer.byteLength - size, size)
      if (read.bytesRead === 0) break
      size += read.bytesRead
    }
    if (size > MAX_EDITOR_DOCUMENT_BYTES) {
      throw new RalphError(
        "RALPH_CONFIG_EDITOR_RESULT_TOO_LARGE",
        "Config editor result exceeded the bounded size limit while it was read",
        {
          exitCode: EXIT_CODES.policyDenied,
          file: path,
          details: { size, maximumBytes: MAX_EDITOR_DOCUMENT_BYTES },
        },
      )
    }

    const finalOpened = await handle.stat()
    const finalPath = await lstat(path)
    if (
      !finalOpened.isFile() ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      finalOpened.dev !== opened.dev ||
      finalOpened.ino !== opened.ino ||
      finalPath.dev !== opened.dev ||
      finalPath.ino !== opened.ino ||
      finalOpened.size !== size ||
      finalPath.size !== size ||
      finalOpened.mtimeMs !== opened.mtimeMs ||
      finalOpened.ctimeMs !== opened.ctimeMs
    ) {
      throw new RalphError(
        "RALPH_CONFIG_EDITOR_RESULT_CHANGED",
        "Config editor result changed while it was read",
        { exitCode: EXIT_CODES.conflict, file: path },
      )
    }
    return buffer.subarray(0, size)
  } finally {
    await handle.close()
  }
}

export function createConfigEditorCommandService(
  environment: Record<string, string | undefined>,
): ConfigEditorCommandService | undefined {
  if (!environment.RALPH_CONFIG_EDITOR?.trim()) return undefined
  return {
    async edit(request) {
      if (request.signal?.aborted) return { status: "cancelled" }
      const executable = await resolveEditorExecutable(environment)
      const args = editorArguments(environment)
      const canonicalTemp = await realpath(resolve(tmpdir()))
      const temporaryRoot = await mkdtemp(join(canonicalTemp, "ralph-config-edit-"))
      const documentPath = join(temporaryRoot, "config.yaml")
      try {
        await writeFileAtomic(documentPath, request.document, { overwrite: false, mode: 0o600 })
        const child = Bun.spawn([executable, ...args, documentPath], {
          cwd: temporaryRoot,
          env: editorEnvironment(environment),
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          // This is the only intentionally visible subprocess: the user explicitly
          // asked Ralph to open an interactive editor, which may itself be a GUI.
          windowsHide: false,
          ...(request.signal ? { signal: request.signal } : {}),
        })
        const exitCode = await child.exited
        if (request.signal?.aborted || exitCode === 130) return { status: "cancelled" }
        if (exitCode !== 0) {
          throw new RalphError(
            "RALPH_CONFIG_EDITOR_FAILED",
            `Configured editor exited with code ${exitCode}`,
            { exitCode: EXIT_CODES.operationalError, file: executable },
          )
        }
        const editedEntry = await lstat(documentPath)
        if (
          !editedEntry.isFile() ||
          editedEntry.isSymbolicLink() ||
          editedEntry.size > MAX_EDITOR_DOCUMENT_BYTES
        ) {
          throw new RalphError(
            "RALPH_CONFIG_EDITOR_RESULT_UNSAFE",
            "Config editor result must remain a bounded regular non-linked file",
            {
              exitCode: EXIT_CODES.policyDenied,
              file: documentPath,
              details: {
                size: editedEntry.size,
                maximumBytes: MAX_EDITOR_DOCUMENT_BYTES,
              },
            },
          )
        }
        const editedBytes = await readStableEditorDocument(documentPath, editedEntry)
        let document: string
        try {
          document = new TextDecoder("utf-8", { fatal: true }).decode(editedBytes)
        } catch (error) {
          throw new RalphError(
            "RALPH_CONFIG_EDITOR_RESULT_ENCODING_INVALID",
            "Config editor result must be valid UTF-8",
            { exitCode: EXIT_CODES.invalidUsage, file: documentPath, cause: error },
          )
        }
        return { status: "submitted", document }
      } finally {
        await removeEditorTemporaryDirectory(temporaryRoot)
      }
    },
  }
}
