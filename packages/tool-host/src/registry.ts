import { z } from "zod"
import type {
  ArtifactPublisherPort,
  PermissionFacts,
  ProcessExecutorPort,
  ToolDefinition,
  ToolEffect,
  ToolEventSink,
  ToolPolicy,
  ToolRecoveryClassification,
  ToolSession,
  ToolSettlementOutcome,
} from "./contracts"
import { ToolDefinitionSchema } from "./contracts"
import { ToolHostError } from "./errors"
import type { WorkspacePathResolver } from "./path-resolver"

export type ToolExecutionResult = {
  outcome?: ToolSettlementOutcome
  content: unknown
  outputRefs?: readonly string[]
  effects?: readonly ToolEffect[]
  retryable?: boolean
  recovery: ToolRecoveryClassification
  reason?: string
}

export type ToolRuntimeContext = {
  toolCallId: string
  /** Immutable journal binding selected by the command-owned ToolHost. */
  argumentsHash: string
  /** Immutable idempotency key selected by the command-owned ToolHost. */
  idempotencyKey: string
  session: ToolSession
  policy: ToolPolicy
  resolver: WorkspacePathResolver
  process: ProcessExecutorPort
  artifacts: ArtifactPublisherPort
  events: ToolEventSink
}

export type ToolAssessment = {
  facts: PermissionFacts
  reason: string
}

export type RegisteredTool = {
  definition: ToolDefinition
  inputSchema: z.ZodType
  assess(input: unknown, context: ToolRuntimeContext): ToolAssessment | Promise<ToolAssessment>
  execute(input: unknown, context: ToolRuntimeContext): Promise<ToolExecutionResult>
}

function definitionFor(tool: Omit<RegisteredTool, "definition"> & { definition: ToolDefinition }) {
  return ToolDefinitionSchema.parse(tool.definition)
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>()

  register(tool: RegisteredTool): void {
    const definition = definitionFor(tool)
    if (this.#tools.has(definition.name)) {
      throw new ToolHostError(
        "RALPH_TOOL_REGISTRY_DUPLICATE",
        `Tool is already registered: ${definition.name}`,
        "invalid",
      )
    }
    this.#tools.set(definition.name, { ...tool, definition })
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name)
  }

  definitions(policy: ToolPolicy): readonly ToolDefinition[] {
    const allowed = policy.allowedTools ? new Set(policy.allowedTools) : undefined
    return [...this.#tools.values()]
      .filter((tool) => !allowed || allowed.has(tool.definition.name))
      .filter((tool) => policy.toolRules[tool.definition.name] !== "deny")
      .filter(
        (tool) =>
          policy.role !== "judge" ||
          (tool.definition.risk === "read" && !tool.definition.mutatesWorkspace),
      )
      .map((tool) => tool.definition)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  names(): readonly string[] {
    return [...this.#tools.keys()].sort()
  }
}

export function jsonInputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<
    string,
    unknown
  >
}
