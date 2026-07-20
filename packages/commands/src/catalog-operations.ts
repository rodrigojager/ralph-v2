import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises"
import { basename, extname, join, relative, resolve, sep } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  canonicalDirectory,
  inspectWorkspace,
  workspaceLayout,
  writeFileAtomic,
} from "@ralph-next/persistence"

const MAX_CATALOG_FILES = 256
const MAX_CATALOG_FILE_BYTES = 1024 * 1024
const CATALOG_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const RULES_HEADER = [
  "# Ralph workspace rules",
  "",
  "These human-readable rules are added explicitly by command authority and may be included in future task context manifests.",
  "",
].join("\n")

export type CatalogEntry = {
  readonly id: string
  readonly kind: "adapter" | "recipe"
  readonly status: "disabled" | "draft" | "quarantined"
  readonly source: "workspace" | "ralph-v1-quarantine"
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex")
}

function portable(path: string): string {
  return path.split(sep).join("/")
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`))
}

function catalogId(value: string): string {
  const id = value.trim()
  if (!CATALOG_ID.test(id)) {
    throw new RalphError(
      "RALPH_CATALOG_ID_INVALID",
      "Catalog IDs must be lowercase kebab-case and start with a letter",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  return id
}

async function workspaceState(root: string): Promise<{
  root: string
  ralph: string
}> {
  const canonical = await canonicalDirectory(root)
  const workspace = await inspectWorkspace(canonical, { exact: true })
  if (!workspace.initialized) {
    throw new RalphError(
      "RALPH_CATALOG_WORKSPACE_REQUIRED",
      "Catalog and rule commands require an initialized Ralph v2 workspace",
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Run `ralph-next init` in this workspace first.",
      },
    )
  }
  const ralph = workspaceLayout(canonical).ralph
  const info = await lstat(ralph)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new RalphError(
      "RALPH_CATALOG_STATE_UNSAFE",
      "Ralph managed state must be a regular non-linked directory",
      { exitCode: EXIT_CODES.policyDenied, file: ralph },
    )
  }
  return { root: canonical, ralph }
}

async function safeDirectory(
  state: { root: string; ralph: string },
  segments: readonly string[],
  create: boolean,
): Promise<string | undefined> {
  let current = state.ralph
  for (const segment of segments) {
    const candidate = join(current, segment)
    try {
      const info = await lstat(candidate)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new RalphError(
          "RALPH_CATALOG_DIRECTORY_UNSAFE",
          "Catalog paths must be regular non-linked directories",
          { exitCode: EXIT_CODES.policyDenied, file: candidate },
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (!create) return undefined
      await mkdir(candidate)
      const created = await lstat(candidate)
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new RalphError(
          "RALPH_CATALOG_DIRECTORY_UNSAFE",
          "Catalog path changed while it was created",
          { exitCode: EXIT_CODES.conflict, file: candidate },
        )
      }
    }
    current = candidate
  }
  const canonical = await realpath(current)
  if (!contained(state.root, canonical)) {
    throw new RalphError(
      "RALPH_CATALOG_PATH_ESCAPE",
      "Catalog path resolves outside the workspace",
      { exitCode: EXIT_CODES.policyDenied, file: current },
    )
  }
  return canonical
}

async function fileSnapshot(path: string): Promise<{
  exists: boolean
  bytes?: Uint8Array
  hash?: string
}> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new RalphError(
        "RALPH_CATALOG_FILE_UNSAFE",
        "Catalog files must be regular and non-linked",
        { exitCode: EXIT_CODES.policyDenied, file: path },
      )
    }
    if (info.size > MAX_CATALOG_FILE_BYTES) {
      throw new RalphError(
        "RALPH_CATALOG_FILE_TOO_LARGE",
        "Catalog file exceeds the bounded file limit",
        { exitCode: EXIT_CODES.policyDenied, file: path },
      )
    }
    const bytes = await readFile(path)
    return { exists: true, bytes, hash: sha256(bytes) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }
    throw error
  }
}

async function guardedWrite(
  path: string,
  content: string,
  options: { force: boolean },
): Promise<{ overwritten: boolean; sha256: string }> {
  const baseline = await fileSnapshot(path)
  if (baseline.exists && !options.force) {
    throw new RalphError("RALPH_CATALOG_FILE_EXISTS", "Catalog file already exists", {
      exitCode: EXIT_CODES.policyDenied,
      file: path,
      hint: "Inspect it first or repeat with --force.",
    })
  }
  await writeFileAtomic(path, content, {
    overwrite: options.force,
    beforeCommit: async () => {
      const current = await fileSnapshot(path)
      if (current.exists !== baseline.exists || current.hash !== baseline.hash) {
        throw new RalphError(
          "RALPH_CATALOG_FILE_CHANGED",
          "Catalog file changed before the atomic write committed",
          { exitCode: EXIT_CODES.conflict, file: path },
        )
      }
    },
  })
  return { overwritten: baseline.exists, sha256: sha256(content) }
}

async function directoryEntries(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  if (entries.length > MAX_CATALOG_FILES) {
    throw new RalphError(
      "RALPH_CATALOG_FILE_LIMIT_EXCEEDED",
      `Catalog contains more than ${MAX_CATALOG_FILES} entries`,
      { exitCode: EXIT_CODES.policyDenied, file: path },
    )
  }
  const names: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new RalphError(
        "RALPH_CATALOG_FILE_UNSAFE",
        "Catalog directories may not contain symbolic links",
        { exitCode: EXIT_CODES.policyDenied, file: join(path, entry.name) },
      )
    }
    if (entry.isFile()) names.push(entry.name)
  }
  return names.sort((left, right) => left.localeCompare(right, "en"))
}

async function listDirectory(
  state: { root: string; ralph: string },
  path: string | undefined,
  kind: "adapter" | "recipe",
  source: CatalogEntry["source"],
): Promise<CatalogEntry[]> {
  if (!path) return []
  const extension = kind === "adapter" ? ".json" : ".md"
  const output: CatalogEntry[] = []
  for (const name of await directoryEntries(path)) {
    if (extname(name).toLocaleLowerCase("en") !== extension) continue
    const file = join(path, name)
    const snapshot = await fileSnapshot(file)
    if (!snapshot.exists || !snapshot.bytes || !snapshot.hash) continue
    output.push({
      id: basename(name, extension),
      kind,
      status:
        source === "ralph-v1-quarantine"
          ? "quarantined"
          : kind === "adapter"
            ? "disabled"
            : "draft",
      source,
      path: portable(relative(state.root, file)),
      bytes: snapshot.bytes.byteLength,
      sha256: snapshot.hash,
    })
  }
  return output
}

export async function listCatalogEntries(options: {
  readonly workspaceRoot: string
  readonly kind: "adapter" | "recipe"
}): Promise<readonly CatalogEntry[]> {
  const state = await workspaceState(options.workspaceRoot)
  const local = await safeDirectory(
    state,
    ["catalog", options.kind === "adapter" ? "adapters" : "recipes"],
    false,
  )
  const imported = await safeDirectory(
    state,
    ["imports", "ralph-v1", options.kind === "adapter" ? "adapters" : "recipes"],
    false,
  )
  const entries = [
    ...(await listDirectory(state, local, options.kind, "workspace")),
    ...(await listDirectory(state, imported, options.kind, "ralph-v1-quarantine")),
  ]
  return entries.sort((left, right) =>
    `${left.id}:${left.source}`.localeCompare(`${right.id}:${right.source}`, "en"),
  )
}

function adapterManifest(id: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "ralph-next-adapter-draft",
      id,
      status: "disabled",
      description: "",
      capabilities: {
        modelCalls: false,
        toolCalls: false,
        workspaceWrites: false,
        network: false,
      },
      activation: {
        automatic: false,
        note: "Convert this data-only draft into an explicit validated profile before use.",
      },
    },
    null,
    2,
  )}\n`
}

