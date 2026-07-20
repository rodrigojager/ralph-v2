---
task: Entregar persistência transacional retomada supervisor workers e watchdog multi-sinal
engine: codex
---

# Subplano S07 — Persistência, resume e watchdog

## Resultado do subplano

Um run pode ser morto em qualquer fase relevante e volta à mesma task com diff/contexto preservados. Leases impedem dois escritores. Supervisor e workers possuem identidade/heartbeats. O watchdog tolera operação lenta com sinais de vida e recupera congelamento real dentro de limites.

## Referências obrigatórias

- `docs/08-orquestracao-executor-tools-e-contexto.md`
- `docs/10-persistencia-retomada-watchdog-e-filhos.md`
- `docs/11-eventos-telemetria-logs-e-relatorios.md`
- `docs/15-testes-qualidade-e-criterios-de-pronto.md`

## Tarefas

- [x] S07.01 finalizar ledger durável escolhido, schemas/migrations/constraints/WAL ou equivalente, content-addressed refs e transactional outbox; testar concurrent readers, crash no append, backup e migration failure sem corromper fixture.
- [x] S07.02 implementar `completion_prepared` e coordinator entre evidence decision, atomic Markdown marker, reparse/hash, task completion, event e claim release; injetar crash entre cada passo e reconciliar sem dupla conclusão.
- [x] S07.03 implementar workspace/run supervisor lease com atomic acquire/renew/release, PID + process start token + hostname + expiration/grace, stale owner probes e conflito informativo; provar PID reuse e múltiplos projetos.
- [x] S07.04 separar workers para model, judge, tool/gate e integration com IPC/capability scope, control heartbeat, process group/job object e supervisor como único escritor de transitions.
- [x] S07.05 implementar resume discovery `auto|never|required`, `--new-run`, reconciliation de markers/ledger/events/Git e algoritmo que escolhe active/interrupted/prepared antes da primeira pending; adicionar `resume`, `stop`, `status --all`.
- [x] S07.06 registrar baseline/diff/untracked/artifacts e context manifest de recuperação, detectar workspace editado externamente, não aplicar reset automático e apresentar ações continue/inspect/checkpoint/explicit rollback.
- [x] S07.07 implementar reconciliation de tool calls unsettled por risk/idempotency/pre/post hash/process probe, reexecutando somente read/idempotent seguros e pausando efeito externo ambíguo.
- [x] S07.08 implementar watchdog states healthy/quiet/slow/suspect/stalled/recovered com control/progress/process/provider/deadline signals, per-phase profiles, confirmations e events/status diagnósticos.
- [x] S07.09 implementar recovery actions notify/cancel/restart-attempt/stop-run, cancel gracioso antes de kill, max restarts e contador operacional separado de revisions; sempre preservar task/diff e tornar exhaustion retomável.
- [x] S07.10 implementar Ctrl+C em duas fases e closing contracts para headless/TUI futura, garantindo que nenhum subprocesso/worker seja abandonado e que primeiro sinal pare agendamento.
- [x] S07.11 executar kill matrix ao menos após task active, tool intent/write, gate, judge, completion prepared/marker/event; executar false-positive matrix com stream silencioso heartbeat, reasoning longo, build CPU/IO e frozen worker usando clock/probes controlados.

## Evidência executável atual

O gate consolidado passou com 673 testes e zero falhas; a suíte de integração passou com 149 e zero
falhas. S07.02 é provada por `execution-store` e pela matriz de fronteiras de completion em
`orchestration-runner`, incluindo `prepared`, marker, event e reconciliação sem nova chamada. S07.08
é provada pelos 4 testes de hardening do watchdog: quiet/slow saudável, stream/retry-after/deadlines,
quorum com confirmações e exhaustion retomável; eles cobrem todos os estados
`healthy|quiet|slow|suspect|stalled|recovered` e mantêm restart budget separado de revisions. A
matriz ampliada de S07.11 leva o arquivo de hardening a 7 casos, incluindo processos reais.

