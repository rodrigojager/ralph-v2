import { createHash } from "node:crypto"

import type { OpenAiFunctionTool, OpenAiToolCall } from "@ralph-next/openai-driver"
import type { ProviderJsonObject, ProviderToolDefinition } from "@ralph-next/providers"

const PROVIDER_FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/
const MAX_SCHEMA_DEPTH = 10
const MAX_SCHEMA_NODES = 10_000
const RECORD_KEY = "key"
const RECORD_VALUE = "value"
const ROOT_UNION_VALUE = "input"

type JsonSchema = Record<string, unknown>

type SchemaBudget = {
  nodes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.keys(value)
    .sort((left, right) => left.localeCompare(right, "en"))
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`
}

function schemaRecord(value: unknown, label: string): JsonSchema {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON Schema object`)
  return value
}

function schemaArray(value: unknown, label: string): readonly JsonSchema[] {
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    throw new Error(`${label} must contain JSON Schema objects`)
  }
  return value as readonly JsonSchema[]
}

function observeSchemaNode(budget: SchemaBudget, depth: number): void {
  budget.nodes += 1
  if (budget.nodes > MAX_SCHEMA_NODES) throw new Error("OpenAI tool schema is too large")
  if (depth > MAX_SCHEMA_DEPTH) throw new Error("OpenAI tool schema is nested too deeply")
}

function copiedConstraints(schema: JsonSchema): JsonSchema {
  const output: JsonSchema = {}
  // Keep only the subset documented for Responses structured outputs. In
  // particular, Zod's `default`, `$schema`, `minLength`, `maxLength`, and
  // `propertyNames` annotations are not provider constraints.
  for (const key of [
    "title",
    "description",
    "type",
    "enum",
    "const",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minItems",
    "maxItems",
    "$ref",
  ]) {
    if (schema[key] !== undefined) output[key] = structuredClone(schema[key])
  }
  return output
}

function unionBranches(schema: JsonSchema): readonly JsonSchema[] | undefined {
  if (schema.oneOf !== undefined) return schemaArray(schema.oneOf, "oneOf")
  if (schema.anyOf !== undefined) return schemaArray(schema.anyOf, "anyOf")
  return undefined
}

function isDictionarySchema(schema: JsonSchema): boolean {
  return (
    schema.type === "object" &&
    (!isRecord(schema.properties) || Object.keys(schema.properties).length === 0) &&
    isRecord(schema.additionalProperties)
  )
}

function nullable(schema: JsonSchema): JsonSchema {
  if (schema.type === "null") return schema
  if (Array.isArray(schema.type) && schema.type.includes("null")) return schema
  return { anyOf: [schema, { type: "null" }] }
}

function schemaAllowsNull(schema: JsonSchema): boolean {
  if (schema.type === "null") return true
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true
  const branches = unionBranches(schema)
  return branches?.some(schemaAllowsNull) ?? false
}

