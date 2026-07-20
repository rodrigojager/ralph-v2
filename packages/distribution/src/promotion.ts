import { z } from "zod"
import {
  ReleasePayloadSchema,
  type ReleaseSupportPolicy,
  ReleaseSupportPolicySchema,
  type ReleaseTarget,
  ReleaseTargetSchema,
  releasePathCollisionKey,
  releaseSupportPolicySha256,
} from "./contracts"

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u)
const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u)
const RequirementIdSchema = z.string().regex(/^R(?:00[1-9]|0[1-6]\d|07[0-9])$/u)
const EvidenceIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u)
const IdentityIdSchema = EvidenceIdSchema

function containsC0OrDeleteControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

const IdentityTextSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value === value.trim() &&
      value === value.normalize("NFC") &&
      !containsC0OrDeleteControl(value),
    "Promotion identity text must be trimmed canonical NFC without controls",
  )
const ArtifactReferenceNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value === value.trim() &&
      value === value.normalize("NFC") &&
      !containsC0OrDeleteControl(value),
    "Promotion artifact reference names must be trimmed canonical NFC without controls",
  )

const PROMOTION_GATE_NAMES = [
  "commandAuthority",
  "secretsAndSecurity",
  "crashResumeAndWatchdog",
  "compatibilityAndMigration",
  "tuiAndHeadless",
  "skill",
  "licenseSbomAndProvenance",
  "installUpdateRollbackUninstall",
] as const
const PromotionGateNameSchema = z.enum(PROMOTION_GATE_NAMES)
type PromotionGateName = z.infer<typeof PromotionGateNameSchema>

export const PromotionEvidenceKindSchema = z.enum([
  "source-review",
  "unit",
  "property",
  "integration",
  "e2e",
  "kill-resume",
  "watchdog",
  "security",
  "pty",
  "performance",
  "compatibility",
  "platform",
  "real-provider-smoke",
  "install-drill",
  "skill-forward-test",
  "license-sbom",
])
export type PromotionEvidenceKind = z.infer<typeof PromotionEvidenceKindSchema>

export const PromotionAttestationSchema = z
  .object({
    id: EvidenceIdSchema,
    kind: PromotionEvidenceKindSchema,
    status: z.literal("pass"),
    subjectSha256: Sha256Schema,
    environment: z
      .object({
        os: z.enum(["windows", "linux", "macos", "agnostic"]),
        architecture: z.enum(["x64", "arm64", "agnostic"]),
        runner: z.string().min(1).max(500),
        isolation: z.enum(["none", "process", "container", "vm", "host"]),
      })
      .strict(),
    issuer: z
      .object({
        reviewerId: IdentityIdSchema,
        role: IdentityTextSchema,
      })
      .strict(),
    recordedAt: z.iso.datetime({ offset: true }),
    summary: z.string().min(1).max(2_000),
    claims: z
      .object({
        requirements: z.array(RequirementIdSchema).max(79),
        gates: z.array(PromotionGateNameSchema).max(PROMOTION_GATE_NAMES.length),
        targets: z.array(ReleaseTargetSchema).max(ReleaseTargetSchema.options.length),
      })
      .strict()
      .refine(
        (claims) => claims.requirements.length + claims.gates.length + claims.targets.length > 0,
        "Promotion attestations must explicitly declare at least one claim",
      ),
    artifactRefs: z
      .array(
        z
          .object({
            name: ArtifactReferenceNameSchema,
            sha256: Sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((attestation, context) => {
    for (const field of ["requirements", "gates", "targets"] as const) {
      const values = attestation.claims[field]
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: ["claims", field],
          message: `Duplicate promotion claim in ${field}`,
        })
      }
    }
    const artifactRefKeys = attestation.artifactRefs.map(
      (reference) => `${reference.name}\u0000${reference.sha256}`,
    )
    if (new Set(artifactRefKeys).size !== artifactRefKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["artifactRefs"],
        message: "Duplicate promotion artifact reference",
      })
    }
  })
export type PromotionAttestation = z.infer<typeof PromotionAttestationSchema>

const PassedRequirementSchema = z
  .object({
    id: RequirementIdSchema,
    status: z.literal("pass"),
    evidence: z.array(EvidenceIdSchema).min(1).max(8),
  })
  .strict()

