---
ralph_prd: 2
id: no-change-change-only
title: Delta obrigatório em modo change-only
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: change-only
metadata:
  fixture: s03-no-change-change-only
---

# Delta obrigatório em modo change-only

O command gate confirma o baseline, mas esta tarefa só entrega quando existe mudança atribuível.

## Vertical slices

- [ ] **materialize-change — Produzir uma alteração auditável**
  - Resultado: existe um delta permitido não vazio atribuído à tentativa atual.
  - Dependências: nenhuma
  - Verificação:
    - command: {"category":"command","skipPolicy":"required","blocking":true,"command":{"executable":"bun","args":["-e","import { readFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8').trim() !== 'unchanged-proof') process.exit(1)"],"cwd":".","shell":false,"timeoutMs":5000,"successExitCodes":[0],"outputLimitBytes":4096}}
  - Limites:
    - Não tratar command gate aprovado como substituto de um delta em `change-only`.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s
