# Sample S12.08 — Vertical Notes

Este sample materializa um ciclo end to end pequeno para o Ralph v2:

- root PRD legivel e um Sub-PRD previamente materializado;
- quatro slices folha atravessando pagina, API, persistencia, container e operacao quando necessario;
- judge fake deterministico que reprova uma primeira avaliacao e aprova a revisao;
- judge real independente somente por opt-in e credential reference;
- interrupcao e retomada a partir da primeira slice nao finalizada;
- acompanhamento por TUI, incluindo progresso root/child, score, revisao, watchdog, logs e usage;
- projecoes esperadas sem tokens, custos, credenciais, hashes ou IDs fabricados.

## Estado honesto

O sample foi escrito, revisado e validado pelo standalone Windows x64 atual. `prd validate` e
`prd inspect`, ambos recursivos e strict, confirmaram 2 documentos, 5 vertical slices, parent/child
e dependency edges, hashes derivados e zero diagnostics.

A integração executável local `tests/integration/s12-sample-e2e.test.ts` também passou com 1/1 teste
e 59 asserções. Em workspace temporário, ela compila o grafo recursivo/strict, usa executor
roteirizado, executa o judge fake como processo external-CLI supervisionado fora do workspace,
observa `72 -> revisão -> 96`, conclui o child, injeta crash depois da primeira folha duravelmente
concluída e retoma o mesmo run sem repeti-la. A prova ainda materializa snapshots root/child para a
view da TUI, exercita a aplicação entregue por HTTP real antes e depois de restart, valida evidence e
artifacts persistidos e compara exatamente as projeções redigidas em `expected/`.

Esse resultado pertence ao checkout e host locais. Ele não chamou provider/modelo/conta real, não
executou a TUI interativa em PTY nem `config import`, `run`, `resume` ou `attach` pelo standalone, e
não prova package, instalação, target suportado ou artifact de release.

## Reprodução manual e prova ainda pendente

Os comandos de `prd validate` e `prd inspect` abaixo já foram executados com o standalone local. A
sequência manual de inicialização Git/workspace e o drill operacional de CLI/TUI permanecem
separados da integração automatizada:

```text
cd examples/vertical-notes
git init
ralph-next init
ralph-next prd validate PRD.md --recursive --strict
ralph-next prd inspect PRD.md --recursive --strict --format json
```

O judge externo sempre roda em um diretório temporário vazio: caminhos relativos ao sample não
ficam disponíveis para o processo. Por isso o perfil chama o binário estável
`ralph-sample-judge`, declarado em `tools/package.json`, em vez de apontar para
`tools/ralph-sample-judge.mjs`.

Materialize o shim do fixture em um prefixo local ignorado pelo Git e adicione apenas o diretório
de bins ao `PATH` da sessão que executará o Ralph. O pacote é privado, não possui dependências nem
scripts de instalação; `--ignore-scripts` mantém essa preparação sem execução de lifecycle hooks.

PowerShell:

```powershell
$sampleRoot = (Get-Location).Path
$fixtureRoot = Join-Path $sampleRoot ".ralph-fixtures"
$fixturePackage = Join-Path $sampleRoot "tools"
npm install --prefix "$fixtureRoot" --no-save --no-package-lock --ignore-scripts --no-audit --no-fund "$fixturePackage"
$fixtureBin = Join-Path $fixtureRoot "node_modules/.bin"
$env:PATH = "$fixtureBin$([IO.Path]::PathSeparator)$env:PATH"
Get-Command ralph-sample-judge | Select-Object -ExpandProperty Source
```

POSIX (`sh`, `bash` ou `zsh`):

```sh
sample_root="$(pwd)"
fixture_root="$sample_root/.ralph-fixtures"
npm install --prefix "$fixture_root" --no-save --no-package-lock --ignore-scripts --no-audit --no-fund "$sample_root/tools"
export PATH="$fixture_root/node_modules/.bin:$PATH"
command -v ralph-sample-judge
```

