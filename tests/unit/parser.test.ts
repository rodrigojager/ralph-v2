import { describe, expect, test } from "bun:test"
import { inferRequestedFormat, parseCli } from "@ralph/commands"
import { EXIT_CODES, type ExitCode, RalphError } from "@ralph/domain"

function expectParseError(
  argv: readonly string[],
  code: string,
  exitCode: ExitCode = EXIT_CODES.invalidUsage,
): RalphError {
  let caught: unknown
  try {
    parseCli(argv)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(RalphError)
  const error = caught as RalphError
  expect(error.code).toBe(code)
  expect(error.exitCode).toBe(exitCode)
  return error
}

describe("CLI parser", () => {
  test("defaults to help with deterministic defaults", () => {
    expect(parseCli([])).toEqual({
      command: "help",
      arguments: [],
      options: {
        format: "human",
        noColor: false,
        debug: false,
        force: false,
        nonInteractive: false,
        effective: false,
        recursive: false,
        strict: false,
        check: false,
        inPlace: false,
        dryRun: false,
        failFast: false,
        skipTests: false,
        skipLint: false,
        skipGates: [],
        noGates: false,
        fast: false,
        noCommit: false,
        wiggum: false,
        refresh: false,
        headless: false,
        secretStdin: false,
        allowInsecureStore: false,
        requireTools: false,
        requireStructuredOutput: false,
        clearCredential: false,
        clearVariant: false,
        clearParameters: false,
        clearExecutorCredential: false,
        clearExecutorVariant: false,
        clearExecutorParameters: false,
        clearJudgeCredential: false,
        clearJudgeVariant: false,
        clearJudgeParameters: false,
        setDefault: false,
        allowShell: false,
        newRun: false,
        acceptWorkspaceChanges: false,
        all: false,
        graceful: false,
        follow: false,
        pending: false,
        completed: false,
        review: false,
        importAdapters: false,
        importRecipes: false,
        fallbackProfiles: [],
        fallbackOn: [],
        inheritProfileFields: [],
        judgeBlockingSeverities: [],
        parameters: {},
        executorParameters: {},
        judgeParameters: {},
        cliArgs: [],
        cliEnvironmentRefs: {},
        allowTools: [],
        denyTools: [],
        askTools: [],
        allowCommands: [],
        readPaths: [],
        writePaths: [],
        parallelGroups: [],
        evidencePaths: [],
        checkpointPaths: [],
        inventoryRoots: [],
        allowDowngrade: false,
      },
    })
  })

  test("normalizes command aliases and value flags", () => {
    const parsed = parseCli([
      "--workspace",
      "C:/work with spaces/projeto",
      "setup",
      "--format=json",
      "--force",
      "--non-interactive",
    ])
    expect(parsed.command).toBe("init")
    expect(parsed.arguments).toEqual([])
    expect(parsed.options).toMatchObject({
      workspace: "C:/work with spaces/projeto",
      format: "json",
      force: true,
      nonInteractive: true,
    })
  })

  test("parses config subcommands and the required dotted key", () => {
    expect(parseCli(["config", "explain", "defaults.mode", "--json"])).toMatchObject({
      command: "config.explain",
      arguments: ["defaults.mode"],
      options: { format: "json" },
    })
    expect(parseCli(["config", "list", "--effective"])).toMatchObject({
      command: "config.list",
      arguments: [],
      options: { effective: true },
    })
  })

  test("global help and version flags short-circuit a preceding command", () => {
    expect(parseCli(["init", "--help"]).command).toBe("help")
    expect(parseCli(["status", "-h"]).command).toBe("help")
    expect(parseCli(["doctor", "--version"]).command).toBe("version")
    expect(parseCli(["config", "list", "-V"]).command).toBe("version")
  })

  test("infers a machine-readable format even when parsing later fails", () => {
    expect(inferRequestedFormat(["bad-command", "--json"])).toBe("json")
    expect(inferRequestedFormat(["--format=jsonl", "bad-command"])).toBe("jsonl")
    expect(inferRequestedFormat(["--format", "human", "bad-command"])).toBe("human")
  })

  test("parses a typed once execution surface with an explicit PRD task", () => {
    const parsed = parseCli([
      "once",
      "--task",
      "S03.01",
      "--prd",
      "plans/root.md",
      "--executor-profile",
      "executor-main",
      "--force",
      "--dry-run",
      "--max-model-calls=4",
      "--retry-delay",
      "0.25",
      "--no-change-policy",
      "require-change",
      "--no-change-max-retries",
      "0",
      "--skip-tests",
      "--skip-lint",
      "--skip-gates",
      "browser",
      "--skip-gates=security",
      "--fast",
      "--no-commit",
      "--run-id",
      "run-01",
    ])

    expect(parsed.command).toBe("once")
    expect(parsed.arguments).toEqual([])
    expect(parsed.options).toMatchObject({
      prd: "plans/root.md",
      executorProfile: "executor-main",
      task: "S03.01",
      force: true,
      dryRun: true,
      maxModelCalls: 4,
      retryDelay: 0.25,
      noChangePolicy: "require-change",
      noChangeMaxRetries: 0,
      skipTests: true,
      skipLint: true,
      skipGates: ["browser", "security"],
      fast: true,
      noCommit: true,
      runId: "run-01",
    })
  })

  test("distinguishes positional ad-hoc requests from explicit PRD task selection", () => {
    expect(parseCli(["once", "S03.01"]).options.adHocDescription).toBe("S03.01")
    expect(parseCli(["once", "--task", "S03.01"]).options.task).toBe("S03.01")
    expectParseError(["once", "S03.01", "--task", "S03.02"], "RALPH_ONCE_SOURCE_CONFLICT")
  })

  test("parses loop and run wiggum limits as numbers", () => {
    expect(
      parseCli(["loop", "--max-tasks", "3", "--fail-fast", "--no-change-policy=fallback"]),
    ).toMatchObject({
      command: "loop",
      options: {
        maxTasks: 3,
        failFast: true,
        noChangePolicy: "fallback",
      },
    })

    expect(
      parseCli([
        "run",
        "--mode",
        "wiggum",
        "--max-iterations",
        "2",
        "--max-model-calls",
        "5",
        "--no-change-policy",
        "retry-on-no-change",
      ]),
    ).toMatchObject({
      command: "run",
      arguments: [],
      options: {
        mode: "wiggum",
        maxIterations: 2,
        maxModelCalls: 5,
        noChangePolicy: "retry-on-no-change",
      },
    })

    expect(parseCli(["run", "--max-iterations", "2"])).toMatchObject({
      command: "run",
      options: { maxIterations: 2 },
    })
  })

  test("accepts only executable generic run modes and rejects ambiguous aliases", () => {
    for (const mode of ["once", "loop", "wiggum", "parallel"] as const) {
      expect(parseCli(["run", "--mode", mode])).toMatchObject({
        command: "run",
        options: { mode },
      })
    }

    expectParseError(["run", "--mode", "loop", "--wiggum"], "RALPH_RUN_MODE_CONFLICT")
    expectParseError(
      ["run", "--mode", "once", "--max-iterations", "2"],
      "RALPH_OPTION_REQUIRES_WIGGUM",
    )
  })

  test("parses run status, events, evidence and report addressing", () => {
    expect(parseCli(["status"])).toMatchObject({ command: "status", arguments: [] })
    expect(parseCli(["status", "run", "--run-id", "run-01"])).toMatchObject({
      command: "status.run",
      arguments: [],
      options: { runId: "run-01" },
    })
    expect(parseCli(["attach", "run-01"])).toMatchObject({
      command: "attach",
      arguments: [],
      options: { runId: "run-01" },
    })
    expect(parseCli(["ui", "--run-id", "run-02"])).toMatchObject({
      command: "attach",
      arguments: [],
      options: { runId: "run-02" },
    })
    expectParseError(["attach", "run-01", "--run-id", "run-02"], "RALPH_RUN_ID_CONFLICT")
    expect(parseCli(["events", "--run-id=run-01", "--format", "jsonl"])).toMatchObject({
      command: "events",
      arguments: [],
      options: { runId: "run-01", format: "jsonl" },
    })
    expect(parseCli(["evidence", "inspect", "attempt-01", "--format", "json"])).toMatchObject({
      command: "evidence.inspect",
      arguments: ["attempt-01"],
      options: { format: "json" },
    })
    expectParseError(["evidence", "inspect"], "RALPH_EVIDENCE_ATTEMPT_ID_MISSING")
    expectParseError(["evidence", "show", "attempt-01"], "RALPH_COMMAND_UNKNOWN")
    expect(parseCli(["report", "last", "--json"])).toMatchObject({
      command: "report.last",
      arguments: [],
      options: { format: "json" },
    })
    expect(parseCli(["report", "show", "run-01"])).toMatchObject({
      command: "report.show",
      arguments: ["run-01"],
    })
    expect(parseCli(["report", "show", "--run-id", "run-02"])).toMatchObject({
      command: "report.show",
      arguments: [],
      options: { runId: "run-02" },
    })
  })

  test("parses the S04 provider, model and credential command surface", () => {
    expect(parseCli(["providers", "list", "--refresh", "--format", "json"]).command).toBe(
      "providers.list",
    )
    expect(parseCli(["providers", "inspect", "openai"]).arguments).toEqual(["openai"])

    const models = parseCli([
      "models",
      "list",
      "--provider",
      "openrouter",
      "--require-tools",
      "--require-structured-output",
    ])
    expect(models.command).toBe("models.list")
    expect(models.options.provider).toBe("openrouter")
    expect(models.options.requireTools).toBe(true)
    expect(models.options.requireStructuredOutput).toBe(true)

    const connect = parseCli([
      "auth",
      "connect",
      "openai",
      "--method",
      "subscription-session",
      "--credential",
      "chatgpt-main",
      "--headless",
      "--timeout",
      "120",
    ])
    expect(connect.command).toBe("auth.connect")
    expect(connect.arguments).toEqual([])
    expect(connect.options.provider).toBe("openai")
    expect(connect.options.method).toBe("subscription-session")
    expect(connect.options.headless).toBe(true)
    expect(connect.options.timeout).toBe(120)

    expect(parseCli(["auth", "revoke", "chatgpt-main"]).arguments).toEqual(["chatgpt-main"])
    expect(parseCli(["model", "smoke", "--profile", "executor-main"]).command).toBe("model.smoke")
  })

  test("keeps executor and judge overrides independent and never accepts a secret argv flag", () => {
    const parsed = parseCli([
      "run",
      "--executor-provider",
      "openai",
      "--executor-model",
      "gpt-executor",
      "--executor-credential",
      "executor-secret-ref",
      "--judge-provider",
      "openrouter",
      "--judge-model",
      "judge-model",
      "--judge-credential",
      "judge-secret-ref",
    ])
    expect(parsed.options.executorProvider).toBe("openai")
    expect(parsed.options.executorCredential).toBe("executor-secret-ref")
    expect(parsed.options.judgeProvider).toBe("openrouter")
    expect(parsed.options.judgeCredential).toBe("judge-secret-ref")

    expectParseError(
      ["auth", "connect", "openai", "--method", "api-key", "--api-key", "secret"],
      "RALPH_OPTION_UNKNOWN",
    )
  })

  test("parses evaluation policy, judge aliases and bounded revision controls", () => {
    expect(
      parseCli([
        "run",
        "--judge",
        "external",
        "--judge-threshold",
        "85",
        "--max-revisions",
        "2",
        "--judge-call-retries",
        "1",
        "--judge-unavailable",
        "pause",
        "--judge-blocking-severity",
        "critical",
        "--judge-blocking-severity=major",
        "--judge-rubric",
        '{"weight_policy":"strict-100","criteria":[{"id":"delivery","description":"Delivery is complete","weight":100,"blocking":true}]}',
        "--judge-exhausted",
        "manual-review",
        "--no-gates",
      ]).options,
    ).toMatchObject({
      evaluationMode: "external",
      judgeThreshold: 85,
      maxRevisionAttempts: 2,
      judgeCallRetries: 1,
      judgeUnavailablePolicy: "pause",
      judgeBlockingSeverities: ["critical", "major"],
      judgeRubric: {
        weight_policy: "strict-100",
        criteria: [
          {
            id: "delivery",
            description: "Delivery is complete",
            weight: 100,
            blocking: true,
          },
        ],
      },
      judgeExhaustedPolicy: "manual-review",
      noGates: true,
    })
    expect(parseCli(["once", "--no-judge"]).options.evaluationMode).toBe("deterministic-only")
    expect(parseCli(["once", "--self-review"]).options.evaluationMode).toBe("self")
    expect(parseCli(["once", "--judge-rubric", "derive"]).options.judgeRubric).toBeNull()
    expectParseError(["once", "--judge", "--self-review"], "RALPH_OPTION_DUPLICATED")
    expectParseError(["once", "--judge-threshold", "101"], "RALPH_JUDGE_THRESHOLD_INVALID")
    expectParseError(
      [
        "once",
        "--judge-rubric",
        '{"weight_policy":"strict-100","criteria":[{"id":"delivery","description":"Delivery","weight":90}]}',
      ],
      "RALPH_JUDGE_RUBRIC_INVALID",
    )
  })

  test("parses an explicit audited revision grant for a manual-review exhaustion", () => {
    const parsed = parseCli([
      "review",
      "retry",
      "--run-id",
      "run-01",
      "--task",
      "root/deliver-slice",
      "--additional-revisions",
      "2",
      "--reason",
      "Human reviewed the evidence and requested a bounded retry",
    ])
    expect(parsed).toMatchObject({
      command: "review.retry",
      options: {
        runId: "run-01",
        task: "root/deliver-slice",
        additionalRevisions: 2,
        reason: "Human reviewed the evidence and requested a bounded retry",
      },
    })
    expectParseError(["review", "retry"], "RALPH_REVIEW_RUN_ID_MISSING")
    expectParseError(["review", "retry", "--run-id", "run-01"], "RALPH_REVIEW_TASK_MISSING")
    expectParseError(
      ["review", "retry", "--run-id", "run-01", "--task", "root/task"],
      "RALPH_REVIEW_REVISIONS_MISSING",
    )
    expectParseError(
      [
        "review",
        "retry",
        "--run-id",
        "run-01",
        "--task",
        "root/task",
        "--additional-revisions",
        "0",
        "--reason",
        "retry",
      ],
      "RALPH_OPTION_INTEGER_RANGE",
    )
  })

  test("parses profile configuration metadata without accepting partial identity", () => {
    const parsed = parseCli([
      "profiles",
      "configure",
      "judge-main",
      "--scope",
      "workspace",
      "--role",
      "judge",
      "--backend",
      "embedded",
      "--provider",
      "openrouter",
      "--model",
      "judge-model",
      "--credential",
      "judge-ref",
      "--fallback-profile",
      "judge-backup",
      "--fallback-on",
      "rate-limit",
      "--fallback-on",
      "transient",
    ])
    expect(parsed.command).toBe("profiles.configure")
    expect(parsed.options.profile).toBe("judge-main")
    expect(parsed.options.fallbackProfiles).toEqual(["judge-backup"])
    expect(parsed.options.fallbackOn).toEqual(["rate-limit", "transient"])
    expect(
      parseCli(["profiles", "configure", "--profile", "executor-main", "--scope", "global"]).options
        .profile,
    ).toBe("executor-main")
    expectParseError(
      ["profiles", "configure", "judge-main", "--fallback-on", "authentication"],
      "RALPH_PROFILE_FALLBACK_FAILURE_INVALID",
    )
    expectParseError(["profiles", "configure"], "RALPH_PROFILE_ID_MISSING")
    expectParseError(["auth", "connect", "openai"], "RALPH_AUTH_METHOD_MISSING")
  })

  test("parses a strongly typed external CLI profile without secret-bearing env values", () => {
    const parsed = parseCli([
      "profiles",
      "configure",
      "executor-cli",
      "--scope",
      "workspace",
      "--backend",
      "external-cli",
      "--cli-executable",
      "codex",
      "--cli-arg=--json",
      "--cli-arg",
      '"two words"',
      "--cli-cwd",
      "packages/worker",
      "--cli-env",
      "OPENAI_API_KEY=env:RALPH_OPENAI_API_KEY",
      "--cli-adapter",
      "protocol",
      "--cli-streaming",
      "true",
      "--cli-tool-calling",
      "ralph",
      "--cli-cancellation",
      "true",
      "--cli-usage",
      "reported",
      "--cli-mutation",
      "workspace",
      "--cli-timeout-ms",
      "300000",
      "--cli-output-limit-bytes",
      "1048576",
    ])
    expect(parsed.options).toMatchObject({
      cliExecutable: "codex",
      cliArgs: ["--json", "two words"],
      cliCwd: "packages/worker",
      cliEnvironmentRefs: { OPENAI_API_KEY: "env:RALPH_OPENAI_API_KEY" },
      cliAdapter: "protocol",
      cliStreaming: true,
      cliToolCalling: "ralph",
      cliCancellation: true,
      cliUsage: "reported",
      cliMutationMode: "workspace",
      cliTimeoutMs: 300_000,
      cliOutputLimitBytes: 1_048_576,
    })
    expectParseError(
      ["profiles", "configure", "executor-cli", "--cli-env", "KEY=raw-secret"],
      "RALPH_EXTERNAL_CLI_ENV_REF_INVALID",
    )
  })

  test("parses execution security overrides and rejects conflicting tool rules", () => {
    const parsed = parseCli([
      "run",
      "--security",
      "auto",
      "--headless-ask",
      "deny",
      "--allow-tool",
      "fs.read",
      "--ask-tool",
      "fs.write",
      "--allow-command",
      "bun test tests/unit/parser.test.ts",
      "--read-path",
      "packages/**",
      "--write-path",
      "packages/commands/**",
      "--allow-shell",
    ])
    expect(parsed.options).toMatchObject({
      securityMode: "auto",
      headlessAsk: "deny",
      allowTools: ["fs.read"],
      askTools: ["fs.write"],
      allowShell: true,
    })
    expectParseError(
      ["run", "--allow-tool", "fs.read", "--deny-tool", "fs.read"],
      "RALPH_TOOL_RULE_CONFLICT",
    )
  })

  test("parses repeatable primitive model parameters without silent coercion", () => {
    const parsed = parseCli([
      "profiles",
      "configure",
      "executor-main",
      "--parameter",
      "reasoning_effort=high",
      "--parameter=temperature=0",
      "--parameter",
      "enabled=true",
      "--parameter",
      'label="true"',
    ])
    expect(parsed.options.parameters).toEqual({
      reasoning_effort: "high",
      temperature: 0,
      enabled: true,
      label: "true",
    })
    expectParseError(
      ["model", "smoke", "--parameter", "missing-separator"],
      "RALPH_PROFILE_PARAMETER_SYNTAX_INVALID",
    )
    expectParseError(
      ["model", "smoke", "--parameter", "effort=high", "--parameter", "effort=low"],
      "RALPH_PROFILE_PARAMETER_DUPLICATED",
    )
  })

  test("rejects unknown commands, options and unexpected arguments", () => {
    const commandCanary = "S04_COMMAND_SECRET_CANARY"
    expect(
      JSON.stringify(expectParseError([commandCanary], "RALPH_COMMAND_UNKNOWN").diagnostic),
    ).not.toContain(commandCanary)
    expectParseError(["status", "--mystery"], "RALPH_OPTION_UNKNOWN")
    const argumentCanary = "S04_ARGV_SECRET_CANARY"
    expect(
      JSON.stringify(
        expectParseError(
          ["auth", "connect", "openai", argumentCanary, "--method", "environment"],
          "RALPH_ARGUMENT_UNEXPECTED",
        ).diagnostic,
      ),
    ).not.toContain(argumentCanary)
    expectParseError(["help", "status"], "RALPH_ARGUMENT_UNEXPECTED")
    expectParseError(["config"], "RALPH_COMMAND_UNKNOWN")
    expectParseError(["config", "explain"], "RALPH_CONFIG_KEY_MISSING")
  })

  test("rejects malformed, duplicated, conflicting and disallowed flags", () => {
    expectParseError(["status", "--workspace"], "RALPH_OPTION_VALUE_MISSING")
    expectParseError(["status", "--format", "json", "--format=json"], "RALPH_OPTION_DUPLICATED")
    expectParseError(["status", "--format=human", "--json"], "RALPH_FORMAT_CONFLICT")
    expectParseError(["status", "--json=true"], "RALPH_BOOLEAN_VALUE_UNEXPECTED")
    expectParseError(["--help=garbage"], "RALPH_BOOLEAN_VALUE_UNEXPECTED")
    expectParseError(["--version=garbage"], "RALPH_BOOLEAN_VALUE_UNEXPECTED")
    expectParseError(["--help", "--help"], "RALPH_OPTION_DUPLICATED")
    expectParseError(["version", "--force"], "RALPH_OPTION_NOT_ALLOWED")
    expectParseError(["status", "--format=xml"], "RALPH_FORMAT_INVALID")
    expectParseError(["status", "--"], "RALPH_PASSTHROUGH_UNAVAILABLE")
    expectParseError(["run", "--max-tasks", "0"], "RALPH_OPTION_INTEGER_RANGE")
    expectParseError(["run", "--max-model-calls=1.5"], "RALPH_OPTION_INTEGER_INVALID")
    expectParseError(["run", "--retry-delay=NaN"], "RALPH_OPTION_NUMBER_INVALID")
    expectParseError(["run", "--no-change-policy", "invented"], "RALPH_NO_CHANGE_POLICY_INVALID")
    expectParseError(
      ["run", "--skip-gates", "test", "--skip-gates", "test"],
      "RALPH_OPTION_VALUE_DUPLICATED",
    )
    expectParseError(["loop", "--wiggum"], "RALPH_OPTION_NOT_ALLOWED")
    expectParseError(["loop", "--mode", "wiggum"], "RALPH_OPTION_NOT_ALLOWED")
    expectParseError(["once", "--fail-fast"], "RALPH_OPTION_NOT_ALLOWED")
    expectParseError(["report"], "RALPH_COMMAND_UNKNOWN")
    expectParseError(["report", "show"], "RALPH_REPORT_RUN_ID_MISSING")
    expectParseError(["report", "show", "run-01", "--run-id", "run-02"], "RALPH_RUN_ID_CONFLICT")
  })
})
