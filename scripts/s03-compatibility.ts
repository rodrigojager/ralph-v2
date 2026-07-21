import { realpathSync } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  getRunReport,
  listAttempts,
  listGateResults,
  listRuns,
  workspaceLayout,
  writeFileAtomic,
} from "@ralph/persistence"
import { nativeTarget, sha256File, validateStandaloneArtifact } from "./build-artifact"
import {
  assertNoSecretLeak,
  type CapturedProcess,
  isolatedChildEnvironment,
  runCapturedProcess,
  SUBPROCESS_SECRET_CANARY,
} from "./subprocess"

const SUITE = "s03-orchestration-addendum" as const
const TEMPORARY_PREFIX = "ralph-v2-compat-s03-"
const COMMAND_TIMEOUT_MS = 30_000
const BUILD_TIMEOUT_MS = 120_000
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu
const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})\b/gu
const SHA256_PATTERN = /\b[a-f0-9]{64}\b/giu

const REQUIRED_HELP_COMMANDS = [
  "once",
  "run",
  "loop",
  "status run",
  "events",
  "report last",
  "report show",
] as const

const REQUIRED_S03_FLAGS = [
  "--prd",
  "--executor-profile",
  "--task",
  "--run-id",
  "--wiggum",
  "--dry-run",
  "--fail-fast",
  "--max-tasks",
  "--retry-delay",
  "--max-iterations",
  "--max-model-calls",
  "--no-change-policy",
  "--no-change-max-retries",
  "--skip-tests",
  "--skip-lint",
  "--skip-gates",
  "--fast",
  "--no-commit",
] as const

type JsonObject = Record<string, unknown>

export type S03HarnessOptions = {
  outputDirectory: string
  writeReports: boolean
  printJson: boolean
  nextBinary?: string
}

type Check = {
  id: string
  passed: boolean
  evidence: string
}

type CommandEvidence = {
  id: string
  composition: "production" | "test"
  invocation: string[]
  exitCode: number
  timedOut: boolean
  resultOk: boolean | null
  reportedCommand: string | null
  diagnosticCodes: string[]
  normalizedStdoutSha256: string
  normalizedStderrSha256: string
}

export type S03CompatibilityReport = {
  schemaVersion: 1
  suite: typeof SUITE
  relationship: {
    baseline: "docs/compatibility/s01-report.json"
    additive: true
    rationale: string
  }
  normalization: string[]
  environment: {
    platform: NodeJS.Platform
    architecture: string
    bunVersion: string
  }
  artifacts: {
    product: {
      kind: "productionStandalone"
      releaseEligible: true
      target: string
      artifact: string
      metadata: string
      sha256: string
      sourceSha256: string
      sourceFresh: true
    }
    testComposition: {
      kind: "testComposition"
      releaseEligible: false
      entrypoint: "tests/support/fixture-cli.ts"
      artifact: string
      sha256: string
      registration: string
    }
  }
  commands: CommandEvidence[]
  checks: Check[]
  summary: {
    total: number
    passed: number
    failed: number
    regressions: number
  }
}

type CommandCapture = {
  process: CapturedProcess
  result: JsonObject | null
  evidence: CommandEvidence
}

type NormalizationContext = {
  projectRoot: string
  temporaryRoot: string
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a path value`)
  return value
}

export function parseS03HarnessOptions(
  argv: readonly string[],
  projectRoot = resolve(import.meta.dir, ".."),
): S03HarnessOptions {
  const options: S03HarnessOptions = {
    outputDirectory: join(projectRoot, "docs", "compatibility"),
    writeReports: true,
    printJson: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case "--next-binary":
        options.nextBinary = resolve(requireValue(argv, index, argument))
        index += 1
        break
      case "--output-dir":
        options.outputDirectory = resolve(requireValue(argv, index, argument))
        index += 1
        break
      case "--no-write":
        options.writeReports = false
        break
      case "--json":
        options.printJson = true
        break
      default:
        throw new Error(`Unknown S03 compatibility harness option: ${argument ?? "<missing>"}`)
    }
  }
  return options
}

function slash(path: string): string {
  return path.replaceAll("\\", "/")
}

function portableProductPath(path: string, projectRoot: string): string {
  const absolute = resolve(path)
  const segment = relative(projectRoot, absolute)
  if (segment && segment !== ".." && !segment.startsWith(`..${sep}`) && !isAbsolute(segment)) {
    return `<PROJECT_ROOT>/${slash(segment)}`
  }
  return `<NEXT_BINARY_DIR>/${basename(absolute)}`
}

function replacePath(value: string, path: string, marker: string): string {
  const candidates = new Set([path, slash(path), path.replaceAll("/", "\\")])
  let output = value
  for (const candidate of [...candidates].sort((left, right) => right.length - left.length)) {
    output = output.replaceAll(candidate, marker)
  }
  return output
}

function normalizeString(value: string, context: NormalizationContext): string {
  return replacePath(
    replacePath(value, context.temporaryRoot, "<TEMP_ROOT>"),
    context.projectRoot,
    "<PROJECT_ROOT>",
  )
    .replace(ISO_TIMESTAMP_PATTERN, "<TIMESTAMP>")
    .replace(UUID_PATTERN, "<UUID>")
    .replace(SHA256_PATTERN, "<SHA256>")
}

function normalizeValue(value: unknown, context: NormalizationContext, key?: string): unknown {
  if (key === "durationMs" && typeof value === "number") return "<DURATION_MS>"
  if (typeof value === "string") return normalizeString(value, context)
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, context))
  if (value !== null && typeof value === "object") {
    const output: JsonObject = {}
    for (const entry of Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))) {
      output[entry] = normalizeValue((value as JsonObject)[entry], context, entry)
    }
    return output
  }
  return value
}

function sha256Text(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function normalizedStreamHash(value: string, context: NormalizationContext): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return sha256Text("")
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return sha256Text(JSON.stringify(normalizeValue(parsed, context)))
  } catch {
    return sha256Text(normalizeString(value, context))
  }
}

function object(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`)
  }
  return value as JsonObject
}

function nestedObject(value: JsonObject, key: string, context: string): JsonObject {
  return object(value[key], `${context}.${key}`)
}

function diagnosticCodes(result: JsonObject | null): string[] {
  if (!result || !Array.isArray(result.diagnostics)) return []
  return result.diagnostics
    .map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined
      const code = (item as JsonObject).code
      return typeof code === "string" ? code : undefined
    })
    .filter((code): code is string => code !== undefined)
    .sort((left, right) => left.localeCompare(right, "en"))
}

function parseJsonResult(capture: CapturedProcess, id: string): JsonObject | null {
  const output = capture.stdout.trim()
  if (!output) return null
  try {
    return object(JSON.parse(output) as unknown, `${id} stdout`)
  } catch (error) {
    throw new Error(`${id} did not emit one JSON command result: ${String(error)}`)
  }
}

async function captureCommand(input: {
  id: string
  composition: CommandEvidence["composition"]
  executable: string
  portableExecutable: string
  arguments: readonly string[]
  cwd: string
  environment: Record<string, string>
  normalization: NormalizationContext
  json: boolean
}): Promise<CommandCapture> {
  const capture = await runCapturedProcess([input.executable, ...input.arguments], {
    cwd: input.cwd,
    environment: input.environment,
    timeoutMs: COMMAND_TIMEOUT_MS,
  })
  assertNoSecretLeak(
    [capture.stdout, capture.stderr],
    [SUBPROCESS_SECRET_CANARY],
    `S03 compatibility command ${input.id}`,
  )
  const result = input.json ? parseJsonResult(capture, input.id) : null
  const ok = result?.ok
  const reportedCommand = result?.command
  return {
    process: capture,
    result,
    evidence: {
      id: input.id,
      composition: input.composition,
      invocation: [
        input.portableExecutable,
        ...input.arguments.map((argument) => normalizeString(argument, input.normalization)),
      ],
      exitCode: capture.exitCode,
      timedOut: capture.timedOut,
      resultOk: typeof ok === "boolean" ? ok : null,
      reportedCommand: typeof reportedCommand === "string" ? reportedCommand : null,
      diagnosticCodes: diagnosticCodes(result),
      normalizedStdoutSha256: normalizedStreamHash(capture.stdout, input.normalization),
      normalizedStderrSha256: normalizedStreamHash(capture.stderr, input.normalization),
    },
  }
}

