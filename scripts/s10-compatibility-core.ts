import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { writeFileAtomic } from "@ralph-next/persistence"
import { nativeTarget, sha256File, validateStandaloneArtifact } from "./build-artifact"
import {
  type CompatibilityReport,
  runCompatibilityHarness,
  type HarnessOptions as S01HarnessOptions,
} from "./compatibility-core"
import { runS03CompatibilityHarness, type S03CompatibilityReport } from "./s03-compatibility"
import {
  assertClosedS10CompatibilityContract,
  S10_EVIDENCE_COVERAGE,
  S10_LEGACY_COMMAND_CONTRACT,
  S10_LEGACY_FLAG_CONTRACT,
  S10_LINKED_TEST_SUITES,
  type S10CompatibilityClassification,
} from "./s10-compatibility-contract"
import { sourceFingerprint } from "./source-fingerprint"
import {
  assertNoSecretLeak,
  type CapturedProcess,
  isolatedChildEnvironment,
  runCapturedProcess,
  SUBPROCESS_SECRET_CANARY,
} from "./subprocess"

const SUITE = "s10-operational-migration-compatibility" as const
const TEMPORARY_PREFIX = "ralph-v2-s10-"
const COMMAND_TIMEOUT_MS = 30_000
const LINKED_TEST_TIMEOUT_MS = 300_000
const STREAM_LIMIT_BYTES = 256 * 1024
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu
const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})\b/gu

export type S10HarnessOptions = {
  legacyBinary: string
  nextBinary: string
  outputDirectory: string
  writeReports: boolean
  format: "human" | "json"
  keepWorkspace: boolean
}

export type S10Assessment = "pass" | "regression"

export type S10StreamEvidence = {
  text: string
  sha256: string
  bytes: number
  truncated: boolean
  lineEndings: "none" | "lf" | "crlf" | "mixed"
}

export type S10InvocationEvidence = {
  id: string
  role: "legacy" | "next" | "harness"
  executable: string
  arguments: string[]
  cwd: string
  exitCode: number
  timedOut: boolean
  durationMs: number
  stdout: S10StreamEvidence
  stderr: S10StreamEvidence
}

export type S10Check = {
  id: string
  assessment: S10Assessment
  evidence: string
}

export type S10FileSnapshot = {
  path: string
  kind: "directory" | "file" | "symlink" | "other"
  size?: number
  sha256?: string
}

export type S10BinaryEvidence = {
  role: "legacy" | "next"
  path: string
  sha256Before: string
  sha256After: string
  immutable: boolean
  size: number
  version: S10InvocationEvidence
  help: S10InvocationEvidence
  buildMetadata?: {
    target: string
    version: string
    artifactSha256: string
    sourceSha256: string
    metadataPath: string
  }
}

export type S10Component<T> = {
  id: string
  assessment: S10Assessment
  error: string | null
  report: T | null
}

export type S10SmokeReport = {
  invocations: S10InvocationEvidence[]
  checks: S10Check[]
  markerBeforeSha256: string
  markerAfterSha256: string
  files: S10FileSnapshot[]
  summary: { total: number; passed: number; regressions: number }
}

export type S10MigrationReport = {
  invocations: S10InvocationEvidence[]
  checks: S10Check[]
  sourceSha256Before: string
  sourceSha256AfterInspect: string
  sourceSha256AfterApply: string
  sourceSha256AfterRollback: string
  destinationFilesAfterRollback: S10FileSnapshot[]
  summary: { total: number; passed: number; regressions: number }
}

export type S10LinkedTestReport = {
  id: string
  files: Array<{ path: string; sha256: string }>
  coverage: string[]
  rationale: string
  invocation: S10InvocationEvidence
  assessment: S10Assessment
}

export type S10ClassifiedSurface = {
  id: string
  kind: "command" | "flag"
  legacySpellings: string[]
  nextContract: string
  classification: S10CompatibilityClassification
  assessment: S10Assessment
  rationale: string
  evidence: string[]
  regressions: string[]
}

export type S10CompatibilityReport = {
  schemaVersion: 1
  suite: typeof SUITE
  generatedAt: string
  comparisonMode: "legacy-vs-next"
  environment: {
    platform: NodeJS.Platform
    architecture: string
    bunVersion: string
    nativeTarget: string
  }
  isolation: {
    disposableRoot: string
    spacesAndUnicode: true
    inheritedEnvironment: "allowlist"
    legacyAndNextConfigSeparated: true
    windowsHide: true
    retainedForDiagnosis: boolean
  }
  source: {
    sha256Before: string
    sha256After: string
    immutableDuringHarness: boolean
  }
  binaries: {
    legacy: S10BinaryEvidence
    next: S10BinaryEvidence
    distinct: boolean
  }
  contract: {
    closedInventory: ReturnType<typeof assertClosedS10CompatibilityContract>
    coverage: typeof S10_EVIDENCE_COVERAGE
    surfaces: S10ClassifiedSurface[]
  }
  components: {
    baselineS01: S10Component<CompatibilityReport>
    addendumS03: S10Component<S03CompatibilityReport>
    operationalSmoke: S10Component<S10SmokeReport>
    migrationCoexistence: S10Component<S10MigrationReport>
    linkedTests: S10LinkedTestReport[]
  }
  legacyFlagProbes: S10InvocationEvidence[]
  checks: S10Check[]
  summary: {
    classifications: Record<S10CompatibilityClassification, number>
    checks: number
    passed: number
    regressions: number
    surfaceRegressions: number
  }
}

type BinaryDescriptor = {
  role: "legacy" | "next"
  path: string
  size: number
  device: number
  inode: number
  sha256Before: string
}

type NormalizationContext = {
  projectRoot: string
  temporaryRoot: string
  legacyBinary: string
  nextBinary: string
}

