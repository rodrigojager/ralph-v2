import { isAbsolute, posix, win32 } from "node:path"
import {
  CommandSpecSchema,
  CommandVerificationWrapperSchema,
  type EvidenceMode,
  EvidenceModeSchema,
  type ExecutableVerificationSpec,
  GitExpectationSchema,
  JsonValueSchema,
  type MarkdownContent,
  PluginGateIdSchema,
  PrdSlugSchema,
  type TaskBudget,
  type VerificationSpec,
  VerificationSpecSchema,
} from "./contracts"
import { parseMarkdownFragment } from "./markdown"

export class PrdLeafError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(code: string, message: string, hint?: string) {
    super(message)
    this.name = "PrdLeafError"
    this.code = code
    this.hint = hint
  }
}

function leafError(code: string, message: string, hint?: string): never {
  throw new PrdLeafError(code, message, hint)
}

export function parseSlug(value: string, field: string): string {
  const normalized = value.trim()
  const parsed = PrdSlugSchema.safeParse(normalized)
  if (!parsed.success) {
    return leafError(
      "RALPH_PRD_SLUG_INVALID",
      `${field} must be a lowercase kebab-case slug: ${normalized || "<empty>"}`,
      "Use lowercase letters, digits and single hyphens; start with a letter.",
    )
  }
  return parsed.data
}

function parsePluginGateId(value: string): string {
  const normalized = value.trim()
  const parsed = PluginGateIdSchema.safeParse(normalized)
  if (!parsed.success) {
    return leafError(
      "RALPH_PRD_PLUGIN_ID_INVALID",
      `Plugin ID must be lowercase kebab-case, optionally namespace-qualified with /: ${normalized || "<empty>"}`,
    )
  }
  return parsed.data
}

export function isExplicitNone(value: string): boolean {
  return ["nenhum", "nenhuma", "none"].includes(value.trim().toLocaleLowerCase("und"))
}

export function parseEvidenceMode(value: string): EvidenceMode {
  const normalized = value.trim().toLocaleLowerCase("und")
  const parsed = EvidenceModeSchema.safeParse(normalized)
  if (!parsed.success) {
    return leafError(
      "RALPH_PRD_EVIDENCE_MODE_INVALID",
      `Unknown evidence mode: ${value}`,
      "Use criteria, change-only, artifact, criteria+artifact or change+artifact.",
    )
  }
  return parsed.data
}

function hasWindowsDrive(value: string): boolean {
  return /^[a-zA-Z]:/.test(value) || value.startsWith("\\\\")
}

export function parseRelativePath(
  value: string,
  field: string,
  options: { allowParent?: boolean; allowDot?: boolean } = {},
): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes("\0")) {
    return leafError("RALPH_PRD_PATH_INVALID", `${field} must be a non-empty relative path`)
  }
  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed) || hasWindowsDrive(trimmed)) {
    return leafError(
      "RALPH_PRD_PATH_ABSOLUTE",
      `${field} must be relative: ${trimmed}`,
      "Store paths relative to the workspace or PRD document.",
    )
  }
  const normalized = posix.normalize(trimmed.replaceAll("\\", "/"))
  if (normalized === "." && !options.allowDot) {
    return leafError("RALPH_PRD_PATH_INVALID", `${field} cannot resolve to the current directory`)
  }
  if (!options.allowParent && (normalized === ".." || normalized.startsWith("../"))) {
    return leafError(
      "RALPH_PRD_PATH_ESCAPE",
      `${field} escapes its allowed root: ${trimmed}`,
      "Use a path contained by the workspace/PRD root.",
    )
  }
  return normalized
}

export function parseDependencies(value: string): string[] {
  if (isExplicitNone(value)) return []
  const tokens = value.split(",").map((token) => token.trim())
  if (tokens.some((token) => token.length === 0)) {
    return leafError(
      "RALPH_PRD_DEPENDENCIES_AMBIGUOUS",
      "Dependencies contain an empty item",
      "Use comma-separated task IDs or the explicit value `nenhuma`/`none`.",
    )
  }
  const dependencies = tokens.map((token) => parseSlug(token, "Dependency"))
  if (new Set(dependencies).size !== dependencies.length) {
    return leafError("RALPH_PRD_DEPENDENCY_DUPLICATED", "A dependency is listed more than once")
  }
  return dependencies
}