S07.01 e S07.03 são provadas pela suíte focada `s07-persistence-leases`: snapshots simultâneos de
dois readers sob WAL enquanto outro connection escreve; rollback integral após crash dentro do
append e falha injetada no insert da outbox; retenção e retry da outbox após falha da projeção; e
backup SQLite íntegro e legível após migration transacional falhar sem alterar a fixture original.
A mesma suíte cobre leases `workspace-supervisor` e `run-supervisor`, acquire/renew/assert/release,
identidade por instance/PID/process-start token/hostname, expiration mais grace, owner vivo,
displacement somente após duas probes de PID reutilizado e isolamento de dois ledgers de projetos.
Os 7 casos passaram duas vezes na mesma execução focada: 14 testes, 128 asserções e zero falhas.

As onze tarefas desta fase possuem agora prova focada própria. O gate consolidado histórico acima
não foi repetido para S07.11: as evidências novas e as regressões diretamente afetadas são
registradas na seção específica abaixo, sem transformar presença de código em alegação de teste.

### Estado de implementação de S07.04

O protocolo privado possui contratos versionados distintos para executor model, judge, tool, gate,
child run e integração Git. Supervisor e worker validam role/capability, identidade de
workspace/run/attempt, bindings de contexto/evidência/resultado, deadlines e escopos explícitos de
path/comando. O runtime aceita uma operação por vez, mantém control heartbeat, propaga
cancelamento, encerra em duas fases e nunca recebe portas de ledger/marker/transition. O mesmo
entrypoint distribuído entra no modo filho somente sob IPC e ambiente definidos pelo supervisor.

A fronteira estática agora falha fechada em detalhes que não podem ser tratados como simples
strings: paths e ancestrais existentes passam por `realpath` (incluindo symlink/junction), recursos
por path são lidos, estabilizados, verificados por hash/bytes e convertidos em conteúdo imutável
antes do adapter, EvidenceBundle e o bundle canônico de contexto têm seus hashes recalculados, e
um retorno de gate precisa preservar `gateId`, category, blocking, `skipPolicy`, criteria e a
invocação exata.
Commands são autorizados por fingerprint SHA-256 da intenção semântica, executável absoluto
canônico + hash real dos bytes, argv, cwd canônico e nomes mínimos de ambiente; autorizar apenas o
nome `git`, `cmd` ou `sh` não cria capability. O launch diferencia executável standalone de runtime
com entrypoint empacotado; executável, entrypoint e entry module do adapter são arquivos absolutos
estabilizados e vinculados por hash; adapters com grafo de
dependências mutável no workspace continuam não autorizados até o empacotamento/sandbox de S09.

Cancel, deadline, shutdown e perda do IPC têm causa explícita e escalada local bounded: primeiro AbortSignal e
cancelamento dos subprocessos registrados, depois kill da árvore e encerramento do worker ao fim
do grace period. Heartbeat/progress/result são aceitos somente no lifecycle e request ativos; a
idade operacional usa receipt time do supervisor, mantendo `sentAt` apenas como dado diagnóstico.
Timers são limitados à faixa representável e deadlines longos são rearmados em segmentos.

`parentPolicy: survive-parent` permanece no contrato de documento, mas a operação worker falha
fechada enquanto não existir supervisor, lease e Job Object/process group independentes para o
child. Colocá-lo na árvore de processo do worker e alegar sobrevivência seria incorreto,
especialmente no Windows com `KILL_ON_JOB_CLOSE`. Adapters concretos devem consumir os paths
canônicos retornados pela fronteira imediatamente antes de cada acesso; contenção contra código de
adapter deliberadamente malicioso continua pertencendo ao sandbox de S09, não ao token IPC.

Os adapters concretos built-in e os call sites principais estão agora ligados estaticamente pelo
composition root: executor e judge resolvem S05 dentro de workers próprios; ToolHost autoriza e
registra no parent antes de despachar o efeito; gates recebem registry worker por attempt; e Git
paralelo recebe um `ProcessSupervisor` worker. OpenAI e OpenRouter embedded compartilham esse
envelope, enquanto provider sem driver e fallback que introduza CLI externo não capability-bound
falham fechados.

O protocolo worker também possui chamadas worker -> supervisor limitadas por role para reserva de
model call, execução oficial de tool, emissão de evento e persistência de output de gate. O
supervisor rejeita resultado terminal enquanto alguma chamada parent ainda está ativa. O runner
fornece `workspaceId` e separa `workspaceRoot` executável de `controlRoot` durável em worktrees.

