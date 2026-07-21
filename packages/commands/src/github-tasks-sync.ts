import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import { basename, dirname, relative, resolve, sep } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph/domain"
import { canonicalDirectory, writeFileAtomic } from "@ralph/persistence"
import { parsePrdSource } from "@ralph/prd"

export type GitHubIssueState = "open" | "closed" | "all"

export type GitHubIssueSummary = {
  readonly number: number
  readonly title: string
  readonly state: "open" | "closed"
  readonly labels: readonly string[]
}

export type GitHubIssueListRequest = {
  readonly repository: string
  readonly state: GitHubIssueState
  readonly label?: string
  readonly signal?: AbortSignal
}

export interface GitHubIssueCommandService {
  listIssues(request: GitHubIssueListRequest): Promise<readonly GitHubIssueSummary[]>
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

const MAX_PAGES = 10
const PAGE_SIZE = 100
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex")
}

function portable(path: string): string {
  return path.split(sep).join("/")
}

function containsAsciiControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127
  })
}

function replaceAsciiControlCharacters(value: string, replacement: string): string {
  return Array.from(value, (character) =>
    containsAsciiControlCharacter(character) ? replacement : character,
  ).join("")
}

function assertRepository(value: string): string {
  const trimmed = value.trim()
  if (!REPOSITORY.test(trimmed) || trimmed.includes("..")) {
    throw new RalphError(
      "RALPH_GITHUB_REPOSITORY_INVALID",
      "GitHub repository must use the owner/repository form",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Use `tasks sync --repo owner/repository`.",
      },
    )
  }
  return trimmed
}

function assertLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 100 || containsAsciiControlCharacter(trimmed)) {
    throw new RalphError("RALPH_GITHUB_LABEL_INVALID", "GitHub label is empty or unsafe", {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  return trimmed
}

function responseIssue(value: unknown): GitHubIssueSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (item.pull_request !== undefined) return undefined
  if (!Number.isSafeInteger(item.number) || (item.number as number) <= 0) return undefined
  if (typeof item.title !== "string") return undefined
  if (item.state !== "open" && item.state !== "closed") return undefined
  const labels = Array.isArray(item.labels)
    ? item.labels.flatMap((label) => {
        if (typeof label === "string") return [label]
        if (!label || typeof label !== "object" || Array.isArray(label)) return []
        const name = (label as Record<string, unknown>).name
        return typeof name === "string" ? [name] : []
      })
    : []
  return {
    number: item.number as number,
    title: item.title,
    state: item.state,
    labels: [...new Set(labels)].sort((left, right) => left.localeCompare(right, "en")),
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length")
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) {
    throw new RalphError(
      "RALPH_GITHUB_RESPONSE_TOO_LARGE",
      "GitHub issue response exceeds the bounded response limit",
      { exitCode: EXIT_CODES.providerUnavailable },
    )
  }
  const text = await response.text()
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new RalphError(
      "RALPH_GITHUB_RESPONSE_TOO_LARGE",
      "GitHub issue response exceeds the bounded response limit",
      { exitCode: EXIT_CODES.providerUnavailable },
    )
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new RalphError("RALPH_GITHUB_RESPONSE_INVALID", "GitHub returned invalid JSON", {
      exitCode: EXIT_CODES.providerUnavailable,
    })
  }
}

export function createGitHubIssueCommandService(options: {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly fetch?: FetchLike
}): GitHubIssueCommandService {
  const request = options.fetch ?? globalThis.fetch
  return {
    async listIssues(input): Promise<readonly GitHubIssueSummary[]> {
      const repository = assertRepository(input.repository)
      const label = assertLabel(input.label)
      const token = options.environment.GITHUB_TOKEN ?? options.environment.GH_TOKEN
      const issues = new Map<number, GitHubIssueSummary>()
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = new URL(`https://api.github.com/repos/${repository}/issues`)
        url.searchParams.set("state", input.state)
        url.searchParams.set("per_page", String(PAGE_SIZE))
        url.searchParams.set("page", String(page))
        if (label) url.searchParams.set("labels", label)
        let response: Response
        try {
          response = await request(url, {
            method: "GET",
            redirect: "error",
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "ralph-tasks-sync",
              "X-GitHub-Api-Version": "2022-11-28",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            ...(input.signal ? { signal: input.signal } : {}),
          })
        } catch (error) {
          if (input.signal?.aborted) throw error
          throw new RalphError("RALPH_GITHUB_REQUEST_FAILED", "Could not read GitHub issues", {
            exitCode: EXIT_CODES.providerUnavailable,
            hint: "Check network access, repository spelling and GITHUB_TOKEN/GH_TOKEN when required.",
          })
        }
        if (!response.ok) {
          const remaining = response.headers.get("x-ratelimit-remaining")
          throw new RalphError(
            response.status === 401 || response.status === 403
              ? "RALPH_GITHUB_AUTH_FAILED"
              : "RALPH_GITHUB_REQUEST_FAILED",
            `GitHub issue request failed with HTTP ${response.status}`,
            {
              exitCode: EXIT_CODES.providerUnavailable,
              hint:
                remaining === "0"
                  ? "GitHub rate limit was exhausted; wait for reset or configure GITHUB_TOKEN/GH_TOKEN."
                  : "Check repository access and the non-secret credential reference.",
            },
          )
        }
        const decoded = await boundedJson(response)
        if (!Array.isArray(decoded)) {
          throw new RalphError(
            "RALPH_GITHUB_RESPONSE_INVALID",
            "GitHub issue response must be an array",
            { exitCode: EXIT_CODES.providerUnavailable },
          )
        }
        for (const raw of decoded) {
          const issue = responseIssue(raw)
          if (issue) issues.set(issue.number, issue)
        }
        if (decoded.length < PAGE_SIZE) {
          return [...issues.values()].sort((left, right) => left.number - right.number)
        }
      }
      throw new RalphError(
        "RALPH_GITHUB_ISSUE_LIMIT_EXCEEDED",
        `GitHub issue sync exceeds the ${MAX_PAGES * PAGE_SIZE} issue safety limit`,
        {
          exitCode: EXIT_CODES.policyDenied,
          hint: "Narrow the sync with --label or --state.",
        },
      )
    },
  }
}

function inline(value: string, fallback: string): string {
  const normalized = replaceAsciiControlCharacters(value, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240)
  const safe = normalized || fallback
  return safe.replace(/([\\*_[\]<>])/gu, "\\$1")
}

function yaml(value: string): string {
  return JSON.stringify(value)
}

function documentId(repository: string): string {
  const normalized = repository
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
  const prefix = /^[a-z]/u.test(normalized) ? normalized : `repo-${normalized}`
  return `${prefix || "github"}-issues`
}

function renderPrd(
  repository: string,
  state: GitHubIssueState,
  label: string | undefined,
  issues: readonly GitHubIssueSummary[],
): string {
  const source = `https://github.com/${repository}/issues`
  const taskLines = issues.flatMap((issue) => {
    const title = inline(issue.title, `GitHub issue ${issue.number}`)
    const url = `${source}/${issue.number}`
    const labels =
      issue.labels.length > 0
        ? issue.labels.map((value) => inline(value, "label")).join(", ")
        : "nenhuma"
    return [
      `- [ ] **gh-${issue.number} — ${title}**`,
      `  - Resultado: entregar a menor funcionalidade vertical que resolve a [issue #${issue.number}](${url}) de ponta a ponta no projeto atual.`,
      "  - Dependências: nenhuma",
      "  - Limites:",
      "    - Respeitar o escopo e os contratos descritos na issue sem escolher ou trocar linguagem, framework ou infraestrutura por preferência do agente.",
      "    - Não considerar o estado remoto da issue como prova automática de conclusão local.",
      "  - Modo de evidência: change-only",
      "  - Sub-PRD: nenhum",
      "  - Notas:",
      `    - Estado no momento da sincronização: ${issue.state}.`,
      `    - Labels no momento da sincronização: ${labels}.`,
      "",
    ]
  })
  return [
    "---",
    "ralph_prd: 2",
    `id: ${documentId(repository)}`,
    `title: ${yaml(`GitHub issues de ${repository}`)}`,
    "kind: root",
    "workspace: .",
    "defaults:",
    "  evidence_mode: change-only",
    "metadata:",
    `  source: ${yaml(source)}`,
    `  repository: ${yaml(repository)}`,
    `  issue_state_filter: ${yaml(state)}`,
    `  label_filter: ${label ? yaml(label) : "null"}`,
    "---",
    "",
    `# GitHub issues de ${repository}`,
    "",
    "## Contexto compartilhado",
    "",
    `Este PRD foi materializado deterministicamente a partir de [${repository}](${source}). A sincronização importa somente número, título, estado e labels; não transforma texto remoto não confiável em comandos, critérios artificiais ou sub-PRDs.`,
    "",
    "## Vertical slices",
    "",
    ...taskLines,
  ].join("\n")
}

