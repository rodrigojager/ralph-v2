---
ralph_prd: 2
id: child-cycle-root
title: Child cycle root
kind: root
workspace: .
defaults:
  evidence_mode: change-only
---

## Vertical slices

- [ ] **cycle-root-task — Enter the child graph**
  - Resultado: o root aponta para o child previsto.
  - Dependências: nenhuma
  - Limites:
    - Não permitir retorno ao root.
  - Modo de evidência: change-only
  - Sub-PRD: child.md
