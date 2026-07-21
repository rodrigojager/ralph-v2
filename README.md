# Ralph v2

Reescrita independente do Ralph CLI em TypeScript/Bun. O primeiro release é o beta
`0.1.0-beta.2`; o único executável e comando público é `ralph`. A v2 substitui a instalação do CLI
anterior no `PATH`, enquanto migração de workspace/configuração continua explícita e reversível.

O source contém as superfícies integradas de S01–S12:
fundação headless, compilador de planos, execução autoritativa, providers/modelos/credenciais
independentes, ToolHost, evidências/judge, persistência e retomada, watchdog, TUI, children,
paralelismo, Git, sandbox, comandos operacionais, migração, distribuição e skill. Isso inclui workspace
v2 isolado, configuração versionada, ledger/eventos locais, PRD v2 legível por humanos com AST
CommonMark e schemas fortes, modos once, loop e Wiggum governados por evidence/gates, catálogo
cacheado, perfis separados de executor/judge, backends embutidos OpenAI e OpenRouter, backend CLI
externo, deterministic-only, self-review e judge externo com score, parecer, threshold e revisões
limitadas. O beta publica somente o target Windows x64 definido pela support policy; os demais
targets continuam visíveis como `not-promoted`, sem transformar build ou teste de contrato em claim
de suporte.

A implementação das slices posteriores acrescenta supervisor e workers com
leases/watchdog/cancelamento, telemetria e raw streams, TUI live/attach/replay, paleta de
configuração pré-run, barra de progresso responsiva, agregação de usage, sub-PRDs supervisionados,
paralelismo, fronteiras Git/checkpoints/sandbox e comandos de operação/migração. A matriz CI executa
quality em Windows/Linux/macOS x64 e uma seleção nativa bloqueante nos seis pares declarados de
OS/arquitetura, com skips classificados. O release handoff content-addressed registra o run, o
commit, os artifacts e os drills exatos do beta. Smokes reais de provider/auth continuam opt-in e
qualquer ausência permanece publicada como limitação, nunca como aprovação implícita.

A matriz focada de distribuição S12.02 também passou localmente: `bun run test:s12:distribution`
executou 8/8 testes e 91 asserções sobre fixtures `nightly`/`*-dev.1` unsigned, cobrindo install,
HTTPS fake sem rede, tamper, check/update, rollback, crash recovery e uninstall receipt-bound. Essa é
evidência `local-contract-only`; os drills do artifact candidato são registrados separadamente no
handoff de release. No host atual, use TEMP fora de `C:` para esse teste: o marcador
`C:\.git` faz o instalador recusar corretamente roots temporários daquele drive como checkout.

A composição legada de teste da S03 continua usando um backend programável injetado explicitamente. O binário normal não registra o perfil `fake` nem outro executor oculto. A S05 acrescenta execução real por OpenAI/OpenRouter embutidos ou processo CLI externo, sempre sob tools, permissões, budgets, eventos e cancelamento comandados pelo Ralph. A S06 acrescenta evidence bundle imutável, gates honestos, judge/self-review e recuperação auditada do budget de revisões. A S07 endurece a execução supervisionada; a S08 conecta observabilidade e configuração à TUI; S09 e S10 fecham sub-PRDs, paralelismo, Git, segurança e operação/migração sem transferir autoridade para modelos ou renderers.

## Princípio de autoridade

O Ralph é o controlador; modelos são ferramentas subordinadas.

> A IA pode produzir trabalho e propor tool calls, mas somente comandos e a máquina de estados do Ralph poderão selecionar tarefas, autorizar ferramentas, aplicar políticas, verificar evidências, persistir estado e marcar conclusão.

O Ralph v2 não é um frontend do OpenCode. A S04 adapta de forma curada partes delimitadas de provider/catalog e do protocolo ChatGPT/Codex, atrás de contratos próprios e com proveniência registrada. UI, session runner, agente e autoridade de execução do OpenCode não são incorporados.

## Estado atual

A superfície pública implementada ou em integração estática é:

