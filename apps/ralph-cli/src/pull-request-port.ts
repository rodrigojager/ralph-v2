import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import { createPullRequestRequestBinding, type PullRequestPort } from "@ralph-next/orchestration"
import { BunProcessSupervisor } from "@ralph-next/supervisor"
import { z } from "zod"

const MAXIMUM_ADAPTER_CONFIG_BYTES = 1_048_576
const MAXIMUM_ADAPTER_INPUT_BYTES = 1_048_576
const MAXIMUM_ADAPTER_OUTPUT_BYTES = 1_048_576
const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
const EnvironmentReferenceSchema = z.string().regex(/^(?:env|environment):[A-Za-z_][A-Za-z0-9_]*$/u)
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)
const CommitSchema = z.string().regex(/^[0-9a-f]{40}$/u)
const SecretArgumentFlag =
  /^--?(?:api[_-]?(?:key|token)|access[_-]?(?:key|token)|refresh[_-]?token|auth[_-]?token|client[_-]?secret|session[_-]?(?:id|token)|token|password|passwd|secret|authorization|bearer|cookie|private[_-]?key)(?:=|$)/iu
const SecretEnvironmentName =
  /(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|(?:^|[_-])token(?:$|[_-])|authorization|bearer|password|passwd|secret|private[_-]?key|session[_-]?(?:id|token)|cookie)/iu
const SecretMaterialText = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/u,
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/u,
  /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{16,}/u,
  /[?&](?:token|access_token|refresh_token|api_key|apikey|key|secret)=[^&\s]+/iu,
] as const
const RedactionSentinels = new Set(["[REDACTED]", "<redacted>", "********"])

function containsAsciiControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127
  })
}

function containsSecretLikeArgument(value: string): boolean {
  const opaquePositionalToken =
    value.length >= 24 &&
    !value.startsWith("-") &&
    !/[\\/:]/u.test(value) &&
    /^[A-Za-z0-9._~+\-=]+$/u.test(value)
  return (
    SecretArgumentFlag.test(value) ||
    SecretMaterialText.some((pattern) => pattern.test(value)) ||
    RedactionSentinels.has(value) ||
    opaquePositionalToken
  )
}
const CanonicalTextSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      value === value.trim() &&
      value === value.normalize("NFC") &&
      !containsAsciiControlCharacter(value),
    "Text must be trimmed NFC without control characters",
  )

const PullRequestAdapterConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: z.literal("ralph-pull-request-adapter-v1"),
    executable: z.string().min(1).max(4_096),
    expectedExecutableSha256: Sha256Schema,
    args: z
      .array(
        z
          .string()
          .max(65_536)
          .refine((value) => !value.includes("\0"), "Adapter arguments cannot contain NUL")
          .refine(
            (value) => !containsSecretLikeArgument(value),
            "Adapter arguments cannot contain secret-like literals; use environmentRefs",
          ),
      )
      .max(256),
    environmentRefs: z.record(EnvironmentNameSchema, EnvironmentReferenceSchema).default({}),
    environmentAllowlist: z
      .array(EnvironmentNameSchema)
      .max(128)
      .refine(
        (names) => names.every((name) => !SecretEnvironmentName.test(name)),
        "Secret-like environment names must use environmentRefs",
      )
      .optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(30 * 60_000)
      .default(120_000),
  })
  .strict()

const PullRequestAdapterRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: z.literal("ralph-pull-request-adapter-v1"),
    operation: z.literal("create-pull-request"),
    repositoryRoot: z.string().min(1).max(32_768),
    sourceRef: CanonicalTextSchema,
    targetRef: CanonicalTextSchema,
    expectedSourceHead: CommitSchema,
    title: z.string().min(1).max(512),
    body: z.string().max(65_536),
    draft: z.boolean(),
    labels: z.array(CanonicalTextSchema).max(64),
    requestBinding: Sha256Schema,
    idempotencyKey: CanonicalTextSchema,
  })
  .strict()

const PullRequestAdapterResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: z.literal("ralph-pull-request-adapter-v1"),
    operation: z.literal("create-pull-request"),
    status: z.enum(["created", "existing"]),
    requestBinding: Sha256Schema,
    idempotencyKey: CanonicalTextSchema,
    ref: CanonicalTextSchema,
    head: CommitSchema,
  })
  .strict()

type PullRequestAdapterConfig = z.infer<typeof PullRequestAdapterConfigSchema> & {
  readonly executable: string
}

