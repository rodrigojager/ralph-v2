import { type EvaluationProfileSnapshot, type JudgeOutput, JudgeOutputSchema } from "@ralph/domain"
import type {
  JudgeBackend,
  JudgeBackendCapabilities,
  JudgeBackendEvent,
  JudgeCallHandle,
  JudgeEventSink,
  JudgeRequest,
} from "@ralph/evaluation"

export type ScriptedJudgeStep = {
  score?: number
  output?: JudgeOutput
  rawResponseRef?: string
  profileSnapshot?: EvaluationProfileSnapshot
  events?: readonly JudgeBackendEvent[]
  heartbeatCount?: number
  /** Waits without completing until release(callId). */
  silence?: boolean
  /** Cannot be released normally; cancellation is required. */
  freeze?: boolean
  failure?: Error | string
  /** Deliberately invalid output for testing downstream schema enforcement. */
  malformedOutput?: unknown
}

type ActiveJudgeCall = {
  mode: "silence" | "freeze"
  promise: Promise<void>
  release: () => void
  reject: (error: Error) => void
}

function deferredCall(mode: ActiveJudgeCall["mode"]): ActiveJudgeCall {
  let release: (() => void) | undefined
  let reject: ((error: Error) => void) | undefined
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    release = resolvePromise
    reject = rejectPromise
  })
  return {
    mode,
    promise,
    release: () => release?.(),
    reject: (error) => reject?.(error),
  }
}

function scoreOutput(request: JudgeRequest, score: number): JudgeOutput {
  const criteria = request.bundle.rubric.criteria.map((entry) => entry.criterion)
  return JudgeOutputSchema.parse({
    schemaVersion: 1,
    score,
    summary: `Scripted judge score ${score}`,
    adequate: score >= 80 ? ["The scripted evidence meets the expected threshold"] : [],
    problems:
      score >= 80
        ? []
        : [
            {
              severity: "major",
              criterion: criteria[0] ?? "scripted-criterion",
              message: "The scripted evidence requires a bounded revision",
              evidenceRefs: [request.evidenceBundleId],
            },
          ],
    missingEvidence: score >= 80 ? [] : ["Scripted deterministic evidence"],
    recommendations: score >= 80 ? [] : ["Apply the scripted bounded revision"],
    criterionScores: (criteria.length > 0 ? criteria : ["scripted-criterion"]).map((criterion) => ({
      criterion,
      score,
      rationale: `Scripted score ${score}`,
    })),
    confidence: 1,
  })
}

function heartbeatCount(value: number | undefined): number {
  const count = value ?? 0
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Scripted judge heartbeatCount must be a non-negative safe integer")
  }
  return count
}

/** Read-only JudgeBackend with score sequences and explicit adverse states. */
export class ScriptedJudgeBackend implements JudgeBackend {
  readonly id: string
  readonly requests: JudgeRequest[] = []
  readonly emittedEvents: JudgeBackendEvent[] = []
  readonly cancellations: Array<{ callId: string; reason: string }> = []
  readonly #queue: ScriptedJudgeStep[]
  readonly #active = new Map<string, ActiveJudgeCall>()

  constructor(steps: readonly ScriptedJudgeStep[], options: { id?: string } = {}) {
    this.id = options.id ?? "scripted-judge"
    this.#queue = [...steps]
  }

  static fromScores(
    scores: readonly number[],
    options: { id?: string } = {},
  ): ScriptedJudgeBackend {
    return new ScriptedJudgeBackend(
      scores.map((score) => ({ score })),
      options,
    )
  }

  capabilities(): JudgeBackendCapabilities {
    return {
      streaming: true,
      cancellation: true,
      structuredOutput: true,
      usage: "unavailable",
      toolCalling: "unavailable",
      mutationMode: "read-only",
    }
  }

  async start(request: JudgeRequest, sink: JudgeEventSink): Promise<JudgeCallHandle> {
    this.requests.push(request)
    const step = this.#queue.shift()
    if (!step) throw new Error("Scripted judge has no remaining assessment step")

    const operation = (async (): Promise<JudgeOutput> => {
      for (const event of step.events ?? []) {
        this.emittedEvents.push(event)
        await sink.emit(event)
      }
      for (let index = 0; index < heartbeatCount(step.heartbeatCount); index += 1) {
        const event: JudgeBackendEvent = {
          type: "judge.heartbeat",
          level: "debug",
          payload: { callId: request.callId, sequence: index + 1 },
        }
        this.emittedEvents.push(event)
        await sink.emit(event)
      }
      if (step.silence || step.freeze) {
        const active = deferredCall(step.freeze ? "freeze" : "silence")
        this.#active.set(request.callId, active)
        try {
          await active.promise
        } finally {
          this.#active.delete(request.callId)
        }
      }
      if (step.failure) {
        throw typeof step.failure === "string" ? new Error(step.failure) : step.failure
      }
      if (Object.hasOwn(step, "malformedOutput")) return step.malformedOutput as JudgeOutput
      if (step.output) return JudgeOutputSchema.parse(step.output)
      return scoreOutput(request, step.score ?? 100)
    })()
    void operation.catch(() => undefined)
    return {
      id: request.callId,
      outcome: operation,
      rawResponseRef: Promise.resolve(step.rawResponseRef),
      profileSnapshot: Promise.resolve(step.profileSnapshot),
    }
  }

  async cancel(handle: JudgeCallHandle, reason: string): Promise<void> {
    this.cancellations.push({ callId: handle.id, reason })
    this.#active.get(handle.id)?.reject(new Error(`Scripted judge call cancelled: ${reason}`))
  }

  release(callId: string): void {
    const active = this.#active.get(callId)
    if (!active) throw new Error(`Scripted judge call is not waiting: ${callId}`)
    if (active.mode === "freeze") {
      throw new Error(`Scripted judge call is frozen and must be cancelled: ${callId}`)
    }
    active.release()
  }

  activeCalls(): readonly string[] {
    return [...this.#active.keys()]
  }

  remaining(): number {
    return this.#queue.length
  }
}
