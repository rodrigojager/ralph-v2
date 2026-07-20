import { afterEach, describe, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { once } from "node:events"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import {
  type WatchdogObservation,
  WatchdogObservationSchema,
  type WatchdogOperationalBudget,
  type WatchdogProfile,
  WatchdogProfileSchema,
  type WatchdogSignalName,
  type WatchdogSnapshot,
} from "@ralph-next/domain"
import {
  evaluateWatchdog,
  probePidLiveness,
  type WatchdogClock,
  WatchdogMonitor,
  type WatchdogProbeResult,
  type WatchdogScheduledTask,
  type WatchdogScheduler,
} from "@ralph-next/supervisor"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const WALL_CLOCK_EPOCH = Date.UTC(2026, 0, 1)
const ownedProcesses = new Set<ChildProcess>()
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all([...ownedProcesses].map(stopOwnedProcess))
  ownedProcesses.clear()
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

function spawnOwnedScript(source: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", source], {
    stdio: "ignore",
    windowsHide: true,
  })
  ownedProcesses.add(child)
  return child
}

async function stopOwnedProcess(child: ChildProcess): Promise<void> {
  ownedProcesses.delete(child)
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
}

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  description: string,
  timeoutMs = 3_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function profile(): WatchdogProfile {
  return WatchdogProfileSchema.parse({
    enabled: true,
    heartbeatIntervalMs: 10,
    heartbeatGraceMs: 40,
    quietAfterMs: 50,
    slowAfterMs: 100,
    suspectAfterMs: 200,
    hardTimeoutMs: 1_000,
    probeIntervalMs: 10,
    confirmations: 2,
    action: "restart-attempt",
    maxRestarts: 1,
    phases: {},
  })
}

function budget(watchdogRestarts = 0): WatchdogOperationalBudget {
  return { schemaVersion: 1, watchdogRestarts }
}

function observation(
  monotonicMs: number,
  overrides: Partial<WatchdogObservation> = {},
): WatchdogObservation {
  return WatchdogObservationSchema.parse({
    schemaVersion: 1,
    probeId: `probe-${monotonicMs}`,
    phase: "model-call",
    observedAt: new Date(WALL_CLOCK_EPOCH + monotonicMs).toISOString(),
    monotonicMs,
    phaseStartedMonotonicMs: 0,
    processAlive: "unknown",
    processActivity: "unknown",
    providerPending: "unknown",
    providerStreamOpen: "unknown",
    settlement: "running",
    ...overrides,
  })
}

function required<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Expected ${description}`)
  return value
}

function signal(snapshot: WatchdogSnapshot, name: WatchdogSignalName) {
  return required(
    snapshot.signals.find((candidate) => candidate.signal === name),
    `${name} signal`,
  )
}

class ControlledClock implements WatchdogClock {
  #now = 0

  set(monotonicMs: number): void {
    if (monotonicMs < this.#now) throw new Error("Controlled clock cannot move backwards")
    this.#now = monotonicMs
  }

  monotonicMs(): number {
    return this.#now
  }

  wallNow(): Date {
    return new Date(WALL_CLOCK_EPOCH + this.#now)
  }
}

type ScheduledProbe = {
  delayMs: number
  callback: () => void
  cancelled: boolean
}

class ControlledScheduler implements WatchdogScheduler {
  readonly delays: number[] = []
  readonly #scheduled: ScheduledProbe[] = []

  schedule(delayMs: number, callback: () => void): WatchdogScheduledTask {
    const probe = { delayMs, callback, cancelled: false }
    this.delays.push(delayMs)
    this.#scheduled.push(probe)
    return {
      cancel: () => {
        probe.cancelled = true
      },
    }
  }

  runNext(): boolean {
    const probe = this.#scheduled.find((candidate) => !candidate.cancelled)
    if (!probe) return false
    probe.cancelled = true
    probe.callback()
    return true
  }
}

async function runScheduledProbe(
  monitor: WatchdogMonitor,
  scheduler: ControlledScheduler,
  results: readonly WatchdogProbeResult[],
): Promise<WatchdogProbeResult> {
  if (!scheduler.runNext()) throw new Error("Expected a scheduled watchdog probe")
  await monitor.whenIdle()
  await Promise.resolve()
  return required(results.at(-1), "a watchdog probe result")
}

describe("S11 watchdog hardening", () => {
  test("quiet and slow phases with independent liveness never become stalled", async () => {
    const clock = new ControlledClock()
    const scheduler = new ControlledScheduler()
    const results: WatchdogProbeResult[] = []
    const actions: WatchdogProbeResult[] = []
    const monitor = new WatchdogMonitor({
      profile: profile(),
      phase: "tool",
      eventContext: {
        streamId: "watchdog-hardening",
        workspaceId: "workspace-fixture",
        runId: "run-quiet-slow",
      },
      clock,
      scheduler,
      onEvaluation: (result) => results.push(result),
      onAction: (result) => actions.push(result),
    })

    monitor.start()
    clock.set(1)
    monitor.recordControlHeartbeat()
    monitor.recordProgress()
    monitor.recordProcessAlive("yes")
    monitor.recordProcessActivity("yes")
    expect((await runScheduledProbe(monitor, scheduler, results)).evaluation.snapshot.state).toBe(
      "healthy",
    )

    clock.set(60)
    monitor.recordControlHeartbeat()
    monitor.recordProcessAlive("yes")
    monitor.recordProcessActivity("yes")
    expect((await runScheduledProbe(monitor, scheduler, results)).evaluation.snapshot.state).toBe(
      "quiet",
    )

    clock.set(120)
    monitor.recordControlHeartbeat()
    monitor.recordProcessAlive("yes")
    monitor.recordProcessActivity("yes")
    const slow = await runScheduledProbe(monitor, scheduler, results)
    expect(slow.evaluation.snapshot.state).toBe("slow")
    expect(slow.evaluation.snapshot.negativeQuorum).toBeFalse()
    expect(slow.evaluation.decision.action).toBe("none")

    clock.set(180)
    monitor.recordControlHeartbeat()
    monitor.recordProgress()
    monitor.recordProcessAlive("yes")
    const recovered = await runScheduledProbe(monitor, scheduler, results)
    expect(recovered.evaluation.snapshot.state).toBe("recovered")
    expect(recovered.evaluation.snapshot.reasons).toContain("recovered-signals")
    expect(actions).toHaveLength(0)
    expect(scheduler.delays).toContain(10)
    monitor.stop()
  })

  test("retry-after, an open stream, live process probes, and future deadlines protect a long call", async () => {
    const clock = new ControlledClock()
    const scheduler = new ControlledScheduler()
    const results: WatchdogProbeResult[] = []
    const actions: WatchdogProbeResult[] = []
    const monitor = new WatchdogMonitor({
      profile: profile(),
      phase: "model-call",
      eventContext: {
        streamId: "watchdog-hardening",
        workspaceId: "workspace-fixture",
        runId: "run-long-provider-call",
      },
      clock,
      scheduler,
      onEvaluation: (result) => results.push(result),
      onAction: (result) => actions.push(result),
    })

    monitor.start()
    clock.set(250)
    monitor.recordControlHeartbeat()
    monitor.recordProcessAlive("yes")
    monitor.recordProcessActivity("yes")
    monitor.recordProviderPending("no")
    monitor.recordProviderStream("yes")
    monitor.recordProviderRetryAfter(500)
    monitor.setDeadlinesAfter({ phaseTimeoutMs: 600, hardTimeoutMs: 900 })

    const first = await runScheduledProbe(monitor, scheduler, results)
    expect(first.evaluation.snapshot.state).toBe("slow")
    expect(first.evaluation.snapshot.negativeQuorum).toBeFalse()
    expect(signal(first.evaluation.snapshot, "provider")).toMatchObject({
      verdict: "positive",
      reason: "provider-retry-after",
    })
    expect(signal(first.evaluation.snapshot, "deadline")).toMatchObject({
      verdict: "positive",
      reason: "deadline-within-limit",
    })

    clock.set(500)
    monitor.recordControlHeartbeat()
    monitor.recordProcessAlive("yes")
    monitor.recordProcessActivity("yes")
    const second = await runScheduledProbe(monitor, scheduler, results)
    expect(second.evaluation.snapshot.state).toBe("slow")
    expect(second.evaluation.snapshot.negativeQuorum).toBeFalse()
    expect(second.evaluation.decision.action).toBe("none")
    expect(actions).toHaveLength(0)
    monitor.stop()
  })

  test("silent streaming heartbeats and long reasoning remain slow but never stalled", async () => {
    for (const scenario of [
      {
        name: "silent-stream-heartbeat",
        phase: "model-call" as const,
        stream: "yes" as const,
        expectedStreamVerdict: "positive" as const,
      },
      {
        name: "long-reasoning",
        phase: "judge" as const,
        stream: "no" as const,
        expectedStreamVerdict: "unknown" as const,
      },
    ]) {
      const clock = new ControlledClock()
      const scheduler = new ControlledScheduler()
      const results: WatchdogProbeResult[] = []
      const actions: WatchdogProbeResult[] = []
      const monitor = new WatchdogMonitor({
        profile: profile(),
        phase: scenario.phase,
        eventContext: {
          streamId: "watchdog-false-positive-matrix",
          workspaceId: "workspace-fixture",
          runId: `run-${scenario.name}`,
        },
        clock,
        scheduler,
        onEvaluation: (result) => results.push(result),
        onAction: (result) => actions.push(result),
      })

      monitor.start()
      clock.set(250)
      monitor.recordControlHeartbeat()
      monitor.recordProcessAlive("yes")
      monitor.recordProcessActivity("no")
      monitor.recordProviderPending("yes")
      monitor.recordProviderStream(scenario.stream)
      monitor.setDeadlines({ phaseDeadlineMonotonicMs: 900 })

      const result = await runScheduledProbe(monitor, scheduler, results)
      expect(result.evaluation.snapshot.state).toBe("slow")
      expect(result.evaluation.snapshot.progressSilenceMs).toBe(250)
      expect(result.evaluation.snapshot.negativeQuorum).toBeFalse()
      expect(result.evaluation.snapshot.negativeConfirmations).toBe(0)
      expect(result.evaluation.decision.action).toBe("none")
      expect(signal(result.evaluation.snapshot, "control-heartbeat").verdict).toBe("positive")
      expect(signal(result.evaluation.snapshot, "provider")).toMatchObject({
        verdict: "positive",
        reason: "provider-pending",
      })
      expect(signal(result.evaluation.snapshot, "provider-stream").verdict).toBe(
        scenario.expectedStreamVerdict,
      )
      expect(actions).toEqual([])
      monitor.stop()
    }
  })

  test("a real CPU and IO build stays protected by live process probes", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    const activityPath = resolve(root, "build-activity.log")
    const child = spawnOwnedScript(`
      const { appendFileSync } = require("node:fs");
      const target = ${JSON.stringify(activityPath)};
      let tick = 0;
      setInterval(() => {
        let checksum = 0;
        for (let index = 0; index < 100000; index += 1) checksum = (checksum + index) % 2147483647;
        appendFileSync(target, String(tick++) + ":" + String(checksum) + "\\n");
      }, 10);
    `)
    const pid = child.pid
    if (!pid) throw new Error("Real build fixture did not receive a PID")
    await waitFor(
      () => (probePidLiveness(pid).alive ? true : undefined),
      "real build process liveness",
    )
    const firstSize = await waitFor(async () => {
      try {
        const current = await stat(activityPath)
        return current.size > 0 ? current.size : undefined
      } catch {
        return undefined
      }
    }, "initial build IO")
    await waitFor(async () => {
      const current = await stat(activityPath)
      return current.size > firstSize ? current.size : undefined
    }, "continued build IO")

    const clock = new ControlledClock()
    const scheduler = new ControlledScheduler()
    const results: WatchdogProbeResult[] = []
    const actions: WatchdogProbeResult[] = []
    const monitor = new WatchdogMonitor({
      profile: profile(),
      phase: "gate",
      eventContext: {
        streamId: "watchdog-false-positive-matrix",
        workspaceId: "workspace-fixture",
        runId: "run-real-cpu-io-build",
      },
      clock,
      scheduler,
      onEvaluation: (result) => results.push(result),
      onAction: (result) => actions.push(result),
    })

    monitor.start()
    clock.set(250)
    monitor.recordControlHeartbeat()
    monitor.recordProcessAlive(probePidLiveness(pid).alive ? "yes" : "no")
    monitor.recordProcessActivity("yes")
    monitor.setDeadlines({ phaseDeadlineMonotonicMs: 900 })
    const result = await runScheduledProbe(monitor, scheduler, results)

    expect(result.evaluation.snapshot.state).toBe("slow")
    expect(result.evaluation.snapshot.negativeQuorum).toBeFalse()
    expect(result.evaluation.snapshot.negativeConfirmations).toBe(0)
    expect(result.evaluation.decision.action).toBe("none")
    expect(signal(result.evaluation.snapshot, "process")).toMatchObject({
      verdict: "positive",
      reason: "process-alive",
    })
    expect(signal(result.evaluation.snapshot, "process-activity")).toMatchObject({
      verdict: "positive",
      reason: "process-active",
    })
    expect(actions).toEqual([])
    expect(probePidLiveness(pid).alive).toBeTrue()
    monitor.stop()
    await stopOwnedProcess(child)
  })

  test("a real frozen worker stalls only after independent confirmations", async () => {
    const child = spawnOwnedScript("setInterval(() => undefined, 1000)")
    const pid = child.pid
    if (!pid) throw new Error("Frozen worker fixture did not receive a PID")
    await waitFor(() => (probePidLiveness(pid).alive ? true : undefined), "frozen worker liveness")

    const clock = new ControlledClock()
    const scheduler = new ControlledScheduler()
    const results: WatchdogProbeResult[] = []
    const actions: WatchdogProbeResult[] = []
    const monitor = new WatchdogMonitor({
      profile: profile(),
      phase: "child",
      eventContext: {
        streamId: "watchdog-false-positive-matrix",
        workspaceId: "workspace-fixture",
        runId: "run-real-frozen-worker",
      },
      clock,
      scheduler,
      onEvaluation: (result) => results.push(result),
      onAction: (result) => actions.push(result),
    })

    monitor.start()
    clock.set(250)
    monitor.recordProcessAlive(probePidLiveness(pid).alive ? "yes" : "no")
    monitor.recordProcessActivity("no")
    const suspect = await runScheduledProbe(monitor, scheduler, results)
    expect(suspect.evaluation.snapshot.state).toBe("suspect")
    expect(suspect.evaluation.snapshot.negativeQuorum).toBeTrue()
    expect(suspect.evaluation.snapshot.negativeConfirmations).toBe(1)
    expect(suspect.evaluation.decision.action).toBe("notify")
    expect(probePidLiveness(pid).alive).toBeTrue()

    clock.set(260)
    monitor.recordProcessAlive(probePidLiveness(pid).alive ? "yes" : "no")
    monitor.recordProcessActivity("no")
    const stalled = await runScheduledProbe(monitor, scheduler, results)
    expect(stalled.evaluation.snapshot.state).toBe("stalled")
    expect(stalled.evaluation.snapshot.negativeConfirmations).toBe(2)
    expect(stalled.evaluation.decision).toMatchObject({
      action: "restart-attempt",
      cause: "stalled",
      gracefulCancelFirst: true,
      forceKillAfterGrace: true,
      preserveTask: true,
      preserveDiff: true,
      resumable: true,
    })
    expect(signal(stalled.evaluation.snapshot, "control-heartbeat").verdict).toBe("negative")
    expect(signal(stalled.evaluation.snapshot, "child-heartbeat").verdict).toBe("negative")
    expect(signal(stalled.evaluation.snapshot, "progress").verdict).toBe("negative")
    expect(signal(stalled.evaluation.snapshot, "process").verdict).toBe("positive")
    expect(actions.map((result) => result.evaluation.decision.action)).toEqual([
      "notify",
      "restart-attempt",
    ])
    expect(probePidLiveness(pid).alive).toBeTrue()
    monitor.stop()
    await stopOwnedProcess(child)
  })

  test("hard timeout stays absolute but starts recovery only after configured confirmations", async () => {
    const clock = new ControlledClock()
    const scheduler = new ControlledScheduler()
    const results: WatchdogProbeResult[] = []
    const actions: WatchdogProbeResult[] = []
    const monitor = new WatchdogMonitor({
      profile: profile(),
      phase: "model-call",
      eventContext: {
        streamId: "watchdog-hard-timeout-matrix",
        workspaceId: "workspace-fixture",
        runId: "run-confirmed-hard-timeout",
      },
      clock,
      scheduler,
      onEvaluation: (result) => results.push(result),
      onAction: (result) => actions.push(result),
    })

    monitor.start()
    clock.set(999)
    monitor.recordControlHeartbeat()
    monitor.recordProgress()
    monitor.recordProcessAlive("yes")
    monitor.recordProcessActivity("yes")
    monitor.recordProviderPending("yes")
    monitor.recordProviderStream("yes")
    const withinLimit = await runScheduledProbe(monitor, scheduler, results)
    expect(withinLimit.evaluation.snapshot.hardTimeoutExceeded).toBeFalse()
    expect(withinLimit.evaluation.snapshot.state).toBe("healthy")
    expect(withinLimit.evaluation.decision.action).toBe("none")

    clock.set(1_000)
    monitor.recordControlHeartbeat()
    monitor.recordProgress()
    monitor.recordProcessAlive("yes")
    monitor.recordProcessActivity("yes")
    monitor.recordProviderPending("yes")
    monitor.recordProviderStream("yes")
    const firstExceeded = await runScheduledProbe(monitor, scheduler, results)
    expect(firstExceeded.evaluation.snapshot).toMatchObject({
      state: "suspect",
      hardTimeoutExceeded: true,
      negativeConfirmations: 1,
      negativeQuorum: false,
    })
    expect(signal(firstExceeded.evaluation.snapshot, "deadline")).toMatchObject({
      verdict: "negative",
      reason: "hard-timeout-exceeded",
    })
    expect(firstExceeded.evaluation.decision).toMatchObject({
      action: "notify",
      cause: "suspect",
      watchdogRestartDelta: 0,
    })

    clock.set(1_010)
    monitor.recordControlHeartbeat()
    monitor.recordProgress()
    monitor.recordProcessAlive("yes")
    monitor.recordProcessActivity("yes")
    monitor.recordProviderPending("yes")
    monitor.recordProviderStream("yes")
    const confirmed = await runScheduledProbe(monitor, scheduler, results)
    expect(confirmed.evaluation.snapshot).toMatchObject({
      state: "stalled",
      hardTimeoutExceeded: true,
      negativeConfirmations: 2,
      negativeQuorum: false,
    })
    expect(confirmed.evaluation.decision).toMatchObject({
      action: "restart-attempt",
      cause: "hard-timeout",
      gracefulCancelFirst: true,
      forceKillAfterGrace: true,
      preserveTask: true,
      preserveDiff: true,
      resumable: true,
      watchdogRestartDelta: 1,
    })
    expect(actions.map((result) => result.evaluation.decision.action)).toEqual([
      "notify",
      "restart-attempt",
    ])
    monitor.stop()
  })

  test("negative quorum requires confirmations before one bounded restart reservation", () => {
    const watchdogProfile = profile()
    const first = evaluateWatchdog({
      profile: watchdogProfile,
      observation: observation(250, {
        processAlive: "no",
        processActivity: "no",
        providerPending: "no",
        providerStreamOpen: "no",
        phaseDeadlineMonotonicMs: 900,
      }),
      budget: budget(),
    })

    expect(first.snapshot.state).toBe("suspect")
    expect(first.snapshot.negativeQuorum).toBeTrue()
    expect(first.snapshot.negativeConfirmations).toBe(1)
    expect(first.decision).toMatchObject({
      action: "notify",
      cause: "suspect",
      requestProtocolPing: true,
      watchdogRestartDelta: 0,
    })

    const confirmed = evaluateWatchdog({
      profile: watchdogProfile,
      observation: observation(260, {
        processAlive: "no",
        processActivity: "no",
        providerPending: "no",
        providerStreamOpen: "no",
        phaseDeadlineMonotonicMs: 900,
      }),
      budget: first.nextBudget,
      previousSnapshot: first.snapshot,
    })

    expect(confirmed.snapshot.state).toBe("stalled")
    expect(confirmed.snapshot.negativeConfirmations).toBe(2)
    expect(confirmed.decision).toMatchObject({
      action: "restart-attempt",
      cause: "stalled",
      gracefulCancelFirst: true,
      forceKillAfterGrace: true,
      preserveTask: true,
      preserveDiff: true,
      resumable: true,
      consumesJudgeRevision: false,
      watchdogRestartDelta: 1,
      budgetBefore: { used: 0, remaining: 1, exhausted: false },
      budgetAfter: { used: 1, remaining: 0, exhausted: true },
    })
    expect(confirmed.nextBudget.watchdogRestarts).toBe(1)

    const repeated = evaluateWatchdog({
      profile: watchdogProfile,
      observation: observation(270, {
        processAlive: "no",
        processActivity: "no",
        providerPending: "no",
        providerStreamOpen: "no",
        phaseDeadlineMonotonicMs: 900,
      }),
      budget: confirmed.nextBudget,
      previousSnapshot: confirmed.snapshot,
    })
    expect(repeated.snapshot.state).toBe("stalled")
    expect(repeated.decision.action).toBe("none")
    expect(repeated.decision.watchdogRestartDelta).toBe(0)
    expect(repeated.nextBudget.watchdogRestarts).toBe(1)
  })

  test("a fresh attempt stops resumably when the durable restart budget is exhausted", () => {
    const watchdogProfile = profile()
    const suspect = evaluateWatchdog({
      profile: watchdogProfile,
      observation: observation(550, {
        phaseStartedMonotonicMs: 300,
        processAlive: "no",
        providerPending: "no",
      }),
      budget: budget(1),
    })
    const exhausted = evaluateWatchdog({
      profile: watchdogProfile,
      observation: observation(560, {
        phaseStartedMonotonicMs: 300,
        processAlive: "no",
        providerPending: "no",
      }),
      budget: suspect.nextBudget,
      previousSnapshot: suspect.snapshot,
    })

    expect(suspect.snapshot.state).toBe("suspect")
    expect(exhausted.snapshot.state).toBe("stalled")
    expect(exhausted.decision).toMatchObject({
      action: "stop-run",
      cause: "restart-budget-exhausted",
      gracefulCancelFirst: true,
      forceKillAfterGrace: true,
      preserveTask: true,
      preserveDiff: true,
      resumable: true,
      watchdogRestartDelta: 0,
      budgetBefore: { used: 1, remaining: 0, exhausted: true },
      budgetAfter: { used: 1, remaining: 0, exhausted: true },
    })
    expect(exhausted.decision.reasons).toContain("restart-budget-exhausted")
    expect(exhausted.nextBudget.watchdogRestarts).toBe(1)
    expect(exhausted.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "WATCHDOG_RESTART_BUDGET_EXHAUSTED",
    )
  })
})
