# 13 — Paralelismo, Git, sandbox e segurança

## Paralelismo só com isolamento demonstrável

Vertical slices reduzem dependência entre camadas, mas ainda podem tocar arquivos comuns. O scheduler paralelo precisa de autorização estrutural e isolamento; não basta observar que duas tasks estão pendentes.

`mode=parallel` é um caminho de execução próprio e comandado pelo CLI. Ele não cai silenciosamente no loop serial: sem `git.branch_per_task`, backend/credencial, capacidade, claim ou isolamento elegível, o run pausa/falha com diagnóstico. Uma task root que referencia sub-PRD entra numa lane command-owned exclusiva da onda: desce, retoma e reconcilia children no mesmo worktree antes de executar o contrato do pai. Essa lane não chama o loop serial root e compartilha exatamente o mesmo `maxTasks` com as demais tasks.

## Elegibilidade paralela

Uma task só roda paralelamente quando:

- dependências estão concluídas;
- pertence a grupo paralelo permitido ou `--parallel-auto` foi explicitamente escolhido;
- seus write scopes não conflitam com claims ativos, ou worktree/merge policy aceita o risco;
- child graph não requer parent sequencing;
- limite global, por projeto, provider e modelo possui vaga;
- Git baseline está consistente;
- sandbox/credentials permitem worker adicional.

`max_parallel` é teto, não garantia.

## Claims

Antes do worker, registrar claim de:

- task/run/attempt;
- worktree/branch;
- paths declarados e eventual wildcard;
- artifacts;
- ports/serviços temporários;
- integration target.

Claims têm lease. O bundle inicial (task, worktree, branch, artifact e integration target) é adquirido antes do worker; os paths canônicos do checkout isolado são adicionados depois que o worktree existe e antes do executor. Conflito conhecido bloqueia a onda — nunca ativa fallback serial. Se o executor toca path não declarado, a finalização verifica o diff antes de staging e aplica `scope_expansion`: negar, pausar ou adquirir claim adicional antes de tentar finalizar novamente.

Lease vencida não autoriza takeover por tempo apenas. Recovery só ocorre dentro do `runId` retomado, depois de lease + grace e duas probes da identidade exata de processo, separadas por intervalo mínimo; `alive` ou `unreachable` mantém a claim. Assim, retomar uma run nunca expira silenciosamente claims de outra run no mesmo workspace. Uma nova época de ownership recebe novo `claimSetId`, inclusive ao retomar a integração de um attempt já concluído.

## Worktrees e diretórios

Modo preferencial para paralelo Git:

```text
<workspace>/.ralph/worktrees/<run-id>/<task-id>--<attempt-id>/
branch: ralph/<run-short>/<task-id>/<attempt-short>
```

Antes de criar/mover/remover, resolver paths absolutos e confirmar que pertencem ao diretório gerenciado. Remoção é feita após integração/retention e nunca contra workspace root. Em Windows, lidar com path length, antivirus locks e process handles com diagnostics claros.

O runtime atual exige worktree Git em `mode=parallel`. Cópia/sandbox sem Git só poderá ser habilitada quando existir estratégia determinística de merge e checksums; até lá é recusada, sem degradação serial.

## Estratégias de integração

- `none`: deixa branches/worktrees para inspeção;
- `merge`: integra em ordem determinística no integration branch;
- `rebase-merge`: atualiza cada slice, roda gates de integração e merge;
- `cherry-pick`: commit por task;
- `create-pr`: publica branch e abre PR/draft quando credencial/plugin existe;
- custom integration adapter.

Conflito nunca é resolvido por escolher “ours/theirs” globalmente. Ele cria integration task/attempt supervisionada ou pausa. Gates da task e gates de integração são distintos.

### Adapter externo de pull request

`create-pr` só fica disponível quando `RALPH_PULL_REQUEST_ADAPTER_CONFIG` aponta para um arquivo
JSON regular e bounded. O adapter é deliberadamente provider-neutral: Ralph não escolhe GitHub,
GitLab, forge, CLI ou SDK. A configuração v1 declara o executável, SHA-256 esperado, argumentos
fixos sem material secret-like, referências de ambiente e timeout. Credenciais devem entrar por
`environmentRefs`; token, password, bearer, chave, sentinel redigido ou token opaco literal em
`args` é recusado, assim como nome secret-like em `environmentAllowlist`.

```json
{
  "schemaVersion": 1,
  "protocol": "ralph-pull-request-adapter-v1",
  "executable": "./adapters/create-pull-request",
  "expectedExecutableSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "args": ["serve-stdio"],
  "environmentRefs": { "FORGE_TOKEN": "env:RALPH_FORGE_TOKEN" },
  "environmentAllowlist": ["PATH", "USERPROFILE"],
  "timeoutMs": 120000
}
```

O exemplo de hash é ilustrativo e precisa ser substituído pelo SHA-256 real. Ralph resolve config,
executável e repositório por handles/caminhos canônicos, recusa link simbólico, confere o hash no
spawn e envia uma única requisição JSON por stdin. Ela contém repository root, source/target refs,
source HEAD exato, title/body/draft/labels, chave de idempotência e `requestBinding`. O binding é o
SHA-256 canônico de todos esses campos funcionais; ele é recalculado depois do `realpath`. O adapter
devolve um único JSON `created|existing` com a mesma chave, o mesmo binding, a referência criada e o
HEAD observado. Qualquer divergência, output incompleto/truncado, timeout ou ausência do adapter
falha fechado e nunca vira `pr-created`.

`--retry-failed` reexecuta somente tasks elegíveis que falharam sob policy; não duplica completed. `--fail-fast` deixa workers ativos chegarem a ponto seguro e para de agendar.

Claims e vagas de capacidade permanecem ativas até o callback de integração terminar. O integration target é conferido contra o HEAD capturado antes da onda; mudança externa retém os worktrees e exige nova continuação, sem rebase implícito. Workers concluídos na mesma onda são integrados por ordem topológica/task ID, nunca pela ordem aleatória de término.

## Restart, resume e budget

- uma conclusão registrada no ledger pode divergir temporariamente do marker do PRD principal somente quando um `GitWorktreeRecord` durável demonstra a conclusão isolada ainda não integrada;
- uma completion transaction interrompida é reconciliada contra o worktree do mesmo `attemptId`, não contra o checkout principal;
- depois de recovery comprovado do owner morto, model calls ainda `started` viram `interrupted`, judge calls ainda `started` viram `cancelled` e attempt/task em voo são terminalizados; sem sandbox pendente, o worktree `active` recebe um marcador durável e a continuação usa esse mesmo worktree com novo attempt, inclusive se a primeira invocação de recovery encerrar antes do redispatch, enquanto completion e tool intents continuam vinculadas às claims do attempt;
- cada sessão sandbox persiste `terminationConfirmed`; `orphaned`, `failed` incerto, `stopped` legado sem confirmação e qualquer outro registro cujo valor não seja exatamente `true` continuam sendo write scopes potencialmente ativos. Antes de criar uma run, resolver backend, abrir attempt ou redisparar trabalho, o runner percorre todas as sessões do workspace em páginas keyset determinísticas de no máximo 256 registros, ordenadas por `(created_at DESC, id DESC)`. Não existe teto total silencioso: cursor ausente, repetido, fora de ordem, página oversized ou incapaz de avançar falha fechado;
- uma sessão sem confirmação pertencente a outra `runId` bloqueia todo o workspace, independentemente de seu `taskId`; o runner não infere que o risco estrangeiro está limitado a uma task. A diagnostic inclui contagem total e amostra limitada, mas a decisão é tomada somente depois de esgotar todas as páginas. O scan ocorre no preflight e é repetido no boundary de cada tentativa real e de cada nova onda paralela, cobrindo inclusive uma sessão incerta criada durante a própria invocação. Sessões da própria run retomada podem manter bloqueio específico por task: o worktree e a task ficam retidos, sem reuse nem fresh retry/redispatch, enquanto outras tasks da mesma run continuam elegíveis. Cleanup de processo local falha fechado quando não consegue provar término, enquanto container só confirma após identidade, stop/remove ou ausência comprovada;
- worktree parado em `preparing` ou sem evidência suficiente de task ativa é retido, nunca reutilizado; somente quando não existe sandbox de término incerto um marcador durável pode autorizar redispatch em isolamento novo, sem converter o crash de infraestrutura em falha funcional da task;
- worktree `active`/`retained`/`integrating`, task concluída e nenhuma integração iniciada formam uma unidade retomável: o executor não roda novamente, novas claims são adquiridas e uma nova tentativa de integração é criada;
- integração `pending`, `running`, `paused`, `failed` ou `conflicted` nunca é repetida às cegas; o run fica `waiting` com IDs, branch e path preservados;
- no recovery, `pending`/`running` é classificado por `targetHeadBefore`, `sourceHead`, ancestry, equivalência de patch, source ref, dirty state e conflitos: source já entregue e sem gates pendentes vira `passed`; `pending` comprovadamente sem mutação vira candidato de retry sob nova claim; qualquer estado não provado vira `paused`/`conflicted`, sem repetir efeito;
- se o processo cai depois de persistir integração `passed`/`pr-created`, mas antes de assentar o worktree, o resume reconcilia apenas o estado terminal já provado: uma entrega mutante exige que `resultHead` ainda seja ancestral do target atual, fica `retained` com cleanup conservadoramente adiado e recria o checkpoint pós-entrega quando a policy o exigia;
- `none` e `pr-created` são entregas externas pendentes, não conclusão falsa do run;
- worktree de retry inclui `attemptId`, portanto uma falha nunca é apagada nem reutilizada por outra tentativa;
- `maxTasks` conta somente novas execuções reais de task, somadas entre root e children. Uma retomada `integrationOnly` que apenas reconcilia/finaliza trabalho já concluído custa zero e roda em ondas próprias; `max_parallel`, `max_global`, limites por provider e modelo continuam limitando seus workers simultâneos;
- o budget único root/children continua valendo nos modos que executam children. Em `parallel`, uma
  task com Sub-PRD usa uma lane command-owned no mesmo worktree isolado: a supervisão do child não
  consome unidade por si só, mas cada nova leaf task realmente executada debita o mesmo budget
  compartilhado. Não existe fallback para o loop serial do checkout principal nem um segundo teto
  capaz de contornar `once`/`maxTasks`.

No fail-fast, todos os workers já ativos chegam ao settlement; resultados concluídos ainda passam pela integração determinística e só então claims/capacidade são liberadas. Nenhuma nova onda é aberta após a primeira falha observada.

## Políticas Git

Configurações preservadas/ampliadas:

- base branch e integration branch;
- branch por task/run;
- commit por task ou `--no-commit`;
- mensagem template;
- assinatura quando configurada;
- create PR/draft/labels;
- permitir/proibir dirty baseline;
- checkpoint antes/depois;
- rollback somente explícito;
- retention de worktree/branch;
- ignore paths gerados pelo Ralph.

O Ralph não faz `reset --hard`, limpeza recursiva ou force push como recuperação automática. Operações destrutivas exigem target resolvido, preview, confirmação/policy e evento auditável.

## Checkpoints e rollback

Checkpoint contém:

- Git refs/status/diff hash;
- arquivos não rastreados relevantes por artifact store quando permitido;
- PRD/state revision;
- database backup/transaction cursor;
- comando/razão/timestamp.

O runner cria checkpoint no boundary inicial quando a policy exige, antes das ondas seguintes quando `checkpoint_before_task`/`auto_checkpoints` está ativo e depois de integração bem-sucedida quando configurado. Git status/diff incompleto ou truncado invalida o checkpoint. `.ralph/**` não entra como arquivo de workspace restaurável. `auto_rollback` é recusado: rollback continua sendo preview hash-bound + confirmação explícita.

Rollback mostra exatamente o que será restaurado/removido. Default cria checkpoint de segurança antes. Se alterações externas surgiram após checkpoint, pausa em conflito.

## Níveis de segurança

### `safe`

