# S10 — Matriz operacional Ralph v1 → Ralph v2

Esta matriz classifica a superfície pública do Ralph v1. `Classificação` descreve a decisão de
produto; `estado estático` descreve o que existe no source atual. A validação local geral já passou
por schemas, lint/typecheck, unitários, packages/CLI e build/smoke nativo Windows x64. O harness
integral foi executado depois de build fresco contra `ralph 0.2.0` real e fechou 91/91 checks, sem
regressions ou surface regressions. `Implementado estaticamente` continua não equivalendo, por si só,
a compatibilidade validada; os assessments executados estão no report versionado.

O inventário fechado e executável agora é `scripts/s10-compatibility-contract.ts`. Ele enumera, sem
wildcards, os spellings reais de comandos/subcomandos/aliases e flags do parser Go auditado. O
relatório `s10-report.json` projeta cada item com dois campos independentes:

- `classification`: `compatible|changed|deprecated|removed`;
- `assessment`: `pass|regression`, derivado somente de evidência realmente executada.

Este Markdown continua legível como decisão de produto; a prova black-box é o report irmão, não a
mera presença do harness. O teste source-only impede spellings ausentes/duplicados e a execução real
sondou cada flag no binário legado explícito.

## Comandos

| Ralph v1 | Ralph v2 | Classificação | Estado estático e diferença intencional |
| --- | --- | --- | --- |
| `init` / `setup` | `init` / alias `setup` | compatible | Implementado; a identidade v2 impede sobrescrever `.ralph` legado. |
| `clean` | `clean --dry-run`, depois `clean --force` | changed | Implementado estaticamente; remove apenas `.ralph` identificado como v2, recusa runs não terminais e nunca remove PRD/código/Git. |
| `run` / `loop` | `run` / `loop` | compatible | Implementado pelas slices anteriores com snapshot de opções e autoridade do CLI. |
| `once` | `once "texto"` ou `once --task ID` | changed | Texto posicional agora é inequivocamente ad hoc; seleção PRD exige `--task`. A fonte ad hoc é persistida/retomável, produz evidence/report record-only; o CLI não materializa PRD/sub-PRD nem altera marker, e um gate bloqueia violações do backend. A composição está coberta pelo addendum e suites vinculadas do report S10. |
| `parallel` | `parallel` | changed | Implementado pela S09 com scheduler próprio, capacity/claims/worktrees e integração Git; não há fallback serial. A suite vinculada executou worktrees, integração, conflito e sandbox process com exit 0. |
| `status` | `status`, `status run` | changed | Implementado com materialização de runs e progresso persistido. |
| `events` | `events [--follow] [--format jsonl]` | compatible | Implementado com cursor durável e filtros. |
| `logs tail` | `logs tail [--follow]` | compatible | Implementado com views audit/human/raw-engine/tool/gate/diagnostic. |
| `report last` | `report last`, `report show` | compatible | Implementado. |
| `tasks list` | `tasks list` | compatible | Implementado estaticamente sobre o grafo PRD compilado; aceita filtros exclusivos. |
| `tasks next` | `tasks next` | changed | Implementado estaticamente; retorna a primeira task realmente elegível por dependências, não apenas a primeira linha pendente. |
| `tasks done` | `tasks done <doc/id\|id\|index\|next>` | changed | Implementado estaticamente; exige `--evidence` ou `--force --reason`, usa hash/reparse do marker e grava dois eventos de override sem reescrever avaliação automática anterior. |
| `tasks sync` | `tasks sync --repo OWNER/REPO ...` | changed | Implementado estaticamente como projeção bounded GitHub issues → PRD v2; token vem apenas de env, PRs/bodies não viram tasks/comandos e overwrite exige `--force` com precondition hash. |
| `config list` | `config list` | compatible | Implementado com origem efetiva e metadata compartilhada. |
| `config get` | `config get <key>` | compatible | Implementado estaticamente como leitura efetiva/headless. |
| `config set` | `config set <key> <value> --scope ...` | changed | Implementado; escopo é obrigatório e só afeta runs futuros. |
| — | `config explain`, `preview`, `validate` | changed | Implementados; `validate` carrega e valida as camadas global/workspace/efetiva. |
| `config reset/unset/edit/import/export` | `config unset` (alias `reset`), `edit`, `import`, `export` | changed | Implementados estaticamente com escopo explícito. Unset é schema-known e idempotente; edit usa porta segura ou input headless e preserva extensions fora do editor; import faz merge bounded de config/profiles tipados sem secrets/extensions; export emite global/workspace/effective redigido em YAML/JSON, stdout ou arquivo contido/atômico. Todas as mutações afetam somente runs futuros. |
| `adapters list/new/inspect` | mesmos verbos, drafts inativos | changed | Implementados estaticamente; `new` cria manifest data-only `disabled`, list inclui imports v1 em quarentena e inspect nunca ativa/carrega código. Perfis continuam sendo o contrato executável. |
| `recipes list/new/show` | mesmos verbos, documentos draft | changed | Implementados estaticamente; authoring é Markdown legível e não executável, e import v1 continua opt-in/quarentenado. |
| `rules list/add/clear` | mesmos verbos sobre `.ralph/rules.md` | changed | Implementados estaticamente com texto bounded, escrita atômica e `clear --force`; inclusão no contexto permanece decisão explícita do runtime. |
| `checkpoint(s)` | `checkpoint(s) list/show/create` + `rollback preview/apply` | changed | Leitura, criação imutável e rollback hash-bound implementados; apply exige hash exato e cria checkpoint de segurança, sem auto-rollback. |
| `context` | `context inspect/export/rotate` | changed | Inspect/export metadata-only implementados; não expõem corpos do contexto. Rotate é uma porta explícita do supervisor e retorna blocked quando ela não foi composta. |
| `ui current/set/toggle` | `attach`, `replay`, `--ui tui` e settings TUI | changed | A experiência visual foi redesenhada; alias top-level `ui` aponta para `attach`. |
| `install`, `update`, `lang` | mesmos nomes, mais `rollback`/`uninstall` standalone | changed | `lang current/list/set/update` está implementado para catálogos bundled e escopo explícito. A S12 compõe install/update/check/rollback/uninstall com staging, receipts e ativação atômica; o smoke do standalone não valida esses ciclos, e `stable` falha fechado sem licença, signer/verifier/trust policy e promotion evidence. |
| `about`, `--version`, `--help` | mesmos comandos/flags | compatible | Implementados. |
| — | `migrate inspect` | changed | Implementado estaticamente, estritamente read-only. |
| — | `migrate apply` | changed | Implementado estaticamente para destino separado, com backup, validação de config/PRD, report e rollback manifest. |
| — | `migrate rollback` | changed | Implementado com preview/hash explícito, schema e location binding estritos, rejeição de traversal/links/duplicatas/hash divergente e remoção somente de arquivos criados ainda idênticos mais diretórios vazios. O ciclo real inspect/apply/rollback passou no harness local; repetição multiplataforma e install rollback de release permanecem externos. |