async function targetSnapshot(path: string): Promise<{ exists: boolean; hash?: string }> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new RalphError(
        "RALPH_TASK_SYNC_OUTPUT_UNSAFE",
        "Task sync output must be a regular non-linked file",
        { exitCode: EXIT_CODES.policyDenied, file: path },
      )
    }
    return { exists: true, hash: sha256(await readFile(path)) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }
    throw error
  }
}

export async function syncGitHubIssueTasks(options: {
  readonly workspaceRoot: string
  readonly output: string
  readonly repository: string
  readonly state: GitHubIssueState
  readonly label?: string
  readonly force: boolean
  readonly service: GitHubIssueCommandService
  readonly signal?: AbortSignal
}): Promise<{
  readonly repository: string
  readonly state: GitHubIssueState
  readonly label?: string
  readonly output: string
  readonly issueCount: number
  readonly contentHash: string
  readonly overwritten: boolean
}> {
  const workspaceRoot = await canonicalDirectory(options.workspaceRoot)
  const repository = assertRepository(options.repository)
  const label = assertLabel(options.label)
  const requestedTarget = resolve(workspaceRoot, options.output)
  const parent = await canonicalDirectory(dirname(requestedTarget))
  const target = resolve(parent, basename(requestedTarget))
  const containment = relative(workspaceRoot, target)
  if (!containment || containment === ".." || containment.startsWith(`..${sep}`)) {
    throw new RalphError(
      "RALPH_TASK_SYNC_OUTPUT_OUTSIDE_WORKSPACE",
      "Task sync output must be a file inside the workspace",
      { exitCode: EXIT_CODES.policyDenied, file: target },
    )
  }
  const baseline = await targetSnapshot(target)
  if (baseline.exists && !options.force) {
    throw new RalphError(
      "RALPH_TASK_SYNC_OUTPUT_EXISTS",
      "Task sync refuses to overwrite an existing PRD without --force",
      { exitCode: EXIT_CODES.policyDenied, file: target },
    )
  }
  const issues = await options.service.listIssues({
    repository,
    state: options.state,
    ...(label ? { label } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (issues.length === 0) {
    throw new RalphError(
      "RALPH_GITHUB_ISSUES_EMPTY",
      "No GitHub issues matched the requested filters; no PRD was written",
      {
        exitCode: EXIT_CODES.invalidUsage,
        hint: "Change --state/--label or verify repository access.",
      },
    )
  }
  const source = renderPrd(repository, options.state, label, issues)
  const file = portable(relative(workspaceRoot, target))
  const parsed = parsePrdSource(source, { file })
  if (!parsed.ok || !parsed.document) {
    throw new RalphError(
      "RALPH_TASK_SYNC_GENERATED_PRD_INVALID",
      "The deterministic GitHub issue projection did not satisfy the PRD v2 schema",
      {
        exitCode: EXIT_CODES.operationalError,
        details: { diagnostics: parsed.diagnostics },
      },
    )
  }
  await writeFileAtomic(target, source, {
    overwrite: options.force,
    beforeCommit: async () => {
      const current = await targetSnapshot(target)
      if (current.exists !== baseline.exists || current.hash !== baseline.hash) {
        throw new RalphError(
          "RALPH_TASK_SYNC_OUTPUT_CHANGED",
          "Task sync output changed while GitHub issues were being read",
          {
            exitCode: EXIT_CODES.conflict,
            file: target,
            hint: "Inspect the current file and retry explicitly.",
          },
        )
      }
    },
  })
  return {
    repository,
    state: options.state,
    ...(label ? { label } : {}),
    output: target,
    issueCount: issues.length,
    contentHash: sha256(source),
    overwritten: baseline.exists,
  }
}
