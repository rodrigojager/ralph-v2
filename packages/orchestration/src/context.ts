import { createHash } from "node:crypto"
import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import {
  type ContextAssessmentFeedback,
  ContextAssessmentFeedbackSchema,
  type ContextBudget,
  type ContextManifest,
  ContextManifestSchema,
  type DependencyOutput,
  EXIT_CODES,
  type GitBaseline,
  type JudgeAssessment,
  RalphError,
  type RecoveryManifest,
  RecoveryManifestSchema,
  type RunMode,
} from "@ralph/domain"
import {
  type CompiledPrdGraph,
  hashCanonicalValue,
  type PrdDocument,
  type PrdTask,
  stableJson,
  type TaskRef,
  type VerificationSpec,
} from "@ralph/prd"

export type ContextLimits = {
  maxTotalPayloadBytes: number
  maxSharedContextBytes: number
  maxTaskFieldBytes: number
  maxVerificationBytes: number
  maxFullPrdBytes: number
  maxCriteria: number
  maxBoundaries: number
  maxNotes: number
  maxVerifications: number
  maxDependencyOutputs: number
  maxOutputRefsPerDependency: number
  maxParentContextRefs: number
  maxDeclaredFileRefs: number
  maxAdditionalInvariants: number
  maxAssessmentFeedbackBytes: number
  maxAssessmentFeedbackFieldBytes: number
  maxRecoveryManifestBytes: number
}

export const DEFAULT_CONTEXT_LIMITS: Readonly<ContextLimits> = Object.freeze({
  maxTotalPayloadBytes: 512 * 1_024,
  maxSharedContextBytes: 48 * 1_024,
  maxTaskFieldBytes: 16 * 1_024,
  maxVerificationBytes: 24 * 1_024,
  maxFullPrdBytes: 384 * 1_024,
  maxCriteria: 128,
  maxBoundaries: 128,
  maxNotes: 128,
  maxVerifications: 128,
  maxDependencyOutputs: 128,
  maxOutputRefsPerDependency: 128,
  maxParentContextRefs: 128,
  maxDeclaredFileRefs: 256,
  maxAdditionalInvariants: 64,
  maxAssessmentFeedbackBytes: 128 * 1_024,
  maxAssessmentFeedbackFieldBytes: 8 * 1_024,
  maxRecoveryManifestBytes: 256 * 1_024,
})

export type ContextTruncation = {
  field: string
  reason: "field-limit" | "total-budget" | "field-and-total-limit" | "item-limit"
  originalHash: string
  originalBytes?: number
  includedBytes?: number
  originalCount?: number
  includedCount?: number
}

export type ContextResource = {
  ref: string
  kind: "verification" | "full-prd" | "assessment" | "recovery"
  mediaType: "application/json" | "text/markdown"
  encoding: "utf-8"
  content: string
  contentHash: string
  includedHash: string
  originalBytes: number
  includedBytes: number
  truncated: boolean
}

export type ContextManifestBundle = {
  manifest: ContextManifest
  resources: readonly ContextResource[]
  truncations: readonly ContextTruncation[]
  canonicalJson: string
}

export type BuildContextManifestInput = {
  graph: CompiledPrdGraph
  task: TaskRef
  runId: string
  attemptId: string
  mode: RunMode
  baseline: GitBaseline
  budget: ContextBudget
  workspaceRoot?: string
  parentContextRefs?: readonly string[]
  dependencyOutputs?: readonly DependencyOutput[]
  declaredFileRefs?: readonly string[]
  previousAssessmentRef?: string
  contextRotation?: {
    requestId: string
    reason: string
    requestedAt: string
    boundary: "next-model-call" | "next-task"
  }
  revisionFeedback?: {
    assessment: JudgeAssessment
    assessmentRef: string
    threshold: number
  }
  recovery?: {
    manifest: RecoveryManifest
    sourceRef: string
    sourceStorageHash: string
  }
  additionalInvariants?: readonly string[]
  limits?: Partial<ContextLimits>
  createdAt?: string
}

type BoundedContent = {
  content: string
  originalHash: string
  originalBytes: number
  includedBytes: number
  truncated: boolean
}

const FIXED_INVARIANTS = Object.freeze([
  "Ralph selects the official task and only Ralph policy may complete it.",
  "Executor output is an allegation until evidence and blocking verifications pass.",
  "The executor must not edit PRD status markers or create or expand a PRD or Sub-PRD.",
  "Tools and side effects are limited to the authority granted for this attempt.",
])

const ALLOWED_REF_SCHEMES = new Set(["artifact", "context", "evidence", "workspace"])
const MAX_PORTABLE_REF_BYTES = 4_096

function contextBuildExitCode(code: string) {
  if (code.includes("HASH_MISMATCH")) return EXIT_CODES.conflict
  if (code.includes("BUDGET") || code.includes("PAYLOAD")) return EXIT_CODES.budgetExceeded
  if (code === "RALPH_CONTEXT_PRD_READ_FAILED") return EXIT_CODES.operationalError
  return EXIT_CODES.invalidUsage
}

export class ContextBuildError extends RalphError {
  readonly details: Readonly<Record<string, unknown>>

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, { exitCode: contextBuildExitCode(code), details })
    this.name = "ContextBuildError"
    this.details = Object.freeze({ ...details })
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

function prefixByUtf8Bytes(value: string, maximum: number): string {
  if (maximum <= 0) return ""
  const pieces: string[] = []
  let used = 0
  for (const character of value) {
    const size = bytes(character)
    if (used + size > maximum) break
    pieces.push(character)
    used += size
  }
  return pieces.join("")
}

function truncationMarker(truncation: ContextTruncation): string {
  return `[RALPH_CONTEXT_TRUNCATED field=${JSON.stringify(truncation.field)} reason=${truncation.reason} originalBytes=${truncation.originalBytes ?? 0} includedPayloadBytes=${truncation.includedBytes ?? 0} originalSha256=${truncation.originalHash}]\n`
}

class PayloadAllocator {
  readonly truncations: ContextTruncation[] = []
  #remaining: number

  constructor(total: number) {
    this.#remaining = total
  }

  get remainingBytes(): number {
    return this.#remaining
  }

  materialize(field: string, value: string, fieldLimit: number): BoundedContent {
    const originalBytes = bytes(value)
    const originalHash = sha256(value)
    const remainingBefore = this.#remaining
    const allowance = Math.min(fieldLimit, remainingBefore)
    const payload = prefixByUtf8Bytes(value, allowance)
    const includedPayloadBytes = bytes(payload)
    this.#remaining -= includedPayloadBytes
    if (includedPayloadBytes === originalBytes) {
      return {
        content: value,
        originalHash,
        originalBytes,
        includedBytes: originalBytes,
        truncated: false,
      }
    }

    const fieldLimited = fieldLimit < originalBytes
    const totalLimited = remainingBefore < originalBytes
    const reason =
      fieldLimited && totalLimited
        ? "field-and-total-limit"
        : fieldLimited
          ? "field-limit"
          : "total-budget"
    const truncation: ContextTruncation = {
      field,
      reason,
      originalHash,
      originalBytes,
      includedBytes: includedPayloadBytes,
    }
    this.truncations.push(truncation)
    const content = `${truncationMarker(truncation)}${payload}`
    return {
      content,
      originalHash,
      originalBytes,
      includedBytes: bytes(content),
      truncated: true,
    }
  }

  recordItemLimit(field: string, original: readonly unknown[], includedCount: number): void {
    if (includedCount >= original.length) return
    this.truncations.push({
      field,
      reason: "item-limit",
      originalHash: sha256(stableJson(original)),
      originalCount: original.length,
      includedCount,
    })
  }

  consumeStructured(
    field: string,
    originalContent: string,
    includedContent: string,
    fieldLimit: number,
  ): BoundedContent {
    const originalBytes = bytes(originalContent)
    const includedBytes = bytes(includedContent)
    const remainingBefore = this.#remaining
    const allowance = Math.min(fieldLimit, remainingBefore)
    if (includedBytes > allowance) {
      throw new ContextBuildError(
        "RALPH_CONTEXT_STRUCTURED_RESOURCE_TOO_LARGE",
        `Structured context resource does not fit its authenticated budget: ${field}`,
        { field, includedBytes, allowance },
      )
    }
    this.#remaining -= includedBytes
    const originalHash = sha256(originalContent)
    if (includedContent !== originalContent) {
      const fieldLimited = fieldLimit < originalBytes
      const totalLimited = remainingBefore < originalBytes
      this.truncations.push({
        field,
        reason:
          fieldLimited && totalLimited
            ? "field-and-total-limit"
            : fieldLimited
              ? "field-limit"
              : "total-budget",
        originalHash,
        originalBytes,
        includedBytes,
      })
    }
    return {
      content: includedContent,
      originalHash,
      originalBytes,
      includedBytes,
      truncated: includedContent !== originalContent,
    }
  }
}

