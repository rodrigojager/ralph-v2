import { afterEach, describe, expect, test } from "bun:test"
import { link, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { releaseManifestSigningSha256 } from "@ralph-next/distribution"
import { createReleaseFixture } from "../../packages/distribution/tests/release-fixture"
import {
  effectiveReleaseCandidateDigest,
  readReleaseCandidateInput,
  readStableJsonInput,
} from "../../scripts/release-candidate-input"

const temporaryRoots: string[] = []

async function releaseFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "ralph-release-candidate-input-"))
  temporaryRoots.push(root)
  return createReleaseFixture(root, { version: "0.1.0-dev.1" })
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  )
})

describe("release candidate input", () => {
  test("binds manifest metadata and every declared payload into the effective digest", async () => {
    const fixture = await releaseFixture()
    const input = await readReleaseCandidateInput(fixture.manifestPath)

    expect(input.kind).toBe("release-manifest")
    if (input.kind !== "release-manifest") throw new Error("Expected a release manifest fixture")
    expect(input.payloads.length).toBeGreaterThan(5)
    expect(input.payloads.every((payload) => payload.verification === "declared-size-and-hash")).toBe(
      true,
    )
    expect(effectiveReleaseCandidateDigest(input)).toMatch(/^sha256:[a-f0-9]{64}$/u)

    const changedAddress = effectiveReleaseCandidateDigest({
      ...input,
      payloadContentAddress: "0".repeat(64),
    })
    expect(changedAddress).not.toBe(effectiveReleaseCandidateDigest(input))
  })

  test("content-addresses a detached signature without claiming cryptographic verification", async () => {
    const fixture = await releaseFixture()
    const signaturePath = resolve(fixture.directory, "signature.bin")
    await writeFile(signaturePath, "detached-signature-fixture")
    const manifest = structuredClone(fixture.manifest)
    const descriptor = {
      status: "present",
      kind: "minisign",
      identity: "fixture-release-signer",
      signedManifestSha256: "0".repeat(64),
      payload: {
        path: "signature.bin",
        maximumSizeBytes: 1024,
        mediaType: "application/octet-stream",
      },
    } as const
    manifest.signature = descriptor
    manifest.signature = {
      ...descriptor,
      signedManifestSha256: releaseManifestSigningSha256(manifest),
    }
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const input = await readReleaseCandidateInput(fixture.manifestPath)
    expect(input.kind).toBe("release-manifest")
    expect(input.payloads.find((payload) => payload.path === "signature.bin")?.verification).toBe(
      "observed-bounded-only",
    )
  })

  test("rejects a detached-signature descriptor that does not bind the canonical manifest", async () => {
    const fixture = await releaseFixture()
    await writeFile(resolve(fixture.directory, "signature.bin"), "invalid-signature-fixture")
    const manifest = structuredClone(fixture.manifest)
    manifest.signature = {
      status: "present",
      kind: "minisign",
      identity: "fixture-release-signer",
      signedManifestSha256: "0".repeat(64),
      payload: {
        path: "signature.bin",
        maximumSizeBytes: 1024,
        mediaType: "application/octet-stream",
      },
    }
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    await expect(readReleaseCandidateInput(fixture.manifestPath)).rejects.toThrow(
      "Release manifest signature descriptor does not bind its canonical projection",
    )
  })

  test("rejects a differently named payload hard-linked to its own metadata", async () => {
    const fixture = await releaseFixture()
    const manifest = structuredClone(fixture.manifest)
    manifest.license = {
      ...manifest.license,
      path: "manifest-alias.json",
      sha256: "0".repeat(64),
      sizeBytes: 1,
    }
    let serialized = ""
    for (let attempt = 0; attempt < 8; attempt += 1) {
      serialized = `${JSON.stringify(manifest)}\n`
      const sizeBytes = Buffer.byteLength(serialized)
      if (manifest.license.sizeBytes === sizeBytes) break
      manifest.license.sizeBytes = sizeBytes
    }
    expect(manifest.license.sizeBytes).toBe(Buffer.byteLength(serialized))
    await writeFile(fixture.manifestPath, serialized)
    await link(fixture.manifestPath, resolve(fixture.directory, manifest.license.path))

    await expect(readReleaseCandidateInput(fixture.manifestPath)).rejects.toThrow(
      "Candidate payload cannot alias its own metadata file",
    )
  })

  test("honors cancellation and does not expose a missing host path in filesystem errors", async () => {
    const fixture = await releaseFixture()
    const controller = new AbortController()
    controller.abort()
    await expect(readReleaseCandidateInput(fixture.manifestPath, controller.signal)).rejects.toThrow(
      "Candidate verification was cancelled",
    )

    const missing = resolve(fixture.directory, "private-host-segment", "missing.json")
    try {
      await readStableJsonInput(missing, "Candidate fixture")
      throw new Error("Expected the missing candidate read to fail")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain("Candidate fixture must be a bounded regular file")
      expect(message).not.toContain(fixture.directory)
      expect(message).not.toContain("private-host-segment")
    }
  })
})
