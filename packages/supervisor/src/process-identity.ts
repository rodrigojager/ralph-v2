import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { hostname as localHostname } from "node:os"
import { join } from "node:path"

export type ProcessIdentity = {
  pid: number
  processStartToken: string
  hostname: string
}

function execute(executable: string, args: readonly string[], timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1_024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout.trim())
      },
    )
  })
}

async function linuxStartToken(pid: number): Promise<string> {
  const [stat, bootId] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
  ])
  const commandEnd = stat.lastIndexOf(")")
  if (commandEnd < 0) throw new Error("Linux process stat has no command terminator")
  // Fields after ')' start at field 3 (state); starttime is field 22, index 19 here.
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)
  const startTicks = fields[19]
  if (!startTicks || !/^\d+$/.test(startTicks)) {
    throw new Error("Linux process stat has no valid starttime field")
  }
  return `linux:${bootId.trim()}:${startTicks}`
}

async function windowsStartToken(pid: number): Promise<string> {
  const systemRoot = process.env.SystemRoot
  const script = [
    "$ErrorActionPreference='Stop'",
    `$process = Get-Process -Id ${pid}`,
    "[Console]::Out.Write($process.StartTime.ToUniversalTime().Ticks)",
  ].join("; ")
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script] as const
  const candidates = [
    ...(systemRoot
      ? [join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]
      : ["powershell.exe"]),
    "pwsh.exe",
  ]
  let ticks: string | undefined
  let firstError: unknown
  for (const executable of candidates) {
    try {
      ticks = await execute(executable, args)
      break
    } catch (error) {
      firstError ??= error
    }
  }
  if (ticks === undefined) {
    throw new Error("Windows process start time is unavailable", { cause: firstError })
  }
  if (!/^\d+$/.test(ticks)) throw new Error("Windows process start time was not an integer")
  return `windows:${ticks}`
}

async function posixStartToken(pid: number): Promise<string> {
  const started = await execute("ps", ["-p", String(pid), "-o", "lstart="])
  if (!started) throw new Error("POSIX process start time is unavailable")
  return `${process.platform}:${started.replace(/\s+/g, " ")}`
}

export async function processStartToken(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process id: ${pid}`)
  if (process.platform === "linux") return linuxStartToken(pid)
  if (process.platform === "win32") return windowsStartToken(pid)
  return posixStartToken(pid)
}

export async function captureProcessIdentity(pid = process.pid): Promise<ProcessIdentity> {
  return {
    pid,
    processStartToken: await processStartToken(pid),
    hostname: localHostname(),
  }
}

export type PidLiveness = { alive: boolean; inaccessible: boolean }

export function probePidLiveness(pid: number): PidLiveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { alive: false, inaccessible: true }
  }
  try {
    process.kill(pid, 0)
    return { alive: true, inaccessible: false }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return { alive: false, inaccessible: false }
    if (code === "EPERM" || code === "EACCES") return { alive: true, inaccessible: true }
    return { alive: false, inaccessible: true }
  }
}
