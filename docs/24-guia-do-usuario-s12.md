# 24 — Guia do usuário do Ralph v2

## Estado deste guia

Este guia descreve a superfície pretendida de `ralph` e separa três estados:

- **implementado estaticamente**: existe composição no source, mas sua execução ainda precisa ser
  validada;
- **disponível em release**: exige um artifact publicado com evidência para a plataforma;
- **opt-in real**: exige conta, credencial, quota ou infraestrutura externa e nunca é inferido de um
  mock.

O nome do comando é sempre `ralph`. Como a versão anterior usa o mesmo nome, remova sua instalação
explicitamente antes de instalar a v2; o Ralph não apaga automaticamente um executável externo.

Todos os exemplos de CLI abaixo mantêm cada comando em uma única linha. Assim, podem ser copiados
sem trocar o caractere de continuação entre PowerShell, `cmd.exe` e shells POSIX; substitua apenas os
valores entre `<...>`.

## 1. Conceito operacional

O Ralph é o controlador. Ele seleciona a task do PRD, monta o contexto, autoriza tools, executa
gates, solicita avaliação e somente então persiste a conclusão. Executor e judge são ferramentas do
CLI; nenhuma mensagem do modelo altera o estado oficial por conta própria.

Uma execução usa:

1. um workspace identificado por `.ralph/workspace.json`;
2. um PRD root v2 e todos os Sub-PRDs já escritos pela skill;
3. um perfil de executor;
4. avaliação `deterministic-only`, `self`, `external` ou `manual`;
5. opções de execução persistidas de forma imutável na run;
6. o mesmo event ledger para headless, TUI, attach, replay, logs e reports.

## 2. Instalação e substituição do CLI anterior

### Checkout de desenvolvimento

O checkout exige Bun na versão declarada por `packageManager`. Os comandos abaixo são de uso do
produto; os comandos de teste/build pertencem ao guia de desenvolvimento.

```text
bun install --frozen-lockfile
bun run ralph -- version
bun run ralph -- help
bun run ralph -- update --check
```

Uma instalação `dev-checkout` não se autoatualiza. `update --check` deve explicar a origem e indicar
o procedimento Git sem executá-lo.

### Standalone

Uma release standalone usa um launcher estável e versões imutáveis sob um install root. O fluxo
pretendido é:

```text
ralph install --manifest <HTTPS-OU-ARQUIVO-LOCAL> --install-root <DIRETORIO> --dry-run
ralph install --manifest <HTTPS-OU-ARQUIVO-LOCAL> --install-root <DIRETORIO>
ralph update --install-root <DIRETORIO> --check
ralph update --install-root <DIRETORIO> --dry-run
ralph update --install-root <DIRETORIO>
ralph rollback --install-root <DIRETORIO> --dry-run
ralph rollback --install-root <DIRETORIO>
ralph uninstall --install-root <DIRETORIO> --dry-run
ralph uninstall --install-root <DIRETORIO>
```

`rollback preview|apply` pertence ao rollback de checkpoint/workspace descrito na seção 12; sem
subcomando, `rollback --install-root` é o rollback da versão standalone. Em automação, a variável
`RALPH_INSTALL_ROOT` pode substituir a flag. O launcher também fornece o root à engine instalada,
mas scripts externos não devem depender desse contexto implícito.

Use apenas as flags exibidas pelo `help` do artifact instalado; a composição final desses comandos
é parte de S12. O instalador confere target, tamanho, SHA-256, metadata, licença, notices e SBOM antes
de trocar `current.json`. Ele não sobrescreve a engine em execução.

### npm

O pacote npm, quando publicado, preserva exclusivamente o bin `ralph`. O próprio package manager continua
responsável por atomicidade e rollback. O CLI não executa um update npm silencioso. O wrapper
distribuído identifica o nome do pacote; por isso
`ralph update --check` devolve uma orientação fail-closed para o package manager antes de pedir
um install root, mas não executa essa orientação. Como o tarball pode ter sido instalado por npm,
pnpm ou Bun, o Ralph não escolhe um deles por heurística nem sugere sintaxe quando o gerenciador é
desconhecido: você deve usar a mesma ferramenta que possui a instalação atual.

### Substituir uma instalação anterior que já usa `ralph`

