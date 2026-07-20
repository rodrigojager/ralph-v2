import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "../..")
const cleanupRoots: string[] = []
const classifierEntry = resolve(projectRoot, "scripts", "ci", "classify-junit.ts")

const passFixture = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" failures="0" errors="0" skipped="0">
  <testsuite name="tests/unit/pass.test.ts" file="tests/unit/pass.test.ts" tests="1" failures="0" errors="0" skipped="0">
    <testsuite name="pass suite" file="tests/unit/pass.test.ts" tests="1" failures="0" errors="0" skipped="0">
      <testcase name="passes deterministically" classname="pass suite" file="tests/unit/pass.test.ts" />
    </testsuite>
  </testsuite>
</testsuites>`

const skipFixture = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" failures="0" errors="0" skipped="1">
  <testsuite name="tests/unit/skip.test.ts" file="tests/unit/skip.test.ts" tests="1" failures="0" errors="0" skipped="1">
    <testcase name="same visible name" classname="skip suite" file="tests/unit/skip.test.ts">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`

type CiOs = "windows" | "linux" | "macos"
type CiArchitecture = "x64" | "arm64"

interface FixtureWaiver {
  readonly kind: string
  readonly report: string
  readonly file: string
  readonly testName: string
  readonly os: CiOs
  readonly architecture: CiArchitecture
  readonly owner: string
  readonly rationale: string
  readonly approvalRef: string
  readonly expiresOn: string
}

interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly classification: Record<string, unknown> | null
}

function currentOs(): CiOs {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "macos"
  return "linux"
}

function currentArchitecture(): CiArchitecture {
  return process.arch === "arm64" ? "arm64" : "x64"
}

function waiver(overrides: Partial<FixtureWaiver> = {}): FixtureWaiver {
  return {
    kind: "fixture-kind",
    report: "fixture.xml",
    file: "tests/unit/skip.test.ts",
    testName: "same visible name",
    os: currentOs(),
    architecture: currentArchitecture(),
    owner: "@fixture-owner",
    rationale: "Fixture approval for a deliberately skipped black-box testcase.",
    approvalRef: "tests/unit/ci-junit-classifier.test.ts#fixture-approval",
    expiresOn: "2099-12-31",
    ...overrides,
  }
}

function portableProjectPath(path: string): string {
  return path.slice(projectRoot.length + 1).replaceAll("\\", "/")
}

