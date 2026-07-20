---
ralph_prd: 2
id: unicode-offsets
title: Ação com offsets UTF-8
kind: root
workspace: .
defaults:
  evidence_mode: change-only
metadata:
  descrição: usuário, café e ação antes do marcador
---

# Contexto com Unicode — usuário, café, ação

## Vertical slices

- [ ] **unicode-slice — Entregar ação observável**
  - Resultado: o usuário vê “concluído” sem perder acentuação.
  - Dependências: nenhuma
  - Limites:
    - Não alterar a codificação do arquivo.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum
