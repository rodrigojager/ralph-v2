---
ralph_prd: 2
id: english-contract
title: English task vocabulary
kind: root
workspace: .
defaults:
  executor_profile: runner
  judge_profile: reviewer
  evidence_mode: criteria
  budget:
    max_model_calls: 4
    timeout: 2m
metadata:
  fixture: english-labels
---

# English contract

Context with Unicode before the queue: ação, usuário and café.

## Vertical slices

- [~] **english-slice — Deliver one observable increment**
  - Result: the user observes one complete increment.
  - Dependencies: none
  - Criteria:
    1. The observable result is present.
  - Verification:
    - file: README.md; exists
  - Boundaries:
    - Do not select a language or framework.
  - Evidence mode: criteria
  - Sub-PRD: none
  - Parallel group: delivery
  - Profiles: executor=runner; judge=reviewer
  - Budget: model_calls=2; tool_calls=3; input_tokens=100; output_tokens=200; reasoning_tokens=50; tokens=350; cost=1.25 USD; timeout=90s; revisions=1
  - Notes:
    - Preserve the human wording.