const actualTemporaryRoots = new WeakMap<S10CompatibilityReport, string>()
const rawInvocationCaptures = new WeakMap<S10InvocationEvidence, CapturedProcess>()

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires an explicit path value`)
  return value
}

function requireExplicitPath(value: string, flag: string): string {
  if (!isAbsolute(value) && !value.includes("/") && !value.includes("\\")) {
    throw new Error(`${flag} requires an explicit file path, not a PATH lookup name: ${value}`)
  }
  return resolve(value)
}

export function parseS10HarnessOptions(
  argv: readonly string[],
  projectRoot = resolve(import.meta.dir, ".."),
): S10HarnessOptions {
  let legacyBinary: string | undefined
  let nextBinary: string | undefined
  let format: S10HarnessOptions["format"] = "human"
  let outputDirectory = join(projectRoot, "docs", "compatibility")
  let writeReports = true
  let keepWorkspace = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case "--legacy-binary":
        legacyBinary = requireExplicitPath(requireValue(argv, index, argument), argument)
        index += 1
        break
      case "--next-binary":
        nextBinary = requireExplicitPath(requireValue(argv, index, argument), argument)
        index += 1
        break
      case "--output-dir":
        outputDirectory = resolve(requireValue(argv, index, argument))
        index += 1
        break
      case "--format": {
        const requested = requireValue(argv, index, argument)
        if (requested !== "human" && requested !== "json") {
          throw new Error("--format must be human or json")
        }
        format = requested
        index += 1
        break
      }
      case "--json":
        format = "json"
        break
      case "--no-write":
        writeReports = false
        break
      case "--keep-workspace":
        keepWorkspace = true
        break
      default:
        throw new Error(`Unknown S10 compatibility harness option: ${argument ?? "<missing>"}`)
    }
  }

  if (!legacyBinary) throw new Error("--legacy-binary <explicit-file> is required")
  if (!nextBinary) throw new Error("--next-binary <explicit-file> is required")
  return { legacyBinary, nextBinary, outputDirectory, writeReports, format, keepWorkspace }
}

function slash(path: string): string {
  return path.replaceAll("\\", "/")
}

function replaceAllPathForms(value: string, path: string, marker: string): string {
  const candidates = new Set([path, slash(path), path.replaceAll("/", "\\")])
  let result = value
  for (const candidate of [...candidates].sort((left, right) => right.length - left.length)) {
    if (candidate) result = result.replaceAll(candidate, marker)
  }
  return result
}

function normalizeText(value: string, context: NormalizationContext): string {
  let result = value
  result = replaceAllPathForms(result, context.temporaryRoot, "<S10_TEMP_ROOT>")
  result = replaceAllPathForms(result, context.projectRoot, "<PROJECT_ROOT>")
  result = replaceAllPathForms(result, dirname(context.legacyBinary), "<LEGACY_BINARY_DIR>")
  result = replaceAllPathForms(result, dirname(context.nextBinary), "<NEXT_BINARY_DIR>")
  return result.replace(UUID_PATTERN, "<UUID>").replace(ISO_TIMESTAMP_PATTERN, "<TIMESTAMP>")
}

function portablePath(path: string, context: NormalizationContext): string {
  return normalizeText(resolve(path), context)
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function lineEndings(value: string): S10StreamEvidence["lineEndings"] {
  if (!value.includes("\n") && !value.includes("\r")) return "none"
  const hasCrlf = value.includes("\r\n")
  const withoutCrlf = value.replaceAll("\r\n", "")
  const hasBare = withoutCrlf.includes("\n") || withoutCrlf.includes("\r")
  if (hasCrlf && hasBare) return "mixed"
  return hasCrlf ? "crlf" : "lf"
}

function streamEvidence(value: string, context: NormalizationContext): S10StreamEvidence {
  const normalized = normalizeText(value, context)
  const bytes = Buffer.byteLength(normalized)
  const truncated = bytes > STREAM_LIMIT_BYTES
  const text = truncated
    ? `${Buffer.from(normalized).subarray(0, STREAM_LIMIT_BYTES).toString("utf8")}\n<TRUNCATED>`
    : normalized
  return {
    text,
    sha256: sha256Text(normalized),
    bytes,
    truncated,
    lineEndings: lineEndings(normalized),
  }
}

async function resolveRegularBinary(
  role: BinaryDescriptor["role"],
  candidate: string,
): Promise<BinaryDescriptor> {
  const requested = resolve(candidate)
  let requestedInfo: Awaited<ReturnType<typeof lstat>>
  try {
    requestedInfo = await lstat(requested)
  } catch {
    throw new Error(`${role} binary does not exist: ${requested}`)
  }
  if (!requestedInfo.isFile() || requestedInfo.isSymbolicLink()) {
    throw new Error(`${role} binary must be an explicit regular, non-linked file: ${requested}`)
  }
  const path = await realpath(requested)
  const resolvedInfo = await lstat(path)
  if (!resolvedInfo.isFile() || resolvedInfo.isSymbolicLink()) {
    throw new Error(`${role} binary resolved to a non-regular file: ${path}`)
  }
  return {
    role,
    path,
    size: resolvedInfo.size,
    device: resolvedInfo.dev,
    inode: resolvedInfo.ino,
    sha256Before: await sha256File(path),
  }
}

function sameBinary(left: BinaryDescriptor, right: BinaryDescriptor): boolean {
  if (
    left.device === right.device &&
    left.inode === right.inode &&
    (left.device !== 0 || left.inode !== 0)
  ) {
    return true
  }
  return process.platform === "win32"
    ? left.path.toLocaleLowerCase("en") === right.path.toLocaleLowerCase("en")
    : left.path === right.path
}

async function captureInvocation(input: {
  id: string
  role: S10InvocationEvidence["role"]
  executable: string
  arguments: string[]
  cwd: string
  environment: Record<string, string>
  context: NormalizationContext
  timeoutMs?: number
}): Promise<S10InvocationEvidence> {
  const started = performance.now()
  const capture = await runCapturedProcess([input.executable, ...input.arguments], {
    cwd: input.cwd,
    environment: input.environment,
    timeoutMs: input.timeoutMs ?? COMMAND_TIMEOUT_MS,
  })
  assertNoSecretLeak(
    [capture.stdout, capture.stderr],
    [SUBPROCESS_SECRET_CANARY],
    `S10 invocation ${input.id}`,
  )
  const evidence: S10InvocationEvidence = {
    id: input.id,
    role: input.role,
    executable: portablePath(input.executable, input.context),
    arguments: input.arguments.map((argument) => normalizeText(argument, input.context)),
    cwd: portablePath(input.cwd, input.context),
    exitCode: capture.exitCode,
    timedOut: capture.timedOut,
    durationMs: Math.round(performance.now() - started),
    stdout: streamEvidence(capture.stdout, input.context),
    stderr: streamEvidence(capture.stderr, input.context),
  }
  rawInvocationCaptures.set(evidence, capture)
  return evidence
}

function addCheck(checks: S10Check[], id: string, passed: boolean, evidence: string): void {
  checks.push({ id, assessment: passed ? "pass" : "regression", evidence })
}

function summarizeChecks(checks: readonly S10Check[]): S10SmokeReport["summary"] {
  const regressions = checks.filter((check) => check.assessment === "regression").length
  return { total: checks.length, passed: checks.length - regressions, regressions }
}

type JsonDocumentParse = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

function parseJsonDocument(invocation: S10InvocationEvidence): JsonDocumentParse {
  try {
    return {
      ok: true,
      value: JSON.parse(rawInvocationCaptures.get(invocation)?.stdout ?? invocation.stdout.text),
    }
  } catch {
    return { ok: false }
  }
}

function parseJsonObjectOutput(invocation: S10InvocationEvidence): Record<string, unknown> | null {
  const parsed = parseJsonDocument(invocation)
  return parsed.ok &&
    parsed.value !== null &&
    typeof parsed.value === "object" &&
    !Array.isArray(parsed.value)
    ? (parsed.value as Record<string, unknown>)
    : null
}

async function snapshotTree(root: string): Promise<S10FileSnapshot[]> {
  const output: S10FileSnapshot[] = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const stats = await lstat(absolute)
      const path = slash(relative(root, absolute))
      if (stats.isSymbolicLink()) {
        output.push({ path, kind: "symlink" })
      } else if (stats.isDirectory()) {
        output.push({ path, kind: "directory" })
        await visit(absolute)
      } else if (stats.isFile()) {
        output.push({ path, kind: "file", size: stats.size, sha256: await sha256File(absolute) })
      } else {
        output.push({ path, kind: "other" })
      }
    }
  }
  await visit(root)
  return output
}

async function treeFingerprint(root: string): Promise<string> {
  return sha256Text(JSON.stringify(await snapshotTree(root)))
}

function assertSafeTemporaryRoot(path: string): void {
  const temporaryRoot = realpathSync(resolve(tmpdir()))
  const candidate = resolve(path)
  const segment = relative(temporaryRoot, candidate)
  if (
    !segment ||
    segment === ".." ||
    segment.startsWith(`..${sep}`) ||
    isAbsolute(segment) ||
    !basename(candidate).startsWith(`${TEMPORARY_PREFIX}espaço-ünicode-`)
  ) {
    throw new Error(`Refusing unsafe S10 temporary root: ${candidate}`)
  }
}

async function removeTemporaryRoot(path: string): Promise<void> {
  assertSafeTemporaryRoot(path)
  await rm(path, { force: true, recursive: true, maxRetries: 4, retryDelay: 50 })
}

const LEGACY_FLAG_VALUES: Readonly<Record<string, readonly string[]>> = {
  "--ui": ["none"],
  "--mode": ["loop"],
  "--gate": ["test=echo-s10"],
  "--run-gate": ["test=echo-s10"],
  "--test-command": ["echo-s10"],
  "--lint-command": ["echo-s10"],
  "--security": ["safe"],
  "--sandbox-provider": ["process"],
  "--sandbox-image": ["s10-fixture"],
  "--sandbox-network": ["none"],
  "--parallel-integration": ["no-merge"],
  "--no-change-policy": ["fallback"],
  "--no-change-max-retries": ["1"],
  "--base-branch": ["main"],
  "--engine": ["codex"],
  "--model": ["s10-fixture"],
  "--prd": ["PRD.md"],
  "--repo": ["owner/repository"],
  "--label": ["compatibility"],
  "--state": ["open"],
  "--output": ["s10-output.md"],
  "-r": ["1"],
  "--retries": ["1"],
  "--max-retries": ["1"],
  "--retry-delay": ["0"],
  "--max-iterations": ["1"],
  "--max-parallel": ["1"],
  "--max-tokens": ["1"],
  "--temperature": ["0"],
  "--level": ["info"],
  "--since": ["1h"],
}

function legacyFlagProbeArguments(spelling: string): string[] {
  if (spelling === "--help" || spelling === "-h") return [spelling]
  if (spelling === "--version" || spelling === "-V") return [spelling]
  if (spelling === "--") return ["run", "--dry-run", "--", "s10-passthrough-probe"]
  return [spelling, ...(LEGACY_FLAG_VALUES[spelling] ?? []), "--help"]
}

async function runLegacyFlagProbes(input: {
  binary: BinaryDescriptor
  root: string
  context: NormalizationContext
}): Promise<{ invocations: S10InvocationEvidence[]; checks: S10Check[] }> {
  const invocations: S10InvocationEvidence[] = []
  const checks: S10Check[] = []
  const environment = await isolatedChildEnvironment(join(input.root, "environment"))
  const spellings = S10_LEGACY_FLAG_CONTRACT.flatMap((item) => item.legacySpellings)
  for (const [index, spelling] of spellings.entries()) {
    const invocation = await captureInvocation({
      id: `legacy.flag.${String(index + 1).padStart(3, "0")}.${spelling.replaceAll(/[^a-z0-9]+/giu, "-")}`,
      role: "legacy",
      executable: input.binary.path,
      arguments: legacyFlagProbeArguments(spelling),
      cwd: input.root,
      environment,
      context: input.context,
    })
    invocations.push(invocation)
    const combined = `${invocation.stdout.text}\n${invocation.stderr.text}`
    const recognized =
      !invocation.timedOut &&
      !combined.includes("Unknown option") &&
      !combined.includes("requires a value") &&
      (spelling === "--" || invocation.exitCode === 0)
    addCheck(
      checks,
      `legacy.flag-recognized.${spelling}`,
      recognized,
      recognized
        ? `${spelling} was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch.`
        : `${spelling} probe exited ${invocation.exitCode} (timeout=${invocation.timedOut}).`,
    )
  }
  return { invocations, checks }
}

async function runOperationalSmoke(input: {
  projectRoot: string
  root: string
  legacy: BinaryDescriptor
  next: BinaryDescriptor
  context: NormalizationContext
}): Promise<S10SmokeReport> {
  const legacyRoot = join(input.root, "legacy operational workspace")
  const nextRoot = join(input.root, "novo operational workspace ç")
  const legacyEnvironmentRoot = join(input.root, "environment legacy")
  const nextEnvironmentRoot = join(input.root, "environment next")
  await Promise.all([mkdir(legacyRoot, { recursive: true }), mkdir(nextRoot, { recursive: true })])
  await writeFile(
    join(legacyRoot, "PRD.md"),
    "---\ntask: S10 legacy operational fixture\nengine: codex\n---\n\n# Tasks\n\n- [ ] legacy operational marker\n",
    "utf8",
  )
  await cp(join(input.projectRoot, "tests", "fixtures", "execution", "single-pass"), nextRoot, {
    recursive: true,
  })
  const legacyEnvironment = await isolatedChildEnvironment(legacyEnvironmentRoot)
  const nextEnvironment = await isolatedChildEnvironment(nextEnvironmentRoot)
  const invocations: S10InvocationEvidence[] = []
  const checks: S10Check[] = []

  async function run(
    id: string,
    role: "legacy" | "next",
    arguments_: string[],
    cwd: string,
  ): Promise<S10InvocationEvidence> {
    const invocation = await captureInvocation({
      id,
      role,
      executable: role === "legacy" ? input.legacy.path : input.next.path,
      arguments: arguments_,
      cwd,
      environment: role === "legacy" ? legacyEnvironment : nextEnvironment,
      context: input.context,
    })
    invocations.push(invocation)
    return invocation
  }

  const legacySetup = await run("operational.legacy.setup", "legacy", ["setup"], legacyRoot)
  const legacyConfig = await run(
    "operational.legacy.config-list",
    "legacy",
    ["config", "list"],
    legacyRoot,
  )
  const legacyStatus = await run(
    "operational.legacy.status-json",
    "legacy",
    ["status", "--json"],
    legacyRoot,
  )

  const nextSetup = await run(
    "operational.next.setup-alias",
    "next",
    ["setup", "--workspace", nextRoot, "--format", "json", "--no-color", "--non-interactive"],
    input.root,
  )
  const markerPath = join(nextRoot, "PRD.md")
  const markerBeforeSha256 = await sha256File(markerPath)

  const successful: Array<[string, string[], string]> = [
    ["help-short", ["-h"], input.root],
    ["help-json", ["help", "--format", "json", "--no-color"], input.root],
    ["version-short", ["-V"], input.root],
    [
      "status-human",
      ["status", "--workspace", nextRoot, "--format", "human", "--no-color"],
      input.root,
    ],
    [
      "status-json",
      ["status", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "config-list-human",
      ["config", "list", "--workspace", nextRoot, "--format", "human", "--no-color"],
      input.root,
    ],
    [
      "config-list-json",
      ["config", "list", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "config-explain",
      [
        "config",
        "explain",
        "evaluation.threshold",
        "--workspace",
        nextRoot,
        "--format",
        "json",
        "--no-color",
      ],
      input.root,
    ],
    [
      "config-set",
      [
        "config",
        "set",
        "evaluation.threshold",
        "85",
        "--scope",
        "workspace",
        "--workspace",
        nextRoot,
        "--format",
        "json",
        "--no-color",
      ],
      input.root,
    ],
    [
      "config-get",
      [
        "config",
        "get",
        "evaluation.threshold",
        "--workspace",
        nextRoot,
        "--format",
        "json",
        "--no-color",
      ],
      input.root,
    ],
    [
      "config-reset-preview-alias",
      [
        "config",
        "reset",
        "evaluation.threshold",
        "--scope",
        "workspace",
        "--workspace",
        nextRoot,
        "--dry-run",
        "--format",
        "json",
        "--no-color",
      ],
      input.root,
    ],
    [
      "tasks-list-human",
      ["tasks", "list", "--workspace", nextRoot, "--format", "human", "--no-color"],
      input.root,
    ],
    [
      "tasks-list-json",
      ["tasks", "list", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "tasks-next",
      ["tasks", "next", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "rules-list-empty",
      ["rules", "list", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "rules-add",
      [
        "rules",
        "add",
        "S10 compatibility rule",
        "--workspace",
        nextRoot,
        "--format",
        "json",
        "--no-color",
      ],
      input.root,
    ],
    [
      "rules-list-human",
      ["rules", "list", "--workspace", nextRoot, "--format", "human", "--no-color"],
      input.root,
    ],
    [
      "checkpoints-list-alias",
      ["checkpoints", "list", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "adapters-list",
      ["adapters", "list", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "recipes-list",
      ["recipes", "list", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "lang-current",
      ["lang", "current", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "lang-list",
      ["lang", "list", "--workspace", nextRoot, "--format", "human", "--no-color"],
      input.root,
    ],
    [
      "events-empty",
      ["events", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "logs-empty",
      ["logs", "tail", "--workspace", nextRoot, "--format", "json", "--no-color"],
      input.root,
    ],
    [
      "doctor",
      ["doctor", "--workspace", nextRoot, "--format", "json", "--no-color", "--non-interactive"],
      input.root,
    ],
    ["about", ["about", "--format", "human", "--no-color"], input.root],
    [
      "clean-preview",
      ["clean", "--workspace", nextRoot, "--dry-run", "--format", "json", "--no-color"],
      input.root,
    ],
  ]
  const successfulInvocations: S10InvocationEvidence[] = []
  for (const [id, arguments_, cwd] of successful) {
    successfulInvocations.push(await run(`operational.next.${id}`, "next", arguments_, cwd))
  }

  const guarded: Array<[string, string[]]> = [
    [
      "tasks-done-without-evidence",
      ["tasks", "done", "next", "--workspace", nextRoot, "--format", "json", "--no-color"],
    ],
    [
      "rules-clear-without-force",
      ["rules", "clear", "--workspace", nextRoot, "--format", "json", "--no-color"],
    ],
    [
      "tasks-sync-without-repo",
      ["tasks", "sync", "--workspace", nextRoot, "--format", "json", "--no-color"],
    ],
    ["report-empty", ["report", "last", "--workspace", nextRoot, "--format", "json", "--no-color"]],
    [
      "context-show-alias-without-run",
      ["context", "show", "--workspace", nextRoot, "--format", "json", "--no-color"],
    ],
    [
      "ui-attach-alias-without-run",
      ["ui", "--workspace", nextRoot, "--format", "json", "--no-color"],
    ],
    [
      "cancel-alias-without-run",
      ["cancel", "--workspace", nextRoot, "--format", "json", "--no-color"],
    ],
    ["connect-alias-without-method", ["connect", "--format", "json", "--no-color"]],
    [
      "context-refresh-alias-without-supervisor",
      ["context", "refresh", "--workspace", nextRoot, "--format", "json", "--no-color"],
    ],
    [
      "install-preflight-without-manifest",
      ["install", "--dry-run", "--format", "json", "--no-color"],
    ],
    ["update-check-without-manifest", ["update", "--check", "--format", "json", "--no-color"]],
  ]
  const guardedInvocations: S10InvocationEvidence[] = []
  for (const [id, arguments_] of guarded) {
    guardedInvocations.push(await run(`operational.next.${id}`, "next", arguments_, input.root))
  }

  const finalRulesClear = await run(
    "operational.next.rules-clear",
    "next",
    ["rules", "clear", "--workspace", nextRoot, "--force", "--format", "json", "--no-color"],
    input.root,
  )

  const markerAfterSha256 = await sha256File(markerPath)
  const files = await snapshotTree(nextRoot)
  const mandatorySuccess = [
    legacySetup,
    legacyConfig,
    legacyStatus,
    nextSetup,
    ...successfulInvocations,
    finalRulesClear,
  ]
  addCheck(
    checks,
    "operational.success-exits",
    mandatorySuccess.every((item) => item.exitCode === 0 && !item.timedOut),
    `${mandatorySuccess.filter((item) => item.exitCode === 0 && !item.timedOut).length}/${mandatorySuccess.length} required operational commands exited zero without timeout.`,
  )
  const jsonInvocations = [...mandatorySuccess, ...guardedInvocations].filter((item) =>
    item.arguments.some((argument) => argument === "json" || argument === "--json"),
  )
  addCheck(
    checks,
    "operational.json-contract",
    jsonInvocations.every((item) => parseJsonDocument(item).ok),
    `${jsonInvocations.filter((item) => parseJsonDocument(item).ok).length}/${jsonInvocations.length} JSON probes produced a single parseable JSON document.`,
  )
  addCheck(
    checks,
    "operational.guards-are-not-unknown",
    guardedInvocations.every((item) => {
      const result = parseJsonObjectOutput(item)
      return (
        !item.timedOut &&
        result !== null &&
        !`${item.stdout.text}${item.stderr.text}`.includes("UNKNOWN_COMMAND")
      )
    }),
    "Expected-denial probes reached command-owned validation instead of an unknown-command fallback.",
  )
  addCheck(
    checks,
    "operational.marker-immutable",
    markerBeforeSha256 === markerAfterSha256,
    "Read commands and rejected manual completion left the exact PRD bytes unchanged.",
  )
  addCheck(
    checks,
    "operational.aliases",
    [
      nextSetup,
      ...successfulInvocations.filter((item) =>
        ["-h", "-V", "checkpoints", "config"].includes(item.arguments[0] ?? ""),
      ),
    ].every((item) => item.exitCode === 0 && !item.timedOut),
    "setup, -h, -V, config reset and checkpoints aliases reached their v2 handlers; context/ui aliases are separately checked as command-owned denials.",
  )
  addCheck(
    checks,
    "operational.human-output",
    successfulInvocations
      .filter(
        (item) =>
          item.arguments.includes("human") ||
          item.arguments[0] === "-h" ||
          item.arguments[0] === "-V",
      )
      .every((item) => item.stdout.text.trim().length > 0 && !item.stdout.text.includes("\u001b[")),
    "Human/no-color probes emitted non-empty plain text.",
  )
  addCheck(
    checks,
    "operational.isolated-config",
    nextEnvironment.RALPH_CONFIG_HOME !== legacyEnvironment.RALPH_CONFIG_HOME &&
      typeof nextEnvironment.RALPH_CONFIG_HOME === "string" &&
      !nextEnvironment.RALPH_CONFIG_HOME.startsWith(`${nextRoot}${sep}`),
    "Legacy and next received distinct allowlisted HOME/config roots outside both workspaces.",
  )

  return {
    invocations,
    checks,
    markerBeforeSha256,
    markerAfterSha256,
    files,
    summary: summarizeChecks(checks),
  }
}

function jsonData(invocation: S10InvocationEvidence): Record<string, unknown> {
  const parsed = parseJsonObjectOutput(invocation)
  const data = parsed?.data
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${invocation.id} did not return an object data payload`)
  }
  return data as Record<string, unknown>
}

