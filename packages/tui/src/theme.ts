export type RalphTuiThemeName = "dark" | "light" | "high-contrast" | "monochrome"

export interface RalphTuiTheme {
  readonly name: RalphTuiThemeName
  readonly background: string
  readonly surface: string
  readonly elevated: string
  readonly border: string
  readonly text: string
  readonly muted: string
  readonly orange: string
  readonly green: string
  readonly yellow: string
  readonly red: string
}

/** Ralph-owned palettes: dense neutral surfaces with warm, non-blue accents. */
export const RALPH_TUI_THEMES: Readonly<Record<RalphTuiThemeName, RalphTuiTheme>> = {
  dark: {
    name: "dark",
    background: "#0b0f0c",
    surface: "#141a16",
    elevated: "#1b231d",
    border: "#344038",
    text: "#e6ebe7",
    muted: "#8f9b92",
    orange: "#ff914d",
    green: "#70d68b",
    yellow: "#edc75e",
    red: "#ff6b6b",
  },
  light: {
    name: "light",
    background: "#f4f1e9",
    surface: "#fffdf7",
    elevated: "#ebe6d9",
    border: "#8a8273",
    text: "#1c211d",
    muted: "#625f57",
    orange: "#a94b10",
    green: "#276a3a",
    yellow: "#795d00",
    red: "#a22929",
  },
  "high-contrast": {
    name: "high-contrast",
    background: "#000000",
    surface: "#090909",
    elevated: "#111111",
    border: "#ffffff",
    text: "#ffffff",
    muted: "#d0d0d0",
    orange: "#ff9d00",
    green: "#62ff7a",
    yellow: "#fff000",
    red: "#ff4d4d",
  },
  monochrome: {
    name: "monochrome",
    background: "#000000",
    surface: "#000000",
    elevated: "#111111",
    border: "#b8b8b8",
    text: "#f0f0f0",
    muted: "#a0a0a0",
    orange: "#f0f0f0",
    green: "#f0f0f0",
    yellow: "#f0f0f0",
    red: "#f0f0f0",
  },
}

function systemThemeName(
  environment: Readonly<Record<string, string | undefined>>,
): RalphTuiThemeName {
  const explicit = environment.RALPH_TUI_SYSTEM_THEME?.trim().toLocaleLowerCase("und")
  if (explicit && Object.hasOwn(RALPH_TUI_THEMES, explicit)) {
    return explicit as RalphTuiThemeName
  }

  // COLORFGBG conventionally ends with the terminal background palette index.
  // ANSI 0-6 are dark backgrounds; 7-15 are light. Unknown terminals fail to
  // the Ralph dark palette rather than guessing from platform branding.
  const backgroundIndex = environment.COLORFGBG?.split(";")
    .map((part) => Number.parseInt(part, 10))
    .findLast((value) => Number.isInteger(value) && value >= 0 && value <= 15)
  if (backgroundIndex !== undefined) return backgroundIndex >= 7 ? "light" : "dark"
  return "dark"
}

export function resolveRalphTuiTheme(
  requested?: string,
  noColor = false,
  environment: Readonly<Record<string, string | undefined>> = typeof process === "undefined"
    ? {}
    : process.env,
): RalphTuiTheme {
  if (noColor) return RALPH_TUI_THEMES.monochrome
  const normalized = requested?.trim().toLocaleLowerCase("und")
  if (normalized === "system") return RALPH_TUI_THEMES[systemThemeName(environment)]
  return normalized && Object.hasOwn(RALPH_TUI_THEMES, normalized)
    ? RALPH_TUI_THEMES[normalized as RalphTuiThemeName]
    : RALPH_TUI_THEMES.dark
}

const environment = typeof process === "undefined" ? undefined : process.env
export const RALPH_TUI_THEME = resolveRalphTuiTheme(
  environment?.RALPH_TUI_THEME,
  environment?.NO_COLOR !== undefined,
  environment,
)
