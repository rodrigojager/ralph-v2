import { afterEach, describe, expect, test } from "bun:test"
import { cp, readFile, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { initializeWorkspace, workspaceLayout } from "@ralph/persistence"
import { stringify } from "yaml"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const CLI_ENTRY = resolve(import.meta.dir, "../../apps/ralph-cli/src/main.ts")
const EXECUTION_FIXTURE = resolve(import.meta.dir, "../fixtures/execution/single-pass")
const EXECUTOR_FIXTURE = resolve(import.meta.dir, "../fixtures/s06/external-revision-executor.ts")
const JUDGE_FIXTURE = resolve(import.meta.dir, "../fixtures/s06/external-sequence-judge.ts")
const REVISION_RECOMMENDATION = "Address this assessment in one bounded revision."
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

function externalProfile(role: "executor" | "judge", fixture: string) {
  return {
    role,
    backend: "external-cli",
    provider: "fixture",
    model: `${role}-fixture-v1`,
    parameters: {},
    requirements: role === "judge" ? { structured_output: true } : {},
    fallback_profiles: [],
    fallback_on: [],
    limits: {},
    external_cli: {
      executable: process.execPath,
      args: [fixture],
      cwd: ".",
      environment_refs: {},
      input_mode: "stdin-json",
      adapter: role === "judge" ? "known-output" : "protocol",
      ...(role === "judge" ? { adapter_id: "judge-output-json-v1" } : {}),
      capabilities: {
        streaming: false,
        tool_calling: role === "judge" ? "unavailable" : "ralph",
        cancellation: true,
        usage: "unavailable",
      },
      mutation_mode: "read-only",
      timeout_ms: 10_000,
      output_limit_bytes: 1_048_576,
    },
  }
}

describe("S06 public executable judge smoke", () => {
  test("actual CLI entrypoint performs external 60 -> revision -> 88 and persists the report", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    await cp(EXECUTION_FIXTURE, root, { recursive: true })
    await unlink(resolve(root, "product", "capability.txt"))
    await initializeWorkspace(root, "0.1.0-s06-public-entrypoint")
    const prd = resolve(root, "PRD.md")
    const fixturePrd = await readFile(prd, "utf8")
    const smokePrd = fixturePrd.replace(
      "model_calls=1; timeout=20s",
      "model_calls=3; tool_calls=2; timeout=120s",
    )
    if (smokePrd === fixturePrd) throw new Error("Public judge smoke task timeout was not found")
    // This smoke crosses the public CLI plus three cold external-CLI process
    // turns. Keep the product task deadline below both outer guards while
    // allowing a loaded hosted Windows runner to make healthy progress.
    await writeFile(prd, smokePrd)
    await writeFile(
      workspaceLayout(root).config,
      stringify({
        schema_version: 1,
        profiles: {
          "fixture-executor": externalProfile("executor", EXECUTOR_FIXTURE),
          "fixture-judge": externalProfile("judge", JUDGE_FIXTURE),
        },
        security: {
          mode: "auto",
          headless_ask: "deny",
          tool_rules: { "fs.write": "allow" },
          allowed_commands: [],
          read_paths: ["."],
          write_paths: ["product"],
          allow_shell: false,
        },
      }),
    )

    const child = Bun.spawn(
      [
        process.execPath,
        CLI_ENTRY,
        "once",
        "--workspace",
        root,
        "--prd",
        "PRD.md",
        "--executor-profile",
        "fixture-executor",
        "--evaluation",
        "external",
        "--judge-profile",
        "fixture-judge",
        "--judge-threshold",
        "85",
        "--judge-max-revisions",
        "1",
        "--headless-ask",
        "deny",
        "--format",
        "json",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          RALPH_CONFIG_HOME: resolve(root, "isolated-global-config"),
        },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const exitPromise = child.exited
    const stdoutPromise = new Response(child.stdout).text()
    const stderrPromise = new Response(child.stderr).text()
    const settlement = Promise.all([exitPromise, stdoutPromise, stderrPromise])
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const [exitCode, stdout, stderr] = await Promise.race([
        settlement,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            if (child.exitCode === null) child.kill()
            reject(new Error("Public entrypoint smoke exceeded its 150s subprocess deadline"))
          }, 150_000)
        }),
      ])

      expect({ exitCode, stderr, ...(exitCode === 0 ? {} : { stdout }) }).toEqual({
        exitCode: 0,
        stderr: "",
      })
      const result = JSON.parse(stdout) as {
        ok: boolean
        runId: string
        data: {
          status: string
          report: {
            counters: { revisionAttempts: number; judgeTransportRetries: number }
            tasks: Array<{ judgeAssessments: Array<{ score: number; kind: string }> }>
          }
        }
      }
      expect(result).toMatchObject({
        ok: true,
        data: {
          status: "completed",
          report: {
            counters: { revisionAttempts: 1, judgeTransportRetries: 0 },
            tasks: [{ judgeAssessments: [{ score: 60 }, { score: 88 }] }],
          },
        },
      })
      expect(result.data.report.tasks[0]?.judgeAssessments.map((item) => item.kind)).toEqual([
        "external",
        "external",
      ])
      expect(await readFile(resolve(root, "product", "capability.txt"), "utf8")).toBe("delivered")
      const revisionSlug = REVISION_RECOMMENDATION.toLocaleLowerCase("en-US")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 56)
      expect(await readFile(resolve(root, "product", `${revisionSlug}.txt`), "utf8")).toBe(
        [
          "score=60/85",
          "problem=Apply one explicit revision before approval.",
          `recommendation=${REVISION_RECOMMENDATION}`,
        ].join("\n"),
      )
      expect(await readFile(prd, "utf8")).toContain("- [x] **deliver-capability")
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      if (child.exitCode === null) child.kill()
      await Promise.allSettled([exitPromise, stdoutPromise, stderrPromise])
    }
  }, 180_000)
})
