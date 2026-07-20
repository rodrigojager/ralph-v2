import { describe, expect, test } from "bun:test"
import {
  classifyScenario,
  makePortableRaw,
  normalizeVolatile,
  parseHarnessOptions,
  type ScenarioCapture,
} from "../../scripts/compatibility-core"

function capture(
  stdout: string,
  files: string[] = [],
  exitCode = 0,
  stdoutLineEndings: ScenarioCapture["stdout"]["lineEndings"] = "lf",
  invariantPass = exitCode === 0,
): ScenarioCapture {
  return {
    invocation: ["ralph"],
    cwd: "<FIXTURE_ROOT>/scenario",
    snapshotRoot: "<FIXTURE_ROOT>/scenario",
    exitCode,
    timedOut: false,
    stdout: { raw: stdout, normalized: stdout, lineEndings: stdoutLineEndings },
    stderr: { raw: "", normalized: "", lineEndings: "none" },
    files: files.map((path) => ({ path, kind: path.includes(".") ? "file" : "directory" })),
    invariants: [
      {
        id: "fixture.invariant",
        passed: invariantPass,
        evidence: invariantPass ? "fixture passed" : "fixture failed",
      },
    ],
  }
}

describe("compatibility normalization", () => {
  test("portable raw canonicalizes fixture roots but preserves line endings", () => {
    const raw = "Root C:\\temp\\fixture\\status\r\nvalue 123\r\n"
    expect(makePortableRaw(raw, "C:\\temp\\fixture")).toBe(
      "Root <FIXTURE_ROOT>\\status\r\nvalue 123\r\n",
    )
  })

  test("normalizes UUIDs and ISO timestamps without hiding arbitrary values", () => {
    const value = "id 5b1c7672-6d95-4de6-a82d-853aa09ca9e6 at 2026-07-18T12:34:56.123Z count 42"
    expect(normalizeVolatile(value)).toBe("id <UUID> at <TIMESTAMP> count 42")
  })

  test("portable raw preserves distinct volatile occurrences with stable indexes", () => {
    const value = "5b1c7672-6d95-4de6-a82d-853aa09ca9e6 9f8c6710-a1d2-4dc5-93bf-a8cbb2202828"
    expect(makePortableRaw(value, "C:\\unused")).toBe("<RAW_UUID_1> <RAW_UUID_2>")
  })
})

describe("compatibility classification", () => {
  test("uninitialized status is semantically compatible despite wording changes", () => {
    const result = classifyScenario(
      "status",
      capture("Workspace: not initialized\n"),
      capture("Workspace: not initialized\nState: uninitialized\n"),
    )
    expect(result.classification).toBe("compatible")
    expect(result.assessment).toBe("pass")
    expect(result.differences).toContain("stdout differs")
  })

  test("line-ending differences remain explicit in classification", () => {
    const result = classifyScenario(
      "status",
      capture("Workspace: not initialized\r\n", [], 0, "crlf"),
      capture("Workspace: not initialized\n", [], 0, "lf"),
    )
    expect(result.differences).toContain("stdout line endings differ")
  })

  test("help surface change is explicit rather than hidden", () => {
    const result = classifyScenario(
      "help",
      capture("ralph - legacy help\n"),
      capture("ralph-next 0.1.0 - S01 help\n"),
    )
    expect(result.classification).toBe("changed")
    expect(result.assessment).toBe("pass")
    expect(result.differences).toEqual(["stdout differs"])
  })

  test("next-only mode records regression assessment without inventing a classification", () => {
    const result = classifyScenario("version", null, capture("", [], 1, "none", false))
    expect(result.classification).toBeNull()
    expect(result.assessment).toBe("regression")
    expect(result.notComparedReason).toBe("legacy-disabled")
  })

  test("failed evidence does not overwrite the documented compatibility decision", () => {
    const result = classifyScenario(
      "help",
      capture("ralph - legacy help\n"),
      capture("broken\n", [], 0, "lf", false),
    )
    expect(result.classification).toBe("changed")
    expect(result.assessment).toBe("regression")
    expect(result.rationale).toContain("fixture.invariant")
  })
})

describe("compatibility options", () => {
  test("supports an explicit next-only non-writing CI mode", () => {
    const options = parseHarnessOptions(
      ["--without-legacy", "--next-source", "--no-write", "--json"],
      "C:\\repo",
    )
    expect(options).toMatchObject({
      withoutLegacy: true,
      nextSource: true,
      writeReports: false,
      printJson: true,
    })
  })

  test("rejects contradictory legacy selection", () => {
    expect(() => parseHarnessOptions(["--without-legacy", "--legacy-binary", "ralph"])).toThrow(
      "cannot be combined",
    )
  })

  test("source entry cannot produce versioned reports", () => {
    expect(() => parseHarnessOptions(["--next-source"], "C:\\repo")).toThrow("requires --no-write")
  })

  test("next-only mode cannot replace the versioned compatibility baseline", () => {
    expect(() => parseHarnessOptions(["--without-legacy"], "C:\\repo")).toThrow(
      "requires --no-write",
    )
  })
})