function addCheck(checks: Check[], id: string, passed: boolean, evidence: string): void {
  checks.push({ id, passed, evidence })
}

function containsEvery(haystack: string, needles: readonly string[]): string[] {
  const normalized = haystack.toLocaleLowerCase("en")
  return needles.filter((needle) => !normalized.includes(needle.toLocaleLowerCase("en")))
}

function assertSafeTemporaryRoot(path: string): void {
  const temporaryRoot = realpathSync(resolve(tmpdir()))
  const target = resolve(path)
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith(TEMPORARY_PREFIX)) {
    throw new Error(`Refusing to remove unsafe S03 compatibility path: ${target}`)
  }
}

async function removeTemporaryRoot(path: string): Promise<void> {
  assertSafeTemporaryRoot(path)
  const retryable = new Set(["EBUSY", "EPERM", "ENOTEMPTY"])
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rm(path, { force: true, recursive: true, maxRetries: 0 })
      return
    } catch (error) {
      lastError = error
      if (!retryable.has((error as NodeJS.ErrnoException).code ?? "") || attempt === 5) break
      await Bun.sleep(50 * 2 ** attempt)
    }
  }
  throw lastError
}

async function compileTestComposition(
  projectRoot: string,
  temporaryRoot: string,
  environment: Record<string, string>,
): Promise<string> {
  const directory = join(temporaryRoot, "fixture-composition")
  await mkdir(directory, { recursive: true })
  const extension = process.platform === "win32" ? ".exe" : ""
  const output = join(directory, `ralph-fixture${extension}`)
  const capture = await runCapturedProcess(
    [
      process.execPath,
      "build",
      "tests/support/fixture-cli.ts",
      "--compile",
      // This composition is test-only and always executes on this host. Omitting
      // an explicit native target makes Bun embed its current runtime instead of
      // downloading the same version into the harness's intentionally empty cache.
      "--packages=bundle",
      "--allow-unresolved=",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-package-json",
      "--no-compile-autoload-tsconfig",
      `--outfile=${output}`,
    ],
    { cwd: projectRoot, environment, timeoutMs: BUILD_TIMEOUT_MS },
  )
  assertNoSecretLeak(
    [capture.stdout, capture.stderr],
    [SUBPROCESS_SECRET_CANARY],
    "S03 test composition build",
  )
  if (capture.timedOut || capture.exitCode !== 0) {
    throw new Error(
      `Could not compile the S03 test composition (exit ${capture.exitCode}, timeout ${capture.timedOut}): ${capture.stderr.trim()}`,
    )
  }
  const metadata = await lstat(output)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("S03 test composition output must be a regular, non-linked file")
  }
  return realpath(output)
}

function commandSucceeded(capture: CommandCapture, command: string): boolean {
  return (
    !capture.process.timedOut &&
    capture.process.exitCode === 0 &&
    capture.result?.ok === true &&
    capture.result.command === command
  )
}

function readRunId(capture: CommandCapture): string {
  const runId = capture.result?.runId
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("The fixture once command did not return a run ID")
  }
  return runId
}

function scalarEquals(record: JsonObject, key: string, expected: unknown): boolean {
  return record[key] === expected
}

function portableTemporaryArtifact(path: string, temporaryRoot: string): string {
  const segment = relative(temporaryRoot, path)
  if (!segment || segment.startsWith(`..${sep}`) || segment === ".." || isAbsolute(segment)) {
    throw new Error(`Expected a temporary artifact inside the harness root: ${path}`)
  }
  return `<TEMP_ROOT>/${slash(segment)}`
}

