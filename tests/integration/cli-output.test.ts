import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { executeCli, runCli } from "@ralph-next/commands"
import { globalConfigPath, initializeWorkspace, workspaceLayout } from "@ralph-next/persistence"
import { type OutputWriters, writeCommandExecution } from "@ralph-next/telemetry"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const VERSION = "9.8.7-test"
const CLI_ENTRY = resolve(import.meta.dir, "../../apps/ralph-cli/src/main.ts")
const temporaryDirectories: string[] = []

// Source-entrypoint cases launch fresh Bun processes and cross the complete
// workspace/SQLite initialization boundary twice. Five seconds is too short
// for a contended hosted Windows runner and is not the product health budget.
setDefaultTimeout(30_000)

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

function captureWriters(): {
  writers: OutputWriters
  stdout: () => string
  stderr: () => string
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    writers: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  }
}

function context(cwd: string, extra: Record<string, string | undefined> = {}) {
  return {
    version: VERSION,
    cwd,
    environment: { RALPH_CONFIG_HOME: resolve(cwd, "global-config"), ...extra },
  }
}

describe("stdout/stderr output contracts", () => {
  test("writes successful human output only to stdout", async () => {
    const root = await temporaryDirectory()
    const capture = captureWriters()
    const exitCode = await runCli(["version"], context(root), capture.writers)
    expect(exitCode).toBe(0)
    expect(capture.stdout()).toBe(`ralph-next ${VERSION}\n`)
    expect(capture.stderr()).toBe("")
  })

  test("writes human errors only to stderr with the normative exit code", async () => {
    const root = await temporaryDirectory()
    const capture = captureWriters()
    const exitCode = await runCli(["does-not-exist"], context(root), capture.writers)
    expect(exitCode).toBe(2)
    expect(capture.stdout()).toBe("")
    expect(capture.stderr()).toContain("ERROR RALPH_COMMAND_UNKNOWN")
    expect(capture.stderr()).toContain("Run `ralph-next help`")
  })

  test("writes JSON errors as one CommandResult on stdout and keeps stderr empty", async () => {
    const root = await temporaryDirectory()
    const capture = captureWriters()
    const exitCode = await runCli(
      ["does-not-exist", "--format", "json"],
      context(root),
      capture.writers,
    )
    expect(exitCode).toBe(2)
    expect(capture.stderr()).toBe("")
    expect(capture.stdout()).not.toContain(String.fromCharCode(27))
    expect(JSON.parse(capture.stdout())).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "error",
      diagnostics: [{ code: "RALPH_COMMAND_UNKNOWN", severity: "error" }],
    })
  })

  test("structurally redacts sensitive diagnostic detail keys in human stderr", () => {
    const capture = captureWriters()
    writeCommandExecution(
      {
        result: {
          schemaVersion: 1,
          ok: false,
          command: "diagnostic-redaction-test",
          diagnostics: [
            {
              code: "RALPH_TEST_SECRET_DETAIL",
              severity: "error",
              message: "Safe diagnostic",
              details: {
                api_key: "not-in-environment-secret",
                nested: { authorization: "Bearer another-secret" },
              },
            },
          ],
        },
      },
      "human",
      capture.writers,
      [],
    )

    expect(capture.stdout()).toBe("")
    expect(capture.stderr()).toContain('"api_key":"[REDACTED]"')
    expect(capture.stderr()).toContain('"authorization":"[REDACTED]"')
    expect(capture.stderr()).not.toContain("not-in-environment-secret")
    expect(capture.stderr()).not.toContain("another-secret")
  })

  test("preserves YAML file, line, column and key path in structured diagnostics", async () => {
    const root = await temporaryDirectory()
    await initializeWorkspace(root, VERSION)
    const config = workspaceLayout(root).config
    await writeFile(config, "schema_version: 1\nunexpected: true\n")
    const capture = captureWriters()

    const exitCode = await runCli(
      ["config", "list", "--workspace", root, "--format", "json"],
      context(root),
      capture.writers,
    )

    expect(exitCode).toBe(2)
    expect(capture.stderr()).toBe("")
    expect(JSON.parse(capture.stdout())).toMatchObject({
      schemaVersion: 1,
      ok: false,
      diagnostics: [
        {
          code: "RALPH_CONFIG_SCHEMA_INVALID",
          file: config,
          line: 2,
          column: 13,
          details: { issues: [{ path: "unexpected" }] },
        },
      ],
    })
  })

  test("explains public config precedence and lists the effective result", async () => {
    const root = await temporaryDirectory()
    await initializeWorkspace(root, VERSION)
    const workspaceConfig = workspaceLayout(root).config
    await writeFile(workspaceConfig, "schema_version: 1\ndefaults:\n  mode: wiggum\n")
    const configHome = resolve(root, "isolated-global")
    const environment = {
      RALPH_CONFIG_HOME: configHome,
      RALPH_MODE: "parallel",
    }
    const globalConfig = globalConfigPath(environment)
    await mkdir(dirname(globalConfig), { recursive: true })
    await writeFile(globalConfig, "defaults:\n  mode: once\n")

    const explain = captureWriters()
    expect(
      await runCli(
        ["config", "explain", "defaults.mode", "--workspace", root, "--mode", "loop", "--json"],
        context(root, environment),
        explain.writers,
      ),
    ).toBe(0)
    expect(explain.stderr()).toBe("")
    expect(JSON.parse(explain.stdout())).toMatchObject({
      ok: true,
      command: "config.explain",
      data: {
        key: "defaults.mode",
        value: "loop",
        source: "cli",
        sourceRef: "command line",
      },
    })

    const list = captureWriters()
    expect(
      await runCli(
        ["config", "list", "--effective", "--workspace", root, "--format", "json"],
        context(root, environment),
        list.writers,
      ),
    ).toBe(0)
    expect(JSON.parse(list.stdout())).toMatchObject({
      ok: true,
      command: "config.list",
      data: {
        effective: true,
        config: { defaults: { mode: "parallel" } },
        sources: { "defaults.mode": { source: "env", sourceRef: "environment" } },
      },
    })
  })

  test("--debug exposes a safe stack while normal errors omit it and argv secrets stay hidden", async () => {
    const root = await temporaryDirectory()
    const normal = await executeCli(["unknown", "--json"], context(root))
    const debug = await executeCli(
      ["unknown", "--json", "--debug"],
      context(root, { RALPH_API_KEY: "debug-secret-canary" }),
    )
    const normalDiagnostic = normal.execution.result.diagnostics[0]
    const debugDiagnostic = debug.execution.result.diagnostics[0]
    expect(normalDiagnostic?.details).toBeUndefined()
    expect(debugDiagnostic?.details?.stack).toBeString()

    const capture = captureWriters()
    await runCli(
      ["unknown", "--json", "--debug"],
      context(root, { RALPH_API_KEY: "debug-secret-canary" }),
      capture.writers,
    )
    expect(capture.stdout()).not.toContain("debug-secret-canary")

    const human = captureWriters()
    await runCli(
      ["debug-secret-canary", "--debug"],
      context(root, { RALPH_API_KEY: "debug-secret-canary" }),
      human.writers,
    )
    expect(human.stdout()).toBe("")
    expect(human.stderr()).toContain("Details:")
    expect(human.stderr()).toContain("RalphError: Unknown command")
    expect(human.stderr()).not.toContain("debug-secret-canary")
  })
})

