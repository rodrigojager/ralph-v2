# ADR 0004 — Contrato de CLI, configuração, output e packaging

- Estado: aceita
- Data: 2026-07-18
- Slice: S01
- Documentos relacionados: `docs/04-cli-comandos-flags-e-precedencia.md`, `docs/05-configuracao-perfis-e-tui.md`, `docs/11-eventos-telemetria-logs-e-relatorios.md`, `docs/14-compatibilidade-migracao-distribuicao-e-licencas.md`, `docs/17-contratos-e-schemas.md`

## Contexto

A primeira slice precisa ser útil em terminal e automação antes da TUI. Isso exige que parser, config, saída, diagnostics e exit codes formem um único contrato, e que o executable rode fora do checkout. Também é necessário distinguir o que foi executado nativamente do que apenas foi compilado para outro target.

O Ralph clássico possui comportamentos que nem sempre correspondem à interface planejada, por exemplo aceitar `--version` mas não necessariamente um subcomando `version`. A v2 precisa medir essas diferenças, não manter quirks que prejudiquem automação sem decisão explícita.

## Decisão

### Nome e superfície S01

- Manter `ralph` até o gate final de migração.
- Implementar `help`, `version`, `about`, `init`/`setup`, `status`, `doctor`, `config explain` e `config list`.
- Não registrar comandos de provider/modelo, execução de task ou TUI antes das slices proprietárias.
- Flags desconhecidas/duplicadas, valores ausentes e combinações inválidas falham com exit code 2 e diagnostic estável.

### Configuração

- YAML em `.ralph/config.yaml` é o formato humano canônico; schema runtime estrito usa versão 1.
- Arquivos global/workspace são overlays parciais estritos sobre defaults; `init` materializa somente `schema_version: 1`, para que a precedência global continue útil. O effective config é sempre validado como documento completo.
- Nesta slice, a precedência é `CLI > env suportado > workspace > global > builtin`.
- Mapeamentos de ambiente são uma allowlist (`RALPH_MODE`, `RALPH_UI`, `RALPH_LANG`); o prefixo por si só não autoriza importação.
- `RALPH_CONFIG_HOME` é override de localização, especialmente para testes isolados.
- `config explain` mostra valor final, origem e referência; futuros segredos aparecem somente como refs redigidas.
- `profiles` e `extensions` ficam reservados como objetos vazios na S01; aceitar conteúdo arbitrário antes dos schemas/credential refs da S04 criaria uma rota de vazamento em `config list`.
- A S01 usa diretamente o shape YAML `snake_case` no bootstrap; a normalização para tipos internos `camelCase`, além de `gates`/`tui` completos, entra com os schemas das slices proprietárias antes de se tornar contrato consumido por engines.

### Output e diagnostics

- Resultados estruturados usam `CommandResult<T>` schema v1.
- `human` é texto conciso; cor depende de TTY/policy.
- `json` emite um único documento e `jsonl`, na S01, um resultado por linha. O stream operacional completo fica para S08.
- JSON/JSONL nunca recebe banner, ANSI ou logs humanos em stdout.
- Diagnostics humanos vão para stderr. Erros em formato estruturado preservam o envelope solicitado em stdout e usam exit code como autoridade de sucesso operacional.
- `--debug` adiciona detalhes redigidos; jamais expõe cause/secret bruto.
- Exit codes 0–10 são compartilhados com os schemas normativos. Os nomes semânticos `notFound` e
  `permissionDenied` são aliases internos dos códigos `operationalError` (1) e `policyDenied` (10),
  respectivamente; não criam valores públicos adicionais.

### Doctor

O `doctor` da S01 verifica somente runtime, Git, filesystem, TTY e identidade/state local. Não importa drivers nem faz network/provider/model call. Checks de auth, callback, container e provider chegam nas slices correspondentes.

### Packaging

- `bun run build` gera bundle JavaScript e standalone do target nativo.
- `bun run build:all` compila a lista fechada Windows/Linux/macOS x64/arm64 suportada pelo script.
- O compiler recebe flags que impedem autoload implícito de `.env`, `bunfig`, `package.json` e `tsconfig` no executable.
- Metadata registra target, versão/revisão Bun e SHA-256 com estado inicial `built-not-tested`.
- Metadata também registra fingerprint determinístico do source e da receita de build; harness/smoke recusam artefato stale ou cujo SHA-256 diverge.
- Smoke copia o binário nativo validado para diretório temporário externo e executa comandos JSON em workspace com espaços/Unicode.
- Cross-build é prova de construção, não de execução. CI nativo é a evidência de plataforma desta fase.
- Relatório de compatibilidade versionado exige standalone nativo fresco e realmente executado. O modo source é aceito apenas de forma explícita com `--next-source --no-write`.
- A matriz do relatório contém os seis targets e usa estados distintos `tested`, `built-not-tested` e `not-evidenced`; somente execução do binário pode produzir `tested`.

## Separação stdout/stderr

| Situação | stdout | stderr | exit code |
| --- | --- | --- | --- |
| human sucesso | resultado humano | vazio | 0 |
| human erro | vazio ou resultado parcial documentado | diagnostic humano | conforme tabela |
| JSON sucesso | `CommandResult` v1 | vazio | 0 |
| JSON erro | `CommandResult` v1 com `ok=false` | diagnostic operacional somente se necessário | conforme tabela |
| JSONL S01 | um `CommandResult` v1 por linha | sem banner/log humano | conforme tabela |

Consumers não devem inferir sucesso apenas da presença de JSON; devem validar `ok` e exit code.

## Consequências

### Positivas

- A mesma camada de comandos atende terminal, CI e TUI futura.
- Configuração efetiva é auditável e não depende de popup.
- Automação recebe schema e exit code previsíveis.
- Suporte de plataforma não é superestimado por cross-compilation.

### Custos e riscos

- A v2 possui mudanças deliberadas em relação a quirks do CLI clássico.
- Output público e exit codes passam a exigir testes golden/black-box antes de alterações.
- Standalone Bun precisa de smoke por plataforma a cada mudança de processo/filesystem/package.

## Evidência esperada

- Goldens human/JSON e casos de erro sem banner/ANSI/secret.
- Testes de precedência e `config explain` com origem correta.
- `doctor --non-interactive --format json` não chama rede/provider.
- Build nativo seguido de smoke externo ao checkout.
- Harness antigo/novo classifica diferenças em Markdown e JSON sem normalizar comportamento real.
