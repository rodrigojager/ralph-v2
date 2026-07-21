import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type RalphError, RoleProfileConfigSchema } from "@ralph/domain"
import {
  effectiveValue,
  globalConfigPath,
  loadEffectiveConfig,
  readWorkspaceConfig,
  writeRoleProfileConfig,
} from "@ralph/persistence"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

async function writeYaml(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, text, "utf8")
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("configuration precedence", () => {
  test("applies CLI > env > workspace > global > builtin and explains each winner", async () => {
    const root = await temporaryDirectory()
    const configHome = join(root, "global")
    const environment = {
      RALPH_CONFIG_HOME: configHome,
      RALPH_MODE: "parallel",
      RALPH_UI: "plain",
      RALPH_LANG: "en-US",
    }
    const globalPath = globalConfigPath(environment)
    const workspacePath = join(root, "workspace.yaml")
    await writeYaml(
      globalPath,
      "defaults:\n  mode: once\n  ui: none\n  lang: es-ES\nrun:\n  max_attempts: 11\n",
    )
    await writeYaml(
      workspacePath,
      "schema_version: 1\ndefaults:\n  mode: wiggum\n  ui: tui\n  lang: pt-PT\nrun:\n  max_attempts: 7\n",
    )

    const withCli = await loadEffectiveConfig({
      workspaceConfig: workspacePath,
      environment,
      cli: { mode: "loop", ui: "auto", lang: "pt-BR" },
    })
    expect(withCli.config.defaults).toMatchObject({ mode: "loop", ui: "auto", lang: "pt-BR" })
    expect(effectiveValue(withCli, "defaults.mode")).toEqual({
      value: "loop",
      source: "cli",
      sourceRef: "command line",
    })

    const withEnv = await loadEffectiveConfig({ workspaceConfig: workspacePath, environment })
    expect(withEnv.config.defaults).toMatchObject({
      mode: "parallel",
      ui: "plain",
      lang: "en-US",
    })
    expect(effectiveValue(withEnv, "defaults.mode")?.source).toBe("env")
    expect(effectiveValue(withEnv, "run.max_attempts")).toMatchObject({
      value: 7,
      source: "workspace",
      sourceRef: workspacePath,
    })

    const withoutEnv = await loadEffectiveConfig({
      workspaceConfig: workspacePath,
      environment: { RALPH_CONFIG_HOME: configHome },
    })
    expect(withoutEnv.config.defaults.mode).toBe("wiggum")
    expect(effectiveValue(withoutEnv, "defaults.mode")?.source).toBe("workspace")

    const globalOnly = await loadEffectiveConfig({
      environment: { RALPH_CONFIG_HOME: configHome },
    })
    expect(globalOnly.config.defaults.mode).toBe("once")
    expect(effectiveValue(globalOnly, "defaults.mode")?.source).toBe("global")

    const builtinOnly = await loadEffectiveConfig({
      environment: { RALPH_CONFIG_HOME: join(root, "absent") },
    })
    expect(builtinOnly.config.defaults.mode).toBe("loop")
    expect(effectiveValue(builtinOnly, "defaults.mode")).toEqual({
      value: "loop",
      source: "builtin",
      sourceRef: "ralph-v2 defaults",
    })
  })

  test("merges every evaluation policy through partial global and workspace overlays", async () => {
    const root = await temporaryDirectory()
    const configHome = join(root, "evaluation-global")
    const environment = { RALPH_CONFIG_HOME: configHome }
    const globalPath = globalConfigPath(environment)
    const workspacePath = join(root, "evaluation-workspace.yaml")
    await writeYaml(
      globalPath,
      [
        "evaluation:",
        "  mode: self",
        "  threshold: 70",
        "  max_revision_attempts: 1",
        "  judge_call_retries: 4",
        "  on_judge_unavailable: fail",
        "  blocking_severities: [major]",
        "  exhausted_policy: fail",
        "defaults:",
        "  judge_profile: global-reviewer",
        "",
      ].join("\n"),
    )
    await writeYaml(
      workspacePath,
      [
        "schema_version: 1",
        "evaluation:",
        "  mode: external",
        "  threshold: 92",
        "  on_judge_unavailable: deterministic",
        "  blocking_severities: [critical, major]",
        "defaults:",
        "  judge_profile: workspace-reviewer",
        "",
      ].join("\n"),
    )

    const effective = await loadEffectiveConfig({ workspaceConfig: workspacePath, environment })

    expect(effective.config.evaluation).toEqual({
      mode: "external",
      threshold: 92,
      max_revision_attempts: 1,
      judge_call_retries: 4,
      on_judge_unavailable: "deterministic",
      blocking_severities: ["critical", "major"],
      exhausted_policy: "fail",
    })
    expect(effective.config.defaults.judge_profile).toBe("workspace-reviewer")
    expect(effectiveValue(effective, "evaluation.threshold")).toEqual({
      value: 92,
      source: "workspace",
      sourceRef: workspacePath,
    })
    expect(effectiveValue(effective, "evaluation.judge_call_retries")).toEqual({
      value: 4,
      source: "global",
      sourceRef: globalPath,
    })
    expect(effectiveValue(effective, "defaults.judge_profile")).toEqual({
      value: "workspace-reviewer",
      source: "workspace",
      sourceRef: workspacePath,
    })
  })

  test("replaces a global rubric from workspace config and allows an explicit derived reset", async () => {
    const root = await temporaryDirectory()
    const configHome = join(root, "rubric-global")
    const environment = { RALPH_CONFIG_HOME: configHome }
    const globalPath = globalConfigPath(environment)
    const workspacePath = join(root, "rubric-workspace.yaml")
    await writeYaml(
      globalPath,
      [
        "evaluation:",
        "  rubric:",
        "    weight_policy: strict-100",
        "    criteria:",
        "      - id: delivery",
        "        description: The requested delivery is complete.",
        "        weight: 100",
        "        blocking: true",
        "",
      ].join("\n"),
    )
    await writeYaml(
      workspacePath,
      [
        "schema_version: 1",
        "evaluation:",
        "  rubric:",
        "    criteria:",
        "      - id: behavior",
        "        description: The observable behavior matches the task.",
        "        weight: 3",
        "      - id: evidence",
        "        description: The supplied evidence supports the behavior.",
        "        weight: 2",
        "",
      ].join("\n"),
    )

    const overridden = await loadEffectiveConfig({ workspaceConfig: workspacePath, environment })
    expect(overridden.config.evaluation.rubric).toEqual({
      weight_policy: "normalize",
      criteria: [
        {
          id: "behavior",
          description: "The observable behavior matches the task.",
          weight: 3,
          blocking: false,
        },
        {
          id: "evidence",
          description: "The supplied evidence supports the behavior.",
          weight: 2,
          blocking: false,
        },
      ],
    })
    expect(effectiveValue(overridden, "evaluation.rubric.criteria")).toEqual({
      value: overridden.config.evaluation.rubric?.criteria,
      source: "workspace",
      sourceRef: workspacePath,
    })

    await writeYaml(workspacePath, "schema_version: 1\nevaluation:\n  rubric: null\n")
    const reset = await loadEffectiveConfig({ workspaceConfig: workspacePath, environment })
    expect(reset.config.evaluation.rubric).toBeNull()
    expect(effectiveValue(reset, "evaluation.rubric")).toEqual({
      value: null,
      source: "workspace",
      sourceRef: workspacePath,
    })
  })

  test("rejects duplicate YAML keys and strict workspace-schema extensions", async () => {
    const root = await temporaryDirectory()
    const isolatedEnvironment = { RALPH_CONFIG_HOME: join(root, "empty-global") }
    const duplicate = join(root, "duplicate.yaml")
    await writeYaml(duplicate, "defaults:\n  mode: once\n  mode: loop\n")
    await expect(
      loadEffectiveConfig({ workspaceConfig: duplicate, environment: isolatedEnvironment }),
    ).rejects.toMatchObject({
      code: "RALPH_CONFIG_YAML_INVALID",
      exitCode: 2,
      diagnostic: { file: duplicate, line: 3, column: 3 },
    })

    const partial = join(root, "partial.yaml")
    await writeYaml(partial, "schema_version: 1\ndefaults:\n  mode: once\n")
    expect(await readWorkspaceConfig(partial)).toEqual({
      schema_version: 1,
      defaults: { mode: "once" },
    })

    const strict = join(root, "strict.yaml")
    await writeYaml(strict, "schema_version: 1\nunexpected: true\n")
    await expect(readWorkspaceConfig(strict)).rejects.toMatchObject({
      code: "RALPH_CONFIG_SCHEMA_INVALID",
      exitCode: 2,
      diagnostic: {
        file: strict,
        line: 2,
        column: 13,
        details: { issues: [{ path: "unexpected" }] },
      },
    })

    const prematureProfile = join(root, "premature-profile.yaml")
    await writeYaml(
      prematureProfile,
      "schema_version: 1\nprofiles:\n  malicious:\n    token: config-secret-canary-98765\n",
    )
    await expect(
      loadEffectiveConfig({ workspaceConfig: prematureProfile, environment: isolatedEnvironment }),
    ).rejects.toMatchObject({
      code: "RALPH_CONFIG_SCHEMA_INVALID",
      exitCode: 2,
    } satisfies Partial<RalphError>)

    const pollution = join(root, "prototype-pollution.yaml")
    await writeYaml(pollution, "schema_version: 1\n__proto__:\n  ralph_polluted: true\n")
    await expect(readWorkspaceConfig(pollution)).rejects.toMatchObject({
      code: "RALPH_CONFIG_KEY_FORBIDDEN",
      exitCode: 2,
    } satisfies Partial<RalphError>)
    expect((Object.prototype as Record<string, unknown>).ralph_polluted).toBeUndefined()

    const aliasBomb = join(root, "alias-bomb.yaml")
    await writeYaml(
      aliasBomb,
      [
        "schema_version: 1",
        "seed: &seed [bounded, alias, expansion]",
        `bomb: [${Array.from({ length: 51 }, () => "*seed").join(", ")}]`,
        "",
      ].join("\n"),
    )
    await expect(readWorkspaceConfig(aliasBomb)).rejects.toMatchObject({
      code: "RALPH_CONFIG_YAML_ALIAS_LIMIT",
      exitCode: 2,
      diagnostic: { file: aliasBomb },
    })

    const invalidGlobalEnvironment = { RALPH_CONFIG_HOME: join(root, "invalid-global") }
    const invalidGlobal = globalConfigPath(invalidGlobalEnvironment)
    await mkdir(invalidGlobal, { recursive: true })
    await expect(
      loadEffectiveConfig({ environment: invalidGlobalEnvironment }),
    ).rejects.toMatchObject({
      code: "RALPH_CONFIG_READ_FAILED",
      exitCode: 2,
      diagnostic: { file: invalidGlobal },
    })
  })

  test("merges independent executor and judge profiles while persisting only credential refs", async () => {
    const root = await temporaryDirectory()
    const configHome = join(root, "global-profiles")
    const environment = { RALPH_CONFIG_HOME: configHome }
    const globalPath = globalConfigPath(environment)
    const workspacePath = join(root, "workspace-profiles.yaml")
    await writeYaml(
      globalPath,
      [
        "schema_version: 1",
        "defaults:",
        "  executor_profile: executor-main",
        "  judge_profile: judge-main",
        "profiles:",
        "  executor-main:",
        "    role: executor",
        "    backend: embedded",
        "    provider: openai",
        "    model: executor-global",
        "    credential: executor-auth",
        "    fallback_profiles: [executor-backup]",
        "    fallback_on: [rate-limit, transient]",
        "  executor-backup:",
        "    role: executor",
        "    backend: embedded",
        "    provider: anthropic",
        "    model: backup-model",
        "    credential: executor-backup-auth",
        "",
      ].join("\n"),
    )
    await writeYaml(
      workspacePath,
      [
        "schema_version: 1",
        "profiles:",
        "  executor-main:",
        "    model: executor-workspace",
        "  judge-main:",
        "    role: judge",
        "    backend: embedded",
        "    provider: openrouter",
        "    model: judge-model",
        "    credential: judge-auth",
        "    requirements:",
        "      structured_output: true",
        "",
      ].join("\n"),
    )

    const effective = await loadEffectiveConfig({ workspaceConfig: workspacePath, environment })
    expect(effective.config.profiles["executor-main"]).toMatchObject({
      role: "executor",
      provider: "openai",
      model: "executor-workspace",
      credential: "executor-auth",
      fallback_profiles: ["executor-backup"],
      fallback_on: ["rate-limit", "transient"],
    })
    expect(effective.config.profiles["judge-main"]).toMatchObject({
      role: "judge",
      provider: "openrouter",
      model: "judge-model",
      credential: "judge-auth",
      requirements: { structured_output: true },
    })
    expect(effective.config.profiles["judge-main"]?.requirements.tools).toBe(false)
    expect(effectiveValue(effective, "profiles.executor-main.model")).toEqual({
      value: "executor-workspace",
      source: "workspace",
      sourceRef: workspacePath,
    })
    expect(effective.config.profiles["executor-main"]?.credential).not.toBe(
      effective.config.profiles["judge-main"]?.credential,
    )
  })

  test("writes a complete profile atomically without accepting credential material", async () => {
    const root = await temporaryDirectory()
    const path = join(root, "profile-config.yaml")
    const base = {
      role: "executor" as const,
      backend: "embedded" as const,
      provider: "openai",
      model: "executor-model",
      credential: "openai-main",
      parameters: {},
      requirements: {
        input: ["text" as const],
        tools: true,
        tool_streaming: true,
        reasoning: true,
        structured_output: false,
        usage: ["input" as const, "output" as const],
        access: ["api" as const],
      },
      fallback_profiles: [],
      fallback_on: [],
      limits: {},
    }
    const created = await writeRoleProfileConfig(path, "executor-main", base, {
      workspace: true,
      validateEffective: () => {},
    })
    expect(created.created).toBeTrue()
    expect(created.previous).toBeUndefined()
    expect(await readWorkspaceConfig(path)).toMatchObject({
      schema_version: 1,
      profiles: { "executor-main": { credential: "openai-main" } },
    })

    const replaced = await writeRoleProfileConfig(
      path,
      "executor-main",
      { ...base, model: "executor-model-v2" },
      { workspace: true, validateEffective: () => {} },
    )
    expect(replaced.created).toBeFalse()
    expect(replaced.previous?.model).toBe("executor-model")
    expect(await readFile(path, "utf8")).toContain("model: executor-model-v2")

    await expect(
      writeRoleProfileConfig(
        path,
        "executor-main",
        { ...base, api_key: "config-secret-canary" } as typeof base,
        { workspace: true, validateEffective: () => {} },
      ),
    ).rejects.toMatchObject({ code: "RALPH_PROFILE_CONFIG_INVALID", exitCode: 2 })
    expect(await readFile(path, "utf8")).not.toContain("config-secret-canary")
  })

  test("requires strong external CLI process metadata and only environment references", async () => {
    const external = RoleProfileConfigSchema.parse({
      role: "executor",
      backend: "external-cli",
      provider: "codex-cli",
      model: "subscription",
      requirements: {},
      external_cli: {
        executable: "codex",
        args: ["exec", "--json"],
        cwd: ".",
        environment_refs: { OPENAI_API_KEY: "env:RALPH_OPENAI_API_KEY" },
        input_mode: "stdin-json",
        adapter: "protocol",
        capabilities: {
          streaming: true,
          tool_calling: "ralph",
          cancellation: true,
          usage: "reported",
        },
        mutation_mode: "workspace",
        timeout_ms: 300_000,
        output_limit_bytes: 1_048_576,
      },
    })
    expect(external.external_cli?.environment_refs).toEqual({
      OPENAI_API_KEY: "env:RALPH_OPENAI_API_KEY",
    })
    expect(() => RoleProfileConfigSchema.parse({ ...external, backend: "embedded" })).toThrow(
      "cannot declare external_cli",
    )
    expect(() =>
      RoleProfileConfigSchema.parse({
        ...external,
        external_cli: {
          ...external.external_cli,
          environment_refs: { OPENAI_API_KEY: "raw-secret" },
        },
      }),
    ).toThrow("env:<NAME>")
  })

  test("merges the complete execution security policy with leaf provenance", async () => {
    const root = await temporaryDirectory()
    const workspacePath = join(root, "security.yaml")
    await writeYaml(
      workspacePath,
      [
        "schema_version: 1",
        "security:",
        "  mode: auto",
        "  headless_ask: deny",
        "  tool_rules:",
        "    fs.read: allow",
        "    fs.write: ask",
        "  allowed_commands: [bun]",
        "  read_paths: ['.']",
        "  write_paths: [packages/commands/**]",
        "  allow_shell: false",
        "",
      ].join("\n"),
    )
    const effective = await loadEffectiveConfig({
      workspaceConfig: workspacePath,
      environment: { RALPH_CONFIG_HOME: join(root, "empty-global") },
    })
    expect(effective.config.security).toEqual({
      mode: "auto",
      headless_ask: "deny",
      tool_rules: { "fs.read": "allow", "fs.write": "ask" },
      allowed_commands: ["bun"],
      read_paths: ["."],
      write_paths: ["packages/commands/**"],
      allow_shell: false,
      network_mode: "none",
      network_destinations: [],
      external_effects: [],
      dangerous_override_reason: null,
    })
    expect(effectiveValue(effective, "security.mode")).toMatchObject({
      value: "auto",
      source: "workspace",
    })
  })
})
