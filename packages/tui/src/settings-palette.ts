/**
 * Format-neutral settings palette contracts.
 *
 * This module intentionally knows nothing about Ralph configuration schemas,
 * persistence, command parsing, or run orchestration. A host adapter owns the
 * concrete draft and exposes only safe display data plus explicit mutations.
 */

export type SettingsPaletteMode = "pre-run" | "attach" | "replay"
export type SettingsPaletteScope = "workspace" | "global"
export type SettingsPaletteStatus =
  | "closed"
  | "loading"
  | "ready"
  | "updating"
  | "previewing"
  | "applying"
  | "saving"
  | "error"

export type SettingsPaletteJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly SettingsPaletteJsonValue[]
  | { readonly [key: string]: SettingsPaletteJsonValue }

export type SettingsPaletteFieldKind =
  | "toggle"
  | "integer"
  | "number"
  | "select"
  | "multi-select"
  | "text"
  | "reference"
  | "json"

export type SettingsPaletteFieldTarget = "config-only" | "config-and-run" | "run-only"

export interface SettingsPaletteFieldVisibility {
  readonly fieldId: string
  readonly values: readonly (string | number | boolean | null)[]
}

export interface SettingsPaletteField {
  readonly id: string
  readonly label: string
  readonly category: string
  readonly kind: SettingsPaletteFieldKind
  readonly help: string
  readonly impact: string
  readonly target: SettingsPaletteFieldTarget
  readonly required: boolean
  readonly secret: boolean
  /** Secret-bearing fields and unsupported host fields are never editable. */
  readonly editable: boolean
  readonly configPath?: string
  readonly cliFlag?: string
  readonly choices?: readonly string[]
  readonly minimum?: number
  readonly maximum?: number
  readonly visibleWhen?: SettingsPaletteFieldVisibility
}

export interface SettingsPaletteFieldState {
  readonly field: SettingsPaletteField
  /** Omitted whenever `masked` is true. */
  readonly value?: SettingsPaletteJsonValue
  readonly displayValue: string
  readonly masked: boolean
  readonly changed: boolean
  readonly source: string
  readonly sourceRef?: string
}

export interface SettingsPaletteSnapshot {
  readonly schemaVersion: 1
  readonly mode: SettingsPaletteMode
  readonly draftRevision: number
  readonly fields: readonly SettingsPaletteFieldState[]
  readonly changedFieldIds: readonly string[]
}

export interface SettingsPalettePreviewEntry {
  readonly fieldId: string
  /** Omitted whenever `masked` is true. */
  readonly value?: SettingsPaletteJsonValue
  readonly displayValue: string
  readonly masked: boolean
  readonly configPath?: string
  readonly configCommand?: string
  readonly runArguments: readonly string[]
  readonly runOverrideAvailable: boolean
}

export interface SettingsPalettePreview {
  readonly schemaVersion: 1
  readonly mode: SettingsPaletteMode
  readonly scope: SettingsPaletteScope
  readonly draftRevision: number
  readonly entries: readonly SettingsPalettePreviewEntry[]
  readonly configCommands: readonly string[]
  readonly runArguments: readonly string[]
  readonly runCommand: string
  readonly applyForRunAvailable: boolean
  readonly applyForRunUnavailableReason?: string
  /** Saving defaults never rewrites a persisted run. */
  readonly saveEffect: "future-runs-only"
}

export type SettingsPaletteUpdateRequest = {
  readonly fieldId: string
  readonly expectedRevision: number
} & (
  | { readonly input: "value"; readonly value: SettingsPaletteJsonValue }
  | { readonly input: "text"; readonly text: string }
)

export interface SettingsPaletteRevisionRequest {
  readonly expectedRevision: number
}

export interface SettingsPalettePreviewRequest extends SettingsPaletteRevisionRequest {
  readonly scope: SettingsPaletteScope
}

export interface SettingsPaletteSaveRequest extends SettingsPalettePreviewRequest {}

export interface SettingsPaletteSaveResponse<TResult> {
  readonly effect: "future-runs-only"
  readonly snapshot: SettingsPaletteSnapshot
  readonly result: TResult
}

/**
 * Host-owned boundary used by a mutable settings popup. The host is responsible
 * for schema validation, optimistic revision checks, atomic writes, and secret
 * redaction. Applying a draft returns data for a not-yet-persisted run only.
 */
export interface SettingsPalettePort<TApplyResult = unknown, TSaveResult = unknown> {
  load(): Promise<SettingsPaletteSnapshot>
  update(request: SettingsPaletteUpdateRequest): Promise<SettingsPaletteSnapshot>
  preview(request: SettingsPalettePreviewRequest): Promise<SettingsPalettePreview>
  applyForRun(request: SettingsPaletteRevisionRequest): Promise<TApplyResult>
  saveDefaults(
    request: SettingsPaletteSaveRequest,
  ): Promise<SettingsPaletteSaveResponse<TSaveResult>>
}

export interface SettingsPaletteViewState {
  readonly open: boolean
  readonly status: SettingsPaletteStatus
  readonly scope: SettingsPaletteScope
  readonly query: string
  readonly category?: string | undefined
  readonly selectedFieldId?: string | undefined
  readonly snapshot?: SettingsPaletteSnapshot | undefined
  readonly preview?: SettingsPalettePreview | undefined
  readonly notice?: string | undefined
  readonly error?: string | undefined
}

export const SETTINGS_PALETTE_MASK = "********"

export function formatSettingsPaletteValue(value: SettingsPaletteJsonValue | undefined): string {
  if (value === undefined) return "not set"
  if (typeof value === "string") return value
  if (value === null) return "null"
  return JSON.stringify(value)
}

export function visibleSettingsPaletteFields(
  state: Pick<SettingsPaletteViewState, "query" | "category" | "snapshot">,
): readonly SettingsPaletteFieldState[] {
  const query = state.query.trim().toLocaleLowerCase("und")
  const fieldStates = new Map(
    (state.snapshot?.fields ?? []).map((entry) => [entry.field.id, entry] as const),
  )
  return (state.snapshot?.fields ?? []).filter((entry) => {
    const visibility = entry.field.visibleWhen
    if (visibility) {
      const dependency = fieldStates.get(visibility.fieldId)
      if (
        !dependency ||
        dependency.masked ||
        !visibility.values.some((value) => Object.is(value, dependency.value))
      ) {
        return false
      }
    }
    if (state.category && entry.field.category !== state.category) return false
    if (!query) return true
    const searchText = [
      entry.field.id,
      entry.field.label,
      entry.field.category,
      entry.field.help,
      entry.field.impact,
      entry.field.configPath ?? "",
      entry.masked ? SETTINGS_PALETTE_MASK : entry.displayValue,
    ]
      .join("\n")
      .toLocaleLowerCase("und")
    return searchText.includes(query)
  })
}

