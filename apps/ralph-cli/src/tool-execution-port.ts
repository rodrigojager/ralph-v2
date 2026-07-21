import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type {
  ExecutionToolContext,
  ExecutionToolPort,
  ExecutionToolReconciliationContext,
  ExecutionToolResult,
} from "@ralph/orchestration"
import {
  type ReplayedToolSettlement,
  reconcileUnsettledToolCalls,
  type ToolReconciliationResult,
  type ToolReplayDecision,
} from "@ralph/orchestration"
import {
  createSqliteToolCallJournal,
  ensureRunLayout,
  getAttempt,
  hashToolCallPayload,
  inspectWorkspace,
  rawPersistenceEnabled,
  resolveDiagnosticRawRetention,
  runLayout,
  type ToolCallIntentRecord,
  workspaceLayout,
  writeFileAtomic,
} from "@ralph/persistence"
import {
  type ProviderToolCall,
  ProviderToolCallSchema,
  type ProviderToolDefinition,
  ProviderToolDefinitionSchema,
} from "@ralph/providers"
import type { ProcessSupervisor } from "@ralph/supervisor"
import { redactText, redactValue, secretValuesFromEnvironment } from "@ralph/telemetry"
import {
  type ArtifactPublisherPort,
  type CommandRule,
  canonicalJson,
  createBuiltinToolRegistry,
  FsApplyPatchInputSchema,
  FsEditInputSchema,
  FsWriteInputSchema,
  hashCanonical,
  InMemoryToolJournal,
  type PermissionPromptPort,
  type ProcessPortResult,
  type PublishedArtifact,
  SupervisorProcessExecutorAdapter,
  sha256,
  type ToolCallRecord,
  type ToolDefinition,
  type ToolEvent,
  type ToolEventSink,
  ToolHost,
  ToolHostError,
  type ToolPolicy,
  ToolPolicySchema,
  type ToolRegistry,
  type ToolSession,
  type ToolSettlement,
  ToolSettlementSchema,
  WorkspacePathResolver,
} from "@ralph/tool-host"
import { probeDurableProcessIntent, reattachDurableProcessIntent } from "./durable-process-owner"
import {
  createWorkspaceBunProcessSupervisor,
  WorkspaceProcessOutputStore,
  type WorkspaceProcessOutputStoreOptions,
} from "./process-output-store"
import { DurableToolJournal } from "./tool-journal-adapter"

const MAX_MODEL_TOOL_OUTPUT_BYTES = 1_048_576
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_PROCESS_ENVIRONMENT_KEYS = [
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
] as const

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("und") : path
}

function isContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  )
}

function portable(path: string): string {
  return path.split(sep).join("/")
}

function operationalProcessEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const output: Record<string, string> = {}
  for (const allowedName of SAFE_PROCESS_ENVIRONMENT_KEYS) {
    const expected = allowedName.toLocaleLowerCase("und")
    const value = Object.entries(environment).find(
      ([name, candidate]) => candidate !== undefined && name.toLocaleLowerCase("und") === expected,
    )?.[1]
    if (value !== undefined) output[allowedName] = value
  }
  return output
}

const WORKSPACE_MUTATION_RECOVERY_VERSION = "ralph.workspace-mutation-recovery.v1"
const RECOVERY_HASHES_PER_REF = 12

type TextReplacement = {
  oldText: string
  newText: string
  all?: boolean
}

type WorkspaceMutationTarget = {
  path: string
  beforeSha256: string | null
  afterSha256?: string
  replacements?: readonly TextReplacement[]
}

type StableWorkspaceFile =
  | { state: "absent" }
  | { state: "file"; sha256: string; text: string }
  | { state: "unknown"; reason: string }

function fileFingerprint(metadata: {
  dev: number
  ino: number
  mode: number
  size: number
  mtimeMs: number
  ctimeMs: number
}): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.size,
    metadata.mtimeMs,
    metadata.ctimeMs,
  ].join(":")
}

function applyTextReplacements(
  source: string,
  replacements: readonly TextReplacement[],
): string | undefined {
  let output = source
  for (const replacement of replacements) {
    const first = output.indexOf(replacement.oldText)
    if (first < 0) return undefined
    if (replacement.all) {
      output = output.split(replacement.oldText).join(replacement.newText)
      continue
    }
    if (output.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
      return undefined
    }
    output = `${output.slice(0, first)}${replacement.newText}${output.slice(
      first + replacement.oldText.length,
    )}`
  }
  return output
}

function workspaceMutationTargets(
  tool: string,
  argumentsValue: unknown,
): WorkspaceMutationTarget[] | undefined {
  if (tool === "fs.write") {
    const parsed = FsWriteInputSchema.safeParse(argumentsValue)
    if (!parsed.success) return undefined
    return [
      {
        path: parsed.data.path,
        beforeSha256:
          parsed.data.precondition.kind === "sha256" ? parsed.data.precondition.value : null,
        afterSha256: sha256(Buffer.from(parsed.data.content, "utf8")),
      },
    ]
  }
  if (tool === "fs.edit") {
    const parsed = FsEditInputSchema.safeParse(argumentsValue)
    if (!parsed.success) return undefined
    return [
      {
        path: parsed.data.path,
        beforeSha256: parsed.data.beforeSha256,
        replacements: parsed.data.replacements,
      },
    ]
  }
  if (tool === "fs.apply_patch") {
    const parsed = FsApplyPatchInputSchema.safeParse(argumentsValue)
    if (!parsed.success) return undefined
    return parsed.data.changes.map((change) => ({
      path: change.path,
      beforeSha256: change.beforeSha256,
      replacements: change.replacements,
    }))
  }
  return undefined
}

