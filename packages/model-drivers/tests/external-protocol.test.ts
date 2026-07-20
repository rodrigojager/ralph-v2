import { describe, expect, test } from "bun:test"
import type { ExecutorOutcome } from "@ralph-next/domain"

import {
  builtinKnownExternalOutputAdapters,
  EXECUTOR_OUTCOME_JSON_ADAPTER_ID,
  parseExternalOutcome,
} from "../src/index"

const outcome: ExecutorOutcome = {
  schemaVersion: 1,
  status: "work_submitted",
  summary: "Implemented one bounded slice",
  intendedFiles: ["src/feature.ts"],
  artifactRefs: [],
  suggestedVerifications: ["run focused check"],
  risks: [],
  reportedAt: "2026-07-18T00:00:00.000Z",
}

describe("external CLI output adapters", () => {
  test("protocol mode accepts only the closed versioned JSON document", async () => {
    const parsed = await parseExternalOutcome({
      adapter: "protocol",
      stdout: JSON.stringify({
        schemaVersion: 1,
        protocol: "ralph.execution.external-cli.v1",
        kind: "outcome",
        outcome,
      }),
      stderr: "",
      exitCode: 0,
    })
    expect(parsed).toEqual(outcome)

    await expect(
      parseExternalOutcome({
        adapter: "protocol",
        stdout: `log before\n${JSON.stringify({
          schemaVersion: 1,
          protocol: "ralph.execution.external-cli.v1",
          kind: "outcome",
          outcome,
        })}`,
        stderr: "",
        exitCode: 0,
      }),
    ).rejects.toThrow("not one valid JSON document")
  })

  test("known mode requires one explicit versioned adapter", async () => {
    const parsed = await parseExternalOutcome({
      adapter: "known-output",
      adapterId: "fixture-v1",
      stdout: "known format",
      stderr: "",
      exitCode: 0,
      knownAdapters: [{ id: "fixture-v1", parse: () => outcome }],
    })
    expect(parsed.summary).toBe(outcome.summary)

    await expect(
      parseExternalOutcome({
        adapter: "known-output",
        adapterId: "missing-v1",
        stdout: "known format",
        stderr: "",
        exitCode: 0,
      }),
    ).rejects.toThrow("unavailable or ambiguous")
  })

  test("ships one deterministic ExecutorOutcome JSON adapter", async () => {
    const parsed = await parseExternalOutcome({
      adapter: "known-output",
      adapterId: EXECUTOR_OUTCOME_JSON_ADAPTER_ID,
      stdout: JSON.stringify(outcome),
      stderr: "",
      exitCode: 0,
      knownAdapters: builtinKnownExternalOutputAdapters(),
    })

    expect(parsed).toEqual(outcome)
  })

  test("generic mode treats TASK_COMPLETE as text and relies on later evidence", async () => {
    const parsed = await parseExternalOutcome({
      adapter: "generic",
      stdout: "TASK_COMPLETE token=super-secret",
      stderr: "",
      exitCode: 0,
      secrets: ["super-secret"],
      now: () => "2026-07-18T00:00:00.000Z",
    })

    expect(parsed.status).toBe("work_submitted")
    expect(parsed.summary).toBe("TASK_COMPLETE token=[REDACTED]")
    expect(parsed.intendedFiles).toEqual([])
    expect(parsed.risks[0]).toContain("workspace evidence and gates")
  })

  test("never converts an unsuccessful process into an executor allegation", async () => {
    await expect(
      parseExternalOutcome({
        adapter: "generic",
        stdout: "TASK_COMPLETE",
        stderr: "failed",
        exitCode: 7,
      }),
    ).rejects.toThrow("status 7")
  })
})
