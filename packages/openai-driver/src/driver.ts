import {
  CHATGPT_CODEX_RESPONSES_ENDPOINT,
  CHATGPT_OAUTH_ORIGINATOR,
  type ChatGptCredential,
  chatGptCredentialFromTokens,
  classifyHttpFailure,
  type FetchLike,
  OpenAiDriverError,
  type OpenAiFailureKind,
  refreshAccessToken,
  rewriteChatGptCodexRequest,
} from "./protocol"
import { readBoundedResponseJson } from "./response-body"
import {
  consumeOpenAiResponse,
  type OpenAiEvent,
  type OpenAiEventSink,
  type OpenAiOpaqueReasoningItem,
  type ResponseConsumption,
} from "./stream"

export const OPENAI_API_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses"
/**
 * OpenRouter's documented OpenAI-compatible Responses endpoint. It remains a
 * provider-owned beta protocol, so the endpoint is pinned here rather than
 * accepted from workspace configuration where a credential could be routed to
 * an arbitrary origin.
 */
export const OPENROUTER_API_RESPONSES_ENDPOINT = "https://openrouter.ai/api/v1/responses"
export const OPENAI_MAX_ERROR_RESPONSE_BYTES = 65_536

export type SmokeRequest = {
  model: string
  prompt: string
  parameters?: Readonly<Record<string, string | number | boolean | null>>
}

export type SmokeOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

export type OpenAiFunctionTool = {
  name: string
  description: string
  parameters: Readonly<Record<string, unknown>>
  strict: true
}

export type OpenAiStructuredTextFormat =
  | { type: "json_object" }
  | {
      type: "json_schema"
      name: string
      schema: Readonly<Record<string, unknown>>
      strict: true
    }

export type OpenAiModelInput =
  | { type: "message"; role: "user" | "assistant"; content: string }
  | OpenAiOpaqueReasoningItem
  | {
      type: "function_call"
      itemId: string
      callId: string
      name: string
      argumentsJson: string
    }
  | { type: "function_call_output"; callId: string; output: string }

export type OpenAiModelRequest = {
  model: string
  instructions?: string
  input: readonly OpenAiModelInput[]
  tools: readonly OpenAiFunctionTool[]
  parameters?: Readonly<Record<string, string | number | boolean | null>>
  maxOutputTokens?: number
  textFormat?: OpenAiStructuredTextFormat
}

export type ModelInvokeOptions = SmokeOptions

export type CredentialMetadata = {
  kind: "chatgpt-subscription" | "openai-api-key" | "openrouter-api-key"
  accountId?: string
  expiresAt?: number
  available: boolean
}

type ChatGptCodexDriverOptions = {
  credential: ChatGptCredential
  fetch: FetchLike
  now?: () => number
}

type OpenAiApiKeyDriverOptions = {
  apiKey: string
  fetch: FetchLike
}

export type OpenRouterApiKeyDriverOptions = {
  apiKey: string
  fetch: FetchLike
}

const CHATGPT_ALLOWED_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
])
const CHATGPT_DISALLOWED_MODELS = new Set(["gpt-5.5-pro", "gpt-5.6"])
const SAFE_MODEL_ID = /^[A-Za-z0-9._:-]{1,256}$/
const SAFE_OPENROUTER_MODEL_ID = /^(?=.{1,256}$)[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)+$/
const SAFE_FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/
const OPENAI_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"])
const OPENAI_MAX_SCHEMA_DEPTH = 10
const OPENAI_MAX_SCHEMA_NODES = 10_000

export class ChatGptCodexDriver {
  readonly kind = "chatgpt-subscription" as const
  readonly #fetch: FetchLike
  readonly #now: () => number
  #credential: ChatGptCredential
  #refreshPromise: Promise<ChatGptCredential> | undefined

  constructor(options: ChatGptCodexDriverOptions) {
    assertChatGptCredential(options.credential)
    this.#credential = { ...options.credential }
    this.#fetch = options.fetch
    this.#now = options.now ?? Date.now
  }

