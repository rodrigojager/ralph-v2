import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises"
import { hostname, release as osRelease, version as osVersion } from "node:os"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"

interface Arguments {
  readonly kind: string
  readonly output: string
  readonly inputs: readonly string[]
  readonly expectedOs?: string
  readonly expectedArchitecture?: string
  readonly target?: string
  readonly runnerLabel?: string
}

interface EvidenceFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

interface CollectedEvidenceFile extends EvidenceFile {
  readonly jsonSnapshot?: Uint8Array
}

interface JsonEvidence {
  readonly path: string
  readonly value: unknown | null
  readonly parseError: string | null
}

interface CommandContract {
  readonly executable: string
  readonly arguments: readonly string[]
}

const REQUIRED_STEP_IDS: Readonly<Record<string, readonly string[]>> = {
  "quality-x64": [
    "install",
    "architecture",
    "documentation",
    "lint",
    "schemas",
    "typecheck",
    "tests",
    "classify",
    "build",
    "smoke",
    "whitespace",
  ],
  "native-platform": [
    "install",
    "architecture",
    "matrix-tests",
    "distribution",
    "classify",
    "build",
    "smoke",
    "whitespace",
  ],
  "security-gates": [
    "install",
    "secret-tool-install",
    "dependency-audit",
    "secret-scan",
    "license-provenance",
    "classify",
  ],
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const BUN_REVISION_PATTERN = /^[a-f0-9]{40}$/u
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
const MAX_JSON_SNAPSHOT_BYTES = 16 * 1024 * 1024
const EXPECTED_BUN_VERSION = "1.3.14"
const EXPECTED_BUN_REVISION = "0d9b296af33f2b851fcbf4df3e9ec89751734ba4"
const GITLEAKS_VERSION = "8.30.1"
const GITLEAKS_ARCHIVE_SHA256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
const GITLEAKS_LINUX_X64_BINARY_SHA256 =
  "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509"
const GITLEAKS_LINUX_X64_BINARY_BYTES = 21_958_840
const GITLEAKS_SOURCE =
  "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/" +
  "gitleaks_8.30.1_linux_x64.tar.gz"

const projectRoot = resolve(import.meta.dir, "../..")

function containsC0OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function parseArguments(argv: readonly string[]): Arguments {
  let kind: string | undefined
  let output: string | undefined
  let expectedOs: string | undefined
  let expectedArchitecture: string | undefined
  let target: string | undefined
  let runnerLabel: string | undefined
  const inputs: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--") continue
    const value = requiredValue(argv, index, flag ?? "<missing>")
    if (flag === "--kind") {
      if (kind !== undefined) throw new Error("--kind may be provided only once")
      kind = value
    } else if (flag === "--output") {
      if (output !== undefined) throw new Error("--output may be provided only once")
      output = value
    } else if (flag === "--input") {
      inputs.push(value)
    } else if (flag === "--expected-os") {
      if (expectedOs !== undefined) throw new Error("--expected-os may be provided only once")
      expectedOs = value
    } else if (flag === "--expected-arch") {
      if (expectedArchitecture !== undefined) {
        throw new Error("--expected-arch may be provided only once")
      }
      expectedArchitecture = value
    } else if (flag === "--target") {
      if (target !== undefined) throw new Error("--target may be provided only once")
      target = value
    } else if (flag === "--runner-label") {
      if (runnerLabel !== undefined) throw new Error("--runner-label may be provided only once")
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
        throw new Error("--runner-label must be a portable GitHub Actions runner label")
      }
      runnerLabel = value
    } else {
      throw new Error(`Unknown argument: ${flag ?? "<missing>"}`)
    }
    index += 1
  }

  if (!kind || !/^[a-z][a-z0-9-]*$/u.test(kind)) throw new Error("--kind is required")
  if (!output) throw new Error("--output is required")
  if (inputs.length === 0) throw new Error("At least one --input is required")
  if (new Set(inputs).size !== inputs.length) throw new Error("Evidence inputs must be unique")
  return {
    kind,
    output,
    inputs,
    ...(expectedOs ? { expectedOs } : {}),
    ...(expectedArchitecture ? { expectedArchitecture } : {}),
    ...(target ? { target } : {}),
    ...(runnerLabel ? { runnerLabel } : {}),
  }
}

function insideProject(path: string, label: string): string {
  const absolute = resolve(projectRoot, path)
  const projectRelative = relative(projectRoot, absolute)
  if (
    projectRelative === ".." ||
    projectRelative.startsWith(`..${sep}`) ||
    isAbsolute(projectRelative)
  ) {
    throw new Error(`${label} must remain inside the project: ${path}`)
  }
  return absolute
}

function portableProjectPath(path: string): string {
  const projectRelative = relative(projectRoot, path)
  if (projectRelative.length === 0) return "."
  const segments = projectRelative.split(sep)
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\") ||
        containsC0OrDeleteControl(segment),
    )
  ) {
    throw new Error(`Evidence path is not portable: ${JSON.stringify(projectRelative)}`)
  }
  return segments.join("/")
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"))
}

