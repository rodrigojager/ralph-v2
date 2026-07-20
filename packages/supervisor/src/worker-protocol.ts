import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { isAbsolute } from "node:path"
import { redactValue } from "@ralph-next/telemetry"
import { z } from "zod"

const NonEmptyStringSchema = z.string().min(1).max(4_096)
const TimestampSchema = z.iso.datetime({ offset: true })
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const WORKER_PROTOCOL_VERSION = 1 as const
export const DEFAULT_MAX_WORKER_MESSAGE_BYTES = 2_097_152
export const MIN_WORKER_HEARTBEAT_INTERVAL_MS = 100
export const MAX_TIMER_DELAY_MS = 2_147_483_647

export const WorkerRoleSchema = z.enum([
  "executor-model",
  "judge",
  "tool-gate",
  "child-run",
  "git-integration",
])
export type WorkerRole = z.infer<typeof WorkerRoleSchema>

export const WorkerCapabilityActionSchema = z.enum([
  "model.execute",
  "judge.evaluate",
  "tool.execute",
  "gate.execute",
  "child.execute",
  "integration.execute",
])
export type WorkerCapabilityAction = z.infer<typeof WorkerCapabilityActionSchema>

export const WorkerCancellationCauseSchema = z.enum([
  "cancel-request",
  "deadline",
  "shutdown",
  "supervisor-disconnect",
])
export type WorkerCancellationCause = z.infer<typeof WorkerCancellationCauseSchema>

/**
 * Narrow worker-to-supervisor services. The durable process service never
 * grants spawn authority: the command supervisor revalidates the immutable
 * journal and exact-command bindings before owning the effect. Child-run calls
 * are limited to the shared budget and durable observation/event projection.
 */
export const WorkerParentCallMethodSchema = z.enum([
  "execution.reserve-model-call",
  "execution.execute-tool",
  "execution.emit-event",
  "judge.emit-event",
  "gate.persist-output",
  "tool.process.execute",
  "child.budget.reserve",
  "child.budget.report",
  "child.budget.mark-boundary",
  "child.observe",
  "child.project-event",
])
export type WorkerParentCallMethod = z.infer<typeof WorkerParentCallMethodSchema>

export function workerRoleAllowsCapability(
  role: WorkerRole,
  capability: WorkerCapabilityAction,
): boolean {
  switch (role) {
    case "executor-model":
      return capability === "model.execute"
    case "judge":
      return capability === "judge.evaluate"
    case "tool-gate":
      return capability === "tool.execute" || capability === "gate.execute"
    case "child-run":
      return capability === "child.execute"
    case "git-integration":
      return capability === "integration.execute"
  }
}

export const WorkerCapabilityGrantSchema = z
  .object({
    action: WorkerCapabilityActionSchema,
    pathScopes: z.array(NonEmptyStringSchema).max(256).default([]),
    /**
     * Exact SHA-256 fingerprints of command invocations. A bare executable
     * name is deliberately not a capability: the fingerprint also binds the
     * canonical executable path and bytes, argv, cwd, environment names and
     * semantic intent at the operation boundary.
     */
    commandScopes: z.array(Sha256Schema).max(256).default([]),
  })
  .strict()
export type WorkerCapabilityGrant = z.infer<typeof WorkerCapabilityGrantSchema>

export const WorkerIdentitySchema = z
  .object({
    schemaVersion: z.literal(WORKER_PROTOCOL_VERSION),
    workerId: NonEmptyStringSchema,
    workspaceId: NonEmptyStringSchema,
    workspaceRoot: z
      .string()
      .min(1)
      .max(32_768)
      .refine(isAbsolute, "Worker workspace root must be absolute"),
    runId: NonEmptyStringSchema,
    attemptId: NonEmptyStringSchema.optional(),
    parentWorkerId: NonEmptyStringSchema.optional(),
    role: WorkerRoleSchema,
    pid: z.number().int().positive(),
    processStartToken: NonEmptyStringSchema,
    hostname: NonEmptyStringSchema,
    capabilityHash: Sha256Schema,
    capabilities: z.array(WorkerCapabilityGrantSchema).min(1).max(64),
    startedAt: TimestampSchema,
    deadlineAt: TimestampSchema.optional(),
  })
  .strict()
export type WorkerIdentity = z.infer<typeof WorkerIdentitySchema>

const WorkerMessageBaseSchema = z
  .object({
    schemaVersion: z.literal(WORKER_PROTOCOL_VERSION),
    workerId: NonEmptyStringSchema,
    sequence: SequenceSchema,
    sentAt: TimestampSchema,
    capabilityToken: z.string().min(32).max(512),
  })
  .strict()

export const WorkerBootstrapMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.bootstrap"),
  identity: WorkerIdentitySchema.omit({ pid: true, startedAt: true }),
  heartbeatIntervalMs: z
    .number()
    .int()
    .min(MIN_WORKER_HEARTBEAT_INTERVAL_MS)
    .max(MAX_TIMER_DELAY_MS),
  cancellationGraceMs: z.number().int().nonnegative().max(MAX_TIMER_DELAY_MS),
  disconnectGraceMs: z.number().int().nonnegative().max(MAX_TIMER_DELAY_MS),
  forceCleanupGraceMs: z.number().int().nonnegative().max(MAX_TIMER_DELAY_MS),
}).strict()

export const WorkerExecuteMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.execute"),
  requestId: NonEmptyStringSchema,
  operation: NonEmptyStringSchema,
  requiredCapability: WorkerCapabilityActionSchema,
  payload: z.unknown(),
  deadlineAt: TimestampSchema.optional(),
}).strict()

export const WorkerCancelMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.cancel"),
  requestId: NonEmptyStringSchema,
  cause: WorkerCancellationCauseSchema,
  reason: NonEmptyStringSchema,
}).strict()

export const WorkerPingMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.ping"),
  pingId: NonEmptyStringSchema,
}).strict()

export const WorkerShutdownMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.shutdown"),
  reason: NonEmptyStringSchema,
  deadlineAt: TimestampSchema,
}).strict()

export const WorkerParentResultMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.parent-result"),
  requestId: NonEmptyStringSchema,
  parentCallId: NonEmptyStringSchema,
  result: z.unknown(),
}).strict()

export const WorkerParentErrorMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.parent-error"),
  requestId: NonEmptyStringSchema,
  parentCallId: NonEmptyStringSchema,
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
}).strict()

export const SupervisorWorkerMessageSchema = z.discriminatedUnion("type", [
  WorkerBootstrapMessageSchema,
  WorkerExecuteMessageSchema,
  WorkerCancelMessageSchema,
  WorkerPingMessageSchema,
  WorkerShutdownMessageSchema,
  WorkerParentResultMessageSchema,
  WorkerParentErrorMessageSchema,
])
export type SupervisorWorkerMessage = z.infer<typeof SupervisorWorkerMessageSchema>

export const WorkerReadyMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.ready"),
  pid: z.number().int().positive(),
  processStartToken: NonEmptyStringSchema,
  startedAt: TimestampSchema,
}).strict()

export const WorkerHeartbeatMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.heartbeat"),
  phase: NonEmptyStringSchema.optional(),
  activeRequestId: NonEmptyStringSchema.optional(),
  controlResponsive: z.literal(true),
}).strict()

export const WorkerProgressMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.progress"),
  requestId: NonEmptyStringSchema,
  phase: NonEmptyStringSchema,
  detail: z.unknown().optional(),
}).strict()

export const WorkerResultMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.result"),
  requestId: NonEmptyStringSchema,
  result: z.unknown(),
}).strict()

export const WorkerErrorMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.error"),
  requestId: NonEmptyStringSchema.optional(),
  code: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  retryable: z.boolean(),
}).strict()

export const WorkerCancelledMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.cancelled"),
  requestId: NonEmptyStringSchema,
  cause: WorkerCancellationCauseSchema,
  reason: NonEmptyStringSchema,
}).strict()

export const WorkerPongMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.pong"),
  pingId: NonEmptyStringSchema,
}).strict()

export const WorkerShutdownAckMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.shutdown-ack"),
  reason: NonEmptyStringSchema,
}).strict()

export const WorkerParentCallMessageSchema = WorkerMessageBaseSchema.extend({
  type: z.literal("worker.parent-call"),
  requestId: NonEmptyStringSchema,
  parentCallId: NonEmptyStringSchema,
  method: WorkerParentCallMethodSchema,
  payload: z.unknown(),
}).strict()

export const WorkerSupervisorMessageSchema = z.discriminatedUnion("type", [
  WorkerReadyMessageSchema,
  WorkerHeartbeatMessageSchema,
  WorkerProgressMessageSchema,
  WorkerResultMessageSchema,
  WorkerErrorMessageSchema,
  WorkerCancelledMessageSchema,
  WorkerPongMessageSchema,
  WorkerShutdownAckMessageSchema,
  WorkerParentCallMessageSchema,
])
export type WorkerSupervisorMessage = z.infer<typeof WorkerSupervisorMessageSchema>

export type WorkerProtocolMessage = SupervisorWorkerMessage | WorkerSupervisorMessage

export function createWorkerCapabilityToken(): string {
  return randomBytes(32).toString("base64url")
}