  credentialMetadata(): CredentialMetadata {
    return {
      kind: this.kind,
      available: Boolean(this.#credential.accessToken && this.#credential.refreshToken),
      expiresAt: this.#credential.expiresAt,
      ...(this.#credential.accountId ? { accountId: this.#credential.accountId } : {}),
    }
  }

  async refresh(options: SmokeOptions = {}): Promise<CredentialMetadata> {
    return runDriverOperation(options, "Credential refresh", async (scope) => {
      await this.refreshCredential(scope)
      scope.assertActive()
      return this.credentialMetadata()
    })
  }

  async smoke(
    request: SmokeRequest,
    sink: OpenAiEventSink,
    options: SmokeOptions = {},
  ): Promise<ResponseConsumption> {
    validateSmokeRequest(request)
    return this.invoke(smokeRequest(request), sink, options)
  }

  async invoke(
    request: OpenAiModelRequest,
    sink: OpenAiEventSink,
    options: ModelInvokeOptions = {},
  ): Promise<ResponseConsumption> {
    validateModelRequest(request)
    if (!isChatGptCodexModelAllowed(request.model)) {
      throw new OpenAiDriverError(
        "eligibility",
        "Model is not eligible for the pinned ChatGPT subscription protocol",
      )
    }
    return runDriverOperation(options, "Model invocation", async (scope) => {
      const credential = await this.currentCredential(scope)
      scope.assertActive()
      const body = modelBody(request)
      const rewritten = rewriteChatGptCodexRequest({
        request: OPENAI_API_RESPONSES_ENDPOINT,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            originator: CHATGPT_OAUTH_ORIGINATOR,
          },
          body: JSON.stringify(body),
        },
        credential,
      })
      return executeModel(rewritten.url, rewritten.init, this.#fetch, sink, scope)
    })
  }

  private async currentCredential(scope: DriverOperationScope): Promise<ChatGptCredential> {
    if (this.#credential.expiresAt > this.#now()) return { ...this.#credential }
    return this.refreshCredential(scope)
  }

  private async refreshCredential(scope: DriverOperationScope): Promise<ChatGptCredential> {
    if (!this.#refreshPromise) {
      this.#refreshPromise = refreshAccessToken(this.#credential.refreshToken, {
        fetch: this.#fetch,
      })
        .then((tokens) =>
          chatGptCredentialFromTokens(tokens, this.#now(), this.#credential.accountId),
        )
        .then((credential) => {
          this.#credential = credential
          return { ...credential }
        })
        .finally(() => {
          this.#refreshPromise = undefined
        })
    }
    return scope.race(this.#refreshPromise)
  }
}

export class OpenAiApiKeyDriver {
  readonly kind = "openai-api-key" as const
  readonly #apiKey: string
  readonly #fetch: FetchLike

  constructor(options: OpenAiApiKeyDriverOptions) {
    if (!options.apiKey) throw new OpenAiDriverError("invalid-input", "OpenAI API key is required")
    this.#apiKey = options.apiKey
    this.#fetch = options.fetch
  }

  credentialMetadata(): CredentialMetadata {
    return { kind: this.kind, available: Boolean(this.#apiKey) }
  }

  async smoke(
    request: SmokeRequest,
    sink: OpenAiEventSink,
    options: SmokeOptions = {},
  ): Promise<ResponseConsumption> {
    validateSmokeRequest(request)
    return this.invoke(smokeRequest(request), sink, options)
  }

  async invoke(
    request: OpenAiModelRequest,
    sink: OpenAiEventSink,
    options: ModelInvokeOptions = {},
  ): Promise<ResponseConsumption> {
    validateModelRequest(request)
    return runDriverOperation(options, "Model invocation", (scope) =>
      executeModel(
        new URL(OPENAI_API_RESPONSES_ENDPOINT),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(modelBody(request)),
          redirect: "error",
        },
        this.#fetch,
        sink,
        scope,
      ),
    )
  }
}

/**
 * Bounded OpenRouter adapter over the provider's documented OpenAI-compatible
 * Responses API. It deliberately reuses only the protocol-normalization layer:
 * Ralph still owns tools, policy, task state, evidence and completion.
 */
export class OpenRouterApiKeyDriver {
  readonly kind = "openrouter-api-key" as const
  readonly #apiKey: string
  readonly #fetch: FetchLike

  constructor(options: OpenRouterApiKeyDriverOptions) {
    if (!options.apiKey) {
      throw new OpenAiDriverError("invalid-input", "OpenRouter API key is required")
    }
    this.#apiKey = options.apiKey
    this.#fetch = options.fetch
  }

  credentialMetadata(): CredentialMetadata {
    return { kind: this.kind, available: Boolean(this.#apiKey) }
  }

  async smoke(
    request: SmokeRequest,
    sink: OpenAiEventSink,
    options: SmokeOptions = {},
  ): Promise<ResponseConsumption> {
    validateSmokeRequest(request, SAFE_OPENROUTER_MODEL_ID, "OpenRouter")
    return this.invoke(smokeRequest(request), sink, options)
  }

  async invoke(
    request: OpenAiModelRequest,
    sink: OpenAiEventSink,
    options: ModelInvokeOptions = {},
  ): Promise<ResponseConsumption> {
    validateModelRequest(request, SAFE_OPENROUTER_MODEL_ID, "OpenRouter")
    return runDriverOperation(options, "Model invocation", (scope) =>
      executeModel(
        new URL(OPENROUTER_API_RESPONSES_ENDPOINT),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(modelBody(request)),
          redirect: "error",
        },
        this.#fetch,
        sink,
        scope,
      ),
    )
  }
}

export function isChatGptCodexModelAllowed(model: string): boolean {
  if (CHATGPT_ALLOWED_MODELS.has(model)) return true
  if (CHATGPT_DISALLOWED_MODELS.has(model)) return false
  const match = /^gpt-(\d+\.\d+)/.exec(model)
  return match?.[1] !== undefined && Number.parseFloat(match[1]) > 5.4
}

async function executeModel(
  url: URL,
  init: RequestInit,
  fetcher: FetchLike,
  sink: OpenAiEventSink,
  scope: DriverOperationScope,
): Promise<ResponseConsumption> {
  scope.assertActive()
  let response: Response
  try {
    response = await scope.race(fetcher(url, { ...init, signal: scope.signal }))
  } catch (cause) {
    scope.assertActive()
    if (cause instanceof OpenAiDriverError) throw cause
    throw new OpenAiDriverError(
      "transport",
      "Model invocation transport failed",
      undefined,
      undefined,
      {
        cause,
      },
    )
  }
  scope.assertActive()
  const fencedSink: OpenAiEventSink = async (event) => {
    scope.assertActive()
    await sink(event)
    scope.assertActive()
  }
  const consume = async (): Promise<ResponseConsumption> => {
    if (!response.ok) {
      const descriptor = await providerFailureDescriptor(response, scope.signal)
      scope.assertActive()
      const error = classifyHttpFailure(response.status, response.headers, descriptor.code)
      await emitHttpFailure(fencedSink, error, descriptor)
      throw error
    }
    return consumeOpenAiResponse(response, fencedSink, scope.signal)
  }
  return scope.race(consume())
}

type DriverTermination = "timeout" | "cancelled"

type DriverOperationScope = {
  signal: AbortSignal
  assertActive(): void
  race<T>(operation: Promise<T>): Promise<T>
}

async function runDriverOperation<T>(
  options: SmokeOptions,
  operation: "Model smoke" | "Model invocation" | "Credential refresh",
  execute: (scope: DriverOperationScope) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30 * 60 * 1_000) {
    throw new OpenAiDriverError("invalid-input", `${operation} timeout is invalid`)
  }
  if (options.signal?.aborted) {
    throw operationTerminationError(operation, "cancelled")
  }

  const controller = new AbortController()
  let termination: DriverTermination | undefined
  let rejectTermination: ((error: OpenAiDriverError) => void) | undefined
  const terminationPromise = new Promise<never>((_resolve, reject) => {
    rejectTermination = reject
  })
  const terminate = (kind: DriverTermination, reason?: unknown) => {
    if (termination) return
    termination = kind
    controller.abort(reason)
    rejectTermination?.(operationTerminationError(operation, kind))
  }
  const cancel = () => terminate("cancelled", options.signal?.reason)
  options.signal?.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(() => terminate("timeout", "timeout"), timeoutMs)
  const assertActive = () => {
    if (termination) throw operationTerminationError(operation, termination)
  }
  const scope: DriverOperationScope = {
    signal: controller.signal,
    assertActive,
    async race<TValue>(pending: Promise<TValue>): Promise<TValue> {
      try {
        return await Promise.race([pending, terminationPromise])
      } catch (cause) {
        assertActive()
        throw cause
      }
    },
  }

  try {
    return await scope.race(execute(scope))
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener("abort", cancel)
  }
}

function operationTerminationError(
  operation: "Model smoke" | "Model invocation" | "Credential refresh",
  termination: DriverTermination,
): OpenAiDriverError {
  return termination === "cancelled"
    ? new OpenAiDriverError("cancelled", `${operation} was cancelled`)
    : new OpenAiDriverError("timeout", `${operation} timed out`)
}

function smokeRequest(request: SmokeRequest): OpenAiModelRequest {
  return {
    model: request.model,
    input: [{ type: "message", role: "user", content: request.prompt }],
    tools: [],
    parameters: request.parameters ?? {},
  }
}

function modelBody(request: OpenAiModelRequest): Record<string, unknown> {
  const input = request.input.map((item): Record<string, unknown> => {
    if (item.type === "message") {
      return { role: item.role, content: [{ type: "input_text", text: item.content }] }
    }
    if (item.type === "reasoning") {
      return {
        type: "reasoning",
        id: item.itemId,
        encrypted_content: item.encryptedContent,
        summary: item.summary.map((entry) => structuredClone(entry)),
      }
    }
    if (item.type === "function_call") {
      return {
        type: "function_call",
        id: item.itemId,
        call_id: item.callId,
        name: item.name,
        arguments: item.argumentsJson,
      }
    }
    return { type: "function_call_output", call_id: item.callId, output: item.output }
  })
  return {
    model: request.model,
    ...(request.instructions ? { instructions: request.instructions } : {}),
    input,
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: true,
          })),
          tool_choice: "auto",
          parallel_tool_calls: false,
        }
      : {}),
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: request.maxOutputTokens }),
    ...(request.textFormat ? { text: { format: request.textFormat } } : {}),
    stream: true,
    store: false,
    ...openAiSmokeParameters(request.parameters ?? {}),
  }
}

function openAiSmokeParameters(
  parameters: Readonly<Record<string, string | number | boolean | null>>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(parameters)) {
    if (name === "reasoning_effort") {
      if (typeof value !== "string" || !OPENAI_REASONING_EFFORTS.has(value)) {
        throw new OpenAiDriverError(
          "invalid-input",
          "OpenAI reasoning_effort must be a supported declared value",
        )
      }
      output.reasoning = { effort: value }
      continue
    }
    if (name === "temperature") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
        throw new OpenAiDriverError(
          "invalid-input",
          "OpenAI temperature must be a finite number between 0 and 2",
        )
      }
      output.temperature = value
      continue
    }
    if (name === "top_p") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new OpenAiDriverError(
          "invalid-input",
          "OpenAI top_p must be a finite number between 0 and 1",
        )
      }
      output.top_p = value
      continue
    }
    throw new OpenAiDriverError(
      "invalid-input",
      `OpenAI smoke parameter is not implemented by this driver: ${name}`,
    )
  }
  return output
}

function validateSmokeRequest(
  request: SmokeRequest,
  modelPattern: RegExp = SAFE_MODEL_ID,
  providerLabel = "OpenAI",
): void {
  if (!modelPattern.test(request.model)) {
    throw new OpenAiDriverError("invalid-input", `${providerLabel} model ID is invalid`)
  }
  if (!request.prompt || request.prompt.length > 1_000_000) {
    throw new OpenAiDriverError("invalid-input", "Smoke prompt is invalid")
  }
  openAiSmokeParameters(request.parameters ?? {})
}