function requiredJsonString(
  record: Record<string, unknown>,
  key: string,
  invocation: S10InvocationEvidence,
): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${invocation.id} did not return data.${key}`)
  }
  return value
}

async function runMigrationCoexistence(input: {
  root: string
  legacy: BinaryDescriptor
  next: BinaryDescriptor
  context: NormalizationContext
}): Promise<S10MigrationReport> {
  const legacyRoot = join(input.root, "projeto legado com espaço ü")
  const nextRoot = join(input.root, "destino migrado v2 com espaço")
  const aliasRoot = join(input.root, "workspace alias setup v2")
  const legacyEnvironmentRoot = join(input.root, "config e home legado")
  const nextEnvironmentRoot = join(input.root, "config e home somente v2")
  await Promise.all(
    [legacyRoot, nextRoot, aliasRoot].map((path) => mkdir(path, { recursive: true })),
  )
  await writeFile(
    join(legacyRoot, "PRD.md"),
    "---\ntask: S10 migration fixture\nengine: codex\n---\n\n# Tasks\n\n- [ ] migrate this legacy task\n",
    "utf8",
  )
  await writeFile(join(nextRoot, "sentinel-unrelated.txt"), "preserve destination sentinel\n")
  const sentinelSha256 = await sha256File(join(nextRoot, "sentinel-unrelated.txt"))
  const legacyEnvironment = await isolatedChildEnvironment(legacyEnvironmentRoot)
  const nextEnvironment = await isolatedChildEnvironment(nextEnvironmentRoot)
  const invocations: S10InvocationEvidence[] = []
  const checks: S10Check[] = []

  async function run(
    id: string,
    role: "legacy" | "next",
    arguments_: string[],
    cwd = input.root,
  ): Promise<S10InvocationEvidence> {
    const invocation = await captureInvocation({
      id,
      role,
      executable: role === "legacy" ? input.legacy.path : input.next.path,
      arguments: arguments_,
      cwd,
      environment: role === "legacy" ? legacyEnvironment : nextEnvironment,
      context: input.context,
    })
    invocations.push(invocation)
    if (invocation.exitCode !== 0 || invocation.timedOut) {
      throw new Error(
        `${id} failed with exit ${invocation.exitCode} (timeout=${invocation.timedOut}): ${invocation.stderr.text.trim()}`,
      )
    }
    return invocation
  }

  await run("migration.legacy.init", "legacy", ["init"], legacyRoot)
  await run("migration.legacy.setup-alias", "legacy", ["setup"], legacyRoot)
  await run("migration.legacy.config-list", "legacy", ["config", "list"], legacyRoot)
  await run("migration.legacy.status-json", "legacy", ["status", "--json"], legacyRoot)
  const sourceSha256Before = await treeFingerprint(legacyRoot)
  const legacyConfigSha256Before = await treeFingerprint(legacyEnvironmentRoot)

  await run("migration.next.setup-alias", "next", [
    "setup",
    "--workspace",
    aliasRoot,
    "--format",
    "json",
    "--no-color",
    "--non-interactive",
  ])
  const inspect = await run("migration.next.inspect", "next", [
    "migrate",
    "inspect",
    legacyRoot,
    "--format",
    "json",
    "--no-color",
  ])
  const sourceSha256AfterInspect = await treeFingerprint(legacyRoot)
  const inspectData = jsonData(inspect)
  const inspectSerialized = JSON.stringify(inspectData)
  addCheck(
    checks,
    "migration.inspect-read-only",
    sourceSha256AfterInspect === sourceSha256Before,
    "migrate inspect left the complete legacy workspace tree byte-identical.",
  )
  addCheck(
    checks,
    "migration.inspect-redacted",
    !inspectSerialized.includes(SUBPROCESS_SECRET_CANARY),
    "The inspect payload did not expose the isolated credential canary.",
  )

  const apply = await run("migration.next.apply", "next", [
    "migrate",
    "apply",
    legacyRoot,
    "--destination",
    nextRoot,
    "--format",
    "json",
    "--no-color",
  ])
  const applyData = jsonData(apply)
  const rollbackManifest = resolve(requiredJsonString(applyData, "rollbackManifest", apply))
  const manifestInfo = await lstat(rollbackManifest)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error(`migrate apply returned a non-regular rollback manifest: ${rollbackManifest}`)
  }
  const sourceSha256AfterApply = await treeFingerprint(legacyRoot)
  addCheck(
    checks,
    "migration.apply-source-immutable",
    sourceSha256AfterApply === sourceSha256Before,
    "migrate apply created only destination-v2 files and did not alter the legacy tree.",
  )
  addCheck(
    checks,
    "migration.apply-sentinel",
    (await sha256File(join(nextRoot, "sentinel-unrelated.txt"))) === sentinelSha256,
    "migrate apply preserved an unrelated pre-existing destination file.",
  )

  const postMigrationSentinel = join(nextRoot, ".ralph", "post-migration-sentinel.txt")
  await writeFile(postMigrationSentinel, "created after migration; rollback must preserve\n")
  const postMigrationSentinelSha256 = await sha256File(postMigrationSentinel)
  await run("migration.next.status", "next", [
    "status",
    "--workspace",
    nextRoot,
    "--format",
    "json",
    "--no-color",
  ])
  await run("migration.next.config-list", "next", [
    "config",
    "list",
    "--workspace",
    nextRoot,
    "--format",
    "json",
    "--no-color",
  ])

  const preview = await run("migration.next.rollback-preview", "next", [
    "migrate",
    "rollback",
    rollbackManifest,
    "--dry-run",
    "--format",
    "json",
    "--no-color",
  ])
  const previewData = jsonData(preview)
  const planHash = requiredJsonString(previewData, "planHash", preview)
  if (!/^[a-f0-9]{64}$/u.test(planHash)) {
    throw new Error(`rollback preview returned an invalid planHash: ${planHash}`)
  }
  await run("migration.next.rollback-apply", "next", [
    "migrate",
    "rollback",
    rollbackManifest,
    "--confirm-plan-hash",
    planHash,
    "--format",
    "json",
    "--no-color",
  ])

  const sourceSha256AfterRollback = await treeFingerprint(legacyRoot)
  const legacyConfigSha256After = await treeFingerprint(legacyEnvironmentRoot)
  const destinationFilesAfterRollback = await snapshotTree(nextRoot)
  addCheck(
    checks,
    "migration.rollback-source-immutable",
    sourceSha256AfterRollback === sourceSha256Before,
    "Rollback never opened the legacy workspace as a mutation target.",
  )
  addCheck(
    checks,
    "migration.rollback-created-files-only",
    !(await Bun.file(rollbackManifest).exists()),
    "The confirmed manifest was removed after its listed, unchanged created files.",
  )
  addCheck(
    checks,
    "migration.rollback-preexisting-sentinel",
    (await sha256File(join(nextRoot, "sentinel-unrelated.txt"))) === sentinelSha256,
    "The pre-existing destination sentinel remained byte-identical after rollback.",
  )
  addCheck(
    checks,
    "migration.rollback-post-sentinel",
    (await sha256File(postMigrationSentinel)) === postMigrationSentinelSha256,
    "The file created after migration remained byte-identical after rollback.",
  )
  addCheck(
    checks,
    "migration.config-roots-separated",
    legacyEnvironment.RALPH_CONFIG_HOME !== nextEnvironment.RALPH_CONFIG_HOME &&
      legacyConfigSha256After === legacyConfigSha256Before,
    "Next-side inspect/apply/status/rollback never changed the isolated legacy HOME/config tree.",
  )
  addCheck(
    checks,
    "migration.workspace-roots-separated",
    !nextRoot.startsWith(`${legacyRoot}${sep}`) &&
      !legacyRoot.startsWith(`${nextRoot}${sep}`) &&
      !aliasRoot.startsWith(`${legacyRoot}${sep}`),
    "Legacy, migrated destination and alias workspace are distinct non-nested roots.",
  )

  return {
    invocations,
    checks,
    sourceSha256Before,
    sourceSha256AfterInspect,
    sourceSha256AfterApply,
    sourceSha256AfterRollback,
    destinationFilesAfterRollback,
    summary: summarizeChecks(checks),
  }
}

async function runLinkedTests(input: {
  projectRoot: string
  root: string
  context: NormalizationContext
}): Promise<S10LinkedTestReport[]> {
  const reports: S10LinkedTestReport[] = []
  for (const [suiteOrdinal, suite] of S10_LINKED_TEST_SUITES.entries()) {
    const files: Array<{ path: string; sha256: string }> = []
    for (const file of suite.files) {
      const absolute = resolve(input.projectRoot, file)
      const segment = relative(input.projectRoot, absolute)
      if (!segment || segment === ".." || segment.startsWith(`..${sep}`) || isAbsolute(segment)) {
        throw new Error(`Linked S10 test escaped the project root: ${file}`)
      }
      const info = await lstat(absolute)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Linked S10 evidence must be a regular test file: ${file}`)
      }
      files.push({ path: slash(file), sha256: await sha256File(absolute) })
    }
    // Keep the isolated TEMP root bounded. The linked Git suite creates a repository-owned
    // `.ralph/worktrees/<run>/<task>--<attempt>` below TEMP; repeating the descriptive suite ID
    // here can push Git for Windows past its internal legacy path boundary before the product's
    // own long-path guard is involved. HOME, config and TEMP remain unique per linked suite.
    const environment = await isolatedChildEnvironment(
      join(input.root, `suite-${String(suiteOrdinal + 1).padStart(2, "0")}`),
    )
    const invocation = await captureInvocation({
      id: `linked-test.${suite.id}`,
      role: "harness",
      executable: process.execPath,
      arguments: ["test", ...suite.files],
      cwd: input.projectRoot,
      environment,
      context: input.context,
      timeoutMs: LINKED_TEST_TIMEOUT_MS,
    })
    reports.push({
      id: suite.id,
      files,
      coverage: [...suite.coverage],
      rationale: suite.rationale,
      invocation,
      assessment: invocation.exitCode === 0 && !invocation.timedOut ? "pass" : "regression",
    })
  }
  return reports
}

