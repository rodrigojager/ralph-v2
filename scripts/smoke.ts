import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { CredentialRefSchema, CredentialStatusSchema } from "@ralph-next/credentials"
import {
  CommandResultSchema,
  RoleProfileConfigSchema,
  WorkspaceStatusSchema,
} from "@ralph-next/domain"
import {
  FallbackPolicySchema,
  ModelParametersSchema,
  RoleProfileSchema,
} from "@ralph-next/providers"
import { secretValuesFromEnvironment } from "@ralph-next/telemetry"
import { z } from "zod"
import { nativeTarget, validateStandaloneArtifact } from "./build-artifact"
import {
  assertNoSecretLeak,
  isolatedChildEnvironment,
  runCapturedProcess,
  SUBPROCESS_SECRET_CANARY,
} from "./subprocess"

type CommandObservation = {
  command: string[]
  exitCode: number
  stdoutBytes: number
  stderrBytes: number
  logicalCommand: string
  contract?: {
    catalogSnapshotId?: string
    provider?: string
    model?: string
    profile?: string
    credential?: string
    credentialStatus?: z.infer<typeof CredentialStatusSchema>
    doctorS04?: boolean
  }
}

const DoctorCheckSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["passed", "warning", "failed", "skipped"]),
    required: z.boolean(),
    message: z.string().min(1),
    hint: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const DoctorDataSchema = z
  .object({
    checks: z.array(DoctorCheckSchema),
  })
  .strict()

const CatalogUseSchema = z
  .object({
    snapshotId: z.string().regex(/^catalog:[a-f0-9]{64}$/),
    source: z.object({ kind: z.string().min(1), url: z.string().min(1) }).passthrough(),
    origin: z.enum(["cache", "source", "stale-cache", "fallback"]),
    stale: z.boolean(),
    warning: z.string().min(1).optional(),
  })
  .strict()

const CatalogListDataSchema = z
  .object({
    count: z.number().int().nonnegative(),
    catalog: CatalogUseSchema,
  })
  .passthrough()

const AuthListDataSchema = z
  .object({
    count: z.number().int().nonnegative(),
    credentials: z.array(CredentialRefSchema),
  })
  .strict()

const CredentialStatusEntrySchema = z
  .object({
    credential: CredentialRefSchema,
    status: CredentialStatusSchema,
  })
  .strict()

const AuthStatusDataSchema = z
  .object({
    count: z.number().int().nonnegative(),
    credentials: z.array(CredentialStatusEntrySchema),
  })
  .strict()

const ProfilesListDataSchema = z
  .object({
    count: z.number().int().nonnegative(),
    profiles: z.array(
      z
        .object({
          id: z.string().min(1),
          profile: RoleProfileConfigSchema,
        })
        .strict(),
    ),
  })
  .strict()

const ProfileCredentialSchema = z
  .object({
    ref: CredentialRefSchema,
    status: CredentialStatusSchema,
  })
  .strict()

const ProfileFormScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const ProfileFormDefaultSchema = z.union([
  ProfileFormScalarSchema,
  z.array(z.string()),
  z.record(z.string(), ProfileFormScalarSchema),
])
const ProfileFormCliRouteSchema = z
  .string()
  .refine(
    (value) => /^--[a-z][a-z-]*$/.test(value) || /^config:[a-z][a-z._]*$/.test(value),
    "Profile form route must be a CLI flag or an explicit config-only route",
  )

const ProfileFormFieldSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum([
      "select",
      "text",
      "reference",
      "multi-select",
      "toggle",
      "integer",
      "number",
      "json",
    ]),
    configPath: z.string().min(1),
    cliFlag: ProfileFormCliRouteSchema,
    cliAliases: z.array(ProfileFormCliRouteSchema).optional(),
    effectiveOptionKey: z.string().min(1).optional(),
    required: z.boolean(),
    secret: z.literal(false),
    choices: z.array(z.string().min(1)).min(1).optional(),
    defaultValue: ProfileFormDefaultSchema.optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    visibleWhen: z
      .object({
        fieldId: z.string().min(1),
        values: z.array(ProfileFormScalarSchema).min(1),
      })
      .strict()
      .optional(),
    help: z.string().min(1),
  })
  .strict()

const ProfileInspectDataSchema = z
  .object({
    id: z.string().min(1),
    profile: RoleProfileConfigSchema,
    runtimeProfile: RoleProfileSchema,
    effectiveParameters: ModelParametersSchema,
    fallbackPolicy: FallbackPolicySchema,
    catalog: CatalogUseSchema,
    sources: z.record(z.string(), z.unknown()),
    credential: ProfileCredentialSchema.optional(),
    model: z
      .object({ id: z.string().min(1), provider: z.string().min(1) })
      .passthrough()
      .optional(),
    form: z
      .object({
        schemaVersion: z.literal(1),
        formId: z.literal("role-profile"),
        profileId: z.string().min(1),
        fields: z.array(ProfileFormFieldSchema).min(1),
      })
      .strict(),
  })
  .strict()

function assertProfileProjection(
  command: "profiles configure" | "profiles inspect",
  profileId: string,
  profile: z.infer<typeof RoleProfileConfigSchema>,
  runtimeProfile: z.infer<typeof RoleProfileSchema>,
  effectiveParameters: z.infer<typeof ModelParametersSchema>,
  fallbackPolicy: z.infer<typeof FallbackPolicySchema>,
): void {
  if (
    profileId !== runtimeProfile.id ||
    profile.role !== runtimeProfile.role ||
    profile.backend !== runtimeProfile.backend ||
    profile.provider !== runtimeProfile.provider ||
    profile.model !== runtimeProfile.model ||
    profile.credential !== runtimeProfile.credential?.id ||
    profile.variant !== runtimeProfile.variant ||
    (runtimeProfile.credential !== undefined &&
      runtimeProfile.credential.provider !== profile.provider)
  ) {
    throw new Error(`${command} returned inconsistent configured and runtime profile identity`)
  }

  const expectedRequirements = {
    input: profile.requirements.input,
    tools: profile.requirements.tools,
    toolStreaming: profile.requirements.tool_streaming,
    reasoning: profile.requirements.reasoning,
    structuredOutput: profile.requirements.structured_output,
    usage: profile.requirements.usage,
    access: profile.requirements.access,
    ...(profile.requirements.minimum_context === undefined
      ? {}
      : { minimumContext: profile.requirements.minimum_context }),
    ...(profile.requirements.minimum_output === undefined
      ? {}
      : { minimumOutput: profile.requirements.minimum_output }),
  }
  const expectedLimits = {
    ...(profile.limits.max_input_tokens === undefined
      ? {}
      : { maxInputTokens: profile.limits.max_input_tokens }),
    ...(profile.limits.max_output_tokens === undefined
      ? {}
      : { maxOutputTokens: profile.limits.max_output_tokens }),
    ...(profile.limits.max_reasoning_tokens === undefined
      ? {}
      : { maxReasoningTokens: profile.limits.max_reasoning_tokens }),
    ...(profile.limits.max_total_tokens === undefined
      ? {}
      : { maxTotalTokens: profile.limits.max_total_tokens }),
    ...(profile.limits.max_cost === undefined ? {} : { maxCost: profile.limits.max_cost }),
  }
  if (
    !isDeepStrictEqual(runtimeProfile.requirements, expectedRequirements) ||
    !isDeepStrictEqual(runtimeProfile.fallbackProfiles, profile.fallback_profiles) ||
    !isDeepStrictEqual(runtimeProfile.limits, expectedLimits) ||
    !isDeepStrictEqual(fallbackPolicy.allowedFailures, profile.fallback_on) ||
    !isDeepStrictEqual(runtimeProfile.parameters, effectiveParameters)
  ) {
    throw new Error(`${command} returned an inconsistent config-to-runtime projection`)
  }
}

