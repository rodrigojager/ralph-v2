import { createHash } from "node:crypto"
import { z } from "zod"

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

function containsC0C1OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true
    }
  }
  return false
}

function containsC0OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

export const ReleaseChannelSchema = z.enum(["dev", "nightly", "beta", "stable"])
export type ReleaseChannel = z.infer<typeof ReleaseChannelSchema>

export const ReleaseDistTagSchema = z.enum(["dev", "nightly", "beta", "latest"])
export type ReleaseDistTag = z.infer<typeof ReleaseDistTagSchema>

export const RELEASE_DIST_TAG_BY_CHANNEL: Readonly<Record<ReleaseChannel, ReleaseDistTag>> = {
  dev: "dev",
  nightly: "nightly",
  beta: "beta",
  stable: "latest",
}

export const ReleaseEvidenceStatusSchema = z.enum(["tested", "built-not-tested", "not-evidenced"])
export type ReleaseEvidenceStatus = z.infer<typeof ReleaseEvidenceStatusSchema>

export const ReleaseTargetSchema = z.enum([
  "bun-windows-x64-baseline",
  "bun-windows-arm64",
  "bun-linux-x64-baseline",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
])
export type ReleaseTarget = z.infer<typeof ReleaseTargetSchema>

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)
const SignaturePrincipalSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => value === value.trim(), "Signature principal must not have edge whitespace")
  .refine((value) => value === value.normalize("NFC"), "Signature principal must use NFC")
  .refine(
    (value) => !containsC0C1OrDeleteControl(value),
    "Signature principal must not contain control characters",
  )
const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u)

function releaseVersionChannelIssue(version: string, channel: ReleaseChannel): string | undefined {
  if (!SemverSchema.safeParse(version).success) {
    return `Release version is not SemVer: ${version}`
  }

  const buildSeparator = version.indexOf("+")
  const versionWithoutBuild = buildSeparator < 0 ? version : version.slice(0, buildSeparator)
  const buildMetadata = buildSeparator < 0 ? undefined : version.slice(buildSeparator + 1)
  if (buildMetadata !== undefined && buildMetadata.split(".").some((entry) => entry.length === 0)) {
    return `Release version contains an empty SemVer build identifier: ${version}`
  }
  const prereleaseSeparator = versionWithoutBuild.indexOf("-")
  const prereleaseIdentifiers =
    prereleaseSeparator < 0 ? [] : versionWithoutBuild.slice(prereleaseSeparator + 1).split(".")
  if (
    prereleaseIdentifiers.some(
      (entry) =>
        entry.length === 0 || (/^\d+$/u.test(entry) && entry.length > 1 && entry.startsWith("0")),
    )
  ) {
    return `Release version contains an invalid SemVer prerelease identifier: ${version}`
  }

  const prereleaseKind = prereleaseIdentifiers[0]
  if (channel === "stable" && prereleaseKind !== undefined) {
    return "Stable channel requires a SemVer version without a prerelease identifier"
  }
  if (channel === "beta" && prereleaseKind !== "beta") {
    return "Beta channel requires a SemVer prerelease whose first identifier is beta"
  }
  if (channel === "nightly" && prereleaseKind !== "nightly" && prereleaseKind !== "dev") {
    return "Nightly channel requires a SemVer prerelease whose first identifier is nightly or dev"
  }
  if (channel === "dev" && prereleaseKind !== "dev") {
    return "Dev channel requires a SemVer prerelease whose first identifier is dev"
  }
  return undefined
}

export function assertReleaseVersionChannel(version: string, channel: ReleaseChannel): void {
  const issue = releaseVersionChannelIssue(version, channel)
  if (issue) throw new Error(issue)
}

export function expectedReleaseDistTag(channel: ReleaseChannel): ReleaseDistTag {
  return RELEASE_DIST_TAG_BY_CHANNEL[channel]
}

export function assertReleaseDistTag(channel: ReleaseChannel, distTag: ReleaseDistTag): void {
  const expected = expectedReleaseDistTag(channel)
  if (distTag !== expected) {
    throw new Error(
      `Release channel ${channel} requires npm dist-tag ${expected}, received ${distTag}`,
    )
  }
}

export const InstallDurabilitySchema = z
  .object({
    fileSync: z.literal("fsync-before-rename"),
    directorySync: z.enum(["fsync-after-rename", "unsupported-file-sync-only"]),
    guarantee: z.enum(["full", "reduced"]),
  })
  .strict()
  .refine(
    (value) =>
      (value.directorySync === "fsync-after-rename" && value.guarantee === "full") ||
      (value.directorySync === "unsupported-file-sync-only" && value.guarantee === "reduced"),
    "Durability guarantee must match directory-sync capability",
  )
export type InstallDurability = z.infer<typeof InstallDurabilitySchema>

const FULL_INSTALL_DURABILITY = {
  fileSync: "fsync-before-rename",
  directorySync: "fsync-after-rename",
  guarantee: "full",
} as const satisfies InstallDurability

const REDUCED_INSTALL_DURABILITY = {
  fileSync: "fsync-before-rename",
  directorySync: "unsupported-file-sync-only",
  guarantee: "reduced",
} as const satisfies InstallDurability

const RELEASE_TARGET_INSTALL_DURABILITY: Readonly<Record<ReleaseTarget, InstallDurability>> = {
  "bun-windows-x64-baseline": REDUCED_INSTALL_DURABILITY,
  "bun-windows-arm64": REDUCED_INSTALL_DURABILITY,
  "bun-linux-x64-baseline": FULL_INSTALL_DURABILITY,
  "bun-linux-arm64": FULL_INSTALL_DURABILITY,
  "bun-darwin-x64": FULL_INSTALL_DURABILITY,
  "bun-darwin-arm64": FULL_INSTALL_DURABILITY,
}

export function releaseTargetInstallDurability(target: ReleaseTarget): InstallDurability {
  const parsed = ReleaseTargetSchema.parse(target)
  return { ...RELEASE_TARGET_INSTALL_DURABILITY[parsed] }
}

const SupportPolicyTextSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine((value) => value === value.trim(), "Support policy text must not have edge whitespace")
  .refine((value) => value === value.normalize("NFC"), "Support policy text must use NFC")
  .refine(
    (value) => !containsC0C1OrDeleteControl(value),
    "Support policy text must not contain control characters",
  )

export const ReleaseTargetCapabilitiesSchema = z
  .object({
    installControlStateDurability: InstallDurabilitySchema,
  })
  .strict()
export type ReleaseTargetCapabilities = z.infer<typeof ReleaseTargetCapabilitiesSchema>

const IncludedReleaseTargetPolicySchema = z
  .object({
    target: ReleaseTargetSchema,
    status: z.literal("included"),
    capabilities: ReleaseTargetCapabilitiesSchema,
    limitations: z.array(SupportPolicyTextSchema).max(64),
  })
  .strict()

const NotPromotedReleaseTargetPolicySchema = z
  .object({
    target: ReleaseTargetSchema,
    status: z.literal("not-promoted"),
    capabilities: ReleaseTargetCapabilitiesSchema,
    reason: SupportPolicyTextSchema,
  })
  .strict()

export const ReleaseTargetSupportPolicySchema = z.discriminatedUnion("status", [
  IncludedReleaseTargetPolicySchema,
  NotPromotedReleaseTargetPolicySchema,
])
export type ReleaseTargetSupportPolicy = z.infer<typeof ReleaseTargetSupportPolicySchema>

/**
 * A release policy is deliberately complete: every known target is present in
 * canonical order, even when it is not promoted. The policy chooses no target
 * by default; that product decision must arrive as an explicit input.
 */
export const ReleaseSupportPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("ralph-next"),
    version: SemverSchema,
    channel: ReleaseChannelSchema,
    matrix: z.array(ReleaseTargetSupportPolicySchema).length(ReleaseTargetSchema.options.length),
  })
  .strict()
  .superRefine((policy, context) => {
    const versionChannelIssue = releaseVersionChannelIssue(policy.version, policy.channel)
    if (versionChannelIssue) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: versionChannelIssue,
      })
    }
    let includedTargets = 0
    for (const [index, expectedTarget] of ReleaseTargetSchema.options.entries()) {
      const entry = policy.matrix[index]
      if (!entry || entry.target !== expectedTarget) {
        context.addIssue({
          code: "custom",
          path: ["matrix", index, "target"],
          message: `Support matrix must contain ${expectedTarget} at canonical index ${index}`,
        })
        continue
      }
      const expectedDurability = releaseTargetInstallDurability(expectedTarget)
      const declaredDurability = entry.capabilities.installControlStateDurability
      if (
        declaredDurability.fileSync !== expectedDurability.fileSync ||
        declaredDurability.directorySync !== expectedDurability.directorySync ||
        declaredDurability.guarantee !== expectedDurability.guarantee
      ) {
        context.addIssue({
          code: "custom",
          path: ["matrix", index, "capabilities", "installControlStateDurability"],
          message: `Support policy must declare the real installer durability capability for ${expectedTarget}`,
        })
      }
      if (entry.status === "included") {
        includedTargets += 1
        if (policy.channel === "stable" && declaredDurability.guarantee !== "full") {
          context.addIssue({
            code: "custom",
            path: ["matrix", index, "status"],
            message: `Stable cannot promote ${expectedTarget} without full install-control durability`,
          })
        }
      }
    }
    const uniqueTargets = new Set(policy.matrix.map((entry) => entry.target))
    if (uniqueTargets.size !== ReleaseTargetSchema.options.length) {
      context.addIssue({
        code: "custom",
        path: ["matrix"],
        message: "Support matrix must declare every release target exactly once",
      })
    }
    if (includedTargets === 0) {
      context.addIssue({
        code: "custom",
        path: ["matrix"],
        message: "Support policy must explicitly include at least one target",
      })
    }
  })
export type ReleaseSupportPolicy = z.infer<typeof ReleaseSupportPolicySchema>

function canonicalSupportPolicyJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Support policy rejects non-finite numbers")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSupportPolicyJson(entry)).join(",")}]`
  }
  if (typeof value !== "object") {
    throw new Error(`Support policy rejects ${typeof value}`)
  }
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalSupportPolicyJson(record[key])}`)
    .join(",")}}`
}

export function releaseSupportPolicySha256(raw: ReleaseSupportPolicy): string {
  const policy = ReleaseSupportPolicySchema.parse(raw)
  return createHash("sha256").update(canonicalSupportPolicyJson(policy), "utf8").digest("hex")
}
const WindowsReservedPathSegmentSchema = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

function isCanonicalReleasePath(value: string): boolean {
  if (
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false
  }
  const segments = value.split("/")
  return segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      !containsC0OrDeleteControl(segment) &&
      !/[<>:"|?*]/u.test(segment) &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      !WindowsReservedPathSegmentSchema.test(segment),
  )
}

export function releasePathCollisionKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und")
}

export const PortableRelativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    isCanonicalReleasePath,
    "Release paths must be canonical NFC cross-platform relative paths without unsafe segments",
  )

export const ReleasePayloadSchema = z
  .object({
    path: PortableRelativePathSchema,
    url: z
      .url()
      .refine(isHttpsUrl, "Release URL must use HTTPS without credentials, query or fragment")
      .optional(),
    sha256: Sha256Schema,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024 * 1024),
    mediaType: z.string().min(1).max(128),
  })
  .strict()
export type ReleasePayload = z.infer<typeof ReleasePayloadSchema>

const CycloneDxPropertySchema = z
  .object({
    name: z.string().min(1).max(512),
    value: z.string().max(8_192),
  })
  .strict()

const CycloneDxComponentSchema = z
  .object({
    type: z.enum(["application", "library"]),
    "bom-ref": z.string().min(1).max(4_096),
    name: z.string().min(1).max(512),
    version: z.string().min(1).max(512),
    purl: z.string().min(1).max(4_096).optional(),
    hashes: z
      .array(
        z
          .object({
            alg: z.string().min(1).max(32),
            content: z.string().min(1).max(1_024),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    licenses: z
      .array(z.object({ expression: z.string().min(1).max(1_024) }).strict())
      .min(1)
      .max(64),
    properties: z.array(CycloneDxPropertySchema).max(256).optional(),
  })
  .strict()

const CycloneDxDependencySchema = z
  .object({
    ref: z.string().min(1).max(4_096),
    dependsOn: z.array(z.string().min(1).max(4_096)).max(10_000),
  })
  .strict()

/**
 * The release pipeline emits one deliberately bounded CycloneDX 1.6 profile.
 * This is not a replacement for the complete CycloneDX specification; it is
 * the untrusted-input contract that install/update can validate deterministically.
 */
export const ReleaseSbomSchema = z
  .object({
    bomFormat: z.literal("CycloneDX"),
    specVersion: z.literal("1.6"),
    serialNumber: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/iu),
    version: z.number().int().positive().max(2_147_483_647),
    metadata: z
      .object({
        timestamp: z.iso.datetime({ offset: true }),
        component: CycloneDxComponentSchema,
        tools: z.object({ components: z.array(CycloneDxComponentSchema).min(1).max(64) }).strict(),
        properties: z.array(CycloneDxPropertySchema).max(256),
      })
      .strict(),
    components: z.array(CycloneDxComponentSchema).max(10_000),
    dependencies: z.array(CycloneDxDependencySchema).min(1).max(10_001),
  })
  .strict()
  .superRefine((bom, context) => {
    const componentRefs = new Set<string>([bom.metadata.component["bom-ref"]])
    for (const [index, component] of bom.components.entries()) {
      if (componentRefs.has(component["bom-ref"])) {
        context.addIssue({
          code: "custom",
          path: ["components", index, "bom-ref"],
          message: `Duplicate CycloneDX component reference: ${component["bom-ref"]}`,
        })
      }
      componentRefs.add(component["bom-ref"])
    }
    const dependencyRefs = new Set<string>()
    for (const [index, dependency] of bom.dependencies.entries()) {
      if (!componentRefs.has(dependency.ref)) {
        context.addIssue({
          code: "custom",
          path: ["dependencies", index, "ref"],
          message: `CycloneDX dependency references an unknown component: ${dependency.ref}`,
        })
      }
      if (dependencyRefs.has(dependency.ref)) {
        context.addIssue({
          code: "custom",
          path: ["dependencies", index, "ref"],
          message: `Duplicate CycloneDX dependency reference: ${dependency.ref}`,
        })
      }
      dependencyRefs.add(dependency.ref)
      for (const [dependsOnIndex, dependsOn] of dependency.dependsOn.entries()) {
        if (!componentRefs.has(dependsOn)) {
          context.addIssue({
            code: "custom",
            path: ["dependencies", index, "dependsOn", dependsOnIndex],
            message: `CycloneDX dependency edge references an unknown component: ${dependsOn}`,
          })
        }
      }
    }
    if (!dependencyRefs.has(bom.metadata.component["bom-ref"])) {
      context.addIssue({
        code: "custom",
        path: ["dependencies"],
        message: "CycloneDX dependencies must include the metadata component",
      })
    }
  })
export type ReleaseSbom = z.infer<typeof ReleaseSbomSchema>

export const ReleaseArtifactSchema = z
  .object({
    target: ReleaseTargetSchema,
    evidenceStatus: ReleaseEvidenceStatusSchema,
    launcher: ReleasePayloadSchema,
    launcherBuildMetadata: ReleasePayloadSchema,
    executable: ReleasePayloadSchema,
    buildMetadata: ReleasePayloadSchema,
    archive: ReleasePayloadSchema.optional(),
    limitations: z.array(z.string().min(1).max(2_000)).max(64).default([]),
  })
  .strict()
export type ReleaseArtifact = z.infer<typeof ReleaseArtifactSchema>

export const ReleaseSignatureKindSchema = z.enum(["cosign", "minisign", "gpg", "sigstore-bundle"])
export type ReleaseSignatureKind = z.infer<typeof ReleaseSignatureKindSchema>
export const ReleaseSignatureMediaTypeSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u)

export const ReleaseSignatureSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unavailable"),
      reason: z.string().min(1).max(1_000),
    })
    .strict(),
  z
    .object({
      status: z.literal("present"),
      kind: ReleaseSignatureKindSchema,
      identity: SignaturePrincipalSchema,
      signedManifestSha256: Sha256Schema,
      payload: z
        .object({
          path: PortableRelativePathSchema,
          url: z
            .url()
            .refine(
              isHttpsUrl,
              "Signature URL must use HTTPS without credentials, query or fragment",
            )
            .optional(),
          maximumSizeBytes: z
            .number()
            .int()
            .positive()
            .max(64 * 1024 * 1024),
          mediaType: ReleaseSignatureMediaTypeSchema,
        })
        .strict(),
    })
    .strict(),
])

export const ReleaseSignatureTrustPolicySchema = z
  .object({
    kind: ReleaseSignatureKindSchema,
    trustedIdentities: z.array(SignaturePrincipalSchema).min(1).max(64),
    trustedIssuers: z.array(SignaturePrincipalSchema).max(64).default([]),
    channels: z
      .array(z.enum(["nightly", "beta", "stable"]))
      .min(1)
      .max(3),
    origins: z
      .array(
        z.union([
          z.literal("local-artifact"),
          z
            .url()
            .refine((value) => {
              const url = new URL(value)
              return (
                url.protocol === "https:" &&
                !url.username &&
                !url.password &&
                !url.search &&
                !url.hash &&
                url.pathname === "/"
              )
            }, "Trusted remote origin must be an HTTPS origin without path, query or fragment")
            .transform((value) => `${new URL(value).origin}/`),
        ]),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((policy, context) => {
    for (const [field, values] of [
      ["trustedIdentities", policy.trustedIdentities],
      ["trustedIssuers", policy.trustedIssuers],
      ["channels", policy.channels],
      ["origins", policy.origins],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `Signature trust policy repeats ${field}`,
        })
      }
    }
  })
export type ReleaseSignatureTrustPolicy = z.infer<typeof ReleaseSignatureTrustPolicySchema>

export const ReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    product: z.literal("ralph-next"),
    version: SemverSchema,
    channel: ReleaseChannelSchema,
    publishedAt: z.iso.datetime({ offset: true }),
    source: z
      .object({
        repository: z.url().refine((value) => {
          if (!isHttpsUrl(value)) return false
          const url = new URL(value)
          return !url.search && !url.hash
        }, "Source repository must use HTTPS without credentials, query or fragment"),
        commit: z.string().regex(/^[0-9a-f]{40}$/u),
        fingerprintSha256: Sha256Schema,
      })
      .strict(),
    compatibility: z
      .object({
        minimumWorkspaceSchema: z.number().int().positive(),
        maximumWorkspaceSchema: z.number().int().positive(),
        minimumLauncherSchema: z.number().int().positive(),
        maximumLauncherSchema: z.number().int().positive(),
        downgradeSafeThrough: SemverSchema.optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.maximumWorkspaceSchema >= value.minimumWorkspaceSchema &&
          value.maximumLauncherSchema >= value.minimumLauncherSchema,
        "Maximum schema versions must not precede their minimums",
      ),
    supportPolicy: ReleaseSupportPolicySchema,
    supportPolicySha256: Sha256Schema,
    artifacts: z.array(ReleaseArtifactSchema).min(1).max(16),
    license: ReleasePayloadSchema,
    thirdPartyNotices: ReleasePayloadSchema,
    sbom: ReleasePayloadSchema,
    skill: ReleasePayloadSchema,
    checksums: ReleasePayloadSchema,
    promotionRecord: ReleasePayloadSchema.optional(),
    signature: ReleaseSignatureSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    const versionChannelIssue = releaseVersionChannelIssue(manifest.version, manifest.channel)
    if (versionChannelIssue) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: versionChannelIssue,
      })
    }
    if (
      manifest.supportPolicy.version !== manifest.version ||
      manifest.supportPolicy.channel !== manifest.channel
    ) {
      context.addIssue({
        code: "custom",
        path: ["supportPolicy"],
        message: "Support policy must bind the manifest version and channel",
      })
    }
    const computedSupportPolicySha256 = releaseSupportPolicySha256(manifest.supportPolicy)
    if (manifest.supportPolicySha256 !== computedSupportPolicySha256) {
      context.addIssue({
        code: "custom",
        path: ["supportPolicySha256"],
        message: "Support policy hash does not bind the canonical support matrix",
      })
    }
    const includedTargets = manifest.supportPolicy.matrix
      .filter((entry) => entry.status === "included")
      .map((entry) => entry.target)
    if (manifest.artifacts.length !== includedTargets.length) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Release artifacts must exactly match the targets explicitly included by policy",
      })
    }
    const targets = new Set<string>()
    const paths = new Map<string, string>()
    const registerPayload = (path: string, issuePath: (string | number)[]) => {
      const collisionKey = releasePathCollisionKey(path)
      const existing = paths.get(collisionKey)
      if (existing) {
        context.addIssue({
          code: "custom",
          path: issuePath,
          message: `Release payload path collides cross-platform with ${existing}: ${path}`,
        })
      }
      paths.set(collisionKey, path)
    }
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (artifact.target !== includedTargets[index]) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index, "target"],
          message: `Release artifacts must follow the included support matrix; expected ${includedTargets[index] ?? "no target"}`,
        })
      }
      if (targets.has(artifact.target)) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index, "target"],
          message: `Duplicate release target: ${artifact.target}`,
        })
      }
      targets.add(artifact.target)
      registerPayload(artifact.launcher.path, ["artifacts", index, "launcher", "path"])
      registerPayload(artifact.launcherBuildMetadata.path, [
        "artifacts",
        index,
        "launcherBuildMetadata",
        "path",
      ])
      registerPayload(artifact.executable.path, ["artifacts", index, "executable", "path"])
      registerPayload(artifact.buildMetadata.path, ["artifacts", index, "buildMetadata", "path"])
      if (artifact.archive) {
        registerPayload(artifact.archive.path, ["artifacts", index, "archive", "path"])
      }
    }
    registerPayload(manifest.license.path, ["license", "path"])
    registerPayload(manifest.thirdPartyNotices.path, ["thirdPartyNotices", "path"])
    registerPayload(manifest.sbom.path, ["sbom", "path"])
    registerPayload(manifest.skill.path, ["skill", "path"])
    registerPayload(manifest.checksums.path, ["checksums", "path"])
    if (manifest.promotionRecord) {
      registerPayload(manifest.promotionRecord.path, ["promotionRecord", "path"])
    }
    if (manifest.signature.status === "present") {
      registerPayload(manifest.signature.payload.path, ["signature", "payload", "path"])
    }
    if (manifest.channel === "stable" && !manifest.promotionRecord) {
      context.addIssue({
        code: "custom",
        path: ["promotionRecord"],
        message: "Stable releases require a promotion record with matrix and target evidence",
      })
    }
    if (
      manifest.artifacts.some((artifact) => artifact.evidenceStatus === "tested") &&
      !manifest.promotionRecord
    ) {
      context.addIssue({
        code: "custom",
        path: ["promotionRecord"],
        message: "Artifacts may be marked tested only when a promotion record is present",
      })
    }
    if (manifest.promotionRecord && manifest.channel !== "beta" && manifest.channel !== "stable") {
      context.addIssue({
        code: "custom",
        path: ["promotionRecord"],
        message: "Promotion records are valid only for beta or stable releases",
      })
    }
    if (manifest.promotionRecord) {
      for (const [index, artifact] of manifest.artifacts.entries()) {
        if (artifact.evidenceStatus !== "tested") {
          context.addIssue({
            code: "custom",
            path: ["artifacts", index, "evidenceStatus"],
            message: "Every artifact in a promoted manifest must have tested evidence",
          })
        }
      }
    }
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (artifact.evidenceStatus === "tested" && !artifact.archive) {
        context.addIssue({
          code: "custom",
          path: ["artifacts", index, "archive"],
          message: "Tested target evidence requires the exact release archive payload",
        })
      }
    }
    if (manifest.channel === "stable") {
      for (const [index, artifact] of manifest.artifacts.entries()) {
        if (artifact.evidenceStatus !== "tested") {
          context.addIssue({
            code: "custom",
            path: ["artifacts", index, "evidenceStatus"],
            message: "Every stable release artifact must have tested target evidence",
          })
        }
      }
      if (manifest.signature.status !== "present") {
        context.addIssue({
          code: "custom",
          path: ["signature", "status"],
          message: "Stable releases require a declared signature payload",
        })
      }
    }
  })
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>

