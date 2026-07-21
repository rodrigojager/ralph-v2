# 23 — Distribuição, instalação, update e rollback S12

## Estado e autoridade

Este documento define o contrato técnico de S12. Ele não afirma que artifacts de release foram
construídos, assinados, publicados, instalados ou suportados. Enquanto a licença própria e os drills
do candidato estiverem pendentes, o projeto continua privado e `ralph` permanece o único nome
promovível.

A implementação está presente em `packages/distribution` e ligada ao parser/handlers de
`packages/commands`. Ela inclui manifest e receipts tipados, staging com hash/tamanho, versões
imutáveis, launcher/pointer, recovery journal, update, rollback e uninstall delimitado pelo
receipt. Além do build/smoke standalone, uma matriz local de contrato executou o lifecycle completo
com payloads sintéticos `nightly`/`*-dev.1` unsigned. Essa prova valida S12.02 no checkout e no host
executados; não cobre packaging, artifact candidato, assinatura, promoção ou suporte de plataforma.

O command handler governa download, verificação, staging, ativação, rollback e uninstall. Provider,
modelo e TUI não recebem autoridade para alterar a instalação.

## Canais e identidade

Canais fechados:

- `dev`: checkout/source, nunca update automático;
- `nightly`: artifacts não promovidos, sem promessa de compatibilidade;
- `beta`: nome `ralph`, rollback obrigatório;
- `stable`: somente depois da matriz, promotion record completo, assinatura verificável e gate de corte.

Todos os canais expõem exclusivamente `ralph`; channel não altera a identidade do comando.

A versão e o canal formam um único contrato fail-closed. O primeiro identificador de prerelease é
case-sensitive e determina a compatibilidade; metadata de build (`+...`) não altera o canal:

| Channel | Forma SemVer aceita | `dist-tag` npm obrigatório |
| --- | --- | --- |
| `dev` | `X.Y.Z-dev` ou `X.Y.Z-dev.<...>` | `dev` |
| `nightly` | `X.Y.Z-nightly[.<...>]` ou `X.Y.Z-dev[.<...>]` | `nightly` |
| `beta` | `X.Y.Z-beta` ou `X.Y.Z-beta.<...>` | `beta` |
| `stable` | `X.Y.Z`, sem prerelease | `latest` |

Identificadores vazios e prerelease numérico com zero inicial não são SemVer válido. Uma versão
`dev` nunca pode ser empacotada como `beta` ou `stable`; da mesma forma, `latest` nunca é aceito
para canais não-stable. Standalone valida a dupla versão/channel. O pacote npm exige ainda que
`--dist-tag` corresponda exatamente à tabela e grava o binding em `publishConfig`, provenance e
resultado do empacotamento. Nenhum comando infere ou corrige silenciosamente esses valores.

Cada release possui versão SemVer, channel, commit/source fingerprint, data, targets, checksums,
SBOM, notices, licença própria e provenance/signature quando disponível. Ausência de assinatura é
metadata explícita, não `verified` implícito.

### Inventário de licenças derivado do artifact

O SBOM registra componentes e expressões, mas não substitui os textos de licença/notice. Depois de
serializar `SBOM.cdx.json`, os dois packagers passam o objeto validado e o SHA-256 do arquivo real a
`scripts/release-licenses.ts`. O helper exige que a única aresta root do SBOM corresponda exatamente
a todos os componentes npm runtime, localiza cada par nome/versão no `node_modules/.bun`, confere
`package.json` e copia todos os arquivos top-level `LICENSE`/`LICENCE`/`COPYING` e `NOTICE` que
casem com a regra bounded. Pelo menos um texto de licença/copying é obrigatório por componente.

Cada origem e destino precisa ser arquivo regular, não-linkado, não vazio, UTF-8 e dentro dos
limites de quantidade/tamanho. Se houver mais de uma variante da mesma versão no Bun store por
causa de peers, os nomes, tipos, tamanhos e hashes dos textos precisam ser idênticos; o packager não
escolhe silenciosamente entre materiais divergentes. Componentes não-npm desconhecidos falham. A
única adaptação não-npm atualmente reconhecida é o snapshot curado OpenCode, para o qual são
copiados em conjunto `LICENSE`, `PROVENANCE.json`, `UPSTREAM.md`, `copied-files.md` e `patches.md`.

O resultado fica em `third_party/licenses/` dentro do artifact. `manifest.json` schema v1 vincula
`publishedAt`, SHA-256 do SBOM exato, bom-ref/nome/versão/expressão declarada, tipo de origem e, para
cada arquivo, path relativo, nome de origem, tipo, tamanho e SHA-256. Os checksums globais do
artifact cobrem esse diretório. Isso entrega rastreabilidade determinística, não uma certificação
jurídica automática.

#### Curação local obrigatória do runtime Bun no standalone

