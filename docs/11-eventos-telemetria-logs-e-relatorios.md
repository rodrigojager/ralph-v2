# 11 — Eventos, telemetria, logs e relatórios

## Um fluxo único de verdade operacional

CLI headless, TUI, relatórios e integrações devem consumir o mesmo event stream versionado. A TUI não raspa stdout de providers para descobrir status ou tokens. Drivers embutidos e backends CLI adaptam suas saídas para eventos Ralph; o output original continua preservado para diagnóstico.

## Envelope normativo

```typescript
type EventEnvelope<TType extends string, TPayload> = {
  schemaVersion: 1
  eventId: string
  sequence: number
  timestamp: string
  monotonicMs: number
  type: TType
  scope: "workspace" | "run"
  streamId: string
  workspaceId: string
  runId?: string
  documentId?: string
  taskId?: string
  attemptId?: string
  callId?: string
  workerId?: string
  parentRunId?: string
  correlationId?: string
  causationId?: string
  level: "trace" | "debug" | "info" | "warn" | "error"
  payload: TPayload
}
```

`sequence` é monotônica por `streamId` e atribuída pelo persistence/outbox. Eventos de configuração e inicialização anteriores a qualquer run usam `scope: workspace`; eventos de execução usam `scope: run` e exigem `runId`. Não se cria um run sintético apenas para acomodar eventos de workspace. `monotonicMs` mede duração local e não substitui timestamp UTC. Consumers ignoram campos futuros, mas rejeitam major schema incompatível.

## Taxonomia mínima

### Lifecycle

- `workspace.initialized`, `workspace.repaired`;
- `run.created`, `run.started`, `run.resumed`, `run.stopping`, `run.completed`, `run.failed`;
- `task.selected`, `task.started`, `task.interrupted`, `task.completed`, `task.blocked`;
- `attempt.created`, `attempt.started`, `attempt.revision_requested`, `attempt.finished`;
- `child.created`, `child.started`, `child.status`, `child.completed`.

### Modelo

- `model.call.started`;
- `model.text.delta`, `model.text.completed`;
- `model.reasoning.delta`, `model.reasoning.completed`;
- `model.tool.input.delta`, `model.tool.call`;
- `model.provider.warning`, `model.provider.error`;
- `model.backend.call.reserved`, `model.usage.updated`,
  `model.usage.settlement.failed`;
- `model.call.finished`.

### Tools/gates/judge

- `tool.call.requested`, `tool.call.authorized`, `tool.call.started`, `tool.output.delta`, `tool.call.settled`;
- `tool.reconciliation.started` e `tool.reconciliation.replayed|effect-confirmed|reattached|interrupted|paused`;
- `gate.started`, `gate.output.delta`, `gate.completed`, `gate.skipped`;
- `evidence.collected`;
- `judge.call.started`, `judge.call.finished`, `judge.assessment.persisted`;
- `judge.attachments.materialized`, `judge.repair.requested` e eventos normalizados `judge.backend.*`;
- `verification.decision`.
- `verify.command.started|finished|failed|cancelled`, `verify.gates.started`,
  `verify.evidence.persisted`;
- `judge.command.started|finished|failed|cancelled`; chamadas standalone continuam usando
  `judge.call.*`, `judge.backend.*` e `judge.assessment.persisted` para não criar outra taxonomia de
  usage/output.

`verify.evidence.persisted` carrega ID, content hash semântico, `contentRef`, storage hash, tamanho e
as duas estabilidades; `judge.assessment.persisted` faz o mesmo para o receipt do assessment, além
de score, threshold e decisão. O evento detalhado é anexado antes da terminalização transacional da
operação; se esta falhar, a operação termina failed em vez de anunciar sucesso parcial.

### Operação

- `watchdog.state_changed`, `watchdog.probe`, `watchdog.action`;
- `child.worker.restart_started`, `child.worker.force_killed`,
  `child.worker.supervision_failed`;
- `lease.acquired`, `lease.renewed`, `lease.lost`;
- `recovery.operator_decision_required`, `recovery.operator_decision_accepted`,
  `recovery.operator_decision_obsolete`;
- `git.checkpoint`, `git.integration`;
- `config.resolved`;
- `log.message`, `diagnostic.created`.

Event names são públicos e estáveis. Payloads têm schemas discriminados e fixtures.

## Adapter de eventos do OpenCode/providers

O código curado pode fornecer eventos de text, reasoning, tool input/call/result/error, finish, provider error e usage. O adapter deve:

1. conservar provider event ID/ref quando houver;
2. mapear para taxonomia Ralph sem vazar tipo upstream como contrato público;
3. preservar payload bruto em storage seguro opcional;
4. marcar eventos sintetizados;
5. emitir diagnostics se a sequência for inválida;
6. fechar tool calls incompletas no fim como unsettled/error, nunca sucesso;
7. tratar usage parcial/cumulativo sem dupla contagem.

Cada provider possui golden fixtures de streams incluindo chunks fora de ordem, retry, tool call, reasoning, erro e finish.

No comando `judge` standalone, o envelope durável conserva `callId` no campo normativo e
`operationId` em `correlationId`. O provider event validado permanece integral em
`payload.backendPayload`; campos observáveis também são projetados no payload Ralph:
`providerCallId`, `usage`, `providerRawRef`, `delta|text|reasoning|output|content` e `finishReason`
quando existirem. Assim logs continuam descobrindo refs brutas aninhadas ou projetadas, a TUI
coalesce deltas e atribui usage ao `callId` lógico sem contar `providerCallId` como outra chamada;
o ID do provider permanece metadata auditável, e replay não precisa conhecer um adapter específico.
Segredos são redigidos antes do append. Payload não reconhecido continua preservado como dado, mas
não ganha métricas inventadas.

## Adapter de backend CLI

Níveis de integração:

- `protocol`: JSONL/eventos estruturados do comando;
- `adapter`: parser específico versionado para stdout/stderr conhecidos;
- `generic`: somente output bruto e exit code.

Regex de token/status específica de modelo pode existir apenas no adapter declarado e deve marcar métricas como estimadas. O painel nunca apresenta número inferido como usage reportado.

## Tokens e custo

`TokenUsage` distingue:

- input total;
- input non-cached;
- cache read;
- cache write;
- output visible;
- reasoning;
- total reportado;
- custo e currency;
- fonte `reported`, `derived`, `estimated`, `unavailable`;
- provider raw usage ref.

Agregações:

```text
chunk -> model call -> attempt -> task -> run
                              └-> executor/judge/tool-model
child run ---------------------------> parent aggregate opcional
```

Não somar snapshots cumulativos como deltas. O adapter declara a semântica. Totais do judge ficam separados e entram no total geral com breakdown. “Context window usado” é métrica do call atual, diferente do consumo cumulativo do run.

O agregador observável mantém binding imutável de `callId + role + scope` e produz, a
partir dos mesmos updates normalizados, visões por call, attempt, task, run, papel
(`executor`, `judge`, `tool-model`, `child`) e child run. Cada agregado publica:

- `callCount`, `settledCalls`, `partialCalls`, `unavailableCalls` e contadores por fonte;
- `availability: complete|partial|unavailable`;
- cobertura de cada campo (`fieldCoverage`), para que uma soma parcial não pareça total;
- currencies observadas e issues; currencies incompatíveis nunca são somadas;
- refs brutas e IDs imutáveis dos price snapshots usados.

`delta` é somado; `cumulative` e `final` substituem o último snapshot da call sem
dupla contagem e regressões falham fechadas. `final` encerra a call. Uma call iniciada
sem usage permanece explicitamente indisponível.

Price snapshots são imutáveis e vinculados ao acesso efetivo. Custo reportado pelo
provider pode existir independentemente dos counters; custo derivado exige o vetor
faturável completo e uma partição exata de input cacheado/não cacheado. Ausência de
campo nunca é interpretada como zero, exceto quando a capability do catálogo
imutável prova que a dimensão não se aplica àquele modelo.
Métrica ausente mantém custo ausente e produz `model.provider.warning` com a causa;
nenhum snapshot parcial de stream interrompido é promovido a final confiável.

Se o provider não reportar usage:

- usar tokenizer conhecido somente se compatível, marcando `estimated`;
- caso contrário mostrar `—`/`unavailable`;
- nunca inventar custo sem price snapshot/model mapping;
- manter contagem de calls e duração, que continuam determinísticas.