export function settingsPaletteCategories(
  snapshot: SettingsPaletteSnapshot | undefined,
): readonly string[] {
  return [...new Set((snapshot?.fields ?? []).map((entry) => entry.field.category))].sort((a, b) =>
    a.localeCompare(b),
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Settings operation failed"
}

type SettingsPaletteListener = (state: SettingsPaletteViewState) => void
type SettingsPalettePendingUpdate = { readonly fieldId: string } & (
  | { readonly input: "value"; readonly value: SettingsPaletteJsonValue }
  | { readonly input: "text"; readonly text: string }
)

/**
 * Small serial controller suitable for Solid signals or another renderer. It
 * prevents overlapping popup mutations while the adapter enforces the durable
 * optimistic revision boundary.
 */
export class SettingsPaletteController<TApplyResult = unknown, TSaveResult = unknown> {
  readonly #port: SettingsPalettePort<TApplyResult, TSaveResult>
  readonly #listeners = new Set<SettingsPaletteListener>()
  #pending: Promise<void> = Promise.resolve()
  #state: SettingsPaletteViewState

  constructor(
    port: SettingsPalettePort<TApplyResult, TSaveResult>,
    options: { readonly scope?: SettingsPaletteScope } = {},
  ) {
    this.#port = port
    this.#state = {
      open: false,
      status: "closed",
      scope: options.scope ?? "workspace",
      query: "",
    }
  }

  get state(): SettingsPaletteViewState {
    return this.#state
  }

  subscribe(listener: SettingsPaletteListener): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  #replace(patch: Partial<SettingsPaletteViewState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener(this.#state)
  }

  #enqueue<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.#pending.then(operation, operation)
    this.#pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #revision(): number {
    return this.#state.snapshot?.draftRevision ?? 0
  }

  #failed(error: unknown): never {
    this.#replace({ status: "error", error: errorMessage(error) })
    throw error
  }

  async open(): Promise<SettingsPaletteSnapshot> {
    this.#replace({ open: true })
    return this.reload()
  }

  close(): void {
    this.#replace({ open: false, status: "closed", preview: undefined, error: undefined })
  }

  reload(): Promise<SettingsPaletteSnapshot> {
    return this.#enqueue(async () => {
      this.#replace({ status: "loading", error: undefined, notice: undefined })
      try {
        const snapshot = await this.#port.load()
        this.#replace({ status: "ready", snapshot, preview: undefined })
        return snapshot
      } catch (error) {
        return this.#failed(error)
      }
    })
  }

  setQuery(query: string): void {
    this.#replace({ query })
  }

  setCategory(category?: string): void {
    this.#replace({ category })
  }

  select(fieldId?: string): void {
    this.#replace({ selectedFieldId: fieldId })
  }

  setScope(scope: SettingsPaletteScope): void {
    this.#replace({ scope, preview: undefined, notice: undefined })
  }

  updateValue(fieldId: string, value: SettingsPaletteJsonValue): Promise<SettingsPaletteSnapshot> {
    return this.#update({ fieldId, input: "value", value })
  }

  updateText(fieldId: string, text: string): Promise<SettingsPaletteSnapshot> {
    return this.#update({ fieldId, input: "text", text })
  }

  #update(request: SettingsPalettePendingUpdate): Promise<SettingsPaletteSnapshot> {
    return this.#enqueue(async () => {
      this.#replace({ status: "updating", error: undefined, notice: undefined })
      try {
        const expectedRevision = this.#revision()
        const mutation: SettingsPaletteUpdateRequest =
          request.input === "value"
            ? { fieldId: request.fieldId, expectedRevision, input: "value", value: request.value }
            : { fieldId: request.fieldId, expectedRevision, input: "text", text: request.text }
        const snapshot = await this.#port.update(mutation)
        this.#replace({ status: "ready", snapshot, preview: undefined })
        return snapshot
      } catch (error) {
        return this.#failed(error)
      }
    })
  }

  preview(): Promise<SettingsPalettePreview> {
    return this.#enqueue(async () => {
      this.#replace({ status: "previewing", error: undefined, notice: undefined })
      try {
        const preview = await this.#port.preview({
          scope: this.#state.scope,
          expectedRevision: this.#revision(),
        })
        this.#replace({ status: "ready", preview })
        return preview
      } catch (error) {
        return this.#failed(error)
      }
    })
  }

  applyForRun(): Promise<TApplyResult> {
    return this.#enqueue(async () => {
      this.#replace({ status: "applying", error: undefined, notice: undefined })
      try {
        const result = await this.#port.applyForRun({ expectedRevision: this.#revision() })
        this.#replace({ status: "ready", notice: "Draft is ready for the new run." })
        return result
      } catch (error) {
        return this.#failed(error)
      }
    })
  }

  saveDefaults(scope: SettingsPaletteScope = this.#state.scope): Promise<TSaveResult> {
    return this.#enqueue(async () => {
      this.#replace({ status: "saving", error: undefined, notice: undefined })
      try {
        const response = await this.#port.saveDefaults({
          scope,
          expectedRevision: this.#revision(),
        })
        this.#replace({
          status: "ready",
          scope,
          snapshot: response.snapshot,
          preview: undefined,
          notice: `Defaults saved for ${scope}; persisted runs were not changed.`,
        })
        return response.result
      } catch (error) {
        return this.#failed(error)
      }
    })
  }
}

export function createSettingsPaletteController<TApplyResult = unknown, TSaveResult = unknown>(
  port: SettingsPalettePort<TApplyResult, TSaveResult>,
  options: { readonly scope?: SettingsPaletteScope } = {},
): SettingsPaletteController<TApplyResult, TSaveResult> {
  return new SettingsPaletteController(port, options)
}