function encodeWorkspaceMutationRefs(
  argumentsHash: string,
  targets: readonly WorkspaceMutationTarget[],
): string[] {
  const refs = [
    WORKSPACE_MUTATION_RECOVERY_VERSION,
    `arguments:${argumentsHash}`,
    `targets:${targets.length}`,
  ]
  const hashes = targets.map((target) => target.afterSha256 ?? "?")
  for (let index = 0; index < hashes.length; index += RECOVERY_HASHES_PER_REF) {
    refs.push(`after:${index}:${hashes.slice(index, index + RECOVERY_HASHES_PER_REF).join(",")}`)
  }
  return refs
}

function decodeWorkspaceMutationRefs(
  intent: ToolCallIntentRecord,
  targets: readonly WorkspaceMutationTarget[],
): readonly (string | undefined)[] | undefined {
  const refs = intent.preconditionRefs
  if (
    refs[0] !== WORKSPACE_MUTATION_RECOVERY_VERSION ||
    refs[1] !== `arguments:${intent.argumentsHash}` ||
    refs[2] !== `targets:${targets.length}`
  ) {
    return undefined
  }
  const hashes: Array<string | undefined> = []
  for (const [ordinal, ref] of refs.slice(3).entries()) {
    const expectedIndex = ordinal * RECOVERY_HASHES_PER_REF
    const prefix = `after:${expectedIndex}:`
    if (!ref.startsWith(prefix)) return undefined
    for (const value of ref.slice(prefix.length).split(",")) {
      if (value === "?") {
        hashes.push(undefined)
      } else if (/^[a-f0-9]{64}$/.test(value)) {
        hashes.push(value)
      } else {
        return undefined
      }
    }
  }
  return hashes.length === targets.length ? hashes : undefined
}

async function readStableWorkspaceFile(
  resolver: WorkspacePathResolver,
  path: string,
  maximumBytes: number,
): Promise<StableWorkspaceFile> {
  try {
    const resolved = await resolver.resolve(path, "write")
    if (!resolved.exists) return { state: "absent" }
    if (resolved.kind !== "file") {
      return { state: "unknown", reason: "workspace target is not a regular file" }
    }
    const beforePath = await lstat(resolved.absolutePath)
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > maximumBytes) {
      return { state: "unknown", reason: "workspace target is unsafe or exceeds the hash limit" }
    }
    const handle = await open(resolved.absolutePath, "r")
    try {
      const beforeHandle = await handle.stat()
      if (fileFingerprint(beforePath) !== fileFingerprint(beforeHandle)) {
        return { state: "unknown", reason: "workspace target changed before hashing" }
      }
      const bytes = await handle.readFile()
      const afterHandle = await handle.stat()
      if (fileFingerprint(beforeHandle) !== fileFingerprint(afterHandle)) {
        return { state: "unknown", reason: "workspace target changed while hashing" }
      }
      let text: string
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {
        return { state: "unknown", reason: "workspace target is not valid UTF-8" }
      }
      return { state: "file", sha256: sha256(bytes), text }
    } finally {
      await handle.close()
    }
  } catch {
    return { state: "unknown", reason: "workspace target could not be resolved safely" }
  }
}

async function captureWorkspaceMutationRefs(
  record: ToolCallRecord,
  context: ExecutionToolContext,
): Promise<readonly string[]> {
  if (record.risk !== "write") return []
  const targets = workspaceMutationTargets(record.tool, record.argumentsRedacted)
  if (!targets) return []
  const policy = policyFromContext(context)
  const resolver = await WorkspacePathResolver.create(context.workspaceRoot, policy)
  for (const target of targets) {
    if (target.afterSha256 || !target.replacements) continue
    const current = await readStableWorkspaceFile(
      resolver,
      target.path,
      policy.limits.maxWriteBytes,
    )
    if (
      current.state !== "file" ||
      target.beforeSha256 === null ||
      current.sha256 !== target.beforeSha256
    ) {
      continue
    }
    const output = applyTextReplacements(current.text, target.replacements)
    if (output !== undefined) target.afterSha256 = sha256(Buffer.from(output, "utf8"))
  }
  return encodeWorkspaceMutationRefs(record.argumentsHash, targets)
}

function assertSafeArtifactId(artifactId: string): void {
  if (!ARTIFACT_ID_PATTERN.test(artifactId) || artifactId === "." || artifactId === "..") {
    throw new ToolHostError(
      "RALPH_ARTIFACT_ID_INVALID",
      `Artifact ID is not a safe path segment: ${artifactId}`,
      "invalid",
      "effect-absent",
    )
  }
}

/**
 * Copies an explicitly published workspace file into the immutable run area.
 * ToolHost resolves policy first; this adapter repeats the containment and
 * regular-file checks so the storage boundary remains safe when reused.
 */
export class WorkspaceArtifactPublisher implements ArtifactPublisherPort {
  readonly #workspaceRoot: string
  readonly #controlRoot: string
  readonly #runId: string

  constructor(options: { workspaceRoot: string; controlRoot?: string; runId: string }) {
    this.#workspaceRoot = resolve(options.workspaceRoot)
    this.#controlRoot = resolve(options.controlRoot ?? options.workspaceRoot)
    // Validate before any path is composed from a run identifier.
    runLayout(workspaceLayout(this.#controlRoot), options.runId)
    this.#runId = options.runId
  }

  async publish(input: {
    artifactId: string
    workspaceRoot: string
    path: string
    expectedSha256?: string
    maximumBytes: number
  }): Promise<PublishedArtifact> {
    assertSafeArtifactId(input.artifactId)
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
      throw new ToolHostError(
        "RALPH_ARTIFACT_LIMIT_INVALID",
        "Artifact maximumBytes must be a positive safe integer",
        "invalid",
        "effect-absent",
      )
    }
    if (isAbsolute(input.path)) {
      throw new ToolHostError(
        "RALPH_ARTIFACT_PATH_INVALID",
        "Artifact paths must be workspace-relative",
        "denied",
        "effect-absent",
      )
    }

    const expectedRoot = await realpath(this.#workspaceRoot)
    const suppliedRoot = await realpath(resolve(input.workspaceRoot))
    if (comparablePath(expectedRoot) !== comparablePath(suppliedRoot)) {
      throw new ToolHostError(
        "RALPH_ARTIFACT_WORKSPACE_MISMATCH",
        "Artifact publication targeted another workspace",
        "denied",
        "manual-review",
      )
    }

    const requestedSource = resolve(expectedRoot, input.path)
    if (!isContained(expectedRoot, requestedSource)) {
      throw new ToolHostError(
        "RALPH_ARTIFACT_PATH_ESCAPE",
        "Artifact source escapes the workspace",
        "denied",
        "manual-review",
      )
    }
    const requestedInfo = await lstat(requestedSource)
    if (requestedInfo.isSymbolicLink()) {
      throw new ToolHostError(
        "RALPH_ARTIFACT_SYMLINK_DENIED",
        "Artifact sources cannot be symbolic links",
        "denied",
        "manual-review",
      )
    }
    const source = await realpath(requestedSource)
    if (!isContained(expectedRoot, source)) {
      throw new ToolHostError(
        "RALPH_ARTIFACT_PATH_ESCAPE",
        "Canonical artifact source escapes the workspace",
        "denied",
        "manual-review",
      )
    }
    const sourceRelative = portable(relative(expectedRoot, source))
    if (sourceRelative === ".ralph" || sourceRelative.startsWith(".ralph/")) {
      throw new ToolHostError(
        "RALPH_ARTIFACT_CONTROL_PATH",
        "Ralph control-plane files cannot be published as task artifacts",
        "denied",
        "manual-review",
      )
    }

    const handle = await open(source, "r")
    let bytes: Uint8Array
    try {
      const before = await handle.stat()
      if (!before.isFile()) {
        throw new ToolHostError(
          "RALPH_ARTIFACT_REGULAR_FILE_REQUIRED",
          "Artifact source must be a regular file",
          "invalid",
          "effect-absent",
        )
      }
      if (before.size > input.maximumBytes) {
        throw new ToolHostError(
          "RALPH_ARTIFACT_TOO_LARGE",
          `Artifact exceeds ${input.maximumBytes} bytes`,
          "invalid",
          "effect-absent",
        )
      }
      bytes = await handle.readFile()
      const after = await handle.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new ToolHostError(
          "RALPH_ARTIFACT_CHANGED_DURING_READ",
          "Artifact source changed while it was being captured",
          "error",
          "reconcile-by-precondition",
          true,
        )
      }
    } finally {
      await handle.close()
    }

    const contentHash = sha256(bytes)
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== contentHash) {
      throw new ToolHostError(
        "RALPH_ARTIFACT_HASH_MISMATCH",
        "Artifact source hash does not match expectedSha256",
        "error",
        "reconcile-by-precondition",
        true,
      )
    }
    const controlRoot = await realpath(this.#controlRoot)
    const isolated = await ensureRunLayout(workspaceLayout(controlRoot), this.#runId)
    const destination = join(isolated.artifacts, input.artifactId)
    if (await Bun.file(destination).exists()) {
      const existing = new Uint8Array(await Bun.file(destination).arrayBuffer())
      if (sha256(existing) !== contentHash) {
        throw new ToolHostError(
          "RALPH_ARTIFACT_ID_CONFLICT",
          `Artifact ID already contains different content: ${input.artifactId}`,
          "error",
          "manual-review",
        )
      }
    } else {
      await writeFileAtomic(destination, bytes, { overwrite: false })
    }

    return {
      artifactId: input.artifactId,
      path: sourceRelative,
      contentHash,
      sizeBytes: bytes.byteLength,
      ref: portable(relative(controlRoot, destination)),
    }
  }
}

export {
  createWorkspaceBunProcessSupervisor,
  WorkspaceProcessOutputStore,
  type WorkspaceProcessOutputStoreOptions,
}

type ParsedCommand = { executable: string; args: readonly string[] }

/**
 * Tokenizes a configured command into direct argv. Quotes group arguments but
 * are never evaluated by a shell; expansion, pipes and redirects remain plain
 * argument characters.
 */
export function parseAllowedCommand(command: string): ParsedCommand {
  if (command.length === 0 || command.trim().length === 0) {
    throw new Error("Allowed command cannot be empty")
  }
  const tokens: string[] = []
  let token = ""
  let tokenStarted = false
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string
    const codePoint = character.codePointAt(0) as number
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
      throw new Error("Allowed command contains a terminal control character")
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined
        tokenStarted = true
        continue
      }
      if (character === "\\" && quote === '"') {
        const next = command[index + 1]
        if (next === '"') {
          token += next
          tokenStarted = true
          index += 1
          continue
        }
      }
      token += character
      tokenStarted = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      tokenStarted = true
      continue
    }
    if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token)
        token = ""
        tokenStarted = false
      }
      continue
    }
    if (character === "\\") {
      const next = command[index + 1]
      if (next !== undefined && (/\s/.test(next) || next === "'" || next === '"')) {
        token += next
        tokenStarted = true
        index += 1
        continue
      }
    }
    token += character
    tokenStarted = true
  }
  if (quote !== undefined) throw new Error("Allowed command contains an unterminated quote")
  if (tokenStarted) tokens.push(token)
  const [executable, ...args] = tokens
  if (!executable) throw new Error("Allowed command must contain an executable")
  return { executable, args }
}

export function commandRulesFromAllowedCommands(
  commands: readonly string[],
): readonly CommandRule[] {
  return commands.map((command, index) => {
    const parsed = parseAllowedCommand(command)
    return {
      id: `configured-command-${index + 1}-${sha256(command).slice(0, 12)}`,
      executable: parsed.executable,
      exactArgs: [...parsed.args],
      shell: false,
      risk: "process",
    }
  })
}

function policyFromContext(context: ExecutionToolContext): ToolPolicy {
  return ToolPolicySchema.parse({
    schemaVersion: 1,
    role: "executor",
    securityMode: context.security.mode,
    interactive: context.security.interactive,
    headlessAsk: context.security.headlessAsk,
    toolRules: context.security.toolRules,
    // ToolPolicy requires at least one read scope. `.ralph` is intrinsically
    // protected, so it faithfully represents an explicitly empty read set.
    readScopes: context.security.readPaths.length > 0 ? context.security.readPaths : [".ralph"],
    writeScopes: context.security.writePaths,
    protectedPaths: context.protectedPaths,
    commandRules: commandRulesFromAllowedCommands(context.security.allowedCommands),
    allowUnlistedProcess: false,
    allowDestructive: false,
    allowShell: context.security.allowShell,
    followInternalSymlinksForRead: false,
    limits: {},
  })
}

function internalToolCallId(context: ExecutionToolContext, call: ProviderToolCall): string {
  return `tool-${hashCanonical("ralph.execution-tool-call.v1", {
    runId: context.runId,
    documentId: context.documentId,
    taskId: context.taskId,
    attemptId: context.attemptId,
    modelCallId: context.modelCallId,
    providerToolCallId: call.callId,
  })}`
}

function definitionForProvider(definition: ToolDefinition): ProviderToolDefinition {
  const original = definition.inputSchema
  const alreadyStrictObject = original.type === "object" && original.additionalProperties === false
  const branches = [
    ...(Array.isArray(original.oneOf) ? original.oneOf : []),
    ...(Array.isArray(original.anyOf) ? original.anyOf : []),
  ]
  const unionPropertyNames = [
    ...new Set(
      branches.flatMap((branch) => {
        if (branch === null || typeof branch !== "object" || Array.isArray(branch)) return []
        const properties = (branch as Record<string, unknown>).properties
        return properties !== null && typeof properties === "object" && !Array.isArray(properties)
          ? Object.keys(properties)
          : []
      }),
    ),
  ].sort()
  // OpenAI-style function contracts require a strict object at the root.
  // Zod emits root `oneOf` for discriminated object unions; the root property
  // envelope closes unknown keys while each original branch keeps its exact
  // validation and required fields.
  const inputSchema = alreadyStrictObject
    ? original
    : {
        ...original,
        type: "object",
        properties: Object.fromEntries(unionPropertyNames.map((name) => [name, {}])),
        additionalProperties: false,
      }
  return ProviderToolDefinitionSchema.parse({
    name: definition.name,
    description: definition.description,
    inputSchema,
  })
}

export function boundedSettlementOutput(
  settlement: ToolSettlement,
  secretValues: readonly string[],
): string {
  const redactedContent = redactValue(settlement.content ?? null, secretValues)
  const redactedOutputRefs = redactValue(settlement.outputRefs, secretValues)
  const redactedEffects = redactValue(settlement.effects, secretValues)
  const redactedReason = settlement.reason ? redactText(settlement.reason, secretValues) : undefined
  const projection = {
    schemaVersion: 1,
    outcome: settlement.outcome,
    content: redactedContent,
    outputRefs: redactedOutputRefs,
    effects: redactedEffects,
    recovery: settlement.recovery,
    ...(redactedReason ? { reason: redactedReason } : {}),
  }
  const output = canonicalJson(projection)
  if (Buffer.byteLength(output, "utf8") <= MAX_MODEL_TOOL_OUTPUT_BYTES) return output
  return canonicalJson({
    schemaVersion: 1,
    outcome: settlement.outcome,
    content: {
      omitted: true,
      reason: "Tool result exceeded the model boundary; inspect durable outputRefs",
      serializedBytes: Buffer.byteLength(output, "utf8"),
    },
    outputRefs: redactedOutputRefs,
    effects: redactedEffects,
    recovery: settlement.recovery,
    ...(redactedReason ? { reason: redactedReason } : {}),
  })
}

function reconciliationExecutionContext(
  context: ExecutionToolReconciliationContext,
  intent: ToolCallIntentRecord,
): ExecutionToolContext {
  return {
    runId: context.runId,
    documentId: context.documentId,
    taskId: context.taskId,
    attemptId: intent.attemptId,
    modelCallId: intent.modelCallId,
    workspaceRoot: context.workspaceRoot,
    ...(context.controlRoot ? { controlRoot: context.controlRoot } : {}),
    ...(context.processSupervisor ? { processSupervisor: context.processSupervisor } : {}),
    protectedPaths: context.protectedPaths,
    maximumToolCalls: 1,
    telemetry: context.telemetry,
    security: context.security,
    ...(context.signal ? { signal: context.signal } : {}),
    environment: context.environment,
    emit: context.emit,
  }
}

async function probeWorkspaceMutation(
  intent: ToolCallIntentRecord,
  context: ExecutionToolReconciliationContext,
) {
  const bindingHash = hashToolCallPayload(intent.preconditionRefs)
  if (hashCanonical("ralph.tool.arguments.v1", intent.argumentsRedacted) !== intent.argumentsHash) {
    return {
      bindingHash,
      effect: "unknown" as const,
      reason: "Redaction prevents exact reconstruction of the original write arguments",
    }
  }
  const targets = workspaceMutationTargets(intent.tool, intent.argumentsRedacted)
  if (!targets) {
    return {
      bindingHash,
      effect: "unknown" as const,
      reason: "The write tool has no deterministic workspace-mutation adapter",
    }
  }
  const afterHashes = decodeWorkspaceMutationRefs(intent, targets)
  if (!afterHashes || afterHashes.some((hash) => hash === undefined)) {
    return {
      bindingHash,
      effect: "unknown" as const,
      reason: "The durable intent lacks a complete post-effect hash binding",
    }
  }
  const policy = policyFromContext(reconciliationExecutionContext(context, intent))
  const resolver = await WorkspacePathResolver.create(context.workspaceRoot, policy)
  const states: Array<"present" | "absent" | "conflict" | "unknown"> = []
  const effectRefs: string[] = []
  for (const [index, target] of targets.entries()) {
    if (context.signal?.aborted) {
      throw context.signal.reason ?? new Error("Tool reconciliation was cancelled")
    }
    const current = await readStableWorkspaceFile(
      resolver,
      target.path,
      policy.limits.maxWriteBytes,
    )
    if (current.state === "unknown") {
      states.push("unknown")
      continue
    }
    const afterSha256 = afterHashes[index]
    if (current.state === "file" && current.sha256 === afterSha256) {
      states.push("present")
      effectRefs.push(`workspace:${sha256(target.path)}:${current.sha256}`)
      continue
    }
    if (
      (target.beforeSha256 === null && current.state === "absent") ||
      (target.beforeSha256 !== null &&
        current.state === "file" &&
        current.sha256 === target.beforeSha256)
    ) {
      states.push("absent")
      continue
    }
    states.push("conflict")
  }
  if (states.every((state) => state === "present")) {
    return {
      bindingHash,
      effect: "present" as const,
      reason: "Every workspace target matches the intent's durable post-effect hash",
      effectRefs,
    }
  }
  if (states.every((state) => state === "absent")) {
    return {
      bindingHash,
      effect: "absent" as const,
      reason: "Every workspace target still matches the intent's durable precondition",
    }
  }
  if (states.includes("unknown")) {
    return {
      bindingHash,
      effect: "unknown" as const,
      reason: "At least one workspace target could not be hashed safely",
    }
  }
  return {
    bindingHash,
    effect: "conflict" as const,
    reason: "Workspace targets are partially applied or differ from both bound states",
  }
}

function persistenceToolOutcome(
  outcome: ToolSettlement["outcome"],
): ReplayedToolSettlement["outcome"] {
  switch (outcome) {
    case "success":
      return "succeeded"
    case "nonzero":
      return "nonzero"
    case "denied":
      return "denied"
    case "timeout":
      return "timeout"
    case "cancelled":
      return "cancelled"
    case "invalid":
    case "error":
      return "failed"
    case "unsettled":
      return "needs-reconciliation"
  }
}

function replaySettlement(
  intent: ToolCallIntentRecord,
  settlement: ToolSettlement,
): ReplayedToolSettlement {
  const durableResult: ToolSettlement = {
    ...settlement,
    toolCallId: intent.id,
  }
  return {
    outcome: persistenceToolOutcome(settlement.outcome),
    result: durableResult,
    effectRefs: settlement.effects.map(
      (effect, index) => `effect:${index}:${hashToolCallPayload(effect)}`,
    ),
    outputRefs: settlement.outputRefs,
    ...(settlement.outcome === "success"
      ? {}
      : { errorCode: `RALPH_TOOL_${settlement.outcome.toUpperCase().replaceAll("-", "_")}` }),
  }
}

function durableProcessToolSettlement(
  intent: ToolCallIntentRecord,
  result: ProcessPortResult,
  settledAt: string,
): ToolSettlement {
  const outcome = result.cancelled
    ? "cancelled"
    : result.timedOut
      ? "timeout"
      : result.error
        ? "error"
        : result.exitCode === 0
          ? "success"
          : "nonzero"
  return ToolSettlementSchema.parse({
    schemaVersion: 1,
    toolCallId: intent.id,
    outcome,
    content: {
      recovery: "durable-process-owner",
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.signal !== undefined ? { signal: result.signal } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      outputTruncated: result.outputTruncated,
      rawOutputTruncated: result.rawOutputTruncated,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      treeTerminated: result.treeTerminated,
    },
    outputRefs: [...result.outputRefs],
    effects: [{ kind: "process" }],
    durationMs: result.durationMs,
    retryable: false,
    recovery: "unknown-external-effect",
    ...(result.error ? { reason: result.error } : {}),
    settledAt,
  })
}

export type RalphExecutionToolPortOptions = {
  registry?: ToolRegistry
  prompt?: PermissionPromptPort
  processSupervisorFactory?: (context: ExecutionToolContext) => ProcessSupervisor
  artifactPublisherFactory?: (context: ExecutionToolContext) => ArtifactPublisherPort
  onEvent?: (event: ToolEvent, context: ExecutionToolContext) => void | Promise<void>
  now?: () => string
}

class LedgerToolEventSink implements ToolEventSink {
  readonly #context: ExecutionToolContext
  readonly #onEvent: RalphExecutionToolPortOptions["onEvent"]

  constructor(context: ExecutionToolContext, onEvent: RalphExecutionToolPortOptions["onEvent"]) {
    this.#context = context
    this.#onEvent = onEvent
  }

  async emit(event: ToolEvent): Promise<void> {
    await this.#context.emit({
      type: event.type,
      level:
        event.level === "warn"
          ? "warning"
          : event.level === "error"
            ? "error"
            : event.level === "debug" || event.level === "trace"
              ? "debug"
              : "info",
      payload: { ...event.payload, source: "tool-host", toolCallId: event.toolCallId },
    })
    await this.#onEvent?.(event, this.#context)
  }
}

/** Concrete, command-composed bridge from provider tool requests to ToolHost. */
export class RalphExecutionToolPort implements ExecutionToolPort {
  readonly #registry: ToolRegistry
  readonly #prompt: PermissionPromptPort | undefined
  readonly #processSupervisorFactory: (context: ExecutionToolContext) => ProcessSupervisor
  readonly #artifactPublisherFactory: (context: ExecutionToolContext) => ArtifactPublisherPort
  readonly #onEvent: RalphExecutionToolPortOptions["onEvent"]
  readonly #now: () => string
  readonly #compositions = new Map<
    string,
    { host: ToolHost; secretValues: readonly string[]; initialToolCallsUsed: number }
  >()

  constructor(options: RalphExecutionToolPortOptions = {}) {
    this.#registry = options.registry ?? createBuiltinToolRegistry()
    this.#prompt = options.prompt
    this.#processSupervisorFactory =
      options.processSupervisorFactory ??
      ((context) =>
        context.processSupervisor ??
        createWorkspaceBunProcessSupervisor({
          workspaceRoot: context.controlRoot ?? context.workspaceRoot,
          runId: context.runId,
          secretValues: secretValuesFromEnvironment({ ...context.environment }),
          persistRawOutput: rawPersistenceEnabled(context.telemetry),
          retention: resolveDiagnosticRawRetention(context.telemetry),
        }))
    this.#artifactPublisherFactory =
      options.artifactPublisherFactory ??
      ((context) =>
        new WorkspaceArtifactPublisher({
          workspaceRoot: context.workspaceRoot,
          ...(context.controlRoot ? { controlRoot: context.controlRoot } : {}),
          runId: context.runId,
        }))
    this.#onEvent = options.onEvent
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async reconcile(
    context: ExecutionToolReconciliationContext,
  ): Promise<readonly ToolReconciliationResult[]> {
    if (context.signal?.aborted) {
      throw context.signal.reason ?? new Error("Tool reconciliation was cancelled")
    }
    const layout = workspaceLayout(context.controlRoot ?? context.workspaceRoot)
    const workspace = await inspectWorkspace(layout.root, { exact: true })
    if (!workspace.initialized || !workspace.workspaceId) {
      throw new Error("Tool reconciliation requires an initialized workspace identity")
    }
    const workspaceId = workspace.workspaceId
    const journal = createSqliteToolCallJournal(layout.ledger)
    const query = {
      runId: context.runId,
      documentId: context.documentId,
      taskId: context.taskId,
    }
    if (journal.listUnsettled(query).length === 0) return []
    await context.emit({
      type: "tool.reconciliation.started",
      payload: {
        runId: context.runId,
        documentId: context.documentId,
        taskId: context.taskId,
      },
    })
    const results = await reconcileUnsettledToolCalls({
      journal,
      query,
      probePreconditions: (intent) => probeWorkspaceMutation(intent, context),
      replaySafe: (intent) => this.#replayIntent(intent, context),
      probeProcess: (intent) =>
        probeDurableProcessIntent({
          controlRoot: layout.root,
          workspaceRoot: context.workspaceRoot,
          workspaceId,
          runId: intent.runId,
          documentId: intent.documentId,
          taskId: intent.taskId,
          attemptId: intent.attemptId,
          intentId: intent.id,
          argumentsHash: intent.argumentsHash,
          idempotencyKey: intent.idempotencyKey,
          ...(context.signal ? { signal: context.signal } : {}),
        }),
      reattachProcess: async (intent) => {
        const result = await reattachDurableProcessIntent({
          controlRoot: layout.root,
          workspaceRoot: context.workspaceRoot,
          workspaceId,
          runId: intent.runId,
          documentId: intent.documentId,
          taskId: intent.taskId,
          attemptId: intent.attemptId,
          intentId: intent.id,
          argumentsHash: intent.argumentsHash,
          idempotencyKey: intent.idempotencyKey,
          ...(context.signal ? { signal: context.signal } : {}),
        })
        return replaySettlement(intent, durableProcessToolSettlement(intent, result, this.#now()))
      },
      now: this.#now,
    })
    for (const result of results) {
      await context.emit({
        type: `tool.reconciliation.${result.action}`,
        level: result.action === "paused" ? "warning" : "info",
        payload: {
          intentId: result.intentId,
          strategy: result.strategy,
          automatic: result.automatic,
          reason: result.reason,
          ...(result.settlementOutcome ? { settlementOutcome: result.settlementOutcome } : {}),
        },
      })
    }
    return results
  }

  async materialize(context: ExecutionToolContext): Promise<readonly ProviderToolDefinition[]> {
    const { host, session } = this.#compose(context)
    return (await host.materialize(session)).map(definitionForProvider)
  }

  async execute(
    callInput: ProviderToolCall,
    context: ExecutionToolContext,
  ): Promise<ExecutionToolResult> {
    const call = ProviderToolCallSchema.parse(callInput)
    const { host, session, secretValues } = this.#compose(context)
    const toolCallId = internalToolCallId(context, call)
    const settlement = await host.execute(
      {
        schemaVersion: 1,
        id: toolCallId,
        modelCallId: context.modelCallId,
        providerToolCallId: call.callId,
        name: call.name,
        arguments: structuredClone(call.input),
        idempotencyKey: hashCanonical("ralph.execution-tool-idempotency.v1", {
          attemptId: context.attemptId,
          modelCallId: context.modelCallId,
          providerToolCallId: call.callId,
        }),
        requestedAt: this.#now(),
      },
      session,
    )
    return {
      callId: call.callId,
      outcome: settlement.outcome,
      output: boundedSettlementOutput(settlement, secretValues),
      retryable: settlement.retryable,
      settlementRef: `tool-journal:${toolCallId}`,
    }
  }

  async #replayIntent(
    intent: ToolCallIntentRecord,
    context: ExecutionToolReconciliationContext,
  ): Promise<ToolReplayDecision> {
    if (
      hashCanonical("ralph.tool.arguments.v1", intent.argumentsRedacted) !== intent.argumentsHash
    ) {
      return {
        status: "paused",
        reason: "Redaction prevents exact reconstruction of the original tool arguments",
      }
    }
    const registered = this.#registry.get(intent.tool)
    if (!registered || registered.definition.risk !== intent.risk) {
      return {
        status: "paused",
        reason: "The current registry cannot reproduce the immutable tool contract",
      }
    }
    if (intent.effectClass !== "read-only" && intent.effectClass !== "workspace-write") {
      return {
        status: "paused",
        reason: "Only read-only or hash-proven workspace writes may use automatic replay",
      }
    }

    const executionContext = reconciliationExecutionContext(context, intent)
    const secretValues = secretValuesFromEnvironment({ ...context.environment })
    const replayId = `tool-replay-${hashCanonical("ralph.tool-replay.v1", {
      intentId: intent.id,
      idempotencyKey: intent.idempotencyKey,
    })}`
    try {
      const host = new ToolHost({
        registry: this.#registry,
        journal: new InMemoryToolJournal(),
        process: new SupervisorProcessExecutorAdapter(
          this.#processSupervisorFactory(executionContext),
        ),
        artifacts: this.#artifactPublisherFactory(executionContext),
        events: new LedgerToolEventSink(executionContext, this.#onEvent),
        ...(this.#prompt ? { prompt: this.#prompt } : {}),
        now: this.#now,
      })
      const policy = policyFromContext(executionContext)
      const session: ToolSession = {
        runId: intent.runId,
        documentId: intent.documentId,
        taskId: intent.taskId,
        attemptId: intent.attemptId,
        modelCallId: intent.modelCallId,
        workspaceRoot: context.workspaceRoot,
        policy,
        maximumToolCalls: 1,
        ...(context.signal ? { signal: context.signal } : {}),
        environment: operationalProcessEnvironment(context.environment),
        secretValues,
      }
      const settlement = await host.execute(
        {
          schemaVersion: 1,
          id: replayId,
          modelCallId: intent.modelCallId,
          providerToolCallId: `replay-${intent.providerToolCallId}`,
          name: intent.tool,
          arguments: structuredClone(intent.argumentsRedacted as Record<string, unknown>),
          idempotencyKey: hashCanonical("ralph.tool-replay-idempotency.v1", {
            intentId: intent.id,
            idempotencyKey: intent.idempotencyKey,
          }),
          requestedAt: this.#now(),
        },
        session,
      )
      if (settlement.outcome === "unsettled") {
        return {
          status: "paused",
          reason: "The current-policy replay did not produce a terminal settlement",
        }
      }
      return { status: "settled", settlement: replaySettlement(intent, settlement) }
    } catch {
      return {
        status: "paused",
        reason: "The current-policy replay adapter could not reproduce the call safely",
      }
    }
  }

  #compose(context: ExecutionToolContext): {
    host: ToolHost
    session: ToolSession
    secretValues: readonly string[]
  } {
    const layout = workspaceLayout(context.controlRoot ?? context.workspaceRoot)
    const attempt = getAttempt(layout.ledger, context.attemptId)
    if (!attempt) {
      throw new ToolHostError(
        "RALPH_TOOL_ATTEMPT_NOT_FOUND",
        `Attempt record not found for tool session: ${context.attemptId}`,
      )
    }
    if (
      attempt.runId !== context.runId ||
      attempt.documentId !== context.documentId ||
      attempt.taskId !== context.taskId
    ) {
      throw new ToolHostError(
        "RALPH_TOOL_ATTEMPT_SCOPE_MISMATCH",
        "Execution tool context does not match the durable attempt scope",
        "denied",
        "manual-review",
      )
    }
    const compositionKey = hashCanonical("ralph.execution-tool-composition.v1", {
      workspaceRoot: resolve(context.workspaceRoot),
      runId: context.runId,
      documentId: context.documentId,
      taskId: context.taskId,
      attemptId: context.attemptId,
      modelCallId: context.modelCallId,
    })
    let composition = this.#compositions.get(compositionKey)
    if (!composition) {
      const secretValues = secretValuesFromEnvironment({ ...context.environment })
      const journal = new DurableToolJournal({
        journal: createSqliteToolCallJournal(layout.ledger),
        scope: {
          runId: context.runId,
          documentId: context.documentId,
          taskId: context.taskId,
          attemptId: context.attemptId,
        },
        initialToolCallsUsed: attempt.counters.toolCalls,
        secretValues,
        preconditionRefs: (record) => captureWorkspaceMutationRefs(record, context),
      })
      const events = new LedgerToolEventSink(context, this.#onEvent)
      const host = new ToolHost({
        registry: this.#registry,
        journal,
        process: new SupervisorProcessExecutorAdapter(this.#processSupervisorFactory(context)),
        artifacts: this.#artifactPublisherFactory(context),
        events,
        ...(this.#prompt ? { prompt: this.#prompt } : {}),
        now: this.#now,
      })
      composition = {
        host,
        secretValues,
        initialToolCallsUsed: attempt.counters.toolCalls,
      }
      this.#compositions.set(compositionKey, composition)
      // A CLI process can execute many tasks, but completed model-call hosts do
      // not need to accumulate without bound. Active parallel calls remain far
      // below this conservative cap in the current scheduler.
      if (this.#compositions.size > 256) {
        const oldest = this.#compositions.keys().next().value
        if (oldest !== undefined && oldest !== compositionKey) this.#compositions.delete(oldest)
      }
    }
    const maximumToolCalls = composition.initialToolCallsUsed + context.maximumToolCalls
    if (!Number.isSafeInteger(maximumToolCalls)) {
      throw new ToolHostError(
        "RALPH_TOOL_BUDGET_INVALID",
        "Combined durable and per-model tool-call budget is not a safe integer",
        "invalid",
        "effect-absent",
      )
    }
    const session: ToolSession = {
      runId: context.runId,
      documentId: context.documentId,
      taskId: context.taskId,
      attemptId: context.attemptId,
      modelCallId: context.modelCallId,
      workspaceRoot: context.workspaceRoot,
      policy: policyFromContext(context),
      // DurableToolJournal starts from the attempt-wide persisted counter;
      // adding the current per-model allowance preserves the intended fresh
      // budget while ToolHost still enforces every reservation atomically.
      maximumToolCalls,
      ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
      // Model-facing tools receive only the command-owned operational subset.
      // Arbitrary environment references are intentionally absent from the
      // process.exec schema, so provider credentials and runtime injection
      // variables cannot be selected by model output.
      environment: operationalProcessEnvironment(context.environment),
      secretValues: composition.secretValues,
    }
    return {
      host: composition.host,
      session,
      secretValues: composition.secretValues,
    }
  }
}

export function createRalphExecutionToolPort(
  options: RalphExecutionToolPortOptions = {},
): ExecutionToolPort {
  return new RalphExecutionToolPort(options)
}
