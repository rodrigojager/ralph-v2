---
task: Entregar sub-PRDs supervisionados paralelismo isolado Git e segurança
engine: codex
---

# Subplano S09 — Sub-PRDs, paralelismo, Git e segurança

## Resultado do subplano

Uma task root executa o sub-PRD que a skill já gerou, acompanha child e só conclui quando ele e o contrato externo passarem. Tasks explicitamente independentes podem rodar em worktrees/branches/claims diferentes e integrar com gates. Segurança, sandbox, checkpoints e recovery impedem colisão ou limpeza destrutiva.

## Referências obrigatórias

- `docs/07-prd-v2-subprds-e-skill.md`
- `docs/10-persistencia-retomada-watchdog-e-filhos.md`
- `docs/12-tui-ux-layout-e-progresso.md`
- `docs/13-paralelismo-git-sandbox-e-seguranca.md`

## Tarefas

- [x] S09.01 implementar recursive scheduler que transforma referência validada em child `RunRecord`, persiste parentRunId/parentTaskId antes do spawn, materializa inherited defaults/overrides e recusa runtime generation, depth/count/cycle violations.
- [x] S09.02 implementar child supervisor/worker, lease/heartbeat/event aggregation/cancellation, regra de resume child mais profundo primeiro e completion externa somente após child terminal pass mais verification do pai.
- [x] S09.03 integrar árvore e barras root/child/aggregate na TUI/status/report, sem dupla contagem, mostrando child current task, watchdog, tokens e erro.
- [x] S09.04 implementar parallel eligibility por dependencies/group/policy/capabilities/limits, claim transacional de task/paths/artifacts/ports e scheduler que respeita max global/project/provider sem presumir independência.
- [x] S09.05 implementar Git worktree/branch por task com paths gerenciados, base/integration branch, dirty baseline policy, commit/no-commit e retention; validar path antes de criar/remover e cobrir locks/long paths no Windows.
- [x] S09.06 implementar integration strategies `none`, `merge`, `rebase-merge`, `cherry-pick` e `create-pr` atrás de ports, com ordem determinística, integration gates e conflito que pausa/cria attempt explícita, nunca escolhe ours/theirs automaticamente.
- [x] S09.07 implementar fail-fast/retry-failed/worker draining e recovery de claim/worktree após crash, garantindo por invariantes estáticos que completed não é redespatchado, failure não apaga branch e projetos usam ledgers/leases próprios.
- [x] S09.08 implementar checkpoints antes/depois, inventory de diff/untracked/PRD/state e rollback com preview/backup/conflict; proibir reset-hard/clean/recursive delete/force-push automático.
- [x] S09.09 implementar security profiles safe/auto/dangerous, command/network/external-effect policies, headless ask behavior, secret redaction e judge read-only; integrar diagnostics e overrides à TUI/report.
- [x] S09.10 implementar sandbox process local e adapters Docker/Podman conforme capability, com mounts/network/env/resources/ports/cleanup, falha explicável quando indisponível e nenhum stack de aplicação imposto.
- [x] S09.11 executar E2E de child completo, nested resume, child failure, dois parallel sem conflito, path-claim conflict, merge conflict, worker crash, sandbox e malicious PRD/tool; auditar que o executor não consegue spawnar child fora do graph.

## Estado de implementação do runtime child

As fundações e a composição estática de S09.01–S09.03 existem no código. Os checkboxes concluídos registram entrega de implementação, e a prova runtime/E2E bounded de S09.11 está registrada abaixo:

- o runtime aceita somente referências de sub-PRD presentes no `CompiledPrdGraph`; autoria, expansão e criação dos arquivos continuam responsabilidade da skill, antes do run;
- validação defensiva recusa diagnostics de erro, geração em runtime, ciclos, documentos inalcançáveis, múltiplos pais/filhos e limites de profundidade/quantidade;
- a reserva transacional persiste `RunRecord`, tasks diretas, identidade determinística, vínculo parent/child, opções herdadas, hashes e quantidade esperada de filhos antes de entregar o child ao executor;
- vínculos, observabilidade, receipt terminal e projeções de eventos são duráveis, revisionados e isolados pelo ledger/workspace; o mesmo parent task não pode reservar dois children;
- o scheduler prioriza o child retomável mais profundo, e cada child supervisor usa lease própria vinculada ao parent; `survive-parent` continua fail-closed sem owner de processo independente;
- essa restrição é específica ao coordinator de child. O owner independente de `process.exec` não torna o child loop independente: ele só conserva e reconcilia o efeito de comando exato daquela tool;
- o loop serial reserva/retoma o child e compõe um `ChildRunExecutionPort` sobre uma instância Ralph real no worker tipado `child-run`; a lease pertence ao PID/start-token do worker, budget/observações/eventos cruzam IPC estreita, cada documento executa em processo de coordinator próprio e um child já terminal recebe apenas reconciliação sem nova chamada de executor/modelo;
- a supervisão desse worker usa o profile efetivo da fase `child`: heartbeat periódico e ping semântico permanecem observações independentes, mas suas ausências compartilham uma única família negativa no quorum quando o control plane IPC cai; progresso é lido do vínculo atual no ledger, PID + start-token e liveness IPC autorizam a renovação da lease sem transformar silêncio de progresso em expulsão, e grace/quorum/hard deadline governam somente ações do watchdog; `enabled: false` desarma inclusive o deadline do watchdog, `restart-attempt` recria a sessão dentro do budget durável e shutdown/kill continua confirmado antes de liberar a fronteira;
- `maximumDepth` não é inventado pela factory: o runner extrai o maior depth do grafo imutável já validado, envia esse limite exato pelo contrato tipado e o worker recompila recusando qualquer árvore mais profunda;
- `once` e `maxTasks` formam um único orçamento por invocação, compartilhado por root e todos os níveis child; somente uma execução real de task consome uma unidade, portanto descer um nível não multiplica o limite nem permite executar o parent depois de a última unidade ter sido consumida;
- uma task parent só pode entrar em completion depois de child `passed`, artifacts reconciliados e receipt íntegro; passar o child apenas libera a verificação independente do contrato externo;
- dry-run segue a cadeia pré-autorizada até a task externa mais profunda que realmente exigiria backend; a presença de `childEdges` é anunciada como suportada, não como indisponibilidade global;
- projeção e recovery do child leem somente páginas indexadas do próprio `runId`, limitadas por high-water mark, sem desserializar eventos de outros runs;
- status terminal do vínculo não é falsificado como `running`: `passed`, `failed` e `cancelled` são escritos exclusivamente pelo settlement com receipt;
- `status run` e o snapshot/follow da TUI leem a árvore durável, mostram a task mais profunda, progresso agregado por leaf task, barra proporcional à largura do painel, watchdog, logs e uso sem contar a task refinada e suas leaf tasks duas vezes.

Não há geração de PRD em runtime: árvores históricas marcadas como concluídas são apenas reconciliadas deterministicamente, e qualquer árvore incompleta volta ao primeiro escopo retomável.

## Estado de implementação do runtime paralelo/Git/sandbox

- `mode=parallel` entra em runner próprio antes do loop serial e nunca usa serialização como fallback; ausência de branch-per-task, claims, capacidade, backend, credencial ou sandbox elegível produz diagnóstico/espera explícita;
- task com sub-PRD usa lane command-owned exclusiva dentro do runner paralelo, no mesmo worktree, descendo children recursivamente e compartilhando o budget root/child sem chamar o loop serial root;
- a exigência de parent sequencing torna a task elegível somente para a lane command-owned de child;
  a supervisão/reconciliação do child não consome budget por si só, enquanto cada leaf task nova
  executada nessa lane consome o mesmo budget compartilhado; child já concluído continua sem modelo
  e sem novo débito;
- scheduler de ondas aplica dependências, grupos/`parallel.auto`, retry budget, fail-fast drain e limites duráveis global/projeto/provider/model;
- claims iniciais cobrem task, worktree, branch, artifact e integration target; paths canônicos são expandidos depois da criação do worktree e antes do executor;
- lease expirada só é recuperada no `runId` retomado, depois da grace e de duas probes exatas `dead`/`identity-mismatch`; `alive`/`unreachable` permanece retida, outra run no mesmo workspace não é alterada e cada ownership epoch recebe claim-set ID novo;
- owner comprovadamente morto terminaliza model call/attempt/task em voo como `interrupted` e cancela judge call ainda aberta; sem sandbox pendente, um worktree `active` recebe marcador durável e é retomado com novo attempt depois da reconciliação de tools, mesmo que o recovery feche antes do redispatch; sandbox sem `terminationConfirmed=true` força retenção e bloqueia tanto reuse quanto fresh retry até confirmação durável;
- o preflight de execução esgota o índice de sandbox do workspace por keyset `(created_at DESC, id DESC)`, em páginas limitadas a 256 registros e sem limite total; a persistência entrega cursor exclusivo e o runner recusa página oversized, ordem não estrita, cursor ausente/repetido ou sem avanço. Assim, nem a barreira global nem o recovery por worker/attempt omitem sessões depois do antigo teto de 1.000;
- qualquer sessão não confirmada de outra `runId` bloqueia toda nova execução/attempt/redispatch no workspace sem deduzir escopo pelo `taskId`; a contagem considera todas as páginas e somente a amostra do diagnóstico é limitada. O runner repete o scan no preflight, antes de cada tentativa efetiva e em cada snapshot de nova onda paralela. Para a própria run retomada, todas as páginas também são consideradas, mas o bloqueio pode permanecer específico à task/worktree correspondente;
- worktree/branch inclui `attemptId`, preservando falhas e retries; nenhum cleanup usa force, e erro/lock de remoção após integração transforma o worktree em `retained` sem invalidar a entrega já integrada;
- conclusão isolada só recebe waiver de marker quando há estado Git durável; completion interrompida é reconciliada no worktree do mesmo attempt, e worktree concluído sem integration record é retomado sem nova chamada de modelo;
- integration records `pending/running/paused/failed/conflicted` não são repetidos cegamente; `none` e `pr-created` permanecem `waiting`, com branch/path/IDs visíveis;
- recovery de integração em voo usa target anterior, source/target ancestry, patch equivalence, refs, dirty/conflict state para assentar `passed`, liberar somente retry comprovadamente sem mutação, ou pausar como ambíguo;
- crash entre integration record terminal e settlement do worktree reconcilia `passed` somente após ancestry do `resultHead`, retém cleanup por segurança e repõe checkpoint pós-entrega configurado; `pr-created` apenas recupera o boundary externo sem repetir o efeito;
- merge/rebase-merge/cherry-pick/create-pr/none são comandados pelo CLI, em ordem determinística, com verificação do target HEAD; conflitos não executam ours/theirs, abort, reset ou rollback automático;
- checkpoints capturam refs/status/diff completo, paths alterados/untracked, documentos PRD e state revision; truncation falha fechado; rollback exige preview/plan hash/confirmação;
- security policy efetiva é persistida por worker, sandbox é escolhido por capability e todo comando de tool continua sob boundary command-owned;
- claims e vagas só são liberadas depois do worker e da integração chegarem a settlement; fail-fast drena workers ativos e impede nova onda.
- budget root/child é debitado somente por nova execução de task; reconciliação/integration-only de task já concluída tem custo zero, usa onda própria e permanece sujeita a capacity/claims.