```text
ralph init [--force] [--workspace PATH] [--format human|json]
ralph clean [--force|--dry-run] [--workspace PATH]
ralph once "DESCRIÇÃO AD-HOC" [opções de execução]
ralph once [--task DOCUMENT/TASK] [--prd PATH] [opções de execução]
ralph run [--prd PATH] [--max-tasks N] [--fail-fast] [opções de execução]
ralph loop [--prd PATH] [--max-tasks N] [--fail-fast] [opções de execução]
ralph parallel [--prd PATH] [opções de concorrência]
ralph run --wiggum [--max-iterations N] [--prd PATH] [opções de execução]
ralph status [--workspace PATH] [--format human|json]
ralph status run [--run-id ID] [--workspace PATH] [--format human|json]
ralph resume [RUN_ID] [--accept-workspace-changes]
ralph stop [RUN_ID] [--graceful] [--grace SEC] [--force]
ralph attach [RUN_ID] [--workspace PATH]
ralph replay [RUN_ID] [--workspace PATH]
ralph events [--run-id ID] [--follow] [filtros] [--format human|json|jsonl]
ralph logs tail [--run-id ID] [--source SOURCE] [--follow] [filtros]
ralph verify --run-id ID --task DOCUMENT/TASK [opções de gate]
ralph verify --attempt-id ID [opções de gate]
ralph verify --evidence-bundle-id ID [opções de gate]
ralph judge --run-id ID --task DOCUMENT/TASK [opções de judge]
ralph judge --attempt-id ID [opções de judge]
ralph judge --evidence-bundle-id ID [opções de judge]
ralph judge --verification-id VERIFY_OPERATION_ID [opções de judge]
ralph evidence inspect <ATTEMPT_ID> [--workspace PATH] [--format human|json]
ralph report last [--workspace PATH] [--format human|json|jsonl]
ralph report show <RUN_ID> [--workspace PATH] [--format human|json|jsonl]
ralph tasks list [--all|--pending|--completed|--review] [--prd PATH]
ralph tasks next [--prd PATH]
ralph tasks done <TASK> --reason TEXT --evidence PATH --force
ralph tasks sync --repo OWNER/REPO [--state open|closed|all] [--output PATH]
ralph review retry --run-id ID --task DOCUMENT/TASK
  --additional-revisions N --reason TEXT [--workspace PATH] [--format human|json]
ralph providers list [--refresh] [--format human|json|jsonl]
ralph providers inspect <PROVIDER> [--refresh] [--format human|json|jsonl]
ralph models list [--provider PROVIDER] [--require-tools]
  [--require-structured-output] [--refresh] [--format human|json|jsonl]
ralph models inspect <PROVIDER/MODEL> [--refresh] [--format human|json|jsonl]
ralph auth connect <PROVIDER> --method <METHOD> [opções seguras de credencial]
ralph auth list [--provider PROVIDER] [--format human|json|jsonl]
ralph auth status [CREDENTIAL] [--provider PROVIDER] [--refresh]
ralph auth revoke <CREDENTIAL> [--format human|json|jsonl]
ralph profiles list [--role executor|judge] [--format human|json|jsonl]
ralph profiles inspect <PROFILE> [--format human|json|jsonl]
ralph profiles configure <PROFILE> --scope global|workspace [opções de perfil]
ralph model smoke --profile <PROFILE> [--refresh] [--format human|json|jsonl]
ralph doctor [--non-interactive] [--workspace PATH] [--format human|json]
ralph install <INSTALL_ROOT> --manifest <PATH|HTTPS> [--channel CHANNEL] [--dry-run]
ralph update --install-root <INSTALL_ROOT> [--manifest <PATH|HTTPS>] [--check|--dry-run]
ralph rollback --install-root <INSTALL_ROOT> [--to-version VERSION] [--dry-run]
ralph uninstall <INSTALL_ROOT> [--dry-run]
ralph config explain <key> [--format human|json]
ralph config get <key> [--format human|json]
ralph config list [--effective] [--format human|json]
ralph config preview <key> <value> [opções de execução]
ralph config set <key> <value> --scope workspace|global
ralph config unset <key> --scope workspace|global [--dry-run]
ralph config edit [INPUT.yaml|json] --scope workspace|global [--dry-run]
ralph config import <INPUT.yaml|json> --scope workspace|global [--dry-run]
ralph config export --scope workspace|global|effective
  [--serialization yaml|json] [--output PATH] [--force]
ralph config validate [--workspace PATH] [--format human|json]
ralph adapters list|new|inspect [argumentos do subcomando]
ralph recipes list|new|show [argumentos do subcomando]
ralph rules list|add|clear [argumentos do subcomando]
ralph context inspect|export|rotate [argumentos do subcomando]
ralph checkpoint create|list|show [argumentos do subcomando]
ralph rollback preview|apply [argumentos do subcomando]
ralph lang current|list|set|update [argumentos do subcomando]
ralph prd validate [PRD] [--recursive] [--strict] [--format human|json]
ralph prd inspect [PRD] [--recursive] [--strict] [--format human|json]
ralph prd format [PRD] [--check|--output PATH|--in-place]
ralph prd migrate [PRD] [--output PATH|--in-place] [--report PATH]
ralph migrate inspect <LEGACY_WORKSPACE> [--format human|json]
ralph migrate apply <LEGACY_WORKSPACE> --destination PATH
  [--import-adapters] [--import-recipes]
ralph migrate rollback <ROLLBACK_MANIFEST> --dry-run
ralph migrate rollback <ROLLBACK_MANIFEST> --confirm-plan-hash SHA256
ralph help [--format human|json]
ralph version [--format human|json]
ralph about [--format human|json]
```

No pacote standalone, `current.json` referencia um receipt geracional imutável e é a única
autoridade atômica de ativação. O uninstall real é delegado a um helper copiado para fora do
install root, que espera launcher/engine encerrarem e revalida token, hash, receipt e ownership;
sem essa composição ele falha fechado antes de remover arquivos. `.ralph`, configuração global e
credenciais permanecem fora do alvo. A remoção de uma instalação antiga do CLI é uma etapa explícita
e separada antes de instalar a v2 sob o mesmo comando `ralph`.

O contrato local desse lifecycle pode ser reexecutado isoladamente com
`bun run test:s12:distribution`. Ele não baixa rede real nem publica artifacts; os casos formais de
release continuam em [`docs/28-release-drills-beta-e-handoff-s12.md`](docs/28-release-drills-beta-e-handoff-s12.md).

Não existe alias ou segundo nome de executável para a v2. O procedimento de inventário, remoção da
instalação anterior, instalação da v2 e verificação da resolução de `ralph` está em
[`docs/28-release-drills-beta-e-handoff-s12.md`](docs/28-release-drills-beta-e-handoff-s12.md).

Esta checkout compõe estaticamente paths externos, provider-neutral e versionados para signer e
verifier de release, mas não escolhe adapter, ferramenta, chave, identidade, issuer nem trust root.
Sem promotion evidence, configuração independente de confiança e validação real, manifests
assinados e `stable` continuam não instaláveis hoje. No Windows, a ausência de directory fsync é
registrada honestamente como garantia reduzida. Uma policy de suporte v1 agora mantém os seis
targets visíveis e exige `included` ou `not-promoted` com motivo; Windows não pode ser `included` em
`stable` enquanto essa capability permanecer reduzida. O repositório não escolhe o subconjunto por
default, e `included` em canais anteriores não significa suporte testado. O template
`examples/release-support-policy.template.json` mantém as seis linhas visíveis, mas é
deliberadamente inválido até o release owner escolher versão/channel e pelo menos um target.

No Bun `1.3.14` para Windows ARM64, `bun:ffi`/TinyCC não está disponível e o renderer nativo do
OpenTUI não pode inicializar. Nesse target, `--ui auto` preserva a execução pela apresentação
headless e `--ui tui` falha fechado com diagnóstico; a engine, persistência, supervisão e comandos
headless continuam na matriz obrigatória. O target permanece `not-promoted` até existir uma
combinação de runtime/renderer validada. Os skips de PTY/TUI correspondentes são waivers
classificados, não resultados aprovados.

Os comandos de execução aceitam `--ui auto|tui|plain|none`. Em terminal interativo, `auto` pode
abrir a paleta pré-run e, depois da persistência durável do run, a TUI operacional. `plain` e `none`
preservam o uso direto por linha de comando e automação headless. Attach observa o run ao vivo;
replay usa uma projeção congelada e nunca oferece ações mutáveis sobre aquele snapshot.

`setup`, `cancel`, `ui`, `connect`, `config reset`, `context show|refresh` e `checkpoints` são aliases
registrados para os comandos correspondentes; `-h`/`--help` e `-V`/`--version` também são aceitos.
`help --format json` expõe o catálogo canônico completo e machine-readable. JSON segue o envelope
público `CommandResult` v1 e não recebe banner nem ANSI.

## PRD v2 e Sub-PRDs

O PRD v2 mantém contexto humano em Markdown e usa uma seção normativa `## Vertical slices`. O frontmatter `ralph_prd: 2` seleciona inequivocamente o formato; cada tarefa possui ID, resultado, dependências, limites, modo de evidência e referência explícita de Sub-PRD ou `nenhum`. O parser usa CommonMark AST para estrutura e regex apenas em tokens folha.

Antes de qualquer execução, o compilador resolve root e children, valida paths canônicos, parent/child, IDs, dependências, ciclos, defaults e budgets e produz um graph tipado com hash estável. Child ausente ou inválido falha sem chamar modelo. A atualização `[ ]`/`[~]`/`[x]` usa offsets UTF-8 e preserva todos os bytes fora do caractere do marker.

O runtime é apenas consumidor. A autoria do root e de todos os Sub-PRDs ocorre antes do run pela skill externa descrita em [skill-contract/ralph-loop-prd-generator](skill-contract/ralph-loop-prd-generator/README.md); o executor nunca recebe fallback para criar ou expandir o próprio plano.

Ao alcançar uma referência já compilada, o comando reserva o run filho e inicia uma instância Ralph
real no worker tipado `child-run`. A lease pertence à identidade real desse processo; budget global,
heartbeat, observações e eventos atravessam IPC estreita, enquanto o worker recompila e confere os
hashes do plano antes de coordenar seu escopo e seus próprios children. A policy disponível é
`pause-with-parent`; `survive-parent` falha fechado até existir owner e reattachment independentes.
Na supervisão child, heartbeat periódico, ping semântico, progresso e PID/start-token são sinais
separados; heartbeat e ping compartilham uma única família negativa no quorum quando o control plane
IPC cai, e silêncio de progresso não revoga uma lease saudável. `watchdog.enabled=false` desarma suas
ações e deadlines; `restart-attempt` encerra a sessão anterior e retoma o mesmo run/task em novo worker
dentro do budget persistido, sem cobrar novamente a leaf já debitada.

O pacote distribuível da skill está em
[`skills/ralph-loop-prd-generator`](skills/ralph-loop-prd-generator/SKILL.md), com templates root/child
e referências de vertical slicing, formato, revisão final e
[curadoria pública](skills/ralph-loop-prd-generator/references/curation.md) com padrões adotados e
rejeitados. O catálogo de 60 schemas já foi gerado e conferido pelo validator oficial no ciclo local
atual. Isso não substitui o forward test completo da skill em um cenário complexo nem autoriza
afirmar que o pacote distribuível de S12 está promovido.

O fluxo completo de uso está consolidado em
[`docs/24-guia-do-usuario-s12.md`](docs/24-guia-do-usuario-s12.md). A arquitetura operacional,
recuperação de incidentes, distribuição, release e contribution gate estão em
[`docs/25-guia-do-operador-e-desenvolvedor-s12.md`](docs/25-guia-do-operador-e-desenvolvedor-s12.md).
A cobertura R001–R079, a evidência local já produzida, as provas ainda pendentes e os blockers de release estão em
[`docs/27-auditoria-estatica-e-validacao-diferida-s11-s12.md`](docs/27-auditoria-estatica-e-validacao-diferida-s11-s12.md).
Os drills determinísticos de release/beta, diagnostics locais e substituição controlada da
instalação anterior estão em
[`docs/28-release-drills-beta-e-handoff-s12.md`](docs/28-release-drills-beta-e-handoff-s12.md).
Esses documentos distinguem implementação, validação local Windows, artifact publicado e smoke real
opt-in; nenhuma prova local promove por si só esta checkout.

```text
bun run ralph -- prd validate examples/PRD-v2-exemplo.md --recursive --strict
bun run ralph -- prd inspect examples/PRD-v2-exemplo.md --recursive --format json
```

## Execução autoritativa S03

O desenho implementado faz `once`, `loop` e `run --wiggum` passarem pelo mesmo scheduler, lifecycle de attempt, coleta de evidência, gates e completion policy. `run` sem `--wiggum` usa a mesma orquestração bounded de `loop`; `loop` preserva a grafia operacional familiar. As diferenças de modo ficam restritas à seleção/quantidade de tarefas e ao envelope de contexto:

- `once "texto"` executa uma unidade ad hoc persistida, com evidência/report; o CLI não materializa PRD nem altera marker e recusa a conclusão se o backend violar essa fronteira;
- `once --task DOCUMENT/TASK --prd PATH` seleciona uma tarefa PRD sem ambiguidade; sem texto/`--task`, executa a próxima elegível;
- `run` e `loop` processam tarefas elegíveis em ordem determinística, respeitando dependências, `--max-tasks` e `--fail-fast`;
- `run --wiggum` relê o PRD completo somente depois de conferir seu hash e limita iterações e model calls separadamente;
- `--dry-run` compila o graph, resolve a tarefa e as opções efetivas sem chamar backend, criar run ou alterar marker;
- `--run-id` solicita uma run persistida compatível; sem ele, uma run retomável compatível pode ser escolhida deterministicamente.

A execução de fonte `prd` aceita somente root PRD v2 compilado de forma recursiva e estrita. PRD clássico precisa passar por `prd migrate`. `once "texto"` é a exceção explícita: materializa uma unidade virtual apenas em memória e persiste a descrição/hash, não um PRD. Child edges pré-autorizados são supervisionados por runs vinculados e retomáveis; o runtime nunca gera sub-PRD. A autoria de root e children continua exclusiva da skill externa. `mode=parallel` usa scheduler próprio com capacity/claims/worktrees e não cai no loop serial quando isolamento ou elegibilidade faltam.

O output do executor é apenas uma alegação. Nem `TASK_COMPLETE` nem outro texto conclui trabalho: o Ralph compara baseline/delta, diagnostica arquivos fora de scope, executa verificações aplicáveis e só então coordena `prepared -> marker-written -> committed`. Gate bloqueante falho mantém a tarefa não concluída e preserva as mudanças do usuário; o Ralph não faz reset, checkout, clean, stash ou rollback implícito.

As policies canônicas de no-change são `require-change`, `allow-no-change`, `fail-on-no-change` e `retry-on-no-change`. `--skip-tests`, `--skip-lint`, `--skip-gates` e `--fast` são pedidos auditáveis: por default só pulam verificações declaradas `allowed-to-skip`; pular uma verificação `required` também exige `--force` e pode produzir no máximo `completed_with_override`. `--no-commit` registra a desativação de eventual commit opcional; a S03 não cria commits.

Sem um perfil executor válido, a execução normal — inclusive `--executor-profile fake` — encerra com exit code `6` antes de criar run ou ativar marker. O backend programável continua restrito a `packages/test-kit`, é injetado por harnesses descartáveis e não abre uma porta escondida no artefato normal. Em produção, a S05 resolve explicitamente um perfil OpenAI `embedded` ou `external-cli`; nenhum deles recebe autoridade para selecionar ou concluir a tarefa.

Observabilidade persistida fica disponível pelos comandos:

```text
ralph status run [--run-id ID]
ralph events [--run-id ID] [--follow] [--format human|json|jsonl]
ralph logs tail [--run-id ID] [--source audit|human|raw-engine|tool|gate|diagnostic]
  [--task DOCUMENT/TASK] [--worker-id ID] [--type EVENT] [--level LEVEL]
  [--since ISO] [--limit N] [--follow] [--format human|json|jsonl]
ralph report last
ralph report show <RUN_ID>
```