- escrita apenas no workspace/paths declarados;
- commands allowlisted;
- rede negada salvo provider/auth e destinos explícitos;
- ações destrutivas negadas;
- prompts de permissão em TTY, deny em headless sem regra;
- judge read-only.

### `auto`

- ferramentas comuns de desenvolvimento permitidas dentro do escopo;
- rede conforme project policy;
- risco elevado pede confirmação/é negado em headless;
- recomendado para uso interativo normal.

### `dangerous`

- amplia comandos/rede/escrita conforme config explícita;
- continua proibindo vazamento de secrets e falsificação de estado;
- banner/evento/relatório registram override;
- não equivale a “sem limites”.

## Sandbox

Backends possíveis:

- processo local com cwd/env/path policy;
- Docker;
- Podman;
- adapter futuro de VM/remote workspace.

Capability discovery escolhe o que existe; não obriga container. Configura:

- filesystem mounts read/write;
- network none/allowlist/full;
- CPU/memória/process/time;
- environment pass-through allowlist;
- user/UID quando aplicável;
- ports e cleanup;
- artifact export.

O model/provider call pode ocorrer fora do container enquanto tools rodam dentro; o boundary deve ser explícito.

O backend `process local` é contenção cooperativa de cwd/env/path e supervisão de árvore, não uma
fronteira de segurança entre processos do mesmo usuário. Um programa hostil executado sob o mesmo
UID/token pode sinalizar outros processos e tentar acessar arquivos do usuário, inclusive o control
plane. Portanto bearer tokens de canais locais protegem binding, stale descriptors e misdelivery,
mas não são apresentados como defesa contra esse adversário. Para executar código de workspace não
confiável, a policy deve exigir Docker, Podman ou sandbox de SO equivalente, montar somente o
workspace necessário e manter `.ralph`/`controlRoot` fora dos mounts; se essa capability não existir,
o modo que exige isolamento forte falha fechado.

## Commands e shell

- preferir argv sem shell quando possível;
- shell explicitamente selecionado por plataforma;
- nunca concatenar argumento do modelo em string não escapada;
- cwd e executable resolvidos;
- environment mínimo e secrets injetados somente no processo necessário;
- output limitado/redigido;
- process tree supervisionada;
- commands do PRD exibidos antes em dry-run.

## Rede e efeitos externos

Tool que cria issue, PR, deploy, mensagem, pagamento ou qualquer estado remoto exige plugin/capability e autorização específica. A permissão genérica de HTTP não autoriza efeitos irreversíveis. Requests recebem idempotency key quando o serviço suportar e settlement fica no ledger.

## Segredos e conteúdo não confiável

- secret refs nunca entram no prompt;
- redact headers, URLs com tokens, env e output;
- PRD/repo são conteúdo potencialmente não confiável e não podem alterar invariantes por prompt injection;
- instruções de `AGENTS.md`/projeto são contexto para execução, subordinadas à policy do Ralph e ao comando do usuário;
- symlinks/junctions são resolvidos antes de write;
- paths que escapam workspace são negados salvo capability explícita;
- artifacts HTML/Markdown não são executados pela TUI;
- dependencies/upstream code passam por licença e security review.

## Critérios de aceite

- Tasks paralelas não escrevem o mesmo checkout sem coordenação.
- Claims/leases sobrevivem a crash e expiraram com segurança.
- Merge conflict pausa ou cria integração explícita.
- Nenhuma recuperação automática usa reset/clean/force push destrutivo.
- Safe/headless nega perguntas sem policy.
- Secrets não aparecem em events, raw logs redigidos ou relatórios.
- Sandbox funciona de modo consistente nas plataformas declaradas ou falha com capability diagnostic.

## Estado de verificação local

A ligação do runner paralelo, claims/leases, worktrees, integração, checkpoints, sandbox e security
audit foi implementada. A validação local geral já inclui schemas, lint/typecheck, integração
149/149, gate consolidado 673/673, watchdog e build/smoke nativo Windows x64. Os E2E específicos de
concorrência, conflito, Git, sandbox, crash e plataformas externas ainda não fecharam; portanto este
documento não afirma essa prova runtime completa.
