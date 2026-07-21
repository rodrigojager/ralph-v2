import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { basename, extname } from "node:path"
import type { Diagnostic } from "@ralph/domain"
import { fromMarkdown } from "mdast-util-from-markdown"
import { parseDocument, stringify } from "yaml"
import {
  type ClassicPrdDocument,
  ClassicPrdDocumentSchema,
  type ClassicPrdTask,
  JsonValueSchema,
  type PrdFormatDetection,
  type PrdMigrationReport,
  PrdMigrationReportSchema,
} from "./contracts"
import { parseMarkdownFragment } from "./markdown"
import { parsePrdSource } from "./parser"

type ClassicParseResult = {
  ok: boolean
  document?: ClassicPrdDocument
  diagnostics: Diagnostic[]
}

export type DetectPrdResult = {
  format: PrdFormatDetection
  declaredVersion?: unknown
  diagnostics: Diagnostic[]
}

export type MigrateClassicOptions = {
  sourceFile: string
  outputFile: string
}

export type MigrateClassicResult = {
  ok: boolean
  markdown?: string
  report?: PrdMigrationReport
  diagnostics: Diagnostic[]
}

type Line = {
  number: number
  start: number
  end: number
  text: string
  newline: string
}

type MutableClassicTask = {
  ordinal: number
  text: string
  status: ClassicPrdTask["status"]
  line: number
  column: number
  markerByteOffset?: number | undefined
  indentation: number
  id?: string | undefined
  group?: string | undefined
  dependsOnGroups: string[]
  acceptanceCriteria: string[]
  filesAllowed: string[]
  gates: string[]
  notes: string[]
  priority?: string | undefined
  complexity?: string | undefined
  inlineFields: Set<string>
  sourceLineIndex: number
}

const CLASSIC_TASK = /^(\s*)-\s+\[([ xX~])\]\s*(.*)$/
const CLASSIC_ANNOTATION =
  /\[(id|group|parallel_group|depends|depends_on|priority|complexity|files_allowed|gate|gates):([^\]]*)\]/g