function validatedLimits(overrides: Partial<ContextLimits> | undefined): ContextLimits {
  const limits = { ...DEFAULT_CONTEXT_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ContextBuildError(
        "RALPH_CONTEXT_LIMIT_INVALID",
        `Context limit ${name} must be a non-negative safe integer.`,
        { name, value },
      )
    }
  }
  return limits
}

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText)
}

function portableRef(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new ContextBuildError("RALPH_CONTEXT_REF_EMPTY", `Context reference is empty: ${field}`, {
      field,
    })
  }
  const normalized = trimmed.replaceAll("\\", "/")
  if (bytes(normalized) > MAX_PORTABLE_REF_BYTES) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_REF_TOO_LARGE",
      `Context reference exceeds ${MAX_PORTABLE_REF_BYTES} UTF-8 bytes: ${field}`,
      { field, maximumBytes: MAX_PORTABLE_REF_BYTES },
    )
  }
  if (isAbsolute(trimmed) || /^[a-z]:($|[/\\])/i.test(trimmed) || normalized.startsWith("//")) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_REF_ABSOLUTE",
      `Context references must not contain absolute machine paths: ${field}`,
      { field },
    )
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1]?.toLocaleLowerCase("en-US")
  if (scheme) {
    if (!ALLOWED_REF_SCHEMES.has(scheme) || !normalized.startsWith(`${scheme}://`)) {
      throw new ContextBuildError(
        "RALPH_CONTEXT_REF_SCHEME_INVALID",
        `Context reference uses a forbidden or malformed scheme: ${field}`,
        { field, scheme },
      )
    }
    return normalized
  }
  const segments = normalized.split("/")
  if (segments.some((segment) => segment === "..")) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_REF_ESCAPE",
      `Context reference escapes its portable namespace: ${field}`,
      { field },
    )
  }
  return normalized.startsWith("./") ? normalized.slice(2) : normalized
}

function markdownValue(value: { markdown: string; text: string }): string {
  return value.markdown.trim() ? value.markdown : value.text
}

function verificationProjection(specification: VerificationSpec): unknown {
  const executionMetadata =
    specification.type === "instruction"
      ? {}
      : {
          ...(specification.attempts !== undefined ? { attempts: specification.attempts } : {}),
          ...(specification.timeoutMs !== undefined ? { timeoutMs: specification.timeoutMs } : {}),
          ...(specification.applicability ? { applicability: specification.applicability } : {}),
          ...(specification.criterionIds ? { criterionIds: specification.criterionIds } : {}),
        }
  const common = {
    schemaVersion: 1,
    id: specification.id,
    type: specification.type,
    category: specification.category,
    skipPolicy: specification.skipPolicy,
    blocking: specification.blocking,
    ...executionMetadata,
  }
  switch (specification.type) {
    case "instruction":
      return { ...common, text: markdownValue(specification.text) }
    case "command":
      return { ...common, command: specification.command }
    case "file":
      return { ...common, path: specification.path, expectation: specification.expectation }
    case "schema":
      return { ...common, path: specification.path, schema: specification.schema }
    case "git":
      return { ...common, expectation: specification.expectation }
    case "artifact":
      return {
        ...common,
        artifactId: specification.artifactId,
        path: specification.path,
        ...(specification.schema ? { schema: specification.schema } : {}),
        ...(specification.expectedSha256 ? { expectedSha256: specification.expectedSha256 } : {}),
      }
    case "plugin":
      return { ...common, plugin: specification.plugin, input: specification.input }
  }
}

function declaredRefsFromVerification(specification: VerificationSpec): string[] {
  switch (specification.type) {
    case "file":
      return [
        specification.path,
        ...(specification.expectation.kind === "json-schema"
          ? [specification.expectation.schema]
          : []),
      ]
    case "artifact":
      return [specification.path, ...(specification.schema ? [specification.schema] : [])]
    case "schema":
      return [specification.path, specification.schema]
    default:
      return []
  }
}

function resourceRef(kind: ContextResource["kind"], name: string, contentHash: string): string {
  const safeName = encodeURIComponent(name)
  const extension = kind === "full-prd" ? "md" : "json"
  return `context://sha256/${contentHash}/${kind}-${safeName}.${extension}`
}

function contextResource(
  kind: ContextResource["kind"],
  name: string,
  mediaType: ContextResource["mediaType"],
  bounded: BoundedContent,
): ContextResource {
  return {
    ref: resourceRef(kind, name, bounded.originalHash),
    kind,
    mediaType,
    encoding: "utf-8",
    content: bounded.content,
    contentHash: bounded.originalHash,
    includedHash: sha256(bounded.content),
    originalBytes: bounded.originalBytes,
    includedBytes: bounded.includedBytes,
    truncated: bounded.truncated,
  }
}