O catálogo já transporta um `PriceSnapshot` imutável por model, com source,
`capturedAt`, access aplicável, currency, unidade e preços opcionais por métrica. O
custo só pode ser derivado se o snapshot estiver `available`, declarar o access da
rota efetiva (`api|subscription`) em `appliesTo` e houver preço para
cada métrica não-zero usada, além de observação explícita de todo o vetor
faturável. Cache sem partição exata, métrica ausente, moeda
ausente, rate ausente ou somente `total` resultam em custo indisponível. Custo derivado recebe source
próprio `derived` (ou preserva `estimated`) e o `priceSnapshotId`; os tokens mantêm
sua source original. Assim tokens `reported` + custo calculado são explicitamente
mixed por campo, nunca reclassificados em bloco nem rotulados como custo reportado.

## Progresso

O progresso oficial do PRD é:

```text
completedTasks / totalTasks
```

Somente transação durável de task completed incrementa `completedTasks`. Active, verifying, score parcial, tokens e tool calls não incrementam. O event `progress.updated` inclui:

- escopo root/child/aggregate;
- completed, total e ratio;
- current task/phase separadamente;
- blocked/failed/pending counts;
- source revision.

Assim CLI e TUI calculam a mesma barra.

## Persistência e replay

- `events.jsonl` é uma projeção reconstruível do ledger e serve a export/replay;
- o ledger mantém índice/cursor e outbox;
- raw streams de processo ficam em
  `.ralph/runs/<run>/raw/diagnostic/processes/<stream-hash>/<segment>.jsonl`,
  com refs estáveis `run-raw://<run>/process/<stream-hash>/stream` que abrangem
  todos os segmentos ainda retidos; saídas deliberadamente workspace-scoped sob
  `.ralph/cache/process-output` usam
  `workspace-raw://process/<stream-hash>/stream`, nunca uma ref de run sem owner;
  capturas de
  modelo usam refs run-scoped sob o mesmo root diagnóstico;
- conexão da TUI começa com snapshot + cursor e segue eventos ao vivo;
- reconexão pede eventos após cursor;
- corrupção/truncamento final de JSONL é reconciliado pelo ledger;
- event retention é configurável, mas relatórios/evidence exigidos ficam fora da
  autoridade de remoção do raw diagnóstico.

Cada registro raw é estruturado, redigido antes da gravação e informa
`truncated`, `originalBytes` e, quando o supervisor já havia limitado a origem,
`sourceTruncated`. Segmentos rodam por tamanho e sofrem budgets oldest-first por
stream e por root; refs removidas pela retenção tornam-se stale de forma
best-effort e nunca são substituídas por conteúdo inventado. A TUI e o modo
headless consomem as mesmas refs e os mesmos eventos; desligar raw apenas remove
essa fonte opcional, sem alterar settlements normalizados.

Cada row de evento recebe no mesmo INSERT um snapshot durável
`event_retention_known/event_retention_ms`. Eventos de run derivam a política do
`EffectiveRunOptions` persistido; eventos sem `runId` usam a política efetiva
passada pelo comando ou o contexto de workspace correspondente no ledger. Não há
colisão entre CLIs: cada processo de comando consulta seu contexto durável no
ledger, e nenhum Map process-local é autoridade. Rows legadas/desconhecidas falham fechado e
não são apagadas; `null` explícito é distinguido de desconhecido e nunca consulta
um default futuro. Runs ativos, outbox não publicado, evidence, gates, artifacts
e estado de retomada nunca entram nessa autoridade; os eventos
`workspace.initialized/workspace.repaired` que sustentam o replay da identidade
e os dois eventos de audit de `task.manual-completion` também são permanentes.
Raw de run só é purgado
depois que nenhum evento daquele run permanece, e a elegibilidade é reavaliada
em flushes posteriores. `event_retention: null` desabilita a
remoção por idade, sem desabilitar os limites seguros de raw por bytes/quantidade.

Stream append, captura de modelo e retenção compartilham um lease de mutação por
root. O owner imutável contém PID, start token, hostname e grace; heartbeat usa
sidecar token-specific, de modo que crash no update não corrompe a identidade do
owner. A publicação do owner é atômica por hard link temporário token-bound, que
é a única exceção controlada à rejeição geral de hard links. Um lock expirado só
é retomado após morte do processo ou PID reuse comprovados; receipts legados
malformados, sem identidade imutável comprovável, permanecem blocked para reparo
explícito em vez de serem roubados por idade. Capturas
abertas mantêm lease própria e não são removidas. Cada ancestral é criado e
revalidado sob o pai confiável, arquivos usam no-follow quando disponível e
lstat/fstat/identidade do pai, rejeitam hard links e revalidam path/handle antes e
depois de cada escrita. O owner chama `assertOwned` nos limites de mutação; isso
inclui o flush cross-process da projeção de eventos. Remoção renomeia para
quarentena, confirma o inode antes de unlink e tenta restaurar o nome original se
uma falha pós-rename impedir a remoção. Um owner vivo ou não verificável produz
receipt `blocked` em vez de roubo heurístico, e `overBudget` continua explícito.

## Backpressure

Token/output delta de alta frequência não pode congelar a TUI nem bloquear provider:

- channel bounded com writer dedicado;
- coalescing somente de deltas renderizáveis, preservando bruto em arquivo;
- lifecycle, tool settlement, gate, usage e error nunca são descartados;
- flush por intervalo/tamanho;
- consumidor lento recebe snapshot atualizado e cursor;
- métricas mostram dropped/coalesced display events;
- limite de memória e disco configurável.

## Logs

Separar:

- audit events estruturados;
- log humano do Ralph;
- stdout/stderr bruto de engine;
- output de tools/gates;
- diagnostics/crash report.

Cada log possui correlation IDs e nível. `--debug` aumenta detalhe do Ralph, não desabilita redaction. `--verbose` controla apresentação. `logs tail` aceita run/task/worker/type/level e `--follow`.

As views reconstruíveis são independentes:

- `audit`: envelope durável completo;
- `human`: uma linha concisa para cada evento;
- `raw-engine`: deltas/output de model e refs para a captura bruta;
- `tool`: lifecycle e settlement de tools;
- `gate`: gates, verification e evidence;
- `diagnostic`: errors, failures e diagnostics.

O comando canônico é
`ralph logs tail [--run-id ID] [--source SOURCE] [--task DOC/TASK]`
`[--worker-id ID] [--type EVENT] [--level LEVEL] [--since ISO] [--limit N]`
`[--follow]`. Sem `--run-id`, ele escolhe o run persistido mais recente quando
existe; filtros são aplicados antes do tail. Follow começa no cursor durável depois
do tail inicial, lê pages limitadas e termina em signal ou quando o run selecionado
fica terminal. `events` aceita os mesmos filtros observáveis e `--follow`.

Para stream, `human` escreve somente linhas, `jsonl` escreve um record por linha e
`json` escreve um array único que é fechado no cancelamento cooperativo. Não há
banner em stdout; falha operacional vai para stderr e exit code.

Capturas brutas são redigidas antes da persistência. O core de persistence oferece
streams segregados por call/process em diretórios derivados de hash, records JSONL
sequenciais, rotação por tamanho, retenção oldest-first por quantidade/bytes/idade,
truncamento explícito quando um único record não cabe e leitura limitada. As refs e
manifests mantêm o binding ao stream; views públicas expõem refs, nunca fingem que
uma captura truncada é completa.

## Saída headless

Modos:

- `human`: linhas concisas e cores somente em TTY;
- `json`: snapshot/resultado único por comando;
- `jsonl`: eventos completos para automação;
- `quiet`: apenas erros e resultado final;
- `raw-engine`: stream bruto explícito, ainda com secrets redigidos.

Stdout contém formato solicitado; diagnostics operacionais vão para stderr. Não misturar banners em JSON/JSONL. Exit code continua a fonte primária de sucesso operacional.

## Relatório final

`report last` e arquivo por run incluem:

- identidade, versão, duração e options efetivas;
- tasks completed/blocked/rejected e progresso;
- executor/judge providers/model IDs sem segredos;
- tokens/custo com source/availability;
- arquivos/artifacts e Git refs;
- gates rodados/pulados/failed e motivo;
- assessments completos e revisões;
- watchdog/restart/interruption; o contador `watchdogRestarts` soma tanto restarts de attempts
  comuns quanto recriações confirmadas de workers `child-run`, sem misturá-las com revisões;
- children/parallel/integration;
- overrides/risks;
- links/paths para logs brutos e evidence.

Versão JSON estável acompanha Markdown humano.

## Critérios de aceite

- TUI e headless exibem estado derivado do mesmo event stream.
- Provider streams com tools/reasoning/usage são normalizados por fixtures.
- Usage nunca é dupla contado e sempre informa a fonte.
- Output bruto permanece disponível sem contaminar o schema público.
- Replay reconstrói snapshot final idêntico.
- Backpressure não perde lifecycle/settlement.
- JSON/JSONL não contém texto decorativo nem secrets.
