import { resolve } from "node:path"
import { createCheckPlan } from "./check-plan"

const projectRoot = resolve(import.meta.dir, "..")

for (const step of createCheckPlan()) {
  console.log(`\n> ${step.command.join(" ")}`)
  const processHandle = Bun.spawn([...step.command], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
    windowsHide: true,
  })
  const exitCode = await processHandle.exited
  if (exitCode !== 0) process.exit(exitCode)
}
