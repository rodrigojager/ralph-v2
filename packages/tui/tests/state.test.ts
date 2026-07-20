import { describe, expect, test } from "bun:test"
import { buildSnapshotView, createEmptyRunUiSnapshot, formatUsage, runUiReducer } from "../src"
import { populatedSnapshot } from "./fixture"

describe("RunUiSnapshot reducer", () => {
  test("projects engine updates without mutating the previous snapshot", () => {
    const empty = createEmptyRunUiSnapshot("run-state")
    const running = runUiReducer(empty, { type: "status", status: "running" })
    const progressed = runUiReducer(running, { type: "progress", completed: 2, total: 5 })
    const withTask = runUiReducer(progressed, {
      type: "task",
      task: { id: "T-2", title: "Thin slice", status: "executing" },
    })
    const withLog = runUiReducer(withTask, {
      type: "append",
      channel: "logs",
      entry: { type: "info", message: "first" },
      limit: 1,
    })

    expect(empty.status).toBe("idle")
    expect(empty.progress).toEqual({ completed: 0, total: 0 })
    expect(empty.evaluationOrigins).toEqual({})
    expect(withLog).toMatchObject({
      status: "running",
      progress: { completed: 2, total: 5 },
      currentTask: { id: "T-2" },
      logs: [{ message: "first" }],
    })
  })

  test("bounds recent channels and engine output", () => {
    let snapshot = createEmptyRunUiSnapshot()
    for (const message of ["one", "two", "three"]) {
      snapshot = runUiReducer(snapshot, {
        type: "append",
        channel: "events",
        entry: { message },
        limit: 2,
      })
      snapshot = runUiReducer(snapshot, { type: "engine-output", line: message, limit: 2 })
    }
    expect(snapshot.events.map((entry) => entry.message)).toEqual(["two", "three"])
    expect(snapshot.engineOutput).toEqual(["two", "three"])
  })

  test("projects evaluation origins independently from evaluation values", () => {
    const snapshot = runUiReducer(createEmptyRunUiSnapshot(), {
      type: "evaluation-origins",
      origins: { judgeThreshold: "cli (--judge-threshold)" },
    })

    expect(snapshot.evaluationOrigins).toEqual({
      judgeThreshold: "cli (--judge-threshold)",
    })
    expect(snapshot.evaluationValues).toEqual({})
  })
})

describe("snapshot view", () => {
  test("keeps executor and judge usage sources separate and explicit", () => {
    const view = buildSnapshotView(populatedSnapshot(), 12, "ascii")
    expect(view.progressLabel).toBe("6/12 · 50%")
    expect(view.progressBar).toBe("######------")
    expect(view.combinedUsage).toBe(
      "unavailable · source=incomplete-role-usage · judge usage unavailable",
    )
    expect(view.executorUsage).toContain("source=provider-final")
    expect(view.executorUsage).toContain("0.012345 USD (provider)")
    expect(view.judgeUsage).toBe("unavailable · source=provider-did-not-report · no usage event")
    expect(view.judgeLabel).toContain("74/85")
    expect(view.judgeLabel).toContain("revisions 1/3")
  })

  test("does not manufacture tokens or costs when a provider omits them", () => {
    expect(formatUsage({ available: true, source: "provider" })).toBe(
      "source=provider · tokens not reported · cost not reported",
    )
  })
})
