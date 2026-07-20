# 08 — Orquestração, executor, tools e contexto

## A regra de autoridade

O Ralph é uma máquina de execução comandada. O modelo é chamado para produzir propostas, texto e tool calls dentro de uma tentativa. Somente o Ralph pode:

| Ação | Autoridade |
| --- | --- |
| Escolher root PRD/run/task | comando + orchestrator |
| Resolver dependências e próxima task | scheduler determinístico |
| Criar tentativa/revisão/child | supervisor conforme PRD e policy |
| Montar contexto oficial | context builder |
| Autorizar e executar tool call | tool host + permission policy |
| Rodar gates e coletar evidência | verification pipeline |
| Calcular aprovação por threshold | evaluation policy |
| Persistir estado e marcar `[x]` | transaction coordinator |
| Pedir trabalho, sugerir tool call e explicar resultado | modelo executor |
| Produzir nota e parecer estruturado | judge, sem poder de transição |

Texto como “TASK_COMPLETE”, “aprovado” ou “marque concluída” é apenas conteúdo. Não produz transição sem evidence pipeline.

## Máquina de estados

Estados de task:

```text
pending -> eligible -> active -> verifying -> evaluating -> completed
                         │           │             │
                         ├-> retryable_failed <----┘
                         ├-> blocked
                         ├-> cancelled
                         └-> interrupted -> active (resume)
```

Estados de attempt:

```text
created -> preparing -> invoking -> tools -> settling
        -> evidence -> gates -> judgment -> passed|revision|required_failure
```

Transições são enums fechados, validadas no domínio e registradas como eventos. Uma exceção não pode pular diretamente para `completed`.

## Seleção de trabalho

O scheduler:

1. retoma child/tarefa ativa interrompida, se houver;
2. senão seleciona a primeira task pending cujas dependências estejam concluídas;
3. respeita ordem textual, group policy, claims e limite paralelo;
4. ignora tarefas já concluídas apenas após reconciliar marker e ledger;
5. relata grafo bloqueado, ciclo ou dependência falha sem pedir ao modelo para resolver o plano;
6. em `--task <id>`, valida elegibilidade ou exige `--force` com audit event.

No modo `once`, texto posicional não passa pelo resolvedor de IDs: ele define uma fonte `ad-hoc`
imutável. O orquestrador deriva identidade/hash determinísticos, materializa uma única unidade virtual
somente em memória e persiste a descrição no run. A unidade usa o scheduler e o pipeline normal, mas
activation/completion são record-only; marker parity/reparse são exclusivos de fontes `prd`. Resume
recarrega a descrição persistida e rejeita qualquer mudança de fonte. Um inventário bounded protege
PRDs existentes sem exigir que exista um PRD válido; mutação/criação de conteúdo PRD falha em gate
de segurança e nunca autoriza conclusão.

Antes de resolver qualquer backend em uma retomada, o orchestrator localiza o run, reconcilia
completion preparada e valida a correspondência exata entre ledger e marker: `pending|eligible`
exigem `[ ]`, estados iniciados ainda não concluídos exigem `[~]` e
`completed|completed_with_override` exigem `[x]`. Somente depois dessa paridade o `graphHash` do
run pode ser alinhado ao grafo recompilado. Um run novo só é persistido depois de confirmar que o
backend da primeira task realmente selecionada está disponível; um run em `waiting` sem seleção
não consulta provider.

## Modos de execução

### `once`

Executa no máximo uma task elegível, incluindo todas as revisões permitidas e eventual child graph necessário para concluí-la. Sai com código que representa completed, rejected, blocked ou operational error.

### `loop`

Executa tasks elegíveis em sequência até não haver trabalho, atingir limites, receber cancelamento ou encontrar política fail-fast. Cada task recebe contexto reconstruído e independente.

### `wiggum`

