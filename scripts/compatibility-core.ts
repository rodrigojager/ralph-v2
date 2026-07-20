import { realpathSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { RalphConfigLayerSchema, WorkspaceIdentitySchema } from "@ralph-next/domain"
import { readEvents, readWorkspaceConfig, writeFileAtomic } from "@ralph-next/persistence"
import {
  type EventEnvelope,
  EventEnvelopeConsumerSchema,
  secretValuesFromEnvironment,
} from "@ralph-next/telemetry"
import {
  nativeTarget,
  RELEASE_TARGETS,
  type ReleaseTarget,
  validateStandaloneArtifact,
} from "./build-artifact"
import {
  assertNoSecretLeak,
  isolatedChildEnvironment,
  runCapturedProcess,
  SUBPROCESS_SECRET_CANARY,
} from "./subprocess"

export const COMPATIBILITY_SCENARIOS = [
  "help",
  "version",
  "status",
  "init",
  "status-descendant",
] as const

export type CompatibilityScenarioId = (typeof COMPATIBILITY_SCENARIOS)[number]
export type CompatibilityClassification = "compatible" | "changed" | "deprecated" | "removed"
export type CompatibilityAssessment = "pass" | "regression"

export type HarnessOptions = {
  withoutLegacy: boolean
  nextSource: boolean
  legacyBinary?: string
  nextBinary?: string
  outputDirectory: string
  writeReports: boolean
  printJson: boolean
}

type Invocation = {
  kind: "binary" | "source-entry"
  argvPrefix: string[]
  portableArgvPrefix: string[]
  evidencePath: string
  validatedTarget?: ReleaseTarget
}

export type FileSnapshot = {
  path: string
  kind: "directory" | "file" | "symlink" | "other"
}

export type StreamCapture = {
  raw: string
  normalized: string
  lineEndings: "none" | "lf" | "crlf" | "mixed"
}

export type InvariantEvidence = {
  id: string
  passed: boolean
  evidence: string
}

export type ScenarioCapture = {
  invocation: string[]
  cwd: string
  snapshotRoot: string
  exitCode: number
  timedOut: boolean
  stdout: StreamCapture
  stderr: StreamCapture
  files: FileSnapshot[]
  invariants: InvariantEvidence[]
}

export type ScenarioComparison = {
  id: CompatibilityScenarioId
  purpose: string
  legacy: ScenarioCapture | null
  next: ScenarioCapture
  classification: CompatibilityClassification | null
  assessment: CompatibilityAssessment
  rationale: string
  differences: string[]
  notComparedReason?: string
}

export type BinaryEvidence = {
  kind: "binary" | "source-entry"
  path: string
  sha256: string
  versionExitCode: number
  versionStdout: string
  versionStderr: string
}

export type PlatformEvidence = {
  target: ReleaseTarget
  platform: "windows" | "linux" | "darwin"
  architecture: "x64" | "arm64"
  state: "tested" | "built-not-tested" | "not-evidenced"
  evidence: string
}

export type CompatibilityReport = {
  schemaVersion: 1
  suite: "s01-foundation-compatibility"
  comparisonMode: "legacy-vs-next" | "next-only"
  normalization: {
    portableRaw: string[]
    normalized: string[]
  }
  environment: {
    platform: NodeJS.Platform
    architecture: string
    bunVersion: string
  }
  binaries: {
    legacy: BinaryEvidence | null
    next: BinaryEvidence
  }
  platformEvidence: PlatformEvidence[]
  scenarios: ScenarioComparison[]
  summary: {
    total: number
    compared: number
    compatible: number
    changed: number
    deprecated: number
    removed: number
    regressions: number
    notCompared: number
  }
}

const SCENARIO_ARGUMENTS: Record<
  CompatibilityScenarioId,
  { legacy: string[]; next: string[]; purpose: string }
> = {
  help: {
    legacy: ["--help"],
    next: ["help", "--format", "human", "--no-color"],
    purpose: "Compare the discoverable S01 command surface and successful help behavior.",
  },
  version: {
    legacy: ["--version"],
    next: ["version", "--format", "human", "--no-color"],
    purpose: "Preserve a non-interactive version probe while the executable name changes.",
  },
  status: {
    legacy: ["status"],
    next: ["status", "--format", "human", "--no-color"],
    purpose: "Compare successful, non-mutating status in an uninitialized workspace.",
  },
  init: {
    legacy: ["init"],
    next: ["init", "--format", "human", "--no-color", "--non-interactive"],
    purpose: "Record the deliberate state-layout boundary between legacy and v2 workspaces.",
  },
  "status-descendant": {
    legacy: ["status"],
    next: ["status", "--format", "human", "--no-color"],
    purpose:
      "Prove that v2 deliberately discovers an identified workspace in an ancestor while legacy status remains rooted at the current directory.",
  },
}

const EXPECTED_CLASSIFICATION: Record<CompatibilityScenarioId, CompatibilityClassification> = {
  help: "changed",
  version: "changed",
  status: "compatible",
  init: "changed",
  "status-descendant": "changed",
}

const NEXT_HELP_COMMANDS = [
  "init",
  "status",
  "doctor",
  "config explain",
  "config list",
  "about",
  "version",
  "help",
] as const

const LEGACY_HELP_COMMANDS = [
  "ralph init",
  "ralph status",
  "ralph doctor",
  "ralph config",
  "ralph about",
  "--version",
  "--help",
] as const

const reportBinaryPaths = new WeakMap<CompatibilityReport, string>()

const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu
const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})\b/gu

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a path value`)
  return value
}

export function parseHarnessOptions(
  argv: readonly string[],
  projectRoot = resolve(import.meta.dir, ".."),
): HarnessOptions {
  const options: HarnessOptions = {
    withoutLegacy: false,
    nextSource: false,
    outputDirectory: join(projectRoot, "docs", "compatibility"),
    writeReports: true,
    printJson: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case "--without-legacy":
        options.withoutLegacy = true
        break
      case "--next-source":
        options.nextSource = true
        break
      case "--legacy-binary":
        options.legacyBinary = requireValue(argv, index, argument)
        index += 1
        break
      case "--next-binary":
        options.nextBinary = requireValue(argv, index, argument)
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
        throw new Error(`Unknown compatibility harness option: ${argument ?? "<missing>"}`)
    }
  }

  if (options.withoutLegacy && options.legacyBinary) {
    throw new Error("--without-legacy cannot be combined with --legacy-binary")
  }
  if (options.withoutLegacy && options.writeReports) {
    throw new Error(
      "--without-legacy requires --no-write; a next-only run cannot replace the compatibility baseline",
    )
  }
  if (options.nextSource && options.nextBinary) {
    throw new Error("--next-source cannot be combined with --next-binary")
  }
  if (options.nextSource && options.writeReports) {
    throw new Error(
      "--next-source requires --no-write; versioned reports require a fresh standalone",
    )
  }
  return options
}

function slashPath(path: string): string {
  return path.replaceAll("\\", "/")
}

export function makePortableRaw(value: string, fixtureRoot: string): string {
  const candidates = new Set([
    fixtureRoot,
    slashPath(fixtureRoot),
    fixtureRoot.replaceAll("/", "\\"),
  ])
  let portable = value
  for (const candidate of [...candidates].sort((left, right) => right.length - left.length)) {
    portable = portable.replaceAll(candidate, "<FIXTURE_ROOT>")
  }
  let timestampIndex = 0
  let uuidIndex = 0
  return portable
    .replace(ISO_TIMESTAMP_PATTERN, () => {
      timestampIndex += 1
      return `<RAW_TIMESTAMP_${timestampIndex}>`
    })
    .replace(UUID_PATTERN, () => {
      uuidIndex += 1
      return `<RAW_UUID_${uuidIndex}>`
    })
}

export function normalizeVolatile(value: string): string {
  return value
    .replace(/<RAW_TIMESTAMP_\d+>/gu, "<TIMESTAMP>")
    .replace(/<RAW_UUID_\d+>/gu, "<UUID>")
    .replace(ISO_TIMESTAMP_PATTERN, "<TIMESTAMP>")
    .replace(UUID_PATTERN, "<UUID>")
}

function lineEndings(value: string): StreamCapture["lineEndings"] {
  if (!value.includes("\n") && !value.includes("\r")) return "none"
  const hasCrlf = value.includes("\r\n")
  const withoutCrlf = value.replaceAll("\r\n", "")
  const hasBareLf = withoutCrlf.includes("\n")
  const hasBareCr = withoutCrlf.includes("\r")
  if (hasCrlf && (hasBareLf || hasBareCr)) return "mixed"
  if (hasCrlf) return "crlf"
  return "lf"
}

function captureStream(value: string, fixtureRoot: string): StreamCapture {
  const raw = makePortableRaw(value, fixtureRoot)
  return { raw, normalized: normalizeVolatile(raw), lineEndings: lineEndings(value) }
}

async function sha256(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex").toUpperCase()
}

async function resolveExecutable(candidate: string): Promise<string> {
  const looksLikePath = isAbsolute(candidate) || candidate.includes("/") || candidate.includes("\\")
  const found = looksLikePath ? resolve(candidate) : Bun.which(candidate)
  if (!found) throw new Error(`Executable was not found: ${candidate}`)
  let resolved: string
  try {
    resolved = await realpath(found)
  } catch {
    throw new Error(`Executable was not found: ${found}`)
  }
  const info = await lstat(resolved)
  if (!info.isFile()) throw new Error(`Executable must resolve to a regular file: ${resolved}`)
  return resolved
}

async function resolveLegacyInvocation(options: HarnessOptions): Promise<Invocation | null> {
  if (options.withoutLegacy) return null
  const configured = options.legacyBinary ?? process.env.RALPH_LEGACY_BINARY ?? "ralph"
  const path = await resolveExecutable(configured)
  return {
    kind: "binary",
    argvPrefix: [path],
    portableArgvPrefix: [`<LEGACY_BINARY_DIR>/${basename(path)}`],
    evidencePath: path,
  }
}

async function resolveNextInvocation(
  options: HarnessOptions,
  projectRoot: string,
): Promise<Invocation> {
  const source = join(projectRoot, "apps", "ralph-cli", "src", "main.ts")
  if (options.nextSource) {
    if (options.writeReports) {
      throw new Error(
        "Source-entry compatibility runs require --no-write; versioned reports require a fresh standalone",
      )
    }
    if (!(await Bun.file(source).exists())) {
      throw new Error(`ralph-next source entry was not found: ${source}`)
    }
    return {
      kind: "source-entry",
      argvPrefix: [process.execPath, source],
      portableArgvPrefix: ["<BUN_RUNTIME>", portablePathFromActual(source, projectRoot, "next")],
      evidencePath: source,
    }
  }
  const configured = options.nextBinary ?? process.env.RALPH_NEXT_BINARY
  if (configured) {
    let path = await resolveExecutable(configured)
    let validatedTarget: ReleaseTarget | undefined
    try {
      const validated = await validateStandaloneArtifact(path, projectRoot, nativeTarget())
      path = await realpath(validated.binary)
      validatedTarget = validated.metadata.target
    } catch (error) {
      if (options.writeReports) throw error
    }
    return {
      kind: "binary",
      argvPrefix: [path],
      portableArgvPrefix: [portablePathFromActual(path, projectRoot, "next")],
      evidencePath: path,
      ...(validatedTarget ? { validatedTarget } : {}),
    }
  }

  const extension = process.platform === "win32" ? ".exe" : ""
  const target = nativeTarget()
  const standalone = join(projectRoot, "dist", "standalone", target, `ralph-next${extension}`)
  const validated = await validateStandaloneArtifact(standalone, projectRoot, target)
  const path = await realpath(validated.binary)
  return {
    kind: "binary",
    argvPrefix: [path],
    portableArgvPrefix: [portablePathFromActual(path, projectRoot, "next")],
    evidencePath: path,
    validatedTarget: target,
  }
}

async function snapshotDirectory(root: string): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = []

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const path = slashPath(relative(root, absolute))
      const stats = await lstat(absolute)
      const kind: FileSnapshot["kind"] = stats.isSymbolicLink()
        ? "symlink"
        : stats.isDirectory()
          ? "directory"
          : stats.isFile()
            ? "file"
            : "other"
      snapshots.push({ path, kind })
      if (kind === "directory") await visit(absolute)
    }
  }

  await visit(root)
  return snapshots
}

async function resetScenarioDirectory(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true })
  await mkdir(path, { recursive: true })
}

async function runCapture(
  invocation: Invocation,
  arguments_: readonly string[],
  cwd: string,
  fixtureRoot: string,
  environment: Record<string, string>,
  snapshotRoot = cwd,
): Promise<ScenarioCapture> {
  const argv = [...invocation.argvPrefix, ...arguments_]
  const captured = await runCapturedProcess(argv, {
    cwd,
    environment,
  })
  const { exitCode, stdout, stderr, timedOut } = captured
  assertNoSecretLeak(
    [stdout, stderr],
    // Compare against the exact isolated environment handed to this child.
    // Host-only credentials are deliberately excluded from the subprocess;
    // treating an unrelated short host value as an output substring creates a
    // false leak report without testing the actual process boundary.
    [...secretValuesFromEnvironment(environment), SUBPROCESS_SECRET_CANARY],
    `Compatibility command ${arguments_.join(" ")}`,
  )
  return {
    invocation: [
      ...invocation.portableArgvPrefix,
      ...arguments_.map((argument) => makePortableRaw(argument, fixtureRoot)),
    ],
    cwd: makePortableRaw(cwd, fixtureRoot),
    snapshotRoot: makePortableRaw(snapshotRoot, fixtureRoot),
    exitCode,
    timedOut,
    stdout: captureStream(stdout, fixtureRoot),
    stderr: captureStream(stderr, fixtureRoot),
    files: await snapshotDirectory(snapshotRoot),
    invariants: [],
  }
}

async function directoryFingerprint(root: string): Promise<string> {
  const snapshots = await snapshotDirectory(root)
  const hasher = new Bun.CryptoHasher("sha256")
  for (const snapshot of snapshots) {
    if (
      snapshot.path === ".ralph/state/ledger.sqlite-wal" ||
      snapshot.path === ".ralph/state/ledger.sqlite-shm"
    ) {
      continue
    }
    hasher.update(`${snapshot.kind}:${snapshot.path}\n`)
    if (snapshot.kind === "file") {
      const absolute = join(root, ...snapshot.path.split("/"))
      hasher.update(new Uint8Array(await Bun.file(absolute).arrayBuffer()))
    }
  }
  const ledger = join(root, ".ralph", "state", "ledger.sqlite")
  if (await Bun.file(ledger).exists()) {
    hasher.update(`ledger-events:${JSON.stringify(readEvents(ledger))}\n`)
  }
  return hasher.digest("hex")
}

function invariant(
  id: string,
  passed: boolean,
  successEvidence: string,
  failureEvidence: string,
): InvariantEvidence {
  return { id, passed, evidence: passed ? successEvidence : failureEvidence }
}

function requiredTextItems(
  output: string,
  required: readonly string[],
): { passed: boolean; missing: string[] } {
  const normalized = output.toLowerCase()
  const missing = required.filter((item) => !normalized.includes(item.toLowerCase()))
  return { passed: missing.length === 0, missing }
}

function hasSnapshot(capture: ScenarioCapture, path: string, kind: FileSnapshot["kind"]): boolean {
  return capture.files.some((file) => file.path === path && file.kind === kind)
}

async function isJsonObject(path: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await Bun.file(path).text())
    return value !== null && typeof value === "object" && !Array.isArray(value)
  } catch {
    return false
  }
}

type InvariantContext = {
  scenarioRoot: string
  executionRoot: string
  setup?: ScenarioCapture
  treeUnchanged?: boolean
}

async function initContentInvariants(
  side: "legacy" | "next",
  capture: ScenarioCapture,
  scenarioRoot: string,
): Promise<InvariantEvidence[]> {
  if (side === "legacy") {
    const pathsValid =
      hasSnapshot(capture, ".ralph", "directory") &&
      hasSnapshot(capture, ".ralph/config.json", "file") &&
      hasSnapshot(capture, ".ralph/state.json", "file") &&
      hasSnapshot(capture, ".ralph/events.jsonl", "file") &&
      hasSnapshot(capture, "PRD.md", "file")
    const [configValid, stateValid, prd] = await Promise.all([
      isJsonObject(join(scenarioRoot, ".ralph", "config.json")),
      isJsonObject(join(scenarioRoot, ".ralph", "state.json")),
      Bun.file(join(scenarioRoot, "PRD.md"))
        .text()
        .catch(() => ""),
    ])
    return [
      invariant(
        "legacy.init.layout",
        pathsValid,
        "Legacy init created its required state/config/event files and PRD.",
        "Legacy init did not create every required state/config/event file and PRD.",
      ),
      invariant(
        "legacy.init.content",
        configValid && stateValid && prd.trim().length > 0,
        "Legacy config/state are JSON objects and its generated PRD is non-empty.",
        "Legacy config/state JSON or generated PRD content is invalid.",
      ),
    ]
  }

  const pathsValid =
    hasSnapshot(capture, ".ralph", "directory") &&
    hasSnapshot(capture, ".ralph/workspace.json", "file") &&
    hasSnapshot(capture, ".ralph/config.yaml", "file") &&
    hasSnapshot(capture, ".ralph/state/ledger.sqlite", "file") &&
    hasSnapshot(capture, ".ralph/state/migrations/0001-initial.sql", "file") &&
    hasSnapshot(capture, ".ralph/events.jsonl", "file") &&
    hasSnapshot(capture, ".ralph/runs", "directory") &&
    hasSnapshot(capture, ".ralph/locks", "directory") &&
    hasSnapshot(capture, ".ralph/cache", "directory") &&
    hasSnapshot(capture, ".ralph/checkpoints", "directory") &&
    !capture.files.some((file) => file.path === "PRD.md" || file.path.endsWith("/PRD.md"))

  let identityValid = false
  let canonicalRootValid = false
  let configValid = false
  let ledgerValid = false
  let projectionValid = false
  let ledgerEvents: EventEnvelope[] = []
  let workspaceId: string | undefined
  try {
    const identityValue: unknown = JSON.parse(
      await Bun.file(join(scenarioRoot, ".ralph", "workspace.json")).text(),
    )
    const parsed = WorkspaceIdentitySchema.safeParse(identityValue)
    identityValid = parsed.success
    if (parsed.success) {
      workspaceId = parsed.data.workspace_id
      canonicalRootValid =
        resolve(parsed.data.canonical_root) === resolve(await realpath(scenarioRoot))
    }
  } catch {
    // Expressed through deterministic invariant evidence below.
  }
  try {
    const config = await readWorkspaceConfig(join(scenarioRoot, ".ralph", "config.yaml"))
    configValid = RalphConfigLayerSchema.safeParse(config).success
  } catch {
    // Expressed through deterministic invariant evidence below.
  }
  try {
    const events = readEvents(join(scenarioRoot, ".ralph", "state", "ledger.sqlite"))
    ledgerEvents = events
    ledgerValid =
      events.length >= 1 &&
      events[0]?.type === "workspace.initialized" &&
      events[0]?.scope === "workspace" &&
      events[0]?.workspaceId === workspaceId
  } catch {
    // Expressed through deterministic invariant evidence below.
  }
  try {
    const projection = await Bun.file(join(scenarioRoot, ".ralph", "events.jsonl")).text()
    const lines = projection
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean)
    const projectionEvents = lines.map((line) =>
      EventEnvelopeConsumerSchema.parse(JSON.parse(line)),
    )
    projectionValid =
      ledgerEvents.length >= 1 &&
      projectionEvents.length === ledgerEvents.length &&
      projectionEvents.every(
        (event, index) => JSON.stringify(event) === JSON.stringify(ledgerEvents[index]),
      )
  } catch {
    // Expressed through deterministic invariant evidence below.
  }

  return [
    invariant(
      "next.init.layout",
      pathsValid,
      "V2 init created the required identified SQLite layout and did not create a PRD.",
      "V2 init layout is incomplete, has a wrong path type, or unexpectedly created a PRD.",
    ),
    invariant(
      "next.init.identity-schema",
      identityValid && canonicalRootValid,
      "workspace.json satisfies WorkspaceIdentitySchema and records the canonical fixture root.",
      "workspace.json is invalid or its canonical root does not identify this fixture.",
    ),
    invariant(
      "next.init.config-schema",
      configValid,
      "config.yaml satisfies RalphConfigLayerSchema.",
      "config.yaml does not satisfy RalphConfigLayerSchema.",
    ),
    invariant(
      "next.init.ledger",
      ledgerValid,
      "The read-only ledger parser found a workspace.initialized event for the persisted workspace ID.",
      "The SQLite ledger could not prove a matching workspace.initialized event.",
    ),
    invariant(
      "next.init.event-projection",
      projectionValid,
      "events.jsonl contains the same schema-valid events as the authoritative ledger.",
      "events.jsonl is invalid or diverges from the authoritative ledger.",
    ),
  ]
}

async function collectScenarioInvariants(
  id: CompatibilityScenarioId,
  side: "legacy" | "next",
  capture: ScenarioCapture,
  context: InvariantContext,
): Promise<InvariantEvidence[]> {
  const output = capture.stdout.normalized.trim()
  const evidence: InvariantEvidence[] = [
    invariant(
      `${side}.process.success`,
      hasSuccessfulOutput(capture),
      "The command completed before timeout with exit code 0 and empty stderr.",
      "The command timed out, returned a non-zero exit code, or wrote to stderr.",
    ),
  ]

  if (id === "help") {
    const expected = side === "legacy" ? LEGACY_HELP_COMMANDS : NEXT_HELP_COMMANDS
    const commands = requiredTextItems(output, expected)
    evidence.push(
      invariant(
        `${side}.help.product-and-commands`,
        (side === "legacy" ? /^ralph\s+-/iu.test(output) : /^ralph-next\s+\d/iu.test(output)) &&
          commands.passed,
        `${side === "legacy" ? "Legacy" : "V2"} help identifies the product and every required command in this baseline.`,
        `Help is missing required product/command evidence: ${commands.missing.join(", ") || "product heading"}.`,
      ),
      invariant(
        `${side}.help.non-mutating`,
        capture.files.length === 0,
        "Help left the fixture directory empty.",
        "Help unexpectedly mutated the fixture directory.",
      ),
    )
    return evidence
  }

  if (id === "version") {
    const semver =
      "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?"
    const product = side === "legacy" ? "ralph" : "ralph-next"
    evidence.push(
      invariant(
        `${side}.version.contract`,
        new RegExp(`^${product} ${semver}$`, "u").test(output),
        `Version output is exactly the ${product} product name followed by semantic version text.`,
        `Version output does not satisfy the ${product} semantic-version contract.`,
      ),
      invariant(
        `${side}.version.non-mutating`,
        capture.files.length === 0,
        "Version left the fixture directory empty.",
        "Version unexpectedly mutated the fixture directory.",
      ),
    )
    return evidence
  }

  if (id === "status") {
    const fieldsValid =
      side === "legacy"
        ? /Workspace:\s+not initialized/iu.test(output) &&
          /Run:\s+idle/iu.test(output) &&
          /Progress:\s+0\/0 completed/iu.test(output)
        : /Workspace:\s+not initialized/iu.test(output) &&
          /State:\s+uninitialized/iu.test(output) &&
          /Events:\s+0/iu.test(output) &&
          /Runs:\s+0/iu.test(output)
    evidence.push(
      invariant(
        `${side}.status.uninitialized-contract`,
        fieldsValid,
        "Status reports the complete uninitialized baseline fields.",
        "Status does not report the required uninitialized baseline fields.",
      ),
      invariant(
        `${side}.status.non-mutating`,
        capture.files.length === 0,
        "Uninitialized status left the fixture directory empty.",
        "Uninitialized status unexpectedly mutated the fixture directory.",
      ),
    )
    return evidence
  }

  if (id === "init") {
    // Ralph v1 can emit either its bundled Portuguese message or the older
    // English message depending on the persisted locale/config generation.
    // Compatibility is the product-specific successful init contract, not a
    // particular presentation language.
    const legacyInitOutput =
      /Workspace ralph inicializado/iu.test(output) ||
      /Initialized ralph workspace(?:\s+at)?/iu.test(output)
    evidence.push(
      invariant(
        `${side}.init.output-contract`,
        side === "legacy"
          ? legacyInitOutput
          : /Ralph v2 workspace initialized/iu.test(output) &&
              /Workspace ID:\s+<UUID>/u.test(output),
        "Init emitted its expected product-specific success and identity output.",
        "Init did not emit its expected product-specific success and identity output.",
      ),
      ...(await initContentInvariants(side, capture, context.scenarioRoot)),
    )
    return evidence
  }

  const setupPassed = context.setup?.invariants.every((item) => item.passed) === true
  const rootPattern = /Root:\s+<FIXTURE_ROOT>[\\/]status-descendant(?:\r?\n|$)/iu
  const ancestorSemantics =
    side === "legacy"
      ? /Workspace:\s+not initialized/iu.test(output)
      : /Workspace:\s+initialized/iu.test(output) &&
        /State:\s+ready/iu.test(output) &&
        /ID:\s+<UUID>/u.test(output) &&
        rootPattern.test(output)
  const nestedStateCreated = capture.files.some((file) =>
    /(?:^|\/)nested space\/filho-ç\/\.ralph(?:\/|$)/u.test(file.path),
  )
  evidence.push(
    invariant(
      `${side}.status-descendant.setup`,
      setupPassed,
      "The parent workspace setup satisfied every init invariant before the descendant probe.",
      "The parent workspace setup did not satisfy every init invariant.",
    ),
    invariant(
      `${side}.status-descendant.semantics`,
      ancestorSemantics,
      side === "legacy"
        ? "Legacy status remains uninitialized when invoked below its initialized parent."
        : "V2 status resolves the identified parent workspace and reports its canonical root and ID.",
      "Descendant status did not exhibit its documented workspace-resolution behavior.",
    ),
    invariant(
      `${side}.status-descendant.non-mutating`,
      context.treeUnchanged === true && !nestedStateCreated,
      "Descendant status left the initialized tree byte-for-byte unchanged and created no nested state.",
      "Descendant status changed parent state or created state below the invocation directory.",
    ),
  )
  return evidence
}

function hasSuccessfulOutput(capture: ScenarioCapture): boolean {
  return !capture.timedOut && capture.exitCode === 0 && capture.stderr.normalized.trim() === ""
}

function captureDifferences(legacy: ScenarioCapture, next: ScenarioCapture): string[] {
  const differences: string[] = []
  if (legacy.cwd !== next.cwd) differences.push("working directory differs")
  if (legacy.snapshotRoot !== next.snapshotRoot) differences.push("snapshot root differs")
  if (legacy.timedOut !== next.timedOut) differences.push("timeout outcome differs")
  if (legacy.exitCode !== next.exitCode) differences.push("exit code differs")
  if (legacy.stdout.normalized !== next.stdout.normalized) differences.push("stdout differs")
  if (legacy.stderr.normalized !== next.stderr.normalized) differences.push("stderr differs")
  if (legacy.stdout.lineEndings !== next.stdout.lineEndings) {
    differences.push("stdout line endings differ")
  }
  if (legacy.stderr.lineEndings !== next.stderr.lineEndings) {
    differences.push("stderr line endings differ")
  }
  const legacyFiles = legacy.files.map((file) => `${file.kind}:${file.path}`).join("\n")
  const nextFiles = next.files.map((file) => `${file.kind}:${file.path}`).join("\n")
  if (legacyFiles !== nextFiles) differences.push("created file layout differs")
  return differences
}

export function classifyScenario(
  id: CompatibilityScenarioId,
  legacy: ScenarioCapture | null,
  next: ScenarioCapture,
): Pick<
  ScenarioComparison,
  "classification" | "assessment" | "rationale" | "differences" | "notComparedReason"
> {
  const failures = [...(legacy?.invariants ?? []), ...next.invariants].filter(
    (item) => !item.passed,
  )
  const assessment: CompatibilityAssessment = failures.length === 0 ? "pass" : "regression"
  const differences = legacy ? captureDifferences(legacy, next) : []
  const failedIds = failures.map((item) => item.id).join(", ")

  if (!legacy) {
    return {
      classification: null,
      assessment,
      rationale:
        assessment === "pass"
          ? "The next implementation satisfied every scenario invariant; no legacy executable was requested."
          : `The next implementation failed invariant evidence: ${failedIds}.`,
      differences,
      notComparedReason: "legacy-disabled",
    }
  }

  const classification = EXPECTED_CLASSIFICATION[id]
  if (assessment === "regression") {
    return {
      classification,
      assessment,
      rationale: `The documented compatibility decision remains ${classification}, but invariant evidence failed: ${failedIds}.`,
      differences,
    }
  }

  const rationale: Record<CompatibilityScenarioId, string> = {
    help: "Both help probes are valid; v2 deliberately exposes its independently implemented command surface, including accepted slices beyond this S01 baseline.",
    version:
      "Both version probes satisfy their contracts; the ralph-next name and independent v2 version are deliberate changes.",
    status:
      "Both commands report a complete uninitialized status and leave the directory untouched.",
    init: "Both init commands satisfy their schemas; v2 deliberately uses identified SQLite state and creates no PRD.",
    "status-descendant":
      "Both parent workspaces are valid; v2 deliberately resolves its identified ancestor while legacy remains uninitialized in the descendant.",
  }
  return { classification, assessment, rationale: rationale[id], differences }
}

async function binaryEvidence(
  invocation: Invocation,
  versionCapture: ScenarioCapture,
  portablePath: string,
): Promise<BinaryEvidence> {
  return {
    kind: invocation.kind,
    path: portablePath,
    sha256: await sha256(invocation.evidencePath),
    versionExitCode: versionCapture.exitCode,
    versionStdout: versionCapture.stdout.raw,
    versionStderr: versionCapture.stderr.raw,
  }
}

function portablePathFromActual(
  evidencePath: string,
  projectRoot: string,
  role: "legacy" | "next",
): string {
  const absolute = resolve(evidencePath)
  const projectRelative = relative(resolve(projectRoot), absolute)
  if (
    projectRelative &&
    projectRelative !== ".." &&
    !projectRelative.startsWith(`..${sep}`) &&
    !isAbsolute(projectRelative)
  ) {
    return `<PROJECT_ROOT>/${slashPath(projectRelative)}`
  }
  const marker = role === "legacy" ? "<LEGACY_BINARY_DIR>" : "<NEXT_BINARY_DIR>"
  return `${marker}/${basename(absolute)}`
}

function portableBinaryPath(
  invocation: Invocation,
  projectRoot: string,
  role: "legacy" | "next",
): string {
  return portablePathFromActual(invocation.evidencePath, projectRoot, role)
}

function platformForTarget(target: ReleaseTarget): PlatformEvidence["platform"] {
  if (target.includes("windows")) return "windows"
  if (target.includes("linux")) return "linux"
  return "darwin"
}

function architectureForTarget(target: ReleaseTarget): PlatformEvidence["architecture"] {
  return target.includes("arm64") ? "arm64" : "x64"
}

function standalonePath(projectRoot: string, target: ReleaseTarget): string {
  const extension = target.startsWith("bun-windows-") ? ".exe" : ""
  return join(projectRoot, "dist", "standalone", target, `ralph-next${extension}`)
}

async function collectPlatformEvidence(
  invocation: Invocation,
  projectRoot: string,
): Promise<PlatformEvidence[]> {
  return Promise.all(
    RELEASE_TARGETS.map(async (target): Promise<PlatformEvidence> => {
      const base = {
        target,
        platform: platformForTarget(target),
        architecture: architectureForTarget(target),
      }
      if (invocation.kind === "binary" && invocation.validatedTarget === target) {
        return {
          ...base,
          state: "tested",
          evidence: `The compatibility harness executed a standalone binary on ${process.platform}/${process.arch}.`,
        }
      }
      try {
        await validateStandaloneArtifact(standalonePath(projectRoot, target), projectRoot, target)
        return {
          ...base,
          state: "built-not-tested",
          evidence:
            "Fresh build metadata and artifact hash were verified; this executable was not run on the current host.",
        }
      } catch {
        return {
          ...base,
          state: "not-evidenced",
          evidence: "No fresh standalone artifact evidence exists for the current source revision.",
        }
      }
    }),
  )
}

function reportSummary(scenarios: ScenarioComparison[]): CompatibilityReport["summary"] {
  return {
    total: scenarios.length,
    compared: scenarios.filter((scenario) => scenario.classification !== null).length,
    compatible: scenarios.filter((scenario) => scenario.classification === "compatible").length,
    changed: scenarios.filter((scenario) => scenario.classification === "changed").length,
    deprecated: scenarios.filter((scenario) => scenario.classification === "deprecated").length,
    removed: scenarios.filter((scenario) => scenario.classification === "removed").length,
    regressions: scenarios.filter((scenario) => scenario.assessment === "regression").length,
    notCompared: scenarios.filter((scenario) => scenario.classification === null).length,
  }
}

function assertSafeTemporaryRoot(path: string): void {
  const temporaryRoot = realpathSync.native(resolve(tmpdir()))
  const candidate = realpathSync.native(resolve(path))
  const segment = relative(temporaryRoot, candidate)
  if (!segment || segment.startsWith(`..${sep}`) || segment === ".." || isAbsolute(segment)) {
    throw new Error(`Refusing to remove unsafe fixture path: ${candidate}`)
  }
}

async function runScenarioSide(
  id: CompatibilityScenarioId,
  side: "legacy" | "next",
  invocation: Invocation,
  scenarioRoot: string,
  fixtureRoot: string,
  environment: Record<string, string>,
): Promise<ScenarioCapture> {
  const arguments_ = SCENARIO_ARGUMENTS[id][side]
  if (id !== "status-descendant") {
    const capture = await runCapture(
      invocation,
      arguments_,
      scenarioRoot,
      fixtureRoot,
      environment,
      scenarioRoot,
    )
    capture.invariants = await collectScenarioInvariants(id, side, capture, {
      scenarioRoot,
      executionRoot: scenarioRoot,
    })
    return capture
  }

  const setupArguments = SCENARIO_ARGUMENTS.init[side]
  const setup = await runCapture(
    invocation,
    setupArguments,
    scenarioRoot,
    fixtureRoot,
    environment,
    scenarioRoot,
  )
  setup.invariants = await collectScenarioInvariants("init", side, setup, {
    scenarioRoot,
    executionRoot: scenarioRoot,
  })

  const executionRoot = join(scenarioRoot, "nested space", "filho-ç")
  await mkdir(executionRoot, { recursive: true })
  const before = await directoryFingerprint(scenarioRoot)
  const capture = await runCapture(
    invocation,
    arguments_,
    executionRoot,
    fixtureRoot,
    environment,
    scenarioRoot,
  )
  const after = await directoryFingerprint(scenarioRoot)
  capture.invariants = await collectScenarioInvariants(id, side, capture, {
    scenarioRoot,
    executionRoot,
    setup,
    treeUnchanged: before === after,
  })
  return capture
}

export async function runCompatibilityHarness(
  options: HarnessOptions,
  projectRoot = resolve(import.meta.dir, ".."),
): Promise<CompatibilityReport> {
  const legacyInvocation = await resolveLegacyInvocation(options)
  const nextInvocation = await resolveNextInvocation(options, projectRoot)
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "ralph-v2-compat-s01-")))
  assertSafeTemporaryRoot(fixtureRoot)
  const scenarios: ScenarioComparison[] = []

  try {
    for (const id of COMPATIBILITY_SCENARIOS) {
      const definition = SCENARIO_ARGUMENTS[id]
      const cwd = join(fixtureRoot, id)
      let legacy: ScenarioCapture | null = null
      if (legacyInvocation) {
        await resetScenarioDirectory(cwd)
        const environment = await isolatedChildEnvironment(
          join(fixtureRoot, "environments", id, "legacy"),
        )
        legacy = await runScenarioSide(
          id,
          "legacy",
          legacyInvocation,
          cwd,
          fixtureRoot,
          environment,
        )
      }
      await resetScenarioDirectory(cwd)
      const environment = await isolatedChildEnvironment(
        join(fixtureRoot, "environments", id, "next"),
      )
      const next = await runScenarioSide(id, "next", nextInvocation, cwd, fixtureRoot, environment)
      const classification = classifyScenario(id, legacy, next)
      scenarios.push({
        id,
        purpose: definition.purpose,
        legacy,
        next,
        ...classification,
      })
    }

    const legacyVersion = scenarios.find((scenario) => scenario.id === "version")?.legacy
    const nextVersion = scenarios.find((scenario) => scenario.id === "version")?.next
    if (!nextVersion) throw new Error("The version scenario did not produce ralph-next evidence")
    if (legacyInvocation && !legacyVersion) {
      throw new Error("The version scenario did not produce legacy evidence")
    }

    const report: CompatibilityReport = {
      schemaVersion: 1,
      suite: "s01-foundation-compatibility",
      comparisonMode: legacyInvocation ? "legacy-vs-next" : "next-only",
      normalization: {
        portableRaw: [
          "temporary fixture root -> <FIXTURE_ROOT>",
          "RFC 4122 UUID -> indexed <RAW_UUID_n>",
          "ISO 8601 timestamp -> indexed <RAW_TIMESTAMP_n>",
        ],
        normalized: ["indexed <RAW_UUID_n> -> <UUID>", "indexed <RAW_TIMESTAMP_n> -> <TIMESTAMP>"],
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        bunVersion: Bun.version,
      },
      binaries: {
        legacy:
          legacyInvocation && legacyVersion
            ? await binaryEvidence(
                legacyInvocation,
                legacyVersion,
                portableBinaryPath(legacyInvocation, projectRoot, "legacy"),
              )
            : null,
        next: await binaryEvidence(
          nextInvocation,
          nextVersion,
          portableBinaryPath(nextInvocation, projectRoot, "next"),
        ),
      },
      platformEvidence: await collectPlatformEvidence(nextInvocation, projectRoot),
      scenarios,
      summary: reportSummary(scenarios),
    }
    reportBinaryPaths.set(report, nextInvocation.evidencePath)
    return report
  } finally {
    assertSafeTemporaryRoot(fixtureRoot)
    await rm(fixtureRoot, { force: true, recursive: true })
  }
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ")
}

export function renderCompatibilityMarkdown(report: CompatibilityReport): string {
  const legacy = report.binaries.legacy
  const scenarioRows = report.scenarios
    .map((scenario) => {
      const classification = scenario.classification ?? "not-compared"
      const invariants = [...(scenario.legacy?.invariants ?? []), ...scenario.next.invariants]
      const passed = invariants.filter((item) => item.passed).length
      return `| ${scenario.id} | ${classification} | ${scenario.assessment} | ${passed}/${invariants.length} | ${markdownCell(scenario.rationale)} | ${markdownCell(scenario.differences.join(", ") || "none")} |`
    })
    .join("\n")
  const platformRows = report.platformEvidence
    .map(
      (item) =>
        `| ${item.target} | ${item.platform} | ${item.architecture} | ${item.state} | ${markdownCell(item.evidence)} |`,
    )
    .join("\n")
  const legacyEvidence = legacy
    ? `- Path: \`${legacy.path}\`\n- SHA-256: \`${legacy.sha256}\`\n- Version output: \`${legacy.versionStdout.trim()}\``
    : "- Not executed (`--without-legacy`)."

  return `# S01 compatibility baseline

This file is generated by \`bun run compat\`. The detailed portable raw and normalized
captures are stored in \`s01-report.json\`; no command runs in the legacy checkout.

## Execution evidence

- Mode: \`${report.comparisonMode}\`
- Harness host: \`${report.environment.platform}/${report.environment.architecture}\`
- Bun: \`${report.environment.bunVersion}\`
- ralph-next invocation: \`${report.binaries.next.kind}\`
- ralph-next evidence: \`${report.binaries.next.path}\`
- ralph-next SHA-256: \`${report.binaries.next.sha256}\`

### Installed legacy Ralph

${legacyEvidence}

## Platform evidence

Only a target whose standalone executable was actually invoked is marked \`tested\`.
Cross-build metadata and hashes can establish \`built-not-tested\`, never native execution.

| Target | Platform | Architecture | State | Evidence |
| --- | --- | --- | --- | --- |
${platformRows}

## Classification

Compatibility decisions use the closed \`compatible|changed|deprecated|removed\` model.
Regression is a separate assessment derived from the recorded invariant evidence.

| Scenario | Classification | Assessment | Invariants | Rationale | Observable differences |
| --- | --- | --- | --- | --- | --- |
${scenarioRows}

## Summary

- Compatible: ${report.summary.compatible}
- Changed: ${report.summary.changed}
- Deprecated: ${report.summary.deprecated}
- Removed: ${report.summary.removed}
- Regressions: ${report.summary.regressions}
- Not compared: ${report.summary.notCompared}

Portable raw capture replaces the disposable fixture root and gives volatile UUID/timestamp
values indexed, type-preserving placeholders. Normalized capture collapses only those indexed
placeholders. Line endings remain intact, are recorded separately and enter classification.
`
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFileAtomic(path, contents, { overwrite: await Bun.file(path).exists() })
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
    throw new Error(
      "Biome is required to format the versioned compatibility JSON; run `bun install`",
    )
  }
  const child = Bun.spawn([executable, "format", "--write", path], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  })
  const stderrPromise = new Response(child.stderr).text()
  const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise])
  if (exitCode !== 0) throw new Error(`Biome could not format ${path}: ${stderr.trim()}`)
}

