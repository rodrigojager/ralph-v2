---
ralph_prd: 2
id: missing-child-root
title: Missing child root
kind: root
workspace: .
defaults:
  evidence_mode: change-only
---

## Vertical slices

- [ ] **missing-child-task — Require a pre-authored child**
  - Resultado: a referência ausente impede compilação.
  - Dependências: nenhuma
  - Limites:
    - Não pedir ao executor para criar o child.
  - Modo de evidência: change-only
  - Sub-PRD: absent-child.md