Mantém o envelope de contexto integral do Ralph/Wiggum: inclui o PRD completo mais a tarefa selecionada e os guardrails. Dentro desse contexto, a mesma tarefa pode receber múltiplas chamadas do executor até que a condição de encerramento do modo e a verificação sejam satisfeitas, respeitando `max_iterations`, budgets e no-change. Continua existindo apenas uma tarefa oficial selecionada por ciclo, e a palavra final do modelo não substitui os gates.

### `parallel`

Agenda tasks explicitamente independentes em workers/worktrees separados. Não é habilitado por simples ausência de dependência se a policy exigir `Grupo paralelo`. Integração ocorre pelo supervisor conforme estratégia configurada.

### `dry-run` e `plan/inspect`

Compilam graph, resolvem perfis, mostram próxima task, commands/gates, child structure e efeitos previstos sem chamar modelos ou alterar markers. Nunca resolvem credenciais secretas além de checar referência.

O plano informa separadamente se criaria um run: ao inspecionar um run resumível,
`effects.createsRun=false` mesmo que a próxima task ainda crie attempt e invoque backend numa
execução real. JSON e saída humana exibem o snapshot/hash de opções efetivas da task mostrada no
plano, não um preview genérico do documento.

Toda chamada programática do runner fornece o contexto materializado de resolução
`config/profile/CLI`. Isso permite reaplicar `CLI > task > PRD > profile > config` para cada task;
omitir esse contexto é erro determinístico e nunca degrada silenciosamente para as opções da
primeira task. O run/report conservam o snapshot de opções do run, enquanto cada attempt conserva
o snapshot exato da sua task.

### `headless`, `tui` e `attach`

São clientes diferentes do mesmo supervisor/event stream. `--no-ui` não altera a semântica do run. Fechar a TUI pode manter o supervisor rodando ou solicitar stop gracioso; a escolha é explícita.

## Construção do contexto

Cada tentativa recebe um `ContextManifest` materializado e registrado por hash:

1. invariantes do Ralph e tool policy;
2. descrição da task vertical atual;
3. critérios, limites, evidence mode e commands relevantes;
4. contexto do root/parent estritamente necessário;
5. parecer estruturado da revisão anterior, se houver, materializado como recurso bounded e content-addressed dentro do bundle — nunca apenas como path para o executor reler em `.ralph`;
6. estado do workspace: branch, diff resumido, arquivos tocados e artifacts;
7. arquivos/referências declarados no PRD;
8. budget restante;
9. instrução de que o modelo não marca task nem cria sub-PRD.

Não se inclui o PRD inteiro por hábito. O compiler calcula a fatia: task, ancestrais, contratos compartilhados referenciados e dependências cujos outputs foram declarados. O manifest permite diagnosticar perda de detalhe entre execuções.

Context rotation pode resumir transcript anterior, mas fatos normativos sempre vêm de arquivos/ledger, não de resumo do modelo. Um novo provider recebe o manifest reconstruído.

Quando um assessment válido causa uma revisão, o manifest conserva `previousAssessmentRef` para auditoria e aponta também para um resource `assessment` autenticado. A projeção contém `sourceAssessmentRef`, ID do assessment e do evidence bundle, score, threshold, summary, adequate, problems, missing evidence, recommendations e criterion scores. Ela exclui profile/credential, raw response e timestamps do provider. O context builder lê o assessment pela camada autoritativa antes da chamada, limita campos/itens, registra truncamentos e inclui hashes do conteúdo original e incluído; tools do executor continuam proibidas de ler `.ralph` diretamente.

## Contrato do executor

O executor deve:

- trabalhar somente na task recebida;
- inspecionar o estado real antes de editar;
- respeitar limites, paths, sandbox e commands;
- usar tools autorizadas para produzir o entregável;
- comunicar impedimento com evidência;
- finalizar com um `ExecutorOutcome` estruturado: resumo, arquivos/artifacts pretendidos, verificações sugeridas, riscos e estado `work_submitted` ou `blocked_reported`.

Esse outcome é uma alegação. O Ralph coleta a realidade em seguida.

## Model calls embutidos e CLI externo

Ambos implementam `ExecutionBackend`:

```typescript
interface ExecutionBackend {
  capabilities(): BackendCapabilities
  start(request: ExecutionRequest, sink: ModelEventSink): Promise<CallHandle>
  cancel(handle: CallHandle, reason: string): Promise<void>
}
```

- Embedded: mensagens e tools estruturadas, streaming e usage nativos.
- External CLI: processo supervisionado, stdout/stderr e protocolo adapter; tool calling pode ser interno ao CLI ou indisponível.

A task declara requirements e o resolver rejeita backend incapaz. “Output parece certo” não substitui settlement de tool estruturada quando o modo exige isso.

### Composição isolada do executável

O composition root de `apps/ralph-cli/src/main.ts` não entrega esses adapters diretamente ao
runner. Para uma execução real, ele cria fronteiras tipadas e de vida curta:

- cada chamada de executor roda em um worker `executor-model`, recebe task, contexto e snapshot de
  configuração imutável e só alcança o supervisor por RPCs limitadas para reservar model call,
  solicitar tool e emitir evento;
- cada avaliação roda em um worker `judge`; o modo external exige perfil `judge`, enquanto
  self-review reutiliza explicitamente o perfil `executor` e ambos retornam somente alegação
  estruturada;
- o ToolHost permanece no processo autoritativo para policy, prompt, intent-before-effect,
  journal e settlement; somente o efeito já autorizado cruza para um worker `tool-gate`;
- cada gate recebe um registry por attempt e executa no worker `tool-gate`; persistência de
  stdout/stderr volta ao supervisor por RPC, sem fornecer ledger ao worker;
- comandos Git do modo paralelo atravessam um worker `git-integration` com executável, hash,
  argv, cwd e nomes de ambiente vinculados à capability.

O transporte embedded auditado desta versão cobre OpenAI e OpenRouter para executor e judge.
OpenRouter usa exclusivamente credencial API/environment e endpoint fixo do adapter; credencial de
assinatura ChatGPT não é reutilizada. Providers sem driver embedded auditado, incluindo Anthropic
nesta versão, falham fechados e continuam disponíveis apenas se houver um perfil `external-cli`
explicitamente configurado. Um fallback para CLI externo precisa estar nomeado em
`fallback_profiles` e autorizado por `fallback_on`; cada candidato é materializado de forma lazy e
recebe sua própria capability de executável absoluto, hash, argv, cwd e nomes de ambiente somente
quando é selecionado. No executor, qualquer tool call já observada bloqueia fallback para impedir
replay de efeito.

Sub-PRDs seguem uma regra diferente e deliberada: o supervisor externo continua decidindo e
reservando o child, mas o coordinator já autorizado executa como uma instância Ralph real no worker
tipado `child-run`, com lease durável vinculada ao PID/start-token desse processo e policy
`pause-with-parent`. Budget compartilhado, observações e projeções cruzam reverse IPC estreita; as
chamadas de executor/judge/tool/gate e children aninhados usam as mesmas fronteiras isoladas. O worker
não recebe autoria de PRD nem comando arbitrário de launch. `survive-parent` permanece fail-closed até
existir owner de processo, lease de workspace e canal de reattachment realmente independentes.

## Tool host mínimo

Ferramentas base, com nomes estáveis do Ralph:

- `fs.read`: ler arquivo/intervalo;
- `fs.list` e `fs.glob`: navegar dentro do workspace;
- `fs.search`: busca textual/estrutural conforme policy;
- `fs.write`: criar arquivo com controle de precondition;
- `fs.edit`: substituição pequena com before hash;
- `fs.apply_patch`: patch auditável;
- `process.exec`: command permitido, cwd/timeout/env explícitos;
- `git.inspect`: status/diff/log/read-only;
- `artifact.publish`: registrar arquivo de prova já criado;
- tools adicionais por plugin, namespaced e declaradas.