const MAX_ASSESSMENT_FEEDBACK_ITEMS = 64
const MAX_ASSESSMENT_EVIDENCE_REFS = 64
const MIN_ASSESSMENT_TEXT_BYTES = 16

function boundedFeedbackText(value: string, maximumBytes: number, unique = false): string {
  if (bytes(value) <= maximumBytes) return value
  const digest = sha256(value).slice(0, 12)
  const suffix = unique ? ` [#${digest}]` : " [truncated]"
  const suffixBytes = bytes(suffix)
  if (maximumBytes <= suffixBytes) {
    return prefixByUtf8Bytes(unique ? digest : value, Math.max(1, maximumBytes))
  }
  return `${prefixByUtf8Bytes(value, maximumBytes - suffixBytes)}${suffix}`
}

function assessmentFeedbackProjection(
  assessment: JudgeAssessment,
  assessmentRef: string,
  threshold: number,
  itemLimit: number,
  evidenceRefLimit: number,
  textLimit: number,
): ContextAssessmentFeedback {
  const text = (value: string) => boundedFeedbackText(value, textLimit)
  const identifier = (value: string) => boundedFeedbackText(value, textLimit, true)
  return ContextAssessmentFeedbackSchema.parse({
    schemaVersion: 1,
    sourceAssessmentRef: assessmentRef,
    sourceAssessmentId: assessment.id,
    sourceEvidenceBundleId: assessment.evidenceBundleId,
    sourceKind: assessment.kind,
    score: assessment.score,
    threshold,
    summary: text(assessment.summary),
    adequate: assessment.adequate.slice(0, itemLimit).map(text),
    problems: assessment.problems.slice(0, itemLimit).map((problem) => ({
      severity: problem.severity,
      ...(problem.criterion ? { criterion: identifier(problem.criterion) } : {}),
      message: text(problem.message),
      evidenceRefs: problem.evidenceRefs
        .slice(0, evidenceRefLimit)
        .map((reference) => identifier(reference)),
    })),
    missingEvidence: assessment.missingEvidence.slice(0, itemLimit).map(text),
    recommendations: assessment.recommendations.slice(0, itemLimit).map(text),
    criterionScores: assessment.criterionScores.slice(0, itemLimit).map((criterion) => ({
      criterion: identifier(criterion.criterion),
      score: criterion.score,
      ...(criterion.rationale ? { rationale: text(criterion.rationale) } : {}),
    })),
  })
}

function assessmentResource(
  input: NonNullable<BuildContextManifestInput["revisionFeedback"]>,
  assessmentRef: string,
  allocator: PayloadAllocator,
  limits: ContextLimits,
): { resource: ContextResource; feedback: ContextAssessmentFeedback } {
  const originalFeedback = assessmentFeedbackProjection(
    input.assessment,
    assessmentRef,
    input.threshold,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  )
  const originalContent = stableJson(originalFeedback)
  const maximumBytes = Math.min(limits.maxAssessmentFeedbackBytes, allocator.remainingBytes)
  let itemLimit = MAX_ASSESSMENT_FEEDBACK_ITEMS
  let evidenceRefLimit = MAX_ASSESSMENT_EVIDENCE_REFS
  let textLimit = limits.maxAssessmentFeedbackFieldBytes
  let feedback: ContextAssessmentFeedback | undefined
  let includedContent = ""

  while (itemLimit >= 1 && textLimit >= 1) {
    feedback = assessmentFeedbackProjection(
      input.assessment,
      assessmentRef,
      input.threshold,
      itemLimit,
      evidenceRefLimit,
      textLimit,
    )
    includedContent = stableJson(feedback)
    if (bytes(includedContent) <= maximumBytes) break
    if (itemLimit > 1) {
      itemLimit = Math.max(1, Math.floor(itemLimit / 2))
      continue
    }
    if (evidenceRefLimit > 0) {
      evidenceRefLimit = Math.floor(evidenceRefLimit / 2)
      continue
    }
    if (textLimit > MIN_ASSESSMENT_TEXT_BYTES) {
      textLimit = Math.max(MIN_ASSESSMENT_TEXT_BYTES, Math.floor(textLimit / 2))
      continue
    }
    break
  }
  if (!feedback || bytes(includedContent) > maximumBytes) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_ASSESSMENT_BUDGET_TOO_SMALL",
      "The previous judge assessment cannot be represented safely inside the revision context budget.",
      {
        assessmentId: input.assessment.id,
        maximumBytes,
        minimumRequiredBytes: feedback ? bytes(includedContent) : undefined,
      },
    )
  }
  const bounded = allocator.consumeStructured(
    `assessment:${input.assessment.id}`,
    originalContent,
    includedContent,
    limits.maxAssessmentFeedbackBytes,
  )
  return {
    resource: contextResource("assessment", input.assessment.id, "application/json", bounded),
    feedback,
  }
}

