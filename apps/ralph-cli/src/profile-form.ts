import { createInterface } from "node:readline/promises"
import {
  inheritableRoleProfileFormField,
  type ProfileFormRequest,
  type ProfileFormResponse,
  type SettingsFieldMetadata,
} from "@ralph-next/commands"
import {
  applyProfileFormFieldValue,
  clearProfileFormField,
  createProfileFormState,
  decodeProfileFormFieldText,
  displayProfileFormValue,
  inheritProfileFormField,
  parseProfileFormLayer,
  parseProfileFormState,
  profileFormFieldValue,
  profileFormFieldVisible,
} from "./profile-form-model"

export type TerminalProfilePrompt =
  | {
      kind: "field"
      field: SettingsFieldMetadata
      message: string
      current?: string
    }
  | {
      kind: "confirm"
      message: string
    }

export type TerminalProfilePrompter = (prompt: TerminalProfilePrompt) => Promise<string | undefined>

export type TerminalProfileFormOptions = {
  isTty?: () => boolean
  prompt?: TerminalProfilePrompter
}

const CANCEL_INPUT = /^(?:cancel|quit|q)$/i
const CLEAR_INPUT = "-"

function fieldClearable(field: SettingsFieldMetadata): boolean {
  return !field.required || field.id === "cliArgs" || field.id === "cliEnvironmentRefs"
}

function terminalAvailable(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY)
}

async function withDefaultPrompter<T>(
  operation: (prompt: TerminalProfilePrompter) => Promise<T>,
): Promise<T> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  })
  try {
    return await operation(async ({ message }) => {
      try {
        return await terminal.question(message)
      } catch {
        return undefined
      }
    })
  } finally {
    terminal.close()
  }
}

function promptMessage(field: SettingsFieldMetadata, current?: string): string {
  const choices = field.choices?.length ? ` [${field.choices.join("/")}]` : ""
  const defaultValue = current === undefined || current === "" ? "" : ` (current: ${current})`
  const clearing = fieldClearable(field) && current ? `; ${CLEAR_INPUT} clears` : ""
  return `${field.label}${choices}${defaultValue}${clearing}\n${field.help}\n${field.cliFlag}> `
}

function parseToggle(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase()
  if (["y", "yes", "true", "1", "on"].includes(normalized)) return true
  if (["n", "no", "false", "0", "off"].includes(normalized)) return false
  return undefined
}

type FieldAnswer =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly action: "inherit" | "clear" | "retain" }
  | { readonly cancelled: false; readonly action: "set"; readonly value: unknown }

async function askField(
  prompt: TerminalProfilePrompter,
  field: SettingsFieldMetadata,
  current: unknown,
): Promise<FieldAnswer> {
  if (field.secret)
    throw new Error(`Secret field is forbidden in role profile metadata: ${field.id}`)
  const currentText = current === undefined ? undefined : displayProfileFormValue(current)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = await prompt({
      kind: "field",
      field,
      message: promptMessage(field, currentText),
      ...(currentText === undefined ? {} : { current: currentText }),
    })
    if (answer === undefined || CANCEL_INPUT.test(answer.trim())) return { cancelled: true }
    const trimmed = answer.trim()
    if (trimmed === "") {
      return {
        cancelled: false,
        action: inheritableRoleProfileFormField(field.id) ? "inherit" : "retain",
      }
    }
    if (trimmed === CLEAR_INPUT && fieldClearable(field)) {
      return { cancelled: false, action: "clear" }
    }
    try {
      return {
        cancelled: false,
        action: "set",
        value: decodeProfileFormFieldText(field, trimmed),
      }
    } catch {
      // The same bounded prompt is shown again with the command-owned field metadata.
    }
  }
  throw new Error(`Could not obtain a valid value for ${field.label}`)
}

async function runForm(
  request: ProfileFormRequest,
  prompt: TerminalProfilePrompter,
): Promise<ProfileFormResponse | undefined> {
  if (request.metadata.formId !== "role-profile") {
    throw new Error(`Unsupported profile form: ${request.metadata.formId}`)
  }
  let state = createProfileFormState(request)
  for (const field of request.metadata.fields) {
    // --scope is command authority. The selector is offered only when the
    // caller omitted it; custom adapters are also rechecked by the handler.
    if (field.id === "scope" && request.scopeLocked) continue
    if (!profileFormFieldVisible(field, state, request.metadata.fields)) continue
    const response = await askField(prompt, field, profileFormFieldValue(field, state))
    if (response.cancelled) return undefined
    if (response.action === "inherit") {
      inheritProfileFormField(field, state)
      continue
    }
    if (response.action === "retain") continue
    if (response.action === "clear") {
      clearProfileFormField(field, state)
      continue
    }
    if (response.action !== "set")
      throw new Error(`Unsupported profile form action: ${response.action}`)
    const previousScope = state.scope
    applyProfileFormFieldValue(field, response.value, state)
    if (field.id === "scope" && state.scope !== previousScope) {
      state = createProfileFormState(request, state.scope)
    }
  }
  const profile = parseProfileFormState(state)
  const confirmation = await prompt({
    kind: "confirm",
    message: `Save ${state.scope} profile ${request.profileId}${state.setDefault ? " and set it as the role default" : ""}? [y/N] `,
  })
  if (confirmation === undefined || CANCEL_INPUT.test(confirmation.trim())) return undefined
  if (parseToggle(confirmation) !== true) return undefined
  const profileLayer = parseProfileFormLayer(state)
  return {
    scope: state.scope,
    profile,
    ...(profileLayer ? { profileLayer } : {}),
    ...(state.setDefault ? { setDefault: true } : {}),
  }
}

/**
 * Metadata-driven TTY adapter shared with the rich TUI profile popup model.
 * Empty input inherits the displayed value, `-` clears an optional field, and
 * all writes still return through the command-owned profiles.configure path.
 */
export function createTerminalProfileForm(options: TerminalProfileFormOptions = {}) {
  return async (request: ProfileFormRequest): Promise<ProfileFormResponse | undefined> => {
    if (!(options.isTty ?? terminalAvailable)()) return undefined
    if (options.prompt) return runForm(request, options.prompt)
    return withDefaultPrompter((prompt) => runForm(request, prompt))
  }
}