`status run` projeta run, tarefas, attempts e progresso; `events` consulta o ledger autoritativo; `logs tail` projeta views redigidas e reconstruíveis do mesmo stream; reports ficam no SQLite e em `.ralph/runs/<run-id>/reports/report.json`. Em follow, human escreve linhas, JSONL escreve records e JSON mantém um único array até o encerramento cooperativo. Counters de attempts, model calls, no-change, iterações Wiggum, revisões e restarts de watchdog permanecem separados.

O `/goal` do Codex é somente o mecanismo usado para implementar este repositório. Ele não integra o binário, o formato de PRD, a configuração, os backends ou o runtime do Ralph v2. O produto final é o Ralph CLI que consome PRDs e Sub-PRDs por conta própria.

## Providers, autenticação e modelos S04

`providers list|inspect` e `models list|inspect` usam snapshots validados de Models.dev, cache local com TTL e fallback curado. A saída registra ID, origem e estado stale do snapshot; metadata remota é tratada somente como dado e nunca executada. OpenAI e OpenRouter estão `available` na curadoria; OpenRouter usa o endpoint Responses compatível fixado e somente credencial API/environment. Anthropic permanece `unknown`: pode ser catalogado, receber credential refs e compor perfil, mas não possui driver embedded reivindicado.

API keys entram por prompt mascarado ou `--secret-stdin`; o valor nunca é aceito em argv. O método `environment` persiste somente o nome da variável. Segredos ficam no Windows Password Vault, macOS Keychain ou Secret Service/`secret-tool` no Linux; config global/workspace contém apenas IDs de `CredentialRef`. O runtime atual falha fechado se o keychain não estiver disponível e não ativa plaintext silenciosamente.

O fluxo de conta ChatGPT Plus/Pro é embutido, com browser OAuth/PKCE/callback ou device code, refresh e storage seguro. Ele não chama o executável `codex`. O snapshot OpenCode fixado fornece a origem protocolar, mas o Ralph continua controlador e não incorpora o session runner do OpenCode. Revogação sempre remove tokens locais; para o protocolo ChatGPT fixado, sem endpoint remoto estável, ela não promete encerrar sessões remotas da conta.

Executor e judge possuem perfis, providers, modelos e credenciais independentes. `fallback_profiles`
é ordenado e `fallback_on` limita troca a `provider-unavailable`, `model-unavailable`, `rate-limit`
ou `transient`; nenhuma falha determinística ganha fallback implícito. `profiles configure` oferece
flags completas, formulário TTY mínimo e `--inherit-profile-field <metadata-id>` repetível sobre a
mesma metadata. Os popups e painéis ricos integrados na S08 projetam os mesmos estados
`inherit|set|clear`; attach/replay continuam read-only para o snapshot do run.

`model smoke` envia um prompt fixo read-only com `tools: []`, normaliza eventos e usage e persiste raw output redigido por referência SHA-256. Os drivers OpenAI e OpenRouter fazem essa chamada; ela não executa tarefa de PRD. Usage declara `reported`, `derived`, `estimated` ou `unavailable`, sem fabricar contagens ou custo.

O guia com comandos exatos, paths, headless auth, limitações e smoke real opt-in está em [docs/20-providers-auth-e-modelos-s04.md](docs/20-providers-auth-e-modelos-s04.md). Não há afirmação de login ou chamada paga real sem o harness opt-in correspondente.

## Tool host e execução S05

Perfis `embedded` OpenAI e `external-cli` implementam o mesmo contrato mínimo de execução. Cada turno real reserva uma model call; tools são materializadas pelo comando e executadas por um ToolHost com journal durável `requested -> authorized -> started -> settled|unsettled`. O modelo recebe apenas settlements bounded e devolve uma alegação `ExecutorOutcome`; evidence, gates e completion continuam pertencendo à orquestração.

O conjunto mínimo inclui leitura, listagem, glob, busca, write/edit/patch preconditioned, processo supervisionado, inspeção Git e publicação de artifact. Paths canônicos, symlinks/junctions, scopes, regras exatas de executable+argv, environment mínimo, redaction e limites de bytes protegem essas fronteiras. `allow|deny|ask` funciona tanto por confirmação em terminal quanto headless; `--non-interactive` nunca abre prompt e `--headless-ask` resolve a decisão de forma explícita e auditável.

O backend CLI externo suporta adapters versionados `protocol`, `known-output` e `generic`. Seu cwd temporário e `mutation_mode: read-only` reduzem efeitos acidentais, mas não são sandbox de kernel. A S09 acrescenta boundary command-owned de sandbox process/Docker/Podman conforme capability e policy; quando sandbox está desativado, o executável configurado continua sendo código confiado pelo usuário. Fallback é comandado e somente ocorre para classes configuradas antes de qualquer tool call; depois de um efeito possível, a execução para para reconciliação em vez de repetir a ação com outro provider.

Ctrl+C/SIGTERM percorre comando, runner, backend, tool host e supervisor. O estado controladamente interrompido permanece retomável. Usage reportada aplica o menor limite entre task e perfil para input/output/reasoning/total/custo; quando usage é indisponível, o Ralph não fabrica zero. Raw output redigido fica por referência sob o run e a observação normalizada está disponível em `events --format jsonl`.

