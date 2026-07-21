# ADR 0006 — Orquestração S03, identidade estável e completion coordenada

- Estado: aceita
- Data: 2026-07-18
- Slice: S03
- Documentos relacionados: `docs/01-principios-e-invariantes.md`, `docs/02-escopo-e-modos-de-trabalho.md`, `docs/08-orquestracao-executor-tools-e-contexto.md`, `docs/09-evidencias-gates-judge-e-revisoes.md`, `docs/10-persistencia-retomada-watchdog-e-filhos.md`, `docs/11-eventos-telemetria-logs-e-relatorios.md`, `docs/17-contratos-e-schemas.md`, `implementation/03-orquestrador-e-modos.md`, ADR 0002, ADR 0004 e ADR 0005

## Contexto

S03 é a primeira slice em que o Ralph seleciona uma tarefa, chama um executor, observa mudanças reais, executa verificação e pode atualizar um marker. Isso transforma os contratos de PRD, ledger, eventos e CLI das slices anteriores em uma máquina de execução autoritativa.

O projeto está sendo implementado com `/goal` do Codex, mas `/goal` não pertence ao produto. O Ralph entregue continua sendo um CLI independente, governado por comandos próprios e consumidor de PRDs. Nenhuma configuração, backend ou caminho de runtime depende de `/goal`.

A auditoria dos contratos S01/S02 encontrou decisões que precisam ser congeladas antes do lifecycle:

- o PRD v2 permite contexto humano antes da fila, mas o objeto compilado ainda precisa preservá-lo para reconstrução de contexto;
- o hash da revisão muda quando o próprio Ralph troca `[ ]`, `[~]` ou `[x]`, por isso não pode ser a identidade estável de um plano retomável;
- no-change e skips possuem nomes legados e semânticas novas que não podem ser normalizados implicitamente;
- output do executor é uma alegação, enquanto completion atravessa SQLite e Markdown e exige coordenação explícita;
- children já são validados pelo compilador, porém execução supervisionada de children pertence a S09;
- fake executor é infraestrutura de prova, não provider disponível no produto final;
- S03 entrega retomada simples e consistência da completion, não leases, watchdog ou recuperação irrestrita de processos mortos.

## Decisão

### Separação entre `/goal` e o produto

1. `/goal` é somente o mecanismo usado para implementar este repositório.
2. O binário `ralph`, seus arquivos persistidos, seus eventos e seus perfis não conhecem `/goal`.
3. O runtime seleciona e executa trabalho exclusivamente a partir de comandos, configuração validada, graph compilado, ledger e policies do Ralph.
4. Nenhum texto do executor, incluindo `TASK_COMPLETE`, muda task, attempt, run, marker ou policy diretamente.

### Formato executável em S03

1. S03 executa somente um root PRD v2 selecionado por `ralph_prd: 2` e compilado recursivamente em strict mode.
2. `prd validate`, `prd inspect` e `prd migrate` continuam aceitando PRD clássico conforme seus contratos.
3. Tentar `once`, `loop` ou `wiggum` com PRD clássico falha antes de criar attempt ou chamar backend, com diagnostic estável e instrução para executar `prd migrate` para um destino separado.
4. O erro não converte, não sobrescreve e não atualiza marker clássico implicitamente.
5. S10 poderá ampliar a compatibilidade operacional mediante novo ADR; não poderá reintroduzir interpretação insegura de comandos clássicos em string.

Essa restrição evita atribuir ao marker `[~]` do formato clássico a semântica `active` do v2 e evita executar gates antigos como shell sem um contrato estruturado.

### Contexto compartilhado compilado

`PrdDocument` passa a preservar `sharedContext: MarkdownContent`, correspondente ao conteúdo Markdown entre o fim do frontmatter e o início do heading normativo `## Vertical slices`.

Regras:

- `markdown`, `text` e AST sanitizada seguem o mesmo contrato de `MarkdownContent` usado nas tasks;
- um documento sem prose compartilhada materializa contexto vazio válido, não `undefined` ambíguo;
- conteúdo posterior ao fim da seção normativa permanece preservado no arquivo, mas não entra automaticamente no contexto oficial;
- `once` e `loop` recebem o shared context necessário do documento atual e de ancestrais autorizados, sem incluir o PRD inteiro por hábito;
- `wiggum` inclui adicionalmente o PRD atual completo, relido somente após conferir o content hash compilado;
- truncamento por budget é explícito e diagnosticado; nunca transforma silêncio em contexto completo.

