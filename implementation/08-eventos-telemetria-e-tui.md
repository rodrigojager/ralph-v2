---
task: Entregar eventos telemetria logs e TUI rica com barra de progresso responsiva
engine: codex
---

# Subplano S08 — Eventos, telemetria e TUI

## Resultado do subplano

Headless e TUI observam o mesmo run por event stream/replay. A TUI anexável apresenta status, tasks, `completed/total`, barra baseada na largura do painel, tokens/custo, activity, errors, engine output, tools, gates, judge e watchdog. Popups configuram os mesmos command models do CLI.

## Referências obrigatórias

- `docs/05-configuracao-perfis-e-tui.md`
- `docs/11-eventos-telemetria-logs-e-relatorios.md`
- `docs/12-tui-ux-layout-e-progresso.md`
- contracts de `docs/17-*`
- `docs/adr/0008-snapshot-imutavel-e-fronteira-tui-s06-s08.md`

## Tarefas

- [x] S08.01 estabilizar event envelope/taxonomia/payload schemas v1, outbox sequence/cursors e reducer puro que reconstrói `RunViewSnapshot`; criar replay compatibility fixtures e proibir TUI de importar provider/persistence concreto.
- [x] S08.02 implementar raw streams por call/process, audit/human/tool/gate logs separados, redaction, rotation/retention e commands `events`, `logs tail --follow`, `report last` em human/JSON/JSONL sem banners.
- [x] S08.03 implementar normalization/aggregation de `TokenUsage` por call/attempt/task/run e executor/judge/children, distinguindo delta/cumulative/final e reported/derived/estimated/unavailable; adicionar model catalog price snapshots sem custo inventado.
- [x] S08.04 implementar channel/backpressure/coalescing para display deltas, preservando lifecycle/settlement/usage/error e raw output, mais load test que prova que stream intenso não bloqueia persistence, heartbeat ou supervisor.
- [x] S08.05 criar app TUI SolidJS/OpenTUI e client local snapshot+cursor+follow, suportar start, attach, replay, disconnect/reconnect e close com escolha background/stop, mantendo run independente do renderer.
- [x] S08.06 implementar layout responsivo com header, progress/tree, status/tokens/watchdog, activity/tools/gates/judge, engine output e errors; fornecer tabs/stack para terminal estreito e filtros/search/autoscroll/raw toggle.
- [x] S08.07 implementar componente de progresso puro: `completed/total`, width útil após labels/padding/borders, floor parcial, fill completo em 100%, total zero, Unicode/ASCII, resize e scopes root/child/aggregate rotulados; task ativa usa indicador separado e nunca preenche barra.
- [x] S08.08 implementar progress/property/golden/PTY tests para larguras extremas e ratios equivalentes `1/2`, `6/12`, `50/100`, garantindo mesma proporção na mesma largura e incremento somente após completion event durável.
- [x] S08.09 implementar painéis de usage/source, current phase/counters, tool/gate status, score/threshold/revision e parecer em abas, watchdog signals/actions e errors persistentes com links/ações de inspeção.
- [x] S08.10 implementar command palette e popups mutáveis provider/model/credential, executor, judge/threshold/revisions, gates/skips/fast, budgets/watchdog, mode/PRD, Git/security e theme; cada campo mostra origem e command/config equivalente e chama o mesmo handler. `Apply for this run` aplica o draft somente antes de o run ser persistido; `Save workspace default` e `Save global default` gravam pelos handlers compartilhados e afetam runs futuros. Attach/replay de run persistido mantém o snapshot read-only.
- [x] S08.11 implementar temas próprios inspirados na densidade/paleta do OpenCode sem branding/logo, dark/light/high-contrast/monochrome, `NO_COLOR`, ASCII, remappable keys, grapheme width e snapshots PT/EN conforme locale disponível.
- [x] S08.12 executar E2E PTY com provider streams variados, sem usage, output grande, resize, popup `Apply for this run` no fluxo pré-run, `Save workspace/global default`, Ctrl+C/close/background/reattach e child placeholder; provar que attach/replay não altera o snapshot persistido e comparar status final TUI, human, JSON e replay.

