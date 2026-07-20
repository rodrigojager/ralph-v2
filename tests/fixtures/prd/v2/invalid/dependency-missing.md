---
ralph_prd: 2
id: dependency-missing
title: Missing dependency
kind: root
workspace: .
defaults:
  evidence_mode: change-only
---

## Vertical slices

- [ ] **dependent-slice — Depend on an absent local task**
  - Resultado: a dependência ausente é diagnosticada.
  - Dependências: never-declared
  - Limites:
    - Não procurar a dependência em outro documento.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum
