import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import {
  EvaluationPolicySchema,
  JudgeAssessmentSchema,
  JudgeOutputSchema,
  JudgeRubricSchema,
} from "@ralph-next/domain"

const FIXTURES = resolve(import.meta.dir, "../fixtures/judge")
const SCHEMAS = resolve(import.meta.dir, "../../schemas")

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(FIXTURES, name), "utf8"))
}

describe("judge domain contracts", () => {
  test("accepts a complete evidence-grounded assessment", async () => {
    const assessment = JudgeAssessmentSchema.parse(await fixture("valid-assessment.json"))
    expect(assessment.score).toBe(88)
    expect(assessment.profileSnapshot.role).toBe("judge")
    expect(assessment.problems[0]?.evidenceRefs).toEqual(["artifact:report"])
  })

  test("rejects out-of-range and contradictory criterion scores", async () => {
    const invalidScore = await fixture("invalid-score-assessment.json")
    const contradictory = await fixture("contradictory-assessment.json")
    expect(() => JudgeAssessmentSchema.parse(invalidScore)).toThrow()
    expect(() => JudgeAssessmentSchema.parse(contradictory)).toThrow("unique criteria")
    expect(() =>
      JudgeOutputSchema.parse({
        schemaVersion: 1,
        score: 1.5,
        summary: "Fractional score",
        adequate: [],
        problems: [],
        missingEvidence: [],
        recommendations: [],
        criterionScores: [],
      }),
    ).toThrow()
  })

  test("rejects a truncated transport document before runtime validation", async () => {
    const document = await readFile(resolve(FIXTURES, "truncated-assessment.json"), "utf8")
    expect(() => JSON.parse(document)).toThrow()
  })

  test("validates explicit rubric weighting and evaluation policies", () => {
    const rubric = JudgeRubricSchema.parse({
      schemaVersion: 1,
      weightPolicy: "strict-100",
      criteria: [
        { criterion: "behavior", description: "Observable behavior", weight: 70 },
        { criterion: "evidence", description: "Deterministic evidence", weight: 30 },
      ],
    })
    expect(rubric.criteria.every((criterion) => criterion.blocking === false)).toBeTrue()
    expect(
      EvaluationPolicySchema.parse({
        schemaVersion: 1,
        mode: "external",
        threshold: 85,
        maxRevisionAttempts: 2,
        judgeCallRetries: 1,
        onJudgeUnavailable: "pause",
        blockingSeverities: ["critical"],
        exhaustedPolicy: "manual-review",
        rubric,
      }).threshold,
    ).toBe(85)
    expect(() =>
      JudgeRubricSchema.parse({
        schemaVersion: 1,
        weightPolicy: "strict-100",
        criteria: [{ criterion: "behavior", description: "Behavior", weight: 90 }],
      }),
    ).toThrow("totaling 100")
  })

  test("publishes closed runtime-derived judge schemas", async () => {
    for (const name of ["judge-output", "judge-assessment", "judge-rubric", "evaluation-policy"]) {
      const generated: unknown = JSON.parse(
        await readFile(resolve(SCHEMAS, `${name}.schema.json`), "utf8"),
      )
      expect(generated).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `https://rodrigojager.github.io/ralph-v2/schemas/v2/${name}.schema.json`,
        type: "object",
        additionalProperties: false,
      })
    }
  })
})