function recipeDocument(id: string): string {
  return [
    "---",
    "ralph_recipe: 1",
    `id: ${id}`,
    "status: draft",
    "---",
    "",
    `# ${id}`,
    "",
    "## Purpose",
    "",
    "Describe the reusable, language-neutral workflow this recipe supports.",
    "",
    "## Inputs",
    "",
    "- Declare only explicit, bounded inputs.",
    "",
    "## Steps",
    "",
    "1. Describe command-authorized steps. This draft is never executed automatically.",
    "",
    "## Completion evidence",
    "",
    "- Describe deterministic evidence when it exists; do not invent superficial criteria.",
    "",
  ].join("\n")
}

export async function createCatalogEntry(options: {
  readonly workspaceRoot: string
  readonly kind: "adapter" | "recipe"
  readonly id: string
  readonly force: boolean
}): Promise<{
  readonly id: string
  readonly kind: "adapter" | "recipe"
  readonly status: "disabled" | "draft"
  readonly path: string
  readonly sha256: string
  readonly overwritten: boolean
  readonly activation: "manual"
}> {
  const state = await workspaceState(options.workspaceRoot)
  const id = catalogId(options.id)
  const directory = await safeDirectory(
    state,
    ["catalog", options.kind === "adapter" ? "adapters" : "recipes"],
    true,
  )
  if (!directory) {
    throw new RalphError(
      "RALPH_CATALOG_DIRECTORY_MISSING",
      "Catalog directory was not available after explicit creation",
      { exitCode: EXIT_CODES.operationalError },
    )
  }
  const path = join(directory, `${id}${options.kind === "adapter" ? ".json" : ".md"}`)
  const content = options.kind === "adapter" ? adapterManifest(id) : recipeDocument(id)
  const result = await guardedWrite(path, content, { force: options.force })
  return {
    id,
    kind: options.kind,
    status: options.kind === "adapter" ? "disabled" : "draft",
    path: portable(relative(state.root, path)),
    sha256: result.sha256,
    overwritten: result.overwritten,
    activation: "manual",
  }
}

