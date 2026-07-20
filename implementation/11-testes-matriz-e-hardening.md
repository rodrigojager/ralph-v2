---
task: Validar e endurecer o Ralph v2 em toda a matriz funcional de falha segurança e plataforma
engine: codex
---

# Subplano S11 — Testes, matriz e hardening

## Resultado do subplano

A v2 deixa de ser apenas uma implementação que compila: cada requisito obrigatório tem prova automatizada ou smoke real claramente rotulado. Falhas de provider, crash, resume, watchdog, TUI, child, paralelo, segurança e plataformas são exercitadas; regressões são corrigidas antes do release.

## Referências obrigatórias

- `docs/15-testes-qualidade-e-criterios-de-pronto.md`
- `docs/18-matriz-de-rastreabilidade.md`
- todos os subplanos anteriores e seus criteria

## Tarefas

- [x] S11.01 inventariar todos os testes existentes por requisito R001–R079, preencher links/IDs na matriz, identificar provas ausentes e criar fila bounded; nenhuma linha obrigatória pode ficar apenas com “implementado”.
- [x] S11.02 consolidar fake provider/judge/CLI/OAuth/process/clock kit capaz de stream, tool, rate limit, malformed output, silence, heartbeat, freeze, PID reuse e score sequences, removendo dependência paga/não determinística da suíte principal.
- [x] S11.03 completar unit/property/fuzz/golden tests de PRD/source edits, graph, state transitions, options, progress/resizes, usage aggregation, redaction, path/command safety e event replay/version compatibility.
- [x] S11.04 completar integration/E2E empacotado para once/loop/wiggum/parallel, embedded/CLI backends, deterministic/self/external evaluation, change/artifact/skips/no-change, child/nested, Git/sandbox e headless/TUI parity.
- [x] S11.05 executar kill-injection em todas as fronteiras críticas de task/tool/gate/judge/completion/child/integration/outbox, corrigir duplicate/skip/divergence e manter relatório de cada ponto com resumed task/marker/diff/counters.
- [x] S11.06 executar watchdog false-positive/stall matrix com clock controlado e alguns processos reais, provar quiet/slow/retry-after/build longo saudáveis e frozen IPC/hard timeout recuperados somente após confirmations.
- [x] S11.07 executar security suite de secret canaries, traversal/symlink/junction, shell/arg injection, malicious PRD/prompt, oversized output, judge write request, headless ask e unsettled external effects; corrigir todo vazamento/escape crítico.
- [ ] S11.08 configurar CI Windows/Linux/macOS nas arquiteturas declaradas para install/build/test/package, process tree/signals, Git worktree, paths Unicode/espaço/long path, PTY/resize, keychain fake e sandbox capability; classificar skips, nunca tratá-los como pass.
- [x] S11.09 executar performance/backpressure/retention benchmarks para PRD grande, event storm, output grande, replay longo, TUI memory e múltiplos projetos; fixar budgets realistas a partir do baseline e corrigir regressões relevantes.
- [ ] S11.10 executar dependency vulnerability/license/secret/SBOM gates e verificar provenance OpenCode arquivo por arquivo, lockfile, notices e ausência de branding/assets indevidos.
- [x] S11.11 rodar compatibility matrix contra Ralph antigo em fixtures, upgrade/migration/rollback drills e smoke opt-in de providers/auth reais suportados, rotulando claramente mock, compile, contract e real integration.
- [ ] S11.12 fechar diagnostics/documentation gaps encontrados, obter suíte limpa repetível, arquivar artifacts/checksums/reports e bloquear S12 se algum requisito obrigatório não tiver owner/evidence/waiver explícito.

## Critérios de conclusão

- R001–R079 têm prova ou waiver explícito aprovado.
- Kill/resume e watchdog false-positive suites passam consistentemente.
- Nenhum secret canary aparece fora do store permitido.
- Platform/package smokes comprovam o que o README promete.
- TUI foi validada por PTY/runtime, não apenas source inspection.
- Upstream/license/SBOM gates estão limpos.

## Evidência executável atual

`docs/18-matriz-de-rastreabilidade.md` contém um ledger individual para R001–R079: 79 IDs únicos,
todos com owner, estado, evidence executável ou blocker nomeado, e nenhum link local quebrado. O
catálogo registra `check` 673/673, integração 149/149, E2E 63/63, segurança 177/177, watchdog 8/8,
smoke PTY em três execuções, matriz Windows ConPTY S08.12 5/5, compatibilidade source-only 5/5,
addendum S03 15/15 e build/smoke Windows x64. Isso fecha S11.01, mas não transforma os blockers do
ledger em waivers: o harness S10 contra o Ralph legado já passou 91/91, mas os binários precisam ser
fornecidos explicitamente para vinculá-lo a um novo archive; providers reais, PTY nas demais
plataformas, multiplataforma e release permanecem tarefas executáveis abertas abaixo.

S11.02 está consolidada em `packages/test-kit`: `ScriptedProviderDriver` cobre deltas de texto e
reasoning, tool calls, usage, rate limit com `retryAfterMs`, resultado deliberadamente malformado,
silêncio liberável, heartbeat e freeze cancelável; `ScriptedJudgeBackend` cobre sequências de nota,
assessment malformado, silêncio, heartbeat, freeze e cancelamento read-only; e
`ScriptedOAuthFetch`/`ScriptedLoopbackOAuth` cobrem browser PKCE e device polling sem browser, socket
ou rede reais, incluindo resposta malformada e request congelada/abortável. O
`ScriptedCliSupervisor`/`ScriptedProcessSupervisor` produz protocol output, tool batches, output
malformado, silêncio, chunks de heartbeat, processo congelado e settlement de cancel/force-kill;
`ScriptedProcessTable` mantém PID e troca o process-start token para provar PID reuse. Por fim,
`ControlledTestClock` implementa os contratos OAuth e watchdog/scheduler, inclusive sleep sentinela
congelado até abort, sem depender de tempo ou carga do host.

A suíte dedicada `packages/test-kit/tests/fakes.test.ts` e três consumidores representativos
(`packages/providers/tests/registry.test.ts`, `packages/credentials/tests/oauth.test.ts` e
`packages/model-drivers/tests/external-cli-backend.test.ts`) passaram juntos: 24/24 testes e 163
assertions com Bun 1.3.14. A primeira execução detectou que o clock avançava também o deadline
sentinela de 60 s; `freezeSleepsAtOrAboveMs` corrigiu o contrato e a repetição ficou verde. O Biome
focado passou em todos os arquivos tocados sem erro ou warning. Essa prova é deliberadamente local,
determinística e sem serviço pago; smokes opt-in de providers/auth reais permanecem explicitamente
`not-executed` em `BLK-AUTH-REAL`, sem serem convertidos em pass por S11.11. O typecheck/suíte global
passaram posteriormente em `EV-CHECK-673`; smokes reais continuam externos e bloqueantes.

S11.03 foi fechada pelo alias focado `bun run test:properties`: 111/111 testes em 12 arquivos,
5.205 assertions e zero falhas com Bun 1.3.14. A execução usou o wrapper Windows sem janela,
prioridade reduzida e logs redirecionados; inclusive o renderer OpenTUI foi somente o renderer de
teste headless, sem terminal/TUI visível. O Biome focado em `tests/unit/s11-properties.test.ts` e
`package.json` também passou sem erro ou warning. A suíte global não foi executada nem é inferida
por esta evidência.

| Contrato de S11.03 | Prova automatizada focada |
| --- | --- |
| PRD e source edits | `prd-properties.test.ts` preserva todos os bytes exceto o byte do marker em 20 combinações Unicode/LF/CRLF/BOM; `prd-marker-format-classic.test.ts` cobre precondition, lock, concorrência e format idempotente. |
| Parse/format/parse e graph | `s11-properties.test.ts` gera 24 DAGs reproduzíveis, variando tamanho, dependências, Unicode, newline e BOM; compara definition/task hashes antes/depois do format, ordem topológica, elegibilidade e injeta ciclo garantido. `prd-graph.test.ts` mantém o golden versionado do graph e os diagnostics recursivos. |
| State transitions | `execution-state.test.ts` enumera todos os pares de status de run, task, attempt phase e attempt status, além dos guards de completion e override auditado. |
| Options | O gerador exaustivo percorre as 16 combinações de presença de builtin/profile/PRD/task/CLI para `maxModelCallsPerAttempt`; `effective-options.test.ts` cobre provenance, hashes, aliases, executor/judge e opções de segurança. |
| Progress e resize | `progress.test.ts` cobre extremos, monotonicidade, ratios equivalentes em toda largura útil 1–512 e golden ASCII/Unicode; `dashboard.test.ts` faz resize real no renderer headless de 112 para 48 colunas e prova 100% sem preenchimento prematuro. |
| Usage aggregation | 64 seeds particionam e intercalam deltas de 1–7 calls entre executor/judge/child/tool-model e comparam contra uma única final autoritativa, incluindo call indisponível e todos os agrupamentos; 32 seeds adicionais provam que regressão cumulative falha sem mutar o snapshot anterior. |
| Redaction | 128 seeds colocam canaries em texto, secret keys, bearer e query string, exigem idempotência e preservam somente credential refs não secretas; os testes unitários existentes mantêm cycles, shared objects, JSON e JSONL. |
| Path e command safety | 128 seeds percorrem paths Unicode contidos e, em ciclo, traversal, dot/empty segments, drive, UNC, backslash, ADS, device, whitespace e control byte; argv com metacaracteres só casa como string literal exata. `tool-host.test.ts` acrescenta symlink/junction, atomic writes e settlements. |
| Event replay e version compatibility | 96 streams v1 reproduzíveis, com gaps de sequence, até 40 eventos e campos aditivos, geram snapshot idêntico em replay repetido; producer continua strict e consumer rejeita major v2 desconhecida. |
| Goldens | A mesma matriz executa os arquivos versionados de graph, progress e help/version, além das fixtures PRD v1/v2 e diagnostics cobertas pelas suítes de parser/graph. |

Os geradores são intencionalmente determinísticos: cada falha informa o seed para reprodução, não
usa `Math.random`, rede, provider pago ou relógio externo. Essa matriz fecha somente o nível
unit/property/fuzz/golden. Integration/E2E amplo e segurança adversarial foram fechados separadamente
pelas evidências S11.04 e S11.07 abaixo; plataformas e candidate release continuam respectivamente
em S11.08 e nos gates S12/`BLK-RELEASE`.

S11.04 foi fechada pelo alias focado `bun run test:s11:e2e`: 100/100 testes em 12 arquivos,
924 assertions e zero falhas com Bun 1.3.14. A execução levou 331,37 s no Windows x64 e foi iniciada
somente por `scripts/run-bun-hidden.ps1`, com `CreateNoWindow`, janela oculta, prioridade
`BelowNormal` e logs redirecionados. Nenhum teste existente foi reescrito: o único ajuste necessário
foi estreitar tipos opcionais da fixture S09 sem alterar cenário ou assert. A suíte global e o PTY
não foram executados por esta tarefa.

| Contrato de S11.04 | Prova automatizada focada |
| --- | --- |
| Modos e pacote | `orchestration-runner.test.ts` executa once, loop e Wiggum; `s09-bounded-e2e.test.ts` executa parallel real; `execution-cli.test.ts` prova spellings/precedência; `packaged-vertical-slice.test.ts` atravessa o CLI compilado. |
| Backends embedded/CLI | Os E2E S05 embedded e external atravessam ToolHost/protocolo/evidência/gates; os smokes públicos repetem ambos pela composition root real do CLI. |
| Avaliação | `s06-judge-runner.test.ts` cobre deterministic-only, self e external, `60 -> revisão -> 88`, exhaustion, malformed/transporte e gate bloqueante acima da nota; o smoke do entrypoint repete external no executável público. |
| Change/artifact/skips/no-change | A matriz S06 completa change-only e artifact nomeado imutável; `skip-completion-policy.test.ts` prova skip/fast/required/override sem transformar skip em pass; o runner cobre require/retry/allow no-change. |
| Child/nested | A matriz S09 executa leaf → child → root, falha determinística do child e retomada antes/depois do spawn sem duplicar IDs, attempts ou markers. |
| Git/sandbox | A matriz S09 executa dois worktrees/claims/commits/merge/checkpoints, conflito real fail-closed, retomada pós-integração e sandbox process supervisionado; isolamento forte continua explicitamente externo. |
| Headless/TUI | `execution-cli.test.ts` prova human/JSON e attach TTY-gated pela mesma porta; `dashboard.test.ts` exercita renderer headless, resize e popup. A evidência real já executada `EV-PTY-S08-5` fecha paridade TUI/human/JSON/replay em ConPTY, sem rerun apenas para inflar contagem. |

Esta evidência é local e determinística. Provider/auth pago real, Docker/Podman, PTY Linux/macOS,
matriz multiplataforma e candidate binding continuam em `BLK-AUTH-REAL`, S11.08 e
S12/`BLK-RELEASE` e não reabrem o escopo
de integração local de S11.04.

S11.07 foi fechada pelo alias focado `bun run test:security`: 177/177 testes em 20 arquivos,
1.777 assertions e zero falhas com Bun 1.3.14. A repetição verde levou 51,49 s no Windows x64 e
foi iniciada exclusivamente por `scripts/run-bun-hidden.ps1`, com `CreateNoWindow`, janela oculta,
prioridade `BelowNormal` e stdout/stderr redirecionados. O Biome focado passou nos oito arquivos
TypeScript/JSON tocados. Nenhuma suíte global, scan de dependência/licença/SBOM, provider pago ou
TUI/PTY visível foi executado por esta tarefa; release security continua separado em S11.10.

| Contrato adversarial de S11.07 | Prova automatizada focada |
| --- | --- |
| Secret canaries em env/header/output | `s03-redaction.test.ts` injeta segredo somente no `CommandContext` e exige ausência no SQLite, eventos, report, raw gates e output; `events-redaction.test.ts`, `tool-execution-port.test.ts`, `verification.test.ts` e credentials cobrem env, `Authorization: Bearer`, valores estruturados e outputs bounded. |
| Traversal, symlink e junction | `tool-host.test.ts` rejeita parent/backslash/absolute/drive/UNC, liquida tentativas sem efeito, detecta troca de identidade e escape por symlink/junction; `verification.test.ts` mantém evidência bounded sem seguir escape. |
| Command/argument injection | ToolHost casa executable + argv literal exato, passa metacaracteres `;$(...)&|>` como um único argumento com `shell: false` e nega drift de um byte; execution port e gates preservam os mesmos limites. |
| Completion, PRD e repo maliciosos | `s05-embedded-e2e.test.ts` entrega ao modelo instrução maliciosa no contexto do PRD, lê `AGENTS.md` malicioso como output de tool e depois recebe `TASK_COMPLETE`; marker, task e arquivos permanecem não concluídos. `execution-state.test.ts` mantém `ExecutorOutcome` como alegação sem autoridade. |
| Tool schema abuse e oversized output | ToolHost rejeita campo aditivo de autoridade antes de efeito; strict OpenAI tools rejeitam payload incompatível; `openai-driver-stream.test.ts`, execution port e verification limitam JSON/SSE/eventos/process/raw/artifacts e falham fechado em UTF-8/estrutura malformada. |
| Judge pedindo capacidade/escrita | Backends embedded/external recebem zero tools e nenhum workspace; mesmo uma chamada direta `fs.write` sob regra nominal `dangerous/allow` é negada pelo hard invariant de role `judge`, sem criar arquivo. |
| Unsafe headless `ask` | O default headless nega sem abrir prompt invisível; `headless_ask=allow` só libera quando explícito e o journal exige `auditedOverride: true`. O caminho interativo continua vinculado a request/hash e decisão allow/deny. |
| External effects e idempotência | `tool-call-journal.test.ts` prova intent-before-effect, settlement único, restart, duplicate idempotente, rejeição de argumentos divergentes e `manual-reconciliation/replay=false` para external effect não liquidado. |
| State/event/PRD/YAML corrompido ou excessivo | Schemas fechados e transitions de state rejeitam corrupção; consumer de evento aceita somente adição v1 e rejeita major v2, enquanto ledger recompõe tail JSONL truncado. PRD proíbe aliases, chaves de prototype e UTF-8 inválido; config limita expansão a 50 aliases e retorna `RALPH_CONFIG_YAML_ALIAS_LIMIT` em vez de propagar exceção bruta. |

A primeira execução desta seleção encontrou somente uma expectativa de fixture desatualizada depois
da migração aditiva do ledger v15 (`CURRENT_LEDGER_VERSIONS` ainda terminava em 14); a expectativa
foi alinhada ao schema realmente instalado e a seleção inteira foi repetida. O hardening de produção
introduzido pela auditoria foi o erro estruturado e bounded para expansão excessiva de alias YAML de
configuração. Nenhum vazamento de canary, path escape, shell escape, escrita de judge, completion
indevida ou replay cego apareceu na repetição verde.

S11.05 foi fechada pelo alias focado `bun run test:kill`, que executa somente
`tests/integration/s07-kill-injection-matrix.test.ts` e
`tests/integration/s09-bounded-e2e.test.ts`. No ciclo local Windows x64 com Bun 1.3.14, a matriz
passou 17/17 testes, 519 assertions e zero falhas. Treze desses testes são fronteiras literais de
kill/crash; os quatro restantes exercitam falha de child, integração/claims/worktrees/checkpoints,
conflito Git real e sandbox local necessários para não aprovar a retomada em um caminho artificial.

| Fronteira injetada | Estado antes do resume | Prova depois do resume |
| --- | --- | --- |
| task ativa | task `[~]`, nenhuma próxima task iniciada | mesmo run/task; marker único `[x]`; attempts/model calls/gates iguais ao ledger |
| gates persistidos | primeira attempt e seus gates duráveis | segunda attempt ordinal sem pulo; diff acumulado e counters exatos |
| completion preparada | receipt preparado e marker ainda reconciliável | mesma attempt, sem nova chamada de modelo; uma única completion terminal |
| marker escrito no arquivo | Markdown `[x]`, ledger ainda preparado | reconciliation confirma o hash e commita uma vez |
| evento de marker persistido | marker e evento duráveis, completion pendente | commit reconciliado sem duplicar evento ou marker |
| completion terminal persistida | task já concluída antes do crash | resume não repete executor; run converge com uma única completion |
| tool intent | journal `started` sem settlement | reconciliação read-only/replay autorizada; uma única tool call e um único efeito |
| tool write | efeito e settlement já persistidos | settlement reutilizado; arquivo não é escrito novamente |
| assessment do judge | assessment imutável ligado à primeira attempt | nova attempt/assessment com IDs distintos; retries/revisões/counters não são confundidos |
| child reservado antes do spawn | link e child run duráveis; backend ainda não chamado | o mesmo link/run é usado; leaf → child → root executam uma vez; três evidências/diffs e markers `[x]` |
| child já iniciado | crash na sessão nested depois do worker boundary | os mesmos dois links são retomados pelo child mais profundo; três model calls, três attempts e três markers |
| integração Git persistida | merge e record `passed` duráveis; worktree ainda `integrating` | ancestry é conferida, o merge não é repetido, os mesmos attempts são usados e a segunda integração conclui uma vez |
| event outbox comprometido | task/marker/diff/counters duráveis e rows não publicadas | projeção é reconstruída; zero rows pendentes; event IDs únicos e JSONL idêntico ao ledger |

Os fault points novos são command-owned e inertes sem o port de teste:
`after-child-reserved` ocorre somente depois da reserva transacional e antes da criação do worker;
`after-git-integration-persisted` ocorre depois do settlement Git terminal e antes da transição do
worktree. A fronteira de outbox provoca falha real da projeção após o commit autoritativo e prova a
recuperação pelo ledger, em vez de simular sucesso apenas em memória. Em todos os casos, arquivos e
diffs content-addressed permanecem presentes, IDs não se duplicam e uma task posterior não começa
antes da reconciliação. Esta evidência é local e determinística; não substitui a matriz
multiplataforma de S11.08 nem candidate binding de S12/`BLK-RELEASE`.

S11.09 tem uma suíte própria em `tests/performance/s11-performance.test.ts`, executada por
`bun run test:performance`: 6/6 testes e 67 assertions passaram no baseline local Windows x64 com
Bun 1.3.14. A prova cobre PRD vertical de 750 tasks (5,90 s; budget 30 s), batch máximo de 2.048
eventos com cerca de 8 MiB de output (14,6 ms; heap adicional observado 0 MiB/budget 96 MiB),
retenção raw sob 32 chunks de 40 kB (10,89 s; budget 45 s; máximo determinístico de 4 segmentos e
256 KiB), replay durável de 25.000 eventos (130,2 ms), replay TUI de 20.000 eventos (178,5 ms;
8,3 MiB/budget 128 MiB; projeções de 32 itens e snapshot abaixo de 512 KiB) e oito projetos
isolados com 256 eventos cada (1,47 s). Os limites de tempo são tetos arquiteturais amplos; os
limites de cardinalidade, retenção e memória/snapshot são os gates principais. Este baseline é
deliberadamente local/Windows e não declara performance multiplataforma; plataformas adicionais
precisam de baselines próprios.

