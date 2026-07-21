# 22 — Migração Ralph v1 → Ralph v2 (S10)

## Invariante principal

O migrador nunca transforma `.ralph` v1 em `.ralph` v2 no mesmo diretório. O source permanece
read-only e o destino é outro diretório não aninhado. O harness pode executar as versões por paths
absolutos separados, mas o comando público instalado é sempre `ralph`. Assim config, state,
heartbeat, reports ou credenciais de uma versão não são interpretados pela outra.

## Inspeção read-only

```powershell
ralph migrate inspect "C:\Projetos\Meu Projeto v1" --format json
```

`migrate inspect`:

1. canoniza a raiz e exige `.ralph` regular, sem symlink/junction;
2. recusa uma identidade `workspace.json` v2;
3. lê apenas arquivos conhecidos e bounded (`PRD.*`, config, state, adapters e recipes);
4. valida markers do PRD clássico antes de sugerir a primeira task não finalizada;
5. classifica cada opção como `direct`, `changed`, `unsupported` ou `secret-reference`;
6. omite valores com aparência de segredo e sugere somente referências `env:...`;
7. detecta run v1 possivelmente ativo, mas nunca o converte;
8. calcula hashes SHA-256 e um fingerprint de source para impedir apply sobre inspeção stale;
9. não executa command, script, adapter ou recipe e não escreve source/destino.

Arquivos maiores que o limite, links, roots ambíguos ou documentos inválidos falham fechados.

## Aplicação em destino separado

O destino pode existir ou ser criado pelo comando, mas não pode conter `.ralph` nem
`PRD.migrated.md`.

```powershell
ralph migrate apply "C:\Projetos\Meu Projeto v1" `
  --destination "C:\Projetos\Meu Projeto v2" `
  --format json
```

Imports opcionais continuam inativos:

```powershell
ralph migrate apply "C:\Projetos\Meu Projeto v1" `
  --destination "C:\Projetos\Meu Projeto v2" `
  --import-adapters `
  --import-recipes
```

O apply reexecuta o inspect, confirma que PRD/config/state não mudaram, migra o PRD clássico para
`PRD.migrated.md`, inicializa identidade/ledger v2, grava somente os campos de config com mapping
válido e valida a camada gerada. Engines/fallbacks antigos não são ativados automaticamente porque
o protocolo de input/output e as capabilities não podem ser inferidos com segurança.

Adapters opt-in vão para:

```text
.ralph/imports/ralph-v1/adapters/
```

Cada adapter vira um record `status=quarantined` sem segredo e exige conversão manual para profile.
Recipes opt-in vão para a quarentena equivalente. Nenhum script é carregado ou executado.

## State ativo e handoff

Mesmo quando `state.json` contém `current_run_id`, `current_task_id`, `run_status` ou heartbeat:

- `heartbeat.json` e arquivos regulares da árvore de checkpoints recebem inventário bounded com path, tamanho e SHA-256;
- heartbeat, lease e checkpoints legados nunca são importados, reproduzidos ou usados como autoridade v2;
- nenhum run/attempt/lease v1 é criado no ledger v2;
- nenhum run ativo é marcado concluído;
- a próxima task vem somente do primeiro marker clássico validado diferente de `[x]`;
- o report registra se o run antigo parecia ativo;
- o usuário deve parar/concluir o processo v1 e selecionar um profile executor v2;
- o comando de handoff sempre cria um run novo sobre o PRD migrado.

Exemplo emitido no resultado:

```powershell
ralph run --workspace "C:\Projetos\Meu Projeto v2" --prd PRD.migrated.md --new-run
```

## Outputs de auditoria

Cada migração concluída cria:

```text
.ralph/migration/<migration-id>/
├── backup/generated-config.yaml
├── report.json
└── rollback-manifest.json
```

O report contém source fingerprint, classificação de config, relatório do PRD, imports e decisão
de handoff. O rollback manifest lista os arquivos criados e seus hashes, exclui o próprio manifest
da lista circular e afirma que nenhum arquivo source pode ser removido.

Falha durante apply aciona rollback interno somente sobre `.ralph` v2 recém-criado e
`PRD.migrated.md` recém-criado. Para rollback posterior existe um fluxo público em duas etapas:

```powershell
$Manifest = "C:\Projetos\Meu Projeto v2\.ralph\migration\<migration-id>\rollback-manifest.json"
ralph migrate rollback $Manifest --dry-run --format json
ralph migrate rollback $Manifest --confirm-plan-hash <SHA256-DO-PREVIEW> --format json
```

O preview é read-only e só produz plano quando o manifest:

1. é um arquivo regular único exatamente em
   `.ralph/migration/<migration-id>/rollback-manifest.json`;
2. passa pelo schema estrito e vincula seu `migrationId`, `destinationRoot` e self-path à localização
   real;
3. contém somente paths portáveis normalizados para `PRD.migrated.md` ou `.ralph/**`, sem traversal,
   absolutos, duplicatas ou aliases de case no Windows;
4. não atravessa symlink/junction e não aponta para symlink ou hardlink;
5. encontra todos os arquivos listados ainda com o SHA-256 gravado pela migração;
6. declara lista vazia de remoções da origem e mantém a raiz v1 separada.

O apply exige o hash exato do preview, adquire ownership exclusivo da migração, recompõe o plano e
revalida hash e identidade de cada arquivo imediatamente antes da remoção segura. O próprio manifest
é verificado e removido por último. Depois do release do lock, somente diretórios candidatos que
estejam realmente vazios são removidos com `rmdir`; qualquer sentinel, arquivo posterior ou diretório
não relacionado os mantém no lugar. Não existe `rm -rf`, descoberta por nome, remoção recursiva ou
acesso à origem v1. Um destino alterado exige novo diagnóstico; o CLI não relaxa o hash confirmado.

## Secrets e credenciais

- O v1 não possui credential store equivalente no workspace.
- Valores suspeitos nunca entram em config, report, manifest ou adapter importado.
- O report fornece uma referência sugerida, por exemplo `env:RALPH_LEGACY_CONFIG_API_KEY`.
- O operador cria uma credential ref pelo fluxo `auth`/provider v2 e configura o profile.
- Adapter/recipe contendo segredo suspeito fica `importable=false`, mesmo com flag opt-in.

## Coexistência e corte do nome

Durante beta:

- o binário antigo continua `ralph`;
- o novo continua `ralph`;
- a raiz v1 e a raiz v2 são diretórios separados;
- global config v2 usa o namespace de plataforma `ralph`;
- nenhuma instalação, update ou migração remove o binário antigo;
- trocar o nome final para `ralph` permanece bloqueado até compatibility/release gates e rollback
  instalável.

## Estado de validação

Além das validações gerais anteriores, o fechamento S10 executou o harness integral com
`ralph 0.2.0` e `ralph 0.1.0-dev.1` explícitos e frescos. O resultado versionado em
`docs/compatibility/s10-report.{json,md}` passou 91/91 checks, sem regressions ou surface regressions.
O componente de coexistência executou setup legado, inspect/apply/status/config/rollback v2 em roots
separadas com espaço/Unicode e confirmou hashes imutáveis da origem, config legado, sentinels e dois
binários. As suites vinculadas de opções, control-flow, parallel/Git/security e signal/resume também
saíram com exit 0. Essa é prova local Windows x64 do checkout, não prova multiplataforma, install de
release, provider/auth real ou promoção.

O harness focado `scripts/s10-migration-coexistence-drill.ps1` permanece uma alternativa operacional
separada e não foi usado como substituto da execução integral aceita. Ele exige paths explícitos para
os binários legacy/next, usa roots temporárias com
espaço/Unicode, processos hidden/BelowNormal, hashes dos binários e da árvore v1, config root v2
isolado, sentinel no destino e o fluxo preview/hash/apply. Seu JSON só vira evidência após execução
real revisada; o fechamento atual vem do componente equivalente e mais amplo dentro do report S10.

O script agora isola HOME, USERPROFILE, AppData, XDG, TEMP e config dos dois lados por allowlist;
captura version/help antes da migração; injeta um canário de credencial que não pode aparecer em
stdout/stderr; e prova que o environment/config legado fica byte-idêntico durante todos os comandos
next. Nenhum processo abre janela ou TUI.

```powershell
pwsh -File scripts/s10-migration-coexistence-drill.ps1 `
  -LegacyBinary "C:\bin\ralph.exe" `
  -NextBinary "C:\bin\ralph.exe" `
  -EvidenceDirectory "C:\evidence\ralph-v2"
```

O fechamento conjunto S10.09/S10.10 usa também o coordenador integral, sem substituir este drill
focado:

```powershell
pwsh -File scripts/run-bun-hidden.ps1 `
  -WorkingDirectory (Get-Location).Path `
  -LogName s10-compatibility `
  run scripts/s10-compatibility.ts `
  --legacy-binary "C:\bin\ralph.exe" `
  --next-binary "C:\bin\ralph.exe"
```

Esse ciclo foi executado sem edições concorrentes, depois de typecheck e build frescos. O report de
19 de julho de 2026 às 23:05:54Z registrou source
`2835b2f3350755ab3045ad4f2c11b13497a2dfb8bfcefcdc49430800bc07b1f8`, legacy
`ffd6b016713e8754b06ad1c9a2f51d6ba761e7b223bd2083fd1f99c9b0a217ee` e next
`ffcb9d0a51f2e3b9c03cf0696d2cdbf9ee5bcff4285eba36ba702be2b454c4c1`. Com revisão humana do
report verde, S10.09 e S10.10 estão fechadas no escopo local declarado.
