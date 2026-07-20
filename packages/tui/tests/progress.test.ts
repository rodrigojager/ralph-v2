import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { progressBar } from "../src"

describe("responsive progress bar", () => {
  test("maps one half to six of twelve cells", () => {
    expect(progressBar({ completed: 1, total: 2, width: 12, style: "ascii" })).toEqual({
      bar: "######------",
      filled: 6,
      ratio: 0.5,
      percentage: 50,
      width: 12,
    })
  })

  test("maps one half to fifty of one hundred cells", () => {
    const result = progressBar({ completed: 1, total: 2, width: 100 })
    expect(result.filled).toBe(50)
    expect(result.bar).toHaveLength(100)
    expect(result.percentage).toBe(50)
  })

  test("uses floor and fills every cell only at one hundred percent", () => {
    expect(progressBar({ completed: 1, total: 3, width: 10 }).filled).toBe(3)
    expect(progressBar({ completed: 2, total: 2, width: 12 }).filled).toBe(12)
    expect(progressBar({ completed: 99, total: 12, width: 12 }).percentage).toBe(100)
  })

  test("represents zero total honestly and enforces a one-cell minimum", () => {
    expect(progressBar({ completed: 0, total: 0, width: 0, style: "ascii" })).toEqual({
      bar: "-",
      filled: 0,
      ratio: 0,
      percentage: 0,
      width: 1,
    })
  })

  test("preserves the completed/total invariant across bounded extreme inputs", () => {
    const failures: string[] = []
    const widths = [-10, 0, 1, 2, 3, 7, 31, 80, 257, 1_024]
    for (const width of widths) {
      let previousFilled = 0
      for (let completed = 0; completed <= 130; completed += 1) {
        const total = 128
        const result = progressBar({ completed, total, width, style: "ascii" })
        const normalizedWidth = Math.max(1, Math.floor(Math.max(0, width)))
        const ratio = Math.min(1, completed / total)
        const expectedFilled = Math.floor(ratio * normalizedWidth)
        if (
          result.width !== normalizedWidth ||
          result.bar.length !== normalizedWidth ||
          result.filled !== expectedFilled ||
          result.filled < previousFilled ||
          result.percentage !== Math.floor(ratio * 100)
        ) {
          failures.push(
            `width=${width}, completed=${completed}: ${JSON.stringify(result)} expectedFilled=${expectedFilled}`,
          )
        }
        previousFilled = result.filled
      }
    }
    expect(failures).toEqual([])
  })

  test("renders equivalent ratios identically at every useful panel width", () => {
    const failures: string[] = []
    for (let width = 1; width <= 512; width += 1) {
      const oneOfTwo = progressBar({ completed: 1, total: 2, width, style: "ascii" })
      const sixOfTwelve = progressBar({ completed: 6, total: 12, width, style: "ascii" })
      const fiftyOfOneHundred = progressBar({
        completed: 50,
        total: 100,
        width,
        style: "ascii",
      })
      if (
        oneOfTwo.bar !== sixOfTwelve.bar ||
        oneOfTwo.bar !== fiftyOfOneHundred.bar ||
        oneOfTwo.filled !== Math.floor(width / 2)
      ) {
        failures.push(`width=${width}`)
      }
    }
    expect(failures).toEqual([])
  })

  test("matches the versioned ASCII and Unicode progress golden", async () => {
    const cases = [
      { completed: 0, total: 0, width: 1 },
      { completed: 1, total: 2, width: 12 },
      { completed: 6, total: 12, width: 12 },
      { completed: 50, total: 100, width: 12 },
      { completed: 1, total: 3, width: 10 },
      { completed: 2, total: 2, width: 7 },
    ] as const
    const rendered = `${cases
      .map(({ completed, total, width }) => {
        const ascii = progressBar({ completed, total, width, style: "ascii" })
        const unicode = progressBar({ completed, total, width, style: "unicode" })
        return `${completed}/${total} width=${width} percentage=${ascii.percentage} filled=${ascii.filled} ascii=${ascii.bar} unicode=${unicode.bar}`
      })
      .join("\n")}\n`
    const golden = await readFile(resolve(import.meta.dir, "goldens", "progress.txt"), "utf8")
    expect(rendered).toBe(golden)
  })
})
