# 04 — CLI, comandos, flags e precedência

## Princípio de interface

Todo recurso deve ser utilizável por linha de comando. A TUI adiciona descoberta, seleção e edição, mas chama os mesmos handlers e schemas.

## Comandos de workspace

```text
ralph init [--force] [--non-interactive]
ralph setup                         alias de init
ralph clean [--force]
ralph doctor [--non-interactive] [--workspace PATH] [--format human|json]
```

`init` cria workspace e config sem sobrescrever PRD existente. `clean` remove somente o diretório
`.ralph` resolvido e exige `--force`. `doctor` verifica runtime, Git, filesystem, workspace, TTY,
metadados locais de profiles/credential refs e, somente quando sandbox está habilitado, a capability
local do backend explicitamente configurado. O check reutiliza a discovery do runtime, declara o
nível real de isolamento e nunca promove `process` a fronteira de container. Chamadas remotas de
smoke e fluxos OAuth continuam nos comandos especializados; quando há profiles, a validação pode
consultar o catálogo e o status das credential refs pelos adapters explicitamente compostos. O
`doctor` nunca sonda backends de container não selecionados nem os escolhe como fallback implícito.

## Comandos de execução

```text
ralph run|loop [options]
ralph once "texto-ad-hoc" [options]
ralph once [--task document-id/task-id] [--prd PATH] [options]
ralph parallel [options]
ralph resume [run-id] [--accept-workspace-changes] [options]
ralph attach [run-id] [--format human|json|jsonl]
ralph replay [run-id] [--format human|json|jsonl]
ralph stop [run-id] [--graceful] [--grace SEC] [--force]
ralph cancel [run-id] [--grace SEC] [--force]  alias compatível de stop
ralph verify --run-id ID --task DOCUMENT/TASK [gate-options]
ralph verify --attempt-id ID [gate-options]
ralph verify --evidence-bundle-id ID [gate-options]
ralph judge --run-id ID --task DOCUMENT/TASK [judge-options]
ralph judge --attempt-id ID [judge-options]
ralph judge --evidence-bundle-id ID [judge-options]
ralph judge --verification-id VERIFY_OPERATION_ID [judge-options]
```

Em `once`, qualquer argumento posicional é uma descrição ad hoc. Uma tarefa PRD só é selecionada
por `--task`; `texto + --task` e `texto + --prd` falham como fontes conflitantes. A descrição e seu
hash ficam no snapshot imutável do run, portanto `resume [run-id]` retoma a mesma unidade sem exigir
que o texto seja repetido. O runtime constrói apenas um contrato virtual em memória: não escreve PRD
ou sub-PRD e a conclusão record-only grava `markerUpdated=false` junto da evidência/report. PRDs já
detectáveis são protected paths; criação ou mutação de conteúdo PRD também falha em gate bloqueante.

`ralph resume <run-id> --accept-workspace-changes` é uma autorização de uso único. Ela só é
válida quando existe uma decisão de recovery pendente para aquele run. O orchestrator vincula a
autorização ao event ID anterior, à task, ao attempt, ao manifesto imutável e aos hashes
`expectedWorkspaceHash`, `observedWorkspaceHash` e `taskBaselineHash`; se qualquer um divergir, a
retomada falha fechada e grava uma nova decisão em vez de transferir a autorização. Sem a flag,
`resume` continua bloqueado. `ralph status run [--run-id ID]` é o caminho read-only para ver a task,
o ref do manifesto e os hashes pendentes.

Essa flag significa apenas **continuar preservando o estado observado**. Ela nunca cria checkpoint
e nunca executa rollback. Checkpoint e rollback precisam de comandos separados e explícitos; não
há fallback automático para reset, checkout, clean ou qualquer mutação destrutiva.

### Seleção e fronteira de `verify`/`judge`

Os dois comandos resolvem uma única evidência persistida e falham fechados. `--attempt-id` e
`--evidence-bundle-id` selecionam identidades imutáveis; `--verification-id` é exclusivo de `judge`
e seleciona a evidência emitida por uma operação `verify` concluída. Seleção por task requer
`--run-id`, e um ID curto que coincida com mais de um documento dentro do run continua sendo erro.
Não há scan truncado de “runs recentes” nem escolha implícita do último resultado.

Um argumento posicional precisa declarar sua natureza: `attempt:<id>`, `evidence:<id>`,
`verification:<id>` ou `task:<document/task>`. `DOCUMENT/TASK` também é reconhecido como referência
de task, ainda exigindo `--run-id`. Qualquer outro posicional sem prefixo é ambíguo e rejeitado.
Flags adicionais podem ser fornecidas somente se concordarem com a identidade resolvida.

`verify` aceita `--skip-tests`, `--skip-lint`, `--skip-gates`, `--no-gates`, `--fast`, `--force` e
`--fail-fast`. Ele roda gates/commands e coleta uma evidência nova, mas nunca chama executor/modelo,
ToolHost ou marker writer. Não pode usar como fonte outra operação `verify`.

`judge` usa `external` por semântica do próprio comando, mesmo quando o default global de runs é
`deterministic-only`. `--self-review` ou `--evaluation self` muda para self; `--judge` e
`--evaluation external` apenas tornam o default explícito. `--no-judge`, `--evaluation
deterministic-only` e `--evaluation manual` são rejeitados porque não produziriam um julgamento.
Perfil, provider, model, credential ref, variant e parameters do judge podem ser sobrescritos ou
limpos explicitamente em external; os equivalentes do executor, em self. Overrides — inclusive
flags `--clear-*` — do papel inativo são rejeitados, nunca ignorados.
Threshold, retries de
chamada, severidades e rubrica também são resolvidos pela precedência normal. O comando não inicia
revision attempts, não altera código e não marca a task.

Ambos produzem `human` ou um report JSON integral. Streaming é lido pelo comando `events`/`logs
tail`; `--format jsonl` não é aceito como formato final desses comandos. Status `passed` ou
`overridden` retorna 0, falha de verificação/julgamento retorna 4, bloqueio retorna 5 e erros de
seleção/configuração/provider usam o exit code operacional correspondente.

## Comandos de PRD e tarefas

```text
ralph prd validate [PATH] [--recursive] [--json]
ralph prd inspect [PATH] [--recursive] [--json]
ralph prd format [PATH] [--check]
ralph prd migrate [PATH] [--output PATH] [--in-place]

ralph tasks list [--all|--pending|--completed|--review]
ralph tasks next
ralph tasks done <id|index|next>
ralph tasks sync --repo owner/repo [--label NAME] [--state open|closed|all] [--output PATH] [--force]
ralph review retry --run-id ID --task ID --additional-revisions N --reason TEXT
```

`prd inspect --recursive` é a visualização canônica do grafo; não existe um handler paralelo
`prd graph`. `tasks list --review` lista tarefas aguardando revisão e `review retry` concede um
budget auditado de novas revisões. Atualização manual de status continua disponível, mas registra
evento de override e nunca falsifica uma avaliação automática anterior.

## Providers, credenciais, modelos e perfis

```text
ralph providers list [--refresh] [--json]
ralph providers inspect <provider> [--refresh] [--json]
ralph models list [--provider provider] [--require-tools] [--require-structured-output] [--json]
ralph models inspect <provider/model> [--variant ID] [--refresh]

ralph auth connect [provider] [--method METHOD]
ralph auth list [--provider provider]
ralph auth status [credential-ref] [--refresh]
ralph auth revoke <credential-ref> [--force]

ralph profiles list
ralph profiles inspect <name>
ralph profiles configure <name> --role executor|judge --backend embedded|external-cli [options]
  [--credential REF|--clear-credential] [--variant ID|--clear-variant]
  [--parameter NAME=VALUE|--clear-parameters]
  [--inherit-profile-field METADATA_ID]... [--set-default]
```

`connect` é alias de `auth connect`. Credenciais possuem comandos próprios porque catálogo de
provider/model é metadata e não deve implicitamente abrir, revogar ou selecionar autenticação.
Criação e alteração de profile convergem no mesmo `profiles configure`; a implementação não expõe
aliases fictícios `show|new|set|delete`.
As opções `--clear-*` removem estado incompatível em vez de preservar silenciosamente valores do
provider/model anterior. `--set-default` grava a camada parcial do perfil, valida o perfil efetivo completo e atualiza `defaults.<role>_profile` sob o
mesmo lock e no mesmo replace atômico.
`--inherit-profile-field` é repetível e recebe o ID exato de um campo da metadata do formulário
(`provider`, `model`, `credential`, `parameters`, `requireTools`, `cliAdapter` etc.). Ele remove
somente a folha correspondente da camada alvo e revela o valor do escopo inferior. `scope`, `role`,
`setDefault` e qualquer ID fora de `profiles.<id>` são rejeitados. Definir ou limpar a mesma folha na
mesma invocação é conflito independentemente da ordem das flags; se o escopo inferior não fornecer
um perfil completo válido, a composição falha sem gravar. Dependências também falham explicitamente
em vez de descartar argv: herdar `backend` não pode acompanhar flags `--cli-*` quando o backend
inferior não é externo, e herdar `cliAdapter` não pode acompanhar `--cli-adapter-id` quando o adapter
inferior não é `known-output`.
Da mesma forma, `--backend embedded` é incompatível com qualquer `--cli-*`: o parser e o handler
rejeitam a invocação, em vez de aceitar argv de subprocesso e descartá-lo ao limpar `external_cli`.

Em uma run, `--executor-parameter`/`--judge-parameter` substituem o mapa do papel; os equivalentes
`--clear-executor-*` e `--clear-judge-*` limpam credential, variant ou parameters no snapshot
imutável. Uma flag de valor e sua flag de limpeza são mutuamente exclusivas.

## Configuração e interface

```text
ralph config list [--effective]
ralph config get <field|key>
ralph config explain <field|key>
ralph config preview <field|key> <value> [--scope workspace|global]
ralph config set <field|key> <value> --scope workspace|global
ralph config unset <field|key> --scope workspace|global [--dry-run]
ralph config reset <field|key> --scope workspace|global [--dry-run]  alias de unset
ralph config edit [INPUT.yaml|json] --scope workspace|global [--dry-run]
ralph config import <INPUT.yaml|json> --scope workspace|global [--dry-run]
ralph config export --scope workspace|global|effective [--serialization yaml|json]
  [--output PATH] [--force]
ralph config validate
ralph attach [run-id] [--format human|json|jsonl]
ralph replay [run-id] [--format human|json|jsonl]
```

`config list` e `config explain` usam a mesma metadata dos popups. `config preview` valida o
valor e devolve o patch de config e argv de run sem escrever. `config set` exige escopo explícito,
resolve o arquivo canônico desse escopo e faz replace atômico após revalidar a camada completa.
Campos exclusivos de invocação podem ser visualizados/aplicados a um draft pré-run, mas são
rejeitados por `config set`. Nenhum desses comandos altera `EffectiveRunOptions` de um run já
persistido.

`config unset` exige um campo conhecido pela metadata compartilhada, recusa segredo, profile,
extension e campos apenas de invocação, remove exatamente o path no escopo escolhido e poda somente
mappings pais que ficarem vazios. Ausência do valor é idempotente. `--dry-run` devolve o mesmo diff
de paths sem gravar; o alias legado `config reset` chega ao mesmo handler.

`config import` lê um arquivo regular, não ligado, UTF-8 e limitado a 1 MiB, aceita YAML ou JSON e
faz merge após validação da camada e da configuração efetiva resultante. Profiles tipados podem ser
transportados com credential IDs e `env:NAME`; chaves desconhecidas, `extensions`, material secreto,
valores redigidos e argumentos de CLI externos que carreguem credenciais são recusados. A mesma
política é reaplicada ao subtree tipado `profiles` sempre que YAML global/workspace é lido, inclusive
se foi editado manualmente; o conteúdo arbitrário de `extensions` não é inspecionado. O resultado
expõe apenas path/operação por mudança, nunca valores. `--dry-run` é o preview determinístico.

`config edit` sem arquivo requer terminal interativo e uma porta segura composta pelo aplicativo.
O executável standalone só compõe essa porta quando `RALPH_CONFIG_EDITOR` aponta para um executável
confiável; `RALPH_CONFIG_EDITOR_ARGS_JSON` fornece argv explícito, sem shell. O editor recebe em um
temporário privado apenas a camada core redigida, com ambiente mínimo; a resposta passa pelo mesmo
parser/schema e por commit atômico com detecção de conflito. `config edit INPUT --non-interactive`
é o equivalente headless. Extensions existentes são preservadas, mas não entram nem saem desse
editor genérico. Sem porta/editor disponível, a falha é explícita.

`config export` é read-only e exige `workspace`, `global` ou `effective`. Ele não resolve secrets:
credential IDs continuam referências e qualquer material identificável é redigido. YAML é o
default; JSON é selecionado por `--serialization json`. Omitir `--output` escreve apenas o documento
em stdout. Com `--output`, o destino deve permanecer sob o workspace/diretório selecionado, o pai
deve existir, a escrita é atômica e overwrite requer `--force`.

`profiles configure` abre popup quando faltam campos e existe TTY, usando formulário textual
sequencial em fallback. Em `--non-interactive`, falha em vez de abrir interface. Configuração geral
também pode ser editada pela paleta pré-run da TUI, mas não existe um segundo handler `configure`.
Quando `--scope` foi informado, esse destino é autoridade do comando e o formulário não pode
trocá-lo; omitir a flag habilita o seletor global/workspace, mantendo todas as demais flags na camada
do escopo finalmente escolhido. Uma resposta de adapter que contradiga um `--scope` explícito falha
antes de qualquer escrita.
`attach` observa um run vivo e `replay` abre uma projeção congelada; ambos exigem terminal interativo
e reutilizam a mesma TUI. `ui` é somente alias compatível de `attach`. Em ambiente headless, os
equivalentes read-only são `status run`, `events`, `logs tail` e `report show`; `--ui` configura a
apresentação de comandos de execução, não `attach`/`replay`.

## Operação e compatibilidade

```text
ralph status [--all] [--json]
ralph status run [--run-id ID] [--json]
ralph events [--run-id ID] [--follow] [--format jsonl]
ralph logs tail [--run-id ID] [--follow] [--level LEVEL] [--source SOURCE] [--since TIME]
ralph report last [--json]
ralph report show <run-id> [--json]
ralph tasks sync --repo OWNER/REPO [--state open|closed|all] [--label LABEL] [--output PRD.md] [--force]
ralph checkpoint list [--run-id ID] [--limit N]
ralph checkpoint show <checkpoint-id>
ralph checkpoints list|show ...
ralph context inspect [--run-id ID] [--limit N]
ralph context export [--run-id ID] --output PATH [--force]
ralph context rotate [--run-id ID] [--reason TEXT]
ralph checkpoint create [options]
ralph rollback preview [options]
ralph rollback apply [options]
ralph adapters list|new|inspect
ralph recipes list|new|show
ralph rules list|add|clear
ralph install <DIR> --manifest <PATH|HTTPS> [--channel nightly|beta|stable] [--dry-run]
ralph update --install-root <DIR> [--manifest <PATH|HTTPS>] [--check|--dry-run]
ralph rollback --install-root <DIR> [--to-version VERSION] [--dry-run]
ralph uninstall <DIR> [--dry-run]
ralph lang current|list|set|update
ralph about
ralph --version|-V
ralph --help|-h

ralph migrate inspect <legacy-workspace> [--format human|json]
ralph migrate apply <legacy-workspace> --destination PATH [--import-adapters] [--import-recipes]
ralph migrate rollback <rollback-manifest.json> --dry-run
ralph migrate rollback <rollback-manifest.json> --confirm-plan-hash SHA256
```

`migrate inspect` é estritamente read-only. `migrate apply` exige um destino separado sem `.ralph`,
gera `PRD.migrated.md`, report e rollback manifest e nunca converte um run v1 ativo em run v2.
Adapters/recipes opt-in entram em quarentena inativa; scripts não são executados.

`migrate rollback` exige exatamente um dos dois modos. `--dry-run` valida schema, localização,
containment, links, duplicatas e todos os hashes sem escrever, e devolve o hash determinístico do
plano. A aplicação exige esse hash exato via `--confirm-plan-hash`, revalida tudo sob lease e remove
somente os arquivos listados ainda idênticos, o próprio manifest confirmado e diretórios que tenham
ficado vazios. A origem v1 nunca é lida nem alterada; traversal, symlink/junction, hardlink, arquivo
ausente/modificado ou hash divergente fecham o fluxo sem autorizar uma remoção ampla.

`tasks sync` lê somente a API de issues do host GitHub fixo, usa `GITHUB_TOKEN`/`GH_TOKEN` sem
persistir ou imprimir o valor, exclui pull requests e gera PRD v2 `change-only` sem transformar body
remoto em comandos ou critérios artificiais. A escrita é interna ao workspace, atômica e exige
`--force` para substituir arquivo já existente.

`checkpoint list/show` são somente leitura; `checkpoint create`, `rollback preview` e
`rollback apply` são mutações/planos explícitos, vinculados ao estado observado e governados pela
autoridade Git/runtime da S09. O alias plural `checkpoints` usa os mesmos handlers.
`context inspect/export` não imprime shared context, critérios, notes nem resource bodies:
exporta apenas metadata/hashes/integridade. `context rotate` só funciona quando o supervisor ativo
compõe a porta de controle; nunca edita manifests persistidos diretamente.

`adapters new` cria JSON data-only `disabled`; `recipes new` cria Markdown `draft`. Inspect/show não
carrega ou executa código. Rules ficam legíveis em `.ralph/rules.md`; `rules clear` exige `--force`.
`lang set` exige `--scope workspace|global` e afeta somente runs futuros. `install`, `update`,
rollback de instalação e `uninstall` possuem handlers S12 compostos; toda instalação exige manifest
verificado e root isolado. `update --check` executa o mesmo staging/preflight verificado sem ativar o
candidato. A presença dos handlers não promove o checkout: artifact, trust/signature, licença,
matriz de plataforma e evidence de release continuam gates separados.

## Flags de execução reconhecidas

- seleção/modo: `--prd PATH`, `--task DOCUMENT/TASK`, `--mode once|loop|wiggum|parallel` em `run`,
  `--wiggum`, `--max-tasks N`, `--max-iterations N` e `--max-model-calls N`;
- limites/fluxo: `--force`, `--fail-fast`, `--retry-delay DURATION`, `--dry-run`, `--fast`,
  `--no-commit`, `--skip-tests`, `--skip-lint`, `--skip-gates ID` e `--no-gates`;
- no-change: `--no-change-policy require-change|allow-no-change|fail-on-no-change|retry-on-no-change`
  e `--no-change-max-retries N`; `fallback|retry|fail-fast` permanecem aliases documentados e são
  normalizados, não nomes de provider fallback;
- paralelismo/Git: `--max-parallel N`, `--max-global-parallel N`, `--parallel-auto`,
  `--parallel-group ID`, `--retry-failed`, `--max-failure-retries N`, `--git-worktrees`,
  `--base-branch REF`, `--integration-branch REF` e
  `--integration none|merge|rebase-merge|cherry-pick|create-pr`;
- segurança: `--security safe|auto|dangerous`, `--sandbox`,
  `--sandbox-provider process|docker|podman`, `--sandbox-image IMAGE`, `--headless-ask deny|allow`,
  `--allow-tool`, `--deny-tool`, `--ask-tool`, `--allow-command`, `--read-path`, `--write-path` e
  `--allow-shell`;
- apresentação: `--ui auto|tui|plain|none`, `--format human|json|jsonl`, `--non-interactive`,
  `--no-color` e `--debug`.

## Perfis, judge e retomada

- executor: `--executor-profile`, `--executor-provider`, `--executor-model`,
  `--executor-credential` e `--executor-variant`;
- judge: `--judge-profile`, `--judge-provider`, `--judge-model`, `--judge-credential`,
  `--judge-variant`, `--evaluation deterministic-only|self|external|manual`, `--judge [external]`,
  `--no-judge`, `--self-review`, `--judge-threshold`, `--judge-max-revisions`, `--max-revisions`,
  `--judge-call-retries`, `--judge-unavailable`, `--judge-blocking-severity`, `--judge-rubric` e
  `--judge-exhausted` onde o comando permitir;
- retomada: `--resume auto|never|required` (`--resume` isolado significa `auto`), `--no-resume`,
  `--new-run`, `--run-id` e `--accept-workspace-changes` somente em `resume`.

O parser deliberadamente rejeita passthrough livre depois de `--`. Um backend CLI externo recebe
argumentos repetíveis e tipados pelo profile com `profiles configure --cli-arg VALUE` (e
`--cli-env`, `--cli-cwd`, `--cli-adapter` etc.). Flags legadas não presentes no catálogo do parser
não são anunciadas como aliases; a fonte de descoberta machine-readable é `help --format json`.

## Precedência

Da maior para a menor:

1. flag explícita da invocação;
2. override da tarefa no PRD;
3. frontmatter do PRD/sub-PRD;
4. perfil nomeado selecionado;
5. variável de ambiente explicitamente suportada pelo schema;
6. configuração do workspace;
7. configuração global;
8. default versionado do produto.

Na S01, antes de existirem tarefa, PRD compilado e profiles completos, a cadeia observável é `CLI > env > workspace > global > builtin`. O Ralph não importa arbitrariamente toda variável com prefixo: cada mapping de ambiente é documentado e validado.

O comando `config list --effective` deve mostrar valor final, origem e se contém segredo por referência.

## Exit codes

| Código | Significado |
| --- | --- |
| `0` | comando e objetivo solicitado concluídos |
| `1` | erro operacional não classificado |
| `2` | uso, flag ou configuração inválida |
| `3` | PRD, schema ou graph inválido |
| `4` | task falhou gate/verification ou foi rejeitada pelo threshold |
| `5` | task/run bloqueado ou aguardando ação necessária/manual review |
| `6` | autenticação, provider ou modelo indisponível sem fallback |
| `7` | conflito de lease, workspace ou Git |
| `8` | cancelado/interrompido e retomável |
| `9` | limite, budget, timeout ou watchdog esgotado |
| `10` | operação negada por segurança, sandbox ou permissão |

Esta tabela e `docs/17-contratos-e-schemas.md` são o mesmo contrato normativo. Os códigos devem ser congelados antes da primeira release estável e testados black-box.