async function runClassifier(options: {
  readonly reports: Readonly<Record<string, string>>
  readonly expected?: readonly string[]
  readonly waivers?: readonly FixtureWaiver[]
  readonly kind?: string
}): Promise<RunResult> {
  const root = resolve(projectRoot, "artifacts", "tests", `junit-classifier-${randomUUID()}`)
  cleanupRoots.push(root)
  const input = resolve(root, "junit")
  const output = resolve(root, "classification.json")
  const manifest = resolve(root, "waivers.json")
  await mkdir(input, { recursive: true })
  await Promise.all(
    Object.entries(options.reports).map(([name, source]) =>
      writeFile(resolve(input, name), source, "utf8"),
    ),
  )
  await writeFile(
    manifest,
    `${JSON.stringify({ schemaVersion: 2, waivers: options.waivers ?? [] }, null, 2)}\n`,
    "utf8",
  )
  const expected = options.expected ?? Object.keys(options.reports)
  const command = [
    process.execPath,
    "run",
    classifierEntry,
    "--kind",
    options.kind ?? "fixture-kind",
    "--input",
    portableProjectPath(input),
    "--output",
    portableProjectPath(output),
    "--waivers",
    portableProjectPath(manifest),
    "--expected-os",
    currentOs(),
    "--expected-arch",
    currentArchitecture(),
    ...expected.flatMap((report) => ["--expect", report]),
  ]
  const child = Bun.spawn(command, {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  let classification: Record<string, unknown> | null = null
  try {
    classification = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw error
  }
  return { exitCode, stdout, stderr, classification }
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("strict black-box JUnit classifier", () => {
  test("accepts a balanced nested report with an exact report set", async () => {
    const result = await runClassifier({ reports: { "fixture.xml": passFixture } })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.classification).toMatchObject({
      schemaVersion: 2,
      artifactClass: "ci-test-classification",
      status: "pass",
      kind: "fixture-kind",
      expectedReports: ["fixture.xml"],
      counts: {
        tests: 1,
        passed: 1,
        failed: 0,
        errors: 0,
        skipped: 0,
        waivedSkips: 0,
        unwaivedSkips: 0,
      },
    })
    expect(result.stdout).toContain('"status":"pass"')
  })

  test("accepts only the exact kind/report/file/name/platform waiver", async () => {
    const result = await runClassifier({
      reports: { "fixture.xml": skipFixture },
      waivers: [waiver()],
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.classification).toMatchObject({
      status: "pass-with-waivers",
      counts: { skipped: 1, waivedSkips: 1, unwaivedSkips: 0 },
      skipped: [
        {
          reportName: "fixture.xml",
          name: "same visible name",
          file: "tests/unit/skip.test.ts",
          disposition: "waived",
          waiver: {
            kind: "fixture-kind",
            report: "fixture.xml",
            approvalRef: "tests/unit/ci-junit-classifier.test.ts#fixture-approval",
          },
        },
      ],
      unusedWaivers: [],
      configurationIssues: [],
    })
  })

  test("fails an unwaived homonym and reports the mismatched waiver as relevant-unused", async () => {
    const result = await runClassifier({
      reports: { "fixture.xml": skipFixture },
      waivers: [waiver({ file: "tests/unit/a-different-file.test.ts" })],
    })

    expect(result.exitCode).toBe(1)
    expect(result.classification).toMatchObject({
      status: "fail",
      counts: { unwaivedSkips: 1 },
      skipped: [{ disposition: "missing-waiver", waiver: null }],
      unusedWaivers: [
        {
          report: "fixture.xml",
          file: "tests/unit/a-different-file.test.ts",
          testName: "same visible name",
        },
      ],
    })
    expect(
      ((result.classification?.configurationIssues ?? []) as string[]).some((issue) =>
        issue.startsWith("unused relevant waiver"),
      ),
    ).toBe(true)
  })

  test("fails a relevant waiver that no skipped testcase consumes", async () => {
    const result = await runClassifier({
      reports: { "fixture.xml": passFixture },
      waivers: [waiver({ file: "tests/unit/pass.test.ts", testName: "passes deterministically" })],
    })

    expect(result.exitCode).toBe(1)
    expect(result.classification).toMatchObject({
      status: "fail",
      counts: { skipped: 0, unwaivedSkips: 0 },
      unusedWaivers: [{ file: "tests/unit/pass.test.ts", testName: "passes deterministically" }],
    })
  })

  test("fails an expired waiver only when it is relevant to this exact context", async () => {
    const result = await runClassifier({
      reports: { "fixture.xml": skipFixture },
      waivers: [waiver({ expiresOn: "2000-01-01" })],
    })

    expect(result.exitCode).toBe(1)
    expect(result.classification).toMatchObject({
      status: "fail",
      counts: { skipped: 1, waivedSkips: 0, unwaivedSkips: 1 },
      skipped: [{ disposition: "expired-waiver" }],
      expiredWaivers: [{ report: "fixture.xml", expiresOn: "2000-01-01" }],
    })
    expect(
      ((result.classification?.configurationIssues ?? []) as string[]).some((issue) =>
        issue.startsWith("expired relevant waiver"),
      ),
    ).toBe(true)
  })

  test("ignores waivers from another job or platform without weakening this context", async () => {
    const otherOs: CiOs = currentOs() === "windows" ? "linux" : "windows"
    const result = await runClassifier({
      reports: { "fixture.xml": passFixture },
      waivers: [
        waiver({ kind: "another-kind", expiresOn: "2000-01-01" }),
        waiver({ os: otherOs, expiresOn: "2000-01-01" }),
      ],
    })

    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.classification).toMatchObject({
      status: "pass",
      waiverManifest: { entries: 2, relevantEntries: 0, ignoredEntries: 2 },
      unusedWaivers: [],
      expiredWaivers: [],
      configurationIssues: [],
    })
  })

  test("rejects truncated XML, a second root, and an unexpected XML report", async () => {
    const truncated = passFixture.replace("</testsuites>", "")
    const secondRoot = `${passFixture}\n${passFixture.replace(
      '<?xml version="1.0" encoding="UTF-8"?>',
      "",
    )}`
    const scenarios = [
      {
        reports: { "fixture.xml": truncated },
        expected: ["fixture.xml"],
        message: "unclosed element",
      },
      {
        reports: { "fixture.xml": secondRoot },
        expected: ["fixture.xml"],
        message: "second root element or trailing content",
      },
      {
        reports: { "fixture.xml": passFixture, "extra.xml": passFixture },
        expected: ["fixture.xml"],
        message: "does not exactly match --expect",
      },
    ] as const

    for (const scenario of scenarios) {
      const result = await runClassifier(scenario)
      expect(result.exitCode, scenario.message).not.toBe(0)
      expect(result.stderr, scenario.message).toContain(scenario.message)
      expect(result.classification, scenario.message).toBeNull()
    }
  }, 30_000)

  test("rejects malformed, count-inconsistent, unknown-status, and oversized reports", async () => {
    const malformed = passFixture.replace("</testsuites>", "</testsuitex>")
    const countMismatch = passFixture.replace(
      '<testsuite name="pass suite" file="tests/unit/pass.test.ts" tests="1"',
      '<testsuite name="pass suite" file="tests/unit/pass.test.ts" tests="2"',
    )
    const unknownStatus = passFixture.replace(
      'file="tests/unit/pass.test.ts" />',
      'file="tests/unit/pass.test.ts" status="mystery" />',
    )
    const oversized = `${passFixture}${" ".repeat(16 * 1024 * 1024)}`
    const scenarios = [
      { source: malformed, message: "unbalanced closing element" },
      { source: countMismatch, message: "inconsistent declared counts" },
      { source: unknownStatus, message: "unknown status" },
      { source: oversized, message: "exceeds the 16777216-byte report limit" },
    ] as const

    for (const scenario of scenarios) {
      const result = await runClassifier({ reports: { "fixture.xml": scenario.source } })
      expect(result.exitCode, scenario.message).not.toBe(0)
      expect(result.stderr, scenario.message).toContain(scenario.message)
      expect(result.classification, scenario.message).toBeNull()
    }
  }, 30_000)

  test("rejects DTD/entity declarations and unapproved status vocabulary", async () => {
    const dtd = passFixture.replace(
      "<testsuites",
      '<!DOCTYPE testsuites [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n<testsuites',
    )
    const result = await runClassifier({ reports: { "fixture.xml": dtd } })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("forbidden DTD or entity declaration")
    expect(result.classification).toBeNull()
  })

  test("rejects duplicate skipped identities and forbidden character data", async () => {
    const duplicateSkip = skipFixture
      .replaceAll('tests="1"', 'tests="2"')
      .replaceAll('skipped="1"', 'skipped="2"')
      .replace(
        "    </testcase>",
        `    </testcase>
    <testcase name="same visible name" classname="skip suite" file="tests/unit/skip.test.ts">
      <skipped />
    </testcase>`,
      )
    const forbiddenCharacterData = passFixture.replace(
      "      <testcase",
      "      ]]>\n      <testcase",
    )

    const duplicate = await runClassifier({
      reports: { "fixture.xml": duplicateSkip },
      waivers: [waiver()],
    })
    expect(duplicate.exitCode).not.toBe(0)
    expect(duplicate.stderr).toContain("Duplicate skipped testcase identity")

    const forbidden = await runClassifier({
      reports: { "fixture.xml": forbiddenCharacterData },
    })
    expect(forbidden.exitCode).not.toBe(0)
    expect(forbidden.stderr).toContain("forbidden ]]> character data")
  })
})
