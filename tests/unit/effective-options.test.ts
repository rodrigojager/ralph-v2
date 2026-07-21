import { describe, expect, test } from "bun:test"
import { cloneDefaultConfig, type EffectiveConfig } from "@ralph/domain"
import {
  effectiveOptionsAreResumeCompatible,
  effectiveOptionsHash,
  effectiveOptionsResumeCompatibilityHash,
  evaluationPolicyForTask,
  RunOptionsResolutionError,
  resolveEffectiveRunOptions,
} from "@ralph/orchestration"
import { compilePrdGraph } from "@ralph/prd"

const FIXTURE = "tests/fixtures/prd/v2/valid-en.md"

async function compiledTask() {
  const compiled = await compilePrdGraph(FIXTURE, {
    workspaceRoot: process.cwd(),
    recursive: true,
    strict: true,
  })
  if (!compiled.ok || !compiled.graph) throw new Error("Expected the valid PRD fixture to compile")
  const document = compiled.graph.documents[compiled.graph.rootDocumentId]
  const task = document?.tasks[0]
  if (!document || !task) throw new Error("Expected one compiled task")
  return { document, task }
}

function effectiveConfig(): EffectiveConfig {
  const config = cloneDefaultConfig()
  config.defaults.mode = "loop"
  config.defaults.executor_profile = "workspace-runner"
  config.run.retry_delay_seconds = 1.25
  config.run.no_change.policy = "fallback"
  config.run.no_change.max_attempts = 4
  return {
    config,
    values: {
      "defaults.mode": {
        value: "loop",
        source: "workspace",
        sourceRef: "C:\\machine-specific\\config.yaml",
      },
      "defaults.executor_profile": {
        value: "workspace-runner",
        source: "workspace",
        sourceRef: "C:\\machine-specific\\config.yaml",
      },
      "run.retry_delay_seconds": {
        value: 1.25,
        source: "global",
        sourceRef: "/machine-specific/config.yaml",
      },
      "run.no_change.policy": {
        value: "fallback",
        source: "workspace",
        sourceRef: "C:\\machine-specific\\config.yaml",
      },
      "run.no_change.max_attempts": {
        value: 4,
        source: "env",
        sourceRef: "environment",
      },
    },
  }
}

function caughtCode(action: () => unknown): string | undefined {
  try {
    action()
  } catch (error) {
    return error instanceof RunOptionsResolutionError ? error.code : undefined
  }
  return undefined
}

describe("S03 effective run options", () => {
  test("applies CLI > task > PRD > profile > config and records portable provenance", async () => {
    const { document, task } = await compiledTask()
    const resolved = resolveEffectiveRunOptions({
      config: effectiveConfig(),
      document,
      task,
      profile: { id: "profile-runner", maxModelCallsPerAttempt: 8 },
      cli: {
        mode: "wiggum",
        executorProfile: "cli-runner",
        task: "english-contract/english-slice",
        force: true,
        dryRun: false,
        skipTests: true,
        skipGates: ["security", "contract", "security"],
        maxTasks: 3,
        maxIterations: 5,
        maxModelCallsPerAttempt: 9,
        noChangePolicy: "fail-fast",
      },
    })

    expect(resolved.options).toMatchObject({
      mode: { value: "wiggum", source: "cli", sourceRef: "cli:--mode" },
      executorProfile: {
        value: "cli-runner",
        source: "cli",
        sourceRef: "cli:--executor-profile",
      },
      task: {
        value: "english-contract/english-slice",
        source: "cli",
        sourceRef: "cli:--task",
      },
      force: { value: true, source: "cli" },
      skipTests: { value: true, source: "cli" },
      skipGates: { value: ["contract", "security"], source: "cli" },
      delayMs: {
        value: 1_250,
        source: "global",
        sourceRef: "global:run.retry_delay_seconds",
      },
      maxModelCallsPerAttempt: { value: 9, source: "cli" },
      maxNoChangeAttempts: {
        value: 4,
        source: "env",
        sourceRef: "env:run.no_change.max_attempts",
      },
      noChangePolicy: {
        value: "fail-on-no-change",
        original: "fail-fast",
        source: "cli",
        sourceRef: "cli:--no-change-policy",
      },
    })
    expect(resolved.notices).toEqual([
      "Legacy no-change policy `fail-fast` normalized to `fail-on-no-change`.",
    ])
    expect(resolved.optionsHash).toBe(resolved.options.contentHash)
    expect(effectiveOptionsHash(resolved.options)).toBe(resolved.optionsHash)
    expect(JSON.stringify(resolved.options)).not.toContain("machine-specific")
  })

  test("uses task and PRD overrides when CLI does not replace them", async () => {
    const { document, task } = await compiledTask()
    const taskResolved = resolveEffectiveRunOptions({
      config: effectiveConfig(),
      document,
      task,
      profile: { id: "profile-runner", maxModelCallsPerAttempt: 8 },
    })
    expect(taskResolved.options.executorProfile).toEqual({
      value: "runner",
      source: "task",
      sourceRef: "task:english-contract/english-slice",
    })
    expect(taskResolved.options.maxModelCallsPerAttempt).toEqual({
      value: 2,
      source: "task",
      sourceRef: "task:english-contract/english-slice",
    })
    expect(taskResolved.options.noChangePolicy).toMatchObject({
      value: "retry-on-no-change",
      original: "fallback",
      source: "workspace",
      sourceRef: "workspace:run.no_change.policy",
    })
    expect(taskResolved.notices[0]).toContain("does not switch provider or model")

    const prdResolved = resolveEffectiveRunOptions({
      config: effectiveConfig(),
      document,
      profile: { id: "profile-runner", maxModelCallsPerAttempt: 8 },
    })
    expect(prdResolved.options.executorProfile.source).toBe("prd")
    expect(prdResolved.options.maxModelCallsPerAttempt).toEqual({
      value: 4,
      source: "prd",
      sourceRef: "prd:english-contract",
    })
  })

  test("hashes canonical values and audit provenance deterministically", async () => {
    const { document, task } = await compiledTask()
    const first = resolveEffectiveRunOptions({
      config: effectiveConfig(),
      document,
      task,
      cli: {
        fast: true,
        skipGates: ["zeta", "alpha"],
        maxIterations: 2,
      },
    })
    const reordered = resolveEffectiveRunOptions({
      config: effectiveConfig(),
      document,
      task,
      cli: {
        maxIterations: 2,
        skipGates: ["alpha", "zeta"],
        fast: true,
      },
    })
    expect(reordered.optionsHash).toBe(first.optionsHash)

    const canonicalSpelling = resolveEffectiveRunOptions({
      config: effectiveConfig(),
      document,
      task,
      cli: { noChangePolicy: "retry-on-no-change" },
    })
    const legacySpelling = resolveEffectiveRunOptions({
      config: effectiveConfig(),
      document,
      task,
      cli: { noChangePolicy: "retry" },
    })
    expect(canonicalSpelling.options.noChangePolicy.value).toBe(
      legacySpelling.options.noChangePolicy.value,
    )
    expect(canonicalSpelling.optionsHash).not.toBe(legacySpelling.optionsHash)
  })

  test("treats task selection and dry-run as invocation-only for resume compatibility", () => {
    const selected = resolveEffectiveRunOptions({ cli: { task: "slice-b" } }).options
    const unselected = resolveEffectiveRunOptions().options
    const dryRun = resolveEffectiveRunOptions({ cli: { dryRun: true } }).options

    expect(selected.contentHash).not.toBe(unselected.contentHash)
    expect(dryRun.contentHash).not.toBe(unselected.contentHash)
    expect(effectiveOptionsResumeCompatibilityHash(selected)).toBe(
      effectiveOptionsResumeCompatibilityHash(unselected),
    )
    expect(effectiveOptionsResumeCompatibilityHash(dryRun)).toBe(
      effectiveOptionsResumeCompatibilityHash(unselected),
    )
    expect(effectiveOptionsAreResumeCompatible(selected, unselected)).toBeTrue()
    expect(effectiveOptionsAreResumeCompatible(dryRun, unselected)).toBeTrue()

    const otherExecutor = resolveEffectiveRunOptions({
      cli: { task: "slice-b", executorProfile: "another-executor" },
    }).options
    expect(effectiveOptionsAreResumeCompatible(selected, otherExecutor)).toBeFalse()
  })

  test("records executor and judge routing overrides independently", () => {
    const config = effectiveConfig()
    config.config.defaults.judge_profile = "judge-config"
    config.values["defaults.judge_profile"] = {
      value: "judge-config",
      source: "global",
      sourceRef: "/machine-specific/config.yaml",
    }
    const resolved = resolveEffectiveRunOptions({
      config,
      cli: {
        executorProvider: "openai",
        executorModel: "executor-model",
        executorCredential: "executor-auth",
        executorVariant: "thorough",
        judgeProfile: "judge-cli",
        judgeProvider: "openrouter",
        judgeModel: "judge-model",
        judgeCredential: "judge-auth",
        judgeVariant: "balanced",
        evaluationMode: "external",
        judgeThreshold: 91,
        maxRevisionAttempts: 2,
        judgeCallRetries: 1,
        judgeUnavailablePolicy: "fail",
        blockingJudgeSeverities: ["critical", "major"],
        judgeExhaustedPolicy: "stop-run",
        noGates: true,
        force: true,
      },
    }).options

    expect(resolved.executorProvider).toEqual({
      value: "openai",
      source: "cli",
      sourceRef: "cli:--executor-provider",
    })
    expect(resolved.executorCredential?.value).toBe("executor-auth")
    expect(resolved.judgeProfile).toEqual({
      value: "judge-cli",
      source: "cli",
      sourceRef: "cli:--judge-profile",
    })
    expect(resolved.judgeProvider).toEqual({
      value: "openrouter",
      source: "cli",
      sourceRef: "cli:--judge-provider",
    })
    expect(resolved.judgeModel).toEqual({
      value: "judge-model",
      source: "cli",
      sourceRef: "cli:--judge-model",
    })
    expect(resolved.judgeCredential).toEqual({
      value: "judge-auth",
      source: "cli",
      sourceRef: "cli:--judge-credential",
    })
    expect(resolved.judgeVariant).toEqual({
      value: "balanced",
      source: "cli",
      sourceRef: "cli:--judge-variant",
    })
    expect(resolved.executorCredential?.value).not.toBe(resolved.judgeCredential?.value)
    expect(resolved).toMatchObject({
      evaluationMode: {
        value: "external",
        source: "cli",
        sourceRef: "cli:--evaluation/--judge/--no-judge/--self-review",
      },
      judgeThreshold: {
        value: 91,
        source: "cli",
        sourceRef: "cli:--judge-threshold",
      },
      maxRevisionAttempts: {
        value: 2,
        source: "cli",
        sourceRef: "cli:--judge-max-revisions/--max-revisions",
      },
      judgeCallRetries: {
        value: 1,
        source: "cli",
        sourceRef: "cli:--judge-call-retries",
      },
      judgeUnavailablePolicy: {
        value: "fail",
        source: "cli",
        sourceRef: "cli:--judge-unavailable",
      },
      blockingJudgeSeverities: {
        value: ["critical", "major"],
        source: "cli",
        sourceRef: "cli:--judge-blocking-severity",
      },
      judgeExhaustedPolicy: {
        value: "stop-run",
        source: "cli",
        sourceRef: "cli:--judge-exhausted",
      },
      noGates: { value: true, source: "cli" },
    })

    const changedJudge = resolveEffectiveRunOptions({
      config,
      cli: { judgeProfile: "judge-cli", judgeModel: "different-judge" },
    }).options
    expect(effectiveOptionsAreResumeCompatible(resolved, changedJudge)).toBeFalse()
    expect(resolveEffectiveRunOptions().options.judgeProfile).toBeUndefined()
  })

  test("materializes a configured rubric with provenance and otherwise derives task criteria", async () => {
    const { document, task } = await compiledTask()
    const config = effectiveConfig()
    config.config.evaluation.rubric = {
      weight_policy: "normalize",
      criteria: [
        {
          id: "workspace-quality",
          description: "The workspace delivery is evidence-grounded.",
          weight: 1,
          blocking: false,
        },
      ],
    }
    config.values["evaluation.rubric.criteria"] = {
      value: config.config.evaluation.rubric.criteria,
      source: "workspace",
      sourceRef: "C:\\machine-specific\\config.yaml",
    }
    const fromConfig = resolveEffectiveRunOptions({ config, document, task }).options
    expect(fromConfig.judgeRubric).toMatchObject({
      source: "workspace",
      sourceRef: "workspace:evaluation.rubric",
      value: { criteria: [{ id: "workspace-quality" }] },
    })

    const configured = resolveEffectiveRunOptions({
      config,
      document,
      task,
      cli: {
        judgeRubric: {
          weight_policy: "strict-100",
          criteria: [
            {
              id: "end-to-end",
              description: "The vertical slice is connected end to end.",
              weight: 100,
              blocking: true,
            },
          ],
        },
      },
    }).options

    expect(configured.judgeRubric).toMatchObject({
      source: "cli",
      sourceRef: "cli:--judge-rubric",
      value: { weight_policy: "strict-100" },
    })
    expect(evaluationPolicyForTask(configured, task).rubric).toEqual({
      schemaVersion: 1,
      weightPolicy: "strict-100",
      criteria: [
        {
          criterion: "end-to-end",
          description: "The vertical slice is connected end to end.",
          weight: 100,
          blocking: true,
        },
      ],
    })

    const derived = resolveEffectiveRunOptions({ document, task }).options
    expect(derived.judgeRubric).toBeUndefined()
    expect(evaluationPolicyForTask(derived, task).rubric.criteria).toEqual(
      task.criteria.map((criterion) => ({
        criterion: criterion.id,
        description: criterion.text.text,
        weight: criterion.weight ?? 1,
        blocking: criterion.blocking ?? false,
      })),
    )

    const reset = resolveEffectiveRunOptions({
      config,
      document,
      task,
      cli: { judgeRubric: null },
    }).options
    expect(reset.judgeRubric).toMatchObject({ value: null, source: "cli" })
    expect(evaluationPolicyForTask(reset, task).rubric).toEqual(
      evaluationPolicyForTask(derived, task).rubric,
    )
  })

  test("materializes task-run security overrides with deterministic provenance and hashing", () => {
    const config = effectiveConfig()
    config.config.security = {
      mode: "safe",
      headless_ask: "deny",
      tool_rules: { "fs.read": "allow", "fs.write": "deny" },
      allowed_commands: ["git status"],
      read_paths: ["."],
      write_paths: ["packages/**"],
      allow_shell: false,
      network_mode: "none",
      network_destinations: [],
      external_effects: [],
      dangerous_override_reason: null,
    }
    const resolved = resolveEffectiveRunOptions({
      config,
      cli: {
        securityMode: "auto",
        headlessAsk: "allow",
        toolRules: { "fs.write": "ask", "git.status": "allow" },
        allowedCommands: ["bun test tests/unit/parser.test.ts"],
        readPaths: ["docs/**"],
        writePaths: ["packages/commands/**"],
        allowShell: true,
      },
    }).options
    expect(resolved).toMatchObject({
      securityMode: { value: "auto", source: "cli", sourceRef: "cli:--security" },
      headlessAsk: { value: "allow", source: "cli", sourceRef: "cli:--headless-ask" },
      toolRules: {
        value: { "fs.read": "allow", "fs.write": "ask", "git.status": "allow" },
        source: "cli",
      },
      allowedCommands: {
        value: ["bun test tests/unit/parser.test.ts", "git status"],
        source: "cli",
      },
      readPaths: { value: [".", "docs/**"], source: "cli" },
      writePaths: {
        value: ["packages/**", "packages/commands/**"],
        source: "cli",
      },
      allowShell: { value: true, source: "cli", sourceRef: "cli:--allow-shell" },
    })

    const safer = resolveEffectiveRunOptions({ config }).options
    expect(effectiveOptionsAreResumeCompatible(resolved, safer)).toBeFalse()
    expect(resolved.contentHash).not.toBe(safer.contentHash)
  })

  test("rejects invalid limits, empty gate IDs and task overrides without a document", async () => {
    const { task } = await compiledTask()
    expect(caughtCode(() => resolveEffectiveRunOptions({ cli: { maxIterations: 0 } }))).toBe(
      "RALPH_EFFECTIVE_RUN_OPTIONS_INVALID",
    )
    expect(
      caughtCode(() => resolveEffectiveRunOptions({ cli: { skipGates: ["test", " "] } })),
    ).toBe("RALPH_SKIP_GATE_EMPTY")
    expect(caughtCode(() => resolveEffectiveRunOptions({ task }))).toBe(
      "RALPH_RUN_OPTION_TASK_DOCUMENT_REQUIRED",
    )
    expect(caughtCode(() => resolveEffectiveRunOptions({ cli: { noGates: true } }))).toBe(
      "RALPH_NO_GATES_NOT_AUTHORIZED",
    )
    expect(
      caughtCode(() =>
        resolveEffectiveRunOptions({
          cli: { toolRules: { "Not A Tool": "allow" } },
        }),
      ),
    ).toBe("RALPH_TOOL_RULE_INVALID")
  })
})
