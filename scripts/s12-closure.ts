import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises"
import { arch, hostname, release as osRelease, platform, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  BunProcessSupervisor,
  type ProcessSettlement,
  TwoPhaseShutdownController,
} from "@ralph-next/supervisor"
import { redactText, secretValuesFromEnvironment } from "@ralph-next/telemetry"
import { z } from "zod"
import {
  nativeTarget,
  sha256File,
  validateBundleArtifact,
  validateStandaloneArtifact,
} from "./build-artifact"
import { type CheckStep, createCheckPlan } from "./check-plan"
import {
  GITLEAKS_VERSION,
  gitleaksTrackedSourceScanArguments,
  resolveGitleaksBinding,
  validateEmptyGitleaksReport,
  validateGitleaksVersionOutput,
} from "./gitleaks-binding"
import {
  effectiveReleaseCandidateDigest,
  type ReleaseCandidateInput,
  readReleaseCandidateInput,
  readStableJsonInput,
} from "./release-candidate-input"
import { compareUtf8Bytes } from "./release-order"
import { canonicalReleaseRepository } from "./release-source"
import { sourceFingerprint } from "./source-fingerprint"

const projectRoot = resolve(import.meta.dir, "..")
const closureBase = resolve(projectRoot, "artifacts", "ci", "s11-closure")
const maximumLogBytes = 16 * 1024 * 1024
const maximumJunitBytes = 64 * 1024 * 1024
const defaultStepTimeoutMs = 30 * 60 * 1_000
const stepTimeoutsMs: Readonly<Record<string, number>> = {
  tests: 2 * 60 * 60 * 1_000,
  build: 60 * 60 * 1_000,
  smoke: 20 * 60 * 1_000,
  "source-secret-scan": 10 * 60 * 1_000,
}
const environmentSecrets = secretValuesFromEnvironment(process.env)
const supervisor = new BunProcessSupervisor()
const closureAbortController = new AbortController()
const intendedEvidenceFiles = new Map<string, { readonly bytes: number; readonly sha256: string }>()
const sha256Pattern = /^[a-f0-9]{64}$/u
const candidateDigestPattern = /^sha256:[a-f0-9]{64}$/u
const requiredBlockerRequirements = {
  "BLK-SOURCE-BINDING": ["R003", "R055", "R066", "R069", "R070"],
  "BLK-AUTH-REAL": ["R007", "R008"],
  "BLK-R015-REVIEW": ["R015"],
  "BLK-R063-FORGE": ["R063"],
  "BLK-MULTIPLATFORM": ["R044", "R055", "R070"],
  "BLK-SANDBOX-EXT": ["R064"],
  "BLK-RELEASE": ["R003", "R055", "R066", "R069", "R070"],
  "BLK-COMPAT-BINARIES": ["R017", "R036", "R068"],
} as const
const requiredGlobalSentinels = [
  "packages/supervisor/tests/supervisor.test.ts",
  "tests/integration/s12-sample-e2e.test.ts",
  "tests/unit/ci-evidence-structure.test.ts",
  "tests/unit/opencode-provenance.test.ts",
  "tests/unit/release-candidate-input.test.ts",
  "tests/unit/release-sbom-license-inventory.test.ts",
  "tests/unit/s12-closure-structure.test.ts",
] as const
const structuredSecretPattern = new RegExp(
  String.raw`((?:api[_-]?key|access[_-]?token|refresh[_-]?token|` +
    String.raw`client[_-]?secret|password)\s*["']?\s*[:=]\s*["']?)[^\s,"']+`,
  "giu",
)

function containsC0OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}
const excludedSourceDirectories = new Set([
  ".git",
  ".ralph",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
])

interface Arguments {
  readonly evidenceRoot: string
  readonly legacyBinary?: string
  readonly nextBinary?: string
  readonly candidateDigest?: string
  readonly candidateArtifact?: string
  readonly waiverArtifact?: string
  readonly waiverDigest?: string
  readonly gitleaksBinary?: string
  readonly gitleaksSha256?: string
}

interface CapturedText {
  readonly text: string
  readonly bytes: number
  readonly retainedBytes: number
  readonly archivedBytes: number
  readonly truncated: boolean
  readonly sha256: string
}

interface StepResult {
  readonly id: string
  readonly label: string
  readonly command: readonly string[]
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly timeoutMs: number
  readonly timedOut: boolean
  readonly treeTerminationRequested: boolean
  readonly treeTerminated: boolean
  readonly exitCode: number
  readonly status: "pass" | "fail"
  readonly stdout: Omit<CapturedText, "text">
  readonly stderr: Omit<CapturedText, "text">
  readonly logs: {
    readonly stdout: string
    readonly stderr: string
  }
  readonly executable: {
    readonly requested: string
    readonly canonical: string | null
    readonly sha256: string | null
  }
}

interface FileReceipt {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

const FileReceiptSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(sha256Pattern),
  })
  .strict()

interface RequirementItem {
  readonly id: string
  readonly owner: string
  readonly state: string
  readonly evidence: string
}

const NonGrantedWaiverSchema = z
  .object({
    disposition: z.literal("not-granted"),
    owner: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
    expiresOn: z.null(),
    candidateDigest: z.null(),
  })
  .strict()
const RegistryWaiverSchema = NonGrantedWaiverSchema
const WaiverableBlockerIdSchema = z.enum([
  "BLK-AUTH-REAL",
  "BLK-R015-REVIEW",
  "BLK-R063-FORGE",
  "BLK-MULTIPLATFORM",
  "BLK-SANDBOX-EXT",
  "BLK-RELEASE",
  "BLK-COMPAT-BINARIES",
])
const ExternalWaiverApprovalSchema = z
  .object({
    blockerId: WaiverableBlockerIdSchema,
    disposition: z.literal("approved"),
    owner: z.string().trim().min(1).max(200),
    rationale: z.string().trim().min(1).max(4_000),
    approvalRef: z
      .string()
      .trim()
      .regex(/^(?:https:\/\/[^\s@?#]+|sha256:[a-f0-9]{64})$/u),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  })
  .strict()
const ExternalWaiverArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactClass: z.literal("ralph-release-candidate-waiver-approvals"),
    subject: z
      .object({
        effectiveCandidateDigest: z.string().regex(candidateDigestPattern),
        candidateMetadataDigest: z.string().regex(candidateDigestPattern),
        repositoryIdentitySha256: z.string().regex(sha256Pattern),
        commit: z.string().regex(/^[a-f0-9]{40}$/u),
        sourceFingerprintSha256: z.string().regex(sha256Pattern),
      })
      .strict(),
    issuedAt: z.iso.datetime({ offset: true }),
    approvals: z.array(ExternalWaiverApprovalSchema).min(1).max(7),
  })
  .strict()
  .superRefine((artifact, context) => {
    const ids = artifact.approvals.map((approval) => approval.blockerId)
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["approvals"],
        message: "External waiver approvals repeat a blocker ID",
      })
    }
    const sorted = [...ids].sort(compareUtf8Bytes)
    if (JSON.stringify(ids) !== JSON.stringify(sorted)) {
      context.addIssue({
        code: "custom",
        path: ["approvals"],
        message: "External waiver approvals must be sorted by blocker ID",
      })
    }
  })
const RegistryBlockerSchema = z
  .object({
    id: z.string().regex(/^BLK-[A-Z0-9-]+$/u),
    status: z.enum(["open", "conditional"]),
    owner: z.string().trim().min(1),
    disposition: z.string().trim().min(1),
    affectedRequirements: z.array(z.string().regex(/^R\d{3}$/u)).min(1),
    requiredEvidence: z.array(z.string().trim().min(1)).min(1),
    waiver: RegistryWaiverSchema,
  })
  .strict()
const BlockerRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactClass: z.literal("s11-s12-release-blocker-registry"),
    policy: z
      .object({
        partialRequirementsBlockRelease: z.literal(true),
        waiversMustBeCandidateBound: z.literal(true),
        waiverAuthority: z.literal("external-candidate-bound-artifact"),
        nonWaivableBlockers: z.tuple([z.literal("BLK-SOURCE-BINDING")]),
        waiverRequiredFields: z.tuple([
          z.literal("owner"),
          z.literal("rationale"),
          z.literal("expiresOn"),
          z.literal("effectiveCandidateDigest"),
          z.literal("approvalRef"),
        ]),
        note: z.string().trim().min(1),
      })
      .strict(),
    blockers: z.array(RegistryBlockerSchema),
  })
  .strict()
type RegistryWaiver = z.infer<typeof RegistryWaiverSchema>
type ExternalWaiverApproval = z.infer<typeof ExternalWaiverApprovalSchema>
type ExternalWaiverArtifact = z.infer<typeof ExternalWaiverArtifactSchema>
type RegistryBlocker = z.infer<typeof RegistryBlockerSchema>
type BlockerRegistry = z.infer<typeof BlockerRegistrySchema>

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
  return value
}

function parseArguments(argv: readonly string[]): Arguments {
  let evidenceRoot: string | undefined
  let legacyBinary: string | undefined
  let nextBinary: string | undefined
  let candidateDigest: string | undefined
  let candidateArtifact: string | undefined
  let waiverArtifact: string | undefined
  let waiverDigest: string | undefined
  let gitleaksBinary: string | undefined
  let gitleaksSha256: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === "--") throw new Error("Bare -- is not supported by the closure runner")
    if (!flag) throw new Error("Closure arguments contain an empty flag")
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${flag}`)
    seen.add(flag)
    const value = requiredValue(argv, index, flag ?? "<missing>")
    if (flag === "--evidence-root") evidenceRoot = value
    else if (flag === "--legacy-binary") legacyBinary = value
    else if (flag === "--next-binary") nextBinary = value
    else if (flag === "--candidate-digest") candidateDigest = value.toLowerCase()
    else if (flag === "--candidate-artifact") candidateArtifact = value
    else if (flag === "--waiver-artifact") waiverArtifact = value
    else if (flag === "--waiver-digest") waiverDigest = value.toLowerCase()
    else if (flag === "--gitleaks-binary") gitleaksBinary = value
    else if (flag === "--gitleaks-sha256") gitleaksSha256 = value.toLowerCase()
    else throw new Error(`Unknown argument: ${flag ?? "<missing>"}`)
    index += 1
  }
  if (!evidenceRoot) throw new Error("--evidence-root is required")
  if (candidateDigest && !candidateDigestPattern.test(candidateDigest)) {
    throw new Error("--candidate-digest must use sha256:<64 lowercase hex>")
  }
  if (Boolean(candidateDigest) !== Boolean(candidateArtifact)) {
    throw new Error("--candidate-digest and --candidate-artifact must be supplied together")
  }
  if (Boolean(waiverDigest) !== Boolean(waiverArtifact)) {
    throw new Error("--waiver-digest and --waiver-artifact must be supplied together")
  }
  if (waiverDigest && !candidateDigestPattern.test(waiverDigest)) {
    throw new Error("--waiver-digest must use sha256:<64 lowercase hex>")
  }
  if (waiverArtifact && !candidateArtifact) {
    throw new Error("External waiver approvals require an explicit candidate artifact/digest")
  }
  if (Boolean(gitleaksBinary) !== Boolean(gitleaksSha256)) {
    throw new Error("--gitleaks-binary and --gitleaks-sha256 must be supplied together")
  }
  if (gitleaksSha256 && !sha256Pattern.test(gitleaksSha256)) {
    throw new Error("--gitleaks-sha256 must be 64 lowercase hexadecimal characters")
  }
  return {
    evidenceRoot,
    ...(legacyBinary ? { legacyBinary } : {}),
    ...(nextBinary ? { nextBinary } : {}),
    ...(candidateDigest ? { candidateDigest } : {}),
    ...(candidateArtifact ? { candidateArtifact } : {}),
    ...(waiverArtifact ? { waiverArtifact } : {}),
    ...(waiverDigest ? { waiverDigest } : {}),
    ...(gitleaksBinary ? { gitleaksBinary } : {}),
    ...(gitleaksSha256 ? { gitleaksSha256 } : {}),
  }
}

function portableProjectPath(path: string): string {
  const projectRelative = relative(projectRoot, path)
  if (
    projectRelative === ".." ||
    projectRelative.startsWith(`..${sep}`) ||
    isAbsolute(projectRelative)
  ) {
    return `<EXTERNAL>/${basename(path)}`
  }
  return projectRelative.replaceAll("\\", "/") || "."
}

function portableEvidencePath(evidenceRoot: string, path: string): string {
  const portable = relative(evidenceRoot, path).replaceAll("\\", "/") || "."
  if (portable === ".." || portable.startsWith("../") || isAbsolute(portable)) {
    throw new Error(`Evidence path escaped its run root: ${portableProjectPath(path)}`)
  }
  return portable
}

function insideDirectory(directory: string, path: string): boolean {
  const directoryRelative = relative(directory, path)
  return (
    directoryRelative !== ".." &&
    !directoryRelative.startsWith(`..${sep}`) &&
    !isAbsolute(directoryRelative)
  )
}

function comparablePath(value: string): string {
  const absolute = resolve(value)
  return process.platform === "win32" ? absolute.toLocaleLowerCase("und") : absolute
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right)
}

function resolveEvidenceRoot(value: string): string {
  const absolute = resolve(projectRoot, value)
  const runName = basename(absolute)
  if (
    !samePath(dirname(absolute), closureBase) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runName) ||
    runName === "." ||
    runName === ".."
  ) {
    throw new Error(
      `--evidence-root must be one new portable direct child of ` +
        `${portableProjectPath(closureBase)}: ${value}`,
    )
  }
  return absolute
}

async function assertCanonicalDirectory(path: string, expectedParent?: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Expected a real non-reparse directory: ${portableProjectPath(path)}`)
  }
  const canonical = await realpath(path)
  if (!samePath(canonical, path)) {
    throw new Error(`Directory resolves through a link or junction: ${portableProjectPath(path)}`)
  }
  if (expectedParent && !samePath(dirname(canonical), expectedParent)) {
    throw new Error(`Directory parent changed during creation: ${portableProjectPath(path)}`)
  }
  return canonical
}

async function prepareEvidenceRoot(path: string): Promise<void> {
  const canonicalProjectRoot = await assertCanonicalDirectory(projectRoot)
  let parent = canonicalProjectRoot
  for (const component of ["artifacts", "ci", "s11-closure"] as const) {
    const child = join(parent, component)
    try {
      await assertCanonicalDirectory(child, parent)
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: unknown }).code !== "ENOENT"
      ) {
        throw error
      }
      await mkdir(child)
      await assertCanonicalDirectory(child, parent)
    }
    parent = child
  }
  if (!samePath(parent, closureBase) || !samePath(dirname(path), parent)) {
    throw new Error("Evidence root parent differs from the validated closure directory")
  }
  await mkdir(path)
  await assertCanonicalDirectory(path, parent)
}

