import { z } from "zod"

const NonEmptyStringSchema = z.string().min(1)
const CounterSchema = z.number().int().nonnegative()

/**
 * Lossless-enough usage projection for aggregating independently persisted
 * child runs. Missing metrics remain missing instead of being coerced to zero;
 * `available: false` means no complete aggregate may be claimed.
 */
export const ChildUsageSummarySchema = z
  .object({
    available: z.boolean(),
    source: NonEmptyStringSchema,
    inputTokens: CounterSchema.optional(),
    outputTokens: CounterSchema.optional(),
    reasoningTokens: CounterSchema.optional(),
    totalTokens: CounterSchema.optional(),
    cost: z
      .object({
        amount: z.number().finite().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        source: NonEmptyStringSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (!usage.available) {
      for (const field of [
        "inputTokens",
        "outputTokens",
        "reasoningTokens",
        "totalTokens",
        "cost",
      ] as const) {
        if (usage[field] !== undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: "Unavailable usage cannot claim token or cost values",
          })
        }
      }
    }
  })
export type ChildUsageSummary = z.infer<typeof ChildUsageSummarySchema>

/**
 * Combines complete usage summaries without fabricating missing metrics or
 * converting incompatible currencies. One unavailable member makes the total
 * unavailable while the caller may still expose each member separately.
 */
export function aggregateChildUsageSummaries(
  values: readonly ChildUsageSummary[],
  source: string,
): ChildUsageSummary {
  if (values.length === 0 || values.some((value) => !value.available)) {
    return ChildUsageSummarySchema.parse({ available: false, source: `${source}:unavailable` })
  }
  const sumIfComplete = (
    field: "inputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens",
  ): number | undefined =>
    values.every((value) => value[field] !== undefined)
      ? values.reduce((sum, value) => sum + (value[field] ?? 0), 0)
      : undefined
  const costs = values.map((value) => value.cost)
  const currency = costs[0]?.currency
  const cost =
    currency && costs.every((value) => value !== undefined && value.currency === currency)
      ? {
          amount: costs.reduce((sum, value) => sum + (value?.amount ?? 0), 0),
          currency,
          source: `${source}:sum`,
        }
      : undefined
  const inputTokens = sumIfComplete("inputTokens")
  const outputTokens = sumIfComplete("outputTokens")
  const reasoningTokens = sumIfComplete("reasoningTokens")
  const totalTokens = sumIfComplete("totalTokens")
  return ChildUsageSummarySchema.parse({
    available: true,
    source,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cost ? { cost } : {}),
  })
}
