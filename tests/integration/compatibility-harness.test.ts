import { expect, test } from "bun:test"
import { join, resolve } from "node:path"
import {
  type HarnessOptions,
  renderCompatibilityMarkdown,
  runCompatibilityHarness,
  writeCompatibilityReports,
} from "../../scripts/compatibility-core"

test("next-only harness exercises every S01 command in disposable workspaces", async () => {
  const projectRoot = resolve(import.meta.dir, "../..")
  const options: HarnessOptions = {
    withoutLegacy: true,
    nextSource: true,
    outputDirectory: resolve(projectRoot, "docs", "compatibility"),
    writeReports: false,
    printJson: false,
  }
  const report = await runCompatibilityHarness(options, projectRoot)

  expect(report.comparisonMode).toBe("next-only")
  expect(report.scenarios.map((scenario) => scenario.id)).toEqual([
    "help",
    "version",
    "status",
    "init",
    "status-descendant",
  ])
  expect(report.summary).toMatchObject({ total: 5, regressions: 0, notCompared: 5 })
  expect(report.scenarios.every((scenario) => scenario.next.exitCode === 0)).toBe(true)
  expect(report.scenarios.every((scenario) => scenario.assessment === "pass")).toBe(true)
  expect(
    report.scenarios.every((scenario) => scenario.next.invariants.every((item) => item.passed)),
  ).toBe(true)
  const descendant = report.scenarios.find((scenario) => scenario.id === "status-descendant")
  expect(descendant?.next.invariants.map((item) => item.id)).toContain(
    "next.status-descendant.semantics",
  )
  expect(report.platformEvidence).toHaveLength(6)
  expect(report.platformEvidence.some((item) => item.state === "tested")).toBe(false)
  expect(descendant?.next.cwd).toBe(
    join("<FIXTURE_ROOT>", "status-descendant", "nested space", "filho-ç"),
  )
  expect(report.binaries.next.path).toBe("<PROJECT_ROOT>/apps/ralph-cli/src/main.ts")
  expect(report.scenarios[0]?.next.invocation[0]).toBe("<BUN_RUNTIME>")
  expect(JSON.stringify(report)).not.toContain(projectRoot)

  const markdown = renderCompatibilityMarkdown(report)
  expect(markdown).toContain("compatible|changed|deprecated|removed")
  expect(markdown).toContain("bun-windows-x64-baseline")
  expect(markdown).toContain("bun-darwin-arm64")
  await expect(
    writeCompatibilityReports(report, resolve(projectRoot, "docs", "compatibility")),
  ).rejects.toThrow("require a standalone binary")
}, 120_000)
