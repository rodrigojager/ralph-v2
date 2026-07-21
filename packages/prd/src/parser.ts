import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Diagnostic } from "@ralph/domain"
import type { List, ListItem, Paragraph, RootContent } from "mdast"
import { LineCounter, parseDocument } from "yaml"
import { type ZodIssue, z } from "zod"
import {
  EvidenceModeSchema,
  type ExecutableVerificationSpec,
  type JsonValue,
  JsonValueSchema,
  type MarkdownContent,
  type PrdDocument,
  PrdDocumentSchema,
  type PrdParseResult,
  type PrdTask,
  type TaskBudget,
  type TaskDefaults,
  type TaskSourceLocation,
} from "./contracts"
import { computePrdDefinitionHash, computeTaskSpecHash } from "./identity"
import {
  isExplicitNone,
  PrdLeafError,
  parseBudget,
  parseDependencies,
  parseEvidenceMode,
  parseProfiles,
  parseRelativePath,
  parseSlug,
  parseVerification,
} from "./leaf"
import { markdownNodeText, parseMarkdown, parseMarkdownFragment } from "./markdown"

type SourcePosition = {
  line: number
  column: number
  charOffset: number
}

type RawBudget = {
  max_model_calls?: number | undefined
  max_tool_calls?: number | undefined
  max_input_tokens?: number | undefined
  max_output_tokens?: number | undefined
  max_reasoning_tokens?: number | undefined
  max_tokens?: number | undefined
  max_cost?: { amount: number; currency: string } | undefined
  timeout?: string | undefined
  max_revisions?: number | undefined
}

type RawDefaults = {
  executor_profile?: string | undefined
  judge_profile?: string | undefined
  evidence_mode?: string | undefined
  budget?: RawBudget | undefined
}

type RawFrontmatter = {
  ralph_prd: 2
  id: string
  title: string
  kind: "root" | "child"
  parent?: { prd: string; task: string } | undefined
  workspace: string
  defaults: RawDefaults
  metadata?: Record<string, JsonValue> | undefined
}

type FrontmatterRead = {
  data: RawFrontmatter
  declaredDefaults: TaskDefaults
  bodyStartChar: number
  bodyStartLine: number
}

type FieldKey =
  | "result"
  | "dependencies"
  | "criteria"
  | "verification"
  | "boundaries"
  | "evidenceMode"
  | "subPrd"
  | "parallelGroup"
  | "profiles"
  | "budget"
  | "notes"

type ParsedField = {
  key: FieldKey
  position: SourcePosition
  inline: string
  entries: MarkdownContent[]
}

export type ParsedPrdInternal = {
  document: PrdDocument
  source: string
  bytes: Uint8Array
  declaredDefaults: TaskDefaults
  sectionListStartChar: number
  sectionListEndChar: number
}

export type ParsePrdOptions = {
  file: string
  inheritedDefaults?: TaskDefaults
}

class DiagnosticCollector {
  readonly diagnostics: Diagnostic[] = []
  readonly file: string

  constructor(file: string) {
    this.file = file
  }

  add(
    code: string,
    message: string,
    options: {
      severity?: Diagnostic["severity"]
      position?: Pick<SourcePosition, "line" | "column">
      hint?: string
      details?: Record<string, unknown>
    } = {},
  ): void {
    this.diagnostics.push({
      code,
      severity: options.severity ?? "error",
      message,
      file: this.file,
      ...(options.position ? { line: options.position.line, column: options.position.column } : {}),
      ...(options.hint ? { hint: options.hint } : {}),
      ...(options.details ? { details: options.details } : {}),
    })
  }

  errorCount(): number {
    return this.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length
  }
}

const RawBudgetSchema = z
  .object({
    max_model_calls: z.number().int().nonnegative().optional(),
    max_tool_calls: z.number().int().nonnegative().optional(),
    max_input_tokens: z.number().int().nonnegative().optional(),
    max_output_tokens: z.number().int().nonnegative().optional(),
    max_reasoning_tokens: z.number().int().nonnegative().optional(),
    max_tokens: z.number().int().nonnegative().optional(),
    max_cost: z
      .object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Za-z]{3}$/) })
      .strict()
      .optional(),
    timeout: z.string().min(1).optional(),
    max_revisions: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((budget) => Object.keys(budget).length > 0, "Budget must contain at least one limit")

const RawDefaultsSchema = z
  .object({
    executor_profile: z.string().min(1).optional(),
    judge_profile: z.string().min(1).optional(),
    evidence_mode: EvidenceModeSchema.optional(),
    budget: RawBudgetSchema.optional(),
  })
  .strict()

const RawFrontmatterSchema = z
  .object({
    ralph_prd: z.literal(2),
    id: z.string().min(1),
    title: z.string().min(1),
    kind: z.enum(["root", "child"]),
    parent: z
      .object({ prd: z.string().min(1), task: z.string().min(1) })
      .strict()
      .optional(),
    workspace: z.string().min(1),
    defaults: RawDefaultsSchema,
    metadata: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "child" && value.parent === undefined) {
      context.addIssue({ code: "custom", path: ["parent"], message: "Child PRDs require parent" })
    }
    if (value.kind === "root" && value.parent !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["parent"],
        message: "Root PRDs cannot declare parent",
      })
    }
  })

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"])