export async function runS03CompatibilityHarness(
  projectRoot = resolve(import.meta.dir, ".."),
  runtime: { nextBinary?: string } = {},
): Promise<S03CompatibilityReport> {
  const root = await realpath(projectRoot)
  const target = nativeTarget()
  const extension = process.platform === "win32" ? ".exe" : ""
  const productCandidate = runtime.nextBinary
    ? resolve(runtime.nextBinary)
    : join(root, "dist", "standalone", target, `ralph${extension}`)
  const product = await validateStandaloneArtifact(productCandidate, root, target)
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), TEMPORARY_PREFIX)))
  assertSafeTemporaryRoot(temporaryRoot)
  const normalization = { projectRoot: root, temporaryRoot }
  const checks: Check[] = []
  const commands: CommandEvidence[] = []

  try {
    const buildEnvironment = await isolatedChildEnvironment(
      join(temporaryRoot, "environments", "build"),
    )
    const productExecutable = await realpath(product.binary)
    const productPortable = portableProductPath(productExecutable, root)
    addCheck(
      checks,
      "product.artifact.fresh",
      product.metadata.sha256.toLowerCase() === (await sha256File(productExecutable)).toLowerCase(),
      "The native production standalone passed artifact, version and current-source fingerprint validation.",
    )

    const helpRoot = join(temporaryRoot, "product-help")
    await mkdir(helpRoot, { recursive: true })
    const helpEnvironment = await isolatedChildEnvironment(
      join(temporaryRoot, "environments", "product-help"),
    )
    const help = await captureCommand({
      id: "product.help",
      composition: "production",
      executable: productExecutable,
      portableExecutable: productPortable,
      arguments: ["help", "--format", "human", "--no-color"],
      cwd: helpRoot,
      environment: helpEnvironment,
      normalization,
      json: false,
    })
    commands.push(help.evidence)
    const missingCommands = containsEvery(help.process.stdout, REQUIRED_HELP_COMMANDS)
    const missingFlags = containsEvery(help.process.stdout, REQUIRED_S03_FLAGS)
    addCheck(
      checks,
      "product.help.command-surface",
      help.process.exitCode === 0 && !help.process.timedOut && missingCommands.length === 0,
      missingCommands.length === 0
        ? "Help exposes once, run, loop, Wiggum, run status, events and both report commands."
        : `Missing command tokens: ${missingCommands.join(", ")}`,
    )
    addCheck(
      checks,
      "product.help.s03-flags",
      help.process.exitCode === 0 && !help.process.timedOut && missingFlags.length === 0,
      missingFlags.length === 0
        ? `Help exposes all ${REQUIRED_S03_FLAGS.length} required S03 execution flags.`
        : `Missing S03 flag tokens: ${missingFlags.join(", ")}`,
    )

    const negativeRoot = join(temporaryRoot, "product-fake-negative")
    await cp(join(root, "tests", "fixtures", "execution", "single-pass"), negativeRoot, {
      recursive: true,
    })
    const negativeEnvironment = await isolatedChildEnvironment(
      join(temporaryRoot, "environments", "product-fake-negative"),
    )
    const negativeInit = await captureCommand({
      id: "product.fake.init",
      composition: "production",
      executable: productExecutable,
      portableExecutable: productPortable,
      arguments: ["init", "--format", "json", "--no-color", "--non-interactive"],
      cwd: negativeRoot,
      environment: negativeEnvironment,
      normalization,
      json: true,
    })
    commands.push(negativeInit.evidence)
    if (!commandSucceeded(negativeInit, "init")) {
      throw new Error("The production standalone could not initialize its negative fixture")
    }
    const negativePrd = join(negativeRoot, "PRD.md")
    const markerBefore = await readFile(negativePrd, "utf8")
    const fakeAttempt = await captureCommand({
      id: "product.fake.once",
      composition: "production",
      executable: productExecutable,
      portableExecutable: productPortable,
      arguments: [
        "once",
        "--format",
        "json",
        "--no-color",
        "--non-interactive",
        "--executor-profile",
        "fake",
        "--no-commit",
      ],
      cwd: negativeRoot,
      environment: negativeEnvironment,
      normalization,
      json: true,
    })
    commands.push(fakeAttempt.evidence)
    const negativeStatus = await captureCommand({
      id: "product.fake.status-run",
      composition: "production",
      executable: productExecutable,
      portableExecutable: productPortable,
      arguments: ["status", "run", "--format", "json", "--no-color"],
      cwd: negativeRoot,
      environment: negativeEnvironment,
      normalization,
      json: true,
    })
    commands.push(negativeStatus.evidence)
    const negativeRuns = listRuns(workspaceLayout(negativeRoot).ledger)
    const negativeStatusData = negativeStatus.result
      ? nestedObject(negativeStatus.result, "data", "product.fake.status-run")
      : {}
    const markerAfter = await readFile(negativePrd, "utf8")
    addCheck(
      checks,
      "product.fake.exit-contract",
      fakeAttempt.process.exitCode === 6 && !fakeAttempt.process.timedOut,
      `The production standalone rejected the fake executor profile with exit ${fakeAttempt.process.exitCode}.`,
    )
    addCheck(
      checks,
      "product.fake.diagnostic",
      fakeAttempt.evidence.diagnosticCodes.includes("RALPH_EXECUTOR_PROFILE_UNAVAILABLE"),
      "The rejection emitted RALPH_EXECUTOR_PROFILE_UNAVAILABLE.",
    )
    addCheck(
      checks,
      "product.fake.no-run",
      negativeRuns.length === 0 && negativeStatusData.run === null,
      `The ledger and public status-run view both report zero persisted runs (${negativeRuns.length}).`,
    )
    addCheck(
      checks,
      "product.fake.marker-unchanged",
      markerBefore === markerAfter && markerAfter.includes("- [ ] **deliver-capability"),
      "The unavailable profile left the complete PRD bytes and pending marker unchanged.",
    )

    const fixtureExecutable = await compileTestComposition(root, temporaryRoot, buildEnvironment)
    const fixtureSha256 = await sha256File(fixtureExecutable)
    addCheck(
      checks,
      "test-composition.classification",
      fixtureExecutable !== productExecutable,
      "The fixture CLI was independently compiled and is explicitly ineligible for release.",
    )

    const fixtureRoot = join(temporaryRoot, "test-composition-flow")
    await cp(join(root, "tests", "fixtures", "execution", "single-pass"), fixtureRoot, {
      recursive: true,
    })
    const fixtureEnvironment = await isolatedChildEnvironment(
      join(temporaryRoot, "environments", "test-composition-flow"),
    )
    fixtureEnvironment.RALPH_TEST_BACKEND_SCRIPT = join(fixtureRoot, "backend.json")
    const fixturePortable = portableTemporaryArtifact(fixtureExecutable, temporaryRoot)
    const fixtureInit = await captureCommand({
      id: "test.init",
      composition: "test",
      executable: fixtureExecutable,
      portableExecutable: fixturePortable,
      arguments: ["init", "--format", "json", "--no-color", "--non-interactive"],
      cwd: fixtureRoot,
      environment: fixtureEnvironment,
      normalization,
      json: true,
    })
    commands.push(fixtureInit.evidence)
    if (!commandSucceeded(fixtureInit, "init")) {
      throw new Error("The test composition could not initialize its fixture")
    }
    const fixtureOnce = await captureCommand({
      id: "test.once",
      composition: "test",
      executable: fixtureExecutable,
      portableExecutable: fixturePortable,
      arguments: [
        "once",
        "--format",
        "json",
        "--no-color",
        "--non-interactive",
        "--executor-profile",
        "fixture-executor",
        "--no-commit",
      ],
      cwd: fixtureRoot,
      environment: fixtureEnvironment,
      normalization,
      json: true,
    })
    commands.push(fixtureOnce.evidence)
    const runId = readRunId(fixtureOnce)
    const fixtureStatus = await captureCommand({
      id: "test.status-run",
      composition: "test",
      executable: fixtureExecutable,
      portableExecutable: fixturePortable,
      arguments: ["status", "run", "--run-id", runId, "--format", "json", "--no-color"],
      cwd: fixtureRoot,
      environment: fixtureEnvironment,
      normalization,
      json: true,
    })
    commands.push(fixtureStatus.evidence)
    const fixtureEvents = await captureCommand({
      id: "test.events",
      composition: "test",
      executable: fixtureExecutable,
      portableExecutable: fixturePortable,
      arguments: ["events", "--run-id", runId, "--format", "json", "--no-color"],
      cwd: fixtureRoot,
      environment: fixtureEnvironment,
      normalization,
      json: true,
    })
    commands.push(fixtureEvents.evidence)
    const fixtureReport = await captureCommand({
      id: "test.report-last",
      composition: "test",
      executable: fixtureExecutable,
      portableExecutable: fixturePortable,
      arguments: ["report", "last", "--format", "json", "--no-color"],
      cwd: fixtureRoot,
      environment: fixtureEnvironment,
      normalization,
      json: true,
    })
    commands.push(fixtureReport.evidence)

    const fixtureLayout = workspaceLayout(fixtureRoot)
    const fixtureRuns = listRuns(fixtureLayout.ledger)
    const attempts = listAttempts(fixtureLayout.ledger, { runId })
    const gates = attempts[0] ? listGateResults(fixtureLayout.ledger, attempts[0].id) : []
    const persistedReport = getRunReport(fixtureLayout.ledger, runId)?.report
    const statusData = fixtureStatus.result
      ? nestedObject(fixtureStatus.result, "data", "test.status-run")
      : {}
    const progress = statusData.progress
      ? object(statusData.progress, "test.status-run.data.progress")
      : {}
    const eventsData = fixtureEvents.result
      ? nestedObject(fixtureEvents.result, "data", "test.events")
      : {}
    const reportData = fixtureReport.result
      ? nestedObject(fixtureReport.result, "data", "test.report-last")
      : {}
    const reportCounters = reportData.counters
      ? object(reportData.counters, "test.report-last.data.counters")
      : {}

    addCheck(
      checks,
      "test-flow.command-sequence",
      commandSucceeded(fixtureOnce, "once") &&
        commandSucceeded(fixtureStatus, "status.run") &&
        commandSucceeded(fixtureEvents, "events") &&
        commandSucceeded(fixtureReport, "report.last"),
      "The packaged test composition completed init -> once -> status run -> events -> report last.",
    )
    addCheck(
      checks,
      "test-flow.deliverable",
      (await readFile(join(fixtureRoot, "product", "capability.txt"), "utf8")) === "delivered",
      "The vertical slice produced product/capability.txt with the exact value delivered.",
    )
    addCheck(
      checks,
      "test-flow.marker",
      (await readFile(join(fixtureRoot, "PRD.md"), "utf8")).includes("- [x] **deliver-capability"),
      "The authority-owned PRD marker reached [x] only after verification.",
    )
    addCheck(
      checks,
      "test-flow.progress",
      scalarEquals(progress, "completed", 1) &&
        scalarEquals(progress, "total", 1) &&
        scalarEquals(progress, "ratio", 1),
      "Public status reports deterministic progress 1/1 (ratio 1).",
    )
    addCheck(
      checks,
      "test-flow.events",
      typeof eventsData.count === "number" &&
        eventsData.count > 0 &&
        Array.isArray(eventsData.events),
      `Public events returned ${typeof eventsData.count === "number" ? eventsData.count : 0} persisted records.`,
    )
    addCheck(
      checks,
      "test-flow.gate",
      gates.length === 1 && gates[0]?.result.status === "passed",
      `The persisted blocking command gate status is ${gates[0]?.result.status ?? "missing"}.`,
    )
    addCheck(
      checks,
      "test-flow.report",
      fixtureRuns.length === 1 &&
        persistedReport?.status === "completed" &&
        reportData.status === "completed" &&
        scalarEquals(reportCounters, "tasksCompleted", 1) &&
        scalarEquals(reportCounters, "attempts", 1) &&
        scalarEquals(reportCounters, "modelCalls", 1),
      "The persisted and public reports agree on completed status, one task, one attempt and one model call.",
    )

    const failed = checks.filter((check) => !check.passed).length
    const report: S03CompatibilityReport = {
      schemaVersion: 1,
      suite: SUITE,
      relationship: {
        baseline: "docs/compatibility/s01-report.json",
        additive: true,
        rationale:
          "S03 adds orchestration evidence without reclassifying or overwriting the S01 legacy compatibility baseline.",
      },
      normalization: [
        "project paths -> <PROJECT_ROOT>",
        "temporary harness paths -> <TEMP_ROOT>",
        "RFC 4122 UUIDs -> <UUID>",
        "ISO 8601 timestamps -> <TIMESTAMP>",
        "SHA-256 values inside command output -> <SHA256>",
        "measured durationMs values -> <DURATION_MS>",
        "only normalized output hashes are retained; raw output and environment values are excluded",
      ],
      environment: {
        platform: process.platform,
        architecture: process.arch,
        bunVersion: Bun.version,
      },
      artifacts: {
        product: {
          kind: "productionStandalone",
          releaseEligible: true,
          target: product.metadata.target,
          artifact: portableProductPath(product.binary, root),
          metadata: portableProductPath(product.metadataPath, root),
          sha256: product.metadata.sha256,
          sourceSha256: product.metadata.sourceSha256,
          sourceFresh: true,
        },
        testComposition: {
          kind: "testComposition",
          releaseEligible: false,
          entrypoint: "tests/support/fixture-cli.ts",
          artifact: portableTemporaryArtifact(fixtureExecutable, temporaryRoot),
          sha256: fixtureSha256,
          registration:
            "The scripted backend is registered only by this test entrypoint and is absent from the production composition root.",
        },
      },
      commands,
      checks,
      summary: {
        total: checks.length,
        passed: checks.length - failed,
        failed,
        regressions: failed,
      },
    }
    assertPortableReport(report, root, temporaryRoot)
    return report
  } finally {
    await removeTemporaryRoot(temporaryRoot)
  }
}