function adapterError(
  code: string,
  message: string,
  exitCode: (typeof EXIT_CODES)[keyof typeof EXIT_CODES],
  details?: Record<string, unknown>,
): RalphError {
  return new RalphError(code, message, {
    exitCode,
    ...(details ? { details } : {}),
  })
}

async function readStableConfig(path: string): Promise<{ path: string; value: unknown }> {
  const requested = resolve(path)
  const before = await lstat(requested).catch(() => undefined)
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size <= 0 ||
    before.size > MAXIMUM_ADAPTER_CONFIG_BYTES
  ) {
    throw adapterError(
      "RALPH_PULL_REQUEST_ADAPTER_CONFIG_INVALID",
      "Pull-request adapter config must be a bounded regular file",
      EXIT_CODES.invalidUsage,
      { path: requested },
    )
  }
  const canonical = await realpath(requested)
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const handle = await open(requested, constants.O_RDONLY | noFollow)
  let bytes: Uint8Array
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw adapterError(
        "RALPH_PULL_REQUEST_ADAPTER_CONFIG_CHANGED",
        "Pull-request adapter config changed while it was opened",
        EXIT_CODES.conflict,
      )
    }
    const buffer = await handle.readFile()
    const settled = await handle.stat()
    const after = await lstat(requested)
    if (
      buffer.byteLength === 0 ||
      buffer.byteLength > MAXIMUM_ADAPTER_CONFIG_BYTES ||
      !settled.isFile() ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      settled.dev !== opened.dev ||
      settled.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      settled.size !== buffer.byteLength ||
      after.size !== buffer.byteLength ||
      settled.mtimeMs !== opened.mtimeMs ||
      settled.ctimeMs !== opened.ctimeMs ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      (await realpath(requested)) !== canonical
    ) {
      throw adapterError(
        "RALPH_PULL_REQUEST_ADAPTER_CONFIG_CHANGED",
        "Pull-request adapter config changed while it was read",
        EXIT_CODES.conflict,
      )
    }
    bytes = buffer
  } finally {
    await handle.close()
  }
  try {
    return {
      path: canonical,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    }
  } catch (error) {
    throw adapterError(
      "RALPH_PULL_REQUEST_ADAPTER_CONFIG_INVALID",
      "Pull-request adapter config must be strict UTF-8 JSON",
      EXIT_CODES.invalidUsage,
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }
}

async function loadAdapterConfig(path: string): Promise<PullRequestAdapterConfig> {
  const input = await readStableConfig(path)
  const parsed = PullRequestAdapterConfigSchema.parse(input.value)
  const requestedExecutable = isAbsolute(parsed.executable)
    ? parsed.executable
    : resolve(dirname(input.path), parsed.executable)
  const requestedInfo = await lstat(requestedExecutable).catch(() => undefined)
  if (!requestedInfo?.isFile() || requestedInfo.isSymbolicLink()) {
    throw adapterError(
      "RALPH_PULL_REQUEST_ADAPTER_EXECUTABLE_INVALID",
      "Pull-request adapter executable must be a regular file, not a symlink",
      EXIT_CODES.invalidUsage,
      { executable: requestedExecutable },
    )
  }
  const executable = await realpath(requestedExecutable)
  const settledInfo = await lstat(executable)
  if (!settledInfo.isFile() || settledInfo.isSymbolicLink()) {
    throw adapterError(
      "RALPH_PULL_REQUEST_ADAPTER_EXECUTABLE_INVALID",
      "Pull-request adapter executable resolved to a non-regular file",
      EXIT_CODES.invalidUsage,
    )
  }
  return { ...parsed, executable }
}

/**
 * Composes a provider-neutral, stdin/stdout pull-request protocol. The config
 * stores only executable metadata and environment references; secret values
 * remain in the host environment/account-owned CLI and are redacted by the
 * process supervisor.
 */
export function createPullRequestPortFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): PullRequestPort | undefined {
  const configPath = environment.RALPH_PULL_REQUEST_ADAPTER_CONFIG?.trim()
  if (!configPath) return undefined
  let configPromise: Promise<PullRequestAdapterConfig> | undefined
  const config = () => (configPromise ??= loadAdapterConfig(configPath))
  return {
    async create(rawInput) {
      const { signal, ...serializableInput } = rawInput
      const input = PullRequestAdapterRequestSchema.parse({
        schemaVersion: 1,
        protocol: "ralph-pull-request-adapter-v1",
        operation: "create-pull-request",
        ...serializableInput,
      })
      const adapter = await config()
      const repositoryRoot = await realpath(resolve(input.repositoryRoot))
      const repositoryInfo = await lstat(repositoryRoot)
      if (!repositoryInfo.isDirectory() || repositoryInfo.isSymbolicLink()) {
        throw adapterError(
          "RALPH_PULL_REQUEST_REPOSITORY_INVALID",
          "Pull-request repository root must resolve to a regular directory",
          EXIT_CODES.conflict,
        )
      }
      const request = PullRequestAdapterRequestSchema.parse({ ...input, repositoryRoot })
      const expectedRequestBinding = createPullRequestRequestBinding(request)
      if (request.requestBinding !== expectedRequestBinding) {
        throw adapterError(
          "RALPH_PULL_REQUEST_REQUEST_BINDING_MISMATCH",
          "Pull-request request binding does not cover the exact canonical request",
          EXIT_CODES.conflict,
          {
            expectedRequestBinding,
            observedRequestBinding: request.requestBinding,
          },
        )
      }
      const stdin = `${JSON.stringify(request)}\n`
      if (Buffer.byteLength(stdin, "utf8") > MAXIMUM_ADAPTER_INPUT_BYTES) {
        throw adapterError(
          "RALPH_PULL_REQUEST_REQUEST_TOO_LARGE",
          "Pull-request adapter request exceeds the protocol input limit",
          EXIT_CODES.invalidUsage,
        )
      }
      const supervisor = new BunProcessSupervisor()
      const settlement = await supervisor.run({
        executable: adapter.executable,
        args: adapter.args,
        cwd: repositoryRoot,
        expectedCanonicalCwd: repositoryRoot,
        expectedExecutableSha256: adapter.expectedExecutableSha256,
        environment,
        environmentRefs: adapter.environmentRefs,
        ...(adapter.environmentAllowlist
          ? { environmentAllowlist: adapter.environmentAllowlist }
          : {}),
        shell: false,
        timeoutMs: adapter.timeoutMs,
        gracePeriodMs: 2_000,
        outputLimitBytes: MAXIMUM_ADAPTER_OUTPUT_BYTES,
        rawOutputLimitBytes: MAXIMUM_ADAPTER_OUTPUT_BYTES,
        maxInputBytes: MAXIMUM_ADAPTER_INPUT_BYTES,
        stdin,
        ...(signal ? { signal } : {}),
      })
      if (settlement.cancelled || signal?.aborted) {
        throw adapterError(
          "RALPH_PULL_REQUEST_ADAPTER_CANCELLED",
          "Pull-request adapter was cancelled",
          EXIT_CODES.interrupted,
        )
      }
      if (
        settlement.timedOut ||
        settlement.exitCode !== 0 ||
        settlement.error ||
        settlement.outputTruncated ||
        settlement.rawOutputTruncated
      ) {
        throw adapterError(
          "RALPH_PULL_REQUEST_ADAPTER_FAILED",
          "Pull-request adapter failed without a complete protocol result",
          settlement.timedOut ? EXIT_CODES.budgetExceeded : EXIT_CODES.operationalError,
          {
            exitCode: settlement.exitCode,
            timedOut: settlement.timedOut,
            error: settlement.error,
            stderr: settlement.stderr.slice(0, 4_096),
          },
        )
      }
      let rawResult: unknown
      try {
        rawResult = JSON.parse(settlement.stdout)
      } catch (error) {
        throw adapterError(
          "RALPH_PULL_REQUEST_ADAPTER_RESULT_INVALID",
          "Pull-request adapter stdout must contain exactly one JSON result",
          EXIT_CODES.operationalError,
          { cause: error instanceof Error ? error.message : String(error) },
        )
      }
      const result = PullRequestAdapterResultSchema.parse(rawResult)
      if (
        result.requestBinding !== input.requestBinding ||
        result.idempotencyKey !== input.idempotencyKey ||
        result.head !== input.expectedSourceHead
      ) {
        throw adapterError(
          "RALPH_PULL_REQUEST_ADAPTER_BINDING_MISMATCH",
          "Pull-request adapter result does not bind the authorized request and source HEAD",
          EXIT_CODES.conflict,
          {
            expectedIdempotencyKey: input.idempotencyKey,
            observedIdempotencyKey: result.idempotencyKey,
            expectedRequestBinding: input.requestBinding,
            observedRequestBinding: result.requestBinding,
            expectedSourceHead: input.expectedSourceHead,
            observedHead: result.head,
          },
        )
      }
      return { ref: result.ref, head: result.head }
    },
  }
}