function issuePath(issue: ZodIssue): PropertyKey[] {
  if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
    return [...issue.path, issue.keys[0] ?? ""]
  }
  return issue.path
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function findForbiddenKey(
  value: unknown,
  prefix: readonly PropertyKey[] = [],
): PropertyKey[] | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenKey(value[index], [...prefix, index])
      if (found) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const [key, child] of Object.entries(value)) {
    const path = [...prefix, key]
    if (FORBIDDEN_KEYS.has(key)) return path
    const found = findForbiddenKey(child, path)
    if (found) return found
  }
  return undefined
}

type SourceLine = {
  number: number
  start: number
  contentEnd: number
  end: number
  text: string
  newline: string
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  let number = 1
  while (start < source.length) {
    let cursor = start
    while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") {
      cursor += 1
    }
    const contentEnd = cursor
    let newline = ""
    if (source[cursor] === "\r" && source[cursor + 1] === "\n") {
      newline = "\r\n"
      cursor += 2
    } else if (source[cursor] === "\r" || source[cursor] === "\n") {
      newline = source[cursor] ?? ""
      cursor += 1
    }
    lines.push({
      number,
      start,
      contentEnd,
      end: cursor,
      text: source.slice(start, contentEnd),
      newline,
    })
    start = cursor
    number += 1
  }
  if (source.length === 0 || source.endsWith("\n") || source.endsWith("\r")) {
    lines.push({
      number,
      start: source.length,
      contentEnd: source.length,
      end: source.length,
      text: "",
      newline: "",
    })
  }
  return lines
}

function byteOffset(source: string, charOffset: number): number {
  return Buffer.byteLength(source.slice(0, charOffset), "utf8")
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function absolutePosition(
  bodyStartChar: number,
  bodyStartLine: number,
  point: { line: number; column: number; offset?: number | undefined },
): SourcePosition {
  const charOffset = bodyStartChar + (point.offset ?? 0)
  return {
    line: bodyStartLine + point.line - 1,
    column: point.column,
    charOffset,
  }
}

function publicPoint(
  source: string,
  position: SourcePosition,
): {
  line: number
  column: number
  offset: number
} {
  return {
    line: position.line,
    column: position.column,
    offset: byteOffset(source, position.charOffset),
  }
}

function mergeDefaults(parent: TaskDefaults | undefined, own: TaskDefaults): TaskDefaults {
  return {
    ...(parent ?? {}),
    ...own,
    ...(parent?.budget || own.budget
      ? { budget: { ...(parent?.budget ?? {}), ...(own.budget ?? {}) } }
      : {}),
  }
}

function rawBudgetToTaskBudget(
  raw: RawBudget,
  collector: DiagnosticCollector,
): TaskBudget | undefined {
  const pieces: string[] = []
  if (raw.max_model_calls !== undefined) pieces.push(`model_calls=${raw.max_model_calls}`)
  if (raw.max_tool_calls !== undefined) pieces.push(`tool_calls=${raw.max_tool_calls}`)
  if (raw.max_input_tokens !== undefined) pieces.push(`input_tokens=${raw.max_input_tokens}`)
  if (raw.max_output_tokens !== undefined) pieces.push(`output_tokens=${raw.max_output_tokens}`)
  if (raw.max_reasoning_tokens !== undefined) {
    pieces.push(`reasoning_tokens=${raw.max_reasoning_tokens}`)
  }
  if (raw.max_tokens !== undefined) pieces.push(`tokens=${raw.max_tokens}`)
  if (raw.max_cost !== undefined) {
    pieces.push(`cost=${raw.max_cost.amount} ${raw.max_cost.currency}`)
  }
  if (raw.timeout !== undefined) pieces.push(`timeout=${raw.timeout}`)
  if (raw.max_revisions !== undefined) pieces.push(`revisions=${raw.max_revisions}`)
  try {
    return parseBudget(pieces.join(";"))
  } catch (error) {
    if (error instanceof PrdLeafError) {
      collector.add(error.code, error.message, { ...(error.hint ? { hint: error.hint } : {}) })
      return undefined
    }
    throw error
  }
}

function normalizeDefaults(raw: RawDefaults, collector: DiagnosticCollector): TaskDefaults {
  const defaults: TaskDefaults = {}
  try {
    if (raw.executor_profile !== undefined) {
      defaults.executorProfile = parseSlug(raw.executor_profile, "Default executor profile")
    }
    if (raw.judge_profile !== undefined) {
      defaults.judgeProfile = parseSlug(raw.judge_profile, "Default judge profile")
    }
    if (raw.evidence_mode !== undefined) {
      defaults.evidenceMode = parseEvidenceMode(raw.evidence_mode)
    }
  } catch (error) {
    if (error instanceof PrdLeafError) {
      collector.add(error.code, error.message, { ...(error.hint ? { hint: error.hint } : {}) })
    } else throw error
  }
  if (raw.budget !== undefined) {
    const budget = rawBudgetToTaskBudget(raw.budget, collector)
    if (budget) defaults.budget = budget
  }
  return defaults
}

function readFrontmatter(
  source: string,
  collector: DiagnosticCollector,
): FrontmatterRead | undefined {
  const lines = sourceLines(source)
  const first = lines[0]
  const firstText = first?.text.startsWith("\uFEFF") ? first.text.slice(1) : first?.text
  if (!first || firstText?.trim() !== "---") {
    collector.add("RALPH_PRD_FRONTMATTER_MISSING", "PRD v2 requires YAML frontmatter", {
      position: { line: 1, column: 1 },
      hint: "Start the document with `---` and set `ralph_prd: 2`.",
    })
    return undefined
  }
  const close = lines.slice(1).find((line) => line.text.trim() === "---")
  if (!close) {
    collector.add("RALPH_PRD_FRONTMATTER_UNCLOSED", "YAML frontmatter is not closed", {
      position: { line: 1, column: 1 },
      hint: "Add a closing `---` line before the Markdown body.",
    })
    return undefined
  }
  const yamlStart = first.end
  const yamlText = source.slice(yamlStart, close.start)
  const lineCounter = new LineCounter()
  const document = parseDocument(yamlText, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    schema: "core",
  })
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      const location = error.linePos?.[0]
      collector.add("RALPH_PRD_YAML_INVALID", error.message, {
        position: {
          line: (location?.line ?? 1) + first.number,
          column: location?.col ?? 1,
        },
        hint: "Use safe YAML core values with unique mapping keys.",
      })
    }
    return undefined
  }
  let value: unknown
  try {
    value = document.toJS({ maxAliasCount: 0 })
  } catch (error) {
    collector.add("RALPH_PRD_YAML_ALIAS_FORBIDDEN", "YAML aliases are not permitted in PRDs", {
      position: { line: first.number + 1, column: 1 },
      details: { reason: error instanceof Error ? error.message : String(error) },
    })
    return undefined
  }
  const forbidden = findForbiddenKey(value)
  if (forbidden) {
    const yamlPath = forbidden.filter(
      (segment): segment is string | number =>
        typeof segment === "string" || typeof segment === "number",
    )
    const node = document.getIn(yamlPath, true)
    const offset = yamlNodeOffset(node)
    const position = offset === undefined ? undefined : lineCounter.linePos(offset)
    collector.add("RALPH_PRD_KEY_FORBIDDEN", `Forbidden YAML key: ${forbidden.join(".")}`, {
      ...(position
        ? { position: { line: position.line + first.number, column: position.col } }
        : {}),
    })
    return undefined
  }
  const parsed = RawFrontmatterSchema.safeParse(value)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issuePath(issue)
      const yamlPath = path.filter(
        (segment): segment is string | number =>
          typeof segment === "string" || typeof segment === "number",
      )
      const node = document.getIn(yamlPath, true)
      const offset = yamlNodeOffset(node)
      const located = offset === undefined ? undefined : lineCounter.linePos(offset)
      collector.add("RALPH_PRD_FRONTMATTER_SCHEMA_INVALID", issue.message, {
        ...(located
          ? { position: { line: located.line + first.number, column: located.col } }
          : { position: { line: first.number + 1, column: 1 } }),
        details: { path: path.join(".") },
      })
    }
    return undefined
  }
  const data: RawFrontmatter = parsed.data
  return {
    data,
    declaredDefaults: normalizeDefaults(data.defaults, collector),
    bodyStartChar: close.end,
    bodyStartLine: close.number + (close.newline ? 1 : 0),
  }
}