const DURATION_FACTORS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

export function parseDuration(value: string): { source: string; milliseconds: number } {
  const normalized = value.trim().toLocaleLowerCase("und")
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(normalized)
  if (!match) {
    return leafError(
      "RALPH_PRD_DURATION_INVALID",
      `Invalid duration: ${value}`,
      "Use a non-negative number followed by ms, s, m, h or d (for example 90s).",
    )
  }
  const amount = Number(match[1])
  const factor = DURATION_FACTORS[match[2] ?? ""]
  const milliseconds = factor === undefined ? Number.NaN : amount * factor
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return leafError(
      "RALPH_PRD_DURATION_RANGE",
      `Duration is outside the supported range: ${value}`,
    )
  }
  return { source: normalized, milliseconds }
}

function positiveInteger(value: string, field: string, allowZero = false): number {
  if (!/^\d+$/.test(value.trim())) {
    return leafError("RALPH_PRD_BUDGET_VALUE_INVALID", `${field} must be an integer: ${value}`)
  }
  const parsed = Number(value)
  const minimum = allowZero ? 0 : 1
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    return leafError(
      "RALPH_PRD_BUDGET_VALUE_RANGE",
      `${field} must be ${allowZero ? "non-negative" : "positive"}: ${value}`,
    )
  }
  return parsed
}

const BUDGET_KEYS = new Map<string, keyof TaskBudget>([
  ["model_calls", "maxModelCallsPerAttempt"],
  ["max_model_calls", "maxModelCallsPerAttempt"],
  ["chamadas_modelo", "maxModelCallsPerAttempt"],
  ["tool_calls", "maxToolCallsPerModelCall"],
  ["max_tool_calls", "maxToolCallsPerModelCall"],
  ["chamadas_ferramenta", "maxToolCallsPerModelCall"],
  ["input_tokens", "maxInputTokens"],
  ["output_tokens", "maxOutputTokens"],
  ["reasoning_tokens", "maxReasoningTokens"],
  ["tokens", "maxTotalTokens"],
  ["max_tokens", "maxTotalTokens"],
  ["total_tokens", "maxTotalTokens"],
  ["cost", "maxCost"],
  ["custo", "maxCost"],
  ["max_cost", "maxCost"],
  ["time", "taskTimeout"],
  ["tempo", "taskTimeout"],
  ["timeout", "taskTimeout"],
  ["revisions", "maxRevisionAttempts"],
  ["revisões", "maxRevisionAttempts"],
  ["max_revisions", "maxRevisionAttempts"],
])

function assignments(value: string, field: string): Array<[string, string]> {
  const pieces = value
    .split(/[;,]/)
    .map((piece) => piece.trim())
    .filter(Boolean)
  if (pieces.length === 0) {
    return leafError(`RALPH_PRD_${field.toUpperCase()}_EMPTY`, `${field} cannot be empty`)
  }
  return pieces.map((piece) => {
    const separator = piece.indexOf("=")
    if (separator <= 0 || separator === piece.length - 1) {
      return leafError(
        `RALPH_PRD_${field.toUpperCase()}_AMBIGUOUS`,
        `${field} entries must use key=value: ${piece}`,
      )
    }
    return [
      piece.slice(0, separator).trim().toLocaleLowerCase("und"),
      piece.slice(separator + 1).trim(),
    ]
  })
}

export function parseBudget(value: string): TaskBudget | undefined {
  if (isExplicitNone(value)) return undefined
  const output: TaskBudget = {}
  const seen = new Set<keyof TaskBudget>()
  for (const [rawKey, rawValue] of assignments(value, "budget")) {
    const key = BUDGET_KEYS.get(rawKey)
    if (!key) {
      return leafError(
        "RALPH_PRD_BUDGET_KEY_UNKNOWN",
        `Unknown budget key: ${rawKey}`,
        "Use model_calls, tool_calls, tokens, timeout or revisions (PT aliases are accepted).",
      )
    }
    if (seen.has(key)) {
      return leafError("RALPH_PRD_BUDGET_KEY_DUPLICATED", `Budget key is duplicated: ${rawKey}`)
    }
    seen.add(key)
    if (key === "taskTimeout") {
      const duration = parseDuration(rawValue)
      if (duration.milliseconds === 0) {
        return leafError("RALPH_PRD_BUDGET_VALUE_RANGE", "Task timeout must be greater than zero")
      }
      output.taskTimeout = duration
    } else if (key === "maxCost") {
      const match = /^(\d+(?:\.\d+)?)\s+([A-Za-z]{3})$/.exec(rawValue)
      const amount = match ? Number(match[1]) : Number.NaN
      if (!match || !Number.isFinite(amount) || amount < 0) {
        return leafError(
          "RALPH_PRD_BUDGET_COST_SYNTAX",
          `Invalid cost budget: ${rawValue}`,
          "Use a non-negative amount and ISO currency, for example `2.50 USD`.",
        )
      }
      output.maxCost = { amount, currency: (match[2] ?? "").toUpperCase() }
    } else output[key] = positiveInteger(rawValue, rawKey, true)
  }
  return output
}

export function parseProfiles(value: string): { executor?: string; judge?: string } | undefined {
  if (isExplicitNone(value)) return undefined
  const output: { executor?: string; judge?: string } = {}
  const seen = new Set<"executor" | "judge">()
  for (const [rawKey, rawValue] of assignments(value, "profiles")) {
    const key =
      rawKey === "executor"
        ? "executor"
        : rawKey === "judge" || rawKey === "juiz"
          ? "judge"
          : undefined
    if (!key) {
      return leafError(
        "RALPH_PRD_PROFILE_KEY_UNKNOWN",
        `Unknown profile role: ${rawKey}`,
        "Use executor=<profile> and/or judge=<profile> (juiz is accepted).",
      )
    }
    if (seen.has(key)) {
      return leafError("RALPH_PRD_PROFILE_KEY_DUPLICATED", `Profile role is duplicated: ${rawKey}`)
    }
    seen.add(key)
    output[key] = parseSlug(rawValue, `${key} profile`)
  }
  return output
}

function removeSingleCodePair(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("`") && trimmed.endsWith("`") && !trimmed.slice(1, -1).includes("`")) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseFileExpectation(
  value: string,
): Extract<VerificationSpec, { type: "file" }>["expectation"] {
  const normalized = value.trim().toLocaleLowerCase("und")
  if (["exists", "existe"].includes(normalized)) return { kind: "exists" }
  if (["non-empty", "não-vazio", "nao-vazio"].includes(normalized)) {
    return { kind: "non-empty" }
  }
  if (["absent", "ausente"].includes(normalized)) return { kind: "absent" }
  if (normalized.startsWith("sha256=")) {
    const hash = normalized.slice("sha256=".length)
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      return leafError("RALPH_PRD_FILE_HASH_INVALID", `Invalid SHA-256 expectation: ${value}`)
    }
    return { kind: "sha256", value: hash }
  }
  if (normalized.startsWith("schema=")) {
    return {
      kind: "json-schema",
      schema: parseRelativePath(value.slice(value.indexOf("=") + 1), "Verification schema"),
    }
  }
  return leafError(
    "RALPH_PRD_FILE_EXPECTATION_INVALID",
    `Unknown file expectation: ${value}`,
    "Use exists, non-empty, absent, sha256=<hash> or schema=<relative-path>.",
  )
}

function verificationBody(content: MarkdownContent): {
  kind: string | undefined
  body: string
} {
  const markdown = content.markdown.trim()
  const separator = markdown.indexOf(":")
  if (separator <= 0) return { kind: undefined, body: markdown }
  const candidate = markdown.slice(0, separator).trim().toLocaleLowerCase("und")
  const aliases = new Map([
    ["instruction", "instruction"],
    ["instrução", "instruction"],
    ["instrucao", "instruction"],
    ["command", "command"],
    ["comando", "command"],
    ["file", "file"],
    ["arquivo", "file"],
    ["artifact", "artifact"],
    ["artefato", "artifact"],
    ["schema", "schema"],
    ["git", "git"],
    ["plugin", "plugin"],
    ["gate", "gate"],
  ])
  const kind = aliases.get(candidate)
  return kind
    ? { kind, body: markdown.slice(separator + 1).trim() }
    : { kind: undefined, body: markdown }
}