async function writeEvidenceFile(path: string, value: string): Promise<void> {
  const absolute = resolve(path)
  const closureRelative = relative(closureBase, absolute)
  if (
    closureRelative === ".." ||
    closureRelative.startsWith(`..${sep}`) ||
    isAbsolute(closureRelative)
  ) {
    throw new Error(`Evidence write escaped the closure base: ${portableProjectPath(absolute)}`)
  }
  const segments = closureRelative.split(sep)
  if (segments.length < 2) throw new Error("Evidence write must target a file inside one run root")
  let parent = await assertCanonicalDirectory(closureBase)
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment)
    await assertCanonicalDirectory(parent, dirname(parent))
  }
  if (!samePath(parent, dirname(absolute))) {
    throw new Error(`Evidence parent changed before write: ${portableProjectPath(absolute)}`)
  }
  await writeFile(absolute, value, { encoding: "utf8", flag: "wx" })
  const written = await lstat(absolute)
  if (
    !written.isFile() ||
    written.isSymbolicLink() ||
    !samePath(await realpath(absolute), absolute)
  ) {
    throw new Error(
      `Evidence output is not a canonical regular file: ${portableProjectPath(absolute)}`,
    )
  }
  const bytes = Buffer.byteLength(value)
  intendedEvidenceFiles.set(comparablePath(absolute), {
    bytes,
    sha256: createHash("sha256").update(value).digest("hex"),
  })
}

function assertIntendedEvidenceFiles(
  evidenceRoot: string,
  inventory: readonly FileReceipt[],
): void {
  const actualByPath = new Map(
    inventory.map((file) => [comparablePath(resolve(evidenceRoot, file.path)), file]),
  )
  for (const [path, expected] of intendedEvidenceFiles) {
    const actual = actualByPath.get(path)
    if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error("A runner-authored evidence file differs from its intended bytes")
    }
  }
}

export function redactClosureText(
  value: string,
  secrets: readonly string[] = environmentSecrets,
): string {
  return redactText(value, secrets)
    .replace(/\b(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "$1[REDACTED]@")
    .replace(/\b(https?:\/\/[^\s?#]+)[?#][^\s]*/giu, "$1[REDACTED_URL_SUFFIX]")
    .replace(
      /(authorization\s*["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+)[^\s"']+/giu,
      "$1<REDACTED>",
    )
    .replace(structuredSecretPattern, "$1<REDACTED>")
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password)=)[^&#\s]+/giu,
      "$1<REDACTED>",
    )
    .replace(/\bsk-[a-z\d_-]{12,}\b/giu, "<REDACTED_OPENAI_KEY>")
    .replace(/\bgh[opusr]_[a-z\d]{20,}\b/giu, "<REDACTED_GITHUB_TOKEN>")
}

function redactTruncatedSuffix(value: string, redacted: string): string {
  for (const secret of environmentSecrets) {
    const maximum = Math.min(secret.length - 1, value.length)
    for (let length = maximum; length > 0; length -= 1) {
      const prefix = secret.slice(0, length)
      if (!value.endsWith(prefix) || !redacted.endsWith(prefix)) continue
      return `${redacted.slice(0, -length)}[REDACTED_TRUNCATED_SECRET]`
    }
  }
  return redacted
}

function capturedText(value: string, bytes: number, truncated: boolean): CapturedText {
  const retainedBytes = Buffer.byteLength(value)
  const suffix = truncated
    ? `\n<OUTPUT_TRUNCATED total-bytes=${bytes} retained-bytes=${retainedBytes}>\n`
    : ""
  const redacted = redactClosureText(value)
  const safeRedacted = truncated ? redactTruncatedSuffix(value, redacted) : redacted
  const text = `${safeRedacted}${suffix}`
  return {
    text,
    bytes,
    retainedBytes,
    archivedBytes: Buffer.byteLength(text),
    truncated,
    sha256: createHash("sha256").update(text).digest("hex"),
  }
}

function redactGitRemoteOutput(value: string): string {
  return value.trim().length > 0 ? "<REMOTE_CONFIGURATION_PRESENT; URL_REDACTED>\n" : ""
}

function capturedMetadata(capture: CapturedText): Omit<CapturedText, "text"> {
  return {
    bytes: capture.bytes,
    retainedBytes: capture.retainedBytes,
    archivedBytes: capture.archivedBytes,
    truncated: capture.truncated,
    sha256: capture.sha256,
  }
}

function withArchiveNote(capture: CapturedText, note: string): CapturedText {
  const text = `${capture.text}${capture.text.endsWith("\n") || !capture.text ? "" : "\n"}${note}\n`
  return {
    ...capture,
    text,
    archivedBytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  }
}

const closureEnvironmentAllowlist = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "SystemDrive",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "TMP",
  "TEMP",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CACHE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const

async function runStep(
  evidenceRoot: string,
  step: CheckStep,
  localGate: boolean,
  approvedExecutable?: { readonly canonical: string; readonly sha256: string },
  observeRawOutput?: (stdout: string, stderr: string) => void,
): Promise<StepResult & { readonly localGate: boolean }> {
  await assertCanonicalDirectory(evidenceRoot, closureBase)
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const timeoutMs = stepTimeoutsMs[step.id] ?? defaultStepTimeoutMs
  let stdout: CapturedText
  let stderr: CapturedText
  let exitCode: number
  let timedOut = false
  let treeTerminationRequested = false
  let treeTerminated = false
  let canonicalExecutable: string | null = null
  let executableSha256: string | null = null
  try {
    const requestedExecutable = step.command[0]
    if (!requestedExecutable) throw new Error(`Step ${step.id} has no executable`)
    const resolvedExecutable = isAbsolute(requestedExecutable)
      ? await realpath(requestedExecutable)
      : supervisor.which(requestedExecutable, process.env)
    if (!resolvedExecutable) throw new Error(`Executable is unavailable: ${requestedExecutable}`)
    canonicalExecutable = await realpath(resolvedExecutable)
    executableSha256 = await sha256File(canonicalExecutable)
    if (
      approvedExecutable &&
      (!samePath(canonicalExecutable, approvedExecutable.canonical) ||
        executableSha256 !== approvedExecutable.sha256)
    ) {
      throw new Error(`Step ${step.id} executable differs from its approved path/hash binding`)
    }
    const canonicalProjectRoot = await realpath(projectRoot)
    const settlement: ProcessSettlement = await supervisor.run({
      executable: canonicalExecutable,
      args: step.command.slice(1),
      cwd: projectRoot,
      environment: process.env,
      environmentAllowlist: closureEnvironmentAllowlist,
      shell: false,
      timeoutMs,
      gracePeriodMs: 5_000,
      outputLimitBytes: maximumLogBytes,
      rawOutputLimitBytes: maximumLogBytes,
      secretValues: environmentSecrets,
      expectedCanonicalCwd: canonicalProjectRoot,
      expectedExecutableSha256: approvedExecutable?.sha256 ?? executableSha256,
      signal: closureAbortController.signal,
    })
    timedOut = settlement.timedOut
    treeTerminationRequested = settlement.timedOut || settlement.cancelled
    treeTerminated = settlement.treeTerminated
    observeRawOutput?.(settlement.rawStdout, settlement.rawStderr)
    const isRemoteProbe = step.id === "git-remotes" || step.id.startsWith("git-remote-")
    const archivalStdout = isRemoteProbe
      ? redactGitRemoteOutput(settlement.rawStdout)
      : settlement.rawStdout
    const archivalStderr = isRemoteProbe
      ? redactGitRemoteOutput(settlement.rawStderr)
      : settlement.rawStderr
    stdout = capturedText(archivalStdout, settlement.stdoutBytes, settlement.rawOutputTruncated)
    stderr = capturedText(archivalStderr, settlement.stderrBytes, settlement.rawOutputTruncated)
    exitCode = settlement.exitCode ?? 127
    if (timedOut) {
      exitCode = 124
      stderr = withArchiveNote(
        stderr,
        `<HARD_TIMEOUT milliseconds=${timeoutMs} policy=wall-clock-not-silence>`,
      )
    }
    if (settlement.error) {
      stderr = withArchiveNote(stderr, `<SUPERVISOR_ERROR>${redactClosureText(settlement.error)}`)
      if (exitCode === 0) exitCode = 127
    }
    if (settlement.cancelled && !timedOut && exitCode === 0) exitCode = 130
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    stdout = {
      text: "",
      bytes: 0,
      retainedBytes: 0,
      archivedBytes: 0,
      truncated: false,
      sha256: createHash("sha256").digest("hex"),
    }
    const redacted = redactClosureText(message)
    stderr = {
      text: `${redacted}\n`,
      bytes: Buffer.byteLength(message),
      retainedBytes: Buffer.byteLength(message),
      archivedBytes: Buffer.byteLength(`${redacted}\n`),
      truncated: false,
      sha256: createHash("sha256").update(`${redacted}\n`).digest("hex"),
    }
    exitCode = 127
  }
  const stdoutPath = resolve(evidenceRoot, "logs", `${step.id}.stdout.log`)
  const stderrPath = resolve(evidenceRoot, "logs", `${step.id}.stderr.log`)
  await writeEvidenceFile(stdoutPath, stdout.text)
  await writeEvidenceFile(stderrPath, stderr.text)
  return {
    id: step.id,
    label: step.label,
    command: step.command.map((argument) => redactClosureText(portableCommandArgument(argument))),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    timeoutMs,
    timedOut,
    treeTerminationRequested,
    treeTerminated,
    exitCode,
    status: exitCode === 0 ? "pass" : "fail",
    stdout: capturedMetadata(stdout),
    stderr: capturedMetadata(stderr),
    logs: {
      stdout: portableEvidencePath(evidenceRoot, stdoutPath),
      stderr: portableEvidencePath(evidenceRoot, stderrPath),
    },
    executable: {
      requested: redactClosureText(portableCommandArgument(step.command[0] ?? "<missing>")),
      canonical: canonicalExecutable ? portableProjectPath(canonicalExecutable) : null,
      sha256: executableSha256,
    },
    localGate,
  }
}

async function observeGitSource(evidenceRoot: string, phase: "before" | "after") {
  let rawHead = ""
  let rawStatus = ""
  let repository: string | null = null
  const headStep = await runStep(
    evidenceRoot,
    {
      id: `git-head-${phase}`,
      label: `Immutable Git HEAD probe (${phase})`,
      command: ["git", "rev-parse", "--verify", "HEAD^{commit}"],
    },
    false,
    undefined,
    (stdout) => {
      rawHead = stdout
    },
  )
  const statusStep = await runStep(
    evidenceRoot,
    {
      id: `git-status-${phase}`,
      label: `Git source-tree status probe (${phase})`,
      command: ["git", "status", "--porcelain=v1", "--untracked-files=all"],
    },
    false,
    undefined,
    (stdout) => {
      rawStatus = stdout
    },
  )
  const remoteStep = await runStep(
    evidenceRoot,
    {
      id: `git-remote-${phase}`,
      label: `Canonical Git origin probe (${phase})`,
      command: ["git", "remote", "get-url", "origin"],
    },
    false,
    undefined,
    (stdout) => {
      repository = canonicalReleaseRepository(stdout.trim())
    },
  )
  const head = /^[a-f\d]{40}$/iu.test(rawHead.trim()) ? rawHead.trim().toLowerCase() : null
  const clean = statusStep.status === "pass" && rawStatus.trim().length === 0
  const repositorySha256 = repository ? createHash("sha256").update(repository).digest("hex") : null
  return {
    steps: [headStep, statusStep, remoteStep] as const,
    probes: {
      head: headStep.logs,
      status: statusStep.logs,
      remote: remoteStep.logs,
    },
    head,
    clean,
    repository,
    repositorySha256,
    valid:
      headStep.status === "pass" &&
      statusStep.status === "pass" &&
      remoteStep.status === "pass" &&
      head !== null &&
      clean &&
      repository !== null,
  }
}

interface FinalGitObservation {
  readonly status: "matched" | "not-required-source-unbound"
  readonly observedAt: string
  readonly head: string | null
  readonly clean: boolean
  readonly repositoryIdentitySha256: string | null
  readonly executableSha256: string | null
}

const FinalGitObservationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("matched"),
      observedAt: z.iso.datetime({ offset: true }),
      head: z.string().regex(/^[a-f0-9]{40}$/u),
      clean: z.literal(true),
      repositoryIdentitySha256: z.string().regex(sha256Pattern),
      executableSha256: z.string().regex(sha256Pattern),
    })
    .strict(),
  z
    .object({
      status: z.literal("not-required-source-unbound"),
      observedAt: z.iso.datetime({ offset: true }),
      head: z.null(),
      clean: z.literal(false),
      repositoryIdentitySha256: z.null(),
      executableSha256: z.null(),
    })
    .strict(),
])

const FinalCandidateObservationSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("matched"),
      metadataSha256: z.string().regex(sha256Pattern),
      metadataSizeBytes: z.number().int().positive().safe(),
      effectiveCandidateDigest: z.string().regex(candidateDigestPattern),
      payloadContentAddress: z.string().regex(candidateDigestPattern),
    })
    .strict(),
  z.object({ status: z.literal("not-verified") }).strict(),
])

const completionAuthority =
  "This valid post-envelope receipt is the only final status authority; run-manifest.json, blockers.json, source-binding.json and evidence-manifest.json are provisional without it."

const ClosureCompletionReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactClass: z.literal("s11-s12-closure-completion"),
    status: z.enum([
      "local-fail/release-blocked",
      "local-pass/release-blocked",
      "local-pass/release-ready",
    ]),
    localStatus: z.enum(["pass", "fail"]),
    releaseStatus: z.enum(["ready", "blocked"]),
    releaseEligible: z.boolean(),
    finishedAt: z.iso.datetime({ offset: true }),
    openBlockers: z.array(z.string().regex(/^BLK-[A-Z0-9-]+$/u)).max(8),
    payloadContentAddress: z.string().regex(candidateDigestPattern),
    envelope: z
      .object({
        manifest: FileReceiptSchema,
        checksums: FileReceiptSchema,
        sourceBinding: FileReceiptSchema,
        candidateBinding: FileReceiptSchema,
        waiverBinding: FileReceiptSchema,
      })
      .strict(),
    sourceBinding: z
      .object({
        resolved: z.boolean(),
        boundSourceSubjectSha256: z.string().regex(sha256Pattern).nullable(),
        finalSourceContentAddressSha256: z.string().regex(sha256Pattern),
        finalSourceFingerprintSha256: z.string().regex(sha256Pattern),
        finalGit: FinalGitObservationSchema,
      })
      .strict(),
    candidate: z
      .object({
        effectiveCandidateDigest: z.string().regex(candidateDigestPattern).nullable(),
        finalObservation: FinalCandidateObservationSchema,
        waiverBinding: z.literal("waiver-binding.json"),
      })
      .strict(),
    waivers: z
      .object({
        evaluatedAt: z.iso.datetime({ offset: true }),
        approvedBlockerIds: z.array(z.string().regex(/^BLK-[A-Z0-9-]+$/u)).max(7),
        earliestExpiry: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/u)
          .nullable(),
      })
      .strict(),
    authority: z.literal(completionAuthority),
  })
  .strict()
  .superRefine((receipt, context) => {
    const expectedEligible = receipt.localStatus === "pass" && receipt.releaseStatus === "ready"
    const expectedStatus =
      receipt.localStatus === "fail"
        ? "local-fail/release-blocked"
        : receipt.releaseStatus === "ready"
          ? "local-pass/release-ready"
          : "local-pass/release-blocked"
    if (receipt.releaseEligible !== expectedEligible || receipt.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Closure completion status fields are inconsistent",
      })
    }
    if (
      receipt.sourceBinding.resolved !== (receipt.sourceBinding.finalGit.status === "matched") ||
      receipt.sourceBinding.resolved !== (receipt.sourceBinding.boundSourceSubjectSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceBinding"],
        message: "Closure completion source binding lacks its final Git observation",
      })
    }
    if (
      receipt.candidate.effectiveCandidateDigest === null
        ? receipt.candidate.finalObservation.status !== "not-verified"
        : receipt.candidate.finalObservation.status !== "matched" ||
          receipt.candidate.finalObservation.effectiveCandidateDigest !==
            receipt.candidate.effectiveCandidateDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidate"],
        message: "Closure completion candidate observation is inconsistent",
      })
    }
    const blockerIds = receipt.openBlockers
    const approvedIds = receipt.waivers.approvedBlockerIds
    if (
      new Set(blockerIds).size !== blockerIds.length ||
      JSON.stringify(blockerIds) !== JSON.stringify([...blockerIds].sort(compareUtf8Bytes)) ||
      new Set(approvedIds).size !== approvedIds.length ||
      JSON.stringify(approvedIds) !== JSON.stringify([...approvedIds].sort(compareUtf8Bytes))
    ) {
      context.addIssue({
        code: "custom",
        path: ["openBlockers"],
        message: "Closure completion blocker IDs must be unique and sorted",
      })
    }
    if (
      approvedIds.some((id) => blockerIds.includes(id)) ||
      (approvedIds.length === 0) !== (receipt.waivers.earliestExpiry === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["waivers"],
        message: "Closure completion waiver resolution is inconsistent",
      })
    }
    if (
      receipt.releaseEligible &&
      (!receipt.sourceBinding.resolved ||
        receipt.candidate.effectiveCandidateDigest === null ||
        receipt.openBlockers.length !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["releaseEligible"],
        message: "Closure completion cannot make an unbound or blocked release eligible",
      })
    }
  })

async function finalGitObservation(input: {
  readonly required: boolean
  readonly expectedHead: string | null
  readonly expectedRepository: string | null
  readonly expectedExecutableSha256: string | null
}): Promise<FinalGitObservation> {
  const observedAt = new Date().toISOString()
  if (!input.required) {
    return {
      status: "not-required-source-unbound",
      observedAt,
      head: null,
      clean: false,
      repositoryIdentitySha256: null,
      executableSha256: null,
    }
  }
  if (!input.expectedHead || !input.expectedRepository || !input.expectedExecutableSha256) {
    throw new Error("Final Git observation lacks an earlier source-binding prerequisite")
  }
  const resolvedExecutable = supervisor.which("git", process.env)
  if (!resolvedExecutable) throw new Error("Git became unavailable before closure completion")
  const canonicalExecutable = await realpath(resolvedExecutable)
  const executableSha256 = await sha256File(canonicalExecutable)
  if (executableSha256 !== input.expectedExecutableSha256) {
    throw new Error("Git executable changed after the archived source probes")
  }
  const canonicalProjectRoot = await realpath(projectRoot)
  const runGit = async (args: readonly string[]): Promise<string> => {
    const settlement = await supervisor.run({
      executable: canonicalExecutable,
      args,
      cwd: projectRoot,
      environment: process.env,
      environmentAllowlist: closureEnvironmentAllowlist,
      shell: false,
      timeoutMs: 60_000,
      gracePeriodMs: 5_000,
      outputLimitBytes: 1024 * 1024,
      rawOutputLimitBytes: 1024 * 1024,
      secretValues: environmentSecrets,
      expectedCanonicalCwd: canonicalProjectRoot,
      expectedExecutableSha256: executableSha256,
      signal: closureAbortController.signal,
    })
    if (
      settlement.exitCode !== 0 ||
      settlement.timedOut ||
      settlement.cancelled ||
      settlement.rawOutputTruncated ||
      settlement.error
    ) {
      throw new Error("Final Git source observation failed before closure completion")
    }
    return settlement.rawStdout.trim()
  }
  const head = (await runGit(["rev-parse", "--verify", "HEAD^{commit}"])).toLowerCase()
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"])
  const repository = canonicalReleaseRepository(await runGit(["remote", "get-url", "origin"]))
  if (!/^[a-f0-9]{40}$/u.test(head)) {
    throw new Error("Final Git HEAD observation is invalid")
  }
  if (
    head !== input.expectedHead ||
    status.length !== 0 ||
    repository !== input.expectedRepository
  ) {
    throw new Error("Git source identity or cleanliness changed before closure completion")
  }
  return {
    status: "matched",
    observedAt: new Date().toISOString(),
    head,
    clean: true,
    repositoryIdentitySha256: createHash("sha256").update(repository).digest("hex"),
    executableSha256,
  }
}

function portableCommandArgument(argument: string): string {
  if (isAbsolute(argument)) return portableProjectPath(argument)
  return argument
}

async function hashRegularFile(path: string): Promise<FileReceipt> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Expected a regular non-symlink file: ${portableProjectPath(path)}`)
  }
  const canonical = await realpath(path)
  if (!samePath(canonical, path)) {
    throw new Error(`File resolves through a link or junction: ${portableProjectPath(path)}`)
  }
  const sha256 = await sha256File(canonical)
  const after = await lstat(path)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error(`File changed while hashing: ${portableProjectPath(path)}`)
  }
  return {
    path: portableProjectPath(path),
    bytes: after.size,
    sha256,
  }
}

function assertPortableInventoryPath(path: string): void {
  const segments = path.split("/")
  if (
    !path ||
    path.normalize("NFC") !== path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    containsC0OrDeleteControl(path) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[<>:"|?*]/u.test(segment) ||
        /[ .]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment),
    )
  ) {
    throw new Error(`Inventory path is not portable and canonical: ${JSON.stringify(path)}`)
  }
}

async function collectInventory(
  root: string,
  directory = root,
  exclusions: ReadonlySet<string> = new Set(),
  ignoreWorkspaceDependencyLinks = false,
): Promise<readonly FileReceipt[]> {
  const canonicalRoot = await realpath(root)
  const canonicalDirectory = await realpath(directory)
  if (
    !insideDirectory(canonicalRoot, canonicalDirectory) &&
    !samePath(canonicalRoot, canonicalDirectory)
  ) {
    throw new Error(`Inventory directory escaped its root: ${portableProjectPath(directory)}`)
  }
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error(
      `Inventory root contains a reparse directory: ${portableProjectPath(directory)}`,
    )
  }
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    compareUtf8Bytes(left.name, right.name),
  )
  const files: FileReceipt[] = []
  for (const entry of entries) {
    const directoryRelative = relative(root, directory).replaceAll("\\", "/")
    const workspaceSegments = directoryRelative ? directoryRelative.split("/") : []
    if (
      ignoreWorkspaceDependencyLinks &&
      entry.name === "node_modules" &&
      workspaceSegments.length === 2 &&
      (workspaceSegments[0] === "apps" || workspaceSegments[0] === "packages")
    ) {
      continue
    }
    const path = resolve(directory, entry.name)
    const info = await lstat(path)
    if (entry.isSymbolicLink() || info.isSymbolicLink()) {
      throw new Error(`Inventory cannot contain links or junctions: ${portableProjectPath(path)}`)
    }
    if (entry.isDirectory() && info.isDirectory()) {
      if (!samePath(directory, root) || !exclusions.has(entry.name)) {
        files.push(
          ...(await collectInventory(root, path, exclusions, ignoreWorkspaceDependencyLinks)),
        )
      }
      continue
    }
    if (!entry.isFile() || !info.isFile()) {
      throw new Error(`Unsupported inventory entry: ${portableProjectPath(path)}`)
    }
    const receipt = await hashRegularFile(path)
    const portable = relative(root, path).replaceAll("\\", "/")
    assertPortableInventoryPath(portable)
    files.push({ ...receipt, path: portable })
  }
  return files.sort((left, right) => compareUtf8Bytes(left.path, right.path))
}

function inventoryAddress(files: readonly FileReceipt[]): string {
  const sorted = [...files].sort((left, right) => compareUtf8Bytes(left.path, right.path))
  const paths = new Set<string>()
  const caseFoldedPaths = new Set<string>()
  for (const file of sorted) {
    assertPortableInventoryPath(file.path)
    if (!sha256Pattern.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`Inventory receipt is invalid: ${file.path}`)
    }
    if (paths.has(file.path)) throw new Error(`Inventory path is duplicated: ${file.path}`)
    const caseFolded = file.path.toLocaleLowerCase("und")
    if (caseFoldedPaths.has(caseFolded)) {
      throw new Error(`Inventory paths collide on a case-insensitive filesystem: ${file.path}`)
    }
    paths.add(file.path)
    caseFoldedPaths.add(caseFolded)
  }
  const canonical = JSON.stringify({
    schemaVersion: 1,
    files: sorted.map((file) => [file.path, file.bytes, file.sha256]),
  })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

function sameCandidateInput(left: ReleaseCandidateInput, right: ReleaseCandidateInput): boolean {
  return (
    samePath(left.path, right.path) &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes &&
    left.kind === right.kind &&
    left.payloadContentAddress === right.payloadContentAddress &&
    JSON.stringify(left.subject) === JSON.stringify(right.subject) &&
    JSON.stringify(left.payloads) === JSON.stringify(right.payloads)
  )
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink() && samePath(await realpath(path), path)
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return false
    }
    throw error
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeEvidenceFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function parseRequirements(markdown: string): readonly RequirementItem[] {
  const heading = "## Ledger executável S11 por requisito"
  const start = markdown.indexOf(heading)
  if (start < 0) throw new Error(`Requirement ledger heading not found: ${heading}`)
  const items: RequirementItem[] = []
  for (const line of markdown.slice(start + heading.length).split(/\r?\n/u)) {
    if (!/^\|\s*R\d{3}\s*\|/u.test(line)) continue
    const columns = line
      .split("|")
      .slice(1, -1)
      .map((column) => column.trim())
    const id = columns[0]
    const owner = columns[1]
    const state = columns[2]?.replaceAll("`", "")
    const evidence = columns.slice(3).join(" | ")
    if (!id || !owner || !state || !evidence) throw new Error(`Malformed ledger row: ${line}`)
    items.push({ id, owner, state, evidence })
  }
  return items
}

function validateRequirements(
  requirements: readonly RequirementItem[],
  registry: BlockerRegistry,
  evidenceCatalogIds: ReadonlySet<string>,
): readonly string[] {
  const issues: string[] = []
  const expectedIds = Array.from(
    { length: 79 },
    (_, index) => `R${String(index + 1).padStart(3, "0")}`,
  )
  const actualIds = requirements.map((requirement) => requirement.id)
  if (new Set(actualIds).size !== actualIds.length) issues.push("Requirement IDs are duplicated")
  for (const id of expectedIds) {
    if (!actualIds.includes(id)) issues.push(`Missing requirement ${id}`)
  }
  for (const id of actualIds) {
    if (!expectedIds.includes(id)) issues.push(`Unexpected requirement ${id}`)
  }
  const allowedStates = new Set([
    "validado-localmente",
    "parcial",
    "prova-pendente",
    "bloqueado-externamente",
  ])
  for (const requirement of requirements) {
    if (!allowedStates.has(requirement.state)) {
      issues.push(`${requirement.id} has unknown state ${requirement.state}`)
    }
    if (!requirement.owner.trim()) issues.push(`${requirement.id} has no owner`)
    if (!requirement.evidence.trim()) issues.push(`${requirement.id} has no evidence or blocker`)
    const evidenceIds = requirement.evidence.match(/\bEV-[A-Z0-9-]+\b/gu) ?? []
    for (const evidenceId of evidenceIds) {
      if (!evidenceCatalogIds.has(evidenceId)) {
        issues.push(`${requirement.id} references unknown evidence ${evidenceId}`)
      }
    }
    if (
      requirement.state === "validado-localmente" &&
      evidenceIds.length === 0 &&
      !/\[[^\]]+\]\((?!https?:\/\/)[^)]+\)/u.test(requirement.evidence)
    ) {
      issues.push(
        `${requirement.id} is validado-localmente without a catalogued evidence ID or local link`,
      )
    }
  }

  const expectedBlockerIds = Object.keys(requiredBlockerRequirements).sort(compareUtf8Bytes)
  const blockerIds = new Set<string>()
  for (const blocker of registry.blockers) {
    if (!/^BLK-[A-Z0-9-]+$/u.test(blocker.id)) issues.push(`Invalid blocker ID ${blocker.id}`)
    if (blockerIds.has(blocker.id)) issues.push(`Duplicate blocker ${blocker.id}`)
    blockerIds.add(blocker.id)
    if (!blocker.owner.trim()) issues.push(`${blocker.id} has no owner`)
    if (!blocker.disposition.trim()) issues.push(`${blocker.id} has no disposition`)
    if (blocker.requiredEvidence.length === 0) issues.push(`${blocker.id} has no required evidence`)
    if (new Set(blocker.affectedRequirements).size !== blocker.affectedRequirements.length) {
      issues.push(`${blocker.id} has duplicate affected requirements`)
    }
    if (new Set(blocker.requiredEvidence).size !== blocker.requiredEvidence.length) {
      issues.push(`${blocker.id} has duplicate required evidence`)
    }
    for (const requirement of blocker.affectedRequirements) {
      if (!expectedIds.includes(requirement)) {
        issues.push(`${blocker.id} references unknown requirement ${requirement}`)
      }
    }
    const expectedRequirements =
      requiredBlockerRequirements[blocker.id as keyof typeof requiredBlockerRequirements]
    if (expectedRequirements) {
      const expected = [...expectedRequirements].sort(compareUtf8Bytes)
      const actual = [...blocker.affectedRequirements].sort(compareUtf8Bytes)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        issues.push(`${blocker.id} affected-requirement set differs from the fixed policy`)
      }
      const expectedStatus = blocker.id === "BLK-COMPAT-BINARIES" ? "conditional" : "open"
      const expectedDisposition =
        blocker.id === "BLK-COMPAT-BINARIES"
          ? "block-release-when-inputs-absent-or-mismatched"
          : "block-release"
      if (blocker.status !== expectedStatus)
        issues.push(`${blocker.id} has an invalid policy status`)
      if (blocker.disposition !== expectedDisposition) {
        issues.push(`${blocker.id} has an invalid policy disposition`)
      }
    }
  }
  const actualBlockerIds = [...blockerIds].sort(compareUtf8Bytes)
  if (JSON.stringify(actualBlockerIds) !== JSON.stringify(expectedBlockerIds)) {
    issues.push(
      `Blocker registry must contain the exact required ID set; expected ` +
        `${expectedBlockerIds.join(", ")}, got ${actualBlockerIds.join(", ")}`,
    )
  }
  for (const requirement of requirements.filter((item) => item.state !== "validado-localmente")) {
    const blockers = registry.blockers.filter((blocker) =>
      blocker.affectedRequirements.includes(requirement.id),
    )
    if (blockers.length === 0) {
      issues.push(`${requirement.id} is ${requirement.state} without a registered blocker`)
    }
  }
  return issues
}

