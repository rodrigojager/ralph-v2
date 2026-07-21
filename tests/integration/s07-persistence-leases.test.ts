import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm } from "node:fs/promises"
import { dirname } from "node:path"

import { RalphError } from "@ralph/domain"
import {
  type AcquireDurableLeaseInput,
  acquireDurableLease,
  appendEvent,
  appendEventInTransaction,
  assertDurableLeaseOwned,
  flushOutbox,
  INITIAL_MIGRATION_SQL,
  initializeLedger,
  type LeaseOwnerIdentity,
  listDurableLeases,
  readActiveDurableLease,
  readDurableLease,
  readEvents,
  readLeaseProbes,
  releaseDurableLease,
  renewDurableLease,
  withLedger,
  workspaceLayout,
} from "@ralph/persistence"

import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []
const T0 = Date.parse("2026-01-02T03:04:05.000Z")

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function temporaryWorkspace(): Promise<ReturnType<typeof workspaceLayout>> {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  const layout = workspaceLayout(root)
  await initializeLedger(layout)
  return layout
}

function workspaceEvent(workspaceId: string, type: string) {
  return {
    type,
    scope: "workspace" as const,
    streamId: `workspace:${workspaceId}`,
    workspaceId,
    payload: { fixture: type },
  }
}

function rowCount(path: string, table: "events" | "outbox", where = ""): number {
  return (
    withLedger(path, (database) =>
      database
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table} ${where}`)
        .get(),
    )?.count ?? 0
  )
}

function captureRalphError(action: () => unknown): RalphError | undefined {
  try {
    action()
  } catch (error) {
    if (error instanceof RalphError) return error
    throw error
  }
  return undefined
}

async function captureAsyncRalphError(
  action: () => Promise<unknown>,
): Promise<RalphError | undefined> {
  try {
    await action()
  } catch (error) {
    if (error instanceof RalphError) return error
    throw error
  }
  return undefined
}

function migrationSnapshot(path: string) {
  const database = new Database(path, { readonly: true, strict: true })
  try {
    database.exec("PRAGMA query_only = ON;")
    return {
      integrity: database.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()
        ?.integrity_check,
      versions: database
        .query<{ version: number; name: string }, []>(
          "SELECT version, name FROM schema_migrations ORDER BY version",
        )
        .all(),
      eventColumns: database
        .query<{ name: string }, []>("PRAGMA table_info(events)")
        .all()
        .map((row) => row.name),
      sentinelEvent: database
        .query<{ event_json: string }, []>(
          "SELECT event_json FROM events WHERE event_id = 'migration-sentinel'",
        )
        .get()?.event_json,
      runColumns: database
        .query<{ name: string }, []>("PRAGMA table_info(runs)")
        .all()
        .map((row) => row.name),
      sentinelRun: database
        .query<{ sentinel: string }, []>("SELECT sentinel FROM runs WHERE id = 'legacy-run'")
        .get()?.sentinel,
    }
  } finally {
    database.close(true)
  }
}

function owner(
  ownerInstanceId: string,
  processStartToken: string,
  overrides: Partial<LeaseOwnerIdentity> = {},
): LeaseOwnerIdentity {
  return {
    ownerInstanceId,
    pid: 4_242,
    processStartToken,
    hostname: "fixture-host",
    ...overrides,
  }
}

function leaseInput(
  id: string,
  workspaceId: string,
  leaseOwner: LeaseOwnerIdentity,
  overrides: Partial<AcquireDurableLeaseInput> = {},
): AcquireDurableLeaseInput {
  return {
    id,
    kind: "workspace-supervisor",
    resourceKey: "workspace-writer",
    workspaceId,
    ...leaseOwner,
    command: "ralph run --resume auto",
    scope: ["workspace:write", "run:supervise", "workspace:write"],
    leaseDurationMs: 1_000,
    staleGraceMs: 500,
    staleProbeConfirmations: 2,
    staleProbeIntervalMs: 10,
    ...overrides,
  }
}

describe("S07.01 durable ledger failure boundaries", () => {
  test("keeps WAL reader snapshots consistent while another connection appends", async () => {
    const layout = await temporaryWorkspace()
    appendEvent(layout.ledger, workspaceEvent("reader-fixture", "reader.before"))

    const readers = [
      new Database(layout.ledger, { readonly: true, strict: true }),
      new Database(layout.ledger, { readonly: true, strict: true }),
    ]
    try {
      for (const reader of readers) {
        reader.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; BEGIN;")
        expect(
          reader.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count,
        ).toBe(1)
      }

      const appended = appendEvent(
        layout.ledger,
        workspaceEvent("reader-fixture", "reader.concurrent"),
      )
      expect(appended.sequence).toBe(2)
      expect(readEvents(layout.ledger).map((event) => event.type)).toEqual([
        "reader.before",
        "reader.concurrent",
      ])

      for (const reader of readers) {
        expect(
          reader.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count,
        ).toBe(1)
        reader.exec("COMMIT;")
        expect(
          reader.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()?.count,
        ).toBe(2)
      }
    } finally {
      for (const reader of readers) {
        try {
          reader.exec("ROLLBACK;")
        } catch {
          // The successful path already committed the read transaction.
        }
        reader.close(true)
      }
    }
  })

  test("rolls back interrupted appends and outbox insert failures atomically", async () => {
    const layout = await temporaryWorkspace()
    appendEvent(layout.ledger, workspaceEvent("append-fixture", "append.baseline"))

    expect(() =>
      withLedger(layout.ledger, (database) =>
        database
          .transaction(() => {
            appendEventInTransaction(
              database,
              workspaceEvent("append-fixture", "append.crash"),
              "event-interrupted-after-append",
            )
            throw new Error("injected crash after transactional append")
          })
          .immediate(),
      ),
    ).toThrow("injected crash after transactional append")
    expect(rowCount(layout.ledger, "events")).toBe(1)
    expect(rowCount(layout.ledger, "outbox")).toBe(1)

    withLedger(layout.ledger, (database) =>
      database.exec(`
        CREATE TRIGGER s07_abort_outbox_insert
        BEFORE INSERT ON outbox
        BEGIN
          SELECT RAISE(ABORT, 'injected outbox insert failure');
        END;
      `),
    )
    try {
      expect(() =>
        appendEvent(layout.ledger, workspaceEvent("append-fixture", "append.outbox-failure")),
      ).toThrow("injected outbox insert failure")
    } finally {
      withLedger(layout.ledger, (database) =>
        database.exec("DROP TRIGGER IF EXISTS s07_abort_outbox_insert"),
      )
    }
    expect(rowCount(layout.ledger, "events")).toBe(1)
    expect(rowCount(layout.ledger, "outbox")).toBe(1)
    expect(readEvents(layout.ledger).map((event) => event.type)).toEqual(["append.baseline"])
  })

  test("retains an unpublished outbox row across projection failure and repairs on retry", async () => {
    const layout = await temporaryWorkspace()
    appendEvent(layout.ledger, workspaceEvent("projection-fixture", "projection.baseline"))
    expect(await flushOutbox(layout)).toBe(1)
    appendEvent(layout.ledger, workspaceEvent("projection-fixture", "projection.pending"))

    await rm(layout.workspaceEvents, { force: true })
    await mkdir(layout.workspaceEvents)
    let projectionFailure: unknown
    try {
      await flushOutbox(layout)
    } catch (error) {
      projectionFailure = error
    }
    expect(projectionFailure).toBeInstanceOf(Error)
    expect(rowCount(layout.ledger, "events")).toBe(2)
    expect(rowCount(layout.ledger, "outbox", "WHERE published_at IS NULL")).toBe(1)

    await rm(layout.workspaceEvents, { recursive: true, force: true })
    expect(await flushOutbox(layout)).toBe(1)
    expect(rowCount(layout.ledger, "outbox", "WHERE published_at IS NULL")).toBe(0)
    const projected = (await readFile(layout.workspaceEvents, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string })
    expect(projected.map((event) => event.type)).toEqual([
      "projection.baseline",
      "projection.pending",
    ])
  })

  test("creates a readable pre-migration backup and preserves the failed source ledger", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    const layout = workspaceLayout(root)
    await mkdir(dirname(layout.ledger), { recursive: true })
    const legacy = new Database(layout.ledger, { create: true, strict: true })
    try {
      legacy.exec(INITIAL_MIGRATION_SQL)
      legacy
        .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (1, ?, ?)")
        .run("initial", new Date(T0).toISOString())
      legacy
        .query("INSERT INTO events(event_id, event_json, created_at) VALUES (?, ?, ?)")
        .run("migration-sentinel", '{"fixture":"preserve-me"}', new Date(T0).toISOString())
      legacy.exec(
        "CREATE TABLE runs(id TEXT PRIMARY KEY, sentinel TEXT NOT NULL); INSERT INTO runs VALUES ('legacy-run', 'preserve-me');",
      )
    } finally {
      legacy.close(true)
    }
    const before = migrationSnapshot(layout.ledger)

    const failure = await captureAsyncRalphError(() => initializeLedger(layout))
    expect(failure?.code).toBe("RALPH_LEDGER_MIGRATION_FAILED")
    const backup = failure?.diagnostic.details?.backup
    expect(typeof backup).toBe("string")
    if (typeof backup !== "string") throw new Error("Migration failure did not retain a backup")
    expect(await Bun.file(backup).exists()).toBeTrue()

    expect(migrationSnapshot(layout.ledger)).toEqual(before)
    expect(migrationSnapshot(backup)).toEqual(before)
    expect(before).toEqual({
      integrity: "ok",
      versions: [{ version: 1, name: "initial" }],
      eventColumns: ["sequence", "event_id", "event_json", "created_at"],
      sentinelEvent: '{"fixture":"preserve-me"}',
      runColumns: ["id", "sentinel"],
      sentinelRun: "preserve-me",
    })
  })
})

describe("S07.03 durable supervisor leases", () => {
  test("acquires, renews, asserts and releases workspace and run supervisor leases", async () => {
    const layout = await temporaryWorkspace()
    const leaseOwner = owner("owner-lifecycle", "process-start-A")
    const acquired = await acquireDurableLease(
      layout.ledger,
      leaseInput("lease-workspace", "workspace-lifecycle", leaseOwner),
      { now: () => new Date(T0) },
    )
    expect(acquired.probes).toEqual([])
    expect(acquired.lease).toMatchObject({
      id: "lease-workspace",
      kind: "workspace-supervisor",
      resourceKey: "workspace-writer",
      workspaceId: "workspace-lifecycle",
      ownerInstanceId: "owner-lifecycle",
      pid: 4_242,
      processStartToken: "process-start-A",
      hostname: "fixture-host",
      acquiredAt: "2026-01-02T03:04:05.000Z",
      renewedAt: "2026-01-02T03:04:05.000Z",
      expiresAt: "2026-01-02T03:04:06.000Z",
      graceExpiresAt: "2026-01-02T03:04:06.500Z",
      status: "active",
      revision: 0,
      scope: ["run:supervise", "workspace:write"],
    })

    const renewed = renewDurableLease(
      layout.ledger,
      acquired.lease.id,
      leaseOwner,
      2_000,
      750,
      () => new Date(T0 + 500),
    )
    expect(renewed).toMatchObject({
      renewedAt: "2026-01-02T03:04:05.500Z",
      expiresAt: "2026-01-02T03:04:07.500Z",
      graceExpiresAt: "2026-01-02T03:04:08.250Z",
      revision: 1,
    })
    expect(
      assertDurableLeaseOwned(layout.ledger, renewed.id, leaseOwner, new Date(T0 + 2_499)),
    ).toEqual(renewed)
    expect(
      captureRalphError(() =>
        assertDurableLeaseOwned(layout.ledger, renewed.id, leaseOwner, new Date(T0 + 2_500)),
      )?.code,
    ).toBe("RALPH_LEASE_LOST")
    expect(
      captureRalphError(() =>
        renewDurableLease(
          layout.ledger,
          renewed.id,
          owner("owner-lifecycle", "reused-process-token"),
          2_000,
          750,
        ),
      )?.code,
    ).toBe("RALPH_LEASE_LOST")
    expect(
      captureRalphError(() =>
        renewDurableLease(
          layout.ledger,
          renewed.id,
          owner("owner-lifecycle", "process-start-A", { hostname: "different-host" }),
          2_000,
          750,
        ),
      )?.code,
    ).toBe("RALPH_LEASE_LOST")

    const released = releaseDurableLease(
      layout.ledger,
      renewed.id,
      leaseOwner,
      () => new Date(T0 + 1_000),
    )
    expect(released).toMatchObject({
      status: "released",
      revision: 2,
      releasedAt: "2026-01-02T03:04:06.000Z",
    })
    expect(releaseDurableLease(layout.ledger, renewed.id, leaseOwner)).toEqual(released)
    expect(
      readActiveDurableLease(
        layout.ledger,
        "workspace-lifecycle",
        "workspace-supervisor",
        "workspace-writer",
      ),
    ).toBeUndefined()

    const runLease = await acquireDurableLease(
      layout.ledger,
      leaseInput("lease-run", "workspace-lifecycle", leaseOwner, {
        kind: "run-supervisor",
        resourceKey: "run:run-lifecycle",
        runId: "run-lifecycle",
      }),
      { now: () => new Date(T0 + 2_000) },
    )
    expect(runLease.lease).toMatchObject({
      kind: "run-supervisor",
      resourceKey: "run:run-lifecycle",
      runId: "run-lifecycle",
    })
    releaseDurableLease(layout.ledger, runLease.lease.id, leaseOwner, () => new Date(T0 + 2_100))

    expect(
      readEvents(layout.ledger)
        .filter((event) => event.payload.leaseId === "lease-workspace")
        .map((event) => event.type),
    ).toEqual(["lease.acquired", "lease.renewed", "lease.released"])
  })

  test("waits through expiration and grace, probes stale identity, and handles PID reuse", async () => {
    const layout = await temporaryWorkspace()
    const originalOwner = owner("owner-original", "process-start-original")
    const reusedPidOwner = owner("owner-reused-pid", "process-start-reused")
    await acquireDurableLease(
      layout.ledger,
      leaseInput("lease-original", "workspace-reuse", originalOwner, { staleGraceMs: 1_000 }),
      { now: () => new Date(T0) },
    )

    let probes = 0
    const beforeExpiry = await captureAsyncRalphError(() =>
      acquireDurableLease(
        layout.ledger,
        leaseInput("lease-too-early", "workspace-reuse", reusedPidOwner, {
          staleGraceMs: 1_000,
        }),
        {
          now: () => new Date(T0 + 999),
          probeOwner: async () => {
            probes += 1
            return { status: "identity-mismatch", reason: "should not be called" }
          },
        },
      ),
    )
    expect(beforeExpiry?.code).toBe("RALPH_LEASE_CONFLICT")
    expect(String(beforeExpiry?.diagnostic.details?.reason)).toContain("not expired")
    expect(probes).toBe(0)

    const insideGrace = await captureAsyncRalphError(() =>
      acquireDurableLease(
        layout.ledger,
        leaseInput("lease-in-grace", "workspace-reuse", reusedPidOwner, {
          staleGraceMs: 1_000,
        }),
        {
          now: () => new Date(T0 + 1_500),
          probeOwner: async () => {
            probes += 1
            return { status: "identity-mismatch", reason: "should not be called" }
          },
        },
      ),
    )
    expect(insideGrace?.code).toBe("RALPH_LEASE_CONFLICT")
    expect(String(insideGrace?.diagnostic.details?.reason)).toContain("stale grace period")
    expect(probes).toBe(0)

    const aliveConflict = await captureAsyncRalphError(() =>
      acquireDurableLease(
        layout.ledger,
        leaseInput("lease-owner-alive", "workspace-reuse", reusedPidOwner, {
          staleGraceMs: 1_000,
        }),
        {
          now: () => new Date(T0 + 2_001),
          probeOwner: async () => {
            probes += 1
            return {
              status: "alive",
              observedProcessStartToken: "process-start-original",
              reason: "same process identity is still alive",
            }
          },
        },
      ),
    )
    expect(aliveConflict?.code).toBe("RALPH_LEASE_CONFLICT")
    expect(String(aliveConflict?.diagnostic.details?.reason)).toContain(
      "confirmed the owner is alive",
    )
    expect(probes).toBe(1)
    expect(readDurableLease(layout.ledger, "lease-original")?.status).toBe("active")

    const probeIds = ["probe-reuse-1", "probe-reuse-2"]
    const sleeps: number[] = []
    const replacement = await acquireDurableLease(
      layout.ledger,
      leaseInput("lease-replacement", "workspace-reuse", reusedPidOwner, {
        staleGraceMs: 1_000,
      }),
      {
        now: () => new Date(T0 + 2_002),
        id: () => probeIds.shift() ?? "unexpected-probe-id",
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
        },
        probeOwner: async (lease) => ({
          status: "identity-mismatch",
          observedProcessStartToken: "process-start-reused",
          reason: `pid ${lease.pid} was reused with a different start token`,
        }),
      },
    )
    expect(sleeps).toEqual([10])
    expect(replacement.lease).toMatchObject({
      id: "lease-replacement",
      pid: originalOwner.pid,
      processStartToken: "process-start-reused",
      status: "active",
    })
    expect(replacement.displacedLease).toMatchObject({
      id: "lease-original",
      status: "stolen",
      replacedByLeaseId: "lease-replacement",
    })
    expect(replacement.probes).toEqual([
      {
        schemaVersion: 1,
        id: "probe-reuse-1",
        leaseId: "lease-original",
        observerInstanceId: "owner-reused-pid",
        sequence: 1,
        status: "identity-mismatch",
        expectedProcessStartToken: "process-start-original",
        observedProcessStartToken: "process-start-reused",
        observedAt: "2026-01-02T03:04:07.002Z",
        reason: "pid 4242 was reused with a different start token",
      },
      {
        schemaVersion: 1,
        id: "probe-reuse-2",
        leaseId: "lease-original",
        observerInstanceId: "owner-reused-pid",
        sequence: 2,
        status: "identity-mismatch",
        expectedProcessStartToken: "process-start-original",
        observedProcessStartToken: "process-start-reused",
        observedAt: "2026-01-02T03:04:07.002Z",
        reason: "pid 4242 was reused with a different start token",
      },
    ])
    expect([...readLeaseProbes(layout.ledger, "lease-original")]).toEqual([...replacement.probes])
    expect(
      readEvents(layout.ledger)
        .filter((event) => event.payload.leaseId === "lease-original")
        .map((event) => event.type),
    ).toEqual(["lease.acquired", "lease.lost"])
  })

  test("keeps identical lease identities isolated across two project ledgers", async () => {
    const [projectA, projectB] = await Promise.all([temporaryWorkspace(), temporaryWorkspace()])
    const sharedOwner = owner("same-owner", "same-process-start")
    const [leaseA, leaseB] = await Promise.all([
      acquireDurableLease(projectA.ledger, leaseInput("same-lease-id", "project-a", sharedOwner), {
        now: () => new Date(T0),
      }),
      acquireDurableLease(projectB.ledger, leaseInput("same-lease-id", "project-b", sharedOwner), {
        now: () => new Date(T0),
      }),
    ])

    expect(leaseA.lease.id).toBe("same-lease-id")
    expect(leaseB.lease.id).toBe("same-lease-id")
    expect(leaseA.lease.workspaceId).toBe("project-a")
    expect(leaseB.lease.workspaceId).toBe("project-b")
    expect(listDurableLeases(projectA.ledger)).toEqual([leaseA.lease])
    expect(listDurableLeases(projectB.ledger)).toEqual([leaseB.lease])

    const releasedA = releaseDurableLease(
      projectA.ledger,
      leaseA.lease.id,
      sharedOwner,
      () => new Date(T0 + 100),
    )
    expect(releasedA.status).toBe("released")
    expect(readDurableLease(projectB.ledger, leaseB.lease.id)?.status).toBe("active")
    releaseDurableLease(projectB.ledger, leaseB.lease.id, sharedOwner, () => new Date(T0 + 100))
  })
})
