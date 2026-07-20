# 26 — Release gates e handoff S12

## Finalidade

Este é o contrato reutilizável de promoção. Ele não converte implementação ou validação local em
release e não deve ser preenchido com “pass” sem artifact/prova correspondente. A campanha preenchida
do beta `0.1.0-beta.2` é gerada fora do commit e anexada ao release com hashes exatos; isso evita que
o documento tente incluir o hash do commit que o contém.

Evidência local disponível no checkout de desenvolvimento: Bun `1.3.14`; 60 schemas gerados e
conferidos; lint/typecheck verdes; gate 673/673; integração 149/149; watchdog 8/8; smoke PTY 3/3 e
matriz Windows ConPTY S08.12 5/5 (34 verificações); build/smoke Windows x64 verdes;
`EV-S12-DIST-8` 8/8 com 91 asserções; sample S12.08 focado 1/1 com 59 asserções. O contrato de
fechamento estrutural/local de S11.12 cataloga essas provas. O archive final, candidate binding,
waivers beta e handoff content-addressed permanecem autoridades externas; nenhuma linha deste
template preenche automaticamente os gates abaixo.

## Gate A — identidade e licença própria

- [x] nome final do package escolhido pelo proprietário: `ralph-next`;
- [x] licença própria escolhida e registrada em `package.json`: MIT;
- [x] `LICENSE` própria presente;
- [x] owner/repository de publicação confirmado;
- [x] namespace público dos JSON Schemas confirmado em
  `https://rodrigojager.github.io/ralph-v2/schemas/v2/`;
- [x] channel inicial confirmado: `beta`;
- [x] policy de suporte v1 preenchida com as seis entries `included`/`not-promoted` e motivos;
- [x] a policy derivada de `examples/release-support-policy.template.json` deixou de ser placeholder, possui a
  versão/channel do candidato e contém ao menos uma decisão explícita `included`;
- [x] política de assinatura/provenance confirmada para o beta: indisponibilidade explícita, sem
  alegação de assinatura ou confiança; `stable` continua proibido sem signer e trust policy reais.

A identidade aprovada usa `https://github.com/rodrigojager/ralph-v2` e versão `0.1.0-beta.2`. O
origin público, a configuração Pages por workflow e o fetch HTTP 200 de um schema v2 publicado foram
observados em 2026-07-20. A policy específica está em
`release/support-policy-0.1.0-beta.2.json`: inclui somente `bun-windows-x64-baseline`; mantém os
outros cinco targets visíveis e não promovidos, inclusive a limitação OpenTUI de Windows ARM64. O
snapshot OpenCode conserva sua atribuição MIT separada; a MIT própria da raiz não substitui notices
de terceiros. O beta usará `--signature-unavailable-reason` porque nenhum signer/trust root foi
configurado; isso é disclosure de ausência, não provenance criptográfica.

## Gate B — source e provenance

- [x] checkout versionado em commit completo de 40 caracteres;
- [ ] source fingerprint confere com todos os build metadata;
- [x] positive inventory OpenCode revisada;
- [x] licenças OpenCode/OpenTUI/SolidJS presentes;
- [ ] lockfile fixo e SBOM sem componente sem licença;
- [ ] `third_party/licenses/manifest.json` contém textos e SHA-256 de todo componente runtime exato;
- [ ] variantes peer de um mesmo nome/versão possuem inventário de licença idêntico;
- [ ] curação Bun local corresponde à versão/revisão exata de todos os standalone engine/launchers;
- [x] `CURATION.json` do Bun declara escopo completo, licença/copying, provenance e nenhum arquivo
  extra ou ausente;
- [ ] cada workspace runtime alcançável é idêntico no `package.json` e no `bun.lock`;
- [ ] `THIRD_PARTY_NOTICES.md` dentro do artifact;
- [x] ausência de agent/session runner, branding e private packages confirmada.

As entradas conhecidas do launcher e da dependência CLI→TUI estão no lockfile, e `bun install
--frozen-lockfile` passou com Bun `1.3.14` no checkout local. O gerador de SBOM continua comparando
cada workspace alcançável com seu `package.json` e recusa qualquer divergência restante em vez de
omitir componentes. O gate ainda exige repetir esse vínculo no checkout/commit do candidato.

Metadata de licença no SBOM não fecha este gate sozinha. O packager deriva o inventário do SBOM
serializado, exige textos reais no Bun store e grava hashes no artifact. Para standalone, também
exige a curação offline em `third_party/bun/runtime/<version>/<revision>/CURATION.json`. A árvore
exata do Bun `1.3.14`/`0d9b296af33f2b851fcbf4df3e9ec89751734ba4` foi materializada a partir da
fonte oficial com licença, provenance e receipts; os contratos de tamper/arquivo extra/ausente/
symlink/revision passaram na seleção focada. O vínculo com todos os engines/launchers e o inventário
final do candidato continuam pendentes até package e matriz reais. O packager permanece offline e
fail-closed.

## Gate C — build por target

O build/smoke Windows x64 do checkout de desenvolvimento passou, mas a tabela abaixo exige o
candidato exato, seus hashes/metadata e runtime host registrado. Por isso a linha de release continua
pendente até esse binding existir.

| Target | Build metadata | Launcher metadata | Engine SHA-256 | Launcher SHA-256 | Evidence | Runtime host |
| --- | --- | --- | --- | --- | --- | --- |
| `bun-windows-x64-baseline` | pendente | pendente | pendente | pendente | not-evidenced | pendente |
| `bun-windows-arm64` | pendente | pendente | pendente | pendente | not-evidenced | pendente |
| `bun-linux-x64-baseline` | pendente | pendente | pendente | pendente | not-evidenced | pendente |
| `bun-linux-arm64` | pendente | pendente | pendente | pendente | not-evidenced | pendente |
| `bun-darwin-x64` | pendente | pendente | pendente | pendente | not-evidenced | pendente |
| `bun-darwin-arm64` | pendente | pendente | pendente | pendente | not-evidenced | pendente |

Compilar produz no máximo `built-not-tested`. Somente execução no host declarado com o artifact
exato permite `tested`.

Esta tabela sempre mantém os seis targets visíveis. O gate de release deve anexar também a
`ReleaseSupportPolicy` v1 específica de versão/channel: `included` autoriza apenas composição e não
é sinônimo de suporte; `not-promoted` exige motivo. Não preencher uma linha não é uma forma válida
de excluí-la. Para entry `not-promoted`, as células de artifact/evidence devem registrar
`not-applicable-by-policy`, policy hash e motivo — nunca `pass`, `tested` ou omissão. Apenas entries
`included` exigem hashes de artifact naquele candidato.

## Gate D — standalone

Depois de licença, build e evidência autorizados, o packager é invocado com dados explícitos:

```text
bun run package:release -- --channel beta --source-repository <HTTPS_REPOSITORY> --source-commit <40_HEX> --published-at <ISO_8601> --support-policy <SUPPORT_POLICY_JSON> --signature-unavailable-reason <MOTIVO_EXPLICITO> --target <TARGET_INCLUDED> [--target <OUTRO_TARGET_INCLUDED>]
```

Esse é o caminho de indisponibilidade explícita para `nightly`/`beta` (e para `dev`, que não é canal
de artifact assinado). Para assinar `nightly` ou `beta`, substitua somente a opção de assinatura:

```text
bun run package:release -- --channel beta --source-repository <HTTPS_REPOSITORY> --source-commit <40_HEX> --published-at <ISO_8601> --support-policy <SUPPORT_POLICY_JSON> --signature-config <SIGNER_CONFIG_JSON> --target <TARGET_INCLUDED> [--target <OUTRO_TARGET_INCLUDED>]
```

Na passagem final, `stable` exige ainda `--promotion-record <PROMOTION_RECORD_JSON>`.
`--signature-config` e `--signature-unavailable-reason` são mutuamente exclusivos e exatamente um
deles é obrigatório; o segundo nunca é aceito para `stable`. A única exceção é a primeira passagem
`stable --candidate-only` descrita abaixo: nela ambas as opções de assinatura e a promoção são
proibidas.

Antes de ler a support policy ou compor artifacts, o standalone vincula o channel à versão raiz:
`dev` requer prerelease `dev`; `nightly` aceita `nightly` ou `dev`; `beta` requer `beta`; `stable`
requer ausência de prerelease. A versão raiz atual `0.1.0-beta.2` satisfaz somente o canal `beta`;
qualquer tentativa `dev`, `nightly` ou `stable` falha fechada antes de compor artifacts.

`--support-policy` é sempre obrigatório. O arquivo schema v1 contém as seis entries em ordem
canônica e seu subconjunto `included` precisa ser exatamente igual aos `--target`; `--all` somente
serve quando todas as seis estão `included`. Windows continua declarando capability
`unsupported-file-sync-only/reduced` e, por isso, não pode ser `included` em `stable` nesta versão.
Isso não decide que Windows será excluído: o proprietário ainda precisa fornecer o status/motivo;
o mecanismo apenas recusa mentir sobre a primitive ou ocultar a linha.

O signer config não escolhe ferramenta ou material de chave pelo projeto. É JSON estrito no formato:

```json
{
  "schemaVersion": 1,
  "protocol": "ralph-release-signature-signer-v1",
  "executable": "<EXECUTAVEL_CONFIADO>",
  "arguments": ["<ARGUMENTO_FIXO_DO_ADAPTER>"],
  "timeoutMilliseconds": 60000,
  "forwardEnvironment": ["<NOME_DE_VARIAVEL>"],
  "signature": {
    "kind": "<KIND_SUPORTADO_PELO_MANIFEST>",
    "identity": "<IDENTIDADE_ALEGADA>",
    "mediaType": "<TIPO_DO_ENVELOPE>",
    "maximumSizeBytes": 1048576
  }
}
```

O gate deve registrar hash/reviewer desse config sem copiar valores de ambiente. O protocolo usa
argv exato sem shell, temp privado, árvore supervisionada e arquivos request/result/output bounded;
stdout/stderr não são evidência. O result v1 vincula kind, identity, hash do manifest canônico,
SHA-256 e tamanho do envelope, todos recalculados pelo packager. Signer bem-sucedido não aprova a
própria identidade: verifier e trust policy independentes continuam obrigatórios no consumo.

Para distribuição remota, acrescente uma base HTTPS sem credencial/query. O output contém manifest,
engine, launcher, metadata de ambos, tar por target, `SHA256SUMS`, `SBOM.cdx.json`, LICENSE, notices
e a skill. O script:

- recusa a passagem final `stable` sem promotion record v3;
- recusa a passagem final `stable` sem assinatura presente e recusa opções de assinatura ambíguas;
- recusa output existente;
- recusa metadata stale ou target/fingerprint/hash divergente;
- recusa symlink e arquivo fora do staging;
- enumera dependências runtime do lockfile e falha sem license metadata;
- materializa textos de licença/notice de cada componente npm exato e um manifest vinculado ao
  SHA-256 do SBOM;
- exige que todos os targets usem a mesma dupla Bun version/revision e que exista a curação local
  completa dessa dupla; não baixa nem sintetiza textos;
- produz tar ustar ordenado com timestamps controlados;
- rotula canais não-stable sem promotion record como `packaged-not-tested`, a primeira passagem
  stable como `candidate-only` e a final como `packaged-tested` somente depois de validar um record
  que vincula todos os artifacts exatos;
- grava a matriz completa e `supportPolicySha256` no manifest schema v2;
- exige que promotion record schema v3 vincule o mesmo hash, cubra R001–R079 e use somente os
  targets `included`;

O envelope destacado é gerado depois de `SHA256SUMS`, pois incluir seu próprio hash na projeção
assinada criaria um ciclo. O manifest autentica kind/identity/descritor e o hash canônico; o
installer calcula tamanho/SHA-256 do envelope staged, passa snapshot privado ao verifier v1 e exige
que o result devolva kind, identidade/issuer, `signedManifestSha256` e `signatureSha256` coerentes.

### Operação standalone `stable` em duas passagens

O `ReleasePromotionRecord` precisa vincular os hashes dos support files, do artifact da skill e de
cada engine, launcher, metadata e archive por target. Esses bytes ainda não existem antes do primeiro
empacotamento. A passagem de candidato resolve o ciclo sem produzir um `ReleaseManifest` que pareça
aprovado.

Primeira passagem, explicitamente não publicável:

```text
bun run package:release -- --channel stable --source-repository <HTTPS_REPOSITORY> --source-commit <40_HEX> --published-at <ISO_8601_FIXO_MAIS_DE_5_MIN_NO_FUTURO> --support-policy <SUPPORT_POLICY_JSON> --target <TARGET_INCLUDED> [--target <OUTRO_TARGET_INCLUDED>] --candidate-only
```

`--candidate-only` só aceita `stable` e é incompatível com `--promotion-record`,
`--signature-config` e `--signature-unavailable-reason`. O output ganha o sufixo `-candidate` mesmo
quando `--output` é explícito. Ele contém support files, skill tar, engine/launcher/metadata e tar por
target, `SHA256SUMS`, `release-candidate-receipt.json` e `package-result.json`; os dois últimos
registram `publishable: false`. Não são criados `release-manifest.json`, diretório `promotion/` nem
`signatures/`. O receipt contém uma projeção `promotionCandidate` diretamente utilizável para montar
o record v3: versão/channel/source, support binding, policy completa/hash, hashes dos cinco artifacts
por target e `publishedAt`.

Depois de executar os gates sobre os hashes exatos, repita todos os inputs que influenciam bytes —
inclusive policy, targets, compatibilidade, source e `publishedAt` —, remova `--candidate-only` e
acrescente record e signer:

```text
bun run package:release -- --channel stable --source-repository <MESMO_HTTPS_REPOSITORY> --source-commit <MESMO_40_HEX> --published-at <MESMO_ISO_8601_FIXO> --support-policy <MESMO_SUPPORT_POLICY_JSON> --target <MESMO_TARGET_INCLUDED> [--target <MESMO_OUTRO_TARGET_INCLUDED>] --promotion-record <RELEASE_PROMOTION_RECORD_JSON_DO_CANDIDATO> --signature-config <SIGNER_CONFIG_JSON>
```

Na primeira passagem, `publishedAt` precisa continuar mais de cinco minutos no futuro no instante do
commit do candidato. A final só aceita o instante entre cinco minutos e um segundo no futuro, lê o
promotion record como arquivo bounded/regular de identidade estável e repete sua validação com relógio
novo depois do signer, imediatamente antes do rename. Se a janela for perdida, gere novo candidato e
novas evidências; não edite timestamp, hash ou record por inferência.

Com inputs e `publishedAt` iguais, o skill tar e todos os tar por target são byte-idênticos entre as
duas passagens; o manifest, record, assinatura, checksums externos e receipts de fluxo podem diferir.
Compare os hashes dos archives antes de qualquer publicação. Esses arquivos de candidato são bytes
tecnicamente copiáveis/distribuíveis por um operador que ignore os sidecars: `candidate-only` é
enforcement do fluxo Ralph, não DRM. Também permanece uma janela local mínima entre a última
verificação e o `rename` na qual um mutador com a mesma autoridade do processo poderia agir; staging,
receipts e revalidações reduzem e detectam substituições, mas não isolam principals equivalentes.

## Gate E — npm

O nome de package não é inferido:

```text
bun run package:npm -- --package-name <NOME_NPM_ESCOLHIDO> --channel <dev|nightly|beta|stable> --dist-tag <dev|nightly|beta|latest> --source-repository <HTTPS_REPOSITORY> --source-commit <40_HEX> --published-at <ISO_8601> [--promotion-record <NPM_PROMOTION_JSON> --release-candidate-receipt <STANDALONE_RELEASE_CANDIDATE_RECEIPT>] (--signature-config <SIGNER_CONFIG_JSON> | --signature-unavailable-reason <MOTIVO>)
```

Os dois flags não são livres nem opcionais: `dev -> dev`, `nightly -> nightly`, `beta -> beta` e
`stable -> latest`. A versão raiz também precisa corresponder semanticamente ao canal: prerelease
`dev` para `dev`, `nightly` ou `dev` para `nightly`, `beta` para `beta` e nenhum prerelease para
`stable`. O primeiro identificador precisa ser exato; `beta2`, por exemplo, não equivale a
`beta.2`. O packager falha antes de compor o payload quando qualquer binding diverge.

O tarball usa `package/`, bin `ralph-next`, bundle, documentação e samples autocontidos referenciados
pelo README (`docs/`, `examples/`, `implementation/`, `skill-contract/`, `AGENTS.md`,
`DEVELOPMENT.md` e `PRD.md`), schemas,
skill, SBOM, provenance, hashes, licença e notices. O package exige Bun; npm/pnpm são canais de
instalação, não runtimes alternativos. Gerar
o `.tgz` não publica. O gzip usa DEFLATE stored blocks, MTIME zero e OS neutro para não depender do
zlib/ICU do host; o custo deliberado é um tarball maior. Publicação e instalação limpa são gates
separados. O `package.json` gerado fixa `publishConfig.tag`, e `PROVENANCE.json`,
`package-result.json`, `npm-release-binding.json` e a saída JSON registram channel/dist-tag. O
`PROVENANCE.json` interno sempre rotula os bytes como `candidate-only` e exige um binding externo
válido; assim a primeira e a segunda passagem preservam o mesmo tarball. A etapa de publicação deve
usar o mesmo tag explícito (`npm publish <TARBALL> --tag <DIST_TAG>`); ela nunca deve depender do
default implícito `latest`.

`third_party/licenses/` no tarball npm é materializado da mesma fonte SBOM e contém todo o grafo npm
runtime com receipts de texto. A curação do binário Bun não entra nesse artifact porque o tarball
npm não distribui o runtime: ele exige um Bun compatível já instalado no host. Essa separação não
autoriza omitir qualquer dependência npm nem alegar que o runtime externo foi licenciado pelo
tarball.

Antes de copiar `schemas/`, ambos os packagers recompõem em memória o catálogo único do gerador e
exigem os 60 nomes e conteúdos exatos. Ausência, arquivo extra ou conteúdo stale bloqueia packaging;
nenhum packager executa geração implícita. Materialização continua sendo uma etapa anterior.

No ciclo local atual, o gerador materializou os 60 schemas e `schemas:check` confirmou nomes e
conteúdos contra a fonte. Nenhum JSON Schema deve ser escrito manualmente para simular essa prova.
Esse check elimina o blocker antigo de árvore ausente/stale, mas não fornece licença, identidade,
artifact, assinatura, promotion record ou install drill.

O tarball continua determinístico e não contém sua própria promoção/assinatura, o que evitaria
vincular seu SHA-256 sem criar um ciclo. Ao lado dele, `npm-release-binding.json` schema v1 vincula
nome, versão, channel/dist-tag, tarball/hash/tamanho, manifest/bundle/build metadata/checksums,
commit/fingerprint e hashes/tamanhos de SBOM, provenance, LICENSE e notices. O binding registra
`packaged-not-tested` ou os receipts exatos de `npm-promotion-record.json` e do candidato standalone;
nenhum estado é herdado por nome ou versão. O segundo entra como
`standalone-release-candidate-snapshot.json`, sidecar opaco hash-bound no inventário/binding assinado,
mas permanece fora do `.tgz`. Ele não é relocatable: seus paths continuam relativos ao diretório
standalone original, portanto não deve ser relido no diretório npm como receipt autônomo. O
`package-result.json` registra essa limitação, o payload content address e o inventário observado.

`NpmReleasePromotionRecordSchema` v2 incorpora um `ReleasePromotionRecord` v3 completo como base
R001–R079 e adiciona attestations/reviewers/gates específicos do candidato npm. A base é revalidada
por `assertReleasePromotionBinding` contra o `promotionCandidate` estrito do receipt standalone
independente. Esse input e seus payloads relativos à origem são validados como arquivos regulares,
bounded e estáveis antes da cópia. `artifactRefs` só vinculam o candidato; `evidenceRefs` são
receipts/logs externos content-addressed. Integração, E2E, install drill e dry-run exigem ambiente
real tipado. O install drill do `.tgz` exato cobre cada OS/arquitetura da promoção base e registra
runner/isolation, Bun/versão e package manager (`npm`, `pnpm` ou `bun`)/versão. LICENSE e
notices também precisam coincidir com a promoção base. O gate de licença precisa referenciar
explicitamente SBOM, provenance, LICENSE e notices exatos. O record inteiro é copiado com
hash/tamanho para o binding.

O mesmo signer config provider-neutral aceita a operação explícita `sign-release-subject` para
`subjectKind: npm-release-binding`; adapters antigos limitados a manifest falham fechado. A
assinatura cobre a projeção canônica do binding, incluindo promotion receipt, receipt standalone e descritor público,
mas omitindo apenas o digest auto-referente. `stable` exige promotion npm válida e signer; `beta`
pode ter promoção e/ou signer, enquanto `dev`/`nightly` não aceitam promotion record. Todos os canais
exigem escolher explicitamente signer config ou razão bounded de indisponibilidade; o repositório
não escolhe package name, provider, credencial, identidade ou trust root. A única exceção é a
primeira passagem `stable --candidate-only`, que proíbe todas as opções de promoção e assinatura
porque não cria binding nem signature.

### Operação npm em duas passagens

O promotion record só pode existir depois que o `.tgz` exato existe e foi submetido aos gates. Para
evitar um ciclo, a promoção usa duas passagens determinísticas com os mesmos inputs e um
`--published-at` canônico fixado para o instante planejado de publicação. Na primeira passagem esse
instante precisa estar mais de cinco minutos no futuro, inclusive no momento do commit do candidato:

1. gere o candidato `stable` com `--candidate-only`, preserve `.tgz`,
   `npm-candidate-receipt.json` e todos os inputs;
2. execute os gates contra o SHA-256 desse `.tgz` e produza o record npm;
3. repita o packager com package name, versão, channel, dist-tag, commit, fingerprint e
   `--published-at` byte a byte iguais, removendo `--candidate-only` e acrescentando
   `--promotion-record`, `--release-candidate-receipt` e `--signature-config`;
4. compare o SHA-256 do novo `.tgz` ao candidato provado e publique somente o tarball final com o
   tag já vinculado.

Primeira passagem (não publicável):

```text
bun run package:npm -- --package-name <NOME_NPM_ESCOLHIDO> --channel stable --dist-tag latest --source-repository <HTTPS_REPOSITORY> --source-commit <40_HEX> --published-at <ISO_8601_FUTURO_FIXO> --candidate-only
```

