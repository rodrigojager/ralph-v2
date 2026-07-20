# Local performance regression suite

Run with `bun run test:performance`.

This suite is a bounded architectural regression check, not a portable machine benchmark. Its
elapsed-time ceilings are intentionally broad enough for the Windows development host and are
printed beside each observed local baseline. Deterministic contracts are the primary gates:

- one 750-task PRD must parse and compile with the exact graph cardinalities;
- the TUI must accept its maximum 2,048-event batch carrying about 8 MiB of output while keeping
  display collections bounded;
- raw output retention must discard the oldest data and remain inside four segments / 256 KiB;
- durable replay must preserve the exact cursor and count for 25,000 events;
- a 20,000-event TUI replay must keep 32-item projections, a sub-512 KiB snapshot, and broad local
  heap growth below 128 MiB;
- eight project ledgers with 256 events each must remain fully isolated.

The budgets intentionally make no Linux, macOS, architecture, CI-runner, or end-user latency
claim. Platform baselines should be collected separately before adding tighter platform-specific
gates.
