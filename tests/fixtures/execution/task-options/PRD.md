---
ralph_prd: 2
id: task-options
title: Opções efetivas distintas por tarefa
kind: root
workspace: .
defaults:
  executor_profile: default-unused
  evidence_mode: criteria
metadata:
  fixture: s03-task-options
---

# Opções efetivas distintas por tarefa

Cada corte usa seu próprio perfil e budget, mantendo a mesma execução de loop.

## Vertical slices

- [ ] **first-profile — Executar com o primeiro perfil**
  - Resultado: `delivery/first.txt` contém `first`.
  - Dependências: nenhuma
  - Critérios:
    1. O primeiro arquivo foi entregue pelo perfil correto.
  - Verificação:
    - command: {"category":"test","skipPolicy":"required","blocking":true,"command":{"executable":"bun","args":["-e","import { readFileSync } from 'node:fs'; if (readFileSync('delivery/first.txt', 'utf8') !== 'first') process.exit(1)"],"cwd":".","shell":false,"timeoutMs":5000,"successExitCodes":[0],"outputLimitBytes":4096}}
  - Limites:
    - Não criar a entrega da segunda tarefa.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Perfis: executor=executor-one
  - Orçamento: model_calls=1; timeout=20s

- [ ] **second-profile — Executar com o segundo perfil e budget**
  - Resultado: `delivery/second.txt` contém `second`.
  - Dependências: first-profile
  - Critérios:
    1. O segundo arquivo foi entregue pelo segundo perfil.
  - Verificação:
    - command: {"category":"test","skipPolicy":"required","blocking":true,"command":{"executable":"bun","args":["-e","import { readFileSync } from 'node:fs'; if (readFileSync('delivery/second.txt', 'utf8') !== 'second') process.exit(1)"],"cwd":".","shell":false,"timeoutMs":5000,"successExitCodes":[0],"outputLimitBytes":4096}}
  - Limites:
    - Preservar a primeira entrega.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Perfis: executor=executor-two
  - Orçamento: model_calls=2; timeout=20s
