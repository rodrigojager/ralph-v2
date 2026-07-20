import { createHash } from "node:crypto"
import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { EXIT_CODES, RalphError } from "@ralph-next/domain"
import {
  appendEvent,
  flushOutbox,
  inspectWorkspace,
  loadEffectiveConfig,
  workspaceLayout,
} from "@ralph-next/persistence"
import {
  type CompiledPrdGraph,
  compilePrdGraph,
  type PrdDocument,
  type PrdTask,
  type TaskRef,
  updateTaskMarker,
} from "@ralph-next/prd"

const MAX_MANUAL_EVIDENCE_BYTES = 64 * 1_048_576

export type TaskListFilter = "all" | "pending" | "completed" | "review"

export type TaskListRow = {
  readonly index: number
  readonly ref: string
  readonly documentId: string
  readonly taskId: string
  readonly title: string
  readonly status: PrdTask["status"]
  readonly eligible: boolean
  readonly dependencies: readonly string[]
  readonly subPrd?: string
  readonly taskSpecHash: string
}

export type ManualTaskCompletion = {
  readonly schemaVersion: 1
  readonly ref: string
  readonly previousStatus: PrdTask["status"]
  readonly status: "completed"
  readonly changed: boolean
  readonly override: true
  readonly automaticEvaluationChanged: false
  readonly reason: string
  readonly evidence: readonly {
    readonly path: string
    readonly sha256: string
    readonly bytes: number
  }[]
  readonly auditEvents: readonly string[]
  readonly contentHash: string
}

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function isContained(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
}

function graphRows(graph: CompiledPrdGraph): TaskListRow[] {
  const eligible = new Set(graph.eligibleTasks.map((task) => `${task.documentId}/${task.taskId}`))
  return graph.topologicalOrder.map((reference, index) => {
    const document = graph.documents[reference.documentId]
    const task = document?.tasks.find((candidate) => candidate.id === reference.taskId)
    if (!document || !task) {
      throw new RalphError(
        "RALPH_TASK_GRAPH_INCONSISTENT",
        `Compiled graph references a missing task: ${reference.documentId}/${reference.taskId}`,
        { exitCode: EXIT_CODES.invalidPrd },
      )
    }
    return {
      index: index + 1,
      ref: `${reference.documentId}/${reference.taskId}`,
      documentId: reference.documentId,
      taskId: reference.taskId,
      title: task.title,
      status: task.status,
      eligible: eligible.has(`${reference.documentId}/${reference.taskId}`),
      dependencies: task.dependencies.map((dependency) =>
        dependency.includes("/") ? dependency : `${reference.documentId}/${dependency}`,
      ),
      ...(task.subPrd ? { subPrd: task.subPrd } : {}),
      taskSpecHash: task.taskSpecHash,
    }
  })
}

export async function compileOperationalPrd(
  workspaceRoot: string,
  prdPath = "PRD.md",
): Promise<CompiledPrdGraph> {
  const absolute = resolve(workspaceRoot, prdPath)
  const result = await compilePrdGraph(absolute, { workspaceRoot, recursive: true })
  if (!result.ok || !result.graph) {
    throw new RalphError("RALPH_PRD_INVALID", "PRD graph is invalid", {
      exitCode: EXIT_CODES.invalidPrd,
      file: absolute,
      details: { diagnostics: result.diagnostics },
    })
  }
  return result.graph
}

export function listOperationalTasks(
  graph: CompiledPrdGraph,
  filter: TaskListFilter,
): TaskListRow[] {
  const rows = graphRows(graph)
  if (filter === "all") return rows
  const status = filter === "review" ? "active" : filter
  return rows.filter((row) => row.status === status)
}

export function nextOperationalTask(graph: CompiledPrdGraph): TaskListRow | null {
  const next = graph.eligibleTasks[0]
  if (!next) return null
  return graphRows(graph).find((row) => row.ref === `${next.documentId}/${next.taskId}`) ?? null
}

function taskByReference(
  graph: CompiledPrdGraph,
  requested: string,
): { reference: TaskRef; document: PrdDocument; task: PrdTask } {
  const rows = graphRows(graph)
  let row: TaskListRow | undefined
  if (requested === "next") row = nextOperationalTask(graph) ?? undefined
  else if (/^[1-9]\d*$/.test(requested)) row = rows[Number(requested) - 1]
  else if (requested.includes("/")) row = rows.find((candidate) => candidate.ref === requested)
  else {
    const matches = rows.filter((candidate) => candidate.taskId === requested)
    if (matches.length > 1) {
      throw new RalphError(
        "RALPH_TASK_REFERENCE_AMBIGUOUS",
        `Task ID is present in more than one PRD document: ${requested}`,
        {
          exitCode: EXIT_CODES.invalidUsage,
          hint: `Use one of: ${matches.map((candidate) => candidate.ref).join(", ")}`,
        },
      )
    }
    row = matches[0]
  }
  if (!row) {
    throw new RalphError("RALPH_TASK_NOT_FOUND", `Task was not found: ${requested}`, {
      exitCode: EXIT_CODES.invalidUsage,
    })
  }
  const document = graph.documents[row.documentId]
  const task = document?.tasks.find((candidate) => candidate.id === row?.taskId)
  const reference = graph.topologicalOrder.find(
    (candidate) => candidate.documentId === row?.documentId && candidate.taskId === row?.taskId,
  )
  if (!document || !task || !reference) {
    throw new RalphError("RALPH_TASK_GRAPH_INCONSISTENT", `Task graph lost ${row.ref}`, {
      exitCode: EXIT_CODES.invalidPrd,
    })
  }
  return { reference, document, task }
}

function assertChildPrdComplete(graph: CompiledPrdGraph, reference: TaskRef): void {
  const child = graph.childEdges.find(
    (edge) =>
      edge.parentTask.documentId === reference.documentId &&
      edge.parentTask.taskId === reference.taskId,
  )
  if (!child) return
  const document = graph.documents[child.childDocument]
  const unfinished = document?.tasks.filter((task) => task.status !== "completed") ?? []
  if (unfinished.length > 0) {
    throw new RalphError(
      "RALPH_TASK_CHILD_PRD_INCOMPLETE",
      `Parent task cannot be manually completed while child PRD ${child.childDocument} has unfinished work`,
      {
        exitCode: EXIT_CODES.blocked,
        details: { unfinished: unfinished.map((task) => task.id) },
      },
    )
  }
}

async function inspectEvidence(
  workspaceRoot: string,
  paths: readonly string[],
): Promise<ManualTaskCompletion["evidence"]> {
  const output: Array<{ path: string; sha256: string; bytes: number }> = []
  for (const requested of paths) {
    const absolute = resolve(workspaceRoot, requested)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(absolute)
    } catch (error) {
      throw new RalphError(
        "RALPH_TASK_EVIDENCE_NOT_FOUND",
        `Manual completion evidence was not found: ${requested}`,
        { exitCode: EXIT_CODES.invalidUsage, file: absolute, cause: error },
      )
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new RalphError(
        "RALPH_TASK_EVIDENCE_UNSAFE",
        `Manual completion evidence must be a regular non-linked file: ${requested}`,
        { exitCode: EXIT_CODES.policyDenied, file: absolute },
      )
    }
    if (info.size > MAX_MANUAL_EVIDENCE_BYTES) {
      throw new RalphError(
        "RALPH_TASK_EVIDENCE_TOO_LARGE",
        `Manual completion evidence exceeds ${MAX_MANUAL_EVIDENCE_BYTES} bytes: ${requested}`,
        { exitCode: EXIT_CODES.policyDenied, file: absolute, details: { bytes: info.size } },
      )
    }
    const canonical = await realpath(absolute)
    if (!isContained(workspaceRoot, canonical)) {
      throw new RalphError(
        "RALPH_TASK_EVIDENCE_OUTSIDE_WORKSPACE",
        `Manual completion evidence resolves outside the workspace: ${requested}`,
        { exitCode: EXIT_CODES.policyDenied, file: absolute },
      )
    }
    const bytes = await readFile(canonical)
    output.push({
      path: portable(relative(workspaceRoot, canonical)),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    })
  }
  return output
}

