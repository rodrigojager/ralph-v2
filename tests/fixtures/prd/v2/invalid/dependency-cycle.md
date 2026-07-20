---
ralph_prd: 2
id: dependency-cycle
title: Dependency cycle
kind: root
workspace: .
defaults:
  evidence_mode: change-only
---

## Vertical slices

- [ ] **cycle-a — First side of the cycle**
  - Resultado: a primeira task participa do ciclo.
  - Dependências: cycle-b
  - Limites:
    - Não quebrar o ciclo por ordem de arquivo.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum

- [ ] **cycle-b — Second side of the cycle**
  - Resultado: a segunda task participa do ciclo.
  - Dependências: cycle-a
  - Limites:
    - Não ignorar a dependência reversa.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum
