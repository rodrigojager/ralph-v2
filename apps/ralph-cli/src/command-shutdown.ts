import {
  type ProcessShutdownRegistry,
  TwoPhaseShutdownController,
  type TwoPhaseShutdownState,
} from "@ralph/supervisor"

export type CommandSignal = "SIGINT" | "SIGTERM"

export type CommandSignalSource = {
  on(signal: CommandSignal, listener: () => void): unknown
  off(signal: CommandSignal, listener: () => void): unknown
}

export type CommandShutdownLifecycleOptions = {
  signalSource?: CommandSignalSource
  registry?: ProcessShutdownRegistry
  forceExit?: (exitCode: number) => void
  forceExitCode?: number
  forceExitTimeoutMs?: number
  onStateChange?: (state: TwoPhaseShutdownState, reason: string) => void
}

export type CommandShutdownLifecycle = {
  readonly signal: AbortSignal
  readonly state: TwoPhaseShutdownState
  /** Shared by process signals (headless) and the TUI interrupt bridge. */
  interrupt(signal: CommandSignal): void
  /** Drains registered participants before detaching process signal listeners. */
  close(): Promise<void>
}

/**
 * Owns the complete command lifetime. The first interrupt aborts command-owned
 * scheduling and starts graceful participant cancellation; the second uses
 * the same controller to force every registered participant. Signal listeners
 * remain installed until the closing drain has actually settled.
 */
export function createCommandShutdownLifecycle(
  options: CommandShutdownLifecycleOptions = {},
): CommandShutdownLifecycle {
  const abortController = new AbortController()
  const controller = new TwoPhaseShutdownController({
    abortController,
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.forceExit ? { forceExit: options.forceExit } : {}),
    ...(options.forceExitCode !== undefined ? { forceExitCode: options.forceExitCode } : {}),
    ...(options.forceExitTimeoutMs !== undefined
      ? { forceExitTimeoutMs: options.forceExitTimeoutMs }
      : {}),
    ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
  })
  const signalSource = options.signalSource ?? process
  const interrupt = (signal: CommandSignal): void => controller.handleSignal(signal)
  const onSigint = (): void => interrupt("SIGINT")
  const onSigterm = (): void => interrupt("SIGTERM")
  signalSource.on("SIGINT", onSigint)
  signalSource.on("SIGTERM", onSigterm)
  let closePromise: Promise<void> | undefined

  return {
    signal: abortController.signal,
    get state() {
      return controller.state
    },
    interrupt,
    close() {
      closePromise ??= (async () => {
        try {
          await controller.close()
        } finally {
          signalSource.off("SIGINT", onSigint)
          signalSource.off("SIGTERM", onSigterm)
        }
      })()
      return closePromise
    },
  }
}
