import { createHash } from "node:crypto"
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BunProcessSupervisor, type ProcessSettlement } from "@ralph/supervisor"
import { sha256File } from "./build-artifact"
import {
  gitleaksTrackedSourceScanArguments,
  resolveGitleaksBinding,
  validateEmptyGitleaksReport,
  validateGitleaksVersionOutput,
} from "./gitleaks-binding"

const ROOT = resolve(import.meta.dir, "..")
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000
const TEST_TIMEOUT_MS = 30 * 60 * 1_000
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024
const RAW_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024
const MAX_JUNIT_BYTES = 16 * 1024 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const EXPECTED_BUN_VERSION = "1.3.14"
const EXPECTED_BUN_REVISION = "0d9b296af33f2b851fcbf4df3e9ec89751734ba4"
const LICENSE_TEST_FILES = [
  "tests/unit/s04-dependency-license.test.ts",
  "tests/unit/s06-tui-dependency-license.test.ts",
  "tests/unit/opencode-provenance.test.ts",
  "tests/unit/release-sbom-license-inventory.test.ts",
] as const

interface Options {
  readonly gitleaksBinary?: string
  readonly gitleaksSha256?: string
}

interface GateResult {
  readonly id: string
  readonly executableSha256: string
  readonly stdout: { readonly bytes: number; readonly sha256: string }
  readonly stderr: { readonly bytes: number; readonly sha256: string }
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function parseOptions(argv: readonly string[]): Options {
  let gitleaksBinary: string | undefined
  let gitleaksSha256: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--") continue
    if (flag === "--gitleaks-binary") {
      if (gitleaksBinary !== undefined) throw new Error(`${flag} may be provided only once`)
      gitleaksBinary = requiredValue(argv, index, flag)
    } else if (flag === "--gitleaks-sha256") {
      if (gitleaksSha256 !== undefined) throw new Error(`${flag} may be provided only once`)
      gitleaksSha256 = requiredValue(argv, index, flag).toLowerCase()
    } else {
      throw new Error(`Unknown release security argument: ${flag ?? "<missing>"}`)
    }
    index += 1
  }
  if (Boolean(gitleaksBinary) !== Boolean(gitleaksSha256)) {
    throw new Error("--gitleaks-binary and --gitleaks-sha256 must be supplied together")
  }
  if (gitleaksSha256 && !SHA256_PATTERN.test(gitleaksSha256)) {
    throw new Error("--gitleaks-sha256 must be 64 lowercase hexadecimal characters")
  }
  return {
    ...(gitleaksBinary ? { gitleaksBinary } : {}),
    ...(gitleaksSha256 ? { gitleaksSha256 } : {}),
  }
}

function safeEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    CI: "1",
    NO_COLOR: "1",
  }
  for (const name of [
    "PATH",
    "Path",
    "PATHEXT",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "TEMP",
    "TMP",
    "TMPDIR",
  ] as const) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

function outputDigest(value: string): { readonly bytes: number; readonly sha256: string } {
  const bytes = Buffer.from(value, "utf8")
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

function samePath(left: string, right: string): boolean {
  const comparable = (value: string) => {
    const absolute = resolve(value)
    return process.platform === "win32" ? absolute.toLocaleLowerCase("und") : absolute
  }
  return comparable(left) === comparable(right)
}

async function readStableBoundedFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const requested = resolve(path)
  const before = await lstat(requested)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > maximumBytes ||
    !samePath(await realpath(requested), requested)
  ) {
    throw new Error("JUnit output must be a bounded regular non-symlink file")
  }
  const bytes = await readFile(requested)
  const after = await lstat(requested)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    bytes.byteLength !== before.size
  ) {
    throw new Error("JUnit output changed while it was read")
  }
  return bytes
}

