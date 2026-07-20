# 12 — TUI, UX, popups e barra de progresso

## Objetivo

A TUI torna o Ralph observável e configurável sem mudar a semântica do CLI. Ela deve aproveitar padrões técnicos selecionados de SolidJS/OpenTUI e a densidade visual que agrada no OpenCode, mas conservar identidade própria e atender primeiro às informações operacionais do Ralph.

Todo ajuste feito em popup possui equivalente em config/flag/comando. Automação headless nunca depende de interação visual.

## Arquitetura

```text
Supervisor/event stream
        │ snapshot + cursor
        ▼
TUI event client -> normalized view store -> Solid/OpenTUI components
```

A TUI não acessa provider diretamente, não executa gates e não altera ledger por mutação local. Ações do usuário enviam commands ao supervisor e recebem confirmação/evento.

Ela pode:

- ser iniciada junto com o run;
- anexar a um run existente;
- fechar mantendo run em background;
- solicitar stop gracioso;
- reproduzir run concluído.

## Layout principal

Desktop largo sugerido:

```text
┌ Ralph v2 ─ project/run ─ executor/model ─ judge/model ─ elapsed ─ status ┐
├───────────────────────────────┬──────────────────────────────────────────┤
│ PROGRESS / TASK TREE          │ ENGINE OUTPUT                            │
│  4/12  [████████░░░░░░░░░░]  │ text / reasoning / tool stream           │
│  > S05 tools       executing  │                                          │
│    child 2/3                  │                                          │
├───────────────────────────────┼──────────────────────────────────────────┤
│ STATUS / TOKENS / WATCHDOG    │ ACTIVITY / TOOLS / GATES / JUDGE         │
│ phase, attempt, calls, usage  │ timestamped normalized events            │
├───────────────────────────────┴──────────────────────────────────────────┤
│ ERRORS / WARNINGS / KEYS                                               │
└─────────────────────────────────────────────────────────────────────────┘
```

Em largura menor, painéis viram tabs/stack; informações críticas continuam visíveis: status, current task, completed/total, barra, watchdog e último erro. Altura pequena reduz histórico, não remove linha de progresso.

## Painéis normativos

### Header/status

- projeto/workspace e run ID curto;
- modo (`once`, `loop`, `wiggum`, `parallel`);
- estado/phase e elapsed;
- executor provider/model/credential label;
- judge estado/provider/model/threshold ou `desativado`;
- branch/worktree;
- resume/background/connection indicator.

### Progresso e árvore

- completed/total numérico;
- barra oficial responsiva;
- task ativa e phase;
- parents/children recolhíveis;
- pending, blocked, rejected e completed com símbolos distintos;
- progresso root, child selecionado e aggregate opcional.

### Tokens/custo

- input, output, reasoning, cache read/write;
- executor e judge separados;
- call atual versus acumulado;
- context window `usado/limite` quando conhecido;
- custo e currency quando suportados;
- indicador `reported`, `~estimated` ou `— unavailable`.

### Activity/tools/gates/judge

- eventos normalizados com timestamp relativo;
- tool name, estado, duração e preview redigido;
- gate name, pass/fail/skipped/timeout;
- judge score/threshold, revisão atual/máxima;
- abas para `Adequado`, `Problemas`, `Ausente`, `Recomendações`;
- watchdog slow/suspect/recovery;
- filtros por task/worker/type/level.

### Engine output

- texto do executor em streaming;
- reasoning somente quando provider disponibilizar e policy permitir;
- stdout/stderr de backend CLI com origem;
- pause/autoscroll/copy/search/wrap;
- raw versus normalized toggle;
- limites visuais sem perder o arquivo bruto persistido.

### Errors

- último erro e contagem;
- código, origem, task/attempt e ação sugerida;
- abrir detalhes/log/evidence;
- nunca sumir automaticamente sem ficar no histórico.

## Barra de progresso responsiva

Requisito central: a largura interna disponível no painel equivale sempre a 100% do trabalho daquele escopo, independentemente de haver 2, 12 ou 500 tasks.

```text
ratio = total === 0 ? 0 : completed / total
fillCells = completed === total && total > 0
  ? barWidth
  : floor(ratio * barWidth)
emptyCells = barWidth - fillCells
```

`barWidth` é recalculada no resize depois de descontar bordas, padding, label `completed/total`, porcentagem e eventual scrollbar. Não existe largura fixa como 44 caracteres.

Regras:

- somente task duravelmente `completed` aumenta `completed`;
- task ativa pode ter spinner/cor ao lado, mas não preenche fração extra;
- a barra nunca regride salvo reconciliation explícita e visível;
- em 100%, todas as células são preenchidas para evitar arredondamento;
- com total zero mostra estado `sem tarefas`, não 100%;
- se `barWidth` for muito pequena, prioriza `n/N`; depois uma mini-barra;
- Unicode usa blocos/células; `--ascii` usa `#` e `-`;
- cor não é a única distinção; há texto/símbolos;
- cálculo é puro e coberto por property tests para toda largura/total;
- root e cada child têm barras próprias; aggregate global é opcional e rotulado;
- aggregate evita dupla contagem: ou conta leaf tasks, ou root tasks, conforme setting exibido.

Exemplos de mesma largura útil:

```text
1/2    [████████████████░░░░░░░░░░░░░░░░]  50%
6/12   [████████████████░░░░░░░░░░░░░░░░]  50%
50/100 [████████████████░░░░░░░░░░░░░░░░]  50%
```

## Popups e command palette

Popups estilo selector/modal, operáveis por teclado:

- escolher/criar/editar perfil;
- provider e modelo com busca/capability badges;
- conectar/desconectar credencial e acompanhar OAuth;
- configurar executor;
- habilitar/configurar judge, threshold, rubrica e revisões;
- evidence/gates/skips/fast;
- budgets, retries e timeouts;
- watchdog por fase;
- modo, PRD, task, child e paralelismo;
- Git/branch/worktree/commit/PR;
- sandbox/rede/permissões;
- theme, ASCII, locale e output;
- confirmação de ações destrutivas/override.

O popup de provider/model/auth inclui uma aba `profile` completa e metadata-driven. As abas de
catálogo continuam restritas à escolha de rotas `embedded`; a aba de profile expõe também
`external-cli`, protocolo/args/cwd/environment refs/capabilities, fallback graph/failure classes,
requirements e limits. Campos condicionais aparecem sem apagar os valores do draft da outra
modalidade. Cada linha mostra `inherit`, `set` ou `clear`, origem, path de config e equivalente
CLI/config. Papel, escopo e a decisão independente `set as role default` permanecem explícitos.
A origem de um campo herdado vem da proveniência efetiva de suas folhas após defaulting; mapas vazios
continuam observáveis e campos agregados de origem heterogênea mostram `mixed(...)`, sem atribuir a
todas as linhas o rótulo genérico do escopo inferior.

Cada popup de configuração mutável mostra:

- valor efetivo;
- origem (`default`, global, workspace, PRD, env, CLI);
- descrição e impacto;
- validação imediata;
- preview do comando/config equivalente;
- `Apply for this run`, `Save workspace default`, `Save global default` como ações distintas.

Popups de inspeção read-only mostram os mesmos valor efetivo, origem, descrição, impacto e equivalentes, mas não apresentam essas ações como se pudessem alterar o run observado.

Secret popup mascara entrada e nunca oferece “mostrar” em logs/screenshot. OAuth mostra URL/estado/expiração, não token.

### Fronteira entre inspeção e configuração

Um run passa a possuir um snapshot imutável de opções efetivas quando é persistido. Por isso, `attach` e replay apresentam popup/resumo read-only: mostram valor, origem, impacto e equivalentes de config/CLI, mas não reescrevem mode, perfis, threshold, rubrica, budgets ou policies daquele run. Ações operacionais posteriores, como uma concessão explícita e auditada de revisões, são novos comandos/eventos duráveis e não mutação retroativa do snapshot.

Os popups mutáveis continuam obrigatórios no fluxo de preparação da S08:

- `Apply for this run` aplica o draft à invocação antes da criação do run e o valor resultante entra no snapshot persistido;
- `Save workspace default` e `Save global default` gravam configuração atomicamente pelos mesmos handlers do CLI;
- quando abertos durante attach/replay, os saves alteram apenas defaults de runs futuros, e `Apply for this run` fica indisponível com explicação explícita;
- abrir um novo run a partir de um run anexado exige uma nova invocação identificável; nunca altera a história do run existente.

No popup de profiles, `Apply for this run` continua significando apenas o override de rota
`embedded` já suportado pelo contrato de invocação. A camada parcial de um profile — inclusive
`external-cli`/fallback/requirements/limits — é salva no escopo escolhido pelo handler
`profiles configure`, que recompõe e valida o profile efetivo completo antes do commit; o run então
o referencia. A TUI não finge existir um override efêmero de profile inteiro que o contrato de
execução não possui. Em attach/replay, esse save afeta somente runs futuros e não anexa evento ao
histórico do run observado.

A projeção read-only entregue em S06 não satisfaz nem substitui a command palette mutável, os três destinos de ação e os testes PTY de apply/save exigidos em S08.10 e S08.12.

## Equivalência TUI/CLI

Toda ação mutável chama um command model compartilhado. Exemplo:

```text
Popup: Judge > External > profile=openrouter-judge > threshold=85 > revisions=2
CLI:   ralph run --judge external --judge-profile openrouter-judge \
         --judge-threshold 85 --max-revisions 2
Config: evaluation.mode/profile/threshold/max_revisions
```

`ralph config explain <key>` e o popup usam a mesma metadata. Nenhum setting secreto vive só no state do componente.

## Teclado e acessibilidade

Defaults documentados e remapeáveis:

- `?` help;
- `Ctrl+P` palette;
- `Tab`/`Shift+Tab` painéis;
- `j/k` ou setas navegação;
- `Enter` detalhes/ação;
- `/` busca/filtro;
- `p` pause autoscroll;
- `r` replay/resume quando aplicável;
- `s` stop gracioso com confirmação;
- `q` fechar/selecionar se mantém background;
- `Esc` fechar modal.

Compatibilidade com terminal sem mouse é obrigatória; mouse é melhoria. Respeitar `NO_COLOR`, high contrast, reduced motion e largura de grapheme Unicode. Screen-reader terminals recebem labels textuais onde possível.

## Tema e identidade

A paleta pode ser inspirada na aparência do OpenCode: fundo neutro escuro/claro, texto de alta legibilidade e accents quentes/contrastantes no lugar do azul padrão atual. Porém:

- não copiar logo, nome ou branding;
- tokens semânticos (`accent`, `success`, `warning`, `danger`, `muted`, `surface`) em vez de cores hardcoded;
- tema claro, escuro, high contrast e monochrome;
- pass/fail não depende só de verde/vermelho;
- snapshot tests garantem consistência.

## Degradação e estabilidade

- Terminal sem truecolor usa 256/16 cores.
- Terminal estreito usa tabs.
- Provider sem usage mostra unavailable.
- Backend generic CLI mostra bruto e status de processo.
- Se TUI falhar, supervisor/run continua e headless status pode anexar.
- Render loop é separado do event persistence; um output intenso não bloqueia heartbeats.

## Critérios de aceite

- Todos os dados pedidos — status, tokens, progresso, log, output, tools, gates, judge e watchdog — aparecem na TUI.
- A barra ocupa dinamicamente a largura útil do painel como 100% e representa exatamente completed/total.
- Resize, 0 tasks, 100%, grandes totais e ASCII funcionam por testes.
- Popups configuram os mesmos campos disponíveis por CLI/config.
- Fechar/reabrir TUI não perde run nem eventos.
- Providers com diferentes streams aparecem sob modelo visual padronizado sem esconder bruto.