Esses limites são cumulativos para a task inteira no run, incluindo fallback,
iterações Wiggum e novas attempts de revisão; o contexto recebe apenas o saldo.
Cada provider/process call real precisa de reservation e settlement final. Custo
reportado pelo provider conserva sua fonte independente; custo derivado só existe
quando o price snapshot imutável se aplica ao acesso, o vetor faturável completo
foi reportado e toda métrica não zero possui rate; uma dimensão omitida só é
aceita quando o catálogo imutável prova que ela é inaplicável ao modelo. Caso contrário, o custo permanece ausente e um warning durável
explica a indisponibilidade, de modo que limite de custo ativo falhe fechado.

A política `telemetry` também é congelada nas opções efetivas do run. Raw opcional
só existe quando persistência e redaction estão habilitadas, output de processo usa
streams estruturados rotacionados e `event_retention` considera a política do
próprio run terminal; evidence/artifacts não entram nessa remoção. `null` não
inventa expiração, embora os budgets seguros de quantidade e bytes continuem
valendo.

Retenção, streams e capturas de modelo usam a mesma autoridade cross-process por
root, com PID/start-token/hostname/heartbeat/grace e reclaim somente após morte ou
PID reuse comprovados. Paths raw são abertos sem seguir links quando a plataforma
permite e sempre revalidados por ancestry, lstat/fstat e identidade do pai. A
policy de eventos é snapshotted em cada row; workspace events usam contexto
durável isolado por processo de comando, legado desconhecido e `null` explícito falham fechado sem
adotar um default futuro. Refs de stream nomeiam o stream completo, não apenas o
último segmento.

O contrato operacional completo, exemplos de perfil, limitações e comandos de validação focada estão em [docs/21-tool-host-e-execucao-s05.md](docs/21-tool-host-e-execucao-s05.md). Os smokes normais usam transportes/processos fixture; uma credencial, quota ou conta real nunca é alegada sem smoke opt-in separado.

## Evidências, judge e revisões S06

Toda attempt concluída pela S06 produz um `EvidenceBundle` v2 imutável e content-addressed. O bundle reúne a especificação compilada da task, baseline e delta, artifacts, gates, tools, contexto, perfil, usage, segurança, truncamentos e histórico necessário. `evidence inspect` verifica schema, binding e hashes antes de apresentar a prova; texto do executor ou do judge nunca substitui essa leitura.

As avaliações disponíveis são:

- `deterministic-only`, sem chamada julgadora e sem nota inventada;
- `self`, em uma nova chamada read-only do executor usando o mesmo bundle, prompt, rubrica e schema do judge;
- `external`, com perfil de judge independente;
- `manual`, que deixa a decisão aguardando ação explícita.

Gates bloqueantes são aplicados antes da nota. O Ralph calcula aprovação a partir de threshold, severidades e critérios obrigatórios; o judge retorna apenas score e parecer detalhado. Uma reprovação válida pode iniciar até `max_revision_attempts` correções, sempre com novo attempt/evidence/assessment e com contadores distintos de retry de transporte, Wiggum, no-change e restart de watchdog. Ao esgotar a policy `manual-review`, `review retry` pode conceder revisões adicionais de forma auditada e retomar o mesmo run sem alterar o snapshot original de opções.

Os comandos top-level `verify` e `judge` são operações separadas e não mutam task/marker.
`verify` parte de uma evidence persistida, reexecuta gates e grava uma evidence nova sem executor.
`judge` avalia evidence de execução ou de um `verify` exato, usa external por default ou self com
`--self-review`, exige backend read-only sem tools e persiste score, threshold, adequado, problemas,
evidência ausente, recomendações, IDs e raw refs. Seleção por task exige `--run-id`; attempt,
evidence e verification operation são seletores imutáveis. Não há escolha truncada do “run mais
recente”, revisão de código ou aplicação automática do parecer à task.

`--skip-tests`, `--skip-lint`, `--skip-gates`, `--no-gates` e `--fast` são pedidos auditáveis. Cada resultado continua identificado como skip; verificações `required` só atravessam um override explícito com `--force`, e a conclusão fica distinguida como `completed_with_override`. `instruction:` é contexto humano `never-run` e não bloqueante: não é agendada, contada ou aceita como evidence de critério. Modos `change-only` e `artifact` provam materialização declarada, não fabricam correção semântica. Quando a skill não encontra nenhum entregável natural, ela pode pré-declarar um receipt bounded ligado à task para produzir diff/hash mínimo; ele registra a ação e limitações, mas não vira oracle semântico.

`attach` abre a projeção TUI read-only de um run persistido e mostra progresso, barra responsiva,
usage total/executor/judge/children, output permitido, eventos, tools, gates, watchdog e parecer.
`replay` apresenta a mesma projeção a partir de um snapshot congelado. A paleta mostra valor efetivo,
origem e equivalentes de config/CLI: em attach/replay, `Apply for this run` é recusado porque as
opções persistidas são imutáveis; salvar um default workspace/global continua permitido mediante
confirmação e afeta somente runs futuros. Em uma execução nova, a paleta pré-run pode aplicar o
draft antes da criação do run, mantendo CLI, config e TUI sobre o mesmo command model.

## Bootstrap rápido