function compileSchema(
  source: JsonSchema,
  options: { root: boolean; depth: number },
  budget: SchemaBudget,
): JsonSchema {
  observeSchemaNode(budget, options.depth)
  if (
    source.allOf !== undefined ||
    source.not !== undefined ||
    source.if !== undefined ||
    source.then !== undefined ||
    source.else !== undefined ||
    source.dependentRequired !== undefined ||
    source.dependentSchemas !== undefined
  ) {
    throw new Error("Ralph tool schema uses unsupported OpenAI composition")
  }

  const branches = unionBranches(source)
  if (branches) {
    const compiledBranches = branches.map((branch) =>
      compileSchema(branch, { root: false, depth: options.depth + 1 }, budget),
    )
    if (options.root) {
      // Responses requires an object rather than anyOf/oneOf at the root. A
      // one-property envelope is reversible and does not weaken each branch.
      return {
        type: "object",
        properties: { [ROOT_UNION_VALUE]: { anyOf: compiledBranches } },
        required: [ROOT_UNION_VALUE],
        additionalProperties: false,
      }
    }
    return { ...copiedConstraints(source), anyOf: compiledBranches }
  }

  if (isDictionarySchema(source)) {
    const keySource = isRecord(source.propertyNames) ? source.propertyNames : { type: "string" }
    const valueSource = schemaRecord(source.additionalProperties, "additionalProperties")
    return {
      type: "array",
      items: {
        type: "object",
        properties: {
          [RECORD_KEY]: compileSchema(keySource, { root: false, depth: options.depth + 2 }, budget),
          [RECORD_VALUE]: compileSchema(
            valueSource,
            { root: false, depth: options.depth + 2 },
            budget,
          ),
        },
        required: [RECORD_KEY, RECORD_VALUE],
        additionalProperties: false,
      },
    }
  }

  if (source.type === "object" || isRecord(source.properties)) {
    const properties = isRecord(source.properties) ? source.properties : {}
    const required = new Set(
      Array.isArray(source.required)
        ? source.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    )
    const compiledProperties: JsonSchema = {}
    for (const [name, value] of Object.entries(properties)) {
      const compiled = compileSchema(
        schemaRecord(value, `property ${name}`),
        { root: false, depth: options.depth + 1 },
        budget,
      )
      compiledProperties[name] = required.has(name) ? compiled : nullable(compiled)
    }
    const output: JsonSchema = {
      ...copiedConstraints(source),
      type: "object",
      properties: compiledProperties,
      required: Object.keys(properties),
      additionalProperties: false,
    }
    if (isRecord(source.$defs)) {
      output.$defs = Object.fromEntries(
        Object.entries(source.$defs).map(([name, value]) => [
          name,
          compileSchema(
            schemaRecord(value, `$defs.${name}`),
            { root: false, depth: options.depth + 1 },
            budget,
          ),
        ]),
      )
    }
    return output
  }

  if (source.type === "array") {
    if (!isRecord(source.items)) throw new Error("OpenAI strict arrays require one items schema")
    return {
      ...copiedConstraints(source),
      type: "array",
      items: compileSchema(source.items, { root: false, depth: options.depth + 1 }, budget),
    }
  }

  if (typeof source.$ref === "string") return copiedConstraints(source)
  if (source.type === undefined) {
    throw new Error("OpenAI strict schemas cannot contain an unconstrained value")
  }
  return copiedConstraints(source)
}

function matchingBranch(branches: readonly JsonSchema[], value: unknown): JsonSchema {
  if (!isRecord(value)) {
    const primitiveType =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value === "number"
            ? "number"
            : typeof value
    return (
      branches.find(
        (branch) =>
          branch.type === primitiveType ||
          (Array.isArray(branch.type) && branch.type.includes(primitiveType)),
      ) ?? (branches[0] as JsonSchema)
    )
  }
  for (const branch of branches) {
    if (!isRecord(branch.properties)) continue
    const discriminators = Object.entries(branch.properties).filter(
      ([, property]) => isRecord(property) && property.const !== undefined,
    )
    if (
      discriminators.length > 0 &&
      discriminators.every(
        ([name, property]) => value[name] === (property as Record<string, unknown>).const,
      )
    ) {
      return branch
    }
  }
  const byRequired = branches.find((branch) =>
    Array.isArray(branch.required)
      ? branch.required.every((name) => typeof name === "string" && name in value)
      : false,
  )
  return byRequired ?? (branches[0] as JsonSchema)
}

function encodeValue(schema: JsonSchema, value: unknown, root = false): unknown {
  const branches = unionBranches(schema)
  if (branches) {
    const encoded = encodeValue(matchingBranch(branches, value), value)
    return root ? { [ROOT_UNION_VALUE]: encoded } : encoded
  }
  if (isDictionarySchema(schema)) {
    if (!isRecord(value)) throw new Error("Ralph dictionary tool input must be an object")
    const valueSchema = schemaRecord(schema.additionalProperties, "additionalProperties")
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => ({
        [RECORD_KEY]: key,
        [RECORD_VALUE]: encodeValue(valueSchema, value[key]),
      }))
  }
  if (schema.type === "object" || isRecord(schema.properties)) {
    if (!isRecord(value)) throw new Error("Ralph object tool input must be an object")
    const properties = isRecord(schema.properties) ? schema.properties : {}
    if (Object.keys(value).some((name) => !Object.hasOwn(properties, name))) {
      throw new Error("Ralph object tool input contains an unknown property")
    }
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    )
    const output: Record<string, unknown> = {}
    for (const [name, property] of Object.entries(properties)) {
      const propertySchema = schemaRecord(property, `property ${name}`)
      if (value[name] !== undefined) output[name] = encodeValue(propertySchema, value[name])
      else if (!required.has(name)) output[name] = null
      else if (propertySchema.default !== undefined)
        output[name] = structuredClone(propertySchema.default)
      else throw new Error(`Ralph tool input omitted required property: ${name}`)
    }
    return output
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error("Ralph array tool input must be an array")
    const items = schemaRecord(schema.items, "items")
    return value.map((entry) => encodeValue(items, entry))
  }
  return structuredClone(value)
}

function safeRecordKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "__proto__" ||
    value === "constructor" ||
    value === "prototype"
  ) {
    throw new Error("Provider returned an invalid dictionary key")
  }
  return value
}

function decodeValue(schema: JsonSchema, value: unknown, root = false): unknown {
  const branches = unionBranches(schema)
  if (branches) {
    if (root && (!isRecord(value) || Object.keys(value).some((key) => key !== ROOT_UNION_VALUE))) {
      throw new Error("Provider returned an invalid wrapped union tool input")
    }
    const wrapped = root ? (value as Record<string, unknown>)[ROOT_UNION_VALUE] : value
    if (wrapped === undefined) throw new Error("Provider omitted the wrapped union tool input")
    return decodeValue(matchingBranch(branches, wrapped), wrapped)
  }
  if (isDictionarySchema(schema)) {
    if (!Array.isArray(value)) throw new Error("Provider dictionary tool input must be an array")
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    const valueSchema = schemaRecord(schema.additionalProperties, "additionalProperties")
    for (const entry of value) {
      if (!isRecord(entry)) throw new Error("Provider dictionary entry must be an object")
      if (Object.keys(entry).some((key) => key !== RECORD_KEY && key !== RECORD_VALUE)) {
        throw new Error("Provider dictionary entry contains an unknown property")
      }
      const key = safeRecordKey(entry[RECORD_KEY])
      if (!Object.hasOwn(entry, RECORD_VALUE)) {
        throw new Error("Provider dictionary entry omitted its value")
      }
      if (Object.hasOwn(output, key)) throw new Error("Provider duplicated a dictionary key")
      output[key] = decodeValue(valueSchema, entry[RECORD_VALUE])
    }
    return { ...output }
  }
  if (schema.type === "object" || isRecord(schema.properties)) {
    if (!isRecord(value)) throw new Error("Provider object tool input must be an object")
    const properties = isRecord(schema.properties) ? schema.properties : {}
    if (Object.keys(value).some((name) => !Object.hasOwn(properties, name))) {
      throw new Error("Provider object tool input contains an unknown property")
    }
    if (Object.keys(properties).some((name) => !Object.hasOwn(value, name))) {
      throw new Error("Provider object tool input omitted a strict property")
    }
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    )
    const output: Record<string, unknown> = {}
    for (const [name, property] of Object.entries(properties)) {
      if (!(name in value)) continue
      if (
        value[name] === null &&
        !required.has(name) &&
        !schemaAllowsNull(property as JsonSchema)
      ) {
        continue
      }
      output[name] = decodeValue(schemaRecord(property, `property ${name}`), value[name])
    }
    return output
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error("Provider array tool input must be an array")
    const items = schemaRecord(schema.items, "items")
    return value.map((entry) => decodeValue(items, entry))
  }
  return structuredClone(value)
}

function providerAlias(name: string): string {
  const readable = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool"
  const hash = createHash("sha256")
    .update("ralph.openai.tool-alias.v1\0")
    .update(name)
    .digest("hex")
  const alias = `ralph_${readable.slice(0, 42)}_${hash.slice(0, 12)}`
  if (!PROVIDER_FUNCTION_NAME.test(alias)) throw new Error("Generated OpenAI tool alias is invalid")
  return alias
}

function assertStrictSchema(schema: JsonSchema, root = true, depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error("Compiled OpenAI schema exceeds nesting limit")
  if (root && (schema.type !== "object" || schema.anyOf !== undefined)) {
    throw new Error("Compiled OpenAI schema root must be one object")
  }
  if (schema.oneOf !== undefined || schema.default !== undefined || schema.$schema !== undefined) {
    throw new Error("Compiled OpenAI schema contains an unsupported keyword")
  }
  if (schema.type === "object" || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    if (schema.additionalProperties !== false) {
      throw new Error("Compiled OpenAI object schema is not closed")
    }
    const required = Array.isArray(schema.required) ? schema.required : []
    const propertyNames = Object.keys(properties)
    if (
      required.length !== propertyNames.length ||
      propertyNames.some((name) => !required.includes(name))
    ) {
      throw new Error("Compiled OpenAI object schema does not require every property")
    }
    for (const property of Object.values(properties)) {
      assertStrictSchema(schemaRecord(property, "compiled property"), false, depth + 1)
    }
  }
  if (schema.type === "array") {
    assertStrictSchema(schemaRecord(schema.items, "compiled items"), false, depth + 1)
  }
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schemaArray(schema.anyOf, "compiled anyOf")) {
      assertStrictSchema(branch, false, depth + 1)
    }
  }
  if (isRecord(schema.$defs)) {
    for (const value of Object.values(schema.$defs)) {
      assertStrictSchema(schemaRecord(value, "compiled definition"), false, depth + 1)
    }
  }
}

type ToolCodec = {
  originalName: string
  providerName: string
  originalSchema: JsonSchema
  providerTool: OpenAiFunctionTool
}

/**
 * Compiles Ralph's richer JSON Schemas into the strict Responses subset and
 * owns the reversible name/argument boundary. Provider aliases and nullable
 * placeholders never cross into ToolHost.
 */
export class OpenAiStrictToolCodec {
  readonly tools: readonly OpenAiFunctionTool[]
  readonly #byOriginal = new Map<string, ToolCodec>()
  readonly #byProvider = new Map<string, ToolCodec>()

  constructor(definitions: readonly ProviderToolDefinition[]) {
    const tools: OpenAiFunctionTool[] = []
    for (const definition of definitions) {
      if (this.#byOriginal.has(definition.name)) throw new Error("Ralph tool name is duplicated")
      const alias = providerAlias(definition.name)
      if (this.#byProvider.has(alias)) throw new Error("OpenAI tool alias collided")
      const originalSchema = structuredClone(definition.inputSchema) as JsonSchema
      const parameters = compileSchema(originalSchema, { root: true, depth: 0 }, { nodes: 0 })
      assertStrictSchema(parameters)
      const providerTool: OpenAiFunctionTool = {
        name: alias,
        description: definition.description,
        parameters,
        strict: true,
      }
      const codec = {
        originalName: definition.name,
        providerName: alias,
        originalSchema,
        providerTool,
      }
      this.#byOriginal.set(definition.name, codec)
      this.#byProvider.set(alias, codec)
      tools.push(providerTool)
    }
    this.tools = tools
  }

  encodeFunctionCall(input: { name: string; argumentsJson: string }): {
    name: string
    argumentsJson: string
  } {
    const codec = this.#byOriginal.get(input.name)
    if (!codec) throw new Error(`Unknown Ralph tool in OpenAI history: ${input.name}`)
    let decoded: unknown
    try {
      decoded = JSON.parse(input.argumentsJson)
    } catch {
      throw new Error("Ralph tool history contains malformed arguments JSON")
    }
    const encoded = encodeValue(codec.originalSchema, decoded, true)
    return { name: codec.providerName, argumentsJson: JSON.stringify(encoded) }
  }

  decodeToolCall(call: OpenAiToolCall): OpenAiToolCall {
    const codec = this.#byProvider.get(call.name)
    if (!codec) throw new Error(`Provider requested an unknown OpenAI tool alias: ${call.name}`)
    let argumentsInput: unknown
    try {
      argumentsInput = JSON.parse(call.argumentsJson)
    } catch {
      throw new Error("Provider tool arguments JSON is malformed")
    }
    if (canonicalJson(argumentsInput) !== canonicalJson(call.input)) {
      throw new Error("Provider tool arguments JSON does not match its parsed input")
    }
    const input = decodeValue(codec.originalSchema, call.input, true)
    if (!isRecord(input)) throw new Error("Decoded Ralph tool input is not an object")
    const providerInput = input as ProviderJsonObject
    return {
      ...call,
      name: codec.originalName,
      input: providerInput,
      argumentsJson: JSON.stringify(providerInput),
    }
  }

  providerName(originalName: string): string {
    const codec = this.#byOriginal.get(originalName)
    if (!codec) throw new Error(`Unknown Ralph tool: ${originalName}`)
    return codec.providerName
  }
}

export function validateOpenAiStrictSchema(schema: Readonly<Record<string, unknown>>): void {
  assertStrictSchema(schema as JsonSchema)
}
