---
ralph_prd: 2
id: vertical-notes
title: Vertical Notes de ponta a ponta
kind: root
workspace: .
defaults:
  judge_profile: sample-fake-judge
  evidence_mode: change-only
metadata:
  sample:
    id: s12-end-to-end
    validation_status: executable-pending
---

# Vertical Notes de ponta a ponta

Este plano implementa o produto descrito em `PROJECT.md`. Cada incremento entrega um caminho
observavel atraves das boundaries necessarias. O executor deve preservar Node.js built-in no
servidor, JavaScript de navegador sem framework, persistencia JSON atomica e container OCI.

O judge fake do sample reprova deliberadamente a primeira avaliacao de `note-create-flow` e aprova
a revisao seguinte somente quando existe uma tentativa anterior marcada `revision_required`. Uma
tentativa interrompida não libera a aprovação. Um judge real e sempre opt-in e usa um
perfil independente escolhido pelo operador.

## Fontes de verdade

- `PROJECT.md` define o produto e a stack escolhida apenas para este sample.
- `config/fake-judge.config.yaml` e `tools/ralph-sample-judge.mjs` definem o judge deterministico.
- `expected/` contem somente projecoes ilustrativas, nunca prova de uma execucao real.

## Vertical slices

- [ ] **health-surface — Exibir a saude real do servico desde a API ate a pagina**
  - Resultado: ao abrir a aplicacao, a pessoa ve o estado atual do servidor obtido por `GET /api/health`, e uma falha de rede aparece como indisponibilidade compreensivel.
  - Dependências: nenhuma
  - Critérios:
    1. `GET /api/health` responde um contrato JSON estavel que distingue sucesso de erro HTTP.
    2. A pagina consulta o endpoint e apresenta estados de carregamento, online e indisponivel sem inventar sucesso.
    3. A mesma porta e o mesmo health endpoint sao usados pelo start local e pelo healthcheck do container.
  - Verificação:
    - instruction: Iniciar a aplicacao pela instrucao documentada, abrir a pagina, registrar o contrato de sucesso e registrar a apresentacao de uma falha de rede real ou simulada pelo operador.
    - artifact: health-runbook; path=artifacts/health-runbook.md
  - Limites:
    - Nao implementar criacao de notas nesta slice.
    - Nao adicionar framework ou dependencia de runtime.
    - Nao declarar suporte de plataforma que nao tenha sido exercitado.
  - Modo de evidência: change+artifact
  - Sub-PRD: nenhum

- [ ] **notes-lifecycle — Criar e recuperar notas persistidas pelo fluxo completo**
  - Resultado: a pessoa cria uma nota valida pela pagina e continua vendo o mesmo dado depois de refresh e reinicio, enquanto entradas invalidas e falhas de persistencia permanecem observaveis.
  - Dependências: health-surface
  - Critérios:
    1. Todas as slices folha de `plans/notes-lifecycle.prd.md` estao concluidas e reconciliadas.
    2. O fluxo final nao depende de estado somente em memoria nem de integracao posterior nao declarada.
  - Verificação:
    - instruction: Reconciliar os artifacts e as evidencias das slices folha e registrar o resultado externo completo do ciclo de notas.
  - Limites:
    - Nao incluir autenticacao, compartilhamento, edicao ou exclusao de notas.
    - Nao marcar o pai concluido enquanto qualquer slice do Sub-PRD estiver incompleta.
  - Modo de evidência: change-only
  - Sub-PRD: plans/notes-lifecycle.prd.md

- [ ] **operator-diagnostics — Correlacionar uma falha visivel com logs e operacao do container**
  - Resultado: quando uma chamada da pagina falha, a pessoa ve um identificador de correlacao e o operador encontra o mesmo identificador em um log redigido e no runbook de diagnostico do servico local ou containerizado.
  - Dependências: notes-lifecycle
  - Critérios:
    1. Respostas de erro da API carregam um identificador opaco que a pagina apresenta sem stack trace.
    2. Logs estruturados permitem localizar o mesmo identificador sem registrar o texto da nota nem credenciais.
    3. O runbook descreve start, health, localizacao da persistencia, parada e recuperacao sem apagar dados implicitamente.
  - Verificação:
    - instruction: Produzir uma falha de validacao ou persistencia, correlacionar pagina e log pelo identificador e registrar o procedimento local e em container.
    - artifact: operator-runbook; path=artifacts/operator-runbook.md
  - Limites:
    - Nao enviar telemetria para servico externo.
    - Nao incluir observabilidade que nao seja consumida pelo fluxo deste sample.
    - Nao registrar corpo de nota, segredo ou variavel de ambiente sensivel.
  - Modo de evidência: change+artifact
  - Sub-PRD: nenhum
