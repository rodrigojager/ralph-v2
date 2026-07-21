import { createHash } from "node:crypto"
import { readFileSync, realpathSync, type Stats, statSync } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { redactText, secretValuesFromEnvironment } from "@ralph/telemetry"
import {
  type ProcessOutputChunk,
  type ProcessOutputStore,
  type ProcessSettlement,
  ProcessSettlementSchema,
  type ProcessSupervisor,
  type ShellExecution,
  type SupervisedProcessHandle,
  type SupervisedProcessRequest,
  type SupervisedProcessSpec,
  SupervisedProcessSpecSchema,
} from "./contracts"
import { processShutdownRegistry } from "./shutdown"
import { WindowsProcessJob } from "./windows-job"
import { WINDOWS_LAUNCHER_SOURCE, type WindowsLauncherRequest } from "./windows-launcher"

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

type CaptureResult = {
  summary: string
  raw: string
  bytes: number
  summaryTruncated: boolean
  rawTruncated: boolean
}

type RuntimeCallbacks = Pick<SupervisedProcessRequest, "onOutput" | "onChunk">

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameCanonicalPath(left: string, right: string): boolean {
  const comparable = (value: string): string => {
    const absolute = resolve(value)
    return process.platform === "win32" ? absolute.toLocaleLowerCase("und") : absolute
  }
  return comparable(left) === comparable(right)
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

/**
 * Revalidates a capability-bound executable without PATH lookup. Returning the
 * canonical path lets the launcher use the same path that was hashed. This
 * narrows, but cannot make atomic, the final check-to-spawn filesystem window.
 */
function verifiedExecutablePath(executable: string, expectedSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("Expected executable SHA-256 is invalid")
  }
  if (!isAbsolute(executable)) {
    throw new Error("A hash-bound executable must use an absolute path")
  }
  const canonical = realpathSync.native(executable)
  if (!sameCanonicalPath(canonical, executable)) {
    throw new Error("A hash-bound executable path must already be canonical")
  }
  const before = statSync(canonical)
  if (!before.isFile()) {
    throw new Error("A hash-bound executable must be a regular file")
  }
  const bytes = readFileSync(canonical)
  const after = statSync(canonical)
  const canonicalAfter = realpathSync.native(canonical)
  if (
    !after.isFile() ||
    !sameFileSnapshot(before, after) ||
    !sameCanonicalPath(canonicalAfter, canonical)
  ) {
    throw new Error("Hash-bound executable changed while it was revalidated")
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex")
  if (actualSha256 !== expectedSha256) {
    throw new Error("Hash-bound executable differs from its authorized content")
  }
  return canonical
}

function environmentValue(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const direct = source[name]
  if (direct !== undefined || process.platform !== "win32") return direct
  const expected = name.toLocaleLowerCase("und")
  const match = Object.entries(source).find(
    ([key, value]) => value !== undefined && key.toLocaleLowerCase("und") === expected,
  )
  return match?.[1]
}

function childEnvironment(spec: SupervisedProcessSpec): {
  environment: Record<string, string>
  referencedSecrets: readonly string[]
} {
  const output: Record<string, string> = { CI: "1", NO_COLOR: "1" }
  const inherited = spec.environmentAllowlist ?? [...SAFE_ENVIRONMENT_KEYS]
  for (const key of inherited) {
    const value = environmentValue(spec.environment, key)
    if (value !== undefined) output[key] = value
  }
  const referencedSecrets: string[] = []
  for (const [target, reference] of Object.entries(spec.environmentRefs ?? {})) {
    const sourceName = /^(?:env|environment):(.+)$/.exec(reference)?.[1]
    if (!sourceName) throw new Error(`Unsupported environment reference: ${reference}`)
    const value = environmentValue(spec.environment, sourceName)
    if (value === undefined) throw new Error(`Environment reference is unavailable: ${reference}`)
    output[target] = value
    referencedSecrets.push(value)
  }
  return { environment: output, referencedSecrets }
}

function redactTruncated(value: string, secrets: readonly string[], truncated: boolean): string {
  let output = redactText(value, secrets)
  if (!truncated) return output
  for (const secret of secrets) {
    for (let length = Math.min(secret.length - 1, output.length); length > 0; length -= 1) {
      if (!output.endsWith(secret.slice(0, length))) continue
      output = `${output.slice(0, -length)}[REDACTED]`
      break
    }
  }
  return output
}

function lastWhitespace(value: string): number {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(value[index] as string)) return index
  }
  return -1
}

function safeEmissionBoundary(value: string, proposed: number, secrets: readonly string[]): number {
  let boundary = proposed
  const candidate = value.slice(0, proposed)
  const bearer = /\bBearer\s+$/i.exec(candidate)
  if (bearer?.index !== undefined) boundary = Math.min(boundary, bearer.index)
  for (const secret of secrets) {
    const maximum = Math.min(secret.length - 1, candidate.length)
    for (let length = maximum; length > 0; length -= 1) {
      if (!candidate.endsWith(secret.slice(0, length))) continue
      boundary = Math.min(boundary, candidate.length - length)
      break
    }
  }
  return boundary
}

class StreamCapture {
  readonly #stream: "stdout" | "stderr"
  readonly #summaryLimit: number
  readonly #rawLimit: number
  readonly #secrets: readonly string[]
  readonly #callbacks: RuntimeCallbacks
  readonly #nextSequence: () => number
  readonly #decoder = new TextDecoder()
  readonly #summaryChunks: Uint8Array[] = []
  readonly #rawChunks: Uint8Array[] = []
  #summaryRetained = 0
  #rawRetained = 0
  #emittedBytes = 0
  #bytes = 0
  #pending = ""

  constructor(input: {
    stream: "stdout" | "stderr"
    summaryLimit: number
    rawLimit: number
    secrets: readonly string[]
    callbacks: RuntimeCallbacks
    nextSequence: () => number
  }) {
    this.#stream = input.stream
    this.#summaryLimit = input.summaryLimit
    this.#rawLimit = input.rawLimit
    this.#secrets = input.secrets
    this.#callbacks = input.callbacks
    this.#nextSequence = input.nextSequence
  }

  async consume(value: Uint8Array): Promise<void> {
    this.#bytes += value.byteLength
    if (this.#summaryRetained < this.#summaryLimit) {
      const retained = value.subarray(
        0,
        Math.min(value.byteLength, this.#summaryLimit - this.#summaryRetained),
      )
      this.#summaryChunks.push(retained.slice())
      this.#summaryRetained += retained.byteLength
    }
    if (this.#rawRetained < this.#rawLimit) {
      const retained = value.subarray(
        0,
        Math.min(value.byteLength, this.#rawLimit - this.#rawRetained),
      )
      this.#rawChunks.push(retained.slice())
      this.#rawRetained += retained.byteLength
    }
    if (this.#emittedBytes >= this.#summaryLimit) return
    const selected = value.subarray(
      0,
      Math.min(value.byteLength, this.#summaryLimit - this.#emittedBytes),
    )
    this.#emittedBytes += selected.byteLength
    this.#pending += this.#decoder.decode(selected, { stream: true })
    const boundary = lastWhitespace(this.#pending)
    if (boundary < 0) return
    const emissionBoundary = safeEmissionBoundary(this.#pending, boundary + 1, this.#secrets)
    if (emissionBoundary === 0) return
    const complete = this.#pending.slice(0, emissionBoundary)
    this.#pending = this.#pending.slice(emissionBoundary)
    await this.#emit(redactText(complete, this.#secrets), selected.byteLength)
  }

  async finish(): Promise<CaptureResult> {
    this.#pending += this.#decoder.decode()
    if (this.#pending) {
      await this.#emit(
        redactTruncated(this.#pending, this.#secrets, this.#bytes > this.#emittedBytes),
        0,
      )
      this.#pending = ""
    }
    const summaryBytes = Buffer.concat(this.#summaryChunks.map((chunk) => Buffer.from(chunk)))
    const rawBytes = Buffer.concat(this.#rawChunks.map((chunk) => Buffer.from(chunk)))
    return {
      summary: redactTruncated(
        new TextDecoder().decode(summaryBytes),
        this.#secrets,
        this.#bytes > this.#summaryRetained,
      ),
      raw: redactTruncated(
        new TextDecoder().decode(rawBytes),
        this.#secrets,
        this.#bytes > this.#rawRetained,
      ),
      bytes: this.#bytes,
      summaryTruncated: this.#bytes > this.#summaryRetained,
      rawTruncated: this.#bytes > this.#rawRetained,
    }
  }

  async #emit(text: string, bytes: number): Promise<void> {
    if (!text) return
    try {
      await this.#callbacks.onOutput?.(this.#stream, text)
      await this.#callbacks.onChunk?.({
        sequence: this.#nextSequence(),
        stream: this.#stream,
        text,
        bytes,
        totalBytes: this.#bytes,
        at: new Date().toISOString(),
      } satisfies ProcessOutputChunk)
    } catch {
      // Event/TUI consumers are observers. Their failure cannot orphan or alter
      // the command-owned child process lifecycle.
    }
  }
}

/**
 * Produces the one exact argv projection used for an explicitly authorized
 * shell request. Worker capability binding imports this helper so the argv
 * that is hashed before dispatch cannot drift from the argv spawned here.
 */
export function shellProcessArgv(
  shell: ShellExecution,
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const selected = shell.executable
  switch (shell.kind) {
    case "powershell":
      return [
        selected ?? Bun.which("pwsh") ?? (process.platform === "win32" ? "powershell.exe" : "pwsh"),
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        shell.script,
      ]
    case "cmd":
      return [
        selected ?? environmentValue(environment, "COMSPEC") ?? "cmd.exe",
        "/d",
        "/s",
        "/c",
        shell.script,
      ]
    case "sh":
      return [selected ?? "sh", "-c", shell.script]
    case "bash":
      return [selected ?? "bash", "-c", shell.script]
    case "custom":
      return [selected as string, "-c", shell.script]
  }
}

function processArgv(spec: SupervisedProcessSpec): string[] {
  return spec.shell
    ? shellProcessArgv(spec.shell, spec.environment)
    : [spec.executable, ...spec.args]
}

function launcherEnvironment(
  environment: Readonly<Record<string, string>>,
): Record<string, string> {
  const output: Record<string, string> = { BUN_BE_BUN: "1", CI: "1", NO_COLOR: "1" }
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = environmentValue(environment, key)
    if (value !== undefined) output[key] = value
  }
  return output
}

async function spawnWindowsProcess(
  argv: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  stdin: Uint8Array | undefined,
  expectedExecutableSha256: string | undefined,
  expectedCanonicalCwd: string | undefined,
): Promise<{
  child: Bun.ReadableSubprocess
  windowsJob: WindowsProcessJob | undefined
}> {
  let windowsJob: WindowsProcessJob | undefined
  let child!: Bun.PipedSubprocess
  try {
    child = Bun.spawn([process.execPath, "-e", WINDOWS_LAUNCHER_SOURCE], {
      cwd,
      env: launcherEnvironment(environment),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      windowsHide: true,
    })
    windowsJob = await WindowsProcessJob.createForProcess(child.pid)
  } catch (error) {
    if (child?.exitCode === null) child.kill(9)
    await child?.exited.catch(() => undefined)
    await windowsJob?.close()
    throw error
  }

  try {
    const request: WindowsLauncherRequest = {
      schemaVersion: 3,
      argv,
      cwd,
      environment,
      stdinBase64: stdin ? Buffer.from(stdin).toString("base64") : null,
      expectedExecutableSha256: expectedExecutableSha256 ?? null,
      expectedCanonicalCwd: expectedCanonicalCwd ?? null,
    }
    await child.stdin.write(JSON.stringify(request))
    await child.stdin.end()
    return { child, windowsJob }
  } catch (error) {
    windowsJob?.terminate()
    if (child.exitCode === null) child.kill(9)
    await child.exited.catch(() => undefined)
    await windowsJob?.close()
    throw error
  }
}

async function spawnProcess(
  argv: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  stdin: Uint8Array | undefined,
  expectedExecutableSha256: string | undefined,
  expectedCanonicalCwd: string | undefined,
) {
  if (process.platform === "win32") {
    return spawnWindowsProcess(
      argv,
      cwd,
      environment,
      stdin,
      expectedExecutableSha256,
      expectedCanonicalCwd,
    )
  }
  const spawnArgv = expectedExecutableSha256
    ? [verifiedExecutablePath(argv[0] as string, expectedExecutableSha256), ...argv.slice(1)]
    : [...argv]
  const child = Bun.spawn(spawnArgv, {
    cwd,
    env: environment,
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    windowsHide: true,
  })
  return { child, windowsJob: undefined }
}

async function runTaskkill(pid: number, force: boolean): Promise<boolean> {
  const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])]
  let helper: ReturnType<typeof Bun.spawn>
  try {
    helper = Bun.spawn(["taskkill.exe", ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
  } catch {
    return false
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      helper.exited.then((exitCode) => ({ exitCode })),
      new Promise<{ exitCode: undefined }>((resolve) => {
        timeout = setTimeout(() => resolve({ exitCode: undefined }), 5_000)
      }),
    ])
    if (outcome.exitCode === undefined) helper.kill(9)
    return outcome.exitCode === 0
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

export type BunProcessSupervisorOptions = {
  outputStore?: ProcessOutputStore
}

export class BunProcessSupervisor implements ProcessSupervisor {
  readonly #outputStore: ProcessOutputStore | undefined

  constructor(options: BunProcessSupervisorOptions = {}) {
    this.#outputStore = options.outputStore
  }

  which(
    executable: string,
    environment?: Readonly<Record<string, string | undefined>>,
  ): string | null {
    if (executable === "bun" || executable === "bun.exe") {
      return realpathSync.native(process.execPath)
    }
    const path = environment ? environmentValue(environment, "PATH") : undefined
    return Bun.which(executable, path ? { PATH: path } : undefined)
  }

  async run(request: SupervisedProcessRequest): Promise<ProcessSettlement> {
    return (await this.start(request)).settlement
  }

  async start(request: SupervisedProcessRequest): Promise<SupervisedProcessHandle> {
    const {
      signal,
      onOutput,
      onChunk,
      expectedCanonicalCwd,
      expectedExecutableSha256,
      ...serializable
    } = request
    const spec = SupervisedProcessSpecSchema.parse(serializable)
    const started = performance.now()
    const argv = processArgv(spec)
    const settledWithoutChild = (input: {
      timedOut?: boolean
      cancelled?: boolean
      error?: string
    }): ProcessSettlement =>
      ProcessSettlementSchema.parse({
        argv,
        cwd: spec.cwd,
        stdout: "",
        stderr: "",
        rawStdout: "",
        rawStderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        outputTruncated: false,
        rawOutputTruncated: false,
        timedOut: input.timedOut ?? false,
        cancelled: input.cancelled ?? false,
        treeTerminated: false,
        outputRefs: [],
        durationMs: performance.now() - started,
        ...(input.error ? { error: input.error } : {}),
      })
    if (
      expectedExecutableSha256 !== undefined &&
      (!/^[a-f0-9]{64}$/.test(expectedExecutableSha256) || !isAbsolute(argv[0] as string))
    ) {
      return {
        settlement: Promise.resolve(
          settledWithoutChild({
            error: "Hash-bound executable requires a valid SHA-256 and absolute argv[0]",
          }),
        ),
        async cancel() {},
        async forceKill() {},
      }
    }
    if (signal?.aborted) {
      return {
        settlement: Promise.resolve(settledWithoutChild({ cancelled: true })),
        async cancel() {},
        async forceKill() {},
      }
    }

    let cwd: string
    let environment: Record<string, string>
    let referencedSecrets: readonly string[]
    try {
      cwd = await realpath(spec.cwd)
      const cwdInfo = await lstat(cwd)
      if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink())
        throw new Error(`Process cwd is not a directory: ${spec.cwd}`)
      if (expectedCanonicalCwd && !sameCanonicalPath(cwd, expectedCanonicalCwd)) {
        throw new Error("Process cwd differs from the command-authorized canonical directory")
      }
      const resolved = childEnvironment(spec)
      environment = resolved.environment
      referencedSecrets = resolved.referencedSecrets
    } catch (error) {
      return {
        settlement: Promise.resolve(
          settledWithoutChild({ error: redactText(errorMessage(error), spec.secretValues ?? []) }),
        ),
        async cancel() {},
        async forceKill() {},
      }
    }

    const stdin =
      spec.stdin === undefined
        ? undefined
        : typeof spec.stdin === "string"
          ? Buffer.from(spec.stdin, "utf8")
          : spec.stdin
    // Resolving cwd/environment can await filesystem and credential work. Do
    // not spawn when cancellation arrived after the initial fast-path check.
    if (signal?.aborted) {
      return {
        settlement: Promise.resolve(settledWithoutChild({ cancelled: true })),
        async cancel() {},
        async forceKill() {},
      }
    }
    let child: Awaited<ReturnType<typeof spawnProcess>>["child"]
    let windowsJob: WindowsProcessJob | undefined
    try {
      // Re-resolve after every awaited environment/stdin preparation step and
      // immediately before the platform launcher receives cwd. This detects a
      // symlink/junction retarget instead of silently spawning in a new place.
      cwd = await realpath(spec.cwd)
      const cwdInfo = await lstat(cwd)
      if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink()) {
        throw new Error(`Process cwd is not a directory: ${spec.cwd}`)
      }
      if (expectedCanonicalCwd && !sameCanonicalPath(cwd, expectedCanonicalCwd)) {
        throw new Error("Process cwd changed after authorization and before spawn")
      }
      if (signal?.aborted) {
        return {
          settlement: Promise.resolve(settledWithoutChild({ cancelled: true })),
          async cancel() {},
          async forceKill() {},
        }
      }
      const spawned = await spawnProcess(
        argv,
        cwd,
        environment,
        stdin,
        expectedExecutableSha256,
        expectedCanonicalCwd,
      )
      child = spawned.child
      windowsJob = spawned.windowsJob
    } catch (error) {
      return {
        settlement: Promise.resolve(
          settledWithoutChild({
            error: redactText(errorMessage(error), [
              ...(spec.secretValues ?? []),
              ...referencedSecrets,
            ]),
          }),
        ),
        async cancel() {},
        async forceKill() {},
      }
    }

    const secrets = [
      ...secretValuesFromEnvironment(spec.environment),
      ...referencedSecrets,
      ...(spec.secretValues ?? []),
    ].filter((value, index, values) => value.length >= 4 && values.indexOf(value) === index)
    let sequence = 0
    const callbacks: RuntimeCallbacks = {
      ...(onOutput ? { onOutput } : {}),
      ...(onChunk ? { onChunk } : {}),
    }
    const nextSequence = () => {
      sequence += 1
      return sequence
    }
    const stdoutCapture = new StreamCapture({
      stream: "stdout",
      summaryLimit: spec.outputLimitBytes,
      rawLimit: spec.rawOutputLimitBytes,
      secrets,
      callbacks,
      nextSequence,
    })
    const stderrCapture = new StreamCapture({
      stream: "stderr",
      summaryLimit: spec.outputLimitBytes,
      rawLimit: spec.rawOutputLimitBytes,
      secrets,
      callbacks,
      nextSequence,
    })
    const readStream = async (
      stream: ReadableStream<Uint8Array>,
      capture: StreamCapture,
    ): Promise<CaptureResult> => {
      const reader = stream.getReader()
      while (true) {
        const item = await reader.read()
        if (item.done) break
        await capture.consume(item.value)
      }
      return capture.finish()
    }

    let timedOut = false
    let cancelled = false
    let treeTerminated = false
    let cancellation: Promise<void> | undefined
    const terminateTree = async (force: boolean): Promise<boolean> => {
      if (process.platform === "win32") {
        if (force && windowsJob?.terminate()) return true
        if (child.exitCode !== null) return false
        const killed = await runTaskkill(child.pid, force)
        // Do not kill only the parent when the graceful tree request fails: it
        // would destroy the PID needed by the forced /T phase and could orphan
        // descendants. Parent-only kill is the final fallback after /T /F.
        if (force && !killed && child.exitCode === null) child.kill(9)
        return killed
      }
      try {
        process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM")
        return true
      } catch {
        if (child.exitCode === null) child.kill(force ? "SIGKILL" : "SIGTERM")
        return false
      }
    }
    const treeMayStillBeAlive = (): boolean => {
      if (process.platform === "win32") {
        try {
          return windowsJob?.hasProcessAccounting()
            ? windowsJob.activeProcessCount() > 0
            : child.exitCode === null
        } catch {
          // A query failure is not evidence that the tree is gone. Keep the
          // conservative answer so the forced termination path still runs.
          return true
        }
      }
      try {
        process.kill(-child.pid, 0)
        return true
      } catch {
        return false
      }
    }
    const requestCancellation = async (force: boolean): Promise<void> => {
      if (force) {
        treeTerminated = (await terminateTree(true)) || treeTerminated
        return
      }
      if (cancellation) return cancellation
      cancellation = (async () => {
        const treeWasAlive = treeMayStillBeAlive()
        treeTerminated = (await terminateTree(false)) || treeTerminated
        if (child.exitCode === null && spec.gracePeriodMs > 0) {
          await Promise.race([child.exited.then(() => undefined), delay(spec.gracePeriodMs)])
        }
        const treeStillAlive = treeMayStillBeAlive()
        if (treeWasAlive && !treeStillAlive) treeTerminated = true
        if (
          treeStillAlive ||
          (process.platform === "win32" &&
            windowsJob !== undefined &&
            !windowsJob.hasProcessAccounting())
        ) {
          treeTerminated = (await terminateTree(true)) || treeTerminated
        }
      })()
      await cancellation
    }
    const onAbort = () => {
      cancelled = true
      void requestCancellation(false)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    // AbortSignal does not replay an event to listeners registered after it
    // was aborted. Recheck after registration to close the prepare/spawn gap;
    // requestCancellation is idempotent if the event raced with this read.
    if (signal?.aborted) onAbort()
    const timeout = setTimeout(() => {
      timedOut = true
      void requestCancellation(false)
    }, spec.timeoutMs)

    const settlement = (async (): Promise<ProcessSettlement> => {
      let exitCode: number | undefined
      let stdout: CaptureResult
      let stderr: CaptureResult
      let executionError: string | undefined
      try {
        ;[exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          readStream(child.stdout, stdoutCapture),
          readStream(child.stderr, stderrCapture),
        ])
      } catch (error) {
        executionError = redactText(errorMessage(error), secrets)
        await requestCancellation(true)
        exitCode = await child.exited.catch(() => undefined)
        stdout = await stdoutCapture.finish()
        stderr = await stderrCapture.finish()
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", onAbort)
      }
      if (cancellation) await cancellation
      if (treeMayStillBeAlive()) {
        treeTerminated = (await terminateTree(true)) || treeTerminated
      }
      await windowsJob?.close()
      const outputRefs: string[] = []
      if (this.#outputStore) {
        try {
          if (stdout.raw || stdout.rawTruncated) {
            outputRefs.push(
              await this.#outputStore.persist({
                processId: String(child.pid),
                stream: "stdout",
                content: stdout.raw,
                truncated: stdout.rawTruncated,
              }),
            )
          }
          if (stderr.raw || stderr.rawTruncated) {
            outputRefs.push(
              await this.#outputStore.persist({
                processId: String(child.pid),
                stream: "stderr",
                content: stderr.raw,
                truncated: stderr.rawTruncated,
              }),
            )
          }
        } catch (error) {
          executionError ??= `Output persistence failed: ${redactText(errorMessage(error), secrets)}`
        }
      }
      return ProcessSettlementSchema.parse({
        pid: child.pid,
        argv,
        cwd,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(child.signalCode ? { signal: child.signalCode } : {}),
        stdout: stdout.summary,
        stderr: stderr.summary,
        rawStdout: stdout.raw,
        rawStderr: stderr.raw,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        outputTruncated: stdout.summaryTruncated || stderr.summaryTruncated,
        rawOutputTruncated: stdout.rawTruncated || stderr.rawTruncated,
        timedOut,
        cancelled,
        treeTerminated,
        outputRefs,
        durationMs: performance.now() - started,
        ...(executionError ? { error: executionError } : {}),
      })
    })()

    const handle: SupervisedProcessHandle = {
      pid: child.pid,
      settlement,
      async cancel() {
        cancelled = true
        await requestCancellation(false)
      },
      async forceKill() {
        cancelled = true
        await requestCancellation(true)
      },
    }
    const unregister = processShutdownRegistry.register(handle)
    void settlement.finally(unregister).catch(() => undefined)
    return handle
  }
}
