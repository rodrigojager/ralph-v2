import { lstat, rm } from "node:fs/promises"
import { hostname as localHostname } from "node:os"
import { join } from "node:path"
import type {
  ContextControlCommandService,
  ContextRotationCommandResult,
  RunControlCommandService,
  RunStopCommandResult,
} from "@ralph-next/commands"
import {
  childRunStatusFromRunStatus,
  EXIT_CODES,
  RalphError,
  type RunStatus,
  RunStatusSchema,
} from "@ralph-next/domain"
import {
  acquireExecutionLock,
  type RunSupervisorControlPort,
  type SupervisorContextRotation,
  type SupervisorContextRotationBoundary,
  type SupervisorContextRotationReceipt,
  type SupervisorStopReceipt,
  transitionStoredRun,
} from "@ralph-next/orchestration"
import {
  getChildRunOwnerLink,
  getRun,
  listChildRunTree,
  listUnsettledToolCalls,
  readDurableLease,
  runLayout,
  settleChildRun,
  workspaceLayout,
  writeJsonAtomic,
} from "@ralph-next/persistence"
import {
  inspectRunControlDescriptor,
  MAX_TIMER_DELAY_MS,
  probePidLiveness,
  processShutdownRegistry,
  processStartToken,
  RunControlClientError,
  type RunControlDescriptor,
  sendRunControlRequest,
  startRunControlServer,
} from "@ralph-next/supervisor"
import {
  DurableProcessLifecycleMissingError,
  probeDurableProcessIntent,
  resolveDurableProcessRecoveryFromJournal,
  stopDurableProcessIntent,
} from "./durable-process-owner"

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled"])
const DEFAULT_FORCE_GRACE_MS = 1_500
const DORMANT_PROCESS_STOP_WAIT_MS = 10_000
const DORMANT_PROCESS_STOP_POLL_MS = 100
const RUN_CONTROL_STOP_RESPONSE_HEADROOM_MS = 30_000
const CONTROL_FILE_NAME = "control.json"

type QueuedRotation = {
  readonly request: SupervisorContextRotation
  readonly boundary: SupervisorContextRotationBoundary
}

function stopResult(
  input: Omit<RunStopCommandResult, "schemaVersion" | "requestedAt"> & {
    readonly requestedAt?: string
  },
): RunStopCommandResult {
  return {
    schemaVersion: 1,
    ...input,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
  }
}

function asRecord(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_RESPONSE_INVALID",
      `The live supervisor returned an invalid ${operation} receipt`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  return value as Record<string, unknown>
}

function supervisorStopResult(
  value: unknown,
  request: { runId: string; mode: "graceful" | "force"; graceMs?: number },
): RunStopCommandResult {
  const record = asRecord(value, "stop")
  const disposition = record.disposition
  const delivery = record.delivery
  const requestedAt = record.requestedAt
  if (
    !["requested", "already-requested", "already-terminal"].includes(String(disposition)) ||
    delivery !== "supervisor" ||
    typeof requestedAt !== "string"
  ) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_RESPONSE_INVALID",
      "The live supervisor returned an invalid stop disposition",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  const previousStatus = RunStatusSchema.parse(record.previousStatus)
  const status = RunStatusSchema.parse(record.status)
  return stopResult({
    runId: request.runId,
    mode: request.mode,
    ...(request.graceMs !== undefined ? { graceMs: request.graceMs } : {}),
    previousStatus,
    status,
    disposition: disposition as RunStopCommandResult["disposition"],
    requestedAt,
    delivery: "supervisor",
  })
}

function supervisorContextResult(value: unknown, runId: string): ContextRotationCommandResult {
  const record = asRecord(value, "context-rotation")
  const disposition = record.disposition
  const requestedAt = record.requestedAt
  const nextBoundary = record.nextBoundary
  if (
    !["requested", "already-requested", "not-applicable"].includes(String(disposition)) ||
    typeof requestedAt !== "string" ||
    !["next-model-call", "next-task"].includes(String(nextBoundary))
  ) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_RESPONSE_INVALID",
      "The live supervisor returned an invalid context-rotation receipt",
      { exitCode: EXIT_CODES.conflict },
    )
  }
  return {
    schemaVersion: 1,
    runId,
    disposition: disposition as ContextRotationCommandResult["disposition"],
    requestedAt,
    nextBoundary: nextBoundary as ContextRotationCommandResult["nextBoundary"],
  }
}

