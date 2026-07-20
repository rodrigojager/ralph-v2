# 27 — Auditoria e estado de validação S11/S12

## Finalidade e limite desta auditoria

Este documento entrega o inventário pedido por S11.01 e o transfere para o handoff de S12 sem
transformar presença de código ou teste local em promoção. O snapshot foi atualizado em 19 de julho
de 2026 no checkout `C:\Users\Rodrigo\Desktop\ralph-v2`.

A antiga restrição executável foi removida. Evidência local atual: Bun `1.3.14`; `check` 673/673;
integração 149/149; E2E determinístico S11.04 100/100 com 924 asserções; segurança S11.07 177/177
com 1.777 asserções; watchdog 8/8; o smoke PTY real passou
em três execuções consecutivas e a matriz Windows ConPTY S08.12 passou 5/5 com 34 verificações;
properties/fuzz/goldens S11.03 passaram 111/111 com 5.205 asserções; compatibility source-only 5/5;
addendum S03 15/15; build e smoke nativo Windows x64 verdes. O harness integral S10 passou 91/91,
sem regressions ou surface regressions, comparando `ralph 0.2.0` e `ralph-next 0.1.0-dev.1` reais e
executando coexistência, inspect/apply/rollback e as suites vinculadas. Smokes reais de provider/auth,
packaging, install/update de artifact de release, matriz multiplataforma, assinatura e promoção não
foram executados. Separadamente, `EV-S12-DIST-8` validou o lifecycle local de distribuição com
fixtures `nightly`/`*-dev.1` unsigned: 8/8 testes, 91 asserções e zero falhas em 3,71 s.
O sample S12.08 também passou sua integração executável local focada: 1/1 teste, 59 asserções e zero
falhas em 41,47 s.

O [ledger executável por R-ID](18-matriz-de-rastreabilidade.md#ledger-executável-s11-por-requisito)
é a fonte atual para distinguir prova local, cobertura parcial e blocker. Nas subseções históricas
abaixo, “prova pendente” deve ser lido como o residual explicitamente listado naquele ledger, não
como negação dos testes locais que agora passaram.

Consequências:

- nenhuma linha R001–R079 recebe `pass` automaticamente sem vínculo à prova exata exigida;
- um arquivo, schema, branch de código ou teste existente é apenas uma superfície candidata à prova;
- resultados locais comprovam apenas o checkout, host e escopo executados;
- o standalone nativo Windows x64 foi construído e exercitado localmente, mas não constitui promoção,
  assinatura, instalação nem suporte de plataforma sem candidate binding, hashes e evidence de release;
- o runner estrutural de S11.12 foi implementado, mas nenhum novo archive foi executado nesta edição;
- esta auditoria não fecha S11/S11.12, não promove S12 e não substitui
  [a matriz normativa](18-matriz-de-rastreabilidade.md) nem
  [os release gates](26-release-gates-e-handoff-s12.md).

## Vocabulário de estado

Os estados de implementação e de prova são dimensões diferentes:

| Estado | Significado estrito |
| --- | --- |
| `implementado-estaticamente` | Há contratos e caminhos de código identificáveis que expressam o requisito. Não significa que compilem, executem ou se componham corretamente. |
| `validado-localmente` | Há resultado executável no checkout/host indicado; não implica matriz externa nem release. |
| `parcial` | Há superfície relevante, mas resta integração entre módulos, decisão externa, caminho operacional ou fechamento estático conhecido. |
| `prova-executável-diferida` | A evidência mínima exata da matriz ainda não foi produzida ou vinculada ao candidato. |
| `bloqueado-por-decisão` | O código não pode resolver sozinho uma escolha do proprietário, identidade de publicação ou política de confiança. |

Um grupo pode, portanto, estar `implementado-estaticamente` e simultaneamente ter toda a sua
`prova-executável-diferida`. `Parcial` nunca deve ser reinterpretado como percentual de aprovação.

## Cobertura integral R001–R079

Os grupos abaixo cobrem, sem lacunas nem sobreposição ambígua, os intervalos
R001–R004, R005–R009, R010–R020, R021–R026, R027–R040, R041–R043, R044–R055,
R056–R060, R061–R065, R066–R070, R071–R075 e R076–R079.

### Grupo A — autoridade do comando e fronteira do agente: R001–R004

**Estado estático:** `implementado-estaticamente`.

**Superfícies atuais:**

- `packages/orchestration/src/runner.ts`, `scheduler.ts`, `state-store.ts` e
  `command-runtime-ports.ts`: seleção de tarefa, lifecycle, transições e ports comandadas;
- `packages/tool-host/src/host.ts`, `permissions.ts`, `journal.ts` e `registry.ts`: autorização,
  intent-before-effect e settlement de tools;
- `apps/ralph-cli/src/tool-execution-port.ts` e `tool-journal-adapter.ts`: composição do ToolHost
  com journal persistido sem entregar o ledger ao modelo;
- `packages/verification/src/evaluation.ts` e `packages/orchestration/src/evaluation.ts`: decisão
  de conclusão fora do texto emitido pelo executor;
- `third_party/opencode/`: snapshot e mapa de adaptação curada, separado da orquestração Ralph.

**Leitura por requisito:** R001 e R002 possuem fronteiras command-owned identificáveis; R003 possui
workspace TypeScript/Bun e scripts de build/package; R004 mantém a orquestração Ralph separada do
OpenCode. A leitura não prova que nenhum caminho alternativo viole essas fronteiras em runtime.

**Prova local atual:** `EV-S11-E2E-100` atravessa a composition root, pacote compilado, ToolHost,
evidência/gates e completion comandada nos backends embedded/CLI; `EV-S11-SEC-177` trata completion
do modelo/PRD/repo como alegação, cobre
allow/deny/ask, nega shell/argv divergente e escrita do judge, e classifica external effect não
liquidado como reconciliação manual sem replay. Composição do artifact, revisão independente e
candidate binding continuam diferidos.

### Grupo B — providers, autenticação, executor e judge independentes: R005–R009

**Estado estático:** `implementado-estaticamente`.

**Superfícies atuais:**

- `packages/providers/src/{contracts,registry,router,runtime,catalog,models-dev,curated}.ts`;
- `packages/credentials/src/{contracts,manager,oauth,os-keychain-secret-store,environment-secret-store,redaction}.ts`;
- `packages/openai-driver/src/{driver,protocol,device-auth,stream}.ts`;
- `packages/model-drivers/src/{embedded-backend,external-cli-backend,embedded-judge-backend,external-judge-backend,provider-stream-adapter}.ts`;
- `apps/ralph-cli/src/s04-services.ts`, `s05-services.ts` e `profile-form.ts`;
- `packages/domain/src/judge.ts` e os schemas públicos de provider/model/profile/usage em `schemas/`.

**Leitura por requisito:** R005 possui catálogo/adaptação curada; R006 separa perfis e backends por
papel; R007 modela API key, variável de ambiente e credencial segura; R008 tem fluxo ChatGPT/Codex
embutido sem depender do executável `codex`; R009 preserva backend CLI externo opcional.

**Prova local atual:** `EV-S11-E2E-100` executa os backends embedded e CLI externo, inclusive pelos
entrypoints públicos, e separa executor de judge external/self em chamadas e perfis próprios.
`EV-FAKES-24` cobre OAuth/browser/device/refresh e processos sem rede paga. Keychains reais dos três
sistemas, conta ChatGPT Plus/Pro, API real opt-in, quota e elegibilidade permanecem em
`BLK-AUTH-REAL`; nenhuma chamada paga é afirmada por esta auditoria.

### Grupo C — PRD v2, vertical slices, parser e autoria externa: R010–R020

**Estado estático:** `implementado-estaticamente`.

**Superfícies atuais:**

- `packages/prd/src/{parser,markdown,leaf,contracts,graph,marker,format,classic,authority}.ts`;
- `examples/PRD-v2-exemplo.md` e `examples/subprd-v2-exemplo.md`;
- `skill-contract/ralph-loop-prd-generator/`;
- `skills/ralph-loop-prd-generator/SKILL.md`, `assets/`, `references/` e `agents/openai.yaml`;
- `schemas/prd-document.schema.json`, `compiled-prd-graph.schema.json`,
  `classic-prd-document.schema.json`, `prd-migration-report.schema.json` e
  `marker-update.schema.json`;
- `docs/07-prd-v2-subprds-e-skill.md` e ADR `0005-prd-v2-compiler-contract.md`.

**Leitura por requisito:** R010–R013 estão representados pelo formato humano e pela skill de slices;
R014 e R015 pelo parser CommonMark/leaf tokens e contratos; R016 pelo marker transacional; R017
pelo adapter clássico e migração; R018 pelo graph recursivo; R019 pela autoridade `external-skill` e
ausência intencional de autoria no runtime; R020 pela resolução estrita de children antes da run.

**Prova local atual:** `EV-S11-PROP-111` cobre parse/format/parse, 24 DAGs/ciclos gerados,
preservação byte a byte do marker, graph/goldens e diagnostics; `EV-S11-SEC-177` acrescenta alias
YAML proibido, chaves de prototype, UTF-8 inválido e contexto PRD malicioso sem autoridade de
completion. O forward test da skill e a migração mock/source também estão verdes no ledger.
Permanece diferido o vínculo ao candidate; `EV-S10-COMPAT-91` executou a migração contra um Ralph
clássico real no host local, mas essa prova não substitui validator, package ou install drill do
artifact promovível.

R015 está `validado-localmente`: além dos testes de leaf tokens, o review estático independente está
registrado nos receipts legível e JSON em `docs/reviews/r015-parser-static-review.*`, com reviewer,
data, bytes, linhas e source digest. O closure não confia apenas nesse texto: recalcula a identidade
do parser e só observa `BLK-R015-REVIEW` como resolvido quando o receipt continua exatamente atual.

### Grupo D — children, isolamento entre projetos e retomada: R021–R026

**Estado estático:** `implementado-estaticamente`; a reconciliação final da integração foi relida no
checkout consolidado e não deixou achado P0/P1 estático conhecido.

**Superfícies atuais:**

- `packages/domain/src/child.ts` e `packages/orchestration/src/child-scheduler.ts`;
- integração recursiva em `packages/orchestration/src/runner.ts`;
- `packages/persistence/src/{child-runs,child-run-links-migration,leases,execution-store}.ts`;
- `packages/orchestration/src/{run-lock,recovery-manifest,recovery-acceptance,revision-recovery,baseline}.ts`;
- `packages/persistence/src/{workspace,paths,ledger}.ts`;
- projeção root/child/aggregate em `apps/ralph-cli/src/tui-services.ts`.

**Leitura por requisito:** há contratos para pai concluir somente após receipt terminal reconciliado
(R021), vínculo/supervisão de child (R022), identidade e locks por workspace (R023), descoberta de
retomada (R024), prioridade ao child profundo (R025) e manifest de alterações parciais (R026).
O worker `child-run` usa PID/start-token e duas observações IPC independentes — heartbeat periódico
recebido e ping semântico solicitado —, mas contabiliza uma perda compartilhada do transporte como
uma única família negativa; relê progresso do vínculo atual no ledger e não trata ausência de
progresso como perda de ownership quando processo e canal continuam vivos. `restart-attempt` encerra
a sessão anterior, conserva run/task/diff e reentra pela folha interrompida com budget de restart
reconstruído dos eventos, sem cobrar novamente a unidade de `maxTasks` já consumida.

**Prova local atual:** `EV-S11-KILL-17` executa child completo/falho, árvore aninhada, kill antes do
spawn e depois da criação da sessão nested, retomada pelo child mais profundo, múltiplos projetos e
diff/evidence reaparecendo com os mesmos link/run IDs e counters. A prova passou 17/17 com 519
asserções no Windows x64. Binding ao candidate final e repetição multiplataforma continuam pendentes;
a mera existência de leases e receipts, isoladamente, não é tratada como prova.

### Grupo E — evidências, gates, judge e revisões limitadas: R027–R040

**Estado estático:** `implementado-estaticamente`.

**Superfícies atuais:**

- `packages/domain/src/judge.ts` e `packages/evaluation/src/{contracts,bundle,evaluator}.ts`;
- `packages/verification/src/{evidence,evaluation,gates,gate-registry,gate-contracts,artifact-contract,applicability}.ts`;
- `packages/orchestration/src/{evaluation,judge-attachments,revision-recovery,options,deadline}.ts`;
- `packages/persistence/src/{evidence-store,judge-store,execution-store}.ts`;
- `packages/model-drivers/src/{embedded-judge-backend,external-judge-backend}.ts`;
- `schemas/{evidence-bundle,judge-assessment,judge-output,judge-rubric,evaluation-policy,completion-decision}.schema.json`;
- configuração/CLI em `packages/commands/src/`, `apps/ralph-cli/src/tui-settings.ts` e
  `packages/tui/src/settings-palette.ts`;
- regras autorais `change-only`/artifact na skill e em `packages/prd/src/contracts.ts`.

**Leitura por requisito:** R027–R029 têm modos deterministic-only/self/external/manual e contrato
compartilhado; R030–R034 têm score, parecer, threshold, budgets e contadores separados; R035 mantém
gate bloqueante acima da nota; R036–R037 modelam skips e limites; R038–R040 preservam modos honestos
de mudança/artifact e exigem planejamento prévio da prova.

**Prova local de segurança:** `EV-S11-SEC-177` comprova que o judge embedded recebe zero tools e
nenhum workspace, o external roda read-only em cwd isolado e uma tentativa direta de `fs.write`
continua negada pelo hard invariant de role, mesmo sob regra nominal `dangerous/allow`.

**Prova local atual:** `EV-S11-E2E-100` cobre deterministic-only/self/external, score
`60 -> revisão -> 88`, exhaustion, judge malformado, retry de transporte, gate falho com score 100,
skips/fast/required/override, no-change, change-only e artifact nomeado imutável. As avaliações são
fixtures determinísticas/read-only; provider real e vínculo ao candidato permanecem diferidos.

### Grupo F — watchdog e supervisão de children: R041–R043

**Estado estático:** `implementado-estaticamente`.

**Superfícies atuais:**

- `packages/domain/src/watchdog.ts`;
- `packages/orchestration/src/watchdog-runtime.ts` e integração em `runner.ts`/`child-scheduler.ts`;
- `packages/supervisor/src/{watchdog,watchdog-monitor,worker-supervisor,worker-runtime,process-identity}.ts`;
- `packages/persistence/src/leases.ts` e eventos em
  `packages/telemetry/src/watchdog-events.ts`;
- projeções em `apps/ralph-cli/src/tui-services.ts` e `packages/tui/src/state.ts`.

**Leitura por requisito:** os estados, sinais, confirmações, deadlines, budgets de restart e heartbeat
de child existem como contratos/caminhos (R041–R043). Isso não demonstra calibração correta de
silêncio legítimo contra travamento.
`enabled: false`, global ou por fase, desarma deadlines e ações do watchdog; a lease continua
separadamente condicionada à identidade exata e liveness recente. Uma ação destrutiva exige nova
amostra, quorum ainda `stalled`, cancelamento dirigido da subtree, grace e confirmação de encerramento
antes de liberar a fronteira. `restart-attempt`, `cancel` e `stop-run` deixam de convergir para o mesmo
resultado: somente a primeira ação cria nova sessão dentro do budget persistido.

**Prova pendente:** `prova-executável-diferida` para worker congelado, heartbeat perdido, processamento
lento, reasoning silencioso, retry-after, build demorado, PID reuse, restart/exhaustion e monitoramento
de child. A matriz de falsos positivos é um blocker explícito de S11.

### Grupo G — TUI, usage, progresso, logs e engine output: R044–R055

**Estado estático:** `implementado-estaticamente`.

**Superfícies atuais:**

- `packages/tui/src/{runtime,dashboard,view,state,event-client,event-stream,progress,text-width,settings-palette,provider-palette,theme,i18n}.ts`;
- `apps/ralph-cli/src/{tui-services,tui-settings,main}.ts`;
- `packages/telemetry/src/{events,logs,output,usage,redaction}.ts`;
- `packages/persistence/src/{ledger,raw-streams}.ts`;
- `packages/model-drivers/src/{file-raw-capture,provider-stream-adapter,incremental-redactor}.ts`;
- schemas de `event-envelope`, `token-usage`, `workspace-status` e records de run/task/attempt.

**Leitura por requisito:** R044 tem projeção de status; R045 separa usage reportada/derivada/estimada/
indisponível; R046–R050 têm métrica completed/total, barra responsiva e escopos child/aggregate;
R051–R053 têm activity, logs, output normalizado, leitura bounded das capturas `raw:model` e dos
stdout/stderr persistidos para external CLI, limitada aos run IDs do root/children anexados e aos
campos estruturais conhecidos de seus envelopes, sem busca recursiva em payload arbitrário; offsets
live usam LRU determinística bounded. R054 tem paleta de settings e popup pesquisável de
provider/model/capabilities/auth com lifecycle OAuth e revoke explícito; R055 tem tema próprio e
licenças OpenTUI/SolidJS separadas. O bootstrap percorre páginas por high-water sem formar um array
global de eventos e a task/attempt exibida é selecionada dentro do escopo durável correto.
Uso/custo possui settlement por `callId`: parcial nunca é promovido a final, `unavailable` não satisfaz
capability reportada/estimada, counters são persistidos antes de falha de policy e budgets de token e
custo acumulam por task através de fallbacks, Wiggum e revisões. Custo derivado exige o vetor completo
das métricas aplicáveis provado pelo snapshot de capability/modelo; partições de cache inconsistentes
ou métricas positivas excluídas tornam pricing indisponível em vez de inventar zero.

**Prova local atual:** `EV-S11-E2E-100` repete o dashboard headless junto dos mesmos runs/relatórios
human/JSON exercitados pelo CLI. `EV-S11-PROP-111` passou 111/111 e cobre larguras extremas, ratios
equivalentes, resize headless real, aggregation de usage por call/attempt/task/child e goldens;
`EV-PTY-S08-5` cobre TTY/ConPTY real, teclado, resize, streams variados,
usage ausente/reportado, popup mutável apply/save, close/background/reattach, Ctrl+C e attach/replay
imutável com paridade TUI/human/JSON/replay. `EV-S11-SEC-177` acrescenta canaries ausentes de
ledger/event/report/raw e limites independentes de JSON/SSE/process/raw/artifact. Continuam
diferidos somente PTY Linux/macOS,
provider/auth real, review visual de release e vínculo ao artifact candidato.

### Grupo H — paridade CLI/headless, attach/replay e fronteira do provider: R056–R060

**Estado estático:** `implementado-estaticamente`.

**Superfícies atuais:**

- `packages/commands/src/{command-registry,parser,handlers,help,settings,settings-command,config-transfer}.ts`;
- `packages/persistence/src/config.ts` e `apps/ralph-cli/src/config-editor.ts` para mutações de
  config com escopo explícito, preview value-free, leitura bounded/identity-checked, commit atômico,
  export redigido e composição de editor sem shell;
- `packages/commands/src/{catalog-handlers,profile-runtime,operational-inspection}.ts`;
- `packages/tui/src/{settings-palette,provider-palette}.ts` e
  `apps/ralph-cli/src/{tui-settings,tui-services}.ts` compartilham command models/ports e mantêm
  attach/replay read-only;
- `packages/telemetry/src/{events,output,logs}.ts`, `packages/persistence/src/raw-streams.ts` e
  `apps/ralph-cli/src/tui-services.ts`;
- contracts de backend em `packages/orchestration/src/backend.ts` e adapters em
  `packages/model-drivers/src/`.

A auditoria mecânica somente leitura da superfície pública encontrou 84 entradas canônicas em
`COMMAND_REGISTRY`; `CliCommand`, a resolução longest-prefix de nomes/aliases e as projections
bounded de completion/command palette agora derivam desse catálogo. Aliases e compatibilidade ficam
visíveis nessas projections e no help, enquanto shells/renderers concretos não mantêm uma segunda
lista. O switch de `handleCommand` possui fronteira `never`, sem comando canônico órfão. Allowed
options e regras posicionais continuam explícitas e dependem de prova posterior. A composition root
fornece as portas especializadas observadas pelos handlers. Help human
e JSON e documentação foram reconciliados com o parser atual: `attach`/`replay` são TUI
interativa read-only, enquanto `status run`, `events`, `logs tail` e `report show` são os
equivalentes headless. Flags antigas não reconhecidas deixaram de ser anunciadas, passthrough livre
após `--` está documentado como indisponível e profiles CLI externos usam `--cli-arg` repetível.

O catálogo fonte de `scripts/generate-schemas.ts` declara 59 outputs. O gerador materializou os 59 e
`schemas:check` confirmou nomes e conteúdos no ciclo local atual. Essa prova vale para a árvore de
source verificada; não é prova de package/release.

**Leitura por requisito:** R056 possui superfícies CLI e TUI orientadas pelos mesmos command models,
incluindo equivalentes diretos para provider/model/auth e config unset/edit/import/export; R057
modela human/JSON/JSONL; R058 mantém
run separada do renderer; R059 separa eventos normalizados, raw refs e conteúdo efetivamente lido
do store bruto com cap, vínculo ao evento de um run anexado, rejeição de link/junction e conferência
de identidade pelo descritor;
R060 mantém provider atrás de ports sem permissão de alterar state/policy. API keys
atravessam somente um input one-shot mascarado até o credential service, sem argv/state/event, e o
método environment transporta apenas o nome da variável. Fechar/destruir a paleta invalida inputs
one-shot pendentes e impede que uma operação enfileirada os consuma depois do fechamento. Writers de
profile revalidam o grafo efetivo sob o lock da camada mais recente; saves globais da TUI recompõem
também o workspace ativo quando disponível.

**Prova local relevante:** `EV-S11-E2E-100` cobre human/JSON, attach TTY-gated/read-only, renderer
headless, entrypoints embedded/CLI e provider adversarial; em conjunto com `EV-PTY-S08-5`, já
executado, prova que TUI/human/JSON/replay convergem sem repetir PTY apenas para inflar contagem.
`EV-S11-SEC-177` cobre human/JSON/JSONL redigido, headless `ask` que nega
por default e só permite override explícito/auditado, e provider adversarial que recebe texto
malicioso de PRD/repo e alega `TASK_COMPLETE` sem concluir a task. Candidate binding e os demais
residuais de paridade operacional permanecem separados desta prova de segurança.

### Grupo I — paralelismo, Git, checkpoints, sandbox e segredos: R061–R065

**Estado estático:** `implementado-estaticamente` para a composição command-owned de paralelismo,
integração Git, checkpoints, sandbox e security. A revisão independente final não encontrou bypass
P0/P1 conhecido no checkout consolidado.

**Superfícies atuais:**

- `packages/domain/src/parallel.ts`;
- `packages/orchestration/src/{parallel-runner,parallel-scheduler,parallel-capacity,parallel-claims,claim-scopes}.ts`;
- `packages/orchestration/src/{git-runtime,checkpoints,sandbox-runtime,sandbox-supervisor,security-runtime}.ts`;
- `packages/persistence/src/{resource-claims,git-state,checkpoint-store,sandbox-state,security-audit}.ts`;
- `packages/commands/src/checkpoint-commands.ts` e handlers/registry do modo parallel;
- segurança complementar em `packages/tool-host/src/{path-resolver,permissions}.ts`,
  `packages/verification/src/path-safety.ts` e redactors de credentials/telemetry/model streams.

**Leitura por requisito:** R061 possui scheduler, capacity, claims, worktrees e encadeamento final
revisto pelo comando; R062 modela conflito como pausa em vez de resolução destrutiva; R063 tem
estratégias Git/checkpoint/rollback; R064 tem policies, adapters e barreira workspace-wide paginada
de sandbox; R065 tem várias fronteiras de redaction e armazenamento indireto de segredo.

**Prova local atual:** `EV-S11-E2E-100` executa parallel com dois worktrees, claims, commits, merge,
checkpoints, conflito real, retomada pós-integração e sandbox process supervisionado.
`EV-S11-SEC-177` cobre canaries env/header/output, traversal, absolute/drive/
UNC, troca de identidade, symlink/junction, argv literal sem shell, schema abuse, output bounded e
external effect não liquidado sem replay. `EV-S09-E2E-7` e `EV-S11-KILL-17` cobrem a fatia local de
parallel/Git/conflict/crash/process sandbox. Docker/Podman, isolamento forte, candidate binding e
repetição multiplataforma continuam diferidos; esta validação local não autoriza chamar o produto de
seguro em produção.

R063 permanece `parcial`: os fluxos Git locais foram exercitados, mas PR/forge remoto ainda exige
evidence, decisão explícita ou waiver candidate-bound em `BLK-R063-FORGE`.

### Grupo J — proveniência, compatibilidade, distribuição e plataformas: R066–R070

**Estado estático:** R066–R070 estão `implementado-estaticamente`. Isso fecha código, contratos,
matriz explícita e composição fail-closed; não promove artifact, plataforma ou release sem os
schemas materializados, inputs do proprietário e provas executáveis registrados abaixo.

**Superfícies atuais:**

- `third_party/opencode/{LICENSE,PROVENANCE.json,UPSTREAM.md,copied-files.md,patches.md}`,
  `THIRD_PARTY_NOTICES.md` e licenças de OpenTUI/SolidJS;
- `docs/compatibility/`, `packages/commands/src/legacy-migration.ts`,
  `task-operations.ts`, `operational-inspection.ts` e `docs/22-migracao-ralph-v1-s10.md`;
- `packages/distribution/src/{contracts,manifest,loader,installer,activation,paths,promotion,signature}.ts`;
- `packages/distribution/tests/{release-fixture,standalone-lifecycle.test}.ts` e o alias
  `test:s12:distribution`;
- `apps/ralph-launcher/src/main.ts`;
- `scripts/{build,build-artifact,package-release,package-npm,release-source,release-files,release-archive,release-sbom,release-promotion}.ts`;
- `docs/23-distribuicao-instalacao-update-e-rollback-s12.md` e
  `docs/26-release-gates-e-handoff-s12.md`;
- `.github/workflows/ci.yml`, com quality x64 e matriz nativa bloqueante para os seis pares
  Windows/Linux/macOS x64/arm64, e `tests/integration/workspace.test.ts`, incluindo path
  Unicode/espaço acima de 260 caracteres.

**Leitura por requisito:** R066–R067 possuem snapshot, atribuição e inventário positivo/negativo;
R068 tem comandos/migração/matriz de compatibilidade; R069 possui contratos e caminhos de
install/update/rollback/uninstall lado a lado; R070 declara seis targets e contém cuidados de paths/
processos para Windows e demais sistemas. `ReleaseSupportPolicy` v1 mantém os seis visíveis,
separa inclusão de suporte testado e vincula capabilities/hash ao manifest v2 e promotion record v3.
A implementação de release falha fechada para stable sem policy explícita, assinatura e promoção.
O contrato CI não usa `continue-on-error` nem converte skip em pass; ele instala pelo lockfile,
confirma a arquitetura, executa filesystem/process/keychain/Git/sandbox/PTY, compila e fumaça o
standalone nativo e arquiva evidence por target. O receipt vincula também o label pedido,
`ImageOS`/`ImageVersion` quando expostos e o hash da workflow, impedindo que uma migração de imagem
herde silenciosamente o baseline anterior. `EV-S11-FS-12` passou localmente no Windows x64,
mas a presença do workflow não prova os outros cinco pares: `BLK-MULTIPLATFORM` permanece.
O alias standalone opt-in também remove seus dois paths por rename para quarentena determinística,
confere identidade/link count/descritor/hash depois do movimento e só então executa unlink. O retry
confirmado reconhece uma quarentena receipt-bound deixada antes do unlink; estados ambíguos são
preservados. Como nas demais operações locais portáveis, isso não cria isolamento forte contra um
mutador concorrente com a mesma autoridade do processo, e nenhuma promessa inclui `PATH` ou um Ralph
clássico fora do install root.
O receipt de controle seguinte passou a ser publicado atomicamente e sua presença/quarentena/hash
integram o snapshot e o plan hash. Na direção inversa, um pending `N+1` de install-recovery só é
descartado se a reconstrução canônica a partir de `N` produzir exatamente os mesmos bytes; assim uma
geração órfã não ocupa silenciosamente o próximo número nem um receipt alheio é apagado por nome.

**Prova local atual:** `EV-S10-COMPAT-91` executou o harness integral com dois binários explícitos,
regulares e distintos: 91/91 checks, zero regressions, zero surface regressions, source e binários
imutáveis, S01/S03, aliases/flags, human/JSON, coexistência, inspect/apply/rollback e suites de
skips/control-flow/parallel/Git/security/signal/resume verdes. O report versionado registra source
`2835b2f3350755ab3045ad4f2c11b13497a2dfb8bfcefcdc49430800bc07b1f8`, legacy
`ffd6b016713e8754b06ad1c9a2f51d6ba761e7b223bd2083fd1f99c9b0a217ee` e next
`ffcb9d0a51f2e3b9c03cf0696d2cdbf9ee5bcff4285eba36ba702be2b454c4c1`.

`EV-S12-DIST-8` executou handlers/CLI e funções públicas reais de distribuição sobre payloads
sintéticos local-contract-only: install dry-run/local/HTTPS fake sem rede, tamanho/hash/metadata e
tamper, check/update preservando launcher e versão anterior, downgrade/schema, rollback receipt-bound,
launcher failure/repair-required, recovery `planned|staged|verified|activated`, journal e uninstall
por scheduler/helper preservando state/config/credential ref/Ralph clássico/sentinela. A tentativa
inicial em TEMP de `C:` foi corretamente recusada por `RALPH_INSTALL_ROOT_IS_CHECKOUT`, pois o host
tem `C:\.git`; o rerun com `TEMP|TMP|TMPDIR` em `D:\Temp\ralph-v2-distribution-tests` passou 8/8,
91 asserções, em 3,71 s. Isso é prova do checkout/host e não evidence de artifact, licença, signer,
target support ou promoção.

**Prova pendente:** `prova-executável-diferida` para provenance contra checkout limpo, SBOM real,
archives determinísticos, packages, repetição de install/update/rollback/uninstall sobre o artifact
candidato e os seis targets. Nenhum artifact promovível desta integração foi empacotado, assinado ou
publicado.

### Grupo K — replay versionado, backpressure, métrica honesta e snapshot imutável: R071–R075

**Estado estático:** `implementado-estaticamente`; R072 permanece especialmente dependente de prova
de carga. R074 é verificável por inspeção do path, mas não implica prontidão do produto.

**Superfícies atuais:**

- `packages/telemetry/src/{events,filesystem-safety}.ts`,
  `packages/persistence/src/{ledger,raw-streams,telemetry-policy}.ts`,
  `packages/model-drivers/src/file-raw-capture.ts` e
  `packages/tui/src/{event-stream,event-client,state}.ts` para R071/R072;
- `packages/tui/src/progress.ts` e `apps/ralph-cli/src/tui-services.ts` para separar phase/atividade
  da barra completed/total em R073;
- este checkout, `README.md` e `docs/00-contexto-e-objetivos.md` para R074;
- `packages/domain/src/execution.ts`, `packages/orchestration/src/options.ts`, persistência do
  `EffectiveRunOptions`, `apps/ralph-cli/src/tui-settings.ts` e ADR
  `0008-snapshot-imutavel-e-fronteira-tui-s06-s08.md` para R075.

Retenção e append de raw compartilham uma lease cross-process por root, ligada a
PID/start-token/hostname/heartbeat e recuperável somente após morte ou PID reuse comprovados. Cada
evento recebe snapshot durável de `event_retention`; `null` explícito, legado desconhecido e duração
finita não colapsam. Paths e handles são revalidados contra ancestry, symlink/junction, hard link e
troca de identidade; remoção usa quarentena com restauração fail-closed, e raw de run só fica elegível
depois que eventos/outbox correspondentes deixarem de existir.

Residuais P2 conhecidos: sidecars/temps/quarantines não autoritativos deixados por crash ainda não
possuem sweep automático; receipt legado já malformado exige intervenção manual porque não carrega
identidade reclamável; e o probe de start-token no Windows invoca PowerShell quando precisa decidir
sobre owner expirado. Nenhum deles autoriza reclaim heurístico ou altera a prova executável pendente.

**Prova local atual:** `EV-S11-PROP-111` cobre 96 streams v1 aditivos com replay idêntico e rejeição
de major desconhecida, barra/resize e snapshot de opções; `EV-PERF-6` cobre event storm,
backpressure/retention, replay longo e memória bounded; `EV-PTY-S08-5` cobre reconnect e attach/replay
imutável. `EV-S11-SEC-177` acrescenta schema state fechado, major v2 rejeitado, tail JSONL truncado
reconstruído e bounds de PRD/config/provider JSON. Permanecem diferidos candidate binding e repetição
multiplataforma. R074 recebe somente a prova de workspace/path registrada no ledger, não prontidão
geral do produto.

### Grupo L — operações standalone de evidência e julgamento: R076–R079

**Estado local:** `validado-localmente` pela matriz focada
`tests/integration/s06-command-evidence.test.ts` (3 testes, 69 asserções, zero falhas). Isso não
alega chamada real de provider externo: os backends da matriz são determinísticos e read-only.

**Superfícies atuais:**

- `packages/domain/src/command-evidence.ts`: seletores tipados, requests, reports, receipts e
  lifecycle das operações `verify`/`judge`;
- `packages/persistence/src/{ledger,command-operations}.ts`: migration e operações duráveis com
  eventos command-owned;
- `packages/orchestration/src/command-evidence-runtime.ts`: resolução exata de evidence/source,
  reexecução de gates sem executor e avaliação standalone sem aplicação de revisão;
- `packages/commands/src/{parser,command-registry,help,handlers}.ts`: superfície CLI, precedência,
  formatos human/JSON e dispatch explícito;
- `packages/orchestration/src/runner.ts`: materialização compartilhada da source ad hoc persistida;
- `docs/{02-escopo-e-modos-de-trabalho,04-cli-comandos-flags-e-precedencia,
  09-evidencias-gates-judge-e-revisoes,10-persistencia-retomada-watchdog-e-filhos,
  11-eventos-telemetria-logs-e-relatorios,17-contratos-e-schemas}.md`.

**Leitura por requisito:** R076 foi exercido sem executor/ToolHost e com igualdade de task/marker;
R077 separou `external` default de `self` explícito, preservou parecer/nota/receipt e recusou backend
mutante; R078 cobriu seletores válidos, ausentes e ambíguos sem scan silencioso; R079 verificou a
source ad hoc persistida sem inventar PRD, marker ou gates. A matriz também cobriu hashes/tamanho/ref
do receipt, objeto removido/adulterado, eventos, transição terminal ilegal e formatos human/JSON.
Smokes de provider real continuam separados e opt-in.

## Delta de implementação — composição worker e controle do run

Uma releitura posterior conectou superfícies que antes estavam apenas
definidas:

- `apps/ralph-cli/src/{worker-composition,worker-adapters,worker-main,main}.ts` compõe executor,
  judge, efeito de tool, gate e Git nos workers tipados;
- `packages/orchestration/src/{backend,runner}.ts` e
  `packages/evaluation/src/contracts.ts` transportam `workspaceId` e a separação entre execution
  root e control root, além das factories de gate e Git;
- `packages/supervisor/src/{worker-protocol,worker-runtime,worker-supervisor,worker-operations,
  worker-entrypoint,run-control}.ts` contém reverse RPC role-bound, rejeição de resultado com RPC
  pendente, adapters built-in e o canal por bearer ligado à identidade do run;
- `apps/ralph-cli/src/{s04-services,s05-services}.ts` liga OpenRouter embedded a executor e judge,
  mantendo assinatura ChatGPT exclusiva de OpenAI e providers sem driver fail-closed;
- `apps/ralph-cli/src/s07-services.ts` compõe stop gracioso/force, fallback sob writer lease e
  context rotation em fronteira do runner;
- `apps/ralph-cli/src/{durable-process-owner,process-output-store}.ts`, o journal binding do
  `ToolHost` e `packages/orchestration/src/tool-reconciliation.ts` compõem ownership independente,
  output live/raw e probe/reattach exato de `process.exec`.

Child orchestration continua command-owned, mas o coordinator já autorizado agora roda em um worker
tipado `child-run` real, com lease durável ligada à identidade do processo e reverse IPC para budget,
heartbeat, observações e eventos sob `pause-with-parent`; seus efeitos e children aninhados compõem
workers próprios. `survive-parent` de child continua fail-closed. Depois deste snapshot de
auditoria, shell-form tool/gate e fallback de executor para CLI externo receberam bindings próprios;
`process.exec`
recebeu implementação estática de owner independente, lifecycle por intent, lease renovável,
controle loopback por bearer, probe por PID + start token + host e reattachment sem replay. O
worker `tool-gate` apenas solicita o efeito por reverse RPC; o supervisor revalida journal binding e
exact-command antes de lançar o owner fora do Job Object efêmero. Shell explicitamente autorizado é
projetado no argv fixo do interpretador, e executável, hash, script/args, cwd e environment names
atravessam a mesma capability exata; gate shell continua usando somente
`CommandSpec.executable + args`, sem string implícita. Esse delta remove o gap estático de “adapters
não ligados”, mas não altera nenhuma linha para `pass`: não houve
build, typecheck, teste, smoke, execução do CLI, chamada de provider ou inspeção de árvore de
processos.

## Delta estático — correções posteriores de contrato, judge e TUI

A revisão cruzada posterior fechou outros gaps de source, ainda sem produzir prova executável:

- `instruction:` passou a ser uma branch strict estruturalmente sem metadata executável; permanece
  no contexto humano, mas não entra no plano, gates, contadores ou evidence de criteria;
- fallback de judge passou a instanciar somente o candidato selecionado, preservar a rota efetiva
  no assessment, bloquear nonzero/permanente, propagar cancel/raw refs e revalidar comando/hash
  canônicos antes do spawn;
- a provider palette captura provider/método/credential/rota antes da fila, vinculando input secreto
  one-shot ao destino confirmado e impedindo apply/save/revoke sobre seleção posterior; cada nova
  abertura hidrata profile + overrides efetivos da invocation por presença, preserva `null` como
  clear de credential e não herda a rota visual do outro papel;
- troca de provider/model usa clears explícitos para credential/variant/parameters, com tri-state e
  replacement registrados em `EffectiveRunOptions`; os mesmos clears existem na CLI;
- layers global/workspace de profiles permanecem overlays parciais: TUI, TTY e CLI distinguem
  `inherit|set|clear`, e `--inherit-profile-field <metadata-id>` repetível remove somente a folha da
  camada alvo; tombstones são aceitos apenas nos paths opcionais tipados, mapas replacement vazios
  suprimem herança e `null` dentro de `parameters` continua sendo dado legítimo;
- composição e proveniência são calculadas por leaf: replacement/tombstone remove origens inferiores
  obsoletas, builtin/global/workspace são rotulados individualmente e o save valida que a camada
  parcial recomposta produz exatamente o profile efetivo informado antes do commit CAS;
- material secreto em `external_cli.args` ou outras folhas tipadas de profile é recusado tanto nas
  mutações command-owned quanto na leitura de YAML global/workspace editado manualmente; somente IDs
  de credencial e referências `env:NAME` atravessam a configuração, sem varrer o namespace arbitrário
  `extensions`;
- `profiles configure --set-default` grava perfil e pointer do papel no mesmo lock e replace, sem o
  estado parcial anterior de duas mutações; a validação sob o lock impede que defaults globais ou do
  overlay ativo terminem apontando para um profile do papel errado, inclusive nos caminhos de
  settings e config transfer; a composição de profile usa a base do escopo realmente escolhido e
  vincula o commit aos hashes das camadas global/workspace observadas antes do formulário/CLI; quando
  ambas participam da composição/validação, seus locks são adquiridos em ordem absoluta determinística
  e somente o target é gravado, eliminando write-skew entre configuradores concorrentes;
- no Windows, a escrita atômica não desloca mais o target para um backup intermediário: violações
  transitórias de sharing repetem o mesmo rename com backoff curto e uma falha permanente preserva o
  arquivo anterior, em vez de abrir uma janela de crash com o path ausente; callbacks CAS são
  repetidos imediatamente antes de cada tentativa;
- a allowlist de `RunOptionOverrides` passou a incluir as opções já suportadas de parallel, Git e
  sandbox, evitando rejeição interna de flags válidas;
- attestations de promoção standalone agora exigem ao menos uma referência content-addressed,
  recusam nomes não canônicos e pares duplicados; uma lista vazia não pode mais afirmar cobertura de
  R001–R079 ou de gate sem indicar o receipt/log externo correspondente;
- a passagem final do packager standalone agora compara, imediatamente antes do rename, o inventário
  completo do staging com os payloads checksummed, `SHA256SUMS`, manifest e assinatura opcional;
  arquivo extra, ausente ou sidecar não vinculado bloqueia o commit, como já ocorria nos caminhos
  candidate-only e npm;
- o tar separado da skill agora inclui a pasta da skill mais `LICENSE` e
  `THIRD_PARTY_NOTICES.md` no próprio root, fechando o requisito de suporte dentro de cada artifact
  distribuível sem alterar o subdiretório canônico do pacote.
- os archives standalone por target e o tarball npm agora copiam a closure local referenciada pelo
  README e pelos guias operacionais (`docs/`, `examples/`, `implementation/`, `skill-contract/`,
  `skills/`, `schemas/`, `third_party/opencode/`,
  `AGENTS.md`, `DEVELOPMENT.md` e `PRD.md`); o allowlist `files` do package npm declara os novos
  paths, enquanto hashes e inventários exatos já existentes vinculam cada byte copiado;
- os packagers standalone e npm agora usam cancelamento command-owned em duas fases, propagam o
  `AbortSignal` ao signer, checam interrupção antes dos renames de commit e removem staging não
  promovido; tar/gzip e checks Git continuam cooperativos entre awaits e exigem prova executável de
  latência e preservação pós-commit.
- o receipt standalone, por ser produzido e consumido entre packagers, entrou no catálogo público;
  a fonte declara 60 schemas, agora materializados e conferidos. Standalone e npm
  recusam e não copiam uma árvore incompleta ou stale. Na passagem npm
  final, a releitura externa do receipt é seguida por nova conferência de source, destino, archive,
  payloads, binding, assinatura, metadata e inventário imediatamente antes da barreira de commit.
- usage final de provider passou a ser reconciliado por chamada antes de settlement da attempt;
  ausência de final mensurável bloqueia retomada automática sob budget ativo, e preço derivado usa o
  snapshot imutável de capability para distinguir contador omitido de dimensão não aplicável;
- supervisão de child passou a separar heartbeat, ping, processo e progresso, desarmar o deadline
  quando o watchdog está desabilitado e executar `restart-attempt` como nova sessão real, com budget
  durável e autorização exata para reentrar somente na folha já debitada;
- retenção de eventos/raw passou a snapshot por row na migration v14, lease global cross-process,
  revalidação path/handle/parent e remoção por quarentena; capturas de model-smoke são particionadas
  por workspace/policy estável sem transformar mudança futura de retenção em diretório órfão.
- a superfície pública ganhou `alias ralph status|install|remove`: preview é hash-bound, install
  exige receipt corrente `stable`, criação exclusiva e ownership geracional; remove verifica receipt
  e bytes, sem editar `PATH`, afetar alias externo ou publicar bin npm implícito;
- `docs/28-*` materializa a worksheet S12.09/S12.10 com case IDs, diagnostics locais/redigidos,
  gate beta e retorno exato ao clássico; `docs/26-*` agora carrega os campos ampliados de S12.11.

As revisões independentes anteriores não encontraram P0/P1 residual nos paths de contrato, judge,
profiles, TUI, supervisão de child/watchdog, usage/custo e telemetria/retenção cobertos por elas. As
duas correções de release acima fecham gaps específicos por inspeção estática. Desde então, o ciclo
local compilou/executou os gates resumidos no início e regenerou/conferiu os 60 JSON Schemas. Isso
remove a divergência antiga da árvore gerada, sem provar packaging ou promoção.

## Validação executável local — sample S12.08

`tests/integration/s12-sample-e2e.test.ts` executou `examples/vertical-notes/` em workspaces
temporários e passou 1/1 com 59 asserções. A prova compilou root+child recursivamente/strict, entregou
as quatro folhas por executor roteirizado, chamou o judge fake external-CLI como processo
supervisionado fora do workspace, observou a sequência `72 -> revisão -> 96` e reconciliou child e
parent. Um fault após o commit durável da primeira folha interrompeu o run; o resume reutilizou o
mesmo run ID e não repetiu a folha concluída.

O mesmo teste construiu snapshots/views TUI de root `4/4` e child `2/2`, conferiu barras, labels de
judge/revisão e usage honesto como `unavailable`; iniciou a aplicação entregue em HTTP real; validou
health, HTML, erro correlacionado, create/list, persistência após restart e ausência do texto privado
nos logs; conferiu attempts, assessments, evidence bundles e artifacts; e comparou por igualdade
estrutural as duas projeções redigidas em `expected/`.

O limite é deliberado: o executor foi injetado/roteirizado, o judge externo era fake/read-only e a
orquestração foi chamada pelo harness, não por um standalone instalado. A TUI foi provada na fronteira
snapshot/view, não em sessão PTY com close/attach/replay; nenhum provider, modelo, conta ou auth real
foi usado. Também não houve package, candidate binding, target externo ou artifact de release. Isso
fecha S12.08 no escopo de integração local, sem alterar os casos `pending` de S12.09–S12.11 nem
produzir suporte de provider, plataforma ou distribuição.

## Blockers reais para fechamento e promoção

### B01 — runner de fechamento local implementado; archive e fechamento integral pendentes

O embargo deixou de existir. Schemas, lint, typecheck, grupos unitário/packages/CLI/watchdog/PTY,
integração, sample S12.08 e build/smoke nativo Windows x64 já produziram a evidência resumida no início. Os casos
R001–R079 estão vinculados individualmente em `docs/18-*`; vínculos de release ainda precisam do
candidato e ambiente exatos. O packager continua falhando fechado diante de schema ausente, extra ou
stale e não materializa schemas implicitamente.

O job `security-gates` agora inclui no receipt content-addressed não apenas os reports e o workflow,
mas também `package.json`, `bun.lock`, `THIRD_PARTY_NOTICES.md`, a árvore `third_party`, os
implementadores de audit/provenance/SBOM/inventário e os quatro contratos de teste de S11.10. Isso
fecha a lacuna estática de portabilidade da evidência de compliance; nenhuma nova execução de CI ou
do gate é inferida por essa alteração.

O runner [`scripts/s12-closure.ts`](../scripts/s12-closure.ts) compõe install pelo lockfile congelado,
check documental, schemas, lint, typecheck, exatamente um `bun test` global com JUnit temporário,
build, smoke, sanitização/classificação, audit JSON, Gitleaks hash-bound, Git/source binding e
receipts. O JUnit bruto é removido antes do archive; o sanitizado deve ser não vazio, casar com a
classificação e conter sentinelas críticos de supervisor, sample, closure, provenance e SBOM.
Segredos são procurados tanto literalmente quanto após decodificação de entidades XML nomeadas e
numéricas; qualquer representação residual falha antes da persistência. O ledger só aceita
`validado-localmente` com ID `EV-*` existente no catálogo ou link Markdown local, e referências
`EV-*` desconhecidas falham. As probes Git canônicas antes/depois comparam a origem em memória e
registram apenas seu digest, nunca a URL. Um source binding apto exige também estabilidade do hash do
executável Git e uma observação final pós-envelope de HEAD/origin/limpeza pelo mesmo executável.
Distribution, sample e licença/provenance são descobertos pelo global e não repetidos. `dist` só é
válido com bundle e standalone nativo current-source construídos depois do início do run. O archive
contém logs bounded/redigidos, R001–R079, blockers, report S10, outputs de build, payload
content-addressed, envelope e `SHA256SUMS`. `--legacy-binary` e `--next-binary` são
opcionais em conjunto; ausentes ou divergentes preservam `BLK-COMPAT-BINARIES`, sem hardcode ou
download do Ralph v1. O report precisa casar com o `sourceFingerprint` corrente. Todos os children
passam por `BunProcessSupervisor`, Job Object/grupo de processo e shutdown em duas fases, usam
`windowsHide: true` e nenhuma TUI é aberta. O evidence root é um novo filho direto, canônico e sem
symlink/junction; inventários rejeitam paths não portáveis e drift entre manifest e checksums.
Exclusões por nome aplicam-se somente aos diretórios declarados na raiz; a única exceção estrutural
é o link gerado `apps|packages/<workspace>/node_modules`, derivado do lockfile e nomeado no receipt,
nunca qualquer diretório aninhado que por acaso se chame `dist`, `artifacts` ou `coverage`.

```text
bun run check:s12 -- --evidence-root artifacts/ci/s11-closure/local-YYYYMMDD-NNN [--legacy-binary <RALPH_V1_EXPLICITO>] [--next-binary <RALPH_V2_EXPLICITO>] [--candidate-artifact <ARQUIVO_CANDIDATO> --candidate-digest sha256:<64_HEX>] [--waiver-artifact <APROVACOES_EXTERNAS_JSON> --waiver-digest sha256:<64_HEX>] [--gitleaks-binary <BINARIO_CANONICO> --gitleaks-sha256 <64_HEX>]
```

Exit `1` é falha local; exit `2` é o resultado honesto `local-pass/release-blocked`. O diretório deve
ser novo. Este comando ainda não foi executado nesta edição, portanto não há content address ou
checksums novos a alegar e S11.12 permanece aberto.

Sem os dois flags de Gitleaks, o runner exige
`artifacts/ci/tooling/gitleaks-install.json` e o binário exato produzidos pelo instalador oficial
checksum-pinned. Não há fallback para um `gitleaks` arbitrário do PATH. O digest de candidate só é
aceito com receipt standalone ou release manifest Ralph schema-valid. A metadata e todos os payloads
declarados são lidos de forma bounded/estável, conferidos por tamanho/hash, revalidados perto do
binding e relidos novamente após a estabilização do envelope; assinatura destacada sem self-hash
recebe somente hash observado e indicação explícita
`observed-bounded-only`. A leitura agregada é limitada a 8 GiB e cancelável entre chunks. O archive
recebe digest/tamanho exatos, projeção tipada sem URLs e inventário dos payloads, nunca a metadata
bruta, e por isso declara-se não autônomo sem o candidato externo. O estado é `content-verified`, não
prova de assinatura. Waivers só são
avaliados quando source binding completo
já liga origem canônica, HEAD limpo, inventário/fingerprint e repository/commit/fingerprint do
candidato. A CLI confirma o digest da metadata, mas waivers usam um digest efetivo derivado também do
payload content address, de modo que o blob destacado observado participa da identidade. O DAG source
binding → manifest de payload → checksums → `closure-complete.json` evita
autorreferência. Os receipts anteriores são provisórios; só o commit marker final, que liga os hashes
do manifest/checksums/source binding depois da revalidação, torna o status e o binding efetivos. Neste
checkout sem HEAD/remote/candidate/archive ligados, o
resultado esperado continua `local-pass/release-blocked` quando todos os gates locais estiverem
verdes. `BLK-SOURCE-BINDING` é fundacional e não é convertido em pass por waiver.

O completion receipt é validado por schema estrito antes da escrita e novamente após releitura
handle-bound. Status/local/release eligibility, source binding/final Git, observação final do
candidato, blockers e waivers precisam ser mutuamente consistentes; os bytes pretendidos ainda são
comparados às duas inventariações finais antes de qualquer output de sucesso.

Aprovações não vivem no registry versionado: editar digest pós-candidato mudaria o source e geraria
um ciclo. O runner aceita, opcionalmente, artifact externo+digest explícitos, schema v1, sujeito ao
metadata/effective digest e à identidade source completa. IDs precisam ser únicos/ordenados, source
binding é proibido e owner precisa casar com o blocker. A autoridade é a seleção explícita do arquivo
e hash pelo operador, sem alegação de assinatura criptográfica; o input bruto não entra no archive.
Waivers efetivamente usados são relidos e reavaliados no instante anterior ao commit marker final.

**Próximo fechamento:** executar esse comando uma vez sem duplicar grupos focados, revisar o archive
e então executar somente os smokes externos, matrizes e drills ainda nomeados no ledger, sem
promover resultado local a suporte de release.

### B02 — identidade decidida; publicação do namespace ainda pendente

O proprietário delegou a decisão e o source agora declara MIT própria, `ralph-next`, versão
`0.1.0-beta.1`, channel `beta` e repositório `https://github.com/rodrigojager/ralph-v2`. O gerador
usa `$id` sob `https://rodrigojager.github.io/ralph-v2/schemas/v2/`, materializado por workflow Pages
com actions pinadas por SHA. `private: true` permanece apenas no monorepo de desenvolvimento; o
packager npm produz staging público separado.

**Desbloqueio restante:** criar/confirmar origin, publicar o primeiro commit, habilitar Pages por
GitHub Actions e provar por fetch que os 59 `$id` resolvem para os bytes gerados. Licença e namespace
não são mais decisões em aberto, mas ainda não constituem artifact ou publicação comprovados.

### B03 — lockfile verificado localmente; SBOM/release ainda pendentes

O texto atual de `bun.lock` contém as entradas conhecidas de `apps/ralph-launcher`, a dependência
CLI -> TUI e as dependências OpenTUI/SolidJS; `bun install --frozen-lockfile` passou com Bun `1.3.14`
no checkout local. Isso confirma sincronização para esse source, mas não produz SBOM nem vincula o
lockfile a um release candidate.

O gerador de SBOM deve permanecer fail-closed diante de qualquer diferença restante entre package
manifests, workspace graph e lockfile.

**Desbloqueio restante:** repetir em checkout versionado/limpo do candidato e produzir SBOM a partir
do artifact/lock exatos.

### B04 — signer/verifier compostos; identidade e trust operacionais ainda não escolhidos

Os paths externos, provider-neutral e versionados de assinatura e verificação agora estão compostos
estaticamente. `scripts/release-signer.ts` e `scripts/package-release.ts` aceitam uma configuração
estrita de signer, supervisionam a árvore sem shell, produzem assinatura destacada e vinculam
kind/identity/hash/tamanho ao manifest canônico. O npm usa a operação separada
`sign-release-subject` sobre `npm-release-binding`; adapters limitados a manifest falham fechado.
`apps/ralph-cli/src/distribution-signature.ts` e o
composition root carregam de forma lazy `RALPH_RELEASE_VERIFIER_CONFIG`, aplicam trust policy local
independente do manifest, verificam um snapshot privado bounded e exigem resultado vinculado ao
kind, identity, hashes e, quando configurado, issuer esperados. Ambos minimizam a janela portátil
entre revalidação do executável e spawn, mas não a apresentam como isolamento forte do sistema
operacional.

O repositório deliberadamente não escolhe adapter/ferramenta, chave, identidade, issuer, trust root,
rotação ou revogação e nenhuma assinatura real foi produzida. Portanto `stable` continua não
instalável hoje por falta de material operacional confiável, promotion evidence e validação real —
não por ausência do contrato/composition path. A falha permanece fechada e identidade declarada no
manifest nunca vira trust anchor.

**Desbloqueio:** o proprietário escolhe e provisiona signer/verifier compatíveis, identidade e trust
policy fora do artifact; produz a assinatura destacada do candidato exato e executa os testes
negativos de adulteração, identidade/issuer, origem, rotação e revogação.

### B05 — evidence candidate-bound R001–R079 e promotion record não produzidos

`packages/distribution/src/promotion.ts` modela o promotion record v3 com attestations bounded,
bindings por hash, reviewers, waivers, gates e targets. A policy cobre exatamente R001–R079;
R076–R079 são críticos em `stable`, e records v2 com somente 75 linhas falham no schema antes do
binding. `NpmReleaseBindingSchema` e `NpmReleasePromotionRecordSchema` v2 vinculam separadamente o
tarball npm, seus support files, o receipt standalone independente, a promoção v3 base e gates npm.
A base é revalidada contra o `promotionCandidate` do receipt; attestations separam `artifactRefs` de
`evidenceRefs` externos, e install drill exige ambiente real para cada OS/arquitetura promovido. O
packager valida os payloads do receipt na origem e inclui no binding/inventário um snapshot opaco
explicitamente não relocatable, além do payload content address no result. Nenhum
bundle de promoção vinculado a um candidato exato foi produzido por esta validação local. Os
SHA-256 do build local não estão vinculados a um commit candidato ou a uma attestation. Há prova
local de segurança `EV-S11-SEC-177` (177/177), compatibility source-only 5/5, addendum S03 15/15,
`EV-S10-COMPAT-91` contra Ralph legado real e forward test cego da skill com validate/inspect strict
sem diagnostics, mas ela não está candidate-bound e não substitui install drill, forward test do
artifact empacotado, license/SBOM de release ou review independente do candidato. O repositório está
na branch `main` ainda sem `HEAD`
inicial e com os arquivos do projeto não versionados; portanto também não existe o commit completo
de 40 caracteres exigido como binding de source pelos packagers e pelo promotion record.

**Desbloqueio:** executar a fila S11 no artifact exato, registrar ambiente/runner/commit/hash/result,
obter reviews independentes quando exigidos e gerar o promotion record sem inventar ou copiar texto
de evidência bruta.

### B06 — lifecycle local exercitado; package/platform/install de release pendentes

O standalone nativo Windows x64 foi reconstruído e passou pelo smoke local de 20 fluxos públicos,
com metadata/hash/fingerprint verificados pelo harness. Essa prova é do checkout de desenvolvimento,
não de um release candidate promovível, e não cobre os outros cinco targets nem package receipts,
signing, trust ou install drill.
`EV-S12-DIST-8` exercitou instalação limpa, update/check, crash recovery, rollback, uninstall,
downgrade/schema incompatível e tamper sobre manifests/payloads sintéticos locais. A fixture declara
`nightly`, versões `*-dev.1`, assinatura indisponível e limitation local-contract-only; portanto não
é package de release, target support ou attestation. A coexistência local com o
Ralph clássico e a migração inspect/apply/rollback foram exercitadas por `EV-S10-COMPAT-91`, com
origem, config roots, credential refs e sentinels preservados; isso não promove aqueles binários a
artifacts instaláveis.

**Desbloqueio:** depois de um archive local revisado e das decisões B02–B04, um canal beta pode produzir artifacts imutáveis em checkout
limpo com indisponibilidade de assinatura declarada e executar a matriz por target, mantendo
`built-not-tested`, `packaged-not-tested` e `tested` como estados distintos. B04, uma
`ReleaseSupportPolicy` explícita e a prova diferida descrita em B08 continuam obrigatórios para
qualquer promoção `stable`; a contradição de implementação em B08 já foi removida.

### B07 — leitura final consolidada concluída estaticamente

Os caminhos de paralelismo/Git/sandbox receberam leitura consolidada depois das últimas edições. A
paginação keyset percorre todas as sessões do workspace sem teto total, falha fechado para cursor,
ordem ou página inválidos, bloqueia o workspace para sessão estrangeira sem término confirmado e
mantém o bloqueio específico por task somente para a própria run retomada. A revisão estática
independente não encontrou P0/P1 residual nesse escopo.

**Estado:** não é mais blocker estático de S09. `EV-S09-E2E-7`, `EV-S11-KILL-17` e a suite
`linked.parallel-git-security` de `EV-S10-COMPAT-91` executaram concorrência, crash, sandbox process e
Git no host local. Isolamento forte, candidate binding, outras plataformas e distribuição/release
continuam sujeitos aos blockers B02–B06 e ao input externo de matriz registrado em B08.

### B08 — contradição estrutural removida; decisão da matriz continua externa

**Estado estático:** `implementado-estaticamente`, sem escolha de targets e sem prova executável.

O mecanismo agora usa `ReleaseSupportPolicy` schema v1 e `ReleaseManifest` schema v2. Cada policy é
específica de versão/channel e contém exatamente os seis targets, em ordem canônica, com estado
`included` ou `not-promoted`. `included` significa somente que o artifact pode compor aquele
manifest; não significa `tested`, suporte ou promoção. `not-promoted` exige motivo explícito, por
isso a ausência de artifact não pode ser interpretada como linha esquecida ou suporte implícito.

Cada entry declara `installControlStateDurability`, mas o valor não é livre: o schema o compara à
primitive realmente implementada. Windows x64/arm64 permanece obrigatoriamente
`unsupported-file-sync-only/reduced`; Linux/macOS declaram `fsync-after-rename/full`. Uma policy
`stable` recusa qualquer entry `included` sem garantia `full`. Assim o código não finge directory
fsync no Windows e também não remove Windows do universo visível.

`scripts/package-release.ts` exige `--support-policy`, lê o JSON por handle bounded com identidade
revalidada e exige igualdade exata entre os targets pedidos e o subconjunto `included`. O manifest
carrega a policy completa e seu SHA-256 canônico. O promotion record schema v3 inclui o mesmo hash,
aceita somente targets `included` em ordem canônica e recusa attestations que aleguem target
`not-promoted`. O installer recalcula o hash, exige version/channel, status local `included`,
capability declarada igual à observada e todos os gates preexistentes; seleção, packaging,
promotion binding e install/update falham fechados em divergência. A assinatura destacada cobre
também a policy e seu hash por fazerem parte da projeção canônica do manifest.

A exigência anterior de “todos os seis artifacts em toda stable” foi removida. Uma stable deixa de
ser estruturalmente impossível porque pode promover somente o subconjunto explicitamente
`included`, mantendo as demais linhas `not-promoted` com motivo. Isso não escolhe o subconjunto pelo
projeto: continua faltando input externo do proprietário/release owner com o status das seis
entries, limitações das incluídas e motivos das não promovidas. Esse input pertence ao Gate A e não
é mais um blocker de implementação B08. Se no futuro uma primitive Windows de garantia plena for
implementada, o contrato/capability deve ser versionado e provado por crash tests antes de mudar a
linha; editar apenas a policy não consegue fabricar `full`.

**Prova pendente:** `EV-S12-DIST-8` cobre parser/hash/tamper e install/update do target local somente
como contrato sintético. Continuam diferidos mismatch de targets, promotion binding, candidate
content-addressed, target incluído/recusado, stable parcial e comportamento real de durabilidade por
plataforma.

### B09 — inventário de textos e curação do runtime Bun materializados

**Estado atual:** helper e integração dos packagers implementados; input de curação oficial exato
presente para Bun `1.3.14`/`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`.

`scripts/release-licenses.ts` usa o SBOM serializado como fonte exata, exige igualdade entre a
aresta runtime root e os componentes npm, resolve nome/versão no Bun store, confere manifest e copia
somente textos regulares, bounded e UTF-8 de `LICENSE|LICENCE|COPYING|NOTICE`. Variantes peer precisam
ter inventários byte-idênticos. O snapshot OpenCode leva licença, o manifesto estruturado e os três
documentos humanos de proveniência.
O output `third_party/licenses/manifest.json` vincula o SHA-256 do SBOM e cada arquivo copiado. O
packager npm usa esse inventário sem exigir o runtime Bun, que não é distribuído no tarball.

O standalone também vincula todos os engine/launcher metadata à mesma dupla `bunVersion` e
`bunRevision` e exige um bundle totalmente manifestado em
`third_party/bun/runtime/<version>/<revision>/CURATION.json`. A árvore atual registra o tag/release,
commit/tree/blob oficiais, a matriz upstream de licença/linked libraries, os seis digests de asset
relevantes e os receipts dos bytes curados. Os quatro contratos de licença/proveniência passaram
26/26, incluindo tamper, arquivo extra/ausente, symlink e mismatch de versão/revisão. Os binaries
históricos em `dist/` continuam fora da autoridade de compliance.

**Prova ainda pendente:** package do candidato precisa copiar exatamente essa árvore, comprovar a
mesma dupla em todos os engine/launcher metadata, fechar peer divergence e inspecionar o inventário
final. O manifest entrega rastreabilidade dos bytes; não deve ser descrito como certificação jurídica
automática.

## Fila de evidência diferida

Esta fila define o que ainda deverá ser provado e vinculado ao artifact exato; não autoriza smokes
reais, publicação ou operações externas sem o opt-in correspondente.

| Lote | Requisitos | Evidence mínima futura | Estado atual |
| --- | --- | --- | --- |
| E01 | R001–R004 | autoridade adversarial, tools/settlements e boundary review no artifact | `EV-S11-E2E-100` + `EV-S11-SEC-177` locais verdes; candidate binding/review ainda pendentes |
| E02 | R005–R009 | fixtures + smokes opt-in por auth/backend, executor e judge independentes | `EV-S11-E2E-100` e fixtures locais verdes; auth/provider real bloqueado |
| E03 | R010–R020 | parser/schema/property/golden, migração e forward test da skill | `EV-S11-PROP-111` + `EV-S11-SEC-177` para bounds/corrupção e prompt PRD; `EV-S10-COMPAT-91` para migração legacy real; candidate binding pendente |
| E04 | R021–R026 | child/nested/kill/resume/reattach/múltiplos projetos | `EV-S11-E2E-100` + `EV-S11-KILL-17` e sample S12.08 local (child + crash/resume sem replay) verdes; attach/candidate binding e plataformas externas pendentes |
| E05 | R027–R040 | gates/skips/change/artifact e sequência completa de judge/revisão | `EV-S11-E2E-100` e sample S12.08 local (`72 -> revisão -> 96`, evidence/artifacts) verdes; provider real/candidate binding pendentes |
| E06 | R041–R043 | stall e false-positive matrix com clock/probes/processos | watchdog 8/8: falsos positivos, processo CPU/IO, worker congelado e hard timeout pós-deadline validados localmente; binding ao candidato/plataformas continua pendente |
| E07 | R044–R055 | TUI PTY/resize/progress/usage/output/popup/theme | `EV-S11-E2E-100`, `EV-S11-PROP-111`, smoke PTY real verde 3x, matriz S08.12 5/5 e projeção root/child do sample S12.08 verdes; PTY do sample, Linux/macOS, provider/auth real, review visual e candidate binding pendentes |
| E08 | R056–R060 | CLI/TUI parity, human/JSON/JSONL, attach/replay e provider adversarial | `EV-S11-E2E-100`, `EV-S11-SEC-177`, `EV-S11-PROP-111` e S08.12 locais verdes; candidate binding pendente |
| E09 | R061–R065 | parallel/Git/conflict/checkpoint/sandbox/security canaries | `EV-S11-E2E-100` para parallel/Git/conflict/checkpoint/process sandbox, `EV-S11-SEC-177` para canaries/path/argv/headless/external effects e `EV-S11-KILL-17` para crash/recovery; isolamento forte e candidate binding pendentes |
| E10 | R066–R070 | provenance/SBOM/compat/package/install e matriz de seis targets | `EV-S10-COMPAT-91`, Windows nativo, `EV-S11-FS-12` e `EV-S12-DIST-8` (8/8, 91 asserções, local contract) verdes; `EV-CI-S11-SOURCE` cobre os seis pares sem skip permissivo, mas package/install do candidate e runs multiplataforma seguem bloqueados |
| E11 | R071–R075 | replay/backpressure/retention/progress honesty/options immutability | `EV-S11-PROP-111`, `EV-S11-SEC-177`, `EV-PERF-6` e `EV-PTY-S08-5` locais verdes; candidate binding e multiplataforma pendentes |
| E12 | R076–R079 | selectors exatos, verify/judge standalone, receipts/eventos, imutabilidade e source ad hoc | matriz focada 3/3, 69 asserções, validada localmente |

Cada registro futuro precisa incluir requisito, tipo de evidência, commit/fingerprint, artifact hash,
ambiente real, comando/harness, resultado, logs content-addressed e reviewer. Um skip permanece skip;
compile não vira runtime; contract test não vira integração real; artifact de outro hash não prova o
candidato atual.

## Handoff seguro durante o fechamento

O estado aceitável deste checkout é `development, unpublished, local validation partial`. Quem assumir o
trabalho deve:

1. preservar todos os checkboxes executáveis ainda abertos, inclusive S11.12 até existir um archive
   executado e revisado; não confundir o runner implementado com conclusão ou promoção;
2. não converter esta auditoria em promotion record;
3. preservar a integração 149/149, o gate 673/673 e o sample S12.08 local 1/1 com 59 asserções,
   fechando somente as lacunas específicas sem extrapolar os resultados locais;
4. manter stable fail-closed, sem assinatura ou trust implícitos;
5. manter `ralph-next` lado a lado com o Ralph clássico;
6. registrar qualquer novo gap na matriz R001–R079 e neste blocker ledger;
7. para release, começar por checkout/lock/schema/build limpos e vinculados ao candidato, sem usar
   resultados locais como substitutos;
8. preencher [o handoff formal](26-release-gates-e-handoff-s12.md) e a
   [worksheet beta/drills](28-release-drills-beta-alias-e-handoff-s12.md) somente com valores observados.

Até isso ocorrer, a formulação correta é: **as superfícies acima foram implementadas e receberam
validação local parcial nos graus registrados, mas o produto não foi validado na matriz externa,
empacotado para promoção, assinado, publicado nem aprovado para uso de produção.**
