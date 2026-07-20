---
task: Classic grouped delivery
engine: codex
test_command: bun test
---

# Classic grouped delivery

- [ ] [id:api-contract] [group:foundation] Deliver the API contract
  acceptance_criteria: The contract is versioned, The contract fixture is valid
  files_allowed: contracts/cart.json
  gates: contract-test

- [~] [id:ui-state] [group:foundation] Deliver the visible state
  notes: This marker used to mean ready for manual review

- [ ] [id:end-to-end] [depends_on:foundation] Connect the complete flow
  gates: end-to-end-test
