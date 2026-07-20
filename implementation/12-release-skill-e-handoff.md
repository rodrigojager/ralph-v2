---
task: Entregar releases documentação migração e a skill final de PRD verticalizado
engine: codex
---

# Subplano S12 — Release, skill e handoff

## Resultado do subplano

O Ralph v2 é instalável, diagnosticável e reversível. Releases carregam checksums, SBOM e notices. A skill gera PRD root e todos os children no schema final, valida pelo parser oficial e produz vertical slices neutras quanto ao stack. O nome final só é promovido após beta/gate.

## Referências obrigatórias

- `docs/06-providers-modelos-autenticacao-e-upstream.md`
- `docs/07-prd-v2-subprds-e-skill.md`
- `docs/14-compatibilidade-migracao-distribuicao-e-licencas.md`
- `docs/15-testes-qualidade-e-criterios-de-pronto.md`
- matriz S11 aprovada

## Tarefas

- [ ] S12.01 finalizar identidade/package/license próprios, versionamento/changelog/release channels, builds standalone/npm para plataformas aprovadas, checksums, signatures quando disponíveis, SBOM, LICENSE e THIRD_PARTY_NOTICES dentro de cada artifact.
- [x] S12.02 implementar/validar install e update por origem com staging, checksum, running-binary safety e rollback, além de uninstall que remove somente targets resolvidos e preserva workspace/config/credentials salvo opção explícita.
- [x] S12.03 escrever documentação de usuário com comandos exatos para init, PRD v1/v2, executor por API/env/account, ChatGPT Plus/Pro quando suportado, judge independente, modes/skips, TUI/headless, resume/watchdog, child/parallel, Git/security e troubleshooting.
- [x] S12.04 escrever documentação de operador/desenvolvedor para arquitetura, schemas/events, provider vendor refresh, auth changes, migrations, fake kit, release, incident recovery, license/provenance e contribution gates.
- [x] S12.05 atualizar/criar a skill `ralph-loop-prd-generator` a partir do schema final, mantendo linguagem/ferramenta neutras e instruindo análise por vertical slices, evidence modes honestos, dependencies/groups e geração prévia de todo sub-PRD.
- [x] S12.06 fornecer templates root/child, examples reais e script/command de validação que a skill chama após escrever arquivos; teste de skill deve gerar cenário complexo, executar `prd validate --recursive --strict` e provar parent refs/graph/criteria/artifacts.
- [x] S12.07 garantir que a skill nunca peça ao runtime/executor geração tardia de child, nunca invente critério só para satisfazer schema, prefira artifact útil declarado e permita um receipt bounded pré-declarado como último recurso determinístico quando nenhum outro entregável material existir.
- [x] S12.08 preparar sample project end to end com pequenas slices atravessando camadas, judge fake/real opt-in, reprovação/revisão, child, crash/resume e TUI; gravar report/evidence esperado sem tokens/secrets reais.
- [ ] S12.09 executar instalação limpa e migration/rollback drill em plataformas alvo, auth smoke real opt-in, TUI runtime e release artifact verification; publicar limitações reais e não converter contract-only em claim de suporte.
- [ ] S12.10 operar período beta como `ralph-next`, coletar/triage diagnostics sem telemetria invasiva, fechar blockers e aplicar checklist de corte antes de oferecer alias `ralph`; backup e retorno ao binário antigo permanecem documentados.
- [ ] S12.11 produzir handoff final com status S01–S12, matriz R001–R079, versões/commits, artifacts/checksums, comandos de instalação/uso, known issues, decisões configuráveis e processo de refresh upstream.

## Critérios de conclusão

- Artifacts instaláveis possuem checksums, SBOM, licença e notices.
- Guia cobre todas as formas de trabalho e configuração TUI/CLI.
- Skill gera root/children humanos e parser-valid sem escolher stack.
- Sample prova execução, avaliação, revisão, resume e UI.
- Migração/rollback foram realmente ensaiados.
- `ralph` só substitui `ralph-next` depois do gate e nunca remove o antigo implicitamente.

## Estado de implementação estática da skill

Sem marcar S12.05–S12.07 ou os critérios de conclusão como concluídos, o repositório agora contém
um pacote de skill real em `skills/ralph-loop-prd-generator/` com:

- `SKILL.md` conciso e trigger para projeto, cenário, issue, especificação, PRD legado ou
  reverticalização de um plano existente;
- metadata `agents/openai.yaml` sem branding copiado ou dependência externa implícita;
- referências progressivas para regras de vertical slice, formato PRD v2 e auditoria/handoff;
- referência de curadoria com fontes públicas verificáveis, padrões adotados/rejeitados e regra de
  refresh, sem copiar gramática, templates ou defaults tecnológicos externos;
- templates distintos de root e child, com autoria integral antes do run;
- workflow que preserva linguagem, framework, banco, cloud, provider, test runner e ferramentas da
  fonte, em vez de escolher stack por preferência;
- regra explícita de critérios reais, `change-only` e artifact útil como fallback; quando nenhum
  entregável natural existir, receipt bounded pré-declarado e ligado à task produz diff/hash mínimo
  sem fabricar oracle nem fingir correção semântica;
- dependencies por task ID, paralelismo somente quando seguro e Sub-PRD somente quando o resultado
  pai realmente exigir múltiplas slices internas;
- validator e inspect oficiais como autoridade; quando sua execução estiver proibida ou
  indisponível, a skill exige declarar `validação executável pendente` em vez de alegar sucesso.

O contrato de integração em `skill-contract/ralph-loop-prd-generator/` aponta para esse pacote e
continua separando `/goal`, autoria da skill e runtime do Ralph. Os packagers incluem a skill no npm
e no standalone, e o standalone também produz um tar separado com `LICENSE` e
`THIRD_PARTY_NOTICES.md`. O pacote passou no `quick_validate.py`; seu teste de contrato passou 3/3;
e o standalone atual validou/inspecionou recursivamente o sample root+child com 2 documentos,
5 slices e zero diagnostics.

Um forward test cego, executado por subagente novo sem answer key, recebeu somente um brief de
convite de membro e a localização da skill. Ele gerou root + child em diretório temporário, com
2 documentos, 7 tasks pendentes, parent/child e dependency edges, um grupo paralelo somente depois
do contrato estabilizado, o único command permitido (`project-check --scope member-invite`), um
artifact decisório útil e evidence modes proporcionais. `prd validate` e `prd inspect`, ambos
recursive/strict no standalone Windows x64, terminaram com exit 0 e zero diagnostics; nenhuma
linguagem, framework, provider, modelo, profile ou budget foi inventado. A primeira slice gerada
ficou no limite superior de tamanho ao reunir contrato, fundação reversível de persistência e ADR,
ressalva registrada para futura iteração da curadoria. A materialização dos artifacts finais de
release permanece pendente.

## Estado validado localmente do sample S12.08

`examples/vertical-notes/` contém:

- root PRD humano e um Sub-PRD previamente materializado, totalizando quatro slices folha e um pai
  composto por duas folhas;
- slices que atravessam página, API, persistência atômica, container, logs e runbook apenas quando
  essas boundaries são necessárias ao resultado observável;
- judge external-CLI fake, read-only e determinístico: ele devolve nota 72 na primeira avaliação de
  `note-create-flow` e 96 somente quando o evidence bundle contém tentativa anterior marcada
  `revision_required`, deixando threshold,
  revisão e conclusão sob autoridade do Ralph;
- provisionamento local, sem lifecycle scripts, do bin `ralph-sample-judge` no `PATH` exclusivo da
  sessão; isso permite que o binding canônico/hash-bound sobreviva ao cwd temporário vazio sem usar
  um argumento relativo ao workspace;
- template de judge real opt-in contendo apenas IDs/credential reference, nunca valor secreto;
- instruções de parada cooperativa, crash controlado, resume, attach e observação de root/child,
  score, watchdog, logs, tokens e barra de progresso na TUI;
- projeções redigidas de report/evidence marcadas `executed-local-integration`, sem IDs de execução,
  hashes reais, path externo, texto da nota, tokens ou credenciais.

O sample não prescreve a stack de projetos-alvo: `PROJECT.md` escolhe Node built-in e browser sem
framework somente como entrada concreta deste exemplo.

O forward test focado `tests/integration/s12-sample-e2e.test.ts` passou com 1/1 teste e 59 asserções.
Ele compila root+child recursivamente/strict, inicializa workspace temporário, executa todas as slices
por backend roteirizado, chama o judge fake como processo external-CLI supervisionado fora do
workspace, observa `72 -> revisão -> 96`, conclui child e parent, injeta crash após a primeira folha
duravelmente concluída e retoma o mesmo run sem replay. Também valida snapshots/views TUI de root e
child, barras, score/revisão e usage; exercita por HTTP real health, HTML, validação, create/list,
persistência após restart e logs correlacionados sem o texto da nota; confere evidence/artifacts; e
compara exatamente os dois goldens redigidos.

Essa é uma integração executável local do checkout, não uma chamada de provider real nem um drill de
release. O executor é roteirizado; o judge é fake/read-only; a TUI é validada por sua projeção de
snapshot/view, não por sessão interativa PTY; e nenhum package instalado, release candidate, auth
real ou matriz externa participa da prova. O template de judge real continua apenas opt-in. S12.08
está concluída nesse escopo sem alterar o estado aberto de S12.09–S12.11 ou alegar suporte de
provider/plataforma/release.

A fundação estática de distribuição também já contém `packages/distribution`, com schemas estritos
para channel/target/evidência, manifest, payloads/hash/tamanho, assinatura ou indisponibilidade
explícita, SBOM CycloneDX 1.6 bounded, install receipt e journal de operação; seleção determinística
do target; e paths standalone delimitados por install root/receipt. O contrato operacional está em
`docs/23-distribuicao-instalacao-update-e-rollback-s12.md`: versões e receipts imutáveis,
`current.json` como autoridade atômica única, WAL e lock interprocesso evitam controle divergente e
sobrescrita do binary em uso. Uninstall é fail-closed e usa helper externo pós-exit vinculado por
token/hash/install ID/receipt; ele só remove o snapshot de paths confirmados pelo receipt.
Download/cópia local streaming para staging, verificação, materialização, ativação/recovery,
  handlers `install|update|rollback|uninstall`, launcher inicial e preservação do launcher em update
  estão implementados estaticamente. O loader revalida no destino caller-owned containment, arquivo
  regular, tamanho e hash; renames críticos sincronizam parent directory quando suportado. Windows
  registra garantia reduzida file-fsync-only sem fingir directory fsync. Uma `ReleaseSupportPolicy`
  v1 obrigatória mantém os seis targets visíveis, exige `included` ou `not-promoted` com motivo e
  impede Windows de ser `included` em `stable` enquanto essa capability permanecer reduzida; o
  subconjunto continua sendo input externo, não default do projeto. O template versionado em
  `examples/release-support-policy.template.json` reduz trabalho manual, mas falha de propósito até
  receber versão/channel e ao menos uma escolha `included`. `update --check` faz preflight
  integral sem ativação; assinatura usa projeção canônica não circular. O main pode compor um verifier
  externo e trust policy local através de config JSON estrito, mas nenhum adapter, identidade, issuer
  ou trust root concreto é fornecido pelo repositório. O verifier opera sobre snapshot privado do
  envelope, vincula tamanho/SHA-256/media type e encerra a árvore no timeout/cancelamento. Sem uma
  configuração independente válida, manifests assinados/`stable` não são instaláveis hoje. Origens
  npm/dev são compostas antes da exigência de install root e falham com diagnóstico explícito,
  permanecendo sob autoridade do package manager/Git. O wrapper npm declara gerenciador
  `unknown` e não inventa sintaxe, enquanto dev exige entrypoint e sentinelas reais do checkout; não
  há inferência por path solto nem execução da orientação. A definição local de S12.02 foi validada
  pela matriz focada descrita abaixo. Artifacts de release, suporte de plataforma, publicação e os
  critérios globais de conclusão continuam pendentes em S12.01/S12.09; o resultado local não os
  promove nem os substitui.

## Evidência executável local de S12.02

`EV-S12-DIST-8` executou `bun run test:s12:distribution` sobre
`packages/distribution/tests/standalone-lifecycle.test.ts`: 8/8 testes, 91 asserções, zero falhas,
3,71 s, Bun 1.3.14 no host Windows x64. A fixture usa `channel: nightly`, versões SemVer `*-dev.1`,
assinatura explicitamente indisponível e limitation `local-contract-only`; seus textos de licença,
SBOM, target policy e payloads são dados sintéticos para validar contratos e não constituem licença,
artifact, provenance ou declaração de suporte do Ralph v2.

A matriz atravessa handlers/CLI reais quando aplicável e cobre preview de install sem mutação,
install local completo, HTTPS por transporte fake allowlisted sem rede, staging/tamanho/SHA-256/
metadata, tamper recusado antes da ativação, `update --check`, update para segunda versão sem substituir
launcher ou engine versionada anterior, downgrade/schema incompatível, rollback receipt-bound,
launcher adulterado e launcher schema incompatível com estado `repair-required` honesto, crash/
recovery em `planned`, `staged`, `verified` e `activated`, journal schema-valid e uninstall dry-run +
scheduler/helper externo preservando `.ralph`, config, credential ref, Ralph clássico e sentinela fora
do install root.

A primeira tentativa usou o TEMP default em `C:` e foi recusada corretamente por
`RALPH_INSTALL_ROOT_IS_CHECKOUT`, pois o host contém `C:\.git` e os roots temporários seriam vistos
como internos a esse checkout. O rerun vinculou `TEMP`, `TMP` e `TMPDIR` a
`D:\Temp\ralph-v2-distribution-tests`, fora daquele marcador, e passou integralmente. O log verde é
`D:\Temp\ralph-v2-distribution-tests\s12-distribution-rerun-hidden-20260719-201340-718-60744.stderr.log`.
Esse caveat comprova o bloqueio fail-closed de colisão com checkout; não autoriza enfraquecer a
detecção nem reclassificar a fixture como drill de release.

