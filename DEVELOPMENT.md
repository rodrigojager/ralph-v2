# Desenvolvimento do Ralph v2

Este guia descreve a fundação, o compilador e a orquestração autoritativa do source atual. Os modos
once, loop e Wiggum usam o mesmo completion core; S04 acrescenta catálogo/auth/perfis, S05 liga
backends embutidos e CLI externo ao ToolHost, S06 acrescenta evidence bundle v2, gates honestos,
deterministic/self/external evaluation e revisões limitadas, S07 acrescenta supervisor, retomada e
watchdog, S08 liga telemetria e TUI operacional, S09 acrescenta children/paralelismo/Git/sandbox e
S10 consolida a superfície operacional e a migração lado a lado. S12 possui fundações de release
fail-closed e um lifecycle local de distribuição validado por contrato.

Essa enumeração descreve implementação em desenvolvimento, agora acompanhada por validação local
parcial. Com Bun `1.3.14`, os 59 schemas foram gerados e conferidos, lint/typecheck passaram, o gate
global fechou 673/673, a integração 149/149, watchdog 8/8, smoke PTY em três repetições e ConPTY
S08.12 5/5 (34 verificações). Build/smoke Windows x64 também passaram. `EV-S12-DIST-8` passou 8/8
com 91 asserções sobre fixtures `nightly`/`*-dev.1` unsigned; o sample S12.08 focado passou 1/1 com
59 asserções separadas. O runner de fechamento estrutural S11.12 está implementado, mas seu archive
ainda não foi executado; R015/R063 permanecem parciais e release/matriz externa continuam pendentes.
O estado correto é `development, unpublished`: prova local não substitui smokes reais opt-in,
candidate binding, assinatura, packaging ou promoção descritos em
`docs/27-auditoria-estatica-e-validacao-diferida-s11-s12.md`.

O `/goal` do Codex é usado para implementar o projeto, não para executar o produto. `ralph-next` continua sendo um CLI independente que governa modelos por comandos próprios e consome PRDs.

## Requisitos

| Ferramenta | Versão/uso |
| --- | --- |
| Bun | `1.3.14`, fixado em `packageManager` e no CI |
| Git | necessário para o check correspondente de `doctor` e para o fluxo de desenvolvimento |
| Sistema | Windows, Linux ou macOS; o standalone deve ser testado na mesma plataforma em que será declarado funcional |

Confirme o ambiente:

```text
bun --version
git --version
```

## Bootstrap reproduzível

Na raiz do projeto:

```text
bun install --frozen-lockfile
bun run lint
bun run schemas:check
bun run typecheck
bun test
bun run test:s12:distribution
bun run test:s12:sample
bun run docs:check
```

No host atual, a matriz S12.02 precisa de `TEMP`, `TMP` e `TMPDIR` fora de `C:` porque existe
`C:\.git`; o bloqueio `RALPH_INSTALL_ROOT_IS_CHECKOUT` para roots temporários sob esse drive é
intencional e não deve ser contornado no produto. Essa matriz é `local-contract-only`, não um drill
do artifact de release.

`--frozen-lockfile` faz o bootstrap falhar se `package.json` e `bun.lock` divergirem. Uma atualização deliberada de dependência deve alterar os dois arquivos na mesma mudança.

Para aplicar a formatação/lint autofix localmente:

```text
bun run format
```

Esse comando modifica arquivos. O CI usa somente `bun run lint`.

## Executar do source

O script de workspace aceita os argumentos depois de `--`:

```text
bun run ralph-next -- version
bun run ralph-next -- help
bun run ralph-next -- about --format json
bun run ralph-next -- status --workspace <diretorio>
bun run ralph-next -- status run --workspace <diretorio>
bun run ralph-next -- init --workspace <diretorio> --format json
bun run ralph-next -- once --workspace <diretorio> --prd PRD.md --dry-run --format json
bun run ralph-next -- providers list --format json
bun run ralph-next -- models list --provider openai --format json
bun run ralph-next -- auth list --format json
bun run ralph-next -- profiles list --format json
```

Para consumo automatizado de JSON durante o desenvolvimento, prefira o entrypoint direto com Bun silencioso ou o standalone, evitando que mensagens do próprio package runner sejam confundidas com output do CLI:

```text
bun --silent apps/ralph-cli/src/main.ts version --format json
bun --silent apps/ralph-cli/src/main.ts status --workspace <diretorio> --format json
```

Em PowerShell, um smoke manual isolado pode ser feito assim:

```powershell
$ralphFixture = Join-Path ([System.IO.Path]::GetTempPath()) ("ralph-v2-manual-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $ralphFixture | Out-Null
bun --silent apps/ralph-cli/src/main.ts init --workspace $ralphFixture --format json
bun --silent apps/ralph-cli/src/main.ts status --workspace $ralphFixture --format json
```

Remova a fixture apenas depois de confirmar que `$ralphFixture` aponta para o diretório temporário criado por esse fluxo.

## Comandos públicos da fundação S01-S04

Esta tabela conserva a visão de desenvolvimento das primeiras slices. O catálogo público atual
também inclui as superfícies posteriores de verify/judge, resume/stop, attach/replay, parallel,
tasks, config transfer, adapters/recipes/rules/context/checkpoints/rollback, install/update/uninstall
e migração. A lista canônica completa fica em `README.md`; metadata, parser, help e command palette
derivam do registry compartilhado em `packages/commands/src/command-registry.ts`.

