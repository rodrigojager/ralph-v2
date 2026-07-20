---
ralph_prd: 2
id: capability-delivery-details
title: Detalhamento da capacidade observável
kind: child
parent:
  prd: ../PRD.md
  task: capability-delivery
workspace: .
defaults:
  evidence_mode: change-only
metadata:
  generated_from: ralph-loop-prd-generator-template
---

# Detalhamento da capacidade observável

Substituir este contexto pelas decisões exclusivas do resultado pai. Todas as slices abaixo devem,
em conjunto, satisfazer o Resultado e os limites de `capability-delivery`.

## Vertical slices

- [ ] **first-integrated-increment — Entregar o primeiro incremento integrado**
  - Resultado: o caller definido pela fonte percorre o primeiro caminho utilizável da capacidade e observa o contrato integrado.
  - Dependências: nenhuma
  - Critérios:
    1. Produtor e consumidor do contrato mínimo funcionam no mesmo incremento.
    2. A falha relevante retorna um resultado observável e diagnosticável conforme a fonte.
  - Verificação:
    - instruction: Executar a verificação de maior nível existente para este caminho e registrar resultado e limitações.
  - Limites:
    - Não antecipar variantes que tenham resultado independente.
    - Não escolher tecnologia ou comando ausente da fonte.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum

- [ ] **complete-parent-outcome — Completar o resultado externo do pai**
  - Resultado: o caller obtém o restante do resultado externo prometido pela task pai sem quebrar o incremento anterior.
  - Dependências: first-integrated-increment
  - Critérios:
    1. O resultado externo completo do pai é observável de ponta a ponta.
    2. O incremento anterior permanece compatível ou sua transição explícita foi concluída.
  - Verificação:
    - instruction: Executar o cenário integrado do resultado pai e registrar prova e limitações.
  - Limites:
    - Não incluir capacidade externa ao resultado da task pai.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum

## Nota de autoria

Remover esta seção antes do handoff. Ajustar `parent.prd`, `parent.task`, IDs, slices, critérios,
verificações e limites. Não manter duas slices se uma única tentativa pequena puder entregar o pai.
