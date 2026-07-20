import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { type ExecutorOutcome, ExecutorOutcomeSchema } from "@ralph-next/domain"
import type {
  BackendCapabilities,
  CallHandle,
  ExecutionBackend,
  ExecutionChannel,
  ExecutionRequest,
} from "@ralph-next/orchestration"

export type ScriptedFileAction =
  | { type: "write"; path: string; content: string }
  | { type: "append"; path: string; content: string }

export type ScriptedExecution = {
  expectedTask?: string
  actions?: readonly ScriptedFileAction[]
  outcome?: Partial<ExecutorOutcome>
  delayMs?: number
  failure?: string
  failureAfterActions?: string
}

function portable(path: string): string {
  return path.replaceAll("\\", "/")
}

function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function comparablePath(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLocaleLowerCase("und") : normalized
}

async function safeActionPath(request: ExecutionRequest, value: string): Promise<string> {
  if (!value.trim() || isAbsolute(value))
    throw new Error(`Fake action path must be relative: ${value}`)
  const root = await realpath(resolve(request.workspaceRoot))
  const target = resolve(root, value)
  if (!contained(root, target)) throw new Error(`Fake action escapes workspace: ${value}`)
  const relativeTarget = portable(relative(root, target))
  const foldedRelative =
    process.platform === "win32" ? relativeTarget.toLocaleLowerCase("und") : relativeTarget
  if (
    foldedRelative === ".git" ||
    foldedRelative.startsWith(".git/") ||
    foldedRelative === ".ralph" ||
    foldedRelative.startsWith(".ralph/") ||
    request.protectedPaths.some(
      (path) => comparablePath(resolve(root, path)) === comparablePath(target),
    )
  ) {
    throw new Error(`Fake backend cannot modify control-plane path: ${relativeTarget}`)
  }
  try {
    const metadata = await lstat(target)
    if (metadata.isSymbolicLink()) throw new Error(`Fake action cannot follow a symlink: ${value}`)
    const canonicalTarget = await realpath(target)
    if (!contained(root, canonicalTarget)) {
      throw new Error(`Fake action resolves outside workspace: ${value}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  let ancestor = dirname(target)
  while (true) {
    try {
      const canonical = await realpath(ancestor)
      if (!contained(root, canonical))
        throw new Error(`Fake action resolves outside workspace: ${value}`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
  return target
}

async function applyAction(request: ExecutionRequest, action: ScriptedFileAction): Promise<void> {
  const target = await safeActionPath(request, action.path)
  await mkdir(dirname(target), { recursive: true })
  if (action.type === "write") {
    const handle = await open(target, "w", 0o600)
    try {
      await handle.writeFile(action.content, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    return
  }
  const previous = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })
  const handle = await open(target, "w", 0o600)
  try {
    await handle.writeFile(`${previous}${action.content}`, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function defaultOutcome(step: ScriptedExecution): ExecutorOutcome {
  return ExecutorOutcomeSchema.parse({
    schemaVersion: 1,
    status: "work_submitted",
    summary: "Scripted test backend submitted work for deterministic verification.",
    intendedFiles: (step.actions ?? []).map((action) => portable(action.path)),
    artifactRefs: [],
    suggestedVerifications: [],
    risks: [],
    reportedAt: new Date().toISOString(),
    ...step.outcome,
  })
}

export class ScriptedExecutionBackend implements ExecutionBackend {
  readonly id = "fake"
  readonly #queue: ScriptedExecution[]
  readonly #cancelled = new Map<string, string>()
  readonly #requests: ExecutionRequest[] = []
  #calls = 0

  constructor(steps: readonly ScriptedExecution[]) {
    this.#queue = [...steps]
  }

  capabilities(): BackendCapabilities {
    return { streaming: true, toolCalling: false, cancellation: true, usage: "unavailable" }
  }

  async start(request: ExecutionRequest, channel: ExecutionChannel): Promise<CallHandle> {
    this.#requests.push(request)
    const step = this.#queue.shift()
    if (!step) throw new Error("Scripted backend has no remaining execution step")
    const callNumber = ++this.#calls
    const id = `fake-call-${callNumber}-${randomUUID()}`
    if (step.expectedTask && step.expectedTask !== `${request.documentId}/${request.taskId}`) {
      throw new Error(
        `Scripted backend expected ${step.expectedTask}, received ${request.documentId}/${request.taskId}`,
      )
    }
    const handle: CallHandle = {
      id,
      outcome: (async () => {
        await channel.reserveModelCall({ callId: id, turn: 1 })
        await channel.emit({
          type: "model.backend.turn.started",
          payload: { callId: id, turn: 1, source: "scripted-test-backend" },
        })
        if (step.delayMs && step.delayMs > 0) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, step.delayMs))
        }
        const cancellation = this.#cancelled.get(id)
        if (cancellation) throw new Error(`Scripted execution cancelled: ${cancellation}`)
        if (step.failure) throw new Error(step.failure)
        for (const action of step.actions ?? []) {
          const currentCancellation = this.#cancelled.get(id)
          if (currentCancellation)
            throw new Error(`Scripted execution cancelled: ${currentCancellation}`)
          await applyAction(request, action)
          await channel.emit({
            type: "tool.call.settled",
            payload: { callId: id, action: action.type, path: portable(action.path) },
          })
        }
        if (step.failureAfterActions) throw new Error(step.failureAfterActions)
        const outcome = defaultOutcome(step)
        await channel.emit({
          type: "model.backend.turn.finished",
          payload: { callId: id, turn: 1, source: "scripted-test-backend" },
        })
        return outcome
      })(),
    }
    return handle
  }

  async cancel(handle: CallHandle, reason: string): Promise<void> {
    this.#cancelled.set(handle.id, reason)
  }

  remaining(): number {
    return this.#queue.length
  }

  requests(): readonly ExecutionRequest[] {
    return [...this.#requests]
  }
}
