import { setTimeout as delay } from "node:timers/promises"
import {
  installPtyChildDiagnostics,
  markPtyChildStage,
  writePtyChildOutput,
} from "./child-diagnostics"

installPtyChildDiagnostics()

const tty = `T${Number(process.stdin.isTTY === true)}${Number(process.stdout.isTTY === true)}${Number(process.stderr.isTTY === true)}`
await writePtyChildOutput(
  `\nRALPH_POSIX_PTY_READY:${JSON.stringify({
    tty,
    columns: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
  })}\n`,
)
markPtyChildStage("posix-resize.ready")

const timeout = setTimeout(() => {
  markPtyChildStage("posix-resize.timeout")
  process.exitCode = 1
  process.kill(process.pid, "SIGTERM")
}, 10_000)

process.once("SIGWINCH", async () => {
  await delay(10)
  clearTimeout(timeout)
  await writePtyChildOutput(
    `\nRALPH_POSIX_PTY_RESIZE:${JSON.stringify({
      tty,
      columns: process.stdout.columns ?? null,
      rows: process.stdout.rows ?? null,
    })}\n`,
  )
  markPtyChildStage("posix-resize.complete")
})