function validateNewlines(source: string, collector: DiagnosticCollector): void {
  const lines = sourceLines(source)
  const kinds = new Set(lines.map((line) => line.newline).filter(Boolean))
  if (kinds.has("\r")) {
    collector.add("RALPH_PRD_NEWLINE_INVALID", "Lone carriage-return newlines are not supported", {
      hint: "Use LF or CRLF line endings.",
    })
  }
  if (kinds.has("\n") && kinds.has("\r\n")) {
    collector.add("RALPH_PRD_NEWLINE_MIXED", "The PRD mixes LF and CRLF line endings", {
      severity: "warning",
      hint: "Use one newline convention per file for stable human diffs.",
    })
  }
  if (source.startsWith("\uFEFF")) {
    collector.add("RALPH_PRD_UTF8_BOM", "UTF-8 BOM was accepted and included in source hashes", {
      severity: "info",
      position: { line: 1, column: 1 },
    })
  }
}

const FIELD_ALIASES = new Map<string, FieldKey>([
  ["resultado", "result"],
  ["result", "result"],
  ["dependências", "dependencies"],
  ["dependencies", "dependencies"],
  ["critérios", "criteria"],
  ["criteria", "criteria"],
  ["verificação", "verification"],
  ["verification", "verification"],
  ["limites", "boundaries"],
  ["boundaries", "boundaries"],
  ["modo de evidência", "evidenceMode"],
  ["evidence mode", "evidenceMode"],
  ["sub-prd", "subPrd"],
  ["grupo paralelo", "parallelGroup"],
  ["parallel group", "parallelGroup"],
  ["perfis", "profiles"],
  ["profiles", "profiles"],
  ["orçamento", "budget"],
  ["budget", "budget"],
  ["notas", "notes"],
  ["notes", "notes"],
])

function dedentFragment(fragment: string, continuationIndent: number): string {
  const normalized = fragment.replaceAll("\r\n", "\n")
  const lines = normalized.split("\n")
  return lines
    .map((line, index) => {
      if (index === 0 || line.length === 0) return line
      let removed = 0
      while (removed < continuationIndent && line[removed] === " ") removed += 1
      return line.slice(removed)
    })
    .join("\n")
    .trim()
}

