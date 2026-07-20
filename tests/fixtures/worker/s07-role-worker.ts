import {
  type RalphWorkerRoleAdapter,
  type WorkerRole,
  runWorkerEntrypoint,
} from "@ralph-next/supervisor"

async function observableDelay(signal: AbortSignal): Promise<void> {
  await Bun.sleep(240)
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Fixture worker cancelled")
  }
}

function adapterFor(role: WorkerRole): RalphWorkerRoleAdapter {
  switch (role) {
    case "executor-model":
      return {
        role,
        async execute(request, context) {
          context.assertPaths([request.execution.controlRoot, ...request.requestedReadPaths])
          context.emitProgress("fixture.executor", {
            summary: "Executor fixture reached its isolated adapter",
            stream: "status",
            redacted: true,
          })
          await context.callSupervisor("execution.emit-event", {
            role,
            callId: request.callId,
          })
          await observableDelay(context.signal)
          return {
            schemaVersion: 1,
            callId: request.callId,
            outcome: {
              schemaVersion: 1,
              status: "work_submitted",
              summary: "Executor fixture submitted bounded work.",
              intendedFiles: [],
              artifactRefs: [],
              suggestedVerifications: [],
              risks: [],
              reportedAt: new Date().toISOString(),
            },
            requestedToolCalls: [],
            observations: [],
            finishReason: "fixture-complete",
          }
        },
      }
    case "judge":
      return {
        role,
        async evaluate(request, context) {
          context.assertPaths([request.evaluation.controlRoot, ...request.requestedReadPaths])
          context.emitProgress("fixture.judge", {
            summary: "Judge fixture evaluated the immutable evidence bundle",
            stream: "judge-output",
            redacted: true,
          })
          await context.callSupervisor("judge.emit-event", {
            role,
            assessmentId: request.assessmentId,
          })
          await observableDelay(context.signal)
          return {
            schemaVersion: 1,
            assessmentId: request.assessmentId,
            output: {
              schemaVersion: 1,
              score: 95,
              summary: "The fixture evidence satisfies its criterion.",
              adequate: ["The bound fixture result is present."],
              problems: [],
              missingEvidence: [],
              recommendations: [],
              criterionScores: [{ criterion: "c1", score: 95 }],
              confidence: 0.95,
            },
            observations: [],
          }
        },
      }
    case "tool-gate":
      return {
        role,
        async executeTool(request, context) {
          context.assertPaths([
            ...(request.runtime.controlRoot ? [request.runtime.controlRoot] : []),
            ...request.requestedReadPaths,
            ...request.requestedWritePaths,
          ])
          context.emitProgress("fixture.tool", {
            summary: "Tool fixture requested supervisor-owned settlement",
            stream: "tool-output",
            redacted: true,
          })
          await context.callSupervisor("tool.process.execute", {
            role,
            callId: request.toolCall.callId,
          })
          await observableDelay(context.signal)
          return {
            schemaVersion: 1,
            callId: request.toolCall.callId,
            outcome: "success",
            output: "fixture tool output",
            retryable: false,
            outputRefs: [],
            observations: [],
          }
        },
        async executeGate(request, context) {
          context.assertPaths([...request.requestedReadPaths, ...request.requestedWritePaths])
          context.emitProgress("fixture.gate", {
            summary: "Gate fixture requested supervisor-owned output persistence",
            stream: "gate-output",
            redacted: true,
          })
          await context.callSupervisor("gate.persist-output", {
            role,
            gateId: request.gateId,
          })
          await observableDelay(context.signal)
          return {
            schemaVersion: 1,
            result: {
              gateId: request.gateId,
              category: request.category,
              blocking: request.blocking,
              skipPolicy: request.skipPolicy,
              criterionIds: request.criterionIds,
              status: "passed",
              durationMs: 1,
              outputRefs: [],
            },
            observations: [],
          }
        },
      }
    case "git-integration":
      return {
        role,
        async integrate(request, context) {
          context.assertPaths([
            request.repositoryRoot,
            ...(request.worktreeRoot ? [request.worktreeRoot] : []),
            request.gitCommand.cwd,
          ])
          context.assertCommands([request.gitCommand])
          context.emitProgress("fixture.git", {
            summary: "Git fixture verified its exact command capability",
            stream: "git-output",
            redacted: true,
          })
          await observableDelay(context.signal)
          return {
            schemaVersion: 1,
            integrationId: request.integrationId,
            action: request.action,
            status: "succeeded",
            conflictPaths: [],
            artifactRefs: [],
            summary: "Git fixture inspected the authorized repository scope.",
            observations: [],
          }
        },
      }
    case "child-run":
      throw new Error("The S07.04 fixture intentionally excludes child-run")
  }
}

const role = process.env.RALPH_WORKER_ROLE as WorkerRole
await runWorkerEntrypoint({ role, adapter: adapterFor(role) })
