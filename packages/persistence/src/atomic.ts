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
const WINDOWS_REPLACE_TIMEOUT_MS = 15_000

const WINDOWS_REPLACE_FILE_SCRIPT = `
$ErrorActionPreference = "Stop"
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [System.IO.File]::Replace(
    [string]$request.source,
    [string]$request.target,
    [string]$request.recovery,
    $true
  )
} catch {
  $code = $_.Exception.HResult -band 0xffff
  [Console]::Error.Write("RALPH_WINDOWS_ERROR:$($code):" + $_.Exception.Message)
  exit 1
}
`
const WINDOWS_REPLACE_FILE_ENCODED = Buffer.from(WINDOWS_REPLACE_FILE_SCRIPT, "utf16le").toString(
  "base64",
)

function isUnavailableBunFfi(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("dlopen() is not available in this build") ||
      error.message.includes("TinyCC is disabled"))
  )
}

const windowsFiles = (() => {
  if (process.platform !== "win32") return undefined
  try {
    return dlopen("kernel32.dll", {
      ReplaceFileW: {
        args: ["ptr", "ptr", "ptr", "u32", "ptr", "ptr"],
        returns: "i32",
      },
      GetLastError: { args: [], returns: "u32" },
    })
  } catch (error) {
    // Bun's native Windows arm64 build can omit TinyCC/FFI. Ordinary rename
    // remains the primary atomic replacement path; only the final sharing-
    // violation fallback becomes unavailable and continues to fail closed.
    if (isUnavailableBunFfi(error)) return undefined
    throw error
  }
})()

function windowsWideString(value: string): Uint8Array {
  return Buffer.from(`${value}\0`, "utf16le")
}

async function replaceFileAtomicWindows(source: string, target: string): Promise<void> {
  const recovery = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.recovery`,
  )
  const code = windowsFiles
    ? windowsFiles.symbols.ReplaceFileW(
        windowsWideString(target),
        windowsWideString(source),
        windowsWideString(recovery),
        0,
        null,
        null,
      ) === 0
      ? windowsFiles.symbols.GetLastError()
      : 0
    : await replaceFileAtomicWindowsWithPowerShell(source, target, recovery)
  if (code !== 0) {
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

async function replaceFileAtomicWindowsWithPowerShell(
  source: string,
  target: string,
  recovery: string,
): Promise<number> {
  const powershell = Bun.which("powershell.exe") ?? Bun.which("pwsh.exe") ?? Bun.which("pwsh")
  if (!powershell) throw new Error("PowerShell is unavailable for atomic Windows replacement")
  const child = Bun.spawn(
    [
      powershell,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      WINDOWS_REPLACE_FILE_ENCODED,
    ],
    {
      env: windowsPowerShellEnvironment(),
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const stderrPromise = new Response(child.stderr).text()
  await child.stdin.write(JSON.stringify({ source, target, recovery }))
  await child.stdin.end()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode })),
    new Promise<{ exitCode: undefined }>((resolveTimeout) => {
      timeout = setTimeout(
        () => resolveTimeout({ exitCode: undefined }),
        WINDOWS_REPLACE_TIMEOUT_MS,
      )
    }),
  ])
  if (timeout) clearTimeout(timeout)
  if (outcome.exitCode === undefined) {
    child.kill(9)
    await child.exited.catch(() => undefined)
    await stderrPromise.catch(() => "")
    throw new Error("PowerShell atomic Windows replacement timed out")
  }
  const stderr = await stderrPromise
  if (outcome.exitCode === 0) return 0
  const windowsCode = /RALPH_WINDOWS_ERROR:(\d+):/u.exec(stderr)?.[1]
  if (!windowsCode) {
    throw new Error(`PowerShell atomic Windows replacement failed: ${stderr || "unknown error"}`)
  }
  return Number.parseInt(windowsCode, 10)
}

function windowsPowerShellEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "SystemDrive",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "PSModulePath",
  ]) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
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
