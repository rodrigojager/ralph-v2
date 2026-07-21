# 25 — Guia do operador e desenvolvedor do Ralph v2

## 1. Autoridades e fronteiras

O composition root do CLI conecta módulos por ports. As fronteiras obrigatórias são:

- `commands`: parser, precedência, UX headless e despacho;
- `orchestration`: scheduler, attempts, child/parallel, políticas e conclusão;
- `domain`: schemas e transições puras;
- `persistence`: workspace, ledger, leases, outbox, receipts e migrations;
- `providers`/`model-drivers`: chamadas de modelo sem acesso ao estado oficial;
- `tool-host`: efeitos autorizados e settlements, sem conclusão de task;
- `verification`/`evaluation`: evidence, gates e parecer read-only;
- `supervisor`: processos, cancellation, heartbeat e watchdog;
- `telemetry`: eventos/redaction/usage;
- `tui`: projeção e cliente de comandos, nunca regra exclusiva;
- `distribution`/launcher: instalação e seleção de engine, sem PRD/provider/config authority.

Uma mudança que permite a provider, tool, TUI, launcher ou texto do modelo persistir conclusão viola
a arquitetura mesmo que produza uma demo funcional.

## 2. Estado durável e crash recovery

SQLite é a autoridade transacional de runs, tasks, attempts, leases, watchdog, children, claims e
outbox. `events.jsonl` e reports são projeções reconstruíveis. Toda fronteira crítica usa prepare /
effect-or-marker / commit e conserva informação suficiente para reconciliar:

- attempt ou tool iniciada sem settlement;
- gate/judge respondido antes do commit;
- completion preparada antes/depois do marker;
- child reservado antes/depois do spawn;
- task paralela integrada ou em conflito;
- operação de instalação staged/verified antes/depois do pointer.

Nunca corrija uma divergência apagando o ledger ou escolhendo o PRD cegamente. Hash, operation ID,
lease fence e evidence determinam a recuperação.

## 3. Evolução de schemas e eventos

Validators runtime são a fonte primária. JSON Schemas gerados, parser, examples, skill e docs devem
permanecer sincronizados. Uma mudança de schema exige:

1. versão/discriminante explícito;
2. compatibilidade de leitura ou migration separada;
3. fixture do formato antigo;
4. limite de bytes/profundidade/quantidade;
5. redaction antes da persistência;
6. atualização da matriz de rastreabilidade;
7. prova no menor nível e no fluxo vertical, registrando ambiente, artifact e resultado exatos.

Eventos públicos são append-only. Adicione um tipo/versionamento novo em vez de reinterpretar bytes
antigos. Replay deve produzir a mesma projeção dentro do schema suportado.

### Fake kit e composition root de testes

O fake de execução é uma dependência de desenvolvimento exportada por
`@ralph/test-kit`; ele não é provider, profile nem backend registrado pelo produto. A API
concreta é `ScriptedExecutionBackend`, construída com uma fila de `ScriptedExecution`. Cada item
pode declarar `expectedTask`, ações relativas `write|append`, `outcome`, `delayMs`, `failure` ou
`failureAfterActions`:

```ts
import { runCli } from "@ralph/commands"
import type { ExecutionBackendResolver } from "@ralph/orchestration"
import { ScriptedExecutionBackend, type ScriptedExecution } from "@ralph/test-kit"

const steps: ScriptedExecution[] = [
  {
    expectedTask: "root/note-create-flow",
    actions: [{ type: "write", path: "result.txt", content: "fixture\n" }],
  },
]
const backend = new ScriptedExecutionBackend(steps)
const resolveBackend: ExecutionBackendResolver = (profile) =>
  profile === "fixture-executor" ? backend : undefined

process.exitCode = await runCli(process.argv.slice(2), {
  version: "0.0.0-test",
  cwd: process.cwd(),
  environment: process.env,
  resolveBackend,
})
```

