# 10 — Persistência, retomada, watchdog e processos filhos

## Objetivo

Fechar a TUI, encerrar o terminal, sofrer crash, perder conexão com provider ou reiniciar a máquina não pode fazer o Ralph pular uma task nem esquecer o que estava fazendo. O runtime deve retomar da task mais antiga ainda não finalizada, priorizando a cadeia ativa de sub-PRDs, e conservar evidência de alterações parciais.

## Isolamento de workspace e run

Cada projeto possui `.ralph/` no seu workspace canônico:

```text
.ralph/
  workspace.json
  config.yaml
  state/
    ledger.sqlite
    migrations/
  runs/<run-id>/
    run.json
    events.jsonl
    raw/
    evidence/
    reports/
    context/
    artifacts/
  locks/
  cache/
  checkpoints/
```

Se SQLite não for escolhido, o store alternativo deve oferecer as mesmas transações, constraints, WAL/journal e migrations; JSON solto não é suficiente para coordenação concorrente. Arquivos grandes ficam content-addressed, com refs no ledger.

`workspaceId` deriva de UUID persistido, não apenas do path. O path canônico e repo identity são registrados para detectar cópia/movimento. Runs de projetos distintos nunca compartilham locks ou estado. Um registry global opcional guarda somente localizações/nomes e credential refs, não task state.

## Entidades duráveis

- Workspace e config revision;
- PRD document/revision/hash e compiled graph hash;
- Run, root PRD e effective options snapshot;
- Task instance e marker reconciliation;
- Attempt, model call, revision e counters;
- Tool call/settlement e external side-effect classification;
- Gate result e evidence bundle;
- Judge assessment;
- Operação standalone `verify|judge`, request hash-bound, report ou erro terminal;
- Child run link;
- Lease/worker/process identity;
- Event cursor;
- Git baseline/checkpoint/worktree;
- token/cost aggregates;
- stop/cancel/crash reason.

Toda linha tem schema version, timestamps UTC e causal IDs. Migrations são forward-only com backup/checkpoint.

## Transações críticas

Completion exige uma unidade coordenada:

1. confirmar evidence/gates/assessment pass;
2. gravar decisão `completion_prepared` com hashes;
3. atualizar marker Markdown atomicamente;
4. confirmar reparse/hash;
5. gravar task completed e evento no mesmo commit lógico;
6. atualizar agregados e liberar claim.

Se crash ocorrer entre passos, reconciliation lê `completion_prepared`, marker e hashes para terminar ou reverter de modo determinístico. Nunca seleciona a próxima task antes disso.

Event append e entity update usam outbox transacional para evitar estado sem evento ou evento mentiroso.
A migration forward-only `event-retention-snapshots` (v14) acrescenta a cada row
`event_retention_known/event_retention_ms` e mantém contextos efetivos de workspace
duráveis e isolados por processo de comando. `known=0` representa legado/desconhecido e nunca autoriza
remoção; `known=1` com duração nula representa `null` explícito, também sem
expiração. Flush/projeção/retenção usam lease cross-process único e não um Map do
processo que por acaso executou o comando.

## Persistência de `verify` e `judge`

A migration forward-only `command-evidence-operations` cria `command_operations`. Cada row guarda
`operationId`, command, status `started|succeeded|failed|cancelled`, run/document/task/attempt,
evidence fonte, request/hash, report ou erro e timestamps. A criação, terminalização e respectivo
evento são transações do mesmo ledger do run; IDs reaproveitados com request diferente são conflito.
Checks e triggers no ledger vinculam request/report às colunas de scope, permitem somente a
transição única de `started` para estado terminal, preservam identidade e recusam delete. A camada de
persistência também revalida evidence de execução no store ou evidence de verificação na operação
`verify` terminal antes de criar ou terminalizar um registro.

