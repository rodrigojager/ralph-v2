# 28 — Drills de release, beta e handoff S12

## Estado e finalidade

Este documento é o runbook e a worksheet determinística reutilizável de S12.09–S12.11. A campanha
preenchida do beta `0.1.0-beta.2`, com artifact/ambiente, resultados, logs redigidos e digests exatos,
é gerada fora do commit e anexada ao handoff/release. As linhas abaixo permanecem `pending` de
propósito para que uma campanha futura não herde aprovação do beta anterior por semelhança.

A campanha final executa artifact verification, install/update/rollback/uninstall, migração,
crash/resume e TUI/PTY no target incluído. Smokes reais de provider/API key/OAuth/ChatGPT permanecem
`not-executed` quando não existe credencial opt-in elegível; isso é publicado como limitação. O beta
usa exclusivamente `ralph` e trata a troca da instalação clássica como operação explícita e auditada.

O runbook nunca converte contrato estático em suporte. Cada resultado pertence a um artifact exato,
em um ambiente exato, e precisa de evidence content-addressed. Um resultado de outro commit, hash,
target, conta ou runner não pode ser reaproveitado por semelhança.

## Baseline local anterior aos drills

`EV-S12-DIST-8` é uma prova executada do código de S12.02, não uma linha `D09-*`. O comando
`bun run test:s12:distribution` passou 8/8 testes e 91 asserções em 3,71 s com Bun 1.3.14 no host
Windows x64. Ele usa manifests/payloads temporários `nightly`, versões `*-dev.1`, assinatura
explicitamente indisponível, texto de licença de fixture e limitation de `local contract only`.
Consequentemente, não há signer, licença do produto, provenance, release candidate ou target-support
claim a reaproveitar na campanha.

O baseline exercita local install, HTTPS por transporte fake allowlisted, tamper de tamanho/hash/
metadata, check/update, preservação de launcher/versão anterior, downgrade/schema, rollback,
repair-required honesto, recovery `planned|staged|verified|activated` e uninstall receipt-bound por
scheduler/helper preservando `.ralph`, config, credential ref, Ralph clássico e sentinela externa.
A primeira tentativa sob o TEMP de `C:` foi recusada por `RALPH_INSTALL_ROOT_IS_CHECKOUT` devido ao
marcador host-level `C:\.git`; com `TEMP`, `TMP` e `TMPDIR` em
`D:\Temp\ralph-v2-distribution-tests`, o rerun oculto passou. Log:
`D:\Temp\ralph-v2-distribution-tests\s12-distribution-rerun-hidden-20260719-201340-718-60744.stderr.log`.

As linhas `D09-INSTALL-*`, `D09-TAMPER-*`, `D09-UPDATE-*`, `D09-CRASH-*`,
`D09-ROLLBACK-*`, `D09-DOWNGRADE-*` e `D09-UNINSTALL-*` continuam `pending`: elas exigem o artifact
candidato e os bindings globais desta worksheet. O baseline local só reduz risco de implementação;
não satisfaz a campanha de release.

## Autoridade e estados permitidos

- O release owner escolhe versão, channel, package/owner, licença, support policy, targets,
  signer/verifier e trust policy. Este documento não escolhe nenhum deles.
- O operador executa comandos; modelo, TUI, artifact e texto de handoff não marcam gates.
- Os únicos resultados de caso são `pass`, `fail`, `skip` ou `waiver`. `pending` significa que o
  caso ainda não foi executado.
- `skip` nunca é `pass`. Um `waiver` exige owner, razão, risco aceito e expiração.
- `built-not-tested` e `packaged-not-tested` nunca são suporte de plataforma.
- Diagnostics permanecem locais até uma pessoa revisar e anexar deliberadamente o subconjunto
  redigido a um issue ou evidence store escolhido pelo release owner.

## Binding global da campanha

Preencha uma vez antes do primeiro caso. Mudança em qualquer binding abre uma campanha nova.

```text
Campaign ID:
Version:
Channel:
Commit (40 hex):
Source fingerprint:
Release manifest SHA-256:
Standalone archive SHA-256 by target:
npm tarball SHA-256:
Support policy schema/SHA-256:
Promotion record SHA-256/status:
Signature envelope SHA-256/status:
Verifier policy SHA-256:
Workspace schema range:
Launcher schema range:
Started at:
Release owner:
Evidence root:
```