describe("real source entrypoint", () => {
  async function invoke(root: string, args: string[]) {
    const processHandle = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
      cwd: root,
      env: {
        ...process.env,
        RALPH_CONFIG_HOME: resolve(root, "global-config"),
        NO_COLOR: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  }

  test("initializes and reads status as banner-free JSON outside the source checkout", async () => {
    const root = await temporaryDirectory()
    const initialized = await invoke(root, ["init", "--format", "json"])
    expect(initialized).toMatchObject({ exitCode: 0, stderr: "" })
    expect(initialized.stdout).not.toContain(String.fromCharCode(27))
    expect(JSON.parse(initialized.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "init",
      data: { created: true, repaired: false, root, eventCount: 1 },
      diagnostics: [],
    })

    const status = await invoke(root, ["status", "--json"])
    expect(status).toMatchObject({ exitCode: 0, stderr: "" })
    expect(JSON.parse(status.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      command: "status",
      data: { initialized: true, state: "ready", root, eventCount: 1 },
      diagnostics: [],
    })
  })

  test("returns a machine-readable usage error without stderr noise", async () => {
    const root = await temporaryDirectory()
    const result = await invoke(root, ["not-a-command", "--json"])
    expect(result).toMatchObject({ exitCode: 2, stderr: "" })
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      ok: false,
      command: "error",
      diagnostics: [{ code: "RALPH_COMMAND_UNKNOWN" }],
    })
  })
})