O request registra o selector já resolvido e a fronteira fixa: executor, model tool calling, task
state e PRD marker são proibidos. O report de `verify` contém a evidence recém-coletada e receipt do
objeto content-addressed. O report de `judge` contém assessment integral, receipt/ref, profile,
policy, decisão e prova de estabilidade do workspace. Reports possuem hash canônico próprio e
schema discriminado; estabilidade do control state compara task/attempt antes/depois e é reportada
separadamente do diff de arquivos. Operação bem-sucedida significa que o comando terminou, não que o parecer foi
`passed`.

Essas operações são deliberadamente append-only em relação à execução fonte. Elas não substituem
`attempts.evidence_bundle_id`, não escrevem gate results na attempt, não atualizam completion e não
tocam o marker. `judge --verification-id` resolve diretamente uma operação `verify` terminal e
verifica novamente todo binding; uma operação incompleta/falha não é fonte válida. Se o processo
cair depois de `started`, o registro continua auditável como não terminal e uma nova invocação usa
outro ID; não há retomada que repita silenciosamente gates ou uma chamada paga.

## Algoritmo de retomada

Ao executar `ralph run` sem `--new-run`:

1. Resolver workspace e adquirir lease de supervisor.
2. Procurar run não terminal compatível com o root PRD/config identity.
3. Reproduzir/reconciliar journal, marker files, worktree e process records.
4. Se há cadeia child ativa, descer até o child mais profundo não terminal.
5. Se há task `active`, `interrupted`, `verifying`, `evaluating` ou transação preparada, retomar essa task antes de qualquer outra.
6. Reconciliar tentativa e tool calls unsettled.
7. Se a tentativa pode continuar com segurança, criar continuation/revision vinculada; se não, preservar diff e começar nova tentativa na mesma task.
8. Se não existe ativa, escolher a primeira task elegível não concluída pela ordem do graph.
9. Se nenhuma task foi concluída, isso naturalmente seleciona a primeira.
10. Somente `--new-run` cria outro run; ainda deve detectar workspace sujo/claims e exigir policy clara.

O usuário pode usar `ralph resume <run-id>`, `ralph run --resume auto|never|required` e `ralph status --all`. `auto` é default. `never` não apaga o anterior; apenas exige que seja terminal ou que `--new-run` trate conflito.

Quando um hash mismatch externo gera `workspace_changed`, `ralph status run --run-id <id>` expõe
somente para leitura o manifesto content-addressed, a task e os hashes esperado/observado.
`ralph resume <id> --accept-workspace-changes` persiste um evento de aceitação de uso único antes da
próxima chamada de modelo. O evento fica ligado à decisão bloqueada e ao manifesto recém-capturado;
uma mudança adicional de workspace invalida a autorização. `resume` sem essa flag permanece fail
closed. A aceitação autoriza apenas `continue`: checkpoint e rollback exigem ações separadas e
explícitas, e rollback nunca é inferido nem executado automaticamente.

`ralph stop <run-id> --graceful` persiste o pedido e o supervisor o reconhece em uma fronteira durável. `cancel` permanece alias de compatibilidade. `--force` só pode escalar quando identidade de processo, capability e canal supervisor/worker foram verificados; a CLI falha fechada em vez de sinalizar um PID arbitrário.

Quando o run já foi persistido e está `running`, o owner publica
`.ralph/runs/<run-id>/control.json` com permissão restrita. O descritor contém somente o endpoint
TCP loopback, workspace/run/instance, PID, process-start token e uma capability aleatória com seu
hash. O cliente estabiliza o arquivo contra troca/link, prova PID + start token, autentica a
mensagem e confere o binding integral da resposta. Stop e context rotation são serializados pelo
owner; nenhum cliente grava transição oficial diretamente.

No stop gracioso, o callback do runner muda o run para `stopping`, impede novo agendamento e
propaga cancelamento cooperativo. No force stop, o supervisor aguarda o grace configurado e mata
somente árvores registradas no registry de shutdown; nunca sinaliza um número de PID isolado. Se o
descritor está ausente ou prova owner morto/PID reutilizado, a CLI só cancela pela fronteira durável
depois de adquirir a mesma lease de writer. Owner vivo porém inalcançável continua sendo conflito,
não autorização para tomar o run.

