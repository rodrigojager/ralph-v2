import { redactValue } from "@ralph/telemetry"
import { z } from "zod"
import type {
  ArtifactPublisherPort,
  PermissionFacts,
  PermissionPromptPort,
  ProcessExecutorPort,
  ToolAuthorization,
  ToolCall,
  ToolCallRecord,
  ToolDefinition,
  ToolEvent,
  ToolEventSink,
  ToolJournal,
  ToolRecoveryClassification,
  ToolSession,
  ToolSettlement,
} from "./contracts"
import {
  ToolAuthorizationSchema,
  ToolCallSchema,
  ToolPolicySchema,
  ToolSettlementSchema,
} from "./contracts"
import { errorMessage, ToolEffectUnsettledError, ToolHostError } from "./errors"
import { hashCanonical } from "./hash"
import { WorkspacePathResolver } from "./path-resolver"
import { authorizeToolCall } from "./permissions"
import type { RegisteredTool, ToolExecutionResult, ToolRegistry } from "./registry"

export type ToolHostOptions = {
  registry: ToolRegistry
  journal: ToolJournal
  process: ProcessExecutorPort
  artifacts: ArtifactPublisherPort
  events: ToolEventSink
  prompt?: PermissionPromptPort
  now?: () => string
}

function initialRecovery(risk: ToolCallRecord["risk"]): ToolRecoveryClassification {
  switch (risk) {
    case "read":
      return "safe-to-retry"
    case "write":
      return "reconcile-by-precondition"
    case "process":
    case "network":
    case "external-effect":
      return "unknown-external-effect"
    case "destructive":
      return "manual-review"
  }
}

function invalidFacts(risk: ToolCallRecord["risk"]): PermissionFacts {
  return {
    risk,
    mutatesWorkspace: risk !== "read",
    pathProtected: false,
    pathInReadScope: false,
    pathInWriteScope: false,
    shell: false,
  }
}

function errorResult(error: unknown): ToolExecutionResult {
  if (error instanceof ToolHostError) {
    return {
      outcome: error.outcome,
      content: error.content ?? { code: error.code, message: error.message },
      outputRefs: error.outputRefs,
      effects: error.effects,
      retryable: error.retryable,
      recovery: error.recovery,
      reason: error.message,
    }
  }
  return {
    outcome: "error",
    content: { code: "RALPH_TOOL_UNEXPECTED", message: errorMessage(error) },
    retryable: false,
    recovery: "manual-review",
    reason: errorMessage(error),
  }
}

export class ToolHost {
  readonly #registry: ToolRegistry
  readonly #journal: ToolJournal
  readonly #process: ProcessExecutorPort
  readonly #artifacts: ArtifactPublisherPort
  readonly #events: ToolEventSink
  readonly #prompt: PermissionPromptPort | undefined
  readonly #now: () => string

