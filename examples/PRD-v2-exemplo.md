---
ralph_prd: 2
id: checkout-incremental
title: Checkout incremental por vertical slices
kind: root
workspace: .
defaults:
  executor_profile: default
  evidence_mode: change-only
metadata:
  example: true
---

# Checkout incremental

Este exemplo demonstra um PRD legível por humanos, com tarefas pequenas que atravessam apenas as camadas necessárias. Ele não prescreve linguagem, framework, banco ou provedor de infraestrutura.

## Contexto compartilhado

O produto já possui catálogo e identidade de usuário. O trabalho começa pelo menor fluxo de carrinho observável e termina antes de integração de pagamento. O contrato de preço usa a moeda configurada no projeto e não deve recalcular valores apenas na interface.

## Vertical slices

- [ ] **cart-add — Adicionar um item e confirmar o carrinho atualizado**
  - Resultado: ao acionar “adicionar”, o usuário recebe confirmação e vê quantidade e total retornados pela fonte autoritativa do produto.
  - Dependências: nenhuma
  - Critérios:
    1. Uma entrada válida altera o carrinho persistido pelo contrato existente do projeto.
    2. A resposta consumida pela interface contém item, quantidade e total coerentes.
    3. O estado de falha apresenta mensagem acionável e não exibe sucesso falso.
  - Verificação:
    - Executar o teste de contrato configurado no projeto para adicionar item.
    - Executar um cenário end to end de sucesso e um de falha.
  - Limites:
    - Não implementar remoção de item.
    - Não implementar pagamento.
    - Não escolher ou trocar o stack do projeto.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum

- [ ] **cart-review — Revisar itens e total antes de continuar**
  - Resultado: o usuário abre o resumo do carrinho e confere itens, quantidades e total em loading, sucesso, vazio e erro.
  - Dependências: cart-add
  - Critérios:
    1. Todos os itens retornados pela fonte autoritativa aparecem no resumo.
    2. O total exibido é o mesmo do contrato, sem recomputação divergente na camada visual.
    3. Loading, carrinho vazio e erro são distinguíveis.
  - Verificação:
    - Todas as verificações do sub-PRD referenciado devem passar.
    - Executar o cenário end to end final do resumo do carrinho.
  - Limites:
    - Não implementar cupom.
    - Não implementar cálculo de frete.
    - Não implementar pagamento.
  - Modo de evidência: change-only
  - Sub-PRD: subprd-v2-exemplo.md

- [ ] **checkout-readiness-note — Registrar a fronteira pronta para a próxima slice**
  - Resultado: existe um registro versionado e revisável do contrato entregue e das integrações deliberadamente restantes para pagamento.
  - Dependências: cart-review
  - Critérios:
    1. O artifact identifica os contratos já exercitados e os pontos ainda fora de escopo.
  - Verificação:
    - artifact: checkout-readiness; path=artifacts/checkout-readiness.md
  - Limites:
    - Não implementar nenhuma integração de pagamento nesta tarefa.
    - Não declarar segurança ou conformidade que não tenha sido verificada.
  - Modo de evidência: artifact
  - Sub-PRD: nenhum

## Observação para humanos

A segunda tarefa usa um sub-PRD porque seus estados e contratos precisam de mais detalhe. O Ralph valida esse arquivo antes de iniciar o run e só conclui `cart-review` depois de todas as tarefas internas e dos critérios externos.