S11.08 já possui a definição executável da matriz, mas permanece aberta até os jobs existirem como
runs reais e seus artifacts forem arquivados. `.github/workflows/ci.yml` separa quality x64 de uma
matriz nativa bloqueante com os seis pares declarados: Windows x64/arm64, Linux x64/arm64 e macOS
x64/arm64. Cada entrada instala pelo lockfile, confirma a arquitetura real, executa a mesma seleção
de filesystem/workspace, árvore de processos e signals, keychain fake, worktrees Git, sandbox e PTY/
resize, compila o target nativo, executa o standalone fora do checkout e publica metadata/binário
como artifact classificado. Nenhuma entrada usa `continue-on-error` e nenhum skip é convertido em
pass. Em 2026-07-19, `windows-11-arm` e `ubuntu-24.04-arm` constam como labels standard para
repositórios públicos e privados na
[referência de runners hospedados do GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
portanto a documentação não os rebaixa mais a preview. A
[migração anunciada da imagem Windows ARM](https://github.blog/changelog/2026-06-11-new-runner-images-in-public-preview/)
continua sendo risco real: qualquer transição de `windows-11-arm` para a imagem VS2026 exige novo run
e baseline, nunca herança silenciosa da evidência anterior. Cada receipt passa a vincular o label
pedido, `ImageOS`/`ImageVersion` quando fornecidos pelo runner e o hash exato da própria workflow.
O teste estrutural `tests/unit/ci-evidence-structure.test.ts` impede remover esses bindings ou alterar
silenciosamente o conjunto de seis labels; sua execução ainda integra a prova pendente da matriz.
O teste de workspace inclui agora path Unicode/espaço acima de 260 caracteres.
Esta alteração fecha a configuração pedida pela tarefa, mas não a prova multiplataforma: os seis
jobs e o package/release candidate ainda precisam ser executados e vinculados antes do `[x]`.
O caso local novo de filesystem passou no Windows x64 junto da suíte de workspace: 12/12 testes,
49 assertions e zero falhas (`EV-S11-FS-12`), incluindo a raiz Unicode/espaço com mais de 260
caracteres. Essa prova não é promovida indevidamente a resultado das outras cinco combinações.

S11.06 foi fechada pela suíte focada `tests/hardening/watchdog.test.ts`, executada em processo Bun
oculto e com prioridade reduzida: 8/8 testes, zero falhas e 84 assertions com Bun 1.3.14. A matriz
cobre quiet/slow com heartbeat e processo saudáveis, Retry-After, stream silencioso, reasoning longo,
processo real com CPU/IO e worker real congelado. O caso adicional atravessa literalmente o hard
deadline (`999 ms -> 1000 ms -> 1010 ms`) e prova que sinais positivos não anulam o timeout, mas a
ação destrutiva só ocorre depois de duas probes pós-deadline: `suspect/notify` na primeira e
`stalled/restart-attempt` na segunda. O runtime deixou de fabricar o total de confirmações a partir
de uma única leitura; `confirmations: 1` continua preservando ação imediata.

S11.10 possui agora o gate repetível `bun run test:release-security`. No ciclo local anterior ele
passou os três estágios: `bun audit --json` sem advisory, varredura redigida do source por Gitleaks
sem finding e testes de licença/provenance do OpenCode e das dependências curadas. A primeira execução
do audit encontrou `GHSA-4x5r-pxfx-6jf8` de severidade baixa em `@babel/core@7.28.0`, fixado
transitivamente por `@opentui/solid@0.4.5`; o lockfile passou a resolver o override explícito e
compatível `@babel/core@7.29.7`, após o qual o audit ficou vazio e os 23 testes focados da TUI
continuaram verdes. Os cinco achados iniciais do Gitleaks eram canários sintéticos de testes ou uma
chave determinística não secreta e receberam somente allow-comments locais, sem allowlist ampla de
arquivo/diretório; a segunda varredura retornou zero findings. Depois desse ciclo, a proveniência
OpenCode passou a ter a autoridade estruturada `third_party/opencode/PROVENANCE.json`, que vincula os
sete sources auditados, doze destinations, três patches, licença/hashes e as exceções nominais; o gate
falha para drift, assimetria, dependência ou branding/asset não declarado. O gate atualizado também
removeu o fallback de Gitleaks pelo `PATH`: exige receipt checksum-pinned ou binário+SHA-256 explícitos,
confere versão/hash/report vazio e, no receipt Linux x64, ancora também bytes e SHA-256 exatos do
binário extraído do archive oficial pinado. Cada árvore usa cwd/executável hash-bound e timeout
absoluto; o audit só roda na versão/revisão exatas de Bun 1.3.14 e aceita apenas o objeto de sucesso
vazio observado. Os quatro contratos de licença/proveniência precisam gerar JUnit não vazio, sem
failure/error/skip e com ao menos um caso aprovado por arquivo. O SBOM npm declara Bun
somente como runtime do host; o standalone só pode declarar o Bun embutido depois de validar uma
  curadoria local exata por versão+commit e copiar seu conjunto completo de licença/notices/proveniência.
Nesta edição, a licença raiz MIT foi decidida e a curadoria oficial do Bun `1.3.14` no commit
`0d9b296af33f2b851fcbf4df3e9ec89751734ba4` foi materializada com licença, provenance e receipts
de tamanho/SHA-256; os quatro contratos focados passaram 26/26, sem falhas. S11.10 permanece aberta
até o gate hash-bound atualizado passar novamente sobre HEAD limpo e os artifacts finais vinculados
serem inspecionados depois do package real.

O receipt `security-gates` da CI também passou a content-addressar diretamente, além do workflow e
dos reports gerados, o manifest raiz, `bun.lock`, `THIRD_PARTY_NOTICES.md`, toda a árvore
`third_party`, os implementadores de audit/provenance/SBOM/inventário e os quatro arquivos de teste
que constituem o gate. Assim, o artifact arquivado permite conferir os bytes exatos das autoridades
de compliance sem depender apenas do nome do commit. O contrato estrutural correspondente está em
`tests/unit/ci-evidence-structure.test.ts`; a seleção de estrutura CI/closure passou 7/7 nesta edição.

S11.11 foi fechada pelo harness integral `bun run compat:s10`, executado exclusivamente pelo wrapper
Windows oculto/`BelowNormal` depois de validação mínima 11/11 com 161 assertions, typecheck e build
fresco. O report de `2026-07-19T23:05:54.068Z` passou 91/91 checks, sem regressions ou surface
regressions. Ele comparou `ralph 0.2.0` e `ralph-next 0.1.0-dev.1` reais, executou S01/S03, sondou o
inventário fechado de commands/flags, exercitou human/JSON/aliases e completou coexistência,
inspect/apply/rollback com origem/config/sentinels imutáveis. As suites vinculadas de execution/options,
control-flow, parallel/Git/security e signal/resume terminaram com exit 0.

Os bindings são source
`2835b2f3350755ab3045ad4f2c11b13497a2dfb8bfcefcdc49430800bc07b1f8`, legacy
`ffd6b016713e8754b06ad1c9a2f51d6ba761e7b223bd2083fd1f99c9b0a217ee` e next
`ffcb9d0a51f2e3b9c03cf0696d2cdbf9ee5bcff4285eba36ba702be2b454c4c1`. O relatório mantém
`classification` separado de `assessment` e distingue prova executada real dos smokes opt-in de
provider/auth não autorizados/configurados. Esses smokes continuam `not-executed` em
`BLK-AUTH-REAL`; não são tratados como pass, mas sua ausência honesta não invalida a matriz local de
compatibilidade/migração que S11.11 exigia.

O fechamento estrutural de S11.12 possui agora um único runner fail-closed em
[`scripts/s12-closure.ts`](../scripts/s12-closure.ts). Ele executa o plano global exatamente uma vez
(install pelo lockfile congelado, schemas, lint, typecheck, um único `bun test`, build e smoke),
acrescenta o check determinístico de links Markdown/referências a scripts, redige o JUnit temporário
antes de persistir e então o classifica, captura audit e Gitleaks separadamente e arquiva
stdout/stderr bounded e redigido. O JUnit global precisa ser não vazio, casar com o hash classificado
e conter sentinelas explícitos de supervisor, sample, closure, provenance e SBOM. A sanitização
redige segredos literais e representações XML nomeadas/numéricas, faz post-scan após decodificação e
rejeita qualquer residual antes de escrever o archive. O ledger também valida cada `EV-*` contra o
catálogo e exige catálogo ou link local para `validado-localmente`; as probes Git antes/depois
comparam a origem canônica em memória e arquivam somente seu digest, sem URL. Distribution,
sample e testes de licença/provenance entram
por discovery da suíte global; não são repetidos por aliases focados. O report S10 é copiado e só se
torna vinculado ao run quando `--legacy-binary` e `--next-binary` explícitos casam com seus hashes;
o runner nunca infere nem baixa Ralph v1. O report S10 também precisa usar o mesmo
`scripts/source-fingerprint.ts` e casar com o fingerprint atual; hashes históricos iguais não tornam
um report stale em prova corrente.

Cada step tem hard timeout absoluto e generoso: duas horas para a suíte global, uma hora para build,
vinte minutos para smoke e trinta minutos por padrão. A execução usa `BunProcessSupervisor`, Job
Object com `KILL_ON_JOB_CLOSE` no Windows, grupo de processo nas demais plataformas, cancellation
bounded e shutdown em duas fases. Somente o deadline total encerra a árvore; silêncio ou demora de
processamento não são classificados como stall.

O archive contém `run-manifest.json`, logs, JUnit/classificação, `docs-check.json`, o ledger
R001–R079, blockers com owner/evidence/waiver disposition, receipts de compatibilidade, build,
audit/Gitleaks, binding dinâmico do review R015, `evidence-manifest.json` que envelopa um payload
content-addressed e `SHA256SUMS`. O candidate input precisa ser receipt standalone ou release
manifest Ralph válido; metadata e payloads são conferidos e relidos até a finalização, e
repository/commit/fingerprint
precisam coincidir com HEAD/origin e source estáveis antes de resolver o binding não-waivable. O DAG
core/candidate → source binding → blockers/run manifest → evidence manifest → checksums → completion
receipt evita autorreferência e false-ready após crash intermediário. Gitleaks é aceito apenas por
receipt checksum-pinned oficial ou por
binário/SHA-256 explícitos, sempre com versão 8.30.1 observada e report JSON vazio. A ausência de Git HEAD
imutável, remote, binários de compatibilidade ou qualquer evidence externa preserva
`local-pass/release-blocked`; esse resultado usa exit code `2`, enquanto falha local usa `1`. O
contrato está implementado, mas este item permanece `[ ]` até o comando abaixo produzir e revisar um
archive real. `R015` possui review independente aprovado e só resolve dinamicamente quando o receipt
continua casando exatamente com bytes, SHA-256 e linhas do parser atual. `R063` permanece `parcial`
em `BLK-R063-FORGE`; nenhum waiver foi inventado.

Antes de gravar o completion receipt, o runner relê pela terceira vez a metadata e todos os payloads
do candidato, recalcula o digest efetivo, recompõe inventário/fingerprint do source e, quando o
binding está apto, repete HEAD/status/origin com o mesmo executável Git hash-bound. Qualquer drift
aborta sem autoridade final; a observação final guarda apenas digests e campos não sensíveis. O
completion receipt é schema-validado antes e depois da escrita, cruza status/source/candidate/waivers
e precisa casar com os bytes pretendidos nas inventariações finais.

## Verificação mínima

```text
bun run check:s12 -- --evidence-root artifacts/ci/s11-closure/local-YYYYMMDD-NNN [--legacy-binary <RALPH_V1_EXPLICITO>] [--next-binary <RALPH_V2_EXPLICITO>] [--candidate-artifact <ARQUIVO_CANDIDATO> --candidate-digest sha256:<64_HEX>] [--waiver-artifact <APROVACOES_EXTERNAS_JSON> --waiver-digest sha256:<64_HEX>] [--gitleaks-binary <BINARIO_CANONICO> --gitleaks-sha256 <64_HEX>]
```

O diretório de evidência deve ser novo. Em Windows, invoque esse comando pelo wrapper
`scripts/run-bun-hidden.ps1` quando precisar garantir `CreateNoWindow`, prioridade reduzida e logs
redirecionados; o supervisor aplica `windowsHide: true` a todo child e nunca abre TUI. Sem os flags
de Gitleaks, deve existir o receipt exato `artifacts/ci/tooling/gitleaks-install.json` produzido pelo
instalador checksum-pinned de CI; PATH arbitrário não é fallback.
