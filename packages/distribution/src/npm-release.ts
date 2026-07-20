import { createHash } from "node:crypto"
import { z } from "zod"
import {
  assertReleaseDistTag,
  assertReleaseVersionChannel,
  PortableRelativePathSchema,
  ReleaseChannelSchema,
  ReleaseDistTagSchema,
  ReleaseSignatureKindSchema,
  ReleaseSignatureMediaTypeSchema,
} from "./contracts"
import {
  assertReleasePromotionBinding,
  type PromotionCandidateReceiptBinding,
  PromotionCandidateReceiptBindingSchema,
  ReleasePromotionRecordSchema,
} from "./promotion"
import { canonicalReleaseJson } from "./signature"

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)
const CommitSchema = z.string().regex(/^[0-9a-f]{40}$/u)
const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u)
const NpmPackageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u)
  .refine(
    (value) => !value.includes(".."),
    "npm package name cannot contain empty traversal segments",
  )

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

function canonicalTextSchema(maximumLength: number) {
  return z
    .string()
    .min(1)
    .max(maximumLength)
    .refine((value) => value === value.trim(), "Text must not have edge whitespace")
    .refine((value) => value === value.normalize("NFC"), "Text must use NFC")
    .refine((value) => !containsC0C1OrDeleteControl(value), "Text must not contain controls")
}
const CanonicalTextSchema = canonicalTextSchema(2_000)
const EvidenceIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u)
const SignatureIdentitySchema = canonicalTextSchema(1_000)

const HttpsRepositorySchema = z.url().refine((value) => {
  const url = new URL(value)
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
}, "Source repository must be HTTPS without credentials, query or fragment")

export const NpmReleaseBoundFileSchema = z
  .object({
    path: PortableRelativePathSchema,
    sha256: Sha256Schema,
    sizeBytes: z.number().int().positive(),
  })
  .strict()
export type NpmReleaseBoundFile = z.infer<typeof NpmReleaseBoundFileSchema>

const NpmReleasePackageIdentitySchema = z
  .object({
    name: NpmPackageNameSchema,
    version: SemverSchema,
    channel: ReleaseChannelSchema,
    distTag: ReleaseDistTagSchema,
  })
  .strict()
  .superRefine((value, context) => {
    try {
      assertReleaseVersionChannel(value.version, value.channel)
      assertReleaseDistTag(value.channel, value.distTag)
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

const NpmReleasePromotionPackageIdentitySchema = z
  .object({
    name: NpmPackageNameSchema,
    version: SemverSchema,
    channel: z.enum(["beta", "stable"]),
    distTag: z.enum(["beta", "latest"]),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      assertReleaseVersionChannel(value.version, value.channel)
      assertReleaseDistTag(value.channel, value.distTag)
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

const NpmReleaseSourceSchema = z
  .object({
    repository: HttpsRepositorySchema,
    commit: CommitSchema,
    fingerprintSha256: Sha256Schema,
  })
  .strict()

const NpmReleaseArtifactBindingSchema = z
  .object({
    tarball: NpmReleaseBoundFileSchema,
    packageManifest: NpmReleaseBoundFileSchema,
    bundle: NpmReleaseBoundFileSchema,
    buildMetadata: NpmReleaseBoundFileSchema,
    checksums: NpmReleaseBoundFileSchema,
  })
  .strict()

const NpmReleaseSupportBindingSchema = z
  .object({
    sbom: NpmReleaseBoundFileSchema,
    provenance: NpmReleaseBoundFileSchema,
    license: NpmReleaseBoundFileSchema,
    thirdPartyNotices: NpmReleaseBoundFileSchema,
  })
  .strict()

export const NpmPromotionGateSchema = z.enum([
  "artifactIntegrity",
  "licenseSbomAndProvenance",
  "installDrill",
  "channelPromotion",
])
export type NpmPromotionGate = z.infer<typeof NpmPromotionGateSchema>

export const NpmPromotionEvidenceKindSchema = z.enum([
  "source-review",
  "integration",
  "e2e",
  "install-drill",
  "license-sbom",
  "publication-dry-run",
])
export type NpmPromotionEvidenceKind = z.infer<typeof NpmPromotionEvidenceKindSchema>

const NpmPromotionRuntimeEnvironmentSchema = z
  .object({
    kind: z.literal("real"),
    os: z.enum(["windows", "linux", "macos"]),
    architecture: z.enum(["x64", "arm64"]),
    runner: canonicalTextSchema(500),
    isolation: z.enum(["none", "process", "container", "vm", "host"]),
    runtime: z
      .object({
        name: z.literal("bun"),
        version: SemverSchema,
      })
      .strict(),
    packageManager: z
      .object({
        name: z.enum(["npm", "pnpm", "bun"]),
        version: SemverSchema,
      })
      .strict(),
  })
  .strict()

const NpmPromotionAgnosticEnvironmentSchema = z
  .object({
    kind: z.literal("agnostic"),
    runner: canonicalTextSchema(500),
    isolation: z.enum(["none", "process", "container", "vm", "host"]),
  })
  .strict()

export const NpmPromotionEnvironmentSchema = z.discriminatedUnion("kind", [
  NpmPromotionRuntimeEnvironmentSchema,
  NpmPromotionAgnosticEnvironmentSchema,
])
export type NpmPromotionEnvironment = z.infer<typeof NpmPromotionEnvironmentSchema>

const NpmPromotionReferenceSchema = z
  .object({
    name: canonicalTextSchema(256),
    sha256: Sha256Schema,
  })
  .strict()

export const NpmPromotionAttestationSchema = z
  .object({
    id: EvidenceIdSchema,
    kind: NpmPromotionEvidenceKindSchema,
    status: z.literal("pass"),
    subjectSha256: Sha256Schema,
    issuer: z
      .object({
        reviewerId: EvidenceIdSchema,
        role: canonicalTextSchema(200),
      })
      .strict(),
    environment: NpmPromotionEnvironmentSchema,
    recordedAt: z.iso.datetime({ offset: true }),
    summary: CanonicalTextSchema,
    claims: z
      .object({
        gates: z.array(NpmPromotionGateSchema).min(1).max(NpmPromotionGateSchema.options.length),
      })
      .strict(),
    artifactRefs: z.array(NpmPromotionReferenceSchema).min(1).max(32),
    evidenceRefs: z.array(NpmPromotionReferenceSchema).min(1).max(32),
  })
  .strict()
  .superRefine((attestation, context) => {
    if (new Set(attestation.claims.gates).size !== attestation.claims.gates.length) {
      context.addIssue({
        code: "custom",
        path: ["claims", "gates"],
        message: "Duplicate npm promotion gate claim",
      })
    }
    const refKeys = attestation.artifactRefs.map(
      (reference) => `${reference.name}\u0000${reference.sha256}`,
    )
    if (new Set(refKeys).size !== refKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["artifactRefs"],
        message: "Duplicate npm promotion artifact reference",
      })
    }
    const evidenceRefKeys = attestation.evidenceRefs.map(
      (reference) => `${reference.name}\u0000${reference.sha256}`,
    )
    if (new Set(evidenceRefKeys).size !== evidenceRefKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["evidenceRefs"],
        message: "Duplicate npm promotion evidence reference",
      })
    }
    const artifactRefSet = new Set(refKeys)
    if (evidenceRefKeys.some((key) => artifactRefSet.has(key))) {
      context.addIssue({
        code: "custom",
        path: ["evidenceRefs"],
        message: "External evidence references must be distinct from candidate artifact references",
      })
    }
    if (
      ["integration", "e2e", "install-drill", "publication-dry-run"].includes(attestation.kind) &&
      attestation.environment.kind !== "real"
    ) {
      context.addIssue({
        code: "custom",
        path: ["environment"],
        message: `npm ${attestation.kind} evidence requires a typed real runtime environment`,
      })
    }
  })
export type NpmPromotionAttestation = z.infer<typeof NpmPromotionAttestationSchema>

export const StandaloneCandidateReceiptBindingSchema = z
  .object({
    subject: z.literal("standalone-release-candidate"),
    path: PortableRelativePathSchema,
    sha256: Sha256Schema,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(8 * 1024 * 1024),
  })
  .strict()
export type StandaloneCandidateReceiptBinding = z.infer<
  typeof StandaloneCandidateReceiptBindingSchema
>

const NpmPromotionGateEvidenceSchema = z
  .object({
    status: z.literal("pass"),
    evidence: z.array(EvidenceIdSchema).min(1).max(32),
  })
  .strict()

const NpmPromotionReviewerSchema = z
  .object({
    id: EvidenceIdSchema,
    name: canonicalTextSchema(200),
    role: canonicalTextSchema(200),
    reviewedAt: z.iso.datetime({ offset: true }),
  })
  .strict()

export const NpmReleasePromotionRecordSchema = z
  .object({
    schemaVersion: z.literal(2),
    product: z.literal("ralph-next"),
    subject: z.literal("npm-package"),
    package: NpmReleasePromotionPackageIdentitySchema,
    source: NpmReleaseSourceSchema,
    artifact: NpmReleaseArtifactBindingSchema,
    support: NpmReleaseSupportBindingSchema,
    releaseCandidateReceipt: StandaloneCandidateReceiptBindingSchema,
    releasePromotion: ReleasePromotionRecordSchema,
    recordedAt: z.iso.datetime({ offset: true }),
    attestations: z.array(NpmPromotionAttestationSchema).min(1).max(256),
    gates: z
      .object({
        artifactIntegrity: NpmPromotionGateEvidenceSchema,
        licenseSbomAndProvenance: NpmPromotionGateEvidenceSchema,
        installDrill: NpmPromotionGateEvidenceSchema,
        channelPromotion: NpmPromotionGateEvidenceSchema,
      })
      .strict(),
    reviewers: z.array(NpmPromotionReviewerSchema).min(1).max(32),
    limitations: z.array(CanonicalTextSchema).max(64),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.releasePromotion.version !== record.package.version ||
      record.releasePromotion.channel !== record.package.channel ||
      record.releasePromotion.source.repository !== record.source.repository ||
      record.releasePromotion.source.commit !== record.source.commit ||
      record.releasePromotion.source.fingerprintSha256 !== record.source.fingerprintSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["releasePromotion"],
        message: "Base release promotion must bind the same version, channel and source",
      })
    }
    if (
      record.releasePromotion.support.licenseSha256 !== record.support.license.sha256 ||
      record.releasePromotion.support.thirdPartyNoticesSha256 !==
        record.support.thirdPartyNotices.sha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["releasePromotion", "support"],
        message: "Base release promotion must bind the npm candidate license and notices",
      })
    }
    const reviewers = new Map(record.reviewers.map((reviewer) => [reviewer.id, reviewer]))
    if (reviewers.size !== record.reviewers.length) {
      context.addIssue({
        code: "custom",
        path: ["reviewers"],
        message: "Duplicate npm promotion reviewer id",
      })
    }
    const normalizedNames = record.reviewers.map((reviewer) =>
      reviewer.name.toLocaleLowerCase("und"),
    )
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      context.addIssue({
        code: "custom",
        path: ["reviewers"],
        message: "Duplicate npm promotion reviewer name",
      })
    }
    if (record.package.channel === "stable" && reviewers.size < 2) {
      context.addIssue({
        code: "custom",
        path: ["reviewers"],
        message: "Stable npm promotion requires two reviewers",
      })
    }
    const attestations = new Map<string, NpmPromotionAttestation>()
    const candidateFiles = [
      record.artifact.tarball,
      record.artifact.packageManifest,
      record.artifact.bundle,
      record.artifact.buildMetadata,
      record.artifact.checksums,
      record.support.sbom,
      record.support.provenance,
      record.support.license,
      record.support.thirdPartyNotices,
    ]
    const pathsByDigest = new Map<string, Set<string>>()
    for (const file of candidateFiles) {
      const paths = pathsByDigest.get(file.sha256) ?? new Set<string>()
      paths.add(file.path)
      pathsByDigest.set(file.sha256, paths)
    }
    const allowedDigests = new Set([
      record.source.fingerprintSha256,
      record.artifact.tarball.sha256,
      record.artifact.packageManifest.sha256,
      record.artifact.bundle.sha256,
      record.artifact.buildMetadata.sha256,
      record.artifact.checksums.sha256,
      record.support.sbom.sha256,
      record.support.provenance.sha256,
      record.support.license.sha256,
      record.support.thirdPartyNotices.sha256,
    ])
    const candidatePaths = new Set(candidateFiles.map((file) => file.path))
    for (const [index, attestation] of record.attestations.entries()) {
      if (attestations.has(attestation.id)) {
        context.addIssue({
          code: "custom",
          path: ["attestations", index, "id"],
          message: `Duplicate npm promotion attestation: ${attestation.id}`,
        })
      }
      attestations.set(attestation.id, attestation)
      const reviewer = reviewers.get(attestation.issuer.reviewerId)
      if (!reviewer || reviewer.role !== attestation.issuer.role) {
        context.addIssue({
          code: "custom",
          path: ["attestations", index, "issuer"],
          message: "npm promotion attestation issuer must match a reviewer",
        })
      } else if (Date.parse(reviewer.reviewedAt) < Date.parse(attestation.recordedAt)) {
        context.addIssue({
          code: "custom",
          path: ["attestations", index, "recordedAt"],
          message: "npm promotion reviewer cannot predate their attestation",
        })
      }
      if (!allowedDigests.has(attestation.subjectSha256)) {
        context.addIssue({
          code: "custom",
          path: ["attestations", index, "subjectSha256"],
          message: "npm promotion attestation subject is outside the exact candidate",
        })
      }
      for (const [referenceIndex, reference] of attestation.artifactRefs.entries()) {
        const expectedPaths = pathsByDigest.get(reference.sha256)
        if (!expectedPaths || !expectedPaths.has(reference.name)) {
          context.addIssue({
            code: "custom",
            path: ["attestations", index, "artifactRefs", referenceIndex, "sha256"],
            message: "npm promotion artifact reference is outside the exact candidate",
          })
        }
      }
      for (const [referenceIndex, reference] of attestation.evidenceRefs.entries()) {
        if (allowedDigests.has(reference.sha256) || candidatePaths.has(reference.name)) {
          context.addIssue({
            code: "custom",
            path: ["attestations", index, "evidenceRefs", referenceIndex],
            message:
              "npm evidence reference must identify an external content-addressed receipt or log",
          })
        }
      }
    }
    const allowedKinds: Readonly<Record<NpmPromotionGate, ReadonlySet<NpmPromotionEvidenceKind>>> =
      {
        artifactIntegrity: new Set(["integration", "e2e", "install-drill"]),
        licenseSbomAndProvenance: new Set(["license-sbom"]),
        installDrill: new Set(["install-drill"]),
        channelPromotion: new Set(["source-review", "publication-dry-run"]),
      }
    for (const gate of NpmPromotionGateSchema.options) {
      const evidence = record.gates[gate].evidence
      if (new Set(evidence).size !== evidence.length) {
        context.addIssue({
          code: "custom",
          path: ["gates", gate, "evidence"],
          message: `Duplicate evidence for npm gate ${gate}`,
        })
      }
      for (const [index, id] of evidence.entries()) {
        const attestation = attestations.get(id)
        if (!attestation) {
          context.addIssue({
            code: "custom",
            path: ["gates", gate, "evidence", index],
            message: `Unknown npm promotion attestation: ${id}`,
          })
        } else if (
          !attestation.claims.gates.includes(gate) ||
          !allowedKinds[gate].has(attestation.kind)
        ) {
          context.addIssue({
            code: "custom",
            path: ["gates", gate, "evidence", index],
            message: `npm promotion attestation does not satisfy gate ${gate}: ${id}`,
          })
        }
      }
    }
    const usedEvidence = new Set(
      NpmPromotionGateSchema.options.flatMap((gate) => record.gates[gate].evidence),
    )
    for (const [index, attestation] of record.attestations.entries()) {
      if (!usedEvidence.has(attestation.id)) {
        context.addIssue({
          code: "custom",
          path: ["attestations", index, "id"],
          message: `Unreferenced npm promotion attestation: ${attestation.id}`,
        })
      }
    }
    const latestAttestationTime = Math.max(
      ...record.attestations.map((attestation) => Date.parse(attestation.recordedAt)),
    )
    for (const [index, reviewer] of record.reviewers.entries()) {
      if (Date.parse(reviewer.reviewedAt) < latestAttestationTime) {
        context.addIssue({
          code: "custom",
          path: ["reviewers", index, "reviewedAt"],
          message: "npm promotion reviewer predates the final evidence set",
        })
      }
    }
    const installEvidence = record.gates.installDrill.evidence
      .map((id) => attestations.get(id))
      .filter((value): value is NpmPromotionAttestation => value !== undefined)
    const requiredInstallEnvironments = new Set(
      record.releasePromotion.targets.map(
        (target) => `${target.environment.os}\u0000${target.environment.architecture}`,
      ),
    )
    const coveredInstallEnvironments = new Set<string>()
    for (const [index, attestation] of installEvidence.entries()) {
      if (
        attestation.kind !== "install-drill" ||
        attestation.subjectSha256 !== record.artifact.tarball.sha256 ||
        attestation.environment.kind !== "real"
      ) {
        context.addIssue({
          code: "custom",
          path: ["gates", "installDrill", "evidence", index],
          message:
            "Every npm install drill must bind the exact tarball and a typed real environment",
        })
        continue
      }
      coveredInstallEnvironments.add(
        `${attestation.environment.os}\u0000${attestation.environment.architecture}`,
      )
    }
    for (const environment of requiredInstallEnvironments) {
      if (!coveredInstallEnvironments.has(environment)) {
        const [os, architecture] = environment.split("\u0000")
        context.addIssue({
          code: "custom",
          path: ["gates", "installDrill"],
          message: `npm install drill does not cover promoted target environment: ${os}/${architecture}`,
        })
      }
    }
    const integrityEvidence = record.gates.artifactIntegrity.evidence
      .map((id) => attestations.get(id))
      .filter((value): value is NpmPromotionAttestation => value !== undefined)
    if (
      !integrityEvidence.some((value) => value.subjectSha256 === record.artifact.tarball.sha256)
    ) {
      context.addIssue({
        code: "custom",
        path: ["gates", "artifactIntegrity"],
        message: "npm artifact integrity evidence must bind the exact tarball digest",
      })
    }
    const licenseEvidence = record.gates.licenseSbomAndProvenance.evidence
      .map((id) => attestations.get(id))
      .filter((value): value is NpmPromotionAttestation => value !== undefined)
    if (!licenseEvidence.some((value) => value.subjectSha256 === record.support.sbom.sha256)) {
      context.addIssue({
        code: "custom",
        path: ["gates", "licenseSbomAndProvenance"],
        message: "npm license evidence must bind the exact SBOM digest",
      })
    }
    const reviewedLicenseFiles = new Set(
      licenseEvidence.flatMap((attestation) =>
        attestation.artifactRefs.map((reference) => `${reference.name}\u0000${reference.sha256}`),
      ),
    )
    for (const required of [
      record.support.sbom,
      record.support.provenance,
      record.support.license,
      record.support.thirdPartyNotices,
    ]) {
      if (!reviewedLicenseFiles.has(`${required.path}\u0000${required.sha256}`)) {
        context.addIssue({
          code: "custom",
          path: ["gates", "licenseSbomAndProvenance"],
          message: `npm license evidence does not reference required support file: ${required.path}`,
        })
      }
    }
    const channelEvidence = record.gates.channelPromotion.evidence
      .map((id) => attestations.get(id))
      .filter((value): value is NpmPromotionAttestation => value !== undefined)
    if (!channelEvidence.some((value) => value.subjectSha256 === record.artifact.tarball.sha256)) {
      context.addIssue({
        code: "custom",
        path: ["gates", "channelPromotion"],
        message: "npm channel promotion evidence must bind the exact tarball digest",
      })
    }
  })