function nestedEntryContent(body: string, item: ListItem): MarkdownContent | undefined {
  const first = item.children[0]
  const last = item.children.at(-1)
  const start = first?.position?.start
  const end = last?.position?.end
  if (start?.offset === undefined || end?.offset === undefined) return undefined
  const fragment = body.slice(start.offset, end.offset)
  return parseMarkdownFragment(dedentFragment(fragment, Math.max(0, start.column - 1)))
}

function nodePosition(
  bodyStartChar: number,
  bodyStartLine: number,
  node: RootContent,
): SourcePosition | undefined {
  const point = node.position?.start
  if (!point) return undefined
  return absolutePosition(bodyStartChar, bodyStartLine, point)
}

function parseFieldItem(
  body: string,
  bodyStartChar: number,
  bodyStartLine: number,
  item: ListItem,
  collector: DiagnosticCollector,
): ParsedField | undefined {
  const first = item.children[0]
  const position = nodePosition(bodyStartChar, bodyStartLine, item)
  if (first?.type !== "paragraph" || !first.position || !position) {
    collector.add("RALPH_PRD_FIELD_STRUCTURE_INVALID", "Task fields must start with a paragraph", {
      ...(position ? { position } : {}),
    })
    return undefined
  }
  if (item.children.length > 2) {
    collector.add(
      "RALPH_PRD_FIELD_STRUCTURE_AMBIGUOUS",
      "A task field may contain only its label paragraph and one direct list",
      { position },
    )
    return undefined
  }
  const nested = item.children[1]
  if (nested && nested.type !== "list") {
    collector.add(
      "RALPH_PRD_FIELD_STRUCTURE_AMBIGUOUS",
      "Task field continuation must be a direct list",
      { position },
    )
    return undefined
  }
  const start = first.position.start.offset
  const end = first.position.end.offset
  if (start === undefined || end === undefined) {
    collector.add("RALPH_PRD_SOURCE_POSITION_MISSING", "Markdown parser omitted field positions", {
      position,
    })
    return undefined
  }
  const paragraphSource = body.slice(start, end)
  const colon = paragraphSource.indexOf(":")
  if (colon <= 0) {
    collector.add(
      "RALPH_PRD_FIELD_LABEL_MISSING",
      "Task field must start with a declared PT/EN label followed by a colon",
      { position },
    )
    return undefined
  }
  const rawLabel = paragraphSource.slice(0, colon).trim()
  const key = FIELD_ALIASES.get(rawLabel.toLocaleLowerCase("und"))
  if (!key) {
    collector.add("RALPH_PRD_FIELD_LABEL_UNKNOWN", `Unknown task field label: ${rawLabel}`, {
      position,
      hint: "Use a canonical Portuguese label or its declared English alias.",
    })
    return undefined
  }
  const inline = paragraphSource.slice(colon + 1).trim()
  if (inline && nested) {
    collector.add(
      "RALPH_PRD_FIELD_CONTENT_AMBIGUOUS",
      `${rawLabel} cannot combine inline content with a nested list`,
      { position },
    )
    return undefined
  }
  const entries: MarkdownContent[] = []
  if (nested?.type === "list") {
    for (const child of nested.children) {
      const content = nestedEntryContent(body, child)
      if (!content?.text) {
        collector.add("RALPH_PRD_FIELD_ENTRY_EMPTY", `${rawLabel} contains an empty entry`, {
          position: nodePosition(bodyStartChar, bodyStartLine, child) ?? position,
        })
      } else entries.push(content)
    }
  } else if (inline) {
    const content = parseMarkdownFragment(inline)
    if (content.text) entries.push(content)
  }
  return { key, position, inline, entries }
}

function fieldContent(field: ParsedField | undefined): MarkdownContent | undefined {
  return field?.entries[0]
}

function parseLeafAt<T>(
  field: ParsedField,
  collector: DiagnosticCollector,
  parse: () => T,
): T | undefined {
  try {
    return parse()
  } catch (error) {
    if (error instanceof PrdLeafError) {
      collector.add(error.code, error.message, {
        position: field.position,
        ...(error.hint ? { hint: error.hint } : {}),
      })
      return undefined
    }
    throw error
  }
}

function requireSingleInline(
  field: ParsedField | undefined,
  label: string,
  collector: DiagnosticCollector,
  taskPosition: SourcePosition,
): string | undefined {
  if (!field) {
    collector.add("RALPH_PRD_FIELD_REQUIRED", `Task is missing required field: ${label}`, {
      position: taskPosition,
    })
    return undefined
  }
  if (!field.inline || field.entries.length !== 1) {
    collector.add("RALPH_PRD_FIELD_INLINE_REQUIRED", `${label} requires one inline value`, {
      position: field.position,
    })
    return undefined
  }
  return fieldContent(field)?.text
}

function optionalSingleInline(
  field: ParsedField | undefined,
  label: string,
  collector: DiagnosticCollector,
): string | undefined {
  if (!field) return undefined
  if (!field.inline || field.entries.length !== 1) {
    collector.add("RALPH_PRD_FIELD_INLINE_REQUIRED", `${label} requires one inline value`, {
      position: field.position,
    })
    return undefined
  }
  return fieldContent(field)?.text
}

function parseTaskTitle(
  paragraph: Paragraph,
  position: SourcePosition,
  collector: DiagnosticCollector,
): { id: string; title: string; marker: " " | "~" | "x" } | undefined {
  const [prefix, strong, ...extra] = paragraph.children
  if (
    prefix?.type !== "text" ||
    strong?.type !== "strong" ||
    extra.length > 0 ||
    !/^\[([ ~x])\][ \t]+$/.test(prefix.value)
  ) {
    collector.add(
      "RALPH_PRD_TASK_HEADER_INVALID",
      "Task must start with `[ ]`, `[~]` or `[x]` followed by one strong title",
      {
        position,
        hint: "Use `- [ ] **task-id — Human title**`.",
      },
    )
    return undefined
  }
  const markerMatch = /^\[([ ~x])\]/.exec(prefix.value)
  const marker = markerMatch?.[1]
  if (marker !== " " && marker !== "~" && marker !== "x") return undefined
  const value = markdownNodeText(strong)
  let separator = " — "
  let separatorIndex = value.indexOf(separator)
  if (separatorIndex < 0) {
    separator = " - "
    separatorIndex = value.indexOf(separator)
    if (separatorIndex >= 0) {
      collector.add(
        "RALPH_PRD_TASK_TITLE_NONCANONICAL",
        "A simple hyphen in a v2 task title is accepted but not canonical",
        {
          severity: "warning",
          position,
          hint: "Use an em dash: `task-id — Human title`.",
        },
      )
    }
  }
  if (
    separatorIndex <= 0 ||
    value.indexOf(separator, separatorIndex + separator.length) >= 0 ||
    !value.slice(separatorIndex + separator.length).trim()
  ) {
    collector.add("RALPH_PRD_TASK_TITLE_AMBIGUOUS", `Invalid strong task title: ${value}`, {
      position,
      hint: "Use exactly one separator between the task ID and title.",
    })
    return undefined
  }
  const rawId = value.slice(0, separatorIndex).trim()
  const title = value.slice(separatorIndex + separator.length).trim()
  const id = parseLeafAt({ key: "result", position, inline: rawId, entries: [] }, collector, () =>
    parseSlug(rawId, "Task ID"),
  )
  return id ? { id, title, marker } : undefined
}

function markerStatus(marker: " " | "~" | "x"): PrdTask["status"] {
  if (marker === "~") return "active"
  if (marker === "x") return "completed"
  return "pending"
}

function parseTask(
  source: string,
  body: string,
  bodyStartChar: number,
  bodyStartLine: number,
  file: string,
  documentId: string,
  item: ListItem,
  defaults: TaskDefaults,
  collector: DiagnosticCollector,
): { task: PrdTask; location: TaskSourceLocation } | undefined {
  const position = nodePosition(bodyStartChar, bodyStartLine, item)
  const paragraph = item.children[0]
  if (!position || !paragraph || paragraph.type !== "paragraph") {
    collector.add("RALPH_PRD_TASK_STRUCTURE_INVALID", "Each task must start with a paragraph", {
      ...(position ? { position } : {}),
    })
    return undefined
  }
  const header = parseTaskTitle(paragraph, position, collector)
  if (!header) return undefined
  if (item.children.length !== 2 || item.children[1]?.type !== "list") {
    collector.add(
      "RALPH_PRD_TASK_FIELDS_INVALID",
      `Task ${header.id} must contain one direct list of fields`,
      { position },
    )
    return undefined
  }
  const fields = new Map<FieldKey, ParsedField>()
  for (const fieldItem of item.children[1].children) {
    const field = parseFieldItem(body, bodyStartChar, bodyStartLine, fieldItem, collector)
    if (!field) continue
    if (fields.has(field.key)) {
      collector.add("RALPH_PRD_FIELD_DUPLICATED", `Task field is duplicated: ${field.key}`, {
        position: field.position,
      })
    } else fields.set(field.key, field)
  }

  const resultField = fields.get("result")
  const result = fieldContent(resultField)
  if (!result?.text || resultField?.entries.length !== 1) {
    collector.add("RALPH_PRD_RESULT_REQUIRED", `Task ${header.id} requires a non-empty Result`, {
      position: resultField?.position ?? position,
    })
  }

  const dependenciesField = fields.get("dependencies")
  const dependencyText = requireSingleInline(
    dependenciesField,
    "Dependências/Dependencies",
    collector,
    position,
  )
  const dependencies =
    dependenciesField && dependencyText !== undefined
      ? parseLeafAt(dependenciesField, collector, () => parseDependencies(dependencyText))
      : undefined

  const criteria = (fields.get("criteria")?.entries ?? []).map((text, index) => ({
    id: `c${index + 1}`,
    text,
  }))

  const verificationField = fields.get("verification")
  const verification = verificationField
    ? verificationField.entries.flatMap((content, index) => {
        const parsed = parseLeafAt(verificationField, collector, () =>
          parseVerification(content, header.id, index + 1),
        )
        return parsed ? [parsed] : []
      })
    : []

  const declaredCriterionIds = new Set(criteria.map((criterion) => criterion.id))
  for (const specification of verification) {
    if (specification.type === "instruction") continue
    for (const criterionId of specification.criterionIds ?? []) {
      if (!declaredCriterionIds.has(criterionId)) {
        collector.add(
          "RALPH_PRD_VERIFICATION_CRITERION_UNKNOWN",
          `Verification ${specification.id} references unknown criterion ${criterionId}`,
          {
            position: verificationField?.position ?? position,
            hint: `Use one of: ${[...declaredCriterionIds].join(", ") || "<no criteria declared>"}.`,
          },
        )
      }
    }
  }

  const boundaryField = fields.get("boundaries")
  const boundaries = boundaryField?.entries ?? []
  if (boundaries.length === 0) {
    collector.add(
      "RALPH_PRD_BOUNDARIES_REQUIRED",
      `Task ${header.id} requires at least one Limit`,
      {
        position: boundaryField?.position ?? position,
      },
    )
  }

  const evidenceField = fields.get("evidenceMode")
  const evidenceText = evidenceField
    ? requireSingleInline(evidenceField, "Modo de evidência/Evidence mode", collector, position)
    : undefined
  const evidenceMode =
    evidenceField && evidenceText !== undefined
      ? parseLeafAt(evidenceField, collector, () => parseEvidenceMode(evidenceText))
      : defaults.evidenceMode
  if (!evidenceMode) {
    collector.add(
      "RALPH_PRD_EVIDENCE_MODE_REQUIRED",
      `Task ${header.id} requires an evidence mode or document default`,
      { position: evidenceField?.position ?? position },
    )
  }

  const subPrdField = fields.get("subPrd")
  const subPrdText = requireSingleInline(subPrdField, "Sub-PRD", collector, position)
  const subPrd =
    subPrdField && subPrdText !== undefined && !isExplicitNone(subPrdText)
      ? parseLeafAt(subPrdField, collector, () =>
          parseRelativePath(subPrdText, "Sub-PRD path", { allowParent: true }),
        )
      : undefined

  const parallelField = fields.get("parallelGroup")
  const parallelContent = optionalSingleInline(
    parallelField,
    "Grupo paralelo/Parallel group",
    collector,
  )
  const parallelGroup =
    parallelField && parallelContent && !isExplicitNone(parallelContent)
      ? parseLeafAt(parallelField, collector, () => parseSlug(parallelContent, "Parallel group"))
      : undefined

  const profilesField = fields.get("profiles")
  const profilesContent = optionalSingleInline(profilesField, "Perfis/Profiles", collector)
  const profiles =
    profilesField && profilesContent
      ? parseLeafAt(profilesField, collector, () => parseProfiles(profilesContent))
      : undefined

  const budgetField = fields.get("budget")
  const budgetContent = optionalSingleInline(budgetField, "Orçamento/Budget", collector)
  const budget =
    budgetField && budgetContent
      ? parseLeafAt(budgetField, collector, () => parseBudget(budgetContent))
      : undefined

  if (evidenceMode?.includes("criteria") && criteria.length === 0) {
    collector.add(
      "RALPH_PRD_CRITERIA_REQUIRED",
      `Evidence mode ${evidenceMode} requires at least one real criterion`,
      { position: fields.get("criteria")?.position ?? position },
    )
  }
  if (evidenceMode?.includes("criteria")) {
    const criterionVerifications = verification.filter(
      (specification): specification is ExecutableVerificationSpec =>
        specification.type !== "instruction",
    )
    const hasExplicitCriterionLinks = criterionVerifications.some(
      (specification) => (specification.criterionIds?.length ?? 0) > 0,
    )
    if (hasExplicitCriterionLinks) {
      for (const criterion of criteria) {
        const canProduceLinkedEvidence = criterionVerifications.some(
          (specification) =>
            specification.skipPolicy !== "never-run" &&
            specification.criterionIds?.includes(criterion.id),
        )
        if (canProduceLinkedEvidence) continue
        collector.add(
          "RALPH_PRD_CRITERION_VERIFICATION_REQUIRED",
          `Criterion ${criterion.id} requires at least one executable linked verification`,
          {
            position: verificationField?.position ?? position,
            hint: "Link a real gate to this criterion; human instruction entries are context and never count as deterministic evidence.",
          },
        )
      }
    } else {
      const hasDeterministicCriterionGate = criterionVerifications.some(
        (specification) => specification.skipPolicy !== "never-run",
      )
      if (!hasDeterministicCriterionGate) {
        collector.add(
          "RALPH_PRD_CRITERIA_VERIFICATION_REQUIRED",
          `Evidence mode ${evidenceMode} requires a deterministic verification gate`,
          {
            position: verificationField?.position ?? position,
            hint: "Declare a real command/file gate, or choose change-only/artifact when no proportional deterministic oracle exists. Human instruction does not satisfy criteria mode.",
          },
        )
      }
    }
  }
  if (evidenceMode?.includes("artifact")) {
    const hasArtifact = verification.some((specification) => specification.type === "artifact")
    if (!hasArtifact && !subPrd) {
      collector.add(
        "RALPH_PRD_ARTIFACT_VERIFICATION_REQUIRED",
        `Evidence mode ${evidenceMode} requires an explicitly named artifact verification`,
        {
          position: verificationField?.position ?? position,
          hint: "Use `artifact: <id>; path=<relative-path>`.",
        },
      )
    }
  }

  if (!result || dependencies === undefined || !evidenceMode || !subPrdField) return undefined

  const taskDefinition: Omit<PrdTask, "taskSpecHash"> = {
    id: header.id,
    title: header.title,
    status: markerStatus(header.marker),
    result,
    dependencies,
    criteria,
    verification,
    boundaries,
    evidenceMode,
    ...(subPrd ? { subPrd } : {}),
    ...(parallelGroup ? { parallelGroup } : {}),
    ...(profiles ? { profiles } : {}),
    ...(budget ? { budget } : {}),
    ...(fields.get("notes") ? { notes: fields.get("notes")?.entries ?? [] } : {}),
  }
  const task: PrdTask = {
    ...taskDefinition,
    taskSpecHash: computeTaskSpecHash({ id: documentId, defaults }, taskDefinition),
  }

  const taskStart = item.position?.start
  const taskEnd = item.position?.end
  const markerPoint = paragraph.position?.start
  if (!taskStart || !taskEnd || !markerPoint) {
    collector.add("RALPH_PRD_SOURCE_POSITION_MISSING", `Task ${header.id} has no source position`, {
      position,
    })
    return undefined
  }
  const markerCharOffset = bodyStartChar + (markerPoint.offset ?? 0)
  if (!/^\[[ ~x]\]$/.test(source.slice(markerCharOffset, markerCharOffset + 3))) {
    collector.add(
      "RALPH_PRD_MARKER_POSITION_INVALID",
      `Task ${header.id} marker cannot be located safely`,
      { position },
    )
    return undefined
  }
  const location: TaskSourceLocation = {
    file,
    taskStart: publicPoint(source, absolutePosition(bodyStartChar, bodyStartLine, taskStart)),
    marker: {
      ...publicPoint(source, absolutePosition(bodyStartChar, bodyStartLine, markerPoint)),
      length: 3,
    },
    taskEnd: publicPoint(source, absolutePosition(bodyStartChar, bodyStartLine, taskEnd)),
  }
  return { task, location }
}

type ParsedSection = {
  sharedContext: MarkdownContent
  tasks: PrdTask[]
  sourceMap: Record<string, TaskSourceLocation>
  listStartChar: number
  listEndChar: number
}

function parseVerticalSection(
  source: string,
  body: string,
  bodyStartChar: number,
  bodyStartLine: number,
  file: string,
  documentId: string,
  defaults: TaskDefaults,
  collector: DiagnosticCollector,
): ParsedSection | undefined {
  const tree = parseMarkdown(body)
  const sectionIndexes = tree.children.flatMap((node, index) =>
    node.type === "heading" && node.depth === 2 && markdownNodeText(node) === "Vertical slices"
      ? [index]
      : [],
  )
  if (sectionIndexes.length !== 1) {
    collector.add(
      sectionIndexes.length === 0
        ? "RALPH_PRD_VERTICAL_SECTION_MISSING"
        : "RALPH_PRD_VERTICAL_SECTION_DUPLICATED",
      sectionIndexes.length === 0
        ? "PRD v2 requires exactly one `## Vertical slices` section"
        : "PRD v2 contains more than one `## Vertical slices` section",
      { hint: "Keep one normative level-2 section for the task queue." },
    )
    return undefined
  }
  const sectionIndex = sectionIndexes[0] ?? 0
  const sectionStart = tree.children[sectionIndex]?.position?.start.offset
  if (sectionStart === undefined) {
    collector.add(
      "RALPH_PRD_SOURCE_POSITION_MISSING",
      "Vertical slices heading has no source position",
    )
    return undefined
  }
  let endIndex = tree.children.length
  for (let index = sectionIndex + 1; index < tree.children.length; index += 1) {
    const node = tree.children[index]
    if (node?.type === "heading" && node.depth <= 2) {
      endIndex = index
      break
    }
  }
  const content = tree.children.slice(sectionIndex + 1, endIndex)
  if (content.length !== 1 || content[0]?.type !== "list" || content[0].ordered) {
    const node = content[0]
    const invalidPosition = node ? nodePosition(bodyStartChar, bodyStartLine, node) : undefined
    collector.add(
      "RALPH_PRD_VERTICAL_SECTION_STRUCTURE_INVALID",
      "The normative section must contain exactly one top-level unordered task list",
      {
        ...(invalidPosition ? { position: invalidPosition } : {}),
      },
    )
    return undefined
  }
  const list: List = content[0]
  const listStart = list.position?.start.offset
  const listEnd = list.position?.end.offset
  if (listStart === undefined || listEnd === undefined) {
    collector.add("RALPH_PRD_SOURCE_POSITION_MISSING", "Task list has no source position")
    return undefined
  }
  const tasks: PrdTask[] = []
  const sourceMap: Record<string, TaskSourceLocation> = {}
  for (const item of list.children) {
    const parsed = parseTask(
      source,
      body,
      bodyStartChar,
      bodyStartLine,
      file,
      documentId,
      item,
      defaults,
      collector,
    )
    if (!parsed) continue
    if (Object.hasOwn(sourceMap, parsed.task.id)) {
      collector.add("RALPH_PRD_TASK_ID_DUPLICATED", `Duplicate task ID: ${parsed.task.id}`, {
        position: {
          line: parsed.location.taskStart.line,
          column: parsed.location.taskStart.column,
        },
      })
      continue
    }
    tasks.push(parsed.task)
    sourceMap[parsed.task.id] = parsed.location
  }
  if (tasks.length === 0) {
    collector.add(
      "RALPH_PRD_TASKS_EMPTY",
      "The vertical slice queue must contain at least one task",
    )
  }
  return {
    sharedContext: parseMarkdownFragment(body.slice(0, sectionStart)),
    tasks,
    sourceMap,
    listStartChar: bodyStartChar + listStart,
    listEndChar: bodyStartChar + listEnd,
  }
}