function componentAssessment(
  report: CompatibilityReport | S03CompatibilityReport | S10SmokeReport | S10MigrationReport,
): S10Assessment {
  if ("suite" in report) {
    return report.summary.regressions === 0 ? "pass" : "regression"
  }
  return report.summary.regressions === 0 ? "pass" : "regression"
}

async function runComponent<
  T extends CompatibilityReport | S03CompatibilityReport | S10SmokeReport | S10MigrationReport,
>(
  id: string,
  operation: () => Promise<T>,
  context: NormalizationContext,
): Promise<S10Component<T>> {
  try {
    const report = await operation()
    return { id, assessment: componentAssessment(report), error: null, report }
  } catch (error) {
    return {
      id,
      assessment: "regression",
      error: normalizeText(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
        context,
      ),
      report: null,
    }
  }
}

function surfaceAssessment(
  kind: S10ClassifiedSurface["kind"],
  item: (typeof S10_LEGACY_COMMAND_CONTRACT)[number] | (typeof S10_LEGACY_FLAG_CONTRACT)[number],
  evidenceAssessments: ReadonlyMap<string, S10Assessment>,
): S10ClassifiedSurface {
  const regressions = item.evidence.filter(
    (evidence) => evidenceAssessments.get(evidence) !== "pass",
  )
  return {
    id: item.id,
    kind,
    legacySpellings: [...item.legacySpellings],
    nextContract: "nextCommand" in item ? item.nextCommand : item.nextContract,
    classification: item.classification,
    assessment: regressions.length === 0 ? "pass" : "regression",
    rationale: item.rationale,
    evidence: [...item.evidence],
    regressions,
  }
}

