import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

function storeError(code, message) {
  return Object.assign(new Error(message), { code })
}

export async function readNotes(path) {
  let source
  try {
    source = await readFile(path, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw storeError("STORE_READ_FAILED", "The note store could not be read")
  }
  try {
    const value = JSON.parse(source)
    if (!Array.isArray(value) || value.some((item) => typeof item?.text !== "string")) {
      throw new Error("invalid shape")
    }
    return value
  } catch {
    throw storeError("STORE_INVALID", "The note store is invalid and was preserved")
  }
}

export async function createNote(path, input) {
  const text = typeof input === "string" ? input.trim() : ""
  if (text.length < 1 || text.length > 280) {
    throw storeError("NOTE_INVALID", "A note must contain between 1 and 280 characters")
  }
  const notes = await readNotes(path)
  const note = { id: randomUUID(), text, createdAt: new Date().toISOString() }
  const next = [...notes, note]
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw storeError("STORE_WRITE_FAILED", `The note store was not replaced: ${error?.code || "error"}`)
  }
  return note
}