Não use `latest`, nome de arquivo ou versão como substituto do SHA-256. O evidence root deve ficar
fora do install root e não deve conter credenciais, tokens, query strings ou output bruto não
revisado.

## Registro obrigatório por caso

Copie esta worksheet para cada caso. A linha só pode mudar de `pending` depois da execução real.

```text
Case ID:
Requirement IDs:
Status: pending
Artifact/manifest SHA-256:
OS/architecture:
Host/runner/isolation:
Bun/package-manager versions:
Terminal/PTY:
Provider/model/auth method/account scope/quota class:
Preconditions:
Exact command or harness ID:
Expected result:
Observed exit/status:
Observed result summary:
Evidence refs (SHA-256 + media type + path/URL):
Diagnostics refs (redacted):
Known limitation created/updated:
Waiver owner/rationale/expiry:
Executed at:
Operator:
Reviewer:
```

Campos não aplicáveis recebem `not-applicable` com motivo; não ficam vazios. Comando deve registrar
argv sem valores secretos. Variáveis podem ser citadas por nome, nunca por valor.

## Matriz S12.09

Cada target `included` recebe suas próprias linhas. Casos reais de auth são opt-in e pertencem ao
ambiente/conta registrados, não ao target inteiro por inferência.

| Case ID | Resultado a provar | Comando/harness base | Estado inicial |
| --- | --- | --- | --- |
| `D09-ARTIFACT-01` | checksums, manifest, SBOM, licença, notices, skill e assinatura/policy coerentes | verificador do artifact exato e `update --check` | `pending` |
| `D09-INSTALL-01` | instalação limpa por manifest local | `ralph install <ROOT> --manifest <MANIFEST> --channel <CHANNEL>` | `pending` |
| `D09-INSTALL-02` | instalação limpa por origem HTTPS allowlisted | mesmo comando com URL HTTPS sem credencial/query | `pending` |
| `D09-TAMPER-01` | tamanho/hash/metadata adulterado é recusado sem ativação | harness de cópia adulterada content-addressed | `pending` |
| `D09-UPDATE-01` | update preserva launcher/engine em uso e troca apenas o pointer autorizado | `ralph update --install-root <ROOT> --manifest <MANIFEST>` | `pending` |
| `D09-CRASH-01` | recovery em `planned` | fault-injection do artifact exato | `pending` |
| `D09-CRASH-02` | recovery em `staged` | fault-injection do artifact exato | `pending` |
| `D09-CRASH-03` | recovery em `verified` | fault-injection do artifact exato | `pending` |
| `D09-CRASH-04` | recovery em `activated` | fault-injection do artifact exato | `pending` |
| `D09-ROLLBACK-01` | rollback para versão receipt-bound | `ralph rollback --install-root <ROOT> --dry-run`, depois aplicação explícita | `pending` |
| `D09-DOWNGRADE-01` | downgrade/schema incompatível é recusado | update com candidato incompatível controlado | `pending` |
| `D09-MIGRATE-01` | inspect v1 é read-only | `ralph migrate inspect <V1>` | `pending` |
| `D09-MIGRATE-02` | apply cria destino v2 separado, backup, report e rollback manifest | `ralph migrate apply <V1> --destination <V2>` | `pending` |
| `D09-MIGRATE-03` | rollback do destino migrado segue somente o manifest e preserva v1 | `scripts/s10-migration-coexistence-drill.ps1 -LegacyBinary <V1> -NextBinary <V2>` executa preview/hash/apply lado a lado | `pending` |
| `D09-RESUME-01` | primeira task não finalizada é retomada após migração/crash | comando de handoff emitido pelo migrador | `pending` |
| `D09-AUTH-01` | API/environment credential real opt-in sem segredo em argv/log | `model smoke --profile <PROFILE>` com receipt de conta/quota | `pending` |
| `D09-AUTH-02` | ChatGPT browser/device/refresh real opt-in quando elegível | `auth connect openai --method <METHOD>` e smoke separado | `pending` |
| `D09-TUI-01` | TUI runtime em PTY real mostra status, barra, usage, logs, output e judge | run do sample + `attach <RUN_ID>` | `pending` |
| `D09-TUI-02` | resize, close/reattach e replay preservam o mesmo ledger | harness PTY ligado ao mesmo run | `pending` |
| `D09-CLASSIC-01` | instalação clássica é inventariada e removida explicitamente antes da v2 | procedimento de substituição abaixo | `pending` |
| `D09-NAME-01` | package, launcher e standalone expõem somente `ralph` | inspeção de artifacts e `ralph version` | `pending` |
| `D09-NAME-02` | resolução do comando aponta somente para a v2 após o corte | `Get-Command`/`where.exe` ou `type -a` | `pending` |
| `D09-UNINSTALL-01` | uninstall remove apenas paths owned e preserva workspace/config/credentials/clássico | `ralph uninstall <ROOT> --dry-run`, depois aplicação explícita | `pending` |
| `D09-WINDOWS-01` | binary em uso, paths com espaços/Unicode e garantia reduzida são honestos | host Windows do target exato | `pending` |

Além dessas linhas, R001–R079 continua sendo a matriz normativa. Esta tabela organiza o drill de
release e não substitui nenhuma requirement ou attestation de S11.

## Protocolo de substituição do comando `ralph`

Não existe alias ou nome temporário para a v2. Antes do corte, execute a versão clássica e a v2 apenas
por paths absolutos. No Windows, registre `Get-Command ralph -All` e `where.exe ralph`; no POSIX,
registre `type -a ralph`. Para cada aplicação, capture path, versão, tamanho e SHA-256.

Remova a instalação clássica somente pelo mecanismo que a criou, com alvo exato. Não apague por glob,
não remova workspaces `.ralph` e não trate um package com nome semelhante como a mesma instalação sem
confirmar seu binário. Instale então a v2 e repita a inspeção. O gate falha se a primeira resolução não
for o artifact v2 esperado ou se uma segunda resolução antiga puder sombreá-lo.

## Backup e rollback para o Ralph clássico

Este procedimento não altera o checkout clássico e não usa glob ou remoção recursiva.

1. Antes do beta, preserve o `PATH` original e identifique os arquivos de profile/configuração que
   definem sua precedência ou comandos de shell. Resolva todas as ocorrências de `ralph` (`Get-Command
   ralph -All` e `where.exe ralph` no Windows; `type -a ralph` no POSIX) e registre, para cada uma,
   `CommandType`, origem/definição e path resolvido quando houver.
2. Trate `Alias` e `Function` separadamente de `Application`: registre a definição e o profile que a
   criou, depois resolva e inventarie a `Application` subjacente por path absoluto. Alias/função não é
   binário e não recebe tamanho ou SHA-256 como se fosse arquivo. Para a aplicação clássica escolhida,
   registre path absoluto, versão, tamanho e SHA-256.
3. Confirme que o path da aplicação fica fora do install root v2. Se estiver dentro, interrompa o
   corte: a identidade é ambígua.
4. Escolha um diretório de backup explícito fora do install root, workspace e checkout. Copie apenas
   o binário/launcher clássico resolvido e os arquivos v1 enumerados pelo operador; grave inventário
   com path de origem, path de backup, tamanho e SHA-256. Não apague nem mova o original.
5. Registre separadamente cada `.ralph` v1 e configuração que precisa de backup. A presença do nome
   `.ralph` não autoriza misturar ou converter state.
6. Durante a validação execute ambos somente por paths absolutos; não publique dois comandos no
   `PATH` com nomes diferentes.
7. Para voltar, desinstale a v2 pelo mecanismo que a instalou e restaure a instalação clássica a
   partir do mecanismo/backup registrado. Restaure `PATH` e profiles somente quando fizerem parte do
   inventário explícito.
8. Execute o clássico pelo path absoluto registrado e compare versão/hash com o inventário. Não use
   apenas o primeiro resultado de `PATH` como prova.
9. Se a origem de um `ralph` for ambígua, não faça delete manual automático. Preserve os bytes e abra
   incidente; ownership fail-closed é preferível a remover um executável desconhecido.

Rollback da engine v2, rollback de workspace/checkpoint, rollback de migração e retorno ao Ralph
clássico são quatro operações diferentes. Cada uma recebe case ID e evidence próprios.

## Diagnostics locais e não invasivos durante beta

Não existe autorização implícita para upload, background telemetry ou coleta de outro projeto. A
coleta é iniciada pelo participante e limitada ao run/workspace escolhido.

Receita mínima, sempre com output redigido revisado antes de compartilhar:

```text
ralph doctor --workspace <WORKSPACE> --format json
ralph status run --run-id <RUN_ID> --workspace <WORKSPACE> --format json
ralph events --run-id <RUN_ID> --workspace <WORKSPACE> --format jsonl
ralph logs tail --run-id <RUN_ID> --workspace <WORKSPACE> --source diagnostic --format jsonl
ralph report show <RUN_ID> --workspace <WORKSPACE> --format json
```

Política da campanha:

- coletar somente IDs, timestamps, versão, commit/artifact hash, ambiente, diagnostics redigidos,
  eventos normalizados e report necessário para reproduzir o problema;
- excluir credential values, environment values, prompts privados, source não necessário,
  chain-of-thought, raw-engine não revisado, query strings e paths pessoais quando não essenciais;
- raw persistence permanece opt-in e bounded; desabilitá-la não pode bloquear o beta;
- o participante revisa o bundle antes do envio e escolhe explicitamente o issue/evidence destino;
- o beta owner define retention e data de exclusão antes da entrada da campanha. Ausência desses
  valores mantém o Gate I aberto;
- um pedido de exclusão remove somente a cópia recebida pelo beta, sem alterar evidence obrigatório
  de release sem decisão auditada do owner;
- cada issue usa um ID estável, severidade, artifact hash, case ID, repro, estado, owner, decisão e
  link content-addressed. Secrets descobertos seguem o procedimento de incidente, não o issue comum.

Template de triagem:

```text
Beta issue ID:
Severity: P0|P1|P2|P3
Campaign/case ID:
Artifact SHA-256:
Environment:
Minimal reproduction:
Expected/observed:
Redacted evidence refs:
Security/privacy impact:
Owner/status:
Decision: fix|duplicate|not-reproducible|waiver
Waiver rationale/expiry:
Retain until/delete at:
Reviewer/date:
```

## Gate de entrada do beta

Todos os itens abaixo precisam de valor observado ou decisão explícita:

- identidade, licença, repository, channel e support policy do candidato definidos;
- artifact beta imutável, checksums/SBOM/notices/license e source binding disponíveis;
- targets `included` e limitações públicas declarados sem alegar `tested` antes do runtime;
- install/rollback/uninstall mínimo do primeiro target incluído executado e revisado;
- coleta local, redaction, retention, issue owner e canal de incidente definidos;
- Ralph clássico inventariado e backup delimitado confirmado;
- artifacts expõem somente o comando `ralph`, sem nome de transição;
- lista de known issues inicial publicada e nenhum P0 conhecido aberto.

## Gate de saída do beta e checklist de corte

Duração, tamanho da coorte e targets são inputs do proprietário e devem ser escritos no handoff; o
repositório não inventa defaults. A saída exige:

- janela/coorte planejadas encerradas e campanhas vinculadas aos artifacts exatos;
- todos os casos obrigatórios dos targets incluídos com `pass` ou waiver ainda válido;
- P0 e P1 fechados; P2/P3 publicados ou com owner/decisão; nenhuma ausência vira sucesso;
- diagnostics triados segundo a política local, retention aplicada e incidentes de segredo fechados;
- R001–R079, skill forward test, auth opt-in aplicável, TUI runtime, migration/rollback e retorno ao
  clássico anexados;
- comandos de instalação, uso, diagnóstico, rollback e desinstalação revisados no artifact;
- handoff S01–S12 completo, support policy e configurable decisions congelados;
- backup clássico verificado, mecanismo de remoção identificado e plano de rollback revisado;
- aprovação explícita do release owner/reviewer para substituir a instalação clássica pelo novo
  `ralph`.

## Handoff da campanha

O resultado consolidado vai para
[26 — Release gates e handoff S12](26-release-gates-e-handoff-s12.md). Anexe esta worksheet
preenchida, known issues, waivers e todos os evidence refs. Campos ausentes permanecem `pending` ou
`unavailable`; não compacte múltiplos targets, contas ou artifacts numa única alegação genérica.
