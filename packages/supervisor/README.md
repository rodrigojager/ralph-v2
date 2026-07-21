# `@ralph/supervisor`

Bounded, redacted process execution and typed worker isolation for Ralph v2.
Direct process mode always passes an argv array to the runtime; text is
interpreted by a shell only when the caller selects the explicit `shell`
variant. POSIX children receive a process group. Windows workers are assigned
to a Job Object when available, with the portable tree-termination fallback
kept for ordinary supervised commands.

## Typed worker boundary

The private IPC protocol separates these roles:

- `executor-model` / `model.execute`;
- `judge` / `judge.evaluate`;
- `tool-gate` / `tool.execute` and `gate.execute`;
- `child-run` / `child.execute`;
- `git-integration` / `integration.execute`.

Every request and result uses a versioned role-specific schema from
`worker-operations.ts`. The supervisor and worker both validate the same
contract. Bootstrap identity binds workspace, run, optional attempt, role,
PID/start token, deadline and capability hash. Before adapter dispatch, the
runtime also checks path scopes, exact command scopes, payload-to-run bindings
and the earliest worker/request deadline. Capability grants for the same action
are unioned deterministically instead of silently ignoring later scopes.

Workers receive no ledger, marker or transition port. They can emit bounded
progress and return a result allegation; only the command-owned supervisor may
persist events or change official run/task/attempt state. Shutdown first aborts
the active operation, acknowledges after it settles, and relies on the parent
grace deadline plus process-tree termination if an adapter ignores cancellation.

## Entrypoint and adapters

`apps/ralph-cli/src/worker-main.ts` is the private child-mode handler used by
the same CLI entrypoint/binary. The parent sets `RALPH_WORKER=1`,
`RALPH_WORKER_ROLE` and a supervisor-owned adapter kind. The product
composition uses the built-in factory from `worker-adapters.ts`; an optional
external module mode remains available for packaged adapters and must export:

```ts
createRalphWorkerRoleAdapter({
  role,
  protocolVersion,
  operationSchemaVersion,
}): RalphWorkerRoleAdapter
```

The entrypoint refuses standalone execution, validates that the adapter really
implements the selected role, registers only its supported operations and then
waits on the authenticated IPC channel. In module mode, code is imported only
after bootstrap, from an absolute path outside the mutable target workspace
and with a stable content hash. In built-in mode, the same packaged CLI owns
the factory. Adapter selection is supervisor-owned in both cases; neither a
model response nor an operation payload can choose or replace it.

Workers may call a small reverse RPC surface. Executor workers can reserve a
model turn, request an official ToolHost settlement and emit normalized events;
judge workers can emit judge events; gate workers can ask the parent to persist
bounded stdout/stderr. Calls are role-checked, request-bound and bounded, and a
worker result is rejected while a reverse call is still active.

## Product composition

`apps/ralph-cli/src/worker-composition.ts` connects the protocol to the real
CLI composition:

- one executor worker per model call;
- one judge worker per assessment;
- ToolHost policy/journal/settlement in the parent and authorized effects in a
  tool worker;
- a gate registry backed by gate workers;
- a Git `ProcessSupervisor` backed by git-integration workers.

Profiles and effective configuration are immutable payloads. Workers verify a
canonical profile hash before resolving S05. Exact external CLI commands are
capability-bound. OpenAI and OpenRouter embedded transports run behind the same
contract; unsupported embedded providers fail closed.

## Child coordinator boundary and remaining limit

The current child policy is `supervised-worker-pause-with-parent`. Child
scheduling, reservation and final reconciliation stay under the outer command
supervisor, but the already-authorized child Ralph coordinator runs in a real
typed `child-run` worker process. The outer supervisor binds the durable lease
to that worker's PID, process-start token, hostname and worker ID, renews it,
and owns the shared task budget plus event/observation projection over narrow
reverse IPC. The child recompiles and hash-checks the pre-authored graph, has no
PRD authorship or arbitrary process-launch capability, and composes its own
executor/judge/tool/gate workers and nested child coordinators. A
`survive-parent` child would require an independent workspace writer lease,
process owner and reattachment channel, so worker execution rejects that claim.

An unsettled `process.exec` is handed to an independent durable owner only
after journal, executable/hash, exact argv, cwd, environment, stdin and limit
bindings are revalidated. Its lifecycle, renewable lease, host/start-token
probe, bounded output and loopback bearer channel permit reattachment without
replaying the effect; ambiguous identity still pauses recovery.

An explicitly authorized shell request is first projected to one fixed
interpreter argv and then crosses the same exact-command boundary as a direct
request. Executor and judge fallback candidates are command-owned and lazy:
each external-CLI candidate receives its own executable/hash capability only
when selected, and executor fallback is forbidden after any tool call.