O context manifest continua incluindo task, critérios, limites, evidence mode, verifications, dependency evidence disponível, baseline, budgets e a proibição de o modelo editar status ou criar PRD/sub-PRD.

### Três identidades de conteúdo

O compilador e o orchestrator usam hashes diferentes para finalidades diferentes:

1. **`definitionHash`:** identidade semântica estável do plano. Inclui documentos, shared context, defaults, parent links, task specs sem status, dependencies, child edges, ordem e grupos. Exclui markers/status, content hashes dos bytes, source positions e eligible tasks derivadas do status. Uma edição semântica externa altera esse hash; uma troca autorizada de marker não.
2. **`graphHash`:** hash da revisão compilada exata. Conserva content hashes, statuses, ordens derivadas e demais fatos da revisão atual. Muda após marker update e é registrado como revision hash em eventos, reports e reconciliation.
3. **`taskSpecHash`:** hash canônico da especificação efetiva de uma task, namespaced por document ID e task ID. Inclui resultado, dependencies, critérios, verifications, limites, evidence mode, child/group, profiles, budget e notas; exclui status, source position e fatos produzidos pela tentativa.

Hashes usam serialização canônica, não incluem paths absolutos da máquina e são persistidos juntos. Resume localiza um run compatível por workspace, root PRD e `definitionHash`; marker CAS continua usando o `contentHash` do documento. Mudança de definição durante um run produz conflito explícito, não um run novo silencioso.

### Política canônica de no-change

O runtime normaliza para exatamente quatro valores:

- `require-change`: exige delta permitido não vazio para que a tentativa seja materialmente suficiente;
- `allow-no-change`: permite delta vazio somente quando as demais evidências determinísticas satisfazem completion;
- `fail-on-no-change`: encerra imediatamente a tentativa como falha de verificação;
- `retry-on-no-change`: cria nova tentativa dentro do contador e budget próprios, sem consumir revisão de judge.

Aliases legados são aceitos na borda e registrados nas opções efetivas com origem e notice:

| Valor legado | Valor canônico S03 | Observação |
| --- | --- | --- |
| `retry` | `retry-on-no-change` | preserva retry limitado por `no_change.max_attempts` |
| `fail-fast` | `fail-on-no-change` | falha na primeira ausência de mudança |
| `fallback` | `retry-on-no-change` | aproximação limitada da S03; não troca provider/modelo silenciosamente |

`fallback` em S03 significa somente retry determinístico dentro do mesmo backend fake/testado. Fallback de perfil/provider é outra policy e pertence a S04/S05. O notice deixa essa mudança semântica visível. `--no-change-continue-on-max-retries` nunca significa aprovação automática: após exhaustion, no-change só pode ser aceito se a policy efetiva for `allow-no-change` e as demais provas passarem.

O report mantém counters separados para attempt, model call, no-change, operational retry, wiggum iteration e revision. Nenhum alias cria contador compartilhado.

### Categoria e skip policy de verification

Cada `VerificationSpec` compilada possui:

- `category`: `instruction`, `command`, `test`, `lint`, `typecheck`, `build`, `file`, `artifact`, `security` ou `plugin`;
- `skipPolicy`: `required`, `optional`, `allowed-to-skip` ou `never-run`;
- `blocking`, preservado como decisão separada sobre o efeito de uma falha executada.

Compatibilidade do contrato:

- folhas existentes sem metadata recebem categoria derivada apenas do tipo; `command` permanece `command`, nunca é inferido como test/lint pelo nome do executable;
- gates existentes recebem `skipPolicy: required` e conservam o blocking atual; `instruction` é a exceção contextual, sempre `never-run` e não bloqueante;
- a gramática estruturada futura pode declarar categoria/policy, mas o parser nunca as deduz de prose ou de uma command string;
- `optional` exige `blocking: false`;
- `never-run` exige `blocking: false` e produz estado explícito de skip;
- `required` não pode ser pulado por config global, `--fast`, `--skip-tests`, `--skip-lint` ou `--skip-gates`;
- `allowed-to-skip` roda por default, mas uma flag aplicável pode produzir `skipped_by_cli` sem ser mascarada como pass;
- `--fast` expande somente para verificações `allowed-to-skip` e registra a lista efetiva;
- override de verification required exige `--force` junto da flag de skip, gera audit event e, se todo o restante passar, no máximo `completed_with_override`.

Uma `instruction` humana orienta o executor, mas não é gate: a pipeline normal não a inclui no plano/registry, em resultados ou contadores, e ela não satisfaz critério. A primitiva unitária possui fallback defensivo `skipped_by_policy` não bloqueante para chamadas diretas indevidas, nunca `unavailable`. Um gate bloqueante executado e falho continua vencendo qualquer outcome do executor.

### Fake executor somente em composição de teste

1. `ExecutionBackend` é uma port do orchestrator e recebe task/context já selecionados pelo Ralph.
2. O fake programável vive em test kit/fixture e é injetado por uma composition root de teste.
3. O E2E pode empacotar um entrypoint de teste que usa os mesmos commands, orchestrator, persistence e verification do produto.
4. O entrypoint normal e os artifacts de release não registram perfil/backend `fake`.
5. Selecionar `--executor-profile fake` no produto normal retorna backend/profile indisponível; não habilita comportamento por environment oculta.
6. O fake pode aplicar ações relativas validadas na fixture e emitir eventos/outcome, mas não escolhe task, não altera ledger e não atualiza marker.

### Children antes de S09

1. S03 sempre compila root e todos os children recursivamente antes de considerar um backend.
2. Missing child, cycle, parent mismatch, path escape ou schema inválido continuam falhando antes de model call.
3. `dry-run` e inspeção podem mostrar o graph completo.
4. Se o graph validado possuir qualquer child edge, `once`, `loop` e `wiggum` falham com capability diagnostic antes do backend, independentemente dos markers atuais.
5. S03 não achata child tasks no run do pai, não cria child process e não conclui a task externa.
6. `--force` não contorna essa fronteira.

S09 implementará child run ID, parent link, lease, heartbeat, retomada profunda e completion do pai. O contrato de S03 deve conservar IDs/hashes suficientes para essa extensão.

### Completion coordenada entre ledger e Markdown

Completion usa o protocolo lógico explícito `prepared -> marker -> committed`, materializado em três estados:

```text
prepared -> marker-written -> committed
```

1. Após evidence/gates, o Ralph calcula e persiste `CompletionDecision` com hashes e refs.
2. Na primeira transação SQLite, confirma guards, grava `completion_prepared` e adiciona o evento correspondente à outbox.
3. Fora da transação SQLite, chama o marker updater com expected content hash, expected `[~]` e target `[x]`.
4. O updater troca somente o byte autorizado, escreve atomicamente, relê e recompila.
5. Na segunda transação SQLite, confirma o novo hash, grava `marker-written`/`committed`, muda a task para completed e publica `task.completed` e `progress.updated` pela mesma outbox.
6. O scheduler nunca seleciona a próxima task enquanto existir completion preparada não reconciliada.

Reconciliation básica:

- prepared + marker `[~]` com hash esperado: pode repetir somente o marker CAS;
- prepared + marker `[x]` com hash final esperado: confirma o commit lógico sem chamar executor novamente;
- marker ou definição divergente: registra conflito, mantém a task não concluída no ledger e exige inspeção;
- task completed sem evento não ocorre, pois entity update e outbox compartilham a transação;
- falha de report/JSONL após commit não desfaz completion; a projeção é reconstruída do ledger.

`ExecutorOutcome` nunca é input suficiente para preparar completion. O guard exige evidence bundle, todos os gates blocking aplicáveis aprovados ou override auditado e evidence mode satisfeito.

### Baseline e atribuição de mudanças

O marker `[~]` é atualizado antes do baseline inicial da task para não satisfazer `change-only`. S03 conserva:

- baseline da task, criado uma vez depois da ativação;
- baseline por attempt;
- `taskDelta`, usado na evidence cumulativa de completion;
- `attemptDelta`, usado pelo contador de no-change.

Mudanças preexistentes do usuário fazem parte do baseline e não são atribuídas ao executor. `.ralph/` e markers autorizados são efeitos do control plane e não contam como entrega. Ralph nunca executa reset, checkout, clean, stash ou rollback implícito para produzir uma decisão.

### Limite entre S03 e S07

S03 entrega:

- SQLite records mínimos de run/task/attempt/evidence/gate/completion;
- outbox transacional;
- exclusão mútua simples para impedir duas tentativas simultâneas no mesmo workspace;
- retomada de interrupção controlada/reexecução simples da mesma task;
- preservação de diff e arquivos não rastreados;
- reconciliation do protocolo de completion;
- limites finitos de once, loop, wiggum, calls, attempts e no-change.

