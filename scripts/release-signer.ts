import { createHash, randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { chmod, lstat, mkdtemp, open, realpath, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import {
  canonicalReleaseManifestSigningBytes,
  type ReleaseManifest,
  ReleaseManifestSchema,
  releaseManifestSigningSha256,
} from "@ralph/distribution"
import { BunProcessSupervisor } from "@ralph/supervisor"
import { sha256File } from "./build-artifact"
import { copyRegularVerified } from "./release-files"

const SIGNER_PROTOCOL = "ralph-release-signature-signer-v1"
const CONFIGURATION_LIMIT_BYTES = 1024 * 1024
const RESULT_LIMIT_BYTES = 64 * 1024
const MAXIMUM_SIGNATURE_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MILLISECONDS = 60_000
const MINIMUM_TIMEOUT_MILLISECONDS = 1_000
const MAXIMUM_TIMEOUT_MILLISECONDS = 300_000

const BASE_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const

const RESERVED_ENVIRONMENT_KEYS = new Set(
  ["RALPH_RELEASE_SIGNER_PROTOCOL", "TEMP", "TMP", "TMPDIR"].map((value) =>
    value.toLocaleLowerCase("und"),
  ),
)

type SignatureKind = "cosign" | "minisign" | "gpg" | "sigstore-bundle"

type FileIdentity = {
  readonly path: string
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

type StableFile = FileIdentity & {
  readonly bytes: Uint8Array
}

export type ReleaseSignerConfiguration = {
  readonly executable: string
  readonly executableIdentity: FileIdentity
  readonly arguments: readonly string[]
  readonly timeoutMilliseconds: number
  readonly forwardEnvironment: readonly string[]
  readonly signature: {
    readonly kind: SignatureKind
    readonly identity: string
    readonly mediaType: string
    readonly maximumSizeBytes: number
  }
}

export type ReleaseSignatureReceipt = FileIdentity & {
  readonly sha256: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const permitted = new Set(allowed)
  const unexpected = Object.keys(value).filter((key) => !permitted.has(key))
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`)
  }
}

function safeArgument(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !containsAsciiControlCharacter(value)
  )
}

function containsAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function identityFrom(path: string, information: Stats): FileIdentity {
  return {
    path,
    dev: information.dev,
    ino: information.ino,
    size: information.size,
    mtimeMs: information.mtimeMs,
    ctimeMs: information.ctimeMs,
  }
}

function sameIdentity(
  left: Pick<FileIdentity, "dev" | "ino">,
  right: Pick<FileIdentity, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function readStableRegularFile(
  requestedPath: string,
  maximumBytes: number,
  label: string,
  options: {
    readonly requireNonEmpty?: boolean
    readonly expectedIdentity?: Pick<FileIdentity, "dev" | "ino">
  } = {},
): Promise<StableFile> {
  const path = resolve(requestedPath)
  const before = await lstat(path).catch((error: unknown) => {
    throw new Error(`${label} is unavailable: ${path}`, { cause: error })
  })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maximumBytes ||
    (options.requireNonEmpty === true && before.size === 0) ||
    (options.expectedIdentity !== undefined && !sameIdentity(before, options.expectedIdentity))
  ) {
    throw new Error(`${label} must be a bounded regular non-linked file: ${path}`)
  }
  const canonicalPath = await realpath(path)
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      !sameIdentity(opened, before) ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`${label} changed while it was opened: ${path}`)
    }
    const buffer = Buffer.allocUnsafe(maximumBytes + 1)
    let size = 0
    while (size < buffer.byteLength) {
      const result = await handle.read(buffer, size, buffer.byteLength - size, size)
      if (result.bytesRead === 0) break
      size += result.bytesRead
    }
    const afterHandle = await handle.stat()
    const afterPath = await lstat(path)
    if (
      size > maximumBytes ||
      (options.requireNonEmpty === true && size === 0) ||
      !afterHandle.isFile() ||
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      !sameIdentity(afterHandle, opened) ||
      !sameIdentity(afterPath, opened) ||
      afterHandle.size !== size ||
      afterPath.size !== size ||
      afterHandle.mtimeMs !== opened.mtimeMs ||
      afterHandle.ctimeMs !== opened.ctimeMs ||
      afterPath.mtimeMs !== opened.mtimeMs ||
      afterPath.ctimeMs !== opened.ctimeMs ||
      (await realpath(path)) !== canonicalPath
    ) {
      throw new Error(`${label} changed while it was read: ${path}`)
    }
    return {
      ...identityFrom(path, afterPath),
      bytes: buffer.subarray(0, size),
    }
  } finally {
    await handle.close()
  }
}

function parseUtf8Json(file: StableFile, label: string): unknown {
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
  } catch (error) {
    throw new Error(`${label} must use valid UTF-8: ${file.path}`, { cause: error })
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${file.path}`, { cause: error })
  }
}

async function resolveSignerExecutable(configured: string): Promise<FileIdentity> {
  const selected = isAbsolute(configured) ? configured : Bun.which(configured)
  if (!selected) throw new Error(`Configured release signer was not found: ${configured}`)
  const executable = await realpath(resolve(selected))
  const information = await lstat(executable)
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error(`Release signer must resolve to a regular executable file: ${executable}`)
  }
  return identityFrom(executable, information)
}

