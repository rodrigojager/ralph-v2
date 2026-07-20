import { afterEach, describe, expect, test } from "bun:test"
import { open, readdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { writeFileAtomic } from "@ralph-next/persistence"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTestDirectory))
})

describe("recoverable atomic file replacement", () => {
  test("replaces an existing file without leaving staging or displaced siblings", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    const target = resolve(root, "state.md")
    await writeFile(target, "before", "utf8")

    await writeFileAtomic(target, "after", { overwrite: true })

    expect(await readFile(target, "utf8")).toBe("after")
    expect(await readdir(root)).toEqual(["state.md"])
  })

  test("replaces after a pre-commit read without reopening away the Windows backoff", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    const target = resolve(root, "state.md")
    await writeFile(target, "before", "utf8")
    let checks = 0

    await writeFileAtomic(target, "after", {
      overwrite: true,
      beforeCommit: async () => {
        checks += 1
        expect(await readFile(target, "utf8")).toBe("before")
      },
    })

    expect(checks).toBeGreaterThanOrEqual(1)
    expect(await readFile(target, "utf8")).toBe("after")
    expect(await readdir(root)).toEqual(["state.md"])
  })

  test("atomically replaces a target while an existing reader retains the old contents", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    const target = resolve(root, "estado-ação-你好.md")
    await writeFile(target, "before", "utf8")
    const reader = await open(target, "r")

    try {
      await writeFileAtomic(target, "after", { overwrite: true })

      expect(await readFile(target, "utf8")).toBe("after")
      expect(await reader.readFile({ encoding: "utf8" })).toBe("before")
      expect(await readdir(root)).toEqual(["estado-ação-你好.md"])
    } finally {
      await reader.close()
    }
  })

  test("preserves the original file when a pre-commit condition fails", async () => {
    const root = await createTestDirectory()
    temporaryDirectories.push(root)
    const target = resolve(root, "state.md")
    await writeFile(target, "before", "utf8")

    await expect(
      writeFileAtomic(target, "after", {
        overwrite: true,
        beforeCommit: async () => {
          throw new Error("stale precondition")
        },
      }),
    ).rejects.toThrow("stale precondition")

    expect(await readFile(target, "utf8")).toBe("before")
    expect(await readdir(root)).toEqual(["state.md"])
  })
})