function recoveryResource(
  input: NonNullable<BuildContextManifestInput["recovery"]>,
  allocator: PayloadAllocator,
  limits: ContextLimits,
): { resource: ContextResource; manifest: RecoveryManifest } {
  const manifest = RecoveryManifestSchema.parse(input.manifest)
  const { contentHash, ...body } = manifest
  const actualManifestHash = hashCanonicalValue("ralph.recovery-manifest.v1", body)
  if (actualManifestHash !== contentHash) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_RECOVERY_HASH_MISMATCH",
      "Recovery manifest semantic hash does not match its content",
      { expectedHash: contentHash, actualHash: actualManifestHash },
    )
  }
  const content = stableJson(manifest)
  const bounded = allocator.consumeStructured(
    `recovery:${manifest.documentId}/${manifest.taskId}`,
    content,
    content,
    limits.maxRecoveryManifestBytes,
  )
  return {
    manifest,
    resource: contextResource(
      "recovery",
      `${manifest.documentId}-${manifest.taskId}-${manifest.attemptId}`,
      "application/json",
      bounded,
    ),
  }
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
}

async function fullPrdResource(
  document: PrdDocument,
  workspaceRoot: string | undefined,
  allocator: PayloadAllocator,
  limits: ContextLimits,
): Promise<ContextResource> {
  if (!workspaceRoot) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_WIGGUM_WORKSPACE_REQUIRED",
      "Wiggum context requires the canonical workspace root to re-read the compiled PRD.",
    )
  }
  let root: string
  let target: string
  try {
    root = await realpath(resolve(workspaceRoot))
    target = await realpath(resolve(root, document.file))
  } catch (error) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_PRD_READ_FAILED",
      "The compiled PRD could not be resolved for Wiggum context.",
      { reason: error instanceof Error ? error.message : String(error) },
    )
  }
  if (!isContained(root, target)) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_PRD_OUTSIDE_WORKSPACE",
      "The compiled PRD resolves outside the Wiggum workspace.",
      { documentId: document.id },
    )
  }
  let raw: Uint8Array
  try {
    raw = await readFile(target)
  } catch (error) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_PRD_READ_FAILED",
      "The compiled PRD could not be read for Wiggum context.",
      { documentId: document.id, reason: error instanceof Error ? error.message : String(error) },
    )
  }
  const actualHash = sha256(raw)
  if (actualHash !== document.contentHash) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_PRD_HASH_MISMATCH",
      "The PRD changed after compilation; Wiggum context was not materialized.",
      {
        documentId: document.id,
        expectedHash: document.contentHash,
        actualHash,
      },
    )
  }
  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)
  } catch (error) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_PRD_UTF8_INVALID",
      "The verified PRD bytes are not valid UTF-8.",
      { documentId: document.id, reason: error instanceof Error ? error.message : String(error) },
    )
  }
  const bounded = allocator.materialize(`fullPrd:${document.id}`, content, limits.maxFullPrdBytes)
  if (bounded.originalHash !== document.contentHash) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_PRD_TEXT_HASH_MISMATCH",
      "The UTF-8 PRD materialization does not preserve the compiled byte hash.",
      { documentId: document.id },
    )
  }
  return contextResource("full-prd", document.id, "text/markdown", bounded)
}

function limitedItems<T>(
  field: string,
  values: readonly T[],
  maximum: number,
  allocator: PayloadAllocator,
): readonly T[] {
  const output = values.slice(0, maximum)
  allocator.recordItemLimit(field, values, output.length)
  return output
}

