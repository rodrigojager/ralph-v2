import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"

export const SUBPROCESS_TIMEOUT_MS = 15_000
export const SUBPROCESS_SECRET_CANARY = "ralph-subprocess-secret-canary-7f3d"

const SAFE_INHERITED_ENVIRONMENT_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "SystemDrive",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
] as const

export async function isolatedChildEnvironment(root: string): Promise<Record<string, string>> {
  const environmentRoot = resolve(root)
  const home = join(environmentRoot, "home")
  const temporary = join(environmentRoot, "tmp")
  const appData = join(home, "AppData", "Roaming")
  const localAppData = join(home, "AppData", "Local")
  const xdgConfig = join(home, ".config")
  const ralphConfig = join(environmentRoot, "ralph-config")
  await Promise.all(
    [home, temporary, appData, localAppData, xdgConfig, ralphConfig].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  )

  const environment: Record<string, string> = {}
  for (const key of SAFE_INHERITED_ENVIRONMENT_KEYS) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }

  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: xdgConfig,
    RALPH_CONFIG_HOME: ralphConfig,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    CI: "1",
    NO_COLOR: "1",
    RALPH_API_KEY: SUBPROCESS_SECRET_CANARY,
  }
}

export type CapturedProcess = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function runCapturedProcess(
  command: string[],
  options: { cwd: string; environment: Record<string, string>; timeoutMs?: number },
): Promise<CapturedProcess> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  let timedOut = false
  let forceKill: ReturnType<typeof setTimeout> | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
    forceKill = setTimeout(() => child.kill(9), 500)
  }, options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timeout)
    if (forceKill) clearTimeout(forceKill)
  }
}

export function assertNoSecretLeak(
  values: readonly string[],
  secrets: readonly string[],
  context: string,
): void {
  for (const secret of secrets) {
    if (secret.length < 4) continue
    if (values.some((value) => value.includes(secret))) {
      throw new Error(`${context} exposed a secret value; capture was aborted`)
    }
  }
}
