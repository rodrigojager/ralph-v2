import { describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { resolveEffectiveRunOptions } from "@ralph-next/orchestration"
import {
  compilePrdGraph,
  formatPrdSource,
  type PrdDocument,
  type PrdTask,
  parsePrdSource,
} from "@ralph-next/prd"
import {
  type EventEnvelope,
  EventEnvelopeConsumerSchema,
  EventEnvelopeSchema,
  REDACTED,
  redactText,
  redactValue,
  replayWorkspaceEvents,
  TokenUsageAggregator,
} from "@ralph-next/telemetry"
import {
  decideToolPermission,
  processExecTool,
  ToolPolicySchema,
  type ToolRuntimeContext,
  type ToolSession,
  WorkspacePathResolver,
} from "@ralph-next/tool-host"
import { createTestDirectory, removeTestDirectory } from "../helpers/temp-directory"

type RandomSource = () => number

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function integer(random: RandomSource, minimum: number, maximum: number): number {
  return minimum + Math.floor(random() * (maximum - minimum + 1))
}

function pick<T>(random: RandomSource, values: readonly T[]): T {
  const value = values[integer(random, 0, values.length - 1)]
  if (value === undefined) throw new Error("Property generator received an empty choice set")
  return value
}

async function forSeeds(
  count: number,
  action: (seed: number, random: RandomSource) => void | Promise<void>,
): Promise<void> {
  for (let seed = 1; seed <= count; seed += 1) {
    try {
      await action(seed, seededRandom(seed * 0x9e37_79b1))
    } catch (error) {
      throw new Error(`S11 deterministic property failed at seed ${seed}`, { cause: error })
    }
  }
}

type GeneratedPrd = {
  source: string
  cyclicSource: string
  documentId: string
  taskIds: readonly string[]
  dependencies: Readonly<Record<string, readonly string[]>>
}

function generatedPrd(seed: number, random: RandomSource): GeneratedPrd {
  const taskCount = integer(random, 3, 9)
  const taskIds = Array.from({ length: taskCount }, (_, index) => `slice-${index + 1}`)
  const dependencies: Record<string, string[]> = {}
  for (const [index, taskId] of taskIds.entries()) {
    if (index === 0) {
      dependencies[taskId] = []
      continue
    }
    const selected = new Set<string>([taskIds[index - 1] as string])
    for (let candidate = 0; candidate < index - 1; candidate += 1) {
      if (random() < 0.35) selected.add(taskIds[candidate] as string)
    }
    dependencies[taskId] = [...selected]
  }

  const documentId = `property-graph-${seed}`
  const newline = random() < 0.5 ? "\n" : "\r\n"
  const prefix = random() < 0.5 ? "\uFEFF" : ""
  const context = pick(random, [
    "ação vertical ☕",
    "contrato usuário 🧪",
    "日本語 e português",
    "emoji 👩🏽‍💻 sem perda",
  ])
  const render = (graph: Readonly<Record<string, readonly string[]>>): string => {
    const lines = [
      "---",
      "ralph_prd: 2",
      `id: ${documentId}`,
      `title: Propriedade de grafo ${seed}`,
      "kind: root",
      "workspace: .",
      "defaults:",
      "  evidence_mode: change-only",
      "---",
      "",
      `# Contexto ${context}`,
      "",
      "## Vertical slices",
      "",
      ...taskIds.flatMap((taskId, index) => [
        `- [ ] **${taskId} — Entregar incremento ${index + 1} com ${context}**`,
        `  - Resultado: o usuário observa o incremento ${index + 1} do início ao fim.`,
        `  - Dependências: ${graph[taskId]?.join(", ") || "nenhuma"}`,
        "  - Limites:",
        "    - Preservar contratos e arquivos fora do escopo.",
        "  - Modo de evidência: change-only",
        "  - Sub-PRD: nenhum",
        "",
      ]),
    ]
    return `${prefix}${lines.join(newline)}`
  }
  const cyclicDependencies = structuredClone(dependencies)
  cyclicDependencies[taskIds[0] as string] = [taskIds.at(-1) as string]
  return {
    source: render(dependencies),
    cyclicSource: render(cyclicDependencies),
    documentId,
    taskIds,
    dependencies,
  }
}

function event(sequence: number, type: string, additive = false): EventEnvelope {
  const candidate = {
    schemaVersion: 1,
    eventId: `property-event-${sequence}`,
    sequence,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, sequence)).toISOString(),
    monotonicMs: sequence,
    type,
    scope: "workspace" as const,
    streamId: "workspace:property",
    workspaceId: "property",
    level: "info" as const,
    payload: { sequence },
    ...(additive ? { futureAdditiveField: { sequence } } : {}),
  }
  return EventEnvelopeConsumerSchema.parse(candidate)
}

