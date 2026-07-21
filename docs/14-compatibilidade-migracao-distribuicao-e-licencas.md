# 14 — Compatibilidade, migração, distribuição e licenças

## Estratégia de substituição controlada

A reescrita usa o executável e package `ralph` desde o primeiro corte. A comparação com a versão
anterior usa caminhos absolutos e fixtures read-only; duas versões não são publicadas no `PATH` sob
nomes diferentes. Na instalação da v2, o operador inventaria e remove explicitamente a instalação
anterior antes de ativar o novo `ralph`.

O checkout antigo é tratado como especificação executável. Testes black-box capturam comandos, flags, arquivos e outputs úteis; não se assume que documentação antiga esteja completa.

## Superfície de compatibilidade

Comandos a preservar ou oferecer com alias/migração documentada:

- `init`/`setup`, `clean`, `doctor`;
- `run`/`loop`, `once`, `parallel`;
- `status`, `events`, `logs tail`, `report last`;
- `checkpoint`/`checkpoints`, `context`;
- `tasks list|next|done|sync`;
- `config list|get|set`;
- `adapters`, `recipes`, `rules`;
- `install`, `update`, `lang`, `ui`, `about`, `version`, `help`.

Flags relevantes do run atual entram na matriz, incluindo PRD/engine/model, loop/wiggum, force/fail-fast/retries/delay/max iterations/parallel/retry failed, tokens/temperature, tests/lint/gates/fast/no-commit, security/sandbox/dry-run/debug/verbose, branch/PR/rollback, context/gutter/no-change/UI e passthrough.

Nem todo comportamento precisa manter implementação idêntica. Mudança deliberada possui:

- classificação compatible, deprecated, changed ou removed;
- rationale;
- mensagem/alias temporário;
- comando de migração;
- versão de remoção.

Essa classificação descreve a decisão de produto e não serve para esconder falhas. Cada cenário também possui assessment fechado `pass` ou `regression`, calculado a partir de invariantes registrados. Assim, por exemplo, um comportamento decidido como `changed` continua `changed` mesmo quando sua implementação atual recebe assessment `regression`.

## Harness black-box

Fixtures temporárias executam Ralph antigo e `ralph` com engines fake, capturando:

- help/exit code/stdout/stderr;
- arquivos `.ralph` criados;
- seleção e marker de task;
- no-change/retry/fail-fast;
- skip tests/gates;
- status/events/report;
- sinais/Ctrl+C quando automatizável;
- comportamento Windows e paths com espaço.

Snapshots ignoram timestamps/IDs variáveis, mas não escondem diferenças sem classificação. O harness jamais escreve no checkout real do Ralph antigo.

O baseline versionado exige comparação legacy-vs-next, standalone nativo fresco, metadata/schema válidos, hash do artefato, fingerprint do source e execução real. `--next-source` e `--without-legacy` existem apenas para testes não versionados junto de `--no-write`. O relatório inclui sempre os seis targets iniciais e distingue `tested` (binário atual validado e realmente executado no host), `built-not-tested` (artefato/hash frescos, sem execução nativa) e `not-evidenced`.

### Coordenador integral S10

O fechamento operacional não sobregrava o baseline S01. `scripts/s10-compatibility.ts` produz o
relatório aditivo `docs/compatibility/s10-report.{json,md}` e exige sempre dois arquivos regulares
explícitos:

```text
bun run compat:s10 --legacy-binary <arquivo-v1> --next-binary <standalone-v2-fresco>
```

Não há fallback para PATH, environment, source entry ou artefato default. O next precisa passar a
metadata do standalone, o hash do artefato e o fingerprint do source atual. O coordenador captura
hash/version/help reais, executa S01 e S03, smoke operacional human/JSON, aliases, coexistência e
`migrate inspect|apply|rollback`. Para skips/fast/no-change/retry/fail-fast, parallel/Git/security e
sinal/resume, ele executa suites focadas e registra hash dos testes, exit/stdout/stderr e timeout;
uma simples referência ao source não conta como evidência.