| Comando | Resultado esperado |
| --- | --- |
| `help` | catálogo de comandos, opções e exit codes |
| `version` | versão do package/CLI |
| `about` | identidade do produto e regra de autoridade |
| `init` / `setup` | cria ou valida um workspace v2 identificado |
| `status` | mostra estado local sem inicializar ou chamar provider |
| `once [TASK]` | executa no máximo uma tarefa selecionada ou elegível |
| `run` / `loop` | executa tarefas elegíveis em ordem, com limites e stop conditions explícitos |
| `run --wiggum` | usa contexto integral verificado e iterações/model calls limitadas |
| `status run [--run-id ID]` | projeta run persistida, tasks, attempts, report e progresso |
| `events [--run-id ID] [--follow]` | consulta/segue eventos persistidos por cursor e filtros |
| `logs tail [--run-id ID] [--source SOURCE] [--follow]` | projeta/segue views redigidas audit, human, engine, tool, gate ou diagnostic |
| `report last` | mostra o report da run mais recente |
| `report show <RUN_ID>` | mostra o report de uma run específica |
| `doctor` | verifica runtime, Git, filesystem, TTY e workspace |
| `config explain <key>` | mostra valor efetivo e origem de uma chave |
| `config list --effective` | mostra a configuração base efetiva e suas origens |
| `prd validate [arquivo]` | valida PRD v2 ou classic; `--recursive --strict` fecha o graph v2 |
| `prd inspect [arquivo]` | expõe documento/graph tipado em human ou JSON |
| `prd format [arquivo]` | canoniza somente v2, em stdout, output separado ou `--in-place` explícito |
| `prd migrate [arquivo]` | converte classic para v2 e grava relatório de perdas/inferências |
| `providers list` | lista providers e o snapshot/origem do catálogo usado |
| `providers inspect <provider>` | mostra status, access e métodos de autenticação anunciados |
| `models list` | lista e filtra modelos por provider/tools/structured output |
| `models inspect <provider/model>` | mostra capabilities, limites, variantes, access e preço com origem |
| `auth connect <provider>` | conecta API key, env ref ou conta suportada sem segredo em argv/config |
| `auth list` | lista somente referências e metadata não secreta |
| `auth status [credential]` | verifica disponibilidade/expiração e pode renovar com `--refresh` |
| `auth revoke <credential>` | remove secret e metadata locais; remote revoke depende do protocolo |
| `profiles list` | lista perfis independentes e permite filtrar o role |
| `profiles inspect <profile>` | resolve config, credential metadata e capabilities do model |
| `profiles configure <profile>` | grava perfil global/workspace por flags ou formulário TTY mínimo |
| `model smoke` | chama o driver OpenAI read-only, sem tools, e preserva raw ref redigida |

Opções comuns implementadas nesta fase:

```text
--format human|json|jsonl
--json
--workspace PATH
--no-color
--debug
--non-interactive
```

`init` também aceita `--force`. Esse flag repara somente arquivos ausentes de uma identidade v2 válida; não migra nem sobrescreve `.ralph` legado/desconhecido.

Opções de execução da S03:

```text
--prd PATH
--executor-profile NAME
--task ID
--run-id ID
--dry-run
--force
--retry-delay SEC
--max-model-calls N
--no-change-policy require-change|allow-no-change|fail-on-no-change|retry-on-no-change
--no-change-max-retries N
--skip-tests
--skip-lint
--skip-gates ID
--fast
--no-commit
```

`run` também aceita `--wiggum`, `--max-iterations`, `--max-tasks` e `--fail-fast`; `loop` aceita `--max-tasks` e `--fail-fast`. As quantidades positivas e o delay não negativo são validados antes da execução. `--skip-gates` pode ser repetido. Aliases legados de no-change (`retry`, `fail-fast` e `fallback`) são normalizados com notice e origem nas opções efetivas, nunca silenciosamente.

Skips não significam pass. Por default, as flags só pulam verificações `allowed-to-skip`; pular uma verificação `required` exige também `--force`, gera auditoria e limita a decisão a `completed_with_override`. `--fast` expande apenas skips permitidos. `--no-commit` registra que commits opcionais estão desabilitados; commits ainda não são criados pela S03.

`config explain` e `config list` aceitam os overrides S01 `--mode`, `--ui` e `--lang`. As variáveis de ambiente suportadas são explícitas:

| Variável | Função |
| --- | --- |
| `RALPH_MODE` | override de `defaults.mode` |
| `RALPH_UI` | override de `defaults.ui` |
| `RALPH_LANG` | override de `defaults.lang` |
| `RALPH_CONFIG_HOME` | substitui o diretório de config global; útil para fixtures/CI |
| `NO_COLOR` | desabilita cor quando respeitado pela apresentação |

Nenhuma outra variável com prefixo `RALPH_` é importada automaticamente.

Opções de catálogo/auth/perfil/smoke introduzidas na S04:

```text
--provider ID
--model ID
--profile ID
--credential REF
--method api-key|environment|oauth-browser|device-code|subscription-session
--label TEXT
--environment NAME
--secret-stdin
--headless
--refresh
--timeout SEC
--role executor|judge
--backend embedded|external-cli
--variant ID
--scope global|workspace
--inherit-profile-field METADATA_ID # repetível; remove override da camada alvo
--fallback-profile ID             # repetível
--fallback-on CLASS               # repetível
--require-tools
--require-structured-output
```

`profiles configure` persiste um overlay parcial no escopo escolhido. Flag ausente preserva a folha
da própria camada; `--inherit-profile-field` remove a folha; flags `--clear-*` gravam tombstone
tipado ou coleção replacement vazia. TUI, TTY e modo headless usam a mesma metadata e os mesmos
handlers; nenhum desses caminhos grava o valor de uma credencial.

