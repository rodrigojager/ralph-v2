import {
  type BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  type KeyEvent,
  type TextRenderable,
} from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { type JSX, jsx, jsxs } from "@opentui/solid/jsx-runtime"
import type { EvaluationFieldMetadata, RunUiSnapshot } from "./contracts"
import { type RalphTuiLocale, tuiText } from "./i18n"
import { progressBar } from "./progress"
import type {
  ProviderPaletteController,
  ProviderPaletteTab,
  ProviderPaletteViewState,
} from "./provider-palette"
import { createProviderPaletteSecretInput } from "./provider-palette"
import {
  type SettingsPaletteController,
  type SettingsPaletteFieldState,
  type SettingsPaletteViewState,
  settingsPaletteCategories,
  visibleSettingsPaletteFields,
} from "./settings-palette"
import { displayWidth, dropLastGrapheme, takeGraphemes, truncateDisplayWidth } from "./text-width"
import { RALPH_TUI_THEME, type RalphTuiTheme } from "./theme"
import { buildSnapshotView, formatEntry } from "./view"

const FEEDBACK_TABS = ["adequate", "problems", "missing", "recommendations"] as const
type FeedbackTab = (typeof FEEDBACK_TABS)[number]
const ACTIVITY_FILTERS = ["all", "warn", "error"] as const
type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]
type EngineOutputMode = "normalized" | "raw-engine"
type RunDashboardAction =
  | "help"
  | "palette"
  | "providers"
  | "search"
  | "filter"
  | "output.toggle"
  | "output.pause"
  | "evaluation"
  | "stop"
  | "quit"

const DEFAULT_KEYBINDINGS: Readonly<Record<RunDashboardAction, string>> = {
  help: "?",
  palette: "ctrl+p",
  providers: "ctrl+m",
  search: "/",
  filter: "f",
  "output.toggle": "o",
  "output.pause": "p",
  evaluation: "e",
  stop: "s",
  quit: "q",
}

function containsC0OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function isEnterKey(key: KeyEvent): boolean {
  return (
    key.name === "enter" ||
    key.name === "return" ||
    key.name === "linefeed" ||
    key.name === "kpenter"
  )
}

export interface RunDashboardProps {
  readonly snapshot: RunUiSnapshot
  readonly evaluationFields?: readonly EvaluationFieldMetadata[]
  readonly initialEvaluationOpen?: boolean
  readonly ascii?: boolean
  readonly theme?: RalphTuiTheme
  /** Safe action-id to terminal key expression mapping from effective config. */
  readonly keybindings?: Readonly<Record<string, string>>
  readonly locale?: RalphTuiLocale
  readonly onQuit?: () => void
  /** Command-owned interrupt bridge; Ctrl+C never destroys only the renderer. */
  readonly onInterrupt?: () => void
  /** Command-owned operational action; the component never mutates run state. */
  readonly onStop?: () => Promise<string | void>
  /** Shared command-model adapter; attach/replay apply remains read-only. */
  readonly settings?: SettingsPaletteController<unknown, unknown>
  /** Searchable provider/model/auth popup with command-owned run/profile mutations. */
  readonly providers?: ProviderPaletteController
  /** Pre-run host callback; persisted attach/replay views leave this unset. */
  readonly onSettingsApply?: (result: unknown) => void
  readonly controllerRef?: (controller: RunDashboardController) => void
}

export interface RunDashboardController {
  updateSnapshot(snapshot: RunUiSnapshot): void
}

interface TextPanelProps {
  readonly theme: RalphTuiTheme
  readonly id: string
  readonly title: string
  readonly content: () => string
  readonly flexGrow?: number
  readonly width?: number | `${number}%`
  readonly height?: number
  readonly boxRef?: (box: BoxRenderable) => void
  readonly textRef?: (text: TextRenderable) => void
}

function TextPanel(props: TextPanelProps): JSX.Element {
  const theme = props.theme
  return jsxs("box", {
    id: props.id,
    ref: props.boxRef,
    title: props.title,
    titleColor: theme.orange,
    border: true,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    paddingX: 1,
    flexDirection: "column",
    flexGrow: props.flexGrow,
    get width() {
      return props.width
    },
    get height() {
      return props.height
    },
    overflow: "hidden",
    children: [
      jsx("text", {
        ref: props.textRef,
        fg: theme.text,
        wrapMode: "word",
        get children() {
          return props.content()
        },
      }),
    ],
  })
}

function statusColor(status: string, theme: RalphTuiTheme): string {
  const normalized = status.toLowerCase()
  if (/(failed|error|rejected|blocked)/.test(normalized)) return theme.red
  if (/(complete|passed|accepted|success)/.test(normalized)) return theme.green
  return theme.orange
}

function taskStatusGlyph(status: string): string {
  const normalized = status.toLowerCase()
  if (/(completed|accepted|passed)/.test(normalized)) return "✓"
  if (/(running|active|verifying|evaluating|selected)/.test(normalized)) return ">"
  if (/(blocked|failed|rejected|interrupted)/.test(normalized)) return "!"
  return "·"
}

type Translate = (english: string, portuguese: string) => string

function feedbackTabLabel(tab: FeedbackTab, text: Translate): string {
  switch (tab) {
    case "adequate":
      return text("adequate", "adequado")
    case "problems":
      return text("problems", "problemas")
    case "missing":
      return text("missing", "faltante")
    case "recommendations":
      return text("recommendations", "recomendações")
  }
}

function stringifyDisplayValue(value: unknown, text: Translate): string {
  if (value === undefined) return text("not set", "não definido")
  if (typeof value === "string") return value.length === 0 ? text("(empty)", "(vazio)") : value
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value)
  }
  try {
    return JSON.stringify(value) ?? text("[unserializable value]", "[valor não serializável]")
  } catch {
    return text("[unserializable value]", "[valor não serializável]")
  }
}

function fieldIsVisible(
  field: EvaluationFieldMetadata,
  values: Readonly<Record<string, unknown>>,
): boolean {
  if (!field.visibleWhen) return true
  const expected = field.visibleWhen.equals
  const actual = values[field.visibleWhen.fieldId]
  return Array.isArray(expected) ? expected.includes(actual as never) : actual === expected
}

function evaluationFieldLines(
  fields: readonly EvaluationFieldMetadata[],
  values: Readonly<Record<string, unknown>>,
  origins: Readonly<Record<string, string>>,
  text: Translate,
): string {
  if (fields.length === 0) {
    return text(
      "No evaluation field metadata was supplied.",
      "Nenhuma metadata de campo de avaliação foi fornecida.",
    )
  }
  return fields
    .filter((field) => fieldIsVisible(field, values))
    .map((field) => {
      const value = field.secret
        ? text("[secret hidden]", "[segredo oculto]")
        : stringifyDisplayValue(values[field.id] ?? field.defaultValue, text)
      const equivalents = [
        ...(field.configPath ? [`config=${field.configPath}`] : []),
        ...(field.cliFlag ? [`CLI=${field.cliFlag}`] : []),
      ]
      return [
        `${field.label}: ${value}`,
        `  ${text("origin", "origem")}=${origins[field.id] ?? text("unavailable", "indisponível")}`,
        `  ${equivalents.length > 0 ? equivalents.join(" · ") : text("config/CLI equivalent unavailable", "equivalente config/CLI indisponível")}`,
      ].join("\n")
    })
    .join("\n")
}

interface EvaluationPopupProps {
  readonly theme: RalphTuiTheme
  readonly snapshot: () => RunUiSnapshot
  readonly fields: readonly EvaluationFieldMetadata[]
  readonly tab: FeedbackTab
  readonly width: () => number
  readonly height: () => number
  readonly visible: boolean
  readonly popupRef: (popup: BoxRenderable) => void
  readonly fieldsRef: (text: TextRenderable) => void
  readonly tabsRef: (text: TextRenderable) => void
  readonly feedbackRef: (text: TextRenderable) => void
  readonly text: Translate
}

function EvaluationPopup(props: EvaluationPopupProps): JSX.Element {
  const theme = props.theme
  const fields = () =>
    evaluationFieldLines(
      props.fields,
      props.snapshot().evaluationValues,
      props.snapshot().evaluationOrigins,
      props.text,
    )
  const tabs = () =>
    FEEDBACK_TABS.map((tab) => {
      const label = feedbackTabLabel(tab, props.text)
      return tab === props.tab ? `[${label}]` : label
    }).join("  ")
  const feedback = () => props.snapshot().judge.feedback[props.tab]

  return jsxs("box", {
    id: "evaluation-popup",
    ref: props.popupRef,
    visible: props.visible,
    title: props.text("EVALUATION · READ ONLY", "AVALIAÇÃO · SOMENTE LEITURA"),
    titleColor: theme.orange,
    bottomTitle: props.text(
      "e/Esc close · Tab/←/→ feedback tab · ↑/↓ scroll",
      "e/Esc fechar · Tab/←/→ aba do parecer · ↑/↓ rolar",
    ),
    bottomTitleAlignment: "center",
    position: "absolute",
    top: 0,
    left: 0,
    get width() {
      return Math.max(1, props.width() - 2)
    },
    get height() {
      return Math.max(1, props.height() - 1)
    },
    zIndex: 100,
    border: true,
    borderStyle: "double",
    borderColor: theme.orange,
    backgroundColor: theme.elevated,
    padding: 1,
    flexDirection: "column",
    overflow: "hidden",
    children: [
      jsx("text", {
        fg: theme.muted,
        children: props.text(
          "Resolved values only. Configuration is not editable here.",
          "Somente valores resolvidos. A configuração não pode ser editada aqui.",
        ),
      }),
      jsx("text", {
        fg: theme.green,
        marginTop: 1,
        children: props.text("Evaluation fields", "Campos de avaliação"),
      }),
      jsx("text", {
        ref: props.fieldsRef,
        fg: theme.text,
        wrapMode: "word",
        get children() {
          return fields()
        },
      }),
      jsx("text", {
        ref: props.tabsRef,
        fg: theme.orange,
        marginTop: 1,
        get children() {
          return tabs()
        },
      }),
      jsx("text", {
        ref: props.feedbackRef,
        fg: theme.text,
        wrapMode: "word",
        flexGrow: 1,
        get children() {
          const items = feedback()
          return items.length === 0
            ? props.text("(none)", "(nenhum)")
            : items.map((item) => `• ${item}`).join("\n")
        },
      }),
    ],
  })
}

interface StopPopupProps {
  readonly theme: RalphTuiTheme
  readonly visible: boolean
  readonly pending: boolean
  readonly message: string
  readonly width: () => number
  readonly height: () => number
  readonly popupRef: (popup: BoxRenderable) => void
  readonly messageRef: (text: TextRenderable) => void
  readonly text: Translate
}

