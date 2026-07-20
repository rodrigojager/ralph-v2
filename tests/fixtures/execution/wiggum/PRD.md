---
ralph_prd: 2
id: wiggum-bounded
title: Convergência limitada do modo wiggum
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: criteria
metadata:
  fixture: s03-wiggum-bounded
---

# Convergência limitada do modo wiggum

A mesma task pode receber até duas chamadas, mas só evidência determinística permite conclusão.

## Vertical slices

- [ ] **converge-capability — Convergir para o valor verificável**
  - Resultado: `product/capability.txt` contém exatamente `converged` dentro do limite configurado.
  - Dependências: nenhuma
  - Critérios:
    1. O command gate confirma o valor final `converged`.
  - Verificação:
    - command: {"category":"test","skipPolicy":"required","blocking":true,"command":{"executable":"bun","args":["-e","import { readFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'converged') process.exit(1)"],"cwd":".","shell":false,"timeoutMs":5000,"successExitCodes":[0],"outputLimitBytes":4096}}
  - Limites:
    - Não iniciar uma terceira chamada nem concluir por texto do executor.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=2; timeout=20s