export const ReleaseBuildMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("ralph-next").optional(),
    target: ReleaseTargetSchema,
    status: ReleaseEvidenceStatusSchema,
    version: SemverSchema,
    bunVersion: z.string().min(1).max(128),
    bunRevision: z.string().min(1).max(256),
    artifact: PortableRelativePathSchema,
    sha256: Sha256Schema,
    sourceSha256: Sha256Schema,
    builtAt: z.iso.datetime({ offset: true }),
  })
  .strict()
export type ReleaseBuildMetadata = z.infer<typeof ReleaseBuildMetadataSchema>

export const LauncherBuildMetadataSchema = ReleaseBuildMetadataSchema.extend({
  product: z.literal("ralph-next-launcher"),
}).strict()
export type LauncherBuildMetadata = z.infer<typeof LauncherBuildMetadataSchema>

export const InstallOriginSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("standalone"),
      manifestUrl: z.url().refine(isHttpsUrl),
    })
    .strict(),
  z
    .object({
      kind: z.literal("local-artifact"),
      manifestPath: z.string().min(1).max(32_768),
    })
    .strict(),
  z
    .object({
      kind: z.literal("npm"),
      packageName: z.string().min(1).max(214),
      packageManager: z.enum(["npm", "pnpm", "bun", "unknown"]),
    })
    .strict(),
  z.object({ kind: z.literal("dev-checkout") }).strict(),
])
export type InstallOrigin = z.infer<typeof InstallOriginSchema>