`process.exec` é um caso especial de ownership. O `tool-gate` valida a chamada, mas não possui o
processo: ele usa reverse RPC privado para pedir ao supervisor command-owned a execução. O
supervisor confere novamente o binding imutável do journal, a capability e o fingerprint do direct
argv; então cria um owner interno detached fora da árvore efêmera do worker. Esse owner mantém lease,
PID/start token/host, canal de stop autenticado e lifecycle por intent. Se o worker ou o comando
principal cair, resume só pode aguardar o mesmo owner ou consumir seu settlement persistido; não há
replay de processo. O executável alvo precisa ser um realpath instalado fora do workspace gravável;
scripts/arquivos do projeto continuam argumentos do executável autorizado. Isso impede que o modelo
substitua os bytes autorizados entre fingerprint e spawn. Shell-form continua recusado nessa
fronteira até possuir contrato equivalente.

O bearer do canal de stop evita entrega acidental, descriptor stale e controle de uma identidade de
owner diferente; ele não cria isolamento contra código hostil executado sob o mesmo usuário do SO.
Sem container/OS sandbox, esse código já pode sinalizar processos do usuário e tentar ler o control
plane. Código de workspace não confiável exige backend forte com `controlRoot` fora dos mounts.

O Ralph não precisa obrigar uma linguagem ou build tool. Commands e allowlists vêm do projeto/PRD/config.

## Ciclo de tool call

1. Driver emite `tool.call.requested` com schema-valid arguments.
2. Tool host normaliza paths e calcula risco.
3. Permission policy decide `allow`, `deny` ou `ask`.
4. Em headless, `ask` segue policy predefinida; nunca fica esperando popup invisível.
5. Ralph emite `tool.call.started` e heartbeat de controle.
6. Executor da tool aplica timeout/cancelamento e captura stdout/stderr.
7. Resultado é limitado, redigido, persistido e devolvido ao modelo.
8. `tool.call.settled` diferencia success, nonzero, denied, timeout e cancelled.
9. Só o orchestrator decide continuar, revisar ou falhar.

Uma tool call deve ser idempotente quando possível, ou registrar `idempotencyKey`/efeitos antes de execução. Após crash, calls sem settlement entram em reconciliação; nunca são repetidas cegamente se puderem ter efeitos externos.

## Permissões

Policies combinam:

- workspace/read paths;
- write paths;
- comandos/argumentos/env permitidos;
- rede e destinos;
- risco destrutivo;
- interação humana;
- limite de output e duração;
- papel (`executor` não equivale a `judge`).

O judge é read-only por padrão: recebe evidence bundle e não recebe tool de escrita. Se puder inspecionar repository, as tools são read-only, limitadas e registradas.

## Limites distintos

Não conflar:

- `max_model_calls_per_attempt`;
- `max_tool_calls_per_model_call`;
- `max_iterations` do wiggum;
- `executor_retries` por falha transitória;
- `judge_transport_retries` por resposta inválida/transporte;
- `max_revision_attempts` após reprovação válida;
- timeouts de call, tool, gate, task e run;
- budgets de input/output/reasoning/custo.

Cada contador aparece em status e relatório. Alcançar limite encerra no estado correspondente; não começa silenciosamente uma nova categoria de tentativa.

## Cancelamento e encerramento

Ctrl+C tem duas fases configuráveis:

1. primeiro sinal: stop gracioso, não agenda nova task, cancela/aguarda ponto seguro e persiste;
2. segundo sinal: force stop, mata workers/process tree, marca operações unsettled e preserva resume.

No Windows, subprocessos devem ser colocados em job object ou mecanismo equivalente; em Unix, process group. Children recebem sinal do supervisor, não ficam órfãos.

## Critérios de aceite

- Nenhum texto do modelo consegue marcar task ou alterar policy.
- Todos os modos usam a mesma máquina de estados e evidence pipeline.
- Contexto de uma task é reconstruível por manifest/hash.
- Tool calls são autorizadas, limitadas, auditadas e settled.
- Embedded e external CLI produzem o mesmo contrato mínimo de eventos/resultados.
- Retries, revisões, iterações e timeouts têm contadores distintos.
- Cancelamento deixa estado retomável e não abandona process tree.
