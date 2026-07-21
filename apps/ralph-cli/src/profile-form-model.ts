import type { ProfileFormRequest, SettingsFieldMetadata } from "@ralph/commands"
import {
  composeRoleProfileConfigLayer,
  inheritRoleProfileConfigLayerPath,
  ProfileParametersSchema,
  type RoleProfileConfig,
  type RoleProfileConfigLayer,
  RoleProfileConfigLayerSchema,
  RoleProfileConfigSchema,
  roleProfileLayerPathSemantics,
} from "@ralph/domain"

export type ProfileFormScope = "global" | "workspace"

export type ProfileFormState = {
  scope: ProfileFormScope
  candidate: Record<string, unknown>
  setDefault: boolean
  /** Exact target layer edited by tri-state forms. */
  profileLayer?: Record<string, unknown>
  /** Complete lower-scope profile over which profileLayer is composed. */
  lowerCandidate?: Record<string, unknown>
  externalCliStash?: Record<string, unknown>
}

const PROFILE_PATH_PREFIX = "profiles.<id>."

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function profileFormFieldPath(field: SettingsFieldMetadata): readonly string[] | undefined {
  return field.configPath.startsWith(PROFILE_PATH_PREFIX)
    ? field.configPath.slice(PROFILE_PATH_PREFIX.length).split(".")
    : undefined
}

function pathValue(source: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = source
  for (const segment of path) {
    const currentRecord = record(current)
    if (!currentRecord) return undefined
    current = currentRecord[segment]
  }
  return current
}

function hasOwnPath(source: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = source
  for (const segment of path) {
    const currentRecord = record(current)
    if (!currentRecord || !Object.hasOwn(currentRecord, segment)) return false
    current = currentRecord[segment]
  }
  return true
}

function setPathValue(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  if (path.length === 0) return
  let current = target
  for (const segment of path.slice(0, -1)) {
    const existing = record(current[segment])
    if (existing) current = existing
    else {
      const created: Record<string, unknown> = {}
      current[segment] = created
      current = created
    }
  }
  const leaf = path[path.length - 1]
  if (!leaf) return
  if (value === undefined) delete current[leaf]
  else current[leaf] = structuredClone(value)
}

function deletePathValue(target: Record<string, unknown>, path: readonly string[]): void {
  if (path.length === 0) return
  const parents: Array<{ parent: Record<string, unknown>; key: string }> = []
  let current = target
  for (const segment of path.slice(0, -1)) {
    const next = record(current[segment])
    if (!next) return
    parents.push({ parent: current, key: segment })
    current = next
  }
  const leaf = path[path.length - 1]
  if (!leaf) return
  delete current[leaf]
  for (const { parent, key } of parents.reverse()) {
    const child = record(parent[key])
    if (child && Object.keys(child).length === 0) delete parent[key]
    else break
  }
}

function externalCliDefaults(): Record<string, unknown> {
  return {
    executable: "",
    args: [],
    cwd: ".",
    environment_refs: {},
    input_mode: "stdin-json",
    adapter: "generic",
    capabilities: {
      streaming: false,
      tool_calling: "unavailable",
      cancellation: false,
      usage: "unavailable",
    },
    mutation_mode: "read-only",
    timeout_ms: 300_000,
    output_limit_bytes: 1_048_576,
  }
}

function ensureExternalCli(candidate: Record<string, unknown>): Record<string, unknown> {
  const existing = record(candidate.external_cli)
  if (existing) return existing
  const created = externalCliDefaults()
  candidate.external_cli = created
  return created
}

function profileCandidateFromLayer(
  lower: Record<string, unknown>,
  layer: Record<string, unknown>,
): Record<string, unknown> {
  const composed = composeRoleProfileConfigLayer(lower, layer)
  const parsed = RoleProfileConfigSchema.safeParse(composed)
  if (parsed.success) return parsed.data as Record<string, unknown>
  // Mirror only defaults supplied by the complete schema. Required route and
  // external-cli leaves stay absent so an incomplete draft remains visibly
  // incomplete instead of borrowing a cosmetic suggestion.
  return {
    ...composed,
    parameters: structuredClone(record(composed.parameters) ?? {}),
    requirements: {
      input: [],
      tools: false,
      tool_streaming: false,
      reasoning: false,
      structured_output: false,
      usage: [],
      access: [],
      ...(record(composed.requirements)
        ? structuredClone(record(composed.requirements) as Record<string, unknown>)
        : {}),
    },
    fallback_profiles: Array.isArray(composed.fallback_profiles)
      ? structuredClone(composed.fallback_profiles)
      : [],
    fallback_on: Array.isArray(composed.fallback_on) ? structuredClone(composed.fallback_on) : [],
    limits: structuredClone(record(composed.limits) ?? {}),
  }
}

