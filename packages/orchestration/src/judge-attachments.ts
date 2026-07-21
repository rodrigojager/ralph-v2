import { lstat } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"

import type { EvidenceBundle } from "@ralph/domain"
import type { JudgeTextAttachmentInput } from "@ralph/evaluation"
import { readVerifiedContentReference } from "@ralph/verification"
import { z } from "zod"

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

const WorkspaceFileSnapshotSchema = z
  .object({
    kind: z.enum(["file", "symlink"]),
    sha256: Sha256Schema,
    size: z.number().int().nonnegative(),
    retentionStatus: z.enum([
      "retained",
      "inventory-only",
      "out-of-scope",
      "sensitive",
      "per-file-limit",
      "total-limit",
      "control-plane",
    ]),
    contentRef: z.string().min(1).optional(),
  })
  .strict()

const WorkspaceDiffManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    mediaType: z.literal("application/vnd.ralph.workspace-diff+json"),
    kind: z.enum(["task", "attempt", "gate"]),
    runId: z.string().min(1),
    attemptId: z.string().min(1),
    files: z.array(
      z
        .object({
          path: z.string().min(1),
          before: WorkspaceFileSnapshotSchema.nullable(),
          after: WorkspaceFileSnapshotSchema.nullable(),
        })
        .strict(),
    ),
  })
  .passthrough()

type WorkspaceDiffManifest = z.infer<typeof WorkspaceDiffManifestSchema>
type AttachmentKind = JudgeTextAttachmentInput["kind"]

export type JudgeAttachmentMaterializationDiagnosticCode =
  | "attachment-count-limit"
  | "attachment-diff-manifest-invalid"
  | "attachment-non-text"
  | "attachment-not-found"
  | "attachment-ref-invalid"
  | "attachment-source-integrity"
  | "attachment-source-too-large"
  | "attachment-source-unavailable"
  | "attachment-total-limit"

export type JudgeAttachmentMaterializationDiagnostic = {
  code: JudgeAttachmentMaterializationDiagnosticCode
  attachmentId: string
  kind: AttachmentKind
  message: string
  sourceRef?: string
  path?: string
}

const JUDGE_ATTACHMENT_INTEGRITY_CODES: ReadonlySet<JudgeAttachmentMaterializationDiagnosticCode> =
  new Set([
    "attachment-diff-manifest-invalid",
    "attachment-ref-invalid",
    "attachment-source-integrity",
  ])

/** Diagnostics that prove the persisted attachment identity or bytes cannot be trusted. */
export function isJudgeAttachmentIntegrityDiagnostic(
  diagnostic: JudgeAttachmentMaterializationDiagnostic,
): boolean {
  return (
    JUDGE_ATTACHMENT_INTEGRITY_CODES.has(diagnostic.code) ||
    (diagnostic.kind === "diff" && diagnostic.code === "attachment-non-text")
  )
}

export type JudgeAttachmentReadLimits = {
  /** Maximum number of attachment candidates admitted for materialization. */
  maxAttachments: number
  /** Maximum bytes read from any one immutable source object. */
  maxSourceBytes: number
  /** Maximum combined bytes read from distinct immutable source objects. */
  maxTotalSourceBytes: number
}

export const DEFAULT_JUDGE_ATTACHMENT_READ_LIMITS: Readonly<JudgeAttachmentReadLimits> =
  Object.freeze({
    maxAttachments: 64,
    maxSourceBytes: 1024 * 1024,
    maxTotalSourceBytes: 4 * 1024 * 1024,
  })

export type JudgeAttachmentSelection = {
  /** Defaults to both cumulative and attempt manifests. */
  diffScopes?: readonly ("cumulative" | "attempt")[]
  /** Defaults to all available before and after sides of changed files. */
  fileSides?: readonly ("before" | "after")[]
  /** Undefined selects every named artifact; an empty array selects none. */
  artifactIds?: readonly string[]
  /** Undefined selects every named gate; an empty array selects none. */
  gateIds?: readonly string[]
}

export type MaterializeJudgeTextAttachmentsInput = {
  workspaceRoot: string
  /** Must be the schema/hash-verified bundle read from Ralph persistence. */
  evidence: EvidenceBundle
  selection?: JudgeAttachmentSelection
  limits?: Partial<JudgeAttachmentReadLimits>
}

export type MaterializedJudgeTextAttachments = {
  attachments: JudgeTextAttachmentInput[]
  diagnostics: JudgeAttachmentMaterializationDiagnostic[]
  sourceBytesRead: number
}

const MAX_EVENT_ATTACHMENT_DIAGNOSTICS = 64
const MAX_EVENT_DIAGNOSTIC_CHARACTERS = 4_096

function boundedEventDiagnosticText(value: string): { text: string; truncated: boolean } {
  const characters = [...value]
  if (characters.length <= MAX_EVENT_DIAGNOSTIC_CHARACTERS) {
    return { text: value, truncated: false }
  }
  return {
    text: `${characters.slice(0, MAX_EVENT_DIAGNOSTIC_CHARACTERS - 12).join("")} [truncated]`,
    truncated: true,
  }
}

/** Bounded durable projection; the full in-memory list still controls integrity and judge input. */
export function judgeAttachmentMaterializationEventPayload(
  materialized: MaterializedJudgeTextAttachments,
): Record<string, unknown> {
  let diagnosticTextTruncated = false
  const boundedText = (value: string): string => {
    const bounded = boundedEventDiagnosticText(value)
    diagnosticTextTruncated ||= bounded.truncated
    return bounded.text
  }
  const diagnostics = materialized.diagnostics
    .slice(0, MAX_EVENT_ATTACHMENT_DIAGNOSTICS)
    .map((diagnostic) => ({
      ...diagnostic,
      attachmentId: boundedText(diagnostic.attachmentId),
      message: boundedText(diagnostic.message),
      ...(diagnostic.sourceRef ? { sourceRef: boundedText(diagnostic.sourceRef) } : {}),
      ...(diagnostic.path ? { path: boundedText(diagnostic.path) } : {}),
    }))
  return {
    attachmentCount: materialized.attachments.length,
    sourceBytesRead: materialized.sourceBytesRead,
    diagnosticCount: materialized.diagnostics.length,
    integrityDiagnosticCount: materialized.diagnostics.filter(isJudgeAttachmentIntegrityDiagnostic)
      .length,
    diagnostics,
    diagnosticsTruncated: diagnostics.length < materialized.diagnostics.length,
    diagnosticTextTruncated,
  }
}

type SourceRequest = {
  attachmentId: string
  kind: AttachmentKind
  sourceRef: string
  expectedHash: string
  expectedSize?: number
  path?: string
}

type ReadText = { text: string; byteLength: number }

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"))
}

