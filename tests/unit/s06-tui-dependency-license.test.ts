import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")

describe("S06 TUI dependency and license gate", () => {
  test("pins the public OpenTUI/Solid stack exactly in the package and lockfile", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(ROOT, "packages/tui/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> }
    expect(manifest.dependencies).toEqual({
      "@opentui/core": "0.4.5",
      "@opentui/solid": "0.4.5",
      "solid-js": "1.9.12",
    })
    const lock = await readFile(resolve(ROOT, "bun.lock"), "utf8")
    expect(lock).toContain('"@opentui/core": "0.4.5"')
    expect(lock).toContain('"@opentui/solid": "0.4.5"')
    expect(lock).toContain('"solid-js": "1.9.12"')
  })

  test("ships exact MIT notices without claiming an OpenCode TUI transplant", async () => {
    const [notice, opentui, solid] = await Promise.all([
      readFile(resolve(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8"),
      readFile(resolve(ROOT, "third_party/opentui/LICENSE"), "utf8"),
      readFile(resolve(ROOT, "third_party/solid-js/LICENSE"), "utf8"),
    ])
    expect(notice).toContain("## OpenTUI")
    expect(notice).toContain("## SolidJS")
    expect(notice).toContain("No OpenCode TUI component, branding or source file is copied")
    expect(opentui).toStartWith("MIT License\n\nCopyright (c) 2025 opentui")
    expect(solid).toStartWith("MIT License\n\nCopyright (c) 2016-2025 Ryan Carniato")
  })
})
