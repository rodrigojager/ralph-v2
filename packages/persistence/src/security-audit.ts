import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import { redactText, secretValuesFromEnvironment } from "@ralph-next/telemetry"
import { appendEvent } from "./ledger"

export type SecurityAuditScope = {
  workspaceId: string
  runId: string
  documentId?: string
  taskId?: string
  attemptId?: string
  workerId?: string
}

function bounded(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 4_096 || /[\0\r\n]/.test(normalized)) {
    throw new RalphError("RALPH_SECURITY_AUDIT_INVALID", `${name} is invalid`, {
      exitCode: EXIT_CODES.invalidUsage,
      details: { name },
    })
  }
  return normalized
}

export function persistSecurityPolicyAudit(input: {
  ledgerPath: string
  scope: SecurityAuditScope
  diagnostics: Readonly<Record<string, unknown>>
}): void {
  appendEvent(input.ledgerPath, {
    type: "security.policy.effective",
    scope: "run",
    streamId: input.scope.runId,
    workspaceId: input.scope.workspaceId,
    runId: input.scope.runId,
    ...(input.scope.documentId ? { documentId: input.scope.documentId } : {}),
    ...(input.scope.taskId ? { taskId: input.scope.taskId } : {}),
    ...(input.scope.attemptId ? { attemptId: input.scope.attemptId } : {}),
    ...(input.scope.workerId ? { workerId: input.scope.workerId } : {}),
    level: input.diagnostics.dangerousOverride === true ? "warn" : "info",
    payload: { schemaVersion: 1, diagnostics: input.diagnostics },
  })
}

export function persistSecurityDecisionAudit(input: {
  ledgerPath: string
  scope: SecurityAuditScope
  kind: "command" | "network" | "external-effect" | "sandbox" | "scope-expansion"
  action: "allow" | "deny" | "ask" | "pause"
  reason: string
  auditedOverride: boolean
  rule?: string
  requestHash?: string
  targetDescriptor?: string
  secretValues?: readonly string[]
}): void {
  const secrets = [...secretValuesFromEnvironment(), ...(input.secretValues ?? [])]
  appendEvent(input.ledgerPath, {
    type: "security.decision",
    scope: "run",
    streamId: input.scope.runId,
    workspaceId: input.scope.workspaceId,
    runId: input.scope.runId,
    ...(input.scope.documentId ? { documentId: input.scope.documentId } : {}),
    ...(input.scope.taskId ? { taskId: input.scope.taskId } : {}),
    ...(input.scope.attemptId ? { attemptId: input.scope.attemptId } : {}),
    ...(input.scope.workerId ? { workerId: input.scope.workerId } : {}),
    level:
      input.action === "deny" || input.action === "pause" || input.auditedOverride
        ? "warn"
        : "info",
    payload: {
      schemaVersion: 1,
      kind: input.kind,
      action: input.action,
      reason: redactText(bounded(input.reason, "reason"), secrets),
      auditedOverride: input.auditedOverride,
      ...(input.rule ? { rule: bounded(input.rule, "rule") } : {}),
      ...(input.requestHash ? { requestHash: bounded(input.requestHash, "requestHash") } : {}),
      ...(input.targetDescriptor
        ? {
            targetDescriptor: redactText(
              bounded(input.targetDescriptor, "targetDescriptor"),
              secrets,
            ),
          }
        : {}),
    },
  })
}