function classificationCounts(
  surfaces: readonly S10ClassifiedSurface[],
): Record<S10CompatibilityClassification, number> {
  return {
    compatible: surfaces.filter((item) => item.classification === "compatible").length,
    changed: surfaces.filter((item) => item.classification === "changed").length,
    deprecated: surfaces.filter((item) => item.classification === "deprecated").length,
    removed: surfaces.filter((item) => item.classification === "removed").length,
  }
}

export async function runS10CompatibilityHarness(
  options: S10HarnessOptions,
  projectRoot = resolve(import.meta.dir, ".."),
): Promise<S10CompatibilityReport> {
  const root = await realpath(projectRoot)
  const closedInventory = assertClosedS10CompatibilityContract()
  const legacy = await resolveRegularBinary("legacy", options.legacyBinary)
  const next = await resolveRegularBinary("next", options.nextBinary)
  if (sameBinary(legacy, next)) {
    throw new Error("--legacy-binary and --next-binary must resolve to distinct regular files")
  }
  const validatedNext = await validateStandaloneArtifact(next.path, root, nativeTarget())
  const temporaryRoot = await realpath(
    await mkdtemp(join(tmpdir(), `${TEMPORARY_PREFIX}espaço-ünicode-`)),
  )
  assertSafeTemporaryRoot(temporaryRoot)
  const context: NormalizationContext = {
    projectRoot: root,
    temporaryRoot,
    legacyBinary: legacy.path,
    nextBinary: next.path,
  }
  const sourceSha256Before = await sourceFingerprint(root)
  let report: S10CompatibilityReport | undefined

  try {
    const binaryEnvironment = await isolatedChildEnvironment(
      join(temporaryRoot, "binary probes environment"),
    )
    const legacyVersion = await captureInvocation({
      id: "binary.legacy.version",
      role: "legacy",
      executable: legacy.path,
      arguments: ["--version"],
      cwd: temporaryRoot,
      environment: binaryEnvironment,
      context,
    })
    const legacyHelp = await captureInvocation({
      id: "binary.legacy.help",
      role: "legacy",
      executable: legacy.path,
      arguments: ["--help"],
      cwd: temporaryRoot,
      environment: binaryEnvironment,
      context,
    })
    const nextVersion = await captureInvocation({
      id: "binary.next.version",
      role: "next",
      executable: next.path,
      arguments: ["version", "--format", "human", "--no-color"],
      cwd: temporaryRoot,
      environment: binaryEnvironment,
      context,
    })
    const nextHelp = await captureInvocation({
      id: "binary.next.help",
      role: "next",
      executable: next.path,
      arguments: ["help", "--format", "human", "--no-color"],
      cwd: temporaryRoot,
      environment: binaryEnvironment,
      context,
    })

    const flagProbes = await runLegacyFlagProbes({
      binary: legacy,
      root: join(temporaryRoot, "legacy flag probes"),
      context,
    })

    const baselineOptions: S01HarnessOptions = {
      withoutLegacy: false,
      nextSource: false,
      legacyBinary: legacy.path,
      nextBinary: next.path,
      outputDirectory: options.outputDirectory,
      writeReports: false,
      printJson: true,
    }
    const baselineS01 = await runComponent(
      "s01.baseline",
      () => runCompatibilityHarness(baselineOptions, root),
      context,
    )
    const addendumS03 = await runComponent(
      "s03.addendum",
      () => runS03CompatibilityHarness(root, { nextBinary: next.path }),
      context,
    )
    const operationalSmoke = await runComponent(
      "s10.operational-smoke",
      () =>
        runOperationalSmoke({
          projectRoot: root,
          root: join(temporaryRoot, "operational smoke"),
          legacy,
          next,
          context,
        }),
      context,
    )
    const migrationCoexistence = await runComponent(
      "s10.migration-coexistence",
      () =>
        runMigrationCoexistence({
          root: join(temporaryRoot, "migration coexistence"),
          legacy,
          next,
          context,
        }),
      context,
    )
    const linkedTests = await runLinkedTests({
      projectRoot: root,
      root: join(temporaryRoot, "linked"),
      context,
    })
    const sourceSha256After = await sourceFingerprint(root)
    const legacySha256After = await sha256File(legacy.path)
    const nextSha256After = await sha256File(next.path)

    const checks: S10Check[] = []
    addCheck(
      checks,
      "binary.explicit-regular-distinct",
      !sameBinary(legacy, next) && legacy.size > 0 && next.size > 0,
      "Both mandatory CLI options resolved to distinct regular non-linked files.",
    )
    addCheck(
      checks,
      "binary.version-help",
      [legacyVersion, legacyHelp, nextVersion, nextHelp].every(
        (item) => item.exitCode === 0 && !item.timedOut && item.stdout.text.trim().length > 0,
      ),
      "Both explicit binaries returned successful non-empty version and human help captures.",
    )
    checks.push(...flagProbes.checks)
    addCheck(
      checks,
      "component.s01-baseline",
      baselineS01.assessment === "pass",
      baselineS01.error ??
        "The additive coordinator executed the S01 baseline without replacing it.",
    )
    addCheck(
      checks,
      "component.s03-addendum",
      addendumS03.assessment === "pass",
      addendumS03.error ?? "The S03 addendum used the same explicit validated next binary.",
    )
    addCheck(
      checks,
      "component.s10-operational-smoke",
      operationalSmoke.assessment === "pass",
      operationalSmoke.error ?? "Operational human/JSON, files, marker and alias checks passed.",
    )
    addCheck(
      checks,
      "component.s10-migration-coexistence",
      migrationCoexistence.assessment === "pass",
      migrationCoexistence.error ?? "Coexistence and inspect/apply/rollback checks passed.",
    )
    for (const linked of linkedTests) {
      addCheck(
        checks,
        `component.${linked.id}`,
        linked.assessment === "pass",
        `${linked.files.length} hashed test files executed with exit ${linked.invocation.exitCode} (timeout=${linked.invocation.timedOut}).`,
      )
    }
    addCheck(
      checks,
      "binary.legacy-immutable",
      legacySha256After === legacy.sha256Before,
      "The legacy binary hash is unchanged after every probe and migration operation.",
    )
    addCheck(
      checks,
      "binary.next-immutable",
      nextSha256After === next.sha256Before,
      "The next binary hash is unchanged after every probe and migration operation.",
    )
    addCheck(
      checks,
      "source.immutable",
      sourceSha256After === sourceSha256Before,
      "No component or linked executable test changed the current source fingerprint.",
    )

    const evidenceAssessments = new Map<string, S10Assessment>([
      [
        "binary.identity-help",
        [legacyVersion, legacyHelp, nextVersion, nextHelp].every(
          (item) => item.exitCode === 0 && !item.timedOut,
        ) && flagProbes.checks.every((check) => check.assessment === "pass")
          ? "pass"
          : "regression",
      ],
      ["s01.baseline", baselineS01.assessment],
      ["s03.addendum", addendumS03.assessment],
      ["s10.operational-smoke", operationalSmoke.assessment],
      ["s10.migration-coexistence", migrationCoexistence.assessment],
      ...linkedTests.map((item) => [item.id, item.assessment] as const),
    ])
    const surfaces = [
      ...S10_LEGACY_COMMAND_CONTRACT.map((item) =>
        surfaceAssessment("command", item, evidenceAssessments),
      ),
      ...S10_LEGACY_FLAG_CONTRACT.map((item) =>
        surfaceAssessment("flag", item, evidenceAssessments),
      ),
    ]
    const surfaceRegressions = surfaces.filter((item) => item.assessment === "regression").length
    const checkRegressions = checks.filter((check) => check.assessment === "regression").length
    const retainedForDiagnosis =
      options.keepWorkspace || checkRegressions > 0 || surfaceRegressions > 0

    report = {
      schemaVersion: 1,
      suite: SUITE,
      generatedAt: new Date().toISOString(),
      comparisonMode: "legacy-vs-next",
      environment: {
        platform: process.platform,
        architecture: process.arch,
        bunVersion: Bun.version,
        nativeTarget: nativeTarget(),
      },
      isolation: {
        disposableRoot: "<S10_TEMP_ROOT>",
        spacesAndUnicode: true,
        inheritedEnvironment: "allowlist",
        legacyAndNextConfigSeparated: true,
        windowsHide: true,
        retainedForDiagnosis,
      },
      source: {
        sha256Before: sourceSha256Before,
        sha256After: sourceSha256After,
        immutableDuringHarness: sourceSha256Before === sourceSha256After,
      },
      binaries: {
        legacy: {
          role: "legacy",
          path: portablePath(legacy.path, context),
          sha256Before: legacy.sha256Before,
          sha256After: legacySha256After,
          immutable: legacy.sha256Before === legacySha256After,
          size: legacy.size,
          version: legacyVersion,
          help: legacyHelp,
        },
        next: {
          role: "next",
          path: portablePath(next.path, context),
          sha256Before: next.sha256Before,
          sha256After: nextSha256After,
          immutable: next.sha256Before === nextSha256After,
          size: next.size,
          version: nextVersion,
          help: nextHelp,
          buildMetadata: {
            target: validatedNext.metadata.target,
            version: validatedNext.metadata.version,
            artifactSha256: validatedNext.metadata.sha256,
            sourceSha256: validatedNext.metadata.sourceSha256,
            metadataPath: portablePath(validatedNext.metadataPath, context),
          },
        },
        distinct: !sameBinary(legacy, next),
      },
      contract: {
        closedInventory,
        coverage: S10_EVIDENCE_COVERAGE,
        surfaces,
      },
      components: {
        baselineS01,
        addendumS03,
        operationalSmoke,
        migrationCoexistence,
        linkedTests,
      },
      legacyFlagProbes: flagProbes.invocations,
      checks,
      summary: {
        classifications: classificationCounts(surfaces),
        checks: checks.length,
        passed: checks.length - checkRegressions,
        regressions: checkRegressions,
        surfaceRegressions,
      },
    }
    actualTemporaryRoots.set(report, temporaryRoot)
    return report
  } finally {
    const shouldKeep =
      options.keepWorkspace ||
      !report ||
      report.summary.regressions > 0 ||
      report.summary.surfaceRegressions > 0
    if (!shouldKeep) await removeTemporaryRoot(temporaryRoot)
  }
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ")
}

export function renderS10CompatibilityMarkdown(report: S10CompatibilityReport): string {
  const componentRows = [
    report.components.baselineS01,
    report.components.addendumS03,
    report.components.operationalSmoke,
    report.components.migrationCoexistence,
  ]
    .map(
      (component) =>
        `| ${component.id} | ${component.assessment} | ${markdownCell(component.error ?? "executed report attached")} |`,
    )
    .join("\n")
  const linkedRows = report.components.linkedTests
    .map(
      (item) =>
        `| ${item.id} | ${item.assessment} | ${item.files.map((file) => file.path).join("<br>")} | ${item.coverage.join(", ")} | ${item.invocation.exitCode} |`,
    )
    .join("\n")
  const surfaceRows = report.contract.surfaces
    .map(
      (item) =>
        `| ${item.kind} | ${item.id} | ${item.legacySpellings.map((value) => `\`${value}\``).join("<br>")} | ${markdownCell(item.nextContract)} | ${item.classification} | ${item.assessment} | ${item.evidence.join("<br>")} |`,
    )
    .join("\n")
  const checkRows = report.checks
    .map((check) => `| ${check.id} | ${check.assessment} | ${markdownCell(check.evidence)} |`)
    .join("\n")
  return `# S10 — Compatibility harness operacional e migração

