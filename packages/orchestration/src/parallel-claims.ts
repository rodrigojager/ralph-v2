import { randomUUID } from "node:crypto"
import {
  EXIT_CODES,
  RalphError,
  type ResourceClaimSetRecord,
  type ResourceClaimSpec,
} from "@ralph/domain"
import {
  acquireResourceClaimSet,
  expandResourceClaimSet,
  type LeaseOwnerProbeResult,
  listResourceClaimSets,
  type ResourceClaimOwner,
  readResourceClaimSet,
  recoverExpiredResourceClaimSet,
  releaseResourceClaimSet,
  renewResourceClaimSet,
} from "@ralph/persistence"
import type { ParallelClaimLifecyclePort } from "./parallel-runner"
import { captureCurrentProcessIdentity, probeProcessIdentity } from "./process-identity"

const CLAIM_LEASE_DURATION_MS = 30_000
const CLAIM_STALE_GRACE_MS = 20_000
const CLAIM_RENEW_INTERVAL_MS = 10_000

type OwnedClaimSet = {
  record: ResourceClaimSetRecord
  owner: ResourceClaimOwner
  timer: ReturnType<typeof setInterval>
  renewal?: Promise<void>
  renewalFailure?: unknown
}

export interface DurableParallelClaimPort extends ParallelClaimLifecyclePort {
  assertOwned(claimSetId: string): ResourceClaimSetRecord
  expand(claimSetId: string, additions: readonly ResourceClaimSpec[]): ResourceClaimSetRecord
  releaseAll(reason: string): Promise<void>
}

export type ParallelClaimRecoverySummary = {
  inspected: number
  expiredCandidates: number
  recoveredClaimSetIds: readonly string[]
  retained: readonly { claimSetId: string; reason: string }[]
}

/**
 * Recovers only claims whose lease and grace are already over and whose exact
 * process-start identity is confirmed dead/reused twice. Unreachable or merely
 * inaccessible owners remain retained; time alone never authorizes takeover.
 */
export async function recoverExpiredParallelClaims(input: {
  ledgerPath: string
  workspaceId: string
  runId?: string
  now?: () => Date
  probe?: (owner: {
    pid: number
    processStartToken: string
    hostname: string
  }) => Promise<LeaseOwnerProbeResult>
  confirmationDelayMs?: number
}): Promise<ParallelClaimRecoverySummary> {
  const now = input.now ?? (() => new Date())
  const probe = input.probe ?? probeProcessIdentity
  const confirmationDelayMs = input.confirmationDelayMs ?? 300
  if (
    !Number.isSafeInteger(confirmationDelayMs) ||
    confirmationDelayMs < 250 ||
    confirmationDelayMs > 10_000
  ) {
    throw new RalphError(
      "RALPH_RESOURCE_CLAIM_RECOVERY_DELAY_INVALID",
      "Claim recovery confirmation delay must be between 250 and 10000 milliseconds",
      { exitCode: EXIT_CODES.invalidUsage },
    )
  }
  const active = listResourceClaimSets(input.ledgerPath, {
    workspaceId: input.workspaceId,
    ...(input.runId ? { runId: input.runId } : {}),
    status: "active",
    limit: 1_000,
  })
  const expired = active.filter(
    (claimSet) => now().getTime() >= Date.parse(claimSet.graceExpiresAt),
  )
  const recoveredClaimSetIds: string[] = []
  const retained: { claimSetId: string; reason: string }[] = []
  for (const claimSet of expired) {
    const owner = {
      pid: claimSet.pid,
      processStartToken: claimSet.processStartToken,
      hostname: claimSet.hostname,
    }
    const firstObservedAt = now().toISOString()
    const first = await probe(owner)
    if (first.status !== "dead" && first.status !== "identity-mismatch") {
      retained.push({ claimSetId: claimSet.id, reason: first.reason })
      continue
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, confirmationDelayMs))
    const second = await probe(owner)
    const observedAt = now().toISOString()
    if (second.status !== "dead" && second.status !== "identity-mismatch") {
      retained.push({ claimSetId: claimSet.id, reason: second.reason })
      continue
    }
    const observedProcessStartToken =
      second.observedProcessStartToken ?? first.observedProcessStartToken
    recoverExpiredResourceClaimSet(
      input.ledgerPath,
      claimSet.id,
      {
        status: second.status,
        confirmationCount: 2,
        firstObservedAt,
        expectedProcessStartToken: claimSet.processStartToken,
        ...(observedProcessStartToken ? { observedProcessStartToken } : {}),
        observedAt,
        reason: `${first.reason}; confirmation: ${second.reason}`.slice(0, 4_096),
      },
      now,
    )
    recoveredClaimSetIds.push(claimSet.id)
  }
  return {
    inspected: active.length,
    expiredCandidates: expired.length,
    recoveredClaimSetIds,
    retained,
  }
}

export async function createDurableParallelClaimPort(input: {
  ledgerPath: string
  workspaceId: string
  ownerInstanceId?: string
}): Promise<DurableParallelClaimPort> {
  const identity = await captureCurrentProcessIdentity()
  const ownerInstanceId = input.ownerInstanceId ?? randomUUID()
  const active = new Map<string, OwnedClaimSet>()

  const renew = (owned: OwnedClaimSet): Promise<void> => {
    if (owned.renewal) return owned.renewal
    const operation = Promise.resolve().then(() => {
      owned.record = renewResourceClaimSet(
        input.ledgerPath,
        owned.record.id,
        owned.owner,
        CLAIM_LEASE_DURATION_MS,
        CLAIM_STALE_GRACE_MS,
      )
    })
    owned.renewal = operation
    void operation
      .catch((error) => {
        owned.renewalFailure = error
        clearInterval(owned.timer)
      })
      .finally(() => {
        if (owned.renewal === operation) delete owned.renewal
      })
    return operation
  }

  const releaseById = async (claimSetId: string, reason: string): Promise<void> => {
    const owned = active.get(claimSetId)
    if (!owned) return
    active.delete(claimSetId)
    clearInterval(owned.timer)
    if (owned.renewal) await owned.renewal.catch(() => undefined)
    releaseResourceClaimSet(input.ledgerPath, claimSetId, owned.owner, reason)
  }

  const assertOwnedById = (claimSetId: string): ResourceClaimSetRecord => {
    const owned = active.get(claimSetId)
    if (!owned) {
      throw new RalphError("RALPH_RESOURCE_CLAIM_LOST", "Resource claim set is unavailable", {
        exitCode: EXIT_CODES.conflict,
        details: { claimSetId },
      })
    }
    if (owned.renewalFailure) throw owned.renewalFailure
    const persisted = readResourceClaimSet(input.ledgerPath, claimSetId)
    if (
      !persisted ||
      persisted.status !== "active" ||
      persisted.ownerInstanceId !== owned.owner.ownerInstanceId ||
      persisted.workerId !== owned.owner.workerId ||
      persisted.processStartToken !== owned.owner.processStartToken
    ) {
      throw new RalphError(
        "RALPH_RESOURCE_CLAIM_LOST",
        "The parallel worker no longer owns its durable resource claims",
        { exitCode: EXIT_CODES.conflict, details: { claimSetId, status: persisted?.status } },
      )
    }
    owned.record = persisted
    return persisted
  }

  return {
    async acquire(request) {
      const owner: ResourceClaimOwner = {
        ownerInstanceId,
        workerId: request.workerId,
        ...identity,
      }
      const record = acquireResourceClaimSet(input.ledgerPath, {
        // A task attempt can legitimately reacquire claims after a verified
        // dead-owner recovery (for example, to integrate an already completed
        // worktree). Claim-set identity therefore belongs to this ownership
        // epoch, not only to the immutable task attempt.
        id: `claims-${request.candidate.attemptId.slice(0, 430)}-${randomUUID()}`,
        workspaceId: input.workspaceId,
        runId: request.candidate.runId,
        documentId: request.candidate.documentId,
        taskId: request.candidate.taskId,
        attemptId: request.candidate.attemptId,
        claims: request.claims,
        leaseDurationMs: CLAIM_LEASE_DURATION_MS,
        staleGraceMs: CLAIM_STALE_GRACE_MS,
        ...owner,
      })
      const owned = {
        record,
        owner,
        timer: setInterval(() => {
          const current = active.get(record.id)
          if (current) void renew(current).catch(() => undefined)
        }, CLAIM_RENEW_INTERVAL_MS),
      } satisfies OwnedClaimSet
      owned.timer.unref()
      active.set(record.id, owned)
      return record
    },
    assertOwned(claimSetId) {
      return assertOwnedById(claimSetId)
    },
    expand(claimSetId, additions) {
      const current = assertOwnedById(claimSetId)
      const owned = active.get(claimSetId)
      if (!owned) throw new Error("Claim owner disappeared after ownership assertion")
      owned.record = expandResourceClaimSet(
        input.ledgerPath,
        current.id,
        owned.owner,
        additions,
        CLAIM_LEASE_DURATION_MS,
        CLAIM_STALE_GRACE_MS,
      )
      return owned.record
    },
    async release(request) {
      await releaseById(request.claimSet.id, request.reason)
    },
    async releaseAll(reason) {
      let firstFailure: unknown
      for (const claimSetId of [...active.keys()]) {
        try {
          await releaseById(claimSetId, reason)
        } catch (error) {
          firstFailure ??= error
        }
      }
      if (firstFailure) {
        throw new RalphError(
          "RALPH_RESOURCE_CLAIM_RELEASE_FAILED",
          "At least one claim set could not be released after all active sets were attempted",
          { exitCode: EXIT_CODES.operationalError, cause: firstFailure },
        )
      }
    },
  }
}
