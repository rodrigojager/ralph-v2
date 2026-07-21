import { describe, expect, test } from "bun:test"
import { createGitCommandPort } from "@ralph/orchestration"
import type {
  ProcessSettlement,
  ProcessSupervisor,
  SupervisedProcessHandle,
  SupervisedProcessRequest,
} from "@ralph/supervisor"

function settlement(request: SupervisedProcessRequest): ProcessSettlement {
  return {
    argv: [request.executable, ...request.args],
    cwd: request.cwd,
    exitCode: 0,
    stdout: "",
    stderr: "",
    rawStdout: "",
    rawStderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTruncated: false,
    rawOutputTruncated: false,
    outputRefs: [],
    timedOut: false,
    cancelled: false,
    treeTerminated: true,
    durationMs: 1,
  }
}

describe("Git command runtime port", () => {
  test("serializes only shared worktree metadata mutations", async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: string[] = []
    let activeMutations = 0
    let maximumActiveMutations = 0
    const supervisor: ProcessSupervisor = {
      which: () => "git",
      start: async (): Promise<SupervisedProcessHandle> => {
        throw new Error("start is not used by the Git command port")
      },
      async run(request) {
        const label = request.args.join(" ")
        started.push(label)
        const mutation = request.args[0] === "worktree" && request.args[1] === "add"
        if (mutation) {
          activeMutations += 1
          maximumActiveMutations = Math.max(maximumActiveMutations, activeMutations)
          if (request.args.includes("first")) await firstMayFinish
          activeMutations -= 1
        }
        return settlement(request)
      },
    }
    const port = createGitCommandPort({}, supervisor)

    const first = port.run({
      cwd: "repository",
      args: ["worktree", "add", "first"],
      timeoutMs: 1_000,
    })
    await Promise.resolve()
    const second = port.run({
      cwd: "repository",
      args: ["worktree", "add", "second"],
      timeoutMs: 1_000,
    })
    const read = port.run({
      cwd: "repository",
      args: ["status", "--porcelain"],
      timeoutMs: 1_000,
    })
    await Promise.resolve()

    expect(started).toEqual(["worktree add first", "status --porcelain"])
    releaseFirst()
    await Promise.all([first, second, read])

    expect(started).toEqual(["worktree add first", "status --porcelain", "worktree add second"])
    expect(maximumActiveMutations).toBe(1)
  })
})
