import { appendFileSync } from "node:fs"

const diagnosticPath = process.env.RALPH_PTY_DIAGNOSTIC_FILE

function printable(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function markPtyChildStage(stage: string, detail?: unknown): void {
  if (!diagnosticPath) return
  const suffix = detail === undefined ? "" : ` | ${printable(detail).replaceAll("\n", "\\n")}`
  appendFileSync(diagnosticPath, `${new Date().toISOString()} | ${stage}${suffix}\n`, "utf8")
}

export function installPtyChildDiagnostics(): void {
  markPtyChildStage("process.started")
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    markPtyChildStage(`process.uncaught-exception.${origin}`, error)
  })
  process.on("unhandledRejection", (reason) => {
    // Preserve the normal failing exit while recording a rejection that would
    // otherwise be hidden by the alternate-screen teardown.
    process.exitCode = 1
    markPtyChildStage("process.unhandled-rejection", reason)
  })
  process.on("exit", (code) => {
    markPtyChildStage(`process.exit.${code}`)
  })
}

export async function writePtyChildOutput(output: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      process.stdout.off("error", onError)
      reject(error)
    }
    process.stdout.once("error", onError)
    process.stdout.write(output, (error) => {
      process.stdout.off("error", onError)
      if (error) reject(error)
      else resolve()
    })
  })
}