A saída usa o sufixo `-candidate`, registra `publishable: false` e não contém
`npm-release-binding.json`, promotion record ou assinatura. `--candidate-only` é aceito somente com
`stable` e é incompatível inclusive com `--signature-unavailable-reason`. A passagem final usa o
diretório sem esse sufixo e continua falhando antes do commit sem record e signer válidos.

Segunda passagem (binding final, ainda sem publicar no registry):

```text
bun run package:npm -- --package-name <MESMO_NOME_NPM> --channel stable --dist-tag latest --source-repository <MESMO_HTTPS_REPOSITORY> --source-commit <MESMO_40_HEX> --published-at <MESMO_ISO_8601_FUTURO_FIXO> --promotion-record <NPM_PROMOTION_JSON_DO_CANDIDATO> --release-candidate-receipt <RELEASE_CANDIDATE_RECEIPT_STANDALONE> --signature-config <SIGNER_CONFIG_JSON>
```

O `recordedAt` do promotion record e suas evidências precisa anteceder o `publishedAt` planejado; a
segunda passagem ocorre entre cinco minutos e um segundo antes desse instante. A validação do record,
do receipt independente e de seus payloads é repetida imediatamente antes do commit do output final;
o sidecar copiado também é conferido no inventário. Se o prazo for perdido, não se edita o record nem se
reaproveita evidência para outro hash: escolha outro instante, gere novo candidato e repita os gates.
O packager nunca publica e nunca altera o dist-tag do registry.

## Gate F — install/update/rollback/uninstall

Para cada target `included` que será efetivamente promovido, arquive evidence de:

- instalação local limpa;
- instalação HTTPS allowlisted;
- target/tamanho/hash/metadata adulterado recusado;
- crash em planned/staged/verified/activated reconciliado;
- update sem sobrescrever launcher/engine em uso;
- launcher schema incompatível deixando repair explícito;
- rollback para receipt-bound version;
- downgrade/schema incompatível recusado;
- uninstall removendo somente managed paths;
- `.ralph`, config, credentials e Ralph clássico preservados.

Para um manifest assinado, arquive também config/policy do verifier sem secrets, identidade/issuer
esperados, origin/channel permitidos, prova de envelope adulterado recusado e prova de
timeout/cancelamento encerrando a árvore. `RALPH_RELEASE_VERIFIER_CONFIG` habilita a composição, mas
o repositório não fornece trust root default e nunca confia na identidade declarada pelo manifest.

`EV-S12-DIST-8` cobre esse lifecycle apenas com fixtures sintéticas `nightly`/`*-dev.1` unsigned. Ele
não marca nenhum item deste gate como concluído nem substitui drill de package instalado.

## Gate G — matriz funcional

Anexe a versão fechada de R001–R079. Para cada linha: ID de prova, ambiente, artifact hash, resultado
e, se necessário, waiver com owner/rationale/expiração. Os seguintes conjuntos são bloqueantes:

- command authority e tool boundaries;
- providers/auth executor e judge independentes;
- PRD parser/skill/root/children;
- judge/revisões/gates/no-change/artifact;
- crash/resume/watchdog/child/parallel;
- Git/checkpoint/rollback/sandbox/security;
- TUI/PTY/progresso/usage/output/replay;
- migration/compatibility;
- distribution/platform/license/SBOM.

O promotion record é schema fechado, não texto livre. Cada attestation declara explicitamente quais
requirements, gates e targets afirma provar. Evidência runtime/package de um target deve apontar para
o SHA-256 do tar exato e para o OS, arquitetura e runner daquele target; a mesma attestation não pode
ser reutilizada entre as duas classes. Gates exigem kind e subject compatíveis (por exemplo,
`security`, `license-sbom`, `skill-forward-test` ou `install-drill`). Reviewer/issuer dentro do record
é metadata de auditoria, não trust anchor. Toda attestation exige ao menos uma `artifactRef`
content-addressed para o receipt/log externo que contém comando ou harness, resultado e diagnostics;
nomes precisam ser canônicos e referências duplicadas são recusadas. Para instalação `stable`, a
confiança vem de política local
independente, assinatura verificável e identidade verificada fora do manifest; self-trust é proibido.

O comando local de fechamento é:

```text
bun run check:s12 -- --evidence-root artifacts/ci/s11-closure/local-YYYYMMDD-NNN [--legacy-binary <RALPH_V1_EXPLICITO>] [--next-binary <RALPH_V2_EXPLICITO>] [--candidate-artifact <ARQUIVO_CANDIDATO> --candidate-digest sha256:<64_HEX>] [--waiver-artifact <APROVACOES_EXTERNAS_JSON> --waiver-digest sha256:<64_HEX>] [--gitleaks-binary <BINARIO_CANONICO> --gitleaks-sha256 <64_HEX>]
```

Ele produz manifest/logs/JUnit sanitizado/classificação/receipts/R001–R079, payload content-addressed,
candidate/source bindings, envelope e `SHA256SUMS`; exit
`2` significa `local-pass/release-blocked`, não falha técnica nem promoção. Para um handoff real,
registre path/URI imutável, SHA-256/tamanho de `closure-complete.json`, SHA-256 do
`evidence-manifest.json`, content address, status e source binding do archive. Sem completion receipt
válido, qualquer outcome anterior é apenas provisório. R015 possui review independente, mas o runner
o revalida contra o parser atual;
qualquer drift reabre `BLK-R015-REVIEW`. `--candidate-artifact` aceita somente um
`release-candidate-receipt.json` standalone ou `release-manifest.json` Ralph schema-valid. O runner
revalida a metadata e cada payload com receipt declarado por tamanho/hash, repete a leitura antes do
binding e faz uma última releitura do conjunto externo depois de estabilizar o envelope, antes do
completion receipt. A assinatura destacada de manifest não possui self-hash: só é lida estável/bounded e
recebe hash observado, nunca veredito criptográfico. A leitura agregada tem limite de 8 GiB e aceita
cancelamento entre chunks. O archive guarda digest/tamanho exatos, projeção tipada sem URLs e
inventário com modo de verificação por payload. A metadata bruta não entra no archive, portanto o
receipt declara-se não autônomo sem o input externo retido; `content-verified` não alega autenticidade.
O `--candidate-digest` confirma somente os bytes da metadata. Source binding e waiver usam o
`effectiveCandidateDigest` derivado de kind + digest/tamanho da metadata + content address de todos
os payloads observados, inclusive o blob destacado; bytes de assinatura diferentes não compartilham
a mesma chave de waiver.
R063 permanece parcial. Promoção exige manter o binding
dinâmico de R015 válido e fechar `BLK-R063-FORGE`, ou registrar waivers aprovados com
owner/rationale/expiração/effective candidate digest; waiver não é inferido do exit `2`.

O registry do source contém somente política e defaults `not-granted`; gravar ali uma aprovação
pós-candidato alteraria commit/fingerprint e criaria um ciclo. Aprovações concretas entram somente
pelo par externo `--waiver-artifact`/`--waiver-digest`, que exige candidate explícito. O schema estrito
vincula metadata/effective digests, repository identity digest, commit e fingerprint, ordena IDs,
recusa duplicatas/`BLK-SOURCE-BINDING` e exige owner idêntico ao blocker. O arquivo e digest passados
explicitamente pelo operador constituem a autoridade deste modo; não representam assinatura
criptográfica. Apenas hashes/projeção sem URLs entram em `waiver-binding.json`, e todo waiver usado é
relido e reavaliado quanto à expiração antes do completion receipt.

O runner não usa Gitleaks do PATH: recebe binário e SHA-256 juntos ou consome o receipt oficial
checksum-pinned da CI, confirma versão 8.30.1 e exige report JSON vazio. JUnit bruto nunca entra no
archive: valores secretos literais e suas formas XML nomeada, decimal, hexadecimal ou combinada são
redigidos; se o post-scan ainda os recuperar por decodificação, o runner rejeita o report antes de
persisti-lo. A origem Git canônica é comparada em memória antes/depois e apenas seu SHA-256 é
arquivado; a URL nunca entra nos logs/receipts. Quando o source binding está apto, uma terceira
observação final usa o mesmo executável Git hash-bound depois da estabilização do envelope e falha se
HEAD, origin ou limpeza divergirem. Source binding permanece aberto até HEAD/origin e
árvore limpa permanecerem idênticos, inventário/fingerprint não mudarem e repository,
commit e fingerprint do candidato coincidirem. O DAG é core + candidate binding → source binding →
blockers/run manifest → evidence manifest → `SHA256SUMS` → `closure-complete.json`; assim não há hash
autorreferente. Run/source/blockers/manifest ficam marcados como provisórios. Somente o último receipt,
ausente em qualquer crash anterior ao fechamento, com os hashes exatos do envelope, é autoridade de
status final. O próprio completion receipt passa por schema estrito, invariantes cruzadas, releitura
estável e comparação byte-intended antes das duas inventariações finais. Esse vínculo fundacional
não é transformado em pass por waiver.

## Gate H — skill

- [ ] cenário complexo gerado em checkout descartável;
- [ ] root e todos os children escritos antes da run;
- [ ] `prd validate --recursive --strict` no artifact exato;
- [ ] parent refs/dependencies/groups corretos;
- [ ] slices atravessam somente boundaries necessárias;
- [ ] stack preservada, sem escolha opinativa;
- [ ] criteria/change-only/artifact honestos;
- [ ] artifact separado da skill contém `LICENSE` e `THIRD_PARTY_NOTICES.md` no próprio root;
- [ ] ausência de autoria tardia pelo runtime;
- [ ] forward test com usuário/revisor registrado.

O source da skill já passou em rehearsal local: `quick_validate.py`, 3/3 testes de contrato e um
forward test cego em checkout temporário produziram 2 documentos/7 tasks e passaram em
`prd validate`/`prd inspect` recursive/strict sem diagnostics. Os checkboxes deste gate permanecem
abertos porque o teste ainda não usou o artifact empacotado, licenciado, content-addressed e ligado
ao release candidate/reviewer formal.

## Gate I — beta e nome final

- [ ] campanha, janela, coorte, targets e artifact hashes vinculados antes da entrada;
- [ ] período beta operado exclusivamente como `ralph-next`;
- [ ] diagnostics locais, redaction, retenção, exclusão e known issues triados sem telemetria invasiva;
- [ ] blockers fechados ou waivers explícitos;
- [ ] TUI/PTY, migração, rollback e retorno ao Ralph clássico documentados e ensaiados;
- [ ] backup clássico registra path, versão, tamanho e SHA-256 e foi conferido por path absoluto;
- [ ] status/preview do alias não mutam; apply exige receipt corrente `stable`, plano confirmado e
  ausência de colisão;
- [ ] remoção é channel-independent, move primeiro para quarentena receipt-bound, inclui
  paths/hashes de recuperação no preview e bloqueia nova instalação enquanto qualquer quarentena
  válida permanecer;
- [ ] receipt de controle `N+1` é atômico, aparece no preview quando ainda não foi ativado e só é
  reutilizado ou descartado após reconstrução canônica e hash idêntico;
- [ ] oferta do alias `ralph` é somente opt-in, não altera `PATH` e inclui prova de
  `Get-Command ralph -All`/`where.exe ralph` ou `type -a ralph`;
- [ ] pacote npm continua expondo somente `ralph-next`, sem alias implícito;
- [ ] Ralph clássico nunca removido implicitamente.

A worksheet determinística e os case IDs deste gate estão em
[28 — Drills de release, beta, alias e handoff](28-release-drills-beta-alias-e-handoff-s12.md).

## Handoff a preencher

```text
Version:
Channel:
Commit:
Source fingerprint:
S01-S12 status and pending evidence:
Release manifest SHA-256:
Standalone artifacts:
npm package/tarball:
SBOM SHA-256:
LICENSE SHA-256:
THIRD_PARTY_NOTICES SHA-256:
Signature/provenance:
Support policy schema/SHA-256/matrix decision:
Signer protocol/config hash/reviewer:
Verifier protocol/policy hash/reviewer:
Workspace schema range:
Launcher schema range:
Migration versions:
Matrix evidence bundle:
S11/S12 closure archive path/URI:
S11/S12 closure content address and evidence-manifest SHA-256:
S11/S12 closure-complete.json SHA-256 and size:
S11/S12 closure status/source binding:
R015 independent parser review/evidence/waiver:
R063 remote forge/PR decision/evidence/waiver:
Real provider/auth smokes:
Platform install smokes:
TUI/PTY runtime smokes:
Migration drill/case/evidence:
Engine and workspace rollback drills:
Classic Ralph return drill:
Known issues:
Waivers:
Install commands:
Usage commands:
Doctor command/result:
Engine rollback:
Workspace rollback:
Vendor rollback:
Upstream snapshot/commit/inventory:
Upstream refresh procedure/reviewer/rollback:
Configurable decisions and owners:
Beta campaign/window/cohort/targets:
Beta entry/exit decisions:
Diagnostics/redaction/retention/deletion policy:
Triage issue index/owner:
Classic Ralph absolute path/version/size/SHA-256:
Classic Ralph backup path/inventory SHA-256:
Alias ralph decision/approval:
Alias current receipt channel/generation/SHA-256:
Alias preview plan SHA-256/collision result:
Alias/receipt removal quarantine paths/SHA-256/state:
Alias pending control receipt/quarantine path/SHA-256/state:
Alias PATH/package-manager non-mutation proof:
Release owner/reviewer/date:
```

Nenhum campo vazio pode ser substituído por inferência. Se um dado não existe, registre `pending` ou
`unavailable` e mantenha o gate aberto.
