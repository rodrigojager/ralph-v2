import { describe, expect, test } from "bun:test"
import { parseMarkdownFragment, parsePrdSource, parseVerification } from "@ralph/prd"

describe("S06 PRD gate declarations", () => {
  test("parses human-readable schema, git and hashed artifact declarations", () => {
    const hash = "a".repeat(64)
    expect(
      parseVerification(
        parseMarkdownFragment("schema: product.json; schema=schemas/product.schema.json"),
        "slice",
        1,
      ),
    ).toMatchObject({
      type: "schema",
      path: "product.json",
      schema: "schemas/product.schema.json",
      category: "schema",
    })
    expect(parseVerification(parseMarkdownFragment("git: no-conflicts"), "slice", 2)).toMatchObject(
      { type: "git", expectation: { kind: "no-conflicts" }, category: "git" },
    )
    expect(
      parseVerification(
        parseMarkdownFragment(`artifact: proof; path=proof.json; sha256=${hash}`),
        "slice",
        3,
      ),
    ).toMatchObject({ type: "artifact", expectedSha256: hash })
  })

  test("parses advanced deterministic metadata through a structured gate declaration", () => {
    const declaration = {
      type: "plugin",
      plugin: "acme/contract-audit",
      input: { strict: true },
      category: "plugin",
      skipPolicy: "allowed-to-skip",
      blocking: true,
      attempts: 3,
      timeoutMs: 5000,
      applicability: {
        platforms: ["linux", "win32"],
        conditions: [{ kind: "path-changed", path: "src", match: "prefix" }],
      },
      criterionIds: ["c1"],
    }
    const parsed = parseVerification(
      parseMarkdownFragment(`gate: ${JSON.stringify(declaration)}`),
      "slice",
      4,
    )

    expect(parsed).toMatchObject({
      id: "slice:verification:4",
      plugin: "acme/contract-audit",
      attempts: 3,
      timeoutMs: 5000,
      applicability: declaration.applicability,
      criterionIds: ["c1"],
    })
  })

  test("rejects a criterion link that does not exist in the containing task", () => {
    const declaration = JSON.stringify({
      type: "file",
      path: "proof.json",
      expectation: { kind: "exists" },
      category: "file",
      skipPolicy: "required",
      blocking: true,
      criterionIds: ["c2"],
    })
    const source = `---
ralph_prd: 2
id: criterion-links
title: Criterion links
kind: root
workspace: .
defaults:
  evidence_mode: criteria
---

# Criterion links

## Vertical slices

- [ ] **linked-slice — Link evidence**
  - Resultado: Evidence is linked.
  - Dependências: nenhuma
  - Critérios:
    1. The declared proof exists.
  - Verificação:
    - gate: ${declaration}
  - Limites:
    - Do not add unrelated files.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
`
    const parsed = parsePrdSource(source, { file: "PRD.md" })

    expect(parsed.ok).toBeFalse()
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "RALPH_PRD_VERIFICATION_CRITERION_UNKNOWN",
    )
  })

  test("rejects artifact evidence mode backed only by an unnamed file gate", () => {
    const source = `---
ralph_prd: 2
id: named-artifact
title: Named artifact
kind: root
workspace: .
defaults:
  evidence_mode: artifact
---

# Named artifact

## Vertical slices

- [ ] **artifact-slice — Materialize evidence**
  - Resultado: Evidence is materialized.
  - Dependências: nenhuma
  - Critérios:
    1. The proof exists.
  - Verificação:
    - file: proof.json; exists
  - Limites:
    - Do not add unrelated files.
  - Modo de evidência: artifact
  - Sub-PRD: nenhum
`
    const parsed = parsePrdSource(source, { file: "PRD.md" })

    expect(parsed.ok).toBeFalse()
    expect(parsed.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "RALPH_PRD_ARTIFACT_VERIFICATION_REQUIRED",
    )
  })
})
