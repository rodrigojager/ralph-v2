export type RalphTuiLocale = "en" | "pt-BR"

export function resolveRalphTuiLocale(value: string | undefined): RalphTuiLocale {
  return value?.trim().toLowerCase().startsWith("pt") ? "pt-BR" : "en"
}

export function tuiText(locale: RalphTuiLocale, english: string, portuguese: string): string {
  return locale === "pt-BR" ? portuguese : english
}