## Critérios de conclusão

- Barra é sempre função de completed/total e largura disponível.
- Active/revision/tool progress não aumenta percentual.
- Todos os painéis pedidos estão presentes e alimentados por eventos reais.
- Popups não criam configuração exclusiva da TUI.
- TUI pode falhar/fechar sem derrubar supervisor indevidamente.
- Tokens/custo mostram fonte e indisponibilidade honestamente.

## Estado auditado de S08.01–S08.03

S08.01, S08.02 e S08.03 estão implementadas e possuem prova automatizada no ciclo
local atual. O core contém:

- envelope/taxonomia v1 validados, sequência/cursor duráveis no outbox, replay
  determinístico com compatibilidade aditiva e reducer imutável de snapshot;
  `packages/tui` não depende de provider, persistence ou command handlers concretos;
- projeções separadas audit/human/raw-engine/tool/gate/diagnostic, filtros por
  run/task/worker/type/nível/tempo e redaction centralizada;
- `events --follow` e `logs tail --follow` cursor-based, com human/JSON/JSONL sem
  banners e encerramento cooperativo;
- storage genérico redigido por call/process com rotação, retenção e truncamento
  explícito; o output real de processos supervisionados já usa essa API com ref
  run-scoped, enquanto a captura especializada de modelo permanece compatível;
- snapshot imutável da política de telemetria por run, raw fail-closed quando
  persistência/redaction não estão ambas habilitadas e remoção por idade baseada
  na política do próprio run terminal;
- snapshot durável de `event_retention` por row, contexto de workspace no ledger e
  lease cross-process única para append/captura/retenção; owner imutável publicado
  atomicamente, heartbeat token-specific e reclaim somente com morte/PID reuse
  comprovados evitam lock abandonado e split-brain;
- paths/handles/parents revalidados contra symlink, junction, hard link e troca de
  identidade, remoção por quarentena restaurável e raw de run purgado somente
  depois que nenhum evento/outbox correspondente permanece;
- agregador de TokenUsage por call/attempt/task/run/papel/child que respeita
  delta/cumulative/final, expõe cobertura e indisponibilidade e rejeita regressão,
  overflow e moedas incompatíveis;
- aplicação de PriceSnapshot somente quando o vetor faturável completo foi
  reportado e toda métrica não zero possui rate comparável; omissão nunca vale
  zero, salvo capability imutável que prove a dimensão inaplicável, e custo ausente
  continua ausente com causa observável; settlement por call bloqueia retomada sob
  budget quando uma chamada anterior não possui final mensurável, e os limites de
  token/custo acumulam por task através de fallback, Wiggum e revisões.

Limites de composição atuais: a captura de modelo conserva seu formato
especializado para não migrar silenciosamente refs antigas, mas obedece à mesma
policy efetiva de raw/redaction/retention. Output sem `runId` usa referência
`workspace-raw://` e root de cache próprios, nunca uma ref de run sem owner. O
breakdown de usage e a fonte separada
  do custo já são persistidos pelo domínio; os 60 schemas JSON foram regenerados e
  conferidos no ciclo local atual.
A TUI resolve refs legadas, refs estruturadas run-scoped e refs workspace-scoped
somente dentro de ancestrais/identidades revalidados.

Residuais estáticos P2: crash em pontos incomuns de publicação/quarentena pode deixar
sidecar, temp ou quarantine não autoritativo para sweep/doctor posterior; receipt
legado já malformado permanece bloqueado para intervenção manual porque não contém
identidade suficiente para reclaim seguro; no Windows, o probe de start-token usa
PowerShell e pode ter custo perceptível quando locks expirados são consultados repetidamente.

