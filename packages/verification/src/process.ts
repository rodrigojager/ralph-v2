import { mkdir, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { CommandSpecSchema } from "@ralph/prd"
import { processShutdownRegistry } from "@ralph/supervisor"
import { redactText, secretValuesFromEnvironment } from "@ralph/telemetry"

type CommandSpec = typeof CommandSpecSchema._output

export type CapturedCommand = {
  argv: string[]
  cwd: string
  exitCode?: number
  durationMs: number
  stdout: string
  stderr: string
  rawStdout: string
  rawStderr: string
  stdoutBytes: number
  stderrBytes: number
  truncated: boolean
  rawTruncated: boolean
  timedOut: boolean
  deadlineExceeded: boolean
  error?: string
}

const DEFAULT_RAW_OUTPUT_LIMIT_BYTES = 16 * 1_024 * 1_024

const SAFE_ENVIRONMENT_KEYS = [
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

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

async function capturedText(
  stream: ReadableStream<Uint8Array>,
  summaryLimit: number,
  rawLimit: number,
): Promise<{
  summary: string
  raw: string
  bytes: number
  summaryTruncated: boolean
  rawTruncated: boolean
}> {
  const reader = stream.getReader()
  const rawChunks: Uint8Array[] = []
  let rawRetained = 0
  let bytes = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    bytes += result.value.byteLength
    if (rawRetained < rawLimit) {
      const available = Math.min(result.value.byteLength, rawLimit - rawRetained)
      rawChunks.push(result.value.subarray(0, available))
      rawRetained += available
    }
  }
  const rawBytes = Buffer.concat(rawChunks.map((chunk) => Buffer.from(chunk)))
  const summaryRetained = Math.min(rawBytes.byteLength, summaryLimit)
  return {
    summary: new TextDecoder().decode(rawBytes.subarray(0, summaryRetained)),
    raw: new TextDecoder().decode(rawBytes),
    bytes,
    summaryTruncated: bytes > summaryRetained,
    rawTruncated: bytes > rawRetained,
  }
}

function redactCapturedText(value: string, secrets: readonly string[], truncated: boolean): string {
  let redacted = redactText(value, secrets)
  if (!truncated) return redacted

  // A byte cap may split a secret at the retained suffix. Redact every suffix
  // that is a non-empty prefix of a known secret so truncation cannot leak it.
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, redacted.length); length > 0; length -= 1) {
      if (!redacted.endsWith(secret.slice(0, length))) continue
      redacted = `${redacted.slice(0, -length)}[REDACTED]`
      break
    }
  }
  return redacted
}

function inheritedEnvironment(source: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {}
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key]
    if (value !== undefined) output[key] = value
  }
  return output
}

function commandEnvironment(
  overrides: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const output = inheritedEnvironment(process.env)
  if (!overrides) return output
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (!Object.hasOwn(overrides, key)) continue
    const value = overrides[key]
    if (value === undefined) delete output[key]
    else output[key] = value
  }
  return output
}

function resolveEnvironmentReferences(
  refs: Record<string, string> | undefined,
  source: Record<string, string | undefined>,
): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [target, reference] of Object.entries(refs ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) {
      throw new Error(`Invalid command environment target: ${target}`)
    }
    const match = /^(?:env|environment):([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference)
    if (!match) throw new Error(`Unsupported environment reference: ${reference}`)
    const sourceName = match[1] as string
    const value = source[sourceName]
    if (value === undefined) throw new Error(`Environment reference is unavailable: ${reference}`)
    output[target] = value
  }
  return output
}

