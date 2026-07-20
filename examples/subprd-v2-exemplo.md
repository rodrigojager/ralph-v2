---
ralph_prd: 2
id: checkout-cart-review-detail
title: Detalhamento do resumo do carrinho
kind: child
parent:
  prd: PRD-v2-exemplo.md
  task: cart-review
workspace: .
defaults:
  executor_profile: default
  evidence_mode: change-only
metadata:
  example: true
---

# Sub-PRD — resumo do carrinho

Este arquivo detalha somente a tarefa `cart-review`. Ele foi criado pela skill junto com o PRD pai, antes do runtime. O executor não deve gerar nem reescrever este plano.

## Contrato compartilhado do child

O resumo consome o contrato autoritativo do carrinho. Os nomes concretos de arquivo, comandos e ferramentas devem ser preenchidos pela skill a partir do projeto real; este exemplo permanece neutro quanto ao stack.

## Vertical slices

- [ ] **cart-review-contract — Disponibilizar e consumir o resumo de sucesso**
  - Resultado: a fronteira de dados entrega o resumo necessário e a superfície do usuário exibe itens, quantidades e total no caminho de sucesso.
  - Dependências: nenhuma
  - Critérios:
    1. O contrato possui versão ou validação compatível com as convenções do projeto.
    2. A mesma fixture de resumo é aceita na fronteira e renderizada na superfície do usuário.
    3. Quantidade e total não divergem entre resposta e apresentação.
  - Verificação:
    - Executar o teste de contrato definido pelo projeto.
    - Executar um teste integrado que atravesse a fronteira e a apresentação.
  - Limites:
    - Não adicionar estados de cupom, frete ou pagamento ao contrato.
    - Não reorganizar camadas sem necessidade para esta capacidade.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum

- [ ] **cart-review-states — Entregar estados vazio, loading e erro de ponta a ponta**
  - Resultado: o usuário distingue carregamento, carrinho vazio e falha, e pode seguir a ação apropriada em cada estado.
  - Dependências: cart-review-contract
  - Critérios:
    1. Loading não mostra conteúdo antigo como se fosse atual.
    2. Carrinho vazio possui mensagem e ação coerentes com o produto.
    3. Falha não é confundida com vazio e possui tentativa novamente quando o projeto permitir.
  - Verificação:
    - Executar cenários integrados para vazio e erro.
    - Executar o cenário end to end de transição entre loading e sucesso ou erro.
  - Limites:
    - Não criar um framework global de estados.
    - Não implementar observabilidade além do necessário para diagnosticar este fluxo.
  - Modo de evidência: change-only
  - Sub-PRD: nenhum

- [ ] **cart-review-proof — Materializar evidência navegável do fluxo completo**
  - Resultado: o run produz um artifact versionado que referencia os cenários exercitados e seus resultados, permitindo auditoria pelo pai e pelo judge opcional.
  - Dependências: cart-review-states
  - Critérios:
    1. O artifact referencia sucesso, vazio e erro sem incluir segredos ou dados pessoais.
    2. Cada referência aponta para resultado de gate, teste ou arquivo verificável.
  - Verificação:
    - artifact: cart-review-evidence; path=artifacts/cart-review-evidence.json
  - Limites:
    - O artifact não substitui os testes das tarefas anteriores.
    - Não incluir transcript bruto que contenha credenciais.
  - Modo de evidência: artifact
  - Sub-PRD: nenhum