function effectiveLimits(input?: Partial<JudgeAttachmentReadLimits>): JudgeAttachmentReadLimits {
  const output = { ...DEFAULT_JUDGE_ATTACHMENT_READ_LIMITS, ...input }
  for (const [name, value] of Object.entries(output)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Judge attachment read limit ${name} must be a positive safe integer`)
    }
  }
  return output
}

function contentHashFromReference(reference: string): string | undefined {
  return /^([a-f0-9]{64})(?:\.|$)/.exec(basename(reference))?.[1]
}

function referenceUsesExpectedStore(
  runId: string,
  kind: AttachmentKind,
  reference: string,
  contentHash: string,
): boolean {
  if (reference.includes("\\")) return false
  const runPrefix = `.ralph/runs/${runId}/`
  const bucketAndFile = `/sha256/${contentHash.slice(0, 2)}/${basename(reference)}`
  if (!reference.endsWith(bucketAndFile)) return false
  switch (kind) {
    case "diff":
      return reference.startsWith(`${runPrefix}evidence/diffs/`)
    case "before-file":
    case "after-file":
    case "artifact":
      return reference.startsWith(`${runPrefix}artifacts/`)
    case "gate-output":
      return (
        reference.startsWith(`${runPrefix}raw/`) ||
        reference.startsWith(`${runPrefix}evidence/diffs/`)
      )
  }
}

function textualArtifactMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    [
      "application/json",
      "application/toml",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
    ].includes(mediaType.toLowerCase())
  )
}

function diagnostic(
  request: Pick<SourceRequest, "attachmentId" | "kind"> &
    Partial<Pick<SourceRequest, "sourceRef" | "path">>,
  code: JudgeAttachmentMaterializationDiagnosticCode,
  message: string,
): JudgeAttachmentMaterializationDiagnostic {
  return {
    code,
    attachmentId: request.attachmentId,
    kind: request.kind,
    message,
    ...(request.sourceRef ? { sourceRef: request.sourceRef } : {}),
    ...(request.path ? { path: request.path } : {}),
  }
}

async function referenceSizeWithoutSymlinks(
  workspaceRoot: string,
  runRoot: string,
  reference: string,
): Promise<number> {
  const target = resolve(workspaceRoot, reference)
  if (isAbsolute(reference) || !contained(workspaceRoot, target) || !contained(runRoot, target)) {
    throw new Error("reference is not contained in the evidence run")
  }

  const nested = relative(workspaceRoot, target)
  let cursor = workspaceRoot
  const segments = nested.split(sep).filter(Boolean)
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment)
    const metadata = await lstat(cursor)
    if (metadata.isSymbolicLink()) throw new Error("reference crosses a symbolic link")
    const final = index === segments.length - 1
    if (final && !metadata.isFile()) throw new Error("reference is not a regular file")
    if (!final && !metadata.isDirectory()) throw new Error("reference parent is not a directory")
    if (final) return metadata.size
  }
  throw new Error("reference does not identify a file")
}

function parseDiffManifest(
  text: string,
  evidence: EvidenceBundle,
  expectedKind: "task" | "attempt",
): WorkspaceDiffManifest | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const parsed = WorkspaceDiffManifestSchema.safeParse(value)
  if (!parsed.success) return undefined
  if (
    parsed.data.runId !== evidence.runId ||
    parsed.data.attemptId !== evidence.attemptId ||
    parsed.data.kind !== expectedKind
  ) {
    return undefined
  }
  return parsed.data
}

/**
 * Materializes only immutable text already referenced by a persisted evidence bundle.
 * It never reads the live project files and does not relax the evaluation builder's
 * independent identity/ref/hash validation.
 */
export async function materializeJudgeTextAttachments(
  input: MaterializeJudgeTextAttachmentsInput,
): Promise<MaterializedJudgeTextAttachments> {
  const limits = effectiveLimits(input.limits)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.evidence.runId)) {
    throw new Error(`Judge evidence run ID is not a safe path segment: ${input.evidence.runId}`)
  }
  const workspaceRoot = resolve(input.workspaceRoot)
  const runRoot = resolve(workspaceRoot, ".ralph", "runs", input.evidence.runId)
  const diagnostics: JudgeAttachmentMaterializationDiagnostic[] = []
  const attachments: JudgeTextAttachmentInput[] = []
  const cache = new Map<string, ReadText>()
  let candidates = 0
  let sourceBytesRead = 0

  const admit = (request: Pick<SourceRequest, "attachmentId" | "kind" | "sourceRef" | "path">) => {
    if (candidates >= limits.maxAttachments) {
      diagnostics.push(
        diagnostic(
          request,
          "attachment-count-limit",
          `Attachment omitted after reaching the ${limits.maxAttachments}-candidate limit`,
        ),
      )
      return false
    }
    candidates += 1
    return true
  }

  const readText = async (request: SourceRequest): Promise<ReadText | undefined> => {
    const expectedReferenceHash = contentHashFromReference(request.sourceRef)
    if (
      !expectedReferenceHash ||
      expectedReferenceHash !== request.expectedHash ||
      !referenceUsesExpectedStore(
        input.evidence.runId,
        request.kind,
        request.sourceRef,
        request.expectedHash,
      )
    ) {
      diagnostics.push(
        diagnostic(
          request,
          "attachment-ref-invalid",
          "Attachment reference is not content-addressed by the expected SHA-256",
        ),
      )
      return undefined
    }
    const cacheKey = `${request.sourceRef}\0${request.expectedHash}`
    const cached = cache.get(cacheKey)
    if (cached) {
      if (request.expectedSize === undefined || request.expectedSize === cached.byteLength) {
        return cached
      }
      diagnostics.push(
        diagnostic(
          request,
          "attachment-source-integrity",
          `Attachment source size does not match evidence (${cached.byteLength} != ${request.expectedSize})`,
        ),
      )
      return undefined
    }

    let sourceSize: number
    try {
      sourceSize = await referenceSizeWithoutSymlinks(workspaceRoot, runRoot, request.sourceRef)
    } catch (error) {
      diagnostics.push(
        diagnostic(
          request,
          "attachment-ref-invalid",
          `Attachment reference was rejected: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      return undefined
    }
    if (request.expectedSize !== undefined && sourceSize !== request.expectedSize) {
      diagnostics.push(
        diagnostic(
          request,
          "attachment-source-integrity",
          `Attachment source size does not match evidence (${sourceSize} != ${request.expectedSize})`,
        ),
      )
      return undefined
    }
    if (sourceSize > limits.maxSourceBytes) {
      diagnostics.push(
        diagnostic(
          request,
          "attachment-source-too-large",
          `Attachment source is ${sourceSize} bytes and exceeds the ${limits.maxSourceBytes}-byte per-source limit`,
        ),
      )
      return undefined
    }
    if (sourceBytesRead + sourceSize > limits.maxTotalSourceBytes) {
      diagnostics.push(
        diagnostic(
          request,
          "attachment-total-limit",
          `Attachment source would exceed the ${limits.maxTotalSourceBytes}-byte total read limit`,
        ),
      )
      return undefined
    }
    sourceBytesRead += sourceSize

    let bytes: Uint8Array
    try {
      bytes = await readVerifiedContentReference(
        workspaceRoot,
        request.sourceRef,
        request.expectedHash,
        sourceSize,
      )
      await referenceSizeWithoutSymlinks(workspaceRoot, runRoot, request.sourceRef)
    } catch (error) {
      diagnostics.push(
        diagnostic(
          request,
          "attachment-source-integrity",
          `Attachment source failed integrity verification: ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      return undefined
    }

    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      diagnostics.push(
        diagnostic(request, "attachment-non-text", "Attachment source is not valid UTF-8 text"),
      )
      return undefined
    }
    if (text.includes("\0")) {
      diagnostics.push(
        diagnostic(request, "attachment-non-text", "Attachment source contains NUL bytes"),
      )
      return undefined
    }
    if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) {
      diagnostics.push(
        diagnostic(
          request,
          "attachment-non-text",
          "Attachment source cannot be losslessly represented as UTF-8 text",
        ),
      )
      return undefined
    }
    const result = { text, byteLength: bytes.byteLength }
    cache.set(cacheKey, result)
    return result
  }

  const diffScopes = uniqueSorted(input.selection?.diffScopes ?? ["cumulative", "attempt"])
  const fileSides = uniqueSorted(input.selection?.fileSides ?? ["before", "after"])
  const diffSources = {
    cumulative: {
      attachmentId: "00:diff:cumulative",
      kind: "diff" as const,
      scope: "cumulative" as const,
      sourceRef: input.evidence.changes.diffRef,
      expectedHash: input.evidence.changes.diffHash,
      expectedKind: "task" as const,
    },
    attempt: {
      attachmentId: "01:diff:attempt",
      kind: "diff" as const,
      scope: "attempt" as const,
      sourceRef: input.evidence.changes.attemptDiffRef,
      expectedHash: input.evidence.changes.attemptDiffHash,
      expectedKind: "attempt" as const,
    },
  }

  let cumulativeManifest: WorkspaceDiffManifest | undefined
  for (const scope of ["cumulative", "attempt"] as const) {
    const requestedAsAttachment = diffScopes.includes(scope)
    const neededForFiles = scope === "cumulative" && fileSides.length > 0
    if (!requestedAsAttachment && !neededForFiles) continue
    const source = diffSources[scope]
    if (!source.sourceRef || !source.expectedHash) {
      diagnostics.push(
        diagnostic(
          { attachmentId: source.attachmentId, kind: source.kind },
          "attachment-source-unavailable",
          `${scope} diff evidence has no immutable hash/reference pair`,
        ),
      )
      continue
    }
    const admitted = requestedAsAttachment
      ? admit({
          attachmentId: source.attachmentId,
          kind: source.kind,
          sourceRef: source.sourceRef,
        })
      : true
    if (!admitted && !neededForFiles) continue
    const materialized = await readText({
      attachmentId: source.attachmentId,
      kind: source.kind,
      sourceRef: source.sourceRef,
      expectedHash: source.expectedHash,
    })
    if (!materialized) continue
    const manifest = parseDiffManifest(materialized.text, input.evidence, source.expectedKind)
    if (!manifest) {
      diagnostics.push(
        diagnostic(
          {
            attachmentId: source.attachmentId,
            kind: source.kind,
            sourceRef: source.sourceRef,
          },
          "attachment-diff-manifest-invalid",
          `${scope} diff manifest failed schema or evidence identity validation`,
        ),
      )
      continue
    }
    if (scope === "cumulative") cumulativeManifest = manifest
    if (requestedAsAttachment && admitted) {
      attachments.push({
        id: source.attachmentId,
        kind: "diff",
        scope,
        sourceRef: source.sourceRef,
        contentHash: source.expectedHash,
        text: materialized.text,
      })
    }
  }

  if (fileSides.length > 0) {
    const manifestFiles = new Map(cumulativeManifest?.files.map((file) => [file.path, file]))
    for (const changed of [...input.evidence.changes.files].sort((left, right) =>
      left.path.localeCompare(right.path, "en"),
    )) {
      const manifestFile = manifestFiles.get(changed.path)
      for (const side of ["before", "after"] as const) {
        if (!fileSides.includes(side)) continue
        if (side === "before" && changed.kind === "created") continue
        if (side === "after" && changed.kind === "deleted") continue
        const path = side === "before" ? (changed.previousPath ?? changed.path) : changed.path
        const attachmentId = `${side === "before" ? "10" : "11"}:file:${side}:${path}`
        const kind = `${side}-file` as const
        const snapshot = manifestFile?.[side]
        if (!snapshot?.contentRef) {
          const missing = input.evidence.changes.missingContent.find(
            (entry) => entry.side === side && [changed.path, path].includes(entry.path),
          )
          diagnostics.push(
            diagnostic(
              { attachmentId, kind, path },
              "attachment-source-unavailable",
              missing?.reason ??
                (manifestFile
                  ? `No retained ${side} content reference is available`
                  : "Changed file is absent from the cumulative diff manifest"),
            ),
          )
          continue
        }
        const request = {
          attachmentId,
          kind,
          path,
          sourceRef: snapshot.contentRef,
          expectedHash: snapshot.sha256,
          expectedSize: snapshot.size,
        }
        if (!admit(request)) continue
        const materialized = await readText(request)
        if (!materialized) continue
        attachments.push({
          id: attachmentId,
          kind,
          path,
          sourceRef: snapshot.contentRef,
          contentHash: snapshot.sha256,
          text: materialized.text,
        })
      }
    }
  }

  const selectedArtifactIds =
    input.selection?.artifactIds === undefined
      ? undefined
      : new Set(uniqueSorted(input.selection.artifactIds))
  const selectedArtifacts = [...input.evidence.artifacts]
    .filter((artifact) => !selectedArtifactIds || selectedArtifactIds.has(artifact.artifactId))
    .sort((left, right) =>
      `${left.artifactId}\0${left.path}`.localeCompare(`${right.artifactId}\0${right.path}`, "en"),
    )
  if (selectedArtifactIds) {
    const available = new Set(input.evidence.artifacts.map((artifact) => artifact.artifactId))
    for (const artifactId of selectedArtifactIds) {
      if (available.has(artifactId)) continue
      diagnostics.push(
        diagnostic(
          { attachmentId: `20:artifact:${artifactId}`, kind: "artifact" },
          "attachment-not-found",
          `Requested artifact is not present in evidence: ${artifactId}`,
        ),
      )
    }
  }
  for (const artifact of selectedArtifacts) {
    const attachmentId = `20:artifact:${artifact.artifactId}:${artifact.path}`
    if (!artifact.immutableRef) {
      diagnostics.push(
        diagnostic(
          { attachmentId, kind: "artifact", path: artifact.path },
          "attachment-source-unavailable",
          artifact.reason ?? "Artifact evidence has no immutable content reference",
        ),
      )
      continue
    }
    const mediaType = "mediaType" in artifact ? artifact.mediaType : undefined
    if (mediaType && !textualArtifactMediaType(mediaType)) {
      diagnostics.push(
        diagnostic(
          {
            attachmentId,
            kind: "artifact",
            sourceRef: artifact.immutableRef,
            path: artifact.path,
          },
          "attachment-non-text",
          `Artifact media type is not textual: ${mediaType}`,
        ),
      )
      continue
    }
    const request = {
      attachmentId,
      kind: "artifact" as const,
      sourceRef: artifact.immutableRef,
      expectedHash: artifact.contentHash,
      expectedSize: artifact.sizeBytes,
      path: artifact.path,
    }
    if (!admit(request)) continue
    const materialized = await readText(request)
    if (!materialized) continue
    attachments.push({
      id: attachmentId,
      kind: "artifact",
      artifactId: artifact.artifactId,
      path: artifact.path,
      sourceRef: artifact.immutableRef,
      contentHash: artifact.contentHash,
      text: materialized.text,
    })
  }

  const selectedGateIds =
    input.selection?.gateIds === undefined
      ? undefined
      : new Set(uniqueSorted(input.selection.gateIds))
  const selectedGates = [...input.evidence.gates]
    .filter((gate) => !selectedGateIds || selectedGateIds.has(gate.gateId))
    .sort((left, right) => left.gateId.localeCompare(right.gateId, "en"))
  if (selectedGateIds) {
    const available = new Set(input.evidence.gates.map((gate) => gate.gateId))
    for (const gateId of selectedGateIds) {
      if (available.has(gateId)) continue
      diagnostics.push(
        diagnostic(
          { attachmentId: `30:gate:${gateId}`, kind: "gate-output" },
          "attachment-not-found",
          `Requested gate is not present in evidence: ${gateId}`,
        ),
      )
    }
  }
  for (const gate of selectedGates) {
    const refs = uniqueSorted(gate.outputRefs)
    for (const [index, sourceRef] of refs.entries()) {
      const attachmentId = `30:gate:${gate.gateId}:${index + 1}`
      const expectedHash = contentHashFromReference(sourceRef)
      if (!expectedHash) {
        diagnostics.push(
          diagnostic(
            { attachmentId, kind: "gate-output", sourceRef },
            "attachment-ref-invalid",
            "Gate output reference is not content-addressed",
          ),
        )
        continue
      }
      const request = {
        attachmentId,
        kind: "gate-output" as const,
        sourceRef,
        expectedHash,
      }
      if (!admit(request)) continue
      const materialized = await readText(request)
      if (!materialized) continue
      attachments.push({
        id: attachmentId,
        kind: "gate-output",
        gateId: gate.gateId,
        sourceRef,
        contentHash: expectedHash,
        text: materialized.text,
      })
    }
  }

  return {
    attachments: attachments.sort((left, right) => left.id.localeCompare(right.id, "en")),
    diagnostics: diagnostics.sort((left, right) =>
      `${left.attachmentId}\0${left.code}`.localeCompare(
        `${right.attachmentId}\0${right.code}`,
        "en",
      ),
    ),
    sourceBytesRead,
  }
}