Antes de instalar a v2, inventarie todas as resoluções do comando com `Get-Command ralph -All` e
`where.exe ralph` no Windows, ou `type -a ralph` no POSIX. Registre o path e a versão da instalação
anterior, remova-a com o mesmo instalador/package manager que a criou e só então instale a v2.
Depois, repita a inspeção e execute `ralph version`; não considere a troca concluída se mais de uma
origem inesperada continuar precedendo o novo binário. O protocolo copiável está em
[28 — Drills de release, beta e handoff](28-release-drills-beta-e-handoff-s12.md).

## 3. Criar e reconhecer um workspace

```text
ralph init --workspace <PROJETO> --format json
ralph status --workspace <PROJETO>
ralph doctor --workspace <PROJETO>
```

`setup` é alias de `init`. Um `.ralph` não identificado ou legado é uma fronteira: `init --force`
não autoriza sobrescrevê-lo. Múltiplos projetos e múltiplas instâncias do Ralph usam IDs, locks,
leases e ledgers próprios.

## 4. Criar o PRD root e os Sub-PRDs

Use a skill distribuída em `skills/ralph-loop-prd-generator`. Ela recebe cenário, projeto, issue,
especificação ou PRD legado e deve escrever antes da execução:

- o PRD root;
- todos os Sub-PRDs referenciados;
- tasks verticais pequenas, de ponta a ponta;
- dependências e grupos paralelos apenas quando seguros;
- critérios, `change-only` ou artifact útil, sem inventar verificações superficiais; se nenhum
  entregável natural existir, um receipt bounded pré-declarado e ligado à task pode fornecer a
  mudança/hash determinística mínima sem alegar correção semântica.

O runtime do Ralph nunca cria ou expande PRDs. Confira o resultado com:

```text
ralph prd validate <PRD-ROOT> --recursive --strict
ralph prd inspect <PRD-ROOT> --recursive --strict --format json
ralph tasks list --prd <PRD-ROOT>
ralph tasks next --prd <PRD-ROOT>
```

PRDs clássicos são aceitos apenas pelas superfícies de compatibilidade/migração. Prefira gerar outro
arquivo e revisar o relatório:

```text
ralph prd validate <PRD-LEGADO>
ralph prd migrate <PRD-LEGADO> --output <PRD-V2>
ralph prd validate <PRD-V2> --recursive --strict
```

## 5. Configurar executor e judge independentemente

### Descobrir providers e modelos

```text
ralph providers list
ralph providers inspect <ID>
ralph models list --provider <ID>
ralph models inspect <PROVIDER>/<MODEL>
```

Catálogo não equivale a driver disponível. O status do provider/model informa se há execução
embutida, apenas metadata ou suporte ainda desconhecido.

### API key sem segredo em argv

Nunca passe o valor da chave na linha de comando.

```text
<LEITURA-SEGURA-DA-CHAVE> | ralph auth connect <ID> --method api-key --secret-stdin --label <NOME>
ralph auth list
ralph auth status <REF>
```

Para variável de ambiente, persista somente o nome:

```text
ralph auth connect <ID> --method environment --environment <NOME_DA_VARIAVEL> --label <NOME>
```

### Conta ChatGPT para Codex

Quando o snapshot protocolar estiver elegível, o fluxo de conta é embutido e não depende de chamar
o executável `codex`:

```text
ralph auth connect openai --method oauth-browser
ralph auth connect openai --method device-code --headless
```

Suporte real a Plus/Pro só pode ser alegado depois de smoke opt-in com conta elegível. Tokens ficam
no credential store do sistema; config e logs carregam apenas referências redigidas.

### Perfis embutidos

```text
ralph profiles configure executor-main --role executor --backend embedded --provider openai --model <MODELO> --credential <REF> --scope workspace
ralph profiles configure judge-main --role judge --backend embedded --provider <PROVIDER> --model <MODELO> --credential <REF> --scope global

ralph profiles inspect executor-main
ralph profiles inspect judge-main
```

Executor e judge podem usar providers, modelos, credenciais, variantes e fallbacks diferentes.
Fallback só ocorre nas classes explicitamente autorizadas e nunca depois de efeito externo incerto.
OpenAI e OpenRouter possuem adapters embedded; OpenRouter exige credential API/environment e usa o
endpoint Responses beta fixado. Anthropic continua somente catalogado até existir driver próprio,
ainda que modelos Anthropic possam ser selecionados através de um ID OpenRouter suportado.

### Backend CLI externo

O backend externo é opcional. Ele serve para um processo confiado pelo usuário e continua
subordinado ao command model:

```text
ralph profiles configure executor-cli --role executor --backend external-cli --cli-executable <EXECUTAVEL> --cli-arg <ARGUMENTO> --cli-adapter protocol --cli-streaming false --cli-tool-calling ralph --cli-cancellation true --cli-usage unavailable --cli-mutation read-only --scope workspace
```

O adapter `protocol` v1 recebe JSON bounded por stdin e devolve um único resultado JSON; por isso
declara streaming e usage como indisponíveis. `read-only` proíbe mutação direta pelo processo
externo, mas `tool-calling ralph` ainda permite que ele solicite tools autorizadas e executadas pelo
ToolHost do CLI. `generic` e `known-output` servem apenas para processos read-only que não precisam
do protocolo de tools; declarar `workspace`, streaming ou usage em v1 falha fechado.

Mapeie secrets por referência de ambiente, nunca como argumento:

```text
--cli-env TARGET=env:SOURCE
```

## 6. Escolher a avaliação

### Somente determinística

```text
ralph run --prd <PRD> --executor-profile executor-main --evaluation deterministic-only
```

O Ralph usa diff/artifacts/gates aplicáveis e não fabrica nota.

### Self-review opcional

```text
ralph run --prd <PRD> --executor-profile executor-main --self-review
```

A revisão é uma nova chamada read-only com o mesmo schema/rubrica do judge, não a mensagem de
conclusão do executor.

### Judge externo independente

```text
ralph run --prd <PRD> --executor-profile executor-main --judge-profile judge-main --evaluation external --judge-threshold 85 --judge-max-revisions 2 --judge-call-retries 2 --judge-exhausted manual-review
```

O judge devolve score 0–100, pontos adequados, problemas/ausências e findings. Threshold, retries de
transporte e revisões de código têm contadores separados. Gate determinístico bloqueante não é
anulado por score alto.

### Verificação e julgamento standalone

Quando for preciso repetir somente a prova determinística, sem chamar executor nem alterar task ou
marker, selecione exatamente uma evidência persistida:

```text
ralph verify --run-id <RUN_ID> --task <DOCUMENT/TASK>
ralph verify --attempt-id <ATTEMPT_ID>
ralph verify --evidence-bundle-id <EVIDENCE_BUNDLE_ID>
```

O `judge` standalone também é read-only. Ele pode avaliar a evidência de uma attempt/bundle ou a
evidência nova produzida por uma operação `verify` concluída:

```text
ralph judge --evidence-bundle-id <EVIDENCE_BUNDLE_ID> --evaluation external --judge-profile judge-main
ralph judge --verification-id <VERIFY_OPERATION_ID> --evaluation external --judge-profile judge-main
ralph judge --attempt-id <ATTEMPT_ID> --evaluation self --executor-profile executor-main
```

Seleção por task exige `--run-id`; `--attempt-id`, `--evidence-bundle-id` e `--verification-id`
referenciam identidades imutáveis. Essas operações gravam reports/receipts próprios, mas não iniciam
revision attempt, não editam código e não concluem marker.

### Manual

```text
ralph run --prd <PRD> --evaluation manual
```

Uma task aguardando revisão não é marcada concluída. Overrides manuais exigem motivo e evidência
auditável:

```text
ralph tasks done <TASK-ID> --prd <PRD> --evidence <ARQUIVO> --reason <MOTIVO> --force
```

## 7. Formas de execução

### Preview sem modelo ou escrita

```text
ralph once --prd <PRD> --dry-run
ralph run --prd <PRD> --dry-run
ralph parallel --prd <PRD> --dry-run
```

### Uma task

```text
ralph once --prd <PRD>
ralph once --task <TASK-ID> --prd <PRD>
ralph once "implemente uma pequena funcionalidade ponta a ponta"
```

O argumento posicional de `once` é sempre uma descrição ad hoc. Para selecionar uma task do PRD,
use `--task`; as duas formas não podem ser combinadas. A execução ad hoc persiste descrição/hash,
tentativas, evidência e report, pode ser retomada por `resume`, e nunca cria/edita PRD ou sub-PRD.

### Loop bounded

```text
ralph run --prd <PRD> --max-tasks 5
ralph loop --prd <PRD> --max-tasks 5 --fail-fast
```

### Ralph Wiggum

```text
ralph run --prd <PRD> --wiggum --max-iterations 3 --max-model-calls 12
```

Cada iteração relê o PRD somente depois de conferir o hash; ela não restaura memória conversacional
oculta.

### Sub-PRDs

O pai reserva e supervisiona a instância child. A task externa só conclui depois que todas as tasks
internas estiverem duravelmente concluídas. Em resume, o child ativo é retomado antes do pai ou da
próxima task.