function normalizeOs(value: string): "windows" | "linux" | "macos" {
  const normalized = value.trim().toLowerCase()
  if (normalized === "win32" || normalized === "windows") return "windows"
  if (normalized === "linux") return "linux"
  if (normalized === "darwin" || normalized === "macos" || normalized === "mac") return "macos"
  throw new Error(`Unsupported operating system: ${value}`)
}

function normalizeArchitecture(value: string): "x64" | "arm64" {
  const normalized = value.trim().toLowerCase()
  if (normalized === "x64" || normalized === "amd64" || normalized === "x86_64") return "x64"
  if (normalized === "arm64" || normalized === "aarch64") return "arm64"
  throw new Error(`Unsupported architecture: ${value}`)
}

function nativeTarget(os: "windows" | "linux" | "macos", architecture: "x64" | "arm64"): string {
  if (os === "windows") {
    return architecture === "arm64" ? "bun-windows-arm64" : "bun-windows-x64-baseline"
  }
  if (os === "linux") {
    return architecture === "arm64" ? "bun-linux-arm64" : "bun-linux-x64-baseline"
  }
  return architecture === "arm64" ? "bun-darwin-arm64" : "bun-darwin-x64"
}

function missingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  )
}

async function hashFile(path: string): Promise<CollectedEvidenceFile> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Evidence input must be a regular non-symlink file: ${path}`)
  }
  const bytes = await readFile(path)
  const after = await lstat(path)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    bytes.byteLength !== after.size
  ) {
    throw new Error(`Evidence input changed while hashing: ${path}`)
  }
  return {
    path: portableProjectPath(path),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(path.toLowerCase().endsWith(".json") && bytes.byteLength <= MAX_JSON_SNAPSHOT_BYTES
      ? { jsonSnapshot: bytes }
      : {}),
  }
}

async function collectFiles(path: string): Promise<readonly CollectedEvidenceFile[]> {
  const information = await lstat(path)
  if (information.isSymbolicLink()) throw new Error(`Evidence input cannot be a symlink: ${path}`)
  if (information.isFile()) return [await hashFile(path)]
  if (!information.isDirectory()) throw new Error(`Unsupported evidence input type: ${path}`)
  const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) =>
    compareUtf8(left.name, right.name),
  )
  const files: CollectedEvidenceFile[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Evidence input cannot contain symlinks: ${resolve(path, entry.name)}`)
    }
    if (!entry.isFile() && !entry.isDirectory()) {
      throw new Error(`Unsupported evidence entry: ${resolve(path, entry.name)}`)
    }
    files.push(...(await collectFiles(resolve(path, entry.name))))
  }
  if (files.length === 0) throw new Error(`Evidence input directory is empty: ${path}`)
  return files
}

async function parseJsonEvidencePath(
  files: readonly CollectedEvidenceFile[],
  path: string,
): Promise<readonly JsonEvidence[]> {
  return parseSelectedJsonEvidence(files.filter((file) => file.path === path))
}

async function parseSelectedJsonEvidence(
  matches: readonly CollectedEvidenceFile[],
): Promise<readonly JsonEvidence[]> {
  const parsed: JsonEvidence[] = []
  for (const match of matches) {
    try {
      if (!match.jsonSnapshot) {
        throw new Error(`JSON evidence exceeds the ${MAX_JSON_SNAPSHOT_BYTES}-byte snapshot limit`)
      }
      parsed.push({
        path: match.path,
        value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(match.jsonSnapshot)),
        parseError: null,
      })
    } catch (error) {
      parsed.push({
        path: match.path,
        value: null,
        parseError: error instanceof Error ? error.message : "unknown JSON parse error",
      })
    }
  }
  return parsed
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function validIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_PATTERN.test(value)) return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function validReceiptTiming(startedAt: unknown, finishedAt: unknown): boolean {
  return (
    validIsoInstant(startedAt) &&
    validIsoInstant(finishedAt) &&
    Date.parse(startedAt) <= Date.parse(finishedAt)
  )
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  )
}

function expectedReportNames(kind: string): readonly string[] {
  if (kind === "quality-x64") return ["quality.xml"]
  if (kind === "native-platform") {
    return ["native-platform.xml", "s12-distribution.xml"]
  }
  if (kind === "security-gates") return ["license-provenance.xml"]
  return []
}

function validateStreamDigest(value: unknown): boolean {
  const record = recordValue(value)
  return (
    record !== null &&
    Number.isSafeInteger(record.bytes) &&
    (record.bytes as number) >= 0 &&
    typeof record.sha256 === "string" &&
    SHA256_PATTERN.test(record.sha256)
  )
}

function runnerLabelOs(os: "windows" | "linux" | "macos"): string {
  return process.env.RUNNER_OS ?? (os === "macos" ? "macOS" : os[0]?.toUpperCase() + os.slice(1))
}

function runnerLabelArchitecture(architecture: "x64" | "arm64"): string {
  return process.env.RUNNER_ARCH ?? architecture.toUpperCase()
}