function parseEvidenceCatalogIds(markdown: string): ReadonlySet<string> {
  const heading = "## Catálogo de evidência executada"
  const start = markdown.indexOf(heading)
  const ledgerStart = markdown.indexOf("## Ledger executável S11 por requisito")
  if (start < 0 || ledgerStart <= start) {
    throw new Error("Evidence catalogue is missing or appears after the requirement ledger")
  }
  const ids = new Set<string>()
  for (const match of markdown
    .slice(start, ledgerStart)
    .matchAll(/^\|\s*`?(EV-[A-Z0-9-]+)`?\s*\|/gmu)) {
    const id = match[1]
    if (!id) continue
    if (ids.has(id)) throw new Error(`Duplicate evidence catalogue ID ${id}`)
    ids.add(id)
  }
  if (ids.size === 0) throw new Error("Evidence catalogue contains no EV-* entries")
  return ids
}

function waiverObservation(
  registryDefault: RegistryWaiver,
  approval: ExternalWaiverApproval | undefined,
  artifactEffectiveCandidateDigest: string | undefined,
  effectiveCandidateDigest: string | undefined,
  now = new Date(),
): {
  readonly approvedForRun: boolean
  readonly reason: string
} {
  if (!approval) {
    return {
      approvedForRun: false,
      reason:
        registryDefault.disposition === "not-granted"
          ? "external-waiver-not-supplied"
          : "registry-waiver-policy-invalid",
    }
  }
  if (!effectiveCandidateDigest || !artifactEffectiveCandidateDigest) {
    return { approvedForRun: false, reason: "effective-candidate-digest-unavailable" }
  }
  if (artifactEffectiveCandidateDigest !== effectiveCandidateDigest) {
    return { approvedForRun: false, reason: "effective-candidate-digest-mismatch" }
  }
  const expiresAt = Date.parse(`${approval.expiresOn}T23:59:59.999Z`)
  if (!Number.isFinite(expiresAt)) {
    return { approvedForRun: false, reason: "invalid-expiry-date" }
  }
  const normalized = new Date(expiresAt).toISOString().slice(0, 10)
  if (normalized !== approval.expiresOn) {
    return { approvedForRun: false, reason: "invalid-expiry-date" }
  }
  if (expiresAt < now.getTime()) return { approvedForRun: false, reason: "waiver-expired" }
  return { approvedForRun: true, reason: "approved-candidate-bound-unexpired-waiver" }
}

function lineCount(value: string): number {
  if (!value) return 0
  const count = value.split(/\r\n|\n|\r/u).length
  return /(?:\r\n|\n|\r)$/u.test(value) ? count - 1 : count
}

async function r015ReviewReceipt(): Promise<{
  readonly resolved: boolean
  readonly value: unknown
}> {
  const receiptPath = resolve(projectRoot, "docs", "reviews", "r015-parser-static-review.json")
  const parserPath = resolve(projectRoot, "packages", "prd", "src", "parser.ts")
  const parserBytes = await readStableBoundedFile(parserPath, maximumLogBytes)
  const parserText = new TextDecoder("utf-8", { fatal: true }).decode(parserBytes)
  const parser = {
    path: portableProjectPath(parserPath),
    bytes: parserBytes.byteLength,
    sha256: createHash("sha256").update(parserBytes).digest("hex"),
  }
  const issues: string[] = []
  let receipt: Record<string, unknown> | null = null
  try {
    const raw = await readStableJson(receiptPath)
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push("R015 review receipt must be a JSON object")
    } else {
      receipt = raw as Record<string, unknown>
    }
  } catch (error) {
    issues.push(`R015 review receipt is unavailable or invalid: ${String(error)}`)
  }
  const review = receipt?.review as Record<string, unknown> | undefined
  const source = receipt?.source as Record<string, unknown> | undefined
  const claims = Array.isArray(receipt?.claims) ? receipt.claims : []
  if (receipt?.schemaVersion !== 1) issues.push("R015 receipt schemaVersion must be 1")
  if (receipt?.artifact !== "ralph.r015.parser-static-review") {
    issues.push("R015 receipt artifact class is invalid")
  }
  if (receipt?.requirementId !== "R015" || receipt?.blockerId !== "BLK-R015-REVIEW") {
    issues.push("R015 receipt requirement/blocker identity is invalid")
  }
  if (
    review?.verdict !== "APPROVED" ||
    review.method !== "independent-static-source-review" ||
    typeof review.reviewer !== "string" ||
    review.reviewer.trim().length === 0 ||
    typeof review.reviewedAt !== "string" ||
    !Number.isFinite(Date.parse(review.reviewedAt))
  ) {
    issues.push("R015 review identity, method, date or verdict is invalid")
  }
  if (
    source?.path !== "packages/prd/src/parser.ts" ||
    source.sha256 !== parser.sha256 ||
    source.bytes !== parser.bytes ||
    source.lines !== lineCount(parserText)
  ) {
    issues.push("R015 receipt is stale relative to the current parser bytes/hash/lines")
  }
  const requiredClaims = new Set([
    "safe-yaml-frontmatter",
    "commonmark-ast-structure",
    "regex-bounded-to-leaf-values",
    "marker-edit-is-position-bound",
    "classic-regex-isolation",
  ])
  const confirmedClaims = new Set(
    claims
      .filter(
        (claim): claim is Record<string, unknown> =>
          claim !== null &&
          typeof claim === "object" &&
          !Array.isArray(claim) &&
          (claim as Record<string, unknown>).status === "confirmed",
      )
      .map((claim) => String(claim.id)),
  )
  for (const claim of requiredClaims) {
    if (!confirmedClaims.has(claim)) issues.push(`R015 receipt lacks confirmed claim ${claim}`)
  }
  return {
    resolved: issues.length === 0,
    value: {
      schemaVersion: 1,
      artifactClass: "r015-current-source-review-binding",
      status: issues.length === 0 ? "bound" : "stale-or-invalid",
      receipt: portableProjectPath(receiptPath),
      parser: { ...parser, path: "packages/prd/src/parser.ts", lines: lineCount(parserText) },
      reviewer: typeof review?.reviewer === "string" ? review.reviewer : null,
      reviewedAt: typeof review?.reviewedAt === "string" ? review.reviewedAt : null,
      issues: issues.map((issue) => redactClosureText(issue)),
    },
  }
}

async function compatibilityReceipt(
  evidenceRoot: string,
  options: Arguments,
  currentSourceFingerprint: string,
  currentSourceContentAddress: string,
): Promise<{
  readonly value: unknown
  readonly localInputError: boolean
  readonly resolved: boolean
}> {
  const reportPath = resolve(projectRoot, "docs", "compatibility", "s10-report.json")
  const reportMarkdownPath = resolve(projectRoot, "docs", "compatibility", "s10-report.md")
  const copiedJson = resolve(evidenceRoot, "compatibility", "s10-report.json")
  const copiedMarkdown = resolve(evidenceRoot, "compatibility", "s10-report.md")
  const inputIssues: string[] = []
  const reportJsonText = new TextDecoder("utf-8", { fatal: true }).decode(
    await readStableBoundedFile(reportPath, maximumJunitBytes),
  )
  const reportMarkdownText = new TextDecoder("utf-8", { fatal: true }).decode(
    await readStableBoundedFile(reportMarkdownPath, maximumJunitBytes),
  )
  const safeReportJsonText = redactClosureText(reportJsonText)
  const safeReportMarkdownText = redactClosureText(reportMarkdownText)
  if (safeReportJsonText !== reportJsonText || safeReportMarkdownText !== reportMarkdownText) {
    inputIssues.push(
      "S10 report required redaction and cannot be treated as exact archival evidence",
    )
  }
  await writeEvidenceFile(copiedJson, safeReportJsonText)
  await writeEvidenceFile(copiedMarkdown, safeReportMarkdownText)
  const report = JSON.parse(reportJsonText) as {
    readonly schemaVersion?: unknown
    readonly suite?: unknown
    readonly generatedAt?: unknown
    readonly source?: {
      readonly sha256Before?: unknown
      readonly sha256After?: unknown
      readonly immutableDuringHarness?: unknown
    }
    readonly binaries?: {
      readonly legacy?: {
        readonly sha256Before?: unknown
        readonly sha256After?: unknown
        readonly immutable?: unknown
      }
      readonly next?: {
        readonly sha256Before?: unknown
        readonly sha256After?: unknown
        readonly immutable?: unknown
        readonly buildMetadata?: {
          readonly artifactSha256?: unknown
          readonly sourceSha256?: unknown
        }
      }
    }
    readonly summary?: {
      readonly checks?: unknown
      readonly passed?: unknown
      readonly regressions?: unknown
      readonly surfaceRegressions?: unknown
    }
  }
  const reportValid =
    report.schemaVersion === 1 &&
    report.suite === "s10-operational-migration-compatibility" &&
    report.source?.immutableDuringHarness === true &&
    report.source.sha256Before === report.source.sha256After &&
    report.binaries?.legacy?.immutable === true &&
    report.binaries.legacy.sha256Before === report.binaries.legacy.sha256After &&
    report.binaries?.next?.immutable === true &&
    report.binaries.next.sha256Before === report.binaries.next.sha256After &&
    report.summary?.checks === 91 &&
    report.summary.passed === 91 &&
    report.summary.regressions === 0 &&
    report.summary.surfaceRegressions === 0
  const reportSourceFresh =
    reportValid &&
    report.source?.sha256Before === currentSourceFingerprint &&
    report.source.sha256After === currentSourceFingerprint &&
    report.binaries?.next?.buildMetadata?.sourceSha256 === currentSourceFingerprint &&
    report.binaries.next.buildMetadata.artifactSha256 === report.binaries.next.sha256Before

  if (Boolean(options.legacyBinary) !== Boolean(options.nextBinary)) {
    inputIssues.push("--legacy-binary and --next-binary must be supplied together")
  }
  const inputReceipts: { role: "legacy" | "next"; receipt: FileReceipt }[] = []
  if (options.legacyBinary && options.nextBinary) {
    try {
      const legacyPath = resolve(options.legacyBinary)
      const nextPath = resolve(options.nextBinary)
      if (legacyPath === nextPath) {
        inputIssues.push("legacy and next binaries must be distinct files")
      }
      inputReceipts.push({ role: "legacy", receipt: await hashRegularFile(legacyPath) })
      inputReceipts.push({ role: "next", receipt: await hashRegularFile(nextPath) })
    } catch (error) {
      inputIssues.push(error instanceof Error ? error.message : String(error))
    }
  }
  const legacyReceipt = inputReceipts.find((item) => item.role === "legacy")?.receipt
  const nextReceipt = inputReceipts.find((item) => item.role === "next")?.receipt
  const hashesMatch =
    legacyReceipt?.sha256 === report.binaries?.legacy?.sha256Before &&
    nextReceipt?.sha256 === report.binaries?.next?.sha256Before
  const inputsSupplied = Boolean(options.legacyBinary && options.nextBinary)
  const resolved =
    reportValid && reportSourceFresh && inputsSupplied && inputIssues.length === 0 && hashesMatch
  return {
    value: {
      schemaVersion: 1,
      artifactClass: "s10-compatibility-receipt",
      status: resolved
        ? "bound-local-pass"
        : !reportValid
          ? "invalid-report"
          : !reportSourceFresh
            ? "stale-source"
            : inputIssues.length > 0
              ? "invalid-input"
              : inputsSupplied
                ? "binary-hash-mismatch"
                : "historical-local-pass-inputs-absent",
      report: {
        valid: reportValid,
        sourceFresh: reportSourceFresh,
        generatedAt: report.generatedAt ?? null,
        sourceSha256: report.source?.sha256Before ?? null,
        checks: report.summary?.checks ?? null,
        passed: report.summary?.passed ?? null,
        regressions: report.summary?.regressions ?? null,
        surfaceRegressions: report.summary?.surfaceRegressions ?? null,
        archivedFiles: [
          portableEvidencePath(evidenceRoot, copiedJson),
          portableEvidencePath(evidenceRoot, copiedMarkdown),
        ],
      },
      sourceBinding: {
        reportSourceSha256: report.source?.sha256Before ?? null,
        closureSourceFingerprint: currentSourceFingerprint,
        closureSourceContentAddress: currentSourceContentAddress,
        directlyComparable: reportValid,
        matchesCurrentSource: reportSourceFresh,
        freshness: resolved
          ? "current-source-and-explicit-binaries-bound"
          : reportSourceFresh
            ? "current-source-but-binary-inputs-not-bound"
            : "report-source-does-not-match-current-source",
        note:
          "The report and closure use scripts/source-fingerprint.ts. A report for any other " +
          "fingerprint is stale even when its historical binary hashes still match.",
      },
      inputs: inputReceipts,
      issues: inputIssues,
      limitation:
        "The closure runner never downloads or infers Ralph v1 and does not rerun the S10 " +
        "harness, because its linked Bun tests are already discovered by the single global " +
        "test invocation.",
    },
    localInputError: inputIssues.length > 0,
    resolved,
  }
}

async function distReceipt(startedAt: string): Promise<{
  readonly valid: boolean
  readonly value: unknown
}> {
  const distRoot = resolve(projectRoot, "dist")
  if (!(await directoryExists(distRoot))) {
    return {
      valid: false,
      value: {
        schemaVersion: 1,
        artifactClass: "build-output-receipt",
        status: "missing",
        root: "dist",
        files: [],
        issues: ["dist is missing after the required build step"],
      },
    }
  }
  const issues: string[] = []
  let bundle: Awaited<ReturnType<typeof validateBundleArtifact>> | null = null
  let standalone: Awaited<ReturnType<typeof validateStandaloneArtifact>> | null = null
  const target = nativeTarget()
  const extension = target.startsWith("bun-windows-") ? ".exe" : ""
  try {
    bundle = await validateBundleArtifact(resolve(distRoot, "ralph-next.js"), projectRoot)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error))
  }
  try {
    standalone = await validateStandaloneArtifact(
      resolve(distRoot, "standalone", target, `ralph-next${extension}`),
      projectRoot,
      target,
    )
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error))
  }
  for (const metadata of [bundle?.metadata, standalone?.metadata]) {
    if (metadata && Date.parse(metadata.builtAt) < Date.parse(startedAt)) {
      issues.push(`${metadata.artifact} predates this closure run and is stale`)
    }
  }
  let files: readonly FileReceipt[] = []
  try {
    files = await collectInventory(distRoot)
    if (files.length === 0) issues.push("dist is empty after the required build step")
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error))
  }
  return {
    valid: issues.length === 0,
    value: {
      schemaVersion: 1,
      artifactClass: "build-output-receipt",
      status: issues.length === 0 ? "current-native-build-inventoried" : "invalid-or-stale",
      root: "dist",
      target,
      files,
      contentAddress: files.length > 0 ? inventoryAddress(files) : null,
      currentArtifacts: {
        bundle: bundle
          ? {
              path: portableProjectPath(bundle.bundle),
              metadata: portableProjectPath(bundle.metadataPath),
              sha256: bundle.metadata.sha256,
              sourceSha256: bundle.metadata.sourceSha256,
              builtAt: bundle.metadata.builtAt,
            }
          : null,
        standalone: standalone
          ? {
              path: portableProjectPath(standalone.binary),
              metadata: portableProjectPath(standalone.metadataPath),
              sha256: standalone.metadata.sha256,
              sourceSha256: standalone.metadata.sourceSha256,
              builtAt: standalone.metadata.builtAt,
            }
          : null,
      },
      issues: issues.map((issue) => redactClosureText(issue)),
    },
  }
}

async function readStableBoundedFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new Error(`Expected a bounded regular non-symlink file: ${portableProjectPath(path)}`)
  }
  if (!samePath(await realpath(path), path)) {
    throw new Error(
      `Bounded file resolves through a link or junction: ${portableProjectPath(path)}`,
    )
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
    throw new Error(`File changed while it was read: ${portableProjectPath(path)}`)
  }
  return bytes
}

async function readStableJson(path: string, maximumBytes = maximumLogBytes): Promise<unknown> {
  const bytes = await readStableBoundedFile(path, maximumBytes)
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
}

async function sanitizeJunitReport(rawPath: string, outputPath: string): Promise<FileReceipt> {
  try {
    const bytes = await readStableBoundedFile(rawPath, maximumJunitBytes)
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    let sanitized = raw
    for (const secret of environmentSecrets.filter((value) => value.length >= 4)) {
      const variants = xmlSecretVariants(secret).sort((left, right) => right.length - left.length)
      for (const variant of variants) sanitized = sanitized.split(variant).join("[REDACTED]")
    }
    sanitized = redactClosureText(sanitized).replace(/<(REDACTED(?:_[A-Z0-9]+)*)>/gu, "[$1]")
    for (const secret of environmentSecrets) {
      if (secret.length >= 4 && containsLiteralOrXmlEncodedSecret(sanitized, secret)) {
        throw new Error(
          "JUnit sanitization left a literal or XML-encoded environment secret in the archival report",
        )
      }
    }
    await writeEvidenceFile(outputPath, sanitized)
    return { ...(await hashRegularFile(outputPath)), path: "junit/global.xml" }
  } finally {
    await unlink(rawPath).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { readonly code?: unknown }).code === "ENOENT"
      ) {
        return
      }
      throw error
    })
  }
}

function xmlSecretVariants(secret: string): string[] {
  const named = secret.replace(/[&<>"']/gu, (character) => {
    const entities: Readonly<Record<string, string>> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    }
    return entities[character] ?? character
  })
  const encode = (radix: 10 | 16, specialOnly: boolean, uppercase: boolean): string =>
    Array.from(secret)
      .map((character) => {
        if (specialOnly && !/[&<>"']/u.test(character)) return character
        const point = character.codePointAt(0)
        if (point === undefined) return character
        const digits = point.toString(radix)
        const normalized = uppercase ? digits.toUpperCase() : digits
        return radix === 16 ? `&#x${normalized};` : `&#${normalized};`
      })
      .join("")
  return [
    secret,
    named,
    encode(10, true, false),
    encode(16, true, false),
    encode(16, true, true),
    encode(10, false, false),
    encode(16, false, false),
    encode(16, false, true),
  ].filter((value, index, values) => values.indexOf(value) === index)
}

function decodeXmlCharacterReferences(value: string): string {
  let decoded = value
  for (let pass = 0; pass < 8; pass += 1) {
    const next = decoded.replace(
      /&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[\da-f]{1,6});/giu,
      (reference) => {
        const named: Readonly<Record<string, string>> = {
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
        }
        const namedValue = named[reference.toLowerCase()]
        if (namedValue !== undefined) return namedValue
        const hexadecimal = /^&#x([\da-f]+);$/iu.exec(reference)
        const decimal = /^&#(\d+);$/u.exec(reference)
        const point = hexadecimal
          ? Number.parseInt(hexadecimal[1] ?? "", 16)
          : Number.parseInt(decimal?.[1] ?? "", 10)
        if (!Number.isSafeInteger(point) || point < 0 || point > 0x10ffff) return reference
        try {
          return String.fromCodePoint(point)
        } catch {
          return reference
        }
      },
    )
    if (next === decoded) return decoded
    decoded = next
  }
  return decoded
}

