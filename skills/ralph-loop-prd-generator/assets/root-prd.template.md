---
ralph_prd: 2
id: project-increment
title: Incremento vertical do projeto
kind: root
workspace: .
defaults:
  evidence_mode: change-only
metadata:
  generated_from: ralph-loop-prd-generator-template
---

# Incremento vertical do projeto

Substituir este contexto por fatos compartilhados do pedido e do projeto. Preservar stack,
contratos e restrições encontrados. O texto ilustrativo não constitui requisito do produto.

## Fontes de verdade

- Pedido, repositório, especificação e decisões fornecidas para a geração.
- Contratos e verificações já existentes no projeto.

## Vertical slices

- [ ] **capability-delivery — Entregar uma capacidade observável**
  - Resultado: o ator ou caller definido pela fonte aciona o menor fluxo útil e observa o resultado integrado pelas boundaries necessárias.
  - Dependências: nenhuma
  - Critérios:
    1. O gatilho, o resultado esperado e a falha relevante definidos pela fonte atravessam as boundaries necessárias.
    2. O incremento funciona sem depender de uma integração futura não declarada.
  - Verificação:
    - instruction: Executar a verificação de maior nível já disponível para o fluxo e registrar resultado e limitações.
  - Limites:
    - Não incluir uma segunda capacidade independente.
    - Não substituir contratos ou ferramentas estabelecidos sem decisão explícita.
  - Modo de evidência: change-only
  - Sub-PRD: plans/capability-delivery.prd.md

## Nota de autoria

Remover esta seção antes do handoff. Substituir todos os termos ilustrativos por fatos específicos e
falsificáveis. Se a tarefa não precisar de detalhamento, usar `Sub-PRD: nenhum` e não criar child.