function validateModelRequest(
  request: OpenAiModelRequest,
  modelPattern: RegExp = SAFE_MODEL_ID,
  providerLabel = "OpenAI",
): void {
  if (!modelPattern.test(request.model)) {
    throw new OpenAiDriverError("invalid-input", `${providerLabel} model ID is invalid`)
  }
  if (request.instructions !== undefined && request.instructions.length > 1_000_000) {
    throw new OpenAiDriverError("invalid-input", "Model instructions exceed the safe limit")
  }
  if (request.input.length === 0 || request.input.length > 10_000) {
    throw new OpenAiDriverError("invalid-input", "Model input item count is invalid")
  }
  let inputBytes = 0
  for (const item of request.input) {
    const values =
      item.type === "message"
        ? [item.content]
        : item.type === "reasoning"
          ? [item.itemId, item.encryptedContent, JSON.stringify(item.summary)]
          : item.type === "function_call"
            ? [item.itemId, item.callId, item.name, item.argumentsJson]
            : [item.callId, item.output]
    for (const value of values) inputBytes += Buffer.byteLength(value, "utf8")
    if (item.type !== "message") {
      for (const identifier of item.type === "function_call"
        ? [item.itemId, item.callId]
        : item.type === "reasoning"
          ? [item.itemId]
          : [item.callId]) {
        if (!SAFE_MODEL_ID.test(identifier)) {
          throw new OpenAiDriverError("invalid-input", "Model tool identifier is invalid")
        }
      }
    }
    if (item.type === "function_call") {
      if (!SAFE_FUNCTION_NAME.test(item.name)) {
        throw new OpenAiDriverError("invalid-input", "Model function name is provider-unsafe")
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(item.argumentsJson)
      } catch (cause) {
        throw new OpenAiDriverError(
          "invalid-input",
          "Model function call arguments are not JSON",
          undefined,
          undefined,
          { cause },
        )
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new OpenAiDriverError("invalid-input", "Model function arguments must be an object")
      }
    }
    if (item.type === "reasoning") {
      if (!item.encryptedContent || item.encryptedContent.length > 4_000_000) {
        throw new OpenAiDriverError("invalid-input", "Opaque reasoning continuation is invalid")
      }
      if (
        !Array.isArray(item.summary) ||
        item.summary.length > 1_000 ||
        item.summary.some((entry) => !isRecord(entry))
      ) {
        throw new OpenAiDriverError("invalid-input", "Opaque reasoning summary is invalid")
      }
    }
  }
  if (inputBytes > 4_000_000) {
    throw new OpenAiDriverError("invalid-input", "Model input exceeds the safe byte limit")
  }
  if (request.tools.length > 128) {
    throw new OpenAiDriverError("invalid-input", "Model tool count exceeds the safe limit")
  }
  const names = new Set<string>()
  for (const tool of request.tools) {
    if (!SAFE_FUNCTION_NAME.test(tool.name) || names.has(tool.name)) {
      throw new OpenAiDriverError("invalid-input", "Model tool name is invalid or duplicated")
    }
    names.add(tool.name)
    if (!tool.description || Buffer.byteLength(tool.description, "utf8") > 16_384) {
      throw new OpenAiDriverError("invalid-input", "Model tool description is invalid")
    }
    if (tool.strict !== true) {
      throw new OpenAiDriverError("invalid-input", "Model tools require strict object schemas")
    }
    validateStrictSchema(tool.parameters, `tool ${tool.name}`)
  }
  if (
    request.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0)
  ) {
    throw new OpenAiDriverError("invalid-input", "Model output token limit is invalid")
  }
  if (request.textFormat?.type === "json_schema") {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.textFormat.name)) {
      throw new OpenAiDriverError("invalid-input", "Structured output schema name is invalid")
    }
    if (request.textFormat.strict !== true) {
      throw new OpenAiDriverError(
        "invalid-input",
        "Structured output requires a strict object schema",
      )
    }
    validateStrictSchema(request.textFormat.schema, "structured output")
  }
  openAiSmokeParameters(request.parameters ?? {})
}

