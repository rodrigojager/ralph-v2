# 21 — Guia operacional do tool host e da execução na S05

Este guia descreve a superfície de execução entregue pela S05. Ele complementa os contratos de [configuração](05-configuracao-perfis-e-tui.md), [providers](06-providers-modelos-autenticacao-e-upstream.md), [orquestração](08-orquestracao-executor-tools-e-contexto.md), [eventos](11-eventos-telemetria-logs-e-relatorios.md), [segurança](13-paralelismo-git-sandbox-e-seguranca.md) e [schemas](17-contratos-e-schemas.md).

A regra central permanece inalterada: o comando do Ralph seleciona a tarefa, monta o contexto, escolhe o perfil, autoriza cada efeito, aplica limites, coleta evidências e decide a conclusão. O backend de modelo recebe uma tarefa já selecionada e devolve apenas uma alegação `ExecutorOutcome`; ele não recebe APIs de scheduler, ledger, marker ou completion.

## Escopo honesto da slice

A S05 acrescenta ao fluxo headless da S03:

- execução embutida pelos drivers OpenAI e OpenRouter, com tools estritas e stream normalizado;
- backend de processo `external-cli`, supervisionado e adaptado por protocolo, output conhecido ou output genérico;
- tool host com dez ferramentas pequenas, bounded e neutras quanto à stack do projeto;
- políticas de path, comando, shell, risco e aprovação por chamada;
- journal durável de tool calls com intenção antes do efeito e settlement posterior;
- limites independentes de model calls, tool calls, tokens, custo, output e tempo;
- fallback explícito entre perfis, sem replay transparente depois de uma tool call;
- propagação de cancelamento até provider, tools e árvore de subprocessos;
- output bruto redigido por referência e eventos normalizados para `events --format jsonl`.

A S05 não entrega judge, watchdog completo, TUI rica, execução de Sub-PRDs, paralelismo, worktrees ou sandbox de sistema operacional. Esses recursos pertencem respectivamente às slices S06–S09.

## Fluxo autoritativo

```text
ralph once/run/loop
        │
        ├─ compila PRD e seleciona task
        ├─ resolve snapshot imutável de config/perfil
        ├─ cria attempt e reserva model call
        ▼
ExecutionBackend selecionado
        │  text/reasoning/tool/usage/outcome
        ▼
ExecutionChannel comandado pelo Ralph
        │
        ├─ materializa somente tools permitidas
        ├─ reserva e autoriza cada tool call
        ├─ executa pelo ToolHost/Supervisor
        └─ devolve settlement bounded ao backend
        ▼
evidência -> gates -> CompletionDecision -> marker/ledger
```

Consequências práticas:

- `TASK_COMPLETE`, “aprovado” ou qualquer outro texto do modelo não altera estado;
- eventos enviados por um provider não podem forjar `task.completed`, `gate.completed` ou a decisão de verificação;
- cada turno real do provider ou do processo externo precisa reservar uma model call antes de começar, inclusive um turno que falhe;
- nenhuma mutação legítima do executor embutido contorna o tool host;
- o timestamp final do outcome é atribuído pelo relógio do Ralph, não aceito como autoridade do backend.

## Backends de execução

### Embedded OpenAI e OpenRouter

O backend embutido transforma o contexto canônico em input do protocolo Responses, fornece definições de tools com JSON Schema estrito e executa um loop bounded de:

1. chamada do provider;
2. normalização de texto, reasoning público, tool calls, warnings, erros, usage e finish;
3. execução das tool calls pelo `ExecutionChannel` do Ralph;
4. replay dos settlements como `function-call-output`;
5. outcome JSON final `work_submitted` ou `blocked_reported`.

Nomes de tools incompatíveis com as restrições do provider recebem aliases determinísticos e reversíveis. Os argumentos são validados novamente na fronteira do driver e na fronteira do tool host. Itens opacos de reasoning necessários ao protocolo podem ser preservados somente para replay; chain-of-thought privada não entra nos eventos, raw público ou relatório.

