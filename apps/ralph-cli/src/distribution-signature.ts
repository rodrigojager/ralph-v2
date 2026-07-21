import { createHash } from "node:crypto"
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import {
  ReleaseSignatureKindSchema,
  ReleaseSignatureMediaTypeSchema,
  type ReleaseSignatureTrustPolicy,
  ReleaseSignatureTrustPolicySchema,
  type ReleaseSignatureVerificationResult,
  type ReleaseSignatureVerifier,
} from "@ralph/distribution"
import { EXIT_CODES, RalphError } from "@ralph/domain"
import { BunProcessSupervisor, type ProcessSupervisor } from "@ralph/supervisor"

const CONFIG_LIMIT_BYTES = 1024 * 1024
const RESULT_LIMIT_BYTES = 64 * 1024
const CANONICAL_MANIFEST_LIMIT_BYTES = 4 * 1024 * 1024
const SIGNATURE_LIMIT_BYTES = 64 * 1024 * 1024
const VERIFIER_OUTPUT_LIMIT_BYTES = 4 * 1024
const DEFAULT_TIMEOUT_MILLISECONDS = 60_000
const MINIMUM_TIMEOUT_MILLISECONDS = 1_000
const MAXIMUM_TIMEOUT_MILLISECONDS = 300_000
const ADAPTER_PROTOCOL = "ralph-release-signature-verifier-v1"

const SAFE_ENVIRONMENT_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "SystemDrive",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
] as const

type FileIdentity = {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
}

type VerifierConfiguration = {
  readonly executable: string
  readonly executableIdentity: FileIdentity
  readonly arguments: readonly string[]
  readonly timeoutMilliseconds: number
  readonly trustPolicy: ReleaseSignatureTrustPolicy
}

type StableFile = {
  readonly path: string
  readonly bytes: Uint8Array
  readonly sha256: string
}

function signatureError(
  code: string,
  message: string,
  options: {
    readonly exitCode?: (typeof EXIT_CODES)[keyof typeof EXIT_CODES]
    readonly file?: string
    readonly hint?: string
    readonly cause?: unknown
    readonly details?: Record<string, unknown>
  } = {},
): RalphError {
  return new RalphError(code, message, {
    exitCode: options.exitCode ?? EXIT_CODES.blocked,
    ...(options.file ? { file: options.file } : {}),
    ...(options.hint ? { hint: options.hint } : {}),
    ...(options.cause !== undefined ? { cause: options.cause } : {}),
    ...(options.details ? { details: options.details } : {}),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errorCode = "RALPH_RELEASE_SIGNATURE_CONFIG_INVALID",
  exitCode: (typeof EXIT_CODES)[keyof typeof EXIT_CODES] = EXIT_CODES.invalidUsage,
): void {
  const permitted = new Set(allowed)
  const unexpected = Object.keys(value).filter((key) => !permitted.has(key))
  if (unexpected.length > 0) {
    throw signatureError(
      errorCode,
      `${label} contains unsupported fields: ${unexpected.join(", ")}`,
      { exitCode },
    )
  }
}

function safeArgument(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4_096 &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159)
    })
  )
}

function safeProtocolPrincipal(value: unknown): value is string {
  return (
    safeArgument(value) &&
    value.length >= 1 &&
    value.length <= 1_000 &&
    value === value.trim() &&
    value === value.normalize("NFC")
  )
}

