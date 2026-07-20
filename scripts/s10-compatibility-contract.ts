export type S10CompatibilityClassification = "compatible" | "changed" | "deprecated" | "removed"

export type S10EvidenceMode =
  | "binary-probe"
  | "executed-component"
  | "executed-smoke"
  | "executed-migration"
  | "executed-linked-test"

export type S10CoverageContract = {
  readonly id: string
  readonly mode: S10EvidenceMode
  readonly description: string
}

export type S10LegacyCommandContract = {
  readonly id: string
  readonly legacySpellings: readonly string[]
  readonly nextCommand: string
  readonly classification: S10CompatibilityClassification
  readonly rationale: string
  readonly evidence: readonly string[]
}

export type S10LegacyFlagContract = {
  readonly id: string
  readonly legacySpellings: readonly string[]
  readonly nextContract: string
  readonly classification: S10CompatibilityClassification
  readonly rationale: string
  readonly evidence: readonly string[]
}

export type S10LinkedTestSuite = {
  readonly id: string
  readonly files: readonly string[]
  readonly coverage: readonly string[]
  readonly rationale: string
}

export const S10_EVIDENCE_COVERAGE = [
  {
    id: "binary.identity-help",
    mode: "binary-probe",
    description:
      "Hash, regular-file identity, version and human help are captured from both explicit binaries.",
  },
  {
    id: "s01.baseline",
    mode: "executed-component",
    description:
      "The S01 legacy-vs-next baseline executes help, version, status, init and descendant discovery.",
  },
  {
    id: "s03.addendum",
    mode: "executed-component",
    description:
      "The S03 addendum executes product rejection and a packaged fixture flow through events and report.",
  },
  {
    id: "s10.operational-smoke",
    mode: "executed-smoke",
    description:
      "S10 executes aliases, human/JSON operational reads, task markers, config, rules, checkpoints and diagnostics.",
  },
  {
    id: "s10.migration-coexistence",
    mode: "executed-migration",
    description:
      "S10 executes isolated legacy/v2 workspaces, inspect, apply, rollback and immutable-source/binary assertions.",
  },
  {
    id: "linked.execution-options",
    mode: "executed-linked-test",
    description:
      "Focused command and completion-policy tests execute skips, fast mode, option provenance and public output.",
  },
  {
    id: "linked.control-flow",
    mode: "executed-linked-test",
    description:
      "Focused control-flow tests execute no-change, retry, fail-fast, blocked and dry-run/resume boundaries.",
  },
  {
    id: "linked.parallel-git-security",
    mode: "executed-linked-test",
    description:
      "The bounded S09 executable matrix runs parallel worktrees, Git integration/conflict and sandbox/security denial.",
  },
  {
    id: "linked.signal-resume",
    mode: "executed-linked-test",
    description:
      "The S07 kill-injection matrix executes signal/crash recovery and proves durable non-replay boundaries.",
  },
] as const satisfies readonly S10CoverageContract[]

export const S10_LINKED_TEST_SUITES = [
  {
    id: "linked.execution-options",
    files: ["tests/integration/execution-cli.test.ts", "tests/unit/skip-completion-policy.test.ts"],
    coverage: ["skips", "fast", "output", "markers", "gates", "option-precedence"],
    rationale:
      "These tests execute public dry-run/output projections and the deterministic completion policy; source presence alone is not accepted as evidence.",
  },
  {
    id: "linked.control-flow",
    files: ["tests/integration/s03-control-flow-edge-cases.test.ts"],
    coverage: ["no-change", "retry", "fail-fast", "resume", "dry-run"],
    rationale:
      "The executable edge-case matrix proves precedence and non-mutation across all no-change policies and resumable state.",
  },
  {
    id: "linked.parallel-git-security",
    files: ["tests/integration/s09-bounded-e2e.test.ts"],
    coverage: ["parallel", "git", "worktrees", "conflict", "security", "sandbox"],
    rationale:
      "The bounded E2E test uses real temporary Git repositories/worktrees and supervised processes, including fail-closed security cases.",
  },
  {
    id: "linked.signal-resume",
    files: ["tests/integration/s07-kill-injection-matrix.test.ts"],
    coverage: ["signal", "crash", "resume", "events", "report"],
    rationale:
      "The kill-injection matrix creates actual child processes and durable interruption boundaries; a static source citation is insufficient.",
  },
] as const satisfies readonly S10LinkedTestSuite[]

