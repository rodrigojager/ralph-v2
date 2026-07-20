type ProtocolInput = {
  history: Array<{ type: string; callId?: string }>
}

const input = JSON.parse(await Bun.stdin.text()) as ProtocolInput
const hasSettlement = input.history.some(
  (item) => item.type === "function-call-output" && item.callId === "fixture-write-1",
)

if (!hasSettlement) {
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      protocol: "ralph.execution.external-cli.v1",
      kind: "tool-calls",
      toolCalls: [
        {
          itemId: "fixture-item-1",
          callId: "fixture-write-1",
          name: "fs.write",
          argumentsJson: JSON.stringify({
            path: "product/capability.txt",
            content: "delivered",
            precondition: { kind: "absent" },
            createParents: true,
          }),
          input: {
            path: "product/capability.txt",
            content: "delivered",
            precondition: { kind: "absent" },
            createParents: true,
          },
        },
      ],
    }),
  )
} else {
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      protocol: "ralph.execution.external-cli.v1",
      kind: "outcome",
      outcome: {
        schemaVersion: 1,
        status: "work_submitted",
        summary: "TASK_COMPLETE is only an allegation; inspect evidence and gates.",
        intendedFiles: ["product/capability.txt"],
        artifactRefs: [],
        suggestedVerifications: [],
        risks: [],
        reportedAt: "2000-01-01T00:00:00.000Z",
      },
    }),
  )
}