function replaceAsciiControlCharacters(
  value: string,
  replacement: string,
  preserveFormattingWhitespace = false,
): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0
    const preserved =
      preserveFormattingWhitespace && (codePoint === 9 || codePoint === 10 || codePoint === 13)
    return !preserved && (codePoint < 32 || codePoint === 127) ? replacement : character
  }).join("")
}

function safeText(bytes: Uint8Array): string {
  return replaceAsciiControlCharacters(Buffer.from(bytes).toString("utf8"), "�", true)
}

function adapterManifestInvalid(path: string, message: string): never {
  throw new RalphError("RALPH_ADAPTER_MANIFEST_INVALID", message, {
    exitCode: EXIT_CODES.invalidUsage,
    file: path,
  })
}

function localAdapterProjection(
  value: Record<string, unknown>,
  entry: CatalogEntry,
  path: string,
): Record<string, unknown> {
  const allowed = new Set([
    "schemaVersion",
    "kind",
    "id",
    "status",
    "description",
    "capabilities",
    "activation",
  ])
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "ralph-next-adapter-draft" ||
    value.id !== entry.id ||
    value.status !== "disabled" ||
    typeof value.description !== "string" ||
    value.description.length > 500 ||
    unknown.length > 0
  ) {
    return adapterManifestInvalid(path, "Workspace adapter draft does not satisfy schema v1")
  }
  if (
    !value.capabilities ||
    typeof value.capabilities !== "object" ||
    Array.isArray(value.capabilities)
  ) {
    return adapterManifestInvalid(path, "Adapter capabilities must be an object")
  }
  const capabilities = value.capabilities as Record<string, unknown>
  const capabilityKeys = ["modelCalls", "toolCalls", "workspaceWrites", "network"] as const
  const capabilityKeySet = new Set<string>(capabilityKeys)
  if (
    Object.keys(capabilities).some((key) => !capabilityKeySet.has(key)) ||
    capabilityKeys.some((key) => typeof capabilities[key] !== "boolean")
  ) {
    return adapterManifestInvalid(path, "Adapter capabilities must use the four schema v1 booleans")
  }
  if (
    !value.activation ||
    typeof value.activation !== "object" ||
    Array.isArray(value.activation)
  ) {
    return adapterManifestInvalid(path, "Adapter activation must be an object")
  }
  const activation = value.activation as Record<string, unknown>
  if (
    activation.automatic !== false ||
    typeof activation.note !== "string" ||
    activation.note.length > 500 ||
    Object.keys(activation).some((key) => key !== "automatic" && key !== "note")
  ) {
    return adapterManifestInvalid(path, "Adapter draft activation must remain manual and bounded")
  }
  return {
    schemaVersion: 1,
    kind: value.kind,
    id: value.id,
    status: value.status,
    capabilities: {
      modelCalls: capabilities.modelCalls,
      toolCalls: capabilities.toolCalls,
      workspaceWrites: capabilities.workspaceWrites,
      network: capabilities.network,
    },
    activation: "manual-profile-conversion-required",
    automaticLoad: false,
    omittedFields: ["description", "activation.note"],
  }
}