function normalizedApplicability(
  specification: ExecutableVerificationSpec,
): ExecutableVerificationSpec["applicability"] {
  if (!specification.applicability) return undefined
  return {
    ...specification.applicability,
    ...(specification.applicability.conditions
      ? {
          conditions: specification.applicability.conditions.map((condition) => ({
            ...condition,
            path: parseRelativePath(condition.path, "Verification applicability path", {
              allowDot: condition.kind === "path-changed",
            }),
          })),
        }
      : {}),
  }
}

function normalizeVerificationPaths(specification: VerificationSpec): VerificationSpec {
  if (specification.type === "instruction") return specification
  const applicability = normalizedApplicability(specification)
  if (specification.type === "command") {
    const cwd = specification.command.cwd
      ? parseRelativePath(specification.command.cwd, "Command cwd", { allowDot: true })
      : undefined
    return VerificationSpecSchema.parse({
      ...specification,
      ...(applicability ? { applicability } : {}),
      type: "command",
      command: { ...specification.command, ...(cwd ? { cwd } : {}) },
    })
  }
  if (specification.type === "file") {
    return VerificationSpecSchema.parse({
      ...specification,
      ...(applicability ? { applicability } : {}),
      type: "file",
      path: parseRelativePath(specification.path, "Verification file"),
      expectation:
        specification.expectation.kind === "json-schema"
          ? {
              ...specification.expectation,
              schema: parseRelativePath(specification.expectation.schema, "Verification schema"),
            }
          : specification.expectation,
    })
  }
  if (specification.type === "schema") {
    return VerificationSpecSchema.parse({
      ...specification,
      ...(applicability ? { applicability } : {}),
      type: "schema",
      path: parseRelativePath(specification.path, "Schema target"),
      schema: parseRelativePath(specification.schema, "Verification schema"),
    })
  }
  if (specification.type === "artifact") {
    return VerificationSpecSchema.parse({
      ...specification,
      ...(applicability ? { applicability } : {}),
      type: "artifact",
      path: parseRelativePath(specification.path, "Artifact path"),
      ...(specification.schema
        ? { schema: parseRelativePath(specification.schema, "Artifact schema") }
        : {}),
    })
  }
  if (specification.type === "git" && specification.expectation.kind === "paths-within") {
    return VerificationSpecSchema.parse({
      ...specification,
      ...(applicability ? { applicability } : {}),
      type: "git",
      expectation: {
        ...specification.expectation,
        paths: specification.expectation.paths.map((path) =>
          parseRelativePath(path, "Git allowed path", { allowDot: true }),
        ),
      },
    })
  }
  return VerificationSpecSchema.parse({
    ...specification,
    ...(applicability ? { applicability } : {}),
  })
}

function parseStructuredGate(body: string, id: string): VerificationSpec {
  let candidate: unknown
  try {
    candidate = JSON.parse(body)
  } catch {
    return leafError(
      "RALPH_PRD_GATE_SPEC_INVALID",
      "Structured gate verification must contain a JSON object",
    )
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return leafError("RALPH_PRD_GATE_SPEC_INVALID", "Structured gate must be a JSON object")
  }
  if (Object.hasOwn(candidate, "id")) {
    return leafError(
      "RALPH_PRD_GATE_ID_FORBIDDEN",
      "Structured gate IDs are derived from task position and cannot be declared inline",
    )
  }
  const parsed = VerificationSpecSchema.safeParse({ ...candidate, id })
  if (!parsed.success) {
    return leafError(
      "RALPH_PRD_GATE_SPEC_INVALID",
      `Structured gate is invalid: ${parsed.error.issues[0]?.message ?? "invalid value"}`,
    )
  }
  return normalizeVerificationPaths(parsed.data)
}

export function parseVerification(
  content: MarkdownContent,
  taskId: string,
  ordinal: number,
): VerificationSpec {
  const id = `${taskId}:verification:${ordinal}`
  const { kind, body } = verificationBody(content)
  if (!body) {
    return leafError("RALPH_PRD_VERIFICATION_EMPTY", "Verification entries cannot be empty")
  }
  if (kind === undefined || kind === "instruction") {
    return {
      type: "instruction",
      id,
      text: kind === undefined ? content : parseMarkdownFragment(body),
      category: "instruction",
      skipPolicy: "never-run",
      blocking: false,
    }
  }
  if (kind === "gate") return parseStructuredGate(body, id)
  if (kind === "command") {
    let candidate: unknown
    try {
      candidate = JSON.parse(body)
    } catch {
      return leafError(
        "RALPH_PRD_COMMAND_SPEC_INVALID",
        "Command verification must contain a structured JSON CommandSpec",
        "Use an object with executable, args, timeoutMs, successExitCodes and outputLimitBytes.",
      )
    }
    const isWrapper =
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      Object.hasOwn(candidate, "command")
    const parsed = isWrapper
      ? CommandVerificationWrapperSchema.safeParse(candidate)
      : CommandSpecSchema.safeParse(candidate)
    if (!parsed.success) {
      return leafError(
        "RALPH_PRD_COMMAND_SPEC_INVALID",
        `Command verification is invalid: ${parsed.error.issues[0]?.message ?? "invalid value"}`,
        "Use a direct CommandSpec or an explicit {command, category, skipPolicy, blocking} wrapper.",
      )
    }
    const command = isWrapper
      ? (parsed.data as ReturnType<typeof CommandVerificationWrapperSchema.parse>).command
      : (parsed.data as ReturnType<typeof CommandSpecSchema.parse>)
    const cwd = command.cwd
      ? parseRelativePath(command.cwd, "Command cwd", { allowDot: true })
      : undefined
    const wrapper = isWrapper
      ? (parsed.data as ReturnType<typeof CommandVerificationWrapperSchema.parse>)
      : undefined
    return normalizeVerificationPaths({
      type: "command",
      id,
      command: { ...command, ...(cwd ? { cwd } : {}) },
      category: wrapper?.category ?? "command",
      skipPolicy: wrapper?.skipPolicy ?? "required",
      blocking: wrapper?.blocking ?? true,
      ...(wrapper?.attempts ? { attempts: wrapper.attempts } : {}),
      ...(wrapper?.timeoutMs ? { timeoutMs: wrapper.timeoutMs } : {}),
      ...(wrapper?.applicability ? { applicability: wrapper.applicability } : {}),
      ...(wrapper?.criterionIds ? { criterionIds: wrapper.criterionIds } : {}),
    })
  }
  if (kind === "file") {
    const [pathValue, expectationValue, ...extra] = body.split(";").map((part) => part.trim())
    if (!pathValue || !expectationValue || extra.length > 0) {
      return leafError(
        "RALPH_PRD_FILE_VERIFICATION_AMBIGUOUS",
        `File verification must be 'file: <path>; <expectation>': ${body}`,
      )
    }
    return {
      type: "file",
      id,
      path: parseRelativePath(removeSingleCodePair(pathValue), "Verification file"),
      expectation: parseFileExpectation(expectationValue),
      category: "file",
      skipPolicy: "required",
      blocking: true,
    }
  }
  if (kind === "schema") {
    const [pathValue, ...rawAssignments] = body.split(";").map((part) => part.trim())
    if (!pathValue || rawAssignments.length !== 1) {
      return leafError(
        "RALPH_PRD_SCHEMA_VERIFICATION_AMBIGUOUS",
        "Schema verification must be 'schema: <path>; schema=<relative-schema-path>'",
      )
    }
    const values = assignments(rawAssignments[0] ?? "", "schema verification")
    if (values.length !== 1 || values[0]?.[0] !== "schema") {
      return leafError(
        "RALPH_PRD_SCHEMA_VERIFICATION_AMBIGUOUS",
        "Schema verification requires exactly one schema=<relative-schema-path> assignment",
      )
    }
    return {
      type: "schema",
      id,
      path: parseRelativePath(removeSingleCodePair(pathValue), "Schema target"),
      schema: parseRelativePath(removeSingleCodePair(values[0][1]), "Verification schema"),
      category: "schema",
      skipPolicy: "required",
      blocking: true,
    }
  }
  if (kind === "git") {
    const normalized = body.trim().toLocaleLowerCase("und")
    let expectation: ReturnType<typeof GitExpectationSchema.parse>
    if (["clean", "changed", "no-conflicts"].includes(normalized)) {
      expectation = GitExpectationSchema.parse({ kind: normalized })
    } else if (normalized.startsWith("branch=")) {
      expectation = GitExpectationSchema.parse({
        kind: "branch",
        value: body.slice(body.indexOf("=") + 1).trim(),
      })
    } else {
      let candidate: unknown
      try {
        candidate = JSON.parse(body)
      } catch {
        return leafError(
          "RALPH_PRD_GIT_EXPECTATION_INVALID",
          "Git verification must use clean, changed, no-conflicts, branch=<name> or a structured GitExpectation JSON object",
        )
      }
      const parsed = GitExpectationSchema.safeParse(candidate)
      if (!parsed.success) {
        return leafError(
          "RALPH_PRD_GIT_EXPECTATION_INVALID",
          `Git expectation is invalid: ${parsed.error.issues[0]?.message ?? "invalid value"}`,
        )
      }
      expectation = parsed.data
    }
    return normalizeVerificationPaths({
      type: "git",
      id,
      expectation,
      category: "git",
      skipPolicy: "required",
      blocking: true,
    })
  }
  if (kind === "artifact") {
    const [rawId, ...rawAssignments] = body.split(";").map((part) => part.trim())
    if (!rawId || rawAssignments.length === 0) {
      return leafError(
        "RALPH_PRD_ARTIFACT_VERIFICATION_AMBIGUOUS",
        "Artifact verification requires an ID and path=<relative-path>",
      )
    }
    let path: string | undefined
    let schema: string | undefined
    let expectedSha256: string | undefined
    for (const [key, value] of assignments(rawAssignments.join(";"), "artifact")) {
      if (key === "path" || key === "caminho") {
        if (path)
          return leafError("RALPH_PRD_ARTIFACT_PATH_DUPLICATED", "Artifact path is duplicated")
        path = parseRelativePath(removeSingleCodePair(value), "Artifact path")
      } else if (key === "schema") {
        if (schema)
          return leafError("RALPH_PRD_ARTIFACT_SCHEMA_DUPLICATED", "Artifact schema is duplicated")
        schema = parseRelativePath(removeSingleCodePair(value), "Artifact schema")
      } else if (key === "sha256" || key === "hash") {
        if (expectedSha256) {
          return leafError("RALPH_PRD_ARTIFACT_HASH_DUPLICATED", "Artifact hash is duplicated")
        }
        const normalized = value.trim().toLocaleLowerCase("und")
        if (!/^[a-f0-9]{64}$/.test(normalized)) {
          return leafError("RALPH_PRD_ARTIFACT_HASH_INVALID", "Artifact SHA-256 is invalid")
        }
        expectedSha256 = normalized
      } else {
        return leafError("RALPH_PRD_ARTIFACT_KEY_UNKNOWN", `Unknown artifact key: ${key}`)
      }
    }
    if (!path) {
      return leafError(
        "RALPH_PRD_ARTIFACT_PATH_MISSING",
        "Artifact verification requires path=<path>",
      )
    }
    return {
      type: "artifact",
      id,
      artifactId: parseSlug(rawId, "Artifact ID"),
      path,
      ...(schema ? { schema } : {}),
      ...(expectedSha256 ? { expectedSha256 } : {}),
      category: "artifact",
      skipPolicy: "required",
      blocking: true,
    }
  }
  const separator = body.indexOf(";")
  const plugin = separator < 0 ? "" : body.slice(0, separator).trim()
  const inputText = separator < 0 ? "" : body.slice(separator + 1).trim()
  if (!plugin || !inputText) {
    return leafError(
      "RALPH_PRD_PLUGIN_VERIFICATION_AMBIGUOUS",
      "Plugin verification must be 'plugin: <plugin-id>; <JSON input>'",
    )
  }
  let input: unknown
  try {
    input = JSON.parse(inputText)
  } catch {
    return leafError("RALPH_PRD_PLUGIN_INPUT_INVALID", "Plugin verification input must be JSON")
  }
  const parsedInput = JsonValueSchema.safeParse(input)
  if (!parsedInput.success) {
    return leafError("RALPH_PRD_PLUGIN_INPUT_INVALID", "Plugin input must be a JSON value")
  }
  return {
    type: "plugin",
    id,
    plugin: parsePluginGateId(plugin),
    input: parsedInput.data,
    category: "plugin",
    skipPolicy: "required",
    blocking: true,
  }
}