A validação automatizada geral anterior permanece registrada: `check` passou com 673 testes, a
integração completa com 149, a suíte de segurança com 91, o compatibility source-only com 5/5 e o
addendum S03 com 15/15. O standalone Windows x64 também passou por build e smoke nativos. Essa suíte
geral não foi repetida durante a rodada bounded de S09.11.

A matriz dedicada `tests/integration/s09-bounded-e2e.test.ts` foi executada isoladamente em
19/07/2026 com Bun `1.3.14`: **5 pass / 0 fail, 64 asserções, 71,01 s**. Ela cobre verticalmente:

- root → child → grandchild, crash injetado na fronteira typed da segunda sessão antes de qualquer
  chamada ao executor, persistência dos dois vínculos como `interrupted`, retomada pelo child mais
  profundo, execução exatamente uma vez de leaf/child/root, reconciliação de artefatos e markers;
- recusa explícita de reservar child a partir da leaf sem edge pré-autorizada, mesmo com instrução
  maliciosa no texto do PRD pedindo para ignorar o graph;
- gate determinístico não-zero no child, com evidência preservada e parent não concluído;
- dois workers reais em worktrees distintos chegando em ordem concorrente arbitrária, commits,
  integração merge determinística, checkpoints, cleanup de worktrees e liberação de claims;
- dois claims de path canônico sobrepostos recusados e merge conflitante preservado em `waiting`, com
  conflito visível e sem seleção automática de `ours`/`theirs`;
- sandbox local supervisionado executado até settlement, exit natural distinguido de kill por
  `treeTerminated: false` e ainda assim registrado com `terminationConfirmed: true`, cleanup
  idempotente, isolamento forte recusado quando a capability é apenas process/policy;
- comando destrutivo `git reset --hard` recusado antes do spawn, policies safe/auto/dangerous sem
  autorização destrutiva, judge read-only e external effect `ask` negado em headless.

A matriz revelou e corrigiu seis defeitos de integração: comparação de `parent.prd` relativo contra
document ID; `INSERT` de child link com 22 valores para 23 colunas; ledger global de capacity sem
migrations; FKs de `attempt_id` incompatíveis com claims/worktrees reservados antes da attempt;
validação indevida de `parentRunId` de linhagem como autoridade de projeção nested; e confusão entre
`treeTerminated` (ação de kill) e confirmação de término natural. O backend do teste paralelo agora é
roteado por task, portanto a ordem legítima de chegada dos workers não altera o script recebido.

Limitações externas, separadas da matriz local concluída: não houve kill real de processo child pelo
SO (o crash é injetado deterministicamente na fronteira do worker), execução Docker/Podman ou prova
de isolamento forte, criação de PR/forge remoto, Unix/macOS nem retomada cross-process nessas
plataformas. A migration v15 foi exercitada em ledgers novos da matriz, não por uma matriz completa de
upgrade com ledgers históricos. Nenhum desses itens externos foi alegado como validado.

## Critérios de conclusão

- Parent não conclui antes do child e não o duplica após resume.
- Child somente nasce de referência pré-validada.
- Parallel workers usam isolamento/claims e respeitam limites.
- Conflitos são visíveis e não resolvidos destrutivamente.
- Checkpoint/rollback são previewáveis e auditados.
- Segurança vale igualmente em TUI/headless e em Windows/Unix suportados.

## Verificação local atual

Com Bun `1.3.14`, a matriz bounded própria de S09.11 passou com 5/5 e 64 asserções. A evidência geral
anterior permanece `check` 673 testes, integração 149/149, segurança 91/91, compatibility source-only
5/5, addendum S03 15/15 e standalone Windows x64 com build/smoke. Os 60 schemas, lint e typecheck
pertencem ao gate geral anterior; não foram reexecutados nesta rodada focada. A matriz de plataformas
e integrações externas continua explicitamente fora dessa prova local.