  constructor(options: ToolHostOptions) {
    this.#registry = options.registry
    this.#journal = options.journal
    this.#process = options.process
    this.#artifacts = options.artifacts
    this.#events = options.events
    this.#prompt = options.prompt
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async materialize(session: ToolSession): Promise<readonly ToolDefinition[]> {
    return this.#registry.definitions(ToolPolicySchema.parse(session.policy))
  }

  async execute(callInput: ToolCall, session: ToolSession): Promise<ToolSettlement> {
    const call = ToolCallSchema.parse(callInput)
    const policy = ToolPolicySchema.parse(session.policy)
    const now = this.#now()
    const registered = this.#registry.get(call.name)
    const risk = registered?.definition.risk ?? "external-effect"
    const argumentsHash = hashCanonical("ralph.tool.arguments.v1", call.arguments)
    const record: ToolCallRecord = {
      schemaVersion: 1,
      id: call.id,
      attemptId: session.attemptId,
      modelCallId: call.modelCallId,
      providerToolCallId: call.providerToolCallId,
      tool: call.name,
      argumentsHash,
      argumentsRedacted: redactValue(call.arguments, session.secretValues ?? []),
      idempotencyKey:
        call.idempotencyKey ??
        hashCanonical("ralph.tool.idempotency.v1", {
          attemptId: session.attemptId,
          modelCallId: call.modelCallId,
          providerToolCallId: call.providerToolCallId,
        }),
      risk,
      status: "requested",
      effects: [],
      recovery: initialRecovery(risk),
      requestedAt: call.requestedAt,
      updatedAt: now,
    }
    const reserved = await this.#journal.reserve({
      record,
      maximumToolCalls: Math.max(0, Math.trunc(session.maximumToolCalls)),
    })
    if (reserved.status === "budget-exhausted") {
      return this.#settlement(call.id, Date.now(), {
        outcome: "denied",
        content: { code: "RALPH_TOOL_BUDGET_EXHAUSTED" },
        recovery: "effect-absent",
        reason: "Maximum tool calls for this attempt was reached",
      })
    }
    if (reserved.status === "duplicate") {
      if (reserved.settlement) return reserved.settlement
      return this.#settlement(call.id, Date.now(), {
        outcome: "unsettled",
        content: {
          code: "RALPH_TOOL_CALL_UNSETTLED",
          status: reserved.record.status,
        },
        recovery: reserved.record.recovery,
        reason: "Duplicate provider tool call has no durable settlement and was not replayed",
      })
    }

    await this.#emit(
      {
        type: "tool.call.requested",
        toolCallId: call.id,
        payload: { tool: call.name, argumentsHash, risk },
      },
      session,
    )

    if (call.modelCallId !== session.modelCallId) {
      return this.#denyInvalid(
        call,
        argumentsHash,
        risk,
        "Model call identity does not match the active command-owned session",
        session,
      )
    }
    if (!registered) {
      return this.#denyInvalid(call, argumentsHash, risk, `Unknown tool: ${call.name}`, session)
    }
    if (policy.allowedTools && !policy.allowedTools.includes(call.name)) {
      return this.#denyInvalid(
        call,
        argumentsHash,
        risk,
        `Tool is not materialized for this session: ${call.name}`,
        session,
      )
    }

    const parsed = registered.inputSchema.safeParse(call.arguments)
    if (!parsed.success) {
      return this.#denyInvalid(call, argumentsHash, risk, z.prettifyError(parsed.error), session)
    }

    const resolver = await WorkspacePathResolver.create(session.workspaceRoot, policy)
    const context = {
      toolCallId: call.id,
      argumentsHash: record.argumentsHash,
      idempotencyKey: record.idempotencyKey,
      session: { ...session, policy },
      policy,
      resolver,
      process: this.#process,
      artifacts: this.#artifacts,
      events: this.#events,
    }
    let assessment: Awaited<ReturnType<RegisteredTool["assess"]>>
    try {
      assessment = await registered.assess(parsed.data, context)
    } catch (error) {
      return this.#denyInvalid(call, argumentsHash, risk, errorMessage(error), session)
    }
    let authorization: ToolAuthorization
    try {
      authorization = await authorizeToolCall({
        call,
        argumentsHash,
        policy,
        facts: assessment.facts,
        ...(this.#prompt ? { prompt: this.#prompt } : {}),
        ...(session.signal ? { signal: session.signal } : {}),
        now: this.#now,
      })
    } catch (error) {
      return this.#denyInvalid(
        call,
        argumentsHash,
        assessment.facts.risk,
        errorMessage(error),
        session,
      )
    }
    await this.#journal.authorize(call.id, authorization)
    await this.#emit(
      {
        type: "tool.call.authorized",
        toolCallId: call.id,
        payload: {
          action: authorization.action,
          reason: authorization.reason,
          requestHash: authorization.requestHash,
        },
      },
      session,
    )
    if (authorization.action !== "allow") {
      const settlement = this.#settlement(call.id, Date.now(), {
        outcome: "denied",
        content: { authorization },
        recovery: "effect-absent",
        reason: authorization.reason,
      })
      await this.#journal.settle(call.id, settlement)
      await this.#emitSettlement(settlement, session)
      return settlement
    }

    const started = Date.now()
    await this.#journal.start(call.id, this.#now())
    await this.#emit(
      { type: "tool.call.started", toolCallId: call.id, payload: { tool: call.name } },
      session,
    )
    let result: ToolExecutionResult
    try {
      result = await registered.execute(parsed.data, context)
    } catch (error) {
      if (error instanceof ToolEffectUnsettledError) throw error
      result = errorResult(error)
    }
    const settlement = this.#settlement(call.id, started, result)
    await this.#journal.settle(call.id, settlement)
    await this.#emitSettlement(settlement, session)
    return settlement
  }

  async #denyInvalid(
    call: ToolCall,
    argumentsHash: string,
    risk: ToolCallRecord["risk"],
    reason: string,
    session: ToolSession,
  ): Promise<ToolSettlement> {
    const projection = {
      toolCallId: call.id,
      tool: call.name,
      argumentsHash,
      risk,
      role: session.policy.role,
      securityMode: session.policy.securityMode,
      reason,
    }
    const authorization = ToolAuthorizationSchema.parse({
      schemaVersion: 1,
      requestId: `invalid-${call.id}`,
      requestHash: hashCanonical("ralph.tool.permission-request.v1", projection),
      action: "deny",
      reason,
      auditedOverride: false,
      decidedAt: this.#now(),
    })
    await this.#journal.authorize(call.id, authorization)
    await this.#emit(
      {
        type: "tool.call.authorized",
        toolCallId: call.id,
        payload: { action: "deny", reason, invalidFacts: invalidFacts(risk) },
      },
      session,
    )
    const settlement = this.#settlement(call.id, Date.now(), {
      outcome: "invalid",
      content: { code: "RALPH_TOOL_CALL_INVALID", reason },
      recovery: "effect-absent",
      reason,
    })
    await this.#journal.settle(call.id, settlement)
    await this.#emitSettlement(settlement, session)
    return settlement
  }

  #settlement(toolCallId: string, started: number, result: ToolExecutionResult): ToolSettlement {
    return ToolSettlementSchema.parse({
      schemaVersion: 1,
      toolCallId,
      outcome: result.outcome ?? "success",
      content: result.content,
      outputRefs: [...(result.outputRefs ?? [])],
      effects: [...(result.effects ?? [])],
      durationMs: Math.max(0, Date.now() - started),
      retryable: result.retryable ?? false,
      recovery: result.recovery,
      ...(result.reason ? { reason: result.reason } : {}),
      settledAt: this.#now(),
    })
  }

  async #emitSettlement(settlement: ToolSettlement, session: ToolSession): Promise<void> {
    await this.#emit(
      {
        type: "tool.call.settled",
        level: settlement.outcome === "success" ? "info" : "warn",
        toolCallId: settlement.toolCallId,
        payload: {
          outcome: settlement.outcome,
          effects: settlement.effects,
          outputRefs: settlement.outputRefs,
          recovery: settlement.recovery,
          durationMs: settlement.durationMs,
          reason: settlement.reason,
        },
      },
      session,
    )
  }

  async #emit(event: ToolEvent, session: ToolSession): Promise<void> {
    await this.#events.emit({
      ...event,
      payload: redactValue(event.payload, session.secretValues ?? []) as Readonly<
        Record<string, unknown>
      >,
    })
  }
}