Todos os filhos usam env allowlist, HOME/AppData/TEMP/config isolados e `windowsHide`. Os workspaces
S10 contêm espaço e Unicode. Falha preserva a raiz temporária para diagnóstico; sucesso a remove. A
classificação `compatible|changed|deprecated|removed` é independente do assessment
`pass|regression`: uma divergência deliberadamente `changed` ainda é regression quando a prova
executável falha.

O inventário fechado está em `scripts/s10-compatibility-contract.ts`. Ele contém cada spelling de
comando/subcomando/alias e cada flag aceita pelo parser Go auditado, inclusive opções não anunciadas
no help. O harness sonda cada flag contra o binário v1 real.

## Migração de PRD

- v1 roda em compatibility mode;
- `ralph prd validate` diagnostica sem alterar;
- `prd migrate` grava outro arquivo por default;
- campos inferidos são marcados com warning/TODO humano;
- nenhum critério é inventado para preencher schema;
- tasks fracas recebem recomendação de passar pela skill futura;
- backup/hash e relatório permitem comparar markers/dependencies.

## Migração de configuração e state

`ralph migrate inspect` lê `.ralph` antigo read-only e produz plano:

- opções mapeadas diretamente;
- opções renomeadas;
- engines/adapters externos convertíveis;
- secrets que devem virar credential refs;
- estado/heartbeat/checkpoints recuperáveis;
- itens não suportados.

`migrate apply`:

1. exige destino v2 separado/backup;
2. nunca sobrescreve secret ou config silenciosamente;
3. gera config versionada e report;
4. valida antes de commit;
5. não converte run ativo antigo em run v2 ativo sem adapter explícito;
6. permite rollback removendo apenas arquivos v2 que criou e confirmou.

O caminho normal é concluir/interromper seguramente a run antiga e iniciar v2 na primeira task não concluída conforme markers validados.

O contrato implementado na S10 usa sempre outra raiz não aninhada, produz
`.ralph/migration/<id>/{report.json,rollback-manifest.json}` e preserva o config vazio gerado como
backup. PRD/config/state são re-hasheados antes da primeira escrita. Um state ativo é apenas
reportado; o handoff emitido usa `--new-run` e `PRD.migrated.md`. Ver
`docs/22-migracao-ralph-v1-s10.md`.

`migrate rollback <manifest> --dry-run` valida e calcula um plano determinístico sem mutação; a
remoção posterior exige `--confirm-plan-hash` com o hash exato. O comando não consulta a origem e
remove somente arquivos criados que ainda correspondam ao manifest estrito, seguido apenas por
diretórios vazios. Traversal, links, duplicatas, ausência ou divergência de hash são recusados; um
arquivo não relacionado no destino é preservado e impede naturalmente a remoção do diretório.

## Compatibilidade de adapters/recipes

Adapters CLI e recipes antigas passam por importer que preserva comando, args, env refs e output parser somente quando seguro. Scripts arbitrários continuam opt-in. Plugins v2 têm manifest/schema/capabilities próprios; não carregam código antigo automaticamente.

## Distribuição

Plataformas alvo iniciais, se confirmadas no kickoff:

- Windows x64/arm64 relevante;
- Linux x64/arm64;
- macOS x64/arm64.

Esses seis targets formam o universo declarado, não uma promessa implícita de suporte. Cada
manifest exige uma `ReleaseSupportPolicy` v1 específica de versão e canal, com as seis entradas em
ordem canônica. Cada entrada é `included` ou `not-promoted`; a segunda exige motivo humano. O estado
`included` autoriza apenas compor um artifact e nunca equivale sozinho a `tested`, suportado ou
promovido. A policy também registra a capability real de durabilidade do controle de instalação:
Windows permanece `unsupported-file-sync-only/reduced` enquanto não existir outra primitive
implementada e provada. Em `stable`, somente targets `included` com garantia `full` podem atravessar
os demais gates. Quais targets entram em cada canal continua sendo decisão explícita de release, não
default do packager.