Child usa uma instância Ralph real no worker tipado `child-run`: o supervisor externo reserva o
escopo, vincula e renova a lease durável pela identidade real do processo e conserva autoridade sobre
budget, observações e projeções por reverse IPC. O coordinator filho recompila o grafo pré-autorizado,
coordena seu próprio escopo e compõe workers internos e filhos aninhados sob `pause-with-parent`.
`survive-parent` de child continua reservado para um coordinator/owner/lease/process tree
independente. Para `process.exec`, a ligação estática agora existe: o worker não faz spawn; solicita
ao command supervisor um owner interno detached, autenticado por capability de bootstrap e
vinculado a workspace/run/document/task/attempt/intent, arguments hash, idempotency key e fingerprint
do exact-command. O owner renova lease, publica controle loopback restrito, persiste lifecycle
`launching|starting|running|settled` e raw refs bounded/redigidos. Resume prova owner e lease por
PID + process-start token + hostname e espera a mesma execução; nunca relança o comando. Deltas já
redigidos são anexados pelo owner ao ledger com scope de run/task/attempt/intent para preservar os
painéis live da TUI mesmo depois que a posse sai do worker.
Runtime/entrypoint são
capturados por realpath+hash antes do trabalho do modelo e revalidados no spawn; owner from-source
dentro do workspace gravável falha fechado e exige distribuição instalada/bundled externa.
O executável alvo da tool também precisa ser um realpath instalado fora do workspace gravável;
scripts do projeto podem ser argumentos, mas não a primitive executável substituível. O bearer do
canal liga requests ao owner e evita descriptor stale/misdelivery; contenção contra código hostil
same-UID continua pertencendo ao sandbox forte de S09, não ao processo local cooperativo.

O run ativo publica um canal de controle loopback autenticado por bearer e ligado a workspace/run/instance,
PID e process-start token. Stop gracioso/force e context rotation passam por esse owner; quando o
owner é comprovadamente ausente, a fallback só escreve após adquirir a mesma lease. Force kill
atinge apenas árvores registradas. Reiniciar o comando continua descobrindo o run durável e parte da
primeira task não finalizada, priorizando o child profundo.

O teste focado `tests/integration/s07-worker-resume.test.ts` executa processos reais separados para
executor model, judge, tool/gate e integração Git. Cada worker passa pelo IPC privado e valida seu
path scope; Git valida também o fingerprint do comando exato. As operações produzem control
heartbeats e progress e encerram por shutdown gracioso. No Windows, chegar a `ready` exige que o
spawn tenha atribuído o processo ao Job Object; em POSIX o mesmo caminho usa process group. O
ledger começa sem runs/tasks, e seus únicos quatro eventos são escritos nos callbacks do supervisor
para as reverse calls autorizadas; o worker Git não recebe porta de escrita. O caso passou com zero
falhas.

### Estado de implementação de S07.05

O mesmo teste prova `required` sem run, conflito de `never` diante de run interrompido, retomada do
mesmo run sem perder a mutação, `--new-run` com identidade distinta, roteamento de stop gracioso ao
supervisor e projeção de todos os runs por `status --all`. A superfície `resume` também é parseada e
retorna o diagnóstico determinístico quando não há alvo.

A fixture `s07-resume-matrix` mantém, no mesmo run, uma task que sofre crash exatamente após
`completion_prepared`, uma task `active`, uma `interrupted` e uma primeira `pending`. A retomada sem
`runId`, com `resumeDiscovery: auto`, conserva a identidade do run, reconcilia a conclusão preparada
sem nova model call e só então executa `active`, `interrupted` e `pending`, nessa ordem. A prova exige
um único attempt para a task preparada e confirma que a transaction termina `committed`.

O workspace da matriz é um repositório Git real e limpo. Cada attempt preserva baseline `git`, HEAD,
branch e revision; a evidência preparada retém diff content-addressed contendo o artefato criado.
Depois da retomada, os quatro markers e os quatro registros do ledger convergem para `completed`, os
eventos incluem `completion.prepared`, `run.resumed`, `completion.reconciled.marker` e
`completion.reconciled.commit`, o HEAD original permanece intacto e o status Git representa somente
o PRD e os artefatos entregues, sem reset ou commit implícito. A suíte focada inteira passou com 3
testes, 48 asserções e zero falhas.

### Estado de implementação de S07.06

A matriz `S07.06 auditable workspace recovery`, em
`tests/integration/s07-worker-resume.test.ts`, parte de um repositório Git real e de um checkpoint
explícito limpo. A primeira tentativa persiste evidência e diff content-addressed; enquanto ela é
avaliada, a fixture simula uma edição externa não rastreada. A tentativa seguinte compara o
`afterHash` esperado da última evidência com o snapshot observado, detecta a divergência antes de
chamar novamente o executor, interrompe a task e conserva o HEAD e todos os arquivos sem `reset`,
rollback ou commit implícito.

O recovery manifest persistido liga task baseline, expected/observed hashes, diff verificável por
SHA-256, inventário `created|modified|deleted`, untracked do Git e refs imutáveis dos artifacts
before/after. O context bundle da tentativa bloqueada inclui o mesmo manifesto como resource e um
pointer autenticado para o objeto-fonte; a continuação cria uma nova observação e o evento
`recovery.operator_decision_accepted` liga, em uma autorização CLI one-shot, o manifesto da decisão
ao manifesto atual.

`status run` apresenta comandos para `inspect`, `continue`, `checkpoint` e rollback explícito. A
matriz executa `checkpoint create` no run bloqueado, prova que `rollback preview` não altera PRD nem
arquivos, exige o hash exato do plano, cria safety checkpoint antes do apply e confirma os eventos
`checkpoint.created`, `checkpoint.rollback.previewed` e `checkpoint.rollback.applied`. O rollback
aplica apenas as operações previamente exibidas e retorna o workspace ao checkpoint inicial. A
execução focada `bun test tests/integration/s07-worker-resume.test.ts -t S07.06` passou com 1 teste,
76 asserções e zero falhas.

Uma regressão de retomada também ficou coberta: revisões iniciadas por outro processo do CLI agora
reutilizam o snapshot imutável de opções da tentativa anterior da mesma task, em vez de resolver as
opções vazias da nova invocação e rebaixar avaliação externa para determinística. A matriz exige duas
avaliações externas persistidas, com notas `60` e `88`, e comprova que a segunda só aprova contra o
threshold preservado de `85`; toda a decisão explícita de recovery continua obrigatória e inalterada.

### Estado de implementação de S07.07

O port de reconciliação task-scoped, o filtro durável por run/document/task, o replay read-only sob a
policy atual e os probes de pré/pós-hash para `fs.write`, `fs.edit` e `fs.apply_patch` estão ligados ao
runner antes de novo trabalho de modelo. Efeito externo, destrutivo, desconhecido, estado parcial e
processo sem identidade durável pausam de forma conservadora. `tool-call-journal` prova persistência,
classificação `safe-to-retry|manual-reconciliation` e ausência de blind replay.

A matriz focada `tests/integration/s07-tool-reconciliation.test.ts` cria um model call real, persiste
intents no journal SQLite usando os IDs reais de run/attempt/model-call e então derruba o backend,
deixando o run `interrupted` exatamente depois da fronteira durável e antes do settlement. A retomada
do mesmo run passa pelo `RalphExecutionToolPort` real antes de permitir outra chamada de modelo.
Ela prova, no mesmo fluxo, replay de `fs.read`, replay único de `fs.write` cujo target ainda satisfaz
a precondition `absent`, confirmação sem replay quando o target já possui o pós-hash esperado e uma
segunda reconciliação vazia, preservando as idempotency keys e um único settlement por intent.

Os casos conservadores cobrem um write cujo hash atual coincide com nem o estado anterior nem o
posterior, um `artifact.publish` de efeito externo ambíguo e um `process.exec` sem lifecycle/lease do
owner. Nos três casos inseguros o backend seguinte não inicia; o intent continua unsettled e o evento
`tool.reconciliation.paused` registra a estratégia e a razão. O caso de processo usa o probe durável
de S07.04 e confirma que a ausência de lifecycle falha fechada sem spawn ou replay do comando. A
execução focada passou com 3 testes, 54 asserções e zero falhas. A kill matrix mais ampla com processo
vivo continua corretamente pertencendo a S07.11, sem reabrir o contrato literal de S07.07.

### Estado de implementação de S07.09

As quatro ações chegam ao runner por uma decisão tipada e durável. `notify` persiste snapshot,
diagnóstico e warning sem abortar trabalho que ainda pode terminar. `cancel`, `restart-attempt` e
`stop-run` abortam o signal command-owned; a fronteira de backend solicita cancelamento, aguarda a
janela bounded de settlement e só libera a tentativa quando o efeito anterior ficou terminal. Na
composição de produto, o worker recebe cancel/shutdown gracioso e `TypedWorkerHandle.shutdown`
escala para a árvore somente depois do grace; processes externos usam o contrato
`cancel -> grace -> terminateTree`, coberto pela suíte focada do supervisor. Child faz
`requestStop` gracioso na subtree e chama `forceKill` somente se essa etapa falhar.

O caminho de attempt agora trata cancelamento e deadline de backend de forma uniforme: se startup ou
outcome continuam unsettled ao fim da janela, o model call permanece `started`, recebe observação de
late settlement e um `restart-attempt` é adiado. Isso impede overlap entre a tentativa antiga e a
nova; resume continua bloqueado até existir settlement terminal. `cancel` interrompe e adia somente
a task afetada, permitindo que slices independentes prossigam, enquanto `stop-run` encerra a
invocação imediatamente em estado retomável.

`max_restarts` é reconstruído apenas dos attempts da mesma run/document/task, não do run inteiro.
Cada decisão `restart-attempt` reserva exatamente uma unidade no contador operacional
`watchdogRestarts`; `revisionAttempts` permanece separado e é compensado quando um watchdog corta
uma tentativa de revisão. O restart cria novo attempt ordinal usando o mesmo task baseline, sem
reset, e o recovery manifest do attempt seguinte carrega o diff parcial. Ao esgotar o budget, a
decisão muda para `stop-run` com causa `restart-budget-exhausted`, não consome revision, preserva
task/diff e permite retomar o mesmo run.

A matriz `tests/integration/s07-watchdog-recovery-actions.test.ts` cobre: notify com conclusão;
restart real após cancelamento confirmado; duas tasks usando independentemente seu limite de um
restart; backend unsettled impedindo overlap; cancel de uma task sem impedir outra independente;
resume do mesmo run com o path parcial no contexto; e exhaustion `stop-run -> resume`. A execução
focada passou com 5 testes, 38 asserções e zero falhas. A kill matrix transversal em todas as fases
continua em S07.11; ela amplia a prova de processos reais, mas não deixa pendente nenhuma semântica
da ação S07.09.

### Estado de implementação de S07.10

O command entrypoint usa uma única `CommandShutdownLifecycle` para sinais do processo headless e
para o callback de interrupt da TUI. Ambos chegam ao mesmo `TwoPhaseShutdownController`: o primeiro
`SIGINT|SIGTERM` muda para `graceful`, aborta sincronicamente o signal command-owned usado pelo
scheduler e inicia `cancelAll`; um sinal posterior muda para `forced`, chama `forceKillAll` e mantém
o exit code convencional 130. A TUI não possui autoridade paralela para matar somente o renderer ou
um worker isolado.

`ProcessShutdownRegistry.whenIdle()` só libera o closing depois que cada participante executou seu
hook de settlement/unregister. `TwoPhaseShutdownController.close()` tornou-se aguardável; durante um
drain iniciado por sinal, os listeners permanecem instalados, permitindo a segunda fase, e o
`finally` do CLI só os remove após o fechamento real. Settlement normal sem sinal continua fechando
imediatamente, sem cancelar participantes que pertencem ao contrato explícito de detach/background.

A matriz `tests/integration/s07-two-phase-shutdown.test.ts` cobre as duas entradas. O caso controlado
emite o primeiro sinal pela fonte headless, prova que novas admissões param e que `close()` permanece
pendente enquanto o cancel gracioso não assentou; então envia o segundo interrupt pela ponte da TUI,
confirma force, exit 130, transições `graceful -> forced -> closed`, registry vazio e remoção tardia
dos listeners. O caso de produto inicia um subprocesso real por `BunProcessSupervisor` e um worker
tipado real, envia somente o primeiro sinal e exige ambos terminalmente encerrados, sem PID vivo,
sem worker fora de `exited` e sem participante restante antes de o CLI closing retornar. A execução
focada passou com 2 testes, 22 asserções e zero falhas.

