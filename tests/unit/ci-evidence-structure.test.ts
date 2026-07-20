import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const projectRoot = resolve(import.meta.dir, "../..")

describe("CI evidence structure", () => {
  test("binds the six native runner labels and the exact workflow into every evidence receipt", async () => {
    const workflow = await readFile(resolve(projectRoot, ".github/workflows/ci.yml"), "utf8")
    const capture = await readFile(resolve(projectRoot, "scripts/ci/capture-evidence.ts"), "utf8")

    const nativeRunnerLabels = [...workflow.matchAll(/^\s+runner:\s+([^\s]+)$/gmu)].map(
      (match) => match[1],
    )
    expect(nativeRunnerLabels).toEqual([
      "windows-2025",
      "windows-11-arm",
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
      "macos-15-intel",
      "macos-15",
    ])
    expect(workflow.match(/--input \.github\/workflows\/ci\.yml/gu)).toHaveLength(3)
    expect(workflow).toContain("--runner-label ${{ matrix.os }}")
    expect(workflow).toContain("--runner-label ${{ matrix.runner }}")
    expect(workflow).toContain("--runner-label ubuntu-24.04")
    expect(workflow).not.toContain("continue-on-error")

    expect(capture).toContain('issues.push("--runner-label is required')
    expect(capture).toContain("requestedLabel: options.runnerLabel ?? null")
    expect(capture).toContain("imageOs: process.env.ImageOS ?? null")
    expect(capture).toContain("imageVersion: process.env.ImageVersion ?? null")
  })

  test("binds every S11.10 compliance authority into the security evidence receipt", async () => {
    const workflow = await readFile(resolve(projectRoot, ".github/workflows/ci.yml"), "utf8")
    const securityJob = workflow.replaceAll("\r\n", "\n").split("\n  security-gates:\n")[1]
    expect(securityJob).toBeDefined()

    for (const path of [
      "package.json",
      "bun.lock",
      "THIRD_PARTY_NOTICES.md",
      "third_party",
      "scripts/ci/dependency-audit.ts",
      "scripts/ci/install-gitleaks.sh",
      "scripts/opencode-provenance.ts",
      "scripts/release-licenses.ts",
      "scripts/release-sbom.ts",
      "tests/unit/s04-dependency-license.test.ts",
      "tests/unit/s06-tui-dependency-license.test.ts",
      "tests/unit/opencode-provenance.test.ts",
      "tests/unit/release-sbom-license-inventory.test.ts",
    ]) {
      expect(securityJob).toContain(`--input ${path}`)
    }
    expect(securityJob).toContain("./artifacts/ci/tooling/bin/gitleaks git .")
    expect(securityJob).not.toContain("gitleaks dir .")
  })

  test("publishes the generated v2 schema tree through a pinned Pages workflow", async () => {
    const workflow = await readFile(
      resolve(projectRoot, ".github/workflows/schema-pages.yml"),
      "utf8",
    )
    expect(workflow).toContain("branches:\n      - main")
    expect(workflow).toContain("mkdir -p _site/schemas/v2")
    expect(workflow).toContain("cp schemas/*.schema.json _site/schemas/v2/")
    expect(workflow).toContain("actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d")
    expect(workflow).toContain(
      "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9",
    )
    expect(workflow).toContain("actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128")
    expect(workflow).not.toMatch(/uses:\s+[^\s@]+@(v|main|master)(?:\d|\b)/u)
  })
})