O fechamento foi auditado contra o `check` integral verde (673 aprovados, 0 falhos) e a suíte de
integração integral verde (149 aprovados, 0 falhos). Isso comprova os contratos locais e simulados;
não é alegação de chamada real a provider, autenticação real ou matriz externa de release.

## Estado auditado de S08.05–S08.11

S08.04–S08.12 estão implementadas e cobertas pelo `check`, pela integração e pelos testes locais de
renderer, propriedades, goldens, locale, carga e Windows ConPTY aplicáveis. A composição atual contém:

- registry tipado de settings por categoria, com kind, choices/range, descrição, impacto,
  origem, chave de config, flag e destino `config-only|config-and-run|run-only`;
- draft imutável versionado para `pre-run|attach|replay`, validação imediata e preview do patch,
  comandos de save e argv equivalente;
- `Apply for this run` restrito a `pre-run`, retornando uma nova estrutura de invocação e
  `RunOptionOverrides`, sem receber ou mutar `EffectiveRunOptions` persistido;
- `Save workspace default`/`Save global default` no mesmo command model usado pelos handlers,
  com destino canônico por escopo, patch sem profiles/extensions/segredos, proteção contra
  prototype pollution, schema completo e replace atômico; o save global recompõe e valida também
  o overlay do workspace ativo quando essa raiz está disponível à TUI;
- headless `config list`, `config explain`, `config preview` e `config set`, sendo que o save
  exige `--scope workspace|global` explícito e afeta somente runs futuros;
- configuração versionada de preferência TUI (`theme`, `ascii`, `keybindings`) para consumo
  pelo renderer, sem copiar branding ou componentes do OpenCode;
- adapter de settings do app sobre o mesmo registry/command model, sem dependência concreta da
  TUI em persistence, providers ou commands;
- command palette e popup em tela cheia, com busca, categorias, seleção, edição, preview,
  confirmação de save e indicação de valor efetivo, origem, chave de config, flag e impacto;
- fluxo pré-run no qual `Apply for this run` devolve uma nova invocação antes de qualquer run ser
  persistido, enquanto fechar sem aplicar retorna `cancelled-before-persist`;
- `Save workspace default` e `Save global default` pelos handlers compartilhados, afetando apenas
  runs futuros; attach e replay recusam Apply e continuam exibindo o snapshot persistido;
- TUI live iniciada somente depois do callback durável `onRunReady`, attach por cursor e replay
  congelado, sem tornar o renderer dono do lifecycle do run;
- layout responsivo com progresso `completed/total`, barra calculada pela largura útil do painel,
  árvore de tasks, status, tokens/custo e fonte, watchdog, activity, tools, gates, judge, output da
  engine, erros, filtros, busca, pausa e alternância raw/normalizado;
- temas dark/light/high-contrast/monochrome/system, respeito a `NO_COLOR`, modo ASCII e bindings
  configuráveis para as ações principais;
- segmentação por grafema e largura visual terminal para backspace, limites de input e truncamentos
  visíveis, evitando cortar emoji, ZWJ ou caracteres combinantes ao meio;
- locale efetivo propagado à TUI com superfícies principais, popups, ajuda, usage, conexão,
  progresso operacional e mensagens de estado em EN/PT-BR, sem alterar IDs, flags ou JSON;
- bootstrap de eventos por high-water durável e páginas indexadas por root/child run, sem carregar e
  desserializar previamente o ledger inteiro de outros runs do workspace e sem reter um array global
  do histórico relevante; tails visuais, refs brutas e chamadas de uso expostas têm limites próprios;
- seleção determinística da task realmente retomável/ativa entre root e children, com prioridade para
  trabalho em voo/interrompido, desempate por child mais profundo e attempt sempre escopado por
  `runId + documentId + taskId`, sem deixar uma task pending antiga substituir a ativa;
- projeções independentes de root e de cada child, cada uma com status, task atual,
  `completed/total`, barra calculada contra 100% da largura útil do painel, tokens/fonte, fase,
  watchdog e resumo de erros, além do agregado root/children separado; o estado live de usage por
  call é bounded e, ao exceder o limite, declara indisponibilidade em vez de subcontar silenciosamente;
