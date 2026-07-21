import { runWorkerEntrypointFromEnvironment } from "@ralph/supervisor"
import { redactText, secretValuesFromEnvironment } from "@ralph/telemetry"
import { createBuiltinRalphWorkerRoleAdapter } from "./worker-adapters"

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return redactText(
    message || "Ralph worker startup failed",
    secretValuesFromEnvironment(process.env),
  ).slice(0, 4_096)
}

export async function runWorkerMain(): Promise<number> {
  try {
    await runWorkerEntrypointFromEnvironment({
      builtinFactory: createBuiltinRalphWorkerRoleAdapter,
    })
    return 0
  } catch (error) {
    process.stderr.write(`RALPH_WORKER_STARTUP_FAILED: ${boundedError(error)}\n`)
    process.disconnect?.()
    return 1
  }
}