Pré-requisitos desta fase:

- Bun `1.3.14`;
- Git disponível no `PATH` para o diagnóstico completo;
- Windows, Linux ou macOS em uma arquitetura suportada pelo Bun.

No checkout:

```text
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:s12:distribution
bun run build
bun run smoke
```

Executar diretamente do source:

```text
bun run ralph -- version
bun run ralph -- help
bun run ralph -- init --workspace <diretorio> --format json
bun run ralph -- status --workspace <diretorio> --format json
```

Depois de `bun run build`, o standalone nativo fica em:

```text
dist/standalone/<bun-target>/ralph[.exe]
```

O smoke copia esse executável para um diretório temporário externo ao checkout e valida os comandos públicos em um workspace com espaços e Unicode. Builds cruzados gerados por `bun run build:all` são artefatos experimentais: construir em uma plataforma não equivale a testar o executável de outra.

Consulte [DEVELOPMENT.md](DEVELOPMENT.md) para os comandos completos, contratos de teste e diagnóstico.

## Workspace v2

`init` cria somente estado identificado da v2 sob o diretório alvo:

```text
.ralph/
  workspace.json
  config.yaml
  events.jsonl
  state/
    ledger.sqlite
    migrations/
  runs/
  locks/
  cache/
  checkpoints/
```

`workspace.json` contém um UUID persistido e funciona como sentinela de identidade. Um `.ralph` não vazio sem essa identidade é recusado para evitar colisão com state legado ou desconhecido. Na descoberta por ancestrais, o primeiro `.ralph` é uma fronteira: o Ralph nunca o ignora para anexar o comando a outro workspace mais alto. `--force` pode reparar arquivos ausentes de um workspace v2 identificado, mas não autoriza sobrescrever state legado, configuração existente ou PRD.

SQLite é a fonte autoritativa para estado/eventos desta fase. `events.jsonl` é uma projeção append-only produzida por outbox transacional para export e replay. Eventos de inicialização usam escopo de workspace; nenhum run sintético é criado apenas para acomodá-los.

## Configuração

O formato humano canônico é YAML com schema versionado. Nesta slice, a precedência observável é:

```text
CLI > variável de ambiente suportada > workspace > global > builtin
```

Somente variáveis mapeadas explicitamente entram na resolução. `config explain <key>` mostra valor efetivo e origem; segredos futuros serão apenas referências e nunca valores expostos.

O arquivo do workspace é um overlay parcial estrito e versionado; `init` grava apenas `schema_version: 1`. Assim, valores não fixados no projeto continuam herdando configuração global ou defaults, e o resultado mesclado completo é validado antes do uso.

Nas camadas persistidas, `profiles` é um mapa tipado de overlays parciais `executor|judge`; a
composição builtin → global → workspace precisa resultar em um perfil completo. Cada entrada pode
fixar backend, provider, model, credential ID, variante, requirements, limites e fallbacks, mas nunca
o valor secreto. `profiles configure` grava atomicamente no escopo escolhido, preserva folhas
ausentes da própria camada, permite remover um override com `--inherit-profile-field`, oferece clears
explícitos tipados e, com `--set-default`, atualiza perfil + pointer no mesmo replace.
`parameters` e environment refs são mapas replacement, não merge oculto. `profiles inspect` valida
modelo/capabilities, credential/provider, role e ciclos de fallback. Campos arbitrários continuam
rejeitados em vez de aparecerem em `config list`.

As operações de transporte exigem escopo explícito. `config unset` remove somente uma chave
persistida conhecida pelo schema e poda apenas os pais que ficarem vazios. `config import` faz
merge de YAML/JSON bounded após preview e aceita profiles tipados com referências, mas rejeita
campos desconhecidos, `extensions`, material secreto e argumentos externos que carreguem
credenciais. `config edit` usa a mesma validação por uma porta de editor composta pelo aplicativo,
ou recebe um arquivo explícito no modo headless; payloads de extension já instalados são
preservados e não entram no editor genérico. `config export` emite a camada global/workspace ou o
snapshot efetivo em YAML/JSON redigido sem resolver credential refs. Sem `--output`, o documento
vai para stdout; com output, o path precisa permanecer no workspace/diretório selecionado e a
escrita é atômica. Toda mutação afeta somente runs futuros.

O catálogo fonte declara 59 contratos públicos para geração. No ciclo local atual, os 59 JSON
Schemas foram materializados pelo gerador e `schemas:check` confirmou a árvore. Esse resultado vale
para o source verificado e não é evidência de pacote/release. `ralph-config-layer.schema.json` é o contrato destinado ao YAML parcial persistido no
workspace; `effective-ralph-config.schema.json` descreve o resultado completo após a precedência.
S04 acrescenta
credential ref, provider/model info, role profile, token usage, provider event/result e catalog
snapshot; S06 acrescenta assessment/output/rubric/policy e amplia evidence/report; S07 declara
recovery/context pointer, payloads de decisão/aceitação, leases/probes e
profile/observation/snapshot/budget/decision/evaluation do watchdog. Todos derivam dos validators
runtime usados pelo CLI. JSON gerado continua sendo produto do gerador e não deve ser transcrito
manualmente.