const CLASSIC_BLOCK_FIELD =
  /^\s*(id|group|parallel_group|depends|depends_on|acceptance|acceptance_criteria|files_allowed|gate|gates|complexity|priority|notes)\s*:\s*(.*)$/

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function linesOf(source: string): Line[] {
  const output: Line[] = []
  let start = 0
  let number = 1
  while (start < source.length) {
    let cursor = start
    while (cursor < source.length && source[cursor] !== "\r" && source[cursor] !== "\n") {
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
    output.push({
      number,
      start,
      end: cursor,
      text: source.slice(start, contentEnd),
      newline,
    })
    start = cursor
    number += 1
  }
  if (output.length === 0) output.push({ number: 1, start: 0, end: 0, text: "", newline: "" })
  return output
}

function decode(bytes: Uint8Array, file: string): { source?: string; diagnostics: Diagnostic[] } {
  try {
    return {
      source: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      diagnostics: [],
    }
  } catch (error) {
    return {
      diagnostics: [
        {
          code: "RALPH_PRD_UTF8_INVALID",
          severity: "error",
          message: "PRD is not valid UTF-8",
          file,
          details: { reason: error instanceof Error ? error.message : String(error) },
        },
      ],
    }
  }
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" ? [item.trim()] : [])).filter(Boolean)
  }
  if (typeof value !== "string") return []
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function statusFromMarker(marker: string): ClassicPrdTask["status"] {
  if (marker === "x" || marker === "X") return "completed"
  if (marker === "~") return "skipped-for-review"
  return "pending"
}

function statusFromObject(value: Record<string, unknown>): ClassicPrdTask["status"] {
  if (value.completed === true) return "completed"
  const status = typeof value.status === "string" ? value.status.toLocaleLowerCase("und") : ""
  if (["completed", "done", "x", "complete"].includes(status)) return "completed"
  if (["skipped", "review", "manual-review", "skipped-for-review", "~"].includes(status)) {
    return "skipped-for-review"
  }
  return "pending"
}

function applyLegacyField(
  task: MutableClassicTask,
  key: string,
  value: string,
  inline: boolean,
): void {
  const normalized = key === "parallel_group" ? "group" : key === "depends" ? "depends_on" : key
  if (!inline && task.inlineFields.has(normalized)) return
  if (inline) task.inlineFields.add(normalized)
  switch (normalized) {
    case "id":
      task.id = value.trim() || undefined
      break
    case "group":
      task.group = value.trim() || undefined
      break
    case "depends_on":
      task.dependsOnGroups = splitList(value)
      break
    case "acceptance":
    case "acceptance_criteria":
      task.acceptanceCriteria = splitList(value)
      break
    case "files_allowed":
      task.filesAllowed = splitList(value)
      break
    case "gate":
    case "gates":
      task.gates = splitList(value)
      break
    case "notes":
      task.notes = splitList(value)
      break
    case "priority":
      task.priority = value.trim() || undefined
      break
    case "complexity":
      task.complexity = value.trim() || undefined
      break
  }
}

function taskFromCheckbox(
  source: string,
  line: Line,
  lineIndex: number,
  match: RegExpExecArray,
  ordinal: number,
): MutableClassicTask {
  const indentation = match[1]?.length ?? 0
  const marker = match[2] ?? " "
  let text = match[3] ?? ""
  const task: MutableClassicTask = {
    ordinal,
    text: "",
    status: statusFromMarker(marker),
    line: line.number,
    column: indentation + 1,
    markerByteOffset: Buffer.byteLength(
      source.slice(0, line.start + textMarkerCharOffset(line.text)),
      "utf8",
    ),
    indentation,
    dependsOnGroups: [],
    acceptanceCriteria: [],
    filesAllowed: [],
    gates: [],
    notes: [],
    inlineFields: new Set(),
    sourceLineIndex: lineIndex,
  }
  text = text.replace(CLASSIC_ANNOTATION, (_whole, key: string, value: string) => {
    applyLegacyField(task, key, value, true)
    return ""
  })
  task.text = text.replace(/[\t ]+/g, " ").trim()
  return task
}

function textMarkerCharOffset(line: string): number {
  const marker = line.indexOf("[")
  return marker < 0 ? 0 : marker
}

function safeYamlObject(text: string): Record<string, unknown> | undefined {
  const document = parseDocument(text, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    schema: "core",
  })
  if (document.errors.length > 0) return undefined
  try {
    const value: unknown = document.toJS({ maxAliasCount: 0 })
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value))
      : undefined
  } catch {
    return undefined
  }
}

function markdownFrontmatter(
  source: string,
  lines: readonly Line[],
): {
  value: Record<string, unknown>
  bodyLineIndex: number
  error?: "unterminated" | "invalid"
} {
  const firstText = lines[0]?.text.startsWith("\uFEFF") ? lines[0].text.slice(1) : lines[0]?.text
  if (firstText?.trim() !== "---") return { value: {}, bodyLineIndex: 0 }
  const close = lines.findIndex((line, index) => index > 0 && line.text.trim() === "---")
  if (close < 0) return { value: {}, bodyLineIndex: 0, error: "unterminated" }
  const start = lines[0]?.end ?? 0
  const end = lines[close]?.start ?? start
  const frontmatterSource = source.slice(start, end)
  if (!frontmatterSource.trim()) return { value: {}, bodyLineIndex: close + 1 }
  const value = safeYamlObject(frontmatterSource)
  return value
    ? { value, bodyLineIndex: close + 1 }
    : { value: {}, bodyLineIndex: close + 1, error: "invalid" }
}

function commonMarkExcludedRanges(source: string): Array<{ start: number; end: number }> {
  type Node = {
    type?: string
    position?: { start?: { offset?: number }; end?: { offset?: number } }
    children?: Node[]
  }
  const ranges: Array<{ start: number; end: number }> = []
  const visit = (node: Node): void => {
    if (node.type === "code" || node.type === "html") {
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (typeof start === "number" && typeof end === "number") ranges.push({ start, end })
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(fromMarkdown(source) as Node)
  return ranges
}

function jsonRecord(
  value: Record<string, unknown>,
): Record<string, import("./contracts").JsonValue> {
  const output: Record<string, import("./contracts").JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    const parsed = JsonValueSchema.safeParse(item)
    if (parsed.success) output[key] = parsed.data
  }
  return output
}

function parseClassicMarkdown(
  source: string,
  bytes: Uint8Array,
  file: string,
  sourceFormat: "markdown" | "yaml" = "markdown",
): ClassicParseResult {
  const diagnostics: Diagnostic[] = []
  const lines = linesOf(source)
  const frontmatter = markdownFrontmatter(source, lines)
  if (frontmatter.error) {
    diagnostics.push({
      code: "RALPH_PRD_CLASSIC_FRONTMATTER_INVALID",
      severity: "error",
      message:
        frontmatter.error === "unterminated"
          ? "Classic Markdown frontmatter is not terminated"
          : "Classic Markdown frontmatter contains invalid YAML",
      file,
      line: 1,
      column: 1,
      hint: "Repair the classic frontmatter before inspection or migration.",
    })
    return { ok: false, diagnostics }
  }
  const excludedRanges = commonMarkExcludedRanges(source)
  const tasks: MutableClassicTask[] = []
  for (let index = frontmatter.bodyLineIndex; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) continue
    if (excludedRanges.some((range) => line.start >= range.start && line.start < range.end))
      continue
    const match = CLASSIC_TASK.exec(line.text)
    if (match) tasks.push(taskFromCheckbox(source, line, index, match, tasks.length + 1))
  }
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    const task = tasks[taskIndex]
    if (!task) continue
    const nextLine = tasks[taskIndex + 1]?.sourceLineIndex ?? lines.length
    for (let index = task.sourceLineIndex + 1; index < nextLine; index += 1) {
      const line = lines[index]
      if (!line) continue
      const heading = /^(\s*)#{1,6}\s+/.exec(line.text)
      if (heading && (heading[1]?.length ?? 0) <= task.indentation) break
      const field = CLASSIC_BLOCK_FIELD.exec(line.text)
      if (field) applyLegacyField(task, field[1] ?? "", field[2] ?? "", false)
    }
  }
  if (tasks.length === 0) {
    diagnostics.push({
      code: "RALPH_PRD_CLASSIC_TASKS_MISSING",
      severity: "error",
      message: "No classic Ralph checklist tasks were recognized",
      file,
    })
    return { ok: false, diagnostics }
  }
  const firstTaskLine = tasks[0]?.sourceLineIndex ?? lines.length
  const contextBeforeTasks = lines
    .slice(frontmatter.bodyLineIndex, firstTaskLine)
    .map((line) => `${line.text}${line.newline}`)
    .join("")
    .trim()
  const taskLineIndexes = new Set(tasks.map((task) => task.sourceLineIndex))
  const preservedLegacyContent = lines
    .slice(firstTaskLine)
    .filter((line, relativeIndex) => {
      const absoluteIndex = firstTaskLine + relativeIndex
      if (taskLineIndexes.has(absoluteIndex)) return false
      if (CLASSIC_BLOCK_FIELD.test(line.text)) return false
      return line.text.trim().length > 0
    })
    .map((line) => line.text)
    .join("\n")
    .trim()
  const titleValue = frontmatter.value.task
  const title = typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : undefined
  const candidate: ClassicPrdDocument = {
    schemaVersion: 1,
    sourceFormat,
    file,
    contentHash: hash(bytes),
    ...(title ? { title } : {}),
    contextBeforeTasks,
    preservedLegacyContent,
    frontmatter: jsonRecord(frontmatter.value),
    tasks: tasks.map(({ inlineFields: _inline, sourceLineIndex: _line, ...task }) => task),
  }
  const parsed = ClassicPrdDocumentSchema.safeParse(candidate)
  if (!parsed.success) {
    diagnostics.push({
      code: "RALPH_PRD_CLASSIC_SCHEMA_INVALID",
      severity: "error",
      message: "Classic PRD adapter produced an invalid document",
      file,
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    })
    return { ok: false, diagnostics }
  }
  return { ok: true, document: parsed.data, diagnostics }
}

function scalarText(value: Record<string, unknown>, ordinal: number): string {
  for (const key of ["title", "text", "task"]) {
    const candidate = value[key]
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim()
  }
  return `Task ${ordinal}`
}

function gatesFrom(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return [item]
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const command = Object.entries(item).find(([key]) => key === "command")?.[1]
        return typeof command === "string" ? [command] : []
      }
      return []
    })
  }
  return splitList(value)
}

function taskFromObject(value: Record<string, unknown>, ordinal: number): ClassicPrdTask {
  const groupValue = value.group ?? value.parallel_group
  const dependsValue = value.depends_on ?? value.depends
  const acceptanceValue = value.acceptance_criteria ?? value.acceptance
  return {
    ordinal,
    text: scalarText(value, ordinal),
    status: statusFromObject(value),
    line: ordinal,
    column: 1,
    indentation: 0,
    ...(typeof value.id === "string" && value.id.trim() ? { id: value.id.trim() } : {}),
    ...(typeof groupValue === "string" && groupValue.trim() ? { group: groupValue.trim() } : {}),
    dependsOnGroups: splitList(dependsValue),
    acceptanceCriteria: splitList(acceptanceValue),
    filesAllowed: splitList(value.files_allowed),
    gates: gatesFrom(value.gates ?? value.gate),
    notes: splitList(value.notes),
    ...(typeof value.priority === "string" && value.priority.trim()
      ? { priority: value.priority.trim() }
      : {}),
    ...(typeof value.complexity === "string" && value.complexity.trim()
      ? { complexity: value.complexity.trim() }
      : {}),
  }
}

function parseStructuredClassic(
  value: unknown,
  bytes: Uint8Array,
  file: string,
  sourceFormat: "yaml" | "json",
): ClassicParseResult {
  const diagnostics: Diagnostic[] = []
  const root = value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  const taskValues = Array.isArray(value)
    ? value
    : root && "tasks" in root && Array.isArray(root.tasks)
      ? root.tasks
      : []
  const tasks = taskValues.flatMap((item, index) => {
    if (typeof item === "string") {
      return [
        taskFromObject(
          CLASSIC_TASK.test(item)
            ? { title: CLASSIC_TASK.exec(item)?.[3] ?? item, status: CLASSIC_TASK.exec(item)?.[2] }
            : { title: item },
          index + 1,
        ),
      ]
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return [taskFromObject(Object.fromEntries(Object.entries(item)), index + 1)]
    }
    return []
  })
  if (tasks.length === 0) {
    diagnostics.push({
      code: "RALPH_PRD_CLASSIC_TASKS_MISSING",
      severity: "error",
      message: "No classic structured tasks were recognized",
      file,
    })
    return { ok: false, diagnostics }
  }
  const rootRecord = root ? Object.fromEntries(Object.entries(root)) : {}
  const nestedFrontmatter =
    rootRecord.frontmatter &&
    typeof rootRecord.frontmatter === "object" &&
    !Array.isArray(rootRecord.frontmatter)
      ? Object.fromEntries(Object.entries(rootRecord.frontmatter))
      : {}
  const mergedFrontmatter = {
    ...Object.fromEntries(
      Object.entries(rootRecord).filter(([key]) => key !== "tasks" && key !== "frontmatter"),
    ),
    ...nestedFrontmatter,
  }
  const candidate: ClassicPrdDocument = {
    schemaVersion: 1,
    sourceFormat,
    file,
    contentHash: hash(bytes),
    ...(typeof mergedFrontmatter.task === "string" && mergedFrontmatter.task.trim()
      ? { title: mergedFrontmatter.task.trim() }
      : {}),
    contextBeforeTasks: "",
    preservedLegacyContent: "",
    frontmatter: jsonRecord(mergedFrontmatter),
    tasks,
  }
  const parsed = ClassicPrdDocumentSchema.safeParse(candidate)
  if (!parsed.success) {
    diagnostics.push({
      code: "RALPH_PRD_CLASSIC_SCHEMA_INVALID",
      severity: "error",
      message: "Classic structured adapter produced an invalid document",
      file,
      details: { issues: parsed.error.issues },
    })
    return { ok: false, diagnostics }
  }
  return { ok: true, document: parsed.data, diagnostics }
}

