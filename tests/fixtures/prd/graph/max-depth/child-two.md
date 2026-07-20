---
ralph_prd: 2
id: depth-child-two
title: Depth child two
kind: child
parent:
  prd: child-one.md
  task: depth-one-task
workspace: .
defaults:
  evidence_mode: change-only
---

## Vertical slices

- [ ] **depth-two-task — Be rejected when depth is one**
  - Resultado: este nível só compila quando a policy permite.
  - Dependências: nenhuma
  - Limites:
    - Não alterar a policy.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum
