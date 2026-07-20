# 18 — Matriz de rastreabilidade

## Uso

Esta matriz impede que uma preferência discutida desapareça durante a reescrita. Cada requisito aponta para a especificação, a slice dona e a evidência mínima. A primeira tabela preserva o contrato esperado; o ledger S11 abaixo registra, separadamente, a prova executada e o blocker residual de cada R-ID.

| ID | Requisito | Especificação | Slice | Prova mínima |
| --- | --- | --- | --- | --- |
| R001 | Ralph/comandos governam a IA | 01, 03, 08 | S03/S05 | modelo dizendo “complete” não muda state |
| R002 | Tool calling existe sob autorização do CLI | 03, 08, 13 | S05 | allow/deny/settlement E2E |
| R003 | Reescrita TypeScript/Bun no ecossistema do OpenCode | 03, 06, 14 | S01/S04 | build/package + provenance |
| R004 | Não usar OpenCode como agente/orquestrador | 01, 03, 06 | S04/S05 | dependency/architecture test/review |
| R005 | Reaproveitar providers/modelos de modo curado | 06, 14 | S04 | provider fixtures + copied-files map |
| R006 | Executor e judge configurados independentemente | 05, 06, 17 | S04/S06 | dois providers/credentials no mesmo run |
| R007 | API key, env e auth por conta quando suportado | 06 | S04 | auth mock/smoke por método |
| R008 | Usar ChatGPT Plus/Pro para Codex sem depender do CLI | 06 | S04 | browser OAuth/account smoke rotulado |
| R009 | Backend CLI externo continua opcional | 06, 08 | S05 | fake CLI/generic adapter E2E |
| R010 | PRD convertido em vertical slices atômicas | 00, 02, 07 | S02/S12 | skill fixture + review/validator |
| R011 | Slice atravessa camadas necessárias de ponta a ponta | 07, 16 | todas | E2E vertical por Sxx |
| R012 | Contexto e contratos das camadas ficam na mesma task | 07, 08 | S02/S03 | context manifest golden |
| R013 | PRD legível por humanos | 07 + examples | S02 | human review + examples |
| R014 | Parser determinístico e schema forte | 07, 17 | S02 | AST/schema/property/golden |
| R015 | Regex apenas em tokens folha | 07 | S02 | parser architecture tests/review |
| R016 | Status `[ ]/[~]/[x]` e edição sem reformatar | 07 | S02 | byte-preservation property test |
| R017 | Compatibilidade/migração do PRD antigo | 07, 14 | S02/S10 | v1 golden + migrate report |
| R018 | Sub-PRDs dão detalhe adicional | 07, 10 | S02/S09 | recursive graph/child E2E |
| R019 | Somente a skill cria root/sub-PRDs | 01, 07, 08 | S02/S12 | ausência de runtime author path + skill test |
| R020 | Ralph valida child ausente antes de executar | 07 | S02 | missing/cycle error before model call |
| R021 | Pai só conclui depois de todos os itens internos | 07, 10 | S09 | parent/child completion test |
| R022 | Child é instância Ralph vinculada e supervisionada | 07, 10 | S09 | run IDs/leases/events/reattach |
| R023 | Múltiplos Ralphs/projetos não colidem | 10, 13 | S07/S09 | concurrent workspace E2E |
| R024 | Retomar última task não finalizada ou primeira | 10 | S07 | kill/resume selection matrix |
| R025 | Child ativo retoma antes do pai/próxima task | 10 | S09 | nested kill/resume test |
| R026 | Alterações parciais entram no contexto retomado | 08, 10 | S07 | diff survives/reappears golden |
| R027 | Judge é opcional | 05, 09 | S06 | deterministic-only E2E |
| R028 | Sem judge, self-review também é opcional | 09 | S06 | self vs none scenarios |
| R029 | Self-review usa os mesmos critérios/schema | 09, 17 | S06 | contract test shared evaluator input |
| R030 | Judge devolve nota 0–100 | 09, 17 | S06 | schema boundary tests |
| R031 | Threshold configurável | 04, 05, 09, 12 | S06/S08 | CLI/config precedence + origem no attach + popup pré-run apply |
| R032 | Parecer diz adequado e ruim/ausente | 09 | S06 | assessment golden/TUI tabs |
| R033 | Máximo de revisões para aprovação | 09 | S06 | 60→revision→88 e exhaustion |
| R034 | Retry de transporte não confunde revisão | 08, 09 | S06 | counter tests |
| R035 | Gates determinísticos têm precedência | 09 | S06 | gate fail + score 100 stays fail |
| R036 | Manter skip tests/commands/gates/fast | 02, 04, 09 | S03/S06/S10 | compatibility/E2E matrix |
| R037 | Evitar loops intermináveis em entrega pequena | 08, 09 | S03/S06 | budgets/timeouts/exhaustion |
| R038 | Task sem critério forte não força critério superficial | 07, 09 | S02/S06/S12 | change-only/artifact examples |
| R039 | Diff/arquivo pode ser último recurso determinístico | 07, 09 | S06 | declared artifact/change E2E |
| R040 | Arquivo de prova é planejado, não improvisado no runtime | 07, 09 | S02/S12 | schema + skill validation |
| R041 | Watchdog detecta travamento | 10 | S07 | frozen worker recovery |
| R042 | Watchdog não confunde demora com stall | 10, 15 | S07/S11 | slow/quiet false-positive matrix |
| R043 | Parent monitora children | 10 | S09 | child heartbeat/status test |
| R044 | Status aparece na TUI | 11, 12 | S08 | PTY snapshot/live E2E |
| R045 | Tokens/custo padronizados e honestos | 06, 11, 17 | S04/S08 | reported/estimated/unavailable fixtures |
| R046 | Progresso numérico executado/total | 11, 12 | S08 | progress snapshots |
| R047 | Barra representa mesma métrica | 11, 12 | S08 | property/snapshot tests |
| R048 | Largura do painel é sempre 100% | 12 | S08 | resize widths and equal-ratio goldens |
| R049 | Só completion durável incrementa barra | 11, 12 | S08 | active/revision does not fill test |
| R050 | Barras parent/child e aggregate rotulado | 12 | S08/S09 | tree/progress PTY test |
| R051 | Log e activity na TUI | 11, 12 | S08 | event filters/replay test |
| R052 | Engine output bruto/normalizado na TUI | 11, 12 | S08 | provider/CLI stream PTY |
| R053 | Tools/gates/judge/watchdog visíveis | 12 | S08 | panel snapshots/E2E |
| R054 | TUI popups ricos estilo OpenCode | 05, 12 | S04/S08 | seleção inicial + command palette mutável e keyboard popup tests |
| R055 | Cores inspiradas, sem azul padrão/branding copiado | 12, 14 | S08/S12 | theme snapshots/license review |
| R056 | Tudo configurável também por CLI | 04, 05, 12 | S08/S10 | option metadata parity test |
| R057 | Headless human/JSON/JSONL | 04, 11 | S01/S08 | golden/stream contract |
| R058 | Fechar TUI e reanexar sem perder run | 10–12 | S07/S08 | close/background/attach test |
| R059 | Raw output preservado e event model próprio | 06, 11 | S05/S08 | raw refs + public schema test |
| R060 | Provider não controla state/policy | 03, 06, 08 | S05 | module boundaries + adversarial test |
| R061 | Paralelismo com claims/worktrees | 02, 13 | S09 | concurrent task integration E2E |
| R062 | Conflitos não resolvidos destrutivamente | 13 | S09 | conflict pause test |
| R063 | Git branch/commit/PR/no-commit/checkpoint/rollback | 04, 13 | S09/S10 | strategy fixtures |
| R064 | Sandbox e security modes | 13 | S09 | safe/auto/dangerous matrix |
| R065 | Secrets não vazam | 06, 11, 13 | S04/S11 | canary suite |
| R066 | Código OpenCode fixado, atribuído e auditável | 06, 14 | S04/S12 | notices/maps/hashes/license gate |
| R067 | Não copiar agente completo nem branding | 06, 14 | S04/S12 | dependency/source inventory review |
| R068 | Preservar comandos/modos úteis atuais | 02, 04, 14 | S03/S10 | compatibility matrix |
| R069 | Instalação/update/migração lado a lado | 14 | S10/S12 | install and rollback smoke |
| R070 | Cross-platform com atenção ao Windows | 10, 13–15 | S11/S12 | platform CI/package smoke |
| R071 | Eventos versionados e replay | 11, 17 | S08 | replay identical snapshot |
| R072 | Output intenso não trava supervisor/TUI | 11, 12 | S08/S11 | backpressure load test |
| R073 | Progresso não tenta estimar trabalho interno da IA | 11, 12 | S08 | UI has phase separate from bar |
| R074 | Projeto novo em `Desktop/ralph-v2` | README, 00 | S01 | path/repo initialization review |
| R075 | Snapshot de opções de run persistido é imutável; attach/replay inspeciona sem alterar | 10, 12, 17, ADR 0008 | S06/S08 | origem/equivalentes read-only + apply pré-run + save future-defaults |
| R076 | `verify` reexecuta gates/evidence sem executor, ToolHost, task ou marker | 02, 04, 09, 17 | S06.12 | selectors + stability + state-before/after |
| R077 | `judge` standalone usa evidence existente, external default/self explícito e nunca aplica revisão/task | 02, 04, 09, 17 | S06.12 | external/self + mutation/state-before/after |
| R078 | Seletores verify/judge são exatos, sem scan truncado ou escolha silenciosa do run recente | 04, 09 | S06.12 | ambiguity and immutable-ID matrix |
| R079 | Runs ad hoc podem ser verificadas/julgadas da source persistida sem PRD, marker ou gates inventados | 02, 09, 10, 17 | S06.12 | ad-hoc source/hash binding matrix |