async function validateLicenseJUnit(path: string): Promise<{
  readonly bytes: number
  readonly sha256: string
  readonly tests: number
  readonly files: readonly string[]
}> {
  const bytes = await readStableBoundedFile(path, MAX_JUNIT_BYTES)
  const junit = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (/<!DOCTYPE|<!ENTITY|<!--|<!\[CDATA\[/iu.test(junit)) {
    throw new Error("License JUnit contains a forbidden XML declaration, comment or CDATA section")
  }
  if (/<(?:failure|error|skipped)\b/iu.test(junit)) {
    throw new Error("License/provenance tests contain a failure, error or skip")
  }
  const testcaseTags = [...junit.matchAll(/<testcase\b[^>]*>/gu)].map((match) => match[0])
  if (testcaseTags.length === 0) throw new Error("License/provenance tests executed zero testcases")
  const observedFiles = new Set<string>()
  for (const tag of testcaseTags) {
    const status = /\bstatus="([^"]+)"/u.exec(tag)?.[1]
    if (status && status !== "passed" && status !== "success") {
      throw new Error(`License/provenance testcase has a non-passing status: ${status}`)
    }
    const file = /\bfile="([^"]+)"/u.exec(tag)?.[1]
    if (!file) throw new Error("License/provenance testcase is missing its file identity")
    observedFiles.add(file.replaceAll("\\", "/").replace(/^\.\//u, ""))
  }
  for (const file of LICENSE_TEST_FILES) {
    if (!observedFiles.has(file)) {
      throw new Error(`License/provenance JUnit lacks a passed testcase from ${file}`)
    }
  }
  const unexpectedFiles = [...observedFiles].filter(
    (file) => !LICENSE_TEST_FILES.some((expected) => file === expected),
  )
  if (unexpectedFiles.length > 0) {
    throw new Error(
      `License/provenance JUnit contains unexpected test files: ${unexpectedFiles.join(", ")}`,
    )
  }
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    tests: testcaseTags.length,
    files: [...observedFiles].sort(),
  }
}

function gateFailure(id: string, settlement: ProcessSettlement): Error {
  const stdout = outputDigest(settlement.rawStdout)
  const stderr = outputDigest(settlement.rawStderr)
  const reason = settlement.timedOut
    ? "timed out"
    : settlement.cancelled
      ? "was cancelled"
      : settlement.error
        ? "could not be supervised"
        : settlement.outputTruncated || settlement.rawOutputTruncated
          ? "exceeded its bounded output"
          : `failed with exit ${String(settlement.exitCode)}`
  return new Error(
    `${id} ${reason} (stdout ${stdout.bytes} bytes sha256:${stdout.sha256}; ` +
      `stderr ${stderr.bytes} bytes sha256:${stderr.sha256})`,
  )
}

async function runGate(input: {
  readonly id: string
  readonly command: readonly [string, ...string[]]
  readonly timeoutMs?: number
}): Promise<{ readonly result: GateResult; readonly settlement: ProcessSettlement }> {
  const environment = safeEnvironment()
  const supervisor = new BunProcessSupervisor()
  const canonicalCwd = await realpath(ROOT)
  const executableSha256Before = await sha256File(input.command[0])
  const settlement = await supervisor.run({
    executable: input.command[0],
    args: input.command.slice(1),
    cwd: ROOT,
    environment,
    environmentAllowlist: Object.keys(environment),
    shell: false,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    gracePeriodMs: 5_000,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
    rawOutputLimitBytes: RAW_OUTPUT_LIMIT_BYTES,
    maxInputBytes: 1,
    secretValues: [],
    expectedExecutableSha256: executableSha256Before,
    expectedCanonicalCwd: canonicalCwd,
  })
  if (
    settlement.timedOut ||
    settlement.cancelled ||
    settlement.error ||
    settlement.exitCode !== 0 ||
    settlement.outputTruncated ||
    settlement.rawOutputTruncated
  ) {
    throw gateFailure(input.id, settlement)
  }
  const executableSha256 = await sha256File(input.command[0])
  if (executableSha256 !== executableSha256Before) {
    throw new Error(`${input.id} executable changed while the gate was running`)
  }
  return {
    result: {
      id: input.id,
      executableSha256,
      stdout: outputDigest(settlement.rawStdout),
      stderr: outputDigest(settlement.rawStderr),
    },
    settlement,
  }
}

function assertSameBinding(
  before: Awaited<ReturnType<typeof resolveGitleaksBinding>>,
  after: Awaited<ReturnType<typeof resolveGitleaksBinding>>,
): void {
  if (before.binary !== after.binary || before.sha256 !== after.sha256) {
    throw new Error("Gitleaks executable binding changed during the release security gates")
  }
  if (
    before.version !== after.version ||
    JSON.stringify(before.provenance) !== JSON.stringify(after.provenance)
  ) {
    throw new Error("Gitleaks provenance binding changed during the release security gates")
  }
}