O parser também reconhece `--allow-insecure-store`, mas a composition S04 recusa plaintext; o comando falha em vez de degradar segurança. API key interativa usa prompt mascarado. Em modo `--non-interactive`, ela exige `--secret-stdin`; não existe flag para passar o valor em argv.

## Desenvolvimento do compilador de PRD

Os exemplos oficiais e o contrato da skill são validados pelo mesmo parser runtime:

```text
bun run ralph-next -- prd validate examples/PRD-v2-exemplo.md --recursive --strict
bun run ralph-next -- prd inspect examples/PRD-v2-exemplo.md --recursive --format json
bun test tests/unit/prd-parser.test.ts tests/unit/prd-graph.test.ts
bun test tests/unit/prd-marker-format-classic.test.ts tests/integration/prd-cli.test.ts
```

`prd format` não migra classic implicitamente. `prd migrate` usa output separado por default; `--in-place` cria backup `.v1.bak`. Entrada, output e relatório precisam ser distintos, paths canônicos permanecem dentro do workspace e `--force` não converte um `--output` ambíguo em autorização de sobrescrever a entrada.

O contrato em [skill-contract/ralph-loop-prd-generator](skill-contract/ralph-loop-prd-generator/README.md)
é consumido pela skill distribuível em
[skills/ralph-loop-prd-generator](skills/ralph-loop-prd-generator/SKILL.md). O runtime apenas valida e
executa planos já completos: não existe caminho para pedir ao executor que crie PRD ou Sub-PRD
durante um run.

## Desenvolvimento do orquestrador S03

A fronteira autoritativa é `ExecutionBackend`: ela recebe task e contexto já selecionados e devolve um `ExecutorOutcome`, que continua sendo apenas uma alegação. Scheduler, lifecycle, baseline, evidence, gates, marker e ledger permanecem sob controle do CLI. Once, loop e Wiggum usam o mesmo completion core.

O entrypoint normal em `apps/ralph-cli` não registra backend fake nem interpreta variável de ambiente secreta para habilitá-lo. A S05 compõe `ExecutionBackend` OpenAI embutido ou `external-cli` a partir de perfis válidos e mantém toda tool sob autorização do Ralph. Uma execução sem perfil/backend disponível falha com exit code `6` antes de criar run ou ativar marker. Em particular, `--executor-profile fake` não é uma opção de produto.

O backend programável fica em `packages/test-kit`. A composition root `tests/support/fixture-cli.ts` o injeta explicitamente sob o nome `fixture-executor`; `tests/integration/packaged-vertical-slice.test.ts` compila esse entrypoint em um executável temporário externo ao checkout e prova uma slice completa com arquivo de produto, command gate, marker, status, eventos e report. Esse artefato de fixture nunca entra em `bun run build` nem no pacote normal.

Comandos de verificação focada:

```text
bun test tests/unit/execution-state.test.ts tests/unit/scheduler.test.ts
bun test tests/unit/context-manifest.test.ts tests/unit/effective-options.test.ts
bun test tests/unit/verification.test.ts
bun test tests/unit/skip-completion-policy.test.ts tests/unit/scripted-backend.test.ts
bun test tests/integration/execution-store.test.ts
bun test tests/integration/orchestration-runner.test.ts
bun test tests/integration/execution-cli.test.ts
bun test tests/integration/packaged-vertical-slice.test.ts
```

O E2E empacotado é parte da prova exigida para a S03, não autoriza conclusão isoladamente. O smoke normal continua verificando o artefato de produto sem embutir o fake.

Limites históricos da S03, antes das slices posteriores:

- somente root PRD v2, recursivo e strict, é executável; classic precisa de `prd migrate`;
- na S03, child graphs eram apenas validados e uma child edge bloqueava execução; a S09 substitui
  esse limite por child runs supervisionadas e retomáveis, sem geração tardia de PRD;
- retomada cobre interrupção controlada, reexecução simples e reconciliação `prepared -> marker-written -> committed`;
- locks não são roubados por heurística;
- leases renováveis, watchdog multi-sinal, kill tree e recuperação geral de hard crash foram
  integrados na S07; o grupo focado de watchdog passou com 8 testes, incluindo processos reais e
  hard timeout confirmado, mas a matriz ampliada de crash, kill e retomada ainda permanece aberta;
- catálogo/providers/auth/modelos e smoke OpenAI entram na S04; executor/tools, na S05; judge e
  revisões, na S06; watchdog e TUI operacional, em S07/S08; children e paralelismo, na S09. O source
  atual compõe essas superfícies e possui a evidência local resumida acima, sem ainda possuir a prova
  externa/multiplataforma necessária para release.

## Desenvolvimento de providers, auth e modelos S04

### Composition e fronteiras

`apps/ralph-cli/src/s04-services.ts` compõe serviços de forma lazy: construir a composition não acessa rede, disco ou keychain. Somente o comando correspondente resolve catálogo, credential ou driver. `packages/providers` não importa PRD, orchestration, Git, completion ou persistence público; `packages/openai-driver` não inicia subprocesso nem depende do aplicativo OpenCode.

Responsabilidades principais:

```text
apps/ralph-cli/src/s04-services.ts  composition, broker de auth e smoke normalizado
apps/ralph-cli/src/profile-form.ts  formulário TTY mínimo com metadata compartilhada
packages/providers/                ports, catálogo, Models.dev, cache e router
packages/credentials/              refs, metadata, OAuth, redaction e keychains
packages/openai-driver/             protocolo ChatGPT/Codex e OpenAI Responses
packages/commands/                  parser, handlers e metadata CLI/form
```

