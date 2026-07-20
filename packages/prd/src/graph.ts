import { realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { Diagnostic } from "@ralph-next/domain"
import {
  type ChildEdgeSchema,
  type CompiledPrdGraph,
  CompiledPrdGraphSchema,
  type DependencyEdgeSchema,
  type PrdCompilationResult,
  type PrdDocument,
  type PrdTask,
  type TaskDefaults,
  type TaskRef,
} from "./contracts"
import { computeGraphDefinitionHash, computeGraphHash } from "./identity"
import { parsePrdFileInternal } from "./parser"

export { stableJson } from "./identity"

type DependencyEdge = typeof DependencyEdgeSchema._output
type ChildEdge = typeof ChildEdgeSchema._output

export type CompilePrdGraphOptions = {
  workspaceRoot?: string
  recursive?: boolean
  strict?: boolean
  maxDepth?: number
  maxDocuments?: number
}

type LoadedDocument = {
  document: PrdDocument
  canonicalPath: string
}

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (!child.startsWith("..") && !isAbsolute(child))
}

function displayPath(root: string, target: string): string {
  const child = portable(relative(root, target))
  return child || portable(target.split(/[\\/]/).at(-1) ?? target)
}

function taskRef(documentId: string, task: PrdTask): TaskRef {
  return { documentId, taskId: task.id, taskSpecHash: task.taskSpecHash }
}

function refKey(reference: TaskRef): string {
  return `${reference.documentId}/${reference.taskId}`
}

function taskLocation(document: PrdDocument, taskId: string): Pick<Diagnostic, "line" | "column"> {
  const point = document.sourceMap[taskId]?.taskStart
  return point ? { line: point.line, column: point.column } : {}
}

function addDiagnostic(
  diagnostics: Diagnostic[],
  code: string,
  message: string,
  options: {
    file?: string
    task?: { document: PrdDocument; taskId: string }
    hint?: string
    severity?: Diagnostic["severity"]
    details?: Record<string, unknown>
  } = {},
): void {
  diagnostics.push({
    code,
    severity: options.severity ?? "error",
    message,
    ...(options.file ? { file: options.file } : {}),
    ...(options.task
      ? {
          file: options.task.document.file,
          ...taskLocation(options.task.document, options.task.taskId),
        }
      : {}),
    ...(options.hint ? { hint: options.hint } : {}),
    ...(options.details ? { details: options.details } : {}),
  })
}

function dependencyOrder(document: PrdDocument, diagnostics: Diagnostic[]): PrdTask[] | undefined {
  const tasks = new Map(document.tasks.map((task) => [task.id, task]))
  const inDegree = new Map(document.tasks.map((task) => [task.id, 0]))
  const dependents = new Map(document.tasks.map((task) => [task.id, [] as string[]]))
  let valid = true
  for (const task of document.tasks) {
    for (const dependency of task.dependencies) {
      if (dependency === task.id) {
        addDiagnostic(
          diagnostics,
          "RALPH_PRD_DEPENDENCY_SELF",
          `Task ${task.id} cannot depend on itself`,
          { task: { document, taskId: task.id } },
        )
        valid = false
        continue
      }
      if (!tasks.has(dependency)) {
        addDiagnostic(
          diagnostics,
          "RALPH_PRD_DEPENDENCY_MISSING",
          `Task ${task.id} depends on missing local task ${dependency}`,
          {
            task: { document, taskId: task.id },
            hint: "Dependencies in PRD v2 are task IDs from the same document.",
          },
        )
        valid = false
        continue
      }
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1)
      dependents.get(dependency)?.push(task.id)
    }
  }
  if (!valid) return undefined
  const authoredIndex = new Map(document.tasks.map((task, index) => [task.id, index]))
  const queue = document.tasks.filter((task) => inDegree.get(task.id) === 0)
  const output: PrdTask[] = []
  while (queue.length > 0) {
    queue.sort(
      (left, right) => (authoredIndex.get(left.id) ?? 0) - (authoredIndex.get(right.id) ?? 0),
    )
    const task = queue.shift()
    if (!task) break
    output.push(task)
    for (const dependent of dependents.get(task.id) ?? []) {
      const next = (inDegree.get(dependent) ?? 0) - 1
      inDegree.set(dependent, next)
      if (next === 0) {
        const dependentTask = tasks.get(dependent)
        if (dependentTask) queue.push(dependentTask)
      }
    }
  }
  if (output.length !== document.tasks.length) {
    const cycle = document.tasks.filter((task) => !output.some((item) => item.id === task.id))
    for (const task of cycle) {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_DEPENDENCY_CYCLE",
        `Task participates in a dependency cycle: ${task.id}`,
        { task: { document, taskId: task.id } },
      )
    }
    return undefined
  }
  return output
}

