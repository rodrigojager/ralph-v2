---
ralph_prd: 2
id: deadline-bounded
title: Timeout autoritativo da tarefa
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: criteria
metadata:
  fixture: s03-deadline
---

# Timeout autoritativo da tarefa

## Vertical slices

- [ ] **deadline-slice — Cancelar trabalho atrasado**
  - Resultado: o executor atrasado é cancelado antes de escrever `delivery/late.txt`.
  - Dependências: nenhuma
  - Critérios:
    1. Nenhuma escrita ocorre depois do timeout.
  - Verificação:
    - command: {"category":"test","skipPolicy":"required","blocking":true,"command":{"executable":"bun","args":["-e","import { existsSync } from 'node:fs'; if (existsSync('delivery/late.txt')) process.exit(1)"],"cwd":".","shell":false,"timeoutMs":5000,"successExitCodes":[0],"outputLimitBytes":4096}}
  - Limites:
    - Não permitir trabalho posterior ao deadline.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=2s
