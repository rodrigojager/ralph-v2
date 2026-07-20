import { describe, expect, test } from "bun:test"
import {
  buildSnapshotView,
  displayWidth,
  dropLastGrapheme,
  resolveRalphTuiLocale,
  resolveRalphTuiTheme,
  takeGraphemes,
  truncateDisplayWidth,
} from "../src"
import { populatedSnapshot } from "./fixture"

describe("TUI locale, theme and terminal text support", () => {
  test("keeps stable semantic snapshots in English and Brazilian Portuguese", () => {
    const snapshot = populatedSnapshot()
    const english = buildSnapshotView(snapshot, 12, "ascii", "en")
    const portuguese = buildSnapshotView(snapshot, 12, "ascii", "pt-BR")

    expect({
      progress: english.progressLabel,
      task: english.currentTaskLabel,
      judge: english.judgeLabel,
      connection: english.connectionLabel,
      runtime: english.runtimeLabel,
      watchdog: english.watchdogLabel,
      error: english.errorLabel,
    }).toEqual({
      progress: "6/12 · 50%",
      task: "S06.10 · Evaluation dashboard · executing · attempt 2",
      judge: "external · judge-main · 74/85 · revisions 1/3",
      connection: "polling",
      runtime: "runtime unavailable",
      watchdog: "disabled or unavailable",
      error: "0 · none",
    })
    expect({
      progress: portuguese.progressLabel,
      task: portuguese.currentTaskLabel,
      judge: portuguese.judgeLabel,
      connection: portuguese.connectionLabel,
      runtime: portuguese.runtimeLabel,
      watchdog: portuguese.watchdogLabel,
      error: portuguese.errorLabel,
    }).toEqual({
      progress: "6/12 · 50%",
      task: "S06.10 · Evaluation dashboard · executing · tentativa 2",
      judge: "external · judge-main · 74/85 · revisões 1/3",
      connection: "consultando",
      runtime: "runtime indisponível",
      watchdog: "desativado ou indisponível",
      error: "0 · nenhum",
    })
    expect(resolveRalphTuiLocale("pt_BR.UTF-8")).toBe("pt-BR")
    expect(resolveRalphTuiLocale("en-US")).toBe("en")
  })

  test("resolves every theme and honors system and NO_COLOR-style selection", () => {
    expect(resolveRalphTuiTheme("dark", false, {}).name).toBe("dark")
    expect(resolveRalphTuiTheme("light", false, {}).name).toBe("light")
    expect(resolveRalphTuiTheme("high-contrast", false, {}).name).toBe("high-contrast")
    const monochrome = resolveRalphTuiTheme("dark", true, {})
    expect(monochrome.name).toBe("monochrome")
    expect(
      new Set([monochrome.orange, monochrome.green, monochrome.yellow, monochrome.red]),
    ).toEqual(new Set(["#f0f0f0"]))
    expect(resolveRalphTuiTheme("system", false, { COLORFGBG: "0;15" }).name).toBe("light")
    expect(resolveRalphTuiTheme("system", false, { COLORFGBG: "15;0" }).name).toBe("dark")
  })

  test("never splits combining, wide, flag or ZWJ graphemes at terminal boundaries", () => {
    const text = "A👩🏽‍💻e\u0301界🇧🇷"
    expect(displayWidth(text)).toBe(8)
    expect(takeGraphemes(text, 3)).toBe("A👩🏽‍💻e\u0301")
    expect(dropLastGrapheme(text)).toBe("A👩🏽‍💻e\u0301界")
    const truncated = truncateDisplayWidth(text, 5)
    expect(truncated).toBe("A👩🏽‍💻e\u0301…")
    expect(displayWidth(truncated)).toBe(5)
  })
})