Antes de responder `cancelled` — inclusive quando o run já parecia terminal — o supervisor enumera
no journal autoritativo todos os intents `process.exec` unsettled do run e de seus descendants. Cada
intent resolve exatamente seu lifecycle por run/scope/arguments hash/idempotency key, sem scan de
diretório nem adivinhação de worktree. A CLI persiste `stop-intent.json` ligado ao command
fingerprint e ao hash da capability; `force` é monotônico e nunca pode ser rebaixado para
`graceful`. O canal loopback é apenas aceleração: o owner lê a intenção antes do spawn, relê na
fronteira imediata e observa o arquivo durante a execução. O fallback só conclui cancelamento após
`settled` autoritativo ou prova de owner e child mortos. Owner vivo, remoto/inacessível, identidade
divergente ou estado de start ambíguo mantém o run em `stopping`/estado anterior e retorna conflito.

`context rotate` usa esse mesmo canal e apenas enfileira uma intenção para `next-model-call` ou
`next-task`. O runner aplica a rotação na fronteira escolhida, persiste requested/applied ou
not-applied e reconstrói o manifest; não existe arquivo lateral que finja trocar contexto.

## Alterações parciais

Antes da primeira chamada, registra-se Git baseline e snapshot dos paths relevantes. Após interrupção:

- diff existente é incluído no próximo context manifest;
- arquivos não rastreados são preservados e enumerados;
- a nova tentativa sabe o que já foi feito e o que ainda falta;
- não se executa reset/rollback automaticamente;
- usuário pode escolher continuar, criar checkpoint, inspecionar ou rollback explícito;
- hash mismatch externo produz `workspace_changed` e exige reconciliation, não descarte.

Nesta slice, `continue` está exposto pela flag hash-bound acima e `inspect` por `status run`/JSON. A
interface de checkpoint e o comando destrutivo de rollback ficam deliberadamente separados; até
que existam, Ralph não os simula e não usa alterações de arquivo como consentimento implícito.

## Tool calls sem settlement

Cada tool call registra intenção antes de efeito. Após crash:

- tools read-only podem ser reexecutadas;
- write/edit idempotente verifica pre/post hashes;
- command local consulta exit/artifact/process se possível;
- efeito externo não idempotente entra em `needs_reconciliation` e não é repetido automaticamente;
- processo ainda vivo pode ser reanexado/monitorado se identidade for comprovada;
- processo morto sem settlement autoritativo permanece `needs_reconciliation`/unsettled, com a
  evidência disponível; morte de PID não prova se o efeito externo já aconteceu e não libera nova
  chamada do modelo.

O reconciliador é uma porta comandada pelo orchestrator e roda antes de qualquer nova chamada de
modelo para a mesma task. Intents read-only só são repetidas depois de reconstruir exatamente os
argumentos e reaplicar a policy efetiva atual. `fs.write`, `fs.edit` e `fs.apply_patch` persistem,
antes do efeito, um binding imutável dos hashes de pré e pós-estado: todos os targets no pré-estado
permitem replay; todos no pós-estado permitem settlement por efeito confirmado; estado parcial,
divergente, não verificável ou argumentos alterados por redaction pausam a task. Intents de rede,
efeito externo, destrutivas e tools desconhecidas também permanecem unsettled.

`process.exec` usa `.ralph/runs/<run-id>/processes/<sha256(intent-id)>/lifecycle.json`. A criação
exclusiva de `launching` concede uma capability de bootstrap de uso único a um owner interno
detached; o token não é persistido, somente seu hash. O owner valida workspace e exact-command,
adquire lease própria, publica `control.json` loopback protegido e avança
`launching -> starting -> running -> settled`. Lifecycle e lease carregam o binding integral de
workspace/run/document/task/attempt/intent, arguments hash, idempotency key, PID, process-start token
e hostname. O settlement persiste apenas a projeção redigida/bounded e refs de raw output, nunca
environment, stdin ou secrets. Durante a execução, o owner registra secrets apenas em memória e
anexa `tool.output.delta` já redigido/bounded ao event ledger no escopo exato de
run/document/task/attempt/intent; `tool.output.completed` publica status e refs para a TUI sem dar ao
worker autoridade de persistência ou transição de task.

O runtime e eventual source entrypoint do owner têm `realpath` e hash capturados ao carregar a
composição, antes do trabalho do modelo, e são revalidados imediatamente antes do handoff privado.
Se mudarem, ou se estiverem dentro do `workspaceRoot` gravável pelo modelo, o spawn falha fechado
antes de enviar bootstrap, environment, stdin ou secrets; execução from-source sobre o próprio
checkout deve usar um Ralph instalado/bundled fora desse workspace para habilitar esse owner.
O mesmo limite se aplica ao executável alvo da tool: ele deve ser um realpath externo ao workspace
gravável, enquanto scripts e arquivos do projeto permanecem argumentos do comando autorizado.
A `cwd` canônica autorizada é revalidada pelo owner e novamente pelo supervisor na última fronteira
pré-spawn; troca por symlink/junction ou escape do workspace falha fechado.

Na retomada, o probe estabiliza o arquivo, confere o binding integral, a lease e PID + start token +
host. Owner vivo é reattached por espera; `settled` reutiliza o resultado exato; PID reutilizado,
owner órfão com child ainda vivo, lifecycle ausente/malformado ou lease incompatível pausam sem
replay. Cancelamento cooperativo persiste primeiro a intenção autoritativa e usa o canal autenticado
por bearer somente para reduzir latência, continuando a aguardar `settled` e evitando uma alegação
terminal enquanto o efeito ainda finaliza. A presença desse código é prova estática, não substitui
os crash/process-tree tests diferidos.

Esse bearer protege binding, identidade e descriptor stale; não isola código hostil que já execute
sob o mesmo usuário do SO. O backend local é cooperativo. Código não confiável exige container/OS
sandbox com `.ralph` e `controlRoot` fora dos mounts.

## Leases e múltiplos Ralphs

Um lease contém:

- workspace ID, run ID e owner instance ID;
- PID, process start token e hostname;
- acquired/renewed/expires timestamps;
- command e capability scope;
- parent run/worker, quando aplicável.

O start token evita confundir PID reciclado. Lock file sozinho não prova processo vivo. A aquisição usa operação atômica + ledger transaction. Lease expirado só é roubado após confirmações de owner morto ou PID reutilizado depois do grace period; host remoto/inacessível permanece conflito fail-closed.

É permitido:

- vários Ralphs em projetos diferentes;
- vários clients/TUIs read-only anexados ao mesmo run;
- vários workers autorizados de um run paralelo;
- parent/children previstos.

Não é permitido dois supervisors escritores independentes no mesmo run/workspace sem coordination mode explícito.

## Supervisor e workers

O processo supervisor possui o lease autoritativo e agenda trabalho. Workers isolam:

- executor model calls;
- judge calls;
- commands/tools/gates;
- integrações Git.

Cada worker recebe worker ID, capability token, prazo, IPC channel e path scope. O supervisor persiste eventos; worker não grava diretamente completion. Parent monitora child supervisor e recebe eventos agregados, mas cada child preserva ledger/run ID.

Cada child run ativo possui uma instância Ralph real no worker tipado `child-run`. O supervisor do
comando reserva o escopo antes do spawn, adquire e renova a lease durável em nome do PID,
process-start token, hostname e worker ID reais e conserva o orçamento da invocação. O coordinator
filho recompila e confere por hash o grafo pré-autorizado, executa o documento em seu próprio processo
e pode compor workers de executor, judge, tool, gate e children aninhados. Budget, heartbeat,
observações e projeções de eventos atravessam reverse IPC tipada; nenhum payload autoriza criar PRD
ou lançar comando arbitrário. `pause-with-parent` garante que fechamento/cancelamento interrompa o
Job Object/process group em ponto retomável. O processo isolado não é rotulado como
`survive-parent`: essa policy continua exigindo owner independente.

O path scope é canônico, não lexical: workspace, ancestrais existentes, symlinks e junctions passam
por `realpath`, recursos referenciados por arquivo são estabilizados e materializados por hash antes
de chegar ao adapter, e o adapter revalida o path canônico imediatamente antes do acesso. Command
scope é o fingerprint exato de intenção + executável absoluto e hash dos bytes + argv + cwd + nomes
de ambiente; nome em `PATH` ou autorização genérica de shell não constitui capability. O launch do
worker declara executável standalone ou entrypoint de runtime empacotado, ambos hash-bound. O supervisor
também recalcula os hashes do EvidenceBundle/context bundle e rejeita retorno de gate que altere
blocking/category/`skipPolicy`/criteria ou alegue outra invocação.

Mensagens IPC obedecem à máquina de estados: progress e terminal precisam referir o request ativo,
heartbeat precisa concordar com o estado busy/ready, e o watchdog usa receipt time + relógio
monotônico do supervisor em vez do relógio alegado pelo worker. Cancel/deadline/shutdown/disconnect preservam a causa no protocolo e escalam dentro de grace
configurado para encerramento da árvore; timers fora da faixa representável são rejeitados.

## Watchdog multi-sinal

Demora não é sinônimo de travamento. O watchdog observa sinais independentes:

1. `controlHeartbeat`: loop/IPC do worker responde;
2. `progressSignal`: novo token/evento/tool output/phase change;
3. `processProbe`: PID/start token/CPU/IO/socket quando disponível;
4. `providerSignal`: stream aberto, retry-after ou request pendente conhecido;
5. `deadline`: timeout da fase e hard timeout;
6. `childHeartbeat`: saúde do child supervisor;
7. `settlement`: chamada/command ainda oficialmente em execução.

Estados:

```text
healthy -> quiet -> slow -> suspect -> stalled
                         └-> recovered -> healthy
```

- `quiet`: sem output, mas heartbeat e processo saudáveis;
- `slow`: ultrapassou expectativa da fase, ainda com vida comprovada;
- `suspect`: perdeu múltiplos sinais além do grace period;
- `stalled`: quorum de sinais negativos ou hard timeout;
- `recovered`: sinal retornou antes da ação destrutiva.

Não se mata um call só porque não chegou token por N segundos. Requests de reasoning, rate limit, build longo e provider silencioso podem continuar saudáveis.

Na fase `child`, o heartbeat periódico emitido pelo worker e o ping semântico solicitado pelo
supervisor são evidências distintas. Um `pong` não renova o marcador do heartbeat periódico; se o
control plane IPC compartilhado derrubar ambos, as duas ausências ocupam uma única família no quorum
e uma ação destrutiva ainda exige outra família negativa. Progresso é diagnóstico de
trabalho, não prova de ownership: sua ausência isolada nunca revoga a lease enquanto PID + start
token e ao menos um sinal IPC de liveness permanecem recentes.

## Timers configuráveis

```yaml
watchdog:
  enabled: true
  heartbeat_interval: 5s
  heartbeat_grace: 20s
  quiet_after: 45s
  slow_after: 5m
  suspect_after: 10m
  hard_timeout: 45m
  probe_interval: 10s
  confirmations: 3
  action: restart-attempt
  max_restarts: 1
```

Há overrides por phase: model call, tool, gate, judge, child e integration. `hard_timeout: null`
desabilita somente o hard timeout; as demais confirmações multi-sinal continuam ativas.
`enabled: false`, globalmente ou na fase, desarma estados suspeitos, ações e todo deadline pertencente
ao watchdog, inclusive `hard_timeout`. A lease continua exigindo identidade exata e liveness recente
porque essa é uma fronteira independente de ownership, mas não usa silêncio de progresso para expulsar
um owner saudável. Durações precisam ser positivas. Defaults são conservadores e visíveis na TUI.

