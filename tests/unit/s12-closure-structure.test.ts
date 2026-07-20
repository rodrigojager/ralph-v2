import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createCheckPlan } from "../../scripts/check-plan"
import { gitleaksTrackedSourceScanArguments } from "../../scripts/gitleaks-binding"
import { redactClosureText } from "../../scripts/s12-closure"

const closureSourcePath = resolve(import.meta.dir, "../../scripts/s12-closure.ts")

describe("S11/S12 closure structure", () => {
  test("keeps the legacy check plan equivalent and invokes one global Bun test", () => {
    const base = createCheckPlan()
    const closure = createCheckPlan({
      includeDocumentation: true,
      docsOutput: "artifacts/docs.json",
      junitOutput: "artifacts/global.xml",
    })

    expect(base.map((step) => step.id)).toEqual([
      "schemas",
      "lint",
      "typecheck",
      "tests",
      "build",
      "smoke",
    ])
    expect(closure.map((step) => step.id)).toEqual([
      "documentation",
      "schemas",
      "lint",
      "typecheck",
      "tests",
      "build",
      "smoke",
    ])
    expect(closure.filter((step) => step.command[1] === "test")).toHaveLength(1)
  })

  test("redacts environment values, structured JSON, bearer headers and URL secrets", () => {
    const source = [
      '"apiKey":"json-secret"',
      "Authorization: Bearer bearer-secret",
      "https://example.test/?token=query-secret",
      "https://username:password@example.test/private?harmless=value#fragment",
      "argument=environment-secret",
    ].join("\n")

    const redacted = redactClosureText(source, ["environment-secret"])

    expect(redacted).not.toContain("json-secret")
    expect(redacted).not.toContain("bearer-secret")
    expect(redacted).not.toContain("query-secret")
    expect(redacted).not.toContain("username:password")
    expect(redacted).not.toContain("harmless=value")
    expect(redacted).not.toContain("#fragment")
    expect(redacted).not.toContain("environment-secret")
    expect(redacted).toContain("<REDACTED>")
    expect(redacted).toContain("[REDACTED]")
  })

  test("scans only tracked Git source and history with a redacted bounded report", () => {
    expect(gitleaksTrackedSourceScanArguments("evidence/gitleaks.json")).toEqual([
      "git",
      ".",
      "--no-banner",
      "--no-color",
      "--redact=100",
      "--timeout",
      "120",
      "--report-format",
      "json",
      "--report-path",
      "evidence/gitleaks.json",
    ])
  })

  test("delegates process trees and derives source binding fail-closed", async () => {
    const source = await readFile(closureSourcePath, "utf8")

    expect(source).toContain("new BunProcessSupervisor()")
    expect(source).toContain("new TwoPhaseShutdownController")
    expect(source).not.toContain("Bun.spawn(")
    expect(source).not.toContain("taskkill.exe")
    expect(source).not.toContain('const sourceBound = false')
    expect(source).toContain('observeGitSource(evidenceRoot, "before")')
    expect(source).toContain('observeGitSource(evidenceRoot, "after")')
    expect(source).toContain("finalGitObservation({")
    expect(source).toContain("Git source identity or cleanliness changed before closure completion")
    expect(source).toContain("sameCandidateInput(candidateInput, recheckedCandidate)")
    expect(source).toContain("Release candidate metadata or payloads changed before closure completion")
    expect(source).toContain("finalObservation: finalCandidateObservation")
    expect(source).toContain("candidateRepositoryMatches")
    expect(source).toContain("candidateCommitMatches")
    expect(source).toContain("candidateFingerprintMatches")
    expect(source).toContain("effectiveCandidateDigest")
    expect(source).toContain("ExternalWaiverArtifactSchema")
    expect(source).toContain('sourceRegistryCanApproveWaivers: false')
    expect(source).toContain('"--waiver-artifact"')
    expect(source).toContain('"--waiver-digest"')
    expect(source).toContain("effectiveOnlyWithValidEvidenceManifestAndChecksums: true")
    expect(source).toContain('nonWaivableBlockers: z.tuple([z.literal("BLK-SOURCE-BINDING")])')
    expect(source).toContain('resolve(evidenceRoot, "candidate-binding.json")')
    expect(source).toContain('rawMetadataArchived: false')
    expect(source).toContain("containsLiteralOrXmlEncodedSecret")
    expect(source).toContain("decodeXmlCharacterReferences")
    expect(source).toContain("REMOTE_CONFIGURATION_PRESENT; URL_REDACTED")
    expect(source).toContain('artifactClass: "s11-s12-closure-completion"')
    expect(source).toContain("ClosureCompletionReceiptSchema.parse({")
    expect(source).toContain("ClosureCompletionReceiptSchema.parse(recheckedCompletionInput.raw)")
    expect(source).toContain('status: "pending-envelope"')
    expect(source).toContain('status: "pending-completion-receipt"')
    expect(source).toContain('resolve(evidenceRoot, "closure-complete.json")')
    expect(source).toContain('"BLK-R015-REVIEW", r015.resolved')
    expect(source).toContain("requiredGlobalSentinels")
    expect(source).toContain("global.raw.xml")
    expect(source).toContain("gitleaksTrackedSourceScanArguments(gitleaksReportPath)")
    expect(source).not.toContain('gitleaksBinding.binary,\n          "dir"')
  })
})
