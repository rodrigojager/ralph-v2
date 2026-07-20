---
ralph_prd: 2
id: single-pass
title: Entrega vertical em uma passagem
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: criteria
metadata:
  fixture: s03-single-pass
---

# Entrega vertical em uma passagem

O arquivo de capacidade representa um resultado observável sem prescrever stack ao projeto.

## Vertical slices

- [ ] **deliver-capability — Entregar a capacidade mínima de ponta a ponta**
  - Resultado: o consumidor encontra a capacidade materializada com o valor `delivered`.
  - Dependências: nenhuma
  - Critérios:
    1. O arquivo `product/capability.txt` contém exatamente `delivered`.
  - Verificação:
    - command: {"category":"test","skipPolicy":"required","blocking":true,"command":{"executable":"bun","args":["-e","import { readFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'delivered') process.exit(1)"],"cwd":".","shell":false,"timeoutMs":5000,"successExitCodes":[0],"outputLimitBytes":4096}}
  - Limites:
    - Não adicionar outra capacidade nem escolher linguagem ou framework para o projeto-alvo.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s