export type NpmReleasePromotionRecord = z.infer<typeof NpmReleasePromotionRecordSchema>

export type NpmPromotionCandidateBinding = {
  readonly package: z.infer<typeof NpmReleasePackageIdentitySchema>
  readonly source: z.infer<typeof NpmReleaseSourceSchema>
  readonly artifact: z.infer<typeof NpmReleaseArtifactBindingSchema>
  readonly support: z.infer<typeof NpmReleaseSupportBindingSchema>
  readonly releaseCandidate: {
    readonly receipt: z.infer<typeof StandaloneCandidateReceiptBindingSchema>
    readonly promotionCandidate: PromotionCandidateReceiptBinding
  }
  readonly publishedAt: string
  readonly now: string
}

function sameFile(left: NpmReleaseBoundFile, right: NpmReleaseBoundFile): boolean {
  return (
    left.path === right.path && left.sha256 === right.sha256 && left.sizeBytes === right.sizeBytes
  )
}

export function assertNpmReleasePromotionBinding(
  raw: unknown,
  candidate: NpmPromotionCandidateBinding,
): NpmReleasePromotionRecord {
  const record = NpmReleasePromotionRecordSchema.parse(raw)
  const boundCandidate = {
    package: NpmReleasePackageIdentitySchema.parse(candidate.package),
    source: NpmReleaseSourceSchema.parse(candidate.source),
    artifact: NpmReleaseArtifactBindingSchema.parse(candidate.artifact),
    support: NpmReleaseSupportBindingSchema.parse(candidate.support),
    releaseCandidate: {
      receipt: StandaloneCandidateReceiptBindingSchema.parse(candidate.releaseCandidate.receipt),
      promotionCandidate: PromotionCandidateReceiptBindingSchema.parse(
        candidate.releaseCandidate.promotionCandidate,
      ),
    },
    publishedAt: z.iso.datetime({ offset: true }).parse(candidate.publishedAt),
    now: z.iso.datetime({ offset: true }).parse(candidate.now),
  }
  if (
    record.package.name !== boundCandidate.package.name ||
    record.package.version !== boundCandidate.package.version ||
    record.package.channel !== boundCandidate.package.channel ||
    record.package.distTag !== boundCandidate.package.distTag ||
    record.source.repository !== boundCandidate.source.repository ||
    record.source.commit !== boundCandidate.source.commit ||
    record.source.fingerprintSha256 !== boundCandidate.source.fingerprintSha256 ||
    !sameFile(record.artifact.tarball, boundCandidate.artifact.tarball) ||
    !sameFile(record.artifact.packageManifest, boundCandidate.artifact.packageManifest) ||
    !sameFile(record.artifact.bundle, boundCandidate.artifact.bundle) ||
    !sameFile(record.artifact.buildMetadata, boundCandidate.artifact.buildMetadata) ||
    !sameFile(record.artifact.checksums, boundCandidate.artifact.checksums) ||
    !sameFile(record.support.sbom, boundCandidate.support.sbom) ||
    !sameFile(record.support.provenance, boundCandidate.support.provenance) ||
    !sameFile(record.support.license, boundCandidate.support.license) ||
    !sameFile(record.support.thirdPartyNotices, boundCandidate.support.thirdPartyNotices) ||
    record.releaseCandidateReceipt.subject !== boundCandidate.releaseCandidate.receipt.subject ||
    record.releaseCandidateReceipt.path !== boundCandidate.releaseCandidate.receipt.path ||
    record.releaseCandidateReceipt.sha256 !== boundCandidate.releaseCandidate.receipt.sha256 ||
    record.releaseCandidateReceipt.sizeBytes !== boundCandidate.releaseCandidate.receipt.sizeBytes
  ) {
    throw new Error("npm promotion record does not bind the exact package candidate")
  }
  assertReleasePromotionBinding(record.releasePromotion, {
    ...boundCandidate.releaseCandidate.promotionCandidate,
    now: boundCandidate.now,
  })
  const recordedAt = Date.parse(record.recordedAt)
  const publishedAt = Date.parse(boundCandidate.publishedAt)
  const now = Date.parse(boundCandidate.now)
  if (
    !Number.isFinite(recordedAt) ||
    !Number.isFinite(publishedAt) ||
    !Number.isFinite(now) ||
    recordedAt > publishedAt ||
    recordedAt > now ||
    publishedAt < now + 1_000 ||
    publishedAt > now + 5 * 60_000
  ) {
    throw new Error("npm promotion/publication timestamps are out of policy order")
  }
  if (Date.parse(record.releasePromotion.recordedAt) > recordedAt) {
    throw new Error("Base release promotion cannot postdate the npm promotion record")
  }
  for (const reviewer of record.reviewers) {
    const reviewedAt = Date.parse(reviewer.reviewedAt)
    if (reviewedAt > recordedAt || reviewedAt > now) {
      throw new Error(`npm promotion reviewer timestamp exceeds the record: ${reviewer.id}`)
    }
  }
  for (const attestation of record.attestations) {
    const attestedAt = Date.parse(attestation.recordedAt)
    if (attestedAt > recordedAt || attestedAt > now) {
      throw new Error(`npm promotion attestation timestamp exceeds the record: ${attestation.id}`)
    }
  }
  return record
}

