/**
 * Canonical command catalog shared by parser, help and completion/palette adapters.
 * Entries describe the public spelling, not handler
 * implementation details, so a headless client can discover the same surface
 * without importing the TUI.
 */
export type CommandCompatibility = "compatible" | "changed" | "deprecated" | "removed"

export type CommandMetadata = {
  readonly canonical: string
  readonly name: string
  readonly aliases: readonly string[]
  readonly summary: string
  readonly compatibility: CommandCompatibility
  readonly replacement?: string
  readonly removalVersion?: string
}

export const COMMAND_REGISTRY = [
  {
    canonical: "init",
    name: "init",
    aliases: ["setup"],
    summary: "Initialize an isolated Ralph v2 workspace",
    compatibility: "compatible",
  },
  {
    canonical: "clean",
    name: "clean",
    aliases: [],
    summary: "Preview or remove only identified Ralph v2 managed state",
    compatibility: "changed",
  },
  {
    canonical: "once",
    name: "once",
    aliases: [],
    summary: "Execute one ad-hoc description or one explicit/eligible PRD task",
    compatibility: "changed",
  },
  {
    canonical: "run",
    name: "run",
    aliases: [],
    summary: "Execute eligible PRD tasks with bounded orchestration",
    compatibility: "compatible",
  },
  {
    canonical: "loop",
    name: "loop",
    aliases: [],
    summary: "Run the same bounded orchestration through the loop spelling",
    compatibility: "compatible",
  },
  {
    canonical: "parallel",
    name: "parallel",
    aliases: [],
    summary: "Execute structurally independent PRD tasks in isolated workers",
    compatibility: "compatible",
  },
  {
    canonical: "verify",
    name: "verify",
    aliases: [],
    summary: "Re-run gates and persist fresh evidence without an executor or PRD marker mutation",
    compatibility: "changed",
  },
  {
    canonical: "judge",
    name: "judge",
    aliases: [],
    summary:
      "Evaluate one existing evidence bundle with a configured read-only self or external judge",
    compatibility: "changed",
  },
  {
    canonical: "status",
    name: "status",
    aliases: [],
    summary: "Show workspace and event-ledger status",
    compatibility: "compatible",
  },
  {
    canonical: "status.run",
    name: "status run",
    aliases: [],
    summary: "Show the status of a persisted execution run",
    compatibility: "changed",
  },
  {
    canonical: "resume",
    name: "resume",
    aliases: [],
    summary: "Require and continue one compatible non-terminal run",
    compatibility: "changed",
  },
  {
    canonical: "stop",
    name: "stop",
    aliases: ["cancel"],
    summary: "Request a durable graceful stop for a persisted run",
    compatibility: "compatible",
  },
  {
    canonical: "attach",
    name: "attach",
    aliases: ["ui"],
    summary: "Open the read-only live TUI for a persisted run",
    compatibility: "changed",
  },
  {
    canonical: "replay",
    name: "replay",
    aliases: [],
    summary: "Open a frozen read-only TUI projection for a persisted run",
    compatibility: "changed",
  },
  {
    canonical: "events",
    name: "events",
    aliases: [],
    summary: "Read persisted run events, including JSONL output",
    compatibility: "compatible",
  },
  {
    canonical: "logs.tail",
    name: "logs tail",
    aliases: [],
    summary: "Read or follow redacted human, audit, engine, tool, gate or diagnostic logs",
    compatibility: "compatible",
  },
  {
    canonical: "report.last",
    name: "report last",
    aliases: [],
    summary: "Show the most recent run report",
    compatibility: "compatible",
  },
  {
    canonical: "report.show",
    name: "report show",
    aliases: [],
    summary: "Show a run report selected by run ID",
    compatibility: "changed",
  },
  {
    canonical: "tasks.list",
    name: "tasks list",
    aliases: [],
    summary: "List parsed PRD tasks and their stable references",
    compatibility: "compatible",
  },
  {
    canonical: "tasks.next",
    name: "tasks next",
    aliases: [],
    summary: "Show the first dependency-eligible unfinished task",
    compatibility: "compatible",
  },
  {
    canonical: "tasks.done",
    name: "tasks done",
    aliases: [],
    summary: "Record an audited evidence-backed manual completion override",
    compatibility: "changed",
  },
  {
    canonical: "tasks.sync",
    name: "tasks sync",
    aliases: [],
    summary: "Project GitHub issues into a deterministic human-readable PRD v2",
    compatibility: "changed",
  },
  {
    canonical: "migrate.inspect",
    name: "migrate inspect",
    aliases: [],
    summary: "Inspect a Ralph v1 workspace without writing either workspace",
    compatibility: "changed",
  },
  {
    canonical: "migrate.apply",
    name: "migrate apply",
    aliases: [],
    summary: "Create a separate Ralph v2 workspace and rollback manifest",
    compatibility: "changed",
  },
  {
    canonical: "migrate.rollback",
    name: "migrate rollback",
    aliases: [],
    summary: "Preview or remove only unchanged files bound to a migration rollback manifest",
    compatibility: "changed",
  },
  {
    canonical: "doctor",
    name: "doctor",
    aliases: [],
    summary: "Check runtime, Git, filesystem, TTY and workspace",
    compatibility: "compatible",
  },
  {
    canonical: "config.explain",
    name: "config explain",
    aliases: [],
    summary: "Explain one effective config value and source",
    compatibility: "changed",
  },
  {
    canonical: "config.list",
    name: "config list",
    aliases: [],
    summary: "List the effective configuration",
    compatibility: "compatible",
  },
  {
    canonical: "config.get",
    name: "config get",
    aliases: [],
    summary: "Read one effective config key without exposing secret material",
    compatibility: "compatible",
  },
  {
    canonical: "config.preview",
    name: "config preview",
    aliases: [],
    summary: "Validate one setting and preview its config and run equivalents",
    compatibility: "changed",
  },
  {
    canonical: "config.set",
    name: "config set",
    aliases: [],
    summary: "Atomically save one validated workspace or global default",
    compatibility: "compatible",
  },
  {
    canonical: "config.unset",
    name: "config unset",
    aliases: ["config reset"],
    summary: "Atomically remove one schema-known non-profile default from an explicit scope",
    compatibility: "changed",
  },
  {
    canonical: "config.edit",
    name: "config edit",
    aliases: [],
    summary: "Edit one validated config layer through a composed editor or explicit input file",
    compatibility: "changed",
  },
  {
    canonical: "config.import",
    name: "config import",
    aliases: [],
    summary: "Preview or merge a bounded typed YAML/JSON config without secret material",
    compatibility: "changed",
  },
  {
    canonical: "config.export",
    name: "config export",
    aliases: [],
    summary: "Emit a redacted YAML/JSON layer or effective snapshot without resolving secrets",
    compatibility: "changed",
  },
  {
    canonical: "config.validate",
    name: "config validate",
    aliases: [],
    summary: "Validate global, workspace and effective configuration layers",
    compatibility: "changed",
  },
  {
    canonical: "prd.validate",
    name: "prd validate",
    aliases: [],
    summary: "Validate a v2 or classic PRD deterministically",
    compatibility: "changed",
  },
  {
    canonical: "prd.inspect",
    name: "prd inspect",
    aliases: [],
    summary: "Print the typed document or recursive graph",
    compatibility: "changed",
  },
  {
    canonical: "prd.format",
    name: "prd format",
    aliases: [],
    summary: "Canonicalize v2 task grammar without losing context",
    compatibility: "changed",
  },
  {
    canonical: "prd.migrate",
    name: "prd migrate",
    aliases: [],
    summary: "Migrate a classic PRD with an explicit loss report",
    compatibility: "changed",
  },
  {
    canonical: "providers.list",
    name: "providers list",
    aliases: [],
    summary: "List embedded provider descriptors",
    compatibility: "changed",
  },
  {
    canonical: "providers.inspect",
    name: "providers inspect",
    aliases: [],
    summary: "Inspect one provider and its auth methods",
    compatibility: "changed",
  },
  {
    canonical: "models.list",
    name: "models list",
    aliases: [],
    summary: "List models and filter required capabilities",
    compatibility: "changed",
  },
  {
    canonical: "models.inspect",
    name: "models inspect",
    aliases: [],
    summary: "Inspect one model, limits, access and catalog source",
    compatibility: "changed",
  },
  {
    canonical: "auth.connect",
    name: "auth connect",
    aliases: ["connect"],
    summary: "Connect a credential without putting secrets in argv",
    compatibility: "changed",
  },
  {
    canonical: "auth.list",
    name: "auth list",
    aliases: [],
    summary: "List non-secret credential references",
    compatibility: "changed",
  },
  {
    canonical: "auth.status",
    name: "auth status",
    aliases: [],
    summary: "Check credential availability and expiry metadata",
    compatibility: "changed",
  },
  {
    canonical: "auth.revoke",
    name: "auth revoke",
    aliases: [],
    summary: "Revoke and remove one credential reference",
    compatibility: "changed",
  },
  {
    canonical: "adapters.list",
    name: "adapters list",
    aliases: [],
    summary: "List disabled workspace drafts and quarantined legacy adapter metadata",
    compatibility: "changed",
  },
  {
    canonical: "adapters.new",
    name: "adapters new",
    aliases: [],
    summary: "Create a data-only disabled adapter draft without loading code",
    compatibility: "changed",
  },
  {
    canonical: "adapters.inspect",
    name: "adapters inspect",
    aliases: [],
    summary: "Inspect bounded adapter metadata without activation or execution",
    compatibility: "changed",
  },
  {
    canonical: "recipes.list",
    name: "recipes list",
    aliases: [],
    summary: "List workspace recipe drafts and quarantined legacy documents",
    compatibility: "changed",
  },
  {
    canonical: "recipes.new",
    name: "recipes new",
    aliases: [],
    summary: "Create a language-neutral human-readable recipe draft",
    compatibility: "changed",
  },
  {
    canonical: "recipes.show",
    name: "recipes show",
    aliases: [],
    summary: "Show one bounded non-executable recipe document",
    compatibility: "changed",
  },
  {
    canonical: "rules.list",
    name: "rules list",
    aliases: [],
    summary: "List explicit human-readable workspace rules",
    compatibility: "changed",
  },
  {
    canonical: "rules.add",
    name: "rules add",
    aliases: [],
    summary: "Append one bounded workspace rule atomically",
    compatibility: "changed",
  },
  {
    canonical: "rules.clear",
    name: "rules clear",
    aliases: [],
    summary: "Clear workspace rules only after explicit --force",
    compatibility: "changed",
  },
  {
    canonical: "context.inspect",
    name: "context inspect",
    aliases: ["context show"],
    summary: "Inspect persisted context metadata and integrity without exposing context bodies",
    compatibility: "changed",
  },
  {
    canonical: "context.export",
    name: "context export",
    aliases: [],
    summary: "Export bounded metadata-only context inspection to a workspace file",
    compatibility: "changed",
  },
  {
    canonical: "context.rotate",
    name: "context rotate",
    aliases: ["context refresh"],
    summary: "Request rotation through an explicitly composed supervisor control port",
    compatibility: "changed",
  },
  {
    canonical: "checkpoint.create",
    name: "checkpoint create",
    aliases: ["checkpoints create"],
    summary: "Create an explicit immutable workspace checkpoint with Git, PRD and ledger bindings",
    compatibility: "changed",
  },
  {
    canonical: "checkpoint.list",
    name: "checkpoint list",
    aliases: ["checkpoints list"],
    summary: "List compact persisted checkpoint metadata without restoring anything",
    compatibility: "changed",
  },
  {
    canonical: "checkpoint.show",
    name: "checkpoint show",
    aliases: ["checkpoints show"],
    summary: "Inspect one checkpoint through a bounded file preview",
    compatibility: "changed",
  },
  {
    canonical: "rollback.preview",
    name: "rollback preview",
    aliases: [],
    summary:
      "Persist a non-mutating rollback plan bound to current files, Git, PRD and ledger state",
    compatibility: "changed",
  },
  {
    canonical: "rollback.apply",
    name: "rollback apply",
    aliases: [],
    summary:
      "Apply an exact rollback plan only with its explicit plan hash and a safety checkpoint",
    compatibility: "changed",
  },
  {
    canonical: "lang.current",
    name: "lang current",
    aliases: [],
    summary: "Show configured locale, source and effective presentation locale",
    compatibility: "changed",
  },
  {
    canonical: "lang.list",
    name: "lang list",
    aliases: [],
    summary: "List bundled human-facing locales",
    compatibility: "compatible",
  },
  {
    canonical: "lang.set",
    name: "lang set",
    aliases: [],
    summary: "Save a bundled locale for future runs in an explicit scope",
    compatibility: "changed",
  },
  {
    canonical: "lang.update",
    name: "lang update",
    aliases: [],
    summary: "Report release-managed language catalog update capability",
    compatibility: "changed",
  },
  {
    canonical: "install",
    name: "install",
    aliases: [],
    summary: "Install one verified standalone release into an isolated versioned root",
    compatibility: "changed",
  },
  {
    canonical: "update",
    name: "update",
    aliases: [],
    summary:
      "Stage and atomically activate a verified standalone engine without replacing the running launcher",
    compatibility: "changed",
  },
  {
    canonical: "install.rollback",
    name: "rollback",
    aliases: [],
    summary:
      "Atomically reactivate a receipt-bound installed version without touching workspace state",
    compatibility: "changed",
  },
  {
    canonical: "uninstall",
    name: "uninstall",
    aliases: [],
    summary:
      "Remove only receipt-owned standalone files while preserving config, credentials and workspaces",
    compatibility: "changed",
  },
  {
    canonical: "profiles.list",
    name: "profiles list",
    aliases: [],
    summary: "List independent executor and judge profiles",
    compatibility: "changed",
  },
  {
    canonical: "profiles.inspect",
    name: "profiles inspect",
    aliases: [],
    summary: "Inspect one resolved role profile",
    compatibility: "changed",
  },
  {
    canonical: "profiles.configure",
    name: "profiles configure",
    aliases: [],
    summary:
      "Configure or inherit exact role-profile layer fields through shared CLI/form metadata",
    compatibility: "changed",
  },
  {
    canonical: "evidence.inspect",
    name: "evidence inspect",
    aliases: [],
    summary: "Verify and inspect one attempt evidence bundle",
    compatibility: "changed",
  },
  {
    canonical: "review.retry",
    name: "review retry",
    aliases: [],
    summary: "Grant audited judge revisions to a task awaiting manual review",
    compatibility: "changed",
  },
  {
    canonical: "model.smoke",
    name: "model smoke",
    aliases: [],
    summary: "Make a read-only, no-tools model smoke call",
    compatibility: "changed",
  },
  {
    canonical: "about",
    name: "about",
    aliases: [],
    summary: "Describe Ralph v2 and its authority model",
    compatibility: "compatible",
  },
  {
    canonical: "version",
    name: "version",
    aliases: ["--version", "-V"],
    summary: "Print the Ralph v2 version",
    compatibility: "compatible",
  },
  {
    canonical: "help",
    name: "help",
    aliases: ["--help", "-h"],
    summary: "Show this help",
    compatibility: "compatible",
  },
] as const satisfies readonly CommandMetadata[]

export type CanonicalCommand = (typeof COMMAND_REGISTRY)[number]["canonical"]

export const COMMAND_METADATA: readonly CommandMetadata[] = COMMAND_REGISTRY

export type CommandDiscoveryEntry = CommandMetadata & {
  readonly spellings: readonly string[]
}

export const COMMAND_DISCOVERY: readonly CommandDiscoveryEntry[] = COMMAND_REGISTRY.map(
  (entry) => ({
    ...entry,
    spellings: [entry.name, ...entry.aliases],
  }),
)

export type ResolvedCommandSpelling = {
  readonly command: CanonicalCommand
  readonly consumed: number
  readonly spelling: string
  readonly alias: boolean
}

export type CommandCompletionEntry = {
  readonly command: CanonicalCommand
  readonly value: string
  readonly alias: boolean
  readonly summary: string
  readonly compatibility: CommandCompatibility
  readonly replacement?: string
  readonly removalVersion?: string
}

export type CommandPaletteEntry = {
  readonly command: CanonicalCommand
  readonly label: string
  readonly aliases: readonly string[]
  readonly summary: string
  readonly compatibility: CommandCompatibility
  readonly replacement?: string
  readonly removalVersion?: string
  readonly searchText: string
}

type IndexedCommandSpelling = {
  readonly command: CanonicalCommand
  readonly spelling: string
  readonly tokens: readonly string[]
  readonly alias: boolean
  readonly metadata: CommandMetadata
}

