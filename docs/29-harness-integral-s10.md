# 29 — Harness integral S10

## Objetivo

Fechar S10.09/S10.10 com evidência executável de dois artefatos reais, sem converter a decisão de
compatibilidade em comparação textual superficial. O baseline S01 continua imutável; o S10 é um
coordenador/report aditivo.

## Pré-condições

1. nenhuma outra slice está editando o source;
2. o standalone v2 foi gerado depois da última edição e possui `build-metadata.json` válido ao lado;
3. Ralph v1 e v2 são arquivos regulares, não links, distintos e informados por path;
4. não há outro Bun concorrente consumindo os mesmos artefatos/evidências;
5. o checkout v1 permanece read-only.

O coordenador recusa nomes resolvidos via PATH, source entry, defaults e environment. O hash e o
fingerprint do v2 precisam corresponder ao source atual antes da primeira execução.

## Execução sem roubar foco no Windows

```powershell
pwsh -File .\scripts\run-bun-hidden.ps1 `
  -WorkingDirectory (Get-Location).Path `
  -LogName s10-compatibility `
  -Priority BelowNormal `
  run scripts/s10-compatibility.ts `
  --legacy-binary "C:\caminho\ralph.exe" `
  --next-binary "C:\caminho\ralph-next.exe"
```

O wrapper usa `UseShellExecute=false`, `CreateNoWindow=true`, `WindowStyle=Hidden`, stdin fechado,
streams redirecionados e prioridade `BelowNormal`. Os subprocessos do coordenador usam
`windowsHide=true`; o harness não abre TUI ou prompt.

Para diagnóstico sem gravar relatórios versionados, acrescente:

```text
--no-write --format json --keep-workspace
```

## Sequência executada

1. validar arquivos regulares, paths explícitos, distinção e freshness do next;
2. registrar SHA-256/tamanho/version/help dos dois binários;
3. sondar cada spelling de flag legado no v1 real;
4. executar o baseline S01 e o addendum S03 com os mesmos binários;
5. executar smoke S10 em workspaces com espaço/Unicode e HOME/config separados;
6. capturar human/JSON, exits, streams, files, marker, guards e aliases;
7. executar inspect/apply/status/config/rollback e re-hashear origem, sentinels, configs e binários;
8. executar, não apenas citar, suites para skips/fast, no-change/retry/fail-fast,
   parallel/Git/security/sandbox e signal/resume;
9. revalidar fingerprint do source e hashes dos binários;
10. projetar classificação e assessment separadamente e gravar JSON/Markdown.

## Relatórios

- `docs/compatibility/s10-report.json`: evidência completa, machine-readable;
- `docs/compatibility/s10-report.md`: matriz humana derivada do mesmo objeto;
- logs do wrapper: paths devolvidos como `STDOUT_LOG` e `STDERR_LOG`.

O JSON contém S01/S03 completos, cada invocation com argv/cwd portátil, exit, timeout,
stdout/stderr normalizados + hash, snapshots de arquivos, hashes do marker/origem/binários,
migração e suites vinculadas com hashes dos arquivos de teste.

## Falha e retomada

Regression faz o processo sair 1 e preserva a raiz temporária. Sucesso remove somente a raiz única
criada sob o temp. O harness jamais apaga checkout v1, source v2 ou path fora do prefixo esperado.

Depois da correção, gere standalones novos e execute desde o início. Relatório parcial não aprova o
gate porque hashes, source e classificação precisam pertencer à mesma execução.

## Gate de fechamento

S10.09/S10.10 só podem ser marcadas após:

- `summary.regressions == 0` e `summary.surfaceRegressions == 0`;
- source e binários imutáveis;
- S01, S03, smoke e migração com assessment pass;
- suites vinculadas realmente executadas com exit 0;
- revisão humana de changed/deprecated/removed;
- revisão do relatório real, não apenas do script ou teste source-only.

## Execução aceita em 2026-07-19

O ciclo exclusivo executou, sempre oculto e em prioridade `BelowNormal`, a validação mínima
11/11 com 161 assertions, typecheck, build nativo fresco e o harness integral. O report foi gerado
em `2026-07-19T23:05:54.068Z` e encerrou 91/91 checks, zero regressions e zero surface regressions.
Todos os componentes S01, S03, smoke operacional, coexistência/migração e as quatro suites vinculadas
receberam assessment `pass`; não houve workspace retido.

Bindings registrados:

- source: `2835b2f3350755ab3045ad4f2c11b13497a2dfb8bfcefcdc49430800bc07b1f8`;
- `ralph 0.2.0`: `ffd6b016713e8754b06ad1c9a2f51d6ba761e7b223bd2083fd1f99c9b0a217ee`;
- `ralph-next 0.1.0-dev.1`: `ffcb9d0a51f2e3b9c03cf0696d2cdbf9ee5bcff4285eba36ba702be2b454c4c1`.

Essa evidência fecha S10.09/S10.10 no host e escopo declarados. Ela não afirma provider/auth real,
package/install de release, assinatura, promoção ou suporte aos outros cinco pares de plataforma.