function dependencyOutputList(
  task: PrdTask,
  values: readonly DependencyOutput[],
  limits: ContextLimits,
  allocator: PayloadAllocator,
): DependencyOutput[] {
  const byTask = new Map<string, DependencyOutput>()
  for (const value of values) {
    if (!task.dependencies.includes(value.taskId)) {
      throw new ContextBuildError(
        "RALPH_CONTEXT_DEPENDENCY_OUTPUT_UNDECLARED",
        `Output context was supplied for non-dependency task ${value.taskId}.`,
        { taskId: task.id, dependencyTaskId: value.taskId },
      )
    }
    if (byTask.has(value.taskId)) {
      throw new ContextBuildError(
        "RALPH_CONTEXT_DEPENDENCY_OUTPUT_DUPLICATED",
        `Dependency output is duplicated for task ${value.taskId}.`,
        { taskId: task.id, dependencyTaskId: value.taskId },
      )
    }
    byTask.set(value.taskId, {
      taskId: value.taskId,
      outputRefs: uniqueSorted(
        [
          ...limitedItems(
            `dependencyOutputs.${value.taskId}.outputRefs`,
            value.outputRefs,
            limits.maxOutputRefsPerDependency,
            allocator,
          ),
        ].map((reference, index) =>
          portableRef(reference, `dependencyOutputs.${value.taskId}.${index}`),
        ),
      ),
    })
  }
  const ordered = task.dependencies.flatMap((dependency) => {
    const output = byTask.get(dependency)
    return output ? [output] : []
  })
  return [...limitedItems("dependencyOutputs", ordered, limits.maxDependencyOutputs, allocator)]
}

function contextProjection(
  manifest: Omit<ContextManifest, "id" | "createdAt" | "contentHash"> | ContextManifest,
  resources: readonly ContextResource[],
  truncations: readonly ContextTruncation[],
): unknown {
  const {
    id: _id,
    createdAt: _createdAt,
    contentHash: _contentHash,
    ...content
  } = manifest as ContextManifest
  const { capturedAt: _capturedAt, ...baseline } = content.baseline
  return {
    ...content,
    baseline,
    budget: content.budget,
    resources: [...resources].sort((left, right) => compareText(left.ref, right.ref)),
    truncations,
  }
}

function schemaIssues(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("issues" in error)) return String(error)
  return (error as { issues: unknown }).issues
}

/**
 * Builds the complete, bounded context bundle for one official task attempt.
 * The domain manifest remains small and points at content-addressed resources;
 * the bundle hash covers those resources and every explicit truncation notice.
 */