function containsLiteralOrXmlEncodedSecret(value: string, secret: string): boolean {
  if (value.includes(secret)) return true
  if (xmlSecretVariants(secret).some((variant) => value.includes(variant))) return true
  return decodeXmlCharacterReferences(value).includes(secret)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

async function validateGlobalTestEvidence(
  classificationPath: string,
  junitPath: string,
): Promise<{ readonly valid: boolean; readonly value: unknown }> {
  const issues: string[] = []
  let classification: Record<string, unknown> | null = null
  let junitReceipt: FileReceipt | null = null
  let junit = ""
  try {
    const value = await readStableJson(classificationPath)
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push("JUnit classification must be a JSON object")
    } else {
      classification = value as Record<string, unknown>
    }
  } catch (error) {
    issues.push(`JUnit classification is unavailable or invalid: ${String(error)}`)
  }
  try {
    const bytes = await readStableBoundedFile(junitPath, maximumJunitBytes)
    junit = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    junitReceipt = {
      path: "junit/global.xml",
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  } catch (error) {
    issues.push(`Sanitized JUnit report is unavailable or invalid: ${String(error)}`)
  }
  const counts = classification?.counts as Record<string, unknown> | undefined
  const reports = Array.isArray(classification?.reports)
    ? (classification.reports as readonly Record<string, unknown>[])
    : []
  if (
    classification?.schemaVersion !== 2 ||
    classification.artifactClass !== "ci-test-classification" ||
    classification.kind !== "s12-closure" ||
    (classification.status !== "pass" && classification.status !== "pass-with-waivers")
  ) {
    issues.push("JUnit classification does not satisfy the S12 schema/status contract")
  }
  if (
    typeof counts?.tests !== "number" ||
    !Number.isSafeInteger(counts.tests) ||
    counts.tests <= 0 ||
    counts.failed !== 0 ||
    counts.errors !== 0 ||
    counts.unwaivedSkips !== 0
  ) {
    issues.push("Global test classification is empty or contains failure/error/unwaived skip")
  }
  if (
    reports.length !== 1 ||
    reports[0]?.name !== "global.xml" ||
    reports[0]?.sha256 !== junitReceipt?.sha256 ||
    (reports[0]?.counts as Record<string, unknown> | undefined)?.tests !== counts?.tests
  ) {
    issues.push("JUnit classification is not hash/count bound to sanitized junit/global.xml")
  }
  const sentinelResults = requiredGlobalSentinels.map((file) => {
    const portableFilePattern = file.split("/").map(escapeRegExp).join("(?:/|\\\\)")
    const fileAttribute = `\\bfile="(?:\\.(?:/|\\\\))?${portableFilePattern}"`
    const selfClosing = new RegExp(`<testcase\\b(?=[^>]*${fileAttribute})[^>]*/>`, "u")
    const paired = new RegExp(
      `<testcase\\b(?=[^>]*${fileAttribute})[^>]*>([\\s\\S]*?)</testcase>`,
      "u",
    )
    const selfClosingMatch = selfClosing.exec(junit)
    const pairedMatch = paired.exec(junit)
    const selfClosingPassed =
      selfClosingMatch !== null && !/\bstatus="(?:skipped|failed|error)"/u.test(selfClosingMatch[0])
    const pairedPassed =
      pairedMatch !== null &&
      !/\bstatus="(?:skipped|failed|error)"/u.test(pairedMatch[0]) &&
      !/<(?:failure|error|skipped)\b/u.test(pairedMatch[1] ?? "")
    return { file, passed: selfClosingPassed || pairedPassed }
  })
  const missingSentinels = sentinelResults.filter((item) => !item.passed).map((item) => item.file)
  if (missingSentinels.length > 0) {
    issues.push(`Global JUnit lacks critical sentinels: ${missingSentinels.join(", ")}`)
  }
  return {
    valid: issues.length === 0,
    value: {
      schemaVersion: 1,
      artifactClass: "s12-global-test-evidence-validation",
      status: issues.length === 0 ? "valid" : "invalid",
      junit: junitReceipt,
      counts: counts ?? null,
      requiredSentinels: requiredGlobalSentinels,
      sentinelResults,
      missingSentinels,
      issues: issues.map((issue) => redactClosureText(issue)),
    },
  }
}

async function validateDependencyAudit(path: string): Promise<FileReceipt> {
  const bytes = await readStableBoundedFile(path, maximumLogBytes)
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 0
  ) {
    throw new Error("Dependency audit JSON must be an empty top-level object")
  }
  return {
    path: "dependency-audit.json",
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

async function main(): Promise<number> {
  const options = parseArguments(process.argv.slice(2))
  const evidenceRoot = resolveEvidenceRoot(options.evidenceRoot)
  await prepareEvidenceRoot(evidenceRoot)
  for (const directory of ["logs", "junit", "compatibility", "receipts"] as const) {
    const path = resolve(evidenceRoot, directory)
    await mkdir(path)
    await assertCanonicalDirectory(path, evidenceRoot)
  }

  const startedAt = new Date().toISOString()
  const steps: (StepResult & { readonly localGate: boolean })[] = []
  const gitBefore = await observeGitSource(evidenceRoot, "before")
  steps.push(...gitBefore.steps)
  const sourceBefore = await collectInventory(
    projectRoot,
    projectRoot,
    excludedSourceDirectories,
    true,
  )
  const sourceAddressBefore = inventoryAddress(sourceBefore)
  const sourceFingerprintBefore = await sourceFingerprint(projectRoot)
  await writeJson(resolve(evidenceRoot, "source-inventory.json"), {
    schemaVersion: 1,
    artifactClass: "source-inventory",
    exclusionScope: "project-root-directories-only",
    exclusions: [...excludedSourceDirectories].sort(compareUtf8Bytes),
    generatedWorkspaceDependencyLinks:
      "only apps/<workspace>/node_modules and packages/<workspace>/node_modules",
    files: sourceBefore,
    contentAddress: sourceAddressBefore,
    sourceFingerprint: sourceFingerprintBefore,
  })

  const docsOutput = resolve(evidenceRoot, "docs-check.json")
  const rawJunitDirectory = await mkdtemp(join(tmpdir(), "ralph-v2-s12-junit-"))
  await assertCanonicalDirectory(rawJunitDirectory)
  const rawJunitOutput = resolve(rawJunitDirectory, "global.raw.xml")
  const junitOutput = resolve(evidenceRoot, "junit", "global.xml")
  const checkPlan: readonly CheckStep[] = [
    {
      id: "frozen-install",
      label: "Frozen lockfile install",
      command: [process.execPath, "install", "--frozen-lockfile"],
    },
    ...createCheckPlan({
      includeDocumentation: true,
      docsOutput,
      junitOutput: rawJunitOutput,
    }),
  ]
  const globalTestSteps = checkPlan.filter(
    (step) => step.command[0] === process.execPath && step.command[1] === "test",
  )
  if (globalTestSteps.length !== 1) {
    const count = globalTestSteps.length
    throw new Error(`Closure plan must contain exactly one global Bun test, found ${count}`)
  }

  const junitSanitizationIssues: string[] = []
  let junitSanitizationReceipt: FileReceipt | null = null
  for (const step of checkPlan) {
    steps.push(await runStep(evidenceRoot, step, true))
    if (step.id !== "tests") continue
    try {
      junitSanitizationReceipt = await sanitizeJunitReport(rawJunitOutput, junitOutput)
    } catch (error) {
      junitSanitizationIssues.push(error instanceof Error ? error.message : String(error))
    }
    try {
      await rmdir(rawJunitDirectory)
    } catch (error) {
      junitSanitizationIssues.push(
        `Raw JUnit staging cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  await writeJson(resolve(evidenceRoot, "junit-sanitization.json"), {
    schemaVersion: 1,
    artifactClass: "sanitized-global-junit-receipt",
    status: junitSanitizationIssues.length === 0 ? "sanitized" : "failed",
    sourceRetained: false,
    output: junitSanitizationReceipt,
    issues: junitSanitizationIssues.map((issue) => redactClosureText(issue)),
  })

  const classificationPath = resolve(evidenceRoot, "test-classification.json")
  const junitClassificationStep = await runStep(
    evidenceRoot,
    {
      id: "junit-classification",
      label: "JUnit failure, error and skip classification",
      command: [
        process.execPath,
        "run",
        "scripts/ci/classify-junit.ts",
        "--kind",
        "s12-closure",
        "--input",
        resolve(evidenceRoot, "junit"),
        "--output",
        classificationPath,
        "--waivers",
        resolve(projectRoot, ".github", "ci", "junit-skip-waivers.json"),
        "--expect",
        "global.xml",
      ],
    },
    true,
  )
  steps.push(junitClassificationStep)
  const globalTests = await validateGlobalTestEvidence(classificationPath, junitOutput)
  await writeJson(resolve(evidenceRoot, "global-test-validation.json"), globalTests.value)

  const securitySteps: (StepResult & { readonly localGate: boolean })[] = []
  const dependencyAuditPath = resolve(evidenceRoot, "dependency-audit.json")
  securitySteps.push(
    await runStep(
      evidenceRoot,
      {
        id: "dependency-audit",
        label: "Structured Bun dependency audit",
        command: [
          process.execPath,
          "run",
          "scripts/ci/dependency-audit.ts",
          "--output",
          dependencyAuditPath,
        ],
      },
      true,
    ),
  )
  const securityIssues: string[] = []
  let dependencyAuditReceipt: FileReceipt | null = null
  try {
    dependencyAuditReceipt = await validateDependencyAudit(dependencyAuditPath)
  } catch (error) {
    securityIssues.push(error instanceof Error ? error.message : String(error))
  }
  let gitleaksBinding: Awaited<ReturnType<typeof resolveGitleaksBinding>> | null = null
  try {
    gitleaksBinding = await resolveGitleaksBinding({
      projectRoot,
      ...(options.gitleaksBinary ? { explicitBinary: options.gitleaksBinary } : {}),
      ...(options.gitleaksSha256 ? { explicitSha256: options.gitleaksSha256 } : {}),
    })
  } catch (error) {
    securityIssues.push(
      `Pinned Gitleaks binding is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const gitleaksReportPath = resolve(evidenceRoot, "gitleaks-report.json")
  let gitleaksVersionStep: (StepResult & { readonly localGate: boolean }) | null = null
  let gitleaksScanStep: (StepResult & { readonly localGate: boolean }) | null = null
  let gitleaksReportReceipt: Awaited<ReturnType<typeof validateEmptyGitleaksReport>> | null = null
  if (gitleaksBinding) {
    gitleaksVersionStep = await runStep(
      evidenceRoot,
      {
        id: "gitleaks-version",
        label: "Pinned Gitleaks version probe",
        command: [gitleaksBinding.binary, "version"],
      },
      true,
      { canonical: gitleaksBinding.binary, sha256: gitleaksBinding.sha256 },
    )
    securitySteps.push(gitleaksVersionStep)
    gitleaksScanStep = await runStep(
      evidenceRoot,
      {
        id: "source-secret-scan",
        label: "Pinned Gitleaks tracked source and history scan",
        command: [
          gitleaksBinding.binary,
          ...gitleaksTrackedSourceScanArguments(gitleaksReportPath),
        ],
      },
      true,
      { canonical: gitleaksBinding.binary, sha256: gitleaksBinding.sha256 },
    )
    securitySteps.push(gitleaksScanStep)
    try {
      const versionOutput = await readFile(
        resolve(evidenceRoot, gitleaksVersionStep.logs.stdout),
        "utf8",
      )
      validateGitleaksVersionOutput(versionOutput)
      if (gitleaksVersionStep.executable.sha256 !== gitleaksBinding.sha256) {
        throw new Error("Executed Gitleaks binary differs from the approved binding")
      }
      if (gitleaksScanStep.executable.sha256 !== gitleaksBinding.sha256) {
        throw new Error("Gitleaks scan executable differs from the approved binding")
      }
      gitleaksReportReceipt = await validateEmptyGitleaksReport(gitleaksReportPath)
    } catch (error) {
      securityIssues.push(error instanceof Error ? error.message : String(error))
    }
  }
  steps.push(...securitySteps)
  for (const securityStep of securitySteps) {
    await writeJson(resolve(evidenceRoot, "receipts", `${securityStep.id}.json`), {
      schemaVersion: 1,
      artifactClass: "security-gate-receipt",
      gate: securityStep.id,
      status: securityStep.status,
      exitCode: securityStep.exitCode,
      timeoutMs: securityStep.timeoutMs,
      timedOut: securityStep.timedOut,
      treeTerminationRequested: securityStep.treeTerminationRequested,
      treeTerminated: securityStep.treeTerminated,
      executable: securityStep.executable,
      logs: securityStep.logs,
      stdout: securityStep.stdout,
      stderr: securityStep.stderr,
    })
  }
  await writeJson(resolve(evidenceRoot, "security-gates.json"), {
    schemaVersion: 1,
    artifactClass: "closure-security-gates",
    status:
      securitySteps.every((step) => step.status === "pass") &&
      securityIssues.length === 0 &&
      globalTests.valid
        ? "pass"
        : "fail",
    gates: securitySteps.map((step) => ({
      id: step.id,
      status: step.status,
      exitCode: step.exitCode,
      timedOut: step.timedOut,
    })),
    dependencyAudit: dependencyAuditReceipt,
    gitleaks: {
      requiredVersion: GITLEAKS_VERSION,
      binding: gitleaksBinding
        ? {
            binary: portableProjectPath(gitleaksBinding.binary),
            sha256: gitleaksBinding.sha256,
            provenance: gitleaksBinding.provenance,
          }
        : null,
      report: gitleaksReportReceipt
        ? {
            ...gitleaksReportReceipt,
            path: portableEvidencePath(evidenceRoot, gitleaksReportReceipt.path),
          }
        : null,
    },
    issues: securityIssues.map((issue) => redactClosureText(issue)),
    licenseAndProvenance: {
      status: globalTests.valid ? "verified-by-global-test-sentinels" : "unverified",
      junit: portableEvidencePath(evidenceRoot, junitOutput),
      classification: portableEvidencePath(evidenceRoot, classificationPath),
      reason:
        "The one global Bun test must be non-empty, hash-bound to its sanitized JUnit report " +
        "and contain the exact provenance/SBOM sentinel test files.",
    },
  })

  const gitDiff = await runStep(
    evidenceRoot,
    {
      id: "git-diff-check",
      label: "Tracked source whitespace/error check",
      command: [process.execPath, "run", "scripts/ci/check-whitespace.ts"],
    },
    true,
  )
  steps.push(gitDiff)

  const candidateIssues: string[] = []
  let candidateReceipt: FileReceipt | null = null
  let candidateInput: ReleaseCandidateInput | null = null
  if (options.candidateArtifact && options.candidateDigest) {
    try {
      const candidatePath = resolve(options.candidateArtifact)
      if (insideDirectory(evidenceRoot, candidatePath) || samePath(evidenceRoot, candidatePath)) {
        throw new Error("Candidate artifact cannot be inside the closure evidence root")
      }
      candidateInput = await readReleaseCandidateInput(candidatePath, closureAbortController.signal)
      if (
        samePath(evidenceRoot, candidateInput.path) ||
        insideDirectory(evidenceRoot, candidateInput.path)
      ) {
        throw new Error("Canonical candidate metadata cannot be inside the closure evidence root")
      }
      candidateReceipt = {
        path: portableProjectPath(candidateInput.path),
        bytes: candidateInput.sizeBytes,
        sha256: candidateInput.sha256,
      }
      if (`sha256:${candidateReceipt.sha256}` !== options.candidateDigest) {
        throw new Error("Candidate metadata hash does not match --candidate-digest")
      }
    } catch (error) {
      candidateIssues.push(error instanceof Error ? error.message : String(error))
      candidateReceipt = null
      candidateInput = null
    }
  }
  let candidateContentVerified =
    candidateReceipt !== null && candidateInput !== null && candidateIssues.length === 0

  const compatibility = await compatibilityReceipt(
    evidenceRoot,
    options,
    sourceFingerprintBefore,
    sourceAddressBefore,
  )
  await writeJson(resolve(evidenceRoot, "compatibility-receipt.json"), compatibility.value)
  const distribution = await distReceipt(startedAt)
  await writeJson(resolve(evidenceRoot, "dist-receipt.json"), distribution.value)

  const ledgerPath = resolve(projectRoot, "docs", "18-matriz-de-rastreabilidade.md")
  const ledgerMarkdown = new TextDecoder("utf-8", { fatal: true }).decode(
    await readStableBoundedFile(ledgerPath, maximumJunitBytes),
  )
  const requirements = parseRequirements(ledgerMarkdown)
  const evidenceCatalogIds = parseEvidenceCatalogIds(ledgerMarkdown)
  const registryPath = resolve(projectRoot, "docs", "s11-s12-closure-blockers.json")
  const registryIssues: string[] = []
  let registry: BlockerRegistry | null = null
  try {
    const registryResult = BlockerRegistrySchema.safeParse(await readStableJson(registryPath))
    if (registryResult.success) {
      registry = registryResult.data
    } else {
      registryIssues.push(
        ...registryResult.error.issues.map(
          (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`,
        ),
      )
    }
  } catch (error) {
    registryIssues.push(
      `registry read/parse failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const syntheticBlockers: readonly RegistryBlocker[] = Object.entries(
    requiredBlockerRequirements,
  ).map<RegistryBlocker>(([id, affectedRequirements]) => ({
    id,
    status: id === "BLK-COMPAT-BINARIES" ? "conditional" : "open",
    owner: "invalid-registry",
    disposition:
      id === "BLK-COMPAT-BINARIES"
        ? "block-release-when-inputs-absent-or-mismatched"
        : "block-release",
    affectedRequirements: [...affectedRequirements],
    requiredEvidence: ["a valid fail-closed blocker registry"],
    waiver: {
      disposition: "not-granted",
      owner: "invalid-registry",
      rationale: "Registry parsing failed; release remains blocked.",
      expiresOn: null,
      candidateDigest: null,
    },
  }))
  const blockersForObservation = registry?.blockers ?? syntheticBlockers
  const requirementIssues = registry
    ? validateRequirements(requirements, registry, evidenceCatalogIds)
    : ["Blocker registry schema is invalid", ...registryIssues]
  const requirementCounts = Object.fromEntries(
    [...new Set(requirements.map((requirement) => requirement.state))]
      .sort(compareUtf8Bytes)
      .map((state) => [
        state,
        requirements.filter((requirement) => requirement.state === state).length,
      ]),
  )
  await writeJson(resolve(evidenceRoot, "requirements.json"), {
    schemaVersion: 1,
    artifactClass: "r001-r079-local-closure",
    source: portableProjectPath(ledgerPath),
    status: requirementIssues.length === 0 ? "structurally-complete" : "invalid",
    counts: { total: requirements.length, byState: requirementCounts },
    requirements,
    validationIssues: requirementIssues,
    policy:
      "validado-localmente is local evidence only; parcial, prova-pendente and " +
      "bloqueado-externamente block release until evidence or an approved candidate-bound " +
      "waiver exists.",
  })

  if (
    candidateContentVerified &&
    options.candidateArtifact &&
    options.candidateDigest &&
    candidateInput
  ) {
    try {
      const recheckedCandidate = await readReleaseCandidateInput(
        resolve(options.candidateArtifact),
        closureAbortController.signal,
      )
      if (
        samePath(evidenceRoot, recheckedCandidate.path) ||
        insideDirectory(evidenceRoot, recheckedCandidate.path)
      ) {
        throw new Error("Canonical candidate metadata cannot be inside the closure evidence root")
      }
      if (!sameCandidateInput(candidateInput, recheckedCandidate)) {
        throw new Error("Candidate metadata or payload inventory changed before final binding")
      }
      candidateInput = recheckedCandidate
      candidateReceipt = {
        path: portableProjectPath(recheckedCandidate.path),
        bytes: recheckedCandidate.sizeBytes,
        sha256: recheckedCandidate.sha256,
      }
    } catch (error) {
      candidateIssues.push(error instanceof Error ? error.message : String(error))
      candidateContentVerified = false
      candidateInput = null
      candidateReceipt = null
    }
  }

  const r015 = await r015ReviewReceipt()
  await writeJson(resolve(evidenceRoot, "r015-review-binding.json"), r015.value)

  const sourceAfter = await collectInventory(
    projectRoot,
    projectRoot,
    excludedSourceDirectories,
    true,
  )
  const sourceAddressAfter = inventoryAddress(sourceAfter)
  const sourceFingerprintAfter = await sourceFingerprint(projectRoot)
  const sourceStable =
    sourceAddressBefore === sourceAddressAfter && sourceFingerprintBefore === sourceFingerprintAfter
  const gitAfter = await observeGitSource(evidenceRoot, "after")
  steps.push(...gitAfter.steps)
  const gitHeadStable =
    gitBefore.head !== null && gitAfter.head !== null && gitBefore.head === gitAfter.head
  const gitRepositoryStable =
    gitBefore.repository !== null &&
    gitAfter.repository !== null &&
    gitBefore.repository === gitAfter.repository
  const gitCleanBeforeAndAfter = gitBefore.clean && gitAfter.clean
  const gitExecutableHashes = [
    ...gitBefore.steps.map((step) => step.executable.sha256),
    ...gitAfter.steps.map((step) => step.executable.sha256),
  ].filter((value): value is string => value !== null)
  const uniqueGitExecutableHashes = [...new Set(gitExecutableHashes)]
  const gitExecutableStable =
    gitExecutableHashes.length === gitBefore.steps.length + gitAfter.steps.length &&
    uniqueGitExecutableHashes.length === 1
  const gitExecutableSha256 = gitExecutableStable ? (uniqueGitExecutableHashes[0] ?? null) : null
  const gitStable =
    gitBefore.valid &&
    gitAfter.valid &&
    gitHeadStable &&
    gitRepositoryStable &&
    gitExecutableStable &&
    gitCleanBeforeAndAfter

  const candidateSourceIssues: string[] = []
  let candidateRepositoryIdentitySha256: string | null = null
  let candidateRepositoryMatches = false
  let candidateCommitMatches = false
  let candidateFingerprintMatches = false
  if (candidateContentVerified && candidateInput) {
    try {
      const canonicalCandidateRepository = canonicalReleaseRepository(
        candidateInput.subject.repository,
      )
      candidateRepositoryIdentitySha256 = createHash("sha256")
        .update(canonicalCandidateRepository)
        .digest("hex")
      candidateRepositoryMatches =
        gitRepositoryStable && canonicalCandidateRepository === gitAfter.repository
      candidateCommitMatches = gitHeadStable && candidateInput.subject.commit === gitAfter.head
      candidateFingerprintMatches =
        sourceStable && candidateInput.subject.sourceFingerprintSha256 === sourceFingerprintAfter
    } catch (error) {
      candidateIssues.push(error instanceof Error ? error.message : String(error))
      candidateContentVerified = false
      candidateInput = null
      candidateReceipt = null
    }
  }
  if (candidateContentVerified) {
    if (gitStable && !candidateRepositoryMatches) {
      candidateSourceIssues.push(
        "Candidate repository identity differs from the observed Git origin",
      )
    }
    if (gitStable && !candidateCommitMatches) {
      candidateSourceIssues.push("Candidate commit differs from the stable observed Git HEAD")
    }
    if (gitStable && sourceStable && !candidateFingerprintMatches) {
      candidateSourceIssues.push("Candidate fingerprint differs from the stable source fingerprint")
    }
  }

  const candidateSourceMatched =
    candidateContentVerified &&
    gitStable &&
    sourceStable &&
    candidateRepositoryMatches &&
    candidateCommitMatches &&
    candidateFingerprintMatches
  const candidateSourceComparable = gitStable && sourceStable
  const effectiveCandidateDigest =
    candidateContentVerified && candidateInput && candidateReceipt
      ? effectiveReleaseCandidateDigest(candidateInput)
      : null
  await writeJson(resolve(evidenceRoot, "candidate-binding.json"), {
    schemaVersion: 1,
    artifactClass: "release-candidate-content-binding",
    status: !options.candidateArtifact
      ? "not-supplied"
      : candidateContentVerified
        ? candidateSourceMatched
          ? "content-verified-source-matched"
          : candidateSourceComparable
            ? "content-verified-source-mismatch"
            : "content-verified-source-unavailable"
        : "invalid",
    terminology:
      "content-verified validates schema, metadata digest and declared payload size/hash receipts; a detached signature payload is only read stably, bounded and content-addressed because its manifest descriptor has no self-hash. No signature authenticity is claimed.",
    suppliedMetadataDigest: options.candidateDigest ?? null,
    effectiveCandidateDigest,
    metadata:
      candidateContentVerified && candidateReceipt
        ? {
            sha256: candidateReceipt.sha256,
            sizeBytes: candidateReceipt.bytes,
            storage: "external-digest-observation",
            selfContained: false,
            retrievalLocatorArchived: false,
            rawMetadataArchived: false,
            reason:
              "Raw candidate metadata can contain repository or payload URLs; the closure stores only its observed exact digest and typed URL-free projection. Independent recomputation requires the separately retained external candidate input.",
          }
        : null,
    kind: candidateInput?.kind ?? null,
    subject: candidateInput
      ? {
          repositoryIdentitySha256: candidateRepositoryIdentitySha256,
          commit: candidateInput.subject.commit,
          sourceFingerprintSha256: candidateInput.subject.sourceFingerprintSha256,
          channel: candidateInput.subject.channel,
        }
      : null,
    payload: candidateInput
      ? {
          contentAddress: `sha256:${candidateInput.payloadContentAddress}`,
          files: candidateInput.payloads,
        }
      : null,
    sourceMatch: {
      repository: candidateRepositoryMatches,
      commit: candidateCommitMatches,
      fingerprint: candidateFingerprintMatches,
      comparable: candidateSourceComparable,
      matched: candidateSourceMatched,
    },
    issues: [...candidateIssues, ...candidateSourceIssues].map((issue) => redactClosureText(issue)),
  })

  const waiverIssues: string[] = []
  let externalWaiverArtifact: ExternalWaiverArtifact | null = null
  let externalWaiverMetadata: { readonly sha256: string; readonly sizeBytes: number } | null = null
  let externalWaiverCanonicalPath: string | null = null
  if (options.waiverArtifact && options.waiverDigest) {
    try {
      const waiverPath = resolve(options.waiverArtifact)
      if (samePath(evidenceRoot, waiverPath) || insideDirectory(evidenceRoot, waiverPath)) {
        throw new Error("External waiver artifact cannot be inside the closure evidence root")
      }
      const input = await readStableJsonInput(
        waiverPath,
        "External candidate waiver artifact",
        8 * 1024 * 1024,
        closureAbortController.signal,
      )
      if (samePath(evidenceRoot, input.path) || insideDirectory(evidenceRoot, input.path)) {
        throw new Error("Canonical external waiver artifact cannot be inside the evidence root")
      }
      if (`sha256:${input.sha256}` !== options.waiverDigest) {
        throw new Error("External waiver artifact hash does not match --waiver-digest")
      }
      const parsed = ExternalWaiverArtifactSchema.parse(input.raw)
      if (
        !effectiveCandidateDigest ||
        parsed.subject.effectiveCandidateDigest !== effectiveCandidateDigest ||
        parsed.subject.candidateMetadataDigest !== options.candidateDigest ||
        parsed.subject.repositoryIdentitySha256 !== candidateRepositoryIdentitySha256 ||
        parsed.subject.commit !== gitAfter.head ||
        parsed.subject.sourceFingerprintSha256 !== sourceFingerprintAfter
      ) {
        throw new Error("External waiver artifact targets a different candidate/source subject")
      }
      for (const approval of parsed.approvals) {
        const blocker = blockersForObservation.find((item) => item.id === approval.blockerId)
        if (!blocker || blocker.owner !== approval.owner) {
          throw new Error(
            `External waiver owner differs from blocker policy: ${approval.blockerId}`,
          )
        }
      }
      externalWaiverArtifact = parsed
      externalWaiverMetadata = { sha256: input.sha256, sizeBytes: input.sizeBytes }
      externalWaiverCanonicalPath = input.path
    } catch (error) {
      waiverIssues.push(error instanceof Error ? error.message : String(error))
      externalWaiverArtifact = null
      externalWaiverMetadata = null
      externalWaiverCanonicalPath = null
    }
  }
  const externalWaiverApprovals = new Map<string, ExternalWaiverApproval>(
    (externalWaiverArtifact?.approvals ?? []).map(
      (approval) => [approval.blockerId, approval] as const,
    ),
  )
  await writeJson(resolve(evidenceRoot, "waiver-binding.json"), {
    schemaVersion: 1,
    artifactClass: "external-candidate-waiver-binding",
    status: !options.waiverArtifact
      ? "not-supplied"
      : externalWaiverArtifact && externalWaiverMetadata
        ? "content-verified-candidate-bound"
        : "invalid",
    sourceRegistryCanApproveWaivers: false,
    authorizationBasis:
      "explicit-operator-supplied-file-and-digest; no cryptographic signer authenticity is claimed",
    nonWaivableBlockers: ["BLK-SOURCE-BINDING"],
    metadata: externalWaiverMetadata
      ? {
          ...externalWaiverMetadata,
          suppliedDigest: options.waiverDigest,
          storage: "external-digest-observation",
          selfContained: false,
          rawArtifactArchived: false,
        }
      : null,
    subject: externalWaiverArtifact?.subject ?? null,
    issuedAt: externalWaiverArtifact?.issuedAt ?? null,
    approvals:
      externalWaiverArtifact?.approvals.map((approval) => ({
        blockerId: approval.blockerId,
        ownerSha256: createHash("sha256").update(approval.owner).digest("hex"),
        rationaleSha256: createHash("sha256").update(approval.rationale).digest("hex"),
        approvalRefSha256: createHash("sha256").update(approval.approvalRef).digest("hex"),
        expiresOn: approval.expiresOn,
      })) ?? [],
    issues: waiverIssues.map((issue) => redactClosureText(issue)),
  })

  const bindingCoreInventory = await collectInventory(evidenceRoot)
  const bindingCoreContentAddress = inventoryAddress(bindingCoreInventory)
  const sourceBindingPrerequisites = {
    gitObservationStable: gitStable,
    gitHeadStable,
    gitRepositoryStable,
    gitExecutableStable,
    gitCleanBeforeAndAfter,
    sourceInventoryStable: sourceStable,
    candidateContentVerified,
    candidateRepositoryMatches,
    candidateCommitMatches,
    candidateFingerprintMatches,
    effectiveCandidateDigestDerived: effectiveCandidateDigest !== null,
    coreEvidenceContentAddressed:
      bindingCoreInventory.length > 0 && sha256Pattern.test(bindingCoreContentAddress),
    finalEnvelopeRequired: true,
  }
  const observedSourceSubject =
    gitAfter.head && gitAfter.repositorySha256
      ? {
          schemaVersion: 1,
          repositoryIdentitySha256: gitAfter.repositorySha256,
          commit: gitAfter.head,
          sourceFingerprintSha256: sourceFingerprintAfter,
          sourceContentAddressSha256: sourceAddressAfter,
        }
      : null
  const observedSourceSubjectSha256 = observedSourceSubject
    ? createHash("sha256").update(JSON.stringify(observedSourceSubject)).digest("hex")
    : null
  const sourceBound =
    sourceBindingPrerequisites.gitObservationStable &&
    sourceBindingPrerequisites.gitHeadStable &&
    sourceBindingPrerequisites.gitRepositoryStable &&
    sourceBindingPrerequisites.gitCleanBeforeAndAfter &&
    sourceBindingPrerequisites.sourceInventoryStable &&
    sourceBindingPrerequisites.candidateContentVerified &&
    sourceBindingPrerequisites.candidateRepositoryMatches &&
    sourceBindingPrerequisites.candidateCommitMatches &&
    sourceBindingPrerequisites.candidateFingerprintMatches &&
    sourceBindingPrerequisites.effectiveCandidateDigestDerived &&
    sourceBindingPrerequisites.coreEvidenceContentAddressed &&
    effectiveCandidateDigest !== null &&
    observedSourceSubjectSha256 !== null

  await writeJson(resolve(evidenceRoot, "source-binding.json"), {
    schemaVersion: 1,
    artifactClass: "source-binding-receipt",
    status: sourceBound ? "subject-bound-pending-envelope" : "unbound",
    effectiveOnlyWithValidEvidenceManifestAndChecksums: true,
    effectiveOnlyWithCompletionReceipt: true,
    reason: sourceBound
      ? "Source, Git identity and candidate content are exactly matched; the binding is effective only inside the finalized evidence envelope."
      : "One or more fail-closed source, Git or candidate prerequisites are not satisfied.",
    boundSourceSubjectSha256: sourceBound ? observedSourceSubjectSha256 : null,
    observedSource: {
      subject: observedSourceSubject,
      before: {
        commit: gitBefore.head,
        clean: gitBefore.clean,
        repositoryIdentitySha256: gitBefore.repositorySha256,
        sourceContentAddressSha256: sourceAddressBefore,
        sourceFingerprintSha256: sourceFingerprintBefore,
      },
      after: {
        commit: gitAfter.head,
        clean: gitAfter.clean,
        repositoryIdentitySha256: gitAfter.repositorySha256,
        sourceContentAddressSha256: sourceAddressAfter,
        sourceFingerprintSha256: sourceFingerprintAfter,
      },
    },
    candidate: {
      binding: "candidate-binding.json",
      suppliedMetadataDigest: candidateContentVerified ? options.candidateDigest : null,
      effectiveDigest: effectiveCandidateDigest,
      payloadContentAddress:
        candidateContentVerified && candidateInput
          ? `sha256:${candidateInput.payloadContentAddress}`
          : null,
    },
    coreEvidence: {
      contentAddress: `sha256:${bindingCoreContentAddress}`,
      files: bindingCoreInventory,
    },
    prerequisites: sourceBindingPrerequisites,
    probes: {
      before: gitBefore.probes,
      after: gitAfter.probes,
    },
    finalEnvelope: {
      manifest: "evidence-manifest.json",
      checksums: "SHA256SUMS",
      completionReceipt: "closure-complete.json",
      policy:
        "The manifest and checksums must validate and closure-complete.json must commit their exact hashes before this binding is effective.",
    },
  })

  const dynamicResolution = new Map<string, boolean>([
    ["BLK-SOURCE-BINDING", sourceBound],
    ["BLK-COMPAT-BINARIES", compatibility.resolved],
    ["BLK-R015-REVIEW", r015.resolved],
  ])
  const waiverEvaluatedAt = new Date()
  const observedBlockers = blockersForObservation.map((blocker) => {
    const dynamicResolved = dynamicResolution.get(blocker.id) ?? false
    const externalApproval = externalWaiverApprovals.get(blocker.id)
    const waiver =
      blocker.id === "BLK-SOURCE-BINDING"
        ? { approvedForRun: false, reason: "source-binding-is-non-waivable" }
        : dynamicResolved
          ? { approvedForRun: false, reason: "waiver-not-needed-dynamic-evidence" }
          : waiverObservation(
              blocker.waiver,
              externalApproval,
              externalWaiverArtifact?.subject.effectiveCandidateDigest,
              sourceBound ? (effectiveCandidateDigest ?? undefined) : undefined,
              waiverEvaluatedAt,
            )
    const resolvedForRun = dynamicResolved || waiver.approvedForRun
    return {
      ...blocker,
      observedDisposition: resolvedForRun ? "resolved-for-this-run" : "blocking-this-run",
      resolutionBasis: dynamicResolved
        ? "exact-dynamic-evidence"
        : waiver.approvedForRun
          ? "approved-candidate-bound-unexpired-waiver"
          : "none",
      waiverObservation: waiver,
      externalWaiverBinding: externalApproval
        ? { artifact: "waiver-binding.json", blockerId: externalApproval.blockerId }
        : null,
      observedEvidence:
        blocker.id === "BLK-SOURCE-BINDING"
          ? {
              boundSourceSubjectSha256: sourceBound ? observedSourceSubjectSha256 : null,
              head: gitAfter.head,
              cleanBeforeAndAfter: gitCleanBeforeAndAfter,
              repositoryIdentitySha256: gitAfter.repositorySha256,
              sourceContentAddress: sourceAddressAfter,
              sourceFingerprint: sourceFingerprintAfter,
              candidateMetadataDigest: candidateContentVerified ? options.candidateDigest : null,
              effectiveCandidateDigest,
              prerequisites: sourceBindingPrerequisites,
            }
          : blocker.id === "BLK-COMPAT-BINARIES"
            ? { compatibilityReceipt: "compatibility-receipt.json" }
            : blocker.id === "BLK-R015-REVIEW"
              ? { reviewBinding: "r015-review-binding.json" }
              : null,
    }
  })
  const approvedWaiverBlockerIds = observedBlockers
    .filter((blocker) => blocker.waiverObservation.approvedForRun)
    .map((blocker) => blocker.id)
    .sort(compareUtf8Bytes)
  const approvedWaiverExpirations = approvedWaiverBlockerIds
    .map((id) => externalWaiverApprovals.get(id)?.expiresOn)
    .filter((value): value is string => value !== undefined)
    .sort(compareUtf8Bytes)
  const earliestApprovedWaiverExpiry = approvedWaiverExpirations[0] ?? null
  await writeJson(resolve(evidenceRoot, "blockers.json"), {
    schemaVersion: 1,
    artifactClass: "observed-s11-s12-release-blockers",
    provisionalUntil: "closure-complete.json",
    finalStatusAuthority: "closure-complete.json",
    registry: portableProjectPath(registryPath),
    registryValid: registry !== null,
    registryIssues,
    releaseBlocked: observedBlockers.some(
      (blocker) => blocker.observedDisposition === "blocking-this-run",
    ),
    blockers: observedBlockers,
  })
  const localFailures = [
    ...new Set([
      ...steps.filter((step) => step.localGate && step.status === "fail").map((step) => step.id),
      ...(junitSanitizationIssues.length > 0 ? ["junit-sanitization"] : []),
      ...(!globalTests.valid ? ["global-test-evidence"] : []),
      ...(securityIssues.length > 0 ? ["security-evidence"] : []),
      ...(!distribution.valid ? ["distribution-evidence"] : []),
      ...(candidateIssues.length > 0 ? ["candidate-binding-input"] : []),
      ...(candidateSourceIssues.length > 0 ? ["candidate-source-mismatch"] : []),
      ...(waiverIssues.length > 0 ? ["waiver-binding-input"] : []),
      ...(compatibility.localInputError ? ["compatibility-input"] : []),
      ...(requirementIssues.length > 0 ? ["requirements-ledger"] : []),
      ...(!sourceStable ? ["source-changed-during-closure"] : []),
    ]),
  ].sort(compareUtf8Bytes)
  const localStatus = localFailures.length === 0 ? "pass" : "fail"
  const releaseBlocked = observedBlockers.some(
    (blocker) => blocker.observedDisposition === "blocking-this-run",
  )
  const status =
    localStatus === "fail"
      ? "local-fail/release-blocked"
      : releaseBlocked
        ? "local-pass/release-blocked"
        : "local-pass/release-ready"

  const runManifestPath = resolve(evidenceRoot, "run-manifest.json")
  await writeJson(runManifestPath, {
    schemaVersion: 1,
    artifactClass: "s11-s12-local-closure-run",
    status: "pending-envelope",
    proposedOutcome: status,
    localStatus,
    releaseStatus: "pending-envelope",
    proposedReleaseStatus: localStatus === "pass" && !releaseBlocked ? "ready" : "blocked",
    releaseEligible: false,
    proposedReleaseEligible: localStatus === "pass" && !releaseBlocked,
    startedAt,
    finishedAt: new Date().toISOString(),
    runner: {
      os: platform(),
      architecture: arch(),
      hostname: hostname(),
      osRelease: osRelease(),
      bunVersion: Bun.version,
      executable: basename(process.execPath),
    },
    source: {
      before: sourceAddressBefore,
      after: sourceAddressAfter,
      fingerprintBefore: sourceFingerprintBefore,
      fingerprintAfter: sourceFingerprintAfter,
      stable: sourceStable,
      gitHeadBefore: gitBefore.head,
      gitHeadAfter: gitAfter.head,
      gitHeadStable,
      gitCleanBeforeAndAfter,
      repositoryIdentitySha256: gitAfter.repositorySha256,
      boundSourceSubjectSha256: sourceBound ? observedSourceSubjectSha256 : null,
    },
    testPolicy: {
      globalBunTestInvocations: 1,
      distributionAndSample: "discovered-by-global-test-not-repeated",
      licenseAndProvenance: "discovered-by-global-test-not-repeated",
      s10Compatibility: "archived-report-and-explicit-binary-receipts-not-rerun",
    },
    steps,
    localFailures,
    outputs: {
      docs: "docs-check.json",
      junit: "junit/global.xml",
      classification: "test-classification.json",
      requirements: "requirements.json",
      blockers: "blockers.json",
      compatibility: "compatibility-receipt.json",
      distribution: "dist-receipt.json",
      security: "security-gates.json",
      source: "source-inventory.json",
      sourceBinding: "source-binding.json",
      r015ReviewBinding: "r015-review-binding.json",
      globalTestValidation: "global-test-validation.json",
      junitSanitization: "junit-sanitization.json",
      candidateBinding: "candidate-binding.json",
      waiverBinding: "waiver-binding.json",
      completionReceipt: "closure-complete.json",
    },
  })

  await assertCanonicalDirectory(evidenceRoot, closureBase)
  const payloadInventory = await collectInventory(evidenceRoot)
  const contentAddress = inventoryAddress(payloadInventory)
  const evidenceManifestPath = resolve(evidenceRoot, "evidence-manifest.json")
  await writeJson(evidenceManifestPath, {
    schemaVersion: 1,
    artifactClass: "content-addressed-s11-s12-closure-evidence",
    status: "pending-completion-receipt",
    proposedOutcome: status,
    payload: {
      contentAddress: `sha256:${contentAddress}`,
      files: payloadInventory,
    },
    inventoryPolicy: {
      payloadIncludes: "all evidence files finalized before evidence-manifest.json",
      envelopeIncludes: ["evidence-manifest.json", "SHA256SUMS"],
      completionReceipt:
        "closure-complete.json is the post-envelope commit marker and binds the finalized manifest/checksum hashes without entering their self-referential inventory",
      canonicalAddress:
        "UTF-8 JSON {schemaVersion:1,files:[[portablePath,bytes,sha256],...]} sorted by UTF-8 bytes",
      checksumRecord: "<sha256><two spaces><portable-path><LF>",
    },
  })
  const inventoryWithManifest = await collectInventory(evidenceRoot)
  const checksumLines = inventoryWithManifest
    .map((file) => `${file.sha256}  ${file.path}`)
    .join("\n")
  const checksumPath = resolve(evidenceRoot, "SHA256SUMS")
  const checksumText = `${checksumLines}\n`
  await writeEvidenceFile(checksumPath, checksumText)
  const settledInventory = await collectInventory(evidenceRoot)
  const settledWithoutChecksum = settledInventory.filter((file) => file.path !== "SHA256SUMS")
  if (JSON.stringify(settledWithoutChecksum) !== JSON.stringify(inventoryWithManifest)) {
    throw new Error("Closure evidence changed while its manifest/checksums were finalized")
  }
  const checksumReceipt = settledInventory.find((file) => file.path === "SHA256SUMS")
  if (
    settledInventory.length !== inventoryWithManifest.length + 1 ||
    !checksumReceipt ||
    checksumReceipt.bytes !== Buffer.byteLength(checksumText) ||
    checksumReceipt.sha256 !== createHash("sha256").update(checksumText).digest("hex")
  ) {
    throw new Error("Closure checksum envelope is incomplete or changed after write")
  }
  const settledRecheck = await collectInventory(evidenceRoot)
  if (JSON.stringify(settledRecheck) !== JSON.stringify(settledInventory)) {
    throw new Error("Closure evidence drifted during the final inventory recheck")
  }

  let finalCandidateObservation:
    | {
        readonly status: "matched"
        readonly metadataSha256: string
        readonly metadataSizeBytes: number
        readonly effectiveCandidateDigest: string
        readonly payloadContentAddress: string
      }
    | { readonly status: "not-verified" } = { status: "not-verified" }
  if (candidateContentVerified && candidateInput && options.candidateArtifact) {
    const recheckedCandidate = await readReleaseCandidateInput(
      resolve(options.candidateArtifact),
      closureAbortController.signal,
    )
    const recheckedEffectiveDigest = effectiveReleaseCandidateDigest(recheckedCandidate)
    if (
      !sameCandidateInput(candidateInput, recheckedCandidate) ||
      recheckedEffectiveDigest !== effectiveCandidateDigest
    ) {
      throw new Error("Release candidate metadata or payloads changed before closure completion")
    }
    finalCandidateObservation = {
      status: "matched",
      metadataSha256: recheckedCandidate.sha256,
      metadataSizeBytes: recheckedCandidate.sizeBytes,
      effectiveCandidateDigest: recheckedEffectiveDigest,
      payloadContentAddress: `sha256:${recheckedCandidate.payloadContentAddress}`,
    }
  }

  const finalSourceInventory = await collectInventory(
    projectRoot,
    projectRoot,
    excludedSourceDirectories,
    true,
  )
  const finalSourceContentAddress = inventoryAddress(finalSourceInventory)
  const finalSourceFingerprint = await sourceFingerprint(projectRoot)
  if (
    finalSourceContentAddress !== sourceAddressAfter ||
    finalSourceFingerprint !== sourceFingerprintAfter
  ) {
    throw new Error("Source changed after its binding and before closure completion")
  }
  const finalGit = await finalGitObservation({
    required: sourceBound,
    expectedHead: gitAfter.head,
    expectedRepository: gitAfter.repository,
    expectedExecutableSha256: gitExecutableSha256,
  })

  if (externalWaiverArtifact && externalWaiverMetadata && externalWaiverCanonicalPath) {
    const recheckedWaiverInput = await readStableJsonInput(
      externalWaiverCanonicalPath,
      "External candidate waiver artifact final recheck",
      8 * 1024 * 1024,
      closureAbortController.signal,
    )
    const recheckedWaiverArtifact = ExternalWaiverArtifactSchema.parse(recheckedWaiverInput.raw)
    if (
      !samePath(recheckedWaiverInput.path, externalWaiverCanonicalPath) ||
      recheckedWaiverInput.sha256 !== externalWaiverMetadata.sha256 ||
      recheckedWaiverInput.sizeBytes !== externalWaiverMetadata.sizeBytes ||
      JSON.stringify(recheckedWaiverArtifact) !== JSON.stringify(externalWaiverArtifact)
    ) {
      throw new Error("External candidate waiver artifact changed before closure completion")
    }
  }
  const finalWaiverEvaluatedAt = new Date()
  for (const blockerId of approvedWaiverBlockerIds) {
    const blocker = blockersForObservation.find((item) => item.id === blockerId)
    const approval = externalWaiverApprovals.get(blockerId)
    if (
      !blocker ||
      !waiverObservation(
        blocker.waiver,
        approval,
        externalWaiverArtifact?.subject.effectiveCandidateDigest,
        sourceBound ? (effectiveCandidateDigest ?? undefined) : undefined,
        finalWaiverEvaluatedAt,
      ).approvedForRun
    ) {
      throw new Error(`Approved external waiver is no longer valid: ${blockerId}`)
    }
  }

  const evidenceManifestReceipt = settledInventory.find(
    (file) => file.path === "evidence-manifest.json",
  )
  const sourceBindingReceipt = settledInventory.find((file) => file.path === "source-binding.json")
  const candidateBindingReceipt = settledInventory.find(
    (file) => file.path === "candidate-binding.json",
  )
  const waiverBindingReceipt = settledInventory.find((file) => file.path === "waiver-binding.json")
  if (
    !evidenceManifestReceipt ||
    !sourceBindingReceipt ||
    !candidateBindingReceipt ||
    !waiverBindingReceipt
  ) {
    throw new Error("Final closure envelope lacks a required manifest or binding receipt")
  }
  const completionPath = resolve(evidenceRoot, "closure-complete.json")
  const completionValue = ClosureCompletionReceiptSchema.parse({
    schemaVersion: 1,
    artifactClass: "s11-s12-closure-completion",
    status,
    localStatus,
    releaseStatus: localStatus === "pass" && !releaseBlocked ? "ready" : "blocked",
    releaseEligible: localStatus === "pass" && !releaseBlocked,
    finishedAt: finalWaiverEvaluatedAt.toISOString(),
    openBlockers: observedBlockers
      .filter((blocker) => blocker.observedDisposition === "blocking-this-run")
      .map((blocker) => blocker.id)
      .sort(compareUtf8Bytes),
    payloadContentAddress: `sha256:${contentAddress}`,
    envelope: {
      manifest: evidenceManifestReceipt,
      checksums: checksumReceipt,
      sourceBinding: sourceBindingReceipt,
      candidateBinding: candidateBindingReceipt,
      waiverBinding: waiverBindingReceipt,
    },
    sourceBinding: {
      resolved: sourceBound,
      boundSourceSubjectSha256: sourceBound ? observedSourceSubjectSha256 : null,
      finalSourceContentAddressSha256: finalSourceContentAddress,
      finalSourceFingerprintSha256: finalSourceFingerprint,
      finalGit,
    },
    candidate: {
      effectiveCandidateDigest,
      finalObservation: finalCandidateObservation,
      waiverBinding: "waiver-binding.json",
    },
    waivers: {
      evaluatedAt: finalWaiverEvaluatedAt.toISOString(),
      approvedBlockerIds: approvedWaiverBlockerIds,
      earliestExpiry: earliestApprovedWaiverExpiry,
    },
    authority: completionAuthority,
  })
  const intendedCompletionText = `${JSON.stringify(completionValue, null, 2)}\n`
  await writeJson(completionPath, completionValue)
  const recheckedCompletionInput = await readStableJsonInput(
    completionPath,
    "Closure completion receipt",
    8 * 1024 * 1024,
    closureAbortController.signal,
  )
  const recheckedCompletion = ClosureCompletionReceiptSchema.parse(recheckedCompletionInput.raw)
  if (
    !samePath(recheckedCompletionInput.path, completionPath) ||
    recheckedCompletionInput.sizeBytes !== Buffer.byteLength(intendedCompletionText) ||
    recheckedCompletionInput.sha256 !==
      createHash("sha256").update(intendedCompletionText).digest("hex") ||
    JSON.stringify(recheckedCompletion) !== JSON.stringify(completionValue)
  ) {
    throw new Error("Closure completion receipt changed before its final inventory")
  }
  const completedInventory = await collectInventory(evidenceRoot)
  const completionReceipt = completedInventory.find((file) => file.path === "closure-complete.json")
  const completedWithoutReceipt = completedInventory.filter(
    (file) => file.path !== "closure-complete.json",
  )
  if (
    !completionReceipt ||
    completedInventory.length !== settledInventory.length + 1 ||
    JSON.stringify(completedWithoutReceipt) !== JSON.stringify(settledInventory)
  ) {
    throw new Error("Closure completion receipt did not atomically commit the settled envelope")
  }
  assertIntendedEvidenceFiles(evidenceRoot, completedInventory)
  const finalInventory = await collectInventory(evidenceRoot)
  if (JSON.stringify(finalInventory) !== JSON.stringify(completedInventory)) {
    throw new Error("Closure evidence drifted after its completion receipt was committed")
  }
  assertIntendedEvidenceFiles(evidenceRoot, finalInventory)

  process.stdout.write(
    `${JSON.stringify({
      status,
      contentAddress: `sha256:${contentAddress}`,
      evidenceRoot: portableProjectPath(evidenceRoot),
      completionReceipt,
      localFailures,
      openBlockers: observedBlockers
        .filter((blocker) => blocker.observedDisposition === "blocking-this-run")
        .map((blocker) => blocker.id)
        .sort(compareUtf8Bytes),
    })}\n`,
  )
  if (localStatus === "fail") return 1
  return releaseBlocked ? 2 : 0
}

if (import.meta.main) {
  const shutdown = new TwoPhaseShutdownController({ abortController: closureAbortController })
  const onSigint = () => shutdown.handleSignal("SIGINT")
  const onSigterm = () => shutdown.handleSignal("SIGTERM")
  process.on("SIGINT", onSigint)
  process.on("SIGTERM", onSigterm)
  try {
    process.exitCode = await main()
  } finally {
    await shutdown.close()
    process.off("SIGINT", onSigint)
    process.off("SIGTERM", onSigterm)
  }
}