Este relatório é aditivo. Ele não substitui o baseline S01 nem o addendum S03: os dois foram
executados como componentes e seus relatórios completos estão embutidos no JSON S10. A classificação
de produto (compatible/changed/deprecated/removed) permanece separada do assessment executável
(pass/regression); uma decisão \`changed\` pode e deve receber \`regression\` quando sua evidência falha.

## Identidade da execução

- Gerado em: ${report.generatedAt}
- Host: ${report.environment.platform}/${report.environment.architecture}
- Target nativo: ${report.environment.nativeTarget}
- Legacy: \`${report.binaries.legacy.path}\` — \`${report.binaries.legacy.sha256Before}\`
- Next: \`${report.binaries.next.path}\` — \`${report.binaries.next.sha256Before}\`
- Source antes/depois: \`${report.source.sha256Before}\` / \`${report.source.sha256After}\`
- Binários distintos e imutáveis: ${report.binaries.distinct && report.binaries.legacy.immutable && report.binaries.next.immutable ? "yes" : "no"}
- Workspace descartável com espaço/Unicode, env allowlist, configs isolados e subprocessos windowsHide: yes
- Retido para diagnóstico: ${report.isolation.retainedForDiagnosis ? "yes" : "no"}

## Componentes executados

| Componente | Assessment | Evidência/erro |
| --- | --- | --- |
${componentRows}

## Suites vinculadas realmente executadas

| Suite | Assessment | Arquivos com hash no JSON | Cobertura | Exit |
| --- | --- | --- | --- | ---: |
${linkedRows}

Os vínculos acima não são citações de source: o coordenador executou cada arquivo via Bun oculto,
capturou exit/stdout/stderr e registrou SHA-256 de cada teste. Assim, skips/fast/no-change/retry/
fail-fast/parallel/Git/security/sandbox/signal só recebem \`pass\` após execução real.

## Inventário fechado do legado

- Contratos de comando: ${report.contract.closedInventory.commands}
- Spellings de comando: ${report.contract.closedInventory.commandSpellings}
- Grupos de flags: ${report.contract.closedInventory.flagGroups}
- Spellings de flags: ${report.contract.closedInventory.flagSpellings}

| Tipo | ID | Ralph v1 | Ralph v2 | Classificação | Assessment | Evidência executável |
| --- | --- | --- | --- | --- | --- | --- |
${surfaceRows}

Cada spelling de flag também foi sondado no binário legado explícito antes de \`--help\`; flag
desconhecida, valor ausente ou timeout vira regression. O passthrough \`--\` usa um dry-run isolado
porque, por definição, ele impede que um \`--help\` posterior seja interpretado pelo parser.

## Checks agregados

| Check | Assessment | Evidência |
| --- | --- | --- |
${checkRows}

## Resultado

- Checks: ${report.summary.passed}/${report.summary.checks}
- Regressions de checks: ${report.summary.regressions}
- Superfícies com regression: ${report.summary.surfaceRegressions}
- Classificações: compatible=${report.summary.classifications.compatible}, changed=${report.summary.classifications.changed}, deprecated=${report.summary.classifications.deprecated}, removed=${report.summary.classifications.removed}

O JSON irmão contém comandos/argv, exit, timeout, stdout/stderr normalizados e seus hashes, snapshots
de arquivos, hashes de marker/origem/binários, eventos/report do S03, resultados de sinal dos testes
vinculados e o ciclo completo inspect/apply/rollback. S10.09/S10.10 só podem ser fechadas após este
relatório ser gerado por standalones frescos e revisado sem regressions.
`
}

