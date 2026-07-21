import type { DurableLeaseRecord, RunStatus } from "@ralph/domain"

export type SupervisorStopRequest = {
  readonly requestId: string
  readonly mode: "graceful" | "force"
  readonly reason: string
  readonly graceMs?: number
  readonly requestedAt: string
}

export type SupervisorStopReceipt = {
  readonly previousStatus: RunStatus
  readonly status: RunStatus
  readonly disposition: "requested" | "already-requested" | "already-terminal"
  readonly requestedAt: string
  readonly delivery: "supervisor"
}

export type SupervisorContextRotation = {
  readonly requestId: string
  readonly reason: string
  readonly requestedAt: string
}

export type SupervisorContextRotationBoundary = "next-model-call" | "next-task"

export type SupervisorContextRotationReceipt = {
  readonly disposition: "requested" | "already-requested" | "not-applicable"
  readonly requestedAt: string
  readonly nextBoundary: SupervisorContextRotationBoundary
}

export type RunSupervisorActivation = {
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly runId: string
  readonly ownerInstanceId: string
  readonly lease: DurableLeaseRecord
  readonly onStop: (request: SupervisorStopRequest) => Promise<SupervisorStopReceipt>
  readonly onContextRotation: (
    request: SupervisorContextRotation,
  ) => Promise<SupervisorContextRotationReceipt>
}

/**
 * Live command-owned control session. The adapter owns transport identity and
 * cancellation of subordinate process trees; the runner remains the only
 * caller allowed to apply official run/task/attempt transitions.
 */
export interface RunSupervisorControlSession {
  readonly signal: AbortSignal
  takeContextRotation(
    boundary: SupervisorContextRotationBoundary,
  ): SupervisorContextRotation | undefined
  pendingContextRotations(): readonly SupervisorContextRotation[]
  close(): Promise<void>
}

export interface RunSupervisorControlPort {
  activate(input: RunSupervisorActivation): Promise<RunSupervisorControlSession>
}