async function assertNoSecretPersisted(
  roots: readonly string[],
  secrets: readonly string[],
): Promise<void> {
  const pending = [...roots]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink())
        throw new Error(`Smoke fixture unexpectedly contains a link: ${path}`)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isFile()) continue
      const content = await readFile(path)
      for (const secret of secrets) {
        if (secret.length >= 4 && content.includes(Buffer.from(secret, "utf8"))) {
          throw new Error(`Smoke fixture persisted a secret in ${path}`)
        }
      }
    }
  }
}

function logicalCommandFromArgs(args: readonly string[]): string | undefined {
  const root = args[0]
  if (!root) return undefined
  if (["auth", "config", "model", "models", "profiles", "providers"].includes(root)) {
    return `${root}.${args[1] ?? ""}`
  }
  return root
}

function validateCommandData(args: readonly string[], command: string, data: unknown): void {
  const expectedCommand = logicalCommandFromArgs(args)
  if (!expectedCommand || command !== expectedCommand) {
    throw new Error(`${args.join(" ")} returned logical command ${command}`)
  }
  if (command === "status") WorkspaceStatusSchema.parse(data)
  if (command === "providers.list") {
    const providers = CatalogListDataSchema.extend({ providers: z.array(z.unknown()) }).parse(data)
    if (providers.count !== providers.providers.length || providers.count === 0) {
      throw new Error("providers list returned an inconsistent or empty catalog")
    }
  }
  if (command === "models.list") {
    const models = CatalogListDataSchema.extend({ models: z.array(z.unknown()) }).parse(data)
    if (models.count !== models.models.length || models.count === 0) {
      throw new Error("models list returned an inconsistent or empty catalog")
    }
  }
  if (command === "models.inspect") {
    CatalogListDataSchema.omit({ count: true })
      .extend({
        model: z.object({ id: z.string().min(1), provider: z.string().min(1) }).passthrough(),
      })
      .parse(data)
  }
  if (command === "auth.list") {
    const auth = AuthListDataSchema.parse(data)
    if (auth.count !== auth.credentials.length) throw new Error("auth list count is inconsistent")
  }
  if (command === "auth.connect") {
    z.object({
      credential: CredentialRefSchema,
    })
      .strict()
      .parse(data)
  }
  if (command === "auth.status") {
    const auth = AuthStatusDataSchema.parse(data)
    if (auth.count !== auth.credentials.length) throw new Error("auth status count is inconsistent")
  }
  if (command === "profiles.list") {
    const profiles = ProfilesListDataSchema.parse(data)
    if (profiles.count !== profiles.profiles.length) {
      throw new Error("profiles list count is inconsistent")
    }
  }
  if (command === "profiles.configure") {
    const configured = z
      .object({
        scope: z.enum(["global", "workspace"]),
        profileId: z.string().min(1),
        profile: RoleProfileConfigSchema,
        runtimeProfile: RoleProfileSchema,
        effectiveParameters: ModelParametersSchema,
        fallbackPolicy: FallbackPolicySchema,
        catalog: CatalogUseSchema,
        created: z.boolean(),
        path: z.string().min(1),
        form: z.unknown(),
      })
      .strict()
      .parse(data)
    assertProfileProjection(
      "profiles configure",
      configured.profileId,
      configured.profile,
      configured.runtimeProfile,
      configured.effectiveParameters,
      configured.fallbackPolicy,
    )
  }
  if (command === "profiles.inspect") {
    const inspected = ProfileInspectDataSchema.parse(data)
    const sourceKeys = Object.keys(inspected.sources)
    const formFieldIds = inspected.form.fields.map((field) => field.id)
    if (
      inspected.id !== inspected.form.profileId ||
      inspected.profile.credential !== inspected.credential?.ref.id ||
      (inspected.credential !== undefined &&
        inspected.credential.ref.provider !== inspected.profile.provider) ||
      (inspected.profile.credential !== undefined &&
        inspected.credential?.status !== "connected") ||
      (inspected.profile.backend === "embedded" && inspected.model === undefined) ||
      (inspected.model !== undefined &&
        (inspected.model.provider !== inspected.profile.provider ||
          inspected.model.id !== inspected.profile.model)) ||
      sourceKeys.length === 0 ||
      sourceKeys.some((key) => !key.startsWith(`profiles.${inspected.id}.`)) ||
      new Set(formFieldIds).size !== formFieldIds.length ||
      !["scope", "role", "backend", "provider", "model", "credential"].every((id) =>
        formFieldIds.includes(id),
      )
    ) {
      throw new Error("profiles inspect returned inconsistent config, runtime or resolved data")
    }
    assertProfileProjection(
      "profiles inspect",
      inspected.id,
      inspected.profile,
      inspected.runtimeProfile,
      inspected.effectiveParameters,
      inspected.fallbackPolicy,
    )
  }
  if (command === "auth.revoke") {
    z.object({
      credential: z.string().min(1),
      provider: z.string().min(1),
      revoked: z.literal(true),
    })
      .strict()
      .parse(data)
  }
  if (command !== "doctor") return

  const doctor = DoctorDataSchema.parse(data)
  const checks = new Map(doctor.checks.map((check) => [check.id, check]))
  const expected = [
    ["runtime.bun", true],
    ["runtime.git", true],
    ["filesystem.workspace", true],
    ["workspace.v2", false],
    ["terminal.tty", false],
  ] as const
  for (const [id, required] of expected) {
    const check = checks.get(id)
    if (!check || check.required !== required) {
      throw new Error(`doctor did not return the required S01 check contract for ${id}`)
    }
  }
  if (checks.get("workspace.v2")?.status !== "passed") {
    throw new Error("doctor did not validate the initialized v2 workspace")
  }
  for (const id of ["providers.catalog", "credentials.metadata", "profiles.runtime"] as const) {
    if (!checks.has(id)) throw new Error(`doctor did not return the required S04 check ${id}`)
  }
}