Artefatos:

- standalone executable gerado pelo Bun quando estável para a plataforma;
- pacote npm para instalação global/controlada;
- checksums e SBOM;
- archive com LICENSE/THIRD_PARTY_NOTICES;
- assinatura/proveniência de release quando infraestrutura permitir.

Commands `install`/`update` distinguem instalação por npm, standalone e dev checkout. O fluxo
standalone usa staging versionado, manifest e payloads limitados, checksums, verificação opcional de
assinatura por uma trust policy local, launcher preservado durante update, pointer/receipt atômicos e
rollback. `update --check` executa o mesmo preflight sem ativar a versão. Origens npm e dev checkout
continuam sob autoridade do package manager/Git e falham com diagnóstico explícito quando alguém
tenta tratá-las como standalone. Update nunca substitui o engine em execução. `doctor` verifica
runtime quando necessário, keychain, Git, sandbox, TTY, auth refs e schema state.

## Localização

CLI determinístico (command/flag/config keys/event types) permanece estável em inglês. Mensagens
humanas/TUI suportam os catálogos bundled `pt-BR` e `en` por `lang`; aliases de locale são
normalizados antes da persistência e `lang set` exige escopo explícito. Isso não altera parser
canônico, JSON nem snapshots de runs já persistidos.

## Licenças e OpenCode

O OpenCode auditado usa licença MIT, mas cada refresh deve reconfirmar o arquivo/licença no commit fixado. O repositório contém:

```text
third_party/opencode/LICENSE
third_party/opencode/PROVENANCE.json
third_party/opencode/UPSTREAM.md
third_party/opencode/copied-files.md
third_party/opencode/patches.md
THIRD_PARTY_NOTICES.md
```

`PROVENANCE.json` é a autoridade estruturada: registra URL, commit, versão, licença, hashes, mapa
source/destination, patches e as exceções explícitas de protocolo/branding. `UPSTREAM.md`,
`copied-files.md` e `patches.md` são a projeção legível por humanos e devem permanecer coerentes com
esse manifesto. Atribuição acompanha source/release.

Não copiar:

- marca/logo/nome visual do OpenCode;
- assets não cobertos/verificados;
- código de outro licenciamento sem revisão;
- dependência privada do workspace supondo que seja pacote público.

Dependências transitivas passam por license allow/deny review e lockfile/SBOM. A escolha TypeScript/Bun/Solid/OpenTUI não significa copiar o produto completo.

## Atualizações upstream

Processo:

1. abrir branch `vendor/opencode-<commit>`;
2. comparar snapshot atual com candidato;
3. revisar auth/provider breaking changes e advisories;
4. atualizar mapa/hashes/licenças;
5. portar somente módulos necessários;
6. rodar golden/provider/auth/TUI matrix;
7. registrar decisão e release note;
8. fazer merge somente após review.

Não existe dependência flutuante de `main`/`dev` nem script que copie upstream automaticamente em release.

## Corte do nome final

Para substituir o Ralph atual:

- matriz compatível aprovada;
- PRD v1 e v2 testados;
- resume/watchdog/credential security validados;
- releases cross-platform instaláveis;
- guia de migração e rollback;
- backup do config/state antigo;
- período beta usando `ralph`;
- remoção explícita do binário anterior antes de instalar a v2;
- prova de que `Get-Command ralph -All`/`where.exe ralph` ou `type -a ralph` resolve somente a v2.

## Critérios de aceite

- Antigo e novo podem ser comparados por paths absolutos sem misturar state, mas apenas a v2 fica
  publicada como `ralph` no `PATH` após o corte.
- Cada comando/flag relevante tem decisão de compatibilidade registrada.
- Migração faz inspect/preview e preserva backup.
- Builds têm checksums, licenses/notices e SBOM.
- Código upstream possui commit e arquivo de origem rastreáveis.
- O comando final permanece `ralph` em todas as fases; os gates controlam a substituição da
  instalação, não uma troca de nome.
