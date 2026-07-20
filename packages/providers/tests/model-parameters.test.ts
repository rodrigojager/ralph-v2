import { describe, expect, test } from "bun:test"

import { CURATED_CATALOG_SEED } from "../src/curated"
import { ProviderCoreError } from "../src/errors"
import { resolveModelParameters } from "../src/model-parameters"

function openAiModel() {
  const model = CURATED_CATALOG_SEED.models.find(
    (candidate) => candidate.provider === "openai" && candidate.id === "gpt-5.4",
  )
  if (!model) throw new Error("OpenAI fixture model is missing")
  return model
}

function providerError(action: () => unknown): ProviderCoreError {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderCoreError)
    return error as ProviderCoreError
  }
  throw new Error("Expected provider parameter resolution to fail")
}

describe("provider/model-aware parameter resolution", () => {
  test("expands a selected variant and accepts an identical explicit value", () => {
    expect(resolveModelParameters(openAiModel(), { variant: "high" })).toEqual({
      variant: expect.objectContaining({ id: "high" }),
      parameters: { reasoning_effort: "high" },
    })
    expect(
      resolveModelParameters(openAiModel(), {
        variant: "high",
        parameters: { reasoning_effort: "high" },
      }).parameters,
    ).toEqual({ reasoning_effort: "high" })
  })

  test("rejects unknown names, undeclared values, invalid types and variant conflicts", () => {
    expect(
      providerError(() => resolveModelParameters(openAiModel(), { parameters: { temperature: 0 } }))
        .code,
    ).toBe("PROVIDER_MODEL_PARAMETER_UNKNOWN")
    expect(
      providerError(() =>
        resolveModelParameters(openAiModel(), {
          parameters: { reasoning_effort: "extreme" },
        }),
      ).code,
    ).toBe("PROVIDER_MODEL_PARAMETER_VALUE_UNDECLARED")
    expect(
      providerError(() =>
        resolveModelParameters(openAiModel(), {
          parameters: { reasoning_effort: { level: "high" } },
        }),
      ).code,
    ).toBe("PROVIDER_MODEL_PARAMETER_VALUE_INVALID")
    expect(
      providerError(() =>
        resolveModelParameters(openAiModel(), {
          variant: "high",
          parameters: { reasoning_effort: "low" },
        }),
      ).code,
    ).toBe("PROVIDER_MODEL_PARAMETER_CONFLICT")
  })

  test("rejects parameters when a model declares no parameter metadata", () => {
    const model = CURATED_CATALOG_SEED.models.find(
      (candidate) => candidate.provider === "anthropic",
    )
    if (!model) throw new Error("Anthropic fixture model is missing")
    expect(
      providerError(() =>
        resolveModelParameters(model, { parameters: { reasoning_effort: "high" } }),
      ).code,
    ).toBe("PROVIDER_MODEL_PARAMETER_UNKNOWN")
  })
})
