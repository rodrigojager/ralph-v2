---
ralph_prd: 2
id: project-increment
title: Incremento vertical do projeto
kind: root
workspace: .
defaults:
  evidence_mode: change-only
metadata:
  template_contract: ralph-loop-prd-generator-v1
---

# Incremento vertical do projeto

Este arquivo é um molde estrutural válido. A skill deve substituir o conteúdo ilustrativo por fatos do projeto, preservando sua linguagem, arquitetura, ferramentas e restrições. Validar a estrutura não prova que critérios genéricos sejam adequados ao projeto real.

## Fontes de verdade

- Repositório, especificação e decisões fornecidas para a geração.
- Contratos e verificações já existentes no projeto.

## Restrições compartilhadas

- Não escolher nem trocar linguagem, framework, banco, cloud ou ferramenta sem uma decisão explícita da fonte.
- Cada task deve entregar um comportamento pequeno de ponta a ponta e sua prova proporcional.
- Root e todos os children referenciados devem existir antes do run.

## Vertical slices

- [ ] **first-slice — Entregar a primeira capacidade observável**
  - Resultado: um ator ou caller definido pela fonte aciona o menor fluxo útil e observa o resultado integrado pelas boundaries realmente necessárias.
  - Dependências: nenhuma
  - Critérios:
    1. O gatilho, o resultado esperado e a falha relevante definidos pela fonte funcionam através das boundaries necessárias.
    2. O incremento permanece utilizável e verificável sem depender de uma integração futura não declarada.
  - Verificação:
    - instruction: Executar a verificação de maior nível já disponível no projeto para o fluxo e registrar resultado e limitações.
  - Limites:
    - Não incluir uma segunda capacidade independente nesta slice.
    - Não substituir contratos ou ferramentas estabelecidos sem necessidade comprovada pela fonte.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum

## Instrução para a autora

A task acima é somente scaffolding válido. Antes de entregar um PRD real, a skill deve substituir ID, título, Resultado, Critérios, Verificação e Limites por conteúdo específico e falsificável; remover esta seção se ela não ajudar o leitor; e criar previamente cada child referenciado.
