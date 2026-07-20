import { randomUUID } from "node:crypto"

import {
  type EvaluationMode,
  type EvaluationProfileSnapshot,
  EvaluationProfileSnapshotSchema,
  type JudgeAssessment,
  JudgeAssessmentSchema,
  type JudgeOutput,
  JudgeOutputSchema,
} from "@ralph-next/domain"

import {
  buildJudgePrompt,
  DEFAULT_MAX_JUDGE_PROMPT_BYTES,
  type JudgeEvaluationBundleBuild,
} from "./bundle"
import type { JudgeBackend, JudgeEventSink, JudgeKind, JudgePrompt } from "./contracts"

const MAX_REPAIR_DETAIL_BYTES = 8 * 1024
const MAX_REPAIR_SOURCE_CHARS = 32 * 1024
const REPAIR_PREFIX = "\n\nRetry repair instruction (bounded):\n"
const REPAIR_SUFFIX =
  "\nDiscard any prior partial response and return one fresh, complete JudgeOutput v1 JSON object."

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (maxBytes < 1) return ""
  let result = ""
  let used = 0
  for (const character of value.slice(0, MAX_REPAIR_SOURCE_CHARS)) {
    const characterBytes = byteLength(character)
    if (used + characterBytes > maxBytes) break
    result += character
    used += characterBytes
  }
  return result
}

function normalizeRepairInstruction(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  let normalized = ""
  for (const character of value.slice(0, MAX_REPAIR_SOURCE_CHARS)) {
    const codePoint = character.codePointAt(0) ?? 0
    const disallowedControl =
      (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      codePoint === 127
    normalized += disallowedControl ? " " : character
  }
  return normalized.trim() || undefined
}

function repairPrompt(
  prompt: JudgePrompt,
  repairInstruction: string | undefined,
  maxPromptBytes: number,
): JudgePrompt {
  const normalized = normalizeRepairInstruction(repairInstruction)
  if (!normalized) return prompt

  const baseBytes = byteLength(prompt.system) + byteLength(prompt.user)
  const fixedBytes = byteLength(REPAIR_PREFIX) + byteLength(REPAIR_SUFFIX)
  const availableDetailBytes = Math.min(
    MAX_REPAIR_DETAIL_BYTES,
    maxPromptBytes - baseBytes - fixedBytes,
  )
  if (availableDetailBytes < 1) {
    throw new Error(
      `Judge prompt has no room for the retry repair instruction within the ${maxPromptBytes}-byte limit`,
    )
  }
  const detail = boundedUtf8(normalized, availableDetailBytes)
  if (!detail) {
    throw new Error("Judge retry repair instruction has no valid content within the prompt limit")
  }
  const user = `${prompt.user}${REPAIR_PREFIX}${detail}${REPAIR_SUFFIX}`
  const promptBytes = byteLength(prompt.system) + byteLength(user)
  if (promptBytes > maxPromptBytes) {
    throw new Error(
      `Judge prompt is ${promptBytes} bytes and exceeds the ${maxPromptBytes}-byte limit`,
    )
  }
  return { system: prompt.system, user }
}

export function evaluationKind(mode: EvaluationMode): JudgeKind | undefined {
  if (mode === "external" || mode === "self") return mode
  return undefined
}

export type JudgeEvaluatorOptions = {
  backend: JudgeBackend
  profileSnapshot: EvaluationProfileSnapshot
  now?: () => string
  idFactory?: () => string
  maxPromptBytes?: number
}

export type JudgeEvaluationInput = {
  callId: string
  kind: JudgeKind
  build: JudgeEvaluationBundleBuild
  signal?: AbortSignal
  /** Bounded diagnostic from a previous failed call, used only to repair the next response. */
  repairInstruction?: string
  /** Explicit provenance override for callers that already persisted the raw response. */
  rawResponseRef?: string
}

export interface JudgeEvaluator {
  evaluate(input: JudgeEvaluationInput, sink: JudgeEventSink): Promise<JudgeAssessment>
}

class SharedJudgeEvaluator implements JudgeEvaluator {
  readonly #profile: EvaluationProfileSnapshot
  readonly #now: () => string
  readonly #idFactory: () => string

  constructor(private readonly options: JudgeEvaluatorOptions) {
    this.#profile = EvaluationProfileSnapshotSchema.parse(options.profileSnapshot)
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#idFactory = options.idFactory ?? randomUUID
  }

  async evaluate(input: JudgeEvaluationInput, sink: JudgeEventSink): Promise<JudgeAssessment> {
    if (input.kind === "external" && this.#profile.role !== "judge") {
      throw new Error("External evaluation requires an independent judge profile snapshot")
    }
    const maxPromptBytes = this.options.maxPromptBytes ?? DEFAULT_MAX_JUDGE_PROMPT_BYTES
    const prompt = repairPrompt(
      buildJudgePrompt(input.build, maxPromptBytes),
      input.repairInstruction,
      maxPromptBytes,
    )
    const handle = await this.options.backend.start(
      {
        callId: input.callId,
        kind: input.kind,
        evidenceBundleId: input.build.bundle.evidence.id,
        bundle: input.build.bundle,
        prompt,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      sink,
    )
    const output: JudgeOutput = JudgeOutputSchema.parse(await handle.outcome)
    const effectiveProfile = EvaluationProfileSnapshotSchema.parse(
      handle.profileSnapshot ? ((await handle.profileSnapshot) ?? this.#profile) : this.#profile,
    )
    if (input.kind === "external" && effectiveProfile.role !== "judge") {
      throw new Error("External evaluation resolved a non-judge fallback profile")
    }
    if (input.kind === "self" && effectiveProfile.role !== "executor") {
      throw new Error("Self-review resolved a non-executor fallback profile")
    }
    const rawResponseRef =
      input.rawResponseRef ?? (handle.rawResponseRef ? await handle.rawResponseRef : undefined)
    return JudgeAssessmentSchema.parse({
      ...output,
      id: this.#idFactory(),
      kind: input.kind,
      profileSnapshot: effectiveProfile,
      evidenceBundleId: input.build.bundle.evidence.id,
      ...(rawResponseRef ? { rawResponseRef } : {}),
      createdAt: this.#now(),
    })
  }
}

export function createJudgeEvaluator(options: JudgeEvaluatorOptions): JudgeEvaluator {
  return new SharedJudgeEvaluator(options)
}
