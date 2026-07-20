import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { readFile, realpath, rm } from "node:fs/promises"
import { basename, resolve } from "node:path"
import { parseCiStepArguments, runCiStep } from "../../scripts/ci/run-step"

const projectRoot = resolve(import.meta.dir, "../..")
const cleanupRoots: string[] = []

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function receiptPath(name: string): { absolute: string; relative: string; root: string } {
  const root = resolve(projectRoot, "artifacts", "tests", `ci-step-${randomUUID()}`)
  cleanupRoots.push(root)
  return {
    root,
    absolute: resolve(root, `${name}.json`),
    relative: `artifacts/tests/${root.split(/[\\/]/u).at(-1)}/${name}.json`,
  }
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe("CI step receipts", () => {
  test("parses a command only after the explicit separator", () => {
    expect(
      parseCiStepArguments([
        "--id",
        "typecheck",
        "--output",
        "artifacts/ci/steps/typecheck.json",
        "--",
        "bun",
        "run",
        "typecheck",
      ]),
    ).toEqual({
      id: "typecheck",
      output: "artifacts/ci/steps/typecheck.json",
      command: ["bun", "run", "typecheck"],
    })
    expect(() =>
      parseCiStepArguments([
        "--id",
        "typecheck",
        "--output",
        "artifacts/ci/steps/typecheck.json",
        "bun",
        "run",
        "typecheck",
      ]),
    ).toThrow("separator")
    expect(() =>
      parseCiStepArguments([
        "--id",
        "NOT SAFE",
        "--output",
        "artifacts/ci/steps/typecheck.json",
        "--",
        "bun",
      ]),
    ).toThrow("--id")
  })

  test("streams output and writes a passing content-addressed receipt", async () => {
    const path = receiptPath("pass")
    const receipt = await runCiStep({
      id: "fixture-pass",
      output: path.relative,
      command: [
        process.execPath,
        "-e",
        "process.stdout.write('fixture-out');process.stderr.write('fixture-err')",
      ],
    })

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      artifactClass: "ci-step-receipt",
      id: "fixture-pass",
      status: "pass",
      exitCode: 0,
      workingDirectory: ".",
      spawnError: null,
    })
    expect(receipt.command.requestedExecutable).toBe(process.execPath)
    expect(receipt.command.executable).toBe(basename(await realpath(process.execPath)))
    expect(receipt.command.bytes).toBeGreaterThan(0)
    expect(receipt.command.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(receipt.stdout).toEqual({ bytes: 11, sha256: sha256("fixture-out") })
    expect(receipt.stderr).toEqual({ bytes: 11, sha256: sha256("fixture-err") })
    expect(JSON.parse(await readFile(path.absolute, "utf8"))).toEqual(receipt)
  })

  test("records a failing exit code and rejects receipt paths outside the project", async () => {
    const path = receiptPath("fail")
    const receipt = await runCiStep({
      id: "fixture-fail",
      output: path.relative,
      command: [process.execPath, "-e", "process.exit(7)"],
    })
    expect(receipt.status).toBe("fail")
    expect(receipt.exitCode).toBe(7)

    await expect(
      runCiStep({
        id: "fixture-fail-duplicate",
        output: path.relative,
        command: [process.execPath, "-e", "process.exit(0)"],
      }),
    ).rejects.toThrow("CI step receipt already exists")

    await expect(
      runCiStep({
        id: "escape",
        output: "../outside-receipt.json",
        command: [process.execPath, "-e", "process.exit(0)"],
      }),
    ).rejects.toThrow("inside the project")
  })

  test("rejects duplicate control flags", () => {
    expect(() =>
      parseCiStepArguments([
        "--id",
        "first",
        "--id",
        "second",
        "--output",
        "artifacts/ci/steps/first.json",
        "--",
        "bun",
      ]),
    ).toThrow("--id may be provided only once")
    expect(() =>
      parseCiStepArguments([
        "--id",
        "first",
        "--output",
        "artifacts/ci/steps/first.json",
        "--output",
        "artifacts/ci/steps/second.json",
        "--",
        "bun",
      ]),
    ).toThrow("--output may be provided only once")
  })
})
