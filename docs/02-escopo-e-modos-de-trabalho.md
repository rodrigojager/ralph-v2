# 02 — Escopo funcional e modos de trabalho

## Formas de execução

### `run` / `loop`

- Executa tarefas pendentes até conclusão, limite, revisão manual, bloqueio ou cancelamento.
- Uma tarefa por invocação de modelo/contexto.
- Contexto enxuto: shared context do PRD, guardrails, tarefa ativa, referências declaradas e evidência de retomada.
- Um supervisor mantém o ciclo e cria workers isolados.
- `loop` permanece alias de `run`.

### `wiggum`

- Usa o corpo completo do PRD atual mais tarefa ativa e guardrails.
- Preserva a regra de uma tarefa por ciclo; muda apenas o envelope de contexto.
- Útil quando tarefas dependem de visão global, mas menos econômico.

### `once`

- Executa a próxima tarefa elegível do PRD ou uma tarefa ad hoc passada na linha de comando.
- Para tarefa do PRD, aplica o mesmo pipeline de evidência e pode concluir a tarefa.
- Texto posicional é sempre ad hoc; seleção de tarefa PRD é sempre explícita por `--task`.
- Para tarefa ad hoc, persiste identidade, tentativas, evidência e report, mas nunca cria PRD/sub-PRD nem altera marker. Associar `--task` e texto ad hoc na mesma invocação é erro.
- PRDs detectáveis entram nos protected paths. Se um backend externo ainda materializar ou alterar conteúdo PRD, um gate bloqueante recusa a conclusão e preserva a mudança para inspeção/recuperação explícita; o CLI não faz rollback destrutivo automático.
- Uma unidade ad hoc usa evidência `change-only`: quando não houver entregável natural, o executor deve materializar um arquivo de evidência bounded em vez de depender apenas de uma alegação textual.
- Antes da primeira chamada, o Ralph inventaria PRDs autorais fora de diretórios de controle,
  dependências e saída gerada (`.ralph`, `.git`, `node_modules`, `vendor`, `dist`, `build` e
  equivalentes). Esses diretórios são deliberadamente classificados como não autorais; a skill não
  deve colocar root/child PRDs neles. Nome convencional, conteúdo PRD detectado, arquivo grande ou
  symlink dentro do inventário autoral é protegido de forma conservadora.
- Pode usar TUI ou headless.

### `parallel`

- Executa tarefas independentes com claims e isolamento por worktree/workspace.
- Respeita dependências, grupos e limites de concorrência.
- Estratégia final configurável: `no-merge`, `merge` ou `create-pr`.
- Não deve paralelizar tarefas que compartilham contrato instável ou o mesmo estado mutável sem isolamento.

### `resume`

- Retoma explicitamente um run interrompido.
- `run` também tenta retomar automaticamente por padrão quando encontra run órfão compatível.
- Permite selecionar `run-id` quando há mais de um candidato.
- Nunca cria execução duplicada quando o lease antigo ainda está válido.

### `attach`

- Abre a TUI interativa read-only sobre um supervisor existente. Em ambiente headless, use
  `status run`, `events`, `logs tail` e `report show` sobre o mesmo ledger.
- Reproduz eventos persistidos e continua em tempo real.
- Não se torna proprietário do worker apenas por observar.

### `verify`

- Parte de uma evidência de execução já persistida, reabre a definição exata da task e reexecuta os
  gates declarados contra o estado atual do workspace sem invocar executor, modelo ou ToolHost.
- Coleta artifacts, baseline/diff cumulativo e uma evidência v2 nova, content-addressed, mas não
  substitui a evidência da attempt e não altera task, marker de PRD ou run.
- Task selection exige `--run-id`; `--attempt-id` e `--evidence-bundle-id` são seletores imutáveis
  alternativos. O comando falha em ambiguidade em vez de escolher silenciosamente o run mais novo.
- Uma run ad hoc é reconstruída somente da descrição/hash persistidos. Ela mantém `change-only`,
  zero verificações declaradas e `markerUpdated=false`; o comando não inventa PRD nem gates.
- Se um gate modificar o workspace, a mudança é preservada para inspeção, registrada na evidência e
  torna a verificação falha. Útil em CI e antes de julgamento manual.

### `judge`

- Avalia uma evidência existente de execução ou a evidência nova de uma operação `verify` exata.
- O comando explícito usa judge externo por default; `--self-review`/`--evaluation self` escolhe uma
  chamada isolada do perfil executor. `deterministic-only` e `manual` não são modos válidos aqui.
- External e self usam o mesmo bundle, rubrica, threshold, schema e policy. O backend precisa declarar
  tools indisponíveis e mutation mode read-only; qualquer alteração observada faz a decisão falhar.
- Persiste assessment, score, adequado, problemas, evidência ausente, recomendações, refs e parecer,
  mas não modifica código, não inicia revisão, não invoca executor e não marca task ou PRD.
- A decisão standalone é um relatório consultivo/auditável. Somente o pipeline de orquestração pode
  aplicar uma avaliação durante uma transação oficial de completion/revision.

### `dry-run`

- Resolve configuração, PRD, tarefas, dependências, provider/model, tools, gates, filhos e integração Git sem iniciar side effects.
- Pode emitir plano humano ou JSON.

## Modos de contexto

| Modo | Contexto enviado ao executor |
| --- | --- |
| `loop` | contexto compartilhado antes da primeira tarefa + guardrails + tarefa ativa + retomada/evidência necessária |
| `wiggum` | PRD completo + guardrails + tarefa ativa + retomada/evidência necessária |
| `ad-hoc` | guardrails + texto informado + contexto explicitamente solicitado |

Progress, repo map e anexos são opt-in por perfil/PRD/flag e devem ter tamanho limitado.

## Backends de execução

### Provider embutido

- Ralph chama o provider diretamente por driver.
- Permite auth por API key, OAuth, assinatura, ambiente ou métodos do provider.
- Ralph hospeda tools, streaming e telemetria.
- É o caminho preferido para padronização da TUI.

### Engine CLI externa

- Ralph inicia um comando externo e controla lifecycle, cwd, env, timeout e output.
- Mantém compatibilidade com Codex CLI, Claude, OpenCode ou adapters customizados.
- Usar assinatura via OAuth não exige obrigatoriamente esse backend: uma credencial embutida pode usar a mesma conta sem chamar o executável.
- Telemetria ausente fica como `unavailable`; raw output permanece acessível.

## Modos de avaliação

| Modo | Comportamento |
| --- | --- |
| `deterministic-only` | gates/evidências e políticas do CLI |
| `self` | nova chamada isolada do executor avalia o mesmo contrato |
| `external` | perfil de judge independente avalia evidências |
| `manual` | Ralph prepara pacote e aguarda decisão humana |

O PRD deve continuar executável em `deterministic-only` sempre que a natureza da tarefa permitir.

## Modos de interface

- `tui`: dashboard e popups ricos.
- `plain`/`none`: texto estável para terminal e pipes.
- `json`: snapshot ou resultado único.
- `jsonl`: eventos incrementais.
- `auto`: TUI em TTY compatível; plain em pipe/CI.
- Aliases legados `spectre`, `gum` e `spectre+gum` podem ser aceitos na migração, mapeados para experiência suportada e acompanhados de aviso de depreciação se a implementação original não for preservada.

## Interativo, não interativo e CI

- `--non-interactive` impede prompts, browser automático não autorizado e qualquer espera por input.
- OAuth browser em ambiente headless deve oferecer device flow/manual URL apenas se o provider suportar.
- Configuração ausente em headless falha com código e instrução exata; não abre TUI.
- `--yes` aceita somente confirmações seguras documentadas, nunca escalada automática para modo perigoso.
- JSON/JSONL não mistura logs humanos em stdout; diagnósticos vão para stderr ou eventos estruturados.

## Comportamentos preservados do Ralph atual

- primeira tarefa pendente por ordem/dependência;
- marcadores `[ ]`, `[x]`, `[~]`;
- loop e wiggum;
- once e parallel;
- gates, test/lint/browser opcionais e flags de skip;
- no-change `fallback|retry|fail-fast`;
- fallback engines/perfis;
- branch por tarefa, PR, checkpoint, rollback, sandbox e security modes;
- status, events, logs, reports, context/repo map, adapters, recipes, tasks sync, install/update/lang/ui;
- passthrough de argumentos para backend CLI externo.
