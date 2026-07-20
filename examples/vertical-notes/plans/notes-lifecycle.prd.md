---
ralph_prd: 2
id: vertical-notes-lifecycle
title: Ciclo persistido de notas
kind: child
parent:
  prd: ../PRD.md
  task: notes-lifecycle
workspace: .
defaults:
  evidence_mode: change-only
metadata:
  sample:
    parent_outcome: create-and-recover-note
---

# Ciclo persistido de notas

As duas slices abaixo compoem o resultado externo de `notes-lifecycle`. A primeira estabiliza o
contrato de criacao consumido pela pagina. A segunda usa o mesmo contrato persistido para provar
refresh e reinicio sem ampliar o produto para um CRUD completo.

## Vertical slices

- [ ] **note-create-flow — Criar uma nota valida e explicar uma entrada rejeitada**
  - Resultado: a pessoa envia uma nota curta pela pagina, recebe a representacao criada pela API e ve o item imediatamente; uma entrada vazia ou acima do limite e rejeitada pelo mesmo contrato sem ser persistida.
  - Dependências: nenhuma
  - Critérios:
    1. Formulario, `POST /api/notes`, validacao, persistencia atomica e apresentacao do item usam um contrato versionado unico.
    2. A API diferencia criacao, entrada invalida e falha de persistencia por status e payloads documentados.
    3. Escrita interrompida nao substitui o arquivo persistido por JSON parcial.
  - Verificação:
    - instruction: Criar uma nota valida, submeter uma nota invalida, inspecionar o arquivo persistido e registrar os contratos observados sem copiar conteudo sensivel para o artifact.
    - artifact: note-contract; path=artifacts/note-contract.md
  - Limites:
    - Nao implementar listagem historica independente da nota recem-criada nesta slice.
    - Nao usar banco externo nem adicionar dependencia de runtime.
    - Nao reduzir a nota ou seus erros a estado apenas no navegador.
  - Modo de evidência: change+artifact
  - Sub-PRD: nenhum

- [ ] **note-resume-flow — Recuperar notas depois de refresh e reinicio**
  - Resultado: depois de refresh ou reinicio do servidor, a pagina carrega por `GET /api/notes` as notas confirmadas no arquivo atomico e apresenta uma falha de leitura sem apagar nem substituir os dados existentes.
  - Dependências: note-create-flow
  - Critérios:
    1. `GET /api/notes` e o carregamento inicial da pagina usam o contrato persistido estabilizado pela slice anterior.
    2. Refresh e reinicio preservam uma nota confirmada, sem depender do estado de memoria do processo ou do navegador.
    3. JSON ausente inicializa estado vazio, enquanto JSON invalido ou erro de leitura produz diagnostico e nao e sobrescrito silenciosamente.
  - Verificação:
    - instruction: Confirmar uma nota, registrar o estado anterior, reiniciar o processo, recarregar a pagina e documentar a recuperacao e a politica de falha sem incluir o texto da nota.
    - artifact: resume-checkpoint; path=artifacts/resume-checkpoint.md
  - Limites:
    - Nao adicionar edicao, exclusao, paginacao ou sincronizacao remota.
    - Nao tratar arquivo corrompido como lista vazia.
    - Nao alterar o contrato de criacao sem manter o consumidor da pagina na mesma slice.
  - Modo de evidência: change+artifact
  - Sub-PRD: nenhum
