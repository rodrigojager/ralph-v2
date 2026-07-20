---
ralph_prd: 2
id: two-task-order
title: Duas entregas com dependência explícita
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: criteria
metadata:
  fixture: s03-two-task-order
---

# Duas entregas com dependência explícita

O segundo resultado só é válido depois que o contrato pequeno da primeira task existir.

## Vertical slices

- [ ] **publish-contract — Publicar o contrato mínimo consumível**
  - Resultado: o consumidor encontra a versão `v1` do contrato compartilhado.
  - Dependências: nenhuma
  - Critérios:
    1. `delivery/contract.txt` contém exatamente `v1`.
  - Verificação:
    - command: {"category":"command","skipPolicy":"required","blocking":true,"command":{"executable":"bun","args":["-e","import { readFileSync } from 'node:fs'; if (readFileSync('delivery/contract.txt', 'utf8') !== 'v1') process.exit(1)"],"cwd":".","shell":false,"timeoutMs":5000,"successExitCodes":[0],"outputLimitBytes":4096}}
    - artifact: published-contract; path=delivery/contract.txt
  - Limites:
    - Não produzir ainda o resultado que consome esse contrato.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s

- [ ] **consume-contract — Entregar resultado ligado ao contrato publicado**
  - Resultado: o consumidor encontra o resultado `ready` junto do contrato `v1` já entregue.
  - Dependências: publish-contract
  - Critérios:
    1. O contrato continua em `v1` e `delivery/result.txt` contém exatamente `ready`.
  - Verificação:
    - command: {"category":"test","skipPolicy":"required","blocking":true,"command":{"executable":"bun","args":["-e","import { readFileSync } from 'node:fs'; if (readFileSync('delivery/contract.txt', 'utf8') !== 'v1' || readFileSync('delivery/result.txt', 'utf8') !== 'ready') process.exit(1)"],"cwd":".","shell":false,"timeoutMs":5000,"successExitCodes":[0],"outputLimitBytes":4096}}
  - Limites:
    - Não ampliar o contrato além do valor necessário para esta fixture.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s
