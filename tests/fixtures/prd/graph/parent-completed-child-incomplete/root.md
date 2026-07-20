---
ralph_prd: 2
id: completed-parent-root
title: Completed parent with incomplete child
kind: root
workspace: .
defaults:
  evidence_mode: change-only
---

## Vertical slices

- [x] **parent-slice — Parent marked complete too early**
  - Resultado: o corte pai somente termina quando todo o Sub-PRD termina.
  - Dependências: nenhuma
  - Limites:
    - Não liberar dependentes enquanto o child estiver incompleto.
  - Modo de evidência: change-only
  - Sub-PRD: child.md

- [ ] **dependent-slice — Depend on the complete parent slice**
  - Resultado: o corte dependente somente fica elegível após a conclusão real do pai.
  - Dependências: parent-slice
  - Limites:
    - Não interpretar apenas o marcador do pai como conclusão.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum
