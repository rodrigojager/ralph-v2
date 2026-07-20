import { mkdir, open, rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

export async function writePrivateFileAtomic(target: string, content: string): Promise<void> {
  const directory = dirname(target)
  await mkdir(directory, { recursive: true })
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  )
  let committed = false

  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(content, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      await rename(temporary, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        process.platform !== "win32" ||
        !["EACCES", "EEXIST", "ENOTEMPTY", "EPERM"].includes(code ?? "")
      ) {
        throw error
      }

      const displaced = join(
        directory,
        `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.replaced`,
      )
      await rename(target, displaced)
      try {
        await rename(temporary, target)
      } catch (replacementError) {
        await rename(displaced, target).catch(() => undefined)
        throw replacementError
      }
      await rm(displaced, { force: true })
    }
    committed = true
  } finally {
    if (!committed) await rm(temporary, { force: true })
  }

  try {
    const directoryHandle = await open(directory, "r")
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch {
    // Directory fsync is unavailable on some supported Windows/filesystem combinations.
  }
}