Como o executável standalone incorpora o runtime Bun, metadata npm não é evidência suficiente. O
primeiro build metadata selecionado fixa `bunVersion` e `bunRevision`; todos os demais engine e
launcher metadata do mesmo release precisam repetir exatamente essa dupla. Antes de compor qualquer
tar, o packager exige o diretório local:

```text
third_party/bun/runtime/<BUN_VERSION>/<BUN_REVISION_40_HEX>/
```

Esse diretório deve conter apenas `CURATION.json` e os arquivos que ele declara. Não há download,
consulta de rede, geração de texto ou fallback automático. O JSON é estrito:

```json
{
  "schemaVersion": 1,
  "runtime": "bun",
  "version": "<BUN_VERSION_EXATO>",
  "revision": "<REVISAO_LOWERCASE_40_HEX>",
  "sourceRepository": "https://github.com/oven-sh/bun",
  "sourceRevision": "<MESMA_REVISAO_40_HEX>",
  "completeScope": "license-notice-provenance-for-pinned-runtime",
  "curatedAt": "<ISO_8601_CANONICO>",
  "curatedBy": "<RESPONSAVEL_PELA_CURADORIA>",
  "files": [
    {
      "path": "LICENSE",
      "kind": "license",
      "sizeBytes": 123,
      "sha256": "<SHA256_LOWERCASE>"
    },
    {
      "path": "PROVENANCE.md",
      "kind": "provenance",
      "sizeBytes": 123,
      "sha256": "<SHA256_LOWERCASE>"
    }
  ]
}
```

Os únicos `kind` aceitos são `license`, `copying`, `notice` e `provenance`. É obrigatório haver ao
menos um `license|copying` e um `provenance`; arquivos extras, ausentes, links, paths inseguros,
hash/tamanho divergente ou revisão incompatível bloqueiam o standalone. O exemplo usa números
placeholders e não deve ser copiado como receipt. O release owner precisa curar os textos oficiais
e a proveniência do runtime exato sem inventar expressão, copyright ou obrigação.

O pacote npm não inclui o binário/runtime Bun. Ele recebe o inventário completo do grafo npm, mas
não inclui a curação de runtime; continua declarando Bun como requisito do host em vez de fingir que
o tarball licencia um runtime externo não distribuído.

## Release manifest

O manifest JSON schema v2 e assinado separadamente quando possível contém:

- `schemaVersion`, `product`, `version`, `channel`, `publishedAt`;
- source repository/commit/fingerprint;
- versão mínima do state/schema e compatibilidade de downgrade;
- faixa compatível do schema do launcher estável;
- `supportPolicy` v1 completa e `supportPolicySha256` sobre sua serialização canônica;
- artifacts por platform/architecture com URL HTTPS, tamanho e SHA-256;
- hashes de `LICENSE`, `THIRD_PARTY_NOTICES`, SBOM e metadata de build;
- status real por target: `tested`, `built-not-tested` ou `not-evidenced`;
- assinatura/provenance como objeto verificável ou indisponibilidade explícita em canais não-stable;
  `stable` exige payload de assinatura e verifier correspondente, nunca boolean inventado.

A assinatura cobre uma projeção canônica não circular do manifest: apenas o campo
`signedManifestSha256` é omitido da projeção, enquanto tipo, identidade alegada e descritor do
envelope destacado permanecem autenticados. Identidade declarada no manifest nunca é trust anchor.
O executável precisa compor verifier e policy local com identidades, issuers, canais e origins
confiáveis; sem ambos, instalação/update assinado e `stable` falham fechados.
O composition root agora pode carregar um verifier externo e uma policy local por
`RALPH_RELEASE_VERIFIER_CONFIG`, mas o repositório não escolhe verifier concreto, identidade,
issuer, chave nem trust root. Sem configuração independente válida, manifests assinados e o canal
`stable` continuam não instaláveis; os comandos abaixo descrevem uma superfície estática ainda não
validada, não a disponibilidade de uma release atual.

### Matriz versionada de inclusão e capabilities

O packager nunca infere suporte a partir de binaries encontrados nem trata `--all` como autorização
de produto. Toda composição exige `--support-policy <ARQUIVO_JSON>`. A policy é JSON estrito,
`schemaVersion: 1`, ligada a `product`, versão SemVer e exatamente um channel. `matrix` contém
exatamente as seis entradas abaixo, nesta ordem:

| Target | Capability de controle de instalação nesta versão | Estado a fornecer externamente |
| --- | --- | --- |
| `bun-windows-x64-baseline` | file fsync; directory sync indisponível; garantia `reduced` | `included` ou `not-promoted` |
| `bun-windows-arm64` | file fsync; directory sync indisponível; garantia `reduced` | `included` ou `not-promoted` |
| `bun-linux-x64-baseline` | file fsync + directory fsync; garantia `full` | `included` ou `not-promoted` |
| `bun-linux-arm64` | file fsync + directory fsync; garantia `full` | `included` ou `not-promoted` |
| `bun-darwin-x64` | file fsync + directory fsync; garantia `full` | `included` ou `not-promoted` |
| `bun-darwin-arm64` | file fsync + directory fsync; garantia `full` | `included` ou `not-promoted` |