function assertPortableReport(
  report: S03CompatibilityReport,
  projectRoot: string,
  temporaryRoot: string,
): void {
  const serialized = JSON.stringify(report)
  const forbidden = [
    projectRoot,
    slash(projectRoot),
    temporaryRoot,
    slash(temporaryRoot),
    SUBPROCESS_SECRET_CANARY,
  ]
  for (const value of forbidden) {
    if (serialized.includes(value)) {
      throw new Error("S03 report retained an absolute path or secret canary")
    }
  }
  if (
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu.test(
      serialized,
    ) ||
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})\b/u.test(serialized)
  ) {
    throw new Error("S03 report retained a volatile UUID or timestamp")
  }
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ")
}

export function renderS03CompatibilityMarkdown(report: S03CompatibilityReport): string {
  const commandRows = report.commands
    .map(
      (command) =>
        `| ${command.id} | ${command.composition} | ${command.exitCode} | ${command.timedOut ? "yes" : "no"} | ${command.resultOk === null ? "n/a" : command.resultOk} | ${markdownCell(command.diagnosticCodes.join(", ") || "none")} | \`${command.normalizedStdoutSha256}\` |`,
    )
    .join("\n")
  const checkRows = report.checks
    .map(
      (check) =>
        `| ${check.id} | ${check.passed ? "pass" : "regression"} | ${markdownCell(check.evidence)} |`,
    )
    .join("\n")
  return `# S03 orchestration compatibility addendum

This generated addendum is intentionally separate from the S01 legacy compatibility baseline.
It proves the packaged S03 orchestration surface and does not overwrite or reinterpret
\`s01-report.json\`.

## Artifact boundary

- Production artifact: \`${report.artifacts.product.artifact}\`
- Production target: \`${report.artifacts.product.target}\`
- Production SHA-256: \`${report.artifacts.product.sha256}\`
- Current source fingerprint: \`${report.artifacts.product.sourceSha256}\`
- Production release eligible: \`true\`
- Test entrypoint: \`${report.artifacts.testComposition.entrypoint}\`
- Test composition SHA-256: \`${report.artifacts.testComposition.sha256}\`
- Test composition release eligible: \`false\`

The production standalone passed the build-metadata, artifact-hash and current-source
fingerprint checks before any scenario ran. The scripted backend exists only in the independently
compiled test composition; it is evidence infrastructure, never a release artifact.

## Command evidence

Only portable invocations, exit contracts, diagnostic codes and hashes of normalized output are
stored. Raw output, absolute paths, environment values, UUIDs, timestamps and measured durations
are not retained.

| Command | Composition | Exit | Timed out | Result ok | Diagnostics | Normalized stdout SHA-256 |
| --- | --- | ---: | --- | --- | --- | --- |
${commandRows}

## Invariants

| Invariant | Assessment | Evidence |
| --- | --- | --- |
${checkRows}

## Summary

- Passed: ${report.summary.passed}/${report.summary.total}
- Regressions: ${report.summary.regressions}
- S01 baseline changed: no

The positive packaged flow is \`init -> once -> status run -> events -> report last\`. It verifies
the delivered file, the authority-owned \`[x]\` marker, the blocking gate, progress counters and
the persisted report. The negative production flow proves that \`--executor-profile fake\` exits
with code 6 and \`RALPH_EXECUTOR_PROFILE_UNAVAILABLE\` without creating a run or changing the PRD.
`
}