Ultrapassar `hard_timeout` produz um sinal absoluto negativo: heartbeat, processo ou provider ainda
saudáveis não anulam o limite. Mesmo assim, o watchdog precisa observar esse deadline excedido em
`confirmations` probes monotônicos distintos antes da ação destrutiva; a primeira amostra entra em
`suspect` e apenas a confirmação seguinte pode entrar em `stalled`. `confirmations: 1` preserva a
ação imediata. Confirmações anteriores a cruzar o hard deadline não são reutilizadas como se já
fossem observações do timeout excedido.

Os aliases v1 `lease_timeout`, `probe_attempts` e `hard_attempt_timeout` ainda são
normalizados, respectivamente, para `heartbeat_grace`, `confirmations` e
`hard_timeout` na fronteira de leitura. Declarar um alias antigo junto do campo
canônico correspondente é erro, evitando precedência ambígua. O schema interno,
o snapshot efetivo e novas gravações usam somente os nomes canônicos.

## Ações de recuperação

Em `suspect`, o Ralph:

1. emite warning e snapshot diagnóstico;
2. envia ping/cancel gracioso conforme protocolo;
3. repete probes pelo número configurado;
4. somente em `stalled` aplica ação: `notify`, `cancel`, `restart-attempt`, `stop-run`;
5. persiste todos os sinais e motivo;
6. mata process tree somente quando necessário;
7. mantém task não concluída e diff intacto;
8. reinicia dentro de budget e com context de recuperação.

Uma restart do watchdog é categoria própria, não consome revision de judge; pode consumir operational retry. Ao esgotar, run fica `interrupted/stalled`, retomável.

Para `child`, `restart-attempt` encerra e confirma a sessão atual, cria um novo worker `child-run` e
retoma o mesmo run/task durável. O budget de restart é reconstruído dos eventos
`child.worker.restart_started` emitidos somente depois da confirmação de encerramento, e
a única leaf task já debitada pode reutilizar exatamente uma autorização de execução; isso evita que
`once` ou `maxTasks` transformem a recuperação da mesma tentativa em uma nova task artificial. Cada
recriação confirmada também entra uma única vez no contador operacional `watchdogRestarts` do
relatório do run pai.

## Parent e child

- Parent persiste child run ID antes de spawn.
- Parent adquire uma lease separada vinculada à identidade real do worker `child-run`; o child a
  revalida antes de coordenar ou escrever.
- Parent não conclui task enquanto child não tiver terminal pass e seus artifacts não forem reconciliados.
- Child heartbeat aparece no parent.
- Stop gracioso propaga de baixo para cima/alto para baixo de maneira ordenada.
- A policy executável `pause-with-parent` encerra o processo filho com a árvore do parent e preserva
  o ponto durável para resume; `survive-parent` só poderá evitar isso com owner independente.
- Resume do parent encontra child pelo ledger, não cria duplicata.
- Profundidade, quantidade e concurrency de children são limitadas.

Na composição atual, `survive-parent` é deliberadamente fail-closed: um child
lançado dentro do Job Object/process group do worker seria morto junto com essa árvore e não pode
ser anunciado como sobrevivente. A opção somente será executável quando existir um supervisor,
lease, canal de reattachment e ownership de processo independentes; até lá, a fronteira tipada
retorna capability diagnostic antes do spawn. `pause-with-parent` continua sendo a única policy
executável.

### Contrato durável implementado em S09

O runtime child parte exclusivamente do grafo já compilado. Ele não recebe ferramenta, callback ou
capability para criar PRD: a skill gera root PRD e sub-PRDs legíveis antes da execução; parser e
compiler resolvem as referências; somente então o scheduler pode materializar um child.

Cada materialização grava atomicamente o run filho, suas tasks diretas e um vínculo imutável com
workspace, parent run/task, documento filho, hashes, opções herdadas, profundidade e quantidade
esperada de filhos diretos. A identidade determinística torna retry/resume idempotente. O ledger de
cada workspace e as leases com `workspaceId`, `runId` e `parentRunId` mantêm projetos e instâncias
Ralph distintos isolados.

O vínculo guarda status, revisão CAS, heartbeat, progresso, uso de executor/judge, watchdog, cursores
de evento/log, reconciliação de artifacts e receipt terminal com content hash. Eventos do child só
podem ser projetados depois de existirem no ledger e a projeção `(link, source event)` é idempotente.
Resume percorre a árvore durável e escolhe primeiro o child não terminal mais profundo.

O loop serial conecta essa fronteira por um `ChildRunExecutionPort` implementado sobre a sessão do
worker `child-run`. O processo externo recebe somente IDs, hashes, paths canônicos, opções efetivas,
snapshot de budget e a lease já vinculada; recompila o root e recusa qualquer divergência antes de
coordenar o documento. O supervisor externo atende apenas reserva/relato do budget, heartbeat,
observação e projeção de evento. Quando encontra um run já terminal após crash, o worker executa
apenas reconciliação idempotente de artifacts/evidências antes de gravar o receipt — nunca chama
novamente o modelo nessa rota. Eventos necessários para projeção e recovery são lidos em páginas
indexadas pelo `runId` do child, sob um high-water mark fixo; eventos de outros runs não são
desserializados.

`once` e `maxTasks` são orçamento da invocação do comando, não de cada nível. Root e todos os children
compartilham o mesmo contador, e somente a execução real de uma task externa/leaf consome uma unidade.
Reservar, retomar ou atravessar um parent com sub-PRD não consome orçamento. Se a última unidade for
usada dentro de um child, os ancestors ficam `interrupted` e retomáveis antes de executar seus contratos
externos. Assim `once` continua sendo um ciclo pequeno, mesmo em árvores profundas.

O progresso agregado usa leaf tasks: quando uma task parent é refinada por sub-PRD, ela deixa de
entrar no denominador junto com as tasks do child. Status e TUI juntam os escopos root/child, preservam
profundidade e parent run e exibem logs, output, watchdog e uso. Completion do parent exige child
`passed`, artifacts reconciliados e receipt íntegro; em seguida ainda executa a verificação própria do
parent. O dry-run percorre a mesma árvore pré-autorizada, sem materializá-la, para resolver opções e
disponibilidade do backend da task externa mais profunda que seria executada; `childEdges` são
reportadas como execução command-owned suportada.

Observações não escrevem um `running` sintético depois que o run child já ficou terminal. O status
terminal do vínculo (`passed`, `failed` ou `cancelled`) pertence exclusivamente ao settlement com
receipt content-hashed, evitando mascarar falha ou conclusão entre a observação final e a confirmação
do supervisor.

A composição de scheduler, persistência, supervisor, worker coordinator e observabilidade está
implementada. `EV-WDG-8` validou 8/8 casos; `EV-S11-E2E-100` e `EV-S11-KILL-17` exercitaram
child/nested, kill/resume e reconciliação; `EV-S12-SAMPLE-59` acrescentou 1/1 teste e 59 asserções
com child e crash/resume sem replay. O gate local 673/673 e a integração 149/149 também passaram.
Essas provas fecham o escopo funcional local descrito, mas não cobrem o sample em PTY, provider real,
candidate binding ou plataformas externas; nenhum desses limites é inferido como aprovado.

## Critérios de aceite

- Kill tests em cada fase retomam a mesma task sem pular trabalho.
- Diff e arquivos não rastreados sobrevivem a crash.
- PID reciclado e lock órfão não causam tomada incorreta.
- Dois projetos executam simultaneamente sem colisão.
- Parent reiniciado reencontra o mesmo child.
- Watchdog não mata fixtures lentas que mantêm sinais de vida.
- Watchdog detecta worker realmente congelado e recupera conforme policy.
- Completion nunca fica metade no ledger e metade no Markdown sem reconciliation.