Na S04, Anthropic e OpenRouter eram catalog-only/auth/profile e conservavam provider status
`unknown`; o único driver de smoke daquela slice era OpenAI, por API key ou credencial de assinatura
ChatGPT. O source posterior acrescenta transporte embutido OpenRouter e preserva Anthropic como
catalog-only enquanto não houver driver composto. A presença em Models.dev, isoladamente, nunca é
evidência de execução, e nenhum smoke real foi executado nesta revisão.

### Comandos manuais seguros

Catálogo não exige workspace inicializado:

```text
bun --silent apps/ralph-cli/src/main.ts providers list --format json
bun --silent apps/ralph-cli/src/main.ts providers inspect openai --format json
bun --silent apps/ralph-cli/src/main.ts models list --provider openai --require-tools --format json
bun --silent apps/ralph-cli/src/main.ts models inspect gpt-5.4-mini --provider openai --format json
```

Credential por referência de ambiente, sem copiar o valor:

```text
bun --silent apps/ralph-cli/src/main.ts auth connect openai \
  --method environment --credential openai-env \
  --environment OPENAI_API_KEY --non-interactive --format json
bun --silent apps/ralph-cli/src/main.ts auth status openai-env --format json
```

Para API key por stdin, produza o segredo por um secret manager; não escreva o valor literal em argv ou no histórico:

```text
<secret-provider-command> | bun --silent apps/ralph-cli/src/main.ts auth connect openai \
  --method api-key --credential openai-main \
  --secret-stdin --non-interactive --format json
```

Conta ChatGPT no navegador ou headless:

```text
bun --silent apps/ralph-cli/src/main.ts auth connect openai \
  --method oauth-browser --credential chatgpt-main
bun --silent apps/ralph-cli/src/main.ts auth connect openai \
  --method device-code --credential chatgpt-headless --headless --timeout 600
```

O primeiro fluxo usa state/PKCE e callback loopback; o segundo imprime URL/código acionáveis em stderr. Nenhum deles chama `codex`. Não execute esses comandos em teste automatizado comum: use mocks; conexões reais são operações explícitas do usuário.

Configurar dois roles com refs independentes:

```text
bun --silent apps/ralph-cli/src/main.ts profiles configure executor-main \
  --scope global --role executor --backend embedded \
  --provider openai --model gpt-5.4-mini --credential openai-env \
  --require-tools --non-interactive --format json

bun --silent apps/ralph-cli/src/main.ts profiles configure judge-main \
  --scope global --role judge --backend embedded \
  --provider openai --model gpt-5.4 --credential chatgpt-main \
  --require-structured-output --non-interactive --format json
```

Smoke direto, sem tools:

```text
bun --silent apps/ralph-cli/src/main.ts model smoke \
  --provider openai --model gpt-5.4-mini \
  --credential openai-env --timeout 30 --format json
```

Esse último comando realiza rede/consumo reais quando a credential aponta para uma conta real. Não o inclua em gates normais.

### Storage e artefatos

O data root é o diretório que contém o config global: `%APPDATA%/ralph-next` no Windows quando `APPDATA` existe, ou `$XDG_CONFIG_HOME/ralph-next`/`~/.config/ralph-next` nas demais plataformas. `RALPH_CONFIG_HOME` substitui o diretório em fixtures/CI.

```text
config.yaml                         perfis globais, somente credential refs
credentials/metadata.json          metadata/locator sem segredo
cache/model-catalog.json           snapshot validado e content-addressed
raw/model-smoke/sha256/<hash>.json raw record redigido
```

Perfis de workspace ficam em `.ralph/config.yaml`. O segredo fica fora de ambos os configs: Windows Password Vault, macOS Keychain, Linux Secret Service via `secret-tool`, ou variável de ambiente referenciada. Raw output é redigido antes da escrita e retornado por `raw://sha256/<hash>`.

### Testes focados

```text
bun test packages/providers/tests
bun test packages/credentials/tests
bun test packages/commands/tests/catalog-handlers.test.ts
bun test packages/commands/tests/profile-runtime.test.ts
bun test packages/commands/tests/s04-dispatcher.test.ts
bun test tests/unit/openai-driver-boundaries.test.ts
bun test tests/unit/openai-driver-device-auth.test.ts
bun test tests/unit/openai-driver-protocol.test.ts
bun test tests/unit/openai-driver-smoke.test.ts
bun test tests/unit/openai-driver-stream.test.ts
bun test tests/integration/openai-driver-subscription-smoke.test.ts
bun test tests/unit/s04-services.test.ts
bun test tests/unit/s04-dependency-license.test.ts
bun test tests/unit/opencode-provenance.test.ts
bun test tests/integration/s04-real-chatgpt-subscription-smoke.test.ts
```

Os testes normais são determinísticos e usam fakes/goldens. O smoke OpenAI real é opt-in e skipped por default:

```text
RALPH_S04_REAL_PROVIDER_SMOKE=1
OPENAI_API_KEY=<injetada com segurança no ambiente>
bun test tests/integration/s04-real-openai-smoke.test.ts
```

`RALPH_S04_REAL_OPENAI_MODEL` troca o model do harness; o default é `gpt-5.4-mini`. A presença do teste não é evidência de execução real. Registre separadamente quando ele tiver sido rodado e nunca persista a key no checkout ou output.

Há também um harness independente para uma conta ChatGPT Plus/Pro real. Ele é
skipped salvo quando o opt-in específico tem valor exato `1`; não lê nem aceita
access token, refresh token ou session token por argv, variável de ambiente ou
configuração:

```powershell
$env:RALPH_S04_REAL_CHATGPT_SMOKE = '1'
$env:RALPH_S04_REAL_CHATGPT_MODEL = 'gpt-5.4-mini' # opcional
try {
  bun test tests/integration/s04-real-chatgpt-subscription-smoke.test.ts
} finally {
  Remove-Item Env:RALPH_S04_REAL_CHATGPT_SMOKE -ErrorAction SilentlyContinue
  Remove-Item Env:RALPH_S04_REAL_CHATGPT_MODEL -ErrorAction SilentlyContinue
}
```

