import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunProcessSupervisor } from "../src"

const processTreeFixture = resolve(import.meta.dir, "fixtures", "process-tree.ts")

// Windows ARM64 uses the native PowerShell/.NET Job Object controller when
// Bun's experimental FFI backend is unavailable. Starting that controller is
// still bounded by production deadlines, but can exceed Bun's five-second
// default on a cold hosted runner.
setDefaultTimeout(30_000)

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  description: string,
): Promise<T> {
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function recordedPid(stateDirectory: string, role: string): Promise<number> {
  return waitFor(async () => {
    try {
      const value = Number.parseInt(await readFile(join(stateDirectory, `${role}.pid`), "utf8"), 10)
      return Number.isSafeInteger(value) && value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }, `${role} pid`)
}

async function waitUntilGone(pid: number, role: string): Promise<void> {
  await waitFor(() => (processIsAlive(pid) ? undefined : true), `${role} process ${pid} to exit`)
}

function treeRequest(
  stateDirectory: string,
  timeoutMs: number,
  parentMode: "parent-exit" | "parent-hold" = "parent-hold",
) {
  const bun = Bun.which("bun")
  if (!bun) throw new Error("Bun executable is unavailable")
  return {
    executable: bun,
    args: [processTreeFixture, parentMode, stateDirectory],
    cwd: process.cwd(),
    environment: {
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      SystemDrive: process.env.SystemDrive,
    },
    shell: false as const,
    timeoutMs,
    gracePeriodMs: 50,
    outputLimitBytes: 16_384,
    rawOutputLimitBytes: 16_384,
  }
}

describe("BunProcessSupervisor", () => {
  test("delivers stdin, passes only allowlisted/ref env, redacts, and preserves argv literally", async () => {
    const bun = Bun.which("bun")
    if (!bun) throw new Error("Bun executable is unavailable")
    const streamed: string[] = []
    const argument = "; echo NOT_A_SECOND_COMMAND"
    const settlement = await new BunProcessSupervisor().run({
      executable: bun,
      args: [
        "-e",
        `const input = await new Response(Bun.stdin.stream()).text();
         process.stdout.write([input, process.env.EXPOSED_COPY, process.env.HIDDEN, process.env.TOKEN, process.argv[1]].join("|"))`,
        argument,
      ],
      cwd: process.cwd(),
      environment: {
        PATH: process.env.PATH,
        EXPOSED: "available",
        HIDDEN: "must-not-pass",
        SECRET_TOKEN: "super-secret-token",
        "ProgramFiles(x86)": "windows-host-value-must-not-pass",
      },
      environmentRefs: {
        EXPOSED_COPY: "env:EXPOSED",
        TOKEN: "env:SECRET_TOKEN",
      },
      stdin: "hello\nworld",
      shell: false,
      timeoutMs: 5_000,
      outputLimitBytes: 16_384,
      rawOutputLimitBytes: 16_384,
      onOutput(_stream, delta) {
        streamed.push(delta)
      },
    })
    expect(settlement.exitCode).toBe(0)
    expect(settlement.stdout).toContain("hello\nworld|[REDACTED]||[REDACTED]")
    expect(settlement.stdout).not.toContain("must-not-pass")
    expect(settlement.stdout).not.toContain("windows-host-value-must-not-pass")
    expect(settlement.stdout).toContain(argument)
    expect(settlement.stdout).not.toContain("super-secret-token")
    expect(streamed.join("")).not.toContain("super-secret-token")
  })

  test("caps retained and incremental output while recording real byte counts", async () => {
    const bun = Bun.which("bun")
    if (!bun) throw new Error("Bun executable is unavailable")
    let streamed = ""
    const settlement = await new BunProcessSupervisor().run({
      executable: bun,
      args: ["-e", `process.stdout.write("x".repeat(4096))`],
      cwd: process.cwd(),
      environment: { PATH: process.env.PATH },
      shell: false,
      timeoutMs: 5_000,
      outputLimitBytes: 128,
      rawOutputLimitBytes: 256,
      onOutput(_stream, delta) {
        streamed += delta
      },
    })
    expect(settlement.stdoutBytes).toBe(4096)
    expect(Buffer.byteLength(settlement.stdout)).toBeLessThanOrEqual(128)
    expect(Buffer.byteLength(settlement.rawStdout)).toBeLessThanOrEqual(256)
    expect(Buffer.byteLength(streamed)).toBeLessThanOrEqual(128)
    expect(settlement.outputTruncated).toBe(true)
    expect(settlement.rawOutputTruncated).toBe(true)
  })

  test("cancel terminates parent and grandchild after the intermediate child has exited", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ralph-supervisor-cancel-"))
    const handle = await new BunProcessSupervisor().start(treeRequest(stateDirectory, 10_000))
    try {
      const parentPid = await recordedPid(stateDirectory, "parent")
      const childPid = await recordedPid(stateDirectory, "child")
      const grandchildPid = await recordedPid(stateDirectory, "grandchild")
      await waitUntilGone(childPid, "child")
      expect(processIsAlive(parentPid)).toBe(true)
      expect(processIsAlive(grandchildPid)).toBe(true)

      await handle.cancel("focused process-tree cancellation test")
      const settlement = await handle.settlement

      expect(settlement.cancelled).toBe(true)
      expect(settlement.timedOut).toBe(false)
      expect(settlement.treeTerminated).toBe(true)
      await waitUntilGone(parentPid, "parent")
      await waitUntilGone(grandchildPid, "grandchild")
    } finally {
      await handle.forceKill("focused process-tree cancellation cleanup")
      await handle.settlement.catch(() => undefined)
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test("an AbortSignal terminates the supervised external process tree", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ralph-supervisor-signal-"))
    const controller = new AbortController()
    const handle = await new BunProcessSupervisor().start({
      ...treeRequest(stateDirectory, 10_000),
      signal: controller.signal,
    })
    try {
      const parentPid = await recordedPid(stateDirectory, "parent")
      const childPid = await recordedPid(stateDirectory, "child")
      const grandchildPid = await recordedPid(stateDirectory, "grandchild")
      await waitUntilGone(childPid, "child")
      expect(processIsAlive(parentPid)).toBe(true)
      expect(processIsAlive(grandchildPid)).toBe(true)

      controller.abort(new Error("command-owned Ctrl+C"))
      const settlement = await handle.settlement

      expect(settlement.cancelled).toBe(true)
      expect(settlement.timedOut).toBe(false)
      expect(settlement.treeTerminated).toBe(true)
      await waitUntilGone(parentPid, "parent")
      await waitUntilGone(grandchildPid, "grandchild")
    } finally {
      await handle.forceKill("focused AbortSignal process-tree cleanup")
      await handle.settlement.catch(() => undefined)
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test("timeout terminates the entire parent-child-grandchild tree", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ralph-supervisor-timeout-"))
    const handle = await new BunProcessSupervisor().start(treeRequest(stateDirectory, 2_000))
    try {
      const parentPid = await recordedPid(stateDirectory, "parent")
      const childPid = await recordedPid(stateDirectory, "child")
      const grandchildPid = await recordedPid(stateDirectory, "grandchild")
      await waitUntilGone(childPid, "child")
      expect(processIsAlive(parentPid)).toBe(true)
      expect(processIsAlive(grandchildPid)).toBe(true)

      const settlement = await handle.settlement

      expect(settlement.cancelled).toBe(false)
      expect(settlement.timedOut).toBe(true)
      expect(settlement.treeTerminated).toBe(true)
      await waitUntilGone(parentPid, "parent")
      await waitUntilGone(grandchildPid, "grandchild")
    } finally {
      await handle.forceKill("focused process-tree timeout cleanup")
      await handle.settlement.catch(() => undefined)
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test("cancel still reaches a grandchild after the original parent has exited", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ralph-supervisor-parent-exit-"))
    const handle = await new BunProcessSupervisor().start(
      treeRequest(stateDirectory, 10_000, "parent-exit"),
    )
    try {
      const parentPid = await recordedPid(stateDirectory, "parent")
      const childPid = await recordedPid(stateDirectory, "child")
      const grandchildPid = await recordedPid(stateDirectory, "grandchild")
      await waitUntilGone(parentPid, "parent")
      await waitUntilGone(childPid, "child")
      expect(processIsAlive(grandchildPid)).toBe(true)

      await handle.cancel("focused cancellation after original parent exit")
      const settlement = await handle.settlement

      expect(settlement.cancelled).toBe(true)
      expect(settlement.timedOut).toBe(false)
      expect(settlement.treeTerminated).toBe(true)
      await waitUntilGone(grandchildPid, "grandchild")
    } finally {
      await handle.forceKill("focused parent-exit cleanup")
      await handle.settlement.catch(() => undefined)
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })
})
