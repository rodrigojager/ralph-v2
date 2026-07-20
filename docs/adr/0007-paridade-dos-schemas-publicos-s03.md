# ADR 0007 — Paridade dos schemas públicos S03

- Estado: aceita
- Data: 2026-07-18
- Slice: S03
- Documentos relacionados: `docs/08-orquestracao-executor-tools-e-contexto.md`, `docs/09-evidencias-gates-judge-e-revisoes.md`, `docs/11-eventos-telemetria-logs-e-relatorios.md`, `docs/17-contratos-e-schemas.md`, `implementation/03-orquestrador-e-modos.md`, ADR 0006

## Contexto

Antes do primeiro release, a auditoria S03 encontrou divergência entre alguns JSON Schemas gerados e os valores realmente produzidos, persistidos e expostos por `status run`. Os schemas continham campos reservados para slices futuras, enquanto faltavam bindings que tornam contexto e evidência verificáveis. Manter essa superfície aspiracional permitiria output aceito pelo schema que o runtime não consegue materializar ou reconstruir.

Como ainda não existe release compatível a preservar, corrigir o contrato agora é preferível a publicar campos fictícios e depois sustentar uma compatibilidade enganosa.

## Decisão

### Regra de publicação

Um campo de record público S03 só pode ser publicado quando possui producer autoritativo, round-trip na persistência e reader validado. `status run` reutiliza os mesmos schemas de run, task, attempt e report; não mantém DTO permissivo paralelo. Campos planejados para outra slice entram somente quando essa slice materializar e persistir sua semântica.

A correção pré-release mantém `schemaVersion: 1`, regenera os JSON Schemas dos validators runtime e invalida artefatos de desenvolvimento antigos. Depois do primeiro release, mudança incompatível exigirá a evolução de versão/migration normal.

### Records e report S03

- `RunRecord` persiste `effectiveOptions` completo e `updatedAt`; remove `parent` e `eventCursor` ainda não materializados.
- `TaskRecord` usa `markerContentHash` e `updatedAt`; remove `childRunId` e `claimId`, reservados para S09.
- `AttemptRecord` conserva o ordinal básico e inclui `executorOutcome`, `evidenceBundleId` e `completionDecision` opcionais mais `updatedAt`; remove ordinals especializados, snapshot de perfil e assessment ID que pertencem a S04/S06/S09.
- `AttemptRecord` persiste ainda `effectiveOptionsHash` e o snapshot exato resolvido para a task, enquanto o snapshot do run representa a invocação; `--task` é controle da invocação e não impede retomada sem repetir o seletor.
- `ExecutionReport` inclui identidade do root, `definitionHash`, `graphHash`, hash e snapshot completo das opções efetivas, e counters separados para tasks, attempts, calls, Wiggum, retries, revisões, gates e no-change.

### Binding de evidência

`GitBaseline.workspaceSnapshotHash` identifica o snapshot exato do workspace usado na comparação; `statusHash` continua representando os fatos Git. `ChangeEvidence.diffHash`/`diffRef` apontam para o delta cumulativo da task, enquanto `attemptDiffHash`/`attemptDiffRef` apontam para o delta da tentativa. Os arquivos de diff são persistidos sob a run e seus hashes vinculam o conteúdo referenciado ao evidence bundle.

Uma completion nunca depende apenas de paths ambientais ou de um hash sem artefato resolvível. O evidence bundle carrega baseline, bindings dos dois deltas, gates, artifacts, outcome opcional e `contextManifestHash` antes de receber seu próprio content hash. Cada delta declara `reproducible` e enumera `missingContent`; bytes sensíveis ou acima dos limites não são arquivados, mas tornam a decisão deterministicamente não aprovável. Artifacts aprovados apontam para objeto imutável, e falha de coleta/materialização vira gate interno bloqueante.

Snapshots inventariam diretórios do projeto sem nomes de stacks hardcoded. Somente `.ralph` e o armazenamento interno ficam fora do delta de produto; fatos de controle selecionados do Git (`config`, `HEAD`, `index`, refs e hooks) entram por hash, nunca por retenção de conteúdo. Assim um gate não consegue alterar hooks/config silenciosamente.

Resultados de command gate preservam contagem de bytes e flags de truncamento da visão resumida e da prova bruta. Os arquivos brutos redigidos são content-addressed e namespaced por tentativa; retries não sobrescrevem evidência anterior.

### Request resolvível do executor

`ExecutionRequest` entrega `contextManifest` e o `ContextManifestBundle` correspondente, identifica `callOrdinal`, e cada `ModelCallRecord` vincula o hash do contexto usado naquela chamada. O bundle contém resources, truncamentos e JSON canônico; cada resource possui ref portátil, media type, conteúdo e hashes. Toda ref fornecida ao backend precisa resolver no bundle materializado, em um path relativo contido no workspace ou em um namespace portátil autorizado, sem depender de memória conversacional, path absoluto oculto ou acesso do backend ao ledger. Em Wiggum, cada chamada reconstrói contexto com budgets restantes e assessment anterior; `deadlineAt` participa do hash autenticado.

## Consequências

- JSON Schemas, producer, SQLite e `status run` passam a descrever a mesma realidade.
- Campos de parent/claim, providers e judge deixam de parecer disponíveis antes de S04/S06/S09.
- Evidence distingue mudança cumulativa da task e mudança da tentativa, permitindo no-change e retomada auditáveis.
- Backends recebem contexto autocontido e refs resolvíveis, mas o bundle aumenta explicitamente a superfície que precisa de budget, redaction e hash.
- Fixtures e artefatos gerados antes desta decisão devem ser regenerados; não existe migração de consumidor externo porque o projeto permanece pré-release.

## Evidência esperada

- `bun run schemas:check` prova paridade entre validators e JSON Schemas regenerados;
- testes de persistence fazem round-trip dos campos publicados e rejeitam shapes aspiracionais;
- `status run` retorna records parseados pelos mesmos schemas persistidos;
- testes de contexto provam que refs do request resolvem no bundle e preservam hashes/truncamentos;
- evidence persistida contém `workspaceSnapshotHash` e refs/hash distintos para os deltas de task e attempt;
- os objetos/patches vinculados pelos deltas permitem reconstruir a mudança mesmo depois de outra task alterar ou remover o mesmo arquivo;
- o E2E empacotado conclui a slice e consulta status/report sem adapter de schema.