function spawnCommand(argv: string[], cwd: string, environment: Record<string, string>) {
  return Bun.spawn(argv, {
    cwd,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
}

export async function runStructuredCommand(
  spec: CommandSpec,
  options: {
    workspaceRoot: string
    signal?: AbortSignal
    environment?: Record<string, string | undefined>
    environmentRoot?: string
    rawOutputLimitBytes?: number
    deadlineAt?: string
  },
): Promise<CapturedCommand> {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error("Command execution cancelled before spawn")
  }
  const started = performance.now()
  const deadline = options.deadlineAt ? Date.parse(options.deadlineAt) : undefined
  if (deadline !== undefined && !Number.isFinite(deadline)) {
    throw new Error(`Execution deadline is not a valid timestamp: ${options.deadlineAt}`)
  }
  const initialRemaining = deadline === undefined ? undefined : deadline - Date.now()
  if (initialRemaining !== undefined && initialRemaining <= 0) {
    return {
      argv: [spec.executable, ...spec.args],
      cwd: spec.cwd ?? ".",
      durationMs: performance.now() - started,
      stdout: "",
      stderr: "",
      rawStdout: "",
      rawStderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      rawTruncated: false,
      timedOut: true,
      deadlineExceeded: true,
    }
  }
  const rawOutputLimitBytes = options.rawOutputLimitBytes ?? DEFAULT_RAW_OUTPUT_LIMIT_BYTES
  if (!Number.isSafeInteger(rawOutputLimitBytes) || rawOutputLimitBytes < spec.outputLimitBytes) {
    throw new Error(
      "Raw output limit must be a safe integer greater than or equal to outputLimitBytes",
    )
  }
  const workspace = await realpath(resolve(options.workspaceRoot))
  const cwd = await realpath(resolve(workspace, spec.cwd ?? "."))
  if (!contained(workspace, cwd)) throw new Error("Command cwd resolves outside the workspace")
  const sourceEnvironment = options.environment ?? process.env
  const referencedEnvironment = resolveEnvironmentReferences(
    spec.environmentRefs,
    sourceEnvironment,
  )
  // Freeze the exact values used for this spawn. Re-reading process.env after
  // the child settles could redact a rotated value while leaking the value
  // that was actually handed to the process.
  // This local-only redaction set is never returned, persisted or emitted.
  const redactionSecrets = [
    ...secretValuesFromEnvironment(sourceEnvironment),
    ...Object.values(referencedEnvironment),
  ]
  const environment = {
    // CommandContext environments may intentionally contain only Ralph
    // overrides (for example RALPH_CONFIG_HOME). Preserve the host's bounded
    // execution variables in that case so a portable bare executable such as
    // `bun` remains discoverable on POSIX. Explicit own-key undefined still
    // removes a safe variable; secrets and arbitrary host variables never enter
    // this projection.
    ...commandEnvironment(options.environment),
    ...referencedEnvironment,
    CI: "1",
    NO_COLOR: "1",
  }
  if (options.environmentRoot) {
    const root = resolve(options.environmentRoot)
    const temporary = resolve(root, "tmp")
    const home = resolve(root, "home")
    await Promise.all([mkdir(temporary, { recursive: true }), mkdir(home, { recursive: true })])
    Object.assign(environment, {
      HOME: home,
      USERPROFILE: home,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
    })
  }

  const argv = [spec.executable, ...spec.args]
  let child: ReturnType<typeof spawnCommand>
  try {
    child = spawnCommand(argv, cwd, environment)
  } catch (error) {
    return {
      argv,
      cwd: relative(workspace, cwd).replaceAll("\\", "/") || ".",
      durationMs: performance.now() - started,
      stdout: "",
      stderr: "",
      rawStdout: "",
      rawStderr: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      rawTruncated: false,
      timedOut: false,
      deadlineExceeded: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  let timedOut = false
  let deadlineExceeded = false
  let forceKill: ReturnType<typeof setTimeout> | undefined
  let cancellationForceKill: ReturnType<typeof setTimeout> | undefined
  const unregisterProcess = processShutdownRegistry.register({
    pid: child.pid,
    cancel: async () => {
      child.kill()
    },
    forceKill: async () => {
      child.kill(9)
    },
  })
  void child.exited.finally(unregisterProcess).catch(() => undefined)
  const onAbort = (): void => {
    child.kill()
    cancellationForceKill = setTimeout(() => child.kill(9), 500)
  }
  options.signal?.addEventListener("abort", onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now())
  const timeoutMs = remaining === undefined ? spec.timeoutMs : Math.min(spec.timeoutMs, remaining)
  const boundedByDeadline = remaining !== undefined && remaining <= spec.timeoutMs
  const timeout = setTimeout(() => {
    timedOut = true
    deadlineExceeded = boundedByDeadline
    child.kill()
    forceKill = setTimeout(() => child.kill(9), 500)
  }, timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      capturedText(child.stdout, spec.outputLimitBytes, rawOutputLimitBytes),
      capturedText(child.stderr, spec.outputLimitBytes, rawOutputLimitBytes),
    ])
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Command execution cancelled")
    }
    return {
      argv,
      cwd: relative(workspace, cwd).replaceAll("\\", "/") || ".",
      exitCode,
      durationMs: performance.now() - started,
      stdout: redactCapturedText(stdout.summary, redactionSecrets, stdout.summaryTruncated),
      stderr: redactCapturedText(stderr.summary, redactionSecrets, stderr.summaryTruncated),
      rawStdout: redactCapturedText(stdout.raw, redactionSecrets, stdout.rawTruncated),
      rawStderr: redactCapturedText(stderr.raw, redactionSecrets, stderr.rawTruncated),
      stdoutBytes: stdout.bytes,
      stderrBytes: stderr.bytes,
      truncated: stdout.summaryTruncated || stderr.summaryTruncated,
      rawTruncated: stdout.rawTruncated || stderr.rawTruncated,
      timedOut,
      deadlineExceeded: deadlineExceeded || (deadline !== undefined && Date.now() >= deadline),
    }
  } finally {
    clearTimeout(timeout)
    if (forceKill) clearTimeout(forceKill)
    if (cancellationForceKill) clearTimeout(cancellationForceKill)
    options.signal?.removeEventListener("abort", onAbort)
  }
}