- alternância `raw-engine` alimentada somente por bytes realmente persistidos: capturas
  `raw:model/*.jsonl` dos drivers embutidos e stdout/stderr redigidos do process store para CLIs
  externos; refs e payloads normalizados não são reformatados para fingir saída bruta; a leitura
  aceita refs somente nos campos estruturais conhecidos do envelope pertencente aos run IDs do
  root/children anexados, nunca por busca recursiva em JSON arbitrário de modelo/tool; rejeita
  links/junctions nos diretórios e no arquivo, confirma no descritor aberto a identidade inspecionada,
  mantém cap explícito por ref e conserva offsets live em LRU determinística de tamanho fixo;
- popup pesquisável de providers, modelos, capacidades, limites, variantes, procedência de preço e
  credenciais, com catálogo pinado, lifecycle visual de OAuth/device/subscription, connect explícito,
  input mascarado de API key por boundary one-shot, seleção somente do nome de variável de ambiente,
  revoke com confirmação e comandos CLI equivalentes; o segredo não entra em argv, snapshot, state,
  evento ou mensagem e o buffer do renderer é limpo ao enviar, cancelar, fechar ou destruir; fechar
  ou destruir invalida também inputs one-shot enfileirados, impedindo consumo posterior pelo port;
- fechamento ou falha da TUI degradado para diagnóstico sem encerrar indevidamente a execução;
  replay não oferece stop e attach não reescreve opções do run.

Limites atuais: edição aprofundada de profiles continua nos handlers especializados;
opções booleanas `false` sem flag inversa não são anunciadas como override CLI exato; e nenhum evento
`config.changed` é anexado a um run, porque defaults não pertencem à história de um run existente.
Traduções específicas da metadata de cada setting continuam fora do snapshot semântico da execução;
IDs, flags, chaves de config e formatos estruturados permanecem invariantes entre locales.

Evidência executada no ciclo atual:

- `check` integral: 673 aprovados, 0 falhos;
- integração integral: 149 aprovados, 0 falhos;
- bateria S08 focada: 18 aprovados, 0 falhos, cobrindo renderer, storm/coalescing, progresso,
  propriedades, golden versionado, locale, temas e largura terminal por grafema;
- progress/property: larguras extremas `-10..1024`, monotonicidade e invariantes para
  `completed=0..130`; equivalência de `1/2`, `6/12` e `50/100` em todas as larguras `1..512`;
  golden ASCII/Unicode e prova de que task/model/tool/completion isolados não alteram o contador
  oficial sem `progress.updated` durável;
- snapshots semânticos exatos do view model e snapshots do renderer OpenTUI em EN/PT-BR, com
  headings, task, progresso, usage, judge/revisions, conexão, runtime, watchdog e erros; cobertura
  adicional de dark/light/high-contrast/monochrome/system, `NO_COLOR`, ASCII e graphemes combinantes,
  CJK, flag e emoji ZWJ;
- load local no boundary da TUI com batch máximo de 2.048 eventos: 2.042 deltas coalescidos em um
  único render agendado, truncamento contabilizado, feed de entrada preservado e lifecycle, usage,
  watchdog, erro e heartbeat ainda observáveis;
- integração S08.04 focada: 1 aprovado, 0 falhos e 29 verificações, atravessando
  `BunProcessSupervisor`, captura real stdout/stderr, SQLite ledger/outbox, raw process store,
  retention e paginação para `RunUiEventStore`. O processo produz um storm real; um heartbeat é
  persistido enquanto o handle do supervisor ainda está ativo; 128 deltas capturados são gravados
  duravelmente com progresso intermediário/final; a captura raw obrigatória mais nova permanece
  legível após a retention remover a candidata antiga; a TUI faz um único render coalescido sem
  perder status, usage, watchdog, raw ref ou progresso. O ensaio integrado é deliberadamente bounded;
  o limite máximo de 2.048 eventos permanece coberto no teste local específico de backpressure;
