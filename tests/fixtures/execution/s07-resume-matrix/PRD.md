---
ralph_prd: 2
id: s07-resume-matrix
title: Matriz integrada de retomada determinística
kind: root
workspace: .
defaults:
  executor_profile: fixture-executor
  evidence_mode: criteria
metadata:
  fixture: s07-resume-matrix
---

# Matriz integrada de retomada determinística

As quatro entregas independentes permitem provar a prioridade de retomada sem prescrever stack.

## Vertical slices

- [~] **prepared-first — Reconciliar primeiro a conclusão preparada**
  - Resultado: a evidência preparada materializa `delivery/prepared.txt`.
  - Dependências: nenhuma
  - Critérios:
    1. O artefato preparado existe e permanece recuperável.
  - Verificação:
    - artifact: prepared-result; path=delivery/prepared.txt
  - Limites:
    - Não alterar os outros artefatos desta matriz.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s

- [~] **active-second — Retomar trabalho ativo antes dos demais**
  - Resultado: a retomada materializa `delivery/active.txt`.
  - Dependências: nenhuma
  - Critérios:
    1. O artefato ativo existe após a retomada.
  - Verificação:
    - artifact: active-result; path=delivery/active.txt
  - Limites:
    - Não alterar os outros artefatos desta matriz.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s

- [~] **interrupted-third — Retomar trabalho interrompido antes do pendente**
  - Resultado: a retomada materializa `delivery/interrupted.txt`.
  - Dependências: nenhuma
  - Critérios:
    1. O artefato interrompido existe após a retomada.
  - Verificação:
    - artifact: interrupted-result; path=delivery/interrupted.txt
  - Limites:
    - Não alterar os outros artefatos desta matriz.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s

- [ ] **pending-fourth — Executar trabalho novo somente depois das retomadas**
  - Resultado: a execução materializa `delivery/pending.txt`.
  - Dependências: nenhuma
  - Critérios:
    1. O artefato pendente existe ao final da matriz.
  - Verificação:
    - artifact: pending-result; path=delivery/pending.txt
  - Limites:
    - Não alterar os outros artefatos desta matriz.
  - Modo de evidência: criteria
  - Sub-PRD: nenhum
  - Orçamento: model_calls=1; timeout=20s
