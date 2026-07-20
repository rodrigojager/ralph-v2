import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"

type CapturedCommand = {
  exitCode: number
  stdout: string
  stderr: string
}

type JsonCommandResult = {
  schemaVersion: number
  ok: boolean
  command: string
  runId?: string
  data?: Record<string, unknown>
}

const projectRoot = resolve(import.meta.dir, "..", "..")
const fixtureRoot = resolve(projectRoot, "tests", "fixtures", "execution", "single-pass")
let temporaryRoot = ""
let workspace = ""
let executable = ""
let environment: Record<string, string> = {}

function assertSafeTemporaryPath(path: string): void {
  const base = resolve(tmpdir())
  const segment = relative(base, resolve(path))
  if (!segment || segment === ".." || segment.startsWith(`..${sep}`)) {
    throw new Error(`Refusing to remove a non-temporary path: ${path}`)
  }
}

async function run(argv: readonly string[]): Promise<CapturedCommand> {
  const child = Bun.spawn([executable, ...argv], {
    cwd: workspace,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function parseJson(capture: CapturedCommand): JsonCommandResult {
  expect(capture.stderr).toBe("")
  return JSON.parse(capture.stdout) as JsonCommandResult
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "ralph-s03-packaged-"))
  assertSafeTemporaryPath(temporaryRoot)
  workspace = join(temporaryRoot, "workspace with spaces ç")
  const binaryDirectory = join(temporaryRoot, "bin")
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(binaryDirectory, { recursive: true }),
  ])
  await cp(fixtureRoot, workspace, { recursive: true })
  executable = join(
    binaryDirectory,
    process.platform === "win32" ? "ralph-fixture.exe" : "ralph-fixture",
  )
  const source = resolve(projectRoot, "tests", "support", "fixture-cli.ts")
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      source,
      "--compile",
      "--packages=bundle",
      "--allow-unresolved=<empty>",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-package-json",
      "--no-compile-autoload-tsconfig",
      `--outfile=${executable}`,
    ],
    {
      cwd: projectRoot,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ])
  if (exitCode !== 0) {
    throw new Error(`Could not build the packaged fixture CLI (${exitCode})\n${stdout}\n${stderr}`)
  }
  environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    RALPH_CONFIG_HOME: join(temporaryRoot, "config home"),
    RALPH_TEST_BACKEND_SCRIPT: join(workspace, "backend.json"),
    NO_COLOR: "1",
  }
})

afterAll(async () => {
  if (!temporaryRoot) return
  assertSafeTemporaryPath(temporaryRoot)
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 125,
  })
})

describe("packaged S03 vertical slice", () => {
  test("the compiled CLI governs execution, evidence, completion and observability", async () => {
    const initialized = parseJson(
      await run(["init", "--workspace", workspace, "--non-interactive", "--format", "json"]),
    )
    expect(initialized.ok).toBe(true)

    const executed = parseJson(
      await run([
        "once",
        "--workspace",
        workspace,
        "--prd",
        "PRD.md",
        "--executor-profile",
        "fixture-executor",
        "--format",
        "json",
      ]),
    )
    expect(executed.ok).toBe(true)
    expect(executed.command).toBe("once")
    expect(executed.runId).toBeString()
    expect(await readFile(join(workspace, "product", "capability.txt"), "utf8")).toBe("delivered")
    expect(await readFile(join(workspace, "PRD.md"), "utf8")).toContain(
      "- [x] **deliver-capability",
    )

    const status = parseJson(
      await run(["status", "run", "--workspace", workspace, "--format", "json"]),
    )
    expect(status.ok).toBe(true)
    expect(status.data?.progress).toEqual({
      completed: 1,
      total: 1,
      ratio: 1,
      scope: "leaf-tasks",
    })

    const events = parseJson(
      await run([
        "events",
        "--workspace",
        workspace,
        "--run-id",
        executed.runId as string,
        "--format",
        "json",
      ]),
    )
    expect(events.ok).toBe(true)
    expect(events.data?.count).toBeGreaterThan(0)

    const report = parseJson(
      await run(["report", "last", "--workspace", workspace, "--format", "json"]),
    )
    expect(report.ok).toBe(true)
    expect(report.runId).toBe(executed.runId)
    expect(report.data?.status).toBe("completed")
    expect(report.data?.counters).toMatchObject({
      tasksCompleted: 1,
      attempts: 1,
      modelCalls: 1,
    })

    const reportFile = join(
      workspace,
      ".ralph",
      "runs",
      executed.runId as string,
      "reports",
      "report.json",
    )
    expect(dirname(reportFile)).toContain(join(".ralph", "runs"))
    expect(JSON.parse(await readFile(reportFile, "utf8"))).toMatchObject({
      runId: executed.runId,
      status: "completed",
    })
  }, 30_000)
})