export function parseClassicPrdBytes(
  bytes: Uint8Array,
  options: { file: string; extension?: string },
): ClassicParseResult {
  const file = portable(options.file)
  const decoded = decode(bytes, file)
  if (!decoded.source) return { ok: false, diagnostics: decoded.diagnostics }
  const extension = (options.extension ?? extname(file)).toLocaleLowerCase("und")
  if (extension === ".json") {
    let value: unknown
    try {
      value = JSON.parse(decoded.source)
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "RALPH_PRD_CLASSIC_JSON_INVALID",
            severity: "error",
            message: "Classic JSON PRD is invalid",
            file,
            details: { reason: error instanceof Error ? error.message : String(error) },
          },
        ],
      }
    }
    return parseStructuredClassic(value, bytes, file, "json")
  }
  if (extension === ".yaml" || extension === ".yml") {
    const checkbox = parseClassicMarkdown(decoded.source, bytes, file, "yaml")
    if (checkbox.ok) return checkbox
    const object = safeYamlObject(decoded.source)
    if (!object) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "RALPH_PRD_CLASSIC_YAML_INVALID",
            severity: "error",
            message: "Classic YAML PRD is invalid or unsupported",
            file,
          },
        ],
      }
    }
    return parseStructuredClassic(object, bytes, file, "yaml")
  }
  return parseClassicMarkdown(decoded.source, bytes, file)
}

export async function parseClassicPrdFile(path: string, file = path): Promise<ClassicParseResult> {
  try {
    return parseClassicPrdBytes(await readFile(path), { file, extension: extname(path) })
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "RALPH_PRD_READ_FAILED",
          severity: "error",
          message: `Could not read PRD: ${portable(file)}`,
          file: portable(file),
          details: { reason: error instanceof Error ? error.message : String(error) },
        },
      ],
    }
  }
}

function declaredRalphVersion(source: string): { present: boolean; value?: unknown } {
  const lines = linesOf(source)
  const frontmatter = markdownFrontmatter(source, lines)
  if (Object.hasOwn(frontmatter.value, "ralph_prd")) {
    return { present: true, value: frontmatter.value.ralph_prd }
  }
  if (frontmatter.bodyLineIndex > 0) {
    const intent = lines
      .slice(1, frontmatter.bodyLineIndex - 1)
      .some((line) => /^\s*ralph_prd\s*:/.test(line.text))
    if (intent) return { present: true }
  }
  const firstText = lines[0]?.text.startsWith("\uFEFF") ? lines[0].text.slice(1) : lines[0]?.text
  if (firstText?.trim() === "---") {
    for (const line of lines.slice(1)) {
      if (line.text.trim() === "---") break
      const match = /^\s*ralph_prd\s*:\s*(.*?)\s*$/.exec(line.text)
      if (!match) continue
      const raw = match[1] ?? ""
      const numeric = /^\d+$/.test(raw) ? Number(raw) : raw || undefined
      return { present: true, ...(numeric !== undefined ? { value: numeric } : {}) }
    }
  }
  return { present: false }
}

export function detectPrdBytes(
  bytes: Uint8Array,
  options: { file: string; extension?: string },
): DetectPrdResult {
  const file = portable(options.file)
  const decoded = decode(bytes, file)
  if (!decoded.source) return { format: "unknown", diagnostics: decoded.diagnostics }
  const extension = (options.extension ?? extname(file)).toLocaleLowerCase("und")
  if (extension === ".json" || extension === ".yaml" || extension === ".yml") {
    let structured: unknown
    try {
      structured =
        extension === ".json" ? JSON.parse(decoded.source) : safeYamlObject(decoded.source)
    } catch {
      structured = undefined
    }
    if (structured && typeof structured === "object" && !Array.isArray(structured)) {
      const record = Object.fromEntries(Object.entries(structured))
      if (Object.hasOwn(record, "ralph_prd")) {
        return {
          format: "unknown",
          declaredVersion: record.ralph_prd,
          diagnostics: [
            {
              code: "RALPH_PRD_V2_CONTAINER_UNSUPPORTED",
              severity: "error",
              message: "PRD v2 is a versioned Markdown format, not JSON/YAML classic input",
              file,
            },
          ],
        }
      }
    }
  }
  if (![".json", ".yaml", ".yml"].includes(extension)) {
    const declared = declaredRalphVersion(decoded.source)
    if (declared.present) {
      if (declared.value === 2) return { format: "v2", declaredVersion: 2, diagnostics: [] }
      return {
        format: "unknown",
        ...(declared.value !== undefined ? { declaredVersion: declared.value } : {}),
        diagnostics: [
          {
            code: "RALPH_PRD_VERSION_UNSUPPORTED",
            severity: "error",
            message: `Unsupported or malformed ralph_prd version: ${String(declared.value)}`,
            file,
            hint: "Fix the declared version; v2 intent never falls back to the classic parser.",
          },
        ],
      }
    }
  }
  const classic = parseClassicPrdBytes(bytes, { file, extension })
  return classic.ok
    ? { format: "classic", diagnostics: classic.diagnostics }
    : { format: "unknown", diagnostics: classic.diagnostics }
}

