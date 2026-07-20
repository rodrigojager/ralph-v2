import { describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import {
  BunProcessSupervisor,
  ProcessShutdownRegistry,
  spawnTypedWorker,
  workerExecutableContentHash,
} from "@ralph-next/supervisor"
import {
  type CommandSignal,
  type CommandSignalSource,
  createCommandShutdownLifecycle,
} from "../../apps/ralph-cli/src/command-shutdown"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const REPOSITORY_ROOT = realpathSync.native(resolve(import.meta.dir, "../.."))
const WORKER_ENTRYPOINT = realpathSync.native(
  resolve(REPOSITORY_ROOT, "tests/fixtures/worker/s07-role-worker.ts"),
)

class ControlledSignalSource implements CommandSignalSource {
  readonly #listeners = new Map<CommandSignal, Set<() => void>>()

  on(signal: CommandSignal, listener: () => void): void {
    const listeners = this.#listeners.get(signal) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(signal, listeners)
  }

  off(signal: CommandSignal, listener: () => void): void {
    this.#listeners.get(signal)?.delete(listener)
  }

  emit(signal: CommandSignal): void {
    for (const listener of this.#listeners.get(signal) ?? []) listener()
  }

  get activeListeners(): number {
    return [...this.#listeners.values()].reduce((total, listeners) => total + listeners.size, 0)
  }
}

function workerEnvironment(): Record<string, string> {
  const names = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP"]
  return Object.fromEntries(
    names.flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name] as string]],
    ),
  )
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("S07.10 two-phase command shutdown", () => {
  test("headless first signal stops admission and TUI second signal force-closes the same participants", async () => {
    const signals = new ControlledSignalSource()
    const registry = new ProcessShutdownRegistry()
    const calls: string[] = []
    const states: string[] = []
    const exitCodes: number[] = []
    let releaseGraceful: (() => void) | undefined
    const gracefulSettlement = new Promise<void>((resolveGraceful) => {
      releaseGraceful = resolveGraceful
    })
    let unregister = (): void => undefined
    unregister = registry.register({
      async cancel(reason) {
        calls.push(`cancel:${reason}`)
        await gracefulSettlement
      },
      async forceKill(reason) {
        calls.push(`force:${reason}`)
        unregister()
        releaseGraceful?.()
      },
    })
    const lifecycle = createCommandShutdownLifecycle({
      signalSource: signals,
      registry,
      forceExit: (exitCode) => exitCodes.push(exitCode),
      forceExitTimeoutMs: 1_000,
      onStateChange: (state, reason) => states.push(`${state}:${reason}`),
    })
    let admitted = 0
    const schedule = (): void => {
      if (!lifecycle.signal.aborted) admitted += 1
    }

    schedule()
    signals.emit("SIGINT")
    schedule()
    expect(lifecycle).toMatchObject({ state: "graceful" })
    expect(lifecycle.signal.aborted).toBeTrue()
    expect(admitted).toBe(1)
    expect(calls).toEqual(["cancel:Received SIGINT"])

    let closeSettled = false
    const closing = lifecycle.close().then(() => {
      closeSettled = true
    })
    await Promise.resolve()
    expect(closeSettled).toBeFalse()
    expect(signals.activeListeners).toBe(2)

    // The TUI bridge invokes the same interrupt contract while headless
    // listeners remain installed throughout graceful closing.
    lifecycle.interrupt("SIGINT")
    await closing
    expect(calls).toEqual(["cancel:Received SIGINT", "force:Received SIGINT"])
    expect(exitCodes).toEqual([130])
    expect(states).toEqual([
      "graceful:Received SIGINT",
      "forced:Received SIGINT",
      "closed:Command settlement completed",
    ])
    expect(lifecycle.state).toBe("closed")
    expect(registry.activeCount).toBe(0)
    expect(signals.activeListeners).toBe(0)
  })

  test("first signal drains a real subprocess and typed worker before CLI closing returns", async () => {
    const workspaceRoot = await createTestDirectory()
    const signals = new ControlledSignalSource()
    const registry = new ProcessShutdownRegistry()
    const states: string[] = []
    const exitCodes: number[] = []
    const lifecycle = createCommandShutdownLifecycle({
      signalSource: signals,
      registry,
      forceExit: (exitCode) => exitCodes.push(exitCode),
      onStateChange: (state) => states.push(state),
    })
    const bun = Bun.which("bun")
    if (!bun) throw new Error("Bun is required by the focused S07.10 shutdown matrix")
    const processHandle = await new BunProcessSupervisor().start({
      executable: bun,
      args: ["-e", "setInterval(() => undefined, 1_000)"],
      cwd: REPOSITORY_ROOT,
      environment: workerEnvironment(),
      shell: false,
      timeoutMs: 30_000,
      gracePeriodMs: 500,
      outputLimitBytes: 4_096,
      rawOutputLimitBytes: 4_096,
    })
    const processPid = processHandle.pid
    if (!processPid) throw new Error("The supervised S07.10 subprocess has no PID")
    const executable = realpathSync.native(process.execPath)
    const workerStates: string[] = []
    const worker = await spawnTypedWorker(
      {
        workerId: "s07-two-phase-worker",
        workspaceId: "workspace-s07-two-phase",
        workspaceRoot,
        runId: "run-s07-two-phase",
        attemptId: "attempt-s07-two-phase",
        role: "executor-model",
        executable,
        executableHash: workerExecutableContentHash(executable),
        launch: {
          kind: "bundled-runtime-entrypoint",
          path: WORKER_ENTRYPOINT,
          contentHash: workerExecutableContentHash(WORKER_ENTRYPOINT),
        },
        args: [],
        cwd: REPOSITORY_ROOT,
        environment: workerEnvironment(),
        capabilities: [
          {
            action: "model.execute",
            pathScopes: [workspaceRoot],
            commandScopes: [],
          },
        ],
        heartbeatIntervalMs: 100,
        startupTimeoutMs: 10_000,
        shutdownGraceMs: 5_000,
        requestCancellationGraceMs: 1_000,
        forceCleanupGraceMs: 1_000,
      },
      {
        onState: (snapshot) => {
          workerStates.push(snapshot.state)
        },
      },
    )
    const unregisterProcess = registry.register(processHandle)
    const unregisterWorker = registry.register({
      cancel: (reason) => worker.shutdown(reason ?? "Command graceful shutdown", 5_000),
      forceKill: (reason) => worker.forceKill(reason ?? "Command forced shutdown"),
    })
    void processHandle.settlement.finally(unregisterProcess).catch(() => undefined)
    void worker.settlement.finally(unregisterWorker).catch(() => undefined)

    try {
      await worker.ready
      expect(processIsAlive(processPid)).toBeTrue()
      let admissions = 0
      const schedule = (): void => {
        if (!lifecycle.signal.aborted) admissions += 1
      }
      schedule()
      signals.emit("SIGINT")
      schedule()
      await lifecycle.close()

      const [processSettlement, workerSettlement] = await Promise.all([
        processHandle.settlement,
        worker.settlement,
      ])
      expect(admissions).toBe(1)
      expect(processSettlement).toMatchObject({ cancelled: true, timedOut: false })
      expect(processIsAlive(processPid)).toBeFalse()
      expect(workerSettlement).toMatchObject({ exitCode: 0, snapshot: { state: "exited" } })
      expect(workerStates).toEqual(expect.arrayContaining(["ready", "closing", "exited"]))
      expect(registry.activeCount).toBe(0)
      expect(states).toEqual(["graceful", "closed"])
      expect(exitCodes).toEqual([])
      expect(signals.activeListeners).toBe(0)
    } finally {
      await processHandle.forceKill("S07.10 focused cleanup").catch(() => undefined)
      await worker.forceKill("S07.10 focused cleanup").catch(() => undefined)
      await Promise.all([
        processHandle.settlement.catch(() => undefined),
        worker.settlement.catch(() => undefined),
      ])
      unregisterProcess()
      unregisterWorker()
      await lifecycle.close().catch(() => undefined)
      await removeTestDirectory(workspaceRoot)
    }
  }, 30_000)
})
