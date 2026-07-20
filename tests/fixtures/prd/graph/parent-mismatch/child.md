---
ralph_prd: 2
id: mismatch-child
title: Parent mismatch child
kind: child
parent:
  prd: other.md
  task: mismatch-parent-task
workspace: .
defaults:
  evidence_mode: change-only
---

## Vertical slices

- [ ] **mismatch-child-task — Expose the mismatch**
  - Resultado: o child continua estruturalmente válido.
  - Dependências: nenhuma
  - Limites:
    - Não mudar seu parent durante parsing.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum
