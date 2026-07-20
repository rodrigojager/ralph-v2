type Segment = { readonly segment: string }
type SegmenterLike = { segment(input: string): Iterable<Segment> }
type SegmenterConstructor = new (
  locale?: string | readonly string[],
  options?: { readonly granularity: "grapheme" },
) => SegmenterLike

const segmenterConstructor = Reflect.get(Intl, "Segmenter") as SegmenterConstructor | undefined
const graphemeSegmenter = segmenterConstructor
  ? new segmenterConstructor(undefined, { granularity: "grapheme" })
  : undefined

const markPattern = /^\p{Mark}+$/u
const pictographicPattern = /\p{Extended_Pictographic}/u
const emojiPresentationPattern = /\p{Emoji_Presentation}/u
const regionalIndicatorPattern = /\p{Regional_Indicator}/u

function fallbackGraphemes(value: string): string[] {
  const output: string[] = []
  let current = ""
  for (const codePointValue of Array.from(value)) {
    const codePoint = codePointValue.codePointAt(0) ?? 0
    const previous = Array.from(current).at(-1)?.codePointAt(0)
    const modifier = codePoint >= 0x1f3fb && codePoint <= 0x1f3ff
    const variation =
      codePoint === 0xfe0e || codePoint === 0xfe0f || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    const regional = codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff
    const currentValues = Array.from(current)
    const currentIsSingleRegional =
      currentValues.length === 1 &&
      (currentValues[0]?.codePointAt(0) ?? 0) >= 0x1f1e6 &&
      (currentValues[0]?.codePointAt(0) ?? 0) <= 0x1f1ff
    if (current.length === 0) {
      current = codePointValue
    } else if (
      markPattern.test(codePointValue) ||
      modifier ||
      variation ||
      codePoint === 0x200d ||
      previous === 0x200d ||
      (regional && currentIsSingleRegional)
    ) {
      current += codePointValue
      if (regional && currentIsSingleRegional) {
        output.push(current)
        current = ""
      }
    } else {
      output.push(current)
      current = codePointValue
    }
  }
  if (current.length > 0) output.push(current)
  return output
}

function graphemes(value: string): string[] {
  if (!graphemeSegmenter) return fallbackGraphemes(value)
  return [...graphemeSegmenter.segment(value)].map((entry) => entry.segment)
}

function isControl(codePoint: number): boolean {
  return codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)
}

// Deliberately mirrors the stable full-width ranges used by common wcwidth
// implementations. Grapheme segmentation happens first, so ZWJ/combining
// sequences consume one terminal cell group rather than being split.
function isFullWidth(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
      (codePoint >= 0x3040 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  )
}

export function graphemeDisplayWidth(grapheme: string): number {
  if (grapheme.length === 0) return 0
  const codePoints = Array.from(grapheme)
  if (codePoints.every((value) => markPattern.test(value))) return 0
  const first = codePoints[0]?.codePointAt(0)
  if (first === undefined || isControl(first)) return 0
  if (
    pictographicPattern.test(grapheme) ||
    emojiPresentationPattern.test(grapheme) ||
    codePoints.some((value) => regionalIndicatorPattern.test(value)) ||
    codePoints.some((value) => {
      const codePoint = value.codePointAt(0)
      return codePoint !== undefined && isFullWidth(codePoint)
    })
  ) {
    return 2
  }
  return 1
}

export function displayWidth(value: string): number {
  return graphemes(value).reduce((total, grapheme) => total + graphemeDisplayWidth(grapheme), 0)
}

export function dropLastGrapheme(value: string): string {
  const values = graphemes(value)
  values.pop()
  return values.join("")
}

export function takeGraphemes(value: string, maximum: number): string {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) return ""
  return graphemes(value).slice(0, maximum).join("")
}

export function truncateDisplayWidth(value: string, maximumWidth: number, suffix = "…"): string {
  if (!Number.isSafeInteger(maximumWidth) || maximumWidth <= 0) return ""
  if (displayWidth(value) <= maximumWidth) return value
  const visibleSuffix = displayWidth(suffix) <= maximumWidth ? suffix : ""
  const contentBudget = maximumWidth - displayWidth(visibleSuffix)
  let consumed = 0
  const selected: string[] = []
  for (const grapheme of graphemes(value)) {
    const width = graphemeDisplayWidth(grapheme)
    if (consumed + width > contentBudget) break
    selected.push(grapheme)
    consumed += width
  }
  return `${selected.join("")}${visibleSuffix}`
}
