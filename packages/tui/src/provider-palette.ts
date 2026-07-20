/**
 * Renderer-neutral provider/model/auth selector. The concrete CLI owns catalog
 * pinning, credential/profile mutations, and the revisioned run draft; this
 * package only projects safe metadata and serializes explicit user actions.
 */

export type ProviderPaletteTab = "providers" | "models" | "auth" | "profile"
export type ProviderPaletteStatus = "closed" | "loading" | "ready" | "mutating" | "error"
export type ProviderPaletteRole = "executor" | "judge"
export type ProviderPaletteMode = "pre-run" | "attach" | "replay"
export type ProviderPaletteScope = "workspace" | "global"

export interface ProviderPaletteAuthMethod {
  readonly method: string
  readonly label: string
  readonly access: readonly string[]
  readonly interactive: boolean
  readonly tuiConnectSupported: boolean
  readonly unsupportedReason?: string
  readonly cliCommand: string
}

export interface ProviderPaletteProvider {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly access: readonly string[]
  readonly catalogSource: string
  readonly catalogUpdatedAt: string
  readonly authMethods: readonly ProviderPaletteAuthMethod[]
}

export interface ProviderPaletteModel {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly family?: string
  readonly status: string
  readonly access: readonly string[]
  readonly capabilities: {
    readonly input: readonly string[]
    readonly tools: boolean
    readonly toolStreaming: boolean
    readonly reasoning: boolean
    readonly structuredOutput: boolean
    readonly usage: readonly string[]
  }
  readonly limits: {
    readonly context?: number
    readonly output?: number
  }
  readonly variants: readonly { readonly id: string; readonly name: string }[]
  readonly price: {
    readonly status: string
    readonly currency?: string
    readonly unit?: string
    readonly source: string
    readonly reason?: string
  }
  readonly cliInspectCommand: string
}

export interface ProviderPaletteCredential {
  readonly id: string
  readonly provider: string
  readonly method: string
  readonly store: string
  readonly label: string
  readonly accountHint?: string
  readonly expiresAt?: string
  readonly status: string
  readonly cliRevokeCommand: string
}

export type ProviderPaletteProfileFieldMode = "inherit" | "set" | "clear"

export interface ProviderPaletteProfileField {
  readonly id: string
  readonly label: string
  readonly kind:
    | "select"
    | "text"
    | "reference"
    | "multi-select"
    | "toggle"
    | "integer"
    | "number"
    | "json"
  readonly configPath: string
  readonly cliFlag: string
  readonly required: boolean
  readonly editable: boolean
  readonly choices?: readonly string[]
  readonly help: string
}

export interface ProviderPaletteProfileFieldState {
  readonly field: ProviderPaletteProfileField
  readonly mode: ProviderPaletteProfileFieldMode
  readonly displayValue: string
  readonly source: string
  readonly visible: boolean
}

export interface ProviderPaletteProfileForm {
  readonly schemaVersion: 1
  readonly revision: number
  readonly profileId: string
  readonly role: ProviderPaletteRole
  readonly scope: ProviderPaletteScope
  readonly setDefault: boolean
  readonly valid: boolean
  readonly issues: readonly string[]
  readonly fields: readonly ProviderPaletteProfileFieldState[]
}

export interface ProviderPaletteSnapshot {
  readonly schemaVersion: 1
  readonly catalogSnapshotId: string
  readonly catalogOrigin: string
  readonly catalogStale: boolean
  readonly providers: readonly ProviderPaletteProvider[]
  readonly models: readonly ProviderPaletteModel[]
  readonly credentials: readonly ProviderPaletteCredential[]
  readonly roleProfiles: Readonly<
    Record<
      ProviderPaletteRole,
      {
        readonly id: string
        readonly configured: boolean
        readonly route?: {
          readonly provider: string
          readonly model: string
          readonly credentialId?: string
        }
        readonly forms: Readonly<Record<ProviderPaletteScope, ProviderPaletteProfileForm>>
      }
    >
  >
}

export interface ProviderPaletteConnectRequest {
  readonly provider: string
  readonly method: string
  /** Ephemeral input; controller state and operation messages never retain it. */
  readonly input:
    | { readonly kind: "none" }
    | { readonly kind: "api-key"; readonly secret: ProviderPaletteSecretInput }
    | { readonly kind: "environment"; readonly variable: string }
}

/** Structural one-shot secret compatible with the command-owned credential boundary. */
export interface ProviderPaletteSecretInput {
  readOnce(): Promise<string>
  clear(): void
  toJSON(): string
}

export function createProviderPaletteSecretInput(value: string): ProviderPaletteSecretInput {
  let pending: string | undefined = value
  return {
    async readOnce() {
      const secret = pending
      pending = undefined
      if (secret === undefined) throw new Error("Secret input has already been consumed")
      return secret
    },
    clear() {
      pending = undefined
    },
    toJSON() {
      return "[REDACTED]"
    },
  }
}

export interface ProviderPalettePort {
  load(options: {
    readonly refresh: boolean
    readonly resetProfileDrafts?: boolean
  }): Promise<ProviderPaletteSnapshot>
  connect(request: ProviderPaletteConnectRequest): Promise<ProviderPaletteCredential>
  revoke(request: { readonly credentialId: string }): Promise<void>
  /** Applies only to an unpersisted invocation draft; the host owns validation and revision CAS. */
  applyForRun?(request: ProviderPaletteSelection): Promise<ProviderPaletteApplyResult>
  /** Persists a future default through the host's shared profile/settings command handlers. */
  saveDefault?(
    request: ProviderPaletteSelection & {
      readonly scope: ProviderPaletteScope
    },
  ): Promise<ProviderPaletteSaveResult>
  updateProfile?(request: {
    readonly role: ProviderPaletteRole
    readonly scope: ProviderPaletteScope
    readonly expectedRevision: number
    readonly fieldId: string
    readonly action: "set" | "clear" | "inherit" | "cycle"
    readonly text?: string
    readonly direction?: -1 | 1
  }): Promise<ProviderPaletteProfileForm>
  saveProfile?(request: {
    readonly role: ProviderPaletteRole
    readonly scope: ProviderPaletteScope
    readonly expectedRevision: number
  }): Promise<ProviderPaletteSaveResult>
}

export interface ProviderPaletteSelection {
  readonly role: ProviderPaletteRole
  readonly provider: string
  readonly model: string
  /**
   * Credential material is forbidden here; this is a non-secret reference ID
   * only. Absence is an explicit "no credential" selection, never "inherit".
   * Because this palette selects only provider/model routes, applying or saving
   * the selection also clears any prior variant and model parameters.
   */
  readonly credentialId?: string
}

export interface ProviderPaletteApplyResult {
  readonly effect: "new-run-draft-only"
  readonly role: ProviderPaletteRole
  readonly profileId: string
  readonly message: string
  /** Opaque shared-settings result passed back to the pre-run host. */
  readonly result: unknown
}

export interface ProviderPaletteSaveResult {
  readonly effect: "future-runs-only"
  readonly role: ProviderPaletteRole
  readonly scope: ProviderPaletteScope
  readonly profileId: string
  readonly message: string
}

export interface ProviderPaletteOperation {
  readonly kind: "connect" | "revoke" | "apply" | "save" | "profile-update"
  readonly status: "pending" | "succeeded" | "failed"
  readonly role?: ProviderPaletteRole
  readonly scope?: ProviderPaletteScope
  readonly profileId?: string
  readonly provider?: string
  readonly method?: string
  readonly credentialId?: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly message: string
}

export interface ProviderPaletteViewState {
  readonly open: boolean
  readonly status: ProviderPaletteStatus
  readonly mode: ProviderPaletteMode
  readonly role: ProviderPaletteRole
  readonly scope: ProviderPaletteScope
  readonly tab: ProviderPaletteTab
  readonly query: string
  readonly selectedProviderId?: string | undefined
  readonly selectedModelKey?: string | undefined
  readonly selectedCredentialId?: string | undefined
  readonly selectedAuthMethodIndex: number
  readonly selectedProfileFieldId?: string | undefined
  readonly snapshot?: ProviderPaletteSnapshot | undefined
  readonly operation?: ProviderPaletteOperation | undefined
  readonly error?: string | undefined
}

type Listener = (state: ProviderPaletteViewState) => void

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.slice(0, 1_000)
    : "Provider/auth operation failed"
}

export class ProviderPaletteController {
  readonly #port: ProviderPalettePort
  readonly #listeners = new Set<Listener>()
  readonly #pendingSecretInputs = new Set<ProviderPaletteSecretInput>()
  #pending: Promise<void> = Promise.resolve()
  #lifecycle = 0
  #disposed = false
  #state: ProviderPaletteViewState = {
    open: false,
    status: "closed",
    mode: "attach",
    role: "executor",
    scope: "workspace",
    tab: "providers",
    query: "",
    selectedAuthMethodIndex: 0,
  }

  constructor(
    port: ProviderPalettePort,
    options: {
      readonly mode?: ProviderPaletteMode
      readonly role?: ProviderPaletteRole
      readonly scope?: ProviderPaletteScope
    } = {},
  ) {
    this.#port = port
    this.#state = {
      ...this.#state,
      mode: options.mode ?? "attach",
      role: options.role ?? "executor",
      scope: options.scope ?? "workspace",
    }
  }

  get state(): ProviderPaletteViewState {
    return this.#state
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    listener(this.#state)
    return () => this.#listeners.delete(listener)
  }

  #replace(patch: Partial<ProviderPaletteViewState>): void {
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

  #connectLifecycleActive(lifecycle: number): boolean {
    return !this.#disposed && this.#state.open && lifecycle === this.#lifecycle
  }

  #closedConnectError(): Error {
    return new Error("Provider connection was cancelled because the palette was closed")
  }

  #clearPendingSecretInputs(): void {
    for (const secret of this.#pendingSecretInputs) secret.clear()
    this.#pendingSecretInputs.clear()
  }

  async open(): Promise<ProviderPaletteSnapshot> {
    if (this.#disposed) throw new Error("Provider palette has been disposed")
    if (this.#state.open) return this.reload(false)
    // A new popup lifecycle must hydrate from the currently effective role
    // route. Keeping the prior snapshot here would make reload preserve an
    // abandoned selection and hide profile/default changes made while closed.
    this.#replace({
      open: true,
      snapshot: undefined,
      selectedProviderId: undefined,
      selectedModelKey: undefined,
      selectedCredentialId: undefined,
      selectedAuthMethodIndex: 0,
      operation: undefined,
      error: undefined,
    })
    return this.reload(false, true)
  }

  close(): void {
    this.#lifecycle += 1
    this.#clearPendingSecretInputs()
    this.#replace({ open: false, status: "closed", query: "", error: undefined })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    try {
      this.close()
    } finally {
      this.#listeners.clear()
    }
  }

  reload(refresh: boolean, resetProfileDrafts = false): Promise<ProviderPaletteSnapshot> {
    const lifecycle = this.#lifecycle
    return this.#enqueue(async () => {
      try {
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        this.#replace({ status: "loading", error: undefined })
        const hadSnapshot = this.#state.snapshot !== undefined
        const snapshot = await this.#port.load({ refresh, resetProfileDrafts })
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        const configuredRoute = snapshot.roleProfiles[this.#state.role].route
        const configuredModel = configuredRoute
          ? snapshot.models.find(
              (model) =>
                model.provider === configuredRoute.provider && model.id === configuredRoute.model,
            )
          : undefined
        const selectedModel = hadSnapshot
          ? snapshot.models.find(
              (model) => `${model.provider}/${model.id}` === this.#state.selectedModelKey,
            )
          : configuredModel
        const selectedProviderId =
          selectedModel?.provider ??
          (snapshot.providers.some((provider) => provider.id === this.#state.selectedProviderId)
            ? this.#state.selectedProviderId
            : snapshot.providers[0]?.id)
        const coherentModel =
          selectedModel ??
          snapshot.models.find((model) => model.provider === selectedProviderId) ??
          snapshot.models[0]
        const selectedModelKey = coherentModel
          ? `${coherentModel.provider}/${coherentModel.id}`
          : undefined
        const currentCredential = snapshot.credentials.find(
          (credential) => credential.id === this.#state.selectedCredentialId,
        )
        const configuredCredential = configuredRoute?.credentialId
          ? snapshot.credentials.find(
              (credential) => credential.id === configuredRoute.credentialId,
            )
          : undefined
        const selectedCredentialId =
          !hadSnapshot && configuredRoute
            ? configuredCredential && configuredCredential.provider === coherentModel?.provider
              ? configuredCredential.id
              : undefined
            : currentCredential && currentCredential.provider === coherentModel?.provider
              ? currentCredential.id
              : hadSnapshot && this.#state.selectedCredentialId === undefined
                ? undefined
                : snapshot.credentials.find(
                    (credential) => credential.provider === coherentModel?.provider,
                  )?.id
        const profileFields =
          snapshot.roleProfiles[this.#state.role].forms[this.#state.scope].fields
        const selectedProfileFieldId = profileFields.some(
          (entry) => entry.visible && entry.field.id === this.#state.selectedProfileFieldId,
        )
          ? this.#state.selectedProfileFieldId
          : profileFields.find((entry) => entry.visible)?.field.id
        this.#replace({
          status: "ready",
          snapshot,
          selectedProviderId,
          selectedModelKey,
          selectedCredentialId,
          selectedProfileFieldId,
        })
        return snapshot
      } catch (error) {
        if (this.#connectLifecycleActive(lifecycle)) {
          this.#replace({ status: "error", error: errorMessage(error) })
        }
        throw error
      }
    })
  }

  setTab(tab: ProviderPaletteTab): void {
    const firstProfileField = this.#state.snapshot?.roleProfiles[this.#state.role].forms[
      this.#state.scope
    ].fields.find((entry) => entry.visible)?.field.id
    this.#replace({
      tab,
      query: "",
      selectedAuthMethodIndex: 0,
      ...(tab === "profile" && !this.#state.selectedProfileFieldId
        ? { selectedProfileFieldId: firstProfileField }
        : {}),
    })
  }

  setQuery(query: string): void {
    this.#replace({ query })
  }

  setRole(role: ProviderPaletteRole): void {
    const snapshot = this.#state.snapshot
    const route = snapshot?.roleProfiles[role].route
    const model = route
      ? snapshot?.models.find(
          (candidate) => candidate.provider === route.provider && candidate.id === route.model,
        )
      : undefined
    const selectedModel = model ?? snapshot?.models[0]
    const credential = route?.credentialId
      ? snapshot?.credentials.find(
          (candidate) =>
            candidate.id === route.credentialId && candidate.provider === selectedModel?.provider,
        )
      : undefined
    const selectedProfileFieldId = snapshot?.roleProfiles[role].forms[
      this.#state.scope
    ].fields.find((entry) => entry.visible)?.field.id
    this.#replace({
      role,
      selectedProviderId: selectedModel?.provider,
      selectedModelKey: selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined,
      selectedCredentialId: credential?.id,
      selectedProfileFieldId,
      error: undefined,
    })
  }

  setScope(scope: ProviderPaletteScope): void {
    const selectedProfileFieldId = this.#state.snapshot?.roleProfiles[this.#state.role].forms[
      scope
    ].fields.find((entry) => entry.visible)?.field.id
    this.#replace({ scope, selectedProfileFieldId, error: undefined })
  }

  selectProvider(id: string): void {
    const model = this.#state.snapshot?.models.find((candidate) => candidate.provider === id)
    const currentCredential = this.#state.snapshot?.credentials.find(
      (credential) => credential.id === this.#state.selectedCredentialId,
    )
    const credentialId =
      this.#state.selectedCredentialId === undefined
        ? undefined
        : currentCredential?.provider === id
          ? currentCredential.id
          : this.#state.snapshot?.credentials.find((credential) => credential.provider === id)?.id
    this.#replace({
      selectedProviderId: id,
      selectedModelKey: model ? `${model.provider}/${model.id}` : undefined,
      selectedCredentialId: credentialId,
      selectedAuthMethodIndex: 0,
      error: undefined,
    })
  }

  selectModel(key: string): void {
    const model = this.#state.snapshot?.models.find(
      (candidate) => `${candidate.provider}/${candidate.id}` === key,
    )
    const currentCredential = this.#state.snapshot?.credentials.find(
      (credential) => credential.id === this.#state.selectedCredentialId,
    )
    const credentialId =
      this.#state.selectedCredentialId === undefined
        ? undefined
        : currentCredential && currentCredential.provider === model?.provider
          ? currentCredential.id
          : this.#state.snapshot?.credentials.find(
              (credential) => credential.provider === model?.provider,
            )?.id
    this.#replace({
      selectedModelKey: key,
      ...(model ? { selectedProviderId: model.provider } : {}),
      selectedCredentialId: credentialId,
      selectedAuthMethodIndex: 0,
      error: undefined,
    })
  }

  selectCredential(id: string): void {
    const credential = this.#state.snapshot?.credentials.find((candidate) => candidate.id === id)
    this.#replace({ selectedCredentialId: id, error: undefined })
    if (!credential) return
    const currentModel = this.#state.snapshot?.models.find(
      (model) => `${model.provider}/${model.id}` === this.#state.selectedModelKey,
    )
    if (currentModel?.provider === credential.provider) return
    const model = this.#state.snapshot?.models.find(
      (candidate) => candidate.provider === credential.provider,
    )
    this.#replace({
      selectedProviderId: credential.provider,
      selectedModelKey: model ? `${model.provider}/${model.id}` : undefined,
      selectedAuthMethodIndex: 0,
    })
  }

  clearCredentialSelection(): void {
    this.#replace({ selectedCredentialId: undefined, error: undefined })
  }

  selectAuthMethod(index: number): void {
    const provider = this.#state.snapshot?.providers.find(
      (item) => item.id === this.#state.selectedProviderId,
    )
    const count = provider?.authMethods.length ?? 0
    this.#replace({
      selectedAuthMethodIndex: count === 0 ? 0 : (Math.max(0, Math.floor(index)) + count) % count,
    })
  }

  #activeProfileForm(): ProviderPaletteProfileForm {
    const form = this.#state.snapshot?.roleProfiles[this.#state.role].forms[this.#state.scope]
    if (!form) throw new Error("The role-profile layer form is unavailable")
    return form
  }

  #replaceProfileForm(form: ProviderPaletteProfileForm): void {
    const snapshot = this.#state.snapshot
    if (!snapshot) return
    this.#replace({
      snapshot: {
        ...snapshot,
        roleProfiles: {
          ...snapshot.roleProfiles,
          [form.role]: {
            ...snapshot.roleProfiles[form.role],
            forms: {
              ...snapshot.roleProfiles[form.role].forms,
              [form.scope]: form,
            },
          },
        },
      },
    })
  }

  selectProfileField(fieldId: string): void {
    const field = this.#activeProfileForm().fields.find(
      (entry) => entry.visible && entry.field.id === fieldId,
    )
    if (!field) return
    this.#replace({ selectedProfileFieldId: fieldId, error: undefined })
  }

  updateProfileField(
    action: "set" | "clear" | "inherit" | "cycle",
    options: { readonly text?: string; readonly direction?: -1 | 1 } = {},
  ): Promise<ProviderPaletteProfileForm> {
    const form = this.#activeProfileForm()
    const field = form.fields.find(
      (entry) => entry.visible && entry.field.id === this.#state.selectedProfileFieldId,
    )
    if (!field) return Promise.reject(new Error("Select a visible profile field"))
    if (!field.field.editable) {
      return Promise.reject(new Error(`${field.field.label} is controlled by the role/scope keys`))
    }
    const updateProfile = this.#port.updateProfile
    if (!updateProfile) {
      return Promise.reject(new Error("Role-profile layer editing is unavailable"))
    }
    const role = this.#state.role
    const scope = this.#state.scope
    const lifecycle = this.#lifecycle
    const startedAt = new Date().toISOString()
    return this.#enqueue(async () => {
      try {
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        this.#replace({ status: "mutating", error: undefined })
        const updated = await updateProfile({
          role,
          scope,
          expectedRevision: form.revision,
          fieldId: field.field.id,
          action,
          ...(options.text !== undefined ? { text: options.text } : {}),
          ...(options.direction !== undefined ? { direction: options.direction } : {}),
        })
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        this.#replaceProfileForm(updated)
        this.#replace({
          status: "ready",
          operation: {
            kind: "profile-update",
            status: "succeeded",
            role: updated.role,
            scope: updated.scope,
            profileId: updated.profileId,
            startedAt,
            finishedAt: new Date().toISOString(),
            message: `${field.field.label} is now ${action}.`,
          },
        })
        return updated
      } catch (error) {
        if (this.#connectLifecycleActive(lifecycle)) {
          this.#replace({
            status: "error",
            error: errorMessage(error),
            operation: {
              kind: "profile-update",
              status: "failed",
              role,
              scope,
              profileId: form.profileId,
              startedAt,
              finishedAt: new Date().toISOString(),
              message: errorMessage(error),
            },
          })
        }
        throw error
      }
    })
  }

  connectSelected(
    input: ProviderPaletteConnectRequest["input"] = { kind: "none" },
  ): Promise<ProviderPaletteCredential> {
    const secretInput = input.kind === "api-key" ? input.secret : undefined
    if (this.#disposed || !this.#state.open) {
      secretInput?.clear()
      return Promise.reject(this.#closedConnectError())
    }
    const provider = this.#state.snapshot?.providers.find(
      (item) => item.id === this.#state.selectedProviderId,
    )
    const method = provider?.authMethods[this.#state.selectedAuthMethodIndex]
    if (!provider || !method) {
      secretInput?.clear()
      const error = new Error("Select a provider and authentication method")
      this.#replace({ status: "error", error: error.message })
      return Promise.reject(error)
    }
    const lifecycle = this.#lifecycle
    const startedAt = new Date().toISOString()
    if (secretInput) this.#pendingSecretInputs.add(secretInput)
    return this.#enqueue(async () => {
      const clearSecretInput = () => {
        if (!secretInput) return
        secretInput.clear()
        this.#pendingSecretInputs.delete(secretInput)
      }
      try {
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        if (!method.tuiConnectSupported) {
          const error = new Error(method.unsupportedReason ?? `Use the CLI: ${method.cliCommand}`)
          this.#replace({ status: "error", error: error.message })
          throw error
        }
        if (method.method === "api-key" && input.kind !== "api-key") {
          const error = new Error("Enter the API key in the masked TUI input")
          this.#replace({ status: "error", error: error.message })
          throw error
        }
        if (method.method === "environment" && input.kind !== "environment") {
          const error = new Error("Enter the environment variable name")
          this.#replace({ status: "error", error: error.message })
          throw error
        }
        if (
          method.method !== "api-key" &&
          method.method !== "environment" &&
          input.kind !== "none"
        ) {
          const error = new Error("The selected authentication method does not accept text input")
          this.#replace({ status: "error", error: error.message })
          throw error
        }
        this.#replace({
          status: "mutating",
          error: undefined,
          operation: {
            kind: "connect",
            status: "pending",
            provider: provider.id,
            method: method.method,
            startedAt,
            message:
              method.method === "api-key"
                ? "Secure API-key connection is active; the value is never displayed or persisted in TUI state."
                : method.method === "environment"
                  ? "Environment credential connection is active; only the variable name is retained."
                  : method.method === "oauth-browser" || method.method === "device-code"
                    ? "OAuth authorization is active; complete the browser/device flow. Tokens are never shown."
                    : "Credential connection is active.",
          },
        })
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        try {
          const credential = await this.#port.connect({
            provider: provider.id,
            method: method.method,
            input,
          })
          if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
          const snapshot = await this.#port.load({ refresh: false })
          if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
          this.#replace({
            status: "ready",
            snapshot,
            selectedCredentialId: credential.id,
            operation: {
              kind: "connect",
              status: "succeeded",
              provider: provider.id,
              method: method.method,
              credentialId: credential.id,
              startedAt,
              finishedAt: new Date().toISOString(),
              message: `Credential ${credential.id} connected.`,
            },
          })
          return credential
        } catch (error) {
          if (this.#connectLifecycleActive(lifecycle)) {
            this.#replace({
              status: "error",
              error: errorMessage(error),
              operation: {
                kind: "connect",
                status: "failed",
                provider: provider.id,
                method: method.method,
                startedAt,
                finishedAt: new Date().toISOString(),
                message: errorMessage(error),
              },
            })
          }
          throw error
        }
      } finally {
        clearSecretInput()
      }
    })
  }

  revokeSelected(): Promise<void> {
    const credential = this.#state.snapshot?.credentials.find(
      (item) => item.id === this.#state.selectedCredentialId,
    )
    if (!credential) return Promise.reject(new Error("Select a credential to revoke"))
    const lifecycle = this.#lifecycle
    const startedAt = new Date().toISOString()
    return this.#enqueue(async () => {
      if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
      this.#replace({
        status: "mutating",
        error: undefined,
        operation: {
          kind: "revoke",
          status: "pending",
          credentialId: credential.id,
          provider: credential.provider,
          startedAt,
          message: `Revoking ${credential.id}.`,
        },
      })
      try {
        await this.#port.revoke({ credentialId: credential.id })
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        const snapshot = await this.#port.load({ refresh: false })
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        this.#replace({
          status: "ready",
          snapshot,
          // Revocation deterministically leaves the route without a credential;
          // choosing a replacement is a separate explicit user action.
          selectedCredentialId: undefined,
          operation: {
            kind: "revoke",
            status: "succeeded",
            credentialId: credential.id,
            provider: credential.provider,
            startedAt,
            finishedAt: new Date().toISOString(),
            message: `Credential ${credential.id} revoked.`,
          },
        })
      } catch (error) {
        if (this.#connectLifecycleActive(lifecycle)) {
          this.#replace({
            status: "error",
            error: errorMessage(error),
            operation: {
              kind: "revoke",
              status: "failed",
              credentialId: credential.id,
              provider: credential.provider,
              startedAt,
              finishedAt: new Date().toISOString(),
              message: errorMessage(error),
            },
          })
        }
        throw error
      }
    })
  }

  #selectedRoute(): ProviderPaletteSelection {
    const provider = this.#state.snapshot?.providers.find(
      (candidate) => candidate.id === this.#state.selectedProviderId,
    )
    const model = this.#state.snapshot?.models.find(
      (candidate) => `${candidate.provider}/${candidate.id}` === this.#state.selectedModelKey,
    )
    const credential = this.#state.selectedCredentialId
      ? this.#state.snapshot?.credentials.find(
          (candidate) => candidate.id === this.#state.selectedCredentialId,
        )
      : undefined
    if (!provider || !model) throw new Error("Select a provider and model before applying")
    if (model.provider !== provider.id) {
      throw new Error("The selected model does not belong to the selected provider")
    }
    if (this.#state.selectedCredentialId && !credential) {
      throw new Error("The selected credential reference is no longer available")
    }
    if (credential && credential.provider !== provider.id) {
      throw new Error("The selected credential belongs to a different provider")
    }
    return {
      role: this.#state.role,
      provider: provider.id,
      model: model.id,
      ...(credential ? { credentialId: credential.id } : {}),
    }
  }

  applySelected(): Promise<ProviderPaletteApplyResult> {
    const selection = this.#selectedRoute()
    const lifecycle = this.#lifecycle
    return this.#enqueue(async () => {
      const startedAt = new Date().toISOString()
      try {
        if (!this.#connectLifecycleActive(lifecycle)) {
          throw new Error("Provider route apply was cancelled because the palette is closed")
        }
        const applyForRun = this.#port.applyForRun
        if (this.#state.mode !== "pre-run" || !applyForRun) {
          throw new Error(
            "Apply for this run is available only before persistence; attach/replay is read-only",
          )
        }
        this.#replace({
          status: "mutating",
          error: undefined,
          operation: {
            kind: "apply",
            status: "pending",
            role: selection.role,
            provider: selection.provider,
            startedAt,
            message: `Applying ${selection.role} route to the unpersisted run draft.`,
          },
        })
        const result = await applyForRun(selection)
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        this.#replace({
          status: "ready",
          operation: {
            kind: "apply",
            status: "succeeded",
            role: result.role,
            profileId: result.profileId,
            provider: selection.provider,
            startedAt,
            finishedAt: new Date().toISOString(),
            message: result.message,
          },
        })
        return result
      } catch (error) {
        if (this.#connectLifecycleActive(lifecycle)) {
          this.#replace({
            status: "error",
            error: errorMessage(error),
            operation: {
              kind: "apply",
              status: "failed",
              role: selection.role,
              startedAt,
              finishedAt: new Date().toISOString(),
              message: errorMessage(error),
            },
          })
        }
        throw error
      }
    })
  }

  saveSelected(
    scope: ProviderPaletteScope = this.#state.scope,
  ): Promise<ProviderPaletteSaveResult> {
    if (this.#state.tab === "profile") return this.#saveActiveProfile(scope)
    const selection = this.#selectedRoute()
    const lifecycle = this.#lifecycle
    return this.#enqueue(async () => {
      const startedAt = new Date().toISOString()
      try {
        if (!this.#connectLifecycleActive(lifecycle)) {
          throw new Error("Provider default save was cancelled because the palette is closed")
        }
        const saveDefault = this.#port.saveDefault
        if (!saveDefault) {
          throw new Error("Role-profile default persistence is unavailable in this TUI composition")
        }
        this.#replace({
          status: "mutating",
          scope,
          error: undefined,
          operation: {
            kind: "save",
            status: "pending",
            role: selection.role,
            scope,
            provider: selection.provider,
            startedAt,
            message: `Saving ${scope} ${selection.role} defaults for future runs.`,
          },
        })
        const result = await saveDefault({ ...selection, scope })
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        const snapshot = await this.#port.load({ refresh: false, resetProfileDrafts: false })
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        this.#replace({
          status: "ready",
          scope,
          snapshot,
          operation: {
            kind: "save",
            status: "succeeded",
            role: result.role,
            scope: result.scope,
            profileId: result.profileId,
            provider: selection.provider,
            startedAt,
            finishedAt: new Date().toISOString(),
            message: result.message,
          },
        })
        return result
      } catch (error) {
        if (this.#connectLifecycleActive(lifecycle)) {
          this.#replace({
            status: "error",
            error: errorMessage(error),
            operation: {
              kind: "save",
              status: "failed",
              role: selection.role,
              scope,
              startedAt,
              finishedAt: new Date().toISOString(),
              message: errorMessage(error),
            },
          })
        }
        throw error
      }
    })
  }

  #saveActiveProfile(scope: ProviderPaletteScope): Promise<ProviderPaletteSaveResult> {
    if (scope !== this.#state.scope) this.setScope(scope)
    const form = this.#activeProfileForm()
    const saveProfile = this.#port.saveProfile
    if (!saveProfile) {
      return Promise.reject(new Error("Role-profile layer persistence is unavailable"))
    }
    const lifecycle = this.#lifecycle
    return this.#enqueue(async () => {
      const startedAt = new Date().toISOString()
      try {
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        if (!form.valid) {
          throw new Error(`Effective profile is invalid: ${form.issues.join("; ")}`)
        }
        this.#replace({
          status: "mutating",
          scope,
          error: undefined,
          operation: {
            kind: "save",
            status: "pending",
            role: form.role,
            scope,
            profileId: form.profileId,
            startedAt,
            message: `Saving the ${scope} ${form.role} profile layer.`,
          },
        })
        const result = await saveProfile({
          role: form.role,
          scope,
          expectedRevision: form.revision,
        })
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        const snapshot = await this.#port.load({ refresh: false, resetProfileDrafts: false })
        if (!this.#connectLifecycleActive(lifecycle)) throw this.#closedConnectError()
        this.#replace({
          status: "ready",
          scope,
          snapshot,
          operation: {
            kind: "save",
            status: "succeeded",
            role: result.role,
            scope: result.scope,
            profileId: result.profileId,
            startedAt,
            finishedAt: new Date().toISOString(),
            message: result.message,
          },
        })
        return result
      } catch (error) {
        if (this.#connectLifecycleActive(lifecycle)) {
          this.#replace({
            status: "error",
            error: errorMessage(error),
            operation: {
              kind: "save",
              status: "failed",
              role: form.role,
              scope,
              profileId: form.profileId,
              startedAt,
              finishedAt: new Date().toISOString(),
              message: errorMessage(error),
            },
          })
        }
        throw error
      }
    })
  }
}

export function createProviderPaletteController(
  port: ProviderPalettePort,
  options: {
    readonly mode?: ProviderPaletteMode
    readonly role?: ProviderPaletteRole
    readonly scope?: ProviderPaletteScope
  } = {},
): ProviderPaletteController {
  return new ProviderPaletteController(port, options)
}
