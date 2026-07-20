import type {
  MarkdownContent,
  PrdDocument,
  PrdTask,
  TaskBudget,
  VerificationSpec,
} from "./contracts"
import { parsePrdBytesInternal } from "./parser"

export type FormatPrdResult = {
  ok: boolean
  source?: string
  changed?: boolean
  diagnostics: ReturnType<typeof parsePrdBytesInternal>["diagnostics"]
}

function titleText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("*", "\\*")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
}

function marker(task: PrdTask): string {
  if (task.status === "active") return "~"
  if (task.status === "completed") return "x"
  return " "
}

function nestedMarkdown(prefix: string, content: MarkdownContent): string[] {
  const lines = content.markdown.trim().split(/\r?\n/)
  const first = lines.shift() ?? ""
  return [`${prefix}${first}`, ...lines.map((line) => `${" ".repeat(prefix.length)}${line}`)]
}

function fieldEntries(
  label: string,
  entries: readonly MarkdownContent[],
  ordered = false,
): string[] {
  if (entries.length === 0) return []
  return [
    `  - ${label}:`,
    ...entries.flatMap((entry, index) =>
      nestedMarkdown(`    ${ordered ? `${index + 1}.` : "-"} `, entry),
    ),
  ]
}

function resultField(content: MarkdownContent): string[] {
  if (!content.markdown.includes("\n") && !content.markdown.includes("\r")) {
    return [`  - Resultado: ${content.markdown.trim()}`]
  }
  return fieldEntries("Resultado", [content])
}

function verificationText(specification: VerificationSpec): MarkdownContent {
  if (specification.type === "instruction") {
    return {
      ...specification.text,
      markdown: `instruction: ${specification.text.markdown.trim()}`,
      text: `instruction: ${specification.text.text}`,
    }
  }
  const hasAdvancedMetadata =
    specification.attempts !== undefined ||
    specification.timeoutMs !== undefined ||
    specification.applicability !== undefined ||
    specification.criterionIds !== undefined
  if (hasAdvancedMetadata && specification.type !== "command") {
    const { id: _derivedId, ...declaration } = specification
    const markdown = `gate: ${JSON.stringify(declaration)}`
    return { markdown, text: markdown, ast: [{ type: "text", value: markdown }] }
  }
  const markdown =
    specification.type === "command"
      ? `command: ${JSON.stringify(
          specification.category === "command" &&
            specification.skipPolicy === "required" &&
            specification.blocking &&
            !hasAdvancedMetadata
            ? specification.command
            : {
                category: specification.category,
                skipPolicy: specification.skipPolicy,
                blocking: specification.blocking,
                ...(specification.attempts ? { attempts: specification.attempts } : {}),
                ...(specification.timeoutMs ? { timeoutMs: specification.timeoutMs } : {}),
                ...(specification.applicability
                  ? { applicability: specification.applicability }
                  : {}),
                ...(specification.criterionIds ? { criterionIds: specification.criterionIds } : {}),
                command: specification.command,
              },
        )}`
      : specification.type === "file"
        ? `file: ${specification.path}; ${fileExpectation(specification.expectation)}`
        : specification.type === "schema"
          ? `schema: ${specification.path}; schema=${specification.schema}`
          : specification.type === "git"
            ? `git: ${gitExpectation(specification.expectation)}`
            : specification.type === "artifact"
              ? `artifact: ${specification.artifactId}; path=${specification.path}${specification.schema ? `; schema=${specification.schema}` : ""}${specification.expectedSha256 ? `; sha256=${specification.expectedSha256}` : ""}`
              : `plugin: ${specification.plugin}; ${JSON.stringify(specification.input)}`
  return { markdown, text: markdown, ast: [{ type: "text", value: markdown }] }
}

function gitExpectation(
  expectation: Extract<VerificationSpec, { type: "git" }>["expectation"],
): string {
  if (["clean", "changed", "no-conflicts"].includes(expectation.kind)) return expectation.kind
  if (expectation.kind === "branch") return `branch=${expectation.value}`
  return JSON.stringify(expectation)
}