export const S10_LEGACY_COMMAND_CONTRACT = [
  {
    id: "init",
    legacySpellings: ["init", "setup"],
    nextCommand: "init (setup alias)",
    classification: "compatible",
    rationale: "The alias remains accepted; v2 deliberately writes only identified v2 state.",
    evidence: ["s01.baseline", "s10.operational-smoke", "s10.migration-coexistence"],
  },
  {
    id: "run",
    legacySpellings: ["run", "loop"],
    nextCommand: "run / loop",
    classification: "compatible",
    rationale: "Both spellings remain explicit orchestration entrypoints.",
    evidence: ["s03.addendum", "linked.control-flow"],
  },
  {
    id: "once",
    legacySpellings: ["once"],
    nextCommand: "once <description> / once --task <id>",
    classification: "changed",
    rationale:
      "Ad-hoc text and PRD task selection are now unambiguous and persist distinct authority records.",
    evidence: ["s03.addendum", "linked.execution-options"],
  },
  {
    id: "parallel",
    legacySpellings: ["parallel"],
    nextCommand: "parallel",
    classification: "changed",
    rationale:
      "v2 owns scheduling, claims, worktrees and deterministic integration instead of delegating an implicit loop.",
    evidence: ["linked.parallel-git-security"],
  },
  {
    id: "install",
    legacySpellings: ["install"],
    nextCommand: "install",
    classification: "changed",
    rationale: "Installation type, staging, receipt, trust and activation are explicit in v2.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "config-list",
    legacySpellings: ["config", "config list"],
    nextCommand: "config list",
    classification: "compatible",
    rationale: "Both expose effective configuration; v2 additionally records source metadata.",
    evidence: ["s10.operational-smoke", "s10.migration-coexistence"],
  },
  {
    id: "config-get",
    legacySpellings: ["config get"],
    nextCommand: "config get",
    classification: "compatible",
    rationale: "Key lookup remains available with deterministic headless output.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "config-set",
    legacySpellings: ["config set"],
    nextCommand: "config set --scope workspace|global",
    classification: "changed",
    rationale: "v2 requires an explicit scope and only affects future run snapshots.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "tasks-list",
    legacySpellings: ["tasks", "tasks list"],
    nextCommand: "tasks list",
    classification: "compatible",
    rationale: "Task listing remains available over the compiled PRD graph.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "tasks-next",
    legacySpellings: ["tasks next"],
    nextCommand: "tasks next",
    classification: "changed",
    rationale: "v2 returns the first dependency-eligible task, not merely the first pending line.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "tasks-done",
    legacySpellings: ["tasks done"],
    nextCommand: "tasks done --evidence ... / --force --reason ...",
    classification: "changed",
    rationale: "Manual completion is evidence- or audited-override-gated in v2.",
    evidence: ["s10.operational-smoke", "linked.execution-options"],
  },
  {
    id: "tasks-sync",
    legacySpellings: ["tasks sync"],
    nextCommand: "tasks sync --repo ...",
    classification: "changed",
    rationale:
      "The GitHub projection is bounded, hash-preconditioned and never turns bodies into commands.",
    evidence: ["s10.operational-smoke", "linked.parallel-git-security"],
  },
  {
    id: "logs-tail",
    legacySpellings: ["logs", "logs tail"],
    nextCommand: "logs tail",
    classification: "compatible",
    rationale: "Tail remains available with explicit durable log views and filters.",
    evidence: ["s03.addendum", "s10.operational-smoke"],
  },
  {
    id: "doctor",
    legacySpellings: ["doctor"],
    nextCommand: "doctor",
    classification: "compatible",
    rationale: "The diagnostic command remains non-interactive and adds capability truth in v2.",
    evidence: ["s01.baseline", "s10.operational-smoke"],
  },
  {
    id: "clean",
    legacySpellings: ["clean"],
    nextCommand: "clean --dry-run / clean --force",
    classification: "changed",
    rationale: "v2 previews first and removes only identified v2 state after explicit force.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "rules",
    legacySpellings: ["rules"],
    nextCommand: "rules list|add|clear",
    classification: "changed",
    rationale:
      "The legacy parser accepted rules before its Go dispatch existed; v2 exposes bounded explicit verbs.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "lang",
    legacySpellings: ["lang", "lang current", "lang list", "lang set", "lang update"],
    nextCommand: "lang current|list|set|update",
    classification: "changed",
    rationale:
      "Locale catalogs remain, while persistence requires explicit workspace/global scope.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "ui",
    legacySpellings: ["ui", "ui current", "ui set", "ui toggle"],
    nextCommand: "attach / replay / --ui auto|tui|plain|none",
    classification: "changed",
    rationale:
      "The visual experience and supervisor ownership were redesigned; ui is an attach alias only.",
    evidence: ["binary.identity-help", "s10.operational-smoke"],
  },
  {
    id: "about",
    legacySpellings: ["about"],
    nextCommand: "about",
    classification: "compatible",
    rationale: "Product and version information remains available headlessly.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "update",
    legacySpellings: ["update"],
    nextCommand: "update / update --check",
    classification: "changed",
    rationale: "v2 separates package-manager authority from standalone staged updates and checks.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "report-last",
    legacySpellings: ["report", "report last"],
    nextCommand: "report last / report show",
    classification: "compatible",
    rationale: "The latest durable run report remains directly queryable.",
    evidence: ["s03.addendum", "linked.signal-resume"],
  },
  {
    id: "status",
    legacySpellings: ["status"],
    nextCommand: "status / status run",
    classification: "compatible",
    rationale: "Workspace status remains read-only; run detail is an additive v2 view.",
    evidence: ["s01.baseline", "s03.addendum", "s10.migration-coexistence"],
  },
  {
    id: "events",
    legacySpellings: ["events", "events tail"],
    nextCommand: "events",
    classification: "compatible",
    rationale: "Durable events remain queryable and v2 adds cursor/follow/JSONL contracts.",
    evidence: ["s03.addendum", "linked.signal-resume"],
  },
  {
    id: "checkpoint-create",
    legacySpellings: ["checkpoint create", "checkpoints create"],
    nextCommand: "checkpoint create",
    classification: "changed",
    rationale: "v2 snapshots are immutable and bounded by explicit inventory roots.",
    evidence: ["s10.operational-smoke", "linked.signal-resume"],
  },
  {
    id: "checkpoint-list-show",
    legacySpellings: [
      "checkpoint",
      "checkpoints",
      "checkpoint list",
      "checkpoints list",
      "checkpoint show",
      "checkpoints show",
    ],
    nextCommand: "checkpoint(s) list|show",
    classification: "compatible",
    rationale: "The singular/plural read aliases are retained.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "checkpoint-restore",
    legacySpellings: ["checkpoint restore", "checkpoints restore"],
    nextCommand: "rollback preview / rollback apply",
    classification: "changed",
    rationale: "Restore became a two-phase hash-bound rollback with a safety checkpoint.",
    evidence: ["s10.operational-smoke", "linked.signal-resume"],
  },
  {
    id: "context-show",
    legacySpellings: ["context", "context show"],
    nextCommand: "context inspect",
    classification: "changed",
    rationale: "v2 exposes metadata only and never dumps model context bodies.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "context-refresh",
    legacySpellings: ["context refresh"],
    nextCommand: "context rotate",
    classification: "changed",
    rationale:
      "Rotation crosses an explicit supervisor control port instead of editing context state directly.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "adapters",
    legacySpellings: [
      "adapter",
      "adapters",
      "adapter list",
      "adapters list",
      "adapter new",
      "adapters new",
    ],
    nextCommand: "adapters list|new|inspect",
    classification: "changed",
    rationale:
      "v2 creates disabled data-only drafts and never executes imported scripts during inspect.",
    evidence: ["s10.operational-smoke", "s10.migration-coexistence"],
  },
  {
    id: "recipes",
    legacySpellings: [
      "recipe",
      "recipes",
      "recipe list",
      "recipes list",
      "recipe new",
      "recipes new",
    ],
    nextCommand: "recipes list|new|show",
    classification: "changed",
    rationale:
      "Recipes are human-readable non-executable drafts and legacy imports remain quarantined.",
    evidence: ["s10.operational-smoke", "s10.migration-coexistence"],
  },
  {
    id: "version",
    legacySpellings: ["--version", "-V"],
    nextCommand: "version / --version / -V",
    classification: "compatible",
    rationale: "Both long and short non-interactive version probes remain accepted.",
    evidence: ["binary.identity-help", "s01.baseline", "s10.operational-smoke"],
  },
  {
    id: "help",
    legacySpellings: ["--help", "-h"],
    nextCommand: "help / --help / -h",
    classification: "compatible",
    rationale:
      "Both long and short help probes remain accepted; the v2 surface is intentionally larger.",
    evidence: ["binary.identity-help", "s01.baseline", "s10.operational-smoke"],
  },
] as const satisfies readonly S10LegacyCommandContract[]

