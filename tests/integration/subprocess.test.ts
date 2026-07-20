import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import {
  isolatedChildEnvironment,
  runCapturedProcess,
  SUBPROCESS_SECRET_CANARY,
} from "../../scripts/subprocess"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

test("child environments are isolated from host credentials", async () => {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  const environment = await isolatedChildEnvironment(join(root, "environment"))
  expect(environment.AWS_ACCESS_KEY_ID).toBeUndefined()
  expect(environment.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  expect(environment.CODEX_POOLER_API_KEY).toBeUndefined()
  expect(environment.RALPH_API_KEY).toBe(SUBPROCESS_SECRET_CANARY)
  expect(environment.RALPH_CONFIG_HOME).toStartWith(root)
})

test("captured subprocesses are terminated after their deadline", async () => {
  const root = await createTestDirectory()
  temporaryDirectories.push(root)
  const environment = await isolatedChildEnvironment(join(root, "environment"))
  const result = await runCapturedProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    cwd: root,
    environment,
    timeoutMs: 100,
  })
  expect(result.timedOut).toBeTrue()
})
