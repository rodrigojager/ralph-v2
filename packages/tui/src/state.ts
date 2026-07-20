import type {
  RunUiEntry,
  RunUiErrors,
  RunUiGateStatus,
  RunUiJudge,
  RunUiRuntimeStatus,
  RunUiScopeProjection,
  RunUiSnapshot,
  RunUiTask,
  RunUiTaskTreeEntry,
  RunUiToolStatus,
  RunUiUsage,
  RunUiWatchdogStatus,
} from "./contracts"

const UNAVAILABLE_USAGE: RunUiUsage = {
  available: false,
  source: "unavailable",
}

export function createEmptyRunUiSnapshot(runId = "pending"): RunUiSnapshot {
  return {
    runId,
    title: "Ralph run",
    status: "idle",
    currentTask: null,
    progress: { completed: 0, total: 0 },
    usage: {
      combined: UNAVAILABLE_USAGE,
      executor: UNAVAILABLE_USAGE,
      judge: UNAVAILABLE_USAGE,
    },
    usageCalls: {},
    activity: [],
    logs: [],
    events: [],
    engineOutput: [],
    rawEngineOutput: [],
    rawEngineRefs: [],
    judge: {
      mode: "none",
      revisionAttempt: 0,
      maxRevisionAttempts: 0,
      feedback: {
        adequate: [],
        problems: [],
        missing: [],
        recommendations: [],
      },
    },
    runtime: { phase: "idle", attempt: 0, modelCalls: 0, toolCalls: 0, gateRuns: 0 },
    taskTree: [],
    scopes: [],
    tools: [],
    observedToolCallIds: [],
    gates: [],
    watchdog: {
      enabled: false,
      state: "unavailable",
      reasons: [],
      restartUsed: 0,
      signals: [],
    },
    errorsSummary: { count: 0 },
    evaluationValues: {},
    evaluationOrigins: {},
  }
}

export type RunUiAction =
  | { readonly type: "replace"; readonly snapshot: RunUiSnapshot }
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "task"; readonly task: RunUiTask | null }
  | { readonly type: "progress"; readonly completed: number; readonly total: number }
  | {
      readonly type: "usage"
      readonly role: "combined" | "executor" | "judge"
      readonly usage: RunUiUsage
    }
  | { readonly type: "judge"; readonly judge: RunUiJudge }
  | { readonly type: "runtime"; readonly runtime: RunUiRuntimeStatus }
  | { readonly type: "task-tree"; readonly entries: readonly RunUiTaskTreeEntry[] }
  | { readonly type: "scopes"; readonly scopes: readonly RunUiScopeProjection[] }
  | { readonly type: "tools"; readonly tools: readonly RunUiToolStatus[] }
  | { readonly type: "gates"; readonly gates: readonly RunUiGateStatus[] }
  | { readonly type: "watchdog"; readonly watchdog: RunUiWatchdogStatus }
  | { readonly type: "errors"; readonly errors: RunUiErrors }
  | {
      readonly type: "evaluation-values"
      readonly values: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: "evaluation-origins"
      readonly origins: Readonly<Record<string, string>>
    }
  | {
      readonly type: "append"
      readonly channel: "activity" | "events" | "logs"
      readonly entry: RunUiEntry
      readonly limit?: number
    }
  | {
      readonly type: "engine-output"
      readonly line: string
      readonly limit?: number
    }
  | {
      readonly type: "raw-engine-output"
      readonly line: string
      readonly limit?: number
    }
  | {
      readonly type: "raw-engine-refs"
      readonly refs: readonly string[]
    }

function appendBounded<T>(items: readonly T[], item: T, limit = 100): readonly T[] {
  const safeLimit = Math.max(1, Math.floor(limit))
  return [...items, item].slice(-safeLimit)
}

export function runUiReducer(snapshot: RunUiSnapshot, action: RunUiAction): RunUiSnapshot {
  switch (action.type) {
    case "replace":
      return action.snapshot
    case "status":
      return { ...snapshot, status: action.status }
    case "task":
      return { ...snapshot, currentTask: action.task }
    case "progress":
      return {
        ...snapshot,
        progress: {
          completed: Math.max(0, action.completed),
          total: Math.max(0, action.total),
        },
      }
    case "usage":
      return {
        ...snapshot,
        usage: { ...snapshot.usage, [action.role]: action.usage },
      }
    case "judge":
      return { ...snapshot, judge: action.judge }
    case "runtime":
      return { ...snapshot, runtime: action.runtime }
    case "task-tree":
      return { ...snapshot, taskTree: action.entries }
    case "scopes":
      return { ...snapshot, scopes: action.scopes }
    case "tools":
      return { ...snapshot, tools: action.tools }
    case "gates":
      return { ...snapshot, gates: action.gates }
    case "watchdog":
      return { ...snapshot, watchdog: action.watchdog }
    case "errors":
      return { ...snapshot, errorsSummary: action.errors }
    case "evaluation-values":
      return { ...snapshot, evaluationValues: action.values }
    case "evaluation-origins":
      return { ...snapshot, evaluationOrigins: action.origins }
    case "append":
      return {
        ...snapshot,
        [action.channel]: appendBounded(snapshot[action.channel], action.entry, action.limit),
      }
    case "engine-output":
      return {
        ...snapshot,
        engineOutput: appendBounded(snapshot.engineOutput, action.line, action.limit),
      }
    case "raw-engine-output":
      return {
        ...snapshot,
        rawEngineOutput: appendBounded(snapshot.rawEngineOutput ?? [], action.line, action.limit),
      }
    case "raw-engine-refs":
      return { ...snapshot, rawEngineRefs: [...action.refs] }
  }
}