No runtime fixado Bun `1.3.14`, Windows ARM64 possui ainda uma limitação independente de
durabilidade: esse build não expõe `bun:ffi`/TinyCC, necessário pelo renderer nativo do OpenTUI.
O comando preserva CLI headless, persistência, supervisão e distribuição; `--ui auto` usa a
apresentação headless e `--ui tui` falha com `RALPH_TUI_UNAVAILABLE`. Até um Bun compatível ou um
renderer sem essa dependência ser validado, a policy de release deve manter `bun-windows-arm64`
como `not-promoted`, com esse motivo público. Os cinco skips PTY/TUI na CI são classificados e
temporários; não constituem teste aprovado nem alegação de suporte.

As duas formas fechadas de entry são:

```text
{
  "target": "<TARGET_CANONICO>",
  "status": "included",
  "capabilities": {
    "installControlStateDurability": {
      "fileSync": "fsync-before-rename",
      "directorySync": "<fsync-after-rename|unsupported-file-sync-only>",
      "guarantee": "<full|reduced>"
    }
  },
  "limitations": ["<LIMITACAO_PUBLICA_SE_EXISTIR>"]
}

{
  "target": "<TARGET_CANONICO>",
  "status": "not-promoted",
  "capabilities": {
    "installControlStateDurability": {
      "fileSync": "fsync-before-rename",
      "directorySync": "<fsync-after-rename|unsupported-file-sync-only>",
      "guarantee": "<full|reduced>"
    }
  },
  "reason": "<MOTIVO_PUBLICO_OBRIGATORIO>"
}
```

`included` significa somente “há artifact candidato neste manifest”. Não significa `tested`, suporte
real ou promoção. `not-promoted` exige motivo bounded, humano e explícito; assim a ausência de
artifact jamais parece suporte acidental. A lista de artifacts precisa ser exatamente o subconjunto
`included`, em ordem canônica. Um target excluído não pode aparecer em artifact, attestation ou
target binding do promotion record.

A capability não é declarada livremente pelo autor para contornar uma limitação: o schema confere o
valor contra a primitive implementada. Portanto Windows continua obrigatoriamente
`unsupported-file-sync-only/reduced`; a policy não pode escrevê-lo como `full`. Para `stable`, uma
entry `included` precisa ter garantia `full`, além de evidence `tested`, promotion record e
assinatura. Isso permite uma stable com subconjunto explicitamente escolhido sem esconder os demais
targets; também continua permitindo que uma futura primitive Windows, implementada e provada, exija
uma revisão versionada do contrato em vez de uma alteração silenciosa.

O SHA-256 canônico da policy fica no manifest e no `support` do promotion record schema v3. O
manifest assinado autentica a policy inteira e seu hash. O installer recalcula o hash, exige
version/channel iguais, exige que o target local esteja `included`, compara a capability declarada à
capability observada e só então aceita selecionar/stagear o artifact. Promotion records vinculam
exatamente o mesmo hash e exatamente o subconjunto `included`; qualquer divergência falha fechada.
Em manifest não assinado esse SHA-256 prova consistência interna, não autenticidade do publisher;
ele não substitui verifier/trust policy e nunca torna nightly/beta “trusted”.

O repositório não fornece uma policy pronta, pois isso escolheria targets pelo proprietário. O input
externo ainda necessário para cada release é: estados das seis entradas, limitações de cada entry
`included` e motivos de cada `not-promoted`.

O arquivo `examples/release-support-policy.template.json` evita reconstruir a estrutura à mão sem
tomar essa decisão. Ele é deliberadamente **não aprovável como está**: usa versão placeholder e
mantém todas as entradas `not-promoted`, enquanto o schema exige pelo menos uma `included`. O release
owner precisa copiar o arquivo, vincular versão/channel reais, escolher explicitamente o subconjunto,
trocar `reason` por `limitations` nas entradas incluídas e só então passá-lo ao packager. Essa falha
inicial é intencional; o template nunca vira uma policy implícita.

### Signer externo do packager

`scripts/package-release.ts` aceita exatamente uma das opções:

- `--signature-config <ARQUIVO_JSON>` para produzir uma assinatura destacada;
- `--signature-unavailable-reason <MOTIVO_PUBLICO>` para declarar honestamente a indisponibilidade.

As opções são mutuamente exclusivas. `nightly` e `beta` aceitam qualquer uma delas; a passagem final
`stable` exige simultaneamente `--promotion-record` e `--signature-config`. `dev` é canal de source
checkout e aceita somente a indisponibilidade explícita. A primeira passagem
`stable --candidate-only` é a exceção fail-closed: proíbe promoção, signer e razão de
indisponibilidade, não cria manifest/assinatura e grava `publishable: false` em output separado. A
presença de um signer não relaxa os gates de licença, evidence, plataforma, verifier ou trust policy.

Independentemente da opção de assinatura, `--support-policy <ARQUIVO_JSON>` é obrigatório.
`--target` repetido ou `--all` deve selecionar exatamente as entries `included`; `--all` só é válido
quando as seis entries estiverem `included`. Essa igualdade é conferida antes da composição e o
output repete a matriz completa e seu hash.

O arquivo de configuração é JSON estrito, UTF-8, regular, não-linkado, lido por handle com limite de
1 MiB e revalidação de identidade/tamanho/tempos antes e depois da leitura. Seu schema v1 é:

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

O projeto não fornece valores recomendados para executável, argumentos, kind, identidade, media
type, variável, chave ou serviço. `forwardEnvironment` contém somente nomes; os valores são lidos do
ambiente do processo no instante da chamada, nunca gravados no JSON, request, manifest ou output.
Variáveis app-owned de protocolo/temp não podem ser sobrescritas. O ambiente filho começa em uma
allowlist mínima e recebe apenas esses nomes adicionais.

O Ralph resolve o executável para arquivo regular, fixa sua identidade e chama um argv exato, sem
shell:

```text
<executable> <arguments...> --request <request.json> --result <result.json>
```

O arquivo e seu diretório pai devem ser protegidos contra escrita concorrente por principals não
confiáveis. O Ralph revalida `dev`/`ino`/tamanho/tempos imediatamente antes e depois da chamada; o
spawn portável ainda ocorre por path, pois Bun não oferece um `fexecve` comum a Windows, Linux e
macOS. Portanto essas revalidações detectam substituição, mas não transformam um path gravável por
um atacante local no mesmo nível de privilégio em executable confiável.

O diretório temporário é privado onde a plataforma oferece modos POSIX. Request, manifest canônico,
result e output da assinatura são arquivos `0600`; result e assinatura são pré-criados e o adapter
deve escrever nos mesmos arquivos, sem substituí-los. A árvore é supervisionada com timeout e
graceful/forced termination. `stdin` não é usado; `stdout`/`stderr` são descartados de forma bounded
e nunca entram no manifest, diagnóstico ou handoff. O adapter comunica somente pelos arquivos do
protocolo.

O request `ralph-release-signature-signer-v1` contém `schemaVersion`, `protocol`, operação, `kind`,
`identity`, `signedManifestSha256`, `canonicalManifestPath`, `signatureOutputPath`,
`signatureMediaType` e `maximumSignatureBytes`. O result deve ser JSON estrito com
`schemaVersion: 1`, o mesmo protocolo, `status: signed`, `kind`, `identity`,
`signedManifestSha256`, `signatureSha256` e `signatureSizeBytes`. O packager calcula novamente os
dois hashes e o tamanho; confere result, executável e bytes canônicos; exige assinatura regular,
não-linkada, não vazia, bounded e com identidade estável; e só então copia o envelope para
`signatures/release-signature.<kind>`.

O manifest final usa `signature.status: present` com `kind`, `identity`, `payload.path`, URL opcional,
`maximumSizeBytes`, `mediaType` e `signedManifestSha256` calculado por
`releaseManifestSigningSha256`. `SHA256SUMS` não inclui o envelope gerado depois de sua projeção, o
que evita um ciclo assinatura→manifest→checksums→assinatura. O instalador calcula tamanho e SHA-256
do envelope staged e exige que o verifier confirme esses valores junto do hash canônico.

Signer e verifier são adapters separados. O sucesso do signer prova apenas que o adapter configurado
produziu um envelope coerente; não prova que a identidade é confiável. No install/update, o verifier
v1 recebe snapshot privado regular e os campos `signatureSizeBytes`, `signatureSha256` e
`signatureMediaType`; seu result precisa devolver `kind`, identidade,
issuer opcional, `signedManifestSha256` e `signatureSha256`. A policy local independente continua
sendo a única autoridade para kind, identidade, issuer, canal e origin.

O cliente recusa schema desconhecido, target incompatível, URL não HTTPS fora de fonte local
explícita, tamanho excessivo, hash divergente, version downgrade não autorizado e manifest cuja
versão não corresponda ao artifact.

## Layout standalone versionado

O instalador recebe ou resolve um install root explícito e cria somente:

```text
<install-root>/
  current.json
  receipts/
    <generation>-<install-id>.json
  bin/
    ralph[.exe]
  versions/
    <version>/
      ralph[.exe]
      build-metadata.json
      launcher-build-metadata.json
      release-manifest.json
      SHA256SUMS
      SBOM.cdx.json
      ralph-loop-prd-generator.tar
      LICENSE
      THIRD_PARTY_NOTICES.md
      promotion-record.json        # quando declarado
      release-signature.<kind>     # quando declarado
  staging/
  rollback/
```

Versões e receipts geracionais são imutáveis. `current.json` é a única autoridade de commit: aponta
para um receipt por path, geração e SHA-256. O launcher lê esse pointer uma única vez, confere o
receipt referenciado, install ID, path canônico sob `versions/`, arquivos regulares e hashes, e só
então executa o binary versionado. Update grava a nova versão e o novo receipt antes de substituir
atomicamente `current.json`; não existem dois arquivos de controle mutáveis que possam divergir.
Assim o binary em uso nunca é sobrescrito, inclusive no Windows. Receipts registram root canônico,
origem, channel, ownership e hashes, sem secrets.

O launcher é tratado como artifact compilado, gerado e delimitado. Não lê config do workspace, não escolhe
provider e não executa texto vindo de PRD. O pointer precisa resolver para um binary regular dentro
de `versions/` e nunca aceitar symlink/junction/path externo sem policy explícita.

Updates normais não substituem o launcher em uso. O manifest declara a faixa de schema aceita. Se
o launcher instalado estiver fora dessa faixa, o update deixa a nova engine em staging e solicita
um repair/reinstall explícito após o launcher encerrar; não tenta uma troca arriscada em background.

## Install

Fluxo standalone:

1. resolver install root e target canônicos sem seguir um target amplo/desconhecido;
2. recusar colisão com `.ralph`, workspace root, checkout source ou instalação não identificada;
3. obter manifest de arquivo local explícito ou HTTPS allowlisted;
4. selecionar exatamente platform/architecture atuais, exigir entry `included`, policy hash e
   capability de durabilidade compatível antes de aceitar o artifact;
5. baixar/copiar para staging com limites de bytes e cancelamento;
6. verificar SHA-256, metadata, versão, target, notices, SBOM, skill empacotada e licença;
7. materializar `versions/<version>` por rename atômico;
8. gerar/confirmar launcher e receipt;
9. trocar `current.json` somente depois de tudo durável;
10. registrar previous version para rollback e emitir instrução de PATH sem alterá-lo silenciosamente.

Toda mutação usa lock interprocesso exclusivo por install root. O lock registra token, PID, host,
ação e timestamps; idade nunca autoriza quebra. Ele só é retomado quando o PID anterior está
comprovadamente morto e a identidade do arquivo continua igual. O journal é write-ahead: destino
de rename, receipt pendente e paths materializados são persistidos antes de cada efeito.
Arquivos são sincronizados antes de rename e, onde o sistema suporta, cada parent directory afetado
é sincronizado depois do rename de WAL, version, receipt e pointer. No Windows a API adotada não
oferece directory fsync equivalente: o receipt registra `unsupported-file-sync-only`/garantia
`reduced`. Essa limitação é aceitável apenas nos canais não-stable; `stable` falha fechado nessa
capability em vez de alegar durabilidade plena.

Um transport de download recebe o destino escolhido pelo instalador, mas não possui autoridade para
substituí-lo: o loader exige path retornado idêntico, containment no staging da operação, `lstat`
regular sem symlink e recalcula tamanho/SHA-256 lendo o próprio destino antes de retorná-lo.

`--dry-run`/preview não baixa nem grava. `--force` não autoriza apagar diretório desconhecido,
ignorar checksum, misturar state ou substituir outro produto.

Superfície direta equivalente em human, JSON ou JSONL quando o formato for aceito pelo comando:

```text
ralph install <install-root> --manifest <release-manifest.json|https-url>
  [--channel nightly|beta|stable] [--to-version VERSION] [--dry-run]
ralph update --install-root <install-root> [--manifest <manifest>]
  [--channel nightly|beta|stable] [--to-version VERSION] [--check] [--dry-run]
ralph update --install-root <install-root> --manifest <older-manifest>
  --to-version VERSION --allow-downgrade
ralph rollback --install-root <install-root> [--to-version VERSION] [--dry-run]
ralph uninstall <install-root> [--dry-run]
```

`RALPH_INSTALL_ROOT` substitui `--install-root` quando não há argumento posicional. Uma engine
iniciada pelo launcher recebe ainda `RALPH_STANDALONE_INSTALL_ROOT`, usado apenas como fallback de
composição depois da flag, do argumento e da variável pública. Apenas `install` e `uninstall`
aceitam o root posicional; scripts externos de `update` e `rollback` devem informar a opção ou
`RALPH_INSTALL_ROOT`, enquanto o artifact iniciado por seu próprio launcher já conhece o root.
O spelling `rollback preview|apply` continua reservado ao rollback de checkpoint/workspace, enquanto
`rollback` sem subcomando reativa uma versão instalada.

## Update

Update resolve a origem antes de qualquer mutação:

- standalone usa release manifest e layout versionado;
- o wrapper npm compõe `kind/packageName` e `packageManager: unknown` antes de carregar a engine; o
  handler não infere qual ferramenta realizou a instalação nem inventa sintaxe para ela antes de
  exigir um install root; essa metadata nunca autoriza executar um comando externo;
- o entrypoint source de um checkout dev é classificado pelo composition root e por sentinelas do
  repositório, fornecendo diagnóstico com comando Git antes de exigir install root, sem executar Git;
