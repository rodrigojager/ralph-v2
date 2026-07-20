import { dlopen } from "bun:ffi"
import { link, mkdir, open, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

// Windows scanners and readers can temporarily deny replacement. Back off
// before revalidating the pre-commit condition so the validation remains as
// close as possible to the next commit attempt.
const WINDOWS_RENAME_RETRY_DELAYS_MS = [0, 10, 25, 50, 100] as const
const WINDOWS_RETRYABLE_RENAME_CODES = new Set(["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"])
const ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 = 1177

const windowsFiles =
  process.platform === "win32"
    ? dlopen("kernel32.dll", {
        ReplaceFileW: {
          args: ["ptr", "ptr", "ptr", "u32", "ptr", "ptr"],
          returns: "i32",
        },
        GetLastError: { args: [], returns: "u32" },
      })
    : undefined

function windowsWideString(value: string): Uint8Array {
  return Buffer.from(`${value}\0`, "utf16le")
}

async function replaceFileAtomicWindows(source: string, target: string): Promise<void> {
  if (!windowsFiles) throw new Error("ReplaceFileW is available only on Windows")
  const recovery = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.recovery`,
  )
  const replaced = windowsFiles.symbols.ReplaceFileW(
    windowsWideString(target),
    windowsWideString(source),
    windowsWideString(recovery),
    0,
    null,
    null,
  )
  if (replaced === 0) {
    const code = windowsFiles.symbols.GetLastError()
    if (code === ERROR_UNABLE_TO_MOVE_REPLACEMENT_2) {
      try {
        await restoreWindowsRecovery(recovery, target)
      } catch (rollbackError) {
        throw new AggregateError(
          [new Error(`ReplaceFileW failed with Windows error ${code}`), rollbackError],
          `ReplaceFileW displaced the original target; recovery remains at ${recovery}`,
        )
      }
    }
    throw new Error(`ReplaceFileW failed with Windows error ${code}`)
  }

  // ReplaceFileW commits the new target and recovery copy in one filesystem
  // transaction. Cleanup is deliberately best-effort: if Windows still has an
  // old-reader handle, retaining the narrowly named recovery file is safer than
  // reporting a false rollback after the new target has already committed.
  await rm(recovery, { force: true }).catch(() => undefined)
}

async function restoreWindowsRecovery(recovery: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]
    if (retryDelay && retryDelay > 0) await delay(retryDelay)
    try {
      // A hard link recreates the missing target without ever overwriting a
      // path that another actor may have created after ReplaceFileW failed.
      await link(recovery, target)
      await rm(recovery, { force: true }).catch(() => undefined)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EEXIST") {
        throw new Error(
          `Refusing to overwrite a target recreated while recovery remains at ${recovery}`,
        )
      }
      if (
        !WINDOWS_RETRYABLE_RENAME_CODES.has(code ?? "") ||
        WINDOWS_RENAME_RETRY_DELAYS_MS[attempt + 1] === undefined
      ) {
        throw error
      }
    }
  }
}

async function renameAtomic(
  source: string,
  target: string,
  overwrite: boolean,
  beforeCommit?: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]
    if (process.platform === "win32" && overwrite && retryDelay && retryDelay > 0) {
      await delay(retryDelay)
    }
    if (beforeCommit) await beforeCommit()
    try {
      await rename(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retriesExhausted = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt + 1] === undefined
      if (
        process.platform !== "win32" ||
        !overwrite ||
        !WINDOWS_RETRYABLE_RENAME_CODES.has(code ?? "") ||
        retriesExhausted
      ) {
        if (
          process.platform === "win32" &&
          overwrite &&
          retriesExhausted &&
          WINDOWS_RETRYABLE_RENAME_CODES.has(code ?? "")
        ) {
          try {
            await replaceFileAtomicWindows(source, target)
            return
          } catch (replacementError) {
            throw new AggregateError(
              [error, replacementError],
              "Atomic replacement failed through rename and ReplaceFileW",
            )
          }
        }
        throw error
      }
    }
  }
}

export async function writeFileAtomic(
  target: string,
  content: string | Uint8Array,
  options: { overwrite?: boolean; mode?: number; beforeCommit?: () => Promise<void> } = {},
): Promise<void> {
  const directory = dirname(target)
  await mkdir(directory, { recursive: true })
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )

  let committed = false
  try {
    const handle = await open(temporary, "wx", options.mode ?? 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }

    if (!options.overwrite && (await Bun.file(target).exists())) {
      throw new Error(`Refusing to overwrite existing file: ${target}`)
    }
    // Never displace the committed target before replacement. A transient
    // Windows sharing violation is retried in place; a permanent failure leaves
    // the old file intact and the finally block removes only this writer's temp.
    await renameAtomic(temporary, target, options.overwrite ?? false, options.beforeCommit)
    committed = true
  } finally {
    if (!committed) await rm(temporary, { force: true })
  }

  try {
    const directoryHandle = await open(directory, "r")
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch {
    // Directory fsync is not available on every supported Windows/filesystem combination.
  }
}

export async function writeJsonAtomic(
  target: string,
  value: unknown,
  options: { overwrite?: boolean; mode?: number } = {},
): Promise<void> {
  await writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, options)
}
