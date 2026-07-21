import { EXIT_CODES } from "@ralph/domain"
import { COMMAND_METADATA, commandRegistryData } from "./command-registry"

export { COMMAND_METADATA } from "./command-registry"

export const OPTION_METADATA = [
  { syntax: "--format human|json|jsonl", summary: "Select the output contract" },
  { syntax: "--json", summary: "Alias for --format json" },
  { syntax: "--workspace PATH", summary: "Use an explicit workspace directory" },
  {
    syntax: "--scope workspace|global|effective",
    summary: "Select an explicit config destination/view; effective is read-only export only",
  },
  { syntax: "--no-color", summary: "Disable ANSI color in human output" },
  { syntax: "--debug", summary: "Include redacted debug details on failures" },
  {
    syntax: "--force",
    summary: "Authorize an audited override where supported; never bypass schema or child safety",
  },
  { syntax: "--non-interactive", summary: "Never prompt or open a UI" },
  { syntax: "--prd PATH", summary: "Select the root PRD v2 file for execution" },
  { syntax: "--executor-profile NAME", summary: "Select the configured executor profile" },
  { syntax: "--executor-provider ID", summary: "Override only the executor provider" },
  { syntax: "--executor-model ID", summary: "Override only the executor model" },
  { syntax: "--executor-credential REF", summary: "Override only the executor credential ref" },
  { syntax: "--executor-variant ID", summary: "Override only the executor model variant" },
  {
    syntax: "--executor-parameter NAME=VALUE",
    summary: "Replace the executor parameter map for this run; repeat as needed",
  },
  { syntax: "--clear-executor-credential", summary: "Clear the inherited executor credential" },
  { syntax: "--clear-executor-variant", summary: "Clear the inherited executor variant" },
  { syntax: "--clear-executor-parameters", summary: "Clear executor parameters for this run" },
  { syntax: "--judge-profile NAME", summary: "Select the configured judge profile" },
  { syntax: "--judge-provider ID", summary: "Override only the judge provider" },
  { syntax: "--judge-model ID", summary: "Override only the judge model" },
  { syntax: "--judge-credential REF", summary: "Override only the judge credential ref" },
  { syntax: "--judge-variant ID", summary: "Override only the judge model variant" },
  {
    syntax: "--judge-parameter NAME=VALUE",
    summary: "Replace the judge parameter map for this run; repeat as needed",
  },
  { syntax: "--clear-judge-credential", summary: "Clear the inherited judge credential" },
  { syntax: "--clear-judge-variant", summary: "Clear the inherited judge variant" },
  { syntax: "--clear-judge-parameters", summary: "Clear judge parameters for this run" },
  {
    syntax: "--evaluation MODE",
    summary: "Select run evaluation; standalone judge accepts only self or external",
  },
  { syntax: "--judge [external]", summary: "Enable the independent external judge" },
  { syntax: "--no-judge", summary: "Alias for deterministic-only evaluation" },
  { syntax: "--self-review", summary: "Use the judge contract with a fresh self-review call" },
  { syntax: "--judge-threshold 0..100", summary: "Set the minimum accepted judge score" },
  {
    syntax: "--judge-max-revisions N",
    summary: "Limit code revisions after valid rejected assessments",
  },
  { syntax: "--max-revisions N", summary: "Alias for --judge-max-revisions" },
  {
    syntax: "--judge-call-retries N",
    summary: "Limit judge transport/schema retries independently from revisions",
  },
  {
    syntax: "--judge-unavailable POLICY",
    summary: "Use deterministic, pause or fail when evaluation is unavailable",
  },
  {
    syntax: "--judge-blocking-severity LEVEL",
    summary: "Make a judge finding severity blocking; repeat as needed",
  },
  {
    syntax: "--judge-rubric JSON|derive",
    summary: "Override the tool-agnostic judge rubric or derive it from task criteria",
  },
  {
    syntax: "--judge-exhausted POLICY",
    summary: "Use manual-review, fail or stop-run after revision exhaustion",
  },
  { syntax: "--provider ID", summary: "Select a provider for catalog, auth or smoke" },
  { syntax: "--model ID", summary: "Select a model where supported" },
  { syntax: "--profile ID", summary: "Select a role profile where supported" },
  { syntax: "--credential REF", summary: "Select a non-secret credential reference" },
  { syntax: "--clear-credential", summary: "Remove a configured profile credential" },
  {
    syntax: "--inherit-profile-field ID",
    summary: "Remove one exact target-layer profile override; repeat for more fields",
  },
  { syntax: "--method METHOD", summary: "Select a provider-advertised authentication method" },
  { syntax: "--label TEXT", summary: "Set a human-readable credential label" },
  { syntax: "--environment NAME", summary: "Reference an environment variable without copying it" },
  { syntax: "--secret-stdin", summary: "Read a secret from stdin instead of prompting" },
  {
    syntax: "--headless",
    summary: "Use an actionable headless auth flow without opening a browser",
  },
  { syntax: "--refresh", summary: "Refresh remote metadata or renewable credential status" },
  { syntax: "--timeout SEC", summary: "Set a positive timeout for auth or smoke operations" },
  { syntax: "--role executor|judge", summary: "Filter or configure a role profile" },
  { syntax: "--backend embedded|external-cli", summary: "Configure a profile backend" },
  {
    syntax: "--cli-executable PATH",
    summary: "Set an external profile executable; never include credentials",
  },
  {
    syntax: "--cli-arg VALUE",
    summary: "Append an external CLI argument; repeat and use a JSON string for exact quoting",
  },
  { syntax: "--cli-cwd PATH", summary: "Set a portable workspace-relative external CLI cwd" },
  {
    syntax: "--cli-env TARGET=env:SOURCE",
    summary: "Map an environment reference without storing its secret value; repeat as needed",
  },
  {
    syntax: "--cli-adapter protocol|known-output|generic",
    summary: "Select external CLI input/output normalization",
  },
  { syntax: "--cli-adapter-id ID", summary: "Select the required known-output adapter ID" },
  { syntax: "--cli-streaming true|false", summary: "Declare external CLI streaming support" },
  {
    syntax: "--cli-tool-calling ralph|internal|unavailable",
    summary: "Declare who owns external CLI tool calls",
  },
  { syntax: "--cli-cancellation true|false", summary: "Declare external CLI cancellation support" },
  {
    syntax: "--cli-usage reported|estimated|unavailable",
    summary: "Declare external CLI usage accounting",
  },
  {
    syntax: "--cli-mutation read-only|workspace",
    summary: "Bound external CLI workspace mutation",
  },
  { syntax: "--cli-timeout-ms N", summary: "Set a positive external process timeout" },
  { syntax: "--cli-output-limit-bytes N", summary: "Cap captured external process output" },
  { syntax: "--variant ID", summary: "Select a provider-declared model variant" },
  { syntax: "--clear-variant", summary: "Remove a configured profile variant" },
  {
    syntax: "--parameter NAME=VALUE",
    summary: "Set a provider-declared primitive model parameter; repeat as needed",
  },
  { syntax: "--clear-parameters", summary: "Replace configured profile parameters with {}" },
  {
    syntax: "--set-default",
    summary: "Atomically select the configured profile as the default for its role",
  },
  {
    syntax: "--fallback-profile ID",
    summary: "Add an ordered explicit fallback; repeat as needed",
  },
  {
    syntax: "--fallback-on CLASS",
    summary: "Authorize a transient fallback class; repeat as needed",
  },
  { syntax: "--require-tools", summary: "Require model tool-calling capability" },
  {
    syntax: "--require-structured-output",
    summary: "Require model structured-output capability",
  },
  {
    syntax: "--allow-insecure-store",
    summary: "Explicitly allow a warned plaintext fallback when no secure store exists",
  },
  {
    syntax: "--task ID",
    summary: "Select one PRD task explicitly; positional once text is always ad-hoc",
  },
  {
    syntax: "--evidence PATH",
    summary:
      "Attach a regular workspace file to an audited manual task completion; repeat as needed",
  },
  { syntax: "--pending", summary: "Show only pending PRD tasks" },
  { syntax: "--completed", summary: "Show only completed PRD tasks" },
  { syntax: "--review", summary: "Show only [~] tasks awaiting manual review" },
  { syntax: "--repo OWNER/REPO", summary: "Select the GitHub repository used by tasks sync" },
  { syntax: "--state open|closed|all", summary: "Filter GitHub issues used by tasks sync" },
  { syntax: "--run-id ID", summary: "Select a resumable or persisted run where supported" },
  { syntax: "--attempt-id ID", summary: "Bind verify/judge to one exact persisted attempt" },
  {
    syntax: "--evidence-bundle-id ID",
    summary: "Bind verify/judge to one exact immutable evidence bundle",
  },
  {
    syntax: "--verification-id ID",
    summary: "Make judge consume the exact evidence emitted by a completed verify operation",
  },
  {
    syntax: "--follow",
    summary: "Continue from the durable event cursor until completion or signal",
  },
  {
    syntax: "--level LEVEL",
    summary: "Filter events/logs at or above trace|debug|info|warn|error",
  },
  {
    syntax: "--source SOURCE",
    summary: "Select audit|human|raw-engine|tool|gate|diagnostic log view",
  },
  { syntax: "--since TIME", summary: "Filter events/logs from an ISO-8601 timestamp" },
  { syntax: "--type EVENT", summary: "Filter one exact durable event type" },
  { syntax: "--worker-id ID", summary: "Filter events/logs for one worker" },
  { syntax: "--limit N", summary: "Bound the initial tail to the newest N matching records" },
  {
    syntax: "--resume auto|never|required",
    summary: "Control discovery of a compatible non-terminal run; bare --resume means auto",
  },
  { syntax: "--no-resume", summary: "Compatibility alias for --resume never" },
  {
    syntax: "--accept-workspace-changes",
    summary:
      "On resume, accept only the exact pending expected/observed workspace hashes and record the decision",
  },
  {
    syntax: "--new-run",
    summary: "Explicitly create a fresh run instead of discovering resumable work",
  },
  { syntax: "--all", summary: "Include every persisted run in workspace status" },
  { syntax: "--graceful", summary: "Request cooperative stop at a safe durable boundary" },
  { syntax: "--grace SEC", summary: "Set a non-negative graceful-stop allowance" },
  {
    syntax: "--additional-revisions N",
    summary: "Grant a positive number of additional judge revision attempts",
  },
  {
    syntax: "--reason TEXT",
    summary: "Record the mandatory audit reason for a manual-review action",
  },
  { syntax: "--wiggum", summary: "Use the verified full-PRD context envelope with run" },
  { syntax: "--dry-run", summary: "Resolve execution without backend calls or marker changes" },
  { syntax: "--fail-fast", summary: "Stop run or loop after the first blocking task failure" },
  { syntax: "--max-tasks N", summary: "Limit run or loop to a positive number of tasks" },
  { syntax: "--max-parallel N", summary: "Bound concurrent workers in this project" },
  { syntax: "--max-global-parallel N", summary: "Bound concurrent Ralph workers across projects" },
  {
    syntax: "--parallel-auto",
    summary: "Allow structurally eligible tasks outside named parallel groups",
  },
  { syntax: "--parallel-group ID", summary: "Allow one declared parallel group; repeat as needed" },
  { syntax: "--retry-failed", summary: "Retry failed parallel tasks within the configured budget" },
  { syntax: "--max-failure-retries N", summary: "Bound parallel failure retries per task" },
  {
    syntax: "--git-worktrees",
    summary: "Require a managed Git worktree and branch per parallel task",
  },
  { syntax: "--base-branch REF", summary: "Select the verified base ref for task worktrees" },
  { syntax: "--integration-branch REF", summary: "Select the claimed integration target" },
  {
    syntax: "--integration STRATEGY",
    summary: "Use none, merge, rebase-merge, cherry-pick or create-pr",
  },
  { syntax: "--sandbox", summary: "Enable the configured command-owned sandbox boundary" },
  {
    syntax: "--sandbox-provider KIND",
    summary: "Select process, docker or podman sandbox capability",
  },
  {
    syntax: "--sandbox-image IMAGE",
    summary: "Select the explicit container image for Docker or Podman",
  },
  {
    syntax: "--path PATH",
    summary: "Add one workspace-relative file to an explicit checkpoint; repeat as needed",
  },
  {
    syntax: "--inventory-root PATH",
    summary: "Add one workspace-relative directory tree to an explicit checkpoint inventory",
  },
  {
    syntax: "--install-root DIR",
    summary: "Select the dedicated standalone installation root; never a workspace or checkout",
  },
  {
    syntax: "--manifest PATH|HTTPS",
    summary: "Select an explicit local or HTTPS release manifest for install/update",
  },
  {
    syntax: "--channel nightly|beta|stable",
    summary: "Require the release channel and explicitly authorize a channel change on update",
  },
  {
    syntax: "--to-version VERSION",
    summary: "Require a release version or select a receipt-bound version for install rollback",
  },
  {
    syntax: "--allow-downgrade",
    summary: "Explicitly authorize an older compatible release during standalone update",
  },
  {
    syntax: "--expires-in SEC",
    summary: "Bound the validity window of a persisted rollback preview",
  },
  {
    syntax: "--confirm-plan-hash SHA256",
    summary: "Confirm checkpoint or migration rollback with the exact matching preview hash",
  },
  { syntax: "--retry-delay SEC", summary: "Set a non-negative delay between retry opportunities" },
  {
    syntax: "--max-iterations N",
    summary: "Limit positive Wiggum iterations; requires effective mode wiggum",
  },
  { syntax: "--max-model-calls N", summary: "Limit model calls to a positive integer" },
  {
    syntax: "--no-change-policy POLICY",
    summary:
      "Use require-change, allow-no-change, fail-on-no-change or retry-on-no-change; legacy aliases remain accepted",
  },
  {
    syntax: "--no-change-max-retries N",
    summary: "Limit no-change retries to a non-negative integer",
  },
  { syntax: "--skip-tests", summary: "Request applicable test gates to be skipped by policy" },
  { syntax: "--skip-lint", summary: "Request applicable lint gates to be skipped by policy" },
  { syntax: "--skip-gates ID", summary: "Request a named gate skip; repeat for multiple gates" },
  {
    syntax: "--no-gates",
    summary: "Request audited gate suppression where the effective policy permits it",
  },
  {
    syntax: "--fast",
    summary: "Request every applicable verification whose policy permits skipping",
  },
  { syntax: "--no-commit", summary: "Disable optional commit creation for this execution" },
  { syntax: "--security safe|auto|dangerous", summary: "Override execution tool security mode" },
  {
    syntax: "--headless-ask deny|allow",
    summary: "Resolve ask rules when no interactive approver is available",
  },
  { syntax: "--allow-tool NAME", summary: "Allow a named tool; repeat as needed" },
  { syntax: "--deny-tool NAME", summary: "Deny a named tool; repeat as needed" },
  { syntax: "--ask-tool NAME", summary: "Require approval for a named tool; repeat as needed" },
  { syntax: "--allow-command COMMAND", summary: "Add an allowed command policy entry" },
  { syntax: "--read-path SCOPE", summary: "Add a portable workspace-relative read scope" },
  { syntax: "--write-path SCOPE", summary: "Add a portable workspace-relative write scope" },
  { syntax: "--allow-shell", summary: "Allow shell tools within all remaining security bounds" },
  { syntax: "--effective", summary: "Request the effective merged config view" },
  {
    syntax: "--mode once|loop|wiggum|parallel",
    summary: "Select generic run mode; also overrides mode in config explain/list",
  },
  {
    syntax: "--ui auto|tui|plain|none",
    summary: "Select execution presentation; tui opens the pre-run command palette",
  },
  { syntax: "--lang LOCALE", summary: "CLI config override used by config explain/list" },
  { syntax: "--recursive", summary: "Compile every referenced Sub-PRD" },
  { syntax: "--strict", summary: "Treat noncanonical warnings as validation failure" },
  { syntax: "--check", summary: "Check formatting without writing" },
  {
    syntax: "--output PATH",
    summary: "Write supported PRD/context/config output to a separate contained path",
  },
  {
    syntax: "--serialization yaml|json",
    summary: "Select the document encoding emitted by config export",
  },
  {
    syntax: "--destination PATH",
    summary: "Select a separate, existing destination directory for migrate apply",
  },
  {
    syntax: "--import-adapters",
    summary: "Copy safe legacy adapter manifests into inactive quarantine; never execute them",
  },
  {
    syntax: "--import-recipes",
    summary: "Copy safe legacy recipe documents into inactive quarantine",
  },
  { syntax: "--report PATH", summary: "Select the migration report path" },
  { syntax: "--in-place", summary: "Explicitly replace the source where supported" },
] as const

export function helpData(version: string): Record<string, unknown> {
  return {
    product: "ralph",
    version,
    usage: "ralph <command> [options]",
    commands: commandRegistryData(),
    options: OPTION_METADATA,
    exitCodes: EXIT_CODES,
  }
}

export function helpText(version: string): string {
  const commandLabel = (command: (typeof COMMAND_METADATA)[number]): string =>
    command.aliases.length > 0
      ? `${command.name} (aliases: ${command.aliases.join(", ")})`
      : command.name
  const commandWidth = Math.max(...COMMAND_METADATA.map((command) => commandLabel(command).length))
  const optionWidth = Math.max(...OPTION_METADATA.map((option) => option.syntax.length))
  const commands = COMMAND_METADATA.map(
    (command) =>
      `  ${commandLabel(command).padEnd(commandWidth)}  ${command.summary} [${command.compatibility}]`,
  ).join("\n")
  const options = OPTION_METADATA.map(
    (option) => `  ${option.syntax.padEnd(optionWidth)}  ${option.summary}`,
  ).join("\n")
  return `ralph ${version} — command-authoritative AI task runner

USAGE
  ralph <command> [options]

COMMANDS
${commands}

OPTIONS
${options}

Ralph selects work, authorizes tools, verifies evidence and persists completion.
Models never control official task state.`
}