function controlError(error: unknown, operation: "stop" | "context rotation"): never {
  if (error instanceof RalphError) throw error
  if (error instanceof RunControlClientError) {
    throw new RalphError(error.code, error.message, {
      exitCode: EXIT_CODES.operationalError,
      hint:
        operation === "context rotation"
          ? "Context may rotate only through the authenticated live supervisor; no persisted context file was edited."
          : "Inspect the run and its supervisor lease; Ralph will never signal a PID without process-start identity and authenticated IPC.",
      cause: error,
    })
  }
  throw new RalphError(
    "RALPH_RUN_CONTROL_FAILED",
    `The ${operation} request could not be settled safely`,
    { exitCode: EXIT_CODES.operationalError, cause: error },
  )
}

function sameHost(left: string, right: string): boolean {
  return left.toLocaleLowerCase("und") === right.toLocaleLowerCase("und")
}

async function assertDescriptorReplaceable(
  descriptorPath: string,
  activationInstanceId: string,
): Promise<void> {
  let descriptor: RunControlDescriptor
  try {
    descriptor = await inspectRunControlDescriptor(descriptorPath)
  } catch (error) {
    if (error instanceof RunControlClientError && error.ownerState === "missing") return
    throw new RalphError(
      "RALPH_RUN_CONTROL_DESCRIPTOR_UNSAFE",
      "An existing run-control descriptor cannot be proven safe to replace",
      {
        exitCode: EXIT_CODES.conflict,
        file: descriptorPath,
        hint: "Inspect the exact control.json file; linked, malformed, or racing control files are never replaced automatically.",
        cause: error,
      },
    )
  }
  if (descriptor.instanceId === activationInstanceId) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_ALREADY_ACTIVE",
      "This supervisor instance already has a published run-control endpoint",
      { exitCode: EXIT_CODES.conflict, file: descriptorPath },
    )
  }
  if (!sameHost(descriptor.process.hostname, localHostname())) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_OWNER_REMOTE",
      "A run-control descriptor attributed to another host cannot be replaced automatically",
      { exitCode: EXIT_CODES.conflict, file: descriptorPath },
    )
  }
  const liveness = probePidLiveness(descriptor.process.pid)
  if (liveness.inaccessible) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_OWNER_UNVERIFIABLE",
      "The existing run-control owner is alive but its identity cannot be verified",
      { exitCode: EXIT_CODES.conflict, file: descriptorPath },
    )
  }
  if (!liveness.alive) return
  let observedStart: string
  try {
    observedStart = await processStartToken(descriptor.process.pid)
  } catch (error) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_OWNER_UNVERIFIABLE",
      "The existing run-control owner process-start token cannot be verified",
      { exitCode: EXIT_CODES.conflict, file: descriptorPath, cause: error },
    )
  }
  if (observedStart === descriptor.process.processStartToken) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_ALREADY_ACTIVE",
      "Another live supervisor still owns the published run-control endpoint",
      { exitCode: EXIT_CODES.conflict, file: descriptorPath },
    )
  }
}

async function removeOwnedDescriptor(
  path: string,
  descriptor: RunControlDescriptor,
): Promise<void> {
  let current: RunControlDescriptor
  try {
    current = await inspectRunControlDescriptor(path)
  } catch (error) {
    if (error instanceof RunControlClientError && error.ownerState === "missing") return
    throw error
  }
  if (
    current.instanceId !== descriptor.instanceId ||
    current.capabilityHash !== descriptor.capabilityHash ||
    current.process.pid !== descriptor.process.pid ||
    current.process.processStartToken !== descriptor.process.processStartToken
  ) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_DESCRIPTOR_CHANGED",
      "Run-control ownership changed before descriptor cleanup",
      { exitCode: EXIT_CODES.conflict, file: path },
    )
  }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new RalphError(
      "RALPH_RUN_CONTROL_DESCRIPTOR_UNSAFE",
      "Run-control descriptor became unsafe before cleanup",
      { exitCode: EXIT_CODES.conflict, file: path },
    )
  }
  await rm(path, { force: true })
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds === 0) return Promise.resolve()
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds)
    timer.unref()
  })
}

function durableProcessProbeDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function runControlStopTimeout(input: { mode: "graceful" | "force"; graceMs?: number }): number {
  const forceGraceMs = input.mode === "force" ? (input.graceMs ?? DEFAULT_FORCE_GRACE_MS) : 0
  const timeoutMs =
    forceGraceMs + DORMANT_PROCESS_STOP_WAIT_MS + RUN_CONTROL_STOP_RESPONSE_HEADROOM_MS
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RalphError(
      "RALPH_STOP_GRACE_TOO_LARGE_FOR_CONTROL_SETTLEMENT",
      "The requested force grace leaves no bounded IPC window for durable process settlement",
      {
        exitCode: EXIT_CODES.invalidUsage,
        details: {
          graceMs: forceGraceMs,
          maximumGraceMs:
            MAX_TIMER_DELAY_MS -
            DORMANT_PROCESS_STOP_WAIT_MS -
            RUN_CONTROL_STOP_RESPONSE_HEADROOM_MS,
        },
      },
    )
  }
  return timeoutMs
}

function scheduleAbort(controller: AbortController, reason: string): void {
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new Error(reason))
  }, 0)
  timer.unref()
}

async function stopDurableProcessEffects(input: {
  workspaceRoot: string
  workspaceId: string
  runId: string
  mode: "graceful" | "force"
  missingLifecycle: "ignore-authoritatively-dormant" | "fail-closed"
  reason: string
}): Promise<void> {
  const layout = workspaceLayout(input.workspaceRoot)
  const runIds = [
    input.runId,
    ...listChildRunTree(layout.ledger, input.runId).map((link) => link.childRunId),
  ]
  const processIntents = runIds
    .flatMap((runId) => listUnsettledToolCalls(layout.ledger, { runId }))
    .map((entry) => entry.intent)
    .filter((intent) => intent.tool === "process.exec")
  const pending: Array<Awaited<ReturnType<typeof resolveDurableProcessRecoveryFromJournal>>> = []

  for (const intent of processIntents) {
    let recovery: Awaited<ReturnType<typeof resolveDurableProcessRecoveryFromJournal>>
    try {
      recovery = await resolveDurableProcessRecoveryFromJournal({
        controlRoot: layout.root,
        workspaceId: input.workspaceId,
        runId: intent.runId,
        documentId: intent.documentId,
        taskId: intent.taskId,
        attemptId: intent.attemptId,
        intentId: intent.id,
        argumentsHash: intent.argumentsHash,
        idempotencyKey: intent.idempotencyKey,
      })
    } catch (error) {
      if (error instanceof DurableProcessLifecycleMissingError) {
        if (input.missingLifecycle === "ignore-authoritatively-dormant") {
          // This policy is legal only while cancelDormantRun owns the workspace
          // writer lease and the original supervisor is proven absent. An
          // intent-before-effect cannot advance to an owner in that boundary.
          continue
        }
        throw new RalphError(
          "RALPH_DURABLE_PROCESS_LIFECYCLE_MISSING",
          `A live process intent has no lifecycle at the stop boundary: ${intent.id}`,
          {
            exitCode: EXIT_CODES.conflict,
            cause: error,
            details: { runId: intent.runId, intentId: intent.id },
          },
        )
      }
      throw new RalphError(
        "RALPH_DURABLE_PROCESS_STOP_BINDING_INVALID",
        `A process effect cannot be stopped from an untrusted lifecycle: ${intent.id}`,
        { exitCode: EXIT_CODES.conflict, cause: error },
      )
    }
    const disposition = await stopDurableProcessIntent({
      ...recovery,
      mode: input.mode,
      reason: input.reason,
    })
    if (disposition === "requested") pending.push(recovery)
  }

  const deadline = Date.now() + DORMANT_PROCESS_STOP_WAIT_MS
  let unresolved = pending
  while (unresolved.length > 0) {
    const observations = await Promise.all(
      unresolved.map(async (recovery) => ({
        recovery,
        probe: await probeDurableProcessIntent(recovery),
      })),
    )
    unresolved = observations
      .filter(({ probe }) => probe.identity !== "same-settled" && probe.identity !== "dead")
      .map(({ recovery }) => recovery)
    if (unresolved.length === 0) return
    if (Date.now() >= deadline) {
      throw new RalphError(
        "RALPH_DURABLE_PROCESS_STOP_UNSETTLED",
        "The run remains stopping because one or more durable process effects could not be proven settled or dead",
        {
          exitCode: EXIT_CODES.conflict,
          details: {
            count: unresolved.length,
            intentIds: unresolved.slice(0, 8).map((entry) => entry.intentId),
          },
        },
      )
    }
    await durableProcessProbeDelay(DORMANT_PROCESS_STOP_POLL_MS)
  }
}

function assertDormantRunOwnerLinkCompatible(input: {
  ledger: string
  run: NonNullable<ReturnType<typeof getRun>>
  expectedLinkId?: string
}): void {
  const currentLink = getChildRunOwnerLink(input.ledger, input.run.id)
  if (!currentLink) {
    if (!input.expectedLinkId) return
    throw new RalphError(
      "RALPH_DORMANT_CHILD_LINK_INVALID",
      `A child run lost its durable parent ownership link: ${input.run.id}`,
      {
        exitCode: EXIT_CODES.conflict,
        details: { expectedLinkId: input.expectedLinkId, childRunId: input.run.id },
      },
    )
  }
  if (input.expectedLinkId && currentLink.id !== input.expectedLinkId) {
    throw new RalphError(
      "RALPH_DORMANT_CHILD_LINK_INVALID",
      `Child ownership changed while the dormant tree was being cancelled: ${input.run.id}`,
      {
        exitCode: EXIT_CODES.conflict,
        details: { expectedLinkId: input.expectedLinkId, childRunId: input.run.id },
      },
    )
  }
  if (["passed", "failed", "cancelled"].includes(currentLink.status)) {
    const expectedStatus = childRunStatusFromRunStatus(input.run.status)
    if (currentLink.status !== expectedStatus) {
      throw new RalphError(
        "RALPH_DORMANT_CHILD_TERMINAL_MISMATCH",
        `Child run and terminal link disagree: ${input.run.id}`,
        {
          exitCode: EXIT_CODES.conflict,
          details: {
            childRunStatus: input.run.status,
            childLinkStatus: currentLink.status,
            expectedLinkStatus: expectedStatus,
          },
        },
      )
    }
  }
}

function settleDormantRunOwnerLink(input: {
  ledger: string
  run: NonNullable<ReturnType<typeof getRun>>
  reason: string
  expectedLinkId?: string
}): void {
  if (!TERMINAL_RUN_STATUSES.has(input.run.status)) {
    throw new RalphError(
      "RALPH_DORMANT_CHILD_RUN_NOT_TERMINAL",
      `A child link cannot settle before its run is terminal: ${input.run.id}`,
      { exitCode: EXIT_CODES.conflict },
    )
  }
  assertDormantRunOwnerLinkCompatible(input)
  const currentLink = getChildRunOwnerLink(input.ledger, input.run.id)
  if (!currentLink) return
  const expectedStatus = childRunStatusFromRunStatus(input.run.status)
  if (currentLink.status === expectedStatus) return
  if (["passed", "failed", "cancelled"].includes(currentLink.status)) {
    throw new RalphError(
      "RALPH_DORMANT_CHILD_TERMINAL_MISMATCH",
      `Child run and terminal link disagree: ${input.run.id}`,
      {
        exitCode: EXIT_CODES.conflict,
        details: {
          childRunStatus: input.run.status,
          childLinkStatus: currentLink.status,
          expectedLinkStatus: expectedStatus,
        },
      },
    )
  }
  settleChildRun(input.ledger, {
    linkId: currentLink.id,
    expectedRevision: currentLink.revision,
    artifactsReconciled: currentLink.artifactsReconciled,
    reason: input.reason,
    finishedAt: input.run.finishedAt ?? new Date().toISOString(),
  })
}

async function cancelDormantChildRunTree(input: {
  workspaceRoot: string
  workspaceId: string
  runId: string
  authority: {
    assertOwned(): unknown
    renew(): Promise<unknown>
  }
}): Promise<void> {
  await input.authority.renew()
  input.authority.assertOwned()
  const ledger = workspaceLayout(input.workspaceRoot).ledger
  const links = listChildRunTree(ledger, input.runId).sort(
    (left, right) => right.depth - left.depth || left.id.localeCompare(right.id),
  )
  const reason = "The command-owned dormant parent stop cancelled its child run tree"
  const children: Array<{
    snapshot: (typeof links)[number]
    child: NonNullable<ReturnType<typeof getRun>>
  }> = []
  for (const snapshot of links) {
    await input.authority.renew()
    input.authority.assertOwned()
    const child = getRun(ledger, snapshot.childRunId)
    if (!child || child.workspaceId !== input.workspaceId) {
      throw new RalphError(
        "RALPH_DORMANT_CHILD_RUN_INVALID",
        `A durable child link does not resolve to a run in this workspace: ${snapshot.childRunId}`,
        {
          exitCode: EXIT_CODES.conflict,
          details: { linkId: snapshot.id, childRunId: snapshot.childRunId },
        },
      )
    }
    assertDormantRunOwnerLinkCompatible({
      ledger,
      run: child,
      expectedLinkId: snapshot.id,
    })
    children.push({ snapshot, child })
  }

  for (const { snapshot, child } of children) {
    await input.authority.renew()
    input.authority.assertOwned()
    const terminal = TERMINAL_RUN_STATUSES.has(child.status)
      ? child
      : transitionStoredRun(ledger, child, "cancelled", {
          stopReason: reason,
          finishedAt: new Date().toISOString(),
          eventType: "run.cancelled",
        })
    settleDormantRunOwnerLink({
      ledger,
      run: terminal,
      reason,
      expectedLinkId: snapshot.id,
    })
  }
}

async function cancelDormantRun(request: {
  workspaceRoot: string
  workspaceId: string
  runId: string
  mode: "graceful" | "force"
  graceMs?: number
}): Promise<RunStopCommandResult> {
  const layout = workspaceLayout(request.workspaceRoot)
  const lock = await acquireExecutionLock({
    layout,
    workspaceId: request.workspaceId,
    runId: request.runId,
    command: "ralph-next stop",
    capabilityScope: ["run:supervise", "workspace:write"],
  })
  try {
    lock.assertOwned()
    const current = getRun(layout.ledger, request.runId)
    if (!current || current.workspaceId !== request.workspaceId) {
      throw new RalphError(
        "RALPH_RUN_NOT_FOUND",
        `Run was not found in this workspace: ${request.runId}`,
        { exitCode: EXIT_CODES.invalidUsage },
      )
    }
    assertDormantRunOwnerLinkCompatible({ ledger: layout.ledger, run: current })
    let cancellable = current
    if (current.status === "running" || current.status === "waiting") {
      cancellable = transitionStoredRun(layout.ledger, current, "stopping", {
        stopReason: "A command-owned supervisor is stopping durable process effects",
        eventType: "run.stopping",
      })
    }
    await stopDurableProcessEffects({
      ...request,
      missingLifecycle: "ignore-authoritatively-dormant",
      reason: "Explicit command-authorized dormant run stop",
    })
    await cancelDormantChildRunTree({ ...request, authority: lock })
    await lock.renew()
    lock.assertOwned()
    assertDormantRunOwnerLinkCompatible({ ledger: layout.ledger, run: cancellable })
    if (TERMINAL_RUN_STATUSES.has(cancellable.status)) {
      settleDormantRunOwnerLink({
        ledger: layout.ledger,
        run: cancellable,
        reason: "The command-owned dormant stop reconciled a terminal child run link",
      })
      return stopResult({
        runId: cancellable.id,
        mode: request.mode,
        ...(request.graceMs !== undefined ? { graceMs: request.graceMs } : {}),
        previousStatus: current.status,
        status: cancellable.status,
        disposition: "already-terminal",
        delivery: "durable-boundary",
      })
    }
    const updated = transitionStoredRun(layout.ledger, cancellable, "cancelled", {
      stopReason:
        "A command-owned supervisor proved the run dormant and all durable process effects settled or dead",
      finishedAt: new Date().toISOString(),
      eventType: "run.cancelled",
    })
    settleDormantRunOwnerLink({
      ledger: layout.ledger,
      run: updated,
      reason: "The command-owned dormant stop cancelled this child run",
    })
    return stopResult({
      runId: updated.id,
      mode: request.mode,
      ...(request.graceMs !== undefined ? { graceMs: request.graceMs } : {}),
      previousStatus: current.status,
      status: updated.status,
      disposition: current.status === "stopping" ? "already-requested" : "requested",
      delivery: "durable-boundary",
    })
  } finally {
    await lock.release()
  }
}

/**
 * S07 command composition. The live path is authenticated IPC bound to the
 * workspace lease's PID, process-start token and owner instance. Only the
 * runner callback writes official transitions. A dormant fallback first takes
 * the same durable writer lease, so commands never race a live supervisor.
 */
export function createS07CommandServices(): {
  readonly runControl: RunControlCommandService
  readonly contextControl: ContextControlCommandService
  readonly supervisorControl: RunSupervisorControlPort
} {
  const supervisorControl: RunSupervisorControlPort = {
    async activate(activation) {
      const layout = workspaceLayout(activation.workspaceRoot)
      const lease = activation.lease
      if (
        lease.kind !== "workspace-supervisor" ||
        lease.resourceKey !== "workspace-writer" ||
        lease.workspaceId !== activation.workspaceId ||
        lease.runId !== activation.runId ||
        lease.ownerInstanceId !== activation.ownerInstanceId ||
        lease.status !== "active" ||
        !lease.scope.includes("run:supervise") ||
        !lease.scope.includes("workspace:write")
      ) {
        throw new RalphError(
          "RALPH_RUN_CONTROL_LEASE_MISMATCH",
          "Run-control activation is not bound to the active workspace writer lease",
          { exitCode: EXIT_CODES.conflict },
        )
      }
      const assertLiveSupervisorLease = (): void => {
        const current = readDurableLease(layout.ledger, lease.id)
        if (
          !current ||
          current.kind !== "workspace-supervisor" ||
          current.resourceKey !== "workspace-writer" ||
          current.workspaceId !== activation.workspaceId ||
          current.runId !== activation.runId ||
          current.ownerInstanceId !== activation.ownerInstanceId ||
          current.pid !== lease.pid ||
          current.processStartToken !== lease.processStartToken ||
          !sameHost(current.hostname, lease.hostname) ||
          current.status !== "active" ||
          Date.now() >= Date.parse(current.expiresAt) ||
          !current.scope.includes("run:supervise") ||
          !current.scope.includes("workspace:write")
        ) {
          throw new RalphError(
            "RALPH_RUN_CONTROL_LEASE_LOST",
            "Run-control authority is no longer backed by its exact active workspace writer lease",
            { exitCode: EXIT_CODES.conflict },
          )
        }
      }
      assertLiveSupervisorLease()
      const descriptorPath = join(runLayout(layout, activation.runId).root, CONTROL_FILE_NAME)
      const cancellation = new AbortController()
      const rotations: QueuedRotation[] = []
      const server = await startRunControlServer({
        workspaceId: activation.workspaceId,
        runId: activation.runId,
        instanceId: activation.ownerInstanceId,
        process: {
          pid: lease.pid,
          processStartToken: lease.processStartToken,
          hostname: lease.hostname,
        },
        async publish(descriptor) {
          await assertDescriptorReplaceable(descriptorPath, activation.ownerInstanceId)
          await writeJsonAtomic(descriptorPath, descriptor, { overwrite: true, mode: 0o600 })
        },
        async unpublish(descriptor) {
          await removeOwnedDescriptor(descriptorPath, descriptor)
        },
        async handle(request) {
          assertLiveSupervisorLease()
          if (request.action.kind === "context-rotate") {
            const existing = rotations[0]
            if (existing) {
              return {
                disposition: "already-requested",
                requestedAt: existing.request.requestedAt,
                nextBoundary: existing.boundary,
              } satisfies SupervisorContextRotationReceipt
            }
            const rotation: SupervisorContextRotation = {
              requestId: request.requestId,
              reason: request.action.reason,
              requestedAt: request.requestedAt,
            }
            const receipt = await activation.onContextRotation(rotation)
            assertLiveSupervisorLease()
            if (receipt.disposition === "requested") {
              rotations.push({ request: rotation, boundary: receipt.nextBoundary })
            }
            return receipt
          }

          const receipt: SupervisorStopReceipt = await activation.onStop({
            requestId: request.requestId,
            mode: request.action.mode,
            reason: request.action.reason,
            ...(request.action.graceMs !== undefined ? { graceMs: request.action.graceMs } : {}),
            requestedAt: request.requestedAt,
          })
          const reason = `Supervisor ${request.action.mode} stop: ${request.action.reason}`
          const gracefulCancellation = processShutdownRegistry.cancelAll(reason)
          if (request.action.mode === "force") {
            await Promise.race([
              gracefulCancellation,
              delay(request.action.graceMs ?? DEFAULT_FORCE_GRACE_MS),
            ])
            await processShutdownRegistry.forceKillAll(reason)
          } else {
            void gracefulCancellation.catch(() => undefined)
          }
          try {
            await stopDurableProcessEffects({
              workspaceRoot: activation.workspaceRoot,
              workspaceId: activation.workspaceId,
              runId: activation.runId,
              mode: request.action.mode,
              missingLifecycle: "fail-closed",
              reason,
            })
          } finally {
            // Schedule only after the durable cleanup attempt so the control
            // handler can write its success/error response before run teardown
            // closes the authenticated socket.
            scheduleAbort(cancellation, reason)
          }
          assertLiveSupervisorLease()
          return receipt
        },
      })
      let closed = false
      return {
        signal: cancellation.signal,
        takeContextRotation(boundary) {
          const index = rotations.findIndex((entry) => entry.boundary === boundary)
          if (index < 0) return undefined
          return rotations.splice(index, 1)[0]?.request
        },
        pendingContextRotations() {
          return rotations.map((entry) => entry.request)
        },
        async close() {
          if (closed) return
          closed = true
          await server.close()
        },
      }
    },
  }

  return {
    supervisorControl,
    runControl: {
      async stop(request) {
        const layout = workspaceLayout(request.workspaceRoot)
        const current = getRun(layout.ledger, request.runId)
        if (!current || current.workspaceId !== request.workspaceId) {
          throw new RalphError(
            "RALPH_RUN_NOT_FOUND",
            `Run was not found in this workspace: ${request.runId}`,
            { exitCode: EXIT_CODES.invalidUsage },
          )
        }
        try {
          const delivered = await sendRunControlRequest({
            descriptorPath: join(runLayout(layout, request.runId).root, CONTROL_FILE_NAME),
            workspaceId: request.workspaceId,
            runId: request.runId,
            action: {
              kind: "stop",
              mode: request.mode,
              reason: "Explicit command-authorized run stop",
              ...(request.graceMs !== undefined ? { graceMs: request.graceMs } : {}),
            },
            timeoutMs: runControlStopTimeout(request),
          })
          return supervisorStopResult(delivered.response.result, request)
        } catch (error) {
          if (
            error instanceof RunControlClientError &&
            ["missing", "dead", "identity-mismatch"].includes(error.ownerState)
          ) {
            try {
              return await cancelDormantRun(request)
            } catch (fallbackError) {
              controlError(fallbackError, "stop")
            }
          }
          controlError(error, "stop")
        }
      },
    },
    contextControl: {
      async rotate(request) {
        const layout = workspaceLayout(request.workspaceRoot)
        const current = getRun(layout.ledger, request.runId)
        if (!current || current.workspaceId !== request.workspaceId) {
          throw new RalphError(
            "RALPH_RUN_NOT_FOUND",
            `Run was not found in this workspace: ${request.runId}`,
            { exitCode: EXIT_CODES.invalidUsage },
          )
        }
        try {
          const delivered = await sendRunControlRequest({
            descriptorPath: join(runLayout(layout, request.runId).root, CONTROL_FILE_NAME),
            workspaceId: request.workspaceId,
            runId: request.runId,
            action: { kind: "context-rotate", reason: request.reason },
            ...(request.signal ? { signal: request.signal } : {}),
          })
          return supervisorContextResult(delivered.response.result, request.runId)
        } catch (error) {
          controlError(error, "context rotation")
        }
      },
    },
  }
}
