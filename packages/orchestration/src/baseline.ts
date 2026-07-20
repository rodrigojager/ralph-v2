import { join } from "node:path"
import type { RunLayout } from "@ralph-next/persistence"
import { writeJsonAtomic } from "@ralph-next/persistence"
import { hashCanonicalValue } from "@ralph-next/prd"
import {
  type CaptureWorkspaceOptions,
  captureWorkspaceBaseline,
  verifyWorkspaceBaselineContent,
  type WorkspaceBaseline,
} from "@ralph-next/verification"
import { z } from "zod"

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

const WorkspaceBaselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    capturedAt: z.iso.datetime({ offset: true }),
    scope: z.string().min(1),
    files: z.record(
      z.string(),
      z
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
        .strict(),
    ),
    git: z
      .object({
        available: z.boolean(),
        dirty: z.boolean(),
        head: z.string().min(1).optional(),
        branch: z.string().min(1).optional(),
        statusHash: Sha256Schema.optional(),
      })
      .strict(),
    snapshotHash: Sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    for (const [path, file] of Object.entries(value.files)) {
      if ((file.retentionStatus === "retained") !== Boolean(file.contentRef)) {
        context.addIssue({
          code: "custom",
          message: "Only retained workspace facts may carry immutable content references",
          path: ["files", path, "contentRef"],
        })
      }
    }
  })

const TaskBaselineArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    documentId: z.string().min(1),
    taskId: z.string().min(1),
    baseline: WorkspaceBaselineSchema,
    contentHash: Sha256Schema,
  })
  .strict()

export type TaskBaselineArtifact = z.infer<typeof TaskBaselineArtifactSchema>

function baselineFileName(documentId: string, taskId: string): string {
  const digest = hashCanonicalValue("ralph.task-baseline-name.v1", { documentId, taskId })
  return `${digest}.json`
}

function baselineArtifact(input: {
  runId: string
  documentId: string
  taskId: string
  baseline: WorkspaceBaseline
}): TaskBaselineArtifact {
  const body = {
    schemaVersion: 1 as const,
    runId: input.runId,
    documentId: input.documentId,
    taskId: input.taskId,
    baseline: WorkspaceBaselineSchema.parse(input.baseline),
  }
  return TaskBaselineArtifactSchema.parse({
    ...body,
    contentHash: hashCanonicalValue("ralph.task-baseline.v1", body),
  })
}

export function taskBaselinePath(layout: RunLayout, documentId: string, taskId: string): string {
  return join(layout.evidence, "task-baselines", baselineFileName(documentId, taskId))
}

export async function loadTaskBaseline(
  layout: RunLayout,
  workspaceRoot: string,
  documentId: string,
  taskId: string,
  storageRoot = workspaceRoot,
): Promise<TaskBaselineArtifact | undefined> {
  const path = taskBaselinePath(layout, documentId, taskId)
  if (!(await Bun.file(path).exists())) return undefined
  const parsed = TaskBaselineArtifactSchema.parse(await Bun.file(path).json())
  if (parsed.documentId !== documentId || parsed.taskId !== taskId) {
    throw new Error(`Task baseline identity mismatch: ${documentId}/${taskId}`)
  }
  const { contentHash, ...body } = parsed
  const actual = hashCanonicalValue("ralph.task-baseline.v1", body)
  if (actual !== contentHash)
    throw new Error(`Task baseline hash mismatch: ${documentId}/${taskId}`)
  await verifyWorkspaceBaselineContent(storageRoot, parsed.baseline as WorkspaceBaseline)
  return parsed
}

export async function ensureTaskBaseline(input: {
  layout: RunLayout
  workspaceRoot: string
  runId: string
  documentId: string
  taskId: string
  capture?: CaptureWorkspaceOptions
  storageRoot?: string
}): Promise<TaskBaselineArtifact> {
  const existing = await loadTaskBaseline(
    input.layout,
    input.workspaceRoot,
    input.documentId,
    input.taskId,
    input.storageRoot,
  )
  if (existing) {
    if (existing.runId !== input.runId) {
      throw new Error(`Task baseline belongs to another run: ${input.documentId}/${input.taskId}`)
    }
    return existing
  }
  const artifact = baselineArtifact({
    runId: input.runId,
    documentId: input.documentId,
    taskId: input.taskId,
    baseline: await captureWorkspaceBaseline(input.workspaceRoot, {
      ...input.capture,
      objectStore: { directory: input.layout.artifacts },
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
    }),
  })
  const path = taskBaselinePath(input.layout, input.documentId, input.taskId)
  await writeJsonAtomic(path, artifact, { overwrite: false })
  return (await loadTaskBaseline(
    input.layout,
    input.workspaceRoot,
    input.documentId,
    input.taskId,
    input.storageRoot,
  )) as TaskBaselineArtifact
}
