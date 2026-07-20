import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"

const SCHEMAS = resolve(import.meta.dir, "../../schemas")

type JsonSchema = {
  $schema?: string
  $id?: string
  type?: string
  const?: unknown
  minimum?: number
  maximum?: number
  additionalProperties?: unknown
  allOf?: unknown[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  properties?: Record<string, JsonSchema>
  required?: string[]
}

async function schema(name: string): Promise<JsonSchema> {
  return JSON.parse(await readFile(resolve(SCHEMAS, `${name}.schema.json`), "utf8"))
}

function objectSchemas(value: unknown): JsonSchema[] {
  if (Array.isArray(value)) return value.flatMap(objectSchemas)
  if (value === null || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  const nested = Object.values(record).flatMap(objectSchemas)
  return record.properties && typeof record.properties === "object"
    ? [record as JsonSchema, ...nested]
    : nested
}

describe("generated public schemas through S06", () => {
  const contracts: Record<string, string[]> = {
    "run-record": [
      "schemaVersion",
      "id",
      "workspaceId",
      "rootPrdId",
      "rootPrdFile",
      "definitionHash",
      "graphHash",
      "mode",
      "status",
      "effectiveOptionsHash",
      "effectiveOptions",
      "createdAt",
      "updatedAt",
    ],
    "task-record": ["runId", "taskId", "documentId", "status", "markerContentHash", "updatedAt"],
    "attempt-record": [
      "id",
      "runId",
      "documentId",
      "taskId",
      "ordinal",
      "phase",
      "status",
      "baseline",
      "contextManifestHash",
      "effectiveOptionsHash",
      "effectiveOptions",
      "counters",
      "startedAt",
      "updatedAt",
    ],
    "effective-run-options": [
      "schemaVersion",
      "mode",
      "executorProfile",
      "noChangePolicy",
      "contentHash",
    ],
    "context-assessment-feedback": [
      "schemaVersion",
      "sourceAssessmentRef",
      "sourceAssessmentId",
      "sourceEvidenceBundleId",
      "sourceKind",
      "score",
      "threshold",
      "summary",
      "adequate",
      "problems",
      "missingEvidence",
      "recommendations",
      "criterionScores",
    ],
    "context-manifest": [
      "schemaVersion",
      "id",
      "runId",
      "attemptId",
      "mode",
      "sharedContext",
      "task",
      "invariants",
      "baseline",
      "budget",
      "authority",
      "createdAt",
      "contentHash",
    ],
    "evidence-bundle": [
      "schemaVersion",
      "id",
      "runId",
      "documentId",
      "taskId",
      "attemptId",
      "taskSpecHash",
      "task",
      "limits",
      "baseline",
      "changes",
      "artifacts",
      "gates",
      "tests",
      "toolCalls",
      "context",
      "contextManifestHash",
      "profile",
      "usage",
      "priorAttempts",
      "priorAssessments",
      "security",
      "provenance",
      "truncations",
      "missingEvidence",
      "createdAt",
      "contentHash",
    ],
    "gate-result": ["gateId", "category", "blocking", "status", "durationMs", "outputRefs"],
    "completion-decision": [
      "status",
      "deterministicPassed",
      "evaluationMode",
      "evidenceBundleId",
      "reasons",
      "decidedBy",
      "decidedAt",
    ],
    "judge-output": [
      "schemaVersion",
      "score",
      "summary",
      "adequate",
      "problems",
      "missingEvidence",
      "recommendations",
      "criterionScores",
    ],
    "judge-assessment": [
      "schemaVersion",
      "id",
      "kind",
      "profileSnapshot",
      "evidenceBundleId",
      "score",
      "summary",
      "adequate",
      "problems",
      "missingEvidence",
      "recommendations",
      "criterionScores",
      "createdAt",
    ],
    "judge-rubric": ["schemaVersion", "weightPolicy", "criteria"],
    "evaluation-policy": [
      "schemaVersion",
      "mode",
      "threshold",
      "maxRevisionAttempts",
      "judgeCallRetries",
      "onJudgeUnavailable",
      "blockingSeverities",
      "exhaustedPolicy",
      "rubric",
    ],
    "execution-report": [
      "schemaVersion",
      "id",
      "runId",
      "rootPrdId",
      "rootPrdFile",
      "definitionHash",
      "graphHash",
      "mode",
      "status",
      "effectiveOptionsHash",
      "effectiveOptions",
      "tasks",
      "counters",
      "reasons",
      "createdAt",
      "contentHash",
    ],
    "credential-ref": ["id", "provider", "method", "store", "locator", "label"],
    "provider-info": [
      "schemaVersion",
      "id",
      "name",
      "status",
      "access",
      "credentialMethods",
      "catalogSource",
      "catalogUpdatedAt",
    ],
    "model-info": [
      "schemaVersion",
      "provider",
      "id",
      "name",
      "status",
      "capabilities",
      "limits",
      "variants",
      "price",
      "access",
      "catalogSource",
      "catalogUpdatedAt",
    ],
    "role-profile": [
      "id",
      "role",
      "backend",
      "provider",
      "model",
      "parameters",
      "requirements",
      "fallbackProfiles",
      "limits",
    ],
    "token-usage": ["source", "semantics"],
    "provider-event": [
      "schemaVersion",
      "eventId",
      "callId",
      "sequence",
      "timestamp",
      "type",
      "level",
      "synthesized",
      "payload",
    ],
    "provider-model-result": ["schemaVersion", "callId", "status", "finishReason", "usage"],
    "model-catalog-snapshot": [
      "schemaVersion",
      "id",
      "contentHash",
      "source",
      "providers",
      "models",
      "createdAt",
      "expiresAt",
    ],
  }

  test("publishes every normative contract as a closed draft-2020-12 schema", async () => {
    const files = await readdir(SCHEMAS)

    for (const [name, required] of Object.entries(contracts)) {
      expect(files).toContain(`${name}.schema.json`)
      const generated = await schema(name)
      if (name === "provider-event") {
        expect(generated).toMatchObject({
          $schema: "https://json-schema.org/draft/2020-12/schema",
          $id: "https://rodrigojager.github.io/ralph-v2/schemas/v2/provider-event.schema.json",
        })
        expect(generated.oneOf).toHaveLength(10)
        for (const variant of generated.oneOf ?? []) {
          expect(variant.additionalProperties).toBeFalse()
          expect(variant.required).toEqual(expect.arrayContaining(required))
          expect(Object.keys(variant.properties ?? {})).toEqual(expect.arrayContaining(required))
        }
        continue
      }
      expect(generated).toMatchObject({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: `https://rodrigojager.github.io/ralph-v2/schemas/v2/${name}.schema.json`,
        additionalProperties: false,
      })
      expect(generated.required).toEqual(expect.arrayContaining(required))
      expect(Object.keys(generated.properties ?? {})).toEqual(expect.arrayContaining(required))
    }
  })

  test("exposes S03 PRD identities, shared context, and verification metadata", async () => {
    const document = await schema("prd-document")
    expect(document.required).toEqual(
      expect.arrayContaining(["definitionHash", "sharedContext", "tasks"]),
    )

    const objects = objectSchemas(document)
    const tasks = objects.filter((candidate) => candidate.required?.includes("taskSpecHash"))
    expect(tasks.length).toBeGreaterThan(0)

    const verifications = objects.filter(
      (candidate) => candidate.required?.includes("type") && candidate.required.includes("id"),
    )
    expect(verifications).toHaveLength(7)
    for (const verification of verifications) {
      expect(verification.required).toEqual(
        expect.arrayContaining(["category", "skipPolicy", "blocking"]),
      )
    }

    const graph = await schema("compiled-prd-graph")
    expect(graph.required).toEqual(expect.arrayContaining(["definitionHash", "graphHash"]))
    expect(
      objectSchemas(graph).some((candidate) => candidate.required?.includes("taskSpecHash")),
    ).toBeTrue()
  })

  test("carries document identity in events and preserves public conditional invariants", async () => {
    const event = await schema("event-envelope")
    expect(event.properties).toHaveProperty("documentId")
    expect(event.allOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          if: expect.objectContaining({ properties: { scope: { const: "run" } } }),
          // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
          then: { required: ["runId"] },
        }),
      ]),
    )

    const context = await schema("context-manifest")
    expect(context.allOf).toEqual([
      {
        if: { properties: { mode: { const: "wiggum" } }, required: ["mode"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
        then: { required: ["fullPrd"] },
      },
      {
        if: { required: ["revisionFeedback"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword.
        then: { required: ["previousAssessmentRef"] },
      },
    ])
  })

  test("publishes S04 provider contracts without any inline secret field", async () => {
    const credential = await schema("credential-ref")
    const serialized = JSON.stringify(credential)
    expect(Object.keys(credential.properties ?? {})).not.toContain("secret")
    expect(Object.keys(credential.properties ?? {})).not.toContain("token")
    expect(serialized).not.toContain("apiKey")
    expect(serialized).not.toContain("accessToken")
    expect(serialized).not.toContain("refreshToken")

    const role = await schema("role-profile")
    expect(role.properties).toHaveProperty("credential")
    expect(role.required).not.toContain("credential")

    const usage = await schema("token-usage")
    expect(usage.properties).toHaveProperty("source")
    expect(usage.properties).toHaveProperty("semantics")
  })

  test("keeps provider counter bounds identical in runtime-derived JSON Schemas", async () => {
    const usage = await schema("token-usage")
    for (const field of [
      "input",
      "inputNonCached",
      "cacheRead",
      "cacheWrite",
      "output",
      "reasoning",
      "total",
    ]) {
      expect(usage.properties?.[field]).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      })
    }

    const modelLimits = objectSchemas(await schema("model-info")).find(
      (candidate) =>
        candidate.properties?.context !== undefined && candidate.properties.output !== undefined,
    )
    expect(modelLimits?.properties?.context).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    })
    expect(modelLimits?.properties?.output).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    })

    const roleObjects = objectSchemas(await schema("role-profile"))
    const requirements = roleObjects.find(
      (candidate) =>
        candidate.properties?.minimumContext !== undefined &&
        candidate.properties.minimumOutput !== undefined,
    )
    for (const field of ["minimumContext", "minimumOutput"]) {
      expect(requirements?.properties?.[field]).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      })
    }
    const profileLimits = roleObjects.find(
      (candidate) =>
        candidate.properties?.maxInputTokens !== undefined &&
        candidate.properties.maxTotalTokens !== undefined,
    )
    for (const field of [
      "maxInputTokens",
      "maxOutputTokens",
      "maxReasoningTokens",
      "maxTotalTokens",
    ]) {
      expect(profileLimits?.properties?.[field]).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      })
    }
  })

  test("publishes revision feedback without provider profile or credential material", async () => {
    const feedback = await schema("context-assessment-feedback")
    expect(feedback.properties).toHaveProperty("sourceAssessmentRef")
    expect(feedback.properties).toHaveProperty("sourceEvidenceBundleId")
    const serialized = JSON.stringify(feedback)
    expect(serialized).not.toContain("profileSnapshot")
    expect(serialized).not.toContain("rawResponseRef")
    expect(serialized).not.toContain("credential")

    const context = await schema("context-manifest")
    expect(context.properties).toHaveProperty("revisionFeedback")
    expect(context.properties).toHaveProperty("previousAssessmentRef")
  })

  test("publishes ten closed provider-event payload variants with semantic discriminators", async () => {
    const providerEvent = await schema("provider-event")
    const variants = providerEvent.oneOf ?? []
    const byType = new Map(
      variants.map((variant) => [String(variant.properties?.type?.const), variant] as const),
    )
    expect([...byType.keys()].sort()).toEqual(
      [
        "model.text.delta",
        "model.text.completed",
        "model.reasoning.delta",
        "model.reasoning.completed",
        "model.tool.input.delta",
        "model.tool.call",
        "model.provider.warning",
        "model.provider.error",
        "model.usage.updated",
        "model.call.finished",
      ].sort(),
    )

    for (const variant of variants) {
      expect(variant.properties?.sequence).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      })
      const payload = variant.properties?.payload
      if (variant.properties?.type?.const === "model.call.finished") {
        const finishPayloads = payload?.oneOf ?? payload?.anyOf
        expect(finishPayloads).toHaveLength(2)
        for (const finishPayload of finishPayloads ?? []) {
          expect(finishPayload.additionalProperties).toBeFalse()
        }
      } else {
        expect(payload?.additionalProperties).toBeFalse()
      }
    }
    const errorPayload = byType.get("model.provider.error")?.properties?.payload
    expect(errorPayload?.required).toEqual(expect.arrayContaining(["kind", "message"]))
    expect(errorPayload?.properties).not.toEqual({})
  })
})