function configuredS04DoctorContract(
  data: unknown,
): { catalogSnapshotId: string; doctorS04: true } | undefined {
  const doctor = DoctorDataSchema.parse(data)
  const checks = new Map(doctor.checks.map((check) => [check.id, check]))
  if (checks.size !== doctor.checks.length) {
    throw new Error("doctor returned duplicate check identifiers")
  }
  const catalog = checks.get("providers.catalog")
  const credentials = checks.get("credentials.metadata")
  const profiles = checks.get("profiles.runtime")
  if (!catalog || !credentials || !profiles) {
    throw new Error("doctor did not return the complete S04 check set")
  }

  const s04Checks = [catalog, credentials, profiles]
  if (s04Checks.every((check) => check.status === "skipped")) {
    if (s04Checks.some((check) => check.required)) {
      throw new Error("doctor marked a skipped S04 check as required")
    }
    return undefined
  }

  if (
    catalog.required !== true ||
    (catalog.status !== "passed" && catalog.status !== "warning") ||
    credentials.required !== true ||
    credentials.status !== "passed" ||
    profiles.required !== true ||
    profiles.status !== "passed"
  ) {
    throw new Error(
      `Configured doctor did not pass the S04 contract: ${JSON.stringify(
        s04Checks.map(({ id, required, status }) => ({ id, required, status })),
      )}`,
    )
  }

  const catalogSnapshotId = catalog.message.match(/catalog:[a-f0-9]{64}/)?.[0]
  const profileSnapshotId = profiles.message.match(/catalog:[a-f0-9]{64}/)?.[0]
  if (!catalogSnapshotId || catalogSnapshotId !== profileSnapshotId) {
    throw new Error(
      `Configured doctor did not validate profiles against its exact catalog snapshot: ${JSON.stringify(
        { catalogSnapshotId, profileSnapshotId },
      )}`,
    )
  }
  return { catalogSnapshotId, doctorS04: true }
}

function commandContract(command: string, data: unknown): CommandObservation["contract"] {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  const catalog = CatalogUseSchema.safeParse(record.catalog)
  const model =
    record.model !== null && typeof record.model === "object" && !Array.isArray(record.model)
      ? (record.model as Record<string, unknown>)
      : undefined
  const runtime = RoleProfileSchema.safeParse(record.runtimeProfile)
  const directCredential = CredentialRefSchema.safeParse(record.credential)
  const statusData = command === "auth.status" ? AuthStatusDataSchema.safeParse(data) : undefined
  const statusCredential =
    statusData?.success && statusData.data.credentials.length === 1
      ? statusData.data.credentials[0]?.credential
      : undefined
  const statusValue =
    statusData?.success && statusData.data.credentials.length === 1
      ? statusData.data.credentials[0]?.status
      : undefined
  const profileCredential = ProfileCredentialSchema.safeParse(record.credential)
  const resolvedCredential =
    runtime.success && runtime.data.credential
      ? runtime.data.credential
      : directCredential.success
        ? directCredential.data
        : statusCredential
          ? statusCredential
          : profileCredential.success
            ? profileCredential.data.ref
            : undefined
  const doctorContract = command === "doctor" ? configuredS04DoctorContract(data) : undefined
  const contract = {
    ...(catalog.success ? { catalogSnapshotId: catalog.data.snapshotId } : {}),
    ...doctorContract,
    ...(typeof model?.provider === "string"
      ? { provider: model.provider }
      : runtime.success
        ? { provider: runtime.data.provider }
        : resolvedCredential
          ? { provider: resolvedCredential.provider }
          : typeof record.provider === "string"
            ? { provider: record.provider }
            : {}),
    ...(typeof model?.id === "string"
      ? { model: model.id }
      : runtime.success
        ? { model: runtime.data.model }
        : {}),
    ...(typeof record.profileId === "string"
      ? { profile: record.profileId }
      : runtime.success
        ? { profile: runtime.data.id }
        : typeof record.id === "string" && command === "profiles.inspect"
          ? { profile: record.id }
          : {}),
    ...(resolvedCredential
      ? { credential: resolvedCredential.id }
      : command === "auth.revoke" && typeof record.credential === "string"
        ? { credential: record.credential }
        : {}),
    ...(statusValue
      ? { credentialStatus: statusValue }
      : profileCredential.success
        ? { credentialStatus: profileCredential.data.status }
        : {}),
  }
  return Object.keys(contract).length > 0 ? contract : undefined
}

function assertSameCatalogSnapshot(observations: readonly CommandObservation[]): void {
  const uses = observations.map((observation) => ({
    command: observation.logicalCommand,
    snapshotId: observation.contract?.catalogSnapshotId,
  }))
  const expected = uses[0]?.snapshotId
  if (!expected || uses.some((use) => use.snapshotId !== expected)) {
    throw new Error(
      `Standalone commands did not agree on one catalog snapshot: ${JSON.stringify(uses)}`,
    )
  }
}

function assertCredentialIdentity(
  observations: readonly CommandObservation[],
  expectedCredential: string,
  expectedProvider: string,
): void {
  const uses = observations.map((observation) => ({
    command: observation.logicalCommand,
    credential: observation.contract?.credential,
    provider: observation.contract?.provider,
  }))
  if (
    uses.some((use) => use.credential !== expectedCredential || use.provider !== expectedProvider)
  ) {
    throw new Error(
      `Standalone commands did not preserve one credential/provider identity: ${JSON.stringify(
        uses,
      )}`,
    )
  }
}

function binaryFromArgs(argv: readonly string[], projectRoot: string): string {
  const index = argv.indexOf("--binary")
  if (index >= 0) {
    const path = argv[index + 1]
    if (!path) throw new Error("--binary requires a path")
    return resolve(path)
  }
  const extension = process.platform === "win32" ? ".exe" : ""
  return join(projectRoot, "dist", "standalone", nativeTarget(), `ralph-next${extension}`)
}