OpenAI usa API key ou o protocolo de conta ChatGPT/Codex fixado. OpenRouter usa somente API key ou
referência de environment e o endpoint OpenAI-compatible Responses fixado; provider/model continuam
validados no snapshot e a resposta passa pela mesma normalização bounded. Anthropic permanece
catalog-only/fail-closed até possuir adapter próprio. A presença de qualquer outro provider no
catálogo ou perfil não afirma suporte de execução.

### External CLI

O backend externo inicia um executável configurado como subprocesso do Ralph. Executável e argumentos são campos separados; `{{provider}}`, `{{model}}` e os demais placeholders suportados são expandidos como argumentos, nunca concatenados em uma shell string. Segredos não devem aparecer em `args`; somente referências `TARGET=env:SOURCE` explicitamente configuradas podem chegar ao processo.

Há três adapters:

| Adapter | Contrato S05 |
| --- | --- |
| `protocol` | Um documento `ralph.execution.external-cli.v1` por turno. Pode devolver `tool-calls` para execução pelo Ralph ou um `outcome` final. |
| `known-output` | Parser versionado selecionado por ID explícito. O adapter embutido `executor-outcome-json-v1` aceita um único `ExecutorOutcome` JSON. |
| `generic` | Captura texto bounded e redigido como resumo de `work_submitted`; não inventa tools, usage, arquivos ou conclusão. |

O transporte v1 é deliberadamente restrito:

- `streaming: false`;
- `usage: unavailable`;
- `mutation_mode: read-only`;
- Ralph-governed tool calling somente com adapter `protocol`;
- um único documento JSON bounded por turno;
- identidades de tool call não podem ser reutilizadas entre turnos.

O processo executa com cwd vazio e temporário. O input usa `workspaceRoot: "."` e oferece somente contexto, recursos bounded, definições de tools e histórico de settlements. O diretório temporário é removido ao terminar.

## Limite de segurança do external CLI

O cwd temporário reduz mutações acidentais, mas **não é um sandbox de sistema operacional**. Um executável local continua sendo código confiado pelo usuário e, sem contenção do sistema, pode tentar abrir paths absolutos, rede ou outros recursos aos quais o processo hospedeiro tenha acesso.

Portanto:

- configure somente executáveis e adapters em que você confia;
- não interprete `mutation_mode: read-only` como isolamento de kernel;
- effects solicitados pelo protocolo continuam passando pelo tool host, mas o Ralph S05 não consegue impedir um executável malicioso de ignorar o protocolo usando APIs diretas do host;
- o sandbox completo, com mounts, rede e limites de processo aplicáveis, pertence à S09.

## Tool host

As tools estáveis da S05 são:

| Tool | Função e proteção principal |
| --- | --- |
| `fs.read` | Leitura bounded dentro dos scopes autorizados. |
| `fs.list` | Listagem bounded e sem escape do workspace. |
| `fs.glob` | Descoberta bounded por quantidade de matches. |
| `fs.search` | Busca textual bounded por arquivos, bytes e matches. |
| `fs.write` | Criação/substituição atômica com precondition e hash. |
| `fs.edit` | Edição pequena vinculada ao conteúdo anterior esperado. |
| `fs.apply_patch` | Patch auditável com revalidação antes do replace. |
| `process.exec` | Executável + argv exatos, cwd, timeout, environment mínimo e output bounded. |
| `git.inspect` | Inspeção Git read-only. |
| `artifact.publish` | Registro content-addressed de um arquivo já criado e autorizado. |

O path resolver usa workspace canônico, containment, scopes relativos, checks de symlink/junction e revalidação imediatamente antes da escrita. PRDs compilados e paths de controle do Ralph são protegidos: o executor não pode editar o próprio plano, marker ou ledger por tool call.

Writes registram preconditions e hashes antes/depois. Uma mudança concorrente produz conflito em vez de sobrescrita silenciosa. Outputs retornados ao modelo têm limites próprios; a prova bruta, quando persistida, também possui limite e indicador explícito de truncamento.

`process.exec` prefere sempre executable + argv. A permissão `--allow-command` materializa uma regra de executable e argumentos **exatos**; permitir nominalmente `process.exec` não autoriza qualquer comando. Shell permanece desligada salvo `--allow-shell`, e mesmo essa flag não remove scopes, allowlist, bounds ou auditoria. O schema entregue ao modelo não aceita referências arbitrárias de environment. O subprocesso recebe apenas o environment operacional mínimo e valores fornecidos pela composição comandada.

Na composição com workers, uma solicitação shell autorizada não atravessa IPC como uma string para
ser reinterpretada livremente. A única projeção canônica converte `kind + executable opcional +
script` no argv fixo do interpretador; antes do dispatch, o supervisor resolve o executável real,
calcula seu SHA-256 e vincula executável, argv completo (incluindo o script), cwd e nomes de ambiente
à capability. O worker recompõe e compara a mesma projeção, e o owner durável revalida novamente o
hash e o exact-command imediatamente antes do spawn. O request entregue ao owner já está em modo
argv direto. Alterar interpretador, flags, script, cwd ou environment names invalida o binding.

Em gates declarados pelo PRD, `shell` é uma classificação explícita de risco; `executable` e `args`
continuam sendo a invocação completa e estruturada. O Ralph não cria `sh -c`, `cmd /c` ou outra
concatenação a partir de prosa. A invocação canonicalizada também precisa coincidir com a capability
exata do worker antes que o gate seja executado.

No Windows, subprocessos supervisionados usam Job Object; em Unix, process group. Timeout e cancelamento encerram a árvore, não somente o PID pai.

## Permissões e modo headless

A decisão combina invariantes duras, role, scopes, regra da tool, regra exata de comando, risco e security mode. A ordem importa: uma regra nominal `allow` nunca supera path protegido, escape de scope, judge read-only ou comando não listado.

- `safe`: leitura/escrita preconditioned dentro do scope; processos exigem allowlist exata; destrutivo é negado.
- `auto`: operações não cobertas podem virar `ask`, mas não ganham permissão implícita.
- `dangerous`: permite apenas overrides que a policy materializou explicitamente e registra `auditedOverride`; não significa “sem limites”. Na composição S05, não autoriza processo fora da allowlist nem comando destrutivo por si só.

Uma decisão `ask` é vinculada a `requestId` e `requestHash`, impedindo que uma resposta antiga aprove outra chamada. A S05 fornece um prompt command-owned `y/N` em `stderr`, serializado e cancelável, que mostra somente tool, risco, motivo e hashes abreviados — nunca os argumentos. Em execução sem TTY ou com `--non-interactive`, não há prompt invisível: `headlessAsk` resolve deterministicamente para `deny` por default ou para `allow` quando isso foi configurado explicitamente, sempre com auditoria. O popup rico da S08 reutilizará o mesmo port e comando.

Flags operacionais relevantes:

```text
--security safe|auto|dangerous
--allow-tool NAME
--deny-tool NAME
--ask-tool NAME
--allow-command "EXECUTABLE ARG1 ARG2"
--read-path SCOPE
--write-path SCOPE
--allow-shell
--headless-ask deny|allow
--non-interactive
```

Exemplo headless conservador:

```text
ralph once --prd PRD.md --executor-profile executor-openai \
  --security safe --headless-ask deny \
  --read-path . --write-path src \
  --allow-command "project-check --slice current" \
  --non-interactive --format json
```

O projeto alvo define o executável real; o Ralph não presume Bun, npm, Python, Go ou outra stack.

## Journal: intenção antes do efeito

O lifecycle durável de cada tool call é:

```text
requested -> authorized -> started -> settled
                              └──────> unsettled
```

Antes de qualquer efeito, o Ralph reserva uma identidade que contém attempt, model call, provider tool call ID, hash dos argumentos, idempotency key, risco e argumentos redigidos. Só depois persiste autorização e `started`. O settlement registra outcome, duração, effects, hashes/refs, retryability e recovery classification.

Outcomes são fechados: `success`, `nonzero`, `denied`, `invalid`, `error`, `timeout`, `cancelled` ou `unsettled`. Reusar a mesma identidade com argumentos diferentes é erro, não uma segunda execução.

Após interrupção:

- read-only pode ser classificado como seguro para retry;
- write/edit usa pre/post hashes para reconciliar;
- efeito confirmado ou ausente pode ser decidido por evidência;
- efeito externo ou ambíguo fica `unknown-external-effect`/`manual-review`;
- nenhuma call possivelmente efetiva é repetida cegamente.

Tool settlements não editam task state. Eles apenas alimentam o backend, os eventos e a futura evidence bundle; a decisão de continuar ou concluir pertence à orquestração.

## Budgets e limites

Os contadores permanecem independentes:

- model calls reais por attempt;
- tool calls por model call/attempt;
- turnos bounded do loop de tools;
- input, output, reasoning e total tokens;
- custo e moeda;
- output resumido e raw bytes;
- timeout/deadline de model call, tool, process e task;
- retries de provider, no-change e revisões futuras.

Limites da task e do perfil não se sobrescrevem de modo permissivo: o Ralph usa o menor valor aplicável. Tokens e custo são acumulados por task no mesmo run, atravessando calls, candidatos de fallback, iterações Wiggum e attempts de revisão; cada novo context manifest recebe somente o saldo. Uma cadeia de fallback ou uma attempt nova não pode reiniciar silenciosamente esse budget. Moedas incompatíveis falham antes da comparação.

Usage incremental ou cumulativa é normalizada por call sem dupla contagem. Cada call real é reservada antes do efeito e precisa encerrar com usage final quando a capability é `reported|estimated`; stream interrompido não promove snapshot parcial a final. Ao exceder um limite, o Ralph emite `budget.model_usage.exceeded` e termina com a classificação de limite correspondente; saldo exatamente esgotado impede reservar outra call. Se o backend declara `usage: unavailable` — como o external CLI v1 — uma task ou perfil com limite de tokens/custo falha fechado como não aplicável de forma verificável; o Ralph não finge que zero tokens foram consumidos. Limites determinísticos de calls, tools, bytes e tempo continuam disponíveis.

Quando uma call interrompida não possui settlement mensurável, a observação
parcial continua no ledger, mas não é promovida. Sob limites ativos, o ID
reservado permanece não reconciliado e uma retomada automática da mesma task é
bloqueada até resolução explícita; abrir outra attempt não reinicia nem oculta o
consumo desconhecido.

Os pedidos `--skip-tests`, `--skip-lint`, `--skip-gates` e `--fast` continuam pertencendo à pipeline de verificação comandada pelo Ralph. Eles não ampliam permissão de tool nem desativam budgets.

## Fallback

Fallback usa a lista ordenada de perfis e as classes `fallback_on` configuradas. A resolução é lazy: perfis não selecionados e perfis de judge não relacionados não provocam acesso desnecessário a catálogo, credencial ou driver.

Troca automática é limitada a falhas explicitamente classificadas, como `provider-unavailable`, `model-unavailable`, `rate-limit` ou `transient`. Não há fallback implícito para autenticação inválida, schema/config incorreto, permissão negada, budget esgotado, gate falho ou outcome reprovado.

Executor e judge percorrem a mesma cadeia validada, preservando o papel original, mas usam backends
de fallback próprios. No judge, timeout, sinal anormal e falha de transporte do CLI externo são erros
tipados `transient`; cancelamento, output inválido e exit code não zero sem classificação explícita
não são elegíveis. Como o judge é read-only e não recebe tools, não existe replay de efeito de
workspace entre candidatos. Cada candidato do judge recebe seu próprio worker somente quando é
selecionado. Para um CLI externo, o parent resolve exatamente esse executável, calcula seu hash e
autoriza apenas aquela invocação por argumentos, cwd de configuração, nomes de environment e intent
`judge-transport`; o worker confere o grant, usa o path canônico no config vinculado e recalcula o
hash imediatamente antes do spawn em cwd temporário isolado. Fallbacks posteriores não são
pré-resolvidos nem pré-autorizados. O evento de troca registra perfil falho, perfil selecionado e
classe da falha, sem converter o fallback em aprovação. O `JudgeCall` registra a rota solicitada;
o assessment/report registra o snapshot efetivo do candidato que produziu o output aceito.

