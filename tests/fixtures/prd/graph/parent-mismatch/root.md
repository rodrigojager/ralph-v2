---
ralph_prd: 2
id: mismatch-root
title: Parent mismatch root
kind: root
workspace: .
defaults:
  evidence_mode: change-only
---

## Vertical slices

- [ ] **mismatch-parent-task — Reference a child with another declared parent**
  - Resultado: o parent mismatch é recusado.
  - Dependências: nenhuma
  - Limites:
    - Não aceitar um vínculo ambíguo.
  - Modo de evidência: change-only
  - Sub-PRD: child.md
