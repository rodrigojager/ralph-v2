---
task: Entregar paridade operacional configuração completa e migração lado a lado
engine: codex
---

# Subplano S10 — Comandos operacionais e migração

## Resultado do subplano

Os fluxos úteis do Ralph atual têm equivalente, alias ou decisão explícita. O usuário administra tasks, config, adapters, recipes, contexto, logs, reports, checkpoints, instalação e diagnóstico pela linha de comando ou pela TUI quando visual. Um workspace antigo é inspecionado e migrado de modo reversível sem misturar state.

## Referências obrigatórias

- `docs/02-escopo-e-modos-de-trabalho.md`
- `docs/04-cli-comandos-flags-e-precedencia.md`
- `docs/05-configuracao-perfis-e-tui.md`
- `docs/14-compatibilidade-migracao-distribuicao-e-licencas.md`

## Tarefas

- [x] S10.01 consolidar command registry/metadata como fonte única de help, completion, parser e command palette; implementar aliases/deprecations e matriz de commands/flags do Ralph antigo com classificação compatible/changed/deprecated/removed e tests black-box.
- [x] S10.02 completar `run|loop|once|parallel`, `status`, `events`, `resume`, `stop`, `ui|attach`, `logs tail` e `report last`, incluindo human/JSON/JSONL, filtros, argumentos externos tipados por `--cli-arg` e exit codes normativos.
- [x] S10.03 implementar `tasks list|next|done|sync` de modo que `done` manual exija evidence/override policy e nunca contorne silently gates; adicionar PRD revision/hash conflict e audit trail.
- [x] S10.04 implementar `config list|get|set|unset|edit|explain|validate`, escopos global/workspace/profile, imports/exports redigidos e parity test que garante metadata compartilhada com todos os popups TUI.
- [x] S10.05 implementar `auth`, `providers`, `models`, `adapters` e `recipes`, incluindo manifests/schemas/capabilities, validation e importer opt-in de adapters/recipes antigos sem executar scripts durante inspect.
- [x] S10.06 implementar `context inspect|export|rotate`, `rules`, `checkpoint(s)`, `clean` seguro, `doctor`, `about`, `version`, `lang`, `install` e `update` conforme estágio, com preview para mutações e capability diagnostics.
- [x] S10.07 construir `migrate inspect` read-only para PRD/config/state/adapters antigos, mapeando options, secret refs, active state e itens não suportados em report human/JSON sem tocar origem/destino.
- [x] S10.08 implementar `migrate apply` para destino v2 separado com backup, temp writes, validation e rollback manifesto; não converter run ativo como concluído e selecionar a primeira task não finalizada somente após markers validados.
- [x] S10.09 provar coexistência `ralph` antigo/`ralph-next`, diretórios/configs/credential refs separados, paths com espaços, aliases e rollback; adicionar guia com comandos exatos e aviso antes da troca de nome.
- [x] S10.10 executar compatibility harness completo, classificar cada divergência, corrigir regressões obrigatórias e publicar matriz atualizada com evidência real; manter opções de skips/fast/no-change/retry/fail-fast/parallel/Git/security existentes.

## Critérios de conclusão

- Não há command/popup sem metadata/contraparte adequada.
- Help, JSON e exit codes são estáveis e testados.
- Migração começa por inspect e não sobrescreve origem.
- Secrets antigos viram referências, nunca texto copiado para config.
- Ralph antigo e novo executam lado a lado.
- Toda incompatibilidade restante está explicitamente documentada e aprovada.

## Verificação mínima

```text
ralph-next help --format json
ralph-next config explain evaluation.threshold --format json
ralph-next tasks list --format json
ralph-next doctor --format json
ralph-next migrate inspect <legacy-workspace> --format json
ralph-next migrate apply <legacy-workspace> --destination <temp-workspace>
ralph-next migrate rollback <rollback-manifest.json> --dry-run --format json
ralph-next migrate rollback <rollback-manifest.json> --confirm-plan-hash <sha256> --format json
```

## Estado de implementação e validação local

- command registry/aliases/classificação, `clean`, `tasks list|next|done|sync`,
  `config list|get|preview|set|unset|edit|import|export|explain|validate`, `adapters`, `recipes`,
  `rules`, `context inspect|export|rotate`,
  `checkpoint(s) list|show`, `lang` e `migrate inspect|apply|rollback` foram implementados
  estaticamente; rollback foi validado pela matriz focada e pelo drill de coexistência descritos abaixo;
- o union canônico e a resolução longest-prefix de comandos/aliases do parser derivam do registry;
  o dispatch é exaustivo em compile time e o help human/JSON expõe aliases e classificação. O mesmo
  catálogo produz projections bounded e format-neutral para completion e command palette, incluindo
  compatibilidade, replacement/removal quando aplicáveis e texto pesquisável. Integrações específicas
  de shell e o renderer visual permanecem adapters sobre essas projections, não novas listas de
  comandos; allowed options e regras de argumentos continuam explícitas no parser;
- `config unset` usa metadata schema-known e poda somente pais vazios; `edit` usa uma porta de
  aplicativo segura ou arquivo headless, vincula o candidato ao hash do alvo anterior à edição e lê
  o resultado temporário por identidade estável; `import` faz preview/merge bounded de config e profiles
  tipados sem secrets/extensions; `export` produz YAML/JSON redigido para stdout ou arquivo contido
  e atômico. Writers compartilhados de settings/profiles/transfer usam lock interprocesso por arquivo
  antes do read-modify-write, sem auto-reclaim por idade; mutação global revalida o workspace ativo
  quando disponível. A configuração de profile recompõe e valida o grafo efetivo sobre a camada mais
  recente dentro do mesmo lock antes do commit. Escopo é explícito e mutações alteram somente defaults
  de runs futuros;
- a migração é read-only no inspect, usa destino separado, omite secrets, põe imports opt-in em
  quarentena, inventaria heartbeat/checkpoints sem importá-los, recusa conversão de run ativo e
  grava report/backup/rollback manifest/handoff;
- `migrate rollback` agora possui superfície pública human/JSON em duas fases. O preview valida o
  manifest strict/location-bound, containment, duplicatas, links e hashes sem escrever; apply exige
  o hash exato, recompõe o plano sob lease e remove somente arquivos criados ainda idênticos, o
  manifest confirmado e diretórios vazios. Origem e arquivos não relacionados nunca entram no plano;
  o teste focado passou 5/5 (32 expects) e o golden de help 3/3. Depois, o coordenador integral
  executou o cenário lado a lado equivalente com temp roots espaço/Unicode, hashes, sentinels e
  config roots separados. O script `scripts/s10-migration-coexistence-drill.ps1` permanece uma
  alternativa manual focada e não é usado como falsa substituição do report integral;
- adapters novos são drafts data-only desativados; recipes/rules permanecem legíveis por humanos;
  nenhum comando de inspect/list/show executa adapter, recipe ou script;
- context export é metadata-only e rotate depende de porta explícita do supervisor. `checkpoint create`
  e `rollback preview|apply` reutilizam os handlers command-owned da S09; list/show continuam
  read-only, preview não muta e apply exige plano/hash explícitos;
- `doctor` compõe a mesma discovery de sandbox usada pelo runtime e sonda somente o backend
  explicitamente configurado quando sandbox está habilitado. A saída human/JSON diferencia backend
  desabilitado, indisponível, contenção local por policy/supervisão e isolamento de container sem
  prometer uma fronteira que a capability não oferece;
- `install|update|rollback|uninstall` agora possuem handlers e runtime de distribuição compostos
  estaticamente pela S12; `update --check` faz o mesmo preflight em staging sem ativar. O dispatcher
  público de S10 foi validado com uma porta data-only explicitamente injetada, enquanto a composição
  normal continua usando o runtime real. Licença, signer/verifier/trust policy, artifacts, publicação
  e drills reais continuam gates de release da S12; não são critério de fechamento da superfície de
  comandos da S10.06;
- a matriz honesta está em `docs/compatibility/s10-command-matrix.md` e o guia operacional em
  `docs/22-migracao-ralph-v1-s10.md`;
- `once "descrição"` foi separado deterministicamente de `once --task ID`: a fonte ad hoc é
  persistida/retomável, usa evidence/report record-only; o CLI não materializa nem conclui
  PRD/sub-PRD/marker e um gate bloqueia qualquer violação observada do backend;
- comandos ainda ausentes ou dependentes de outra slice permanecem explicitamente classificados na matriz;
- S10.01–S10.05 e S10.07–S10.08 estão fechadas no escopo de implementação/contrato: `check` passou
  com 673 testes, a integração completa com 149/149 e a suíte de segurança com 91/91. O addendum
  S03 passou 15/15 e o compatibility harness source-only passou 5/5;
- S10.06 está fechada no escopo de comando/contrato. O teste dedicado
  `tests/integration/s10-operational-commands.test.ts` passou 6/6 com 86 asserts pelo wrapper oculto
  e prioridade `BelowNormal`: provou preview/force/safety de `clean`; list/add idempotente/clear
  force-gated de `rules`; inspect/export metadata-only e rotate por porta de `context`; create/list/show
  e aliases de `checkpoint(s)`; current/list/set/update sem mutação de `lang`; e install/update dry-run
  mais `update --check`/preflight por porta data-only, em human/JSON, com exit codes e ausência de
  mutação verificadas. `doctor`, `about` e `version` permanecem cobertos pelas validações focadas e
  gerais já registradas. A prova real de distribuição e publicação pertence à S12 e não reabre esta
  slice;
- S10.09 e S10.10 foram fechadas por `docs/compatibility/s10-report.{json,md}`: execução de
  `2026-07-20T15:37:43.103Z`, 91/91 checks, zero regressions e zero surface regressions, com
  `ralph 0.2.0` e `ralph-next 0.1.0-beta.2` reais, source `f757b820...`, binário next
  `8c7ef683...` e ambos os binários imutáveis. Coexistência, mensagens reais PT/EN do legado,
  inspect/apply/rollback e suites vinculadas ficaram verdes. A matriz multiplataforma,
  provider/auth real e install de release continuam em S11/S12 e não são inflados por essa prova
  local.