O harness usa o catálogo curado, inicia o device-code embutido em modo headless
e mostra somente URL, código de usuário e instruções de autorização. Há até 15
minutos para a autorização manual. Depois, grava a credencial de ID aleatório
no keychain do sistema, faz uma chamada read-only com `tools: []`, confere a
resposta e a `rawRef` redigida e, no `finally`, revoga o registro/segredo local e
remove somente o diretório temporário exato criado por `mkdtemp`.

Esse fluxo autentica uma conta e faz uma chamada real, podendo consumir limites
da assinatura; exige keychain funcional e elegibilidade da conta. O protocolo
pode sofrer drift e, nesse caso, deve falhar fechado. Não há promessa de
revogação remota para o protocolo fixado. O harness imprime o ID local e o data
root temporário para recuperação: se o processo for encerrado à força antes do
`finally`, a limpeza deve usar exatamente esses dois valores com `auth revoke`
antes de remover o diretório temporário validado. Nunca copie tokens para essa
recuperação. A existência deste harness também não comprova que o fluxo real foi
executado neste checkout.

### Provenance

O snapshot fixado do OpenCode é `45cd8d76920839e4a7b6b931c4e26b52e1495636`, MIT.
`third_party/opencode/PROVENANCE.json` é o inventário estruturado canônico: fixa source e destination
arquivo por arquivo, hashes, patch IDs, licença e exceções nominais. `copied-files.md`, `patches.md` e
`UPSTREAM.md` são projeções humanas que o gate confere contra esse inventário. O parâmetro protocolar
`originator=opencode` é uma exceção nominal preservada: não é User-Agent ou branding. O User-Agent é
`ralph-next/...` e pode ser injetado. O gate rejeita dependência OpenCode flutuante, pacote privado,
source/destination não inventariado, hash divergente e branding ou asset upstream não declarado.

O guia operacional completo está em [docs/20-providers-auth-e-modelos-s04.md](docs/20-providers-auth-e-modelos-s04.md).

### Validação focada S05

A S05 liga o backend embutido/CLI externo ao ToolHost e ao runner real. Durante desenvolvimento,
rode somente os grupos tocados abaixo; o gate global já foi executado e é reproduzido separadamente
por `bun run check`:

```text
bun test packages/tool-host/tests/tool-host.test.ts
bun test packages/supervisor/tests/supervisor.test.ts
bun test packages/model-drivers/tests
bun test apps/ralph-cli/tests/tool-execution-port.test.ts
bun test apps/ralph-cli/tests/terminal-permission-prompt.test.ts
bun test apps/ralph-cli/tests/s05-services.test.ts
bun test tests/integration/s05-interactive-permissions.test.ts
bun test tests/integration/s05-embedded-e2e.test.ts
bun test tests/integration/s05-external-e2e.test.ts
bun test tests/integration/s05-public-cli-smoke.test.ts
bunx tsc --noEmit --pretty false
bun run schemas:check
```

Esses E2Es usam transporte OpenAI e processo CLI fixture; não consomem conta, key ou quota real. O external CLI ainda é um executável confiado no host: cwd temporário e protocolo read-only não substituem o sandbox de sistema operacional da S09. O contrato completo está em [docs/21-tool-host-e-execucao-s05.md](docs/21-tool-host-e-execucao-s05.md).

### Validação focada S06

A S06 liga o evidence store, gates, policy de avaliação, backends de judge, revision recovery,
report e projeção TUI. Para mudanças focadas, use os entrypoints diretamente afetados; o gate global
é reproduzido separadamente por `bun run check`:

```text
bun test packages/evaluation/tests/evaluation.test.ts
bun test packages/model-drivers/tests/judge-backends.test.ts
bun test tests/unit/judge-domain.test.ts tests/unit/judge-attachments.test.ts
bun test tests/unit/evaluation-policy.test.ts tests/unit/s06-gates.test.ts
bun test tests/unit/s06-prd-gates.test.ts tests/unit/s06-completion-compositions.test.ts
bun test tests/unit/skip-completion-policy.test.ts
bun test tests/integration/judge-store.test.ts
bun test tests/integration/s06-judge-runner.test.ts
bun test tests/integration/revision-recovery.test.ts
bun test tests/integration/s06-public-entrypoint-smoke.test.ts
bun test packages/tui/tests
bun run schemas:check
bun run typecheck
```

O smoke público S06 executa o entrypoint real com executor e judge `external-cli` fixture, persiste
scores `60 -> 88`, exige uma revisão para threshold 85 e verifica report, arquivo entregue e marker.
Quando realmente executado sobre o mesmo source/artifact, ele prova o protocolo/composição do
produto, não disponibilidade de uma conta ou provider pago. `attach` é read-only para runs já
materializados. A S08 posterior integrou Apply antes da persistência e Save workspace/global para
runs futuros; attach/replay continuam sem reescrever o snapshot persistido. Esses fluxos foram
exercitados pelas matrizes locais `EV-S11-E2E-100`/`EV-INT-149`; continuam sem provider/auth real e
sem binding ao candidato.

## Contrato de saída

- `human`: texto conciso; cor somente quando permitida pelo terminal/opções.
- `json`: comandos finitos comuns retornam um `CommandResult` v1; `logs tail` (tail finito ou follow) e outros record streams retornam um único array fechado no encerramento cooperativo, sempre sem banner/ANSI.
- `jsonl`: comandos finitos comuns retornam um `CommandResult` por linha; `events` retorna envelopes e `logs tail`/follow retornam um record estruturado por linha.
- diagnostics humanos usam stderr; o formato solicitado permanece em stdout.
- `--debug` acrescenta detalhes redigidos, nunca desabilita redaction.