function validateStrictSchema(
  schema: Readonly<Record<string, unknown>>,
  label: string,
  root = true,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): void {
  budget.nodes += 1
  if (budget.nodes > OPENAI_MAX_SCHEMA_NODES || depth > OPENAI_MAX_SCHEMA_DEPTH) {
    throw new OpenAiDriverError("invalid-input", `OpenAI ${label} schema exceeds safe limits`)
  }
  if (root && (schema.type !== "object" || schema.anyOf !== undefined)) {
    throw new OpenAiDriverError("invalid-input", `OpenAI ${label} schema root must be an object`)
  }
  if (
    schema.oneOf !== undefined ||
    schema.allOf !== undefined ||
    schema.not !== undefined ||
    schema.if !== undefined ||
    schema.then !== undefined ||
    schema.else !== undefined ||
    schema.dependentRequired !== undefined ||
    schema.dependentSchemas !== undefined ||
    schema.default !== undefined ||
    schema.$schema !== undefined ||
    schema.propertyNames !== undefined
  ) {
    throw new OpenAiDriverError(
      "invalid-input",
      `OpenAI ${label} schema contains an unsupported keyword`,
    )
  }
  if (schema.type === "object" || schema.properties !== undefined) {
    if (!isRecord(schema.properties) || schema.additionalProperties !== false) {
      throw new OpenAiDriverError("invalid-input", `OpenAI ${label} object schema is not closed`)
    }
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((name) => typeof name !== "string")
    ) {
      throw new OpenAiDriverError(
        "invalid-input",
        `OpenAI ${label} object schema has invalid required fields`,
      )
    }
    const properties = Object.keys(schema.properties)
    const required = new Set(schema.required as string[])
    if (
      schema.required.length !== properties.length ||
      required.size !== properties.length ||
      properties.some((name) => !required.has(name))
    ) {
      throw new OpenAiDriverError(
        "invalid-input",
        `OpenAI ${label} object schema must require every property`,
      )
    }
    for (const [name, property] of Object.entries(schema.properties)) {
      if (!isRecord(property)) {
        throw new OpenAiDriverError(
          "invalid-input",
          `OpenAI ${label} property ${name} is not a schema`,
        )
      }
      validateStrictSchema(property, label, false, depth + 1, budget)
    }
  }
  if (schema.type === "array") {
    if (!isRecord(schema.items)) {
      throw new OpenAiDriverError("invalid-input", `OpenAI ${label} array schema has no items`)
    }
    validateStrictSchema(schema.items, label, false, depth + 1, budget)
  }
  if (schema.anyOf !== undefined) {
    if (
      !Array.isArray(schema.anyOf) ||
      schema.anyOf.length === 0 ||
      schema.anyOf.some((branch) => !isRecord(branch))
    ) {
      throw new OpenAiDriverError("invalid-input", `OpenAI ${label} anyOf schema is invalid`)
    }
    for (const branch of schema.anyOf as Array<Record<string, unknown>>) {
      validateStrictSchema(branch, label, false, depth + 1, budget)
    }
  }
  if (schema.$defs !== undefined) {
    if (!isRecord(schema.$defs)) {
      throw new OpenAiDriverError("invalid-input", `OpenAI ${label} definitions are invalid`)
    }
    for (const definition of Object.values(schema.$defs)) {
      if (!isRecord(definition)) {
        throw new OpenAiDriverError("invalid-input", `OpenAI ${label} definition is invalid`)
      }
      validateStrictSchema(definition, label, false, depth + 1, budget)
    }
  }
  if (
    schema.type === undefined &&
    schema.$ref === undefined &&
    schema.anyOf === undefined &&
    schema.properties === undefined
  ) {
    throw new OpenAiDriverError("invalid-input", `OpenAI ${label} schema is unconstrained`)
  }
}

