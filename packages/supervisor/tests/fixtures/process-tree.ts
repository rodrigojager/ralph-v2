import { access } from "node:fs/promises"
import { join } from "node:path"

const [mode, stateDirectory] = process.argv.slice(2)
if (!mode || !stateDirectory) throw new Error("Expected a process-tree mode and state directory")

async function record(role: string): Promise<void> {
  await Bun.write(join(stateDirectory as string, `${role}.pid`), `${process.pid}\n`)
}

async function waitForGrandchild(): Promise<void> {
  const path = join(stateDirectory as string, "grandchild.pid")
  while (true) {
    try {
      await access(path)
      return
    } catch {
      await Bun.sleep(10)
    }
  }
}

const fixturePath = import.meta.path

switch (mode) {
  case "parent-exit":
  case "parent-hold": {
    await record("parent")
    const child = Bun.spawn([process.execPath, fixturePath, "child", stateDirectory], {
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      detached: false,
      windowsHide: true,
    })
    child.unref()
    await waitForGrandchild()
    if (mode === "parent-hold") setInterval(() => undefined, 1_000)
    break
  }
  case "child": {
    await record("child")
    const grandchild = Bun.spawn([process.execPath, fixturePath, "grandchild", stateDirectory], {
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      // Bun cleans up a still-attached Windows child when this fixture process
      // exits. Detaching creates the orphan shape this regression test needs;
      // Windows Job membership is inherited even by a detached console child.
      // POSIX must remain in the parent's process group.
      detached: process.platform === "win32",
      windowsHide: true,
    })
    grandchild.unref()
    await waitForGrandchild()
    break
  }
  case "grandchild":
    await record("grandchild")
    process.stdout.write("grandchild-ready\n")
    setInterval(() => undefined, 1_000)
    break
  default:
    throw new Error(`Unsupported process-tree mode: ${mode}`)
}
