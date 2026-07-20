import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { cp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { executeCli } from "@ralph-next/commands"
import {
  executeRun,
  type RunOptionOverrides,
  resolveEffectiveRunOptions,
} from "@ralph-next/orchestration"
import { initializeWorkspace } from "@ralph-next/persistence"
import { compilePrdGraph } from "@ralph-next/prd"
import { ScriptedExecutionBackend } from "@ralph-next/test-kit"
import { buildRunUiSnapshot } from "../../apps/ralph-cli/src/tui-services"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const ROOT = resolve(import.meta.dir, "../..")
const STREAM_FIXTURE = resolve(ROOT, "packages/tui/tests/fixtures/pty-dashboard.ts")
const LIFECYCLE_FIXTURE = resolve(ROOT, "packages/tui/tests/fixtures/pty-lifecycle.ts")
const PRE_RUN_FIXTURE = resolve(ROOT, "tests/fixtures/pty/pre-run-settings.ts")
const PERSISTED_FIXTURE = resolve(ROOT, "tests/fixtures/pty/persisted-attach-replay.ts")
const POSIX_RESIZE_FIXTURE = resolve(ROOT, "tests/fixtures/pty/posix-resize.ts")
// ConPTY can emit many complete-screen redraws per second. Keep a small rolling
// transcript and trim in coarse batches: slicing an 8 MiB string on every PTY
// chunk made the Bun runner spend minutes copying text after a failed wait.
const OUTPUT_RETAINED_CHARACTERS = 512 * 1024
const OUTPUT_TRIM_THRESHOLD = OUTPUT_RETAINED_CHARACTERS * 2
// Hosted Windows runners can spend several seconds scheduling ConPTY redraws
// while the full native matrix is active. Keep each observable transition
// bounded, but leave enough room for a real renderer response before treating
// the terminal as stalled.
const STEP_TIMEOUT_MS = 20_000
const PTY_EXIT_OUTPUT_IDLE_MS = 75
const PTY_EXIT_OUTPUT_LIMIT_MS = 750
const temporaryDirectories: string[] = []
// ConPTY may preserve either the seven-bit ESC+[ form, the equivalent
// eight-bit C1 CSI byte, or an invalid standalone 0x9b decoded as U+FFFD.
// OpenTUI cursor moves can split visible words, so each complete CSI form must
// be removed before semantic text assertions.
// biome-ignore lint/complexity/useRegexLiterals: literals with terminal controls are rejected by noControlCharactersInRegex.
const CSI_ESCAPE = new RegExp("(?:\\x1b\\[|\\x9b|\\ufffd)[0-?]*[ -/]*[@-~]", "gu")
// biome-ignore lint/complexity/useRegexLiterals: literals with terminal controls are rejected by noControlCharactersInRegex.
const OSC_ESCAPE = new RegExp("\\x1b\\][^\\x07]*(?:\\x07|$)", "gu")

interface OutputObserver {
  readonly needle: string
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  searchFrom: number
  timer?: ReturnType<typeof setTimeout>
}

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

function waitWithTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolveWait, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}`)),
      milliseconds,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolveWait(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function pauseForInput(milliseconds = 75): Promise<void> {
  return new Promise((resolvePause) => setTimeout(resolvePause, milliseconds))
}

function openPty(
  fixture: string,
  options: {
    readonly cols?: number
    readonly rows?: number
    readonly environment?: Readonly<Record<string, string>>
  } = {},
) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let output = ""
  let outputOffset = 0
  const observers = new Set<OutputObserver>()
  const pendingInput: Uint8Array[] = []
  let pendingInputOffset = 0
  let inputRetryTimer: ReturnType<typeof setTimeout> | undefined
  let lastOutputAt = performance.now()
  let childDiagnostics = ""
  const childDiagnosticPath = resolve(tmpdir(), `ralph-v2-pty-child-${randomUUID()}.log`)
  let terminal: Bun.Terminal

  const clearInputRetry = (): void => {
    if (!inputRetryTimer) return
    clearTimeout(inputRetryTimer)
    inputRetryTimer = undefined
  }
  const scheduleInputRetry = (): void => {
    if (inputRetryTimer || terminal.closed) return
    inputRetryTimer = setTimeout(() => {
      inputRetryTimer = undefined
      flushPendingInput()
    }, 10)
  }
  const flushPendingInput = (): void => {
    if (!terminal || terminal.closed) {
      clearInputRetry()
      return
    }
    while (pendingInput.length > 0) {
      const current = pendingInput[0]
      if (!current) return
      const remaining = current.subarray(pendingInputOffset)
      const written = terminal.write(remaining)
      if (written <= 0) {
        // Bun's Windows PTY does not always emit `drain` after a zero-byte
        // write. Retry the same unwritten suffix without advancing its offset.
        scheduleInputRetry()
        return
      }
      pendingInputOffset += Math.min(written, remaining.byteLength)
      if (pendingInputOffset < current.byteLength) continue
      pendingInput.shift()
      pendingInputOffset = 0
    }
    clearInputRetry()
  }
  const writeInput = (value: string): void => {
    pendingInput.push(encoder.encode(value))
    flushPendingInput()
  }

  const findOutput = (needle: string, after: number): number => {
    const absoluteStart = Math.max(after, outputOffset)
    const absoluteEnd = outputOffset + output.length
    if (absoluteStart > absoluteEnd) return -1
    const localIndex = output.indexOf(needle, absoluteStart - outputOffset)
    return localIndex < 0 ? -1 : outputOffset + localIndex
  }
  const scanObserver = (observer: OutputObserver): void => {
    if (findOutput(observer.needle, observer.searchFrom) >= 0) {
      if (observer.timer) clearTimeout(observer.timer)
      observers.delete(observer)
      observer.resolve()
      return
    }
    const overlap = Math.max(0, observer.needle.length - 1)
    observer.searchFrom = Math.max(
      observer.searchFrom,
      outputOffset + Math.max(0, output.length - overlap),
    )
  }
  terminal = new Bun.Terminal({
    cols: options.cols ?? 96,
    rows: options.rows ?? 30,
    name: "xterm-256color",
    data(_terminal, data) {
      lastOutputAt = performance.now()
      output += decoder.decode(data, { stream: true })
      for (const observer of observers) scanObserver(observer)
      if (output.length > OUTPUT_TRIM_THRESHOLD) {
        const discarded = output.length - OUTPUT_RETAINED_CHARACTERS
        output = output.slice(discarded)
        outputOffset += discarded
      }
    },
    // Bun.Terminal.write() is explicitly partial/backpressured. Queue the
    // unwritten suffix and resume it on drain or a bounded retry after a
    // zero-byte Windows ConPTY write.
    drain() {
      clearInputRetry()
      flushPendingInput()
    },
  })
  // A leaked PTY must never be the resource that keeps the test runner alive.
  // The subprocess remains referenced until it exits, and every normal path
  // still closes the terminal explicitly below.
  terminal.unref()
  const child = Bun.spawn([Bun.which("bun") ?? globalThis.process.execPath, fixture], {
    cwd: ROOT,
    env: {
      ...globalThis.process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      RALPH_TUI_ASCII: "1",
      RALPH_LANG: "en",
      ...options.environment,
      RALPH_PTY_DIAGNOSTIC_FILE: childDiagnosticPath,
    },
    terminal,
    // Every ConPTY child must remain hidden so a test run cannot steal focus.
    windowsHide: true,
  })
  const childExited = child.exited.then(async (exitCode) => {
    clearInputRetry()
    pendingInput.length = 0
    pendingInputOffset = 0
    // `Subprocess.exited` and the PTY data callback are distinct channels. On
    // Windows, the final ConPTY block can arrive just after the process exit
    // promise resolves. Keep the terminal open until output has been idle for
    // a short bounded window so the fixture's final result marker is not cut.
    lastOutputAt = performance.now()
    const settleDeadline = lastOutputAt + PTY_EXIT_OUTPUT_LIMIT_MS
    while (performance.now() < settleDeadline) {
      const idleFor = performance.now() - lastOutputAt
      if (idleFor >= PTY_EXIT_OUTPUT_IDLE_MS) break
      await pauseForInput(Math.min(25, PTY_EXIT_OUTPUT_IDLE_MS - idleFor))
    }
    childDiagnostics = await readFile(childDiagnosticPath, "utf8").catch(
      () => "(no child diagnostics)",
    )
    if (!terminal.closed) terminal.close()
    for (const observer of observers) {
      if (observer.timer) clearTimeout(observer.timer)
      observers.delete(observer)
      observer.reject(
        new Error(
          `PTY child exited with code ${exitCode} before output: ${observer.needle}\nChild diagnostics:\n${childDiagnostics}`,
        ),
      )
    }
    return exitCode
  })

  const waitForOutput = (needle: string, after = 0): Promise<void> => {
    if (findOutput(needle, after) >= 0) return Promise.resolve()
    return new Promise<void>((resolveOutput, reject) => {
      const overlap = Math.max(0, needle.length - 1)
      const observer: OutputObserver = {
        needle,
        resolve: resolveOutput,
        reject,
        searchFrom: Math.max(after, outputOffset + Math.max(0, output.length - overlap)),
      }
      observer.timer = setTimeout(() => {
        observers.delete(observer)
        reject(new Error(`Timed out waiting for ${needle}`))
      }, STEP_TIMEOUT_MS)
      observers.add(observer)
    })
  }

  const waitForRenderedText = async (needle: string, after = 0): Promise<void> => {
    const deadline = performance.now() + STEP_TIMEOUT_MS
    while (performance.now() < deadline) {
      const absoluteStart = Math.max(after, outputOffset)
      const rendered = output
        .slice(absoluteStart - outputOffset)
        .replace(CSI_ESCAPE, "")
        .replace(OSC_ESCAPE, "")
      if (rendered.includes(needle)) return
      if (child.exitCode !== null) {
        throw new Error(
          `PTY child exited with code ${child.exitCode} before rendered text: ${needle}`,
        )
      }
      await pauseForInput(25)
    }
    throw new Error(`Timed out waiting for rendered text ${needle}`)
  }

  const waitForExit = async (): Promise<number> => {
    return waitWithTimeout(childExited, STEP_TIMEOUT_MS, "the PTY child process to exit")
  }

  const cleanup = async (): Promise<void> => {
    if (child.exitCode === null && !terminal.closed) {
      // Close any popup, request renderer close, then use the command-owned
      // interrupt path. Separate writes prevent ConPTY from decoding Esc+q as
      // a single Alt+q key. We never kill the process from the harness.
      writeInput("\x1b")
      await pauseForInput(25)
      writeInput("q")
      await pauseForInput(25)
      writeInput("\x03")
      await waitWithTimeout(childExited, 2_000, "cooperative PTY cleanup").catch(() => undefined)
    }
    // Do not call ClosePseudoConsole while a child is still alive on Windows
    // 10; it can block while conhost flushes. The external bounded supervisor
    // owns the exceptional stuck-child cleanup.
    if (child.exitCode !== null && !terminal.closed) terminal.close()
    clearInputRetry()
    pendingInput.length = 0
    pendingInputOffset = 0
    for (const observer of observers) if (observer.timer) clearTimeout(observer.timer)
    observers.clear()
    await rm(childDiagnosticPath, { force: true }).catch(() => undefined)
  }

  return {
    child,
    terminal,
    output: () => output,
    mark: () => outputOffset + output.length,
    waitForOutput,
    waitForRenderedText,
    waitForExit,
    cleanup,
    write: writeInput,
    typeText: (value: string) => {
      for (const character of value) writeInput(character)
    },
    resize: (cols: number, rows: number) => terminal.resize(cols, rows),
  }
}

function markerJson<T>(output: string, marker: string): T {
  const markerStart = output.lastIndexOf(`${marker}:`)
  if (markerStart < 0) throw new Error(`Missing ${marker} JSON marker in PTY output`)
  // ConPTY renders stdout into its virtual screen and inserts hard wraps plus
  // terminal-control sequences. Normalize only the machine marker tail, then
  // extract one balanced JSON object without assuming it fits on one row.
  const tail = output
    .slice(markerStart + marker.length + 1)
    .replace(CSI_ESCAPE, "")
    .replace(OSC_ESCAPE, "")
    .replace(/[\r\n]/gu, "")
  const objectStart = tail.indexOf("{")
  if (objectStart < 0) throw new Error(`Missing ${marker} JSON object in PTY output`)
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = objectStart; index < tail.length; index += 1) {
    const character = tail[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") depth += 1
    else if (character === "}" && --depth === 0) {
      return JSON.parse(tail.slice(objectStart, index + 1)) as T
    }
  }
  throw new Error(`Incomplete ${marker} JSON object in PTY output`)
}

function outputFailure(error: unknown, output: string): Error {
  return new Error(
    `${error instanceof Error ? error.message : String(error)}\nPTY output tail:\n${output.slice(-6_000)}`,
    { cause: error },
  )
}

async function seedCompletedRun(root: string): Promise<string> {
  await cp(resolve(ROOT, "tests/fixtures/execution/single-pass"), root, { recursive: true })
  await initializeWorkspace(root, "0.1.0-pty")
  const compiled = await compilePrdGraph(resolve(root, "PRD.md"), {
    workspaceRoot: root,
    recursive: true,
    strict: true,
  })
  if (!compiled.ok || !compiled.graph) throw new Error("PTY parity PRD did not compile")
  const reference = compiled.graph.topologicalOrder[0]
  const document = reference ? compiled.graph.documents[reference.documentId] : undefined
  const task = document?.tasks.find((candidate) => candidate.id === reference?.taskId)
  if (!document || !task) throw new Error("PTY parity PRD has no executable task")
  const cli = {
    mode: "once",
    executorProfile: "fixture-executor",
    evaluationMode: "deterministic-only",
    maxRevisionAttempts: 0,
    noChangePolicy: "require-change",
  } satisfies RunOptionOverrides
  const effectiveOptions = resolveEffectiveRunOptions({ document, task, cli }).options
  const backend = new ScriptedExecutionBackend([
    {
      expectedTask: "single-pass/deliver-capability",
      actions: [{ type: "write", path: "product/capability.txt", content: "delivered" }],
    },
  ])
  const execution = await executeRun({
    workspaceRoot: root,
    prdFile: "PRD.md",
    effectiveOptions,
    optionResolution: { cli },
    dependencies: {
      resolveBackend: (profile) => (profile === "fixture-executor" ? backend : undefined),
      sleep: async () => undefined,
    },
  })
  if (execution.status !== "completed" || !execution.runId) {
    throw new Error(`PTY parity run did not complete: ${execution.status}`)
  }
  return execution.runId
}

function windowsPtyTest(name: string, callback: () => Promise<void>, timeout: number): void {
  if (process.platform !== "win32") return
  // Bun 1.3.14 for Windows ARM64 is built without TinyCC/bun:ffi. OpenTUI's
  // native renderer therefore cannot initialize on that runtime. Register a
  // real, classifier-visible skip instead of hiding the case or claiming a
  // pass; headless CLI, persistence, supervision and distribution tests still
  // run on the same ARM64 job.
  if (process.arch === "arm64") test.skip(name, callback, timeout)
  else test(name, callback, timeout)
}

describe("native PTY TUI matrix", () => {
  if (process.platform !== "win32") {
    test("propagates a real POSIX PTY resize with updated dimensions", async () => {
      const session = openPty(POSIX_RESIZE_FIXTURE)
      try {
        await session.waitForOutput("RALPH_POSIX_PTY_READY:")
        session.resize(120, 36)
        // Bun.Terminal.resize() updates the real PTY winsize on POSIX but does
        // not currently notify the child. A terminal emulator performs both
        // operations, so deliver SIGWINCH explicitly after the winsize write.
        await pauseForInput(25)
        process.kill(session.child.pid, "SIGWINCH")
        await session.waitForOutput("RALPH_POSIX_PTY_RESIZE:")
        expect(await session.waitForExit()).toBe(0)
        expect(
          markerJson<{ tty: string; columns: number; rows: number }>(
            session.output(),
            "RALPH_POSIX_PTY_RESIZE",
          ),
        ).toEqual({ tty: "T111", columns: 120, rows: 36 })
      } catch (error) {
        throw outputFailure(error, session.output())
      } finally {
        await session.cleanup()
      }
    }, 30_000)

    test("renders the dashboard and structured streams in a real POSIX PTY", async () => {
      const session = openPty(STREAM_FIXTURE)
      try {
        await session.waitForOutput("RALPH_PTY_READY")
        await session.waitForOutput("1/4")
        await session.waitForOutput("child-placeholder")
        session.write("q")
        await session.waitForOutput("RALPH_PTY_STREAM_RESULT:")
        expect(await session.waitForExit()).toBe(0)
        expect(
          markerJson<{
            tty: string
            status: string
            progress: { completed: number; total: number }
            childPlaceholder: boolean
            streams: Record<string, boolean>
          }>(session.output(), "RALPH_PTY_STREAM_RESULT"),
        ).toMatchObject({
          tty: "T111",
          status: "running",
          progress: { completed: 1, total: 4 },
          childPlaceholder: true,
          streams: { large: true, reasoning: true, tool: true, gate: true, external: true },
        })
      } catch (error) {
        throw outputFailure(error, session.output())
      } finally {
        await session.cleanup()
      }
    }, 30_000)
  }

  for (const usageMode of ["no-usage", "reported"] as const) {
    windowsPtyTest(
      `renders varied streams (${usageMode}), large output, child placeholder and resize`,
      async () => {
        const session = openPty(STREAM_FIXTURE, {
          environment: { RALPH_PTY_USAGE_MODE: usageMode },
        })
        try {
          expect(session.child.terminal).toBe(session.terminal)
          expect(session.child.stdin).toBeNull()
          expect(session.child.stdout).toBeNull()
          expect(session.child.stderr).toBeNull()

          // The dashboard title is intentionally clipped at narrow widths, so
          // synchronize on its stable prefix and assert the full TTY marker in
          // the fixture's machine-readable result below.
          await session.waitForOutput("RALPH_PTY_READY")
          await session.waitForOutput("1/4")
          await session.waitForOutput("child-placeholder")
          await session.waitForOutput(`source=${usageMode}`)

          session.resize(120, 36)
          await session.waitForOutput("RALPH_PTY_RESIZE:120x36")

          session.write("q")
          await session.waitForOutput("RALPH_PTY_STREAM_RESULT:")
          expect(await session.waitForExit()).toBe(0)
          const result = markerJson<{
            usageMode: string
            tty: string
            status: string
            progress: { completed: number; total: number }
            usageSource: string
            childPlaceholder: boolean
            streams: Record<string, boolean>
            droppedDisplayCharacters: number
          }>(session.output(), "RALPH_PTY_STREAM_RESULT")
          expect(result).toMatchObject({
            usageMode,
            tty: "T111",
            status: "completed",
            progress: { completed: 4, total: 4 },
            usageSource: usageMode,
            childPlaceholder: true,
            streams: { large: true, reasoning: true, tool: true, gate: true, external: true },
          })
          expect(result.droppedDisplayCharacters).toBeGreaterThan(0)
        } catch (error) {
          throw outputFailure(error, session.output())
        } finally {
          await session.cleanup()
        }
      },
      45_000,
    )
  }

  windowsPtyTest(
    "applies a mutable pre-run draft and saves workspace/global defaults through shared handlers",
    async () => {
      const workspaceRoot = await temporaryDirectory()
      const configHome = await temporaryDirectory()
      const session = openPty(PRE_RUN_FIXTURE, {
        cols: 120,
        rows: 40,
        environment: {
          RALPH_PTY_WORKSPACE: workspaceRoot,
          RALPH_CONFIG_HOME: configHome,
        },
      })
      try {
        await session.waitForOutput("pre-run")

        let cursor = session.mark()
        session.write("/")
        await session.waitForOutput("SEARCH>", cursor)
        session.typeText("language")
        await pauseForInput(200)
        session.write("\r")
        await pauseForInput()

        cursor = session.mark()
        session.write("\r")
        await session.waitForOutput("EDIT Language> en", cursor)
        session.write("\x7f\x7f")
        session.typeText("pt-BR")
        session.write("\r")
        await session.waitForOutput("pt-BR · draft", cursor)
        session.write("v")
        await session.waitForOutput("apply this run: available", cursor)
        session.write("w")
        await session.waitForOutput("CONFIRM: save workspace", cursor)
        session.write("\r")
        await session.waitForRenderedText("Defaults saved for workspace", cursor)

        cursor = session.mark()
        session.write("\r")
        // A successful save clears the draft and restores the command-owned
        // invocation value (`en`) in the popup. Committing it again creates the
        // explicit global-default mutation without relying on hidden state.
        await session.waitForOutput("EDIT Language> en", cursor)
        session.write("\r")
        await session.waitForOutput("en · draft", cursor)
        session.write("g")
        await session.waitForOutput("CONFIRM: save global", cursor)
        session.write("\r")
        await session.waitForRenderedText("Defaults saved for global", cursor)

        cursor = session.mark()
        session.write("\r")
        await session.waitForOutput("EDIT Language> en", cursor)
        session.write("\x7f\x7f")
        session.typeText("pt-BR")
        session.write("\r")
        await session.waitForOutput("pt-BR · draft", cursor)
        // Preview is the deterministic acknowledgement that the final draft
        // revision reached the shared settings handler and is applyable. Do not
        // race Apply against a screen redraw or rely on an arbitrary delay.
        cursor = session.mark()
        session.write("v")
        await session.waitForOutput("apply this run: available", cursor)
        session.write("a")

        await session.waitForOutput("RALPH_PTY_PRE_RUN_RESULT:")
        expect(await session.waitForExit()).toBe(0)
        expect(
          markerJson<{
            disposition: string
            appliedLanguage: string | null
            workspaceLanguage: string
            globalLanguage: string
            persistedRuns: number
          }>(session.output(), "RALPH_PTY_PRE_RUN_RESULT"),
        ).toEqual({
          disposition: "applied",
          appliedLanguage: "pt-BR",
          workspaceLanguage: "pt-BR",
          globalLanguage: "en",
          persistedRuns: 0,
        })
      } catch (error) {
        throw outputFailure(error, session.output())
      } finally {
        await session.cleanup()
      }
    },
    60_000,
  )

  windowsPtyTest(
    "q leaves the source in background, reattach observes progress and Ctrl+C uses the command bridge",
    async () => {
      const stateDirectory = await temporaryDirectory()
      const stateFile = resolve(stateDirectory, "lifecycle-state.json")
      const background = openPty(LIFECYCLE_FIXTURE, {
        cols: 110,
        rows: 36,
        environment: {
          RALPH_PTY_LIFECYCLE_PHASE: "background",
          RALPH_PTY_LIFECYCLE_STATE: stateFile,
        },
      })
      try {
        await background.waitForOutput("RALPH_PTY_LIFECYCLE")
        await background.waitForOutput("child-placeholder")
        await background.waitForOutput("1/3")
        // The footer is emitted after the complete initial frame and is the
        // renderer-owned acknowledgement that global key handling is active.
        await background.waitForOutput("q close/background")
        background.write("q")
        await background.waitForOutput("RALPH_PTY_BACKGROUND:source-progressed-without-renderer")
        await background.waitForOutput("RALPH_PTY_BACKGROUND_RESULT:")
        expect(await background.waitForExit()).toBe(0)

        const backgroundResult = markerJson<{
          status: string
          progress: { completed: number; total: number }
        }>(background.output(), "RALPH_PTY_BACKGROUND_RESULT")
        expect(backgroundResult).toEqual({
          status: "running",
          progress: { completed: 2, total: 3 },
        })

        const reattach = openPty(LIFECYCLE_FIXTURE, {
          cols: 110,
          rows: 36,
          environment: {
            RALPH_PTY_LIFECYCLE_PHASE: "reattach",
            RALPH_PTY_LIFECYCLE_STATE: stateFile,
          },
        })
        try {
          await reattach.waitForOutput("REATTACHED")
          await reattach.waitForOutput("2/3")
          await reattach.waitForOutput("q close/background")
          reattach.write("\x03")
          await reattach.waitForOutput("RALPH_PTY_CTRL_C:command-owned-interrupt")
          await reattach.waitForOutput("RALPH_PTY_LIFECYCLE_RESULT:")
          expect(await reattach.waitForExit()).toBe(0)
          expect(
            markerJson<{
              interrupted: boolean
              status: string
              progress: { completed: number; total: number }
              childPlaceholder: boolean
            }>(reattach.output(), "RALPH_PTY_LIFECYCLE_RESULT"),
          ).toEqual({
            interrupted: true,
            status: "running",
            progress: { completed: 2, total: 3 },
            childPlaceholder: true,
          })
        } catch (error) {
          throw outputFailure(error, reattach.output())
        } finally {
          await reattach.cleanup()
        }
      } catch (error) {
        throw outputFailure(error, background.output())
      } finally {
        await background.cleanup()
      }
    },
    45_000,
  )

  windowsPtyTest(
    "attach/replay stay read-only and final TUI, human, JSON and replay status agree",
    async () => {
      const workspaceRoot = await temporaryDirectory()
      const configHome = await temporaryDirectory()
      const runId = await seedCompletedRun(workspaceRoot)
      const beforeSnapshot = buildRunUiSnapshot(workspaceRoot, runId)
      const beforeHash = createHash("sha256").update(JSON.stringify(beforeSnapshot)).digest("hex")
      const environment = {
        RALPH_PTY_WORKSPACE: workspaceRoot,
        RALPH_PTY_RUN_ID: runId,
        RALPH_CONFIG_HOME: configHome,
      }
      const attach = openPty(PERSISTED_FIXTURE, {
        cols: 120,
        rows: 40,
        environment: { ...environment, RALPH_PTY_ATTACH_MODE: "attach" },
      })
      try {
        await attach.waitForOutput("RALPH_PTY_ATTACH_START")
        await attach.waitForOutput("completed")
        await attach.waitForOutput("1/1")
        let cursor = attach.mark()
        attach.write("\x10")
        await attach.waitForOutput("attach · status", cursor)
        attach.write("a")
        await attach.waitForOutput("Attach and replay settings are read-only", cursor)
        cursor = attach.mark()
        attach.write("\x1b")
        await attach.waitForOutput("ENGINE OUTPUT", cursor)
        attach.write("q")
        await attach.waitForOutput("RALPH_PTY_PERSISTED_RESULT:")
        expect(await attach.waitForExit()).toBe(0)
        const attachResult = markerJson<{
          mode: string
          runId: string
          status: string
          progress: { completed: number; total: number }
          result: { observedStatus: string; closeReason: string }
          readOnly: boolean
        }>(attach.output(), "RALPH_PTY_PERSISTED_RESULT")
        expect(attachResult).toMatchObject({
          mode: "attach",
          runId,
          status: "completed",
          progress: { completed: 1, total: 1 },
          result: { observedStatus: "completed", closeReason: "user" },
          readOnly: true,
        })

        const replay = openPty(PERSISTED_FIXTURE, {
          cols: 120,
          rows: 40,
          environment: { ...environment, RALPH_PTY_ATTACH_MODE: "replay" },
        })
        let replayResult: {
          mode: string
          runId: string
          status: string
          progress: { completed: number; total: number }
          result: { observedStatus: string; closeReason: string }
          readOnly: boolean
        }
        try {
          await replay.waitForOutput("RALPH_PTY_REPLAY_START")
          await replay.waitForOutput("completed")
          await replay.waitForOutput("1/1")
          cursor = replay.mark()
          replay.write("\x10")
          await replay.waitForOutput("replay · status", cursor)
          replay.write("a")
          await replay.waitForOutput("Attach and replay settings are read-only", cursor)
          cursor = replay.mark()
          replay.write("\x1b")
          await replay.waitForOutput("ENGINE OUTPUT", cursor)
          replay.write("\x03")
          await replay.waitForOutput("RALPH_PTY_CTRL_C:replay-command-interrupt")
          await replay.waitForOutput("RALPH_PTY_PERSISTED_RESULT:")
          expect(await replay.waitForExit()).toBe(0)
          replayResult = markerJson(replay.output(), "RALPH_PTY_PERSISTED_RESULT")
          expect(replayResult).toMatchObject({
            mode: "replay",
            runId,
            status: "completed",
            progress: { completed: 1, total: 1 },
            result: { observedStatus: "completed", closeReason: "signal" },
            readOnly: true,
          })
        } catch (error) {
          throw outputFailure(error, replay.output())
        } finally {
          await replay.cleanup()
        }

        const commandContext = {
          version: "0.1.0-pty",
          cwd: workspaceRoot,
          environment: {
            ...globalThis.process.env,
            RALPH_CONFIG_HOME: configHome,
            RALPH_LANG: "en",
          },
        }
        const humanStatus = await executeCli(
          ["status", "run", "--workspace", workspaceRoot, "--run-id", runId],
          commandContext,
        )
        const jsonStatus = await executeCli(
          ["status", "run", "--workspace", workspaceRoot, "--run-id", runId, "--format", "json"],
          commandContext,
        )
        const replaySnapshot = buildRunUiSnapshot(workspaceRoot, runId)
        const afterHash = createHash("sha256").update(JSON.stringify(replaySnapshot)).digest("hex")
        const jsonData = jsonStatus.execution.result.data as {
          run: { status: string }
          progress: { completed: number; total: number }
        }

        expect(humanStatus.execution.human).toContain("Status:   completed")
        expect(humanStatus.execution.human).toContain("Progress: 1/1")
        expect(jsonData.run.status).toBe("completed")
        expect(jsonData.progress).toMatchObject({ completed: 1, total: 1 })
        expect(replaySnapshot.status).toBe("completed")
        expect(replaySnapshot.progress).toEqual({ completed: 1, total: 1 })
        expect(beforeSnapshot.status).toBe(attachResult.status)
        expect(jsonData.run.status).toBe(replayResult.status)
        expect(replaySnapshot.status).toBe(replayResult.status)
        expect(afterHash).toBe(beforeHash)
      } catch (error) {
        throw outputFailure(error, attach.output())
      } finally {
        await attach.cleanup()
      }
    },
    90_000,
  )
})
