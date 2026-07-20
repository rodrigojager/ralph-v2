---
ralph_prd: 2
id: adversarial-outcome
title: Output do executor não governa conclusão
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: criteria
metadata:
  fixture: s03-adversarial-outcome
---

# Output do executor não governa conclusão

O texto do backend é apenas uma alegação; o contrato oficial permanece neste documento.

## Vertical slices

- [ ] **deliver-evidence — Entregar evidência material e verificável**
  - Resultado: `product/capability.txt` contém exatamente `delivered`.
  - Dependências: nenhuma
  - Critérios:
    1. O arquivo mudou e o command gate confirma o valor `delivered`.
  - Verificação:
    - command: {"category":"test","skipPolicy":"required","blocking":true,"command":{"executable":"bun","args":["-e","import { readFileSync } from 'node:fs'; if (readFileSync('product/capability.txt', 'utf8') !== 'delivered') process.exit(1)"],"cwd":".","shell":false,"timeoutMs":5000,"successExitCodes":[0],"outputLimitBytes":4096}}
  - Limites:
    - Não concluir sem mudança e gate aprovado, independentemente da redação do backend.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s