const WaivedRequirementSchema = z
  .object({
    id: RequirementIdSchema,
    status: z.literal("waived"),
    evidence: z.array(EvidenceIdSchema).min(1).max(8),
    waiver: z
      .object({
        ownerId: IdentityIdSchema,
        approverReviewerId: IdentityIdSchema,
        reason: z.string().min(1).max(2_000),
        approvedAt: z.iso.datetime({ offset: true }),
        expiresAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  })
  .strict()

const RequirementPromotionSchema = z.discriminatedUnion("status", [
  PassedRequirementSchema,
  WaivedRequirementSchema,
])

const GateEvidenceSchema = z
  .object({
    status: z.literal("pass"),
    evidence: z.array(EvidenceIdSchema).min(1).max(16),
  })
  .strict()

export const PromotionTargetBindingSchema = z
  .object({
    target: ReleaseTargetSchema,
    status: z.literal("tested"),
    engineSha256: Sha256Schema,
    launcherSha256: Sha256Schema,
    buildMetadataSha256: Sha256Schema,
    launcherBuildMetadataSha256: Sha256Schema,
    archiveSha256: Sha256Schema,
    environment: z
      .object({
        os: z.enum(["windows", "linux", "macos"]),
        architecture: z.enum(["x64", "arm64"]),
        runner: z.string().min(1).max(500),
      })
      .strict(),
    runtimeEvidence: z.array(EvidenceIdSchema).min(1).max(16),
    packageEvidence: z.array(EvidenceIdSchema).min(1).max(16),
  })
  .strict()
export type PromotionTargetBinding = z.infer<typeof PromotionTargetBindingSchema>

export const PromotionSupportBindingSchema = z
  .object({
    licenseSha256: Sha256Schema,
    thirdPartyNoticesSha256: Sha256Schema,
    sbomSha256: Sha256Schema,
    skillArtifactSha256: Sha256Schema,
    supportPolicySha256: Sha256Schema,
  })
  .strict()
export type PromotionSupportBinding = z.infer<typeof PromotionSupportBindingSchema>

export const PromotionCandidateTargetBindingSchema = z
  .object({
    target: ReleaseTargetSchema,
    engineSha256: Sha256Schema,
    launcherSha256: Sha256Schema,
    buildMetadataSha256: Sha256Schema,
    launcherBuildMetadataSha256: Sha256Schema,
    archiveSha256: Sha256Schema,
  })
  .strict()
export type PromotionCandidateTargetBinding = z.infer<typeof PromotionCandidateTargetBindingSchema>

export const PromotionCandidateReceiptBindingSchema = z
  .object({
    version: SemverSchema,
    channel: z.enum(["beta", "stable"]),
    repository: z.url().refine((value) => {
      const url = new URL(value)
      return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
    }),
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
    sourceFingerprintSha256: Sha256Schema,
    support: PromotionSupportBindingSchema,
    supportPolicy: ReleaseSupportPolicySchema,
    targets: z.array(PromotionCandidateTargetBindingSchema).min(1).max(6),
    publishedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      candidate.supportPolicy.version !== candidate.version ||
      candidate.supportPolicy.channel !== candidate.channel
    ) {
      context.addIssue({
        code: "custom",
        path: ["supportPolicy"],
        message: "Standalone candidate support policy must bind its version and channel",
      })
    }
    const policySha256 = releaseSupportPolicySha256(candidate.supportPolicy)
    if (candidate.support.supportPolicySha256 !== policySha256) {
      context.addIssue({
        code: "custom",
        path: ["support", "supportPolicySha256"],
        message: "Standalone candidate support-policy digest is inconsistent",
      })
    }
    const includedTargets = candidate.supportPolicy.matrix
      .filter((entry) => entry.status === "included")
      .map((entry) => entry.target)
    if (
      candidate.targets.length !== includedTargets.length ||
      candidate.targets.some((target, index) => target.target !== includedTargets[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Standalone candidate targets must equal the canonical included support matrix",
      })
    }
  })
export type PromotionCandidateReceiptBinding = z.infer<
  typeof PromotionCandidateReceiptBindingSchema
>

const StandaloneCandidateTargetFilesSchema = z
  .object({
    target: ReleaseTargetSchema,
    evidenceStatus: z.literal("built-not-tested"),
    launcher: ReleasePayloadSchema,
    executable: ReleasePayloadSchema,
    buildMetadata: ReleasePayloadSchema,
    launcherBuildMetadata: ReleasePayloadSchema,
    archive: ReleasePayloadSchema,
    limitations: z.array(z.string().min(1).max(2_000)).max(64),
  })
  .strict()

export const StandaloneReleaseCandidateReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.literal("ralph-next"),
    subject: z.literal("standalone-release-candidate"),
    status: z.literal("candidate-only"),
    publishable: z.literal(false),
    reason: z
      .string()
      .min(1)
      .max(2_000)
      .refine(
        (value) =>
          value === value.trim() &&
          value === value.normalize("NFC") &&
          !containsC0OrDeleteControl(value),
        "Standalone candidate reason must be canonical bounded text",
      ),
    promotionCandidate: PromotionCandidateReceiptBindingSchema,
    files: z
      .object({
        license: ReleasePayloadSchema,
        thirdPartyNotices: ReleasePayloadSchema,
        sbom: ReleasePayloadSchema,
        skill: ReleasePayloadSchema,
        checksums: ReleasePayloadSchema,
        targets: z.array(StandaloneCandidateTargetFilesSchema).min(1).max(6),
      })
      .strict(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const candidate = receipt.promotionCandidate
    const supportFiles = receipt.files
    for (const [field, actualSha256, expectedSha256] of [
      ["license", supportFiles.license.sha256, candidate.support.licenseSha256],
      [
        "thirdPartyNotices",
        supportFiles.thirdPartyNotices.sha256,
        candidate.support.thirdPartyNoticesSha256,
      ],
      ["sbom", supportFiles.sbom.sha256, candidate.support.sbomSha256],
      ["skill", supportFiles.skill.sha256, candidate.support.skillArtifactSha256],
    ] as const) {
      if (actualSha256 !== expectedSha256) {
        context.addIssue({
          code: "custom",
          path: ["files", field, "sha256"],
          message: `Standalone candidate ${field} payload does not bind promotionCandidate`,
        })
      }
    }
    if (
      receipt.files.targets.length !== candidate.targets.length ||
      receipt.files.targets.some(
        (target, index) => target.target !== candidate.targets[index]?.target,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["files", "targets"],
        message: "Standalone candidate file targets must match promotionCandidate in order",
      })
    }
    for (const [index, targetFiles] of receipt.files.targets.entries()) {
      const binding = candidate.targets[index]
      if (!binding) continue
      for (const [field, actualSha256, expectedSha256] of [
        ["executable", targetFiles.executable.sha256, binding.engineSha256],
        ["launcher", targetFiles.launcher.sha256, binding.launcherSha256],
        ["buildMetadata", targetFiles.buildMetadata.sha256, binding.buildMetadataSha256],
        [
          "launcherBuildMetadata",
          targetFiles.launcherBuildMetadata.sha256,
          binding.launcherBuildMetadataSha256,
        ],
        ["archive", targetFiles.archive.sha256, binding.archiveSha256],
      ] as const) {
        if (actualSha256 !== expectedSha256) {
          context.addIssue({
            code: "custom",
            path: ["files", "targets", index, field, "sha256"],
            message: `Standalone target payload does not bind promotionCandidate: ${targetFiles.target}/${field}`,
          })
        }
      }
    }
    const payloadPaths = [
      supportFiles.license.path,
      supportFiles.thirdPartyNotices.path,
      supportFiles.sbom.path,
      supportFiles.skill.path,
      supportFiles.checksums.path,
      ...supportFiles.targets.flatMap((target) => [
        target.launcher.path,
        target.executable.path,
        target.buildMetadata.path,
        target.launcherBuildMetadata.path,
        target.archive.path,
      ]),
    ]
    if (new Set(payloadPaths.map(releasePathCollisionKey)).size !== payloadPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Standalone candidate payload paths collide cross-platform",
      })
    }
  })
export type StandaloneReleaseCandidateReceipt = z.infer<
  typeof StandaloneReleaseCandidateReceiptSchema
>

export const ReleasePromotionRecordSchema = z
  .object({
    schemaVersion: z.literal(3),
    product: z.literal("ralph-next"),
    version: SemverSchema,
    channel: z.enum(["beta", "stable"]),
    source: z
      .object({
        repository: z.url().refine((value) => {
          const url = new URL(value)
          return (
            url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
          )
        }),
        commit: z.string().regex(/^[0-9a-f]{40}$/u),
        fingerprintSha256: Sha256Schema,
      })
      .strict(),
    support: PromotionSupportBindingSchema,
    recordedAt: z.iso.datetime({ offset: true }),
    attestations: z.array(PromotionAttestationSchema).min(1).max(512),
    requirements: z.array(RequirementPromotionSchema).length(79),
    targets: z.array(PromotionTargetBindingSchema).min(1).max(6),
    gates: z
      .object({
        commandAuthority: GateEvidenceSchema,
        secretsAndSecurity: GateEvidenceSchema,
        crashResumeAndWatchdog: GateEvidenceSchema,
        compatibilityAndMigration: GateEvidenceSchema,
        tuiAndHeadless: GateEvidenceSchema,
        skill: GateEvidenceSchema,
        licenseSbomAndProvenance: GateEvidenceSchema,
        installUpdateRollbackUninstall: GateEvidenceSchema,
      })
      .strict(),
    reviewers: z
      .array(
        z
          .object({
            id: IdentityIdSchema,
            name: IdentityTextSchema,
            role: IdentityTextSchema,
            reviewedAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    limitations: z.array(z.string().min(1).max(2_000)).max(64),
  })
  .strict()
  .superRefine((record, context) => {
    const attestationIds = new Set<string>()
    const attestationsById = new Map<string, PromotionAttestation>()
    for (const [index, attestation] of record.attestations.entries()) {
      if (attestationIds.has(attestation.id)) {
        context.addIssue({
          code: "custom",
          path: ["attestations", index, "id"],
          message: `Duplicate promotion attestation: ${attestation.id}`,
        })
      }
      attestationIds.add(attestation.id)
      attestationsById.set(attestation.id, attestation)
    }
    const requirements = new Set<string>()
    for (const [index, requirement] of record.requirements.entries()) {
      if (requirements.has(requirement.id)) {
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "id"],
          message: `Duplicate promotion requirement: ${requirement.id}`,
        })
      }
      requirements.add(requirement.id)
      if (new Set(requirement.evidence).size !== requirement.evidence.length) {
        context.addIssue({
          code: "custom",
          path: ["requirements", index, "evidence"],
          message: `Duplicate evidence reference for requirement: ${requirement.id}`,
        })
      }
      for (const [evidenceIndex, evidence] of requirement.evidence.entries()) {
        if (!attestationIds.has(evidence)) {
          context.addIssue({
            code: "custom",
            path: ["requirements", index, "evidence", evidenceIndex],
            message: `Unknown promotion attestation: ${evidence}`,
          })
        } else if (!attestationsById.get(evidence)?.claims.requirements.includes(requirement.id)) {
          context.addIssue({
            code: "custom",
            path: ["requirements", index, "evidence", evidenceIndex],
            message: `Promotion attestation does not claim requirement ${requirement.id}: ${evidence}`,
          })
        }
      }
    }
    const targets = new Set<string>()
    for (const [index, target] of record.targets.entries()) {
      if (targets.has(target.target)) {
        context.addIssue({
          code: "custom",
          path: ["targets", index, "target"],
          message: `Duplicate promoted target: ${target.target}`,
        })
      }
      targets.add(target.target)
      for (const [field, evidence] of [
        ["runtimeEvidence", target.runtimeEvidence],
        ["packageEvidence", target.packageEvidence],
      ] as const) {
        if (new Set(evidence).size !== evidence.length) {
          context.addIssue({
            code: "custom",
            path: ["targets", index, field],
            message: `Duplicate ${field} reference for target: ${target.target}`,
          })
        }
        for (const [evidenceIndex, id] of evidence.entries()) {
          if (!attestationIds.has(id)) {
            context.addIssue({
              code: "custom",
              path: ["targets", index, field, evidenceIndex],
              message: `Unknown promotion attestation: ${id}`,
            })
          } else if (!attestationsById.get(id)?.claims.targets.includes(target.target)) {
            context.addIssue({
              code: "custom",
              path: ["targets", index, field, evidenceIndex],
              message: `Promotion attestation does not claim target ${target.target}: ${id}`,
            })
          }
        }
      }
    }
    for (const [gateName, gate] of Object.entries(record.gates)) {
      if (new Set(gate.evidence).size !== gate.evidence.length) {
        context.addIssue({
          code: "custom",
          path: ["gates", gateName, "evidence"],
          message: `Duplicate evidence reference for gate: ${gateName}`,
        })
      }
      for (const [evidenceIndex, evidence] of gate.evidence.entries()) {
        if (!attestationIds.has(evidence)) {
          context.addIssue({
            code: "custom",
            path: ["gates", gateName, "evidence", evidenceIndex],
            message: `Unknown promotion attestation: ${evidence}`,
          })
        } else if (
          !attestationsById.get(evidence)?.claims.gates.includes(gateName as PromotionGateName)
        ) {
          context.addIssue({
            code: "custom",
            path: ["gates", gateName, "evidence", evidenceIndex],
            message: `Promotion attestation does not claim gate ${gateName}: ${evidence}`,
          })
        }
      }
    }
  })
export type ReleasePromotionRecord = z.infer<typeof ReleasePromotionRecordSchema>

export interface PromotionCandidateBinding {
  readonly version: string
  readonly channel: "beta" | "stable"
  readonly repository: string
  readonly commit: string
  readonly sourceFingerprintSha256: string
  readonly support: PromotionSupportBinding
  readonly supportPolicy: ReleaseSupportPolicy
  readonly targets: readonly Omit<
    PromotionTargetBinding,
    "status" | "environment" | "runtimeEvidence" | "packageEvidence"
  >[]
  readonly publishedAt: string
  readonly now: string
}

const CRITICAL_REQUIREMENTS = new Set([
  "R001",
  "R002",
  "R004",
  "R006",
  "R014",
  "R019",
  "R020",
  "R021",
  "R022",
  "R023",
  "R024",
  "R025",
  "R027",
  "R030",
  "R031",
  "R032",
  "R033",
  "R034",
  "R035",
  "R041",
  "R042",
  "R043",
  "R049",
  "R058",
  "R060",
  "R061",
  "R062",
  "R063",
  "R064",
  "R065",
  "R066",
  "R067",
  "R069",
  "R070",
  "R071",
  "R075",
  "R076",
  "R077",
  "R078",
  "R079",
])

const TARGET_ENVIRONMENT: Readonly<
  Record<ReleaseTarget, { os: "windows" | "linux" | "macos"; architecture: "x64" | "arm64" }>
> = {
  "bun-windows-x64-baseline": { os: "windows", architecture: "x64" },
  "bun-windows-arm64": { os: "windows", architecture: "arm64" },
  "bun-linux-x64-baseline": { os: "linux", architecture: "x64" },
  "bun-linux-arm64": { os: "linux", architecture: "arm64" },
  "bun-darwin-x64": { os: "macos", architecture: "x64" },
  "bun-darwin-arm64": { os: "macos", architecture: "arm64" },
}

const GATE_EVIDENCE_KINDS: Readonly<Record<PromotionGateName, ReadonlySet<PromotionEvidenceKind>>> =
  {
    commandAuthority: new Set(["source-review", "integration", "e2e"]),
    secretsAndSecurity: new Set(["security"]),
    crashResumeAndWatchdog: new Set(["kill-resume", "watchdog"]),
    compatibilityAndMigration: new Set(["compatibility"]),
    tuiAndHeadless: new Set(["pty", "e2e"]),
    skill: new Set(["skill-forward-test"]),
    licenseSbomAndProvenance: new Set(["license-sbom"]),
    installUpdateRollbackUninstall: new Set(["install-drill"]),
  }

type RequirementSubjectKind = "candidate-source" | "target-archive" | "skill-artifact" | "sbom"
type RequirementEvidencePolicy = {
  readonly kinds: ReadonlySet<PromotionEvidenceKind>
  readonly subjects: ReadonlySet<RequirementSubjectKind>
}

const REQUIREMENT_EVIDENCE_POLICIES = new Map<string, RequirementEvidencePolicy>()

function requirementRange(first: number, last: number): string[] {
  return Array.from(
    { length: last - first + 1 },
    (_, offset) => `R${String(first + offset).padStart(3, "0")}`,
  )
}

function registerRequirementPolicy(
  ids: readonly string[],
  kinds: readonly PromotionEvidenceKind[],
  subjects: readonly RequirementSubjectKind[],
): void {
  for (const id of ids) {
    if (REQUIREMENT_EVIDENCE_POLICIES.has(id)) {
      throw new Error(`Duplicate promotion requirement evidence policy: ${id}`)
    }
    REQUIREMENT_EVIDENCE_POLICIES.set(id, {
      kinds: new Set(kinds),
      subjects: new Set(subjects),
    })
  }
}

registerRequirementPolicy(
  ["R001"],
  ["source-review", "integration", "e2e", "security"],
  ["candidate-source", "target-archive"],
)
registerRequirementPolicy(["R002"], ["integration", "e2e", "security"], ["target-archive"])
registerRequirementPolicy(["R003"], ["source-review", "license-sbom"], ["candidate-source", "sbom"])
registerRequirementPolicy(["R004"], ["source-review", "security"], ["candidate-source"])
registerRequirementPolicy(
  ["R005"],
  ["source-review", "compatibility", "integration"],
  ["candidate-source", "target-archive"],
)
registerRequirementPolicy(
  requirementRange(6, 9),
  ["integration", "e2e", "real-provider-smoke", "security"],
  ["target-archive"],
)
registerRequirementPolicy(
  ["R010"],
  ["skill-forward-test", "e2e"],
  ["skill-artifact", "target-archive"],
)
registerRequirementPolicy(["R011"], ["e2e"], ["target-archive"])
registerRequirementPolicy(["R012"], ["integration", "e2e"], ["target-archive"])
registerRequirementPolicy(
  ["R013"],
  ["source-review", "skill-forward-test"],
  ["candidate-source", "skill-artifact"],
)
registerRequirementPolicy(
  ["R014"],
  ["unit", "property", "integration"],
  ["candidate-source", "target-archive"],
)
registerRequirementPolicy(["R015"], ["source-review", "unit", "property"], ["candidate-source"])
registerRequirementPolicy(["R016"], ["unit", "property"], ["candidate-source", "target-archive"])
registerRequirementPolicy(["R017"], ["compatibility", "integration"], ["target-archive"])
registerRequirementPolicy(["R018"], ["integration", "e2e"], ["target-archive"])
registerRequirementPolicy(
  ["R019"],
  ["source-review", "security", "skill-forward-test"],
  ["candidate-source", "skill-artifact"],
)
registerRequirementPolicy(["R020"], ["integration", "e2e"], ["target-archive"])
registerRequirementPolicy(
  requirementRange(21, 26),
  ["integration", "e2e", "kill-resume", "watchdog"],
  ["target-archive"],
)
registerRequirementPolicy(
  requirementRange(27, 35),
  ["unit", "property", "integration", "e2e"],
  ["target-archive"],
)
registerRequirementPolicy(["R036"], ["compatibility", "integration"], ["target-archive"])
registerRequirementPolicy(["R037"], ["integration", "e2e", "watchdog"], ["target-archive"])
registerRequirementPolicy(
  requirementRange(38, 40),
  ["unit", "integration", "skill-forward-test"],
  ["candidate-source", "skill-artifact", "target-archive"],
)
registerRequirementPolicy(["R041"], ["watchdog", "kill-resume"], ["target-archive"])
registerRequirementPolicy(["R042"], ["watchdog", "performance"], ["target-archive"])
registerRequirementPolicy(["R043"], ["watchdog", "kill-resume", "e2e"], ["target-archive"])
registerRequirementPolicy(["R044"], ["pty", "e2e"], ["target-archive"])
registerRequirementPolicy(
  ["R045"],
  ["integration", "e2e", "real-provider-smoke"],
  ["target-archive"],
)
registerRequirementPolicy(requirementRange(46, 54), ["pty", "property", "e2e"], ["target-archive"])
registerRequirementPolicy(
  ["R055"],
  ["pty", "source-review"],
  ["candidate-source", "target-archive"],
)
registerRequirementPolicy(["R056"], ["compatibility", "integration"], ["target-archive"])
registerRequirementPolicy(["R057"], ["integration", "e2e"], ["target-archive"])
registerRequirementPolicy(["R058"], ["kill-resume", "e2e"], ["target-archive"])
registerRequirementPolicy(
  ["R059"],
  ["integration", "e2e", "real-provider-smoke"],
  ["target-archive"],
)
registerRequirementPolicy(
  ["R060"],
  ["source-review", "security", "e2e"],
  ["candidate-source", "target-archive"],
)
registerRequirementPolicy(requirementRange(61, 63), ["integration", "e2e"], ["target-archive"])
registerRequirementPolicy(["R064"], ["security", "integration"], ["target-archive"])
registerRequirementPolicy(["R065"], ["security"], ["candidate-source", "target-archive"])
registerRequirementPolicy(
  requirementRange(66, 67),
  ["source-review", "security", "license-sbom"],
  ["candidate-source", "sbom"],
)
registerRequirementPolicy(["R068"], ["compatibility"], ["target-archive"])
registerRequirementPolicy(["R069"], ["install-drill", "compatibility"], ["target-archive"])
registerRequirementPolicy(["R070"], ["platform", "install-drill"], ["target-archive"])
registerRequirementPolicy(["R071"], ["integration", "property", "e2e"], ["target-archive"])
registerRequirementPolicy(["R072"], ["performance", "e2e"], ["target-archive"])
registerRequirementPolicy(["R073"], ["pty", "property", "e2e"], ["target-archive"])
registerRequirementPolicy(["R074"], ["source-review"], ["candidate-source"])
registerRequirementPolicy(
  ["R075"],
  ["integration", "security", "e2e"],
  ["candidate-source", "target-archive"],
)
registerRequirementPolicy(
  ["R076"],
  ["source-review", "integration", "e2e", "security"],
  ["candidate-source", "target-archive"],
)
registerRequirementPolicy(
  ["R077"],
  ["source-review", "integration", "e2e", "security"],
  ["candidate-source", "target-archive"],
)
registerRequirementPolicy(
  ["R078"],
  ["unit", "property", "integration", "e2e", "security"],
  ["candidate-source", "target-archive"],
)
registerRequirementPolicy(
  ["R079"],
  ["integration", "e2e", "security"],
  ["candidate-source", "target-archive"],
)