function environmentName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)
}

function validateForwardEnvironment(raw: unknown): readonly string[] {
  const values = raw ?? []
  if (
    !Array.isArray(values) ||
    values.length > 64 ||
    values.some((value) => !environmentName(value))
  ) {
    throw new Error(
      "Release signer forwardEnvironment must be a bounded array of environment names",
    )
  }
  const output = values as string[]
  const folded = output.map((value) => value.toLocaleLowerCase("und"))
  if (new Set(folded).size !== folded.length) {
    throw new Error("Release signer forwardEnvironment contains duplicate names")
  }
  const reserved = output.find((value) =>
    RESERVED_ENVIRONMENT_KEYS.has(value.toLocaleLowerCase("und")),
  )
  if (reserved) {
    throw new Error(
      `Release signer forwardEnvironment cannot replace app-owned variable ${reserved}`,
    )
  }
  return output
}

export async function loadReleaseSignerConfiguration(
  requestedPath: string,
): Promise<ReleaseSignerConfiguration> {
  const file = await readStableRegularFile(
    requestedPath,
    CONFIGURATION_LIMIT_BYTES,
    "Release signer configuration",
    { requireNonEmpty: true },
  )
  const raw = parseUtf8Json(file, "Release signer configuration")
  if (!isRecord(raw)) throw new Error("Release signer configuration must be a JSON object")
  assertExactKeys(
    raw,
    [
      "schemaVersion",
      "protocol",
      "executable",
      "arguments",
      "timeoutMilliseconds",
      "forwardEnvironment",
      "signature",
    ],
    "Release signer configuration",
  )
  if (raw.schemaVersion !== 1 || raw.protocol !== SIGNER_PROTOCOL) {
    throw new Error(`Release signer configuration must select ${SIGNER_PROTOCOL}`)
  }
  if (!safeArgument(raw.executable) || raw.executable.trim().length === 0) {
    throw new Error("Release signer configuration requires one executable without shell syntax")
  }
  const argumentsValue = raw.arguments ?? []
  if (
    !Array.isArray(argumentsValue) ||
    argumentsValue.length > 64 ||
    argumentsValue.some((argument) => !safeArgument(argument)) ||
    argumentsValue.some(
      (argument) =>
        argument === "--" ||
        argument === "--request" ||
        argument.startsWith("--request=") ||
        argument === "--result" ||
        argument.startsWith("--result="),
    )
  ) {
    throw new Error(
      "Release signer arguments must be a bounded JSON argv array without app-owned flags",
    )
  }
  const timeoutMilliseconds = raw.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    (timeoutMilliseconds as number) < MINIMUM_TIMEOUT_MILLISECONDS ||
    (timeoutMilliseconds as number) > MAXIMUM_TIMEOUT_MILLISECONDS
  ) {
    throw new Error(
      `Release signer timeout must be ${MINIMUM_TIMEOUT_MILLISECONDS}-${MAXIMUM_TIMEOUT_MILLISECONDS} ms`,
    )
  }
  if (!isRecord(raw.signature)) {
    throw new Error("Release signer configuration requires a strict signature descriptor")
  }
  assertExactKeys(
    raw.signature,
    ["kind", "identity", "mediaType", "maximumSizeBytes"],
    "Release signer signature descriptor",
  )
  const supportedKinds = new Set<unknown>(["cosign", "minisign", "gpg", "sigstore-bundle"])
  if (!supportedKinds.has(raw.signature.kind)) {
    throw new Error("Release signer signature kind is unsupported by the release manifest schema")
  }
  if (
    typeof raw.signature.identity !== "string" ||
    raw.signature.identity.length < 1 ||
    raw.signature.identity.length > 1_000 ||
    raw.signature.identity.trim() !== raw.signature.identity ||
    containsAsciiControlCharacter(raw.signature.identity)
  ) {
    throw new Error("Release signer identity must be a bounded non-control string")
  }
  if (
    typeof raw.signature.mediaType !== "string" ||
    raw.signature.mediaType.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u.test(
      raw.signature.mediaType,
    )
  ) {
    throw new Error("Release signer mediaType must be a bounded media type without parameters")
  }
  if (
    !Number.isSafeInteger(raw.signature.maximumSizeBytes) ||
    (raw.signature.maximumSizeBytes as number) <= 0 ||
    (raw.signature.maximumSizeBytes as number) > MAXIMUM_SIGNATURE_BYTES
  ) {
    throw new Error(`Release signer maximumSizeBytes must be 1-${MAXIMUM_SIGNATURE_BYTES}`)
  }
  const executableIdentity = await resolveSignerExecutable(raw.executable)
  return {
    executable: executableIdentity.path,
    executableIdentity,
    arguments: argumentsValue as string[],
    timeoutMilliseconds: timeoutMilliseconds as number,
    forwardEnvironment: validateForwardEnvironment(raw.forwardEnvironment),
    signature: {
      kind: raw.signature.kind as SignatureKind,
      identity: raw.signature.identity,
      mediaType: raw.signature.mediaType,
      maximumSizeBytes: raw.signature.maximumSizeBytes as number,
    },
  }
}

function sourceEnvironmentValue(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const direct = source[name]
  if (direct !== undefined || process.platform !== "win32") return direct
  const expected = name.toLocaleLowerCase("und")
  return Object.entries(source).find(
    ([key, value]) => value !== undefined && key.toLocaleLowerCase("und") === expected,
  )?.[1]
}

function signerEnvironment(
  configuration: ReleaseSignerConfiguration,
  source: Readonly<Record<string, string | undefined>>,
  temporaryRoot: string,
): Record<string, string> {
  const output: Record<string, string> = {
    RALPH_RELEASE_SIGNER_PROTOCOL: SIGNER_PROTOCOL,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
  }
  for (const name of BASE_ENVIRONMENT_KEYS) {
    const value = sourceEnvironmentValue(source, name)
    if (value === undefined) continue
    if (value.includes("\0")) throw new Error(`Release signer environment ${name} contains NUL`)
    output[name] = value
  }
  for (const name of configuration.forwardEnvironment) {
    const value = sourceEnvironmentValue(source, name)
    if (value === undefined) {
      throw new Error(`Release signer forwarded environment is unavailable: ${name}`)
    }
    if (value.includes("\0")) throw new Error(`Release signer environment ${name} contains NUL`)
    output[name] = value
  }
  return output
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<FileIdentity> {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  const information = await lstat(path)
  if (!information.isFile() || information.isSymbolicLink()) {
    throw new Error(`Private signer file is not a regular file: ${path}`)
  }
  return identityFrom(path, information)
}

async function removeSignerTemporaryDirectory(
  path: string,
  expectedIdentity: Pick<FileIdentity, "dev" | "ino">,
): Promise<void> {
  const canonicalTemporaryRoot = await realpath(resolve(tmpdir()))
  const parent = await realpath(dirname(path))
  if (parent !== canonicalTemporaryRoot || !basename(path).startsWith("ralph-release-sign-")) {
    throw new Error(`Refusing to clean an unexpected release signer temporary directory: ${path}`)
  }
  const before = await lstat(path)
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !sameIdentity(before, expectedIdentity) ||
    (await realpath(path)) !== path
  ) {
    throw new Error(`Release signer temporary directory changed before cleanup: ${path}`)
  }
  const quarantine = join(canonicalTemporaryRoot, `.cleanup-ralph-release-sign-${randomUUID()}`)
  await rename(path, quarantine)
  const quarantined = await lstat(quarantine)
  if (
    !quarantined.isDirectory() ||
    quarantined.isSymbolicLink() ||
    !sameIdentity(quarantined, expectedIdentity) ||
    (await realpath(quarantine)) !== quarantine
  ) {
    throw new Error(`Release signer cleanup quarantine changed identity: ${quarantine}`)
  }
  await rm(quarantine, { recursive: true, force: false })
}

function parseSignerResult(file: StableFile): {
  readonly kind: SignatureKind
  readonly identity: string
  readonly signedManifestSha256: string
  readonly signatureSha256: string
  readonly signatureSizeBytes: number
} {
  const raw = parseUtf8Json(file, "Release signer result")
  if (!isRecord(raw)) throw new Error("Release signer result must be a JSON object")
  assertExactKeys(
    raw,
    [
      "schemaVersion",
      "protocol",
      "status",
      "kind",
      "identity",
      "signedManifestSha256",
      "signatureSha256",
      "signatureSizeBytes",
    ],
    "Release signer result",
  )
  const supportedKinds = new Set<unknown>(["cosign", "minisign", "gpg", "sigstore-bundle"])
  if (
    raw.schemaVersion !== 1 ||
    raw.protocol !== SIGNER_PROTOCOL ||
    raw.status !== "signed" ||
    !supportedKinds.has(raw.kind) ||
    typeof raw.identity !== "string" ||
    raw.identity.length < 1 ||
    raw.identity.length > 1_000 ||
    typeof raw.signedManifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.signedManifestSha256) ||
    typeof raw.signatureSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.signatureSha256) ||
    !Number.isSafeInteger(raw.signatureSizeBytes) ||
    (raw.signatureSizeBytes as number) <= 0 ||
    (raw.signatureSizeBytes as number) > MAXIMUM_SIGNATURE_BYTES
  ) {
    throw new Error("Release signer did not return a strict signed result")
  }
  return {
    kind: raw.kind as SignatureKind,
    identity: raw.identity,
    signedManifestSha256: raw.signedManifestSha256,
    signatureSha256: raw.signatureSha256,
    signatureSizeBytes: raw.signatureSizeBytes as number,
  }
}

function parseSubjectSignerResult(file: StableFile): {
  readonly kind: SignatureKind
  readonly identity: string
  readonly subjectKind: "npm-release-binding"
  readonly signedSubjectSha256: string
  readonly signatureSha256: string
  readonly signatureSizeBytes: number
} {
  const raw = parseUtf8Json(file, "Release subject signer result")
  if (!isRecord(raw)) throw new Error("Release subject signer result must be a JSON object")
  assertExactKeys(
    raw,
    [
      "schemaVersion",
      "protocol",
      "status",
      "kind",
      "identity",
      "subjectKind",
      "signedSubjectSha256",
      "signatureSha256",
      "signatureSizeBytes",
    ],
    "Release subject signer result",
  )
  const supportedKinds = new Set<unknown>(["cosign", "minisign", "gpg", "sigstore-bundle"])
  if (
    raw.schemaVersion !== 1 ||
    raw.protocol !== SIGNER_PROTOCOL ||
    raw.status !== "signed" ||
    !supportedKinds.has(raw.kind) ||
    typeof raw.identity !== "string" ||
    raw.identity.length < 1 ||
    raw.identity.length > 1_000 ||
    raw.subjectKind !== "npm-release-binding" ||
    typeof raw.signedSubjectSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.signedSubjectSha256) ||
    typeof raw.signatureSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.signatureSha256) ||
    !Number.isSafeInteger(raw.signatureSizeBytes) ||
    (raw.signatureSizeBytes as number) <= 0 ||
    (raw.signatureSizeBytes as number) > MAXIMUM_SIGNATURE_BYTES
  ) {
    throw new Error("Release subject signer did not return a strict signed result")
  }
  return {
    kind: raw.kind as SignatureKind,
    identity: raw.identity,
    subjectKind: raw.subjectKind,
    signedSubjectSha256: raw.signedSubjectSha256,
    signatureSha256: raw.signatureSha256,
    signatureSizeBytes: raw.signatureSizeBytes as number,
  }
}

async function assertExecutableIdentity(configuration: ReleaseSignerConfiguration): Promise<void> {
  const information = await lstat(configuration.executable)
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    !sameIdentity(information, configuration.executableIdentity) ||
    information.size !== configuration.executableIdentity.size ||
    information.mtimeMs !== configuration.executableIdentity.mtimeMs ||
    information.ctimeMs !== configuration.executableIdentity.ctimeMs ||
    (await realpath(configuration.executable)) !== configuration.executable
  ) {
    throw new Error("Configured release signer changed after configuration was loaded")
  }
}

export async function invokeReleaseSigner(input: {
  readonly configuration: ReleaseSignerConfiguration
  readonly manifest: ReleaseManifest
  readonly signatureDestination: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
}): Promise<ReleaseSignatureReceipt> {
  if (input.signal?.aborted) throw new Error("Release signing was cancelled")
  const manifest = ReleaseManifestSchema.parse(input.manifest)
  if (
    manifest.signature.status !== "present" ||
    manifest.signature.kind !== input.configuration.signature.kind ||
    manifest.signature.identity !== input.configuration.signature.identity ||
    manifest.signature.payload.mediaType !== input.configuration.signature.mediaType ||
    manifest.signature.payload.maximumSizeBytes !== input.configuration.signature.maximumSizeBytes
  ) {
    throw new Error("Release manifest signature descriptor does not match signer configuration")
  }
  const canonicalManifestBytes = canonicalReleaseManifestSigningBytes(manifest)
  const signedManifestSha256 = releaseManifestSigningSha256(manifest)
  if (manifest.signature.signedManifestSha256 !== signedManifestSha256) {
    throw new Error("Release manifest signedManifestSha256 does not match its canonical projection")
  }

  await assertExecutableIdentity(input.configuration)
  const canonicalTemporaryRoot = await realpath(resolve(tmpdir()))
  const temporaryRoot = await mkdtemp(join(canonicalTemporaryRoot, "ralph-release-sign-"))
  await chmod(temporaryRoot, 0o700)
  const temporaryInformation = await lstat(temporaryRoot)
  if (!temporaryInformation.isDirectory() || temporaryInformation.isSymbolicLink()) {
    throw new Error("Release signer temporary root is not a regular directory")
  }
  const temporaryIdentity = identityFrom(temporaryRoot, temporaryInformation)
  const canonicalManifestPath = join(temporaryRoot, "canonical-manifest.json")
  const requestPath = join(temporaryRoot, "request.json")
  const resultPath = join(temporaryRoot, "result.json")
  const signatureOutputPath = join(temporaryRoot, "release-signature.bin")
  try {
    const canonicalIdentity = await writePrivateFile(canonicalManifestPath, canonicalManifestBytes)
    const resultIdentity = await writePrivateFile(resultPath, new Uint8Array())
    const signatureIdentity = await writePrivateFile(signatureOutputPath, new Uint8Array())
    const request = {
      schemaVersion: 1,
      protocol: SIGNER_PROTOCOL,
      operation: "sign-release-manifest",
      kind: input.configuration.signature.kind,
      identity: input.configuration.signature.identity,
      signedManifestSha256,
      canonicalManifestPath,
      signatureOutputPath,
      signatureMediaType: input.configuration.signature.mediaType,
      maximumSignatureBytes: input.configuration.signature.maximumSizeBytes,
    }
    await writePrivateFile(requestPath, new TextEncoder().encode(`${JSON.stringify(request)}\n`))

    const environment = signerEnvironment(input.configuration, input.environment, temporaryRoot)
    await assertExecutableIdentity(input.configuration)
    const supervisor = new BunProcessSupervisor()
    const settlement = await supervisor.run({
      executable: input.configuration.executable,
      args: [...input.configuration.arguments, "--request", requestPath, "--result", resultPath],
      cwd: temporaryRoot,
      environment,
      environmentAllowlist: Object.keys(environment),
      shell: false,
      timeoutMs: input.configuration.timeoutMilliseconds,
      gracePeriodMs: 1_000,
      outputLimitBytes: 1,
      rawOutputLimitBytes: 1,
      maxInputBytes: 1,
      secretValues: Object.values(environment),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (settlement.timedOut) {
      throw new Error(`Release signer exceeded ${input.configuration.timeoutMilliseconds} ms`)
    }
    if (settlement.cancelled) throw new Error("Release signer was cancelled")
    if (settlement.error || settlement.exitCode !== 0) {
      throw new Error(
        settlement.exitCode === undefined
          ? "Release signer could not be started"
          : `Release signer failed with exit code ${settlement.exitCode}`,
      )
    }

    await assertExecutableIdentity(input.configuration)
    const result = parseSignerResult(
      await readStableRegularFile(resultPath, RESULT_LIMIT_BYTES, "Release signer result", {
        requireNonEmpty: true,
        expectedIdentity: resultIdentity,
      }),
    )
    if (
      result.kind !== input.configuration.signature.kind ||
      result.identity !== input.configuration.signature.identity ||
      result.signedManifestSha256 !== signedManifestSha256
    ) {
      throw new Error("Release signer result does not bind the configured descriptor and manifest")
    }
    const canonicalAfter = await readStableRegularFile(
      canonicalManifestPath,
      canonicalManifestBytes.byteLength,
      "Canonical release manifest",
      { requireNonEmpty: true, expectedIdentity: canonicalIdentity },
    )
    const canonicalAfterSha256 = createHash("sha256").update(canonicalAfter.bytes).digest("hex")
    if (
      canonicalAfter.bytes.byteLength !== canonicalManifestBytes.byteLength ||
      canonicalAfterSha256 !== signedManifestSha256
    ) {
      throw new Error("Canonical release manifest changed while the signer was running")
    }
    const signature = await readStableRegularFile(
      signatureOutputPath,
      input.configuration.signature.maximumSizeBytes,
      "Detached release signature",
      { requireNonEmpty: true, expectedIdentity: signatureIdentity },
    )
    const signatureSha256 = createHash("sha256").update(signature.bytes).digest("hex")
    if (
      result.signatureSha256 !== signatureSha256 ||
      result.signatureSizeBytes !== signature.size
    ) {
      throw new Error("Release signer result does not bind the generated signature file")
    }
    const signatureBeforeCopy = await lstat(signature.path)
    if (
      !signatureBeforeCopy.isFile() ||
      signatureBeforeCopy.isSymbolicLink() ||
      !sameIdentity(signatureBeforeCopy, signature) ||
      signatureBeforeCopy.size !== signature.size ||
      signatureBeforeCopy.mtimeMs !== signature.mtimeMs ||
      signatureBeforeCopy.ctimeMs !== signature.ctimeMs
    ) {
      throw new Error("Detached release signature changed before verified copy")
    }
    const copied = await copyRegularVerified(signature.path, input.signatureDestination, {
      expectedSha256: signatureSha256,
      expectedSizeBytes: signature.size,
    })
    const signatureAfterCopy = await lstat(signature.path)
    if (
      !signatureAfterCopy.isFile() ||
      signatureAfterCopy.isSymbolicLink() ||
      !sameIdentity(signatureAfterCopy, signature) ||
      signatureAfterCopy.size !== signature.size ||
      signatureAfterCopy.mtimeMs !== signature.mtimeMs ||
      signatureAfterCopy.ctimeMs !== signature.ctimeMs
    ) {
      throw new Error("Detached release signature changed during verified copy")
    }
    const destination = await lstat(copied.destination)
    if (!destination.isFile() || destination.isSymbolicLink()) {
      throw new Error("Copied detached release signature is not a regular file")
    }
    return {
      ...identityFrom(copied.destination, destination),
      sha256: copied.sha256,
    }
  } finally {
    await removeSignerTemporaryDirectory(temporaryRoot, temporaryIdentity)
  }
}

/**
 * Uses the same provider-neutral, shell-free signer configuration for a
 * canonical release subject that is not the standalone release manifest.
 * Adapters opt into the explicit `sign-release-subject` operation; a legacy
 * manifest-only adapter fails closed instead of silently signing other bytes.
 */
export async function invokeReleaseSubjectSigner(input: {
  readonly configuration: ReleaseSignerConfiguration
  readonly subjectKind: "npm-release-binding"
  readonly canonicalSubjectBytes: Uint8Array
  readonly signedSubjectSha256: string
  readonly signatureDestination: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
}): Promise<ReleaseSignatureReceipt> {
  if (input.signal?.aborted) throw new Error("Release subject signing was cancelled")
  if (
    input.canonicalSubjectBytes.byteLength <= 0 ||
    input.canonicalSubjectBytes.byteLength > 4 * 1024 * 1024 ||
    !/^[0-9a-f]{64}$/u.test(input.signedSubjectSha256) ||
    createHash("sha256").update(input.canonicalSubjectBytes).digest("hex") !==
      input.signedSubjectSha256
  ) {
    throw new Error(
      "Release signing subject must be bounded canonical bytes with its exact SHA-256",
    )
  }

  await assertExecutableIdentity(input.configuration)
  const canonicalTemporaryRoot = await realpath(resolve(tmpdir()))
  const temporaryRoot = await mkdtemp(join(canonicalTemporaryRoot, "ralph-release-sign-"))
  await chmod(temporaryRoot, 0o700)
  const temporaryInformation = await lstat(temporaryRoot)
  if (!temporaryInformation.isDirectory() || temporaryInformation.isSymbolicLink()) {
    throw new Error("Release subject signer temporary root is not a regular directory")
  }
  const temporaryIdentity = identityFrom(temporaryRoot, temporaryInformation)
  const canonicalSubjectPath = join(temporaryRoot, "canonical-subject.json")
  const requestPath = join(temporaryRoot, "request.json")
  const resultPath = join(temporaryRoot, "result.json")
  const signatureOutputPath = join(temporaryRoot, "release-signature.bin")
  try {
    const canonicalIdentity = await writePrivateFile(
      canonicalSubjectPath,
      input.canonicalSubjectBytes,
    )
    const resultIdentity = await writePrivateFile(resultPath, new Uint8Array())
    const signatureIdentity = await writePrivateFile(signatureOutputPath, new Uint8Array())
    const request = {
      schemaVersion: 1,
      protocol: SIGNER_PROTOCOL,
      operation: "sign-release-subject",
      subjectKind: input.subjectKind,
      signedSubjectSha256: input.signedSubjectSha256,
      canonicalSubjectPath,
      signatureOutputPath,
      signatureMediaType: input.configuration.signature.mediaType,
      maximumSignatureBytes: input.configuration.signature.maximumSizeBytes,
      kind: input.configuration.signature.kind,
      identity: input.configuration.signature.identity,
    }
    await writePrivateFile(requestPath, new TextEncoder().encode(`${JSON.stringify(request)}\n`))

    const environment = signerEnvironment(input.configuration, input.environment, temporaryRoot)
    await assertExecutableIdentity(input.configuration)
    const supervisor = new BunProcessSupervisor()
    const settlement = await supervisor.run({
      executable: input.configuration.executable,
      args: [...input.configuration.arguments, "--request", requestPath, "--result", resultPath],
      cwd: temporaryRoot,
      environment,
      environmentAllowlist: Object.keys(environment),
      shell: false,
      timeoutMs: input.configuration.timeoutMilliseconds,
      gracePeriodMs: 1_000,
      outputLimitBytes: 1,
      rawOutputLimitBytes: 1,
      maxInputBytes: 1,
      secretValues: Object.values(environment),
      ...(input.signal ? { signal: input.signal } : {}),
    })
    if (settlement.timedOut) {
      throw new Error(
        `Release subject signer exceeded ${input.configuration.timeoutMilliseconds} ms`,
      )
    }
    if (settlement.cancelled) throw new Error("Release subject signer was cancelled")
    if (settlement.error || settlement.exitCode !== 0) {
      throw new Error(
        settlement.exitCode === undefined
          ? "Release subject signer could not be started"
          : `Release subject signer failed with exit code ${settlement.exitCode}`,
      )
    }

    await assertExecutableIdentity(input.configuration)
    const result = parseSubjectSignerResult(
      await readStableRegularFile(resultPath, RESULT_LIMIT_BYTES, "Release subject signer result", {
        requireNonEmpty: true,
        expectedIdentity: resultIdentity,
      }),
    )
    if (
      result.kind !== input.configuration.signature.kind ||
      result.identity !== input.configuration.signature.identity ||
      result.subjectKind !== input.subjectKind ||
      result.signedSubjectSha256 !== input.signedSubjectSha256
    ) {
      throw new Error("Release subject signer result does not bind the configured subject")
    }
    const canonicalAfter = await readStableRegularFile(
      canonicalSubjectPath,
      input.canonicalSubjectBytes.byteLength,
      "Canonical release subject",
      { requireNonEmpty: true, expectedIdentity: canonicalIdentity },
    )
    const canonicalAfterSha256 = createHash("sha256").update(canonicalAfter.bytes).digest("hex")
    if (
      canonicalAfter.bytes.byteLength !== input.canonicalSubjectBytes.byteLength ||
      canonicalAfterSha256 !== input.signedSubjectSha256
    ) {
      throw new Error("Canonical release subject changed while the signer was running")
    }
    const signature = await readStableRegularFile(
      signatureOutputPath,
      input.configuration.signature.maximumSizeBytes,
      "Detached release subject signature",
      { requireNonEmpty: true, expectedIdentity: signatureIdentity },
    )
    const signatureSha256 = createHash("sha256").update(signature.bytes).digest("hex")
    if (
      result.signatureSha256 !== signatureSha256 ||
      result.signatureSizeBytes !== signature.size
    ) {
      throw new Error("Release subject signer result does not bind the generated signature file")
    }
    const signatureBeforeCopy = await lstat(signature.path)
    if (
      !signatureBeforeCopy.isFile() ||
      signatureBeforeCopy.isSymbolicLink() ||
      !sameIdentity(signatureBeforeCopy, signature) ||
      signatureBeforeCopy.size !== signature.size ||
      signatureBeforeCopy.mtimeMs !== signature.mtimeMs ||
      signatureBeforeCopy.ctimeMs !== signature.ctimeMs
    ) {
      throw new Error("Detached release subject signature changed before verified copy")
    }
    const copied = await copyRegularVerified(signature.path, input.signatureDestination, {
      expectedSha256: signatureSha256,
      expectedSizeBytes: signature.size,
    })
    const signatureAfterCopy = await lstat(signature.path)
    if (
      !signatureAfterCopy.isFile() ||
      signatureAfterCopy.isSymbolicLink() ||
      !sameIdentity(signatureAfterCopy, signature) ||
      signatureAfterCopy.size !== signature.size ||
      signatureAfterCopy.mtimeMs !== signature.mtimeMs ||
      signatureAfterCopy.ctimeMs !== signature.ctimeMs
    ) {
      throw new Error("Detached release subject signature changed during verified copy")
    }
    const destination = await lstat(copied.destination)
    if (!destination.isFile() || destination.isSymbolicLink()) {
      throw new Error("Copied detached release subject signature is not a regular file")
    }
    return {
      ...identityFrom(copied.destination, destination),
      sha256: copied.sha256,
    }
  } finally {
    await removeSignerTemporaryDirectory(temporaryRoot, temporaryIdentity)
  }
}

export async function assertReleaseSignatureReceipt(
  receipt: ReleaseSignatureReceipt,
): Promise<void> {
  const before = await lstat(receipt.path)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !sameIdentity(before, receipt) ||
    before.size !== receipt.size ||
    before.mtimeMs !== receipt.mtimeMs ||
    before.ctimeMs !== receipt.ctimeMs
  ) {
    throw new Error("Detached release signature changed before package commit")
  }
  const sha256 = await sha256File(receipt.path)
  const after = await lstat(receipt.path)
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameIdentity(after, receipt) ||
    after.size !== receipt.size ||
    after.mtimeMs !== receipt.mtimeMs ||
    after.ctimeMs !== receipt.ctimeMs ||
    sha256 !== receipt.sha256
  ) {
    throw new Error("Detached release signature changed before package commit")
  }
}