- smoke Windows ConPTY repetido três vezes: TTY real, fonte `no-usage`, input de output de 20.000
  caracteres mais reasoning/external CLI, progresso `1/4`, popup de avaliação read-only, resize
  `96x30 -> 120x36`, progresso `4/4`, `q`, exit 0 e liberação observada do terminal;
- matriz Windows ConPTY S08.12: 5 aprovados, 0 falhos e 34 verificações. Ela cobre streams de model,
  reasoning, tool, gate e CLI externo; usage `reported` e `no-usage`; truncamento explícito de output
  grande; resize e progresso `1/4 -> 4/4`; child placeholder; popup mutável pré-run por teclado com
  preview, `Save workspace default`, `Save global default` e `Apply for this run`; fechamento por `q`
  com progresso da fonte sem renderer; reattach em novo processo; Ctrl+C pela ponte do comando;
  attach/replay read-only; e igualdade de status/progresso entre TUI, human, JSON e replay com hash do
  snapshot persistido inalterado;
- lifecycle Windows/ConPTY corrigido no produto, sem desviar o resultado por sidecar ou alterar as
  asserções finais: o OpenTUI recebe um `Writable` de identidade própria via `NativeSpanFeed`, enquanto
  o fechamento usa a barreira pública `stop -> idle -> destroy` e só resolve `closed` no `onDestroy`
  final. Assim, fechar durante uma atualização Solid em voo não invalida `stdout`, e os markers pós-TUI
  continuam atravessando o mesmo terminal real;
- typecheck isolado de `packages/tui` e Biome dos seis arquivos tocados: verdes. O typecheck global
  permaneceu bloqueado por erro preexistente fora de S08 em
  `tests/integration/s06-command-evidence.test.ts:677` (`descriptionHash` em união não estreitada);
- policy de foco Windows: subprocessos Bun internos/headless declaram `windowsHide: true`; somente o
  editor interativo é explicitamente visível. O próprio harness ConPTY também usa `windowsHide`.

Essa evidência não equivale a uma matriz PTY em Linux/macOS e não exercita contas/providers reais. O
fixture ConPTY injeta envelopes de provider/CLI determinísticos; não comprova credencial, quota ou
OAuth reais. Essas provas externas permanecem na matriz S11 e nos gates S12, sem reabrir o corte
funcional local de S08.

## Fechamento de S08.12 e residuais externos

- **S08.12 — concluída localmente:** execução oculta de
  `bun test tests/hardening/pty.test.ts` em Windows x64/Bun 1.3.14 terminou com 5 aprovados, 0 falhos e
  34 verificações. Log: `ralph-s08-pty-matrix-retry-20260719-183256-970-67056.stdout.log`.
- Diagnóstico Windows ConPTY de 2026-07-19: a matriz intermediária chegou a `3 pass / 2 fail`. Os dois
  filhos aceitavam `a`/`q`, concluíam o trabalho e só então recebiam `EPIPE` ao reutilizar `stdout`.
  Probes mínimos descartaram raw mode, pause, listeners e sequências ANSI. Um renderer com feed
  isolado preservou a saída; a reprodução completa mostrou que o diferencial era destruir durante
  atualização Solid em voo. A barreira `stop -> idle -> destroy`, combinada ao output bridge sem
  transferência de ownership, fechou os dois casos mantendo os markers no terminal; a matriz completa
  subsequente ficou verde.
- PTY Linux/macOS, provider/auth real e vínculo a release candidate continuam provas próprias de
  S11/S12. Não são inferidos a partir do Windows ConPTY nem tratados como concluídos aqui.

## Comandos de verificação mínima

```text
ralph-next attach --run-id <run-id>
ralph-next replay --run-id <run-id>
ralph-next events --run-id <run-id> --format jsonl
ralph-next report last --format json
bun test packages/telemetry packages/tui
bun run test:pty
```