Antes de qualquer tool call, um fallback permitido recebe contexto reconstruído pelo Ralph e uma nova model call identificável. Depois que uma tool call foi executada ou pode ter produzido efeito, a S05 bloqueia replay transparente com `RALPH_FALLBACK_RECONCILIATION_REQUIRED`. O diff e o journal são preservados para reconciliação; o próximo provider não repete a ação às cegas.

## Cancelamento e retomada

`SIGINT`/Ctrl+C e `SIGTERM` entram como cancelamento comandado e percorrem command handler, runner, backend, tool host e supervisor. Uma chamada ativa recebe `AbortSignal`; o driver embedded é cancelado e processos/tools encerram sua árvore de forma supervisionada. Races antes, durante e logo depois de `start` são observadas para não deixar handle tardio órfão.

Em cancelamento controlado, run, task, attempt e model call ficam interrompidos/cancelados de forma retomável, alterações parciais permanecem no workspace e o comando encerra com exit code `8`. A próxima execução compatível reconcilia o estado e volta à task não concluída em vez de selecionar a seguinte.

Esta garantia S05 não deve ser confundida com recuperação geral de hard crash. Leases renováveis, retomada após morte abrupta em todos os pontos, watchdog multi-sinal e steal seguro de processo pertencem à S07.

## Eventos, raw output e redaction

Embedded e external CLI convergem para eventos Ralph comandados. Entre os eventos observáveis estão:

- `model.*` para text, reasoning público, tool input/call, warnings, errors, usage e finish;
- `external.cli.started`, `external.cli.output.delta` e `external.cli.settled`;
- `tool.call.requested`, `tool.call.authorized`, `tool.call.started`, `tool.output.delta` e `tool.call.settled`;
- eventos de budget, attempt, evidence, gate, verification e task emitidos somente pelas respectivas autoridades.

Consulte o stream persistido com:

```text
ralph events --run-id <RUN_ID> --format jsonl
ralph status run --run-id <RUN_ID> --format json
ralph report show <RUN_ID> --format json
```

Raw stdout/stderr e frames de provider ficam sob `.ralph/runs/<run-id>/raw/` por chamada/processo, referenciados por hash/URI portável nos settlements e eventos. A visão bounded informa quando output resumido ou raw foi truncado.

Redaction ocorre antes de persistência e também de forma incremental, para que um segredo fragmentado entre chunks não reapareça quando o stream é remontado. Erros de provider são sanitizados. O raw não é uma exceção para vazamento de segredo ou chain-of-thought privada; “raw” significa preservar a saída operacional permitida, não desabilitar segurança.

Esses eventos são a base para os painéis de status, tokens, progresso, logs e engine output da S08. A S05 não reivindica que a TUI rica já esteja entregue.

## Dry-run

Use o mesmo comando de execução com `--dry-run`:

```text
ralph once --prd PRD.md --executor-profile executor-cli \
  --dry-run --non-interactive --format json
```

O dry-run compila o graph, seleciona a task, materializa opções efetivas e valida o backend configurado sem criar run, alterar marker, escrever no workspace ou invocar modelo/processo. Para external CLI, valida o contrato v1, adapter, capabilities e disponibilidade do executável. Ele não resolve valores secretos nem deve abrir rede, keychain ou prompt apenas para inspecionar um candidato não executado.

A saída deve ser tratada como preflight de configuração, não como prova de que a credencial, API ou comportamento do modelo funcionarão em uma execução real.

## Configuração resumida

Perfil embedded:

```text
ralph profiles configure executor-openai \
  --scope workspace --role executor --backend embedded \
  --provider openai --model <MODEL_ID> --credential <CREDENTIAL_REF> \
  --require-tools
```

Perfil external CLI v1 com tools governadas pelo Ralph:

```text
ralph profiles configure executor-cli \
  --scope workspace --role executor --backend external-cli \
  --provider <PROVIDER_ID> --model <MODEL_ID> \
  --cli-executable custom-agent \
  --cli-arg '"--provider"' --cli-arg '"{{provider}}"' \
  --cli-arg '"--model"' --cli-arg '"{{model}}"' \
  --cli-cwd . --cli-adapter protocol \
  --cli-streaming false --cli-tool-calling ralph \
  --cli-cancellation true --cli-usage unavailable \
  --cli-mutation read-only \
  --cli-timeout-ms 300000 --cli-output-limit-bytes 1048576
```

`--cli-arg` é repetível e aceita uma string JSON para preservar quoting de forma determinística. Não coloque tokens, API keys ou session IDs nesses argumentos. Use `--cli-env TARGET=env:SOURCE` somente quando o executável realmente precisar de uma referência de environment aprovada.

## Limitações conhecidas

| Limitação S05 | Consequência operacional | Slice dona |
| --- | --- | --- |
| Embedded implementado para OpenAI e OpenRouter; Anthropic ainda sem adapter | Catálogo/perfil de outro provider não prova execução. | driver futuro + smoke opt-in |
| External CLI roda como executável confiado no host | O cwd temporário não contém um processo malicioso. | S09 |
| External protocol v1 não reporta streaming nem usage | Tokens/custo ficam unavailable; limites dependentes de usage não podem ser aplicados. | versão futura do protocolo |
| Sem judge/self-review S05 | Completion usa evidência/gates da S03. | S06 |
| Sem watchdog/hard-crash completo | Cancelamento controlado é retomável; kill arbitrário ainda não possui toda a matriz. | S07 |
| Sem painéis/popups ricos | Headless/events funcionam; a projeção TUI chega depois. | S08 |
| Sem Sub-PRD/parallel/sandbox completo | Root task serial somente e nenhuma contenção OS forte. | S09 |
| Sem credencial real na suíte normal S05 | E2Es usam transportes/processos fixture; não provam conta, quota ou disponibilidade real. | smoke opt-in/release |

O smoke OpenAI real da S04 é read-only e opt-in. Ele não substitui um smoke real de task com tools, e a ausência de uma credencial real na suíte normal deve permanecer explícita em relatórios.

## Validação focada da S05

Durante a implementação por slices, a S05 usa validações rápidas e proporcionais; a suíte global e a matriz final ficam para o fechamento da S12. Os grupos focados são:

```text
bun test packages/tool-host/tests/tool-host.test.ts
bun test packages/supervisor/tests/supervisor.test.ts
bun test apps/ralph-cli/tests/tool-execution-port.test.ts
bun test apps/ralph-cli/tests/terminal-permission-prompt.test.ts
bun test apps/ralph-cli/tests/s05-services.test.ts
bun test tests/integration/s05-interactive-permissions.test.ts
bun test tests/integration/s05-embedded-e2e.test.ts
bun test tests/integration/s05-external-e2e.test.ts
bun test tests/integration/s05-public-cli-smoke.test.ts
bun test tests/integration/s05-public-cli-embedded-smoke.test.ts
bunx tsc --noEmit --pretty false
bun run schemas:check
```

Além desses entrypoints, os testes focados de `packages/model-drivers/tests/` cobrem aliases/schemas OpenAI, chunks fragmentados, fechamento de tentativa parcial e isolamento causal do retry por fixture golden, redaction incremental, protocolo externo, adapters e cancelamento. Os testes de orquestração cobrem autoridade dos eventos, reserva de calls, budgets/usage e estado retomável.

Os E2Es são deliberadamente diferentes:

- embedded usa transporte OpenAI fixture, mas atravessa a composition real, driver, tool host, evidence, gate e completion;
- external usa processo fixture real e o protocolo/adapters da S05;
- public CLI smoke chama a superfície `once`, consulta `events --format jsonl` e prova que gates/verification precedem `task.completed`;
- cenários adversariais exercitam path protegido, tool inválida, comando destrutivo, texto `TASK_COMPLETE`, queda após write e fallback bloqueado.

Compilar, usar mock ou passar dry-run isoladamente não é prova de suporte real a uma conta/provider. Qualquer execução paga ou por assinatura deve ser opt-in, rotulada e separada da suíte determinística.