### Paralelo

```text
ralph parallel --prd <PRD> --max-parallel 3 --max-global-parallel 6 --parallel-group <GRUPO> --git-worktrees --integration merge --fail-fast
```

Somente tasks sem dependência e sem claims conflitantes podem iniciar juntas. Worktrees/branches são
isolados; conflitos pausam para ação explícita e nunca provocam reset/clean destrutivo.

### Execução rápida e skips

```text
ralph run --prd <PRD> --skip-tests --skip-lint
ralph run --prd <PRD> --skip-gates <ID>
ralph run --prd <PRD> --fast
```

Skip é pedido auditável, não sucesso. Gate `required` exige também override explícito quando a policy
permitir e pode produzir no máximo `completed_with_override`.

## 8. TUI, popups e headless

```text
ralph run --prd <PRD> --ui tui
ralph run --prd <PRD> --ui auto
ralph run --prd <PRD> --ui plain
ralph run --prd <PRD> --ui none --format jsonl --non-interactive
```

Antes de uma nova run, a TUI pode abrir a paleta de configuração e aplicar um draft ao snapshot que
será persistido. Salvar em workspace/global altera somente defaults futuros. Em attach/replay, as
opções da run são imutáveis.

A TUI projeta:

- status e fase;
- `completed/total` e barra cuja largura do painel representa 100%;
- progresso root, child e agregado devidamente rotulado;
- tokens/custo como `reported`, `estimated` ou `unavailable`;
- log/activity, output bruto permitido e normalizado;
- tools, gates, judge/revisões e watchdog;
- conexão, pause, filtros, busca e replay.

Toda configuração do popup tem equivalente em CLI/config. Use `Ctrl+P` para a paleta e consulte o
help incorporado para os atalhos efetivos do artifact.

Use `Ctrl+M` para a superfície pesquisável de providers, modelos, capacidades e autenticação. Ela
mostra limites, variantes, procedência de preço, métodos de autenticação e o comando CLI equivalente.
`t` alterna explicitamente entre a rota de `executor` e `judge`. No preparo de uma run, `a` confirma
e aplica provider/model/credential ao draft antes da persistência; `d`, na aba de autenticação,
seleciona explicitamente uma rota sem credencial. Trocar a rota limpa variant e parameters
model-specific em vez de herdá-los silenciosamente. `w` e `g` confirmam a criação ou edição do
`RoleProfile` ativo e do default correspondente em workspace/global por uma única operação
`profiles configure --set-default`; perfil e pointer são gravados sob o mesmo lock/replace e afetam
somente runs futuras. Em
attach/replay, `a` permanece indisponível e o snapshot persistido continua somente leitura.
OAuth por browser, device code e sessão de assinatura podem ser iniciados no popup; a TUI mostra o
lifecycle, mas nunca o token. API key usa um input mascarado one-shot: o valor vai diretamente para
o serviço de credenciais e não entra em argv, state, snapshot, evento ou mensagem; o buffer é limpo
ao enviar, cancelar, fechar ou destruir a paleta. Fechar invalida também conexões enfileiradas, de
modo que elas não possam consumir posteriormente o one-shot. Para `environment`, o popup recebe
somente o nome da variável, nunca seu valor. Revogação exige confirmação. Os fluxos CLI equivalentes
continuam disponíveis:

```text
ralph auth connect <PROVIDER> --method api-key
ralph auth connect <PROVIDER> --method environment --environment <NOME>
ralph auth revoke <CREDENTIAL-ID>
ralph profiles configure <PROFILE> --scope workspace --clear-credential --clear-variant --clear-parameters --set-default <DEMAIS_OPCOES_DO_PERFIL>
ralph profiles configure <PROFILE> --scope workspace --inherit-profile-field credential --inherit-profile-field parameters
```

Cada folha do profile usa a mesma semântica na TUI, TTY e CLI: `inherit` remove somente o override
da camada alvo e revela o valor inferior; `set` grava o valor; `clear` grava um tombstone tipado ou
uma coleção vazia quando o contrato precisa suprimir o valor herdado. Uma flag ausente preserva a
camada alvo. `parameters` e `external_cli.environment_refs` são mapas replacement, portanto `{}` os
esvazia e um `null` legítimo dentro de `parameters` continua sendo dado, não tombstone. Os IDs aceitos
por `--inherit-profile-field` são os mesmos IDs exibidos no help do formulário; o flag pode ser
repetido e não pode conflitar com set/clear da mesma folha.

O modo `raw-engine` não serializa novamente eventos normalizados. Ele mostra somente conteúdo lido
de uma captura bruta persistida que o driver realmente tenha produzido. Drivers embutidos usam o
store `raw:model`; CLIs externos usam os arquivos stdout/stderr redigidos e limitados que o
supervisor gravou sob o run correspondente. A TUI resolve somente refs dos IDs root/children
anexados e somente quando elas ocupam campos estruturais conhecidos do envelope; conteúdo JSON
arbitrário de modelo/tool não é vasculhado à procura de refs. Diretórios, arquivos ou identidades
trocados por links são rejeitados, e offsets live usam uma LRU de tamanho fixo. Ausência de captura
é exibida como indisponível, sem transformar uma referência em conteúdo fictício.

Para manutenção e transporte headless da configuração:

```text
ralph config unset evaluation.threshold --scope workspace --dry-run
ralph config edit prepared-config.yaml --scope workspace --non-interactive --dry-run
ralph config import prepared-config.yaml --scope workspace --dry-run
ralph config export --scope effective --serialization yaml
ralph config export --scope workspace --serialization json --output config-export.json
```

Remova `--dry-run` somente depois de revisar os paths do preview. Import/edit aceitam configuração
e profiles tipados, mas nunca valores secretos nem `extensions`; use `auth connect` para
credenciais. `config edit` sem arquivo depende de TTY e de `RALPH_CONFIG_EDITOR` (argv adicional é
um array JSON em `RALPH_CONFIG_EDITOR_ARGS_JSON`) e falha claramente quando a porta não está
composta. Export sem `--output` usa stdout; com arquivo, não sai do workspace/diretório selecionado
e não sobrescreve sem `--force`. Commits de configuração usam um lock por arquivo e uma segunda
instância recebe conflito em vez de sobrescrever mudanças. Se um crash deixar o lock, inspecione o
PID/target indicado e só remova o arquivo após confirmar que nenhum writer está ativo; idade não
autoriza reclaim automático. Perfis são revalidados como grafo efetivo dentro do lock sobre a camada
mais recente; saves globais originados na TUI também validam o overlay do workspace ativo. Essas
mutações valem para novas runs, não para snapshots existentes.

## 9. Segurança, tools, Git e sandbox

```text
ralph run --prd <PRD> --security safe
ralph run --prd <PRD> --security auto --ask-tool process.exec
ralph run --prd <PRD> --security dangerous --allow-shell --force
```

Escopos podem ser reduzidos com `--read-path`, `--write-path`, `--allow-tool`, `--deny-tool`,
`--ask-tool` e `--allow-command`. Em headless, `--headless-ask deny|allow` resolve toda autorização
que normalmente exigiria pessoa. `dangerous` não desativa proteção do estado oficial, redaction,
receipt, path canônico ou invariantes do PRD.

Sandbox é capability explícita:

```text
ralph run --prd <PRD> --sandbox --sandbox-provider process
ralph run --prd <PRD> --sandbox --sandbox-provider docker --sandbox-image <IMAGEM-FIXADA>
```

Ausência de sandbox real é reportada como unavailable/skip, nunca como isolamento comprovado.

## 10. Resume, watchdog e recuperação

Por default, o Ralph descobre deterministicamente uma run compatível não terminal. Controle isso
com:

```text
ralph resume --run-id <ID>
ralph run --prd <PRD> --resume required
ralph run --prd <PRD> --resume never
ralph run --prd <PRD> --new-run
ralph stop --run-id <ID> --graceful --grace 30
```

`--new-run` e uma política `--resume` explícita são alternativas mutuamente exclusivas; combine
nenhuma das duas na mesma invocação.

Ao reabrir depois de crash, o Ralph retoma a task não finalizada — ou a primeira elegível quando não
existe progresso. Alterações parciais, evidence, attempts e child ativo são reconciliados antes de
começar trabalho novo.

O watchdog diferencia atividade, quiet e stall. Demora silenciosa, reasoning longo, retry-after,
processo com CPU/IO ou child ativo não são encerrados por um único timer. Recovery exige sinais
combinados e limites de restart/hard timeout.

## 11. Observar uma run

```text
ralph status run --run-id <ID>
ralph attach --run-id <ID>
ralph replay --run-id <ID>
ralph events --run-id <ID> --follow --format jsonl
ralph logs tail --run-id <ID> --source diagnostic --follow
ralph report show <ID>
```

Fechar a TUI não cancela a run. `attach` acompanha eventos novos; `replay` congela o high-water e não
muda estado.