function assertChatGptCredential(credential: ChatGptCredential): void {
  if (
    credential.kind !== "chatgpt-subscription" ||
    !credential.accessToken ||
    !credential.refreshToken ||
    !Number.isFinite(credential.expiresAt)
  ) {
    throw new OpenAiDriverError("invalid-input", "ChatGPT credential is invalid")
  }
}

async function providerFailureDescriptor(
  response: Response,
  signal: AbortSignal,
): Promise<{
  code?: string
  type?: string
}> {
  let value: unknown
  try {
    value = await readBoundedResponseJson(response, {
      maxBytes: OPENAI_MAX_ERROR_RESPONSE_BYTES,
      signal,
      label: "Provider error response",
    })
  } catch (cause) {
    if (signal.aborted) throw cause
    return {}
  }
  if (!isRecord(value)) return {}
  const error = isRecord(value.error) ? value.error : value
  const code = safeFailureToken(error.code)
  const type = safeFailureToken(error.type)
  return { ...(code ? { code } : {}), ...(type ? { type } : {}) }
}

async function emitHttpFailure(
  sink: OpenAiEventSink,
  error: OpenAiDriverError,
  descriptor: { code?: string; type?: string },
): Promise<void> {
  const raw: OpenAiEvent = {
    type: "raw",
    sequence: 1,
    data: {
      status: error.status,
      ...(descriptor.code ? { code: descriptor.code } : {}),
      ...(descriptor.type ? { providerType: descriptor.type } : {}),
    },
  }
  const normalized: OpenAiEvent = {
    type: "error",
    sequence: 2,
    error: {
      kind: error.kind,
      message: error.message,
      ...(descriptor.code ? { code: descriptor.code } : {}),
    },
  }
  await sink(raw)
  await sink(normalized)
}

function safeFailureToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function classifySmokeError(error: unknown): OpenAiFailureKind {
  return error instanceof OpenAiDriverError ? error.kind : "transport"
}

export function isPinnedChatGptEndpoint(value: string): boolean {
  return value === CHATGPT_CODEX_RESPONSES_ENDPOINT
}
