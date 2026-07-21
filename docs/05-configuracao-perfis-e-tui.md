# 05 — Configuração, perfis e TUI de settings

## Camadas

- Defaults do produto, versionados no código.
- Configuração global, no diretório de configuração da plataforma.
- Configuração do workspace em `.ralph/config.yaml`.
- Frontmatter e campos de tarefa do PRD.
- Flags da invocação.

Credenciais ficam fora desses arquivos. Config contém apenas referências.

## Schema ilustrativo

O formato humano canônico é YAML com chaves `snake_case`. O parser normaliza para os tipos TypeScript `camelCase` de `docs/17-*`; JSON continua disponível para `config export` e automação, mas não existe uma segunda semântica.

```yaml
schema_version: 1
defaults:
  executor_profile: executor-default
  judge_profile: judge-default
  ui: auto
  lang: pt-BR
profiles:
  executor-default:
    role: executor
    backend: embedded
    provider: openai
    model: codex-model
    credential: chatgpt-personal
    variant: high
    max_steps: 80
    max_tokens: null
    temperature: null
    fallback_profiles: []
  judge-default:
    role: judge
    backend: embedded
    provider: openrouter
    model: judge-model
    credential: openrouter-personal
    max_tokens: null
  executor-cli:
    role: executor
    backend: external-cli
    provider: custom-cli
    model: subscription-model
    external_cli:
      executable: custom-agent
      args: [--provider, "{{provider}}", --model, "{{model}}"]
      cwd: .
      environment_refs:
        OPENAI_API_KEY: env:RALPH_OPENAI_API_KEY
      input_mode: stdin-json
      adapter: protocol
      capabilities:
        streaming: false
        tool_calling: ralph
        cancellation: true
        usage: unavailable
      mutation_mode: read-only
      timeout_ms: 300000
      output_limit_bytes: 1048576
run:
  mode: loop
  resume: true
  max_attempts: 3
  retry_delay_seconds: 2
  no_change:
    policy: fallback
    max_attempts: 3
    stop_on_exhausted: true
  include_progress_context: false
  include_repo_map_context: false
evaluation:
  mode: deterministic-only
  threshold: 85
  max_revision_attempts: 3
  judge_call_retries: 2
  exhausted_policy: manual-review
watchdog:
  enabled: true
  heartbeat_interval: 5s
  heartbeat_grace: 20s
  quiet_after: 45s
  slow_after: 5m
  suspect_after: 10m
  hard_timeout: 45m
  probe_interval: 10s
  confirmations: 3
  action: restart-attempt
  max_restarts: 1
  phases:
    judge:
      slow_after: 8m
      suspect_after: 15m
      hard_timeout: null
parallel:
  max_parallel: 2
  integration_strategy: no-merge
telemetry:
  persist_raw_output: true
  event_retention: null
  redact: true
tui:
  theme: dark
  ascii: false
  keybindings: {}
security:
  mode: safe
  headless_ask: deny
  tool_rules: {}
  allowed_commands: []
  read_paths: ['.']
  write_paths: ['.']
  allow_shell: false
sandbox:
  enabled: false
  provider: process
  image: null
  network: null
git:
  branch_per_task: false
  base_branch: null
  create_pr: false
  draft_pr: false
  auto_rollback: false
  auto_checkpoints: false
```

Valores são exemplos de shape, não defaults imutáveis até serem aprovados em testes de produto.

`telemetry.event_retention` aceita somente uma duração positiva no formato
`<inteiro><ms|s|m|h|d>` (por exemplo, `500ms`, `30m`, `24h` ou `30d`). `null`
não inventa uma idade máxima: eventos permanecem retidos, enquanto capturas raw
opcionais continuam limitadas pelos budgets seguros de quantidade, tamanho por
arquivo/segmento e bytes totais. A política efetiva é salva no snapshot imutável
do run; alterações pelo CLI ou popup valem para runs futuros e não reescrevem
attach/replay de um run existente.

Persistência pública sempre passa pela redaction obrigatória. Raw diagnóstico só
é gravado quando `persist_raw_output` e `redact` são ambos `true`; pedir
`redact: false` não libera conteúdo sem redaction, mas desliga raw opcional de
forma fail-closed. Eventos, settlements, logs e relatórios permanecem redigidos
independentemente dessa preferência. Quando raw está desligado, o runtime não
fabrica refs vazias ou placeholders.

O transporte external CLI v1 é deliberadamente bounded: cada turno devolve um documento JSON,
por isso declara `streaming: false` e `usage: unavailable`. Em S05 ele executa em diretório temporário
isolado e não recebe autorização para mutar o workspace diretamente; efeitos entram pelo protocolo e
pelas tools do Ralph. `known-output` pode selecionar o adapter embutido
`executor-outcome-json-v1`; `generic` transforma texto apenas em alegação e nunca em conclusão.

## Perfis

Um perfil encapsula backend, provider, modelo, credencial, variante, parâmetros e fallbacks. Regras:

- role obrigatória `executor` ou `judge`;
- um perfil de judge não recebe tools de escrita;
- modelo embutido de executor deve suportar tool calling ou um protocolo alternativo explicitamente implementado;
- credential ref precisa pertencer ou ser compatível com o provider;
- fallbacks são ordenados e não mudam silenciosamente o role;
- overrides por PRD não armazenam token.

Perfis `external-cli` exigem o bloco fechado `external_cli`; perfis `embedded`
o proíbem. `cwd`, scopes e referências são portáveis, e `environment_refs`
aceita somente `TARGET=env:SOURCE`. Valores secretos não pertencem a
`executable`, `args`, config ou argv. Na CLI, `profiles configure` expõe
`--cli-executable`, `--cli-arg`, `--cli-cwd`, `--cli-env`, adapter,
capabilities, mutation mode, timeout e limite de output. Os metadados
condicionais são combinados no mesmo formulário usado pela TTY e pela TUI, mas
só ficam visíveis quando `backend=external-cli`, para não forçar campos de
subprocesso em perfis embutidos. O formulário também cobre o protocolo
`stdin-json`, environment refs, todas as capabilities declaradas, requirements
(`input`, tools/streaming, reasoning, structured output, usage, access e mínimos),
fallbacks e limits de tokens/custo. Campos sem flag dedicada continuam exibindo
o path de config e são equivalentes ao fluxo headless tipado de `config edit/import`.
Qualquer folha de profile representada pela metadata também pode abandonar seu override pela CLI
headless com `--inherit-profile-field <metadata-id>`, repetido uma vez por campo.

Trocas de provider/model possuem limpeza explícita: `--clear-credential`, `--clear-variant` e
`--clear-parameters` nunca significam “preservar o valor antigo”. `--set-default` atualiza o perfil
e o pointer do papel em uma única mutação do mesmo arquivo. Para apenas uma run, os pares
`--executor-*`/`--judge-*` têm flags `--clear-...` equivalentes e parâmetros são replacement, não
merge oculto. Em `profiles configure`, uma flag ausente preserva a folha da camada alvo; ela não
materializa no workspace um valor herdado da camada global. `--clear-credential` e
`--clear-variant` gravam tombstones tipados quando necessário, enquanto `--clear-parameters`
grava o mapa vazio como replacement.
Um `--scope global|workspace` explícito fica bloqueado durante o formulário TTY. Para escolher o
escopo dentro do formulário, a invocação deve omitir `--scope`; assim sets, inherits e clears da
linha de comando são projetados uma única vez sobre o destino escolhido, sem desaparecer numa troca
silenciosa de camada. `--backend embedded` com qualquer `--cli-*` também é conflito fail-closed.

## TUI de configuração

O fluxo é inspirado nos popups do OpenCode:

1. Command palette abre `Configure`.
2. Seleção do escopo: global ou workspace.
3. Categoria: executor, judge, providers/auth, run, evidence, watchdog, TUI, parallel, Git, sandbox, segurança, idioma.
4. Formulário mostra valor efetivo e origem.
5. Campos dependentes aparecem conforme seleção.
6. Validação acontece antes de salvar.
7. Preview mostra diff de configuração sem segredos.
8. Confirmação grava atomicamente, retorna um receipt/mutation tipado e a TUI recarrega a projeção.

A origem é calculada por folha depois do defaulting do schema. Coleções vazias efetivas mantêm
proveniência própria, tombstones/replacements removem origens inferiores e campos agregados exibem
`mixed(...)` quando suas folhas realmente vierem de camadas diferentes; não existe um rótulo único
de “global” ou “builtin” aplicado ao profile inteiro.

Não existe, neste contrato, um event bus global de configuração. Salvar durante preparação,
attach ou replay não acrescenta `config.changed` ao histórico de um run existente; em attach/replay
o save afeta apenas runs futuros e o refresh da TUI lê novamente a configuração command-owned.

Na paleta de providers, as abas de catálogo continuam sendo o atalho de rota `embedded`: `d`
seleciona explicitamente “sem credencial”, e aplicar uma nova rota limpa somente variant e
parâmetros model-specific. A aba `profile` não esconde as opções profundas: ela edita backend,
rota/credential/variant/parameters, `external_cli`, fallbacks, requirements e limits. Provider e
model de um perfil `external-cli` são texto explícito e não são filtrados pelo catálogo embedded.

Cada campo do profile possui estado visível `inherit`, `set` ou `clear`. `inherit` remove a folha da
camada alvo e revela o escopo inferior; `set` grava um override; `clear` usa tombstone apenas nos
paths opcionais tipados (`credential`, `variant`, `external_cli`, `adapter_id`, mínimos e limits) ou
uma coleção vazia explícita. `parameters` e `external_cli.environment_refs` são replacement de mapa,
portanto `{}` realmente os esvazia; `null` legítimo dentro de `parameters` nunca é interpretado como
tombstone. Em qualquer toggle com path de profile, ausência é `inherit`, `true` é `set` e o override
explícito `false` aparece como `clear`, inclusive nas capabilities de CLI externo; o `setDefault`
command-owned não participa dessa projeção. `s` troca a projeção global/workspace, `t` troca o papel,
`f` decide explicitamente se o profile também se torna default daquele papel, e `w`/`g` confirmam o
escopo de persistência. Salvar sem `set-default` altera somente o profile. Salvar com ele atualiza o
profile e `defaults.executor_profile` ou `defaults.judge_profile` atomicamente. O popup envia, em
uma resposta one-shot, tanto a camada parcial quanto o profile efetivo completo ao mesmo handler
command-owned `profiles configure`; ele não escreve YAML e não sintetiza argv contendo configurações
profundas. O handler mantém locks e hashes CAS das camadas global/workspace, recompõe o profile sob
esses snapshots e só confirma a escrita se o resultado completo for exatamente o informado e passar
schema, resolução de provider/model/credential, capabilities, fallbacks e limits.

A rota, o método de autenticação e a credencial confirmados são capturados antes da fila, inclusive
para inputs secretos one-shot e revogação. Valores de credencial continuam fora do formulário;
somente IDs e referências `env:NAME` podem atravessar essa fronteira.

Popups específicos:

- conectar provider e escolher método de auth;
- selecionar modelo com busca, capabilities, contexto, custo e status;
- criar/editar perfil executor;
- criar/editar perfil judge;
- configurar threshold e revisões;
- configurar watchdog com explicação de slow versus stalled;
- configurar gates e políticas de skip;
- configurar branch/worktree/PR;
- importar configuração v1.

## Equivalência CLI

Cada campo mostra na ajuda contextual:

- chave de config;
- comando equivalente;
- flag de override, quando existir;
- escopo em que será salvo.

Exemplo:

```text
Judge threshold
Effective: 85 (workspace)
Key: evaluation.threshold
CLI: ralph config set evaluation.threshold 85 --workspace
Run override: --judge-threshold 85
```

O command model compartilhado aceita um draft tipado e diferencia três destinos:

- `Apply for this run` produz somente opções para uma nova invocação, antes de existir run;
- `Save workspace default` resolve exclusivamente `<workspace>/.ralph/config.yaml`;
- `Save global default` resolve exclusivamente o arquivo de configuração da plataforma.

No modo headless, `config preview <campo|chave> <valor> [--scope workspace|global]`
valida o mesmo campo e mostra patch/config/argv equivalentes. A gravação exige confirmação de
escopo na própria linha de comando:

```text
ralph config preview evaluation.threshold 85 --scope workspace
ralph config set evaluation.threshold 85 --scope workspace
ralph config set tui.theme high-contrast --scope global
```

Valores compostos usam JSON. `config set` não aceita caminho de saída, não grava profiles pelo
editor genérico e não transporta segredo; profiles continuam no handler tipado de profiles e
credenciais continuam no credential store. Saves alteram apenas defaults de runs futuros.

## Unset, edição e transporte determinísticos

As mutações nunca inferem escopo. Os contratos públicos são:

```text
ralph config unset evaluation.threshold --scope workspace [--dry-run]
ralph config edit [INPUT.yaml|json] --scope workspace|global [--dry-run]
ralph config import CONFIG.yaml --scope workspace|global [--dry-run]
ralph config export --scope workspace|global|effective
  [--serialization yaml|json] [--output PATH] [--force]
```

- `unset` aceita somente um campo persistido conhecido pela metadata, não profile/extension/secret,
  remove exatamente o leaf e poda apenas mappings pais vazios. Repetir sobre campo ausente é no-op.
- `import` faz merge de um documento UTF-8 regular e não ligado, limitado a 1 MiB. O parser YAML é
  strict, rejeita chaves duplicadas, limita aliases e também aceita JSON. A camada e a configuração
  efetiva resultante são validadas antes de qualquer commit.
- Imports podem conter profiles completos tipados e referências `credential: id` ou `env:NAME`.
  Campos desconhecidos, `extensions`, valores de credencial, sentinelas redigidas, PEM/tokens e
  flags secret-bearing em `external_cli.args` falham fechados. Essa política também é aplicada ao
  subtree `profiles` de toda camada global/workspace lida, portanto edição manual ou config legada
  não cria bypass; `extensions` não é varrido. Credenciais continuam sendo criadas por `auth connect`,
  nunca por import.
- `edit` substitui somente as chaves core gerenciadas e preserva o namespace `extensions` já
  instalado sem mostrá-lo ao editor. Sem input, exige TTY e a porta de editor do aplicativo; no
  standalone, `RALPH_CONFIG_EDITOR` escolhe um executável e `RALPH_CONFIG_EDITOR_ARGS_JSON` um array
  JSON de argumentos. Não existe shell, o ambiente é allowlisted e o arquivo temporário é privado.
  Com input explícito, a mesma operação funciona headless e `--non-interactive` não abre editor.
- `export` não resolve credential refs nem consulta secret store. Ele serializa uma camada ou o
  snapshot efetivo já redigido. Sem output, devolve o documento em stdout; com output, exige destino
  contido, pai existente, commit atômico e `--force` para overwrite.

Import, edit e unset produzem um preview value-free de paths/operações e verificam se o arquivo
alvo mudou antes do replace. Em `edit`, o hash do alvo é capturado antes de abrir o editor ou ler o
arquivo preparado; uma alteração concorrente durante esse intervalo encerra com conflito, em vez de
ser sobrescrita. O resultado temporário do editor é lido por um handle de identidade estável e com
limite de tamanho. Todo commit feito pelos writers compartilhados de settings, profiles e transporte
adquire antes da leitura um lock interprocesso específico do arquivo; outra instância falha com
conflito em vez de perder update. O lock registra PID/token/target, é removido por identidade e não é
reclamado apenas por idade: após crash, o operador precisa confirmar que não existe writer e remover
explicitamente o lock indicado no diagnóstico. `--dry-run` não cria lock, diretório ou arquivo.
Uma mutação global também valida o workspace ativo quando ele pode ser resolvido; outros workspaces
são revalidados quando carregados. Ao configurar um profile, o grafo de profiles efetivo é recomposto
da camada mais recente e validado dentro do mesmo lock, imediatamente antes do commit; duas instâncias
não podem aprovar separadamente fallbacks que só formariam um ciclo depois de serializados. Commits
reais afetam apenas runs futuros; snapshots de runs já persistidos não são reabertos.

## Validação e persistência

- Schema versionado e migrações idempotentes.
- Escrita atômica com arquivo temporário, flush e replace seguro.
- Backup da versão anterior antes de migração.
- Chaves desconhecidas preservadas quando seguro ou rejeitadas com caminho/linha; nunca ignoradas silenciosamente se controlarem comportamento.
- `config doctor`/`doctor` detecta refs inexistentes, profiles cíclicos e modelos incompatíveis.
- `config list --effective` não resolve/exibe valor secreto.

## Credenciais

- Secret store da plataforma quando disponível; fallback em arquivo com permissões restritas e aviso.
- Config salva somente `credential: <ref>`.
- Refresh tokens e access tokens nunca entram em logs/eventos/report.
- OAuth callback valida state/PKCE e limita bind a loopback.
- Revogação e logout são operações explícitas.
- Importação de sessão existente é opt-in, auditada e não copia credencial para workspace.

## TUI indisponível

Se OpenTUI ou TTY falhar:

- operação continua em plain quando possível;
- erro é registrado em log de TUI;
- `--ui tui` explícito pode falhar com mensagem clara se o usuário exigir a interface;
- toda configuração permanece acessível por comandos.
