import { Writable } from "node:stream"
import { type CliRenderer, type CliRendererConfig, createCliRenderer } from "@opentui/core"
import type { TestRendererOptions, TestRendererSetup } from "@opentui/core/testing"
import { render, testRender } from "@opentui/solid"
import type { EvaluationFieldMetadata, RunUiSnapshot, RunUiSource } from "./contracts"
import { RunDashboard, type RunDashboardController, type RunDashboardProps } from "./dashboard"
import type { RalphTuiLocale } from "./i18n"
import type { ProviderPaletteController } from "./provider-palette"
import type { SettingsPaletteController } from "./settings-palette"
import { RALPH_TUI_THEME, type RalphTuiTheme } from "./theme"

export interface RenderRunDashboardOptions {
  readonly source: RunUiSource
  readonly evaluationFields?: readonly EvaluationFieldMetadata[]
  readonly onStop?: () => Promise<string | void>
  readonly onInterrupt?: () => void
  readonly ascii?: boolean
  readonly settings?: SettingsPaletteController<unknown, unknown>
  readonly providers?: ProviderPaletteController
  readonly onSettingsApply?: (result: unknown) => void
  readonly theme?: RalphTuiTheme
  readonly keybindings?: Readonly<Record<string, string>>
  readonly locale?: RalphTuiLocale
  readonly renderer?: CliRendererConfig
}

export interface RunDashboardHandle {
  readonly renderer: CliRenderer
  readonly destroy: () => void
  readonly closed: Promise<void>
}

// Giving OpenTUI a stream with a distinct identity selects NativeSpanFeed on
// Windows. The bridge forwards bytes without transferring ownership of the
// command process' stdout to the native renderer, which is essential when the
// same CLI continues after a pre-run TUI closes inside a ConPTY.
class WindowsTuiOutputBridge extends Writable {
  get columns(): number {
    return process.stdout.columns ?? 80
  }

  get rows(): number {
    return process.stdout.rows ?? 24
  }

  get isTTY(): boolean {
    return process.stdout.isTTY === true
  }

  getColorDepth(environment?: Record<string, string | undefined>): number {
    return process.stdout.getColorDepth?.(environment) ?? 1
  }

  hasColors(count?: number, environment?: Record<string, string | undefined>): boolean {
    if (!process.stdout.hasColors) return count === undefined || count <= 2
    return count === undefined
      ? process.stdout.hasColors()
      : process.stdout.hasColors(count, environment)
  }

  override _write(
    chunk: string | Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      if (typeof chunk === "string") process.stdout.write(chunk, encoding, callback)
      else process.stdout.write(chunk, callback)
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

export async function renderRunDashboard(
  options: RenderRunDashboardOptions,
): Promise<RunDashboardHandle> {
  const theme = options.theme ?? RALPH_TUI_THEME
  const outputBridge =
    process.platform === "win32" && options.renderer?.stdout === undefined
      ? new WindowsTuiOutputBridge()
      : undefined
  let removeResizeBridge: (() => void) | undefined
  let unsubscribe: (() => void) | undefined
  let unsubscribed = false
  const unsubscribeOnce = () => {
    if (unsubscribed) return
    unsubscribed = true
    unsubscribe?.()
  }
  let closedSettled = false
  let resolveClosed: (() => void) | undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const settleClosed = () => {
    if (closedSettled) return
    closedSettled = true
    removeResizeBridge?.()
    unsubscribeOnce()
    resolveClosed?.()
  }
  const configuredOnDestroy = options.renderer?.onDestroy
  const renderer = await createCliRenderer({
    backgroundColor: theme.background,
    ...options.renderer,
    ...(outputBridge
      ? {
          stdout: outputBridge as unknown as NonNullable<CliRendererConfig["stdout"]>,
          remote: true,
        }
      : {}),
    exitOnCtrlC: false,
    // OpenTUI emits DESTROY near the beginning of finalizeDestroy(), before it
    // restores stdout and releases its native renderer. Expose `closed` only
    // from the final callback so callers can safely continue using the
    // terminal after awaiting the dashboard lifecycle.
    onDestroy: () => {
      try {
        configuredOnDestroy?.()
      } finally {
        settleClosed()
      }
    },
  })
  if (outputBridge && !closedSettled) {
    const resize = () => {
      renderer.resize(
        process.stdout.columns ?? renderer.width,
        process.stdout.rows ?? renderer.height,
      )
    }
    process.on("SIGWINCH", resize)
    removeResizeBridge = () => {
      process.off("SIGWINCH", resize)
      removeResizeBridge = undefined
    }
  }
  let latestSnapshot = options.source.getSnapshot()
  let controller: RunDashboardController | undefined
  unsubscribe = options.source.subscribe((snapshot) => {
    latestSnapshot = snapshot
    controller?.updateSnapshot(snapshot)
  })
  let destroyRequested = false
  const destroy = () => {
    unsubscribeOnce()
    if (destroyRequested || renderer.isDestroyed) return
    destroyRequested = true
    // OpenTUI can receive a quit key while a Solid update is still rendering.
    // Stop scheduling frames and cross its public idle barrier before releasing
    // the native renderer/feed. This keeps the command's stdout usable for the
    // run that continues after a pre-run popup or a detached dashboard closes.
    renderer.stop()
    void renderer.idle().then(
      () => {
        if (!renderer.isDestroyed) renderer.destroy()
      },
      () => {
        if (!renderer.isDestroyed) renderer.destroy()
      },
    )
  }

  try {
    await render(
      () =>
        RunDashboard({
          snapshot: latestSnapshot,
          onQuit: destroy,
          ...(options.onInterrupt ? { onInterrupt: options.onInterrupt } : {}),
          controllerRef: (nextController) => {
            controller = nextController
            nextController.updateSnapshot(latestSnapshot)
          },
          ...(options.evaluationFields ? { evaluationFields: options.evaluationFields } : {}),
          ...(options.onStop ? { onStop: options.onStop } : {}),
          ...(options.ascii !== undefined ? { ascii: options.ascii } : {}),
          ...(options.settings ? { settings: options.settings } : {}),
          ...(options.providers ? { providers: options.providers } : {}),
          ...(options.onSettingsApply ? { onSettingsApply: options.onSettingsApply } : {}),
          theme,
          ...(options.locale ? { locale: options.locale } : {}),
          ...(options.keybindings ? { keybindings: options.keybindings } : {}),
        }),
      renderer,
    )
  } catch (error) {
    destroy()
    throw error
  }

  return { renderer, destroy, closed }
}

export async function testRenderRunDashboard(
  props: RunDashboardProps,
  options?: TestRendererOptions,
): Promise<TestRendererSetup> {
  return testRender(() => RunDashboard(props), options)
}

export function staticRunUiSource(snapshot: RunUiSnapshot): RunUiSource {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  }
}
