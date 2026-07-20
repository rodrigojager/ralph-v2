import type { VerificationSkipPolicy, VerificationSpec } from "@ralph-next/prd"
import type { GateExecutorRegistry } from "./gate-registry"

export type VerificationStatus =
  | "passed"
  | "failed"
  | "timeout"
  | "error"
  | "skipped_by_cli"
  | "skipped_by_policy"
  | "not_applicable"
  | "unavailable"

export type VerificationResult = {
  gateId: string
  category: string
  blocking: boolean
  skipPolicy?: VerificationSkipPolicy
  criterionIds?: string[]
  status: VerificationStatus
  command?: Extract<VerificationSpec, { type: "command" }>["command"]
  exitCode?: number
  durationMs: number
  attempts?: number
  outputRefs: string[]
  stdoutBytes?: number
  stderrBytes?: number
  outputTruncated?: boolean
  rawOutputTruncated?: boolean
  deadlineExceeded?: boolean
  reason?: string
  overridden: boolean
}

export type VerificationRunOptions = {
  workspaceRoot: string
  /** Command-owned cancellation propagated to every gate attempt. */
  signal?: AbortSignal
  environment?: Record<string, string | undefined>
  environmentRoot?: string
  rawOutputLimitBytes?: number
  deadlineAt?: string
  platform?: NodeJS.Platform
  changedPaths?: ReadonlySet<string>
  skipTests?: boolean
  skipLint?: boolean
  skipGateIdsOrCategories?: ReadonlySet<string>
  noGates?: boolean
  fast?: boolean
  force?: boolean
  failFast?: boolean
  registry?: GateExecutorRegistry
  persistOutput?: (gateId: string, stream: "stdout" | "stderr", value: string) => Promise<string>
}

export type GateExecutionOutcome = {
  status: VerificationStatus
  command?: Extract<VerificationSpec, { type: "command" }>["command"]
  exitCode?: number
  outputRefs?: string[]
  stdoutBytes?: number
  stderrBytes?: number
  outputTruncated?: boolean
  rawOutputTruncated?: boolean
  deadlineExceeded?: boolean
  reason?: string
}

export type GateExecutionContext = {
  workspaceRoot: string
  environment?: Record<string, string | undefined>
  environmentRoot?: string
  rawOutputLimitBytes?: number
  deadlineAt?: string
  signal: AbortSignal
  attempt: number
  registry: GateExecutorRegistry
  persistOutput?: VerificationRunOptions["persistOutput"]
}

export type GateExecutor<T extends VerificationSpec = VerificationSpec> = (
  specification: T,
  context: GateExecutionContext,
) => Promise<GateExecutionOutcome>

export type PluginGateExecutor = GateExecutor<Extract<VerificationSpec, { type: "plugin" }>>