O composition root de teste é quem escolhe o profile reservado e injeta o resolver. A referência
executável do repositório está em `tests/support/fixture-cli.ts`; `RALPH_TEST_BACKEND_SCRIPT` pertence
somente a essa fixture e nunca é lida pelo entrypoint normal. O fake informa usage como
`unavailable`, não oferece tool calling interno e conserva cancellation pelo contrato do backend.
`expectedTask` prova a seleção feita pelo scheduler; não permite ao fake escolher a task. Sem
`outcome`, o backend produz `work_submitted` com os paths das ações em `intendedFiles`.
`remaining()` informa quantos passos ainda estão na fila e `requests()` devolve um snapshot das
requisições recebidas para assertions do composition root.

As ações aceitam somente paths relativos dentro do workspace. Paths absolutos, escape por ancestral
ou symlink, o próprio target quando é symlink, `.git`, `.ralph` e paths protegidos são recusados. O
fake pode produzir arquivos e eventos de prova, mas não recebe ledger, não atualiza marker e não
persiste conclusão. O entrypoint normal não importa nem registra `@ralph/test-kit`; portanto
`--executor-profile fake` precisa continuar
indisponível no produto e nos artifacts de release. Acrescentar novos comportamentos ao kit exige
manter essa separação e cobrir a composição de teste, a rejeição no produto e os limites de path.

## 4. Refresh curado de provider/OpenCode

O snapshot de upstream é fixo por commit. Para atualizar:

1. crie `vendor/opencode-<commit>`;
2. confira licença/copyright no commit candidato;
3. compare cada arquivo da positive inventory;
4. revise mudanças de auth, protocolo, tool/event e advisories;
5. porte somente os módulos necessários atrás dos ports Ralph;
6. atualize `UPSTREAM.md`, `copied-files.md`, `patches.md`, hashes e notices;
7. verifique ausência de session runner, server, storage, plugin host, branding e private packages;
8. execute a matriz provider/auth/catalog e smoke real somente como operação opt-in explícita, com
   credencial e custo autorizados pelo operador;
9. registre rollback commit e reviewer.

Release nunca baixa source do OpenCode nem segue branch/tag flutuante.

### OpenRouter Responses API

O adapter embutido de OpenRouter é código próprio do Ralph orientado pela documentação oficial da
Responses API; ele não é uma cópia adicional do OpenCode. O endpoint de produto permanece fixado em
`https://openrouter.ai/api/v1/responses` e não aceita `base_url` arbitrária em configuração, para que
uma alteração de workspace não consiga redirecionar a credencial. A API está documentada como beta;
por isso mudanças em endpoint, autenticação, formato de erro, eventos de streaming, tool calls,
reasoning ou usage não entram como atualização mecânica.

Antes de atualizar esse contrato:

1. compare a implementação com a [visão geral oficial da Responses API](https://openrouter.ai/docs/api/reference/responses/overview) e a [referência oficial de streaming](https://openrouter.ai/docs/api/reference/streaming);
2. registre quais shapes/eventos mudaram e preserve fixtures antigas como versões de protocolo;
3. revise redaction, retry/fallback e a fronteira entre efeito possível e transporte falho;
4. mantenha model IDs e credential kinds validados antes de qualquer request;
5. faça smoke real somente como opt-in explícito, sem transformar ausência de smoke em suporte
   comprovado;
6. registre rollback e reviewer como em qualquer refresh de provider.

Modelos Anthropic acessados por um ID do catálogo OpenRouter continuam sendo chamadas OpenRouter;
isso não equivale a possuir um driver Anthropic nativo.

## 5. Credenciais e incidentes de auth

Config contém somente `CredentialRef`. Segredo pertence ao Windows Password Vault, macOS Keychain,
Secret Service ou store explicitamente autorizado. Em incidente:

1. pare novas calls sem apagar evidence;
2. revogue/remova a referência local;
3. rotacione no provider quando houver endpoint suportado;
4. procure somente indicadores redigidos em eventos/reports;
5. invalide artifacts/logs que tenham canary confirmado;
6. registre provider, credential ID, intervalo e versão — nunca o valor;
7. corrija redaction antes de retomar.

Fallback de auth nunca muda de conta/API key silenciosamente.

### Profiles completos pela TUI

A paleta `providers/models/auth/profile` separa duas operações. As três primeiras abas escolhem
somente uma rota de catálogo `embedded`; a aba `profile` edita o contrato completo do executor ou
juiz, incluindo external CLI, fallbacks, requirements e limits. Use `t` para o papel, `s` para
global/workspace, `i` para voltar ao valor herdado, `d` para limpar campo opcional, `Enter` para
definir e `f` para decidir se o profile deve também virar default do papel. `w` e `g` confirmam o
escopo de persistência.

O popup nunca escreve config diretamente: ele devolve o profile tipado ao handler `profiles
configure`, que recompõe catálogo/credenciais/fallback graph e faz a mutação atômica. Salvar sem
`set-default` preserva o pointer existente; salvar com ele atualiza profile e pointer juntos.
Provider/model externos não precisam existir no catálogo embedded, mas suas capabilities declaradas
precisam satisfazer requirements. Attach/replay não altera o snapshot da run observada.

## 6. Operação do supervisor e watchdog

Status combina ledger, lease, heartbeat, progress signal, process identity e deadlines. Classifique:

- `active`: atividade recente;
- `quiet`: sem output, mas dentro dos limites e com sinais saudáveis;
- `slow`: atraso/retry-after ou fase longa observável;
- `suspected-stall`: múltiplos sinais vencidos;
- `stalled`: confirmação suficiente para recovery;
- `hard-timeout`: budget absoluto excedido.

Antes de matar um worker, confira child ativo, CPU/IO/process identity, tool deadline e provider
retry-after. PID isolado não prova identidade. Restarts são bounded e separados de retry/model call.
O hard timeout continua absoluto mesmo diante desses sinais positivos, mas uma ação destrutiva só é
entregue depois de o deadline excedido aparecer no número configurado de probes `confirmations`;
uma única leitura de relógio não fabrica múltiplas confirmações.

## 7. Paralelismo, Git e conflito

O scheduler usa dependências, parallel groups, file/resource claims e capacidade local/global.
Workers recebem leases fenced e, quando configurado, worktree/branch próprios. A integração:

- confirma base e head esperados;
- registra commit/patch/evidence antes do efeito;
- serializa a branch alvo;
- pausa em conflito;
- nunca resolve com reset/clean/checkout destrutivo;
- mantém worktree e instructions de recovery.

`create-pr` prepara metadata/branch; publicação externa exige credencial e autorização próprias.
O composition root só instala essa capacidade quando `RALPH_PULL_REQUEST_ADAPTER_CONFIG` aponta
para o contrato provider-neutral documentado em
[13 — Paralelismo, Git, sandbox e segurança](13-paralelismo-git-sandbox-e-seguranca.md).
O executável é hash-bound, recebe request bounded por stdin e deve ecoar chave de idempotência,
`requestBinding` integral e source HEAD. Segredos só entram por `environmentRefs`; argumentos
literais secret-like são inválidos. Sem adapter válido, a estratégia falha fechado.

## 8. Distribuição standalone

Layout e schemas estão em `packages/distribution`; o launcher mínimo fica em
`apps/ralph-launcher`. O launcher valida `current.json`, o receipt geracional imutável apontado por
path e SHA-256, install ID, geração, paths regulares, containment e hashes antes de iniciar a
engine. Não existe um segundo arquivo de controle mutável equivalente a `install.json`.

Cada operação usa journal:

```text
planned -> staged -> verified -> activated
                                -> failed
                                -> rolled-back
```

Versões sob `versions/<semver>` são imutáveis. Download ocorre em staging identificado por
operation ID; materialização e pointer usam rename/replace durável. Um crash é reconciliado pelo
journal, sem adivinhar arquivos por glob. Uninstall remove somente paths do receipt pertencentes ao
mesmo install ID e preserva `.ralph`, config, credentials, checkout clássico e executáveis externos.

## 9. Release e provenance

Uma release só pode ser promovida quando contém:

- engine e launcher por target;
- build metadata e source fingerprint;
- evidence status honesto por target;
- manifest schema v2 com `ReleaseSupportPolicy` v1 completa e hash canônico;
- SHA-256/tamanho de cada payload;
- LICENSE própria;
- `THIRD_PARTY_NOTICES.md` e licenças carregadas;
- SBOM;
- assinatura/provenance ou indisponibilidade explícita;
- skill, templates e referências;
- documentação e samples autocontidos referenciados pelo README distribuído: `docs/`, `examples/`,
  `implementation/`, `skill-contract/`, `AGENTS.md`, `DEVELOPMENT.md` e `PRD.md`;
- catálogo público `schemas/` completo e atual, validado antes de qualquer cópia para o artifact;
- changelog e known limitations.

`built-not-tested` nunca vira `tested` por ter sido compilado em outra plataforma. O packager deve
falhar se a licença própria estiver ausente ou se qualquer hash/metadata/source fingerprint divergir.

O checklist de licença possui duas fontes distintas e ambas são obrigatórias. Primeiro, o
`SBOM.cdx.json` serializado governa o inventário de dependências npm: cada componente exato precisa
ter texto `LICENSE|LICENCE|COPYING` real no Bun store, notices correspondentes e receipt SHA-256 em
`third_party/licenses/manifest.json`; expressão no `package.json` não substitui texto. Segundo, um
standalone incorpora o próprio Bun e exige curação local separada em
`third_party/bun/runtime/<version>/<revision>/CURATION.json`, vinculada à mesma versão/revisão de
engine e launcher metadata. O conteúdo precisa ser completo, bounded, regular, totalmente
manifestado e incluir licença/copying mais proveniência. O packager não baixa nem sintetiza nada.

Ao preparar essa curação, o operador deve obter os materiais da fonte oficial fora do packager,
registrar responsável/data/repositório/revisão, calcular tamanho e SHA-256 de cada arquivo, revisar
as obrigações e só então adicionar o bundle deliberadamente. Arquivo extra, symlink, texto vazio,
hash divergente, variantes peer divergentes ou Bun revision diferente são blockers, não warnings.
O manifest de inventário prova quais bytes acompanharam o artifact; não é parecer jurídico nem
declaração automática de compliance.

O universo permanece com seis targets em toda policy. Para cada versão/channel, o release owner
fornece explicitamente `included` ou `not-promoted`; a segunda forma exige motivo. `included`
autoriza empacotamento, não é alegação de suporte. O packager exige `--support-policy`, equality
exata com os `--target` e capability real; o promotion record schema v3 vincula o mesmo policy hash
e exige a matriz completa R001–R079.
Windows permanece `reduced` e não pode ser incluído em `stable` sem uma nova primitive versionada e
prova correspondente. Não omita linhas nem edite capability para contornar o gate.

### Signer e verifier externos

O Ralph não escolhe tecnologia, serviço, linguagem, chave ou identidade de assinatura. O standalone
expõe dois adapters app-owned e provider-neutral, deliberadamente separados:

- `ralph-release-signature-signer-v1`, usado por `scripts/package-release.ts` para
  `sign-release-manifest` e por `scripts/package-npm.ts` para
  `sign-release-subject`/`npm-release-binding`, sempre através de `--signature-config`;
- `ralph-release-signature-verifier-v1`, carregado pelo CLI através de
  `RALPH_RELEASE_VERIFIER_CONFIG` junto de uma trust policy local.

O signer config é um JSON estrito e bounded contendo executable, argv fixo, timeout,
`forwardEnvironment` apenas com nomes e o descritor público `kind`/`identity`/`mediaType`/limite. O
processo recebe um diretório temporário privado, ambiente allowlisted e argv exato sem shell. Ele
escreve assinatura e result nos arquivos privados pré-criados indicados pelo request; substituir
esses arquivos, exceder o limite, mudar sua identidade, retornar outro kind/identity/hash/tamanho,
emitir result fora do schema ou exceder timeout falha fechado. A árvore inteira é encerrada no
cancelamento/timeout e stdout/stderr não são promovidos a log ou handoff.

O packager standalone calcula `signedManifestSha256` pela projeção de
`canonicalReleaseManifestSigningBytes`, que omite somente o próprio digest e conserva descritor,
kind e identidade alegada. O result do signer também vincula SHA-256/tamanho do envelope; o Ralph os
recalcula antes da cópia e revalida o receipt até o commit do package. `nightly`/`beta` podem usar
esse caminho ou indisponibilidade explícita; a passagem final `stable` exige signer e promotion
record. `dev` não é canal de artifact assinado. Para quebrar o ciclo de evidência, a primeira
passagem `stable --candidate-only` proíbe promotion e todas as opções de assinatura, usa output
`-candidate`, grava `publishable: false` e produz somente os support files, skill/target archives e
receipts necessários ao `ReleasePromotionRecord`, sem `ReleaseManifest`. Com os mesmos inputs e
`publishedAt`, os archives dessa passagem precisam ser byte-idênticos aos da final.

O candidato precisa conservar `publishedAt` mais de cinco minutos no futuro até seu commit. Depois
do signer, a passagem final relê e revalida o promotion record com relógio novo imediatamente antes
do rename, aceitando apenas a janela de cinco minutos a um segundo anterior à publicação planejada.
O operador compara os hashes dos archives entre as passagens e reinicia o ciclo se perder a janela.
O flag disciplina o fluxo Ralph, mas não é DRM: quem ignorar `publishable: false` ainda pode copiar
bytes tecnicamente distribuíveis. Staging e revalidações também não eliminam a janela local mínima
para um mutador concorrente com a mesma autoridade entre a última verificação e o rename.

No npm, a projeção `canonicalNpmReleaseBindingSigningBytes` autentica package name/version,
channel/dist-tag, source, tarball e todos os support hashes, mais os receipts exatos da promoção e do
candidato standalone quando presentes. O segundo fornece o `promotionCandidate` independente contra
o qual a promoção base v3 é revalidada; é validado com seus payloads na origem, copiado como sidecar
e incluído no inventário e no subject assinado sem alterar o `.tgz`. A operação provider-neutral usa
`subjectKind: npm-release-binding` e o result devolve
`signedSubjectSha256`; kind/identity e hash/tamanho do envelope continuam sendo conferidos. O
tarball não contém o binding externo para não criar auto-referência. `stable` falha fechado sem
`NpmReleasePromotionRecord` v2, receipt standalone independente e assinatura; isso não fornece nem substitui trust policy do
consumidor. A primeira passagem `stable --candidate-only` é a exceção deliberadamente
não-publicável: usa output separado, não aceita nenhuma opção de assinatura/promoção e não cria um
release binding que possa ser confundido com aprovação.

No consumo, o verifier nunca recebe diretamente o path mutável do staging: o Ralph lê o envelope
por handle, confere identidade/limite/hash, cria snapshot privado e fornece ao adapter o manifest
canônico, kind/identidade alegada, media type, tamanho e SHA-256. O result v1 devolve kind,
identidade verificada, issuer opcional, `signedManifestSha256` e `signatureSha256`. O installer
compara tudo e aplica uma policy local independente para kind, channel, origin, identity e issuer.
Manifest, signer config ou output do próprio signer nunca criam trust root.

Ao integrar um adapter concreto:

1. mantenha config de signer e config/policy de verifier separadas;
2. armazene material secreto fora dos JSONs e encaminhe somente por variável explicitamente nomeada
   ou mecanismo próprio do executável escolhido;
3. não inclua valores secretos em argv, stdout, stderr, manifest, promotion record ou handoff;
4. registre versão do protocolo, identidade esperada, rotação/revogação e owner da policy;
5. prove assinatura, adulteração, identidade/issuer incorretos, timeout, cancelamento e árvore filha
   no artifact exato quando validação executável voltar a ser permitida;
6. preserve rollback e nunca trate o sucesso do signer como substituto da verificação independente.

## 10. Canais e rollback

- `dev`: source checkout;
- `nightly`: integração contínua sem promessa de suporte;
- `beta`: `ralph`, rollback obrigatório;
- `stable`: subconjunto `included` explicitamente escolhido, demais seis-target entries
  `not-promoted` com motivo, e gates completos.

Todos os canais publicam o mesmo comando `ralph`; não existe alias de transição.

O binding de versão é obrigatório: `dev` requer prerelease iniciado por `dev`; `nightly` aceita
prerelease iniciado por `nightly` ou `dev`; `beta` requer `beta`; `stable` proíbe prerelease.
Metadata `+...` não muda o canal. No npm, os únicos bindings de `dist-tag` são respectivamente
`dev`, `nightly`, `beta` e `latest`; qualquer divergência bloqueia o empacotamento. A versão atual
`0.1.0-beta.2` pode ser usada somente no canal `beta`, nunca em `dev`, `nightly` ou `stable`.

Rollback de engine troca somente o pointer para uma versão receipt-bound compatível. Rollback de
workspace é outra operação, com preview/hash/expiração. Nunca misture os dois.

O corte para a v2 inventaria a instalação clássica, remove-a explicitamente por seu mecanismo de
origem, instala o novo `ralph` e verifica toda a resolução do `PATH`. Campanha beta, diagnostics
locais e rollback seguem o worksheet
[28 — Drills de release, beta e handoff](28-release-drills-beta-e-handoff-s12.md).

## 11. Matriz de validação

S11 possui quatro classes de evidência e elas não são intercambiáveis:

- source/contract review;
- compile/build;
- mock/fixture integration;
- real runtime/platform/provider smoke.

Cada linha R001–R079 precisa de link/ID de prova ou waiver aprovado. Skip é estado explícito. A
validação local parcial não marca automaticamente nenhuma linha como pass: cada requisito ainda
precisa do vínculo ao artifact, ambiente e evidence exigidos pela matriz.

A ordem segura de fechamento é:

1. validações focadas por módulo;
2. integration vertical;
3. kill/resume/watchdog/security/PTY;
4. compatibility;
5. package/install/update/rollback/uninstall por plataforma;
6. providers/auth reais opt-in;
7. suíte completa e release gate.

## 12. Incidentes comuns

### Ledger ou outbox divergente

Pare nova execução, preserve arquivos, capture hashes, rode apenas inspectors read-only, identifique
a última transaction e reconcilie pela migration/repair específica. Não edite SQLite/JSONL à mão.

### Completion marker divergente

Use a completion receipt/prepared record. Não marque a próxima task antes de confirmar evidence,
marker hash e commit transacional.

### Tool unsettled

Trate efeito externo como possivelmente ocorrido. Não repita em outro provider. Reconcile por
idempotency key ou ação humana e persista a decisão.

### Child órfão

Valide parent/child run IDs, lease fence e heartbeat. Retome o child antes do pai; só crie outro se o
record autoritativo provar que nenhum child foi materializado.

### Update interrompido

Leia o operation journal. Staging não ativado pode ser removido pelo ID exato; versão verificada pode
ser materializada; pointer trocado com receipt antigo exige restauração do pointer anterior. Nunca
apague `versions` por conveniência.

## 13. Contribution gate

Uma mudança aceitável:

1. preserva command authority e stack neutrality do projeto-alvo;
2. entrega um corte vertical, não apenas uma camada desconectada;
3. atualiza schema/doc/example/skill quando o contrato muda;
4. documenta provenance de código externo;
5. não persiste segredo ou reasoning privado;
6. tem budgets e cancellation explícitos;
7. mantém headless/TUI sobre o mesmo command/event model;
8. inclui o plano de falha/resume;
9. recebe a prova apropriada no nível e ambiente exigidos;
10. não promove suporte real com evidência apenas estática.

## 14. Handoff mínimo de uma release

Registre em um único documento:

- versão, channel, commit e source fingerprint;
- support policy schema/hash e decisão explícita das seis entries;
- artifacts/targets/hashes/evidence status;
- manifest/SBOM/notices/license/signature;
- migrations e ranges de schema/launcher;
- matriz R001–R079 e waivers;
- comandos exatos de instalação e diagnóstico;
- providers/auth testados e escopo da conta/quota;
- known issues e limitações;
- rollback da engine, workspace e vendor refresh;
- campanha beta, diagnostics/privacy/retention e triagem;
- TUI runtime, migration/rollback e substituição controlada do Ralph clássico;
- inventário do comando antigo e prova de resolução exclusiva do novo `ralph`.

Sem esses dados, o artifact pode ser um build de desenvolvimento, mas não uma release promovida.