### Estado de implementação de S07.11

A matriz `tests/integration/s07-kill-injection-matrix.test.ts` derruba a execução em nove fronteiras
literais e retoma sempre o mesmo run e a mesma task: task já `active`; intent de tool durável antes
do efeito; write de tool aplicado e assentado; resultados de gates persistidos; assessment do judge
persistido; `completion_prepared`; marker já escrito no Markdown; evento
`completion.marker_written`; e commit/evento terminal `task.completed`. Os pontos de fault do runner
ficam depois das respectivas escritas duráveis; contadores de gate e judge são persistidos antes do
corte, não reconstruídos por aproximação depois do crash.

Os dois cortes de tool atravessam o `RalphExecutionToolPort`, o `ToolHost` e o journal SQLite reais.
No corte de intent, o target ainda satisfaz a precondition e a reconciliação faz exatamente um
replay seguro. No corte de write, o settlement já existe e nenhum replay ocorre. Em ambos sobra um
único intent, um único settlement e o arquivo com o conteúdo esperado. Os cortes de completion não
fazem nova chamada de backend; os demais criam apenas o novo attempt ordinal necessário.

Cada caso exige marker `[x]` único, task final `completed`, diff content-addressed contendo todos os
arquivos acumulados, ordinais contíguos, IDs de attempt/model call sem repetição, counters de model,
tool e gate iguais aos registros do ledger, report igual à soma dos attempts, exatamente um evento
terminal de completion, nenhuma decisão `skipped` e nenhuma transaction preparada remanescente. Os
9 casos passaram com 344 asserções e zero falhas.

A matriz de falsos positivos em `tests/hardening/watchdog.test.ts` usa clock e scheduler controlados
para stream silencioso com heartbeat e provider pendente, reasoning longo sem chunks, build saudável
e worker congelado. Os dois últimos usam subprocessos reais ocultos: o build produz atividade CPU e
IO observável enquanto continua `slow` sem quorum; o worker permanece vivo mas não emite control,
child heartbeat nem progresso, fica `suspect` na primeira probe e somente vira `stalled` com
`restart-attempt` na segunda confirmação independente. Os processos pertencem ao teste, são
encerrados no `finally/afterEach` e não deixam PID órfão. O arquivo passou com 7 testes e zero falhas.

A matriz revelou dois bugs reais e bounded. Resume de um crash em gate/judge deixava o record em
`verifying|evaluating` e tentava a transição proibida diretamente para `active`; o runner agora
assenta attempts ativos como `interrupted`, limpa o vínculo e reconcilia a task antes de reativá-la.
Em workers sequenciais, um heartbeat capturado entre requests podia chegar sem `activeRequestId`
depois de o supervisor já marcar o próximo request como `busy`; esse snapshot vazio de fronteira é
aceito, mas qualquer ID não vazio divergente continua falhando fechado. O teste IPC que reproduziu a
corrida passou isolado depois da correção.

As regressões focadas também ficaram verdes: 3 casos de tool reconciliation; os 3 casos S07.05/06
do arquivo de worker/resume; o caso IPC S07.04 após a correção; e 2 casos filtrados da matriz antiga
de completion, inclusive deadline de boundary e reconciliação sem nova model call. Todas as
execuções Bun foram iniciadas em processo oculto, `BelowNormal`, com timeout externo e logs em
`%TEMP%`; nenhuma suíte global foi executada.

## Critérios de conclusão

- Reinício nunca pula a task incompleta.
- Marker/ledger/event convergem após crash em completion.
- Diff e untracked aparecem no contexto retomado.
- Lock órfão/PID reciclado são tratados com grace/probes.
- Quiet/slow saudável não é morto.
- Stall real é detectado, registrado e recuperado conforme budget.

## Verificação mínima

```text
ralph-next run --resume auto --prd <fixture>
ralph-next status --all --format json
ralph-next resume <run-id>
ralph-next stop <run-id> --graceful
bun test packages/persistence packages/supervisor --filter kill
bun test packages/supervisor --filter watchdog
```
