import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parsePrdFile, updateTaskMarker } from "@ralph-next/prd"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

function propertyDocument(options: {
  newline: "\n" | "\r\n"
  bom: boolean
  context: string
  ordinal: number
}): Uint8Array {
  const lines = [
    "---",
    "ralph_prd: 2",
    `id: property-${options.ordinal}`,
    `title: Propriedade ${options.ordinal}`,
    "kind: root",
    "workspace: .",
    "defaults:",
    "  evidence_mode: change-only",
    "---",
    "",
    `# Contexto ${options.context}`,
    "",
    "## Vertical slices",
    "",
    `- [ ] **slice-${options.ordinal} — Preservar ${options.context}**`,
    `  - Resultado: o usuário observa ${options.context} sem corrupção.`,
    "  - Dependências: nenhuma",
    "  - Limites:",
    "    - Não alterar bytes fora do marker.",
    "  - Modo de evidência: change-only",
    "  - Sub-PRD: nenhum",
    "",
  ]
  const source = lines.join(options.newline)
  return Buffer.from(`${options.bom ? "\uFEFF" : ""}${source}`, "utf8")
}

describe("PRD marker source-map properties", () => {
  test("preserves every non-marker byte across deterministic Unicode/newline/BOM cases", async () => {
    const root = await createTestDirectory()
    const contexts = ["ação", "café ☕", "usuário 🧪", "日本語 e português", "emoji 👩🏽‍💻"]
    try {
      let ordinal = 0
      for (const newline of ["\n", "\r\n"] as const) {
        for (const bom of [false, true]) {
          for (const context of contexts) {
            ordinal += 1
            const taskId = `slice-${ordinal}`
            const path = resolve(root, `plano ${ordinal} ç.md`)
            const before = Buffer.from(propertyDocument({ newline, bom, context, ordinal }))
            await writeFile(path, before)

            const parsed = await parsePrdFile(path, { file: `plano ${ordinal} ç.md` })
            expect(parsed.ok).toBe(true)
            const document = parsed.document
            const marker = document?.sourceMap[taskId]?.marker
            expect(marker).toBeDefined()
            expect(before.subarray(marker?.offset, (marker?.offset ?? 0) + 3).toString()).toBe(
              "[ ]",
            )

            const update = await updateTaskMarker(path, {
              file: `plano ${ordinal} ç.md`,
              taskId,
              status: "active",
              expectedStatus: "pending",
              expectedContentHash: document?.contentHash ?? "",
            })
            expect(update.changed).toBe(true)

            const after = await readFile(path)
            const center = (marker?.offset ?? 0) + 1
            expect(after.length).toBe(before.length)
            expect(after.subarray(0, center).equals(before.subarray(0, center))).toBe(true)
            expect(after[center]).toBe("~".charCodeAt(0))
            expect(after.subarray(center + 1).equals(before.subarray(center + 1))).toBe(true)
          }
        }
      }
      expect(ordinal).toBe(20)
    } finally {
      await removeTestDirectory(root)
    }
  })
})