function refreshLayerCandidate(state: ProfileFormState): void {
  if (!state.profileLayer || !state.lowerCandidate) return
  state.candidate = profileCandidateFromLayer(state.lowerCandidate, state.profileLayer)
}

export function profileFormCandidate(
  request: ProfileFormRequest,
  scope: ProfileFormScope = request.initialScope ?? "workspace",
): Record<string, unknown> {
  const scoped = request.scopedCandidates?.[scope]
  const existing = scoped ? scoped.existing : request.existing
  const suggested = (scoped ? scoped.suggested : request.suggested) as Record<string, unknown>
  const candidate: Record<string, unknown> = {
    ...(existing ? structuredClone(existing) : {}),
    ...structuredClone(suggested),
    parameters: structuredClone(suggested.parameters ?? existing?.parameters ?? {}),
    requirements: {
      input: [],
      tools: false,
      tool_streaming: false,
      reasoning: false,
      structured_output: false,
      usage: [],
      access: [],
      ...(existing?.requirements ? structuredClone(existing.requirements) : {}),
      ...(record(suggested.requirements)
        ? structuredClone(record(suggested.requirements) as Record<string, unknown>)
        : {}),
    },
    fallback_profiles: structuredClone(
      suggested.fallback_profiles ?? existing?.fallback_profiles ?? [],
    ),
    fallback_on: structuredClone(suggested.fallback_on ?? existing?.fallback_on ?? []),
    limits: structuredClone(suggested.limits ?? existing?.limits ?? {}),
  }
  for (const field of request.clearedFields ?? []) {
    if (field === "parameters") candidate.parameters = {}
    else delete candidate[field]
  }
  if (candidate.backend === "external-cli") ensureExternalCli(candidate)
  if (candidate.backend === "embedded") delete candidate.external_cli
  return candidate
}

export function createProfileFormState(
  request: ProfileFormRequest,
  scope: ProfileFormScope = request.initialScope ?? "workspace",
): ProfileFormState {
  const scopedLayer = request.scopedLayers?.[scope]
  if (scopedLayer) {
    const lowerCandidate = structuredClone(scopedLayer.lowerProfile ?? {}) as Record<
      string,
      unknown
    >
    const profileLayer = structuredClone(scopedLayer.profileLayer ?? {}) as Record<string, unknown>
    return {
      scope,
      candidate: profileCandidateFromLayer(lowerCandidate, profileLayer),
      setDefault: false,
      profileLayer,
      lowerCandidate,
    }
  }
  return {
    scope,
    candidate: profileFormCandidate(request, scope),
    setDefault: false,
  }
}

export function profileFormFieldValue(
  field: SettingsFieldMetadata,
  state: ProfileFormState,
): unknown {
  if (field.id === "scope") return state.scope
  if (field.id === "setDefault") return state.setDefault
  const path = profileFormFieldPath(field)
  return path ? pathValue(state.candidate, path) : undefined
}

export function profileFormFieldVisible(
  field: SettingsFieldMetadata,
  state: ProfileFormState,
  fields: readonly SettingsFieldMetadata[],
): boolean {
  const condition = field.visibleWhen
  if (!condition) return true
  const dependency = fields.find((candidate) => candidate.id === condition.fieldId)
  if (!dependency) return false
  const value = profileFormFieldValue(dependency, state)
  return condition.values.some((candidate) => Object.is(candidate, value))
}

function parsedToggle(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase()
  if (["y", "yes", "true", "1", "on"].includes(normalized)) return true
  if (["n", "no", "false", "0", "off"].includes(normalized)) return false
  return undefined
}