function fileExpectation(
  expectation: Extract<VerificationSpec, { type: "file" }>["expectation"],
): string {
  if (expectation.kind === "sha256") return `sha256=${expectation.value}`
  if (expectation.kind === "json-schema") return `schema=${expectation.schema}`
  return expectation.kind
}

function budgetText(budget: TaskBudget): string {
  const parts: string[] = []
  if (budget.maxModelCallsPerAttempt !== undefined) {
    parts.push(`model_calls=${budget.maxModelCallsPerAttempt}`)
  }
  if (budget.maxToolCallsPerModelCall !== undefined) {
    parts.push(`tool_calls=${budget.maxToolCallsPerModelCall}`)
  }
  if (budget.maxInputTokens !== undefined) parts.push(`input_tokens=${budget.maxInputTokens}`)
  if (budget.maxOutputTokens !== undefined) parts.push(`output_tokens=${budget.maxOutputTokens}`)
  if (budget.maxReasoningTokens !== undefined) {
    parts.push(`reasoning_tokens=${budget.maxReasoningTokens}`)
  }
  if (budget.maxTotalTokens !== undefined) parts.push(`tokens=${budget.maxTotalTokens}`)
  if (budget.maxCost !== undefined) {
    parts.push(`cost=${budget.maxCost.amount} ${budget.maxCost.currency}`)
  }
  if (budget.taskTimeout !== undefined) parts.push(`timeout=${budget.taskTimeout.source}`)
  if (budget.maxRevisionAttempts !== undefined) {
    parts.push(`revisions=${budget.maxRevisionAttempts}`)
  }
  return parts.join("; ")
}

function formatTask(task: PrdTask): string {
  const lines = [
    `- [${marker(task)}] **${task.id} — ${titleText(task.title)}**`,
    ...resultField(task.result),
    `  - Dependências: ${task.dependencies.length ? task.dependencies.join(", ") : "nenhuma"}`,
    ...fieldEntries(
      "Critérios",
      task.criteria.map((criterion) => criterion.text),
      true,
    ),
    ...fieldEntries("Verificação", task.verification.map(verificationText)),
    ...fieldEntries("Limites", task.boundaries),
    `  - Modo de evidência: ${task.evidenceMode}`,
    `  - Sub-PRD: ${task.subPrd ?? "nenhum"}`,
    ...(task.parallelGroup ? [`  - Grupo paralelo: ${task.parallelGroup}`] : []),
    ...(task.profiles
      ? [
          `  - Perfis: ${[
            task.profiles.executor ? `executor=${task.profiles.executor}` : undefined,
            task.profiles.judge ? `judge=${task.profiles.judge}` : undefined,
          ]
            .filter((value): value is string => value !== undefined)
            .join("; ")}`,
        ]
      : []),
    ...(task.budget ? [`  - Orçamento: ${budgetText(task.budget)}`] : []),
    ...(task.notes ? fieldEntries("Notas", task.notes) : []),
  ]
  return lines.join("\n")
}

export function formatTaskList(document: PrdDocument): string {
  return document.tasks.map(formatTask).join("\n\n")
}

function newlineOf(source: string): "\n" | "\r\n" {
  const index = source.indexOf("\n")
  return index > 0 && source[index - 1] === "\r" ? "\r\n" : "\n"
}

export function formatPrdSource(source: string, options: { file: string }): FormatPrdResult {
  const parsed = parsePrdBytesInternal(Buffer.from(source, "utf8"), options)
  if (!parsed.ok || !parsed.parsed || !parsed.document) {
    return { ok: false, diagnostics: parsed.diagnostics }
  }
  const replacement = formatTaskList(parsed.document).replaceAll("\n", newlineOf(source))
  const formatted = `${source.slice(0, parsed.parsed.sectionListStartChar)}${replacement}${source.slice(parsed.parsed.sectionListEndChar)}`
  const validation = parsePrdBytesInternal(Buffer.from(formatted, "utf8"), options)
  if (!validation.ok) return { ok: false, diagnostics: validation.diagnostics }
  return {
    ok: true,
    source: formatted,
    changed: formatted !== source,
    diagnostics: parsed.diagnostics,
  }
}