export const S10_LEGACY_FLAG_CONTRACT = [
  {
    id: "help-version",
    legacySpellings: ["--help", "-h", "--version", "-V"],
    nextContract: "help/version commands and aliases",
    classification: "compatible",
    rationale: "Headless discovery and identity probes remain stable.",
    evidence: ["binary.identity-help", "s01.baseline", "s10.operational-smoke"],
  },
  {
    id: "ui",
    legacySpellings: ["--ui"],
    nextContract: "--ui auto|tui|plain|none",
    classification: "changed",
    rationale: "Legacy renderer names are migration inputs, not independent v2 engines.",
    evidence: ["binary.identity-help", "s10.operational-smoke"],
  },
  {
    id: "tests",
    legacySpellings: ["--skip-tests", "--run-tests"],
    nextContract: "--skip-tests plus typed gate policy",
    classification: "changed",
    rationale: "A skip is a request subject to policy and never fabricated passed evidence.",
    evidence: ["s03.addendum", "linked.execution-options"],
  },
  {
    id: "fast",
    legacySpellings: ["--fast"],
    nextContract: "--fast",
    classification: "compatible",
    rationale:
      "Fast mode remains, with required gates protected unless an audited override is allowed.",
    evidence: ["linked.execution-options"],
  },
  {
    id: "worker-run",
    legacySpellings: ["--worker-run"],
    nextContract: "internal supervisor/worker protocol",
    classification: "removed",
    rationale: "A public flag may not impersonate an authority-owned child process in v2.",
    evidence: ["binary.identity-help", "linked.parallel-git-security"],
  },
  {
    id: "fail-fast",
    legacySpellings: ["--fail-fast"],
    nextContract: "--fail-fast",
    classification: "compatible",
    rationale: "Independent work stops after a blocking failure when explicitly requested.",
    evidence: ["linked.control-flow"],
  },
  {
    id: "mode",
    legacySpellings: ["--mode", "--loop", "-l", "-loop", "--wiggum", "-w", "-wiggum"],
    nextContract: "run|loop and --mode loop|wiggum / --wiggum",
    classification: "changed",
    rationale:
      "Canonical modes remain while ambiguous single-dash word aliases are deprecated away.",
    evidence: ["s03.addendum", "linked.execution-options", "linked.control-flow"],
  },
  {
    id: "lint",
    legacySpellings: ["--no-lint", "--skip-lint"],
    nextContract: "--skip-lint",
    classification: "changed",
    rationale:
      "The canonical spelling is explicit and policy still controls whether a gate may skip.",
    evidence: ["linked.execution-options"],
  },
  {
    id: "no-commit",
    legacySpellings: ["--no-commit"],
    nextContract: "--no-commit",
    classification: "compatible",
    rationale: "The CLI can still suppress commit integration for a run.",
    evidence: ["s03.addendum", "linked.parallel-git-security"],
  },
  {
    id: "json",
    legacySpellings: ["--json"],
    nextContract: "--format json / --json",
    classification: "compatible",
    rationale: "Machine-readable output remains available and is stricter about stdout purity.",
    evidence: ["s01.baseline", "s03.addendum", "s10.operational-smoke"],
  },
  {
    id: "gates",
    legacySpellings: ["--gate", "--run-gate", "--test-command", "--lint-command"],
    nextContract: "typed PRD/profile gates and --skip-gates",
    classification: "changed",
    rationale: "Arbitrary inline command strings moved to typed, snapshotted gate contracts.",
    evidence: ["s03.addendum", "linked.execution-options"],
  },
  {
    id: "security",
    legacySpellings: ["--security", "--dangerous"],
    nextContract: "--security safe|auto|dangerous plus explicit permissions",
    classification: "changed",
    rationale: "Dangerous execution cannot silently broaden tool or path authority.",
    evidence: ["linked.parallel-git-security"],
  },
  {
    id: "sandbox",
    legacySpellings: [
      "--sandbox",
      "--no-sandbox",
      "--sandbox-provider",
      "--sandbox-image",
      "--sandbox-network",
    ],
    nextContract: "--sandbox, provider/image and capability diagnostics",
    classification: "changed",
    rationale:
      "v2 reports actual isolation strength and fails closed when a required boundary is unavailable.",
    evidence: ["s10.operational-smoke", "linked.parallel-git-security"],
  },
  {
    id: "dry-run",
    legacySpellings: ["--dry-run"],
    nextContract: "--dry-run",
    classification: "compatible",
    rationale: "Planning without mutation remains supported and emits explicit impact.",
    evidence: ["s10.operational-smoke", "linked.execution-options", "linked.control-flow"],
  },
  {
    id: "retry-failed",
    legacySpellings: ["--retry-failed"],
    nextContract: "--retry-failed / --max-failure-retries",
    classification: "changed",
    rationale: "Retry eligibility and budgets are persisted and typed in v2.",
    evidence: ["linked.control-flow", "linked.parallel-git-security"],
  },
  {
    id: "parallel-integration",
    legacySpellings: ["--parallel-integration"],
    nextContract: "--integration and explicit Git policy",
    classification: "changed",
    rationale:
      "Integration strategy is part of the scheduler/Git contract and durable checkpoints.",
    evidence: ["linked.parallel-git-security"],
  },
  {
    id: "auto-rollback",
    legacySpellings: ["--auto-rollback"],
    nextContract: "rollback preview/apply and checkpoint policy",
    classification: "changed",
    rationale:
      "v2 does not silently restore; rollback is an explicit hash-bound control operation.",
    evidence: ["s10.migration-coexistence", "linked.parallel-git-security"],
  },
  {
    id: "debug-engine-json",
    legacySpellings: ["--debug-engine-json"],
    nextContract: "--debug and raw-engine event/log view",
    classification: "changed",
    rationale: "Raw provider output is bounded, redacted and exposed through the event/log model.",
    evidence: ["s03.addendum", "linked.execution-options"],
  },
  {
    id: "context-stops",
    legacySpellings: [
      "--ignore-context-stops",
      "--ignore-gutter",
      "--respect-context-stops",
      "--respect-gutter",
    ],
    nextContract: "typed context/watchdog policy",
    classification: "changed",
    rationale:
      "Legacy gutter aliases become explicit context and watchdog policy rather than parser booleans.",
    evidence: ["linked.signal-resume"],
  },
  {
    id: "no-change",
    legacySpellings: [
      "--no-change-policy",
      "--no-change-max-retries",
      "--no-change-stop-on-max-retries",
      "--no-change-continue-on-max-retries",
    ],
    nextContract: "--no-change-policy and --no-change-max-retries",
    classification: "changed",
    rationale:
      "Policies are normalized to allow/fail/retry and evaluated against per-attempt deterministic deltas.",
    evidence: ["linked.control-flow"],
  },
  {
    id: "verbose",
    legacySpellings: ["--verbose", "-v"],
    nextContract: "--debug plus logs/events views",
    classification: "changed",
    rationale: "Verbosity is separated into deterministic output and persisted diagnostic views.",
    evidence: ["s10.operational-smoke", "s03.addendum"],
  },
  {
    id: "git",
    legacySpellings: ["--branch-per-task", "--base-branch", "--create-pr", "--draft-pr"],
    nextContract: "--git-worktrees, --base-branch, integration policy and review handoff",
    classification: "changed",
    rationale:
      "Git effects are lease/checkpoint-bound; remote PR publication remains an explicit integration authority.",
    evidence: ["linked.parallel-git-security"],
  },
  {
    id: "force",
    legacySpellings: ["--force"],
    nextContract: "--force with command-specific reason/confirmation contracts",
    classification: "changed",
    rationale: "Force never acts as an untyped universal bypass in v2.",
    evidence: ["s10.operational-smoke", "linked.execution-options"],
  },
  {
    id: "interaction",
    legacySpellings: ["--yes", "-y", "--non-interactive"],
    nextContract: "--non-interactive and explicit confirmation plan hashes",
    classification: "changed",
    rationale:
      "Headless mutations require command-owned authorization rather than an implicit yes prompt.",
    evidence: ["s01.baseline", "s10.operational-smoke", "s10.migration-coexistence"],
  },
  {
    id: "doctor-processes",
    legacySpellings: ["--processes"],
    nextContract: "doctor capability probes",
    classification: "changed",
    rationale:
      "Process/runtime diagnostics are bounded by configured capabilities and do not enumerate unrelated state.",
    evidence: ["s10.operational-smoke"],
  },
  {
    id: "model-shortcuts",
    legacySpellings: ["--sonnet", "--opus", "--haiku"],
    nextContract: "--executor-profile / --executor-provider / --executor-model",
    classification: "deprecated",
    rationale: "Provider-specific shortcuts cannot be a provider-neutral CLI contract.",
    evidence: ["binary.identity-help", "s03.addendum"],
  },
  {
    id: "engine-model",
    legacySpellings: ["--engine", "--model"],
    nextContract: "--executor-profile/provider/model and independent judge settings",
    classification: "changed",
    rationale: "Executor and judge provider/model selection are independent and snapshotted.",
    evidence: ["s03.addendum", "linked.execution-options"],
  },
  {
    id: "prd",
    legacySpellings: ["--prd"],
    nextContract: "--prd",
    classification: "compatible",
    rationale: "An explicit PRD path remains supported.",
    evidence: ["s03.addendum", "linked.execution-options"],
  },
  {
    id: "github-sync",
    legacySpellings: ["--repo", "--label", "--state", "--output"],
    nextContract: "tasks sync --repo/--label/--state/--output",
    classification: "changed",
    rationale: "The import is bounded and output replacement is hash/force controlled.",
    evidence: ["s10.operational-smoke", "linked.parallel-git-security"],
  },
  {
    id: "retries",
    legacySpellings: ["-r", "--retries", "--max-retries", "--retry-delay"],
    nextContract: "--max-failure-retries and --retry-delay",
    classification: "changed",
    rationale: "Failure and no-change retry budgets are distinct, typed and persisted.",
    evidence: ["linked.control-flow"],
  },
  {
    id: "budgets",
    legacySpellings: ["--max-iterations", "--max-parallel", "--max-tokens", "--temperature"],
    nextContract: "typed run/profile budgets and --max-parallel",
    classification: "changed",
    rationale:
      "Execution, model-call and concurrency limits are typed snapshot inputs; model parameters belong to profiles.",
    evidence: ["s03.addendum", "linked.execution-options", "linked.parallel-git-security"],
  },
  {
    id: "tail-filters",
    legacySpellings: ["--follow", "--level", "--since"],
    nextContract: "events/logs tail follow and filters",
    classification: "compatible",
    rationale: "Durable stream/tail filtering remains available with cursor semantics.",
    evidence: ["s03.addendum", "s10.operational-smoke", "linked.signal-resume"],
  },
  {
    id: "passthrough",
    legacySpellings: ["--"],
    nextContract: "repeatable typed --cli-arg on an external profile",
    classification: "removed",
    rationale: "Unbounded command-line passthrough is outside the deterministic parser contract.",
    evidence: ["binary.identity-help", "linked.execution-options"],
  },
] as const satisfies readonly S10LegacyFlagContract[]

export type S10ClosedContractSummary = {
  commands: number
  commandSpellings: number
  flagGroups: number
  flagSpellings: number
  classifications: Record<S10CompatibilityClassification, number>
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort((left, right) => left.localeCompare(right, "en"))
}

export function assertClosedS10CompatibilityContract(): S10ClosedContractSummary {
  const coverageIds = new Set<string>(S10_EVIDENCE_COVERAGE.map((item) => item.id))
  const linkedSuiteIds = S10_LINKED_TEST_SUITES.map((item) => item.id)
  const duplicateLinkedSuiteIds = duplicateValues(linkedSuiteIds)
  if (duplicateLinkedSuiteIds.length > 0) {
    throw new Error(`Duplicate linked S10 suite IDs: ${duplicateLinkedSuiteIds.join(", ")}`)
  }
  const commandIds = S10_LEGACY_COMMAND_CONTRACT.map((item) => item.id)
  const flagIds = S10_LEGACY_FLAG_CONTRACT.map((item) => item.id)
  const duplicateIds = duplicateValues([...commandIds, ...flagIds.map((id) => `flag:${id}`)])
  if (duplicateIds.length > 0) {
    throw new Error(`Duplicate S10 contract IDs: ${duplicateIds.join(", ")}`)
  }

  const duplicateCommands = duplicateValues(
    S10_LEGACY_COMMAND_CONTRACT.flatMap((item) => item.legacySpellings),
  )
  if (duplicateCommands.length > 0) {
    throw new Error(
      `Legacy command spellings are classified more than once: ${duplicateCommands.join(", ")}`,
    )
  }

  const duplicateFlags = duplicateValues(
    S10_LEGACY_FLAG_CONTRACT.flatMap((item) => item.legacySpellings),
  )
  if (duplicateFlags.length > 0) {
    throw new Error(
      `Legacy flag spellings are classified more than once: ${duplicateFlags.join(", ")}`,
    )
  }

  for (const item of [...S10_LEGACY_COMMAND_CONTRACT, ...S10_LEGACY_FLAG_CONTRACT]) {
    const spellings: readonly string[] = item.legacySpellings
    const evidence: readonly string[] = item.evidence
    if (spellings.length === 0 || evidence.length === 0) {
      throw new Error(`S10 contract ${item.id} must have spellings and executable evidence`)
    }
    const missing = item.evidence.filter((id) => !coverageIds.has(id))
    if (missing.length > 0) {
      throw new Error(`S10 contract ${item.id} references unknown evidence: ${missing.join(", ")}`)
    }
  }

  for (const suite of S10_LINKED_TEST_SUITES) {
    const files: readonly string[] = suite.files
    const suiteCoverage: readonly string[] = suite.coverage
    if (!coverageIds.has(suite.id) || files.length === 0 || suiteCoverage.length === 0) {
      throw new Error(`Linked S10 suite ${suite.id} is not closed over evidence/files/coverage`)
    }
  }

  const classifications: Record<S10CompatibilityClassification, number> = {
    compatible: 0,
    changed: 0,
    deprecated: 0,
    removed: 0,
  }
  for (const item of [...S10_LEGACY_COMMAND_CONTRACT, ...S10_LEGACY_FLAG_CONTRACT]) {
    classifications[item.classification] += 1
  }

  return {
    commands: S10_LEGACY_COMMAND_CONTRACT.length,
    commandSpellings: S10_LEGACY_COMMAND_CONTRACT.flatMap((item) => item.legacySpellings).length,
    flagGroups: S10_LEGACY_FLAG_CONTRACT.length,
    flagSpellings: S10_LEGACY_FLAG_CONTRACT.flatMap((item) => item.legacySpellings).length,
    classifications,
  }
}