## Catálogo de evidência executada em 2026-07-19

Os resultados abaixo pertencem ao checkout local em Windows x64. Eles não estão vinculados a um
release candidate, commit publicado ou promotion record e não provam automaticamente provider/auth
real, outras plataformas, instalação de release ou promoção. A compatibilidade local contra o
Ralph clássico real está registrada separadamente em `EV-S10-COMPAT-91`.

| Evidence ID | Resultado observado | Superfície executável |
| --- | --- | --- |
| `EV-CHECK-673` | `check` verde, 673/673 testes; schemas, lint, typecheck, build e smoke nativo incluídos | [`scripts/check.ts`](../scripts/check.ts), [`package.json`](../package.json) |
| `EV-INT-149` | integração 149/149 | [`tests/integration/`](../tests/integration/) |
| `EV-E2E-63` | E2E determinístico 63/63 | alias `test:e2e` em [`package.json`](../package.json) |
| `EV-S11-E2E-100` | `test:s11:e2e` 100/100, 924 asserções em 12 arquivos: once/loop/Wiggum/parallel; pacote compilado; embedded/CLI; deterministic/self/external; change/artifact/skips/no-change; child/nested; Git/process sandbox; renderer headless. Paridade de terminal real permanece vinculada ao `EV-PTY-S08-5` já executado, sem rerun | alias `test:s11:e2e` em [`package.json`](../package.json), [`orchestration-runner.test.ts`](../tests/integration/orchestration-runner.test.ts), [`execution-cli.test.ts`](../tests/integration/execution-cli.test.ts), [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts), [`s09-bounded-e2e.test.ts`](../tests/integration/s09-bounded-e2e.test.ts), [`dashboard.test.ts`](../packages/tui/tests/dashboard.test.ts) |
| `EV-S11-SEC-177` | `test:security` 177/177, 1.777 asserções em 20 arquivos: canaries env/header/output; traversal/symlink/junction; argv literal sem shell; PRD/repo/completion maliciosos; schema/output bounds; judge read-only; headless ask auditado; external effects/idempotência; state/event/PRD/YAML fail-closed | alias `test:security` em [`package.json`](../package.json), [`tool-host.test.ts`](../packages/tool-host/tests/tool-host.test.ts), [`s05-embedded-e2e.test.ts`](../tests/integration/s05-embedded-e2e.test.ts), [`tool-call-journal.test.ts`](../tests/integration/tool-call-journal.test.ts), [`config.test.ts`](../tests/unit/config.test.ts) |
| `EV-WDG-8` | watchdog 8/8, 84 assertions: clock/scheduler controlados, quiet/slow/retry-after/stream/reasoning, processos reais saudável/congelado e hard timeout confirmado em duas probes pós-deadline | [`tests/hardening/watchdog.test.ts`](../tests/hardening/watchdog.test.ts) |
| `EV-PTY-3X` | o smoke PTY real passou em três execuções consecutivas | [`tests/hardening/pty.test.ts`](../tests/hardening/pty.test.ts) |
| `EV-PTY-S08-5` | matriz Windows ConPTY S08.12 5/5, 34 verificações: streams variados, usage ausente/reportado, output grande, resize, child, popup apply/save, background/reattach, Ctrl+C, attach/replay imutável e paridade TUI/human/JSON/replay | [`tests/hardening/pty.test.ts`](../tests/hardening/pty.test.ts) |
| `EV-COMPAT-SRC-5` | compatibility source-only 5/5, sem Ralph legado | [`tests/integration/compatibility-harness.test.ts`](../tests/integration/compatibility-harness.test.ts), [`scripts/compatibility.ts`](../scripts/compatibility.ts) |
| `EV-S03-15` | addendum S03 15/15 | [`compatibility/s03-addendum.json`](compatibility/s03-addendum.json), [`scripts/s03-compatibility.ts`](../scripts/s03-compatibility.ts) |
| `EV-S10-COMPAT-91` | harness integral S10 91/91, zero regressions e zero surface regressions contra `ralph 0.2.0`; S01, S03, comandos/flags, human/JSON, aliases, coexistência, inspect/apply/rollback, skips/control-flow, parallel/Git/security e signal/resume passaram com source e binários imutáveis | [`compatibility/s10-report.json`](compatibility/s10-report.json), [`compatibility/s10-report.md`](compatibility/s10-report.md), [`scripts/s10-compatibility.ts`](../scripts/s10-compatibility.ts) |
| `EV-S06-CMD-3` | matriz standalone `verify`/`judge` 3/3, 69 asserções | [`s06-command-evidence.test.ts`](../tests/integration/s06-command-evidence.test.ts) |
| `EV-S07-KILL-10` | kill/resume em 10 fronteiras literais: task, tool intent/write, gate, judge, completion prepared/marker/event/commit e outbox pós-commit/pré-projeção | [`s07-kill-injection-matrix.test.ts`](../tests/integration/s07-kill-injection-matrix.test.ts) |
| `EV-S09-E2E-7` | child reservado pré-spawn, nested crash pós-spawn, parallel claims/worktrees, Git integration pós-efeito, conflito e sandbox local 7/7 | [`s09-bounded-e2e.test.ts`](../tests/integration/s09-bounded-e2e.test.ts) |
| `EV-S11-KILL-17` | `test:kill` 17/17, 519 asserções: 13 fronteiras literais de task/tool/gate/judge/completion/child/integration/outbox mais quatro cenários de suporte S09; resumed task/child, marker, diff/evidence, IDs e counters convergem sem replay perigoso | alias `test:kill` em [`package.json`](../package.json), [`s07-kill-injection-matrix.test.ts`](../tests/integration/s07-kill-injection-matrix.test.ts), [`s09-bounded-e2e.test.ts`](../tests/integration/s09-bounded-e2e.test.ts) |
| `EV-S11-PROP-111` | `test:properties` 111/111, 5.205 asserções: PRD/source/graph, transitions, options, usage, redaction, paths/argv, replay/version e progress/resize/goldens; geradores seeded reproduzíveis e renderer OpenTUI headless | alias `test:properties` em [`package.json`](../package.json), [`s11-properties.test.ts`](../tests/unit/s11-properties.test.ts), [`progress.test.ts`](../packages/tui/tests/progress.test.ts), [`dashboard.test.ts`](../packages/tui/tests/dashboard.test.ts) |
| `EV-FAKES-24` | test-kit determinístico 24/24, 163 asserções: provider/judge/OAuth/CLI/process/clock, malformed/silence/heartbeat/freeze/PID reuse/score sequences | [`packages/test-kit/tests/fakes.test.ts`](../packages/test-kit/tests/fakes.test.ts) |
| `EV-PERF-6` | performance/backpressure/retention/replay/TUI/múltiplos projetos 6/6, 67 asserções no baseline Windows | [`s11-performance.test.ts`](../tests/performance/s11-performance.test.ts) |
| `EV-RELSEC-3` | HEAD `b6f62a9976ad717f56eb4e0c81ff16bd70910e0e`: audit vazio, Gitleaks 8.30.1 preso por SHA-256 com report vazio/0 findings e JUnit de licença/provenance 26/26; curadoria Bun exata e inventário OpenCode recalculado | [`release-security-gates.ts`](../scripts/release-security-gates.ts), [`CURATION.json`](../third_party/bun/runtime/1.3.14/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/CURATION.json) |
| `EV-SKILL-FWD-7` | forward test cego: 2 documentos, 7 tasks, validate/inspect strict sem diagnostics | [`ralph-loop-prd-generator`](../skills/ralph-loop-prd-generator/SKILL.md), [`skill-package.test.ts`](../tests/unit/skill-package.test.ts) |
| `EV-WIN-NATIVE` | build e smoke nativos Windows x64 verdes | [`scripts/build.ts`](../scripts/build.ts), [`scripts/smoke.ts`](../scripts/smoke.ts) |
| `EV-CI-S11-SOURCE` | contrato CI bloqueante para seis pares OS/arquitetura e matriz filesystem/process/keychain/Git/sandbox/PTY; ainda sem run remoto | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`workspace.test.ts`](../tests/integration/workspace.test.ts) |
| `EV-S11-FS-12` | workspace Windows x64 12/12, incluindo Unicode/espaço e path acima de 260 caracteres | [`workspace.test.ts`](../tests/integration/workspace.test.ts) |
| `EV-S12-DIST-8` | lifecycle local-contract-only 8/8, 91 asserções: install/update/check/crash recovery/rollback/uninstall/downgrade/schema/tamper sobre fixtures `nightly`/`*-dev.1` unsigned; não é package/install de release | [`standalone-lifecycle.test.ts`](../packages/distribution/tests/standalone-lifecycle.test.ts), alias `test:s12:distribution` em [`package.json`](../package.json) |
| `EV-S12-SAMPLE-59` | sample S12.08 local focado 1/1, 59 asserções: root/child, executor roteirizado, judge external-CLI fake, `72 -> revisão -> 96`, crash/resume, projeção TUI, HTTP real e goldens redigidos; não é standalone instalado, PTY ou provider real | [`s12-sample-e2e.test.ts`](../tests/integration/s12-sample-e2e.test.ts), [`examples/vertical-notes/expected/`](../examples/vertical-notes/expected/) |

### Blockers e lacunas nomeadas

O registro normativo legível por máquina é
[`s11-s12-closure-blockers.json`](s11-s12-closure-blockers.json). Todo blocker tem owner,
disposição, evidence necessária e waiver explicitamente `not-granted`; waiver futuro precisa de
owner, rationale, expiração e digest efetivo do candidato (metadata + payload content address).
`BLK-SOURCE-BINDING` integra a lista normativa de
blockers não-waivable e nunca pode receber waiver aprovado. A tabela abaixo é o resumo humano.

| Blocker ID | Owner | Disposição atual | Evidence necessária |
| --- | --- | --- | --- |
| `BLK-SOURCE-BINDING` | release owner | bloqueia release, não-waivable | HEAD/origin canônica e árvore limpa estáveis antes/depois; inventário/fingerprint estáveis; receipt/manifest e payloads content-verified com repository/commit/fingerprint iguais; envelope content-addressed do mesmo source |
| `BLK-AUTH-REAL` | account/provider owner | bloqueia release | contas, quotas, keychain e chamadas reais de provider/ChatGPT redigidas e candidate-bound |
| `BLK-R015-REVIEW` | parser owner + reviewer independente | bloqueia release | review estático que prove regex somente em leaf tokens/CommonMark, com identidade/data/source digest |
| `BLK-R063-FORGE` | Git/forge owner | bloqueia release | PR e integração em forge remoto controlado, ou decisão/waiver candidate-bound aprovado |
| `BLK-MULTIPLATFORM` | CI/platform owner | bloqueia release | runs, JUnit classificado e artifacts reais dos seis pares OS/arquitetura; skip exige waiver explícito. No Bun 1.3.14 Windows ARM64, `bun:ffi`/TinyCC não existe e o OpenTUI não inicializa: somente os cinco casos interativos recebem waiver temporário; CLI headless, persistência, supervisão e distribuição continuam obrigatórios. |
| `BLK-SANDBOX-EXT` | security/platform owner | bloqueia release | Docker/Podman, isolamento forte e lifecycle sandbox nos hosts suportados |
| `BLK-RELEASE` | release owner | bloqueia release | licença/identidade/support/targets, SBOM/notices/signing, package/install drills e promotion record |
| `BLK-COMPAT-BINARIES` | migration/release owner | bloqueia o run se inputs faltarem/divergirem | `--legacy-binary` e `--next-binary` explícitos cujos hashes casem com o report S10 91/91 |

