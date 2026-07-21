import { describe, expect, test } from "bun:test"
import { type ProviderToolDefinition, ProviderToolDefinitionSchema } from "@ralph/providers"
import { createBuiltinToolRegistry, type ToolDefinition, ToolPolicySchema } from "@ralph/tool-host"

import { OpenAiStrictToolCodec, validateOpenAiStrictSchema } from "../src/index"

const SHA = "a".repeat(64)

const samples: Readonly<Record<string, Record<string, unknown>>> = {
  "artifact.publish": { artifactId: "report", path: "report.json" },
  "fs.apply_patch": {
    changes: [
      {
        path: "src/a.ts",
        beforeSha256: SHA,
        replacements: [{ oldText: "before", newText: "after" }],
      },
    ],
  },
  "fs.edit": {
    path: "src/a.ts",
    beforeSha256: SHA,
    replacements: [{ oldText: "before", newText: "after" }],
  },
  "fs.glob": { pattern: "**/*.ts" },
  "fs.list": {},
  "fs.read": { path: "README.md" },
  "fs.search": { query: "needle" },
  "fs.write": {
    path: "out.txt",
    content: "value",
    precondition: { kind: "absent" },
  },
  "git.inspect": { operation: "status" },
  "process.exec": {
    mode: "direct",
    executable: "git",
    args: ["status"],
  },
}

function providerDefinition(definition: ToolDefinition): ProviderToolDefinition {
  const original = definition.inputSchema
  const branches = [
    ...(Array.isArray(original.oneOf) ? original.oneOf : []),
    ...(Array.isArray(original.anyOf) ? original.anyOf : []),
  ]
  const names = [
    ...new Set(
      branches.flatMap((branch) => {
        if (typeof branch !== "object" || branch === null || Array.isArray(branch)) return []
        const properties = (branch as Record<string, unknown>).properties
        return typeof properties === "object" && properties !== null && !Array.isArray(properties)
          ? Object.keys(properties)
          : []
      }),
    ),
  ]
  const inputSchema =
    original.type === "object" && original.additionalProperties === false
      ? original
      : {
          ...original,
          type: "object",
          properties: Object.fromEntries(names.map((name) => [name, {}])),
          additionalProperties: false,
        }
  return ProviderToolDefinitionSchema.parse({
    name: definition.name,
    description: definition.description,
    inputSchema,
  })
}

describe("OpenAI strict Ralph tool compiler", () => {
  test("round-trips all ten real ToolHost definitions through provider-safe aliases", () => {
    const registry = createBuiltinToolRegistry()
    const policy = ToolPolicySchema.parse({
      schemaVersion: 1,
      role: "executor",
      securityMode: "auto",
      interactive: false,
      readScopes: ["."],
      writeScopes: ["."],
      protectedPaths: [".ralph"],
      commandRules: [],
      limits: {},
    })
    const definitions = registry.definitions(policy)
    expect(definitions).toHaveLength(10)
    const codec = new OpenAiStrictToolCodec(definitions.map(providerDefinition))

    for (const [index, definition] of definitions.entries()) {
      const registered = registry.get(definition.name)
      if (!registered) throw new Error(`Missing registered tool ${definition.name}`)
      const originalInput = registered.inputSchema.parse(samples[definition.name]) as Record<
        string,
        unknown
      >
      const encoded = codec.encodeFunctionCall({
        name: definition.name,
        argumentsJson: JSON.stringify(originalInput),
      })
      expect(encoded.name).toMatch(/^ralph_[A-Za-z0-9_-]+_[a-f0-9]{12}$/)
      expect(encoded.name).not.toContain(".")
      const providerInput = JSON.parse(encoded.argumentsJson) as Record<string, unknown>
      const decoded = codec.decodeToolCall({
        itemId: `item-${index}`,
        callId: `call-${index}`,
        name: encoded.name,
        input: providerInput,
        argumentsJson: encoded.argumentsJson,
      })
      expect(decoded.name).toBe(definition.name)
      expect(registered.inputSchema.parse(decoded.input)).toEqual(originalInput)
      validateOpenAiStrictSchema(codec.tools[index]?.parameters ?? {})
    }

    const processIndex = definitions.findIndex((definition) => definition.name === "process.exec")
    const encodedProcess = codec.encodeFunctionCall({
      name: "process.exec",
      argumentsJson: JSON.stringify(
        registry.get("process.exec")?.inputSchema.parse(samples["process.exec"]),
      ),
    })
    const processEnvelope = JSON.parse(encodedProcess.argumentsJson) as {
      input: Record<string, unknown>
    }
    expect(processEnvelope.input).not.toHaveProperty("environmentRefs")
    expect(JSON.stringify(codec.tools[processIndex]?.parameters)).not.toContain("environmentRefs")
    expect(codec.tools[processIndex]?.parameters).toMatchObject({
      type: "object",
      required: ["input"],
      additionalProperties: false,
    })
  })

  test("turns optional properties into nullable required fields and removes null before ToolHost", () => {
    const codec = new OpenAiStrictToolCodec([
      ProviderToolDefinitionSchema.parse({
        name: "fs.read",
        description: "read",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            limitBytes: { type: "integer" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      }),
    ])
    const schema = codec.tools[0]?.parameters as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(schema.required).toEqual(["path", "limitBytes"])
    expect(schema.properties.limitBytes).toMatchObject({
      anyOf: [{ type: "integer" }, { type: "null" }],
    })
    const decoded = codec.decodeToolCall({
      itemId: "item",
      callId: "call",
      name: codec.providerName("fs.read"),
      input: { path: "README.md", limitBytes: null },
      argumentsJson: '{"path":"README.md","limitBytes":null}',
    })
    expect(decoded.input).toEqual({ path: "README.md" })
    expect(() =>
      codec.decodeToolCall({
        itemId: "item-missing",
        callId: "call-missing",
        name: codec.providerName("fs.read"),
        input: { path: "README.md" },
        argumentsJson: '{"path":"README.md"}',
      }),
    ).toThrow("omitted a strict property")
  })
})