Exit codes são compartilhados por domínio, help e docs normativos:

| Código | Significado |
| --- | --- |
| 0 | sucesso |
| 1 | erro operacional não classificado |
| 2 | uso/flag/config inválido |
| 3 | PRD/schema/graph inválido |
| 4 | verification/gate/judgment falhou |
| 5 | bloqueado ou aguardando ação |
| 6 | provider/auth/model indisponível |
| 7 | conflito de workspace/lease/Git |
| 8 | interrompido e retomável |
| 9 | limite, budget, timeout ou watchdog esgotado |
| 10 | operação negada por segurança/policy |

## Build e packaging

Build nativo da máquina atual:

```text
bun run build
```

O comando gera:

```text
dist/ralph-next.js
dist/ralph-next.js.map
dist/standalone/<target>/ralph-next[.exe]
dist/standalone/<target>/build-metadata.json
```

O metadata contém target, versão/revisão do Bun, SHA-256 e o status inicial `built-not-tested`. Somente o smoke executado nativamente prova que aquele target rodou.

Targets fechados aceitos pelo script:

| Plataforma | Target Bun |
| --- | --- |
| Windows x64 | `bun-windows-x64-baseline` |
| Windows arm64 | `bun-windows-arm64` |
| Linux x64 | `bun-linux-x64-baseline` |
| Linux arm64 | `bun-linux-arm64` |
| macOS x64 | `bun-darwin-x64` |
| macOS arm64 | `bun-darwin-arm64` |

O host nativo também deve pertencer exatamente a essa matriz (`win32|linux|darwin` e `x64|arm64`). Flags desconhecidas, target ausente e combinações como `--all --target ...` falham; não existe fallback silencioso para outro SO ou arquitetura.

Construir um target específico:

```text
bun run scripts/build.ts --target bun-linux-x64-baseline
```

Construir todos os targets suportados pelo compiler do Bun:

```text
bun run build:all
```

Cross-build não é cross-test. Releases futuras só poderão declarar suporte depois do smoke nativo e dos gates de S11/S12.

## Smoke do standalone

Depois do build nativo:

```text
bun run smoke
```

O smoke:

1. localiza o target nativo;
2. copia o executável para um diretório temporário externo ao checkout;
3. cria workspace e config home isolados com espaços/Unicode;
4. executa `version`, `help`, `about`, `init`, `status`, `config list`, `config explain`, `doctor`, catálogo, auth e profiles em JSON;
5. prova no standalone `auth connect` por referência de ambiente, status, configuração/inspeção de profile e revoke, sem fazer chamada paga de modelo;
6. rejeita exit code não zero, stderr inesperado, ANSI, comando lógico divergente, envelope diferente de `CommandResult` v1, checks mínimos ausentes ou qualquer canário secreto persistido;
7. remove somente a fixture temporária criada por ele.

Para testar explicitamente outro binário compatível com a plataforma atual:

```text
bun run scripts/smoke.ts --binary <caminho-do-ralph-next>
```

O smoke exige `build-metadata.json` ao lado do standalone e valida target nativo, SHA-256 do artefato e fingerprint do source/receita de build atuais antes de executar. Um artefato antigo não pode produzir nova evidência `tested`; reconstrua com `bun run build`.

## Schemas públicos

A definição fonte do gerador contém 59 JSON Schemas: além dos contratos de configuração/PRD da
S01/S02 e dos records/evidence da S03, a S04 publica credenciais/providers/modelos, a S06 publica os
contratos de judge/evaluation, a S07 publica recovery, decisões/aceitação, leases/probes e watchdog,
e S12 acrescenta operações/reports e contratos de release. O gerador materializou os 59 arquivos e
`schemas:check` confirmou a árvore no ciclo local atual. O gerador usa APIs portáveis de Node; não
edite JSON gerado manualmente nem trate esse check como prova de artifact publicado.

## Testes e gate local

Comandos granulares:

```text
bun run test:unit
bun run test:integration
bun test
```

Gate global de fechamento:

```text
bun run check
bun run docs:check
git diff --check
```

`bun run check` continua executando schemas, lint, typecheck, um único `bun test`, build nativo e
smoke nativo. `docs:check` usa CommonMark AST para validar links, imagens, referências e âncoras
Markdown, confere `bun run <script>` contra `package.json` e rejeita escapes por symlink/junction;
`href`/`src` em HTML cru ficam explicitamente fora desse contrato. No ciclo local
de 2026-07-19, o gate consolidado fechou com 673 testes aprovados e dois smokes reais opt-in
corretamente ignorados; a integração separada fechou 149/149. `git diff --check` continua separado
para detectar whitespace inválido no patch quando houver baseline Git rastreado.

O fechamento S11.12/S12 agrega essas verificações sem repetir aliases focados:

```text
bun run check:s12 -- --evidence-root artifacts/ci/s11-closure/local-YYYYMMDD-NNN [--legacy-binary <RALPH_V1_EXPLICITO>] [--next-binary <RALPH_V2_EXPLICITO>] [--candidate-artifact <ARQUIVO_CANDIDATO> --candidate-digest sha256:<64_HEX>] [--waiver-artifact <APROVACOES_EXTERNAS_JSON> --waiver-digest sha256:<64_HEX>] [--gitleaks-binary <BINARIO_CANONICO> --gitleaks-sha256 <64_HEX>]
```

O runner começa por `bun install --frozen-lockfile`. O global JUnit é a única chamada `bun test`;
distribution, sample e licença/provenance entram por discovery. `--legacy-binary`/`--next-binary`
são opcionais somente em conjunto e nunca são inferidos. Da mesma forma, `--candidate-artifact` e
`--candidate-digest` são um par obrigatório. O artifact precisa ser um
`release-candidate-receipt.json` standalone ou um `release-manifest.json` Ralph válido; o runner
confere o SHA-256 da metadata, revalida schema e payloads declarados por tamanho/hash e repete a
leitura antes do binding. O payload destacado de assinatura de um release manifest não possui
self-hash por desenho: ele é somente lido de forma estável, limitado por `maximumSizeBytes`, recebe
hash observado separado e continua sem autenticidade alegada. O total lido é limitado a 8 GiB e
respeita cancelamento entre chunks. O archive guarda digest/tamanho exatos da metadata, uma projeção
tipada sem URLs e o inventário dos payloads; não copia a metadata bruta e não é evidência autônoma sem
o candidato externo retido. Isso é chamado de `content-verified`, não de assinatura autenticada.
O digest fornecido na CLI identifica somente a metadata. Para source binding e waivers, o runner
deriva e publica um `effectiveCandidateDigest` separado sobre kind + digest/tamanho da metadata +
payload content address, incluindo o hash observado de assinatura destacada; waiver deve usar esse
digest efetivo, nunca o digest de metadata isolado.

Uma aprovação concreta de waiver nunca é editada no registry versionado, pois isso alteraria o
próprio commit/candidato e criaria um ciclo. `--waiver-artifact`/`--waiver-digest` são um par opcional
externo pós-candidato e exigem também o par de candidate. O JSON schema v1 vincula o digest efetivo,
digest da metadata, repository identity digest, commit e fingerprint; approvals são únicas/ordenadas,
não podem mencionar `BLK-SOURCE-BINDING` e o owner deve coincidir com o registry. O arquivo+digest
explicitamente fornecidos pelo operador são a autoridade configurada deste fluxo; nenhuma assinatura
criptográfica do waiver é alegada. O arquivo bruto/path não é arquivado, e qualquer waiver usado é
revalidado, inclusive expiração, imediatamente antes de `closure-complete.json`.
O runner exige diretório novo, usa `windowsHide: true`, não abre TUI e produz logs bounded/redigidos,
receipts, R001–R079, blockers, manifest content-addressed e `SHA256SUMS`. Para esse script de
desenvolvimento, exit `1` significa falha local e exit `2` significa
`local-pass/release-blocked`; o código `2` não é o exit de usage do produto nem aprovação de release.
Os steps usam hard timeout absoluto generoso e encerramento da árvore; não existe heurística de
silêncio, portanto processamento demorado não vira stall só por não imprimir output.

`BLK-SOURCE-BINDING` só resolve quando HEAD, árvore limpa e origem Git canônica permanecem idênticos
nas probes antes/depois, o inventário/fingerprint não muda e repositório, commit e fingerprint do
candidato coincidem. A URL é comparada somente em memória; o archive guarda apenas seu SHA-256. O
vínculo é não-waivable e segue um DAG sem autorreferência: evidência core + candidate binding →
`source-binding.json` → `blockers.json`/`run-manifest.json` → `evidence-manifest.json` →
`SHA256SUMS` → `closure-complete.json`. Os documentos anteriores permanecem explicitamente
provisórios; apenas o último receipt, gravado depois de revalidar o envelope e contendo os hashes
exatos do manifest/checksums/source binding, é autoridade de status final. O source binding só é
efetivo quando esse commit marker e o envelope validam.

O gate focado de dependências, secrets, licenças, proveniência e SBOM é:

```text
bun run test:release-security -- [--gitleaks-binary <BINARIO_CANONICO> --gitleaks-sha256 <64_HEX>]
```

Sem os dois flags, ele exige o receipt checksum-pinned
`artifacts/ci/tooling/gitleaks-install.json` e o binário exato produzido por
`scripts/ci/install-gitleaks.sh`. Não existe fallback para `gitleaks` arbitrário no `PATH`. O gate
confere versão 8.30.1, bytes e SHA-256 fixos do binário Linux x64 extraído do archive oficial já
pinado, hash antes/depois e report JSON vazio. Ele também exige Bun 1.3.14 na revisão exata fixada
pelo CI e um JUnit não vazio, sem failure/error/skip e com casos aprovados dos quatro arquivos de
licença/proveniência. Todos os processos usam supervisor com cwd/executável hash-bound e timeout
absoluto; falhas registram somente tamanhos/hashes de stdout/stderr.

No Windows, automação deve impedir que Bun ou seus consoles filhos ativem outra janela e roubem o
foco. O projeto já exige `windowsHide` explícito em todo `Bun.spawn`; o processo de topo pode ser
executado oculto, com logs e prioridade reduzida. Em PowerShell 7+, o wrapper versionado é a forma
preferida e aceita qualquer argv do Bun sem passar por shell:

```powershell
pwsh -NoProfile -File .\scripts\run-bun-hidden.ps1 -LogName check run check
```

Execute-o como `pwsh -File` (não faça dot-source), pois ele devolve o exit code do Bun pelo processo
PowerShell filho. Ele imprime somente exit code e os dois caminhos de log. A forma expandida
equivalente é:

```powershell
$stdout = Join-Path $env:TEMP "ralph-v2-check.stdout.log"
$stderr = Join-Path $env:TEMP "ralph-v2-check.stderr.log"
$process = Start-Process -FilePath (Get-Command bun).Source `
  -ArgumentList @("run", "check") `
  -WorkingDirectory (Get-Location).Path `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru
$process.PriorityClass = "BelowNormal"
$process.WaitForExit()
Get-Content -LiteralPath $stdout -Tail 120
Get-Content -LiteralPath $stderr -Tail 120
if ($process.ExitCode -ne 0) { exit $process.ExitCode }
```

Não aplicar esse wrapper a uma TUI/editor que o usuário pediu para abrir interativamente.

Para reproduzir o gate de fechamento da S03, execute os dois relatórios sobre esse mesmo build fresco:

```text
bun run compat
bun run compat:s03
```

O primeiro preserva a comparação fundacional com o Ralph clássico; o segundo prova a fronteira produtivo/fake e a vertical slice empacotada da S03.

## Harness de compatibilidade

O script público e suas opções são:

```text
bun run compat
bun run compat:s03
bun run compat -- --legacy-binary <path> --next-binary <path>
bun run compat -- --output-dir <diretorio>
bun run compat -- --without-legacy --next-source --no-write --json
```

O harness recusa um standalone cujo hash ou `sourceSha256` não corresponda ao artefato/source atuais. Testes de integração usam `--next-source --no-write` explicitamente; source nunca pode gravar o baseline versionado. O baseline exige o binário nativo recém-construído e revalida metadata, target, hash do artefato e fingerprint imediatamente antes da escrita.

Por default, o harness resolve o Ralph clássico por `RALPH_LEGACY_BINARY` ou pelo comando `ralph` no `PATH`. O novo usa `RALPH_NEXT_BINARY` ou o standalone nativo fresco. Se não houver artefato fresco, ele falha com orientação de build; o source só é aceito pela combinação explícita `--next-source --no-write`. `--without-legacy` exige `--no-write`: é somente validação do lado novo e nunca pode substituir o baseline de paridade.

O harness executa ambos somente em diretórios temporários, captura stdout/stderr/exit code/arquivos e registra evidências de invariantes. O baseline continua se chamando `s01-report` porque sua matriz comparativa cobre os contratos fundacionais: superfície completa do help, semver, status não mutante, schemas de `workspace.json`/`config.yaml`, evento do ledger e descoberta por ancestrais. Ele foi regenerado no fechamento da S03 para capturar a ajuda pública expandida, mas não é usado como falsa prova de paridade de execução; essa prova exige também o E2E empacotado e o addendum S03 frescos.

O relatório separa a decisão `compatible|changed|deprecated|removed` do assessment `pass|regression` e contém sempre a matriz fechada dos seis targets, distinguindo `tested`, `built-not-tested` e `not-evidenced`. A captura portable substitui a raiz descartável e valores UUID/timestamp, sem esconder outras diferenças. A ausência do binário clássico sem `--without-legacy` produz diagnóstico explícito, não simula paridade. Por default ele grava `docs/compatibility/s01-report.json` e `docs/compatibility/s01-report.md`; `--no-write` evita alterar relatórios e `--json` imprime o resultado estruturado. Regressão ou erro encerra com exit code 1.

`bun run compat:s03` é o addendum empacotado específico da orquestração. Ele exige o standalone nativo fresco de `bun run build`, valida metadata/hash/fingerprint, confere a ajuda e flags S03 no produto, prova que `--executor-profile fake` retorna exit `6` sem run ou marker alterado e compila separadamente a composition root de teste. Nela, executa `init -> once -> status run -> events -> report last` e verifica entregável, gate, marker, progresso, eventos e report persistido.

Os resultados são gravados em `docs/compatibility/s03-addendum.json` e `docs/compatibility/s03-addendum.md`. O relatório classifica explicitamente o standalone normal como elegível para release e o executável da fixture como não elegível. Somente invocações portáteis, exit contracts, diagnostic codes e hashes de output normalizado são retidos; paths absolutos, environment values, UUIDs, timestamps, durações e raw output não entram no artefato. Esse addendum não sobrescreve nem reinterpreta o baseline S01.

O harness não recebe o checkout `C:\Users\Rodrigo\Desktop\Ralph Loop` como diretório de trabalho e não tem autorização para modificá-lo.

## CI

No checkout de source, `.github/workflows/ci.yml` executa uma matriz independente em Windows,
Linux e macOS com Bun `1.3.14`. O workflow não integra os artifacts de runtime; por isso seu path é
uma referência de contribuição, não um link prometido dentro da distribuição:

1. install com lockfile congelado;
2. lint;
3. typecheck;
4. testes;
5. build standalone nativo;
6. smoke do mesmo executável nativo;
7. `git diff --check`.

O sucesso de uma linha da matriz comprova somente aquela plataforma/arquitetura disponibilizada pelo runner. Artefatos cruzados ou plataformas fora da matriz permanecem `built-not-tested`.

## Decisões e limites

As decisões fundacionais aceitas até a S03 estão em [docs/adr/README.md](docs/adr/README.md); as decisões de provenance S04 também estão registradas em `third_party/opencode/`, e os contratos S05/S06 permanecem nas fontes normativas e schemas runtime correspondentes. Mudanças de contrato exigem atualizar o ADR ou registro normativo correspondente.

Não registre o fake no produto nem apresente o smoke S04 como executor de tarefas. Tool host/executor
e judge possuem fluxos compostos desde S05/S06, enquanto TUI rica, watchdog e child execution foram
integrados nas slices S07-S09. Testes determinísticos com transportes/processos fixture não devem ser
descritos como login, consumo real de conta ou prova do artifact. OpenRouter possui transporte
embutido no source posterior; Anthropic permanece catalog-only. Em todos os casos, catálogo ou
inspeção estática não substituem smoke real nem autorização de release.
