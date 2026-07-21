# S10 — Compatibility harness operacional e migração

Este relatório é aditivo. Ele não substitui o baseline S01 nem o addendum S03: os dois foram
executados como componentes e seus relatórios completos estão embutidos no JSON S10. A classificação
de produto (compatible/changed/deprecated/removed) permanece separada do assessment executável
(pass/regression); uma decisão `changed` pode e deve receber `regression` quando sua evidência falha.

## Identidade da execução

- Gerado em: 2026-07-21T10:00:10.656Z
- Host: win32/x64
- Target nativo: bun-windows-x64-baseline
- Legacy: `<LEGACY_BINARY_DIR>\ralph.exe` — `ffd6b016713e8754b06ad1c9a2f51d6ba761e7b223bd2083fd1f99c9b0a217ee`
- Next: `<PROJECT_ROOT>\dist\standalone\bun-windows-x64-baseline\ralph.exe` — `6a875d6a69c45b3c431b86f5a6b4be13c8d4f72daa00afd7221791ea89605613`
- Source antes/depois: `1615ef4768c45996fd51d0d6125aecfa7dd12e5474f29248ae2a561123f7608b` / `1615ef4768c45996fd51d0d6125aecfa7dd12e5474f29248ae2a561123f7608b`
- Binários distintos e imutáveis: yes
- Workspace descartável com espaço/Unicode, env allowlist, configs isolados e subprocessos windowsHide: yes
- Retido para diagnóstico: no

## Componentes executados

| Componente | Assessment | Evidência/erro |
| --- | --- | --- |
| s01.baseline | pass | executed report attached |
| s03.addendum | pass | executed report attached |
| s10.operational-smoke | pass | executed report attached |
| s10.migration-coexistence | pass | executed report attached |

## Suites vinculadas realmente executadas

| Suite | Assessment | Arquivos com hash no JSON | Cobertura | Exit |
| --- | --- | --- | --- | ---: |
| linked.execution-options | pass | tests/integration/execution-cli.test.ts<br>tests/unit/skip-completion-policy.test.ts | skips, fast, output, markers, gates, option-precedence | 0 |
| linked.control-flow | pass | tests/integration/s03-control-flow-edge-cases.test.ts | no-change, retry, fail-fast, resume, dry-run | 0 |
| linked.parallel-git-security | pass | tests/integration/s09-bounded-e2e.test.ts | parallel, git, worktrees, conflict, security, sandbox | 0 |
| linked.signal-resume | pass | tests/integration/s07-kill-injection-matrix.test.ts | signal, crash, resume, events, report | 0 |

Os vínculos acima não são citações de source: o coordenador executou cada arquivo via Bun oculto,
capturou exit/stdout/stderr e registrou SHA-256 de cada teste. Assim, skips/fast/no-change/retry/
fail-fast/parallel/Git/security/sandbox/signal só recebem `pass` após execução real.

## Inventário fechado do legado

- Contratos de comando: 32
- Spellings de comando: 66
- Grupos de flags: 33
- Spellings de flags: 78

| Tipo | ID | Ralph v1 | Ralph v2 | Classificação | Assessment | Evidência executável |
| --- | --- | --- | --- | --- | --- | --- |
| command | init | `init`<br>`setup` | init (setup alias) | compatible | pass | s01.baseline<br>s10.operational-smoke<br>s10.migration-coexistence |
| command | run | `run`<br>`loop` | run / loop | compatible | pass | s03.addendum<br>linked.control-flow |
| command | once | `once` | once <description> / once --task <id> | changed | pass | s03.addendum<br>linked.execution-options |
| command | parallel | `parallel` | parallel | changed | pass | linked.parallel-git-security |
| command | install | `install` | install | changed | pass | s10.operational-smoke |
| command | config-list | `config`<br>`config list` | config list | compatible | pass | s10.operational-smoke<br>s10.migration-coexistence |
| command | config-get | `config get` | config get | compatible | pass | s10.operational-smoke |
| command | config-set | `config set` | config set --scope workspace\|global | changed | pass | s10.operational-smoke |
| command | tasks-list | `tasks`<br>`tasks list` | tasks list | compatible | pass | s10.operational-smoke |
| command | tasks-next | `tasks next` | tasks next | changed | pass | s10.operational-smoke |
| command | tasks-done | `tasks done` | tasks done --evidence ... / --force --reason ... | changed | pass | s10.operational-smoke<br>linked.execution-options |
| command | tasks-sync | `tasks sync` | tasks sync --repo ... | changed | pass | s10.operational-smoke<br>linked.parallel-git-security |
| command | logs-tail | `logs`<br>`logs tail` | logs tail | compatible | pass | s03.addendum<br>s10.operational-smoke |
| command | doctor | `doctor` | doctor | compatible | pass | s01.baseline<br>s10.operational-smoke |
| command | clean | `clean` | clean --dry-run / clean --force | changed | pass | s10.operational-smoke |
| command | rules | `rules` | rules list\|add\|clear | changed | pass | s10.operational-smoke |
| command | lang | `lang`<br>`lang current`<br>`lang list`<br>`lang set`<br>`lang update` | lang current\|list\|set\|update | changed | pass | s10.operational-smoke |
| command | ui | `ui`<br>`ui current`<br>`ui set`<br>`ui toggle` | attach / replay / --ui auto\|tui\|plain\|none | changed | pass | binary.identity-help<br>s10.operational-smoke |
| command | about | `about` | about | compatible | pass | s10.operational-smoke |
| command | update | `update` | update / update --check | changed | pass | s10.operational-smoke |
| command | report-last | `report`<br>`report last` | report last / report show | compatible | pass | s03.addendum<br>linked.signal-resume |
| command | status | `status` | status / status run | compatible | pass | s01.baseline<br>s03.addendum<br>s10.migration-coexistence |
| command | events | `events`<br>`events tail` | events | compatible | pass | s03.addendum<br>linked.signal-resume |
| command | checkpoint-create | `checkpoint create`<br>`checkpoints create` | checkpoint create | changed | pass | s10.operational-smoke<br>linked.signal-resume |
| command | checkpoint-list-show | `checkpoint`<br>`checkpoints`<br>`checkpoint list`<br>`checkpoints list`<br>`checkpoint show`<br>`checkpoints show` | checkpoint(s) list\|show | compatible | pass | s10.operational-smoke |
| command | checkpoint-restore | `checkpoint restore`<br>`checkpoints restore` | rollback preview / rollback apply | changed | pass | s10.operational-smoke<br>linked.signal-resume |
| command | context-show | `context`<br>`context show` | context inspect | changed | pass | s10.operational-smoke |
| command | context-refresh | `context refresh` | context rotate | changed | pass | s10.operational-smoke |
| command | adapters | `adapter`<br>`adapters`<br>`adapter list`<br>`adapters list`<br>`adapter new`<br>`adapters new` | adapters list\|new\|inspect | changed | pass | s10.operational-smoke<br>s10.migration-coexistence |
| command | recipes | `recipe`<br>`recipes`<br>`recipe list`<br>`recipes list`<br>`recipe new`<br>`recipes new` | recipes list\|new\|show | changed | pass | s10.operational-smoke<br>s10.migration-coexistence |
| command | version | `--version`<br>`-V` | version / --version / -V | compatible | pass | binary.identity-help<br>s01.baseline<br>s10.operational-smoke |
| command | help | `--help`<br>`-h` | help / --help / -h | compatible | pass | binary.identity-help<br>s01.baseline<br>s10.operational-smoke |
| flag | help-version | `--help`<br>`-h`<br>`--version`<br>`-V` | help/version commands and aliases | compatible | pass | binary.identity-help<br>s01.baseline<br>s10.operational-smoke |
| flag | ui | `--ui` | --ui auto\|tui\|plain\|none | changed | pass | binary.identity-help<br>s10.operational-smoke |
| flag | tests | `--skip-tests`<br>`--run-tests` | --skip-tests plus typed gate policy | changed | pass | s03.addendum<br>linked.execution-options |
| flag | fast | `--fast` | --fast | compatible | pass | linked.execution-options |
| flag | worker-run | `--worker-run` | internal supervisor/worker protocol | removed | pass | binary.identity-help<br>linked.parallel-git-security |
| flag | fail-fast | `--fail-fast` | --fail-fast | compatible | pass | linked.control-flow |
| flag | mode | `--mode`<br>`--loop`<br>`-l`<br>`-loop`<br>`--wiggum`<br>`-w`<br>`-wiggum` | run\|loop and --mode loop\|wiggum / --wiggum | changed | pass | s03.addendum<br>linked.execution-options<br>linked.control-flow |
| flag | lint | `--no-lint`<br>`--skip-lint` | --skip-lint | changed | pass | linked.execution-options |
| flag | no-commit | `--no-commit` | --no-commit | compatible | pass | s03.addendum<br>linked.parallel-git-security |
| flag | json | `--json` | --format json / --json | compatible | pass | s01.baseline<br>s03.addendum<br>s10.operational-smoke |
| flag | gates | `--gate`<br>`--run-gate`<br>`--test-command`<br>`--lint-command` | typed PRD/profile gates and --skip-gates | changed | pass | s03.addendum<br>linked.execution-options |
| flag | security | `--security`<br>`--dangerous` | --security safe\|auto\|dangerous plus explicit permissions | changed | pass | linked.parallel-git-security |
| flag | sandbox | `--sandbox`<br>`--no-sandbox`<br>`--sandbox-provider`<br>`--sandbox-image`<br>`--sandbox-network` | --sandbox, provider/image and capability diagnostics | changed | pass | s10.operational-smoke<br>linked.parallel-git-security |
| flag | dry-run | `--dry-run` | --dry-run | compatible | pass | s10.operational-smoke<br>linked.execution-options<br>linked.control-flow |
| flag | retry-failed | `--retry-failed` | --retry-failed / --max-failure-retries | changed | pass | linked.control-flow<br>linked.parallel-git-security |
| flag | parallel-integration | `--parallel-integration` | --integration and explicit Git policy | changed | pass | linked.parallel-git-security |
| flag | auto-rollback | `--auto-rollback` | rollback preview/apply and checkpoint policy | changed | pass | s10.migration-coexistence<br>linked.parallel-git-security |
| flag | debug-engine-json | `--debug-engine-json` | --debug and raw-engine event/log view | changed | pass | s03.addendum<br>linked.execution-options |
| flag | context-stops | `--ignore-context-stops`<br>`--ignore-gutter`<br>`--respect-context-stops`<br>`--respect-gutter` | typed context/watchdog policy | changed | pass | linked.signal-resume |
| flag | no-change | `--no-change-policy`<br>`--no-change-max-retries`<br>`--no-change-stop-on-max-retries`<br>`--no-change-continue-on-max-retries` | --no-change-policy and --no-change-max-retries | changed | pass | linked.control-flow |
| flag | verbose | `--verbose`<br>`-v` | --debug plus logs/events views | changed | pass | s10.operational-smoke<br>s03.addendum |
| flag | git | `--branch-per-task`<br>`--base-branch`<br>`--create-pr`<br>`--draft-pr` | --git-worktrees, --base-branch, integration policy and review handoff | changed | pass | linked.parallel-git-security |
| flag | force | `--force` | --force with command-specific reason/confirmation contracts | changed | pass | s10.operational-smoke<br>linked.execution-options |
| flag | interaction | `--yes`<br>`-y`<br>`--non-interactive` | --non-interactive and explicit confirmation plan hashes | changed | pass | s01.baseline<br>s10.operational-smoke<br>s10.migration-coexistence |
| flag | doctor-processes | `--processes` | doctor capability probes | changed | pass | s10.operational-smoke |
| flag | model-shortcuts | `--sonnet`<br>`--opus`<br>`--haiku` | --executor-profile / --executor-provider / --executor-model | deprecated | pass | binary.identity-help<br>s03.addendum |
| flag | engine-model | `--engine`<br>`--model` | --executor-profile/provider/model and independent judge settings | changed | pass | s03.addendum<br>linked.execution-options |
| flag | prd | `--prd` | --prd | compatible | pass | s03.addendum<br>linked.execution-options |
| flag | github-sync | `--repo`<br>`--label`<br>`--state`<br>`--output` | tasks sync --repo/--label/--state/--output | changed | pass | s10.operational-smoke<br>linked.parallel-git-security |
| flag | retries | `-r`<br>`--retries`<br>`--max-retries`<br>`--retry-delay` | --max-failure-retries and --retry-delay | changed | pass | linked.control-flow |
| flag | budgets | `--max-iterations`<br>`--max-parallel`<br>`--max-tokens`<br>`--temperature` | typed run/profile budgets and --max-parallel | changed | pass | s03.addendum<br>linked.execution-options<br>linked.parallel-git-security |
| flag | tail-filters | `--follow`<br>`--level`<br>`--since` | events/logs tail follow and filters | compatible | pass | s03.addendum<br>s10.operational-smoke<br>linked.signal-resume |
| flag | passthrough | `--` | repeatable typed --cli-arg on an external profile | removed | pass | binary.identity-help<br>linked.execution-options |