function environmentValue(
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

async function readStableRegularFile(
  requestedPath: string,
  maximumBytes: number,
  label: string,
): Promise<StableFile> {
  const path = resolve(requestedPath)
  const before = await lstat(path).catch((error: unknown) => {
    throw signatureError("RALPH_RELEASE_SIGNATURE_FILE_UNAVAILABLE", `${label} is unavailable`, {
      exitCode: EXIT_CODES.invalidUsage,
      file: path,
      cause: error,
    })
  })
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_FILE_UNSAFE",
      `${label} must be a bounded regular non-linked file`,
      {
        exitCode: EXIT_CODES.policyDenied,
        file: path,
        details: { size: before.size, maximumBytes },
      },
    )
  }
  const handle = await open(path, "r").catch((error: unknown) => {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_FILE_CHANGED",
      `${label} changed before it could be opened`,
      { exitCode: EXIT_CODES.conflict, file: path, cause: error },
    )
  })
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.size !== before.size ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw signatureError(
        "RALPH_RELEASE_SIGNATURE_FILE_CHANGED",
        `${label} changed while it was opened`,
        { exitCode: EXIT_CODES.conflict, file: path },
      )
    }
    const bounded = Buffer.allocUnsafe(maximumBytes + 1)
    let byteLength = 0
    while (byteLength < bounded.byteLength) {
      const { bytesRead } = await handle.read(
        bounded,
        byteLength,
        bounded.byteLength - byteLength,
        null,
      )
      if (bytesRead === 0) break
      byteLength += bytesRead
    }
    if (byteLength > maximumBytes) {
      throw signatureError(
        "RALPH_RELEASE_SIGNATURE_FILE_UNSAFE",
        `${label} exceeded its byte limit while it was read`,
        {
          exitCode: EXIT_CODES.policyDenied,
          file: path,
          details: { maximumBytes, observedBytes: byteLength },
        },
      )
    }
    const bytes = bounded.subarray(0, byteLength)
    const afterHandle = await handle.stat()
    const afterPath = await lstat(path).catch((error: unknown) => {
      throw signatureError(
        "RALPH_RELEASE_SIGNATURE_FILE_CHANGED",
        `${label} changed while it was read`,
        { exitCode: EXIT_CODES.conflict, file: path, cause: error },
      )
    })
    if (
      bytes.byteLength > maximumBytes ||
      afterHandle.size !== bytes.byteLength ||
      afterHandle.dev !== opened.dev ||
      afterHandle.ino !== opened.ino ||
      afterHandle.mtimeMs !== opened.mtimeMs ||
      afterHandle.ctimeMs !== opened.ctimeMs ||
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      afterPath.size !== opened.size ||
      afterPath.mtimeMs !== opened.mtimeMs ||
      afterPath.ctimeMs !== opened.ctimeMs
    ) {
      throw signatureError(
        "RALPH_RELEASE_SIGNATURE_FILE_CHANGED",
        `${label} changed while it was read`,
        { exitCode: EXIT_CODES.conflict, file: path },
      )
    }
    return {
      path,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
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
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_FILE_ENCODING_INVALID",
      `${label} must use valid UTF-8`,
      { exitCode: EXIT_CODES.invalidUsage, file: file.path, cause: error },
    )
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_FILE_JSON_INVALID",
      `${label} must contain valid JSON`,
      { exitCode: EXIT_CODES.invalidUsage, file: file.path, cause: error },
    )
  }
}

async function resolveVerifierExecutable(
  configured: string,
  environment: Readonly<Record<string, string | undefined>>,
  processSupervisor: ProcessSupervisor,
): Promise<{
  readonly path: string
  readonly identity: VerifierConfiguration["executableIdentity"]
}> {
  if (!safeArgument(configured) || configured.trim().length === 0) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_CONFIG_INVALID",
      "Release signature verifier executable is invalid",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const selected = isAbsolute(configured)
    ? configured
    : processSupervisor.which(configured, environment)
  if (!selected) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_UNAVAILABLE",
      `Configured release signature verifier was not found: ${configured}`,
    )
  }
  const executable = await realpath(resolve(selected))
  const information = await lstat(executable)
  if (!information.isFile() || information.isSymbolicLink()) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_UNSAFE",
      "Release signature verifier must resolve to a regular executable file",
      { exitCode: EXIT_CODES.policyDenied, file: executable },
    )
  }
  return {
    path: executable,
    identity: {
      dev: information.dev,
      ino: information.ino,
      size: information.size,
      mtimeMs: information.mtimeMs,
      ctimeMs: information.ctimeMs,
    },
  }
}

async function assertVerifierExecutableIdentity(
  configuration: VerifierConfiguration,
): Promise<void> {
  const current = await lstat(configuration.executable).catch((error: unknown) => {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_CHANGED",
      "Release signature verifier disappeared before execution",
      {
        exitCode: EXIT_CODES.conflict,
        file: configuration.executable,
        cause: error,
      },
    )
  })
  const expected = configuration.executableIdentity
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.ctimeMs !== expected.ctimeMs
  ) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_CHANGED",
      "Release signature verifier changed after the trust configuration was loaded",
      { exitCode: EXIT_CODES.conflict, file: configuration.executable },
    )
  }
}

async function loadVerifierConfiguration(
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
  processSupervisor: ProcessSupervisor,
): Promise<VerifierConfiguration> {
  const file = await readStableRegularFile(
    path,
    CONFIG_LIMIT_BYTES,
    "Release verifier configuration",
  )
  const raw = parseUtf8Json(file, "Release verifier configuration")
  if (!isRecord(raw)) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_CONFIG_INVALID",
      "Release verifier configuration must be a JSON object",
      { exitCode: EXIT_CODES.invalidUsage, file: file.path },
    )
  }
  assertExactKeys(
    raw,
    ["schemaVersion", "protocol", "executable", "arguments", "timeoutMilliseconds", "trustPolicy"],
    "Release verifier configuration",
  )
  if (raw.schemaVersion !== 1 || raw.protocol !== ADAPTER_PROTOCOL) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_PROTOCOL_UNSUPPORTED",
      `Release verifier configuration must select ${ADAPTER_PROTOCOL}`,
      { exitCode: EXIT_CODES.invalidUsage, file: file.path },
    )
  }
  if (!safeArgument(raw.executable) || raw.executable.trim().length === 0) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_CONFIG_INVALID",
      "Release verifier configuration requires one executable without shell syntax",
      { exitCode: EXIT_CODES.invalidUsage, file: file.path },
    )
  }
  const argumentsValue = raw.arguments ?? []
  if (
    !Array.isArray(argumentsValue) ||
    argumentsValue.length > 64 ||
    argumentsValue.some((argument) => !safeArgument(argument)) ||
    argumentsValue.some(
      (argument) =>
        argument === "--request" ||
        argument === "--result" ||
        argument.startsWith("--request=") ||
        argument.startsWith("--result="),
    )
  ) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_CONFIG_INVALID",
      "Release verifier arguments must be a bounded JSON string array without app-owned flags",
      { exitCode: EXIT_CODES.invalidUsage, file: file.path },
    )
  }
  const timeoutMilliseconds = raw.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    (timeoutMilliseconds as number) < MINIMUM_TIMEOUT_MILLISECONDS ||
    (timeoutMilliseconds as number) > MAXIMUM_TIMEOUT_MILLISECONDS
  ) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_CONFIG_INVALID",
      `Release verifier timeout must be ${MINIMUM_TIMEOUT_MILLISECONDS}-${MAXIMUM_TIMEOUT_MILLISECONDS} ms`,
      { exitCode: EXIT_CODES.invalidUsage, file: file.path },
    )
  }
  const trustPolicy = ReleaseSignatureTrustPolicySchema.safeParse(raw.trustPolicy)
  if (!trustPolicy.success) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_TRUST_POLICY_INVALID",
      "Release verifier configuration contains an invalid local trust policy",
      {
        exitCode: EXIT_CODES.invalidUsage,
        file: file.path,
        details: { issues: trustPolicy.error.issues },
      },
    )
  }
  const executable = await resolveVerifierExecutable(raw.executable, environment, processSupervisor)
  return {
    executable: executable.path,
    executableIdentity: executable.identity,
    arguments: argumentsValue as string[],
    timeoutMilliseconds: timeoutMilliseconds as number,
    trustPolicy: trustPolicy.data,
  }
}

function verifierEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  temporaryRoot: string,
): Record<string, string> {
  const environment: Record<string, string> = {
    RALPH_RELEASE_VERIFIER_PROTOCOL: ADAPTER_PROTOCOL,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
  }
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = environmentValue(source, key)
    if (value !== undefined) environment[key] = value
  }
  return environment
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function removeVerifierTemporaryDirectory(
  path: string,
  expectedIdentity: Pick<FileIdentity, "dev" | "ino">,
): Promise<void> {
  const canonicalTemporaryRoot = await realpath(resolve(tmpdir()))
  const parent = await realpath(dirname(path))
  const current = await lstat(path).catch((error: unknown) => {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_TEMP_CHANGED",
      "Release verifier temporary directory disappeared before cleanup",
      { exitCode: EXIT_CODES.conflict, file: path, cause: error },
    )
  })
  if (
    parent !== canonicalTemporaryRoot ||
    !basename(path).startsWith("ralph-release-verify-") ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== expectedIdentity.dev ||
    current.ino !== expectedIdentity.ino
  ) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_TEMP_UNSAFE",
      "Refusing to clean a replaced or unexpected release verifier temporary directory",
      { exitCode: EXIT_CODES.policyDenied, file: path },
    )
  }
  await rm(path, { recursive: true, force: true })
}

function parseVerificationResult(file: StableFile): ReleaseSignatureVerificationResult {
  const raw = parseUtf8Json(file, "Release verifier result")
  if (!isRecord(raw)) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_RESULT_INVALID",
      "Release verifier result must be a JSON object",
      { file: file.path },
    )
  }
  assertExactKeys(
    raw,
    [
      "schemaVersion",
      "protocol",
      "status",
      "kind",
      "identity",
      "issuer",
      "signedManifestSha256",
      "signatureSha256",
    ],
    "Release verifier result",
    "RALPH_RELEASE_SIGNATURE_VERIFIER_RESULT_INVALID",
    EXIT_CODES.blocked,
  )
  const kind = ReleaseSignatureKindSchema.safeParse(raw.kind)
  if (
    raw.schemaVersion !== 1 ||
    raw.protocol !== ADAPTER_PROTOCOL ||
    raw.status !== "verified" ||
    !kind.success ||
    !safeProtocolPrincipal(raw.identity) ||
    (raw.issuer !== undefined && !safeProtocolPrincipal(raw.issuer)) ||
    typeof raw.signedManifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.signedManifestSha256) ||
    typeof raw.signatureSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(raw.signatureSha256)
  ) {
    throw signatureError(
      "RALPH_RELEASE_SIGNATURE_VERIFIER_RESULT_INVALID",
      "Release verifier did not return a strict verified result",
      { file: file.path },
    )
  }
  return {
    kind: kind.data,
    identity: raw.identity,
    ...(typeof raw.issuer === "string" ? { issuer: raw.issuer } : {}),
    signedManifestSha256: raw.signedManifestSha256,
    signatureSha256: raw.signatureSha256,
  }
}

export async function loadDistributionSignatureComposition(
  environment: Record<string, string | undefined>,
): Promise<
  | {
      readonly verifier: ReleaseSignatureVerifier
      readonly trustPolicy: ReleaseSignatureTrustPolicy
    }
  | undefined