O source contém agora packagers separados e fail-closed: `scripts/package-release.ts` para o layout
standalone e `scripts/package-npm.ts` para o tarball npm. Eles exigem identidade/licença própria,
commit, fingerprint, metadata e hashes coerentes; geram SBOM CycloneDX a partir do grafo runtime do
lockfile, checksums, provenance/limitações honestas, licenças/notices, toda a documentação
referenciada pelo README distribuído (`docs/`, `examples/`, `implementation/`, `skill-contract/`, `AGENTS.md`,
`DEVELOPMENT.md` e `PRD.md`), o catálogo público `schemas/` e a skill. Ambos recusam schemas ausentes,
extras ou stale, sem geração implícita. O packager standalone também produz tar ustar por target
com engine e launcher. Nenhum dos dois packagers foi
executado sobre o source consolidado. O standalone aceita promotion record S11 validado contra
artifacts/ambientes exatos para produzir `packaged-tested`; sem ele, produz
`packaged-not-tested` nos canais permitidos. Para resolver o ciclo de uma `stable`, o standalone tem
agora uma primeira passagem `--candidate-only`: exclusiva de `stable`, incompatível com promotion e
qualquer opção de assinatura, output `-candidate` e receipts `publishable: false`, sem
`ReleaseManifest`. Ela materializa support files, skill tar e engine/launcher/metadata/archive por
target e registra exatamente os bindings necessários ao `ReleasePromotionRecord` v3. Repetir os
mesmos inputs e `publishedAt` conserva skill/target archives byte-idênticos; a passagem final exige
record+signer, releitura estável e revalidação com relógio fresco imediatamente antes do rename. O
candidato precisa terminar com `publishedAt` mais de cinco minutos no futuro; a final aceita somente
a janela de cinco minutos a um segundo anterior. O enforcement é do fluxo Ralph, não DRM, e não
elimina a janela local mínima para mutador de mesma autoridade entre verificação e rename. O npm
também não herda a promoção do standalone: ele produz um
`npm-release-binding.json` externo que vincula o tarball e support files. Somente um promotion record
npm v2, com promoção base v3 revalidada contra um receipt standalone independente, referências
externas content-addressed, ambiente real e install drill do tarball exato em cada OS/arquitetura
promovido, pode produzir `packaged-tested`. O receipt é relido por handle bounded, seus payloads são
recalculados na origem e um snapshot opaco hash-bound entra no binding e no inventário final com nome
que não alega relocabilidade; seus paths continuam relativos à origem e o result registra essa
limitação e o payload content address. Standalone e npm
compartilham um path de signing externo, provider-neutral e versionado:
  `--signature-config` lê JSON estrito bounded/estável, resolve executable+argv sem shell, encaminha
  somente variáveis nomeadas, usa temp privado e árvore supervisionada, exige result e assinatura
  regulares/bounded/identity-stable e calcula `signedManifestSha256` pela projeção canônica. A opção é
  mutuamente exclusiva com `--signature-unavailable-reason`; para npm o adapter recebe
  `sign-release-subject`/`npm-release-binding`, enquanto o standalone recebe
  `sign-release-manifest`. `nightly`/`beta` aceitam signer ou indisponibilidade explícita e a passagem
  final `stable` exige promotion record do subject correto e assinatura presente. `--support-policy` também é
  obrigatório: artifacts devem coincidir exatamente com entries `included`; o manifest schema v2 e
  promotion record schema v3 vinculam o hash canônico da matriz R001–R079, e o installer recusa status,
  capability, target set ou hash divergentes. O result do signer vincula também
  SHA-256/tamanho do envelope e o receipt é revalidado até o commit. Nenhuma ferramenta, linguagem,
  chave ou identidade foi escolhida e nenhum artifact foi assinado; licença, evidence, trust policy,
  validação executável e limitações de plataforma mantêm S12.01 e a promoção `stable` abertas.

Os dois packagers possuem cancelamento command-owned em duas fases para SIGINT/SIGTERM, propagam o
`AbortSignal` ao signer supervisionado, verificam cancelamento entre efeitos longos e imediatamente
antes dos renames de commit e removem staging não promovido em falha ou interrupção. Essa garantia é
  apenas estrutural até que os caminhos de cancelamento e preservação do artifact já promovido sejam
  exercitados pelos testes específicos de packaging.

Os guias consolidados de usuário e operador estão em `docs/24-*` e `docs/25-*`. O gate único e o
template de handoff estão em `docs/26-*`, cobrindo identidade/licença, targets, artifacts,
install/update/rollback/uninstall, matriz R001–R079, skill, beta e decisão do alias `ralph`.

No ciclo local atual, os 60 schemas foram gerados/conferidos; lint e typecheck passaram; o gate
consolidado aprovou 673 testes com 2 smokes reais opt-in corretamente ignorados; integração aprovou
149/149; E2E 63/63; segurança 91/91; watchdog 8/8; e o smoke PTY passou em três repetições. Build e
smoke do standalone Windows x64, compatibilidade source-only 5/5 e addendum S03 15/15 também estão
verdes. A matriz local de distribuição S12.02 passou 8/8 com 91 asserções. A skill passou no
`quick_validate.py`, em 3/3 testes de contrato e no forward test cego de
geração (2 documentos, 7 tasks, validate/inspect recursive/strict sem diagnostics). Os packagers e
os drills de release ainda não foram executados. Separadamente, a integração focada do sample S12.08
passou 1/1 com 59 asserções; ela não altera os totais das suites consolidadas que não foram
reexecutadas neste fechamento.

