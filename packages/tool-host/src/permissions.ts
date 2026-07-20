import { randomUUID } from "node:crypto"
import type {
  PermissionFacts,
  PermissionPromptPort,
  ToolAuthorization,
  ToolAuthorizationAction,
  ToolCall,
  ToolPermissionRequest,
  ToolPolicy,
} from "./contracts"
import {
  ToolAuthorizationSchema,
  ToolPermissionRequestSchema,
  ToolPermissionResponseSchema,
} from "./contracts"
import { ToolHostError } from "./errors"
import { hashCanonical } from "./hash"

export type PermissionRuleDecision = {
  action: ToolAuthorizationAction
  reason: string
  ruleId?: string
  auditedOverride: boolean
}

export function decideToolPermission(
  policy: ToolPolicy,
  facts: PermissionFacts,
  toolName?: string,
): PermissionRuleDecision {
  if (facts.pathProtected) {
    return {
      action: "deny",
      reason: "Control-plane and explicitly protected paths are never tool-writable or readable",
      auditedOverride: false,
    }
  }
  if (policy.role === "judge" && (facts.mutatesWorkspace || facts.risk !== "read")) {
    return {
      action: "deny",
      reason: "Judge sessions are read-only and cannot receive mutable or process capabilities",
      auditedOverride: false,
    }
  }
  if (facts.shell && !policy.allowShell) {
    return {
      action: "deny",
      reason: "Shell execution is disabled by the effective command-owned policy",
      auditedOverride: false,
    }
  }
  if (facts.risk === "read" && !facts.pathInReadScope) {
    return {
      action: "deny",
      reason: "Read is outside all authorized scopes",
      auditedOverride: false,
    }
  }
  if (facts.risk === "write" && !facts.pathInWriteScope) {
    return {
      action: "deny",
      reason: "Write is outside all authorized scopes",
      auditedOverride: false,
    }
  }
  if (
    facts.mutatesWorkspace &&
    (facts.risk === "process" || facts.risk === "destructive") &&
    !facts.pathInWriteScope
  ) {
    return {
      action: "deny",
      reason: "Process working directory is outside all authorized write scopes",
      auditedOverride: false,
    }
  }
  if (toolName === "artifact.publish" && !facts.pathInReadScope) {
    return {
      action: "deny",
      reason: "Artifact source is outside all authorized read scopes",
      auditedOverride: false,
    }
  }
  const nominalRule = toolName ? policy.toolRules[toolName] : undefined
  if (nominalRule === "deny") {
    return {
      action: "deny",
      reason: `Named tool policy denies ${toolName}`,
      ruleId: `tool:${toolName}`,
      auditedOverride: false,
    }
  }
  if (nominalRule === "ask") {
    return {
      action: "ask",
      reason: `Named tool policy requires confirmation for ${toolName}`,
      ruleId: `tool:${toolName}`,
      auditedOverride: false,
    }
  }
  if (facts.risk === "read") {
    return {
      action: "allow",
      reason:
        nominalRule === "allow"
          ? `Named tool policy allows ${toolName} inside the authorized scope`
          : "Read is contained by an authorized scope",
      ...(nominalRule === "allow" ? { ruleId: `tool:${toolName}` } : {}),
      auditedOverride: false,
    }
  }
  if (facts.risk === "write") {
    return {
      action: "allow",
      reason:
        nominalRule === "allow"
          ? `Named tool policy allows ${toolName} inside the authorized scope`
          : "Preconditioned write is contained by an authorized scope",
      ...(nominalRule === "allow" ? { ruleId: `tool:${toolName}` } : {}),
      auditedOverride: false,
    }
  }
  if (facts.risk === "destructive" || facts.commandRuleRisk === "destructive") {
    if (policy.securityMode === "safe") {
      return {
        action: "deny",
        reason: "Safe security mode denies destructive operations",
        auditedOverride: false,
      }
    }
    if (policy.securityMode === "dangerous" && policy.allowDestructive && facts.commandRuleId) {
      return {
        action: "allow",
        reason: "Explicit dangerous-mode rule authorizes this destructive command",
        ruleId: facts.commandRuleId,
        auditedOverride: true,
      }
    }
    return {
      action: "ask",
      reason: "Destructive operation requires an explicit per-call decision",
      ...(facts.commandRuleId ? { ruleId: facts.commandRuleId } : {}),
      auditedOverride: true,
    }
  }
  if (facts.risk === "process") {
    if (facts.commandRuleId) {
      return {
        action: "allow",
        reason: "Command matches an explicit executable and argv rule",
        ruleId: facts.commandRuleId,
        auditedOverride: false,
      }
    }
    if (policy.securityMode === "safe") {
      return {
        action: "deny",
        reason:
          "Safe security mode requires an explicit executable and argv rule; a named tool allow cannot authorize an unlisted command",
        auditedOverride: false,
      }
    }
    if (policy.securityMode === "dangerous" && policy.allowUnlistedProcess) {
      return {
        action: "allow",
        reason: "Dangerous mode explicitly permits unlisted process execution",
        auditedOverride: true,
      }
    }
    return {
      action: "ask",
      reason: "Unlisted process execution requires an explicit per-call decision",
      auditedOverride: policy.securityMode === "dangerous",
    }
  }
  if (nominalRule === "allow") {
    return {
      action: "allow",
      reason: `Named tool policy allows ${toolName} after hard invariants`,
      ruleId: `tool:${toolName}`,
      auditedOverride: true,
    }
  }
  return policy.securityMode === "auto" || policy.securityMode === "dangerous"
    ? {
        action: "ask",
        reason: "Network and external-effect tools require an explicit per-call decision",
        auditedOverride: policy.securityMode === "dangerous",
      }
    : {
        action: "deny",
        reason: "Safe mode denies network and external-effect tools without a named allow rule",
        auditedOverride: false,
      }
}

export async function authorizeToolCall(input: {
  call: ToolCall
  argumentsHash: string
  policy: ToolPolicy
  facts: PermissionFacts
  prompt?: PermissionPromptPort
  signal?: AbortSignal
  now?: () => string
}): Promise<ToolAuthorization> {
  const now = input.now ?? (() => new Date().toISOString())
  const decision = decideToolPermission(input.policy, input.facts, input.call.name)
  const requestProjection = {
    toolCallId: input.call.id,
    tool: input.call.name,
    argumentsHash: input.argumentsHash,
    risk: input.facts.risk,
    role: input.policy.role,
    securityMode: input.policy.securityMode,
    reason: decision.reason,
  }
  const requestHash = hashCanonical("ralph.tool.permission-request.v1", requestProjection)
  const requestId = `permission-${randomUUID()}`
  if (decision.action !== "ask") {
    return ToolAuthorizationSchema.parse({
      schemaVersion: 1,
      requestId,
      requestHash,
      action: decision.action,
      reason: decision.reason,
      ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
      auditedOverride: decision.auditedOverride,
      decidedAt: now(),
    })
  }

  const request: ToolPermissionRequest = ToolPermissionRequestSchema.parse({
    schemaVersion: 1,
    id: requestId,
    requestHash,
    ...requestProjection,
    requestedAt: now(),
  })
  if (!input.policy.interactive) {
    const allowed = input.policy.headlessAsk === "allow"
    return ToolAuthorizationSchema.parse({
      schemaVersion: 1,
      requestId,
      requestHash,
      action: allowed ? "allow" : "deny",
      reason: allowed
        ? "Headless ask was explicitly configured to allow and remains audited"
        : "Headless ask defaults to deny; no invisible prompt was opened",
      ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
      auditedOverride: allowed || decision.auditedOverride,
      decidedAt: now(),
    })
  }
  if (!input.prompt) {
    throw new ToolHostError(
      "RALPH_TOOL_PERMISSION_PROMPT_UNAVAILABLE",
      "Interactive permission requires a command-owned prompt port",
      "denied",
    )
  }
  const response = ToolPermissionResponseSchema.parse(
    await input.prompt.request(request, input.signal),
  )
  if (response.requestId !== request.id || response.requestHash !== request.requestHash) {
    throw new ToolHostError(
      "RALPH_TOOL_PERMISSION_RESPONSE_MISMATCH",
      "Permission response is not bound to the pending request",
      "denied",
    )
  }
  return ToolAuthorizationSchema.parse({
    schemaVersion: 1,
    requestId,
    requestHash,
    action: response.action,
    reason: response.reason,
    ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
    auditedOverride: decision.auditedOverride,
    decidedAt: response.respondedAt,
  })
}