export const InstalledVersionSchema = z
  .object({
    version: SemverSchema,
    channel: ReleaseChannelSchema,
    target: ReleaseTargetSchema,
    directory: z.string().min(1).max(32_768),
    executable: z.string().min(1).max(32_768),
    sha256: Sha256Schema,
    evidenceStatus: ReleaseEvidenceStatusSchema,
    compatibility: z
      .object({
        minimumWorkspaceSchema: z.number().int().positive(),
        maximumWorkspaceSchema: z.number().int().positive(),
        minimumLauncherSchema: z.number().int().positive(),
        maximumLauncherSchema: z.number().int().positive(),
      })
      .strict()
      .refine(
        (value) =>
          value.maximumWorkspaceSchema >= value.minimumWorkspaceSchema &&
          value.maximumLauncherSchema >= value.minimumLauncherSchema,
        "Installed compatibility ranges must be ordered",
      ),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(32_768),
            sha256: Sha256Schema,
            sizeBytes: z
              .number()
              .int()
              .positive()
              .max(4 * 1024 * 1024 * 1024),
            role: z.enum([
              "executable",
              "build-metadata",
              "launcher-build-metadata",
              "release-manifest",
              "checksums",
              "sbom",
              "skill",
              "license",
              "third-party-notices",
              "promotion-record",
              "signature",
            ]),
          })
          .strict(),
      )
      .min(9)
      .max(32),
    installedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((installed, context) => {
    const paths = new Set<string>()
    const roles = new Set<string>()
    for (const [index, file] of installed.files.entries()) {
      if (paths.has(file.path)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: `Duplicate installed file path: ${file.path}`,
        })
      }
      paths.add(file.path)
      if (roles.has(file.role) && file.role !== "signature") {
        context.addIssue({
          code: "custom",
          path: ["files", index, "role"],
          message: `Duplicate installed file role: ${file.role}`,
        })
      }
      roles.add(file.role)
    }
    for (const role of [
      "executable",
      "build-metadata",
      "launcher-build-metadata",
      "release-manifest",
      "checksums",
      "sbom",
      "skill",
      "license",
      "third-party-notices",
    ]) {
      if (!roles.has(role)) {
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: `Installed version is missing required file role: ${role}`,
        })
      }
    }
  })
export type InstalledVersion = z.infer<typeof InstalledVersionSchema>

export const CurrentInstallPointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    installId: z.uuid(),
    product: z.literal("ralph-next"),
    generation: z.number().int().positive(),
    receipt: PortableRelativePathSchema.refine(
      (value) => value.startsWith("receipts/"),
      "Current receipt must live under receipts/",
    ),
    receiptSha256: Sha256Schema,
    version: SemverSchema,
    target: ReleaseTargetSchema,
    executable: PortableRelativePathSchema.refine(
      (value) => value.startsWith("versions/"),
      "Current executable must live under versions/",
    ),
    sha256: Sha256Schema,
    activatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
export type CurrentInstallPointer = z.infer<typeof CurrentInstallPointerSchema>

export const InstallReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    installId: z.uuid(),
    product: z.literal("ralph-next"),
    generation: z.number().int().positive(),
    installRoot: z.string().min(1).max(32_768),
    origin: InstallOriginSchema,
    channel: ReleaseChannelSchema,
    currentVersion: SemverSchema,
    currentTarget: ReleaseTargetSchema,
    currentExecutable: z.string().min(1).max(32_768),
    launcher: z
      .object({
        schemaVersion: z.literal(1),
        executable: z.string().min(1).max(32_768),
        sha256: Sha256Schema,
        installedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    durability: InstallDurabilitySchema,
    previousVersion: SemverSchema.optional(),
    versions: z.array(InstalledVersionSchema).min(1).max(64),
    managedPaths: z.array(z.string().min(1).max(32_768)).min(1).max(4_096),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((receipt, context) => {
    const versions = new Set(receipt.versions.map((entry) => entry.version))
    if (!versions.has(receipt.currentVersion)) {
      context.addIssue({
        code: "custom",
        path: ["currentVersion"],
        message: "Current version is absent from the install receipt",
      })
    }
    if (receipt.previousVersion && !versions.has(receipt.previousVersion)) {
      context.addIssue({
        code: "custom",
        path: ["previousVersion"],
        message: "Previous version is absent from the install receipt",
      })
    }
  })
export type InstallReceipt = z.infer<typeof InstallReceiptSchema>

/**
 * Ownership receipt for the optional `ralph` launcher copy. The alias is
 * deliberately scoped to one identified standalone install root and never
 * claims, replaces or removes a `ralph` executable outside that root.
 */
export const RalphAliasReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("ralph-next"),
    alias: z.literal("ralph"),
    installId: z.uuid(),
    installRoot: z.string().min(1).max(32_768),
    sourceGeneration: z.number().int().positive(),
    sourceReceiptPath: z.string().min(1).max(32_768),
    sourceReceiptSha256: Sha256Schema,
    launcherPath: z.string().min(1).max(32_768),
    launcherSha256: Sha256Schema,
    aliasPath: z.string().min(1).max(32_768),
    aliasSha256: Sha256Schema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine(
    (receipt) => receipt.launcherSha256 === receipt.aliasSha256,
    "The optional ralph alias must be an exact copy of its receipt-bound launcher",
  )
export type RalphAliasReceipt = z.infer<typeof RalphAliasReceiptSchema>

export const DistributionOperationSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.uuid(),
    action: z.enum(["install", "update", "rollback", "uninstall"]),
    status: z.enum([
      "planned",
      "staged",
      "verified",
      "repair-required",
      "materializing-version",
      "installing-launcher",
      "persisting-control-state",
      "activating",
      "activated",
      "uninstalling",
      "removing-control-state",
      "completed",
      "rolling-back",
      "rolled-back",
      "failed",
    ]),
    installRoot: z.string().min(1).max(32_768),
    installId: z.uuid().optional(),
    requestedVersion: SemverSchema.optional(),
    previousVersion: SemverSchema.optional(),
    target: ReleaseTargetSchema.optional(),
    stagingRoot: z.string().min(1).max(32_768),
    rollbackPointerPath: z.string().min(1).max(32_768).optional(),
    pendingRename: z
      .object({
        kind: z.enum(["version", "launcher"]),
        source: z.string().min(1).max(32_768),
        destination: z.string().min(1).max(32_768),
      })
      .strict()
      .optional(),
    pendingReceiptPath: z.string().min(1).max(32_768).optional(),
    pendingReceiptSha256: Sha256Schema.optional(),
    deferredRequestId: z.uuid().optional(),
    deferredHandoffTokenSha256: Sha256Schema.optional(),
    handoffReceiptPath: z.string().min(1).max(32_768).optional(),
    handoffReceiptSha256: Sha256Schema.optional(),
    uninstallPaths: z.array(z.string().min(1).max(32_768)).max(4_096).default([]),
    stagedPaths: z.array(z.string().min(1).max(32_768)).max(4_096),
    materializedPaths: z.array(z.string().min(1).max(32_768)).max(4_096).default([]),
    launcherMutation: z.enum(["install", "preserve", "repair-required", "none"]),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    failure: z
      .object({ code: z.string().min(1), message: z.string().min(1).max(4_000) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((operation, context) => {
    for (const [left, right, path] of [
      [operation.pendingReceiptPath, operation.pendingReceiptSha256, "pendingReceiptPath"],
      [operation.handoffReceiptPath, operation.handoffReceiptSha256, "handoffReceiptPath"],
      [operation.deferredRequestId, operation.deferredHandoffTokenSha256, "deferredRequestId"],
    ] as const) {
      if (Boolean(left) !== Boolean(right)) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${path} has an incomplete paired binding`,
        })
      }
    }
    const hasUninstallState =
      operation.uninstallPaths.length > 0 ||
      operation.status === "uninstalling" ||
      operation.status === "removing-control-state"
    if (hasUninstallState && operation.action !== "uninstall") {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "Uninstall-only journal state is forbidden on other actions",
      })
    }
  })
export type DistributionOperation = z.infer<typeof DistributionOperationSchema>

export const DistributionLockOwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    ownerToken: z.uuid(),
    pid: z.number().int().positive(),
    hostname: z.string().min(1).max(255),
    action: z.enum([
      "install",
      "update",
      "rollback",
      "uninstall",
      "recover",
      "alias-install",
      "alias-remove",
    ]),
    installRoot: z.string().min(1).max(32_768),
    processStartedAt: z.iso.datetime({ offset: true }),
    acquiredAt: z.iso.datetime({ offset: true }),
  })
  .strict()
export type DistributionLockOwner = z.infer<typeof DistributionLockOwnerSchema>

/**
 * Authenticated-by-hash handoff from the foreground CLI to a copied, external
 * cleanup helper. The helper still rebinds every field to current.json and its
 * immutable receipt before deleting anything.
 */
export const DeferredUninstallRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    handoffToken: z.uuid(),
    installRoot: z.string().min(1).max(32_768),
    installId: z.uuid(),
    generation: z.number().int().positive(),
    receiptPath: z.string().min(1).max(32_768),
    receiptSha256: Sha256Schema,
    currentVersion: SemverSchema,
    target: ReleaseTargetSchema,
    waitForPids: z.array(z.number().int().positive()).min(1).max(16),
    createdByPid: z.number().int().positive(),
    createdAt: z.iso.datetime({ offset: true }),
    maximumWaitMilliseconds: z.number().int().min(60_000).max(86_400_000),
  })
  .strict()
  .superRefine((request, context) => {
    if (!request.waitForPids.includes(request.createdByPid)) {
      context.addIssue({
        code: "custom",
        path: ["waitForPids"],
        message: "Deferred uninstall must wait for its creating process",
      })
    }
    if (new Set(request.waitForPids).size !== request.waitForPids.length) {
      context.addIssue({
        code: "custom",
        path: ["waitForPids"],
        message: "Deferred uninstall wait PIDs must be unique",
      })
    }
  })
export type DeferredUninstallRequest = z.infer<typeof DeferredUninstallRequestSchema>
