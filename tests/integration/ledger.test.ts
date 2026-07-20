import { afterEach, describe, expect, test } from "bun:test"
import { appendFile } from "node:fs/promises"
import {
  appendEvent,
  flushOutbox,
  initializeLedger,
  readEvents,
  registerLedgerRedactionSecrets,
  withLedger,
  workspaceLayout,
} from "@ralph-next/persistence"
import { EventEnvelopeSchema, replayWorkspaceEvents } from "@ralph-next/telemetry"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("SQLite ledger and JSONL outbox", () => {
  test("commits ordered events, flushes at least once and replays the same snapshot", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)

    const first = appendEvent(layout.ledger, {
      type: "workspace.initialized",
      scope: "workspace",
      streamId: "workspace:ws-1",
      workspaceId: "ws-1",
      payload: { fixture: true },
    })
    const second = appendEvent(layout.ledger, {
      type: "workspace.inspected",
      scope: "workspace",
      streamId: "workspace:ws-1",
      workspaceId: "ws-1",
    })
    expect([first.sequence, second.sequence]).toEqual([1, 2])
    expect(readEvents(layout.ledger).map((event) => event.eventId)).toEqual([
      first.eventId,
      second.eventId,
    ])

    expect(await flushOutbox(layout)).toBe(2)
    expect(await flushOutbox(layout)).toBe(0)
    const lines = (await Bun.file(layout.workspaceEvents).text()).trim().split(/\r?\n/)
    const published = lines.map((line) => EventEnvelopeSchema.parse(JSON.parse(line)))
    expect(published).toEqual(readEvents(layout.ledger))
    expect(replayWorkspaceEvents(published)).toEqual(
      replayWorkspaceEvents(readEvents(layout.ledger)),
    )
    expect(replayWorkspaceEvents(published)).toMatchObject({
      initialized: true,
      eventCursor: 2,
      eventCount: 2,
      lastEventType: "workspace.inspected",
    })

    const unpublished = withLedger(layout.ledger, (database) =>
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM outbox WHERE published_at IS NULL",
        )
        .get(),
    )
    expect(unpublished?.count).toBe(0)
  })

  test("deduplicates an event already present in JSONL before settling its outbox row", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    const event = appendEvent(layout.ledger, {
      type: "workspace.initialized",
      scope: "workspace",
      streamId: "workspace:ws-dedupe",
      workspaceId: "ws-dedupe",
    })

    await appendFile(layout.workspaceEvents, `${JSON.stringify(event)}\n`)
    expect(await flushOutbox(layout)).toBe(1)
    expect(await flushOutbox(layout)).toBe(0)
    const nonEmptyLines = (await Bun.file(layout.workspaceEvents).text())
      .split(/\r?\n/)
      .filter(Boolean)
    expect(nonEmptyLines).toHaveLength(1)
    expect(EventEnvelopeSchema.parse(JSON.parse(nonEmptyLines[0] as string))).toEqual(event)
  })

  test("rebuilds a truncated JSONL tail from the authoritative ledger", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    const event = appendEvent(layout.ledger, {
      type: "workspace.initialized",
      scope: "workspace",
      streamId: "workspace:ws-reconcile",
      workspaceId: "ws-reconcile",
    })

    await Bun.write(layout.workspaceEvents, '{"truncated":')
    expect(await flushOutbox(layout)).toBe(1)
    const lines = (await Bun.file(layout.workspaceEvents).text()).trim().split(/\r?\n/)
    expect(lines).toHaveLength(1)
    expect(EventEnvelopeSchema.parse(JSON.parse(lines[0] as string))).toEqual(event)
  })

  test("redacts secrets before event persistence and JSONL projection", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    const previous = process.env.RALPH_API_KEY
    process.env.RALPH_API_KEY = "ledger-secret-canary"
    try {
      appendEvent(layout.ledger, {
        type: "workspace.secret-test",
        scope: "workspace",
        streamId: "workspace:ws-redaction",
        workspaceId: "ws-redaction",
        payload: {
          apiKey: "another-secret",
          benignField: "ledger-secret-canary",
        },
      })
    } finally {
      if (previous === undefined) delete process.env.RALPH_API_KEY
      else process.env.RALPH_API_KEY = previous
    }

    expect(readEvents(layout.ledger)[0]?.payload).toEqual({
      apiKey: "[REDACTED]",
      benignField: "[REDACTED]",
    })
    await flushOutbox(layout)
    const projection = await Bun.file(layout.workspaceEvents).text()
    expect(projection).not.toContain("ledger-secret-canary")
    expect(projection).not.toContain("another-secret")
  })

  test("redacts execution-scoped secrets that are not present in process.env", async () => {
    const root = await temporaryDirectory()
    const layout = workspaceLayout(root)
    await initializeLedger(layout)
    const canary = "injected-command-context-secret-canary"
    expect(Object.values(process.env)).not.toContain(canary)
    const release = registerLedgerRedactionSecrets(layout.ledger, [canary])
    try {
      appendEvent(layout.ledger, {
        type: "run.injected-secret-test",
        scope: "run",
        streamId: "run:secret-test",
        workspaceId: "ws-secret-test",
        runId: "secret-test",
        payload: { backendMessage: `provider failed with ${canary}` },
      })
    } finally {
      release()
    }

    const persisted = JSON.stringify(readEvents(layout.ledger))
    expect(persisted).not.toContain(canary)
    expect(persisted).toContain("[REDACTED]")
    await flushOutbox(layout)
    expect(await Bun.file(layout.workspaceEvents).text()).not.toContain(canary)
  })
})