> {
  const configuredPath = environment.RALPH_RELEASE_VERIFIER_CONFIG?.trim()
  if (!configuredPath) return undefined
  const processSupervisor = new BunProcessSupervisor()
  const configuration = await loadVerifierConfiguration(
    configuredPath,
    environment,
    processSupervisor,
  )
  return {
    trustPolicy: configuration.trustPolicy,
    verifier: {
      async verify(request) {
        if (request.signal?.aborted) {
          throw signatureError(
            "RALPH_RELEASE_SIGNATURE_VERIFICATION_INTERRUPTED",
            "Release signature verification was cancelled before it started",
            { exitCode: EXIT_CODES.interrupted },
          )
        }
        if (
          request.canonicalManifestBytes.byteLength === 0 ||
          request.canonicalManifestBytes.byteLength > CANONICAL_MANIFEST_LIMIT_BYTES ||
          !Number.isSafeInteger(request.signatureSizeBytes) ||
          request.signatureSizeBytes < 1 ||
          !Number.isSafeInteger(request.signatureMaximumSizeBytes) ||
          request.signatureMaximumSizeBytes < request.signatureSizeBytes ||
          request.signatureMaximumSizeBytes > SIGNATURE_LIMIT_BYTES ||
          !/^[0-9a-f]{64}$/u.test(request.signedManifestSha256) ||
          !/^[0-9a-f]{64}$/u.test(request.signatureSha256) ||
          !ReleaseSignatureMediaTypeSchema.safeParse(request.signatureMediaType).success
        ) {
          throw signatureError(
            "RALPH_RELEASE_SIGNATURE_REQUEST_INVALID",
            "Release signature verification request exceeds its deterministic protocol bounds",
            { exitCode: EXIT_CODES.policyDenied },
          )
        }
        const signatureSnapshot = await readStableRegularFile(
          request.signaturePath,
          request.signatureMaximumSizeBytes,
          "Detached release signature",
        )
        if (
          signatureSnapshot.bytes.byteLength !== request.signatureSizeBytes ||
          signatureSnapshot.sha256 !== request.signatureSha256
        ) {
          throw signatureError(
            "RALPH_RELEASE_SIGNATURE_PAYLOAD_CHANGED",
            "Detached release signature no longer matches the staged payload",
            {
              exitCode: EXIT_CODES.conflict,
              file: request.signaturePath,
              details: {
                expectedSizeBytes: request.signatureSizeBytes,
                actualSizeBytes: signatureSnapshot.bytes.byteLength,
                expectedSha256: request.signatureSha256,
                actualSha256: signatureSnapshot.sha256,
              },
            },
          )
        }
        const canonicalTemporaryRoot = await realpath(resolve(tmpdir()))
        const temporaryRoot = await mkdtemp(join(canonicalTemporaryRoot, "ralph-release-verify-"))
        const temporaryIdentity = await lstat(temporaryRoot)
        if (!temporaryIdentity.isDirectory() || temporaryIdentity.isSymbolicLink()) {
          throw signatureError(
            "RALPH_RELEASE_SIGNATURE_TEMP_UNSAFE",
            "Release verifier temporary root is not a private regular directory",
            { exitCode: EXIT_CODES.policyDenied, file: temporaryRoot },
          )
        }
        const requestPath = join(temporaryRoot, "request.json")
        const resultPath = join(temporaryRoot, "result.json")
        const signatureSnapshotPath = join(temporaryRoot, "signature.payload")
        try {
          await writePrivateFile(signatureSnapshotPath, signatureSnapshot.bytes)
          const requestDocument = {
            schemaVersion: 1,
            protocol: ADAPTER_PROTOCOL,
            operation: "verify-release-manifest",
            kind: request.kind,
            claimedIdentity: request.claimedIdentity,
            trustPolicy: request.trustPolicy,
            signedManifestSha256: request.signedManifestSha256,
            canonicalManifestBase64: Buffer.from(request.canonicalManifestBytes).toString("base64"),
            signaturePath: signatureSnapshotPath,
            signatureSizeBytes: request.signatureSizeBytes,
            signatureSha256: request.signatureSha256,
            signatureMediaType: request.signatureMediaType,
          }
          await writePrivateFile(
            requestPath,
            new TextEncoder().encode(`${JSON.stringify(requestDocument)}\n`),
          )
          await writePrivateFile(resultPath, new Uint8Array())
          await assertVerifierExecutableIdentity(configuration)
          const childEnvironment = verifierEnvironment(environment, temporaryRoot)
          const settlement = await processSupervisor.run({
            executable: configuration.executable,
            args: [...configuration.arguments, "--request", requestPath, "--result", resultPath],
            cwd: temporaryRoot,
            environment: childEnvironment,
            environmentAllowlist: Object.keys(childEnvironment),
            shell: false,
            timeoutMs: configuration.timeoutMilliseconds,
            gracePeriodMs: 1_000,
            outputLimitBytes: VERIFIER_OUTPUT_LIMIT_BYTES,
            rawOutputLimitBytes: VERIFIER_OUTPUT_LIMIT_BYTES,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          if (settlement.cancelled) {
            throw signatureError(
              "RALPH_RELEASE_SIGNATURE_VERIFICATION_INTERRUPTED",
              "Release signature verification was cancelled",
              { exitCode: EXIT_CODES.interrupted, file: configuration.executable },
            )
          }
          if (settlement.timedOut) {
            throw signatureError(
              "RALPH_RELEASE_SIGNATURE_VERIFIER_TIMEOUT",
              `Release signature verifier exceeded ${configuration.timeoutMilliseconds} ms`,
              { file: configuration.executable },
            )
          }
          if (settlement.error) {
            throw signatureError(
              "RALPH_RELEASE_SIGNATURE_VERIFIER_PROCESS_FAILED",
              "Release signature verifier could not be supervised to completion",
              {
                file: configuration.executable,
                details: { supervisorError: settlement.error },
              },
            )
          }
          if (settlement.exitCode !== 0) {
            throw signatureError(
              "RALPH_RELEASE_SIGNATURE_VERIFICATION_FAILED",
              settlement.exitCode === undefined
                ? "Release signature verifier terminated without a successful exit code"
                : `Release signature verifier rejected the artifact with exit code ${settlement.exitCode}`,
              {
                file: configuration.executable,
                ...(settlement.signal ? { details: { signal: settlement.signal } } : {}),
              },
            )
          }
          const result = parseVerificationResult(
            await readStableRegularFile(resultPath, RESULT_LIMIT_BYTES, "Release verifier result"),
          )
          const signatureAfter = await readStableRegularFile(
            request.signaturePath,
            request.signatureMaximumSizeBytes,
            "Detached release signature",
          )
          if (
            signatureAfter.bytes.byteLength !== signatureSnapshot.bytes.byteLength ||
            signatureAfter.sha256 !== signatureSnapshot.sha256
          ) {
            throw signatureError(
              "RALPH_RELEASE_SIGNATURE_PAYLOAD_CHANGED",
              "Detached release signature changed during verification",
              { exitCode: EXIT_CODES.conflict, file: request.signaturePath },
            )
          }
          return result
        } finally {
          await removeVerifierTemporaryDirectory(temporaryRoot, temporaryIdentity)
        }
      },
    },
  }
}