export async function buildContextManifest(
  input: BuildContextManifestInput,
): Promise<ContextManifestBundle> {
  const limits = validatedLimits(input.limits)
  const allocator = new PayloadAllocator(limits.maxTotalPayloadBytes)
  const document = input.graph.documents[input.task.documentId]
  const task = document?.tasks.find((candidate) => candidate.id === input.task.taskId)
  if (!document || !task) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_TASK_NOT_FOUND",
      `Compiled task does not exist: ${input.task.documentId}/${input.task.taskId}`,
    )
  }
  if (task.taskSpecHash !== input.task.taskSpecHash) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_TASK_HASH_MISMATCH",
      "The selected task reference does not match the compiled task specification.",
      {
        documentId: document.id,
        taskId: task.id,
        expectedHash: task.taskSpecHash,
        actualHash: input.task.taskSpecHash,
      },
    )
  }

  const resources: ContextResource[] = []
  const explicitPreviousAssessmentRef = input.previousAssessmentRef
    ? portableRef(input.previousAssessmentRef, "previousAssessmentRef")
    : undefined
  const feedbackAssessmentRef = input.revisionFeedback
    ? portableRef(input.revisionFeedback.assessmentRef, "revisionFeedback.assessmentRef")
    : undefined
  // In Wiggum, previousAssessmentRef may advance to an iteration assessment
  // while revisionFeedback remains bound to the judge assessment that caused
  // this code-revision attempt. Both refs are intentionally auditable.
  const previousAssessmentRef = explicitPreviousAssessmentRef ?? feedbackAssessmentRef
  let revisionFeedback: ContextManifest["revisionFeedback"]
  if (input.revisionFeedback && feedbackAssessmentRef) {
    const materialized = assessmentResource(
      input.revisionFeedback,
      feedbackAssessmentRef,
      allocator,
      limits,
    )
    resources.push(materialized.resource)
    revisionFeedback = {
      kind: "assessment",
      ref: materialized.resource.ref,
      sourceAssessmentRef: materialized.feedback.sourceAssessmentRef,
      sourceAssessmentId: materialized.feedback.sourceAssessmentId,
      sourceEvidenceBundleId: materialized.feedback.sourceEvidenceBundleId,
      contentHash: materialized.resource.contentHash,
      includedHash: materialized.resource.includedHash,
      score: materialized.feedback.score,
      threshold: materialized.feedback.threshold,
      truncated: materialized.resource.truncated,
    }
  }
  let recovery: ContextManifest["recovery"]
  if (input.recovery) {
    const materialized = recoveryResource(input.recovery, allocator, limits)
    const manifest = materialized.manifest
    if (
      manifest.runId !== input.runId ||
      manifest.attemptId !== input.attemptId ||
      manifest.documentId !== input.task.documentId ||
      manifest.taskId !== input.task.taskId
    ) {
      throw new ContextBuildError(
        "RALPH_CONTEXT_RECOVERY_IDENTITY_MISMATCH",
        "Recovery manifest does not belong to this official task attempt",
        {
          expected: {
            runId: input.runId,
            attemptId: input.attemptId,
            documentId: input.task.documentId,
            taskId: input.task.taskId,
          },
          actual: {
            runId: manifest.runId,
            attemptId: manifest.attemptId,
            documentId: manifest.documentId,
            taskId: manifest.taskId,
          },
        },
      )
    }
    if (manifest.observedWorkspaceHash !== input.baseline.workspaceSnapshotHash) {
      throw new ContextBuildError(
        "RALPH_CONTEXT_RECOVERY_BASELINE_MISMATCH",
        "Recovery manifest is not bound to the observed attempt baseline",
        {
          expectedHash: input.baseline.workspaceSnapshotHash,
          actualHash: manifest.observedWorkspaceHash,
        },
      )
    }
    resources.push(materialized.resource)
    recovery = {
      kind: "recovery",
      ref: materialized.resource.ref,
      sourceRef: portableRef(input.recovery.sourceRef, "recovery.sourceRef"),
      manifestHash: manifest.contentHash,
      contentHash: materialized.resource.contentHash,
      includedHash: materialized.resource.includedHash,
      sourceStorageHash: input.recovery.sourceStorageHash,
      truncated:
        materialized.resource.truncated ||
        manifest.changes.truncated ||
        manifest.changes.untrackedTotal > manifest.changes.untracked.length,
      state: manifest.state,
      changedFiles: manifest.changes.total,
      untrackedFiles: manifest.changes.untrackedTotal,
      previousAttempts: manifest.previousAttemptIds.length,
      unsettledToolCalls: manifest.unsettledToolCallIds.length,
      recommendedAction: manifest.recommendedAction,
      requiresOperatorDecision: manifest.requiresOperatorDecision,
    }
  }
  const sharedContext = allocator.materialize(
    `sharedContext:${document.id}`,
    markdownValue(document.sharedContext),
    limits.maxSharedContextBytes,
  )
  const result = allocator.materialize(
    `task:${document.id}/${task.id}:result`,
    markdownValue(task.result),
    limits.maxTaskFieldBytes,
  )
  const title = allocator.materialize(
    `task:${document.id}/${task.id}:title`,
    task.title,
    limits.maxTaskFieldBytes,
  )
  const criteria = limitedItems(
    `task:${document.id}/${task.id}:criteria`,
    task.criteria,
    limits.maxCriteria,
    allocator,
  ).map((criterion) => ({
    id: criterion.id,
    text: allocator.materialize(
      `task:${document.id}/${task.id}:criterion:${criterion.id}`,
      markdownValue(criterion.text),
      limits.maxTaskFieldBytes,
    ).content,
    ...(criterion.weight !== undefined ? { weight: criterion.weight } : {}),
    ...(criterion.blocking !== undefined ? { blocking: criterion.blocking } : {}),
  }))
  const boundaries = limitedItems(
    `task:${document.id}/${task.id}:boundaries`,
    task.boundaries,
    limits.maxBoundaries,
    allocator,
  ).map(
    (boundary, index) =>
      allocator.materialize(
        `task:${document.id}/${task.id}:boundary:${index + 1}`,
        markdownValue(boundary),
        limits.maxTaskFieldBytes,
      ).content,
  )
  const notes = task.notes
    ? limitedItems(
        `task:${document.id}/${task.id}:notes`,
        task.notes,
        limits.maxNotes,
        allocator,
      ).map(
        (note, index) =>
          allocator.materialize(
            `task:${document.id}/${task.id}:note:${index + 1}`,
            markdownValue(note),
            limits.maxTaskFieldBytes,
          ).content,
      )
    : undefined

  const verifications = limitedItems(
    `task:${document.id}/${task.id}:verifications`,
    task.verification,
    limits.maxVerifications,
    allocator,
  )
  const verificationRefs = verifications.map((verification) => {
    const bounded = allocator.materialize(
      `task:${document.id}/${task.id}:verification:${verification.id}`,
      stableJson(verificationProjection(verification)),
      limits.maxVerificationBytes,
    )
    const resource = contextResource(
      "verification",
      `${document.id}-${task.id}-${verification.id}`,
      "application/json",
      bounded,
    )
    resources.push(resource)
    return resource.ref
  })

  const derivedFileRefs = task.verification.flatMap(declaredRefsFromVerification)
  const declaredFileRefs = uniqueSorted(
    [...derivedFileRefs, ...(input.declaredFileRefs ?? [])].map((reference, index) =>
      portableRef(reference, `declaredFileRefs.${index}`),
    ),
  )
  const limitedFileRefs = [
    ...limitedItems("declaredFileRefs", declaredFileRefs, limits.maxDeclaredFileRefs, allocator),
  ]

  const dependencyOutputs = dependencyOutputList(
    task,
    input.dependencyOutputs ?? [],
    limits,
    allocator,
  )
  const parentContextRefs = uniqueSorted(
    limitedItems(
      "parentContextRefs",
      input.parentContextRefs ?? [],
      limits.maxParentContextRefs,
      allocator,
    ).map((reference, index) => portableRef(reference, `parentContextRefs.${index}`)),
  )
  const additionalInvariants = uniqueSorted(
    limitedItems(
      "additionalInvariants",
      (input.additionalInvariants ?? []).map((value) => value.trim()).filter(Boolean),
      limits.maxAdditionalInvariants,
      allocator,
    ).map(
      (value, index) =>
        allocator.materialize(`additionalInvariant:${index + 1}`, value, limits.maxTaskFieldBytes)
          .content,
    ),
  )

  let fullPrd: ContextManifest["fullPrd"]
  if (input.mode === "wiggum") {
    const resource = await fullPrdResource(document, input.workspaceRoot, allocator, limits)
    resources.push(resource)
    fullPrd = { ref: resource.ref, contentHash: resource.contentHash }
  }

  const createdAt = input.createdAt ?? new Date().toISOString()
  const contextBudget: ContextBudget = {
    ...(task.budget?.maxTotalTokens !== undefined
      ? { maxTotalTokens: task.budget.maxTotalTokens }
      : {}),
    ...(task.budget?.maxCost !== undefined ? { maxCost: task.budget.maxCost } : {}),
    ...(task.budget?.taskTimeout !== undefined ? { taskTimeout: task.budget.taskTimeout } : {}),
    // Command-resolved values override task-only defaults after combining the
    // task and executor profile with the most restrictive bound.
    ...input.budget,
  }
  const unhashed = {
    schemaVersion: 1 as const,
    runId: input.runId,
    attemptId: input.attemptId,
    mode: input.mode,
    sharedContext: sharedContext.content,
    ...(fullPrd ? { fullPrd } : {}),
    task: {
      documentId: document.id,
      taskId: task.id,
      title: title.content,
      result: result.content,
      criteria,
      boundaries,
      ...(notes ? { notes } : {}),
      evidenceMode: task.evidenceMode,
      verificationRefs,
      taskSpecHash: task.taskSpecHash,
    },
    invariants: [...FIXED_INVARIANTS, ...additionalInvariants],
    parentContextRefs,
    dependencyOutputs,
    declaredFileRefs: limitedFileRefs,
    ...(previousAssessmentRef ? { previousAssessmentRef } : {}),
    ...(input.contextRotation ? { contextRotation: input.contextRotation } : {}),
    ...(revisionFeedback ? { revisionFeedback } : {}),
    ...(recovery ? { recovery } : {}),
    baseline: input.baseline,
    budget: contextBudget,
    authority: {
      taskSelection: "ralph" as const,
      taskCompletion: "ralph-policy" as const,
      subPrdCreation: "preauthored-only" as const,
    },
  }
  const projection = contextProjection(unhashed, resources, allocator.truncations)
  const canonicalJson = stableJson(projection)
  const contentHash = hashCanonicalValue("ralph.execution.context-bundle.v1", projection)
  const candidate = {
    ...unhashed,
    id: `context-${contentHash.slice(0, 24)}`,
    createdAt,
    contentHash,
  }

  let manifest: ContextManifest
  try {
    manifest = ContextManifestSchema.parse(candidate)
  } catch (error) {
    throw new ContextBuildError(
      "RALPH_CONTEXT_MANIFEST_INVALID",
      "The materialized context does not satisfy the S03 manifest contract.",
      { issues: schemaIssues(error) },
    )
  }
  return {
    manifest,
    resources: [...resources].sort((left, right) => compareText(left.ref, right.ref)),
    truncations: [...allocator.truncations],
    canonicalJson,
  }
}

export function contextManifestBundleHash(bundle: ContextManifestBundle): string {
  return hashCanonicalValue(
    "ralph.execution.context-bundle.v1",
    contextProjection(bundle.manifest, bundle.resources, bundle.truncations),
  )
}

export function canonicalContextManifestBundle(bundle: ContextManifestBundle): string {
  return stableJson(contextProjection(bundle.manifest, bundle.resources, bundle.truncations))
}