## 12. Checkpoint e rollback de workspace

Checkpoint de workspace é separado do rollback da instalação:

```text
ralph checkpoint create --path <ARQUIVO> --inventory-root <DIRETORIO>
ralph checkpoint list
ralph checkpoint show <ID>
ralph rollback preview <ID> --expires-in 300
ralph rollback apply <ID> --confirm-plan-hash <SHA256>
```

O preview gera um hash de plano de curta duração. Apply só modifica paths identificados e não usa
`git reset --hard`, `clean` ou target amplo.

## 13. Migração do Ralph v1

```text
ralph migrate inspect <V1>
ralph migrate apply <V1> --destination <V2>
ralph migrate rollback <V2>/.ralph/migration/<ID>/rollback-manifest.json --dry-run
ralph migrate rollback <V2>/.ralph/migration/<ID>/rollback-manifest.json --confirm-plan-hash <SHA256>
```

`inspect` é estritamente read-only e não recebe destino. Em `apply`, o destino é separado. Segredos
não são importados, adapters/recipes permanecem quarentenados e um run v1 ativo nunca vira run v2
ativo implicitamente. O report e o rollback manifest enumeram cada arquivo criado. O rollback de
migração não é o rollback standalone nem `rollback preview|apply` de checkpoint: primeiro valide o
manifest com `--dry-run`, revise o plano e só então confirme seu hash exato. A origem v1 e arquivos
não listados permanecem intocados; qualquer arquivo listado modificado faz o comando recusar o plano.

## 14. Diagnóstico rápido

- **Nenhuma task elegível**: use `tasks list`, `tasks next` e `prd inspect --recursive` para localizar
  dependência, marker ou child pendente.
- **Credential unavailable**: use `auth status`; confirme o credential store e a variável
  referenciada sem imprimir seu valor.
- **Provider/model catalogado mas indisponível**: `providers inspect` e `models inspect` distinguem
  metadata de driver.
- **Judge não responde**: consulte a policy `--judge-unavailable`; retries de transporte não gastam
  revisões de código.
- **Workspace mudou durante resume**: inspecione o diagnóstico; `--accept-workspace-changes` aceita
  somente os hashes esperados/observados registrados.
- **Run parece parada**: veja `status run`, eventos de watchdog, worker/child heartbeat e hard
  deadline antes de solicitar stop.
- **Conflito paralelo**: preserve worktrees e evidence; escolha uma integração explícita.
- **Update bloqueado**: confira origem, channel, target, licença, evidence status, launcher schema e
  checksum. O bloqueio é preferível a sobrescrever o binário em uso.

## 15. Sample end to end S12.08

`examples/vertical-notes/` reúne um root PRD, child preexistente, judge fake read-only, template de
judge real opt-in, roteiro de stop/crash/resume, observação pela TUI e projeções redigidas de
report/evidence. O fake solicita uma revisão determinística de uma única slice; o Ralph continua
sendo o único responsável por threshold, counters, transições e conclusão.

O README do sample contém o comando implementado de `config import` e os comandos de
`prd validate/inspect`, run, resume e attach. Neste checkout, `prd validate` e `prd inspect`
recursivos/strict passaram no standalone Windows x64 atual (2 documentos, 5 slices, zero
diagnostics). Além disso, a integração executável local focada passou com 1/1 teste e 59 asserções:
executor roteirizado; judge fake external-CLI supervisionado fora do workspace; `72 -> revisão ->
96`; child; crash após commit da primeira folha; resume do mesmo run sem replay; snapshots/view da
TUI para root/child, barras, judge e usage; aplicação HTTP real com persistência após restart; e
comparação exata dos goldens redigidos em `expected/`.

Essa prova não executou provider/modelo/conta real, os comandos operacionais pelo standalone nem uma
TUI interativa em PTY. Também não pertence a package instalado ou release candidate. Por isso ela
fecha o sample local S12.08, mas não transforma os casos S12.09 de auth, attach/PTY, instalação,
plataforma ou release em suporte disponível.

## 16. Contratos de saída

`human` é para pessoas, `json` para uma resposta completa e `jsonl` para streams. Em JSON/JSONL,
stdout fica reservado ao contrato e diagnostics vão para stderr. IDs, event types, command names,
flags e config keys permanecem em inglês; texto humano/TUI suporta `pt-BR` e `en`.

```text
ralph lang list
ralph lang set pt-BR --scope workspace
ralph config get lang
ralph config validate
```

Nenhuma saída autorizada inclui segredo ou chain-of-thought privada.
