import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type DurableLeaseRecord, EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  acquireDurableLease,
  assertDurableLeaseOwned,
  globalConfigPath,
  initializeLedger,
  type LeaseOwnerIdentity,
  releaseDurableLease,
  renewDurableLease,
  type WorkspaceLayout,
} from "@ralph-next/persistence"
import type { ParallelCapacityLeasePort } from "./parallel-scheduler"
import { captureCurrentProcessIdentity, probeProcessIdentity } from "./process-identity"

const GLOBAL_CAPACITY_WORKSPACE_ID = "ralph-global-parallel-capacity-v1"
const LEASE_DURATION_MS = 30_000
const STALE_GRACE_MS = 20_000
const RENEW_INTERVAL_MS = 10_000

type CapacityLease = {
  ledgerPath: string
  record: DurableLeaseRecord
}

type CapacityBundle = {
  id: string
  leases: CapacityLease[]
  timer: ReturnType<typeof setInterval>
  renewalFailure?: unknown
  renewal?: Promise<void>
}

export interface DurableParallelCapacityPort extends ParallelCapacityLeasePort {
  assertOwned(leaseId: string): void
  releaseAll(reason: string): Promise<void>
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_024) {
    throw new RalphError("RALPH_PARALLEL_LIMIT_INVALID", `${name} is outside the safe range`, {
      exitCode: EXIT_CODES.invalidUsage,
      details: { name, value, minimum: 1, maximum: 1_024 },
    })
  }
  return value
}

function safeKey(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("und")
  if (!normalized || normalized.length > 512 || /[\0\r\n]/.test(normalized)) {
    throw new RalphError("RALPH_PARALLEL_CAPACITY_KEY_INVALID", "Capacity key is invalid", {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  return encodeURIComponent(normalized)
}

function limitFor(
  limits: Readonly<Record<string, number>>,
  exact: string,
  fallback?: string,
): number | undefined {
  const value = limits[exact] ?? (fallback ? limits[fallback] : undefined)
  return value === undefined ? undefined : positive(`capacity.${exact}`, value)
}

function leaseConflict(error: unknown): boolean {
  return error instanceof RalphError && error.code === "RALPH_LEASE_CONFLICT"
}

function globalCapacityLedgerLayout(globalLedgerPath: string): WorkspaceLayout {
  const root = dirname(globalLedgerPath)
  const state = join(root, "parallel-capacity-state")
  return {
    root,
    ralph: state,
    identity: join(state, "workspace.json"),
    config: join(state, "config.yaml"),
    ledger: globalLedgerPath,
    migrations: join(state, "migrations"),
    workspaceEvents: join(state, "events.jsonl"),
    runs: join(state, "runs"),
    locks: join(state, "locks"),
    cache: join(state, "cache"),
    checkpoints: join(state, "checkpoints"),
  }
}

export async function createDurableParallelCapacityPort(input: {
  projectLedgerPath: string
  workspaceId: string
  maximumGlobal: number
  maximumProject: number
  maximumByProvider: Readonly<Record<string, number>>
  maximumByModel: Readonly<Record<string, number>>
  environment?: Record<string, string | undefined>
}): Promise<DurableParallelCapacityPort> {
  const maximumGlobal = positive("maximumGlobal", input.maximumGlobal)
  const maximumProject = positive("maximumProject", input.maximumProject)
  const globalLedgerPath = join(
    dirname(globalConfigPath(input.environment ?? process.env)),
    "parallel-capacity.sqlite",
  )
  await mkdir(dirname(globalLedgerPath), { recursive: true })
  // The global capacity ledger is intentionally separate from every project
  // ledger, so it must own and migrate its schema before the first lease is
  // acquired. Opening a bare SQLite file here would otherwise fail on a clean
  // config home with `no such table: leases` before any worker can start.
  await initializeLedger(globalCapacityLedgerLayout(globalLedgerPath))
  const processIdentity = await captureCurrentProcessIdentity()
  const owner: LeaseOwnerIdentity = {
    ownerInstanceId: randomUUID(),
    ...processIdentity,
  }
  const bundles = new Map<string, CapacityBundle>()

  const acquireSlot = async (slot: {
    ledgerPath: string
    workspaceId: string
    runId: string
    workerId: string
    namespace: string
    maximum: number
  }): Promise<CapacityLease | undefined> => {
    for (let ordinal = 1; ordinal <= slot.maximum; ordinal += 1) {
      try {
        const acquired = await acquireDurableLease(
          slot.ledgerPath,
          {
            kind: "worker",
            resourceKey: `parallel-capacity/${slot.namespace}/${ordinal}`,
            workspaceId: slot.workspaceId,
            runId: slot.runId,
            workerId: slot.workerId,
            ...owner,
            command: "ralph-next parallel capacity",
            scope: ["parallel:execute", `parallel:capacity:${slot.namespace}`],
            leaseDurationMs: LEASE_DURATION_MS,
            staleGraceMs: STALE_GRACE_MS,
            staleProbeConfirmations: 2,
            staleProbeIntervalMs: 250,
          },
          { probeOwner: probeProcessIdentity },
        )
        return { ledgerPath: slot.ledgerPath, record: acquired.lease }
      } catch (error) {
        if (!leaseConflict(error)) throw error
      }
    }
    return undefined
  }

  const releaseLeases = (leases: readonly CapacityLease[]): void => {
    let firstFailure: unknown
    for (const lease of [...leases].reverse()) {
      try {
        releaseDurableLease(lease.ledgerPath, lease.record.id, owner)
      } catch (error) {
        firstFailure ??= error
      }
    }
    if (firstFailure) {
      throw new RalphError(
        "RALPH_PARALLEL_CAPACITY_RELEASE_FAILED",
        "At least one durable capacity slot could not be released after all slots were attempted",
        { exitCode: EXIT_CODES.operationalError, cause: firstFailure },
      )
    }
  }

  const renewBundle = (bundle: CapacityBundle): Promise<void> => {
    if (bundle.renewal) return bundle.renewal
    const operation = Promise.resolve().then(() => {
      for (const lease of bundle.leases) {
        lease.record = renewDurableLease(
          lease.ledgerPath,
          lease.record.id,
          owner,
          LEASE_DURATION_MS,
          STALE_GRACE_MS,
        )
      }
    })
    bundle.renewal = operation
    void operation
      .catch((error) => {
        bundle.renewalFailure = error
        clearInterval(bundle.timer)
      })
      .finally(() => {
        if (bundle.renewal === operation) delete bundle.renewal
      })
    return operation
  }

  const releaseBundle = async (leaseId: string): Promise<void> => {
    const bundle = bundles.get(leaseId)
    if (!bundle) return
    bundles.delete(leaseId)
    clearInterval(bundle.timer)
    if (bundle.renewal) await bundle.renewal.catch(() => undefined)
    releaseLeases(bundle.leases)
  }

  return {
    async reserve(request) {
      const leases: CapacityLease[] = []
      const providerLimit = limitFor(input.maximumByProvider, request.providerId)
      const modelKey = `${request.providerId}/${request.modelId}`
      const modelLimit = limitFor(input.maximumByModel, modelKey, request.modelId)
      const scopes = [
        {
          scope: "global" as const,
          ledgerPath: globalLedgerPath,
          workspaceId: GLOBAL_CAPACITY_WORKSPACE_ID,
          namespace: "global",
          maximum: maximumGlobal,
        },
        {
          scope: "project" as const,
          ledgerPath: input.projectLedgerPath,
          workspaceId: input.workspaceId,
          namespace: "project",
          maximum: maximumProject,
        },
        ...(providerLimit
          ? [
              {
                scope: "provider" as const,
                ledgerPath: globalLedgerPath,
                workspaceId: GLOBAL_CAPACITY_WORKSPACE_ID,
                namespace: `provider/${safeKey(request.providerId)}`,
                maximum: providerLimit,
              },
            ]
          : []),
        ...(modelLimit
          ? [
              {
                scope: "model" as const,
                ledgerPath: globalLedgerPath,
                workspaceId: GLOBAL_CAPACITY_WORKSPACE_ID,
                namespace: `model/${safeKey(modelKey)}`,
                maximum: modelLimit,
              },
            ]
          : []),
      ]
      try {
        for (const scope of scopes) {
          const lease = await acquireSlot({
            ledgerPath: scope.ledgerPath,
            workspaceId: scope.workspaceId,
            runId: request.runId,
            workerId: request.workerId,
            namespace: scope.namespace,
            maximum: scope.maximum,
          })
          if (!lease) {
            releaseLeases(leases)
            return {
              status: "full",
              scope: scope.scope,
              reason: `No durable ${scope.scope} capacity slot is available`,
            }
          }
          leases.push(lease)
        }
      } catch (error) {
        releaseLeases(leases)
        throw error
      }
      const id = randomUUID()
      const bundle = {
        id,
        leases,
        timer: setInterval(() => {
          const current = bundles.get(id)
          if (current) void renewBundle(current).catch(() => undefined)
        }, RENEW_INTERVAL_MS),
      } satisfies CapacityBundle
      bundle.timer.unref()
      bundles.set(id, bundle)
      return { status: "reserved", leaseId: id }
    },
    assertOwned(leaseId) {
      const bundle = bundles.get(leaseId)
      if (!bundle) {
        throw new RalphError("RALPH_PARALLEL_CAPACITY_LOST", "Capacity bundle is unavailable", {
          exitCode: EXIT_CODES.conflict,
          details: { leaseId },
        })
      }
      if (bundle.renewalFailure) throw bundle.renewalFailure
      for (const lease of bundle.leases) {
        lease.record = assertDurableLeaseOwned(lease.ledgerPath, lease.record.id, owner)
      }
    },
    async release(leaseId, _reason) {
      await releaseBundle(leaseId)
    },
    async releaseAll(_reason) {
      let firstFailure: unknown
      for (const leaseId of [...bundles.keys()]) {
        try {
          await releaseBundle(leaseId)
        } catch (error) {
          firstFailure ??= error
        }
      }
      if (firstFailure) throw firstFailure
    },
  }
}