## Estado de S12.09–S12.11

Sem marcar essas tasks ou seus critérios como concluídos, `docs/28-*` agora fornece case IDs e
worksheet determinística para artifacts, install/update/rollback/uninstall, migração/resume, auth
opt-in, TUI/PTY, beta, diagnostics locais e retorno ao Ralph clássico. O source também expõe o alias
standalone `ralph` como operação opt-in receipt-bound: preview hash-bound, apply somente a partir de
receipt corrente `stable`, colisão fail-closed, remoção por quarentena com identidade/hash verificados,
recuperação determinística entre rename/unlink, receipt de controle `N+1` atômico e hash-bound, e
nenhum efeito em `PATH` ou no pacote npm.
`docs/26-*` contém o handoff ampliado de S01–S12, campanha beta, smokes, decisões,
upstream refresh, classic backup e alias. Os casos formais da worksheet permanecem `pending`: o
smoke local Windows, o smoke PTY mínimo, `EV-S12-DIST-8` e a integração local do sample S12.08 não
substituem install/update/rollback do artifact candidato, execução do sample nesse artifact com
TUI/attach em PTY, providers reais nem a matriz externa exigida por esses casos.

## Identidade e licença próprias decididas

O proprietário delegou as decisões finais. O source agora usa MIT própria, copyright Rodrigo Jager,
package/binário `ralph-next`, versão `0.1.0-beta.1`, primeiro channel `beta`, repositório
`https://github.com/rodrigojager/ralph-v2` e namespace de schemas
`https://rodrigojager.github.io/ralph-v2/schemas/v2/`. O monorepo raiz permanece `private: true`
porque não é o tarball publicável; `package:npm` materializa o package público em staging separado.
Essas decisões removem o blocker de autoridade, mas S12.01 continua aberta até o origin existir, os
schemas estarem acessíveis, a curadoria Bun e os inventories estarem completos e o candidato passar
pelos gates reais.

## Verificação mínima ainda necessária para S12

A fila operacional restante deve ser executada nesta ordem, sempre pelo wrapper oculto no Windows:

1. Rodar a seleção estrutural focada que cobre os vínculos acrescentados nesta edição:

   ```powershell
   pwsh -File .\scripts\run-bun-hidden.ps1 `
     -WorkingDirectory (Get-Location).Path `
     -LogName s11-s12-structure `
     -Priority BelowNormal `
     test `
     ./tests/unit/ci-evidence-structure.test.ts `
     ./tests/unit/release-candidate-input.test.ts `
     ./tests/unit/s12-closure-structure.test.ts `
     ./tests/unit/windows-subprocess-focus.test.ts
   ```

2. Com um binário Gitleaks canônico e seu SHA-256 explícitos, repetir
   `test:release-security` pelo mesmo wrapper. Não usar executável arbitrário do `PATH`.
3. Depois de existir HEAD versionado e origin confirmado, executar o workflow remoto e arquivar os
   receipts dos três jobs x64, dos seis pares nativos e do job `security-gates`. Configuração local do
   YAML não substitui essas execuções.
4. Somente depois das decisões do Gate A, da curadoria exata do Bun e de um candidato real, executar
   packaging e install/migration/rollback drills sobre os bytes do candidato.
5. Por último, executar `check:s12` uma única vez pelo wrapper, com diretório de evidência novo,
   binários/candidato/digests explícitos e qualquer waiver externo aprovado. Exit `2` continua sendo
   `local-pass/release-blocked`, não conclusão.

No início desta edição nenhum comando da fila havia sido executado. A licença e identidade já foram
decididas; ainda faltam curadoria do runtime Bun, Git HEAD/origin, Gitleaks pinado local e release
candidate até que as etapas seguintes produzam esses inputs.

```text
ralph-next prd validate <skill-generated-root> --recursive --strict
ralph-next doctor --format json
<release-artifact> version
<release-artifact> run --prd <sample> --executor-profile <fake-or-opt-in>
<checksum-command> <release-artifacts>
```