export const NpmReleaseSignatureSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("unavailable"),
      reason: canonicalTextSchema(1_000),
    })
    .strict(),
  z
    .object({
      status: z.literal("present"),
      kind: ReleaseSignatureKindSchema,
      identity: SignatureIdentitySchema,
      signedBindingSha256: Sha256Schema,
      payload: z
        .object({
          path: PortableRelativePathSchema,
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
export type NpmReleaseSignature = z.infer<typeof NpmReleaseSignatureSchema>

export const NpmReleaseBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("ralph-next"),
    subject: z.literal("npm-package"),
    package: NpmReleasePackageIdentitySchema,
    publishedAt: z.iso.datetime({ offset: true }),
    source: NpmReleaseSourceSchema,
    artifact: NpmReleaseArtifactBindingSchema,
    support: NpmReleaseSupportBindingSchema,
    evidence: z.discriminatedUnion("status", [
      z.object({ status: z.literal("packaged-not-tested") }).strict(),
      z
        .object({
          status: z.literal("packaged-tested"),
          promotion: NpmReleaseBoundFileSchema,
          releaseCandidateReceipt: NpmReleaseBoundFileSchema,
        })
        .strict(),
    ]),
    signature: NpmReleaseSignatureSchema,
  })
  .strict()
  .superRefine((binding, context) => {
    if (binding.package.channel === "stable") {
      if (binding.evidence.status !== "packaged-tested") {
        context.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "Stable npm packages require exact tested promotion evidence",
        })
      }
      if (binding.signature.status !== "present") {
        context.addIssue({
          code: "custom",
          path: ["signature"],
          message: "Stable npm packages require a detached binding signature",
        })
      }
    }
    if (
      (binding.package.channel === "dev" || binding.package.channel === "nightly") &&
      binding.evidence.status === "packaged-tested"
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "npm promotion evidence is accepted only for beta or stable",
      })
    }
    const paths = [
      binding.artifact.tarball.path,
      binding.artifact.packageManifest.path,
      binding.artifact.bundle.path,
      binding.artifact.buildMetadata.path,
      binding.artifact.checksums.path,
      binding.support.sbom.path,
      binding.support.provenance.path,
      binding.support.license.path,
      binding.support.thirdPartyNotices.path,
      ...(binding.evidence.status === "packaged-tested"
        ? [binding.evidence.promotion.path, binding.evidence.releaseCandidateReceipt.path]
        : []),
      ...(binding.signature.status === "present" ? [binding.signature.payload.path] : []),
    ]
    const folded = paths.map((path) => path.normalize("NFC").toLocaleLowerCase("und"))
    if (new Set(folded).size !== folded.length) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "npm release binding paths collide cross-platform",
      })
    }
  })
export type NpmReleaseBinding = z.infer<typeof NpmReleaseBindingSchema>

export function canonicalNpmReleaseBindingSigningBytes(raw: NpmReleaseBinding): Uint8Array {
  const binding = NpmReleaseBindingSchema.parse(raw)
  if (binding.signature.status !== "present") {
    throw new Error("An unsigned npm release binding has no signing projection")
  }
  const projection = {
    ...binding,
    signature: {
      status: binding.signature.status,
      kind: binding.signature.kind,
      identity: binding.signature.identity,
      payload: binding.signature.payload,
    },
  }
  return new TextEncoder().encode(canonicalReleaseJson(projection))
}

export function npmReleaseBindingSigningSha256(raw: NpmReleaseBinding): string {
  return createHash("sha256").update(canonicalNpmReleaseBindingSigningBytes(raw)).digest("hex")
}

export function assertNpmReleaseBinding(raw: unknown): NpmReleaseBinding {
  const binding = NpmReleaseBindingSchema.parse(raw)
  if (
    binding.signature.status === "present" &&
    binding.signature.signedBindingSha256 !== npmReleaseBindingSigningSha256(binding)
  ) {
    throw new Error("npm release binding signature digest does not match its canonical projection")
  }
  return binding
}