export function decodeProfileFormFieldText(field: SettingsFieldMetadata, text: string): unknown {
  const trimmed = text.trim()
  if (field.kind === "toggle") {
    const value = parsedToggle(trimmed)
    if (value === undefined) throw new Error(`${field.label} requires true or false`)
    return value
  }
  if (field.kind === "integer" || field.kind === "number") {
    const value = Number(trimmed)
    if (!Number.isFinite(value) || (field.kind === "integer" && !Number.isSafeInteger(value))) {
      throw new Error(`${field.label} requires a finite ${field.kind}`)
    }
    if (field.minimum !== undefined && value < field.minimum) {
      throw new Error(`${field.label} must be at least ${field.minimum}`)
    }
    if (field.maximum !== undefined && value > field.maximum) {
      throw new Error(`${field.label} must be at most ${field.maximum}`)
    }
    return value
  }
  if (field.kind === "multi-select") {
    const values = trimmed
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
    if (field.choices && values.some((value) => !field.choices?.includes(value))) {
      throw new Error(`${field.label} contains an unsupported value`)
    }
    return [...new Set(values)]
  }
  if (field.kind === "json") {
    let value: unknown
    try {
      value = JSON.parse(trimmed)
    } catch {
      throw new Error(`${field.label} requires valid JSON`)
    }
    if (field.id === "parameters") {
      const parsed = ProfileParametersSchema.safeParse(value)
      if (!parsed.success) throw new Error(`${field.label} contains invalid model parameters`)
      return parsed.data
    }
    return value
  }
  if (field.choices && !field.choices.includes(trimmed)) {
    throw new Error(`${field.label} requires one of: ${field.choices.join(", ")}`)
  }
  if (trimmed.length === 0 && field.required) throw new Error(`${field.label} is required`)
  return trimmed
}

export function applyProfileFormFieldValue(
  field: SettingsFieldMetadata,
  value: unknown,
  state: ProfileFormState,
): void {
  if (field.id === "scope") {
    if (value !== "global" && value !== "workspace") {
      throw new Error("Profile configuration scope must be global or workspace")
    }
    state.scope = value
    return
  }
  if (field.id === "setDefault") {
    if (typeof value !== "boolean") throw new Error("Set-default must be true or false")
    state.setDefault = value
    return
  }
  const path = profileFormFieldPath(field)
  if (!path) throw new Error(`Unsupported role profile form field: ${field.id}`)

  if (state.profileLayer) {
    setPathValue(state.profileLayer, path, value)
    if (field.id === "backend") {
      if (value === "external-cli") {
        const composed = composeRoleProfileConfigLayer(
          state.lowerCandidate ?? {},
          state.profileLayer,
        )
        if (!record(composed.external_cli)) {
          state.profileLayer.external_cli = externalCliDefaults()
        }
      }
      if (value === "embedded") state.profileLayer.external_cli = null
    }
    if (field.id === "cliAdapter") {
      if (value !== "known-output") {
        setPathValue(state.profileLayer, ["external_cli", "adapter_id"], null)
      } else {
        const externalLayer = record(state.profileLayer.external_cli)
        if (externalLayer?.adapter_id === null) {
          deletePathValue(state.profileLayer, ["external_cli", "adapter_id"])
        }
      }
    }
    if (field.id === "requireToolStreaming" && value === true) {
      setPathValue(state.profileLayer, ["requirements", "tools"], true)
    }
    if (field.id === "requireTools" && value === false) {
      setPathValue(state.profileLayer, ["requirements", "tool_streaming"], false)
    }
    refreshLayerCandidate(state)
    return
  }

  setPathValue(state.candidate, path, value)

  if (field.id === "backend") {
    if (value === "external-cli") {
      if (state.externalCliStash) {
        state.candidate.external_cli = structuredClone(state.externalCliStash)
      } else {
        ensureExternalCli(state.candidate)
      }
    }
    if (value === "embedded") {
      const external = record(state.candidate.external_cli)
      if (external) state.externalCliStash = structuredClone(external)
      delete state.candidate.external_cli
    }
  }
  if (field.id === "cliAdapter" && value !== "known-output") {
    const external = ensureExternalCli(state.candidate)
    delete external.adapter_id
  }
  if (field.id === "requireToolStreaming" && value === true) {
    const requirements = record(state.candidate.requirements) ?? {}
    requirements.tools = true
    state.candidate.requirements = requirements
  }
  if (field.id === "requireTools" && value === false) {
    const requirements = record(state.candidate.requirements) ?? {}
    requirements.tool_streaming = false
    state.candidate.requirements = requirements
  }
}

export function clearProfileFormField(field: SettingsFieldMetadata, state: ProfileFormState): void {
  const requiredButEmptyIsValid = field.id === "cliArgs" || field.id === "cliEnvironmentRefs"
  if (
    (field.required && !requiredButEmptyIsValid) ||
    field.id === "scope" ||
    field.id === "role" ||
    field.id === "backend"
  ) {
    throw new Error(`${field.label} cannot be cleared`)
  }
  const path = profileFormFieldPath(field)
  const emptyValue =
    field.id === "parameters" || field.id === "cliEnvironmentRefs"
      ? {}
      : field.id === "fallbackProfiles" ||
          field.id === "fallbackOn" ||
          field.id === "requireInput" ||
          field.id === "requireUsage" ||
          field.id === "requireAccess" ||
          field.id === "cliArgs"
        ? []
        : field.id === "requireTools" ||
            field.id === "requireStructuredOutput" ||
            field.id === "requireToolStreaming" ||
            field.id === "requireReasoning" ||
            field.id === "setDefault"
          ? false
          : state.profileLayer && path && roleProfileLayerPathSemantics(path) === "tombstone"
            ? null
            : undefined
  applyProfileFormFieldValue(field, emptyValue, state)
}

/** Removes exactly one target-layer override and reveals the lower scope. */
export function inheritProfileFormField(
  field: SettingsFieldMetadata,
  state: ProfileFormState,
): void {
  if (!state.profileLayer) return
  const path = profileFormFieldPath(field)
  if (!path) return
  state.profileLayer = inheritRoleProfileConfigLayerPath(
    state.profileLayer,
    state.lowerCandidate ?? {},
    path,
  )
  refreshLayerCandidate(state)
}

export function profileFormFieldMode(
  field: SettingsFieldMetadata,
  state: ProfileFormState,
): "inherit" | "set" | "clear" {
  const path = profileFormFieldPath(field)
  if (!path || !state.profileLayer || !hasOwnPath(state.profileLayer, path)) return "inherit"
  const value = pathValue(state.profileLayer, path)
  if (value === null && roleProfileLayerPathSemantics(path) === "tombstone") return "clear"
  if (Array.isArray(value) && value.length === 0) return "clear"
  if (
    (field.id === "parameters" || field.id === "cliEnvironmentRefs") &&
    record(value) &&
    Object.keys(record(value) as Record<string, unknown>).length === 0
  ) {
    return "clear"
  }
  // Every path-backed toggle uses the same visible tri-state: absence inherits,
  // true sets the requirement/capability and an explicit false clears it.
  // Pathless setDefault returned above and is not part of profile-layer state.
  if (value === false && field.kind === "toggle") return "clear"
  return "set"
}

export function parseProfileFormLayer(state: ProfileFormState): RoleProfileConfigLayer | undefined {
  if (!state.profileLayer) return undefined
  const parsed = RoleProfileConfigLayerSchema.safeParse(state.profileLayer)
  if (parsed.success) return parsed.data
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`)
    .join("; ")
  throw new Error(`Role profile form produced an invalid target layer: ${details}`)
}

export function parseProfileFormState(state: ProfileFormState): RoleProfileConfig {
  const parsed = RoleProfileConfigSchema.safeParse(state.candidate)
  if (parsed.success) return parsed.data
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`)
    .join("; ")
  throw new Error(`Role profile form produced an invalid profile: ${details}`)
}

export function displayProfileFormValue(value: unknown): string {
  if (value === undefined) return "not set"
  if (Array.isArray(value)) return value.join(",")
  if (typeof value === "boolean") return value ? "true" : "false"
  if (value !== null && typeof value === "object") return JSON.stringify(value)
  return String(value)
}