export function hashWorkerCapabilityToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export function matchesWorkerCapabilityToken(token: string, expectedHash: string): boolean {
  if (!Sha256Schema.safeParse(expectedHash).success) return false
  const actual = Buffer.from(hashWorkerCapabilityToken(token), "hex")
  const expected = Buffer.from(expectedHash, "hex")
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected)
}

export function immutableWorkerCapabilityGrant(
  input: WorkerCapabilityGrant,
): WorkerCapabilityGrant {
  const grant = WorkerCapabilityGrantSchema.parse(input)
  Object.freeze(grant.pathScopes)
  Object.freeze(grant.commandScopes)
  return Object.freeze(grant)
}

export function immutableWorkerIdentity(input: WorkerIdentity): WorkerIdentity {
  const identity = WorkerIdentitySchema.parse(input)
  for (const grant of identity.capabilities) {
    if (!workerRoleAllowsCapability(identity.role, grant.action)) {
      throw new Error(`Worker role ${identity.role} cannot receive capability ${grant.action}`)
    }
    Object.freeze(grant.pathScopes)
    Object.freeze(grant.commandScopes)
    Object.freeze(grant)
  }
  Object.freeze(identity.capabilities)
  return Object.freeze(identity)
}

/**
 * Produces the effective grant for one action without silently ignoring later
 * grants. The supervisor can split scopes for composition; the worker always
 * sees their deterministic union.
 */
export function mergeWorkerCapabilityGrants(
  grants: readonly WorkerCapabilityGrant[],
  action: WorkerCapabilityAction,
): WorkerCapabilityGrant | undefined {
  const matching = grants.filter((grant) => grant.action === action)
  if (matching.length === 0) return undefined
  return immutableWorkerCapabilityGrant({
    action,
    pathScopes: [...new Set(matching.flatMap((grant) => grant.pathScopes))].sort(),
    commandScopes: [...new Set(matching.flatMap((grant) => grant.commandScopes))].sort(),
  })
}

function encodedMessageBytes(value: unknown): number {
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch (error) {
    throw new Error(`Worker IPC message is not JSON-serializable: ${String(error)}`)
  }
  if (encoded === undefined) throw new Error("Worker IPC message has no JSON representation")
  return Buffer.byteLength(encoded, "utf8")
}

function validMaximumMessageBytes(maximumBytes: number): number {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error(`Worker IPC maximum message size must be a positive safe integer`)
  }
  return maximumBytes
}

export function parseSupervisorWorkerMessage(
  value: unknown,
  maximumBytes = DEFAULT_MAX_WORKER_MESSAGE_BYTES,
): SupervisorWorkerMessage {
  maximumBytes = validMaximumMessageBytes(maximumBytes)
  const size = encodedMessageBytes(value)
  if (size > maximumBytes) {
    throw new Error(`Supervisor IPC message exceeds ${maximumBytes} bytes (${size})`)
  }
  return SupervisorWorkerMessageSchema.parse(value)
}

export function parseWorkerSupervisorMessage(
  value: unknown,
  maximumBytes = DEFAULT_MAX_WORKER_MESSAGE_BYTES,
): WorkerSupervisorMessage {
  maximumBytes = validMaximumMessageBytes(maximumBytes)
  const size = encodedMessageBytes(value)
  if (size > maximumBytes) {
    throw new Error(`Worker IPC message exceeds ${maximumBytes} bytes (${size})`)
  }
  return WorkerSupervisorMessageSchema.parse(value)
}

export function assertWorkerMessageAuthority(
  message: WorkerProtocolMessage,
  expected: { workerId: string; capabilityHash: string; minimumSequenceExclusive: number },
): void {
  if (message.workerId !== expected.workerId) {
    throw new Error(`Worker IPC identity mismatch: expected ${expected.workerId}`)
  }
  if (!matchesWorkerCapabilityToken(message.capabilityToken, expected.capabilityHash)) {
    throw new Error(`Worker IPC capability proof is invalid for ${expected.workerId}`)
  }
  if (message.sequence <= expected.minimumSequenceExclusive) {
    throw new Error(
      `Worker IPC sequence is not monotonic for ${expected.workerId}: ${message.sequence}`,
    )
  }
}

export function redactWorkerProtocolMessage<T extends WorkerProtocolMessage>(
  message: T,
  secretValues: readonly string[] = [],
): Omit<T, "capabilityToken"> & { capabilityToken: "[REDACTED]" } {
  return redactValue({ ...message, capabilityToken: "[REDACTED]" }, secretValues) as Omit<
    T,
    "capabilityToken"
  > & {
    capabilityToken: "[REDACTED]"
  }
}
