---
ralph_prd: 2
id: child-cycle-child
title: Child cycle child
kind: child
parent:
  prd: root.md
  task: cycle-root-task
workspace: .
defaults:
  evidence_mode: change-only
---

## Vertical slices

- [ ] **cycle-child-task — Attempt to return to root**
  - Resultado: a recursão cíclica é detectada antes da execução.
  - Dependências: nenhuma
  - Limites:
    - Não iniciar qualquer modelo.
  - Modo de evidência: change-only
  - Sub-PRD: root.md