function StopPopup(props: StopPopupProps): JSX.Element {
  const theme = props.theme
  return jsxs("box", {
    id: "stop-popup",
    ref: props.popupRef,
    visible: props.visible,
    title: props.text("STOP RUN · CONFIRM", "PARAR RUN · CONFIRMAR"),
    titleColor: theme.yellow,
    bottomTitle: props.text("Enter confirm · Esc cancel", "Enter confirmar · Esc cancelar"),
    bottomTitleAlignment: "center",
    position: "absolute",
    top: 4,
    left: 1,
    get width() {
      return Math.max(1, Math.min(76, props.width() - 2))
    },
    get height() {
      return Math.max(1, Math.min(8, props.height() - 2))
    },
    zIndex: 110,
    border: true,
    borderStyle: "double",
    borderColor: theme.yellow,
    backgroundColor: theme.elevated,
    padding: 1,
    flexDirection: "column",
    children: [
      jsx("text", {
        fg: theme.text,
        children: props.text(
          "Request a graceful, durable stop. The current task/diff remains resumable and the TUI does not kill the engine directly.",
          "Solicita uma parada graciosa e durável. A task e o diff atuais continuam retomáveis, e a TUI não encerra a engine diretamente.",
        ),
      }),
      jsx("text", {
        ref: props.messageRef,
        fg: props.pending ? theme.yellow : theme.muted,
        marginTop: 1,
        get children() {
          return props.message
        },
      }),
    ],
  })
}

interface SearchPopupProps {
  readonly theme: RalphTuiTheme
  readonly visible: boolean
  readonly query: string
  readonly width: () => number
  readonly height: () => number
  readonly popupRef: (popup: BoxRenderable) => void
  readonly queryRef: (text: TextRenderable) => void
  readonly text: Translate
}

function SearchPopup(props: SearchPopupProps): JSX.Element {
  const theme = props.theme
  return jsxs("box", {
    id: "search-popup",
    ref: props.popupRef,
    visible: props.visible,
    title: props.text("SEARCH / FILTER", "BUSCA / FILTRO"),
    titleColor: theme.orange,
    bottomTitle: props.text(
      "type to filter · Enter keep · Esc clear",
      "digite para filtrar · Enter manter · Esc limpar",
    ),
    bottomTitleAlignment: "center",
    position: "absolute",
    top: 3,
    left: 1,
    get width() {
      return Math.max(1, Math.min(90, props.width() - 2))
    },
    get height() {
      return Math.max(1, Math.min(5, props.height() - 2))
    },
    zIndex: 120,
    border: true,
    borderStyle: "double",
    borderColor: theme.orange,
    backgroundColor: theme.elevated,
    paddingX: 1,
    flexDirection: "column",
    children: [
      jsx("text", {
        ref: props.queryRef,
        fg: theme.text,
        get children() {
          return `/${props.query}█`
        },
      }),
    ],
  })
}

interface HelpPopupProps {
  readonly theme: RalphTuiTheme
  readonly visible: boolean
  readonly width: () => number
  readonly height: () => number
  readonly popupRef: (popup: BoxRenderable) => void
  readonly content: string
  readonly text: Translate
}

function HelpPopup(props: HelpPopupProps): JSX.Element {
  const theme = props.theme
  return jsxs("box", {
    id: "help-popup",
    ref: props.popupRef,
    visible: props.visible,
    title: props.text("RALPH TUI · KEYS", "RALPH TUI · TECLAS"),
    titleColor: theme.orange,
    bottomTitle: props.text("? or Esc close", "? ou Esc fechar"),
    bottomTitleAlignment: "center",
    position: "absolute",
    top: 2,
    left: 1,
    get width() {
      return Math.max(1, Math.min(78, props.width() - 2))
    },
    get height() {
      return Math.max(1, Math.min(20, props.height() - 2))
    },
    zIndex: 115,
    border: true,
    borderStyle: "double",
    borderColor: theme.orange,
    backgroundColor: theme.elevated,
    padding: 1,
    flexDirection: "column",
    children: [
      jsx("text", {
        fg: theme.text,
        wrapMode: "word",
        children: props.content,
      }),
    ],
  })
}

interface SettingsPopupProps {
  readonly theme: RalphTuiTheme
  readonly visible: boolean
  readonly width: () => number
  readonly height: () => number
  readonly content: () => string
  readonly popupRef: (popup: BoxRenderable) => void
  readonly contentRef: (text: TextRenderable) => void
  readonly text: Translate
  readonly id?: string
  readonly title?: string
  readonly bottomTitle?: string
}

function SettingsPopup(props: SettingsPopupProps): JSX.Element {
  const theme = props.theme
  return jsxs("box", {
    id: props.id ?? "settings-popup",
    ref: props.popupRef,
    visible: props.visible,
    title:
      props.title ?? props.text("COMMAND PALETTE · CONFIGURE", "PALETA DE COMANDOS · CONFIGURAR"),
    titleColor: theme.orange,
    bottomTitle:
      props.bottomTitle ??
      props.text(
        "↑/↓ select · Enter edit · / search · c category · Tab scope · v preview · w/g save · a apply · Esc close",
        "↑/↓ selecionar · Enter editar · / buscar · c categoria · Tab escopo · v prévia · w/g salvar · a aplicar · Esc fechar",
      ),
    bottomTitleAlignment: "center",
    position: "absolute",
    top: 0,
    left: 0,
    get width() {
      return Math.max(1, props.width() - 2)
    },
    get height() {
      return Math.max(1, props.height() - 1)
    },
    zIndex: 130,
    border: true,
    borderStyle: "double",
    borderColor: theme.orange,
    backgroundColor: theme.elevated,
    padding: 1,
    flexDirection: "column",
    overflow: "hidden",
    children: [
      jsx("text", {
        ref: props.contentRef,
        fg: theme.text,
        wrapMode: "word",
        get children() {
          return props.content()
        },
      }),
    ],
  })
}

export function RunDashboard(props: RunDashboardProps): JSX.Element {
  const renderer = useRenderer()
  const theme = props.theme ?? RALPH_TUI_THEME
  const locale = props.locale ?? "en"
  const text: Translate = (english, portuguese) => tuiText(locale, english, portuguese)
  let currentSnapshot = props.snapshot
  const snapshot = () => currentSnapshot
  let evaluationOpen = props.initialEvaluationOpen ?? false
  let feedbackTabIndex = 0
  let feedbackScrollOffset = 0
  let outputPaused = false
  let pausedEngineOutput: readonly string[] = []
  let pausedRawEngineOutput: readonly string[] = []
  let engineOutputMode: EngineOutputMode = "normalized"
  let activityFilterIndex = 0
  let searchOpen = false
  let searchQuery = ""
  let helpOpen = false
  let stopConfirmOpen = false
  let stopPending = false
  let stopMessage = text("Awaiting confirmation", "Aguardando confirmação")
  let settingsState: SettingsPaletteViewState = props.settings?.state ?? {
    open: false,
    status: "closed",
    scope: "workspace",
    query: "",
  }
  let settingsInputMode: "none" | "edit" | "query" = "none"
  let settingsInputBuffer = ""
  let settingsPendingSave: "workspace" | "global" | undefined
  let providersState: ProviderPaletteViewState = props.providers?.state ?? {
    open: false,
    status: "closed",
    mode: "attach",
    role: "executor",
    scope: "workspace",
    tab: "providers",
    query: "",
    selectedAuthMethodIndex: 0,
  }
  let providersQueryInput = false
  let providersQueryBuffer = ""
  let providersAuthInput: "none" | "api-key" | "environment" = "none"
  let providersAuthInputBuffer = ""
  let providersProfileInput = false
  let providersProfileInputBuffer = ""
  let providersRevokeConfirm = false
  let providersApplyConfirm = false
  let providersPendingSave: "workspace" | "global" | undefined
  let evaluationPopup: BoxRenderable | undefined
  let evaluationFieldsText: TextRenderable | undefined
  let evaluationTabs: TextRenderable | undefined
  let evaluationFeedback: TextRenderable | undefined
  let stopPopup: BoxRenderable | undefined
  let stopMessageText: TextRenderable | undefined
  let searchPopup: BoxRenderable | undefined
  let searchQueryText: TextRenderable | undefined
  let helpPopup: BoxRenderable | undefined
  let settingsPopup: BoxRenderable | undefined
  let settingsContentText: TextRenderable | undefined
  let providersPopup: BoxRenderable | undefined
  let providersContentText: TextRenderable | undefined
  let headerTitle: TextRenderable | undefined
  let headerStatus: TextRenderable | undefined
  let currentTaskText: TextRenderable | undefined
  let progressLabelText: TextRenderable | undefined
  let progressBarText: TextRenderable | undefined
  let usagePanel: BoxRenderable | undefined
  let usageText: TextRenderable | undefined
  let detailGrid: BoxRenderable | undefined
  let activityPanel: BoxRenderable | undefined
  let activityText: TextRenderable | undefined
  let enginePanel: BoxRenderable | undefined
  let engineText: TextRenderable | undefined
  let keyHelpText: TextRenderable | undefined
  const feedbackTab = () => FEEDBACK_TABS[feedbackTabIndex] ?? "adequate"
  const activityFilter = (): ActivityFilter => ACTIVITY_FILTERS[activityFilterIndex] ?? "all"
  const wide = () => renderer.width >= 90
  const progressWidth = () => Math.max(1, renderer.width - 6)
  const view = () =>
    buildSnapshotView(snapshot(), progressWidth(), props.ascii ? "ascii" : "unicode", locale)
  const headerStatusLine = () =>
    `${snapshot().status} · ${snapshot().runtime?.phase ?? text("phase?", "fase?")} · ${view().connectionLabel} · ${snapshot().runId}`
  const currentTaskLine = () => {
    if (wide()) return view().currentTaskLabel
    const task = snapshot().currentTask
    return task
      ? `${task.id} · ${task.status}`
      : text("No task is currently executing", "Nenhuma task está em execução")
  }
  const watchdogSignalsLine = () => {
    const watchdog = snapshot().watchdog
    if (!watchdog?.enabled || watchdog.signals.length === 0) {
      return text("(none reported)", "(nenhum reportado)")
    }
    return watchdog.signals.map((signal) => `${signal.name}=${signal.verdict}`).join(" · ")
  }
  const matchesSearch = (value: string): boolean =>
    searchQuery.length === 0 ||
    value.toLocaleLowerCase("und").includes(searchQuery.toLocaleLowerCase("und"))
  const matchesActivityFilter = (entry: { readonly level?: string }): boolean => {
    const filter = activityFilter()
    if (filter === "all") return true
    if (filter === "error") return entry.level === "error"
    return entry.level === "warn" || entry.level === "error"
  }
  const binding = (action: RunDashboardAction): string => {
    const configured = props.keybindings?.[action]?.trim()
    return configured && configured.length <= 64 ? configured : DEFAULT_KEYBINDINGS[action]
  }
  const keyHelpLine = () =>
    locale === "pt-BR"
      ? `${binding("help")} ajuda · ${binding("palette")} configurações${props.providers ? ` · ${binding("providers")} providers/modelos/auth/profiles` : ""} · ${binding("search")} buscar${searchQuery ? `=${JSON.stringify(searchQuery)}` : ""} · ${binding("filter")} filtro=${activityFilter()} · ${binding("output.toggle")} ${engineOutputMode} · ${binding("output.pause")} ${outputPaused ? "retomar" : "pausar"}${props.onStop ? ` · ${binding("stop")} parar` : ""} · ${binding("quit")} fechar/background`
      : `${binding("help")} help · ${binding("palette")} settings${props.providers ? ` · ${binding("providers")} providers/models/auth/profiles` : ""} · ${binding("search")} search${searchQuery ? `=${JSON.stringify(searchQuery)}` : ""} · ${binding("filter")} filter=${activityFilter()} · ${binding("output.toggle")} ${engineOutputMode} · ${binding("output.pause")} ${outputPaused ? "resume" : "pause"}${props.onStop ? ` · ${binding("stop")} stop` : ""} · ${binding("quit")} close/background`

  const settingsFields = (): readonly SettingsPaletteFieldState[] =>
    visibleSettingsPaletteFields(settingsState)
  const selectedSettingsField = (): SettingsPaletteFieldState | undefined => {
    const fields = settingsFields()
    return fields.find((entry) => entry.field.id === settingsState.selectedFieldId) ?? fields[0]
  }
  const settingsLineLimit = (): number => Math.max(2, renderer.height - 22)
  const settingsContent = (): string => {
    const fields = settingsFields()
    const selected = selectedSettingsField()
    const selectedIndex = selected
      ? Math.max(
          0,
          fields.findIndex((entry) => entry.field.id === selected.field.id),
        )
      : 0
    const lineLimit = settingsLineLimit()
    const windowStart = Math.max(
      0,
      Math.min(Math.max(0, fields.length - lineLimit), selectedIndex - Math.floor(lineLimit / 2)),
    )
    const fieldLines = fields.slice(windowStart, windowStart + lineLimit).map((entry) => {
      const marker = entry.field.id === selected?.field.id ? ">" : " "
      const changed = entry.changed ? "*" : " "
      const editable = entry.field.editable ? "" : text(" · read-only", " · somente leitura")
      const displayValue =
        entry.displayValue === "not set" ? text("not set", "não definido") : entry.displayValue
      return `${marker}${changed} ${entry.field.label} = ${displayValue} · ${entry.source}${editable}`
    })
    const category = settingsState.category ?? "all"
    const modePrompt = settingsPendingSave
      ? text(
          `CONFIRM: save ${settingsPendingSave} defaults for future runs? Enter confirms; Esc cancels.`,
          `CONFIRMAR: salvar defaults ${settingsPendingSave} para runs futuros? Enter confirma; Esc cancela.`,
        )
      : settingsInputMode === "edit"
        ? `${text("EDIT", "EDITAR")} ${selected?.field.label ?? text("field", "campo")}> ${settingsInputBuffer}█`
        : settingsInputMode === "query"
          ? `${text("SEARCH", "BUSCAR")}> ${settingsInputBuffer}█`
          : undefined
    const fieldDetails = selected
      ? [
          `${selected.field.id} · ${selected.field.category} · ${selected.field.kind} · target=${selected.field.target}`,
          `config=${selected.field.configPath ?? text("unavailable", "indisponível")} · CLI=${selected.field.cliFlag ?? text("unavailable", "indisponível")}`,
          `${text("source", "origem")}=${selected.source}${selected.sourceRef ? ` (${selected.sourceRef})` : ""}`,
          selected.field.help,
          `${text("Impact", "Impacto")}: ${selected.field.impact}`,
          ...(selected.field.choices?.length
            ? [`${text("Choices", "Opções")}: ${selected.field.choices.join(", ")}`]
            : []),
        ]
      : [
          text(
            "No setting matches the current category/search filter.",
            "Nenhuma configuração corresponde à categoria ou busca atual.",
          ),
        ]
    const preview = settingsState.preview
    const previewLines = preview
      ? [
          `run: ${preview.runCommand}`,
          `${text("save", "salvar")}: ${preview.configCommands.length > 0 ? preview.configCommands.join(" · ") : text("no config mutation", "sem alteração de config")}`,
          `${text("apply this run", "aplicar nesta run")}: ${preview.applyForRunAvailable ? text("available", "disponível") : (preview.applyForRunUnavailableReason ?? text("unavailable", "indisponível"))}`,
        ]
      : [
          text(
            "Press v to preview deterministic CLI/config effects before applying or saving.",
            "Pressione v para visualizar os efeitos determinísticos em CLI/config antes de aplicar ou salvar.",
          ),
        ]
    const notice = settingsState.error
      ? `${text("ERROR", "ERRO")}: ${settingsState.error}`
      : settingsState.notice
        ? `${text("NOTICE", "AVISO")}: ${settingsState.notice}`
        : ""
    return [
      `${text("mode", "modo")}=${settingsState.snapshot?.mode ?? text("loading", "carregando")} · status=${settingsState.status} · ${text("scope", "escopo")}=${settingsState.scope} · ${text("category", "categoria")}=${category} · ${fields.length}/${settingsState.snapshot?.fields.length ?? 0} ${text("visible", "visíveis")}`,
      settingsState.query
        ? `${text("query", "busca")}=${JSON.stringify(settingsState.query)}`
        : `${text("query", "busca")}=${text("(none)", "(nenhuma)")}`,
      modePrompt ?? "",
      "",
      fieldLines.length > 0
        ? fieldLines.join("\n")
        : text("(no visible settings)", "(nenhuma configuração visível)"),
      "",
      text("SELECTED", "SELECIONADO"),
      ...fieldDetails,
      "",
      text("PREVIEW", "PRÉVIA"),
      ...previewLines,
      ...(notice ? ["", notice] : []),
    ].join("\n")
  }
  const refreshSettingsPopup = () => {
    if (settingsPopup) settingsPopup.visible = settingsState.open
    if (settingsContentText) settingsContentText.content = settingsContent()
    if (!renderer.isDestroyed) renderer.requestRender()
  }
  const closeSettings = () => {
    settingsInputMode = "none"
    settingsInputBuffer = ""
    settingsPendingSave = undefined
    props.settings?.close()
  }
  const moveSettingsSelection = (delta: number) => {
    if (!props.settings) return
    const fields = settingsFields()
    if (fields.length === 0) return
    const current = fields.findIndex(
      (entry) => entry.field.id === selectedSettingsField()?.field.id,
    )
    const nextIndex = (Math.max(0, current) + delta + fields.length) % fields.length
    props.settings.select(fields[nextIndex]?.field.id)
  }
  const cycleSettingsCategory = () => {
    if (!props.settings) return
    const categories = [undefined, ...settingsPaletteCategories(settingsState.snapshot)] as const
    const current = categories.findIndex((category) => category === settingsState.category)
    props.settings.setCategory(categories[(Math.max(0, current) + 1) % categories.length])
  }
  const beginSettingsEdit = () => {
    const selected = selectedSettingsField()
    if (!selected?.field.editable || selected.masked) return
    settingsInputMode = "edit"
    settingsInputBuffer = selected.displayValue === "not set" ? "" : selected.displayValue
    refreshSettingsPopup()
  }
  const commitSettingsEdit = () => {
    const selected = selectedSettingsField()
    if (!props.settings || !selected?.field.editable || selected.masked) return
    const value = settingsInputBuffer
    settingsInputMode = "none"
    settingsInputBuffer = ""
    void props.settings.updateText(selected.field.id, value).catch(() => undefined)
  }
  const handleSettingsKeyboard = (key: KeyEvent, printable: string | undefined): boolean => {
    if (!props.settings || !settingsState.open) return false
    key.preventDefault()
    if (settingsPendingSave) {
      if (key.name === "escape" || key.name === "esc") {
        settingsPendingSave = undefined
        refreshSettingsPopup()
      } else if (isEnterKey(key)) {
        const scope = settingsPendingSave
        settingsPendingSave = undefined
        void props.settings.saveDefaults(scope).catch(() => undefined)
        refreshSettingsPopup()
      }
      return true
    }
    if (settingsInputMode !== "none") {
      if (key.name === "escape" || key.name === "esc") {
        if (settingsInputMode === "query") props.settings.setQuery("")
        settingsInputMode = "none"
        settingsInputBuffer = ""
        refreshSettingsPopup()
        return true
      }
      if (isEnterKey(key)) {
        if (settingsInputMode === "edit") commitSettingsEdit()
        else settingsInputMode = "none"
        refreshSettingsPopup()
        return true
      }
      if (key.name === "backspace" || key.name === "delete") {
        settingsInputBuffer = dropLastGrapheme(settingsInputBuffer)
        if (settingsInputMode === "query") props.settings.setQuery(settingsInputBuffer)
        refreshSettingsPopup()
        return true
      }
      if (printable) {
        settingsInputBuffer = takeGraphemes(`${settingsInputBuffer}${printable}`, 4_096)
        if (settingsInputMode === "query") props.settings.setQuery(settingsInputBuffer)
        refreshSettingsPopup()
      }
      return true
    }
    if (key.name === "escape" || key.name === "esc") {
      closeSettings()
      return true
    }
    if (key.name === "down" || key.name === "j") {
      moveSettingsSelection(1)
      return true
    }
    if (key.name === "up" || key.name === "k") {
      moveSettingsSelection(-1)
      return true
    }
    if (isEnterKey(key)) {
      beginSettingsEdit()
      return true
    }
    if (key.name === "/" || printable === "/") {
      settingsInputMode = "query"
      settingsInputBuffer = settingsState.query
      refreshSettingsPopup()
      return true
    }
    if (key.name === "c") {
      cycleSettingsCategory()
      return true
    }
    if (key.name === "tab") {
      props.settings.setScope(settingsState.scope === "workspace" ? "global" : "workspace")
      return true
    }
    if (key.name === "v") {
      void props.settings.preview().catch(() => undefined)
      return true
    }
    if (key.name === "w") {
      settingsPendingSave = "workspace"
      refreshSettingsPopup()
      return true
    }
    if (key.name === "g") {
      settingsPendingSave = "global"
      refreshSettingsPopup()
      return true
    }
    if (key.name === "a") {
      void props.settings
        .applyForRun()
        .then((result) => props.onSettingsApply?.(result))
        .catch(() => undefined)
      return true
    }
    return true
  }

  const providerTabs: readonly ProviderPaletteTab[] = ["providers", "models", "auth", "profile"]
  const providerMatches = (...values: readonly (string | undefined)[]): boolean => {
    const query = providersState.query.trim().toLocaleLowerCase("und")
    return !query || values.some((value) => value?.toLocaleLowerCase("und").includes(query))
  }
  const visibleProviders = () =>
    (providersState.snapshot?.providers ?? []).filter((provider) =>
      providerMatches(
        provider.id,
        provider.name,
        provider.status,
        provider.access.join(" "),
        provider.authMethods.map((method) => `${method.method} ${method.label}`).join(" "),
      ),
    )
  const visibleModels = () =>
    (providersState.snapshot?.models ?? []).filter((model) =>
      providerMatches(
        model.provider,
        model.id,
        model.name,
        model.family,
        model.status,
        model.access.join(" "),
        model.capabilities.input.join(" "),
        model.capabilities.usage.join(" "),
        model.capabilities.tools ? "tools" : "",
        model.capabilities.reasoning ? "reasoning" : "",
        model.capabilities.structuredOutput ? "structured-output" : "",
      ),
    )
  const visibleCredentials = () =>
    (providersState.snapshot?.credentials ?? []).filter((credential) =>
      providerMatches(
        credential.id,
        credential.provider,
        credential.method,
        credential.store,
        credential.label,
        credential.accountHint,
        credential.status,
      ),
    )
  const activeProfileForm = () =>
    providersState.snapshot?.roleProfiles[providersState.role].forms[providersState.scope]
  const visibleProfileFields = () =>
    (activeProfileForm()?.fields ?? []).filter(
      (entry) =>
        entry.visible &&
        providerMatches(
          entry.field.id,
          entry.field.label,
          entry.field.configPath,
          entry.field.cliFlag,
          entry.field.help,
          entry.displayValue,
          entry.mode,
          entry.source,
        ),
    )
  const selectedProvider = () =>
    visibleProviders().find((provider) => provider.id === providersState.selectedProviderId) ??
    visibleProviders()[0]
  const selectedModel = () =>
    visibleModels().find(
      (model) => `${model.provider}/${model.id}` === providersState.selectedModelKey,
    ) ?? visibleModels()[0]
  const selectedCredential = () =>
    visibleCredentials().find((credential) => credential.id === providersState.selectedCredentialId)
  const selectedProfileField = () =>
    visibleProfileFields().find(
      (entry) => entry.field.id === providersState.selectedProfileFieldId,
    ) ?? visibleProfileFields()[0]
  const providerCapabilityBadges = (model: ReturnType<typeof selectedModel>): string => {
    if (!model) return ""
    return [
      ...model.capabilities.input,
      ...(model.capabilities.tools ? ["tools"] : []),
      ...(model.capabilities.toolStreaming ? ["tool-stream"] : []),
      ...(model.capabilities.reasoning ? ["reasoning"] : []),
      ...(model.capabilities.structuredOutput ? ["structured"] : []),
      ...model.capabilities.usage.map((metric) => `usage:${metric}`),
    ].join(" · ")
  }
  const selectedWindow = <T>(
    values: readonly T[],
    selectedIndex: number,
    limit: number,
  ): readonly T[] => {
    if (values.length <= limit) return values
    const normalizedIndex = selectedIndex < 0 ? 0 : selectedIndex
    const start = Math.max(
      0,
      Math.min(values.length - limit, normalizedIndex - Math.floor(limit / 2)),
    )
    return values.slice(start, start + limit)
  }
  const providerContent = (): string => {
    const snapshot = providersState.snapshot
    const selectedProviderValue = selectedProvider()
    const selectedModelValue = selectedModel()
    const selectedCredentialValue = selectedCredential()
    const selectedMethod =
      selectedProviderValue?.authMethods[providersState.selectedAuthMethodIndex]
    const activeRoleProfile = snapshot?.roleProfiles[providersState.role]
    const roleFlag = providersState.role === "executor" ? "executor" : "judge"
    const routeCli = selectedModelValue
      ? [
          "ralph run",
          `--${roleFlag}-provider ${selectedModelValue.provider}`,
          `--${roleFlag}-model ${selectedModelValue.id}`,
          ...(selectedCredentialValue
            ? [`--${roleFlag}-credential ${selectedCredentialValue.id}`]
            : [`--clear-${roleFlag}-credential`]),
          `--clear-${roleFlag}-variant`,
          `--clear-${roleFlag}-parameters`,
        ].join(" ")
      : text("run route unavailable", "rota de run indisponível")
    const lineLimit = Math.max(3, renderer.height - 20)
    let rows: readonly string[] = []
    let details: readonly string[] = []
    if (providersState.tab === "providers") {
      const values = visibleProviders()
      const selectedIndex = values.findIndex(
        (provider) => provider.id === selectedProviderValue?.id,
      )
      rows = selectedWindow(values, selectedIndex, lineLimit).map(
        (provider) =>
          `${provider.id === selectedProviderValue?.id ? ">" : " "} ${provider.name} (${provider.id}) · ${provider.status} · access=${provider.access.join(",")}`,
      )
      details = selectedProviderValue
        ? [
            `${selectedProviderValue.name} · ${selectedProviderValue.id} · ${selectedProviderValue.status}`,
            `catalog=${selectedProviderValue.catalogSource} @ ${selectedProviderValue.catalogUpdatedAt}`,
            `${text("auth methods", "métodos de auth")}: ${selectedProviderValue.authMethods.map((method, index) => `${index === providersState.selectedAuthMethodIndex ? "[" : ""}${method.method}${index === providersState.selectedAuthMethodIndex ? "]" : ""}${method.tuiConnectSupported ? "" : " (CLI)"}`).join(" · ") || text("none", "nenhum")}`,
            selectedMethod
              ? `${selectedMethod.label} · ${selectedMethod.cliCommand}${selectedMethod.unsupportedReason ? `\n${selectedMethod.unsupportedReason}` : ""}`
              : text("No auth method", "Nenhum método de auth"),
          ]
        : []
    } else if (providersState.tab === "models") {
      const values = visibleModels()
      const selectedIndex = values.findIndex(
        (model) =>
          `${model.provider}/${model.id}` ===
          (selectedModelValue
            ? `${selectedModelValue.provider}/${selectedModelValue.id}`
            : undefined),
      )
      rows = selectedWindow(values, selectedIndex, lineLimit).map((model) => {
        const key = `${model.provider}/${model.id}`
        const selectedKey = selectedModelValue
          ? `${selectedModelValue.provider}/${selectedModelValue.id}`
          : undefined
        return `${key === selectedKey ? ">" : " "} ${key} · ${model.name} · ${model.status} · ${providerCapabilityBadges(model)}`
      })
      details = selectedModelValue
        ? [
            `${selectedModelValue.provider}/${selectedModelValue.id} · ${selectedModelValue.name}`,
            `${text("capabilities", "capacidades")}: ${providerCapabilityBadges(selectedModelValue)}`,
            `${text("limits", "limites")}: context=${selectedModelValue.limits.context ?? "—"} · output=${selectedModelValue.limits.output ?? "—"}`,
            `${text("variants", "variantes")}: ${selectedModelValue.variants.map((variant) => variant.id).join(", ") || text("none", "nenhuma")}`,
            `${text("price", "preço")}: ${selectedModelValue.price.status} · ${selectedModelValue.price.currency ?? "—"} · ${selectedModelValue.price.source}${selectedModelValue.price.reason ? ` · ${selectedModelValue.price.reason}` : ""}`,
            selectedModelValue.cliInspectCommand,
          ]
        : []
    } else if (providersState.tab === "auth") {
      const values = visibleCredentials()
      const selectedIndex = values.findIndex(
        (credential) => credential.id === selectedCredentialValue?.id,
      )
      rows = selectedWindow(values, selectedIndex, lineLimit).map(
        (credential) =>
          `${credential.id === selectedCredentialValue?.id ? ">" : " "} ${credential.id} · ${credential.provider}/${credential.method} · ${credential.status} · ${credential.store}`,
      )
      details = selectedCredentialValue
        ? [
            `${selectedCredentialValue.label} · ${selectedCredentialValue.id}`,
            `${selectedCredentialValue.provider}/${selectedCredentialValue.method} · ${selectedCredentialValue.status} · ${selectedCredentialValue.store}`,
            `${text("account", "conta")}: ${selectedCredentialValue.accountHint ?? "—"} · ${text("expires", "expira")}: ${selectedCredentialValue.expiresAt ?? "—"}`,
            selectedCredentialValue.cliRevokeCommand,
          ]
        : []
    } else {
      const form = activeProfileForm()
      const values = visibleProfileFields()
      const selectedValue = selectedProfileField()
      const selectedIndex = values.findIndex((entry) => entry.field.id === selectedValue?.field.id)
      rows = selectedWindow(values, selectedIndex, lineLimit).map((entry) => {
        const marker = entry.field.id === selectedValue?.field.id ? ">" : " "
        const mode = entry.mode === "inherit" ? "I" : entry.mode === "set" ? "S" : "C"
        const editable = entry.field.editable ? "" : ` · ${text("controlled", "controlado")}`
        return `${marker} [${mode}] ${entry.field.label} = ${entry.displayValue} · ${entry.source}${editable}`
      })
      details = selectedValue
        ? [
            `${selectedValue.field.label} · ${selectedValue.field.id} · mode=${selectedValue.mode}`,
            `${selectedValue.field.configPath} · ${selectedValue.field.cliFlag}`,
            `${text("kind", "tipo")}: ${selectedValue.field.kind} · ${text("required", "obrigatório")}: ${selectedValue.field.required}`,
            `${text("choices", "opções")}: ${selectedValue.field.choices?.join(", ") ?? "—"}`,
            selectedValue.field.help,
            `${text("form", "formulário")}: revision=${form?.revision ?? 0} · valid=${form?.valid ?? false} · set-default=${form?.setDefault ?? false}`,
            ...(form?.issues.length ? form.issues.slice(0, 4).map((issue) => `! ${issue}`) : []),
          ]
        : []
    }
    const operation = providersState.operation
      ? `${providersState.operation.kind}/${providersState.operation.status}: ${providersState.operation.message}`
      : text("No mutation active", "Nenhuma mutação ativa")
    const prompt = providersProfileInput
      ? `${text("PROFILE VALUE", "VALOR DO PROFILE")}> ${providersProfileInputBuffer}█ · ${text("Enter sets; Esc cancels", "Enter define; Esc cancela")}`
      : providersAuthInput === "api-key"
        ? `${text("API KEY", "CHAVE DE API")}> ${providersAuthInputBuffer ? "********" : ""}█ · ${text("masked; Enter submits directly to the credential service", "mascarada; Enter envia diretamente ao serviço de credenciais")}`
        : providersAuthInput === "environment"
          ? `${text("ENVIRONMENT VARIABLE NAME", "NOME DA VARIÁVEL DE AMBIENTE")}> ${providersAuthInputBuffer}█`
          : providersRevokeConfirm
            ? text(
                `CONFIRM revoke ${selectedCredentialValue?.id ?? "?"}? Enter confirms; Esc cancels.`,
                `CONFIRMAR revogação de ${selectedCredentialValue?.id ?? "?"}? Enter confirma; Esc cancela.`,
              )
            : providersApplyConfirm
              ? text(
                  `CONFIRM apply ${providersState.role} route through profile ${activeRoleProfile?.id ?? "?"} to this unpersisted run? Enter confirms; Esc cancels.`,
                  `CONFIRMAR aplicação da rota ${providersState.role} pelo profile ${activeRoleProfile?.id ?? "?"} nesta run ainda não persistida? Enter confirma; Esc cancela.`,
                )
              : providersPendingSave
                ? text(
                    providersState.tab === "profile"
                      ? `CONFIRM save ${providersPendingSave} ${providersState.role} profile layer ${activeProfileForm()?.profileId ?? activeRoleProfile?.id ?? "?"} (set-default=${activeProfileForm()?.setDefault ?? false}) for future runs? Enter confirms; Esc cancels.`
                      : `CONFIRM save the selected embedded route in ${providersPendingSave} profile ${activeProfileForm()?.profileId ?? activeRoleProfile?.id ?? "?"} (set-default=${activeProfileForm()?.setDefault ?? false}) for future runs? Enter confirms; Esc cancels.`,
                    providersState.tab === "profile"
                      ? `CONFIRMAR salvamento da camada do profile ${providersState.role} ${activeProfileForm()?.profileId ?? activeRoleProfile?.id ?? "?"} em ${providersPendingSave} (set-default=${activeProfileForm()?.setDefault ?? false}) para runs futuras? Enter confirma; Esc cancela.`
                      : `CONFIRMAR salvamento da rota embedded selecionada no profile ${activeProfileForm()?.profileId ?? activeRoleProfile?.id ?? "?"} em ${providersPendingSave} (set-default=${activeProfileForm()?.setDefault ?? false}) para runs futuras? Enter confirma; Esc cancela.`,
                  )
                : providersQueryInput
                  ? `${text("SEARCH", "BUSCAR")}> ${providersQueryBuffer}█`
                  : ""
    return [
      `mode=${providersState.mode} · role=${providersState.role} · scope=${providersState.scope} · status=${providersState.status}`,
      `catalog=${snapshot?.catalogSnapshotId ?? text("loading", "carregando")} · origin=${snapshot?.catalogOrigin ?? "—"}${snapshot?.catalogStale ? " · STALE" : ""}`,
      providerTabs.map((tab) => (tab === providersState.tab ? `[${tab}]` : tab)).join("  "),
      providersState.query ? `query=${JSON.stringify(providersState.query)}` : "query=(none)",
      `route=${selectedModelValue ? `${selectedModelValue.provider}/${selectedModelValue.id}` : "—"} · credential=${selectedCredentialValue?.id ?? text("none (explicit clear)", "nenhuma (limpeza explícita)")}`,
      `profile=${activeProfileForm()?.profileId ?? activeRoleProfile?.id ?? "—"} · ${activeRoleProfile?.configured ? text("configured", "configurado") : text("not configured", "não configurado")} · set-default=${activeProfileForm()?.setDefault ?? false}`,
      `CLI=${routeCli}`,
      `config=profiles.<active-${providersState.role}-profile>.{backend,provider,model,credential,variant,parameters,external_cli,fallback_profiles,fallback_on,requirements,limits} · defaults.${providersState.role}_profile`,
      prompt,
      "",
      rows.length > 0
        ? rows.join("\n")
        : text("(no matching entries)", "(nenhuma entrada correspondente)"),
      "",
      text("SELECTED", "SELECIONADO"),
      ...(details.length > 0 ? details : [text("(none)", "(nenhum)")]),
      "",
      `${text("MUTATION", "MUTAÇÃO")}: ${operation}`,
      providersState.tab === "profile"
        ? text(
            "Enter/e edits · Space cycles choices/toggles · i inherits · d clears optional · f toggles role default · s changes scope · w/g save profile layer · t role.",
            "Enter/e edita · Espaço alterna opções/toggles · i herda · d limpa opcional · f alterna default do papel · s muda escopo · w/g salvam camada do profile · t papel.",
          )
        : providersState.mode === "pre-run"
          ? text(
              "a applies this route to the run draft; w/g save workspace/global future defaults; d selects no credential.",
              "a aplica esta rota ao draft da run; w/g salvam defaults futuros workspace/global; d seleciona nenhuma credencial.",
            )
          : text(
              "Persisted run is read-only; w/g may save defaults for future runs only.",
              "A run persistida é somente leitura; w/g podem salvar apenas defaults de runs futuras.",
            ),
      ...(providersState.error ? [`${text("ERROR", "ERRO")}: ${providersState.error}`] : []),
    ].join("\n")
  }
  const refreshProvidersPopup = () => {
    if (providersPopup) providersPopup.visible = providersState.open
    if (providersContentText) providersContentText.content = providerContent()
    if (!renderer.isDestroyed) renderer.requestRender()
  }
  const setProviderQuery = (query: string) => {
    if (!props.providers) return
    props.providers.setQuery(query)
    if (providersState.tab === "providers") {
      const values = visibleProviders()
      if (
        values[0] &&
        !values.some((provider) => provider.id === providersState.selectedProviderId)
      ) {
        props.providers.selectProvider(values[0].id)
      }
    } else if (providersState.tab === "models") {
      const values = visibleModels()
      if (
        values[0] &&
        !values.some((model) => `${model.provider}/${model.id}` === providersState.selectedModelKey)
      ) {
        props.providers.selectModel(`${values[0].provider}/${values[0].id}`)
      }
    } else if (providersState.tab === "auth") {
      const values = visibleCredentials()
      if (
        providersState.selectedCredentialId !== undefined &&
        values[0] &&
        !values.some((credential) => credential.id === providersState.selectedCredentialId)
      ) {
        props.providers.selectCredential(values[0].id)
      }
    } else {
      const values = visibleProfileFields()
      if (
        values[0] &&
        !values.some((entry) => entry.field.id === providersState.selectedProfileFieldId)
      ) {
        props.providers.selectProfileField(values[0].field.id)
      }
    }
  }
  const moveProviderSelection = (delta: number) => {
    if (!props.providers) return
    if (providersState.tab === "providers") {
      const values = visibleProviders()
      if (values.length === 0) return
      const index = values.findIndex((provider) => provider.id === selectedProvider()?.id)
      const next = values[(Math.max(0, index) + delta + values.length) % values.length]
      if (next) props.providers.selectProvider(next.id)
    } else if (providersState.tab === "models") {
      const values = visibleModels()
      if (values.length === 0) return
      const selected = selectedModel()
      const selectedKey = selected ? `${selected.provider}/${selected.id}` : undefined
      const index = values.findIndex((model) => `${model.provider}/${model.id}` === selectedKey)
      const next = values[(Math.max(0, index) + delta + values.length) % values.length]
      if (next) props.providers.selectModel(`${next.provider}/${next.id}`)
    } else if (providersState.tab === "auth") {
      const values = visibleCredentials()
      if (values.length === 0) return
      const index = values.findIndex((credential) => credential.id === selectedCredential()?.id)
      const current = index >= 0 ? index : delta > 0 ? -1 : 0
      const next = values[(current + delta + values.length) % values.length]
      if (next) props.providers.selectCredential(next.id)
    } else {
      const values = visibleProfileFields()
      if (values.length === 0) return
      const index = values.findIndex((entry) => entry.field.id === selectedProfileField()?.field.id)
      const next = values[(Math.max(0, index) + delta + values.length) % values.length]
      if (next) props.providers.selectProfileField(next.field.id)
    }
  }
  const handleProvidersKeyboard = (key: KeyEvent, printable: string | undefined): boolean => {
    if (!props.providers || !providersState.open) return false
    key.preventDefault()
    if (providersProfileInput) {
      if (key.name === "escape" || key.name === "esc") {
        providersProfileInput = false
        providersProfileInputBuffer = ""
      } else if (key.name === "backspace" || key.name === "delete") {
        providersProfileInputBuffer = dropLastGrapheme(providersProfileInputBuffer)
      } else if (isEnterKey(key)) {
        const submitted = providersProfileInputBuffer
        providersProfileInput = false
        providersProfileInputBuffer = ""
        void props.providers.updateProfileField("set", { text: submitted }).catch(() => undefined)
      } else if (printable) {
        providersProfileInputBuffer = takeGraphemes(
          `${providersProfileInputBuffer}${printable}`,
          16_384,
        )
      }
      refreshProvidersPopup()
      return true
    }
    if (providersAuthInput !== "none") {
      if (key.name === "escape" || key.name === "esc") {
        providersAuthInput = "none"
        providersAuthInputBuffer = ""
      } else if (key.name === "backspace" || key.name === "delete") {
        providersAuthInputBuffer = dropLastGrapheme(providersAuthInputBuffer)
      } else if (isEnterKey(key)) {
        const kind = providersAuthInput
        const submitted = providersAuthInputBuffer
        providersAuthInput = "none"
        providersAuthInputBuffer = ""
        if (submitted.length === 0) {
          void props.providers.connectSelected().catch(() => undefined)
        } else if (kind === "api-key") {
          void props.providers
            .connectSelected({
              kind: "api-key",
              secret: createProviderPaletteSecretInput(submitted),
            })
            .catch(() => undefined)
        } else {
          void props.providers
            .connectSelected({ kind: "environment", variable: submitted })
            .catch(() => undefined)
        }
      } else if (printable) {
        providersAuthInputBuffer = takeGraphemes(`${providersAuthInputBuffer}${printable}`, 16_384)
      }
      refreshProvidersPopup()
      return true
    }
    if (providersRevokeConfirm) {
      if (key.name === "escape" || key.name === "esc") providersRevokeConfirm = false
      else if (isEnterKey(key)) {
        providersRevokeConfirm = false
        void props.providers.revokeSelected().catch(() => undefined)
      }
      refreshProvidersPopup()
      return true
    }
    if (providersApplyConfirm) {
      if (key.name === "escape" || key.name === "esc") providersApplyConfirm = false
      else if (isEnterKey(key)) {
        providersApplyConfirm = false
        void props.providers
          .applySelected()
          .then((result) => props.onSettingsApply?.(result.result))
          .catch(() => undefined)
      }
      refreshProvidersPopup()
      return true
    }
    if (providersPendingSave) {
      if (key.name === "escape" || key.name === "esc") providersPendingSave = undefined
      else if (isEnterKey(key)) {
        const scope = providersPendingSave
        providersPendingSave = undefined
        void props.providers.saveSelected(scope).catch(() => undefined)
      }
      refreshProvidersPopup()
      return true
    }
    if (providersQueryInput) {
      if (key.name === "escape" || key.name === "esc" || isEnterKey(key)) {
        providersQueryInput = false
      } else if (key.name === "backspace" || key.name === "delete") {
        providersQueryBuffer = dropLastGrapheme(providersQueryBuffer)
        setProviderQuery(providersQueryBuffer)
      } else if (printable) {
        providersQueryBuffer = takeGraphemes(`${providersQueryBuffer}${printable}`, 256)
        setProviderQuery(providersQueryBuffer)
      }
      refreshProvidersPopup()
      return true
    }
    if (key.name === "escape" || key.name === "esc") {
      providersAuthInputBuffer = ""
      providersProfileInput = false
      providersProfileInputBuffer = ""
      props.providers.close()
      return true
    }
    if (key.name === "tab" || key.name === "right") {
      const index = providerTabs.indexOf(providersState.tab)
      props.providers.setTab(providerTabs[(index + 1) % providerTabs.length] ?? "providers")
      return true
    }
    if (key.name === "left") {
      const index = providerTabs.indexOf(providersState.tab)
      props.providers.setTab(
        providerTabs[(index - 1 + providerTabs.length) % providerTabs.length] ?? "providers",
      )
      return true
    }
    if (key.name === "down" || key.name === "j") {
      moveProviderSelection(1)
      return true
    }
    if (key.name === "up" || key.name === "k") {
      moveProviderSelection(-1)
      return true
    }
    if (key.name === "/" || printable === "/") {
      providersQueryInput = true
      providersQueryBuffer = providersState.query
      refreshProvidersPopup()
      return true
    }
    if (key.name === "[" || printable === "[") {
      props.providers.selectAuthMethod(providersState.selectedAuthMethodIndex - 1)
      return true
    }
    if (key.name === "]" || printable === "]") {
      props.providers.selectAuthMethod(providersState.selectedAuthMethodIndex + 1)
      return true
    }
    if (key.name === "r") {
      void props.providers.reload(true).catch(() => undefined)
      return true
    }
    if (key.name === "t") {
      props.providers.setRole(providersState.role === "executor" ? "judge" : "executor")
      return true
    }
    if (key.name === "a") {
      if (providersState.tab === "profile") return true
      if (providersState.mode === "pre-run") providersApplyConfirm = true
      else void props.providers.applySelected().catch(() => undefined)
      refreshProvidersPopup()
      return true
    }
    if (key.name === "w") {
      props.providers.setScope("workspace")
      providersPendingSave = "workspace"
      refreshProvidersPopup()
      return true
    }
    if (key.name === "g") {
      props.providers.setScope("global")
      providersPendingSave = "global"
      refreshProvidersPopup()
      return true
    }
    if (key.name === "c") {
      if (providersState.tab !== "providers") return true
      const method = selectedProvider()?.authMethods[providersState.selectedAuthMethodIndex]
      if (method?.method === "api-key" || method?.method === "environment") {
        providersAuthInput = method.method
        providersAuthInputBuffer = ""
        refreshProvidersPopup()
      } else {
        void props.providers.connectSelected().catch(() => undefined)
      }
      return true
    }
    if (key.name === "d" && providersState.tab === "auth") {
      props.providers.clearCredentialSelection()
      refreshProvidersPopup()
      return true
    }
    if (key.name === "x" && providersState.tab === "auth" && selectedCredential()) {
      providersRevokeConfirm = true
      refreshProvidersPopup()
      return true
    }
    if (providersState.tab === "profile") {
      if (isEnterKey(key) || key.name === "e") {
        const field = selectedProfileField()
        if (field?.field.editable) {
          providersProfileInput = true
          providersProfileInputBuffer =
            field.mode === "clear" || field.displayValue === "not set" ? "" : field.displayValue
          refreshProvidersPopup()
        }
        return true
      }
      if (key.name === "space" || printable === " ") {
        void props.providers.updateProfileField("cycle", { direction: 1 }).catch(() => undefined)
        return true
      }
      if (key.name === "i") {
        void props.providers.updateProfileField("inherit").catch(() => undefined)
        return true
      }
      if (key.name === "d") {
        void props.providers.updateProfileField("clear").catch(() => undefined)
        return true
      }
      if (key.name === "s") {
        props.providers.setScope(providersState.scope === "workspace" ? "global" : "workspace")
        return true
      }
      if (key.name === "f") {
        props.providers.selectProfileField("setDefault")
        void props.providers.updateProfileField("cycle", { direction: 1 }).catch(() => undefined)
        return true
      }
    }
    return true
  }

  const refreshFeedbackTab = () => {
    const selected = feedbackTab()
    const fieldLimit = Math.max(3, Math.floor((renderer.height - 10) / 2))
    if (evaluationFieldsText) {
      const fieldLines = evaluationFieldLines(
        props.evaluationFields ?? [],
        snapshot().evaluationValues,
        snapshot().evaluationOrigins,
        text,
      ).split("\n")
      evaluationFieldsText.content =
        fieldLines.length <= fieldLimit
          ? fieldLines.join("\n")
          : `${fieldLines.slice(0, fieldLimit).join("\n")}\n… ${fieldLines.length - fieldLimit} ${text("field line(s) omitted; use config explain for the complete view", "linha(s) de campo omitida(s); use config explain para a visão completa")}`
    }
    if (evaluationTabs) {
      evaluationTabs.content = FEEDBACK_TABS.map((tab) => {
        const label = feedbackTabLabel(tab, text)
        return tab === selected ? `[${label}]` : label
      }).join("  ")
    }
    if (evaluationFeedback) {
      const items = snapshot().judge.feedback[selected]
      const feedbackLimit = Math.max(1, renderer.height - Math.max(12, fieldLimit) - 10)
      const maximumOffset = Math.max(0, items.length - feedbackLimit)
      feedbackScrollOffset = Math.min(feedbackScrollOffset, maximumOffset)
      const visibleItems = items.slice(feedbackScrollOffset, feedbackScrollOffset + feedbackLimit)
      evaluationFeedback.content =
        items.length === 0
          ? text("(none)", "(nenhum)")
          : `${visibleItems.map((item) => `• ${item}`).join("\n")}\n[${feedbackScrollOffset + 1}-${feedbackScrollOffset + visibleItems.length}/${items.length}]`
    }
    renderer.requestRender()
  }
  const setEvaluationVisible = (visible: boolean) => {
    evaluationOpen = visible
    if (evaluationPopup) evaluationPopup.visible = visible
    renderer.requestRender()
  }
  const refreshSearchPopup = () => {
    if (searchPopup) searchPopup.visible = searchOpen
    if (searchQueryText) searchQueryText.content = `/${searchQuery}█`
    if (activityText) activityText.content = recentOperations()
    if (engineText) engineText.content = engineAndJudge()
    if (keyHelpText) keyHelpText.content = keyHelpLine()
    renderer.requestRender()
  }
  const setSearchVisible = (visible: boolean) => {
    searchOpen = visible
    refreshSearchPopup()
  }
  const setHelpVisible = (visible: boolean) => {
    helpOpen = visible
    if (helpPopup) helpPopup.visible = visible
    renderer.requestRender()
  }
  const printableKey = (key: KeyEvent): string | undefined => {
    const sequence = Reflect.get(key as object, "sequence")
    if (typeof sequence !== "string" || sequence.length === 0) return undefined
    const ctrl = Reflect.get(key as object, "ctrl")
    const meta = Reflect.get(key as object, "meta")
    if (ctrl === true || meta === true || containsC0OrDeleteControl(sequence)) return undefined
    return sequence
  }
  const matchesAction = (
    action: RunDashboardAction,
    key: KeyEvent,
    printable: string | undefined,
  ): boolean => {
    const expression = binding(action).trim().toLocaleLowerCase("und")
    const parts = expression
      .split("+")
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length === 0) return false
    const primary = parts.at(-1)
    if (!primary) return false
    const modifiers = new Set(parts.slice(0, -1))
    if (
      [...modifiers].some(
        (part) => part !== "ctrl" && part !== "alt" && part !== "meta" && part !== "shift",
      )
    ) {
      return false
    }
    const ctrl = Reflect.get(key as object, "ctrl") === true
    const meta = Reflect.get(key as object, "meta") === true
    const shift = Reflect.get(key as object, "shift") === true
    const alt = Reflect.get(key as object, "alt") === true
    if (ctrl !== modifiers.has("ctrl")) return false
    if (meta !== modifiers.has("meta")) return false
    if (modifiers.has("shift") && !shift) return false
    if (alt !== modifiers.has("alt")) return false
    const name = key.name.toLocaleLowerCase("und")
    const aliases: Readonly<Record<string, readonly string[]>> = {
      esc: ["esc", "escape"],
      escape: ["esc", "escape"],
      return: ["return", "enter"],
      enter: ["return", "enter"],
      up: ["up", "arrowup"],
      down: ["down", "arrowdown"],
      left: ["left", "arrowleft"],
      right: ["right", "arrowright"],
    }
    return (
      (aliases[primary]?.includes(name) ?? false) ||
      name === primary ||
      printable?.toLocaleLowerCase("und") === primary
    )
  }
  const refreshStopPopup = () => {
    if (stopPopup) stopPopup.visible = stopConfirmOpen
    if (stopMessageText) stopMessageText.content = stopMessage
    if (!renderer.isDestroyed) renderer.requestRender()
  }
  const requestStop = async () => {
    if (!props.onStop || stopPending) return
    stopPending = true
    stopMessage = text(
      "Sending command-owned graceful stop request…",
      "Enviando solicitação command-owned de parada graciosa…",
    )
    refreshStopPopup()
    try {
      stopMessage =
        (await props.onStop()) ??
        text("Graceful stop request accepted", "Solicitação de parada graciosa aceita")
    } catch (error) {
      stopMessage = error instanceof Error ? error.message : String(error)
    } finally {
      stopPending = false
      refreshStopPopup()
    }
  }
  const keyboardHandler = (key: KeyEvent) => {
    const printable = printableKey(key)
    if (Reflect.get(key as object, "ctrl") === true && key.name.toLocaleLowerCase("und") === "c") {
      key.preventDefault()
      if (props.onInterrupt) props.onInterrupt()
      else if (props.onQuit) props.onQuit()
      return
    }
    if (props.providers && matchesAction("providers", key, printable)) {
      key.preventDefault()
      if (providersState.open) props.providers.close()
      else {
        if (settingsState.open) closeSettings()
        void props.providers.open().catch(() => undefined)
      }
      return
    }
    if (handleProvidersKeyboard(key, printable)) return
    if (props.settings && matchesAction("palette", key, printable)) {
      key.preventDefault()
      if (settingsState.open) closeSettings()
      else {
        if (providersState.open) props.providers?.close()
        void props.settings.open().catch(() => undefined)
      }
      return
    }
    if (handleSettingsKeyboard(key, printable)) return
    if (searchOpen) {
      key.preventDefault()
      if (key.name === "escape" || key.name === "esc") {
        searchQuery = ""
        setSearchVisible(false)
        return
      }
      if (isEnterKey(key)) {
        setSearchVisible(false)
        return
      }
      if (key.name === "backspace" || key.name === "delete") {
        searchQuery = dropLastGrapheme(searchQuery)
        refreshSearchPopup()
        return
      }
      if (printable) {
        searchQuery = takeGraphemes(`${searchQuery}${printable}`, 256)
        refreshSearchPopup()
      }
      return
    }
    if (helpOpen) {
      if (matchesAction("help", key, printable) || key.name === "escape" || key.name === "esc") {
        key.preventDefault()
        setHelpVisible(false)
      }
      return
    }
    if (matchesAction("quit", key, printable)) {
      key.preventDefault()
      if (props.onQuit) props.onQuit()
      else renderer.destroy()
      return
    }
    if (matchesAction("help", key, printable) && !evaluationOpen && !stopConfirmOpen) {
      key.preventDefault()
      setHelpVisible(true)
      return
    }
    if (matchesAction("search", key, printable) && !evaluationOpen && !stopConfirmOpen) {
      key.preventDefault()
      setSearchVisible(true)
      return
    }
    if (matchesAction("filter", key, printable) && !evaluationOpen && !stopConfirmOpen) {
      key.preventDefault()
      activityFilterIndex = (activityFilterIndex + 1) % ACTIVITY_FILTERS.length
      refreshSearchPopup()
      return
    }
    if (matchesAction("output.toggle", key, printable) && !evaluationOpen && !stopConfirmOpen) {
      key.preventDefault()
      engineOutputMode = engineOutputMode === "normalized" ? "raw-engine" : "normalized"
      refreshSearchPopup()
      return
    }
    if (matchesAction("evaluation", key, printable) && !stopConfirmOpen) {
      key.preventDefault()
      setEvaluationVisible(!evaluationOpen)
      return
    }
    if (matchesAction("stop", key, printable) && !evaluationOpen && props.onStop) {
      key.preventDefault()
      stopConfirmOpen = true
      stopMessage = text("Awaiting confirmation", "Aguardando confirmação")
      refreshStopPopup()
      return
    }
    if ((key.name === "escape" || key.name === "esc") && stopConfirmOpen && !stopPending) {
      key.preventDefault()
      stopConfirmOpen = false
      refreshStopPopup()
      return
    }
    if (isEnterKey(key) && stopConfirmOpen) {
      key.preventDefault()
      void requestStop()
      return
    }
    if (matchesAction("output.pause", key, printable) && !evaluationOpen) {
      key.preventDefault()
      outputPaused = !outputPaused
      if (outputPaused) {
        pausedEngineOutput = [...snapshot().engineOutput]
        pausedRawEngineOutput = [...(snapshot().rawEngineOutput ?? [])]
      }
      if (engineText) engineText.content = engineAndJudge()
      if (keyHelpText) keyHelpText.content = keyHelpLine()
      renderer.requestRender()
      return
    }
    if ((key.name === "escape" || key.name === "esc") && evaluationOpen) {
      key.preventDefault()
      setEvaluationVisible(false)
      return
    }
    if (!evaluationOpen) return
    if (key.name === "tab" || key.name === "right") {
      key.preventDefault()
      feedbackTabIndex = (feedbackTabIndex + 1) % FEEDBACK_TABS.length
      feedbackScrollOffset = 0
      refreshFeedbackTab()
    } else if (key.name === "left") {
      key.preventDefault()
      feedbackTabIndex = (feedbackTabIndex - 1 + FEEDBACK_TABS.length) % FEEDBACK_TABS.length
      feedbackScrollOffset = 0
      refreshFeedbackTab()
    } else if (key.name === "down" || key.name === "j") {
      key.preventDefault()
      feedbackScrollOffset += 1
      refreshFeedbackTab()
    } else if (key.name === "up" || key.name === "k") {
      key.preventDefault()
      feedbackScrollOffset = Math.max(0, feedbackScrollOffset - 1)
      refreshFeedbackTab()
    }
  }
  const detachKeyboard = () => renderer.keyInput.off("keypress", keyboardHandler)
  renderer.keyInput.on("keypress", keyboardHandler)
  const unsubscribeSettings = props.settings?.subscribe((nextState) => {
    settingsState = nextState
    const fields = settingsFields()
    if (
      nextState.open &&
      fields.length > 0 &&
      !fields.some((entry) => entry.field.id === nextState.selectedFieldId)
    ) {
      props.settings?.select(fields[0]?.field.id)
      return
    }
    refreshSettingsPopup()
  })
  const unsubscribeProviders = props.providers?.subscribe((nextState) => {
    providersState = nextState
    if (!nextState.open) {
      providersAuthInput = "none"
      providersAuthInputBuffer = ""
      providersQueryInput = false
      providersQueryBuffer = ""
      providersRevokeConfirm = false
      providersApplyConfirm = false
      providersPendingSave = undefined
    }
    refreshProvidersPopup()
  })

  const scopePanelWidth = (): number =>
    wide() ? Math.max(1, Math.floor((renderer.width - 3) / 2) - 4) : Math.max(1, renderer.width - 6)
  const scopeProjectionLines = (): readonly string[] => {
    const scopes = snapshot().scopes ?? []
    if (scopes.length === 0)
      return [text("(scope projection unavailable)", "(projeção de escopo indisponível)")]
    const activeRunId = snapshot().currentTask?.runId ?? snapshot().runId
    const activeIndex = Math.max(
      0,
      scopes.findIndex((scope) => scope.runId === activeRunId),
    )
    const maximumVisible = Math.max(1, Math.min(4, Math.floor((renderer.height - 13) / 2)))
    const windowStart = Math.max(
      0,
      Math.min(Math.max(0, scopes.length - maximumVisible), activeIndex - 1),
    )
    const visible = scopes.slice(windowStart, windowStart + maximumVisible)
    const width = scopePanelWidth()
    const lines = visible.flatMap((scope) => {
      const indent = "  ".repeat(Math.max(0, scope.depth))
      const scopeName =
        scope.kind === "root"
          ? text("root", "raiz")
          : `${text("child", "filho")} ${scope.runId.slice(0, 8)}`
      const active = scope.runId === activeRunId ? ">" : " "
      const totalTokens = scope.usage.combined.available
        ? (scope.usage.combined.totalTokens ?? "—")
        : "—"
      const header = `${active}${indent}${scopeName} · ${scope.progress.completed}/${scope.progress.total} · ${scope.status} · tokens=${totalTokens} (${scope.usage.combined.source}) · wd=${scope.watchdog.state} · errors=${scope.errors.count}`
      const barPrefix = " ".repeat(Math.min(displayWidth(indent), Math.max(0, width - 1)))
      const bar = progressBar({
        completed: scope.progress.completed,
        total: scope.progress.total,
        width: Math.max(1, width - displayWidth(barPrefix)),
        style: props.ascii ? "ascii" : "unicode",
      }).bar
      return [truncateDisplayWidth(header, width), `${barPrefix}${bar}`]
    })
    if (scopes.length > visible.length) {
      lines.push(
        `${text("scopes", "escopos")} ${windowStart + 1}-${windowStart + visible.length}/${scopes.length} · ${text("active scope kept visible", "escopo ativo mantido visível")}`,
      )
    }
    return lines
  }

  const recentOperations = () => {
    const state = snapshot()
    const treeEntries = state.taskTree ?? []
    const treeLines = treeEntries.map((task) => {
      const indent = "  ".repeat(Math.max(0, task.depth))
      return `${indent}${taskStatusGlyph(task.status)} ${task.id} · ${task.status}`
    })
    const currentTreeIndex = treeEntries.findIndex(
      (task) => task.id === state.currentTask?.id && task.runId === state.currentTask?.runId,
    )
    const treeWindowStart = Math.max(
      0,
      Math.min(
        Math.max(0, treeLines.length - 8),
        currentTreeIndex < 0 ? Math.max(0, treeLines.length - 8) : currentTreeIndex - 3,
      ),
    )
    const tree = searchQuery
      ? treeLines.filter(matchesSearch).slice(-8)
      : treeLines.slice(treeWindowStart, treeWindowStart + 8)
    const activity = state.activity
      .filter(matchesActivityFilter)
      .map(formatEntry)
      .filter(matchesSearch)
      .slice(-3)
    const logs = state.logs
      .filter(matchesActivityFilter)
      .map(formatEntry)
      .filter(matchesSearch)
      .slice(-3)
    return [
      `${text("ROOT / CHILD PROGRESS", "PROGRESSO RAIZ / FILHOS")} · ${text("each bar uses 100% of its panel width", "cada barra usa 100% da largura do painel")}`,
      ...scopeProjectionLines(),
      "",
      text("TASK TREE", "ÁRVORE DE TASKS"),
      tree.length > 0 ? tree.join("\n") : text("(none)", "(nenhuma)"),
      "",
      `${text("ACTIVITY", "ATIVIDADE")} · ${text("FILTER", "FILTRO")}=${activityFilter()}${searchQuery ? ` · ${text("SEARCH", "BUSCA")}=${JSON.stringify(searchQuery)}` : ""}`,
      activity.length > 0 ? activity.join("\n") : text("(none)", "(nenhuma)"),
      "",
      `${text("ERRORS", "ERROS")}  ${view().errorLabel}`,
      text("LOG / WARNINGS", "LOG / AVISOS"),
      logs.length > 0 ? logs.join("\n") : text("(none)", "(nenhum)"),
    ].join("\n")
  }
  const engineAndJudge = () => {
    const state = snapshot()
    const selectedOutput =
      engineOutputMode === "raw-engine"
        ? outputPaused
          ? pausedRawEngineOutput
          : (state.rawEngineOutput ?? [])
        : outputPaused
          ? pausedEngineOutput
          : state.engineOutput
    const output = selectedOutput
      .filter(matchesSearch)
      .slice(-5)
      .map((line) => truncateDisplayWidth(line, 600, "…[display truncated]"))
    const tools = (state.tools ?? [])
      .map(
        (tool) =>
          `${tool.name} · ${tool.status}${tool.durationMs === undefined ? "" : ` · ${tool.durationMs}ms`}${tool.preview ? ` · ${tool.preview}` : ""}`,
      )
      .filter(matchesSearch)
      .slice(-3)
    const gates = (state.gates ?? [])
      .map(
        (gate) =>
          `${taskStatusGlyph(gate.status)} ${gate.id} · ${gate.status}${gate.durationMs === undefined ? "" : ` · ${gate.durationMs}ms`}`,
      )
      .filter(matchesSearch)
      .slice(-3)
    const summary =
      state.judge.summary ?? text("No judge summary reported", "Nenhum resumo do juiz reportado")
    const decision = state.judge.decision ?? "pending"
    return [
      text("JUDGE", "JUIZ"),
      view().judgeLabel,
      `${text("decision", "decisão")}: ${decision}`,
      `${text("opinion", "parecer")}: ${summary}`,
      "",
      text("TOOLS", "FERRAMENTAS"),
      tools.length > 0 ? tools.join("\n") : text("(none)", "(nenhuma)"),
      "",
      text("GATES", "GATES"),
      gates.length > 0 ? gates.join("\n") : text("(none)", "(nenhum)"),
      "",
      `${text("ENGINE OUTPUT", "SAÍDA DA ENGINE")} · ${engineOutputMode.toUpperCase()}${outputPaused ? text(" · PAUSED", " · PAUSADA") : text(" · LIVE", " · AO VIVO")}${searchQuery ? ` · ${text("SEARCH", "BUSCA")}=${JSON.stringify(searchQuery)}` : ""}`,
      output.length > 0
        ? output.join("\n")
        : engineOutputMode === "raw-engine"
          ? text(
              `(no persisted raw capture content available${state.rawEngineRefs?.length ? `; ${state.rawEngineRefs.length} resolved ref(s)` : ""})`,
              `(nenhum conteúdo de captura bruta persistida disponível${state.rawEngineRefs?.length ? `; ${state.rawEngineRefs.length} ref(s) resolvida(s)` : ""})`,
            )
          : text("(no output)", "(sem saída)"),
    ].join("\n")
  }

  const syncSnapshotView = () => {
    const nextView = view()
    if (headerTitle) headerTitle.content = `RALPH · ${snapshot().title}`
    if (headerStatus) {
      headerStatus.content = headerStatusLine()
      headerStatus.fg = statusColor(snapshot().status, theme)
    }
    if (currentTaskText) {
      currentTaskText.content = `${text("Current task", "Task atual")}  ${currentTaskLine()}`
    }
    if (progressLabelText) {
      progressLabelText.content = `${text("Progress", "Progresso")}      ${nextView.progressLabel}`
    }
    if (progressBarText) progressBarText.content = nextView.progressBar
    if (usageText) {
      usageText.content =
        `STATUS    ${nextView.runtimeLabel}\n` +
        `WATCHDOG  ${nextView.watchdogLabel}\n` +
        `${text("SIGNALS", "SINAIS")}   ${watchdogSignalsLine()}\n` +
        `TOTAL     ${nextView.combinedUsage}\n` +
        `${text("executor", "executor")}  ${nextView.executorUsage}\n` +
        `${text("judge", "juiz")}     ${nextView.judgeUsage}`
    }
    if (activityText) activityText.content = recentOperations()
    if (engineText) engineText.content = engineAndJudge()
    if (keyHelpText) keyHelpText.content = keyHelpLine()
    refreshFeedbackTab()
    renderer.requestRender()
  }
  const syncLayout = () => {
    const isWide = wide()
    if (usagePanel) usagePanel.height = isWide ? 8 : 13
    if (detailGrid) detailGrid.flexDirection = isWide ? "row" : "column"
    if (activityPanel) activityPanel.width = isWide ? "50%" : "100%"
    if (enginePanel) enginePanel.width = isWide ? "50%" : "100%"
    if (evaluationPopup) {
      evaluationPopup.width = Math.max(1, renderer.width - 2)
      evaluationPopup.height = Math.max(1, renderer.height - 1)
    }
    if (stopPopup) {
      stopPopup.width = Math.max(1, Math.min(76, renderer.width - 2))
      stopPopup.height = Math.max(1, Math.min(8, renderer.height - 2))
    }
    if (searchPopup) {
      searchPopup.width = Math.max(1, Math.min(90, renderer.width - 2))
      searchPopup.height = Math.max(1, Math.min(5, renderer.height - 2))
    }
    if (helpPopup) {
      helpPopup.width = Math.max(1, Math.min(78, renderer.width - 2))
      helpPopup.height = Math.max(1, Math.min(20, renderer.height - 2))
    }
    if (settingsPopup) {
      settingsPopup.width = Math.max(1, renderer.width - 2)
      settingsPopup.height = Math.max(1, renderer.height - 1)
    }
    if (providersPopup) {
      providersPopup.width = Math.max(1, renderer.width - 2)
      providersPopup.height = Math.max(1, renderer.height - 1)
    }
    syncSnapshotView()
  }
  const controller: RunDashboardController = {
    updateSnapshot(nextSnapshot) {
      currentSnapshot = nextSnapshot
      syncSnapshotView()
    },
  }
  props.controllerRef?.(controller)
  const resizeHandler = () => syncLayout()
  renderer.on(CliRenderEvents.RESIZE, resizeHandler)
  renderer.once(CliRenderEvents.DESTROY, () => {
    detachKeyboard()
    unsubscribeSettings?.()
    unsubscribeProviders?.()
    providersAuthInputBuffer = ""
    providersProfileInputBuffer = ""
    renderer.off(CliRenderEvents.RESIZE, resizeHandler)
  })

  return jsxs("box", {
    id: "ralph-dashboard",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: theme.background,
    paddingX: 1,
    children: [
      jsxs("box", {
        id: "header",
        height: 2,
        flexDirection: "row",
        justifyContent: "space-between",
        children: [
          jsx("text", {
            ref: (text: TextRenderable) => {
              headerTitle = text
            },
            fg: theme.orange,
            get children() {
              return `RALPH · ${snapshot().title}`
            },
          }),
          jsx("text", {
            ref: (text: TextRenderable) => {
              headerStatus = text
            },
            get fg() {
              return statusColor(snapshot().status, theme)
            },
            get children() {
              return headerStatusLine()
            },
          }),
        ],
      }),
      jsxs("box", {
        id: "run-summary",
        title: "RUN",
        titleColor: theme.orange,
        border: true,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        height: 6,
        paddingX: 1,
        flexDirection: "column",
        children: [
          jsx("text", {
            ref: (text: TextRenderable) => {
              currentTaskText = text
            },
            fg: theme.text,
            get children() {
              return `${text("Current task", "Task atual")}  ${currentTaskLine()}`
            },
          }),
          jsx("text", {
            ref: (text: TextRenderable) => {
              progressLabelText = text
            },
            fg: theme.green,
            get children() {
              return `${text("Progress", "Progresso")}      ${view().progressLabel}`
            },
          }),
          jsx("text", {
            ref: (text: TextRenderable) => {
              progressBarText = text
            },
            fg: theme.green,
            truncate: true,
            get children() {
              return view().progressBar
            },
          }),
        ],
      }),
      TextPanel({
        theme,
        id: "usage-panel",
        title: text("STATUS / USAGE / WATCHDOG", "STATUS / USO / WATCHDOG"),
        get height() {
          return wide() ? 8 : 13
        },
        boxRef: (box) => {
          usagePanel = box
        },
        textRef: (text) => {
          usageText = text
        },
        content: () =>
          `STATUS    ${view().runtimeLabel}\nWATCHDOG  ${view().watchdogLabel}\n${text("SIGNALS", "SINAIS")}   ${watchdogSignalsLine()}\nTOTAL     ${view().combinedUsage}\nexecutor  ${view().executorUsage}\n${text("judge", "juiz")}     ${view().judgeUsage}`,
      }),
      jsxs("box", {
        id: "detail-grid",
        ref: (box: BoxRenderable) => {
          detailGrid = box
        },
        get flexDirection() {
          return wide() ? "row" : "column"
        },
        flexGrow: 1,
        gap: 1,
        overflow: "hidden",
        children: [
          TextPanel({
            theme,
            id: "activity-panel",
            title: text("TASKS / ACTIVITY / ERRORS", "TASKS / ATIVIDADE / ERROS"),
            flexGrow: 1,
            get width() {
              return wide() ? "50%" : "100%"
            },
            boxRef: (box) => {
              activityPanel = box
            },
            textRef: (text) => {
              activityText = text
            },
            content: recentOperations,
          }),
          TextPanel({
            theme,
            id: "engine-panel",
            title: text("ENGINE / TOOLS / GATES / JUDGE", "ENGINE / FERRAMENTAS / GATES / JUIZ"),
            flexGrow: 1,
            get width() {
              return wide() ? "50%" : "100%"
            },
            boxRef: (box) => {
              enginePanel = box
            },
            textRef: (text) => {
              engineText = text
            },
            content: engineAndJudge,
          }),
        ],
      }),
      jsx("text", {
        id: "key-help",
        ref: (text: TextRenderable) => {
          keyHelpText = text
        },
        height: 1,
        fg: theme.muted,
        get children() {
          return keyHelpLine()
        },
      }),
      EvaluationPopup({
        theme,
        text,
        snapshot,
        fields: props.evaluationFields ?? [],
        tab: feedbackTab(),
        width: () => renderer.width,
        height: () => renderer.height,
        visible: evaluationOpen,
        popupRef: (popup) => {
          evaluationPopup = popup
        },
        fieldsRef: (text) => {
          evaluationFieldsText = text
        },
        tabsRef: (text) => {
          evaluationTabs = text
        },
        feedbackRef: (text) => {
          evaluationFeedback = text
        },
      }),
      StopPopup({
        theme,
        text,
        visible: stopConfirmOpen,
        pending: stopPending,
        message: stopMessage,
        width: () => renderer.width,
        height: () => renderer.height,
        popupRef: (popup) => {
          stopPopup = popup
        },
        messageRef: (text) => {
          stopMessageText = text
        },
      }),
      SearchPopup({
        theme,
        text,
        visible: searchOpen,
        query: searchQuery,
        width: () => renderer.width,
        height: () => renderer.height,
        popupRef: (popup) => {
          searchPopup = popup
        },
        queryRef: (text) => {
          searchQueryText = text
        },
      }),
      HelpPopup({
        theme,
        text,
        visible: helpOpen,
        content:
          locale === "pt-BR"
            ? `${binding("help")} ajuda\n${binding("palette")} paleta de configurações\n${binding("providers")} providers/modelos/auth/camada de profile; t troca executor/juiz, a aplica rota embedded pré-run, w/g salvam profile no escopo\nProfile: Enter edita, Espaço alterna, i herda, d limpa, f alterna default, s troca escopo\n${binding("search")} buscar atividade e saída visíveis\n${binding("filter")} alternar filtro de nível da atividade\n${binding("output.toggle")} alternar visão normalizada/raw-engine\n${binding("output.pause")} pausar/retomar rolagem automática\n${binding("evaluation")} avaliação e parecer do juiz\n${binding("stop")} parada graciosa e durável\n${binding("quit")} fechar TUI; a run segue em background\nEsc fecha o popup ativo`
            : `${binding("help")} help\n${binding("palette")} settings palette\n${binding("providers")} providers/models/auth/profile layer; t switches executor/judge, a applies embedded route pre-run, w/g save profile by scope\nProfile: Enter edits, Space cycles, i inherits, d clears, f toggles default, s switches scope\n${binding("search")} search visible activity and output\n${binding("filter")} cycle activity level filter\n${binding("output.toggle")} toggle normalized/raw-engine view\n${binding("output.pause")} pause/resume output autoscroll\n${binding("evaluation")} evaluation and judge opinion\n${binding("stop")} graceful durable stop\n${binding("quit")} close TUI; run stays in background\nEsc closes the active popup`,
        width: () => renderer.width,
        height: () => renderer.height,
        popupRef: (popup) => {
          helpPopup = popup
        },
      }),
      SettingsPopup({
        theme,
        text,
        visible: settingsState.open,
        width: () => renderer.width,
        height: () => renderer.height,
        content: settingsContent,
        popupRef: (popup) => {
          settingsPopup = popup
        },
        contentRef: (text) => {
          settingsContentText = text
        },
      }),
      SettingsPopup({
        theme,
        text,
        id: "providers-popup",
        title: text(
          "PROVIDERS · MODELS · AUTH · COMPLETE ROLE PROFILES",
          "PROVIDERS · MODELOS · AUTH · PROFILES COMPLETOS",
        ),
        bottomTitle: text(
          "Tab/←/→ section · ↑/↓ select · profile: Enter edit, Space cycle, i inherit, d clear, f default, s scope · w/g save · t role · Esc close",
          "Tab/←/→ seção · ↑/↓ selecionar · profile: Enter editar, Espaço alternar, i herdar, d limpar, f default, s escopo · w/g salvar · t papel · Esc fechar",
        ),
        visible: providersState.open,
        width: () => renderer.width,
        height: () => renderer.height,
        content: providerContent,
        popupRef: (popup) => {
          providersPopup = popup
        },
        contentRef: (content) => {
          providersContentText = content
        },
      }),
    ],
  })
}

export function destroyDashboardRenderer(renderer: CliRenderer): void {
  if (!renderer.isDestroyed) renderer.destroy()
}
