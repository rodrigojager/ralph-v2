export type ProgressBarStyle = "ascii" | "unicode"

export interface ProgressBarOptions {
  readonly completed: number
  readonly total: number
  readonly width: number
  readonly style?: ProgressBarStyle
}

export interface ProgressBarResult {
  readonly bar: string
  readonly filled: number
  readonly ratio: number
  readonly percentage: number
  readonly width: number
}

function finiteNonNegative(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, value)
}

/**
 * Builds a deterministic fixed-cell bar. Fractions always use floor so the
 * display never claims work that has not been completed.
 */
export function progressBar(options: ProgressBarOptions): ProgressBarResult {
  const total = finiteNonNegative(options.total)
  const completed = finiteNonNegative(options.completed)
  const width = Math.max(1, Math.floor(finiteNonNegative(options.width)))
  const ratio = total === 0 ? 0 : Math.min(1, completed / total)
  const filled = Math.floor(ratio * width)
  const full = options.style === "ascii" ? "#" : "█"
  const empty = options.style === "ascii" ? "-" : "░"

  return {
    bar: `${full.repeat(filled)}${empty.repeat(width - filled)}`,
    filled,
    ratio,
    percentage: Math.floor(ratio * 100),
    width,
  }
}