function commandContracts(
  kind: string,
  os: "windows" | "linux" | "macos",
  architecture: "x64" | "arm64",
  target: string,
): Readonly<Record<string, CommandContract>> {
  const classifierBase = ["run", "ci:junit:classify"]
  if (kind === "quality-x64") {
    return {
      install: { executable: "bun", arguments: ["install", "--frozen-lockfile"] },
      architecture: {
        executable: "bun",
        arguments: ["run", "scripts/ci/assert-architecture.ts", "--expected", "x64"],
      },
      documentation: { executable: "bun", arguments: ["run", "docs:check"] },
      lint: { executable: "bun", arguments: ["run", "lint"] },
      schemas: { executable: "bun", arguments: ["run", "schemas:check"] },
      typecheck: { executable: "bun", arguments: ["run", "typecheck"] },
      tests: {
        executable: "bun",
        arguments: [
          "test",
          "--reporter=junit",
          "--reporter-outfile=artifacts/ci/junit/quality.xml",
        ],
      },
      classify: {
        executable: "bun",
        arguments: [
          ...classifierBase,
          "--kind",
          "quality-x64",
          "--input",
          "artifacts/ci/junit",
          "--expect",
          "quality.xml",
          "--waivers",
          ".github/ci/junit-skip-waivers.json",
          "--output",
          "artifacts/ci/test-classification.json",
          "--expected-os",
          runnerLabelOs(os),
          "--expected-arch",
          "x64",
        ],
      },
      build: { executable: "bun", arguments: ["run", "build"] },
      smoke: { executable: "bun", arguments: ["run", "smoke"] },
      whitespace: {
        executable: "bun",
        arguments: ["run", "scripts/ci/check-whitespace.ts"],
      },
    }
  }
  if (kind === "native-platform") {
    const binary = `dist/standalone/${target}/ralph-next${os === "windows" ? ".exe" : ""}`
    return {
      install: { executable: "bun", arguments: ["install", "--frozen-lockfile"] },
      architecture: {
        executable: "bun",
        arguments: ["run", "scripts/ci/assert-architecture.ts", "--expected", architecture],
      },
      "matrix-tests": {
        executable: "bun",
        arguments: [
          "test",
          "--reporter=junit",
          "--reporter-outfile=artifacts/ci/junit/native-platform.xml",
          "./tests/integration/workspace.test.ts",
          "./packages/supervisor/tests/supervisor.test.ts",
          "./tests/integration/s07-two-phase-shutdown.test.ts",
          "./packages/credentials/tests/os-keychain-secret-store.test.ts",
          "./tests/integration/s09-bounded-e2e.test.ts",
          "./tests/hardening/pty.test.ts",
        ],
      },
      distribution: {
        executable: "bun",
        arguments: [
          "test",
          "--reporter=junit",
          "--reporter-outfile=artifacts/ci/junit/s12-distribution.xml",
          "./packages/distribution/tests/standalone-lifecycle.test.ts",
        ],
      },
      classify: {
        executable: "bun",
        arguments: [
          ...classifierBase,
          "--kind",
          "native-platform",
          "--input",
          "artifacts/ci/junit",
          "--expect",
          "native-platform.xml",
          "--expect",
          "s12-distribution.xml",
          "--waivers",
          ".github/ci/junit-skip-waivers.json",
          "--output",
          "artifacts/ci/test-classification.json",
          "--expected-os",
          os,
          "--expected-arch",
          architecture,
        ],
      },
      build: { executable: "bun", arguments: ["run", "build", "--target", target] },
      smoke: {
        executable: "bun",
        arguments: ["run", "smoke", "--binary", binary],
      },
      whitespace: {
        executable: "bun",
        arguments: ["run", "scripts/ci/check-whitespace.ts"],
      },
    }
  }
  if (kind === "security-gates") {
    return {
      install: { executable: "bun", arguments: ["install", "--frozen-lockfile"] },
      "secret-tool-install": {
        executable: "bash",
        arguments: ["scripts/ci/install-gitleaks.sh"],
      },
      "dependency-audit": {
        executable: "bun",
        arguments: [
          "run",
          "scripts/ci/dependency-audit.ts",
          "--output",
          "artifacts/ci/dependency-audit.json",
        ],
      },
      "secret-scan": {
        executable: "./artifacts/ci/tooling/bin/gitleaks",
        arguments: [
          "git",
          ".",
          "--no-banner",
          "--no-color",
          "--redact=100",
          "--report-format",
          "json",
          "--report-path",
          "artifacts/ci/gitleaks-report.json",
        ],
      },
      "license-provenance": {
        executable: "bun",
        arguments: [
          "test",
          "--reporter=junit",
          "--reporter-outfile=artifacts/ci/junit/license-provenance.xml",
          "./tests/unit/s04-dependency-license.test.ts",
          "./tests/unit/s06-tui-dependency-license.test.ts",
          "./tests/unit/opencode-provenance.test.ts",
          "./tests/unit/release-sbom-license-inventory.test.ts",
        ],
      },
      classify: {
        executable: "bun",
        arguments: [
          ...classifierBase,
          "--kind",
          "security-gates",
          "--input",
          "artifacts/ci/junit",
          "--expect",
          "license-provenance.xml",
          "--waivers",
          ".github/ci/junit-skip-waivers.json",
          "--output",
          "artifacts/ci/test-classification.json",
          "--expected-os",
          runnerLabelOs(os),
          "--expected-arch",
          runnerLabelArchitecture(architecture),
        ],
      },
    }
  }
  return {}
}

function sameArguments(left: readonly unknown[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((argument, index) => argument === right[index])
}

async function resolvedExecutableName(requested: string): Promise<string | null> {
  const pathLike = isAbsolute(requested) || requested.includes("/") || requested.includes("\\")
  const located = pathLike ? resolve(projectRoot, requested) : Bun.which(requested)
  if (!located) return null
  try {
    return basename(await realpath(located))
  } catch (error) {
    if (missingError(error)) return null
    throw error
  }
}

async function validateStepReceipts(
  kind: string,
  receipts: readonly JsonEvidence[],
  os: "windows" | "linux" | "macos",
  architecture: "x64" | "arm64",
  target: string,
  issues: string[],
): Promise<ReadonlyMap<string, JsonEvidence>> {
  const required = REQUIRED_STEP_IDS[kind]
  if (!required) {
    issues.push(`unsupported CI evidence kind: ${kind}`)
    return new Map()
  }
  const observed = new Map<string, JsonEvidence>()
  const contracts = commandContracts(kind, os, architecture, target)
  const executableNames = new Map<string, string | null>()
  for (const contract of Object.values(contracts)) {
    if (!executableNames.has(contract.executable)) {
      executableNames.set(contract.executable, await resolvedExecutableName(contract.executable))
    }
  }
  const executableIdentities = new Map<
    string,
    { readonly bytes: number; readonly sha256: string }
  >()
  for (const receipt of receipts) {
    if (receipt.parseError) {
      issues.push(`CI step receipt is invalid JSON: ${receipt.path}: ${receipt.parseError}`)
      continue
    }
    const value = recordValue(receipt.value)
    const id = value?.id
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(id)) {
      issues.push(`CI step receipt has an invalid id: ${receipt.path}`)
      continue
    }
    if (observed.has(id)) {
      issues.push(`duplicate CI step receipt id: ${id}`)
      continue
    }
    observed.set(id, receipt)
    if (receipt.path !== `artifacts/ci/steps/${id}.json`) {
      issues.push(`CI step receipt path does not match its id: ${receipt.path}`)
    }
    const runtime = recordValue(value?.runtime)
    const command = recordValue(value?.command)
    const contract = contracts[id]
    if (
      value?.schemaVersion !== 2 ||
      value?.artifactClass !== "ci-step-receipt" ||
      value?.status !== "pass" ||
      value?.exitCode !== 0 ||
      value?.spawnError !== null ||
      value?.workingDirectory !== "." ||
      !validReceiptTiming(value?.startedAt, value?.finishedAt) ||
      typeof value?.durationMilliseconds !== "number" ||
      value.durationMilliseconds < 0 ||
      !validateStreamDigest(value?.stdout) ||
      !validateStreamDigest(value?.stderr) ||
      runtime?.bunVersion !== Bun.version ||
      runtime?.bunRevision !== Bun.revision ||
      runtime?.os !== process.platform ||
      runtime?.architecture !== process.arch ||
      typeof command?.requestedExecutable !== "string" ||
      command.requestedExecutable.length === 0 ||
      typeof command?.executable !== "string" ||
      command.executable.length === 0 ||
      !nonNegativeInteger(command?.bytes) ||
      command.bytes === 0 ||
      typeof command?.sha256 !== "string" ||
      !SHA256_PATTERN.test(command.sha256) ||
      !Array.isArray(command.arguments) ||
      !command.arguments.every((argument) => typeof argument === "string")
    ) {
      issues.push(`CI step receipt is not a passing bound schema-v2 result: ${receipt.path}`)
    } else if (
      !contract ||
      command.requestedExecutable !== contract.executable ||
      !sameArguments(command.arguments, contract.arguments)
    ) {
      issues.push(`CI step receipt command does not match the ${kind}/${id} contract`)
    } else if (command.executable !== executableNames.get(contract.executable)) {
      issues.push(`CI step receipt executable does not match the resolved ${kind}/${id} command`)
    } else {
      const previous = executableIdentities.get(contract.executable)
      if (previous && (previous.bytes !== command.bytes || previous.sha256 !== command.sha256)) {
        issues.push(
          `CI executable identity changed between ${kind} step receipts: ${contract.executable}`,
        )
      } else {
        executableIdentities.set(contract.executable, {
          bytes: command.bytes,
          sha256: command.sha256,
        })
      }
    }
  }

  const requiredSet = new Set(required)
  const missing = required.filter((id) => !observed.has(id))
  const extra = [...observed.keys()].filter((id) => !requiredSet.has(id)).sort()
  if (missing.length > 0) issues.push(`missing CI step receipts: ${missing.join(", ")}`)
  if (extra.length > 0) issues.push(`unexpected CI step receipts: ${extra.join(", ")}`)
  return observed
}

function validateBuildMetadata(
  evidence: JsonEvidence,
  expected: {
    readonly kind: "bundle" | "standalone"
    readonly target: string
    readonly artifact: string
    readonly version: string | null
  },
  filesByPath: ReadonlyMap<string, EvidenceFile>,
  issues: string[],
): string | null {
  if (evidence.parseError) {
    issues.push(
      `${expected.kind} metadata is invalid JSON: ${evidence.path}: ${evidence.parseError}`,
    )
    return null
  }
  const value = recordValue(evidence.value)
  const artifact = value?.artifact
  const declaredSha256 = value?.sha256
  const sourceSha256 = value?.sourceSha256
  const artifactEvidence =
    typeof artifact === "string" ? filesByPath.get(artifact.replaceAll("\\", "/")) : undefined
  const valid =
    value?.schemaVersion === 1 &&
    value?.status === "built-not-tested" &&
    value?.target === expected.target &&
    value?.version === expected.version &&
    value?.bunVersion === Bun.version &&
    typeof value?.bunRevision === "string" &&
    BUN_REVISION_PATTERN.test(value.bunRevision) &&
    value?.bunRevision === Bun.revision &&
    typeof value?.builtAt === "string" &&
    validIsoInstant(value.builtAt) &&
    artifact === expected.artifact &&
    typeof declaredSha256 === "string" &&
    SHA256_PATTERN.test(declaredSha256) &&
    typeof sourceSha256 === "string" &&
    SHA256_PATTERN.test(sourceSha256) &&
    artifactEvidence?.sha256 === declaredSha256
  if (expected.kind === "bundle" && value?.product !== "ralph-next-bundle") {
    issues.push(`bundle metadata has an unexpected product: ${evidence.path}`)
  }
  if (!valid) {
    issues.push(
      `${expected.kind} metadata does not bind runtime/version/target/artifact/hash: ` +
        evidence.path,
    )
    return null
  }
  return sourceSha256
}

function validateSecurityReports(
  audit: readonly JsonEvidence[],
  gitleaks: readonly JsonEvidence[],
  issues: string[],
): void {
  if (audit.length !== 1) {
    issues.push(`expected exactly one dependency-audit.json, found ${audit.length}`)
  }
  for (const report of audit) {
    const value = recordValue(report.value)
    if (report.parseError || !value || Object.keys(value).length !== 0) {
      issues.push(`dependency audit is not the pinned Bun empty-object result: ${report.path}`)
    }
  }
  if (gitleaks.length !== 1) {
    issues.push(`expected exactly one gitleaks-report.json, found ${gitleaks.length}`)
  }
  for (const report of gitleaks) {
    if (report.parseError || !Array.isArray(report.value) || report.value.length !== 0) {
      issues.push(`Gitleaks report is not an empty findings array: ${report.path}`)
    }
  }
}

function validateGitleaksInstall(
  installs: readonly JsonEvidence[],
  filesByPath: ReadonlyMap<string, EvidenceFile>,
  issues: string[],
): void {
  if (installs.length !== 1) {
    issues.push(`expected exactly one gitleaks-install.json, found ${installs.length}`)
  }
  for (const install of installs) {
    if (install.parseError) {
      issues.push(
        `Gitleaks install receipt is invalid JSON: ${install.path}: ${install.parseError}`,
      )
      continue
    }
    const value = recordValue(install.value)
    const binaryPath = value?.binaryPath
    const binaryBytes = value?.binaryBytes
    const binarySha256 = value?.binarySha256
    const binaryEvidence = typeof binaryPath === "string" ? filesByPath.get(binaryPath) : undefined
    if (
      value?.schemaVersion !== 1 ||
      value?.artifactClass !== "pinned-ci-tool-install" ||
      value?.tool !== "gitleaks" ||
      value?.version !== GITLEAKS_VERSION ||
      value?.source !== GITLEAKS_SOURCE ||
      value?.archiveSha256 !== GITLEAKS_ARCHIVE_SHA256 ||
      binaryPath !== "artifacts/ci/tooling/bin/gitleaks" ||
      binaryBytes !== GITLEAKS_LINUX_X64_BINARY_BYTES ||
      binarySha256 !== GITLEAKS_LINUX_X64_BINARY_SHA256 ||
      value?.reportedVersion !== GITLEAKS_VERSION ||
      binaryEvidence?.bytes !== binaryBytes ||
      binaryEvidence?.sha256 !== binarySha256
    ) {
      issues.push(
        `Gitleaks install receipt does not match the pinned tool contract: ${install.path}`,
      )
    }
  }
}

const options = parseArguments(process.argv.slice(2))
const output = insideProject(options.output, "Evidence output")
const inputPaths = options.inputs.map((input) => insideProject(input, "Evidence input"))
for (const input of inputPaths) {
  const outputRelative = relative(input, output)
  if (
    output === input ||
    (outputRelative !== ".." &&
      !outputRelative.startsWith(`..${sep}`) &&
      !isAbsolute(outputRelative))
  ) {
    throw new Error(
      `Evidence output cannot be inside an evidence input: ${portableProjectPath(input)}`,
    )
  }
}

const os = normalizeOs(process.platform)
const architecture = normalizeArchitecture(process.arch)
const issues: string[] = []
if (Bun.version !== EXPECTED_BUN_VERSION || Bun.revision !== EXPECTED_BUN_REVISION) {
  issues.push(
    `CI requires Bun ${EXPECTED_BUN_VERSION} (${EXPECTED_BUN_REVISION}), ` +
      `observed ${Bun.version} (${Bun.revision})`,
  )
}
if (!options.expectedOs) issues.push("--expected-os is required for runner-bound CI evidence")
if (!options.expectedArchitecture) {
  issues.push("--expected-arch is required for runner-bound CI evidence")
}
if (!options.runnerLabel) issues.push("--runner-label is required for runner-bound CI evidence")
if (options.kind === "native-platform" && !options.target) {
  issues.push("--target is required for native-platform CI evidence")
}
if (options.kind !== "native-platform" && options.target) {
  issues.push(`--target is unexpected for ${options.kind} CI evidence`)
}
if (options.expectedOs && normalizeOs(options.expectedOs) !== os) {
  issues.push(`runner OS ${os} does not match expected OS ${options.expectedOs}`)
}
if (
  options.expectedArchitecture &&
  normalizeArchitecture(options.expectedArchitecture) !== architecture
) {
  issues.push(
    `runner architecture ${architecture} does not match expected architecture ${
      options.expectedArchitecture
    }`,
  )
}
if (options.kind === "quality-x64" && architecture !== "x64") {
  issues.push(`quality-x64 requires x64, observed ${architecture}`)
}
if (options.kind === "security-gates" && (os !== "linux" || architecture !== "x64")) {
  issues.push(`security-gates requires linux/x64, observed ${os}/${architecture}`)
}
const actualTarget = nativeTarget(os, architecture)
if (options.target && options.target !== actualTarget) {
  issues.push(`native target ${actualTarget} does not match expected target ${options.target}`)
}

const missingInputs: string[] = []
const collected: CollectedEvidenceFile[] = []
for (const input of inputPaths) {
  try {
    collected.push(...(await collectFiles(input)))
  } catch (error) {
    if (!missingError(error)) throw error
    missingInputs.push(portableProjectPath(input))
  }
}
const duplicateFiles = new Set<string>()
const seenFiles = new Set<string>()
for (const file of collected) {
  if (seenFiles.has(file.path)) duplicateFiles.add(file.path)
  seenFiles.add(file.path)
}
if (duplicateFiles.size > 0) {
  issues.push(`duplicate evidence files: ${[...duplicateFiles].sort().join(", ")}`)
}
if (missingInputs.length > 0) {
  issues.push(`missing evidence inputs: ${missingInputs.join(", ")}`)
}
const snapshotFiles = [...new Map(collected.map((file) => [file.path, file])).values()].sort(
  (left, right) => compareUtf8(left.path, right.path),
)
const files: EvidenceFile[] = snapshotFiles.map((file) => ({
  path: file.path,
  bytes: file.bytes,
  sha256: file.sha256,
}))
const filesByPath = new Map(files.map((file) => [file.path, file]))
const packageManifest = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8"),
) as {
  readonly name?: unknown
  readonly packageManager?: unknown
  readonly version?: unknown
}
const packageVersion = typeof packageManifest.version === "string" ? packageManifest.version : null
if (packageManifest.name !== "ralph-v2") {
  issues.push("package.json name must remain ralph-v2 for CI evidence")
}
if (packageManifest.packageManager !== `bun@${EXPECTED_BUN_VERSION}`) {
  issues.push(`package.json packageManager must remain bun@${EXPECTED_BUN_VERSION}`)
}
if (
  typeof packageManifest.version !== "string" ||
  packageManifest.version.length === 0 ||
  packageManifest.version.length > 128 ||
  containsC0OrDeleteControl(packageManifest.version)
) {
  issues.push("package.json version must be a non-empty bounded control-safe string")
}