export async function writeCompatibilityReports(
  report: CompatibilityReport,
  outputDirectory: string,
): Promise<{ json: string; markdown: string }> {
  if (report.binaries.next.kind !== "binary") {
    throw new Error(
      "Versioned compatibility reports require a standalone binary; source-entry runs are --no-write only",
    )
  }
  if (report.comparisonMode !== "legacy-vs-next" || !report.binaries.legacy) {
    throw new Error(
      "Versioned compatibility reports require a real legacy-vs-next comparison; next-only runs are --no-write only",
    )
  }
  const projectRoot = resolve(import.meta.dir, "..")
  const marker = "<PROJECT_ROOT>/"
  const actualBinary =
    reportBinaryPaths.get(report) ??
    (report.binaries.next.path.startsWith(marker)
      ? resolve(projectRoot, ...report.binaries.next.path.slice(marker.length).split("/"))
      : undefined)
  if (!actualBinary) {
    throw new Error(
      "The portable report does not retain an external binary path; run and write the harness in one process",
    )
  }
  const validated = await validateStandaloneArtifact(actualBinary, projectRoot, nativeTarget())
  if (validated.metadata.sha256.toLowerCase() !== report.binaries.next.sha256.toLowerCase()) {
    throw new Error("Compatibility report binary hash does not match fresh build metadata")
  }
  const nativeEvidence = report.platformEvidence.find((item) => item.target === nativeTarget())
  if (nativeEvidence?.state !== "tested") {
    throw new Error("Versioned compatibility reports require native standalone execution evidence")
  }
  const directory = resolve(outputDirectory)
  const json = join(directory, "s01-report.json")
  const markdown = join(directory, "s01-report.md")
  await atomicWrite(json, `${JSON.stringify(report, null, 2)}\n`)
  await formatGeneratedJson(json)
  await atomicWrite(markdown, renderCompatibilityMarkdown(report))
  return { json, markdown }
}

export function conciseHarnessResult(report: CompatibilityReport): Record<string, unknown> {
  return {
    suite: report.suite,
    mode: report.comparisonMode,
    summary: report.summary,
    legacy: report.binaries.legacy
      ? {
          version: report.binaries.legacy.versionStdout.trim(),
          sha256: report.binaries.legacy.sha256,
        }
      : null,
    next: {
      version: report.binaries.next.versionStdout.trim(),
      sha256: report.binaries.next.sha256,
      artifact: basename(report.binaries.next.path),
    },
  }
}
