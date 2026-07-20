# 15 — Testes, qualidade e definição de pronto

## Estratégia

O Ralph governa modelos não determinísticos, mas seu próprio comportamento deve ser majoritariamente determinístico e testável sem chamar serviços pagos. Providers reais entram em smoke tests opt-in; a suíte principal usa fakes, fixtures gravadas/redigidas e clocks/processes controlados.

## Pirâmide de testes

### Unitários

- state transitions e invariantes;
- option precedence/config explain;
- ID/path/duration/budget parsing;
- progress bar e token aggregation;
- score/threshold/severity;
- retry/revision/watchdog counters;
- redaction e capability resolution;
- command construction sem shell injection.

### Property-based

- parse/format/parse do PRD preserva graph;
- marker edit altera somente o byte previsto;
- graph cycle/dependency ordering;
- barra: `0 <= fill <= width`, monotonicidade e 100%;
- usage snapshots/deltas nunca dupla contam;
- event replay é idempotente;
- normalized paths não escapam root;
- arbitrary resize/totals não quebra layout.

### Golden/fixtures

- PRD v1/v2 válido e diagnostics inválidos;
- provider streams text/reasoning/tools/errors/usage;
- CLI adapter outputs por engine/model;
- judge JSON válido/inválido/fora de range;
- reports human/JSON;
- TUI snapshots por largura/tema/ASCII/locale;
- compatibility outputs sanitizados.

### Integração

- supervisor + ledger + event outbox;
- fake model -> tool host -> diff -> gates -> completion;
- external CLI backend;
- credential ref/keychain fake/OAuth callback fake;
- child run e parent completion;
- worktree/parallel/integration;
- sandbox capability;
- attach/replay/headless JSONL.

### End to end

Projetos fixture de tecnologias diferentes comprovam neutralidade. Cada cenário roda o binário empacotado:

- slice simples com criteria/test;
- full-stack fixture atravessando UI/API/data;
- task `change-only`;
- artifact task sem critério semântico inventado;
- judge externo fake reprova, executor revisa e aprova;
- self-review e deterministic-only;
- skip tests/fast/no-change;
- OAuth/account mock e API key;
- provider fallback permitido/proibido;
- child PRD profundo;
- parallel non-conflicting e conflict;
- crash/resume em fases críticas;
- watchdog slow versus stalled;
- TUI PTY resize/popup/close/reattach.

## Fake providers

O test kit deve programar scripts de eventos:

```text
emit text -> request tool -> wait -> emit usage -> finish
hang with heartbeat
hang without heartbeat
rate limit then recover
malformed tool args
partial stream disconnect
judge score sequence 60, 88
```

Clock monotônico virtual evita sleeps longos. Fake process tree simula PID reuse, child orphan e exit races. OAuth fake valida state/PKCE/refresh sem token real.

## Kill/crash matrix

Injetar encerramento após:

- lease acquired;
- task marker `[~]`;
- attempt started;
- model text/tool intent;
- write concluída antes do settlement;
- gate iniciado/concluído;
- judge response antes de persistir;
- completion prepared antes/depois do marker;
- child created antes/depois do spawn;
- Git integration;
- event outbox commit.

Para cada ponto, reabrir e provar:

- mesma task/child é retomada;
- não há duplicação perigosa;
- diff/artifacts persistem;
- counters corretos;
- marker e ledger reconciliam;
- próxima task não começa cedo.

## Watchdog false-positive matrix

- model silencioso com control heartbeat;
- reasoning longo sem text delta;
- provider envia retry-after;
- build longo com CPU/IO e sem stdout;
- process dormindo legitimamente dentro de timeout;
- event consumer/TUI lento, worker saudável;
- child ativo com parent quiet;
- congelamento real de IPC/process;
- PID morto/reciclado;
- hard timeout real.

Somente cenários reais de stall devem executar recovery. Os demais podem mostrar quiet/slow sem matar.

## Segurança

- secret canaries em env/header/output não chegam a logs/report/event;
- path traversal, symlink e junction escape;
- command/argument injection;
- malicious PRD/repo prompt tentando marcar completion;
- tool schema abuse e oversized output;
- judge tentando pedir tool de escrita;
- unsafe headless `ask`;
- external effects/idempotency;
- corrupt state/event/PRD/YAML bomb bounds;
- dependency/licensing/SBOM scans em release.

## Cross-platform

CI por plataforma testa:

- path separators, spaces, unicode e long paths;
- signals/process trees/terminal resize;
- keychain adapter;
- Git worktrees/file locks/newlines;
- Docker/Podman apenas onde disponíveis, com capability skip explícito;
- standalone/package install/update/doctor;
- `NO_COLOR` e shells relevantes.

Skip de plataforma nunca é rotulado pass; aparece na matriz.

## Performance e robustez

- PRD com milhares de tasks e graph children;
- event stream intenso/backpressure;
- output bruto grande e rotation;
- resume/replay de run longo;
- múltiplos projetos simultâneos;
- memória da TUI bounded;
- startup/status sem resolver providers desnecessariamente;
- migrations de ledger com backup.

Metas numéricas devem ser fixadas após benchmark baseline, não inventadas no plano. Regressions têm budget versionado.

## Gates de desenvolvimento

Por slice, conforme aplicável:

- formatter/lint/typecheck;
- unit/property/golden afetados;
- integration/E2E vertical da slice;
- license/provenance se houver upstream;
- docs/schema/examples na mesma mudança;
- `git diff --check` e artifact/package checks.

Antes de release:

- suíte completa e compatibility matrix;
- cross-platform install smoke;
- security/secret/license/SBOM;
- crash/watchdog/PTY suites;
- docs link/schema validation;
- upgrade/migration/rollback drill.

## Definição de pronto por task de implementação

Uma task só é concluída quando:

1. entrega o comportamento vertical descrito, não apenas um módulo isolado;
2. integra CLI/domain/persistence/events/TUI ou headless necessários;
3. possui teste no menor nível e pelo menos um teste do fluxo atravessado;
4. falhas e retomada relevantes estão cobertas;
5. config/CLI/TUI têm paridade quando a task introduz setting;
6. schema/doc/exemplo foram atualizados;
7. código upstream tem provenance/licença;
8. não há TODO bloqueante escondido;
9. relatório/evidência demonstra o critério;
10. task pai só é marcada quando seu subplano inteiro passa.

## Definição final de pronto do Ralph v2

- S01–S12 e todos os subplanos concluídos;
- invariantes de `docs/01-*` verificadas;
- requisitos rastreados sem gaps obrigatórios;
- CLI e TUI operam sobre mesmo supervisor/events;
- providers/auth executor e judge independentes;
- PRD/sub-PRD parser forte e skill adaptada;
- judge/revision/deterministic-only completos;
- resume/watchdog/children/parallel validados por kill tests;
- barra completed/total responsiva comprovada;
- compatibilidade/migração/releases/licenças aprovadas;
- documentação permite instalar, configurar, executar, diagnosticar e recuperar;
- nenhuma reivindicação de suporte real se baseia apenas em compile ou mock: smoke real é rotulado separadamente.