export async function detectPrdFile(path: string, file = path): Promise<DetectPrdResult> {
  try {
    return detectPrdBytes(await readFile(path), { file, extension: extname(path) })
  } catch (error) {
    return {
      format: "unknown",
      diagnostics: [
        {
          code: "RALPH_PRD_READ_FAILED",
          severity: "error",
          message: `Could not read PRD: ${portable(file)}`,
          file: portable(file),
          details: { reason: error instanceof Error ? error.message : String(error) },
        },
      ],
    }
  }
}

function slugify(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("und")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const candidate = normalized || fallback
  return /^[a-z]/.test(candidate) ? candidate : `task-${candidate}`
}

function markdownPlain(value: string): string {
  return parseMarkdownFragment(value).text.replaceAll("\n", " ").trim()
}

function strongText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("\n", " ")
}

function inlineText(value: string): string {
  return value.replaceAll("\r", " ").replaceAll("\n", " ").trim()
}

function migrationTitle(document: ClassicPrdDocument): string {
  if (document.title) return document.title
  const heading = document.contextBeforeTasks
    .split(/\r?\n/)
    .find((line) => /^#\s+/.test(line.trim()))
  if (heading) return heading.trim().replace(/^#\s+/, "").trim()
  return basename(document.file, extname(document.file)).replaceAll(/[-_]+/g, " ") || "Migrated PRD"
}

function quoteLegacy(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")
}

export function migrateClassicDocument(
  document: ClassicPrdDocument,
  options: MigrateClassicOptions,
): MigrateClassicResult {
  const diagnostics: Diagnostic[] = []
  const notices: PrdMigrationReport["notices"] = []
  const notice = (
    code: string,
    severity: "info" | "warning" | "error",
    kind: PrdMigrationReport["notices"][number]["kind"],
    task: ClassicPrdTask | undefined,
    sourceField: string,
    targetField: string | undefined,
    reason: string,
  ): void => {
    notices.push({
      code,
      severity,
      kind,
      source: {
        file: document.file,
        ...(task ? { line: task.line, column: task.column } : {}),
        field: sourceField,
      },
      ...(targetField ? { target: { field: targetField } } : {}),
      reason,
    })
  }

  const title = migrationTitle(document)
  const documentId = slugify(title, "migrated-prd")
  notice(
    "RALPH_PRD_MIGRATION_DOCUMENT_ID",
    "info",
    "inferred",
    undefined,
    "title",
    "id",
    "Classic PRDs do not have a required document ID; a deterministic slug was generated.",
  )
  const usedIds = new Set<string>()
  const ids: string[] = []
  for (const task of document.tasks) {
    const explicit =
      task.id && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(task.id) ? task.id : undefined
    const base = explicit ?? slugify(markdownPlain(task.text), `task-${task.ordinal}`)
    let id = base
    let suffix = 2
    while (usedIds.has(id)) {
      id = `${base}-${suffix}`
      suffix += 1
    }
    usedIds.add(id)
    ids.push(id)
    if (!explicit || id !== explicit) {
      notice(
        "RALPH_PRD_MIGRATION_GENERATED_ID",
        "warning",
        "inferred",
        task,
        "id",
        "task.id",
        explicit
          ? "A duplicate task ID received a stable suffix."
          : "A valid v2 task ID was generated.",
      )
    }
  }

  const groupMembers = new Map<string, number[]>()
  for (let index = 0; index < document.tasks.length; index += 1) {
    const group = document.tasks[index]?.group
    if (!group) continue
    const members = groupMembers.get(group) ?? []
    members.push(index)
    groupMembers.set(group, members)
  }
  const usesGroups =
    groupMembers.size > 0 || document.tasks.some((task) => task.dependsOnGroups.length)

  const taskBlocks: string[] = []
  for (let index = 0; index < document.tasks.length; index += 1) {
    const task = document.tasks[index]
    const id = ids[index]
    if (!task || !id) continue
    const titleText = markdownPlain(task.text)
    if (!titleText) {
      diagnostics.push({
        code: "RALPH_PRD_MIGRATION_TASK_TEXT_MISSING",
        severity: "error",
        message: `Classic task ${task.ordinal} has no deliverable text`,
        file: document.file,
        line: task.line,
        column: task.column,
      })
      continue
    }
    const dependencies: string[] = []
    if (usesGroups) {
      for (const group of task.dependsOnGroups) {
        const members = groupMembers.get(group)
        if (!members || members.length === 0) {
          diagnostics.push({
            code: "RALPH_PRD_MIGRATION_GROUP_DEPENDENCY_MISSING",
            severity: "error",
            message: `Legacy depends_on references unknown group: ${group}`,
            file: document.file,
            line: task.line,
            column: task.column,
          })
          continue
        }
        const priorMembers = members.filter((member) => member < index)
        if (priorMembers.length !== members.length) {
          diagnostics.push({
            code: "RALPH_PRD_MIGRATION_GROUP_DEPENDENCY_FUTURE",
            severity: "error",
            message: `Legacy group dependency is future/cyclic and cannot be migrated safely: ${group}`,
            file: document.file,
            line: task.line,
            column: task.column,
          })
          continue
        }
        dependencies.push(...priorMembers.flatMap((member) => (ids[member] ? [ids[member]] : [])))
        notice(
          "RALPH_PRD_MIGRATION_GROUP_DEPENDENCY_EXPANDED",
          members.length > 1 ? "warning" : "info",
          members.length > 1 ? "semantic-change" : "promoted",
          task,
          "depends_on",
          "dependencies",
          members.length > 1
            ? "A legacy group dependency was conservatively expanded to all prior group members."
            : "A singleton legacy group dependency was promoted to a task dependency.",
        )
      }
    } else if (index > 0 && ids[index - 1]) {
      dependencies.push(ids[index - 1] ?? "")
      notice(
        "RALPH_PRD_MIGRATION_IMPLICIT_ORDER_MATERIALIZED",
        "info",
        "inferred",
        task,
        "file order",
        "dependencies",
        "Classic sequential execution order was materialized as an explicit dependency.",
      )
    }

    const criteria = task.acceptanceCriteria
    // Classic command/gate strings are preserved as non-executable human
    // instructions below. They cannot honestly satisfy criteria mode until an
    // author replaces them with structured v2 gates.
    const evidenceMode = "change-only"
    if (criteria.length > 0) {
      notice(
        "RALPH_PRD_MIGRATION_CRITERIA_PROMOTED",
        "info",
        "promoted",
        task,
        "acceptance_criteria",
        "criteria",
        "Only explicitly declared classic acceptance criteria were promoted.",
      )
    }
    const boundaries =
      task.filesAllowed.length > 0
        ? task.filesAllowed.map((path) => `Escopo permitido no PRD clássico: \`${path}\`.`)
        : [
            "Nenhum limite explícito foi declarado no PRD clássico; manter esta slice restrita ao resultado acima.",
          ]
    if (task.filesAllowed.length > 0) {
      notice(
        "RALPH_PRD_MIGRATION_FILES_ALLOWED_PROMOTED",
        "warning",
        "promoted",
        task,
        "files_allowed",
        "boundaries",
        "Declarative classic file scope was preserved as a human boundary; it was not enforced by the old loop.",
      )
    }
    const globalCommands = ["test_command", "lint_command", "browser_command"].flatMap((key) => {
      const value = document.frontmatter[key]
      return typeof value === "string" && value.trim() ? [`${key}: ${value.trim()}`] : []
    })
    const verifications = [...globalCommands, ...task.gates].map(
      (value) => `instruction: Executar verificação legada declarada: \`${value}\``,
    )
    const notes = [...task.notes]
    if (task.status === "skipped-for-review") {
      notes.push(
        "Status legado `[~]` significava resolvida para revisão manual; a migração manteve esta tarefa pendente.",
      )
      notice(
        "RALPH_PRD_MIGRATION_SKIPPED_REVIEW_TO_PENDING",
        "warning",
        "semantic-change",
        task,
        "status",
        "status",
        "The same marker means active in v2, so skipped-for-review was converted to pending.",
      )
    }
    if (task.indentation > 0) {
      notice(
        "RALPH_PRD_MIGRATION_NESTED_TASK_FLATTENED",
        "warning",
        "semantic-change",
        task,
        "indentation",
        "task order",
        "Classic nested checkboxes were independent flat tasks; indentation was not converted to a child PRD.",
      )
    }
    if (task.priority) notes.push(`Prioridade clássica preservada: ${task.priority}.`)
    if (task.complexity) notes.push(`Complexidade clássica preservada: ${task.complexity}.`)
    const marker = task.status === "completed" ? "x" : " "
    const lines = [
      `- [${marker}] **${id} — ${strongText(titleText)}**`,
      `  - Resultado: ${inlineText(task.text)}`,
      `  - Dependências: ${dependencies.length ? [...new Set(dependencies)].join(", ") : "nenhuma"}`,
      ...(criteria.length
        ? [
            "  - Critérios:",
            ...criteria.map((criterion, ordinal) => `    ${ordinal + 1}. ${criterion}`),
          ]
        : []),
      ...(verifications.length
        ? ["  - Verificação:", ...verifications.map((verification) => `    - ${verification}`)]
        : []),
      "  - Limites:",
      ...boundaries.map((boundary) => `    - ${boundary}`),
      `  - Modo de evidência: ${evidenceMode}`,
      "  - Sub-PRD: nenhum",
      ...(task.group
        ? [`  - Grupo paralelo: ${slugify(task.group, `group-${task.ordinal}`)}`]
        : []),
      ...(notes.length ? ["  - Notas:", ...notes.map((note) => `    - ${note}`)] : []),
    ]
    taskBlocks.push(lines.join("\n"))
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics }
  }

  const unmappedFrontmatter = Object.keys(document.frontmatter).filter(
    (key) =>
      !["task", "test_command", "lint_command", "browser_command", "gates", "gate"].includes(key),
  )
  for (const key of unmappedFrontmatter) {
    notice(
      "RALPH_PRD_MIGRATION_FRONTMATTER_UNMAPPED",
      "warning",
      "dropped",
      undefined,
      key,
      undefined,
      "Provider/security/runtime settings were not converted into invented v2 profiles.",
    )
  }
  const frontmatter = stringify(
    {
      ralph_prd: 2,
      id: documentId,
      title,
      kind: "root",
      workspace: ".",
      defaults: { evidence_mode: "change-only" },
      metadata: {
        legacy: {
          source_format: document.sourceFormat,
          source_hash: document.contentHash,
          unmapped_frontmatter_keys: unmappedFrontmatter,
        },
      },
    },
    { indent: 2, lineWidth: 100 },
  ).trimEnd()
  const context = document.contextBeforeTasks
    .split(/\r?\n/)
    .filter((line) => !/^#{1,2}\s+(Vertical slices|Tasks)\s*$/i.test(line.trim()))
    .filter((line) => !/^#\s+/.test(line.trim()))
    .join("\n")
    .trim()
  const markdown = [
    "---",
    frontmatter,
    "---",
    "",
    `# ${title}`,
    ...(context ? ["", context] : []),
    "",
    "## Vertical slices",
    "",
    taskBlocks.join("\n\n"),
    ...(document.preservedLegacyContent
      ? ["", "## Conteúdo legado preservado", "", quoteLegacy(document.preservedLegacyContent)]
      : []),
    "",
  ].join("\n")
  const validation = parsePrdSource(markdown, { file: portable(options.outputFile) })
  if (!validation.ok) {
    diagnostics.push(...validation.diagnostics)
    return { ok: false, diagnostics }
  }
  const report = PrdMigrationReportSchema.parse({
    schemaVersion: 1,
    source: portable(options.sourceFile),
    output: portable(options.outputFile),
    detected: "classic",
    taskCount: document.tasks.length,
    lossless: !notices.some((item) => item.kind === "dropped" || item.kind === "semantic-change"),
    notices,
  })
  return { ok: true, markdown, report, diagnostics }
}

export async function migrateClassicFile(
  path: string,
  options: MigrateClassicOptions,
): Promise<MigrateClassicResult> {
  const parsed = await parseClassicPrdFile(path, options.sourceFile)
  if (!parsed.ok || !parsed.document) return { ok: false, diagnostics: parsed.diagnostics }
  return migrateClassicDocument(parsed.document, options)
}
