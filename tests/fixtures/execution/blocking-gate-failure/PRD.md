---
ralph_prd: 2
id: blocking-gate-failure
title: Falha de gate bloqueante
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: criteria
metadata:
  fixture: s03-blocking-gate-failure
---

# Falha de gate bloqueante

Existe mudança material, mas somente o valor aceito satisfaz o contrato.

## Vertical slices

- [ ] **deliver-accepted-value — Entregar somente o valor aceito pelo contrato**
  - Resultado: `product/capability.txt` contém exatamente `accepted`.
  - Dependências: nenhuma
  - Critérios:
    1. A verificação bloqueante confirma o valor `accepted`.
  - Verificação:
    - command: {"category":"test","skipPolicy":"required","blocking":true,"command":{"executable":"bun","args":["-e","import { readFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'accepted') process.exit(1)"],"cwd":".","shell":false,"timeoutMs":5000,"successExitCodes":[0],"outputLimitBytes":4096}}
  - Limites:
    - Não aceitar outro valor apenas porque o executor produziu um diff.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s
