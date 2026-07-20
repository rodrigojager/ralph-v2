import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { RalphError } from "@ralph-next/domain"
import { acquireExecutionLock, type ExecutionLock } from "@ralph-next/orchestration"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []
const heldLocks: ExecutionLock[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await createTestDirectory()
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(heldLocks.splice(0).map((lock) => lock.release()))
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

async function captureRalphError(action: () => Promise<unknown>): Promise<RalphError | undefined> {
  try {
    await action()
  } catch (error) {
    if (error instanceof RalphError) return error
    throw error
  }
  return undefined
}

describe("S03 workspace execution lock", () => {
  test("provides mutual exclusion without replacing the current owner", async () => {
    const root = await temporaryDirectory()
    const locksDirectory = resolve(root, "locks")
    const first = await acquireExecutionLock(locksDirectory, "run-owner")
    heldLocks.push(first)
    const before = await readFile(first.path, "utf8")

    const conflict = await captureRalphError(() =>
      acquireExecutionLock(locksDirectory, "run-contender"),
    )

    expect(conflict?.code).toBe("RALPH_EXECUTION_ALREADY_ACTIVE")
    expect(conflict?.diagnostic.details?.owner).toBe(before.trim())
    expect(await readFile(first.path, "utf8")).toBe(before)
  })

  test("release is idempotent and permits a later clean acquisition", async () => {
    const root = await temporaryDirectory()
    const locksDirectory = resolve(root, "locks")
    const first = await acquireExecutionLock(locksDirectory, "run-first")

    await first.release()
    await first.release()

    const next = await acquireExecutionLock(locksDirectory, "run-next")
    heldLocks.push(next)
    expect(next.token).not.toBe(first.token)
    expect(JSON.parse(await readFile(next.path, "utf8"))).toMatchObject({
      schemaVersion: 1,
      token: next.token,
      runId: "run-next",
    })
  })

  test("never steals a stale-looking or dead-owner lock in S03", async () => {
    const root = await temporaryDirectory()
    const locksDirectory = resolve(root, "locks")
    const lockPath = resolve(locksDirectory, "execution.lock")
    await mkdir(locksDirectory, { recursive: true })
    const staleOwner = `${JSON.stringify({
      schemaVersion: 1,
      token: "stale-owner-token",
      pid: 2_147_483_647,
      runId: "old-run",
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`
    await writeFile(lockPath, staleOwner, { encoding: "utf8", mode: 0o600 })

    const conflict = await captureRalphError(() => acquireExecutionLock(locksDirectory, "new-run"))

    expect(conflict?.code).toBe("RALPH_EXECUTION_ALREADY_ACTIVE")
    expect(conflict?.diagnostic.hint).toContain("never steals")
    expect(await readFile(lockPath, "utf8")).toBe(staleOwner)
  })
})