function decodeUtf8(bytes: Uint8Array, collector: DiagnosticCollector): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    collector.add("RALPH_PRD_UTF8_INVALID", "PRD is not valid UTF-8", {
      details: { reason: error instanceof Error ? error.message : String(error) },
    })
    return undefined
  }
}

function yamlNodeOffset(node: unknown): number | undefined {
  if (!isRecord(node) || !Array.isArray(node.range)) return undefined
  const first = node.range[0]
  return typeof first === "number" ? first : undefined
}

export type InternalPrdParseResult = PrdParseResult & {
  parsed?: ParsedPrdInternal
}

export function parsePrdBytesInternal(
  bytes: Uint8Array,
  options: ParsePrdOptions,
): InternalPrdParseResult {
  const file = options.file.replaceAll("\\", "/")
  const collector = new DiagnosticCollector(file)
  const source = decodeUtf8(bytes, collector)
  if (source === undefined) return { ok: false, diagnostics: collector.diagnostics }
  validateNewlines(source, collector)
  const frontmatter = readFrontmatter(source, collector)
  if (!frontmatter) return { ok: false, diagnostics: collector.diagnostics }
  const effectiveDefaults = mergeDefaults(options.inheritedDefaults, frontmatter.declaredDefaults)
  let id: string | undefined
  let workspace: string | undefined
  let parent: PrdDocument["parent"]
  try {
    id = parseSlug(frontmatter.data.id, "PRD ID")
    workspace = parseRelativePath(frontmatter.data.workspace, "Workspace", { allowDot: true })
    if (frontmatter.data.parent) {
      parent = {
        prd: parseRelativePath(frontmatter.data.parent.prd, "Parent PRD path", {
          allowParent: true,
        }),
        task: parseSlug(frontmatter.data.parent.task, "Parent task ID"),
      }
    }
  } catch (error) {
    if (error instanceof PrdLeafError) {
      collector.add(error.code, error.message, { ...(error.hint ? { hint: error.hint } : {}) })
    } else throw error
  }
  const body = source.slice(frontmatter.bodyStartChar)
  const section = parseVerticalSection(
    source,
    body,
    frontmatter.bodyStartChar,
    frontmatter.bodyStartLine,
    file,
    id ?? "invalid-document-id",
    effectiveDefaults,
    collector,
  )
  if (!id || !workspace || !section || collector.errorCount() > 0) {
    return { ok: false, diagnostics: collector.diagnostics }
  }
  const definitionCandidate: Omit<PrdDocument, "definitionHash"> = {
    schemaVersion: 2,
    id,
    title: frontmatter.data.title.trim(),
    kind: frontmatter.data.kind,
    file,
    workspace,
    contentHash: hashBytes(bytes),
    ...(parent ? { parent } : {}),
    defaults: effectiveDefaults,
    sharedContext: section.sharedContext,
    tasks: section.tasks,
    sourceMap: section.sourceMap,
    ...(frontmatter.data.metadata ? { metadata: frontmatter.data.metadata } : {}),
  }
  const candidate: PrdDocument = {
    ...definitionCandidate,
    definitionHash: computePrdDefinitionHash(definitionCandidate),
  }
  const validated = PrdDocumentSchema.safeParse(candidate)
  if (!validated.success) {
    for (const issue of validated.error.issues) {
      collector.add("RALPH_PRD_COMPILED_SCHEMA_INVALID", issue.message, {
        details: { path: issue.path.join(".") },
      })
    }
    return { ok: false, diagnostics: collector.diagnostics }
  }
  return {
    ok: true,
    document: validated.data,
    diagnostics: collector.diagnostics,
    parsed: {
      document: validated.data,
      source,
      bytes,
      declaredDefaults: frontmatter.declaredDefaults,
      sectionListStartChar: section.listStartChar,
      sectionListEndChar: section.listEndChar,
    },
  }
}

export function parsePrdSource(source: string, options: ParsePrdOptions): PrdParseResult {
  const parsed = parsePrdBytesInternal(Buffer.from(source, "utf8"), options)
  return {
    ok: parsed.ok,
    ...(parsed.document ? { document: parsed.document } : {}),
    diagnostics: parsed.diagnostics,
  }
}

export async function parsePrdFileInternal(
  path: string,
  options: ParsePrdOptions,
): Promise<InternalPrdParseResult> {
  let bytes: Uint8Array
  try {
    bytes = await readFile(path)
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "RALPH_PRD_READ_FAILED",
          severity: "error",
          message: `Could not read PRD: ${options.file}`,
          file: options.file.replaceAll("\\", "/"),
          details: { reason: error instanceof Error ? error.message : String(error) },
        },
      ],
    }
  }
  return parsePrdBytesInternal(bytes, options)
}

export async function parsePrdFile(
  path: string,
  options: ParsePrdOptions,
): Promise<PrdParseResult> {
  const parsed = await parsePrdFileInternal(path, options)
  return {
    ok: parsed.ok,
    ...(parsed.document ? { document: parsed.document } : {}),
    diagnostics: parsed.diagnostics,
  }
}
