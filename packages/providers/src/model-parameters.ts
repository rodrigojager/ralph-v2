import {
  type ModelInfo,
  ModelInfoSchema,
  type ModelParameters,
  ModelParametersSchema,
  type ModelParameterValue,
  type ModelVariant,
} from "./contracts"
import { ProviderCoreError } from "./errors"

export type ModelParameterSelection = {
  variant?: string
  parameters?: Readonly<Record<string, unknown>>
}

export type ResolvedModelParameters = {
  variant?: ModelVariant
  parameters: ModelParameters
}

function sameParameterValue(left: ModelParameterValue, right: ModelParameterValue): boolean {
  return left === right
}

/**
 * Resolves a provider/model-specific variant into the exact parameter map sent to a driver.
 * ModelVariant metadata is the allowlist: no parameter name or value is inferred globally.
 */
export function resolveModelParameters(
  modelInput: ModelInfo,
  selection: ModelParameterSelection = {},
): ResolvedModelParameters {
  const model = ModelInfoSchema.parse(modelInput)
  const explicitResult = ModelParametersSchema.safeParse(selection.parameters ?? {})
  if (!explicitResult.success) {
    throw new ProviderCoreError(
      "PROVIDER_MODEL_PARAMETER_VALUE_INVALID",
      `Model parameters contain an unsupported type for ${model.provider}/${model.id}`,
      {
        provider: model.provider,
        model: model.id,
        issues: explicitResult.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    )
  }
  const explicit = explicitResult.data
  const variant = selection.variant
    ? model.variants.find((candidate) => candidate.id === selection.variant)
    : undefined
  if (selection.variant && !variant) {
    throw new ProviderCoreError(
      "PROVIDER_MODEL_VARIANT_NOT_FOUND",
      `Model variant is not declared for ${model.provider}/${model.id}: ${selection.variant}`,
      { provider: model.provider, model: model.id, variant: selection.variant },
    )
  }

  const declared = new Map<string, ModelParameterValue[]>()
  for (const candidate of model.variants) {
    for (const [name, value] of Object.entries(candidate.parameters)) {
      const values = declared.get(name) ?? []
      if (!values.some((known) => sameParameterValue(known, value))) values.push(value)
      declared.set(name, values)
    }
  }

  for (const [name, value] of Object.entries(explicit)) {
    const allowed = declared.get(name)
    if (!allowed) {
      throw new ProviderCoreError(
        "PROVIDER_MODEL_PARAMETER_UNKNOWN",
        `Model parameter is not declared for ${model.provider}/${model.id}: ${name}`,
        { provider: model.provider, model: model.id, parameter: name },
      )
    }
    if (!allowed.some((candidate) => sameParameterValue(candidate, value))) {
      throw new ProviderCoreError(
        "PROVIDER_MODEL_PARAMETER_VALUE_UNDECLARED",
        `Model parameter value is not declared for ${model.provider}/${model.id}: ${name}`,
        {
          provider: model.provider,
          model: model.id,
          parameter: name,
          value,
          allowedValues: allowed,
        },
      )
    }
    const presetValue = variant?.parameters[name]
    if (variant && presetValue !== undefined && !sameParameterValue(presetValue, value)) {
      throw new ProviderCoreError(
        "PROVIDER_MODEL_PARAMETER_CONFLICT",
        `Explicit model parameter conflicts with variant ${variant.id}: ${name}`,
        {
          provider: model.provider,
          model: model.id,
          variant: variant.id,
          parameter: name,
          variantValue: presetValue,
          explicitValue: value,
        },
      )
    }
  }

  return {
    ...(variant ? { variant: structuredClone(variant) } : {}),
    parameters: ModelParametersSchema.parse({ ...(variant?.parameters ?? {}), ...explicit }),
  }
}
