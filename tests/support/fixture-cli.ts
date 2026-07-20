#!/usr/bin/env bun

import { readFileSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { runCli } from "@ralph-next/commands"
import type { ExecutionBackendResolver } from "@ralph-next/orchestration"
import { type ScriptedExecution, ScriptedExecutionBackend } from "@ralph-next/test-kit"
import packageJson from "../../package.json" with { type: "json" }

function scriptedExecutions(environment: NodeJS.ProcessEnv): ScriptedExecution[] {
  const configured = environment.RALPH_TEST_BACKEND_SCRIPT
  if (!configured) {
    throw new Error("RALPH_TEST_BACKEND_SCRIPT is required by the test-only fixture CLI")
  }
  const path = isAbsolute(configured) ? configured : resolve(process.cwd(), configured)
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!Array.isArray(parsed)) {
    throw new Error("RALPH_TEST_BACKEND_SCRIPT must contain a JSON array")
  }
  return parsed as ScriptedExecution[]
}

const backend = new ScriptedExecutionBackend(scriptedExecutions(process.env))
const resolveBackend: ExecutionBackendResolver = (profile) =>
  profile === "fixture-executor" ? backend : undefined

const exitCode = await runCli(process.argv.slice(2), {
  version: `${packageJson.version}-fixture`,
  cwd: process.cwd(),
  environment: process.env,
  resolveBackend,
})

process.exitCode = exitCode
