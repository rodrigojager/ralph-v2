import { createHash, randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  type ReleaseManifest,
  ReleaseManifestSchema,
  type ReleasePayload,
  ReleaseSupportPolicySchema,
  type ReleaseTarget,
  ReleaseTargetSchema,
  type ReleaseTransport,
  releaseSupportPolicySha256,
  releaseTargetFor,
  releaseTargetInstallDurability,
} from "@ralph-next/distribution"

const LOCAL_CONTRACT_LIMITATION =
  "Local contract fixture only; this is not release, signer, license, or target-support evidence."
const FIXTURE_TIMESTAMP = "2026-07-19T00:00:00.000Z"

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function fixtureUrl(baseUrl: string | undefined, path: string): string | undefined {
  return baseUrl ? new URL(path, baseUrl).toString() : undefined
}

export interface ReleaseFixtureOptions {
  readonly version: string
  readonly target?: ReleaseTarget
  readonly remoteBaseUrl?: string
  readonly launcherText?: string
  readonly engineText?: string
  readonly engineMetadataVersion?: string
  readonly minimumWorkspaceSchema?: number
  readonly maximumWorkspaceSchema?: number
  readonly minimumLauncherSchema?: number
  readonly maximumLauncherSchema?: number
}

export interface ReleaseFixture {
  readonly directory: string
  readonly manifestPath: string
  readonly manifestUrl?: string
  readonly manifest: ReleaseManifest
  readonly target: ReleaseTarget
  readonly bytesByUrl: ReadonlyMap<string, Uint8Array>
  readonly launcherBytes: Uint8Array
  readonly engineBytes: Uint8Array
  readonly launcherPath: string
  readonly enginePath: string
}

export async function createReleaseFixture(
  directory: string,
  options: ReleaseFixtureOptions,
): Promise<ReleaseFixture> {
  const root = resolve(directory)
  await mkdir(root, { recursive: true })
  const target = options.target ?? releaseTargetFor()
  const remoteBaseUrl = options.remoteBaseUrl
    ? new URL(options.remoteBaseUrl).toString()
    : undefined
  const sourceFingerprintSha256 = sha256(bytes(`local-contract-source:${options.version}`))
  const extension = target.startsWith("bun-windows-") ? ".exe" : ""
  const launcherPath = `payloads/ralph-next-launcher${extension}`
  const enginePath = `payloads/ralph-next-engine${extension}`
  const bytesByUrl = new Map<string, Uint8Array>()

  const writePayload = async (
    path: string,
    value: Uint8Array,
    mediaType: string,
  ): Promise<ReleasePayload> => {
    const destination = resolve(root, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, value)
    const url = fixtureUrl(remoteBaseUrl, path)
    if (url) bytesByUrl.set(url, value)
    return {
      path,
      ...(url ? { url } : {}),
      sha256: sha256(value),
      sizeBytes: value.byteLength,
      mediaType,
    }
  }

  const launcherBytes = bytes(options.launcherText ?? `launcher:${options.version}`)
  const engineBytes = bytes(options.engineText ?? `engine:${options.version}`)
  const launcher = await writePayload(
    launcherPath,
    launcherBytes,
    "application/octet-stream",
  )
  const executable = await writePayload(enginePath, engineBytes, "application/octet-stream")

  const buildMetadata = await writePayload(
    "metadata/build-metadata.json",
    bytes(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          product: "ralph-next",
          target,
          status: "built-not-tested",
          version: options.engineMetadataVersion ?? options.version,
          bunVersion: "1.3.14-fixture",
          bunRevision: "local-contract-fixture",
          artifact: executable.path,
          sha256: executable.sha256,
          sourceSha256: sourceFingerprintSha256,
          builtAt: FIXTURE_TIMESTAMP,
        },
        null,
        2,
      )}\n`,
    ),
    "application/json",
  )
  const launcherBuildMetadata = await writePayload(
    "metadata/launcher-build-metadata.json",
    bytes(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          product: "ralph-next-launcher",
          target,
          status: "built-not-tested",
          version: options.version,
          bunVersion: "1.3.14-fixture",
          bunRevision: "local-contract-fixture",
          artifact: launcher.path,
          sha256: launcher.sha256,
          sourceSha256: sourceFingerprintSha256,
          builtAt: FIXTURE_TIMESTAMP,
        },
        null,
        2,
      )}\n`,
    ),
    "application/json",
  )
  const license = await writePayload(
    "support/LICENSE",
    bytes("TEST FIXTURE ONLY - NOT A PRODUCT LICENSE\n"),
    "text/plain",
  )
  const thirdPartyNotices = await writePayload(
    "support/THIRD_PARTY_NOTICES.md",
    bytes("# Local contract fixture\n\nNo release or license assertion is made.\n"),
    "text/markdown",
  )
  const applicationPurl = `pkg:npm/ralph-next@${encodeURIComponent(options.version)}`
  const sbom = await writePayload(
    "support/SBOM.cdx.json",
    bytes(
      `${JSON.stringify(
        {
          bomFormat: "CycloneDX",
          specVersion: "1.6",
          serialNumber: `urn:uuid:${randomUUID()}`,
          version: 1,
          metadata: {
            timestamp: FIXTURE_TIMESTAMP,
            component: {
              type: "application",
              "bom-ref": applicationPurl,
              name: "ralph-next",
              version: options.version,
              purl: applicationPurl,
              licenses: [{ expression: "NOASSERTION" }],
            },
            tools: {
              components: [
                {
                  type: "application",
                  "bom-ref": "local-contract-fixture@1",
                  name: "local-contract-fixture",
                  version: "1",
                  licenses: [{ expression: "NOASSERTION" }],
                },
              ],
            },
            properties: [
              {
                name: "ralph:source-fingerprint-sha256",
                value: sourceFingerprintSha256,
              },
            ],
          },
          components: [],
          dependencies: [{ ref: applicationPurl, dependsOn: [] }],
        },
        null,
        2,
      )}\n`,
    ),
    "application/vnd.cyclonedx+json",
  )
  const skill = await writePayload(
    "support/ralph-loop-prd-generator.tar",
    bytes(`local-contract-skill:${options.version}`),
    "application/x-tar",
  )
  const checksumSubjects = [
    launcher,
    launcherBuildMetadata,
    executable,
    buildMetadata,
    license,
    thirdPartyNotices,
    sbom,
    skill,
  ]
  const checksums = await writePayload(
    "support/SHA256SUMS",
    bytes(checksumSubjects.map((payload) => `${payload.sha256} *${payload.path}`).join("\n") + "\n"),
    "text/plain",
  )

  const supportPolicy = ReleaseSupportPolicySchema.parse({
    schemaVersion: 1,
    product: "ralph-next",
    version: options.version,
    channel: "nightly",
    matrix: ReleaseTargetSchema.options.map((candidate) => ({
      target: candidate,
      status: candidate === target ? "included" : "not-promoted",
      capabilities: {
        installControlStateDurability: releaseTargetInstallDurability(candidate),
      },
      ...(candidate === target
        ? { limitations: [LOCAL_CONTRACT_LIMITATION] }
        : { reason: "Not selected by this local contract fixture." }),
    })),
  })
  const manifest = ReleaseManifestSchema.parse({
    schemaVersion: 2,
    product: "ralph-next",
    version: options.version,
    channel: "nightly",
    publishedAt: FIXTURE_TIMESTAMP,
    source: {
      repository: "https://example.invalid/ralph-v2",
      commit: "a".repeat(40),
      fingerprintSha256: sourceFingerprintSha256,
    },
    compatibility: {
      minimumWorkspaceSchema: options.minimumWorkspaceSchema ?? 1,
      maximumWorkspaceSchema: options.maximumWorkspaceSchema ?? 1,
      minimumLauncherSchema: options.minimumLauncherSchema ?? 1,
      maximumLauncherSchema: options.maximumLauncherSchema ?? 1,
    },
    supportPolicy,
    supportPolicySha256: releaseSupportPolicySha256(supportPolicy),
    artifacts: [
      {
        target,
        evidenceStatus: "built-not-tested",
        launcher,
        launcherBuildMetadata,
        executable,
        buildMetadata,
        limitations: [LOCAL_CONTRACT_LIMITATION],
      },
    ],
    license,
    thirdPartyNotices,
    sbom,
    skill,
    checksums,
    signature: {
      status: "unavailable",
      reason: "Unsigned local contract fixture; no authenticity claim is made.",
    },
  })
  const manifestBytes = bytes(`${JSON.stringify(manifest, null, 2)}\n`)
  const manifestPath = resolve(root, "release-manifest.json")
  await writeFile(manifestPath, manifestBytes)
  const manifestUrl = fixtureUrl(remoteBaseUrl, "release-manifest.json")
  if (manifestUrl) bytesByUrl.set(manifestUrl, manifestBytes)
  return {
    directory: root,
    manifestPath,
    ...(manifestUrl ? { manifestUrl } : {}),
    manifest,
    target,
    bytesByUrl,
    launcherBytes,
    engineBytes,
    launcherPath: resolve(root, launcherPath),
    enginePath: resolve(root, enginePath),
  }
}

export class AllowlistedFixtureTransport implements ReleaseTransport {
  readonly requests: string[] = []

  constructor(
    private readonly allowedHostname: string,
    private readonly payloads: ReadonlyMap<string, Uint8Array>,
  ) {}

  async fetch(request: Parameters<ReleaseTransport["fetch"]>[0]): Promise<Uint8Array> {
    if (request.url.protocol !== "https:" || request.url.hostname !== this.allowedHostname) {
      throw new Error(`Fixture transport refused non-allowlisted URL: ${request.url.toString()}`)
    }
    this.requests.push(request.url.toString())
    const payload = this.payloads.get(request.url.toString())
    if (!payload) throw new Error(`Fixture transport has no payload: ${request.url.toString()}`)
    if (payload.byteLength > request.maximumBytes) {
      throw new Error(`Fixture payload exceeds maximumBytes: ${request.url.toString()}`)
    }
    return payload.slice()
  }
}
