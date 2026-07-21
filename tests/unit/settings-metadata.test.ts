import { describe, expect, test } from "bun:test"
import {
  EVALUATION_SETTINGS_METADATA,
  EXTERNAL_CLI_PROFILE_SETTINGS_METADATA,
  evaluationFormMetadata,
  OPTION_METADATA,
  parseCli,
  ROLE_PROFILE_FORM_METADATA,
  roleProfileFormMetadata,
} from "@ralph/commands"
import { DEFAULT_CONFIG } from "@ralph/domain"

describe("S04 shared role-profile form metadata", () => {
  test("maps every popup field to a documented CLI route and config key", () => {
    const documented = new Set(OPTION_METADATA.map((option) => option.syntax.split(" ")[0]))
    for (const field of ROLE_PROFILE_FORM_METADATA) {
      expect(field.configPath.length).toBeGreaterThan(0)
      expect(field.secret).toBeFalse()
      if (field.cliFlag.startsWith("config:")) {
        expect(field.configPath).toBe(`profiles.<id>.${field.cliFlag.slice("config:".length)}`)
      } else {
        expect(documented).toContain(field.cliFlag)
      }
    }
    expect(new Set(ROLE_PROFILE_FORM_METADATA.map((field) => field.id)).size).toBe(
      ROLE_PROFILE_FORM_METADATA.length,
    )
  })

  test("exposes the same metadata to headless JSON and interactive clients", () => {
    const form = roleProfileFormMetadata("judge-main")
    expect(form).toMatchObject({
      schemaVersion: 1,
      formId: "role-profile",
      profileId: "judge-main",
    })
    expect(form.fields.slice(0, ROLE_PROFILE_FORM_METADATA.length)).toEqual([
      ...ROLE_PROFILE_FORM_METADATA,
    ])
    const externalFields = form.fields.slice(ROLE_PROFILE_FORM_METADATA.length)
    expect(externalFields.map((field) => field.id)).toEqual(
      EXTERNAL_CLI_PROFILE_SETTINGS_METADATA.map((field) => field.id),
    )
    expect(externalFields.every((field) => field.visibleWhen !== undefined)).toBe(true)

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
    ])
    expect(parsed.options.profile).toBe(form.profileId)
    expect(parsed.options.scope).toBe("workspace")
    expect(parsed.options.role).toBe("judge")
  })
})

describe("S06 shared evaluation form metadata", () => {
  test("maps every evaluation field to config, CLI and effective-option provenance", () => {
    const documentedFlags = new Set(OPTION_METADATA.map((option) => option.syntax.split(" ")[0]))
    const fieldIds = new Set(EVALUATION_SETTINGS_METADATA.map((field) => field.id))
    const effectiveKeys = new Set(
      EVALUATION_SETTINGS_METADATA.map((field) => field.effectiveOptionKey),
    )
    const expectedEffectiveKeys: Array<
      (typeof EVALUATION_SETTINGS_METADATA)[number]["effectiveOptionKey"]
    > = [
      "evaluationMode",
      "judgeProfile",
      "judgeProvider",
      "judgeModel",
      "judgeCredential",
      "judgeVariant",
      "judgeThreshold",
      "maxRevisionAttempts",
      "judgeCallRetries",
      "judgeUnavailablePolicy",
      "blockingJudgeSeverities",
      "judgeRubric",
      "judgeExhaustedPolicy",
    ]

    expect(fieldIds.size).toBe(EVALUATION_SETTINGS_METADATA.length)
    expect(effectiveKeys.size).toBe(EVALUATION_SETTINGS_METADATA.length)
    expect([...effectiveKeys].sort()).toEqual(expectedEffectiveKeys.sort())
    for (const field of EVALUATION_SETTINGS_METADATA) {
      expect(field.configPath.length).toBeGreaterThan(0)
      expect(field.effectiveOptionKey.length).toBeGreaterThan(0)
      expect(field.secret).toBeFalse()
      expect(documentedFlags).toContain(field.cliFlag)
      for (const alias of "cliAliases" in field ? field.cliAliases : []) {
        expect(documentedFlags).toContain(alias)
      }
      if ("visibleWhen" in field) expect(fieldIds).toContain(field.visibleWhen.fieldId)
    }
  })

  test("publishes versioned defaults and numeric constraints without duplicating secret values", () => {
    const metadata = evaluationFormMetadata()
    expect(metadata).toMatchObject({ schemaVersion: 1, formId: "evaluation" })
    expect(metadata.fields).toBe(EVALUATION_SETTINGS_METADATA)
    const fields = Object.fromEntries(metadata.fields.map((field) => [field.id, field]))

    expect(fields.evaluationMode?.defaultValue).toBe(DEFAULT_CONFIG.evaluation.mode)
    expect(fields.judgeProfile?.defaultValue).toBe(DEFAULT_CONFIG.defaults.judge_profile)
    expect(fields.judgeThreshold).toMatchObject({
      defaultValue: DEFAULT_CONFIG.evaluation.threshold,
      minimum: 0,
      maximum: 100,
    })
    expect(fields.maxRevisionAttempts).toMatchObject({
      defaultValue: DEFAULT_CONFIG.evaluation.max_revision_attempts,
      minimum: 0,
    })
    expect(fields.judgeCallRetries).toMatchObject({
      defaultValue: DEFAULT_CONFIG.evaluation.judge_call_retries,
      minimum: 0,
    })
    expect(fields.judgeUnavailablePolicy?.defaultValue).toBe(
      DEFAULT_CONFIG.evaluation.on_judge_unavailable,
    )
    expect(fields.blockingJudgeSeverities?.defaultValue).toEqual(
      DEFAULT_CONFIG.evaluation.blocking_severities,
    )
    expect(fields.judgeRubric).toMatchObject({
      kind: "json",
      configPath: "evaluation.rubric",
      cliFlag: "--judge-rubric",
      effectiveOptionKey: "judgeRubric",
      required: false,
    })
    expect(fields.judgeExhaustedPolicy?.defaultValue).toBe(
      DEFAULT_CONFIG.evaluation.exhausted_policy,
    )
    expect(JSON.stringify(metadata)).not.toMatch(/api[_-]?key|access[_-]?token|refresh[_-]?token/i)
  })
})