## Ledger executável S11 por requisito

`validado-localmente` significa somente que a prova específica passou neste checkout. `parcial`
significa que existe evidência real, mas uma parte material do requisito permanece fora dela.
`prova-pendente` indica código/contrato identificado sem a matriz executável mínima. `bloqueado-externamente`
exige conta, artifact, plataforma ou decisão que este checkout não pode inventar.

| R-ID | Owner | Estado atual | Evidence executável ou blocker explícito |
| --- | --- | --- | --- |
| R001 | S03/S05 | `validado-localmente` | `EV-S11-E2E-100`; [`orchestration-runner.test.ts`](../tests/integration/orchestration-runner.test.ts) e [`s05-embedded-e2e.test.ts`](../tests/integration/s05-embedded-e2e.test.ts) rejeitam transição/conclusão alegada pelo executor. |
| R002 | S05 | `validado-localmente` | `EV-S11-SEC-177` e `EV-S11-PROP-111`; [`tool-host.test.ts`](../packages/tool-host/tests/tool-host.test.ts) e [`s05-interactive-permissions.test.ts`](../tests/integration/s05-interactive-permissions.test.ts). |
| R003 | S01/S04 | `parcial` | `EV-CHECK-673` e `EV-WIN-NATIVE`; source/candidate binding e package/provenance de release continuam em `BLK-SOURCE-BINDING` e `BLK-RELEASE`. |
| R004 | S04/S05 | `validado-localmente` | [`s04-dependency-license.test.ts`](../tests/unit/s04-dependency-license.test.ts) e [`opencode-provenance.test.ts`](../tests/unit/opencode-provenance.test.ts). |
| R005 | S04 | `validado-localmente` | `EV-CHECK-673`; [`packages/providers/tests/`](../packages/providers/tests/) e [`opencode-provenance.test.ts`](../tests/unit/opencode-provenance.test.ts). |
| R006 | S04/S06 | `validado-localmente` | `EV-INT-149`; [`s04-services-cli.test.ts`](../tests/integration/s04-services-cli.test.ts) e [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts). |
| R007 | S04 | `parcial` | `EV-S11-SEC-177` e `EV-FAKES-24` cobrem API key/env, OAuth device/browser, malformed/freeze e secret boundaries; chamadas/keychains reais permanecem em `BLK-AUTH-REAL`. |
| R008 | S04 | `parcial` | `EV-FAKES-24` e [`openai-driver-device-auth.test.ts`](../tests/unit/openai-driver-device-auth.test.ts) cobrem os protocolos sem rede/browser real; conta ChatGPT Plus/Pro real permanece em `BLK-AUTH-REAL`. |
| R009 | S05 | `validado-localmente` | `EV-S11-E2E-100` e `EV-FAKES-24`; [`s05-external-e2e.test.ts`](../tests/integration/s05-external-e2e.test.ts) e [`external-cli-backend.test.ts`](../packages/model-drivers/tests/external-cli-backend.test.ts). |
| R010 | S02/S12 | `validado-localmente` | `EV-SKILL-FWD-7` gerou/validou slices verticais a partir de brief bruto e `EV-S12-SAMPLE-59` executou root/child pré-gerados ponta a ponta; [`prd-parser.test.ts`](../tests/unit/prd-parser.test.ts) cobre o contrato estrutural. |
| R011 | Todas | `validado-localmente` | `EV-S11-E2E-100`, `EV-S12-SAMPLE-59`; [`packaged-vertical-slice.test.ts`](../tests/integration/packaged-vertical-slice.test.ts). |
| R012 | S02/S03 | `validado-localmente` | [`context-manifest.test.ts`](../tests/unit/context-manifest.test.ts) e [`orchestration-runner.test.ts`](../tests/integration/orchestration-runner.test.ts). |
| R013 | S02 | `validado-localmente` | `EV-SKILL-FWD-7` recebeu revisão humana independente, e [`prd-cli.test.ts`](../tests/integration/prd-cli.test.ts) validou a forma compilada. |
| R014 | S02 | `validado-localmente` | `EV-S11-PROP-111` e `EV-S11-SEC-177`; [`prd-parser.test.ts`](../tests/unit/prd-parser.test.ts) rejeita aliases, chaves de prototype e UTF-8 inválido, e [`prd-properties.test.ts`](../tests/unit/prd-properties.test.ts) mantém propriedades de source/marker. |
| R015 | S02 | `validado-localmente` | [`packages/prd/src/parser.ts`](../packages/prd/src/parser.ts) e [`prd-parser.test.ts`](../tests/unit/prd-parser.test.ts) documentam o comportamento local; o review independente está vinculado ao snapshot exato no [recibo legível](reviews/r015-parser-static-review.md) e no [recibo JSON](reviews/r015-parser-static-review.json). |
| R016 | S02 | `validado-localmente` | `EV-S11-PROP-111`; [`atomic.test.ts`](../tests/unit/atomic.test.ts), [`prd-marker-format-classic.test.ts`](../tests/unit/prd-marker-format-classic.test.ts) e crash boundaries em [`orchestration-runner.test.ts`](../tests/integration/orchestration-runner.test.ts). |
| R017 | S02/S10 | `validado-localmente` | [`prd-cli.test.ts`](../tests/integration/prd-cli.test.ts), `EV-COMPAT-SRC-5` e `EV-S10-COMPAT-91`; o harness real executou inspect/apply/rollback mantendo origem, config e sentinels imutáveis. |
| R018 | S02/S09 | `validado-localmente` | `EV-S09-E2E-7`; [`prd-graph.test.ts`](../tests/unit/prd-graph.test.ts) valida o graph e a matriz nested executa os Sub-PRDs pré-autorizados. |
| R019 | S02/S12 | `validado-localmente` | `EV-SKILL-FWD-7` materializou root/child antes de qualquer run; [`packages/prd/tests/authority.test.ts`](../packages/prd/tests/authority.test.ts) prova ausência de author port no runtime. |
| R020 | S02 | `validado-localmente` | [`prd-graph.test.ts`](../tests/unit/prd-graph.test.ts) cobre child ausente/ciclo/depth antes da execução. |
| R021 | S09 | `validado-localmente` | `EV-S11-E2E-100` e `EV-S12-SAMPLE-59` provam leaf/child/root uma vez, reconciliação e parent terminal somente depois do child. |
| R022 | S09 | `validado-localmente` | `EV-S09-E2E-7` e `EV-S11-KILL-17`; vínculos duráveis, child/grandchild supervisionados, eventos e retomada pré/pós-spawn do child mais profundo. |
| R023 | S07/S09 | `validado-localmente` | [`s07-persistence-leases.test.ts`](../tests/integration/s07-persistence-leases.test.ts) prova dois projetos isolados; `EV-S09-E2E-7` isola config/claims da árvore executada. |
| R024 | S07 | `validado-localmente` | `EV-S11-KILL-17` e `EV-S12-SAMPLE-59` interrompem e retomam deterministicamente o mesmo run/task; [`s07-worker-resume.test.ts`](../tests/integration/s07-worker-resume.test.ts) prova a prioridade prepared/active/interrupted antes da primeira pending. |
| R025 | S09 | `validado-localmente` | `EV-S11-KILL-17` cobre a reserva pré-spawn e o crash nested pós-spawn, preserva os mesmos child run/link IDs e retoma grandchild antes de child/root. |
| R026 | S07 | `validado-localmente` | `EV-S11-KILL-17` exige diff content-addressed e arquivos acumulados no mesmo run retomado; [`s07-worker-resume.test.ts`](../tests/integration/s07-worker-resume.test.ts) prova o recovery manifest entregue ao contexto seguinte. |
| R027 | S06 | `validado-localmente` | `EV-S11-E2E-100`; deterministic-only em [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts). |
| R028 | S06 | `validado-localmente` | `EV-S11-E2E-100`; cenários self/none em [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts). |
| R029 | S06 | `validado-localmente` | [`judge-domain.test.ts`](../tests/unit/judge-domain.test.ts) e self-review em [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts). |
| R030 | S06 | `validado-localmente` | [`judge-domain.test.ts`](../tests/unit/judge-domain.test.ts) valida score 0–100 e schema. |
| R031 | S06/S08 | `validado-localmente` | `EV-S11-PROP-111`; [`effective-options.test.ts`](../tests/unit/effective-options.test.ts), [`settings-metadata.test.ts`](../tests/unit/settings-metadata.test.ts) e `60 -> 88` em [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts). |
| R032 | S06 | `validado-localmente` | Assessment/feedback em [`judge-domain.test.ts`](../tests/unit/judge-domain.test.ts) e popup de parecer em [`dashboard.test.ts`](../packages/tui/tests/dashboard.test.ts). |
| R033 | S06 | `validado-localmente` | Revisão/exhaustion em [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts) e `72 -> revisão -> 96` em `EV-S12-SAMPLE-59`. |
| R034 | S06 | `validado-localmente` | Retry malformado/transporte separado de revisões em [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts). |
| R035 | S06 | `validado-localmente` | Gate falho não cede a score 100 em [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts). |
| R036 | S03/S06/S10 | `validado-localmente` | `EV-S11-E2E-100` e `EV-S10-COMPAT-91`; [`skip-completion-policy.test.ts`](../tests/unit/skip-completion-policy.test.ts), `EV-COMPAT-SRC-5` e `EV-S03-15`. |
| R037 | S03/S06 | `validado-localmente` | `EV-S11-E2E-100`; budgets, timeout e operações penduradas em [`orchestration-runner.test.ts`](../tests/integration/orchestration-runner.test.ts). |
| R038 | S02/S06/S12 | `validado-localmente` | `EV-S11-E2E-100`; change-only/artifact em [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts) e [`s06-completion-compositions.test.ts`](../tests/unit/s06-completion-compositions.test.ts). |
| R039 | S06 | `validado-localmente` | Change/artifact exatos em [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts) e evidence/artifacts reconciliados em `EV-S12-SAMPLE-59`. |
| R040 | S02/S12 | `validado-localmente` | `EV-SKILL-FWD-7` pré-declarou artifact decisório antes do run; [`s06-prd-gates.test.ts`](../tests/unit/s06-prd-gates.test.ts) prova o contrato compilado. |
| R041 | S07 | `validado-localmente` | `EV-WDG-8` congela um worker real e só declara stall/restart após duas confirmações independentes. |
| R042 | S07/S11 | `validado-localmente` | `EV-WDG-8` cobre quiet/slow, heartbeat, reasoning longo, processo CPU/IO saudável, Retry-After e hard timeout literal que exige duas probes pós-deadline antes da recuperação destrutiva. |
| R043 | S09 | `validado-localmente` | `EV-S09-E2E-7` prova projeção/eventos/status dos children supervisionados; [`watchdog.test.ts`](../tests/hardening/watchdog.test.ts) cobre os sinais de saúde. |
| R044 | S08 | `parcial` | `EV-PTY-3X` e [`dashboard.test.ts`](../packages/tui/tests/dashboard.test.ts) provam Windows x64; POSIX PTY é exercitado na matriz. Windows ARM64 permanece explicitamente limitado pelo `BLK-MULTIPLATFORM`: `--ui auto` cai para apresentação headless, `--ui tui` falha fechado e os cinco casos OpenTUI são skips classificados, não passes. |
| R045 | S04/S08 | `validado-localmente` | `EV-S11-PROP-111`; [`state.test.ts`](../packages/tui/tests/state.test.ts), [`openai-driver-stream.test.ts`](../tests/unit/openai-driver-stream.test.ts) e judge usage em [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts). |
| R046 | S08 | `validado-localmente` | `EV-S11-PROP-111`, `EV-S12-SAMPLE-59`, [`progress.test.ts`](../packages/tui/tests/progress.test.ts), `EV-PTY-3X` e `EV-S03-15`. |
| R047 | S08 | `validado-localmente` | `EV-S11-PROP-111` e `EV-S12-SAMPLE-59`; [`progress.test.ts`](../packages/tui/tests/progress.test.ts). |
| R048 | S08 | `validado-localmente` | `EV-S11-PROP-111` e `EV-S12-SAMPLE-59` cobrem larguras distintas; resize também passa em [`progress.test.ts`](../packages/tui/tests/progress.test.ts), [`dashboard.test.ts`](../packages/tui/tests/dashboard.test.ts) e `EV-PTY-3X`. |
| R049 | S08 | `validado-localmente` | Completion persistida/progresso em `EV-S12-SAMPLE-59`, [`packaged-vertical-slice.test.ts`](../tests/integration/packaged-vertical-slice.test.ts) e [`progress.test.ts`](../packages/tui/tests/progress.test.ts). |
| R050 | S08/S09 | `validado-localmente` | `EV-S09-E2E-7` e `EV-S12-SAMPLE-59` fornecem árvore/progresso durável; `EV-PTY-S08-5` prova child placeholder e escopos/progresso apresentados no terminal real. |
| R051 | S08 | `validado-localmente` | [`dashboard.test.ts`](../packages/tui/tests/dashboard.test.ts), [`ledger.test.ts`](../tests/integration/ledger.test.ts) e `EV-PTY-S08-5`. |
| R052 | S08 | `validado-localmente` | Engine state/raw em [`state.test.ts`](../packages/tui/tests/state.test.ts), refs reais em [`s03-raw-gate-evidence.test.ts`](../tests/integration/s03-raw-gate-evidence.test.ts) e streams model/reasoning/tool/gate/CLI em `EV-PTY-S08-5`. |
| R053 | S08 | `validado-localmente` | [`dashboard.test.ts`](../packages/tui/tests/dashboard.test.ts), `EV-WDG-8`, [`s06-judge-runner.test.ts`](../tests/integration/s06-judge-runner.test.ts) e composição terminal em `EV-PTY-S08-5`. |
| R054 | S04/S08 | `validado-localmente` | [`settings-metadata.test.ts`](../tests/unit/settings-metadata.test.ts), [`dashboard.test.ts`](../packages/tui/tests/dashboard.test.ts) e popup mutável keyboard-driven apply/save em `EV-PTY-S08-5`. |
| R055 | S08/S12 | `parcial` | Temas/snapshots e atribuições OpenTUI locais estão cobertos por [`dashboard.test.ts`](../packages/tui/tests/dashboard.test.ts), [`s06-tui-dependency-license.test.ts`](../tests/unit/s06-tui-dependency-license.test.ts) e [`opencode-provenance.test.ts`](../tests/unit/opencode-provenance.test.ts); review visual/licença de release permanece em `BLK-RELEASE` e a indisponibilidade nativa Windows ARM64 em `BLK-MULTIPLATFORM`. |
| R056 | S08/S10 | `validado-localmente` | [`settings-metadata.test.ts`](../tests/unit/settings-metadata.test.ts) e [`parser.test.ts`](../tests/unit/parser.test.ts). |
| R057 | S01/S08 | `validado-localmente` | [`help-version.golden.test.ts`](../tests/unit/help-version.golden.test.ts), [`cli-output.test.ts`](../tests/integration/cli-output.test.ts) e [`events-redaction.test.ts`](../tests/unit/events-redaction.test.ts). |
| R058 | S07/S08 | `validado-localmente` | `EV-S11-E2E-100` cobre attach TTY-gated e renderer headless; `EV-PTY-S08-5` fecha `q`, progresso sem renderer, reattach em novo processo, Ctrl+C e replay imutável. |
| R059 | S05/S08 | `validado-localmente` | `EV-S11-PROP-111` e `EV-S11-SEC-177`; [`s03-redaction.test.ts`](../tests/integration/s03-redaction.test.ts) prova ausência do canary em ledger/event/report/raw e [`tool-execution-port.test.ts`](../apps/ralph-cli/tests/tool-execution-port.test.ts) mantém output bounded/redigido. |
| R060 | S05 | `validado-localmente` | `EV-S11-SEC-177`; backend adversarial em [`orchestration-runner.test.ts`](../tests/integration/orchestration-runner.test.ts) e PRD/repo/model completion tratados como alegação em [`s05-embedded-e2e.test.ts`](../tests/integration/s05-embedded-e2e.test.ts). |
| R061 | S09 | `validado-localmente` | `EV-S11-E2E-100` executa dois workers em worktrees distintas, claims transacionais, commits, merge e cleanup; `EV-S11-KILL-17` prova recuperação pós-efeito sem repetir executor ou merge. |
| R062 | S09 | `validado-localmente` | `EV-S09-E2E-7` provoca conflito Git real, pausa em `waiting` e preserva o conflito sem escolher `ours`/`theirs`. |
| R063 | S09/S10 | `parcial` | `EV-S09-E2E-7`, [`git-runtime.ts`](../packages/orchestration/src/git-runtime.ts) e [`checkpoint-commands.ts`](../packages/commands/src/checkpoint-commands.ts) provam Git/checkpoint locais; criação de PR/forge remoto permanece em `BLK-R063-FORGE`. |
| R064 | S09 | `parcial` | `EV-S11-E2E-100` e `EV-S11-SEC-177` cobrem process sandbox, cleanup, safe/auto/dangerous, headless ask, paths/argv e fail-closed; Docker/Podman/isolamento forte permanecem em `BLK-SANDBOX-EXT`. |
| R065 | S04/S11 | `validado-localmente` | `EV-S11-SEC-177` e `EV-S11-PROP-111` cobrem canaries e boundaries de credencial em runtime; o gate de source/release permanece separado em S11.10/`EV-RELSEC-3`. |
| R066 | S04/S12 | `parcial` | `EV-RELSEC-3`, [`opencode-provenance.test.ts`](../tests/unit/opencode-provenance.test.ts) e [`s04-dependency-license.test.ts`](../tests/unit/s04-dependency-license.test.ts); inventário/SBOM do candidate dependem de `BLK-RELEASE`. |
| R067 | S04/S12 | `validado-localmente` | Boundary/dependency review em [`s04-dependency-license.test.ts`](../tests/unit/s04-dependency-license.test.ts) e [`opencode-provenance.test.ts`](../tests/unit/opencode-provenance.test.ts). |
| R068 | S03/S10 | `validado-localmente` | `EV-COMPAT-SRC-5`, `EV-S03-15` e `EV-S10-COMPAT-91`; a matriz integral classificou 65 superfícies e encerrou sem regressions. |
| R069 | S10/S12 | `parcial` | `EV-S10-COMPAT-91` provou coexistência/migração lado a lado e `EV-S12-DIST-8` provou lifecycle sintético local; install/update/rollback de artifacts reais de release continuam em `BLK-RELEASE`. |
| R070 | S11/S12 | `parcial` | `EV-WIN-NATIVE`, `EV-S11-FS-12`, `EV-S12-DIST-8` e `EV-CI-S11-SOURCE`; o workflow cobre seis pares, path longo/Unicode, process tree/signals, keychain fake, Git/sandbox e PTY. Windows ARM64 mantém toda a matriz não visual, mas os cinco casos OpenTUI são waiver temporário por ausência de `bun:ffi`; archive final e demais runs permanecem em `BLK-MULTIPLATFORM`. |
| R071 | S08 | `validado-localmente` | `EV-S11-PROP-111` e `EV-S11-SEC-177`; consumer preserva adições v1, rejeita major v2 e o ledger recompõe tail JSONL truncado; `EV-S11-KILL-17` prova commit/outbox/projeção após crash sem duplicar event IDs. |
| R072 | S08/S11 | `validado-localmente` | `EV-PERF-6`, [`s08-event-storm.test.ts`](../tests/integration/s08-event-storm.test.ts) e [`event-stream.test.ts`](../packages/tui/tests/event-stream.test.ts) provam storm/output bounded sem bloquear persistência/heartbeat/render. |
| R073 | S08 | `validado-localmente` | Fase separada da barra em [`dashboard.test.ts`](../packages/tui/tests/dashboard.test.ts) e [`progress.test.ts`](../packages/tui/tests/progress.test.ts). |
| R074 | S01 | `validado-localmente` | Checkout atual e paths com espaço/Unicode em [`workspace.test.ts`](../tests/integration/workspace.test.ts), mais `EV-WIN-NATIVE`. |
| R075 | S06/S08 | `validado-localmente` | Snapshot imutável em [`execution-state.test.ts`](../tests/unit/execution-state.test.ts), attach read-only em [`execution-cli.test.ts`](../tests/integration/execution-cli.test.ts) e apply/save pré-run mais attach/replay hash-idêntico em `EV-PTY-S08-5`. |
| R076 | S06.12 | `validado-localmente` | `EV-S06-CMD-3` reexecuta gates/evidence, persiste receipt/eventos e compara state-before/after sem executor, ToolHost ou marker mutation. |
| R077 | S06.12 | `validado-localmente` | `EV-S06-CMD-3` cobre external default, self explícito, backend read-only/mutante, parecer/receipt e zero aplicação de revisão/task. |
| R078 | S06.12 | `validado-localmente` | `EV-S06-CMD-3` cobre seletores exatos, IDs ausentes, ambiguidade e erros determinísticos sem escolha silenciosa da run recente. |
| R079 | S06.12 | `validado-localmente` | `EV-S06-CMD-3` verifica source ad hoc persistida, sem PRD/marker/gates inventados, e falha em objeto ausente/adulterado. |

## Controle de mudanças

Novo requisito recebe ID e linhas correspondentes antes da implementação. Se uma decisão for
removida, a linha permanece com estado/rationale em ADR; não é simplesmente apagada. S11.12 falha
estruturalmente se algum requisito obrigatório não tiver owner e evidence exata ou blocker/waiver
explícito. Estado `parcial` continua bloqueando promoção; não equivale a pass.