const classifications = await parseJsonEvidencePath(
  snapshotFiles,
  "artifacts/ci/test-classification.json",
)
if (classifications.length !== 1) {
  issues.push(`expected exactly one test-classification.json, found ${classifications.length}`)
}
for (const classification of classifications) {
  if (classification.parseError) {
    issues.push(
      `test classification is invalid JSON: ${classification.path}: ${classification.parseError}`,
    )
    continue
  }
  const value = recordValue(classification.value)
  const runner = recordValue(value?.runner)
  const policy = recordValue(value?.policy)
  const counts = recordValue(value?.counts)
  const expectedReports = expectedReportNames(options.kind)
  const passed = counts?.passed
  const failed = counts?.failed
  const errors = counts?.errors
  const skipped = counts?.skipped
  const waivedSkips = counts?.waivedSkips
  const unwaivedSkips = counts?.unwaivedSkips
  const tests = counts?.tests
  const expectedStatus =
    nonNegativeInteger(waivedSkips) && waivedSkips > 0 ? "pass-with-waivers" : "pass"
  if (
    !value ||
    value.schemaVersion !== 2 ||
    value.artifactClass !== "ci-test-classification" ||
    value.status !== expectedStatus ||
    value.kind !== options.kind ||
    !validIsoInstant(value.generatedAt) ||
    runner?.os !== os ||
    runner?.architecture !== architecture ||
    policy?.skippedTestsCountAsPassed !== false ||
    policy?.unwaivedSkipFailsGate !== true ||
    policy?.relevantUnusedWaiverFailsGate !== true ||
    policy?.waiverScope !== "kind-report-file-test-name-os-architecture" ||
    policy?.expiryDateInclusive !== true ||
    policy?.exactExpectedReportSet !== true ||
    policy?.strictBoundedXml !== true ||
    !sameStrings(value.expectedReports, expectedReports) ||
    !nonNegativeInteger(tests) ||
    !nonNegativeInteger(passed) ||
    !nonNegativeInteger(failed) ||
    !nonNegativeInteger(errors) ||
    !nonNegativeInteger(skipped) ||
    !nonNegativeInteger(waivedSkips) ||
    !nonNegativeInteger(unwaivedSkips) ||
    tests === 0 ||
    tests !== passed + failed + errors + skipped ||
    failed !== 0 ||
    errors !== 0 ||
    unwaivedSkips !== 0 ||
    waivedSkips !== skipped ||
    !Array.isArray(value.configurationIssues) ||
    value.configurationIssues.length !== 0 ||
    !Array.isArray(value.unusedWaivers) ||
    value.unusedWaivers.length !== 0 ||
    !Array.isArray(value.expiredWaivers) ||
    value.expiredWaivers.length !== 0 ||
    !Array.isArray(value.skipped) ||
    value.skipped.length !== skipped
  ) {
    issues.push(`test classification is not a passing runner-bound result: ${classification.path}`)
  }
  const reports = Array.isArray(value?.reports) ? value.reports : []
  if (reports.length !== expectedReports.length) {
    issues.push(`test classification report count is invalid: ${classification.path}`)
  }
  for (const [index, rawReport] of reports.entries()) {
    const report = recordValue(rawReport)
    const expectedName = expectedReports[index]
    const reportPath = report?.path
    const evidence = typeof reportPath === "string" ? filesByPath.get(reportPath) : undefined
    if (
      report?.name !== expectedName ||
      reportPath !== `artifacts/ci/junit/${expectedName}` ||
      !nonNegativeInteger(report?.bytes) ||
      typeof report?.sha256 !== "string" ||
      !SHA256_PATTERN.test(report.sha256) ||
      evidence?.bytes !== report.bytes ||
      evidence?.sha256 !== report.sha256
    ) {
      issues.push(`test classification report is not content-bound: ${expectedName ?? index}`)
    }
  }
  const waiverManifest = recordValue(value?.waiverManifest)
  const waiverEvidence = filesByPath.get(".github/ci/junit-skip-waivers.json")
  if (
    waiverManifest?.schemaVersion !== 2 ||
    waiverManifest?.path !== ".github/ci/junit-skip-waivers.json" ||
    !nonNegativeInteger(waiverManifest?.bytes) ||
    typeof waiverManifest?.sha256 !== "string" ||
    !SHA256_PATTERN.test(waiverManifest.sha256) ||
    waiverEvidence?.bytes !== waiverManifest.bytes ||
    waiverEvidence?.sha256 !== waiverManifest.sha256
  ) {
    issues.push(`test classification waiver manifest is not content-bound: ${classification.path}`)
  }
}

const evidenceContracts = await parseJsonEvidencePath(
  snapshotFiles,
  "artifacts/ci/evidence-contract.json",
)
if (evidenceContracts.length !== 1) {
  issues.push(`expected exactly one evidence-contract.json, found ${evidenceContracts.length}`)
}
for (const contract of evidenceContracts) {
  const value = recordValue(contract.value)
  if (
    contract.parseError ||
    !value ||
    value.schemaVersion !== 1 ||
    value.artifactClass !== "ci-validation-only" ||
    value.releaseEligible !== false ||
    value.packageEligible !== false ||
    !validIsoInstant(value.startedAt)
  ) {
    issues.push(`CI evidence contract is invalid or overclaims eligibility: ${contract.path}`)
  }
}

const stepReceipts = await parseSelectedJsonEvidence(
  snapshotFiles.filter(
    (file) =>
      file.path.startsWith("artifacts/ci/steps/") && file.path.toLowerCase().endsWith(".json"),
  ),
)
const receiptsById = await validateStepReceipts(
  options.kind,
  stepReceipts,
  os,
  architecture,
  actualTarget,
  issues,
)

