# Changelog

Todas as mudanças relevantes do Ralph v2 serão registradas neste arquivo. O projeto segue SemVer
somente depois que um channel for promovido; builds `dev` e `nightly` não constituem suporte estável.

## [Unreleased]

## [0.1.0-beta.2] — candidato de hardening

### Fixed

- Portabilidade de workers/gates Bun, leitura SQLite em WAL no macOS, encerramento de árvores de
  processo sem FFI no Windows ARM64, resize PTY nativo e isolamento de refs Git paralelas.
- Fixtures e budgets da matriz de CI alinhados ao schema/migrations atuais e a runners mais lentos.
- Flush determinístico de evidence grande em Unix, heartbeat de encerramento tolerante a mensagens
  autenticadas em trânsito, normalização C1 do ConPTY e fallback PowerShell 7 para identidade de
  processo em Windows ARM64.
- Serialização somente das mutações de metadata compartilhada de `git worktree`, preservando a
  execução paralela dos workers, e lifecycle PTY com Ctrl+C convergindo pela mesma bridge de comando
  usada em produção e resultado estruturado durável fora do canal ConPTY desmontado.

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
- Curadoria offline do runtime Bun `1.3.14` presa ao commit exato, com licença/notice upstream,
  provenance de tag/release/assets e receipts determinísticos usados pelo SBOM standalone.
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

- O primeiro beta promove somente `bun-windows-x64-baseline`; os outros cinco targets permanecem
  `not-promoted` na support policy. Windows ARM64 executa o caminho headless na CI, mas a TUI OpenTUI
  não é suportada pelo runtime Bun 1.3.14 desse target.
- Nenhum signer/trust root foi configurado para este beta. Manifest e package declaram assinatura
  indisponível de forma explícita; checksums e source binding não constituem assinatura.
- Smokes de provider/API key/OAuth/ChatGPT reais são opt-in e não foram inferidos a partir da sessão
  do operador. A ausência de credenciais elegíveis permanece `not-executed` no handoff.
- A campanha beta mantém `ralph-next`; o alias `ralph` não é oferecido e o Ralph clássico permanece
  intacto. O pacote npm é produzido e verificado localmente, mas publicação no registry exige
  credencial explícita do proprietário.

## [0.1.0-dev.1] — não publicado

- Versão de trabalho inicial usada apenas para identificar manifests, schemas e artifacts locais.
