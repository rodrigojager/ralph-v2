---
ralph_prd: 2
id: depth-child-one
title: Depth child one
kind: child
parent:
  prd: root.md
  task: depth-root-task
workspace: .
defaults:
  evidence_mode: change-only
---

## Vertical slices

- [ ] **depth-one-task — Enter level two**
  - Resultado: o primeiro child referencia o segundo.
  - Dependências: nenhuma
  - Limites:
    - Não exceder o limite sem diagnóstico.
  - Modo de evidência: change-only
  - Sub-PRD: child-two.md