Cada spelling de flag também foi sondado no binário legado explícito antes de `--help`; flag
desconhecida, valor ausente ou timeout vira regression. O passthrough `--` usa um dry-run isolado
porque, por definição, ele impede que um `--help` posterior seja interpretado pelo parser.

## Checks agregados

| Check | Assessment | Evidência |
| --- | --- | --- |
| binary.explicit-regular-distinct | pass | Both mandatory CLI options resolved to distinct regular non-linked files. |
| binary.version-help | pass | Both explicit binaries returned successful non-empty version and human help captures. |
| legacy.flag-recognized.--help | pass | --help was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.-h | pass | -h was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--version | pass | --version was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.-V | pass | -V was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--ui | pass | --ui was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--skip-tests | pass | --skip-tests was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--run-tests | pass | --run-tests was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--fast | pass | --fast was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--worker-run | pass | --worker-run was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--fail-fast | pass | --fail-fast was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--mode | pass | --mode was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--loop | pass | --loop was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.-l | pass | -l was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.-loop | pass | -loop was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--wiggum | pass | --wiggum was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.-w | pass | -w was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.-wiggum | pass | -wiggum was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--no-lint | pass | --no-lint was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--skip-lint | pass | --skip-lint was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--no-commit | pass | --no-commit was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--json | pass | --json was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--gate | pass | --gate was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--run-gate | pass | --run-gate was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--test-command | pass | --test-command was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--lint-command | pass | --lint-command was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--security | pass | --security was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--dangerous | pass | --dangerous was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--sandbox | pass | --sandbox was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--no-sandbox | pass | --no-sandbox was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--sandbox-provider | pass | --sandbox-provider was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--sandbox-image | pass | --sandbox-image was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--sandbox-network | pass | --sandbox-network was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--dry-run | pass | --dry-run was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--retry-failed | pass | --retry-failed was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--parallel-integration | pass | --parallel-integration was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--auto-rollback | pass | --auto-rollback was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--debug-engine-json | pass | --debug-engine-json was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--ignore-context-stops | pass | --ignore-context-stops was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--ignore-gutter | pass | --ignore-gutter was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--respect-context-stops | pass | --respect-context-stops was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--respect-gutter | pass | --respect-gutter was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--no-change-policy | pass | --no-change-policy was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--no-change-max-retries | pass | --no-change-max-retries was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--no-change-stop-on-max-retries | pass | --no-change-stop-on-max-retries was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--no-change-continue-on-max-retries | pass | --no-change-continue-on-max-retries was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--verbose | pass | --verbose was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.-v | pass | -v was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--branch-per-task | pass | --branch-per-task was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--base-branch | pass | --base-branch was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--create-pr | pass | --create-pr was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--draft-pr | pass | --draft-pr was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--force | pass | --force was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--yes | pass | --yes was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.-y | pass | -y was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--non-interactive | pass | --non-interactive was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--processes | pass | --processes was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--sonnet | pass | --sonnet was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--opus | pass | --opus was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--haiku | pass | --haiku was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--engine | pass | --engine was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--model | pass | --model was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--prd | pass | --prd was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--repo | pass | --repo was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--label | pass | --label was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--state | pass | --state was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--output | pass | --output was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.-r | pass | -r was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--retries | pass | --retries was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--max-retries | pass | --max-retries was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--retry-delay | pass | --retry-delay was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--max-iterations | pass | --max-iterations was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--max-parallel | pass | --max-parallel was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--max-tokens | pass | --max-tokens was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--temperature | pass | --temperature was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--follow | pass | --follow was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--level | pass | --level was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.--since | pass | --since was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| legacy.flag-recognized.-- | pass | -- was accepted by the explicit legacy binary without mutation; help/version short-circuited dispatch. |
| component.s01-baseline | pass | The additive coordinator executed the S01 baseline without replacing it. |
| component.s03-addendum | pass | The S03 addendum used the same explicit validated next binary. |
| component.s10-operational-smoke | pass | Operational human/JSON, files, marker and alias checks passed. |
| component.s10-migration-coexistence | pass | Coexistence and inspect/apply/rollback checks passed. |
| component.linked.execution-options | pass | 2 hashed test files executed with exit 0 (timeout=false). |
| component.linked.control-flow | pass | 1 hashed test files executed with exit 0 (timeout=false). |
| component.linked.parallel-git-security | pass | 1 hashed test files executed with exit 0 (timeout=false). |
| component.linked.signal-resume | pass | 1 hashed test files executed with exit 0 (timeout=false). |
| binary.legacy-immutable | pass | The legacy binary hash is unchanged after every probe and migration operation. |
| binary.next-immutable | pass | The next binary hash is unchanged after every probe and migration operation. |
| source.immutable | pass | No component or linked executable test changed the current source fingerprint. |

## Resultado

- Checks: 91/91
- Regressions de checks: 0
- Superfícies com regression: 0
- Classificações: compatible=22, changed=40, deprecated=1, removed=2

O JSON irmão contém comandos/argv, exit, timeout, stdout/stderr normalizados e seus hashes, snapshots
de arquivos, hashes de marker/origem/binários, eventos/report do S03, resultados de sinal dos testes
vinculados e o ciclo completo inspect/apply/rollback. S10.09/S10.10 só podem ser fechadas após este
relatório ser gerado por standalones frescos e revisado sem regressions.