## Estrutura do código

```text
apps/
  ralph-cli/       entrypoint `ralph` e composition root do produto
  ralph-launcher/  launcher standalone mínimo ligado ao receipt geracional
packages/
  commands/        parser e handlers públicos
  credentials/     refs, metadata, OAuth e keychains Win/macOS/Linux
  distribution/    manifests, promoção, assinatura, install/update/rollback/uninstall
  domain/          schemas, records e máquinas de estado puras
  evaluation/      bundle/prompt compartilhado, evaluator e contratos de judge
  model-drivers/   backends embutido/CLI externo de executor e judge
  openai-driver/   protocolo Responses: OpenAI API/ChatGPT-Codex e OpenRouter API
  orchestration/   scheduler, contexto, opções, lock e lifecycle de execução
  persistence/     workspace, configuração, SQLite, migrations, runs e outbox
  prd/             parser AST, graph recursivo, formatter, marker e migração v1
  providers/       ports, catálogo, cache, registry lazy e router
  supervisor/      processos subordinados e cancelamento cross-platform
  telemetry/       eventos, outputs e redaction
  verification/    snapshots, evidências, gates e completion policy
  tool-host/       tools, autorização, journal e settlements
  tui/             projeção SolidJS/OpenTUI anexável e componentes visuais
  test-kit/        backend programável injetável somente em testes
scripts/           build, release/package, smoke, checks e compatibilidade black-box
tests/             unitários, integração, goldens e fixtures
schemas/           JSON Schemas públicos gerados dos validators runtime
skill-contract/    contrato de integração para a skill autora de PRD
skills/            pacote distribuível atual da skill `ralph-loop-prd-generator`
examples/          samples de produto/PRD; `vertical-notes` cobre a integração local S12.08
docs/adr/          decisões arquiteturais aceitas
```

Os projetos que o Ralph executará continuam agnósticos de linguagem, framework, banco, cloud ou test runner. TypeScript/Bun é a implementação do próprio CLI, não uma prescrição ao projeto-alvo.

## Especificação e sequência

Antes de implementar, leia [AGENTS.md](AGENTS.md). A ordem normativa é:

1. [docs/00-contexto-e-objetivos.md](docs/00-contexto-e-objetivos.md) até [docs/19-decisoes-riscos-e-nao-objetivos.md](docs/19-decisoes-riscos-e-nao-objetivos.md);
2. [PRD.md](PRD.md), que contém a fila mestre S01–S12;
3. o subplano correspondente em [implementation/](implementation/).

Cada item é uma vertical slice observável. Nenhuma slice deve ser marcada concluída apenas porque módulos compilam; ela exige os testes e smokes definidos em seu subplano.

## Compatibilidade e segurança

- O checkout antigo em `C:\Users\Rodrigo\Desktop\Ralph Loop` é somente referência read-only.
- O harness de compatibilidade executa binários em fixtures temporárias e classifica diferenças; ele não escreve no checkout antigo.
- O baseline [S01](docs/compatibility/s01-report.md) cobre a paridade fundacional com o Ralph clássico; o [addendum S03](docs/compatibility/s03-addendum.md), regenerado no mesmo fechamento, prova separadamente o standalone de produto, a rejeição do fake e o fluxo empacotado da composition root de teste.
- O coordenador S10 (`bun run compat:s10 --legacy-binary <arquivo> --next-binary <arquivo>`) exige dois binários explícitos, agrega S01/S03 sem substituí-los e só publica `s10-report.{json,md}` depois de executar smoke operacional, migração/rollback e suites vinculadas. No Windows, use `scripts/run-bun-hidden.ps1` para manter Bun e filhos sem janela e em prioridade baixa.
- `.ralph` legado ou não identificado nunca é migrado implicitamente por `init`.
- JSON e JSONL reservam stdout ao contrato solicitado; diagnostics operacionais usam stderr.
- Payloads de eventos e toda saída pública passam por redaction antes de persistência/serialização.
- A S04 integra ports, catálogo, credenciais e smokes embutidos por protocolo; nenhum agente ou
  session runner do OpenCode foi incorporado. OpenAI/ChatGPT usa o protocolo fixado da adaptação
  curada; OpenRouter usa seu endpoint Responses compatível fixado, somente por API key. O fake da
  S03 permanece isolado no test kit e na composition root de teste.

As decisões da fundação estão registradas no [índice de ADRs](docs/adr/README.md).

## Referências

- Ralph clássico (v1, referência de compatibilidade): <https://github.com/rodrigojager/ralph>
- OpenCode: <https://github.com/anomalyco/opencode>
- Snapshot curado do OpenCode: `45cd8d76920839e4a7b6b931c4e26b52e1495636` (verificado em 17 de julho de 2026)

Esse snapshot é a autoridade de proveniência das adaptações curadas da S04, não uma dependência
runtime do aplicativo OpenCode. O inventário estruturado e fail-closed está em
[`third_party/opencode/PROVENANCE.json`](third_party/opencode/PROVENANCE.json); os documentos humanos
do mesmo diretório explicam source/destination, patches e licença. Qualquer código upstream futuro
deverá fixar explicitamente origem, commit, hashes e licença antes da cópia.
