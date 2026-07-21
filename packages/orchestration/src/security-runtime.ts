import { createHash } from "node:crypto"
import { basename } from "node:path"
import {
  EXIT_CODES,
  type ExternalEffectRule,
  type NetworkPolicy,
  RalphError,
  type SecurityPolicySnapshot,
  SecurityPolicySnapshotSchema,
} from "@ralph/domain"

export type SecurityDecision = {
  action: "allow" | "deny"
  reason: string
  auditedOverride: boolean
  rule?: string
}

export type ExternalEffectRequest = {
  requestId: string
  capability: string
  operation: string
  target: string
  summary: string
  idempotencyKey?: string
  irreversible: boolean
}

export interface ExternalEffectPromptPort {
  request(input: {
    requestId: string
    requestHash: string
    capability: string
    operation: string
    target: string
    summary: string
    irreversible: boolean
  }): Promise<{ requestId: string; requestHash: string; action: "allow" | "deny"; reason: string }>
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`
}

function requestHash(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(`${namespace}\0${canonicalJson(value)}`)
    .digest("hex")
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

export function materializeSecurityPolicy(input: {
  profile: "safe" | "auto" | "dangerous"
  interactive: boolean
  headlessAsk?: "deny" | "allow"
  commandAllowlist?: readonly string[]
  network?: NetworkPolicy
  externalEffects?: readonly ExternalEffectRule[]
  dangerousOverrideReason?: string
  role: "executor" | "judge"
}): SecurityPolicySnapshot {
  if (input.role === "judge") {
    return SecurityPolicySnapshotSchema.parse({
      schemaVersion: 1,
      role: "judge",
      profile: input.profile,
      interactive: input.interactive,
      headlessAsk: "deny",
      commandAllowlist: [],
      network: { mode: "none", destinations: [] },
      externalEffects: [],
      destructiveOperations: false,
      judgeReadOnly: true,
      ...(input.profile === "dangerous"
        ? {
            dangerousOverrideReason:
              input.dangerousOverrideReason ??
              "Dangerous executor profile does not weaken the judge read-only boundary",
          }
        : {}),
    })
  }
  const defaultNetwork: NetworkPolicy = { mode: "none", destinations: [] }
  const network = input.network ?? defaultNetwork
  if (network.mode === "full" && input.profile !== "dangerous") {
    throw new RalphError(
      "RALPH_SECURITY_NETWORK_POLICY_INVALID",
      "Full network access requires the dangerous profile and remains audited",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  return SecurityPolicySnapshotSchema.parse({
    schemaVersion: 1,
    role: "executor",
    profile: input.profile,
    interactive: input.interactive,
    headlessAsk: input.headlessAsk ?? "deny",
    commandAllowlist: distinct(input.commandAllowlist ?? []),
    network,
    externalEffects: input.externalEffects ?? [],
    destructiveOperations: false,
    judgeReadOnly: true,
    ...(input.profile === "dangerous"
      ? { dangerousOverrideReason: input.dangerousOverrideReason }
      : {}),
  })
}

function canonicalDestination(value: string): { kind: "origin" | "host"; value: string } {
  const candidate = value.trim()
  if (!candidate || /[\0\s]/.test(candidate)) {
    throw new RalphError(
      "RALPH_SECURITY_NETWORK_DESTINATION_INVALID",
      "Network destination allowlist contains an invalid value",
      { exitCode: EXIT_CODES.invalidUsage, details: { destination: value } },
    )
  }
  if (candidate.includes(":")) {
    try {
      const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`)
      if (url.username || url.password || (url.protocol !== "https:" && url.protocol !== "http:")) {
        throw new Error("unsupported URL")
      }
      return { kind: "origin", value: url.origin.toLocaleLowerCase("und") }
    } catch (error) {
      throw new RalphError(
        "RALPH_SECURITY_NETWORK_DESTINATION_INVALID",
        "Network destination must be a hostname or HTTP(S) origin without credentials",
        { exitCode: EXIT_CODES.invalidUsage, details: { destination: value }, cause: error },
      )
    }
  }
  return { kind: "host", value: candidate.toLocaleLowerCase("und") }
}

export function authorizeNetworkRequest(
  policy: SecurityPolicySnapshot,
  requestUrl: string,
): SecurityDecision {
  if (policy.role === "judge") {
    return {
      action: "deny",
      reason: "Judge policy does not receive network or external-effect capabilities",
      auditedOverride: false,
    }
  }
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return { action: "deny", reason: "Network URL is invalid", auditedOverride: false }
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      action: "deny",
      reason: "Only HTTP(S) network requests are supported",
      auditedOverride: false,
    }
  }
  if (url.username || url.password) {
    return {
      action: "deny",
      reason: "Credentials cannot be embedded in an authorized URL",
      auditedOverride: false,
    }
  }
  if (policy.network.mode === "none") {
    return { action: "deny", reason: "Effective network policy is none", auditedOverride: false }
  }
  if (policy.network.mode === "full") {
    return {
      action: "allow",
      reason: "Dangerous profile explicitly enables full network access",
      auditedOverride: true,
      rule: "network:full",
    }
  }
  const hostname = url.hostname.toLocaleLowerCase("und")
  const origin = url.origin.toLocaleLowerCase("und")
  for (const destination of policy.network.destinations) {
    const rule = canonicalDestination(destination)
    if (
      (rule.kind === "origin" && rule.value === origin) ||
      (rule.kind === "host" && rule.value === hostname)
    ) {
      return {
        action: "allow",
        reason: "Request matches an explicit network destination",
        auditedOverride: policy.profile === "dangerous",
        rule: `network:${destination}`,
      }
    }
  }
  return {
    action: "deny",
    reason: "Request does not match any explicit network destination",
    auditedOverride: false,
  }
}

function externalEffectRule(
  policy: SecurityPolicySnapshot,
  capability: string,
): ExternalEffectRule | undefined {
  return policy.externalEffects.find((rule) => rule.capability === capability)
}

export async function authorizeExternalEffect(input: {
  policy: SecurityPolicySnapshot
  request: ExternalEffectRequest
  prompt?: ExternalEffectPromptPort
}): Promise<SecurityDecision> {
  if (input.policy.role === "judge") {
    return {
      action: "deny",
      reason: "Judge sessions are read-only and cannot create external state",
      auditedOverride: false,
    }
  }
  const rule = externalEffectRule(input.policy, input.request.capability)
  if (!rule) {
    return {
      action: "deny",
      reason: "Generic network access does not authorize an external side effect",
      auditedOverride: false,
    }
  }
  if (rule.requireIdempotencyKey && !input.request.idempotencyKey) {
    return {
      action: "deny",
      reason: "External-effect rule requires an idempotency key",
      auditedOverride: false,
      rule: `external:${rule.capability}`,
    }
  }
  if (rule.action === "deny") {
    return {
      action: "deny",
      reason: `External-effect capability ${rule.capability} is denied`,
      auditedOverride: false,
      rule: `external:${rule.capability}`,
    }
  }
  if (rule.action === "allow") {
    return {
      action: "allow",
      reason: `Explicit capability rule allows ${input.request.operation}`,
      auditedOverride: input.policy.profile === "dangerous" || input.request.irreversible,
      rule: `external:${rule.capability}`,
    }
  }
  if (!input.policy.interactive) {
    const allowed = input.policy.headlessAsk === "allow"
    return {
      action: allowed ? "allow" : "deny",
      reason: allowed
        ? "Headless ask was explicitly configured to allow this capability and remains audited"
        : "Headless ask defaults to deny; no invisible permission prompt was opened",
      auditedOverride: allowed,
      rule: `external:${rule.capability}`,
    }
  }
  if (!input.prompt) {
    return {
      action: "deny",
      reason: "Interactive external effect requires a command-owned permission prompt",
      auditedOverride: false,
      rule: `external:${rule.capability}`,
    }
  }
  const projection = {
    requestId: input.request.requestId,
    capability: input.request.capability,
    operation: input.request.operation,
    target: input.request.target,
    summary: input.request.summary,
    irreversible: input.request.irreversible,
    idempotencyKey: input.request.idempotencyKey ?? null,
  }
  const hash = requestHash("ralph.external-effect.permission.v1", projection)
  const response = await input.prompt.request({ ...projection, requestHash: hash })
  if (response.requestId !== input.request.requestId || response.requestHash !== hash) {
    throw new RalphError(
      "RALPH_EXTERNAL_EFFECT_PERMISSION_MISMATCH",
      "External-effect permission response is not bound to the pending request",
      { exitCode: EXIT_CODES.policyDenied },
    )
  }
  return {
    action: response.action,
    reason: response.reason,
    auditedOverride: response.action === "allow",
    rule: `external:${rule.capability}`,
  }
}

export function assertAutomaticCommandIsNonDestructive(
  executable: string,
  args: readonly string[],
): void {
  const program = basename(executable.trim())
    .toLocaleLowerCase("und")
    .replace(/\.(?:exe|cmd|bat)$/i, "")
  const command = args[0]?.toLocaleLowerCase("und")
  const forbiddenGit =
    program === "git" &&
    ((command === "reset" && args.includes("--hard")) ||
      command === "clean" ||
      (command === "push" &&
        args.some(
          (arg) => arg === "--force" || arg === "-f" || arg.startsWith("--force-with-lease"),
        )))
  const forbiddenShellAdapter = [
    "powershell",
    "pwsh",
    "cmd",
    "command",
    "sh",
    "bash",
    "dash",
    "zsh",
    "fish",
  ].includes(program)
  const forbiddenDelete =
    ["rm", "rmdir", "del", "erase", "remove-item"].includes(program) &&
    args.some((arg) =>
      /^(?:-[^-]*r[^-]*|--recursive|\/s|-recurse(?::(?:true|\$true))?)$/i.test(arg),
    )
  if (forbiddenGit || forbiddenDelete || forbiddenShellAdapter) {
    throw new RalphError(
      "RALPH_AUTOMATIC_DESTRUCTIVE_COMMAND_FORBIDDEN",
      "Automatic execution cannot invoke an unaudited shell, reset, clean, force-push or recursively delete",
      {
        exitCode: EXIT_CODES.policyDenied,
        details: { executable, args },
        hint: forbiddenShellAdapter
          ? "Shell interpreters require a separately audited adapter; the direct-argv sandbox cannot inspect nested scripts honestly."
          : "Use an explicit previewed user command with an exact resolved target and separate audit event.",
      },
    )
  }
}

export function securityDiagnostics(policy: SecurityPolicySnapshot): Record<string, unknown> {
  const networkDestinations = policy.network.destinations.map((destination) => {
    try {
      return canonicalDestination(destination).value
    } catch {
      return "[invalid-destination]"
    }
  })
  return {
    role: policy.role,
    profile: policy.profile,
    interactive: policy.interactive,
    headlessAsk: policy.headlessAsk,
    commandAllowlistEntries: policy.commandAllowlist.length,
    networkMode: policy.network.mode,
    networkDestinationCount: networkDestinations.length,
    networkDestinations,
    externalEffectCapabilities: policy.externalEffects.map((rule) => ({
      capability: rule.capability,
      action: rule.action,
      requireIdempotencyKey: rule.requireIdempotencyKey,
    })),
    destructiveAutomation: "denied",
    judgeReadOnly: policy.judgeReadOnly,
    dangerousOverride: policy.profile === "dangerous",
    ...(policy.dangerousOverrideReason
      ? {
          dangerousOverrideReasonRecorded: true,
          dangerousOverrideReasonHash: requestHash(
            "ralph.security.dangerous-reason.v1",
            policy.dangerousOverrideReason,
          ),
        }
      : {}),
  }
}