async function main(): Promise<void> {
  if (Bun.version !== EXPECTED_BUN_VERSION || Bun.revision !== EXPECTED_BUN_REVISION) {
    throw new Error(
      `Release security gates require Bun ${EXPECTED_BUN_VERSION} (${EXPECTED_BUN_REVISION}); ` +
        `observed ${Bun.version} (${Bun.revision})`,
    )
  }
  const options = parseOptions(process.argv.slice(2))
  const bindingInput = {
    projectRoot: ROOT,
    ...(options.gitleaksBinary ? { explicitBinary: options.gitleaksBinary } : {}),
    ...(options.gitleaksSha256 ? { explicitSha256: options.gitleaksSha256 } : {}),
  }
  const binding = await resolveGitleaksBinding(bindingInput)
  const canonicalTemporaryRoot = await realpath(tmpdir())
  const temporaryRoot = await mkdtemp(join(canonicalTemporaryRoot, "ralph-v2-release-security-"))
  const gitleaksReportPath = resolve(temporaryRoot, "gitleaks-report.json")
  const licenseJunitPath = resolve(temporaryRoot, "license-provenance.xml")
  let summary: Record<string, unknown> | null = null
  try {
    const dependencyAudit = await runGate({
      id: "dependency-audit",
      command: [process.execPath, "audit", "--json"],
    })
    const auditValue = JSON.parse(dependencyAudit.settlement.rawStdout) as unknown
    if (
      !auditValue ||
      typeof auditValue !== "object" ||
      Array.isArray(auditValue) ||
      Object.keys(auditValue).length !== 0
    ) {
      throw new Error("Pinned Bun dependency audit success report must be exactly an empty object")
    }
    console.log("[pass] dependency-audit")

    const version = await runGate({
      id: "gitleaks-version",
      command: [binding.binary, "version"],
    })
    validateGitleaksVersionOutput(version.settlement.rawStdout)
    if (version.result.executableSha256 !== binding.sha256) {
      throw new Error("Gitleaks version probe executed a binary with the wrong SHA-256")
    }

    const scan = await runGate({
      id: "source-secret-scan",
      command: [binding.binary, ...gitleaksTrackedSourceScanArguments(gitleaksReportPath)],
    })
    if (scan.result.executableSha256 !== binding.sha256) {
      throw new Error("Gitleaks scan executed a binary with the wrong SHA-256")
    }
    const gitleaksReport = await validateEmptyGitleaksReport(gitleaksReportPath)
    const rebound = await resolveGitleaksBinding(bindingInput)
    assertSameBinding(binding, rebound)
    console.log("[pass] source-secret-scan")

    const licenses = await runGate({
      id: "license-and-provenance-tests",
      command: [
        process.execPath,
        "test",
        "--reporter=junit",
        `--reporter-outfile=${licenseJunitPath}`,
        ...LICENSE_TEST_FILES.map((file) => `./${file}`),
      ],
      timeoutMs: TEST_TIMEOUT_MS,
    })
    const licenseJunit = await validateLicenseJUnit(licenseJunitPath)
    console.log("[pass] license-and-provenance-tests")

    summary = {
      status: "pass",
      runtime: { bunVersion: Bun.version, bunRevision: Bun.revision },
      dependencyAudit: {
        ...dependencyAudit.result,
        reportSha256: dependencyAudit.result.stdout.sha256,
      },
      gitleaks: {
        binding: {
          sha256: binding.sha256,
          version: binding.version,
          provenance: binding.provenance,
        },
        version: version.result,
        scan: scan.result,
        report: {
          bytes: gitleaksReport.bytes,
          sha256: gitleaksReport.sha256,
          findings: gitleaksReport.findings,
        },
      },
      licenses: { ...licenses.result, junit: licenseJunit },
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: false })
  }
  if (!summary) throw new Error("Release security gates did not produce a success summary")
  process.stdout.write(`${JSON.stringify(summary)}\n`)
  console.log(
    "Release security gates passed (dependency audit, pinned source secret scan, " +
      "licenses, provenance and SBOM/inventory contracts).",
  )
}

await main()
