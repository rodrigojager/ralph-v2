import { createHash } from "node:crypto"
import { extname } from "node:path"
import {
  type ArtifactEvidence,
  type ArtifactEvidenceV2,
  ArtifactEvidenceV2Schema,
  type ChangeEvidence,
  ChangeEvidenceSchema,
  type CompletionDecision,
  CompletionDecisionSchema,
  type ContextTask,
  computeEvidenceBundleContentHash,
  type EvidenceAssessmentRef,
  type EvidenceBundle,
  type EvidenceBundleV2,
  EvidenceBundleV2Schema,
  type EvidenceContextBinding,
  type EvidenceLimits,
  type EvidencePriorAttempt,
  type EvidenceProfileSnapshot,
  type EvidenceToolCall,
  type EvidenceTruncation,
  type EvidenceUsage,
  type ExecutorOutcome,
  type GateResult,
  GateResultSchema,
  type GitBaseline,
  GitBaselineSchema,
  type MissingEvidence,
  type NoChangePolicy,
} from "@ralph-next/domain"
import type { PrdTask, VerificationSpec } from "@ralph-next/prd"
import { validateArtifactContract } from "./artifact-contract"
import type { VerificationResult } from "./gates"
import {
  type ContentAddressedStore,
  freezeWorkspaceFile,
  type WorkspaceBaseline,
  type WorkspaceChanges,
} from "./workspace"

export type CompletionEvaluation = {
  decision: CompletionDecision
  retryNoChange: boolean
  overrideUsed: boolean
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function gitBaselineFromWorkspace(value: WorkspaceBaseline): GitBaseline {
  return GitBaselineSchema.parse({
    schemaVersion: 1,
    kind: value.git.available ? "git" : "workspace",
    revision: value.git.head ?? null,
    branch: value.git.branch ?? null,
    dirty: value.git.dirty,
    statusHash: value.git.statusHash ?? value.snapshotHash,
    workspaceSnapshotHash: value.snapshotHash,
    capturedAt: value.capturedAt,
  })
}

export function changeEvidenceFromWorkspace(
  changes: WorkspaceChanges,
  after: WorkspaceBaseline,
  policy: NoChangePolicy,
  binding?: {
    diffHash: string
    diffRef: string
    reproducible: boolean
    missingContent: ChangeEvidence["missingContent"]
  },
): ChangeEvidence {
  const files = changes.changed.map((path) => {
    const current = after.files[path]
    const kind = changes.created.includes(path)
      ? "created"
      : changes.deleted.includes(path)
        ? "deleted"
        : "modified"
    return {
      path,
      kind,
      ...(current?.sha256 ? { contentHash: current.sha256 } : {}),
      ...(current ? { sizeBytes: current.size } : {}),
    }
  })
  const status =
    changes.outsideScope.length > 0 ? "out_of_scope" : changes.hasChanges ? "changed" : "unchanged"
  return ChangeEvidenceSchema.parse({
    schemaVersion: 1,
    policy,
    status,
    files,
    outsideScopePaths: changes.outsideScope,
    reproducible: binding?.reproducible ?? true,
    missingContent: binding?.missingContent ?? [],
    ...(binding
      ? {
          diffHash: binding.diffHash,
          diffRef: binding.diffRef,
        }
      : {}),
  })
}

export function gateResultFromVerification(value: VerificationResult): GateResult {
  return GateResultSchema.parse({
    gateId: value.gateId,
    category: value.category,
    blocking: value.blocking,
    ...(value.skipPolicy ? { skipPolicy: value.skipPolicy } : {}),
    ...(value.criterionIds ? { criterionIds: value.criterionIds } : {}),
    status: value.status,
    ...(value.command ? { command: value.command } : {}),
    ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}),
    durationMs: value.durationMs,
    ...(value.attempts !== undefined ? { attempts: value.attempts } : {}),
    outputRefs: value.outputRefs,
    ...(value.stdoutBytes !== undefined ? { stdoutBytes: value.stdoutBytes } : {}),
    ...(value.stderrBytes !== undefined ? { stderrBytes: value.stderrBytes } : {}),
    ...(value.outputTruncated !== undefined ? { outputTruncated: value.outputTruncated } : {}),
    ...(value.rawOutputTruncated !== undefined
      ? { rawOutputTruncated: value.rawOutputTruncated }
      : {}),
    ...(value.reason ? { reason: value.reason } : {}),
  })
}

function artifactMediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "application/json"
    case ".yaml":
    case ".yml":
      return "application/yaml"
    case ".toml":
      return "application/toml"
    case ".md":
      return "text/markdown"
    case ".txt":
    case ".log":
      return "text/plain"
    case ".html":
      return "text/html"
    case ".css":
      return "text/css"
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript"
    case ".ts":
    case ".tsx":
      return "text/typescript"
    case ".png":
      return "image/png"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".svg":
      return "image/svg+xml"
    case ".pdf":
      return "application/pdf"
    default:
      return "application/octet-stream"
  }
}

export async function collectArtifactEvidence(
  workspaceRoot: string,
  specifications: readonly VerificationSpec[],
  options: {
    objectStore: ContentAddressedStore
    maxArtifactBytes?: number
    storageRoot?: string
  },
): Promise<ArtifactEvidenceV2[]> {
  const evidence: ArtifactEvidenceV2[] = []
  for (const specification of specifications) {
    if (specification.type !== "artifact") continue
    try {
      const frozen = await freezeWorkspaceFile(
        workspaceRoot,
        specification.path,
        options.objectStore,
        {
          ...(options.maxArtifactBytes === undefined ? {} : { maxBytes: options.maxArtifactBytes }),
          ...(options.storageRoot ? { storageRoot: options.storageRoot } : {}),
        },
      )
      const validation = await validateArtifactContract(workspaceRoot, specification, {
        capturedContentHash: frozen.contentHash,
      })
      const capturedHashMismatch =
        validation.contentHash !== undefined && validation.contentHash !== frozen.contentHash
      const validationReason = capturedHashMismatch
        ? `Artifact changed between immutable capture and validation: ${specification.path}`
        : validation.reason
      const validationPassed = validation.status === "passed" && !capturedHashMismatch
      const schemaValidationReason = specification.schema ? validationReason : undefined
      evidence.push(
        ArtifactEvidenceV2Schema.parse({
          artifactId: specification.artifactId,
          path: specification.path,
          contentHash: frozen.contentHash,
          sizeBytes: frozen.sizeBytes,
          mediaType: artifactMediaType(specification.path),
          immutableRef: frozen.ref,
          status: validationPassed ? "passed" : "failed",
          validation: {
            status: capturedHashMismatch ? "unavailable" : validation.schemaStatus,
            ...(specification.schema ? { schemaRef: specification.schema } : {}),
            ...(!validationPassed && schemaValidationReason
              ? { reason: schemaValidationReason }
              : {}),
          },
          ...(!validationPassed && validationReason ? { reason: validationReason } : {}),
        }),
      )
    } catch (error) {
      evidence.push(
        ArtifactEvidenceV2Schema.parse({
          artifactId: specification.artifactId,
          path: specification.path,
          contentHash: sha256("missing"),
          sizeBytes: 0,
          mediaType: artifactMediaType(specification.path),
          status: "failed",
          validation: { status: "unavailable", reason: "Artifact could not be retained" },
          reason: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
  return evidence
}

export function buildEvidenceBundle(input: {
  id: string
  runId: string
  documentId: string
  task: PrdTask
  taskSnapshot?: ContextTask
  attemptId: string
  baseline: GitBaseline
  changes: ChangeEvidence
  artifacts: Array<ArtifactEvidence | ArtifactEvidenceV2>
  gates: GateResult[]
  executorOutcome?: ExecutorOutcome
  context?: EvidenceContextBinding
  contextManifestHash?: string
  limits?: EvidenceLimits
  toolCalls?: EvidenceToolCall[]
  profile?: EvidenceProfileSnapshot
  usage?: EvidenceUsage
  priorAttempts?: EvidencePriorAttempt[]
  priorAssessments?: EvidenceAssessmentRef[]
  security?: EvidenceBundleV2["security"]
  truncations?: EvidenceTruncation[]
  missingEvidence?: MissingEvidence[]
  createdAt?: string
}): EvidenceBundleV2 {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const contextManifestHash = input.context?.manifestHash ?? input.contextManifestHash
  if (!contextManifestHash) throw new Error("Evidence bundle requires a context manifest hash")
  const context: EvidenceContextBinding = input.context ?? {
    manifestHash: contextManifestHash,
    manifestRef: `context:${contextManifestHash}`,
    mode: "once",
  }
  const taskSnapshot: ContextTask = input.taskSnapshot ?? {
    documentId: input.documentId,
    taskId: input.task.id,
    title: input.task.title,
    result: input.task.result.text,
    criteria: input.task.criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text.text,
      ...(criterion.weight !== undefined ? { weight: criterion.weight } : {}),
      ...(criterion.blocking !== undefined ? { blocking: criterion.blocking } : {}),
    })),
    boundaries: input.task.boundaries.map((boundary) => boundary.text),
    ...(input.task.notes ? { notes: input.task.notes.map((note) => note.text) } : {}),
    evidenceMode: input.task.evidenceMode,
    verificationRefs: input.task.verification.map(
      (verification) => `verification:${verification.id}`,
    ),
    taskSpecHash: input.task.taskSpecHash,
  }
  const limits: EvidenceLimits = input.limits ?? {
    modelCallsPerAttempt: {
      maximum: input.task.budget?.maxModelCallsPerAttempt ?? 1,
      source: input.task.budget?.maxModelCallsPerAttempt === undefined ? "command" : "task",
    },
    ...(input.task.budget?.maxToolCallsPerModelCall !== undefined
      ? {
          toolCallsPerModelCall: {
            maximum: input.task.budget.maxToolCallsPerModelCall,
            source: "task",
          },
        }
      : {}),
    ...(input.task.budget?.taskTimeout ? { taskTimeout: input.task.budget.taskTimeout } : {}),
    ...(input.task.budget?.maxRevisionAttempts !== undefined
      ? {
          maxRevisionAttempts: {
            maximum: input.task.budget.maxRevisionAttempts,
            source: "task",
          },
        }
      : {}),
  }
  const toolCalls = input.toolCalls ?? []
  const profile: EvidenceProfileSnapshot = input.profile ?? {
    role: "executor",
    profileId: input.task.profiles?.executor ?? "unavailable",
    backendId: "unavailable",
    metadataAvailability: "unavailable",
    capabilities: {
      streaming: false,
      toolCalling: "unavailable",
      cancellation: false,
      usage: "unavailable",
    },
    declaredLimits: {},
  }
  const usage: EvidenceUsage = input.usage ?? {
    source: "unavailable",
    semantics: "final",
    providerRawRefs: [],
    providerCallCount: 0,
  }
  const security: EvidenceBundleV2["security"] = input.security ?? {
    mode: "safe",
    headlessAsk: "deny",
    allowShell: false,
    interactive: false,
    allowedCommandCount: 0,
    readPaths: [],
    writePaths: [],
    toolRuleCount: 0,
    diagnostics: ["Security diagnostics were unavailable to this compatibility caller"],
  }
  const artifacts = input.artifacts.map((artifact) =>
    "mediaType" in artifact
      ? ArtifactEvidenceV2Schema.parse(artifact)
      : ArtifactEvidenceV2Schema.parse({
          ...artifact,
          mediaType: artifactMediaType(artifact.path),
          validation: { status: "not_requested" },
        }),
  )
  const truncations: EvidenceTruncation[] = [
    ...(input.truncations ?? []),
    ...input.gates.flatMap((gate) => {
      const notices: EvidenceTruncation[] = []
      if (gate.outputTruncated) {
        notices.push({
          source: "gate",
          field: `${gate.gateId}.output`,
          reason: "bounded gate output was truncated",
          ...(gate.outputRefs[0] ? { ref: gate.outputRefs[0] } : {}),
        })
      }
      if (gate.rawOutputTruncated) {
        notices.push({
          source: "gate",
          field: `${gate.gateId}.rawOutput`,
          reason: "raw gate output reached its retention limit",
          ...(gate.outputRefs[0] ? { ref: gate.outputRefs[0] } : {}),
        })
      }
      return notices
    }),
  ]
  const usageHasEnforcedLimit = Boolean(
    limits.inputTokens ||
      limits.outputTokens ||
      limits.reasoningTokens ||
      limits.totalTokens ||
      limits.cost,
  )
  const missingEvidence: MissingEvidence[] = [
    ...(input.missingEvidence ?? []),
    ...input.changes.missingContent.map((missing) => ({
      source: "change" as const,
      code: "workspace-content-not-retained",
      message: `${missing.side} content is unavailable for ${missing.path}: ${missing.reason}`,
      blocking: true,
    })),
    ...artifacts.flatMap((artifact) => {
      const missing: MissingEvidence[] = []
      if (artifact.status === "failed") {
        const retained = Boolean(artifact.immutableRef)
        missing.push({
          source: "artifact",
          code: retained ? "artifact-contract-failed" : "artifact-not-retained",
          message:
            artifact.reason ??
            (retained
              ? `Artifact did not satisfy its declared contract: ${artifact.path}`
              : `Artifact could not be retained: ${artifact.path}`),
          blocking: true,
          ref: artifact.path,
        })
      }
      if (artifact.validation.status === "unavailable") {
        missing.push({
          source: "artifact",
          code: "artifact-validation-unavailable",
          message:
            artifact.validation.reason ?? `Artifact validation is unavailable: ${artifact.path}`,
          blocking: artifact.status !== "failed",
          ref: artifact.path,
        })
      }
      return missing
    }),
    ...toolCalls
      .filter((tool) => !tool.settlement)
      .map((tool) => ({
        source: "tool" as const,
        code: "tool-settlement-missing",
        message: `Tool call ${tool.intentId} has no durable settlement`,
        blocking: true,
        ref: tool.intentRef,
      })),
    ...(usage.source === "unavailable"
      ? [
          {
            source: "usage" as const,
            code: "model-usage-unavailable",
            message: "The execution backend did not provide measurable model usage",
            blocking: usageHasEnforcedLimit,
          },
        ]
      : []),
  ]
  const body = {
    schemaVersion: 2 as const,
    id: input.id,
    runId: input.runId,
    documentId: input.documentId,
    taskId: input.task.id,
    attemptId: input.attemptId,
    taskSpecHash: input.task.taskSpecHash,
    task: taskSnapshot,
    limits,
    baseline: input.baseline,
    changes: input.changes,
    artifacts,
    gates: input.gates,
    tests: input.gates
      .filter((gate) => gate.category === "test")
      .map((gate) => ({ gateId: gate.gateId, status: gate.status, blocking: gate.blocking })),
    toolCalls,
    ...(input.executorOutcome ? { executorOutcome: input.executorOutcome } : {}),
    context,
    contextManifestHash,
    profile,
    usage,
    priorAttempts: input.priorAttempts ?? [],
    priorAssessments: input.priorAssessments ?? [],
    security,
    provenance: {
      task: "derived" as const,
      changes: "derived" as const,
      artifacts: "derived" as const,
      gates: "derived" as const,
      tools: "derived" as const,
      context: "derived" as const,
      profile: "derived" as const,
      usage: usage.source,
      security: "derived" as const,
      assessments:
        (input.priorAssessments?.length ?? 0) > 0 ? ("derived" as const) : ("unavailable" as const),
    },
    truncations,
    missingEvidence,
    createdAt,
  }
  return EvidenceBundleV2Schema.parse({
    ...body,
    contentHash: computeEvidenceBundleContentHash(body),
  })
}

function modeRequiresCriteria(mode: PrdTask["evidenceMode"]): boolean {
  return mode === "criteria" || mode === "criteria+artifact"
}

function modeRequiresArtifact(mode: PrdTask["evidenceMode"]): boolean {
  return mode === "artifact" || mode === "criteria+artifact" || mode === "change+artifact"
}

function modeRequiresChange(mode: PrdTask["evidenceMode"]): boolean {
  return mode === "change-only" || mode === "change+artifact"
}

function artifactDeclarationPassed(
  specification: Extract<VerificationSpec, { type: "artifact" }>,
  evidence: EvidenceBundle,
): boolean {
  return evidence.artifacts.some((artifact) => {
    if (
      artifact.artifactId !== specification.artifactId ||
      artifact.path !== specification.path ||
      artifact.status !== "passed"
    ) {
      return false
    }
    if (
      specification.expectedSha256 !== undefined &&
      artifact.contentHash !== specification.expectedSha256
    ) {
      return false
    }
    if (!specification.schema) return true
    if (!("validation" in artifact)) return false
    const parsedArtifact = ArtifactEvidenceV2Schema.safeParse(artifact)
    return (
      parsedArtifact.success &&
      parsedArtifact.data.validation.status === "passed" &&
      parsedArtifact.data.validation.schemaRef === specification.schema
    )
  })
}

function linkedVerificationPassed(
  specification: VerificationSpec,
  criterionId: string,
  evidence: EvidenceBundle,
): boolean {
  const gatePassed = evidence.gates.some(
    (gate) =>
      gate.gateId === specification.id &&
      gate.status === "passed" &&
      gate.criterionIds?.includes(criterionId),
  )
  if (!gatePassed) return false
  return specification.type !== "artifact" || artifactDeclarationPassed(specification, evidence)
}

export function decideDeterministicCompletion(input: {
  task: PrdTask
  evidence: EvidenceBundle
  overrideGateIds?: ReadonlySet<string>
  decidedAt?: string
}): CompletionEvaluation {
  const reasons: string[] = []
  const overrides = input.overrideGateIds ?? new Set<string>()
  let overrideUsed = false
  let retryNoChange = false
  let passed = true
  let blocked = false

  if (input.evidence.executorOutcome?.status === "blocked_reported") {
    passed = false
    blocked = true
    reasons.push("Executor reported a blocking condition; the report is not completion")
  }
  if (input.evidence.changes.status === "out_of_scope") {
    passed = false
    reasons.push(
      `Workspace changes escaped the declared scope: ${input.evidence.changes.outsideScopePaths.join(", ")}`,
    )
  }
  if (!input.evidence.changes.reproducible) {
    passed = false
    const missing = input.evidence.changes.missingContent
      .map((item) => `${item.path} (${item.side}: ${item.reason})`)
      .join(", ")
    reasons.push(`Workspace change evidence is not reproducible: ${missing}`)
  }

  for (const gate of input.evidence.gates) {
    if (!gate.blocking || gate.status === "passed") continue
    if (
      gate.status === "skipped_by_cli" &&
      (gate.skipPolicy === "allowed-to-skip" || gate.skipPolicy === "optional")
    ) {
      reasons.push(`Blocking gate ${gate.gateId} was explicitly skipped as ${gate.skipPolicy}`)
      continue
    }
    if (gate.status === "skipped_by_cli" && overrides.has(gate.gateId)) {
      overrideUsed = true
      reasons.push(`Required gate ${gate.gateId} was skipped by audited override`)
      continue
    }
    passed = false
    reasons.push(`Blocking gate ${gate.gateId} is ${gate.status}`)
  }

  const noChange = input.evidence.changes.status === "unchanged"
  if (modeRequiresChange(input.task.evidenceMode) && noChange) {
    passed = false
    reasons.push(`Evidence mode ${input.task.evidenceMode} requires a permitted change`)
  } else if (noChange && input.evidence.changes.policy !== "allow-no-change") {
    passed = false
    retryNoChange = input.evidence.changes.policy === "retry-on-no-change"
    reasons.push(`No-change policy ${input.evidence.changes.policy} does not accept an empty delta`)
  }

  if (modeRequiresCriteria(input.task.evidenceMode)) {
    const hasExplicitCriterionLinks = input.task.verification.some(
      (specification) =>
        specification.type !== "instruction" && (specification.criterionIds?.length ?? 0) > 0,
    )
    if (hasExplicitCriterionLinks) {
      for (const criterion of input.task.criteria) {
        const linked = input.task.verification.filter(
          (specification) =>
            specification.type !== "instruction" &&
            specification.criterionIds?.includes(criterion.id),
        )
        if (linked.length === 0) {
          passed = false
          reasons.push(`Criterion ${criterion.id} has no declared verification link`)
          continue
        }
        if (
          !linked.some((specification) =>
            linkedVerificationPassed(specification, criterion.id, input.evidence),
          )
        ) {
          passed = false
          reasons.push(`Criterion ${criterion.id} has no passed linked deterministic evidence`)
        }
      }
    } else {
      const declaredDeterministicGateIds = new Set(
        input.task.verification
          .filter(
            (specification) =>
              specification.type !== "instruction" && specification.skipPolicy !== "never-run",
          )
          .map((specification) => specification.id),
      )
      const deterministicCriterionEvidence = input.evidence.gates.some(
        (gate) => gate.status === "passed" && declaredDeterministicGateIds.has(gate.gateId),
      )
      if (!deterministicCriterionEvidence) {
        passed = false
        reasons.push("Criteria mode has no passed deterministic verification")
      }
    }
  }

  if (modeRequiresArtifact(input.task.evidenceMode)) {
    const declaredArtifacts = input.task.verification.filter(
      (specification): specification is Extract<VerificationSpec, { type: "artifact" }> =>
        specification.type === "artifact",
    )
    if (declaredArtifacts.length === 0) {
      passed = false
      reasons.push("Artifact evidence mode requires an explicitly named artifact declaration")
    } else {
      const missingRequiredArtifacts = declaredArtifacts.filter(
        (specification) =>
          specification.blocking &&
          specification.skipPolicy === "required" &&
          !artifactDeclarationPassed(specification, input.evidence),
      )
      if (missingRequiredArtifacts.length > 0) {
        passed = false
        reasons.push(
          `Required declared artifacts have no matching passed evidence: ${missingRequiredArtifacts
            .map((specification) => `${specification.artifactId} (${specification.path})`)
            .join(", ")}`,
        )
      } else if (
        !declaredArtifacts.some((specification) =>
          artifactDeclarationPassed(specification, input.evidence),
        )
      ) {
        passed = false
        reasons.push("Artifact evidence mode has no passed evidence matching a declared artifact")
      }
    }
  }

  if (passed && reasons.length === 0)
    reasons.push("All deterministic completion requirements passed")
  const status = blocked ? "blocked" : passed ? (overrideUsed ? "overridden" : "passed") : "failed"
  const decision = CompletionDecisionSchema.parse({
    status,
    deterministicPassed: passed,
    evaluationMode: "none",
    evidenceBundleId: input.evidence.id,
    reasons,
    decidedBy: "ralph-policy",
    decidedAt: input.decidedAt ?? new Date().toISOString(),
  })
  return { decision, retryNoChange, overrideUsed }
}