S03 não declara completos:

- leases renováveis e roubo seguro de lease;
- PID start token/reuse e múltiplos probes de processo;
- watchdog multi-sinal;
- job object/process group e kill tree completo;
- reconciliação de tool/external effects unsettled;
- attach/background supervisor;
- kill matrix em todas as fases;
- child reattachment ou workers paralelos.

Esses itens pertencem a S07 ou S09. Um lock órfão não é roubado por heurística destrutiva em S03; a ferramenta relata conflito e preserva o trabalho. Testes de S03 podem injetar interrupções controladas, mas não autorizam alegar recuperação geral de hard crash.

## Consequências

### Positivas

- Marker updates do próprio Ralph não rompem a identidade retomável do plano.
- Contexto humano do PRD deixa de desaparecer entre compiler e executor.
- No-change e skip deixam de depender de aliases ambíguos.
- Test/lint podem ser selecionados por categoria sem inspecionar command text.
- Fake prova a máquina sem virar provider de produção.
- Child graph inválido ou ainda não suportado nunca chega ao executor.
- Completion aponta para evidence e permanece reconciliável entre filesystem e SQLite.
- S03 entrega valor vertical sem antecipar alegações de watchdog/lease de S07.

### Custos e riscos

- `sharedContext`, novos hashes e metadata de verification exigem evolução coordenada de schemas, fixtures, formatter e skill contract.
- Dois hashes de graph e um hash de task aumentam a quantidade de dados exibida, mas evitam usar uma identidade para finalidades incompatíveis.
- O alias `fallback` não preserva troca de backend na S03; o notice de compatibilidade é obrigatório.
- Skipping de required verification torna-se deliberadamente mais explícito e pode produzir `completed_with_override` em vez de completion normal.
- Completion exige duas transações e reconciliation porque SQLite e rename de Markdown não formam uma transação física única.
- PRDs clássicos precisam de migração antes da execução, embora continuem inspecionáveis.
- Runs com children ficam indisponíveis até S09, mesmo que o graph compile corretamente.

## Alternativas rejeitadas

- **Usar `/goal` como runtime:** inverteria a arquitetura e tornaria o Ralph dependente do mecanismo usado para implementá-lo.
- **Identificar run apenas por `graphHash`:** o próprio marker update faria o plano parecer outro.
- **Remover status do único hash existente:** perderia uma revisão exata útil para CAS, report e diagnóstico.
- **Reler prose bruta sem compilá-la:** recriaria um segundo caminho de parsing no context builder.
- **Mapear `fallback` para aprovação sem mudança:** poderia concluir trabalho sem evidence.
- **Inferir test/lint pelo executable:** seria heurístico e dependente de stack.
- **Tratar skip como pass:** falsificaria evidence.
- **Registrar fake no binário normal:** criaria uma superfície de execução não destinada ao usuário.
- **Executar child no mesmo run da task pai:** quebraria os contratos de parent/child supervisionado e retomada.
- **Marcar `[x]` e depois apenas tentar persistir:** permitiria marker concluído sem decisão durável.
- **Persistir completed antes do marker:** permitiria ledger concluído enquanto o documento humano permanece ativo.
- **Implementar watchdog/lease parcialmente e declará-los prontos:** ampliaria a superfície sem os testes de falso positivo e kill recovery de S07.

## Evidência esperada

- schema/golden comprova `sharedContext` preservado e sanitizado;
- trocar somente markers altera `graphHash`, mas conserva `definitionHash` e `taskSpecHash`;
- editar resultado, critério, verification, limite, dependency ou shared context altera os hashes semânticos correspondentes;
- aliases de no-change mostram valor original, valor efetivo e notice no report;
- skips produzem estados distintos e required gate não é pulado sem `--force`;
- o entrypoint normal rejeita fake e o entrypoint empacotado de teste executa a fixture;
- PRD clássico e qualquer graph com child edge falham antes de qualquer evento de backend/model call;
- `TASK_COMPLETE` sem evidence não produz completion;
- gate blocking falho mantém `[~]`;
- fault injection em cada fronteira do protocolo prepared/marker/committed retoma ou conflita deterministicamente sem selecionar a próxima task;
- interrupção controlada preserva diff e seleciona a mesma task na reexecução;
- documentação e reports não reivindicam leases/watchdog/hard-crash recovery antes de S07.