function quarantinedAdapterProjection(
  value: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  if (
    value.schemaVersion !== 1 ||
    value.status !== "quarantined" ||
    value.activation !== "manual-profile-conversion-required" ||
    typeof value.source !== "string" ||
    value.source.length > 1_024 ||
    typeof value.sourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sourceSha256)
  ) {
    return adapterManifestInvalid(path, "Quarantined adapter metadata does not satisfy schema v1")
  }
  return {
    schemaVersion: 1,
    status: value.status,
    activation: value.activation,
    source: value.source,
    sourceSha256: value.sourceSha256,
    note: "Quarantined legacy metadata is never activated or executed by inspection.",
  }
}

function validateLocalRecipe(content: string, entry: CatalogEntry, path: string): void {
  const normalized = content.replaceAll("\r\n", "\n")
  const prefix = ["---", "ralph_recipe: 1", `id: ${entry.id}`, "status: draft", "---", ""].join(
    "\n",
  )
  if (!normalized.startsWith(prefix)) {
    throw new RalphError(
      "RALPH_RECIPE_DOCUMENT_INVALID",
      "Workspace recipe does not satisfy the human-readable recipe v1 header",
      { exitCode: EXIT_CODES.invalidUsage, file: path },
    )
  }
}

export async function inspectCatalogEntry(options: {
  readonly workspaceRoot: string
  readonly kind: "adapter" | "recipe"
  readonly id: string
}): Promise<{
  readonly entry: CatalogEntry
  readonly content?: string
  readonly manifest?: Record<string, unknown>
}> {
  const id = catalogId(options.id)
  const entries = await listCatalogEntries({
    workspaceRoot: options.workspaceRoot,
    kind: options.kind,
  })
  const matches = entries.filter((entry) => entry.id === id)
  if (matches.length !== 1) {
    throw new RalphError(
      matches.length === 0 ? "RALPH_CATALOG_ENTRY_NOT_FOUND" : "RALPH_CATALOG_ENTRY_AMBIGUOUS",
      matches.length === 0
        ? `Catalog entry was not found: ${id}`
        : `Catalog entry is ambiguous between workspace and quarantine: ${id}`,
      { exitCode: matches.length === 0 ? EXIT_CODES.invalidUsage : EXIT_CODES.conflict },
    )
  }
  const state = await workspaceState(options.workspaceRoot)
  const entry = matches[0] as CatalogEntry
  const path = resolve(state.root, entry.path)
  if (!contained(state.root, path)) {
    throw new RalphError("RALPH_CATALOG_PATH_ESCAPE", "Catalog entry resolves outside workspace", {
      exitCode: EXIT_CODES.policyDenied,
      file: path,
    })
  }
  const snapshot = await fileSnapshot(path)
  if (!snapshot.exists || !snapshot.bytes || snapshot.hash !== entry.sha256) {
    throw new RalphError(
      "RALPH_CATALOG_FILE_CHANGED",
      "Catalog entry changed while it was being inspected",
      { exitCode: EXIT_CODES.conflict, file: path },
    )
  }
  if (options.kind === "recipe") {
    const content = safeText(snapshot.bytes)
    if (entry.source === "workspace") validateLocalRecipe(content, entry, path)
    return { entry, content }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(safeText(snapshot.bytes))
  } catch {
    throw new RalphError("RALPH_ADAPTER_MANIFEST_INVALID", "Adapter manifest is not valid JSON", {
      exitCode: EXIT_CODES.invalidUsage,
      file: path,
    })
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new RalphError("RALPH_ADAPTER_MANIFEST_INVALID", "Adapter manifest must be an object", {
      exitCode: EXIT_CODES.invalidUsage,
      file: path,
    })
  }
  const value = decoded as Record<string, unknown>
  const manifest =
    entry.source === "workspace"
      ? localAdapterProjection(value, entry, path)
      : quarantinedAdapterProjection(value, path)
  return { entry, manifest }
}