async function observe(
  binary: string,
  cwd: string,
  args: string[],
  environment: Record<string, string>,
): Promise<CommandObservation> {
  const observation = await runCapturedProcess([binary, ...args], {
    cwd,
    environment,
  })
  const { stdout, stderr, exitCode } = observation
  if (observation.timedOut) throw new Error(`${args.join(" ")} exceeded the smoke timeout`)
  assertNoSecretLeak(
    [stdout, stderr],
    // Compare against the exact isolated environment handed to this child.
    // Host-only credentials are deliberately excluded from the subprocess;
    // treating an unrelated short host value as an output substring creates a
    // false leak report without testing the actual process boundary.
    [...secretValuesFromEnvironment(environment), SUBPROCESS_SECRET_CANARY],
    `Smoke command ${args.join(" ")}`,
  )
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} exited ${exitCode}: ${stderr || stdout}`)
  }
  if (stderr !== "") throw new Error(`${args.join(" ")} wrote to stderr: ${stderr}`)
  if (stdout.includes(`${String.fromCharCode(27)}[`)) {
    throw new Error(`${args.join(" ")} emitted ANSI in JSON`)
  }
  const parsed: unknown = JSON.parse(stdout)
  const result = CommandResultSchema.parse(parsed)
  if (!result.ok) throw new Error(`${args.join(" ")} returned ok=false`)
  validateCommandData(args, result.command, result.data)
  const contract = commandContract(result.command, result.data)
  return {
    command: args,
    exitCode,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    logicalCommand: result.command,
    ...(contract ? { contract } : {}),
  }
}

const projectRoot = resolve(import.meta.dir, "..")
const sourceBinary = binaryFromArgs(process.argv.slice(2), projectRoot)
const artifact = await validateStandaloneArtifact(sourceBinary, projectRoot, nativeTarget())

const temporaryRoot = await mkdtemp(join(tmpdir(), "ralph-v2-standalone-smoke-"))
try {
  const binaryDirectory = join(temporaryRoot, "bin externo")
  const workspace = join(temporaryRoot, "workspace áç 你好")
  await Promise.all([
    mkdir(binaryDirectory, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ])
  const copiedBinary = join(binaryDirectory, basename(sourceBinary))
  await copyFile(sourceBinary, copiedBinary)
  if (process.platform !== "win32") await chmod(copiedBinary, 0o755)
  const isolatedEnvironmentRoot = join(temporaryRoot, "isolated-environment")
  const environment = await isolatedChildEnvironment(isolatedEnvironmentRoot)
  const observations: CommandObservation[] = []
  observations.push(
    await observe(copiedBinary, workspace, ["version", "--format", "json"], environment),
  )
  observations.push(
    await observe(copiedBinary, workspace, ["help", "--format", "json"], environment),
  )
  observations.push(
    await observe(copiedBinary, workspace, ["about", "--format", "json"], environment),
  )
  observations.push(
    await observe(copiedBinary, workspace, ["init", "--format", "json"], environment),
  )
  observations.push(
    await observe(copiedBinary, workspace, ["status", "--format", "json"], environment),
  )
  observations.push(
    await observe(
      copiedBinary,
      workspace,
      ["config", "list", "--effective", "--format", "json"],
      environment,
    ),
  )
  observations.push(
    await observe(
      copiedBinary,
      workspace,
      ["config", "explain", "defaults.mode", "--format", "json"],
      environment,
    ),
  )
  observations.push(
    await observe(
      copiedBinary,
      workspace,
      ["doctor", "--non-interactive", "--format", "json"],
      environment,
    ),
  )
  const providersList = await observe(
    copiedBinary,
    workspace,
    ["providers", "list", "--format", "json"],
    environment,
  )
  observations.push(providersList)
  const modelsList = await observe(
    copiedBinary,
    workspace,
    ["models", "list", "--provider", "openai", "--format", "json"],
    environment,
  )
  observations.push(modelsList)
  const modelInspect = await observe(
    copiedBinary,
    workspace,
    ["models", "inspect", "openai/gpt-5.4", "--format", "json"],
    environment,
  )
  observations.push(modelInspect)
  observations.push(
    await observe(copiedBinary, workspace, ["auth", "list", "--format", "json"], environment),
  )
  observations.push(
    await observe(copiedBinary, workspace, ["auth", "status", "--format", "json"], environment),
  )
  observations.push(
    await observe(copiedBinary, workspace, ["profiles", "list", "--format", "json"], environment),
  )
  const authConnect = await observe(
    copiedBinary,
    workspace,
    [
      "auth",
      "connect",
      "openai",
      "--method",
      "environment",
      "--environment",
      "RALPH_API_KEY",
      "--credential",
      "standalone-openai-env",
      "--label",
      "Standalone smoke",
      "--non-interactive",
      "--format",
      "json",
    ],
    environment,
  )
  observations.push(authConnect)
  const authStatus = await observe(
    copiedBinary,
    workspace,
    ["auth", "status", "standalone-openai-env", "--format", "json"],
    environment,
  )
  observations.push(authStatus)
  const profileConfigure = await observe(
    copiedBinary,
    workspace,
    [
      "profiles",
      "configure",
      "--profile",
      "standalone-executor",
      "--scope",
      "global",
      "--role",
      "executor",
      "--backend",
      "embedded",
      "--provider",
      "openai",
      "--model",
      "gpt-5.4",
      "--credential",
      "standalone-openai-env",
      "--non-interactive",
      "--format",
      "json",
    ],
    environment,
  )
  observations.push(profileConfigure)
  const profileInspect = await observe(
    copiedBinary,
    workspace,
    ["profiles", "inspect", "standalone-executor", "--format", "json"],
    environment,
  )
  observations.push(profileInspect)
  const configuredDoctor = await observe(
    copiedBinary,
    workspace,
    ["doctor", "--non-interactive", "--format", "json"],
    environment,
  )
  observations.push(configuredDoctor)
  if (configuredDoctor.contract?.doctorS04 !== true) {
    throw new Error("Configured doctor did not produce a successful S04 contract")
  }
  assertSameCatalogSnapshot([
    providersList,
    modelsList,
    modelInspect,
    profileConfigure,
    profileInspect,
    configuredDoctor,
  ])
  for (const observation of [modelInspect, profileConfigure, profileInspect]) {
    if (observation.contract?.provider !== "openai" || observation.contract?.model !== "gpt-5.4") {
      throw new Error(`${observation.logicalCommand} did not preserve openai/gpt-5.4`)
    }
  }
  for (const observation of [profileConfigure, profileInspect]) {
    if (observation.contract?.profile !== "standalone-executor") {
      throw new Error(`${observation.logicalCommand} did not preserve standalone-executor`)
    }
  }
  const authRevoke = await observe(
    copiedBinary,
    workspace,
    ["auth", "revoke", "standalone-openai-env", "--format", "json"],
    environment,
  )
  observations.push(authRevoke)
  assertCredentialIdentity(
    [authConnect, authStatus, profileConfigure, profileInspect, authRevoke],
    "standalone-openai-env",
    "openai",
  )
  if (
    authStatus.contract?.credentialStatus !== "connected" ||
    profileInspect.contract?.credentialStatus !== "connected"
  ) {
    throw new Error(
      "Standalone auth status and profile inspect did not agree on a connected credential",
    )
  }
  await assertNoSecretPersisted([workspace, isolatedEnvironmentRoot], [SUBPROCESS_SECRET_CANARY])
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        status: "tested",
        platform: process.platform,
        architecture: process.arch,
        target: nativeTarget(),
        sourceBinary: artifact.binary,
        sourceSha256: artifact.metadata.sourceSha256,
        artifactSha256: artifact.metadata.sha256,
        copiedBinary: basename(copiedBinary),
        observations,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