Mantenha o `PATH` nessa mesma sessão para `config import`, `run` e `resume`. O Ralph herda o
`PATH`, resolve o shim ao construir o binding de transporte e entrega ao worker o caminho canônico
com seu hash; o cwd temporário vazio continua sem receber caminho do workspace. Não use um `PATH`
global nem `npm link` para este drill.

Depois importe a configuração por preview e aplicação atômica:

```text
ralph-next config import config/fake-judge.config.yaml --scope workspace --dry-run
ralph-next config import config/fake-judge.config.yaml --scope workspace
ralph-next config validate
```

Selecione um executor real ja configurado. O judge fake e independente e read-only:

```text
ralph-next run --prd PRD.md --executor-profile <EXECUTOR_PROFILE> --judge-profile sample-fake-judge --evaluation external --judge-threshold 85 --max-revisions 2 --ui tui
```

O fake judge retorna 72 enquanto `note-create-flow` ainda não possui uma tentativa anterior marcada
duravelmente como `revision_required`; depois dessa reprovação/revisão, retorna 96. O Ralph, não o
script, aplica threshold, decide revisão,
contabiliza tentativas e persiste conclusao.

## Judge real opt-in

`config/real-judge.fragment.yaml` e apenas um template sem segredo. Prefira configurar provider,
model e credential reference pela CLI/TUI, conectar a credencial pelo fluxo `auth connect` e fazer
um smoke read-only explicito antes de substituir o perfil do fake:

```text
ralph-next profiles configure sample-real-judge --scope workspace --role judge --backend embedded --provider <PROVIDER_ID> --model <MODEL_ID> --credential <CREDENTIAL_REF>
ralph-next run --prd PRD.md --executor-profile <EXECUTOR_PROFILE> --judge-profile sample-real-judge --evaluation external --judge-threshold 85 --ui tui
```

Nenhuma API key ou token deve entrar no PRD, nos YAML do sample, em argv, logs ou reports.

## Interrupcao, crash e resume

Para o caminho cooperativo, solicite parada por outro terminal e retome o mesmo run:

```text
ralph-next status
ralph-next stop --run-id <RUN_ID> --graceful --grace 30
ralph-next resume --run-id <RUN_ID>
```

Para o drill de crash, encerre o processo pelo mecanismo seguro do ambiente somente depois de anotar
o `RUN_ID`; nao edite SQLite, markers ou heartbeat manualmente. Ao reiniciar:

```text
ralph-next status run --run-id <RUN_ID>
ralph-next resume --run-id <RUN_ID>
ralph-next attach --run-id <RUN_ID>
```

A retomada esperada parte da primeira folha ainda nao finalizada. Folhas concluidas nao voltam a ser
executadas, o parent `notes-lifecycle` continua aberto enquanto houver child incompleto e attempts,
revisoes e restarts de watchdog permanecem contadores diferentes.

## O que observar na TUI

- barra root cuja largura disponivel representa sempre 100%, acompanhada de `concluidas/total`;
- barra e contadores proprios do child `vertical-notes-lifecycle`;
- task/attempt realmente ativos, score 72, parecer, revisao e score 96;
- tokens/custo com fonte explicita ou `unavailable`, nunca zero inventado;
- estado do watchdog sem confundir processamento lento com travamento;
- logs redigidos e raw engine output somente quando o toggle e a policy permitirem.

Fechar a TUI nao conclui nem cancela a run. Use `attach` para acompanhar e os comandos de stop para
alterar o ciclo de vida.

A integração local validou a projeção de progresso root `4/4`, child `2/2`, barras responsivas,
labels de judge/revisão e usage `unavailable`. Watchdog, logs/raw output e close/reattach numa TUI
interativa continuam pertencendo ao drill PTY/release, não ao golden de view.

## Handoff de evidencia

Os arquivos em `expected/` são goldens redigidos da projeção determinística observada pela integração
local. O teste valida primeiro ledger, attempts, assessments, evidence, artifacts e comportamento do
produto; somente depois remove IDs, hashes reais, paths externos, texto da nota, tokens e credenciais
e exige igualdade estrutural com os goldens. Para operação manual ou release, use os records e o
report autoritativos do run concreto: os goldens não substituem evidence vinculada ao artifact.