## Aliases e depreciações

O catálogo em `packages/commands/src/command-registry.ts` é a fonte compartilhada por parser, help,
completion e command palette. O union canônico e a resolução longest-prefix derivam dos mesmos
spellings; aliases de topo são projeções dessa metadata e o dispatch é exaustivo. Help human/JSON,
`commandCompletionData` e `commandPaletteData` expõem aliases e classificação, sem manter listas
paralelas. Shells e renderers podem consumir essas projections format-neutral; instalar scripts de
completion ou desenhar um popup específico não muda o catálogo. Allowed options e regras posicionais
permanecem explícitas porque são gramática por comando, não descoberta de comandos.

- `setup` → `init` (`compatible`).
- `cancel` → `stop` (`compatible`).
- `ui` → `attach` (`changed`): não altera ownership do supervisor.
- `connect` → `auth connect` (`changed`): credenciais ficam no credential service.
- `checkpoints` → `checkpoint` (`changed`): singular/plural chegam ao mesmo catálogo; list/show são read-only, create e rollback mantêm verbos/autoridade explícitos.
- `context show` → `context inspect` e `context refresh` → `context rotate` (`changed`): inspect é
  metadata-only e rotate exige a porta real do supervisor.
- `spectre`, `gum` e `spectre+gum` não são engines/UI independentes em v2; a migração deve
  classificá-los e recomendar `tui` ou `plain`, nunca fingir equivalência visual.

## Flags legadas

| Grupo v1 | Decisão v2 |
| --- | --- |
| `--prd`, engine/model, loop/wiggum | Preservados ou mapeados a perfil/override explícito. |
| retries/delay/iterations/no-change/fail-fast | Preservados dentro de budgets e políticas tipadas. |
| tests/lint/gates/fast | Preservados como pedidos de skip/execução sujeitos à policy; não são garantia de bypass. |
| security/sandbox | Preservados com escopos e autorização mais estritos. |
| branch/PR/rollback/parallel | Implementados por S09/S10 atrás de policies/ports explícitos; worktrees/merge/conflito/checkpoint e migração rollback foram executados localmente. Forge remoto/create-PR e release rollback continuam externos. |
| passthrough após `--` | Mudança deliberada: indisponível no parser determinístico atual; argumentos externos devem ser configurados como `--cli-arg` em perfil tipado. |
| UI legada | Mudança deliberada para `auto|tui|plain|none`; aliases visuais antigos são apenas entradas de migração/depreciação. |

## Contrato headless

- `human`, `json` e `jsonl` usam o mesmo handler; JSON/JSONL não recebem prosa em stdout.
- Comandos mutáveis não abrem TUI em `--non-interactive`.
- `migrate inspect` nunca escreve; `migrate apply` é autorizado pelo próprio verbo e por
  `--destination`, sem prompt escondido. `migrate rollback` exige exatamente `--dry-run` ou
  `--confirm-plan-hash`; a origem v1 nunca é aberta por esse comando.
- Paths com espaços são valores únicos de argv; o handoff emitido pelo migrador inclui quoting.
- Divergências ainda não implementadas continuam explícitas nesta matriz, não são aliases falsos.

## Estado de evidência

Esta matriz continua sendo uma classificação de produto; o relatório black-box aceito é
`s10-report.{json,md}`. Em `2026-07-19T23:05:54.068Z`, o coordenador executou S01, S03, smoke S10,
migração/coexistência e quatro suites vinculadas com dois binários reais, explícitos, distintos e
imutáveis. O resultado foi 91/91 checks, zero regressions e zero surface regressions. A classificação
final contém 22 superfícies `compatible`, 40 `changed`, uma `deprecated` e duas `removed`.

Bindings da execução:

- source: `2835b2f3350755ab3045ad4f2c11b13497a2dfb8bfcefcdc49430800bc07b1f8`;
- `ralph 0.2.0`: `ffd6b016713e8754b06ad1c9a2f51d6ba761e7b223bd2083fd1f99c9b0a217ee`;
- `ralph 0.1.0-dev.1`: `ffcb9d0a51f2e3b9c03cf0696d2cdbf9ee5bcff4285eba36ba702be2b454c4c1`.

S10.09 e S10.10 estão fechadas no escopo Windows x64/local declarado. O script PowerShell focado
permanece uma alternativa operacional; provider/auth real, create-PR remoto, install de release e
outras plataformas continuam fora desta evidência.