function partition(total: number, count: number, random: RandomSource): number[] {
  const cuts = Array.from({ length: count - 1 }, () => integer(random, 0, total)).sort(
    (left, right) => left - right,
  )
  const boundaries = [0, ...cuts, total]
  return boundaries.slice(1).map((boundary, index) => boundary - (boundaries[index] as number))
}

function propertyPolicy(overrides: Record<string, unknown> = {}) {
  return ToolPolicySchema.parse({
    schemaVersion: 1,
    role: "executor",
    securityMode: "safe",
    interactive: false,
    headlessAsk: "deny",
    toolRules: { "process.exec": "allow" },
    readScopes: ["."],
    writeScopes: ["."],
    protectedPaths: ["PRD.md"],
    commandRules: [],
    limits: {},
    ...overrides,
  })
}

describe("S11.03 deterministic property and fuzz matrix", () => {
  test("preserves generated PRD graphs through parse/format/parse and rejects generated cycles", async () => {
    const root = await createTestDirectory()
    try {
      await forSeeds(24, async (seed, random) => {
        const generated = generatedPrd(seed, random)
        const path = resolve(root, `plano property ${seed} ç.md`)
        await writeFile(path, generated.source)

        const original = await compilePrdGraph(path, {
          workspaceRoot: root,
          recursive: true,
          strict: true,
        })
        expect(original.ok).toBeTrue()
        const originalGraph = original.graph
        if (!originalGraph) throw new Error("Generated DAG did not produce a graph")
        expect(originalGraph.rootDocumentId).toBe(generated.documentId)
        expect(originalGraph.topologicalOrder.map((reference) => reference.taskId)).toEqual(
          [...generated.taskIds],
        )
        const order = new Map(
          originalGraph.topologicalOrder.map((reference, index) => [reference.taskId, index]),
        )
        for (const edge of originalGraph.dependencyEdges) {
          expect(order.get(edge.dependsOn.taskId) as number).toBeLessThan(
            order.get(edge.task.taskId) as number,
          )
        }
        expect(originalGraph.eligibleTasks.map((reference) => reference.taskId)).toEqual(
          generated.taskIds.filter((taskId) => generated.dependencies[taskId]?.length === 0),
        )

        const formatted = formatPrdSource(generated.source, { file: `property-${seed}.md` })
        expect(formatted.ok).toBeTrue()
        const reparsed = parsePrdSource(formatted.source as string, {
          file: `property-${seed}.md`,
        })
        expect(reparsed.ok).toBeTrue()
        expect(reparsed.document?.definitionHash).toBe(
          originalGraph.documents[generated.documentId]?.definitionHash,
        )
        expect(reparsed.document?.tasks.map((task) => task.taskSpecHash)).toEqual(
          originalGraph.documents[generated.documentId]?.tasks.map((task) => task.taskSpecHash),
        )

        await writeFile(path, formatted.source as string)
        const canonical = await compilePrdGraph(path, {
          workspaceRoot: root,
          recursive: true,
          strict: true,
        })
        expect(canonical.ok).toBeTrue()
        expect(canonical.graph?.definitionHash).toBe(originalGraph.definitionHash)
        expect(canonical.graph?.dependencyEdges).toEqual(originalGraph.dependencyEdges)

        await writeFile(path, generated.cyclicSource)
        const cyclic = await compilePrdGraph(path, {
          workspaceRoot: root,
          recursive: true,
          strict: true,
        })
        expect(cyclic.ok).toBeFalse()
        expect(cyclic.graph).toBeUndefined()
        expect(cyclic.diagnostics.some((item) => item.code === "RALPH_PRD_DEPENDENCY_CYCLE")).toBe(
          true,
        )
      })
    } finally {
      await removeTestDirectory(root)
    }
  })

  test("resolves every combination of option precedence without changing the winning source", () => {
    const parsed = parsePrdSource(generatedPrd(101, seededRandom(101)).source, {
      file: "options-property.md",
    })
    const baseDocument = parsed.document
    const baseTask = baseDocument?.tasks[0]
    if (!baseDocument || !baseTask) throw new Error("Expected generated option fixture")

    for (let mask = 0; mask < 16; mask += 1) {
      const profileEnabled = (mask & 1) !== 0
      const prdEnabled = (mask & 2) !== 0
      const taskEnabled = (mask & 4) !== 0
      const cliEnabled = (mask & 8) !== 0
      const document: PrdDocument = structuredClone(baseDocument)
      const task: PrdTask = structuredClone(baseTask)
      delete document.defaults.budget
      delete task.budget
      if (prdEnabled) document.defaults.budget = { maxModelCallsPerAttempt: 22 }
      if (taskEnabled) task.budget = { maxModelCallsPerAttempt: 33 }

      const resolved = resolveEffectiveRunOptions({
        document,
        task,
        ...(profileEnabled
          ? { profile: { id: "property-profile", maxModelCallsPerAttempt: 11 } }
          : {}),
        ...(cliEnabled ? { cli: { maxModelCallsPerAttempt: 44 } } : {}),
      }).options.maxModelCallsPerAttempt
      const expected = cliEnabled
        ? { value: 44, source: "cli" }
        : taskEnabled
          ? { value: 33, source: "task" }
          : prdEnabled
            ? { value: 22, source: "prd" }
            : profileEnabled
              ? { value: 11, source: "profile" }
              : { value: 1, source: "builtin" }
      expect(resolved).toMatchObject(expected)
    }
  })

  test("aggregates arbitrarily partitioned and interleaved usage exactly once", async () => {
    await forSeeds(64, (seed, random) => {
      const runId = `usage-property-${seed}`
      const actual = new TokenUsageAggregator(runId)
      const reference = new TokenUsageAggregator(runId)
      const queues: Array<Array<Parameters<TokenUsageAggregator["update"]>[0]>> = []
      const callCount = integer(random, 1, 7)
      for (let index = 0; index < callCount; index += 1) {
        const role = pick(random, ["executor", "judge", "child", "tool-model"] as const)
        const scope = {
          runId,
          documentId: `document-${index % 3}`,
          taskId: `task-${index % 5}`,
          attemptId: `attempt-${index % 4}`,
          ...(role === "child" ? { parentRunId: runId, childRunId: `child-${index % 2}` } : {}),
        }
        const binding = { callId: `call-${index}`, role, scope }
        actual.registerCall(binding)
        reference.registerCall(binding)
        const input = integer(random, 0, 50_000)
        const output = integer(random, 0, 20_000)
        const parts = integer(random, 1, 6)
        const inputs = partition(input, parts, random)
        const outputs = partition(output, parts, random)
        const updates: Array<Parameters<TokenUsageAggregator["update"]>[0]> = inputs.map(
          (inputDelta, part) => ({
            ...binding,
            usage: {
              source: "reported" as const,
              semantics: "delta" as const,
              input: inputDelta,
              output: outputs[part] as number,
              total: inputDelta + (outputs[part] as number),
            },
          }),
        )
        updates.push({
          ...binding,
          usage: {
            source: "reported" as const,
            semantics: "final" as const,
            input,
            output,
            total: input + output,
          },
        })
        queues.push(updates)
        reference.update({
          ...binding,
          usage: {
            source: "reported",
            semantics: "final",
            input,
            output,
            total: input + output,
          },
        })
      }

      while (queues.some((queue) => queue.length > 0)) {
        const available = queues
          .map((queue, index) => (queue.length > 0 ? index : -1))
          .filter((index) => index >= 0)
        const selected = pick(random, available)
        actual.update(queues[selected]?.shift() as Parameters<TokenUsageAggregator["update"]>[0])
      }

      const unavailable = {
        callId: "call-unavailable",
        role: "executor" as const,
        scope: { runId, attemptId: "attempt-unavailable" },
      }
      actual.registerCall(unavailable)
      reference.registerCall(unavailable)
      actual.settleUnavailableIfOpen(unavailable)
      reference.settleUnavailableIfOpen(unavailable)

      const actualSnapshot = actual.snapshot()
      const referenceSnapshot = reference.snapshot()
      expect(actualSnapshot.total).toEqual(referenceSnapshot.total)
      expect(actualSnapshot.roles).toEqual(referenceSnapshot.roles)
      expect(actualSnapshot.attempts).toEqual(referenceSnapshot.attempts)
      expect(actualSnapshot.tasks).toEqual(referenceSnapshot.tasks)
      expect(actualSnapshot.children).toEqual(referenceSnapshot.children)
      expect(Object.keys(actualSnapshot.calls)).toEqual(Object.keys(referenceSnapshot.calls))
      for (const key of Object.keys(referenceSnapshot.calls)) {
        const actualCall = actualSnapshot.calls[key]
        const referenceCall = referenceSnapshot.calls[key]
        if (!actualCall || !referenceCall) throw new Error(`Missing normalized usage call ${key}`)
        const { updates: actualUpdates, ...actualValues } = actualCall
        const { updates: referenceUpdates, ...referenceValues } = referenceCall
        expect(actualValues).toEqual(referenceValues)
        expect(actualUpdates).toBeGreaterThanOrEqual(referenceUpdates)
      }
    })
  })

  test("rejects cumulative usage regressions without mutating the prior aggregate", async () => {
    await forSeeds(32, (seed, random) => {
      const runId = `usage-regression-${seed}`
      const aggregate = new TokenUsageAggregator(runId)
      const binding = {
        callId: "regression-call",
        role: "executor" as const,
        scope: { runId, attemptId: "attempt" },
      }
      const input = integer(random, 2, 100_000)
      aggregate.update({
        ...binding,
        usage: { source: "reported", semantics: "cumulative", input, total: input },
      })
      const before = aggregate.snapshot()
      expect(() =>
        aggregate.update({
          ...binding,
          usage: {
            source: "reported",
            semantics: "cumulative",
            input: input - 1,
            total: input - 1,
          },
        }),
      ).toThrow("Cumulative/final usage regressed")
      expect(aggregate.snapshot()).toEqual(before)
    })
  })

  test("redacts generated secret placements idempotently without hiding credential references", async () => {
    await forSeeds(128, (seed, random) => {
      const secret = `canary-${seed.toString(16)}-${integer(random, 100_000, 999_999)}`
      const bearer = `bearer.${seed}.${integer(random, 100_000, 999_999)}`
      const urlSecret = `url-${seed}-${integer(random, 100_000, 999_999)}`
      const text = `${pick(random, ["prefix", "linha", "contexto"])} ${secret}; Authorization: Bearer ${bearer}; https://example.test/callback?token=${urlSecret}&ok=1`
      const redacted = redactText(text, [secret])
      expect(redacted).not.toContain(secret)
      expect(redacted).not.toContain(bearer)
      expect(redacted).not.toContain(urlSecret)
      expect(redactText(redacted, [secret])).toBe(redacted)

      const value = {
        credential: `credential-ref-${seed}`,
        nested: [
          { message: `before ${secret} after` },
          { refreshToken: secret },
          { authorization: `Bearer ${bearer}` },
        ],
      }
      const safe = redactValue(value, [secret]) as typeof value
      expect(JSON.stringify(safe)).not.toContain(secret)
      expect(JSON.stringify(safe)).not.toContain(bearer)
      expect(safe.credential).toBe(`credential-ref-${seed}`)
      expect((safe.nested[1] as { refreshToken?: string } | undefined)?.refreshToken).toBe(REDACTED)
    })
  })

  test("replays generated additive v1 event streams idempotently and rejects a future major", async () => {
    await forSeeds(96, (_seed, random) => {
      const count = integer(random, 1, 40)
      const events: EventEnvelope[] = []
      let sequence = integer(random, 1, 4)
      for (let index = 0; index < count; index += 1) {
        events.push(
          event(sequence, index === 0 ? "workspace.initialized" : "workspace.inspected", true),
        )
        sequence += integer(random, 1, 5)
      }
      const first = replayWorkspaceEvents(events)
      const second = replayWorkspaceEvents(structuredClone(events))
      expect(second).toEqual(first)
      expect(first).toMatchObject({
        initialized: true,
        eventCount: count,
        eventCursor: events.at(-1)?.sequence,
        lastEventType: count === 1 ? "workspace.initialized" : "workspace.inspected",
        initializedAt: events[0]?.timestamp,
      })
    })

    const v1 = event(1, "workspace.initialized")
    expect(EventEnvelopeSchema.safeParse({ ...v1, futureAdditiveField: true }).success).toBeFalse()
    expect(EventEnvelopeConsumerSchema.safeParse({ ...v1, schemaVersion: 2 }).success).toBeFalse()
  })

  test("keeps generated paths contained and treats command metacharacters as literal argv", async () => {
    const root = await createTestDirectory()
    try {
      const basePolicy = propertyPolicy()
      const resolver = await WorkspacePathResolver.create(root, basePolicy)
      const tool = processExecTool()
      await forSeeds(128, async (seed, random) => {
        const portable = `dir-${seed}/ação-${integer(random, 1, 999)}/file-${integer(random, 1, 999)}.txt`
        const source = random() < 0.5 ? portable : `./${portable}`
        expect(resolver.normalize(source)).toBe(portable)
        expect(resolver.isInScope(portable, "read")).toBeTrue()
        expect(resolver.isInScope(portable, "write")).toBeTrue()
        const resolved = await resolver.resolve(source, "write")
        expect(resolved).toMatchObject({
          portablePath: portable,
          exists: false,
          operation: "write",
          protected: false,
          inScope: true,
        })

        const invalidVariants = [
          `../${portable}`,
          `${portable}/../escape`,
          `C:/${portable}`,
          `//server/${portable}`,
          portable.replaceAll("/", "\\"),
          `${portable}/./child`,
          `${portable}//child`,
          `${portable}:stream`,
          "CON",
          ` ${portable}`,
          `${portable}\u0000`,
        ]
        const invalid = invalidVariants[(seed - 1) % invalidVariants.length] as string
        expect(() => resolver.normalize(invalid)).toThrow()

        const literalArgument = `${pick(random, ["; rm", "&& echo", "$(whoami)", "`whoami`", "| calc", "%COMSPEC%", "$env:SECRET"])}-${seed}`
        const policy = propertyPolicy({
          commandRules: [
            {
              id: `literal-${seed}`,
              executable: "fixture-command",
              exactArgs: [literalArgument],
              shell: false,
              risk: "process",
            },
          ],
        })
        const session: ToolSession = {
          runId: "run",
          documentId: "document",
          taskId: "task",
          attemptId: "attempt",
          modelCallId: "model",
          workspaceRoot: root,
          policy,
          maximumToolCalls: 256,
        }
        const context: ToolRuntimeContext = {
          toolCallId: `tool-${seed}`,
          argumentsHash: "a".repeat(64),
          idempotencyKey: `property-${seed}`,
          session,
          policy,
          resolver,
          process: {
            which: () => null,
            async run() {
              throw new Error("Property assessment must not execute a process")
            },
          },
          artifacts: {
            async publish() {
              throw new Error("Property assessment must not publish an artifact")
            },
          },
          events: { emit() {} },
        }
        const exact = await tool.assess(
          {
            mode: "direct",
            executable: "fixture-command",
            args: [literalArgument],
            cwd: ".",
          },
          context,
        )
        expect(decideToolPermission(policy, exact.facts, "process.exec")).toMatchObject({
          action: "allow",
          ruleId: `literal-${seed}`,
        })
        const changed = await tool.assess(
          {
            mode: "direct",
            executable: "fixture-command",
            args: [`${literalArgument}-changed`],
            cwd: ".",
          },
          context,
        )
        expect(decideToolPermission(policy, changed.facts, "process.exec").action).toBe("deny")
      })
    } finally {
      await removeTestDirectory(root)
    }
  })
})