function normalizedSpelling(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function compareCommandSpelling(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function buildCommandSpellingIndex(): readonly IndexedCommandSpelling[] {
  const seen = new Map<string, CanonicalCommand>()
  const entries: IndexedCommandSpelling[] = []
  for (const metadata of COMMAND_REGISTRY) {
    const spellings = [metadata.name, ...metadata.aliases]
    for (let index = 0; index < spellings.length; index += 1) {
      const spelling = normalizedSpelling(spellings[index] ?? "")
      if (!spelling) throw new Error(`Empty command spelling in registry: ${metadata.canonical}`)
      const previous = seen.get(spelling)
      if (previous && previous !== metadata.canonical) {
        throw new Error(
          `Conflicting command spelling in registry: ${spelling} -> ${previous}/${metadata.canonical}`,
        )
      }
      if (previous) continue
      seen.set(spelling, metadata.canonical)
      entries.push({
        command: metadata.canonical,
        spelling,
        tokens: spelling.split(" "),
        alias: index > 0,
        metadata,
      })
    }
  }
  return entries.sort(
    (left, right) =>
      right.tokens.length - left.tokens.length ||
      Number(left.alias) - Number(right.alias) ||
      compareCommandSpelling(left.spelling, right.spelling),
  )
}

const COMMAND_SPELLING_INDEX = buildCommandSpellingIndex()

/**
 * Resolve the longest public command spelling from positional argv tokens.
 * Parser aliases therefore cannot drift from help, completion or palette data.
 */
export function resolveCommandTokens(
  tokens: readonly string[],
): ResolvedCommandSpelling | undefined {
  for (const entry of COMMAND_SPELLING_INDEX) {
    if (entry.tokens.length > tokens.length) continue
    if (entry.tokens.every((token, index) => tokens[index] === token)) {
      return {
        command: entry.command,
        consumed: entry.tokens.length,
        spelling: entry.spelling,
        alias: entry.alias,
      }
    }
  }
  return undefined
}

/** Format-neutral candidates for shell/argv completion adapters. */
export function commandCompletionData(prefix = "", limit = 100): readonly CommandCompletionEntry[] {
  const normalizedPrefix = normalizedSpelling(prefix).toLocaleLowerCase("und")
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, 500)) : 0
  return COMMAND_SPELLING_INDEX.filter(
    (entry) =>
      !entry.spelling.startsWith("-") &&
      entry.spelling.toLocaleLowerCase("und").startsWith(normalizedPrefix),
  )
    .sort(
      (left, right) =>
        Number(left.alias) - Number(right.alias) ||
        compareCommandSpelling(left.spelling, right.spelling),
    )
    .slice(0, boundedLimit)
    .map((entry) => ({
      command: entry.command,
      value: entry.spelling,
      alias: entry.alias,
      summary: entry.metadata.summary,
      compatibility: entry.metadata.compatibility,
      ...(entry.metadata.replacement ? { replacement: entry.metadata.replacement } : {}),
      ...(entry.metadata.removalVersion ? { removalVersion: entry.metadata.removalVersion } : {}),
    }))
}

/** Searchable command projection for renderer-owned command palettes. */
export function commandPaletteData(query = "", limit = 100): readonly CommandPaletteEntry[] {
  const normalizedQuery = normalizedSpelling(query).toLocaleLowerCase("und")
  const boundedLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, 500)) : 0
  return COMMAND_REGISTRY.map((entry): CommandPaletteEntry => {
    const metadata: CommandMetadata = entry
    const searchText = [
      entry.name,
      ...entry.aliases,
      entry.summary,
      entry.compatibility,
      metadata.replacement ?? "",
      metadata.removalVersion ?? "",
    ]
      .join("\n")
      .toLocaleLowerCase("und")
    return {
      command: entry.canonical,
      label: entry.name,
      aliases: entry.aliases,
      summary: entry.summary,
      compatibility: entry.compatibility,
      ...(metadata.replacement ? { replacement: metadata.replacement } : {}),
      ...(metadata.removalVersion ? { removalVersion: metadata.removalVersion } : {}),
      searchText,
    }
  })
    .filter((entry) => !normalizedQuery || entry.searchText.includes(normalizedQuery))
    .slice(0, boundedLimit)
}

function deriveTopLevelCommandAliases(): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>()
  for (const entry of COMMAND_REGISTRY) {
    for (const alias of entry.aliases) {
      const segments = alias.split(" ")
      const topLevelAlias = segments[0]
      if (!topLevelAlias) continue
      const target = segments.length === 1 ? entry.canonical : entry.canonical.split(".")[0]
      if (!target || topLevelAlias === target) continue
      const existing = aliases.get(topLevelAlias)
      if (existing && existing !== target) {
        throw new Error(
          `Conflicting top-level command alias in registry: ${topLevelAlias} -> ${existing}/${target}`,
        )
      }
      aliases.set(topLevelAlias, target)
    }
  }
  return aliases
}

export const TOP_LEVEL_COMMAND_ALIASES = deriveTopLevelCommandAliases()

export function commandRegistryData(): readonly CommandMetadata[] {
  return COMMAND_REGISTRY
}

export function commandDiscoveryData(): readonly CommandDiscoveryEntry[] {
  return COMMAND_DISCOVERY
}