const dependencyAudits = await parseJsonEvidencePath(
  snapshotFiles,
  "artifacts/ci/dependency-audit.json",
)
const gitleaksReports = await parseJsonEvidencePath(
  snapshotFiles,
  "artifacts/ci/gitleaks-report.json",
)
const gitleaksInstalls = await parseJsonEvidencePath(
  snapshotFiles,
  "artifacts/ci/tooling/gitleaks-install.json",
)
if (options.kind === "security-gates") {
  validateSecurityReports(dependencyAudits, gitleaksReports, issues)
  validateGitleaksInstall(gitleaksInstalls, filesByPath, issues)
  const install = recordValue(gitleaksInstalls[0]?.value)
  const scanReceipt = recordValue(receiptsById.get("secret-scan")?.value)
  const scanCommand = recordValue(scanReceipt?.command)
  const installedBinarySha256 = install?.binarySha256
  const installedBinaryBytes = install?.binaryBytes
  if (
    typeof installedBinarySha256 !== "string" ||
    !nonNegativeInteger(installedBinaryBytes) ||
    scanCommand?.sha256 !== installedBinarySha256 ||
    scanCommand?.bytes !== installedBinaryBytes
  ) {
    issues.push("executed Gitleaks binary hash does not match its pinned install receipt")
  }
} else if (
  dependencyAudits.length > 0 ||
  gitleaksReports.length > 0 ||
  gitleaksInstalls.length > 0
) {
  issues.push("security reports are unexpected outside the security-gates evidence kind")
}

const bundleMetadata = await parseJsonEvidencePath(snapshotFiles, "dist/bundle-build-metadata.json")
const standaloneMetadata = await parseJsonEvidencePath(
  snapshotFiles,
  `dist/standalone/${actualTarget}/build-metadata.json`,
)
if (options.kind !== "security-gates") {
  if (bundleMetadata.length !== 1) {
    issues.push(`expected exactly one bundle-build-metadata.json, found ${bundleMetadata.length}`)
  }
  if (standaloneMetadata.length !== 1) {
    issues.push(
      `expected exactly one standalone build-metadata.json, found ${standaloneMetadata.length}`,
    )
  }
}
let bundleSourceSha256: string | null = null
let standaloneSourceSha256: string | null = null
for (const metadata of bundleMetadata) {
  bundleSourceSha256 = validateBuildMetadata(
    metadata,
    {
      kind: "bundle",
      target: "bun",
      artifact: "dist/ralph-next.js",
      version: packageVersion,
    },
    filesByPath,
    issues,
  )
}
const standaloneArtifact = `dist/standalone/${actualTarget}/ralph-next${
  os === "windows" ? ".exe" : ""
}`
for (const metadata of standaloneMetadata) {
  standaloneSourceSha256 = validateBuildMetadata(
    metadata,
    {
      kind: "standalone",
      target: actualTarget,
      artifact: standaloneArtifact,
      version: packageVersion,
    },
    filesByPath,
    issues,
  )
}
if (
  options.kind !== "security-gates" &&
  bundleSourceSha256 &&
  standaloneSourceSha256 &&
  bundleSourceSha256 !== standaloneSourceSha256
) {
  issues.push("bundle and standalone metadata disagree on the source fingerprint")
}
const complete = issues.length === 0
const evidence = {
  schemaVersion: 1,
  artifactClass: "ci-validation-evidence",
  kind: options.kind,
  status: complete ? "complete" : "incomplete-or-failed",
  releaseEligible: false,
  packageEligible: false,
  generatedAt: new Date().toISOString(),
  project: {
    name: typeof packageManifest.name === "string" ? packageManifest.name : null,
    version: typeof packageManifest.version === "string" ? packageManifest.version : null,
  },
  runner: {
    os,
    architecture,
    nativeTarget: actualTarget,
    requestedLabel: options.runnerLabel ?? null,
    hostname: hostname(),
    osRelease: osRelease(),
    osVersion: osVersion(),
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerArchitecture: process.env.RUNNER_ARCH ?? null,
    runnerName: process.env.RUNNER_NAME ?? null,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
  },
  runtime: {
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    executable: basename(process.execPath),
  },
  github: {
    serverUrl: process.env.GITHUB_SERVER_URL ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    job: process.env.GITHUB_JOB ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runNumber: process.env.GITHUB_RUN_NUMBER ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    eventName: process.env.GITHUB_EVENT_NAME ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    ref: process.env.GITHUB_REF ?? null,
    refName: process.env.GITHUB_REF_NAME ?? null,
  },
  inputRoots: inputPaths.map(portableProjectPath),
  missingInputs,
  files,
  metadata: {
    evidenceContract: evidenceContracts,
    stepReceipts,
    bundle: bundleMetadata,
    standalone: standaloneMetadata,
    testClassification: classifications,
    dependencyAudit: dependencyAudits,
    gitleaks: gitleaksReports,
    gitleaksInstall: gitleaksInstalls,
  },
  issues,
  limitations: [
    "This is CI validation evidence, not a package, installer, release candidate or " +
      "release approval.",
    "Native process, sandbox and signal behavior is evidenced only by the named runner " +
      "and uploaded files.",
    "This workflow does not package or install a release candidate; S11.08 and release support " +
      "remain open until separately content-addressed package/install evidence exists.",
  ],
}

await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
})
process.stdout.write(
  `${JSON.stringify({
    status: evidence.status,
    kind: options.kind,
    files: files.length,
    output: portableProjectPath(output),
  })}\n`,
)
if (!complete) process.exitCode = 1