function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error")
}

function graphProjection(
  rootDocumentId: string,
  rootFile: string,
  definitionHash: string,
  documents: Record<string, PrdDocument>,
  canonicalReferences: Record<string, string>,
  dependencyEdges: DependencyEdge[],
  childEdges: ChildEdge[],
  topologicalOrder: TaskRef[],
  eligibleTasks: TaskRef[],
  parallelGroups: CompiledPrdGraph["parallelGroups"],
): unknown {
  return {
    schemaVersion: 1,
    rootDocumentId,
    rootFile,
    definitionHash,
    documents: Object.fromEntries(
      Object.entries(documents).map(([id, document]) => [
        id,
        {
          id: document.id,
          file: document.file,
          contentHash: document.contentHash,
          definitionHash: document.definitionHash,
          parent: document.parent,
          defaults: document.defaults,
          sharedContext: document.sharedContext,
          tasks: document.tasks,
          metadata: document.metadata,
        },
      ]),
    ),
    canonicalReferences,
    dependencyEdges,
    childEdges,
    topologicalOrder,
    eligibleTasks,
    parallelGroups,
  }
}

export async function compilePrdGraph(
  rootFile: string,
  options: CompilePrdGraphOptions = {},
): Promise<PrdCompilationResult> {
  const diagnostics: Diagnostic[] = []
  const recursive = options.recursive ?? true
  const maxDepth = options.maxDepth ?? 8
  const maxDocuments = options.maxDocuments ?? 100
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    addDiagnostic(diagnostics, "RALPH_PRD_MAX_DEPTH_INVALID", "maxDepth must be non-negative")
    return { ok: false, diagnostics }
  }
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1) {
    addDiagnostic(diagnostics, "RALPH_PRD_MAX_DOCUMENTS_INVALID", "maxDocuments must be positive")
    return { ok: false, diagnostics }
  }

  let workspaceCanonical: string
  let rootCanonical: string
  try {
    workspaceCanonical = await realpath(
      resolve(options.workspaceRoot ?? dirname(resolve(rootFile))),
    )
  } catch (error) {
    addDiagnostic(diagnostics, "RALPH_PRD_WORKSPACE_NOT_FOUND", "Workspace root does not exist", {
      details: { reason: error instanceof Error ? error.message : String(error) },
    })
    return { ok: false, diagnostics }
  }
  try {
    rootCanonical = await realpath(resolve(rootFile))
  } catch (error) {
    addDiagnostic(diagnostics, "RALPH_PRD_ROOT_NOT_FOUND", "Root PRD does not exist", {
      file: portable(rootFile),
      details: { reason: error instanceof Error ? error.message : String(error) },
    })
    return { ok: false, diagnostics }
  }
  if (!isContained(workspaceCanonical, rootCanonical)) {
    addDiagnostic(
      diagnostics,
      "RALPH_PRD_ROOT_OUTSIDE_WORKSPACE",
      "Root PRD resolves outside the allowed workspace",
      { file: portable(rootFile) },
    )
    return { ok: false, diagnostics }
  }

  const loadedByCanonical = new Map<string, LoadedDocument>()
  const canonicalById = new Map<string, string>()
  const documentOrder: LoadedDocument[] = []
  const childByParent = new Map<string, string>()

  const load = async (
    canonicalPath: string,
    inheritedDefaults: TaskDefaults | undefined,
    depth: number,
    ancestry: readonly string[],
    parent?: { document: PrdDocument; task: PrdTask },
  ): Promise<LoadedDocument | undefined> => {
    const file = displayPath(workspaceCanonical, canonicalPath)
    if (depth > maxDepth) {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_CHILD_MAX_DEPTH",
        `Sub-PRD depth exceeds configured maximum ${maxDepth}`,
        parent ? { task: { document: parent.document, taskId: parent.task.id } } : { file },
      )
      return undefined
    }
    if (ancestry.includes(canonicalPath)) {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_CHILD_CYCLE",
        `Sub-PRD cycle detected at ${file}`,
        parent ? { task: { document: parent.document, taskId: parent.task.id } } : { file },
      )
      return undefined
    }
    const existing = loadedByCanonical.get(canonicalPath)
    if (existing) {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_CHILD_MULTIPLE_PARENTS",
        `Sub-PRD is referenced more than once: ${file}`,
        parent ? { task: { document: parent.document, taskId: parent.task.id } } : { file },
      )
      return existing
    }
    if (documentOrder.length >= maxDocuments) {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_CHILD_MAX_DOCUMENTS",
        `PRD graph exceeds configured maximum ${maxDocuments}`,
        parent ? { task: { document: parent.document, taskId: parent.task.id } } : { file },
      )
      return undefined
    }
    const parsed = await parsePrdFileInternal(canonicalPath, {
      file,
      ...(inheritedDefaults ? { inheritedDefaults } : {}),
    })
    diagnostics.push(...parsed.diagnostics)
    const document = parsed.document
    if (!parsed.ok || !document) return undefined
    if (!parent && document.kind !== "root") {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_ROOT_KIND_INVALID",
        "Graph entry PRD must have kind root",
        {
          file: document.file,
        },
      )
    }
    if (parent && document.kind !== "child") {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_CHILD_KIND_INVALID",
        `Referenced Sub-PRD must have kind child: ${document.file}`,
        { task: { document: parent.document, taskId: parent.task.id } },
      )
    }
    const previousPath = canonicalById.get(document.id)
    if (previousPath && previousPath !== canonicalPath) {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_DOCUMENT_ID_DUPLICATED",
        `Document ID is used by multiple files: ${document.id}`,
        { file: document.file },
      )
    }
    if (ancestry.some((ancestor) => loadedByCanonical.get(ancestor)?.document.id === document.id)) {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_DOCUMENT_ID_CYCLE",
        `Document ID repeats in its ancestry: ${document.id}`,
        { file: document.file },
      )
    }
    const loaded = { document, canonicalPath }
    loadedByCanonical.set(canonicalPath, loaded)
    canonicalById.set(document.id, canonicalPath)
    documentOrder.push(loaded)

    if (parent) {
      const parentKey = refKey(taskRef(parent.document.id, parent.task))
      childByParent.set(parentKey, document.id)
      if (!document.parent) {
        addDiagnostic(
          diagnostics,
          "RALPH_PRD_CHILD_PARENT_MISSING",
          `Child document ${document.id} has no parent reference`,
          { file: document.file },
        )
      } else {
        let declaredParent: string | undefined
        try {
          declaredParent = await realpath(resolve(dirname(canonicalPath), document.parent.prd))
        } catch {
          addDiagnostic(
            diagnostics,
            "RALPH_PRD_CHILD_PARENT_FILE_MISSING",
            `Child parent.prd does not resolve to an existing file: ${document.parent.prd}`,
            { file: document.file },
          )
        }
        if (declaredParent && declaredParent !== parentByPath(parent.document, loadedByCanonical)) {
          addDiagnostic(
            diagnostics,
            "RALPH_PRD_CHILD_PARENT_MISMATCH",
            `Child ${document.id} points to a different parent PRD`,
            { file: document.file },
          )
        }
        if (document.parent.task !== parent.task.id) {
          addDiagnostic(
            diagnostics,
            "RALPH_PRD_CHILD_PARENT_TASK_MISMATCH",
            `Child ${document.id} parent.task must be ${parent.task.id}`,
            { file: document.file },
          )
        }
      }
    }

    if (!recursive) {
      for (const task of document.tasks.filter((candidate) => candidate.subPrd)) {
        addDiagnostic(
          diagnostics,
          "RALPH_PRD_CHILD_NOT_EXPANDED",
          `Sub-PRD was not compiled without recursive mode: ${task.subPrd}`,
          {
            severity: "warning",
            task: { document, taskId: task.id },
            hint: "Use recursive validation before execution.",
          },
        )
      }
      return loaded
    }

    for (const task of document.tasks) {
      if (!task.subPrd) continue
      const candidate = resolve(dirname(canonicalPath), task.subPrd)
      let childCanonical: string
      try {
        childCanonical = await realpath(candidate)
      } catch (error) {
        addDiagnostic(
          diagnostics,
          "RALPH_PRD_CHILD_MISSING",
          `Referenced Sub-PRD does not exist: ${task.subPrd}`,
          {
            task: { document, taskId: task.id },
            details: { reason: error instanceof Error ? error.message : String(error) },
          },
        )
        continue
      }
      if (!isContained(workspaceCanonical, childCanonical)) {
        addDiagnostic(
          diagnostics,
          "RALPH_PRD_CHILD_OUTSIDE_WORKSPACE",
          `Sub-PRD resolves outside the allowed workspace: ${task.subPrd}`,
          { task: { document, taskId: task.id } },
        )
        continue
      }
      await load(childCanonical, document.defaults, depth + 1, [...ancestry, canonicalPath], {
        document,
        task,
      })
    }
    return loaded
  }

  await load(rootCanonical, undefined, 0, [])
  if (hasErrors(diagnostics)) return { ok: false, diagnostics }
  const root = documentOrder[0]
  if (!root) return { ok: false, diagnostics }

  const dependencyEdges: DependencyEdge[] = []
  const childEdges: ChildEdge[] = []
  const localOrder = new Map<string, PrdTask[]>()
  for (const loaded of documentOrder) {
    const order = dependencyOrder(loaded.document, diagnostics)
    if (order) localOrder.set(loaded.document.id, order)
    for (const task of loaded.document.tasks) {
      for (const dependency of task.dependencies) {
        const dependencyTask = loaded.document.tasks.find(
          (candidate) => candidate.id === dependency,
        )
        if (!dependencyTask) continue
        dependencyEdges.push({
          task: taskRef(loaded.document.id, task),
          dependsOn: taskRef(loaded.document.id, dependencyTask),
        })
      }
      const childDocument = childByParent.get(refKey(taskRef(loaded.document.id, task)))
      if (childDocument) {
        childEdges.push({
          parentTask: taskRef(loaded.document.id, task),
          childDocument,
        })
      }
    }
  }
  if (hasErrors(diagnostics)) return { ok: false, diagnostics }

  const documentById = new Map(documentOrder.map((loaded) => [loaded.document.id, loaded.document]))
  const documentComplete = (document: PrdDocument): boolean =>
    document.tasks.every((task) => {
      if (task.status !== "completed") return false
      const childId = childByParent.get(refKey(taskRef(document.id, task)))
      const child = childId ? documentById.get(childId) : undefined
      return child ? documentComplete(child) : true
    })
  const taskComplete = (document: PrdDocument, task: PrdTask): boolean => {
    if (task.status !== "completed") return false
    const childId = childByParent.get(refKey(taskRef(document.id, task)))
    const child = childId ? documentById.get(childId) : undefined
    return child ? documentComplete(child) : true
  }

  for (const edge of childEdges) {
    const parentDocument = documentById.get(edge.parentTask.documentId)
    const parentTask = parentDocument?.tasks.find((task) => task.id === edge.parentTask.taskId)
    const child = documentById.get(edge.childDocument)
    if (parentDocument && parentTask?.status === "completed" && child && !documentComplete(child)) {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_PARENT_COMPLETED_CHILD_INCOMPLETE",
        `Parent task ${parentTask.id} is completed while its Sub-PRD still has incomplete tasks`,
        {
          task: { document: parentDocument, taskId: parentTask.id },
          hint: "Complete every child task before marking the parent task completed.",
          details: { childDocumentId: child.id },
        },
      )
    }
  }
  if (hasErrors(diagnostics)) return { ok: false, diagnostics }

  const expandedOrder: TaskRef[] = []
  const appendDocumentOrder = (document: PrdDocument): void => {
    for (const task of localOrder.get(document.id) ?? []) {
      const childId = childByParent.get(refKey(taskRef(document.id, task)))
      const child = childId ? documentById.get(childId) : undefined
      if (child) appendDocumentOrder(child)
      expandedOrder.push(taskRef(document.id, task))
    }
  }
  appendDocumentOrder(root.document)

  const eligibleTasks: TaskRef[] = []
  const collectEligible = (document: PrdDocument): void => {
    for (const task of localOrder.get(document.id) ?? []) {
      if (task.status === "completed") continue
      if (
        !task.dependencies.every((dependency) => {
          const dependencyTask = document.tasks.find((candidate) => candidate.id === dependency)
          return dependencyTask ? taskComplete(document, dependencyTask) : false
        })
      )
        continue
      const childId = childByParent.get(refKey(taskRef(document.id, task)))
      const child = childId ? documentById.get(childId) : undefined
      if (child && !documentComplete(child)) collectEligible(child)
      else eligibleTasks.push(taskRef(document.id, task))
    }
  }
  collectEligible(root.document)

  const parallelGroups: CompiledPrdGraph["parallelGroups"] = []
  for (const loaded of documentOrder) {
    const groups = new Map<string, TaskRef[]>()
    for (const task of loaded.document.tasks) {
      if (!task.parallelGroup) continue
      const members = groups.get(task.parallelGroup) ?? []
      members.push(taskRef(loaded.document.id, task))
      groups.set(task.parallelGroup, members)
    }
    for (const [id, tasks] of groups) {
      parallelGroups.push({ documentId: loaded.document.id, id, tasks })
    }
  }

  const documents = Object.fromEntries(documentOrder.map(({ document }) => [document.id, document]))
  const canonicalReferences = Object.fromEntries(
    documentOrder.map(({ document }) => [document.id, document.file]),
  )
  const definitionHash = computeGraphDefinitionHash({
    rootDocumentId: root.document.id,
    documents,
    dependencyEdges,
    childEdges,
    topologicalOrder: expandedOrder,
    parallelGroups,
  })
  const projection = graphProjection(
    root.document.id,
    root.document.file,
    definitionHash,
    documents,
    canonicalReferences,
    dependencyEdges,
    childEdges,
    expandedOrder,
    eligibleTasks,
    parallelGroups,
  )
  const candidate: CompiledPrdGraph = {
    schemaVersion: 1,
    rootDocumentId: root.document.id,
    rootFile: root.document.file,
    documents,
    canonicalReferences,
    dependencyEdges,
    childEdges,
    topologicalOrder: expandedOrder,
    eligibleTasks,
    parallelGroups,
    diagnostics,
    definitionHash,
    graphHash: computeGraphHash(projection),
  }
  const validated = CompiledPrdGraphSchema.safeParse(candidate)
  if (!validated.success) {
    for (const issue of validated.error.issues) {
      addDiagnostic(
        diagnostics,
        "RALPH_PRD_GRAPH_SCHEMA_INVALID",
        `Compiled graph is invalid: ${issue.message}`,
        { details: { path: issue.path.join(".") } },
      )
    }
    return { ok: false, diagnostics }
  }
  const strictRejected =
    options.strict === true && diagnostics.some((diagnostic) => diagnostic.severity === "warning")
  return {
    ok: !strictRejected,
    graph: validated.data,
    diagnostics,
  }
}

function parentByPath(
  parent: PrdDocument,
  loadedByCanonical: ReadonlyMap<string, LoadedDocument>,
): string | undefined {
  for (const [canonical, loaded] of loadedByCanonical) {
    if (loaded.document === parent) return canonical
  }
  return undefined
}