function assertPortableS10Report(report: S10CompatibilityReport, projectRoot: string): void {
  const serialized = JSON.stringify(report)
  const forbidden = [
    resolve(projectRoot),
    slash(resolve(projectRoot)),
    actualTemporaryRoots.get(report) ?? "",
    slash(actualTemporaryRoots.get(report) ?? ""),
    SUBPROCESS_SECRET_CANARY,
  ].filter((value) => value.length > 0)
  for (const value of forbidden) {
    if (serialized.includes(value)) {
      throw new Error("S10 report retained an absolute project/temp path or secret canary")
    }
  }
}

export async function writeS10CompatibilityReports(
  report: S10CompatibilityReport,
  outputDirectory: string,
  projectRoot = resolve(import.meta.dir, ".."),
): Promise<{ json: string; markdown: string }> {
  assertPortableS10Report(report, projectRoot)
  const directory = resolve(outputDirectory)
  await mkdir(directory, { recursive: true })
  const json = join(directory, "s10-report.json")
  const markdown = join(directory, "s10-report.md")
  await writeFileAtomic(json, `${JSON.stringify(report, null, 2)}\n`, {
    overwrite: await Bun.file(json).exists(),
  })
  await writeFileAtomic(markdown, renderS10CompatibilityMarkdown(report), {
    overwrite: await Bun.file(markdown).exists(),
  })
  return { json, markdown }
}

export function conciseS10CompatibilityResult(
  report: S10CompatibilityReport,
  reports: { json: string; markdown: string } | null,
): Record<string, unknown> {
  return {
    suite: report.suite,
    generatedAt: report.generatedAt,
    legacySha256: report.binaries.legacy.sha256Before,
    nextSha256: report.binaries.next.sha256Before,
    sourceSha256: report.source.sha256Before,
    summary: report.summary,
    reports,
    retainedWorkspace: report.isolation.retainedForDiagnosis
      ? (actualTemporaryRoots.get(report) ?? "retained but unavailable")
      : null,
  }
}