if (REQUIREMENT_EVIDENCE_POLICIES.size !== 79) {
  throw new Error("Promotion evidence policy must cover R001 through R079 exactly once")
}

function sameSupport(left: PromotionSupportBinding, right: PromotionSupportBinding): boolean {
  return (
    left.licenseSha256 === right.licenseSha256 &&
    left.thirdPartyNoticesSha256 === right.thirdPartyNoticesSha256 &&
    left.sbomSha256 === right.sbomSha256 &&
    left.skillArtifactSha256 === right.skillArtifactSha256 &&
    left.supportPolicySha256 === right.supportPolicySha256
  )
}

export function assertReleasePromotionBinding(
  rawRecord: unknown,
  candidate: PromotionCandidateBinding,
): ReleasePromotionRecord {
  const record = ReleasePromotionRecordSchema.parse(rawRecord)
  const supportPolicy = ReleaseSupportPolicySchema.parse(candidate.supportPolicy)
  const supportPolicySha256 = releaseSupportPolicySha256(supportPolicy)
  const policyIncludedTargets = supportPolicy.matrix
    .filter((entry) => entry.status === "included")
    .map((entry) => entry.target)
  const policyIncludedTargetSet = new Set<ReleaseTarget>(policyIncludedTargets)
  if (
    record.version !== candidate.version ||
    record.channel !== candidate.channel ||
    supportPolicy.version !== candidate.version ||
    supportPolicy.channel !== candidate.channel ||
    candidate.support.supportPolicySha256 !== supportPolicySha256 ||
    record.source.repository !== candidate.repository ||
    record.source.commit !== candidate.commit ||
    record.source.fingerprintSha256 !== candidate.sourceFingerprintSha256 ||
    !sameSupport(record.support, candidate.support)
  ) {
    throw new Error("Promotion record does not bind the release source, support files or channel")
  }
  const expectedRequirements = new Set(
    Array.from({ length: 79 }, (_, index) => `R${String(index + 1).padStart(3, "0")}`),
  )
  for (const requirement of record.requirements) expectedRequirements.delete(requirement.id)
  if (expectedRequirements.size > 0) {
    throw new Error(`Promotion record omits requirements: ${[...expectedRequirements].join(", ")}`)
  }

  const publishedAt = Date.parse(candidate.publishedAt)
  const now = Date.parse(candidate.now)
  const recordedAt = Date.parse(record.recordedAt)
  if (
    !Number.isFinite(publishedAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(recordedAt) ||
    recordedAt > publishedAt ||
    recordedAt > now ||
    publishedAt < now + 1_000 ||
    publishedAt > now + 5 * 60_000
  ) {
    throw new Error("Promotion record/publication timestamps are out of policy order")
  }
  const reviewerIds = new Set<string>()
  const reviewerNames = new Set<string>()
  const reviewersById = new Map(record.reviewers.map((reviewer) => [reviewer.id, reviewer]))
  for (const reviewer of record.reviewers) {
    const normalizedName = reviewer.name.toLowerCase()
    if (reviewerIds.has(reviewer.id) || reviewerNames.has(normalizedName)) {
      throw new Error(`Duplicate promotion reviewer identity: ${reviewer.id}`)
    }
    reviewerIds.add(reviewer.id)
    reviewerNames.add(normalizedName)
    const reviewedAt = Date.parse(reviewer.reviewedAt)
    if (reviewedAt > recordedAt || reviewedAt > now) {
      throw new Error(`Promotion reviewer timestamp exceeds the record: ${reviewer.name}`)
    }
  }
  if (record.channel === "stable" && reviewerIds.size < 2) {
    throw new Error("Stable promotion requires at least two distinct reviewers")
  }
  for (const requirement of record.requirements) {
    if (requirement.status !== "waived") continue
    if (record.channel === "stable" && CRITICAL_REQUIREMENTS.has(requirement.id)) {
      throw new Error(`Critical stable requirement cannot be waived: ${requirement.id}`)
    }
    if (
      requirement.waiver.ownerId === requirement.waiver.approverReviewerId ||
      !reviewerIds.has(requirement.waiver.approverReviewerId)
    ) {
      throw new Error(`Promotion waiver lacks an independent reviewer: ${requirement.id}`)
    }
    const approvedAt = Date.parse(requirement.waiver.approvedAt)
    const expiresAt = Date.parse(requirement.waiver.expiresAt)
    const approver = reviewersById.get(requirement.waiver.approverReviewerId)
    if (
      !approver ||
      Date.parse(approver.reviewedAt) < approvedAt ||
      approvedAt > recordedAt ||
      approvedAt > now ||
      expiresAt <= publishedAt ||
      expiresAt <= now
    ) {
      throw new Error(`Promotion waiver timestamps are invalid or expired: ${requirement.id}`)
    }
  }

  const attestations = new Map(
    record.attestations.map((attestation) => [attestation.id, attestation]),
  )
  const archiveSubjects = new Set(candidate.targets.map((target) => target.archiveSha256))
  const allowedSubjects = new Set<string>([
    candidate.sourceFingerprintSha256,
    candidate.support.licenseSha256,
    candidate.support.thirdPartyNoticesSha256,
    candidate.support.sbomSha256,
    candidate.support.skillArtifactSha256,
    candidate.support.supportPolicySha256,
    ...candidate.targets.flatMap((target) => [
      target.engineSha256,
      target.launcherSha256,
      target.buildMetadataSha256,
      target.launcherBuildMetadataSha256,
      target.archiveSha256,
    ]),
  ])
  for (const attestation of record.attestations) {
    const issuer = reviewersById.get(attestation.issuer.reviewerId)
    if (!issuer || issuer.role !== attestation.issuer.role) {
      throw new Error(`Promotion attestation issuer is not a reviewer: ${attestation.id}`)
    }
    if (!allowedSubjects.has(attestation.subjectSha256)) {
      throw new Error(`Promotion attestation binds an unknown candidate digest: ${attestation.id}`)
    }
    for (const target of attestation.claims.targets) {
      if (!policyIncludedTargetSet.has(target)) {
        throw new Error(
          `Promotion attestation claims a target not included by support policy: ${attestation.id}/${target}`,
        )
      }
    }
    const attestedAt = Date.parse(attestation.recordedAt)
    if (attestedAt > recordedAt || attestedAt > now || Date.parse(issuer.reviewedAt) < attestedAt) {
      throw new Error(`Promotion attestation timestamp exceeds the record: ${attestation.id}`)
    }
  }
  const latestAttestationTime = Math.max(
    ...record.attestations.map((attestation) => Date.parse(attestation.recordedAt)),
  )
  for (const reviewer of record.reviewers) {
    if (Date.parse(reviewer.reviewedAt) < latestAttestationTime) {
      throw new Error(`Promotion reviewer predates the final evidence set: ${reviewer.id}`)
    }
  }

  const subjectMatchesPolicy = (
    policy: RequirementEvidencePolicy,
    subjectSha256: string,
  ): boolean =>
    (policy.subjects.has("candidate-source") &&
      subjectSha256 === candidate.sourceFingerprintSha256) ||
    (policy.subjects.has("target-archive") && archiveSubjects.has(subjectSha256)) ||
    (policy.subjects.has("skill-artifact") &&
      subjectSha256 === candidate.support.skillArtifactSha256) ||
    (policy.subjects.has("sbom") && subjectSha256 === candidate.support.sbomSha256)

  for (const requirement of record.requirements) {
    const evidence = requirement.evidence.map((id) => {
      const attestation = attestations.get(id)
      if (!attestation)
        throw new Error(`Requirement references unknown evidence: ${requirement.id}/${id}`)
      return attestation
    })
    if (requirement.status === "waived") {
      const hasApprovalEvidence = evidence.some(
        (attestation) =>
          attestation.kind === "source-review" &&
          attestation.subjectSha256 === candidate.sourceFingerprintSha256 &&
          attestation.issuer.reviewerId === requirement.waiver.approverReviewerId &&
          Date.parse(attestation.recordedAt) >= Date.parse(requirement.waiver.approvedAt),
      )
      if (!hasApprovalEvidence) {
        throw new Error(`Promotion waiver lacks source-bound approval evidence: ${requirement.id}`)
      }
      continue
    }
    const policy = REQUIREMENT_EVIDENCE_POLICIES.get(requirement.id)
    if (
      !policy ||
      !evidence.some(
        (attestation) =>
          policy.kinds.has(attestation.kind) &&
          subjectMatchesPolicy(policy, attestation.subjectSha256),
      )
    ) {
      throw new Error(`Promotion requirement lacks policy-compatible evidence: ${requirement.id}`)
    }
  }

  for (const gateName of PROMOTION_GATE_NAMES) {
    const allowedKinds = GATE_EVIDENCE_KINDS[gateName]
    const hasGateSpecificEvidence = record.gates[gateName].evidence.some((id) => {
      const attestation = attestations.get(id)
      if (!attestation || !allowedKinds.has(attestation.kind)) return false
      if (gateName === "skill") {
        return attestation.subjectSha256 === candidate.support.skillArtifactSha256
      }
      if (gateName === "licenseSbomAndProvenance") {
        return attestation.subjectSha256 === candidate.support.sbomSha256
      }
      if (gateName === "commandAuthority" || gateName === "secretsAndSecurity") {
        return (
          attestation.subjectSha256 === candidate.sourceFingerprintSha256 ||
          (gateName === "commandAuthority" && archiveSubjects.has(attestation.subjectSha256))
        )
      }
      return archiveSubjects.has(attestation.subjectSha256)
    })
    if (!hasGateSpecificEvidence) {
      throw new Error(`Promotion gate lacks gate-specific evidence: ${gateName}`)
    }
  }

  const promotedByTarget = new Map(record.targets.map((target) => [target.target, target]))
  const candidateTargetIds = candidate.targets.map((target) => target.target)
  if (new Set(candidate.targets.map((target) => target.target)).size !== candidate.targets.length) {
    throw new Error("Candidate release contains duplicate promotion targets")
  }
  if (
    candidateTargetIds.length !== policyIncludedTargets.length ||
    candidateTargetIds.some((target, index) => target !== policyIncludedTargets[index])
  ) {
    throw new Error("Candidate target set differs from the versioned included support matrix")
  }
  if (promotedByTarget.size !== candidate.targets.length) {
    throw new Error("Promotion record target set differs from the candidate target set")
  }
  if (
    record.targets.length !== candidateTargetIds.length ||
    record.targets.some((target, index) => target.target !== candidateTargetIds[index])
  ) {
    throw new Error("Promotion record targets must follow the canonical included support matrix")
  }
  for (const target of candidate.targets) {
    const promoted = promotedByTarget.get(target.target)
    if (
      !promoted ||
      promoted.engineSha256 !== target.engineSha256 ||
      promoted.launcherSha256 !== target.launcherSha256 ||
      promoted.buildMetadataSha256 !== target.buildMetadataSha256 ||
      promoted.launcherBuildMetadataSha256 !== target.launcherBuildMetadataSha256 ||
      promoted.archiveSha256 !== target.archiveSha256
    ) {
      throw new Error(`Promotion record hashes do not bind target: ${target.target}`)
    }
    const expectedEnvironment = TARGET_ENVIRONMENT[target.target]
    if (
      promoted.environment.os !== expectedEnvironment.os ||
      promoted.environment.architecture !== expectedEnvironment.architecture
    ) {
      throw new Error(`Promotion target environment does not match target: ${target.target}`)
    }
    const packageEvidenceIds = new Set(promoted.packageEvidence)
    if (promoted.runtimeEvidence.some((id) => packageEvidenceIds.has(id))) {
      throw new Error(
        `Promotion target reuses evidence across runtime and package claims: ${target.target}`,
      )
    }
    const targetEvidence = [...promoted.runtimeEvidence, ...promoted.packageEvidence].map((id) => {
      const attestation = attestations.get(id)
      if (!attestation) throw new Error(`Promotion target references unknown evidence: ${id}`)
      if (attestation.subjectSha256 !== target.archiveSha256) {
        throw new Error(
          `Promotion target evidence does not bind its exact archive: ${target.target}/${id}`,
        )
      }
      if (
        attestation.environment.os !== expectedEnvironment.os ||
        attestation.environment.architecture !== expectedEnvironment.architecture ||
        attestation.environment.runner !== promoted.environment.runner
      ) {
        throw new Error(
          `Promotion target evidence environment does not match target: ${target.target}/${id}`,
        )
      }
      return attestation
    })
    const runtimeKinds = new Set<PromotionEvidenceKind>(
      targetEvidence
        .slice(0, promoted.runtimeEvidence.length)
        .map((attestation) => attestation.kind),
    )
    if (
      !(["e2e", "platform", "real-provider-smoke"] as const).some((kind) => runtimeKinds.has(kind))
    ) {
      throw new Error(`Promotion target lacks runtime evidence: ${target.target}`)
    }
    const packageKinds = new Set<PromotionEvidenceKind>(
      targetEvidence.slice(promoted.runtimeEvidence.length).map((attestation) => attestation.kind),
    )
    if (!packageKinds.has("install-drill")) {
      throw new Error(`Promotion target lacks install-drill evidence: ${target.target}`)
    }
  }
  return record
}