export async function completeOperationalTask(input: {
  readonly workspaceRoot: string
  readonly prdPath: string
  readonly requested: string
  readonly force: boolean
  readonly reason?: string
  readonly evidencePaths: readonly string[]
  readonly environment: Readonly<Record<string, string | undefined>>
}): Promise<ManualTaskCompletion> {
  const workspace = await inspectWorkspace(input.workspaceRoot, { exact: true })
  if (!workspace.initialized || !workspace.workspaceId) {
    throw new RalphError(
      "RALPH_TASK_OVERRIDE_WORKSPACE_REQUIRED",
      "tasks done requires an initialized Ralph v2 workspace so the override can be audited",
      {
        exitCode: EXIT_CODES.blocked,
        hint: "Run `ralph-next init`, then repeat the manual completion command.",
      },
    )
  }
  if (input.evidencePaths.length === 0 && (!input.force || !input.reason?.trim())) {
    throw new RalphError(
      "RALPH_TASK_OVERRIDE_PROOF_REQUIRED",
      "Manual completion requires at least one --evidence file, or --force with a non-empty --reason",
      { exitCode: EXIT_CODES.policyDenied },
    )
  }
  const graph = await compileOperationalPrd(input.workspaceRoot, input.prdPath)
  const selected = taskByReference(graph, input.requested)
  assertChildPrdComplete(graph, selected.reference)
  const evidence = await inspectEvidence(input.workspaceRoot, input.evidencePaths)
  const reason = input.reason?.trim() || "Manual completion backed by explicit evidence files"
  const layout = workspaceLayout(workspace.root)
  const eventRetention = (
    await loadEffectiveConfig({
      workspaceConfig: layout.config,
      environment: { ...input.environment },
    })
  ).config.telemetry.event_retention
  const streamId = `task:${selected.reference.documentId}/${selected.reference.taskId}`
  const requestedEvent = appendEvent(layout.ledger, {
    type: "task.manual-completion.requested",
    scope: "workspace",
    streamId,
    workspaceId: workspace.workspaceId,
    eventRetention,
    documentId: selected.reference.documentId,
    taskId: selected.reference.taskId,
    payload: {
      override: true,
      automaticEvaluationChanged: false,
      previousStatus: selected.task.status,
      expectedContentHash: selected.document.contentHash,
      taskSpecHash: selected.task.taskSpecHash,
      reason,
      evidence,
      forcedWithoutEvidence: evidence.length === 0,
    },
  })
  await flushOutbox(layout)

  const canonicalPrd = graph.canonicalReferences[selected.reference.documentId]
  if (!canonicalPrd) {
    throw new RalphError(
      "RALPH_TASK_DOCUMENT_PATH_MISSING",
      `Compiled graph has no canonical path for ${selected.reference.documentId}`,
      { exitCode: EXIT_CODES.invalidPrd },
    )
  }
  const marker = await updateTaskMarker(resolve(input.workspaceRoot, canonicalPrd), {
    file: selected.document.file,
    taskId: selected.task.id,
    status: "completed",
    expectedContentHash: selected.document.contentHash,
    expectedStatus: selected.task.status,
    inheritedDefaults: selected.document.defaults,
  })
  const appliedEvent = appendEvent(layout.ledger, {
    type: "task.manual-completion.applied",
    scope: "workspace",
    streamId,
    workspaceId: workspace.workspaceId,
    eventRetention,
    documentId: selected.reference.documentId,
    taskId: selected.reference.taskId,
    payload: {
      override: true,
      automaticEvaluationChanged: false,
      previousStatus: marker.previousStatus,
      status: marker.status,
      changed: marker.changed,
      contentHash: marker.contentHash,
      requestEventId: requestedEvent.eventId,
      reason,
      evidence,
    },
  })
  await flushOutbox(layout)
  return {
    schemaVersion: 1,
    ref: `${selected.reference.documentId}/${selected.reference.taskId}`,
    previousStatus: selected.task.status,
    status: "completed",
    changed: marker.changed,
    override: true,
    automaticEvaluationChanged: false,
    reason,
    evidence,
    auditEvents: [requestedEvent.eventId, appliedEvent.eventId],
    contentHash: marker.contentHash,
  }
}
