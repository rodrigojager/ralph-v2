import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { parseS03HarnessOptions } from "../../scripts/s03-compatibility"
import {
  assertClosedS10CompatibilityContract,
  S10_LEGACY_COMMAND_CONTRACT,
  S10_LEGACY_FLAG_CONTRACT,
  S10_LINKED_TEST_SUITES,
} from "../../scripts/s10-compatibility-contract"
import { parseS10HarnessOptions } from "../../scripts/s10-compatibility-core"

const EXPECTED_LEGACY_FLAGS = [
  "--",
  "--auto-rollback",
  "--base-branch",
  "--branch-per-task",
  "--create-pr",
  "--dangerous",
  "--debug-engine-json",
  "--draft-pr",
  "--dry-run",
  "--engine",
  "--fail-fast",
  "--fast",
  "--follow",
  "--force",
  "--gate",
  "--haiku",
  "--help",
  "--ignore-context-stops",
  "--ignore-gutter",
  "--json",
  "--label",
  "--level",
  "--lint-command",
  "--loop",
  "--max-iterations",
  "--max-parallel",
  "--max-retries",
  "--max-tokens",
  "--mode",
  "--model",
  "--no-change-continue-on-max-retries",
  "--no-change-max-retries",
  "--no-change-policy",
  "--no-change-stop-on-max-retries",
  "--no-commit",
  "--no-lint",
  "--no-sandbox",
  "--non-interactive",
  "--opus",
  "--output",
  "--parallel-integration",
  "--prd",
  "--processes",
  "--repo",
  "--respect-context-stops",
  "--respect-gutter",
  "--retries",
  "--retry-delay",
  "--retry-failed",
  "--run-gate",
  "--run-tests",
  "--sandbox",
  "--sandbox-image",
  "--sandbox-network",
  "--sandbox-provider",
  "--security",
  "--since",
  "--skip-lint",
  "--skip-tests",
  "--sonnet",
  "--state",
  "--temperature",
  "--test-command",
  "--ui",
  "--verbose",
  "--version",
  "--wiggum",
  "--worker-run",
  "--yes",
  "-V",
  "-h",
  "-l",
  "-loop",
  "-r",
  "-v",
  "-w",
  "-wiggum",
  "-y",
] as const

const EXPECTED_LEGACY_COMMANDS = [
  "--help",
  "--version",
  "-V",
  "-h",
  "about",
  "adapter",
  "adapter list",
  "adapter new",
  "adapters",
  "adapters list",
  "adapters new",
  "checkpoint",
  "checkpoint create",
  "checkpoint list",
  "checkpoint restore",
  "checkpoint show",
  "checkpoints",
  "checkpoints create",
  "checkpoints list",
  "checkpoints restore",
  "checkpoints show",
  "clean",
  "config",
  "config get",
  "config list",
  "config set",
  "context",
  "context refresh",
  "context show",
  "doctor",
  "events",
  "events tail",
  "init",
  "install",
  "lang",
  "lang current",
  "lang list",
  "lang set",
  "lang update",
  "logs",
  "logs tail",
  "loop",
  "once",
  "parallel",
  "recipe",
  "recipe list",
  "recipe new",
  "recipes",
  "recipes list",
  "recipes new",
  "report",
  "report last",
  "rules",
  "run",
  "setup",
  "status",
  "tasks",
  "tasks done",
  "tasks list",
  "tasks next",
  "tasks sync",
  "ui",
  "ui current",
  "ui set",
  "ui toggle",
  "update",
] as const

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, "en"))
}

describe("S10 closed legacy compatibility contract", () => {
  test("classifies every audited Go parser command and flag spelling exactly once", () => {
    const summary = assertClosedS10CompatibilityContract()
    const commands = S10_LEGACY_COMMAND_CONTRACT.flatMap((item) => item.legacySpellings)
    const flags = S10_LEGACY_FLAG_CONTRACT.flatMap((item) => item.legacySpellings)

    expect(sorted(commands)).toEqual(sorted(EXPECTED_LEGACY_COMMANDS))
    expect(sorted(flags)).toEqual(sorted(EXPECTED_LEGACY_FLAGS))
    expect(summary.commandSpellings).toBe(EXPECTED_LEGACY_COMMANDS.length)
    expect(summary.flagSpellings).toBe(EXPECTED_LEGACY_FLAGS.length)
    expect(
      [...S10_LEGACY_COMMAND_CONTRACT, ...S10_LEGACY_FLAG_CONTRACT].every(
        (item) => item.evidence.length > 0,
      ),
    ).toBe(true)
  })

  test("requires both explicit binary paths and never falls back to PATH or environment", () => {
    const projectRoot = resolve("C:/s10-project")
    expect(() => parseS10HarnessOptions([], projectRoot)).toThrow("--legacy-binary")
    expect(() =>
      parseS10HarnessOptions(["--legacy-binary", "ralph", "--next-binary", "ralph"], projectRoot),
    ).toThrow("explicit file path")

    const parsed = parseS10HarnessOptions(
      [
        "--legacy-binary",
        "./bin/ralph.exe",
        "--next-binary",
        "./dist/ralph.exe",
        "--format",
        "json",
        "--no-write",
        "--keep-workspace",
      ],
      projectRoot,
    )
    expect(parsed).toMatchObject({
      format: "json",
      writeReports: false,
      keepWorkspace: true,
    })
    expect(parsed.legacyBinary).toBe(resolve("./bin/ralph.exe"))
    expect(parsed.nextBinary).toBe(resolve("./dist/ralph.exe"))
  })

  test("binds every non-black-box edge to a test suite that the coordinator executes", () => {
    const coverage = new Set<string>(S10_LINKED_TEST_SUITES.flatMap((suite) => suite.coverage))
    for (const required of [
      "skips",
      "fast",
      "no-change",
      "retry",
      "fail-fast",
      "parallel",
      "git",
      "security",
      "sandbox",
      "signal",
      "events",
      "report",
    ]) {
      expect(coverage.has(required)).toBe(true)
    }
    expect(S10_LINKED_TEST_SUITES.every((suite) => suite.files.length > 0)).toBe(true)
  })

  test("lets the S03 addendum use the same explicit next standalone", () => {
    const projectRoot = resolve("C:/s10-project")
    const options = parseS03HarnessOptions(
      ["--next-binary", "./dist/ralph.exe", "--no-write", "--json"],
      projectRoot,
    )
    expect(options.nextBinary).toBe(resolve("./dist/ralph.exe"))
    expect(options).toMatchObject({ writeReports: false, printJson: true })
  })
})
