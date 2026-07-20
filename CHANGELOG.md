# Changelog

Todas as mudanças relevantes do Ralph v2 serão registradas neste arquivo. O projeto segue SemVer
somente depois que um channel for promovido; builds `dev` e `nightly` não constituem suporte estável.

## [Unreleased]

- Nenhuma mudança acumulada depois do primeiro candidato beta.

## [0.1.0-beta.1] — candidato não publicado

### Added

- Runtime TypeScript/Bun independente sob o nome coexistente `ralph-next`.
- PRD v2 humano e determinístico, Sub-PRDs pré-autorizados e execução command-owned.
- Providers/perfis independentes para executor e judge, ToolHost, evidence bundles e revisões.
- Price snapshots imutáveis, custo reportado ou derivado com proveniência separada,
  settlement final obrigatório e budgets de tokens/custo cumulativos por task.
- Supervisor, leases, watchdog, telemetria, TUI live/attach/replay e configuração pré-run.
- Política efetiva de telemetria congelada por run, raw diagnóstico redigido e
  rotacionado por processo, retenção bounded e poda de eventos orientada pelo
  snapshot do próprio run terminal.
- Child runtime em workers Ralph supervisionados com lease/IPC/budget compartilhado, além de
  paralelismo, Git, checkpoints, sandbox, segurança e migração v1.
- Watchdog de child com heartbeat/ping/processo independentes, silêncio de progresso não destrutivo
  e `restart-attempt` real, retomável e limitado por budget persistido.
- Skill distribuível `ralph-loop-prd-generator` para geração neutra de vertical slices.
- Guias consolidados de usuário/operação, manifest de release, launcher estável e distribuição
  transacional com staging, receipt, update, rollback e uninstall delimitados.
- Origem npm/dev composta pelo entrypoint para que `update --check` devolva orientação fail-closed
  antes de exigir um install root, sem executar package manager ou Git.
- Guia do operador para o `ScriptedExecutionBackend` test-only e exemplos de CLI em linhas únicas,
  copiáveis também no PowerShell.
- Packagers standalone/npm fail-closed, SBOM CycloneDX, promotion record v3 R001–R079 e handoff gate
  que distinguem `built-not-tested`, `tested` e suporte real.
- Alias standalone `ralph` opt-in, receipt-bound e reversível, com preview confirmado, gate de
  receipt `stable`, colisão fail-closed e nenhuma alteração de `PATH` ou bin npm implícito.
- Worksheet de drills/beta com diagnostics locais e retorno ao Ralph clássico, além do handoff
  S01–S12 ampliado para campanha, smokes, decisões e refresh upstream.

### Security

- State v2 isolado, credenciais por referência, paths/commands estruturados, judge read-only e
  política explícita para efeitos externos.
- Camadas de profile preservam proveniência por folha, rejeitam material secreto também em YAML
  editado manualmente e falham fechado para combinações `embedded` + `--cli-*` ou troca de escopo
  divergente no formulário.
- Promotion attestations standalone exigem referência content-addressed não vazia; o packager final
  recusa inventário extra/ausente antes do commit, e o artifact separado da skill carrega licença e
  notices próprios.
- A promoção npm v2 revalida a promoção standalone contra receipt independente, separa artifacts de
  evidências externas, exige cobertura real por OS/arquitetura e inclui o receipt no binding e no
  inventário; o contrato do receipt integra o catálogo público e todo output é rechecado após a
  releitura externa final. SIGINT/SIGTERM cancelam os packagers em duas fases antes do commit atômico.
- Streams, capturas e retenção de telemetria compartilham lease cross-process com identidade de
  processo; paths/handles/parents são revalidados contra links, hard links e TOCTOU, e remoções usam
  quarentena restaurável antes do unlink.

### Known limitations

- A validação executável local não está suspensa: gate 673/673, integração 149/149,
  `EV-S12-DIST-8` 8/8 (91 asserções) e sample S12.08 1/1 (59 asserções) foram observados no checkout
  Windows x64; isso não é evidence de release candidate.
- O runner de archive estrutural S11.12 está implementado, mas ainda não foi executado. R015 e R063
  permanecem parciais, os gates externos/candidate-bound continuam abertos e nenhum release
  candidate foi promovido.
- A identidade foi fixada em MIT, package/binário `ralph-next`, repositório
  `rodrigojager/ralph-v2`, canal `beta` e schemas versionados publicados por GitHub Pages. O
  candidato permanece não publicável até os gates multiplataforma, license inventory e closure.

## [0.1.0-dev.1] — não publicado

- Versão de trabalho inicial usada apenas para identificar manifests, schemas e artifacts locais.