async function writeReports(
  report: S03CompatibilityReport,
  outputDirectory: string,
): Promise<{ json: string; markdown: string }> {
  const directory = resolve(outputDirectory)
  const json = join(directory, "s03-addendum.json")
  const markdown = join(directory, "s03-addendum.md")
  await mkdir(directory, { recursive: true })
  await writeFileAtomic(json, `${JSON.stringify(report, null, 2)}\n`, {
    overwrite: await Bun.file(json).exists(),
  })
  await formatGeneratedJson(json)
  await writeFileAtomic(markdown, renderS03CompatibilityMarkdown(report), {
    overwrite: await Bun.file(markdown).exists(),
  })
  return { json, markdown }
}

async function formatGeneratedJson(path: string): Promise<void> {
  const projectRoot = resolve(import.meta.dir, "..")
  const executable = join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "biome.exe" : "biome",
  )
  if (!(await Bun.file(executable).exists())) {
    throw new Error("Biome is required to format the versioned S03 compatibility JSON")
  }
  const child = Bun.spawn([executable, "format", "--write", path], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`Biome could not format ${path}: ${stderr.trim()}`)
}

if (import.meta.main) {
  const projectRoot = resolve(import.meta.dir, "..")
  try {
    const options = parseS03HarnessOptions(process.argv.slice(2), projectRoot)
    const report = await runS03CompatibilityHarness(projectRoot, {
      ...(options.nextBinary ? { nextBinary: options.nextBinary } : {}),
    })
    const reports = options.writeReports
      ? await writeReports(report, options.outputDirectory)
      : null
    console.log(
      JSON.stringify(
        options.printJson
          ? report
          : {
              suite: report.suite,
              summary: report.summary,
              artifacts: {
                product: report.artifacts.product.artifact,
                testComposition: report.artifacts.testComposition.artifact,
              },
              reports,
            },
        null,
        2,
      ),
    )
    if (report.summary.regressions > 0) process.exitCode = 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`S03 compatibility harness failed: ${message}`)
    process.exitCode = 1
  }
}