function normalizeRule(value: string): string {
  const rule = replaceAsciiControlCharacters(value, " ").replace(/\s+/gu, " ").trim()
  if (!rule || rule.length > 500) {
    throw new RalphError(
      "RALPH_RULE_INVALID",
      "A rule must contain between 1 and 500 visible characters",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  return rule
}

function parseRules(content: string, path: string): string[] {
  const normalized = content.replaceAll("\r\n", "\n")
  if (!normalized.startsWith(RULES_HEADER)) {
    throw new RalphError(
      "RALPH_RULES_DOCUMENT_INVALID",
      "Rules document does not satisfy the human-readable rules v1 header",
      { exitCode: EXIT_CODES.invalidUsage, file: path },
    )
  }
  const lines = normalized.slice(RULES_HEADER.length).split("\n")
  const rules: string[] = []
  for (const line of lines) {
    if (line === "") continue
    const match = /^- (.+)$/u.exec(line)
    if (!match?.[1] || normalizeRule(match[1]) !== match[1]) {
      throw new RalphError(
        "RALPH_RULES_DOCUMENT_INVALID",
        "Rules document contains a noncanonical or unbounded entry",
        { exitCode: EXIT_CODES.invalidUsage, file: path },
      )
    }
    rules.push(match[1])
  }
  return rules
}

async function rulesPath(options: { workspaceRoot: string }): Promise<{
  state: { root: string; ralph: string }
  path: string
}> {
  const state = await workspaceState(options.workspaceRoot)
  return { state, path: join(state.ralph, "rules.md") }
}

export async function listWorkspaceRules(options: { readonly workspaceRoot: string }): Promise<{
  readonly path: string
  readonly count: number
  readonly rules: readonly string[]
  readonly sha256?: string
}> {
  const { state, path } = await rulesPath(options)
  const snapshot = await fileSnapshot(path)
  const rules = snapshot.bytes ? parseRules(safeText(snapshot.bytes), path) : []
  return {
    path: portable(relative(state.root, path)),
    count: rules.length,
    rules,
    ...(snapshot.hash ? { sha256: snapshot.hash } : {}),
  }
}

export async function addWorkspaceRule(options: {
  readonly workspaceRoot: string
  readonly rule: string
}): Promise<{
  readonly path: string
  readonly rule: string
  readonly changed: boolean
  readonly count: number
  readonly sha256: string
}> {
  const { state, path } = await rulesPath(options)
  const rule = normalizeRule(options.rule)
  const baseline = await fileSnapshot(path)
  const currentRules = baseline.bytes ? parseRules(safeText(baseline.bytes), path) : []
  if (currentRules.includes(rule)) {
    return {
      path: portable(relative(state.root, path)),
      rule,
      changed: false,
      count: currentRules.length,
      sha256: baseline.hash ?? sha256(RULES_HEADER),
    }
  }
  const rules = [...currentRules, rule]
  const content = `${RULES_HEADER}${rules.map((item) => `- ${item}`).join("\n")}\n`
  await writeFileAtomic(path, content, {
    overwrite: baseline.exists,
    beforeCommit: async () => {
      const current = await fileSnapshot(path)
      if (current.exists !== baseline.exists || current.hash !== baseline.hash) {
        throw new RalphError("RALPH_RULES_CHANGED", "Rules changed before add committed", {
          exitCode: EXIT_CODES.conflict,
          file: path,
        })
      }
    },
  })
  return {
    path: portable(relative(state.root, path)),
    rule,
    changed: true,
    count: rules.length,
    sha256: sha256(content),
  }
}

export async function clearWorkspaceRules(options: {
  readonly workspaceRoot: string
  readonly force: boolean
}): Promise<{
  readonly path: string
  readonly cleared: number
  readonly sha256: string
}> {
  if (!options.force) {
    throw new RalphError(
      "RALPH_RULES_CLEAR_CONFIRMATION_REQUIRED",
      "rules clear requires --force after inspecting the current rules",
      { exitCode: EXIT_CODES.policyDenied },
    )
  }
  const { state, path } = await rulesPath(options)
  const baseline = await fileSnapshot(path)
  const current = baseline.bytes ? parseRules(safeText(baseline.bytes), path) : []
  await writeFileAtomic(path, RULES_HEADER, {
    overwrite: baseline.exists,
    beforeCommit: async () => {
      const candidate = await fileSnapshot(path)
      if (candidate.exists !== baseline.exists || candidate.hash !== baseline.hash) {
        throw new RalphError("RALPH_RULES_CHANGED", "Rules changed before clear committed", {
          exitCode: EXIT_CODES.conflict,
          file: path,
        })
      }
    },
  })
  return {
    path: portable(relative(state.root, path)),
    cleared: current.length,
    sha256: sha256(RULES_HEADER),
  }
}