- origem desconhecida falha com instrução, sem tentar adivinhar.

Um `--manifest`, `--install-root`, `RALPH_INSTALL_ROOT` ou root fornecido pelo launcher seleciona
explicitamente o fluxo standalone. A origem npm/dev só é usada quando esses seletores estão ausentes
e serve exclusivamente para falhar com a orientação correta; ela não concede authority de mutação.

O fluxo preserva a versão atual até a ativação. Falha de download/verificação remove somente o
staging identificado. Falha depois da troca do pointer restaura o pointer anterior. O comando não
remove versões antigas em uso; retention é operação separada e limitada pelo receipt.

Downgrade exige flag explícita, manifest compatível e aviso sobre schema/state. Update nunca migra
workspace automaticamente. Migrations de state continuam sob o CLI com backup e ledger próprios.
`update --check` também faz preflight completo em staging — manifest, target, payloads,
checksums, SBOM, promotion record e assinatura/policy quando declarada — e remove o staging sem
ativar nada; não confunde metadata declarada com autenticidade verificada. Se `--check` e
`--dry-run` forem combinados, `--check` continua sendo a operação mais forte: a composição local
de trust é carregada e o preflight completo permanece obrigatório, ainda sem ativação.

## Rollback

Rollback lista versões verificadas pelo receipt e apresenta preview. A ativação troca apenas
`current.json`; não altera PRD, `.ralph`, config global ou credential store. Se a versão anterior
não suportar o schema de state atual, o comando recusa e aponta para backup/migration compatível em
vez de iniciar em condição desconhecida.

## Uninstall

Uninstall exige install root identificado e confere pointer, receipt, hashes e ownership antes de
agendar qualquer remoção. A composição empacotada copia um helper mínimo para um diretório próprio
do Ralph sob o temp do sistema, grava uma requisição exclusiva e entrega separadamente token e
SHA-256. O helper espera engine e launcher encerrarem, confirma que executa fora do install root,
retoma o mesmo lock e revalida token, request, install ID, geração, receipt e tree delimitada.
Somente então cria journal retomável e remove os paths enumerados pelo receipt. Isso evita apagar o
executável em uso no Windows; ausência do helper falha antes de mutar a instalação. A requisição é
retida em falha para retomada idempotente e removida após conclusão; a cópia externa pode permanecer
no temp para limpeza posterior do sistema, pois um `.exe` não pode apagar a si próprio no Windows.

Por default remove somente launcher, pointer, versões, staging, rollback e receipts pertencentes ao
mesmo install ID. Preserva:

- qualquer `.ralph` em projetos;
- configuração global do usuário;
- credential refs e keychain/vault;
- caches externos não declarados no receipt;
- checkout e dados do Ralph clássico fora do install root.

Remoção de config/credentials exige flags separadas, confirmação explícita e target enumerado. Um
uninstall nunca usa path amplo, glob, `$HOME`, `~`, root de drive ou diretório de workspace como
alvo recursivo.

A superfície atual não oferece flags de remoção de config/credentials: portanto esses dados são
sempre preservados. Uma extensão futura só poderá adicioná-las como operações separadas e explícitas.

### Identidade única e substituição da instalação anterior

O launcher standalone já se chama `ralph`; não há alias, nome temporário ou segundo binário público.
O instalador continua restrito ao install root informado e nunca procura ou remove outro `ralph` pelo
`PATH`. Por isso a troca de uma instalação clássica é uma operação externa explícita: inventarie o
comando resolvido, remova-o com seu instalador/package manager original, instale a v2 e confirme que
a resolução aponta somente para o novo artifact. O protocolo completo está em
[28 — Drills de release, beta e handoff](28-release-drills-beta-e-handoff-s12.md).

## Pacote npm

O package publicável contém bundle, launcher JS, schemas, skill, templates, LICENSE e notices. Não
inclui tests, fixtures pagas, secrets, raw logs, workspace state ou snapshot OpenCode desnecessário.
O `bin` do pacote é exclusivamente `ralph`; npm, pnpm e Bun não recebem um segundo nome de comando.

Install/update npm não finge controlar atomicidade do package manager. O CLI detecta a origem e o
nome do pacote, mas não infere qual ferramenta o instalou e, quando ela é desconhecida, não sugere
uma sintaxe: exige que o operador use a mesma ferramenta que já possui a instalação. O Ralph não
executa o comando externo.

## Composição de artifacts

`scripts/package-release.ts` compõe o diretório standalone e `scripts/package-npm.ts` compõe um
tarball npm com prefixo `package/`. Ambos falham fechados sem licença própria, commit completo,
source fingerprint, metadata/hashes coerentes e license metadata das dependências runtime. O
ambos os packagers também recompõem em memória o catálogo único de schemas e recusam qualquer
arquivo ausente, extra ou semanticamente stale; hoje são 59 outputs. Eles nunca geram ou corrigem
schemas silenciosamente durante packaging. O
standalone inclui metadata separada da engine e do launcher, tar determinístico por target,
`SHA256SUMS`, `SBOM.cdx.json` no perfil bounded CycloneDX 1.6, a árvore `schemas/`, notices e a skill tanto no bundle
quanto no payload explícito `ralph-loop-prd-generator.tar`. Esse tar separado preserva a pasta
canônica `ralph-loop-prd-generator/` e inclui também `LICENSE` e
`THIRD_PARTY_NOTICES.md` no próprio root, para não depender de arquivos irmãos quando distribuído
isoladamente. O npm exige um nome de package explícito e preserva
somente o bin `ralph`.

O standalone rotula releases não-stable sem promotion record como `packaged-not-tested`; um record
validado contra R001–R079, support hashes, archives e ambientes exatos pode fazê-lo produzir
`packaged-tested`. Para `stable`, a passagem final continua impossível sem record e signer; a
primeira passagem usa o estado separado `candidate-only`, nunca um manifest incompleto. O npm possui
contrato separado porque o subject é o `.tgz`, não um target
standalone: `npm-release-binding.json` v1 vincula identidade/channel/dist-tag, source, tarball,
manifest/bundle/metadata/checksums e SBOM/provenance/license/notices. Sem um
`npm-promotion-record.json` v2 e um `release-candidate-receipt.json` standalone independente
validados contra esses bytes, permanece `packaged-not-tested`. A promoção base v3 é revalidada
contra o `promotionCandidate` do receipt, nunca contra campos derivados do próprio record.
`artifactRefs` vinculam somente arquivos do candidato; `evidenceRefs`, receipts/logs externos por
SHA-256. Evidence runtime declara ambiente real tipado, e install drill do `.tgz` exato cobre cada
OS/arquitetura da promoção base com versões de Bun e de um package manager suportado.
O support binding inclui também `supportPolicySha256`; targets ausentes do subconjunto `included`
continuam visíveis como `not-promoted` no manifest, mas nunca recebem artifact ou attestation.

O standalone `stable` também opera em duas passagens. A primeira repete os inputs finais, escolhe um
`publishedAt` fixo que ainda esteja mais de cinco minutos no futuro no commit e acrescenta somente
`--candidate-only`. Seu output `-candidate` contém os support files, skill tar, engine, launcher,
metadata e tar por target, além de `SHA256SUMS`, `release-candidate-receipt.json` e
`package-result.json`; não contém `ReleaseManifest`, promotion ou assinatura. Esse receipt é também
o input obrigatório `--release-candidate-receipt` da passagem npm promovida. O receipt
`publishable: false` expõe exatamente source, policy/support binding e os cinco hashes por target que
o `ReleasePromotionRecord` v3 deve vincular. A segunda passagem remove o flag, usa exatamente os
mesmos inputs/`publishedAt` e acrescenta `--promotion-record` e `--signature-config`. O skill tar e
os archives por target precisam conservar hashes byte-idênticos. O final lê o record por handle com
identidade/limite estáveis e o revalida, depois do signer e antes do rename, quando `publishedAt` está
entre cinco minutos e um segundo no futuro. Imediatamente antes do commit, o packager compara o
inventário completo do staging com a união exata dos payloads cobertos por `SHA256SUMS`, o próprio
arquivo de checksums, o manifest e a assinatura opcional; arquivo extra, ausente ou sidecar não
vinculado bloqueia a promoção. Perder a janela exige novo candidato e evidências.

`candidate-only` é um gate do fluxo Ralph, não DRM: um operador que ignore receipts ainda consegue
copiar ou distribuir os archives tecnicamente válidos. Há ainda uma janela local mínima entre a
última verificação e o rename em que um mutador com a mesma autoridade pode agir; hashes, staging
privado e releitura detectam substituições observáveis, mas não criam isolamento contra principals
equivalentes.

O source possui agora paths externos, provider-neutral e versionados para signer e verifier. O
signer v1 aceita tanto `sign-release-manifest` quanto a operação explícita
`sign-release-subject`/`npm-release-binding`; adapters que não implementam a operação falham
fechado. O binding externo evita o ciclo de colocar dentro do tarball uma declaração sobre seu
próprio hash e conserva o promotion receipt e a cópia content-addressed do receipt standalone no
subject assinado. Os payloads deste são validados no diretório standalone de origem. Ainda assim,
nenhum adapter, chave, identidade ou trust root concreto foi escolhido e nenhuma assinatura foi
produzida. A passagem final `stable` npm falha antes do commit sem promotion record próprio e
assinatura; a única passagem sem esses sidecars é `stable --candidate-only`, gravada em output
separado, explicitamente `publishable: false` e sem release binding. A promoção real permanece
bloqueada pelos gates de licença, promotion evidence, configuração
independente de confiança, prova executável e limitações de plataforma. O checklist e o handoff
único estão em
`docs/26-release-gates-e-handoff-s12.md`.

Como o promotion record npm precisa vincular o `.tgz` exato, a operação promovida é deliberadamente
de duas passagens. A primeira usa `stable --candidate-only`, produz output `-candidate` com
`npm-candidate-receipt.json`, `publishable: false` e `publishedAt` fixo mais de cinco minutos no
futuro também no instante do commit, sem binding,
promotion ou assinatura. Os gates geram evidência sobre seu hash; a segunda remove o flag, repete
exatamente os mesmos inputs e inclui o record, `--release-candidate-receipt` e a assinatura externos.
O receipt é lido como arquivo regular UTF-8 bounded e estável; identidade/status,
`promotionCandidate` e payloads relativos à origem são validados. Sua cópia entra no inventário e no
binding assinados, mas não no `.tgz`, preservando a identidade entre passagens. O `PROVENANCE.json` interno
continua `candidate-only` nas duas passagens porque somente o binding externo promove os bytes. O
tarball repetido precisa conservar o mesmo SHA-256. Record, attestations e reviews antecedem o
instante planejado, e a passagem final ocorre entre cinco minutos e um segundo antes dele, com nova
validação imediatamente antes do commit. Perder a janela exige novo candidato e novas evidências;
timestamps, hashes ou records nunca são corrigidos por inferência.

Os packagers standalone e npm instalam handlers command-owned de SIGINT/SIGTERM em duas fases. O
primeiro sinal interrompe cooperativamente a operação, propaga `AbortSignal` ao signer supervisionado
e impede novos efeitos; um segundo sinal força o encerramento das árvores registradas. Checkpoints de
cancelamento protegem as fronteiras longas e ficam imediatamente antes de cada rename que promove o
staging. Antes do commit, falha ou cancelamento remove a operação temporária; cancelamento retorna
exit 130, enquanto erro operacional normal retorna 1. Se o rename já ocorreu, o artifact promovido é
preservado e uma falha posterior é reportada como pós-commit. Tar/gzip e verificações Git não expõem
`AbortSignal` próprio e, portanto, observam o
cancelamento entre awaits; essa limitação precisa entrar no drill futuro em vez de ser descrita como
preempção imediata.

## Segurança e observabilidade

- redigir URL query/headers e nunca logar token de registry;
- aceitar credential somente por store/env/ref apropriado, não argv;
- limitar redirects, bytes, tempo e content type;
- usar TLS/HTTPS e hash obrigatório; assinatura é camada adicional;
- persistir receipt/diagnóstico sem dados secretos;
- emitir estados `planned`, `staged`, `verified`, `persisting-control-state`, `activated`,
  `rolled-back`, `uninstalling`, `removing-control-state`, `failed`;
- não tratar `built-not-tested` como suporte real da plataforma;
- manter operação cancelável e reconciliável após crash em cada fronteira.

## Validação local executada e drill de release pendente

`EV-S12-DIST-8` executou o alias `bun run test:s12:distribution` de forma oculta no host Windows x64
com Bun 1.3.14: 8/8 testes, 91 asserções, zero falhas em 3,71 s. O harness usa manifests e payloads
temporários sintéticos, `channel: nightly`, versões `*-dev.1`, assinatura indisponível explícita e
limitation de `local contract only`; ele não escolhe licença, signer, trust root ou support target do
produto.

A prova cobre:

- install CLI dry-run sem mutação e install local real com staging, tamanho/SHA-256, metadata,
  pointer e receipt;
- origem HTTPS por transporte fake allowlisted sem rede;
- adulteração de tamanho, hash e metadata recusada antes da ativação;
- `update --check`, update para segunda versão preservando launcher e engine versionada anterior,
  downgrade/schema incompatível e rollback receipt-bound;
- launcher adulterado, incompatibilidade de launcher schema e estado `repair-required` explícito,
  sem alegar repair executado;
- fault injection e recovery em `planned`, `staged`, `verified` e `activated`, com journals válidos;
- uninstall dry-run, handoff por scheduler e helper externo, removendo somente paths do receipt e
  preservando workspace `.ralph`, config, credential ref, Ralph clássico e sentinelas adjacentes.

A primeira execução sob o TEMP default de `C:` foi bloqueada corretamente por
`RALPH_INSTALL_ROOT_IS_CHECKOUT`: existe `C:\.git` neste host, logo roots temporários abaixo do drive
seriam internos a um checkout. O rerun definiu `TEMP`, `TMP` e `TMPDIR` como
`D:\Temp\ralph-v2-distribution-tests` e passou. Evidência verde:
`D:\Temp\ralph-v2-distribution-tests\s12-distribution-rerun-hidden-20260719-201340-718-60744.stderr.log`.

Continuam pendentes em S12.09 o mesmo lifecycle sobre artifacts candidatos reais e content-addressed,
binary de release realmente em uso, target incorreto/targets externos, package npm em diretório
temporário, assinatura/trust/promotion e repetição por plataforma. Nenhum resultado local desta seção
muda `built-not-tested` para `tested`, nem transforma a fixture em suporte ou release drill.
